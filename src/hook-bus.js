/**
 * ══════════════════════════════════════════════════════════════════════
 *  钩子总线 —— 插件型扩展包的**唯一承载**
 *  第 46 轮 B12e-2 · EX-LIFECYCLE（执行层第二步）
 * ══════════════════════════════════════════════════════════════════════
 *  解决的问题：5 个 plugin 型扩展包（`plugins/` 下）不注册工具，它们
 *  **靠钩子介入**。其中 `复读拦截` 声明的是 `before-tool`：
 *  在"即将发送"这个动作上否决一次调用。
 *
 *  参考实现（QQ-Agent v0.31 · MIT）的对应形状：
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
 *  ⚠️ 已知盲区（写明，不假装没有）：**没有超时**。
 *  钩子里写一个 `await new Promise(() => {})` 会让这一轮回复永远挂住。
 *  本批不设超时，理由是"扩展包是用户自己装的、且加载前要过白名单"；
 *  真要闭合得靠进程级看门狗，与收益不成比例。
 */

/**
 * 支持的钩子点。名单与参考实现（QQ-Agent 0.4 preview · src/orchestrator.js）
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
]);

/** 否决的判据键。参考实现用的是 `block`，保持一致（扩展包不用改一行） */
const VETO_KEY = 'block';

/**
 * 建一条钩子总线。
 *
 * @param {{log?:{info?:Function,warn?:Function}}} deps
 */
export function createHookBus({ log } = {}) {
  const warn = (m) => log?.warn?.(m);
  /** @type {Map<string, Array<{owner:string, fn:Function}>>} */
  const points = new Map();
  for (const p of HOOK_POINTS) points.set(p, []);

  return {
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
      for (const h of list) {
        ran += 1;
        try {
          // eslint-disable-next-line no-await-in-loop -- 顺序执行是刻意的：注册顺序 = 判定顺序
          const v = await h.fn(payload);
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
        }
      }
      return { vetoed, ran, errors };
    },
  };
}
