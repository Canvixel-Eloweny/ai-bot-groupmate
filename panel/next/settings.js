/**
 * 左下角设置层（2026-10-23 · P2；2026-10-26 按桌面预览复刻）
 *
 * 只做四件事：外观（localStorage；自定义背景存用户数据目录，旧 IndexedDB 自动迁移）、启动与关闭（config.json）、
 * 关于（只读 + 同源星数）、数据（复用现有导出动作）。
 * 业务状态仍由 app.js 的 S 管理；本模块只渲染与提交，不另存一份偏好。
 */

const ACCENTS = [
  { id: 'ocean',  name: '海蓝',   l: '#2f509b', d: '#9dbfeb' },
  { id: 'lagoon', name: '青碧',   l: '#116b74', d: '#7fd4d6' },
  { id: 'pine',   name: '松绿',   l: '#2f6b45', d: '#8ed8ad' },
  { id: 'amber',  name: '琥珀',   l: '#8a5a12', d: '#f0c27d' },
  { id: 'coral',  name: '珊瑚',   l: '#a4413a', d: '#f2a29a' },
  { id: 'berry',  name: '莓红',   l: '#8f2f5f', d: '#efa4c8' },
  { id: 'violet', name: '紫罗兰', l: '#5b4a9e', d: '#bdb0f2' },
  { id: 'mono',   name: '黑白',   l: '#1c1c1e', d: '#f2f5fa' },
  { id: 'graphite', name: '石墨', l: '#3f4652', d: '#c2cad6' },
];
const REPO_FALLBACK = 'https://github.com/Canvixel-Eloweny/ai-bot-groupmate';
/* 工厂域转场动画：纯本机外观偏好（localStorage），默认开启。
   app.js 的导航触发器也 import 这一个函数 —— 键名只在这里写一次，
   避免"开关写一个键、触发器读另一个键"那种静默失效。 */
const FACTORY_WIPE_KEY = 'next-factory-wipe';
export function factoryWipeOn() {
  try { return localStorage.getItem(FACTORY_WIPE_KEY) !== 'off'; } catch { return true; }
}
/* 2026-10-28：名单尚未确定 —— 先保留 6 个席位，全部用占位信息。
   维护者确认一个人后，直接把对应行的 name / role / id / since 换掉并去掉 placeholder。
   ⚠️ 「虚位以待」不是真实致谢；卡片为空是当前状态，不是渲染缺陷。 */
const SUPPORTERS = Object.freeze([
  { name: '虚位以待', role: '待定', id: 'EST-XXX', since: '—', avatar: '', placeholder: true },
  { name: '虚位以待', role: '待定', id: 'EST-XXX', since: '—', avatar: '', placeholder: true },
  { name: '虚位以待', role: '待定', id: 'EST-XXX', since: '—', avatar: '', placeholder: true },
  { name: '虚位以待', role: '待定', id: 'EST-XXX', since: '—', avatar: '', placeholder: true },
  { name: '虚位以待', role: '待定', id: 'EST-XXX', since: '—', avatar: '', placeholder: true },
  { name: '虚位以待', role: '待定', id: 'EST-XXX', since: '—', avatar: '', placeholder: true },
]);
const SUB_NAV = {
  'sec-appearance': [
    { label: '显示模式', target: 'card-appearance-mode' },
    { label: '主题色', target: 'card-appearance-accent' },
    { label: '转场动画', target: 'card-appearance-motion' },
    { label: '背景', target: 'card-appearance-bg' },
    { label: '自定义背景', target: 'card-appearance-cbg' },
    { label: '字体', target: 'card-appearance-font' },
  ],
  'sec-startup': [
    { label: '开屏动画', target: 'card-startup-splash' },
    { label: '打开方式', target: 'card-startup-mode' },
    { label: '启动偏好', target: 'card-startup-prefs' },
    { label: '关闭行为', target: 'card-startup-close' },
    { label: '上次启动', target: 'card-startup-last' },
  ],
  'sec-about': [
    { label: '版本情况', target: 'card-about-version' },
    { label: 'GitHub', target: 'card-about-github' },
    { label: '意见箱', target: 'card-about-feedback' },
  ],
};

const $ = (id) => document.getElementById(id);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const checkIcon = () => '<svg aria-hidden="true"><use href="#si-check"/></svg>';

export function initSettings(deps) {
  const layer = $('settingsLayer');
  if (!layer) return;

  const panel = $('settingsPanel');
  const scroll = $('settingsScroll');
  const gear = $('setGear');
  const gearRot = $('setGearRot');
  const backdrop = $('settingsBackdrop');
  const closeBtn = $('settingsClose');
  const railEl = $('setRail');
  const railItems = $$('.set-rail-item', railEl);
  const pages = $$('.set-section', scroll);
  const reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  let isOpen = false;
  let lastFocus = null;
  let introTimer = 0;
  let pageAnimTimer = 0;
  let bgTries = 0;

  const stateOf = () => (deps.getState() && deps.getState().state) || {};
  const launchOf = () => {
    const s = stateOf();
    return (s.config && s.config.launch) || {};
  };
  const themeNow = () => document.documentElement.dataset.theme || 'light';
  const accentNow = () => document.documentElement.dataset.accent || 'ocean';
  const fontNow = () => document.documentElement.dataset.fontStyle || 'sans';

  /* ── 主题 / 主题色 / 字体 ─────────────────────────────────────────── */
  const accentIds = (window.__accentBoot && Array.isArray(window.__accentBoot.values))
    ? window.__accentBoot.values.slice()
    : ACCENTS.map((a) => a.id);
  const accentById = (id) => ACCENTS.find((a) => a.id === id) || ACCENTS[0];
  const accentGrid = $('accentGrid');
  if (accentGrid) {
    accentGrid.innerHTML = accentIds.map((id) => {
      const a = accentById(id);
      return `<button class="set-acc" type="button" data-accent-opt="${esc(a.id)}" aria-pressed="false" aria-label="主题色：${esc(a.name)}" style="--dot-l:${a.l};--dot-d:${a.d}">`
        + `<span class="set-acc-dot">${checkIcon()}</span><span>${esc(a.name)}</span></button>`;
    }).join('');
    accentGrid.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-accent-opt]');
      if (!btn) return;
      deps.setAccent(btn.dataset.accentOpt);
      paintAccents();
      paintChip();
    });
  }

  const themeSeg = $('setThemeSeg');
  if (themeSeg) {
    themeSeg.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-theme-opt]');
      if (!btn) return;
      const next = btn.dataset.themeOpt;
      // 先翻控件与标题：主题本身由 View Transition 在下一帧写入，
      // 等它 await 完再画会让分段控件空转约 1 秒。
      paintTheme(next);
      paintChip(next);
      await deps.applyTheme(next, btn);
      paintTheme();
      paintChip();
    });
  }
  const fontGrid = $('fontGrid');
  if (fontGrid) {
    fontGrid.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-font-opt]');
      if (!btn) return;
      deps.setFontStyle(btn.dataset.fontOpt);
      paintFont();
    });
  }

  function paintTheme(override) {
    const t = override || themeNow();
    if (themeSeg) {
      themeSeg.dataset.mode = t;
      $$('[data-theme-opt]', themeSeg).forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.themeOpt === t));
      });
    }
  }
  function paintAccents() {
    const a = accentNow();
    $$('[data-accent-opt]', accentGrid || document).forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.accentOpt === a));
    });
    if ($('setAccentName')) $('setAccentName').textContent = accentById(a).name;
  }
  function paintFont() {
    const f = fontNow() === 'serif' ? 'serif' : 'sans';
    $$('[data-font-opt]', fontGrid || document).forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.fontOpt === f));
    });
  }
  function paintChip(themeOverride) {
    const label = accentById(accentNow()).name;
    const theme = (themeOverride || themeNow()) === 'dark' ? '夜间' : '日间';
    if ($('setChip')) $('setChip').textContent = `${label} · ${theme}`;
    if ($('setAccentName')) $('setAccentName').textContent = label;
  }

  /* ── 背景 + 速度（数据源仍是 shader-bg.js）────────────────────────── */
  function paintSpeed() {
    const box = $('bgSpeed');
    if (!box) return;
    const sb = window.ShaderBG;
    const speeds = (sb && sb.SPEEDS) || [];
    if (!speeds.length) { box.innerHTML = ''; return; }
    if (box.childElementCount !== speeds.length) {
      box.innerHTML = speeds.map((s) => `<button type="button" data-speed="${s.v}" aria-pressed="false">${esc(s.label)}</button>`).join('');
    }
    const cur = sb ? sb.speed : null;
    $$('[data-speed]', box).forEach((b) => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === Number(cur)));
    });
  }

  function bgModeNow() {
    return (window.ContourBG && window.ContourBG.mode) || 'contour';
  }
  function bgLabel() {
    if (customActive()) return '自定义';
    if (bgModeNow() === 'contour') return '等高线';
    const sb = window.ShaderBG;
    const v = sb && (sb.VARIANTS || []).find((x) => x.id === sb.current);
    return v ? v.label : '—';
  }
  function paintBgMode() {
    const box = $('setBgMode');
    const mode = bgModeNow();
    if (box) {
      box.dataset.bgmode = mode;
      $$('[data-bgmode-opt]', box).forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.bgmodeOpt === mode));
      });
    }
    const pick = $('bgPick');
    if (pick) pick.hidden = mode !== 'shader';
  }
  function paintBackground() {
    if ($('setBgName')) $('setBgName').textContent = bgLabel();
    paintBgMode();
    paintSpeed();
    paintBgSelection();
  }

  function withShader(cb) {
    if (window.ShaderBG) { cb(); return; }
    if (bgTries >= 60) return;
    bgTries += 1;
    setTimeout(() => withShader(cb), 50);
  }

  const bgSpeed = $('bgSpeed');
  if (bgSpeed) {
    bgSpeed.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-speed]');
      if (!btn || !window.ShaderBG) return;
      window.ShaderBG.setSpeed(Number(btn.dataset.speed));
      paintSpeed();
      deps.toast(`背景速度：${btn.textContent}`, 'ok');
    });
  }
  const bgModeBox = $('setBgMode');
  if (bgModeBox) {
    bgModeBox.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-bgmode-opt]');
      if (!btn || !window.ContourBG) return;
      if (customActive()) deactivateCustomBg(false);
      window.ContourBG.setMode(btn.dataset.bgmodeOpt);
      paintBackground();
      deps.toast(`背景模式：${btn.textContent}`, 'ok');
    });
  }
  const bgPickList = $('bgPickList');
  if (bgPickList) {
    bgPickList.addEventListener('click', (ev) => {
      if (!ev.target.closest('.bg-sw')) return;
      if (customActive()) deactivateCustomBg(false);
      setTimeout(() => { paintBackground(); }, 0);
    }, true);
    bgPickList.addEventListener('click', () => setTimeout(paintBackground, 0));
  }
  function paintBgSelection() {
    if (!bgPickList) return;
    const custom = !!customActive();
    const current = window.ShaderBG && window.ShaderBG.current;
    $$('.bg-sw', bgPickList).forEach((b) => {
      b.setAttribute('aria-checked', String(!custom && b.dataset.id === current));
    });
    if ($('setBgName')) $('setBgName').textContent = bgLabel();
  }

  /* ── 启动 / 关闭偏好 ──────────────────────────────────────────────── */
  function setSeg(id, attr, value) {
    $$(`#${id} [${attr}]`).forEach((b) => {
      b.setAttribute('aria-pressed', String(b.getAttribute(attr) === value));
    });
  }
  function setSwitch(id, on) {
    const b = $(id);
    if (b) b.setAttribute('aria-checked', String(!!on));
  }
  function isSwitchOn(id) {
    const b = $(id);
    return !!b && b.getAttribute('aria-checked') === 'true';
  }

  async function saveLaunch(patch, okMsg) {
    try {
      const r = await deps.post('/api/config', { launch: patch });
      deps.toast((r && r.msg) || okMsg, 'ok');
      await deps.refresh(true);
      paintLaunch();
    } catch (e) {
      deps.toast(`保存失败：${e.message}`, 'bad');
      paintLaunch();
    }
  }

  const lastLaunch = $('setLastLaunch');
  function paintLastLaunch(last) {
    if (!lastLaunch) return;
    if (!last || typeof last !== 'object') {
      lastLaunch.innerHTML = '<dt>记录</dt><dd>启动一次控制台后这里会出现</dd>';
      return;
    }
    const at = last.t ? new Date(last.t) : null;
    const time = at && !Number.isNaN(at.getTime()) ? at.toLocaleString('zh-CN', { hour12: false }) : '—';
    const how = last.used || last.kind || last.mode || '—';
    const result = last.skipped
      ? '按设置未打开界面'
      : (last.opened === false ? `打开失败（${last.error || '原因未知'}）` : '已打开');
    lastLaunch.innerHTML = [
      ['时间', time],
      ['入口', last.entryLabel || last.entry || '—'],
      ['形态', how],
      ['结果', result],
    ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  }

  function paintLaunch() {
    const l = launchOf();
    setSeg('setModeSeg', 'data-mode-opt', l.mode === 'window' ? 'window' : 'browser');
    setSeg('setCloseSeg', 'data-close-opt', l.closeAction === 'quit' ? 'quit' : 'tray');
    setSwitch('setOpenOnStart', l.openOnStart !== false);
    setSwitch('setAutoProtocol', l.autoProtocol !== false);

    const auto = String(l.autoStartState || 'unsupported');
    setSwitch('setAutostart', auto === 'on');
    const autoBtn = $('setAutostart');
    if (autoBtn) autoBtn.disabled = auto === 'unsupported';
    const autoHint = $('setAutostartHint');
    if (autoHint) {
      autoHint.textContent = auto === 'on' ? '已写入 Windows 启动项。'
        : auto === 'blocked' ? '任务管理器已禁用这个启动项；再开启会清除禁用状态。'
          : auto === 'off' ? '当前未开启；仅 Windows 安装版可用。'
            : '仅 Windows 安装版可用。';
    }
    const closeHint = $('setCloseHint');
    if (closeHint) {
      closeHint.textContent = l.closeAction === 'quit'
        ? '关闭窗口会走完整停止链：结束机器人与协议端，并核对没有残留进程。'
        : '程序继续在后台运行；托盘不可用时，关闭会自动最小化到任务栏。';
    }
    paintLastLaunch(l.last);
  }

  const modeSeg = $('setModeSeg');
  if (modeSeg) {
    modeSeg.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-mode-opt]');
      if (!btn) return;
      if (btn.getAttribute('aria-pressed') === 'true') return;
      saveLaunch({ mode: btn.dataset.modeOpt }, '已保存 —— 下次启动生效');
    });
  }
  const closeSeg = $('setCloseSeg');
  if (closeSeg) {
    closeSeg.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-close-opt]');
      if (!btn) return;
      if (btn.getAttribute('aria-pressed') === 'true') return;
      const quit = btn.dataset.closeOpt === 'quit';
      saveLaunch({ closeAction: quit ? 'quit' : 'tray' },
        quit ? '已保存 —— 关闭窗口将退出程序' : '已保存 —— 关闭窗口将驻留托盘');
    });
  }

  $$('[data-set]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const key = btn.dataset.set;
      if (key === 'splash') {
        const next = !isSwitchOn(btn.id);
        btn.setAttribute('aria-checked', String(next));
        writeSplash(next);
        if (next) replaySplash();
        deps.toast(next ? '开屏动画已开启' : '开屏动画已关闭', 'ok');
        return;
      }
      if (key === 'factoryWipe') {
        const next = !isSwitchOn(btn.id);
        writeFactoryWipe(next);
        deps.toast(next ? '工厂转场动画已开启' : '工厂转场动画已关闭', 'ok');
        return;
      }
      const next = !isSwitchOn(btn.id);
      btn.setAttribute('aria-checked', String(next));
      if (key === 'autoStart') {
        saveLaunch({ autoStart: next }, next ? '已写入系统启动项' : '已移除系统启动项');
      } else if (key === 'autoProtocol') {
        saveLaunch({ autoProtocol: next }, '已保存 —— 下次启动生效');
      } else if (key === 'openOnStart') {
        saveLaunch({ openOnStart: next }, '已保存 —— 下次启动生效');
      }
    });
  });

  /* ── 关于 / 仓库 / 星数 ───────────────────────────────────────────── */
  function stripRepo(url) {
    return String(url || '').replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '');
  }
  function repoBase() {
    const repo = String((stateOf().appMeta || {}).repo || '').trim() || REPO_FALLBACK;
    return repo.replace(/\.git$/i, '').replace(/\/$/, '');
  }
  function setLink(id, href) {
    const a = $(id);
    if (!a) return;
    if (href) {
      a.href = href;
      a.removeAttribute('aria-disabled');
    } else {
      a.href = '#';
      a.setAttribute('aria-disabled', 'true');
    }
  }

  function paintAbout() {
    const s = stateOf();
    const meta = s.appMeta || {};
    const u = s.update || {};
    const version = meta.version || u.currentVersion || '—';
    const versionText = version === '—' ? '版本未知' : `v${version}`;
    if ($('aboutVersion')) $('aboutVersion').textContent = versionText;
    if ($('setRailVersion')) $('setRailVersion').textContent = versionText;
    const ua = navigator.userAgent || '';
    const em = ua.match(/Electron\/([\d.]+)/);
    if ($('aboutShell')) $('aboutShell').textContent = em ? `Electron ${em[1]}` : '浏览器模式';
    if ($('aboutBuild')) $('aboutBuild').textContent = em ? '桌面版' : '浏览器版';
    if ($('aboutRuntime')) {
      $('aboutRuntime').textContent = meta.runtime ? `Node ${meta.runtime}` : '—';
    }
    const idn = s.uiIdentity || {};
    if ($('aboutUiIdentity')) {
      $('aboutUiIdentity').textContent = idn.state === 'official'
        ? '官方签名'
        : idn.state === 'unofficial'
          ? '非官方界面（核心骨架不符）'
          : '未知 / 旧后端';
    }

    let last = '尚未检查';
    if (u.phase === 'checking') last = '检查中…';
    else if (u.phase === 'up_to_date') last = '已是最新';
    else if (u.phase === 'available') last = `发现 v${(u.latest && u.latest.version) || '?'}`;
    else if (u.phase === 'downloading') last = `正在下载${u.progress && u.progress.percent != null ? ` ${u.progress.percent}%` : ''}`;
    else if (u.phase === 'ready') last = `v${(u.latest && u.latest.version) || '?'} 已下载，待安装`;
    else if (u.phase === 'error') last = `检查失败：${u.error || '未知原因'}`;
    else if (u.checkedAt) last = `上次检查 ${new Date(u.checkedAt).toLocaleString('zh-CN', { hour12: false })}`;
    if ($('aboutUpdateState')) $('aboutUpdateState').textContent = last;

    const repo = repoBase();
    if ($('aboutRepoPath')) {
      $('aboutRepoPath').textContent = repo ? stripRepo(repo).replace('/', ' / ') : '未提供仓库地址';
    }
    setLink('repoOpen', repo);
    setLink('repoIssues', repo ? `${repo.replace(/\/$/, '')}/issues/new` : '');
    setLink('repoReleases', repo ? `${repo.replace(/\/$/, '')}/releases` : '');
    const star = $('repoStar');
    if (star) star.href = `${repo.replace(/\/$/, '')}/stargazers`;
    const copy = $('repoCopy');
    if (copy) copy.disabled = !repo;
    paintStarsFromCache();
  }

  const copyBtn = $('repoCopy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const repo = repoBase();
      if (!repo) return;
      try {
        await navigator.clipboard.writeText(repo);
        deps.toast('仓库地址已复制', 'ok');
      } catch {
        const ta = document.createElement('textarea');
        ta.value = repo;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { /* 老浏览器 */ }
        ta.remove();
        deps.toast(ok ? '仓库地址已复制' : '复制失败，请手动选择地址', ok ? 'ok' : 'warn');
      }
    });
  }

  const updateBtn = panel && panel.querySelector('[data-a="update.check"]');
  if (updateBtn) setTimeout(() => updateBtn.addEventListener('click', () => setTimeout(paintAbout, 1500)), 0);

  /* 星数：只走同源接口；接口不存在时显示缓存或 —，绝不直连 GitHub API（CSP）。 */
  const STARS_CACHE_KEY = 'estrella-github-stars-v1';
  const STARS_REFRESH_MS = 5 * 60 * 1000;
  const STARS_MIN_GAP = 2 * 60 * 1000;
  let starsInFlight = false;
  let starsLastFetch = 0;
  let starTimer = 0;

  function readStarCache() {
    try {
      const raw = localStorage.getItem(STARS_CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data && typeof data.count === 'number' && isFinite(data.count) && data.count >= 0) return data;
    } catch { /* 隐私模式 */ }
    return null;
  }
  function writeStarCache(count) {
    try { localStorage.setItem(STARS_CACHE_KEY, JSON.stringify({ count, at: Date.now() })); } catch { /* 忽略 */ }
  }
  function starTime(ts) {
    try { return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
  }
  function starText(count) { return Number(count).toLocaleString('zh-CN'); }

  function paintStars(count, mode, at, busy) {
    const star = $('repoStar');
    const num = $('repoStars');
    if (!star || !num) return;
    const text = starText(count);
    num.textContent = text;
    if (busy) star.setAttribute('aria-busy', 'true');
    else star.removeAttribute('aria-busy');
    star.title = mode === 'live'
      ? `GitHub Star · ${text} · 更新于 ${starTime(at || Date.now())}`
      : `GitHub Star · ${text}${at ? ` · 缓存于 ${starTime(at)}` : ' · 缓存值'}`;
    star.setAttribute('aria-label', `在 GitHub 查看 ${text} 个 Star${mode === 'live' ? '' : '（缓存）'}`);
  }
  function paintStarsUnavailable(cache) {
    const star = $('repoStar');
    const num = $('repoStars');
    if (!star || !num) return;
    if (cache) {
      paintStars(cache.count, 'cache', cache.at, false);
      star.title = `GitHub Star · ${starText(cache.count)} · 缓存值，暂时无法连接`;
      return;
    }
    num.textContent = '—';
    star.removeAttribute('aria-busy');
    star.title = 'GitHub Star · 暂时无法读取（稍后自动重试）';
    star.setAttribute('aria-label', '在 GitHub 查看 Star 数（暂时无法读取）');
  }
  function paintStarsFromCache() {
    const cache = readStarCache();
    if (cache) paintStars(cache.count, 'cache', cache.at, true);
  }
  function refreshRepoStars(force) {
    const star = $('repoStar');
    const num = $('repoStars');
    if (!star || !num || starsInFlight || typeof fetch !== 'function') {
      if (!starsInFlight && typeof fetch !== 'function') paintStarsUnavailable(readStarCache());
      return;
    }
    const now = Date.now();
    if (!force && now - starsLastFetch < STARS_MIN_GAP) return;
    starsInFlight = true;
    starsLastFetch = now;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 8000) : 0;
    const opts = { headers: { Accept: 'application/json' }, cache: 'no-store' };
    if (controller) opts.signal = controller.signal;
    // 同源星数接口；失败时落回缓存或 —，不在浏览器里直连 GitHub（CSP 只允许同源）。
    fetch('/api/github/star', opts)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const count = data && (data.count ?? data.stars ?? data.stargazers_count);
        if (typeof count !== 'number' || !isFinite(count) || count < 0) throw new Error('missing count');
        const at = Date.now();
        writeStarCache(count);
        paintStars(count, 'live', at, false);
      })
      .catch(() => paintStarsUnavailable(readStarCache()))
      .finally(() => {
        if (timer) clearTimeout(timer);
        starsInFlight = false;
      });
  }
  /* 启动时只画缓存；真正请求 /api/github/star 推迟到设置层第一次打开 ——
     首屏少一条网络请求，星数也不需要参与开屏竞速。 */
  paintStarsFromCache();
  let starsStarted = false;
  function startRepoStars() {
    if (starsStarted || !$('repoStar') || !$('repoStars')) return;
    starsStarted = true;
    refreshRepoStars(true);
    starTimer = setInterval(() => { if (!document.hidden) refreshRepoStars(false); }, STARS_REFRESH_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshRepoStars(false); });
  }
  /* 自定义背景视频在窗口隐藏/最小化时不该继续解码；设置层开着时由 open/close 管。 */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseCustomVideoForSettings();
    else if (!isOpen) resumeCustomVideoForSettings();
  });

  /* ── 鸣谢名单（只读；维护者随版本改这一份数组）───────────────────── */
  (function renderSupporters() {
    const grid = $('supportersGrid');
    const countEl = $('supporterCount');
    if (!grid) return;
    grid.textContent = '';
    const allPlaceholder = SUPPORTERS.length > 0 && SUPPORTERS.every((p) => p.placeholder);
    if (countEl) {
      countEl.textContent = SUPPORTERS.length
        ? (allPlaceholder ? `共 ${SUPPORTERS.length} 席` : `共 ${SUPPORTERS.length} 位`)
        : '待发布';
    }
    if (!SUPPORTERS.length) {
      const empty = document.createElement('li');
      empty.className = 'supporters-empty';
      empty.textContent = '名单尚未发布。';
      grid.appendChild(empty);
      return;
    }
    const star = '<svg aria-hidden="true"><use href="#si-star"/></svg>';
    SUPPORTERS.forEach((person) => {
      const li = document.createElement('li');
      li.className = 'supporter-badge';

      const strap = document.createElement('span');
      strap.className = 'badge-strap';
      strap.setAttribute('aria-hidden', 'true');
      strap.innerHTML = star;
      li.appendChild(strap);

      const clip = document.createElement('span');
      clip.className = 'badge-clip';
      clip.setAttribute('aria-hidden', 'true');
      li.appendChild(clip);

      const card = document.createElement('article');
      card.className = 'badge-card';

      const slot = document.createElement('span');
      slot.className = 'badge-slot';
      slot.setAttribute('aria-hidden', 'true');
      card.appendChild(slot);

      const photoWrap = document.createElement('div');
      photoWrap.className = 'badge-photo-wrap';
      const photo = document.createElement('div');
      photo.className = 'badge-photo is-empty';
      photo.setAttribute('aria-hidden', 'true');
      if (person.avatar) {
        photo.classList.remove('is-empty');
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = person.avatar;
        img.addEventListener('error', () => {
          img.remove();
          photo.classList.add('is-empty');
        });
        photo.appendChild(img);
      }
      const mark = document.createElement('span');
      mark.className = 'badge-photo-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.innerHTML = star;
      photo.appendChild(mark);
      photoWrap.appendChild(photo);

      const seal = document.createElement('span');
      seal.className = 'badge-seal';
      seal.setAttribute('aria-hidden', 'true');
      seal.innerHTML = star;
      photoWrap.appendChild(seal);
      card.appendChild(photoWrap);

      const name = document.createElement('h4');
      name.className = 'badge-name';
      name.textContent = person.name;
      name.title = person.name;
      card.appendChild(name);

      const role = document.createElement('span');
      role.className = 'badge-role';
      role.textContent = person.role;
      card.appendChild(role);

      const meta = document.createElement('div');
      meta.className = 'badge-meta';
      const idLine = document.createElement('span');
      idLine.textContent = person.id;
      const sinceLine = document.createElement('span');
      sinceLine.textContent = `SINCE ${person.since}`;
      meta.append(idLine, sinceLine);
      card.appendChild(meta);

      li.appendChild(card);
      grid.appendChild(li);
    });
  })();

  /* ── 意见箱：只打开 GitHub Issue 预填页，不上传、不落盘 ──────────── */
  const FB_TYPE_KEY = 'next-feedback-type';
  let feedbackType = 'suggestion';
  try {
    const savedType = localStorage.getItem(FB_TYPE_KEY);
    if (['suggestion', 'problem', 'other'].includes(savedType)) feedbackType = savedType;
  } catch { /* 隐私模式 */ }
  const fbText = $('fbText');
  const fbCount = $('fbCount');
  const fbSubmit = $('fbSubmit');
  const fbError = $('fbError');
  const fbForm = $('feedbackForm');

  function paintFeedbackType() {
    $$('[data-fb-type]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.fbType === feedbackType));
    });
  }
  function syncFb() {
    if (!fbText || !fbSubmit) return;
    const n = fbText.value.length;
    if (fbCount) fbCount.textContent = `${n} / 500`;
    fbSubmit.disabled = fbText.value.trim().length < 4;
    if (fbText.value.trim().length >= 4) {
      fbText.removeAttribute('aria-invalid');
      if (fbError) fbError.hidden = true;
    }
  }
  if (fbText) {
    fbText.addEventListener('input', syncFb);
    paintFeedbackType();
    syncFb();
  }
  $$('[data-fb-type]').forEach((b) => {
    b.addEventListener('click', () => {
      feedbackType = b.dataset.fbType;
      try { localStorage.setItem(FB_TYPE_KEY, feedbackType); } catch { /* 隐私模式 */ }
      paintFeedbackType();
    });
  });
  if (fbForm) {
    fbForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!fbText) return;
      const text = fbText.value.trim();
      if (text.length < 4) {
        fbText.setAttribute('aria-invalid', 'true');
        if (fbError) fbError.hidden = false;
        fbText.focus();
        return;
      }
      const typeLabel = { suggestion: '建议', problem: '问题', other: '其他' }[feedbackType] || '建议';
      const contact = ($('fbContact') && $('fbContact').value.trim()) || '';
      const meta = stateOf().appMeta || {};
      const version = meta.version || (stateOf().update && stateOf().update.currentVersion) || '—';
      const body = [
        `类型：${typeLabel}`,
        '',
        text,
        contact ? `\n联系方式：${contact}` : '',
        '',
        `版本：${version}`,
        `页面：${location.href}`,
      ].join('\n');
      const title = `[${typeLabel}] 面板意见`;
      const url = `${repoBase()}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
      // 用真实锚点而不是 window.open：带 noopener 时 window.open 会返回 null，
      // 再走 fallback 会打开两个标签页。锚点只开一个，且保留 noopener。
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
      fbText.value = '';
      if ($('fbContact')) $('fbContact').value = '';
      syncFb();
      deps.toast('已打开 GitHub Issue 预填页；面板没有上传或保存这段内容。', 'ok');
    });
  }

  /* ── 数据：按范围导出（大小来自服务端 dry=1）─────────────────────── */
  let scopeRows = [];
  let scopeLoaded = false;
  const fmtBytes = (n) => {
    const v = Math.max(0, Number(n) || 0);
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1024 / 1024).toFixed(1)} MB`;
  };
  function selectedScopes() {
    return $$('#exportScopes [data-scope]').filter((i) => i.checked).map((i) => i.dataset.scope);
  }
  function paintScopeTotal() {
    const ids = new Set(selectedScopes());
    const total = scopeRows.filter((r) => ids.has(r.id)).reduce((n, r) => n + (Number(r.bytes) || 0), 0);
    if ($('exportTotal')) $('exportTotal').innerHTML = `合计 <b>${fmtBytes(total)}</b> · ${ids.size} 项`;
    if ($('exportSelected')) $('exportSelected').disabled = ids.size === 0;
  }
  async function loadScopes(force) {
    const box = $('exportScopes');
    if (!box || !deps.api) return;
    if (scopeLoaded && !force) return;
    box.innerHTML = '<p class="set-hint">正在读取可导出范围…</p>';
    try {
      const data = await deps.api('/api/custom/export?what=selected&dry=1');
      scopeRows = Array.isArray(data && data.scopes) ? data.scopes : [];
      if (!scopeRows.length) {
        box.innerHTML = '<p class="set-hint">当前没有可导出的数据。</p>';
        paintScopeTotal();
        return;
      }
      box.innerHTML = scopeRows.map((r) => {
        const files = Array.isArray(r.files) ? r.files.join(' · ') : '';
        return `<label class="set-scope"><input type="checkbox" data-scope="${esc(r.id)}" checked>`
          + `<span class="txt"><b>${esc(r.label || r.id)}</b><span>${esc(files)}</span></span>`
          + `<span class="size">${fmtBytes(r.bytes)}</span></label>`;
      }).join('');
      scopeLoaded = true;
      paintScopeTotal();
    } catch (e) {
      box.innerHTML = `<p class="set-hint">范围读取失败：${esc(e.message)}；仍可用下面的完整数据包。</p>`;
    }
  }
  const scopeBox = $('exportScopes');
  if (scopeBox) scopeBox.addEventListener('change', paintScopeTotal);
  const exportSelected = $('exportSelected');
  if (exportSelected) {
    exportSelected.addEventListener('click', () => {
      const ids = selectedScopes();
      if (!ids.length) return deps.toast('先选至少一项再导出', 'warn');
      deps.exportSelected(ids);
    });
  }

  /* ── 恢复默认外观 ─────────────────────────────────────────────────── */
  const reset = $('setResetAppearance');
  if (reset) {
    reset.addEventListener('click', async () => {
      if (customActive()) deactivateCustomBg(false);
      deps.setAccent('ocean');
      deps.setFontStyle('sans');
      await deps.applyTheme('light');
      if (window.ContourBG) window.ContourBG.setMode('contour');
      const sb = window.ShaderBG;
      const defaultBg = sb ? (sb.DEFAULT || sb.VARIANTS[0].id) : '';
      if (sb) {
        sb.set(defaultBg);
        sb.setSpeed(66);
      }
      paintAll();
      const resetBgLabel = (window.ContourBG && window.ContourBG.mode === 'contour')
        ? '等高线'
        : ((sb && (sb.VARIANTS || []).find((x) => x.id === defaultBg) || {}).label || '默认');
      deps.toast(`外观已恢复为默认：海蓝 · 日间 · ${resetBgLabel} · 无衬线`, 'ok');
    });
  }

  /* ── 齿轮 / 开合 ─────────────────────────────────────────────────── */
  function currentRotation(el) {
    const t = getComputedStyle(el).transform;
    if (!t || t === 'none') return 0;
    try {
      const m = new DOMMatrixReadOnly(t);
      return Math.atan2(m.b, m.a) * 180 / Math.PI;
    } catch { return 0; }
  }
  let gearAnim = null;
  function spinGear(open) {
    if (!gearRot) return;
    if (reduceMQ.matches || typeof gearRot.animate !== 'function') {
      if (gearAnim) { gearAnim.cancel(); gearAnim = null; }
      gearRot.style.transform = open ? 'rotate(135deg)' : 'none';
      return;
    }
    const from = currentRotation(gearRot);
    if (gearAnim) { gearAnim.cancel(); gearAnim = null; }
    const frames = open
      ? [{ transform: `rotate(${from}deg)` }, { transform: 'rotate(151deg)', offset: .68 }, { transform: 'rotate(135deg)' }]
      : [{ transform: `rotate(${from}deg)` }, { transform: 'rotate(-9deg)', offset: .62 }, { transform: 'rotate(0deg)' }];
    gearAnim = gearRot.animate(frames, {
      duration: open ? 560 : 440,
      easing: 'cubic-bezier(.22,.8,.28,1)',
      fill: 'forwards',
    });
  }

  function setBackgroundInert(on) {
    $$('.topbar, #navrow, #navHotzone, #page, #factoryHost, .foot, .savebar, #banners').forEach((el) => {
      if (on) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    });
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    lastFocus = document.activeElement;
    clearTimeout(introTimer);
    layer.classList.add('is-intro');
    introTimer = setTimeout(() => layer.classList.remove('is-intro'), 1300);
    paintAll();
    startRepoStars();
    layer.dataset.open = 'true';
    layer.removeAttribute('aria-hidden');
    gear.classList.add('is-open');
    gear.setAttribute('aria-expanded', 'true');
    gear.setAttribute('aria-label', '关闭设置');
    gear.title = '关闭设置';
    const label = $('setGear') && $('setGear').querySelector('.set-fab-label');
    if (label) label.textContent = '收起设置';
    document.documentElement.classList.add('settings-open');
    setBackgroundInert(true);
    pauseCustomVideoForSettings();
    if (window.ContourBG) window.ContourBG.setSettingsOpen(true);
    spinGear(true);
    scroll.scrollTop = 0;
    setPage(currentPageId || 'sec-appearance', { animate: false });
    requestAnimationFrame(paintFactoryPreview);
    Promise.resolve(deps.refresh(true)).then(() => {
      if (!isOpen) return;
      paintAll();
      void loadScopes(true);
    }).catch(() => { void loadScopes(true); });
    setTimeout(() => {
      if (panel) panel.focus({ preventScroll: true });
      setPage(currentPageId || 'sec-appearance', { animate: false });
    }, 30);
  }

  function close() {
    if (!isOpen) return;
    stopFactoryPreview();
    if (cropOpen) closeCropEditor();
    isOpen = false;
    layer.dataset.open = 'false';
    layer.setAttribute('aria-hidden', 'true');
    layer.classList.remove('is-intro');
    clearTimeout(introTimer);
    gear.classList.remove('is-open');
    gear.setAttribute('aria-expanded', 'false');
    gear.setAttribute('aria-label', '打开设置');
    gear.title = '设置';
    const label = gear.querySelector('.set-fab-label');
    if (label) label.textContent = '设置';
    document.documentElement.classList.remove('settings-open');
    setBackgroundInert(false);
    resumeCustomVideoForSettings();
    if (window.ContourBG) window.ContourBG.setSettingsOpen(false);
    spinGear(false);
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus({ preventScroll: true });
    else gear.focus({ preventScroll: true });
  }

  layer.setAttribute('aria-hidden', 'true');
  gear.addEventListener('click', () => { if (isOpen) close(); else open(); });
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (backdrop) backdrop.addEventListener('click', close);

  document.addEventListener('keydown', (ev) => {
    if (!isOpen) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (cropOpen) closeCropEditor();
      else close();
      return;
    }
    if (ev.key !== 'Tab' || !panel) return;
    const focusables = $$('a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])', panel)
      .filter((el) => el.offsetParent !== null && !el.closest('[inert]') && getComputedStyle(el).visibility !== 'hidden');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (ev.shiftKey && (active === first || active === panel)) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
  });

  /* ── 分页 + 二级目录（Rare UI hook sidebar 移植）──────────────────── */
  let currentPageId = '';
  const subMap = Object.create(null);
  const HOOK_CORNER = 6;
  const HOOK_TIP = '<svg class="set-hook-tip" width="12" height="7" viewBox="0 0 12 7" fill="none" aria-hidden="true"><path d="M0.5 0a6 6 0 0 0 6 6H12" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 2"/></svg>';

  railItems.forEach((r, i) => {
    r.style.setProperty('--ri', i);
    r.setAttribute('aria-controls', r.getAttribute('data-target'));
  });
  pages.forEach((s) => {
    $$('.set-card', s).forEach((c, i) => c.style.setProperty('--ci', i));
  });

  const railHp = $('setRail') && $('setRail').querySelector('.set-rail-hp');
  let railHpReady = false;
  let railHpSettleT = 0;

  function railHpTarget() {
    const primary = railEl.querySelector('.set-rail-item.is-active');
    if (!primary) return null;
    const sub = primary.nextElementSibling;
    if (!sub || !sub.classList || !sub.classList.contains('set-rail-sub') ||
        !sub.classList.contains('is-open') || !sub.getClientRects().length) return null;
    const label = sub.querySelector('.set-rail-sub-item[aria-current="location"] .set-rail-sub-label');
    return label && label.getClientRects().length ? label : null;
  }

  function syncRailHp(instant, adjust) {
    if (!railEl || !railHp) return;
    const target = railHpTarget();
    if (!target) { railHp.classList.remove('is-ready'); return; }
    const rr = railEl.getBoundingClientRect();
    const tr = target.getBoundingClientRect();
    let x = tr.left - rr.left + railEl.scrollLeft;
    let y = tr.top - rr.top + railEl.scrollTop;
    const w = tr.width;
    const h = tr.height;
    if (!w || !h) return;
    if (adjust) {
      if (adjust.collapseAboveTop != null && adjust.collapseAboveTop < tr.top) {
        y -= adjust.collapseAbove;
      }
      if (adjust.openingSub) y += 2;
    }
    const jump = !!instant || !railHpReady || reduceMQ.matches;
    if (jump) railHp.classList.add('is-jump');
    railHp.style.width = `${w}px`;
    railHp.style.height = `${h}px`;
    railHp.style.transform = `translate3d(${x}px,${y}px,0)`;
    railHp.classList.add('is-ready');
    railHpReady = true;
    if (jump) {
      void railHp.offsetWidth;
      requestAnimationFrame(() => railHp.classList.remove('is-jump'));
    }
  }

  function makeHookRail(kind) {
    const rail = document.createElement('span');
    rail.className = `set-hook-rail is-${kind}`;
    rail.setAttribute('aria-hidden', 'true');
    rail.innerHTML = '<i class="set-hook-line"></i>' + HOOK_TIP;
    return rail;
  }

  function initSubNav(pageId, items) {
    const parent = railEl.querySelector(`.set-rail-item[data-target="${pageId}"]`);
    const page = document.getElementById(pageId);
    if (!parent || !page || !items.length) return null;

    const sub = document.createElement('div');
    sub.className = 'set-rail-sub';
    sub.setAttribute('role', 'group');
    sub.setAttribute('aria-hidden', 'true');
    sub.setAttribute('aria-label', `${page.querySelector('h3').textContent.trim()} · 页内目录`);

    const clip = document.createElement('div');
    clip.className = 'set-rail-sub-clip';
    const list = document.createElement('div');
    list.className = 'set-rail-sub-list';
    const hoverRail = makeHookRail('hover');
    const activeRail = makeHookRail('active');
    list.appendChild(hoverRail);
    list.appendChild(activeRail);

    const buttons = items.map((item) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'set-rail-sub-item';
      b.setAttribute('data-target', item.target);
      const label = document.createElement('span');
      label.className = 'set-rail-sub-label';
      label.textContent = item.label;
      b.appendChild(label);
      list.appendChild(b);
      return b;
    });

    clip.appendChild(list);
    sub.appendChild(clip);
    parent.insertAdjacentElement('afterend', sub);

    const activeLine = activeRail.querySelector('.set-hook-line');
    const activeTip = activeRail.querySelector('.set-hook-tip');
    const hoverLine = hoverRail.querySelector('.set-hook-line');
    const hoverTip = hoverRail.querySelector('.set-hook-tip');
    let centers = [];
    let activeIndex = 0;
    let hoverIndex = null;
    let pointerInside = false;
    let focusInside = false;

    const isOpenSub = () => sub.classList.contains('is-open');

    function setRail(rail, line, tip, from, y, visible) {
      if (y != null) {
        const cornerTop = Math.max(0, y - HOOK_CORNER);
        line.style.top = `${from}px`;
        line.style.height = `${Math.max(0, cornerTop - from)}px`;
        tip.style.top = `${cornerTop}px`;
      }
      rail.classList.toggle('is-visible', !!visible);
    }

    function paint() {
      const activeY = centers[activeIndex] != null ? centers[activeIndex] : null;
      const hoverY = hoverIndex != null && centers[hoverIndex] != null ? centers[hoverIndex] : null;
      setRail(activeRail, activeLine, activeTip, 0, activeY, isOpenSub() && activeY != null);

      const hoverVisible = isOpenSub() && activeY != null && hoverY != null &&
        hoverIndex !== activeIndex && (pointerInside || focusInside);
      let hoverFrom = 0;
      if (activeY != null && hoverY != null) {
        hoverFrom = hoverY <= activeY ? Math.max(0, hoverY - HOOK_CORNER) : activeY;
      }
      setRail(hoverRail, hoverLine, hoverTip, hoverFrom, hoverY, hoverVisible);
    }

    function measure() {
      centers = buttons.map((b) => b.offsetTop + b.offsetHeight / 2);
      paint();
    }

    function setActive(index) {
      if (index < 0 || index >= buttons.length) return;
      activeIndex = index;
      buttons.forEach((b, i) => {
        if (i === index) b.setAttribute('aria-current', 'location');
        else b.removeAttribute('aria-current');
      });
      paint();
    }

    function setOpenSub(open) {
      sub.classList.toggle('is-open', open);
      if (open) sub.removeAttribute('aria-hidden');
      else sub.setAttribute('aria-hidden', 'true');
      clip.inert = !open;
      paint();
    }

    function scrollToTarget(button, toTop) {
      if (toTop) {
        scroll.scrollTo({ top: 0, behavior: reduceMQ.matches ? 'auto' : 'smooth' });
        return;
      }
      const target = document.getElementById(button.getAttribute('data-target'));
      if (!target) return;
      const top = target.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 12;
      scroll.scrollTo({ top: Math.max(0, top), behavior: reduceMQ.matches ? 'auto' : 'smooth' });
    }

    buttons.forEach((button, i) => {
      button.addEventListener('mouseenter', () => {
        pointerInside = true;
        hoverIndex = i;
        paint();
      });
      button.addEventListener('click', () => {
        clearTimeout(railHpSettleT);
        setActive(i);
        scrollToTarget(button, i === 0);
        syncRailHp();
      });
    });
    list.addEventListener('mouseleave', () => {
      pointerInside = false;
      paint();
    });
    list.addEventListener('focusin', (e) => {
      const button = e.target.closest ? e.target.closest('.set-rail-sub-item') : null;
      if (!button) return;
      focusInside = true;
      hoverIndex = buttons.indexOf(button);
      paint();
    });
    list.addEventListener('focusout', (e) => {
      if (list.contains(e.relatedTarget)) return;
      focusInside = false;
      paint();
    });

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(measure).observe(list);
    }

    const controller = { setOpen: setOpenSub, setActive, measure };
    subMap[pageId] = controller;
    measure();
    return controller;
  }

  Object.keys(SUB_NAV).forEach((pageId) => initSubNav(pageId, SUB_NAV[pageId]));

  /* 右侧滚动 → 左侧二级目录联动（2026-10-28）。
     以前只有「点目录滚右侧」，反过来滚右侧时左侧一直停在第一项。
     只读卡片相对滚动容器顶部的位置；点击滚动仍是唯一的写入入口。 */
  let spyIndex = -1;
  let spyRaf = 0;
  function spyTargetIndex(pageId) {
    const items = SUB_NAV[pageId];
    if (!items || !items.length) return -1;
    const line = scroll.getBoundingClientRect().top + 24;
    let index = 0;
    items.forEach((item, i) => {
      const el = document.getElementById(item.target);
      if (el && el.getBoundingClientRect().top <= line) index = i;
    });
    const atBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2;
    return atBottom ? items.length - 1 : index;
  }
  function syncSpy() {
    const controller = subMap[currentPageId];
    if (!controller) return;
    const index = spyTargetIndex(currentPageId);
    if (index < 0 || index === spyIndex) return;
    spyIndex = index;
    controller.setActive(index);
    syncRailHp();
  }
  if (scroll) {
    scroll.addEventListener('scroll', () => {
      if (spyRaf) return;
      spyRaf = requestAnimationFrame(() => { spyRaf = 0; syncSpy(); });
    }, { passive: true });
  }

  function setPage(id, opts = {}) {
    const page = document.getElementById(id);
    if (!page) return;
    const pageChanged = id !== currentPageId;
    const prevPrimary = railEl.querySelector('.set-rail-item.is-active');
    const prevSub = prevPrimary && prevPrimary.nextElementSibling;
    let prevSubSpace = 0;
    let prevSubTop = null;
    if (pageChanged && prevSub && prevSub.classList.contains('set-rail-sub') &&
        prevSub.classList.contains('is-open')) {
      const prevSubStyle = getComputedStyle(prevSub);
      prevSubSpace = prevSub.offsetHeight +
        (parseFloat(prevSubStyle.marginTop) || 0) + (parseFloat(prevSubStyle.marginBottom) || 0);
      prevSubTop = prevSub.getBoundingClientRect().top;
    }
    currentPageId = id;
    railItems.forEach((r) => {
      const on = r.getAttribute('data-target') === id;
      r.classList.toggle('is-active', on);
      if (on) r.setAttribute('aria-current', 'page'); else r.removeAttribute('aria-current');
    });
    pages.forEach((p) => { p.hidden = p.id !== id; });
    Object.keys(subMap).forEach((key) => {
      if (key === id) {
        subMap[key].setActive(0);
        subMap[key].setOpen(true);
      } else {
        subMap[key].setOpen(false);
      }
    });
    scroll.scrollTop = 0;
    spyIndex = -1;
    requestAnimationFrame(syncSpy);

    if (opts.animate !== false) {
      clearTimeout(introTimer);
      layer.classList.remove('is-intro');
      clearTimeout(pageAnimTimer);
      page.classList.remove('is-page-enter');
      void page.offsetWidth;
      page.classList.add('is-page-enter');
      pageAnimTimer = setTimeout(() => page.classList.remove('is-page-enter'), 320);
    }
    const adjust = pageChanged ? { collapseAbove: prevSubSpace, collapseAboveTop: prevSubTop, openingSub: true } : null;
    clearTimeout(railHpSettleT);
    syncRailHp(opts.animate === false, adjust);
    if (opts.animate !== false) {
      railHpSettleT = setTimeout(() => syncRailHp(true), 380);
    }
  }

  railItems.forEach((r) => {
    r.addEventListener('click', () => setPage(r.getAttribute('data-target')));
  });

  const initialRail = railItems.find((r) => r.classList.contains('is-active')) || railItems[0];
  if (initialRail) setPage(initialRail.getAttribute('data-target'), { animate: false });

  let railHpResizeT = 0;
  window.addEventListener('resize', () => {
    clearTimeout(railHpResizeT);
    clearTimeout(railHpSettleT);
    railHpResizeT = setTimeout(() => syncRailHp(true), 120);
  });
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => {
      clearTimeout(railHpSettleT);
      requestAnimationFrame(() => syncRailHp(true));
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-font-style'] });
  }

  /* ── 开屏动画：开关 / 真实启动层（最终版 M7） ─────────────────── */
  function splashOn() {
    if (window.__splashBoot && typeof window.__splashBoot.on === 'function') return window.__splashBoot.on();
    try { return localStorage.getItem('next-splash') !== 'off'; } catch { return true; }
  }
  function writeSplash(on) {
    try { localStorage.setItem((window.__splashBoot && window.__splashBoot.key) || 'next-splash', on ? 'on' : 'off'); } catch { /* 隐私模式 */ }
    setSwitch('setSplash', on);
  }
  function splashHostName() {
    const p = navigator.platform || navigator.userAgent || '';
    if (/win/i.test(p)) return 'Windows';
    if (/mac/i.test(p)) return 'macOS';
    return 'your device';
  }
  function replaySplash() {
    if (window.__bootSplash && typeof window.__bootSplash.start === 'function') window.__bootSplash.start();
  }
  const replay = $('replaySplash');
  if (replay) replay.addEventListener('click', replaySplash);
  setSwitch('setSplash', splashOn());
  const splashMiniHost = $('splashMiniHost');
  if (splashMiniHost) splashMiniHost.textContent = splashHostName();

  /* ── 工厂域转场：只写本机外观偏好（与启动/关闭的 config.json 无关） ── */
  function writeFactoryWipe(on) {
    try { localStorage.setItem(FACTORY_WIPE_KEY, on ? 'on' : 'off'); } catch { /* 隐私模式 */ }
    setSwitch('setFactoryWipe', on);
  }
  function paintFactoryWipe() {
    setSwitch('setFactoryWipe', factoryWipeOn());
  }
  function paintFactoryPreview() {
    const pv = window.__factoryWipe && window.__factoryWipe.preview;
    if (pv && typeof pv.poster === 'function') pv.poster();
  }
  function stopFactoryPreview() {
    const pv = window.__factoryWipe && window.__factoryWipe.preview;
    if (pv && typeof pv.stop === 'function') pv.stop();
  }
  const replayFactory = $('replayFactoryWipe');
  if (replayFactory) {
    replayFactory.addEventListener('click', () => {
      const pv = window.__factoryWipe && window.__factoryWipe.preview;
      if (pv && typeof pv.play === 'function') pv.play();
    });
  }

  /* ── 自定义背景：服务端存储 + 图片裁切 + 视频轮播（旧 IndexedDB 自动迁移）── */
  const DB_NAME = 'estrella-panel-bg';
  const DB_STORE = 'items';
  const BG_ACTIVE_KEY = 'estrella-panel-bg-active';
  const BG_LIMIT = { image: 8 * 1024 * 1024, video: 24 * 1024 * 1024 };
  let dbPromise = null;
  let dbOK = true;
  let customItems = [];
  let cbgBusy = false;
  let customActiveId = null;
  let videoMode = false;
  let videoToken = 0;
  let activeVideoSlot = 0;
  let videoFailures = new Set();
  let cropItem = null;
  let cropOpen = false;
  let cropDrag = null;
  let cropSession = 0;
  let cropApplyBusy = false;
  let cropBase = null;
  let cropImgNat = { w: 0, h: 0 };
  const cropView = { zoom: 1, panX: 0, panY: 0 };
  let cropReturnFocus = null;

  const shaderCanvas = $('shaderBg');
  const customBgEl = $('customBg');
  const cbgImageEl = $('cbgImage');
  const videoSlotEls = [$('cbgVideoA'), $('cbgVideoB')];
  const cbgGrid = $('cbgGrid');
  const cbgStatus = $('cbgStatus');
  const cbgTag = $('cbgTag');
  const cbgCropBtn = $('cbgCropBtn');
  const cbgClearBtn = $('cbgClearBtn');
  const cbgImageInput = $('cbgImageInput');
  const cbgVideoInput = $('cbgVideoInput');
  const cbgAnyInput = $('cbgAnyInput');
  const cbgDrop = $('cbgDrop');
  const cbgFolder = $('cbgFolder');
  const cropEditor = $('cropEditor');
  const cropStage = $('cropStage');
  const cropImgEl = $('cropImg');
  const cropZoomEl = $('cropZoom');
  const cropNameEl = $('cropName');
  const cropApplyBtn = $('cropApply');

  function openBgDb() {
    if (!dbOK) return Promise.reject(new Error('indexedDB unavailable'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { dbOK = false; reject(new Error('indexedDB unavailable')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbOK = false; reject(req.error || new Error('indexedDB open failed')); };
    }).catch((err) => { dbPromise = null; throw err; });
    return dbPromise;
  }
  async function dbDelete(id) {
    const db = await openBgDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('db delete failed'));
    });
  }
  async function dbAll() {
    const db = await openBgDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => reject(req.error || new Error('db read failed'));
    });
  }
  /* 服务端是唯一数据源：页面只拿同源 URL（CSP media-src 'self' 就能播视频）。 */
  function customFromServer(it) {
    if (!it || !it.id) return null;
    return { ...it, src: it.url, displayUrl: it.displayUrl || it.url };
  }
  function syncActive(id) {
    if (!deps.api) return;
    deps.api('/api/backgrounds/active', { method: 'POST', body: { id } })
      .catch((e) => deps.toast(`启用状态没保存：${e.message}`, 'warn'));
  }
  function customById(id) {
    return customItems.find((item) => item.id === id) || null;
  }
  function customActive() {
    if (!customActiveId) return null;
    const item = customById(customActiveId);
    if (!item) customActiveId = null;
    return item;
  }
  function customVideos() { return customItems.filter((item) => item.type === 'video'); }
  function customTypeLabel(type) { return type === 'video' ? '视频' : '图片'; }
  function customBaseName(name) {
    return String(name || '').replace(/\.[^.]+$/, '').trim() || '未命名素材';
  }
  function customFileType(file) {
    const mime = String((file && file.type) || '').toLowerCase();
    if (/^image\/(?:png|jpe?g|webp|gif|avif|bmp)$/.test(mime)) return 'image';
    if (/^video\/(?:mp4|webm)$/.test(mime)) return 'video';
    const ext = String((file && file.name) || '').toLowerCase().split('.').pop();
    if (/^(png|jpe?g|webp|gif|avif|bmp)$/.test(ext)) return 'image';
    if (/^(mp4|webm)$/.test(ext)) return 'video';
    return '';
  }

  (function mountCbgFolder() {
    if (!cbgFolder) return;
    const flapPath = 'M0 25C0 11.1929 11.1929 0 25 0H136.084C143.044 0 149.689 2.90139 154.42 8.00608L178.08 33.5343C182.811 38.639 189.456 41.5404 196.416 41.5404H296C309.807 41.5404 321 52.7333 321 66.5404V216C321 229.807 309.807 241 296 241H25C11.1929 241 0 229.807 0 216V25Z';
    cbgFolder.innerHTML =
      '<div class="cbg-folder-base"></div>'
      + '<div class="cbg-folder-cards">'
      + '<div class="cbg-folder-card fcard-1"></div>'
      + '<div class="cbg-folder-card fcard-2"></div>'
      + '<div class="cbg-folder-card fcard-3"></div>'
      + '</div>'
      + '<div class="cbg-folder-flap-wrap"><div class="cbg-folder-flap">'
      + '<div class="cbg-folder-flap-glass"></div>'
      + `<svg viewBox="0 0 321 241" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="${flapPath}"/></svg>`
      + '</div></div>';
  })();

  function paintCustomSelection() {
    const active = customActive();
    $$('.cbg-item', cbgGrid).forEach((el) => {
      const on = !!(active && el.getAttribute('data-cbg-id') === active.id);
      el.classList.toggle('is-active', on);
      const thumb = el.querySelector('.cbg-thumb');
      if (thumb) thumb.setAttribute('aria-pressed', String(on));
    });
    const isImage = !!(active && active.type === 'image');
    if (cbgCropBtn) cbgCropBtn.disabled = !isImage;
    if (cbgClearBtn) cbgClearBtn.disabled = !active;
    if (cbgTag) {
      cbgTag.textContent = active ? (active.type === 'video' ? '轮播中' : '图片') : '未启用';
      cbgTag.classList.toggle('accent', !!active);
    }
    if (!cbgStatus) return;
    if (active) {
      if (active.type === 'video') {
        const list = customVideos();
        const idx = list.indexOf(active);
        cbgStatus.textContent = `视频轮播 ${idx >= 0 ? idx + 1 : '?'}/${list.length} · ${active.name}`;
      } else {
        cbgStatus.textContent = `图片 · ${active.name}`;
      }
    } else {
      cbgStatus.textContent = customItems.length ? '未启用自定义背景' : '还没有自定义背景';
    }
  }

  function renderCustomGrid() {
    if (!cbgGrid) return;
    cbgGrid.textContent = '';
    customItems.forEach((item) => {
      const wrap = document.createElement('div');
      wrap.className = 'cbg-item';
      wrap.setAttribute('data-cbg-id', item.id);

      const thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'cbg-thumb';
      thumb.setAttribute('data-cbg-id', item.id);
      thumb.setAttribute('aria-label', `${item.type === 'video' ? '播放视频背景：' : '使用图片背景：'}${item.name}`);
      thumb.setAttribute('aria-pressed', 'false');

      if (item.type === 'image') {
        const im = document.createElement('img');
        im.src = item.displayUrl || item.src;
        im.alt = '';
        im.loading = 'lazy';
        im.decoding = 'async';
        thumb.appendChild(im);
      } else {
        const v = document.createElement('video');
        v.muted = true;
        v.setAttribute('muted', '');
        v.setAttribute('playsinline', '');
        v.setAttribute('preload', 'metadata');
        v.setAttribute('aria-hidden', 'true');
        v.tabIndex = -1;
        v.src = item.src;
        v.addEventListener('loadedmetadata', () => {
          try { v.currentTime = Math.min(.1, (v.duration || 1) / 3); } catch { /* 忽略 */ }
        }, { once: true });
        thumb.appendChild(v);
        const play = document.createElement('span');
        play.className = 'cbg-play';
        play.setAttribute('aria-hidden', 'true');
        thumb.appendChild(play);
      }

      const type = document.createElement('span');
      type.className = 'cbg-type';
      type.textContent = customTypeLabel(item.type);
      thumb.appendChild(type);

      const check = document.createElement('span');
      check.className = 'cbg-check';
      check.setAttribute('aria-hidden', 'true');
      check.innerHTML = checkIcon();
      thumb.appendChild(check);

      const meta = document.createElement('div');
      meta.className = 'cbg-meta';
      const name = document.createElement('span');
      name.className = 'cbg-name';
      name.textContent = item.name;
      name.title = `${item.name} · ${customTypeLabel(item.type)}`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'cbg-del';
      del.setAttribute('aria-label', `删除素材：${item.name}`);
      del.title = '删除素材';
      del.innerHTML = '<svg aria-hidden="true"><use href="#si-close"/></svg>';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeCustomItem(item.id);
      });
      meta.appendChild(name);
      meta.appendChild(del);

      wrap.appendChild(thumb);
      wrap.appendChild(meta);
      cbgGrid.appendChild(wrap);
    });
    paintCustomSelection();
  }

  function showCustomImage(item) {
    if (!customBgEl || !cbgImageEl) return;
    customBgEl.classList.remove('is-video');
    customBgEl.classList.add('is-on', 'is-image');
    cbgImageEl.src = item.displayUrl || item.src;
    if (shaderCanvas) shaderCanvas.classList.add('is-custom');
    if (window.ContourBG) window.ContourBG.setSuppressed(true);
  }

  function stopVideoRotation() {
    videoToken++;
    videoMode = false;
    activeVideoSlot = 0;
    videoSlotEls.forEach((v) => {
      if (!v) return;
      v.onended = null;
      v.onerror = null;
      v.pause();
      v.classList.remove('is-active');
      v.removeAttribute('src');
      try { v.load(); } catch { /* 忽略 */ }
    });
  }

  function advanceVideo(currentId) {
    if (!videoMode) return;
    const list = customVideos();
    if (!list.length) { deactivateCustomBg(); return; }
    const idx = list.findIndex((item) => item.id === currentId);
    playVideoItem(list[(idx + 1 + list.length) % list.length]);
  }

  function playVideoItem(item) {
    if (!videoMode || !item) return;
    const list = customVideos();
    if (!list.length) { deactivateCustomBg(); return; }
    if (!list.includes(item)) item = list[0];
    customActiveId = item.id;
    const token = ++videoToken;
    const current = videoSlotEls[activeVideoSlot];
    const next = videoSlotEls[1 - activeVideoSlot];
    if (!next) return;
    next.onended = null;
    next.onerror = null;
    next.classList.remove('is-active');
    try { next.pause(); } catch { /* 忽略 */ }
    next.src = item.src;
    next.loop = false;
    next.muted = true;
    next.setAttribute('muted', '');
    next.setAttribute('playsinline', '');
    try { next.load(); } catch { /* 忽略 */ }
    next.onended = () => {
      if (token !== videoToken || !videoMode) return;
      advanceVideo(item.id);
    };
    next.onerror = () => {
      if (token !== videoToken || !videoMode) return;
      videoFailures.add(item.id);
      if (videoFailures.size >= customVideos().length) {
        deps.toast('这些视频都无法播放，已取消自定义背景。', 'bad');
        deactivateCustomBg();
        return;
      }
      deps.toast('有一段视频无法播放，已试着切到下一段。', 'warn');
      setTimeout(() => { if (token === videoToken && videoMode) advanceVideo(item.id); }, 280);
    };

    let activated = false;
    const activate = () => {
      if (token !== videoToken || activated) return;
      activated = true;
      videoFailures.delete(item.id);
      next.classList.add('is-active');
      if (current && current !== next) {
        current.classList.remove('is-active');
        setTimeout(() => {
          if (!current.classList.contains('is-active')) { try { current.pause(); } catch { /* 忽略 */ } }
        }, 850);
      }
      activeVideoSlot = 1 - activeVideoSlot;
      paintCustomSelection();
    };
    next.addEventListener('playing', activate, { once: true });
    paintCustomSelection();
    const playPromise = next.play();
    if (playPromise && playPromise.catch) {
      playPromise.catch(() => {
        if (token !== videoToken || activated) return;
        activate();
        deps.toast('浏览器拦截了自动播放，可再点一下视频素材。', 'warn');
      });
    }
  }

  function startVideoRotation(startItem) {
    const list = customVideos();
    if (!list.length) { deactivateCustomBg(); return; }
    videoFailures = new Set();
    videoMode = true;
    if (customBgEl) {
      customBgEl.classList.remove('is-image');
      customBgEl.classList.add('is-on', 'is-video');
    }
    if (shaderCanvas) shaderCanvas.classList.add('is-custom');
    if (window.ContourBG) window.ContourBG.setSuppressed(true);
    const first = startItem && list.includes(startItem) ? startItem : list[0];
    const gate = window.__bootGate;
    if (gate && gate.on && !gate.done && typeof gate.whenDone === 'function') {
      gate.whenDone(function () { if (videoMode) playVideoItem(first); });
      return;
    }
    playVideoItem(first);
  }

  function pauseCustomVideoForSettings() {
    if (!videoMode) return;
    videoSlotEls.forEach((v) => {
      if (v && !v.paused) { try { v.pause(); } catch { /* 忽略 */ } }
    });
  }

  function resumeCustomVideoForSettings() {
    if (!videoMode) return;
    const v = videoSlotEls[activeVideoSlot];
    if (!v || !v.classList.contains('is-active') || !v.paused) return;
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  }

  function activateCustom(id, persist = true) {
    const item = customById(id);
    if (!item) return;
    if (cropOpen && (!cropItem || cropItem.id !== item.id)) closeCropEditor();
    customActiveId = id;
    if (persist) syncActive(id);
    if (item.type === 'image') {
      stopVideoRotation();
      showCustomImage(item);
    } else {
      startVideoRotation(item);
    }
    paintCustomSelection();
    paintBgSelection();
    paintChip();
  }

  function deactivateCustomBg(repaint = true, persist = true) {
    stopVideoRotation();
    customActiveId = null;
    if (persist) syncActive(null);
    if (cropOpen) closeCropEditor();
    if (customBgEl) customBgEl.classList.remove('is-on', 'is-image', 'is-video');
    if (shaderCanvas) shaderCanvas.classList.remove('is-custom');
    if (window.ContourBG) window.ContourBG.setSuppressed(false);
    if (repaint) {
      paintCustomSelection();
      paintBgSelection();
      paintChip();
    } else {
      paintCustomSelection();
    }
  }

  function setCbgBusy(on) {
    cbgBusy = !!on;
    [cbgImageInput, cbgVideoInput, cbgAnyInput].forEach((el) => { if (el) el.disabled = cbgBusy; });
    if (cbgStatus && cbgBusy) cbgStatus.textContent = '正在保存素材…';
  }

  async function addCustomFiles(files, type) {
    if (cbgBusy) {
      deps.toast('上一批素材还在保存，请稍等。', 'warn');
      return;
    }
    const list = Array.from(files || []);
    if (!list.length) return;
    const added = [];
    const counts = { image: 0, video: 0 };
    const failed = [];
    setCbgBusy(true);
    try {
      for (const file of list) {
        if (!file) continue;
        const fileType = customFileType(file);
        if (!fileType) continue;
        if (type === 'image' && fileType !== 'image') continue;
        if (type === 'video' && fileType !== 'video') continue;
        if (file.size > BG_LIMIT[fileType]) {
          deps.toast(`${fileType === 'video' ? '视频' : '图片'}超过 ${Math.round(BG_LIMIT[fileType] / 1024 / 1024)} MB，已跳过「${customBaseName(file.name)}」。`, 'warn');
          continue;
        }
        try {
          const q = new URLSearchParams({
            slot: 'original',
            type: fileType,
            name: customBaseName(file.name),
          });
          const r = await deps.api(`/api/backgrounds?${q.toString()}`, {
            method: 'POST', body: file, timeout: 180000,
          });
          if (!r || !r.ok || !r.item) throw new Error((r && r.error) || '保存失败');
          const item = customFromServer(r.item);
          if (!item) throw new Error('服务端返回的素材不完整');
          if (!customById(item.id)) customItems.push(item);
          added.push(item);
          counts[fileType]++;
        } catch (e) {
          failed.push(`${customBaseName(file.name)}（${e.message}）`);
        }
      }
    } finally {
      setCbgBusy(false);
    }
    if (!added.length) {
      if (failed.length) deps.toast(`没有保存成功：${failed.slice(0, 2).join('、')}`, 'bad');
      else if (type === 'image') deps.toast('没有识别到可用的图片文件（JPG/PNG/WEBP/GIF/AVIF/BMP）。', 'warn');
      else if (type === 'video') deps.toast('没有识别到可用的视频文件（MP4/WEBM）。', 'warn');
      else deps.toast('只支持图片或视频文件。', 'warn');
      paintCustomSelection();
      return;
    }
    renderCustomGrid();
    if (!customActive()) activateCustom(added[0].id);
    else {
      paintCustomSelection();
      paintBgSelection();
      paintChip();
    }
    const parts = [];
    if (counts.image) parts.push(`${counts.image} 张图片`);
    if (counts.video) parts.push(`${counts.video} 段视频`);
    deps.toast(`已添加 ${parts.join('、')}。`, 'ok');
    if (failed.length) deps.toast(`${failed.length} 个文件没保存：${failed.slice(0, 2).join('、')}`, 'warn');
  }

  async function removeCustomItem(id) {
    const item = customById(id);
    if (!item) return;
    try {
      await deps.api('/api/backgrounds/delete', { method: 'POST', body: { id } });
    } catch (e) {
      deps.toast(`删除失败：${e.message}`, 'bad');
      return;
    }
    const idx = customItems.indexOf(item);
    if (idx < 0) return;
    const wasActive = customActiveId === id;
    const wasVideoMode = videoMode;
    if (cropItem && cropItem.id === id) closeCropEditor();
    if (wasActive && wasVideoMode) stopVideoRotation();
    customItems.splice(idx, 1);
    if (wasActive) customActiveId = null;

    if (wasActive) {
      if (wasVideoMode) {
        const vidsLeft = customVideos();
        customActiveId = null;
        renderCustomGrid();
        if (vidsLeft.length) {
          startVideoRotation(vidsLeft[0]);
          // 轮播过程中的切换不写 active（否则每段视频一次 POST）；但删除当前项后
          // 选中的下一段是用户动作的结果，要落盘，否则刷新后会回到"未启用"。
          syncActive(customActiveId);
        } else if (customItems.length) activateCustom(customItems[Math.min(idx, customItems.length - 1)].id);
        else deactivateCustomBg();
      } else if (customItems.length) {
        const nextItem = customItems[Math.min(idx, customItems.length - 1)];
        customActiveId = null;
        renderCustomGrid();
        activateCustom(nextItem.id);
      } else {
        renderCustomGrid();
        deactivateCustomBg();
      }
    } else {
      renderCustomGrid();
      paintCustomSelection();
      paintBgSelection();
      paintChip();
    }
    deps.toast('已移除素材。', 'ok');
  }

  if (cbgImageInput) cbgImageInput.addEventListener('change', () => {
    void addCustomFiles(cbgImageInput.files, 'image');
    cbgImageInput.value = '';
    closeCbgFolderSoon();
  });
  if (cbgVideoInput) cbgVideoInput.addEventListener('change', () => {
    void addCustomFiles(cbgVideoInput.files, 'video');
    cbgVideoInput.value = '';
    closeCbgFolderSoon();
  });
  if (cbgAnyInput) cbgAnyInput.addEventListener('change', () => {
    void addCustomFiles(cbgAnyInput.files, 'auto');
    cbgAnyInput.value = '';
    closeCbgFolderSoon();
  });
  const addImagesBtn = $('cbgAddImages');
  if (addImagesBtn) addImagesBtn.addEventListener('click', () => cbgImageInput && cbgImageInput.click());
  const addVideosBtn = $('cbgAddVideos');
  if (addVideosBtn) addVideosBtn.addEventListener('click', () => cbgVideoInput && cbgVideoInput.click());

  let cbgDragDepth = 0;
  let cbgFolderPinUntil = 0;
  let cbgCloseTimer = 0;
  let cbgDropBeatUntil = 0;
  function isFileDrag(e) {
    const types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, 'Files') >= 0;
  }
  function setCbgDropActive(on) {
    if (!cbgDrop) return;
    cbgDrop.classList.toggle('is-dragover', on);
    cbgDrop.classList.toggle('is-open', on);
  }
  function openCbgPicker() {
    if (!cbgDrop || !cbgAnyInput) return;
    cbgFolderPinUntil = performance.now() + 1800;
    clearTimeout(cbgCloseTimer);
    cbgDrop.classList.add('is-open');
    cbgCloseTimer = setTimeout(() => {
      if (!cbgDrop.matches(':hover')) cbgDrop.classList.remove('is-open');
    }, 1800);
    cbgAnyInput.click();
  }
  function closeCbgFolderSoon() {
    clearTimeout(cbgCloseTimer);
    cbgCloseTimer = setTimeout(() => {
      if (!cbgDrop) return;
      setCbgDropActive(false);
      if (!cbgDrop.matches(':hover')) cbgDrop.classList.remove('is-hover');
    }, 520);
  }
  if (cbgDrop) {
    cbgDrop.addEventListener('pointerenter', (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      cbgDrop.classList.add('is-hover');
    });
    cbgDrop.addEventListener('pointerleave', () => {
      cbgDrop.classList.remove('is-hover');
      if (!cbgDragDepth && performance.now() > cbgFolderPinUntil) cbgDrop.classList.remove('is-open');
    });
    cbgDrop.addEventListener('dragenter', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      cbgDragDepth++;
      cbgFolderPinUntil = 0;
      clearTimeout(cbgCloseTimer);
      setCbgDropActive(true);
    });
    cbgDrop.addEventListener('dragover', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setCbgDropActive(true);
    });
    cbgDrop.addEventListener('dragleave', () => {
      cbgDragDepth = Math.max(0, cbgDragDepth - 1);
      if (!cbgDragDepth && performance.now() > cbgDropBeatUntil) setCbgDropActive(false);
    });
    cbgDrop.addEventListener('drop', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      cbgDragDepth = 0;
      cbgDropBeatUntil = performance.now() + 700;
      void addCustomFiles(e.dataTransfer.files, 'auto');
      closeCbgFolderSoon();
    });
    cbgDrop.addEventListener('click', openCbgPicker);
    cbgDrop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openCbgPicker();
      }
    });
  }
  document.addEventListener('dragend', () => {
    cbgDragDepth = 0;
    if (performance.now() > cbgDropBeatUntil) setCbgDropActive(false);
  });
  document.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (cbgDrop && !cbgDrop.contains(e.target)) {
      cbgDragDepth = 0;
      if (performance.now() > cbgDropBeatUntil) setCbgDropActive(false);
    }
  });
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget) return;
    cbgDragDepth = 0;
    if (performance.now() > cbgDropBeatUntil) setCbgDropActive(false);
  });
  document.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (isOpen && cbgDrop && !cbgDrop.contains(e.target)) {
      deps.toast('把文件拖到自定义背景的 16:9 区域里。', 'warn');
    }
  });
  if (cbgGrid) {
    cbgGrid.addEventListener('click', (e) => {
      const thumb = e.target.closest('.cbg-thumb');
      if (!thumb) return;
      activateCustom(thumb.getAttribute('data-cbg-id'));
    });
  }
  if (cbgCropBtn) {
    cbgCropBtn.addEventListener('click', () => {
      const active = customActive();
      if (active && active.type === 'image') openCropEditor(active);
    });
  }
  if (cbgClearBtn) {
    cbgClearBtn.addEventListener('click', () => {
      deactivateCustomBg();
      deps.toast('已取消自定义背景。', 'ok');
    });
  }

  /* 静态图裁切 */
  function layoutCrop(restore) {
    if (!cropOpen || !cropItem || !cropImgNat.w || !cropImgNat.h) return;
    if (!cropStage) return;
    const sw = cropStage.clientWidth;
    const sh = cropStage.clientHeight;
    if (!sw || !sh) return;
    const scale = Math.max(sw / cropImgNat.w, sh / cropImgNat.h);
    const baseW = cropImgNat.w * scale;
    const baseH = cropImgNat.h * scale;
    if (restore) {
      const c = cropItem.crop;
      cropView.zoom = c && isFinite(c.zoom) ? Math.max(1, Math.min(2.6, c.zoom)) : 1;
      cropView.panX = c ? (c.x || 0) * sw : 0;
      cropView.panY = c ? (c.y || 0) * sh : 0;
    }
    const maxX = Math.max(0, (baseW * cropView.zoom - sw) / 2);
    const maxY = Math.max(0, (baseH * cropView.zoom - sh) / 2);
    cropView.panX = Math.max(-maxX, Math.min(maxX, cropView.panX));
    cropView.panY = Math.max(-maxY, Math.min(maxY, cropView.panY));
    cropBase = { baseW, baseH, sw, sh };
    cropImgEl.style.width = `${baseW}px`;
    cropImgEl.style.height = `${baseH}px`;
    cropImgEl.style.transform = `translate(-50%, -50%) translate(${cropView.panX}px, ${cropView.panY}px) scale(${cropView.zoom})`;
    if (cropZoomEl) cropZoomEl.value = String(cropView.zoom);
  }

  function setCropZoom(value) {
    if (!cropOpen) return;
    cropView.zoom = Math.max(1, Math.min(2.6, value));
    layoutCrop(false);
  }

  function openCropEditor(item) {
    if (!item || item.type !== 'image' || customActiveId !== item.id) return;
    if (cropOpen && cropItem && cropItem.id === item.id) { closeCropEditor(); return; }
    if (cropOpen) closeCropEditor();
    cropItem = item;
    cropOpen = true;
    cropReturnFocus = document.activeElement;
    cropEditor.hidden = false;
    cropNameEl.textContent = item.name;
    cropView.zoom = 1;
    cropView.panX = 0;
    cropView.panY = 0;
    cropZoomEl.value = '1';
    cropApplyBusy = false;
    cropApplyBtn.disabled = false;
    cropApplyBtn.textContent = '应用裁切';
    const token = ++cropSession;
    let didLoad = false;
    const loaded = () => {
      if (didLoad || !cropOpen || token !== cropSession || !cropItem) return;
      didLoad = true;
      cropImgEl.onload = null;
      cropImgNat = { w: cropImgEl.naturalWidth, h: cropImgEl.naturalHeight };
      if (!cropImgNat.w || !cropImgNat.h) { deps.toast('图片读取失败，请换一张。', 'warn'); return; }
      layoutCrop(true);
      setTimeout(() => {
        if (cropOpen && token === cropSession) {
          try { cropEditor.scrollIntoView({ block: 'nearest', behavior: reduceMQ.matches ? 'auto' : 'smooth' }); } catch { /* 忽略 */ }
          try { cropZoomEl.focus({ preventScroll: true }); } catch { /* 忽略 */ }
        }
      }, 40);
    };
    cropImgEl.onload = loaded;
    cropImgEl.onerror = () => deps.toast('图片读取失败，请换一张。', 'warn');
    // 裁切永远从原图开始；displayUrl 是上一次裁切的结果，拿它再裁会逐次损失像素。
    cropImgEl.src = item.src;
    if (cropImgEl.complete && cropImgEl.naturalWidth) loaded();
  }

  function closeCropEditor() {
    if (!cropOpen) return;
    cropOpen = false;
    cropSession++;
    cropItem = null;
    cropDrag = null;
    cropBase = null;
    cropApplyBusy = false;
    cropApplyBtn.disabled = false;
    cropApplyBtn.textContent = '应用裁切';
    cropEditor.hidden = true;
    cropStage.classList.remove('is-dragging');
    cropImgEl.onload = null;
    cropImgEl.onerror = null;
    cropImgEl.removeAttribute('src');
    if (cropReturnFocus && document.contains(cropReturnFocus)) {
      try { cropReturnFocus.focus({ preventScroll: true }); } catch { /* 忽略 */ }
    }
    cropReturnFocus = null;
  }

  if (cropZoomEl) cropZoomEl.addEventListener('input', () => setCropZoom(parseFloat(cropZoomEl.value)));
  const cropReset = $('cropReset');
  if (cropReset) cropReset.addEventListener('click', () => {
    if (!cropOpen) return;
    cropView.zoom = 1;
    cropView.panX = 0;
    cropView.panY = 0;
    layoutCrop(false);
  });
  const cropCancel = $('cropCancel');
  if (cropCancel) cropCancel.addEventListener('click', closeCropEditor);

  if (cropStage) {
    cropStage.addEventListener('pointerdown', (e) => {
      if (!cropOpen || e.button !== 0) return;
      cropDrag = { x: e.clientX, y: e.clientY, panX: cropView.panX, panY: cropView.panY, id: e.pointerId };
      cropStage.classList.add('is-dragging');
      try { cropStage.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      e.preventDefault();
    });
    cropStage.addEventListener('pointermove', (e) => {
      if (!cropDrag) return;
      cropView.panX = cropDrag.panX + (e.clientX - cropDrag.x);
      cropView.panY = cropDrag.panY + (e.clientY - cropDrag.y);
      layoutCrop(false);
    });
    const endCropDrag = (e) => {
      if (!cropDrag) return;
      cropDrag = null;
      cropStage.classList.remove('is-dragging');
      try { cropStage.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
    };
    cropStage.addEventListener('pointerup', endCropDrag);
    cropStage.addEventListener('pointercancel', endCropDrag);
    cropStage.addEventListener('wheel', (e) => {
      if (!cropOpen) return;
      e.preventDefault();
      setCropZoom(cropView.zoom * (e.deltaY < 0 ? 1.08 : .925));
    }, { passive: false });
  }

  if (cropApplyBtn) {
    cropApplyBtn.addEventListener('click', () => {
      if (!cropOpen || !cropItem || !cropBase || cropApplyBusy) return;
      const item = cropItem;
      const session = cropSession;
      const base = cropBase;
      const appliedZoom = cropView.zoom;
      const appliedPanX = cropView.panX;
      const appliedPanY = cropView.panY;
      const totalScale = (base.baseW / cropImgNat.w) * appliedZoom;
      const dispW = cropImgNat.w * totalScale;
      const dispH = cropImgNat.h * totalScale;
      const left = (base.sw - dispW) / 2 + appliedPanX;
      const top = (base.sh - dispH) / 2 + appliedPanY;
      let sx = -left / totalScale;
      let sy = -top / totalScale;
      const swSrc = base.sw / totalScale;
      const shSrc = base.sh / totalScale;
      sx = Math.max(0, Math.min(cropImgNat.w - swSrc, sx));
      sy = Math.max(0, Math.min(cropImgNat.h - shSrc, sy));

      cropApplyBusy = true;
      cropApplyBtn.disabled = true;
      cropApplyBtn.textContent = '裁切中…';

      const canvas = document.createElement('canvas');
      canvas.width = 1600;
      canvas.height = 900;
      const cctx = canvas.getContext('2d');
      cctx.fillStyle = '#0b1226';
      cctx.fillRect(0, 0, 1600, 900);
      cctx.drawImage(cropImgEl, sx, sy, swSrc, shSrc, 0, 0, 1600, 900);

      canvas.toBlob(async (blob) => {
        if (session !== cropSession) return;
        if (!blob || !customItems.includes(item)) {
          cropApplyBusy = false;
          cropApplyBtn.disabled = false;
          cropApplyBtn.textContent = '应用裁切';
          deps.toast('裁切没有保存，请重试。', 'bad');
          return;
        }
        try {
          const crop = {
            zoom: appliedZoom,
            x: base.sw ? appliedPanX / base.sw : 0,
            y: base.sh ? appliedPanY / base.sh : 0,
          };
          const q = new URLSearchParams({
            slot: 'display',
            id: item.id,
            zoom: String(crop.zoom),
            x: String(crop.x),
            y: String(crop.y),
          });
          const r = await deps.api(`/api/backgrounds?${q.toString()}`, {
            method: 'POST', body: blob, timeout: 60000,
          });
          if (!r || !r.ok || !r.item) throw new Error((r && r.error) || '保存失败');
          const next = customFromServer(r.item);
          const at = customItems.findIndex((x) => x.id === item.id);
          if (at >= 0 && next) customItems[at] = next;
          closeCropEditor();
          renderCustomGrid();
          if (next && customActiveId === next.id) showCustomImage(next);
          paintCustomSelection();
          paintBgSelection();
          paintChip();
          deps.toast('画面已更新。', 'ok');
        } catch (e) {
          deps.toast(`裁切没保存：${e.message}`, 'bad');
        } finally {
          cropApplyBusy = false;
          cropApplyBtn.disabled = false;
          cropApplyBtn.textContent = '应用裁切';
        }
      }, 'image/jpeg', .92);
    });
  }

  async function waitBgOnline(ms = 6000) {
    for (let t = 0; t < ms; t += 120) {
      const st = deps.getState ? deps.getState() : null;
      if (st && st.online) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  }

  async function migrateLegacyBackgrounds() {
    let rows = [];
    try {
      rows = await dbAll();
    } catch {
      return { migrated: new Map(), skipped: [], failed: [] };
    }
    const migrated = new Map();
    const skipped = [];
    const failed = [];
    rows.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    for (const rec of rows) {
      if (!rec || !rec.id || !rec.blob) continue;
      const type = rec.type === 'video' ? 'video' : 'image';
      try {
        const q = new URLSearchParams({
          slot: 'original',
          type,
          name: rec.name || '旧素材',
          sourceKey: String(rec.id),
        });
        const r = await deps.api(`/api/backgrounds?${q.toString()}`, {
          method: 'POST', body: rec.blob, timeout: 180000,
        });
        if (!r || !r.ok || !r.item) throw new Error((r && r.error) || '上传失败');
        let item = customFromServer(r.item);
        if (!item) throw new Error('服务端返回的素材不完整');
        if (rec.displayBlob && type === 'image') {
          const c = rec.crop || {};
          const dq = new URLSearchParams({
            slot: 'display',
            id: item.id,
            zoom: String(c.zoom == null ? 1 : c.zoom),
            x: String(c.x == null ? 0 : c.x),
            y: String(c.y == null ? 0 : c.y),
          });
          const dr = await deps.api(`/api/backgrounds?${dq.toString()}`, {
            method: 'POST', body: rec.displayBlob, timeout: 60000,
          });
          if (!dr || !dr.ok || !dr.item) throw new Error((dr && dr.error) || '裁切图上传失败');
          item = customFromServer(dr.item) || item;
        }
        if (!customById(item.id)) customItems.push(item);
        migrated.set(String(rec.id), item.id);
        // 原图与裁切图都成功了，才删浏览器副本；失败的行下次打开会重试（sourceKey 幂等）。
        try { await dbDelete(rec.id); } catch { /* 浏览器存储不可写时忽略 */ }
      } catch (e) {
        const msg = String((e && e.message) || '');
        if (/415|只支持|不支持|格式/.test(msg)) skipped.push(rec.name || rec.id);
        else failed.push(`${rec.name || rec.id}（${msg}）`);
      }
    }
    if (migrated.size) {
      renderCustomGrid();
      deps.toast(`已把 ${migrated.size} 个旧背景搬到本机数据目录。`, 'ok');
    }
    if (skipped.length) {
      deps.toast(`有 ${skipped.length} 个旧素材格式不再支持，仍留在浏览器里：${skipped.slice(0, 3).join('、')}`, 'warn');
    }
    if (failed.length) {
      deps.toast(`有 ${failed.length} 个旧素材没搬成功，下次打开会重试：${failed.slice(0, 2).join('、')}`, 'warn');
    }
    return { migrated, skipped, failed };
  }

  async function restoreCustomBackground() {
    let serverOk = false;
    let serverActive = null;
    try {
      const r = await deps.api('/api/backgrounds');
      if (r && r.ok) {
        serverOk = true;
        customItems = (Array.isArray(r.items) ? r.items : []).map(customFromServer).filter(Boolean);
        serverActive = r.activeId || null;
      }
    } catch (e) {
      deps.toast(`读不到自定义背景：${e.message}`, 'warn');
    }
    if (!serverOk) {
      renderCustomGrid();
      deactivateCustomBg(false, false);
      return;
    }
    renderCustomGrid();
    /* 自定义背景要在格栅揭幕前就位：先把服务端 active 项应用上；视频播放由
       startVideoRotation 自己等开屏结束。 */
    if (serverActive && customById(serverActive)) activateCustom(serverActive, false);
    // 页面初始化时 S.online 还是 false（refresh 还没回来），api() 会拒绝 POST。
    // 迁移必须等在线态，否则会把「未连接后端」误判成上传失败并留下 IDB 行。
    const online = await waitBgOnline();
    if (!online) {
      if (!(serverActive && customById(serverActive))) deactivateCustomBg(false, false);
      return;
    }
    /* IDB→服务端迁移会读库 + 上传，等开屏整层隐藏后再做。 */
    const gate = window.__bootGate;
    if (gate && gate.on && !gate.done && typeof gate.whenDone === 'function') {
      await new Promise((resolve) => gate.whenDone(resolve));
    }
    let legacyActive = '';
    try { legacyActive = localStorage.getItem(BG_ACTIVE_KEY) || ''; } catch { /* 隐私模式 */ }
    const mig = await migrateLegacyBackgrounds();
    const mappedLegacy = legacyActive ? mig.migrated.get(legacyActive) : null;
    const activeId = serverActive && customById(serverActive)
      ? serverActive
      : (mappedLegacy && customById(mappedLegacy) ? mappedLegacy : null);
    if (activeId) {
      if (activeId !== customActiveId) activateCustom(activeId, !!mappedLegacy && !serverActive);
    } else {
      deactivateCustomBg(false, false);
    }
    if (!mig.failed.length) {
      try { localStorage.removeItem(BG_ACTIVE_KEY); } catch { /* 隐私模式 */ }
    }
  }
  void restoreCustomBackground();

  /* ── 面板点阵背景（DSH Elastic Dot Grid）──────────────────────────── */
  (function mountPanelDots() {
    const canvas = $('panelDots');
    if (!canvas || !panel) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const SPACING = 24;
    const BASE_R = 0.6;
    const HOVER_R = 2.0;
    const INFLUENCE = 130;
    const BASE_A = 0.38;
    const HOVER_A = 0.95;
    const MAGNET = 0.30;
    const STIFF = 0.265;
    const DAMP = 0.54 + 0.74 * 0.24;
    const STEP = 1 / 60;
    const MAX_PULL = Math.min(MAGNET, 0.92);
    let dots = [];
    let live = [];
    const rest = document.createElement('canvas');
    const restCtx = rest.getContext('2d');
    if (!restCtx) return;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let cols = 0;
    let rows = 0;
    let x0 = 0;
    let y0 = 0;
    const mouse = { x: 0, y: 0, active: false };
    let moved = false;
    let busy = false;
    let running = false;
    let raf = 0;
    let last = 0;
    let acc = 0;
    let pendingPointer = null;

    function makeDot(ox, oy) {
      return { ox, oy, x: ox, y: oy, vx: 0, vy: 0, r: BASE_R, a: BASE_A, rv: 0, av: 0 };
    }
    function build() {
      cols = Math.max(2, Math.ceil(width / SPACING) + 1);
      rows = Math.max(2, Math.ceil(height / SPACING) + 1);
      x0 = (width - (cols - 1) * SPACING) / 2;
      y0 = (height - (rows - 1) * SPACING) / 2;
      dots = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) dots.push(makeDot(x0 + c * SPACING, y0 + r * SPACING));
      }
    }
    function dotColor() {
      return document.documentElement.dataset.theme === 'dark'
        ? '226, 235, 248' : '49, 68, 108';
    }
    function paintRest() {
      if (!width || !height) return;
      restCtx.setTransform(1, 0, 0, 1, 0, 0);
      restCtx.clearRect(0, 0, rest.width, rest.height);
      restCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      restCtx.fillStyle = `rgb(${dotColor()})`;
      restCtx.globalAlpha = BASE_A;
      dots.forEach((d) => {
        restCtx.beginPath();
        restCtx.arc(d.ox, d.oy, BASE_R, 0, Math.PI * 2);
        restCtx.fill();
      });
      restCtx.globalAlpha = 1;
    }
    function draw() {
      if (!width || !height) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(rest, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!live.length) return;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      live.forEach((d) => {
        ctx.beginPath();
        ctx.arc(d.ox, d.oy, BASE_R + 2.2, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
      ctx.fillStyle = `rgb(${dotColor()})`;
      live.forEach((q) => {
        const a = Math.max(0, Math.min(1, q.a));
        if (a <= 0.004) return;
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(q.x, q.y, Math.max(q.r, 0.1), 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    }
    function drawStatic() {
      dots.forEach((d) => {
        d.x = d.ox; d.y = d.oy; d.vx = d.vy = 0;
        d.r = BASE_R; d.a = BASE_A; d.rv = d.av = 0;
      });
      live = [];
      busy = false;
      moved = false;
      draw();
    }
    function stop() {
      if (!running) return;
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
    function reset() {
      stop();
      mouse.active = false;
      drawStatic();
    }
    function resize() {
      const w = panel.clientWidth;
      const h = panel.clientHeight;
      if (!w || !h) return;
      width = w;
      height = h;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      rest.width = canvas.width;
      rest.height = canvas.height;
      build();
      paintRest();
      drawStatic();
    }
    function stepAll() {
      const active = mouse.active && !reduceMQ.matches;
      let nextBusy = false;
      const nextLive = [];
      dots.forEach((d) => {
        const dx = d.ox - mouse.x;
        const dy = d.oy - mouse.y;
        const dist2 = dx * dx + dy * dy;
        let t = 0;
        if (active && dist2 < INFLUENCE * INFLUENCE) t = 1 - Math.sqrt(dist2) / INFLUENCE;
        const kSize = t * t * (3 - 2 * t);
        const pull = MAX_PULL * t * t;
        const tx = d.ox + (mouse.x - d.ox) * pull;
        const ty = d.oy + (mouse.y - d.oy) * pull;
        const tr = BASE_R + (HOVER_R - BASE_R) * kSize;
        const ta = BASE_A + (HOVER_A - BASE_A) * kSize;
        d.vx = (d.vx + (tx - d.x) * STIFF) * DAMP; d.x += d.vx;
        d.vy = (d.vy + (ty - d.y) * STIFF) * DAMP; d.y += d.vy;
        d.rv = (d.rv + (tr - d.r) * STIFF) * DAMP; d.r += d.rv;
        d.av = (d.av + (ta - d.a) * STIFF) * DAMP; d.a += d.av;
        const off = Math.abs(d.x - d.ox) + Math.abs(d.y - d.oy);
        if (off > 0.05 || d.r > BASE_R + 0.03 || d.a > BASE_A + 0.002) nextLive.push(d);
        if (off > 0.05 || Math.abs(d.rv) > 0.0015 || Math.abs(d.av) > 0.0008) nextBusy = true;
      });
      live = nextLive;
      busy = nextBusy;
      moved = false;
    }
    function tick(now) {
      if (!running) return;
      if (pendingPointer) {
        const r = panel.getBoundingClientRect();
        mouse.x = pendingPointer.x - r.left;
        mouse.y = pendingPointer.y - r.top;
        pendingPointer = null;
      }
      const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
      last = now;
      acc += dt;
      let steps = 0;
      while (acc >= STEP && steps < 5) {
        stepAll();
        acc -= STEP;
        steps++;
      }
      if (steps >= 5) acc = 0;
      draw();
      if (!busy && !moved) {
        running = false;
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(tick);
    }
    function wake() {
      if (running || reduceMQ.matches || !width || !height) return;
      running = true;
      last = 0;
      acc = 0;
      raf = requestAnimationFrame(tick);
    }
    function onMove(e) {
      if (reduceMQ.matches) return;
      if (e.pointerType && e.pointerType !== 'mouse') return;
      pendingPointer = { x: e.clientX, y: e.clientY };
      mouse.active = true;
      moved = true;
      wake();
    }
    function onLeave() {
      pendingPointer = null;
      mouse.active = false;
      moved = true;
      wake();
    }
    panel.addEventListener('pointermove', onMove, { passive: true });
    panel.addEventListener('pointerleave', onLeave, { passive: true });
    let resizeT = 0;
    function scheduleResize() {
      clearTimeout(resizeT);
      resizeT = setTimeout(resize, 90);
    }
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => scheduleResize()).observe(panel);
    } else {
      window.addEventListener('resize', scheduleResize, { passive: true });
    }
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(() => {
        paintRest();
        if (!running) draw();
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      new MutationObserver(() => {
        if (layer.dataset.open === 'false') reset();
      }).observe(layer, { attributes: true, attributeFilter: ['data-open'] });
    }
    if (reduceMQ.addEventListener) {
      reduceMQ.addEventListener('change', () => {
        if (reduceMQ.matches) reset();
        else draw();
      });
    }
    resize();
  })();

  /* ── 汇总绘制 ─────────────────────────────────────────────────────── */
  withShader(paintBackground);
  function paintAll() {
    paintTheme();
    paintAccents();
    paintFont();
    paintChip();
    paintBackground();
    paintLaunch();
    paintAbout();
    paintFactoryWipe();
  }

  paintAll();
  void loadScopes(false);
}
