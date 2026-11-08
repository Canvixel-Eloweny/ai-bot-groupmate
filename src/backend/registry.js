/**
 * L3 聚合适配层 · 后端注册表（唯一真相源）。
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么要有这一层
 * ══════════════════════════════════════════════════════════════════════════
 *  我方生产面只调 OneBot v11 的一小撮动作，而 NapCat / SnowLuma / LLBot /
 *  Lagrange 对同一动作的**入参优先级与失败形状**并不相同（见
 *  `docs/design/PROTOCOL-END-BLUEPRINT.md` §2.4b）。把这些差异散在调用点上，
 *  每接一家就要改一遍主链路；收进这张表之后，调用方只问"我的后端是谁"。
 *
 *  ⚠️ 这张表**只描述已取证的事实**，不猜：
 *    · NapCat 的 `get_forward_msg` 是 `message_id || id`，数字 message_id 走历史回查；
 *    · LLBot 把两个键都按 **resId 字符串**解读，`id` 才是它的正路；
 *    · SnowLuma 的 `message_id` 是 int32 哈希、**可为负**；
 *    · `can_send_image` / `can_send_record` 在 LLBot 上恒 true，不能当能力真值。
 *  未取证的部分一律写 `unknown`，不替对方"应该支持"。
 *
 *  ⚠️ 本文件是**零依赖叶子**：不 import 任何运行时模块（config / onebot / panel），
 *  这样面板、机器人、测试、将来的安装器都能直接读同一张表。
 */

/** 生产链路实际使用的动作（10 个；含 2 条只读回读）。 */
export const PRODUCTION_ACTIONS = Object.freeze([
  'send_group_msg',
  'send_private_msg',
  'send_group_forward_msg',
  'send_private_forward_msg',
  'get_forward_msg',
  'get_group_member_info',
  'get_login_info',
  'get_group_list',
  'get_version_info',
  'get_status',
]);

/** 只读白名单里与"媒体能力"相关的动作 —— 它们在各家之间的差异最大。 */
export const MEDIA_ACTIONS = Object.freeze([
  'get_image',
  'get_record',
  'can_send_image',
  'can_send_record',
]);

/**
 * 上游 `can_send_*` 自报一律不可信（LLBot 恒 true）。这是**唯一判定值**——
 * `normalize.capabilitiesOf()` 只引用它，不再在 normalize 里另写一份字面量。
 */
export const UNTRUSTED_CAN_SEND = Object.freeze({
  image: 'untrusted',
  record: 'untrusted',
});

/**
 * 一家后端 = 一张冻结表。
 *
 * `forwardOrder` 用的是 **OneBot 入参键名**（`message_id` / `id`），不是我们的内部名：
 * 调用方拿它去拼 attempts，就不会再各自决定"先试哪个"。
 * `supports` 只写**有差异**的动作；没写的生产动作用 `actionSupportOf` 的默认值。
 */
const DEF = {
  napcat: {
    id: 'napcat',
    label: 'NapCat',
    license: 'LRL（装后现下；禁内嵌分发）',
    autoDownload: true,
    forwardOrder: ['message_id', 'id'],
    messageId: 'int-or-resid',
    supports: {
      get_version_info: 'yes',
      get_status: 'yes',
      get_image: 'yes',
      get_record: 'yes',
    },
  },
  snowluma: {
    id: 'snowluma',
    label: 'SnowLuma',
    license: '非商业许可（禁内嵌分发）',
    autoDownload: false,
    forwardOrder: ['message_id', 'id'],
    // int32 哈希、可为负 —— 任何把 id 当无符号数用的代码都会歪。
    messageId: 'int32-may-negative',
    supports: {
      get_version_info: 'yes',
      get_status: 'yes',
      get_image: 'yes',
      get_record: 'yes',
    },
  },
  llbot: {
    id: 'llbot',
    label: 'LLBot',
    license: 'GPLv2 + PMHQ（有强制外部鉴权）',
    autoDownload: false,
    // 两个键都按 resId 字符串解读 ⇒ `id` 必须先试；先喂整数 message_id 是空转。
    forwardOrder: ['id', 'message_id'],
    messageId: 'resid-string',
    supports: {
      get_version_info: 'unknown',
      get_status: 'unknown',
      get_image: 'unknown',
      get_record: 'unknown',
    },
  },
  lagrange: {
    id: 'lagrange',
    label: 'Lagrange.OneBot',
    license: 'AGPL-3.0（OneBot 只在 v1 分支）',
    autoDownload: false,
    forwardOrder: ['message_id', 'id'],
    messageId: 'int',
    supports: {
      get_version_info: 'yes',
      get_status: 'yes',
      get_image: 'unknown',
      get_record: 'unknown',
    },
  },
  generic: {
    id: 'generic',
    label: 'OneBot v11（通用）',
    license: '未知',
    autoDownload: false,
    forwardOrder: ['message_id', 'id'],
    messageId: 'unknown',
    supports: {
      get_version_info: 'unknown',
      get_status: 'unknown',
      get_image: 'unknown',
      get_record: 'unknown',
    },
  },
  /**
   * QQ 官方机器人（2026-11-06）。
   *
   * ⚠️ 它**不是** OneBot 实现，而是"另一个通道"：只有 `channel.mode === 'official'`
   *    时才会被选中（见 `src/backend/channel.js`），`onebot.backend` 里选不到它 ——
   *    因为 `auto` 的识别方式是问 `get_version_info`，而官方 API 根本没有这个动作。
   *    把两件事混成一个键，就会长出"配置说官方、代码在连 3001"这种两边各自自洽的状态。
   *
   * `supports` 里写 `'no'` 的四条是**取证过的没有**，不是"没测"：
   *   出站没有合并转发、没有历史回查、群成员/群资料接口是内邀白名单（`11253`）。
   */
  official: {
    id: 'official',
    label: 'QQ 官方机器人',
    license: 'QQ 开放平台服务条款（合规路线，无第三方协议端）',
    autoDownload: false,
    // 官方没有合并转发端点 ⇒ 顺序表为空，`forwardAttemptsFor` 会回"没有可尝试的参数"。
    forwardOrder: [],
    // 群与人都是 openid 字符串；`toNum()` 认不出来会原样传，这正好是我们要的行为。
    messageId: 'openid-string',
    supports: {
      send_group_forward_msg: 'no',
      send_private_forward_msg: 'no',
      get_forward_msg: 'no',
      get_group_member_info: 'no',
      get_version_info: 'no',
      get_status: 'yes',
      get_image: 'no',
      get_record: 'no',
    },
  },
};

const BACKENDS = Object.freeze(
  Object.fromEntries(Object.entries(DEF).map(([k, v]) => [k, Object.freeze(v)])),
);

const BACKEND_IDS = Object.freeze(Object.keys(BACKENDS));

/**
 * `auto` 是"让运行时按 `get_version_info` 识别"，不是一家后端。
 *
 * ⚠️ `official` **不在这一张表里**：它不是 OneBot 实现，识别方式也不是 `get_version_info`
 *    （官方 API 没有这个动作）。它只能由 `channel.mode` 显式选中，
 *    所以默认只许从"OneBot 家族"里选；`driver.js` 会带着 `allowOfficial` 例外放行，
 *    那是 index 已经按通道决定完之后传进来的，不是用户能填的第二个入口。
 */
const ONEBOT_SELECTIONS = Object.freeze(
  ['auto', ...BACKEND_IDS.filter((x) => x !== 'generic' && x !== 'official')],
);
const ALL_SELECTIONS = Object.freeze([...ONEBOT_SELECTIONS, 'official']);

/** 配置里的值 → 合法选择。不认识的一律回 `auto`（不猜、不抛）。 */
export function normalizeBackend(value, { allowOfficial = false } = {}) {
  const v = String(value ?? '').trim().toLowerCase();
  const table = allowOfficial ? ALL_SELECTIONS : ONEBOT_SELECTIONS;
  return table.includes(v) ? v : 'auto';
}

/**
 * 从 `get_version_info` 的自报值识别后端。
 * ⚠️ 识别不出来就回 `generic`，**不猜最近的一家**：猜错会让 forward 参数顺序走错。
 * @param {{app_name?:string, app_version?:string}} data
 */
export function backendOfSelfReport(data) {
  const s = `${data?.app_name ?? ''} ${data?.app_version ?? ''}`.toLowerCase();
  if (s.includes('napcat')) return 'napcat';
  if (s.includes('snowluma')) return 'snowluma';
  if (s.includes('llbot') || s.includes('luckylillia')) return 'llbot';
  if (s.includes('lagrange')) return 'lagrange';
  return 'generic';
}

/**
 * 最终用哪一家：**显式配置优先**，`auto` 才看自报。
 * 显式配置优先是有意的 —— 用户知道自己在接什么时，不该被一条自报字符串改掉参数顺序。
 */
export function resolveBackend({ configured = 'auto', selfReport = null } = {}) {
  const c = normalizeBackend(configured);
  if (c !== 'auto') return c;
  return backendOfSelfReport(selfReport);
}

export function backendLabel(id) {
  return BACKENDS[id]?.label || BACKENDS.generic.label;
}

export function backendOf(id) {
  return BACKENDS[id] || BACKENDS.generic;
}
