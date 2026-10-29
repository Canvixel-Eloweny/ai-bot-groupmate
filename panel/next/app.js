/**
 * ══════════════════════════════════════════════════════════════════════════
 *  Estrella Bot Console v2 · 渲染器 / 路由 / 反馈
 * ══════════════════════════════════════════════════════════════════════════
 *  这一层**不认识任何业务**：它把 `schema.js` 描述的东西画出来，把用户的动作
 *  按控件自己声明的 `save()` / `bind` 送出去。想知道"有哪些功能"，看 schema.js；
 *  想知道"某个类型怎么画"，看下面的 RENDER 表。
 *
 *  三条不变量（破了就会出"点了没反应"这种最难查的故障）：
 *   ① **schema 里出现的每个 `t` 必须在 RENDER 表里**。缺了当场画红框，不静默跳过。
 *   ② **页面切换只重建 #page 与导航的 aria 状态**，不重建 body / 不碰顶栏。
 *   ③ **草稿只在显式保存时提交**；切页不丢草稿（草稿按路径存，不按页面存）。
 */

import { GROUPS, CTRL_KINDS, $, brainPickOf } from './schema.js';
import { DEMO } from './demo-state.js';
import { initSettings, factoryWipeOn } from './settings.js';
// `href` 的协议白名单（第 10 轮 · 开源前审查 H-01）。⚠️ 与 `esc` 是**两件事**：
// esc 防"跳出属性"，它防"协议可执行"。`javascript:` 一个待转义字符都不含，
// 只靠 esc 挡不住。行为判据在 smoke（那个模块是零依赖叶子，能直接 import）。
import { safeHref } from './url-safe.js';

const { j, fmtDur, fmtNum, capsOf } = $;

/* ════════════════════════════════════════════════ 1. 全局状态 ═══ */
const S = {
  state: null,
  online: false,          // 是否真连上后端（决定"写"能不能成功）
  gi: 0, si: 0,
  draft: { custom: {}, sys: {} },   // 工作副本：也存"列表类字段的快照"，供增删改用
  dirty: new Set(),       // **真正被用户动过的路径**（c:custom 路径 / s:顶层字段）
  volatile: {},           // 不落盘的本地值（导出格式、临时输入框……）
  extra: {},              // 按需拉取：sessions / chats / trace / logs / audit / models / balance / packages / groups / tryOut
  reg: new Map(),         // 当前页面的控件登记表：id → ctrl
  logCursor: 0,
};

/**
 * 更新状态（P3）。刻意放在 S 之外：`refresh()` 每 3 秒整份替换 S.state，
 * 而下载进度比 3 秒密 —— 放进 S 会被轮询打回旧值，进度条会来回跳。
 */
const UPD = { state: null, es: null, lastPhase: '', loaded: false };
/* UI 身份锁（§171）：服务端验签结果 + 本地 DOM 的核心锚点比对。
   只做提示与标记，不阻止任何操作；unknown（旧后端 / 演示模式）不报警。 */
const UI_IDENTITY = { state: 'unknown', reason: '', missing: [], checkedAt: 0, checked: false };
const fmtBytes = (n) => {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
};
/** 离线清单只有 64 KiB 级；分块转 base64，避免大参数展开把调用栈打爆。 */
const bytesToB64 = (bytes) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode(...u8.subarray(i, i + CH));
  return btoa(s);
};

const TOKEN = (document.querySelector('meta[name="panel-token"]')?.content || '').trim();
const HAS_TOKEN = !!TOKEN && TOKEN !== '__QQBOT_PANEL_TOKEN__';
const $id = (x) => document.getElementById(x);
/* 工厂域下标（schema 里没有 factory 域时是 -1）。转场只认这个域的前后跨越。 */
const FACTORY_GI = GROUPS.findIndex((g) => g.id === 'factory');
/* 工厂域导航自动上收：控制器在文件尾部初始化；paintPage 在初始化前调用时直接跳过。 */
let navAutoReady = false;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/**
 * 把 `**粗体**` 变成 `<b>`。
 *
 * 为什么需要它：schema 里的文案是**写给人看的中文散文**，作者会自然地写 Markdown；
 * 而这些文案最终是**直接插进 HTML** 的 —— 不转换就会在页面上留下字面量星号。
 * （实测过：首屏「睡眠那一行是**只读**的」原样显示了两颗星。）
 * 只认 `**…**` 一种，不做完整 Markdown —— 够用，且不会把 `*` 通配符之类的文本吃掉。
 */
const mdBold = (s) => String(s ?? '').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
/** 放进 title 属性时用这个：属性里不能有标签。 */
const plain = (s) => mdBold(s).replace(/<[^>]*>/g, '');
const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
function setPath(o, p, v) {
  const ks = p.split('.');
  let cur = o;
  for (let i = 0; i < ks.length - 1; i += 1) {
    if (cur[ks[i]] == null || typeof cur[ks[i]] !== 'object') cur[ks[i]] = {};
    cur = cur[ks[i]];
  }
  cur[ks[ks.length - 1]] = v;
}
const currentSub = () => GROUPS[S.gi].subs[S.si];

/* ════════════════════════════════════════════════ 2. 反馈层 ═══ */
/* ── 提示卡（2026-10-27 改版）───────────────────────────────────────────
   形态：描边图标 + 标题 + 说明 + 右上角关闭；语义色只走底色 / 描边 / 图标，
   标题与说明用中性文字。确认卡复用同一套外观，按钮在卡内底部。
   ⚠️ 文案一律用 textContent 写入 —— 后端的 msg 可能含任意字符。
   ⚠️ 最多同时留 4 张自动提示；确认卡不受上限与自动关闭影响。 */
const TOAST_ICONS = {
  ok: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="m8.4 12.2 2.5 2.5 4.9-5.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3.6 21 20H3L12 3.6Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 9.2v4.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="16.8" r="1" fill="currentColor"/></svg>',
  bad: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.6v5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="16.5" r="1" fill="currentColor"/></svg>',
  tip: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1" fill="currentColor"/></svg>',
};
const TOAST_TITLES = { ok: '操作成功', warn: '请注意', bad: '出错了', tip: '提示' };
const TOAST_TTL = { ok: 4500, warn: 6000, bad: 7000, tip: 4500 };
const TOAST_MAX = 4;
const TOAST_CLOSE = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

function dismissToast(el) {
  if (!el || el.dataset.leaving) return;
  el.dataset.leaving = '1';
  clearTimeout(el._toastTimer);
  const slot = el._toastSlot || el;
  if (!slot.isConnected) { slot.remove(); return; }
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) {
    slot.remove();
    return;
  }
  if (typeof el.animate !== 'function') { slot.remove(); return; }
  // 卡片只做**横向滑出**（transform/opacity，走合成层）；高度收起交给外层 slot，
  // 这样标题/按钮不会被挤扁，剩余卡片随 slot 高度平滑下落。
  const slide = el.animate(
    [{ transform: 'translateX(0)', opacity: 1 },
     { transform: 'translateX(calc(100% + 24px))', opacity: 0 }],
    { duration: 200, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'forwards' }
  );
  slide.onfinish = () => {
    const h = slot.offsetHeight;
    const gap = parseFloat(getComputedStyle(slot.parentElement).rowGap) || 0;
    slot.style.overflow = 'hidden';
    const close = slot.animate(
      [{ height: `${h}px`, marginBottom: '0px' },
       { height: '0px', marginBottom: `-${gap}px` }],
      { duration: 170, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'forwards' }
    );
    close.onfinish = () => slot.remove();
  };
}

function armToastTimer(el, ms) {
  clearTimeout(el._toastTimer);
  el._toastTimer = setTimeout(() => dismissToast(el), ms);
}

function buildToast(tone, title, desc, opts = {}) {
  const box = $id('toasts');
  if (!box) return null;
  const live = [...box.querySelectorAll('.toast:not([data-persist]):not([data-leaving])')];
  while (live.length >= TOAST_MAX) dismissToast(live.shift());

  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.setAttribute('role', tone === 'warn' || tone === 'bad' ? 'alert' : 'status');
  if (opts.persist) el.dataset.persist = '1';

  const icon = document.createElement('span');
  icon.className = 'toast-ico';
  icon.innerHTML = TOAST_ICONS[tone] || TOAST_ICONS.tip;

  const main = document.createElement('div');
  main.className = 'toast-main';
  const t = document.createElement('p');
  t.className = 'toast-title';
  t.textContent = title;
  main.appendChild(t);
  if (desc) {
    const d = document.createElement('p');
    d.className = 'toast-desc';
    d.textContent = desc;
    main.appendChild(d);
  }

  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'toast-x';
  x.setAttribute('aria-label', '关闭');
  x.innerHTML = TOAST_CLOSE;
  x.addEventListener('click', () => {
    dismissToast(el);
    if (opts.onClose) opts.onClose();
  });

  el.append(icon, main, x);
  const slot = document.createElement('div');
  slot.className = 'toast-slot';
  slot.appendChild(el);
  el._toastSlot = slot;
  box.appendChild(slot);

  if (!opts.persist) {
    el._toastMs = TOAST_TTL[tone] || 4500;
    armToastTimer(el, el._toastMs);
    el.addEventListener('mouseenter', () => clearTimeout(el._toastTimer));
    el.addEventListener('mouseleave', () => {
      if (!el.dataset.leaving) armToastTimer(el, el._toastMs);
    });
    el.addEventListener('focusin', () => clearTimeout(el._toastTimer));
    el.addEventListener('focusout', (e) => {
      if (!el.contains(e.relatedTarget) && !el.dataset.leaving) armToastTimer(el, el._toastMs);
    });
  }
  return el;
}

function toast(msg, cls = '') {
  const tone = cls === 'ok' || cls === 'warn' || cls === 'bad' ? cls : 'tip';
  let desc = String(msg ?? '');
  if (tone === 'bad') desc = desc.replace(/^失败：/, '');
  if (tone === 'ok') desc = desc.replace(/^✔\s*/, '');
  buildToast(tone, TOAST_TITLES[tone], desc);
}

/**
 * 站内确认卡（替代原生 confirm）。返回 Promise<boolean>。
 * 文案里有问号 ⇒ 问号那段做标题、其余做说明；也可用 opts.title 覆盖。
 * 默认焦点落在**取消**上：破坏性确认不该让回车直接生效。
 */
function confirmToast(msg, opts = {}) {
  const raw = String(msg ?? '').replace(/\s*\n+\s*/g, ' ').trim();
  const cut = raw.search(/[？?]/);
  let title = '请确认';
  let desc = raw;
  if (opts.title) {
    title = opts.title;
  } else if (cut >= 0) {
    title = raw.slice(0, cut + 1);
    desc = raw.slice(cut + 1).trim();
  }
  const tone = opts.tone === 'warn' ? 'warn' : 'bad';
  const prevFocus = document.activeElement;
  return new Promise((resolve) => {
    let settled = false;
    let finish;
    const el = buildToast(tone, title, desc, { persist: true, onClose: () => finish(false) });
    if (!el) { resolve(false); return; }
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'false');

    const foot = document.createElement('div');
    foot.className = 'toast-foot';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'toast-btn';
    cancel.textContent = opts.cancelLabel || '取消';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'toast-btn primary';
    ok.textContent = opts.okLabel || '确认';
    /* 选中态 = 实心填充（默认主操作；Tab/悬停把选中移到当前那颗）。
       取消按钮用主题强调色，主操作用卡片语义色 —— 不再画焦点外框。 */
    const setOn = (btn) => {
      cancel.classList.toggle('is-on', btn === cancel);
      ok.classList.toggle('is-on', btn === ok);
    };
    setOn(ok);
    for (const b of [cancel, ok]) {
      b.addEventListener('focus', () => setOn(b));
      b.addEventListener('mouseenter', () => setOn(b));
    }
    foot.addEventListener('mouseleave', () => {
      const at = document.activeElement;
      setOn(at === cancel ? cancel : at === ok ? ok : ok);
    });
    foot.addEventListener('focusout', (e) => {
      if (!foot.contains(e.relatedTarget)) setOn(ok);
    });
    foot.append(cancel, ok);
    el.appendChild(foot);
    el.tabIndex = -1;

    finish = (v) => {
      if (settled) return;
      settled = true;
      dismissToast(el);
      if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') {
        try { prevFocus.focus({ preventScroll: true }); } catch { /* 焦点归位失败不影响结果 */ }
      }
      resolve(v);
    };
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(false); });
    // 焦点先落在卡上：默认回车不会直接确认（Tab 才进到按钮）
    requestAnimationFrame(() => el.focus({ preventScroll: true }));
  });
}

/** 只有在 Electron 壳里才返回 API；普通浏览器没有 IPC，继续走 HTTP。 */
function shellApi() {
  const api = window.estrellaShell;
  return api && api.isShell ? api : null;
}

/** 只有在 Electron 壳里、且窗口被隐藏时才发系统通知；普通浏览器是 no-op。 */
function shellNotify(title, body) {
  if (!document.hidden) return;
  const api = shellApi();
  if (!api || typeof api.notify !== 'function') return;
  try { void api.notify({ title, body }); } catch { /* 壳通知失败不影响面板 */ }
}

/**
 * 写操作的**统一回报**（2026-10-14 立）。
 *
 * ⚠️ 它防的是一类真实存在的缺陷：**后端回了 `ok:false`，界面却显示成绿色的"成功"**。
 *    以前每个动作都自己写 `toastResult(r, '已启动')` —— 那个 `'ok'` 是**写死的**，
 *    于是"机器人启动失败"和"机器人已启动"在界面上长得一样（都是绿条 + 一行字，
 *    区别只在字里）。本项目最忌「失败伪装成成功」，而这一类恰恰**不报错、也不留痕**。
 *    2026-10-14 真机上维护者点「启动机器人」失败却没能立刻察觉，就是这个形状。
 *
 * ⇒ 写操作的提示**一律走这里**：颜色由后端的 `ok` 决定，不由调用方决定。
 *    （`catch` 里那条仍是 `'bad'` —— 那是请求本身失败，与这里不是一回事。）
 */
function toastResult(r, okMsg) {
  const failed = r && r.ok === false;
  toast((r && r.msg) || okMsg, failed ? 'bad' : 'ok');
  return failed;
}
let busyDepth = 0;
function busy(on, txt = '处理中…') {
  busyDepth = Math.max(0, busyDepth + (on ? 1 : -1));
  const b = $id('busy');
  b.hidden = busyDepth === 0;
  $id('busyTxt').textContent = txt;
}
/* `head`（2026-10-17）：标题右侧的附加控件。
   加它的直接原因是「添加自定义模型」要在标题旁摆云端/本地切换 —— 那是**表单的模式**，
   不属于表单内容；塞进 body 第一行会让人以为它是"第一个字段"。 */
let glassScrimRO = null;
/* 渐进模糊遮罩（2026-10-22）：与 #modal 相邻，三层 backdrop-filter 在 CSS 里，
   这里只负责"弹窗中心 → 遮罩椭圆"与面积分档。关闭立即隐藏，不做退出动画
   —— 卡住的全屏遮罩比瞬间关闭更糟。 */
function glassScrimSync() {
  const box = $id('modalBox');
  const scrim = $id('glassScrim');
  if (!box || !scrim) return;
  const r = box.getBoundingClientRect();
  scrim.style.setProperty('--gsc-cx', (r.left + r.width / 2) + 'px');
  scrim.style.setProperty('--gsc-cy', (r.top + r.height / 2) + 'px');
  scrim.style.setProperty('--gsc-rx2', Math.max(320, r.width / 2 + Math.min(innerWidth, 1440) * 0.26) + 'px');
  scrim.style.setProperty('--gsc-ry2', Math.max(240, r.height / 2 + innerHeight * 0.24) + 'px');
  scrim.style.setProperty('--gsc-rx3', Math.max(220, r.width / 2 + Math.min(innerWidth, 1440) * 0.1) + 'px');
  scrim.style.setProperty('--gsc-ry3', Math.max(180, r.height / 2 + innerHeight * 0.09) + 'px');
  const area = innerWidth * innerHeight;
  scrim.dataset.layers = area > 5000000 ? '1' : (area > 2400000 ? '2' : '3');
}
function glassScrimShow() {
  const scrim = $id('glassScrim');
  if (!scrim) return;
  scrim.hidden = false;
  glassScrimSync();
  requestAnimationFrame(() => scrim.classList.add('on'));
  if (typeof ResizeObserver !== 'undefined') {
    if (glassScrimRO) glassScrimRO.disconnect();
    glassScrimRO = new ResizeObserver(glassScrimSync);
    glassScrimRO.observe($id('modalBox'));
  }
  window.addEventListener('resize', glassScrimSync);
}
function glassScrimHide() {
  const scrim = $id('glassScrim');
  if (!scrim) return;
  scrim.classList.remove('on');
  scrim.hidden = true;
  if (glassScrimRO) { glassScrimRO.disconnect(); glassScrimRO = null; }
  window.removeEventListener('resize', glassScrimSync);
}
function modal(title, html, actions = [], head = '') {
  const box = $id('modalBox');
  box.innerHTML = `<div class="modal-h"><h3>${esc(title)}</h3>${head ? `<span class="spacer"></span>${head}` : ''}</div>
    <div class="modal-body">${html}</div>
    <div class="btn-row" style="margin-top:18px;justify-content:flex-end;">
      ${actions.map((a, i) => `<button class="btn ${a.style || 'btn-ghost'}" data-a="__modal" data-idx="${i}">${esc(a.label)}</button>`).join('')}
      <button class="btn btn-ghost" data-a="__modal-close">关闭</button>
    </div>`;
  $id('modal').hidden = false;
  modal._actions = actions;
  glassScrimShow();
}
const closeModal = () => { glassScrimHide(); $id('modal').hidden = true; modal._actions = []; };

/* ════════════════════════════════════════════════ 3. API ═══ */
/* GET 并发去重：同一路径同一瞬间只飞一次。**不缓存结果** —— /api/state、日志、
   审计必须每次拿最新值；这里只把重复请求合并到同一个 in-flight Promise。 */
const apiInflight = new Map();

async function apiDo(path, { method = 'GET', body = null, raw = false, timeout = 120000 } = {}) {
  /* ⚠️ 只挡**写**。第一版写成 `!S.online` 就抛 —— 而 `S.online` 初始为 false，
     于是连首屏那次 `GET /api/state` 都被自己挡掉，页面**永远进不了在线态**。
     表现是"一打开就是演示模式"，而日志里一句错都没有。 */
  if (!S.online && method !== 'GET') throw new Error('未连接后端（演示模式）');
  const opt = { method, headers: {} };
  if (HAS_TOKEN) opt.headers['Authorization'] = `Bearer ${TOKEN}`;
  if (body !== null && !(body instanceof Blob)) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  else if (body instanceof Blob) opt.body = body;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  opt.signal = ctl.signal;
  try {
    const r = await fetch(path, opt);
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) {
      const msg = (data && data.error) || (typeof data === 'string' && data) || `HTTP ${r.status}`;
      const err = new Error(msg);
      err.status = r.status;
      err.body = data;
      throw err;
    }
    return data;
  } finally { clearTimeout(timer); }
}

function api(path, opts = {}) {
  const method = opts.method || 'GET';
  /* `dedupe:false` 给**写后强制刷新**用：轮询请求若先起飞，合并会把它早于这次写入的
     旧响应塞回来 —— 表现就是"切了大脑，横幅还停在上一套"。 */
  if (method !== 'GET' || opts.dedupe === false) return apiDo(path, opts);
  const hit = apiInflight.get(path);
  if (hit) return hit;
  const p = apiDo(path, opts);
  apiInflight.set(path, p);
  const settle = () => { if (apiInflight.get(path) === p) apiInflight.delete(path); };
  p.then(settle, settle);
  return p;
}

/** 刷新 /api/state。失败时**明确**进入演示模式，并且说出来。 */
async function refresh(silent = false) {
  try {
    S.state = await api('/api/state', silent ? { dedupe: false } : undefined);
    if (!S.online) S.online = true;
  } catch (e) {
    if (S.online) { S.online = false; toast(`与后端断开：${e.message}`, 'bad'); }
    // ⚠️ 只有**原型模式**才回落到演示数据（2026-10-12 · 真机修正）。
    //    面板发来的页面（HAS_TOKEN）如果拿不到状态就摆出一屏"演示数据"，
    //    用户看到的是**看起来很正常的假数据**（机器人没在跑 / 容器未检测 / pid 0），
    //    而真相是"后端没应答"。诚实做法是留着空白 + 一行说明，见 paintPage。
    if (!S.state && !HAS_TOKEN) S.state = DEMO;
    S.bootTried = true;
  }
  // ⚠️⚠️ 第 58 轮 · 真机截图抓到的缺陷：**告警条以前永远不会消失。**
  //
  //    原来 `renderBanners()` 只挂在两个地方 —— 「离线 → 在线」那一瞬（上面那个 if），
  //    以及 catch 分支。**成功刷新的路径上根本没有它**，而 `paintTop()` / `softPaint()`
  //    每次都会跑 ⇒ 结果是：
  //      · 顶栏与页面内容**实时更新**；
  //      · 告警条**冻结在页面首次连上那一帧**，之后再也不变。
  //    用户看到的就是"同一页自相矛盾"：条子还停在旧状态，而下面的卡片已经实时更新。
  //
  //    受影响的是所有条子 —— 「内存很紧」（pressure≥90）一旦亮起，
  //    就算内存降下来也不会消失；「面板服务端是旧代码」「没拿到 token」同理。
  //
  //    所以它必须和 paintTop / softPaint 一样，**每次拿到新状态都重绘**。
  //    （告警条里没有输入框，不受 `busyTyping()` 那条"别打断打字"的约束。）
  /* UI 身份锁（§171）：服务端签名结果 + 本地 DOM 核心锚点；只在首次/服务端 checkedAt 变化时计算。 */
  if (S.state && S.state.uiIdentity) runUiIdentityCheck(S.state.uiIdentity);
  else if (S.online) runUiIdentityCheck(null);
  renderBanners();
  paintTop();
  softPaint();
  announceLogin();
  announceModelSync();
  announceShellBotState();
  if (!silent && !S.online) return;
}

/**
 * 官方模型目录对账的**一次性提示**（2026-10-17 · 维护者点名）。
 *
 * 事件由后端在启动 / 6 小时节流时写进 `panel/model-sync.json`，`/api/state` 原样下发。
 * 这里只负责"没见过的弹一次"：事件 id 记在 `localStorage`。
 * ⚠️ 换一个浏览器会再弹一次 —— 可接受（它说的是"你的模型更新了"，
 *    不是"提醒你去点某个按钮"，重复一次不误导）。
 * ⚠️ 弹完就记账，**不依赖后端回执**：读路由不该因为一条提示而变成写路由。
 */
const SYNC_SEEN_KEY = 'modelSyncSeen';
function announceModelSync() {
  const evs = Array.isArray(S.state?.modelSync?.events) ? S.state.modelSync.events : [];
  if (!evs.length) return;
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(SYNC_SEEN_KEY) || '[]'); } catch { seen = []; }
  if (!Array.isArray(seen)) seen = [];
  const fresh = evs.filter((e) => e && e.id && !seen.includes(e.id));
  if (!fresh.length) return;
  for (const e of fresh) toast(`${e.title}${e.detail ? ` · ${e.detail}` : ''}`, 'ok');
  try { localStorage.setItem(SYNC_SEEN_KEY, JSON.stringify([...seen, ...fresh.map((e) => e.id)].slice(-20))); } catch { /* 无痕模式 */ }
}

let lastBridgeRunning = null;
function announceShellBotState() {
  const running = !!(S.state && S.state.bridge && S.state.bridge.running);
  if (lastBridgeRunning === true && !running) {
    shellNotify('机器人已停止', '面板仍在运行；打开面板查看「启动链路」。');
  }
  lastBridgeRunning = running;
}

/**
 * 扫码登录**成功**的那一下，在面板里明确说出来（2026-10-13）。
 *
 * 为什么需要：以前扫码之后没有任何"成了"的信号 —— 用户只能自己猜（去别处看一眼，
 * 或者干脆再扫一次）。而"再扫一次"在旧链路里意味着再开一个前台窗口，
 * 那个窗口一关又把登录态带走了。
 *
 * ⚠️ 只在**二维码弹窗开着**的时候报（那才说明用户正处在扫码流程里）；
 *    否则每次刷新页面都会因为"已经登录着"弹一次成功提示，那是噪音不是反馈。
 *    报完顺手把弹窗关掉 —— 码用完了，留在屏幕上只会误导下一次。
 */
let loginNickShown = '';
function announceLogin() {
  const nick = (S.state && S.state.account && S.state.account.nickname) || '';
  if (!nick) return;
  const qrOpen = Boolean(document.querySelector('[data-qr]'));
  if (!qrOpen) { loginNickShown = nick; return; }
  if (nick === loginNickShown) return;
  loginNickShown = nick;
  closeModal();
  toast(`登录成功：${nick}（以后开机会自动登录，不用再扫）`, 'ok');
}

/**
 * 轮询重画之前先看一眼：用户正在输入 / 有没保存的改动 → **这一次不重画**。
 * 无脑 `innerHTML =` 会把焦点和光标一起换掉，表现是"打字打到一半跳走"，
 * 而 3 秒一次的轮询正好能把这件事变成常态。
 */
function busyTyping() {
  const t = document.activeElement;
  const tag = t && t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable === true;
}
/**
 * 拖拽排序总闸。改成 false（或删掉 `sortable.js` 的 script 标签）⇒
 * 线路板退回纯 ↑↓ 按钮：**顺序照常能改**，只是没有拖拽与让位动画。
 *
 * ⚠️ 必须声明在 `softPaint` **之前** —— `const` 有 TDZ，
 * 「声明在使用点之后」在这里会真的抛 ReferenceError（本项目踩过）。
 */
const SORTABLE_ON = true;

function softPaint() {
  /* ⚠️ 三个守卫的顺序**不能换**，也不能只留其中一个：
       ① 用户正在输入 / 有未保存改动 —— 否则光标被吞（原有纪律）
       ② 排序列表在忙（拖动中或让位动画未收敛）—— `innerHTML` 重建会把
          正在拖的节点换掉（拖拽当场断），也会把动画元素换掉（看起来"闪一下"）。
          ⚠️ 这不是"少见情况"：本页面每 3 秒重绘一次，必撞。
       ③ 守卫挡掉的那次重绘由 `Sortable` 的 `onSettled` 补上（见 mountRouteSort），
          所以这里**只挡不补**的话标签文案会晚一个周期。 */
  if (busyTyping() || dirtyKeys() > 0) return;
  if (SORTABLE_ON && window.Sortable && window.Sortable.busy()) return;
  paintPage(false);
}

/* ════════════════════════════════════════════════ 4. 草稿 ═══ */
/**
 * 改动计数 = **被用户动过的路径条数**，不是"草稿里有几个键"。
 *
 * ⚠️ 第一版数的是 `S.draft.custom` 的顶层键数，而列表类渲染器（技能 / 记忆 / 定时 /
 *    插件白名单）每次重画都会把当前数组**快照**进草稿 —— 于是"只是打开这一页"
 *    就会显示「有 5 处改动还没保存」，而且 `softPaint()`（有草稿就不重画）会因此
 *    **永久停更**，页面看起来卡在旧数据上。两处都由这一个计数错误引起。
 *    所以：快照 ≠ 改动。改动只在用户真的动了控件时登记。
 */
const dirtyKeys = () => S.dirty.size;
const touchC = (p) => S.dirty.add(`c:${p}`);
const touchS = (k) => S.dirty.add(`s:${k}`);
function markDirty() {
  $id('savebar').hidden = dirtyKeys() === 0;
  $id('savebarTxt').textContent = `有 ${dirtyKeys()} 处改动还没保存`;
}
/**
 * 控件值的**读口**。
 *
 * ⚠️ `ctrl.pct`（2026-10-12）：界面上的百分数控件（如「随机插话概率（%）」）
 *    与盘上的小数**不是同一个单位**，换算必须收在这里，不能让每个控件各写一遍。
 *
 *    修之前是一个很典型的"一个框、两个单位"缺陷：框里画 0–100、标签写着 `%`，
 *    而 `trigger.interjectChance` 从 config.json 到服务端**全程是 0–1 的小数**，
 *    读写两个方向都不换算。于是用户填 15 → 服务端 `Math.min(1, 15)` ⇒ 盘上是 `1`（=100%）
 *    ⇒ **填什么都被钉在上限**（症状"改了不生效"）；盘上真值 0.15 时框里回显 0.15
 *    （症状"改了不显示"）。两个症状看起来毫无关系，根因是同一行没换算。
 */
function valueOf(ctrl) {
  const s = S.state || DEMO;
  const raw = (() => {
    if (ctrl.id in S.volatile) return S.volatile[ctrl.id];
    if (ctrl.bind) {
      const d = getPath(S.draft.custom, ctrl.bind);
      return d !== undefined ? d : getPath(s.custom, ctrl.bind);
    }
    if (ctrl.bindSys) {
      const d = S.draft.sys[ctrl.bindSys];
      return d !== undefined ? d : getPath(s.config, ctrl.bindSys);
    }
    return ctrl.read ? ctrl.read(s) : ctrl.value;
  })();
  if (ctrl.pct && raw !== '' && raw != null && Number.isFinite(Number(raw))) {
    return String(Math.round(Number(raw) * 100));
  }
  /* `scale`（2026-10-17）：界面单位 ≠ 盘上单位，且差一个**乘数**（插话冷却：分钟 ↔ 毫秒）。
     与 `pct` 同一条纪律 —— 换算只许住在这里，控件自己只声明 `scale`。
     不合并进 `pct` 的理由：`pct` 的语义是"百分比"，写死 /100，读回时还要 round；
     把它改成通用乘数会让 6 处百分比控件的语义跟着一起变（它们只声明了 `pct: true`）。 */
  if (ctrl.scale && raw !== '' && raw != null && Number.isFinite(Number(raw))) {
    return String(Math.round(Number(raw) / Number(ctrl.scale)));
  }
  return raw;
}
function setValue(ctrl, v) {
  // 写口是读口的逆运算，同样只在这里做一次（理由见 valueOf）
  const numv = v !== '' && v != null && Number.isFinite(Number(v));
  const stored = (ctrl.pct && numv)
    ? Number(v) / 100
    : (ctrl.scale && numv ? Number(v) * Number(ctrl.scale) : v);
  if (ctrl.bind) { setPath(S.draft.custom, ctrl.bind, stored); touchC(ctrl.bind); }
  else if (ctrl.bindSys) { S.draft.sys[ctrl.bindSys] = stored; touchS(ctrl.bindSys); }
  else S.volatile[ctrl.id] = stored;
  markDirty();
}
/**
 * 只把**动过的那几支**打包提交。
 *
 * 为什么不整份提交：草稿里还躺着列表快照（用户没动过），整份提交等于把一份可能
 * 已经过时的数组写回磁盘 —— 那正是"我没改这一块，它却变了"的经典来源。
 */
function draftBody() {
  const custom = {};
  const body = {};
  for (const p of S.dirty) {
    if (p.startsWith('c:')) {
      const path = p.slice(2);
      const v = getPath(S.draft.custom, path);
      setPath(custom, path, v === undefined ? null : JSON.parse(JSON.stringify(v)));
    } else if (p.startsWith('s:')) {
      body[p.slice(2)] = S.draft.sys[p.slice(2)];
    }
  }
  if (Object.keys(custom).length) body.custom = custom;
  return body;
}
async function commitDraft() {
  if (!dirtyKeys()) return;
  const body = draftBody();
  busy(true, '保存中…');
  try {
    const r = await api('/api/config', { method: 'POST', body });
    S.draft = { custom: {}, sys: {} };
    S.dirty.clear();
    markDirty();
    toast(r?.autoDisabledMsg || '已保存并生效', r?.autoDisabledMsg ? 'warn' : 'ok');
    if (r && r.applied === false) toast('机器人还没读入新配置（可能在启动中），稍后看「运行 → 总览」的生效时间', 'warn');
    await refresh(true);
  } catch (e) { toast(`保存失败：${e.message}`, 'bad'); }
  finally { busy(false); }
}
function discardDraft() {
  S.draft = { custom: {}, sys: {} };
  S.dirty.clear();
  markDirty();
  paintPage(false);
  toast('已丢弃未保存的改动');
}

/* ════════════════════════════════════════════════ 5. 动作表 ═══ */
const post = (url, body) => api(url, { method: 'POST', body });
const DEMO_BLOCK = () => {
  toast(shellApi()
    ? '后端未连接：先点告警条里的「重启面板」'
    : '演示模式：这一页没有连上后端，写操作不会发送', 'warn');
};
/* HUD 几何预设：只是把宽高一起写进 island.js，不复制它的默认值。 */
function hudPreset(w, h) {
  if (!window.Island) return;
  window.Island.set({ width: w, height: h });
  paintPage(false);
  toast(`HUD 尺寸：${w}×${h}`, 'ok');
}

const ACTIONS = {
  'onekey.start': async () => { busy(true, '一键启动中…'); try { const r = await post('/api/onekey/start'); stepsOf(r); toastResult(r, '已启动'); await refresh(true); } catch (e) { toast(`启动失败：${e.message}`, 'bad'); } finally { busy(false); } },
  /* P11：协议端没装时的两条自助路 —— 不再让用户去 AppData 里放文件。 */
  'napcat.importAuto': async () => {
    busy(true, '正在查找已解压的 NapCat…');
    try {
      const r = await post('/api/napcat/import-auto');
      if (r.ok) toast(r.action === 'already' ? '协议端已经装好了' : `已从 ${r.from} 装好协议端`, 'ok');
      else if (r.action === 'not-found') toast('没找到 —— 点「打开协议端文件夹」把 NapCat.Shell 里的文件拖进去', 'bad');
      else toast(`失败：${r.msg || r.error || r.action}`, 'bad');
      await refresh(true);
    } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); }
  },
  'napcat.openFolder': async () => {
    try {
      const r = await post('/api/napcat/open-folder');
      toast(r.ok ? '已打开文件夹 —— 把 NapCat.Shell 里的文件拖进去即可，页面会自动检测' : (r.msg || '打不开'), r.ok ? 'ok' : 'bad');
    } catch (e) { toast(`失败：${e.message}`, 'bad'); }
  },
  'onekey.stop': async () => { if (!(await confirmToast('结束本次运行？机器人 + 本机模型 + 协议端一起停，面板也会退出。', { okLabel: '结束' }))) return; busy(true, '结束中…'); try { const r = await post('/api/onekey/stop'); stepsOf(r); if (r && r.panelExiting) { document.body.innerHTML = '<div style="font:16px/1.8 system-ui,sans-serif;padding:48px;text-align:center"><h2>已结束并退出</h2><p>机器人、模型、协议端与控制台进程都已停止。</p><p>这个窗口可以关掉了；下次双击图标会重新拉起。</p></div>'; return; } toastResult(r, '已结束'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'bridge.start': async () => { busy(true, '启动机器人…'); try { const r = await post('/api/bridge/start'); toastResult(r, '已启动'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'bridge.stop': async () => { if (!(await confirmToast('停止机器人？', { okLabel: '停止' }))) return; busy(true, '停止中…'); try { const r = await post('/api/bridge/stop'); toastResult(r, '已停止'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'cmd.sleep': () => bridgeCmd('sleep'), 'cmd.wake': () => bridgeCmd('wake'),
  'cmd.abort': () => bridgeCmd('abort'), 'cmd.retry': () => bridgeCmd('retry'),
  'check': async () => { busy(true, '自检中…'); try { const r = await post('/api/check'); modal('连接自检', `<pre class="mono" style="white-space:pre-wrap;font-size:12px;">${esc(r.output || '')}</pre>`, [{ label: '知道了', style: 'btn-primary' }]); } catch (e) { toast(`自检失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'groups.load': async () => { busy(true, '读取群列表…'); try { const r = await api('/api/groups'); S.extra.groups = r.groups || []; modal('机器人已加入的群', r.groups?.length ? `<div class="rows">${r.groups.map((g) => `<div class="row flat"><span class="mono">${esc(g.id)}</span><span class="spacer"></span><span>${esc(g.name)}</span></div>`).join('')}</div>` : '<div class="empty">协议端没连上，或还没加入任何群。</div>', [{ label: '知道了', style: 'btn-primary' }]); } catch (e) { toast(`读取失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'open.webui': () => openTab('/api/qrcode', '二维码', true),
  'open.qwenchat': () => { const p = j(S.state, ['localModel', 'ports', 'qwenchat'], 8765); window.open(`http://127.0.0.1:${p}`, '_blank'); },
  'open.home': () => window.open('/', '_blank'),
  'update.goto': () => {
    const gi = GROUPS.findIndex((g) => g.id === 'sys');
    const si = gi >= 0 ? GROUPS[gi].subs.findIndex((x) => x.id === 'panel') : -1;
    if (gi >= 0 && si >= 0) { S.gi = gi; S.si = si; paintPage(true); }
  },
  /* HUD 信息岛：设置页的即时动作。设置本体在 island.js 的 localStorage，
     这里只调它并重画当前页；不经过 /api/config，也不碰机器人进程。 */
  'hud.entrance': () => { if (window.Island) { window.Island.replayEntrance(); toast('已重播入场', 'ok'); } },
  'hud.replaySwitch': () => { if (window.Island) { window.Island.replaySwitch(); toast('已重播切换', 'ok'); } },
  'hud.birth': () => { if (window.Island) { window.Island.replayBirth(); toast('已重播出生', 'ok'); } },
  'hud.next': () => { if (window.Island) { window.Island.next(); toast('已切到下一条', 'ok'); } },
  'hud.move': (p) => {
    const [id, dir] = String(p || '').split('|');
    if (window.Island && id) { window.Island.moveItem(id, Number(dir)); paintPage(false); }
  },
  'hud.defaultThree': () => {
    if (window.Island) { window.Island.set({ enabled: ['usage', 'bridge', 'memory'] }); paintPage(false); toast('已恢复默认三条', 'ok'); }
  },
  'hud.all': () => {
    if (window.Island) { window.Island.setAll(true); paintPage(false); toast('已启用全部状态项', 'ok'); }
  },
  'hud.none': () => {
    if (window.Island) { window.Island.setAll(false); paintPage(false); toast('已全部停用（岛仍显示当前项）', 'warn'); }
  },
  'hud.export': () => {
    if (!window.Island) return;
    try {
      const blob = new Blob([JSON.stringify(window.Island.exportConfig(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'hud-island-config.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('已导出 HUD 配置', 'ok');
    } catch (e) { toast(`导出失败：${e.message}`, 'bad'); }
  },
  'hud.preset.mini': () => hudPreset(260, 30),
  'hud.preset.compact': () => hudPreset(320, 34),
  'hud.preset.standard': () => hudPreset(380, 38),
  'hud.preset.reference': () => hudPreset(440, 44),
  'hud.preset.large': () => hudPreset(520, 48),
  'hud.reset': () => { if (window.Island) { window.Island.resetConfig(); paintPage(false); toast('HUD 设置已恢复默认', 'ok'); } },
  'update.check': async () => {
    try {
      const r = await post('/api/update/check');
      UPD.state = r;
      paintUpdateBox();
      renderBanners();
      if (!r.ok) toast(r.error || '检查更新失败', 'bad');
      else toast(r.phase === 'up_to_date' ? '已是最新版本' : (r.phase === 'available' ? `发现新版本 ${r.latest?.version || ''}` : '检查完成'), 'ok');
    } catch (e) { toast(`检查更新失败：${e.message}`, 'bad'); }
  },
  'update.download': async () => {
    try {
      const r = await post('/api/update/download');
      UPD.state = r;
      paintUpdateBox();
      if (!r.ok) toast(r.error || '下载启动失败', 'bad');
      else toast('开始下载更新…', 'ok');
    } catch (e) { toast(`下载失败：${e.message}`, 'bad'); }
  },
  'update.cancel': async () => {
    try {
      const r = await post('/api/update/cancel');
      UPD.state = r;
      paintUpdateBox();
      toast('已取消下载', 'warn');
    } catch (e) { toast(`取消失败：${e.message}`, 'bad'); }
  },
  'update.install': async () => {
    if (!(await confirmToast('应用将关闭，安装完成后重新打开。', { title: '现在安装？', tone: 'warn', okLabel: '现在安装' }))) return;
    try {
      const r = await post('/api/update/install');
      if (!r.ok) { toast(r.error || '安装启动失败', 'bad'); return; }
      UPD.state = r;
      paintUpdateBox();
      busy(false);
      modal('正在安装', '<div class="empty">安装器已启动，应用即将关闭。安装完成后请重新打开控制台。</div>', [{ label: '知道了', style: 'btn-primary' }]);
      // 有壳时让壳先走完整退出链（bridge/stop → panel/quit → stop.mjs），
      // 否则 Electron 会锁着 versions/<ver>/app/electron 目录，安装器换不动。
      setTimeout(() => { try { window.estrellaShell?.quit?.(); } catch { /* 浏览器模式没有壳 */ } }, 800);
    } catch (e) { toast(`安装失败：${e.message}`, 'bad'); }
  },
  'update.offline.verify': async () => {
    const m = $id('upd-off-manifest')?.files?.[0];
    const s = $id('upd-off-sig')?.files?.[0];
    const e = $id('upd-off-exe')?.files?.[0];
    const status = $id('upd-off-status');
    const set = (t, bad = false) => {
      if (status) { status.textContent = t; status.classList.toggle('bad', bad); }
    };
    if (!m || !s || !e) { set('请先选齐 latest.json、.sig 和安装包', true); return; }
    busy(true, '校验离线包…');
    try {
      set('读取并校验清单…');
      const manifestBase64 = bytesToB64(new Uint8Array(await m.arrayBuffer()));
      const sigBase64 = await s.text();
      const prep = await post('/api/update/offline/prepare', { manifestBase64, sigBase64 });
      if (!prep.ok) { set(prep.error || '离线清单校验失败', true); return; }
      set(`清单 OK（${prep.offline?.version || ''}），上传安装包…`);
      const exeBytes = await e.arrayBuffer();
      const done = await api('/api/update/offline/installer', {
        method: 'POST', body: new Blob([exeBytes]), timeout: 300000,
      });
      if (!done.ok) { set(done.error || '离线安装包校验失败', true); return; }
      UPD.state = done;
      paintUpdateBox();
      renderBanners();
      toast(`离线更新 ${done.latest?.version || ''} 已校验，可立即安装`, 'ok');
    } catch (err) {
      set(`离线校验失败：${err.message}`, true);
    } finally {
      busy(false);
    }
  },
  'protocol.start': async () => { busy(true, '拉起协议端…'); try { const r = await post('/api/protocol/start'); toast(r.msg || '已发起', r.ok ? 'ok' : 'bad'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'napcat.restart': async () => { busy(true, '重启容器…'); try { const r = await post('/api/napcat/restart'); toast(r.output || '已重启', 'ok'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'qrcode.refresh': async () => { await doQrRefresh(); },
  'stopall': async () => { if (!(await confirmToast('一键全停：机器人 + 本机模型 + 协议端？', { okLabel: '全部停止' }))) return; busy(true, '全停中…'); try { const r = await post('/api/stop-all'); toastResult(r, '已全停'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'local.start': async () => { busy(true, '拉起本机模型…'); try { const r = await post('/api/local-model/start'); toastResult(r, '已启动'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'local.stop': async () => { busy(true, '停止本机模型…'); try { const r = await post('/api/local-model/stop'); toastResult(r, '已停止'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'switch.local': () => switchBrain('local'), 'switch.cloud': () => switchBrain('cloud'),
  'switch.zhipu': () => switchBrain('zhipu'), 'switch.qwen': () => switchBrain('qwen'),
  /* 自定义大脑：`brain.use` 带 id（同一 target 下有多套）；
     `brain.add` 弹表单（新增与编辑共用同一个表单，靠 id 区分）。 */
  'brain.use': (id) => switchBrain('custom', id),
  'brain.add': () => brainForm(null),
  /* 表单里的「云端 ⇄ 本地」切换（2026-10-17）。就地重画**同一个弹窗**：
     保留名字 / Key / 勾选，地址与模型名清空 —— 两套形态的地址不通用，
     把云端 URL 带进本地表单只会让人填错后得到一次看不懂的 fetch 失败。 */
  'brain.mode': (id) => {
    const mode = bfVal('mode') === 'local' ? 'cloud' : 'local';
    brainForm(id || '', {
      mode,
      name: bfVal('name'),
      baseUrl: '',
      model: '',
      apiKey: mode === 'cloud' ? bfVal('apiKey') : '',
      features: {
        vision: bfChecked('vision'),
        thinking: bfChecked('thinking'),
        webSearch: bfChecked('webSearch'),
      },
    });
  },
  /* 打开这家服务商的「额度页」。地址**不在前端**：它随 `state.quotaPlans` 下发
     （唯一实现住 `src/free-quota.js`）—— 额度页地址是会变的（改版就换路径），
     写在页面里等于埋一个迟早失效、且失效时**没有任何提示**的链接。 */
  'quota.open': () => {
    const p = j(S.state, ['config', 'provider'], 'zhipu');
    const url = j(S.state, ['quotaPlans', p, 'controlUrl'], '');
    if (!url) return toast('这家没有单独的额度页', 'warn');
    window.open(url, '_blank');
  },
  'balance.load': async () => { busy(true, '查余额…'); try { const r = await api('/api/balance'); S.extra.balance = r; S.state.__balance = balanceText(r); paintPage(false); toast('已刷新余额', 'ok'); } catch (e) { toast(`查询失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'usage.reset': async () => { if (!(await confirmToast('清零用量统计？会删掉 panel/ 下所有 usage*.jsonl。', { okLabel: '清零' }))) return; try { const r = await post('/api/usage/reset'); toastResult(r, '已清零'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } },
  'trace.clear': async () => { if (!(await confirmToast('清空对话流记录？', { okLabel: '清空' }))) return; try { await post('/api/trace/clear'); toast('已清空', 'ok'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } },
  'logs.clear': async () => { try { await post('/api/logs/clear'); S.logCursor = 0; S.extra.logs = null; toast('已清空', 'ok'); paintPage(false); } catch (e) { toast(`失败：${e.message}`, 'bad'); } },
  'mem.auto.clear': async () => { if (!(await confirmToast('清空历史存量？手动记忆与结构化记忆不受影响。', { okLabel: '清空' }))) return; try { const r = await post('/api/custom/memory/clear'); toastResult(r, '已清空'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } },
  'mem.auto.del': async (id) => { try { const r = await post('/api/custom/memory/delete', { id }); toastResult(r, '已删除'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } },
  'mem.review': async (p) => { const [id, action] = String(p).split('|'); try { const r = await post('/api/memory/review', { id, action }); toastResult(r, `已${action}`); await refresh(true); } catch (e) { toast(e.message === '这条不在了' ? '这条已经不在了（可能另一个窗口刚删过），正在刷新' : `失败：${e.message}`, 'bad'); await refresh(true); } },
  // D-M3：按关键词检索记忆。**只读**（不做复证、不加 samples），所以失败也不刷新整页。
  'mem.search': async () => {
    const q = String($id('memQ')?.value || '').trim();
    if (!q) return toast('先写要搜什么', 'warn');
    try {
      const r = await post('/api/memory/search', { query: q });
      S.extra.memSearch = { q, lines: r.lines || [], hits: r.hits || [] };
      paintPage(false);
      if (!(r.lines || []).length) toast('没捞到相关内容', 'warn');
    } catch (e) { toast(`检索失败：${e.message}`, 'bad'); }
  },
  'mem.search.clear': () => { S.extra.memSearch = null; paintPage(false); },
  /* 长列表封顶的展开 / 收起（见 `capRows`）。**只改 `S.extra.open` 再重画**：
     那是"这一屏怎么看"，不是数据 —— 所以不写 config、不落盘、刷新即折叠。 */
  'list.more': (p) => { if (!S.extra.open) S.extra.open = {}; S.extra.open[p] = true; paintPage(false); },
  'list.fold': (p) => { if (S.extra.open) delete S.extra.open[p]; paintPage(false); },
  /* ── 网页内置终端（2026-10-11）─────────────────────────────────────────────
     这三个动作都在终端页里。`panel.quit` 是"关掉控制台"的**唯一**正规出口 ——
     以前只能去任务管理器杀 node，而那既不该是普通用户的操作，也会留下锁文件。 */
  'term.src': () => { TERM.src = TERM.src === 'napcat' ? 'panel' : 'napcat'; TERM.stick = true; paintPage(false); },
  'term.clear': () => {
    if (TERM.src === 'napcat') TERM.nap = []; else TERM.lines = [];
    paintTerm();
  },
  'panel.quit': async () => {
    if (!(await confirmToast('退出控制台？\n\n机器人是独立进程，不会被一起停掉。\n退掉之后控制台不再占着文件，整个目录就能删了。', { okLabel: '退出' }))) return;
    busy(true, '正在退出…');
    const api = shellApi();
    if (api && typeof api.quitConsole === 'function') {
      try {
        const r = await api.quitConsole();
        if (r && r.ok === false) throw new Error(r.error || '退出失败');
        TERM.quit = true;
        paintPage(false);
        toast('控制台已退出（机器人继续运行）', 'ok');
      } catch (e) {
        toast(`退出失败：${e.message}`, 'bad');
      } finally { busy(false); }
      return;
    }
    try {
      await post('/api/panel/quit');
      TERM.quit = true;
      paintPage(false);
      toast('控制台已退出 —— 双击桌面图标可以再打开', 'ok');
    } catch (e) {
      // ⚠️ 连接被掐断**正是预期结果**（服务端先回响应再退，但竞态下也可能先断）
      //    ⇒ 只要请求发出去过，就按"已退出"处理，别把正常结果报成失败。
      TERM.quit = true;
      paintPage(false);
      toast('控制台已退出', 'ok');
    } finally { busy(false); }
  },
  'panel.restart': async () => {
    busy(true, '重启面板…');
    const api = shellApi();
    if (api && typeof api.restartPanel === 'function') {
      try {
        const before = j(S.state, ['panel', 'pid']);
        const r = await api.restartPanel();
        if (!r || r.ok === false) {
          toast(`失败：${(r && r.error) || '重启失败'}`, 'bad');
          busy(false);
          return;
        }
        if (!r.restarted) { toast(r.msg || '已是最新，没有重启'); busy(false); return; }
        toast('正在重启，几秒后自动刷新…', 'ok');
        // 壳会在新面板就绪后重载窗口；这一层只兜“壳没来得及重载”的路径。
        await waitPanelPid(before);
      } catch (e) {
        toast(`失败：${e.message}`, 'bad');
      } finally { busy(false); }
      return;
    }
    try {
      const before = j(S.state, ['panel', 'pid']);
      const r = await post('/api/panel/restart');
      if (!r.restarted) { toast(r.msg || '已是最新，没有重启'); busy(false); return; }
      toast('正在重启，几秒后自动刷新…', 'ok');
      await waitPanelPid(before);
    } catch (e) {
      toast(`失败：${e.message}`, 'bad');
    } finally { busy(false); }
  },
  /* ── 假 QQ 会话（2026-10-21 · Win-v0.1.2 移植）──────────────────────────
     三条写路由（start / send / stop）+ 一个只读状态轮询。写的是**服务端**的进程，
     不是草稿 —— 所以这里不碰 S.draft / markDirty()。 */
  'fake.start': async () => {
    const o = fakeOpts();
    if (!o.sandbox && j(S.state, ['bridge', 'running'])) {
      return toast('真机器人在跑：先停它，或勾上「沙箱数据」再启动', 'warn');
    }
    busy(true, '起假 QQ…');
    try {
      const r = await post('/api/fake-qq/start', { offline: o.offline, sandbox: o.sandbox });
      if (!r?.ok) return toast(r?.msg || '起不来', 'bad');
      S.extra.fakeSince = 0; S.extra.fakeLines = [];
      toastResult(r, '已启动');
      await fakePoll();
    } catch (e) { toast(`启动失败：${e.message}`, 'bad'); }
    finally { busy(false); }
  },
  'fake.stop': async () => { try { const r = await post('/api/fake-qq/stop'); toastResult(r, '已停止'); } catch (e) { toast(`停止失败：${e.message}`, 'bad'); } },
  'fake.send': async () => {
    const text = String(S.volatile['fake.text'] ?? '').trim();
    if (!text) return toast('先写一句要发的话', 'warn');
    await fakeSay(text, true);
  },
  'fake.cmd': async (p) => { await fakeSay(`/${p}`); },
  'fake.clear': () => { S.extra.fakeLines = []; paintFake(); },
  'fake.opt': (p) => { const o = fakeOpts(); o[p] = !o[p]; paintPage(false); },
  'config.undo': async () => { if (!(await confirmToast('撤销上一次保存？配置会整份退回那一版。', { okLabel: '撤销' }))) return; busy(true, '撤销中…'); try { const r = await post('/api/config/undo', { steps: 1 }); toastResult(r, '已撤销'); await refresh(true); } catch (e) { toast(`撤销失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'try.run': async () => { const text = String(S.volatile['try.text'] || '').trim(); if (!text) return toast('先写一句要它回的话', 'warn'); busy(true, '跑完整链路…'); try { S.extra.tryOut = await post('/api/try', { text }); paintPage(false); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'skill.add.pack': () => addSkill('pack'), 'skill.add.persona': () => addSkill('persona'),
  'skill.apply': (i) => applyPersonaCard(Number(i)),
  'skill.snap': (i) => snapPersonaCard(Number(i)),
  'cg.do': (p) => fillCardDim(p),
  'cg.adopt': (i) => adoptCard(Number(i)),
  // 定时消息的新条目必须是对象：推空串的话 `schedAction` 会在 strict mode 抛错。
  'row.add': (p) => { draftArr(p).push({ at: '', text: '', prompt: '', target: 'group', enabled: true }); touchC(p); markDirty(); paintPage(false); },
  'row.del': (p) => {
    const [path, i] = String(p).split('|');
    draftArr(path).splice(Number(i), 1);
    touchC(path); markDirty(); paintPage(false);
  },
  '__modal': (p, ev) => { const i = Number(ev.target.dataset.idx); const a = modal._actions[i]; if (a && a.run) a.run(); else closeModal(); },
  '__modal-close': closeModal,

  /* ── 人设域六页（2026-10-25）──────────────────────────────────────────
     ⚠️ 这些必须写在 `const ACTIONS = { … }` **字面量里**，不能用 Object.assign 追加：
        静态契约（check-wb §68）只解析这张字面量；追加进去的动作在它眼里等于不存在，
        页面上的按钮会被判成"没有处理者"。 */
  'psn.type': (p) => {
    const t = String(p || '');
    const axes = {
      EI: t.includes('I') ? 62 : 38,
      SN: t.includes('N') ? 58 : 42,
      TF: t.includes('F') ? 57 : 43,
      JP: t.includes('P') ? 54 : 46,
    };
    for (const [k, v] of Object.entries(axes)) {
      setValue({ id: `mbti.axis.${k}`, bind: `mbti.axes.${k}`, t: 'range' }, v);
    }
    paintPage(false);
  },
  'psn.prompt.unlock': () => {
    const n = psnSections().filter((s) => PSN_EDITABLE.includes(s.id) && s.enabled).length;
    modal('编辑系统提示词', `<p>确认后，下面 <b>${n}</b> 段都会变成可编辑的全文。</p>
      <ul><li>只改这一页的提示词快照，不回写人设 / MBTI / 增强项页。</li>
      <li>保存后下一轮生效；「恢复全部自动」会清掉所有覆盖。</li>
      <li>关着的段（MBTI / 彩蛋 / 扮演规则）即使存着旧覆盖也不会注入。</li></ul>`,
    [{ label: '开始编辑', style: 'btn-primary', run: () => { psnPromptBeginEdit(); closeModal(); } }]);
  },
  'psn.prompt.cancel': () => {
    S.extra.psnPromptEdit = false;
    S.extra.psnPromptBuf = null;
    paintPage(false);
  },
  'psn.prompt.save': () => psnPromptSave(),
  'psn.prompt.reset': () => psnPromptReset(),
  'psn.copy': () => psnCopyPrompt(),
  'psn.mood.refresh': async () => {
    await refresh(true);
    toast('已重新读取状态', 'ok');
  },
  'psn.art': () => {
    const type = String(document.querySelector('.psn [data-psn-type-code2]')?.textContent || psnMbti().type || 'INFJ');
    psnOpenArt(type);
  },
  'psn.art.close': () => psnCloseArt(),
  'psn.rules.unlock': () => psnRulesBeginEdit(),
  'psn.rules.lock': () => {
    S.extra.psnRulesEdit = false;
    paintPage(false);
  },
  'psn.rules.add': () => {
    const list = psnRulesEnsureDraft();
    if (list.length >= 40) return toast('最多 40 条', 'warn');
    list.push({ text: '' });
    psnRulesTouch();
    paintPage(false);
    return undefined;
  },
  'psn.rules.del': (p) => {
    const list = psnRulesEnsureDraft();
    const i = Math.max(0, Math.min(list.length - 1, Number(p) || 0));
    list.splice(i, 1);
    psnRulesTouch();
    paintPage(false);
  },
  'psn.rules.reset': () => {
    S.draft.custom.playRuleItems = null;
    psnRulesTouch();
    paintPage(false);
  },
};

async function bridgeCmd(cmd) {
  if (!S.online) return DEMO_BLOCK();
  try {
    const r = await post('/api/bridge/command', { cmd });
    toastResult(r, `已下发 ${cmd}，等机器人取走`);
    await refresh(true);
  } catch (e) { toast(`下发失败：${e.message}`, 'bad'); }
}
/**
 * 切模型（2026-10-17 · 维护者第三轮）：**先改界面，再等后端**。
 *
 * ⚠️ 为什么必须乐观：`/api/switch` 会等机器人热重载确认（`waitEffectiveApplied`，
 *    最长 12 秒）才返回。这十几秒里如果界面一动不动，用户看到的就是"点了没反应" ——
 *    而实际情况是"正在切"。（维护者给的那张截图就是这个窗口：横幅还写着 DeepSeek、
 *    选中的千问挂着「待生效」。）
 *
 * ⚠️ 失败必须**回滚**：否则"切失败了、界面却显示切成功"就是本项目最忌的那种
 *    「失败伪装成成功」。回滚的是内存里的 state，盘上由后端负责（它没写就是没写）。
 */
async function switchBrain(target, id = '') {
  // 自定义大脑要带上"是哪一套" —— 内置那几套靠 target 就够了。
  const undone = patchPick(target, id);
  busy(true, `切到 ${target} …`);
  try {
    const r = await post('/api/switch', id ? { target, id } : { target });
    if (Array.isArray(r.steps)) S.state.__steps = r.steps.map((x) => `· ${typeof x === 'string' ? x : x.msg || JSON.stringify(x)}`);
    toastResult(r, '已切换');
    await refresh(true);
    // ★ 切换成功后**顺带**把新服务商的模型清单读出来（用户报的 bug：不点「读取」
    //   下拉里就只剩当前那一个）。静默执行 —— 拉不到不算切换失败。
    await refreshModelsAfterSwitch();
  } catch (e) {
    if (undone) { Object.assign(S.state.config, undone); paintPage(false); }
    toast(`切换失败：${e.message}`, 'bad');
  } finally { busy(false); }
}

/**
 * 把「刚点了哪一套」立刻写进**页面用的那份 state**（`S.state`，纯内存、不落盘）。
 *
 * 只做自定义大脑：内置预设（本机 / 智谱 / 千问）那几套的扁平值由后端算
 * （地址、Key、降级链、上下文长度都要一起换），前端照抄一份就是第二份会漂的规则。
 *
 * @returns {object|null} 回滚用的旧值；null = 这次没法乐观更新（按原样等后端）
 */
function patchPick(target, id) {
  if (target !== 'custom' || !S.online) return null;
  const cfg = S.state && S.state.config;
  const b = (cfg?.customBrains || []).find((x) => x.id === id);
  if (!cfg || !b) return null;
  const before = {
    activeCustomId: cfg.activeCustomId,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    provider: cfg.provider,
    fallbackModels: cfg.fallbackModels,
  };
  cfg.activeCustomId = b.id;
  cfg.model = b.model;
  cfg.baseUrl = b.baseUrl;
  // 服务商由后端算好下发（`brain.provider` 就是 `providerOf(baseUrl)` 的结论），
  // 前端不按域名重算 —— 那会变成第二份「哪家算千问」的规则。
  cfg.provider = b.provider || cfg.provider;
  cfg.fallbackModels = Array.isArray(b.fallbackModels) ? [...b.fallbackModels] : [];
  /* ⚠️ 有未保存的改动 / 正在输入时**不重画**：那会把输入框连同里面的字一起重建
     （`softPaint` 的守卫是同一个理由）。这种情况下界面会在下一次刷新对齐。 */
  if (!busyTyping() && dirtyKeys() === 0) paintPage(false);
  return before;
}

/* ═══ 自定义大脑（2026-10-07）═════════════════════════════════════════════
   用户自己填地址 / 密钥 / 模型名，能存好多套，右键可改名或删除。
   ⚠️ 表单里的值一律**直接读 DOM**（`[data-bf]`），不进 `S.volatile`：
      它是"填完就提交"的一次性表单，走 draft/保存条那套反而会多出一个
      "未保存改动"的假信号（而这套数据本来就存在 config.json 里，不是草稿）。
   ═══════════════════════════════════════════════════════════════════════ */
function bfVal(k) {
  const el = document.querySelector(`[data-bf="${k}"]`);
  return el ? String(el.value || '').trim() : '';
}
function bfChecked(k) {
  const el = document.querySelector(`[data-bf="${k}"]`);
  return !!(el && el.checked);
}
function brainById(id) {
  return (j(S.state, ['config', 'customBrains'], []) || []).find((b) => b.id === id) || null;
}

/**
 * 已知服务商的「接口地址 → 默认模型」，给自定义大脑表单做一键填入。
 *
 * ⚠️ 值**一律来自 `state.config.presets`** —— 那是服务端 `panel/lib/models.js` 的
 *    `CLOUD_PRESETS` 经 `readPresets()` 下发的。前端**不抄第二份地址或模型名**：
 *    那张表改了，这里自动跟着改（本项目"唯一实现"那条纪律的直接应用）。
 *
 * 存在的理由（2026-10-10 · 真机翻车记录）：用户报「群里 @ 了机器人不回」。
 * 根因是他把 **DeepSeek 控制台的密钥管理网页** `https://platform.deepseek.com/api_keys`
 * 当成接口地址填了进来 ⇒ 每条消息 `HTTP 405 Method Not Allowed`。
 * 表单原来只写了一句「要填 API 地址，不是控制台网页」——**说了不是什么，没说是什么**，
 * 用户照样不知道该复制哪个。所以这里把每家的正确地址直接摆出来 + 一点即填。
 */
function brainPresetRows() {
  const presets = j(S.state, ['config', 'presets'], {}) || {};
  return Object.entries(presets)
    .filter(([, p]) => p && String(p.baseUrl || ''))
    .map(([key, p]) => ({
      key,
      label: String(p.label || key),
      baseUrl: String(p.baseUrl),
      model: String(p.model || ''),
    }));
}

/* 添加 / 编辑自定义模型（2026-10-17 加「云端 ⇄ 本地」切换）。
   ⚠️ 两种形态**填的东西不一样**：云端要接口地址 + Key + 模型名；本地不要 Key，
      地址是本地推理服务（LM Studio / llama.cpp / MLX）的 `/v1`。
      以前只有云端一套字段，本地用户只能硬填 —— 现在按模式换字段，
      并在标题右侧摆一个「切换到本地模型 / 切换到云端」的标签（维护者点名的位置）。 */
function brainForm(id, draft = null) {
  const b = brainById(id);
  const mode = draft?.mode || (b?.provider === 'local' ? 'local' : 'cloud');
  const cloud = mode === 'cloud';
  const v = {
    name: draft ? draft.name : (b?.name || ''),
    baseUrl: draft ? draft.baseUrl : (b?.baseUrl || ''),
    model: draft ? draft.model : (b?.model || ''),
    apiKey: draft ? draft.apiKey : '',
  };
  const f = draft?.features || b?.features || {};
  const chk = (k, label, hint) => `<label class="row flat f-inline" style="gap:8px;">
      <input type="checkbox" data-bf="${k}" ${f[k] === true ? 'checked' : ''}>
      <span class="grow">${label}</span><span class="hint">${hint}</span></label>`;

  // 「接口地址 → 默认模型」的一键填入清单（**只在云端模式**下有意义）。
  // ⚠️ 值全部来自 `state.config.presets`（服务端 `panel/lib/models.js` 的 CLOUD_PRESETS 下发的那份），
  //    前端不抄第二份地址 / 模型名 —— 那张表改了这里自动跟着改。
  const rows = cloud ? brainPresetRows() : [];
  const fillHint = rows.length ? `<div class="hint" style="margin-top:8px;">
      常见服务商（点「填入」= <b>接口地址与默认模型一起写好</b>，模型可以再改）：
      <div style="margin-top:4px;">${rows.map((r) => `<div class="row flat" style="gap:8px;align-items:center;flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" data-bf-fill="${esc(r.key)}">填入</button>
          <code>${esc(r.baseUrl)}</code>${r.model ? `<span class="hint"> → ${esc(r.model)}</span>` : ''}
        </div>`).join('')}</div>
      <div style="margin-top:6px;">
        ⚠️ 要的是<b>接口地址</b>，不是控制台网页 —— 浏览器地址栏里那种
        <code>platform.…/api_keys</code> <code>…/usage</code> <code>…/dashboard</code> 都不是接口地址。
        <b>填错的表现</b>：群里 @ 它不回，日志里写 <code>模型调用失败 … HTTP 405 / 404</code>
        （日志在 <code>app\\panel\\bridge.log</code>）。
        自建 / 中转网关填你自己的地址，不受这张表约束。
      </div>
    </div>` : '';

  const localHint = !cloud ? `<div class="hint" style="margin-top:8px;">
      本地模型：先把推理服务开起来（LM Studio / llama.cpp / MLX / QwenChat 都行），
      地址填它的 <code>/v1</code> 接口（默认 <code>http://127.0.0.1:8080/v1</code>）。
      <b>不需要 API Key</b>，也不产生费用；模型名带 <code>VL</code> 的才能看图。
    </div>` : '';

  const html = `<div class="f">
    <input type="hidden" data-bf="mode" value="${mode}" />
    <input type="text" data-bf="name" value="${esc(v.name)}" placeholder="名字，例如「公司网关」${cloud ? '' : ' / 「本机 Qwen」'}" />
    <input type="text" data-bf="baseUrl" value="${esc(v.baseUrl || (cloud ? '' : 'http://127.0.0.1:8080/v1'))}" placeholder="${cloud
      ? '接口地址 https://…（要填 API 地址，不是控制台网页）'
      : '本地服务地址，例如 http://127.0.0.1:8080/v1'}" />
    <!-- 按地址识别厂商（2026-10-17）：填完地址就告诉你是哪家、备用链会填几条、额度去哪看 -->
    <div class="hint" data-bf-info style="margin:0;"></div>
    ${cloud ? `<input type="password" data-bf="apiKey" value="${esc(v.apiKey)}" placeholder="${b?.hasKey ? '已保存过，留空则不改' : 'API Key'}" />` : ''}
    <input type="text" data-bf="model" value="${esc(v.model)}" placeholder="${cloud
      ? '模型名，例如 gpt-4o-mini'
      : '本地服务里加载的模型名，例如 qwen3.5-vl-7b-instruct'}" />
    ${fillHint}${localHint}
    <div class="hint" style="margin-top:6px;">它能做什么（勾了才生效，界面上也<b>只显示勾过的</b>）：</div>
    ${chk('vision', '能看图', '勾了才会把群里的图片发给它')}
    ${chk('thinking', '能思考', '勾了才带思考参数；服务端不认会自动去掉重发，不会卡住')}
    ${cloud ? chk('webSearch', '能联网', '勾了才带联网工具 —— 只有支持智谱那套形状的服务商认') : ''}
  </div>`;
  // 切换标签的文案 = **点一下会去哪个模式**（维护者原话：现在云端就写"切换到本地模型"）。
  const head = `<button class="btn btn-ghost btn-sm" data-a="brain.mode" data-p="${esc(id || '')}"
    title="${cloud ? '改成填本地推理服务的地址（不需要 Key）' : '改成填云端 API 地址（需要 Key）'}">${cloud ? '切换到本地模型' : '切换到云端'}</button>`;
  modal(id ? `改设置：${b?.name || ''}` : '添加自定义模型', html, [
    { label: '取消' },
    { label: '保存', style: 'btn-primary', run: () => brainFormSubmit(id) },
  ], head);
  mountBrainProbe();
}

/**
 * 表单里的「按地址识别厂商」（2026-10-17 · 维护者点名）。
 *
 * 输入地址 → 300ms 防抖 → `GET /api/provider-info` → 一行结论：
 * 「识别为 千问云端 · 备用链 7 条（保存时自动填）· 额度官网」。
 *
 * ⚠️ 判据**不在前端**：哪家、默认链、额度页全部来自后端（`providerOf` / `defaultChainOf` /
 *    `quotaPlanOf` 的唯一实现）。前端只负责显示 —— 再写一份域名判断必然漂。
 * ⚠️ 用 `seq` 丢掉"先发后到"的旧响应：用户连续改地址时，慢的那次不能盖掉新的。
 */
function mountBrainProbe() {
  const el = document.querySelector('[data-bf="baseUrl"]');
  const box = document.querySelector('[data-bf-info]');
  if (!el || !box || !S.online) return;
  let timer = null;
  let seq = 0;
  const run = async () => {
    const raw = String(el.value || '').trim();
    if (!raw) { box.innerHTML = ''; return; }
    const my = ++seq;
    box.innerHTML = '<span class="hint" style="margin:0;">识别中…</span>';
    try {
      const r = await api(`/api/provider-info?baseUrl=${encodeURIComponent(raw)}`);
      if (my !== seq) return;
      const model = String(document.querySelector('[data-bf="model"]')?.value || '').trim();
      const backup = (r.chain || []).filter((m) => m !== model);
      const bits = [`识别为 <b>${esc(r.vendor)}</b>`];
      if (backup.length) bits.push(`备用链 ${backup.length} 条（保存时自动填）`);
      if (r.quota?.controlUrl) {
        bits.push(`<a href="${safeHref(r.quota.controlUrl)}" target="_blank" rel="noreferrer">额度官网</a>`);
      }
      if (r.quota?.mustDo) bits.push('<span class="tag warn">有个开关要自己开</span>');
      box.innerHTML = `<span class="hint" style="margin:0;">${bits.join(' · ')}</span>`;
    } catch (e) {
      if (my === seq) box.innerHTML = `<span class="hint bad" style="margin:0;">${esc(e.message)}</span>`;
    }
  };
  el.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 350); });
  run();  // 编辑已有大脑时，打开就该看到结论
}

async function brainFormSubmit(id) {
  const mode = bfVal('mode') === 'local' ? 'local' : 'cloud';
  const baseUrl = bfVal('baseUrl');
  const model = bfVal('model');
  if (!baseUrl || !model) return toast(mode === 'local' ? '本地服务地址和模型名都要填' : '接口地址和模型名都要填', 'warn');
  busy(true, '保存中…');
  try {
    const r = await post('/api/custom-brain/save', {
      id: id || '', name: bfVal('name'), baseUrl, model,
      // 本地模型不需要 Key —— 明确发空串，避免把上一个模式的 Key 带进来。
      apiKey: mode === 'cloud' ? bfVal('apiKey') : '',
      features: {
        vision: bfChecked('vision'),
        thinking: bfChecked('thinking'),
        // `web_search` 是智谱那套形状；本地服务收到必然 400，所以本地模式不发。
        webSearch: mode === 'cloud' ? bfChecked('webSearch') : false,
      },
    });
    closeModal();
    toastResult(r, '已保存');
    await refresh(true);
  } catch (e) { toast(`保存失败：${e.message}`, 'bad'); }
  finally { busy(false); }
}

function brainRename(id) {
  const b = brainById(id);
  if (!b) return toast('这套已经不在了', 'warn');
  closeModal();
  modal('改名字', `<div class="f"><input type="text" data-bf="name" value="${esc(b.name)}" /></div>`, [
    { label: '取消' },
    { label: '改', style: 'btn-primary', run: async () => {
      const name = bfVal('name');
      if (!name) return toast('名字不能为空', 'warn');
      try { const r = await post('/api/custom-brain/rename', { id, name }); closeModal(); toastResult(r, '已改名'); await refresh(true); }
      catch (e) { toast(`改名失败：${e.message}`, 'bad'); }
    } },
  ]);
}

function brainDelete(id) {
  const b = brainById(id);
  if (!b) return toast('这套已经不在了', 'warn');
  closeModal();
  const using = j(S.state, ['config', 'activeCustomId'], '') === id;
  modal(`删除「${b.name}」？`, `<div class="hint">${using
    ? '它<b>正在被使用</b>，删掉之后会自动切回智谱。'
    : '只是删掉这一套配置，当前在用的不受影响。'}</div>`, [
    { label: '不删' },
    { label: '删除', style: 'btn-danger', run: async () => {
      try { const r = await post('/api/custom-brain/delete', { id }); closeModal(); toastResult(r, '已删除'); await refresh(true); }
      catch (e) { toast(`删除失败：${e.message}`, 'bad'); }
    } },
  ]);
}

/* ── 右键浮层（2026-10-20 · 只改**呈现层**）─────────────────────────────
   原来右键大脑标签弹的是**居中 modal**（信息 + 三个动作）。现在弹在**光标锚点旁**，
   信息与三个动作一字不改。数值规格借自 bencho 的 SortMenu：
   `transform-origin: 100% 0`、入场关键帧**只写 from**（其余交给浏览器插值）、时长档 160/180/220ms。
   ⚠️ bencho **无公开仓库、无许可声明** ⇒ 只借数值，**未取任何代码行**。
   ⚠️ 浮层挂在 `document.body` 上（`position: fixed`）：它不参与 `#page` 的 3 秒重建，
      但**重建后目标节点可能已被换掉** ⇒ 动作只认打开时捕获的 `b.id`，不回头查 DOM。
   ⚠️ 关闭路径必须齐：点外部 / Escape / 滚动 / 尺寸变化 / 页面重建 —— 漏任何一个都会
      "菜单飘在屏幕上关不掉"，而且没有任何报错。 */
let ctxMenu = null;

function closeCtxMenu() {
  if (!ctxMenu) return;
  ctxMenu.remove();
  ctxMenu = null;
}

function openCtxMenu(ev, title, info, items) {
  closeCtxMenu();
  const m = document.createElement('div');
  m.className = 'ctxmenu';
  m.setAttribute('role', 'menu');
  m.setAttribute('aria-label', title);
  m.innerHTML = `<div class="ctx-h">${esc(title)}</div>`
    + (info ? `<div class="ctx-i">${info}</div>` : '')
    + items.map((it, i) => `<button role="menuitem" type="button" data-ci="${i}" class="btn ${it.style || 'btn-ghost'}">${esc(it.label)}</button>`).join('');
  document.body.appendChild(m);
  /* 先量后夹：直接按 clientX/Y 放会在右下角溢出视口（菜单一半在屏幕外，且看不出来是 bug）
     ⚠️ 量的是 `offsetWidth/offsetHeight`（布局尺寸），**不是** `getBoundingClientRect()` ——
        入场关键帧带 `scale(.96)`，而 rect 会把动画的缩放算进去 ⇒ 量小约 4%，
        动画结束菜单比算出来的大，右/下边缘就会溢出（真机实测溢出 4px）。 */
  const mw = m.offsetWidth, mh = m.offsetHeight;
  const pad = 8;
  m.style.left = `${Math.max(pad, Math.min(ev.clientX, window.innerWidth - mw - pad))}px`;
  m.style.top = `${Math.max(pad, Math.min(ev.clientY, window.innerHeight - mh - pad))}px`;
  m.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ci]');
    if (!btn) return;
    const it = items[Number(btn.dataset.ci)];
    closeCtxMenu();
    it.run();
  });
  ctxMenu = m;
  const first = m.querySelector('[data-ci]');
  if (first) first.focus({ preventScroll: true });
}

document.addEventListener('pointerdown', (e) => {
  if (ctxMenu && !ctxMenu.contains(e.target)) closeCtxMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCtxMenu();
});
window.addEventListener('scroll', () => closeCtxMenu(), { passive: true, capture: true });
window.addEventListener('resize', () => closeCtxMenu());

/* 右键菜单：**委托在 document 上** —— 列表每 3 秒重绘一次，
   绑在按钮节点上会在第一次重绘后就失效（而症状只是"右键没反应"，看不出原因）。 */
document.addEventListener('contextmenu', (ev) => {
  const el = ev.target && ev.target.closest ? ev.target.closest('[data-brain]') : null;
  if (!el) return;
  const b = brainById(el.dataset.brain || '');
  if (!b) return;
  ev.preventDefault();
  openCtxMenu(ev, `「${b.name}」`, `<div class="rows">
      <div class="row flat"><span class="grow">模型</span><span class="mono">${esc(b.model)}</span></div>
      <div class="row flat"><span class="grow">接口</span><span class="mono">${esc(b.baseUrl)}</span></div>
      <div class="row flat"><span class="grow">密钥</span><span>${b.hasKey ? '已填' : '<b>还没填</b>'}</span></div>
    </div>`, [
    { label: '改名字', run: () => brainRename(b.id) },
    { label: '改设置', run: () => brainForm(b.id) },
    { label: '删除', style: 'btn-danger', run: () => brainDelete(b.id) },
  ]);
});
function stepsOf(r) {
  if (Array.isArray(r?.steps)) {
    S.state.__steps = r.steps.map((x) => `· ${typeof x === 'string' ? x : x.msg || JSON.stringify(x)}`);
    paintPage(false);
  }
}
async function waitPanelPid(before) {
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    try { const st = await api('/api/state'); if (st.panel?.pid && st.panel.pid !== before) { S.state = st; S.online = true; paintTop(); paintPage(false); toast('面板已换到新进程', 'ok'); return; } } catch { /* 正在重启，正常 */ }
  }
  toast('等了几十秒还没回来，点右上角重开一次控制台', 'warn');
}
async function openTab(path, title, asModal) {
  if (asModal) return openQrModal();
  window.open(path, '_blank');
  return undefined;
}

/**
 * 「打开二维码登录」的弹窗（2026-10-12 · 真机修正）。
 *
 * ⚠️ 为什么要**先探一次**、而不是直接把 `<img src=/api/qrcode>` 摆上去：
 *    取不到时接口回的是 404 + 一段**给人看的说明**，而 `<img>` 只会把它渲染成一个
 *    裂图标 —— 用户看到的就是"二维码坏了"，我们看到的是一张什么都没有的截图。
 *    现在：探不到就把那段说明**显示出来**，并给一个能立刻解决问题的按钮。
 *
 * ⚠️ 为什么要自动换图：二维码约 2 分钟就失效，而这张弹窗可能开着不动。
 *    每 5 秒重取一次，用户扫的时候手上那张**一定是新的**。
 *    （自清理：找不到那个 img 元素就停表 —— 弹窗被关掉时不会留下一个空转的定时器。）
 */
let qrTimer = null;
// 弹窗的"上一次状态"，用来判断要不要真的动 DOM（不动 = 不闪）
let qrLastUrl = '';
let qrLastMsg = '';

/**
 * 换一张二维码 —— 成功/失败都把后端那句话原样告诉用户。
 *
 * ⚠️ 两条来自真机资料的规矩（2026-10-13）：
 *  ① 后端的 msg 必须显示出来（以前吞掉了，用户只看到"失败"两个字）；
 *  ② `degrade`（够不着协议端）时**把盘上当前那张码打开**，别让用户手里空着 ——
 *     而"已登录 / 凭证不符"这类是业务拒绝，不该也去开一张空图。
 */
async function doQrRefresh() {
  let r = null;
  try {
    r = await post('/api/qrcode/refresh');
  } catch (e) {
    toast(`换码失败：${e.message}`, 'bad');
    return;
  }
  if (r && r.ok) {
    toastResult(r, '已换一张新码');
    return;
  }
  const msg = (r && r.msg) || '换码失败（后端没给原因）';
  toast(msg.split('\n')[0], 'bad');
  if (r && r.degrade && typeof openTab === 'function') openTab('/api/qrcode', '二维码', true);
}
async function openQrModal() {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
  qrLastUrl = '';
  qrLastMsg = '';

  const grab = async () => {
    try {
      const r = await fetch(`/api/qrcode?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return { ok: false, msg: (await r.text() || '').trim() || `HTTP ${r.status}` };
      const blob = await r.blob();
      if (!blob.size) return { ok: false, msg: '取到的是一张空图' };
      return { ok: true, url: URL.createObjectURL(blob) };
    } catch (e) {
      return { ok: false, msg: e.message };
    }
  };

  const paint = async () => {
    const got = await grab();
    const box = document.querySelector('[data-qr]');
    if (!box) return;
    if (got.ok) {
      // ⚠️ 闪烁修复（2026-10-13 真机反馈："二维码页面时不时会闪烁"）：
      //    以前每次轮询都整块 `innerHTML =` ⇒ `<img>` 被销毁重建 ⇒ 肉眼可见的闪。
      //    现在：**第一次**搭骨架，之后只换 `img.src`（同一个元素，浏览器原地换图，不闪）。
      //    旧 blob URL 及时 revoke，免得开着几分钟泄漏一堆对象 URL。
      let im = box.querySelector('img[data-qr-img]');
      if (!im) {
        box.innerHTML = `<img data-qr-img alt="登录二维码" style="width:min(360px,100%);display:block;margin:0 auto;">
          <div class="hint" style="text-align:center;margin-top:10px;">用<b>机器人小号</b>的手机 QQ 扫这张码。约 2 分钟换一张，这里会自动换新的。</div>`;
        im = box.querySelector('img[data-qr-img]');
        // ⚠️ 裂图兜底（2026-10-13 真机截图驱动）："取到了数据"与"显示得出来"是两件事 ——
        //    CSP 拦 blob: 那次就是数据到了、图是裂的，而用户看到裂图只会以为没换成功。
        //    所以解码失败要单独说一句，并把锅指向"重试/看日志"这两条能走的路。
        im.onerror = () => {
          box.innerHTML = `<div class="empty" style="white-space:pre-wrap;">取到了二维码数据，但浏览器没能把它显示出来。\n点「重试」再取一次；反复这样就看「终端」页的协议端日志（二维码也在里面）。</div>`;
        };
      }
      if (qrLastUrl) { try { URL.revokeObjectURL(qrLastUrl); } catch { /* 已失效无所谓 */ } }
      qrLastUrl = got.url;
      im.src = got.url;
    } else {
      // 失败态：文案没变就**不重写**（重写同样的字也会让页面抖一下）
      const text = got.msg;
      if (qrLastMsg !== text) {
        qrLastMsg = text;
        box.innerHTML = `<div class="empty" style="white-space:pre-wrap;">${esc(text)}</div>`;
      }
    }
  };

  modal('登录二维码', '<div data-qr><div class="empty">正在取二维码…</div></div>', [
    { label: '重试', run: async () => { await paint(); } },
    { label: '重启协议端', run: async () => { await ACTIONS['napcat.restart'](); await paint(); } },
    // ⚠️ 换码失败也要把**后端那句原因**送到用户眼前（2026-10-13 · 群友真机资料）：
    //    以前这里吞掉返回值，用户只看到一句"已换一张新码"或"失败"，
    //    而真正的原因（连不上 WebUI / 这个号已登录 / 协议端没运行）一个字都看不到。
    { label: '换一张', run: async () => { await doQrRefresh(); await paint(); } },
    // ⚠️ 不传「关闭」：modal() 每次都会自动补一个 ghost「关闭」（见 modal() 末尾），
    //    这里再传一个就成了两个（2026-10-13 真机截图确认的 UI 缺陷）。
  ]);
  await paint();
  // 自动换图 + 自清理（找不到节点就停）
  qrTimer = setInterval(() => {
    if (!document.querySelector('[data-qr]')) { clearInterval(qrTimer); qrTimer = null; return; }
    paint();
  }, 5000);
}
function draftArr(path) {
  let a = getPath(S.draft.custom, path);
  if (!Array.isArray(a)) {
    const cur = getPath(S.state?.custom, path);
    a = Array.isArray(cur) ? JSON.parse(JSON.stringify(cur)) : [];
    setPath(S.draft.custom, path, a);
  }
  return a;
}
/**
 * 把当前草稿的人格 / 增强 / 场景拍成一张角色卡快照。
 * 形状与后端 `cardFields()`（src/custom-config.js）逐字对齐：人格 12 + 增强 12 + scenes。
 * 键名一律从 `customMeta` 取（前端不自存任何一份名单）。
 */
function snapshotPersonaFields() {
  const meta = (S.state || DEMO).customMeta || {};
  const personaKeys = meta.personaKeys || [];
  const enhanceKeys = meta.enhanceKeys || meta.enhance?.keys || [];
  const out = {};
  for (const k of personaKeys) out[k] = String(getPath(S.draft.custom, `persona.${k}`) ?? '');
  for (const k of enhanceKeys) out[k] = String(getPath(S.draft.custom, `enhance.${k}`) ?? '');
  out.scenes = {};
  for (const k of Object.keys(meta.scenes || {})) out.scenes[k] = String(getPath(S.draft.custom, `scenes.${k}`) ?? '');
  return out;
}
/**
 * 把当前人格 / 增强 / 场景重新拍进一张已有的角色卡。
 * 新建时已经拍过一次；这个按钮是给"改完人格后更新卡"用的。
 */
function snapPersonaCard(i) {
  const sk = draftArr('skills')[i];
  if (!sk) return;
  sk.fields = snapshotPersonaFields();
  touchC('skills'); markDirty(); paintPage(false);
  toast('已把当前人格 / 增强 / 场景存进这张卡 —— 记得保存', 'ok');
}

/** 卡里全部可读文字（AI 认领的素材）。 */
function cardTextOf(sk) {
  const parts = [
    sk?.name,
    sk?.background,
    ...(Array.isArray(sk?.examples) ? sk.examples : []),
    ...Object.values(sk?.fields || {}),
  ];
  return parts.map((x) => String(x || '').trim()).filter(Boolean).join('\n');
}

/**
 * 「写进这张卡」：把这一维的答案追加进卡字段，立刻保存并重新分级。
 * 只追加用户自己写的一句话；机器搬来的内容走 `applyAdopt`，只填空字段。
 */
function fillCardDim(p) {
  const [i, dimId] = String(p || '').split('|');
  const g = (j(S.state || DEMO, ['personaCards'], []) || [])[Number(i)];
  if (!g) return toast('没找到这张卡（可能刚被删了，刷新一下）', 'warn');
  const input = document.querySelector(`[data-a="cg.fill"][data-p="${i}|${dimId}"]`);
  const text = String((input && input.value) || '').trim();
  if (!text) return toast('先写一句话再点', 'warn');
  const arr = draftArr('skills');
  const idx = arr.findIndex((sk) => sk.kind === 'persona' && ((g.id && sk.id === g.id) || sk.name === g.name));
  if (idx < 0) return toast('草稿里没有这张卡（可能刚被删了，刷新一下）', 'warn');
  const gap = (g.gaps || []).find((x) => x.id === dimId) || {};
  const key = gap.field || '';
  if (!key) return toast('这一维没有可写的字段', 'warn');
  const cur = String(arr[idx].fields?.[key] || '').trim();
  arr[idx].fields = { ...(arr[idx].fields || {}), [key]: cur ? `${cur} ${text}` : text };
  touchC('skills'); markDirty();
  toast(`已写进「${gap.label || dimId}」的 ${key}`, 'ok');
  return commitDraft();
}

/** 「AI 认领」：模型按十维归位，先预览，用户点确认才写；只填空字段。 */
async function adoptCard(i) {
  if (!S.online) return DEMO_BLOCK();
  const g = (j(S.state || DEMO, ['personaCards'], []) || [])[Number(i)];
  if (!g) return toast('没找到这张卡（可能刚被删了，刷新一下）', 'warn');
  const arr = draftArr('skills');
  const idx = arr.findIndex((sk) => sk.kind === 'persona' && ((g.id && sk.id === g.id) || sk.name === g.name));
  if (idx < 0) return toast('草稿里没有这张卡（可能刚被删了，刷新一下）', 'warn');
  const sk = arr[idx];
  const text = cardTextOf(sk);
  if (text.length < 20) return toast('这张卡里只有名字，没有可认领的文字 —— 先把内容填进背景或示例', 'warn');
  busy(true, 'AI 认领中（一次模型调用，约 5–30 秒）…');
  try {
    const r = await api('/api/persona/adopt', {
      method: 'POST',
      body: { name: sk.name, text, fields: sk.fields || {} },
      timeout: 160000,
    });
    const wrote = Array.isArray(r.wrote) ? r.wrote : [];
    if (!wrote.length) throw new Error('这一趟没认出任何一维');
    S.extra.adopt = { idx, wrote };
    modal('AI 认领预览', `
      <p class="hint">模型只从卡里已有的文字里搬，素材没提到的维度它留空。<b>只填这张卡里还空着的字段</b>，你已经写过的内容一律不动。</p>
      <div class="rows">${wrote.map((w) => {
        const already = String((sk.fields || {})[w.field] || '').trim();
        return `<div class="row flat">
        <div class="row-h"><b>${esc(w.label)}</b><span class="spacer"></span>
          <span class="mono hint">→ ${esc(w.field)} · ${w.chars} 字</span>
          ${already ? '<span class="tag warn">已有内容，会跳过</span>' : ''}</div>
        <div class="hint">${esc(w.text)}</div>
      </div>`;
      }).join('')}</div>
      ${Array.isArray(r.missing) && r.missing.length ? `<p class="hint">没认出来的维度：${esc(r.missing.join('、'))} —— 素材里可能确实没写，别硬补。</p>` : ''}
    `, [{ label: '写进这张卡', style: 'btn-primary', run: applyAdopt }]);
  } catch (e) { toast(`认领失败：${e.message}`, 'bad'); } finally { busy(false); }
}

function applyAdopt() {
  const a = S.extra.adopt;
  S.extra.adopt = null;
  if (!a) return closeModal();
  const sk = draftArr('skills')[a.idx];
  if (!sk) return closeModal();
  const fields = { ...(sk.fields || {}) };
  let n = 0;
  for (const w of a.wrote) {
    if (String(fields[w.field] || '').trim()) continue; // 已有内容的不覆盖
    fields[w.field] = w.text;
    n++;
  }
  sk.fields = fields;
  if (!n) { closeModal(); return toast('这些字段本来就有内容，一个都没覆盖', 'warn'); }
  touchC('skills'); markDirty(); closeModal();
  toast(`已认领 ${n} 个字段 —— 保存后重新分级`, 'ok');
  return commitDraft();
}

function addSkill(kind) {
  // ⚠️ 建**角色卡**时快照当前人格（2026-10-15 · B4 / Issue #5）：
  //    面板上没有任何地方能编辑卡内字段，不快照的话新建出来就是一张永远填不进去的
  //    空卡（`.fields` 恒为 undefined，"套用"直接劝退）。快照 = 让"存多张卡、一键换人"
  //    这个功能真的成立，也顺带给「场景」一个来源（否则卡里永远没有 scenes）。
  const fields = kind === 'persona' ? snapshotPersonaFields() : undefined;
  draftArr('skills').push({ id: `k${Date.now().toString(36)}`, kind, name: kind === 'persona' ? '新角色卡' : '新知识包',
    enabled: true, scope: { type: 'global', id: '' }, triggers: [], background: '', examples: [],
    ...(fields ? { fields } : {}) });
  touchC('skills'); markDirty(); paintPage(false);
  if (fields) toast('已新建角色卡（快照了当前人格 / 增强 / 场景）—— 记得点底部「保存并生效」', 'ok');
}
function applyPersonaCard(i) {
  const sk = draftArr('skills')[i];
  if (!sk?.fields) return toast('这张卡没有存人格快照，套用不了', 'warn');
  const meta = (S.state || DEMO).customMeta || {};
  const personaKeys = new Set(meta.personaKeys || []);
  const enhanceKeys = new Set(meta.enhanceKeys || meta.enhance?.keys || []);
  const sceneKeys = Object.keys(meta.scenes || {});
  // 归属名单缺失（老面板缓存）时退回老行为：一律写 persona.*。
  // 宁可"增强项没换"也不要"整张卡一点没生效"——后者是完全静默的假成功。
  const hasRouting = personaKeys.size > 0 || enhanceKeys.size > 0;
  let nP = 0, nE = 0, nS = 0;
  for (const k of Object.keys(sk.fields)) {
    if (k === 'scenes') {
      // 场景是**单份全局状态**、卡里存的是快照。只有卡里真的存过（非空）才覆盖 ——
      // 卡里没存就原样留着，绝不把当前场景整片清空（那比"没换"更糟：静默丢用户填的东西）。
      const snap = sk.fields.scenes && typeof sk.fields.scenes === 'object' ? sk.fields.scenes : {};
      if (Object.keys(snap).some((x) => String(snap[x] || '').trim())) {
        for (const key of sceneKeys) setPath(S.draft.custom, `scenes.${key}`, String(snap[key] ?? ''));
        nS = sceneKeys.length;
      }
      continue;
    }
    if (!hasRouting) { setPath(S.draft.custom, `persona.${k}`, sk.fields[k]); nP += 1; continue; }
    if (personaKeys.has(k)) { setPath(S.draft.custom, `persona.${k}`, sk.fields[k]); nP += 1; }
    else if (enhanceKeys.has(k)) { setPath(S.draft.custom, `enhance.${k}`, sk.fields[k]); nE += 1; }
  }
  touchC('persona');
  if (nE) touchC('enhance');
  if (nS) touchC('scenes');
  markDirty(); paintPage(false);
  toast(`已套用（人格 ${nP} 项 / 增强 ${nE} 项${nS ? ` / 场景 ${nS} 项` : ''}）—— 记得点底部的「保存并生效」`, 'ok');
}
function balanceText(r) {
  if (!r || typeof r !== 'object') return '—';
  const v = r.total ?? r.balance ?? r.left ?? null;
  return v == null ? '—' : String(v);
}
async function doExportSelected(scopes) {
  if (!S.online) return DEMO_BLOCK();
  const ids = [...new Set((scopes || []).filter((x) => typeof x === 'string' && x))];
  if (!ids.length) return toast('先选至少一项再导出', 'warn');
  busy(true, '打包中…');
  try {
    const q = ids.map(encodeURIComponent).join(',');
    const r = await fetch(`/api/custom/export?what=selected&format=zip&mask=1&scopes=${q}`,
      HAS_TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : {});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `qqbot-selected-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已开始下载所选数据', 'ok');
  } catch (e) { toast(`导出失败：${e.message}`, 'bad'); } finally { busy(false); }
}

async function doExport(what, forceFmt = '') {
  if (!S.online) return DEMO_BLOCK();
  const fmt = forceFmt || S.volatile['ex.fmt'] || 'json';
  const mask = S.volatile['ex.mask'] === false ? '0' : '1';
  busy(true, '打包中…');
  try {
    const r = await fetch(`/api/custom/export?what=${what}&format=${fmt}&mask=${mask}`, HAS_TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : {});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `qqbot-${what}-${new Date().toISOString().slice(0, 10)}.${fmt}`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已开始下载', 'ok');
  } catch (e) { toast(`导出失败：${e.message}`, 'bad'); } finally { busy(false); }
}
async function applyImport() {
  const payload = S.extra.importPayload;
  if (!payload) return toast('没有待导入的内容', 'warn');
  Object.assign(S.draft.custom, payload);
  for (const k of Object.keys(payload)) touchC(k);
  markDirty(); closeModal(); paintPage(false);
  toast('已载入页面，检查无误后点底部的「保存并生效」', 'ok');
}
async function previewImport(file) {
  if (!S.online) return DEMO_BLOCK();
  let obj;
  try { obj = JSON.parse(await file.text()); } catch (e) { return toast(`不是合法 JSON：${e.message}`, 'bad'); }
  const custom = obj.custom && typeof obj.custom === 'object' ? obj.custom : obj;
  busy(true, '比对差异…');
  try {
    const r = await post('/api/custom/preview', { custom });
    S.extra.importPayload = custom;
    const rows = (r.changes || []).map((c) => `<div class="row flat"><span class="mono">${esc(c.key || c)}</span><span class="spacer"></span><span>${esc(String(c.to ?? c.value ?? ''))}</span></div>`).join('');
    const lists = (r.lists || []).map((l) => `<div class="row flat"><span>${esc(l.label || l.key)}</span><span class="spacer"></span><span>+${l.added ?? 0} / -${l.removed ?? 0} / ~${l.changed ?? 0}</span></div>`).join('');
    const conflicts = (r.conflicts || []).map((c) => `<div class="row flat"><span class="tag warn">疑似重复</span><span>${esc(c.text || JSON.stringify(c))}</span></div>`).join('');
    const untouched = (r.untouched || []).map((u) => `<span class="chip">${esc(u.label || u)}</span>`).join('');
    modal('导入前的变更清单', `
      <p class="hint">确认后只载入到页面，<b>仍要点「保存并生效」才会写下去</b>。</p>
      ${rows ? `<div class="card-d"><b>字段级差异</b></div><div class="rows">${rows}</div>` : ''}
      ${lists ? `<div class="card-d" style="margin-top:10px;"><b>清单类增删改</b></div><div class="rows">${lists}</div>` : ''}
      ${conflicts ? `<div class="card-d" style="margin-top:10px;"><b>同一件事记两遍的提醒</b></div><div class="rows">${conflicts}</div>` : ''}
      ${untouched ? `<div class="card-d" style="margin-top:10px;"><b>本次不会碰的字段</b></div><div class="chip-list">${untouched}</div>` : ''}
    `, [{ label: '载入到页面', style: 'btn-primary', run: applyImport }]);
  } catch (e) { toast(`预览失败：${e.message}`, 'bad'); } finally { busy(false); }
}
async function installZip(file, kind = 'plugin', opts = {}) {
  if (!S.online) return DEMO_BLOCK();
  const overwrite = opts.overwrite === true;
  if (!overwrite && !(await confirmToast('装这个包？同名包不会被覆盖（那是另一条确认）。', { okLabel: '安装' }))) return;
  busy(true, '校验并安装…');
  try {
    const q = `kind=${encodeURIComponent(kind === 'skill' ? 'skill' : 'plugin')}${overwrite ? '&overwrite=1' : ''}`;
    const r = await api(`/api/extensions/install?${q}`, { method: 'POST', body: file });
    toast(`已装入 ${r.id}（${r.kind}）· ${r.files} 个文件。装完默认不启用 —— 在列表里勾上它，然后重启机器人。`, 'ok');
    await refresh(true);
  } catch (e) {
    if (!overwrite && (e.status === 409 || /同名包已存在/.test(e.message))) {
      busy(false);
      const yes = await confirmToast('同名包已存在，要用这个包覆盖吗？旧包会先备份再替换。', { okLabel: '覆盖安装' });
      if (yes) return installZip(file, kind, { overwrite: true });
      return;
    }
    toast(`安装失败：${e.message}`, 'bad');
  } finally { busy(false); }
}

/* ════════════════════════════════════════════════ 6. 顶栏 / 告警 ═══ */
function paintTop() {
  const s = S.state || DEMO;
  // 顶栏状态岛（island.js）：原来的五颗胶囊已并入岛内，这里只喂状态、不碰 DOM。
  if (window.Island) window.Island.update(S.state || null, { online: S.online });
  const sub = j(s, ['account', 'nickname']);
  $id('subline').textContent = S.online
    ? `${j(s, ['config', 'provider'], '?')} · ${j(s, ['effective', 'model'], '—')}${sub ? ` · ${sub}` : ''} · 面板 pid ${j(s, ['panel', 'pid'], '—')}`
    : (shellApi()
      ? '后端未连接 —— 窗口还在，可用告警条里的「重启面板」重新拉起'
      : '未连上后端 —— 下面是离线演示快照（写操作不会发送）');
  $id('footStat').textContent = `一级域 ${GROUPS.length} · 页面 ${GROUPS.reduce((n, g) => n + g.subs.length, 0)} · 控件类型 ${CTRL_KINDS.length}`;
}

/**
 * 告警条上一次画出来的 HTML。
 *
 * ⚠️ 存在的理由（第 59 轮）：第 58 轮把 `renderBanners()` 挪到**每次刷新都跑**
 *   （原来只在「离线→在线」与 catch 里跑，于是条子冻结在首帧、与页面内容自相矛盾）。
 *   但 `refresh()` 是 3 秒一轮的 ⇒ 这函数也就变成 3 秒一次 **`innerHTML =`**。
 *   而告警条里**有一颗按钮**（「重启面板」）—— 整块被替换的那一瞬点下去，
 *   这一次点击就丢了，表现正是本项目记录过多次的"**点了没反应**"。
 *   ⇒ 只在**内容真的变了**时才写 DOM：既保住第 58 轮"条子要跟着状态变"的修复，
 *     又不再每 3 秒无谓地重建一块带按钮的 DOM（顺带省掉一次重排）。
 */
let bannersHtml = '';

function renderBanners() {
  const box = $id('banners');
  const s = S.state || DEMO;
  const out = [];
  if (!S.online) {
    if (shellApi()) {
      out.push(`<div class="banner bad"><b>控制台后端没有响应</b><span class="spacer"></span>
        <span>窗口还在，但面板进程已经退出。可以直接重新拉起，不用关掉窗口；机器人不受影响。</span>
        <button class="btn btn-sm" data-a="panel.restart">重启面板</button>
        <button class="btn btn-sm" data-a="panel.quit">退出控制台</button></div>`);
    } else {
      out.push(`<div class="banner info"><b>演示模式</b><span class="spacer"></span>
        <span>这一页没有连上后端。要看真实数据：在项目根目录跑 <code>node tools/serve-next.mjs</code>，然后打开它给出的地址。</span></div>`);
    }
  }
  if (S.online && !HAS_TOKEN) {
    out.push(`<div class="banner"><b>没拿到面板 token</b><span class="spacer"></span>
      <span>读正常，写会被拒。用控制台图标重开一次（服务端会把 token 注入页面）。</span></div>`);
  }
  if (S.online && j(s, ['panel', 'stale'])) {
    out.push(`<div class="banner"><b>面板服务端是旧代码</b><span class="spacer"></span>
      <span>磁盘上的 <code>panel/server.js</code> 或 <code>panel/lib/</code> 比正在跑的进程新，新接口还没生效（表现为某些按钮点了没反应）。</span>
      <button class="btn btn-sm" data-a="panel.restart">重启面板</button></div>`);
  }
  if (j(s, ['memory', 'pressure'], 0) >= 90) {
    out.push(`<div class="banner"><b>内存很紧</b><span class="spacer"></span>
      <span>占用 ${j(s, ['memory', 'pressure'])}%。再挤下去 Docker 会被系统悄悄杀掉（表现为"容器凭空消失"）—— 建议先停本机模型。</span></div>`);
  }
  const upd = UPD.state || j(s, ['update'], null);
  if (upd && upd.enabled && (upd.phase === 'available' || upd.phase === 'ready')) {
    const latest = upd.latest && upd.latest.version ? ` ${upd.latest.version}` : '';
    out.push(`<div class="banner info"><b>${upd.phase === 'ready' ? '更新已下载' : `新版本${esc(latest)} 可用`}</b><span class="spacer"></span>
      <span>${upd.phase === 'ready' ? '已校验通过，等你点「立即安装」；不会自动安装。' : '在「系统 → 面板维护」里下载并安装；不会自动安装。'}</span>
      <button class="btn btn-sm" data-a="update.goto">查看更新</button></div>`);
  }
  if (UI_IDENTITY.state === 'unofficial') {
    const detail = UI_IDENTITY.missing && UI_IDENTITY.missing.length
      ? `缺少 ${UI_IDENTITY.missing.slice(0, 3).join('、')}`
      : '核心界面骨架与官方签名不一致';
    out.push(`<div class="banner bad" data-ui-identity="unofficial"><b>检测到非官方界面</b><span class="spacer"></span>
      <span>${esc(detail)}；功能可能仍正常，但这不是官方发布的界面。</span></div>`);
  }
  const html = out.join('');
  if (html === bannersHtml) return; // 没变就别重建 —— 那颗「重启面板」会被整块换掉（见上方注释）
  bannersHtml = html;
  box.innerHTML = html;
}

/* ── UI 身份锁（§171）：本地核心锚点比对 ────────────────────────────────
   服务端负责验签并下发 anchors；这里只做 DOM/模块级存在性比对。
   清单里的核心项必须在；多出来的域/页/选择器/渲染入口一律放行。 */
function evaluateUiIdentityLocal(manifest, snapshot) {
  const missing = [];
  const domains = Array.isArray(manifest && manifest.domains) ? manifest.domains : [];
  const snapDomains = Array.isArray(snapshot && snapshot.domains) ? snapshot.domains : [];
  const byId = new Map(snapDomains.map((d) => [d.id, d]));
  const coreDomains = domains.map((d) => d.id);
  for (const md of domains) {
    const sd = byId.get(md.id);
    if (!sd) { missing.push('domain:' + md.id); continue; }
    if (sd.label !== md.label) missing.push('domain-label:' + md.id);
    const pages = Array.isArray(md.pages) ? md.pages : [];
    const spById = new Map((Array.isArray(sd.pages) ? sd.pages : []).map((p) => [p.id, p]));
    const corePageIds = pages.map((p) => p.id);
    for (const mp of pages) {
      const hit = spById.get(mp.id);
      if (!hit) { missing.push('page:' + md.id + '/' + mp.id); continue; }
      if (hit.label !== mp.label) missing.push('page-label:' + md.id + '/' + mp.id);
    }
    const order = (Array.isArray(sd.pages) ? sd.pages : [])
      .map((p) => p.id).filter((id) => corePageIds.includes(id));
    if (order.join('\u0000') !== corePageIds.join('\u0000')) missing.push('page-order:' + md.id);
  }
  const order = snapDomains.map((d) => d.id).filter((id) => coreDomains.includes(id));
  if (order.join('\u0000') !== coreDomains.join('\u0000')) missing.push('domain-order');
  const selectors = Array.isArray(manifest && manifest.selectors) ? manifest.selectors : [];
  const haveSel = new Set(Array.isArray(snapshot && snapshot.selectors) ? snapshot.selectors : []);
  for (const sel of selectors) if (!haveSel.has(sel)) missing.push('selector:' + sel);
  const renderers = Array.isArray(manifest && manifest.renderers) ? manifest.renderers : [];
  const haveRen = new Set(Array.isArray(snapshot && snapshot.renderers) ? snapshot.renderers : []);
  for (const r of renderers) if (!haveRen.has(r)) missing.push('renderer:' + r);
  return { ok: missing.length === 0, missing };
}

function localUiIdentitySnapshot(anchors) {
  if (!anchors || !Array.isArray(anchors.selectors) || !Array.isArray(anchors.renderers)) return null;
  const domains = GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    pages: (g.subs || []).map((s) => ({ id: s.id, label: s.label })),
  }));
  const selectors = anchors.selectors.filter((sel) => !!document.querySelector(sel));
  const renderers = anchors.renderers.filter((r) => {
    if (r === 'RENDER') return typeof RENDER === 'object' && RENDER !== null;
    if (r === 'renderNav1') return typeof renderNav1 === 'function';
    if (r === 'renderNav2') return typeof renderNav2 === 'function';
    if (r === 'paintPage') return typeof paintPage === 'function';
    return false;
  });
  return { domains, selectors, renderers };
}

function runUiIdentityCheck(serverIdentity, force = false) {
  const stamp = (serverIdentity && serverIdentity.checkedAt) || 0;
  if (!force && UI_IDENTITY.checked && UI_IDENTITY.checkedAt === stamp) return UI_IDENTITY;
  if (!document.getElementById('nav1') || !document.getElementById('page')) return UI_IDENTITY;
  const next = { state: 'unknown', reason: '', missing: [], checkedAt: stamp, checked: true };
  if (serverIdentity && serverIdentity.state === 'unofficial') {
    next.state = 'unofficial';
    next.reason = serverIdentity.reason || '';
  } else if (serverIdentity && serverIdentity.state === 'official' && serverIdentity.anchors) {
    const snapshot = localUiIdentitySnapshot(serverIdentity.anchors);
    if (!snapshot) {
      next.reason = '缺少可核对的锚点';
    } else {
      const ev = evaluateUiIdentityLocal(serverIdentity.anchors, snapshot);
      next.state = ev.ok ? 'official' : 'unofficial';
      next.missing = ev.missing;
      next.reason = ev.ok ? '' : '核心界面骨架与官方签名不一致';
    }
  } else {
    next.reason = (serverIdentity && serverIdentity.reason) || '旧后端/无法校验';
  }
  Object.assign(UI_IDENTITY, next);
  document.documentElement.dataset.uiIdentity = UI_IDENTITY.state;
  renderBanners();
  return UI_IDENTITY;
}

/* 观察孔：自检脚本用它强制重查；业务代码不要依赖。 */
window.__uiIdentity = {
  get state() { return UI_IDENTITY.state; },
  get missing() { return UI_IDENTITY.missing.slice(); },
  evaluate: evaluateUiIdentityLocal,
  check: () => runUiIdentityCheck(S.state && S.state.uiIdentity, true),
};

/**
 * 更新卡片的 HTML。读 `UPD.state`（SSE 实时）并回落到 `/api/state` 的 `update`，
 * 这样首屏（SSE 还没连上）也不会空白。
 */
function offlineHtml(u) {
  if (!u || !u.enabled) return '';
  if (!['idle', 'up_to_date', 'available', 'error'].includes(u.phase)) return '';
  const pending = u.offline && u.offline.version
    ? `<div class="hint">已读取离线清单 <b>${esc(u.offline.version)}</b>（${fmtBytes(u.offline.size)}），请选择安装包。</div>`
    : '';
  return `<details class="upd-off"${pending ? ' open' : ''}>
    <summary>离线更新（EXE + latest.json + .sig）</summary>
    <div class="hint">三件套只在本机校验：先验签、再验哈希；不会联网，也不会绕过任何校验。</div>
    <label>latest.json <input type="file" id="upd-off-manifest" accept=".json,application/json"></label>
    <label>.sig <input type="file" id="upd-off-sig" accept=".sig,text/plain"></label>
    <label>安装包 <input type="file" id="upd-off-exe" accept=".exe,application/octet-stream"></label>
    ${pending}
    <div class="upd-row"><button class="btn btn-sm btn-ghost" data-a="update.offline.verify">校验离线包</button><span class="spacer"></span></div>
    <div class="hint" id="upd-off-status"></div>
  </details>`;
}

function updateHtml() {
  const u = UPD.state || j(S.state, ['update'], null);
  if (!u) return '<div class="hint">正在读取更新状态…</div>';
  if (!u.enabled) return `<div class="hint">${esc(u.reason || '应用内更新不可用')}</div>`;
  const cur = esc(u.currentVersion || '—');
  const latest = u.latest ? esc(u.latest.version || '—') : '';
  const p = u.progress || {};
  const notes = u.latest && u.latest.notesUrl ? safeHref(u.latest.notesUrl) : '';
  const tail = offlineHtml(u);
  const btn = (label, action, cls = 'btn-ghost') =>
    `<button class="btn btn-sm ${cls}" data-a="${action}">${esc(label)}</button>`;
  switch (u.phase) {
    case 'checking':
      return '<div class="upd-row"><span>正在检查更新…</span></div>';
    case 'up_to_date':
      return `<div class="upd-row"><span>当前版本 <b>${cur}</b> · 已是最新</span><span class="spacer"></span>${btn('再检查一次', 'update.check')}</div>${tail}`;
    case 'available':
      return `<div class="upd-row"><span>当前 <b>${cur}</b> → 最新 <b>${latest}</b></span><span class="spacer"></span>${notes ? `<a class="btn btn-sm btn-ghost" href="${esc(notes)}" target="_blank" rel="noreferrer">更新说明</a>` : ''}${btn('下载更新', 'update.download', 'btn-primary')}</div>${tail}`;
    case 'downloading':
      return `<div class="upd-row"><span>正在下载 <b>${latest}</b> · ${p.percent == null ? '…' : `${p.percent}%`}</span><span class="spacer"></span>${btn('取消', 'update.cancel')}</div><div class="upd-bar"><i style="width:${Math.max(0, Math.min(100, Number(p.percent) || 0))}%"></i></div><div class="hint">${fmtBytes(p.received)} / ${fmtBytes(p.total)}${p.bytesPerSec ? ` · ${fmtBytes(p.bytesPerSec)}/s` : ''}</div>`;
    case 'ready':
      return `<div class="upd-row"><span>更新 <b>${latest}</b> 已下载 · 大小/哈希校验通过</span><span class="spacer"></span>${btn('立即安装', 'update.install', 'btn-primary')}</div><div class="hint">点「立即安装」后应用会关闭，安装完成后重新打开。没有自动安装。</div>`;
    case 'installing':
      return '<div class="upd-row"><span>正在启动安装器…应用即将关闭。</span></div>';
    case 'error':
      return `<div class="upd-row"><span class="bad">${esc(u.error || '更新失败')}</span><span class="spacer"></span>${btn('重试', 'update.check')}</div>${tail}`;
    default:
      return `<div class="upd-row"><span>当前版本 <b>${cur}</b></span><span class="spacer"></span>${btn('检查更新', 'update.check')}</div>${tail}`;
  }
}

function paintUpdateBox() {
  const box = $id('upd-box');
  if (box) box.innerHTML = updateHtml();
}

/** 更新进度走现有 SSE（/api/console/stream）的 `update` 事件，不新开端口。 */
function openUpdateStream() {
  if (UPD.es || typeof EventSource === 'undefined') return;
  const es = new EventSource('/api/console/stream');
  UPD.es = es;
  es.addEventListener('update', (ev) => {
    try {
      UPD.state = JSON.parse(ev.data);
      UPD.loaded = true;
      const phase = UPD.state && UPD.state.phase ? UPD.state.phase : '';
      if (phase !== UPD.lastPhase) {
        UPD.lastPhase = phase;
        renderBanners();
        if (phase === 'ready') {
          const ver = UPD.state && UPD.state.latest && UPD.state.latest.version
            ? `新版本 ${UPD.state.latest.version} ` : '';
          shellNotify('更新已下载', `${ver}已校验通过；打开面板点「立即安装」。`);
        }
      }
      paintUpdateBox();
    } catch { /* 坏帧丢掉即可 */ }
  });
  es.onerror = () => { /* EventSource 自带重连 */ };
}

/* ════════════════════════════════════════════════ 7. 导航 ═══ */
function renderNav1() {
  const inner = $id('navInner');
  /* ⚠️ 只摘**按钮**，不动 `.nav-ind` —— 指示器是 index.html 里的静态元素，
     让它活过每一次重建是"切换时能滑过去"的**前提**（见 index.html 的注释）。
     用 `innerHTML = …` 一把换掉最省事，但那会把指示器一起清掉。
     导航显示短标签；完整名称放进 title/aria-label，页面头仍用全名。 */
  inner.querySelectorAll('.grp').forEach((b) => b.remove());
  inner.insertAdjacentHTML('afterbegin', GROUPS.map((g, i) => `
    <button class="grp" role="tab" data-g="${i}" aria-selected="${i === S.gi}" title="${esc(g.label)}（${g.subs.length} 页）" aria-label="${esc(g.label)}（${g.subs.length} 页）">${esc(g.short || g.label)}<span class="cnt">${g.subs.length}</span></button>`).join(''));
  layoutNavDock(false);
}
function renderNav2() {
  const g = GROUPS[S.gi];
  $id('nav2').innerHTML = g.subs.map((su, i) => `
    <button class="sub" role="tab" data-s="${i}"${su.frame ? ` data-frame="${esc(su.frame)}"` : ''} aria-selected="${i === S.si}" title="${esc(su.label)}" aria-label="${esc(su.label)}">${esc(su.short || su.label)}</button>`).join('');
  /* B30：原来这里还往 `#pageMeta` 填「即时页 / 点一下立刻生效」，该节点已整块删除 ——
     草稿页的保存入口仍是页面底部的保存条（savebar），功能不受影响。 */
  layoutNavDock(true);
  syncNav2Indicator(false);
}

/* ── 吸顶导航：一级在上、二级在下（2026-10-22）──────────────────────────
   船（dock）宽度 = 一级内容宽 + 16；二级宽度 = 当前域二级内容宽（按内容收缩/展开）。
   中间肩线用 42 × 11.5、控制点 0.618 的三次贝塞尔；曲率从 0 到 0，避免硬拐点。
   ⚠️ 二级宽度**没有 300px 下限**：3 个页签的「系统」就应收到 ~150，而不是留一大片空。
   ⚠️ 只在 renderNav1/renderNav2/resize 时量；不要放进 3 秒轮询（getBoundingClientRect
      会强制同步布局）。 */
let navDockW = 0;       // 二级 wrap 宽度（动画插值）
let navDockBoxW = 0;    // dock 外壳宽度（切页时一次定死）
let navDockRaf = 0;
let navGeom = null;
let navEdgeSig = '';
/* ── dock 停稳回调（2026-10-28）────────────────────────────────────────
   分段渲染要等导航动画停稳再落图、再放行入场动画。dock 是裸 rAF（不是 Motion 句柄，
   Motion.onSettle 用不上），这里只登记回调，并在动画的**三条终点**统一触发：
   无动画分支 / reduced-motion 快退 / `p===1`。不新开调度器。 */
const navDockSettleCbs = [];
let navDockRunning = false;
function navDockAnimating() { return navDockRunning; }
function navDockSettled(cb) { navDockSettleCbs.push(cb); }
function fireNavDockSettled() {
  navDockRunning = false;
  const cbs = navDockSettleCbs.splice(0);
  for (const cb of cbs) {
    try { cb(); } catch { /* 停稳回调不许把导航拖下水 */ }
  }
}

function navCssPx(name, fallback) {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
}

function readNavGeom() {
  return {
    H1: navCssPx('--h-nav1', 48),
    H2: navCssPx('--h-nav2', 30),
    T: navCssPx('--nav-shoulder', 42),
    HT: navCssPx('--nav-rise', 11.5),
    R2: navCssPx('--nav-r2', 11.5),
  };
}

function layoutNavDock(animate) {
  const row = $id('navrow'), inner = $id('navInner'), nav2 = $id('nav2');
  const wrap = $id('nav2wrap'), dock = $id('navDock');
  if (!row || !inner || !nav2 || !wrap || !dock) return;
  /* 读在写前：三个宽度一次取完，避免 `dock.style.width =` 之后再读触发强制布局。 */
  const avail = row.getBoundingClientRect().width;
  const l1w = inner.scrollWidth + 16;
  const contentW = nav2.scrollWidth + 8;
  const desired = Math.min(avail, l1w);
  const dockW = Math.max(240, desired);
  navDockBoxW = dockW;
  dock.style.width = `${dockW}px`;
  /* 几何令牌只在断点 / 触屏档变化，缓存到下一次 resize 为止。
     换域那一帧会调两次 layoutNavDock（renderNav1 + renderNav2），
     旧版每次都 readNavGeom（5 次 getComputedStyle）⇒ 多出来的 5 次全是白读。 */
  if (!navGeom) navGeom = readNavGeom();
  const maxW = Math.max(120, desired - 2 * (navGeom.H1 / 2 + navGeom.T + 4));
  const target = Math.min(contentW, maxW);

  if (!navDockW) navDockW = target;
  if (animate && Math.abs(navDockW - target) > 0.5) animateNavDock(navDockW, target);
  else {
    navDockW = target;
    setNav2Width(target);
    /* 没有在途 rAF 就说明没有动画真要等：顺手清掉上一次中断可能留下的 running，
       否则所有等停稳的回调只能靠 900ms 兜底（表现是图表迟迟不出现）。
       没有动画要等时，正在等停稳的回调当场放行。 */
    if (!navDockRaf) navDockRunning = false;
    if (!navDockRunning) fireNavDockSettled();
  }
}

function setNav2Width(w) {
  const wrap = $id('nav2wrap');
  if (!wrap) return;
  wrap.style.width = `${w}px`;
  paintNavDock(w);
}

function animateNavDock(from, to) {
  cancelAnimationFrame(navDockRaf);
  const M = window.Motion;
  navDockRunning = true;
  if (M && M.reducedMotion && M.reducedMotion()) {
    navDockW = to; setNav2Width(to); navDockRaf = 0; fireNavDockSettled(); return;
  }
  const t0 = performance.now();
  const dur = 380;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const w = from + (to - from) * ease(p);
    navDockW = w;
    setNav2Width(w);
    if (p < 1) navDockRaf = requestAnimationFrame(step);
    else { navDockW = to; setNav2Width(to); navDockRaf = 0; fireNavDockSettled(); }
  };
  navDockRaf = requestAnimationFrame(step);
}

function paintNavDock(wrapW = navDockW) {
  const dock = $id('navDock'), edge = $id('navDockEdge');
  const path = edge && edge.querySelector('path');
  if (!dock || !edge || !path) return;
  /* 动画帧里只用传进来的宽度与 layoutNavDock 缓存的几何：
     旧版每帧 getBoundingClientRect ×2 + getComputedStyle ×5，正好和 380ms 展开动画打架。 */
  const W = navDockBoxW;
  const g = navGeom || (navGeom = readNavGeom());
  const { H1, H2, T, HT, R2 } = g;
  const H = H1 + H2;
  const R1 = H1 / 2;
  const TW = Math.max(20, Math.min(wrapW, W - 2 * (R1 + T + 2)));
  const TL = (W - TW) / 2;
  const TR = TL + TW;
  const K = 0.6180339887498949;
  const n = (v) => (Number.isFinite(v) ? v : 0).toFixed(2);
  const d = [
    `M ${n(R1)} 0`,
    `L ${n(W - R1)} 0`,
    `A ${n(R1)} ${n(R1)} 0 0 1 ${n(W)} ${n(R1)}`,
    `L ${n(W)} ${n(H1 - R1)}`,
    `A ${n(R1)} ${n(R1)} 0 0 1 ${n(W - R1)} ${n(H1)}`,
    `L ${n(TR + T)} ${n(H1)}`,
    `C ${n(TR + T - K * T)} ${n(H1)}, ${n(TR)} ${n(H1 + HT - K * HT)}, ${n(TR)} ${n(H1 + HT)}`,
    `L ${n(TR)} ${n(H1 + H2 - R2)}`,
    `A ${n(R2)} ${n(R2)} 0 0 1 ${n(TR - R2)} ${n(H1 + H2)}`,
    `L ${n(TL + R2)} ${n(H1 + H2)}`,
    `A ${n(R2)} ${n(R2)} 0 0 1 ${n(TL)} ${n(H1 + H2 - R2)}`,
    `L ${n(TL)} ${n(H1 + HT)}`,
    `C ${n(TL)} ${n(H1 + HT - K * HT)}, ${n(TL - T + K * T)} ${n(H1)}, ${n(TL - T)} ${n(H1)}`,
    `L ${n(R1)} ${n(H1)}`,
    `A ${n(R1)} ${n(R1)} 0 0 1 0 ${n(H1 - R1)}`,
    `L 0 ${n(R1)}`,
    `A ${n(R1)} ${n(R1)} 0 0 1 ${n(R1)} 0`,
    'Z',
  ].join(' ');
  dock.style.clipPath = `path("${d}")`;
  /* dock 外宽/总高在 380ms 内不变：SVG 尺寸只在切页时写一次，帧内只更新 d。 */
  const sig = `${n(W)}|${n(H)}`;
  if (sig !== navEdgeSig) {
    navEdgeSig = sig;
    edge.setAttribute('viewBox', `0 0 ${n(W)} ${n(H)}`);
    edge.setAttribute('width', n(W));
    edge.setAttribute('height', n(H));
  }
  path.setAttribute('d', d);
}

/* ════════════════════════════════════════════ 7b. 导航滑块（灵动岛） ═══
   高亮由**唯一一个** `.nav-ind` 承载：位置与宽度取选中项的 `offsetLeft/offsetWidth`，
   切换时用弹簧过渡过去 —— 这就是从 RareUI 的 GooeyNav 取的"形变 / 滑动"
   （它公开实现的内核；它的 SVG gooey 滤镜**没有**照搬，理由写在 style.css）。

   ⚠️ 四处不能动的地方，动了就以"看着像坏了"的形式退化，而且**不报错**：
     ① **不参与状态**：指示器只**读** `aria-selected`。点击委托、`S.gi / S.si`、
        以及 `aria-selected` 的写入点一个字节都没改 —— 用户要求 5 原话
        "路由跳转与选中项标识逻辑完全不变"，靠的是这里**不加逻辑**而不是加对了逻辑。
     ② 坐标基准取 `offsetLeft`（相对 `offsetParent` = `.nav-inner`，它是 position:relative），
        指示器也定位在同一个盒子里 ⇒ 两个坐标系天然一致。
        **不要**改成 `getBoundingClientRect()`：那个含滚动偏移，窄屏一滚就错位。
     ③ 首屏与窗口尺寸变化走 `jump()`（不做动画）：否则第一次会从 (0,0) 飞过来。
     ④ 弹簧被打断时**不重置速度**（`animate` 内部保留 `state.v`）：
        连点两下是"顺势拐弯"。自己写 rAF 很容易在这里做成"每次从零起步"，
        表现是连点时一顿一顿的。

   形变的来源是**速度**（`MotionValue.velocity()`）：滑得越快越被横向拉长，
   纵向按面积守恒压一档（`Motion.areaPreservingScaleX`）。
   这一步是"液体"与"变胖"的分界 —— 只放大不守恒，看起来是元素变大了，不是被抻长了。
   ⚠️ 减弱动效不用在这里判：`Motion.animate` 内部会直接落位（motion.js 已实现）。
   形变的上限压得很低（0.14）：这是一页控制台，动效服务于"切换发生了"这件事，
   不该抢注意力 —— 短距离位移速度低，几乎看不到拉伸；只在跨半屏时才明显。 */
const NAV_SPRING = { stiffness: 340, damping: 30, mass: .85 };
const NAV_STRETCH_PER_PX_S = 0.00007;   // 每 1px/s 速度对应的额外横向拉伸
const NAV_STRETCH_MAX = 0.14;
let navInd = null;
let navPopTimer = 0;
let navPopGi = -1;
let navPopEls = [];
let navBurstTimer = 0;

/** 一次性绑定：指示器是静态元素，只绑一回（重建会把它连同订阅一起丢掉）。 */
function bindNavIndicator() {
  const el = $id('navInd');
  const glide = $id('navGlider');
  const M = window.Motion;
  if (!el || !M) return null;
  const ringCore = el.firstElementChild;
  const glideCore = glide && glide.firstElementChild;
  const ind = {
    el, glide, ringCore, glideCore,
    x: M.motionValue(0), w: M.motionValue(0), anims: [], inited: false, tx: -1, tw: -1,
  };
  ind.apply = () => {
    const x = ind.x.get(), w = ind.w.get();
    /* 非有限值一律不写：`translateX(NaN)` 会被 CSS 忽略、元素停在上一帧，
       而 `width(NaN)` 会让它静默消失 —— 由 sync 的 bad 分支负责跳回目标。 */
    if (!Number.isFinite(x) || !Number.isFinite(w)) return;
    el.style.width = `${Math.max(0, w).toFixed(2)}px`;
    el.style.transform = `translateX(${x.toFixed(2)}px)`;
    if (glide) {
      glide.style.width = `${Math.max(0, w).toFixed(2)}px`;
      glide.style.transform = `translateX(${x.toFixed(2)}px)`;
    }
    if (glideCore) {
      /* 拉伸只落在填充层：1px 细框保持原宽，选中框不会被速度拉成椭圆。 */
      const k = 1 + Math.min(Math.abs(ind.x.velocity()) * NAV_STRETCH_PER_PX_S, NAV_STRETCH_MAX);
      glideCore.style.transform = `scaleX(${k.toFixed(4)}) scaleY(${M.areaPreservingScaleX(k).toFixed(4)})`;
    }
  };
  ind.x.on(ind.apply);
  ind.w.on(ind.apply);
  navInd = ind;
  return ind;
}

/** 把选中项带进岛的可见区（窄屏岛内会横向滚动）。
 *  ⚠️ **不用 `scrollIntoView`**：它把**纵向**也一起滚（整页跳一下，很突然），
 *     而这里要动的只是岛内部的 `scrollLeft` 一个数。 */
function scrollNavTo(sel) {
  const inner = $id('navInner');
  if (!inner || inner.scrollWidth <= inner.clientWidth) return;
  const pad = 12, left = sel.offsetLeft, right = left + sel.offsetWidth;
  if (left - inner.scrollLeft < pad) inner.scrollLeft = Math.max(0, left - pad);
  else if (right - inner.scrollLeft > inner.clientWidth - pad) inner.scrollLeft = right - inner.clientWidth + pad;
}
/** 把二级选中项带进窄条的可见区（同上：只动 `.nav2` 的 scrollLeft）。 */
function scrollNav2To(sel) {
  const nav = $id('nav2');
  if (!nav || nav.scrollWidth <= nav.clientWidth) return;
  const pad = 12, left = sel.offsetLeft, right = left + sel.offsetWidth;
  const before = nav.scrollLeft;
  if (left - nav.scrollLeft < pad) nav.scrollLeft = Math.max(0, left - pad);
  else if (right - nav.scrollLeft > nav.clientWidth - pad) nav.scrollLeft = right - nav.clientWidth + pad;
  /* 自己把选中项滚进视野时记一笔：随后的 scroll 事件不要再 instant 跳，
     否则刚起跑的二级胶囊弹簧会被一帧掐到终点（切换看起来是"闪一下"）。 */
  if (nav.scrollLeft !== before) nav2AutoScrollT = performance.now();
}

/** 让指示器对齐当前选中项。`instant` 为真时直接落位（首屏 / 尺寸变化）。 */
function syncNavIndicator(instant) {
  const ind = navInd || bindNavIndicator();
  if (!ind) return;
  const sel = document.querySelector('#navInner .grp[aria-selected="true"]');
  if (!sel) return;
  const x = sel.offsetLeft, w = sel.offsetWidth;
  /* ⚠️⚠️ 目标没变就**不重启**（2026-10-21 · 真机 bug）。
     `paintPage(false)` 会被页面数据刷新高频调用；以前每次都 stop + animate，
     弹簧带着当前速度反复重来，速度会被指数放大（实测滑块被写到
     translateX(66662px) / width(21304px)，再被 `.nav2wrap` 的 clip-path 裁掉）。
     同一目标下的重复同步必须是**空操作**，让在途弹簧自己收敛。 */
  if (!instant && ind.inited
      && Math.abs(ind.tx - x) < 0.5 && Math.abs(ind.tw - w) < 0.5) return;
  ind.tx = x; ind.tw = w;
  const gi = Number(sel.dataset.g);
  const giChanged = ind.inited && navPopGi !== -1 && gi !== navPopGi;
  navPopGi = gi;
  const M = window.Motion;
  ind.anims.forEach((a) => a.stop());          // 打断上一段：不重置速度，见上面 ④
  ind.anims = [];
  const bad = !Number.isFinite(ind.x.get()) || !Number.isFinite(ind.w.get());
  if (instant || !ind.inited || bad || M.reducedMotion()) {
    ind.x.jump(x); ind.w.jump(w);
  } else if (Math.abs(ind.x.get() - x) > 0.5 || Math.abs(ind.w.get() - w) > 0.5) {
    ind.anims = [M.animate(ind.x, x, NAV_SPRING), M.animate(ind.w, w, NAV_SPRING)];
  }
  ind.inited = true;
  ind.el.classList.add('ready');
  if (ind.glide) ind.glide.classList.add('ready');
  /* 一级换域才弹一下：初次渲染 / 轮询 / 改字号都只换宽度不换 gi，不会误触发。 */
  if (!instant && giChanged && !M.reducedMotion()) {
    clearTimeout(navPopTimer);
    navPopTimer = setTimeout(() => {
      const cur = document.querySelector('#navInner .grp[aria-selected="true"]');
      if (cur && Number(cur.dataset.g) === gi) navPop();
    }, 320);
  }
  scrollNavTo(sel);
}

/** 一级落位后整项弹一下 + 三颗小球；只在用户换域后由 syncNavIndicator 计时触发。 */
function navPop() {
  const M = window.Motion;
  if (M && M.reducedMotion()) return;
  const sel = document.querySelector('#navInner .grp[aria-selected="true"]');
  const ind = $id('navInd');
  const glide = $id('navGlider');
  const ringCore = ind && ind.firstElementChild;
  const glideCore = glide && glide.firstElementChild;
  if (!sel || !ringCore || !glideCore || typeof sel.animate !== 'function') return;
  const targets = [sel, ringCore, glideCore];
  const frames = [
    { offset: 0, scale: '0.95', translate: '0 1.5px' },
    { offset: 0.5, scale: '1.04', translate: '0 -1px' },
    { offset: 1, scale: '1', translate: '0 0' },
  ];
  const opts = { duration: 300, easing: 'cubic-bezier(.4, 0, .2, 1)', id: 'navPop' };
  for (const el of navPopEls) {
    el.getAnimations().filter((a) => a.id === 'navPop').forEach((a) => a.cancel());
  }
  navPopEls = targets;
  for (const el of targets) {
    el.getAnimations().filter((a) => a.id === 'navPop').forEach((a) => a.cancel());
    el.animate(frames, opts);
  }
  navBurst(sel);
}

function navBurst(btn) {
  const burst = $id('navBurst');
  if (!burst || !btn) return;
  const wrap = burst.parentElement.getBoundingClientRect();
  const br = btn.getBoundingClientRect();
  const x = br.left - wrap.left + br.width / 2;
  const y = br.top - wrap.top;
  clearTimeout(navBurstTimer);
  burst.replaceChildren();
  [-11, 0, 11].forEach((dx, i) => {
    const dot = document.createElement('i');
    dot.style.left = `${x.toFixed(2)}px`;
    dot.style.top = `${y.toFixed(2)}px`;
    dot.style.setProperty('--dx', `${dx}px`);
    dot.style.setProperty('--dx2', `${(dx * 1.55).toFixed(2)}px`);
    dot.style.animationDelay = `${i * 35}ms`;
    burst.appendChild(dot);
  });
  void burst.offsetWidth;
  burst.querySelectorAll('i').forEach((dot) => dot.classList.add('go'));
  navBurstTimer = setTimeout(() => burst.replaceChildren(), 1150);
}

/* ── 二级导航滑块（2026-10-20 · 契约 §103）────────────────────────────
   与 `.nav-ind` 同构：**静态元素** + `Motion` 弹簧 + 首帧 jump、之后 animate。
   为什么不再用 `.sub::after` 的 `scaleX`：下划线只能"出现/消失"，
   **位移本身不承载语义**；而导航符合 §6.4 三条准入（有序 / 反复拨 / 位移即语义），
   所以二级也升到 S2。`style.css` 里保留了当年"下划线更省"的三条理由，并写明本轮裁决。
   ⚠️ 坐标基准是 `.nav2wrap`；`#nav2` 横向滚动时子元素 `offsetLeft` **不跟着变**，
      必须减 `scrollLeft`，否则窄屏一滚就与按钮错开（且不会有任何报错）。
   ⚠️ 减弱动效不在这里判：`Motion.animate` 内部会直接落位（motion.js 已实现）。 */
const NAV2_SPRING = { stiffness: 300, damping: 30, mass: .7 };   // 比一级（340/30/.85）软一档：行程更短
const NAV2_INSET = 0;                                            // 胶囊直接盖住整颗二级页签
let nav2Ind = null;
let nav2SweepSi = -1;
let nav2SweepTimer = 0;
let nav2AutoScrollT = 0;

function bindNav2Indicator() {
  const el = $id('nav2Ind');
  const nav = $id('nav2');
  const M = window.Motion;
  if (!el || !nav || !M) return null;
  const ind = { el, x: M.motionValue(0), w: M.motionValue(0), anims: [], inited: false, tx: -1, tw: -1 };
  ind.apply = () => {
    const x = ind.x.get(), w = ind.w.get();
    if (!Number.isFinite(x) || !Number.isFinite(w)) return;   // 理由同一级滑块
    el.style.width = `${Math.max(0, w).toFixed(2)}px`;
    el.style.transform = `translateX(${x.toFixed(2)}px)`;
  };
  ind.x.on(ind.apply);
  ind.w.on(ind.apply);
  nav.addEventListener('scroll', () => {
    /* 手动横滚：胶囊立刻贴住选中项；程序性 scrollNav2To：让在途弹簧继续跑。 */
    syncNav2Indicator(performance.now() - nav2AutoScrollT > 120);
  }, { passive: true });
  nav2Ind = ind;
  return ind;
}

/** 让二级滑块对齐当前选中页签。`instant` 为真时直接落位（首屏 / 滚动 / 尺寸变化）。 */
function syncNav2Indicator(instant) {
  const ind = nav2Ind || bindNav2Indicator();
  if (!ind) return;
  const nav = $id('nav2');
  const sel = nav && nav.querySelector('.sub[aria-selected="true"]');
  if (!sel) return;
  scrollNav2To(sel);
  /* ⚠️ 二级滑块住在 `.nav2wrap`，而 `.sub` 的 offsetLeft 相对 `.nav2`；
     `.nav2` 自身有 4px 居中留白，漏加 nav.offsetLeft 会让胶囊整体偏左 4px（看起来像没对齐）。 */
  const x = sel.offsetLeft + nav.offsetLeft + NAV2_INSET - nav.scrollLeft;
  const w = Math.max(0, sel.offsetWidth - NAV2_INSET * 2);
  /* ⚠️⚠️ 目标没变就**不重启**（2026-10-21 · 用户视频里的"横线乱跑/消失"根因）：
     `paintPage(false)` 会被"日志与审计"页的取数回环高频调用（已在该页的 loader 里断开），
     以前每次同步都 stop + animate，弹簧带着速度重来会被指数放大 —— 实测写出
     translateX(66662px) / width(21304px)，横线冲出玻璃条后被 clip-path 裁掉。
     重复同步必须空操作，在途弹簧继续跑。 */
  if (!instant && ind.inited
      && Math.abs(ind.tx - x) < 0.5 && Math.abs(ind.tw - w) < 0.5) return;
  ind.tx = x; ind.tw = w;
  const si = Number(sel.dataset.s);
  const siChanged = ind.inited && nav2SweepSi !== -1 && si !== nav2SweepSi;
  nav2SweepSi = si;
  const M = window.Motion;
  ind.anims.forEach((a) => a.stop());      // 打断上一段：不重置速度（同 `.nav-ind` 的 ④）
  ind.anims = [];
  const bad = !Number.isFinite(ind.x.get()) || !Number.isFinite(ind.w.get());
  if (instant || !ind.inited || bad || M.reducedMotion()) {
    ind.x.jump(x); ind.w.jump(w);
  } else if (Math.abs(ind.x.get() - x) > 0.5 || Math.abs(ind.w.get() - w) > 0.5) {
    ind.anims = [M.animate(ind.x, x, NAV2_SPRING), M.animate(ind.w, w, NAV2_SPRING)];
  }
  ind.inited = true;
  ind.el.classList.add('ready');
  if (!instant && siChanged && !M.reducedMotion()) {
    clearTimeout(nav2SweepTimer);
    ind.el.classList.remove('sweep');
    void ind.el.offsetWidth;
    ind.el.classList.add('sweep');
    nav2SweepTimer = setTimeout(() => ind.el.classList.remove('sweep'), 520);
  }
}

/* 一级按压：细框贴到被按按钮并随按钮下沉。独立 press 环让「按未选中项」
   只移细框、不把选中项下面的填充一起带走；松开即交还给选中环。 */
let navPressedGrp = null;
function navPressAt(btn) {
  const inner = $id('navInner'), press = $id('navPress');
  if (!inner || !press || !btn) return;
  const w = btn.offsetWidth;
  if (!w) return;
  press.style.width = `${w}px`;
  press.style.transform = `translateX(${btn.offsetLeft.toFixed(2)}px)`;
  press.classList.add('on');
  void press.offsetWidth;
  press.classList.add('pressing');
  inner.classList.add('pressing');
  navPressedGrp = btn;
}
function navPressEnd() {
  if (!navPressedGrp) return;
  const inner = $id('navInner'), press = $id('navPress');
  if (inner && press) {
    press.classList.remove('pressing');
    press.classList.remove('on');
    inner.classList.remove('pressing');
  }
  navPressedGrp = null;
}

/* ══════════════════════════════════════════════════════════════════════════
   重绘保状态：`<details>` 的展开 + 容器的滚动位置（2026-10-04）
   ──────────────────────────────────────────────────────────────────────────
   `paintPage()` 每 3 秒把 `#page` 整个 `innerHTML` 重建一次（数据新鲜度靠它），
   代价是**所有住在 DOM 上的状态都会被抹掉**。用户实测到的两条症状都来自这里：

     · 「展开后几秒自己收回去了」—— `<details>` 的 `open` 是**元素属性**，
       重建即回默认（收起）。用户截图点的就是扮演规则那张卡的
       「看看这 10 条到底是什么」。
     · 「滚到一半被强制拉回去」—— 任何容器的 `scrollTop` 归零。

   ⚠️ 这两件事**都不是"有人写了个定时器几秒后收回"**（全文件查过：没有任何
      "过几秒自动关"的定时器）。所以修法只有一个：**重建前采集、重建后恢复** ——
      而不是去关掉重绘（数据还得靠它更新，那是另一件事）。

   ⚠️ 键用**路径**（`#page` 下的 children 索引链）而不是 id / class：这些元素
      大多没有 id（一页里好几张同类卡片）。路径在"结构没变"时稳定；结构真的
      变了（列表条数变化）时对不上就**安静跳过** —— 比错位恢复好。
   ⚠️ 键里带 `gi/si`：不然切页之后，新页面的第 3 个容器会套上旧页面第 3 个
      容器的滚动位置，表现是"一打开就发现页面滚了一半"。
   ⚠️ `KEEP_SEL` 是**登记制**：以后新加滚动容器 / 新折叠块要登记进来。漏登记
      不报错，只会又变成"它自己跳回去了" —— 本项目最怕的那类静默失败。
   ══════════════════════════════════════════════════════════════════════════ */
const KEEP_SEL = ['details', '.scroll-y', 'pre', '.det > *'];

/** `#page` 下的子节点索引链（如 `3.1.0`）—— 重建前后同形即同键。 */
function elPathOf(el, root) {
  const parts = [];
  for (let n = el; n && n !== root; n = n.parentElement) {
    const p = n.parentElement;
    if (!p) return '';
    parts.push([].indexOf.call(p.children, n));
  }
  return parts.reverse().join('.');
}

function keepPageState() {
  const root = $id('page');
  if (!root) return null;
  /* 键取"上一次 commit 给 `#page` 盖的章"，**不是** S.gi/S.si ——
     点击处理器已经把 S.* 改成目标页了，用它们采集到的旧 DOM 会被盖上**新页**的键，
     于是 restore 的守卫形同虚设（「运行」日志 pre 的 scrollTop 会被恢复到
     「人设」同路径节点上），换域时还白遍历一遍旧 DOM。 */
  if (S.extra.paintKey !== S.gi + '/' + S.si) return null;
  const det = []; const sc = [];
  for (const sel of KEEP_SEL) {
    root.querySelectorAll(sel).forEach((el) => {
      const k = elPathOf(el, root);
      if (!k) return;
      if (el.tagName === 'DETAILS') { if (el.open) det.push(k); }
      else if (el.scrollTop > 0) sc.push([k, el.scrollTop]);
    });
  }
  const y = window.scrollY || 0;
  if (!det.length && !sc.length && y < 100) return null;
  return { page: S.extra.paintKey, det, sc, y };
}

function restorePageState(keep) {
  if (!keep || keep.page !== S.gi + '/' + S.si) return;
  const root = $id('page');
  if (!root) return;
  const find = (k) => {
    let n = root;
    for (const i of k.split('.')) { n = n && n.children[+i]; }
    return n || null;
  };
  for (const k of keep.det) {
    const el = find(k);
    if (el && el.tagName === 'DETAILS') el.open = true;
  }
  const later = [];
  for (const [k, v] of keep.sc) {
    const el = find(k);
    if (!el) continue;
    el.scrollTop = v;
    /* 内容 / 字体还没落定时 scrollTop 会被 clamp —— 只补一帧，不轮询。 */
    if (el.scrollTop !== v) later.push([el, v]);
  }
  /* 整页滚动**只在"被弹回顶部"时**补：用户正在往下滚的时候不许动它
     （容器内滚动则相反 —— 那个位置必须补回来，否则就是用户说的"拉回去"）。 */
  if (keep.y > 100 && (window.scrollY || 0) < 8) later.push([window, keep.y]);
  if (later.length) {
    requestAnimationFrame(() => {
      for (const [el, v] of later) { try { el.scrollTo(0, v); } catch { el.scrollTop = v; } }
    });
  }
}

/* ════════════════════════════════════════════════ 8. 页面渲染 ═══ */
let pagePaintSeq = 0;
let pagePaintPending = false;

function syncNav1Selection() {
  document.querySelectorAll('#nav1 .grp').forEach((b, i) => b.setAttribute('aria-selected', String(i === S.gi)));
}
function syncNav2Selection() {
  document.querySelectorAll('#nav2 .sub').forEach((b, i) => b.setAttribute('aria-selected', String(i === S.si)));
  syncNav2Indicator(false);
}

function paintPage(rebuildNav = true, nav = {}) {
  /* 连点/切页只保留最后一次排队的内容渲染；3 秒轮询撞上排队时让路。 */
  if (!rebuildNav && pagePaintPending) return;
  const paintSeq = ++pagePaintSeq;
  pagePaintPending = false;
  const rebuildNav1 = rebuildNav && nav.nav1 !== false;
  const rebuildNav2 = rebuildNav && nav.nav2 !== false;
  /* ⚠️ 只在**切页**（rebuildNav）时关右键浮层，**不在 3 秒轮询时关**：
     轮询每 3 秒把 `#page` 重建一次，若每次都关，菜单活不过 3 秒（用户还没看清就没了）。
     安全前提：动作只认打开时捕获的 `b.id`，不回头查 DOM ⇒ 轮询换掉节点不影响点击。 */
  if (rebuildNav) {
    closeCtxMenu();
    /* 同 group 的二级切换：nav1/nav2 结构没变，只改选中态，不重建、不重启动 dock 宽度动画。
       只有换域时才重建 nav1/nav2（二级全称决定 dock 宽度要重新量）。 */
    if (rebuildNav1) renderNav1(); else syncNav1Selection();
    if (rebuildNav2) renderNav2(); else syncNav2Selection();
    psnCloseArt(); psnHelpHide(true); psnChartHide(); psnLineHide();
    ovDestroy();
  }
  else {
    syncNav1Selection();
    syncNav2Selection();
  }
  const g = GROUPS[S.gi], su = currentSub(), page = $id('page');
  /* 工厂三页：`#page[data-frame]` 是「当前显示哪一帧」的唯一来源。
     3 秒轮询会重复走到这里 —— 同值不写，避免 MutationRecord 让工厂层重播入场。 */
  const frameSrc = su.frame || '';
  if ((page.dataset.frame || '') !== frameSrc) {
    if (frameSrc) page.dataset.frame = frameSrc;
    else delete page.dataset.frame;
  }
  document.body.classList.toggle('is-frame-page', !!frameSrc);
  syncNavAuto(!!frameSrc && S.gi === FACTORY_GI);
  /* ⚠️⚠️ 首屏**不许**先摆一屏"演示数据"（2026-10-12 · 真机截图抓到的现象）：
     面板发来的页面在拿到第一份 /api/state 之前 `S.state` 是 null，
     而下面所有渲染都写着 `S.state || DEMO` ⇒ 用户看到的是**一屏看起来很正常的假数据**
     （机器人没在跑 / 实例数 0 / 容器未检测 / pid 0），几秒后真实数据到了又整屏换掉 ——
     观感就是"这页闪了一下，还都是错的"。诚实做法：**没数据就先说没数据**。
     （原型模式 `!HAS_TOKEN` 不在此列：那种场合演示数据就是它的用途。）
     工厂页不需要 /api/state；若也走这条早退，host 会盖住「正在连接」。 */
  if (!S.state && HAS_TOKEN && !su.frame) {
    const msg = S.bootTried
      ? '读不到控制台后端 —— 已断开，正在每 3 秒重试。\n如果一直这样：双击桌面上的「Estrella Bot」图标重新打开控制台。'
      : '正在连接控制台…';
    page.dataset.domain = 'none';
    page.className = 'page';
    page.innerHTML = `<div class="wrap-head" style="grid-column:span 12;">
        <h1 style="font-size:var(--t-2xl);">正在连接</h1>
      </div>
      <section class="card" style="grid-column:span 12;"><div class="empty" style="white-space:pre-wrap;">${esc(msg)}</div></section>`;
    return;
  }
  /* 指示器每次都对齐一次：首次 `jump`（不飞）、之后 `animate`（滑过去）。
     判断住在 `syncNavIndicator` 内部（靠 `ind.inited`），这里不摆第二份。 */
  syncNavIndicator(false);
  /* 空白占位页（通用能力，当前无页面使用）：
     页面不挂内容，只保留导航按钮。 */
  if (su.blank) {
    page.dataset.domain = 'none';
    S.extra.psnHtml = null;
    page.className = 'page page--blank';
    if (page.firstChild) page.innerHTML = '';
    S.reg = new Map();
    return;
  }
  /* 全幅工具页（2026-10-27 · 工厂三页）：
     工厂是自带顶栏/布局的成品单文件，不适合再套 .card。iframe 由 factory-frame.js
     挂在 #page 之外的固定层里并提前预热 —— 3 秒轮询只清空 #page，不碰那个常驻节点，
     所以切页不重载、未点「应用到控制台」的调参也不会丢。 */
  if (su.frame) {
    page.dataset.domain = 'none';
    S.extra.psnHtml = null;
    page.className = 'page page--frame';
    if (page.firstChild) page.innerHTML = '';
    S.reg = new Map();
    return;
  }
  S.reg = new Map();
  /* 运行总览：按卡片补丁，避免 3 秒轮询把折线 hover / 热力格动画 / 折叠状态整块重建掉。 */
  if (g.id === 'run' && su.id === 'overview') {
    paintOverviewPage(su, rebuildNav);
    return;
  }
  const isPersona = g.id === 'persona';
  /* 页面内容（S.reg / HTML / innerHTML / mount）收进闭包：
     - 轮询：同步执行，保持现有行为；
     - 切页：nav 先更新，内容双 rAF 后再画 —— 让 nav 动画至少先占一帧，
       不让 10–30KB HTML、SVG 与 textarea 布局把它挤掉；
     - 连点用 pagePaintSeq 让旧帧失效；排队期间 3 秒轮询让路。 */
  const commit = () => {
    if (pagePaintSeq !== paintSeq) return;
    /* 人设页的字段 id 每次渲染都从 1 开始，HTML 才会逐字稳定 —— 3 秒轮询靠它 skip-redraw。
       2026-10-26：PSN_UID 无条件自增时，同一页每次生成不同的 input id，轮询永远判"内容变了"，
       整页 page-in 每 3 秒重播一次（人设页连续闪；二级切换偶尔撞上轮询就双动画）。 */
    S.reg = new Map();
    if (isPersona) PSN_UID = 0;
    const uidMark = PSN_UID;
    const buildHtml = () => `
      <div class="wrap-head" style="grid-column:span 12;">
        <h1 style="font-size:var(--t-2xl);">${esc(su.title || su.label)}</h1>
        ${su.desc ? `<p class="hint" style="margin:6px 0 0;max-width:80ch;">${su.desc}</p>` : ''}
        <p class="hint" style="margin:4px 0 0;">${esc(g.label)} → ${esc(su.label)}</p>
      </div>
      ${cardsHtml(su.cards || [])}`;
    /* 第一趟：完整页面（图表载荷同时登记进 psnChartSlots，供停稳后回填）。
       ⚠️ `psnChartSlots` 在生成期间是"本趟的收集器"，但**不能把上一趟待放行的载荷冲掉**：
       3 秒轮询走同一条 commit，它命中 skip-redraw 会立刻 return —— 那份载荷还得留着
       给还没执行的放行用，否则壳永远空着（实测踩到：槽 0/4 但已经 psn-armed）。 */
    PSN_STAGE = 'full';
    const slots = isPersona && rebuildNav ? new Map() : null;
    const pendingSlots = psnChartSlots;
    psnChartSlots = slots;
    const html = buildHtml();
    psnChartSlots = pendingSlots;
    /* 非人设页轮询也做同一件事：HTML 逐字相同就不重建 DOM。
       带秒级计时/相对时间的页面字符串自然不同，命中不了就照旧重建 —— 不做归一化猜测。 */
    const htmlKey = S.gi + '/' + S.si;
    if (!isPersona && !rebuildNav && page.dataset.domain === g.id
        && html === S.extra.pageHtml && S.extra.pageHtmlKey === htmlKey) {
      S.extra.paintKey = htmlKey;
      if (window.__paintStats) window.__paintStats.skips += 1;
      markDirty();
      return;
    }
    if (!isPersona) {
      S.extra.pageHtml = html;
      S.extra.pageHtmlKey = htmlKey;
      if (window.__paintStats) window.__paintStats.builds += 1;
    }
    /* 人设域每 3 秒轮询一次；内容没变就不重建 DOM —— 否则 hover/浮层/动画/输入焦点
       每 3 秒被重置一次（原型里这些状态是连续的）。其他域保持原来的重建节奏。 */
    if (isPersona && !rebuildNav && html === S.extra.psnHtml) {
      markDirty();
      return;
    }
    /* `psnHtml` 缓存**只存完整趟**：轮询的逐字比较拿的必须是与 DOM 一致的那一份。 */
    S.extra.psnHtml = isPersona ? html : null;
    /* 第二趟（只在换域进人设有图表的总览时）：生成"壳" —— 卡框/文案/图例逐字相同，
       只把图表载荷留空。槽位为空就说明这页没有图表，不分段、照旧一次画完。 */
    let staged = false;
    let shellHtml = html;
    if (isPersona && rebuildNav && slots && slots.size) {
      PSN_UID = uidMark;
      S.reg = new Map();
      PSN_STAGE = 'shell';
      psnChartSlots = null;   /* 壳趟不许登记载荷 */
      try { shellHtml = buildHtml(); } finally { PSN_STAGE = 'full'; }
      staged = true;
    }
    page.dataset.domain = g.id;
    page.className = 'page';    /* 分段渲染的动画闸门：壳从出生起就不许播入场，等 psnArmAndFill 撤掉它。 */
    if (staged) page.classList.add('psn-stage');
    /* 非切页（数据轮询 / 局部动作）真的要换内容时，才给 #page 挂 no-enter：
       新 DOM 不重播整页入场；放在 skip 之后是关键 —— 轮询跳过时不能去动
       正在播的切页 page-in，否则动画会被 animation:none 拦腰掐断。 */
    if (isPersona && !rebuildNav) page.classList.add('psn-no-enter');
    const keep = keepPageState();   /* ⚠️ 必须在 `innerHTML =` **之前**采集 */
    page.innerHTML = staged ? shellHtml : html;
    restorePageState(keep);         /* ⚠️ 必须在**之后**恢复 —— 顺序反了就等于没修 */
    /* 盖章：`#page` 这一份 DOM 属于哪一页。下一次采集用它判断"是不是同一页"，
       换页/换域时不拿旧容器的滚动位置去污染新页。 */
    S.extra.paintKey = S.gi + '/' + S.si;
    markDirty();
    auditActions();
    onPageShown(su);
    /* 落图排在导航时间线之后：dock 还在动就等它停稳，否则下一帧。 */
    if (staged) { psnChartSlots = slots; psnScheduleArm(); }
    else psnChartSlots = null;
  };
  if (!rebuildNav) { commit(); return; }
  pagePaintPending = true;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (pagePaintSeq !== paintSeq) return;
    pagePaintPending = false;
    commit();
  }));
}

/**
 * 卡片列表 → HTML。**连续**同 `col` 的卡片会被聚进一个列容器。
 *
 * 为什么需要这一层（2026-10-17 · 「插话冷却」落点）：
 *   `span-6` 只表达"多宽"，两张 span-6 之后的第三张会按 auto-flow 回到**左列**；
 *   更糟的是同一行的两张卡被**行高对齐**——左列 507px、右列 291px 时，
 *   第三张卡只能从 507px 的底部开始，于是它离上一张（拉黑）有 216px 的空洞。
 *   红框要的是"紧贴拉黑下方"，那就得让右列两张卡成为**同一个列容器里的兄弟**，
 *   各自按内容高度堆叠。
 *
 * ⚠️ 只聚合**相邻**的 `col`：`[A, B(r), C, D(r)]` 会得到 A / B / C / D 四块
 *    （两个单卡容器），不会把不相邻的右列卡硬凑成一个块 —— 那会静默改变
 *    作者在 schema 里写下的顺序。
 */
function cardsHtml(cards) {
  const list = cards.filter((c) => !c.when || c.when(S.state || DEMO));
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (!list[i].col) { out.push(cardHtml(list[i])); continue; }
    const col = list[i].col;
    const group = [];
    while (i < list.length && list[i].col === col) group.push(list[i++]);
    i--;
    out.push(`<div class="card-col">${group.map((c) => cardHtml(c)).join('')}</div>`);
  }
  return out.join('');
}

function cardHtml(c) {
  if (c.bare) return bareHtml(c);
  const span = c.span === 3 ? 'span-3'
    : c.span === 6 ? 'span-6'
      : c.span === 4 ? 'span-4'
        : c.span === 8 ? 'span-8' : '';
  const tone = c.tone ? ` data-tone="${esc(c.tone)}"` : '';
  const badge = c.badge ? `<span class="${c.badge.cls || 'tag'}">${esc(c.badge.text)}</span>` : '';
  const body = (c.ctrls || []).filter((x) => !x.when || x.when(S.state || DEMO)).map((x) => ctrlHtml(x)).join('');
  if (c.fold) {
    return `<details class="card ${span} ov-fold" id="card-${esc(c.id)}"${tone}>
      <summary class="card-h"><h2>${esc(c.title)}</h2>${badge}<span class="spacer"></span><svg class="ov-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></summary>
      <div class="card-b">${c.desc ? `<div class="card-d">${mdBold(c.desc)}</div>` : ''}${body}</div>
    </details>`;
  }
  return `<section class="card ${span}" id="card-${esc(c.id)}"${tone}>
    <div class="card-h"><h2>${esc(c.title)}</h2>${badge}<span class="spacer"></span></div>
    ${c.desc ? `<div class="card-d">${mdBold(c.desc)}</div>` : ''}
    <div class="card-b">${body}</div>
  </section>`;
}

/**
 * **裸容器通道**（`bare: true`）：控件内容直接落到页面栅格里，**不套 .card**。
 *
 * ⚠️ 为什么需要它（用户 2026-10-04 截图点名）：插件页原来是
 *   「一张 span-12 .card」→「.card-b」→「.pgrid」→ 13 块 .pcard。
 *   也就是说**外面还罩着一整块大玻璃板**，用户要的是「每个插件一块独立玻璃板」，
 *   看到的却是「一块大玻璃板里切了 13 块」。多出来的那层不是设计，是容器。
 *
 * ⚠️ 这条通道**只脱掉 .card 这一层**，不碰控件自己的结构：
 *   · 控件吐什么（pluginList 仍吐 .pgrid > .pcard）由渲染器负责，容器不加工；
 *   · .card-h / .card-d 在 bare 下**一并省掉** —— 它们是「卡片标题栏」，
 *     裸容器没有卡片，留一个悬空的 h2 反而更怪（要标题就写进控件自己）；
 *   · .card-b 的 padding 也一并省掉，否则网格四周多出一圈不属于任何一块板的留白，
 *     板与背景之间就有第二道「边」—— 那还是容器感。
 *
 * ⚠️ **别把它当通用开关**：只有「内容自己就是完整的板集合」才用 bare
 *   （目前只有插件网格一处）。普通卡片一律走原路径。
 */
function bareHtml(c) {
  const span = c.span === 3 ? 'span-3' : c.span === 6 ? 'span-6' : '';
  const body = (c.ctrls || []).filter((x) => !x.when || x.when(S.state || DEMO)).map((x) => ctrlHtml(x)).join('');
  return `<div class="bare ${span}" id="card-${esc(c.id)}">${body}</div>`;
}

/* ── 单个控件 ── */
function ctrlHtml(x) {
  const fn = RENDER[x.t];
  if (!fn) {
    return `<div class="row" style="border-color:var(--c-danger-line);background:var(--c-danger-bg);color:var(--c-danger);">
      <b>schema 里用了没实现的控件类型：${esc(x.t)}</b>
      <span class="hint bad">在 app.js 的 RENDER 表里补一个同名函数，或把 schema.js 里那一项改掉 —— 静默跳过等于页面上少一个控件，没人会往这上面想。</span></div>`;
  }
  try { return fn(x); } catch (e) { return `<div class="row"><span class="hint bad">渲染「${esc(x.t)}」时出错：${esc(e.message)}</span></div>`; }
}

const lb = (x, extra = '') => `<span class="f-lb"><span>${esc(x.label || '')}</span>${extra}</span>`;
/* ── 进度条的刻度换算（`range` 控件 · 2026-10-17）───────────────────────────
   位置用 **0–1000 的整数**，不用 0–100 的小数：原生 `input[type=range]` 的 value
   是字符串，整数步进能保证"拖到同一格 ⇒ 同一个值"，也省掉浮点在 aria 文案里冒出来的尾数。

   ⚠️ `log: true` 时**必须** min > 0 —— `Math.log(0)` 是 -Infinity，那条分母会把整条
      刻度压成 NaN，而 NaN 在 CSS 里是"无值"：滑块会照常渲染、位置却回到最左，
      症状与"保存失败"一模一样。所以这里显式回落成线性。 */
function rngPosOf(x, v) {
  const lo = Number(x.min ?? 0), hi = Number(x.max ?? 100);
  const n = Math.min(hi, Math.max(lo, Number(v) || 0));
  if (!(hi > lo)) return 0;
  const log = !!x.log && lo > 0;
  const t = log
    ? (Math.log(n) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))
    : (n - lo) / (hi - lo);
  return Math.round(Math.min(1, Math.max(0, t)) * 1000);
}
function rngValOf(x, pos) {
  const lo = Number(x.min ?? 0), hi = Number(x.max ?? 100);
  const t = Math.min(1, Math.max(0, Number(pos) / 1000));
  const log = !!x.log && lo > 0;
  const v = log ? Math.exp(Math.log(lo) + t * (Math.log(hi) - Math.log(lo))) : lo + t * (hi - lo);
  return Math.round(v);
}
/** 分钟 → 人话。`fmtDur` 喂的是毫秒、且会把整点说成"1 小时 0 分"，这里要的是"1 小时"。 */
function fmtMin(n) {
  const m = Math.round(Number(n) || 0);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60), rest = m % 60;
  return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}
/** 控件声明的单位 → 读数字。目前只有「分钟」一种（毫秒级的量不该用滑块表达）。 */
/** 滑块读数：控件可给 `fmt(v)` 自定义（毫秒/倍率/比例），否则按单位拼。 */
const rngFmt = (x, v) => {
  if (typeof x.fmt === 'function') return x.fmt(v);
  return x.unit === '分钟' ? fmtMin(v) : `${v} ${x.unit || ''}`.trim();
};
const hintOf = (x) => {
  const h = typeof x.hint === 'function' ? x.hint(S.state || DEMO) : x.hint;
  return h ? `<span class="hint">${mdBold(h)}</span>` : '';
};
const noteHtml = (text, kind) => `<div class="card-b" style="padding:0;"><div class="hint ${kind || ''}" style="line-height:1.6;">${mdBold(text)}</div></div>`;

/** 注册一个可交互控件，返回它的 html id */
function reg(x, node) { S.reg.set(x.id, x); return node; }
const did = (x) => `data-id="${esc(x.id)}"`;
/** 把控件登记进当前页的登记表 —— 事件处理要靠它拿回 bind / save，缺了就是"点了没反应"。 */
const regd = (x) => { S.reg.set(x.id, x); return ''; };
/** 控件的动作属性：有 save/bind 的走统一入口，其余只存本地。 */
const ctlA = (x) => `${did(x)} data-a="${x.save || x.bind || x.bindSys ? 'field' : 'field-local'}"`;

/* ══════════════════════════════════════════════════════════════════════════
   长列表封顶（2026-10-04）
   ──────────────────────────────────────────────────────────────────────────
   卡片里的长列表**默认只渲染前 N 条**，余下的藏在「展开」后面。

   ── 为什么必须封顶 ───────────────────────────────────────────────────
     结构化记忆 / 群友档案 / 历史存量 / 额度情报 这类列表会**随数据一直长**
     （实测：额度情报页 40 条）。卡片因此能长到几千像素，而 `markTiltables()`
     把倾斜挂在 `section.card` 上 —— 卡片越高，同样 1° 的上下边缘位移越大，
     读起来就是「鼠标放上去倾斜很大」。
     ⇒ **修的是长度，不是倾角**：`tilt.js` 与 `MAX_DEG` 一行没动。

   ── 为什么是"截断"而不是"容器里滚动" ─────────────────────────────────
     `paintPage()` 每 3 秒重建一次 `#page` ⇒ 任何容器的 `scrollTop` 都会归零，
     "滚到一半自己弹回顶部"比"列表长"更难用。截断不依赖滚动位置；
     展开态存 `S.extra.open`（**纯 UI 状态**：不进 config、不落盘、刷新即折叠），
     它活得过重绘靠的正是这一点。

   ⚠️ **唯一实现**：长列表一律走 `capRows` / `capChips`，不要在渲染器里各自
      `.slice()` —— 那会把"上限是多少"变成 N 个互相不知道的数字。
   ⚠️ `kind` 必须是**稳定字符串**（展开态的键）。写错的表现是"点了展开又弹回"。
   ⚠️ `rowFn(item, i)` 里的 `i` 是**原数组下标**，不是切片下标 —— 可编辑列表
      （手动记忆）靠它定位要改哪一条，用切片下标会**改错行**。
   ══════════════════════════════════════════════════════════════════════════ */
const LIST_CAP = 15;   // 经验值：约一屏卡片高，再多就开始"翻不到"
const CHIP_CAP = 12;   // 概览 chip 是摘要（**不展开**）：超出只追加一个「还有 N 条」

const listOpen = (kind) => !!(S.extra.open && S.extra.open[kind]);

function capRows(list, kind, rowFn) {
  const total = list.length;
  const open = total > LIST_CAP && listOpen(kind);
  const pairs = list.map((it, i) => [it, i]).slice(0, open ? total : LIST_CAP);
  const rows = `<div class="rows${open ? ' scroll-y capped' : ''}">${pairs.map(([it, i]) => rowFn(it, i)).join('')}</div>`;
  if (total <= LIST_CAP) return rows;
  const bar = open
    ? `<div class="btn-row"><button class="btn btn-xs" data-a="list.fold" data-p="${esc(kind)}">收起</button>
        <span class="hint">共 ${total} 条 · 已全部列出</span></div>`
    : `<div class="btn-row"><button class="btn btn-ghost btn-sm" data-a="list.more" data-p="${esc(kind)}">展开剩下 ${total - LIST_CAP} 条</button>
        <span class="hint">只列了前 ${LIST_CAP} 条 · 共 ${total} 条</span></div>`;
  return rows + bar;
}

/** chip 列表的封顶：**只截断不展开** —— 概览卡的职责是摘要，详表在各自那张卡里。 */
function capChips(items, chipFn) {
  const shown = items.slice(0, CHIP_CAP);
  const rest = items.length - shown.length;
  return shown.map((it, i) => chipFn(it, i)).join('')
    + (rest > 0 ? `<span class="chip">还有 ${rest} 条</span>` : '');
}

/**
 * 「启动链路」**空态**显示的检查表 —— 2026-10-14 立，同日加到 5 行。
 *
 * 为什么要有它：维护者点了一次「一键启动」，失败了，而原因是"模型的 API Key 没填"。
 * 那条信息其实**一直在**（`schema.js` 的 `config.hasKey` → 「尚未配置」），
 * 但它在「模型 → 云端设置」页里 —— 人得先想到去那儿看。于是空态从
 * 「还没有动作」变成一张**只摆事实的检查表**：一眼看出"还差什么、去哪儿补"。
 *
 * ⚠️ 纪律（破了就会长出第二个真相源）：
 *   ① **只读 `/api/state` 里已有的字段**（`ports.*` / `panel.pid` / `bridge.running` /
 *      `config.hasKey` / `config.groups`）—— 与 `banners()` 用的是同一套读法，这里不另算。
 *   ② **可以摆"配置填没填"这个事实，但不许下"能不能启动"的结论。**
 *      "白名单为空 ⇒ 拒绝启动"那条判据住在 `src/config.js`，它的注释明确反对在面板里
 *      复制一份（"复制一份白名单判据，就一定会与机器人那一份漂开"）——
 *      那条结论还依赖 `allowAllWhenEmpty`，抄过来必然漂。
 *      ⇒ 所以群聊那一行**只说"填没填、去哪儿填"**，不说"不填就启动不了"。
 *      （2026-10-14 维护者要求把这一项摆出来：最容易忘的就是它。）
 *   ③ 文案里写的是**去哪一页改**（面板导航名），与 `src/config.js` 那条报错同一写法。
 *
 * 返回顺序 = **该动手的先后**：协议端 → 控制台 → Key → 放行的群聊 → 机器人本体。
 * 渲染时把**第一个 `ok: false`** 标成 `data-cur="1"`（复用 `.stp` 现成样式：实心点 + 强调环），
 * 视线自然落到"最该先处理的那一件"上 —— 本项目一贯的"把判断交给视觉，别让人读字符串"。
 */
function readyChecklist(s) {
  const wsOk = j(s, ['ports', 'onebotWs']) === true;
  const httpOk = j(s, ['ports', 'onebotHttp']) === true;
  const wsNo = j(s, ['ports', 'onebot', 'ws'], '');
  const httpNo = j(s, ['ports', 'onebot', 'http'], '');
  const hasKey = j(s, ['config', 'hasKey']) === true;
  const keyNeeded = j(s, ['config', 'keyNotNeeded']) !== true;
  const botRunning = j(s, ['bridge', 'running']) === true;
  /* 只取**个数**，不把群号打印到检查表里 —— 群号是真实标识符，
     这一块又常被整屏截给别人看；要核对具体是哪几个，去「触发方式」那一页看。 */
  const groupCount = (j(s, ['config', 'groups'], []) || []).length;
  const privateCount = (j(s, ['config', 'privateUsers'], []) || []).length;
  const ownerCount = (j(s, ['config', 'owners'], []) || []).length;
  const cfgSource = j(s, ['config', 'source'], 'config.json');

  const agent = j(s, ['ports', 'onebotAgent'], null);
  const botHealth = agent?.bot || null;
  /* 时刻显示成 HH:MM:SS：两个来源（面板探测 / 机器人心跳）要能一眼对表，
     相对时间（"3 秒前"）反而会把"两个时刻差了多少"藏起来。 */
  const hhmmss = (ms) => {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '—';
    const d = new Date(n);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((x) => String(x).padStart(2, '0')).join(':');
  };

  const ok = wsOk && httpOk;
  /* 事件流与端口分开判（B3）：端口全绿而事件流已死，正是"看起来正常、其实不回话"的那一格。
     `account-offline` 必须明说"不要重启协议端" —— 重启替代不了重新登录，只会多一次风控。 */
  const live = j(s, ['onebot', 'verdict'], 'unknown');
  const liveInfo = {
    ok: { ok: true, txt: '事件流：正常（心跳与连接都在）' },
    unknown: { ok: true, txt: '事件流：暂无可判数据（机器人可能刚启动）' },
    'port-only': { ok: false, txt: '事件流：端口在听，但机器人没收到任何帧 —— 先确认机器人已连上，别急着扫码' },
    'ws-down': { ok: false, txt: '事件流：WS 没连上 —— 协议端在跑的话，看它是否允许 3001 的 OneBot 连接' },
    'account-offline': { ok: false, txt: '事件流：QQ 账号已掉线 —— **不要重启协议端**，等它自己重登或重新扫码' },
    stalled: { ok: false, txt: '事件流：心跳已停摆 —— 看门狗会主动断开并按既有退避重连' },
    'actions-dead': { ok: false, txt: '事件流：帧还在，但动作探测连败 —— 协议端可能半死，先看日志再决定是否重启' },
    down: { ok: false, txt: '事件流：HTTP 与 WS 都不通 —— 协议端没起来，或端口与配置对不上' },
  }[live] || { ok: false, txt: `事件流：${live}` };
  const qqOnline = agent?.selfOnline;
  const qqOk = qqOnline === true && live !== 'account-offline';
  const qqText = live === 'account-offline'
    ? 'QQ 账号：已掉线 —— 重新扫码，不要重启协议端'
    : qqOnline === true
      ? 'QQ 账号：自报在线'
      : qqOnline === false
        ? 'QQ 账号：自报离线 —— 等它重登或重新扫码'
        : 'QQ 账号：状态未知（协议端没自报）';
  const out = [
    { ok: qqOk, group: 'qq', txt: qqText },
    { ok, group: 'proto',
      txt: `协议端：WS ${wsNo || '—'} ${wsOk ? '在听' : '没在听'} · HTTP ${httpNo || '—'} ${httpOk ? '通' : '不通'}`
        + (ok ? '' : ' —— 点「重启协议端」把协议端拉起来（首次要扫码）') },
    { ...liveInfo, group: 'proto' },
    /* 协议端**自报**的身份与版本（2026-10-20 补，数据来自同一处探测：
       `panel/lib/state-collector.js` 的 `/get_version_info` + `/get_status`）。
       上一行只说"有没有人答 HTTP"，这一行说"答的是谁、报的哪一版"——
       换协议端或版本与 QQ 客户端对不上时，这是第一眼线索。
       ⚠️ 这一行**恒绿**（只摆事实）：有的家没实现这两条动作（LLBot 未取证、官方群侧无此端点），
          把"它没答"报成故障等于把"这家没实现"说成"我方坏了"；而 `online/good` 是自报值，
          有的家写死 true，不能拿来当健康判据。 */
    { ok: true, group: 'proto',
      txt: agent && agent.answered
        ? `协议端自报：${agent.appName || '未报名称'} ${agent.appVersion || '—'}`
          + ` · OneBot ${agent.protocolVersion || '—'}`
          + (agent.statusAnswered
            ? ` · 自报 online=${agent.selfOnline ? 'yes' : 'no'} good=${agent.selfGood ? 'yes' : 'no'}（自报值，不作健康判据）`
            : '')
        : '协议端自报：这一家没有回答 get_version_info（NapCat / SnowLuma / Lagrange 有实现，'
          + 'LLBot 未取证、官方群侧没有这个端点）—— 不影响使用' },
    /* 机器人侧看到的协议端连接（B6 · 双时刻）：与上一行**并排**，不合并 ——
       上一行是"面板此刻问到了什么"，这一行是"机器人守着的 WS / 心跳 / 超时"。
       两个来源的采样周期不同（面板 3 秒轮询、机器人 20 秒刷快照），合成一句会让人
       以为它们是同一时刻的事实。⚠️ 恒绿：机器人没在跑 / 还没到第一次快照都只是
       "没有数据"，不是故障。 */
    { ok: true, group: 'app',
      txt: botHealth
        ? `机器人心跳：${botHealth.connected ? 'WS 已连' : 'WS 未连'}`
          + ` · 最后心跳 ${hhmmss(botHealth.lastHeartbeatAt)}`
          + (Number(botHealth.heartbeatIntervalMs) > 0
            ? `（间隔 ${Math.round(Number(botHealth.heartbeatIntervalMs) / 1000)}s）`
            : '（后端未报间隔）')
          + ` · 状态探测 ${botHealth.lastStatusOk === true ? '正常'
            : botHealth.lastStatusOk === false ? '失败' : '还没问过'}`
          + ` · 动作超时 ${Number(botHealth.timeouts) || 0} 次`
          + ` · 面板探测 ${hhmmss(agent?.probedAt)}`
        : `机器人心跳：机器人未在跑或还没到第一次快照（面板探测 ${hhmmss(agent?.probedAt)}）` },
    { ok: true, group: 'app', txt: `控制台：pid ${j(s, ['panel', 'pid'], '—')} 运行中` },
  ];
  /* Key 只有**云端大脑**才需要（`keyNotNeeded` 是本机模型那一路）——
     本机模型下不摆这一行，免得说一句不适用的话。 */
  if (keyNeeded) {
    out.push({ ok: hasKey, group: 'app',
      txt: hasKey
        ? '模型的 API Key：已填'
        : '模型的 API Key：还没填 —— 去「模型 → 云端设置」填上（不填的话机器人起得来，但一被叫到就回不了话）' });
  }
  /* 放行的群聊（2026-10-14 维护者要求加，插在 Key 与机器人本体之间）：
     "配了哪些群"是最容易忘的一步 —— 装好了、灯全绿，群里却没人理，多半是它。 */
  out.push({ ok: groupCount > 0, group: 'app',
    txt: groupCount > 0
      ? `放行的群聊：${groupCount} 个`
      : '放行的群聊：还没填 —— 去「发言 → 触发方式 → 放行的群号」把允许它说话的群号填上' });
  /* 私聊与主人（2026-10-21）：私聊报告的真因就是这两格都空 ——
     "加了白名单却没生效"在界面上没有任何反馈，用户只能以为它坏了。 */
  out.push({ ok: privateCount > 0 || ownerCount > 0, group: 'app',
    txt: (privateCount > 0 || ownerCount > 0)
      ? `私聊：放行 ${privateCount} 人${ownerCount ? ` · 主人 ${ownerCount} 人（会自动补进私聊）` : ''}`
      : '私聊：白名单为空 —— 谁私聊它都不会回。去「发言 → 触发方式 → 同意私聊的 QQ 号」填上；配「主人 QQ」也会自动补进去' });
  /* 配置来源（2026-10-21）：没有 config.json 时机器人读的是模板，而面板保存写的是 config.json。
     用户看到"保存成功"却不生效，原因就在这一格。 */
  out.push({ ok: cfgSource === 'config.json', group: 'app',
    txt: cfgSource === 'config.json'
      ? '配置文件：config.json'
      : '配置文件：正在用 config.example.json 模板 —— 面板保存不会写进模板，先点一次「保存」生成 config.json' });
  out.push({ ok: botRunning, group: 'app',
    txt: botRunning
      ? '机器人本体：在跑'
      : '机器人本体：没在跑 —— 点右上角「一键启动」；点完的进度会显示在这一块里' });
  return out;
}

/* ══════════════════════════════════════════════════════════════════════
   运行总览（2026-10-27）
   ──────────────────────────────────────────────────────────────────────
   三栏：左链路 / 中仪表盘 / 右操作与图表。
   3 秒轮询只替换**内容变了的卡**（见 paintOverviewPage），否则折线 hover、
   热力格动画和 details 展开状态每 3 秒都会被整块重建掉。
   ══════════════════════════════════════════════════════════════════════ */
const _ovOpen = new Map();
const _ovSeenDone = new Set();
const _ovSeenGroups = new Set();
let _ovMount = null;
let _ovTipBound = false;
let _ovLineHide = null;
let _ovCards = new Map();
let _ovOrder = '';

const ovPad2 = (n) => String(n).padStart(2, '0');
const ovN = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const ovArr = (v) => (Array.isArray(v) ? v : []);
const ovCountOf = (v) => (Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0));
const ovFmtTokens = (n) => {
  const v = Math.max(0, ovN(n));
  if (v >= 1e6) return `${(v / 1e6).toFixed(2).replace(/\.00$/, '')}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(v));
};
const ovFmtMoney = (n) => {
  const v = ovN(n);
  if (!v) return '¥0.00';
  if (v < 0.1) return `¥${v.toFixed(4)}`;
  if (v < 1) return `¥${v.toFixed(3)}`;
  return `¥${v.toFixed(2)}`;
};
const ovPct = (n) => `${Math.round(ovN(n) * 1000) / 10}%`;
const ovTime = (t) => {
  const d = new Date(ovN(t, Date.now()));
  return `${ovPad2(d.getHours())}:${ovPad2(d.getMinutes())}`;
};

function ovSentOf(s) {
  const x = s && s.sent;
  if (!x || typeof x !== 'object') return { ok: false, today: 0, total: 0, byDay: [], exactFrom: null };
  return {
    ok: x.ok === true,
    today: ovN(x.today),
    total: ovN(x.total),
    byDay: ovArr(x.byDay),
    exactFrom: x.exactFrom || null,
  };
}
function ovUsageOf(s) { return s && s.usage && typeof s.usage === 'object' ? s.usage : {}; }

function ovEmotionOf(s) {
  const e = s && s.emotion;
  return e && e.ok ? e : null;
}
function ovEmoTop(s, limit = 3) {
  const e = ovEmotionOf(s);
  if (!e) return [];
  const labels = new Map();
  const groups = s?.customMeta?.emotion?.groups || [];
  for (const g of groups) {
    for (const it of (g.items || [])) {
      if (Array.isArray(it)) labels.set(it[0], it[1]);
    }
  }
  return ovArr(e.spectrum)
    .filter(([k, v]) => Math.abs(ovN(v)) > 0)
    .sort((a, b) => Math.abs(ovN(b[1])) - Math.abs(ovN(a[1])))
    .slice(0, limit)
    .map(([k]) => labels.get(k) || String(k));
}

function ovPluginsOf(s) {
  const ex = s && s.extensions && typeof s.extensions === 'object' ? s.extensions : {};
  const sum = ex.sum || {};
  const items = ovArr(ex.items);
  const total = ovN(sum.total, items.length);
  const load = ovN(sum.load, items.filter((x) => x.action === 'load').length);
  const labels = { plugin: '插件', skill: '技能', unknown: '其他' };
  const kinds = new Map();
  if (items.length) {
    for (const it of items) {
      /* 分类只数**本次真的加载**的包；未加载的另起一段。
         两处都数会把同一个包画两次（中心 6、图例 4+2+1 对不上）。 */
      if (String(it.action || '') !== 'load') continue;
      const k = it.kind || 'unknown';
      kinds.set(k, (kinds.get(k) || 0) + 1);
    }
  } else if (sum.byKind && typeof sum.byKind === 'object') {
    for (const [k, n] of Object.entries(sum.byKind)) kinds.set(k, ovN(n));
  }
  const segs = [...kinds.entries()]
    .filter(([, n]) => n > 0)
    .map(([k, n]) => ({
      key: k,
      label: labels[k] || k,
      count: n,
      color: k === 'plugin' ? 'var(--c-accent)' : (k === 'skill' ? 'var(--c-info)' : 'var(--c-text-3)'),
    }));
  const skipped = Math.max(0, total - load);
  if (skipped > 0) segs.push({ key: 'skipped', label: '未加载', count: skipped, color: 'var(--c-warn)' });
  return { total, load, skipped, segs };
}

/* 图例百分比按最大余数分配，保证整数列加起来正好 100（4/7+2/7+1/7 不再是 57+29+14 之外的误差）。 */
function ovPctParts(counts, total) {
  /* 空插件 / 空分类时 order 也是空的，但最大余数补齐仍会跑 100 次 ——
     读 order[0].i 直接抛 "Cannot read properties of undefined (reading 'i')"，
     整个右栏被错误卡替代。空集直接返回空数组，由 Gauge 的空态分支接管。 */
  if (!counts.length) return [];
  const safe = total > 0 ? total : 1;
  const raw = counts.map((n) => (ovN(n) / safe) * 100);
  const out = raw.map((n) => Math.floor(n));
  let left = 100 - out.reduce((n, v) => n + v, 0);
  const order = raw.map((n, i) => ({ i, frac: n - Math.floor(n) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < left; k += 1) out[order[k % order.length].i] += 1;
  return out;
}

function ovLinePoints(s) {
  const recent = ovArr(ovUsageOf(s).recent).slice(0, 25).reverse();
  return recent.map((r, i) => ({
    i,
    token: ovN(r.p) + ovN(r.c),
    cost: ovN(r.cost),
    label: ovTime(r.t),
    model: String(r.model || ''),
  }));
}

function ovSparkSvg(values) {
  const vals = ovArr(values).map((v) => ovN(v));
  if (vals.length < 2) return '';
  const w = 220, h = 26, p = 2;
  const min = Math.min(...vals);
  const span = (Math.max(...vals) - min) || 1;
  const pts = vals.map((v, i) => [p + (i * (w - p * 2)) / (vals.length - 1), h - p - ((v - min) / span) * (h - p * 2)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${h} L${pts[0][0].toFixed(1)} ${h} Z`;
  return `<svg class="ov-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="${area}"/><path class="line" d="${line}"/></svg>`;
}

function ovArcPath(cx, cy, r, a0, a1) {
  const p0 = { x: cx + r * Math.sin(a0), y: cy - r * Math.cos(a0) };
  const p1 = { x: cx + r * Math.sin(a1), y: cy - r * Math.cos(a1) };
  return `M${p0.x.toFixed(2)} ${p0.y.toFixed(2)}A${r} ${r} 0 0 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

function ovActionButton(label, action, cls, icon) {
  return `<button class="ov-btn ${cls}" type="button" data-a="${esc(action)}">${Icons.icon(icon, { size: 15 })}${esc(label)}</button>`;
}

/* KPI 三张卡的近 14 天序列与「较昨日」基数由后端下发（`/api/state.kpi`）。
   缺失时只用后端已有的日期键拼，前端**不自己算日期**（H-11①）。 */
function ovKpiOf(s) {
  if (s && s.kpi && s.kpi.messages && Array.isArray(s.kpi.messages.series)) return s.kpi;
  const sent = ovSentOf(s);
  const usage = ovUsageOf(s);
  const heatDays = Array.isArray(s?.heat?.days) ? s.heat.days.filter((x) => !x.future).slice(-14) : [];
  const msgs = heatDays.map((x) => ({ key: String(x.key).slice(5), v: ovN(x.count), est: !!x.estimated }));
  const uDays = Array.isArray(usage.byDay) ? usage.byDay.slice(-14) : [];
  const tok = uDays.map((x) => ({ key: String(x.key).slice(5), v: ovN(x.tokens) }));
  const cost = uDays.map((x) => ({ key: String(x.key).slice(5), v: ovN(x.cost) }));
  return {
    messages: {
      today: sent.ok ? sent.today : null,
      prev: msgs.length >= 2 ? msgs[msgs.length - 2].v : null,
      prevEst: msgs.length >= 2 ? !!msgs[msgs.length - 2].est : false,
      series: msgs,
    },
    tokens: {
      today: tok.length ? tok[tok.length - 1].v : 0,
      prev: tok.length >= 2 ? tok[tok.length - 2].v : 0,
      series: tok,
    },
    cost: {
      today: ovN(usage.today?.cost),
      prev: cost.length >= 2 ? cost[cost.length - 2].v : 0,
      series: cost,
    },
  };
}

function ovKpiDelta(today, prev, fmt, est) {
  const t = Number(today);
  const p = Number(prev);
  if (!Number.isFinite(t)) return '<span class="ov-kpi-delta flat" title="逐条计数从本版开始">—</span>';
  if (!Number.isFinite(p) || p <= 0) {
    if (t > 0) return '<span class="ov-kpi-delta up" title="昨日没有记录">新增</span>';
    return '<span class="ov-kpi-delta flat">—</span>';
  }
  const v = ((t - p) / p) * 100;
  const up = v >= 0;
  const text = `${up ? '+' : ''}${Math.abs(v) >= 100 ? Math.round(v) : v.toFixed(1)}%`;
  const title = `较昨日 ${fmt(p)}${est ? '（估算）' : ''} → ${fmt(t)}`;
  return `<span class="ov-kpi-delta ${up ? 'up' : 'down'}" title="${esc(title)}"><svg viewBox="0 0 8 8" aria-hidden="true"><path d="${up ? 'M4 1.2l3 5.2H1z' : 'M4 6.8 1 1.6h6z'}"/></svg>${text}</span>`;
}

function ovKpiSpark(series, fmt) {
  const vals = ovArr(series).map((x) => ovN(x.v));
  if (vals.length < 2) {
    return '<div class="ov-kpi-spark"><svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><line class="base" x1="0" y1="24" x2="100" y2="24"/></svg></div>';
  }
  const W = 100, H = 30, P = 3;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const flat = max === min;
  const span = flat ? 1 : max - min;
  /* 横向不内缩：曲线与面积从卡片左内沿画到右内沿，两侧不留白缝；纵向仍留 2px 余量。 */
  const xOf = (i) => (i * W) / (vals.length - 1);
  const yOf = (v) => (flat ? H / 2 : H - P - 2 - ((v - min) / span) * (H - P * 2 - 4));
  const pts = vals.map((v, i) => [xOf(i), yOf(v)]);
  let line = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i += 1) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const mx = (x0 + x1) / 2;
    line += ` C${mx.toFixed(1)} ${y0.toFixed(1)}, ${mx.toFixed(1)} ${y1.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${H} L${pts[0][0].toFixed(1)} ${H} Z`;
  const points = pts.map(([x, y], i) => `<circle class="ov-kpi-pt" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r=".1" fill="none" data-label="${esc(series[i].key || '')}" data-tip="${esc(fmt(vals[i]))}"></circle>`).join('');
  const last = pts[pts.length - 1];
  return `<div class="ov-kpi-spark"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path class="area" d="${area}"/><path class="line" d="${line}"/>${points}
    <line class="scan" x1="${last[0].toFixed(2)}" y1="0" x2="${last[0].toFixed(2)}" y2="${H}"/>
    <circle class="dot" cx="${last[0].toFixed(2)}" cy="${last[1].toFixed(2)}" r="2.5"/>
  </svg></div>`;
}

function ovKpisHtml(s) {
  const sent = ovSentOf(s);
  const usage = ovUsageOf(s);
  const k = ovKpiOf(s);
  const today = k.messages.today;
  const total = sent.ok ? sent.total : null;
  const tokensToday = k.tokens.today;
  const tokensTotal = ovN(usage.prompt) + ovN(usage.completion);
  const costToday = k.cost.today;
  const hasUsage = ovN(usage.calls) > 0;
  return `<div class="ov-kpis">
    <div class="card ov-kpi" data-ov-kpi>
      <div class="ov-kpi-top"><span class="kl">今日发言</span>${ovKpiDelta(today, k.messages.prev, (v) => `${v} 条`, k.messages.prevEst)}</div>
      <b class="v">${today == null ? '—' : today}<small>条</small></b>
      <span class="s">${total == null ? '逐条计数从本版开始' : `累计 ${total.toLocaleString('zh-CN')} 条${sent.exactFrom ? ` · 从 ${esc(sent.exactFrom)} 起` : ''}`}</span>
      ${ovKpiSpark(k.messages.series, (v) => `${v} 条`)}<span class="ov-kpi-hit" hidden></span>
    </div>
    <div class="card ov-kpi" data-ov-kpi>
      <div class="ov-kpi-top"><span class="kl">Token 消耗</span>${ovKpiDelta(tokensToday, k.tokens.prev, (v) => `${ovFmtTokens(v)} tokens`)}</div>
      <b class="v">${hasUsage ? ovFmtTokens(tokensTotal) : '—'}<small>tokens</small></b>
      <span class="s">今日 ${hasUsage ? ovFmtTokens(tokensToday) : '—'} · 缓存命中 <em>${ovPct(usage.cacheHitRate)}</em></span>
      ${ovKpiSpark(k.tokens.series, (v) => `${ovFmtTokens(v)} tokens`)}<span class="ov-kpi-hit" hidden></span>
    </div>
    <div class="card ov-kpi" data-ov-kpi>
      <div class="ov-kpi-top"><span class="kl">累计花费</span>${ovKpiDelta(costToday, k.cost.prev, (v) => ovFmtMoney(v))}</div>
      <b class="v">${hasUsage ? ovFmtMoney(ovN(usage.cost)) : '—'}</b>
      <span class="s">今日 ${hasUsage ? ovFmtMoney(costToday) : '—'} · <span class="muted">按实际模型单价</span></span>
      ${ovKpiSpark(k.cost.series, (v) => ovFmtMoney(v))}<span class="ov-kpi-hit" hidden></span>
    </div>
  </div>`;
}

function ovHeatHtml(s) {
  const sent = ovSentOf(s);
  const heat = s && s.heat && Array.isArray(s.heat.days)
    ? s.heat
    : { days: [], weeks: 53, months: [], weekCount: 0, peakCount: 0, streak: 0, total: 0, activeDays: 0 };
  const days = heat.days;
  const vals = days.filter((x) => !x.future && x.count > 0).map((x) => x.count).sort((a, b) => a - b);
  const q = (p) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))] : 0);
  const thresholds = [q(.25), q(.5), q(.75), q(.9)];
  const levelOf = (n) => (n === 0 ? 0 : Math.min(4, 1 + thresholds.filter((t) => n > t).length));
  const cells = days.map((it, i) => {
    const lv = levelOf(it.count);
    const sub = it.future ? '未来日期' : (it.estimated ? '历史按回复轮次估算' : '');
    const value = it.future ? '—' : (it.exact ? `${it.count} 条` : (it.estimated ? `${it.count} 轮（估算）` : '无记录'));
    const label = it.future ? `${it.key} · 未来` : `${it.key} · ${value}${sub ? ` · ${sub}` : ''}`;
    const delay = Math.min(360, Math.floor(i / 7) * 6 + (i % 7) * 3);
    return `<button class="ov-cell" type="button" data-lv="${lv}" data-key="${esc(it.key)}" data-count="${it.count}"`
      + `${it.estimated ? ' data-est="1"' : ''}${it.future ? ' data-future="1"' : ''}`
      + ` style="--d:${delay}ms"`
      + ` data-ov-tip-title="${esc(it.key)}" data-ov-tip-value="${esc(value)}" data-ov-tip-sub="${esc(sub)}" aria-label="${esc(label)}"></button>`;
  }).join('');
  const weekdays = ['一', '', '三', '', '五', '', '日'].map((x) => `<span>${x}</span>`).join('');
  const weeks = ovN(heat.weeks, 53);
  const months = ovArr(heat.months).map((m) => `<span style="grid-column:${ovN(m.col) + 1}">${esc(m.label)}</span>`).join('');
  const total = Number.isFinite(Number(heat.total))
    ? ovN(heat.total)
    : days.filter((x) => !x.future).reduce((n, x) => n + ovN(x.count), 0);
  const activeDays = Number.isFinite(Number(heat.activeDays))
    ? ovN(heat.activeDays)
    : days.filter((x) => !x.future && ovN(x.count) > 0).length;
  const peakCount = ovN(heat.peakCount);
  const streak = ovN(heat.streak);
  const todayCount = sent.ok ? sent.today : null;
  const rangeLabel = weeks >= 52 ? '近一年' : `近 ${weeks} 周`;
  const swatches = [0, 1, 2, 3, 4].map((lv) => `<i class="sw" data-lv="${lv}"></i>`).join('');
  return `<section class="card ov-panel ov-heat-panel">
    <div class="ov-panel-h"><div><h3>发言频率</h3><p>${rangeLabel} · 历史按回复轮次补齐</p></div><span class="chip">${todayCount == null ? '今日 —' : `今日 ${todayCount} 条`}</span></div>
    <div class="ov-heat-wrap">
      <div class="ov-heat-days">${weekdays}</div>
      <div class="ov-heat-right">
        <div class="ov-heat-months" style="--cols:${weeks}">${months}</div>
        <div class="ov-heat" id="ovHeatGrid">${cells}</div>
      </div>
    </div>
    <div class="ov-heat-foot">
      <div class="ov-heat-legend"><span>少</span>${swatches}<span>多</span><span class="est"><i></i>按回复轮次估算</span></div>
      <div class="ov-heat-meta">${rangeLabel} ${total} 条 · 活跃 ${activeDays} 天 · 峰值 ${peakCount} · 连续 ${streak} 天</div>
    </div>
  </section>`;
}

function ovFocusHtml(s) {
  const sent = ovSentOf(s);
  const usage = ovUsageOf(s);
  const today = sent.ok ? sent.today : null;
  const running = j(s, ['bridge', 'running']) === true;
  const wsUp = j(s, ['ports', 'onebotWs']) === true;
  const sentence = today == null
    ? `逐条发言计数从本版开始；${running ? '机器人在跑' : '机器人没在跑'}，协议端${wsUp ? '在线' : '未就绪'}。`
    : `今天已说 ${today} 句，花了 ${ovFmtMoney(usage.today?.cost)}；${running ? '机器人在跑' : '机器人没在跑'}，协议端${wsUp ? '在线' : '未就绪'}。`;
  const meteors = [0, 1, 2, 3, 4, 5].map((i) => `<i class="ov-meteor" style="--x:${12 + i * 15}%;--y:${8 + (i % 3) * 16}%;--len:${70 + i * 12}px;--d:${7 + (i % 4) * 1.4}s;--delay:${i * 1.3}s"></i>`).join('');
  return `<section class="card ov-focus">
    <div class="ov-meteors">${meteors}</div>
    <div class="ov-focus-main"><span class="eyebrow">今日小结</span>
      <div class="hero"><b>${today == null ? '—' : today}</b><span>${today == null ? '待记录' : '句话'}</span></div>
      <p>${esc(sentence)}</p></div>
    <div class="ov-focus-facts">
      <div><span>Token</span><b>${ovFmtTokens(ovN(usage.prompt) + ovN(usage.completion))}</b></div>
      <div><span>缓存命中</span><b>${ovPct(usage.cacheHitRate)}</b></div>
      <div><span>今日花费</span><b>${ovFmtMoney(usage.today?.cost)}</b></div>
      <div><span>群聊 / 插件</span><b>${ovCountOf(s.config?.groups)} / ${ovPluginsOf(s).total}</b></div>
    </div>
    <div class="ov-focus-extra">
      <div><span class="k">运行内存</span><b class="v" data-ov-focus="mem">—</b><span class="h" data-ov-focus-hint="mem"></span></div>
      <div><span class="k">网络延迟</span><b class="v" data-ov-focus="lat">—</b><span class="h" data-ov-focus-hint="lat"></span></div>
      <div><span class="k">已运行</span><b class="v" data-ov-focus="uptime" data-ov-uptime-at="">—</b><span class="h" data-ov-focus-hint="uptime"></span></div>
    </div>
  </section>`;
}

/* 今日小结底部三格：值每秒/每轮都可能变（内存、协议端往返、运行时长），
   所以 HTML 里只放占位节点，由这里原位刷新 —— 否则 3 秒轮询会整块重建中栏，
   热力格的入场动画和悬停会被重播（2026-10-27 真机踩到）。 */
let _ovFocusTimer = 0;
function ovFocusValues(s) {
  const procs = s?.memory?.procs || null;
  const memMb = procs
    ? ['bridgeMB', 'localModelMB', 'dockerMB', 'panelMB'].reduce((n, k) => n + ovN(procs[k]), 0)
    : 0;
  const latencyRaw = s?.ports?.onebotLatencyMs;
  const latency = latencyRaw == null || latencyRaw === '' ? null : Number(latencyRaw);
  const running = j(s, ['bridge', 'running']) === true;
  return {
    mem: memMb > 0 ? `${memMb.toLocaleString('zh-CN')} MB` : '—',
    memHint: memMb > 0 ? '机器人 / 协议端 / 面板' : '内存读数不可用',
    lat: latency != null && Number.isFinite(latency) && latency >= 0 ? `${Math.round(latency)} ms` : '—',
    latHint: j(s, ['ports', 'onebotHttp']) ? '协议端 HTTP 往返' : '协议端未连通',
    uptimeAt: running
      ? ovN(j(s, ['bridge', 'startedAt'], 0))
      : ovN(j(s, ['panel', 'bootedAt'], 0)),
    uptimeHint: running ? '机器人进程' : '控制台进程',
  };
}
function ovPaintFocus(root, s) {
  if (!root) return;
  const v = ovFocusValues(s);
  const set = (sel, text) => { const el = root.querySelector(sel); if (el) el.textContent = text; };
  set('[data-ov-focus="mem"]', v.mem);
  set('[data-ov-focus-hint="mem"]', v.memHint);
  set('[data-ov-focus="lat"]', v.lat);
  set('[data-ov-focus-hint="lat"]', v.latHint);
  const up = root.querySelector('[data-ov-focus="uptime"]');
  if (up) {
    up.dataset.ovUptimeAt = String(v.uptimeAt || '');
    up.textContent = v.uptimeAt > 0 ? fmtDur(Date.now() - v.uptimeAt) : '—';
  }
  set('[data-ov-focus-hint="uptime"]', v.uptimeHint);
  if (!_ovFocusTimer) {
    _ovFocusTimer = setInterval(() => {
      const el = document.querySelector('.ov-focus [data-ov-focus="uptime"]');
      if (!el) return;
      const at = Number(el.dataset.ovUptimeAt) || 0;
      el.textContent = at > 0 ? fmtDur(Date.now() - at) : '—';
    }, 1000);
  }
}

function ovStatsHtml(s) {
  const e = ovEmotionOf(s);
  const mood = e ? e.mood : null;
  const moodP = Math.max(0, Math.min(100, ovN(mood)));
  const trend = e && Array.isArray(e.trend) ? e.trend : [];
  const trendDelta = trend.length >= 2 ? Math.round(ovN(trend[trend.length - 1]) - ovN(trend[0])) : null;
  const top = ovEmoTop(s, 3);
  const filled = psnPersonaFilled();
  const enh = psnEnhanceFilled();
  const personaDots = Array.from({ length: 12 }, (_, i) => `<i class="${i < filled ? 'on' : ''}"></i>`).join('');
  const enhDots = Array.from({ length: 12 }, (_, i) => `<i class="${i < enh ? 'on' : ''}"></i>`).join('');
  const groups = ovCountOf(s.config?.groups);
  const priv = ovCountOf(s.config?.privateUsers);
  const owners = ovCountOf(s.config?.owners);
  const privateOk = priv > 0 || owners > 0;
  const memAuto = ovCountOf(s.autoMemory);
  const memManual = ovCountOf(s.memoryRecords);
  const memTotal = memAuto + memManual;
  const memAutoPct = memTotal ? Math.round((memAuto / memTotal) * 100) : 0;
  return `<div class="ov-stats">
    <div class="card ov-stat"><div class="l"><span>心情</span>${Icons.icon('sun', { size: 14 })}</div>
      <div class="ov-stat-main"><b class="v">${mood == null ? '—' : Math.round(mood)}</b>
        <span class="cap">${mood == null ? '情绪状态还没写盘' : '平静'}</span></div>
      <div class="ov-stat-side">
        <span><em>唤醒</em><b>${mood == null ? '—' : Math.round(ovN(e.arousal))}</b></span>
        <span><em>${trendDelta == null ? '关键词' : '24h'}</em><b class="${trendDelta != null && trendDelta < 0 ? 'warn' : ''}">${trendDelta == null ? top.length : `${trendDelta >= 0 ? '+' : ''}${trendDelta}`}</b></span>
      </div>
      <div class="tail"><div class="ov-mood-track" style="--p:${moodP}%"><i></i></div>
        <div class="ov-chips">${top.map((x) => `<span>${esc(x)}</span>`).join('')}${trend.length >= 2 ? '' : '<span>暂无 24h 曲线</span>'}</div>
        ${trend.length >= 2 ? ovSparkSvg(trend) : ''}</div></div>
    <div class="card ov-stat"><div class="l"><span>人设完整度</span>${Icons.icon('user', { size: 14 })}</div>
      <div class="ov-stat-main"><b class="v">${filled}<small>/12</small></b>
        <span class="cap">${filled >= 12 ? '基础字段已填满' : `基础字段还差 ${12 - filled} 项`}</span></div>
      <div class="ov-stat-side"><span><em>基础</em><b>${filled}/12</b></span><span><em>增强</em><b>${enh}/12</b></span></div>
      <div class="tail"><div class="ov-dotbar">${personaDots}</div><div class="ov-dotbar enh" style="margin-top:4px">${enhDots}</div></div></div>
    <div class="card ov-stat"><div class="l"><span>放行群聊</span>${Icons.icon('layers', { size: 14 })}</div>
      <div class="ov-stat-main"><b class="v">${groups}<small>个</small></b>
        <span class="cap">${groups > 0 ? '群聊白名单' : '还没有放行任何群'}</span></div>
      <div class="ov-stat-side"><span class="${priv ? '' : 'warn'}"><em>私聊</em><b>${priv}</b></span><span><em>主人</em><b>${owners}</b></span></div>
      <div class="tail"><span class="ov-stat-status ${privateOk ? '' : 'warn'}"><i></i>${privateOk ? '私聊与群聊都放行了' : '私聊白名单为空 —— 谁私聊都不会回'}</span></div></div>
    <div class="card ov-stat"><div class="l"><span>记忆条目</span>${Icons.icon('memory', { size: 14 })}</div>
      <div class="ov-stat-main"><b class="v">${memTotal}<small>条</small></b>
        <span class="cap">长期记忆 · 自动 / 人工</span></div>
      <div class="ov-stat-side"><span><em>自动</em><b>${memAuto}</b></span><span><em>人工</em><b>${memManual}</b></span></div>
      <div class="tail"><div class="ov-splitbar"><i style="width:${memAutoPct}%"></i><i style="width:${100 - memAutoPct}%"></i></div>
        <div class="ov-split-legend"><span>自动 <b>${memAutoPct}%</b></span><span>人工 <b>${100 - memAutoPct}%</b></span></div></div></div>
  </div>`;
}

function ovDashHtml(s) {
  return `<div class="ov ov-center">${ovKpisHtml(s)}${ovHeatHtml(s)}${ovFocusHtml(s)}${ovStatsHtml(s)}</div>`;
}

function ovLineHtml(s) {
  const pts = ovLinePoints(s);
  const has = pts.length >= 2;
  const head = `<div class="ov-panel-h"><div><h3>Token / 花费</h3><p>${has ? `最近 ${pts.length} 次调用` : '还没有调用记录'}</p></div><span class="side-note">${has ? `${ovFmtTokens(pts[pts.length - 1].token)} · ${ovFmtMoney(pts[pts.length - 1].cost)}` : '—'}</span></div>`;
  if (!has) {
    return `<section class="card ov-panel ov-line">${head}<div class="ov-chart-wrap"><svg viewBox="0 0 320 150" aria-hidden="true"><line x1="12" y1="120" x2="308" y2="120" stroke="var(--c-line)" stroke-dasharray="4 5"/></svg><div class="ov-chart-empty">还没有调用记录</div></div><div class="ov-chart-foot"><span class="legend"><span><i></i>Token</span><span><i class="cost"></i>花费</span></span><span>等待第一次模型调用</span></div></section>`;
  }
  const W = 320, H = 150, x0 = 12, x1 = 308, y0 = 12, y1 = 120;
  const tVals = pts.map((p) => p.token);
  const cVals = pts.map((p) => p.cost);
  const tMin = Math.min(...tVals), tMax = Math.max(...tVals);
  const cMin = Math.min(...cVals), cMax = Math.max(...cVals);
  const tSpan = (tMax - tMin) || 1;
  const cSpan = (cMax - cMin) || 1;
  const stepX = (x1 - x0) / (pts.length - 1);
  const xOf = (i) => x0 + i * stepX;
  const yOf = (v, min, span) => y1 - 6 - ((v - min) / span) * (y1 - y0 - 8);
  const tPts = pts.map((p, i) => [xOf(i), yOf(p.token, tMin, tSpan)]);
  const cPts = pts.map((p, i) => [xOf(i), cMax === cMin ? y1 - 8 : yOf(p.cost, cMin, cSpan)]);
  const path = (arr) => arr.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${path(tPts)} L${x1} ${y1} L${x0} ${y1} Z`;
  const grid = [0, 1, 2].map((i) => `<line class="ov-grid-line" x1="${x0}" y1="${y0 + i * ((y1 - y0) / 2)}" x2="${x1}" y2="${y0 + i * ((y1 - y0) / 2)}"/>`).join('');
  const dots = pts.map((p, i) => `<circle class="ov-line-pt" cx="${tPts[i][0].toFixed(2)}" cy="${tPts[i][1].toFixed(2)}" r="${i === pts.length - 1 ? 2.8 : 2.1}" fill="var(--c-accent)" opacity="${i === pts.length - 1 ? 1 : .5}" data-token="${p.token}" data-cost="${p.cost}" data-label="${esc(p.label)}" data-model="${esc(p.model)}"/>`).join('');
  const last = tPts[tPts.length - 1];
  return `<section class="card ov-panel ov-line">${head}
    <div class="ov-chart-wrap" data-ov-line tabindex="0" role="img" aria-label="最近 ${pts.length} 次调用的 Token 与花费折线图，第一行 Token，第二行价格">
      <svg id="ovLineSvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <defs><linearGradient id="ovArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--c-accent)" stop-opacity=".24"/><stop offset="1" stop-color="var(--c-accent)" stop-opacity="0"/></linearGradient><clipPath id="ovPlot"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath></defs>
        ${grid}
        <g clip-path="url(#ovPlot)">
          <path class="ov-line-area" d="${area}" fill="url(#ovArea)"/>
          <path class="ov-line-path" d="${path(tPts)}"/>
          <path class="ov-cost-path" d="${path(cPts)}"/>
          ${dots}
          <circle class="ov-dot-halo" cx="${last[0]}" cy="${last[1]}" r="4"/>
          <circle class="ov-dot-core" cx="${last[0]}" cy="${last[1]}" r="3.4"/>
          <g id="ovCross" style="opacity:0"><line class="ov-cross-line" id="ovCrossLine" x1="0" y1="${y0}" x2="0" y2="${y1}"/><circle class="ov-cross-dot" id="ovCrossT" r="3.6" fill="var(--c-accent)"/><circle class="ov-cross-dot" id="ovCrossC" r="3.6" fill="var(--c-ok)"/></g>
        </g>
        <rect class="ov-line-zone" x="0" y="0" width="${W}" height="${H}" fill="transparent" pointer-events="all"/>
      </svg>
      <div class="ov-line-tip" id="ovLineTip" hidden></div>
    </div>
    <div class="ov-chart-foot"><span class="legend"><span><i></i>Token</span><span><i class="cost"></i>花费</span></span><span>悬停 / ← → 查看逐次读数</span></div>
  </section>`;
}

function ovGaugeHtml(s) {
  const p = ovPluginsOf(s);
  const sum = p.segs.reduce((n, x) => n + x.count, 0) || 1;
  const parts = ovPctParts(p.segs.map((x) => x.count), sum);
  const track = ovArcPath(100, 100, 70, -Math.PI / 2, Math.PI / 2);
  const gap = p.segs.length > 1 ? Math.min(0.3, 1.4 / p.segs.length) : 0;
  let cursor = 0;
  const paths = p.segs.map((seg, i) => {
    const frac = seg.count / sum;
    const first = i === 0;
    const last = i === p.segs.length - 1;
    const a0 = -Math.PI / 2 + cursor * Math.PI + (first ? 0 : gap / 2);
    cursor += frac;
    const a1 = -Math.PI / 2 + cursor * Math.PI - (last ? 0 : gap / 2);
    const d = ovArcPath(100, 100, 70, a0, Math.max(a0 + 0.01, a1));
    return `<g class="ov-gauge-arc" data-ov-gauge-arc="${i}" aria-hidden="true">
      <path class="ov-gauge-hit" d="${d}"/>
      <path class="ov-gauge-seg" data-ov-gauge-seg="${i}" d="${d}" stroke="${seg.color}" pathLength="100" stroke-dasharray="100" stroke-dashoffset="0" style="--delay:${i * 70}ms"/>
    </g>`;
  }).join('');
  const legend = p.segs.map((seg, i) => `<button type="button" class="ov-gauge-row" data-ov-gauge-row="${i}"
      data-ov-gauge-label="${esc(seg.label)}" data-ov-gauge-count="${seg.count}" data-ov-gauge-pct="${parts[i]}"
      aria-label="${esc(seg.label)} ${seg.count} 个，占 ${parts[i]}%">
      <i style="--gc:${seg.color}"></i><span class="lb">${esc(seg.label)}</span><b class="n">${seg.count}</b><span class="pc">${parts[i]}%</span>
    </button>`).join('');
  const empty = p.total === 0 || p.segs.length === 0;
  return `<section class="card ov-panel ov-gauge" data-ov-gauge data-total="${p.total}" data-load="${p.load}">
    <div class="ov-panel-h"><div><h3>插件构成</h3><p>半圆 = 总数 · 颜色 = 类型</p></div><span class="side-note">${empty ? '未安装' : `${p.load}/${p.total} 可加载`}</span></div>
    <div class="ov-gauge-wrap"><svg viewBox="0 0 200 120" role="img" aria-label="${empty ? '还没有安装扩展包' : `共 ${p.total} 个扩展包，其中 ${p.load} 个可加载`}">
      <path class="ov-gauge-track${empty ? ' empty' : ''}" d="${track}"/>${empty ? '' : paths}
    </svg><div class="ov-gauge-center"><span class="k" data-ov-gauge-k>总计</span><b class="n" data-ov-gauge-v>${p.total}<small>个</small></b><span class="pc" data-ov-gauge-p>${empty ? '还没有安装扩展包' : `可加载 ${p.load}`}</span></div></div>
    ${empty ? '<div class="ov-empty" style="padding:4px 0 0">去「插件」页放一个扩展包，这里会按类型分段。</div>' : `<div class="ov-gauge-legend" data-ov-gauge-legend>${legend}</div>`}
  </section>`;
}

function ovSideHtml(s) {
  const running = j(s, ['bridge', 'running']) === true;
  const httpUp = j(s, ['ports', 'onebotHttp']) === true;
  const wsUp = j(s, ['ports', 'onebotWs']) === true;
  const nickname = String(j(s, ['account', 'nickname'], '') || '');
  const primary = running
    ? ''
    : ovActionButton('一键启动', 'onekey.start', 'ov-btn-primary', 'play');
  const stop = running
    ? ovActionButton('结束本次运行', 'onekey.stop', 'ov-btn-ghost', 'stop')
    : '';
  return `<div class="ov ov-side">
    <section class="card ov-panel ov-actions">
      <div class="ov-panel-h"><div><h3>运行控制</h3><p>右上角主操作 · 与顶栏同一组动作</p></div><span class="pill ${running ? 'ok' : 'bad'}"><span class="dot"></span>${running ? '在跑' : '未启动'}</span></div>
      <div class="ov-runline ${running ? '' : 'bad'}"><span class="dot"></span><b>机器人</b><span>${running ? `pid ${esc(j(s, ['bridge', 'pid'], '—'))} · ${esc(fmtDur(ovN(j(s, ['bridge', 'uptimeMs'], 0))))}` : '没在跑'}</span></div>
      <div class="ov-runline ${wsUp ? '' : 'bad'}"><span class="dot"></span><b>协议端</b><span>HTTP ${esc(j(s, ['ports', 'onebot', 'http'], '—'))} · WS ${esc(j(s, ['ports', 'onebot', 'ws'], '—'))} ${wsUp && httpUp ? '通' : '断'}</span></div>
      <div class="ov-runline ${nickname ? '' : 'bad'}"><span class="dot"></span><b>QQ</b><span>${nickname ? esc(nickname) : '未登录'}</span></div>
      <div class="ov-act-grid">${primary}
        ${ovActionButton('拉起协议端', 'protocol.start', 'ov-btn-ghost', 'network')}
        ${stop}
        ${ovActionButton('打开 QQ 登录', 'open.webui', 'ov-btn-ghost', 'key')}
        ${ovActionButton('重启 QQ 容器', 'napcat.restart', 'ov-btn-danger', 'reload')}
      </div>
    </section>
    ${ovLineHtml(s)}
    ${ovGaugeHtml(s)}
  </div>`;
}

/* ── 总览 tooltip（body 级；热力格 / Gauge 共用）────────────────────── */
function ovTipEl() {
  let el = $id('ovTip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ovTip';
    el.className = 'ov-tip';
    el.hidden = true;
    el.setAttribute('role', 'tooltip');
    document.body.appendChild(el);
  }
  return el;
}
function ovTipShowData({ title = '', value = '', sub = '', color = 'var(--c-accent)' }, x, y) {
  const el = ovTipEl();
  el.innerHTML = `<div class="ov-tip-head"><span class="ov-tip-dot" style="--tc:${esc(color)}"></span>${esc(title)}</div>`
    + `${value ? `<b>${esc(value)}</b>` : ''}${sub ? `<em>${esc(sub)}</em>` : ''}`;
  el.hidden = false;
  ovTipMove(x, y);
}
function ovTipShow(target, x, y) {
  if (!target) return;
  ovTipShowData({
    title: target.dataset.ovTipTitle || '',
    value: target.dataset.ovTipValue || '',
    sub: target.dataset.ovTipSub || '',
    color: target.dataset.ovTipColor || 'var(--c-accent)',
  }, x, y);
}
function ovTipMove(x, y) {
  const el = $id('ovTip');
  if (!el || el.hidden) return;
  const r = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(innerWidth - r.width - 8, x + 14));
  let top = y + 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(8, top))}px`;
}
function ovTipHide() {
  const el = $id('ovTip');
  if (el) el.hidden = true;
}
function ovBindTip() {
  if (_ovTipBound) return;
  _ovTipBound = true;
  document.addEventListener('pointerover', (ev) => {
    const t = ev.target instanceof Element ? ev.target.closest('.ov [data-ov-tip-title]') : null;
    if (t) ovTipShow(t, ev.clientX, ev.clientY);
  });
  document.addEventListener('pointermove', (ev) => {
    const el = $id('ovTip');
    if (el && !el.hidden) ovTipMove(ev.clientX, ev.clientY);
  });
  document.addEventListener('pointerout', (ev) => {
    const t = ev.target instanceof Element ? ev.target.closest('.ov [data-ov-tip-title]') : null;
    if (t) ovTipHide();
  });
  document.addEventListener('pointerover', (ev) => {
    if (_ovLineHide && !(ev.target instanceof Element && ev.target.closest('.ov-line'))) _ovLineHide();
  });
  window.addEventListener('scroll', () => { if (_ovLineHide) _ovLineHide(); }, { passive: true });
  window.addEventListener('resize', () => { if (_ovLineHide) _ovLineHide(); });
}

function ovMountChainProgress(root) {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.querySelectorAll('.ov-sub-pct').forEach((el) => {
    const target = ovN(el.dataset.p);
    const row = el.closest('.ov-sub');
    const animate = row && row.dataset.anim === '1';
    if (reduce || !animate || target <= 0) { el.textContent = `${target}%`; return; }
    const delay = parseFloat((row && row.style.getPropertyValue('--d')) || '0') || 0;
    const start = performance.now() + delay;
    const dur = 500;
    const tick = (now) => {
      const t = Math.max(0, Math.min(1, (now - start) / dur));
      el.textContent = `${Math.round(t * target)}%`;
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function ovMountChain(root) {
  root.querySelectorAll('.ov-group[data-group]').forEach((d) => {
    if (d.dataset.ovBound) return;
    d.dataset.ovBound = '1';
    d.addEventListener('toggle', () => _ovOpen.set(d.dataset.group, d.open));
  });
  ovMountChainProgress(root);
}
function ovMountHeat(root) {
  root.querySelectorAll('.ov-cell').forEach((el) => {
    if (el.dataset.ovFocus) return;
    el.dataset.ovFocus = '1';
    el.addEventListener('focus', () => {
      const r = el.getBoundingClientRect();
      ovTipShow(el, r.left, r.bottom);
    });
    el.addEventListener('blur', ovTipHide);
  });
}
function ovMountKpi(root) {
  root.querySelectorAll('.ov-kpi[data-ov-kpi]').forEach((card) => {
    if (card.dataset.ovKpiBound) return;
    card.dataset.ovKpiBound = '1';
    const spark = card.querySelector('.ov-kpi-spark');
    const scan = card.querySelector('.scan');
    const dot = card.querySelector('.dot');
    const hit = card.querySelector('.ov-kpi-hit');
    const pts = [...card.querySelectorAll('.ov-kpi-pt')];
    if (!spark || !scan || !dot || !hit || !pts.length) return;
    const show = (clientX) => {
      const sr = spark.getBoundingClientRect();
      const vx = ((clientX - sr.left) / Math.max(1, sr.width)) * 100;
      let best = 0;
      let dist = Infinity;
      pts.forEach((p, i) => {
        const dd = Math.abs(Number(p.getAttribute('cx')) - vx);
        if (dd < dist) { dist = dd; best = i; }
      });
      const p = pts[best];
      const cx = p.getAttribute('cx');
      scan.setAttribute('x1', cx);
      scan.setAttribute('x2', cx);
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', p.getAttribute('cy'));
      hit.hidden = false;
      hit.innerHTML = `${esc(p.dataset.label || '')} ·<b>${esc(p.dataset.tip || '')}</b>`;
      const sub = card.querySelector('.s');
      if (sub) {
        hit.style.left = '14px';
        hit.style.top = `${sub.offsetTop - 1}px`;
        hit.style.transform = 'none';
      } else {
        const cr = card.getBoundingClientRect();
        const left = (sr.left - cr.left) + (Number(cx) / 100) * sr.width;
        hit.style.left = `${Math.max(44, Math.min(cr.width - 44, left))}px`;
        hit.style.top = `${Math.max(26, sr.top - cr.top - 3)}px`;
        hit.style.transform = 'translate(-50%, -100%)';
      }
      card.classList.add('hot');
    };
    const hide = () => { card.classList.remove('hot'); hit.hidden = true; };
    card.addEventListener('pointerenter', (ev) => show(ev.clientX));
    card.addEventListener('pointermove', (ev) => show(ev.clientX));
    card.addEventListener('pointerleave', hide);
  });
}

/* 图例 / 弧段同权：悬停任一处都把中心读数切到那一段，其余段褪成淡色。 */
function ovMountGauge(root) {
  const card = root.querySelector('[data-ov-gauge]');
  if (!card || card.dataset.ovGaugeBound) return;
  card.dataset.ovGaugeBound = '1';
  const k = card.querySelector('[data-ov-gauge-k]');
  const v = card.querySelector('[data-ov-gauge-v]');
  const sub = card.querySelector('[data-ov-gauge-p]');
  const rows = [...card.querySelectorAll('[data-ov-gauge-row]')];
  const arcs = [...card.querySelectorAll('[data-ov-gauge-arc]')];
  if (!k || !v || !sub || !rows.length) return;
  const total = card.dataset.total || '0';
  const load = card.dataset.load || '0';
  const reset = () => {
    delete card.dataset.hot;
    k.textContent = '总计';
    v.innerHTML = `${esc(total)}<small>个</small>`;
    sub.textContent = `可加载 ${esc(load)}`;
    rows.forEach((row) => row.classList.remove('hot'));
    arcs.forEach((arc) => {
      arc.classList.remove('hot');
      const seg = arc.querySelector('.ov-gauge-seg');
      if (seg) seg.classList.remove('hot');
    });
  };
  const show = (i) => {
    const row = rows[i];
    if (!row) return;
    card.dataset.hot = '1';
    k.textContent = row.dataset.ovGaugeLabel || '';
    v.innerHTML = `${esc(row.dataset.ovGaugeCount || '0')}<small>个</small>`;
    sub.textContent = `占比 ${row.dataset.ovGaugePct || '0'}%`;
    rows.forEach((x, j) => x.classList.toggle('hot', j === i));
    arcs.forEach((arc, j) => {
      const on = j === i;
      arc.classList.toggle('hot', on);
      const seg = arc.querySelector('.ov-gauge-seg');
      if (seg) seg.classList.toggle('hot', on);
    });
  };
  rows.forEach((row, i) => {
    row.addEventListener('pointerenter', () => show(i));
    row.addEventListener('focus', () => show(i));
    row.addEventListener('pointerleave', reset);
    row.addEventListener('blur', reset);
  });
  arcs.forEach((arc, i) => {
    arc.addEventListener('pointerenter', () => show(i));
    arc.addEventListener('pointerleave', reset);
  });
  card.addEventListener('pointerleave', reset);
}
function ovMountLine(root) {
  const wrap = root.querySelector('.ov-chart-wrap[data-ov-line]');
  if (!wrap || wrap.dataset.ovBound) return;
  wrap.dataset.ovBound = '1';
  const pts = [...wrap.querySelectorAll('.ov-line-pt')].map((c) => ({
    x: ovN(c.getAttribute('cx')),
    y: ovN(c.getAttribute('cy')),
    token: ovN(c.dataset.token),
    cost: ovN(c.dataset.cost),
    label: c.dataset.label || '',
    model: c.dataset.model || '',
  }));
  const tip = wrap.querySelector('.ov-line-tip');
  const cross = wrap.querySelector('#ovCross');
  const crossLine = wrap.querySelector('#ovCrossLine');
  const crossT = wrap.querySelector('#ovCrossT');
  const crossC = wrap.querySelector('#ovCrossC');
  if (!pts.length || !tip || !cross) return;
  const cVals = pts.map((p) => p.cost);
  const cMin = Math.min(...cVals);
  const cMax = Math.max(...cVals);
  const cSpan = (cMax - cMin) || 1;
  const costY = (cost) => (cMax === cMin ? 116 : 120 - 6 - ((cost - cMin) / cSpan) * 100);
  let active = -1;
  const hide = () => {
    active = -1;
    cross.style.opacity = '0';
    crossLine.style.opacity = '0';
    tip.hidden = true;
  };
  const show = (i, clientX, clientY) => {
    if (i < 0 || i >= pts.length) return;
    active = i;
    const p = pts[i];
    const yC = costY(p.cost);
    cross.style.opacity = '1';
    crossLine.style.opacity = '1';
    crossLine.setAttribute('x1', p.x); crossLine.setAttribute('x2', p.x);
    crossT.setAttribute('cx', p.x); crossT.setAttribute('cy', p.y); crossT.style.opacity = '1';
    crossC.setAttribute('cx', p.x); crossC.setAttribute('cy', yC); crossC.style.opacity = '1';
    tip.hidden = false;
    tip.innerHTML = `<b>Token ${p.token.toLocaleString('zh-CN')}</b><span>${ovFmtMoney(p.cost)}</span><em>${esc(p.label)} · ${esc(p.model)}</em>`;
    const rect = wrap.getBoundingClientRect();
    const left = Math.max(66, Math.min(rect.width - 66, (p.x / 320) * rect.width));
    const top = Math.max(44, Math.min(rect.height - 4, (Math.min(p.y, yC) / 150) * rect.height));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    if (clientX != null) {
      tip.style.left = `${Math.max(66, Math.min(rect.width - 66, clientX - rect.left))}px`;
    }
    if (clientY != null) {
      tip.style.top = `${Math.max(44, Math.min(rect.height - 4, clientY - rect.top))}px`;
    }
  };
  const nearest = (clientX) => {
    const rect = wrap.getBoundingClientRect();
    const vx = ((clientX - rect.left) / Math.max(1, rect.width)) * 320;
    let best = 0;
    let dist = Infinity;
    for (let i = 0; i < pts.length; i += 1) {
      const dd = Math.abs(pts[i].x - vx);
      if (dd < dist) { dist = dd; best = i; }
    }
    return best;
  };
  wrap.addEventListener('pointermove', (ev) => show(nearest(ev.clientX), ev.clientX, ev.clientY));
  wrap.addEventListener('pointerleave', hide);
  wrap.addEventListener('focus', () => show(active < 0 ? pts.length - 1 : active));
  wrap.addEventListener('blur', hide);
  wrap.addEventListener('keydown', (ev) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(ev.key)) return;
    ev.preventDefault();
    if (ev.key === 'Escape') { hide(); return; }
    let i = active < 0 ? pts.length - 1 : active;
    if (ev.key === 'ArrowLeft') i = Math.max(0, i - 1);
    if (ev.key === 'ArrowRight') i = Math.min(pts.length - 1, i + 1);
    if (ev.key === 'Home') i = 0;
    if (ev.key === 'End') i = pts.length - 1;
    show(i);
  });
  _ovLineHide = hide;
}

function ovMountOverview() {
  const dash = $id('card-dash')?.querySelector('.ov-center') || null;
  const side = $id('card-side')?.querySelector('.ov-side') || null;
  const chain = $id('card-chain')?.querySelector('.ov-chain') || null;
  const focus = dash ? dash.querySelector('.ov-focus') : null;
  ovPaintFocus(focus, S.state || DEMO);
  const changed = !_ovMount || _ovMount.dash !== dash || _ovMount.side !== side || _ovMount.chain !== chain;
  if (!changed) return;
  const prev = _ovMount;
  _ovMount = { dash, side, chain };
  ovBindTip();
  if (chain && (!prev || prev.chain !== chain)) ovMountChain(chain);
  if (dash && (!prev || prev.dash !== dash)) { ovMountHeat(dash); ovMountKpi(dash); }
  if (side && (!prev || prev.side !== side)) { ovMountLine(side); ovMountGauge(side); }
}
function ovDestroy() {
  ovTipHide();
  if (_ovFocusTimer) { clearInterval(_ovFocusTimer); _ovFocusTimer = 0; }
  const tip = $id('ovLineTip');
  if (tip) tip.hidden = true;
  _ovLineHide = null;
  _ovMount = null;
}

function paintOverviewPage(su, rebuildNav) {
  const g = GROUPS[S.gi];
  const page = $id('page');
  /* 总览走按卡补丁的早返回，不经过 commit() 的类复位；从工厂空白页/全幅工具页
     回来时必须把 `page--blank` / `page--frame` 摘掉，否则内容在但被样式藏住。 */
  if (page.className !== 'page') page.className = 'page';
  /* 域名戳也必须随总览一起盖：`#page[data-domain="persona"] > .wrap-head` 是隐藏的，
     从人设页回来若不改它，总览页头会被上一页的样式规则吃掉。 */
  if (page.dataset.domain !== g.id) page.dataset.domain = g.id;
  const head = `<div class="wrap-head" style="grid-column:span 12;">
    <h1 style="font-size:var(--t-2xl);">${esc(su.title || su.label)}</h1>
    ${su.desc ? `<p class="hint" style="margin:6px 0 0;max-width:80ch;">${su.desc}</p>` : ''}
    <p class="hint" style="margin:4px 0 0;">${esc(g.label)} → ${esc(su.label)}</p>
  </div>`;
  const cards = (su.cards || []).map((c) => ({ id: c.id, html: cardHtml(c) }));
  const order = cards.map((c) => c.id).join('|');
  const keep = keepPageState();
  const full = rebuildNav || order !== _ovOrder || !page.querySelector('.ov-center');
  if (full) {
    ovDestroy();
    page.innerHTML = head + cards.map((c) => c.html).join('');
    _ovCards = new Map(cards.map((c) => [c.id, c.html]));
    _ovOrder = order;
    restorePageState(keep);
  } else {
    for (const c of cards) {
      if (_ovCards.get(c.id) === c.html) continue;
      const el = $id(`card-${c.id}`);
      if (!el) {
        ovDestroy();
        page.innerHTML = head + cards.map((x) => x.html).join('');
        _ovCards = new Map(cards.map((x) => [x.id, x.html]));
        _ovOrder = order;
        restorePageState(keep);
        break;
      }
      /* 鼠标正悬停在这张卡上时先不换：换掉会把 tooltip / hover 状态当场清空。 */
      if (el.matches(':hover') || el.querySelector(':hover')) continue;
      if (el.contains(document.activeElement)) continue;
      const wasOpen = el.tagName === 'DETAILS' ? el.open : null;
      const scroller = el.querySelector('.scroll-y');
      const scrollTop = scroller ? scroller.scrollTop : 0;
      el.outerHTML = c.html;
      const next = $id(`card-${c.id}`);
      if (wasOpen !== null && next && next.tagName === 'DETAILS') next.open = wasOpen;
      if (scrollTop && next) {
        const sc = next.querySelector('.scroll-y');
        if (sc) sc.scrollTop = scrollTop;
      }
      _ovCards.set(c.id, c.html);
    }
  }
  S.extra.psnHtml = null;
  markDirty();
  auditActions();
  onPageShown(su);
}

/* 服务商 → 短名。**只做显示映射** —— 判据是后端下发的 `provider`
   （`providerOf` 唯一实现，前端不按域名再判一次）。 */
const VENDOR_SHORT = { local: '本机', deepseek: 'DeepSeek', zhipu: '智谱', qwen: '千问' };
const vendorShort = (p) => VENDOR_SHORT[String(p || '')] || '自定义';

const RENDER = {
  /* ── 只读展示 ── */
  /* `text` 允许是**函数**（按状态算），与 `hint` / `metric` / `ports.label` 同款
     （2026-10-09 · 第 53 轮 B6）：那段"Windows 上本机模型为什么不存在、该走哪条路"
     的文案由**后端下发**（`localModel.unsupportedWhy`），前端不自存一份 ——
     抄一份就会在两处慢慢说不一样的话（本项目在"一份数据维护两遍"上踩过多次）。 */
  note: (x) => {
    let t = x.text;
    try { if (typeof t === 'function') t = t(S.state || DEMO); } catch { t = ''; }
    return noteHtml(t, x.kind);
  },
  // ⚠️ **一律 esc()**（2026-10-05 开源前审查 · S-07）。
  //    这里原本有一条 `val.includes('<') ? val : esc(val)` —— 意思是"看着像 HTML 就原样插"。
  //    它是全仓唯一绕过转义的地方，而它读的是**服务端下发的值**：
  //      `kv('接口地址', () => j(s, ['effective', 'baseUrl'], '—'))`（schema.js）
  //    `baseUrl` 可由 `POST /api/config` 写入 ⇒ 写一条 `<img src=x onerror=...>` 就能
  //    在面板上执行任意脚本（存储型 XSS）。
  //    ⚠️ 删掉它是安全的：全仓 16 处 `kv(...)` **没有任何一处**返回 HTML 标签
  //    （已逐个核对），所以"富文本"这个能力本来就没人在用。
  //    真要富文本，应当用**显式标记**（如 `x.md: true`）加白名单解析，
  //    而不是靠"猜值里有没有 <"—— 后者等于把转义交给了攻击者控制的内容。
  kv: (x) => `<dl class="kv">${x.rows(S.state || DEMO).map(([k, v]) => {
    let val; try { val = typeof v === 'function' ? v(S.state || DEMO) : v; } catch (e) { val = `（算不出来：${e.message}）`; }
    return `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`;
  }).join('')}</dl>`,
  metrics: (x) => `<div class="metrics">${x.items.map((m) => {
    let v; try { v = m.n(S.state || DEMO); } catch { v = null; }
    /* ⚠️ `null` / `undefined` = 「**这项采不到**」，与"值是 0"是两件事
       （2026-10-09 · 第 53 轮 B2）。Windows 上内存那几项后端如实返回 null，
       而这里以前把它渲染成 `0`/`—` —— 屏幕上是一片"0 MB / 0%"，读的人只会
       理解成"它几乎不占内存"，不可能想到"这个数根本没采到"。
       本项目最忌「失败伪装成成功」，所以无数据要**明说**。 */
    const nodata = v === null || v === undefined;
    return `<div class="metric ${m.hi ? 'hi' : ''}${nodata ? ' nodata' : ''}">`
      + `<div class="n">${esc(nodata ? '暂不支持' : v)}</div><div class="l">${esc(m.l)}</div></div>`;
  }).join('')}</div>`,
  /* ── 启动链路 ──
     ⚠️ 原来是 `<div>` 堆叠的纯文本行 —— 一列句子，读者要逐句读才知道走到哪一步。
     改成**横向步骤条**：每步一个节点 + 连接线，节点带状态色。
     于是"走到第几步 / 卡在哪一步"变成**看位置和颜色**，不用读字。
     步骤文本本身来自 `source()`（服务端给的真实日志），**不编造**。 */
  steps: (x) => {
    const s = S.state || DEMO;
    const running = j(s, ['bridge', 'running']) === true;
    const lines = x.source(s);
    const items = readyChecklist(s);
    const groups = [
      { id: 'qq', label: 'QQ', icon: 'user', short: '账号' },
      { id: 'proto', label: '协议端', icon: 'network', short: '连接' },
      { id: 'app', label: '应用端', icon: 'bot', short: '本体' },
    ].map((g) => ({ ...g, rows: items.filter((it) => (it.group || 'app') === g.id) }));
    const firstBad = items.findIndex((it) => !it.ok);
    const firstBadGroup = firstBad >= 0 ? (items[firstBad].group || 'app') : '';
    const firstBadText = firstBad >= 0 ? String(items[firstBad].txt || '') : '';
    const allDone = groups.every((g) => g.rows.length > 0 && g.rows.every((r) => r.ok));
    const doneCount = groups.filter((g) => g.rows.length > 0 && g.rows.every((r) => r.ok)).length;
    const groupHtml = groups.map((g) => {
      const badCount = g.rows.filter((r) => !r.ok).length;
      const st = badCount === 0 ? 'done' : (badCount === g.rows.length ? 'blocked' : 'warn');
      const open = _ovOpen.has(g.id) ? _ovOpen.get(g.id) : true;
      const stateText = st === 'done' ? '已就绪' : (st === 'blocked' ? '未就绪' : `${badCount} 项待处理`);
      const subHtml = g.rows.map((it, idx) => {
        const bad = !it.ok;
        const pct = bad ? 0 : 100;
        const key = `${g.id}:${idx}`;
        const anim = !bad && !_ovSeenDone.has(key);
        if (bad) _ovSeenDone.delete(key);
        else _ovSeenDone.add(key);
        const isCur = !lines.length && bad && g.id === firstBadGroup && String(it.txt || '') === firstBadText;
        const full = String(it.txt || '').replace(/\*\*/g, '');
        return `<li class="stp ov-sub ${bad ? 'bad' : 'done'}" data-p="${pct}" data-anim="${anim ? 1 : 0}"${isCur ? ' data-cur="1"' : ''} style="--d:${idx * 35}ms">`
          + `<span class="ov-sub-ring" style="--p:${pct}" aria-hidden="true"><svg viewBox="0 0 20 20"><circle class="track" cx="10" cy="10" r="8"/><circle class="bar" cx="10" cy="10" r="8" pathLength="100"/><circle class="disc" cx="10" cy="10" r="8"/><path class="check" d="m5.8 10.2 2.7 2.7 5.7-6"/></svg></span>`
          + `<span class="stp-tx" title="${esc(full)}">${esc(full)}</span>`
          + `<span class="ov-sub-pct" data-p="${pct}">${anim ? 0 : pct}%</span></li>`;
      }).join('');
      const groupAnim = st === 'done' && !_ovSeenGroups.has(g.id);
      if (st === 'done') _ovSeenGroups.add(g.id);
      else _ovSeenGroups.delete(g.id);
      const summaryCur = !lines.length && allDone && g.id === 'app';
      return `<li class="stp ov-node" data-state="${st}"${summaryCur ? ' data-cur="1"' : ''}>
        <details class="ov-group" data-state="${st}" data-group="${g.id}" data-justdone="${groupAnim ? 1 : 0}"${open ? ' open' : ''}>
          <summary class="ov-node-head">
            <span class="ov-node-ico">${Icons.icon(g.icon, { size: 18 })}<span class="ov-node-check" aria-hidden="true"><svg viewBox="0 0 12 12"><path d="m2.8 6.2 2.1 2.1 4.4-4.6"/></svg></span></span>
            <span class="ov-node-main"><b class="stp-tx">${esc(g.label)}</b><span>${st === 'done' ? `${g.rows.length} 项已通过` : `${g.rows.length} 项检查 · 卡在${esc(g.short)}`}</span></span>
            <span class="ov-node-state">${stateText}</span>
            <svg class="ov-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
          </summary>
          <ol class="ov-subs">${subHtml}</ol>
        </details>
      </li>`;
    }).join('');
    const logHtml = lines.length
      ? `<ol class="steps ov-log">${lines.map((l, i) => `<li class="stp" data-cur="${i === lines.length - 1 ? '1' : '0'}"><span class="stp-dot"></span><span class="stp-tx">${esc(l)}</span></li>`).join('')}</ol>`
      : '';
    const bars = groups.map((g) => `<i class="${g.rows.length > 0 && g.rows.every((r) => r.ok) ? 'done' : 'warn'}"></i>`).join('');
    const lamps = [
      ['HTTP', j(s, ['ports', 'onebot', 'http'], ''), j(s, ['ports', 'onebotHttp'])],
      ['WS', j(s, ['ports', 'onebot', 'ws'], ''), j(s, ['ports', 'onebotWs'])],
      ['WebUI 6099', '', j(s, ['ports', 'webui'])],
    ].map(([label, no, on]) => `<div class="ov-lamp ${on ? '' : 'off'}"><i></i><span>${esc(label)}${no ? ` ${esc(no)}` : ''}</span><b>${on ? '通' : '断'}</b></div>`).join('');
    const headerTone = allDone ? 'ok' : (running ? 'warn' : 'bad');
    const guardText = running ? '在盯着 · 已拉起 0 次' : '已停手 · 连续拉起失败';
    return `<div class="ov-chain-top"><span class="pill ${headerTone}"><span class="dot"></span>${allDone ? '全部就绪' : (running ? '有一步没到' : '有故障')}</span><span class="chip">QQ → 协议端 → 应用端</span></div>
      <ol class="steps ov-chain">${groupHtml}</ol>
      ${logHtml}
      <div class="ov-chain-foot"><b>${doneCount}/3</b><span class="bar-label">主节点就绪</span><span class="ov-chain-bar">${bars}</span></div>
      <div class="ov-guard">
        <div class="ov-guard-h"><span>进程守护</span><span class="ov-guard-state ${running ? '' : 'bad'}">${guardText}</span></div>
        <div class="ov-lamps">${lamps}</div>
      </div>
      <div class="hint ov-chain-hint">所有主节点默认展开；点标题可手动收起。</div>`;
  },
  overviewDash: () => ovDashHtml(S.state || DEMO),
  overviewSide: () => ovSideHtml(S.state || DEMO),
  /* `data-mb`：页面上不止一条横幅（大脑 / 计费），`data-ui` 让 DOM 守卫能精确指到
     "现在在用哪套模型"那一条 —— 否则断言只能在整页文本里搜，搜到别处的同名字就假绿。 */
  modebar: (x) => { const m = x.calc(S.state || DEMO); return `<div class="banner ${m.cls || 'info'}" data-mb="${esc(x.id || '')}" style="margin:0;"><b>${esc(m.title)}</b><span class="spacer"></span><span class="hint" style="margin:0;">${esc(m.hint || '')}</span></div>`; },
  update: () => `<div class="upd" id="upd-box">${updateHtml()}</div>`,
  pill: (x) => { const p = x.calc(S.state || DEMO); return `<span class="pill ${p.cls || ''}"><span class="dot"></span>${esc(p.text)}</span>`; },

  /* ── 状态卡组（2026-10-02 运行总览页重排）────────────────────────────
     ⚠️ **它替代的是 `kv`，不是"kv 的更好版本"** —— 判据是：
        `kv` 把 N 行信息压成等权的两列文本，读者要**逐行读文字**才能
        找出"哪个坏了"。而这页的信息**天然分三态**（通 / 断 / 未知），
        三态就该有**三种视觉**，不该只在文字里区分。

     每张卡：图标 + 名称 + 一个大数值 + 一行补充说明。
     图标同时是**状态位**（`data-st` 驱动颜色）—— 于是"扫一眼看颜色"就够了，
     不用读文字。这是"可视化"真正的意思：**把判断交给视觉系统，而不是眼睛读字符串**。

     `items` 由 schema 给：`{ ico, label, value, sub, st }`，
     其中 `st ∈ ok | warn | bad | off`（`off` = 不适用/未配置）。
     ⚠️ 状态是**数据**（`st`）而不是从value 里猜字符串 ——
        猜的话 "1 个" 和 "0 个" 要靠正则，而"断"有太多写法。 */
  statusGrid: (x) => {
    const s = S.state || DEMO;
    const items = x.items.map((it) => {
      let v, sub = '', st = 'off';
      try { v = typeof it.value === 'function' ? it.value(s) : it.value; } catch (e) { v = '—'; }
      if (typeof it.sub === 'function') { try { sub = it.sub(s); } catch { sub = ''; } }
      /* ⚠️ `st` 允许传**函数**：状态是**算出来的**（"在跑" ⇒ ok），
         写在 schema 的同一个 item 里，值与状态就不会各说各话。
         ⚠️ 早先这里直接 `it.st || 'off'` ⇒ 传函数时**函数被插进 HTML**，
         页面上出现一段函数源码。判据：凡是要放进 HTML 属性的值，
         **必须先问"它到运行时还是不是那个类型"**。 */
      if (typeof it.st === 'function') { try { st = it.st(s); } catch { st = 'off'; } }
      else st = it.st || 'off';
      /* 状态只许来自闭集 —— 拼错一个字符串会得到"没有颜色的状态"，
         而那与"状态正常"在页面上长得一样。 */
      if (['ok', 'warn', 'bad', 'off'].indexOf(st) < 0) st = 'off';
      const goAttr = it.go ? ` data-go="${esc(it.go)}" title="点击前往对应页"` : '';
      return `<div class="sg-cell" data-st="${st}"${goAttr}>
        <div class="sg-ico">${Icons.icon(it.ico, { size: 20 })}</div>
        <div class="sg-body">
          <div class="sg-label">${esc(it.label)}</div>
          <div class="sg-value">${esc(v)}</div>
          ${sub ? `<div class="sg-sub">${esc(sub)}</div>` : ''}
        </div>
      </div>`;
    }).join('');
    return `<div class="sg">${items}</div>`;
  },

  /* ── 端口三态（HTTP / WS / WebUI 各自独立）────────────────────────────
     ⚠️ 为什么单独一个控件：这三条**各自独立**（HTTP 通但 WS 断是真实故障），
        而原版把它们拼进一行 `HTTP 通 · WS 通 · WebUI 通`——
        **一行里三个状态，坏的那个要被逐字读出来**。
        拆成三个独立格子之后，坏的那个自己会变红，眼睛不用找。 */
  ports: (x) => {
    const s = S.state || DEMO;
    const cells = x.items.map((p) => {
      let on = false;
      try { on = typeof p.get === 'function' ? !!p.get(s) : !!p.get; } catch { on = false; }
      /* 「这一格探的是**哪个端口**」要能看见（2026-10-09 · 第 53 轮 B2）：
         端口现在来自配置（`onebot.wsUrl`），而"端口对不上"的表现恰好就是"断" ——
         把端口号摆在名字里，用户一眼能核对"面板探的是不是我在 NapCat 里配的那个"，
         不用去猜。与 `hint` / `metric` 同款：`label` 允许是函数（按状态算）。 */
      let lbl = p.label;
      try { if (typeof lbl === 'function') lbl = lbl(s); } catch { lbl = ''; }
      return `<div class="port" data-on="${on ? '1' : '0'}">
        <span class="port-led"></span>
        <span class="port-name">${esc(lbl)}</span>
        <span class="port-st">${on ? '通' : '断'}</span>
      </div>`;
    }).join('');
    return `<div class="ports">${cells}</div>`;
  },
  hint: (x) => `<div class="hint">${esc(x.calc(S.state || DEMO))}</div>`,

  /* ── 按钮 ── */
  /* ── 按钮 ── */
  /* ⚠️ `ico` / `icoTo` 是**图标变形**的接线（2026-10-02）：
       `ico`   初始图标名
       `icoTo` 变形目标 —— 由页面按当前状态算出，状态一变（启动→停止）
                 就**变形**过去，而不是换一张图。
     这里只输出**静态 SVG + 两个 data 属性**；真正的变形由 `morph.js`
     在 `onPageShown` 时接管（见 `mountMorphIcons`）。
     ⚠️ `icoTo === ico` 时标`data-ico-static`，让挂载层知道
       **不需要**建 morph 实例（省掉 N 个 rAF 订阅）。
     ⚠️ 变形总闸是 `MORPH_ON`，关掉就只剩静态图标，**零额外成本**。 */
  button: (x) => {
    const ico = x.ico || '';
    const icoTo = typeof x.icoTo === 'function' ? x.icoTo(S.state || DEMO) : (x.icoTo || '');
    let attrs = '';
    if (ico) {
      attrs += ` data-ico="${esc(ico)}"`;
      if (icoTo) attrs += ` data-morph-to="${esc(icoTo)}"`;
      if (icoTo && icoTo === ico) attrs += ' data-ico-static="1"';
    }
    const icoEl = ico ? Icons.icon(ico, { size: 16, cls: 'btn-ico' }) : '';
    return `<button class="btn ${x.style || 'btn-ghost'}" data-a="${esc(x.action)}"${
      attrs} title="${esc(plain(x.hint || ''))}">${icoEl}${esc(x.label)}</button>`;
  },
  buttons: (x) => `<div class="f">${x.label ? lb(x) : ''}
      ${x.hint ? `<span class="hint">${mdBold(x.hint)}</span>` : ''}
      <div class="btn-row">${(x.items || []).filter((it) => !it.when || it.when(S.state || DEMO)).map((it) => ctrlHtml(it)).join('')}</div></div>`,

  /* ── 输入类 ── */
  text: (x) => fieldInput(x, 'text'),
  password: (x) => fieldInput(x, 'password'),
  number: (x) => fieldInput(x, 'number'),
  time: (x) => fieldInput(x, 'time'),
  select: (x) => fieldInput(x, 'select'),
  seg: (x) => {
    const cur = String(valueOf(x) ?? '');
    const opts = typeof x.options === 'function' ? x.options(S.state || DEMO) : x.options;
    return `<div class="f">${regd(x)}${lb(x)}<div class="seg" data-seg="${esc(x.id || '')}">${opts.map((o) => `
      <label${o.title ? ` title="${esc(o.title)}"` : ''}><input type="radio" name="${esc(x.id)}" value="${esc(o.v)}" ${String(o.v) === cur ? 'checked' : ''} ${ctlA(x)}><span>${esc(o.l)}</span></label>`).join('')}</div>${hintOf(x)}</div>`;
  },
  /* ── 档位进度条（`ticks` · 2026-10-21 由竖向刻度改为横向）────────────
     ⚠️ **它是 `seg` 的另一种呈现，不是新的一套数据契约**：
        读值走 `valueOf(x)`、写值走 `setValue(x, v)`、选项来源与 `seg` **同一个**
        `x.options`（多半是函数，从后端 `customMeta` 取）。所以任何一处改数据
        两边都跟着变，不存在"进度条那份数据是抄的"。

     ── 为什么是横向进度条，而不是竖向刻度 / 等宽按钮 ──────────────────
     档位有**顺序**（短→中→长 / 低→高）。`.seg` 把三档排成等宽按钮，
     间距只表达"它们同类"，**不表达"谁比谁多"**；竖向刻度能表达顺序，
     但对「回复长短」这种三档格子来说，竖柱会被读成柱状图。
     横向进度条把"当前走到第几档"画成一段液面，既保留顺序，又与项目里
     既有的 `range` 控件同一种材质 —— 用户不用学第二套视觉语言。

     ⚠️ 液面宽度是**档位覆盖的轨道比例**（选第 i 档 ⇒ 前 i+1 段亮），
        不是业务百分比。所以这里只把档名写成大字，**不再显示 0%/50%/100%**
        —— 那个数字不是"回复长短的百分比"，写出来只会让人以为它可量化。

     ⚠️ **少于 3 档自动退回 `seg`**：2 档时进度条与两个等宽按钮信息量相同，
        只多一层指针逻辑。守卫按实际档数判，不写死"至少 3 档"——
        思考强度的档数由模型能力表下发，可能只有 2 档。

     ⚠️ **无障碍**：可视层是 `role="slider"`，原生 radio 仍在（视觉隐藏）
        负责表单语义与读屏；键盘 ← → 换档。两条通道并存会让读屏念两次，
        所以原生那组用 `.tkx-native` 移出可视区而不是 `display:none`
        （后者会让它**从无障碍树里消失**）。 */
  ticks: (x) => {
    const cur = String(valueOf(x) ?? '');
    const opts = typeof x.options === 'function' ? x.options(S.state || DEMO) : (x.options || []);
    if (opts.length < 3) return RENDER.seg(x);

    const n = opts.length;
    const idx = Math.max(0, opts.findIndex((o) => String(o.v) === cur));
    /* 每一档占 1/n 的轨道；选到第 i 档 ⇒ 液面覆盖前 i+1 段。
       不用 idx/(n-1)：那会让第一档停在 0%，看起来像"什么都没选"。 */
    const pctOf = (i) => Math.round(((i + 1) / n) * 1000) / 10;
    const stops = Array.from({ length: n - 1 }, (_, i) =>
      `<i class="tkx-stop" aria-hidden="true" style="left:${(((i + 1) / n) * 100).toFixed(3)}%"></i>`).join('');
    const legend = opts.map((o, i) =>
      `<span${i === idx ? ' data-on="true"' : ''}>${esc(o.l)}</span>`).join('');

    return `<div class="f tkx" data-tk="${esc(x.id)}" data-n="${n}" style="--p:${pctOf(idx)}%">
      ${regd(x)}
      <div class="rng-head">
        ${lb(x)}
        <b class="rng-val tkx-name">${esc(opts[idx]?.l || '')}</b>
      </div>
      <!-- 整行一个 handler（见 mountTicks）：点击 / 拖动 / 键盘都只改原生 radio，
           不另开写值路径。液面只是读数，不接事件。 -->
      <div class="rng-track tkx-row" data-tk-row role="slider" tabindex="0"
           aria-label="${esc(x.label || '档位')}" aria-valuemin="0" aria-valuemax="${n - 1}"
           aria-valuenow="${idx}" aria-valuetext="${esc(opts[idx]?.l || '')}">
        <span class="rng-fill"></span>${stops}
      </div>
      <div class="tkx-legend">${legend}</div>
      <!-- 原生 radio：无障碍与表单语义的真正载体，视觉上移出但**不进无障碍树** -->
      <div class="tkx-native" aria-hidden="false">${opts.map((o) => `
        <label><input type="radio" name="${esc(x.id)}" value="${esc(o.v)}"
               ${String(o.v) === cur ? 'checked' : ''} ${ctlA(x)}><span>${esc(o.l)}</span></label>`).join('')}</div>
      ${hintOf(x)}</div>`;
  },

  /* ── 进度条（`range` · 2026-10-17）──────────────────────────────────────
     它是一个**真滑块**，不是"画得像滑块的 div"：原生 `<input type="range">` 铺在轨道上
     （透明、可点可拖、自带 role=slider 与键盘 ←/→），视觉层（填充 / 水滴把手 / 刻线）
     全部由 CSS 按 `--p` 画。这样做的好处是**无障碍不用另写一套**，坏处是
     必须在 `input` 事件里同步 `--p` 与读数字 —— 见下面的 document 级委托。

     ⚠️ 读数字的文本**只由 `rngFmt` 生成**（渲染时一次、拖动时一次）：两处各写一份
        格式化，就会出现"拖着是 5 分钟、松手变 0.08 小时"这种同一格说两套话。 */
  range: (x) => {
    S.reg.set(x.id, x);
    /* ⚠️ 不能用 `Number(valueOf(x))` 一句话：`Number('')` 是 0，而 0 **是**一个合法的
       业务值 ⇒ "没读到配置" 会被画成"0 分钟"，看起来像默认值被改矮了。
       空 / null / 非数 一律回落到 `min`，那是这张卡在老后端上的正确样子。 */
    const got = valueOf(x);
    const raw = Number(got);
    const v = (got === '' || got == null || !Number.isFinite(raw)) ? Number(x.min ?? 0) : raw;
    const pos = rngPosOf(x, v);
    const marks = (x.marks || []).map((m) => `<i class="rng-mark" style="left:${(rngPosOf(x, m) / 10).toFixed(2)}%"></i>`).join('');
    return `<div class="f rng" data-rng="${esc(x.id)}" style="--p:${(pos / 10).toFixed(2)}%">
      <div class="rng-head">
        <span class="f-lb">${esc(x.label || '')}</span>
        <b class="rng-val">${esc(rngFmt(x, v))}</b>
      </div>
      <div class="rng-track">
        <input type="range" min="0" max="1000" step="1" value="${pos}" ${did(x)} data-a="field"
               aria-label="${esc(x.label || '')}" aria-valuetext="${esc(rngFmt(x, v))}" />
        <span class="rng-fill"></span>${marks}<span class="rng-knob"></span>
      </div>
      <div class="rng-ends"><span>${esc(rngFmt(x, x.min ?? 0))}</span><span>${esc(rngFmt(x, x.max ?? 100))}</span></div>
      ${hintOf(x)}
    </div>`;
  },

  tags: (x) => {
    const v = valueOf(x);
    const arr = Array.isArray(v) ? v : String(v ?? '').split(/[,，\s]+/).filter(Boolean);
    return `<div class="f">${regd(x)}${lb(x)}
      <input type="text" ${ctlA(x)} value="${esc(arr.join(', '))}" placeholder="${esc(x.ph || '')}" />
      <div class="chip-list">${arr.length ? arr.map((t, i) => `<span class="chip">${esc(t)}<button class="x" data-a="tag.del" data-p="${esc(x.id)}|${i}" title="删掉这一项">×</button></span>`).join('') : '<span class="hint">还没有</span>'}</div>
      ${hintOf(x)}</div>`;
  },
  switch: (x) => {
    const on = !!valueOf(x);
    const h = typeof x.hint === 'function' ? x.hint(S.state || DEMO) : x.hint;
    return `<div class="f">${regd(x)}<label class="sw">
      <input type="checkbox" ${ctlA(x)} ${on ? 'checked' : ''}><span class="track"></span><span class="txt">${esc(x.label || '')}</span></label>
      ${h ? `<span class="hint">${mdBold(h)}</span>` : ''}</div>`;
  },
  /* HUD 轮播项：勾选 + 顺序合成一张表（原型 LAB 的「轮播项与顺序」）。
     ⚠️ 每行勾选框登记成独立 `switch` 控件，仍走统一 field 写口；
        上移/下移只改 order，不复制第二份 enabled。 */
  hudItems: () => {
    const I = window.Island;
    if (!I) return noteHtml('HUD 岛未加载（island.js 未取到），这一页暂时读不到设置。', 'bad');
    const cfg = I.cfg();
    const meta = I.items();
    const nameOf = (id) => (meta.find((m) => m.id === id) || {}).title || id;
    const rows = cfg.order.map((id, i) => {
      const on = cfg.enabled.indexOf(id) >= 0;
      const idCtl = 'hud.i.' + id;
      const ctl = { id: idCtl, read: () => on, save: (v) => { I.setItem(id, !!v); return null; } };
      S.reg.set(idCtl, ctl);
      return `<div class="hud-row" data-hud-id="${esc(id)}">
        <label class="hud-check"><input type="checkbox" ${ctlA(ctl)} ${on ? 'checked' : ''}><span>${esc(nameOf(id))}</span></label>
        <span class="hud-ord">${i + 1}</span>
        <span class="hud-move">
          <button type="button" class="btn btn-ghost btn-xs" data-a="hud.move" data-p="${esc(id)}|-1" ${i === 0 ? 'disabled' : ''} aria-label="上移 ${esc(nameOf(id))}">↑</button>
          <button type="button" class="btn btn-ghost btn-xs" data-a="hud.move" data-p="${esc(id)}|1" ${i === cfg.order.length - 1 ? 'disabled' : ''} aria-label="下移 ${esc(nameOf(id))}">↓</button>
        </span>
      </div>`;
    }).join('');
    const dbg = I.debug();
    const rot = dbg.rotation.join(' → ') || '空';
    return `<div class="f hud-list">${rows}
      <div class="hint">活动项：${esc(dbg.activeTitle || '—')} · 轮播：${esc(rot)}</div>
      <div class="hint">${cfg.enabled.length} / ${cfg.order.length} 项启用；顺序就是轮播顺序。全不选时岛仍显示当前项，但不再自动轮播。</div>
    </div>`;
  },
  /* HUD 实时读数：给「调试」卡用 —— 全部读 Island.debug()，不在页面另算一份。 */
  hudMetrics: () => {
    const I = window.Island;
    if (!I) return noteHtml('HUD 岛未加载（island.js 未取到）。', 'bad');
    const d = I.debug();
    const cfg = I.cfg();
    return `<div class="metrics">
      <div class="metric"><div class="n">${esc(d.activeTitle || '—')}</div><div class="l">活动项</div></div>
      <div class="metric"><div class="n">${esc(d.rotation.join(' → ') || '空')}</div><div class="l">轮播顺序</div></div>
      <div class="metric"><div class="n">${d.width}px</div><div class="l">实际宽度</div></div>
      <div class="metric"><div class="n">${esc(d.density)}</div><div class="l">密度</div></div>
      <div class="metric"><div class="n">${d.timelineMs}ms</div><div class="l">切换时间轴</div></div>
      <div class="metric"><div class="n">${d.anims}</div><div class="l">岛内动画</div></div>
      <div class="metric"><div class="n">${esc(cfg.switchMode)}</div><div class="l">切换方式</div></div>
      <div class="metric"><div class="n">${d.frozen ? '冻结' : (d.reduced ? '减弱' : '正常')}</div><div class="l">播放状态</div></div>
    </div>`;
  },
  featSwitch: (x) => {
    const s = S.state || DEMO;
    const caps = capsOf(s);
    const on = !!j(s, ['config', 'features', x.feat]);
    const unsupported = caps && caps.known && caps.features && caps.features[x.feat] === false;
    const reason = caps?.reasons?.[x.feat] || '';
    return `<div class="f"><label class="sw${LIQUID_ON && !unsupported ? ' liq-host' : ''}" title="${esc(x.hint || '')}">
      <input type="checkbox" data-a="feat" data-feat="${esc(x.feat)}" ${on ? 'checked' : ''} ${unsupported ? 'disabled' : ''}><span class="track"></span>
      <span class="txt">${esc(s.featureLabels?.[x.feat] || x.label)}</span></label>
      ${unsupported ? `<span class="hint warn">当前大脑不支持：${esc(reason || '模型能力表里标了 false')}</span>` : `<span class="hint">${esc(x.hint || '')}</span>`}</div>`;
  },

  /* ── 领域块 ── */
  sleepLine: (x) => {
    const s = S.state || DEMO, sl = j(s, ['custom', 'sleep'], {});
    if (!sl.enabled) return `<div class="hint">作息：<b>未启用</b> —— 它从不睡。要开去「发言 → 主动与免打扰」。</div>`;
    return `<div class="hint">作息：<b>${esc(sl.bed)}</b> 睡 → <b>${esc(sl.wake)}</b> 自然醒${sl.goodnight ? ` · 睡前道晚安：「${esc(sl.goodnight)}」` : ''}；叫醒关键词 ${sl.wakeWords?.length ? esc(sl.wakeWords.join('、')) : '（没设）'}。</div>`;
  },
  sleepDetail: (x) => {
    const s = S.state || DEMO, sl = j(s, ['custom', 'sleep'], {}), ef = j(s, ['effective', 'sleep'], null);
    return `<div class="f">${lb({ label: '运行时状态' })}
      ${ef ? `<dl class="kv">${Object.entries(ef).map(([k, v]) => `<dt>${esc(SLEEP_LABEL[k] || k)}</dt><dd class="mono">${esc(sleepVal(k, v))}</dd>`).join('')}</dl>`
      : `<div class="hint">机器人没在跑，或这一版还没下发睡眠态。作息本身${sl.enabled ? '已启用' : '<b>未启用</b>'}。</div>`}
      <div class="hint">这一栏是**这一版新加的**：旧页面只有上面那两行只读提示，睡眠状态在页面上一格都看不到（只能从 trace 里翻）。</div></div>`;
  },
  modelPick: (x) => {
    const s = S.state || DEMO;
    const cur = j(s, ['config', 'model'], '');
    const models = S.extra.models || [];
    return `<div class="f">${lb(x, '<span class="spacer"></span>')}
      <div class="f-inline">
        <select class="grow" data-a="model.pick">${models.length
          ? models.map((m) => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(s.modelLabels?.[m] || m)}</option>`).join('')
          : `<option value="${esc(cur)}">${esc(s.modelLabels?.[cur] || cur || '（点右边「读取」）')}</option>`}</select>
        <button class="btn btn-ghost btn-sm" data-a="models.load">读取</button>
      </div>
      <div class="hint">也可以直接填这家的模型名：</div>
      <input type="text" data-a="model.free" value="${esc(cur)}" placeholder="例如 glm-4.6v" />
      <div class="hint">降级链（机器人按顺序试，被限流/超时就换下一个）：<b>${esc((j(s, ['config', 'fallbackModels'], []) || []).map((m) => s.modelLabels?.[m] || m).join(' → ') || '无')}</b></div>
    </div>`;
  },
  /* ── 免费额度：**一颗按钮**（2026-10-17 · 维护者第二次点名）────────────
     它要回答的只有一句：「这家会不会扣钱、额度去哪看」。
     形态：卡片右下角一颗 ghost 按钮 —— 「免费额度 · 限时赠送 ↗」；点一下直接去那家的
     额度/余额官网。解释文案（额度规则 / 面板查不到实时余额 / 千问那句"用完即停要自己开"）
     全部塞进 `title`，鼠标停一下就有，不占版面。
     ⚠️ 文案仍全部来自 `state.quotaPlans`（`src/free-quota.js` 是唯一实现），
        前端不写规则 —— 那句提醒是真会让人被扣钱的，抄一份就多一处会烂的地方。
     ⚠️ 「必须手动处理」用一颗小红点表示，不用一段文字。 */
  quotaBtn: (x) => {
    const q = x.calc(S.state || DEMO);
    /* ⚠️ 两个 `width:100%` 是必须的：`.f` 在卡片里是 flex 列，
       `.btn-row` 不自带宽度 ⇒ 它会缩到内容宽，`justify-content:flex-end` 就无处可对齐
       （实拍：按钮跑到左下角去了。维护者要的是**右下角**）。 */
    return `<div class="f" style="margin:0;width:100%;"><div class="btn-row" style="justify-content:flex-end;margin:0;width:100%;">
      <button class="btn btn-ghost btn-sm quota-btn" data-a="quota.open" title="${esc(q.title)}"${q.hasUrl ? '' : ' data-no-url="1"'}>
        ${esc(q.label)}${q.mustDo ? '<i class="q-dot" title="这家有个开关要你自己打开，不打开会静默扣钱"></i>' : ''}<span class="q-go">↗</span>
      </button></div></div>`;
  },
  /* ── 大脑切换标签（2026-10-17 · 维护者第三轮定稿）────────────────────
     一句话：**这一行就是"我建过的模型"，亮着的那一颗就是"现在在用的"**。
       · 不再摆 本机 / DeepSeek / 智谱 / 千问 这些预设标签 —— 它们不是用户建的；
       · 新建（云端 / 本地都行）之后自动出现在这里，点一下就切；
       · 右键弹改名 / 改设置 / 删除（与原来列表行的菜单同一份实现）。
     ⚠️⚠️ 选中态跟 **`config.activeCustomId`**（面板已选定），**不再跟 `effective`**。
        上一版是"高亮 = 机器人已读入；已选未读 = 虚线 +「待生效」"——于是切换之后
        要等机器人热重载（`waitEffectiveApplied` 最长 12 秒）界面才有反应，
        用户看到的就是"点了没反应"。维护者 2026-10-17 点名去掉这个中间态：
        **点了就是它，用户自己会测**。
     判据只有一份，住 `schema.js` 的 `brainPickOf()` —— 横幅、标签、下面那几行 kv
     全从它取，所以它们不可能各说一套。 */
  brainTags: () => {
    const s = S.state || DEMO;
    const pick = brainPickOf(s);
    const customs = j(s, ['config', 'customBrains'], []) || [];
    /* 选中态**只认 activeCustomId**。不搞"按地址+模型名反查"那种启发式：
       用户建的千问和内置的千问可以填成一模一样，反查会让"其实在用某套内置"时
       也亮起一颗自定义标签（一句话两个意思）。没有 activeCustomId ⇒ 就是不亮，
       同时后端那侧也不会把它当自定义大脑用（`materializeBrain` 每次都写这个字段）。 */
    const activeId = pick.customId;
    const tag = (o) => {
      const on = !!o.id && o.id === activeId;
      return `<button class="brain-tag${on ? ' on' : ''}${o.add ? ' add' : ''}"
        data-a="${o.a}"${o.p ? ` data-p="${esc(o.p)}"` : ''}${o.id ? ` data-brain="${esc(o.id)}"` : ''}${o.add ? '' : ` aria-pressed="${on}"`}${o.title ? ` title="${esc(o.title)}"` : ''}>
        <span class="nm">${esc(o.name)}${on ? '<span class="use-tag">在用</span>' : ''}</span>${o.sub ? `<span class="sub mono">${esc(o.sub)}</span>` : ''}</button>`;
    };
    const items = customs.map((b) => tag({
      id: b.id,
      name: b.name,
      sub: b.model,
      a: 'brain.use',
      p: b.id,
      title: `切到「${b.name}」（${vendorShort(b.provider)} · ${b.model}）\n右键：改名 / 改设置 / 删除`,
    }));
    items.push(tag({ name: '＋ 自定义模型', add: true, a: 'brain.add', title: '新建一个云端或本地模型' }));
    const empty = customs.length ? ''
      : '<div class="hint" style="margin-top:6px;">还没有模型 —— 点「＋ 自定义模型」建一个（云端 / 本地都行）。</div>';
    return `<div class="f">${lb({ label: '我的模型' }, '<span class="spacer"></span><span class="hint" style="margin:0;">点一下切换 · 右键可改名 / 删除</span>')}`
      + `<div class="brain-tags">${items.join('')}</div>${empty}</div>`;
  },
  routeBoard: (x) => {
    const s = S.state || DEMO;
    const list = j(s, ['config', 'fallbackModels'], []) || [];
    // 候选池 = **当前这家**的模型清单（`modelCaps` 是后端按服务商算好的能力表）。
    //
    // ⚠️ 这里顺手修掉了一个**一直存在、但没人发现**的缺陷：原来的写法是
    //    `j(s, ['zhipuMeta', 'freeModels'])`，而 `zhipuMeta` 下发的就是
    //    `ZHIPU_MODEL_META` 本身 —— 它**没有** `freeModels` 这个字段
    //    ⇒ 候选池**恒为空数组**，展开「候选模型」永远是那句"这一版没拿到"。
    //    它活得久的原因很典型：写法**读起来毫无破绽**（`.freeModels` 看着就该存在），
    //    而空数组的表现是"一句像样的提示"，不像故障。
    //    接千问时它变成硬伤：千问的页面上连候选都拿不到，等于线路加不了模型。
    const provider = j(s, ['config', 'provider'], 'zhipu');
    const pool = Object.keys(j(s, ['modelCaps', provider], null) || {});
    const known = new Set(pool);
    /* ⚠️ 这份列表存的是**主模型之后**的那几条（`/api/config` 的约定：主模型由 `config.model`
       承担，链里再出现一次会被静默剔掉）。以前这里把第 1 行标成「主模型」——
       于是页面上同时出现「正在使用 qwen3.8-max」和「主模型 GLM-4.5-Air」两句互相打架的话，
       用户以为面板把主模型换掉了（2026-10-17 截图）。现在主模型单独一行，列表是备用链。 */
    const main = String(j(s, ['config', 'model'], '') || '');
    /* 清单里没有的条目 = 这家不会响应它（老数据 / 别家大脑的遗留）。**标出来**，
       并给一个一键清掉的入口 —— 不标的话它看起来和正常条目一模一样。 */
    const foreign = known.size ? list.filter((m) => !known.has(m)) : [];
    /* ⚠️ 撤销条**不在这里算**：`_routeUndo` 是模块级状态（活过一次渲染），
       所以「上一次的顺序」是**上一次提交前**的顺序，而不是"从服务端再读一遍"。
       后者做不到 —— 服务端只存当前值，旧值只有前端记得。 */
    const undo = _routeUndo;
    return `<div class="f">${lb({ label: '试模型的顺序' }, '<span class="spacer"></span>')}
      <div class="row flat f-inline"><span class="tag accent">主模型</span>
        <span class="grow mono">${esc(s.modelLabels?.[main] || main || '（没设）')}</span>
        <span class="hint" style="margin:0;">先试它，被限流/超时才往下走</span></div>
      <div class="rows srt" data-rb>${list.length ? list.map((m, i) => `<div class="row flat f-inline srt-item" data-srt-id="${esc(m)}" data-i="${i}">
        <button class="srt-grip" type="button" title="按住拖动改顺序（也可点它后按 ↑↓）" aria-label="调整 ${esc(s.modelLabels?.[m] || m)} 的顺序，当前第 ${i + 1} 位，共 ${list.length} 位">⠿</button>
        <span class="tag ${known.size && !known.has(m) ? 'warn' : 'plain'}">${known.size && !known.has(m) ? '这家没有' : `第 ${i + 1} 备用`}</span>
        <span class="grow">${esc(s.modelLabels?.[m] || m)}</span>
        <button class="btn btn-xs" data-a="route.up" data-p="${i}" title="上移" aria-label="把 ${esc(s.modelLabels?.[m] || m)} 上移">↑</button>
        <button class="btn btn-xs" data-a="route.down" data-p="${i}" title="下移" aria-label="把 ${esc(s.modelLabels?.[m] || m)} 下移">↓</button>
        <button class="btn btn-xs btn-danger" data-a="route.del" data-p="${i}" title="从线路里删掉" aria-label="把 ${esc(s.modelLabels?.[m] || m)} 从线路里删掉">×</button>
      </div>`).join('') : '<div class="empty">还没有备用模型 —— 下面是候选。</div>'}</div>
      ${foreign.length ? `<div class="btn-row"><button class="btn btn-ghost btn-sm" data-a="route.clean">清掉不属于这家的 ${foreign.length} 条</button>
        <span class="hint warn">这家的模型清单里没有：${esc(foreign.join('、'))}（换模型时会连续撞墙）</span></div>` : ''}
      ${undo ? `<div class="btn-row"><button class="btn btn-ghost btn-sm" data-a="route.undo">撤销上一次改顺序</button>
        <span class="hint">上一次把「${esc(undo.label)}」挪到了第 ${undo.at + 1} 位。</span></div>` : ''}
      <details class="det"><summary>候选模型（点一下加进线路）</summary>
        <div class="chip-list">${(pool.length ? pool : []).map((m) => `<button class="chip" data-a="route.add" data-p="${esc(m)}">+ ${esc(s.modelLabels?.[m] || m)}</button>`).join('') || '<span class="hint">候选名单由后端下发；这一版没拿到。</span>'}</div>
        <div class="hint" style="margin-top:6px;">${provider === 'qwen'
          ? '千问的赠送额度是<b>按模型发的</b>（每个模型各 100 万 token）—— 所以这条链排得长：换一个模型等于换一份额度。'
          : '官方永久免费的 Flash 档在晚高峰很挤（实测 429），所以默认排在最后 —— 让它们先试会让每条消息都白等一次超时。'}</div>
      </details>
      <div class="btn-row"><button class="btn btn-ghost btn-sm" data-a="route.reset">恢复实测最优</button>
        <span class="hint">按<b>当前这家</b>的默认链路重排；点完立即生效，不用另点保存。</span></div></div>`;
  },
  packages: (x) => {
    const p = S.extra.packages;
    return `<div class="f">${lb({ label: x.label || '赠送额度' })}
      ${p ? `<div class="rows">${(p.packages || p.items || []).map((k) => `<div class="row flat f-inline"><span class="grow">${esc(k.name || k.id || '')}</span><span class="mono">${esc(String(k.left ?? k.balance ?? ''))}</span></div>`).join('') || '<div class="empty">没有按 token 计费的推理包。</div>'}</div>`
      : '<div class="hint">点「刷新」拉一次实时余额。只列按 token 计费的推理包 —— 搜索次数包 / 图片次数包对群聊没用。</div>'}
      <div class="btn-row"><button class="btn btn-ghost btn-sm" data-a="packages.load">刷新</button></div></div>`;
  },
  usageBySource: (x) => {
    const s = S.state || DEMO, rs = j(s, ['usage', 'bySource'], []) || [];
    if (!rs.length) return `<div class="f">${lb({ label: x.label })}<div class="empty">还没有按来源分的账。</div></div>`;
    return `<div class="f">${lb({ label: x.label })}<div class="scroll-y"><table class="tbl">
      <colgroup><col style="width:38%"><col><col></colgroup>
      <thead><tr><th>来源</th><th class="num">条数</th><th class="num">token</th></tr></thead>
      <tbody>${rs.map((r) => `<tr><td>${esc(r.label || r.key)}</td><td class="num">${fmtNum(r.calls)}</td><td class="num">${fmtNum(r.tokens)}</td></tr>`).join('')}</tbody>
    </table></div></div>`;
  },
  usageByChat: (x) => {
    const s = S.state || DEMO, rs = j(s, ['usage', 'byChat'], []) || [];
    if (!rs.length) return `<div class="f">${lb({ label: x.label })}<div class="empty">还没有按会话分的账。</div></div>`;
    return `<div class="f">${lb({ label: x.label })}<div class="scroll-y"><table class="tbl">
      <colgroup><col style="width:42%"><col><col><col style="width:86px"></colgroup>
      <thead><tr><th>会话</th><th class="num">条数</th><th class="num">token</th><th class="num">花费</th></tr></thead>
      <tbody>${rs.map((r) => `<tr><td class="mono">${esc(r.key)}</td><td class="num">${fmtNum(r.calls)}</td><td class="num">${fmtNum(r.tokens)}</td><td class="num">¥${Number(r.cost || 0).toFixed(4)}</td></tr>`).join('')}</tbody>
    </table></div></div>`;
  },
  usageByDay: (x) => {
    const s = S.state || DEMO, rs = j(s, ['usage', 'byDay'], []) || [];
    if (!rs.length) return `<div class="f">${lb({ label: x.label })}<div class="empty">还没有按天的账。</div></div>`;
    return `<div class="f">${lb({ label: x.label })}<div class="scroll-y"><table class="tbl">
      <colgroup><col style="width:38%"><col><col><col style="width:86px"></colgroup>
      <thead><tr><th>日期</th><th class="num">条数</th><th class="num">token</th><th class="num">花费</th></tr></thead>
      <tbody>${rs.map((r) => `<tr><td class="mono">${esc(r.key)}</td><td class="num">${fmtNum(r.calls)}</td><td class="num">${fmtNum(r.tokens)}</td><td class="num">¥${Number(r.cost || 0).toFixed(4)}</td></tr>`).join('')}</tbody>
    </table></div></div>`;
  },
  /**
   * 最近记录表。⚠️ 下面那三组列宽是**按内容最坏情况**给的，不是随手填的：
   * `table.tbl` 是 `table-layout: fixed` —— 列宽完全由 `<colgroup>` 决定、与内容无关，
   * 给窄了就是**截断**，而且是"看起来像个正常数字"的那种截断。
   *
   * 实测（1440px 视口，取 `scrollWidth > clientWidth`）：
   *   「花费」原来 64px，而 `¥0.0000` 要 72px ⇒ 每一格都渲染成 `¥0.0…`；
   *   「输入 / 输出」原来 56px，而 token 会到 `123,456`（7 字）⇒ 同样是截断。
   * 所以改成 80 / 80 / 92。**改这几个数字之前先跑一次同一个量测**，别凭感觉调。
   */
  usageTable: (x) => {
    const s = S.state || DEMO, rs = j(s, ['usage', 'recent'], []) || [];
    if (!rs.length) return `<div class="f">${lb({ label: x.label })}<div class="empty">还没有记录。</div></div>`;
    return `<div class="f">${lb({ label: x.label })}<div class="scroll-y"><table class="tbl">
      <colgroup><col style="width:74px"><col style="width:96px"><col><col style="width:80px"><col style="width:80px"><col style="width:92px"></colgroup>
      <thead><tr><th>时间</th><th>模型</th><th>来源</th><th class="num">输入</th><th class="num">输出</th><th class="num">花费</th></tr></thead>
      <tbody>${rs.map((r) => `<tr><td class="mono">${new Date(r.t).toLocaleTimeString().slice(0, 5)}</td><td>${esc(r.model || '')}</td>
        <td><span class="tag ${r.free ? 'ok' : 'warn'}">${esc(r.origin || '')}${r.free ? ' · 免费' : ''}${r.source ? ` · ${esc(r.source)}` : ''}</span></td>
        <td class="num">${fmtNum(r.p)}</td><td class="num">${fmtNum(r.c)}</td><td class="num">¥${Number(r.cost || 0).toFixed(4)}</td></tr>`).join('')}</tbody>
    </table></div></div>`;
  },
  scenes: (x) => {
    const s = S.state || DEMO, meta = j(s, ['customMeta', 'scenes'], null);
    if (!meta) return '<div class="empty">后端没下发场景定义（customMeta.scenes 为空）。</div>';
    return `<div class="grid2">${Object.entries(meta).map(([k, o]) => fieldInput(
      { id: `sc.${k}`, t: 'text', label: o.label, hint: o.hint, ph: o.ph, bind: `scenes.${k}` }, 'text')).join('')}</div>`;
  },
  skills: (x) => {
    const arr = draftArr('skills');
    if (!arr.length) return '<div class="empty">还没有技能。知识包＝某方面的本事；角色卡＝成套的人格。</div>';
    return `<div class="rows">${arr.map((sk, i) => `
      <div class="row">
        <div class="row-h">
          <span class="tag ${sk.kind === 'persona' ? 'accent' : 'info'}">${sk.kind === 'persona' ? '角色卡' : '知识包'}</span>
          <input type="text" style="flex:1;min-width:100px;" value="${esc(sk.name)}" data-a="skill.set" data-p="${i}|name" />
          <label class="sw flat"><input type="checkbox" ${sk.enabled !== false ? 'checked' : ''} data-a="skill.set" data-p="${i}|enabled"><span class="track"></span><span class="txt">启用</span></label>
          ${sk.kind === 'persona' ? `<button class="btn btn-xs" data-a="skill.snap" data-p="${i}" title="把当前的人格 / 增强 / 场景重新拍进这张卡（按群生效靠这份快照）">存当前人格</button> <button class="btn btn-xs" data-a="skill.apply" data-p="${i}" title="把这张卡的人格快照写进人格设定">套用到人格设定</button>` : ''}
          <button class="btn btn-xs btn-danger" data-a="skill.del" data-p="${i}">删</button>
        </div>
        <div class="f-inline">
          <span class="hint" style="flex:none;">触发词</span>
          <input type="text" class="grow" value="${esc((sk.triggers || []).join(', '))}" placeholder="命中才拿出来用，留空＝总是可用" data-a="skill.set" data-p="${i}|triggers" />
          <span class="hint" style="flex:none;">范围</span>
          <select style="width:auto;" data-a="skill.set" data-p="${i}|scopeType">
            ${['global', 'group', 'user'].map((v) => `<option value="${v}" ${(sk.scope?.type || 'global') === v ? 'selected' : ''}>${{ global: '全局', group: '指定群', user: '指定人' }[v]}</option>`).join('')}
          </select>
          ${sk.scope?.type && sk.scope.type !== 'global' ? `<input type="text" style="width:130px;" value="${esc(sk.scope.id || '')}" placeholder="${sk.scope.type === 'group' ? '群号' : 'QQ 号'}" data-a="skill.set" data-p="${i}|scopeId" />` : ''}
        </div>
        <textarea rows="2" placeholder="背景知识 / 它是谁" data-a="skill.set" data-p="${i}|background">${esc(sk.background || '')}</textarea>
      </div>`).join('')}</div>`;
  },
  /* 角色卡分级（十维）：数据全由后端算好（`state.personaCards`，判据在 src/persona-grade.js）。
     ⚠️ 面板不算分、不写门槛 —— 抄一份门槛表的后果是"界面上的金和真正判定的金不是一个数"。 */
  cardGrade: (x) => {
    const cards = j(S.state || DEMO, ['personaCards'], []) || [];
    if (!cards.length) {
      return '<div class="empty">还没有角色卡。去「知识包与角色卡」新建一张，'
        + '填好人格设定后点那张卡的「存当前人格」，回来这里看分数。</div>';
    }
    const dot = (tier) => `<span class="cgdot t-${esc(tier)}"></span>`;
    return `<div class="rows">${cards.map((g, i) => `
      <div class="row">
        <div class="row-h">
          ${dot(g.cellTier)}
          <b class="grow">${esc(g.name)}${g.enabled === false ? ' <span class="tag plain">未启用</span>' : ''}</b>
          <span class="tag ${g.cellTier === 'gold' ? 'accent' : 'plain'}">${esc(g.cell)}</span>
          <span class="hint">覆盖 ${Math.round(g.coverage * 100)}% · 最低 ${Math.round(g.minScore * 100)}% · 缺 ${g.gaps.length} 维</span>
          ${g.gaps.length ? `<button class="btn btn-xs" data-a="cg.adopt" data-p="${i}" title="把这张卡里已有的文字交给模型，按十维归到标准字段（先预览再写，只填空字段）">AI 认领</button>` : ''}
        </div>
        <div class="hint">${esc(g.advice)}</div>
        <div class="cg-dims">${g.dims.map((d) => `<div class="cg-dim">
          ${dot(d.tier)}<b>${esc(d.label)}</b>
          <span class="hint">${Math.round(d.score * 100)}% · ${d.filledChars} 字${d.cueHits.length ? ` · 命中「${esc(d.cueHits.slice(0, 3).join('、'))}」` : ''}</span>
        </div>`).join('')}</div>
        ${g.gaps.length ? `<details class="det"><summary>缺 ${g.gaps.length} 维 —— 抄问题，把答案写下来就补进去了</summary>
          ${g.gaps.map((gp) => `<div class="f">
            <div class="f-lb"><b>${esc(gp.label)}</b> <span class="hint">${Math.round(gp.score * 100)}%</span></div>
            <div class="hint">${esc(gp.question)}</div>
            <div class="f-inline">
              <input class="grow" type="text" placeholder="一句话就行（会写进字段 ${esc(gp.hint)}）" data-a="cg.fill" data-p="${i}|${esc(gp.id)}">
              <button class="btn btn-xs" data-a="cg.do" data-p="${i}|${esc(gp.id)}">写进这张卡</button>
            </div>
          </div>`).join('')}</details>` : '<div class="hint">十维都够材料了。</div>'}
      </div>`).join('')}</div>`;
  },
  memOverview: (x) => {
    const s = S.state || DEMO;
    const manual = (j(s, ['custom', 'memory', 'manual'], []) || []).filter((m) => m.on !== false);
    const recs = (s.memoryRecords || []).filter((r) => r.status === 'confirmed');
    return `<div class="grid2">
      <div class="f"><div class="f-lb"><b>手动记忆（生效中 ${manual.length} 条）</b></div>
        <div class="chip-list">${manual.length ? capChips(manual, (m) => `<span class="chip">${esc(m.text)}</span>`) : '<span class="hint">没有</span>'}</div></div>
      <div class="f"><div class="f-lb"><b>结构化记忆（已确认 ${recs.length} 条）</b></div>
        <div class="chip-list">${recs.length ? capChips(recs, (r) => `<span class="chip">${esc(r.text)}</span>`) : '<span class="hint">没有</span>'}</div></div>
    </div>`;
  },
  memList: (x) => {
    const arr = draftArr(x.path);
    /* ⚠️ 条目里传的是**原数组下标**：`data-p` 靠它定位"改哪一条 / 删哪一条"
       （见 `capRows` 的第三条警告）—— 用切片下标会静默改错行。 */
    const rows = arr.length
      ? capRows(arr, 'mem.manual', (m, i) => `<div class="row flat f-inline">
        <label class="sw flat"><input type="checkbox" ${m.on !== false ? 'checked' : ''} data-a="memlist.set" data-p="${i}|on"><span class="track"></span><span class="txt">启用</span></label>
        <input type="text" class="grow" value="${esc(m.text)}" data-a="memlist.set" data-p="${i}|text" />
        <button class="btn btn-xs btn-danger" data-a="memlist.del" data-p="${i}">删</button>
      </div>`)
      : '<div class="rows"><div class="empty">还没有。下面的输入框加一条。</div></div>';
    return `<div class="f">${x.note ? `<div class="hint">${x.note}</div>` : ''}
      ${rows}
      <div class="f-inline">
        <input type="text" class="grow" id="memNew" placeholder="例如：不要跟群里的张三说话 / 聊到加班就别接话" />
        <button class="btn btn-ghost" data-a="memlist.add">添加</button>
      </div></div>`;
  },
  memRecords: (x) => {
    const s = S.state || DEMO, rs = s.memoryRecords || [];
    const meta = j(s, ['customMeta', 'memoryReview'], {});
    const orders = meta.statusOrder || [];
    const labels = meta.statusLabels || {};
    // ── 记忆检索（D-M3）──────────────────────────────────────────────────
    // 走的**就是机器人那句"你还记得吗"用的同一套检索**（后端 `/api/memory/search`
    // → `recallForPrompt`）。所以这里显示的行，与模型看到的行**逐字相同** ——
    // "面板能查到、它却不记得"这种解释不清的现象从根上不会出现。
    const search = S.extra.memSearch;
    const searchBox = `<div class="f-inline">
      <input type="text" class="grow" id="memQ" placeholder="搜记忆：它回答「你还记得吗」用的是同一套检索" value="${esc(search ? search.q : '')}" />
      <button class="btn btn-ghost" data-a="mem.search">搜</button>
      ${search ? '<button class="btn btn-xs" data-a="mem.search.clear">清</button>' : ''}
    </div>`;
    const searchBlock = search
      ? (search.lines.length
        ? `<div class="hint">捞出 ${search.lines.length} 条（这就是模型看到的样子）：</div>
           <div class="rows">${search.lines.map((l) => `<div class="row flat">${esc(String(l).replace(/^-\s*/, ''))}</div>`).join('')}</div>`
        : '<div class="empty">没捞到相关内容。</div>')
      : '';
    if (!rs.length) {
      return `<div class="f">${searchBox}${searchBlock}
        <div class="empty">还没有结构化记忆。机器人观察够几次之后，这里会自己长出来。</div></div>`;
    }
    const cnt = {};
    for (const r of rs) cnt[r.status] = (cnt[r.status] || 0) + 1;
    return `<div class="f">
      ${searchBox}
      ${searchBlock}
      <div class="chip-list">${orders.map((k) => `<span class="chip">${esc(labels[k] || k)}：${cnt[k] || 0}</span>`).join('')}</div>
      ${capRows(rs, 'mem.records', (r) => `<div class="row">
        <div class="row-h"><span class="tag ${r.status === 'confirmed' ? 'ok' : r.status === 'rejected' ? 'bad' : 'warn'}">${esc(labels[r.status] || r.status)}</span>
          <span class="tag plain">${esc(r.kindShort || r.kind || '')}</span>
          ${r.subjectName ? `<span class="tag plain">关于 ${esc(r.subjectName)}</span>` : ''}
          <span class="spacer"></span><span class="hint">观察到 ${esc(String(r.samples ?? '?'))} 次</span></div>
        <div>${esc(r.text)}</div>
        ${r.detail ? `<div class="hint">依据${r.inferred ? '（含推测，别当实锤）' : ''}：${esc(r.detail)}</div>` : ''}
        <div class="row-h">
          ${['confirmed', 'rejected', 'archived'].map((k) => `<button class="btn btn-xs" data-a="mem.review" data-p="${esc(r.id)}|${k}">${esc(labels[k] || k)}</button>`).join('')}
          <span class="spacer"></span><span class="hint mono">${esc(r.chatKey || '')}</span>
        </div>
      </div>`)}</div>`;
  },
  autoMemList: (x) => {
    const s = S.state || DEMO, rs = s.autoMemory || [];
    if (!rs.length) return '<div class="empty">这份历史存量是空的。</div>';
    return capRows(rs, 'mem.auto', (m) => `<div class="row flat f-inline"><span class="grow">${esc(m.text)}</span>
      <span class="hint">${esc(m.from || '')}</span><button class="btn btn-xs btn-danger" data-a="mem.auto.del" data-p="${esc(m.id)}">删</button></div>`);
  },
  schedList: (x) => {
    const arr = draftArr(x.path);
    return `<div class="f">${x.note ? `<div class="hint">${x.note}</div>` : ''}
      <div class="rows">${arr.length ? arr.map((k, i) => `<div class="row flat f-inline">
        <input type="time" style="width:112px;" value="${esc(k.at || '')}" data-a="sched.set" data-p="${i}|at" />
        ${x.detailed ? `<input type="date" style="width:150px;" value="${esc(k.date || '')}" title="留空 = 每天这个点；填了就只在那天发一次（⚠️ 当前存不住，见下方说明）" data-a="sched.set" data-p="${i}|date" />` : ''}
        <input type="text" class="grow" value="${esc(k.text || '')}" placeholder="到点要发的内容" data-a="sched.set" data-p="${i}|text" />
        ${x.detailed ? `<input type="text" class="grow" value="${esc(k.prompt || '')}" title="填了就改成：到点让模型按这句现写（夜间摘要/周报）。填了 prompt 时上面的原文不再使用。" placeholder="或：让模型现写（例：把今天群里聊的事写个摘要）" data-a="sched.set" data-p="${i}|prompt" />
        <select style="width:110px;" title="现写出来的东西发到哪" data-a="sched.set" data-p="${i}|target">
          ${[['group', '发群里'], ['owner', '发主人私聊']].map(([v, l]) => `<option value="${v}" ${(k.target || 'group') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
        ${x.detailed ? `<select style="width:110px;" data-a="sched.set" data-p="${i}|on">
          ${[['any', '每天'], ['workday', '只工作日'], ['rest', '只休息日']].map(([v, l]) => `<option value="${v}" ${(k.on || 'any') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
        <label class="sw flat"><input type="checkbox" ${k.enabled !== false ? 'checked' : ''} data-a="sched.set" data-p="${i}|enabled"><span class="track"></span><span class="txt">启用</span></label>
        <button class="btn btn-xs btn-danger" data-a="row.del" data-p="${esc(x.path)}|${i}">×</button>
      </div>`).join('') : '<div class="empty">还没有定时消息。加了之后到点会自动在那个群发一句。</div>'}</div>
      <div class="btn-row"><button class="btn btn-ghost btn-sm" data-a="row.add" data-p="${esc(x.path)}">加一条</button>
        <span class="hint">到点后 30 分钟内都还算数（被限流挡一下会自己重试），超窗才收尾成「错过」。填了「让模型现写」的条目：发主人私聊的不受睡眠与免打扰管（那是不往群里开口），发群里的照旧管。</span></div></div>`;
  },
  /**
   * 节假日表：**可以编辑了**（2026-10-02 修完数据链路之后）。
   *
   * ⚠️ 修之前这一格是禁用的只读表格，因为 `custom.holidays` 不在 `readCustom` 的
   *    白名单里 —— 填了会被下一次保存抹掉。现在它进了白名单，于是：
   *      表格 → 草稿里的 `holidays` 对象 → 底部「保存并生效」→ `patchCustom` → config.json
   *      → 机器人 `normalizeHolidays(cfg.custom.holidays)` → 判"这天算上班还是休息"。
   * ⚠️ 值只有两种（`holiday` / `makeup`），由 `src/holidays.js` 的闭集合定 ——
   *    这里照它渲染，不自己发明第三种。
   */
  holidays: (x) => {
    const raw = getPath(S.draft.custom, 'holidays');
    const table = (raw !== undefined ? raw : ((S.state || DEMO).custom?.holidays)) || {};
    const keys = Object.keys(table).sort();
    const dirtyH = Object.keys(S.dirty).some((k) => k.startsWith('c:holidays'));
    return `<div class="f">
      ${keys.length
        ? `<div class="rows">${keys.map((k) => `<div class="row flat f-inline">
            <input type="date" style="width:160px;" value="${esc(k)}" data-a="holidays.ren" data-p="${esc(k)}" />
            <select style="width:130px;" data-a="holidays.kind" data-p="${esc(k)}">
              <option value="holiday" ${table[k] === 'holiday' ? 'selected' : ''}>法定假日（休）</option>
              <option value="makeup" ${table[k] === 'makeup' ? 'selected' : ''}>调休补班（上）</option>
            </select>
            <span class="spacer"></span>
            <button class="btn btn-xs btn-danger" data-a="holidays.del" data-p="${esc(k)}">删</button>
          </div>`).join('')}</div>`
        : '<div class="empty">表是空的 —— 机器人会按星期几兜底判工作日 / 休息日。</div>'}
      <div class="f-inline">
        <input type="date" id="holiDate" style="width:160px;" />
        <select id="holiKind" style="width:130px;">
          <option value="holiday">法定假日（休）</option>
          <option value="makeup">调休补班（上）</option>
        </select>
        <button class="btn btn-ghost" data-a="holidays.add">添加</button>
        <span class="hint">改完点底部「保存并生效」${dirtyH ? ' · <b>有改动待保存</b>' : ''}</span>
      </div>
      <div class="hint">生效范围：定时消息里选了「只工作日 / 只休息日」的那些条目。判定顺序是
        <b>先查这张表、再按星期几兜底</b> —— 所以调休与法定假不会被星期几判反。</div>
    </div>`;
  },
  pluginSettings: (x) => {
    const s = S.state || DEMO;
    const it = (s.extensions?.items || []).find((e) => e.id === x.extId);
    if (!it) return `<div class="empty">没扫到插件 <code>${esc(x.extId)}</code>（它可能没装、或目录名不对）。</div>`;
    const spec = Array.isArray(it.settingsSpec) ? it.settingsSpec : [];
    if (!spec.length) return `<div class="empty">这个包没有声明设置项。</div>`;
    return `<div class="f">
      <div class="f-inline"><span class="tag ${it.action === 'load' ? 'ok' : 'warn'}">${esc(it.detail || '')}</span>
        <span class="hint">共 ${spec.length} 项 · 控件类型由后端 <code>settingsSpec</code> 下发（面板不自己判 typeof）</span></div>
      ${spec.map((f) => pluginSettingHtml(x.extId, f)).join('')}
      <div class="hint">改完点底部「保存并生效」。越界键会被拒绝并说出来 —— 不会静默丢弃。</div>
    </div>`;
  },
  /**
   * 插件总览（计数 + 运行期状态 + 热插拔说明）。
   *
   * ⚠️ 为什么从清单里**拆出来**成独立一张卡：它是"扫了几个 / 机器人加载了几个"这一层
   *   全局信息，与任何一个具体插件无关。混在某个插件的板里，读者会以为那几个数字
   *   只跟这一个插件有关 —— 而它其实是整批的。
   */
  pluginSummary: () => {
    const s = S.state || DEMO;
    const ext = s.extensions;
    if (!ext || !ext.ok) return '<div class="empty">读不到插件目录。</div>';
    const kind = 'plugin';
    const items = (ext.items || []).filter((it) => (it.kind === 'skill' ? 'skill' : 'plugin') === kind);
    const sum = {
      total: items.length,
      load: items.filter((x) => x.action === 'load').length,
      skip: items.filter((x) => x.action === 'skip').length,
      reject: items.filter((x) => x.action === 'reject').length,
    };
    const rt = j(s, ['effective', 'extensions'], null);
    const rtItems = (rt?.items || []).filter((it) => (it.kind === 'skill' ? 'skill' : 'plugin') === kind);
    const rtSum = {
      loaded: rtItems.filter((x) => x.state === 'loaded').length,
      pending: rtItems.filter((x) => x.state === 'pending').length,
      failed: rtItems.filter((x) => x.state === 'failed').length,
      over: rtItems.filter((x) => x.state === 'over').length,
      empty: rtItems.filter((x) => x.state === 'loaded' && x.empty).length,
    };
    const enabled = draftArr('extensions.plugins.enabled').length;
    const maxPlugins = Number(s.custom?.extensions?.max) || 256;
    const toolMax = Number(s.custom?.tools?.max) || 64;
    const overStatic = items.filter((x) => x.action === 'over').length;
    const overRun = rtSum.over;
    return `<div class="f">
      <div class="hint">扫到 ${sum.total} 个插件：可加载 ${sum.load} · 未启用 ${sum.skip} · 有问题 ${sum.reject} · <b>超过上限 ${overStatic}</b>（上限 ${maxPlugins}）。
        ${rt ? `机器人侧：已加载 ${rtSum.loaded} · 未启用 ${rtSum.pending} · 失败 ${rtSum.failed} · 超上限 ${overRun} · 空载 ${rtSum.empty}。` : '机器人没在跑，看不到运行期状态。'}</div>
      <div class="hint">已启用 <b>${enabled}</b> / 上限 <b>${maxPlugins}</b>${overStatic ? `（超出 ${overStatic} 个不会加载；取消勾选别的包或调大上限即可）` : ''} ·
        工具 <b>${rt?.limits?.toolsUsed ?? '?'}</b> / 上限 <b>${rt?.limits?.tools ?? toolMax}</b>（工具 schema 会进每一轮请求，别调太大）。</div>
      <div class="hint"><b>不支持热插拔</b>：改完白名单要重启机器人（那正是插件板上出现「待重启」的原因）。装完 ZIP 也不会自动启用。</div>
    </div>`;
  },
  skillSummary: () => {
    const s = S.state || DEMO;
    const ext = s.extensions;
    if (!ext || !ext.ok) return '<div class="empty">读不到 Skill 目录。</div>';
    const kind = 'skill';
    const items = (ext.items || []).filter((it) => (it.kind === 'skill' ? 'skill' : 'plugin') === kind);
    const rt = j(s, ['effective', 'extensions'], null);
    const rtItems = (rt?.items || []).filter((it) => (it.kind === 'skill' ? 'skill' : 'plugin') === kind);
    const enabled = draftArr('extensions.skills.enabled').length;
    const maxPlugins = Number(s.custom?.extensions?.max) || 256;
    const promptMax = Number(s.extensionPrompt?.skill?.maxChars) || 2000;
    const promptUsed = Number(s.extensionPrompt?.skill?.used) || 0;
    const promptOnly = rtItems.filter((x) => x.promptOnly).length;
    const mixed = rtItems.filter((x) => x.mixed).length;
    const overStatic = items.filter((x) => x.action === 'over').length;
    return `<div class="f">
      <div class="hint">扫到 ${items.length} 个 Skill：可加载 ${items.filter((x) => x.action === 'load').length} · 未启用 ${items.filter((x) => x.action === 'skip').length} · 有问题 ${items.filter((x) => x.action === 'reject').length} · <b>超过上限 ${overStatic}</b>（扩展总数上限 ${maxPlugins}）。
        ${rt ? `机器人侧：已加载 ${rtItems.filter((x) => x.state === 'loaded').length} · 失败 ${rtItems.filter((x) => x.state === 'failed').length} · 纯提示词 ${promptOnly} · 混合型 ${mixed}。` : '机器人没在跑，看不到运行期状态。'}</div>
      <div class="hint">已启用 <b>${enabled}</b> / 扩展总数上限 <b>${maxPlugins}</b> · 提示词预算 <b>${promptUsed}</b> / <b>${promptMax}</b> 字${s.extensionPrompt?.source === 'static' ? '（静态预览：启用后才会注入）' : ''}。</div>
      <div class="hint"><b>Skill 不保证执行</b>：模型可能一直不调用它。需要“条件满足必跑”的功能请做插件。<b>不支持热插拔</b>：勾选后要重启机器人；装完 ZIP 也不会自动启用。</div>
    </div>`;
  },
  skillPromptPreview: () => {
    const s = S.state || DEMO;
    const plan = s.extensionPrompt;
    if (!plan) return '<div class="empty">还没有 Skill 预览数据。</div>';
    const skill = plan.skill || {};
    const lines = Array.isArray(skill.lines) ? skill.lines : [];
    const pluginLines = Array.isArray(plan.plugin?.lines) ? plan.plugin.lines : [];
    const source = plan.source === 'runtime'
      ? '<span class="tag ok">此刻注入</span>'
      : '<span class="tag warn">机器人未运行：启用后将注入</span>';
    return `<div class="f">
      <div class="hint">${source} · Skill 段 <b>${skill.used || 0}</b> / <b>${skill.maxChars || 2000}</b> 字 · 丢弃段 ${skill.dropped || 0}</div>
      <pre class="mono" style="white-space:pre-wrap;font-size:11.5px;max-height:320px;overflow:auto;">${esc(lines.join('\n') || '（当前没有 Skill 提示词段）')}</pre>
      ${pluginLines.length ? `<details class="det"><summary>插件兼容指引（extensions 段，${plan.plugin.used || 0} 字）</summary><pre class="mono" style="white-space:pre-wrap;font-size:11.5px;max-height:220px;overflow:auto;">${esc(pluginLines.join('\n'))}</pre></details>` : ''}
      <div class="hint">预览只展示扩展注入段，不含核心系统提示；工具名来自真实注册表（robot 未运行时静态预览不伪造工具名）。</div>
    </div>`;
  },
  /**
   *
   * ── 为什么这么排 ────────────────────────────────────────────────────────
   *   旧形态是「一张大卡 → 一个 `.rows` 列表 → N 行」。三个问题：
   *     ① 视觉上所有插件是**一个**对象，开关与设置混在一列长列表里；
   *     ② 设置项多的插件会把整列撑得很长，下面那些插件要滚很久才看到；
   *     ③ 玻璃只有一层 —— "每块板都是玻璃"这件事根本没发生。
   *   现在：`.pgrid` 网格（`auto-fill minmax(340px,1fr)`）→ 每插件一张 `.pcard`。
   *   **玻璃材质不新造**：`.pcard` 同时挂 `card` 类，材质走现役那一档
   *   （`:where(body.eg-on) .card`，见 style.css）—— 圆角 / 模糊 / 阴影 / 透明度
   *   与全站其它卡片逐项同源，**视觉一致性由此保证，而不是靠"再写一份像的"**。
   *
   * ── 保持不变的部分（一条都不许少）─────────────────────────────────────────
   *   启用开关（`plugin.toggle`）、运行期徽标（loaded/failed/待重启）、设置项
   *   （`plugin.set`，>3 项仍默认收起）、`自带联网` 标记、problems 详情、版本号、
   *   有问题的插件**开关禁用**且不能被勾上。
   *
   * ⚠️ 板内不用 `.row`（那套是给"卡内列表行"设计的，横排 + hover 底色）；
   *   这里用 `.pcard-h` / `.pcard-b` 两个新类，**只管排版**，
   *   玻璃与圆角一律继承 `.card` —— 见 style.css 的「插件板」一节。
   */
  pluginList: () => {
    const s = S.state || DEMO;
    const ext = s.extensions;
    if (!ext || !ext.ok) return '<div class="empty">读不到插件目录。</div>';
    const on = new Set(draftArr('extensions.plugins.enabled'));
    const rt = j(s, ['effective', 'extensions'], null);
    const rtById = {}; if (rt?.items) for (const r of rt.items) rtById[r.id] = r;
    const items = (ext.items || []).filter((it) => (it.kind === 'skill' ? 'skill' : 'plugin') === 'plugin');
    if (!items.length) return '<div class="empty">还没有装插件。</div>';
    return `<div class="pgrid">${items.map((it) => {
      const bad = it.action === 'reject';
      const over = it.action === 'over';
      const checked = on.has(it.id) && !bad;
      const run = rtById[it.id];
      const hookCount = (run?.hooks || []).reduce((n, [, c]) => n + Number(c || 0), 0);
      const toolCount = (run?.tools || []).length;
      const hookErr = (run?.hookErrors || []);
      const toolErr = (run?.toolErrors || []);
      // 运行期徽标：over 也要显示（它不是 rejects，开关仍可勾选）。
      const badge = !rt ? ''
        : over ? '<span class="tag warn">超上限·未加载</span>'
          : (!checked ? '' : run ? `<span class="tag ${run.state === 'failed' ? 'bad' : 'ok'}">${esc(run.state || '')}</span>` : '<span class="tag warn">待重启</span>');
      return `<section class="card pcard" data-plugin="${esc(it.id)}">
        <div class="pcard-h">
          <label class="sw flat" title="${bad ? '这个插件有问题，勾了也不会加载' : '勾上才启用'}">
            <input type="checkbox" ${checked ? 'checked' : ''} ${bad ? 'disabled' : ''} data-a="plugin.toggle" data-k="plugin" data-p="${esc(it.id)}"><span class="track"></span><span class="txt"></span></label>
          <span class="nm">${esc(it.name)}</span>
          <span class="spacer"></span>
          <span class="hint mono">v${esc(it.version || '?')}</span>
        </div>
        <div class="pcard-b">
          <div class="f-inline">
            <span class="tag plain mono">${esc(it.id)}</span>
            <span class="tag ${it.kind === 'plugin' ? 'info' : 'plain'}">${it.kind === 'plugin' ? '插件' : 'Skill'}</span>
            ${badge}
            ${it.netSelf ? '<span class="tag warn" title="这个插件自带联网：它用自己的 fetch，不受浏览锁定约束">自带联网</span>' : ''}
            ${bad ? '<span class="tag bad">有问题</span>' : ''}
            ${run ? `<span class="tag ${hookCount ? 'ok' : 'warn'}" title="运行期实际挂上的钩子数">钩子 ${hookCount}</span>` : ''}
            ${run ? `<span class="tag ${toolCount ? 'ok' : 'warn'}" title="运行期实际注册的工具数">工具 ${toolCount}</span>` : ''}
            ${run?.empty ? '<span class="tag bad" title="既没挂上钩子、也没注册工具 —— 装了等于没装（先看下面的告警）">空载</span>' : ''}
            ${hookErr.length ? `<span class="tag bad" title="${esc(hookErr.map((e) => `${e.point}: ${e.reason}`).join('\n'))}">钩子未挂 ${hookErr.length}</span>` : ''}
            ${toolErr.length ? `<span class="tag bad" title="${esc(toolErr.map((e) => `${e.id || e.name || '?'}: ${e.reason}`).join('\n'))}">工具未注册 ${toolErr.length}</span>` : ''}
          </div>
          <div class="hint">${esc(it.detail || '')}</div>
          ${(it.problems || []).length ? `<div class="hint bad">${esc(it.problems.join('；'))}</div>` : ''}
          ${pluginSettingsRow(it, 'plugin')}
        </div>
      </section>`;
    }).join('')}</div>`;
  },
  skillList: () => {
    const s = S.state || DEMO;
    const ext = s.extensions;
    if (!ext || !ext.ok) return '<div class="empty">读不到 Skill 目录。</div>';
    const on = new Set(draftArr('extensions.skills.enabled'));
    const rt = j(s, ['effective', 'extensions'], null);
    const rtById = {}; if (rt?.items) for (const r of rt.items) rtById[r.id] = r;
    const items = (ext.items || []).filter((it) => (it.kind === 'skill' ? 'skill' : 'plugin') === 'skill');
    if (!items.length) return '<div class="empty">还没有装 Skill。纯提示词 Skill 也需要 skill.json + index.js（可写 export {}）。</div>';
    return `<div class="pgrid">${items.map((it) => {
      const bad = it.action === 'reject';
      const over = it.action === 'over';
      const checked = on.has(it.id) && !bad;
      const run = rtById[it.id];
      const hookCount = (run?.hooks || []).reduce((n, [, c]) => n + Number(c || 0), 0);
      const toolCount = (run?.tools || []).length;
      const promptCount = (run?.promptSections || it.promptSections || []).length;
      const hookErr = (run?.hookErrors || []);
      const toolErr = (run?.toolErrors || []);
      const badge = !rt ? ''
        : over ? '<span class="tag warn">超上限·未加载</span>'
          : (!checked ? '' : run ? `<span class="tag ${run.state === 'failed' ? 'bad' : 'ok'}">${esc(run.state || '')}</span>` : '<span class="tag warn">待重启</span>');
      return `<section class="card pcard" data-plugin="${esc(it.id)}">
        <div class="pcard-h">
          <label class="sw flat" title="${bad ? '这个 Skill 有问题，勾了也不会加载' : '勾上才启用'}">
            <input type="checkbox" ${checked ? 'checked' : ''} ${bad ? 'disabled' : ''} data-a="plugin.toggle" data-k="skill" data-p="${esc(it.id)}"><span class="track"></span><span class="txt"></span></label>
          <span class="nm">${esc(it.name)}</span>
          <span class="spacer"></span>
          <span class="hint mono">v${esc(it.version || '?')}</span>
        </div>
        <div class="pcard-b">
          <div class="f-inline">
            <span class="tag plain mono">${esc(it.id)}</span>
            <span class="tag info">Skill</span>
            ${badge}
            ${run?.promptOnly ? '<span class="tag ok">提示词型</span>' : ''}
            ${run?.mixed ? '<span class="tag warn" title="Skill 同时导出了 hooks；建议迁移到插件">混合型（不推荐）</span>' : ''}
            ${bad ? '<span class="tag bad">有问题</span>' : ''}
            ${run ? `<span class="tag ${hookCount ? 'ok' : 'warn'}" title="运行期实际挂上的钩子数">钩子 ${hookCount}</span>` : ''}
            ${run ? `<span class="tag ${toolCount ? 'ok' : 'warn'}" title="运行期实际注册的工具数">工具 ${toolCount}</span>` : ''}
            <span class="tag ${promptCount ? 'ok' : 'warn'}" title="清单 prompt.sections 段数">提示词 ${promptCount}</span>
            ${run?.empty ? '<span class="tag bad" title="既没挂钩子、也没注册工具、也没有提示词 —— 装了等于没装">空载</span>' : ''}
            ${hookErr.length ? `<span class="tag bad" title="${esc(hookErr.map((e) => `${e.point}: ${e.reason}`).join('\n'))}">钩子未挂 ${hookErr.length}</span>` : ''}
            ${toolErr.length ? `<span class="tag bad" title="${esc(toolErr.map((e) => `${e.id || e.name || '?'}: ${e.reason}`).join('\n'))}">工具未注册 ${toolErr.length}</span>` : ''}
          </div>
          <div class="hint">${esc(it.detail || '')}</div>
          ${(it.problems || []).length ? `<div class="hint bad">${esc(it.problems.join('；'))}</div>` : ''}
          ${pluginSettingsRow(it, 'skill')}
        </div>
      </section>`;
    }).join('')}</div>`;
  },
  skillScope: () => `<div class="f">
      <div class="scroll-y"><table class="tbl">
        <colgroup><col style="width:32%"><col></colgroup>
        <thead><tr><th>类型</th><th>谁决定 / 怎么生效</th></tr></thead>
        <tbody>
          <tr><td class="mono">Skill（skills/）</td><td>注册工具 + prompt.sections；<b>模型判断</b>是否调用，可能一直不用。</td></tr>
          <tr><td class="mono">插件（plugins/）</td><td>导出 hooks；<b>核心</b>在固定时机调用，条件满足必跑。</td></tr>
          <tr><td class="mono">知识包 / 角色卡</td><td><code>custom.skills</code> 里的提示词数据，不是代码扩展，不注册工具。</td></tr>
        </tbody>
      </table></div>
      <div class="hint">Skill 与插件共用同一套加载器、工具表、开关与生命周期；目录只是语义标签。Skill 带 hooks 会被标成“混合型”，但不会静默丢弃。</div>
    </div>`,
  pluginScope: () => `<div class="f">
      <div class="scroll-y"><table class="tbl">
        <colgroup><col style="width:34%"><col></colgroup>
        <thead><tr><th>它想做的事</th><th>结果</th></tr></thead>
        <tbody>
          <tr><td class="mono">send_msg / send_*</td><td><span class="tag bad">一律拒绝</span> 并告警 —— 发言只能走宿主给的 ctx.sender，插件不许自己往外发</td></tr>
          <tr><td>只读动作（15 个白名单）</td><td><span class="tag ok">放行</span> 例如取群信息、取历史消息</td></tr>
          <tr><td>其余任何动作</td><td><span class="tag bad">拒绝</span> 默认关，不是默认开</td></tr>
        </tbody></table></div>
      <div class="hint">这套边界在 <code>src/ext-scope.js</code> 里是<b>闭集合</b>：要加新动作必须去改那一处并补契约，不能在这里加一行 if。</div>
    </div>`,
  /* `faces` 渲染器已于 2026-10-17 删除：收藏表情随「发 QQ 表情」能力一起下线。 */
  /**
   * 群友档案：**真数据**（2026-10-02 起）。
   * 数据源 `data/memory/people/*.json`（插件 群友印象 在写），
   * 由 `panel/lib/bot-data.js` 投影：一档一文件，坏文件只跳过它自己。
   * ⚠️ 那一栏显示的是**真实 QQ 号**（这一页是靠它认人的，脱敏之后就没法用了）。
   *    页面与面板都只在本机；别把它截图发出去。
   */
  people: (x) => {
    const p = (S.state || DEMO).people;
    if (!p) return '<div class="empty">这一版的面板还没下发群友档案（需要重启面板加载新代码）。</div>';
    if (!p.ok) {
      return `<div class="f">
        <div class="hint">${esc(p.reason || '读不到档案')}</div>
        <div class="hint">档案由插件 <b>群友印象</b> 写在 <code>data/memory/people/&lt;QQ&gt;.json</code>：在「插件 → 插件」里勾上它并重启机器人，它聊过之后这里就会长出条目。</div>
        <div class="hint">相关能力：<code>群友印象</code>（记印象与好感度）· <code>自我印象</code>（把自己总结成低权重背景板）·
          <code>记忆管理</code>（列 / 搜 / 合并归档）· <code>百科查询</code>（外部百科，不进本地梗库）。</div>
      </div>`;
    }
    if (!p.count) {
      return `<div class="f"><div class="empty">还没有任何人的档案 —— 那个技能还没被用到过。</div>
        <div class="hint">它会在聊过之后自己记（模型决定记什么），不需要你手填。</div></div>`;
    }
    const fav = (v) => (typeof v === 'number'
      ? `<span class="tag ${v >= 70 ? 'ok' : v <= 30 ? 'bad' : 'plain'}">好感 ${v}</span>` : '');
    return `<div class="f">
      <div class="f-inline"><span class="tag accent">共 ${p.count} 人</span>
        ${p.broken ? `<span class="tag warn" title="这些文件读不出 JSON —— 只跳过它们自己，不让整张列表变空">${p.broken} 个文件坏</span>` : ''}
        <span class="spacer"></span><span class="hint">按最近更新排序</span></div>
      ${capRows(p.items, 'mem.people', (it) => `
        <div class="row">
          <div class="row-h">
            <span class="mono">${esc(it.userId)}</span>
            ${it.nickname ? `<span class="nm">${esc(it.nickname)}</span>` : ''}
            ${fav(it.favor)}
            <span class="tag plain">印象 ${it.impressionCount}</span>
            <span class="spacer"></span>
            <span class="hint">${it.updatedAt ? new Date(it.updatedAt).toLocaleString() : ''}</span>
          </div>
          ${it.attitude ? `<div class="hint">态度：${esc(it.attitude)}</div>` : ''}
          ${it.impressions.length ? `<div><div class="chip-list">${it.impressions.map((m) => `<span class="chip">${esc(m.content)}</span>`).join('')}</div>
            <div class="hint">只带最近 3 条 —— 全文检索是那个技能自己的工具（记忆管理）的事。</div></div>`
            : '<span class="hint">还没有文字印象，只有一个好感度。</span>'}
        </div>`)}
    </div>`;
  },

  /** 自定义图库：**只报张数**（那个包的条目字段名我们没样本可核，不猜 —— 见 bot-data.js ③）。 */
  gallery: (x) => {
    const g = (S.state || DEMO).gallery;
    if (!g) return '';
    if (!g.ok) return `<div class="hint">图库：${esc(g.reason || '读不到')}（那个技能没被用到过时是正常的）</div>`;
    return `<div class="metric"><div class="n">${g.count}</div><div class="l">图库里可发送的图</div></div>`;
  },

  /** 免费额度情报：**真数据**（旧控制台里这一页是骨架）。 */
  apiDeals: (x) => {
    const d = (S.state || DEMO).apiDeals;
    if (!d) return '<div class="empty">这一版的面板还没下发额度情报（需要重启面板加载新代码）。</div>';
    if (!d.ok) {
      return `<div class="f"><div class="hint">${esc(d.reason || '读不到')}</div>
        <div class="hint">数据由插件 <b>AI免费额度情报</b>（api-deals）定时抓取后落在 <code>data/api-deals.json</code>：
          在「插件 → 插件」里勾上它，凌晨会自动刷新。</div></div>`;
    }
    return `<div class="f">
      <div class="f-inline">
        <span class="tag accent">共 ${d.count} 条</span>
        <span class="hint">最近抓取：${d.lastRefresh ? new Date(d.lastRefresh).toLocaleString() : '—'}</span>
        ${d.lastError ? `<span class="tag warn" title="部分源抓失败不影响已有条目">有一路抓失败：${esc(d.lastError)}</span>` : ''}
      </div>
      ${d.items.length ? capRows(d.items, 'deals', (it) => `
        <div class="row flat f-inline">
          <span class="tag ${it.free ? 'ok' : 'plain'}">${it.free ? '免费' : esc(it.source || '')}</span>
          <span class="grow">${esc(it.title)}</span>
          ${it.brand ? `<span class="hint">${esc(it.brand)}</span>` : ''}
          ${it.amount ? `<span class="hint">${esc(it.amount)}</span>` : ''}
          ${it.deadline ? `<span class="tag warn">截止 ${esc(it.deadline)}</span>` : ''}
          ${it.url ? `<a class="jump" href="${esc(safeHref(it.url))}" target="_blank" rel="noopener">原文</a>` : ''}
        </div>`)
        : '<div class="empty">抓到的列表是空的。</div>'}
      <div class="hint">这一页<b>只读</b>：刷新由那个插件自己做（凌晨自动），面板不触发网络请求 —— 否则打开一次页面就替你去抓一次。</div>
    </div>`;
  },
  unread: (x) => {
    const s = S.state || DEMO;
    const tr = (s.trace || []).filter((r) => r.unread);
    const last = tr[tr.length - 1]?.unread;
    const drop = tr.reduce((n, r) => n + (r.unread?.dropped || 0), 0);
    return `<div class="f">
      ${last ? `<div class="metrics">
        <div class="metric"><div class="n">${esc(String(last.left ?? 0))}</div><div class="l">当前还压着的未读</div></div>
        <div class="metric"><div class="n">${esc(String(last.consumed ?? 0))}</div><div class="l">这一轮消费掉几条</div></div>
        <div class="metric ${drop ? 'hi' : ''}"><div class="n">${drop}</div><div class="l">有界丢弃（超过 200 条的经验上限）</div></div>
      </div>` : `<div class="empty">还没有带未读计数的记录。${S.online ? '（未读是内存态、不落盘，重启即空 —— 机器人跑起来后每条回复的记录里都会带一格。）' : ''}</div>`}
      <div class="hint">未读模型（D30）刻意<b>不做</b>「全部标记已读」：按 id 逐条消费，消费发生在 <code>decide()</code> 之后 ——
        所以"它看过但决定不回"的消息也会被吃掉，不会永远堆在那里重复打扰它。</div>
    </div>`;
  },
  sesList: (x) => {
    const d = S.extra.sessions;
    if (!d) return `<div class="f"><div class="empty">正在读取…</div><div class="btn-row"><button class="btn btn-ghost btn-sm" data-a="sessions.load">刷新</button></div></div>`;
    return `<div class="f">
      <div class="f-inline"><span class="hint">窗口 ${esc(d.window || '?')} 条 · 共 ${(d.items || []).length} 个会话</span>
        <span class="spacer"></span><button class="btn btn-ghost btn-sm" data-a="sessions.load">刷新</button></div>
      <div class="scroll-y"><div class="rows" style="padding:6px;">${(d.items || []).length ? d.items.map((it) => `
        <div class="row flat f-inline" style="cursor:pointer;" data-a="sessions.open" data-p="${esc(it.key)}">
          <span class="tag ${String(it.key).startsWith('group') ? 'info' : 'plain'}">${String(it.key).startsWith('group') ? '群' : '私聊'}</span>
          <span class="grow mono">${esc(it.key)}</span>
          <span class="hint">${esc(it.lastText || '')}</span>
          <span class="hint">${it.lastAt ? new Date(it.lastAt).toLocaleTimeString() : ''}</span>
        </div>`).join('') : '<div class="empty">还没有会话记录。机器人跑起来之后这里会自己长出来。</div>'}</div></div>
    </div>`;
  },
  sesDetail: () => {
    const d = S.extra.sesDetail;
    if (!d) return `<div class="f"><div class="f-lb">这一轮在聊什么</div><div class="empty">← 选一个会话，看它最近几轮的经过</div></div>`;
    return `<div class="f"><div class="f-lb">${esc(d.key)}</div>
      <div class="scroll-y"><div class="rows" style="padding:6px;">${(d.items || []).map((r) => `
        <div class="row"><div class="row-h"><span class="tag ${r.kind === 'judge' ? 'warn' : 'ok'}">${r.kind === 'judge' ? '判定卡' : esc(r.stage || '')}</span>
          <span class="spacer"></span><span class="hint">${r.t ? new Date(r.t).toLocaleTimeString() : ''}</span></div>
          <div>${esc(r.text || '')}</div></div>`).join('')}</div></div></div>`;
  },
  chatList: (x) => {
    const d = S.extra.chats;
    if (!d) return `<div class="f"><div class="empty">正在读取…</div><div class="btn-row"><button class="btn btn-ghost btn-sm" data-a="chats.load">刷新</button></div></div>`;
    return `<div class="f">
      <div class="f-inline"><span class="hint">共 ${(d.items || []).length} 个会话的存档</span><span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" data-a="chats.load">刷新</button></div>
      <div class="scroll-y"><div class="rows" style="padding:6px;">${(d.items || []).length ? d.items.map((it) => `
        <div class="row flat f-inline" style="cursor:pointer;" data-a="chats.open" data-p="${esc(it.key)}">
          <span class="grow mono">${esc(it.key)}</span><span class="hint">${esc(String(it.count ?? it.messages?.length ?? ''))} 条</span>
          <span class="hint">${it.at ? new Date(it.at).toLocaleString() : ''}</span></div>`).join('')
        : '<div class="empty">存档只在机器人退出 / 定时归档时写入，刚启动时会是空的。</div>'}</div></div>
    </div>`;
  },
  chatDetail: () => {
    const d = S.extra.chatDetail;
    if (!d) return `<div class="f"><div class="f-lb">← 选一个会话看存档</div><div class="empty">存档里是群聊原文 —— 渲染时全部转义，不会被当成标签执行。</div></div>`;
    return `<div class="f"><div class="f-lb">${esc(d.key)}</div>
      <div class="scroll-y"><div class="rows" style="padding:6px;">${(d.detail?.messages || []).map((m) => `
        <div class="row"><div class="row-h"><span class="tag plain">${esc(m.role || m.name || '')}</span><span class="spacer"></span>
          <span class="hint">${m.t ? new Date(m.t).toLocaleTimeString() : ''}</span></div><div>${esc(m.text || m.content || '')}</div></div>`).join('')}</div></div></div>`;
  },
  traceList: (x) => {
    const s = S.state || DEMO, rs = (s.trace || []).slice().reverse();
    if (!rs.length) return '<div class="empty">还没有记录。跑一次「试一句」或等群里来消息。</div>';
    return `<div class="rows">${rs.map((r, i) => `
      <div class="row">
        <div class="row-h">
          <span class="tag ${r.kind === 'judge' ? 'warn' : 'ok'}">${esc(r.kind === 'judge' ? '判定' : (r.stage || 'reply'))}</span>
          <span class="mono hint">${esc(r.traceId || '')}</span>
          <span class="spacer"></span>
          <span class="hint">${esc(r.model || '')} · ${r.ms || 0} ms · ${r.messageCount || 0} 条上下文</span>
        </div>
        <div><b>群里说了什么：</b>${esc(r.text || '')}</div>
        ${r.reason ? `<div class="hint">为什么没回：${esc(r.reason)}</div>` : ''}
        ${(r.chunks || []).length ? `<div><b>实际发出去的分段：</b>${r.chunks.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : ''}
        ${r.prompt ? `<details class="det"><summary>发给模型的完整提示词（${(r.prompt || '').length} 字符）</summary><pre class="mono" style="white-space:pre-wrap;font-size:11px;max-height:280px;overflow:auto;">${esc(r.prompt)}</pre></details>` : ''}
      </div>`).join('')}</div>`;
  },
  logList: (x) => {
    const lines = S.extra.logs?.lines || [];
    return `<div class="f">
      <div class="f-inline"><span class="hint">环形缓冲封顶 600 行；这里是增量拉取</span><span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" data-a="logs.load">刷新</button></div>
      <pre class="mono" style="max-height:320px;overflow:auto;font-size:11px;background:var(--c-sunken);padding:10px;border-radius:var(--r2);margin:0;">${lines.length ? esc(lines.join('\n')) : '（暂无日志）'}</pre>
    </div>`;
  },
  /* ══════════════ 网页内置终端（2026-10-11）═════════════════════════════════
     它取代的是那个"关不掉、删不掉"的前台 cmd 窗口：同一份运行日志，实时推到页面上。
     ⚠️ 内容用 `textContent` 写，**不走 innerHTML** —— 日志正文里有 NapCat 原始输出
        （含 ANSI 转义、路径、登录提示），当成 HTML 插进去既会串格式、也是个注入面。
     ⚠️ 它与页面那 3 秒一轮的 `innerHTML` 重建是**并存**的：重建后由 `mountTerm()`
        负责按 `TERM.lines`（模块级，不随重画丢失）重新填一次。 */
  termView: () => {
    if (TERM.quit) {
      return `<div class="term"><div class="term-h"><span class="hint">控制台已退出</span></div>
        <div class="term-body mono">控制台已经退出 —— 关掉这个标签页即可。
要再打开：双击桌面上的「Estrella Bot」图标。</div></div>`;
    }
    const st = TERM.st || {};
    const dot = (on, label) => `<span class="term-dot ${on ? 'on' : ''}" title="${esc(label)}"></span><span class="hint">${esc(label)}</span>`;
    return `<div class="term">
      <div class="term-h">
        ${dot(st.bridge, '机器人')}${dot(st.proto, '协议端')}${dot(true, '控制台')}
        <span class="spacer"></span>
        <span class="hint">${esc(TERM.src === 'napcat' ? '协议端日志（NapCat 自己写的那一份）' : '控制台日志（服务端实时推送）')}</span>
        <button class="btn btn-ghost btn-sm" data-a="term.src">${TERM.src === 'napcat' ? '看控制台日志' : '看协议端日志'}</button>
        <button class="btn btn-ghost btn-sm" data-a="term.clear">清屏</button>
      </div>
      <pre class="term-body mono" id="termBody"></pre>
    </div>`;
  },
  /* ── 假 QQ 会话（2026-10-21 · Win-v0.1.2 移植）────────────────────────── */
  fakeView: () => {
    const on = !!S.extra.fakeRunning;
    const opts = fakeOpts();
    const opt = (k, label, hint) => `<label class="sw flat" title="${esc(hint)}">
        <input type="checkbox" data-a="fake.opt" data-p="${k}" ${opts[k] ? 'checked' : ''} ${on ? 'disabled' : ''}>
        <span class="track"></span><span class="txt">${esc(label)}</span></label>`;
    const cmd = (label, p, hint = '') => `<button class="btn btn-ghost btn-sm" data-a="fake.cmd" data-p="${p}" ${on ? '' : 'disabled'} title="${esc(hint)}">${esc(label)}</button>`;
    return `<div class="f">
      <div class="f-inline">
        <span id="fakeBadge" class="tag ${on ? 'ok' : 'plain'}">${on ? `会话在跑${S.extra.fakePid ? ` · pid ${S.extra.fakePid}` : ''}` : '没在跑'}</span>
        <span class="spacer"></span>
        <button class="btn btn-primary btn-sm" data-a="fake.start" ${on ? 'disabled' : ''}>启动会话</button>
        <button class="btn btn-danger btn-sm" data-a="fake.stop" ${on ? '' : 'disabled'}>停止会话</button>
      </div>
      <div class="f-inline" style="gap:14px;flex-wrap:wrap;">
        ${opt('offline', '离线假模型', '不调真模型：固定回话、不花钱、断网可用')}
        ${opt('sandbox', '沙箱数据', '换成空的临时 data（不碰真实 data，真机器人可以在跑）')}
      </div>
      <div class="f-inline" style="gap:6px;flex-wrap:wrap;">
        ${cmd('切私聊', 'private', '下一句走私聊（管理员路径）')}
        ${cmd('切回群', 'group')}
        ${cmd('开关 @', 'at', '关掉 = 没被点名的群消息，用来看巡逻 / 插话逻辑')}
        ${cmd('看程序日志', 'log', '相当于 /log：打最后 20 行程序日志')}
      </div>
      <pre class="term-body mono" id="fakeBody"></pre>
    </div>`;
  },
  /* 巡逻与热度的现状（只读）。数据来自机器人每 30 秒写的
     `data/patrol-state.json`（面板读盘，不经机器人转发 —— 机器人没跑也能看上一次的样子）。 */
  patrolView: () => {
    const d = (S.state || DEMO).patrol;
    if (!d) return '<div class="empty">这一版的面板还没下发巡逻快照（需要重启面板加载新代码）。</div>';
    if (!d.ok) {
      return `<div class="f"><div class="hint">${esc(d.reason || '还没写过快照')}</div>
        <div class="hint">机器人启动后每 30 秒会写一次 <code>data/patrol-state.json</code>；
          没跑过就是空表 —— 这不是故障。</div></div>`;
    }
    const rows = Array.isArray(d.rows) ? d.rows : [];
    if (!rows.length) return '<div class="f"><div class="empty">还没有受管的群会话（先让机器人在群里收到一条消息）。</div></div>';
    const t = d.tuned || {};
    const bar = (pct) => `<span class="track" style="display:inline-block;width:64px;height:6px;border-radius:3px;background:var(--c-line);vertical-align:middle;overflow:hidden;"><span style="display:block;height:100%;width:${Math.max(2, Math.min(100, pct))}%;background:var(--c-accent);"></span></span>`;
    return `<div class="f">
      <div class="f-inline" style="flex-wrap:wrap;gap:8px;">
        <span class="tag ${t.enabled === false ? 'plain' : 'accent'}">巡逻${t.enabled === false ? '已关闭' : '开着'}</span>
        <span class="hint">门槛：积压 ≥ ${esc(String(t.minUnread ?? '—'))} · 安静 ≥ ${esc(String(t.silenceMin ?? '—'))} 分钟 · 间隔 ≥ ${esc(String(t.minGapMin ?? '—'))} 分钟 · 基础概率 ${Math.round((Number(t.chance) || 0) * 100)}%</span>
        <span class="spacer"></span>
        <span class="hint">${d.updatedAt ? `快照于 ${new Date(d.updatedAt).toLocaleTimeString()}` : ''}</span>
      </div>
      ${rows.map((r) => {
        const last = Number(r.lastPatrolAt) || 0;
        const ago = last ? `${Math.max(0, Math.round((Date.now() - last) / 60000))} 分钟前` : '还没巡逻过';
        return `<div class="row flat">
          <div class="f-inline" style="flex-wrap:wrap;gap:8px;">
            <span class="tag ${r.unread ? 'warn' : 'plain'}">群 ${esc(r.group)}</span>
            <span class="hint">压着 <b>${esc(String(r.unread))}</b> 条积压 · 安静 ${esc(String(r.silenceMin))} 分钟 · 上次巡逻 ${esc(ago)}</span>
            <span class="spacer"></span>
            <span class="hint">群活跃 ${bar(r.heat)} ${esc(String(r.heat))}%</span>
          </div>
          ${(r.people || []).length ? `<div class="f-inline" style="flex-wrap:wrap;gap:6px;padding-top:4px;">
            ${(r.people || []).map((u) => `<span class="chip" title="关系温度 ${u.pct}%（${esc(u.band || '')}）">${esc(u.qq)} <span class="hint">${esc(String(u.pct))}% ${esc(u.band || '')}</span></span>`).join('')}
          </div>` : '<div class="hint">还没有按人的热值（它跟谁聊过，这里就会出现）。</div>'}
        </div>`;
      }).join('')}
      <div class="hint">「群活跃」看最近 30 分钟的消息量；「关系温度」按人算 —— 连着找它聊天会掉温，安静下来慢慢回升。两者都只<b>压</b>主动开口的概率，不会让它越过「必须 @ / 拉黑 / 免打扰」这些硬闸。</div>
    </div>`;
  },
  auditList: (x) => {
    const d = S.extra.audit;
    if (!d) return `<div class="f"><div class="empty">正在读取…</div><div class="btn-row"><button class="btn btn-ghost btn-sm" data-a="audit.load">刷新</button></div></div>`;
    return `<div class="f">
      <div class="f-inline"><span class="hint">${esc(d.file || '')} · 最新在前</span><span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" data-a="audit.load">刷新</button></div>
      <div class="scroll-y"><table class="tbl">
        <colgroup><col style="width:132px"><col style="width:96px"><col></colgroup>
        <thead><tr><th>时间</th><th>动作</th><th>谁 / 细节</th></tr></thead>
        <tbody>${(d.lines || []).map((l) => `<tr><td class="mono">${esc(l.t ? new Date(l.t).toLocaleString() : '')}</td>
          <td>${esc(l.action || l.route || '')}</td><td class="mono">${esc(l.actor || '')} ${esc(l.ua || '')} ${esc(l.detail || '')}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="hint">审计<b>故意不进页面轮询</b>：它只在你打开这一页时拉一次。写路由与它同源（同一张 <code>WRITE_ROUTES</code> 表）。</div>
    </div>`;
  },
  tryOut: () => {
    const t = S.extra.tryOut;
    if (!t) return '';
    return `<div class="f">
      <div class="f-inline"><span class="tag ${t.error ? 'bad' : 'ok'}">${t.error ? '出错' : `成功 · ${t.ms || 0} ms`}</span></div>
      ${t.error ? `<div class="hint bad">${esc(t.error)}</div>` : ''}
      <div><b>最终分段：</b>${(t.chunks || []).map((c) => `<span class="chip">${esc(c)}</span>`).join('') || '<span class="hint">没有分段</span>'}</div>
      ${t.raw ? `<details class="det"><summary>模型原始输出</summary><pre class="mono" style="white-space:pre-wrap;font-size:11px;max-height:220px;overflow:auto;">${esc(t.raw)}</pre></details>` : ''}
      ${t.prompt ? `<details class="det"><summary>发给模型的完整提示词（${(t.prompt || '').length} 字符）</summary><pre class="mono" style="white-space:pre-wrap;font-size:11px;max-height:280px;overflow:auto;">${esc(t.prompt)}</pre></details>` : ''}
    </div>`;
  },
  importFile: () => `<div class="f"><input type="file" accept=".json" data-a="import.file" />
      <div class="hint">选一个之前下载的 JSON。导入前会先弹一份变更清单 —— 确认了才载入页面。</div></div>`,
  importZip: (x) => `<div class="f">${x.label ? lb(x) : ''}<div class="f-inline">
      <input type="file" accept=".zip,application/zip" data-a="zip.file" data-k="${esc(x.kind || 'plugin')}" class="grow" />
      <button class="btn btn-ghost" data-a="zip.pick" data-k="${esc(x.kind || 'plugin')}">选文件并安装</button></div>
      <div class="hint">顶层必须是一个目录。${x.kind === 'skill' ? 'Skill 页只接受含 <code>skill.json</code> 的包；纯提示词 Skill 仍需 <code>index.js</code>（写 <code>export {}</code>）。' : '插件页只接受含 <code>plugin.json</code> 的包。'}<b>装完默认不启用</b> —— 在列表里勾上它，然后重启机器人。</div></div>`,
  protoInfo: () => `<div class="f">
      <div class="kv"><dt>这是什么</dt><dd>控制台前端的<b>初步重构原型</b>：整页由 <code>panel/next/schema.js</code> 一份数据驱动。</dd></div>
      <div class="kv"><dt>怎么加减</dt><dd>加页面 / 卡片 / 控件只改 schema；加控件类型才要动 <code>app.js</code> 的 RENDER 表。</dd></div>
      <div class="kv"><dt>和旧页的关系</dt><dd>旧页面（<code>panel/parts/</code> 的 16 个片段 + 它的清单模块）已在 <b>S-12 收口</b>时<b>整块删除</b>：服务端不再有读它的分支，页面上也没有回旧界面的入口，连那份 403 条断言（<code>test/verify-panel.mjs</code>）都不在仓库里了。面板侧的真实验收现在是 <code>panel/next/verify.mjs</code>（沙箱里跑，真实浏览器）。「那套机制不许回到运行时」由契约 §66 钉着。</dd></div>
      <div class="kv"><dt>已知边界</dt><dd>定时消息的日期 / 频次存不住；其余以 <code>/api/state</code> 实际下发为准。</dd></div>
      <div class="hint">要看真实数据：照常启动控制台即可 —— 它读的就是本机真实的 <code>panel/</code> 与 <code>data/</code>，不是 mock。</div>
    </div>`,
  /* ── 人设域六页（2026-10-25）──────────────────────────────────────────
     整页渲染器。⚠️ 必须写在 RENDER **字面量里**（check-wb §69 只解析这里），
     不要用 Object.assign 追加。 */
  psnOverview: () => psnOverviewHtml(),
  psnProfile: () => psnProfileHtml(),
  psnMbti: () => psnMbtiHtml(),
  psnEnhance: () => psnEnhanceHtml(),
  psnMood: () => psnMoodHtml(),
  psnPrompt: () => psnPromptHtml(),
};

/* ══════════════════════════════════════════════════════════════════════════
   人设域六页（2026-10-25）
   ──────────────────────────────────────────────────────────────────────────
   这一域是**整页渲染**（schema 里用 `bare: true` 的裸容器），因为它是一组带
   图表的可视化页面，不是"卡片 + 控件"的平铺列表。但每个可写字段仍然：
     · 登记进 `S.reg`（`data-id` + `data-a="field"`）；
     · 走统一的 `setValue()` / 草稿 / 保存条。
   所以"看起来是手写 HTML"不等于"绕开了保存路径"。

   ⚠️ 三条数据纪律：
     ① 页面上的派生值（MBTI 类型 / 星座 / 提示词分段）**全部由后端算好下发**；
        前端只做排版与配色。前端自己推一份，就会出现"面板说注入了、模型没收到"。
     ② 情绪数据没有就是没有 —— 不补 `mood: 50` 这种默认值来把图画满。
     ③ 情绪是项目本体（`src/emotion.js`）写入的状态文件；提示词段的文字
        也由同一份实现生成，所以这里展示的就是模型会收到的那一段。
   ══════════════════════════════════════════════════════════════════════════ */

const PSN_TYPE_BASE = {
  INTJ: '#6f5288', INTP: '#98618f', ENTJ: '#624992', ENTP: '#8a4f74',
  INFJ: '#237653', INFP: '#3a9367', ENFJ: '#6d8a2c', ENFP: '#3f9a72',
  ISTJ: '#2f7a8f', ISFJ: '#3f8d92', ESTJ: '#356f9b', ESFJ: '#3f839e',
  ISTP: '#957023', ISFP: '#b08a35', ESTP: '#a97a28', ESFP: '#bf9335',
};
/* 16Personalities 官方场景图（2026-10-26 · 维护者授权随包分发）。
   路径是相对页面根的 `./assets/mbti/<type>.jpg`；服务端由 /assets/mbti 路由发送。
   `psnTypeScene` 仍保留为加载失败时的本地 SVG 回退。 */
const PSN_ART = Object.fromEntries(Object.keys(PSN_TYPE_BASE).map((code) => [code, `./assets/mbti/${code.toLowerCase()}.jpg`]));
const PSN_EDITABLE = ['base', 'persona', 'mbti', 'enhance', 'mood', 'rules', 'isolate', 'memory', 'astro'];
const PSN_ENH_SPAN = { lines: 6, meters: 6 };
const PSN_ENH_ROWS = { lines: 4, meters: 2 };

function psnState() { return S.state || DEMO; }
function psnCustom() { return psnState().custom || {}; }
function psnPersona() { return psnCustom().persona || {}; }
function psnEnhance() { return psnCustom().enhance || {}; }
function psnMeta() { return psnState().customMeta || {}; }
function psnPromptData() { return psnState().personaPrompt || { sections: [], total: 0, layerTotal: 0 }; }
function psnSections() { return psnPromptData().sections || []; }
function psnSection(id) { return psnSections().find((x) => x.id === id) || null; }
function psnName() { return j(psnState(), ['config', 'personaName'], '') || ''; }
function psnMbti() {
  return psnState().mbtiInfo || {
    type: 'INFJ', name: '提倡者', tag: '', traits: [], axes: { EI: 62, SN: 58, TF: 57, JP: 46 },
    summary: '', on: false, note: '',
  };
}
function psnBirth() {
  return psnState().birthdayInfo || { age: 0, month: 0, day: 0, year: null, animal: '', sign: null, on: false };
}
function psnEmotion() { return psnState().emotion || { ok: false, reason: '这一版的面板还没下发情绪' }; }
function psnVal(path, fallback) {
  const d = getPath(S.draft.custom, path);
  return d !== undefined ? d : (getPath(psnCustom(), path) ?? fallback);
}
function psnBool(path, fallback) {
  const v = psnVal(path, fallback);
  return v === true;
}
const psnChip = (html, cls = '') => `<span class="meta-chip ${cls}">${html}</span>`;
const psnFmt = (n) => Number(n || 0).toLocaleString('zh-CN');
const psnLen = (s) => String(s ?? '').length;
function psnPageHead(items) {
  const su = currentSub() || {};
  const layer = String(su.layer || '人设系统');
  const m = layer.match(/^([①②③④⑤])\s*(.*)$/);
  const badge = m && su.id !== 'overview' ? `<span class="layer-badge">${m[1]}</span>` : '';
  const layerName = m ? m[2] : layer;
  return `<div class="page-head">
    <div class="page-head-copy">
      <div class="eyebrow">${badge}人格 / ${esc(layerName)}</div>
      <h1>${esc(su.title || su.label || '')}</h1>
      ${su.desc ? `<p class="page-desc">${esc(su.desc)}</p>` : ''}
    </div>
    <div class="head-meta">${items.filter(Boolean).join('')}</div>
  </div>`;
}

function psnRgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function psnHex(rgb) {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}
function psnMix(bg, fg, t) {
  const a = psnRgb(bg), b = psnRgb(fg);
  return psnHex(a.map((v, i) => v * (1 - t) + b[i] * t));
}
function psnLum(rgb) {
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = rgb.map(f);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function psnContrast(a, b) {
  const [hi, lo] = [psnLum(a), psnLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function psnHsl(hex) {
  const [r, g, b] = psnRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  const l = (max + min) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return [h, s, l];
}
function psnFromHsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h * 6) % 2 - 1));
  const m = l - c / 2;
  const rgb = h < 1 / 6 ? [c, x, 0] : h < 2 / 6 ? [x, c, 0] : h < 3 / 6 ? [0, c, x]
    : h < 4 / 6 ? [0, x, c] : h < 5 / 6 ? [x, 0, c] : [c, 0, x];
  return rgb.map((v) => (v + m) * 255);
}
function psnInk(base, bg) {
  const [h, s, l] = psnHsl(base);
  const bgRgb = psnRgb(bg);
  const dir = psnLum(bgRgb) > 0.45 ? -1 : 1;
  for (let i = 0; i <= 100; i += 1) {
    const rgb = psnFromHsl(h, s, Math.max(0, Math.min(1, l + dir * i / 100)));
    if (psnContrast(rgb, bgRgb) >= 4.5) return psnHex(rgb);
  }
  return dir < 0 ? '#000000' : '#ffffff';
}
const PSN_THEME = Object.fromEntries(Object.entries(PSN_TYPE_BASE).map(([code, base]) => {
  const lightBg = psnMix('#e6f6fc', base, 0.12);
  const darkBg = psnMix('#1b293e', base, 0.18);
  return [code, { color: base, ink: psnInk(base, lightBg), inkDark: psnInk(base, darkBg) }];
}));
function psnTypeVars(code) {
  const t = PSN_THEME[code] || PSN_THEME.INFJ;
  return `--type-color:${t.color};--type-ink:${t.ink};--type-ink-dark:${t.inkDark}`;
}
function psnTypeFromAxes(axes) {
  const a = axes || {};
  return (Number(a.EI) >= 50 ? 'I' : 'E')
    + (Number(a.SN) >= 50 ? 'N' : 'S')
    + (Number(a.TF) >= 50 ? 'F' : 'T')
    + (Number(a.JP) >= 50 ? 'P' : 'J');
}
function psnAxisMeta() {
  return j(psnMeta(), ['mbti', 'axes'], []) || [];
}
function psnTypeTable() {
  return j(psnMeta(), ['mbti', 'types'], {}) || {};
}
function psnAxisSummary(axes) {
  return psnAxisMeta().map((axis) => {
    const v = Number(axes?.[axis.id]) || 0;
    return v >= 50 ? `${axis.right} ${Math.round(v)}%` : `${axis.left} ${Math.round(100 - v)}%`;
  }).join(' · ');
}

/* ── 浮动标签字段 / 开关：外观照原型，值仍走统一写口 ─────────────────── */
let PSN_UID = 0;
/* ── 分段渲染（2026-10-28）──────────────────────────────────────────────
   维护者反馈：从运行/发言切到人设时，一级栏与二级栏卡顿。探针实测（test/panel-perf.mjs）：
   页面提交落在 dock 380ms 动画的前 ~38ms，53 条 psn-* 入场动画里有 15 条与导航同窗起播。
   做法：换域进入人设时，导航那条时间线独占第一批帧；页面先落「壳」（卡框/文案/图例齐全，
   只把图表载荷留空、高度按 viewBox 预留），等 dock 停稳再把图表体填进去、同一刻撤掉
   动画闸门 —— `psn-stage` 把 `.psn` 下的 animation 全按住，`psnArmAndFill` 撤掉它。
   ⚠️ 只分人设、只在换域；同域二级切换与 3 秒轮询照旧一次画完
      （skip-redraw / psn-no-enter 一个字不动）。 */
let PSN_STAGE = 'full';
let psnChartSlots = null;
let psnStageGen = 0;
let psnArmTimer = 0;
/** 图表载荷：完整趟登记进 psnChartSlots，壳趟发空串（外层元素两趟逐字相同）。 */
function psnSlotBody(name, inner) {
  if (PSN_STAGE === 'shell') return '';
  if (psnChartSlots) psnChartSlots.set(name, inner);
  return inner;
}
function psnField(o) {
  const isBound = !!(o.bind || o.bindSys);
  const ctrl = o.bindSys
    ? { id: o.id, bindSys: o.bindSys, t: o.area ? 'textarea' : 'text' }
    : { id: o.id, bind: o.bind, t: o.area ? 'textarea' : 'text' };
  if (isBound) S.reg.set(o.id, ctrl);
  let value = isBound ? valueOf(ctrl) : (o.value ?? '');
  if (value == null) value = '';
  const domId = `psnf-${String(o.id).replace(/[^a-zA-Z0-9_-]/g, '-')}-${PSN_UID += 1}`;
  const attrs = isBound ? `data-id="${esc(o.id)}" data-a="field"` : '';
  const countPath = o.bind || o.bindSys || '';
  const countAttr = countPath && o.count !== false ? ` data-count-for="${esc(countPath)}"` : '';
  const common = `class="input" id="${domId}" ${attrs}${countAttr} placeholder=" "`;
  const control = o.area
    ? `<textarea ${common} rows="${o.rows || 2}" data-psn-auto data-max-h="${o.maxH || 220}">${esc(value)}</textarea>`
    : `<input ${common} type="${o.type || 'text'}" value="${esc(value)}"${o.min != null ? ` min="${o.min}"` : ''}${o.max != null ? ` max="${o.max}"` : ''}${o.step != null ? ` step="${o.step}"` : ''} />`;
  const chars = Array.from(String(o.label || '').replace(/[\s/、，。·]/g, '')).length;
  const size = chars <= 3 ? 'label-xs' : chars <= 6 ? 'label-sm' : 'label-lg';
  const countBit = o.count !== false && countPath
    ? `<span class="charcount" data-count-for="${esc(countPath)}">${psnLen(value)} 字</span>` : '';
  const helpBit = o.help
    ? `<button class="help" type="button" data-help-tip="${esc(o.help)}" aria-label="查看说明：${esc(plain(o.help))}" aria-expanded="false" aria-controls="psnHelpTip">?</button>` : '';
  const metaBits = [countBit, helpBit].filter(Boolean).join('');
  return `<div class="field ffield ${size}">
    <div class="ffield-box">${control}<label class="ff-label" for="${domId}">${esc(o.label)}</label></div>
    ${o.hint || metaBits ? `<div class="ffield-foot">${o.hint ? `<span class="field-hint">${mdBold(o.hint)}</span>` : ''}${metaBits ? `<span class="ff-meta">${metaBits}</span>` : ''}</div>` : ''}
  </div>`;
}

function psnSwitch(o) {
  const ctrl = { id: o.id, bind: o.bind, t: 'switch' };
  S.reg.set(o.id, ctrl);
  const on = !!valueOf(ctrl);
  return `<label class="psn-switch" title="${esc(o.label || '')}">
    <input type="checkbox" data-id="${esc(o.id)}" data-a="field" data-psn-repaint="1" ${on ? 'checked' : ''} aria-label="${esc(o.label || '')}">
    <span class="psn-switch-track" aria-hidden="true"></span>
  </label>`;
}

function psnSelect(o) {
  const ctrl = { id: o.id, bind: o.bind, t: 'select' };
  S.reg.set(o.id, ctrl);
  const cur = String(valueOf(ctrl) ?? o.value ?? '');
  const opts = (o.options || []).map(([v, label]) =>
    `<option value="${esc(v)}"${String(v) === cur ? ' selected' : ''}>${esc(label)}</option>`).join('');
  return `<select class="input" data-id="${esc(o.id)}" data-a="field"${o.repaint ? ' data-psn-repaint="1"' : ''} aria-label="${esc(o.label || '')}">${opts}</select>`;
}

function psnChartEmpty(text, go, goLabel) {
  return `<div class="chart-empty"><span class="dash">—</span><p>${esc(text)}</p>`
    + (go ? `<button class="linklike" type="button" data-go="${go}">${esc(goLabel || '去看看')}</button>` : '')
    + '</div>';
}

/* ── 图表：五面/四面雷达、环形、圆柱、折线（纯 SVG/CSS，零依赖）──────── */
const PSN_RADAR_AXES = [
  { id: 'warmth', label: '热情', low: '冷漠', angle: -90 },
  { id: 'initiative', label: '主动', low: '被动', angle: -18 },
  { id: 'sensitivity', label: '感性', low: '理性', angle: 54 },
  { id: 'stability', label: '稳定', low: '波动', angle: 126 },
  { id: 'expressiveness', label: '表达', low: '内敛', angle: 198 },
];
function psnRadarValues(e) {
  return PSN_RADAR_AXES.map((a) => {
    const v = Number(e?.radar?.[a.id]);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : NaN;
  });
}
function psnRadarCard() {
  const e = psnEmotion();
  const values = psnRadarValues(e);
  const has = e.ok === true && values.every(Number.isFinite);
  let body = psnChartEmpty('状态里还没有五维数据；机器人跑一轮后会自动生成。', 'persona/mood', '去心情值页');
  if (has) {
    const cx = 180, cy = 148, radius = 110;
    const point = (angle, v) => {
      const rad = angle * Math.PI / 180;
      const r = radius * Math.max(0, Math.min(100, v)) / 100;
      return [cx + Math.cos(rad) * r, cy + Math.sin(rad) * r];
    };
    const poly = (k) => PSN_RADAR_AXES.map((a) => {
      const rad = a.angle * Math.PI / 180;
      return [cx + Math.cos(rad) * radius * k, cy + Math.sin(rad) * radius * k].map((n) => n.toFixed(1)).join(',');
    }).join(' ');
    const grid = [0.25, 0.5, 0.75, 1].map((k) => `<polygon class="radar-grid" points="${poly(k)}"/>`).join('');
    const axes = PSN_RADAR_AXES.map((a) => {
      const rad = a.angle * Math.PI / 180;
      return `<line class="radar-axis" x1="${cx}" y1="${cy}" x2="${(cx + Math.cos(rad) * radius).toFixed(1)}" y2="${(cy + Math.sin(rad) * radius).toFixed(1)}"/>`;
    }).join('');
    const tipOf = (a, v) => {
      const mode = v >= 55 ? '偏高' : v <= 45 ? '偏低' : '中间';
      return { title: `${a.label} / ${a.low}`, value: `${Math.round(v)} / 100`, sub: `${mode}；低端=${a.low}` };
    };
    const sectors = PSN_RADAR_AXES.map((a, i) => {
      const p0 = point(a.angle - 36, 100);
      const p1 = point(a.angle + 36, 100);
      const t = tipOf(a, values[i]);
      return `<path class="radar-sector" d="M${cx},${cy} L${p0[0].toFixed(1)},${p0[1].toFixed(1)} A${radius},${radius} 0 0 1 ${p1[0].toFixed(1)},${p1[1].toFixed(1)} Z"
        data-tip="radar" data-tip-title="${esc(t.title)}" data-tip-value="${esc(t.value)}" data-tip-sub="${esc(t.sub)}" data-tip-color="var(--chart-2)"/>`;
    }).join('');
    const shape = values.map((v, i) => point(PSN_RADAR_AXES[i].angle, v)).map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const dots = values.map((v, i) => {
      const p = point(PSN_RADAR_AXES[i].angle, v);
      const t = tipOf(PSN_RADAR_AXES[i], v);
      return `<g class="radar-point" style="--i:${i}" data-tip="radar" data-tip-title="${esc(t.title)}" data-tip-value="${esc(t.value)}" data-tip-sub="${esc(t.sub)}" data-tip-color="var(--chart-2)">
        <circle class="radar-hit" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="16"/>
        <circle class="radar-dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.2"/></g>`;
    }).join('');
    const labels = PSN_RADAR_AXES.map((a, i) => {
      const rad = a.angle * Math.PI / 180;
      const x = cx + Math.cos(rad) * (radius + 20);
      const y = cy + Math.sin(rad) * (radius + 20) + 4;
      const anchor = Math.abs(Math.cos(rad)) < 0.2 ? 'middle' : (Math.cos(rad) > 0 ? 'start' : 'end');
      const t = tipOf(a, values[i]);
      return `<text class="radar-label" style="--i:${i}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" data-tip="radar" data-tip-title="${esc(t.title)}" data-tip-value="${esc(t.value)}" data-tip-sub="${esc(t.sub)}" data-tip-color="var(--chart-2)">${a.label} <tspan class="radar-value">${Math.round(values[i])}</tspan></text>`;
    }).join('');
    body = `<svg class="radar-svg" viewBox="0 0 360 276" role="img" aria-label="五维情绪倾向雷达图" data-psn-slot="radar">${psnSlotBody('radar', `<circle class="radar-orbit" cx="${cx}" cy="${cy}" r="122"/>${sectors}${grid}${axes}<polygon class="radar-shape" points="${shape}"/>${dots}${labels}`)}</svg>
      <div class="radar-legend">${PSN_RADAR_AXES.map((a, i) => `<span class="legend-item" style="--i:${i}"><span class="legend-dot"></span>${a.label} / ${a.low}<b>${Math.round(values[i])}</b></span>`).join('')}</div>
      <div class="chart-note">低端：冷漠 / 被动 / 理性 / 波动 / 内敛</div>`;
  }
  return `<div class="card fill chart-card trio span-4" style="--lc:var(--chart-2)">
    <div class="card-head"><div class="card-head-main"><div class="card-title">五维情绪倾向</div><div class="card-sub">实时 · 悬停看单项</div></div><span class="chip ${has ? 'accent' : ''}">${has ? '实时' : '未建立'}</span></div>
    <div class="chart-body">${body}</div>
    <div class="card-foot"><span class="hint">${has ? '低端也是一面' : '启动机器人后可看'}</span>${has
      ? '<button class="linklike" type="button" data-a="psn.mood.refresh">刷新</button>'
      : '<button class="linklike" type="button" data-go="persona/mood">去心情值页</button>'}</div>
  </div>`;
}

function psnDonutArcPath(cx, cy, r, a0, a1) {
  const p0 = { x: cx + r * Math.sin(a0), y: cy - r * Math.cos(a0) };
  const p1 = { x: cx + r * Math.sin(a1), y: cy - r * Math.cos(a1) };
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p0.x.toFixed(2)} ${p0.y.toFixed(2)}A${r} ${r} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

function psnLayerUsage() {
  const chars = (id) => {
    const sec = psnSection(id);
    return sec?.enabled ? (sec.chars || 0) : 0;
  };
  return [
    { id: 'persona', label: '人设', value: chars('persona'), color: 'var(--layer-1)' },
    { id: 'mbti', label: 'MBTI', value: chars('mbti'), color: 'var(--layer-2)' },
    { id: 'enhance', label: '增强', value: chars('enhance'), color: 'var(--layer-3)' },
    { id: 'mood', label: '心情', value: chars('mood'), color: 'var(--layer-4)' },
  ];
}

function psnDonutCard() {
  const items = psnLayerUsage();
  const total = items.reduce((n, i) => n + i.value, 0);
  const whole = psnPromptData().total || 0;
  const share = whole ? Math.round(total / whole * 100) : 0;
  const segs = [];
  if (total > 0) {
    let cursor = 0;
    const gap = 3.5 / 90 + 18 / 2 / 90;
    items.forEach((item, idx) => {
      if (!item.value) return;
      const a0 = cursor * Math.PI * 2;
      cursor += item.value / total;
      const a1 = cursor * Math.PI * 2;
      const start = a0 + gap;
      const end = Math.max(start + 0.012, a1 - gap);
      segs.push({ ...item, idx, pct: Math.round(item.value / total * 100), d: psnDonutArcPath(125, 125, 90, start, end) });
    });
  }
  const legend = items.map((i, idx) => {
    const pct = total ? Math.round(i.value / total * 100) : 0;
    return `<div class="donut-legend-item${i.value ? '' : ' is-off'}" data-donut-index="${idx}" data-donut-label="${esc(i.label)}" data-donut-value="${i.value}" data-donut-pct="${i.value ? `${pct}%` : '未注入'}">
      <span class="legend-dot" style="--lc:${i.color}"></span>
      <span class="donut-legend-name">${esc(i.label)}</span>
      <b class="donut-legend-val">${i.value ? psnFmt(i.value) : '—'}</b>
      <span class="donut-legend-pct">${i.value ? `${pct}%` : '未注入'}</span></div>`;
  }).join('');
  const has = total > 0;
  return `<div class="card fill chart-card trio span-4" style="--lc:var(--chart-1)">
    <div class="card-head"><div class="card-head-main"><div class="card-title">四层提示词用量</div><div class="card-sub">环形 = 字数占比 · 悬停看单层</div></div><span class="chip">字</span></div>
    <div class="chart-body">${has ? `<div class="layer-donut" data-donut-total="${total}">
      <svg class="donut-svg" viewBox="0 0 250 250" role="img" aria-label="人设 / MBTI / 增强 / 心情四层提示词用量环形图" data-psn-slot="donut">${psnSlotBody('donut', `<circle class="donut-track" cx="125" cy="125" r="90"/>${segs.map((s) => `<g class="donut-seg" data-donut-index="${s.idx}" data-donut-label="${esc(s.label)}" data-donut-value="${s.value}" data-donut-pct="${s.pct}%">
          <path class="donut-arc" style="--seg:${s.color}" d="${s.d}"/>
          <path class="donut-hit" style="--seg:${s.color}" d="${s.d}" data-donut-index="${s.idx}" data-donut-label="${esc(s.label)}" data-donut-value="${s.value}" data-donut-pct="${s.pct}%"/>
        </g>`).join('')}`)}</svg>
      <div class="donut-center"><span class="donut-center-label">四层合计</span><b class="donut-center-value">${psnFmt(total)}</b><span class="donut-center-pct"></span></div>
    </div><div class="donut-legend">${legend}</div>
    <div class="chart-facts"><span>占全文 <b>${share}%</b></span><span>四层 <b>${psnFmt(total)} 字</b></span></div>`
      : psnChartEmpty('人设 / MBTI / 增强 / 心情都还没有字，环形暂时是空的。', 'persona/prompt', '去提示词页')}
    </div>
    <div class="card-foot"><span class="hint">四层合计 <b>${psnFmt(total)}</b> 字</span><button class="linklike" type="button" data-go="persona/prompt">提示词 →</button></div>
  </div>`;
}

const PSN_EMO_FALLBACK = [
  { label: '正向', key: 'positive', items: [] }, { label: '中性', key: 'neutral', items: [] }, { label: '负向', key: 'negative', items: [] },
];
function psnEmoGroups() { return j(psnMeta(), ['emotion', 'groups'], PSN_EMO_FALLBACK) || PSN_EMO_FALLBACK; }
function psnSpectrum() {
  const e = psnEmotion();
  if (!e.ok) return null;
  if (Array.isArray(e.spectrum) && e.spectrum.length) return e.spectrum;
  return null;
}
function psnEmoTotals() {
  const sp = psnSpectrum();
  if (!sp) return null;
  const map = Object.fromEntries(sp);
  return psnEmoGroups().map((g) => ({
    label: g.label,
    value: g.items.reduce((n, [k]) => n + (Number(map[k]) || 0), 0),
    color: g.label === '正向' ? 'var(--chart-3)' : g.label === '中性' ? 'var(--chart-neutral)' : 'var(--chart-5)',
    sub: g.items.filter(([k]) => Number(map[k]) > 0).sort((a, b) => map[b[0]] - map[a[0]]).slice(0, 3).map(([k, l]) => `${l} ${map[k]}`).join(' · ') || '无',
  }));
}
function psnCylinderCard() {
  const totals = psnEmoTotals();
  const has = !!totals;
  const total = has ? totals.reduce((n, i) => n + i.value, 0) : 0;
  const emoLabels = Object.fromEntries(psnEmoGroups().flatMap((g) => g.items));
  const top3 = (psnSpectrum() || []).filter(([, v]) => Number(v) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 3)
    .map(([k]) => emoLabels[k] || k).join(' / ');
  let body = psnChartEmpty('状态还没建立，暂时没有情绪分布。', 'persona/mood', '去心情值页');
  if (has && total === 0) {
    body = psnChartEmpty('21 项都还是 0：情绪还没被触发，聊几轮后这里才会出现分布。', 'persona/mood', '去心情值页');
  } else if (has) {
    const max = Math.max(1, ...totals.map((i) => i.value));
    const bars = totals.map((i, idx) => {
      const h = i.value ? Math.max(3, Math.round(i.value / max * 100)) : 3;
      const pct = total ? Math.round(i.value / total * 100) : 0;
      return `<div class="cyl-item" style="--i:${idx}" data-tip="cyl" data-tip-title="${esc(i.label)}" data-tip-value="${i.value ? esc(`${psnFmt(i.value)} · ${pct}%`) : '未注入'}" data-tip-sub="${esc(i.sub || '')}" data-tip-color="${i.color}">
        <div class="cyl-track" style="--h:${h}"><div class="cyl" style="height:${h}%;--cyl-color:${i.color};--i:${idx}"></div><span class="cyl-val">${i.value ? psnFmt(i.value) : '—'}</span></div>
        <div class="cyl-label"><span class="legend-dot" style="--lc:${i.color}"></span>${esc(i.label)}</div></div>`;
    }).join('');
    body = `<div class="cyl-chart" data-psn-slot="cyl">${psnSlotBody('cyl', bars)}</div>
    <div class="chart-facts"><span>非零 <b>${psnSpectrum().filter(([, v]) => Number(v) > 0).length} / 21</b></span><span>合计 <b>${psnFmt(total)}</b></span></div>
    <div class="chart-note">${totals.map((i) => `${i.label} ${total ? Math.round(i.value / total * 100) : 0}%`).join(' · ')}</div>`;
  }
  return `<div class="card fill chart-card trio span-4" style="--lc:var(--chart-3)">
    <div class="card-head"><div class="card-head-main"><div class="card-title">情绪构成</div><div class="card-sub">柱高 = 强度 · 悬停看主导</div></div><span class="chip">${has ? '此刻' : '未接入'}</span></div>
    <div class="chart-body">${body}</div>
    <div class="card-foot"><span class="hint">${has ? `主导 ${top3 || '—'}` : '启动后可看分布'}</span><button class="linklike" type="button" data-go="persona/mood">详情 →</button></div>
  </div>`;
}

const PSN_LINE_SPRING = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, raf: 0, last: 0 };
function psnLineReduced() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
function psnLineRender() {
  const svg = document.querySelector('.psn .line-svg');
  const cross = svg?.querySelector('.line-cross');
  if (!svg || !cross) return false;
  const top = Number(svg.dataset.plotTop);
  const bottom = Number(svg.dataset.plotBottom);
  const left = Number(svg.dataset.plotLeft);
  const right = Number(svg.dataset.plotRight);
  const v = cross.querySelector('.line-cross-v');
  const h = cross.querySelector('.line-cross-h');
  const dot = cross.querySelector('.line-cross-dot');
  if (!v || !h || !dot) return false;
  v.setAttribute('x1', PSN_LINE_SPRING.x); v.setAttribute('x2', PSN_LINE_SPRING.x);
  v.setAttribute('y1', top); v.setAttribute('y2', bottom);
  h.setAttribute('x1', left); h.setAttribute('x2', right);
  h.setAttribute('y1', PSN_LINE_SPRING.y); h.setAttribute('y2', PSN_LINE_SPRING.y);
  dot.setAttribute('cx', PSN_LINE_SPRING.x); dot.setAttribute('cy', PSN_LINE_SPRING.y);
  return true;
}
function psnLineTick() {
  const st = PSN_LINE_SPRING;
  st.raf = 0;
  const k = 340, d = 30, m = 0.85, dt = 1 / 60;
  const fx = -k * (st.x - st.tx) - d * st.vx;
  const fy = -k * (st.y - st.ty) - d * st.vy;
  st.vx += (fx / m) * dt; st.vy += (fy / m) * dt;
  st.x += st.vx * dt; st.y += st.vy * dt;
  if (!psnLineRender()) return;
  if (Math.abs(st.x - st.tx) < 0.15 && Math.abs(st.y - st.ty) < 0.15
    && Math.abs(st.vx) < 0.15 && Math.abs(st.vy) < 0.15) {
    st.x = st.tx; st.y = st.ty; st.vx = 0; st.vy = 0; psnLineRender(); return;
  }
  st.raf = requestAnimationFrame(psnLineTick);
}
function psnLineSet(x, y) {
  const st = PSN_LINE_SPRING;
  st.tx = x; st.ty = y;
  if (psnLineReduced()) {
    if (st.raf) cancelAnimationFrame(st.raf);
    st.raf = 0; st.x = x; st.y = y; st.vx = 0; st.vy = 0; psnLineRender(); return;
  }
  if (!st.raf) st.raf = requestAnimationFrame(psnLineTick);
}
function psnLineHide() {
  const st = PSN_LINE_SPRING;
  if (st.raf) cancelAnimationFrame(st.raf);
  st.raf = 0;
  const cross = document.querySelector('.psn .line-cross');
  if (cross) cross.classList.remove('is-on');
  for (const p of document.querySelectorAll('.psn .line-point.is-active')) p.classList.remove('is-active');
  psnChartHide();
}
function psnLineHover(zone, ev) {
  const svg = zone.closest('.line-svg');
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  if (!rect.width) return;
  const wx = (ev.clientX - rect.left) * (Number(svg.viewBox.baseVal.width) || 640) / rect.width;
  const points = [...svg.querySelectorAll('.line-point')];
  if (!points.length) return;
  let best = points[0];
  for (const p of points) {
    if (Math.abs(Number(p.dataset.x) - wx) < Math.abs(Number(best.dataset.x) - wx)) best = p;
  }
  const x = Number(best.dataset.x), y = Number(best.dataset.y);
  const cross = svg.querySelector('.line-cross');
  if (cross) cross.classList.add('is-on');
  for (const p of points) p.classList.toggle('is-active', p === best);
  psnLineSet(x, y);
  psnChartShowData({
    title: best.dataset.title || '',
    value: best.dataset.v ? `${best.dataset.v} / 100` : '',
    sub: best.dataset.sub || '',
    color: 'var(--chart-3)',
  }, ev.clientX, ev.clientY);
}
document.addEventListener('pointermove', (ev) => {
  const zone = ev.target instanceof Element ? ev.target.closest('.psn .line-hover-zone') : null;
  if (zone) psnLineHover(zone, ev);
});
document.addEventListener('pointerout', (ev) => {
  const zone = ev.target instanceof Element ? ev.target.closest('.psn .line-hover-zone') : null;
  if (zone) psnLineHide();
});

function psnTrendSvg(values) {
  const W = 640, H = 232, L = 38, R = 16, T = 18, B = 32;
  const n = values.length;
  const xs = values.map((_, i) => L + (n === 1 ? 0 : (i / (n - 1)) * (W - L - R)));
  const ys = values.map((v) => T + (1 - Math.max(0, Math.min(100, v)) / 100) * (H - T - B));
  const line = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const area = `M${xs[0].toFixed(1)},${H - B} ${xs.map((x, i) => `L${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')} L${xs[n - 1].toFixed(1)},${H - B} Z`;
  const grid = [0, 50, 100].map((v) => {
    const y = T + (1 - v / 100) * (H - T - B);
    return `<line class="line-grid ${v === 50 ? 'dashed' : ''}" x1="${L}" y1="${y}" x2="${W - R}" y2="${y}"/><text class="line-axis" x="4" y="${y + 3}">${v}</text>`;
  }).join('');
  const points = xs.map((x, i) => {
    const prev = i > 0 ? values[i - 1] : values[i];
    const diff = values[i] - prev;
    const title = i === n - 1 ? '现在' : `${n - 1 - i} 步前`;
    const sub = i === 0 ? '曲线起点' : `较上点 ${diff >= 0 ? '+' : ''}${diff}`;
    return `<g class="line-point${i === n - 1 ? ' is-now' : ''}" data-x="${x.toFixed(1)}" data-y="${ys[i].toFixed(1)}" data-v="${values[i]}" data-title="${esc(title)}" data-sub="${esc(sub)}">
      <circle class="line-dot" cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="${i === n - 1 ? 4.2 : 2.6}"/></g>`;
  }).join('');
  const lastX = xs[n - 1].toFixed(1), lastY = ys[n - 1].toFixed(1);
  const inner = `${grid}<line class="line-now-line" x1="${lastX}" y1="${T}" x2="${lastX}" y2="${H - B}"/>
    <path class="line-area" d="${area}"/><path class="line-path" pathLength="1" d="${line}"/>
    <circle class="line-pulse" cx="${lastX}" cy="${lastY}" r="9"/>${points}
    <g class="line-cross" aria-hidden="true">
      <line class="line-cross-v" x1="${lastX}" y1="${T}" x2="${lastX}" y2="${H - B}"/>
      <line class="line-cross-h" x1="${L}" y1="${lastY}" x2="${W - R}" y2="${lastY}"/>
      <circle class="line-cross-dot" cx="${lastX}" cy="${lastY}" r="6"/>
    </g>
    <text class="line-now" x="${xs[n - 1] - 4}" y="${ys[n - 1] - 10}" text-anchor="end">${values[n - 1]}</text>
    <text class="line-axis" x="${L}" y="${H - 8}">最早</text><text class="line-axis" x="${(L + W - R) / 2}" y="${H - 8}" text-anchor="middle">中段</text><text class="line-axis" x="${W - R}" y="${H - 8}" text-anchor="end">现在</text>
    <rect class="line-hover-zone" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/>`;
  return `<svg class="line-svg" viewBox="0 0 ${W} ${H}" data-plot-top="${T}" data-plot-bottom="${H - B}" data-plot-left="${L}" data-plot-right="${W - R}" role="img" aria-label="心情走势折线图" data-psn-slot="line">${psnSlotBody('line', inner)}</svg>`;
}

function psnTrendCard() {
  const e = psnEmotion();
  const vals = Array.isArray(e.trend) ? e.trend : [];
  const has = e.ok && vals.length >= 2;
  return `<div class="card fill chart-card span-8" style="--lc:var(--chart-3)">
    <div class="card-head"><div class="card-head-main"><div class="card-title">心情走势</div><div class="card-sub">${has ? `最近 ${vals.length} 个采样` : '还没有第二个采样'}</div></div><span class="chip ${has ? 'accent' : ''}">${has ? '趋势' : '无历史'}</span></div>
    <div class="chart-body">${has ? psnTrendSvg(vals) : psnChartEmpty('状态文件目前只有一个当前值；跨过一个采样间隔后才会出现真实曲线 —— 这里不画假折线。', 'persona/mood', '去心情值页')}</div>
    <div class="card-foot"><span class="hint">${has ? `当前 <b>${e.mood ?? '—'}</b> · 区间 ${Math.min(...vals)}–${Math.max(...vals)}` : '等状态累积两个采样后自动出现'}</span><button class="linklike" type="button" data-go="persona/mood">详情 →</button></div>
  </div>`;
}

/* ── 卡片 / 层卡 ─────────────────────────────────────────────────────── */
function psnLayerCard(no, kind, titleHtml, bodyHtml, footHtml, color, meterHtml) {
  return `<div class="card fill layer-card span-3" style="--lc:${color}">
    <div class="layer-top"><span class="layer-no">${no}</span><span class="layer-kind">${kind}</span></div>
    <div class="layer-name">${titleHtml}</div>
    ${bodyHtml}${meterHtml || ''}
    <div class="layer-foot">${footHtml}</div>
  </div>`;
}

function psnPersonaFilled() {
  const p = psnPersona();
  const keys = ['age', 'role', 'world', 'desire', 'fear', 'traits', 'tone', 'catch', 'logic', 'attitude', 'status'];
  return (psnName() ? 1 : 0) + keys.filter((k) => String(p[k] || '').trim()).length;
}
function psnEnhanceFilled() {
  return Object.values(psnEnhance()).filter((v) => String(v || '').trim()).length;
}
function psnEnhanceChars() {
  return Object.values(psnEnhance()).reduce((n, v) => n + psnLen(v), 0);
}
function psnMoodLabel(n) {
  if (!Number.isFinite(Number(n))) return '—';
  if (Number(n) >= 75) return '轻快';
  if (Number(n) >= 60) return '平静偏暖';
  if (Number(n) >= 45) return '平稳';
  return '低落';
}
function psnMoodTone(n) {
  return Number(n) >= 60 ? 'var(--chart-3)' : Number(n) >= 45 ? 'var(--chart-4)' : 'var(--chart-5)';
}
function psnStaleNote() {
  const p = psnState().panel;
  return p && p.stale === true ? '<span class="chip warn">面板代码已更新，正在重启</span>' : '';
}

/* ── ① 总览 ─────────────────────────────────────────────────────────── */
function psnOverviewHtml() {
  const p = psnPersona();
  const m = psnMbti();
  const b = psnBirth();
  const e = psnEmotion();
  const pr = psnPromptData();
  const filledPersona = psnPersonaFilled();
  const filledEnh = psnEnhanceFilled();
  const total = pr.total || 0;
  const layerTotal = pr.layerTotal || 0;
  const psn = psnSection('persona');
  const sectMbti = psnSection('mbti');
  const sectEnh = psnSection('enhance');
  const moodOk = e.ok === true;
  const moodTone = psnMoodTone(e.mood);
  const energy = e.energy || {};
  const cards = [
    psnLayerCard('①', '定义层 · 最高优先级', esc(p.name || psnName() || '未命名'),
      `<div class="layer-role">${esc(p.role || '还没有身份')}</div>
       <div class="layer-lines"><span>${esc(p.traits || '性格关键词还没填')}</span><span>${esc(String(p.tone || '').split('。')[0] || '说话方式还没填')}</span></div>`,
      `<button class="linklike" type="button" data-go="persona/profile">编辑人设 →</button><span class="hint">${psnFmt(psn?.chars || 0)} 字</span>`,
      'var(--layer-1)',
      `<div class="layer-meter"><span>字段</span><div class="bar"><i style="width:${Math.round(filledPersona / 12 * 100)}%"></i></div><b>${filledPersona}/12</b></div>`),
    psnLayerCard('②', '辅助层', `${m.type} <span style="font-size:12px;font-weight:400;color:var(--text-3)">${esc(m.name)}</span>`,
      `<div class="layer-role">${esc(m.tag || '还没设置 MBTI')}</div>
       <div class="chip-row" style="margin-top:2px">${(m.traits || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('') || '<span class="chip">未填</span>'}</div>
       <div class="layer-lines"><span>${esc(m.summary || '')}</span></div>`,
      `<button class="linklike" type="button" data-go="persona/mbti">调整 MBTI →</button><span class="hint">${m.on ? '注入开' : '注入关'}</span>`,
      'var(--layer-2)',
      `<div class="layer-meter"><span>四轴</span><div class="bar"><i style="width:56%"></i></div><b>${m.type}</b></div>`),
    psnLayerCard('③', '细节层', `${filledEnh}/12 已填`,
      `<div class="layer-role">12 项细节；留空不进。负责像不像人，不负责是谁。</div>
       <div class="layer-lines">${psnEnhanceGroups().map((g) => {
        const n = (g.keys || []).filter((k) => String(psnEnhance()[k] || '').trim()).length;
        return `<span>${esc(g.label)} ${n}/${(g.keys || []).length}</span>`;
      }).join('') || '<span>后端没下发分组</span>'}</div>`,
      `<button class="linklike" type="button" data-go="persona/enhance">编辑增强项 →</button><span class="hint">${psnFmt(sectEnh?.chars || psnEnhanceChars())} 字</span>`,
      'var(--layer-3)',
      `<div class="layer-meter"><span>已填</span><div class="bar"><i style="width:${Math.round(filledEnh / 12 * 100)}%"></i></div><b>${filledEnh}/12</b></div>`),
    psnLayerCard('④', '实时层', `${moodOk ? e.mood : '—'} <span style="font-size:12px;font-weight:400;color:var(--text-3)">/ 100 · ${moodOk ? psnMoodLabel(e.mood) : '未接入'}</span>`,
      `<div class="layer-role">心情 / 唤醒 / 压力 / 精力；每轮更新，只影响这一轮语气。</div>
       <div class="mini-list">${moodOk
        ? `<div class="row"><span>唤醒</span><b>${e.arousal ?? '—'}</b><span>急性压力</span><b>${e.acuteStress ?? '—'}</b></div>
           <div class="row"><span>精力</span><b>${energy.physical ?? '—'}</b><span>情绪</span><b>${energy.emotional ?? '—'}</b></div>`
        : '<div class="row"><span>数据源</span><b>项目本体</b><span>状态</span><b>未建立</b></div>'}</div>`,
      `<button class="linklike" type="button" data-go="persona/mood">查看心情 →</button><span class="hint">${moodOk ? '本体写入' : '还没数据'}</span>`,
      'var(--layer-4)',
      `<div class="layer-meter"><span>心情</span><div class="bar"><i style="width:${moodOk ? Math.max(0, Math.min(100, e.mood)) : 0}%;background:${moodTone}"></i></div><b>${moodOk ? e.mood : '—'}</b></div>`),
  ].join('');

  const miniRows = [
    { no: '①', name: '人物设定', text: `${p.name || psnName() || '未命名'} · ${String(p.role || '未填').slice(0, 30)}`, chars: psn?.chars || 0 },
    { no: '②', name: 'MBTI 辅助', text: `${m.type} · ${m.summary || '—'}`, chars: sectMbti?.enabled ? sectMbti.chars : 0 },
    { no: '③', name: '更细的演法', text: '12 项增强 · 价值观 / 决策 / 情绪触发 / 示例台词', chars: sectEnh?.chars || 0 },
    { no: '④', name: '此刻的状态', text: moodOk ? `心情 ${e.mood}/100（${psnMoodLabel(e.mood)}）· 主导 ${topEmotionsText(e)}` : '状态未建立', chars: psnSection('mood')?.enabled ? (psnSection('mood')?.chars || 0) : 0 },
  ];
  const segColors = ['var(--layer-1)', 'var(--layer-2)', 'var(--layer-3)', 'var(--layer-4)'];
  const known = miniRows.reduce((n, r) => n + r.chars, 0);
  const comp = miniRows.map((r, i) => `<div class="comp-seg" style="--seg:${segColors[i]};width:${Math.max(4, Math.round(r.chars / Math.max(1, known) * 100))}%"></div>`).join('');
  const promptCard = `<div class="card fill span-12" style="--lc:var(--chart-neutral)">
    <div class="card-head"><div class="card-head-main"><div class="card-title">汇总 · 系统提示词</div><div class="card-sub">四层人设在这里合成一段话；每轮发言前重建。</div></div>
      <div class="card-actions"><span class="chip accent">自动汇总</span><button class="card-link" type="button" data-go="persona/prompt">查看全文 →</button></div></div>
    <div class="comp-bar" aria-label="人设各段占提示词的比例">${comp}</div>
    <div class="prompt-mini">${miniRows.map((r) => `<div class="prompt-mini-row">
      <span class="prompt-mini-no" style="color:var(--text-3)">${r.no}</span>
      <span class="prompt-mini-txt"><b>${r.name}</b> · ${esc(r.text)}</span>
      <span class="prompt-mini-chars">${r.chars ? `${psnFmt(r.chars)} 字` : '未注入'}</span></div>`).join('')}</div>
    <div class="card-foot"><span class="hint">四层 <b>${psnFmt(layerTotal)}</b> 字 · 占提示词 <b>${total ? Math.round(layerTotal / total * 100) : 0}%</b></span><span class="chip accent">每轮注入</span></div>
  </div>`;

  const priority = `<div class="card fill multi-rail priority-card span-4">
    <div class="card-head"><div class="card-head-main"><div class="card-title">优先级</div><div class="card-sub">越靠上，越不该被下面的层覆盖。</div></div><span class="chip plain">冲突时</span></div>
    <div class="pri-list">
      ${[['①', '人格定义', '决定它是谁；最高优先', 100, 'var(--layer-1)'], ['②', 'MBTI 辅助', '调整表达倾向，不覆盖人设', 78, 'var(--layer-2)'], ['③', '增强项', '让演法更像人，留空不进', 60, 'var(--layer-3)'], ['④', '心情值', '只影响这一轮的语气', 42, 'var(--layer-4)']]
        .map(([no, name, sub, pct, color], i) => `<div class="pri-row" style="--lc:${color};--i:${i}"><span class="pri-no">${no}</span><div class="pri-copy"><b>${name}</b><span>${sub}</span></div><div class="pri-meter"><div class="pri-bar"><i style="width:${pct}%"></i></div><span class="pri-pct" title="相对权重，不是实际字数占比">${pct}</span></div></div>`).join('')}
    </div>
    <div class="card-foot"><span class="hint">整段 <b>${psnFmt(total)}</b> 字</span><span class="chip ${psnState().panel?.stale ? 'warn' : 'ok'}">${psnState().panel?.stale ? '待重启' : '已同步'}</span></div>
  </div>`;

  return `<div class="psn" data-psn-page="overview">
    ${psnPageHead([
      psnChip(`人设 <b>${filledPersona}/12</b>`),
      psnChip(`增强 <b>${filledEnh}/12</b>`),
      psnChip(`提示词 <b>${psnFmt(total)}</b> 字`, 'accent'),
      psnStaleNote(),
    ])}
    <div class="grid psn-layer-grid">${cards}</div>
    <div class="span-12"><div class="grid chart-trio">${psnRadarCard()}${psnDonutCard()}${psnCylinderCard()}</div></div>
    <div class="span-12"><div class="grid priority-row">${psnTrendCard()}${priority}</div></div>
    ${promptCard}
  </div>`;
}

function topEmotionsText(e) {
  if (!Array.isArray(e.spectrum)) return '—';
  const groups = psnEmoGroups();
  const labels = Object.fromEntries(groups.flatMap((g) => g.items));
  return e.spectrum.filter(([, v]) => Number(v) > 0).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${labels[k] || k} ${v}`).join(' · ') || '—';
}
function psnEnhanceGroups() {
  const meta = j(psnMeta(), ['enhance'], {}) || {};
  const keys = meta.keys || [];
  const groups = meta.groups || [];
  return groups.map((label) => ({ label, keys: keys.filter((k) => meta.table?.[k]?.group === label) }));
}

/* ── ② 人设 ─────────────────────────────────────────────────────────── */
function psnBirthDraft() {
  const age = Number(psnVal('birthday.age', 0)) || 0;
  const month = Number(psnVal('birthday.month', 0)) || 0;
  const day = Number(psnVal('birthday.day', 0)) || 0;
  const meta = j(psnMeta(), ['birthday'], {}) || {};
  const signs = Array.isArray(meta.signs) ? meta.signs : [];
  let sign = null;
  if (month >= 1 && month <= 12 && day >= 1) {
    sign = signs.find((s) => {
      const [sm, sd] = s.start || [];
      const [em, ed] = s.end || [];
      if (sm <= em) return (month > sm || (month === sm && day >= sd)) && (month < em || (month === em && day <= ed));
      return (month > sm || (month === sm && day >= sd)) || (month < em || (month === em && day <= ed));
    }) || null;
  }
  let year = null;
  const today = psnBirth().today;
  if (sign && age > 0 && today) {
    const before = today.m < month || (today.m === month && today.d < day);
    year = today.y - age - (before ? 1 : 0);
  }
  const animals = Array.isArray(meta.animals) ? meta.animals : [];
  const animal = year && animals.length ? animals[((year - 4) % 12 + 12) % 12] : '';
  return { age, month, day, year, animal, sign, on: psnBool('astroOn', false) };
}

function psnBirthdayCard() {
  const b = psnBirthDraft();
  const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][(b.month || 1) - 1] || 31;
  const monthOpts = [['0', '未填']].concat(Array.from({ length: 12 }, (_, i) => [String(i + 1), `${i + 1} 月`]));
  const dayOpts = [['0', '未填']].concat(Array.from({ length: maxDay }, (_, i) => [String(i + 1), `${i + 1} 日`]));
  const astroSec = psnSection('astro');
  const injected = b.on && !!b.sign && !!astroSec?.enabled;
  const astroChars = astroSec?.chars || 0;
  const ageCtrl = { id: 'psn.birth.age', bind: 'birthday.age', t: 'number' };
  S.reg.set(ageCtrl.id, ageCtrl);
  const ageVal = valueOf(ageCtrl) ?? 0;
  const injectNote = injected
    ? `两句 · ${psnFmt(astroChars)} 字 · 最低权重`
    : (b.on ? '开关已开 · 保存后生效' : '关掉时完全不影响提示词');
  const preview = injected
    ? '星座写进提示词；生肖只展示，不进提示词。'
    : (b.sign ? (b.on ? '开关已开；保存后这一段才会进提示词。生肖始终只展示。' : '开关关闭，不影响提示词；生肖始终只展示。') : '选好生日后可注入；生肖始终只展示。');
  return `<div class="card fill span-12 birth-card" style="--lc:var(--chart-4)">
    <div class="card-head"><div class="card-head-main"><div class="card-title">生日彩蛋 <span class="chip plain">娱乐</span></div><div class="card-sub">参考周岁 + 生日，推生肖与星座，不改人设。生肖只展示；星座最多两句。</div></div>
      <span class="chip${injected ? ' ok' : ''}">${injected ? '<span class="dot"></span>已注入 · 最低权重' : '未注入'}</span></div>
    <div class="birth-main">
      <div class="birth-controls">
        <label class="birth-field">参考周岁
          <span class="birth-age-wrap">
            <input class="input birth-age" type="number" min="0" max="120" step="1" inputmode="numeric"
                   data-id="psn.birth.age" data-a="field" data-psn-repaint="1"
                   value="${esc(ageVal)}" aria-label="参考周岁" />
            <span>岁</span>
          </span>
        </label>
        <label class="birth-field">生日
          <span class="birth-date">
            ${psnSelect({ id: 'psn.birth.month', bind: 'birthday.month', label: '出生月份', options: monthOpts, repaint: true })}
            ${psnSelect({ id: 'psn.birth.day', bind: 'birthday.day', label: '出生日期', options: dayOpts, repaint: true })}
          </span>
        </label>
      </div>
      <div class="birth-signs">
        <div class="sign-tile" style="--sign:var(--chart-3)">
          <span class="sign-orb">${esc(b.animal || '—')}</span>
          <span class="sign-copy"><b>生肖 · ${esc(b.animal || '待填写')}</b><span>${b.year ? `${b.year} 年 · 仅展示` : '填周岁后推算 · 仅展示'}</span></span>
        </div>
        <div class="sign-tile" style="--sign:var(--chart-4)">
          <span class="sign-orb">${b.sign ? b.sign.glyph : '—'}</span>
          <span class="sign-copy"><b>星座 · ${b.sign ? esc(b.sign.name) : '待填写'}</b><span>${b.sign ? `${esc(b.sign.range)} · ${injected ? '极轻注入' : (b.on ? '待保存' : '未注入')}` : '选好月日后锁定'}</span></span>
        </div>
      </div>
      <div class="birth-inject">
        <div class="switch-row">
          <div class="switch-copy"><b>星座写进提示词</b><span>${injectNote}</span></div>
          ${psnSwitch({ id: 'psn.astro.on', bind: 'astroOn', label: '星座写进提示词' })}
        </div>
      </div>
    </div>
    <div class="card-foot birth-foot"><span class="hint">${esc(preview)}</span><button class="card-link" type="button" data-go="persona/prompt">看完整提示词 →</button></div>
  </div>`;
}

function psnProfileHtml() {
  const p = psnPersona();
  const pr = psnSection('persona');
  const identity = `<div class="card fill span-4">
    <div class="card-head"><div class="card-head-main"><div class="card-title">身份档案</div><div class="card-sub">它在什么世界、以什么身份说话。</div></div><span class="chip accent">① 最高优先</span></div>
    <div class="stack">
      <div class="fg-2">
        ${psnField({ id: 'p.name', bindSys: 'personaName', label: '机器人昵称', help: '顶层 personaName；换到别的页面看到的也是同一个值。' })}
        ${psnField({ id: 'p.age', bind: 'persona.age', label: '年龄' })}
      </div>
      ${psnField({ id: 'p.role', bind: 'persona.role', label: '身份', area: true, rows: 3, maxH: 190 })}
      ${psnField({ id: 'p.world', bind: 'persona.world', label: '时代 / 世界观', area: true, rows: 3, maxH: 190, hint: '影响它举什么例子、用什么词。' })}
    </div>
    <div class="card-foot"><span class="hint">权重最高 · 冲突时以这里为准</span><button class="card-link" type="button" data-go="persona/prompt">注入结果 →</button></div>
  </div>`;
  const drive = `<div class="card fill span-4">
    <div class="card-head"><div class="card-head-main"><div class="card-title">核心驱动</div><div class="card-sub">想要什么、怕什么；行为的发动机。</div></div><span class="chip">核心</span></div>
    <div class="stack">
      ${psnField({ id: 'p.desire', bind: 'persona.desire', label: '核心欲望', area: true, rows: 3, maxH: 180 })}
      ${psnField({ id: 'p.fear', bind: 'persona.fear', label: '核心恐惧 / 弱点', area: true, rows: 3, maxH: 180 })}
      ${psnField({ id: 'p.traits', bind: 'persona.traits', label: '性格关键词', area: true, rows: 2, maxH: 150 })}
    </div>
    <div class="card-foot"><span class="hint">行为驱动。</span><span class="chip plain">驱动</span></div>
  </div>`;
  const voice = `<div class="card fill span-4">
    <div class="card-head"><div class="card-head-main"><div class="card-title">表达方式</div><div class="card-sub">像不像一个人，主要看这里。</div></div><span class="chip">语气</span></div>
    <div class="stack">
      ${psnField({ id: 'p.tone', bind: 'persona.tone', label: '说话方式', area: true, rows: 4, maxH: 200 })}
      ${psnField({ id: 'p.catch', bind: 'persona.catch', label: '口头禅' })}
      ${psnField({ id: 'p.attitude', bind: 'persona.attitude', label: '对群里人的态度', area: true, rows: 3, maxH: 180 })}
    </div>
    <div class="card-foot"><span class="hint">最影响像不像。</span><span class="chip plain">手感</span></div>
  </div>`;
  const file = j(psnState(), ['config', 'personaFile'], '');
  const logic = `<div class="card fill span-8">
    <div class="card-head"><div class="card-head-main"><div class="card-title">行为逻辑</div><div class="card-sub">怎么决定、怎么反应、底线在哪。</div></div><span class="chip">决策</span></div>
    ${psnField({ id: 'p.logic', bind: 'persona.logic', label: '遇事的反应逻辑', area: true, rows: 4, maxH: 240 })}
    <div class="divider"></div>
    <div class="fg-2">
      <div class="field"><span class="f-lb"><span>人设文件</span></span>
        <div class="psn-readonly mono">${esc(file || '（未设置，只用结构化人设）')}</div>
        <span class="hint">只读展示；改路径请编辑 config.json 的 persona.file。文件正文会在运行时并入人物设定段。</span></div>
      <div class="switch-row" style="align-self:end;padding-bottom:2px">
        <div class="switch-copy"><b>改人设后丢弃旧发言</b><span>关掉时，模型会先照旧口吻说几句，像没改成功。</span></div>
        ${psnSwitch({ id: 'p.reset', bind: 'personaResetOnChange', label: '改人设后丢弃旧发言' })}
      </div>
    </div>
    <div class="card-foot"><span class="hint">文件 + 字段都进提示词；字段优先。</span><span class="chip ok"><span class="dot"></span>${psnFmt(pr?.chars || 0)} 字</span></div>
  </div>`;
  const status = `<div class="card fill span-4">
    <div class="card-head"><div class="card-head-main"><div class="card-title">当前状态</div><div class="card-sub">每轮注入，可随时手改。</div></div><span class="chip accent">实时</span></div>
    ${psnField({ id: 'p.status', bind: 'persona.status', label: '现在在哪、想做什么、情绪如何', area: true, rows: 3, maxH: 200 })}
    <div class="notice" style="margin-top:12px"><span>这里手写；心情值由项目本体更新。两者都会进提示词。</span></div>
    <div class="card-foot"><span class="hint">手动维护</span><span class="chip plain">每轮注入</span></div>
  </div>`;
  const preview = `<div class="card fill span-8">
    <div class="card-head"><div class="card-head-main"><div class="card-title">这一层写进提示词的样子</div><div class="card-sub">只读；随字段更新。</div></div><button class="card-link" type="button" data-go="persona/prompt">完整提示词 →</button></div>
    <div class="code-block" style="max-height:250px;overflow:auto">${esc(pr?.text || '（人物设定还是空的）')}</div>
  </div>`;
  const map = `<div class="card fill span-4">
    <div class="card-head"><div class="card-head-main"><div class="card-title">字段怎么起作用</div><div class="card-sub">字段的实际作用。</div></div></div>
    <div class="mini-list">
      <div class="row"><span>身份 / 世界</span><b>举例与用词</b></div>
      <div class="row"><span>欲望 / 恐惧</span><b>行为驱动</b></div>
      <div class="row"><span>性格 / 语气 / 口头禅</span><b>说话手感</b></div>
      <div class="row"><span>行为逻辑</span><b>遇事怎么选</b></div>
      <div class="row"><span>当前状态</span><b>这一轮的心情底色</b></div>
      <div class="row"><span>人设文件</span><b>不随工作台变的底子</b></div>
    </div>
    <div class="card-foot"><span class="hint">冲突时：结构化字段 > 人设文件 > MBTI > 增强项 > 心情值</span></div>
  </div>`;
  return `<div class="psn" data-psn-page="profile">
    ${psnPageHead([
      psnChip(`<b>${psnPersonaFilled()}/12</b> 字段`, 'ok'),
      psnChip('最高优先'),
      psnChip(`<b>${psnFmt(pr?.chars || 0)}</b> 字`, 'accent'),
    ])}
    <div class="span-12"><div class="grid persona-top">${identity}${drive}${voice}</div></div>
    ${psnBirthdayCard()}
    <div class="span-12"><div class="grid persona-bottom"><div class="span-8 persona-col persona-col-left">${logic}${preview}</div><div class="span-4 persona-col persona-col-right">${status}${map}</div></div></div>
  </div>`;
}

/* ── ③ MBTI ─────────────────────────────────────────────────────────── */
function psnAxisReadsHtml(axes) {
  const meta = psnAxisMeta();
  const reads = {
    EI: { E: '从人群里充电，先说出来再想', I: '独处回血，先观察再开口' },
    SN: { S: '先看事实、细节和已经发生的事', N: '先看弦外之音、可能性和走向' },
    TF: { T: '先讲对错、逻辑和可执行的那一步', F: '先照顾感受、关系和气氛' },
    JP: { J: '喜欢有结论、有落点，答应就做到', P: '保留弹性，边走边看，临时改也行' },
  };
  const names = { EI: '能量来源', SN: '信息偏好', TF: '决策依据', JP: '生活方式' };
  return `<div class="axis-read-grid">${meta.map((axis) => {
    const v = Number(axes[axis.id]) || 0;
    const right = v >= 50;
    const letter = right ? axis.right : axis.left;
    const pct = right ? v : 100 - v;
    return `<div class="axis-read" data-axis-read="${axis.id}">
      <div class="axis-read-head"><span>${names[axis.id] || axis.id}</span><b>${letter} ${Math.round(pct)}%</b></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="axis-read-txt">${esc((reads[axis.id] || {})[letter] || '')}</div></div>`;
  }).join('')}</div>`;
}

function psnAxisRows(axes) {
  const meta = psnAxisMeta();
  return `<div class="axis-list">${meta.map((axis) => {
    const v = Number(axes[axis.id]) || 0;
    const right = v >= 50;
    S.reg.set(`mbti.axis.${axis.id}`, { id: `mbti.axis.${axis.id}`, bind: `mbti.axes.${axis.id}`, t: 'range' });
    return `<div class="axis" data-axis-row="${axis.id}">
      <div class="axis-head"><span><b class="${right ? 'dim' : ''}">${axis.left}</b> <span class="${right ? 'dim' : ''}">${axis.leftName}</span> ${100 - v}%</span><span><b class="${right ? '' : 'dim'}">${axis.right}</b> <span class="${right ? '' : 'dim'}">${axis.rightName}</span> ${v}%</span></div>
      <div class="axis-slider">
        <div class="axis-track"></div><div class="axis-fill" style="width:${v}%"></div><div class="axis-mid"></div><div class="axis-knob" style="left:${v}%"></div>
        <input class="range" type="range" min="0" max="100" step="1" value="${v}" data-psn-axis="${axis.id}" aria-label="${esc(`${axis.leftName}与${axis.rightName}`)}" aria-valuetext="${esc(v >= 50 ? `${axis.right} ${axis.rightName} ${v}%` : `${axis.left} ${axis.leftName} ${100 - v}%`)}">
      </div></div>`;
  }).join('')}</div>`;
}

function psnTypeGrid(axes) {
  const cur = psnTypeFromAxes(axes);
  const types = psnTypeTable();
  return `<div class="mbti-grid">${Object.entries(types).map(([code, info]) => `
    <button class="type-cell" type="button" data-a="psn.type" data-p="${esc(code)}" aria-pressed="${code === cur}" style="${psnTypeVars(code)}">
      <b>${code}</b><span class="type-name">${esc(info.name)}</span><span class="type-ghost" aria-hidden="true">${code}</span>
    </button>`).join('')}</div>`;
}

/* 16Personalities 的官方场景图不能随包分发；这里用本地 SVG 画一张
   与原布局同形的抽象场景：远山、树、星光与人物剪影，颜色跟着类型走。
   生成的图案由类型代码决定，同一类型每次刷新都是同一张。 */
function psnTypeScene(code) {
  const seedOf = (s) => Array.from(String(s || '')).reduce((h, ch) => ((h * 31 + ch.charCodeAt(0)) >>> 0), 7);
  const seed = seedOf(code);
  const rnd = (i) => {
    let x = (seed + (i + 1) * 2654435761) >>> 0;
    x ^= x >>> 13;
    x = Math.imul(x, 1274126177) >>> 0;
    return (x >>> 8) / 16777216;
  };
  const hill = (layer) => {
    const base = 286 + layer * 16;
    const pts = [];
    for (let i = 0; i <= 7; i += 1) {
      pts.push(`${i * 130},${Math.round(base - 18 - rnd(layer * 15 + i) * (64 - layer * 12))}`);
    }
    return `<polygon points="0,360 ${pts.join(' ')} 910,360" fill="currentColor" opacity="${(0.08 + layer * 0.07).toFixed(2)}"/>`;
  };
  const tree = (x, h, i) => `<g fill="currentColor" opacity="${(0.24 + rnd(60 + i) * 0.25).toFixed(2)}">
    <rect x="${x - 2}" y="${324 - h * 0.28}" width="4" height="${h * 0.34}" rx="1"/>
    <polygon points="${x},${324 - h} ${x - h * 0.28},${324 - h * 0.18} ${x + h * 0.28},${324 - h * 0.18}"/>
    <polygon points="${x},${324 - h * 0.78} ${x - h * 0.24},${324 - h * 0.05} ${x + h * 0.24},${324 - h * 0.05}"/>
  </g>`;
  const stars = Array.from({ length: 14 }, (_, i) => {
    const x = 30 + rnd(100 + i) * 840;
    const y = 24 + rnd(140 + i) * 130;
    const r = 0.8 + rnd(180 + i) * 1.8;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="currentColor" opacity="${(0.18 + rnd(220 + i) * 0.4).toFixed(2)}"/>`;
  }).join('');
  const trees = [[74, 56], [136, 36], [352, 44], [706, 60], [806, 36], [856, 48]]
    .map(([x, h], i) => tree(x, h, i)).join('');
  return `<svg class="psn-art-svg" viewBox="0 0 910 360" role="img" aria-label="${esc(code)} 类型场景图">
    <title>${esc(code)} · 本地几何场景</title>
    <rect width="910" height="360" fill="currentColor" opacity=".10"/>
    <circle cx="760" cy="76" r="54" fill="currentColor" opacity=".16"/>
    <circle cx="760" cy="76" r="34" fill="currentColor" opacity=".2"/>
    ${stars}
    ${hill(0)}${hill(1)}${hill(2)}
    <path d="M0 322 Q220 306 455 322 T910 318 L910 360 L0 360 Z" fill="currentColor" opacity=".30"/>
    ${trees}
    <g fill="currentColor" opacity=".58">
      <circle cx="204" cy="214" r="19"/>
      <path d="M186 236 Q204 224 222 236 L232 320 L176 320 Z"/>
      <path d="M176 252 Q146 264 138 284 L150 290 Q164 270 186 264 Z"/>
      <path d="M222 252 Q254 258 268 276 L258 286 Q242 268 218 262 Z"/>
    </g>
    <g fill="currentColor">
      <circle cx="280" cy="244" r="24" opacity=".14"/>
      <circle cx="280" cy="244" r="10" opacity=".5"/>
    </g>
    <text x="565" y="282" text-anchor="middle" font-size="168" font-weight="700" letter-spacing="10"
      fill="currentColor" opacity=".11" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif">${esc(code)}</text>
  </svg>`;
}

function psnMbtiSnippetText(type, summary, on) {
  return `## MBTI 辅助\n${type} · ${summary}\n${on ? '已注入 · 只当表达倾向' : '未注入 · 这一段不会出现'}`;
}

function psnMbtiHtml() {
  const saved = psnMbti();
  const axes = {};
  for (const axis of psnAxisMeta()) axes[axis.id] = Number(psnVal(`mbti.axes.${axis.id}`, saved.axes?.[axis.id] ?? 50)) || 0;
  const type = psnTypeFromAxes(axes);
  const types = psnTypeTable();
  const info = types[type] || { name: '', tag: '', traits: [] };
  const summary = psnAxisSummary(axes);
  const on = psnBool('mbti.on', false);
  const note = String(psnVal('mbti.note', '') || '');
  const sect = psnSection('mbti');
  const vars = psnTypeVars(type);
  const hero = `<div class="card psn-mbti-hero span-12" data-psn-hero style="${vars}">
    <button class="mbti-art" id="mbtiArt" type="button" data-a="psn.art" aria-label="查看 ${type} ${esc(info.name)} 官方场景大图">
      <span class="psn-art-scene" data-psn-art-scene>${psnTypeScene(type)}</span>
      <img class="mbti-art-img" src="${PSN_ART[type] || ''}" alt="16Personalities 官方 ${type} ${esc(info.name)} 场景图" data-art-type="${type}">
      <span class="mbti-art-tag" data-psn-art-label>${type} · ${esc(info.name)}</span>
      <span class="mbti-art-zoom">看大图 ↗</span>
    </button>
    <div class="mbti-art-info">
      <div class="mbti-art-eyebrow">官方形象 · 16Personalities</div>
      <h2 class="mbti-art-title">每一种类型，都有一张自己的场景</h2>
      <p class="mbti-art-desc">选择下方的任一类型，图片会切换到对应的官方场景；点图片或「看大图」可放大。</p>
      <div class="mbti-art-actions"><button class="btn small" type="button" data-a="psn.art">看大图</button></div>
      <span class="mbti-art-source">图源 16Personalities</span>
    </div>
  </div>`;
  const matrix = `<div class="card fill mbti-matrix span-7" style="${vars}">
    <div class="card-head"><div class="card-head-main"><div class="card-title">16 型矩阵</div><div class="card-sub">点类型对齐四轴，或直接拖轴。</div></div><span class="chip">辅助层</span></div>
    ${psnTypeGrid(axes)}
    ${psnAxisRows(axes)}
    <div class="card-foot"><span class="hint">50% 附近 = 倾向弱；不是能力量表。</span><span class="chip plain">四轴</span></div>
  </div>`;
  const current = `<div class="card fill mbti-current-card span-5" style="${vars}">
    <div class="card-head"><div class="card-head-main"><div class="card-title">当前类型</div><div class="card-sub">提示词里只占一小段。</div></div>
      ${psnSwitch({ id: 'mbti.on2', bind: 'mbti.on', label: '把 MBTI 写进提示词' })}</div>
    <div class="mbti-code-row"><div class="mbti-code" data-psn-type-code2>${type}</div><div class="mbti-name" data-psn-type-name2>${esc(info.name)}</div></div>
    <div class="mbti-tag" data-psn-type-tag2>${esc(info.tag)}</div>
    <div class="mbti-traits chip-row" data-psn-type-traits2>${(info.traits || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
    <div class="divider"></div>
    ${psnField({ id: 'mbti.note', bind: 'mbti.note', label: '个人差异补充', area: true, rows: 3, maxH: 160, hint: '写它和类型不一样的地方。' })}
    <div class="subhead"><span>写进提示词的片段</span><span class="chip ${on ? 'accent' : 'warn'}">${on ? '注入开' : '注入关'}</span></div>
    <div class="mbti-snippet" data-psn-mbti-snippet>${esc(psnMbtiSnippetText(type, summary, on))}</div>
    <div class="subhead"><span>四轴读法</span><span class="chip plain">辅助</span></div>
    <div data-psn-axis-reads>${psnAxisReadsHtml(axes)}</div>
    <div class="card-foot"><span class="hint">${on ? '它与人物设定冲突时，人物设定优先。' : '关闭后这一段完全不进提示词。'}</span></div>
  </div>`;
  const boundary = `<div class="card span-12">
    <div class="card-head"><div class="card-head-main"><div class="card-title">使用边界</div><div class="card-sub">辅助框架，不是行为许可证。</div></div><span class="chip plain">只做辅助</span></div>
    <div class="boundary-grid">
      <div class="boundary"><span class="mark">01</span><div><b>人设定义优先</b><span>冲突时以「人设」页为准；MBTI 不覆盖它。</span></div></div>
      <div class="boundary"><span class="mark">02</span><div><b>不做刻板印象</b><span>不用类型解释自己，也不把类型挂在嘴边。</span></div></div>
      <div class="boundary"><span class="mark">03</span><div><b>允许不典型</b><span>个人差异补充可以推翻类型的典型描述。</span></div></div>
      <div class="boundary"><span class="mark">04</span><div><b>随时可关闭</b><span>关闭后这一段完全不进提示词，不影响其他层。</span></div></div>
    </div>
  </div>`;
  return `<div class="psn" data-psn-page="mbti">${psnPageHead([
    `<span class="meta-chip type-tint" data-psn-type-chip-wrap style="${vars}"><span data-psn-type-chip>${type}</span> · ${esc(info.name)}</span>`,
    psnChip('四轴'),
    psnChip(`<b>${on ? psnFmt(sect?.chars || 0) : 0}</b> 字`, on ? 'accent' : 'warn'),
  ])}${hero}<div class="span-12"><div class="grid mbti-top">${matrix}${current}</div></div>${boundary}</div>`;
}

/* ── ④ 增强项 ───────────────────────────────────────────────────────── */
function psnHasDraftPath(path) {
  return Object.prototype.hasOwnProperty.call(S.draft.custom || {}, path);
}
function psnRulesForEdit() {
  const d = S.draft.custom.playRuleItems;
  if (Array.isArray(d)) return d;
  // 草稿里显式写 null = 用户点了「恢复默认」：显示默认 10 条，
  // 而不是显示已保存的那份自定义列表。
  if (psnHasDraftPath('playRuleItems') && d === null) {
    return (psnMeta().defaultPlayRules || []).map((r) => ({ ...r }));
  }
  const saved = psnCustom().playRuleItems;
  if (Array.isArray(saved)) return saved;
  return psnMeta().playRules || [];
}
function psnRulesCount() {
  return psnRulesForEdit().filter((r) => String(r?.text || '').trim()).length;
}
function psnRulesTouch() {
  touchC('playRuleItems');
  markDirty();
}
function psnRulesEnsureDraft() {
  if (!Array.isArray(S.draft.custom.playRuleItems)) {
    S.draft.custom.playRuleItems = psnRulesForEdit().map((r) => ({ ...r }));
  }
  return S.draft.custom.playRuleItems;
}
function psnRulesBeginEdit() {
  if (!psnHasDraftPath('playRuleItems')) {
    S.draft.custom.playRuleItems = psnRulesForEdit().map((r) => ({ ...r }));
  }
  S.extra.psnRulesEdit = true;
  paintPage(false);
}

function psnEnhanceHtml() {
  const meta = j(psnMeta(), ['enhance'], {}) || {};
  const table = meta.table || {};
  const groups = psnEnhanceGroups();
  const filled = psnEnhanceFilled();
  const total = psnEnhanceChars();
  const groupsHtml = groups.map((g, gi) => {
    const count = g.keys.filter((k) => String(psnEnhance()[k] || '').trim()).length;
    return `<div class="enh-group">
      <div class="enh-group-head"><span class="g-no">0${gi + 1}</span><h3>${esc(g.label)}</h3><span class="g-count">${count}/${g.keys.length}</span></div>
      <div class="enh-fields">${g.keys.map((k) => {
        const f = table[k] || { label: k };
        const span = PSN_ENH_SPAN[k] || 3;
        const rows = PSN_ENH_ROWS[k] || 2;
        return `<div class="enh-field span-${span}">${psnField({
          id: `enh.${k}`, bind: `enhance.${k}`, label: f.label || k, area: true, rows,
          maxH: span === 6 ? 280 : 220, help: f.hint || '',
        })}</div>`;
      }).join('')}</div></div>`;
  }).join('');
  const card = `<div class="card span-12">
    <div class="card-head"><div class="card-head-main"><div class="card-title">12 项细节</div><div class="card-sub">12 项都可留空；填了才进提示词。</div></div><span class="chip accent">可留空</span></div>
    <div class="enh-summary"><span class="hint"><b>${filled}/12</b> 已填</span><div class="bar"><i style="width:${Math.min(100, total / 3000 * 100)}%"></i></div><span class="hint">${psnFmt(total)} / 3,000 字</span></div>
    ${groupsHtml || '<div class="empty">后端没下发增强项定义（customMeta.enhance 为空）。</div>'}
  </div>`;
  const rules = psnRulesForEdit();
  const playOn = psnBool('playRules', true);
  const rulesEdit = !!S.extra.psnRulesEdit;
  const activeRules = psnRulesCount();
  const rulesBody = rulesEdit
    ? `<div class="rules-edit-list">${rules.map((r, i) => `
        <div class="rule-edit-row">
          <span class="rule-num">${String(i + 1).padStart(2, '0')}</span>
          <textarea class="input" data-psn-rule-index="${i}" data-psn-auto data-max-h="120" rows="2" aria-label="第 ${i + 1} 条扮演规则" placeholder="留空会被忽略">${esc(r.text || '')}</textarea>
          ${r.safety ? '<span class="chip warn">边界</span>' : ''}
          <button class="rule-del" type="button" data-a="psn.rules.del" data-p="${i}" aria-label="删除第 ${i + 1} 条规则">×</button>
        </div>`).join('') || '<div class="empty">还没有规则；下面可以添加一条。</div>'}</div>
      <div class="rule-edit-foot"><button class="linklike" type="button" data-a="psn.rules.add">+ 添加一条</button><button class="linklike" type="button" data-a="psn.rules.reset">恢复默认 10 条</button></div>`
    : `<div class="rules-grid">${rules.map((r) => `<div class="rule-row ${r.safety ? 'safety' : ''}"><span class="ri">${r.safety ? '!' : '·'}</span><span>${esc(r.text)}</span>${r.safety ? '<span class="rs chip warn">边界</span>' : ''}</div>`).join('') || '<div class="empty">还没有规则；点右上角 ! 添加。</div>'}</div>`;
  const rulesCard = `<div class="card fill span-7">
    <div class="card-head"><div class="card-head-main"><div class="card-title">扮演规则</div><div class="card-sub">${rulesEdit ? '直接改文字；空行会被忽略。' : '底层约束，任何情况下成立。'}</div></div>
      <div class="card-actions">${rulesEdit
        ? '<span class="lock-chip">编辑中</span><button class="linklike" type="button" data-a="psn.rules.lock">锁定</button>'
        : '<button class="unlock-btn" type="button" data-a="psn.rules.unlock" aria-label="解锁编辑扮演规则" title="编辑扮演规则">!</button>'}${psnSwitch({ id: 'pr.on', bind: 'playRules', label: '把扮演规则写进提示词' })}</div></div>
    ${rulesBody}
    <div class="card-foot"><span class="hint">${playOn ? `这 <b>${activeRules}</b> 条会作为固定段进提示词。` : '已关闭：模型没有这些约束了。'}${rulesEdit ? '' : ' · 点右上角 ! 可编辑'}</span><span class="chip ${playOn ? 'ok' : 'warn'}">${playOn ? '注入开' : '注入关'}</span></div>
  </div>`;
  const budget = `<div class="card fill span-5">
    <div class="card-head"><div class="card-head-main"><div class="card-title">增强项预算</div><div class="card-sub">细节不该盖过人格。</div></div><span class="chip">3,000</span></div>
    <div class="bar" style="height:8px"><i style="width:${Math.min(100, total / 3000 * 100)}%"></i></div>
    <div class="mini-list" style="margin-top:8px"><div class="row"><span>当前已填</span><b>${psnFmt(total)} 字</b></div><div class="row"><span>剩余</span><b>${psnFmt(Math.max(0, 3000 - total))} 字</b></div></div>
    <ul class="budget-list" style="margin:12px 0 0;padding:0;list-style:none">
      <li><span class="bi"></span><span><b>留空不占字数。</b>12 项都可只写一两项。</span></li>
      <li><span class="bi"></span><span><b>裁撤顺序。</b>预算吃紧时，先裁背景消息 / 技能 / 记忆 / 场景，再裁增强项；扮演规则与人格定义更晚。</span></li>
      <li><span class="bi"></span><span><b>不要复述。</b>这些是给模型“照着演”的，不是让它背出来。</span></li>
    </ul>
    <div class="card-foot"><span class="hint">只算已填项。</span><span class="chip accent">${filled}/12</span></div>
  </div>`;
  return `<div class="psn" data-psn-page="enhance">${psnPageHead([
    psnChip(`<b>${filled}/12</b>`, 'ok'),
    psnChip(`<b>${psnFmt(total)}</b> 字`, 'accent'),
    psnChip('留空不进'),
  ])}${card}${rulesCard}${budget}</div>`;
}

/* ── ⑤ 心情值 ───────────────────────────────────────────────────────── */
function psnEmotionBarItem(k, label, group, value, max, idx, groupStart, color) {
  const h = value ? (value / max) * 100 : 0;
  return `<div class="emo-bar-item${value ? '' : ' is-zero'}${groupStart ? ' group-start' : ''}" style="--ec:${color};--i:${idx}" data-tip="emotion" data-tip-title="${esc(label)}" data-tip-value="${value ? `${value} / 100` : '未触发'}" data-tip-sub="${esc(group)}情绪 · ${value ? '强度 ' + value : '此刻为 0'}" data-tip-color="${color}">
    <div class="emo-bar-plot"><div class="emo-bar-fill" style="--h:${h.toFixed(2)}%">${value ? `<span class="emo-bar-val">${value}</span>` : ''}</div></div>
    <span class="emo-bar-label">${esc(label)}</span></div>`;
}

function psnMoodHtml() {
  const e = psnEmotion();
  const ok = e.ok === true;
  if (!ok) {
    const missing = e.missing === true;
    return `<div class="psn" data-psn-page="mood">${psnPageHead([psnChip('本体情绪 · 未建立', 'warn'), psnChip('不占提示词')])}
      <div class="span-12"><div class="grid"><div class="card span-8"><div class="empty-state">
        <div class="empty-icon">—</div><h2>${missing ? '机器人还没建立状态' : '情绪状态暂时读不到'}</h2>
        <p>${missing
          ? '不需要安装任何插件：机器人启动时会自动创建 <code>data/bot-state.json</code>，跑一轮之后这里就是真实数字。'
          : '状态文件在，但这次没读成功。点「刷新」再读一次；仍失败再看下面的原因。'}</p>
        <p class="hint">${esc(e.reason || '还没有状态文件')}</p>
        <div class="empty-actions"><button class="btn small primary" type="button" data-go="run/overview">去运行页</button><button class="btn small" type="button" data-a="psn.mood.refresh">刷新</button></div>
      </div></div>
      <div class="card span-4"><div class="card-head"><div class="card-head-main"><div class="card-title">数据源</div><div class="card-sub">项目本体维护，不依赖插件。</div></div><span class="chip warn">未建立</span></div>
        <div class="mini-list"><div class="row"><span>来源</span><b>项目内建</b></div><div class="row"><span>文件</span><b class="mono">data/bot-state.json</b></div><div class="row"><span>写入</span><b>每轮回复后</b></div><div class="row"><span>读取</span><b>面板直接读</b></div></div>
        <div class="notice" style="margin-top:12px"><span>心情值只影响语气。没有它，人设、MBTI、增强项照常工作。</span></div>
        <div class="card-foot"><span class="hint">启动机器人后，这里会变成实时快照。</span></div></div></div></div>
    </div>`;
  }
  const energy = e.energy || {};
  const energyPairs = [['身体', energy.physical], ['认知', energy.cognitive], ['情绪', energy.emotional], ['意志', energy.will]];
  const hasEnergy = energyPairs.every(([, v]) => Number.isFinite(Number(v)));
  const top = Array.isArray(e.spectrum) ? e.spectrum.filter(([, v]) => Number(v) > 0).sort((a, b) => b[1] - a[1]).slice(0, 3) : [];
  const labels = Object.fromEntries(psnEmoGroups().flatMap((g) => g.items));
  const tone = psnMoodTone(e.mood);
  const moodSec = psnSection('mood');
  const moodOn = psnBool('moodOn', true);
  const moodText = moodSec?.enabled
    ? (moodSec.text || moodSec.autoText || '')
    : (moodSec?.autoText || '');
  const prevMood = Array.isArray(e.trend) && e.trend.length > 1 ? e.trend[e.trend.length - 2] : e.mood;
  const moodDelta = Number(e.mood) - Number(prevMood);
  const here = `<div class="card fill span-4">
    <div class="card-head"><div class="card-head-main"><div class="card-title">此刻的心情</div><div class="card-sub">只影响这一轮语气。</div></div><span class="chip accent">实时</span></div>
    <div class="mood-hero"><span class="mood-num">${e.mood ?? '—'}</span><span class="mood-den">/ 100</span><span class="mood-label"><span class="legend-dot" style="--lc:${tone}"></span>${psnMoodLabel(e.mood)}</span></div>
    <div class="mood-scale" style="--mood-color:${tone}"><span class="mood-fill" style="width:${Math.max(0, Math.min(100, Number(e.mood) || 0))}%"></span><span class="mood-knob" style="left:${Math.max(0, Math.min(100, Number(e.mood) || 0))}%"></span></div>
    <div class="scale-labels"><span>0</span><span>50</span><span>100</span></div>
    <div class="metric-grid" style="margin-top:12px">
      <div class="metric"><b>${e.arousal ?? '—'}</b><span>唤醒度</span></div>
      <div class="metric"><b>${e.acuteStress ?? '—'}</b><span>急性压力</span></div>
      <div class="metric"><b>${e.chronicStress != null ? Number(e.chronicStress).toFixed(1) : '—'}</b><span>慢性压力</span></div>
    </div>
    <div class="divider"></div>
    <div class="mini-list"><div class="row"><span>主导情绪</span><b>${top.map(([k, v]) => `${labels[k] || k} ${v}`).join(' · ') || '—'}</b></div><div class="row"><span>较上次</span><b>${moodDelta >= 0 ? '+' : ''}${Math.round(moodDelta * 10) / 10}</b></div><div class="row"><span>非零项</span><b>${Array.isArray(e.spectrum) ? e.spectrum.filter(([, v]) => Number(v) > 0).length : '—'} / 21</b></div></div>
    ${e.intent ? `<div class="notice" style="margin-top:10px"><span><b>此刻的意图</b>：${esc(e.intent)}</span></div>` : ''}
    <div class="card-foot"><span class="hint">${e.updatedAt ? `更新于 ${new Date(e.updatedAt).toLocaleString()}` : '每轮更新'}</span><span class="chip plain">本体写入</span></div>
  </div>`;
  const trendVals = Array.isArray(e.trend) ? e.trend : [];
  const trend = `<div class="card fill span-4">
    <div class="card-head"><div class="card-head-main"><div class="card-title">近 24 小时</div><div class="card-sub">只看走向，不猜原因。</div></div><span class="chip plain">${trendVals.length ? `每 10 分钟 · ${trendVals.length} 个采样` : '无历史'}</span></div>
    ${trendVals.length >= 2
      ? `<div class="trend"><div class="trend-line"><span>50</span></div>${trendVals.map((v, i) => `<div class="trend-b${i === trendVals.length - 1 ? ' now' : ''}" style="height:${Math.max(6, v)}%" data-v="${v}" title="${i === trendVals.length - 1 ? '现在' : `${(trendVals.length - 1 - i) * 10} 分钟前`} · ${v}"></div>`).join('')}</div>
         <div class="trend-x"><span>最早</span><span>中段</span><span>现在</span></div>
         <div class="mini-list" style="margin-top:10px"><div class="row"><span>变化</span><b>${Number(e.mood) - trendVals[0] >= 0 ? '+' : ''}${Math.round((Number(e.mood) - trendVals[0]) * 10) / 10}</b></div><div class="row"><span>区间</span><b>${Math.min(...trendVals)} → ${Math.max(...trendVals)}</b></div></div>`
      : `<div class="chart-empty"><span class="dash">—</span><p>再跑几轮、跨过一个采样间隔后，这里会出现真实曲线。</p></div>`}
    <div class="card-foot"><span class="hint">现在是 <b>${e.mood ?? '—'}</b></span><span class="chip accent">${top.map(([k, v]) => `${labels[k] || k} ${v}`).join(' · ') || '—'}</span></div>
  </div>`;
  const energyCard = `<div class="card fill span-4">
    <div class="card-head"><div class="card-head-main"><div class="card-title">精力</div><div class="card-sub">每轮更新；低精力先影响语气。</div></div><span class="chip">4 项</span></div>
    ${hasEnergy ? `<div class="stack">${energyPairs.map(([label, v]) => `<div class="energy-row"><div class="energy-head"><span>${label}</span><b>${v}</b></div><div class="bar"><i style="width:${Math.max(0, Math.min(100, Number(v)))}%;background:var(--chart-3)"></i></div></div>`).join('')}</div>` : '<div class="empty">状态里没有精力四项。</div>'}
    <div class="notice" style="margin-top:12px"><span>这四项是项目本体维护的状态值，不是“它现在有多努力”。</span></div>
    <div class="mini-list" style="margin-top:10px">${hasEnergy ? `<div class="row"><span>最高</span><b>${energyPairs.slice().sort((a, b) => b[1] - a[1])[0].join(' ')}</b></div><div class="row"><span>最低</span><b>${energyPairs.slice().sort((a, b) => a[1] - b[1])[0].join(' ')}</b></div>` : ''}</div>
    <div class="card-foot"><span class="hint">${hasEnergy ? `${energyPairs.reduce((n, [, v]) => n + Number(v), 0)} / 400 合计` : '—'}</span><span class="chip plain">每轮更新</span></div>
  </div>`;
  const spectrum = psnSpectrum();
  const allZero = !spectrum || spectrum.every(([, v]) => !(Number(v) > 0));
  let emoHeads = '';
  let emoBars = '';
  if (spectrum) {
    const map = Object.fromEntries(spectrum);
    const groups = psnEmoGroups();
    const max = Math.max(1, ...spectrum.map(([, v]) => Number(v) || 0));
    emoHeads = groups.map((g) => {
      const nz = g.items.filter(([k]) => Number(map[k]) > 0).length;
      const color = g.label === '正向' ? 'var(--chart-3)' : g.label === '中性' ? 'var(--chart-neutral)' : 'var(--chart-5)';
      return `<div class="emo-group-head" style="grid-column:span ${g.items.length};--ec:${color}"><span class="legend-dot" style="--lc:${color}"></span><b>${g.label}</b><span>${nz} 项非零</span></div>`;
    }).join('');
    let idx = 0;
    emoBars = groups.map((g) => g.items.map(([k, label], itemIndex) => {
      const color = g.label === '正向' ? 'var(--chart-3)' : g.label === '中性' ? 'var(--chart-neutral)' : 'var(--chart-5)';
      const v = Number(map[k]) || 0;
      const html = psnEmotionBarItem(k, label, g.label, v, max, idx, itemIndex === 0 && g.label !== '正向', color);
      idx += 1;
      return html;
    }).join('')).join('');
  }
  const emotions = `<div class="card fill span-7${allZero ? ' is-empty' : ''}">
    <div class="card-head"><div class="card-head-main"><div class="card-title">21 项情绪</div><div class="card-sub">全部摆出；0 也保留。</div></div><span class="chip">此刻</span></div>
    ${spectrum ? `<div class="emo-spectrum${allZero ? ' is-empty' : ''}"><div class="emo-group-heads">${emoHeads}</div><div class="emo-bars">${emoBars}</div></div>` : '<div class="empty">状态里没有情绪键。</div>'}
    ${allZero ? '<div class="chart-empty"><span class="dash">—</span><p>还没有触发任何情绪；每项都从 0 开始，聊几轮后柱高才会出现。</p></div>' : ''}
    <div class="card-foot"><span class="hint">键名来自项目内建的情绪表；认不出的键照实显示。</span><span class="chip accent">好奇 ${spectrum ? (Object.fromEntries(spectrum).curiosity ?? 0) : '—'}</span></div>
  </div>`;
  const inject = `<div class="card fill span-5">
    <div class="card-head"><div class="card-head-main"><div class="card-title">心情如何进入提示词</div><div class="card-sub">插在增强项之后。</div></div>
      <div class="card-actions"><span class="chip ${moodOn ? 'ok' : 'warn'}">${moodOn ? '注入开' : '注入关'}</span>${psnSwitch({ id: 'mood.on', bind: 'moodOn', label: '把心情值写进提示词' })}</div></div>
    <div class="code-block" style="max-height:220px;overflow:auto">${esc(moodText || '状态段为空：还没有可注入的心情。')}</div>
    <div class="switch-row" style="margin-top:12px"><div class="switch-copy"><b>立即刷新</b><span>重新读一次状态文件。</span></div><button class="btn small" type="button" data-a="psn.mood.refresh">刷新</button></div>
    <div class="mini-list" style="margin-top:10px"><div class="row"><span>注入位置</span><b>增强项之后</b></div><div class="row"><span>本段字数</span><b>${psnFmt(psnLen(moodText))}</b></div><div class="row"><span>关闭后</span><b>省 ${psnFmt(psnLen(moodText))} 字</b></div></div>
    <div class="card-foot"><span class="hint">${moodOn ? '实时段，不命中缓存。' : '已关闭：不占提示词。'}</span><span class="chip plain">本体写入</span></div>
  </div>`;
  const ev = e.lastEvent;
  const event = `<div class="card fill span-7 event-card">
    <div class="card-head"><div class="card-head-main"><div class="card-title">上一次移动它的事件</div><div class="card-sub">状态变化的来源。</div></div><span class="chip">${esc(ev?.kind || '—')}</span></div>
    ${ev ? `<div class="event"><div class="event-mark"><span class="event-dot"></span></div><div class="event-body"><b>${esc(ev.note || '—')}</b><p>意图：${esc(e.intent || '—')}</p><div class="event-meta"><span class="chip plain">${ev.at ? new Date(ev.at).toLocaleString() : '—'}</span>${ev.chatKey ? `<span class="chip plain mono">${esc(ev.chatKey)}</span>` : ''}</div></div></div>` : '<div class="empty">还没有值得记录的事件；跑几轮后这里会出现。</div>'}
    <div class="card-foot"><span class="hint">下一轮更新。</span><span class="chip ok"><span class="dot"></span>本体状态 · 运行中</span></div>
  </div>`;
  const source = `<div class="card fill span-5 source-card">
    <div class="card-head"><div class="card-head-main"><div class="card-title">数据源</div><div class="card-sub">直接读盘，不依赖机器人进程。</div></div><span class="chip ok">在线</span></div>
    <div class="mini-list"><div class="row"><span>来源</span><b>项目内建</b></div><div class="row"><span>文件</span><b class="mono">data/bot-state.json</b></div><div class="row"><span>写入时机</span><b>每轮回复后</b></div><div class="row"><span>读取方式</span><b>面板直接读</b></div></div>
    <div class="card-foot"><span class="hint">机器人没在跑时也可以看。</span><span class="chip plain">只读</span></div>
  </div>`;
  return `<div class="psn" data-psn-page="mood">${psnPageHead([
    psnChip('<span class="dot"></span>本体情绪', 'ok'),
    psnChip(`<b>更新于</b> ${esc(e.updatedAt ? new Date(e.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—')}`),
    psnChip(`注入 <b>${moodOn ? '开' : '关'}</b>`),
  ])}<div class="span-12"><div class="grid mood-top">${here}${trend}${energyCard}</div></div><div class="span-12"><div class="grid mood-mid">${emotions}${inject}</div></div><div class="span-12"><div class="grid mood-bottom">${event}${source}</div></div></div>`;
}

/* ── ⑥ 系统提示词 ───────────────────────────────────────────────────── */
function psnPromptLayerColor(layer) {
  return layer >= 1 && layer <= 4 ? `var(--layer-${layer})` : 'var(--layer-other)';
}
function psnPromptLayerTag(layer) {
  return layer >= 1 && layer <= 4 ? `第 ${layer} 层` : '固定段';
}
function psnPromptBuf() {
  if (!S.extra.psnPromptBuf) S.extra.psnPromptBuf = {};
  return S.extra.psnPromptBuf;
}
function psnPromptBeginEdit() {
  const buf = {};
  for (const sec of psnSections()) {
    if (!PSN_EDITABLE.includes(sec.id) || !sec.enabled) continue;
    buf[sec.id] = sec.unknownChars ? '' : sec.text;
  }
  S.extra.psnPromptBuf = buf;
  S.extra.psnPromptEdit = true;
  paintPage(false);
}

function psnPromptPlainText() {
  const parts = [];
  for (const sec of psnSections()) {
    if (!sec.enabled) continue;
    if (sec.unknownChars) {
      parts.push(`## ${sec.name}\n（运行时按会话生成；面板拿不到具体文本）`);
      continue;
    }
    parts.push(sec.text);
  }
  return parts.join('\n\n');
}

function psnPromptHtml() {
  const all = psnSections();
  const active = all.filter((s) => s.enabled);
  const total = active.filter((s) => !s.unknownChars).reduce((n, s) => n + s.chars, 0);
  const four = active.filter((s) => !s.unknownChars && s.layer >= 1 && s.layer <= 4).reduce((n, s) => n + s.chars, 0);
  const edit = !!S.extra.psnPromptEdit;
  const buf = edit ? psnPromptBuf() : {};
  const comp = active.filter((s) => !s.unknownChars && s.chars > 0).map((s) =>
    `<div class="comp-seg" style="--seg:${psnPromptLayerColor(s.layer)};width:${Math.max(1.5, s.chars / Math.max(1, total) * 100)}%" title="${esc(s.name)} · ${psnFmt(s.chars)} 字"></div>`).join('');
  const legend = active.filter((s) => !s.unknownChars && s.chars > 0).map((s) =>
    `<div class="comp-item" style="--seg:${psnPromptLayerColor(s.layer)}"><span class="comp-swatch"></span><b>${esc(s.name)}</b><span>${psnFmt(s.chars)}</span></div>`).join('');
  const compCard = `<div class="card span-12">
    <div class="card-head"><div class="card-head-main"><div class="card-title">提示词构成</div><div class="card-sub">按字数；四层与固定段分开着色。</div></div><span class="chip accent">四层 ${total ? Math.round(four / total * 100) : 0}%</span></div>
    <div class="comp-bar">${comp || '<div class="comp-seg" style="--seg:var(--line);width:100%"></div>'}</div>
    <div class="comp-legend">${legend || '<span class="hint">还没有任何可统计的分段。</span>'}</div>
    <div class="card-foot"><span class="hint"><b>${psnFmt(total)}</b> 字 · <b>${active.filter((s) => !s.unknownChars).length}</b> 段 · 约 <b>${psnFmt(Math.round(total / 1.6))}</b> tokens</span><span class="chip ok">每轮重建</span></div>
  </div>`;
  const list = `<div class="card fill span-4">
    <div class="card-head"><div class="card-head-main"><div class="card-title">注入顺序</div><div class="card-sub">按顺序拼进 system prompt。</div></div><span class="chip plain">${active.length}/${all.length} 段</span></div>
    <div class="sec-list">${all.map((s) => `<div class="sec-row ${s.layer >= 1 && s.layer <= 4 ? 'is-layer' : ''} ${s.enabled ? '' : 'off'}" style="--lc:${psnPromptLayerColor(s.layer)}">
      <span class="sec-no">${s.layer >= 1 && s.layer <= 4 ? s.layer : '·'}</span>
      <div class="sec-main"><div class="sec-title"><span>${esc(s.name)}</span></div>
        <div class="sec-meta"><span class="chip">${esc(s.source)}</span>${s.layer >= 1 && s.layer <= 4 ? `<span class="chip accent">${psnPromptLayerTag(s.layer)}</span>` : ''}${s.overridden ? '<span class="chip ok">已改</span>' : ''}${s.enabled ? '' : '<span class="chip warn">未注入</span>'}</div>
        <div class="sec-bar"><i style="width:${s.enabled && !s.unknownChars ? Math.max(4, s.chars / Math.max(1, total) * 100) : 0}%"></i></div></div>
      <span class="sec-chars">${s.enabled ? (s.unknownChars ? '运行时' : `${psnFmt(s.chars)} 字`) : '—'}</span></div>`).join('')}</div>
    <div class="card-foot"><span class="hint">稳定段可缓存；心情段每轮变。</span></div>
  </div>`;
  const editbar = edit ? `<div class="prompt-editbar"><span class="hint"><b>分段编辑</b> · 共 <b data-psn-edit-total>${psnFmt(total)}</b> 字 · 只改提示词快照，不回写人设 / MBTI / 增强项页</span><div class="card-actions"><button class="linklike" type="button" data-a="psn.prompt.reset">恢复全部自动</button><button class="btn small" type="button" data-a="psn.prompt.cancel">取消</button><button class="btn small primary" type="button" data-a="psn.prompt.save">保存全部</button></div></div>` : '';
  const preview = `<div class="card fill span-8 prompt-card">
    <div class="prompt-toolbar"><div class="toolbar-left"><span class="chip">system · 人设相关段</span><span class="hint">${edit ? '编辑全部段落；保存后下一轮生效。' : '只读；右上角 ! 解锁全部段落。'}</span></div><div class="card-actions">${edit ? '<span class="chip accent">提示词编辑中</span>' : '<button class="unlock-btn" type="button" data-a="psn.prompt.unlock" aria-label="编辑系统提示词" title="编辑系统提示词">!</button>'}<button class="btn small" type="button" data-a="psn.copy">复制全文</button></div></div>
    ${editbar}
    <div class="prompt-doc">${active.map((s) => {
      const isLayer = s.layer >= 1 && s.layer <= 4;
      if (edit && PSN_EDITABLE.includes(s.id)) {
        const value = buf[s.id] === undefined ? (s.unknownChars ? '' : s.text) : buf[s.id];
        return `<div class="p-sec ${isLayer ? 'is-layer' : ''}" style="--lc:${psnPromptLayerColor(s.layer)}">
          <div class="p-h p-h-edit"><span class="p-edit-name">${esc(s.name)}</span>${isLayer ? `<span class="tag">${psnPromptLayerTag(s.layer)}</span>` : ''}<span class="src">${esc(s.source)}</span><span class="charcount" data-psn-sec-count="${esc(s.id)}">${psnFmt(psnLen(value))} 字</span></div>
          <textarea class="input prompt-editor-inline" data-psn-sec="${esc(s.id)}" data-psn-auto data-max-h="460" spellcheck="false" aria-label="编辑 ${esc(s.name)}" placeholder="${s.id === 'memory' ? '运行时按会话生成；在这里写会覆盖整个记忆段。' : ''}">${esc(value)}</textarea></div>`;
      }
      if (s.unknownChars) {
        return `<div class="p-sec ${isLayer ? 'is-layer' : ''}" style="--lc:${psnPromptLayerColor(s.layer)}">
          <div class="p-h"><span>## ${esc(s.name)}</span>${isLayer ? `<span class="tag">${psnPromptLayerTag(s.layer)}</span>` : ''}<span class="src">${esc(s.source)}</span></div>
          <div class="p-b"><span class="hint">运行时按会话生成（手动记忆 / 自动记忆 / 结构化记忆）。</span></div></div>`;
      }
      const isBase = s.id === 'base';
      const lines = isBase ? [s.text] : s.text.split('\n');
      const head = isBase ? s.name : (lines.shift() || '').replace(/^##\s*/, '') || s.name;
      return `<div class="p-sec ${isLayer ? 'is-layer' : ''}" style="--lc:${psnPromptLayerColor(s.layer)}">
        <div class="p-h"><span>## ${esc(head)}</span>${isLayer ? `<span class="tag">${psnPromptLayerTag(s.layer)}</span>` : ''}<span class="src">${esc(s.source)}</span>${s.overridden ? '<span class="chip ok">已改</span>' : ''}</div>
        <div class="p-b">${esc(lines.join('\n'))}</div></div>`;
    }).join('')}</div>
    <div class="card-foot"><span class="hint">${edit ? '保存后下一轮生效；空行也会保留。' : '只读；右上角 ! 解锁全部段落。'}</span><span class="chip accent">${esc(psnMbti().type)} · 心情 ${psnEmotion().ok ? (psnEmotion().mood ?? '—') : '未建立'}</span></div>
  </div>`;
  const layerTiles = all.filter((s) => s.layer >= 1 && s.layer <= 4).map((s) => {
    const on = s.enabled;
    return `<div class="diff-tile${on ? '' : ' is-off'}"><b>${on ? psnFmt(s.chars) : '—'}</b><span>${esc(s.name)} · ${on ? '已注入' : '未注入'}</span></div>`;
  }).join('');
  const note = `<div class="card span-12">
    <div class="card-head"><div class="card-head-main"><div class="card-title">四层快照</div><div class="card-sub">本页是当前快照；逐轮变化去「运行 → 日志」看 trace。</div></div><span class="chip ok">稳定前缀</span></div>
    <div class="diff-grid">${layerTiles}</div>
    <div class="card-foot"><span class="hint">稳定段可缓存；心情段每轮重写。场景 / 记忆 / 技能在运行时另加。</span><span class="chip plain">四层 ${psnFmt(four)} 字</span></div>
  </div>`;
  return `<div class="psn" data-psn-page="prompt">${psnPageHead([
    psnChip('自动汇总', 'ok'),
    psnChip(`<b>${active.filter((s) => !s.unknownChars).length}</b> 段`),
    psnChip(`<b>${psnFmt(total)}</b> 字`, 'accent'),
    psnChip(`四层 <b>${total ? Math.round(four / total * 100) : 0}%</b>`),
  ])}${compCard}${list}${preview}${note}</div>`;
}

/* ── 人设页的挂载 / 局部同步 ─────────────────────────────────────────── */
function psnGrow(el) {
  if (!el || el.tagName !== 'TEXTAREA') return;
  const max = Number(el.dataset.maxH) || 220;
  el.style.height = 'auto';
  const h = Math.min(max, Math.max(52, el.scrollHeight + 2));
  el.style.height = `${h}px`;
  el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
}

/* 人设页挂载时一次处理全部 textarea：先统一写 auto，再统一读 scrollHeight，最后统一写。
   逐个 psnGrow 会形成 12–24 次「写→读→写」的强制布局，正好卡在切页后 nav 动画的同一帧。 */
function psnGrowAll(els) {
  const list = [...els].filter((el) => el && el.tagName === 'TEXTAREA');
  if (!list.length) return;
  const maxes = list.map((el) => Number(el.dataset.maxH) || 220);
  for (const el of list) el.style.height = 'auto';
  const raws = list.map((el) => el.scrollHeight);
  for (let i = 0; i < list.length; i++) {
    list[i].style.height = `${Math.min(maxes[i], Math.max(52, raws[i] + 2))}px`;
    list[i].style.overflowY = raws[i] > maxes[i] ? 'auto' : 'hidden';
  }
}

function psnAxisReadCard(axis, value) {
  const v = Number(value) || 0;
  const right = v >= 50;
  const letter = right ? axis.right : axis.left;
  const pct = right ? v : 100 - v;
  const reads = {
    EI: { E: '从人群里充电，先说出来再想', I: '独处回血，先观察再开口' },
    SN: { S: '先看事实、细节和已经发生的事', N: '先看弦外之音、可能性和走向' },
    TF: { T: '先讲对错、逻辑和可执行的那一步', F: '先照顾感受、关系和气氛' },
    JP: { J: '喜欢有结论、有落点，答应就做到', P: '保留弹性，边走边看，临时改也行' },
  };
  const names = { EI: '能量来源', SN: '信息偏好', TF: '决策依据', JP: '生活方式' };
  return `<div class="axis-read" data-axis-read="${axis.id}">
    <div class="axis-read-head"><span>${names[axis.id] || axis.id}</span><b>${letter} ${Math.round(pct)}%</b></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="axis-read-txt">${esc((reads[axis.id] || {})[letter] || '')}</div></div>`;
}

function psnAxisVisual(id, value) {
  const row = document.querySelector(`.psn [data-axis-row="${id}"]`);
  if (!row) return;
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const fill = row.querySelector('.axis-fill');
  const knob = row.querySelector('.axis-knob');
  if (fill) fill.style.width = `${v}%`;
  if (knob) knob.style.left = `${v}%`;
}

/* 与原型同一组弹簧参数：拖动时滑块跟手回弹，松手不突兀。 */
const psnAxisSprings = new Map();
function psnSpringAxis(id, target) {
  const to = Math.max(0, Math.min(100, Number(target) || 0));
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    psnAxisVisual(id, to);
    return;
  }
  let st = psnAxisSprings.get(id);
  if (!st) {
    const row = document.querySelector(`.psn [data-axis-row="${id}"]`);
    const fill = row ? row.querySelector('.axis-fill') : null;
    const knob = row ? row.querySelector('.axis-knob') : null;
    const shown = parseFloat(fill?.style.width || 'NaN');
    st = { value: Number.isFinite(shown) ? shown : to, velocity: 0, target: to, raf: 0, fill, knob };
    psnAxisSprings.set(id, st);
  }
  st.target = to;
  if (st.raf) return;
  /* 节点在第一次拖动时缓存；页面重建会由 psnMountPersona 清空这张表。 */
  const paint = (v) => {
    if (st.fill) st.fill.style.width = `${v}%`;
    if (st.knob) st.knob.style.left = `${v}%`;
  };
  const step = () => {
    const k = 340, d = 18, m = 0.85, dt = 1 / 60;
    const force = -k * (st.value - st.target) - d * st.velocity;
    st.velocity += (force / m) * dt;
    st.value += st.velocity * dt;
    paint(st.value);
    if (Math.abs(st.value - st.target) < 0.15 && Math.abs(st.velocity) < 0.15) {
      paint(st.target);
      st.raf = 0;
      return;
    }
    st.raf = requestAnimationFrame(step);
  };
  st.raf = requestAnimationFrame(step);
}

/* 读数卡 / 类型卡每帧最多换一次：拖动时 input 可能到 120Hz，逐条 outerHTML
   会在一帧里反复重建同一块 DOM。视觉跟手仍由弹簧直接写节点。 */
const psnAxisPending = new Map();
let psnAxisRaf = 0;

function psnPaintAxisHeavy(id, v) {
  const meta = psnAxisMeta().find((a) => a.id === id);
  if (!meta) return;
  const row = document.querySelector(`.psn [data-axis-row="${id}"]`);
  if (!row) return;
  const input = row.querySelector('[data-psn-axis]');
  if (input) input.setAttribute('aria-valuetext', v >= 50 ? `${meta.right} ${meta.rightName} ${v}%` : `${meta.left} ${meta.leftName} ${100 - v}%`);
  const head = row.querySelector('.axis-head');
  const right = v >= 50;
  if (head) {
    head.innerHTML = `<span><b class="${right ? 'dim' : ''}">${meta.left}</b> <span class="${right ? 'dim' : ''}">${meta.leftName}</span> ${100 - v}%</span>`
      + `<span><b class="${right ? '' : 'dim'}">${meta.right}</b> <span class="${right ? '' : 'dim'}">${meta.rightName}</span> ${v}%</span>`;
  }
  const read = document.querySelector(`.psn [data-axis-read="${id}"]`);
  if (read) read.outerHTML = psnAxisReadCard(meta, v);
}

function psnFlushAxisPaint() {
  psnAxisRaf = 0;
  const batch = new Map(psnAxisPending);
  psnAxisPending.clear();
  for (const [id, v] of batch) psnPaintAxisHeavy(id, v);
  if (batch.size) psnPaintTypeLive();
}

function psnPaintAxis(id, value, visual = true) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  if (visual) psnAxisVisual(id, v);
  psnAxisPending.set(id, v);
  if (psnAxisRaf) return;
  psnAxisRaf = requestAnimationFrame(psnFlushAxisPaint);
}

function psnCurrentAxes() {
  const out = {};
  for (const el of document.querySelectorAll('.psn [data-psn-axis]')) out[el.dataset.psnAxis] = Number(el.value) || 0;
  return out;
}

function psnPaintTypeLive() {
  const axes = psnCurrentAxes();
  if (!Object.keys(axes).length) return;
  const type = psnTypeFromAxes(axes);
  const info = psnTypeTable()[type] || { name: '', tag: '', traits: [] };
  const summary = psnAxisSummary(axes);
  const vars = psnTypeVars(type);
  const on = !!document.querySelector('.psn input[data-id="mbti.on"]')?.checked
    || !!document.querySelector('.psn input[data-id="mbti.on2"]')?.checked;
  for (const el of document.querySelectorAll('.psn [data-psn-hero], .psn .mbti-matrix, .psn .mbti-current-card')) {
    el.setAttribute('style', vars);
  }
  for (const el of document.querySelectorAll('.psn [data-psn-type-code]')) el.textContent = type;
  for (const el of document.querySelectorAll('.psn [data-psn-type-code2]')) el.textContent = type;
  for (const el of document.querySelectorAll('.psn [data-psn-type-name]')) el.textContent = info.name || '';
  for (const el of document.querySelectorAll('.psn [data-psn-type-name2]')) el.textContent = info.name || '';
  for (const el of document.querySelectorAll('.psn [data-psn-type-chip-wrap]')) el.setAttribute('style', vars);
  for (const el of document.querySelectorAll('.psn [data-psn-type-chip]')) el.textContent = type;
  for (const el of document.querySelectorAll('.psn [data-psn-type-tag], .psn [data-psn-type-tag2]')) el.textContent = info.tag || '';
  for (const el of document.querySelectorAll('.psn [data-psn-type-traits], .psn [data-psn-type-traits2]')) {
    el.innerHTML = (info.traits || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('');
  }
  const artBtn = document.querySelector('.psn #mbtiArt');
  if (artBtn) artBtn.setAttribute('aria-label', `查看 ${type} ${info.name || ''} 官方场景大图`);
  for (const el of document.querySelectorAll('.psn [data-psn-art-label]')) el.textContent = `${type} · ${info.name || ''}`;
  for (const el of document.querySelectorAll('.psn [data-psn-art-scene]')) {
    if (el.dataset.psnArtType === type) continue;
    el.dataset.psnArtType = type;
    el.innerHTML = psnTypeScene(type);
  }
  const artImg = document.querySelector('.psn .mbti-art-img');
  if (artImg && artImg.dataset.artType !== type) {
    artImg.dataset.artType = type;
    artImg.classList.remove('is-broken');
    artImg.src = PSN_ART[type] || '';
    artImg.alt = `16Personalities 官方 ${type} ${info.name || ''} 场景图`;
    artImg.style.animation = 'none';
    void artImg.offsetWidth;
    artImg.style.animation = '';
  }
  for (const el of document.querySelectorAll('.psn [data-psn-type-ghost]')) el.textContent = type;
  for (const el of document.querySelectorAll('.psn [data-psn-type-summary]')) el.textContent = summary;
  const snippet = psnMbtiSnippetText(type, summary, on);
  for (const el of document.querySelectorAll('.psn [data-psn-mbti-snippet], .psn [data-psn-mbti-snippet2]')) el.textContent = snippet;
  for (const btn of document.querySelectorAll('.psn [data-a="psn.type"]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.p === type));
  }
}

function psnUpdateEditTotal() {
  let n = 0;
  for (const el of document.querySelectorAll('.psn [data-psn-sec]')) n += el.value.length;
  for (const el of document.querySelectorAll('.psn [data-psn-edit-total]')) el.textContent = psnFmt(n);
}

let psnPriorityObs = null;
function psnInitPriorityReveal() {
  if (psnPriorityObs) { psnPriorityObs.disconnect(); psnPriorityObs = null; }
  const card = document.querySelector('.psn .priority-card');
  if (!card) return;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (S.extra.psnPrioritySeen || reduced || !('IntersectionObserver' in window)) {
    card.classList.add('is-in');
    S.extra.psnPrioritySeen = true;
    return;
  }
  psnPriorityObs = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    card.classList.add('is-in');
    S.extra.psnPrioritySeen = true;
    psnPriorityObs?.disconnect();
    psnPriorityObs = null;
  }, { threshold: 0.25 });
  psnPriorityObs.observe(card);
}

function psnMountPersona() {
  psnGrowAll(document.querySelectorAll('.psn [data-psn-auto]'));
  /* 滑块视觉由 JS 跟手更新；这里只把初始状态对齐一次，避免浏览器恢复表单值时
     视觉层与 input.value 不同步（刷新页面后最容易看到）。 */
  psnAxisSprings.clear();
  psnAxisPending.clear();
  if (psnAxisRaf) { cancelAnimationFrame(psnAxisRaf); psnAxisRaf = 0; }
  for (const el of document.querySelectorAll('.psn [data-psn-axis]')) psnPaintAxis(el.dataset.psnAxis, el.value);
  psnHelpHide(true);
  psnChartHide();
  psnLineHide();
  /* 分段渲染的壳阶段先不揭示优先级（否则入场级联又和导航动画同窗）；
     等 psnArmAndFill 落图时再调。非分段页照旧在这里揭示。 */
  if (!$id('page').classList.contains('psn-stage')) psnInitPriorityReveal();
}

/* ── 分段渲染的落图与放行（2026-10-28）──────────────────────────────────
   壳落定后调 psnScheduleArm：导航还在动就等 dock 停稳（回调挂在既有 rAF 位点），
   否则下一帧就落；另有 900ms 兜底 —— 动画被取消、标签页在后台都可能让回调晚到，
   壳已经在页面上，最坏只是图表晚到，不会白屏。
   ⚠️ 放行**不绑 paintSeq**：3 秒轮询会照常 ++pagePaintSeq，但它命中的是 skip-redraw
      （DOM 与缓存逐字相同、连 className 都不动），拿它作废放行会把壳冻死。
      判据只认两件：代号没被更新的分段渲染顶掉、页面还挂着 `psn-stage`。 */
function psnScheduleArm() {
  const gen = ++psnStageGen;
  clearTimeout(psnArmTimer);
  const psnArm = () => psnArmAndFill(gen);
  if (navDockAnimating()) navDockSettled(psnArm);
  else requestAnimationFrame(psnArm);
  psnArmTimer = setTimeout(psnArm, 900);
}
function psnArmAndFill(gen) {
  if (gen !== psnStageGen) return;
  const page = $id('page');
  if (!page || !page.classList.contains('psn-stage')) return;
  clearTimeout(psnArmTimer);
  /* 先落图、再撤闸门：撤 `psn-stage` 的同一刻，所有入场动画一起起跑。
     槽里已有内容（期间轮询整页提交过）就整段跳过 —— 图表动画靠插入触发，绝不重播。 */
  if (psnChartSlots) {
    for (const [name, body] of psnChartSlots) {
      const slot = page.querySelector(`[data-psn-slot="${name}"]`);
      if (slot && !slot.firstElementChild && !slot.textContent) slot.innerHTML = body;
    }
    psnChartSlots = null;
  }
  page.classList.remove('psn-stage');
  page.classList.add('psn-armed');
  psnInitPriorityReveal();
}

/* 输入框：字数、自动长高、滑块跟手、提示词分段缓冲（全部**委托一次**） */
document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (!(el instanceof Element)) return;
  if (el.matches('[data-psn-auto]')) psnGrow(el);
  if (el.dataset.countFor) {
    const text = `${psnLen(el.value)} 字`;
    for (const n of document.querySelectorAll(`.psn [data-count-for="${el.dataset.countFor}"]`)) n.textContent = text;
  }
  if (el.dataset.psnAxis) {
    const id = el.dataset.psnAxis;
    setValue({ id: `mbti.axis.${id}`, bind: `mbti.axes.${id}`, t: 'range' }, Number(el.value));
    psnSpringAxis(id, Number(el.value));
    psnPaintAxis(id, Number(el.value), false);
  }
  if (el.dataset.psnSec) {
    psnPromptBuf()[el.dataset.psnSec] = el.value;
    const n = el.closest('.p-sec')?.querySelector('[data-psn-sec-count]');
    if (n) n.textContent = `${psnFmt(el.value.length)} 字`;
    psnUpdateEditTotal();
  }
  if (el.dataset.psnRuleIndex != null) {
    const list = psnRulesEnsureDraft();
    const i = Number(el.dataset.psnRuleIndex);
    if (list[i]) {
      list[i] = { ...list[i], text: el.value };
      psnRulesTouch();
    }
  }
});

/* ── 人设页的动作 ──────────────────────────────────────────────────── */
async function psnPromptSave() {
  const buf = psnPromptBuf();
  const patch = {};
  let changed = false;
  for (const sec of psnSections()) {
    if (!PSN_EDITABLE.includes(sec.id) || !sec.enabled) continue;
    if (!Object.prototype.hasOwnProperty.call(buf, sec.id)) continue;
    const next = buf[sec.id];
    const cur = sec.unknownChars ? '' : sec.text;
    if (next === cur) continue;
    if (next === sec.autoText) {
      if (sec.overridden) { patch[sec.id] = null; changed = true; }
      continue;
    }
    patch[sec.id] = next;
    changed = true;
  }
  if (!changed) {
    toast('没有改动');
    S.extra.psnPromptEdit = false;
    S.extra.psnPromptBuf = null;
    paintPage(false);
    return;
  }
  S.draft.custom.promptSections = { ...(S.draft.custom.promptSections || {}), ...patch };
  touchC('promptSections');
  S.extra.psnPromptEdit = false;
  S.extra.psnPromptBuf = null;
  await commitDraft();
}

async function psnPromptReset() {
  const patch = {};
  for (const sec of psnSections()) {
    if (PSN_EDITABLE.includes(sec.id)) patch[sec.id] = null;
  }
  S.draft.custom.promptSections = { ...(S.draft.custom.promptSections || {}), ...patch };
  touchC('promptSections');
  S.extra.psnPromptEdit = false;
  S.extra.psnPromptBuf = null;
  await commitDraft();
}

async function psnCopyPrompt() {
  const text = psnPromptPlainText();
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制 ${psnFmt(text.length)} 字`, 'ok');
  } catch {
    toast('复制失败：浏览器不允许剪贴板；请手动选中', 'bad');
  }
}

/* ── MBTI 官方场景大图（body 级，独立于通用 modal）────────────────── */
function psnOpenArt(type) {
  const t = String(type || '').toUpperCase();
  const info = psnTypeTable()[t] || { name: '' };
  let el = $id('psnArtModal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'psnArtModal';
    el.className = 'psn-overlay psn-art-modal';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'MBTI 官方场景大图');
    document.body.appendChild(el);
  }
  S.extra.psnArtReturn = document.activeElement;
  el.innerHTML = `<button class="psn-art-backdrop" type="button" data-a="psn.art.close" aria-label="关闭大图"></button>
    <figure class="psn-art-figure" style="${psnTypeVars(t)}">
      <div class="psn-art-stage">
        <span class="psn-art-scene" aria-hidden="true">${psnTypeScene(t)}</span>
        <img class="psn-art-img" src="${PSN_ART[t] || ''}" alt="16Personalities 官方 ${t} ${esc(info.name)} 场景图">
      </div>
      <figcaption><b>${t} · ${esc(info.name)}</b><span>图源 16Personalities</span><span>Esc / 点击空白关闭</span></figcaption>
    </figure>
    <button class="psn-art-x" type="button" data-a="psn.art.close" aria-label="关闭大图">×</button>`;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-open'));
  el.querySelector('.psn-art-x')?.focus();
}
function psnCloseArt() {
  const el = $id('psnArtModal');
  if (!el || el.hidden) return;
  el.classList.remove('is-open');
  el.hidden = true;
  el.innerHTML = '';
  const back = S.extra.psnArtReturn;
  S.extra.psnArtReturn = null;
  if (back && back.isConnected) { try { back.focus(); } catch { /* 忽略 */ } }
}
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$id('psnArtModal')?.hidden) { ev.preventDefault(); psnCloseArt(); }
});
/* 官方图加载失败时露出下面的本地 SVG 回退；CSP 禁内联 onerror，所以用捕获阶段委托。 */
document.addEventListener('error', (ev) => {
  const img = ev.target;
  if (img instanceof HTMLImageElement && (img.classList.contains('mbti-art-img') || img.classList.contains('psn-art-img'))) {
    img.classList.add('is-broken');
  }
}, true);

/* ── 字段帮助浮层（body 级，pointer/focus/click 三态）────────────── */
function psnHelpEl() {
  let el = $id('psnHelpTip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'psnHelpTip';
    el.className = 'psn-overlay psn-help-tip';
    el.hidden = true;
    el.setAttribute('role', 'tooltip');
    document.body.appendChild(el);
  }
  return el;
}
function psnHelpShow(anchor, pin = false) {
  if (!anchor || !anchor.dataset.helpTip) return;
  if (!pin && S.extra.psnHelpPinned && S.extra.psnHelpPinned !== anchor) return;
  const el = psnHelpEl();
  el.textContent = anchor.dataset.helpTip;
  el.hidden = false;
  const r = anchor.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  let top = r.top - er.height - 8;
  if (top < 8) top = Math.min(innerHeight - er.height - 8, r.bottom + 8);
  const left = Math.max(8, Math.min(innerWidth - er.width - 8, r.left + r.width / 2 - er.width / 2));
  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(left)}px`;
  el.style.setProperty('--arrow-x', `${Math.round(r.left + r.width / 2 - left)}px`);
  requestAnimationFrame(() => el.classList.add('show'));
  anchor.setAttribute('aria-expanded', 'true');
  if (pin) S.extra.psnHelpPinned = anchor;
}
function psnHelpHide(force = false) {
  const pinned = S.extra.psnHelpPinned;
  if (pinned && !force) return;
  const el = $id('psnHelpTip');
  if (el) { el.classList.remove('show'); el.hidden = true; }
  if (pinned) pinned.setAttribute('aria-expanded', 'false');
  S.extra.psnHelpPinned = null;
}
document.addEventListener('pointerover', (ev) => {
  const help = ev.target instanceof Element ? ev.target.closest('.psn [data-help-tip]') : null;
  if (help) psnHelpShow(help, false);
});
document.addEventListener('pointerout', (ev) => {
  const help = ev.target instanceof Element ? ev.target.closest('.psn [data-help-tip]') : null;
  if (help && !S.extra.psnHelpPinned) psnHelpHide(true);
});
document.addEventListener('focusin', (ev) => {
  const help = ev.target instanceof Element ? ev.target.closest('.psn [data-help-tip]') : null;
  if (help) psnHelpShow(help, false);
});
document.addEventListener('focusout', (ev) => {
  const help = ev.target instanceof Element ? ev.target.closest('.psn [data-help-tip]') : null;
  if (help && !S.extra.psnHelpPinned) psnHelpHide(true);
});
document.addEventListener('click', (ev) => {
  const help = ev.target instanceof Element ? ev.target.closest('.psn [data-help-tip]') : null;
  if (help) {
    ev.preventDefault();
    if (S.extra.psnHelpPinned === help) psnHelpHide(true);
    else psnHelpShow(help, true);
    return;
  }
  if (!(ev.target instanceof Element) || !ev.target.closest('#psnHelpTip')) psnHelpHide(true);
});
window.addEventListener('scroll', () => psnHelpHide(true), { passive: true });
window.addEventListener('resize', () => psnHelpHide(true));

/* ── 图表浮层（body 级；雷达/环形/折线/圆柱/情绪柱共用）────────────── */
function psnChartTipEl() {
  let el = $id('psnChartTip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'psnChartTip';
    el.className = 'psn-overlay psn-chart-tip';
    el.hidden = true;
    el.setAttribute('role', 'tooltip');
    document.body.appendChild(el);
  }
  return el;
}
function psnChartShowData({ title = '', value = '', sub = '', color = 'var(--chart-1)' }, x, y) {
  const el = psnChartTipEl();
  el.innerHTML = `<div class="ct-head"><span class="ct-dot" style="--tc:${esc(color)}"></span>${esc(title)}</div>
    ${value ? `<div class="ct-value">${esc(value)}</div>` : ''}
    ${sub ? `<div class="ct-sub">${esc(sub)}</div>` : ''}`;
  el.style.setProperty('--tc', color);
  el.hidden = false;
  psnChartMove(x, y);
  requestAnimationFrame(() => el.classList.add('show'));
}
function psnChartShow(target, x, y) {
  if (!target) return;
  psnChartShowData({
    title: target.dataset.tipTitle || '',
    value: target.dataset.tipValue || '',
    sub: target.dataset.tipSub || '',
    color: target.dataset.tipColor || 'var(--chart-1)',
  }, x, y);
}
function psnChartMove(x, y) {
  const el = $id('psnChartTip');
  if (!el || el.hidden) return;
  const r = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(innerWidth - r.width - 8, x + 14));
  let top = y + 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(8, top))}px`;
}
function psnChartHide() {
  const el = $id('psnChartTip');
  if (el) { el.classList.remove('show'); el.hidden = true; }
}
document.addEventListener('pointerover', (ev) => {
  const target = ev.target instanceof Element ? ev.target.closest('.psn [data-tip], .psn [data-tip-title]') : null;
  if (target) psnChartShow(target, ev.clientX, ev.clientY);
});
document.addEventListener('pointermove', (ev) => {
  if ($id('psnChartTip')?.hidden) return;
  psnChartMove(ev.clientX, ev.clientY);
});
document.addEventListener('pointerout', (ev) => {
  const target = ev.target instanceof Element ? ev.target.closest('.psn [data-tip], .psn [data-tip-title]') : null;
  if (target) psnChartHide();
});

/* 环形 hover：段/图例共用 data-donut-index；中心数字按原型做短动画。 */
const psnDonutAnim = new WeakMap();
function psnDonutNumber(el, to) {
  if (!el) return;
  const prev = psnDonutAnim.get(el);
  if (prev) cancelAnimationFrame(prev);
  const target = Math.max(0, Number(to) || 0);
  const from = Number(String(el.textContent || '').replace(/[^\d]/g, '')) || 0;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = psnFmt(target); return;
  }
  const t0 = performance.now();
  const dur = 320;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const v = Math.round(from + (target - from) * (1 - Math.pow(1 - p, 3)));
    el.textContent = psnFmt(v);
    if (p < 1) psnDonutAnim.set(el, requestAnimationFrame(step));
    else psnDonutAnim.delete(el);
  };
  psnDonutAnim.set(el, requestAnimationFrame(step));
}
function psnDonutShow(hit) {
  if (!hit) return;
  const root = document.querySelector('.psn .layer-donut');
  if (!root) return;
  const idx = String(hit.dataset.donutIndex || '');
  root.classList.add('is-hover');
  for (const seg of root.querySelectorAll('.donut-seg')) {
    seg.classList.toggle('is-active', seg.dataset.donutIndex === idx);
  }
  const label = root.querySelector('.donut-center-label');
  const value = root.querySelector('.donut-center-value');
  const pct = root.querySelector('.donut-center-pct');
  if (label) label.textContent = hit.dataset.donutLabel || '';
  if (value) psnDonutNumber(value, hit.dataset.donutValue);
  if (pct) pct.textContent = hit.dataset.donutPct || '';
}
function psnDonutHide() {
  const root = document.querySelector('.psn .layer-donut');
  if (!root) return;
  root.classList.remove('is-hover');
  for (const seg of root.querySelectorAll('.donut-seg')) seg.classList.remove('is-active');
  const label = root.querySelector('.donut-center-label');
  const value = root.querySelector('.donut-center-value');
  const pct = root.querySelector('.donut-center-pct');
  if (label) label.textContent = '四层合计';
  if (value) psnDonutNumber(value, root.dataset.donutTotal);
  if (pct) pct.textContent = '';
}
document.addEventListener('pointerover', (ev) => {
  const hit = ev.target instanceof Element ? ev.target.closest('.psn [data-donut-index]') : null;
  if (hit) psnDonutShow(hit);
});
document.addEventListener('pointerout', (ev) => {
  const hit = ev.target instanceof Element ? ev.target.closest('.psn [data-donut-index]') : null;
  if (!hit) return;
  const to = ev.relatedTarget;
  if (to instanceof Element && to.closest('.psn [data-donut-index]') === hit) return;
  psnDonutHide();
});

/* 睡眠运行时状态的中文标签与取值格式。
   为什么要做：`effective.sleep` 的键是 `asleep / wakeAt / wakeKind` 这种实现名，
   直接铺在页面上等于让用户读源码。**没见过的键原样显示**（不隐藏、不猜），
   这样以后 src 加了字段，页面会如实多一行，而不是静默少一行。 */
const SLEEP_LABEL = {
  enabled: '作息已启用', asleep: '此刻睡着', bed: '入睡时刻', wake: '自然醒时刻',
  bedAt: '本次入睡于', wakeAt: '下次自然醒于', wakeUntil: '临时醒到', mode: '模式',
  wakeKind: '叫醒方式', reason: '判定依据', pending: '压着的未读条数', owners: '可叫醒的主人数',
  privateWake: '允许私聊叫醒', updateAt: '状态更新于',
};
const TS_KEYS = new Set(['bedAt', 'wakeAt', 'wakeUntil', 'updateAt']);
function sleepVal(k, v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (TS_KEYS.has(k) && Number(v) > 1e12) return new Date(Number(v)).toLocaleString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* 配置里的命名空间是复数（extensions.plugins / extensions.skills），
   而 kind 是单数（plugin / skill）—— 两套字面量只在这个函数里换算一次。 */
const extNsOf = (kind) => (kind === 'skill' ? 'skills' : 'plugins');
/* pluginSettingsRow 的独立实现（避免 RENDER 表里塞函数当键） */
function pluginSettingsRow(it, kind = 'plugin') {
  const spec = Array.isArray(it.settingsSpec) ? it.settingsSpec : [];
  if (!spec.length) return '';
  const body = spec.map((f) => pluginSettingHtml(it.id, f, kind)).join('');
  /* 设置项多的包（实测最多 7 项）默认收起：一个包就把页面撑满，
     会让"下面还有别的包"这件事看不见。≤3 项的直接摊开，省一次点击。 */
  if (spec.length > 3) {
    return `<details class="det"><summary>设置（共 ${spec.length} 项，改完点底部「保存并生效」）</summary>
      <div class="f" style="gap:6px;padding-top:4px;">${body}</div></details>`;
  }
  return `<div class="f" style="gap:6px;">
    <span class="hint">设置（共 ${spec.length} 项，改完点底部「保存并生效」）</span>${body}</div>`;
}
/** 把一次 `plugin.set` 控件变化写进草稿。click 不写、change 才写 —— 见调用点的注释。 */
function commitPluginSetting(el, p) {
  const [kindRaw, extId, key] = String(p || '').split('|');
  const kind = kindRaw === 'skill' ? 'skill' : 'plugin';
  const it = (S.state?.extensions?.items || []).find((e) => e.id === extId);
  const field = (it?.settingsSpec || []).find((f) => f.key === key);
  if (!field) return toast(`「${key}」不在这个包的清单里，已拒绝写入`, 'bad');
  // bool 必须写**布尔**：以前写 'true'/'false' 字符串，重画时 `val === true` 判不过，
  // 复选框又变回未勾选 —— 用户以为"存不上"。其余类型按控件原样取。
  let v;
  if (field.kind === 'bool') v = el.checked === true;
  else if (field.kind === 'list') v = String(el.value || '').split('\n').map((s) => s.trim()).filter(Boolean);
  else v = el.value;
  const path = `extensions.${extNsOf(kind)}.settings.${extId}.${key}`;
  setPath(S.draft.custom, path, v);
  touchC(path);
  markDirty();
  return undefined;
}

function pluginSettingHtml(extId, f, kind = 'plugin') {
  const path = `extensions.${extNsOf(kind)}.settings.${extId}.${f.key}`;
  const raw = getPath(S.draft.custom, path);
  // 回填优先级：草稿（本次未保存）→ 服务端当前值 → 清单默认值。
  // 中间这层以前缺了：保存成功 + 刷新后控件显示清单默认值，用户以为"存不上"。
  const fromState = getPath((S.state || DEMO).custom, path);
  const val = raw !== undefined ? raw : (fromState !== undefined ? fromState : f.value);
  const common = `data-a="plugin.set" data-p="${esc(kind)}|${esc(extId)}|${esc(f.key)}"`;
  const tip = `清单默认值：${JSON.stringify(f.def)}`;
  if (f.kind === 'bool') {
    // 兼容旧草稿里的字符串写法（'true'/'false'），新写入一律布尔。
    return `<label class="sw flat" title="${esc(tip)}"><input type="checkbox" ${(val === true || val === 'true') ? 'checked' : ''} ${common}>
      <span class="track"></span><span class="txt mono">${esc(f.label || f.key)}</span></label>`;
  }
  if (f.kind === 'number') {
    return `<div class="f-inline" title="${esc(tip)}"><span class="hint mono" style="flex:none;min-width:120px;">${esc(f.label || f.key)}</span>
      <input type="number" value="${esc(String(val ?? ''))}" ${common} style="max-width:180px;" /></div>`;
  }
  if (f.kind === 'list') {
    const text = Array.isArray(val) ? val.join('\n') : String(val ?? '');
    return `<div class="f" title="${esc(tip)}"><span class="hint mono">${esc(f.label || f.key)} · 一行一项</span>
      <textarea rows="2" ${common} style="font-size:12px;">${esc(text)}</textarea></div>`;
  }
  if (f.kind === 'string') {
    return `<div class="f-inline" title="${esc(tip)}"><span class="hint mono" style="flex:none;min-width:120px;">${esc(f.label || f.key)}</span>
      <input type="${f.sensitive ? 'password' : 'text'}" value="${esc(String(val ?? ''))}" ${common} style="max-width:280px;" />
      ${f.sensitive ? '<span class="tag warn">凭据</span>' : ''}</div>`;
  }
  return `<div class="f-inline"><span class="hint mono" style="flex:none;min-width:120px;">${esc(f.key)}</span>
    <span class="hint">这一项的默认值不是基本类型，宿主不支持直接编辑（要改就改清单）。</span></div>`;
}

/* 通用输入控件 */
function fieldInput(x, type) {
  S.reg.set(x.id, x);
  const v = valueOf(x);
  const ref = x.ref ? ` data-ref="${esc(x.ref)}"` : '';
  const a = x.save || x.bind || x.bindSys ? `data-a="field"` : `data-a="field-local"`;
  const common = `${did(x)} ${a}${ref}`;
  const wide = x.wide ? 'class="grow"' : '';
  let node;
  if (type === 'textarea') node = `<textarea rows="${x.rows || 2}" ${common} placeholder="${esc(x.ph || '')}">${esc(v ?? '')}</textarea>`;
  else if (type === 'select') {
    const opts = typeof x.options === 'function' ? x.options(S.state || DEMO) : x.options;
    node = `<select ${common} ${wide}>${(opts || []).map((o) => `<option value="${esc(o.v)}" ${String(o.v) === String(v) ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}</select>`;
  } else if (type === 'number') {
    node = `<input type="number" ${common} value="${esc(v ?? '')}" ${x.min != null ? `min="${x.min}"` : ''} ${x.max != null ? `max="${x.max}"` : ''} step="${x.step || 1}" ${x.readonly ? 'readonly' : ''} style="width:${x.wide ? '100%' : '130px'}" />`;
  } else {
    node = `<input type="${type}" ${common} value="${esc(v ?? '')}" placeholder="${esc(x.ph || '')}" ${x.readonly ? 'readonly' : ''} ${wide} autocomplete="off" />`;
  }
  const bounds = x.bounds ? boundHint(x.bounds) : '';
  return `<div class="f">${lb(x, bounds)}${node}${hintOf(x)}</div>`;
}
function boundHint(key) {
  const b = j(S.state, ['customMeta', 'fieldMeta', 'bounds', key], null);
  return b ? `<span class="spacer"></span><span class="hint">后端允许 ${b[0]} – ${b[1]}</span>` : '';
}

/* ══════════════ 8.5 网页内置终端（2026-10-11）═════════════════════════════════
   为什么状态放在**模块级**而不是 `S.extra`：页面那 3 秒一轮的重画会整块替换
   `#page` 的 innerHTML，任何挂在 DOM 上的东西（滚动位置、已收到的日志行）都会丢。
   所以日志行与 SSE 连接必须住在重画之外，重画只负责"按现状再画一遍"。 */
const TERM = {
  lines: [],   // 控制台日志（SSE 推来的）
  nap: [],     // 协议端日志（拉取的尾部）
  src: 'panel',
  st: null,    // 最近一次心跳：{ bridge, proto, pid }
  es: null,    // EventSource（只建一次）
  stick: true, // 是否在"贴着底部"（贴底才自动滚动，否则尊重用户手动翻的位置）
  napTimer: null, // 协议端日志的续拉定时器（单例，见 startNapTailTimer）
  quit: false,
};

/** 把当前该显示的那份文本写进 `#termBody`（**只动这一个节点**，不整页重画）。 */
function paintTerm() {
  const box = $id('termBody');
  if (!box) return;
  const lines = TERM.src === 'napcat' ? TERM.nap : TERM.lines;
  box.textContent = lines.length ? lines.join('\n') : (TERM.src === 'napcat'
    ? '（还没有协议端日志 —— 它第一次跑起来之后才会写这个文件。）'
    : '（正在连接日志流…）');
  if (TERM.stick) box.scrollTop = box.scrollHeight;
}

/** 页面重画完之后重新挂一次（元素每轮都是新的）。 */
function mountTerm() {
  const box = $id('termBody');
  if (!box) return;
  paintTerm();
  if (!TERM.stick) box.scrollTop = 0;
  // ⚠️ 每轮重建后**重新绑**：`scroll` 是绑在节点上的，节点换了监听就随它一起没了。
  box.addEventListener('scroll', () => {
    TERM.stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  });
  if (!S.online) { box.textContent = '演示模式：这一页没有连上后端，看不到实时日志。'; return; }
  if (!TERM.es) openTermStream();
  if (TERM.src === 'napcat') { loadNapcatTail(); startNapTailTimer(); } else stopNapTailTimer();
}

/**
 * 协议端日志的**定时续拉**（2026-10-13）。
 *
 * 为什么需要：控制台那一路是 SSE 推的，而协议端那一路是从 `napcat.log` 尾部读的，
 * 以前只在"切到这一栏 / 页面重画"时拉一次 ⇒ 扫码提示与登录过程**停在第一帧**，
 * 用户只好再去开一个黑窗口看实时输出 —— 而那个窗口一关就掉登录态。
 * 现在这一栏自己每 3 秒续一次，黑窗口就没有任何存在理由了。
 *
 * ⚠️ 定时器的句柄要住在 `TERM` 里（页面 3 秒一轮重画会换掉 DOM，但不会换掉模块级状态），
 *    且**必须单例**：重画每调一次 mountTerm 就多一个定时器，很快会变成每秒几十个请求。
 */
function startNapTailTimer() {
  if (TERM.napTimer) return;
  TERM.napTimer = setInterval(() => {
    // 只在"还看得见这一栏"时拉：用户翻到别的页就别再打扰后端了
    if (TERM.src !== 'napcat' || !document.querySelector('#termBody')) { stopNapTailTimer(); return; }
    loadNapcatTail();
  }, 3000);
}
function stopNapTailTimer() {
  if (!TERM.napTimer) return;
  clearInterval(TERM.napTimer);
  TERM.napTimer = null;
}

/**
 * 开日志流（SSE）。
 *
 * ⚠️ 为什么不用轮询 `/api/logs`：那要每 3 秒发一次请求，而日志**大部分时间没有新增** ——
 *    轮询的代价付在"没变化时"上，SSE 的代价付在"有变化时"上，后者才是我们要的。
 * ⚠️ 断线**不手工重连**：`EventSource` 自带重连（服务端 `retry: 3000` 指定了间隔）。
 */
function openTermStream() {
  if (TERM.es || typeof EventSource === 'undefined') return;
  const es = new EventSource('/api/console/stream');
  TERM.es = es;
  const push = (arr) => {
    TERM.lines = TERM.lines.concat(arr).slice(-400);
    if (TERM.src === 'panel') paintTerm();
  };
  es.addEventListener('hello', (ev) => { try { push(JSON.parse(ev.data).lines || []); } catch { /* 坏帧丢掉即可 */ } });
  es.addEventListener('log', (ev) => { try { push(JSON.parse(ev.data).lines || []); } catch { /* 同上 */ } });
  es.addEventListener('state', (ev) => {
    try { TERM.st = JSON.parse(ev.data); } catch { /* 同上 */ }
    // 状态灯只在"值变了"时才重画一次整个终端块 —— 心跳每 3 秒来一次，
    // 无脑重画会让页面一直在闪（而闪起来看不出是心跳还是出问题了）。
    const h = document.querySelector('.term-h');
    if (h) {
      const dots = h.querySelectorAll('.term-dot');
      if (dots[0]) dots[0].classList.toggle('on', Boolean(TERM.st?.bridge));
      if (dots[1]) dots[1].classList.toggle('on', Boolean(TERM.st?.proto));
    }
  });
  es.onerror = () => { /* 交给 EventSource 自己重连；页面上的"断线"由不增长的行数自然显示 */ };
}

async function loadNapcatTail() {
  try {
    const r = await api('/api/console/tail?src=napcat&lines=200');
    TERM.nap = r.lines || [];
    paintTerm();
  } catch (e) {
    TERM.nap = [`（协议端日志读不到：${e.message}）`];
    paintTerm();
  }
}

/* ════════════════════════════════════════════════ 9. 页面显示时拉数据 ═══ */
/* ── 假 QQ 会话的轮询与回显（2026-10-21 · Win-v0.1.2 移植）────────────────
   1.5 秒轮询足够（输出频率是"人打一句"）；回显缓冲在前端也留一份，
   因为整页每 3 秒重建，`<pre>` 每次都是新节点。 */
function fakeOpts() {
  if (!S.extra.fakeOpt) S.extra.fakeOpt = { offline: false, sandbox: false };
  return S.extra.fakeOpt;
}
function fakeLines() { return Array.isArray(S.extra.fakeLines) ? S.extra.fakeLines : (S.extra.fakeLines = []); }
function paintFake() {
  const box = $id('fakeBody');
  if (!box) return;
  const lines = fakeLines();
  box.textContent = lines.length ? lines.join('\n') : '（还没启动 —— 点「启动会话」）';
  box.scrollTop = box.scrollHeight;
  const badge = $id('fakeBadge');
  if (badge) {
    const on = !!S.extra.fakeRunning;
    badge.textContent = on ? `会话在跑${S.extra.fakePid ? ` · pid ${S.extra.fakePid}` : ''}` : '没在跑';
    badge.className = `tag ${on ? 'ok' : 'plain'}`;
  }
}
async function fakeSay(text, clearInput = false) {
  if (!S.extra.fakeRunning) return toast('会话没在跑 —— 先点「启动会话」', 'warn');
  try {
    const r = await post('/api/fake-qq/send', { text });
    if (!r?.ok) return toast(r?.msg || '没发出去', 'bad');
    if (clearInput) { S.volatile['fake.text'] = ''; const el = $id('fake.text'); if (el) el.value = ''; }
    await fakePoll();
  } catch (e) { toast(`发送失败：${e.message}`, 'bad'); }
}
async function fakePoll() {
  try {
    const r = await api(`/api/fake-qq/state?since=${S.extra.fakeSince || 0}`);
    if (!r) return;
    const changedRun = Boolean(r.running) !== Boolean(S.extra.fakeRunning);
    S.extra.fakeRunning = !!r.running;
    S.extra.fakePid = r.pid || 0;
    const lines = fakeLines();
    for (const l of r.lines || []) lines.push(l.text);
    if (lines.length > 400) lines.splice(0, lines.length - 400);
    if (r.seq) S.extra.fakeSince = r.seq;
    // 跑/停切换时整页重画一次（按钮的 disabled 在渲染里定），平时只动回显框。
    if (changedRun) paintPage(false); else paintFake();
  } catch { /* 面板没响应就安静等下一轮 */ }
}
let fakeTimer = null;
function mountFake() {
  paintFake();
  if (!fakeTimer) {
    fakeTimer = setInterval(() => {
      if (!$id('fakeBody')) { clearInterval(fakeTimer); fakeTimer = null; return; }
      fakePoll();
    }, 1500);
  }
  fakePoll();
}

function onPageShown(su) {
  const ids = new Set((su.cards || []).flatMap((c) => (c.ctrls || []).map((x) => x.t)));
  if (ids.has('sesList') && !S.extra.sessions) loadSessions();
  if (ids.has('chatList') && !S.extra.chats) loadChats();
  if (ids.has('logList')) loadLogs();
  if (ids.has('auditList')) loadAudit();
  if (ids.has('termView')) mountTerm();
  if (ids.has('fakeView')) mountFake();
  /* 人设六页（2026-10-25）：整页渲染，需要在每次重画后对齐字数 / 滑块视觉。 */
  if (['psnOverview', 'psnProfile', 'psnMbti', 'psnEnhance', 'psnMood', 'psnPrompt'].some((t) => ids.has(t))) {
    psnMountPersona();
  }
  mountLiquidSwitches();
  mountMorphIcons();
  mountTicks();
  mountRouteSort();
  markTiltables();
  mountSegHp();
  if (ids.has('overviewDash') || ids.has('overviewSide')) ovMountOverview();
}

/* ── 分段选择器的滑动高亮块（.seg → .seg-hp）────────────────────────────
   机制取自 Watermelon Highlight（wm-hl）：
     MIT，Copyright (c) 2026 Watermelon Platform Contributors。
     上游做法照抄：一块 position:absolute 的块 + 按选中项 offset 写 transform，
     首次定位后加 `.lit` 淡入（原文见 demos/js.txt 的 `hp.style.transform = 'translateY(' + (it.offsetTop - items[0].offsetTop) + 'px)'`）。
   本项目改写（与 style.css 同名注释成对）：按 `:checked` 定位（上游按 hover）、水平轴、
   宽度随标签变化、时长走 --dur 令牌、减弱动效时直接落位。
   ⚠️ `paintPage` 每 3 秒整页重建 ⇒ 每次重建后都要重挂；**坐标现量不缓存**
      —— 缓存会在重建后错位，而且不会有任何报错（本仓典型的静默失效形状）。 */
function mountSegHp() {
  document.querySelectorAll('#page .seg').forEach((seg, k) => positionSegHp(seg, false, k));
}

/* 记住每一处 `.seg` 上一次的高亮位置（键 = 控件 id，退化时用页内序号）。
   ⚠️ 为什么必须「记住」：`paintPage` 每次整页重建 `#page`，`change` 一发生旧节点就被换掉
      —— 于是 CSS `transition` 永远没有机会跑（新节点一出现就已经在终点）。
      真机实测：点完 120ms 内旧 `.seg` 即被卸载，逐帧采样只能拿到 2 个值。
      ⇒ 动画必须**跨节点**做：在新节点上从**旧坐标**用 WAAPI 滑到新坐标。 */
const SEG_POS = new Map();

/** 读 `--dur` 令牌并转成毫秒（不写死 160：本仓时长只有令牌一处来源）。 */
function segDurMs(hp) {
  const v = getComputedStyle(hp).getPropertyValue('--dur').trim();   // 形如 ".16s"
  const n = parseFloat(v) || 0.16;
  return /ms$/.test(v) ? n : n * 1000;
}

function positionSegHp(seg, animate, fallbackKey) {
  let hp = seg.querySelector(':scope > .seg-hp');
  if (!hp) {
    hp = document.createElement('span');
    hp.className = 'seg-hp';
    hp.setAttribute('aria-hidden', 'true');
    seg.insertBefore(hp, seg.firstChild);
  }
  const labels = [...seg.querySelectorAll(':scope > label')];
  if (!labels.length) return;
  const cur = labels.find((l) => l.querySelector('input:checked')) || labels[0];
  const x = cur.offsetLeft - labels[0].offsetLeft;
  const w = cur.offsetWidth;
  const key = seg.dataset.seg || `#${fallbackKey ?? 0}`;
  const prev = SEG_POS.get(key);
  SEG_POS.set(key, { x, w });

  const M = window.Motion;
  const reduced = M ? M.reducedMotion() : false;
  const moved = prev && (prev.x !== x || prev.w !== w);

  /* 直接落位：首帧 / 没变 / 减弱动效 —— 一律先关过渡再写值，避免"从 0 长出来" */
  if (!animate || !moved || reduced) {
    hp.style.transform = `translateX(${x}px)`;
    hp.style.width = `${w}px`;
    seg.classList.add('lit');
    return;
  }

  hp.style.transform = `translateX(${x}px)`;
  hp.style.width = `${w}px`;
  seg.classList.add('lit');
  hp.animate(
    [{ transform: `translateX(${prev.x}px)`, width: `${prev.w}px` },
      { transform: `translateX(${x}px)`, width: `${w}px` }],
    { duration: segDurMs(hp), easing: 'cubic-bezier(.4, 0, .2, 1)' },
  );
}

/**
 * 卡片微倾**总闸**。改成 `false` ⇒ `markTiltables()` 一行样式都不加，
 * 并且把上一轮已挂的 `data-tilt` **清掉** —— 卡片回到完全静止。
 *
 * ⚠️ 为什么要留这个开关（本项目其它动效都有同款：`SORTABLE_ON` / `G_ENABLED` /
 *    `LIQUID_ON`）：这是个**纯装饰、零功能价值**的效果，一旦它与用户的观感
 *    发生冲突，"能一行关掉并确认"比"再猜一轮"重要得多。
 * ⚠️ 关掉时**必须清标记**：只 `return` 的话上一轮挂上去的 `data-tilt` 还在，
 *    表现是"关了还在动"，而那会让人以为开关没生效。
 */
const TILT_ON = true;

/**
 * 给"可以 3D 倾斜"的元素打标记 —— **唯一一处决定"哪些能斜"**。
 *
 * ── 挂什么（按用户 2026-10-04 的四条实测反馈定的，与第一版相反）────────────
 *   · **只挂大板块** `section.card`。「不希望里面的小方块也动」⇒
 *     `.metric` / `.sg` 之类的卡内小块**一律不挂**（第一版全挂过，是错的）。
 *   · **不再按"卡里有没有输入控件"整张跳过**。那是第一版我按
 *     "倾斜会让点击坐标偏移"的理由加的 —— 但 1° 下的偏移肉眼不可见，
 *     而"同一页里有的卡会动、有的不会"是**更容易被读成故障**的困惑
 *     （用户原话：「有些有效果，有些没有效果」）。⇒ 取消，全部挂。
 *   · 真要排除某一类，给它 `data-tilt="off"`（唯一例外口子，写在卡片上而不是这里）。
 *
 * ⚠️ 它必须是 `onPageShown` 的一部分 —— `paintPage()` 每 3 秒 `innerHTML`
 * 重建一次，属性写在元素上，活不过一轮。
 * ⚠️ `data-tilt="off"` 的卡**不要覆盖**成 `''`（那会让"明确排除"变成"明确开启"）。
 */
function markTiltables() {
  if (!TILT_ON) {
    document.querySelectorAll('[data-tilt]').forEach((el) => el.removeAttribute('data-tilt'));
    return;
  }
  document.querySelectorAll('section.card').forEach((el) => {
    if (el.getAttribute('data-tilt') === 'off') return;
    /* ⚠️⚠️ **每块板各自挂**（含插件板 `.pcard`）—— 2026-10-08 用户裁定。
       曾经试过把 `.pgrid` 当成"一个倾斜单元"（板自己不挂、靠父级 transform 一起动），
       因为用户先说"有些小插件没有倾斜"。**用户看到截图后明确否掉了那个做法**：
       「你现在是整个小插件群在动……我是要**每个单独的小玻璃**可以动，
        而不是把这些都**搓成一坨**弄」。
       ⇒ 所以：每块玻璃板就是一个独立个体，鼠标移到哪一块，**那一块**倾斜。
       （`.pcard` 是 `section.card`，这条选择器本来就会命中它，不需要特判。） */
    el.setAttribute('data-tilt', '');
  });
  /* ⚠️ 标注完必须**把倾斜状态认回来**：这次 `paintPage` 刚把上一轮的元素全换掉，
     而鼠标很可能正停在其中一张卡上 —— 不认回来，卡片就会"自己正一下再斜回来"
     （每 3 秒一次）。见 `tilt.js` 的 `resync()`。 */
  if (window.Tilt && window.Tilt.resync) window.Tilt.resync();
}

/* ══════════════════════════════════════════════════════════════════════════
   档位刻度的交互挂载（2026-10-02）
   ══════════════════════════════════════════════════════════════════════════
   ⚠️ **整行一个 handler，不是每格一个** —— 这条判例值得记住：

     每格各挂 onPointerEnter 是最顺手的写法，而它**只对鼠标有效**。
     触摸会被"起始命中"的那一格捕获：手指从一端划到另一端，浏览器把后续所有
     事件**仍然发给起手那一格**，其余格的 enter 永远不触发 —— 刻度尺**卡住不动**。
     不是事件没来，是**事件全都送到了同一个元素**。

     所以：行上一个 handler，档位下标由「指针实际在哪」算出来。
     鼠标划过第 12 格和手指拖过第 12 格，**同一段代码**，不再是两条路径。

   ── 其它三条纪律（与液态/变形层一致）────────────────────────────────
   · `paintPage()` 整页重建 ⇒ **幂等** + 重挂前回收。
   · 装饰层出问题**不影响功能**：真实写值走**原生 radio 的 change**，
     刻度层只是把 radio 点上。所以即使这段抛了，档位照样能改。
   · hover 是**预览不是提交**（`data-cursor`）；`pointerup` 才真正写值。
   ══════════════════════════════════════════════════════════════════════════ */

/** `宿主 .tkx` → 清理函数。`onPageShown` 里先跑一遍。 */
const _tickClean = [];

function mountTicks() {
  // 回收上一批
  for (const fn of _tickClean.splice(0)) { try { fn(); } catch { /* DOM 已不在 */ } }

  document.querySelectorAll('.tkx').forEach((box) => {
    const row = box.querySelector('[data-tk-row]');
    const native = box.querySelector('.tkx-native');
    if (!row || !native) return;
    const radios = [...native.querySelectorAll('input[type=radio]')];
    if (!radios.length) return;
    const n = radios.length;

    /* 客户端坐标 → 档位下标。
       横向进度条是**等分轨道**：每一档占 1/n，点/拖到哪一段就是哪一档。
       这比旧的"按每根刻度中点反查"更简单，也不会在右侧留白处把
       "点空白"判成最后一档 —— 因为整条轨道都是有效区域。
       ⚠️ 仍然必须用 `getBoundingClientRect()`，不能用 `offsetLeft`：
         面板会在 `transform: scale()` 的容器里渲染（实验室页），
         offset 仍是布局坐标而 clientX 是屏幕坐标，会差一个缩放倍数。 */
    const slotAt = (clientX) => {
      const b = row.getBoundingClientRect();
      if (!b || !b.width) return null;
      const t = (clientX - b.left) / b.width;
      return Math.min(n - 1, Math.max(0, Math.floor(t * n)));
    };
    const pctOf = (i) => Math.round(((i + 1) / n) * 1000) / 10;
    const labelOf = (i) => radios[i]?.parentElement?.querySelector('span')?.textContent || '';

    /* 光标预览：**只改样式，不写值**。液面、当前档名、标签高亮一起跟着走。
       ⚠️ 离开时传 null ⇒ 回到"真正选中的那一档"，不是停在最后悬停的位置。 */
    let cur = null;
    const paint = (i) => {
      const k = i == null ? radios.findIndex((r) => r.checked) : i;
      const kk = k < 0 ? 0 : k;
      box.style.setProperty('--p', `${pctOf(kk)}%`);
      const name = box.querySelector('.tkx-name');
      if (name) name.textContent = labelOf(kk);
      box.querySelectorAll('.tkx-legend > span').forEach((s, j) => s.toggleAttribute('data-on', j === kk));
      box.setAttribute('data-scrub', i == null ? '0' : '1');
      return kk;
    };
    const paintCursor = (i) => { paint(i); cur = i; };

    /* 真正提交：**点原生 radio**，让它去跑 change 绑定。
       ⚠️ 可视层**自己不改值** —— 那样就多了一条写值的路，
          而"一个元素一个写入口"是本项目的红线。
       ⚠️ 提交后必须**同步 aria-valuenow / valuetext 与液面**：
         漏了 ARIA ⇒ 读屏念旧档位；漏了液面 ⇒ 视觉停在旧档位，
         要等下一次 paintPage 才追上（看起来像"点了没反应"）。 */
    const commit = (i) => {
      if (i == null) return;
      const r = radios[i];
      if (r && !r.checked) r.click();     // click ⇒ change ⇒ 既有保存链路
      row.setAttribute('aria-valuenow', String(i));
      row.setAttribute('aria-valuetext', labelOf(i));
      paint(i);
    };

    let down = false;

    const onDown = (e) => {
      down = true;
      /* 指针捕获在"指针已不在"时会抛（合成事件、真实的手指已离开），
         而拖动不靠它也能用 —— 必须 try/catch。 */
      try { row.setPointerCapture(e.pointerId); } catch { /* 非活动指针 */ }
      paintCursor(slotAt(e.clientX));
    };
    const onMove = (e) => {
      /* 鼠标悬停就跟随；触摸必须按住 ——
         否则手指在滚动时路过这一行，档位也会跟着跳。 */
      if (e.pointerType !== 'mouse' && !down) return;
      paintCursor(slotAt(e.clientX));
    };
    const onUp = (e) => {
      /* 释放捕获同样会抛（从未成功捕获时）—— 必须 catch，
         否则后面的 commit 不会执行，档位"点不动"。 */
      try { row.releasePointerCapture(e.pointerId); } catch { /* 从未捕获 */ }
      if (down) { commit(cur); }
      down = false;
      paintCursor(null);
    };
    const onLeave = () => { if (!down) paintCursor(null); };

    /* 键盘：← → 在档位间移动。刻度是一个 slider，不是 radio group。
       ⚠️ 走 `commit(k)` 而不是直接 `click()` —— 否则 ARIA 不跟着更新
         （实测发现的那个不一致）。 */
    const onKey = (e) => {
      const base = radios.findIndex((r) => r.checked);
      const i = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? base + 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? base - 1
          : null;
      if (i == null) return;
      e.preventDefault();
      commit(Math.min(n - 1, Math.max(0, i)));
    };

    row.addEventListener('pointerdown', onDown);
    row.addEventListener('pointermove', onMove);
    row.addEventListener('pointerup', onUp);
    row.addEventListener('pointercancel', onUp);
    row.addEventListener('pointerleave', onLeave);
    row.addEventListener('keydown', onKey);

    _tickClean.push(() => {
      row.removeEventListener('pointerdown', onDown);
      row.removeEventListener('pointermove', onMove);
      row.removeEventListener('pointerup', onUp);
      row.removeEventListener('pointercancel', onUp);
      row.removeEventListener('pointerleave', onLeave);
      row.removeEventListener('keydown', onKey);
    });
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   图标变形接入层（2026-10-02 · 运行总览页重排）
   ══════════════════════════════════════════════════════════════════════════
   把按钮上的静态图标换成**可变形**的：状态一变（启动 → 停止），
   图标从 `play` **变形**成 `stop`，而不是突然换一张图。

   ── 纪律与液态开关完全一致 ────────────────────────────────────────────
   `paintPage()` 是整页 innerHTML 重建 ⇒ 挂上去的节点每3 秒被销毁一次。
   所以：**幂等**（可反复调用）、重挂前**先 destroy**（不rAF 泄漏）、
   失败**静默降级**为静态图标（装饰层出问题绝不影响功能）。

   ⚠️ **不做"上一个状态 → 下一个状态"的自动补间**：
      页面每 3 秒重渲染一次，若每次都补间，图标会**一直在动**（永远追不上）。
      正确做法是**只在状态真的变了的那一刻**变形 —— 而"变了"的判断必须
      跨渲染存活，所以状态存在 `_morphState`（模块级 Map）里，不存DOM。
   ══════════════════════════════════════════════════════════════════════════ */

/** 图标变形的总闸。关掉 ⇒ 全部退回静态图标（少建 N 个动画实例）。 */
const MORPH_ON = true;

/** `按钮元素` → { inst, lastTo }。 */
const _morphMap = new Map();

/** `动作名` → 目标图标名。**跨渲染存**，因为 DOM 每 3 秒被重建，
 *  写在元素上的属性活不过一轮。
 *  ⚠️ 键用 `data-a`（动作名）而不是元素引用 —— 元素每次都是新对象。
 *  ⚠️ 它必须在 `mountMorphIcons` **之前**声明：`const` 有 TDZ，
 *     「声明在使用点后面」在这里会真的抛 ReferenceError。 */
const _morphState = new Map();

function mountMorphIcons() {
  // 先回收：它们的 DOM 已经被 innerHTML 清掉了
  for (const rec of _morphMap.values()) {
    try { rec.inst.destroy(); } catch { /* 已不在文档里，destroy 也无害 */ }
  }
  _morphMap.clear();
  if (!MORPH_ON || !window.Morph) return;

  document.querySelectorAll('button[data-ico][data-morph-to]').forEach((btn) => {
    const from = btn.dataset.ico;
    const to = btn.dataset.morphTo;
    // 名字不存在就不建实例 —— 静态 SVG 留在那儿，页面照常工作
    if (!window.Icons.has(from) || !window.Icons.has(to)) return;
    // 静态的（不需要形变）也建，但要直接落到终态，省一次动画
    const prev = _morphState.get(btn.dataset.a);
    _morphState.set(btn.dataset.a, to);

    let inst;
    try {
      inst = window.Morph.create(from, { size: 16, speed: 62 });
    } catch {
      return; // 起不来就保留静态 SVG
    }
    const old = btn.querySelector('svg');
    if (old) old.replaceWith(inst.el);
    else btn.insertBefore(inst.el, btn.firstChild);

    /* 只有「跨渲染**真的**变了」才补间：
       -首次挂载（prev 为空）直接落到目标态，不放进场动画；
       - prev === to 说明状态没变，页面重渲染不该让图标再动一次。 */
    if (prev && prev !== to) inst.morphTo(to);
    else inst.set(to);

    _morphMap.set(btn, { inst, lastTo: to });
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   液态开关接入层（2026-10-02 UI 升级轮）
   ══════════════════════════════════════════════════════════════════════════
   给能力开关（联网查询 / 识图 / 发表情）套上液态 goo。**只有这三处** ——
   列表行内的技能/记忆/作息/插件开关（`.sw.flat`，行高 26px）**保持原样**。

   ── 为什么只改这三处（三条都基于实测，不是偏好）──────────────────────
   ① `style.css` 开头那条主线：「安静的仪表盘」，且明写
      **"所有动效只用于状态变化，不做进入动画"**。7 处全换会让密集中文界面失焦。
   ② 几何不兼容：行内开关是 40×22 且所在行只有 26px 高，
      液态形态（哪怕缩到mini 档 40×22）加上 goo 的溢出会在密集列表里糊成一片。
   ③ 交互冲突：行内开关是**批量勾选**用的，液态滑块是可拖的 ⇒ 误触风险。

   ── 最要紧的一条：这里是**渐进增强**，不是替换 ─────────────────────────
   `paintPage()` 用 `$id('page').innerHTML = html` **整页重建**，
   任何挂上去的 DOM 节点每 3 秒轮询都会被销毁重建。所以：

     · **原生 checkbox 始终是唯一事实源**（它才是被 change 事件绑定、被读值的那个）
     · 液态层是**纯装饰**，盖在 `.track` 上面，点击**穿透**给原生 input
     · 重渲染后由 `onPageShown` 重新挂载，**不依赖任何状态**

   这样做的三个好处：① 关掉 `LIQUID_ON` 就完全退回原生，一行不改；
   ② 液态层出任何问题都**不影响功能**（最坏是看不见装饰）；
   ③ `destroy()` 在重挂前统一调用，**不rAF 泄漏**。

   ⚠️ 不要改成"用液态组件替换原生 input"：那样 change 事件的数据绑定、
      键盘可达性、disabled 态全都要重写，而收益只是好看一点。
   ══════════════════════════════════════════════════════════════════════════ */

/** 总闸。2026-10-23 起关掉：所有开关统一改用 .sw .track 的弹性滑块
    （uiverse sour-vampirebat-66 配方）；液态层文件与接线保留，改回 true 即恢复。 */
const LIQUID_ON = false;

/** 已挂载的实例：`宿主 label` → { ctl, liquid }。重挂前统一 destroy。 */
const _liqMounted = new Map();

/**
 * 挂载液态层到能力开关上。
 * 由 `onPageShown` 调用（每次整页重渲染后），所以必须是**幂等**的。
 */
function mountLiquidSwitches() {
  if (!LIQUID_ON || !window.LiquidToggle) return;

  // 先回收上一批的实例 —— 它们的 DOM 已经被 innerHTML 清掉了
  for (const rec of _liqMounted.values()) {
    try { rec.liquid.destroy(); } catch { /* 已经不在文档里，destroy 也无害 */ }
  }
  _liqMounted.clear();

  document.querySelectorAll('.sw.liq-host').forEach((host) => {
    const input = host.querySelector('input[type=checkbox]');
    const track = host.querySelector('.track');
    // 三个前提缺一不可：原生 input 在、track 在、且没被 disabled
    if (!input || !track || input.disabled) return;

    const label = (host.querySelector('.txt')?.textContent || '').trim();
    let liquid;
    try {
      liquid = window.LiquidToggle.create({
        size: 'mini',
        on: input.checked,
        label: label || '开关',
        // 交互交给原生 checkbox：这里**只反映**状态，不接受点击
        onChange: null,
      });
    } catch {
      return; // 组件起不来就当没这层装饰 —— 功能不受影响
    }

    // 盖在 .track 上：同样的几何，靠 CSS 定位
    track.style.position = 'relative';
    track.appendChild(liquid.el);

    // 装饰层**不接管指针**：点它等于点下面的原生 input
    liquid.el.style.pointerEvents = 'none';
    liquid.el.style.position = 'absolute';
    liquid.el.style.inset = '0';
    liquid.el.style.display = 'block';

    // 原来那颗 CSS 小圆点要藏掉（液态层已经包含液滴）。
    // ⚠️ 靠**类**告诉样式表"这里有液态层"，不要用内联自定义属性 + 属性选择器
    //    去判 —— `[style*="--x"]` 匹配的是字面量文本，自定义属性的序列化
    //    不保证保留你要的那段，会在"该藏没藏"的地方静默失败。
    host.classList.add('liq-on');

    // 状态跟随：原生 input 是唯一事实源，这里只做单向镜像
    // ⚠️ 用 `sync()` 而不是 `set()` —— `set()` 语义是"用户操作"（会触发 onChange），
    // 装饰层只是跟随，用set 会在同步时反向触发回调，可能形成
    // "读状态 → 写配置 → 再读状态"的回环。
    const sync = () => liquid.sync(input.checked);
    input.addEventListener('change', sync);
    _liqMounted.set(host, { ctl: liquid, input, sync });
  });
}
async function loadSessions() {
  try { S.extra.sessions = await api('/api/sessions'); softPaint(); } catch (e) { /* 演示模式下静默 */ }
}
async function loadChats() {
  try { S.extra.chats = await api('/api/chats'); softPaint(); } catch { /* 同上 */ }
}
async function loadLogs() {
  try {
    const d = await api(`/api/logs?since=${S.logCursor}`);
    const fresh = Array.isArray(d.lines) ? d.lines : [];
    const reset = Boolean(d.reset) || !S.extra.logs;
    /* ⚠️⚠️ 没有新行就**不重画**（2026-10-21 · 真机 bug 根因之一）：
       `onPageShown()` 每次重画都会再调本函数，而本函数末尾的 `softPaint()`
       又会触发下一次重画 —— 一行不判就是一个本地回环（实测每秒上千次）。
       回环把 `syncNav2Indicator()` 变成每帧重启弹簧，最终让二级滑块数值发散、
       飞出导航条并被裁掉。守卫之后：有新行才重画，回环在第二轮自然停下。 */
    if (!reset && !fresh.length) return;
    if (reset) S.extra.logs = { lines: [] };
    S.extra.logs.lines = S.extra.logs.lines.concat(fresh).slice(-400);
    S.logCursor = d.total || 0;
    softPaint();
  } catch { /* 同上 */ }
}
async function loadAudit() {
  try {
    const next = await api('/api/audit?limit=200');
    /* 同 loadLogs：内容没变就不重画，否则 onPageShown 会把它变成取数回环。 */
    const sig = JSON.stringify(next || []);
    if (S.extra.auditSig === sig) return;
    S.extra.audit = next;
    S.extra.auditSig = sig;
    softPaint();
  } catch { /* 同上 */ }
}
/**
 * 读出**当前服务商**的模型清单（给右侧「云端设置」的下拉用）。
 *
 * @param {boolean} [quiet] 静默：成功不弹提示，失败也不弹。
 *   切换大脑后自动调用时要传 `true` —— 那时拉不到（还没填 Key、网关不提供 /models、
 *   或者就是自定义那个地址不支持）**不是切换失败**，不该拿一条红色提示吓人。
 *   用户看得见结果：下拉里仍然是当前那一个模型，想重试就自己点「读取」。
 *
 * ⚠️ 重绘放在 try/catch **之后**：静默失败时也必须把"只剩当前那个"画出来，
 *    否则界面上还留着**上一个服务商**的模型名 —— 用户会以为还能选，而选了是错的。
 */
async function loadModels(quiet = false) {
  try {
    const provider = j(S.state, ['config', 'provider'], 'zhipu');
    const r = await api(`/api/models?provider=${provider}`);
    S.extra.models = r.models || [];
    if (!quiet) toast(`读到 ${S.extra.models.length} 个模型`, 'ok');
  } catch (e) { if (!quiet) toast(`读取失败：${e.message}`, 'bad'); }
  paintPage(false);
}

/**
 * 切换大脑之后，把新服务商的模型清单**自动**读出来。
 *
 * 用户报的 bug（2026-10-07）：从智谱切到千问，右侧下拉里只剩当前那一个模型，
 * 必须手动点「读取」才出得来剩下的。原因很直白：列表是**懒加载**的 ——
 * 只有点「读取」时才会去问新服务商"你有哪些模型"，而切换本身不会触发它。
 */
async function refreshModelsAfterSwitch() {
  const provider = j(S.state, ['config', 'provider'], '');
  // 本机没有"云端模型清单"这一说 —— 它的规格是本机已装的那些，走另一份。
  if (provider === 'local') return;
  S.extra.models = []; // 先清掉旧服务商的，避免短暂出现一组不属于它的模型名
  await loadModels(true);
}

/* ════════════════════════════════════════════════ 10. 事件 ═══ */
/**
 * 由事件处理器**内联**处理的动作名（不经过 ACTIONS 表）。
 *
 * 它同时是"接线自检"的判据来源 —— 名字只在这里写一次。
 * 加一个新动作时：要么进 `ACTIONS`，要么进这个数组，**没有第三种**；
 * 漏了就会被 `auditActions()` 当场报成 console.error（自检脚本会把它当失败）。
 */
const INLINE_ACTIONS = [
  'tag.del', 'models.load', 'model.pick', 'model.free',
  'sessions.load', 'sessions.open', 'chats.load', 'chats.open',
  'logs.load', 'audit.load', 'packages.load',
  'route.up', 'route.down', 'route.del', 'route.add', 'route.reset', 'route.undo', 'route.clean',
  'plugin.toggle', 'plugin.set', 'memlist.set', 'memlist.del', 'memlist.add',
  'sched.set', 'skill.set', 'skill.del', 'cg.fill',
  'holidays.add', 'holidays.del', 'holidays.kind', 'holidays.ren',
  'import.file', 'zip.file', 'zip.pick',
  'field', 'field-local', 'feat', '__modal', '__modal-close',
];

/**
 * 由**全局点击处理器里的特判分支**处理的动作名（顶栏与草稿保存条那四个）。
 *
 * 为什么不并进 `INLINE_ACTIONS`：那几个分支是"按名字直接调函数"，而它们的名字带
 * **连字符**（`onekey-start`），与 `ACTIONS` 表的点号命名（`onekey.start`）刻意不同形 ——
 * 并进去会让人误以为 `ACTIONS['onekey-start']` 存在。
 * 但自检**必须认识**它们：否则顶栏那两个按钮会被判成"没有处理者"，
 * 而这四个按钮正是历史上一整批静默失效过的位置（当时属性名写成了 `data-act`）。
 */
const SHELL_ACTIONS = ['onekey-start', 'onekey-stop', 'draft-save', 'draft-discard'];

/** 当前页渲染完之后扫一遍：页面上每个 `data-a` 都必须有处理者。 */
let auditedKey = '';
function auditActions() {
  const key = `${S.gi}/${S.si}`;
  if (key === auditedKey) return;
  auditedKey = key;
  const known = new Set([...Object.keys(ACTIONS), ...INLINE_ACTIONS, ...SHELL_ACTIONS]);
  const unknown = new Set();
  // ⚠️ 范围 = **页面主体 + 顶栏 + 保存条**（这三处才有静态写死的 `data-a`）。
  //    以前这里还圈了一个 `#tabs` —— 那是**旧页面**的元素 id，旧页面删掉之后
  //    它永远匹配不到：一个查不到东西的选择器不会报错，只会让自检悄悄少查一块。
  //    顶栏那四个名字靠 `SHELL_ACTIONS` 才认得出来，别把它删了。
  for (const el of document.querySelectorAll('#page [data-a], .topbar [data-a], .savebar [data-a], #settingsPanel [data-a]')) {
    const a = el.dataset.a;
    if (!known.has(a) && !a.startsWith('export.')) unknown.add(a);
  }
  for (const a of unknown) {
    console.error(`[接线] 页面上有动作「${a}」没有处理者 —— 点它不会有任何反应（补进 ACTIONS 或 INLINE_ACTIONS）`);
  }
}

/* `.seg` 选中态变化：**委托一次**，不随 3 秒重建重复绑定。
   （给每次重建出来的新元素各绑一次 = 监听器随轮询累积，是本仓反复踩过的泄漏形状。） */
document.addEventListener('change', (ev) => {
  const inp = ev.target;
  if (!(inp instanceof HTMLInputElement) || inp.type !== 'radio') return;
  const seg = inp.closest('.seg');
  if (seg) positionSegHp(seg, true);
});

/* 一级按压：只委托一次；press 环随按钮下沉，松开后交还选中环。 */
document.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0 || !(ev.target instanceof Element)) return;
  const btn = ev.target.closest('#navInner .grp');
  if (btn) navPressAt(btn);
}, { passive: true });
document.addEventListener('pointerup', navPressEnd, { passive: true });
document.addEventListener('pointercancel', navPressEnd, { passive: true });
addEventListener('blur', navPressEnd);

document.addEventListener('click', async (ev) => {
  // 状态卡上的「点击前往对应页」：data-go="组id/子页id"（2026-10-22）。
  // 用**id**而不是索引：插/删页签时索引会漂，id 不会。
  const goEl = ev.target.closest('[data-go]');
  if (goEl) {
    const [gid, sid] = String(goEl.dataset.go || '').split('/');
    const gi = GROUPS.findIndex((g) => g.id === gid);
    const si = gi >= 0 ? GROUPS[gi].subs.findIndex((s) => s.id === sid) : -1;
    if (gi >= 0 && si >= 0) {
      const sameGroup = gi === S.gi;
      S.gi = gi; S.si = si;
      paintPage(true, sameGroup ? { nav1: false, nav2: false } : undefined);
      window.scrollTo({ top: 0 }); return;
    }
  }
  const nav1 = ev.target.closest('#nav1 .grp');
  if (nav1) {
    /* 转场播放期间整条一级栏都不响应：overlay 已经盖住页面，
       放行第二次切页只会让遮罩下的状态与画面错位。 */
    if (factoryWipeBusy()) return;
    const gi = Number(nav1.dataset.g);
    /* 跨「工厂」域才播：进工厂左→右，出工厂右→左；同域内保持瞬时切页。
       ⚠️ 设置层「外观 → 转场动画」关掉后 factoryWipeOn() 为 false，直接走下面的瞬时切页。
       ⚠️ 只在**真实用户点击**上播（isTrusted）：转场把切页压到盖满那一刻（约 0.9s），
          而 `element.click()` 的自动化遍历会在这 0.9s 里继续点下一页 —— 延迟切页会
          打乱逐页遍历的节奏（panel/next/verify.mjs 正是这样点的）。真实鼠标/键盘
          事件都是 trusted，用户侧不受影响；手动复现转场用 window.__factoryWipe.play()。 */
    if (FACTORY_GI >= 0 && ev.isTrusted && factoryWipeOn()
      && (gi === FACTORY_GI) !== (S.gi === FACTORY_GI)) {
      const forward = gi === FACTORY_GI;
      playFactoryWipe({
        direction: forward ? 'forward' : 'reverse',
        label: forward ? 'FACTORY' : 'CONSOLE',
        onCover: () => { S.gi = gi; S.si = 0; paintPage(true); window.scrollTo({ top: 0 }); },
      });
      return;
    }
    S.gi = gi; S.si = 0; paintPage(true); window.scrollTo({ top: 0 }); return;
  }
  const nav2 = ev.target.closest('#nav2 .sub');
  if (nav2) { S.si = Number(nav2.dataset.s); paintPage(true, { nav1: false, nav2: false }); window.scrollTo({ top: 0 }); return; }

  // 「自定义大脑」表单里的「填入」按钮：把该服务商的接口地址与默认模型写进输入框。
  //    ⚠️ 走**事件委托**而不是绑在节点上：弹窗的内容是每次打开重画的，绑上去会在下一次
  //       打开时失效（而症状只是"点了没反应"，看不出原因 —— 与右键菜单那条同一个理由）。
  //    ⚠️ 刻意**不注册成 action**：它不是 `data-a`，也就不进 `ACTIONS` / `INLINE_ACTIONS`
  //       与 `auditActions()` 的自检 —— 这只是个填表单的便利按钮，不该进动作面。
  const fillBtn = ev.target.closest('[data-bf-fill]');
  if (fillBtn) {
    const hit = brainPresetRows().find((r) => r.key === String(fillBtn.dataset.bfFill || ''));
    if (!hit) return;
    const bu = document.querySelector('[data-bf="baseUrl"]');
    const md = document.querySelector('[data-bf="model"]');
    if (bu) bu.value = hit.baseUrl;
    if (md && hit.model) md.value = hit.model;
    toast(`已填入 ${hit.baseUrl}${hit.model ? ` 与 ${hit.model}` : ''}`, 'ok');
    return;
  }

  const el = ev.target.closest('[data-a]');
  if (!el) return;
  const a = el.dataset.a, p = el.dataset.p;
  // 卡级补全的输入框：点它只是聚焦，不是动作（否则会落进 ACTIONS 的兜底提示）。
  if (a === 'cg.fill') return;

  /* 顶栏与保存条 */
  if (a === 'onekey-start') return ACTIONS['onekey.start']();
  if (a === 'onekey-stop') return ACTIONS['onekey.stop']();
  if (a === 'draft-save') return commitDraft();
  if (a === 'draft-discard') return discardDraft();
  if (a === 'tag.del') {
    const [cid, i] = String(p).split('|');
    const c = S.reg.get(cid); if (!c) return;
    const arr = (Array.isArray(valueOf(c)) ? valueOf(c) : String(valueOf(c) ?? '').split(/[,，\s]+/).filter(Boolean)).slice();
    arr.splice(Number(i), 1);
    setValue(c, arr); paintPage(false); return;
  }
  if (a === 'models.load') return loadModels();
  if (a === 'model.pick' || a === 'model.free') {
    const v = el.value;
    if (!v) return;
    try { const r = await post('/api/config', { model: v }); toast(r.autoDisabledMsg || `已切到 ${v}`, r.autoDisabledMsg ? 'warn' : 'ok'); await refresh(true); }
    catch (e) { toast(`失败：${e.message}`, 'bad'); }
    return;
  }
  if (a === 'sessions.load') return (S.extra.sessions = null, loadSessions());
  if (a === 'chats.load') return (S.extra.chats = null, loadChats());
  if (a === 'logs.load') return loadLogs();
  if (a === 'audit.load') return (S.extra.audit = null, loadAudit());
  if (a === 'sessions.open') {
    try { S.extra.sesDetail = await api(`/api/sessions/detail?key=${encodeURIComponent(p)}`); paintPage(false); } catch (e) { toast(e.message, 'bad'); } return;
  }
  if (a === 'chats.open') {
    try { S.extra.chatDetail = await api(`/api/chats/detail?key=${encodeURIComponent(p)}`); paintPage(false); } catch (e) { toast(e.message, 'bad'); } return;
  }
  if (a === 'packages.load') {
    try { const r = await api('/api/zhipu/packages?refresh=1'); S.extra.packages = r; paintPage(false); toast('已刷新', 'ok'); } catch (e) { toast(e.message, 'bad'); } return;
  }
  if (a === 'route.up' || a === 'route.down' || a === 'route.del' || a === 'route.add'
    || a === 'route.reset' || a === 'route.undo' || a === 'route.clean') {
    return routeAction(a, p);
  }
  if (a === 'plugin.toggle') {
    const kind = el?.dataset?.k === 'skill' ? 'skill' : 'plugin';
    const path = `extensions.${extNsOf(kind)}.enabled`;
    const arr = draftArr(path);
    const i = arr.indexOf(p);
    if (i >= 0) arr.splice(i, 1); else arr.push(p);
    touchC(path);
    markDirty(); paintPage(false);
    toast(i >= 0 ? `已取消勾选 ${p}` : `已勾选 ${p} —— 点底部「保存并生效」，然后重启机器人才生效`, 'warn');
    return;
  }
  if (a === 'memlist.set' || a === 'memlist.del' || a === 'memlist.add') return memListAction(a, p, el);
  if (a === 'sched.set') return schedAction(p, el);
  if (a === 'holidays.add') {
    const d = String($id('holiDate')?.value || '').trim();
    const k = String($id('holiKind')?.value || 'holiday');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return toast('先选一个日期', 'warn');
    setPath(S.draft.custom, `holidays.${d}`, k);
    touchC('holidays'); markDirty(); paintPage(false);
    toast(`已登记 ${d} —— 点底部「保存并生效」`, 'ok');
    return;
  }
  if (a === 'holidays.del') {
    const t = { ...(getPath(S.draft.custom, 'holidays') || (S.state || DEMO).custom?.holidays || {}) };
    delete t[p];
    setPath(S.draft.custom, 'holidays', t);
    touchC('holidays'); markDirty(); paintPage(false);
    return;
  }
  if (a === 'holidays.kind') {
    setPath(S.draft.custom, `holidays.${p}`, el.value);
    touchC('holidays'); markDirty();
    return;
  }
  if (a === 'skill.set' || a === 'skill.del') return skillAction(a, p, el);
  if (a === 'import.file') { /* 由 change 事件处理 */ return; }
  if (a === 'zip.file') { /* 由 change 事件处理 */ return; }
  if (a === 'zip.pick') { document.querySelector('[data-a="zip.file"]')?.click(); return; }
  if (a === 'export.all') return doExport('all');
  if (a === 'export.diag') return doExport('diag', 'zip');
  if (a.startsWith('export.')) return doExport(a.slice(7));
  // ⚠️ `feat` 与 `holidays.ren` 同样由 change 处理（2026-10-15 修 · B1 / Issue #5）：
  //    它们是 `data-a` 动作，click 会先于 change 冒到这里；此前只登记了 `field` 两个，
  //    于是点任一能力开关（识图 / 联网 / 表情）都会**同时**弹一条红字
  //    「未实现的动作：feat」—— 设置其实由 change 正常保存了（另一条 toast 是真的），
  //    但红字会让用户以为功能坏了。这两个名字必须与 `INLINE_ACTIONS` 逐项对齐。
  // `plugin.set` 同理（2026-10-23）：它以前只在 click 里读值 —— 而"点进输入框"
  // 会先触发一次 click（那时值还是旧的），打字只触发 change ⇒ 保存的是旧值/空串。
  // 现在 click 只登记、change 才提交；复选框的 click 之后也必有一次 change。
  if (['field', 'field-local', 'feat', 'holidays.ren', 'plugin.set'].includes(a)) return; // 由 change 处理

  const fn = ACTIONS[a];
  if (!fn) { toast(`未实现的动作：${a}`, 'bad'); return; }
  return fn(p, ev);
});

/* 插件工厂（iframe）里的两个入口：用控制台自己的弹窗实现，只认同源 + source 标记。 */
window.addEventListener('message', (ev) => {
  if (ev.origin !== location.origin) return;
  const d = ev.data || {};
  if (d.source !== 'estrella-factory') return;
  /* 人设工厂的「回到人格总览」：只接受 GROUPS 里真实存在的 group/sub，避免任意跳转。 */
  if (d.action === 'panel.goto') {
    const gi = GROUPS.findIndex((g) => g.id === String(d.group || ''));
    const si = gi >= 0 ? GROUPS[gi].subs.findIndex((s) => s.id === String(d.sub || '')) : -1;
    if (gi >= 0 && si >= 0) {
      S.gi = gi; S.si = si;
      paintPage(true);
      window.scrollTo({ top: 0 });
    }
    return;
  }
  /* 本版控制台只有 `installZip(file)` 这条老导入口（弹窗式的导入/创造提示词
     属于插件系统那一批，尚未合并）——所以这里按**本版实际有的能力**接线：
     导入 = 拉起 ZIP 选择器后交给 installZip；创造 = 说清楚为什么暂时不可用。 */
  if (d.action === 'plugin.import.file' && d.file instanceof Blob) {
    const f = new File([d.file], String(d.name || 'plugin.zip'), { type: 'application/zip' });
    installZip(f, d.kind === 'skill' ? 'skill' : 'plugin');
    return;
  }
  if (d.action === 'plugin.import') {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.zip,application/zip';
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      if (f) installZip(f);
    });
    inp.click();
  } else if (d.action === 'plugin.create') {
    toast('请在插件工厂页里填写创建信息。', 'warn');
  }
});

/* 进度条拖动中的**视觉**同步（2026-10-17）。
   ⚠️ 只改视觉，不写草稿：`change` 才是提交点（与输入框一致 —— 拖到一半就登记改动，
      会让保存条在用户还在拖的时候闪，也会让"拖出去又拖回来"留下一条假改动）。
   ⚠️ 用 document 级委托而不是逐元素绑：`paintPage()` 每 3 秒重建 `#page`，
      绑在节点上的监听会随节点一起消失（本项目在终端滚动条上踩过同款）。 */
document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (!el || el.type !== 'range' || el.dataset.a !== 'field') return;
  const x = S.reg.get(el.dataset.id);
  if (!x || x.t !== 'range') return;
  const box = el.closest('.rng');
  if (!box) return;
  const v = rngValOf(x, el.value);
  box.style.setProperty('--p', `${(rngPosOf(x, v) / 10).toFixed(2)}%`);
  const out = box.querySelector('.rng-val');
  if (out) out.textContent = rngFmt(x, v);
  el.setAttribute('aria-valuetext', rngFmt(x, v));
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  const a = el.dataset.a;

  if (a === 'feat') {
    const feat = el.dataset.feat;
    try {
      const r = await post('/api/config', { features: { [feat]: el.checked } });
      toast(r.autoDisabledMsg || `${j(S.state, ['featureLabels', feat], feat)} 已${el.checked ? '打开' : '关闭'}`,
        r.autoDisabledMsg ? 'warn' : 'ok');
      await refresh(true);
      // ⚠️ 服务端驳回（当前模型不支持该能力，已自动关回去）时，重画会被**自己**挡住
      //    （2026-10-15 修 · B2 / Issue #5）：`softPaint` 的守卫判到 `busyTyping()`
      //    为真就跳过重画（防打字时光标被吞）—— 而刚点的复选框正好就是
      //    `document.activeElement` ⇒ 重画被自己挡住，开关仍显示为"开"，
      //    要等焦点移开 + 一轮轮询（3 秒）才自己变回关。
      //    这里主动 `el.blur()` 再刷一次，让界面立刻与后端一致。
      if (r.autoDisabledMsg) { el.blur(); await refresh(true); }
    } catch (e) { toast(`失败：${e.message}`, 'bad'); await refresh(true); }
    return;
  }
  if (a === 'field' || a === 'field-local') {
    const x = S.reg.get(el.dataset.id);
    if (!x) return;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number' || (x.t === 'number')) v = Number(v);
    /* 进度条的 `value` 是**位置**（0–1000），不是业务值 —— 提交前必须经同一张
       换算表落回分钟，否则会把"位置"当"分钟"存进配置（拖到最右 = 300 分钟，
       而不是 5 小时；症状是"拖满了却只有 5 小时以外的某个值"）。 */
    if (x.t === 'range') v = rngValOf(x, el.value);
    if (x.t === 'tags') v = String(v).split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    if (a === 'field-local' || (!x.save && !x.bind && !x.bindSys)) { S.volatile[x.id] = v; paintPage(false); return; }
    if (x.save) {
      try {
        const req = x.save(v, S.state || DEMO);
        if (!req) return;
        await post(req.url, req.body);
        // ⚠️ 提示语可由控件声明（`savedMsg`）覆盖 —— "下次启动生效"这类设置上，
        //    通用文案「已生效」是句**假话**（保存成功 ≠ 立刻换了形态），
        //    而它会直接误导用户去刷新找变化。没声明的照旧用「已生效」。
        toast(x.savedMsg || '已生效', 'ok');
        await refresh(true);
      } catch (e) { toast(`失败：${e.message}`, 'bad'); await refresh(true); }
      return;
    }
    setValue(x, v);
    /* 人设六页（2026-10-25）：有些控件改完要立刻重画派生区域（生日 → 星座、
       MBTI 开关 → 片段文字）。**必须在 setValue 之后** —— 反了就会先画旧值再写草稿，
       界面停在上一秒，看起来像"改了没反应"。 */
    if (el.dataset.psnRepaint === '1') paintPage(false);
    return;
  }
  if (a === 'holidays.ren') {
    // 改日期 = 改**键**：删旧键、写新键（值原样搬过去）。渲染器用 `change` 而不是
    // `input`，所以不会在半途（2026-10-0）就执行一次 —— 那种中间态存下去是个坏键。
    const nd = String(el.value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nd) || nd === p) { paintPage(false); return; }
    const t = { ...(getPath(S.draft.custom, 'holidays') || (S.state || DEMO).custom?.holidays || {}) };
    const v = t[p];
    delete t[p];
    t[nd] = v;
    setPath(S.draft.custom, 'holidays', t);
    touchC('holidays'); markDirty(); paintPage(false);
    return;
  }
  if (a === 'plugin.set') { commitPluginSetting(el, el.dataset.p); return; }
  if (a === 'import.file') { const f = el.files?.[0]; if (f) previewImport(f); return; }
  if (a === 'zip.file') { const f = el.files?.[0]; if (f) installZip(f, el.dataset.k === 'skill' ? 'skill' : 'plugin'); return; }
});

/** 手动记忆那一行的输入框：按回车等于点「添加」。它**不是一个动作**（没有 data-a），
 *  所以不会出现在接线自检里 —— 自检只管"按钮点了有没有人接"。 */
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  if (ev.target.id === 'memNew') { ev.preventDefault(); memListAction('memlist.add'); }
  // 记忆检索框：回车等于点「搜」（同上，它也没有 data-a）。
  if (ev.target.id === 'memQ') { ev.preventDefault(); ACTIONS['mem.search'](); }
});

function memListAction(a, p, el) {
  const arr = draftArr('memory.manual');
  if (a === 'memlist.add') {
    const inp = $id('memNew') || document.querySelector('[data-a="memlist.new"]');
    const t = String(inp?.value || '').trim();
    if (!t) return toast('先写一条内容', 'warn');
    arr.push({ id: `m${Date.now().toString(36)}`, text: t, on: true, t: Date.now() });
    if (inp) inp.value = '';
    touchC('memory.manual'); markDirty(); paintPage(false); return;
  }
  const [i, k] = String(p).split('|');
  const it = arr[Number(i)]; if (!it) return;
  if (a === 'memlist.del') { arr.splice(Number(i), 1); } else { it[k] = k === 'on' ? el.checked : el.value; }
  touchC('memory.manual'); markDirty(); paintPage(false);
}
function schedAction(p, el) {
  const [i, k] = String(p).split('|');
  const arr = draftArr('trigger.scheduled');
  const it = arr[Number(i)]; if (!it) return;
  it[k] = k === 'enabled' ? el.checked : el.value;
  touchC('trigger.scheduled'); markDirty();
}
function skillAction(a, p, el) {
  const arr = draftArr('skills');
  if (a === 'skill.del') { arr.splice(Number(p), 1); touchC('skills'); markDirty(); paintPage(false); return; }
  const [i, k] = String(p).split('|');
  const sk = arr[Number(i)]; if (!sk) return;
  if (k === 'enabled') sk.enabled = el.checked;
  else if (k === 'triggers') sk.triggers = String(el.value).split(/[,，\s]+/).filter(Boolean);
  else if (k === 'scopeType') { sk.scope = { type: el.value, id: el.value === 'global' ? '' : (sk.scope?.id || '') }; }
  else if (k === 'scopeId') sk.scope = { type: sk.scope?.type || 'group', id: el.value.trim() };
  else sk[k] = el.value;
  touchC('skills'); markDirty(); paintPage(false);
}
/**
 * 线路板：上一次改顺序之前的样子。**模块级**而不是 DOM 上的 ——
 * `paintPage()` 每 3 秒 `innerHTML` 重建，写在元素上的属性活不过一轮。
 *
 * ⚠️ 它存的是**前端记忆里的旧顺序**，不是"再向服务端读一次"：
 * 服务端只保存当前值，旧值只有前端记得。所以它必须由「提交前」那一刻
 * 抓下来，漏抓一次撤销就退不回去了。
 * @type {{ids: string[], label: string, at: number}|null}
 */
let _routeUndo = null;

/**
 * 键盘重排之后，焦点该回到谁身上（被挪动的那一条的 id）。
 *
 * ⚠️ 为什么需要它：键盘重排 → `commitRouteOrder` → `saveRoute` → `refresh()`
 * → **整页 `innerHTML` 重建** ⇒ 焦点掉到 `<body>` ⇒ 用户"连按两次 ↓"
 * 第二次就不知道自己在哪了。而屏幕上看不出任何异常（只是那一次按键没反应）。
 *
 * ⚠️ 必须在**提交那一刻**记下来（那时焦点还在把手上）：重绘之后 `activeElement`
 * 已经是 `body`，再去读就晚了 —— 这是"取证时机早于失效时刻"的又一例。
 * ⚠️ `appendChild` 本身**不丢**焦点（DOM 移动保留焦点），丢焦点的是重绘。
 * @type {string|null}
 */
let _routeFocusId = null;

/** 上一批挂载的排序实例，重挂前统一 destroy（不 rAF 泄漏）。 */
let _rbInst = null;

/**
 * 挂载可排序列表到线路板上。由 `onPageShown` 调用（每 3 秒一次），**必须幂等**。
 *
 * ── 为什么接线点是这里，而不是排序引擎自己 ──────────────────────────────
 *   `paintPage()` 整页重建 ⇒ 挂上去的节点每 3 秒被销毁一次。
 *   解法是 `docs/MOTION-METHODOLOGY.md` §7.3 的 **a（幂等重挂 + 先 destroy）**：
 *   重挂前把上一批 `destroy()`，然后对着新 DOM 重新 `create`。
 *   引擎不存任何跨渲染的状态 —— 顺序的**事实源**始终是服务端那份配置，
 *   引擎只是这一轮 DOM 上的临时演出。
 */
function mountRouteSort() {
  // 先回收：它们的 DOM 已经被 innerHTML 清掉了
  if (_rbInst) { try { _rbInst.destroy(); } catch { /* 已不在文档里 */ } _rbInst = null; }
  if (!SORTABLE_ON || !window.Sortable) return;

  const root = document.querySelector('[data-rb]');
  if (!root) return;
  const items = root.querySelectorAll('.srt-item');
  if (items.length < 2) return;      // 一条线路没有"排序"可言，不挂

  const s = S.state || DEMO;
  try {
    _rbInst = window.Sortable.create({
      root,
      item: '.srt-item',
      handle: '.srt-grip',
      idAttr: 'data-srt-id',
      labelOf: (el) => (s.modelLabels?.[el.getAttribute('data-srt-id')] || el.getAttribute('data-srt-id') || ''),
      onCommit: (ids, meta) => commitRouteOrder(ids, meta),
      /* 动画收敛后**补一次被守卫挡掉的重绘**（标签文案要跟上）。
         ⚠️⚠️ 必须走 `softPaint()` 而**不是** `paintPage()` —— 三个守卫一个都不能少，
            而直接调 `paintPage` 会把它们全绕过：
              ① 正在拖：重建把手指下的节点换掉 ⇒ 拖拽当场断；
              ② 动画未收敛（`Sortable.busy()`）：刚 `play` 上去的让位动画被换掉 ⇒ "闪一下"；
              ③ **提交链路**：`commitRouteOrder` → `saveRoute` → `refresh()` 本身就是一次
                 完整重绘，在这里再插一次会把**键盘重排刚恢复的焦点**冲掉
                 ⇒ 连按两次 ↓ 第二次就不知道自己在哪。
            实测（verify）：绕过守卫时表现为「让位峰值只剩 2.00px」+「焦点跟随 false」
            +「撤销条要等到下一个周期才出现」。 */
      onSettled: () => softPaint(),
    });
  } catch {
    _rbInst = null;      // 起不来就退回纯 ↑↓ 按钮 —— 功能不受影响
  }
  /* 焦点还给"上一次键盘重排的那一条"（见 `_routeFocusId`）。
     ⚠️ 只在焦点**真的被甩到 body** 时还 —— 用户已经点到别处去了就别抢焦点。 */
  if (_routeFocusId) {
    const id = _routeFocusId;
    _routeFocusId = null;
    const cur = document.activeElement;
    if (!cur || cur === document.body) {
      const back = root.querySelector(`.srt-item[data-srt-id="${CSS.escape(id)}"] .srt-grip`);
      if (back) back.focus({ preventScroll: true });
    }
  }
}

/** 拖拽 / 键盘重排落地：抓一份撤销点，然后走原有的保存链路。 */
function commitRouteOrder(ids, meta) {
  const s = S.state || DEMO;
  const before = j(s, ['config', 'fallbackModels'], []) || [];
  const movedId = (meta && meta.movedId) || '';
  const labelOf = (m) => (s.modelLabels?.[m] || m || '');
  if (before.join(' ') !== ids.join(' ')) {
    _routeUndo = {
      ids: before.slice(),
      label: labelOf(movedId || ids[0]),
      at: before.indexOf(movedId),
    };
    /* 焦点只在**键盘路径**上要还：指针路径下焦点本来就跟着指针走，
       而且拖拽结束时用户的手刚离开把手，抢焦点反而更烦。
       ⚠️ 记的是 `movedId`（引擎给的那一条），不是 `activeElement` 反查 ——
       后者要靠"哪个 item 里含 activeElement"，多一步、多一处能错的地方。 */
    const act = document.activeElement;
    const onGrip = act && act.closest ? act.closest('.srt-grip') : null;
    _routeFocusId = onGrip && movedId ? movedId : null;
  }
  saveRoute(ids);
}

function routeAction(a, p) {
  const list = (j(S.state, ['config', 'fallbackModels'], []) || []).slice();
  const i = Number(p);
  if (a === 'route.up' || a === 'route.down') {
    const to = a === 'route.up' ? i - 1 : i + 1;
    if (to < 0 || to >= list.length) return;      // 已在两端：不发请求，也不弹提示
    /* 有排序实例就让**引擎**改顺序（带弹簧让位），它回调 `commitRouteOrder`
       去保存。没有实例（总闸关 / 起不来）才退回原来的直接换位 ——
       两条路都通向同一个 `saveRoute`，功能不依赖动效。 */
    if (_rbInst) {
      const next = list.slice();
      const [x] = next.splice(i, 1);
      next.splice(to, 0, x);
      _rbInst.applyIds(next, { via: 'button', movedId: list[i] });
      return;
    }
    [list[i], list[to]] = [list[to], list[i]];
  }
  else if (a === 'route.del') { if (list.length <= 1) return toast('线路至少要留一条', 'warn'); list.splice(i, 1); }
  else if (a === 'route.add') { if (!list.includes(p)) list.push(p); }
  else if (a === 'route.undo') {
    const u = _routeUndo;
    if (!u) return toast('没有可撤销的改顺序', 'warn');
    _routeUndo = null;
    if (_rbInst) { _rbInst.applyIds(u.ids, { via: 'undo' }); return; }
    return saveRoute(u.ids);
  }
  else if (a === 'route.reset') return resetRoute();
  else if (a === 'route.clean') return cleanRoute();
  saveRoute(list);
}
/**
 * 「恢复实测最优」。
 *
 * ⚠️ 以前写死取 `state.zhipuDefaultChain` —— 在**千问**页面上按一下，提交上去的是一条
 *    GLM 链（`/api/config` 对千问刻意放行跨家名字，见 `modelProviderMismatch`），
 *    于是得到"选了千问、降级链全是 GLM、一条都打不通"这种状态（2026-10-17 用户截图）。
 *    现在按**当前这家**取默认链（`state.defaultChain`，判据住 `models.js` 的 `defaultChainOf`）。
 * ⚠️ `defaultChain` **含主模型**，而线路板存的是主模型**之后**的那几条
 *    （`/api/config` 会再把与主模型重复的静默剔掉），所以这里先把它滤掉。
 */
async function resetRoute() {
  const s = S.state || DEMO;
  let def = j(s, ['defaultChain'], null);
  if (!Array.isArray(def) && j(s, ['config', 'provider']) === 'zhipu') {
    def = j(s, ['zhipuDefaultChain'], null);   // 老后端没下发 defaultChain 时的回落
  }
  if (!Array.isArray(def) || !def.length) {
    return toast('这家没有「实测最优」的默认线路 —— 从下面的候选模型里挑几条加进来', 'warn');
  }
  const cur = String(j(s, ['config', 'model'], '') || '');
  saveRoute(def.filter((m) => m !== cur));
}
/**
 * 「清掉不属于这家的」：把链里那些**这一家的模型清单里没有**的条目剔掉再存。
 *
 * 只为已经存坏的老数据准备（新数据在 `/api/config` 就被拦了）。
 * 判据与后端同源：`state.modelCaps[provider]` 的键（后端 `modelsOfProvider()` 下发的同一份）。
 */
async function cleanRoute() {
  const s = S.state || DEMO;
  const provider = j(s, ['config', 'provider'], '');
  /* ⚠️ 本机 / 自建网关**不清**：模型名是那边的推理服务自己起的，我们手上没有名单，
     "清单里没有"在这两种场合不构成依据（与后端 `chainForProvider` 同一条判据）。 */
  if (provider === 'local' || provider === 'other') {
    return toast('这家（本机 / 自建网关）的模型名由服务自己定，没有"不属于这家"这回事', 'warn');
  }
  const known = new Set(Object.keys(j(s, ['modelCaps', provider], null) || {}));
  const list = j(s, ['config', 'fallbackModels'], []) || [];
  const kept = known.size ? list.filter((m) => known.has(m)) : list;
  if (kept.length === list.length) return toast('这条链里都是这家的模型，不用清', 'warn');
  await saveRoute(kept);
}
async function saveRoute(list) {
  if (!S.online) return DEMO_BLOCK();
  try {
    const r = await post('/api/config', { fallbackModels: list });
    toast(r.autoDisabledMsg || '线路已更新', r.autoDisabledMsg ? 'warn' : 'ok');
    await refresh(true);
  } catch (e) { toast(`失败：${e.message}`, 'bad'); }
}

/* 主题（只影响这一页，不进配置、不发写请求）
   ── 圆形深浅切换（2026-10-04）────────────────────────────────────────
   beui「Theme Toggle」circle-blur 变体的零构建移植：点击后整页经
   View Transition API 以**按钮圆心**为发散点圆形揭开，揭开边缘带
   8px→0 的模糊（配方取原件，发散位置按用户裁决用我们的按钮，不是
   beui 默认的 bottom-up）。动画 CSS 在 style.css「深浅切换的整页揭开」段。
   降级三档（任一命中就退回"直接换"，页面照常能用，只是没有揭开动画）：
     ① 总闸 THEME_VT_ON 关 ② prefers-reduced-motion ③ 无 startViewTransition。
   ⚠️ `data-vt` 挂在 html 上、动画结束**必须摘掉**：VT 伪元素的选择器
      靠它分型，忘摘的表现是旧快照被 animation:none 钉住 —— 看起来像
      "下一次换主题没动画"。 */
const THEME_VT_ON = true;
function themeDark() { return document.documentElement.dataset.theme === 'dark'; }
/* 偏好键名从 `window.__themeBoot` 取，**不在这里写字面量**（2026-10-04 改）。
   ⚠️ 为什么连"写"也要共用：键名是同一份语义（"这个人的面板配色偏好"），
      它出现在两个文件里就等于有了两份可以漂移的拷贝 —— 漂移的表现是
      "换了主题但刷新后不记得"，而且**不报错**。
      观察孔由 `splash.js` 在 `<head>` 里同步建立，所以它一定早于本模块存在
      （`type="module"` 恒 defer）；真的取不到就退化成"只切不记"，
      那比抛异常好 —— 抛异常会让整页都白屏，而丢一个偏好只是不记。
   契约见 `scripts/check-wb.mjs` §68④。 */
function setTheme(v) {
  document.documentElement.dataset.theme = v === 'dark' ? 'dark' : 'light';
  const k = window.__themeBoot && window.__themeBoot.key;
  if (!k) return;
  try { localStorage.setItem(k, v); } catch { /* 隐私模式下忽略 */ }
}

/* 主题色：值与首屏启动层共用同一个观察孔（`next-accent`）。CSS 的 9 套
   令牌在 style.css 里，这里只负责写 <html data-accent> 与持久化。 */
function setAccent(v) {
  const allowed = (window.__accentBoot && Array.isArray(window.__accentBoot.values))
    ? window.__accentBoot.values
    : ['ocean'];
  const id = allowed.includes(v) ? v : 'ocean';
  document.documentElement.dataset.accent = id;
  const k = window.__accentBoot && window.__accentBoot.key;
  if (k) {
    try { localStorage.setItem(k, id); } catch { /* 隐私模式下忽略 */ }
  }
}

/* 深浅切换：设置层的两态按钮调用这里。source 是被点按钮（VT 圆心）；
   没有 source（例如恢复默认外观）就只换色，不播揭开动画。 */
async function applyTheme(next, source) {
  const target = next === 'dark' ? 'dark' : 'light';
  if (target === (themeDark() ? 'dark' : 'light')) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!THEME_VT_ON || reduce || !document.startViewTransition || !source
    || typeof source.getBoundingClientRect !== 'function') {
    setTheme(target);
    return;
  }
  const root = document.documentElement;
  const r = source.getBoundingClientRect();
  root.style.setProperty('--vt-origin',
    `${Math.round(r.left + r.width / 2)}px ${Math.round(r.top + r.height / 2)}px`);
  root.dataset.vt = 'circle-blur';
  const vt = document.startViewTransition(() => { setTheme(target); });
  try { await vt.finished; } catch { /* 动画被跳过（文档隐藏等）不算失败 */ }
  delete root.dataset.vt;
}

/* 字体风格（只影响这一页，不进配置、不发写请求）—— 与深浅切换同性质。
   键名与首屏启动共用 `window.__fontBoot`（splash.js 里唯一一份）；
   默认无衬线，选了衬线后由 `<html data-font-style="serif">` 接管 `--font`。 */
function setFontStyle(v) {
  const style = v === 'serif' ? 'serif' : 'sans';
  document.documentElement.dataset.fontStyle = style;
  const k = window.__fontBoot && window.__fontBoot.key;
  if (k) {
    try { localStorage.setItem(k, style); } catch { /* 隐私模式下忽略 */ }
  }
}

/* 窗口尺寸变化 → 指示器必须重算。
   岛是 `width: fit-content`、选项宽度跟着断点令牌变，所以"选中项在哪、多宽"每次都会变；
   不重算的表现是**切页之后才发现白框偏了一截**（而看起来像是"上次动画没做完"）。
   ⚠️ 走 `instant`：拖窗时不该有一段追着跑的弹簧。
   ⚠️ 防抖 120ms：`offsetLeft` 会强制同步布局，拖窗时每帧读一次就是持续的布局抖动。 */
let navResizeT = 0;
window.addEventListener('resize', () => {
  clearTimeout(navResizeT);
  navResizeT = setTimeout(() => {
    navGeom = null;   /* 断点/触屏档可能换了令牌 —— 缓存的几何作废 */
    layoutNavDock(false); syncNavIndicator(true); syncNav2Indicator(true);
  }, 120);
});

/* ════════════════════════════════════════════════ 11. 启动 ═══ */
(function boot() {
  /* ① schema 自检：控件类型必须在 RENDER 表里，且必须在 CTRL_KINDS 清单里。
        清单漂了只会让文档骗人；RENDER 缺了会让页面上少一个控件 —— 两种都要当场红。 */
  const seen = new Set();
  const walk = (x) => { seen.add(x.t); for (const it of x.items || []) if (it && it.t) walk(it); };
  for (const g of GROUPS) for (const su of g.subs) for (const c of su.cards || []) for (const x of c.ctrls || []) walk(x);
  const missingRender = [...seen].filter((t) => !RENDER[t]);
  const missingList = [...seen].filter((t) => !CTRL_KINDS.includes(t));
  /* 2026-10-25：`ticks`（回复长短档位条）与 `scenes`（9 种场景）随「回复设置」页
     暂时离开六页 IA，但实现保留、等那一页重做时直接接上。运行期与静态契约
     （check-wb §69）用**同一份**豁免名单，否则一边放行一边报警。 */
  const RESERVED_UNUSED = new Set(['ticks', 'scenes']);
  const unusedList = CTRL_KINDS.filter((t) => !seen.has(t) && !RESERVED_UNUSED.has(t));
  if (missingRender.length) console.error('[schema] 这些控件类型没有渲染器：', missingRender);
  if (missingList.length) console.error('[schema] 这些类型没登记进 CTRL_KINDS：', missingList);
  if (unusedList.length) console.warn('[schema] CTRL_KINDS 里登记了但没人用（清单该收一收了）：', unusedList);

  /* 首屏主题：**问**开屏层，不自己读。
     ⚠️⚠️ 为什么不再在这里 `localStorage.getItem('next-theme')`（2026-10-04 改）：
        本函数是 `type="module"` 的 IIFE ⇒ **天生 defer** ⇒ 它跑在首次绘制
        **之后**。于是深色用户每次打开面板都先看到一帧浅色底 + 浅色文字。
        真正的同步读取点搬到了 `splash.js`（`<head>` 里的同步经典脚本），
        它把值写进 `document.documentElement.dataset.theme`。
        ⚠️ **本地存储的键名必须只有一处**：如果这里再读一次，键名一旦漂移
           （改一个字）两处会**静默分家** —— 表现为"偶尔闪一下"，
           而且没有任何东西报警。所以此处只**问** `window.__themeBoot`。
        ⚠️ 问不到时（单独跑 app.js / 观察孔缺失）回落浅色：那是 `:root` 本身，
           页面照常可用 —— 判据是"不能因为读不到就白屏"。
        契约见 `scripts/check-wb.mjs` §68③。 */
  if (window.__themeBoot && typeof window.__themeBoot.apply === 'function') {
    window.__themeBoot.apply();
  } else {
    document.documentElement.dataset.theme = 'light';
  }

  /* 主题色同理：键名与闭集合只在 splash.js 里写一次。 */
  if (window.__accentBoot && typeof window.__accentBoot.apply === 'function') {
    window.__accentBoot.apply();
  } else {
    document.documentElement.dataset.accent = 'ocean';
  }

  /* 字体偏好由 splash.js 在 <head> 里同步写好；这里再问一次是为了
     单独跑 app.js（没有入口页）时也有确定值。 */
  if (window.__fontBoot && typeof window.__fontBoot.apply === 'function') {
    window.__fontBoot.apply();
  } else {
    document.documentElement.dataset.fontStyle = 'sans';
  }

  /* 静态标记里只剩 data-a 了 —— 混进 data-act 这类别的属性名，按钮会**静默失效**
     （事件处理器只认 data-a）。已实测踩过一次：顶栏与保存条四个按钮全点不动。 */
  const staleAttrs = document.querySelectorAll('[data-act]').length;
  if (staleAttrs) {
    console.error(`[接线] 静态标记里有 ${staleAttrs} 处 data-act —— 事件处理器只认 data-a，这些按钮点了不会有反应`);
  }

  /* 唯一一处对外暴露：自检脚本（`panel/next/verify.mjs`）要靠它读水面下的状态
     —— 顶层 `const S` 在 ES module 作用域里，`Runtime.evaluate` 的全局作用域看不见它。
     ⚠️ 业务代码里别用它，这只是一个观察孔。 */
  window.__next = S;
  /* 只读计数：性能探针用它证明「内容没变时轮询真的没重建 DOM」。 */
  window.__paintStats = { builds: 0, skips: 0 };
  /* 设置层齿轮走图标表（与顶栏/卡片同一套路径数据）；预览版视觉直径 14px。 */
  const gearRot = $id('setGearRot');
  if (gearRot && window.Icons) gearRot.innerHTML = Icons.icon('gear', { size: 14 });
  /* HUD调整页的保存回执：island.js 写 localStorage 后调它，给用户一句"已保存"。
     以前保存函数返回 null（不走 /api/config），面板不会弹提示 —— 用户会以为没存上。 */
  window.__nextHudToast = (msg) => toast(msg, 'ok');

  /* 左下角设置层：只注入状态与写入口，设置模块不反向依赖 app.js。 */
  initSettings({
    getState: () => S,
    api,
    post,
    toast,
    refresh,
    applyTheme,
    setAccent,
    setFontStyle,
    exportSelected: doExportSelected,
  });

  /* 弹层里的「HUD 调整」：跳到「维护 → HUD调整」。事件由 island.js 派发，
     避免 isle 直接依赖 app.js 的内部状态。 */
  document.addEventListener('hud:open-settings', () => {
    const gi = GROUPS.findIndex((g) => g.id === 'sys');
    const si = gi >= 0 ? GROUPS[gi].subs.findIndex((x) => x.id === 'hud') : -1;
    if (gi >= 0 && si >= 0) { S.gi = gi; S.si = si; paintPage(true); window.scrollTo({ top: 0 }); }
  });

  /* 第二条观察孔：`paintPage` 的别名。**只有自检脚本用它** —— 它要先往
     `S.state` 里灌一批夹具数据（比如 40 条记忆），再强制重画一次好断言
     "卡片真的只画了前 N 条"。没有它就只能干等 3 秒轮询，而那一次会被
     服务端数据覆盖回去（`refresh()` 会整个换掉 `S.state`）。
     ⚠️ 业务代码不许用它 —— 要重画就调 `paintPage` / `softPaint`。 */
  window.__nextRepaint = () => paintPage(false);

  paintPage(true);
  refresh();
  openUpdateStream();
  let refreshTimer = 0;
  function startRefreshTimer() {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 3000);
  }
  /* 开屏期间不跳 3 秒轮询：第二次 refresh 原本正好落在格栅 canvas 阶段。
     首次 refresh() 照常（格栅 2000ms 开始透出页面，内容必须已经就位）。 */
  const bootGate = window.__bootGate;
  if (bootGate && bootGate.on && !bootGate.done && typeof bootGate.whenDone === 'function') {
    bootGate.whenDone(startRefreshTimer);
  } else {
    startRefreshTimer();
  }
  /* 测试专用：暂停 3 秒轮询。面板 QA 往 `S.state` 注入夹具后要在**同一个事件循环**里
     完成断言 —— 轮询若在中间触发，会把夹具换回服务端数据（表现为"展开态突然收回"）。
     业务代码不许调它；重画请用 `__nextRepaint`。 */
  window.__nextPauseRefresh = (on) => {
    if (on) { clearInterval(refreshTimer); refreshTimer = 0; return; }
    const g = window.__bootGate;
    if (g && g.on && !g.done && typeof g.whenDone === 'function') g.whenDone(startRefreshTimer);
    else startRefreshTimer();
  };
})();

/* ════════════════════════════════════════ 窗口几何跟踪（2026-10-16）════
   独立窗口里（启动器在 URL 上带了 `__win=1` 标记）把「窗口的位置与尺寸」持续回报给
   面板 —— 下次启动由 src/launch-mode.js 用 --window-size / --window-position 还原：
   关掉再开，窗口回到你上次放的地方，不再每次都被重置。

   ⚠️ 只在带标记的窗口里启用：普通标签页的"窗口"是**整个浏览器**（含标签栏与地址栏），
      上报它会把"上次独立窗口的位置"污染成浏览器窗口的样子 —— 两端都会觉得诡异。
   ⚠️ 三条纪律：① 节流（resize 后 400ms / 位置没有事件可听所以 2.5s 轮询 / 关闭前
      pagehide 补最后一枪）；② 值没变不发；③ **任何失败都吞掉** —— 跟踪是锦上添花，
      绝不许打断页面。
   ⚠️ 标记字面量 `__win` 与 src/launch-mode.js 的 WIN_QUERY 必须逐字相容 —— check-wb §104 钉着。 */
(function trackWindowGeometry() {
  let marked = false;
  try { marked = location.search.includes('__win'); } catch { marked = false; }
  if (!marked) return;

  let last = '';
  const send = () => {
    try {
      const g = {
        x: Math.round(window.screenX), y: Math.round(window.screenY),
        w: Math.round(window.outerWidth), h: Math.round(window.outerHeight),
      };
      const s = JSON.stringify(g);
      if (s === last) return; // 值没变不发（2.5s 轮询因此几乎不产生流量）
      last = s;
      fetch('/api/panel/window', {
        method: 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          HAS_TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
        ),
        body: s,
        keepalive: true, // 关窗那一刻也能把最后一枪打出去
      }).catch(() => {});
    } catch { /* 纪律 ③：永不打断页面 */ }
  };

  let t = 0;
  const soon = () => { clearTimeout(t); t = setTimeout(send, 400); };
  window.addEventListener('resize', soon);
  window.addEventListener('pagehide', send);
  setTimeout(send, 1500); // 首报：窗口刚开出来，几何已定型
  setInterval(send, 2500); // 位置变化没有事件可听，靠轮询兜底
})();

/* ════════════════════════════════════════════════ 12. 工厂域转场 ═══
   2026-10-27 · 从桌面原型 `estrella-绝区零绿幕转场-2026-10-25.html` 移植。
   时间轴、三层弹簧列车、3+3 文字快闪、斜纹与中央黑带全部保留。

   与原型的**唯一语义差异**是绿幕：
     · 原型结尾用绿色把画面铺满（给合成留的占位色）；
     · 产品里绿色必须消失 ⇒ 那条绿色回扫改成**透明擦除**：
       同一形状的 chevron 从左边把黑幕吃掉，露出下面已经切换好的新页面。
     · 进入工厂时整体左→右；离开工厂时 container 镜像，整体右→左。

   切页时机 = 最上层 dark 真正铺满的那一刻（按视口长宽比算，不是写死 0.9s）；
   盖满后先让新页面完成一次绘制，再开始擦除 —— 否则擦开的是空白。

   ⚠️ 整段包在 IIFE 里：内部几十个短名（el / T / render / tick …）与主渲染器
      重名的概率很高，块级作用域是唯一不用逐个改名也不会静默覆盖的写法。
   ⚠️ 2026-10-27 定稿：并入 app.js（不新开资产文件）—— 面板进程的 NEXT_ASSETS
      在启动时读入内存，新文件要重启面板才可取；并进已有资产后刷新即生效。 */
const factoryWipe = (() => {
  const FPS = 60;
  const LEAD_FROM = -8;
  const REVEAL_TO = 108.5;
  const REVEAL_DUR = 0.24;          // 原型 green[1]
  const SPRING_MAX_T = 1.35;        // 原型总时长；弹簧表按它预计算
  const BAND_H_AT_720 = 33;

  /* 原型 1280×720 下的斜边水平偏移（% of width）换算成"占高度"的比例，
     这样换视口时 chevron 的角度保持一致，而不是被宽度拉扁/拉尖。 */
  const SLANT_RATIO = {
    light: (5.2 / 100 * 1280) / 720,
    medium: (5.2 / 100 * 1280) / 720,
    dark: (7.2 / 100 * 1280) / 720,
    reveal: (6.8 / 100 * 1280) / 720,
  };

  const T = {
    bandIn: [0.00, 0.08],
    textIn: [0.08, 0.15],
    flickers: [
      [0.16, 0.18, 0.025],
      [0.23, 0.25, 0.025],
      [0.30, 0.32, 0.025],
      [0.66, 0.68, 0.020],
      [0.715, 0.735, 0.020],
      [0.77, 0.79, 0.010],
    ],
    train: { start: 0.44, dur: 0.90, endLead: 320, gap: 50, k: 180, c: 18 },
    bandOut: [0.89, 0.075],
    hatchIn: [0.08, 0.25],
    hatchClose: [0.62, 0.263],
    textEnd: 0.80,
  };

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const lerp = (a, b, p) => a + (b - a) * p;
  const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
  const easeInOutSine = (p) => 0.5 - 0.5 * Math.cos(Math.PI * p);
  const smooth = (a, b, v) => {
    const p = clamp01((v - a) / (b - a));
    return p * p * (3 - 2 * p);
  };
  const reducedMotion = () =>
    !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const FRAME_TOTAL = Math.round(SPRING_MAX_T * FPS);

  /* 与原型逐行同构：浅灰是领跑层（easeOutCubic 目标），中灰跟浅灰目标 -50，
     黑跟中灰实际 -50，两层各自过弹簧 ⇒ 间距会呼吸，但不是硬编码的等差。 */
  const SPRING = (() => {
    const dt = 1 / FPS;
    const light = [];
    const medium = [];
    const dark = [];
    let L = LEAD_FROM;
    let M = LEAD_FROM - T.train.gap;
    let D = LEAD_FROM - T.train.gap * 2;
    let mv = 0;
    let dv = 0;
    for (let i = 0; i <= FRAME_TOTAL; i++) {
      const t = i * dt;
      const p = clamp01((t - T.train.start) / T.train.dur);
      L = LEAD_FROM + (T.train.endLead - LEAD_FROM) * easeOutCubic(p);
      const mt = L - T.train.gap;
      const ma = (mt - M) * T.train.k - mv * T.train.c;
      mv += ma * dt;
      M += mv * dt;
      const dtg = M - T.train.gap;
      const da = (dtg - D) * T.train.k - dv * T.train.c;
      dv += da * dt;
      D += dv * dt;
      light.push(L);
      medium.push(M);
      dark.push(D);
    }
    return { light, medium, dark };
  })();

  function springAt(arr, t) {
    const x = Math.max(0, Math.min(SPRING_MAX_T, t)) * FPS;
    const i = Math.min(arr.length - 1, Math.floor(x));
    const j = Math.min(arr.length - 1, i + 1);
    return arr[i] + (arr[j] - arr[i]) * (x - i);
  }

  function textFlickerAt(t) {
    let v = 0;
    for (const [start, holdEnd, release] of T.flickers) {
      const dt = t - start;
      if (dt < 0 || dt > (holdEnd - start) + release) continue;
      const rise = smooth(0, 0.012, dt);
      const fall = 1 - smooth(holdEnd - start, (holdEnd - start) + release, dt);
      v = Math.max(v, Math.min(rise, fall));
    }
    return v;
  }

  let el = null;
  let trainEl = null;
  let lightEl = null;
  let mediumEl = null;
  let darkEl = null;
  let hatchEl = null;
  let bandEl = null;
  let textEl = null;

  let busy = false;
  let phase = 'idle';
  let direction = 'forward';
  let currentT = 0;
  let revealElapsed = -1;
  let lastEraserLead = LEAD_FROM;
  let metrics = null;
  let animStart = 0;
  let baseT = 0;
  let revealStart = 0;
  let raf = 0;
  let finishPlay = null;

  function ensure() {
    if (el) return;
    el = document.createElement('div');
    el.className = 'fx-wipe';
    el.id = 'fxWipe';
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `
      <div class="fx-wipe-train">
        <div class="fx-wipe-layer is-light"></div>
        <div class="fx-wipe-layer is-medium"></div>
        <div class="fx-wipe-layer is-dark"></div>
        <div class="fx-wipe-hatch"></div>
      </div>
      <div class="fx-wipe-band"><span class="fx-wipe-text"></span></div>`;
    document.body.appendChild(el);
    trainEl = el.querySelector('.fx-wipe-train');
    lightEl = trainEl.querySelector('.is-light');
    mediumEl = trainEl.querySelector('.is-medium');
    darkEl = trainEl.querySelector('.is-dark');
    hatchEl = trainEl.querySelector('.fx-wipe-hatch');
    bandEl = el.querySelector('.fx-wipe-band');
    textEl = el.querySelector('.fx-wipe-text');
  }

  function measure() {
    const w = Math.max(1, window.innerWidth || 1);
    const h = Math.max(1, window.innerHeight || 1);
    const slant = (name) => SLANT_RATIO[name] * (h / w) * 100;
    metrics = {
      w,
      h,
      bandFull: Math.max(24, Math.min(48, (h * BAND_H_AT_720) / 720)),
      slant: {
        light: slant('light'),
        medium: slant('medium'),
        dark: slant('dark'),
        reveal: slant('reveal'),
      },
    };
  }

  /* 最上层 dark 的 chevron 上角越过屏幕底边 => 整屏已被完全盖住。 */
  function coverTime() {
    if (!metrics) measure();
    const need = 100 + metrics.slant.dark;
    for (let i = 0; i < SPRING.dark.length; i++) {
      if (SPRING.dark[i] >= need) return (i + 1) / FPS;
    }
    return T.bandOut[0];
  }

  function setLead(target, lead, slant) {
    const top = lead - slant;
    target.style.clipPath = `polygon(0% 0%, ${top}% 0%, ${lead}% 50%, ${top}% 100%, 0% 100%)`;
  }

  /* 透明擦除：盖住区域在 chevron 右侧；左侧是"洞"，露出新页面。 */
  function setReveal(target, lead, slant) {
    const top = lead - slant;
    target.style.clipPath = `polygon(${top}% 0%, 100% 0%, 100% 100%, ${top}% 100%, ${lead}% 50%)`;
  }

  function render(t, reveal = -1) {
    if (!metrics) measure();
    currentT = Math.max(0, Math.min(SPRING_MAX_T, t));

    const bandIn = smooth(T.bandIn[0], T.bandIn[1], currentT);
    const bandOut = smooth(T.bandOut[0], T.bandOut[0] + T.bandOut[1], currentT);
    const textIn = smooth(T.textIn[0], T.textIn[1], currentT);

    bandEl.style.height = `${metrics.bandFull * bandIn * (1 - bandOut)}px`;
    const flicker = textFlickerAt(currentT);
    const textOpacity = textIn * (currentT < T.textEnd ? 1 : 0) * (1 - flicker);
    textEl.style.opacity = String(textOpacity);
    textEl.style.transform = `scaleX(${lerp(0.97, 1, textIn)})`;

    setLead(lightEl, springAt(SPRING.light, currentT), metrics.slant.light);
    setLead(mediumEl, springAt(SPRING.medium, currentT), metrics.slant.medium);
    setLead(darkEl, springAt(SPRING.dark, currentT), metrics.slant.dark);

    const hatchP = clamp01((currentT - T.hatchClose[0]) / T.hatchClose[1]);
    const hatchPitch = lerp(9, 3.2, easeInOutSine(hatchP));
    const hatchIn = smooth(T.hatchIn[0], T.hatchIn[1], currentT);
    hatchEl.style.setProperty('--fx-hp', `${hatchPitch.toFixed(2)}px`);
    hatchEl.style.opacity = String(0.78 * hatchIn * (1 - smooth(T.hatchClose[0], T.hatchClose[0] + T.hatchClose[1], currentT)));

    lastEraserLead = reveal < 0
      ? LEAD_FROM
      : lerp(LEAD_FROM, REVEAL_TO, easeOutCubic(clamp01(reveal / REVEAL_DUR)));
    setReveal(trainEl, lastEraserLead, metrics.slant.reveal);
  }

  /* ── 设置页小框预览 ────────────────────────────────────────────────
     复用同一套时间轴 / 弹簧，但只画进 16:9 的小框：白底、无绿幕。
     海报帧停在中途（0.60s），点「重播」才跑一次 rAF；播完 320ms 回到海报帧，
     不常驻循环 —— 设置面板里的预览不该一直占一个帧循环。 */
  const PREVIEW_POSTER_T = 0.48;
  let pv = null;
  let pvMetrics = null;
  let pvRaf = 0;
  let pvTimer = 0;
  let pvPlaying = false;
  let pvPlays = 0;

  function previewEnsure() {
    if (pv) return true;
    const stage = document.getElementById('fxPreviewStage');
    const root = stage && stage.querySelector('.fxp');
    if (!root) return false;
    pv = {
      stage,
      root,
      train: root.querySelector('.fx-wipe-train'),
      light: root.querySelector('.fx-wipe-layer.is-light'),
      medium: root.querySelector('.fx-wipe-layer.is-medium'),
      dark: root.querySelector('.fx-wipe-layer.is-dark'),
      hatch: root.querySelector('.fx-wipe-hatch'),
      band: root.querySelector('.fx-wipe-band'),
      text: root.querySelector('.fx-wipe-text'),
    };
    return !!(pv.train && pv.light && pv.medium && pv.dark && pv.hatch && pv.band && pv.text);
  }

  function previewMeasure() {
    if (!previewEnsure()) return false;
    const w = pv.root.clientWidth;
    const h = pv.root.clientHeight;
    if (w < 40 || h < 24) return false;
    const slant = (name) => SLANT_RATIO[name] * (h / w) * 100;
    pvMetrics = {
      w,
      h,
      bandFull: Math.max(8, (h * BAND_H_AT_720) / 720),
      slant: {
        light: slant('light'),
        medium: slant('medium'),
        dark: slant('dark'),
        reveal: slant('reveal'),
      },
    };
    pv.root.style.setProperty('--fxp-scale', String(Math.max(0.22, h / 720)));
    return true;
  }

  function previewCoverTime() {
    if (!pvMetrics) return T.bandOut[0];
    const need = 100 + pvMetrics.slant.dark;
    for (let i = 0; i < SPRING.dark.length; i++) {
      if (SPRING.dark[i] >= need) return (i + 1) / FPS;
    }
    return T.bandOut[0];
  }

  function renderPreview(t, reveal = -1) {
    if (!pvMetrics) return;
    const ct = Math.max(0, Math.min(SPRING_MAX_T, t));
    const bandIn = smooth(T.bandIn[0], T.bandIn[1], ct);
    const bandOut = smooth(T.bandOut[0], T.bandOut[0] + T.bandOut[1], ct);
    const textIn = smooth(T.textIn[0], T.textIn[1], ct);

    pv.band.style.height = `${pvMetrics.bandFull * bandIn * (1 - bandOut)}px`;
    const flicker = textFlickerAt(ct);
    const textOpacity = textIn * (ct < T.textEnd ? 1 : 0) * (1 - flicker);
    pv.text.style.opacity = String(textOpacity);
    pv.text.style.transform = `scaleX(${lerp(0.97, 1, textIn)})`;

    setLead(pv.light, springAt(SPRING.light, ct), pvMetrics.slant.light);
    setLead(pv.medium, springAt(SPRING.medium, ct), pvMetrics.slant.medium);
    setLead(pv.dark, springAt(SPRING.dark, ct), pvMetrics.slant.dark);

    const hatchP = clamp01((ct - T.hatchClose[0]) / T.hatchClose[1]);
    const hatchPitch = lerp(4.2, 2.4, easeInOutSine(hatchP));
    const hatchIn = smooth(T.hatchIn[0], T.hatchIn[1], ct);
    pv.hatch.style.setProperty('--fx-hp', `${hatchPitch.toFixed(2)}px`);
    pv.hatch.style.opacity = String(0.6 * hatchIn * (1 - smooth(T.hatchClose[0], T.hatchClose[0] + T.hatchClose[1], ct)));

    const lead = reveal < 0
      ? LEAD_FROM
      : lerp(LEAD_FROM, REVEAL_TO, easeOutCubic(clamp01(reveal / REVEAL_DUR)));
    setReveal(pv.train, lead, pvMetrics.slant.reveal);
  }

  function previewStop() {
    pvPlaying = false;
    if (pvRaf) cancelAnimationFrame(pvRaf);
    pvRaf = 0;
    if (pvTimer) clearTimeout(pvTimer);
    pvTimer = 0;
  }

  function previewPoster() {
    previewStop();
    if (!previewMeasure()) return false;
    renderPreview(PREVIEW_POSTER_T, -1);
    return true;
  }

  function previewPlay() {
    previewStop();
    if (!previewMeasure()) return false;
    pvPlays += 1;
    if (reducedMotion()) {
      renderPreview(PREVIEW_POSTER_T, -1);
      return false;
    }
    const cover = previewCoverTime();
    const start = performance.now();
    pvPlaying = true;
    renderPreview(0, -1);
    const step = (now) => {
      if (!pvPlaying) return;
      const t = (now - start) / 1000;
      if (t < cover) {
        renderPreview(t, -1);
        pvRaf = requestAnimationFrame(step);
        return;
      }
      const reveal = t - cover;
      if (reveal < REVEAL_DUR) {
        renderPreview(t, reveal);
        pvRaf = requestAnimationFrame(step);
        return;
      }
      renderPreview(cover + REVEAL_DUR, REVEAL_DUR);
      pvPlaying = false;
      pvRaf = 0;
      pvTimer = setTimeout(() => {
        pvTimer = 0;
        if (!pvPlaying) renderPreview(PREVIEW_POSTER_T, -1);
      }, 320);
    };
    pvRaf = requestAnimationFrame(step);
    return true;
  }

  function initPreview() {
    if (!previewEnsure()) return;
    requestAnimationFrame(() => {
      if (!pvPlaying) previewPoster();
    });
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (pvPlaying) return;
        if (previewMeasure()) renderPreview(PREVIEW_POSTER_T, -1);
      });
      ro.observe(pv.root);
    }
  }

  function stopRaf() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function finish() {
    stopRaf();
    if (el) {
      el.hidden = true;
      el.classList.remove('is-active', 'is-reverse');
    }
    busy = false;
    phase = 'idle';
    revealElapsed = -1;
    currentT = 0;
    if (finishPlay) {
      const done = finishPlay;
      finishPlay = null;
      done(true);
    }
  }

  function waitFrames(n) {
    return new Promise((resolve) => {
      let left = n;
      const step = () => (left-- <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
  }

  function tick(now) {
    const t = baseT + (now - animStart) / 1000;
    const cover = coverTime();

    if (phase === 'cover') {
      const tc = Math.min(t, cover);
      render(tc, -1);
      if (t >= cover) {
        phase = 'hold';
        currentT = cover;
        stopRaf();
        Promise.resolve()
          .then(() => onCoverRef())
          .catch((e) => console.error('[fx-wipe] 切页失败', e))
          .then(() => waitFrames(4))
          .then(() => {
            if (phase !== 'hold') return;
            phase = 'reveal';
            revealElapsed = 0;
            baseT = cover;
            animStart = performance.now();
            revealStart = animStart;
            raf = requestAnimationFrame(tick);
          });
        return;
      }
      raf = requestAnimationFrame(tick);
      return;
    }

    if (phase === 'reveal') {
      revealElapsed = Math.max(0, (now - revealStart) / 1000);
      const nextT = baseT + (now - animStart) / 1000;
      render(Math.min(nextT, cover + REVEAL_DUR), revealElapsed);
      if (revealElapsed >= REVEAL_DUR - 0.0001) {
        finish();
        return;
      }
      raf = requestAnimationFrame(tick);
    }
  }

  let onCoverRef = () => {};

  function playWithCover({ direction: dir = 'forward', label = 'FACTORY', onCover = () => {} } = {}) {
    if (busy) return Promise.resolve(false);
    if (reducedMotion()) {
      Promise.resolve().then(onCover).catch((e) => console.error('[fx-wipe] 切页失败', e));
      return Promise.resolve(true);
    }
    ensure();
    measure();
    direction = dir === 'reverse' ? 'reverse' : 'forward';
    onCoverRef = onCover;
    textEl.textContent = label;
    el.hidden = false;
    el.classList.add('is-active');
    el.classList.toggle('is-reverse', direction === 'reverse');
    phase = 'cover';
    busy = true;
    revealElapsed = -1;
    render(0, -1);
    baseT = 0;
    animStart = performance.now();

    return new Promise((resolve) => {
      finishPlay = resolve;
      raf = requestAnimationFrame(tick);
    });
  }

  window.addEventListener('resize', () => {
    if (!busy) return;
    measure();
    render(currentT, revealElapsed);
  });

  /* 真实浏览器门禁用：只读状态 + 手动触发 / 定帧（不点导航也能单独复现转场）。 */
  window.__factoryWipe = {
    play: playWithCover,
    seek: (t = 0, reveal = -1, dir = 'forward') => {
      if (busy) return false;
      ensure();
      measure();
      direction = dir === 'reverse' ? 'reverse' : 'forward';
      el.hidden = false;
      el.classList.add('is-active');
      el.classList.toggle('is-reverse', direction === 'reverse');
      phase = 'seek';
      render(t, reveal);
      return true;
    },
    hide: () => {
      if (busy) return false;
      if (el) {
        el.hidden = true;
        el.classList.remove('is-active', 'is-reverse');
      }
      phase = 'idle';
      return true;
    },
    state: () => ({
      busy,
      phase,
      direction,
      t: +currentT.toFixed(3),
      reveal: +revealElapsed.toFixed(3),
      eraserLead: +lastEraserLead.toFixed(2),
      coverT: busy && metrics ? +coverTime().toFixed(3) : null,
      hidden: el ? el.hidden : true,
    }),
    /* 设置页小框预览：poster 画静态帧，play 跑一次，stop 取消。 */
    preview: {
      poster: previewPoster,
      play: previewPlay,
      stop: previewStop,
      state: () => ({
        playing: pvPlaying,
        plays: pvPlays,
        w: pvMetrics ? pvMetrics.w : 0,
        h: pvMetrics ? pvMetrics.h : 0,
      }),
    },
  };

  initPreview();

  return { play: playWithCover, busy: () => busy };
})();

function playFactoryWipe(opts) {
  return factoryWipe.play(opts);
}
function factoryWipeBusy() {
  return factoryWipe.busy();
}

/* ════════════════════════════════ 9. 工厂域导航自动上收 ═══
   只在「工厂」页生效：过场与 dock 停稳后上收；顶部居中热区呼出；
   离开导航 2.5s 收回；离开工厂域立刻复位为常显。 */
const NAV_HIDE_DELAY = 2500;
const navAuto = {
  active: false, hidden: false, armed: false, hover: false,
  token: 0, hideTimer: 0, px: null, py: null,
};
/* 悬停面 = 整个 dock（#navDockWrap，含一级 + 二级 + 外框内边距）：
   鼠标停在任一级上都不收回；只有离开这个范围才起 2.5s 计时。
   ⚠️ 不要退回 #nav2wrap —— 那只覆盖二级行，鼠标停在一级上会被误收。 */
const navAutoEls = () => ({ row: $id('navrow'), dock: $id('navDockWrap'), hot: $id('navHotzone') });

function navAutoIsFactory() {
  const su = currentSub();
  return !!(su && su.frame) && S.gi === FACTORY_GI;
}
function navAutoStopTimer() {
  clearTimeout(navAuto.hideTimer);
  navAuto.hideTimer = 0;
}
/* 上收时如果鼠标正压在热区里，不立刻重新武装 —— 否则 nav 一消失就会被同一只鼠标呼出。 */
function navAutoPointerInHot() {
  const { hot } = navAutoEls();
  if (!hot || navAuto.px == null || navAuto.py == null) return false;
  const r = hot.getBoundingClientRect();
  return navAuto.px >= r.left && navAuto.px <= r.right
    && navAuto.py >= r.top && navAuto.py <= r.bottom;
}
/* 鼠标是否正压在导航 dock（一级 + 二级）上。
   ⚠️ 普通页（插件管理 / Skill）会把 navAuto 复位；从它们切回 frame 页时会重新武装，
   若只按时间上收，就会在用户点二级栏时把导航收走。自动上收的两条路径都要先看它。 */
function navAutoPointerInDock() {
  const { dock } = navAutoEls();
  if (!dock || navAuto.px == null || navAuto.py == null) return false;
  const r = dock.getBoundingClientRect();
  return navAuto.px >= r.left && navAuto.px <= r.right
    && navAuto.py >= r.top && navAuto.py <= r.bottom;
}
function navAutoHide() {
  if (!navAuto.active) return;
  const { row, hot } = navAutoEls();
  if (!row || !hot) return;
  navAuto.hidden = true;
  navAuto.armed = !navAutoPointerInHot();
  navAuto.hover = false;
  navAutoStopTimer();
  row.inert = true;
  hot.tabIndex = 0;
  document.body.classList.add('nav-auto-hidden');
}
function navAutoShow() {
  if (!navAuto.active) return;
  const { row, hot } = navAutoEls();
  if (!row || !hot) return;
  navAuto.hidden = false;
  navAuto.armed = true;
  navAuto.hover = true;
  navAutoStopTimer();
  row.inert = false;
  hot.tabIndex = -1;
  document.body.classList.remove('nav-auto-hidden');
}
function navAutoSchedule() {
  if (!navAuto.active || navAuto.hidden) return;
  navAutoStopTimer();
  navAuto.hideTimer = setTimeout(() => {
    navAuto.hideTimer = 0;
    if (!navAuto.active || navAuto.hidden) return;
    if (navAuto.hover || navAutoPointerInDock()) { navAuto.hover = true; return; }
    navAutoHide();
  }, NAV_HIDE_DELAY);
}
function navAutoReset() {
  navAuto.active = false;
  navAuto.hidden = false;
  navAuto.armed = false;
  navAuto.hover = false;
  navAuto.token += 1;
  navAutoStopTimer();
  const { row, hot } = navAutoEls();
  if (row) row.inert = false;
  if (hot) hot.tabIndex = -1;
  document.body.classList.remove('nav-auto-hidden');
}
function navAutoArm() {
  if (navAuto.active || !navAutoIsFactory()) return;
  navAuto.active = true;
  navAuto.hidden = false;
  navAuto.armed = false;
  navAuto.hover = false;
  navAutoStopTimer();
  const token = ++navAuto.token;
  const { row, hot } = navAutoEls();
  if (row) row.inert = false;
  if (hot) hot.tabIndex = -1;
  document.body.classList.remove('nav-auto-hidden');
  const waitWipe = async () => {
    for (let i = 0; i < 200 && factoryWipeBusy(); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const waitDock = new Promise((resolve) => {
    if (navDockAnimating()) navDockSettled(resolve);
    else resolve();
  });
  Promise.all([waitWipe(), waitDock]).then(() => {
    if (token !== navAuto.token || !navAuto.active) return;
    setTimeout(() => {
      if (token !== navAuto.token || !navAuto.active) return;
      if (navAuto.hover || navAutoPointerInDock()) { navAuto.hover = true; return; }
      navAutoHide();
    }, 120);
  });
}
function syncNavAuto(isFactory) {
  if (!navAutoReady) return;
  if (!isFactory) { navAutoReset(); return; }
  navAutoArm();
}
function initNavAuto() {
  const { dock, hot } = navAutoEls();
  if (!dock || !hot) return;
  document.addEventListener('pointermove', (ev) => {
    navAuto.px = ev.clientX;
    navAuto.py = ev.clientY;
  }, { passive: true });

  hot.addEventListener('pointerenter', () => {
    if (!navAuto.active) return;
    if (navAuto.hidden) {
      if (navAuto.armed) navAutoShow();
      return;
    }
    navAuto.hover = true;
    navAutoStopTimer();
  });
  hot.addEventListener('pointerleave', () => {
    if (!navAuto.active) return;
    if (navAuto.hidden) { navAuto.armed = true; return; }
    if (navAuto.hover) {
      navAuto.hover = false;
      /* 离开事件不一定会再带一次 pointermove；清掉坐标，避免几何判定以为指针还在导航上。 */
      navAuto.px = null; navAuto.py = null;
      navAutoSchedule();
    }
  });
  hot.addEventListener('focus', () => {
    if (navAuto.active && navAuto.hidden) navAutoShow();
  });
  hot.addEventListener('click', () => {
    if (navAuto.active && navAuto.hidden) navAutoShow();
  });

  dock.addEventListener('pointerenter', () => {
    if (!navAuto.active) return;
    navAuto.hover = true;
    navAutoStopTimer();
  });
  dock.addEventListener('pointerleave', (ev) => {
    if (!navAuto.active || navAuto.hidden) return;
    if (ev.relatedTarget && (dock.contains(ev.relatedTarget) || hot.contains(ev.relatedTarget))) return;
    navAuto.hover = false;
    /* 离开事件不一定会再带一次 pointermove；清掉坐标，避免几何判定以为指针还在导航上。 */
    navAuto.px = null; navAuto.py = null;
    navAutoSchedule();
  });
  dock.addEventListener('focusin', () => {
    if (!navAuto.active) return;
    navAuto.hover = true;
    navAutoStopTimer();
  });
  dock.addEventListener('focusout', (ev) => {
    if (!navAuto.active || navAuto.hidden) return;
    if (ev.relatedTarget && (dock.contains(ev.relatedTarget) || hot.contains(ev.relatedTarget))) return;
    navAuto.hover = false;
    navAutoSchedule();
  });

  window.__navAutoHide = {
    state: () => ({
      active: navAuto.active,
      hidden: navAuto.hidden,
      armed: navAuto.armed,
      hover: navAuto.hover,
      delay: NAV_HIDE_DELAY,
    }),
    reveal: () => navAutoShow(),
    hide: () => navAutoHide(),
    reset: () => navAutoReset(),
  };
  navAutoReady = true;
}
initNavAuto();
