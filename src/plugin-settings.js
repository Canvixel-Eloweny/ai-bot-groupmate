/**
 * 扩展包设置的**判据层**（D7 / 报告 E1 的收口）。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  这一步要解决的两件事
 * ══════════════════════════════════════════════════════════════════════
 * ① **面板只能给一个 JSON 大框**（第 55 轮的形态）。实测真实 13 个包的设置
 *    共 36 个键，类型恰好四类：`bool 10 / number 18 / string 4 / list 4`。
 *    也就是说"逐项控件"这件事**有数据支撑**（不是替包猜形状）：
 *    类型就藏在**清单默认值的 JS 类型**里 —— 默认值 `true` 就是开关、`20` 就是数字。
 *
 * ② **写回没有边界**。面板原来把用户填的 JSON 整份塞进 `settings[id]`，
 *    于是"往别的包身上写"或"写一个清单里根本没有的键"都不会被拦。
 *    本模块给出**唯一一份**命名空间/越界判据，服务端在保存时用它。
 *
 * ⚠️ 关于报告里说的"enum 控件"：**没有数据支撑**，所以不做。
 *    实测 36 个键里**没有一个**声明过候选值（清单里只有 `键 → 默认值`，没有 options/type 元数据），
 *    硬做就得**发明一种没人用的元数据**——那正是本项目明令否决的"提前通用化"。
 *    `list`（短字符串数组）用多行文本表达，已经覆盖现有四类。
 *
 * ⚠️ 零依赖叶子：smoke 直接喂反例，面板与服务端共用同一份判据（避免两份拷贝）。
 */

/**
 * 敏感键名特征。命中的 `string` 键在面板上渲染成**密码框**（点一下才显示）。
 *
 * 为什么按**键名**而不是按"值看起来像不像密钥"：值可能是空的（还没填），
 * 而"这个键是不是放凭据的"由键名决定 —— 与生态里的实际命名一致（`cookie` / `token` / `apiKey`）。
 */
const SENSITIVE_KEY_RE = /(cookie|token|secret|key|passwd|password|pwd|auth|session)/i;

/** 这个键名是不是放凭据的（面板据此选密码框）。 */
export function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(String(key ?? ''));
}

/**
 * 从**清单默认值**推断控件类型（唯一实现）。
 *
 * 判据是"值本身是什么"，不是键名的命名习惯 —— 键名千奇百怪，而 JS 类型只有这几种。
 * 认不出来的（对象 / null）返回 `'other'`：面板渲染成**只读展示**，
 * 不硬塞进某一个控件里（塞错的表现是"存下去的值悄悄地变了类型"）。
 *
 * @param {unknown} def 清单里的默认值
 * @returns {'bool'|'number'|'string'|'list'|'other'}
 */
export function kindOfSetting(def) {
  if (typeof def === 'boolean') return 'bool';
  if (typeof def === 'number' && Number.isFinite(def)) return 'number';
  if (typeof def === 'string') return 'string';
  if (Array.isArray(def)) return 'list';
  return 'other';
}

/**
 * 把一个**字符串**（面板控件送回来的原始值）按类型强转。
 *
 * ⚠️ 强转失败要**明确失败**，绝不能返回一个"看起来能用"的兜底值 ——
 *    那会把用户填错的数字静默存成 `NaN` 或者 `0`，而他在面板上看不出任何异常。
 *
 * @param {string} kind
 * @param {string} raw
 * @returns {{ok:boolean, value?:unknown, reason?:string}}
 */
export function coerceSetting(kind, raw) {
  const s = String(raw ?? '');
  switch (kind) {
    case 'bool': {
      const t = s.trim().toLowerCase();
      if (['true', '1', 'yes', 'on', '开'].includes(t)) return { ok: true, value: true };
      if (['false', '0', 'no', 'off', '关', ''].includes(t)) return { ok: true, value: false };
      return { ok: false, reason: `开关只能是 true / false（收到 ${JSON.stringify(s)}）` };
    }
    case 'number': {
      const t = s.trim();
      if (!t) return { ok: false, reason: '数字不能为空' };
      const n = Number(t);
      if (!Number.isFinite(n)) return { ok: false, reason: `不是合法数字：${JSON.stringify(s)}` };
      return { ok: true, value: n };
    }
    case 'string':
      return { ok: true, value: s };
    case 'list':
      return {
        ok: true,
        // 一行一项；顺带去掉空行 —— 空行是"手滑回车"，不是数据
        value: s.split('\n').map((x) => x.trim()).filter(Boolean),
      };
    default:
      return { ok: false, reason: '这一项的默认值不是基本类型，宿主不支持直接编辑（请改清单）' };
  }
}

/**
 * 面板渲染用的**控件描述**（服务端算好、页面只渲染）。
 *
 * 为什么由服务端算：类型判据必须只有一份。让页面自己按 `typeof` 再判一遍，
 * 就会在"某一侧改了判定而另一侧没改"时静默漂移 —— 本项目已经在
 * `normalizeThinking` 上真实踩过一次（两处实现各写一份，靠契约才发现）。
 *
 * @param {Record<string, unknown>} declared 清单声明的键 → 默认值
 * @param {Record<string, unknown>} user 用户在面板上填的那份（可空）
 * @returns {{key:string, kind:string, sensitive:boolean, def:unknown, value:unknown}[]}
 */
export function settingsSpec(declared, user) {
  const defs = declared && typeof declared === 'object' && !Array.isArray(declared) ? declared : {};
  const mine = user && typeof user === 'object' && !Array.isArray(user) ? user : {};
  return Object.keys(defs).map((key) => ({
    key,
    kind: kindOfSetting(defs[key]),
    sensitive: isSensitiveKey(key),
    def: defs[key],
    // 用户没填过就用清单默认值 —— 与 `settingsOf()` 的合并口径一致
    value: Object.prototype.hasOwnProperty.call(mine, key) ? mine[key] : defs[key],
  }));
}

/**
 * 应用一次设置补丁：**命名空间 + 越界 + 类型**三重判据（唯一实现）。
 *
 * 三条拒绝理由，缺一条都会变成事故：
 *   ① **越界键**：patch 里出现清单没声明的键 → 拒绝。放行的话，面板（或任何调用方）
 *      可以往这个包的设置里塞任意东西，而扩展包会把它当成"用户配置"读走。
 *   ② **类型不合**：按 kind 强转失败 → 拒绝，并说清是哪一项、为什么。
 *   ③ **未声明的 kind**：默认值不是基本类型（对象 / null）→ 拒绝编辑，不猜。
 *
 * ⚠️ 只处理**一个包**的设置。跨包的写入（A 包想改 B 包的设置）在调用方就被拦住 ——
 *    函数签名里没有"包 id"，它拿不到别的包那一格。
 *
 * @param {{declared:Record<string,unknown>, prev:Record<string,unknown>, patch:Record<string,string>}} p
 * @returns {{ok:boolean, reason:string, value:Record<string,unknown>}}
 */
export function applySettingsPatch({ declared, prev, patch }) {
  const defs = declared && typeof declared === 'object' && !Array.isArray(declared) ? declared : {};
  const before = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {};
  const next = { ...before };

  const incoming = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const keys = Object.keys(incoming);

  // ① 越界键：先整体拒掉，不做"部分写入" —— 部分写入会让用户以为保存成功了
  const outOfBounds = keys.filter((k) => !Object.prototype.hasOwnProperty.call(defs, k));
  if (outOfBounds.length) {
    return {
      ok: false,
      reason: `这些键不在清单声明的设置里，已整条拒绝（不部分写入）：${outOfBounds.join('、')}`,
      value: next,
    };
  }

  // ② 类型（按清单默认值的类型强转）
  for (const k of keys) {
    const kind = kindOfSetting(defs[k]);
    const r = coerceSetting(kind, incoming[k]);
    if (!r.ok) return { ok: false, reason: `设置「${k}」：${r.reason}`, value: next };
    next[k] = r.value;
  }
  return { ok: true, reason: '', value: next };
}
