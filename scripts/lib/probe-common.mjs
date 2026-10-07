/**
 * 两个智谱模型探测脚本（`probe-models.mjs` / `probe-functions.mjs`）**共用的候选清单**。
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么单独一个文件（第 13 轮 H-11 收敛）
 * ══════════════════════════════════════════════════════════════════════════
 *  这两个脚本各自抄了一份**逐字相同**的 19 个模型串清单。后果与所有"同一语义两份实现"
 *  一样、且是静默的：**加 / 删一个模型要改两处，漏一处的表现是"两个探测器测的模型集合
 *  悄悄不一样"，而报告里看不出来**（比方说 function calling 那张表少了一个模型的实测）。
 *  清单收在这里一份；两个脚本各取所需（`probe-models` 多测一个 `glm-ocr`）。
 *
 *  ⚠️ 清单与 `src/model-caps.js` 的 `ZHIPU_MODEL_META` 对齐 —— 改那张表时这里要跟。
 *     「对齐」不靠自觉：`check-wb` 有一条判据盯着"清单只有这一处"。
 */

/** 智谱**对话**模型候选（`glm-ocr` 不是对话模型，不在其中）。 */
export const ZHIPU_CHAT_CANDIDATES = [
  'glm-4.5-air', 'glm-4.6v', 'glm-4.7',
  'glm-4-flash', 'glm-4-flash-250414', 'glm-4.5', 'glm-5', 'glm-5.2',
  'glm-5v-turbo', 'glm-4.6', 'glm-4.5-flash', 'glm-5.1', 'glm-5-turbo',
  'glm-4.7-flash', 'glm-4.6v-flash',
  'glm-5.3', 'glm-5.3-flash', 'glm-4.6v-flashx', 'glm-4.5v',
];

/** 只给 `probe-models.mjs` 补测的**非对话**模型：`glm-ocr` 是 OCR，不测 function calling。 */
export const ZHIPU_NON_CHAT_CANDIDATES = ['glm-ocr'];

/** DeepSeek 现役两款（停用的两款也测一下，历史配置里还留着）。 */
export const DEEPSEEK_CANDIDATES = ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'];
