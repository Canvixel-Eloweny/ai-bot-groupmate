/**
 * §133「模型与消息可靠性」的定向变异（2026-10-22）。
 *
 * 每条只打一个失效面；全部 BLOCKED 才说明 §133 不是假绿。
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/message-reliability-1022.mjs`
 * ⚠️ 串行；会改写真实工作树。
 */
export default [
  {
    id: 'R1',
    note: '入站群图不再读本地文件 —— §133① 必须变红'
      + '（Windows 群图仍会在采集阶段丢失）。预期 BLOCKED',
    file: 'src/onebot.js',
    anchor: /localImageToDataUrl\(rawFile \|\| rawUrl\)/,
    count: 1,
    apply: (s) => s.replace('localImageToDataUrl(rawFile || rawUrl)', "''"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R2',
    note: '引用消息不再补取 get_msg —— §133② 必须变红'
      + '（引用图/引用文字仍然看不见）。预期 BLOCKED',
    file: 'src/index.js',
    anchor: /bot\.call\('get_msg', \{ message_id: Number\(parsed\.replyTo\) \}/,
    count: 1,
    apply: (s) => s.replace(
      "bot.call('get_msg', { message_id: Number(parsed.replyTo) }",
      "bot.call('get_msg_x', { message_id: Number(parsed.replyTo) }"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R3',
    note: '空回复不再按 finish_reason=length 重试 —— §133③ 必须变红'
      + '（思考型模型仍会"花了钱没回复"）。预期 BLOCKED',
    file: 'src/llm.js',
    anchor: /finishReason === 'length'/,
    count: 1,
    apply: (s) => s.replace("finishReason === 'length'", "finishReason === 'mutated'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R4',
    note: '记忆判断额度退回 160 —— §133④ 必须变红'
      + '（关不掉思考的模型会把额度吃空）。预期 BLOCKED',
    file: 'src/memory.js',
    anchor: /maxTokens: 2000/,
    count: 1,
    apply: (s) => s.replace('maxTokens: 2000', 'maxTokens: 160'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R5',
    note: '新装默认 maxTokens 退回 400 —— §133⑤ 必须变红'
      + '（新用户仍会踩空回复）。预期 BLOCKED',
    file: 'src/config.js',
    anchor: /asInt\(raw\.llm\?\.maxTokens, 1200\)/,
    count: 1,
    apply: (s) => s.replace('asInt(raw.llm?.maxTokens, 1200)', 'asInt(raw.llm?.maxTokens, 400)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
