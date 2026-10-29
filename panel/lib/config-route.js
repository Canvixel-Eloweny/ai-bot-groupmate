/**
 * 「保存配置」这条路由的**全部逻辑**（H-10 第二半 · 第 18 轮从主文件搬出）。
 * ══════════════════════════════════════════════════════════════════════════
 *  层号 **L3** —— 它依赖 L2 的 `models.js`（模型判据 / 预设）与 L1 的
 *  `config-io.js`（配置落盘），所以不能比它们更浅。这也是本仓 lib 里最深的一层。
 *
 *  为什么它是三块里**第一个能搬**的（`collectState` / `buildExport` 还搬不动）：
 *  · 白名单外只差 `custom-config.js` · `injection.js` · `gate-scan.js`，
 *    三者的传递闭包实测**都不触达**机器人重型链（9 / 2 / 1 个模块）⇒ 登记即可；
 *  · **零模块级状态** —— 搬走时不需要带走任何 `let` 缓存，
 *    所以没有「块外那处赋值让 ESM 只读绑定静默分叉成两份」的风险（那正是
 *    `collectState` 搬不动的真原因，见交接件 §七）。
 *
 *  ⚠️ **四个依赖是注入的，不是搬进来的**：`baseUrlReject` / `sameUrl` /
 *    `bridgeRunning` / `waitEffectiveApplied` 在主文件里**各自还有别的调用点**
 *    （`bridgeRunning` 更是被 8 处用）。搬进来就得在主文件留一份壳，
 *    两份实现各自活一份、后改的那份不生效 —— 所以这里走注入，
 *    与 `ext-install.js` 的 `io` 入参同一形状。
 *
 *  @param {object} deps 主文件注入的四个只读判据（见上面的「四个依赖是注入的」）
 *  @returns {function} 签名为 `(req, res, url)` 的路由 handler（与路由表约定一致）
 */
import { capabilitiesOf, resolveFeatures, FEATURE_LABEL, THINK } from '../../src/model-caps.js';
import { patchCustom } from '../../src/custom-config.js';
import { looksInjected } from '../../src/injection.js';
import { GATE_ERROR_KIND, isBlocking } from '../../src/gate-scan.js';
import { providerOf } from '../../src/net-rules.js';
// 桌面端「启动方式」（2026-10-16）：值域与校验住 `src/launch-mode.js` ——
// **写侧（这里）与读侧（state-collector / 三个启动器）共用同一份判定**，
// 不许在这里再手写一遍 ['browser','window']（两份值域必然漂移）。
import { validateLaunch } from '../../src/launch-mode.js';
import { setAutostart } from '../../src/desktop/autostart.js';
import { applySettingsPatch } from '../../src/plugin-settings.js';
import { pushLog, state } from './runtime-state.js';
import { sendJson, readBody } from './http-io.js';
import { readConfig, writeConfig } from './config-io.js';
import { INSTALL_ROOT } from './paths.js';
import { extensionsOf } from './extensions.js';
import {
  CLOUD_PRESETS, MAX_CHAIN_LEN, chainModelsOf, localChannelOf, modelProviderMismatch, normalizeThinking,
  readPresets, stashCurrentPreset,
} from './models.js';

export function makeConfigRoute(deps) {
  const { baseUrlReject, sameUrl, bridgeRunning, waitEffectiveApplied } = deps;

  return async function apiConfig(req, res, url) {
    const body = await readBody(req);
    const cfg = readConfig() || {};
    cfg.llm = cfg.llm || {};

    // 改 baseUrl 等于换大脑：先把旧那套的设置存回它自己的预设，别让它串到新的上面
    const providerBefore = providerOf(cfg.llm.baseUrl);
    const wantBase = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    // S-08：先判能不能收。⚠️ 放在 stash 之前 —— 被拒的地址不该触发"把当前预设存回去"
    // （那会把一份本来好好的预设覆盖成脏的）。
    if (wantBase) {
      const why = baseUrlReject(wantBase);
      if (why) {
        pushLog(`✗ 接口地址被拒（${why}）—— 填的是 ${wantBase.slice(0, 80)}`);
        return sendJson(res, { ok: false, error: why, reason: 'bad-base-url' }, 400);
      }
    }
    if (wantBase && !sameUrl(wantBase, cfg.llm.baseUrl)) stashCurrentPreset(cfg);

    if (wantBase) cfg.llm.baseUrl = wantBase;
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      cfg.llm.apiKey = body.apiKey.trim();
      // 顺手按当前服务商归档，以后切来切去不用重复填
      const prov = providerOf(cfg.llm.baseUrl);
      if (prov !== 'local' && prov !== 'other') {
        cfg.llm.keys = { ...(cfg.llm.keys || {}), [prov]: body.apiKey.trim() };
      }
    }

    // —— 模型：先按服务商校验，跨家的名字直接拒掉并说清原因 ——
    // 这是用户明确要防的那件事：在 A 的页面上点了 B 的模型，然后一用就报错。
    const providerNow = providerOf(cfg.llm.baseUrl);
    if (typeof body.model === 'string' && body.model.trim()) {
      const want = body.model.trim();
      const mismatch = modelProviderMismatch(want, providerNow);
      if (mismatch) {
        pushLog(`✗ 拒绝了不匹配的模型：${want}`);
        return sendJson(
          res,
          { ok: false, error: mismatch, provider: providerNow, currentModel: cfg.llm.model },
          400
        );
      }
      cfg.llm.model = want;
    }

    // —— 降级链顺序（面板上那条可拖动的「优先级线路」）——
    // 第 1 项由上面的 body.model 承担，这里只收第 2 项起的 fallbackModels。
    // 校验三件事：不跨服务商、不重复、**不含实测不可用的模型**。
    // 最后一条最关键：glm-5.3 这类"不许关思考"的模型一旦进链，请求会以 400 直接失败；
    // 而 400 不属于"可重试"错误，src/llm.js 会当场抛出、**不会**降级到下一个 ——
    // 等于整条链白排。所以宁可在这里拒掉并说清原因。
    if (Array.isArray(body.fallbackModels)) {
      // seen 预先塞进主模型：链里再出现一次主模型是纯浪费（每轮要多打一次同样的请求），
      // 而前端拖动时并不会特意避开这种情况（直调接口更不会）。
      const seen = new Set([String(cfg.llm.model || '').trim()].filter(Boolean));
      const chain = [];
      /* ⚠️ **这家清单里没有的模型一条都不许进链**（2026-10-17 维护者截图）。
         上面那道 `modelProviderMismatch()` 对千问是**刻意放行**的（千问平台代理别家模型，
         前缀判不了），于是"整条 GLM 链存进千问"能一路无阻 —— 而那条链一条都打不通。
         清单只有一份（`modelsOfProvider` ⇒ `buildModelCaps`），这里只查成员资格；
         服务商认不出（local / other / 自建网关）⇒ 清单为空 ⇒ 不判（没有依据说它错）。 */
      const known = new Set(chainModelsOf(providerNow));
      for (const raw of body.fallbackModels) {
        const m = String(raw || '').trim();
        if (!m || seen.has(m)) continue; // 空项、重复项、与主模型撞车的一律静默丢弃
        const bad = modelProviderMismatch(m, providerNow);
        if (bad) {
          pushLog(`✗ 降级链里有不匹配的模型：${m}`);
          return sendJson(res, { ok: false, error: bad, provider: providerNow }, 400);
        }
        if (known.size && !known.has(m)) {
          const why = `「${m}」不在${CLOUD_PRESETS[providerNow]?.label || providerNow}的模型清单里，`
            + `放进降级链也不会被这家响应（换模型失败时只会连续撞墙）。`
            + `它仍然可以当主模型 —— 请把它拖出线路，或者从「候选模型」里换一条这一家的。`;
          pushLog(`✗ 拒绝把 ${m} 放进降级链（${providerNow} 的清单里没有它）`);
          return sendJson(res, {
            ok: false, reason: 'model-not-in-provider', provider: providerNow, model: m, error: why,
          }, 400);
        }
        if (
          providerNow === 'zhipu' &&
          capabilitiesOf('zhipu', m).think === THINK.ALWAYS
        ) {
          const why = `「${m}」始终思考、不支持关闭。放在降级链里，一旦降级到它，`
            + `思考会把字数配额吃光、正文变空，等于这次回复白跑（而且它比别的慢很多）。`
            + `它可以当主模型，但不适合放进降级链 —— 请把它拖出列表再试。`;
          pushLog(`✗ 拒绝把 ${m} 放进降级链（始终思考）`);
          return sendJson(res, { ok: false, error: why, provider: providerNow }, 400);
        }
        seen.add(m);
        chain.push(m);
      }
      // 超长就**明确拒绝**，不要静默截断 —— 悄悄丢掉用户拖进来的模型，
      // 表现是"排好了、重启又变了"，比报错难查得多。
      if (chain.length > MAX_CHAIN_LEN - 1) {
        const why = `线路最多 ${MAX_CHAIN_LEN} 条（含主模型），这次传了 ${chain.length + 1} 条。`
          + `请先移掉几条再保存。`;
        pushLog(`✗ 降级链超长（${chain.length + 1} 条），已拒绝`);
        return sendJson(res, { ok: false, error: why, provider: providerNow }, 400);
      }
      cfg.llm.fallbackModels = chain;
      /* ⚠️ 当前这套是**自定义大脑** ⇒ 链也要写进它自己那一格（2026-10-17）。
         不写的话：改完链只是改了扁平字段，一旦切走再切回，`materializeBrain()`
         会把链覆盖回大脑里那条旧的 —— 用户改的东西**静默丢失**（而且界面上
         一度显示的是"改成功了"）。判据与 `stashCurrentPreset` 同一条：扁平配置属于谁，就存给谁。 */
      const activeId = String(cfg.llm.activeCustomId || '');
      if (activeId && cfg.llm.customBrains?.[activeId]) {
        cfg.llm.customBrains[activeId] = {
          ...cfg.llm.customBrains[activeId],
          fallbackModels: [...chain],
        };
      }
    }

    // 思考配置：既收新的 {mode,level}，也收旧的 "auto"/"on"/"off"
    if (body.thinking !== undefined) {
      cfg.llm.thinking = normalizeThinking(body.thinking);
    }
    if (Number.isFinite(body.maxTokens) && body.maxTokens > 0) cfg.llm.maxTokens = Math.round(body.maxTokens);
    // 本机推理通道（mlx / qwenchat）。只在本机大脑下有意义，其它大脑忽略。
    if (typeof body.localChannel === 'string' && body.localChannel) {
      const ch = localChannelOf(body.localChannel);
      cfg.llm.localChannel = ch;
      // ⚠️ 这个字段**永远是「本机那套」的设置**，跟当前停在哪家大脑无关，
      //    所以必须直接写进本机预设。否则会出现：在云端页面上选了 QwenChat 通道，
      //    一切到本机又被预设里的旧值（mlx）盖回去 —— 表现是"改了没用"，
      //    而且还白起一个 MLX 服务占掉 2.9G 内存。
      const all = readPresets(cfg);
      all.local = { ...all.local, channel: ch };
      cfg.llm.presets = all;
    }
    if (body.context && typeof body.context === 'object') {
      if (Number.isFinite(body.context.recentTurns)) {
        cfg.context = { ...(cfg.context || {}), recentTurns: Math.max(2, Math.round(body.context.recentTurns)) };
      }
      if (Number.isFinite(body.context.ambientMessages)) {
        cfg.context = { ...(cfg.context || {}), ambientMessages: Math.max(0, Math.round(body.context.ambientMessages)) };
      }
    }
    // 两个能力开关（联网 / 识图）。
    // 这里是**第三道闸**（前两道：界面上灰显、前端提交前拦）。真正兜底的是它：
    // 不管配置是从界面上改的、还是手改 config.json 的，落盘前都收敛一次。
    if (body.features && typeof body.features === 'object') {
      // ⚠️ **按键局部合并**，不整份覆盖（2026-10-15 修 · A2 / Issue #5）：
      //    面板点一个开关只发**那一个键**（`{features:{vision:true}}`）。整份重算会把
      //    没传的两项判成 `undefined === true` → false ⇒「先开识图、再开联网，识图被
      //    静默改回关」，反过来也一样；而且每一步都弹"已打开"，用户完全无从下手。
      //    只有同时开多个时才暴露（单开一个时被冲掉的那两个本来就是 false，看着正常）。
      //    与 `patchCustom` 同一条纪律：只动这次真的传上来的键。
      const next = { ...(cfg.llm.features || {}) };
      for (const k of ['webSearch', 'vision']) {
        if (k in body.features) next[k] = body.features[k] === true;
      }
      cfg.llm.features = next;
    }
    // 无论这次有没有传 features，都按**最终落盘的模型**再收敛一次。
    // 为什么必须做：换到纯文本模型时，之前开着的识图/联网会被服务端 400 拒掉 ——
    // 表现是"机器人突然不说话了"，而用户根本想不到是自己切了模型导致的。
    // 静默关掉 + 明确告诉他关了哪一项，好过一个看不出原因的哑巴。
    const featureBefore = { ...(cfg.llm.features || {}) };
    // ⚠️ 第 4 个参数（`declared`）**必须传**（2026-10-12 修）：
    //    它是「用户自己勾的能力」，而自定义大脑**没有内置能力档案**（providerOf 把
    //    `api.z.ai` 这类国际站域名归到 `other`，能力表里根本没有这一桶）⇒
    //    不传 declared，它勾的"能联网 / 能看图"会被这里判成"这个型号没有该能力"
    //    而**当场关掉**，并弹一句"当前模型不支持"。而发请求的 `src/llm.js` 是**传了**
    //    declared 的 ⇒ 同一个大脑，配置侧说"不支持"、请求侧说"支持"，
    //    用户看到的就是"开了又自己关 / 开了也不生效"。
    //    判据只有一份（`resolveFeatures`），**谁调用谁把 declared 带上**。
    const conv = resolveFeatures(providerNow, cfg.llm.model, cfg.llm.features, cfg.llm.declaredFeatures);
    cfg.llm.features = conv.features;
    const autoDisabled = [];
    for (const k of ['webSearch', 'vision']) {
      if (featureBefore[k] === true && conv.features[k] === false) autoDisabled.push(k);
    }
    cfg.allow = cfg.allow || {};
    if (Array.isArray(body.groups)) cfg.allow.groups = body.groups.map((x) => String(x).trim()).filter(Boolean);
    // 私聊白名单（2026-10-12；面板上现在叫「同意私聊的 QQ 号」）。它与 `groups` 是**同一个闸的两半**（brain.js 按消息类型二选一），
    // 所以键名不同、形状与清洗规则必须逐条一致 —— 半扇门开着等于没有门。
    if (Array.isArray(body.privateUsers)) cfg.allow.private = body.privateUsers.map((x) => String(x).trim()).filter(Boolean);
    // 主人 QQ（顶层 `owner.qq`，2026-10-21）：它是"睡眠叫醒"的唯一身份判据，
    // 加载时会把主人自动补进 `allow.private`（Q26f 裁决③）。面板此前**写不了**这一格，
    // 于是"主人私聊叫醒"在界面上既看不见也改不了。只收 5–12 位纯数字，去重。
    if (Array.isArray(body.ownerQq)) {
      const owners = [...new Set(body.ownerQq.map((x) => String(x).trim()).filter((q) => /^\d{5,12}$/.test(q)))];
      cfg.owner = { ...(cfg.owner || {}), qq: owners };
    }
    // 黑名单。优先级高于白名单（src/brain.js 的 decide() 里先判 deny），
    // 所以界面上要写清楚"进了黑名单就不管白名单了"，否则用户会以为两个都设了是"取交集"。
    cfg.deny = cfg.deny || {};
    if (Array.isArray(body.denyGroups)) cfg.deny.groups = body.denyGroups.map((x) => String(x).trim()).filter(Boolean);
    if (Array.isArray(body.denyUsers)) cfg.deny.users = body.denyUsers.map((x) => String(x).trim()).filter(Boolean);
    cfg.trigger = cfg.trigger || {};
    if (typeof body.requireAtInGroup === 'boolean') cfg.trigger.requireAtInGroup = body.requireAtInGroup;
    if (typeof body.interjectChance === 'number' && Number.isFinite(body.interjectChance)) {
      cfg.trigger.interjectChance = Math.min(1, Math.max(0, body.interjectChance));
    }
    // 单会话小时上限（2026-10-21）：只约束主动/插话；直呼类豁免在 brain.throttleReason 里。
    if (typeof body.perHourPerSession === 'number' && Number.isFinite(body.perHourPerSession)) {
      cfg.throttle = cfg.throttle || {};
      cfg.throttle.perHourPerSession = Math.round(Math.min(600, Math.max(1, body.perHourPerSession)));
    }
    /* 插话冷却（`trigger.interjectCooldownMs`，2026-10-17）：
       机器人侧从 `src/brain.js` 起就一直在读它（`lastInterjectAt < interjectCooldownMs` ⇒ 不插话），
       而这条路由的 trigger 白名单里**从来没有**它 ⇒ 面板就算画了滑块，保存也会被静默丢掉
       （症状与 interjectChance 那次一模一样：改了不生效、还查不出原因）。
       ⚠️ 值域只在这里夹：0 = 不冷却（可被手改的 config.json 用到，面板自己从 1 分钟起）；
          上限 5 小时 —— 再大就等于"只在被叫到时才说话"，那种需求应该关掉插话（概率调 0），
          而不是把冷却当开关用。 */
    if (typeof body.interjectCooldownMs === 'number' && Number.isFinite(body.interjectCooldownMs)) {
      cfg.trigger.interjectCooldownMs = Math.round(Math.min(5 * 3600e3, Math.max(0, body.interjectCooldownMs)));
    }
    if (Array.isArray(body.aliases)) cfg.trigger.aliases = body.aliases.map((s) => String(s).trim()).filter(Boolean);
    if (typeof body.personaName === 'string' && body.personaName.trim()) {
      cfg.persona = cfg.persona || {};
      cfg.persona.name = body.personaName.trim();
    }

    // ── 回复分段（2026-10-09 · 第 53 轮 · B4）──
    // `reply.splitToken` 此前**只有配置文件能改**（面板上没有任何入口），而它恰好是最容易
    // 坏的一个字段：脱敏器曾把它当凭据清空、写进了 `config.example.json`，于是全新安装的
    // 用户拿到的就是一份"一条回复会被逐字切开发出去"的配置
    // （详见 `src/config.js` 的 `normalizeSplitToken` 注释）。
    // 现在补上写入路径，并**当场判空**：空串在这里被丢掉（保持原值），
    // 界面点不出坏配置，好过让用户在群里被逐字刷屏之后才发现。
    cfg.reply = cfg.reply || {};
    if (typeof body.splitToken === 'string' && body.splitToken.trim()) {
      cfg.reply.splitToken = body.splitToken.trim();
    }

    // ── 桌面端「启动方式」（launch · 2026-10-16）──
    // 它决定启动器（Windows 快捷方式 / Mac 图标 / CLI）把控制台开成
    // 浏览器标签页还是独立窗口。**保存成功 ≠ 立刻生效**：启动器只在启动时读一次
    // （面板上的提示语已经写明"下次启动生效"，schema.js 的 savedMsg）。
    // 校验失败按本文件的一贯取向**拒绝整次保存并说清原因**，不做静默纠正 ——
    // 静默纠正会让用户以为"我明明点了独立窗口"。
    if (body.launch !== undefined) {
      // 开机自启是**系统状态**，不是 config 的一个副本：先写系统，失败就不写配置；
      // 读侧由 state-collector 直接读 Startup 快捷方式与 StartupApproved。
      if (body.launch && typeof body.launch === 'object' && !Array.isArray(body.launch)
        && Object.prototype.hasOwnProperty.call(body.launch, 'autoStart')) {
        const want = body.launch.autoStart;
        if (typeof want !== 'boolean') {
          return sendJson(res, { ok: false, error: 'autoStart 只接受 true / false', reason: 'bad-launch' }, 400);
        }
        const a = setAutostart(want, { installRoot: INSTALL_ROOT });
        if (!a.ok) {
          pushLog(`✗ 开机自启没有保存：${a.error}`);
          return sendJson(res, { ok: false, error: a.error, reason: 'autostart' }, 500);
        }
        // 写成功先在进程内给一个 15 秒的临时回执；否则面板要等下一次系统查询
        // 才会从“关”变成“开”，用户会以为没生效。读侧仍以系统为最终真相。
        state.autoStartState = a.state;
        state.autoStartAt = Date.now();
        state.autoStartDetail = a.state === 'on' ? (a.shortcut || '') : '';
        const { autoStart, ...rest } = body.launch;
        body.launch = rest;
      }
      const r = validateLaunch(body.launch);
      if (!r.ok) {
        pushLog(`✗ 启动方式没有保存：${r.error}`);
        return sendJson(res, { ok: false, error: r.error, reason: 'bad-launch' }, 400);
      }
      cfg.launch = { ...(cfg.launch && typeof cfg.launch === 'object' ? cfg.launch : {}), ...r.value };
    }

    // ── 自定义工作台那一整块 ──
    // 走 patchCustom 而不是整份替换：工作台有八个分区，前端每次只提交它自己那块，
    // 直接替换会把没提交的字段冲回默认值（"我只改了安全设置，人格怎么没了"）。
    if (body.custom && typeof body.custom === 'object') {
      // ── 入库注入闸门（B9 · INJ-GATE）──
      // 手动记忆和自动记忆一样，是**每轮都会被重新塞进提示词**的内容。
      // 面板是另一条写入路径：机器人那边拦住了、这边直接存进去，闸门就等于没有 ——
      // 所以两边共用同一份模式表（src/injection.js）。
      //
      // 这里选择**拒绝整次保存并说明原因**，而不是静默丢弃那一条：
      // 静默丢弃会表现成"我明明保存了，刷新就没了"，用户只会以为面板坏了。
      // （自动记忆那条路径相反 —— 它是机器自己写的，静默丢弃 + 记日志才合适。）
      const manual = body.custom?.memory?.manual;
      if (Array.isArray(manual)) {
        for (const item of manual) {
          const kind = looksInjected(item?.text);
          const preview = String(item?.text || '').slice(0, 40);
          // 闸门自己坏了（哨兵）→ **放行**，与出口闸门取向刻意相反（理由见 src/gate-scan.js）。
          // 判"拦不拦"的唯一判据是 `isBlocking()`；`kind === GATE_ERROR_KIND` 只是为了换文案。
          if (kind === GATE_ERROR_KIND) {
            pushLog(`⚠ 注入闸门规则自身出错，这一条按放行处理（fail-open）：${preview}`);
          } else if (isBlocking(kind)) {
            pushLog(`✗ 手动记忆被注入闸门拦下（${kind}）：${preview}`);
            return sendJson(
              res,
              {
                ok: false,
                error:
                  `手动记忆里有一条命中了「注入闸门（${kind}）」：${preview}\n` +
                  '这类内容会被反复塞进每一轮提示词，等于让它长期影响机器人，所以拒绝保存。\n' +
                  '如果这确实是你要记的东西，换个说法写（或先评估一下它的影响）。',
              },
              400
            );
          }
        }
      }
      // ── 插件设置的命名空间闸门（D7 / 报告 E1）──
      // 第 55 轮把"能填进去"打通了，但没有边界：面板原来把用户填的 JSON 整份塞进
      // `settings[id]`，于是**写一个清单里根本没有的键**也能存下去，插件会把它当成
      // "用户配置"读走。这里用**唯一一份判据**（`src/plugin-settings.js`）拒掉越界键。
      //
      // ⚠️ 选择**拒绝整次保存并说清哪几个键**，不做"部分写入" —— 与上面注入闸门同一取向：
      //    部分写入会让用户以为保存成功了（"我明明改了，怎么有一项没生效"）。
      const extBody = body.custom?.extensions;
      const psNamespaces = [];
      if (extBody && typeof extBody === 'object' && !Array.isArray(extBody)) {
        for (const [kind, key] of [['plugin', 'plugins'], ['skill', 'skills']]) {
          const patch = extBody[key]?.settings;
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) continue;
          psNamespaces.push({
            kind,
            patch,
            enabled: cfg.custom?.extensions?.[key]?.enabled || [],
            current: cfg.custom?.extensions?.[key]?.settings || {},
          });
        }
      } else {
        const patch = body.custom?.plugins?.settings;
        if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
          psNamespaces.push({
            kind: 'plugin',
            patch,
            enabled: cfg.custom?.plugins?.enabled || [],
            current: cfg.custom?.plugins?.settings || {},
          });
        }
      }
      for (const ns of psNamespaces) {
        const declaredById = new Map();
        for (const it of (extensionsOf(ns.enabled, {
          maxPlugins: cfg.custom?.extensions?.max ?? cfg.custom?.plugins?.max,
        })?.items || [])) {
          if (it.kind !== ns.kind) continue;
          // ⚠️ 只把**有默认值**的包纳入闸门。清单只声明了 `configSchema`（没有默认值）的包
          //    在投影里是空对象 —— 拿它当"声明的键的集合"会把用户所有合法输入判成越界。
          if (Object.keys(it.settings || {}).length) declaredById.set(it.id, it.settings);
        }
        for (const [id, patch] of Object.entries(ns.patch)) {
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) continue;
          if (!declaredById.has(id)) continue; // 包不在（还没拷进来）→ 不卡这一步
          const r = applySettingsPatch({ declared: declaredById.get(id), prev: ns.current[id] || {}, patch });
          if (!r.ok) {
            pushLog(`✗ ${ns.kind === 'skill' ? 'Skill' : '插件'}设置被拒（${id}）：${r.reason}`);
            return sendJson(
              res,
              {
                ok: false,
                error: `${ns.kind === 'skill' ? 'Skill' : '插件'}「${id}」的设置没有保存：${r.reason}\n` +
                  '只允许填清单里声明过的键（面板上已经按类型列出来了），值也要与类型相符。',
              },
              400
            );
          }
          // ★ 把**强转之后**的那份写回请求体 —— 面板送来的是控件里的字符串（"20"），
          //   不写回的话存的还是字符串，插件读到一个 str 而清单声明的是 number。
          ns.patch[id] = r.value;
        }
      }
      cfg.custom = patchCustom(cfg.custom, body.custom);
      pushLog('✔ 工作台设置已更新');
    }

    // 把这次改动记进「它所属大脑」的那套预设 —— 切走再切回来什么都不丢
    stashCurrentPreset(cfg);
    writeConfig(cfg);
    pushLog(`✔ 配置已保存${providerBefore !== providerNow ? `（大脑已变为 ${providerNow}）` : ''}`);

    // 明确回答"这次改动到底生效没有"，别让用户自己猜。
    // 关键：要等机器人真的把新配置读进去再返回。热重载有约 1 秒延迟，
    // 如果保存完立刻返回，前端紧接着刷新会读到旧状态，
    // 把用户刚点选的按钮又戳回去 —— 表现就是「要点两三下才切过去」。
    const running = bridgeRunning();
    const applied = await waitEffectiveApplied(cfg);
    // 「换模型时自动关掉了哪些能力」要如实回报 —— 静默改动用户配置是不行的，
    // 他会以为那个开关坏了。接口把原因一起给出去，前端照着弹一句。
    const offNames = autoDisabled.map((k) => FEATURE_LABEL[k]).filter(Boolean);
    if (offNames.length) pushLog(`ℹ 已自动关闭 ${offNames.join('、')}（当前模型不支持）`);

    // ── K-ENV 的**写入端**（B9）──
    // 用户这一次明确填了一把 Key，但配置里还挂着 `llm.apiKeyEnv`：
    // 加载时环境变量的优先级更高（见 src/config.js），所以他刚填的这把会被**静默盖掉**。
    // 界面一片正常、实际用的还是环境变量里那把 —— 属于"填了不生效"里最难查的一种。
    //
    // ⚠️ 这里**故意不自动删掉 `apiKeyEnv`**：那是用户自己配的环境变量约定。
    //    为了"让他填的生效"就悄悄改掉它，与"静默改动用户配置"是同一类错误 ——
    //    上面 autoDisabled 那段注释里已经写过这条原则，不在这里破例。
    //    所以只把冲突如实说出来，并告诉他一刀切在哪里。
    const envVar = typeof cfg.llm.apiKeyEnv === 'string' ? cfg.llm.apiKeyEnv.trim() : '';
    const typedKey = typeof body.apiKey === 'string' && body.apiKey.trim();
    const envOverrided = !!(typedKey && envVar && process.env[envVar]);
    if (envOverrided) {
      pushLog(`⚠ 配置里还设着 llm.apiKeyEnv=${envVar}，它的优先级更高 —— 刚填的这把不会被使用`);
    }
    const baseMsg = !running
      ? '已保存（机器人没在运行，下次启动后生效）'
      : applied
        ? '已保存，机器人已用上新配置（不用重启）'
        : '已保存，但机器人还没确认，请稍等几秒再看';
    return sendJson(res, {
      ok: true,
      bridgeRunning: running,
      applied,
      autoDisabled,
      autoDisabledMsg: offNames.length
        ? `已自动关闭 ${offNames.join('、')}：当前模型「${cfg.llm.model}」不支持，留着会让每个请求被服务端拒掉。`
        : '',
      envOverride: envOverrided
        ? {
            envVar,
            note:
              `配置里还设着 llm.apiKeyEnv=${envVar}，环境变量的优先级更高 —— 刚填的这把不会被使用。` +
              `想让它生效，先把 config.json 里的 llm.apiKeyEnv 删掉（或在环境变量里换成新 Key）。`,
          }
        : null,
      msg:
        baseMsg +
        (envOverrided
          ? `　⚠ 配置里还设着 llm.apiKeyEnv=${envVar}，它的优先级更高，刚填的这把不会被使用。` +
            '想用刚填的这把，请先删掉 config.json 里的 llm.apiKeyEnv。'
          : ''),
    });
  };
}
