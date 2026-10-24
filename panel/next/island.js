/* HUD 信息岛 · 顶栏状态岛（原生 JS，零构建）。
   玻璃材质随主题自动切换，无 HUD 核材质；灰圈只在切换中且被岛体圆角裁切。 */
(function () {
  'use strict';

  var KEY = 'next-hud-island-v1';
  var HOST_ID = 'tbPills';
  var RATIOS = { plate: .64, glyph: .41, pad: .40, gap: .22, ring: .76, ringGlyph: .34, primary: .46, secondary: .30, right: .42, title: .44, tag: .18 };
  var DEFAULTS = {
    enabled: ['usage', 'bridge', 'memory'],
    interval: 7000,
    width: 360,
    height: 38,
    speed: 1
  };
  var ALL = ['usage', 'bridge', 'container', 'model', 'memory', 'panel', 'account'];

  var state = {
    mounted: false,
    cfg: readCfg(),
    data: null,
    online: false,
    activeId: DEFAULTS.enabled[0],
    anims: [],
    switching: false,
    switchStart: 0,
    switchKind: '',
    timelineMs: 1200,
    seekMs: 0,
    timer: 0,
    settleTimer: 0,
    seedTimer: 0,
    queued: null,
    paused: false,
    hover: false,
    focus: false,
    popOpen: false,
    popAnim: null,
    reduced: false,
    isle: null, host: null, els: {}
  };

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDur(ms) {
    var s = Math.max(0, Math.round(Number(ms || 0) / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + 'h ' + pad2(m) + 'm';
    if (m > 0) return m + 'm ' + pad2(s % 60) + 's';
    return s + 's';
  }
  function readCfg() {
    var out = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (raw && typeof raw === 'object') {
        if (Array.isArray(raw.enabled)) out.enabled = raw.enabled.filter(function (id) { return ALL.indexOf(id) >= 0; });
        ['interval', 'width', 'height', 'speed'].forEach(function (k) { if (Number.isFinite(Number(raw[k]))) out[k] = Number(raw[k]); });
      }
    } catch (e) { /* 隐私模式 / 坏 JSON 时用默认 */ }
    out.enabled = out.enabled.length ? out.enabled : DEFAULTS.enabled.slice();
    return out;
  }
  function saveCfg() {
    try { localStorage.setItem(KEY, JSON.stringify(state.cfg)); } catch (e) { /* 忽略 */ }
    try { if (window.__nextHudToast) window.__nextHudToast('HUD 设置已保存（本机）'); } catch (e) { /* 忽略 */ }
  }
  function j(o, path, dflt) {
    var cur = o;
    for (var i = 0; i < path.length; i++) { if (cur == null) return dflt; cur = cur[path[i]]; }
    return cur == null ? dflt : cur;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function icon(name, size) {
    try { return window.Icons && Icons.icon(name, { size: size || 15 }); } catch (e) { return ''; }
  }

  /* ── 数据项：全部来自真实 /api/state；没有发送计数字段，故不设「今日发送」 ── */
  function valueOfItem(id) {
    var s = state.data;
    var online = state.online && !!s;
    if (id === 'usage') {
      var t = j(s, ['usage', 'today'], null);
      var cost = t ? Number(t.cost || 0) : 0;
      var calls = t ? Number(t.calls || 0) : 0;
      return { tag: 'USAGE', title: '今日用量', icon: 'coin', primary: '¥' + cost.toFixed(2), secondary: calls + ' 次', right: '', ratio: null, tone: online ? 'ok' : 'off' };
    }
    if (id === 'bridge') {
      var run = !!j(s, ['bridge', 'running'], false);
      var up = j(s, ['bridge', 'uptimeMs'], 0);
      return { tag: 'RUNTIME', title: '机器人', icon: 'bot', primary: run ? fmtDur(up) : '没在跑', secondary: run ? '运行中' : '已停止', right: '', ratio: run ? clamp(up / 86400000, 0, 1) : 0, tone: run ? 'ok' : 'off' };
    }
    if (id === 'container') {
      var c = j(s, ['container'], null);
      var applicable = c ? c.applicable !== false : true;
      var logged = !!j(c, ['loggedIn'], false);
      var prim = !applicable ? '原生' : (logged ? '已登录' : (c && c.running ? '未登录' : '未启动'));
      return { tag: 'CONTAINER', title: '协议端', icon: 'container', primary: prim, secondary: applicable ? 'NapCat 容器' : '原生 NapCat', right: '', ratio: logged ? 1 : 0, tone: logged || !applicable ? 'ok' : 'warn' };
    }
    if (id === 'model') {
      var lm = j(s, ['localModel', 'running'], false);
      return { tag: 'LOCAL', title: '本机模型', icon: 'monitor', primary: lm ? '在跑' : '没跑', secondary: lm ? '本机推理' : '未占用', right: '', ratio: lm ? 1 : 0, tone: lm ? 'ok' : 'off' };
    }
    if (id === 'memory') {
      var p = j(s, ['memory', 'pressure'], null);
      return { tag: 'MEMORY', title: '内存', icon: 'memory', primary: p == null ? '—' : p + '%', secondary: p == null ? '暂不支持' : '占用', right: '', ratio: p == null ? 0 : clamp(p / 100, 0, 1), tone: p == null ? 'off' : (p >= 90 ? 'bad' : p >= 75 ? 'warn' : 'ok') };
    }
    if (id === 'panel') {
      var connected = online;
      var stale = !!j(s, ['panel', 'stale'], false);
      return { tag: 'PANEL', title: '面板', icon: 'link', primary: connected ? (stale ? '旧代码' : '已连接') : '未连接', secondary: connected ? 'pid ' + j(s, ['panel', 'pid'], '—') : '演示模式', right: '', ratio: connected ? (stale ? .2 : 1) : 0, tone: !connected ? 'warn' : (stale ? 'warn' : 'ok') };
    }
    var nick = j(s, ['account', 'nickname'], '');
    return { tag: 'ACCOUNT', title: '账号', icon: 'user', primary: nick || '未登录', secondary: nick ? '在线' : '—', right: '', ratio: nick ? 1 : 0, tone: nick ? 'ok' : 'off' };
  }

  /* ── 几何 ── */
  function tokens() {
    var h = state.cfg.height, w = state.widthActual || state.cfg.width;
    var plate = h * RATIOS.plate * .92;
    var plateFinal = plate * .714;
    var pad = h * RATIOS.pad;
    var gap = h * RATIOS.gap;
    var dataInset = pad + plateFinal + gap;
    return {
      h: h, w: w, plate: plate, plateFinal: plateFinal, pad: pad, gap: gap, dataInset: dataInset,
      ring: h * RATIOS.ring, ringGlyph: h * RATIOS.ringGlyph,
      iconC: pad + plateFinal / 2 - w / 2,
      iconB: (pad + plateFinal / 2 - w / 2) * (179 / 245)
    };
  }
  function applyTokens() {
    if (!state.isle) return;
    var t = tokens();
    state.t = t;
    var st = state.isle.style;
    st.setProperty('--isle-w', state.widthActual + 'px');
    st.setProperty('--isle-h', t.h + 'px');
    st.setProperty('--isle-plate', t.plate + 'px');
    st.setProperty('--isle-glyph', (t.h * RATIOS.glyph).toFixed(1) + 'px');
    st.setProperty('--isle-data-inset', t.dataInset.toFixed(1) + 'px');
    st.setProperty('--isle-gap', (t.h * RATIOS.gap).toFixed(1) + 'px');
    st.setProperty('--isle-ring', t.ring.toFixed(1) + 'px');
    st.setProperty('--isle-ring-glyph', t.ringGlyph.toFixed(1) + 'px');
    st.setProperty('--icon-final', (state.density === 'icon' ? 0 : t.iconC).toFixed(1) + 'px');
  }

  function renderItem(id, opts) {
    var o = opts || {};
    id = ALL.indexOf(id) >= 0 ? id : state.cfg.enabled[0];
    var v = valueOfItem(id);
    state.activeId = id;
    var e = state.els;
    if (!e.name) return;
    e.isle.dataset.tone = v.tone;
    e.name.textContent = v.title;
    e.tag.textContent = v.tag;
    e.primary.textContent = v.primary;
    e.secondary.textContent = v.secondary || '';
    e.right.textContent = v.right || '';
    e.ringGlyph.innerHTML = icon(v.icon, 12) || '';
    e.ringWrap.style.display = v.ratio == null ? 'none' : '';
    var C = 2 * Math.PI * 15.5;
    e.ringArc.style.strokeDasharray = String(C);
    e.ringArc.style.strokeDashoffset = String(C * (1 - clamp(Number(v.ratio) || 0, 0, 1)));
    if (!o.noGlyph) e.glyph.innerHTML = icon(v.icon, 16) || '';
    if (state.popOpen) renderPopover();
  }

  /* ── 时间轴 ── */
  function cancelAnims() {
    state.anims.forEach(function (a) { try { a.cancel(); } catch (e) { /* 已结束 */ } });
    state.anims = [];
    state.switching = false;
    clearTimeout(state.settleTimer);
    clearTimeout(state.seedTimer);
  }
  function anim(el, frames, duration, opts) {
    return el.animate(frames, Object.assign({ duration: duration, fill: 'both' }, opts || {}));
  }
  function iconFrame(x) { return 'translate(-50%, -50%) translateX(' + x.toFixed(1) + 'px)'; }
  function hostFrame(x, y) { return 'translateX(' + x.toFixed(1) + 'px) translateY(' + (y || 0) + 'px)'; }

  function playEntrance() {
    if (!state.mounted || !state.isle) return;
    cancelAnims();
    state.reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (state.reduced) { renderItem(state.activeId); return; }
    var W = state.widthActual, H = state.cfg.height;
    var t = tokens();
    state.switchKind = 'entrance';
    state.timelineMs = 1200;
    state.seekMs = 0;
    var D = 1200 / state.cfg.speed;
    var o = function (ms) { return clamp(ms, 0, 1200) / 1200; };
    var wide = W >= 260;
    var anims = [];
    var add = function (a) { if (a) anims.push(a); };
    var e = state.els;

    add(anim(state.isle, [
      { offset: 0, width: Math.max(12, H) + 'px' },
      { offset: o(200), width: Math.max(12, H) + 'px', easing: 'cubic-bezier(.22,1,.36,1)' },
      { offset: o(wide ? 780 : 340), width: W + 'px' },
      { offset: 1, width: W + 'px' }
    ], D));
    add(anim(state.isle, [
      { offset: 0, opacity: 0, transform: 'scale(.9)' },
      { offset: o(220), opacity: 1, transform: 'scale(1)', easing: 'cubic-bezier(.34,1.56,.64,1)' },
      { offset: o(wide ? 1020 : 460), opacity: 1, transform: 'scale(1.006)', easing: 'cubic-bezier(.22,1,.36,1)' },
      { offset: o(wide ? 1160 : 560), opacity: 1, transform: 'scale(1)' },
      { offset: 1, opacity: 1, transform: 'scale(1)' }
    ], D));
    if (wide) {
      add(anim(e.welcome, [
        { offset: 0, opacity: 0, clipPath: 'inset(0 100% 0 0)' },
        { offset: o(300), opacity: 0, clipPath: 'inset(0 100% 0 0)', easing: 'cubic-bezier(.4,0,.2,1)' },
        { offset: o(520), opacity: 1, clipPath: 'inset(0 0 0 0)' },
        { offset: o(800), opacity: 1, clipPath: 'inset(0 0 0 0)', easing: 'cubic-bezier(.4,0,.2,1)' },
        { offset: o(980), opacity: 1, clipPath: 'inset(0 0 0 100%)' },
        { offset: 1, opacity: 1, clipPath: 'inset(0 0 0 100%)' }
      ], D));
      add(anim(e.data, [
        { offset: 0, opacity: 0, clipPath: 'inset(0 100% 0 0)' },
        { offset: o(860), opacity: 0, clipPath: 'inset(0 100% 0 0)' },
        { offset: o(1080), opacity: 1, clipPath: 'inset(0 0 0 0)' },
        { offset: 1, opacity: 1, clipPath: 'inset(0 0 0 0)' }
      ], D));
      add(anim(e.plate, [
        { offset: 0, opacity: 0, transform: 'scale(.4)', borderRadius: '50%' },
        { offset: o(840), opacity: 0, transform: 'scale(.4)', borderRadius: '50%', easing: 'cubic-bezier(.4,0,.2,1)' },
        { offset: o(1020), opacity: 1, transform: 'scale(.714)', borderRadius: '22%' },
        { offset: 1, opacity: 1, transform: 'scale(.714)', borderRadius: '22%' }
      ], D));
      add(anim(e.sweep, [
        { offset: 0, opacity: 0, transform: 'translateX(-140%) skewX(-14deg)' },
        { offset: o(860), opacity: 0, transform: 'translateX(-140%) skewX(-14deg)' },
        { offset: o(960), opacity: .8, transform: 'translateX(40%) skewX(-14deg)' },
        { offset: o(1140), opacity: 0, transform: 'translateX(240%) skewX(-14deg)' },
        { offset: 1, opacity: 0, transform: 'translateX(240%) skewX(-14deg)' }
      ], D));
    } else {
      add(anim(e.data, [
        { offset: 0, opacity: 0 }, { offset: o(200), opacity: 0 }, { offset: o(420), opacity: 1 }, { offset: 1, opacity: 1 }
      ], D));
      add(anim(e.plate, [
        { offset: 0, opacity: 0, transform: 'scale(.4)' },
        { offset: o(160), opacity: 0, transform: 'scale(.4)' },
        { offset: o(360), opacity: 1, transform: 'scale(.714)' },
        { offset: 1, opacity: 1, transform: 'scale(.714)' }
      ], D));
    }
    state.anims = anims;
    settleAnims(anims, D + 100, 1200);
    renderItem(state.activeId);
    scheduleNext();
  }

  function playSwitch(id) {
    if (!state.mounted) return;
    state.reduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (state.reduced) { cancelAnims(); renderItem(id); scheduleNext(); return; }
    if (state.switching && performance.now() - state.switchStart < 200) { state.queued = id; return; }
    cancelAnims();
    var t = tokens();
    var r = state.els;
    var total = 1040, D = total / state.cfg.speed;
    var o = function (ms) { return clamp(ms, 0, total) / total; };
    var C = t.iconC, B = t.iconB;
    var anims = [];
    var add = function (a) { if (a) anims.push(a); };
    state.switching = true;
    state.switchStart = performance.now();
    state.switchKind = 'switch';
    state.timelineMs = total;
    state.activeId = id;

    add(anim(r.data, [
      { offset: 0, opacity: 1, transform: 'translateY(0)' },
      { offset: o(120), opacity: 0, transform: 'translateY(4px)' },
      { offset: o(820), opacity: 0, transform: 'translateY(4px)' },
      { offset: o(1000), opacity: 1, transform: 'translateY(0)' },
      { offset: 1, opacity: 1, transform: 'translateY(0)' }
    ], D));
    add(anim(r.title, [
      { offset: 0, opacity: 0, transform: 'translateY(6px)' },
      { offset: o(320), opacity: 0, transform: 'translateY(6px)', easing: 'cubic-bezier(.4,0,.2,1)' },
      { offset: o(440), opacity: 1, transform: 'translateY(0)' },
      { offset: o(760), opacity: 1, transform: 'translateY(0)', easing: 'cubic-bezier(.4,0,.2,1)' },
      { offset: o(860), opacity: 0, transform: 'translateY(-3px)' },
      { offset: 1, opacity: 0, transform: 'translateY(-3px)' }
    ], D));
    add(anim(state.isle, [
      { offset: 0, borderRadius: state.cfg.height / 2 + 'px' },
      { offset: o(60), borderRadius: state.cfg.height / 2 + 'px', easing: 'cubic-bezier(.22,1,.36,1)' },
      { offset: o(300), borderRadius: state.cfg.height * .36 + 'px' },
      { offset: o(900), borderRadius: state.cfg.height * .36 + 'px', easing: 'cubic-bezier(.22,1,.36,1)' },
      { offset: o(1020), borderRadius: state.cfg.height / 2 + 'px' },
      { offset: 1, borderRadius: state.cfg.height / 2 + 'px' }
    ], D));
    add(anim(r.plate, [
      { offset: 0, transform: 'scale(.714)', borderRadius: '22%' },
      { offset: o(80), transform: 'scale(.714)', borderRadius: '22%' },
      { offset: o(300), transform: 'scale(1)', borderRadius: '50%', easing: 'cubic-bezier(.22,1,.36,1)' },
      { offset: o(340), transform: 'scale(1.08)', borderRadius: '50%' },
      { offset: o(380), transform: 'scale(1)', borderRadius: '50%' },
      { offset: o(860), transform: 'scale(1)', borderRadius: '50%' },
      { offset: o(1000), transform: 'scale(.714)', borderRadius: '22%' },
      { offset: 1, transform: 'scale(.714)', borderRadius: '22%' }
    ], D));
    add(anim(r.icon, [
      { offset: 0, transform: iconFrame(C) },
      { offset: o(120), transform: iconFrame(C), easing: 'cubic-bezier(.22,1,.36,1)' },
      { offset: o(300), transform: iconFrame(0) },
      { offset: o(380), transform: iconFrame(0) },
      { offset: o(620), transform: iconFrame(B) },
      { offset: o(820), transform: iconFrame(B), easing: 'cubic-bezier(.22,1,.36,1)' },
      { offset: o(1020), transform: iconFrame(C) },
      { offset: 1, transform: iconFrame(C) }
    ], D));
    add(anim(r.host, [
      { offset: 0, transform: hostFrame(C, 10) },
      { offset: o(120), transform: hostFrame(C, 0), easing: 'cubic-bezier(.22,1,.36,1)' },
      { offset: o(300), transform: hostFrame(0, 0) },
      { offset: o(380), transform: hostFrame(0, 0) },
      { offset: o(620), transform: hostFrame(B, 0) },
      { offset: o(820), transform: hostFrame(B, 0), easing: 'cubic-bezier(.22,1,.36,1)' },
      { offset: o(1020), transform: hostFrame(C, 0) },
      { offset: 1, transform: hostFrame(C, 0) }
    ], D));
    add(halo(r.r1, [60, 160, 380, 520], 1.05, .42, D, total));
    add(halo(r.r2, [80, 180, 400, 540], 1.18, .34, D, total));
    add(halo(r.r3, [100, 200, 420, 560], 1.30, .28, D, total));

    state.seedTimer = setTimeout(function () { renderItem(id); }, 300 / state.cfg.speed);
    state.anims = anims;
    settleAnims(anims, D + 80, total);
    scheduleNext();
  }

  function halo(el, times, target, peak, D, total) {
    var o = function (ms) { return clamp(ms, 0, total) / total; };
    return anim(el, [
      { offset: 0, opacity: 0, transform: 'translate(-50%, -50%) scale(0)' },
      { offset: o(times[0]), opacity: 0, transform: 'translate(-50%, -50%) scale(0)' },
      { offset: o(times[1]), opacity: peak, transform: 'translate(-50%, -50%) scale(.06)', easing: 'cubic-bezier(.25,.8,.35,1)' },
      { offset: o(times[2]), opacity: peak, transform: 'translate(-50%, -50%) scale(' + (target * .82) + ')' },
      { offset: o(times[3]), opacity: 0, transform: 'translate(-50%, -50%) scale(' + target + ')' },
      { offset: 1, opacity: 0, transform: 'translate(-50%, -50%) scale(' + target + ')' }
    ], D);
  }

  function settleAnims(anims, ms, finalSeek) {
    clearTimeout(state.settleTimer);
    state.settleTimer = setTimeout(function () {
      if (state.anims !== anims) return;
      anims.forEach(function (a) { try { a.cancel(); } catch (e) { /* 已结束 */ } });
      state.anims = [];
      state.switching = false;
      state.seekMs = finalSeek;
      if (state.queued) { var q = state.queued; state.queued = null; playSwitch(q); }
    }, ms);
  }

  function isPaused() {
    return state.paused || state.hover || state.focus || document.hidden || state.reduced;
  }
  function scheduleNext() {
    clearTimeout(state.timer);
    if (isPaused()) return;
    var list = state.cfg.enabled;
    if (list.length < 2) return;
    state.timer = setTimeout(function () {
      if (isPaused()) return;
      var i = list.indexOf(state.activeId);
      switchTo(list[(i + 1 + list.length) % list.length]);
    }, Math.max(1500, state.cfg.interval));
  }
  function switchTo(id) {
    if (!state.mounted) return;
    if (state.anims.length || state.switching) { playSwitch(id); return; }
    playSwitch(id);
  }

  /* ── 弹层 ── */
  function renderPopover() {
    var pop = state.els.pop;
    if (!pop) return;
    var rows = ALL.map(function (id) {
      var v = valueOfItem(id);
      var on = state.cfg.enabled.indexOf(id) >= 0;
      return '<button class="isle-pop-row' + (id === state.activeId ? ' on' : '') + '" type="button" data-isle-id="' + id + '">'
        + '<span class="isle-pop-ico">' + icon(v.icon, 14) + '</span>'
        + '<span class="isle-pop-name"><b>' + esc(v.title) + '</b><i>' + esc(on ? v.tag : '未启用') + '</i></span>'
        + '<span class="isle-pop-val">' + esc(v.primary) + (v.secondary ? ' <i>' + esc(v.secondary) + '</i>' : '') + '</span>'
        + '<span class="isle-pop-dot ' + esc(v.tone) + '"></span></button>';
    }).join('');
    pop.innerHTML = '<div class="isle-pop-head"><b>状态岛</b><span>' + state.cfg.enabled.length + ' 项轮播</span></div>'
      + '<div class="isle-pop-list">' + rows + '</div>'
      + '<div class="isle-pop-foot">'
      + '<button type="button" data-isle-act="prev">上一条</button>'
      + '<button type="button" data-isle-act="pause">' + (state.paused ? '继续轮播' : '暂停轮播') + '</button>'
      + '<button type="button" data-isle-act="next">下一条</button>'
      + '<button type="button" data-isle-act="settings" class="primary">HUD 调整</button>'
      + '</div>';
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
    if (state.reduced || !pop.animate) return;
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
    if (state.reduced || !pop.animate) { pop.hidden = true; return; }
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

  /* ── 尺寸与挂载 ── */
  function measure() {
    var host = state.host;
    if (!host) return;
    var top = host.closest('.topbar');
    if (!top) { state.widthActual = state.cfg.width; state.density = 'full'; applyTokens(); return; }
    var brand = top.querySelector('.tb-brand');
    var acts = top.querySelector('.tb-actions');
    var br = brand ? brand.getBoundingClientRect().right : 0;
    var al = acts ? acts.getBoundingClientRect().left : window.innerWidth;
    var gap = al - br - 32;
    var want = Math.min(state.cfg.width, Math.max(0, gap));
    var density = want >= 300 ? 'full' : (want >= 160 ? 'icon' : 'hidden');
    state.widthActual = density === 'hidden' ? 0 : Math.round(want);
    state.density = density;
    state.isle.hidden = density === 'hidden';
    state.isle.classList.toggle('compact', density === 'icon');
    applyTokens();
  }

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
      + '  <span class="isle-title" aria-hidden="true"><i class="tag"></i><b class="name"></b></span>'
      + '  <span class="isle-icon" aria-hidden="true"><span class="plate"><span class="glyph"></span></span></span>'
      + '  <span class="isle-data" aria-hidden="true">'
      + '    <span class="primary"><b></b><i></i></span><span class="grow"></span>'
      + '    <span class="right"><b></b></span>'
      + '    <span class="ring"><svg viewBox="0 0 36 36" aria-hidden="true"><circle class="ring-track" cx="18" cy="18" r="15.5"></circle><circle class="ring-arc" cx="18" cy="18" r="15.5"></circle></svg><span class="ring-glyph"></span></span>'
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
      isle: isle, pop: pop,
      welcome: isle.querySelector('.isle-welcome'), sweep: isle.querySelector('.isle-sweep'),
      title: isle.querySelector('.isle-title'), tag: isle.querySelector('.isle-title .tag'), name: isle.querySelector('.isle-title .name'),
      icon: isle.querySelector('.isle-icon'), plate: isle.querySelector('.plate'), glyph: isle.querySelector('.glyph'),
      data: isle.querySelector('.isle-data'), primary: isle.querySelector('.primary b'), secondary: isle.querySelector('.primary i'),
      right: isle.querySelector('.right b'), ringWrap: isle.querySelector('.ring'), ringArc: isle.querySelector('.ring-arc'), ringGlyph: isle.querySelector('.ring-glyph'),
      host: isle.querySelector('.isle-ripple-host'), r1: isle.querySelector('.r1'), r2: isle.querySelector('.r2'), r3: isle.querySelector('.r3')
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
    isle.addEventListener('pointerenter', function () { state.hover = true; clearTimeout(state.timer); });
    isle.addEventListener('pointerleave', function () { state.hover = false; scheduleNext(); });
    isle.addEventListener('focus', function () { state.focus = true; clearTimeout(state.timer); });
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
    document.addEventListener('visibilitychange', function () { if (document.hidden) clearTimeout(state.timer); else scheduleNext(); });
    state.reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    measure();
    renderItem(state.cfg.enabled[0]);
    if (state.reduced) renderItem(state.activeId); else playEntrance();
  }

  function prev() { nav(-1); }
  function next() { nav(1); }
  function nav(dir) {
    var list = state.cfg.enabled;
    if (!list.length) return;
    var i = list.indexOf(state.activeId);
    switchTo(list[(i + dir + list.length) % list.length]);
  }
  function select(id) {
    if (state.cfg.enabled.indexOf(id) >= 0) { switchTo(id); return; }
    state.cfg.enabled = state.cfg.enabled.concat([id]);
    saveCfg();
    switchTo(id);
  }

  window.Island = {
    mount: mount,
    update: function (data, meta) {
      state.data = data || null;
      state.online = !!(meta && meta.online);
      if (!state.mounted) mount();
      if (!state.mounted) return;
      measure();
      if (!state.anims.length && !state.switching) renderItem(state.activeId);
      else if (state.popOpen) renderPopover();
    },
    cfg: function () { return JSON.parse(JSON.stringify(state.cfg)); },
    set: function (patch) {
      if (patch && typeof patch === 'object') {
        if (Number.isFinite(Number(patch.width))) state.cfg.width = clamp(Number(patch.width), 200, 640);
        if (Number.isFinite(Number(patch.height))) state.cfg.height = clamp(Number(patch.height), 28, 48);
        if (Number.isFinite(Number(patch.interval))) state.cfg.interval = clamp(Number(patch.interval), 3000, 15000);
        if (Number.isFinite(Number(patch.speed))) state.cfg.speed = clamp(Number(patch.speed), .5, 2);
        if (Array.isArray(patch.enabled)) state.cfg.enabled = patch.enabled.filter(function (id) { return ALL.indexOf(id) >= 0; });
      }
      state.cfg.enabled = state.cfg.enabled.length ? state.cfg.enabled : DEFAULTS.enabled.slice();
      if (state.cfg.enabled.indexOf(state.activeId) < 0) state.activeId = state.cfg.enabled[0];
      saveCfg(); measure(); renderItem(state.activeId); scheduleNext();
    },
    setItem: function (id, on) {
      if (ALL.indexOf(id) < 0) return;
      var has = state.cfg.enabled.indexOf(id) >= 0;
      if (on && !has) state.cfg.enabled.push(id);
      if (!on && has && state.cfg.enabled.length > 1) state.cfg.enabled = state.cfg.enabled.filter(function (x) { return x !== id; });
      if (!state.cfg.enabled.length) state.cfg.enabled = [id];
      if (state.cfg.enabled.indexOf(state.activeId) < 0) state.activeId = state.cfg.enabled[0];
      saveCfg(); renderItem(state.activeId); scheduleNext();
    },
    replayEntrance: playEntrance,
    resetConfig: function () {
      state.cfg = JSON.parse(JSON.stringify(DEFAULTS));
      state.activeId = state.cfg.enabled[0];
      state.paused = false;
      saveCfg(); measure(); renderItem(state.activeId); scheduleNext();
    },
    open: openPopover,
    close: closePopover
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
