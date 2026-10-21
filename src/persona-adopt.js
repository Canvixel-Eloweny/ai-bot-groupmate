/**
 * ══════════════════════════════════════════════════════════════════════
 *  角色卡「AI 认领」——把一张不标准格式的卡，归到十维的标准字段
 * ══════════════════════════════════════════════════════════════════════
 *  为什么需要这一步（鸡生蛋的那颗蛋）：
 *    分级只读卡里那 24 个标准字段（`src/persona-grade.js`），而**完整但不标准**
 *    的卡把内容写在背景 / 示例 / 描述里 —— 内容一点都不缺，缺的是"归位"。
 *    归位交给模型做一次（花一次额度、面板给预览、确认才写），比在本地按关键词
 *    猜"这段描述算自我还是本我"靠谱。
 *
 *  三条硬规矩（都写进提示词，也在 `parseAdopt` 里兜）：
 *    ① **只从素材里搬，不许编**：素材没提到的维度留空字符串。
 *    ② 每维只写具体的事（谁 / 为什么 / 怎么做），不写"温柔善良"这种评价词。
 *    ③ 输出只有一个 JSON 对象，键固定为十维的 id（面板不猜键名）。
 *
 *  ⚠️ 纯函数叶子：不读时钟、不碰 IO。提示词、解析、字段映射都在这里一份，
 *     脚本（`scripts/adopt-card.mjs`）与测试共用 —— 两边各写一份提示词
 *     就会出现"测试过的那份和线上跑的那份不是同一份"。
 */
import { TEN_DIMS, fieldForDim } from './persona-grade.js';

/** 送给模型的卡文本上限（再长也让它在预算里；素材本身超了就先截）。 */
export const ADOPT_MAX_INPUT = 12000;
/** 模型每维的输出上限（先卡住，别让它写一整篇文章）。 */
export const ADOPT_DIM_CHARS = 600;
/** 落进卡字段的上限 —— 与 `custom-config.js` 的 `TEXT_LONG` 一致，否则归一化会腰斩。 */
export const ADOPT_MAX_FIELD = 1200;

/** 十维 id 的集合（提示词与解析共用同一份，不许各写一遍）。 */
export const ADOPT_DIM_IDS = Object.freeze(TEN_DIMS.map((d) => d.id));

/**
 * 组装这一次调用的消息。
 *
 * @param {{name?: string, text?: string}} card 卡的显示名 + 卡里的全部文字
 * @returns {Array<{role: string, content: string}>}
 */
export function adoptMessages({ name, text } = {}) {
  const who = String(name ?? '').trim().slice(0, 40) || '未命名';
  const body = String(text ?? '').slice(0, ADOPT_MAX_INPUT).trim();
  const dims = TEN_DIMS
    .map((d) => `- ${d.id}（${d.label}）：${d.question}`)
    .join('\n');
  const system = [
    '你在做「角色卡归档」：把一张格式不标准的角色卡，按下面十维拆成结构化字段。',
    '',
    '规则：',
    '1. 只从素材里搬，不许编造、不许补设定、不许把"可能是"写成"就是"。素材没提到的维度，值写空字符串。',
    `2. 每维不超过 ${ADOPT_DIM_CHARS} 字，写具体：谁、为什么、怎么做。不写评价词（"温柔善良"这种不算内容）。`,
    '3. 角色自称、口头禅、语气这类原话可以照抄；不要改写成书面语。',
    '4. 只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。键固定为下面十维的 id，一个不多一个不少。',
    '',
    '十维（键 = id，括号里是这一维要回答的问题）：',
    dims,
    '',
    '输出形状示例（值可以是空字符串）：',
    `{"${ADOPT_DIM_IDS[0]}": "……", "${ADOPT_DIM_IDS[1]}": "", …}`,
  ].join('\n');
  const user = [
    `角色名：${who}`,
    '',
    '素材（这张卡里的全部文字，来源不同请自己判断该归到哪一维）：',
    body || '（空）',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 去掉模型爱加的代码块围栏，并尽量从一段话里抠出 JSON。 */
function jsonOf(raw) {
  const s = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* 下面再抠 */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

/**
 * 解析模型输出。**只收认识的键**：十维的 id，或十维自己的候选字段名
 * （模型很爱直接吐 `fear` / `relation` 这种字段名，实测第一版就撞上了）。
 * 两个都不认识的键直接丢 —— 自创键写进卡里会被归一化静默扔掉，而面板看起来"存上了"。
 *
 * @param {string} raw 模型的原始输出
 * @returns {{byDim: Record<string,string>, filled: number, missing: string[]}}
 *          `missing` = 素材里没被认领出来的维度 id（面板提示"这几维还没有"）。
 */
export function parseAdopt(raw) {
  const obj = jsonOf(raw);
  const byDim = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { byDim, filled: 0, missing: ADOPT_DIM_IDS.slice() };
  }
  // 先按 id 收（最准），再按字段名收（同一个键不覆盖）。
  const FIELD_DIM = {};
  for (const d of TEN_DIMS) for (const f of d.fields) if (!FIELD_DIM[f]) FIELD_DIM[f] = d.id;
  for (const [key, v] of Object.entries(obj)) {
    const id = ADOPT_DIM_IDS.includes(key) ? key : FIELD_DIM[key];
    if (!id || byDim[id] || typeof v !== 'string') continue;
    const t = v.trim().slice(0, ADOPT_DIM_CHARS).trim();
    if (t) byDim[id] = t;
  }
  return {
    byDim,
    filled: Object.keys(byDim).length,
    missing: ADOPT_DIM_IDS.filter((id) => !byDim[id]),
  };
}

/**
 * 把「十维文本」映射到这张卡该写的字段上。
 *
 * ⚠️ 字段选择复用 `fieldForDim()`（第一个**空着**的标准字段）—— 与面板
 *    「写进这张卡」按钮是同一条判据，否则同一句话在这里进 `self`、在那里进 `traits`。
 *
 * @param {Record<string,string>} byDim `parseAdopt` 的结果
 * @param {{fields?: Record<string,string>}} card 这张卡（已有字段决定写哪个键）
 * @returns {{fields: Record<string,string>, wrote: Array<{id:string,label:string,field:string,chars:number,text:string}>}}
 */
export function adoptFields(byDim, card) {
  const fields = {};
  const wrote = [];
  for (const d of TEN_DIMS) {
    const text = String(byDim?.[d.id] ?? '').trim().slice(0, ADOPT_MAX_FIELD).trim();
    if (!text) continue;
    const field = fieldForDim(card && typeof card === 'object' ? card : {}, d.id);
    if (!field) continue;
    // 同一字段被两维同时选中时，**先到先得**：后来那维并进同一格会变成一锅粥。
    if (fields[field]) continue;
    fields[field] = text;
    wrote.push({ id: d.id, label: d.label, field, chars: text.length, text });
  }
  return { fields, wrote };
}
