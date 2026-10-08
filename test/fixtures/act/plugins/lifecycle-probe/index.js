// 生命周期四态样本（第 46 轮 B12e-2 · EX-LIFECYCLE 的断言对象）。
//
// 本文件**故意**会被真的 import（与 test/fixtures/ext 下那两个不同 —— 那两个
// 只给"入口存在性校验"一个真实对象）。所以它要把四个生命周期函数都跑一遍，
// 并把"看到了什么"留在模块级数组里，让断言去读。
//
// ⚠️ 模块级状态在**一个进程里只有一份**（ESM 模块缓存）—— 这本身就是
//    "不支持热插拔"的一个具体后果。测试里**只加载一次**，别指望它是干净的。

/** 四态调用顺序。断言要读它 —— 顺序错了说明生命周期接错。 */
export const seen = [];
/** setup 看到的 ctx 是什么样（EX-CAPCTX 的落点） */
export const ctxSeen = { keys: [], hasDataDir: false, fetchRejects: false, registerToolThrows: false };
/** 钩子看到的载荷（用来断言 send_message 的合成形状） */
export const hookSeen = { calls: 0, last: null, lastArgs: null };

export function setup(api) {
  seen.push('setup');
  ctxSeen.keys = Object.keys(api).sort();
  // 「未声明能力时 ctx 字段为 undefined」—— 参考实现里也没有 dataDir，
  // 所以它在真实生态里就是 undefined，扩展包应当 `if (api.dataDir)` 兜底。
  ctxSeen.hasDataDir = 'dataDir' in api;
  // plugin 型不许注册工具（那属于 skills/）—— 宿主给的是"一调就抛"的函数
  try {
    api.registerTool({ id: 'nope', handler: () => 1 });
  } catch {
    ctxSeen.registerToolThrows = true;
  }
  // 没声明 web_fetch → api.fetch 必须是**可调用但会 reject**的函数，
  // 而不是 undefined（参考实现就是这个形状）。
  try {
    const p = api.fetch('http://127.0.0.1:1/');
    if (p && typeof p.then === 'function') {
      p.then(() => { ctxSeen.fetchRejects = false; }, () => { ctxSeen.fetchRejects = true; });
    }
  } catch {
    ctxSeen.fetchRejects = true;
  }
  // config() 必须拿得到清单里的默认值（settings 合并的落点）
  ctxSeen.windowMin = typeof api.config === 'function' ? api.config()?.windowMin : null;
}

export function activate() {
  seen.push('activate');
}

export function deactivate() {
  seen.push('deactivate');
}

export function dispose() {
  seen.push('dispose');
}

export const hooks = {
  'before-tool': (payload) => {
    hookSeen.calls += 1;
    hookSeen.last = payload;
    hookSeen.lastArgs = payload?.argsRaw;
    // 只对"发消息"这个动作说话：收到带 `复读` 二字的内容就否决它。
    // 用它与真实包（`复读拦截`）同名的动作名匹配方式（/send_message/i）保持一致。
    if (!/send_message/i.test(String(payload?.toolName || ''))) return undefined;
    let args = payload?.argsRaw;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = null;
      }
    }
    const msgs = (args?.messages || []).map(String);
    if (msgs.some((m) => m.includes('复读'))) {
      return { block: true, reason: '样本包：不许复读' };
    }
    return undefined;
  },
};
