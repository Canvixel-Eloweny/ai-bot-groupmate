/**
 * 「这笔调用花不花钱」—— 全项目**唯一判据**（2026-10-07 · 接入千问时立）
 * ══════════════════════════════════════════════════════════════════════════
 *  解决的问题：在接千问之前，"免费"这件事**散在三处、各写了一份名单**：
 *
 *      · `panel/lib/models.js`   FREE_CLOUD_MODELS / CREDIT_CLOUD_MODELS / isZhipuModel
 *      · `panel/lib/usage-report.js`  isBillable() 里那句 `if (isZhipuModel(model)) return false`
 *      · 界面上"哪些是高亮成免费的"又按同一份名单另判一次
 *
 *  三处都对的时候看不出问题 —— 而它们**必然漂**（本项目已经因为"同一份语义两份拷贝"
 *  吃过很多次亏，最贵的一次是"同一个地址，页面说云端计费、后端按本机免费统计"）。
 *  再加一家（千问）会让份数从 3 涨到 4。所以本模块把判定收成**一份**，
 *  三家都来问它，返回一个**四选一的有限枚举**（判据的答案本来就有限，见 net-rules 的模块头）。
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *  ⚠️ 本判据回答的是「**按平台规则，这类调用现在收不收费**」，
 *     **不是**「你账户里还剩多少」。两者刻意分开：
 *
 *      · 前半句是**规则** → 有限枚举、可写死、可以断言（本模块负责）；
 *      · 后半句是**余额** → 要调远端接口、随时失效（`panel/lib/models.js` 的
 *        `readZhipuPackages` 负责智谱那一半；千问那边**根本查不到**，见 `quotaPlanOf`）。
 *
 *     把它们合并成一句"免费吗"是本项目最想避免的那种混账：余额查不到时，
 *     人会顺手把它当成"免费"，而它其实正在扣钱。
 *
 *  ⚠️ 依赖方向：本模块 import `./model-caps.js`（同目录、零依赖的能力表）。
 *     反过来**绝对不许** —— model-caps 是更底层的事实表，让它反过来依赖"计费口径"
 *     会把"模型会什么"和"用它花不花钱"搅在一起。
 */

import { ZHIPU_MODEL_META } from './model-caps.js';

/**
 * 四种情形。**字符串常量而非裸字符串**：它会被写进日志、下发给界面、被测试断言，
 * 裸写迟早出现 `'grant'` / `'Grant'` 这种谁也发现不了的失配。
 */
export const QUOTA_KIND = Object.freeze({
  /** 跑在自己机器上：不产生任何费用，也没有"额度"这回事 */
  LOCAL: 'local',
  /** 服务商白纸黑字承诺**永久免费**：不会用完，不需要盯着 */
  OFFICIAL: 'official',
  /** 赠送 / 新人额度：**现在**不花钱，但会用完、会到期 —— 必须让人看得见期限 */
  GRANT: 'grant',
  /** 按量计费：用多少扣多少 */
  PAID: 'paid',
});

/**
 * 智谱**官方承诺永久免费**的那批 —— **派生**自能力表的 `free` 标记，不手抄第二份。
 *
 * ⚠️ 这张表以前叫 `FREE_CLOUD_MODELS`，住在 `panel/lib/models.js`。
 *    搬到这里的原因是它的**语义属于本模块**（"免费"的判据），而 models.js
 *    只需要知道"怎么把免费与否显示出来"。搬完 models.js 从本模块 import ——
 *    仍然是**一份**实现，只是换了个更该待的住处。
 */
// ⚠️ 三个智谱专用名单与 `isZhipuModel()` **刻意不 export**：判据对外只开一个口子
//    （`quotaOf` / `QUOTA_KIND` / `quotaPlanOf`）。开了口子就有人绕过去直接判名字，
//    而"谁在判智谱"这件事一旦散开，下一次加家又要满仓找一遍。
const FREE_CLOUD_MODELS = new Set(
  Object.keys(ZHIPU_MODEL_META).filter((m) => ZHIPU_MODEL_META[m].free)
);

/**
 * 不在上面那份永久免费清单里、但**实测能调用**的智谱模型。
 *
 * 能用的原因是**新用户赠送额度**（官网 FAQ 提到注册送 token 额度在兜着），
 * 不是免费。额度耗尽后会开始扣费或直接不可用。
 * 单独标出来，免得用户以为"这些都是免费的"而措手不及。
 *
 * ⚠️ 这份名单**刻意保持原样搬迁**（不从 `ZHIPU_MODEL_META` 派生）：
 *    派生出来的集合会比它多出 `glm-5v-turbo`（表里有、这份名单里没有），
 *    那会**悄悄改变历史账本的计费结果** —— 搬家和改判据是两件事，不要一起做。
 *    谁要动它，是一次独立的行为变更，配独立的断言。
 */
const CREDIT_CLOUD_MODELS = new Set([
  'glm-4-flash',
  'glm-4-flash-250414',
  'glm-4.5-flash',
  'glm-4.5-air',
  'glm-4.5',
  'glm-4.6',
  'glm-4.7',
  'glm-5',
  'glm-5-turbo',
  'glm-5.1',
  'glm-5.2',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-4.6v-flashx',
  'glm-4.6v',
  'glm-4.5v',
]);

/** 智谱的模型：官方免费 or 走赠送额度，两者当前都不产生实际扣费 */
function isZhipuModel(model) {
  const m = String(model || '');
  return FREE_CLOUD_MODELS.has(m) || CREDIT_CLOUD_MODELS.has(m);
}

/**
 * 判一笔调用属于哪一类。
 *
 * ⚠️ `provider` 允许为空 —— 那是**历史账本**的形状：`usage-2026-09.jsonl` 那一批
 *    记录里没有 `v`（服务商）字段（D8 之后才开始写）。为空时按**模型名**回落，
 *    与老代码 `isZhipuModel(model)` 的口径逐字一致 ⇒ 历史账目一分钱都不会变。
 *
 *    （这也是为什么这里不做"按模型名猜服务商"的更通用实现：老记录里只可能出现
 *      智谱的 `glm-*`，千问是刚接的、不可能有历史数据。多写一条猜法就多一处会漂的语义。）
 *
 * @param {string} provider 'local' / 'deepseek' / 'zhipu' / 'qwen' / 'other' / ''（未知）
 * @param {string} model
 * @returns {{kind:string, free:boolean, why:string}} free = **现在**不花钱
 */
export function quotaOf(provider, model) {
  const m = String(model || '');
  const p = String(provider || '');

  if (p === 'local') {
    return { kind: QUOTA_KIND.LOCAL, free: true, why: '跑在本机，不产生任何费用，也没有额度这回事' };
  }

  // ── 千问 ──────────────────────────────────────────────────────────────
  // 平台按"每个模型 100 万 token、90 天有效"发赠送额度（输入输出共享）。
  // ⚠️ 所以这里给 GRANT 而不是 OFFICIAL：它**一定会用完 / 到期**。
  //    这不是保守估计，是平台规则本身 —— 面板必须把期限显示出来。
  if (p === 'qwen') {
    return {
      kind: QUOTA_KIND.GRANT,
      free: true,
      why: '平台赠送额度（每个模型 100 万 token、90 天有效）—— 用完或到期后会转按量计费',
    };
  }

  // ── 智谱 ──────────────────────────────────────────────────────────────
  if (p === 'zhipu' || (!p && isZhipuModel(m))) {
    if (FREE_CLOUD_MODELS.has(m)) {
      return { kind: QUOTA_KIND.OFFICIAL, free: true, why: '智谱官方承诺永久免费，不会用完' };
    }
    if (CREDIT_CLOUD_MODELS.has(m)) {
      return { kind: QUOTA_KIND.GRANT, free: true, why: '走智谱赠送额度，额度耗尽后会开始扣费' };
    }
    // 智谱的模型但两个名单都没有 → 不猜，按计费算（宁可多算不多算）
    return { kind: QUOTA_KIND.PAID, free: false, why: '' };
  }

  // deepseek / other / 未知：一律按计费。**不猜**（老代码同款取向：
  // "认不出来就该按 0 处理并标注出来"，而不是套一个默认价）。
  return { kind: QUOTA_KIND.PAID, free: false, why: '' };
}

/**
 * 给**界面**用的"这家额度长什么样"（下发给面板，前端不再自己抄一份文案）。
 *
 * ⚠️ 三个字段刻意分开，因为它们的能力**不对等**：
 *    · `liveBalance` —— `'api'` = 面板能查到实时余额（智谱：那个私有资源包接口，
 *      实测 API Key 直接就能查）；`'none'` = **查不到**。
 *      千问的用量查询是**账号级签名**的，光有 API Key 查不到 ⇒ 面板只能给静态说明 + 跳转。
 *      **不许**为了"看起来统一"就编一个数字出来 —— 那比没有更糟。
 *    · `controlUrl` —— 查不到实时数的，至少把人送到能自己看的地方。
 *    · `mustDo` —— 平台上有"必须自己动手、不做就静默扣钱"的开关（千问那个
 *      「免费额度用尽即停」默认是**关**的）。这类事必须写在面板上，不能只写在文档里。
 *
 * @param {string} provider
 * @returns {{label:string, kindNote:string, liveBalance:'api'|'none', controlUrl:string, mustDo:string}}
 */
export function quotaPlanOf(provider) {
  if (provider === 'qwen') {
    return {
      label: '千问',
      kindNote: '每个模型 100 万 token 赠送额度 · 90 天有效（输入与输出共用这一份）',
      liveBalance: 'none',
      controlUrl: 'https://platform.qianwenai.com/home/benefits',
      mustDo:
        '去上面那个页面把「免费额度用尽即停」打开 —— 这个开关默认是关的，'
        + '不打开的话额度一用完就直接按量扣钱，而机器人这边完全看不出来（账本上还写着"免费"）。',
    };
  }
  if (provider === 'zhipu') {
    return {
      label: '智谱',
      kindNote: 'Flash 档官方永久免费；其余模型走赠送额度（额度耗尽后开始扣费）',
      liveBalance: 'api',
      controlUrl: 'https://open.bigmodel.cn/finance/resourcepack',
      mustDo: '',
    };
  }
  if (provider === 'local') {
    return {
      label: '本机模型',
      kindNote: '跑在自己的机器上：不产生费用，也没有额度上限',
      liveBalance: 'none',
      controlUrl: '',
      mustDo: '',
    };
  }
  return {
    label: 'DeepSeek',
    kindNote: '全部按量计费，没有免费额度',
    liveBalance: 'none',
    controlUrl: 'https://platform.deepseek.com/usage',
    mustDo: '',
  };
}
