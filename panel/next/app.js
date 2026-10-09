/**
 * ══════════════════════════════════════════════════════════════════════════
 *  QQ-BOT-CONTROL v2 · 渲染器 / 路由 / 反馈
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

import { GROUPS, CTRL_KINDS, $ } from './schema.js';
import { DEMO } from './demo-state.js';
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

const TOKEN = (document.querySelector('meta[name="panel-token"]')?.content || '').trim();
const HAS_TOKEN = !!TOKEN && TOKEN !== '__QQBOT_PANEL_TOKEN__';
const $id = (x) => document.getElementById(x);
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
function toast(msg, cls = '') {
  const box = $id('toasts');
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), cls === 'bad' ? 6000 : 3200);
}
let busyDepth = 0;
function busy(on, txt = '处理中…') {
  busyDepth = Math.max(0, busyDepth + (on ? 1 : -1));
  const b = $id('busy');
  b.hidden = busyDepth === 0;
  $id('busyTxt').textContent = txt;
}
function modal(title, html, actions = []) {
  const box = $id('modalBox');
  box.innerHTML = `<h3>${esc(title)}</h3><div class="modal-body">${html}</div>
    <div class="btn-row" style="margin-top:18px;justify-content:flex-end;">
      ${actions.map((a, i) => `<button class="btn ${a.style || 'btn-ghost'}" data-a="__modal" data-idx="${i}">${esc(a.label)}</button>`).join('')}
      <button class="btn btn-ghost" data-a="__modal-close">关闭</button>
    </div>`;
  $id('modal').hidden = false;
  modal._actions = actions;
}
const closeModal = () => { $id('modal').hidden = true; modal._actions = []; };

/* ════════════════════════════════════════════════ 3. API ═══ */
async function api(path, { method = 'GET', body = null, raw = false, timeout = 120000 } = {}) {
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
      throw new Error(msg);
    }
    return data;
  } finally { clearTimeout(timer); }
}

/** 刷新 /api/state。失败时**明确**进入演示模式，并且说出来。 */
async function refresh(silent = false) {
  try {
    S.state = await api('/api/state');
    if (!S.online) { S.online = true; renderBanners(); }
  } catch (e) {
    if (S.online) { S.online = false; toast(`与后端断开：${e.message}`, 'bad'); }
    if (!S.state) S.state = DEMO;
    renderBanners();
  }
  paintTop();
  softPaint();
  if (!silent && !S.online) return;
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
function valueOf(ctrl) {
  const s = S.state || DEMO;
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
}
function setValue(ctrl, v) {
  if (ctrl.bind) { setPath(S.draft.custom, ctrl.bind, v); touchC(ctrl.bind); }
  else if (ctrl.bindSys) { S.draft.sys[ctrl.bindSys] = v; touchS(ctrl.bindSys); }
  else S.volatile[ctrl.id] = v;
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
const DEMO_BLOCK = () => { toast('演示模式：这一页没有连上后端，写操作不会发送', 'warn'); };

const ACTIONS = {
  'onekey.start': async () => { busy(true, '一键启动中…'); try { const r = await post('/api/onekey/start'); stepsOf(r); toast(r.msg || '已启动', 'ok'); await refresh(true); } catch (e) { toast(`启动失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'onekey.stop': async () => { if (!confirm('结束本次运行？机器人 + 本机模型 + 容器一起停。')) return; busy(true, '结束中…'); try { const r = await post('/api/onekey/stop'); stepsOf(r); toast(r.msg || '已结束', 'ok'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'bridge.start': async () => { busy(true, '启动机器人…'); try { const r = await post('/api/bridge/start'); toast(r.msg || '已启动', 'ok'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'bridge.stop': async () => { if (!confirm('停止机器人？')) return; busy(true, '停止中…'); try { const r = await post('/api/bridge/stop'); toast(r.msg || '已停止', 'ok'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'cmd.sleep': () => bridgeCmd('sleep'), 'cmd.wake': () => bridgeCmd('wake'),
  'cmd.abort': () => bridgeCmd('abort'), 'cmd.retry': () => bridgeCmd('retry'),
  'check': async () => { busy(true, '自检中…'); try { const r = await post('/api/check'); modal('连接自检', `<pre class="mono" style="white-space:pre-wrap;font-size:12px;">${esc(r.output || '')}</pre>`, [{ label: '知道了', style: 'btn-primary' }]); } catch (e) { toast(`自检失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'groups.load': async () => { busy(true, '读取群列表…'); try { const r = await api('/api/groups'); S.extra.groups = r.groups || []; modal('机器人已加入的群', r.groups?.length ? `<div class="rows">${r.groups.map((g) => `<div class="row flat"><span class="mono">${esc(g.id)}</span><span class="spacer"></span><span>${esc(g.name)}</span></div>`).join('')}</div>` : '<div class="empty">协议端没连上，或还没加入任何群。</div>', [{ label: '知道了', style: 'btn-primary' }]); } catch (e) { toast(`读取失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'open.webui': () => openTab('/api/qrcode', '二维码', true),
  'open.qwenchat': () => { const p = j(S.state, ['localModel', 'ports', 'qwenchat'], 8765); window.open(`http://127.0.0.1:${p}`, '_blank'); },
  'open.home': () => window.open('/', '_blank'),
  'napcat.restart': async () => { busy(true, '重启容器…'); try { const r = await post('/api/napcat/restart'); toast(r.output || '已重启', 'ok'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'qrcode.refresh': async () => { try { await post('/api/qrcode/refresh'); toast('已换一张新码', 'ok'); } catch (e) { toast(`失败：${e.message}`, 'bad'); } },
  'stopall': async () => { if (!confirm('一键全停：机器人 + 本机模型 + QQ 容器？')) return; busy(true, '全停中…'); try { const r = await post('/api/stop-all'); toast(r.msg || '已全停', 'ok'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'local.start': async () => { busy(true, '拉起本机模型…'); try { const r = await post('/api/local-model/start'); toast(r.msg || '已启动', 'ok'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'local.stop': async () => { busy(true, '停止本机模型…'); try { const r = await post('/api/local-model/stop'); toast(r.msg || '已停止', 'ok'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'switch.local': () => switchBrain('local'), 'switch.cloud': () => switchBrain('cloud'),
  'switch.zhipu': () => switchBrain('zhipu'), 'switch.qwen': () => switchBrain('qwen'),
  /* 自定义大脑：`brain.use` 带 id（同一 target 下有多套）；
     `brain.add` 弹表单（新增与编辑共用同一个表单，靠 id 区分）。 */
  'brain.use': (id) => switchBrain('custom', id),
  'brain.add': () => brainForm(null),
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
  'usage.reset': async () => { if (!confirm('清零用量统计？会删掉 panel/ 下所有 usage*.jsonl。')) return; try { const r = await post('/api/usage/reset'); toast(r.msg || '已清零', 'ok'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } },
  'trace.clear': async () => { if (!confirm('清空对话流记录？')) return; try { await post('/api/trace/clear'); toast('已清空', 'ok'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } },
  'logs.clear': async () => { try { await post('/api/logs/clear'); S.logCursor = 0; S.extra.logs = null; toast('已清空', 'ok'); paintPage(false); } catch (e) { toast(`失败：${e.message}`, 'bad'); } },
  'mem.auto.clear': async () => { if (!confirm('清空历史存量？手动记忆与结构化记忆不受影响。')) return; try { const r = await post('/api/custom/memory/clear'); toast(r.msg || '已清空', 'ok'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } },
  'mem.auto.del': async (id) => { try { const r = await post('/api/custom/memory/delete', { id }); toast(r.msg || '已删除', 'ok'); await refresh(true); } catch (e) { toast(`失败：${e.message}`, 'bad'); } },
  'mem.review': async (p) => { const [id, action] = String(p).split('|'); try { const r = await post('/api/memory/review', { id, action }); toast(r.msg || `已${action}`, 'ok'); await refresh(true); } catch (e) { toast(e.message === '这条不在了' ? '这条已经不在了（可能另一个窗口刚删过），正在刷新' : `失败：${e.message}`, 'bad'); await refresh(true); } },
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
  'panel.restart': async () => { busy(true, '重启面板…'); try { const before = j(S.state, ['panel', 'pid']); const r = await post('/api/panel/restart'); if (!r.restarted) { toast(r.msg || '已是最新，没有重启'); busy(false); return; } toast('正在重启，几秒后自动刷新…', 'ok'); await waitPanelPid(before); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'config.undo': async () => { if (!confirm('撤销上一次保存？配置会整份退回那一版。')) return; busy(true, '撤销中…'); try { const r = await post('/api/config/undo', { steps: 1 }); toast(r.msg || '已撤销', 'ok'); await refresh(true); } catch (e) { toast(`撤销失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'try.run': async () => { const text = String(S.volatile['try.text'] || '').trim(); if (!text) return toast('先写一句要它回的话', 'warn'); busy(true, '跑完整链路…'); try { S.extra.tryOut = await post('/api/try', { text }); paintPage(false); } catch (e) { toast(`失败：${e.message}`, 'bad'); } finally { busy(false); } },
  'skill.add.pack': () => addSkill('pack'), 'skill.add.persona': () => addSkill('persona'),
  'skill.apply': (i) => applyPersonaCard(Number(i)),
  'row.add': (p) => { draftArr(p).push(''); touchC(p); markDirty(); paintPage(false); },
  'row.del': (p) => {
    const [path, i] = String(p).split('|');
    draftArr(path).splice(Number(i), 1);
    touchC(path); markDirty(); paintPage(false);
  },
  '__modal': (p, ev) => { const i = Number(ev.target.dataset.idx); const a = modal._actions[i]; if (a && a.run) a.run(); else closeModal(); },
  '__modal-close': closeModal,
};

async function bridgeCmd(cmd) {
  if (!S.online) return DEMO_BLOCK();
  try {
    const r = await post('/api/bridge/command', { cmd });
    toast(r.msg || `已下发 ${cmd}，等机器人取走`, 'ok');
    await refresh(true);
  } catch (e) { toast(`下发失败：${e.message}`, 'bad'); }
}
async function switchBrain(target, id = '') {
  // 自定义大脑要带上"是哪一套" —— 内置那几套靠 target 就够了。
  busy(true, `切到 ${target} …`);
  try {
    const r = await post('/api/switch', id ? { target, id } : { target });
    if (Array.isArray(r.steps)) S.state.__steps = r.steps.map((x) => `· ${typeof x === 'string' ? x : x.msg || JSON.stringify(x)}`);
    toast(r.msg || '已切换', 'ok');
    await refresh(true);
    // ★ 切换成功后**顺带**把新服务商的模型清单读出来（用户报的 bug：不点「读取」
    //   下拉里就只剩当前那一个）。静默执行 —— 拉不到不算切换失败。
    await refreshModelsAfterSwitch();
  } catch (e) { toast(`切换失败：${e.message}`, 'bad'); }
  finally { busy(false); }
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

function brainForm(id) {
  const b = brainById(id);
  const f = b?.features || {};
  const chk = (k, label, hint) => `<label class="row flat f-inline" style="gap:8px;">
      <input type="checkbox" data-bf="${k}" ${f[k] === true ? 'checked' : ''}>
      <span class="grow">${label}</span><span class="hint">${hint}</span></label>`;
  const html = `<div class="f">
    <input type="text" data-bf="name" value="${esc(b?.name || '')}" placeholder="名字，例如「公司网关」" />
    <input type="text" data-bf="baseUrl" value="${esc(b?.baseUrl || '')}" placeholder="接口地址 https://…（要填 API 地址，不是控制台网页）" />
    <input type="password" data-bf="apiKey" value="" placeholder="${b?.hasKey ? '已保存过，留空则不改' : 'API Key'}" />
    <input type="text" data-bf="model" value="${esc(b?.model || '')}" placeholder="模型名，例如 gpt-4o-mini" />
    <div class="hint" style="margin-top:6px;">它能做什么（勾了才生效，界面上也<b>只显示勾过的</b>）：</div>
    ${chk('vision', '能看图', '勾了才会把群里的图片发给它')}
    ${chk('thinking', '能思考', '勾了才带思考参数；服务端不认会自动去掉重发，不会卡住')}
    ${chk('webSearch', '能联网', '勾了才带联网工具 —— 只有支持智谱那套形状的服务商认')}
  </div>`;
  modal(id ? `改设置：${b?.name || ''}` : '添加自定义模型', html, [
    { label: '取消' },
    { label: '保存', style: 'btn-primary', run: () => brainFormSubmit(id) },
  ]);
}

async function brainFormSubmit(id) {
  const baseUrl = bfVal('baseUrl');
  const model = bfVal('model');
  if (!baseUrl || !model) return toast('接口地址和模型名都要填', 'warn');
  busy(true, '保存中…');
  try {
    const r = await post('/api/custom-brain/save', {
      id: id || '', name: bfVal('name'), baseUrl, model, apiKey: bfVal('apiKey'),
      features: { vision: bfChecked('vision'), thinking: bfChecked('thinking'), webSearch: bfChecked('webSearch') },
    });
    closeModal();
    toast(r.msg || '已保存', 'ok');
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
      try { const r = await post('/api/custom-brain/rename', { id, name }); closeModal(); toast(r.msg || '已改名', 'ok'); await refresh(true); }
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
      try { const r = await post('/api/custom-brain/delete', { id }); closeModal(); toast(r.msg || '已删除', 'ok'); await refresh(true); }
      catch (e) { toast(`删除失败：${e.message}`, 'bad'); }
    } },
  ]);
}

/* 右键菜单：**委托在 document 上** —— 列表每 3 秒重绘一次，
   绑在按钮节点上会在第一次重绘后就失效（而症状只是"右键没反应"，看不出原因）。 */
document.addEventListener('contextmenu', (ev) => {
  const el = ev.target && ev.target.closest ? ev.target.closest('[data-brain]') : null;
  if (!el) return;
  const b = brainById(el.dataset.brain || '');
  if (!b) return;
  ev.preventDefault();
  modal(`「${b.name}」`, `<div class="rows">
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
  if (asModal) { modal(title, `<img alt="二维码" style="width:min(360px,100%);display:block;margin:0 auto;" src="${path}?t=${Date.now()}">`, [{ label: '换一张', run: async () => { try { await post('/api/qrcode/refresh'); openTab(path, title, true); } catch (e) { toast(e.message, 'bad'); } } }]); return; }
  window.open(path, '_blank');
}
function addRow(path, make) {
  draftArr(path).push(make ? make() : '');
  touchC(path); markDirty(); paintPage(false);
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
function addSkill(kind) {
  draftArr('skills').push({ id: `k${Date.now().toString(36)}`, kind, name: kind === 'persona' ? '新角色卡' : '新知识包',
    enabled: true, scope: { type: 'global', id: '' }, triggers: [], background: '', examples: [] });
  touchC('skills'); markDirty(); paintPage(false);
}
function applyPersonaCard(i) {
  const sk = draftArr('skills')[i];
  if (!sk?.fields) return toast('这张卡没有存人格快照，套用不了', 'warn');
  for (const k of Object.keys(sk.fields)) setPath(S.draft.custom, `persona.${k}`, sk.fields[k]);
  touchC('persona'); markDirty(); paintPage(false);
  toast('已套用到人格设定 —— 记得点底部的「保存并生效」', 'ok');
}
function balanceText(r) {
  if (!r || typeof r !== 'object') return '—';
  const v = r.total ?? r.balance ?? r.left ?? null;
  return v == null ? '—' : String(v);
}
async function doExport(what) {
  if (!S.online) return DEMO_BLOCK();
  const fmt = S.volatile['ex.fmt'] || 'json';
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
async function installZip(file) {
  if (!S.online) return DEMO_BLOCK();
  if (!confirm(`装这个包？同名包不会被覆盖（那是另一条确认）。`)) return;
  busy(true, '校验并安装…');
  try {
    const r = await api('/api/extensions/install', { method: 'POST', body: file });
    toast(`已装入 ${r.id}（${r.kind}）· ${r.files} 个文件。装完默认不启用 —— 在列表里勾上它，然后重启机器人。`, 'ok');
    await refresh(true);
  } catch (e) { toast(`安装失败：${e.message}`, 'bad'); } finally { busy(false); }
}

/* ════════════════════════════════════════════════ 6. 顶栏 / 告警 ═══ */
function paintTop() {
  const s = S.state || DEMO;
  const dst = j(s, ['docker', 'daemon']), dapp = j(s, ['docker', 'app']);
  const cp = j(s, ['memory', 'pressure']);
  const set = (id, text, cls) => { const el = $id(id); el.className = `pill ${cls || ''}`; el.innerHTML = `<span class="dot"></span>${esc(text)}`; };
  set('pillMode', S.online ? (j(s, ['panel', 'stale']) ? '面板跑着旧代码' : '已连接') : '演示模式（未连后端）',
    S.online ? (j(s, ['panel', 'stale']) ? 'warn' : 'on') : 'warn');
  set('pillBridge', j(s, ['bridge', 'running']) ? `机器人在跑 · ${fmtDur(j(s, ['bridge', 'uptimeMs'], 0))}` : '机器人没在跑', j(s, ['bridge', 'running']) ? 'on' : 'off');
  /* ⚠️ 第 53 轮（B2）：`container.applicable === false` 表示**这台机器根本没走容器这条路**
     （Windows 便携版用原生 NapCat、不装 Docker）⇒ 不许再说"Docker 没跑"——
     那是一句假警报，用户会去查一个不存在的容器。灰（off）= "这条路线不适用"，
     不是失败也不是等待。判据来自后端，页面不按平台自己猜。 */
  set('pillContainer',
    j(s, ['container', 'running'])
      ? (j(s, ['container', 'loggedIn']) ? '容器已登录' : '容器在跑 · 未登录')
      : (j(s, ['container', 'applicable']) === false
        ? '原生 NapCat（不用容器）'
        : (dapp ? 'Docker 在跑 · 容器没起' : 'Docker 没跑')),
    j(s, ['container', 'running'])
      ? (j(s, ['container', 'loggedIn']) ? 'on' : 'warn')
      : (j(s, ['container', 'applicable']) === false ? 'off' : (dst ? 'warn' : 'off')));
  set('pillLocal', j(s, ['localModel', 'running']) ? '本机模型在跑' : '本机模型没跑', j(s, ['localModel', 'running']) ? 'on' : 'off');
  // ⚠️ 内存读数可能是 **null**（Windows 上采不到、后端如实降级）——
  //    那时这颗药丸必须说"暂不支持"，**不许**显示「内存 0%」
  //    （第 53 轮 B2：那会让"采不到"看起来像"很空"，是谎话）。
  if (cp == null) set('pillMem', '内存 暂不支持', 'off');
  else set('pillMem', `内存 ${cp}%`, cp >= 90 ? 'bad' : cp >= 75 ? 'warn' : 'on');
  const sub = j(s, ['account', 'nickname']);
  $id('subline').textContent = S.online
    ? `${j(s, ['config', 'provider'], '?')} · ${j(s, ['effective', 'model'], '—')}${sub ? ` · ${sub}` : ''} · 面板 pid ${j(s, ['panel', 'pid'], '—')}`
    : '未连上后端 —— 下面是离线演示快照（写操作不会发送）';
  $id('footStat').textContent = `一级域 ${GROUPS.length} · 页面 ${GROUPS.reduce((n, g) => n + g.subs.length, 0)} · 控件类型 ${CTRL_KINDS.length}`;
}

function renderBanners() {
  const box = $id('banners');
  const s = S.state || DEMO;
  const out = [];
  if (!S.online) {
    out.push(`<div class="banner info"><b>演示模式</b><span class="spacer"></span>
      <span>这一页没有连上后端。要看真实数据：在项目根目录跑 <code>node tools/serve-next.mjs</code>，然后打开它给出的地址。</span></div>`);
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
  if (S.online && j(s, ['bridge', 'lock']) && !j(s, ['bridge', 'running'])) {
    out.push(`<div class="banner"><b>实例锁被占着</b><span class="spacer"></span>
      <span>pid ${j(s, ['bridge', 'lock', 'pid'])} 持有锁，而面板这边没在跑机器人 —— 这种情况下点「启动机器人」会被拒。清锁是危险动作，交脚本或人工。</span></div>`);
  }
  box.innerHTML = out.join('');
}

/* ════════════════════════════════════════════════ 7. 导航 ═══ */
function renderNav1() {
  const inner = $id('navInner');
  /* ⚠️ 只摘**按钮**，不动 `.nav-ind` —— 指示器是 index.html 里的静态元素，
     让它活过每一次重建是"切换时能滑过去"的**前提**（见 index.html 的注释）。
     用 `innerHTML = …` 一把换掉最省事，但那会把指示器一起清掉。 */
  inner.querySelectorAll('.grp').forEach((b) => b.remove());
  inner.insertAdjacentHTML('afterbegin', GROUPS.map((g, i) => `
    <button class="grp" role="tab" data-g="${i}" aria-selected="${i === S.gi}">${esc(g.label)}<span class="cnt">${g.subs.length}</span></button>`).join(''));
}
function renderNav2() {
  const g = GROUPS[S.gi];
  $id('nav2').innerHTML = g.subs.map((su, i) => `
    <button class="sub" role="tab" data-s="${i}" aria-selected="${i === S.si}">${esc(su.label)}</button>`).join('');
  /* B30：原来这里还往 `#pageMeta` 填「即时页 / 点一下立刻生效」，该节点已整块删除 ——
     草稿页的保存入口仍是页面底部的保存条（savebar），功能不受影响。 */
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

/** 一次性绑定：指示器是静态元素，只绑一回（重建会把它连同订阅一起丢掉）。 */
function bindNavIndicator() {
  const el = $id('navInd');
  const M = window.Motion;
  if (!el || !M) return null;
  const ind = { el, x: M.motionValue(0), w: M.motionValue(0), anims: [], inited: false };
  ind.apply = () => {
    const k = 1 + Math.min(Math.abs(ind.x.velocity()) * NAV_STRETCH_PER_PX_S, NAV_STRETCH_MAX);
    el.style.width = `${ind.w.get().toFixed(2)}px`;
    el.style.transform = `translateX(${ind.x.get().toFixed(2)}px)`
      + ` scaleX(${k.toFixed(4)}) scaleY(${M.areaPreservingScaleX(k).toFixed(4)})`;
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

/** 让指示器对齐当前选中项。`instant` 为真时直接落位（首屏 / 尺寸变化）。 */
function syncNavIndicator(instant) {
  const ind = navInd || bindNavIndicator();
  if (!ind) return;
  const sel = document.querySelector('#navInner .grp[aria-selected="true"]');
  if (!sel) return;
  const x = sel.offsetLeft, w = sel.offsetWidth;
  const M = window.Motion;
  ind.anims.forEach((a) => a.stop());          // 打断上一段：不重置速度，见上面 ④
  ind.anims = [];
  if (instant || !ind.inited || M.reducedMotion()) {
    ind.x.jump(x); ind.w.jump(w);
  } else if (Math.abs(ind.x.get() - x) > 0.5 || Math.abs(ind.w.get() - w) > 0.5) {
    ind.anims = [M.animate(ind.x, x, NAV_SPRING), M.animate(ind.w, w, NAV_SPRING)];
  }
  ind.inited = true;
  ind.el.classList.add('ready');                // 定位后才显形，避免首帧在 (0,0) 闪一下
  scrollNavTo(sel);
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
  return { page: S.gi + '/' + S.si, det, sc, y };
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
function paintPage(rebuildNav = true) {
  if (rebuildNav) { renderNav1(); renderNav2(); }
  else {
    document.querySelectorAll('#nav1 .grp').forEach((b, i) => b.setAttribute('aria-selected', String(i === S.gi)));
    document.querySelectorAll('#nav2 .sub').forEach((b, i) => b.setAttribute('aria-selected', String(i === S.si)));
  }
  /* 指示器每次都对齐一次：首次 `jump`（不飞）、之后 `animate`（滑过去）。
     判断住在 `syncNavIndicator` 内部（靠 `ind.inited`），这里不摆第二份。 */
  syncNavIndicator(false);
  const g = GROUPS[S.gi], su = currentSub();
  S.reg = new Map();
  const html = `
    <div class="wrap-head" style="grid-column:span 12;">
      <h1 style="font-size:var(--t-2xl);">${esc(su.title || su.label)}</h1>
      ${su.desc ? `<p class="hint" style="margin:6px 0 0;max-width:80ch;">${su.desc}</p>` : ''}
      <p class="hint" style="margin:4px 0 0;">${esc(g.label)} → ${esc(su.label)}</p>
    </div>
    ${(su.cards || []).filter((c) => !c.when || c.when(S.state || DEMO)).map((c) => cardHtml(c)).join('')}`;
  const keep = keepPageState();   /* ⚠️ 必须在 `innerHTML =` **之前**采集 */
  $id('page').innerHTML = html;
  restorePageState(keep);         /* ⚠️ 必须在**之后**恢复 —— 顺序反了就等于没修 */
  markDirty();
  auditActions();
  onPageShown(su);
}

function cardHtml(c) {
  if (c.bare) return bareHtml(c);
  const span = c.span === 6 ? 'span-6' : c.span === 4 ? 'span-4' : c.span === 8 ? 'span-8' : '';
  const badge = c.badge ? `<span class="${c.badge.cls || 'tag'}">${esc(c.badge.text)}</span>` : '';
  const body = (c.ctrls || []).filter((x) => !x.when || x.when(S.state || DEMO)).map((x) => ctrlHtml(x)).join('');
  return `<section class="card ${span}" id="card-${esc(c.id)}">
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
  const body = (c.ctrls || []).filter((x) => !x.when || x.when(S.state || DEMO)).map((x) => ctrlHtml(x)).join('');
  return `<div class="bare" id="card-${esc(c.id)}">${body}</div>`;
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
    const lines = x.source(S.state || DEMO);
    const label = x.label ? `<div class="f-lb">${esc(x.label)}</div>` : '';
    if (!lines.length) {
      return `${label}<div class="steps steps-empty">${Icons.icon('play', { size: 15 })}<span>还没有动作 —— 点一次「一键启动」或「启动机器人」，进度会出现在这里。</span></div>`;
    }
    /* ⚠️ 最后一条视为「当前」：它一定是最新的那一条。
       判据是**位置**而不是内容 —— 日志文本里可能有"成功"也有"失败"，
       按内容猜会在重试场景里判反。 */
    const items = lines.map((l, i) => {
      const cur = i === lines.length - 1;
      return `<li class="stp" data-cur="${cur ? '1' : '0'}">
        <span class="stp-dot"></span>
        <span class="stp-tx">${esc(l)}</span>
      </li>`;
    }).join('');
    return `${label}<ol class="steps">${items}</ol>`;
  },
  modebar: (x) => { const m = x.calc(S.state || DEMO); return `<div class="banner ${m.cls || 'info'}" style="margin:0;"><b>${esc(m.title)}</b><span class="spacer"></span><span class="hint" style="margin:0;">${esc(m.hint || '')}</span></div>`; },
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
      return `<div class="sg-cell" data-st="${st}">
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
  textarea: (x) => fieldInput(x, 'textarea'),
  number: (x) => fieldInput(x, 'number'),
  time: (x) => fieldInput(x, 'time'),
  select: (x) => fieldInput(x, 'select'),
  seg: (x) => {
    const cur = String(valueOf(x) ?? '');
    const opts = typeof x.options === 'function' ? x.options(S.state || DEMO) : x.options;
    return `<div class="f">${regd(x)}${lb(x)}<div class="seg">${opts.map((o) => `
      <label${o.title ? ` title="${esc(o.title)}"` : ''}><input type="radio" name="${esc(x.id)}" value="${esc(o.v)}" ${String(o.v) === cur ? 'checked' : ''} ${ctlA(x)}><span>${esc(o.l)}</span></label>`).join('')}</div>${hintOf(x)}</div>`;
  },
  /* ── 档位刻度（2026-10-02 · 抄 bencho.dev「Progress ticks」）──────────
     ⚠️ **它是 `seg` 的另一种呈现，不是新的一套数据契约**：
        读值走 `valueOf(x)`、写值走 `setValue(x, v)`、选项来源与 `seg` **同一个**
        `x.options`（多半是函数，从后端 `customMeta` 取）。所以任何一处改数据
        两边都跟着变，不存在"刻度那份数据是抄的"。

     ── 为什么某些档位值得用刻度而不是等宽按钮 ──────────────────────────
     档位有**顺序**（短→中→长 / 低→高），而 `.seg` 把三档排成等宽按钮 ——
     按钮之间的间距是"它们是同类"的意思，**不表达"谁比谁多"**。
     刻度把高度接���来（近→高），于是**不用读文字就知道大概在哪一档**。

     ⚠️ 成本也要说清：3 档时两种都够用，刻度的优势要到 **4 档以上**才明显。
        下面是 3 档（短/中/长），所以刻度在这里是"更好一点"而不是"必须"。

     ⚠️ **无障碍**：这**不是** radio group，刻度在 DOM 里是 `role="slider"`；
        键盘 ← → 换档、原生 radio 仍然在（视觉隐藏）负责表单语义与读屏。
        两条通道并存会让读屏念出两次，所以原生那组用 `.tkx-native` 移出可视区
        而不是 `display:none`（后者会让它**从无障碍树里消失**）。 */
  ticks: (x) => {
    const cur = String(valueOf(x) ?? '');
    const opts = typeof x.options === 'function' ? x.options(S.state || DEMO) : (x.options || []);

    /* ⚠️ **少于 3 档自动退回 `seg`**，不是硬套刻度。
       理由：2 档时"一根亮一根暗"和"两个等宽按钮"信息量**完全相同**，
       而刻度多占一行高度、多一个可聚焦元素、多一套指针逻辑。
       刻度的优势要到 3 档才出现（高度差能表达顺序），4 档才明显。
       ⚠️ 这条守卫是**按实际档数判**的，不是写死"至少 3 档"——
         思考强度的档数由**模型能力表**下发，可能只有 2 档。 */
    if (opts.length < 3) return RENDER.seg(x);

    const n = opts.length;
    const idx = Math.max(0, opts.findIndex((o) => String(o.v) === cur));
    const pct = n > 1 ? Math.round((idx / (n - 1)) * 100) : 0;

    /* 刻度高度：基础 52% + 正弦波纹。波纹让 3 根柱子看起来是"一族"，
       而 3 根一模一样的柱子会被读成"3 个并列项"而不是"一串档位"。
       点亮的额外 +26% —— 高度差与未点亮的基线同为 26px，
       于是"点亮了"这件事在长度上足够明显，又不至于变成实心块。 */
    const wave = (i) => 52 + Math.round(Math.sin(i / 1.9) * 12) + (i <= idx ? 26 : 0);
    const ticks = opts.map((o, i) =>
      `<span class="tkx-tick" data-on="${i <= idx}" data-near="${i === idx}"
             style="height:${wave(i)}%"></span>`).join('');
    const legend = opts.map((o, i) =>
      `<span${i === idx ? ' style="color:var(--c-text-2)"' : ''}>${esc(o.l)}</span>`).join('');

    return `<div class="f">${regd(x)}${lb(x)}
      <div class="tkx" data-tk="${esc(x.id)}" data-scrub="0" data-n="${n}">
        <div class="tkx-head">
          <span class="tkx-fig">${pct}<i>%</i></span>
          <span class="tkx-name">${esc(opts[idx]?.l || '')}</span>
          <span class="tkx-delta" data-show="0"></span>
        </div>
        <!-- 视觉刻度行：整行一个 handler（见 app.js 里 mountTicks 的注释） -->
        <div class="tkx-row" data-tk-row role="slider" tabindex="0"
             aria-label="${esc(x.label || '档位')}" aria-valuemin="0" aria-valuemax="${n - 1}"
             aria-valuenow="${idx}" aria-valuetext="${esc(opts[idx]?.l || '')}">${ticks}</div>
        <div class="tkx-legend">${legend}</div>
        <!-- 原生 radio：无障碍与表单语义的真正载体，视觉上移出但**不进无障碍树** -->
        <div class="tkx-native" aria-hidden="false">${opts.map((o) => `
          <label><input type="radio" name="${esc(x.id)}" value="${esc(o.v)}"
                 ${String(o.v) === cur ? 'checked' : ''} ${ctlA(x)}><span>${esc(o.l)}</span></label>`).join('')}</div>
      </div>${hintOf(x)}</div>`;
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
    if (!sl.enabled) return `<div class="hint">作息：<b>未启用</b> —— 它从不睡。要开去「发言与时机 → 睡眠作息」。</div>`;
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
  brainList: (x) => {
    const s = S.state || DEMO;
    const list = j(s, ['config', 'customBrains'], []) || [];
    const active = j(s, ['config', 'activeCustomId'], '');
    const rows = list.length
      ? list.map((b) => `<div class="row flat f-inline" data-brain="${esc(b.id)}">
          <span class="grow">${esc(b.name)}</span>
          <span class="hint mono">${esc(b.model)}</span>
          ${b.id === active
            ? '<span class="tag accent">在用</span>'
            : `<button class="btn btn-xs" data-a="brain.use" data-p="${esc(b.id)}" title="切到这套">用</button>`}
        </div>`).join('')
      : '<div class="empty">还没有自定义模型。点下面「添加」，填自己的接口地址、密钥和模型名就行。</div>';
    return `<div class="f">${lb({ label: '自定义模型（右键可改名 / 删除）' }, '<span class="spacer"></span>')}
      <div class="rows">${rows}</div>
      <div class="btn-row"><button class="btn btn-ghost btn-sm" data-a="brain.add">+ 添加自定义模型</button></div>
      <div class="hint" style="margin-top:6px;">哪家都行，只要接口是 OpenAI 兼容的（<code>/chat/completions</code>）。
        添加时会让你勾它能做什么 —— 勾了才生效，界面上也<b>只显示勾过的那几项</b>。</div>
    </div>`;
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
    /* ⚠️ 撤销条**不在这里算**：`_routeUndo` 是模块级状态（活过一次渲染），
       所以「上一次的顺序」是**上一次提交前**的顺序，而不是"从服务端再读一遍"。
       后者做不到 —— 服务端只存当前值，旧值只有前端记得。 */
    const undo = _routeUndo;
    return `<div class="f">${lb({ label: '试模型的顺序' }, '<span class="spacer"></span>')}
      <div class="rows srt" data-rb>${list.length ? list.map((m, i) => `<div class="row flat f-inline srt-item" data-srt-id="${esc(m)}" data-i="${i}">
        <button class="srt-grip" type="button" title="按住拖动改顺序（也可点它后按 ↑↓）" aria-label="调整 ${esc(s.modelLabels?.[m] || m)} 的顺序，当前第 ${i + 1} 位，共 ${list.length} 位">⠿</button>
        <span class="tag ${i === 0 ? 'accent' : 'plain'}">${i === 0 ? '主模型' : `第 ${i + 1}`}</span>
        <span class="grow">${esc(s.modelLabels?.[m] || m)}</span>
        <button class="btn btn-xs" data-a="route.up" data-p="${i}" title="上移" aria-label="把 ${esc(s.modelLabels?.[m] || m)} 上移">↑</button>
        <button class="btn btn-xs" data-a="route.down" data-p="${i}" title="下移" aria-label="把 ${esc(s.modelLabels?.[m] || m)} 下移">↓</button>
        <button class="btn btn-xs btn-danger" data-a="route.del" data-p="${i}" title="从线路里删掉" aria-label="把 ${esc(s.modelLabels?.[m] || m)} 从线路里删掉">×</button>
      </div>`).join('') : '<div class="empty">线路是空的。</div>'}</div>
      ${undo ? `<div class="btn-row"><button class="btn btn-ghost btn-sm" data-a="route.undo">撤销上一次改顺序</button>
        <span class="hint">上一次把「${esc(undo.label)}」挪到了第 ${undo.at + 1} 位。</span></div>` : ''}
      <details class="det"><summary>候选模型（点一下加进线路）</summary>
        <div class="chip-list">${(pool.length ? pool : []).map((m) => `<button class="chip" data-a="route.add" data-p="${esc(m)}">+ ${esc(s.modelLabels?.[m] || m)}</button>`).join('') || '<span class="hint">候选名单由后端下发；这一版没拿到。</span>'}</div>
        <div class="hint" style="margin-top:6px;">${provider === 'qwen'
          ? '千问的赠送额度是<b>按模型发的</b>（每个模型各 100 万 token）—— 所以这条链排得长：换一个模型等于换一份额度。'
          : '官方永久免费的 Flash 档在晚高峰很挤（实测 429），所以默认排在最后 —— 让它们先试会让每条消息都白等一次超时。'}</div>
      </details>
      <div class="btn-row"><button class="btn btn-ghost btn-sm" data-a="route.reset">恢复实测最优</button>
        <span class="hint">改完点底部「保存并生效」。</span></div></div>`;
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
  enhance: (x) => {
    const s = S.state || DEMO, meta = j(s, ['customMeta', 'enhance'], null);
    if (!meta) return '<div class="empty">后端没下发增强项定义（customMeta.enhance 为空）。</div>';
    return (meta.groups || []).map((g) => `<div class="f" style="margin-bottom:6px;">
      <div class="f-lb"><b>${esc(g)}</b></div>
      <div class="grid2">${(meta.keys || []).filter((k) => meta.table[k].group === g).map((k) => {
        const f = meta.table[k];
        const bind = `enhance.${k}`;
        const c = { id: `enh.${k}`, t: f.textarea ? 'textarea' : 'text', label: f.label, hint: f.hint, ph: f.ph, bind };
        return fieldInput(c, f.textarea ? 'textarea' : 'text');
      }).join('')}</div></div>`).join('');
  },
  scenes: (x) => {
    const s = S.state || DEMO, meta = j(s, ['customMeta', 'scenes'], null);
    if (!meta) return '<div class="empty">后端没下发场景定义（customMeta.scenes 为空）。</div>';
    return `<div class="grid2">${Object.entries(meta).map(([k, o]) => fieldInput(
      { id: `sc.${k}`, t: 'text', label: o.label, hint: o.hint, ph: o.ph, bind: `scenes.${k}` }, 'text')).join('')}</div>`;
  },
  playRules: (x) => {
    const s = S.state || DEMO, rs = j(s, ['customMeta', 'playRules'], []) || [];
    return `<details class="det"><summary>看看这 ${rs.length} 条到底是什么</summary><div class="rows">
      ${rs.map((r, i) => `<div class="row flat f-inline"><span class="tag plain">${i + 1}</span><span class="grow">${esc(r.text)}</span>${r.safety ? '<span class="tag info">安全</span>' : ''}</div>`).join('')}
    </div></details>`;
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
          ${sk.kind === 'persona' ? `<button class="btn btn-xs" data-a="skill.apply" data-p="${i}" title="把这张卡的人格快照写进人格设定">套用到人格设定</button>` : ''}
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
        ${x.detailed ? `<select style="width:110px;" data-a="sched.set" data-p="${i}|on">
          ${[['any', '每天'], ['workday', '只工作日'], ['rest', '只休息日']].map(([v, l]) => `<option value="${v}" ${(k.on || 'any') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
        <label class="sw flat"><input type="checkbox" ${k.enabled !== false ? 'checked' : ''} data-a="sched.set" data-p="${i}|enabled"><span class="track"></span><span class="txt">启用</span></label>
        <button class="btn btn-xs btn-danger" data-a="row.del" data-p="${esc(x.path)}|${i}">×</button>
      </div>`).join('') : '<div class="empty">还没有定时消息。加了之后到点会自动在那个群发一句。</div>'}</div>
      <div class="btn-row"><button class="btn btn-ghost btn-sm" data-a="row.add" data-p="${esc(x.path)}">加一条</button>
        <span class="hint">到点后 30 分钟内都还算数（被限流挡一下会自己重试），超窗才收尾成「错过」。</span></div></div>`;
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
  /**
   * 情绪：**真数据**（2026-10-02 起）。
   * 数据源是插件落的 `data/bot-state.json`，由 `panel/lib/bot-data.js` 白名单投影后
   * 随 `/api/state` 下发。所以这一页在**机器人没在跑时也能看** —— 而"机器人没在跑"
   * 恰恰是用户最想看它心情的时候。
   * ⚠️ `ok:false` 时**不画红**：那多半是"插件没装 / 还没产出数据"，是正常状态而不是故障。
   */
  emotionState: (x) => {
    const e = (S.state || DEMO).emotion;
    if (!e) return '<div class="empty">这一版的面板还没下发情绪（需要重启面板加载新代码）。</div>';
    if (!e.ok) {
      return `<div class="f">
        <div class="hint">${esc(e.reason || '读不到状态')}</div>
        <div class="hint">数据由插件 <b>本体情绪</b> 写在 <code>data/bot-state.json</code>：
          在「插件 → 插件」里勾上它、并重启机器人，这里就会长出数字（每轮聊天都会更新）。</div>
      </div>`;
    }
    const bar = (v) => {
      const n = typeof v === 'number' ? Math.max(0, Math.min(100, v)) : null;
      return n === null ? '<span class="hint">—</span>'
        : `<span style="display:inline-block;width:96px;height:6px;border-radius:3px;background:var(--c-sunken);vertical-align:2px;margin-right:6px;">
            <span style="display:block;width:${n}%;height:6px;border-radius:3px;background:var(--c-accent);"></span></span><b>${n}</b>`;
    };
    const EMO = { anger: '生气', irk: '烦躁', disgust: '厌恶', joy: '喜悦', cheer: '振奋', pride: '自豪', smug: '得意',
      hype: '兴奋', gratitude: '感激', anxiety: '焦虑', sadness: '难过', fear: '害怕', shame: '羞愧',
      guilt: '内疚', envy: '羡慕', loneliness: '孤独', down: '低落', boredom: '无聊', surprise: '惊讶',
      curiosity: '好奇', hope: '期待' };
    return `<div class="f">
      <div class="metrics">
        <div class="metric hi"><div class="n">${esc(String(e.mood ?? '—'))}</div><div class="l">心情（0–100）</div></div>
        <div class="metric"><div class="n">${esc(String(e.arousal ?? '—'))}</div><div class="l">唤醒度</div></div>
        <div class="metric"><div class="n">${esc(String(e.acuteStress ?? '—'))}</div><div class="l">急性压力</div></div>
        <div class="metric"><div class="n">${e.chronicStress != null ? Number(e.chronicStress).toFixed(1) : '—'}</div><div class="l">慢性压力</div></div>
      </div>
      <div class="f">${lb({ label: '精力' })}
        ${['physical', 'cognitive', 'emotional', 'will'].filter((k) => k in (e.energy || {})).map((k) => `
          <div class="f-inline"><span class="hint" style="flex:none;min-width:64px;">${{ physical: '身体', cognitive: '认知', emotional: '情绪', will: '意志' }[k]}</span>${bar(e.energy[k])}</div>`).join('')
          || '<span class="hint">没有精力字段</span>'}
        ${(e.energyExtra || []).length ? `<span class="hint">另有未识别的键：${esc(e.energyExtra.join('、'))}（照实带出，不猜含义）</span>` : ''}
      </div>
      <div class="f"><div class="f-lb">此刻的情绪（只列非零的）</div>
        ${(e.emotions || []).length
          ? `<div class="chip-list">${e.emotions.map(([k, v]) => `<span class="chip">${esc(EMO[k] || k)} <b>${esc(String(v))}</b></span>`).join('')}</div>`
          : '<span class="hint">21 项离散情绪全是 0 —— 此刻心里没什么起伏。</span>'}
        <div class="hint">键名来自那个包；认不出的键原样显示（不猜含义、不隐藏），这样它改名时这一页会如实体现在多一行，而不是静默少一行。</div>
      </div>
      ${e.intent ? `<div class="f"><div class="f-lb">此刻的意图</div><div>${esc(e.intent)}</div></div>` : ''}
      ${e.lastEvent ? `<div class="f"><div class="f-lb">上一次移动它的事件</div>
        <div class="row flat f-inline"><span class="tag plain">${esc(e.lastEvent.kind || '?')}</span>
          <span class="grow">${esc(e.lastEvent.note || '')}</span>
          <span class="hint">${e.lastEvent.at ? new Date(e.lastEvent.at).toLocaleString() : ''}</span>
          <span class="hint mono">${esc(e.lastEvent.chatKey || '')}</span></div></div>` : ''}
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
    const sum = ext.sum || {};
    const rt = j(s, ['effective', 'extensions'], null);
    return `<div class="f">
      <div class="hint">扫到 ${sum.total || 0} 个插件：可加载 ${sum.load || 0} · 未启用 ${sum.skip || 0} · 有问题 ${sum.reject || 0}。
        ${rt ? `机器人侧：已加载 ${rt.sum?.loaded ?? 0} · 未启用 ${rt.sum?.pending ?? 0} · 失败 ${rt.sum?.failed ?? 0}。` : '机器人没在跑，看不到运行期状态。'}</div>
      <div class="hint"><b>不支持热插拔</b>：改完白名单要重启机器人（那正是插件板上出现「待重启」的原因）。装完 ZIP 也不会自动启用。</div>
    </div>`;
  },
  /**
   * 插件清单：**每个插件一块独立玻璃板**，以网格平铺（不再挤在一个大容器里）。
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
    const on = new Set(draftArr('plugins.enabled'));
    const rt = j(s, ['effective', 'extensions'], null);
    const rtById = {}; if (rt?.items) for (const r of rt.items) rtById[r.id] = r;
    const items = ext.items || [];
    if (!items.length) return '<div class="empty">还没有装插件。</div>';
    return `<div class="pgrid">${items.map((it) => {
      const bad = it.action === 'reject';
      const checked = on.has(it.id) && !bad;
      const run = rtById[it.id];
      const badge = !rt ? '' : (!checked ? '' : run ? `<span class="tag ${run.state === 'failed' ? 'bad' : 'ok'}">${esc(run.state || '')}</span>` : '<span class="tag warn">待重启</span>');
      return `<section class="card pcard" data-plugin="${esc(it.id)}">
        <div class="pcard-h">
          <label class="sw flat" title="${bad ? '这个插件有问题，勾了也不会加载' : '勾上才启用'}">
            <input type="checkbox" ${checked ? 'checked' : ''} ${bad ? 'disabled' : ''} data-a="plugin.toggle" data-p="${esc(it.id)}"><span class="track"></span><span class="txt"></span></label>
          <span class="nm">${esc(it.name)}</span>
          <span class="spacer"></span>
          <span class="hint mono">v${esc(it.version || '?')}</span>
        </div>
        <div class="pcard-b">
          <div class="f-inline">
            <span class="tag plain mono">${esc(it.id)}</span>
            <span class="tag ${it.kind === 'plugin' ? 'info' : 'plain'}">${it.kind === 'plugin' ? '插件' : '技能包'}</span>
            ${badge}
            ${it.netSelf ? '<span class="tag warn" title="这个插件自带联网：它用自己的 fetch，不受浏览锁定约束">自带联网</span>' : ''}
            ${bad ? '<span class="tag bad">有问题</span>' : ''}
          </div>
          <div class="hint">${esc(it.detail || '')}</div>
          ${(it.problems || []).length ? `<div class="hint bad">${esc(it.problems.join('；'))}</div>` : ''}
          ${pluginSettingsRow(it)}
        </div>
      </section>`;
    }).join('')}</div>`;
  },
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
  faces: (x) => {
    const s = S.state || DEMO;
    const f = j(s, ['effective', 'customFaces'], null);
    const n = Array.isArray(f) ? f.length : f?.count ?? null;
    return `<div class="f">
      <div class="metric"><div class="n">${n == null ? '—' : n}</div><div class="l">已接入的收藏表情</div></div>
      ${Array.isArray(f) && f.length ? `<div class="chip-list">${f.slice(0, 40).map((t) => `<span class="chip mono">${esc(String(t.token || t).slice(0, 12))}</span>`).join('')}</div>` : ''}
      <div class="hint">${n == null ? '机器人没在跑（或这一版还没下发收藏快照）—— 所以这里不显示数字。' : ''}</div>
    </div>`;
  },
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
      <input type="file" accept=".zip,application/zip" data-a="zip.file" class="grow" />
      <button class="btn btn-ghost" data-a="zip.pick">选文件并安装</button></div>
      <div class="hint">顶层必须是一个目录，里面放 <code>plugin.json</code> 或 <code>skill.json</code>。<b>装完默认不启用</b> —— 在上面那张列表里勾上它，然后重启机器人。</div></div>`,
  protoInfo: () => `<div class="f">
      <div class="kv"><dt>这是什么</dt><dd>控制台前端的<b>初步重构原型</b>：整页由 <code>panel/next/schema.js</code> 一份数据驱动。</dd></div>
      <div class="kv"><dt>怎么加减</dt><dd>加页面 / 卡片 / 控件只改 schema；加控件类型才要动 <code>app.js</code> 的 RENDER 表。</dd></div>
      <div class="kv"><dt>和旧页的关系</dt><dd>旧页面（<code>panel/parts/</code> 的 16 个片段 + 它的清单模块）已在 <b>S-12 收口</b>时<b>整块删除</b>：服务端不再有读它的分支，页面上也没有回旧界面的入口，连那份 403 条断言（<code>test/verify-panel.mjs</code>）都不在仓库里了。面板侧的真实验收现在是 <code>panel/next/verify.mjs</code>（沙箱里跑，真实浏览器）。「那套机制不许回到运行时」由契约 §66 钉着。</dd></div>
      <div class="kv"><dt>已知边界</dt><dd>情绪状态、群友档案、节假日表没有下发口；定时消息的日期 / 频次存不住。见各自页面里的说明 —— 都是<b>写明的</b>，不是漏的。</dd></div>
      <div class="hint">要看真实数据：照常启动控制台即可 —— 它读的就是本机真实的 <code>panel/</code> 与 <code>data/</code>，不是 mock。</div>
    </div>`,
};

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

/* pluginSettingsRow 的独立实现（避免 RENDER 表里塞函数当键） */
function pluginSettingsRow(it) {
  const spec = Array.isArray(it.settingsSpec) ? it.settingsSpec : [];
  if (!spec.length) return '';
  const body = spec.map((f) => pluginSettingHtml(it.id, f)).join('');
  /* 设置项多的包（实测最多 7 项）默认收起：一个包就把页面撑满，
     会让"下面还有别的包"这件事看不见。≤3 项的直接摊开，省一次点击。 */
  if (spec.length > 3) {
    return `<details class="det"><summary>设置（共 ${spec.length} 项，改完点底部「保存并生效」）</summary>
      <div class="f" style="gap:6px;padding-top:4px;">${body}</div></details>`;
  }
  return `<div class="f" style="gap:6px;">
    <span class="hint">设置（共 ${spec.length} 项，改完点底部「保存并生效」）</span>${body}</div>`;
}
function pluginSettingHtml(extId, f) {
  const path = `plugins.settings.${extId}.${f.key}`;
  const raw = getPath(S.draft.custom, path);
  const val = raw !== undefined ? raw : f.value;
  const common = `data-a="plugin.set" data-p="${esc(extId)}|${esc(f.key)}"`;
  const tip = `清单默认值：${JSON.stringify(f.def)}`;
  if (f.kind === 'bool') {
    return `<label class="sw flat" title="${esc(tip)}"><input type="checkbox" ${val === true ? 'checked' : ''} ${common}>
      <span class="track"></span><span class="txt mono">${esc(f.key)}</span></label>`;
  }
  if (f.kind === 'number') {
    return `<div class="f-inline" title="${esc(tip)}"><span class="hint mono" style="flex:none;min-width:120px;">${esc(f.label || f.key)}</span>
      <input type="number" value="${esc(String(val ?? ''))}" ${common} style="max-width:180px;" /></div>`;
  }
  if (f.kind === 'list') {
    const text = Array.isArray(val) ? val.join('\n') : String(val ?? '');
    return `<div class="f" title="${esc(tip)}"><span class="hint mono">${esc(f.key)} · 一行一项</span>
      <textarea rows="2" ${common} style="font-size:12px;">${esc(text)}</textarea></div>`;
  }
  if (f.kind === 'string') {
    return `<div class="f-inline" title="${esc(tip)}"><span class="hint mono" style="flex:none;min-width:120px;">${esc(f.key)}</span>
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

/* ════════════════════════════════════════════════ 9. 页面显示时拉数据 ═══ */
function onPageShown(su) {
  const ids = new Set((su.cards || []).flatMap((c) => (c.ctrls || []).map((x) => x.t)));
  if (ids.has('sesList') && !S.extra.sessions) loadSessions();
  if (ids.has('chatList') && !S.extra.chats) loadChats();
  if (ids.has('logList')) loadLogs();
  if (ids.has('auditList')) loadAudit();
  mountLiquidSwitches();
  mountMorphIcons();
  mountTicks();
  mountRouteSort();
  markTiltables();
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
   ⚠️ **整行一个 handler，不是每格一个** —— 这条是 Bencho 原文的判例，值得抄：

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
       ⚠️ 两个坑都在这里：
       ① **不能用 `offsetLeft`**：`.tkx` 可能被写在 `transform: scale()` 的容器里
          （实验室页就是），此时 offset 仍是布局坐标而 clientX 是屏幕坐标，
          会差一个缩放倍数。必须 `getBoundingClientRect()`。
       ② **不能用整行宽度**去均分：刻度是**定宽 22px + 起点对齐**（不铺满），
          均分整行会在档数多时把"手指在右边空白处"也算成一个档位 ——
          实际是"点击空白 = 选中最后一档"，而视觉上那里什么都没有。
          ⇒ 改成**按刻度实际排布反查**：找出第 i 格的中点，落在哪个区间就是哪一档。 */
    const at = (clientX) => {
      const b = row.getBoundingClientRect();
      if (!b || !b.width) return null;
      const ticks = row.children;
      if (!ticks.length) return null;
      /* 超出最后���格 ⇒ 判为最后一档（点在右侧空白里不该是"没反应"） */
      for (let i = 0; i < ticks.length; i++) {
        const r = ticks[i].getBoundingClientRect();
        if (clientX < r.left + r.width / 2) return i;
      }
      return ticks.length - 1;
    };

    /* 光标预览：**只改样式，不写值**。 */
    let cur = null;
    const paintCursor = (i) => {
      const ticks = row.children;
      for (let k = 0; k < ticks.length; k++) {
        ticks[k].toggleAttribute('data-cursor', i === k);
      }
      box.setAttribute('data-scrub', i == null ? '0' : '1');
      const fig = box.querySelector('.tkx-fig');
      const name = box.querySelector('.tkx-name');
      const delta = box.querySelector('.tkx-delta');
      if (i == null) {
        if (delta) { delta.setAttribute('data-show', '0'); }
        return;
      }
      const base = radios.findIndex((r) => r.checked);
      const pct = Math.round((i / Math.max(1, n - 1)) * 100);
      if (fig) fig.innerHTML = `${pct}<i>%</i>`;
      if (name && radios[i]) name.textContent = radios[i].parentElement?.querySelector('span')?.textContent || '';
      if (delta) {
        const d = pct - Math.round((base / Math.max(1, n - 1)) * 100);
        if (d !== 0) {
          delta.textContent = (d > 0 ? '+' : '') + d;
          delta.setAttribute('data-show', '1');
          delta.setAttribute('data-up', d > 0 ? 'true' : 'false');
        } else delta.setAttribute('data-show', '0');
      }
      cur = i;
    };

    /* 真正提交：**点原生 radio**，让它去跑 change 绑定。
       ⚠️ 刻度层**自己不改值** —— 那样就多了一条写值的路，
          而"一个元素一个写入口"是本项目的红线。
       ⚠️ 提交后必须**同步 aria-valuenow / valuetext**：
         实测（自检页）漏了这一步 ⇒ 读屏念的还是旧档位，**与视觉不一致**。
         视觉那一半靠下次 `paintPage` 重渲染，而当前这一次的 ARIA 不会自己更新。 */
    const commit = (i) => {
      if (i == null) return;
      const r = radios[i];
      if (r && !r.checked) r.click();     // click ⇒ change ⇒ 既有保存链路
      row.setAttribute('aria-valuenow', String(i));
      row.setAttribute('aria-valuetext', (r && r.parentElement?.querySelector('span')?.textContent) || '');
    };

    let down = false;

    const onDown = (e) => {
      down = true;
      /* 指针捕获在"指针已不在"时会抛（合成事件、真实的手指已离开），
         而拖动不靠它也能用 —— 必须 try/catch。 */
      try { row.setPointerCapture(e.pointerId); } catch { /* 非活动指针 */ }
      paintCursor(at(e.clientX));
    };
    const onMove = (e) => {
      /* 鼠标悬停就跟随；触摸必须按住 ——
         否则手指在滚动时路过这一行，档位也会跟着跳。 */
      if (e.pointerType !== 'mouse' && !down) return;
      paintCursor(at(e.clientX));
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

/** 总闸。改成 false（或把liquid-toggle.js 的 script 标签删掉）就完全退回原生开关。 */
const LIQUID_ON = true;

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
    if (d.reset || !S.extra.logs) S.extra.logs = { lines: [] };
    S.extra.logs.lines = S.extra.logs.lines.concat(d.lines || []).slice(-400);
    S.logCursor = d.total || 0;
    softPaint();
  } catch { /* 同上 */ }
}
async function loadAudit() {
  try { S.extra.audit = await api('/api/audit?limit=200'); softPaint(); } catch { /* 同上 */ }
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
  'route.up', 'route.down', 'route.del', 'route.add', 'route.reset', 'route.undo',
  'plugin.toggle', 'plugin.set', 'memlist.set', 'memlist.del', 'memlist.add',
  'sched.set', 'skill.set', 'skill.del',
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
  for (const el of document.querySelectorAll('#page [data-a], .topbar [data-a], .savebar [data-a]')) {
    const a = el.dataset.a;
    if (!known.has(a) && !a.startsWith('export.')) unknown.add(a);
  }
  for (const a of unknown) {
    console.error(`[接线] 页面上有动作「${a}」没有处理者 —— 点它不会有任何反应（补进 ACTIONS 或 INLINE_ACTIONS）`);
  }
}

document.addEventListener('click', async (ev) => {
  const nav1 = ev.target.closest('#nav1 .grp');
  if (nav1) { S.gi = Number(nav1.dataset.g); S.si = 0; paintPage(true); window.scrollTo({ top: 0 }); return; }
  const nav2 = ev.target.closest('#nav2 .sub');
  if (nav2) { S.si = Number(nav2.dataset.s); paintPage(true); window.scrollTo({ top: 0 }); return; }

  const el = ev.target.closest('[data-a]');
  if (!el) return;
  const a = el.dataset.a, p = el.dataset.p;

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
    || a === 'route.reset' || a === 'route.undo') {
    return routeAction(a, p);
  }
  if (a === 'plugin.toggle') {
    const arr = draftArr('plugins.enabled');
    const i = arr.indexOf(p);
    if (i >= 0) arr.splice(i, 1); else arr.push(p);
    touchC('plugins.enabled');
    markDirty(); paintPage(false);
    toast(i >= 0 ? `已取消勾选 ${p}` : `已勾选 ${p} —— 点底部「保存并生效」，然后重启机器人才生效`, 'warn');
    return;
  }
  if (a === 'plugin.set') {
    const [extId, key] = String(p).split('|');
    const it = (S.state?.extensions?.items || []).find((e) => e.id === extId);
    const field = (it?.settingsSpec || []).find((f) => f.key === key);
    if (!field) return toast(`「${key}」不在这个包的清单里，已拒绝写入`, 'bad');
    let v = field.kind === 'bool' ? (el.checked ? 'true' : 'false') : el.value;
    if (field.kind === 'list') v = String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);
    setPath(S.draft.custom, `plugins.settings.${extId}.${key}`, v);
    touchC(`plugins.settings.${extId}.${key}`);
    markDirty();
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
  if (a.startsWith('export.')) return doExport(a.slice(7));
  if (a === 'field' || a === 'field-local') return; // 由 change 处理

  const fn = ACTIONS[a];
  if (!fn) { toast(`未实现的动作：${a}`, 'bad'); return; }
  return fn(p, ev);
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
    } catch (e) { toast(`失败：${e.message}`, 'bad'); await refresh(true); }
    return;
  }
  if (a === 'field' || a === 'field-local') {
    const x = S.reg.get(el.dataset.id);
    if (!x) return;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number' || (x.t === 'number')) v = Number(v);
    if (x.t === 'tags') v = String(v).split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    if (a === 'field-local' || (!x.save && !x.bind && !x.bindSys)) { S.volatile[x.id] = v; paintPage(false); return; }
    if (x.save) {
      try {
        const req = x.save(v, S.state || DEMO);
        if (!req) return;
        await post(req.url, req.body);
        toast('已生效', 'ok');
        await refresh(true);
      } catch (e) { toast(`失败：${e.message}`, 'bad'); await refresh(true); }
      return;
    }
    setValue(x, v);
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
  if (a === 'import.file') { const f = el.files?.[0]; if (f) previewImport(f); return; }
  if (a === 'zip.file') { const f = el.files?.[0]; if (f) installZip(f); return; }
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
  saveRoute(list);
}
async function resetRoute() {
  const def = j(S.state, ['zhipuDefaultChain'], null);
  if (!Array.isArray(def)) return toast('后端没下发默认线路', 'warn');
  saveRoute(def.slice());
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
/* 图标语义与 beui 原件一致：深色下画太阳（点了去浅色），浅色下画月亮。 */
function paintThemeBtn() {
  const btn = $id('themeBtn');
  if (btn) btn.innerHTML = Icons.icon(themeDark() ? 'sun' : 'moon', { size: 18 });
}
async function toggleTheme(ev) {
  const next = themeDark() ? 'light' : 'dark';
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!THEME_VT_ON || reduce || !document.startViewTransition) { setTheme(next); paintThemeBtn(); return; }
  const root = document.documentElement;
  const r = ev.currentTarget.getBoundingClientRect();
  /* 发散圆心 = 按钮此刻的圆心（每次点击现算 —— 顶栏是吸顶元素，滚动后位置会变） */
  root.style.setProperty('--vt-origin',
    `${Math.round(r.left + r.width / 2)}px ${Math.round(r.top + r.height / 2)}px`);
  root.dataset.vt = 'circle-blur';
  /* 图标换进 VT 的**新快照**里（写在 update 回调中），按钮跟着整页一起揭开 */
  const vt = document.startViewTransition(() => { setTheme(next); paintThemeBtn(); });
  try { await vt.finished; } catch { /* 动画被跳过（文档隐藏等）不算失败 */ }
  delete root.dataset.vt;
}
$id('themeBtn').addEventListener('click', toggleTheme);

/* 窗口尺寸变化 → 指示器必须重算。
   岛是 `width: fit-content`、选项宽度跟着断点令牌变，所以"选中项在哪、多宽"每次都会变；
   不重算的表现是**切页之后才发现白框偏了一截**（而看起来像是"上次动画没做完"）。
   ⚠️ 走 `instant`：拖窗时不该有一段追着跑的弹簧。
   ⚠️ 防抖 120ms：`offsetLeft` 会强制同步布局，拖窗时每帧读一次就是持续的布局抖动。 */
let navResizeT = 0;
window.addEventListener('resize', () => {
  clearTimeout(navResizeT);
  navResizeT = setTimeout(() => syncNavIndicator(true), 120);
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
  const unusedList = CTRL_KINDS.filter((t) => !seen.has(t));
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
  paintThemeBtn();

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

  /* 第二条观察孔：`paintPage` 的别名。**只有自检脚本用它** —— 它要先往
     `S.state` 里灌一批夹具数据（比如 40 条记忆），再强制重画一次好断言
     "卡片真的只画了前 N 条"。没有它就只能干等 3 秒轮询，而那一次会被
     服务端数据覆盖回去（`refresh()` 会整个换掉 `S.state`）。
     ⚠️ 业务代码不许用它 —— 要重画就调 `paintPage` / `softPaint`。 */
  window.__nextRepaint = () => paintPage(false);

  paintPage(true);
  refresh();
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 3000);
})();
