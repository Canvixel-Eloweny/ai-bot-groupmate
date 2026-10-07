/**
 * ══════════════════════════════════════════════════════════════════════
 *  扩展包的 `api.fetch` —— 受出站策略约束的那一份（第 55 轮）
 * ══════════════════════════════════════════════════════════════════════
 *  为什么单独一个文件：**`plugin-api.js` 是零依赖叶子**（不 import 任何东西），
 *  而这里要 import `safe-fetch`。判据与 IO 分开，叶子才能继续被 smoke 直接喂反例
 *  （本项目的一贯做法：判据零依赖、宿主负责接线）。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  它填的是哪个洞
 *  ────────────────────────────────────────────────────────────────────
 *  在此之前 `api.fetch = globalThis.fetch` —— 声明了 `web_fetch` 的包拿到的是
 *  **裸 fetch**：没有私网地址拦截、没有重定向重校验、没有超时与限量。
 *  那正是 B13（`NET-SSRF`）建 `src/safe-fetch.js` 时要防的东西，
 *  只是当时它 **0 个生产调用方**（所以立了一条契约把"0"钉成事实）。
 *  → 计划附 S.5 早就写明这三个包（AI额度情报 / B站视频解析 / 百科查询）
 *    "需先接到 safe-fetch —— 接上那条契约就会红，**那条契约就该红**"。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 形状必须**还是 fetch**（这是本模块唯一真正难的地方）
 *  ────────────────────────────────────────────────────────────────────
 *  `safeFetch` 返回的是 `{ok, status, body, ...}` —— **不是** `Response`。
 *  而 13 个真实包里用 fetch 的那些写的都是 `await res.text()` / `res.json()`。
 *  直接把 safeFetch 塞给 `api.fetch`，包会拿到一个没有 `.json()` 的对象：
 *  不报错、不抛异常，只是**永远取不到正文**。
 *  → 所以这里包一层，把结果还原成真的 `Response`（语义与裸 fetch 一致），
 *    而**判据仍然只有 safeFetch 那一份**（本模块不复制任何一条地址规则）。
 *
 *  ⚠️ 只支持 GET：`safeFetch` 本来就只做 GET。非 GET **抛错**而不是静默降级成 GET ——
 *     静默改方法会让包"看起来发了、其实发的是另一个请求"，比直接失败更糟。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  D15（报告 E11 ① ②）：这里现在有**两道**闸，按顺序过
 *  ────────────────────────────────────────────────────────────────────
 *  ① `browseDecision`（`src/browse-lock.js`）—— **范围**：名单外的站点一律拒。
 *     只在配置里开启时生效；关闭态直接放行，理由如实写成 `lock-off`。
 *  ② `safeFetch`（`src/safe-fetch.js`）—— **地址形态**：私网 / 回环 / 云元数据 / 重定向重校验。
 *  两道都要过。谁也不能替代谁：名单里的站点也可能解析到私网（DNS rebinding），
 *  而合法的公网站点未必在我们的名单里。
 */

import { safeFetch } from './safe-fetch.js';
import { browseDecision, BROWSE_LOCK_DEFAULTS } from './browse-lock.js';

/**
 * 造一个给扩展包用的 `fetch`。
 *
 * @param {{log?:Function, lock?:{enabled:boolean,hosts:string[]}}} [deps]
 *   `log` 用来在被拦下时留一句话（否则"某个包偷偷访问内网"
 *   在日志里一个字都没有 —— 与 `ext-scope.js` 拒绝发言时既要抛错也要告警同一条纪律）。
 *   `lock` 是**浏览锁定**（D15 · 报告 E11 ②）：只允许去名单内的站点。
 *   ⚠️ 与 `safe-fetch` 是**互补的两道闸**，不是替代关系 —— 见 `browse-lock.js` 文件头。
 * @returns {(url:string, opts?:object) => Promise<Response>}
 */
export function createExtFetch({ log, lock = BROWSE_LOCK_DEFAULTS } = {}) {
  return async function extFetch(url, opts = {}) {
    const init = opts && typeof opts === 'object' ? opts : {};
    const method = String(init.method || 'GET').toUpperCase();
    if (method !== 'GET') {
      throw new Error(`扩展包的 fetch 只支持 GET（收到 ${method}）—— 需要别的方法请改走别的路子`);
    }
    // ── 第一道：**范围**（browseLock，D15）。放在地址形态判据之前，理由有两条 ──
    // ① 越界与"地址非法"是两类不同的拒绝，先判范围，日志里的原因才准确；
    // ② 名单是**可信配置**推导出来的，而地址是**外来输入** —— 先拿可信的那半筛一遍，
    //    进了名单的地址才轮到"形态"判据去深究（顺序上也是把可能不可信的放在后面）。
    const gate = browseDecision(url, lock);
    if (!gate.allow) {
      const why = `${gate.reason}${gate.detail ? `：${gate.detail}` : ''}`;
      if (typeof log === 'function') log(`扩展包 fetch 被浏览锁定拦下（${why}）`);
      throw new Error(`fetch 被出站策略拦下（${why}）`);
    }
    const r = await safeFetch(url);
    if (!r.ok) {
      const why = `${r.reason}${r.detail ? `：${r.detail}` : ''}`;
      if (typeof log === 'function') log(`扩展包 fetch 被拦下（${why}）`);
      // 抛错而不是返回 500：包自己的 try/catch 接得住，且错误信息直指"被策略拦了"，
      // 不会伪装成"对方服务器挂了"。
      throw new Error(`fetch 被出站策略拦下（${why}）`);
    }
    const headers = new Headers();
    if (r.headers && typeof r.headers === 'object') {
      for (const [k, v] of Object.entries(r.headers)) {
        if (String(k).toLowerCase() === 'set-cookie') continue; // 不把 Cookie 递给外来代码
        try { headers.set(String(k), String(v)); } catch { /* 非法头名跳过 */ }
      }
    }
    return new Response(r.body ?? '', { status: Number(r.status) || 200, headers });
  };
}
