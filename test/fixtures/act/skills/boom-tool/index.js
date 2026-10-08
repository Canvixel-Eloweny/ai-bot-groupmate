// 「注册完工具才抛错」的样本 —— 幽灵工具的反例（第 46 轮 B12e-2）。
export const seen = { registered: '' };

export function setup(api) {
  seen.registered = api.registerTool({
    id: 'ghost',
    description: '一个注定不该留下来的工具',
    parameters: { type: 'object', properties: {} },
    handler: () => 'x',
  });
  throw new Error('注册完了才失败');
}
