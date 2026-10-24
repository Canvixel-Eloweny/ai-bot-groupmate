import fs from 'node:fs';
import {
  ENHANCE, ENHANCE_KEYS, ENHANCE_GROUPS, PERSONA_KEYS, PLAY_RULES, REPLY_LENGTHS, SCENES,
  SKILL_IN_PROMPT, SKILL_CHARS_IN_PROMPT, MANUAL_MEMORY_IN_PROMPT, SIMILAR_THRESHOLD, readCustom,
} from '../../src/custom-config.js';
import {
  PROMPT_BUDGET_CHARS, RECALL_MAX, RECORD_STATUS, RECORD_STATUS_LABELS,
  REVIEW_ACTIONS, REVIEW_ACTIONS_FOR, SAMPLES_FOR_STABLE, SAMPLES_TO_CONFIRM,
} from '../../src/memory-record.js';
import { FEATURE_LABEL, ZHIPU_MODEL_META } from '../../src/model-caps.js';
import { LOCK_REFUSE_EXIT_CODE } from '../../src/bridge-lock.js';
import { fieldMeta } from '../../src/field-schema.js';
import { isLocalBase, onebotEndpointOf, providerOf } from '../../src/net-rules.js';
import { livenessVerdictOf } from '../../src/onebot-liveness.js';
// L3 聚合层（2026-10-20）：面板只转述"识别到的后端"，不自己再写一份名字映射。
import { backendOfSelfReport, backendLabel } from '../../src/backend/registry.js';
import { classifyOneBotReply, selfReportTrustOf } from '../../src/backend/normalize.js';
// 桌面端「启动方式」（2026-10-16）：唯一判据住 `src/launch-mode.js` ——
// 面板这里只下发**结论**（与启动器执行的那一个值逐字一致），不许自己再判一遍；
// 启动跟踪（launch-log）的读口也在这里，卡片上的「上次启动」就是它。
import { LAUNCH_ENTRY_LABELS, launchLogPath, launchOfConfig, readLaunchLog } from '../../src/launch-mode.js';
import { readAutostartState } from '../../src/desktop/autostart.js';
// 「这家的免费额度长什么样」（额度类型 / 能不能查实时余额 / 该去哪个页面看）。
// 唯一实现住 src/free-quota.js —— 面板**不要**自己再写一份文案：
// 千问那句"用完即停开关默认是关的"是**真会让人被扣钱**的提醒，抄一份就多一处会腐烂的地方。
import { quotaPlanOf } from '../../src/free-quota.js';
// 自定义大脑（2026-10-07）：列表与"当前用的是哪套"。判据住 `src/custom-brain.js`。
import { activeBrainOf, brainListOf, visibleFeatureKeysOf } from '../../src/custom-brain.js';
import { listAutoMemory } from '../../src/memory-store.js';
import { readHistory } from '../../src/config-history.js';
import {
  CONFIG_FILE, DOCKER, DOCKER_APP, HISTORY_FILE, IS_WIN, MLX_PY, NAPCAT_WEBUI_PORT,
  PANEL_STATE_DIR, QWENCHAT_SERVER, QWEN_SERVER,
} from './paths.js';
import {
  LOCAL_CHANNELS, LOCAL_MODELS, LOCAL_MODEL_SUPPORTED, LOCAL_MODEL_UNSUPPORTED_WHY,
  MODEL_LABELS, ZHIPU_DEFAULT_CHAIN, buildModelCaps, defaultChainOf,
  localChannelOf, localKeyOf, localModelExists, normalizeThinking, readPresets,
  resolveLocalKey, PRESET_KEYS,
} from './models.js';
import { cachedDockerPs, cachedDockerUp, cachedMemory, httpGet, portOpen, sh, winMemoryOf, wsProbe } from './proc.js';
import { CONTROL_LABELS, controlStateOf } from './control.js';
import { extensionsOf } from './extensions.js';
import { readBotData } from './bot-data.js';
// 角色卡十维判据（唯一实现住 src/persona-grade.js —— 面板不抄第二份门槛表）。
import { gradePersonaCard } from '../../src/persona-grade.js';
import { readConfig } from './config-io.js';
import { readModelSync } from './model-sync-state.js';
import { readTrace } from './trace-io.js';
import { state } from './runtime-state.js';

/** 开机自启三态每 10 秒最多查一次系统：面板轮询 3 秒一次，不能每轮起 PowerShell/reg。 */
let autoStartCache = { at: 0, value: null };
function autoStartStateOf() {
  const now = Date.now();
  if (autoStartCache.value && now - autoStartCache.at < 10000) return autoStartCache.value;
  const value = readAutostartState();
  autoStartCache = { at: now, value };
  return value;
}

/** 面板刚写过系统启动项时先用 15 秒临时回执，之后回到系统查询。 */
function launchAutoStartState() {
  if (state.autoStartState && Date.now() - Number(state.autoStartAt || 0) < 15000) {
    return { state: state.autoStartState, shortcut: state.autoStartDetail || '' };
  }
  return autoStartStateOf();
}

/**
 * 把 `get_version_info` / `get_status` 两份回包收成「协议端自报」这一块。
 *
 * 纯函数：不碰 IO、不猜缺省 —— 没答就 `answered:false`，字段缺就留空串。
 * 键名按两家实物核对过（2026-10-20 取证）：`get_version_info` 回 `app_name`/`app_version`/
 * `protocol_version`（NapCat `action/system/GetVersionInfo.ts:6-9`、SnowLuma `onebot/src/actions/info.ts:63-67`
 * 两家逐字一致，也是 OneBot 11 规范名）；`get_status` 回 `online`/`good`（NapCat `GetStatus.ts:5-8`）。
 *
 * ⚠️ **只转述、不下结论**，两个理由：① 有的家没实现这两条动作（LLBot 未取证、官方群侧无此端点）；
 *    ② 自报值不能当健康判据 —— NapCat 的 `GetStatus.ts:29-30` 就把 `good` 写死 `true`，
 *    Lagrange 的 `online/good` 同样是硬编码、LLBot 的 `can_send_*` 恒 true。
 *    字段前缀 `self` 就是为了把这件事写在名字上。
 *
 * @param {{ok:boolean,body:string}|null} verRes `/get_version_info` 的原始回包
 * @param {{ok:boolean,body:string}|null} statRes `/get_status` 的原始回包
 * @param {number} [now] 面板探测时刻（可注入，保持纯函数）
 * @returns {{answered:boolean,appName:string,appVersion:string,protocolVersion:string,
 *            statusAnswered:boolean,selfOnline:boolean|null,selfGood:boolean|null,probedAt:number,
 *            backendId:string,backendLabel:string,selfReportTrust:object}}
 */
export function onebotSelfReport(verRes, statRes, now = Date.now()) {
  // 与账号那一支同一个口径：`status==='ok'` 或 `retcode===0` 才算它答了。
  const dataOf = (res) => {
    if (!res || !res.ok) return null;
    try {
      const rep = classifyOneBotReply(JSON.parse(res.body));
      return rep.businessOk ? (rep.data ?? null) : null;
    } catch { return null; }
  };
  const s = (x) => (x === undefined || x === null ? '' : String(x));
  const v = dataOf(verRes);
  const st = dataOf(statRes);
  // 后端识别只从**自报 app_name** 来；识别不出就是 generic，不猜最近的一家。
  const backendId = backendOfSelfReport(v);
  return {
    backendId,
    backendLabel: backendLabel(backendId),
    // 自报值可不可信（NapCat/Lagrange 的 good 写死 true、LLBot 的 can_send_* 恒 true）。
    // 面板原样转述这份结论，不自己再判一遍。
    selfReportTrust: selfReportTrustOf(backendId),
    answered: !!v,
    appName: s(v?.app_name),
    appVersion: s(v?.app_version),
    protocolVersion: s(v?.protocol_version),
    statusAnswered: !!st,
    selfOnline: st ? !!st.online : null,
    selfGood: st ? !!st.good : null,
    // 面板这次探测的时刻：与机器人侧的心跳时刻并排显示时，
    // 读的人才能分清"两个来源各是什么时候看到的"（B6 双时刻）。
    probedAt: now,
  };
}

/**
 * 「面板状态」聚合（`/api/state` 的数据源）—— H-10 第二半 · 第 19 轮从主文件搬出。
 * ══════════════════════════════════════════════════════════════════════════
 * 层号 **L3**：依赖 L2 的 `models.js` / `proc.js`，也是本仓 lib 最深一层。
 *
 * ⚠️ **十一个判据全部是注入的，不是搬进来的**（理由与 `config-route.js` 同形）：
 * 它们在主文件里各自还有别的调用点，而 ESM 的 import 绑定在**外部只读**
 * ——搬进来就得在主文件留一份壳，两份实现各活一份、后改的那份不生效。
 *
 * ⚠️ **三个模块级缓存因此留在主文件，这正是我们要的**：
 * `usageCache` / `usageFileCache` / `bridgeInstCache` 由 `readUsage` 与
 * `countBridgeInstances` 持有，而它们**被collectState 外面**的
 * `apiUsageReset`（清零）与 `invalidateBridgeInstances`（起停后失效）赋值。
 * 若连缓存一起搬，那两处块外赋值会因只读绑定而**默默变成两份缓存** ——
 * 症状是「清零后数字不刷新」「起停后实例数不更新」，**且完全不报错**。
 * 注入 `readUsage` / `countBridgeInstances` 这两个函数，缓存就永远不跨模块边界。
 *
 * @param {object} deps 主文件注入的判据（见上面的清单）
 * @returns {Promise<object>} 可直接 JSON.stringify 的状态对象
 */
export function makeStateCollector(deps) {
  const {
    IMPORTABLE_KEYS, bridgeRunning, countBridgeInstances, memoryRecordsOf,
    napcatToken, panelInfo, readBridgeLock, readDebugFlag, readEffective,
    readThinking, readUsage, winMemory,
  } = deps;

  return async function collectState() {
    const cfg = readConfig();

    // daemon 不在就别白等 docker 命令超时了，直接判定容器没跑
    const daemonUp = await cachedDockerUp();
    const containerLine = await cachedDockerPs();
    const containerRunning = /Up/i.test(containerLine);
    // 这台机器上「容器」这条部署路线适不适用（第 53 轮 · B2）。
    // ⚠️ 判据**不是平台**，而是"有没有在走这条路"：
    //    容器在跑 / daemon 在跑 / Docker Desktop 装着 —— 三者有其一即适用。
    //    Windows 便携版用**原生 NapCat**、不装 Docker ⇒ 三项全否 ⇒ 不适用。
    //    此时界面不该把"容器没跑"当故障报（那是个**假警报**，用户会去查一个不存在的容器）。
    const containerApplicable = containerRunning || daemonUp || (!!DOCKER_APP && fs.existsSync(DOCKER_APP));

    // ── 协议端地址：**只有一个来源**（配置里机器人连的那条）─────────────────────
    // ⚠️ 这两个端口以前是写死的 `3000` / `3001`。它们只是 macOS 那条 Docker 路线
    //    "容器端口映射"的巧合，**不是协议端的定义**：Windows 便携版跑的是原生 NapCat，
    //    端口由用户在自己的 NapCat 里配。写死的后果不是报错，而是面板**连探都不探** ——
    //    屏幕上「协议端端口」永远"断"、「登录账号」永远"未登录"，
    //    而机器人其实连着、消息流一直有记录。判据见 `src/net-rules.js` 的 onebotEndpointOf。
    const onebot = onebotEndpointOf(cfg?.onebot);

    // 真问一次协议端，而不是只看端口。
    // ⚠️ 这一步**不再以"容器在不在跑"为前提**：容器只是 macOS 那条部署路线的实现细节，
    //    协议端在不在，只有一个正确的判据 —— 问它本人。
    // 2026-10-20 追加两条回读（`/get_version_info`、`/get_status`）：同一次并行探测，
    // 不额外增加延迟（三条都在同一个 Promise.all 里，各自 2.5s 上限，答不上就空）。
    const [infoRes, verRes, statRes, wsRes, p6099] = await Promise.all([
      httpGet(onebot.httpPort, '/get_login_info'),
      httpGet(onebot.httpPort, '/get_version_info'),
      httpGet(onebot.httpPort, '/get_status'),
      wsProbe(onebot.wsPort),
      portOpen(NAPCAT_WEBUI_PORT),
    ]);

    let account = null;
    if (infoRes.ok) {
      try {
        const rep = classifyOneBotReply(JSON.parse(infoRes.body));
        if (rep.businessOk) {
          account = {
            userId: String(rep.data?.user_id ?? ''),
            nickname: String(rep.data?.nickname ?? ''),
          };
        }
      } catch { /* 不是 JSON 就当没连上 */ }
    }

    // ── 协议端自报的身份与状态（2026-10-20 补的两条回读）─────────────────────
    // 上面那条 `onebotHttp: infoRes.ok` 只回答"有没有人答 HTTP"，不回答"答的是谁、
    // 报的哪一版"。这一块把后者摆出来供核对（换协议端 / 版本对不上 QQ 时，这是第一眼线索）。
    // ⚠️ 只转述、不判红：自报值不可信（Lagrange 的 online/good 写死 true），而且有的家
    //    根本没实现这两条动作 —— 拿"它没答"去报故障，等于把"这家没实现"说成"我方坏了"。
    const onebotAgent = onebotSelfReport(verRes, statRes);

    // ── 登录状态（第 53 轮 · B2：整段从"容器在跑"这个前提里解出来）──────────
    // 原来整段包在 `if (containerRunning)` 里 ⇒ Windows 上恒为 false ⇒
    // 无论协议端多健康，界面都显示"未登录 / 容器没在运行"。
    let loggedIn = false;
    let loginHint = '';
    let qrDecodeUrl = '';

    if (account) {
      loggedIn = true;
      loginHint = `已登录：${account.nickname}（${account.userId}）`;
    } else if (infoRes.ok) {
      // 协议端答了、只是没给账号信息 ⇒ 它是活的、还没登录
      loginHint = '协议端在跑，但还没登录（要扫码）';
    } else if (containerRunning) {
      // **只有这一支**才需要翻容器日志找原因（原来是无条件翻，白跑 docker logs）
      const lg = await sh(DOCKER, ['logs', '--tail', '150', 'napcat']);
      const all = lg.stdout + lg.stderr;
      if (/二维码|qrcode/i.test(all)) {
        loginHint = '等待扫码';
        const m = all.match(/二维码解码URL:\s*(\S+)/g);
        if (m && m.length) qrDecodeUrl = m[m.length - 1].replace(/^二维码解码URL:\s*/, '');
      } else if (/快速登录错误|登录态已失效/.test(all)) {
        loginHint = '登录态已失效，需要重新扫码';
      } else {
        loginHint = '正在启动 / 等待登录';
      }
    } else {
      loginHint = `协议端没有响应（${onebot.httpHost}:${onebot.httpPort}）—— `
        + '没启动，或它的端口与配置里 onebot.wsUrl 写的对不上';
    }

    const llmKey = cfg?.llm?.apiKey || process.env[cfg?.llm?.apiKeyEnv || ''] || '';
    const baseUrl = String(cfg?.llm?.baseUrl || '');
    // 用和计费完全同一套规则判断，避免"面板说是本地、统计却按云端算"的错位
    const isLocalBrain = isLocalBase(baseUrl);

    // 两条本地通道各探一次。正常情况下只会有其中一条活着 —— 它们互斥，
    // 但因为服务可能是上次控制台（或用户手点 QwenChat.app）起的，所以不能靠记忆，要实探。
    const wantChannel = localChannelOf(cfg?.llm?.localChannel);
    const [mlxRes, qcRes] = await Promise.all([
      httpGet(LOCAL_CHANNELS.mlx.port, '/v1/models', 1500),
      httpGet(LOCAL_CHANNELS.qwenchat.port, '/v1/models', 1500),
    ]);
    const liveChannel = mlxRes.ok ? 'mlx' : qcRes.ok ? 'qwenchat' : '';
    const localRes = liveChannel === 'qwenchat' ? qcRes : mlxRes;
    let localModelIds = [];
    if (localRes.ok) {
      try {
        localModelIds = (JSON.parse(localRes.body)?.data || []).map((m) => m.id);
      } catch { /* 忽略 */ }
    }

    // 端口上跑着的到底是哪个规格（可能是别的控制台起的，只能从接口反推）
    const runningKey = localRes.ok
      ? localKeyOf(localModelIds[0]) || (liveChannel === state.localChannel ? state.localModelKey : '') || ''
      : '';

    let eff = readEffective();
    // 兜底：快照文件可能丢失（比如退出的孤儿实例清掉过它），
    // 但只要机器人进程还活着，就用配置文件的值顶上 —— 总比面板显示一片空白强。
    if (!eff?.alive && bridgeRunning()) {
      eff = {
        pid: state.bridge?.pid || state.bridgePid || null,
        alive: true,
        inferred: true, // 告诉前端"这是推断出来的，不是机器人自己写的"
        model: cfg?.llm?.model || '',
        baseUrl,
        isLocal: isLocalBrain,
        fallbackModels: cfg?.llm?.fallbackModels || [],
        thinking: normalizeThinking(cfg?.llm?.thinking),
        temperature: cfg?.llm?.temperature ?? 1,
        maxTokens: cfg?.llm?.maxTokens ?? 400,
      };
    }

    // 页面不再自带"这个地址属于哪家"的判据（B11c · AR-DATADRIVEN）。
    // 与 `config.provider` 同源（都走 `providerOf()`），页面只读结论、不重算 ——
    // 这正是"第三份模型名单"消掉时的同一个办法（改判据只动一处，页面自动跟着变）。
    // ⚠️ 放在最后、覆盖两个来源（快照文件 / 上面那段"进程还活着"的推断），
    //    否则"推断出来的那条生效信息"会缺 provider 字段，页面又得回去猜。
    if (eff) eff = { ...eff, provider: providerOf(eff.baseUrl || '') };

    // 「自定义工作台」归一化**只算一次**：下面 `custom` 与 `extensions` 都要用它的结论。
    // 算两遍不只是浪费 —— 两份归一化结果一旦因为入参不同而分叉，就会出现
    // "页面上显示已启用、机器人却不认"这种没法复现的差异（本项目最怕的形状）。
    const custom = readCustom(cfg);

    // ── 内存那一段（2026-10-09 · 第 53 轮 · B2）─────────────────────────────
    // macOS：`cachedMemory()` 走 `vm_stat` / `sysctl` / `ps -Ao`。
    // Windows：那三个命令一个都没有（所以 `readMemory()` 如实返回 null）⇒
    //          改走注入进来的快照 → `winMemoryOf()` 换算（快照由 L3 的 server.js
    //          用一次 PowerShell 取回，带 15 秒缓存）。
    // ⚠️ **两条路都可能给 null**（采不到），而前端把 null 渲染成"暂不支持"——
    //    这是刻意的：显示 `0 MB` 等于撒谎（读的人只会理解成"它几乎不占内存"，
    //    不可能想到"这个数根本没采到"）。
    const memory = (await cachedMemory())
      ?? (IS_WIN && winMemory ? winMemoryOf(await winMemory()) : null);

    return {
      // 面板自己的版本自检（页面据此判断"是不是在跟一个跑着旧代码的后端说话"）
      panel: panelInfo(),
      container: {
        running: containerRunning,
        line: containerLine,
        loggedIn,
        loginHint,
        qrDecodeUrl,
        // 「容器」这条部署路线在**这台机器上**适不适用（第 53 轮 · B2）。
        // false = 用户走的是原生 NapCat（Windows 便携版不装 Docker）⇒ 界面不该把
        // "容器没跑"当故障显示 —— 那会让用户去查一个**根本不存在的容器**。
        applicable: containerApplicable,
      },
      docker: { daemon: daemonUp, app: !!DOCKER_APP && fs.existsSync(DOCKER_APP) },
      memory,
      ports: {
        onebotHttp: infoRes.ok,
        onebotWs: wsRes.ok,
        webui: p6099,
        // 探的是哪两个端口（第 53 轮：端口改从配置解析，界面要能核对"我探的是不是它"）。
        // ⚠️ 下发这四个数字是为了**排错**：端口对不上时，用户一眼能看出面板在探哪儿。
        onebot: {
          http: onebot.httpPort,
          ws: onebot.wsPort,
          wsConfigured: onebot.wsConfigured,
          httpIsDefault: onebot.httpIsDefault,
        },
        // 协议端**自报**的身份与版本（同一次探测里拿的，不是另一个真相源）。
        // 放在 `ports` 这一组是因为它就是"那条 HTTP 探测答了什么"的一部分；
        // 「启动链路」检查表读的也是这一组（判据见 check-wb §100 的字段白名单）。
        // `bot` = 机器人进程自己看到的连接健康（来自 effective.json，由机器人每 20 秒刷一次）。
        // ⚠️ 它与 `probedAt` 是**两个观测面、两个时刻**：面板探 HTTP、机器人守 WS 与心跳。
        //    别把任何一个当成另一个的"实时版"（它们的采样周期不同，也不保证同时成功）。
        onebotAgent: { ...onebotAgent, bot: eff?.onebotHealth || null },
      },
      // 协议端存活结论（B3）：端口通 ≠ 事件流活。判据住 src/onebot-liveness.js，
      // 面板只转述 code；页面按 code 决定颜色与文案（不在前端重算阶梯）。
      onebot: {
        ...livenessVerdictOf({
          health: eff?.onebotHealth || null,
          ports: { http: infoRes.ok, ws: wsRes.ok },
        }),
        transports: { http: infoRes.ok, ws: wsRes.ok, webui: p6099 },
      },
      account,
      localModel: {
        // 这一整套（MLX 模型 + 两条通道 + 启动命令）**在这个平台上成不成立**（第 53 轮 · B6）。
        // false = Windows（那边是 Apple Silicon 专用的实现，一个都不存在）⇒
        // 面板据此把这一块**整块隐藏并指路**，而不是摆一堆点了必然失败的控件。
        supported: LOCAL_MODEL_SUPPORTED,
        unsupportedWhy: LOCAL_MODEL_UNSUPPORTED_WHY,
        running: !!liveChannel,
        channel: liveChannel,            // 实际活着的那条通道（空 = 没在跑）
        wantChannel,                     // 配置里希望用的通道
        channels: Object.entries(LOCAL_CHANNELS).map(([key, v]) => ({
          key, label: v.label, port: v.port, up: key === 'mlx' ? mlxRes.ok : qcRes.ok,
        })),
        ports: Object.fromEntries(Object.entries(LOCAL_CHANNELS).map(([k, v]) => [k, v.port])),
        port: liveChannel ? LOCAL_CHANNELS[liveChannel].port : LOCAL_CHANNELS[wantChannel].port,
        ids: localModelIds,
        starting: !!state.localModel,
        startingKey: state.localChannel ? state.localModelKey : '',
        runningKey,
        available: fs.existsSync(QWEN_SERVER),
        qwenchatAvailable: fs.existsSync(QWENCHAT_SERVER) && fs.existsSync(MLX_PY),
        // exists 让前端只列出磁盘上真的有的规格（用户删掉某个模型后下拉自动变）
        presets: Object.entries(LOCAL_MODELS).map(([k, v]) => ({
          key: k, label: v.label, path: v.path, exists: localModelExists(k),
        })),
      },
      usage: readUsage(),
      // 可撤销的次数（B10b · O-CFGHIST）。只下發**条数**，不下发历史内容 ——
      // 那份文件里是完整的 config.json（含 API Key），不该被轮询反复搬来搬去。
      configHistory: readHistory(HISTORY_FILE).length,
      /* ★ 官方模型目录对账的结果（2026-10-17）：只读，页面拿它弹右下角提示。
         事件由 `panel/lib/model-sync.js` 在启动 / 6 小时节流时写入；
         页面自己按事件 id 去重（`localStorage`），所以同一个版本只弹一次。
         ⚠️ 它在**顶层**而不是 `config` 里：对账记录是面板的运行态，不是用户的配置。 */
      modelSync: readModelSync(),
      // 机器人真正在用的配置；null 表示机器人没在跑
      effective: eff,
      // 正在生成回复？（本机模型慢，面板要能显示"它在干活"）
      thinking: readThinking(),
      // ⚠️ 这里原本还有 `token: napcatToken()`（2026-10-05 开源前审查 · S-09 移除）：
      //    那是 QQ **登录会话**的 WebUI 凭据，而 `/api/state` 是**只读路由、不鉴权** ——
      //    任何本机进程、以及 DNS Rebinding 之后的网页，都能不带凭据拿到它。
      //    而**现役控制台根本没用这个字段**（`panel/next/` 里只有动作名 `open.webui`
      //    与端口状态 `ports.webui`，打开的是 `/api/qrcode`）—— 它是已下线旧页面的遗留。
      webui: { url: `http://localhost:6099/webui` },
      bridge: {
        running: bridgeRunning(),
        pid: state.bridge?.pid || state.bridgePid || null,
        uptimeMs: state.bridge ? Date.now() - state.bridgeStartedAt : 0,
        lastExit: state.lastExit,
        // 系统里**实际**有几个实例（≥2 就是"在抢同一条群消息"）。null = 这次没扫出来。
        // 它是这个缺陷唯一能被用户看见的地方 —— 详见 countBridgeInstances 的注释。
        instances: await countBridgeInstances(),
        // 控制通道（D6b）：最近一条命令的下发与执行情况。null = 从来没下发过。
        // ⚠️ 只读盘，不判断"机器人该不该执行"—— 那套判据在 src/control-channel.js，
        //    面板再判一次就会出现两份"什么算过期"。
        control: controlStateOf(),
        // 实例锁（D19）：谁持着"我在这里跑"这份排他声明。null = 没有锁 / 读不出来。
        // 页面靠它在"点了启动会被拒"**之前**就把这件事说出来（面板自己不删锁 —— Q19）。
        lock: readBridgeLock(),
        // "启动被拒"的退出码，页面拿它把 `lastExit.code === 3` 翻译成人话。
        // 从 src/bridge-lock.js 取，不在前端再写一个 3。
        refuseExitCode: LOCK_REFUSE_EXIT_CODE,
      },
      debugLog: readDebugFlag(),
      config: {
        // 用户选的后端（`auto` = 让机器人按 get_version_info 识别）。
        // 面板只转述配置；**识别结果**在 `ports.onebotAgent.backendId`，两者不同：
        // 配置是"我想要哪家"，识别是"实际连上的那家"。
        backend: cfg?.onebot?.backend || 'auto',
        wsUrl: cfg?.onebot?.wsUrl || '',
        baseUrl,
        model: cfg?.llm?.model || '',
        fallbackModel: cfg?.llm?.fallbackModel || '',
        fallbackModels: cfg?.llm?.fallbackModels || [],
        provider: providerOf(baseUrl),
        features: {
          webSearch: cfg?.llm?.features?.webSearch === true,
          vision: cfg?.llm?.features?.vision === true,
          },
        thinking: normalizeThinking(cfg?.llm?.thinking),
        hasKey: isLocalBrain || !!llmKey,
        keyNotNeeded: isLocalBrain,
        // ⚠️ 原本是 `llmKey.slice(0, 6) + '…' + llmKey.slice(-4)`（2026-10-05 审查 · S-10 改掉）。
        //    `/api/state` 不鉴权，而 Key 的前 6 后 4 是**唯一会流出进程的真实字符** ——
        //    它虽不足以直接复用那把 Key，但足够做指纹识别与定向钓鱼。
        //    改成"掩码 + 长度"：面板照旧能显示"填没填、多长"，但不给出任何真实字符。
        keyMasked: llmKey ? `${'•'.repeat(8)}（${llmKey.length} 位）` : '',
        maxTokens: cfg?.llm?.maxTokens ?? 400,
        localChannel: localChannelOf(cfg?.llm?.localChannel),
        localSize: resolveLocalKey(localKeyOf(cfg?.llm?.model) || cfg?.llm?.localSize),
        // 四套大脑各自存着的那份设置（面板切换时直接用它渲染，不用再发一次请求）
        presets: readPresets(cfg),
        activePreset: providerOf(baseUrl),
        // 自定义大脑（2026-10-07）：**刻意不混进 `presets`** —— 那张表是
        // "服务商 → 一套设置"，而自定义是"用户自己命名的多套"，形状不同。
        //
        // ⚠️⚠️ **下发前必须剥掉 `apiKey`**：`/api/state` **不鉴权**，
        //    而它是唯一每 3 秒被轮询一次的接口 —— 把 Key 带出去等于把它
        //    广播给同机任何能访问这个端口的东西。（本项目在 `keyMasked`
        //    那一条上已经踩过一次"前 6 后 4 也算泄露"，这里更彻底：连字符都不给。）
        //    ⇒ 只给 `hasKey`（填没填），界面靠它决定提示文案。
        customBrains: brainListOf(cfg).map((b) => ({
          id: b.id,
          name: b.name,
          baseUrl: b.baseUrl,
          model: b.model,
          // 这套大脑属于哪家（2026-10-17）：**判据仍然只有一份**（`providerOf`）。
          // 前端要在标签/条目上写「DeepSeek / 智谱 / 千问 / 自定义」，但它不该
          // 自己再按域名判一次 —— 那会变成第二份会漂的规则（本项目踩过）。
          provider: providerOf(b.baseUrl),
          hasKey: !!String(b.apiKey || '').trim(),
          fallbackModels: b.fallbackModels,
          features: b.features,
          maxTokens: b.maxTokens,
          temperature: b.temperature,
        })),
        activeCustomId: activeBrainOf(cfg)?.id || '',
        // 当前是自定义大脑时，下发"**该显示哪几项能力**"的**结论**。
        // ⚠️ 判据只有一份（`visibleFeatureKeysOf`），前端**不许**按 `features` 自己再判一遍 ——
        //    那会出现"页面显示的"与"后端认的"两套口径，而两边看起来都正常
        //    （本项目在"前端自存一份名单"这件事上已经踩过好几次）。
        //    `null` = 当前不是自定义大脑（内置那几家照旧全显示）。
        customVisibleFeatures: (() => {
          const b = activeBrainOf(cfg);
          return b ? visibleFeatureKeysOf(b) : null;
        })(),
        // 每家有没有存过 Key —— 面板要按大脑提示"这家的 Key 填没填"。
        // ⚠️ 名单**从 `PRESET_KEYS` 派生**，不再手写数组（2026-10-07 接千问时改的）。
        //    原来写的是 `['deepseek', 'zhipu']` —— 加一家就必须记得回来加一个名字，
        //    而漏掉的症状很隐蔽：千问那一页的 Key 输入框下方**不显示"已保存"提示**，
        //    用户会以为刚才填的 Key 没存上，然后再填一遍。
        //    （`local` 不在名单里：本机模型不需要 Key。）
        keySaved: Object.fromEntries(
          PRESET_KEYS.filter((k) => k !== 'local')
            .map((k) => [k, !!String(cfg?.llm?.keys?.[k] || '').trim()])
        ),
        groups: cfg?.allow?.groups || [],
        // 私聊白名单（2026-10-12；面板上现在叫「同意私聊的 QQ 号」）：机器人侧一直按 `allow.private` 判定私聊放行，
        // 但面板从没下发过它 ⇒ 界面上看不见也改不了。下发与落盘两处一起补。
        privateUsers: cfg?.allow?.private || [],
        // 主人 QQ（2026-10-21）：睡眠叫醒的唯一身份判据，加载时会自动补进私聊白名单。
        owners: cfg?.owner?.qq || [],
        // 当前读的是真配置还是模板。用模板时面板**保存不会写进模板**，
        // 用户看到"保存成功"却不生效 —— 这一格就是用来把这件事摆到台面上的。
        source: fs.existsSync(CONFIG_FILE) ? 'config.json' : 'config.example.json',
        // 黑名单也下发 —— 面板要能编辑它（以前只有后端认这个字段，界面没有入口）
        denyGroups: cfg?.deny?.groups || [],
        denyUsers: cfg?.deny?.users || [],
        requireAtInGroup: cfg?.trigger?.requireAtInGroup !== false,
        aliases: cfg?.trigger?.aliases || [],
        interjectChance: cfg?.trigger?.interjectChance ?? 0,
        /* 插话冷却（2026-10-17）：与 interjectChance 同一族 —— 机器人一直按它判
           「插话冷却中」（`src/brain.js`），但面板既没下发也没写入入口，
           于是它是**唯一一条只能手改 config.json 的发言闸门**。
           下发的是**毫秒原值**：换算成分钟只发生在前端控件那一处（`scale`）。 */
        interjectCooldownMs: cfg?.trigger?.interjectCooldownMs ?? 300000,
        personaName: cfg?.persona?.name || '',
        // 分段标记（第 53 轮 · B4）：以前面板上一个入口都没有，于是它坏掉（空串）时
        // 用户**看不见也改不了** —— 而空串的后果是"一条回复被逐字发出去"。
        // 下发给页面是 `""` 时界面按"要用默认值"提示（后端 normalizeSplitToken 已兜底）。
        splitToken: cfg?.reply?.splitToken || '',
        // 桌面端「启动方式」（2026-10-16）：`{ mode, openOnStart, unknownMode, last }`。
        // 下发的是**结论** —— 认不出的 mode 在启动时按 browser 执行，面板也照这个
        // 结论显示；否则两格单选会"一个都不选中"（看起来像面板坏了，其实是配置写错了）。
        // `last` = 最近一次**启动跟踪**（哪个入口 + 用什么形态 + 有没有回落）：
        // 三个启动器每次都会往这个文件写一行（见 src/launch-mode.js 的 recordLaunch），
        // 让"双击了却没按我选的来"在现场就能看见，而不用去猜。
        launch: {
          ...launchOfConfig(cfg),
          autoStartState: launchAutoStartState().state,
          autoStartDetail: launchAutoStartState().shortcut || '',
          last: (() => {
            const e = readLaunchLog(launchLogPath(CONFIG_FILE, PANEL_STATE_DIR), { limit: 1 })[0] || null;
            if (!e) return null;
            return { ...e, entryLabel: LAUNCH_ENTRY_LABELS[e.entry] || e.entry || '未知入口' };
          })(),
        },
      },
      // 「自定义工作台」那一整块。归一化逻辑在 src/custom-config.js（与机器人共用一份），
      // 面板只负责渲染 —— 不自己写默认值，才不会出现"面板上填了、机器人没读"。
      custom,
      // 角色卡分级（十维）：面板只渲染，判据在 src/persona-grade.js。
      // 只算 `kind:'persona'` 的卡；`custom.skills` 里没有卡就是空数组。
      personaCards: (custom.skills || [])
        .filter((sk) => sk && sk.kind === 'persona')
        .map((sk) => ({ ...gradePersonaCard(sk), id: sk.id || '', enabled: sk.enabled !== false, scope: sk.scope || { type: 'global' } })),
      // 自动记忆（机器人唯一写入者，面板只读）。形状和手动记忆一致，便于前端一起渲染。
      autoMemory: listAutoMemory(),
      // 结构化记忆（ATI-3 存量 + 人工复核的状态，ATI-5）。
      // 面板在这里是**读 + 只改状态**；新增与复证仍然只有机器人进程做（`appendRecord`）。
      memoryRecords: memoryRecordsOf(),
      // 场景 / 回复长短的**显示名**。放后端是为了让面板不必再抄一份中文表
      // （抄两份必然漂移，这个项目已经因为同样的原因踩过好几次）。
      customMeta: {
        scenes: SCENES,
        replyLengths: REPLY_LENGTHS,
        similarThreshold: SIMILAR_THRESHOLD,
        // 扮演规则的清单（只读）。放在后端是为了让"提示词里到底写了哪几条"
        // 和"面板上给你看的是哪几条"永远出自同一份 —— 前端不用也不会再抄一份。
        playRules: PLAY_RULES,
        // 增强 12 项：字段名 / 中文标签 / 提示 / 示例 / 分组，全部由后端给。
        // 前端只负责按分组摆出来 —— 它不再自存任何一个中文名（本项目"一份数据
        // 维护两遍"踩过四次，每一次都是这样开始的）。
        enhance: { table: ENHANCE, keys: ENHANCE_KEYS, groups: ENHANCE_GROUPS },
        // 人格 12 项 / 增强 12 项的**键名**，供「套用角色卡」按归属分派用
        // （2026-10-15 · B3 / Issue #5）。角色卡里那份快照是「人格 12 + 增强 12 +
        // 场景 9」混在一个扁平对象里，前端必须知道每个键该写回 `persona.*` 还是
        // `enhance.*` —— 此前一律写进 `persona.*`，增强那 12 个是非法键、
        // 被归一化（personaFields）当场丢掉，表现就是"语气对了、演法没换"。
        // 归属名单只此一份（来自 src/custom-config.js），前端不自抄。
        personaKeys: PERSONA_KEYS,
        enhanceKeys: ENHANCE_KEYS,
        // 导入白名单：前端渲染「导入到此为止」的说明和导入本身都用它，只有这一份
        importableKeys: IMPORTABLE_KEYS,
        // 技能相关上限：界面上要写明"最多同时上几条"，不然用户会以为填了就一定生效。
        // 2026-10-23 起是**生效值**（config 可配），不是常量默认值。
        skillInPrompt: custom.skillPrompt?.max ?? SKILL_IN_PROMPT,
        skillInPromptChars: custom.skillPrompt?.chars ?? SKILL_CHARS_IN_PROMPT,
        // 手动记忆的注入上限，同样由后端下发 —— 前端一个数字都不自存。
        manualMemoryInPrompt: custom.memory?.promptMax ?? MANUAL_MEMORY_IN_PROMPT,
        // 数值类设置的**默认值与上下限**（B12b · SCHEMA-LITE）。
        // 页面用它填三件事：① 提示文字里的数字（`data-num`）；② `<input min max>`（`data-limit`）；
        // ③ 收集表单时的兜底值。以前这三处各抄一次，漂了只会让界面撒谎。
        fieldMeta: fieldMeta(),
        // 结构化记忆那一块的中文名与按钮表（ATI-5）。全部来自 `src/memory-record.js` ——
        // 面板一个中文名都不自存；`actionsFor` 还顺手挡掉"已确认的条目还给一个「认可」按钮"
        // 这种说了等于没说的界面。
        memoryReview: {
          statusOrder: RECORD_STATUS,
          statusLabels: RECORD_STATUS_LABELS,
          actions: REVIEW_ACTIONS,
          actionsFor: REVIEW_ACTIONS_FOR,
          samplesToConfirm: SAMPLES_TO_CONFIRM,
          samplesForStable: SAMPLES_FOR_STABLE,
          promptBudgetChars: PROMPT_BUDGET_CHARS,
          // 一次回忆最多带几条（D-M3）。页面写说明时直接用它，不自存数字。
          recallMax: RECALL_MAX,
        },
        // 控制通道（D6b）的中文名表。同一条纪律：页面不许自存这几个中文串，
        // 否则改了标签就只剩后端生效（而界面上不会报错，只是两处说法不一样）。
        control: { labels: CONTROL_LABELS, kinds: Object.keys(CONTROL_LABELS) },
      },
      // 最近 3 次「群消息 → 提示词 → 模型输出 → 发出去的段」的完整链路
      trace: readTrace(),
      // 模型 id → 显示名。前端**不要**再自己抄一份：以前前后端各存一份，
      // 改一个忘一个（前端那份至今少着 glm-ocr）。以后加模型只改后端这张表。
      modelLabels: MODEL_LABELS,
      // 能力开关的**显示名**（联网查询 / 识图）。
      // 唯一真相源是 src/model-caps.js 的 FEATURE_LABEL —— 机器人侧自动关掉某个能力时
      // 的提示语用的也是它。面板上「发言与时机 → 触发方式」与「自定义工作台」两处摆的是**同一份配置**，
      // 文字也必须逐字一致：一边写"联网查询"、另一边写"联网搜索"，用户会以为这是两个功能。
      featureLabels: FEATURE_LABEL,
      // 智谱模型档案：实测延迟 / 走哪个额度包 / 官方免费 / 思考形态。
      // 面板上那条可拖动的「优先级线路」全部靠它渲染 —— 前端**不要**再抄一份模型名单，
      // 以前前后端各存一份的结果就是漂移（前端那份曾少了 glm-ocr）。
      zhipuMeta: ZHIPU_MODEL_META,
      // 默认链路顺序。前端只在"配置里链是空的"时拿它当兜底展示。
      zhipuDefaultChain: ZHIPU_DEFAULT_CHAIN,
      /* ★ **当前这家**的默认链（含它自己的主模型）。2026-10-17 加：
         面板的「恢复实测最优」以前**写死**取 `zhipuDefaultChain` —— 于是在千问页面上点一下，
         提交上去的是一条 GLM 链（而 `/api/config` 对千问刻意放行跨家名字），
         结果就是"选了千问、降级链全是 GLM、一条都打不通"。
         ⇒ 判据收到 `defaultChainOf(provider)`（唯一一份），前端不再自己挑名单。 */
      defaultChain: defaultChainOf(providerOf(baseUrl)),
      // ★ 按（服务商，模型）算好的能力表 —— 面板靠它决定哪个开关能点、哪个要灰掉。
      //   派生逻辑在 src/model-caps.js，机器人发请求前用的是同一套函数；
      //   前端只渲染结论，不重复实现判定（重复实现过一次，就是"前后端说的不一样"）。
      modelCaps: buildModelCaps(),
      // ★ 各家的「免费额度说明」（2026-10-07 · 接千问时新增）。
      //   四家全下发（合计约 1KB），不做"只下发当前那家"的优化 ——
      //   面板上那张「免费额度」卡要**同时**显示"现在在用的这家"和"另一家还剩什么"，
      //   （用户的原话需求就是"统一处理免费额度的使用与切换"）。
      //   ⚠️ 这些是**规则文案**，不是余额数字。余额只有智谱能查（`liveBalance: 'api'`），
      //      千问**查不到**（`'none'`）—— 面板照实渲染，不许编数字。
      quotaPlans: Object.fromEntries(
        ['local', 'deepseek', 'zhipu', 'qwen'].map((p) => [p, quotaPlanOf(p)])
      ),
      // 插件快照（B12d · EX-PLUGIN）。面板**自己扫**（理由见 `lib/extensions.js` 文件头），
      // 不依赖机器人进程 —— 机器人没在跑时，正是用户最想核对"我装的包对不对"的时候。
      // 白名单取上面刚归一化过的那一份（`custom.plugins.enabled`），不重读一遍配置：
      // 两处各读一次就会分叉，而分叉的表现是"页面说已启用、后端其实没认"。
      // D7：第二个参数是"用户在面板上填的那份设置" —— 由 `extensionsOf` 把每个包的设置
      // 算成**控件描述**（类型 / 是否密码框 / 当前值）随状态下发。
      // 为什么判据在服务端：类型只有一份来源，页面只按 `kind` 渲染（两份判定必然漂移）。
      // ⚠️ 第二个参数是 **opts 对象**（`{userSettings, maxPlugins}`），不是"设置本体"。
      //    2026-10-23 修：这里原先直接传 `custom.plugins.settings`，被解构成
      //    `{now, force, userSettings}` ⇒ `userSettings` 恒为 `{}` ⇒ 面板永远显示
      //    清单默认值，用户填的值存进了 config 却在刷新后"消失"。这是"设置存不上"
      //    的第二条真因（第一条是 app.js 的 change 分支缺失）。
      extensions: extensionsOf(custom.plugins.enabled, {
        userSettings: custom.plugins.settings,
        maxPlugins: custom.plugins.max,
      }),
      // ── 插件写的数据（2026-10-02）─────────────────────────────────────
      // 情绪 / 群友档案 / 图库张数 / 免费额度情报 —— 这四份数据**一直是插件在写**，
      // 但从来没有出口，所以页面只能摆一张写着"未实现"的骨架。
      //
      // ⚠️ 面板**直接读盘**，不经机器人转发：都是普通 JSON，而"机器人没在跑"恰恰是
      //    用户最想看这些数据的时候（让他先起机器人才能看心情，是本末倒置）。
      // ⚠️ 读失败**不抛**（这里每 3 秒被拉一次，抛一次整份快照就 500）；形状与纪律
      //    全在 `lib/bot-data.js`（白名单投影 / 认不出不猜 / 不下发绝对路径）。
      ...readBotData(),
    };
  };
}
