/**
 * 「试一句」的单飞闸（2026-11-05 · 外部评估 P2）。
 *
 * `/api/try` 会真起一个子进程、真调一次模型。它原来被归在只读路由里，
 * 于是没有 token、没有 Origin 闸、也没有并发上限 —— 连点两次就是两次计费。
 * 归属改到写路由之后，这层只负责一件事：**同一时刻最多一次在途**。
 *
 * 纯函数工厂（不读 env、不碰进程），这样 429 的判据能直接单测，
 * 不必靠"真起一个慢模型"去撞。
 */
export function createTryGate() {
  let busy = false;
  return {
    acquire() {
      if (busy) return false;
      busy = true;
      return true;
    },
    release() {
      busy = false;
    },
    get busy() {
      return busy;
    },
  };
}
