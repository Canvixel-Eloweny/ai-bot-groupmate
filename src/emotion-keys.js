/**
 * 「本体情绪」那 21 个键的**唯一一份**中文名与分组（2026-10-25）。
 *
 * 为什么单独开一个叶子：面板要画 21 根柱子、提示词侧要读状态、
 * 而键名与中文名若各写一份，插件改名时就会一边显示新名、一边显示旧名。
 * 这里只放静态表，不含任何 IO。
 */

export const EMO_GROUPS = [
  { label: '正向', key: 'positive', items: [['joy', '喜悦'], ['cheer', '振奋'], ['pride', '自豪'], ['smug', '得意'], ['hype', '兴奋'], ['gratitude', '感激'], ['hope', '期待'], ['curiosity', '好奇']] },
  { label: '中性', key: 'neutral', items: [['surprise', '惊讶'], ['boredom', '无聊']] },
  { label: '负向', key: 'negative', items: [['anger', '生气'], ['irk', '烦躁'], ['disgust', '厌恶'], ['anxiety', '焦虑'], ['sadness', '难过'], ['fear', '害怕'], ['shame', '羞愧'], ['guilt', '内疚'], ['envy', '羡慕'], ['loneliness', '孤独'], ['down', '低落']] },
];

/** 21 个键的呈现顺序（正向 8 → 中性 2 → 负向 11），面板与投影共用。 */
export const EMOTION_KEYS = EMO_GROUPS.flatMap((g) => g.items.map(([k]) => k));
