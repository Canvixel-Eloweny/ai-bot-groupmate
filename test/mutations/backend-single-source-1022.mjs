/**
 * 能力清单单源（2026-10-22）的变异清单。
 *
 * `UNTRUSTED_CAN_SEND` 原先在 registry.js 定义后无人使用，normalize.js 又写了一份
 * 同样的字面量；check-backend 还把字面量钉住。修复后只许从 registry 取。
 *
 * 这条变异把 normalize 改回字面量，check-backend 必须变红。
 *
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/backend-single-source-1022.mjs`
 * ⚠️ 串行；会改写真实工作树。
 */

const FILE = 'src/backend/normalize.js';
const ANCHOR = /canSend:\s*\{\s*\.\.\.UNTRUSTED_CAN_SEND\s*\},/;

export default [
  {
    id: 'M1',
    note: '把 capabilitiesOf 的 canSend 改回本地字面量 —— check-backend 的单源判据必须变红。预期 BLOCKED',
    file: FILE,
    anchor: ANCHOR,
    count: 1,
    apply: (s) => s.replace(ANCHOR, "canSend: { image: 'yes', record: 'yes' },"),
    layer: 'backend',
    expect: 'BLOCKED',
  },
];
