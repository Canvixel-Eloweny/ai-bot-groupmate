/**
 * ══════════════════════════════════════════════════════════════════════
 *  反模板闸（D 改造）—— 同一个模子连着来，就把它改平
 * ══════════════════════════════════════════════════════════════════════
 *  为什么是"改平"而不是"拦掉"：
 *    本项目已有一条写死的取向 —— 「说了句客服腔」的代价是"显得假"，
 *    而拦掉一整条回复的代价是"它突然不理我"，后者更难查、更伤信任
 *    （见 `src/speech-rules.js` 文件头，以及出口闸门只拦凭据/本机路径的口径）。
 *    所以这道闸的动作只有一种：**把重复的那个形状削掉，话照说**。
 *
 *  为什么必须有它（而不是只靠提示词教）：
 *    提示词里已经写了「别一个模子」，可是小模型在连续几轮里会滑回同一个形状：
 *      · 每条都用破折号抖个机灵（"——毕竟我是条鱼"）；
 *      · 每条都以同一个词开头（"行吧""好家伙""啧"）；
 *      · 每条都是"短句＋逗号＋短句"的同一副骨架、同一个长度档。
 *    这三件事**都能用文本本身判出来**，不依赖模型自省。判出来之后削一次，
 *    比祈祷它自己收敛可靠 —— 而且削掉的只是"形状"，信息一个字不丢。
 *
 *  ⚠️ 零依赖叶子：不 import 任何模块（连 node: 内置都不引），纯函数、无时钟。
 *     调用方把"最近它自己说过的几句"和"这一轮的段落"传进来。
 *
 *  ⚠️ 三条规则的秩序是**先形状后句子**：先削最刺眼的（破折号抖机灵），
 *     再削开头（同一个词起手），最后才是整体骨架。只做一次，不循环 ——
 *     循环削会把一句正常的话越削越碎，那正是"读起来像机器"的另一种表现。
 */

/** 三条规则的名字（trace / 日志里用它，别在别处再写一遍字符串）。 */
export const TEMPLATE_RULES = Object.freeze({
  zinger: 'dash-zinger',      // 破折号抖机灵，连着几条都这么收尾
  opening: 'same-opening',    // 连着几条同一个词起手
  shape: 'same-shape',        // 标点骨架 + 长度档都撞了
});

/** 只看末尾那一句里有没有破折号（`——` 与单个 `—` 都算，中文里两种都在用）。 */
const hasDash = (s) => /—/.test(String(s || ''));

/** 起手三个字（去掉开头的引号/括号/空白；不足三个字返回整句，不够长就不该判"撞车"）。 */
export function openingOf(text) {
  const s = String(text || '').trim().replace(/^["'“”‘’「」『』（(【\[\s]+/, '');
  return s.slice(0, 3);
}

/** 标点骨架：只留标点（把"短句，再短句"这种节奏形状抽出来），最多 8 个。 */
export function skeletonOf(text) {
  return String(text || '').replace(/[^\p{P}\s]/gu, '').replace(/\s+/g, '').slice(0, 8);
}

/** 长度档（每 20 字一档，封顶 4）：防止"20 字"与"200 字"被判成同一形状。 */
export function lenBucketOf(text) {
  return Math.min(4, Math.floor(String(text || '').length / 20));
}

/** 至少两句才算"连着来" —— 一句不算模板，那是它今天只说过一次。 */
const MIN_PRIOR = 2;

/**
 * 这一轮撞了哪条模板（不改文本，只给判据；测试与 trace 都用它）。
 *
 * @param {string[]} recent 最近它自己说过的几句（旧的在前）
 * @param {string[]} chunks 这一轮的段落
 * @returns {string} 规则名；没撞返回空串
 */
export function templateHitOf(recent, chunks) {
  const prior = (Array.isArray(recent) ? recent : []).map((s) => String(s || '')).filter(Boolean);
  const cur = (Array.isArray(chunks) ? chunks : []).map((s) => String(s || '')).filter(Boolean);
  if (prior.length < MIN_PRIOR || !cur.length) return '';

  const last = cur[cur.length - 1];
  if (hasDash(last) && prior.filter(hasDash).length >= MIN_PRIOR) return TEMPLATE_RULES.zinger;

  const op = openingOf(cur[0]);
  if (op.length === 3 && prior.filter((s) => openingOf(s) === op).length >= MIN_PRIOR) return TEMPLATE_RULES.opening;

  const skel = skeletonOf(cur.join(''));
  const bucket = lenBucketOf(cur.join(''));
  if (
    skel.length >= 2
    && prior.filter((s) => skeletonOf(s) === skel && lenBucketOf(s) === bucket).length >= MIN_PRIOR
  ) return TEMPLATE_RULES.shape;

  return '';
}

/** 句末切一刀（。！？…；;!?）—— 没有句末标点就返回原句。 */
function firstSentence(s) {
  const m = String(s || '').match(/^[\s\S]*?[。！？…!?]/);
  return m ? m[0].trim() : String(s || '').trim();
}

/**
 * 按命中的规则把它改平（缺口：只削形状，不改内容；削完太短就不削了）。
 *
 * @param {string[]} recent 最近它自己说过的几句（旧的在前）
 * @param {string[]} chunks 这一轮的段落
 * @returns {{chunks: string[], hit: string, changed: boolean}}
 *   永远返回**非空**的 chunks：这道闸不许把一条回复削成没话说（那是"突然不理我"）。
 */
export function deTemplate(recent, chunks) {
  const list = (Array.isArray(chunks) ? chunks : []).map((s) => String(s || '')).filter(Boolean);
  const hit = templateHitOf(recent, list);
  if (!hit || !list.length) return { chunks: list, hit, changed: false };

  const out = list.slice();
  if (hit === TEMPLATE_RULES.zinger) {
    // 砍掉最后一个破折号之后的那截（含破折号本身）。前半句不到 4 个字就说明
    // 破折号不是"尾巴"而是"整句话的结构"—— 那种情况削完就只剩半个意思，宁可不动。
    const last = out[out.length - 1];
    const idx = last.lastIndexOf('—');
    const head = idx > 0 ? last.slice(0, idx).trim().replace(/[—\s]+$/, '') : '';
    if (head.length >= 4) out[out.length - 1] = head;
    else return { chunks: list, hit, changed: false };
  } else if (hit === TEMPLATE_RULES.opening) {
    // 把"起手那个词"连到第一个逗号一起削掉（"行吧，今天……" → "今天……"）。
    const first = out[0];
    const idx = first.search(/[，,]/);
    const rest = idx > 0 ? first.slice(idx + 1).trim() : '';
    if (rest.length >= 4) out[0] = rest;
    else return { chunks: list, hit, changed: false };
  } else {
    // 骨架撞车：压成第一句（"平铺直叙半句，允许无聊"）。压出来太短就不动。
    const joined = firstSentence(out[0]);
    if (joined.length >= 4 && joined.length < out[0].length) out[0] = joined;
    else return { chunks: list, hit, changed: false };
  }

  // 兜底：理论上上面每一步都保证了非空；这里再挡一次"削成空"的路径。
  if (!out.length || out.every((s) => !s)) return { chunks: list, hit, changed: false };
  return { chunks: out, hit, changed: true };
}
