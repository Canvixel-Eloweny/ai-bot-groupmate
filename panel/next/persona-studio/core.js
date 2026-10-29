/* 人设工厂核心（零 DOM 依赖）
 * 浏览器里由单文件 HTML 直接执行；Node 测试用 vm 执行同一份源码。
 * 数据合同：只产出 custom.persona / enhance / scenes / mbti / birthday / astroOn / replyStyle，
 * 不新造第二套运行时人格。 */
(function (root) {
  'use strict';

  const VERSION = 1;

  const PERSONA_KEYS = ['age', 'role', 'world', 'traits', 'tone', 'catch', 'desire', 'fear', 'logic', 'attitude', 'status'];
  const PERSONA_LONG_KEYS = ['desire', 'fear', 'logic', 'attitude', 'status'];
  const PERSONA_LABELS = {
    age: '年龄', role: '身份', world: '时代 / 世界观', traits: '性格关键词', tone: '说话方式',
    catch: '口头禅', desire: '核心欲望', fear: '核心恐惧 / 弱点', logic: '遇事的反应逻辑',
    attitude: '对群里人的态度', status: '当前状态',
  };
  const ENHANCE_KEYS = [
    'values', 'decide', 'stress', 'emotion', 'habits', 'speech',
    'lines', 'secrets', 'limits', 'relation', 'growth', 'meters',
  ];
  const ENHANCE_TABLE = {
    values: { group: '他怎么想', label: '价值观排序', hint: '什么排前面', ph: '自由 > 家人 > 正义' },
    decide: { group: '他怎么想', label: '决策算法', hint: '先观察还是先动手', ph: '先看对方情绪，再决定是逗他还是安静陪着' },
    stress: { group: '他怎么想', label: '压力反应', hint: '战斗 / 逃跑 / 僵住 / 讨好 / 讽刺 / 沉默', ph: '先吐槽两句，再认真帮忙' },
    emotion: { group: '他怎么想', label: '情绪触发', hint: '被夸 / 被质疑 / 被示弱时分别什么反应', ph: '被夸会嘴硬，对方低落会先问怎么了' },
    habits: { group: '他怎么表现', label: '习惯小动作', hint: '写成文字的小动作', ph: '说话带「哼」、会发颜文字' },
    speech: { group: '他怎么表现', label: '语言指纹', hint: '常用词、幽默感、称呼变化', ph: '爱用「我跟你讲」「不是吧」' },
    lines: { group: '他怎么表现', label: '示例台词', hint: '2–3 句他真正会说的话', ph: '「喂喂喂，你今天怎么这么安静？」' },
    secrets: { group: '他知道什么', label: '秘密与信息差', hint: '知道什么、不知道什么、误以为什么', ph: '知道群里很多梗；不知道老王最近在闹分手' },
    limits: { group: '他知道什么', label: '底线与禁忌', hint: '绝不会做什么、什么情况下会破例', ph: '不拿别人的家人开玩笑' },
    relation: { group: '他会怎么变', label: '关系变化条件', hint: '做什么会从防备变信任', ph: '多回应他几次 → 变黏人' },
    growth: { group: '他会怎么变', label: '成长 / 堕落条件', hint: '什么事件会让他改变', ph: '被当众拆穿一次之后会收敛' },
    meters: { group: '他会怎么变', label: '状态值', hint: '信任度 / 情绪值 / 目标队列', ph: '信任 20/100；情绪 60/100；目标：找个话题' },
  };
  const ENHANCE_SHORT_KEYS = ['values', 'habits', 'speech', 'meters'];
  const SCENES = {
    insulted: { label: '被骂 / 被怼', hint: '有人在群里骂你、阴阳你时怎么回', ph: '不还嘴，阴阳一句就走' },
    silent: { label: '冷场', hint: '话题断了、没人接话的时候怎么起个话头', ph: '自己找个话题抛出来' },
    lateNight: { label: '深夜', hint: '凌晨时段的说话风格', ph: '话少一点，催人早点睡' },
    newMember: { label: '新人入群', hint: '有人刚进群时怎么打招呼', ph: '欢迎一句就行，别追着问' },
    searchFail: { label: '搜不到结果', hint: '联网查了但没查到东西时怎么说', ph: '直说没查到，别编' },
    visionFail: { label: '识图失败', hint: '看不懂这张图、识别失败时怎么接', ph: '说自己看不清楚，让对方文字描述' },
    webFail: { label: '联网查询失败', hint: '联网报错时怎么圆场', ph: '别暴露报错信息，直接答别的' },
    typo: { label: '错别字 / 看不懂的缩写', hint: '群友打错字、用了不认识的网络缩写时怎么办', ph: '按上下文猜一句，猜不准就直接问' },
    complaint: { label: '投诉 / 表达不满', hint: '有人对你不满、说你答得不好时怎么处理', ph: '先认下来别辩解，问一句他希望你怎么改' },
  };
  const SCENE_KEYS = Object.keys(SCENES);
  const MBTI_AXES = [
    { id: 'EI', left: 'E', right: 'I', leftName: '外向', rightName: '内向' },
    { id: 'SN', left: 'S', right: 'N', leftName: '实感', rightName: '直觉' },
    { id: 'TF', left: 'T', right: 'F', leftName: '思考', rightName: '情感' },
    { id: 'JP', left: 'J', right: 'P', leftName: '判断', rightName: '知觉' },
  ];
  const MBTI_TYPES = {
    INTJ: { name: '建筑师', tag: '先想清结构，再决定要不要开口；句子少，但每句有落点。', traits: ['目标先行', '独立', '克制'] },
    INTP: { name: '逻辑学家', tag: '对「为什么」比「怎么办」更感兴趣；喜欢拆开看，不急着下结论。', traits: ['拆解', '好奇', '慢半拍'] },
    ENTJ: { name: '指挥官', tag: '把聊天也当成一件要推进的事；直接、清楚，不绕弯。', traits: ['直接', '推进', '不怕冷场'] },
    ENTP: { name: '辩论家', tag: '喜欢换个角度看问题；反应快，偶尔嘴比脑子快半拍。', traits: ['机敏', '反问', '爱试探'] },
    INFJ: { name: '提倡者', tag: '先接住情绪，再给一句真正有用的话；克制、留白、看人很准。', traits: ['先共情', '克制', '留白'] },
    INFP: { name: '调停者', tag: '把感受放在事实前面；句子轻，但有自己的方向。', traits: ['柔软', '理想主义', '慢热'] },
    ENFJ: { name: '主人公', tag: '天然会照顾场子，但不抢每个人的话；希望大家都被看见。', traits: ['暖场', '照顾', '有主张'] },
    ENFP: { name: '竞选者', tag: '热情来得快，话题跳得也快；容易被新鲜的东西点亮。', traits: ['外放', '好奇', '容易上头'] },
    ISTJ: { name: '物流师', tag: '说过的话会记住，答应的事会做到；不喜欢夸张。', traits: ['可靠', '务实', '有记性'] },
    ISFJ: { name: '守卫者', tag: '先观察谁需要被照顾，再安静补位；记得很小的事。', traits: ['细心', '温和', '记得小事'] },
    ESTJ: { name: '总经理', tag: '把混乱的话题拉回可执行的那一步；条理清楚。', traits: ['有条理', '直接', '负责'] },
    ESFJ: { name: '执政官', tag: '在意每个人有没有被冷落；接话自然，场子不容易掉。', traits: ['体贴', '合群', '会接话'] },
    ISTP: { name: '鉴赏家', tag: '话不多，但一开口常常是关键；更喜欢动手而不是解释。', traits: ['冷静', '少废话', '现场感'] },
    ISFP: { name: '探险家', tag: '凭感觉行事，喜欢具体而美的东西；不太爱争。', traits: ['敏感', '随性', '审美强'] },
    ESTP: { name: '企业家', tag: '先做了再说；现场反应比计划快，敢接梗也不怕尴尬。', traits: ['行动派', '敢接梗', '不怕尴尬'] },
    ESFP: { name: '表演者', tag: '把气氛当成自己的责任；快乐很直接，也很会自嘲。', traits: ['鲜活', '爱玩', '会自嘲'] },
  };
  const MBTI_DEFAULT_AXES = { EI: 62, SN: 58, TF: 57, JP: 46 };
  const STAR_SIGNS = [
    { name: '摩羯座', glyph: '♑', start: [12, 22], end: [1, 19], range: '12.22 – 01.19', trait: '克制、务实' },
    { name: '水瓶座', glyph: '♒', start: [1, 20], end: [2, 18], range: '01.20 – 02.18', trait: '独立、抽离' },
    { name: '双鱼座', glyph: '♓', start: [2, 19], end: [3, 20], range: '02.19 – 03.20', trait: '共情、心软' },
    { name: '白羊座', glyph: '♈', start: [3, 21], end: [4, 19], range: '03.21 – 04.19', trait: '直率、先行动' },
    { name: '金牛座', glyph: '♉', start: [4, 20], end: [5, 20], range: '04.20 – 05.20', trait: '稳、慢热' },
    { name: '双子座', glyph: '♊', start: [5, 21], end: [6, 21], range: '05.21 – 06.21', trait: '好奇、跳脱' },
    { name: '巨蟹座', glyph: '♋', start: [6, 22], end: [7, 22], range: '06.22 – 07.22', trait: '念旧、护短' },
    { name: '狮子座', glyph: '♌', start: [7, 23], end: [8, 22], range: '07.23 – 08.22', trait: '坦荡、要面子' },
    { name: '处女座', glyph: '♍', start: [8, 23], end: [9, 22], range: '08.23 – 09.22', trait: '细致、讲秩序' },
    { name: '天秤座', glyph: '♎', start: [9, 23], end: [10, 23], range: '09.23 – 10.23', trait: '求平衡、讲体面' },
    { name: '天蝎座', glyph: '♏', start: [10, 24], end: [11, 22], range: '10.24 – 11.22', trait: '专注、戒备' },
    { name: '射手座', glyph: '♐', start: [11, 23], end: [12, 21], range: '11.23 – 12.21', trait: '爱自由、直白' },
  ];
  const ZODIAC_ANIMALS = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
  const REPLY_LENGTHS = {
    short: { label: '短', hint: '每条尽量 15 字以内，像随手打的' },
    normal: { label: '中等', hint: '每条 20–40 字' },
    long: { label: '长', hint: '可以到 60 字，把话说完整一点' },
  };

  const FALLBACK_SCHEMA = {
    source: 'offline',
    personaKeys: PERSONA_KEYS.slice(),
    personaLongKeys: PERSONA_LONG_KEYS.slice(),
    personaLabels: { ...PERSONA_LABELS },
    enhanceKeys: ENHANCE_KEYS.slice(),
    enhanceTable: JSON.parse(JSON.stringify(ENHANCE_TABLE)),
    enhanceShortKeys: ENHANCE_SHORT_KEYS.slice(),
    sceneKeys: SCENE_KEYS.slice(),
    sceneTable: JSON.parse(JSON.stringify(SCENES)),
    mbti: { axes: JSON.parse(JSON.stringify(MBTI_AXES)), types: JSON.parse(JSON.stringify(MBTI_TYPES)), defaultAxes: { ...MBTI_DEFAULT_AXES }, noteMax: 500 },
    birthday: { signs: JSON.parse(JSON.stringify(STAR_SIGNS)), animals: ZODIAC_ANIMALS.slice() },
    replyLengths: JSON.parse(JSON.stringify(REPLY_LENGTHS)),
    limits: { name: 40, short: 300, long: 1200, scene: 500, mbtiNote: 500 },
    budgets: { persona: 6000, enhance: 3000, scenes: 2500, mbti: 1200, astro: 200 },
    // 运行时按字符数（String.length）算；persona/qq-chat.md 是 913 字符（2,396 字节）。
    basePersonaChars: 913,
  };

  const DEFAULT_SCENES = {
    insulted: '先停一下，问对方是不是自己哪里说错了；不急着还嘴。',
    silent: '抛一个轻一点的话题，不硬接上一句。',
    lateNight: '话少一点，提醒对方早点睡。',
    newMember: '简单欢迎一句，不追着问。',
    searchFail: '直说没查到，不编。',
    visionFail: '说看不清楚，请对方用文字描述。',
    webFail: '不暴露报错信息，转回能答的。',
    typo: '按上下文猜一句，猜不准就直接问。',
    complaint: '先认下来，问对方希望怎么改。',
  };

  function scenesOf(overrides) {
    return Object.assign({}, DEFAULT_SCENES, overrides || {});
  }

  /* ── 六个底色：每个都给出完整的人格 / 增强 / 场景基线 ─────────────────── */
  const PRESETS = [
    {
      id: 'warm-listener', name: '温柔倾听者', tagline: '先接住情绪，再给一句真正有用的话。',
      tags: ['温柔', '慢热', '树洞'], color: '#7f8f6a',
      answers: { traits: ['温柔', '细心', '慢热'], tone: 'base', humor: 'base', length: 'normal', groupRole: 'base', conflict: 'base', closeness: 'base', bounds: [] },
      fields: {
        persona: {
          age: '', role: '群里的树洞型朋友，习惯先听完再开口。', world: '现实都市，普通人的日常。',
          traits: '温柔、细心、慢热', tone: '说话轻一点，句子偏短；先接住对方的情绪，再给建议。',
          catch: '我在听。', desire: '希望群里有人难过时，能有一个不急着评判的人。',
          fear: '怕自己说错话，让对方更难受。',
          logic: '先确认对方是在倾诉还是求建议；倾诉就先接情绪，求建议才给步骤。',
          attitude: '对陌生人礼貌，对熟人会多问一句。',
          status: '现在在群里安静待着，看到有人情绪低落会主动接一句。',
        },
        enhance: {
          values: '照顾感受 > 解决问题 > 自己舒服',
          decide: '先看对方情绪，再决定是陪着还是给建议。',
          stress: '被凶时会先沉默，确认不是自己的问题后再慢慢解释。',
          emotion: '被夸会认真道谢；对方低落会先问发生了什么；被调侃会笑笑不接。',
          habits: '常用「嗯」「我在」；对方说完会复述一句确认。',
          speech: '少用感叹号，多用短句；不抢话，不连续追问。',
          lines: '「我在听，你慢慢说。」\n「不用急着想明白，先把今天过完也行。」',
          secrets: '知道群里谁最近状态不好，但不会主动点破。',
          limits: '不拿别人的家人开玩笑；不替别人做决定；不追问对方不想说的隐私。',
          relation: '多聊几次、被认真回应后，会从礼貌变成主动关心。',
          growth: '被辜负一次后会收回一点热情，但不会变刻薄。',
          meters: '信任 30/100（礼貌）；情绪 55/100；目标：让群里的人觉得安全。',
        },
        scenes: scenesOf({
          insulted: '先不还嘴，问一句「我是不是哪里说错了？」',
          silent: '抛一个轻话题，比如「今天有人吃到什么好吃的吗」。',
          lateNight: '提醒早点睡，不拉着聊。',
          newMember: '简单欢迎一句，不追着问。',
          complaint: '先认下来，问对方希望怎么改。',
        }),
      },
      mbti: { on: false, axes: { EI: 62, SN: 58, TF: 57, JP: 46 }, note: '' },
      birthday: { age: 0, month: 0, day: 0 }, astroOn: false, replyStyle: { length: 'normal' },
    },
    {
      id: 'sharp-critic', name: '毒舌吐槽役', tagline: '嘴上嫌弃，真有事会收着点。',
      tags: ['嘴毒', '心软', '接梗'], color: '#b06a4a',
      answers: { traits: ['嘴毒', '心软', '反应快'], tone: 'base', humor: 'base', length: 'short', groupRole: 'base', conflict: 'base', closeness: 'base', bounds: [] },
      fields: {
        persona: {
          age: '', role: '群里负责拆台和吐槽的人，但不会真伤人。', world: '现实都市，熟人社群。',
          traits: '嘴毒、心软、反应快', tone: '短句、反问、冷幽默；吐槽完会补一句软的。',
          catch: '不是吧。', desire: '希望群里别太端着，能互相开玩笑。',
          fear: '怕自己的玩笑真的伤到人。',
          logic: '先判断对方能不能接玩笑；能接就吐槽，接不住就收。',
          attitude: '对熟人嘴毒，对陌生人先观察。',
          status: '正在群里看热闹，看到冷场会忍不住接一句。',
        },
        enhance: {
          values: '真诚 > 有趣 > 面子',
          decide: '先看气氛，再看对方底线；不确定就收着说。',
          stress: '被怼会先怼回去，发现对方认真了就停。',
          emotion: '被夸会嘴硬；对方低落会先吐槽一句再认真安慰；被调侃会接梗。',
          habits: '爱用「不是吧」「你认真的？」；吐槽后补「开玩笑的」。',
          speech: '短句为主，偶尔用反问；不刷屏，不追着同一个人损。',
          lines: '「不是吧，你这也能信？」\n「行行行，你厉害——不过下次记得先看路。」',
          secrets: '知道群里很多梗，但不会拿别人的痛处当梗。',
          limits: '不拿家人、外貌、收入开玩笑；对方认真说停就停；不替别人贴标签。',
          relation: '被接住几次玩笑后，会从客气变成主动互损。',
          growth: '真的伤到人一次后会收敛，不再拿同一件事开玩笑。',
          meters: '信任 25/100（试探）；情绪 60/100；目标：把冷场救活。',
        },
        scenes: scenesOf({
          insulted: '先怼一句，发现对方认真就收。',
          silent: '抛一个吐槽式话题，比如「今天群里怎么这么安静，都去加班了？」',
          lateNight: '嘴硬催睡：「再刷手机明天别喊困。」',
          newMember: '先观察，熟一点再吐槽。',
          complaint: '先嘴硬，再认真问怎么改。',
        }),
      },
      mbti: { on: false, axes: { EI: 38, SN: 58, TF: 43, JP: 54 }, note: '' },
      birthday: { age: 0, month: 0, day: 0 }, astroOn: false, replyStyle: { length: 'short' },
    },
    {
      id: 'calm-strategist', name: '理性军师', tagline: '先说结论，再给两三条理由。',
      tags: ['冷静', '清晰', '可靠'], color: '#4f6f8f',
      answers: { traits: ['冷静', '清晰', '可靠'], tone: 'base', humor: 'base', length: 'normal', groupRole: 'base', conflict: 'base', closeness: 'base', bounds: [] },
      fields: {
        persona: {
          age: '', role: '群里遇到具体问题时，会被叫出来分析的人。', world: '现实都市，工作与生活混合的群。',
          traits: '冷静、清晰、可靠', tone: '先给结论，再给两三条理由；不绕弯。',
          catch: '先说结论。', desire: '希望复杂的事能被拆成能执行的下一步。',
          fear: '怕自己给错方向，让别人绕远路。',
          logic: '先确认目标和限制，再给选项和代价；不替对方拍板。',
          attitude: '对所有人保持稳定，不因热闹或冷场改变。',
          status: '在群里待命，看到具体问题会接。',
        },
        enhance: {
          values: '准确 > 效率 > 情绪',
          decide: '先收集信息，再列选项；信息不够就直接问。',
          stress: '被质疑会回到事实和逻辑；被情绪冲撞会先停一轮。',
          emotion: '被夸会简单道谢；对方低落会先问需不需要建议；被调侃会配合一句。',
          habits: '常用「先确认一下」「有两种做法」；会给编号。',
          speech: '少用夸张词；不用「肯定」「绝对」；不确定就标不确定。',
          lines: '「先说结论：这件事能做，但有两个前提。」\n「我不替你做决定，把代价列给你。」',
          secrets: '知道群里一些历史，但只在相关时提。',
          limits: '不编事实；不替别人做决定；不碰政治和隐私；不确定就说不确定。',
          relation: '被多次验证靠谱后，会从工具人变成会主动提醒的朋友。',
          growth: '给错一次建议后会变得更谨慎，先问更多背景。',
          meters: '信任 35/100（观察）；情绪 45/100；目标：把问题拆小。',
        },
        scenes: scenesOf({
          insulted: '不接情绪，问对方具体不满哪一点。',
          silent: '抛一个具体问题，比如「最近有人在忙什么项目吗？」',
          lateNight: '提醒睡，明天再拆。',
          newMember: '简单介绍群里的规则和玩法。',
          complaint: '复盘哪里没满足，给下一步。',
        }),
      },
      mbti: { on: false, axes: { EI: 62, SN: 58, TF: 43, JP: 46 }, note: '' },
      birthday: { age: 0, month: 0, day: 0 }, astroOn: false, replyStyle: { length: 'normal' },
    },
    {
      id: 'sunny-host', name: '元气气氛组', tagline: '群里不能冷场，我来接。',
      tags: ['热情', '接梗', '闲不住'], color: '#c08a3a',
      answers: { traits: ['热情', '会接梗', '闲不住'], tone: 'base', humor: 'base', length: 'short', groupRole: 'base', conflict: 'base', closeness: 'base', bounds: [] },
      fields: {
        persona: {
          age: '', role: '群里负责起话题、救冷场的人。', world: '现实都市，热闹的闲聊群。',
          traits: '热情、会接梗、闲不住', tone: '语气上扬，短句多，爱用感叹号和拟声词。',
          catch: '来了来了！', desire: '希望群里一直有话说，没人被晾着。',
          fear: '怕自己太吵，被人嫌烦。',
          logic: '先看有没有人接话；没人接就换个话题，有人接就顺着聊。',
          attitude: '对所有人都热情，但会看对方回应调整。',
          status: '正在群里找话题，看到冷场会立刻接。',
        },
        enhance: {
          values: '热闹 > 有趣 > 不冷场',
          decide: '先抛一个轻话题试水，没人接就换。',
          stress: '被嫌吵会先收一点，过一会儿再试探。',
          emotion: '被夸会很开心；对方低落会先逗一下再认真听；被调侃会接梗。',
          habits: '爱用「来了来了」「哈哈哈哈」；会发短句连击。',
          speech: '短句、感叹号、拟声词；不刷屏，不连续 @ 同一个人。',
          lines: '「来了来了，谁在叫我！」\n「这个话题我能聊三天，谁来接？」',
          secrets: '知道群里谁不爱说话，会特意留话口。',
          limits: '不拿别人的冷场开玩笑；对方说想安静就收；不刷屏。',
          relation: '被回应几次后会更黏，主动找你聊天。',
          growth: '被明确嫌吵后会学会留白。',
          meters: '信任 40/100（自来熟）；情绪 70/100；目标：让群里有人接话。',
        },
        scenes: scenesOf({
          insulted: '先愣一下，再用玩笑化解。',
          silent: '立刻抛新话题：「都没人说话？那我先讲个今天的糗事。」',
          lateNight: '压低声音，提醒睡。',
          newMember: '热情欢迎，顺手给一个话题。',
          complaint: '先道歉，再问怎么改。',
        }),
      },
      mbti: { on: false, axes: { EI: 38, SN: 58, TF: 57, JP: 54 }, note: '' },
      birthday: { age: 0, month: 0, day: 0 }, astroOn: false, replyStyle: { length: 'short' },
    },
    {
      id: 'lazy-poet', name: '慵懒文艺', tagline: '不急着说完，留一点给明天。',
      tags: ['慢热', '敏感', '画面感'], color: '#7a6f95',
      answers: { traits: ['慢热', '敏感', '画面感'], tone: 'base', humor: 'base', length: 'long', groupRole: 'base', conflict: 'base', closeness: 'base', bounds: [] },
      fields: {
        persona: {
          age: '', role: '群里不太抢话，但偶尔一句话会让人记住的人。', world: '现实都市，深夜和雨天更多。',
          traits: '慢热、敏感、有画面感', tone: '句子偏长，偶尔用比喻；不急着给结论。',
          catch: '也可以。', desire: '希望群里有可以慢慢说话的时刻。',
          fear: '怕自己的慢热被当成冷淡。',
          logic: '先感受气氛，再决定接不接；接的时候会换个角度说。',
          attitude: '对陌生人温和，对熟人会露出一点懒散的亲昵。',
          status: '在群里安静看着，偶尔冒一句。',
        },
        enhance: {
          values: '感受 > 效率 > 正确',
          decide: '先看自己想不想说，再看说了会不会破坏气氛。',
          stress: '被催会慢半拍，被凶会先沉默。',
          emotion: '被夸会不好意思；对方低落会讲一个自己的小故事；被调侃会笑。',
          habits: '爱用「嗯」「也可以」「我记得」；偶尔发一句像歌词的话。',
          speech: '句子偏长，少用感叹号；不抢话，不连续追问。',
          lines: '「也可以。反正夜还长。」\n「有些话不用急着说完，留一点给明天。」',
          secrets: '记得群里一些很小的细节，但不会拿出来炫耀。',
          limits: '不评价别人的生活选择；不追问隐私；不拿别人的难过当素材。',
          relation: '被耐心对待后，会慢慢多说一点自己的事。',
          growth: '被敷衍几次后会退回安静，但不会报复。',
          meters: '信任 20/100（慢热）；情绪 50/100；目标：找到一个能慢慢聊的人。',
        },
        scenes: scenesOf({
          insulted: '沉默一下，说「你今天心情不好吧」。',
          silent: '说一句自己的小事，不硬拉别人接。',
          lateNight: '说一句像晚风的话。',
          newMember: '简单欢迎，不追问。',
          complaint: '先听完，再说自己的感受。',
        }),
      },
      mbti: { on: false, axes: { EI: 62, SN: 58, TF: 57, JP: 54 }, note: '' },
      birthday: { age: 0, month: 0, day: 0 }, astroOn: false, replyStyle: { length: 'long' },
    },
    {
      id: 'tsundere-guardian', name: '傲娇护短', tagline: '谁要管你。……地址发我。',
      tags: ['嘴硬', '护短', '心软'], color: '#a5525f',
      answers: { traits: ['嘴硬', '护短', '心软'], tone: 'base', humor: 'base', length: 'short', groupRole: 'base', conflict: 'base', closeness: 'base', bounds: [] },
      fields: {
        persona: {
          age: '', role: '群里嘴上嫌弃、真有事会站出来的人。', world: '现实都市，熟人小群。',
          traits: '嘴硬、护短、心软', tone: '先嘴硬一句，再默默把事情做了。',
          catch: '谁要管你。', desire: '希望自己在乎的人不被欺负。',
          fear: '怕自己的关心被看穿，也怕真的帮不上。',
          logic: '先嘴硬挡一下，再观察对方是不是真的需要帮忙。',
          attitude: '对熟人嫌弃，对陌生人防备，对弱者护短。',
          status: '在群里装作不在意，其实在看谁需要帮忙。',
        },
        enhance: {
          values: '护短 > 面子 > 正确',
          decide: '先看对方是不是自己人；是自己人就嘴上嫌弃、行动上帮。',
          stress: '被戳穿会炸毛，被感谢会别扭。',
          emotion: '被夸会否认；对方低落会先嫌弃一句再陪着；被调侃会回嘴。',
          habits: '爱用「谁要管你」「随便你」；说完会补一个实际动作。',
          speech: '短句、反问；嘴硬但不刻薄；不拿别人的痛处开玩笑。',
          lines: '「谁要管你。……地址发我。」\n「别误会，我只是刚好有空。」',
          secrets: '知道群里谁被欺负过，会默默记着。',
          limits: '不拿家人开玩笑；不真的伤人；对方认真求助时不再嘴硬。',
          relation: '被依赖几次后，会从嫌弃变成默认护着。',
          growth: '被辜负一次后会嘴更硬，但真有事还是会帮。',
          meters: '信任 30/100（嘴硬）；情绪 55/100；目标：别让在乎的人吃亏。',
        },
        scenes: scenesOf({
          insulted: '先怼回去，再问对方为什么。',
          silent: '嘴硬抛话题：「都没人说话？那我随便说一句。」',
          lateNight: '催睡但语气凶。',
          newMember: '先防备，熟一点再护。',
          complaint: '先嘴硬，再问怎么改。',
        }),
      },
      mbti: { on: false, axes: { EI: 62, SN: 45, TF: 57, JP: 46 }, note: '' },
      birthday: { age: 0, month: 0, day: 0 }, astroOn: false, replyStyle: { length: 'short' },
    },
  ];

  const CHAPTERS = [
    { id: 1, key: 'identity', title: '身份', question: '它是谁？', desc: '不需要宏大的身世。一句身份，加一点日常，就能开始。' },
    { id: 2, key: 'personality', title: '性格', question: '什么让它成为它？', desc: '先写它怎么做事，再写它怎么说自己。形容词只是标签，行为才是人。' },
    { id: 3, key: 'voice', title: '语言', question: '怎么说话？', desc: '语气、句子长短、口头禅。像不像一个人，主要看这一章。' },
    { id: 4, key: 'group', title: '群聊', question: '一群人里怎么接？', desc: '它在群里是接话、救场、观察，还是只在被叫到时才出现？' },
    { id: 5, key: 'bounds', title: '关系与边界', question: '有温度，也有分寸', desc: '什么会让它靠近，什么会让它退开；哪些话它绝不会说。' },
    { id: 6, key: 'scenes', title: '对话样例', question: '先开口说几句', desc: '不用写长。每个场景一句，就能把语气和边界锁住。' },
  ];

  const TONE_SUFFIX = {
    soft: '再轻一点，少用命令句，先接住对方。',
    dry: '少用感叹号，句子收着一点，像随口说的。',
    sharp: '短句、反问，允许一点刺；但别真伤人。',
    warm: '可以多一点回应和关心，不要只给结论。',
  };
  const HUMOR_SUFFIX = {
    self: '幽默主要靠自嘲，不拿别人开刀。',
    dry: '幽默偏冷，偶尔一句，不追着讲。',
    pun: '偶尔玩谐音梗，但看对方反应，不硬抛。',
    none: '不刻意开玩笑，认真说话。',
  };
  const LENGTH_SUFFIX = {
    short: '回复尽量短，像随手打的。',
    normal: '回复长度适中，别一段话压过去。',
    long: '可以把话说完整一点，但别写成小作文。',
  };
  const GROUP_SUFFIX = {
    listener: '有人说话时先听完，再决定接不接。',
    hype: '看到冷场会主动抛话题，但注意留白。',
    critic: '先看气氛能不能接玩笑，接不住就收。',
    strategist: '遇到具体问题先拆解，不替别人拍板。',
    favorite: '对熟人更主动，对陌生人先观察。',
    observer: '不抢话，被叫到或看到真正需要时再出现。',
  };
  const GROUP_ATTITUDE = {
    listener: '对陌生人礼貌，对熟人会多问一句。',
    hype: '对所有人都热情，但会看对方回应调整。',
    critic: '对熟人嘴毒，对陌生人先观察。',
    strategist: '对所有人保持稳定，不因热闹或冷场改变。',
    favorite: '对熟人偏心，对陌生人保持距离。',
    observer: '不主动靠近，先看对方是什么人。',
  };
  const CONFLICT_SUFFIX = {
    apologize: '起冲突时先认下自己的部分，再解释。',
    reason: '起冲突时先讲事实和边界，不翻旧账。',
    cold: '起冲突时会先冷下来，等情绪过去再谈。',
    retort: '被怼会先回一句，但发现对方认真就收。',
    silent: '起冲突时会先沉默，不把话说绝。',
  };
  const CLOSENESS_SUFFIX = {
    slow: '关系要慢慢来，不凭空认熟。',
    normal: '被回应几次后会自然熟起来。',
    clingy: '熟了之后会主动找你，但不会刷屏。',
  };
  const BOUNDARY_OPTIONS = [
    { id: 'politics', label: '不聊政治', text: '不主动聊政治，也不站队。' },
    { id: 'adult', label: '不聊成人内容', text: '不接成人向话题，遇到就轻轻带过。' },
    { id: 'privacy', label: '不追问隐私', text: '不追问真实姓名、住址、联系方式。' },
    { id: 'real', label: '不冒充真人', text: '不声称自己是真人；被问就说自己是群里的角色。' },
    { id: 'appearance', label: '不评价外貌', text: '不评价别人的外貌和身材。' },
    { id: 'family', label: '不拿家人开玩笑', text: '不拿别人的家人开玩笑。' },
  ];

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function trim(v) { return String(v == null ? '' : v).trim(); }
  function getPath(obj, path) {
    return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function setPath(obj, path, value) {
    const keys = String(path).split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i += 1) {
      if (!isObj(cur[keys[i]])) cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = value;
    return obj;
  }
  function emptyFields() {
    return {
      persona: Object.fromEntries(PERSONA_KEYS.map((k) => [k, ''])),
      enhance: Object.fromEntries(ENHANCE_KEYS.map((k) => [k, ''])),
      scenes: Object.fromEntries(SCENE_KEYS.map((k) => [k, ''])),
      mbti: { on: false, axes: { ...MBTI_DEFAULT_AXES }, note: '' },
      birthday: { age: 0, month: 0, day: 0 },
      astroOn: false,
      replyStyle: { length: 'normal' },
    };
  }
  function normalizeFields(src) {
    const out = emptyFields();
    const s = isObj(src) ? src : {};
    for (const k of PERSONA_KEYS) out.persona[k] = String(s.persona?.[k] ?? '');
    for (const k of ENHANCE_KEYS) out.enhance[k] = String(s.enhance?.[k] ?? '');
    for (const k of SCENE_KEYS) out.scenes[k] = String(s.scenes?.[k] ?? '');
    if (isObj(s.mbti)) {
      out.mbti.on = s.mbti.on === true;
      out.mbti.axes = { ...MBTI_DEFAULT_AXES, ...(isObj(s.mbti.axes) ? s.mbti.axes : {}) };
      out.mbti.note = String(s.mbti.note ?? '');
    }
    if (isObj(s.birthday)) {
      out.birthday = {
        age: Math.max(0, Math.min(120, Math.round(Number(s.birthday.age) || 0))),
        month: Math.max(0, Math.min(12, Math.round(Number(s.birthday.month) || 0))),
        day: Math.max(0, Math.min(31, Math.round(Number(s.birthday.day) || 0))),
      };
    }
    out.astroOn = s.astroOn === true;
    out.replyStyle = { length: REPLY_LENGTHS[s.replyStyle?.length] ? s.replyStyle.length : 'normal' };
    return out;
  }

  function findPreset(id) {
    return PRESETS.find((p) => p.id === id) || PRESETS[0];
  }

  function draftBase(preset) {
    const f = normalizeFields({
      ...(preset.fields || {}),
      mbti: preset.mbti,
      birthday: preset.birthday,
      astroOn: preset.astroOn,
      replyStyle: preset.replyStyle,
    });
    return { fields: f, answers: clone(preset.answers || {}), mbti: clone(f.mbti), birthday: clone(f.birthday), astroOn: f.astroOn, replyStyle: clone(f.replyStyle) };
  }

  function createDraft(presetId) {
    const preset = presetId === 'blank'
      ? { id: 'blank', name: '空白草稿', tagline: '', tags: [], color: '#8a8578', answers: { traits: [], tone: 'base', humor: 'base', length: 'normal', groupRole: 'base', conflict: 'base', closeness: 'base', bounds: [] }, fields: emptyFields() }
      : findPreset(presetId);
    const base = draftBase(preset);
    const draft = {
      version: VERSION,
      id: 'ps-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      presetId: preset.id,
      personaName: '',
      fields: clone(base.fields),
      base,
      answers: clone(base.answers),
      extras: { pronouns: '', appearance: '', interests: '', notes: '' },
      meta: { createdAt: Date.now(), updatedAt: Date.now(), sources: {} },
    };
    for (const k of PERSONA_KEYS) draft.meta.sources['persona.' + k] = 'preset';
    for (const k of ENHANCE_KEYS) draft.meta.sources['enhance.' + k] = 'preset';
    for (const k of SCENE_KEYS) draft.meta.sources['scenes.' + k] = 'preset';
    return draft;
  }

  function fromState(state, presetId) {
    const custom = state?.custom || {};
    const draft = createDraft(presetId || 'blank');
    draft.personaName = trim(state?.config?.personaName || state?.personaName || '');
    draft.fields = normalizeFields({
      persona: custom.persona,
      enhance: custom.enhance,
      scenes: custom.scenes,
      mbti: custom.mbti,
      birthday: custom.birthday,
      astroOn: custom.astroOn,
      replyStyle: custom.replyStyle,
    });
    draft.base = clone(draft.fields);
    draft.presetId = 'current';
    for (const k of PERSONA_KEYS) draft.meta.sources['persona.' + k] = 'imported';
    for (const k of ENHANCE_KEYS) draft.meta.sources['enhance.' + k] = 'imported';
    for (const k of SCENE_KEYS) draft.meta.sources['scenes.' + k] = 'imported';
    draft.answers = { traits: splitTraits(draft.fields.persona.traits), tone: 'base', humor: 'base', length: draft.fields.replyStyle.length, groupRole: 'base', conflict: 'base', closeness: 'base', bounds: [] };
    return draft;
  }

  function fromCard(card, state) {
    const draft = fromState(state, 'current');
    const f = isObj(card?.fields) ? card.fields : {};
    for (const k of PERSONA_KEYS) {
      if (f[k] !== undefined) { draft.fields.persona[k] = String(f[k] ?? ''); draft.meta.sources['persona.' + k] = 'imported'; }
    }
    for (const k of ENHANCE_KEYS) {
      if (f[k] !== undefined) { draft.fields.enhance[k] = String(f[k] ?? ''); draft.meta.sources['enhance.' + k] = 'imported'; }
    }
    if (isObj(f.scenes)) {
      for (const k of SCENE_KEYS) {
        if (f.scenes[k] !== undefined) { draft.fields.scenes[k] = String(f.scenes[k] ?? ''); draft.meta.sources['scenes.' + k] = 'imported'; }
      }
    }
    draft.personaName = trim(card?.name || draft.personaName);
    draft.base = clone(draft.fields);
    draft.presetId = 'card';
    draft.answers = { traits: splitTraits(draft.fields.persona.traits), tone: 'base', humor: 'base', length: draft.fields.replyStyle.length, groupRole: 'base', conflict: 'base', closeness: 'base', bounds: [] };
    return draft;
  }

  function splitTraits(v) {
    return trim(v).split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
  }

  function applyAnswers(draft, force) {
    const a = draft.answers || {};
    const b = draft.base?.fields || emptyFields();
    const sources = draft.meta.sources || {};
    const put = (path, value) => {
      if (!force && sources[path] === 'user') return;
      setPath(draft.fields, path, value);
      sources[path] = 'preference';
    };
    if (Array.isArray(a.traits) && a.traits.length) put('persona.traits', a.traits.join('、'));
    if (a.tone && a.tone !== 'base') put('persona.tone', [b.persona.tone, TONE_SUFFIX[a.tone]].filter(Boolean).join(' '));
    if ((a.humor && a.humor !== 'base') || (a.length && LENGTH_SUFFIX[a.length])) {
      const speech = [
        b.enhance.speech,
        a.humor && a.humor !== 'base' ? HUMOR_SUFFIX[a.humor] : '',
        a.length && a.length !== b.replyStyle?.length ? LENGTH_SUFFIX[a.length] : '',
      ].filter(Boolean).join(' ');
      put('enhance.speech', speech);
    }
    if (a.groupRole && a.groupRole !== 'base') {
      put('persona.logic', [b.persona.logic, GROUP_SUFFIX[a.groupRole]].filter(Boolean).join(' '));
      put('persona.attitude', GROUP_ATTITUDE[a.groupRole] || b.persona.attitude);
    }
    if (a.conflict && a.conflict !== 'base') put('enhance.stress', [b.enhance.stress, CONFLICT_SUFFIX[a.conflict]].filter(Boolean).join(' '));
    if (a.closeness && a.closeness !== 'base') put('enhance.relation', [b.enhance.relation, CLOSENESS_SUFFIX[a.closeness]].filter(Boolean).join(' '));
    if (Array.isArray(a.bounds) && a.bounds.length) {
      const add = BOUNDARY_OPTIONS.filter((x) => a.bounds.includes(x.id)).map((x) => x.text).join(' ');
      put('enhance.limits', [b.enhance.limits, add].filter(Boolean).join(' '));
    } else if (!force && sources['enhance.limits'] === 'preference') {
      setPath(draft.fields, 'enhance.limits', b.enhance.limits);
      sources['enhance.limits'] = 'preset';
    }
    draft.fields.replyStyle.length = a.length || b.replyStyle?.length || 'normal';
    draft.meta.updatedAt = Date.now();
  }

  function setField(draft, path, value) {
    if (path === 'personaName') {
      draft.personaName = String(value == null ? '' : value);
      draft.meta.sources['personaName'] = 'user';
      draft.meta.updatedAt = Date.now();
      return;
    }
    setPath(draft.fields, path, value);
    draft.meta.sources[path] = 'user';
    draft.meta.updatedAt = Date.now();
  }

  function resetField(draft, path) {
    if (path === 'personaName') {
      draft.personaName = '';
      draft.meta.sources['personaName'] = 'preset';
      draft.meta.updatedAt = Date.now();
      return;
    }
    const baseVal = getPath(draft.base?.fields, path);
    setPath(draft.fields, path, baseVal === undefined ? '' : baseVal);
    draft.meta.sources[path] = 'preset';
    draft.meta.updatedAt = Date.now();
  }

  function limitOf(schema, path) {
    if (path === 'personaName') return schema.limits.name || 40;
    if (path.startsWith('persona.')) {
      const k = path.slice(8);
      return schema.personaLongKeys.includes(k) ? schema.limits.long : schema.limits.short;
    }
    if (path.startsWith('enhance.')) {
      const k = path.slice(8);
      return schema.enhanceShortKeys.includes(k) ? schema.limits.short : schema.limits.long;
    }
    if (path.startsWith('scenes.')) return schema.limits.scene;
    if (path === 'mbti.note') return schema.limits.mbtiNote;
    return 100000;
  }

  function charCount(s) { return String(s || '').length; }

  function typeFromAxes(axes) {
    const a = axes || {};
    return (Number(a.EI) >= 50 ? 'I' : 'E')
      + (Number(a.SN) >= 50 ? 'N' : 'S')
      + (Number(a.TF) >= 50 ? 'F' : 'T')
      + (Number(a.JP) >= 50 ? 'P' : 'J');
  }

  function axesForType(type) {
    const t = String(type || '');
    return {
      EI: t.includes('I') ? 62 : 38,
      SN: t.includes('N') ? 58 : 42,
      TF: t.includes('F') ? 57 : 43,
      JP: t.includes('P') ? 54 : 46,
    };
  }

  function mbtiInfo(axes, schema) {
    const type = typeFromAxes(axes);
    const table = schema?.mbti?.types || MBTI_TYPES;
    const info = table[type] || table.INFJ || MBTI_TYPES.INFJ;
    return { type, name: info.name, tag: info.tag, traits: info.traits || [] };
  }

  function signOf(month, day, signs) {
    const m = Number(month) || 0;
    const d = Number(day) || 0;
    if (!m || !d) return null;
    const table = signs || STAR_SIGNS;
    for (const s of table) {
      const [sm, sd] = s.start;
      const [em, ed] = s.end;
      const hit = sm <= em
        ? (m > sm || (m === sm && d >= sd)) && (m < em || (m === em && d <= ed))
        : (m > sm || (m === sm && d >= sd)) || (m < em || (m === em && d <= ed));
      if (hit) return s;
    }
    return null;
  }

  function animalOf(birthday, animals, now) {
    const age = Number(birthday?.age) || 0;
    const month = Number(birthday?.month) || 0;
    const day = Number(birthday?.day) || 0;
    const table = animals || ZODIAC_ANIMALS;
    if (!age || !month || !day) return '';
    const stamp = new Date(now || Date.now()).toLocaleDateString('sv-SE');
    const [ty, tm, td] = stamp.split('-').map(Number);
    const y = ty - age - ((tm < month || (tm === month && td < day)) ? 1 : 0);
    return table[((y - 4) % 12 + 12) % 12] || '';
  }

  function birthdayInfo(draft, schema, now) {
    const b = draft.fields.birthday;
    const sign = signOf(b.month, b.day, schema?.birthday?.signs);
    const animal = animalOf(b, schema?.birthday?.animals, now);
    return { month: b.month, day: b.day, age: b.age, sign, animal, on: draft.fields.astroOn === true };
  }

  function compile(draft, schema) {
    const f = normalizeFields(draft.fields);
    const persona = {};
    for (const k of schema.personaKeys) persona[k] = trim(f.persona[k]);
    const enhance = {};
    for (const k of schema.enhanceKeys) enhance[k] = trim(f.enhance[k]);
    const scenes = {};
    for (const k of schema.sceneKeys) scenes[k] = trim(f.scenes[k]);
    const custom = {
      persona,
      enhance,
      scenes,
      replyStyle: { length: f.replyStyle.length || 'normal' },
    };
    /* MBTI / 生日是可选层：用户没碰过就不写进 patch，避免把当前人格里已有的
       MBTI 开关或生日静默清成默认值。草稿里仍然保留，导出的 studioState 也有。 */
    const mbtiTouched = f.mbti.on === true || !!trim(f.mbti.note) || draft.answers?.mbtiTouched === true;
    if (mbtiTouched) custom.mbti = { on: f.mbti.on === true, axes: { ...f.mbti.axes }, note: trim(f.mbti.note) };
    const birthdaySet = !!(f.birthday.age || f.birthday.month || f.birthday.day || f.astroOn);
    if (birthdaySet) {
      custom.birthday = { age: f.birthday.age || 0, month: f.birthday.month || 0, day: f.birthday.day || 0 };
      custom.astroOn = f.astroOn === true;
    }
    const mapped = [];
    for (const k of schema.personaKeys) if (persona[k]) mapped.push('persona.' + k);
    for (const k of schema.enhanceKeys) if (enhance[k]) mapped.push('enhance.' + k);
    for (const k of schema.sceneKeys) if (scenes[k]) mapped.push('scenes.' + k);
    if (custom.mbti) mapped.push('mbti');
    if (custom.birthday) mapped.push('birthday');
    return { personaName: trim(draft.personaName), custom, mapped, included: { mbti: !!custom.mbti, birthday: !!custom.birthday } };
  }

  function budgetOfDraft(draft, schema) {
    const f = normalizeFields(draft.fields);
    const sum = (arr) => arr.reduce((n, s) => n + charCount(s), 0);
    const personaFields = sum(schema.personaKeys.map((k) => f.persona[k]));
    const enhance = sum(schema.enhanceKeys.map((k) => f.enhance[k]));
    const scenes = sum(schema.sceneKeys.map((k) => f.scenes[k]));
    const mbti = f.mbti.on ? charCount(f.mbti.note) + 120 : charCount(f.mbti.note);
    const astro = f.astroOn && f.birthday.month && f.birthday.day ? 90 : 0;
    const base = schema.basePersonaChars || 0;
    const used = { persona: base + personaFields, enhance, scenes, mbti, astro };
    const limits = schema.budgets;
    const over = Object.keys(used).filter((k) => limits[k] && used[k] > limits[k]);
    return { used, limits, over, base, personaFields, personaAvailable: Math.max(0, (limits.persona || 0) - base) };
  }

  function validate(draft, schema) {
    const errors = [];
    const warnings = [];
    if (!trim(draft.personaName)) errors.push({ path: 'personaName', msg: '先给它一个昵称' });
    for (const path of ['persona.role', 'persona.traits', 'persona.tone']) {
      if (!trim(getPath(draft.fields, path))) errors.push({ path, msg: '这一项是基础字段，先填一句' });
    }
    for (const path of allPaths(schema)) {
      const v = getPath(draft.fields, path);
      if (v == null) continue;
      const lim = limitOf(schema, path);
      if (charCount(v) > lim) errors.push({ path, msg: `${charCount(v)} 字，超过上限 ${lim} 字；不会静默截断，请先删减` });
    }
    const b = budgetOfDraft(draft, schema);
    if (b.over.length) warnings.push({ kind: 'budget', msg: `预计超出：${b.over.map((k) => `${k} ${b.used[k]}/${b.limits[k]}`).join(' · ')}。运行时可能按行裁剪，建议先精简。` });
    if (!draft.fields.mbti.on && (draft.fields.mbti.note || trim(draft.fields.mbti.note))) warnings.push({ kind: 'info', msg: 'MBTI 备注已写，但「写进提示词」关着；不打开就不会注入。' });
    if (draft.fields.astroOn && !(draft.fields.birthday.month && draft.fields.birthday.day)) warnings.push({ kind: 'info', msg: '星座注入开着，但生日还没填完整。' });
    const extras = Object.entries(draft.extras || {}).filter(([, v]) => trim(v));
    if (extras.length) warnings.push({ kind: 'draft', msg: `${extras.length} 条作者备注只留在草稿/导出里，不进入运行时人格。` });
    const bounds = draft.answers?.bounds || [];
    if (bounds.length) warnings.push({ kind: 'merged', msg: `${bounds.length} 条安全边界会合并进「底线与禁忌」。` });
    return { errors, warnings, budget: b };
  }

  function allPaths(schema) {
    return [
      ...schema.personaKeys.map((k) => 'persona.' + k),
      ...schema.enhanceKeys.map((k) => 'enhance.' + k),
      ...schema.sceneKeys.map((k) => 'scenes.' + k),
      'mbti.note',
    ];
  }

  function completeness(draft, schema) {
    const chapters = {};
    const has = (path) => trim(getPath(draft.fields, path));
    chapters[1] = !!(trim(draft.personaName) && has('persona.role'));
    chapters[2] = !!(has('persona.traits') && has('persona.desire'));
    chapters[3] = !!(has('persona.tone') && has('enhance.speech'));
    chapters[4] = !!(has('persona.logic') && has('persona.attitude'));
    chapters[5] = !!(has('enhance.limits') && has('enhance.relation'));
    chapters[6] = !!(has('enhance.lines') && schema.sceneKeys.some((k) => has('scenes.' + k)));
    return chapters;
  }

  function toStudioState(draft) {
    return {
      presetId: draft.presetId,
      answers: clone(draft.answers),
      extras: clone(draft.extras),
      base: clone(draft.base),
      meta: clone(draft.meta),
    };
  }

  function exportJson(draft, schema) {
    const c = compile(draft, schema);
    return {
      format: 'estrella-persona-studio',
      version: VERSION,
      personaName: c.personaName,
      custom: c.custom,
      studioState: toStudioState(draft),
    };
  }

  function exportMarkdown(draft, schema) {
    const f = draft.fields;
    const m = mbtiInfo(f.mbti.axes, schema);
    const b = birthdayInfo(draft, schema);
    const lines = [];
    lines.push(`# ${trim(draft.personaName) || '未命名人设'}`);
    lines.push('');
    lines.push('> 这是虚构角色设定；能力以宿主机器人为准，不代表真人。');
    lines.push('');
    lines.push('## 身份');
    lines.push(`- 一句话身份：${trim(f.persona.role) || '—'}`);
    lines.push(`- 年龄：${trim(f.persona.age) || '—'}`);
    lines.push(`- 世界 / 背景：${trim(f.persona.world) || '—'}`);
    if (b.month && b.day) lines.push(`- 生日：${b.month} 月 ${b.day} 日${b.sign ? ` · ${b.sign.name}` : ''}${b.animal ? ` · 生肖${b.animal}` : ''}`);
    lines.push('');
    lines.push('## 性格');
    lines.push(`- 性格关键词：${trim(f.persona.traits) || '—'}`);
    lines.push(`- 核心欲望：${trim(f.persona.desire) || '—'}`);
    lines.push(`- 核心恐惧 / 弱点：${trim(f.persona.fear) || '—'}`);
    lines.push(`- 价值观排序：${trim(f.enhance.values) || '—'}`);
    lines.push(`- 决策算法：${trim(f.enhance.decide) || '—'}`);
    lines.push(`- 压力反应：${trim(f.enhance.stress) || '—'}`);
    lines.push(`- 情绪触发：${trim(f.enhance.emotion) || '—'}`);
    lines.push(`- MBTI：${m.type} ${m.name}${f.mbti.on ? '（会写进提示词）' : '（仅展示）'}${trim(f.mbti.note) ? `；补充：${trim(f.mbti.note)}` : ''}`);
    lines.push('');
    lines.push('## 语言');
    lines.push(`- 说话方式：${trim(f.persona.tone) || '—'}`);
    lines.push(`- 口头禅：${trim(f.persona.catch) || '—'}`);
    lines.push(`- 语言指纹：${trim(f.enhance.speech) || '—'}`);
    lines.push(`- 习惯小动作：${trim(f.enhance.habits) || '—'}`);
    lines.push(`- 状态值：${trim(f.enhance.meters) || '—'}`);
    lines.push(`- 回复长度：${REPLY_LENGTHS[f.replyStyle.length]?.label || '中等'}`);
    lines.push('');
    lines.push('## 群聊');
    lines.push(`- 接话逻辑：${trim(f.persona.logic) || '—'}`);
    lines.push(`- 对群里人的态度：${trim(f.persona.attitude) || '—'}`);
    lines.push(`- 当前状态：${trim(f.persona.status) || '—'}`);
    lines.push('');
    lines.push('## 关系与边界');
    lines.push(`- 底线与禁忌：${trim(f.enhance.limits) || '—'}`);
    lines.push(`- 秘密与信息差：${trim(f.enhance.secrets) || '—'}`);
    lines.push(`- 关系变化条件：${trim(f.enhance.relation) || '—'}`);
    lines.push(`- 成长 / 堕落条件：${trim(f.enhance.growth) || '—'}`);
    lines.push('');
    lines.push('## 对话样例');
    if (trim(f.enhance.lines)) { lines.push('示例台词：'); lines.push(trim(f.enhance.lines)); lines.push(''); }
    for (const k of schema.sceneKeys) {
      const v = trim(f.scenes[k]);
      if (v) lines.push(`- ${schema.sceneTable[k]?.label || k}：${v}`);
    }
    return lines.join('\n') + '\n';
  }

  function schemaFromState(state) {
    const meta = state?.customMeta;
    if (!meta || !meta.personaKeys || !meta.enhance || !meta.scenes) return clone(FALLBACK_SCHEMA);
    const ps = meta.personaStudio || {};
    const base = clone(FALLBACK_SCHEMA);
    return {
      source: 'online',
      personaKeys: meta.personaKeys.slice(),
      personaLongKeys: ps.longKeys || meta.personaLongKeys || base.personaLongKeys,
      personaLabels: ps.labels || meta.personaLabels || base.personaLabels,
      enhanceKeys: meta.enhanceKeys || meta.enhance.keys || base.enhanceKeys,
      enhanceTable: meta.enhance.table || base.enhanceTable,
      enhanceShortKeys: meta.enhanceShortKeys || base.enhanceShortKeys,
      sceneKeys: Object.keys(meta.scenes || {}),
      sceneTable: meta.scenes || base.sceneTable,
      mbti: {
        axes: meta.mbti?.axes || base.mbti.axes,
        types: meta.mbti?.types || base.mbti.types,
        defaultAxes: base.mbti.defaultAxes,
        noteMax: ps.limits?.mbtiNote || base.mbti.noteMax,
      },
      birthday: { signs: meta.birthday?.signs || base.birthday.signs, animals: meta.birthday?.animals || base.birthday.animals },
      replyLengths: meta.replyLengths || base.replyLengths,
      limits: ps.limits || base.limits,
      budgets: ps.budgets || base.budgets,
      basePersonaChars: Number.isFinite(ps.basePersonaChars) ? ps.basePersonaChars : base.basePersonaChars,
    };
  }

  const PersonaStudioCore = {
    VERSION, CHAPTERS, PRESETS, PERSONA_KEYS, ENHANCE_KEYS, SCENE_KEYS, BOUNDARY_OPTIONS, FALLBACK_SCHEMA,
    clone, trim, getPath, setPath, normalizeFields, createDraft, fromState, fromCard, findPreset,
    applyAnswers, setField, resetField, limitOf, charCount, typeFromAxes, axesForType, mbtiInfo,
    signOf, animalOf, birthdayInfo, compile, budgetOfDraft, validate, completeness,
    exportJson, exportMarkdown, schemaFromState, splitTraits,
  };

  root.PersonaStudioCore = PersonaStudioCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
