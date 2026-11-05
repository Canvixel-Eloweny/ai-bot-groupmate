/**
 * 批 B10（扩展宿主缺口）定向变异（2026-11-03 · 群友报告 BUG-13 / MIG-02/03/07）。
 *
 * 这批修的是"权限表先于实现存在"与"旧名字被当拼错拒掉"两类名实不符：
 *   · `storage` 挂在 PERMISSION_NAMES 里、也写进了给作者看的创作提示词，宿主却没实现
 *     ⇒ 包按文档写 `api.storage.get(k)` 得到 `Cannot read properties of undefined`，
 *     报错指向"包写错了"，真正坏的是宿主。
 *   · `cross_send` / `local_service` 这些**名字没写错、宿主确实没有**的，
 *     被报成"声明了不认识的权限" ⇒ 把人带去查错方向。
 *   · 社区包注册的 `incoming-message` / `message` 被当未知钩子点拒掉 ⇒ 包永远是死的，
 *     表现只是"装了没反应"。
 *
 * ⚠️ 每条都打在"接线"上而不是"函数存在"上 —— 本项目头号失败形状是"写了没人读"：
 *    纯函数与判据可以全对，只要宿主没注入，用户拿到的还是 undefined。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/ext-host-b10-1104.mjs
 */

const HOST = 'src/plugin-host.js';
const API = 'src/plugin-api.js';
const BUS = 'src/hook-bus.js';
const STORE = 'src/ext-storage.js';

export default [
  {
    id: 'X1',
    note: '宿主不再注入 storage（buildApi 收不到）—— §扩展包宿主⑪ 必须变红：函数在、但包拿不到',
    file: HOST,
    anchor: /storage: extStorage,/g,
    count: 1,
    apply: (s) => s.replace('        storage: extStorage,\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'X2',
    note: '宿主不再给 dataDir —— §扩展包宿主⑪ 必须变红：包只能自己猜布局（便携布局下"它说没有数据"）',
    file: HOST,
    anchor: /dataDir: path\.join\(root, 'data', 'ext', String\(p\.id \?\? ''\)\),/g,
    count: 1,
    apply: (s) => s.replace("        dataDir: path.join(root, 'data', 'ext', String(p.id ?? '')),\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'X3',
    note: 'api.storage 换个名字赋值（权限表仍写着 storage）—— §⑪ 必须变红：名实不符复活',
    file: API,
    anchor: /api\.storage = wired/g,
    count: 1,
    apply: (s) => s.replace('api.storage = wired', 'api.storageV2 = wired'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'X4',
    note: '存储写盘退回普通覆盖写 —— §⑪ 必须变红：崩溃留半截 JSON，包"以为状态被清空"',
    file: STORE,
    anchor: /writeJsonAtomic\(f, m, \{ mode: 0o600 \}\);/g,
    count: 1,
    apply: (s) => s.replace(
      '        writeJsonAtomic(f, m, { mode: 0o600 });',
      "        fs.writeFileSync(f, JSON.stringify(m), { mode: 0o600 });",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'X5',
    note: '清空钩子别名表 —— §⑫ 必须变红：社区包的 incoming-message 重新被当"未知钩子点"拒掉',
    file: BUS,
    anchor: /export const HOOK_POINT_ALIASES = Object\.freeze\(\{[\s\S]*?\}\);/g,
    count: 1,
    apply: (s) => s.replace(
      /export const HOOK_POINT_ALIASES = Object\.freeze\(\{[\s\S]*?\}\);/,
      'export const HOOK_POINT_ALIASES = Object.freeze({});',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'X6',
    note: '别名告警里去掉"不代答"那句 —— §⑫ 必须变红：命令型包以为接上了，仍是静默不生效',
    file: BUS,
    anchor: /'该点只通知、不代答（return 的 handled\/reply 不会被消费）/g,
    count: 1,
    apply: (s) => s.replace(
      "'该点只通知、不代答（return 的 handled/reply 不会被消费），所以命令型包仍需宿主接进主链路'",
      "'已接到本宿主的钩子点'",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
