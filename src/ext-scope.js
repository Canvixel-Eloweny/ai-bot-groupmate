/**
 * ══════════════════════════════════════════════════════════════════════
 *  扩展包的**能力边界层**（第 48 轮 B12e-4 · EX-SCOPE）
 *  零依赖叶子
 * ══════════════════════════════════════════════════════════════════════
 *
 *  ────────────────────────────────────────────────────────────────────
 *  它要堵的那个洞：`onebot` 是宿主与协议端之间的**全量桥**
 *  ────────────────────────────────────────────────────────────────────
 *  第 47 轮把工具定义的形状对齐成生态约定 `execute(ctx, args)`，于是 ctx 里
 *  放进了 `onebot`。那不是"多给一个字段"，而是把**绕过宿主一切出站策略**的能力
 *  交给了一段外来代码：
 *
 *    · 出口闸门（凭据 / 本机路径不外泄到群里）—— 不经过
 *    · 发送节奏（`src/pace.js`）—— 不经过
 *    · 主动出站配额（`src/proactive.js`）—— 不经过
 *    · 会话存档 —— 不经过
 *
 *  而这一切在日志里只表现为"工具调用成功"。`ctx.onebot.call('send_group_msg', …)`
 *  可以往任意群说话，宿主一条都拦不住、也留不下痕 —— 正是本项目最贵的那类
 *  "改了不报错、事后无人能查"。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  处置：不给原始客户端，给一个**按白名单放行的代理**
 *  ────────────────────────────────────────────────────────────────────
 *  | 动作 | 决定 | 理由 |
 *  |---|---|---|
 *  | `send_*`（发言类） | **拒绝 + 告警** | 发言能力只走宿主自己那条路（`ctx.sender`，背后是出口闸门与节奏控制） |
 *  | 只读查询（群信息 / 成员 / 登录号…） | 放行 | 读不到凭据、说不了话，给出去没有额外风险 |
 *  | **其余一切** | **拒绝** | **默认拒绝，不是默认放行** —— 新动作出现时先拒，等有人真的需要再逐个加 |
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 这是**有意的偏差**，别照着"对齐生态"改回去
 *  ────────────────────────────────────────────────────────────────────
 *  生态通行的做法是给**原始**客户端。
 *  "外来代码能绕过宿主所有出站策略"换不来任何价值 —— 它只是省了宿主一层适配。
 *  偏差已记在计划附 V.4。
 *
 *  ⚠️ **零依赖叶子**（与 `hook-bus` / `plugin-api` / `send-guard` 同纪律）：
 *     它会被机器人进程与测试同时加载，多一条边就多一条成环的路。
 */

/**
 * 发言类动作的判据。**一处定义**。
 *
 * 用前缀而不是枚举：OneBot v11 的发言动作有 `send_group_msg` / `send_private_msg` /
 * `send_msg` / `send_group_forward_msg` / `send_private_forward_msg` / `send_like` …
 * 枚举一定会漏（漏掉的那个就是下一个洞），前缀不会。
 */
export const SEND_ACTION_RE = /^send_/;

/**
 * 放行的**只读**动作白名单。
 *
 * 取的是"看一眼协议端的状态"这一类 —— 查询型、无副作用、拿不到凭据。
 * ⚠️ 这是一份**白名单**：没列进来的一律拒绝（见 `actionDecision`）。
 */
export const READONLY_ACTIONS = Object.freeze([
  'get_login_info',
  'get_status',
  'get_version_info',
  'get_group_list',
  'get_group_info',
  'get_group_member_list',
  'get_group_member_info',
  'get_friend_list',
  'get_stranger_info',
  'get_msg',
  'get_forward_msg',
  'get_image',
  'get_record',
  'can_send_image',
  'can_send_record',
]);

/**
 * 一个动作放不放行。**纯函数**（扩展包边界上唯一的那处判据）。
 *
 * @param {string} action
 * @returns {{ok:boolean, reason:''|'empty'|'send'|'unknown'}}
 *   `send` = 发言类（拒绝，且这是**最要紧**的那一类）
 *   `unknown` = 不在只读白名单里（默认拒绝）
 */
export function actionDecision(action) {
  const a = String(action ?? '').trim();
  if (!a) return { ok: false, reason: 'empty' };
  if (SEND_ACTION_RE.test(a)) return { ok: false, reason: 'send' };
  if (READONLY_ACTIONS.includes(a)) return { ok: true, reason: '' };
  return { ok: false, reason: 'unknown' };
}

/**
 * 把真实的 OneBot 客户端包成**只给扩展包用**的代理。
 *
 * 形状与真实客户端一致（只有 `call`），所以扩展包一行都不用改 ——
 * 它照旧写 `ctx.onebot.call('get_group_info', …)`；被拒的那一类才当场报错。
 *
 * ⚠️ **拒绝时抛错而不是返回空结果**：抛错会被 `tool-loop` 的 try/catch 折成
 *    `isError` 回灌给模型（模型能看见"这条路被宿主关了"），同时**留一条 warn 日志**
 *    —— 否则"某个包在偷偷尝试发言"在日志里一个字都没有。
 *
 * @param {{call:Function}} bot 真实的客户端
 * @param {{log?:{warn?:Function}, owner?:string}} [opts]
 * @returns {{call:(action:string, params?:object, timeoutMs?:number)=>Promise<any>}}
 */
export function scopedOnebot(bot, { log, owner = '' } = {}) {
  const who = owner ? `扩展包「${owner}」` : '扩展包';
  return {
    async call(action, params = {}, timeoutMs) {
      const d = actionDecision(action);
      if (!d.ok) {
        const why = d.reason === 'send'
          ? '发言类动作一律走宿主提供的 sender（它背后有出口闸门与节奏控制）'
          : d.reason === 'empty'
            ? '动作名是空的'
            : '不在宿主的只读白名单里';
        const fn = log?.warn;
        if (typeof fn === 'function') fn(`${who} 试图直接调用 OneBot 动作「${action}」，已拒绝：${why}`);
        throw new Error(`${who}不能直接调用 OneBot 动作「${action}」：${why}`);
      }
      return bot.call(action, params, timeoutMs);
    },
  };
}

/**
 * 把宿主的**发送适配器**（`ctx.sender`）按清单声明裁剪成某个包自己的那一份。
 *
 * ── 为什么必须有这一层（2026-10-15 补 · 对应「小鱼发不出图片」的遗留）──────────
 *  `ctx.sender` 是宿主**唯一**认可的发言通道（`scopedOnebot` 把 `send_*` 一律拒了，
 *  见上面那张表 —— 发言能力只走这条路）。而这条路此前是**无差别开放**的：
 *  `sender.sendImage` 一旦补上，**任何**启用中的包都能往任意会话发图。
 *
 *  清单里本来就有 `send_image` 这个权限名（`src/plugin-api.js` 的 `PERMISSION_NAMES`），
 *  但它**从未接线** —— 声明了不生效、不声明也没人拦。这里把它接上，口径与
 *  `ext-scope` 拒绝 `send_*` 时**逐字同款**：
 *
 *    · 拒绝时**既抛错又告警**（抛错会被 tool-loop 折成 `isError` 回灌给模型，
 *      模型看得见"这条路被宿主关了"；告警保证日志里留得下痕 —— 否则
 *      "某个包在偷偷尝试发图"在日志里一个字都没有）；
 *    · **默认拒绝**，不是默认放行（新能力出现时先拒，等有人真的需要再逐个发）。
 *
 * ⚠️ **只裁剪 `sendImage`，不动 `sendSegments`**（宁窄勿宽，加法不改默认行为）：
 *    `sendSegments` 早就在用（「合并转发发送」），而它没有对应的权限名 ——
 *    现在给它加闸等于**把已经在跑的能力收回**，那不是本条的意图。
 * ⚠️ 纯函数、零依赖：传进来的 `sender` 原样铺开，**不就地改它**（宿主那份要被复用）。
 *
 * @param {object} sender 宿主的发送适配器（`ctx.sender`）
 * @param {{owner?:string, permissions?:string[], log?:{warn?:Function}}} [opts]
 * @returns {object} 与入参同形状的副本；未声明的能力被换成一个「拒绝并告警」的函数
 */
export function scopedSender(sender, { owner = '', permissions = [], log } = {}) {
  const who = owner ? `扩展包「${owner}」` : '扩展包';
  const allow = new Set(Array.isArray(permissions) ? permissions : []);
  const refuse = (cap) => {
    const why = `${who}没有声明 ${cap} 权限`;
    return async () => {
      const fn = log?.warn;
      if (typeof fn === 'function') {
        fn(`✗ ${why} —— 已拒绝：${cap === 'send_image' ? '发图' : cap}只发给声明过它的包`
          + `（要用请在它的清单里加 "permissions": ["${cap}"]）`);
      }
      throw new Error(`${who}不能 ${cap === 'send_image' ? '发图' : cap}：没有声明 ${cap} 权限`);
    };
  };
  return {
    ...sender,
    ...(allow.has('send_image') ? {} : { sendImage: refuse('send_image') }),
  };
}
