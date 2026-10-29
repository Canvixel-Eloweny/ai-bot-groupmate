/* HUD 信息岛 · 顶栏状态岛（原生 JS，零构建）。
   两行读数：上行是「谁 + 上下文」，下行是「多少 + 单位」；右栏是副消息。
   材质 / 强调色 / 字体 / 几何 / 密度 / 灰圈 / 时间轴全部来自「维护 → HUD调整」，
   设置只存这台机器的 localStorage；岛内所有数值来自 /api/state，不造数。 */
(function () {
  'use strict';

  var KEY = 'next-hud-island-v1';
  var HOST_ID = 'tbPills';
  var ITEM = {
    usage: { title: '今日用量', tag: 'USAGE', icon: 'coin' },
    bridge: { title: '机器人', tag: 'BOT', icon: 'bot' },
    memory: { title: '内存', tag: 'MEMORY', icon: 'memory' },
    calls: { title: '今日调用', tag: 'CALLS', icon: 'network' },
    tokens: { title: 'Token', tag: 'TOKENS', icon: 'layers' },
    cache: { title: '缓存命中', tag: 'CACHE', icon: 'layers' },
    patrol: { title: '巡逻积压', tag: 'PATROL', icon: 'search' },
    container: { title: '协议端', tag: 'PROTOCOL', icon: 'container' },
    model: { title: '本机模型', tag: 'LOCAL', icon: 'monitor' },
    link: { title: '连接', tag: 'LINK', icon: 'link' },
    update: { title: '版本', tag: 'UPDATE', icon: 'reload' },
    panel: { title: '面板', tag: 'PANEL', icon: 'link' },
    account: { title: '在线账号', tag: 'ACCOUNT', icon: 'user' }
  };
  /* 项清单只由 ITEM 的键序推导一次 —— 再加一项时只改上面的表，
     不会出现「ALL 忘了加 / ORDER 顺序与 ITEM 不一致」的第二份名单。 */
  var ALL = Object.keys(ITEM);
  var ORDER = ALL.slice();
  var RING_C = 2 * Math.PI * 15.5;
  var BASE_RATIOS = {
    plate: .70, glyph: .44, primary: .46, secondary: .26, right: .36,
    ring: .72, title: .44, tag: .21, pad: .40, gap: .22,
    radiusB: .32
  };
  /* 旧默认值只用于一次迁移：没有 geometryRev 的存档若比例仍是这一套，
     说明用户没动过，直接换成新默认；动过的保持原样。 */
  var OLD_RATIOS = {
    plate: .64, glyph: .41, pad: .40, gap: .22,
    ring: .76, primary: .46, secondary: .30, right: .42,
    title: .44, tag: .18
  };
  var GEOMETRY_REV = 2;
  var DEFAULTS = {
    enabled: ['usage', 'bridge', 'memory'],
    order: ORDER.slice(),
    interval: 7000,
    width: 380,
    height: 38,
    speed: 1,
    material: 'auto',
    accent: 'theme',
    font: 'sans',
    contentScale: 1,
    typeScale: 1,
    geometryRev: GEOMETRY_REV,
    ratios: Object.assign({}, BASE_RATIOS),
    switchMode: 'full',
    pauseHover: true,
    reduced: false,
    detail: 'auto',
    rewindMs: 0,
    seedMs: 0,
    slide1Ms: 0,
    titleHoldMs: 0,
    slide2Ms: 0,
    dataInMs: 0,
    radiusLead: -20,
    timelineRev: 2,
    haloStrength: .42,
    haloScale: 1,
    haloLayers: 3
  };

  var state = {
    mounted: false,
    cfg: readCfg(),
    data: null,
    online: false,
    activeId: '',
    anims: [],
    switching: false,
    switchStart: 0,
    switchKind: '',
    timelineMs: 1500,
    seekMs: 0,
    frozen: false,
    timer: 0,
    settleTimer: 0,
    seedTimer: 0,
    rollTimer: 0,
    arcTimer: 0,
    pendingRatio: null,
    queued: null,
    paused: false,
    hover: false,
    focus: false,
    popOpen: false,
    popAnim: null,
    popSig: '',
    density: '',
    widthActual: 0,
    measured: false,
    tokenKey: '',
    lookKey: '',
    lockKey: '',
    lock: null,
    primaryWheels: [],
    primaryTokens: null,
    primaryNumber: NaN,
    primaryPending: false,
    primaryFallback: '',
    primaryPendingData: false,
    isle: null,
    host: null,
    els: {}
  };
  state.activeId = (state.cfg.enabled[0] || state.cfg.order[0] || 'usage');
  var saveTimer = 0;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  var EASE = {
    pop: 'cubic-bezier(.34,1.56,.64,1)',
    smooth: 'cubic-bezier(.65,0,.35,1)',
    out: 'cubic-bezier(.22,.61,.36,1)',
    settle: 'cubic-bezier(.22,1,.36,1)',
    lock: 'cubic-bezier(.22,1.25,.36,1)',
    wheel: 'cubic-bezier(.4,0,.2,1)',
    fade: 'cubic-bezier(.4,0,.2,1)'
  };
  function isItem(id) { return Object.prototype.hasOwnProperty.call(ITEM, id); }
  function num(v, dflt) { var n = Number(v); return Number.isFinite(n) ? n : dflt; }
  function enumOf(v, list, dflt) { return list.indexOf(v) >= 0 ? v : dflt; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDur(ms) {
    var s = Math.max(0, Math.round(Number(ms || 0) / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + 'h ' + pad2(m) + 'm';
    if (m > 0) return m + 'm';
    return s + 's';
  }
  function fmtNum(n) {
    var v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1e4) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(v));
  }
  function fmtGB(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n.toFixed(1) : '—';
  }
  function pct(n) { return Math.round(clamp(Number(n) || 0, 0, 1) * 100); }
  function j(o, path, dflt) {
    var cur = o;
    for (var i = 0; i < path.length; i++) { if (cur == null) return dflt; cur = cur[path[i]]; }
    return cur == null ? dflt : cur;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function icon(name, size) {
    try { return window.Icons && Icons.icon(name, { size: size || 15 }); } catch (e) { return ''; }
  }

  function readCfg() {
    var out = JSON.parse(JSON.stringify(DEFAULTS));
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { raw = null; }
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.enabled)) out.enabled = raw.enabled.filter(isItem);
      if (Array.isArray(raw.order)) {
        out.order = raw.order.filter(isItem);
        ALL.forEach(function (id) { if (out.order.indexOf(id) < 0) out.order.push(id); });
      }
      if (!raw.order && Array.isArray(raw.enabled) && raw.enabled.length) {
        out.order = raw.enabled.filter(isItem).concat(ALL.filter(function (id) { return raw.enabled.indexOf(id) < 0; }));
      }
      out.interval = clamp(num(raw.interval, out.interval), 2000, 15000);
      out.width = clamp(num(raw.width, out.width), 200, 640);
      out.height = clamp(num(raw.height, out.height), 28, 48);
      out.speed = clamp(num(raw.speed, out.speed), .5, 2);
      out.contentScale = clamp(num(raw.contentScale, out.contentScale), .8, 1.2);
      out.typeScale = clamp(num(raw.typeScale, out.typeScale), .85, 1.15);
      out.material = raw.material === 'hud' ? 'black' : enumOf(raw.material, ['auto', 'glass', 'white', 'black'], 'auto');
      out.accent = enumOf(raw.accent, ['theme', 'cyan', 'orange', 'purple'], 'theme');
      out.font = enumOf(raw.font, ['sans', 'serif'], 'sans');
      out.switchMode = enumOf(raw.switchMode, ['full', 'handoff', 'quick'], 'full');
      out.detail = enumOf(raw.detail, ['auto', 'full', 'compact', 'minimal'], 'auto');
      if (typeof raw.pauseHover === 'boolean') out.pauseHover = raw.pauseHover;
      if (typeof raw.reduced === 'boolean') out.reduced = raw.reduced;
      out.rewindMs = clamp(num(raw.rewindMs, out.rewindMs), -300, 300);
      out.seedMs = clamp(num(raw.seedMs, out.seedMs), -300, 300);
      out.slide1Ms = clamp(num(raw.slide1Ms, out.slide1Ms), -300, 300);
      out.titleHoldMs = clamp(num(raw.titleHoldMs, out.titleHoldMs), -300, 300);
      out.slide2Ms = clamp(num(raw.slide2Ms, out.slide2Ms), -300, 300);
      out.dataInMs = clamp(num(raw.dataInMs, out.dataInMs), -300, 300);
      out.radiusLead = clamp(num(raw.radiusLead, out.radiusLead), -80, 80);
      if (Number(raw.timelineRev) !== 2) {
        out.rewindMs = 0;
        out.seedMs = 0;
        out.slide1Ms = 0;
        out.titleHoldMs = 0;
        out.slide2Ms = 0;
        out.dataInMs = 0;
        out.radiusLead = -20;
      }
      out.timelineRev = 2;
      out.haloStrength = clamp(num(raw.haloStrength, out.haloStrength), 0, .6);
      out.haloScale = clamp(num(raw.haloScale, out.haloScale), .8, 1.3);
      out.haloLayers = clamp(Math.round(num(raw.haloLayers, out.haloLayers)), 1, 3);
      if (raw.ratios && typeof raw.ratios === 'object') {
        Object.keys(BASE_RATIOS).forEach(function (k) {
          out.ratios[k] = clamp(num(raw.ratios[k], out.ratios[k]), .1, 1);
        });
      }
      if (Number(raw.geometryRev) !== GEOMETRY_REV) {
        var saved = raw.ratios && typeof raw.ratios === 'object' ? raw.ratios : null;
        var pristine = !saved || Object.keys(OLD_RATIOS).every(function (k) {
          return saved[k] == null || Math.abs(Number(saved[k]) - OLD_RATIOS[k]) < 1e-6;
        });
        if (pristine) out.ratios = Object.assign({}, BASE_RATIOS);
      }
      out.geometryRev = GEOMETRY_REV;
    }
    if (!out.order.length) out.order = ORDER.slice();
    return out;
  }

  function saveCfg(quiet) {
    try { localStorage.setItem(KEY, JSON.stringify(state.cfg)); } catch (e) { /* 隐私模式 / 配额满时保持内存态 */ }
    if (!quiet) {
      try { if (window.__nextHudToast) window.__nextHudToast('HUD 设置已保存（本机）'); } catch (e) { /* 忽略 */ }
    }
  }
  /* 滑块拖动时每次 input 都同步写 localStorage 会卡手；最多每 160ms 落一次盘。
     关页 / 隐藏时 flush，保证「拖完马上关」也不丢。 */
  function queueSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () { saveTimer = 0; saveCfg(true); }, 160);
  }
  function flushSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    saveCfg(true);
  }
  function saveNow(quiet) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    saveCfg(quiet);
  }

  /* ── 数据项：全部来自真实 /api/state ─────────────────────────────── */
  function valueOfItem(id) {
    var s = state.data;
    var online = state.online && !!s;
    if (!s) {
      return { label: (ITEM[id] || ITEM.usage).title, context: '', primary: '读取中', unit: '', rightLabel: '', right: '', suffix: '', ratio: null, tone: 'idle', primaryText: true };
    }
    if (id === 'usage') {
      var u = s.usage || {};
      var t = u.today || {};
      var cache = Number(u.cacheHitRate) || 0;
      return {
        label: '今日用量',
        context: fmtNum(t.calls) + ' 次',
        primary: '¥' + (Number(t.cost) || 0).toFixed(2),
        unit: '',
        rightLabel: '缓存命中',
        right: String(pct(cache)),
        suffix: '%',
        ratio: cache,
        tone: online ? 'ok' : 'idle'
      };
    }
    if (id === 'bridge') {
      var b = s.bridge || {};
      if (!b.running) {
        return { label: '机器人', context: '未启动', primary: '没在跑', unit: '', rightLabel: '状态', right: '离线', suffix: '', ratio: 0, tone: 'bad', primaryText: true };
      }
      return {
        label: '机器人',
        context: 'pid ' + (b.pid || '—'),
        primary: fmtDur(b.uptimeMs),
        unit: '',
        rightLabel: '状态',
        right: '在线',
        suffix: '',
        ratio: 1,
        tone: 'ok'
      };
    }
    if (id === 'memory') {
      var m = s.memory;
      if (!m) {
        return { label: '内存', context: '暂不支持', primary: '—', unit: '', rightLabel: '占比', right: '', suffix: '', ratio: null, tone: 'idle', primaryText: true };
      }
      var used = Number(m.usedGB) || 0;
      var total = Number(m.totalGB) || 0;
      var mr = total ? used / total : 0;
      return {
        label: '内存',
        context: '/ ' + fmtGB(total) + ' GB',
        primary: fmtGB(used),
        unit: 'GB',
        rightLabel: '占比',
        right: String(pct(mr)),
        suffix: '%',
        ratio: mr,
        tone: mr >= .9 ? 'bad' : mr >= .75 ? 'warn' : 'ok'
      };
    }
    if (id === 'calls') {
      var ct = (s.usage || {}).today || {};
      var ccache = Number((s.usage || {}).cacheHitRate) || 0;
      return {
        label: '今日调用',
        context: '免费 ' + fmtNum(ct.freeCalls) + ' · 付费 ' + fmtNum(ct.paidCalls),
        primary: fmtNum(ct.calls),
        unit: '次',
        rightLabel: '缓存命中',
        right: String(pct(ccache)),
        suffix: '%',
        ratio: ccache,
        tone: 'ok'
      };
    }
    if (id === 'tokens') {
      var tu = s.usage || {};
      var totalTokens = (Number(tu.prompt) || 0) + (Number(tu.completion) || 0);
      var tcache = Number(tu.cacheHitRate) || 0;
      return {
        label: 'Token',
        context: 'prompt ' + fmtNum(tu.prompt),
        primary: fmtNum(totalTokens),
        unit: '',
        rightLabel: '缓存命中',
        right: String(pct(tcache)),
        suffix: '%',
        ratio: tcache,
        tone: 'ok'
      };
    }
    if (id === 'cache') {
      var cu = s.usage || {};
      var cacheRate = Number(cu.cacheHitRate) || 0;
      var cm = s.memory;
      var memUsed = cm && Number(cm.totalGB) ? pct(Number(cm.usedGB) / Number(cm.totalGB)) : 0;
      return {
        label: '缓存命中',
        context: '',
        primary: String(pct(cacheRate)),
        unit: '%',
        rightLabel: '内存',
        right: String(memUsed),
        suffix: '%',
        ratio: cacheRate,
        tone: 'ok'
      };
    }
    if (id === 'patrol') {
      var rows = (s.patrol && s.patrol.rows) || [];
      var unread = rows.reduce(function (a, r) { return a + (Number(r.unread) || 0); }, 0);
      var last = rows.reduce(function (a, r) { return Math.max(a, Number(r.lastPatrolAt) || 0); }, 0);
      var ago = last ? fmtDur(Date.now() - last) : '—';
      return {
        label: '巡逻积压',
        context: rows.length + ' 个群',
        primary: String(unread),
        unit: '条',
        rightLabel: '最近',
        right: ago,
        suffix: '',
        ratio: clamp(unread / 50, 0, 1),
        tone: unread >= 20 ? 'warn' : 'ok',
        primaryText: false
      };
    }
    if (id === 'container') {
      var c = s.container || {};
      if (c.applicable === false) {
        return { label: '协议端', context: '原生 NapCat', primary: '已登录', unit: '', rightLabel: '运行', right: 'OK', suffix: '', ratio: 1, tone: 'ok', primaryText: true };
      }
      if (!c.running) {
        return { label: '协议端', context: 'Docker', primary: '没起', unit: '', rightLabel: '运行', right: '离线', suffix: '', ratio: 0, tone: 'bad', primaryText: true };
      }
      if (!c.loggedIn) {
        return { label: '协议端', context: 'Docker', primary: '未登录', unit: '', rightLabel: '运行', right: '待扫码', suffix: '', ratio: .15, tone: 'warn', primaryText: true };
      }
      return { label: '协议端', context: 'napcat', primary: '已登录', unit: '', rightLabel: '运行', right: '在线', suffix: '', ratio: 1, tone: 'ok', primaryText: true };
    }
    if (id === 'model') {
      var l = s.localModel || {};
      var mb = s.memory && s.memory.procs ? (Number(s.memory.procs.localModelMB) || 0) : 0;
      return {
        label: '本机模型',
        context: l.channel || '未选',
        primary: l.running ? '运行中' : '没跑',
        unit: '',
        rightLabel: '内存',
        right: String(mb),
        suffix: 'MB',
        ratio: l.running ? 1 : 0,
        tone: l.running ? 'ok' : 'idle',
        primaryText: true
      };
    }
    if (id === 'link') {
      var o = s.onebot || {};
      var ok = o.code === 'ok';
      var ports = s.ports || {};
      var httpPort = j(ports, ['onebot', 'http'], '');
      var wsPort = j(ports, ['onebot', 'ws'], '');
      return {
        label: '连接',
        context: 'WS ' + (wsPort || '—'),
        primary: ok ? '正常' : (o.code || '异常'),
        unit: '',
        rightLabel: 'HTTP',
        right: ok ? String(httpPort || '—') : '检查',
        suffix: ok ? '端口' : '',
        ratio: ok ? 1 : .15,
        tone: ok ? 'ok' : 'bad',
        primaryText: true
      };
    }
    if (id === 'update') {
      var up = s.update || {};
      var latest = up.latest && up.latest.version;
      var same = latest && latest === up.currentVersion;
      return {
        label: '版本',
        context: latest && !same ? 'latest ' + latest : '',
        primary: up.currentVersion || '—',
        unit: '',
        rightLabel: '状态',
        right: up.enabled === false ? '未启用' : (same ? '已是最新' : (latest ? '可更新' : '未检查')),
        suffix: '',
        ratio: same ? 1 : .35,
        tone: same ? 'ok' : 'warn',
        primaryText: true
      };
    }
    if (id === 'panel') {
      var p = s.panel || {};
      var stale = !!p.stale;
      var connected = online;
      return {
        label: '面板',
        context: 'pid ' + (p.pid || '—'),
        primary: connected ? (stale ? '旧代码' : '已连接') : '未连接',
        unit: '',
        rightLabel: '状态',
        right: connected ? (stale ? '待重启' : '在线') : '离线',
        suffix: '',
        ratio: connected ? (stale ? .2 : 1) : 0,
        tone: !connected ? 'warn' : (stale ? 'warn' : 'ok'),
        primaryText: true
      };
    }
    var a = s.account || {};
    var nick = a.nickname || '';
    return {
      label: '在线账号',
      context: 'OneBot v11',
      primary: nick || '未登录',
      unit: '',
      rightLabel: '状态',
      right: online ? '在线' : '演示',
      suffix: '',
      ratio: online ? 1 : 0,
      tone: online ? 'ok' : 'idle',
      primaryText: true
    };
  }

  function enabledList() {
    return state.cfg.order.filter(function (id) { return state.cfg.enabled.indexOf(id) >= 0; });
  }

  /* ── 几何与外观 ────────────────────────────────────────────────── */
  function tokens() {
    var h = state.cfg.height;
    var w = state.widthActual || state.cfg.width;
    var r = state.cfg.ratios;
    var cs = state.cfg.contentScale;
    var ts = state.cfg.typeScale;
    var plate = h * r.plate * cs;
    var plateFinal = plate * .8;
    var pad = h * r.pad * cs;
    var gap = h * r.gap * cs;
    var dataInset = pad + plateFinal + gap;
    var iconC = pad + plateFinal / 2 - w / 2;
    return {
      h: h,
      w: w,
      plate: plate,
      plateFinal: plateFinal,
      glyph: h * r.glyph * cs,
      pad: pad,
      gap: gap,
      dataInset: dataInset,
      ring: h * r.ring * cs,
      ringStroke: 3.2,
      fsPrimary: Math.max(12, h * r.primary * ts),
      fsSecondary: Math.max(10.5, h * r.secondary * ts),
      fsRight: Math.max(10, h * r.right * ts),
      fsLabel: Math.max(9.5, h * .22 * ts),
      fsTitle: Math.max(12, h * r.title * ts),
      fsTag: Math.max(9, h * r.tag * ts),
      fsSuffix: Math.max(9.5, h * .24 * ts),
      fsStatus: Math.max(11.5, h * .29 * ts),
      radiusB: h * r.radiusB,
      haloLine: Math.max(1, plate * .06),
      iconC: iconC,
      iconB: iconC * (179 / 245),
      titleShift: (plateFinal + Math.max(8, gap * 1.3)) / 2
    };
  }

  function resolvedMaterial() {
    return state.cfg.material === 'auto' ? 'glass' : state.cfg.material;
  }
  function isDarkSurface() {
    var m = resolvedMaterial();
    var darkTheme = document.documentElement.dataset.theme === 'dark';
    return m === 'black' || (m !== 'white' && darkTheme);
  }
  function accentFor() {
    var material = resolvedMaterial();
    var theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    var darkSurface = isDarkSurface();
    if (state.cfg.accent === 'theme') {
      if (material === 'black') return '#ff9a4d';
      if (material === 'white') return '#006b7c';
      return theme === 'dark' ? '#ff9a4d' : '#006b7c';
    }
    var map = {
      cyan: { light: '#006b7c', dark: '#22d3ee' },
      orange: { light: '#b45309', dark: '#ff9a4d' },
      purple: { light: '#6d28d9', dark: '#c4b5fd' }
    };
    var acc = map[state.cfg.accent] || map.cyan;
    return darkSurface ? acc.dark : acc.light;
  }

  function setVar(st, name, val) {
    if (st.getPropertyValue(name) !== val) st.setProperty(name, val);
  }

  function applyLook(force) {
    if (!state.isle) return;
    var material = resolvedMaterial();
    var theme = document.documentElement.dataset.theme || 'light';
    var accent = accentFor();
    var dark = isDarkSurface();
    var key = material + '|' + accent + '|' + state.cfg.font + '|' + theme;
    if (!force && key === state.lookKey) return;
    state.lookKey = key;
    if (state.isle.dataset.material !== material) state.isle.dataset.material = material;
    if (state.isle.dataset.font !== state.cfg.font) state.isle.dataset.font = state.cfg.font;
    setVar(state.isle.style, '--isle-accent', accent);
    setVar(state.isle.style, '--isle-accent-ink', dark ? '#171008' : '#ffffff');
    setVar(state.isle.style, '--halo-ink', dark ? '196, 206, 220' : '66, 78, 94');
  }

  function tokenKey() {
    var c = state.cfg, r = c.ratios;
    return [
      state.widthActual, c.height, c.contentScale, c.typeScale, c.haloScale,
      r.plate, r.glyph, r.pad, r.gap, r.ring, r.radiusB,
      r.primary, r.secondary, r.right, r.title, r.tag,
    ].join('|');
  }

  function applyTokens(force) {
    if (!state.isle) return;
    var key = tokenKey();
    if (!force && key === state.tokenKey) return;
    state.tokenKey = key;
    var t = tokens();
    var st = state.isle.style;
    setVar(st, '--isle-w', state.widthActual + 'px');
    setVar(st, '--isle-h', t.h + 'px');
    setVar(st, '--isle-plate', t.plate.toFixed(2) + 'px');
    setVar(st, '--isle-glyph', t.glyph.toFixed(2) + 'px');
    setVar(st, '--isle-data-inset', t.dataInset.toFixed(2) + 'px');
    setVar(st, '--isle-gap', t.gap.toFixed(2) + 'px');
    setVar(st, '--isle-ring', t.ring.toFixed(2) + 'px');
    setVar(st, '--ring-stroke', t.ringStroke.toFixed(2));
    setVar(st, '--fs-primary', t.fsPrimary.toFixed(2) + 'px');
    setVar(st, '--fs-secondary', t.fsSecondary.toFixed(2) + 'px');
    setVar(st, '--fs-right', t.fsRight.toFixed(2) + 'px');
    setVar(st, '--fs-label', t.fsLabel.toFixed(2) + 'px');
    setVar(st, '--fs-title', t.fsTitle.toFixed(2) + 'px');
    setVar(st, '--fs-tag', t.fsTag.toFixed(2) + 'px');
    setVar(st, '--fs-suffix', t.fsSuffix.toFixed(2) + 'px');
    setVar(st, '--fs-status', t.fsStatus.toFixed(2) + 'px');
    setVar(st, '--isle-radius-b', t.radiusB.toFixed(2) + 'px');
    setVar(st, '--icon-final', t.iconC.toFixed(2) + 'px');
    setVar(st, '--title-shift', t.titleShift.toFixed(2) + 'px');
    setVar(st, '--halo-disc', (t.plate * 5 * state.cfg.haloScale).toFixed(2) + 'px');
    setVar(st, '--halo-ring1', (t.plate * 6.9 * state.cfg.haloScale).toFixed(2) + 'px');
    setVar(st, '--halo-ring2', (t.plate * 8.75 * state.cfg.haloScale).toFixed(2) + 'px');
    setVar(st, '--halo-line', t.haloLine.toFixed(2) + 'px');
    if (state.activeId) applyTitleShift(state.activeId);
    if (state.els.ringArc) {
      var dash = String(RING_C);
      if (state.els.ringArc.style.strokeDasharray !== dash) state.els.ringArc.style.strokeDasharray = dash;
    }
  }

  function applyDetail(force) {
    if (!state.isle) return;
    var d = state.cfg.detail;
    if (d === 'auto') {
      var w = state.widthActual;
      var h = state.cfg.height;
      d = (w < 260 || h < 32) ? 'minimal' : (w < 320 || h < 36) ? 'compact' : 'full';
    }
    if (!force && state.isle.dataset.detail === d) return;
    state.isle.dataset.detail = d;
  }

  /* 量宽只在「可能变了」时做。信息岛永远居中，所以宽度只由配置与视口决定，
     不再读左右品牌/按钮的布局 —— 左右内容不参与岛的几何。 */
  function measure(force) {
    if (!state.host) return;
    var viewport = Math.max(0, window.innerWidth - 24);
    var want = Math.min(state.cfg.width, viewport);
    var density = want >= 300 ? 'full' : (want >= 160 ? 'icon' : 'hidden');
    var widthActual = density === 'hidden' ? 0 : Math.round(want);
    if (!force && state.measured && widthActual === state.widthActual && density === state.density) return;
    state.widthActual = widthActual;
    state.density = density;
    state.measured = true;
    state.isle.hidden = density === 'hidden';
    var compact = density !== 'full';
    if (state.isle.classList.contains('compact') !== compact) state.isle.classList.toggle('compact', compact);
    applyTokens();
    applyDetail();
  }

  /* ── 渲染 ──────────────────────────────────────────────────────── */
  function setTxt(el, txt) {
    var s = txt == null ? '' : String(txt);
    if (el && el.textContent !== s) el.textContent = s;
  }
  function setDisp(el, on) {
    if (!el) return;
    var v = on ? '' : 'none';
    if (el.style.display !== v) el.style.display = v;
  }
  function setCls(el, cls, on) {
    if (el && el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
  }

  /* ── 数字滚轮 ───────────────────────────────────────────────────────
     定宽槽 + 上下软遮罩 + 方向感知。轨道预排 3 组 0–9 + 末尾 0，
     偏移 10 格，滚动位置单位是“格”，位移用 em，随字号缩放。 */
  var WHEEL_BASE = 10;
  var WHEEL_COUNT = 31;

  function splitLead(text) {
    var s = String(text == null ? '' : text);
    var m = s.match(/^([¥$€£])([\s\S]*)$/);
    return m ? { sig: m[1], rest: m[2] } : { sig: '', rest: s };
  }
  function makeWheel() {
    var w = document.createElement('span');
    w.className = 'wheel';
    var ghost = document.createElement('span');
    ghost.className = 'wheel-ghost';
    ghost.textContent = '0';
    var track = document.createElement('span');
    track.className = 'wheel-track';
    for (var i = 0; i < WHEEL_COUNT; i++) {
      var cell = document.createElement('span');
      cell.className = 'wheel-cell';
      cell.textContent = String(i % 10);
      track.appendChild(cell);
    }
    w.appendChild(ghost);
    w.appendChild(track);
    w._track = track;
    w._pos = WHEEL_BASE;
    w._digit = 0;
    w._roll = null;
    return w;
  }
  function setWheelPos(w, pos) {
    w._pos = pos;
    w._track.style.transform = 'translateY(' + (-pos) + 'em)';
  }
  function wheelVisualPos(w) {
    var tr = getComputedStyle(w._track).transform;
    if (!tr || tr === 'none') return w._pos;
    var em = parseFloat(getComputedStyle(w).fontSize) || 16;
    try { return -new DOMMatrixReadOnly(tr).m42 / em; } catch (e) { return w._pos; }
  }
  function settleWheel(w, digit) {
    if (w._roll) { try { w._roll.cancel(); } catch (e) { /* 已结束 */ } w._roll = null; }
    var face = ((digit % 10) + 10) % 10;
    w._digit = face;
    setWheelPos(w, WHEEL_BASE + face);
  }
  function rollWheel(w, digit, dir, duration) {
    var target = ((digit % 10) + 10) % 10;
    if (isReduced()) { settleWheel(w, target); return; }
    var at = w._pos;
    if (w._roll) {
      at = wheelVisualPos(w);
      try { w._roll.cancel(); } catch (e) { /* 已结束 */ }
      w._roll = null;
      setWheelPos(w, at);
    }
    var face = ((at - WHEEL_BASE) % 10 + 10) % 10;
    var up = (target - face + 10) % 10;
    var down = (face - target + 10) % 10;
    if (up < .001 && down < .001) { w._digit = target; return; }
    var goal = dir < 0 && down > 0 ? at - down : at + up;
    w._digit = target;
    var anim = w._track.animate([
      { transform: 'translateY(' + (-at) + 'em)' },
      { transform: 'translateY(' + (-goal) + 'em)' }
    ], { duration: duration || 420, easing: EASE.wheel, fill: 'both' });
    w._roll = anim;
    anim.onfinish = function () {
      w._roll = null;
      try { anim.cancel(); } catch (e) { /* 已结束 */ }
      setWheelPos(w, WHEEL_BASE + target);
    };
  }
  function tokenizePrimary(text) {
    var parts = splitLead(text);
    var tokens = [];
    if (parts.sig) tokens.push({ t: 'sig', c: parts.sig });
    for (var i = 0; i < parts.rest.length; i++) {
      var ch = parts.rest[i];
      tokens.push(/[0-9]/.test(ch) ? { t: 'digit', c: ch } : { t: 'mark', c: ch });
    }
    return tokens;
  }
  function sameStructure(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].t !== b[i].t) return false;
      if (a[i].t !== 'digit' && a[i].c !== b[i].c) return false;
    }
    return true;
  }
  function digitsValue(tokens) {
    var raw = '';
    tokens.forEach(function (t) { if (t.t === 'digit') raw += t.c; });
    return raw ? Number(raw) : NaN;
  }
  function cancelPrimaryRolls() {
    (state.primaryWheels || []).forEach(function (w) {
      if (w._roll) { try { w._roll.cancel(); } catch (e) { /* 已结束 */ } w._roll = null; }
    });
  }
  function wheelDuration() { return 420 / clamp(Number(state.cfg.speed) || 1, .5, 2); }

  function primaryFits() {
    var b = state.els.primary;
    return !b || b.clientWidth <= 0 || b.scrollWidth <= b.clientWidth + 1;
  }
  function primaryFallbackText(text) {
    var b = state.els.primary;
    cancelPrimaryRolls();
    b.textContent = text;
    state.primaryWheels = [];
    state.primaryTokens = null;
    state.primaryNumber = NaN;
    state.primaryPending = false;
    state.primaryFallback = text;
  }
  /* mode: zero=从 0 起（换项种子，等 data-in 再滚）/ target=直接落位 /
     roll=同一指标刷新，从当前值滚到新值。 */
  function paintPrimary(text, mode, forceText) {
    var s = String(text == null ? '' : text);
    var b = state.els.primary;
    if (!b) return false;
    var numeric = !forceText && /^[¥$€£+\-−]?\d/.test(s);
    if (!numeric) {
      cancelPrimaryRolls();
      b.textContent = s;
      b.dataset.value = s;
      state.primaryWheels = [];
      state.primaryTokens = null;
      state.primaryNumber = NaN;
      state.primaryPending = false;
      state.primaryFallback = '';
      return false;
    }
    if (state.primaryFallback && state.primaryFallback === s && mode !== 'target') {
      cancelPrimaryRolls();
      b.textContent = s;
      state.primaryWheels = [];
      state.primaryTokens = null;
      state.primaryNumber = NaN;
      state.primaryPending = false;
      return true;
    }
    var tokens = tokenizePrimary(s);
    var prevWheels = state.primaryWheels || [];
    var canReuse = mode === 'roll' && sameStructure(state.primaryTokens, tokens)
      && prevWheels.length === tokens.filter(function (t) { return t.t === 'digit'; }).length;
    if (canReuse) {
      var prev = state.primaryNumber;
      var next = digitsValue(tokens);
      var dir = Number.isFinite(prev) && Number.isFinite(next) && next < prev ? -1 : 1;
      var wi = 0;
      tokens.forEach(function (tok) {
        if (tok.t !== 'digit') return;
        rollWheel(prevWheels[wi++], Number(tok.c), dir, wheelDuration());
      });
      state.primaryTokens = tokens;
      state.primaryNumber = next;
      state.primaryPending = false;
      state.primaryFallback = '';
      b.dataset.value = s;
      return true;
    }
    cancelPrimaryRolls();
    b.replaceChildren();
    state.primaryFallback = '';
    var wheels = [];
    tokens.forEach(function (tok) {
      if (tok.t === 'sig') {
        var sig = document.createElement('span');
        sig.className = 'sig';
        sig.textContent = tok.c;
        b.appendChild(sig);
      } else if (tok.t === 'mark') {
        var mark = document.createElement('span');
        mark.className = 'value-mark';
        mark.textContent = tok.c;
        b.appendChild(mark);
      } else {
        var w = makeWheel();
        w._digit = Number(tok.c);
        if (mode === 'target') settleWheel(w, w._digit);
        else setWheelPos(w, WHEEL_BASE);
        b.appendChild(w);
        wheels.push(w);
      }
    });
    state.primaryWheels = wheels;
    state.primaryTokens = tokens;
    state.primaryNumber = digitsValue(tokens);
    state.primaryPending = mode === 'zero';
    b.dataset.value = s;
    if (mode === 'roll') {
      requestAnimationFrame(function () {
        wheels.forEach(function (w) { rollWheel(w, w._digit, 1, wheelDuration()); });
      });
    }
    if (wheels.length) requestAnimationFrame(function () {
      if (state.primaryWheels === wheels && !primaryFits()) primaryFallbackText(s);
    });
    return true;
  }
  function rollPrimary() {
    state.primaryPending = false;
    (state.primaryWheels || []).forEach(function (w) {
      rollWheel(w, w._digit, 1, wheelDuration());
    });
  }
  function settlePrimary() {
    state.primaryPending = false;
    (state.primaryWheels || []).forEach(function (w) { settleWheel(w, w._digit); });
  }
  function scheduleWheelRoll(ms) {
    clearTimeout(state.rollTimer);
    state.rollTimer = setTimeout(function () {
      if (!state.frozen) rollPrimary();
    }, Math.max(0, ms));
  }
  function setArc(ratio) {
    var r = clamp(Number(ratio) || 0, 0, 1);
    var off = String(RING_C * (1 - r));
    if (state.els.ringArc && state.els.ringArc.style.strokeDashoffset !== off) {
      state.els.ringArc.style.strokeDashoffset = off;
    }
  }
  function applyPendingArc() {
    if (state.pendingRatio == null) return;
    var r = state.pendingRatio;
    state.pendingRatio = null;
    setArc(r);
  }

  function renderItem(id, opts) {
    id = isItem(id) ? id : (state.cfg.enabled[0] || state.cfg.order[0] || 'usage');
    var v = valueOfItem(id);
    state.activeId = id;
    var e = state.els;
    if (!e.primary) return;
    var tone = v.tone || 'ok';
    if (e.isle.dataset.tone !== tone) e.isle.dataset.tone = tone;
    setTxt(e.label, v.label || (ITEM[id] || ITEM.usage).title);
    setTxt(e.ctx, v.context || '');
    setDisp(e.ctx, !!v.context);
    var wheelMode = (opts && opts.wheelMode) || 'target';
    var numeric = paintPrimary(v.primary == null ? '—' : v.primary, wheelMode, !!v.primaryText);
    setCls(e.primaryWrap, 'is-text', !!v.primaryText || !numeric);
    setTxt(e.unit, v.unit || '');
    setDisp(e.unit, !!v.unit);
    setTxt(e.rightLabel, v.rightLabel || '');
    setDisp(e.rightLabel, !!v.rightLabel);
    setTxt(e.right, v.right == null ? '' : v.right);
    setTxt(e.suffix, v.suffix || '');
    setDisp(e.suffix, !!v.suffix);
    setCls(e.rightWrap, 'is-text', !v.suffix);
    setDisp(e.rightWrap, !!(v.rightLabel || v.right));
    var ratio = v.ratio == null ? null : clamp(Number(v.ratio) || 0, 0, 1);
    setDisp(e.ring, ratio != null);
    if (ratio != null) {
      if (opts && opts.deferArc) state.pendingRatio = ratio;
      else { state.pendingRatio = null; setArc(ratio); }
    } else {
      state.pendingRatio = null;
    }
    var meta = ITEM[id] || ITEM.usage;
    setTxt(e.tag, '/// ' + meta.tag);
    setTxt(e.title, meta.title);
    applyTitleShift(id);
    var svg = icon(meta.icon, 16) || '';
    if (e.glyph.innerHTML !== svg) e.glyph.innerHTML = svg;
    if (state.popOpen) renderPopover();
  }

  function renderPopover() {
    var pop = state.els.pop;
    if (!pop) return;
    var rows = state.cfg.order.map(function (id) {
      return { id: id, v: valueOfItem(id), on: state.cfg.enabled.indexOf(id) >= 0 };
    });    var sig = rows.map(function (r) {
      return r.id + '|' + r.v.primary + '|' + r.v.unit + '|' + r.v.context + '|' + r.v.tone + '|' + (r.on ? 1 : 0);
    }).join(';') + '|' + state.activeId + '|' + state.paused;
    if (sig === state.popSig && pop.firstChild) return;
    state.popSig = sig;
    var list = pop.querySelector('.isle-pop-list');
    var scroll = list ? list.scrollTop : 0;
    var html = rows.map(function (r) {
      var def = ITEM[r.id] || ITEM.usage;
      return '<button class="isle-pop-row' + (r.id === state.activeId ? ' on' : '') + '" type="button" data-isle-id="' + r.id + '">'
        + '<span class="isle-pop-ico">' + icon(def.icon, 14) + '</span>'
        + '<span class="isle-pop-name"><b>' + esc(def.title) + '</b><i>' + esc(r.on ? def.tag : '未启用') + '</i></span>'
        + '<span class="isle-pop-val">' + esc(r.v.primary) + (r.v.unit ? esc(r.v.unit) : '') + (r.v.context ? ' <i>' + esc(r.v.context) + '</i>' : '') + '</span>'
        + '<span class="isle-pop-dot ' + esc(r.v.tone) + '"></span></button>';
    }).join('');
    pop.innerHTML = '<div class="isle-pop-head"><b>状态岛</b><span>' + state.cfg.enabled.length + ' / ' + ALL.length + ' 项轮播</span></div>'
      + '<div class="isle-pop-list">' + html + '</div>'
      + '<div class="isle-pop-foot">'
      + '<button type="button" data-isle-act="prev">上一条</button>'
      + '<button type="button" data-isle-act="pause">' + (state.paused ? '继续轮播' : '暂停轮播') + '</button>'
      + '<button type="button" data-isle-act="next">下一条</button>'
      + '<button type="button" data-isle-act="settings" class="primary">HUD 调整</button>'
      + '</div>';
    list = pop.querySelector('.isle-pop-list');
    if (list && scroll) list.scrollTop = scroll;
  }
  function placePopover() {
    var pop = state.els.pop;
    if (!pop || pop.hidden) return;
    var r = state.isle.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left + r.width / 2 - pop.offsetWidth / 2)) + 'px';
    pop.style.top = (r.bottom + 8) + 'px';
  }
  function openPopover() {
    var pop = state.els.pop;
    if (!pop) return;
    state.popOpen = true;
    pop.hidden = false;
    state.isle.setAttribute('aria-expanded', 'true');
    renderPopover();
    placePopover();
    if (isReduced() || !pop.animate) return;
    try {
      if (state.popAnim) state.popAnim.cancel();
      state.popAnim = pop.animate([
        { opacity: 0, transform: 'translateY(-6px) scale(.96)' },
        { opacity: 1, transform: 'translateY(0) scale(1)' }
      ], { duration: 180, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' });
      state.popAnim.onfinish = function () {
        try { state.popAnim && state.popAnim.cancel(); } catch (e) { /* 已结束 */ }
        state.popAnim = null;
      };
    } catch (e) { /* 动画不可用时直接显示 */ }
  }
  function closePopover() {
    var pop = state.els.pop;
    if (!pop) return;
    state.popOpen = false;
    state.isle.setAttribute('aria-expanded', 'false');
    if (isReduced() || !pop.animate) { pop.hidden = true; return; }
    try {
      if (state.popAnim) state.popAnim.cancel();
      var a = pop.animate([
        { opacity: 1, transform: 'translateY(0) scale(1)' },
        { opacity: 0, transform: 'translateY(-4px) scale(.98)' }
      ], { duration: 120, easing: 'cubic-bezier(.4,0,1,1)', fill: 'both' });
      state.popAnim = a;
      a.onfinish = function () {
        try { a.cancel(); } catch (e) { /* 已结束 */ }
        state.popAnim = null;
        if (!state.popOpen) pop.hidden = true;
      };
    } catch (e) { pop.hidden = true; }
  }

  /* ── 时间轴 ────────────────────────────────────────────────────── */
  function isReduced() {
    return !!state.cfg.reduced || !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function cancelAnims() {
    state.anims.forEach(function (a) { try { a.cancel(); } catch (e) { /* 已结束 */ } });
    state.anims = [];
    state.switching = false;
    state.frozen = false;
    state.pendingRatio = null;
    clearTimeout(state.settleTimer);
    clearTimeout(state.seedTimer);
    clearTimeout(state.rollTimer);
    clearTimeout(state.arcTimer);
    if (state.isle) {
      state.isle.classList.remove('is-timing');
      state.isle.style.opacity = '';
    }
  }
  function anim(el, frames, duration, opts) {
    if (!el || !el.animate) return null;
    try { return el.animate(frames, Object.assign({ duration: duration, fill: 'both' }, opts || {})); } catch (e) { return null; }
  }
  function iconFrame(x) { return 'translate(-50%, -50%) translateX(' + x.toFixed(1) + 'px)'; }
  function hostFrame(x, y) { return 'translateX(' + x.toFixed(1) + 'px) translateY(' + (y || 0) + 'px)'; }

  function playEntrance() {
    if (!state.mounted || !state.isle) return;
    cancelAnims();
    var W = state.widthActual, H = state.cfg.height;
    var wide = state.density === 'full' && W >= 240;
    var total = wide ? 1320 : 620;
    if (isReduced()) {
      state.timelineMs = total;
      state.switchKind = 'reduced';
      state.switching = false;
      state.seekMs = 0;
      renderItem(state.activeId);
      scheduleNext();
      return;
    }
    state.timelineMs = total;
    state.switchKind = 'entrance';
    state.switching = true;
    state.switchStart = performance.now();
    state.seekMs = 0;
    state.isle.classList.add('is-timing');
    var D = total / state.cfg.speed;
    var o = function (ms) { return clamp(ms, 0, total) / total; };
    var anims = [];
    var add = function (a) { if (a) anims.push(a); };
    var e = state.els;
    renderItem(state.activeId, { wheelMode: 'zero' });
    var arcEnd = parseFloat(e.ringArc.style.strokeDashoffset) || 0;
    add(anim(state.isle, [
      { offset: 0, width: Math.max(12, H) + 'px' },
      { offset: o(200), width: Math.max(12, H) + 'px', easing: EASE.settle },
      { offset: o(wide ? 780 : 340), width: W + 'px' },
      { offset: 1, width: W + 'px' }
    ], D));
    add(anim(state.isle, [
      { offset: 0, opacity: 0, transform: 'scale(.9)' },
      { offset: o(220), opacity: 1, transform: 'scale(1)', easing: EASE.pop },
      { offset: o(wide ? 780 : 340), opacity: 1, transform: 'scale(1)' },
      { offset: o(wide ? 1020 : 460), opacity: 1, transform: 'scale(1.006)', easing: EASE.settle },
      { offset: o(wide ? 1160 : 560), opacity: 1, transform: 'scale(1)' },
      { offset: 1, opacity: 1, transform: 'scale(1)' }
    ], D));
    if (wide) {
      add(anim(e.welcome, [
        { offset: 0, opacity: 0, clipPath: 'inset(0 100% 0 0)' },
        { offset: o(300), opacity: 0, clipPath: 'inset(0 100% 0 0)', easing: EASE.fade },
        { offset: o(520), opacity: 1, clipPath: 'inset(0 0 0 0)' },
        { offset: o(800), opacity: 1, clipPath: 'inset(0 0 0 0)', easing: EASE.fade },
        { offset: o(980), opacity: 1, clipPath: 'inset(0 0 0 100%)' },
        { offset: 1, opacity: 1, clipPath: 'inset(0 0 0 100%)' }
      ], D));
      add(anim(e.data, [
        { offset: 0, opacity: 0, clipPath: 'inset(0 100% 0 0)' },
        { offset: o(860), opacity: 0, clipPath: 'inset(0 100% 0 0)' },
        { offset: o(1080), opacity: 1, clipPath: 'inset(0 0 0 0)' },
        { offset: 1, opacity: 1, clipPath: 'inset(0 0 0 0)' }
      ], D));
      add(anim(e.ringArc, [
        { offset: 0, strokeDashoffset: RING_C },
        { offset: o(880), strokeDashoffset: RING_C, easing: EASE.settle },
        { offset: o(1120), strokeDashoffset: arcEnd },
        { offset: 1, strokeDashoffset: arcEnd }
      ], D));
      add(anim(e.plate, [
        { offset: 0, opacity: 0, transform: 'scale(.4)', borderRadius: '50%' },
        { offset: o(840), opacity: 0, transform: 'scale(.4)', borderRadius: '50%', easing: EASE.fade },
        { offset: o(1020), opacity: 1, transform: 'scale(.8)', borderRadius: '22%' },
        { offset: 1, opacity: 1, transform: 'scale(.8)', borderRadius: '22%' }
      ], D));
      add(anim(e.sweep, [
        { offset: 0, opacity: 0, transform: 'translateX(-140%) skewX(-14deg)' },
        { offset: o(860), opacity: 0, transform: 'translateX(-140%) skewX(-14deg)' },
        { offset: o(960), opacity: .85, transform: 'translateX(40%) skewX(-14deg)' },
        { offset: o(1140), opacity: 0, transform: 'translateX(240%) skewX(-14deg)' },
        { offset: 1, opacity: 0, transform: 'translateX(240%) skewX(-14deg)' }
      ], D));
    } else {
      add(anim(e.data, [
        { offset: 0, opacity: 0 }, { offset: o(200), opacity: 0 }, { offset: o(420), opacity: 1 }, { offset: 1, opacity: 1 }
      ], D));
      add(anim(e.ringArc, [
        { offset: 0, strokeDashoffset: RING_C },
        { offset: o(220), strokeDashoffset: RING_C, easing: EASE.settle },
        { offset: o(440), strokeDashoffset: arcEnd },
        { offset: 1, strokeDashoffset: arcEnd }
      ], D));
      add(anim(e.plate, [
        { offset: 0, opacity: 0, transform: 'scale(.4)' },
        { offset: o(160), opacity: 0, transform: 'scale(.4)' },
        { offset: o(360), opacity: 1, transform: 'scale(.8)', borderRadius: '22%' },
        { offset: 1, opacity: 1, transform: 'scale(.8)', borderRadius: '22%' }
      ], D));
    }
    state.anims = anims;
    settleAnims(anims, D + 100, total);
    scheduleWheelRoll((wide ? 940 : 470) / state.cfg.speed);
    scheduleNext();
  }

  /* ── 标题 lockup：画布量宽，图标停在文案左侧 gap 处 ─────────────── */
  var measureCtx = null;
  function lockupFor(id) {
    var t = tokens();
    var meta = ITEM[id] || ITEM.usage;
    var family = state.isle ? getComputedStyle(state.isle).fontFamily : 'sans-serif';
    var key = [id, t.fsTitle.toFixed(2), t.fsTag.toFixed(2), t.gap.toFixed(2),
      t.plateFinal.toFixed(2), family].join('|');
    if (key === state.lockKey && state.lock) return state.lock;
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    var measure = function (text, size, lsEm) {
      measureCtx.font = '600 ' + size + 'px ' + family;
      return measureCtx.measureText(text).width + Math.max(0, text.length - 1) * size * lsEm;
    };
    var w = Math.max(measure(meta.title, t.fsTitle, .08), measure('/// ' + meta.tag, t.fsTag, .26));
    var gap = Math.max(8, t.gap * 1.3);
    state.lockKey = key;
    state.lock = { w: w, gap: gap, shift: (t.plateFinal + gap) / 2, bx: -(w + gap) / 2 };
    return state.lock;
  }
  function titleBxPx(id) {
    return clamp(lockupFor(id).bx, tokens().iconC, 0);
  }
  function applyTitleShift(id) {
    if (!state.isle) return;
    state.isle.style.setProperty('--title-shift', lockupFor(id).shift.toFixed(1) + 'px');
  }

  /* ── 三档时间轴（原型 T 表 + 设置页偏移）────────────────────────── */
  function timelineFor(mode) {
    var base;
    if (mode === 'quick') {
      base = {
        total: 1000, exit: 90,
        radiusIn: [20, 160], radiusOut: [720, 900],
        plateIn: [30, 150], plateOut: [720, 860], seed: 170,
        windup1: 180, slide1: [200, 340], windup2: 540, slide2: [560, 720],
        dataIn: 740, titleTagIn: null, titleIn: null, titleHold: 0, titleOut: 0,
        haloDisc: [50, 150, 340, 460], haloRing1: [70, 170, 360, 480], haloRing2: [90, 190, 380, 500]
      };
    } else if (mode === 'handoff') {
      base = {
        total: 1440, exit: 90,
        radiusIn: [0, 150], radiusOut: [830, 1120],
        plateIn: [0, 150], plateOut: [1020, 1140], seed: 160,
        windup1: 160, slide1: [180, 360],
        titleTagIn: [380, 470], titleIn: [390, 560], titleHold: 700, titleOut: 770,
        windup2: 830, slide2: [830, 1020], dataIn: 1040,
        haloDisc: [30, 160, 360, 540], haloRing1: [60, 190, 380, 520], haloRing2: [90, 220, 400, 540]
      };
    } else if (mode === 'birth') {
      base = {
        total: 1400, exit: 90,
        radiusIn: [0, 170], radiusOut: [810, 1060],
        plateIn: [0, 150], plateOut: [1000, 1120], seed: 130,
        windup1: 0, slide1: [160, 340],
        titleTagIn: [360, 460], titleIn: [370, 540], titleHold: 680, titleOut: 750,
        windup2: 810, slide2: [810, 1000], dataIn: 1020,
        haloDisc: [0, 100, 340, 520], haloRing1: [30, 130, 360, 500], haloRing2: [60, 160, 380, 520]
      };
    } else {
      base = {
        total: 1500, exit: 90,
        radiusIn: [20, 220], radiusOut: [900, 1210],
        plateIn: [30, 210], plateOut: [1090, 1210], seed: 200,
        windup1: 230, slide1: [250, 430],
        titleTagIn: [450, 560], titleIn: [470, 640], titleHold: 780, titleOut: 850,
        windup2: 900, slide2: [900, 1090], dataIn: 1120,
        haloDisc: [40, 180, 380, 560], haloRing1: [70, 210, 400, 540], haloRing2: [100, 240, 420, 560]
      };
    }
    var off = {
      exit: state.cfg.rewindMs,
      seed: state.cfg.seedMs,
      slide1: state.cfg.slide1Ms,
      hold: state.cfg.titleHoldMs,
      slide2: state.cfg.slide2Ms,
      dataIn: state.cfg.dataInMs
    };
    var total = clamp(base.total + off.exit + off.seed + off.slide1 + off.hold + off.slide2 + off.dataIn, 900, 2400);
    var T = Object.assign({}, base);
    T.total = total;
    T.exit = clamp(base.exit + off.exit, 40, 360);
    T.seed = clamp(base.seed + off.seed, 40, total - 240);
    T.slide1 = [base.slide1[0], clamp(base.slide1[1] + off.slide1, base.slide1[0] + 60, total - 120)];
    T.slide2 = [base.slide2[0], clamp(base.slide2[1] + off.slide2, base.slide2[0] + 60, total - 40)];
    if (base.titleIn) {
      T.titleHold = clamp(base.titleHold + off.hold, 80, total - 240);
      T.titleOut = clamp(base.titleOut + off.hold + Math.round(off.slide2 / 2), T.titleHold + 40, total - 100);
      T.dataIn = clamp(base.dataIn + off.dataIn, T.titleOut + 60, total - 40);
    } else {
      T.dataIn = clamp(base.dataIn + off.dataIn, 420, total - 40);
    }
    var fix = function (a) { return a.map(function (ms) { return clamp(ms, 0, total - 1); }); };
    T.radiusIn = fix(base.radiusIn);
    T.radiusOut = fix(base.radiusOut);
    T.plateIn = fix(base.plateIn);
    T.plateOut = fix(base.plateOut);
    T.haloDisc = fix(base.haloDisc);
    T.haloRing1 = fix(base.haloRing1);
    T.haloRing2 = fix(base.haloRing2);
    return { T: T, total: total };
  }

  /* 可中断时间轴：打断时先拍下 computed 状态，新时间轴头部插融合帧。 */
  function captureInterrupt() {
    var pick = function (el, props) {
      if (!el) return null;
      var c = getComputedStyle(el), f = {};
      props.forEach(function (p) { f[p] = c[p]; });
      return f;
    };
    var r = state.els;
    return {
      title: pick(r.titleWrap, ['opacity', 'transform', 'filter']),
      tag: pick(r.tag, ['opacity', 'transform', 'filter', 'letterSpacing']),
      name: pick(r.title, ['opacity', 'transform', 'filter', 'letterSpacing']),
      parts: [r.leftMicro, r.leftValue, r.rightMicro, r.rightValue, r.ring].map(function (el) {
        return pick(el, ['opacity', 'transform', 'filter']);
      }),
      isle: pick(r.isle, ['borderRadius']),
      plate: pick(r.plate, ['transform', 'borderRadius']),
      icon: pick(r.icon, ['transform']),
      host: pick(r.host, ['transform']),
      r1: pick(r.r1, ['opacity', 'transform']),
      r2: pick(r.r2, ['opacity', 'transform']),
      r3: pick(r.r3, ['opacity', 'transform'])
    };
  }
  function blendTo(frames, cap, target, blendMs, total) {
    if (!cap || frames.length < 2) return frames;
    var limit = frames[1].offset * total - 8;
    if (limit < 8) return frames;
    var b = clamp(blendMs, 8, limit);
    var bridge = Object.assign({}, target, { offset: b / total, easing: frames[0].easing });
    var capFrame = Object.assign({}, cap, { offset: 0, easing: 'ease-out' });
    return [capFrame, bridge].concat(frames.slice(1));
  }
  function haloAnim(el, times, target, opacityPeak, D, total, cap) {
    if (!el || !opacityPeak) return null;
    var o = function (ms) { return clamp(ms, 0, total) / total; };
    var s = times[0], p = times[1], h = times[2], e2 = times[3];
    var frames = [
      { offset: 0, opacity: 0, transform: 'translate(-50%, -50%) scale(0)' },
      { offset: o(s), opacity: 0, transform: 'translate(-50%, -50%) scale(0)' },
      { offset: o(p), opacity: opacityPeak, transform: 'translate(-50%, -50%) scale(.06)', easing: 'cubic-bezier(.25,.8,.35,1)' },
      { offset: o(h), opacity: opacityPeak, transform: 'translate(-50%, -50%) scale(' + (target * .82) + ')' },
      { offset: o(e2), opacity: 0, transform: 'translate(-50%, -50%) scale(' + target + ')' }
    ];
    if (cap) {
      var fade = 120;
      s = Math.max(s, fade + 20);
      p = Math.max(p, fade + 80);
      frames.splice(0, 2,
        { offset: 0, opacity: cap.opacity, transform: cap.transform, easing: 'ease-out' },
        { offset: o(fade), opacity: 0, transform: cap.transform },
        { offset: o(s), opacity: 0, transform: 'translate(-50%, -50%) scale(0)' }
      );
    }
    return anim(el, frames, D);
  }

  /* 一轮读数共用的落位节奏：微标签 → 主值 → 右标签 → 右值 → 环。 */
  function dataTimeline(add, cap, T, total, D, birth, stagger, durs) {
    var o = function (ms) { return clamp(ms, 0, total) / total; };
    var parts = [state.els.leftMicro, state.els.leftValue, state.els.rightMicro, state.els.rightValue, state.els.ring];
    parts.forEach(function (el, i) {
      var isRing = i === 4;
      var s = T.dataIn + stagger[i];
      var e2 = Math.min(s + durs[i], total - 8);
      var from = isRing ? 'scale(.94)' : 'translateY(5px)';
      var exit = isRing ? 'scale(1)' : 'translateY(4px)';
      var clear = isRing ? 'scale(1)' : 'translateY(0px)';
      var frames = birth ? [
        { offset: 0, opacity: 0, transform: from, filter: isRing ? 'none' : 'blur(1.5px)' },
        { offset: o(s), opacity: 0, transform: from, filter: isRing ? 'none' : 'blur(1.5px)', easing: EASE.out },
        { offset: o(e2), opacity: 1, transform: clear, filter: 'blur(0px)' },
        { offset: 1, opacity: 1, transform: clear, filter: 'blur(0px)' }
      ] : [
        { offset: 0, opacity: 1, transform: clear, filter: 'blur(0px)' },
        { offset: o(T.exit), opacity: 0, transform: exit, filter: isRing ? 'none' : 'blur(1.5px)', easing: 'ease-in' },
        { offset: o(s), opacity: 0, transform: from, filter: isRing ? 'none' : 'blur(1.5px)', easing: EASE.out },
        { offset: o(e2), opacity: 1, transform: clear, filter: 'blur(0px)' },
        { offset: 1, opacity: 1, transform: clear, filter: 'blur(0px)' }
      ];
      add(anim(el, blendTo(frames, cap && cap.parts && cap.parts[i], { opacity: 0, transform: exit, filter: isRing ? 'none' : 'blur(1.5px)' }, 60, total), D));
    });
  }
  /* 标题卡：父层只做出现/消失总闸门；字距与位移分别在 tag/title 上落位。 */
  function titleCard(add, cap, T, total, D, o) {
    add(anim(state.els.titleWrap, blendTo([
      { offset: 0, opacity: 0 },
      { offset: o(T.titleIn[0]), opacity: 0, easing: EASE.fade },
      { offset: o(T.titleIn[0] + 40), opacity: 1 },
      { offset: o(T.titleOut), opacity: 1, easing: 'ease-in' },
      { offset: o(T.titleOut + 50), opacity: 0 },
      { offset: 1, opacity: 0 }
    ], cap && cap.title, { opacity: 0 }, 80, total), D));
    var mk = function (start, end, dy, ls0, ls1) {
      return [
        { offset: 0, opacity: 0, transform: 'translateY(' + dy + 'px)', filter: 'blur(2px)', letterSpacing: ls0 },
        { offset: o(start), opacity: 0, transform: 'translateY(' + dy + 'px)', filter: 'blur(2px)', letterSpacing: ls0, easing: EASE.out },
        { offset: o(end), opacity: 1, transform: 'translateY(0px)', filter: 'blur(0px)', letterSpacing: ls1 },
        { offset: o(T.titleOut), opacity: 1, transform: 'translateY(0px)', filter: 'blur(0px)', letterSpacing: ls1, easing: 'ease-in' },
        { offset: o(T.titleOut + 60), opacity: 0, transform: 'translateY(-3px)', filter: 'blur(2px)', letterSpacing: ls1 },
        { offset: 1, opacity: 0, transform: 'translateY(-3px)', filter: 'blur(2px)', letterSpacing: ls1 }
      ];
    };
    add(anim(state.els.tag, blendTo(mk(T.titleTagIn[0], T.titleTagIn[1], 3, '.40em', '.26em'),
      cap && cap.tag, { opacity: 0, transform: 'translateY(3px)', filter: 'blur(2px)', letterSpacing: '.40em' }, 70, total), D));
    add(anim(state.els.title, blendTo(mk(T.titleIn[0], T.titleIn[1], 8, '.20em', '.08em'),
      cap && cap.name, { opacity: 0, transform: 'translateY(8px)', filter: 'blur(2px)', letterSpacing: '.20em' }, 70, total), D));
  }

  function playSwitch(id, opts) {
    if (!state.mounted) return;
    if (isReduced()) { cancelAnims(); renderItem(id); scheduleNext(); return; }
    if (state.switching && performance.now() - state.switchStart < 200) { state.queued = id; return; }
    var birth = !!(opts && opts.birth);
    var mode = birth ? 'birth' : state.cfg.switchMode;
    var cap = state.anims.length ? captureInterrupt() : null;
    cancelAnims();
    id = isItem(id) ? id : state.activeId;
    var seq = timelineFor(mode);
    var T = seq.T;
    var total = seq.total;
    var D = total / state.cfg.speed;
    var o = function (ms) { return clamp(ms, 0, total) / total; };
    var t = tokens();
    var r = state.els;
    var C = t.iconC;
    var B = titleBxPx(id);
    var R = state.cfg.height / 2 + 'px';
    var RB = t.radiusB.toFixed(2) + 'px';
    var strength = state.cfg.haloStrength;
    var anims = [];
    var add = function (a) { if (a) anims.push(a); };
    state.switching = true;
    state.switchStart = performance.now();
    state.switchKind = mode;
    state.timelineMs = total;
    state.activeId = id;
    state.seekMs = 0;
    state.pendingRatio = null;
    if (state.isle) {
      state.isle.classList.add('is-timing');
      state.isle.style.opacity = birth ? '0' : '';
    }
    setTxt(r.tag, '/// ' + (ITEM[id] || ITEM.usage).tag);
    setTxt(r.title, (ITEM[id] || ITEM.usage).title);
    applyTitleShift(id);

    if (birth) {
      add(anim(state.isle, [
        { offset: 0, opacity: 0, transform: 'scale(.6)' },
        { offset: o(180), opacity: 1, transform: 'scale(1.015)' },
        { offset: o(240), opacity: 1, transform: 'scale(1)' }
      ], D, { easing: 'ease-out' }));
    }

    if (mode === 'quick') {
      dataTimeline(add, cap, T, total, D, birth, [0, 15, 30, 45, 30], [100, 140, 100, 130, 170]);
    } else {
      dataTimeline(add, cap, T, total, D, birth, [0, 24, 48, 72, 48], [130, 180, 130, 170, 220]);
    }
    if (mode === 'quick') {
      add(anim(r.titleWrap, blendTo([
        { offset: 0, opacity: 0 }, { offset: 1, opacity: 0 }
      ], cap && cap.title, { opacity: 0 }, 50, total), D));
    } else {
      titleCard(add, cap, T, total, D, o);
    }

    var rIn = [T.radiusIn[0] + state.cfg.radiusLead, T.radiusIn[1] + state.cfg.radiusLead];
    var rOut = [T.radiusOut[0] + state.cfg.radiusLead, T.radiusOut[1] + state.cfg.radiusLead];
    add(anim(state.isle, blendTo([
      { offset: 0, borderRadius: R, easing: EASE.settle },
      { offset: o(rIn[1]), borderRadius: RB },
      { offset: o(rOut[0]), borderRadius: RB, easing: EASE.settle },
      { offset: o(rOut[1]), borderRadius: R }
    ], cap && cap.isle, { borderRadius: R }, 70, total), D));

    /* 图标盘：bloom 时圆角方块长成整圆；两段滑动各带一次 5% 级挤压。 */
    var plateFrames = [];
    var pAt = function (ms, tx, radius, easing) {
      var f = { offset: o(ms), transform: typeof tx === 'number' ? 'scale(' + tx + ')' : tx, borderRadius: radius };
      if (easing) f.easing = easing;
      plateFrames.push(f);
    };
    var growEnd = T.plateIn[1];
    var outEnd = T.plateOut[1];
    var s1Mid = Math.round(((birth ? T.slide1[0] : T.windup1 + 30) + T.slide1[1]) / 2);
    var s2Mid = Math.round(((birth ? T.windup2 : T.windup2 + 30) + T.slide2[1]) / 2);
    if (birth) {
      pAt(0, 1, '50%'); pAt(100, 1, '50%');
      pAt(growEnd, 1.06, '50%', EASE.settle);
      pAt(growEnd + 40, 1, '50%');
      pAt(s1Mid, 'scale(1.05, .95)', '50%', EASE.settle);
      pAt(T.slide1[1], 1, '50%');
      pAt(T.windup2, 1, '50%');
      pAt(s2Mid, 'scale(1.04, .96)', '50%', EASE.settle);
      pAt(T.slide2[1], 1, '50%');
      pAt(outEnd, .8, '22%');
    } else if (mode === 'quick') {
      pAt(0, .8, '22%');
      pAt(50, .8, '22%');
      pAt(T.plateIn[1], 1, '50%', EASE.settle);
      pAt(T.slide1[1], 1.08, '50%', EASE.pop);
      pAt(T.slide1[1] + 40, 1, '50%');
      pAt(T.plateOut[0], 1.02, '50%', EASE.settle);
      pAt(outEnd, .8, '22%');
    } else {
      pAt(0, .8, '22%');
      pAt(Math.max(30, growEnd - 80), 1.05, '50%', EASE.settle);
      pAt(growEnd, 1, '50%');
      pAt(T.windup1 + 30, 'scale(1.03, .97)', '50%', EASE.settle);
      pAt(s1Mid, 'scale(1.06, .94)', '50%');
      pAt(T.slide1[1], 1, '50%');
      pAt(T.windup2, 1, '50%');
      pAt(T.windup2 + 30, 'scale(1.04, .96)', '50%', EASE.settle);
      pAt(s2Mid, 'scale(1.05, .95)', '50%');
      pAt(T.slide2[1], 1, '50%');
      pAt(outEnd, .8, '22%');
    }
    add(anim(r.plate, blendTo(plateFrames, cap && cap.plate, birth ? { transform: 'scale(1)', borderRadius: '50%' } : { transform: 'scale(.8)', borderRadius: '22%' }, 60, total), D));

    var iconFrames = [];
    var iAt = function (ms, x, easing) {
      var f = { offset: o(ms), transform: iconFrame(x) };
      if (easing) f.easing = easing;
      iconFrames.push(f);
    };
    if (birth) {
      iAt(0, 0); iAt(T.slide1[0], 0);
      iAt(T.slide1[1], B, EASE.settle);
      iAt(T.windup2, B); iAt(T.slide2[1], C, EASE.lock);
    } else {
      iAt(0, C); iAt(T.windup1, C);
      iAt(T.windup1 + 30, C - 4, EASE.settle);
      iAt(T.slide1[1], B, EASE.settle);
      iAt(T.windup2, B);
      iAt(T.windup2 + 30, B + 4, EASE.settle);
      iAt(T.slide2[1], C, EASE.lock);
    }
    add(anim(r.icon, blendTo(iconFrames, cap && cap.icon, { transform: iconFrame(birth ? 0 : C) }, 90, total), D));

    var hostFrames = [];
    var hAt = function (ms, x, easing) {
      var f = { offset: o(ms), transform: hostFrame(x) };
      if (easing) f.easing = easing;
      hostFrames.push(f);
    };
    if (birth) {
      hAt(0, 0); hAt(T.slide1[0], 0);
      hAt(T.slide1[1], B, EASE.settle);
      hAt(T.windup2, B); hAt(T.slide2[1], C, EASE.lock);
    } else {
      hAt(0, C); hAt(T.windup1, C);
      hAt(T.windup1 + 30, C - 4, EASE.settle);
      hAt(T.slide1[1], B, EASE.settle);
      hAt(T.windup2, B);
      hAt(T.windup2 + 30, B + 4, EASE.settle);
      hAt(T.slide2[1], C, EASE.lock);
    }
    add(anim(r.host, blendTo(hostFrames, cap && cap.host, { transform: hostFrame(birth ? 0 : C) }, 90, total), D));

    add(haloAnim(r.r1, T.haloDisc, 1.05, strength, D, total, cap && cap.r1));
    if (state.cfg.haloLayers >= 2) add(haloAnim(r.r2, T.haloRing1, 1.18, strength * 1.1, D, total, cap && cap.r2));
    if (state.cfg.haloLayers >= 3) add(haloAnim(r.r3, T.haloRing2, 1.30, strength * .9, D, total, cap && cap.r3));

    state.seedTimer = setTimeout(function () {
      renderItem(id, { wheelMode: 'zero', deferArc: true });
    }, T.seed / state.cfg.speed);
    clearTimeout(state.arcTimer);
    state.arcTimer = setTimeout(function () {
      if (!state.frozen) applyPendingArc();
    }, (T.dataIn + 20) / state.cfg.speed);
    scheduleWheelRoll((T.dataIn + 50) / state.cfg.speed);

    state.anims = anims.filter(Boolean);
    settleAnims(state.anims, D + 70, total);
    scheduleNext();
  }

  function settleAnims(anims, ms, finalSeek) {
    clearTimeout(state.settleTimer);
    state.settleTimer = setTimeout(function () {
      if (state.anims !== anims) return;
      if (state.frozen) return;
      anims.forEach(function (a) { try { a.cancel(); } catch (e) { /* 已结束 */ } });
      state.anims = [];
      state.switching = false;
      state.seekMs = finalSeek;
      if (state.isle) {
        state.isle.classList.remove('is-timing');
        state.isle.style.opacity = '';
      }
      applyPendingArc();
      if (state.primaryPendingData) {
        state.primaryPendingData = false;
        renderItem(state.activeId, { wheelMode: 'roll' });
      }
      if (state.queued) { var q = state.queued; state.queued = null; playSwitch(q); }
    }, ms);
  }

  function isPaused() {
    return state.paused || (state.cfg.pauseHover && (state.hover || state.focus)) || document.hidden || isReduced() || state.frozen;
  }
  function scheduleNext() {
    clearTimeout(state.timer);
    if (isPaused()) return;
    var list = enabledList();
    if (list.length < 2) return;
    state.timer = setTimeout(function () {
      if (isPaused()) return;
      var i = list.indexOf(state.activeId);
      switchTo(list[(i + 1 + list.length) % list.length]);
    }, Math.max(1500, state.cfg.interval));
  }
  function switchTo(id) {
    if (!state.mounted) return;
    if (state.frozen) freeze(false);
    playSwitch(id);
  }

  /* ── 挂载 ──────────────────────────────────────────────────────── */
  function mount() {
    if (state.mounted) return;
    var host = document.getElementById(HOST_ID);
    if (!host) return;
    state.host = host;
    host.innerHTML = ''
      + '<button class="isle" id="hudIsle" type="button" aria-label="运行状态" aria-expanded="false" aria-controls="hudIslePop" title="点击查看全部状态">'
      + '  <span class="isle-ripple-host" aria-hidden="true"><span class="ripple r1"></span><span class="ripple r2"></span><span class="ripple r3"></span></span>'
      + '  <span class="isle-welcome" aria-hidden="true"><b>Welcome to Estrella</b><i>Console · HUD</i></span>'
      + '  <span class="isle-sweep" aria-hidden="true"></span>'
      + '  <span class="isle-title" aria-hidden="true"><i class="tagline"></i><b class="title"></b></span>'
      + '  <span class="isle-icon" aria-hidden="true"><span class="plate"><span class="glyph"></span></span></span>'
      + '  <span class="isle-data" aria-hidden="true">'
      + '    <span class="readout primary"><span class="micro"><span class="lbl"></span><em class="ctx"></em></span><span class="value"><b class="primary"></b><em class="unit"></em></span></span>'
      + '    <span class="grow"></span>'
      + '    <span class="readout right"><span class="micro"></span><span class="value"><span class="stat-dot"></span><b></b><i></i></span></span>'
      + '    <span class="ring"><svg viewBox="0 0 36 36" aria-hidden="true"><circle class="ring-track" cx="18" cy="18" r="15.5"></circle><circle class="ring-arc" cx="18" cy="18" r="15.5"></circle></svg></span>'
      + '  </span>'
      + '</button>';
    var isle = host.querySelector('.isle');
    var pop = document.createElement('div');
    pop.className = 'isle-pop';
    pop.id = 'hudIslePop';
    pop.hidden = true;
    document.body.appendChild(pop);
    state.isle = isle;
    state.els = {
      isle: isle,
      pop: pop,
      welcome: isle.querySelector('.isle-welcome'),
      sweep: isle.querySelector('.isle-sweep'),
      titleWrap: isle.querySelector('.isle-title'),
      tag: isle.querySelector('.isle-title .tagline'),
      title: isle.querySelector('.isle-title .title'),
      icon: isle.querySelector('.isle-icon'),
      plate: isle.querySelector('.plate'),
      glyph: isle.querySelector('.glyph'),
      data: isle.querySelector('.isle-data'),
      primaryWrap: isle.querySelector('.readout.primary'),
      leftMicro: isle.querySelector('.readout.primary .micro'),
      leftValue: isle.querySelector('.readout.primary .value'),
      label: isle.querySelector('.readout.primary .micro .lbl'),
      ctx: isle.querySelector('.readout.primary .micro .ctx'),
      primary: isle.querySelector('.readout.primary .value b'),
      unit: isle.querySelector('.readout.primary .value .unit'),
      rightWrap: isle.querySelector('.readout.right'),
      rightMicro: isle.querySelector('.readout.right .micro'),
      rightValue: isle.querySelector('.readout.right .value'),
      rightLabel: isle.querySelector('.readout.right .micro'),
      right: isle.querySelector('.readout.right .value b'),
      suffix: isle.querySelector('.readout.right .value i'),
      ring: isle.querySelector('.ring'),
      ringArc: isle.querySelector('.ring-arc'),
      host: isle.querySelector('.isle-ripple-host'),
      r1: isle.querySelector('.r1'),
      r2: isle.querySelector('.r2'),
      r3: isle.querySelector('.r3')
    };
    state.mounted = true;
    isle.addEventListener('click', function (e) {
      e.stopPropagation();
      if (state.popOpen) closePopover(); else openPopover();
    });
    isle.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      else if (e.key === 'Escape') closePopover();
    });
    document.addEventListener('click', function (e) {
      if (!state.popOpen) return;
      if (pop.contains(e.target) || isle.contains(e.target)) return;
      closePopover();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.popOpen) closePopover(); });
    isle.addEventListener('pointerenter', function () { state.hover = true; if (state.cfg.pauseHover) clearTimeout(state.timer); });
    isle.addEventListener('pointerleave', function () { state.hover = false; scheduleNext(); });
    isle.addEventListener('focus', function () { state.focus = true; if (state.cfg.pauseHover) clearTimeout(state.timer); });
    isle.addEventListener('blur', function () { state.focus = false; scheduleNext(); });
    pop.addEventListener('click', function (e) {
      var row = e.target.closest('[data-isle-id]');
      if (row) { select(row.dataset.isleId); closePopover(); return; }
      var act = e.target.closest('[data-isle-act]');
      if (!act) return;
      var a = act.dataset.isleAct;
      if (a === 'prev') prev();
      else if (a === 'next') next();
      else if (a === 'pause') { state.paused = !state.paused; if (state.paused) clearTimeout(state.timer); else scheduleNext(); renderPopover(); placePopover(); }
      else if (a === 'settings') { closePopover(); document.dispatchEvent(new CustomEvent('hud:open-settings')); }
    });
    window.addEventListener('resize', function () { measure(); if (state.popOpen) placePopover(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { clearTimeout(state.timer); flushSave(); }
      else scheduleNext();
    });
    window.addEventListener('pagehide', flushSave);
    var themeObs = new MutationObserver(function () { applyLook(); });
    try { themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); } catch (e) { /* 旧环境 */ }
    applyLook(true);
    measure(true);
    renderItem(state.activeId);
    var bootGate = window.__bootGate;
    function beginHud() {
      if (isReduced()) scheduleNext(); else playEntrance();
    }
    /* 开屏期间只渲染静态内容；入场与 7 秒轮播等整层隐藏后再开始，别和格栅抢帧。 */
    if (bootGate && bootGate.on && !bootGate.done && typeof bootGate.whenDone === 'function') {
      bootGate.whenDone(beginHud);
    } else {
      beginHud();
    }
  }

  function prev() { nav(-1); }
  function next() { nav(1); }
  function nav(dir) {
    var list = enabledList();
    if (!list.length) return;
    var i = list.indexOf(state.activeId);
    switchTo(list[(i + dir + list.length) % list.length]);
  }
  function select(id) {
    if (!isItem(id)) return;
    if (state.cfg.enabled.indexOf(id) < 0) {
      state.cfg.enabled = state.cfg.enabled.concat([id]);
      saveNow(true);
    }
    switchTo(id);
  }

  function applySet(patch) {
    if (!patch || typeof patch !== 'object') return;
    var c = state.cfg;
    var beforeActive = state.activeId;
    var listChanged = Array.isArray(patch.enabled) || Array.isArray(patch.order);
    var measureNeeded = Number.isFinite(Number(patch.width)) || Number.isFinite(Number(patch.height));
    var tokensNeeded = measureNeeded
      || Number.isFinite(Number(patch.contentScale)) || Number.isFinite(Number(patch.typeScale))
      || Number.isFinite(Number(patch.haloScale)) || (patch.ratios && typeof patch.ratios === 'object');
    var lookNeeded = !!patch.material || !!patch.accent || !!patch.font;
    var detailNeeded = !!patch.detail;
    var timingNeeded = Number.isFinite(Number(patch.interval)) || Number.isFinite(Number(patch.speed))
      || !!patch.switchMode || typeof patch.pauseHover === 'boolean' || typeof patch.reduced === 'boolean';
    if (Array.isArray(patch.enabled)) c.enabled = patch.enabled.filter(isItem);
    if (Array.isArray(patch.order)) {
      c.order = patch.order.filter(isItem);
      ALL.forEach(function (id) { if (c.order.indexOf(id) < 0) c.order.push(id); });
    }
    if (Number.isFinite(Number(patch.width))) c.width = clamp(Number(patch.width), 200, 640);
    if (Number.isFinite(Number(patch.height))) c.height = clamp(Number(patch.height), 28, 48);
    if (Number.isFinite(Number(patch.interval))) c.interval = clamp(Number(patch.interval), 2000, 15000);
    if (Number.isFinite(Number(patch.speed))) c.speed = clamp(Number(patch.speed), .5, 2);
    if (Number.isFinite(Number(patch.contentScale))) c.contentScale = clamp(Number(patch.contentScale), .8, 1.2);
    if (Number.isFinite(Number(patch.typeScale))) c.typeScale = clamp(Number(patch.typeScale), .85, 1.15);
    if (patch.material) c.material = patch.material === 'hud' ? 'black' : enumOf(patch.material, ['auto', 'glass', 'white', 'black'], c.material);
    if (patch.accent) c.accent = enumOf(patch.accent, ['theme', 'cyan', 'orange', 'purple'], c.accent);
    if (patch.font) c.font = enumOf(patch.font, ['sans', 'serif'], c.font);
    if (patch.switchMode) c.switchMode = enumOf(patch.switchMode, ['full', 'handoff', 'quick'], c.switchMode);
    if (patch.detail) c.detail = enumOf(patch.detail, ['auto', 'full', 'compact', 'minimal'], c.detail);
    if (typeof patch.pauseHover === 'boolean') c.pauseHover = patch.pauseHover;
    if (typeof patch.reduced === 'boolean') c.reduced = patch.reduced;
    ['rewindMs', 'seedMs', 'slide1Ms', 'titleHoldMs', 'slide2Ms', 'dataInMs', 'radiusLead'].forEach(function (k) {
      if (Number.isFinite(Number(patch[k]))) c[k] = clamp(Number(patch[k]), k === 'radiusLead' ? -80 : -300, k === 'radiusLead' ? 80 : 300);
    });
    if (Number.isFinite(Number(patch.haloStrength))) c.haloStrength = clamp(Number(patch.haloStrength), 0, .6);
    if (Number.isFinite(Number(patch.haloScale))) c.haloScale = clamp(Number(patch.haloScale), .8, 1.3);
    if (Number.isFinite(Number(patch.haloLayers))) c.haloLayers = clamp(Math.round(Number(patch.haloLayers)), 1, 3);
    if (patch.ratios && typeof patch.ratios === 'object') {
      Object.keys(BASE_RATIOS).forEach(function (k) {
        if (Number.isFinite(Number(patch.ratios[k]))) c.ratios[k] = clamp(Number(patch.ratios[k]), .1, 1);
      });
    }
    if (c.enabled.indexOf(state.activeId) < 0) state.activeId = c.enabled[0] || c.order[0] || 'usage';
    queueSave();
    if (lookNeeded) applyLook(true);
    if (measureNeeded) measure(true);
    else if (tokensNeeded) applyTokens(true);
    if (detailNeeded && !measureNeeded) applyDetail(true);
    if (listChanged) {
      if (beforeActive !== state.activeId || !state.anims.length || state.frozen) renderItem(state.activeId);
      if (state.popOpen) renderPopover();
    }
    if (timingNeeded) {
      if (c.reduced) { cancelAnims(); renderItem(state.activeId); clearTimeout(state.timer); }
      else scheduleNext();
    }
  }

  window.Island = {
    mount: mount,
    update: function (data, meta) {
      state.data = data || null;
      state.online = !!(meta && meta.online);
      if (!state.mounted) mount();
      if (!state.mounted) return;
      measure();
      if (!state.anims.length && !state.switching) renderItem(state.activeId, { wheelMode: 'roll' });
      else {
        state.primaryPendingData = true;
        if (state.popOpen) renderPopover();
      }
    },
    cfg: function () { return JSON.parse(JSON.stringify(state.cfg)); },
    items: function () {
      return state.cfg.order.map(function (id) {
        return { id: id, title: (ITEM[id] || {}).title || id, tag: (ITEM[id] || {}).tag || '' };
      });
    },
    set: function (patch) { applySet(patch); },
    setItem: function (id, on) {
      if (!isItem(id)) return;
      var has = state.cfg.enabled.indexOf(id) >= 0;
      if (on && !has) state.cfg.enabled = state.cfg.enabled.concat([id]);
      if (!on && has) state.cfg.enabled = state.cfg.enabled.filter(function (x) { return x !== id; });
      if (state.cfg.enabled.indexOf(state.activeId) < 0) state.activeId = state.cfg.enabled[0] || state.cfg.order[0] || id;
      saveNow();
      renderItem(state.activeId);
      scheduleNext();
    },
    setAll: function (on) {
      state.cfg.enabled = on ? ALL.slice() : [];
      if (state.cfg.enabled.indexOf(state.activeId) < 0) state.activeId = state.cfg.enabled[0] || state.cfg.order[0] || 'usage';
      saveNow();
      renderItem(state.activeId);
      scheduleNext();
    },
    setDefault: function () {
      cancelAnims();
      state.cfg = JSON.parse(JSON.stringify(DEFAULTS));
      state.activeId = state.cfg.enabled[0];
      state.paused = false;
      state.timelineMs = 1500;
      state.seekMs = 0;
      state.popSig = '';
      saveNow();
      applyLook(true);
      measure(true);
      renderItem(state.activeId);
      scheduleNext();
    },
    moveItem: function (id, dir) {
      var i = state.cfg.order.indexOf(id);
      var j2 = i + (Number(dir) || 0);
      if (i < 0 || j2 < 0 || j2 >= state.cfg.order.length) return;
      var order = state.cfg.order.slice();
      var tmp = order[i]; order[i] = order[j2]; order[j2] = tmp;
      state.cfg.order = order;
      saveNow(true);
      if (state.popOpen) renderPopover();
    },
    replayEntrance: function () { freeze(false); playEntrance(); },
    replaySwitch: function () { freeze(false); playSwitch(state.activeId); },
    replayBirth: function () { freeze(false); playSwitch(state.activeId, { birth: true }); },
    next: function () { next(); },
    freeze: function (on) { freeze(!!on); },
    seek: function (ms) { seek(ms); },
    resetConfig: function () { window.Island.setDefault(); },
    exportConfig: function () { return JSON.parse(JSON.stringify(state.cfg)); },
    debug: function () {
      return {
        activeId: state.activeId,
        activeTitle: (ITEM[state.activeId] || {}).title || '',
        order: state.cfg.order.map(function (id) { return (ITEM[id] || {}).title || id; }),
        rotation: enabledList().map(function (id) { return (ITEM[id] || {}).title || id; }),
        timelineMs: state.timelineMs,
        seekMs: state.seekMs,
        mode: state.switchKind,
        titleShift: state.lock ? state.lock.shift : null,
        lockWidth: state.lock ? state.lock.w : null,
        frozen: state.frozen,
        anims: state.anims.length,
        density: state.density,
        width: state.widthActual,
        reduced: isReduced()
      };
    },
    open: openPopover,
    close: closePopover
  };

  function freeze(on) {
    state.frozen = !!on;
    if (on) {
      clearTimeout(state.settleTimer);
      state.anims.forEach(function (a) { try { a.pause(); } catch (e) { /* 已结束 */ } });
      renderItem(state.activeId);
    } else {
      state.anims.forEach(function (a) { try { a.play(); } catch (e) { /* 已结束 */ } });
      if (state.anims.length) settleAnims(state.anims, 450, state.timelineMs);
      scheduleNext();
    }
  }
  function seek(ms) {
    if (!state.anims.length) playSwitch(state.activeId);
    if (!state.anims.length) return;
    if (!state.frozen) freeze(true);
    var v = clamp(Number(ms) || 0, 0, state.timelineMs);
    state.seekMs = v;
    state.anims.forEach(function (a) { try { a.currentTime = v / state.cfg.speed; } catch (e) { /* 已结束 */ } });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
