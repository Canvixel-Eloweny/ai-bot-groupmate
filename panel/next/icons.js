/* ══════════════════════════════════════════════════════════════════════════
   icons.js · 零依赖图标系统
   ──────────────────────────────────────────────────────────────────────────
   内联 SVG 图标集，**不引任何图标库**。理由（2026-10-02 实测后的决定）：

   · `lucide` / `tabler` 等图标库是 npm 包 —— 本项目**零构建**（无打包器，
     `package.json` 依赖只有 `ws`），引包要么破坏"改完刷新即生效"，要么引入构建步骤。
   · `morphicons` 的主入口是 **React / Vue / Svelte 组件**，且图标**数据**要另拉
     （@iconify）。它很优秀（6.5KB / 零运行时依赖 / 闭式最优旋转），
     但对"零构建的原生页面"来说是错的形态。⇒ **取它的算法，不取它的包。**

   ── 形态约定 ──────────────────────────────────────────────────────────
   ① **24×24 网格、stroke 图标**（Lucide 网格）。所有图标共用同一坐标系 ——
      这是图标能**互相变形**的前提（morph.js 的 2D Procrustes 要求同网格）。
   ② 路径是 **数据**（`d` 字符串数组），不是组件。变形算法需要直接操作顶点。
   ③ **颜色用 `currentColor`**，不写死色值 —— 沿用style.css 的纪律 ①，
      跟主题走。
   ④ `stroke-width: 2` / `stroke-linecap: round` / `stroke-linejoin: round`
     是 Lucide 的标准参数，写在 `ICONS_ATTRS` 里**只出现一次**。

   ── 依赖：零。属依赖图最底层（同 motion.js 的 L0）。
   ══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* Lucide 标准描边参数。**只在这里写一次** ——
     每个图标自带一份的话，改一次视觉要动几十处。 */
  var STROKE_ATTRS = {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round'
  };

  /* ══ 图标表 ════════════════════════════════════════════════════════════
     每项是**顶点序列**（不是单个 d 字符串）：变形需要逐段对应，
     合成一个 d 反而丢了分段信息。

     ⚠️ 命名不按图标库的原名，而是按**这个面板里它在说什么**命名。
        `bot` 而不是 `robot-head`—— 名字要能被 schema 直接读懂，
        那是它的唯一用途。 */
  var ICONS = {
    /* ── 进程与身份 ── */
    bot: [
      'M12 2a2 2 0 0 0-2 2v1H8a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2V4a2 2 0 0 0-2-2Z',
      'M9 10.5h.01M15 10.5h.01M9 15h6'
    ],
    /* 身份：单个人形（登录账号用） */
    user: [
      'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2',
      'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z'
    ],
    /* 多个实例（"几个"） */
    layers: [
      'M12 2 2 7l10 5 10-5-10-5Z',
      'm2 17 10 5 10-5', 'm2 12 10 5 10-5'
    ],

    /* ── 容器与网络 ── */
    container: [
      'M4 5h16v14H4z', 'M9 5v14', 'M15 5v14', 'M4 10h16', 'M4 14h16'
    ],
    /* 网络端口（比 icon "globe" 更贴"端口通不通"） */
    network: [
      'M9 2v6M15 2v6', 'M7 8h10v4a5 5 0 0 1-10 0V8Z', 'M12 17v5'
    ],
    /* 面板（控制台自身） */
    monitor: [
      'M3 4h18v12H3z', 'M8 20h8', 'M12 16v4'
    ],

    /* ── 状态与动作 ── */
    play:['M6 4l14 8-14 8V4Z'],
    stop: ['M6 6h12v12H6z'],
    power: [
      'M12 3v9', 'M6.5 6.5a8 8 0 1 0 11 0'
    ],
    /* 「三步链路」：面板里那条启动链路 */
    link: [
      'M9 17H7A5 5 0 0 1 7 7h2', 'M15 7h2a5 5 0 0 1 0 10h-2',
      'M8 12h8'
    ],
    clock: [
      'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'
    ],
    /* 排查类动作：放大镜 */
    search: [
      'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'm20 20-4-4'
    ],
    reload: [
      'M21 12a9 9 0 1 1-3-6.7', 'M21 4v5h-5'
    ],
    list: [
      'M8 6h13M8 12h13M8 18h13', 'M3.5 6h.01M3.5 12h.01M3.5 18h.01'
    ],
    warn: [
      'M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z',
      'M12 9v4', 'M12 17h.01'
    ],
    moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z'],
    sun: [
      'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z',
      'M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4'
    ],
    /* 危险 */
    alert: [
      'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 8v5', 'M12 16h.01'
    ],
    /* 睡眠（作息那行用） */
    bed: [
      'M3 18v-6h18v6', 'M3 12V7', 'M7 10h3v2H7z', 'M3 18h18'
    ],
    /* 设置类（键） */
    key: [
      'M15.5 9.5a3.5 3.5 0 1 1-3.4 3.5c0-.2 0-.3.1-.5L3 22v-3h3v-2h2v-2l6.6-6.6c.2-.1.5-.1.9-.1Z'
    ],
    memory: [
      'M4 6h16v12H4z', 'M8 10v4', 'M11 10v4', 'M14 10v4', 'M17 10v4'
    ],
    check: ['m5 13 4 4L19 7']
  };

  /* ══ 渲染 ══════════════════════════════════════════════════════════════ */

  /**
   * 生成一个图标元素。
   * @param {string} name  图标名（不在表里 → 返回空字符串，不抛）
   * @param {object} [opt]
   * @param {number} [opt.size=20]边长
   * @param {string} [opt.cls]    额外 class
   * @param {string} [opt.style]  内联样式（少用；优先靠 CSS）
   */
  function icon(name, opt) {
    opt = opt || {};
    var paths = ICONS[name];
    if (!paths) {
      // ⚠️ 未知图标**静默返回空**而不是抛：缺一个图标不该让整页白屏。
      //    真要排查就查这里（verify.mjs 有一条断言在核对本表用到的名字都存在）。
      return '';
    }
    var size = opt.size || 20;
    var cls = 'ico' + (opt.cls ? ' ' + opt.cls : '');
    /* ⚠️ 描边参数必须真的写到 SVG 上（2026-10-04 修）：STROKE_ATTRS 曾是
       "定义了但没人消费" —— SVG 的默认 fill 是 black、默认无 stroke，
       于是所有图标被渲染成**实心色块**（月亮成实心团、太阳成实心圆盘），
       而"描边风格"是本文件头号形态约定（约定①④）。
       挂在 <svg> 层让 <path> 继承，与 morph.js 的 setAttribute 同一形态。 */
    var attrs = '';
    for (var k in STROKE_ATTRS) attrs += ' ' + k + '="' + STROKE_ATTRS[k] + '"';
    var s = '<svg class="' + cls + '" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" aria-hidden="true" focusable="false"' + attrs +
      (opt.style ? ' style="' + opt.style + '"' : '') + '>';
    for (var i = 0; i < paths.length; i++) {
      s += '<path d="' + paths[i] + '"/>';
    }
    s += '</svg>';
    return s;
  }

  /** 图标名 → 路径数组。变形动画要**数据**，不要元素。 */
  function iconPaths(name) {
    return ICONS[name] || null;
  }

  /** 这个名字有没有图标（给 verify 的断言用，避免它在页面里找）。 */
  function has(name) { return !!ICONS[name]; }

  global.Icons = {
    icon: icon,
    iconPaths: iconPaths,
    has: has,
    NAMES: Object.keys(ICONS),
    SIZE: 24
  };
})(typeof window !== 'undefined' ? window : globalThis);
