// setup 抛错的样本（第 46 轮 B12e-2）。
// ⚠️ 它还会先注册一个工具 —— 用来验证「setup 失败后已注册的工具被收回」（不留幽灵工具）。
export const seen = [];

export function setup(api) {
  seen.push('setup-throw');
  if (typeof api?.log === 'function') api.log('马上要抛了');
  throw new Error('故意失败：这是一个测试样本');
}
