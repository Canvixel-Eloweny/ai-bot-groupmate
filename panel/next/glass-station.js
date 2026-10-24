/* ══════════════════════════════════════════════════════════════════════════
   Liquid Glass Lab · 交互、场景与导出
   ══════════════════════════════════════════════════════════════════════════
   · 模板 / 场景数据只在这里；CSS 只消费 --gs-* 变量
   · 真折射只走 window.EstrellaGlass（glass.js），本文件不复制贴图算法
   · 没有 fetch / 没有 ES module / 没有外部图片：file:// 可直接打开
   ══════════════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const EG = window.EstrellaGlass || null;
  const root = document.documentElement;
  const $ = (sel, scope = document) => scope.querySelector(sel);
  const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const DESIGN = { w: 900, h: 620 };
  const STORE_KEY = 'estrellaglass.lab.v2';

  /* ── 图标（全部内联 SVG，无外链）────────────────────────────────────── */
  const svg = (inner) => '<svg class="gs-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  const I = {
    play: svg('<path d="M8 5.4v13.2L19 12z" fill="currentColor" stroke="none"/>'),
    prev: svg('<path d="M18 6v12L9 12z" fill="currentColor" stroke="none"/><path d="M6 6v12"/>'),
    next: svg('<path d="M6 6v12l9-6z" fill="currentColor" stroke="none"/><path d="M18 6v12"/>'),
    home: svg('<path d="M4.5 10.5 12 4l7.5 6.5"/><path d="M6.5 9.5V20h11V9.5"/>'),
    grid: svg('<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>'),
    music: svg('<path d="M9 18V6l9-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="15.5" cy="16" r="2.5"/>'),
    book: svg('<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15H7.5A2.5 2.5 0 0 0 5 20.5z"/><path d="M5 20.5V5.5"/>'),
    settings: svg('<circle cx="12" cy="12" r="3.2"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4.4l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4.4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/>'),
    shield: svg('<path d="M12 3 5 6v6c0 4.2 2.8 7.2 7 9 4.2-1.8 7-4.8 7-9V6z"/><path d="m9.2 12.2 1.9 1.9 3.8-3.8"/>'),
    bell: svg('<path d="M6.5 17h11l-1.2-2V10a4.3 4.3 0 0 0-8.6 0v5z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>'),
    spark: svg('<path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z"/>'),
    cloud: svg('<path d="M7 18h9.5a3.5 3.5 0 0 0 .3-7A5.2 5.2 0 0 0 7 12.2 3 3 0 0 0 7 18z"/>'),
    wifi: svg('<path d="M4.5 9.5a11 11 0 0 1 15 0"/><path d="M7.5 13a7 7 0 0 1 9 0"/><circle cx="12" cy="17.5" r="1.2" fill="currentColor" stroke="none"/>'),
    bluetooth: svg('<path d="M9 5.5 15 10l-6 4.5V3l6 4.5L9 12"/><path d="M15 14l-6 4.5V16"/>'),
    moon: svg('<path d="M19.5 14.3A7.8 7.8 0 0 1 9.7 4.5a7.9 7.9 0 1 0 9.8 9.8z"/>'),
    search: svg('<circle cx="11" cy="11" r="6.3"/><path d="m16 16 4.2 4.2"/>'),
    send: svg('<path d="m4 4 16 8-16 8 3.2-8z"/><path d="M7.2 12H20"/>'),
    copy: svg('<rect x="8" y="8" width="11" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/>'),
    pin: svg('<path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 15v5"/>'),
    trash: svg('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>'),
    volume: svg('<path d="M4 10v4h4l5 4V6L8 10z"/><path d="M16.5 9.5a4 4 0 0 1 0 5"/><path d="M18.5 7.5a7 7 0 0 1 0 9"/>'),
    message: svg('<path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 3v-5.2A7.5 7.5 0 1 1 20 11.5z"/>'),
    lock: svg('<rect x="5" y="10" width="14" height="10" rx="2.5"/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10"/>'),
  };

  /* ── 16 个模板 ──────────────────────────────────────────────────────── */
  const TEMPLATES = [
    {
      id: 'pill', label: '状态胶囊', hint: '340×76 · r38', w: 340, h: 76, r: 38,
      html: '<div class="t-pill"><span class="t-live"></span><span class="t-pill-txt"><b>Estrella</b>'
        + '<small>在线 · 3 个群</small></span><span class="t-badge">运行中</span></div>',
    },
    {
      id: 'circle', label: '圆钮', hint: '112×112 · r56', w: 112, h: 112, r: 56,
      html: '<span class="t-circle">' + I.play + '</span>',
    },
    {
      id: 'dock', label: 'Dock', hint: '460×76 · r38', w: 460, h: 76, r: 38,
      html: '<div class="t-dock">'
        + '<span class="t-dock-i is-on">' + I.home + '<small>主页</small></span>'
        + '<span class="t-dock-i">' + I.grid + '<small>发现</small></span>'
        + '<span class="t-dock-i">' + I.music + '<small>电台</small></span>'
        + '<span class="t-dock-i">' + I.book + '<small>资料</small></span>'
        + '<span class="t-dock-i">' + I.settings + '<small>设置</small></span>'
        + '</div>',
    },
    {
      id: 'topbar', label: '顶栏', hint: '680×62 · r20', w: 680, h: 62, r: 20,
      html: '<div class="t-topbar"><div class="t-brand"><span class="t-brand-mark">E</span><b>Estrella</b></div>'
        + '<nav><span class="is-on">概览</span><span>会话</span><span>记忆</span><span>模型</span></nav>'
        + '<div class="t-top-actions"><span class="t-top-chip">' + I.shield + '安全</span><span class="t-avatar">C</span></div></div>',
    },
    {
      id: 'notify', label: '通知卡', hint: '420×118 · r24', w: 420, h: 118, r: 24,
      html: '<div class="t-notify"><span class="t-notify-ico">' + I.bell + '</span>'
        + '<div class="t-notify-body"><div class="t-notify-top"><b>勿扰模式已打开</b><span>现在</span></div>'
        + '<p>只保留主人私聊与关键告警，其余消息静音。</p>'
        + '<div class="t-notify-acts"><span>查看</span><span>延后</span></div></div></div>',
    },
    {
      id: 'sheet', label: '设置弹层', hint: '560×250 · r26', w: 560, h: 250, r: 26,
      html: '<div class="t-sheet"><header><div><small>APPEARANCE</small><h4>面板设置</h4></div><span class="t-sheet-x">×</span></header>'
        + '<div class="t-sheet-row"><span class="t-sheet-ico">' + I.sun + '</span><div><b>外观</b><small>跟随系统 · 浅色</small></div><span class="t-switch is-on"></span></div>'
        + '<div class="t-sheet-row"><span class="t-sheet-ico">' + I.bell + '</span><div><b>通知</b><small>仅关键告警</small></div><span class="t-switch"></span></div>'
        + '<div class="t-sheet-row"><span class="t-sheet-ico">' + I.spark + '</span><div><b>液态玻璃</b><small>边缘折射 + 内侧焦散</small></div><span class="t-switch is-on"></span></div></div>',
    },
    {
      id: 'seg', label: '分段控件', hint: '340×48 · r24', w: 340, h: 48, r: 24,
      html: '<div class="t-seg"><span>概览</span><span class="is-on">会话</span><span>设置</span></div>',
    },
    {
      id: 'search', label: '搜索框', hint: '420×54 · r27', w: 420, h: 54, r: 27,
      html: '<div class="t-search">' + I.search + '<span class="t-search-ph">搜索页面、设置或群聊…</span><kbd>⌘ K</kbd></div>',
    },
    {
      id: 'media', label: '播放器', hint: '380×188 · r30', w: 380, h: 188, r: 30,
      html: '<div class="t-media"><span class="t-cover"><span class="t-cover-disc"></span></span>'
        + '<div class="t-media-body"><small>NOW PLAYING</small><b>Liquid Light</b><span>Estrella Sound</span>'
        + '<div class="t-progress"><i></i><em></em></div>'
        + '<div class="t-controls"><span>' + I.prev + '</span><span class="t-play">' + I.play + '</span><span>' + I.next + '</span></div></div></div>',
    },
    {
      id: 'weather', label: '天气小组件', hint: '240×164 · r28', w: 240, h: 164, r: 28,
      html: '<div class="t-weather"><div class="t-weather-top"><span>上海</span>' + I.cloud + '</div>'
        + '<b class="t-temp">18°</b><p>多云 · 体感 17°</p>'
        + '<div class="t-forecast"><span><small>14时</small><b>19°</b></span><span><small>15时</small><b>19°</b></span>'
        + '<span><small>16时</small><b>18°</b></span><span><small>17时</small><b>17°</b></span></div></div>',
    },
    {
      id: 'tile', label: '控制瓷片', hint: '180×132 · r24', w: 180, h: 132, r: 24,
      html: '<div class="t-tile"><span class="t-tile-ico">' + I.wifi + '</span><b>Wi-Fi</b><small>Estrella-5G</small><span class="t-tile-dot"></span></div>',
    },
    {
      id: 'slider', label: '亮度条', hint: '300×64 · r32', w: 300, h: 64, r: 32,
      html: '<div class="t-slider">' + I.sun + '<span class="t-slider-track"><i style="width:64%"></i><em style="left:64%"></em></span><b>64</b></div>',
    },
    {
      id: 'toggle', label: '设置行', hint: '380×72 · r20', w: 380, h: 72, r: 20,
      html: '<div class="t-toggle"><div><b>热点模式</b><small>允许附近设备发现</small></div><span class="t-switch is-on"></span></div>',
    },
    {
      id: 'menu', label: '上下文菜单', hint: '240×172 · r18', w: 240, h: 172, r: 18,
      html: '<div class="t-menu"><span>' + I.spark + '<b>重新生成</b><kbd>⌘ R</kbd></span>'
        + '<span>' + I.copy + '<b>复制回复</b><kbd>⌘ C</kbd></span>'
        + '<span>' + I.pin + '<b>固定到顶部</b></span><i></i>'
        + '<span class="is-danger">' + I.trash + '<b>删除会话</b></span></div>',
    },
    {
      id: 'chatbar', label: '输入条', hint: '460×72 · r36', w: 460, h: 72, r: 36,
      html: '<div class="t-chat"><span class="t-avatar">C</span><span class="t-chat-input">输入消息…</span><span class="t-send">' + I.send + '</span></div>',
    },
    {
      id: 'dialog', label: '确认框', hint: '420×190 · r24', w: 420, h: 190, r: 24,
      html: '<div class="t-dialog"><h4>覆盖当前配置？</h4><p>新的液态玻璃参数会替换当前页面的材质，操作只影响本机。</p>'
        + '<div class="t-dialog-acts"><span>取消</span><span class="is-primary">覆盖</span></div></div>',
    },
  ];
  const tpl = (id) => (TEMPLATES.find((t) => t.id === id) || TEMPLATES[0]).html;

  const notifyHTML = (title, time, body) => '<div class="t-notify"><span class="t-notify-ico">'
    + I.bell + '</span><div class="t-notify-body"><div class="t-notify-top"><b>' + title
    + '</b><span>' + time + '</span></div><p>' + body + '</p>'
    + '<div class="t-notify-acts"><span>查看</span><span>延后</span></div></div></div>';

  const tileHTML = (ico, title, sub, dot) => '<div class="t-tile"><span class="t-tile-ico">'
    + ico + '</span><b>' + title + '</b><small>' + sub + '</small>'
    + (dot ? '<span class="t-tile-dot"></span>' : '') + '</div>';

  /* ── 7 个可直接拖的场景 ─────────────────────────────────────────────── */
  const SCENES = [
    {
      id: 'desktop', label: '桌面组合', hint: '4 件', acc: '#3d6cf0', acc2: '#8b5cf6',
      specs: [
        { key: 'topbar', x: 450, y: 70, w: 690, h: 62, r: 20, html: tpl('topbar') },
        { key: 'weather', x: 182, y: 247, w: 240, h: 168, r: 28, html: tpl('weather') },
        { key: 'media', x: 618, y: 255, w: 390, h: 190, r: 30, html: tpl('media') },
        { key: 'dock', x: 450, y: 540, w: 430, h: 72, r: 36, html: tpl('dock') },
      ],
    },
    {
      id: 'control', label: '控制中心', hint: '5 件', acc: '#3a8fe0', acc2: '#21b3a6',
      specs: [
        { key: 'wifi', x: 252, y: 194, w: 214, h: 142, r: 26, html: tileHTML(I.wifi, 'Wi-Fi', 'Estrella-5G', true) },
        { key: 'bluetooth', x: 488, y: 194, w: 214, h: 142, r: 26, html: tileHTML(I.bluetooth, '蓝牙', '已连接 2 台', false) },
        { key: 'focus', x: 252, y: 360, w: 214, h: 142, r: 26, html: tileHTML(I.moon, '专注', '22:30 自动结束', false) },
        { key: 'brightness', x: 488, y: 360, w: 214, h: 142, r: 26, html: tileHTML(I.sun, '亮度', '64%', false) },
        { key: 'dock', x: 450, y: 528, w: 440, h: 70, r: 35, html: '<div class="t-dock">'
          + '<span class="t-dock-i is-on">' + I.home + '<small>主页</small></span>'
          + '<span class="t-dock-i">' + I.grid + '<small>发现</small></span>'
          + '<span class="t-dock-i">' + I.music + '<small>电台</small></span>'
          + '<span class="t-dock-i">' + I.settings + '<small>设置</small></span></div>' },
      ],
    },
    {
      id: 'notify', label: '通知中心', hint: '3 件', acc: '#6a6ff0', acc2: '#d76aa8',
      specs: [
        { key: 'n1', x: 450, y: 156, w: 486, h: 112, r: 24, html: notifyHTML('协议端已重新连接', '现在', '登录态恢复，群消息将在几秒内补齐。') },
        { key: 'n2', x: 450, y: 286, w: 486, h: 112, r: 24, html: notifyHTML('群友发来一张图', '2 分钟前', '「晚风」在群里提到了你，并附了一张截图。') },
        { key: 'n3', x: 450, y: 416, w: 486, h: 112, r: 24, html: notifyHTML('夜间模式即将开始', '22:30', '只保留主人私聊与关键告警，其余消息静音。') },
      ],
    },
    {
      id: 'music', label: '正在播放', hint: '3 件', acc: '#e06b8c', acc2: '#6e5cf0',
      specs: [
        { key: 'media', x: 450, y: 246, w: 486, h: 226, r: 32, html: tpl('media') },
        { key: 'lyric', x: 450, y: 402, w: 486, h: 56, r: 28, html: '<div class="t-lyric"><span class="t-lyric-dot"></span>'
          + '<span><b>Liquid Light</b><small>— Estrella Sound</small></span>'
          + '<span class="t-wave"><i></i><i></i><i></i><i></i><i></i></span></div>' },
        { key: 'dock', x: 450, y: 508, w: 390, h: 68, r: 34, html: '<div class="t-dock">'
          + '<span class="t-dock-i">' + I.prev + '<small>上一首</small></span>'
          + '<span class="t-dock-i is-on">' + I.play + '<small>播放</small></span>'
          + '<span class="t-dock-i">' + I.next + '<small>下一首</small></span>'
          + '<span class="t-dock-i">' + I.volume + '<small>音量</small></span></div>' },
      ],
    },
    {
      id: 'search', label: '搜索面板', hint: '3 件', acc: '#3f6fe8', acc2: '#43b0c9',
      specs: [
        { key: 'search', x: 450, y: 138, w: 570, h: 58, r: 29, html: tpl('search') },
        { key: 'results', x: 450, y: 330, w: 570, h: 268, r: 24, html: '<div class="t-results"><small>搜索结果 · 4</small>'
          + '<span class="t-result is-on"><i>' + I.settings + '</i><b>面板设置</b><em>设置 / 外观</em><kbd>↵</kbd></span>'
          + '<span class="t-result"><i>' + I.message + '</i><b>会话 · 晚风</b><em>群聊 / 3 天前</em></span>'
          + '<span class="t-result"><i>' + I.bell + '</i><b>通知与免打扰</b><em>设置 / 提醒</em></span>'
          + '<span class="t-result"><i>' + I.book + '</i><b>记忆条目 · 运行偏好</b><em>记忆 / 长期</em></span>'
          + '<span class="t-result"><i>' + I.spark + '</i><b>液态玻璃参数</b><em>实验 / SDF</em></span></div>' },
        { key: 'hint', x: 450, y: 520, w: 390, h: 54, r: 27, html: '<div class="t-lyric"><span class="t-lyric-dot"></span>'
          + '<span><b>↑ ↓ 选择 · ↵ 打开</b><small>Esc 关闭搜索</small></span><kbd>⌘ K</kbd></div>' },
      ],
    },
    {
      id: 'chat', label: '对话与菜单', hint: '4 件', acc: '#d1748f', acc2: '#4f79d8',
      specs: [
        { key: 'incoming', x: 300, y: 194, w: 326, h: 116, r: 24, html: '<div class="t-bubble"><span class="t-avatar">晚</span>'
          + '<div><small>晚风 · 21:04</small><p>把导航改成液态玻璃后，边缘真的会把背后的字折进来。</p></div></div>' },
        { key: 'outgoing', x: 596, y: 326, w: 300, h: 104, r: 24, html: '<div class="t-bubble is-me"><span class="t-avatar">C</span>'
          + '<div><small>我 · 21:05</small><p>中心保持清晰，只有边缘弯折；再调一下色散。</p></div></div>' },
        { key: 'menu', x: 760, y: 160, w: 210, h: 166, r: 18, html: tpl('menu') },
        { key: 'chatbar', x: 450, y: 520, w: 570, h: 72, r: 36, html: tpl('chatbar') },
      ],
    },
    {
      id: 'settings', label: '设置弹层', hint: '4 件', acc: '#5b6fe0', acc2: '#9b6ad8',
      specs: [
        { key: 'notify', x: 226, y: 142, w: 336, h: 112, r: 24, html: notifyHTML('外观已切换', '刚刚', '新材质会在下一次重绘时生效。') },
        { key: 'toggle', x: 710, y: 152, w: 250, h: 92, r: 20, html: tpl('toggle') },
        { key: 'sheet', x: 450, y: 330, w: 610, h: 300, r: 28, html: tpl('sheet') },
        { key: 'seg', x: 450, y: 522, w: 350, h: 48, r: 24, html: tpl('seg') },
      ],
    },
  ];

  const BACKDROPS = [
    { id: 'aurora', label: '极光', color: 'linear-gradient(135deg,#0b1224,#4b6fe8)' },
    { id: 'dusk', label: '暮色', color: 'linear-gradient(135deg,#f7e4d4,#b8c7ff)' },
    { id: 'grid', label: '制图', color: 'linear-gradient(135deg,#eef2f7,#cfdaea)' },
    { id: 'paper', label: '纸感', color: 'linear-gradient(135deg,#f8f3e9,#ded2bc)' },
    { id: 'blank', label: '空白', color: 'linear-gradient(135deg,#f5f7fa,#e7ebf2)' },
  ];

  /* 参数基线来自 2026-10-22 维护者截图；SDF 环带、中心 0.26、投影 19/40/17。 */
  const DEFAULTS = {
    map: 'sdf',
    scale: -52, chroma: 9, edgeBand: 0.24, curve: 2.5, center: 0.26, mapBlur: 12,
    blur: 2.5, saturate: 161, brightness: 1.02,
    tint: 0.23, noise: 0.035,
    rim: 0.8, caustic: 0.6, border: 1,
    /* 吸收自外部做法（独立实现）：内侧暗壁 + 渐变描边 + 对角高光 */
    wall: 0.25, bevel: 'raised', bevelA: 0.35, spec: 'sweep',
    shadowA: 0.27, shadowY: 19, shadowB: 40, shadowSpread: 17,
  };

  const PRESETS = [
    {
      id: 'balanced', name: '均衡', color: '#2f509b', theme: 'light',
      params: Object.assign({}, DEFAULTS),
    },
    {
      id: 'clear', name: '轻透', color: '#43a5c4', theme: 'light',
      params: Object.assign({}, DEFAULTS, {
        scale: -36, chroma: 6, edgeBand: 0.2, curve: 2.1, center: 0.13, mapBlur: 14,
        blur: 2, saturate: 150, brightness: 1.03, tint: 0.16, noise: 0.022,
        rim: 0.64, caustic: 0.42, border: 0.8, shadowA: 0.18, shadowY: 15, shadowB: 34, shadowSpread: 20,
        wall: 0.12, bevel: 'off', spec: 'sweep',
      }),
    },
    {
      id: 'refract', name: '强折射', color: '#7a5cf0', theme: 'light',
      params: Object.assign({}, DEFAULTS, {
        scale: -78, chroma: 15, edgeBand: 0.29, curve: 2.9, center: 0.33, mapBlur: 9,
        blur: 2.5, saturate: 172, brightness: 1.02, tint: 0.21, noise: 0.03,
        rim: 0.92, caustic: 0.76, border: 1.2, shadowA: 0.3, shadowY: 22, shadowB: 46, shadowSpread: 16,
        wall: 0.34, bevelA: 0.5, spec: 'corners',
      }),
    },
    {
      id: 'frost', name: '磨砂', color: '#8c9bb3', theme: 'light', mode: 'frost',
      params: Object.assign({}, DEFAULTS, {
        blur: 9, saturate: 176, brightness: 1.03, tint: 0.36, noise: 0.02,
        rim: 0.52, caustic: 0.3, border: 1, shadowA: 0.24, shadowY: 18, shadowB: 42, shadowSpread: 18,
        wall: 0.16, bevelA: 0.3,
      }),
    },
    {
      id: 'night', name: '暗夜', color: '#1e2a44', theme: 'dark',
      params: Object.assign({}, DEFAULTS, {
        scale: -58, chroma: 8, edgeBand: 0.26, curve: 2.6, center: 0.24, mapBlur: 11,
        blur: 3.5, saturate: 135, brightness: 0.98, tint: 0.34, noise: 0.04,
        rim: 0.58, caustic: 0.38, border: 1, shadowA: 0.46, shadowY: 24, shadowB: 52, shadowSpread: 14,
        wall: 0.4, bevelA: 0.4,
      }),
    },
  ];

  const PARAM_GROUPS = [
    {
      title: '透镜', keys: ['map', 'scale', 'chroma', 'edgeBand', 'curve', 'center', 'mapBlur'],
      items: [
        { key: 'map', label: '贴图', select: [['sdf', 'SDF 环形透镜'], ['ramp', 'Ramp 边缘弯折']] },
        { key: 'scale', label: '折射强度', min: -140, max: 140, step: 1, tip: '边缘位移量；负值把背景向内折' },
        { key: 'chroma', label: '色散', min: 0, max: 24, step: 1, tip: '红/蓝通道的错位量，形成边缘彩边' },
        { key: 'edgeBand', label: '边缘带宽', min: 0.04, max: 0.4, step: 0.01, fmt: (v) => v.toFixed(2), tip: '环带宽度占短边比例；只弯边缘' },
        { key: 'curve', label: '边缘曲线', min: 0.5, max: 3, step: 0.1, fmt: (v) => v.toFixed(1), tip: '环带衰减曲线；越大越集中在边缘' },
        { key: 'center', label: '中心放大', min: 0, max: 0.6, step: 0.01, fmt: (v) => v.toFixed(2), tip: '中心向心位移，模拟轻微放大' },
        { key: 'mapBlur', label: '贴图柔化', min: 0, max: 30, step: 1, tip: '位移贴图模糊；越小边缘越锐' },
      ],
    },
    {
      title: '材质', keys: ['blur', 'saturate', 'brightness'],
      items: [
        { key: 'blur', label: '模糊', min: 0, max: 16, step: 0.5, unit: 'px', tip: '背板高斯模糊' },
        { key: 'saturate', label: '饱和', min: 100, max: 220, step: 1, unit: '%', tip: '透出的颜色饱和度' },
        { key: 'brightness', label: '亮度', min: 0.9, max: 1.15, step: 0.01, fmt: (v) => v.toFixed(2), tip: '透出的亮度' },
      ],
    },
    {
      title: '表面', keys: ['tint', 'noise'],
      items: [
        { key: 'tint', label: '白纱不透明度', min: 0, max: 0.6, step: 0.01, fmt: (v) => v.toFixed(2), tip: '白纱/暗纱的不透明度' },
        { key: 'noise', label: '噪声', min: 0, max: 0.08, step: 0.005, fmt: (v) => v.toFixed(3), tip: '噪点强度，压住塑料感' },
      ],
    },
    {
      title: '边缘', keys: ['rim', 'caustic', 'border', 'wall', 'bevel', 'bevelA', 'spec'],
      items: [
        { key: 'rim', label: '边缘高光', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2), tip: '外缘镜面高光' },
        { key: 'caustic', label: '内侧焦散', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2), tip: '内侧回折的亮边' },
        { key: 'border', label: '边框厚度', min: 0.5, max: 2, step: 0.1, unit: 'px', tip: '最外圈描边厚度' },
        { key: 'wall', label: '内侧暗壁', min: 0, max: 0.6, step: 0.01, fmt: (v) => v.toFixed(2), tip: '一圈柔暗内壁 = 玻璃厚度；浅色底上防塑料感' },
        { key: 'bevel', label: '渐变描边', select: [['off', '关闭'], ['raised', '凸起（上亮下暗）'], ['groove', '凹槽（上暗下亮）']] },
        { key: 'bevelA', label: '描边明暗差', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2), tip: '渐变描边的强度' },
        { key: 'spec', label: '高光形状', select: [['sweep', '单向扫光'], ['corners', '对角双高光'], ['both', '两者叠加']] },
      ],
    },
    {
      title: '投影', keys: ['shadowA', 'shadowY', 'shadowB', 'shadowSpread'],
      items: [
        { key: 'shadowA', label: '环境投影浓度', min: 0, max: 0.4, step: 0.01, fmt: (v) => v.toFixed(2), tip: '空白页上也应看得见的环境投影' },
        { key: 'shadowY', label: '投影下移', min: 0, max: 40, step: 1, unit: 'px', tip: '投影垂直偏移' },
        { key: 'shadowB', label: '投影模糊', min: 0, max: 80, step: 1, unit: 'px', tip: '投影模糊半径' },
        { key: 'shadowSpread', label: '投影收束', min: 0, max: 40, step: 1, unit: 'px', tip: '负扩散；越大越收束' },
      ],
    },
  ];

  const LAYERS = [
    { id: 'shadow', label: '投影', sw: '#4b628f' },
    { id: 'lens', label: '背板折射', sw: '#4d7cf0' },
    { id: 'tint', label: '白纱', sw: '#c9d6ea' },
    { id: 'rim', label: '边缘 / 焦散', sw: '#8fb4ff' },
    { id: 'noise', label: '噪点', sw: '#9a88b8' },
    { id: 'content', label: '内容', sw: '#5d6f8e' },
  ];

  const state = {
    theme: 'light',
    backdrop: 'aurora',
    view: 'scene',
    scene: 'desktop',
    template: 'pill',
    mode: EG && EG.support && EG.support.lens ? 'lens' : 'frost',
    params: Object.assign({}, DEFAULTS),
    layouts: {},
    selected: null,
    layers: { shadow: true, lens: true, tint: true, rim: true, noise: true, content: true },
    blur: { layers: 3, strength: 1, flat: false, opaque: false },
    grid: false,
    explode: false,
    zoom: 1,
    exportTab: 'css',
    insts: [],
    compareInsts: [],
    specDefs: new Map(),
    fit: 1,
    lastBuildMs: 0,
    lastMapMs: 0,
  };

  let scheduleTimer = 0;
  let mapTimer = 0;
  let saveTimer = 0;
  let toastTimer = 0;
  let hintTimer = 0;
  let modalRO = null;
  let drag = null;
  let splitDrag = null;
  let modalDrag = null;

  const currentScene = () => SCENES.find((s) => s.id === state.scene) || SCENES[0];
  const currentTemplate = () => TEMPLATES.find((t) => t.id === state.template) || TEMPLATES[0];
  const sceneKey = () => (state.view === 'single' ? 'single' : state.scene);
  const paramItem = (key) => PARAM_GROUPS.flatMap((g) => g.items).find((i) => i.key === key);
  const fmtValue = (item, value) => (typeof item.fmt === 'function' ? item.fmt(value) : String(value) + (item.unit || ''));

  function specsForCurrent() {
    if (state.view === 'single') {
      const t = currentTemplate();
      return [{ key: 'single', x: 450, y: 310, w: t.w, h: t.h, r: t.r, html: t.html, label: t.label }];
    }
    return currentScene().specs;
  }

  function layoutKey(spec) { return sceneKey() + ':' + spec.key; }

  function getLayout(spec) {
    const stored = state.layouts[layoutKey(spec)];
    const base = Object.assign({}, spec);
    if (stored && [stored.x, stored.y, stored.w, stored.h, stored.r].every(Number.isFinite)) {
      return Object.assign(base, stored);
    }
    return base;
  }

  function setLayout(spec, next) {
    state.layouts[layoutKey(spec)] = {
      x: next.x, y: next.y, w: next.w, h: next.h, r: next.r,
    };
    saveState();
  }

  function clampCenter(x, y, w, h) {
    const mx = w / 2 + 8;
    const my = h / 2 + 8;
    return {
      x: mx > DESIGN.w - mx ? DESIGN.w / 2 : clamp(x, mx, DESIGN.w - mx),
      y: my > DESIGN.h - my ? DESIGN.h / 2 : clamp(y, my, DESIGN.h - my),
    };
  }

  /* ── 持久化 ─────────────────────────────────────────────────────────── */
  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({
          v: 2, theme: state.theme, backdrop: state.backdrop, view: state.view,
          scene: state.scene, template: state.template, mode: state.mode,
          params: state.params, layouts: state.layouts, layers: state.layers, blur: state.blur,
          zoom: state.zoom,
        }));
      } catch { /* file:// 隐私模式禁写时静默 */ }
    }, 220);
  }

  function loadState() {
    let raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch { return; }
    if (!raw) return;
    try {
      const o = JSON.parse(raw);
      if (!o || o.v !== 2) return;
      if (o.theme === 'dark' || o.theme === 'light') state.theme = o.theme;
      if (BACKDROPS.some((b) => b.id === o.backdrop)) state.backdrop = o.backdrop;
      if (['scene', 'single', 'compare'].includes(o.view)) state.view = o.view;
      if (SCENES.some((s) => s.id === o.scene)) state.scene = o.scene;
      if (TEMPLATES.some((t) => t.id === o.template)) state.template = o.template;
      if ((o.mode === 'lens' && EG && EG.support.lens) || o.mode === 'frost') state.mode = o.mode;
      if (o.params && typeof o.params === 'object') {
        for (const key of Object.keys(DEFAULTS)) {
          const item = paramItem(key);
          if (item && item.select) {
            if (item.select.some(([v]) => v === o.params[key])) state.params[key] = o.params[key];
          } else if (Number.isFinite(o.params[key])) {
            state.params[key] = item ? clamp(o.params[key], item.min, item.max) : o.params[key];
          }
        }
      }
      if (o.layouts && typeof o.layouts === 'object') {
        for (const [key, value] of Object.entries(o.layouts)) {
          if (value && [value.x, value.y, value.w, value.h, value.r].every(Number.isFinite)) {
            state.layouts[key] = value;
          }
        }
      }
      if (o.layers && typeof o.layers === 'object') {
        for (const layer of LAYERS) {
          if (typeof o.layers[layer.id] === 'boolean') state.layers[layer.id] = o.layers[layer.id];
        }
      }
      if (o.blur) {
        state.blur.layers = clamp(Number(o.blur.layers) || 3, 1, 3);
        state.blur.strength = clamp(Number(o.blur.strength) || 1, 0.4, 2);
      }
      if (Number.isFinite(o.zoom)) state.zoom = clamp(o.zoom, 0.75, 1.5);
    } catch { /* 坏数据就当没存过 */ }
  }

  /* ── 变量、贴图、实例 ───────────────────────────────────────────────── */
  function lensOpts() {
    const p = state.params;
    return {
      map: p.map, scale: p.scale, chroma: p.chroma,
      edgeBand: p.edgeBand, curve: p.curve, center: p.center, mapBlur: p.mapBlur,
      blur: p.blur, saturate: p.saturate, brightness: p.brightness,
    };
  }

  function applyVars() {
    const p = state.params;
    root.style.setProperty('--gs-blur', p.blur + 'px');
    root.style.setProperty('--gs-sat', String(p.saturate / 100));
    root.style.setProperty('--gs-bright', String(p.brightness));
    root.style.setProperty('--gs-tint-a', String(p.tint));
    root.style.setProperty('--gs-noise', String(p.noise));
    root.style.setProperty('--gs-rim', String(p.rim));
    root.style.setProperty('--gs-caustic', String(p.caustic));
    root.style.setProperty('--gs-border', p.border + 'px');
    /* 光影三件套：壁宽/壁色由 wall 驱动；渐变描边由 bevel 模式 × 强度驱动 */
    root.style.setProperty('--gs-wall', String(p.wall));
    const strength = p.bevel === 'off' ? 0 : p.bevelA;
    const light = (a) => 'rgba(255, 255, 255, ' + a.toFixed(3) + ')';
    const dark = (a) => 'rgba(var(--gs-shadow-rgb), ' + a.toFixed(3) + ')';
    const groove = p.bevel === 'groove';
    root.style.setProperty('--gs-bevel-top', groove ? dark(0.30 * strength) : light(0.95 * strength));
    root.style.setProperty('--gs-bevel-bottom', groove ? light(0.80 * strength) : dark(0.24 * strength));
    $$('.gs-spec').forEach((el) => { el.dataset.spec = p.spec; });
    root.style.setProperty('--gs-shadow-a', String(p.shadowA));
    root.style.setProperty('--gs-shadow-y', p.shadowY + 'px');
    root.style.setProperty('--gs-shadow-b', p.shadowB + 'px');
    root.style.setProperty('--gs-shadow-spread', p.shadowSpread + 'px');
    for (const layer of LAYERS) root.dataset['layer' + layer.id[0].toUpperCase() + layer.id.slice(1)] = state.layers[layer.id] ? '1' : '0';
    $$('[data-layer-meta]').forEach((el) => { el.textContent = layerMeta(el.dataset.layerMeta); });
  }

  function layerMeta(id) {
    const p = state.params;
    if (id === 'shadow') return p.shadowY + '/' + p.shadowB + 'px';
    if (id === 'lens') return p.map === 'sdf' ? 'SDF' : 'RAMP';
    if (id === 'tint') return Math.round(p.tint * 100) + '%';
    if (id === 'rim') return p.rim.toFixed(2) + ' / ' + p.caustic.toFixed(2)
      + ' · 壁' + Math.round(p.wall * 100) + ' · ' + ({ off: '无边', raised: '凸', groove: '凹' }[p.bevel] || '无边');
    if (id === 'noise') return (p.noise * 100).toFixed(1) + '%';
    return 'front';
  }

  function applyInstances() {
    const opts = lensOpts();
    for (const inst of state.insts.concat(state.compareInsts)) {
      if (inst && typeof inst.set === 'function') inst.set(opts);
    }
  }

  function schedule() {
    clearTimeout(scheduleTimer);
    scheduleTimer = setTimeout(() => {
      applyVars();
      applyInstances();
      updateMapPreview();
      updateExport();
      updateSupport();
      updateDirty();
      saveState();
    }, 70);
  }

  function updateMapPreview() {
    const img = $('#gsMapImg');
    const meta = $('#gsMapMeta');
    if (!img || !meta) return;
    if (!EG) { meta.textContent = '引擎未加载'; return; }
    clearTimeout(mapTimer);
    mapTimer = setTimeout(() => {
      const t0 = performance.now();
      const opts = Object.assign({}, EG.defaults, lensOpts());
      const url = state.params.map === 'sdf'
        ? EG.buildMapSdf(240, 116, 40, opts)
        : EG.buildMap(240, 116, 40, opts);
      state.lastMapMs = Math.round(performance.now() - t0);
      if (url) img.src = url;
      meta.textContent = state.params.map.toUpperCase() + ' · 240×116 · ' + state.lastMapMs + 'ms';
      updateSupport();
    }, 120);
  }

  /* ── 舞台构建 ───────────────────────────────────────────────────────── */
  const wallpaperInner = (id) => {
    if (id === 'aurora') {
      return '<span class="wp-stars"></span><span class="wp-lines"></span>'
        + '<span class="wp-word">AURORA</span><span class="wp-sub">DRAG THE GLASS · WATCH THE EDGE BEND LIGHT</span>'
        + '<span class="wp-note n1">N = 1.52 · EDGE BAND 24%</span>'
        + '<span class="wp-note n2">NEUTRAL 128<br>CENTER STAYS CLEAR</span>';
    }
    if (id === 'dusk') {
      return '<span class="wp-glow g1"></span><span class="wp-glow g2"></span>'
        + '<span class="wp-word">Made of light</span><span class="wp-sub">A SMALL STUDY OF REFRACTION</span>';
    }
    if (id === 'grid') {
      return '<span class="wp-word">OPTICS<br>/ 01</span><span class="wp-sub">900 × 620 · EDGE BAND 24%<br>NEUTRAL 128</span>'
        + '<span class="wp-cross" style="left:8%;top:12%"></span><span class="wp-cross" style="right:8%;bottom:12%"></span>';
    }
    if (id === 'paper') {
      return '<span class="wp-rule r1"></span><span class="wp-rule r2"></span>'
        + '<span class="wp-word">Estrella</span><span class="wp-sub">LIQUID GLASS · SPECIMEN NO. 04</span>';
    }
    return '<span class="wp-sub">BLANK SURFACE · SHADOW CHECK</span>';
  };

  function makeWallpaper() {
    const w = document.createElement('div');
    w.className = 'gs-wallpaper wp-' + state.backdrop;
    w.innerHTML = wallpaperInner(state.backdrop);
    return w;
  }

  function applyBackdropToWorlds() {
    root.dataset.backdrop = state.backdrop;
    for (const world of [$('#gsWorldA'), $('#gsWorldB')]) {
      if (!world) continue;
      const old = $('.gs-wallpaper', world);
      const next = makeWallpaper();
      if (old) old.replaceWith(next); else world.prepend(next);
    }
  }

  function createSpecEl(spec, mode) {
    const layout = getLayout(spec);
    const el = document.createElement('div');
    el.className = 'gs-spec';
    el.dataset.key = spec.key;
    el.dataset.mode = mode;
    el.dataset.spec = state.params.spec;
    el.dataset.variant = mode === 'current' ? 'current' : 'refined';
    el.innerHTML = '<span class="gs-shadow"></span><span class="gs-lens"></span>'
      + '<span class="gs-tint"></span><span class="gs-rim"></span><span class="gs-noise"></span>'
      + '<div class="gs-content">' + spec.html + '</div>'
      + '<span class="gs-outline">'
      + '<span class="gs-handle" data-corner="nw"></span><span class="gs-handle" data-corner="ne"></span>'
      + '<span class="gs-handle" data-corner="sw"></span><span class="gs-handle" data-corner="se"></span>'
      + '<span class="gs-size-tag"></span></span>';
    applyLayoutToEl(el, layout);
    el.style.zIndex = String(10 + Math.round(layout.y));
    return el;
  }

  function applyLayoutToEl(el, layout) {
    el.style.left = layout.x + 'px';
    el.style.top = layout.y + 'px';
    el.style.width = layout.w + 'px';
    el.style.height = layout.h + 'px';
    el.style.borderRadius = layout.r + 'px';
    el.dataset.z = String(10 + Math.round(layout.y));
    el.style.zIndex = el.classList.contains('is-selected') ? '600' : el.dataset.z;
    const tag = $('.gs-size-tag', el);
    if (tag) tag.textContent = Math.round(layout.w) + ' × ' + Math.round(layout.h);
  }

  function clearInstances() {
    for (const inst of state.insts.concat(state.compareInsts)) {
      try { inst.destroy(); } catch { /* 单实例失败不应拦住整场重建 */ }
    }
    state.insts = [];
    state.compareInsts = [];
  }

  function rebuildStage() {
    const t0 = performance.now();
    clearInstances();
    state.specDefs.clear();
    const specs = specsForCurrent();
    const compare = state.view === 'compare';
    const lensOK = !!(EG && EG.support && EG.support.lens);
    if (state.mode === 'lens' && !lensOK) state.mode = 'frost';

    $('#gsWorldWrapB').hidden = !compare;
    $('#gsCompare').hidden = !compare;
    $('#gsVLabels').hidden = !compare;
    $('#gsCanvas').dataset.view = state.view;
    const bLabel = $('#gsVLabels .is-b');
    if (bLabel) bLabel.innerHTML = '<i></i>' + (lensOK ? '精修 · SDF 透镜' : '精修 · CSS 磨砂');

    const worldA = $('#gsWorldA');
    const worldB = $('#gsWorldB');
    worldA.replaceChildren(makeWallpaper());
    worldB.replaceChildren(makeWallpaper());

    for (const spec of specs) {
      state.specDefs.set(spec.key, spec);
      const modeA = compare ? 'current' : (state.mode === 'lens' ? 'lens' : 'frost');
      const elA = createSpecEl(spec, modeA);
      worldA.appendChild(elA);
      if (modeA === 'lens' && lensOK) {
        const lens = $('.gs-lens', elA);
        const inst = EG.make(lens, lensOpts());
        if (inst) state.insts.push(inst);
      }
      if (compare) {
        /* 没有真透镜也要给右侧一层材质：否则对比视图右半会变成空白。 */
        const elB = createSpecEl(spec, lensOK ? 'lens' : 'frost');
        worldB.appendChild(elB);
        if (lensOK) {
          const inst = EG.make($('.gs-lens', elB), lensOpts());
          if (inst) state.compareInsts.push(inst);
        }
      }
    }

    if (state.selected && !state.specDefs.has(state.selected)) state.selected = null;
    applySelection();
    updateStageBadge(specs);
    updateFit();
    updateSupport();
    updateMapPreview();
    updateExport();
    state.lastBuildMs = Math.round(performance.now() - t0);
    const perf = $('#gsPerf');
    if (perf) perf.textContent = '重建 ' + state.lastBuildMs + 'ms';
    syncViewTabs();
    syncPalette();
    syncScenes();
  }

  function updateFit() {
    const canvas = $('#gsCanvas');
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const base = clamp(Math.min(r.width / DESIGN.w, r.height / DESIGN.h), 0.32, 1.08);
    const fit = clamp(base * state.zoom, 0.32, 2);
    state.fit = fit;
    canvas.style.setProperty('--gs-fit', fit.toFixed(4));
    const zoomBtn = $('[data-gs="zoom"]');
    if (zoomBtn) zoomBtn.textContent = Math.round(state.zoom * 100) + '%';
  }

  function updateStageBadge(specs) {
    const el = $('#gsStageBadge');
    if (!el) return;
    if (state.view === 'compare') {
      const lensOK = !!(EG && EG.support && EG.support.lens);
      el.textContent = '对比 · ' + specs.length + ' 对 · 磨砂 ↔ ' + (lensOK ? 'SDF 透镜' : 'CSS 磨砂');
      return;
    }
    if (state.view === 'single') {
      const t = currentTemplate();
      el.textContent = t.label + ' · ' + Math.round(t.w) + '×' + Math.round(t.h) + ' · '
        + (state.mode === 'lens' ? 'SDF lens' : 'frost');
      return;
    }
    const sc = currentScene();
    el.textContent = sc.label + ' · ' + specs.length + ' 件玻璃 · '
      + (state.mode === 'lens' ? 'SDF lens' : 'frost');
  }

  /* ── 选择、拖动、缩放、对比 ─────────────────────────────────────────── */
  function select(key) {
    state.selected = key || null;
    applySelection();
  }

  function applySelection() {
    $$('.gs-spec', $('#gsCanvas')).forEach((el) => {
      const on = el.dataset.key === state.selected;
      el.classList.toggle('is-selected', on);
      el.style.zIndex = on ? '600' : (el.dataset.z || '10');
    });
    const box = $('#gsSelection');
    if (!box) return;
    if (!state.selected) { box.textContent = '未选中玻璃'; return; }
    const spec = state.specDefs.get(state.selected);
    if (!spec) { box.textContent = '未选中玻璃'; return; }
    const l = getLayout(spec);
    box.textContent = state.selected + ' · x' + Math.round(l.x) + ' y' + Math.round(l.y)
      + ' · ' + Math.round(l.w) + '×' + Math.round(l.h) + ' · r' + Math.round(l.r);
  }

  function updateSelectedLayout(spec, layout) {
    setLayout(spec, layout);
    $$('.gs-spec', $('#gsCanvas')).forEach((el) => {
      if (el.dataset.key !== spec.key) return;
      applyLayoutToEl(el, layout);
    });
    applySelection();
  }

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const handle = e.target.closest('.gs-handle');
    if (handle) { beginResize(e, handle); return; }
    const compareHandle = e.target.closest('#gsCompareHandle');
    if (compareHandle) { beginSplitDrag(e); return; }
    const spec = e.target.closest('.gs-spec');
    if (spec && spec.closest('#gsCanvas')) {
      e.preventDefault();
      const key = spec.dataset.key;
      select(key);
      beginDrag(e, key);
      return;
    }
    if (e.target.closest('#gsCanvas')) select(null);
  }

  function pointerMoveHandler(e) {
    if (!drag) return;
    const spec = state.specDefs.get(drag.key);
    if (!spec) return;
    const dx = (e.clientX - drag.sx) / state.fit;
    const dy = (e.clientY - drag.sy) / state.fit;
    if (!drag.moved && Math.hypot(dx, dy) < 2) return;
    drag.moved = true;
    const c = clampCenter(drag.base.x + dx, drag.base.y + dy, drag.base.w, drag.base.h);
    const next = Object.assign({}, drag.base, { x: c.x, y: c.y });
    updateSelectedLayout(spec, next);
  }

  function pointerUpHandler() {
    if (drag) {
      document.body.classList.remove('is-dragging');
      if (drag.moved) saveState();
      drag = null;
    }
    if (splitDrag) { splitDrag = null; }
  }

  function beginDrag(e, key) {
    const spec = state.specDefs.get(key);
    if (!spec) return;
    drag = { key, sx: e.clientX, sy: e.clientY, base: getLayout(spec), moved: false };
    document.body.classList.add('is-dragging');
    dimHint();
  }

  function beginResize(e, handle) {
    e.preventDefault();
    e.stopPropagation();
    const specEl = handle.closest('.gs-spec');
    if (!specEl) return;
    const key = specEl.dataset.key;
    select(key);
    const spec = state.specDefs.get(key);
    if (!spec) return;
    const base = getLayout(spec);
    const corner = handle.dataset.corner;
    const sx = e.clientX;
    const sy = e.clientY;
    const fit = state.fit;
    if (handle.setPointerCapture) {
      try { handle.setPointerCapture(e.pointerId); } catch { /* 某些指针类型不支持捕获 */ }
    }

    const move = (ev) => {
      const dx = (ev.clientX - sx) / fit;
      const dy = (ev.clientY - sy) / fit;
      let w = base.w;
      let h = base.h;
      let x = base.x;
      let y = base.y;
      if (corner.includes('e')) {
        w = clamp(base.w + dx, 56, DESIGN.w - 24);
        x = (base.x - base.w / 2) + w / 2;
      } else if (corner.includes('w')) {
        w = clamp(base.w - dx, 56, DESIGN.w - 24);
        x = (base.x + base.w / 2) - w / 2;
      }
      if (corner.includes('s')) {
        h = clamp(base.h + dy, 36, DESIGN.h - 24);
        y = (base.y - base.h / 2) + h / 2;
      } else if (corner.includes('n')) {
        h = clamp(base.h - dy, 36, DESIGN.h - 24);
        y = (base.y + base.h / 2) - h / 2;
      }
      const capsule = base.r >= Math.min(base.w, base.h) / 2 - 0.6;
      const r = capsule ? Math.min(w, h) / 2 : base.r * Math.min(w / base.w, h / base.h);
      const c = clampCenter(x, y, w, h);
      updateSelectedLayout(spec, { x: c.x, y: c.y, w, h, r });
      dimHint();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveState();
      for (const inst of state.insts.concat(state.compareInsts)) {
        if (inst && inst.el && inst.el.closest('.gs-spec') && inst.el.closest('.gs-spec').dataset.key === key) {
          try { inst.refresh(true); } catch { /* 重建失败时 ResizeObserver 还会再试 */ }
        }
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function beginSplitDrag(e) {
    e.preventDefault();
    const canvas = $('#gsCanvas');
    if (!canvas) return;
    splitDrag = true;
    const move = (ev) => {
      const r = canvas.getBoundingClientRect();
      const pct = clamp(((ev.clientX - r.left) / r.width) * 100, 8, 92);
      canvas.style.setProperty('--gs-split', pct.toFixed(2) + '%');
      const handle = $('#gsCompareHandle');
      if (handle) handle.setAttribute('aria-valuenow', String(Math.round(pct)));
    };
    move(e);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      splitDrag = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function resetSpecLayout(key) {
    const spec = state.specDefs.get(key);
    if (!spec) return;
    delete state.layouts[layoutKey(spec)];
    const base = getLayout(spec);
    updateSelectedLayout(spec, base);
    saveState();
    toast('已复位 ' + key);
  }

  function resetCurrentLayout() {
    for (const spec of specsForCurrent()) delete state.layouts[layoutKey(spec)];
    for (const spec of state.specDefs.values()) {
      const base = getLayout(spec);
      $$('.gs-spec', $('#gsCanvas')).forEach((el) => {
        if (el.dataset.key === spec.key) applyLayoutToEl(el, base);
      });
    }
    applySelection();
    saveState();
    toast('当前场景已复位');
  }

  /* ── 视图 / 背板 / 选择状态 ─────────────────────────────────────────── */
  function setView(view) {
    if (!['scene', 'single', 'compare'].includes(view)) return;
    state.view = view;
    state.selected = null;
    rebuildStage();
    saveState();
    toast(view === 'compare' ? '拖动中间分割线对比' : (view === 'single' ? '单件检查：可拖角点缩放' : '场景已加载'));
  }

  function setBackdrop(id) {
    if (!BACKDROPS.some((b) => b.id === id)) return;
    state.backdrop = id;
    applyBackdropToWorlds();
    syncBackdrops();
    saveState();
  }

  function setTemplate(id) {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    state.template = id;
    state.view = 'single';
    state.selected = null;
    rebuildStage();
    saveState();
    toast(t.label + ' 已载入');
  }

  function setScene(id) {
    const sc = SCENES.find((x) => x.id === id);
    if (!sc) return;
    state.scene = id;
    state.view = 'scene';
    state.selected = null;
    rebuildStage();
    saveState();
    toast(sc.label + ' 已载入');
  }

  function setMode(mode) {
    state.mode = mode === 'lens' && EG && EG.support.lens ? 'lens' : 'frost';
    rebuildStage();
    saveState();
  }

  function setTheme(theme) {
    state.theme = theme === 'dark' ? 'dark' : 'light';
    root.dataset.theme = state.theme;
    syncThemeButton();
    applyVars();
    updateMapPreview();
    updateExport();
    saveState();
  }

  function toggleTheme() { setTheme(state.theme === 'light' ? 'dark' : 'light'); }

  function applyPreset(id) {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    state.params = Object.assign({}, preset.params);
    state.mode = preset.mode === 'frost' || !(EG && EG.support.lens) ? 'frost' : 'lens';
    if (preset.theme) {
      state.theme = preset.theme;
      root.dataset.theme = state.theme;
      syncThemeButton();
    }
    applyVars();
    buildControls();
    rebuildStage();
    updateMapPreview();
    updateExport();
    updateDirty();
    saveState();
    toast(preset.name + ' 预设已应用');
  }

  function resetAll() {
    state.params = Object.assign({}, DEFAULTS);
    state.theme = 'light';
    state.backdrop = 'aurora';
    state.view = 'scene';
    state.scene = 'desktop';
    state.template = 'pill';
    state.mode = EG && EG.support.lens ? 'lens' : 'frost';
    state.layouts = {};
    state.layers = { shadow: true, lens: true, tint: true, rim: true, noise: true, content: true };
    state.blur = { layers: 3, strength: 1, flat: false, opaque: false };
    state.selected = null;
    state.grid = false;
    state.explode = false;
    state.zoom = 1;
    root.dataset.theme = state.theme;
    root.dataset.explode = '0';
    root.dataset.backdrop = state.backdrop;
    const grid = $('#gsGrid');
    if (grid) grid.hidden = true;
    syncThemeButton();
    syncThemeControls();
    buildControls();
    applyVars();
    rebuildStage();
    updateMapPreview();
    updateExport();
    syncBackdrops();
    toast('已恢复默认参数与布局');
    saveState();
  }

  /* ── 控件 ───────────────────────────────────────────────────────────── */
  function setRangeFill(input) {
    const min = Number(input.min);
    const max = Number(input.max);
    const v = Number(input.value);
    input.style.setProperty('--fill', ((v - min) / (max - min) * 100).toFixed(2) + '%');
  }

  function buildControls() {
    const box = $('#gsControls');
    if (!box) return;
    box.replaceChildren();
    for (const group of PARAM_GROUPS) {
      const sec = document.createElement('section');
      sec.className = 'gs-group';
      sec.dataset.open = '1';
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'gs-group-head';
      head.innerHTML = '<span class="gs-chev">▾</span><span>' + group.title + '</span>'
        + '<span class="gs-group-count">' + group.items.length + '</span>';
      head.addEventListener('click', () => {
        sec.dataset.open = sec.dataset.open === '1' ? '0' : '1';
      });
      sec.appendChild(head);
      const body = document.createElement('div');
      body.className = 'gs-group-body';

      for (const item of group.items) {
        const row = document.createElement('div');
        row.className = 'gs-ctl-item' + (item.select ? ' is-map' : '');
        const label = document.createElement('label');
        label.textContent = item.label;
        label.title = (item.tip || item.label) + ' · 双击复位';
        label.dataset.resetKey = item.key;
        label.addEventListener('dblclick', () => resetOneParam(item.key));

        if (item.select) {
          const sel = document.createElement('select');
          sel.dataset.selectParam = item.key;
          sel.setAttribute('aria-label', item.label);
          for (const [value, text] of item.select) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = text;
            sel.appendChild(opt);
          }
          sel.value = String(state.params[item.key]);
          sel.addEventListener('change', () => {
            state.params[item.key] = sel.value;
            schedule();
            updateDirty();
          });
          row.append(label, sel);
          body.appendChild(row);
          continue;
        }

        const out = document.createElement('output');
        out.dataset.out = item.key;
        out.textContent = fmtValue(item, state.params[item.key]);
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(item.min);
        input.max = String(item.max);
        input.step = String(item.step);
        input.value = String(state.params[item.key]);
        input.dataset.param = item.key;
        input.setAttribute('aria-label', item.label);
        setRangeFill(input);
        input.addEventListener('input', () => {
          state.params[item.key] = Number(input.value);
          out.textContent = fmtValue(item, state.params[item.key]);
          setRangeFill(input);
          schedule();
        });
        row.append(label, out, input);
        body.appendChild(row);
      }
      sec.appendChild(body);
      box.appendChild(sec);
    }
    syncControls();
  }

  function syncControls() {
    $$('[data-param]', $('#gsControls')).forEach((input) => {
      const key = input.dataset.param;
      const item = paramItem(key);
      if (!item) return;
      input.value = String(state.params[key]);
      setRangeFill(input);
      const out = $('[data-out="' + key + '"]', $('#gsControls'));
      if (out) out.textContent = fmtValue(item, state.params[key]);
    });
    $$('[data-select-param]', $('#gsControls')).forEach((sel) => {
      sel.value = String(state.params[sel.dataset.selectParam]);
    });
  }

  function resetOneParam(key) {
    const item = paramItem(key);
    if (!item) return;
    state.params[key] = DEFAULTS[key];
    syncControls();
    schedule();
    updateDirty();
    const out = $('[data-out="' + key + '"]', $('#gsControls'));
    if (out) {
      out.classList.remove('gs-reset-flash');
      void out.offsetWidth;
      out.classList.add('gs-reset-flash');
    }
    toast(item.label + ' 已复位');
  }

  function paramsEqualDefaults() {
    return Object.keys(DEFAULTS).every((k) => state.params[k] === DEFAULTS[k]) && state.mode === (EG && EG.support.lens ? 'lens' : 'frost');
  }

  function presetMatches(preset) {
    if (state.mode !== (preset.mode === 'frost' || !(EG && EG.support.lens) ? 'frost' : 'lens')) return false;
    if (preset.theme && state.theme !== preset.theme) return false;
    return Object.keys(DEFAULTS).every((k) => state.params[k] === preset.params[k]);
  }

  function updateDirty() {
    const tag = $('#gsParamDirty');
    const isDefault = paramsEqualDefaults();
    if (tag) {
      tag.textContent = isDefault ? '默认基线' : '已调校';
      tag.classList.toggle('is-dirty', !isDefault);
    }
    $$('[data-preset]').forEach((btn) => {
      const preset = PRESETS.find((p) => p.id === btn.dataset.preset);
      btn.classList.toggle('is-active', !!preset && presetMatches(preset));
    });
  }

  /* ── 面板渲染 ───────────────────────────────────────────────────────── */
  function miniSpec(t) {
    const spec = createSpecEl({ key: 'mini-' + t.id, x: 450, y: 310, w: t.w, h: t.h, r: t.r, html: t.html }, 'frost');
    spec.classList.add('is-mini');
    spec.style.left = '50%';
    spec.style.top = '50%';
    spec.style.zIndex = '2';
    return spec;
  }

  function renderPalette() {
    const box = $('#gsPalette');
    if (!box) return;
    box.replaceChildren();
    for (const t of TEMPLATES) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'gs-tpl-card';
      card.dataset.gsTemplate = t.id;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-selected', String(state.view === 'single' && state.template === t.id));
      const art = document.createElement('div');
      art.className = 'gs-tpl-art';
      art.style.setProperty('--mini', Math.min(0.34, 124 / t.w, 58 / t.h).toFixed(3));
      art.appendChild(miniSpec(t));
      const name = document.createElement('span');
      name.className = 'gs-tpl-name';
      name.innerHTML = '<b>' + t.label + '</b><small>' + t.hint + '</small>';
      card.append(art, name);
      box.appendChild(card);
    }
    const count = $('#gsTemplateCount');
    if (count) count.textContent = String(TEMPLATES.length);
  }

  function syncPalette() {
    $$('[data-gs-template]', $('#gsPalette')).forEach((card) => {
      card.setAttribute('aria-selected', String(state.view === 'single' && card.dataset.gsTemplate === state.template));
    });
  }

  function renderPresets() {
    const box = $('#gsPresets');
    if (!box) return;
    box.replaceChildren();
    for (const p of PRESETS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gs-preset';
      btn.dataset.preset = p.id;
      btn.style.setProperty('--p', p.color);
      btn.innerHTML = '<i></i>' + p.name;
      btn.title = '应用 ' + p.name + ' 参数';
      box.appendChild(btn);
    }
    updateDirty();
  }

  function renderBackdrops() {
    const box = $('#gsBackdrops');
    if (!box) return;
    box.replaceChildren();
    for (const b of BACKDROPS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gs-backdrop-btn';
      btn.dataset.backdropId = b.id;
      btn.innerHTML = '<i style="--bg:' + b.color + '"></i>' + b.label;
      box.appendChild(btn);
    }
    syncBackdrops();
  }

  function syncBackdrops() {
    $$('[data-backdrop-id]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.backdropId === state.backdrop));
    });
  }

  function renderScenes() {
    const box = $('#gsScenes');
    if (!box) return;
    box.replaceChildren();
    for (const sc of SCENES) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'gs-scene-card';
      card.dataset.scene = sc.id;
      card.style.setProperty('--acc', sc.acc);
      card.style.setProperty('--acc2', sc.acc2);
      card.innerHTML = '<span class="gs-scene-art"><i></i><i></i><i></i></span>'
        + '<span class="gs-scene-name"><b>' + sc.label + '</b><small>' + sc.hint + '</small></span>';
      box.appendChild(card);
    }
    const count = $('#gsSceneCount');
    if (count) count.textContent = String(SCENES.length);
    syncScenes();
  }

  function syncScenes() {
    $$('[data-scene]').forEach((card) => {
      card.classList.toggle('is-active', state.view !== 'single' && card.dataset.scene === state.scene);
    });
  }

  function renderLayers() {
    const box = $('#gsLayerStack');
    if (!box) return;
    box.replaceChildren();
    for (const layer of LAYERS) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'gs-layer-row';
      row.dataset.layer = layer.id;
      row.setAttribute('aria-pressed', String(state.layers[layer.id]));
      row.innerHTML = '<span class="gs-layer-swatch" style="--sw:' + layer.sw + '"></span>'
        + '<b>' + layer.label + '</b><small data-layer-meta="' + layer.id + '">' + layerMeta(layer.id) + '</small>'
        + '<span class="gs-eye" aria-pressed="' + String(state.layers[layer.id]) + '"></span>';
      row.addEventListener('click', () => {
        state.layers[layer.id] = !state.layers[layer.id];
        applyVars();
        syncLayerRows();
        saveState();
      });
      box.appendChild(row);
    }
    syncLayerRows();
  }

  function syncLayerRows() {
    $$('[data-layer]', $('#gsLayerStack')).forEach((row) => {
      const on = !!state.layers[row.dataset.layer];
      row.setAttribute('aria-pressed', String(on));
      row.classList.toggle('is-off', !on);
      const eye = $('.gs-eye', row);
      if (eye) eye.setAttribute('aria-pressed', String(on));
    });
    for (const layer of LAYERS) {
      root.dataset['layer' + layer.id[0].toUpperCase() + layer.id.slice(1)] = state.layers[layer.id] ? '1' : '0';
    }
  }

  function updateSupport() {
    const box = $('#gsSupport');
    if (!box) return;
    const lensOK = !!(EG && EG.support && EG.support.lens);
    const rows = EG ? [
      ['引擎版本', EG.version, true],
      ['真折射', lensOK ? '可用' : '降级磨砂', lensOK],
      ['CSS 解析', EG.support.parse ? '通过' : '不通过', !!EG.support.parse],
      ['引擎族', EG.support.engine ? '通过' : '不通过', !!EG.support.engine],
      ['写回探针', EG.support.probe ? '通过' : '不通过', !!EG.support.probe],
      ['滤镜实例', String(state.insts.length + state.compareInsts.length), true],
      ['贴图生成', state.lastMapMs ? state.lastMapMs + 'ms' : '—', true],
      ['舞台玻璃', String($$('.gs-spec', $('#gsCanvas')).length), true],
    ] : [['引擎', '未加载（只能看 CSS 磨砂）', false]];
    box.replaceChildren();
    for (const [k, v, good] of rows) {
      const line = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = k;
      const span = document.createElement('span');
      span.textContent = v;
      span.className = good ? 'ok' : 'bad';
      line.append(b, span);
      box.appendChild(line);
    }

    const chip = $('#gsEngineChip');
    if (chip) {
      chip.classList.toggle('is-ok', lensOK);
      chip.classList.toggle('is-bad', !lensOK);
      chip.innerHTML = '<i></i>' + (lensOK ? '真折射可用 · Chromium' : '当前环境降级为磨砂');
    }
    const perf = $('#gsPerf');
    if (perf && state.lastBuildMs) perf.textContent = '重建 ' + state.lastBuildMs + 'ms';
  }

  function syncThemeButton() {
    const label = $('[data-theme-label]');
    if (label) label.textContent = state.theme === 'light' ? '深色' : '浅色';
  }

  function syncThemeControls() {
    syncThemeButton();
    syncLayerRows();
    syncBackdrops();
    syncPalette();
    syncScenes();
    syncViewTabs();
  }

  function syncViewTabs() {
    $$('[data-view]').forEach((btn) => {
      btn.setAttribute('aria-selected', String(btn.dataset.view === state.view));
    });
    syncPalette();
    syncScenes();
  }

  /* ── 导出 ───────────────────────────────────────────────────────────── */
  function cssExport() {
    const p = state.params;
    const t = state.view === 'single' ? currentTemplate() : currentScene();
    const tintRgb = getComputedStyle(root).getPropertyValue('--gs-tint-rgb').trim() || '255, 255, 255';
    return [
      '/* Estrella Liquid Glass · ' + (t.label || t.id) + ' · ' + state.mode + ' */',
      ':root {',
      '  --lg-blur: ' + p.blur + 'px;',
      '  --lg-sat: ' + p.saturate + '%;',
      '  --lg-brightness: ' + p.brightness + ';',
      '  --lg-tint: rgba(' + tintRgb + ', ' + p.tint + ');',
      '  --lg-rim: ' + p.rim + ';',
      '  --lg-caustic: ' + p.caustic + ';',
      '  --lg-border: ' + p.border + 'px;',
      '  --lg-shadow: 0 ' + p.shadowY + 'px ' + p.shadowB + 'px -' + p.shadowSpread
        + 'px rgba(49, 68, 108, ' + p.shadowA + ');',
      '}',
      '',
      '.glass {',
      '  border-radius: 24px;',
      '  background: var(--lg-tint);',
      '  backdrop-filter: blur(var(--lg-blur)) saturate(var(--lg-sat)) brightness(var(--lg-brightness));',
      '  box-shadow:',
      '    var(--lg-shadow),',
      '    inset 0 1px 0 rgba(255, 255, 255, var(--lg-rim)),',
      '    inset 0 -12px 20px -16px rgba(255, 255, 255, var(--lg-caustic));',
      '}',
      '',
      '/* 边缘折射贴图按元素尺寸运行时生成，不要把 url(#g-lg-N) 写死。',
      '   真透镜参数（交给 JS 导出里的 EstrellaGlass.make）：',
      JSON.stringify(lensOpts(), null, 2).split('\n').map((line) => '   ' + line).join('\n'),
      '*/',
      '',
      '/* 落到产品：把上面的数值映射进 style.css 的 --c-eg-* 令牌，',
      '   再跑 NODE_OPTIONS= node scripts/check-wb.mjs。 */',
    ].join('\n');
  }

  function jsExport() {
    return [
      '/* 需要先加载 panel/next/glass.js（暴露 window.EstrellaGlass） */',
      'const factory = window.EstrellaGlass;',
      'if (!factory || !factory.support.lens) {',
      '  el.classList.add("frost"); // 降级：CSS backdrop-filter',
      '} else {',
      '  const inst = factory.make(el, ' + JSON.stringify(lensOpts(), null, 2).replace(/\n/g, '\n  ') + ');',
      '  // 参数热更新：inst.set({ scale: -52 }); 尺寸变化后 inst.refresh(true);',
      '}',
      '',
      '/* ' + (state.view === 'single' ? currentTemplate().label : currentScene().label)
        + ' · 拖动/缩放后的布局在 JSON 导出里 */',
    ].join('\n');
  }

  function jsonExport() {
    const specs = specsForCurrent();
    return JSON.stringify({
      version: 2,
      theme: state.theme,
      backdrop: state.backdrop,
      view: state.view,
      scene: state.scene,
      template: state.template,
      mode: state.mode,
      engine: EG ? EG.version : null,
      params: state.params,
      layers: state.layers,
      blur: state.blur,
      specs: specs.map((s) => ({
        key: s.key,
        layout: (() => { const l = getLayout(s); return { x: l.x, y: l.y, w: l.w, h: l.h, r: l.r }; })(),
      })),
    }, null, 2);
  }

  function currentExport() {
    if (state.exportTab === 'js') return { text: jsExport(), ext: 'js', lang: 'JS' };
    if (state.exportTab === 'json') return { text: jsonExport(), ext: 'json', lang: 'JSON' };
    return { text: cssExport(), ext: 'css', lang: 'CSS' };
  }

  function updateExport() {
    const pre = $('#gsCode');
    const meta = $('#gsExportMeta');
    if (!pre) return;
    const out = currentExport();
    pre.textContent = out.text;
    if (meta) {
      const lines = out.text.split('\n').length;
      meta.textContent = out.lang + ' · ' + lines + ' 行 · ' + new Blob([out.text]).size + ' B';
    }
  }

  function copyText(text, btn) {
    const done = () => {
      if (!btn) return;
      const old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = old; }, 900);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* 浏览器禁止复制时静默 */ }
    ta.remove();
  }

  function downloadExport(btn) {
    const out = currentExport();
    const blob = new Blob([out.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'estrella-glass.' + out.ext;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已下载 ' + a.download);
    if (btn) btn.blur();
  }

  /* ── 渐进模糊弹层 ───────────────────────────────────────────────────── */
  function applyBlurTune() {
    const scrim = $('#gsScrim');
    if (!scrim) return;
    scrim.style.setProperty('--gsc-b1', (4 * state.blur.strength).toFixed(1) + 'px');
    scrim.style.setProperty('--gsc-b2', (9 * state.blur.strength).toFixed(1) + 'px');
    scrim.style.setProperty('--gsc-b3', (16 * state.blur.strength).toFixed(1) + 'px');
    scrim.dataset.layers = String(state.blur.layers);
    scrim.classList.toggle('is-flat', state.blur.flat || state.blur.opaque);
    const out = $('#gsBlurOut');
    if (out) out.textContent = state.blur.strength.toFixed(1) + '×';
    const sel = $('[data-blur="layers"]');
    if (sel) sel.value = String(state.blur.layers);
    const range = $('[data-blur="strength"]');
    if (range) range.value = String(state.blur.strength);
    const modal = $('#gsModalBox');
    if (modal) modal.classList.toggle('is-opaque', state.blur.opaque);
  }

  function syncModal() {
    const scrim = $('#gsScrim');
    const box = $('#gsModalBox');
    if (!scrim || !box) return;
    const r = box.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    scrim.style.setProperty('--gsc-cx', cx + 'px');
    scrim.style.setProperty('--gsc-cy', cy + 'px');
    scrim.style.setProperty('--gsc-rx2', Math.max(320, r.width / 2 + Math.min(innerWidth, 1440) * 0.26) + 'px');
    scrim.style.setProperty('--gsc-ry2', Math.max(240, r.height / 2 + innerHeight * 0.24) + 'px');
    scrim.style.setProperty('--gsc-rx3', Math.max(220, r.width / 2 + Math.min(innerWidth, 1440) * 0.1) + 'px');
    scrim.style.setProperty('--gsc-ry3', Math.max(180, r.height / 2 + innerHeight * 0.09) + 'px');
    scrim.dataset.layers = String(state.blur.layers);
  }

  function syncModalRows() {
    const rows = $$('.gs-modal-row');
    const values = [
      state.mode === 'lens',
      !state.blur.flat,
      state.blur.opaque,
    ];
    rows.forEach((row, i) => {
      const on = !!values[i];
      row.classList.toggle('is-on', on);
      row.classList.toggle('is-off', !on);
      const sw = $('.gs-switch', row);
      if (sw) sw.setAttribute('aria-checked', String(on));
    });
  }

  function openModal() {
    const scrim = $('#gsScrim');
    const modal = $('#gsModal');
    if (!scrim || !modal) return;
    closeHelp();
    syncModalRows();
    applyBlurTune();
    modal.hidden = false;
    scrim.hidden = false;
    syncModal();
    requestAnimationFrame(() => scrim.classList.add('on'));
    if (typeof ResizeObserver !== 'undefined') {
      if (modalRO) modalRO.disconnect();
      modalRO = new ResizeObserver(syncModal);
      modalRO.observe($('#gsModalBox'));
    }
    window.addEventListener('resize', syncModal);
  }

  function closeModal() {
    const scrim = $('#gsScrim');
    const modal = $('#gsModal');
    if (!scrim || !modal) return;
    scrim.classList.remove('on');
    scrim.hidden = true;
    modal.hidden = true;
    const box = $('#gsModalBox');
    if (box) { box.style.transform = ''; box.style.opacity = ''; }
    if (modalRO) { modalRO.disconnect(); modalRO = null; }
    window.removeEventListener('resize', syncModal);
  }

  function bindModalControls() {
    const grab = $('#gsModalGrab');
    if (grab) {
      grab.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const box = $('#gsModalBox');
        if (!box) return;
        const sy = e.clientY;
        modalDrag = { sy, dy: 0 };
        const move = (ev) => {
          if (!modalDrag) return;
          modalDrag.dy = Math.max(0, ev.clientY - modalDrag.sy);
          box.style.transform = 'translateY(' + modalDrag.dy + 'px)';
          box.style.opacity = String(clamp(1 - modalDrag.dy / 420, 0.35, 1));
          syncModal();
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          const dy = modalDrag ? modalDrag.dy : 0;
          modalDrag = null;
          if (dy > 110) closeModal();
          else if (box) { box.style.transform = ''; box.style.opacity = ''; syncModal(); }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    }

    const layerSel = $('[data-blur="layers"]');
    if (layerSel) layerSel.addEventListener('change', () => {
      state.blur.layers = Number(layerSel.value);
      applyBlurTune();
      syncModal();
      saveState();
    });
    const strength = $('[data-blur="strength"]');
    if (strength) strength.addEventListener('input', () => {
      state.blur.strength = Number(strength.value);
      applyBlurTune();
      syncModal();
      saveState();
    });

    $$('.gs-modal-row').forEach((row, index) => {
      row.addEventListener('click', () => {
        const on = !row.classList.contains('is-on');
        row.classList.toggle('is-on', on);
        row.classList.toggle('is-off', !on);
        const sw = $('.gs-switch', row);
        if (sw) sw.setAttribute('aria-checked', String(on));
        if (index === 0) {
          state.mode = on ? (EG && EG.support.lens ? 'lens' : 'frost') : 'frost';
          rebuildStage();
        } else if (index === 1) {
          state.blur.flat = !on;
          applyBlurTune();
          syncModal();
        } else {
          state.blur.opaque = on;
          applyBlurTune();
          syncModal();
        }
        saveState();
      });
      const sw = $('.gs-switch', row);
      if (sw) sw.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
      });
    });
  }

  /* ── 帮助 / 提示 ────────────────────────────────────────────────────── */
  function bindGooey() {
    const stage = $('#gsGooeyStage');
    const blob = $('#gsGooeyBlob');
    if (!stage || !blob) return;
    const set = (dx, dy) => {
      blob.style.setProperty('--gx', dx.toFixed(1));
      blob.style.setProperty('--gy', dy.toFixed(1));
    };
    stage.addEventListener('pointermove', (e) => {
      const sr = stage.getBoundingClientRect();
      const cx = sr.left + blob.offsetLeft + blob.offsetWidth / 2;
      const cy = sr.top + blob.offsetTop + blob.offsetHeight / 2;
      set(clamp((e.clientX - cx) * 0.6, -170, 170), clamp((e.clientY - cy) * 0.6, -70, 70));
    });
    stage.addEventListener('pointerleave', () => set(0, 0));
  }

  function toggleHelp() {
    const help = $('#gsHelp');
    if (!help) return;
    help.hidden = !help.hidden;
    if (!help.hidden && !$('#gsModal').hidden) closeModal();
  }
  function closeHelp() {
    const help = $('#gsHelp');
    if (help) help.hidden = true;
  }
  function toast(msg) {
    const el = $('#gsToast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-on'), 1800);
  }
  function dimHint() {
    const hint = $('#gsCanvasHint');
    if (!hint) return;
    hint.classList.add('is-dim');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.remove('is-dim'), 1600);
  }

  /* ── 全屏 ───────────────────────────────────────────────────────────── */
  function toggleFullscreen() {
    const panel = $('#gsStagePanel');
    if (!panel) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    if (panel.requestFullscreen) {
      panel.requestFullscreen().catch(() => toast('当前浏览器不允许全屏'));
    } else {
      toast('当前浏览器不支持全屏');
    }
  }

  /* ── 事件接线 ───────────────────────────────────────────────────────── */
  function bindEvents() {
    document.addEventListener('click', (e) => {
      const tplCard = e.target.closest('[data-gs-template]');
      if (tplCard) { setTemplate(tplCard.dataset.gsTemplate); return; }
      const sceneCard = e.target.closest('[data-scene]');
      if (sceneCard) { setScene(sceneCard.dataset.scene); return; }
      const preset = e.target.closest('[data-preset]');
      if (preset) { applyPreset(preset.dataset.preset); return; }
      const backdrop = e.target.closest('[data-backdrop-id]');
      if (backdrop) { setBackdrop(backdrop.dataset.backdropId); return; }
      const view = e.target.closest('[data-view]');
      if (view) { setView(view.dataset.view); return; }
      const exportTab = e.target.closest('[data-export]');
      if (exportTab) {
        state.exportTab = exportTab.dataset.export;
        $$('[data-export]').forEach((b) => b.setAttribute('aria-selected', String(b === exportTab)));
        updateExport();
        return;
      }
      const act = e.target.closest('[data-gs]');
      if (act) {
        const a = act.dataset.gs;
        if (a === 'theme') toggleTheme();
        else if (a === 'help') toggleHelp();
        else if (a === 'fullscreen') toggleFullscreen();
        else if (a === 'openModal') openModal();
        else if (a === 'closeModal') closeModal();
        else if (a === 'grid') {
          state.grid = !state.grid;
          $('#gsGrid').hidden = !state.grid;
          $$('[data-gs="grid"]').forEach((b) => b.setAttribute('aria-pressed', String(state.grid)));
        } else if (a === 'explode') {
          state.explode = !state.explode;
          root.dataset.explode = state.explode ? '1' : '0';
          $$('[data-gs="explode"]').forEach((b) => b.setAttribute('aria-pressed', String(state.explode)));
          if (state.explode && !state.selected) {
            const first = specsForCurrent()[0];
            if (first) select(first.key);
            toast('已拆层：拖动玻璃单独看每一层');
          }
        } else if (a === 'zoom') {
          const zooms = [1, 1.25, 1.5, 0.75];
          const idx = zooms.indexOf(state.zoom);
          state.zoom = zooms[(idx + 1) % zooms.length];
          updateFit();
          saveState();
          toast('舞台缩放 ' + Math.round(state.zoom * 100) + '%');
        } else if (a === 'gooey') {
          const stage = $('#gsGooeyStage');
          if (!stage) return;
          const on = stage.dataset.gooey !== 'on';
          stage.dataset.gooey = on ? 'on' : 'off';
          act.setAttribute('aria-pressed', String(on));
          act.textContent = on ? '融合：开' : '融合：关';
        } else if (a === 'resetLayout') resetCurrentLayout();
        else if (a === 'resetAll') resetAll();
        else if (a === 'copy') copyText(currentExport().text, act);
        else if (a === 'download') downloadExport(act);
        return;
      }
      if (e.target.closest('#gsHelp') && !e.target.closest('.gs-help-card')) closeHelp();
    });

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', pointerMoveHandler);
    document.addEventListener('pointerup', pointerUpHandler);
    document.addEventListener('pointercancel', pointerUpHandler);

    $('#gsCanvas').addEventListener('dblclick', (e) => {
      const spec = e.target.closest('.gs-spec');
      if (spec) {
        e.preventDefault();
        select(spec.dataset.key);
        resetSpecLayout(spec.dataset.key);
      }
    });

    $('#gsCanvas').addEventListener('wheel', (e) => {
      if (!e.altKey) return;
      const specEl = e.target.closest('.gs-spec');
      if (!specEl) return;
      e.preventDefault();
      const spec = state.specDefs.get(specEl.dataset.key);
      if (!spec) return;
      const base = getLayout(spec);
      const factor = e.deltaY < 0 ? 1.04 : 0.96;
      const nw = clamp(base.w * factor, 56, DESIGN.w - 24);
      const nh = clamp(base.h * (nw / base.w), 36, DESIGN.h - 24);
      const capsule = base.r >= Math.min(base.w, base.h) / 2 - 0.6;
      const r = capsule ? Math.min(nw, nh) / 2 : base.r * (nw / base.w);
      select(spec.key);
      updateSelectedLayout(spec, { x: base.x, y: base.y, w: nw, h: nh, r });
      saveState();
      dimHint();
    }, { passive: false });

    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'select', 'textarea'].includes(tag)) return;
      if (e.key === 'Escape') {
        if (!$('#gsHelp').hidden) { closeHelp(); return; }
        if (!$('#gsModal').hidden) { closeModal(); return; }
        if (state.selected) { select(null); return; }
      }
      if (e.key === '?' && !e.metaKey && !e.ctrlKey) { toggleHelp(); return; }
      if (!state.selected) return;
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const dir = arrows[e.key];
      if (!dir) return;
      e.preventDefault();
      const spec = state.specDefs.get(state.selected);
      if (!spec) return;
      const base = getLayout(spec);
      const step = e.shiftKey ? 10 : 2;
      const c = clampCenter(base.x + dir[0] * step, base.y + dir[1] * step, base.w, base.h);
      updateSelectedLayout(spec, { x: c.x, y: c.y, w: base.w, h: base.h, r: base.r });
      saveState();
      dimHint();
    });

    window.addEventListener('resize', () => {
      updateFit();
      if (!$('#gsModal').hidden) syncModal();
    });
    document.addEventListener('fullscreenchange', () => requestAnimationFrame(updateFit));
  }

  function init() {
    loadState();
    root.dataset.theme = state.theme;
    root.dataset.backdrop = state.backdrop;
    root.dataset.explode = '0';
    syncThemeButton();
    renderBackdrops();
    renderPresets();
    renderPalette();
    renderScenes();
    renderLayers();
    buildControls();
    applyVars();
    applyBlurTune();
    rebuildStage();
    bindEvents();
    bindModalControls();
    bindGooey();
    syncControls();
    updateDirty();
    updateExport();
    updateMapPreview();
    const hint = $('#gsCanvasHint');
    if (hint) hintTimer = setTimeout(() => hint.classList.add('is-dim'), 7000);

    window.__glassLab = {
      state,
      templates: TEMPLATES.length,
      scenes: SCENES.length,
      presets: PRESETS.length,
      openModal,
      closeModal,
      rebuildStage,
      select,
      setView,
      setScene,
      setTemplate,
      setBackdrop,
      setTheme,
      applyPreset,
      resetAll,
      probe: () => ({
        engine: EG ? EG.version : null,
        support: EG ? EG.support : null,
        mode: state.mode,
        view: state.view,
        scene: state.scene,
        template: state.template,
        specs: $$('.gs-spec', $('#gsCanvas')).length,
        miniSpecs: $$('.gs-spec', $('#gsPalette')).length,
        lensInstances: state.insts.length + state.compareInsts.length,
        selected: state.selected,
        scrimHidden: $('#gsScrim') ? $('#gsScrim').hidden : null,
        fit: state.fit,
        lastBuildMs: state.lastBuildMs,
        lastMapMs: state.lastMapMs,
      }),
    };
  }

  init();
})();
