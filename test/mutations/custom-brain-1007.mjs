/**
 * 自定义大脑的变异清单。2026-10-07。
 * ══════════════════════════════════════════════════════════════════════════
 *  这一批打的是：**用户自己填的那套大脑，会不会悄悄变成"配了但不生效"。**
 *
 *  | 条 | 打的是                                            | 该由谁拦住 | 期望    |
 *  |----|---------------------------------------------------|-----------|---------|
 *  | M1 | 坏条目（缺地址 / 缺模型名）**不再被丢弃**          | smoke     | BLOCKED |
 *  | M2 | 物化时不带 `declaredFeatures`（用户勾的能力全失效）| smoke     | BLOCKED |
 *  | M3 | 没勾"能思考"时不再强制关思考（乱发思考参数）       | smoke     | BLOCKED |
 *
 *  ## 为什么只打这三条
 *
 *  每一条都是一个"**不报错、但用户明显受损**"的失效形态：
 *
 *    · M1 —— 坏条目留在列表里的症状是：点下去得到一个看不懂的 fetch 失败，
 *      而列表上它和其它套长得一模一样。丢掉**并说出来**是唯一的解。
 *    · M2 —— 这是本批**最要紧的一条**：`declaredFeatures` 是唯一把"用户勾了什么"
 *      带到 `src/llm.js` 的通道。它一断，用户勾的"能看图"立刻失效，
 *      界面上却还显示着已开启 —— 两端看起来都正常。
 *    · M3 —— 各家思考参数的写法互不相同。对没勾思考的自建网关乱发参数，
 *      后果是一个 400 把整条请求废掉（而 400 不属于可重试错误，降级链会当场断）。
 *
 *  ## ⚠️ 没打的两条（写在这里，免得下一个人再试一遍）
 *
 *    · **"Key 留空时保留原值"那条没打。** 试过：把 `brain.apiKey || cfg.llm.apiKey`
 *      改成 `brain.apiKey` ⇒ T382 **确实会红**。但那条变异与 M2 打的是同一个函数
 *      的相邻两行，拦住的原因高度重叠，多一条只是重复计数器 ——
 *      这种"能拦住但只是再确认一遍"的条目**不算验收**，留在文档里比塞进清单诚实。
 *    · **界面上的"只显示勾过的"没打。** 它落在前端（`schema.js` 的 `when`），
 *      而前端不在变异四层里（本项目的既有边界）。它的证据是浏览器侧的 `verify.mjs`。
 *
 *  ⚠️ 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/custom-brain-1007.mjs`
 */

export default [
  {
    id: 'M1',
    file: 'src/custom-brain.js',
    anchor: /if \(!one\) \{ dropped\.push\(id\); continue; \}/,
    count: 1,
    // 坏条目也照收 ⇒ 列表里多出一个点不动的套（点下去是看不懂的 fetch 失败）
    apply: (src) => src.replace(
      'if (!one) { dropped.push(id); continue; }',
      'if (!one) { brains[id] = raw; continue; }'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: '坏条目不再丢弃 ⇒ 列表里混进点不动的套，而它和其它套长得一模一样（"我明明保存了"反过来变成"保存了却不能用"）',
  },
  {
    id: 'M2',
    file: 'src/custom-brain.js',
    anchor: /cfg\.llm\.declaredFeatures = declaredFeaturesOf\(brain\);/,
    count: 1,
    apply: (src) => src.replace('cfg.llm.declaredFeatures = declaredFeaturesOf(brain);', ''),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: '★ 物化不带 declaredFeatures ⇒ 用户勾的能力全部失效（界面仍显示已开启），两端看起来都正常',
  },
  {
    id: 'M3',
    file: 'src/custom-brain.js',
    anchor: /if \(!brain\.features\?\.thinking\) cfg\.llm\.thinking = \{ mode: 'off', level: 'medium' \};/,
    count: 1,
    apply: (src) => src.replace(
      "if (!brain.features?.thinking) cfg.llm.thinking = { mode: 'off', level: 'medium' };",
      ''
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: '没勾"能思考"却不再强制关 ⇒ 对自建网关乱发思考参数，400 会废掉整条请求（且不属于可重试错误）',
  },
];
