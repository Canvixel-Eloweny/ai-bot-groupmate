/**
 * 离线演示快照 —— **只在连不上后端时使用**。
 *
 * 为什么要有它：这一页要能双击打开（`file://`）就看见完整结构，而不是一片"读取中"。
 * 但**任何写操作都不会落到这里** —— 演示模式下点保存 / 启动，页面只会如实说
 * "未连接后端"，不会假装成功（假装成功正是本项目最怕的那种"改了没落地"）。
 *
 * ⚠️ 体积刻意压到最小：只保留**渲染骨架需要的形状**，不含任何真实群号 / QQ 号 / Key。
 *    字段名与 `panel/server.js` 的 `collectState()` 一一对应；形状对不上时
 *    渲染器会显示空白格而不是报错 —— 那是**故意的**：宁可看见空格，也不要看见编的数字。
 */

const persona = {
  age: '24', role: '刚毕业的程序员', world: '当代都市',
  traits: '活泼、爱吐槽、嘴贫但没恶意', tone: '短句为主，多用语气词',
  catch: '有一说一', faces: '狗头、呲牙',
  desire: '想让群里的人认可他', fear: '最怕没人理他',
  logic: '先看别人怎么说再插话', attitude: '对熟人损友式亲近', status: '刚下班，在等外卖',
};

export const DEMO = {
  __demo: true,
  panel: { pid: 0, bootedAt: Date.now(), uptimeMs: 0, stale: false },
  container: { running: false, line: '（演示数据）未检测', loggedIn: false, loginHint: '', qrDecodeUrl: '' },
  docker: { daemon: false, app: false },
  memory: { totalGB: 16, usedGB: 11.2, freeGB: 4.8, cachedGB: 3.1, swapGB: 0.4, pressure: 74,
    procs: { bridgeMB: 168, localModelMB: 0, dockerMB: 742, panelMB: 96 } },
  ports: { onebotHttp: true, onebotWs: true, webui: false },
  account: { userId: '', nickname: '（演示数据）' },
  localModel: { running: false, channel: 'mlx', wantChannel: 'mlx', ids: ['4b'],
    channels: [{ key: 'mlx', label: 'MLX 服务', port: 8080, up: false }, { key: 'qwenchat', label: 'QwenChat', port: 8765, up: false }],
    ports: { mlx: 8080, qwenchat: 8765 }, starting: false, available: true },
  configHistory: 7,
  debugLog: false,
  effective: {
    pid: 0, since: Date.now(), alive: false, model: 'glm-4.6v', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
    isLocal: false, fallbackModels: ['glm-4.5-air', 'glm-4.7', 'glm-4-flash'], temperature: 1, maxTokens: 400,
    extensions: { sum: { loaded: 0, pending: 0, skipped: 0, failed: 0 }, items: [] },
    customFaces: null, sleep: null,
  },
  config: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/', model: 'glm-4.6v', provider: 'zhipu',
    fallbackModels: ['glm-4.5-air', 'glm-4.7', 'glm-4-flash'],
    features: { webSearch: false, vision: true, stickers: true },
    thinking: { mode: 'on', level: 'low' }, hasKey: true, keyMasked: 'ab12••••••••cd34', keyNotNeeded: false,
    maxTokens: 400, localChannel: 'mlx', localSize: '4b', activePreset: 'zhipu',
    presets: { zhipu: { context: { recentTurns: 6, ambientMessages: 8 } } },
    groups: [], denyGroups: [], denyUsers: [], requireAtInGroup: true, interjectChance: 0,
    aliases: ['小鱼'], personaName: '小鱼',
  },
  custom: {
    version: 2, persona,
    enhance: { values: '', decide: '', stress: '', emotion: '', habits: '', speech: '',
      lines: '', secrets: '', limits: '', relation: '', growth: '', meters: '' },
    personaResetOnChange: true, playRules: true,
    skills: [{ id: 'k1', kind: 'pack', name: '（演示）梗百科', enabled: true, scope: { type: 'global', id: '' },
      triggers: ['梗'], background: '示例背景', examples: [] }],
    plugins: { enabled: ['bot-emotion'], settings: {} },
    replyStyle: { length: 'normal', mentionAt: false, cooldownSec: 0, multiMessage: true },
    trigger: {
      keywords: ['小鱼', '肥鱼'],
      proactive: { enabled: false, intervalMin: 90, text: '' },
      scheduled: [{ id: 's1', at: '07:00', text: '（演示）早报', enabled: true, date: '', on: 'workday' }],
      quietHours: { from: 23, to: 8 },
    },
    allowProactive: true,
    browseLock: { enabled: false, hosts: [] },
    sleep: { enabled: false, bed: '01:00', wake: '08:00', wakeWords: ['起床'], goodnight: '' },
    forwardExpand: { enabled: true },
    crossSend: { enabled: false },
    scenes: { insulted: '', silent: '', lateNight: '', newMember: '', searchFail: '', visionFail: '', webFail: '', typo: '', complaint: '' },
    memory: { auto: false, manual: [{ id: 'm1', text: '（演示）不要跟群里的张三说话', on: true, t: Date.now() }] },
    safety: { banned: [], antiFlood: true, filterLinks: false },
  },
  customMeta: {
    similarThreshold: 0.5,
    replyLengths: {
      short: { label: '短', hint: '每条尽量 15 字以内，像随手打的' },
      normal: { label: '中等', hint: '每条 20–40 字' },
      long: { label: '长', hint: '可以到 60 字，把话说完整一点' },
    },
    fieldMeta: { numbers: { minIntervalMs: 1500, minIntervalMsSec: 1.5, cooldownSec: 0, proactiveIntervalMin: 90, quietFrom: 23, quietTo: 8, antiFloodChunks: 2 },
      bounds: { cooldownSec: [0, 600], proactiveIntervalMin: [5, 1440], quietFrom: [0, 23], quietTo: [0, 23] } },
    playRules: [
      { id: 'inCharacter', text: '始终以角色身份说话和行动，不跳出角色。' },
      { id: 'noAuto', text: '不替用户决定、行动、感受或说话。' },
      { id: 'noInvent', text: '不知道的信息不编造，可以怀疑、猜测、沉默。' },
      { id: 'inertia', text: '情绪和关系有惯性，不无缘无故好感或敌意。' },
      { id: 'mayRefuse', text: '可以拒绝、误解、隐瞒、嘴硬，不必永远配合。' },
      { id: 'consistent', text: '保持称呼、口癖、底线一致。' },
      { id: 'advance', text: '每次回复推进一点互动，不要总结全文。' },
      { id: 'ooc', text: '需要出戏时，只响应 OOC: 开头的消息。' },
      { id: 'notOmniscient', text: '不轻易全知，不读心，不预知剧情。' },
      { id: 'gradual', text: '关系变化要有过程，不能一回合从敌人变恋人。' },
      { id: 'allAges', text: '全年龄向，不碰政治、不碰低俗。', safety: true },
      { id: 'noSpam', text: '主动找话题可以，但不刷屏、不抢话。', safety: true },
    ],
    scenes: {
      insulted: { label: '被骂 / 被怼', hint: '有人在群里骂你、阴阳你时怎么回', ph: '例如：不还嘴，阴阳一句就走' },
      silent: { label: '冷场', hint: '话题断了、没人接话的时候怎么起个话头', ph: '例如：自己找个话题抛出来' },
      lateNight: { label: '深夜', hint: '凌晨时段的说话风格', ph: '例如：话少一点，催人早点睡' },
      newMember: { label: '新人入群', hint: '有人刚进群时怎么打招呼', ph: '例如：欢迎一句就行' },
      searchFail: { label: '搜不到结果', hint: '联网查了但没查到东西时怎么说', ph: '例如：直说没查到，别编' },
      visionFail: { label: '识图失败', hint: '看不懂这张图时怎么接', ph: '例如：说自己看不清楚' },
      webFail: { label: '联网查询失败', hint: '联网报错时怎么圆场', ph: '例如：别暴露报错信息' },
      typo: { label: '错别字 / 看不懂的缩写', hint: '群友打错字、用了你不认识的缩写时怎么办', ph: '例如：按上下文猜一句' },
      complaint: { label: '投诉 / 表达不满', hint: '有人对你不满、说你答得不好时怎么处理', ph: '例如：先认下来别辩解' },
    },
    enhance: {
      table: {
        values: { group: '他怎么想', label: '价值观排序', hint: '什么排前面', ph: '自由 > 家人 > 正义' },
        decide: { group: '他怎么想', label: '决策算法', hint: '先观察还是先动手', ph: '先看对方情绪' },
        stress: { group: '他怎么想', label: '压力反应', hint: '战斗 / 逃跑 / 僵住 / 讨好 / 讽刺 / 沉默', ph: '先吐槽两句' },
        emotion: { group: '他怎么想', label: '情绪触发', hint: '被夸 / 被质疑时分别什么反应', ph: '被夸：「哼，我知道啦」' },
        habits: { group: '他怎么表现', label: '习惯小动作', hint: '写成文字的小动作', ph: '说话带「哼」' },
        speech: { group: '他怎么表现', label: '语言指纹', hint: '常用词、骂人方式、幽默感', ph: '爱用「我跟你讲」' },
        lines: { group: '他怎么表现', label: '示例台词', hint: '2–3 句他真正会说的话', textarea: true, ph: '「喂喂喂，你今天怎么这么安静？」' },
        secrets: { group: '他知道什么', label: '秘密与信息差', hint: '他知道什么、不知道什么', ph: '他知道群里很多梗' },
        limits: { group: '他知道什么', label: '底线与禁忌', hint: '绝不会做什么', ph: '不拿别人的家人开玩笑' },
        relation: { group: '他会怎么变', label: '关系变化条件', hint: '做什么会从防备变信任', ph: '多回应他几次 → 变黏人' },
        growth: { group: '他会怎么变', label: '成长 / 堕落条件', hint: '什么事件会让他改变', ph: '被当众拆穿一次之后会收敛' },
        meters: { group: '他会怎么变', label: '状态值', hint: '信任度 / 情绪值 / 目标队列', ph: '信任 20/100（戒备）' },
      },
      keys: ['values', 'decide', 'stress', 'emotion', 'habits', 'speech', 'lines', 'secrets', 'limits', 'relation', 'growth', 'meters'],
      groups: ['他怎么想', '他怎么表现', '他知道什么', '他会怎么变'],
    },
  },
  usage: {
    calls: 692, paidCalls: 17, freeCalls: 675, prompt: 1246625, completion: 78310, reasoning: 25140,
    cached: 418022, cost: 0.01659, avgCost: 0.000976, lastAt: Date.now(),
    today: { calls: 11, paidCalls: 0, freeCalls: 11, cost: 0 },
    cloud: { calls: 676, cost: 0.01659 }, local: { calls: 16, cost: 0 },
    bySource: [
      { key: 'agent', label: '主回复', calls: 57, tokens: 227169 },
      { key: 'memoryJudge', label: '记忆判定', calls: 31, tokens: 27230 },
      { key: 'proactiveTopic', label: '主动话题', calls: 4, tokens: 8800 },
    ],
    recent: [
      { t: Date.now(), model: 'GLM-4.6V', origin: 'cloud', free: true, think: 'on', level: 'low', p: 843, c: 62, r: 0, cost: 0, source: 'agent' },
    ],
    rates: {},
  },
  memoryRecords: [
    { id: 'rm1', kind: 'person', kindShort: '群友画像', text: '（演示）小鱼喜欢追剧，最近在补老剧', status: 'confirmed', samples: 6, chatKey: 'group:100000', userId: '10001', firstSeenAt: Date.now(), lastSeenAt: Date.now() },
    { id: 'rm2', kind: 'fact', kindShort: '事实', text: '（演示）群里周三晚上固定开黑', status: 'candidate', samples: 2, chatKey: 'group:100000', userId: '', firstSeenAt: Date.now(), lastSeenAt: Date.now() },
  ],
  autoMemory: [{ id: 'a1', text: '（演示）早期自动记录的一条', t: Date.now(), from: 'group:100000' }],
  trace: [
    { t: Date.now(), traceId: 'demo', kind: 'reply', stage: 'sent', scene: 'group', sender: '（演示）',
      text: '在不，随便聊两句呗', model: 'glm-4.6v', used: 'glm-4.6v', prompt: '（演示）完整提示词…',
      messageCount: 12, ms: 1840, chunks: ['在的在的，刚下班'], reason: '', unread: { pending: 0, consumed: 3, left: 0, dropped: 0 } },
  ],
  modelCaps: {
    zhipu: {
      'glm-4.6v': { known: true, think: 'on', thinkModes: { auto: true, off: true, on: true }, levels: ['low', 'high'],
        features: { webSearch: true, vision: true, stickers: true, functions: true }, reasons: {} },
    },
  },
  featureLabels: { webSearch: '联网查询', vision: '识图', stickers: '发 QQ 表情' },
  modelLabels: { 'glm-4.6v': 'GLM-4.6V', 'glm-4.5-air': 'GLM-4.5-Air' },
  extensions: {
    ok: true,
    sum: { total: 13, load: 5, skip: 8, reject: 0, byReason: {}, byKind: { plugin: 5, skill: 8 } },
    roots: [{ name: 'plugins', missing: false, count: 5 }, { name: 'skills', missing: false, count: 8 }],
    items: [
      { id: 'bot-emotion', dirName: '本体情绪', name: '本体情绪', version: '1.0.0', kind: 'plugin',
        action: 'load', reason: 'enabled', detail: '已启用', problems: [], netSelf: false,
        settings: { injectPrompt: true, autoUpdate: true, injectPriority: 25 },
        settingsSpec: [
          { key: 'injectPrompt', kind: 'bool', sensitive: false, def: true, value: true },
          { key: 'autoUpdate', kind: 'bool', sensitive: false, def: true, value: true },
          { key: 'injectPriority', kind: 'number', sensitive: false, def: 25, value: 25 },
        ] },
      { id: 'echo-guard', dirName: '复读拦截', name: '复读拦截', version: '1.0.0', kind: 'plugin',
        action: 'skip', reason: 'not-enabled', detail: '未在 config 的白名单里启用', problems: [], netSelf: false,
        settings: { windowMin: 20, minLen: 6, maxPerRun: 6 },
        settingsSpec: [
          { key: 'windowMin', kind: 'number', sensitive: false, def: 20, value: 20 },
          { key: 'minLen', kind: 'number', sensitive: false, def: 6, value: 6 },
          { key: 'maxPerRun', kind: 'number', sensitive: false, def: 6, value: 6 },
        ] },
      { id: 'image-lib', dirName: '自定义图库', name: '自定义图库', version: '1.0.0', kind: 'skill',
        action: 'skip', reason: 'not-enabled', detail: '未在 config 的白名单里启用', problems: [], netSelf: false,
        settings: { maxEntries: 200 },
        settingsSpec: [{ key: 'maxEntries', kind: 'number', sensitive: false, def: 200, value: 200 }] },
    ],
  },
};
