// skill 型样本：注册一个工具（第 46 轮 B12e-2 建；第 47 轮 B12e-3 对齐生态约定）。
// ⚠️ 模块级状态在进程里只有一份（ESM 缓存）—— 测试里只加载一次。
//
// ⚠️ 生态约定是 execute(ctx, args)（参考实现 src/tool-registry.js:14）：
//    ctx 是宿主注入的会话上下文（chatKey / onebot / sender / …），args 是模型实参。
//    单参数 handler 写法已废弃（两种形状并存 = 同一份判据两处定义）。
export const seen = { registered: '', fetchIsReal: false, ctxKeys: [] };

export function setup(api) {
  // 声明了 web_fetch → api.fetch 应当就是**真的** fetch（不是会 reject 的傀儡）
  seen.fetchIsReal = api.has('web_fetch') && api.fetch === globalThis.fetch;
  seen.registered = api.registerTool({
    id: 'ping',
    description: '回一个 pong',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    execute: (ctx, a) => {
      // 把拿到的 ctx 键记下来 —— 接线对拍（消费方拿到的确实是宿主那份 ctx）
      seen.ctxKeys = ctx && typeof ctx === 'object' ? Object.keys(ctx).sort() : [];
      return `pong:${String(a?.q ?? '')}`;
    },
  });
}
