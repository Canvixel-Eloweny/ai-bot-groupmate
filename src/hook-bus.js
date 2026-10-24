/**
 * ══════════════════════════════════════════════════════════════════════
 *  钩子总线 —— 插件型扩展包的**唯一承载**
 *  第 46 轮 B12e-2 · EX-LIFECYCLE（执行层第二步）
 * ══════════════════════════════════════════════════════════════════════
 *  解决的问题：5 个 plugin 型扩展包（`plugins/` 下）不注册工具，它们
 *  **靠钩子介入**。其中 `复读拦截` 声明的是 `before-tool`：
 *  在"即将发送"这个动作上否决一次调用。
 *
 *  生态通行的对应形状：
 *    · `skillManager.runHook(name, payload)` → 返回一组 `{value}`；
 *    · 调用方 `find(v => v && v.block)` 取**第一个否决**，
 *      并把 `错误：<reason>` 当成工具结果回灌给模型；
 *    · 钩子里抛错 → `recordError` 记下，**不影响主流程**。
 *  本模块照抄这三条语义（拿真实样本核过，不是照规格猜的）。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 钩子出错必须 **fail-open**（放行），这与出口闸门**故意相反**
 *  ────────────────────────────────────────────────────────────────────
 *  本项目第 43 轮定过一条：闸门失败语义按职责分，两侧故意相反 ——
 *    · 出口 `scanEgress()`  保护**凭据不外泄** → 出错时 **fail-closed**（拦下）
 *    · 注入 `looksInjected()` 保护**脏记忆不落盘** → 出错时 fail-open + 告警
 *  钩子属于**第三类，且明确站在 fail-open 一侧**：
 *  它保护的是"别有重复消息"这种**体验**，不是凭据那类**安全**。
 *  一个写坏的扩展包让机器人彻底不说话了 —— 那比它复读一句严重得多。
 *  → 所以 `emit()` 把每个钩子的异常**吞掉并记账**，绝不让它变成否决。
 *
 *  ⚠️ 否决**不打断后续钩子**：全部跑完再取第一个否决。
 *  与参考实现一致（`Promise.all` 之后 find）。理由：若"先否决就停"，
 *  排在后面的钩子会因为前面的否决而**没跑** —— 那是一个隐藏状态，
 *  排查时"为什么它没记录"会变得无法解释。
 *
 *  ⚠️ **零依赖叶子**：不 import 任何东西。它被机器人进程与测试同时加载。
 *
 *  ⚠️ 单条钩子有超时（2026-10-23）：默认 `HOOK_TIMEOUT_MS` = 5000 ms，可在
 *  `custom.plugins.hookTimeoutMs` 里改（钳制 100–120000）。超时按 fail-open
 *  放行并记一条 `errors`，**继续跑后面的钩子**，不置否决。
 *
 *  ⚠️ 超时**不能取消**已经在跑的 Promise：它仍可能在之后修改共享 payload
 *  （尤其 `before-llm-messages` 的 `messages` 数组）。深拷贝会破坏包的有意
 *  原地修改，所以这里选择接受这个残余风险，并在超时日志里点名 owner。
 *  另外 N 条钩子是**串行**的，最坏累计 N × timeout；本层不设总预算。
 */

/**
 * 支持的钩子点。名单与生态通行的那套钩子点
 * 触发的 5 个点**逐一对应**（第 47 轮 B12e-3 拿真实样本核过，不是照规格猜）：
 *   before-context        orchestrator.js:763   组消息之后、建上下文之前（本体情绪靠它读入站情绪）
 *   before-llm-messages   orchestrator.js:857   消息已建好、发给模型之前（可改 messages）
 *   before-tool           orchestrator.js:1121  工具调用前（可否决；本项目发送闸也走这里）
 *   after-tool            orchestrator.js:1132  工具调用后
 *   after-response        orchestrator.js:997   本轮回复结束之后（本体情绪靠它更新状态）
 *
 * **不在这个表里的钩子名会被拒绝并告警**（不静默忽略）——
 * 静默忽略的表现是"扩展包的钩子写错了名字，它永远是死的，而日志里什么都没有"。
 */
export const HOOK_POINTS = Object.freeze([
  'before-context',
  'before-llm-messages',
  'before-tool',
  'after-tool',
  'after-response',
  // 2026-10-23：宿主扩展点（**不是**参考实现的 5 点之一）。
  // 入站消息被放行之后、决策之前触发 —— "没被回复的消息"也要能被插件看到，
  // 否则好感度 / 心情这类"按所有消息记账"的包永远只有被点名的那几条。
  // 只通知、不否决：返回值里的 `block` 不在这里消费（否决语义仍只在 before-tool）。
  'after-incoming-message',
]);

/** 单条钩子的默认超时（毫秒）与硬天花板。默认值同时登记在 `field-schema.js`。 */
export const HOOK_TIMEOUT_MS = 5000;
export const HOOK_TIMEOUT_LIMIT = 120000;

/** 否决的判据键。参考实现用的是 `block`，保持一致（扩展包不用改一行） */
const VETO_KEY = 'block';

/**
 * 建一条钩子总线。
 *
 * @param {{log?:{info?:Function,warn?:Function}}} deps
 */
export function createHookBus({ log, timeoutMs = HOOK_TIMEOUT_MS } = {}) {
  const warn = (m) => log?.warn?.(m);
  const cap = Math.max(100, Math.min(HOOK_TIMEOUT_LIMIT, Math.trunc(Number(timeoutMs)) || HOOK_TIMEOUT_MS));
  /** @type {Map<string, Array<{owner:string, fn:Function}>>} */
  const points = new Map();
  for (const p of HOOK_POINTS) points.set(p, []);

  return {
    /** 生效的单条超时（面板 / 快照只读它，不自己再算一遍） */
    timeoutMs: cap,
    /**
     * 注册一个钩子。
     * @returns {boolean} 是否受理（未知钩子点 / 非函数 → false，并告警）
     */
    on(point, fn, { owner = '' } = {}) {
      const key = String(point ?? '');
      if (!points.has(key)) {
        warn(`扩展包「${owner}」注册了未知钩子点「${key}」，已忽略（支持：${HOOK_POINTS.join(' / ')}）`);
        return false;
      }
      if (typeof fn !== 'function') {
        warn(`扩展包「${owner}」的钩子「${key}」不是函数，已忽略`);
        return false;
      }
      points.get(key).push({ owner: String(owner ?? ''), fn });
      return true;
    },

    /** 注销某个扩展包的全部钩子（deactivate / dispose 时用） */
    offOwner(owner) {
      const o = String(owner ?? '');
      let n = 0;
      for (const [k, list] of points) {
        const keep = list.filter((h) => h.owner !== o);
        n += list.length - keep.length;
        points.set(k, keep);
      }
      return n;
    },

    /** 某个钩子点上有几个钩子（调用方用它做"有没有钩子"的快速判断） */
    size(point) {
      return (points.get(String(point ?? '')) || []).length;
    },

    /** 全部钩子数（自证用：面板/日志要能说"一共挂了几条"） */
    total() {
      let n = 0;
      for (const list of points.values()) n += list.length;
      return n;
    },

    /** 已挂钩子的扩展包 id（排序后返回，便于断言与展示） */
    owners() {
      const s = new Set();
      for (const list of points.values()) for (const h of list) if (h.owner) s.add(h.owner);
      return [...s].sort();
    },

    /**
     * 触发一个钩子点。
     *
     * @returns {Promise<{vetoed:null|{reason:string,owner:string}, ran:number,
     *                    errors:Array<{owner:string,message:string}>}>}
     *   `ran` 是**真正执行过**的钩子数（不是注册数）—— 输入基数必须可打印。
     */
    async emit(point, payload = {}) {
      const key = String(point ?? '');
      const list = points.get(key);
      const errors = [];
      if (!list || !list.length) return { vetoed: null, ran: 0, errors };

      let ran = 0;
      let vetoed = null;
      // 哨兵值：超时用 resolve 而不是 reject —— 后者会在迟到的 Promise 上留下
      // 未处理拒绝的风险，而这里只想"先往下走"。
      const TIMED_OUT = Symbol('hook-timeout');
      for (const h of list) {
        ran += 1;
        let timer = null;
        // 包一层 Promise.resolve()：同步 throw 也变成 reject，走同一个 catch。
        const run = Promise.resolve().then(() => h.fn(payload));
        // 超时后原 Promise 仍可能在跑；挂一个空 catch，避免它迟到的 reject
        // 变成 unhandled rejection（race 已经settled，不会再消费它）。
        run.catch(() => {});
        const timeout = new Promise((resolve) => {
          // ⚠️ 不要 unref：短生命周期进程（测试 / 一次性脚本）里，唯一的定时器被
          // unref 后事件循环会直接空转退出，超时永远不触发 —— 表现为"emit 挂住"。
          // 代价是进程最多多活 cap 毫秒（默认 5 秒），换来确定性的放行。
          timer = setTimeout(() => resolve(TIMED_OUT), cap);
        });
        try {
          // eslint-disable-next-line no-await-in-loop -- 顺序执行是刻意的：注册顺序 = 判定顺序
          const v = await Promise.race([run, timeout]);
          if (v === TIMED_OUT) {
            const message = `钩子超时（>${cap}ms），已放行`;
            errors.push({ owner: h.owner, message });
            warn(`扩展包「${h.owner}」的钩子「${key}」${message}`);
            continue;
          }
          if (!vetoed && v && typeof v === 'object' && v[VETO_KEY] === true) {
            vetoed = {
              // reason 可能是任意类型（扩展包自己写的）—— 统一成字符串，
              // 否则它会被原样塞进日志/trace，变成一个「[object Object]」。
              reason: String(v.reason ?? '').trim() || '该动作被扩展包拒绝（未给原因）',
              owner: h.owner,
            };
          }
        } catch (e) {
          // ★ fail-open：记下来，继续跑下一个，**绝不**变成否决。
          const message = String(e?.message ?? e);
          errors.push({ owner: h.owner, message });
          warn(`扩展包「${h.owner}」的钩子「${key}」出错（已放行）：${message}`);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      return { vetoed, ran, errors };
    },
  };
}
