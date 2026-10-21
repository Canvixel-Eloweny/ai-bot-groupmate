/**
 * 与业务无关的并发闸门（零依赖叶子）。
 *
 * 它住在 src/ 而不是内联在 `index.js`：`index.js` 是入口，import 它会真的启动机器人，
 * 于是"同步抛错后槽位有没有归还"这类判据**根本无法被喂反例**。抽出来之后，
 * 判据与实现只有一份，测试可以直接调它。
 */

/**
 * 并发闸门。`limit` 个槽位，超出的排队；**同步抛错也必须归还槽位**。
 *
 * 旧实现的 `run().then(...).finally(...)` 在 `run()` 同步抛错时根本没挂上 ——
 * 槽位永久泄漏，累计 `limit` 次后整条闸门死锁，而且没有任何日志。
 */
export function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active += 1;
    const { run, resolve, reject } = queue.shift();
    let p;
    try {
      p = run();
    } catch (e) {
      active -= 1;
      next();
      reject(e);
      return;
    }
    Promise.resolve(p).then(resolve, reject).finally(() => {
      active -= 1;
      next();
    });
  };
  return (run) =>
    new Promise((resolve, reject) => {
      queue.push({ run, resolve, reject });
      next();
    });
}
