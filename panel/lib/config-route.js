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
import { ZHIPU_MODEL_META, capabilitiesOf, resolveFeatures, FEATURE_LABEL, THINK } from '../../src/model-caps.js';
import { patchCustom } from '../../src/custom-config.js';
import { looksInjected } from '../../src/injection.js';
import { GATE_ERROR_KIND, isBlocking } from '../../src/gate-scan.js';
import { providerOf } from '../../src/net-rules.js';
import { applySettingsPatch } from '../../src/plugin-settings.js';
import { pushLog } from './runtime-state.js';
import { sendJson, readBody } from './http-io.js';
import { readConfig, writeConfig } from './config-io.js';
import { extensionsOf } from './extensions.js';
import {
  MAX_CHAIN_LEN, localChannelOf, modelProviderMismatch, normalizeThinking,
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
      for (const raw of body.fallbackModels) {
        const m = String(raw || '').trim();
        if (!m || seen.has(m)) continue; // 空项、重复项、与主模型撞车的一律静默丢弃
        const bad = modelProviderMismatch(m, providerNow);
        if (bad) {
          pushLog(`✗ 降级链里有不匹配的模型：${m}`);
          return sendJson(res, { ok: false, error: bad, provider: providerNow }, 400);
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
    // 三个能力开关（联网 / 识图 / 表情）。
    // 这里是**第三道闸**（前两道：界面上灰显、前端提交前拦）。真正兜底的是它：
    // 不管配置是从界面上改的、还是手改 config.json 的，落盘前都收敛一次。
    if (body.features && typeof body.features === 'object') {
      cfg.llm.features = {
        webSearch: body.features.webSearch === true,
        vision: body.features.vision === true,
        stickers: body.features.stickers === true,
      };
    }
    // 无论这次有没有传 features，都按**最终落盘的模型**再收敛一次。
    // 为什么必须做：换到纯文本模型时，之前开着的识图/联网会被服务端 400 拒掉 ——
    // 表现是"机器人突然不说话了"，而用户根本想不到是自己切了模型导致的。
    // 静默关掉 + 明确告诉他关了哪一项，好过一个看不出原因的哑巴。
    const featureBefore = { ...(cfg.llm.features || {}) };
    const conv = resolveFeatures(providerNow, cfg.llm.model, cfg.llm.features);
    cfg.llm.features = conv.features;
    const autoDisabled = [];
    for (const k of ['webSearch', 'vision']) {
      if (featureBefore[k] === true && conv.features[k] === false) autoDisabled.push(k);
    }
    cfg.allow = cfg.allow || {};
    if (Array.isArray(body.groups)) cfg.allow.groups = body.groups.map((x) => String(x).trim()).filter(Boolean);
    // 黑名单。优先级高于白名单（src/brain.js 的 decide() 里先判 deny），
    // 所以界面上要写清楚"进了黑名单就不管白名单了"，否则用户会以为两个都设了是"取交集"。
    cfg.deny = cfg.deny || {};
    if (Array.isArray(body.denyGroups)) cfg.deny.groups = body.denyGroups.map((x) => String(x).trim()).filter(Boolean);
    if (Array.isArray(body.denyUsers)) cfg.deny.users = body.denyUsers.map((x) => String(x).trim()).filter(Boolean);
    cfg.trigger = cfg.trigger || {};
    if (typeof body.requireAtInGroup === 'boolean') cfg.trigger.requireAtInGroup = body.requireAtInGroup;
    if (typeof body.interjectChance === 'number') cfg.trigger.interjectChance = Math.min(1, Math.max(0, body.interjectChance));
    if (Array.isArray(body.aliases)) cfg.trigger.aliases = body.aliases.map((s) => String(s).trim()).filter(Boolean);
    if (typeof body.personaName === 'string' && body.personaName.trim()) {
      cfg.persona = cfg.persona || {};
      cfg.persona.name = body.personaName.trim();
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
      const psPatch = body.custom?.plugins?.settings;
      if (psPatch && typeof psPatch === 'object' && !Array.isArray(psPatch)) {
        const declaredById = new Map();
        for (const it of (extensionsOf(cfg.custom?.plugins?.enabled || [])?.items || [])) {
          // ⚠️ 只把**有默认值**的包纳入闸门。清单只声明了 `configSchema`（没有默认值）的包
          //    在投影里是空对象 —— 拿它当"声明的键的集合"会把用户所有合法输入判成越界。
          //    实测 13 个真实包**全部**有 `settings`（且与 configSchema 同键），所以这不影响覆盖面；
          //    写这一句是为了"将来出现 schema-only 包时不会误杀"。
          if (Object.keys(it.settings || {}).length) declaredById.set(it.id, it.settings);
        }
        const current = cfg.custom?.plugins?.settings || {};
        for (const [id, patch] of Object.entries(psPatch)) {
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) continue;
          if (!declaredById.has(id)) continue; // 包不在（还没拷进来）→ 不卡这一步
          const r = applySettingsPatch({ declared: declaredById.get(id), prev: current[id] || {}, patch });
          if (!r.ok) {
            pushLog(`✗ 插件设置被拒（${id}）：${r.reason}`);
            return sendJson(
              res,
              {
                ok: false,
                error: `插件「${id}」的设置没有保存：${r.reason}\n` +
                  '只允许填清单里声明过的键（面板上已经按类型列出来了），值也要与类型相符。',
              },
              400
            );
          }
          // ★ 把**强转之后**的那份写回请求体 —— 面板送来的是控件里的字符串（"20"），
          //   不写回的话存的还是字符串，插件读到一个 str 而清单声明的是 number。
          //   那正是"静默存成错值"：面板上看不出任何异常。
          psPatch[id] = r.value;
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
