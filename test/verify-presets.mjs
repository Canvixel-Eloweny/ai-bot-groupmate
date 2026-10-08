/**
 * 各家大脑预设 / 跨服务商防呆 的接口级验证（在沙箱副本里跑，不碰真实配置）。
 * 逐条断言，最后打印汇总。
 */
import fs from 'node:fs';
// 判据只有一份实现（B11c · AR-DATADRIVEN）。
// 这几条断言原来写的是 `/deepseek\.com/.test(url)` —— 那等于在**测试里也抄一份判据**，
// 改规则时要多改一处。现在改用同一份 `providerOf()`：
// 它仍然能抓住"预设把地址写错了"（写错 → 落到 `other` → 红），
// 但不再要求测试知道"DeepSeek 的地址长什么样"。
import { providerOf } from '../src/net-rules.js';

const BASE = process.env.VERIFY_BACKEND || 'http://127.0.0.1:8790';
const CFG = process.env.VERIFY_CONFIG || '/tmp/qqbot-sandbox/config.json';

let pass = 0;
let fail = 0;
const bad = [];

function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    bad.push(name);
    console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`);
  }
}

/** 沙箱面板的 token（B9c · AUTH-PANEL）。沙箱**同样强制鉴权**，值是固定的，
 *  由 `test/sandbox.sh` 导出到这里与面板两侧共享 —— 任一侧拿错都会是明确的 401，
 *  而不是"有的接口通有的不通"。
 *
 *  @sync-with panel-token-env
 *    变量名与 `src/panel-auth.js` 的 `TOKEN_ENV`、`test/sandbox.sh` 的设置处必须逐字相同
 *    （`check-wb` 第 9 节契约比对）。 */
const TOKEN = process.env.QQBOT_PANEL_TOKEN || '';

async function api(path, body) {
  const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
  const init = { headers };
  if (body) {
    init.method = 'POST';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + path, init);
  const txt = await r.text();
  let data = null;
  try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
  return { status: r.status, data };
}

const cfg = () => JSON.parse(fs.readFileSync(CFG, 'utf8'));

console.log('\n【S0】B9 前置：沙箱配置副本必须已经完全脱敏（并在此刻取 Key 快照）');
{
  // 判据不在这里重写：复用 scripts/sanitize-config.mjs 的 findLeaks（一份真相源）。
  // 检的是**磁盘上那个副本**，不是内存对象 —— 排查泄漏时能信的只有落盘的那份。
  //
  // ⚠️ 必须放在**任何写操作之前**：后面的用例会通过 /api/switch 与 /api/config 把预设
  //    物化回配置里，那时凭据字段已经不是脱敏器写的那份了。（第一版把这段放在最后，
  //    结果误报三处 —— 详见 B9 报告「偏差」一节。）
  let leaks = null;
  try {
    const { findLeaks } = await import('../scripts/sanitize-config.mjs');
    leaks = findLeaks(JSON.parse(fs.readFileSync(CFG, 'utf8')));
  } catch (e) {
    leaks = [`读不了/解析不了 ${CFG}: ${e.message}`];
  }
  check(
    '★ 沙箱配置副本里没有任何真凭据（K-SANDBOX）',
    Array.isArray(leaks) && leaks.length === 0,
    leaks && leaks.length ? leaks.slice(0, 3).join('；') : `${CFG} 干净`
  );
}

/**
 * 「切服务商应当换回它自己那把 Key」必须靠**配置里的实际值**来判，不能写死前缀。
 *
 * ⚠️ 这两条断言原本写的是 `/^sk-f8c/` 与 `/^7eaa8f/` —— 那是**真实 Key 的前几位**，
 *    内嵌在一个受版本控制的测试文件里。它既是一处不该有的泄露，也让沙箱脱敏变成不可能
 *    （凭据被换成假值之后，那两条断言必然挂）。改成快照比对：语义更强（比对的是完整值），
 *    且不含任何秘密。沙箱里这把值本身是脱敏器造的假值，形如 `SANDBOX-FAKE-zhipu`。
 */
const KEYS0 = { ...(cfg().llm.keys || {}) };

console.log('\n【0】前置：把大脑置回智谱（保证测试可重复运行，不受当前配置影响）');
{
  const r = await api('/api/switch', { target: 'zhipu' });
  check('已切到智谱', r.data.ok === true && r.data.preset === 'zhipu', r.data.msg);
}

/**
 * 【1】记下智谱的备用链，【7】用来验「切走再切回不丢」。
 * 刻意**不写死条数**：默认链由后端给（state.zhipuDefaultChain），
 * 写死数字的话以后每调一次默认顺序都得回来改测试 —— 那是测试在拖后腿。
 */
let baseChain = [];

console.log('\n【1】初始状态');
{
  const { data } = await api('/api/state');
  check('state 读得到', data && !data.error);
  check('activePreset = zhipu', data.config.activePreset === 'zhipu', data.config.activePreset);
  check('四套预设都在（2026-10-07 加千问）',
    ['local', 'deepseek', 'zhipu', 'qwen'].every((k) => data.config.presets[k]),
    Object.keys(data.config.presets || {}).join(','));
  check('本机预设带合法的推理通道', ['mlx', 'qwenchat'].includes(data.config.presets.local.channel), String(data.config.presets.local.channel));
  baseChain = [...(data.config.presets.zhipu.fallbackModels || [])];
  check('zhipu 有降级链（主模型之外还有备用）', baseChain.length > 0, `备用 ${baseChain.length} 条`);
  check('智谱主模型是 glm-*', /^glm/i.test(data.config.presets.zhipu.model || ''), data.config.presets.zhipu.model);
  // 面板上「优先级线路」的徽标（实测延迟 / 额度包 / 免费）全靠这两份下发数据，
  // 前端不另存一份 —— 少下发一个，那一列徽标就会整片消失
  check('★ state 下发了智谱模型档案 zhipuMeta',
    !!data.zhipuMeta && Object.keys(data.zhipuMeta).length >= 10,
    String(Object.keys(data.zhipuMeta || {}).length) + ' 条');
  check('★ state 下发了默认链路 zhipuDefaultChain',
    Array.isArray(data.zhipuDefaultChain) && data.zhipuDefaultChain.length > 0,
    JSON.stringify(data.zhipuDefaultChain || []).slice(0, 70));

  // ── 2026-10-07 接千问：五条"下发了才画得出来 / 判得对"的东西 ────────────────
  // 每一条都对应一个**漏了不报错**的失效形态，写在注释里，方便下一个人知道为什么留着它们。
  const qp = data.config.presets.qwen || {};
  // ① 地址必须是**API 域名**，不能是控制台域名。
  //    漏/写错的症状：切过去"看着成功"，然后每条消息都失败，而失败来自一个网页服务器。
  check('★ 千问预设带的是官方 API 地址（不是控制台域名）',
    providerOf(qp.baseUrl) === 'qwen' && !/qianwenai/i.test(qp.baseUrl || ''),
    String(qp.baseUrl));
  // ② 主模型 + 降级链。千问的额度**按模型发**，所以链长是它的一半价值。
  check('★ 千问主模型是 qwen-* 且带降级链',
    /^qwen/i.test(qp.model || '') && (qp.fallbackModels || []).length > 0,
    `${qp.model} + 备用 ${(qp.fallbackModels || []).length} 条`);
  // ③ 能力表。**判据是"按（服务商，模型）算好的"**，不是"有这张表"——
  //    只差一个 key 的症状是千问那页的开关全灰（`modelCaps.qwen` 取不到 → 判成"不支持"），
  //    而页面其余部分完全正常。
  check('★ 千问的能力表按 (服务商,模型) 下发了 modelCaps.qwen',
    Object.keys(data.modelCaps?.qwen || {}).length > 0
      && Array.isArray(data.modelCaps?.qwen?.[qp.model]?.levels),
    `${Object.keys(data.modelCaps?.qwen || {}).length} 个模型`);
  // ④ 免费额度说明（唯一实现住 src/free-quota.js）。四家都要有。
  check('★ state 下发了四家的免费额度说明 quotaPlans',
    ['local', 'deepseek', 'zhipu', 'qwen'].every((p) => data.quotaPlans?.[p]?.kindNote),
    Object.keys(data.quotaPlans || {}).join(','));
  // ⑤ **两条反向断言**，它们才是这张卡存在的理由：
  //    · 千问必须照实标 `liveBalance: 'none'` —— 它的用量查询要账号级签名，API Key 查不到。
  //      改成 `'api'` 会让界面显示一个**编出来的**余额（比没有更糟：它看起来更专业）。
  //    · 千问必须带上「用完即停」那句提醒 —— 那个开关默认是关的，不开就静默扣钱，
  //      而这句提醒是用户唯一会在意的地方。它腐烂时页面看起来完全正常。
  check('★ 千问照实标了"查不到实时余额"（不许编数字）',
    data.quotaPlans?.qwen?.liveBalance === 'none',
    String(data.quotaPlans?.qwen?.liveBalance));
  check('★ 千问带上了「免费额度用尽即停」那句提醒',
    /用尽即停/.test(data.quotaPlans?.qwen?.mustDo || ''),
    String(data.quotaPlans?.qwen?.mustDo || '').slice(0, 40));

  // ⑥ 脱敏器也要认得千问（打的是"沙箱副本"那条路，不是浏览器那条）。
  //    漏加的症状与上面【1b】那条同源，但**更难查**：沙箱里切到千问时，
  //    `llm.apiKey` 的假值会被造名成 `SANDBOX-FAKE-apiKey`，而紧接着的
  //    `stashCurrentPreset` 又把它归档进 `keys.qwen` ⇒ **覆盖**掉那格本来正确的假值。
  //    表现是另一条完全不相干的断言（"切走再切回来 Key 变了"）莫名其妙地挂。
  //    直接喂纯函数，比隔着沙箱去追更快也更准。
  {
    const { sanitizeConfig, FAKE_CREDENTIAL_PREFIX } = await import('../scripts/sanitize-config.mjs');
    const s = sanitizeConfig({
      llm: {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'whatever-this-would-be',
        keys: { qwen: 'whatever-this-would-be' },
      },
    }, { credentials: 'fake' });
    check('★ 脱敏器认得千问（当前大脑是千问 ⇒ 假值就该叫 qwen）',
      s.llm.apiKey === `${FAKE_CREDENTIAL_PREFIX}qwen`,
      String(s.llm.apiKey));
  }
}

console.log('\n【2】跨服务商防呆：智谱页上填 DeepSeek 的模型');
{
  const r = await api('/api/config', { model: 'deepseek-flash' });
  check('被拒绝（HTTP 400）', r.status === 400, String(r.status));
  check('错误信息说清了原因', /deepseek/i.test(r.data.error || '') && /智谱/.test(r.data.error || ''), r.data.error);
  check('config.json 没有被写脏', cfg().llm.model !== 'deepseek-flash', cfg().llm.model);
}

console.log('\n【2b】千问：切过去、拿它自己那把 Key、再切回来不丢（2026-10-07）');
{
  // 切走之前先把智谱那份**逐字**记下来（深拷贝），【2b】末尾用来验"切回来还在"。
  const zhipuBefore = JSON.parse(JSON.stringify(cfg().llm.presets.zhipu));

  const r = await api('/api/switch', { target: 'qwen' });
  // ⚠️ `preset` 这个回执字段是**真的有判别力**的：`apiSwitch` 里那张 `ALT_TARGET` 表
  //    若漏了 `qwen`，它会被兜底成 `'local'`（切本机），于是这里 `r.data.preset` 是 `local`
  //    —— 而这正是"点了『用千问』、本机模型莫名其妙被拉起来"那个形态。
  check('已切到千问（target 没被兜底成 local）',
    r.data.ok === true && r.data.preset === 'qwen', `${r.data.preset}｜${r.data.msg}`);

  const c = cfg();
  check('baseUrl → 千问（按地址判得出服务商）', providerOf(c.llm.baseUrl) === 'qwen', c.llm.baseUrl);
  check('地址里没有控制台域名（填错会被 baseUrlReject 拒）',
    !/qianwenai/i.test(c.llm.baseUrl), c.llm.baseUrl);
  check('model → qwen-*（不是 GLM）', /^qwen/i.test(c.llm.model || ''), c.llm.model);
  check('降级链非空（千问额度按模型发，一条链等于几份额度）',
    (c.llm.fallbackModels || []).length > 0, `备用 ${(c.llm.fallbackModels || []).length} 条`);
  // ★ 最要紧的一条：取回的是**它自己那一格**的 Key。
  //   写成"两边都空也算过"是刻意的：真机的 `keys.qwen` 现在是空的（用户还没填），
  //   而正确行为就是"空着、并提示去填"，**不是**退化成拿智谱那把。
  //   所以这条断言同时覆盖了"空对空"与"有值对值"两种情形，且能抓出张冠李戴。
  check('★ 取回的 Key 与 keys.qwen 一致（空对空也算过，但不许张冠李戴）',
    c.llm.apiKey === (KEYS0.qwen || ''),
    `apiKey=${String(c.llm.apiKey).slice(0, 20)}｜keys.qwen=${String(KEYS0.qwen).slice(0, 20)}`);

  const st = await api('/api/state');
  check('★ state.keySaved 里有 qwen（名单已从 PRESET_KEYS 派生，不再手写）',
    'qwen' in (st.data.config.keySaved || {}),
    Object.keys(st.data.config.keySaved || {}).join(','));

  await api('/api/switch', { target: 'zhipu' });
  const back = cfg();
  check('★ 切回智谱：那份预设一字未变（千问没把它冲掉）',
    JSON.stringify(back.llm.presets.zhipu) === JSON.stringify(zhipuBefore),
    `${back.llm.model}｜链 ${(back.llm.fallbackModels || []).length} 条`);
  check('切回智谱后模型还是 glm-*', /^glm/i.test(back.llm.model || ''), back.llm.model);
}

console.log('\n【3】同页正确模型：正常保存');
{
  const r = await api('/api/config', { model: 'glm-4-flash' });
  check('保存成功', r.status === 200 && r.data.ok === true, JSON.stringify(r.data).slice(0, 120));
  check('config.json 已更新', cfg().llm.model === 'glm-4-flash', cfg().llm.model);
  check('回写进了 zhipu 预设', cfg().llm.presets.zhipu.model === 'glm-4-flash', cfg().llm.presets.zhipu.model);
  check('没有污染 deepseek 预设', cfg().llm.presets.deepseek.model === 'deepseek-flash', cfg().llm.presets.deepseek.model);
}

console.log('\n【4】能力开关按**模型**收敛（2026-09-18 起不再是按服务商一刀切）');
{
  // 前置：【3】刚把模型设成 glm-4-flash —— 纯文本模型，实测发图必 400
  const r0 = await api('/api/config', { features: { webSearch: true, vision: true, stickers: true } });
  check('保存成功', r0.data.ok === true);
  const c0 = cfg();
  check('★ 联网被存下（glm-4-flash 实测支持 web_search）', c0.llm.features.webSearch === true);
  check('★ 识图在纯文本模型上被自动掐掉（glm-4-flash 发图会 400，存了就是哑弹）',
    c0.llm.features.vision === false, JSON.stringify(c0.llm.features));

  // 换到视觉模型再开 —— glm-4.6v 实测"认图但搜索结果不注入"，
  // 两个模型各支持一半，正好把"按模型收敛"的两面都测到
  await api('/api/config', { model: 'glm-4.6v' });
  const r1 = await api('/api/config', { features: { webSearch: true, vision: true, stickers: true } });
  const c1 = cfg();
  check('★ 视觉模型（glm-4.6v）上识图存得下', c1.llm.features.vision === true, JSON.stringify(c1.llm.features));
  check('★ 联网在 glm-4.6v 上被掐掉（实测视觉模型不注入搜索结果，开着等于白开）',
    c1.llm.features.webSearch === false, JSON.stringify(c1.llm.features));
  check('存下的开关进了 zhipu 预设', c1.llm.presets.zhipu.features.vision === true);
}

console.log('\n【5】切到 DeepSeek（前端传的 target 是 "cloud"）：应当物化它自己那套');
{
  const r = await api('/api/switch', { target: 'cloud' });
  check('切换成功', r.data.ok === true, r.data.msg);
  check('返回的预设键是 deepseek', r.data.preset === 'deepseek', String(r.data.preset));
  const c = cfg();
  check('baseUrl → DeepSeek', providerOf(c.llm.baseUrl) === 'deepseek', c.llm.baseUrl);
  check('model → deepseek-flash（不是 GLM）', c.llm.model === 'deepseek-flash', c.llm.model);
  check('降级链被清空（DeepSeek 无备用链）', (c.llm.fallbackModels || []).length === 0);
  check(
    'Key 换成了 DeepSeek 那把（与智谱那把不同）',
    !!KEYS0.deepseek && c.llm.apiKey === KEYS0.deepseek && KEYS0.deepseek !== KEYS0.zhipu,
    `apiKey=${String(c.llm.apiKey).slice(0, 20)}｜keys.deepseek=${String(KEYS0.deepseek).slice(0, 20)}｜keys.zhipu=${String(KEYS0.zhipu).slice(0, 20)}`
  );
  check('★ 联网开关被自动关掉（DeepSeek 不认 web_search）', c.llm.features.webSearch === false);
  check('★ 识图开关被自动关掉（DeepSeek 无视觉模型）', c.llm.features.vision === false);
  check('zhipu 预设原样保留（切回来不丢）', c.llm.presets.zhipu.features.vision === true,
    JSON.stringify(c.llm.presets.zhipu.features));
}

console.log('\n【6】在 DeepSeek 页上硬开联网：后端第二道闸应当掐掉');
{
  await api('/api/config', { features: { webSearch: true, vision: false, stickers: true } });
  const c = cfg();
  check('★ 写进配置的联网仍是 false', c.llm.features.webSearch === false);
  check('deepseek 预设里也没有被污染', c.llm.presets.deepseek.features.webSearch === false);
}

console.log('\n【7】切回智谱：智谱自己的设置应当原样回来');
{
  const r = await api('/api/switch', { target: 'zhipu' });
  check('切换成功', r.data.ok === true, r.data.msg);
  const c = cfg();
  check('baseUrl → 智谱', providerOf(c.llm.baseUrl) === 'zhipu', c.llm.baseUrl);
  // 预设里存的是 vision:true / webSearch:false（【4】在 glm-4.6v 上收敛后的结果）。
  // 切回来"原样回来"的语义 = 模型支持的照常恢复、不支持的被收敛闸摁住
  check('★ 识图恢复为 true（glm-4.6v 支持视觉）', c.llm.features.vision === true, JSON.stringify(c.llm.features));
  check('★ 联网保持收敛（glm-4.6v 实测不注入搜索结果）', c.llm.features.webSearch === false, JSON.stringify(c.llm.features));
  check('★ 切回来后备用链一条不多一条不少',
    JSON.stringify(c.llm.fallbackModels || []) === JSON.stringify(baseChain),
    `${(c.llm.fallbackModels || []).length} 条 vs 原 ${baseChain.length} 条`);
  check(
    'Key 换回智谱那把（与快照逐字相同）',
    !!KEYS0.zhipu && c.llm.apiKey === KEYS0.zhipu,
    `apiKey=${String(c.llm.apiKey).slice(0, 20)}｜keys.zhipu=${String(KEYS0.zhipu).slice(0, 20)}`
  );
}

console.log('\n【8】切到本机：本机预设单独一套值（沙箱里会因找不到脚本而失败，但配置该先写好）');
{
  // 故意传 9b —— 9B 已从这台机器移除，应当自动回落到 4b，而不是留下一个指向不存在目录的路径
  const r = await api('/api/switch', { target: 'local', size: '9b' });
  check('沙箱里如实报失败（找不到启动脚本）', r.data.ok === false, r.data.msg);
  const c = cfg();
  check('baseUrl → 本机（端口对应所选通道）',
    new RegExp(`127\\.0\\.0\\.1:(${c.llm.presets.local.channel === 'qwenchat' ? 18765 : 18080})/v1`).test(c.llm.baseUrl),
    c.llm.baseUrl);
  check('★ 传 9b 被回落到 4B（9B 已移除，不能留个死路径）', /4B-MLX-4bit/.test(c.llm.model), c.llm.model);
  check('★ 单条上限压到本机的 160', c.llm.maxTokens === 160, String(c.llm.maxTokens));
  check('★ 上下文压到 8 轮 / 8 条', c.context.recentTurns === 8 && c.context.ambientMessages === 8);
  check('★ 本机预设也回落成 4b', c.llm.presets.local.size === '4b', c.llm.presets.local.size);
  check('★ 联网/识图在本机自动关掉', c.llm.features.webSearch === false && c.llm.features.vision === false);
  check('云端预设没被本机的值污染', c.llm.presets.zhipu.maxTokens === 400 && c.llm.presets.zhipu.context.recentTurns === 12);
}

console.log('\n【9】本机页填云端模型名：应当拒绝');
{
  const r = await api('/api/config', { model: 'glm-4-flash' });
  check('被拒绝（HTTP 400）', r.status === 400, String(r.status));
  check('提示指向本机路径写法', /本机/.test(r.data.error || ''), r.data.error);
}

console.log('\n【10】模型候选列表按服务商分开（不再串台）');
{
  const z = await api('/api/models?provider=zhipu');
  check('智谱列表非空', (z.data.models || []).length > 0);
  check('★ 智谱列表含官方免费档 glm-4.7-flash', (z.data.models || []).includes('glm-4.7-flash'));
  check('★ 智谱列表不含 deepseek-*', !(z.data.models || []).some((m) => /deepseek/i.test(m)), (z.data.models || []).join(',').slice(0, 80));

  const d = await api('/api/models?provider=deepseek');
  check('★ DeepSeek 列表不含 glm-*', !(d.data.models || []).some((m) => /^glm/i.test(m)), (d.data.models || []).join(','));
  check('DeepSeek 列表含 flash 与 v4-pro', (d.data.models || []).includes('deepseek-flash') && (d.data.models || []).includes('deepseek-v4-pro'));

  const l = await api('/api/models?provider=local');
  check('★ 本机列表只剩 4b（9B 已移除）', l.data.models.join(',') === '4b', (l.data.models || []).join(','));
}

console.log('\n【11】思考档位「最高」不再被悄悄降级，且不会串到别的大脑');
{
  const sw = await api('/api/switch', { target: 'zhipu' });
  check('先切回智谱', sw.data.ok === true, sw.data.msg);
  const localBefore = cfg().llm.presets.local.thinking;
  // DeepSeek 那套的值是「它第一次被使用/被保存时」从当时的配置承接过来的，不该被这次改动碰到
  const dsBefore = cfg().llm.presets.deepseek.thinking;
  const r = await api('/api/config', { thinking: { mode: 'on', level: 'max' } });
  check('保存成功', r.data.ok === true);
  const c = cfg();
  check('★ config.json 里 level 就是 max', c.llm.thinking.level === 'max', c.llm.thinking.level);
  check('★ 存进了 zhipu 预设', c.llm.presets.zhipu.thinking.level === 'max', JSON.stringify(c.llm.presets.zhipu.thinking));
  check(
    '★ 本机预设的思考设置没被改动',
    JSON.stringify(c.llm.presets.local.thinking) === JSON.stringify(localBefore),
    JSON.stringify(c.llm.presets.local.thinking)
  );
  check('★ DeepSeek 预设的思考设置也没被改动', JSON.stringify(c.llm.presets.deepseek.thinking) === JSON.stringify(dsBefore), JSON.stringify(c.llm.presets.deepseek.thinking));
  check('识图仍留在智谱这边（glm-4.6v 支持）', c.llm.features.vision === true, JSON.stringify(c.llm.features));
}

console.log('\n【12】换二维码接口：要么换成功，要么给一句人话');
{
  // 沙箱里 docker 一定连不上：假 HOME 会让 docker CLI 去找 /var/run/docker.sock，
  // 而 Docker Desktop 的 socket 在用户目录里 —— 于是所有 docker 分支在沙箱里只可能走
  // 「容器没在运行」这条路（隔离得干净，顺带也让这条断言是确定的）。
  // 真机上容器在跑时才会走上面那条分支（会真的换一张码，等价于点一下「换一张」）。
  const r = await api('/api/qrcode/refresh', {});
  if (r.status === 200) {
    check('容器在跑：换码成功并回传二维码地址', r.data.ok === true && typeof r.data.qr === 'string', JSON.stringify(r.data));
  } else {
    check('★ 容器没跑时返回 400 而不是 500', r.status === 400, String(r.status));
    check('★ 报错内容是可读的原因（不是 undefined/堆栈）',
      typeof r.data.msg === 'string' && r.data.msg.length > 4 && !/at .*\(/.test(r.data.msg),
      JSON.stringify(r.data));
    check('★ 不谎报成功', r.data.ok !== true, JSON.stringify(r.data));
  }
}

console.log('\n【13】优先级线路：拖动排序落盘（/api/config 的 model + fallbackModels）');
{
  await api('/api/switch', { target: 'zhipu' });

  // 自建基线，**不依赖沙箱里"碰巧"存在的那条链路**。
  // 以前这里先记下当前配置、结尾再复原 —— 环境一变（真实配置里只剩 5 条）断言就挂，
  // 那是测试在拖后腿。现在开头就把链路设成已知值，结尾复原到这个已知值。
  // 基线里主模型与备用刻意不重叠，这样"去重"不会干扰"复位"的比对。
  const BASE = { model: 'glm-4.5-air', fallbackModels: ['glm-4.6v', 'glm-4.7'] };
  const setBase = await api('/api/config', BASE);
  check('基线线路已写入（后续断言都基于它）', setBase.data.ok === true, JSON.stringify(setBase.data).slice(0, 100));

  // 模拟"用户把 glm-4.6v 拖到第 1 位"：第 1 项走 model，其余走 fallbackModels
  const r = await api('/api/config', { model: 'glm-4.6v', fallbackModels: ['glm-4.5-air', 'glm-4.7'] });
  check('保存成功', r.status === 200 && r.data.ok === true, JSON.stringify(r.data).slice(0, 120));
  const c = cfg();
  check('★ 主模型写进了扁平字段（机器人真正读的那个）', c.llm.model === 'glm-4.6v', c.llm.model);
  check('★ 降级链也写进了扁平字段', JSON.stringify(c.llm.fallbackModels) === JSON.stringify(['glm-4.5-air', 'glm-4.7']), JSON.stringify(c.llm.fallbackModels));
  check('★ 同步回写了 zhipu 预设（切走再切回不丢）', c.llm.presets.zhipu.model === 'glm-4.6v', c.llm.presets.zhipu.model);
  check('★ 没有污染 DeepSeek 预设', (c.llm.presets.deepseek.fallbackModels || []).length === 0);

  // 去重：同一模型拖两次不该在链里出现两遍（否则每轮都要多打一次）
  await api('/api/config', { model: 'glm-4.6v', fallbackModels: ['glm-4.5-air', 'glm-4.5-air', 'glm-4.7', 'glm-4.6v'] });
  check('★ 降级链里的重复项被去掉（含与主模型重复的那个）',
    JSON.stringify(cfg().llm.fallbackModels) === JSON.stringify(['glm-4.5-air', 'glm-4.7']),
    JSON.stringify(cfg().llm.fallbackModels));

  // 跨服务商：往智谱的链里塞 deepseek 的模型必须被拦
  const bad = await api('/api/config', { model: 'glm-4.6v', fallbackModels: ['deepseek-flash'] });
  check('★ 链里塞别家模型被拒（HTTP 400）', bad.status === 400, String(bad.status));
  check('★ 拒绝时说了原因', /deepseek/i.test(bad.data.error || ''), bad.data.error);

  // 实测会 400 的模型（始终思考）：这是本轮专门加的一道闸。
  // 放进链里的后果比"不生效"严重得多 —— 400 不可重试，整条链都不会被触发。
  const banned = await api('/api/config', { model: 'glm-4.6v', fallbackModels: ['glm-5.3'] });
  check('★ 不支持关思考的模型被拒进链（HTTP 400）', banned.status === 400, String(banned.status));
  check('★ 拒绝理由说清了"不支持关闭思考"', /思考/.test(banned.data.error || ''), banned.data.error);
  check('★ 被拒后链没有被写坏', JSON.stringify(cfg().llm.fallbackModels) === JSON.stringify(['glm-4.5-air', 'glm-4.7']), JSON.stringify(cfg().llm.fallbackModels));

  // ★ 一条实战教训钉成断言：真实配置里的链路曾从 7 条**悄悄变成 5 条**，
  //   尾部的两个官方免费档（glm-4.7-flash / glm-4.6v-flash）无声消失。
  //   静默截断比报错危险得多 —— 链路短了两条，降级时会直接无模型可用。
  //   这里要求整条链路原样往返，任何地方加了截断都会立刻红。
  const full = ['glm-4.6v', 'glm-4.7', 'glm-5.2', 'glm-5', 'glm-4-flash', 'glm-4.7-flash', 'glm-4.6v-flash'];
  await api('/api/config', { model: 'glm-4.5-air', fallbackModels: full });
  check('★ 7 条链路原样往返，没有被静默截断',
    JSON.stringify(cfg().llm.fallbackModels) === JSON.stringify(full),
    JSON.stringify(cfg().llm.fallbackModels));
  check('★ 预设里也一条不少（切走再切回不会变短）',
    JSON.stringify(cfg().llm.presets.zhipu.fallbackModels) === JSON.stringify(full),
    JSON.stringify(cfg().llm.presets.zhipu.fallbackModels));

  // 复原到自建基线，别把沙箱状态留给后面的用例
  await api('/api/config', BASE);
  check('线路可复位（回到自建基线）',
    JSON.stringify(cfg().llm.fallbackModels) === JSON.stringify(BASE.fallbackModels)
      && cfg().llm.presets.zhipu.model === BASE.model,
    `链 ${JSON.stringify(cfg().llm.fallbackModels)} / 主 ${cfg().llm.presets.zhipu.model}`);
}

console.log('\n【14】智谱候选名单：glm-5.3 可以露脸，但能力档案必须如实标注');
{
  const m = await api('/api/models?provider=zhipu');
  const list = m.data.models || [];
  // 2026-09-18 起行为升级：glm-5.3 / glm-5.3-flash 不再被一刀切踢出名单 ——
  // 有了按模型收敛的能力，选中它们后界面会禁用「关闭思考」、后端也绝不会再发
  // disabled 过去。「能选且点了有用」比「看不见」好（不能选的才是黑名单，如 glm-ocr）。
  check('★ glm-5.3 在名单里（选中后关闭思考会被禁用，而不是整个消失）', list.includes('glm-5.3'), list.join(','));
  check('★ glm-5.3-flash 也在名单里', list.includes('glm-5.3-flash'), list.join(','));
  // 档案必须如实：它们是"始终思考"（think: 'always'），前端靠这个字段禁用关闭按钮
  const st = await api('/api/state');
  const meta = st.data.zhipuMeta || {};
  check('★ 档案标注 glm-5.3 为始终思考（界面据此禁用「关闭」）',
    meta['glm-5.3']?.think === 'always', JSON.stringify(meta['glm-5.3'] || {}));
  check('★ 档案标注 glm-4-flash 为不思考（实测思考 token 恒为 0）',
    meta['glm-4-flash']?.think === 'none', JSON.stringify(meta['glm-4-flash'] || {}));
  check('★ 纯 OCR 模型（glm-ocr）不许进对话名单', !list.includes('glm-ocr'), list.join(','));
  check('★ 官方免费档仍在名单里（智谱接口不返回它们，靠内置补齐）',
    list.includes('glm-4.7-flash') && list.includes('glm-4.6v-flash'), list.join(','));
  check('★ 有专属额度的三档都在', ['glm-4.5-air', 'glm-4.6v', 'glm-4.7'].every((x) => list.includes(x)), list.join(','));
}

console.log('\n【15】赠送额度接口 /api/zhipu/packages');
{
  // 沙箱复制的是真实 config.json（含真实 Key），所以这里会**真去打智谱接口**。
  // 断言只要求"结构正确、能优雅失败"—— 余额数字是活的，不能写死。
  const r = await api('/api/zhipu/packages');
  check('接口返回 200（不管查没查到，都不该 5xx）', r.status === 200, String(r.status));
  check('返回体带 ok 字段', typeof r.data.ok === 'boolean', JSON.stringify(r.data).slice(0, 120));
  if (r.data.ok) {
    const rows = r.data.rows || [];
    check('★ 只返回按 token 计费的包（搜索/视频次数包被滤掉）',
      rows.every((x) => Number.isFinite(x.available) && Number.isFinite(x.total)),
      JSON.stringify(rows).slice(0, 120));
    check('★ 每行都有名称与总额度', rows.every((x) => x.name && x.total > 0));
    check('★ 可用额度不超过总额度（分子不大于分母）', rows.every((x) => x.available <= x.total));
    check('返回了 4 个推理包', rows.length === 4, `实际 ${rows.length} 个`);
  } else {
    // Key 没填 / 网络不通时也必须给出人话，而不是抛异常
    check('★ 失败时给的是可读原因', typeof r.data.error === 'string' && r.data.error.length > 4, JSON.stringify(r.data));
  }
}

console.log('\n【16】技能注册表 / 人设指纹 / 新增字段归一化（纯函数，不走 HTTP）');
let savedCustom = null;
{
  const { pickSkillsForPrompt, scopeMatches } = await import('../src/skills.js');
  const { readCustom, personaFingerprint, SKILL_IN_PROMPT } = await import('../src/custom-config.js');

  // ── 作用范围 ──
  check('★ 全局技能对所有会话生效', scopeMatches({ type: 'global', id: '' }, { groupId: '1' }) === true);
  check('★ 群范围技能只在自己那个群生效',
    scopeMatches({ type: 'group', id: '100' }, { groupId: '100' }) === true
    && scopeMatches({ type: 'group', id: '100' }, { groupId: '200' }) === false);
  check('★ 人范围技能按 QQ 号匹配',
    scopeMatches({ type: 'user', id: '42' }, { userId: '42' }) === true
    && scopeMatches({ type: 'user', id: '42' }, { userId: '43' }) === false);
  // 这条是刻意的设计：填漏了 id 的"群范围"技能必须哪儿都不生效 ——
  // 否则它会静默污染所有群，而用户根本看不出是哪条技能干的
  check('★ 填漏 id 的群/人范围技能哪儿都不生效（宁可无效，不可到处生效）',
    scopeMatches({ type: 'group', id: '' }, { groupId: '100' }) === false);

  // ── 挑选与上限 ──
  const mk = (id, over) => ({
    id, kind: 'pack', name: id, enabled: true, scope: { type: 'global', id: '' },
    triggers: [], background: '内容', examples: [], ...over,
  });
  const hit = (list, text = '') => pickSkillsForPrompt(list, { groupId: '100' }, text).map((s) => s.id);

  check('★ 停用的技能不注入', hit([mk('a', { enabled: false })]) .length === 0);
  check('★ 知识包填了触发词 → 不命中就不注入',
    hit([mk('a', { triggers: ['运势'] })], '今天天气不错').length === 0
    && hit([mk('a', { triggers: ['运势'] })], '看看我的运势').join() === 'a');
  check('★ 知识包没填触发词 → 每轮都带上（用户自己的选择）', hit([mk('a')]).join() === 'a');
  check('★ 角色卡同一个会话只取第一张（两张卡会互相打架）',
    hit([mk('c1', { kind: 'persona' }), mk('c2', { kind: 'persona' })]).join() === 'c1');
  check(`★ 同时命中的技能压到上限 ${SKILL_IN_PROMPT} 条`,
    hit([mk('a'), mk('b'), mk('c'), mk('d'), mk('e')]).length === SKILL_IN_PROMPT);

  // 总字数闸：超长的那条被跳过，后面短的那条还能进（不是一刀切砍掉整份列表）
  const long = mk('long', { background: 'x'.repeat(3000) });
  check('★ 单条超长时跳过它、但不影响后面的短技能', hit([long, mk('s')]).join() === 's');

  // ── 归一化 ──
  const norm = readCustom({
    custom: {
      persona: { age: '24', desire: 'D'.repeat(5000), role: 'R' },
      trigger: { quietHours: { from: 99, to: -3 } },
      skills: [
        { id: 'ok', kind: 'pack', name: '好的', background: 'B' },
        { id: 'bad-empty' },
        { id: 'weird-kind', kind: 'nonsense', name: 'W', background: 'B' },
        { id: 'no-scope-id', kind: 'pack', name: 'N', background: 'B', scope: { type: 'group', id: '' } },
      ],
    },
  });
  check('★ 叙述型字段用更宽的上限（1200，不是 300）', norm.persona.desire.length === 1200, String(norm.persona.desire.length));
  check('★ 短字段仍守 300 上限', norm.persona.role.length <= 300);
  check('★ 非法小时被钳回默认值（99 → 23，-3 → 8）',
    norm.trigger.quietHours.from === 23 && norm.trigger.quietHours.to === 8, JSON.stringify(norm.trigger.quietHours));
  check('★ 空技能被丢弃、未知 kind 归一成 pack、群范围缺 id 归一成空 id',
    norm.skills.length === 3 && norm.skills.find((s) => s.id === 'weird-kind').kind === 'pack'
    && norm.skills.find((s) => s.id === 'no-scope-id').scope.id === '',
    JSON.stringify(norm.skills.map((s) => s.id)));
  check('★ 场景表新增的两个（错别字 / 投诉）自动进了配置字段',
    'typo' in norm.scenes && 'complaint' in norm.scenes && Object.keys(norm.scenes).length >= 9,
    Object.keys(norm.scenes).join(','));

  // ── 人设指纹 ──
  const base = readCustom({ custom: { persona: { traits: '冷静' }, skills: [{ id: 'k', name: 'K', background: 'BG', enabled: true }] } });
  const f0 = personaFingerprint(base, '小鱼');
  check('★ 同样的输入指纹稳定', personaFingerprint(base, '小鱼') === f0);
  check('★ 改人设 → 指纹变（该丢旧发言了）',
    personaFingerprint({ ...base, persona: { ...base.persona, traits: '暴躁' } }, '小鱼') !== f0);
  check('★ 改昵称 → 指纹变', personaFingerprint(base, '大肥鱼') !== f0);
  check('★ 改启用中的技能背景 → 指纹变',
    personaFingerprint({ ...base, skills: [{ id: 'k', name: 'K', background: '换了', enabled: true }] }, '小鱼') !== f0);
  // 这条是设计决定，不是漏掉：记忆是渐变的，加一条就清空会话历史太粗暴
  check('★ 改记忆 → 指纹**不变**（记忆是渐变的，不该拿它清空历史）',
    personaFingerprint({ ...base, memory: { auto: false, manual: [{ id: 'm', text: '新记忆', on: true, t: 1 }] } }, '小鱼') === f0);
}

console.log('\n【17】技能 / 新人设字段 / 免打扰时段 / 黑名单 落盘往返');
{
  // 先写 —— 后面的「导入前预览」和「导出」都依赖沙箱里**已经有技能存在**。
  // 测试顺序就是依赖顺序：读的断言必须排在写的断言后面，否则会得到
  // "技能导出里一条都没有"这种**看起来像 bug、其实是测试自己抢跑**的假失败。
  const st0 = (await api('/api/state')).data;
  savedCustom = st0.custom; // 收尾要还原

  const r = await api('/api/config', {
    denyGroups: ['99999999'], denyUsers: ['88888888'],
    custom: {
      persona: {
        age: '24', role: '程序员', world: '近未来都市', desire: '想被认可', fear: '被无视',
        traits: '毒舌、心软', tone: '短句', logic: '先观察再动手', attitude: '试探', status: '刚进群',
        catch: '那没事了', faces: '狗头',
      },
      personaResetOnChange: true,
      replyStyle: { multiMessage: false },
      trigger: { quietHours: { from: 22, to: 7 } },
      skills: [
        { id: 'k-fortune', kind: 'pack', name: '星座运势', enabled: true, scope: { type: 'global', id: '' }, triggers: ['运势'], background: '你懂一点占星。', examples: ['这周关键词是拖延。'] },
        { id: 'k-card', kind: 'persona', name: '中二剑客', enabled: true, scope: { type: 'global', id: '' }, triggers: [], background: '你是自称剑客的中二青年。', examples: [] },
      ],
    },
  });
  check('保存新人设字段 + 技能 + 免打扰 + 黑名单', r.data.ok === true, JSON.stringify(r.data).slice(0, 160));

  const st = (await api('/api/state')).data;
  const c = st.custom;
  check('★ 人设 12 字段原样读回（含叙述型长字段与初始态度）',
    c.persona.age === '24' && c.persona.role === '程序员' && c.persona.desire === '想被认可'
    && c.persona.logic === '先观察再动手' && c.persona.attitude === '试探' && c.persona.status === '刚进群',
    JSON.stringify(c.persona));
  check('★ 两条技能都存下来了，kind 没串',
    c.skills.length === 2 && c.skills.some((s) => s.kind === 'persona') && c.skills.some((s) => s.kind === 'pack'),
    JSON.stringify(c.skills.map((s) => s.kind)));
  // 角色卡的快照 = 人格 12 字段 + 增强 12 项（第 32 轮起增强项也进卡）。
  // 写死"等于 12"会把加字段变成改测试；写清楚"等于这两个表的字段总数"才是真契约。
  {
    const card = c.skills.find((s) => s.kind === 'persona');
    const { PERSONA_KEYS: PK, ENHANCE_KEYS: EK } = await import('../src/custom-config.js');
    check('★ 角色卡带上了完整人格快照（「存多张卡一键换人」靠它）',
      !!card?.fields && Object.keys(card.fields).length === PK.length + EK.length
      && PK.every((k) => k in card.fields) && EK.every((k) => k in card.fields),
      `字段数 ${Object.keys(card?.fields || {}).length}，期望 ${PK.length + EK.length}`);
  }
  check('★ 知识包**不带**人格快照（它只提供背景，不换人）',
    c.skills.find((s) => s.kind === 'pack')?.fields === undefined);
  check('★ 免打扰时段可配（不再是硬编码 23–08）',
    c.trigger.quietHours.from === 22 && c.trigger.quietHours.to === 7, JSON.stringify(c.trigger.quietHours));
  check('★ 「一件事合并成一条长消息」开关落盘', c.replyStyle.multiMessage === false);
  check('★ 黑名单随状态下发到面板（这轮才补的入口）',
    st.config.denyGroups?.[0] === '99999999' && st.config.denyUsers?.[0] === '88888888',
    JSON.stringify({ g: st.config.denyGroups, u: st.config.denyUsers }));
  check('★ 场景表随状态下发且带示例文案（前端不再自存一份）',
    !!st.customMeta?.scenes?.insulted?.ph && !!st.customMeta?.scenes?.typo && Object.keys(st.customMeta.scenes).length >= 9,
    Object.keys(st.customMeta?.scenes || {}).join(','));
  check('★ 导入白名单随状态下发（导入与预览共用同一份，不会"预览说 3 处、实际改 5 处"）',
    Array.isArray(st.customMeta?.importableKeys) && st.customMeta.importableKeys.includes('skills'),
    JSON.stringify(st.customMeta?.importableKeys));
}

console.log('\n【18】导入前预览：说清"会改什么 / 和什么冲突"（不落盘）');
{
  // 基准要取「预览**之前**那一刻」的值 —— 拿 savedCustom（上一节写入前的快照）去比，
  // 比的是一个已经过期的东西，这条断言必然为红，但它红的原因和"预览会不会落盘"毫无关系。
  const before = JSON.stringify((await api('/api/state')).data.custom);

  const r = await api('/api/custom/preview', {
    custom: {
      persona: { traits: '完全不同的性格' },
      // 用**已有**的 id → 应当被认成"改了这一条"，而不是"新增一条"
      skills: [{ id: 'k-fortune', kind: 'pack', name: '星座运势', enabled: false, scope: { type: 'global', id: '' }, triggers: [], background: '改了内容', examples: [] }],
      // 这两句实测相似度 0.57（阈值 0.5）—— 刻意挑一对**真的**能被判成同一件事的，
      // 否则断言测的是"我的测试数据够不够像"，而不是代码逻辑
      memory: { manual: [{ id: 'm-d1', text: '张三讨厌被叫小三', on: true, t: 1 }, { id: 'm-d2', text: '张三讨厌别人叫他小三', on: true, t: 1 }] },
    },
  });
  const d = r.data;
  check('预览接口返回 ok', d.ok === true, JSON.stringify(d).slice(0, 180));
  check('★ 报出字段级变更（具体到 persona.traits，不是笼统一句"有变化"）',
    Array.isArray(d.changes) && d.changes.some((c) => c.path === 'persona.traits'), JSON.stringify(d.changes?.map((c) => c.path)));
  check('★ 已有技能被改（同名 id）→ 报成"修改"而不是"新增"',
    d.lists?.some((l) => l.name === '技能' && l.changed.includes('星座运势') && !l.added.includes('星座运势')),
    JSON.stringify(d.lists));
  check('★ 手动记忆按"新增几条"报出来',
    d.lists?.some((l) => l.name === '手动记忆' && l.added.length === 2), JSON.stringify(d.lists));
  check('★ 报出导入内容内部的自相重复（"同一件事记了两遍"）',
    d.conflicts?.some((c) => /说同一件事/.test(c)), JSON.stringify(d.conflicts));
  check('★ 明说哪些字段不会被碰（用户才敢点确认）',
    Array.isArray(d.untouched) && d.untouched.includes('safety'), JSON.stringify(d.untouched));
  check('预览**本身不落盘**（预览前 / 预览后读到的配置逐字节一致）',
    JSON.stringify((await api('/api/state')).data.custom) === before);
}

console.log('\n【19】导出：技能子集 + 两级脱敏');
{
  const st0 = (await api('/api/state')).data;
  const realGroup = (st0.config.groups || [])[0] || '';

  const sk = await (await fetch(`${BASE}/api/custom/export?what=skills&format=json`)).json();
  check('★ what=skills 只给技能那一份', !!sk.skills && Object.keys(sk.skills).length === 1, Object.keys(sk.skills || {}).join(','));
  const md = sk.skills?.['技能.md'] || '';
  check('★ 技能导出里有名称 / 类型 / 触发词 / 内容',
    /技能（共 2 条/.test(md) && /星座运势/.test(md) && /知识包/.test(md) && /角色卡/.test(md)
    && /触发词/.test(md) && /你懂一点占星/.test(md),
    md.slice(0, 160));

  const m0 = (await (await fetch(`${BASE}/api/custom/export?what=config&format=json&mask=0`)).json()).config?.['config-已脱敏.json'] || '';
  const m1 = (await (await fetch(`${BASE}/api/custom/export?what=config&format=json&mask=1`)).json()).config?.['config-已脱敏.json'] || '';
  check('★ mask=0 保留真实群号（自己留档用）', !realGroup || m0.includes(realGroup), `找不到 ${realGroup}`);
  check('★ mask=1 把群号也藏掉（这份可以发给别人）', (!realGroup || !m1.includes(realGroup)) && /已隐藏/.test(m1), m1.slice(0, 140));
  check('★ 两级脱敏都清空了 Key（不存在"连 Key 都不脱敏"的导出）',
    !/"apiKey":\s*"[^"]+"/.test(m0) && !/"apiKey":\s*"[^"]+"/.test(m1));
}

console.log('\n【20】/api/state 必须下发工作台配置 + 面板自检（用户报的三个问题根因都在这儿）');
{
  const { data } = await api('/api/state');
  // 这三条不是"锦上添花"：只要 state 里少了 custom / customMeta，
  // 工作台就会表现成「技能、知识包、角色卡点不了」「保存点不了」——
  // 而页面 HTML 是每次读盘的，看起来一切正常，排查方向会被完全带偏。
  check('★ state 里有 custom（缺了它 = 工作台所有编辑动作都会"点了没反应"）',
    !!data.custom && typeof data.custom === 'object');
  check('★ custom 里带 allowProactive（主动发言总闸）',
    typeof data.custom?.allowProactive === 'boolean', String(data.custom?.allowProactive));
  check('★ state 里有 customMeta（场景表 / 导入白名单 / 技能上限全靠它）',
    !!data.customMeta && !!data.customMeta.scenes && Array.isArray(data.customMeta.importableKeys));

  check('★ 面板自检信息齐全（pid / 启动时刻 / 代码指纹 / stale）',
    !!data.panel && Number.isInteger(data.panel.pid) && data.panel.bootedAt > 0
    && data.panel.codeMtime > 0 && typeof data.panel.stale === 'boolean',
    JSON.stringify(data.panel));
  // 刚起好的沙箱没换过代码 → 不该报 stale。否则每次打开都催你重启，等于狼来了。
  check('★ 代码没换过时 stale = false', data.panel.stale === false, String(data.panel.stale));

  // 幂等是硬要求：launcher.sh 每次打开 .app 都会打这个接口，它**不能**真的重启。
  // 这条断言还有一层作用 —— 跑完之后面板必须还活着，后面的用例才跑得下去。
  const pid0 = data.panel.pid;
  const r1 = await api('/api/panel/restart', {});
  check('★ 没有新代码时重启接口不动手（幂等，restarted:false）',
    r1.data.ok === true && r1.data.restarted === false, JSON.stringify(r1.data).slice(0, 130));
  await new Promise((r) => setTimeout(r, 600));
  const pid1 = (await api('/api/state')).data.panel?.pid;
  check('★ 幂等调用之后面板还是同一个进程（没被误杀）', pid1 === pid0, `${pid0} → ${pid1}`);
}

console.log('\n【21】本轮新增的两个字段：主动发言总闸 + 扮演规则');
{
  const off = await api('/api/config', { custom: { allowProactive: false } });
  check('★ 关掉主动发言：保存成功', off.data.ok === true, JSON.stringify(off.data).slice(0, 130));
  check('★ 读回来是 false', (await api('/api/state')).data.custom.allowProactive === false);

  // 关键语义：**没传它**的保存不许动它。
  // 工作台的「保存」已经不收集这个字段了（它勾了就生效），这条断言把这个设计钉住 ——
  // 否则点「保存」会把页面上可能还没同步完的那一份拿去覆盖后端。
  const other = await api('/api/config', { custom: { replyStyle: { cooldownSec: 7 } } });
  check('★ 只改别的字段时它保持 false（后端对没传的字段一律不动）',
    other.data.ok === true && (await api('/api/state')).data.custom.allowProactive === false);

  const on = await api('/api/config', { custom: { allowProactive: true } });
  check('★ 重新打开主动发言', on.data.ok === true && (await api('/api/state')).data.custom.allowProactive === true);

  // ── 扮演规则：清单必须随 /api/state 下发（前端不自存），且能落盘往返 ──
  const st = (await api('/api/state')).data;
  /* ⚠️ **不写死条数**（2026-10-04 改，原来写死 12）。
   *  `PLAY_RULES`（src/custom-config.js）由用户按产品需要增删 ——
   *  2026-10-02 就亲手删过两条（mayRefuse「允许顶嘴」/ notOmniscient「不轻易全知」）。
   *  写死数字会让每次产品调整都"看起来像测试坏了"，而最坏的情况是
   *  有人为了让测试变绿**把规则加回去** —— 那正好是用户明确不要的。
   *  该守的是"清单随 /api/state 下发且非空"，条数交给上面那条
   *  「规则表与下发的那份一致」来对（同一份数据，比大小没有意义）。 */
  check('★ customMeta 下发了扮演规则清单（非空，且与规则表同源）',
    Array.isArray(st.customMeta?.playRules) && st.customMeta.playRules.length > 0,
    String(st.customMeta?.playRules?.length));
  check('★ 清单里每条都带正文，且有两条标了 safety',
    st.customMeta.playRules.every((r) => r.text && r.text.length > 4)
    && st.customMeta.playRules.filter((r) => r.safety).length === 2);
  check('★ 导入白名单由后端下发，且含 playRules',
    (st.customMeta.importableKeys || []).includes('playRules'), (st.customMeta.importableKeys || []).join(','));

  const r1 = await api('/api/config', { custom: { playRules: false } });
  const st1 = (await api('/api/state')).data;
  check('★ 关掉扮演规则能落盘', r1.data.ok === true && st1.custom.playRules === false);
  const r2 = await api('/api/config', { custom: { playRules: true } });
  check('★ 再打开也能落盘', r2.data.ok === true && (await api('/api/state')).data.custom.playRules === true);

  // 导出里要能看到"提示词里到底写了哪几条规则" —— 不然用户没法核对
  const md = (await (await fetch(`${BASE}/api/custom/export?what=persona&format=json&mask=1`)).json())
    .persona?.['人格.md'] || '';
  check('★ 导出的人格.md 里列出了扮演规则（抽查两条代表项）',
    /扮演规则/.test(md) && /不替用户决定/.test(md) && /关系变化要有过程/.test(md), md.slice(0, 120));
}

/**
 * 造一份最小配置，直接问 buildMessages 要提示词。
 * 【22】【23】都要用 —— 光有一张常量表而没有消费者，就是这个项目反复踩的
 * "写上了但没人读"，所以"真的进了提示词"必须每次都验。
 */
async function mkPrompt(custom) {
  const { readCustom } = await import('../src/custom-config.js');
  const { Brain, SessionStore } = await import('../src/brain.js');
  const cfg = {
    persona: { name: '小鱼', text: '' },
    context: { ambientMessages: 0, recentTurns: 0 },
    reply: { maxChunks: 1 },
    llm: { model: 'glm-4-flash', provider: 'zhipu', features: {} },
    custom: readCustom({ custom: { memory: { auto: false }, ...custom } }),
  };
  const b = new Brain(cfg, new SessionStore(cfg));
  const evt = { message_type: 'group', group_id: '1', user_id: '2', sender: { nickname: '老王' } };
  return b.buildMessages({ history: [], ambient: [] }, evt, { text: '在吗' })[0].content;
}

console.log('\n【22】扮演规则：真的进了提示词（纯函数，不走 HTTP）');
{
  const { PLAY_RULES, readCustom, personaFingerprint } = await import('../src/custom-config.js');

  check('★ 规则表非空且每条都有正文（条数不写死：增删规则是产品决定，见上面那条的说明）',
    PLAY_RULES.length > 0 && PLAY_RULES.every((r) => r.text && r.text.length > 4),
    `${PLAY_RULES.length} 条`);
  check('★ 规则 id 不重复（id 是用来定位的，重了就没法引用）',
    new Set(PLAY_RULES.map((r) => r.id)).size === PLAY_RULES.length);
  check('★ 两条边界规则被标了 safety（全年龄 / 不刷屏）',
    PLAY_RULES.filter((r) => r.safety).length === 2);
  check('默认开着（文档写的是"必须写进去"，那默认值只能是 true）', readCustom({}).playRules === true);

  /** 造一份最小配置，直接问 buildMessages 要提示词。
   *  这是唯一能证明"规则真的进了提示词"的地方 —— 光有一张常量表而没有消费者，
   *  就是这个项目反复踩的"写上了但没人读"。 */
  const promptWith = mkPrompt;

  const onP = await promptWith({});
  const offP = await promptWith({ playRules: false });
  check('★ 开着时：每条规则都出现在提示词里',
    PLAY_RULES.every((r) => onP.includes(r.text)),
    PLAY_RULES.filter((r) => !onP.includes(r.text)).map((r) => r.id).join(','));
  check('★ 规则单独成节，且排在人物设定之后（先"你是谁"，再"演的时候守什么"）',
    onP.includes('## 扮演规则') && onP.indexOf('## 扮演规则') > onP.indexOf('## 你的人物设定'));
  check('★ 关掉后提示词里一条规则都不剩',
    !PLAY_RULES.some((r) => offP.includes(r.text)));
  check('★ 关掉它不动"说话方式"那一节（规矩和人设是两件事）',
    offP.includes('## 说话方式') && onP.includes('## 说话方式'));
  check('★ 切换它会让"人设指纹"变化 —— 否则机器人会继续按旧规矩说',
    personaFingerprint(readCustom({ custom: { playRules: true } }), 'x')
    !== personaFingerprint(readCustom({ custom: { playRules: false } }), 'x'));
}

console.log('\n【23】增强项：12 个字段只从后端来，且真的进了提示词');
{
  const cc = await import('../src/custom-config.js');
  const { ENHANCE, ENHANCE_KEYS, ENHANCE_GROUPS, readCustom } = cc;

  check('★ 恰好 12 项', ENHANCE_KEYS.length === 12, String(ENHANCE_KEYS.length));
  check('★ 分成 4 组（12 个框排成一堵墙就没意义了）', ENHANCE_GROUPS.length === 4,
    ENHANCE_GROUPS.join(' / '));
  check('★ 每一项都带 分组 / 名称 / 说明 / 示例',
    ENHANCE_KEYS.every((k) => ENHANCE[k].group && ENHANCE[k].label && ENHANCE[k].hint && ENHANCE[k].ph),
    ENHANCE_KEYS.filter((k) => !(ENHANCE[k].group && ENHANCE[k].label && ENHANCE[k].hint && ENHANCE[k].ph)).join(','));
  check('★ 默认全空（这就是"可选、非必填"）',
    ENHANCE_KEYS.every((k) => readCustom({}).enhance[k] === ''));

  // ── /api/state 下发 ──
  const st = (await api('/api/state')).data;
  check('★ state 下发了增强项字段表（表 / 字段名 / 分组）',
    !!st.customMeta?.enhance?.table && Array.isArray(st.customMeta.enhance.keys)
    && st.customMeta.enhance.keys.length === 12
    && Array.isArray(st.customMeta.enhance.groups) && st.customMeta.enhance.groups.length === 4);
  check('★ 导入白名单含 enhance', (st.customMeta.importableKeys || []).includes('enhance'));

  // ── 落盘往返 ──
  const w = await api('/api/config', { custom: { enhance: { values: '自由 > 家人 > 正义', lines: '「我跟你讲」「不是吧」' } } });
  const st2 = (await api('/api/state')).data;
  check('★ 填了能落盘、能读回',
    w.data.ok === true && st2.custom.enhance.values === '自由 > 家人 > 正义'
    && st2.custom.enhance.lines === '「我跟你讲」「不是吧」');
  /* ⚠️ 原来写死 `enhance.secrets === ''`，那假设了**本机角色卡里 secrets 是空的**。
   *  沙箱只带 `QQBOT_SANDBOX=1`、**不带 `QQBOT_DATA_DIR`**，读的是真实 `data/` ——
   *  你写过内容 ⇒ 必然红。
   *
   *  ⚠️⚠️ **这里刻意不去"先把它写空"**：沙箱**不隔离配置文件**
   *  （`sandbox.sh` 里没有任何 config / custom 文件的 env 覆盖），
   *  也就是说 `/api/config` 写的就是**你真实的 config.json** ——
   *  为了让一条断言变绿而清掉你的角色卡内容，是本末倒置。
   *  （我第一版就是这么写的，写完才反应过来，已撤回。）
   *
   *  正确做法：**用纯函数验这条性质，不碰 IO**。
   *  `readCustom({}).enhance[k]` 就是"没填该项"的确切输入 ——
   *  判据落在 `normalizeCustom`（缺字段 ⇒ 补空串）这个真正要守的点上，
   *  既与本机存了什么无关，也不会改你的数据。 */
  check('没填的项仍然是空串（不会被默认值污染 · 走纯函数，不依赖也不改动本机配置）',
    ENHANCE_KEYS.every((k) => readCustom({}).enhance[k] === ''),
    ENHANCE_KEYS.filter((k) => readCustom({}).enhance[k] !== '').join(',') || '全部为空串');
  const clr = await api('/api/config', { custom: { enhance: { values: '' } } });
  check('★ 清空某一项也是有效操作（提示词里应当不再出现它）',
    clr.data.ok === true && (await api('/api/state')).data.custom.enhance.values === '');

  // ── 真的进提示词 ──
  const on = await mkPrompt({ enhance: { values: '自由 > 家人 > 正义', lines: '「我跟你讲」', meters: '信任 20/100' } });
  check('★ 填了的项逐条出现在提示词里（带后端那份中文名）',
    on.includes('## 更细的演法') && /- 价值观排序：自由 > 家人/.test(on)
    && on.includes('「我跟你讲」') && on.includes('信任 20/100'));
  check('★ 空着的项在提示词里一条都不出现',
    !on.includes('秘密与信息差') && !on.includes('成长 / 堕落条件'), '出现了空项的小标题');
  check('★ 增强项排在「人物设定」之后、「扮演规则」之前（先是谁，再多像，最后规矩）',
    on.indexOf('## 你的人物设定') < on.indexOf('## 更细的演法')
    && on.indexOf('## 更细的演法') < on.indexOf('## 扮演规则'));
  check('一个都没填时整节不出现（空白小标题会让模型去猜）',
    !(await mkPrompt({})).includes('更细的演法'));

  // ── 人设指纹与角色卡 ──
  check('★ 改增强项会让人设指纹变化（否则它会按旧演法继续说）',
    cc.personaFingerprint(readCustom({ custom: { enhance: { values: 'A' } } }), 'x')
    !== cc.personaFingerprint(readCustom({ custom: { enhance: { values: 'B' } } }), 'x'));
  const card = cc.readCustom({ custom: { skills: [{ id: 'c1', kind: 'persona', name: '卡', fields: { tone: '话少', values: '自由', meters: '信任 80/100' } }] } });
  check('★ 角色卡快照同时装下人格字段和增强项（否则"一键换人"只换回半个人）',
    card.skills[0].fields.tone === '话少' && card.skills[0].fields.values === '自由'
    && card.skills[0].fields.meters === '信任 80/100');
  check('★ 角色卡里没写到的字段会被补成空串（不是 undefined —— 否则前端填回表单时会写入 "undefined"）',
    card.skills[0].fields.secrets === '');

  // ── 导出 ──
  await api('/api/config', { custom: { enhance: { values: '导出用：自由 > 家人' } } });
  const md = (await (await fetch(`${BASE}/api/custom/export?what=persona&format=json&mask=1`)).json())
    .persona?.['人格.md'] || '';
  check('★ 导出的人格.md 逐条列出增强 12 项',
    /增强项/.test(md) && /价值观排序：导出用/.test(md) && /示例台词：/.test(md), md.slice(0, 120));
}

console.log('\n【24】日志环形缓冲：填满之后游标仍要能拿到新行');
{
  // 这一段专门盯一个已经发生过的 bug：日志数组封顶后长度恒定 600，
  // 前端游标停在 600 之后 slice(600) 恒为空 —— 面板日志从此永久冻结，
  // 只能靠清日志或刷新页面恢复。修复靠的是「累计编号」而不是「数组长度」。
  //
  // 🔴 前置闸门：灌日志用的是 /api/debug，而它在桥接运行时会触发
  // stopBridge + 1.2 秒 + startBridge —— 那就是在真实杀进程。
  // 沙箱里桥接不该在跑（.bridge.pid 已被 rsync 排除）；若发现它在跑，
  // 说明要么沙箱漏拷了状态、要么有人把测试对着真实后端跑 —— 都必须当场拦住。
  const st0 = (await (await fetch(`${BASE}/api/state`)).json());
  const originDebug = st0.debugLog;
  const bridgeUp = st0.bridge?.running === true;
  check('前置：桥接没在运行（在跑时灌 /api/debug 会真实杀进程，2026-09-19 事故实录）', !bridgeUp);

  if (!bridgeUp) {
  await api('/api/logs/clear', {}); // 从干净状态开始：测试自带基线，不依赖运行时残留
  const zero = (await (await fetch(`${BASE}/api/logs?since=0`)).json());
  check('清空后 total 与 dropped 都归零（前端游标也归零，两边对得上）',
    zero.total === 0 && zero.dropped === 0, `total=${zero.total} dropped=${zero.dropped}`);

  // 推到超过上限，把环形缓冲挤成"已满"状态。用 /api/debug：每次恰好 pushLog 一行，
  // 且沙箱里桥接没在跑，不会触发"停桥接+1.2 秒+重启"那条重路径。
  const N = 620;
  for (let i = 0; i < N; i += 1) await api('/api/debug', { on: i % 2 === 0 });

  const full = (await (await fetch(`${BASE}/api/logs?since=0`)).json());
  check('★ 日志被挤出去了（dropped > 0）—— 这正是冻结 bug 的触发条件',
    full.dropped > 0, `dropped=${full.dropped}`);
  check('★ total 是单调递增的累计编号，不再卡在数组长度上',
    full.total > 600, `total=${full.total}`);
  check('★ dropped + 现存行数 = total（编号与数组对得上）',
    full.dropped + full.lines.length === full.total,
    `${full.dropped} + ${full.lines.length} vs ${full.total}`);

  // 关键：游标推进到最新之后，再来的新行仍然拿得到（旧逻辑在这里恒为空 → 冻结）
  let cursor = full.total;
  await api('/api/debug', { on: true });
  const next = (await (await fetch(`${BASE}/api/logs?since=${cursor}`)).json());
  check('★ 游标停在最新处时，新行照样拿得到（旧逻辑此处恒为空 = 日志冻住）',
    next.lines.length >= 1, `lines=${next.lines.length}`);
  check('★ 且不会整份重复下发（只给增量）', next.lines.length <= 3, `lines=${next.lines.length}`);

  // 面板重启 / 别处清了日志之后，旧游标会指向一个不存在的编号 —— 必须让客户端追平
  const stale = (await (await fetch(`${BASE}/api/logs?since=${cursor + 1000}`)).json());
  check('★ 落后太多的客户端会被标记 reset 并拿到现存日志（而不是卡死）',
    stale.reset === true && stale.lines.length > 0, `reset=${stale.reset} lines=${stale.lines.length}`);

  // 收尾：清干净，并把详细日志开关还原成测试前的值
  await api('/api/logs/clear', {});
  await api('/api/debug', { on: originDebug === true });
  }
}

console.log('\n【25】收尾：把本轮测试改过的配置还原（保证下次运行结果一致）');
{
  const r = await api('/api/config', { denyGroups: [], denyUsers: [], custom: { ...savedCustom } });
  check('已还原', r.data.ok === true, JSON.stringify(r.data).slice(0, 140));
}

console.log('\n【26】B9：沙箱脱敏 + 审计日志');
{
  // ① 脱敏的断言已经挪到【S0】—— 它**必须在任何写操作之前**做。
  //    （留在这一段里的话，预设在前面几步已经被 /api/switch 物化回配置，
  //      凭据字段不再是脱敏器写的那份，会误报。第一版就是这么错的。）

  // ② 写路由必须留痕：路径对得上、状态码记下来、**actor 非空**。
  const before = (await api('/api/audit?limit=500')).data;
  check('/api/audit 可读', Array.isArray(before?.lines), JSON.stringify(before).slice(0, 120));

  // ⚠️ 判据**不能比行数**（第 46 轮踩到并修掉的既存脆弱性）：
  //    审计是一份**有界**日志（AUDIT_MAX=500，超了折半截断成 250）。
  //    沙箱一轮的审计产出量已经逼近这个上限 —— 于是"正好跨过阈值"就会让
  //    `after === before + 1` 变成 `500 → 250` 而假红，
  //    而那件事实与"写路由到底留没留痕"**完全无关**。
  //    这正是本项目第 11 条陷阱的形状（量数载体会被系统自己回收），
  //    解法同那里：改成量**不会随时间被回收的那个对象** —— 记为本次写操作产生的新记录。
  const t0 = Date.now();
  const w = await api('/api/config', {});
  check('一次写操作自身成功', w.data.ok === true, JSON.stringify(w.data).slice(0, 120));

  const after = (await api('/api/audit?limit=500')).data;
  const newest = after.lines[0];
  // 截断保留的是**最新的**那些行，所以刚写下的这条一定还在里面。
  const fresh = (after.lines || []).filter((l) => l && l.t >= t0 && l.path === '/api/config');
  check(
    '★ 写路由产生了审计行（成与败都记）',
    fresh.length >= 1,
    `本次写入后新增 ${fresh.length} 条 /api/config 审计行（判据：t ≥ ${t0}，不比行数）`
  );
  check(
    '★ 审计行带 actor（非空）与 status，且路径对得上',
    !!newest &&
      typeof newest.actor === 'string' &&
      newest.actor.length > 0 &&
      newest.path === '/api/config' &&
      newest.status === 200,
    JSON.stringify(newest).slice(0, 150)
  );

  // ③ 读路由不该进审计 —— 否则 3 秒一次的轮询会把审计淹掉，等于没记。
  //    同样**不比行数**（同上面的理由）：直接数审计里有没有 `/api/state` 这一路。
  await api('/api/state');
  await api('/api/state');
  const stateRows = (await api('/api/audit?limit=500')).data.lines
    .filter((l) => l && l.path === '/api/state').length;
  check(
    '★ 读路由（GET /api/state）不进审计 —— 否则会被 3 秒轮询淹掉',
    stateRows === 0,
    `审计里 /api/state 的记录数=${stateRows}（应为 0，且这个判据不受折半截断影响）`
  );
}

console.log(`\n──────── 结果：${pass} 通过 / ${fail} 失败 ────────`);
if (fail) console.log('失败项：\n - ' + bad.join('\n - '));
process.exit(fail ? 1 : 0);
