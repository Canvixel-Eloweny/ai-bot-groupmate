/**
 * UI 身份清单的读取、验签与核心锚点比对（2026-10-29 · §171）。
 *
 * 这里只回答「这份界面还是不是官方骨架」，不阻止运行：
 *   - official   ：签名有效、公钥指纹是官方的、appId 一致
 *   - unofficial ：签名/公钥/appId 不对，或核心锚点缺失（由前端用 anchors 比对 DOM）
 *   - unknown    ：清单/公钥缺失、旧后端、DEMO —— 不报警
 *
 * 签名对象是 `panel/ui-identity.json` 的**原始字节**；不要用 JSON.stringify 往返。
 * 公钥复用更新体系：installRoot / programRoot 下的 resources/update-pubkey.pem。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PROGRAM_ROOT, INSTALL_ROOT, APP_ID } from './paths.js';
import { loadPublicKeyFile, verifyRawSignature, fingerprintOf } from './update-signature.js';
import { stripBom } from '../../src/plugin-manifest.js';

export const EXPECTED_FINGERPRINT = 'sha256:20a9a6b2f509fcedadb8544d8c41e4ef4a30e098c169fb36768fce2f73122f0d';
export const IDENTITY_FILE = path.join(PROGRAM_ROOT, 'panel', 'ui-identity.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function readRaw(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function envAllowsOverride(env) {
  return env.QQBOT_SANDBOX === '1' || env.QQBOT_MODE === 'dev';
}

function resolveIdentityFile(env) {
  const override = String(env.QQBOT_UI_IDENTITY_FILE || '').trim();
  if (override && envAllowsOverride(env)) return path.resolve(override);
  return IDENTITY_FILE;
}

function resolveSigFile(file, env) {
  const override = String(env.QQBOT_UI_IDENTITY_SIG || '').trim();
  if (override && envAllowsOverride(env)) return path.resolve(override);
  return `${file}.sig`;
}

function resolvePublicKey(env) {
  const candidates = [
    String(env.QQBOT_UPDATE_PUBKEY || '').trim(),
    path.join(INSTALL_ROOT, 'resources', 'update-pubkey.pem'),
    path.join(PROGRAM_ROOT, 'resources', 'update-pubkey.pem'),
  ].filter(Boolean);
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return '';
}

export function verifyIdentity({ file, sigFile, env = process.env } = {}) {
  const idFile = file ? path.resolve(file) : resolveIdentityFile(env);
  const signatureFile = sigFile ? path.resolve(sigFile) : resolveSigFile(idFile, env);
  const raw = readRaw(idFile);
  if (!raw) return { state: 'unknown', reason: '身份清单缺失' };
  const sig = readText(signatureFile).trim();
  if (!sig) return { state: 'unknown', reason: '身份签名缺失' };
  const keyFile = resolvePublicKey(env);
  if (!keyFile) return { state: 'unknown', reason: '找不到更新公钥' };
  let key;
  try { key = loadPublicKeyFile(keyFile); } catch { return { state: 'unknown', reason: '更新公钥读不出来' }; }
  const fingerprint = fingerprintOf(key);
  if (fingerprint !== EXPECTED_FINGERPRINT) {
    return { state: 'unofficial', reason: '更新公钥指纹与官方不一致', key: { fingerprint } };
  }
  if (!verifyRawSignature(raw, sig, key)) {
    return { state: 'unofficial', reason: '身份清单签名无效', key: { fingerprint } };
  }
  let manifest;
  try {
    manifest = JSON.parse(stripBom(raw.toString('utf8')));
  } catch {
    return { state: 'unknown', reason: '身份清单不是合法 JSON', key: { fingerprint } };
  }
  if (!manifest || manifest.schema !== 1 || manifest.kind !== 'ui-identity') {
    return { state: 'unofficial', reason: '身份清单形状不对', key: { fingerprint } };
  }
  if (manifest.appId !== APP_ID) {
    return { state: 'unofficial', reason: '身份清单与当前程序 appId 不一致', key: { fingerprint } };
  }
  const shapeOk = Array.isArray(manifest.domains) && manifest.domains.length > 0
    && Array.isArray(manifest.selectors) && manifest.selectors.length > 0
    && Array.isArray(manifest.renderers) && manifest.renderers.length > 0;
  if (!shapeOk) {
    return { state: 'unofficial', reason: '身份清单缺少核心锚点', key: { fingerprint } };
  }
  return { state: 'official', manifest, key: { fingerprint }, sha256: sha256(raw) };
}

/**
 * 核心锚点比对：清单里的项必须都在快照里；快照多出来的项一律放行。
 * `orderOk` 只看核心 ID 的相对顺序（多出来的页插在中间不影响）。
 */
export function evaluateIdentity(manifest, snapshot) {
  const missing = [];
  const extra = [];
  const domains = Array.isArray(manifest?.domains) ? manifest.domains : [];
  const snapDomains = Array.isArray(snapshot?.domains) ? snapshot.domains : [];
  const snapById = new Map(snapDomains.map((d) => [d.id, d]));
  const coreDomainIds = domains.map((d) => d.id);

  for (const md of domains) {
    const sd = snapById.get(md.id);
    if (!sd) { missing.push(`domain:${md.id}`); continue; }
    if (sd.label !== md.label) missing.push(`domain-label:${md.id}`);
    const pages = Array.isArray(md.pages) ? md.pages : [];
    const spById = new Map((Array.isArray(sd.pages) ? sd.pages : []).map((p) => [p.id, p]));
    const corePageIds = pages.map((p) => p.id);
    for (const mp of pages) {
      const sp = spById.get(mp.id);
      if (!sp) { missing.push(`page:${md.id}/${mp.id}`); continue; }
      if (sp.label !== mp.label) missing.push(`page-label:${md.id}/${mp.id}`);
    }
    const actualOrder = (Array.isArray(sd.pages) ? sd.pages : [])
      .map((p) => p.id).filter((id) => corePageIds.includes(id));
    if (actualOrder.join('\u0000') !== corePageIds.join('\u0000')) missing.push(`page-order:${md.id}`);
  }

  const actualDomainOrder = snapDomains.map((d) => d.id).filter((id) => coreDomainIds.includes(id));
  if (actualDomainOrder.join('\u0000') !== coreDomainIds.join('\u0000')) missing.push('domain-order');

  const selectors = Array.isArray(manifest?.selectors) ? manifest.selectors : [];
  const snapSelectors = new Set(Array.isArray(snapshot?.selectors) ? snapshot.selectors : []);
  for (const sel of selectors) if (!snapSelectors.has(sel)) missing.push(`selector:${sel}`);

  const renderers = Array.isArray(manifest?.renderers) ? manifest.renderers : [];
  const snapRenderers = new Set(Array.isArray(snapshot?.renderers) ? snapshot.renderers : []);
  for (const r of renderers) if (!snapRenderers.has(r)) missing.push(`renderer:${r}`);

  const coreSelectors = new Set(selectors);
  for (const sel of snapSelectors) if (!coreSelectors.has(sel)) extra.push(`selector:${sel}`);
  const coreRenderers = new Set(renderers);
  for (const r of snapRenderers) if (!coreRenderers.has(r)) extra.push(`renderer:${r}`);
  for (const d of snapDomains) if (!coreDomainIds.includes(d.id)) extra.push(`domain:${d.id}`);

  return { ok: missing.length === 0, missing, extra };
}

let cached = null;
let cachedKey = '';

/** 面板 /api/state 用的状态；整体 try/catch，永不因为身份文件缺失把读路由拖崩。 */
export function uiIdentityState(env = process.env) {
  const file = resolveIdentityFile(env);
  const sigFile = resolveSigFile(file, env);
  const key = `${file}\u0000${sigFile}\u0000${env.QQBOT_UPDATE_PUBKEY || ''}`;
  if (cached && cachedKey === key) return cached;
  let value;
  try {
    const v = verifyIdentity({ file, sigFile, env });
    value = {
      state: v.state,
      reason: v.reason || '',
      checkedAt: Date.now(),
      key: v.key || null,
      manifest: v.manifest ? { sha256: v.sha256 } : null,
      anchors: v.state === 'official' ? {
        domains: v.manifest.domains,
        selectors: v.manifest.selectors,
        renderers: v.manifest.renderers,
      } : null,
    };
  } catch {
    value = { state: 'unknown', reason: '身份校验异常', checkedAt: Date.now(), key: null, manifest: null, anchors: null };
  }
  cached = value;
  cachedKey = key;
  return value;
}

export function resetUiIdentityCache() {
  cached = null;
  cachedKey = '';
}
