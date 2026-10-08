/**
 * 闸门规则表的**唯一遍历实现**，以及"闸门自己出错"的统一表达（B12c · GUARD-LITE）。
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  这个模块存在的理由：两处闸门各写了一遍"遍历规则表 + 守卫异常"
 * ──────────────────────────────────────────────────────────────────────────
 * `src/egress.js`（出口闸门）与 `src/injection.js`（注入闸门）是一对同型的东西：
 * 都是"一张模块级常量表 + 一个遍历它的纯函数"。B12c 开工前实测发现，
 * 两边的遍历**都没有守卫**：规则自身的正则一旦抛错（改正则时最容易发生），
 * 异常会直接穿透到调用链顶端 —— 表现是**整轮消息被静默吞掉，且没有任何日志指向闸门**。
 * 这是本项目反复在防的那类失败形态（"拦了不留痕 = 静默失效"）。
 *
 * 修法有两条路，本项目只走第二条：
 *   · 在 egress 与 injection 里**各加一个 try/catch** —— 两个文件各写一遍同样的守卫；
 *   · **把遍历抽成一份**，两处 import（本文的做法）。
 * 第二条多出来的收益不是"少写几行"，而是**"闸门出错"从此有了唯一的表达**（见下）。
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  ⚠️ 失败策略**不在这个模块里**，它由调用方声明，而且两边**故意不同**
 * ──────────────────────────────────────────────────────────────────────────
 * 用户裁决（第 42 轮 B12c）：**按职责区分**，不是规格里那句"失败一律放行"。
 *
 * | 闸门 | 它保护什么 | 规则出错时 | 理由 |
 * |---|---|---|---|
 * | 出口闸门 `scanEgress` | 凭据/本机路径**不外泄到群里** | **拦下**（fail-closed） | 宁可这一轮不说话，也不能把 `sk-…` 发出去 |
 * | 注入闸门 `looksInjected` | 脏记忆**不落盘** | **放行**（fail-open） | 闸门自己写着"不是万无一失的防线"；它坏了不该让记忆静默停摆 |
 *
 * 所以本模块只做一件中立的事：**把异常折成一个哨兵值**（`GATE_ERROR_KIND`），
 * 让调用方**看得见"闸门坏了"**，再由调用方决定拦还是放。两种策略因此各只有一处：
 *   · fail-closed 的落点 = `!!kind`（`src/brain.js` 判 `blocked` 非空，**本批未改**）
 *   · fail-open 的落点 = `isBlocking(kind)`（`src/memory.js` · `panel/server.js`）
 * `check-wb.mjs` 第 12 节把这三处都钉成契约 —— 少改任何一处，
 * 表现都是"哨兵被当成命中"，也就是**安静地变成了另一种策略**。
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  为什么哨兵是个字符串，而不是"返回 null + 另开一个查询接口"
 * ──────────────────────────────────────────────────────────────────────────
 * fail-open 的出口空间只有 `null`（= 放行）。如果出错也返回 `null`，
 * 调用方就**分不出"没命中"和"规则坏了"** —— 告警永远发不出来，
 * 于是"闸门坏了"重新变回静默。哨兵值是这个区分的**最小代价形式**：
 * 它沿着已有的返回值走出去，不需要引入隐藏状态（模块级"最近一次错误"那种写法
 * 在多会话并发下本来也是错的）。
 *
 * ⚠️ **本模块零依赖**（不 import 任何东西，含 `node:` 内置）：`egress.js` 被
 *    `logger.js` import，`injection.js` 被 `panel/server.js` import ——
 *    它俩同时被机器人进程与面板进程加载，自身拉进任何模块都会扩大依赖图。
 *    `check-wb.mjs` 有契约盯这一条。
 */

/**
 * "闸门规则自身抛异常"的哨兵值。
 *
 * 它不是一条规则名，**不许**被当成普通命中来做文案 —— 调用方判到它时
 * 要说的不是"你命中了 XX"，而是"闸门坏了，我这次按 X 处理"。
 */
export const GATE_ERROR_KIND = '闸门规则异常';

/**
 * 遍历一张 `{ kind, re }` 规则表，**逐条守卫**。
 *
 * 与旧实现的差别只有一处：规则自身的 `re.test()` 抛错时不再往外抛，
 * 而是把错误原样交回给调用方（`error` 非空）。
 * 命中顺序、`kind` 取值、无命中返回 `null` —— 全部与旧实现逐字一致。
 *
 * ⚠️ 出错即**停止遍历**（不继续试后面的规则）：一条规则抛错说明这张表
 *    大概率被改坏了，此时"跳过它继续用剩下的"会给出一个**看起来正常、
 *    实际上少了一道**的结论 —— 比整体报错更难查。
 *
 * @param {Array<{ kind: string, re: RegExp }>} rules 规则表（顺序即优先级）
 * @param {unknown} text 待检文本
 * @returns {{ kind: string|null, error: Error|null }}
 *   `kind`：命中的类别名；未命中为 `null`。
 *   `error`：规则自身抛出的错误；正常为 `null`。
 *   ⚠️ 两者**不会同时非空**。
 */
export function scanRules(rules, text) {
  // ⚠️ 连 `String(...)` 这一步也守在里面：调用方递进来的若是个
  //    `toString()` 会抛的对象，异常同样会穿透到回复链路 ——
  //    而这条守卫的意义正是让"本函数**永远不抛**"成为一句**可断言**的话。
  let s;
  try {
    s = String(text ?? '');
  } catch (e) {
    return { kind: null, error: toError(e) };
  }
  if (!s) return { kind: null, error: null };
  for (const r of rules) {
    try {
      // 规则一律**不带 g**：带 g 的正则 `.test()` 会留下 `lastIndex`，
      // 同一个正则连调两次会给出不同答案（`src/egress.js` 的 `compiled()` 有同一条教训）。
      if (r.re.test(s)) return { kind: r.kind, error: null };
    } catch (e) {
      return { kind: null, error: toError(e) };
    }
  }
  return { kind: null, error: null };
}

/** 非 Error 的抛出值也要能安全地包成 Error（否则"包装"自己会再抛一次）。 */
function toError(e) {
  if (e instanceof Error) return e;
  try {
    return new Error(String(e));
  } catch {
    return new Error('规则抛出了无法转成字符串的值');
  }
}

/**
 * 把 `scanRules` 的结果折成"给调用方看的名字"：出错 → 哨兵，否则原样。
 *
 * 这道折装**刻意只有一份**：两个闸门在这一点上的行为完全相同
 * （都要让调用方看见"坏了"），差异只在调用方拿到哨兵之后怎么做。
 *
 * @param {{ kind: string|null, error: Error|null }} scanned
 * @returns {string|null}
 */
export function kindOf(scanned) {
  if (!scanned || scanned.error) return GATE_ERROR_KIND;
  return scanned.kind ?? null;
}

/**
 * fail-open 判据：**这个 `kind` 该不该拦**。
 *
 * `GATE_ERROR_KIND` 返回 `false`（闸门坏了 → 放行），其余非空串返回 `true`。
 *
 * ⚠️ 这个函数**只给 fail-open 的调用方用**。fail-closed 那侧（`src/brain.js`）
 *    判的是 `!!blocked`，哨兵天然被当成命中 —— 那是**正确的**，不要为了"统一"
 *    把它也改成 `isBlocking`，那会把出口闸门悄悄变成 fail-open。
 */
export function isBlocking(kind) {
  return !!kind && kind !== GATE_ERROR_KIND;
}
