/**
 * 全局光标跟随层（§168 · 2026-10-28）的变异清单 —— 纯数据。
 * 跑法：
 *   NODE_OPTIONS= node scripts/mutate-lint.mjs
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/cursor-follow-2026-10-28.mjs --layer check-wb
 * 纪律：anchor 必须在 pristine 文件里**恰好命中 count 次**；apply 必须返回不同且语法合法的内容。
 * ⚠️ 跑之前先本地提交（干净树），且串行；跑时不许编辑被测文件。
 */
const CSS = 'panel/next/cursor-follow.css';
const JS = 'panel/next/cursor-follow.js';
const FF = 'panel/next/factory-frame.js';

export default [
  {
    id: 'M1',
    note: '跟随层 z-index 掉到 38（被顶栏/工厂盖住）—— §168③ 必须变红。预期 BLOCKED',
    file: CSS,
    anchor: /z-index: 81;/,
    count: 1,
    apply: (s) => s.replace(/z-index: 81;/, 'z-index: 38;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '根层 pointer-events 改成 auto（整层吞掉点击）—— §168③ 必须变红。预期 BLOCKED',
    file: CSS,
    anchor: /z-index: 81;\n  pointer-events: none;/,
    count: 1,
    apply: (s) => s.replace(
      /z-index: 81;\n  pointer-events: none;/,
      'z-index: 81;\n  pointer-events: auto;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '启动门槛只留 !!M（减弱动效/触屏不再禁用）—— §168⑤ 必须变红。预期 BLOCKED',
    file: JS,
    anchor: /var enabled = !M\.reducedMotion\(\) && !coarse;/,
    count: 1,
    apply: (s) => s.replace(
      /var enabled = !M\.reducedMotion\(\) && !coarse;/,
      'var enabled = !!M;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '钳制条件恒假（环会甩出一条长尾巴）—— §168⑥ 必须变红。预期 BLOCKED',
    file: JS,
    anchor: /if \(d > MAX_LAG\)/,
    count: 1,
    apply: (s) => s.replace(/if \(d > MAX_LAG\)/, 'if (false && d > MAX_LAG)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '删掉工厂帧的 attachFrame 调用（三个工厂页失去跟随）—— §168⑦ 必须变红。预期 BLOCKED',
    file: FF,
    anchor: /window\.CursorFollow\?\.attachFrame\?\.\(frame\)/,
    count: 1,
    apply: (s) => s.replace(/window\.CursorFollow\?\.attachFrame\?\.\(frame\)/, 'void 0'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
