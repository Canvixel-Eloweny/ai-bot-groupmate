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
};

const BACKENDS = Object.freeze(
  Object.fromEntries(Object.entries(DEF).map(([k, v]) => [k, Object.freeze(v)])),
);

const BACKEND_IDS = Object.freeze(Object.keys(BACKENDS));

/** `auto` 是"让运行时按 `get_version_info` 识别"，不是一家后端。 */
const BACKEND_SELECTIONS = Object.freeze(['auto', ...BACKEND_IDS.filter((x) => x !== 'generic')]);

/** 配置里的值 → 合法选择。不认识的一律回 `auto`（不猜、不抛）。 */
export function normalizeBackend(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return BACKEND_SELECTIONS.includes(v) ? v : 'auto';
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
