/**
 * 应用内更新编排（P3 · 2026-10-18）。
 *
 * 状态机：disabled → idle → checking → up_to_date / available
 *         available → downloading → ready → installing
 *         error 可重试；install 只能从 ready 进，且只能由显式路由触发。
 *
 * 安全顺序（不可调换）：
 *   1) 取 latest.json 原始字节 + .sig；
 *   2) **先** Ed25519 验签，**再** JSON.parse；
 *   3) schema/appId/channel/版本/平台/过期校验；
 *   4) 下载 .part（Range 续传/镜像）；
 *   5) 先校 size + sha256，再 rename 成 .exe；
 *   6) 用户点“立即安装”才运行安装器；安装前再校一次哈希与签名。
 * 任何一步失败都不执行下载物。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeJsonAtomic } from '../../src/atomic-write.js';
import {
  APP_ID, APP_VERSION, INSTALL_ROOT, MODE, PROGRAM_ROOT, SANDBOX, UPDATE_DIR,
} from './paths.js';
import {
  MANIFEST_URL, MANIFEST_MAX_BYTES, SIGNATURE_MAX_BYTES, OFFLINE_PENDING_MAX_AGE_MS,
  validateManifest, isAllowedUrl,
} from './update-manifest.js';

export { OFFLINE_INSTALLER_MAX_BYTES, OFFLINE_PENDING_MAX_AGE_MS } from './update-manifest.js';
import { loadPublicKeyFile, verifyRawSignature } from './update-signature.js';
import { compareVersions } from './update-version.js';
import { fetchCapped, downloadWithProgress } from './update-download.js';

export const PHASES = Object.freeze([
  'disabled', 'idle', 'checking', 'up_to_date', 'available',
  'downloading', 'ready', 'installing', 'error',
]);

const ALLOWED_TRANSITIONS = {
  disabled: [],
  idle: ['checking'],
  checking: ['up_to_date', 'available', 'idle', 'error'],
  up_to_date: ['checking'],
  available: ['downloading', 'checking'],
  downloading: ['ready', 'available', 'error'],
  ready: ['installing'],
  installing: [],
  error: ['checking', 'downloading'],
};

export function canTransition(from, to) {
  if (!PHASES.includes(from) || !PHASES.includes(to)) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function defaultSpawnInstaller(exe, { silent }) {
  if (process.platform !== 'win32') throw new Error('应用内安装只在 Windows 上可用');
  const child = spawn(exe, silent ? ['/S'] : [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

/**
 * @param {object} [deps] 仅供测试注入；生产走默认值。
 */
export function createUpdater(deps = {}) {
  const {
    mode = MODE,
    sandbox = SANDBOX,
    appId = APP_ID,
    appVersion = APP_VERSION,
    updateDir = UPDATE_DIR,
    installRoot = INSTALL_ROOT,
    programRoot = PROGRAM_ROOT,
    env = process.env,
    now = () => Date.now(),
    logger = (msg) => console.log(`[update] ${msg}`),
    onUpdate = () => {},
    requestShutdown = null,
    fetchManifest = null,
    download = downloadWithProgress,
    spawnInstaller = defaultSpawnInstaller,
    publicKeyFile = '',
  } = deps;

  const testMode = env.QQBOT_UPDATE_TEST === '1';
  let enabled = !sandbox && (mode === 'installed' || testMode);
  let disabledReason = '';
  if (!enabled) {
    disabledReason = sandbox
      ? '沙箱模式不检查更新'
      : '仅安装版支持应用内更新';
  }

  const manifestUrl = testMode && env.QQBOT_UPDATE_MANIFEST_URL
    ? String(env.QQBOT_UPDATE_MANIFEST_URL)
    : MANIFEST_URL;
  if (enabled) {
    const check = isAllowedUrl(manifestUrl, { testMode });
    if (!check.ok) {
      enabled = false;
      disabledReason = `更新地址不可用：${check.reason}`;
    }
  }
  const sigUrl = `${manifestUrl}.sig`;
  const cacheDir = path.join(updateDir, 'cache');
  const stateFile = path.join(updateDir, 'state.json');

  let publicKey = null;
  if (enabled) {
    const candidates = [
      publicKeyFile,
      path.join(installRoot, 'resources', 'update-pubkey.pem'),
      path.join(programRoot, 'resources', 'update-pubkey.pem'),
    ].filter(Boolean);
    for (const file of candidates) {
      try {
        if (fs.existsSync(file)) {
          publicKey = loadPublicKeyFile(file);
          break;
        }
      } catch (e) {
        logger(`更新公钥读取失败：${e.message}`);
      }
    }
    if (!publicKey) {
      enabled = false;
      disabledReason = '缺少更新公钥（resources/update-pubkey.pem）';
    }
  }

  const state = {
    phase: enabled ? 'idle' : 'disabled',
    reason: enabled ? '' : disabledReason,
    latest: null,
    progress: null,
    error: '',
    checkedAt: 0,
    downloadedAt: 0,
    offline: null,
    source: '',
  };
  let downloadedFile = '';
  let downloadCtl = null;
  let downloadPromise = null;
  let timers = [];
  let lastEmit = 0;

  const snapshot = () => ({
    enabled,
    testMode,
    phase: state.phase,
    reason: state.reason,
    currentVersion: appVersion,
    latest: state.latest
      ? {
          version: state.latest.version,
          notesUrl: state.latest.notesUrl,
          size: state.latest.size,
          sha256: state.latest.sha256,
        }
      : null,
    progress: state.progress,
    error: state.error,
    checkedAt: state.checkedAt,
    downloadedAt: state.downloadedAt,
    offline: state.offline ? { ...state.offline } : null,
    source: state.source,
  });

  function emit(force = true) {
    const t = now();
    if (!force && t - lastEmit < 500) return;
    lastEmit = t;
    try { onUpdate(snapshot()); } catch { /* 观察者失败不影响更新 */ }
  }

  function persist() {
    try {
      fs.mkdirSync(updateDir, { recursive: true });
      writeJsonAtomic(stateFile, {
        schema: 1,
        phase: state.phase === 'installing' ? 'idle' : state.phase,
        latest: state.latest,
        checkedAt: state.checkedAt,
        downloadedAt: state.downloadedAt,
        error: state.error,
        offline: state.offline,
        source: state.source,
        currentVersion: appVersion,
      });
    } catch (e) {
      logger(`state.json 写入失败：${e.message}`);
    }
  }

  function setState(patch, { persist: doPersist = true, force = true } = {}) {
    Object.assign(state, patch);
    if (doPersist) persist();
    emit(force);
  }

  async function defaultFetchManifest() {
    const signal = AbortSignal.timeout ? AbortSignal.timeout(10_000) : undefined;
    const validate = (u) => isAllowedUrl(u, { testMode });
    const [manifestRes, sigRes] = await Promise.all([
      fetchCapped(manifestUrl, {
        maxBytes: MANIFEST_MAX_BYTES, timeoutMs: 10_000, signal, validateUrl: validate,
      }),
      fetchCapped(sigUrl, {
        maxBytes: SIGNATURE_MAX_BYTES, timeoutMs: 10_000, signal, validateUrl: validate,
      }),
    ]);
    return { raw: manifestRes.buffer, sig: sigRes.buffer.toString('utf8') };
  }

  function manifestCachePaths(version) {
    return {
      manifest: path.join(cacheDir, `${version}.json`),
      sig: path.join(cacheDir, `${version}.sig`),
      exe: path.join(cacheDir, `${version}.exe`),
    };
  }

  function rememberManifest(raw, sig) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const p = manifestCachePaths(JSON.parse(raw.toString('utf8')).version);
    fs.writeFileSync(p.manifest, raw);
    fs.writeFileSync(p.sig, sig);
    return p;
  }

  function offlinePaths() {
    const pending = path.join(updateDir, 'offline', 'pending');
    return {
      pending,
      manifest: path.join(pending, 'manifest.json'),
      sig: path.join(pending, 'manifest.sig'),
      info: path.join(pending, 'pending.json'),
      installerPart: path.join(pending, 'installer.part'),
    };
  }

  function readPending() {
    const p = offlinePaths();
    try {
      const info = JSON.parse(fs.readFileSync(p.info, 'utf8'));
      if (!info || typeof info !== 'object') return null;
      const at = Number(info.at);
      if (!Number.isFinite(at) || now() - at > OFFLINE_PENDING_MAX_AGE_MS) return null;
      if (!fs.existsSync(p.manifest) || !fs.existsSync(p.sig)) return null;
      return info;
    } catch {
      return null;
    }
  }

  function removePending() {
    try { fs.rmSync(offlinePaths().pending, { recursive: true, force: true }); } catch { /* 下次覆盖 */ }
    state.offline = null;
  }

  function sweepOffline() {
    const p = offlinePaths();
    if (!fs.existsSync(p.info)) return;
    let info = null;
    try { info = JSON.parse(fs.readFileSync(p.info, 'utf8')); } catch { /* 读不出来就留着等覆盖 */ }
    const at = Number(info && info.at);
    if (!Number.isFinite(at) || now() - at > OFFLINE_PENDING_MAX_AGE_MS) removePending();
  }

  /**
   * 离线第一步：验签 + 校验清单，暂存 latest.json/.sig。
   * 此时 EXE 还没到，不改变 phase；只把 version/size/hash 挂到 state.offline 供 UI 显示。
   */
  async function prepareOffline({ manifestBytes, sigBase64 } = {}) {
    if (!enabled) throw new Error(state.reason || '更新不可用');
    if (state.phase === 'downloading' || state.phase === 'installing' || state.phase === 'ready') {
      throw new Error('已有更新正在下载/待安装，请先处理完或重启面板');
    }
    const raw = Buffer.isBuffer(manifestBytes) ? manifestBytes : Buffer.from(manifestBytes || []);
    if (!raw.length) throw new Error('离线清单为空');
    if (raw.length > MANIFEST_MAX_BYTES) throw new Error(`离线清单超过 ${MANIFEST_MAX_BYTES} 字节`);
    const sig = String(sigBase64 || '').trim();
    if (!sig) throw new Error('离线签名为空');
    if (Buffer.byteLength(sig, 'utf8') > SIGNATURE_MAX_BYTES) throw new Error(`离线签名超过 ${SIGNATURE_MAX_BYTES} 字节`);

    if (!verifyRawSignature(raw, sig, publicKey)) throw new Error('离线清单签名无效');
    let obj;
    try { obj = JSON.parse(raw.toString('utf8')); } catch { throw new Error('离线清单不是有效 JSON'); }
    const checkResult = validateManifest(obj, {
      currentVersion: appVersion,
      appId,
      windowsVersion: process.platform === 'win32' ? os.release() : '',
      testMode,
    });
    if (!checkResult.ok) throw new Error(`离线清单校验失败：${checkResult.errors.join('；')}`);
    const cmp = compareVersions(obj.version, appVersion);
    if (cmp === 0) throw new Error(`离线清单就是当前版本 ${appVersion}`);
    if (cmp !== 1) throw new Error(`离线清单版本不可用（${obj.version} vs ${appVersion}）`);

    const p = offlinePaths();
    try { fs.rmSync(p.pending, { recursive: true, force: true }); } catch { /* 覆盖旧暂存 */ }
    fs.mkdirSync(p.pending, { recursive: true });
    fs.writeFileSync(p.manifest, raw);
    fs.writeFileSync(p.sig, sig);
    writeJsonAtomic(p.info, {
      schema: 1,
      version: obj.version,
      size: obj.installer.size,
      sha256: obj.installer.sha256,
      notesUrl: obj.notesUrl || '',
      at: now(),
    });
    state.offline = { version: obj.version, size: obj.installer.size, sha256: obj.installer.sha256 };
    state.source = 'offline';
    if (state.phase === 'error') state.phase = 'idle';
    state.error = '';
    emit();
    logger(`离线清单已校验：${obj.version}（等待安装包）`);
    return snapshot();
  }

  /**
   * 离线第二步：EXE 已落到 pending/installer.part，校 size+sha256 后移入 cache 并置 ready。
   * 仍然复用 install() 的“安装前再校一次”与两次点击契约。
   */
  async function completeOffline({ exePath = '', bytes = null } = {}) {
    if (!enabled) throw new Error(state.reason || '更新不可用');
    const info = readPending();
    if (!info) throw new Error('没有待完成的离线清单，请先上传 latest.json 与 .sig');
    const p = offlinePaths();
    const raw = fs.readFileSync(p.manifest);
    const sig = fs.readFileSync(p.sig, 'utf8');
    if (!verifyRawSignature(raw, sig, publicKey)) throw new Error('离线清单签名复验失败');
    let obj;
    try { obj = JSON.parse(raw.toString('utf8')); } catch { throw new Error('离线清单不是有效 JSON'); }
    const checkResult = validateManifest(obj, {
      currentVersion: appVersion,
      appId,
      windowsVersion: process.platform === 'win32' ? os.release() : '',
      testMode,
    });
    if (!checkResult.ok) throw new Error(`离线清单校验失败：${checkResult.errors.join('；')}`);
    if (obj.version !== info.version) throw new Error('离线暂存版本与清单不一致');
    let sourceFile = exePath;
    if (Buffer.isBuffer(bytes)) {
      fs.mkdirSync(p.pending, { recursive: true });
      sourceFile = p.installerPart;
      fs.writeFileSync(sourceFile, bytes);
    }
    if (!sourceFile || !fs.existsSync(sourceFile)) throw new Error('离线安装包不存在');
    const st = fs.statSync(sourceFile);
    if (st.size !== obj.installer.size) {
      throw new Error(`离线安装包大小不符（${st.size} ≠ ${obj.installer.size}）`);
    }
    const digest = await sha256File(sourceFile);
    if (digest !== obj.installer.sha256) throw new Error('离线安装包 SHA-256 不符');

    fs.mkdirSync(cacheDir, { recursive: true });
    const dest = path.join(cacheDir, `${obj.version}.exe`);
    try { fs.rmSync(dest, { force: true }); } catch { /* 覆盖写 */ }
    try {
      fs.renameSync(sourceFile, dest);
    } catch {
      fs.copyFileSync(sourceFile, dest);
      fs.rmSync(sourceFile, { force: true });
    }
    fs.writeFileSync(path.join(cacheDir, `${obj.version}.json`), raw);
    fs.writeFileSync(path.join(cacheDir, `${obj.version}.sig`), sig);

    downloadedFile = dest;
    state.latest = {
      version: obj.version,
      notesUrl: obj.notesUrl,
      size: obj.installer.size,
      sha256: obj.installer.sha256,
      url: obj.installer.url,
      mirrors: Array.isArray(obj.installer.mirrors) ? obj.installer.mirrors.slice(0, 5) : [],
    };
    state.source = 'offline';
    removePending();
    setState({
      phase: 'ready',
      progress: { received: obj.installer.size, total: obj.installer.size, percent: 100, bytesPerSec: 0 },
      downloadedAt: now(),
      error: '',
    });
    logger(`离线安装包校验通过：${obj.version}`);
    return snapshot();
  }

  function clearOffline() {
    removePending();
    if (state.source === 'offline' && state.phase !== 'ready') state.source = '';
    emit();
    return snapshot();
  }

  async function restore() {
    if (!enabled) return;
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (!saved || typeof saved !== 'object') return;
      state.checkedAt = Number(saved.checkedAt) || 0;
      state.downloadedAt = Number(saved.downloadedAt) || 0;
      state.error = String(saved.error || '');
      state.source = typeof saved.source === 'string' ? saved.source : '';
      state.offline = saved.offline && typeof saved.offline === 'object' ? saved.offline : null;
      const pending = readPending();
      if (pending && !state.offline) {
        state.offline = { version: pending.version, size: pending.size, sha256: pending.sha256 };
        if (!state.source) state.source = 'offline';
      }
      if (!saved.latest || typeof saved.latest !== 'object') return;
      // 升级后新面板启动时，缓存里的版本可能正好等于当前版本 —— 那是“已升完”，不是“可更新”。
      if (compareVersions(saved.latest.version, appVersion) !== 1) {
        state.latest = null;
        state.phase = 'idle';
        return;
      }
      state.latest = saved.latest;
      const p = manifestCachePaths(saved.latest.version);
      if (!fs.existsSync(p.manifest) || !fs.existsSync(p.sig)) {
        state.latest = null;
        state.phase = 'idle';
        return;
      }
      const raw = fs.readFileSync(p.manifest);
      const sig = fs.readFileSync(p.sig, 'utf8');
      if (!verifyRawSignature(raw, sig, publicKey)) {
        state.latest = null;
        state.phase = 'idle';
        return;
      }
      const obj = JSON.parse(raw.toString('utf8'));
      const check = validateManifest(obj, {
        currentVersion: appVersion,
        appId,
        windowsVersion: process.platform === 'win32' ? os.release() : '',
        testMode,
      });
      if (!check.ok) {
        state.latest = null;
        state.phase = 'idle';
        return;
      }
      if (fs.existsSync(p.exe)) {
        const st = fs.statSync(p.exe);
        if (st.size === obj.installer.size && (await sha256File(p.exe)) === obj.installer.sha256) {
          downloadedFile = p.exe;
          state.phase = 'ready';
          return;
        }
      }
      state.phase = 'available';
    } catch (e) {
      logger(`状态恢复失败：${e.message}`);
    }
  }

  async function check({ manual = false } = {}) {
    if (!enabled) return snapshot();
    if (state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'installing') return snapshot();
    if (state.phase === 'ready') return snapshot();
    const previous = state.phase;
    setState({ phase: 'checking', error: '' });
    try {
      const fetched = fetchManifest ? await fetchManifest() : await defaultFetchManifest();
      if (!verifyRawSignature(fetched.raw, fetched.sig, publicKey)) {
        throw new Error('更新清单签名无效');
      }
      let obj;
      try {
        obj = JSON.parse(fetched.raw.toString('utf8'));
      } catch {
        throw new Error('更新清单不是有效 JSON');
      }
      const checkResult = validateManifest(obj, {
        currentVersion: appVersion,
        appId,
        windowsVersion: process.platform === 'win32' ? os.release() : '',
        testMode,
      });
      if (!checkResult.ok) throw new Error(`更新清单校验失败：${checkResult.errors.join('；')}`);

      const cmp = compareVersions(obj.version, appVersion);
      if (cmp === 0) {
        state.source = 'online';
        setState({
          phase: 'up_to_date',
          latest: null,
          progress: null,
          checkedAt: now(),
          error: '',
        });
        logger(`已是最新版本 ${appVersion}`);
        return snapshot();
      }
      if (cmp !== 1) throw new Error(`更新版本不可用（${obj.version} vs ${appVersion}）`);

      state.source = 'online';
      const cached = rememberManifest(fetched.raw, fetched.sig);
      state.latest = {
        version: obj.version,
        notesUrl: obj.notesUrl,
        size: obj.installer.size,
        sha256: obj.installer.sha256,
        url: obj.installer.url,
        mirrors: Array.isArray(obj.installer.mirrors) ? obj.installer.mirrors.slice(0, 5) : [],
      };
      downloadedFile = '';
      setState({
        phase: 'available',
        progress: null,
        checkedAt: now(),
        error: '',
      });
      logger(`发现新版本 ${obj.version}（当前 ${appVersion}）`);
      return snapshot();
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      if (manual) {
        setState({ phase: 'error', progress: null, error: message });
      } else if (previous === 'available' || previous === 'ready') {
        setState({ phase: previous, progress: state.progress, error: '' });
      } else {
        setState({ phase: 'idle', progress: null, error: '' });
      }
      logger(`检查更新失败：${message}`);
      return snapshot();
    }
  }

  function startDownload() {
    if (!enabled || state.phase !== 'available' || !state.latest) return snapshot();
    if (downloadPromise) return snapshot();
    // 在线下载开始后，之前暂存的离线三件套不再有意义；不删已完成的 cache。
    removePending();
    state.source = 'online';
    const ctl = new AbortController();
    downloadCtl = ctl;
    setState({
      phase: 'downloading',
      progress: { received: 0, total: state.latest.size || 0, percent: 0, bytesPerSec: 0 },
      error: '',
    });
    downloadPromise = (async () => {
      try {
        const dest = path.join(cacheDir, `${state.latest.version}.exe`);
        const urls = [state.latest.url, ...(state.latest.mirrors || [])].filter(Boolean);
        const result = await download({
          urls,
          dest,
          expectedSha256: state.latest.sha256,
          expectedSize: state.latest.size,
          signal: ctl.signal,
          validateUrl: (u) => isAllowedUrl(u, { testMode }),
          onProgress: (p) => {
            state.progress = p;
            emit(false);
          },
        });
        downloadedFile = result ? dest : dest;
        setState({
          phase: 'ready',
          progress: { received: state.latest.size, total: state.latest.size, percent: 100, bytesPerSec: 0 },
          downloadedAt: now(),
          error: '',
        });
        logger(`下载完成并校验通过：${state.latest.version}`);
      } catch (e) {
        if (ctl.signal.aborted) {
          setState({ phase: 'available', progress: null, error: '下载已取消' });
        } else {
          setState({ phase: 'error', progress: null, error: `下载失败：${e.message || e}` });
        }
        logger(`下载失败：${e.message || e}`);
      } finally {
        downloadPromise = null;
        downloadCtl = null;
      }
    })();
    return snapshot();
  }

  async function cancel() {
    if (downloadCtl) downloadCtl.abort(new Error('用户取消'));
    clearOffline();
    return snapshot();
  }

  async function install({ silent = false } = {}) {
    if (!enabled) throw new Error(state.reason || '更新不可用');
    if (state.phase !== 'ready' || !state.latest || !downloadedFile) {
      throw new Error('更新还没有下载完成');
    }
    if (silent && !testMode) throw new Error('静默安装只在测试模式可用');

    const p = manifestCachePaths(state.latest.version);
    const raw = fs.readFileSync(p.manifest);
    const sig = fs.readFileSync(p.sig, 'utf8');
    if (!verifyRawSignature(raw, sig, publicKey)) throw new Error('签名复验失败，拒绝安装');
    const st = fs.statSync(downloadedFile);
    if (st.size !== state.latest.size) throw new Error('安装包大小不符，拒绝安装');
    if ((await sha256File(downloadedFile)) !== state.latest.sha256) {
      throw new Error('安装包 SHA-256 不符，拒绝安装');
    }

    setState({ phase: 'installing', error: '' });
    try {
      await spawnInstaller(downloadedFile, { silent });
    } catch (e) {
      setState({ phase: 'ready', error: `启动安装器失败：${e.message || e}` });
      throw e;
    }
    logger('安装器已启动；应用即将关闭');
    if (requestShutdown) {
      const t = setTimeout(() => requestShutdown(), 1200);
      if (typeof t.unref === 'function') t.unref();
    }
    return snapshot();
  }

  function clearTimers() {
    for (const t of timers) clearTimeout(t);
    timers = [];
  }

  function scheduleNextCheck() {
    const jitter = Math.floor((Math.random() * 2 - 1) * 10 * 60 * 1000);
    const t = setTimeout(async () => {
      await check({ manual: false });
      scheduleNextCheck();
    }, 6 * 3600 * 1000 + jitter);
    if (typeof t.unref === 'function') t.unref();
    timers.push(t);
  }

  function start() {
    if (!enabled) {
      emit(true);
      return;
    }
    sweepOffline();
    restore().then(() => {
      emit(true);
      const t = setTimeout(async () => {
        await check({ manual: false });
        scheduleNextCheck();
      }, 3000);
      if (typeof t.unref === 'function') t.unref();
      timers.push(t);
    }).catch(() => {});
  }

  function stop() {
    clearTimers();
    if (downloadCtl) downloadCtl.abort(new Error('面板退出'));
  }

  return {
    snapshot, check, startDownload, cancel, install, start, stop, restore,
    prepareOffline, completeOffline, clearOffline,
  };
}
