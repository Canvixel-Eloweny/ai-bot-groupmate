/**
 * 面板写路由的鉴权判定（第 35 轮 B9c · AUTH-PANEL）
 * ══════════════════════════════════════════════════════════════════════════
 *  这一层挡的是什么，以及**它挡不住什么** —— 先说清楚，免得被当成安全边界
 * ══════════════════════════════════════════════════════════════════════════
 *  面板只绑 `127.0.0.1`，网络上是关着的。真正的缺口在**同机的其它程序**：
 *  任何一个脚本都能 `POST /api/config` 改配置、`POST /api/bridge/stop` 把机器人停掉。
 *  B9 的审计第一次把这件事变成可见的（`actor=loopback · ua=curl/8.7.1`）。
 *
 *  ⚠️ **本模块不是安全边界**。回环服务无法区分"用户的浏览器"和"另一个本机程序"
 *  —— 任何本机进程都能 `GET /` 从页面里读走 token。这是物理限制，不是实现缺陷。
 *  它真正挡住的是**没有去读 token 的那一类写请求**：
 *    · 陈旧的脚本 / cron / 别的应用顺手探到端口就写；
 *    · 误粘贴的一条 curl。
 *  它改变的另一件事更朴素：**"能改配置"从"默认就能"变成"需要一次显式取用"**，
 *  而那一步会留下审计行（B9 的 AU-AUDIT 与本模块同源 —— 同一张 WRITE_ROUTES 表）。
 *
 *  三条设计（都能被断言，理由见下）：
 *   ① **判定是纯函数** —— 不做任何 IO、不读 `process.env`。
 *      读文件 / 生成 / 写盘只在 `panel/server.js` 里发生一次。
 *      于是"真机观察"能变成 `test/smoke.js` 里的断言，而不是一句口头保证。
 *   ② **比较必须定长**（`timingSafeEqual`），不是 `===`。
 *   ③ **缺 expected 一律拒绝**（fail-closed）：服务端永远有 token
 *      （env → 文件 → 当场生成），所以"没有 expected"只可能是接线错了；
 *      那种时候放行才是真正危险的行为。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 自定义头名。`Authorization: Bearer` 是主路（浏览器与 curl 都会写），
 * 这个是给"不方便设 Authorization"的调用方留的第二条路。
 */
export const TOKEN_HEADER = 'x-panel-token';

/**
 * 环境变量名。设了它就一定用它，且**不读文件、不生成** ——
 * 沙箱与将来的 CI 靠这个拿到一个固定 token。
 *
 * @sync-with panel-token-env
 *   另两处按**这个名字**读写它：`test/sandbox.sh`（设）与 `test/verify-presets.mjs`（读）。
 *   改名只改一处 → 沙箱静默地"没设 token"，而它不会报错，只会让一批断言在无鉴权状态下运行。
 *   由 `scripts/check-wb.mjs` 第 9 节契约保证这三处的名字一致。
 *   ⚠️ S-12 第六批（2026-10-05）：原来并列的第三处 `test/verify-panel.mjs`（验已下线旧页的
 *      那一份）已随旧页整块删除，登记随之收窄 —— 锚点的作用（改一处必须三处一起改）不变。
 */
export const TOKEN_ENV = 'QQBOT_PANEL_TOKEN';

/**
 * 页面里 token 的占位符。
 *
 * 服务端发 `GET /` 时把它换成真 token。**测试也从这里注入**
 * （见 `test/verify-presets.mjs` 与本项目 `panel/next/index.html` 的 meta），
 * 于是"页面到底有没有把 token 用上"是真的被测到了 ——
 * 而不是靠测试的转发器替页面加一个头（那样只能测到服务端，测不到接线）。
 *
 * ⚠️ 页面脚本里也会出现这个字符串（当作"还没注入"的哨兵），所以**绝不能全文替换**：
 *    2026-09-19 实测踩到一次 —— `html.split(SLOT).join(token)` 把脚本里的哨兵常量
 *    一起换成了 token，于是"当前值 = 哨兵"这个判据永远为假，页面自认为没拿到 token。
 *    表现是：**页面所有写操作 401，而所有"token 已注入"的断言全绿**。
 *
 * @sync-with panel-token-slot
 *   取用侧是**现役控制台入口页** `panel/next/index.html` 的 `<meta name="panel-token">`
 *   占位符，必须与本常量**逐字相同**。
 *   零构建单文件没法 import，所以这一对**合并不了**，只能登记 + 让契约比对字面量。
 *   ⚠️ S-12 第四批（2026-10-05）：旧页（`panel/parts/00-head.html` 的 meta 与
 *      `panel/parts/14-script.html` 的 `PANEL_TOKEN_SLOT` 哨兵）已下线，登记随之收窄到一处。
 */
export const TOKEN_SLOT = '__QQBOT_PANEL_TOKEN__';

/** 只匹配 `<meta name="panel-token" content="…">` 的**属性值**，不动文件里其它地方。 */
const TOKEN_META_RE = /(<meta name="panel-token" content=")[^"]*(")/;

/**
 * 把 token 注入页面 —— **全项目唯一一处**做这件事的地方。
 * 服务端和测试都用它，两边就不会各写一份替换规则（各写一份迟早不一致）。
 */
export function injectPanelToken(html, token) {
  // 用函数做替换：`$&` / `$1` 这类符号出现在 token 里时不会被当成替换模式。
  return html.replace(TOKEN_META_RE, (_m, head, tail) => head + token + tail);
}

/**
 * 这次请求带着哪个 token。没有就返回空串。
 *
 * 只认两种写法，**别的都不认** —— 放宽解析（比如"任意头里含 token 就算"）
 * 等于给自己开后门，而那种后门从代码上看不出来。
 */
export function presentedToken(headers = {}) {
  const raw = headers['authorization'] ?? headers['Authorization'];
  if (typeof raw === 'string') {
    const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(raw.trim());
    if (m) return m[1];
  }
  const bare = headers[TOKEN_HEADER] ?? headers['X-Panel-Token'];
  return typeof bare === 'string' ? bare.trim() : '';
}

/**
 * 定长比较。
 *
 * 长度不等直接 false —— `timingSafeEqual` 在长度不等时会**抛异常**，
 * 不是一个"返回 false"的函数；把它包在这里，调用方就不必再try一次。
 * 空值也直接 false：`'' === ''` 会让"没有 token"变成"匹配成功"。
 */
export function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 这次请求放不放行 —— **全项目唯一一处这样的判定**。
 *
 * `isWrite` 由调用方从 `isWriteRequest()` 传进来：读写分类表仍然只有
 * `panel/server.js` 里的 `WRITE_ROUTES` / `READ_ONLY_POST` 一张
 * （B9 立的规矩：「哪些请求算改动」只有一处实现）。这里**不再抄一份**。
 *
 * 返回 `{ allow, status?, reason }`。reason 是给日志看的机器值，
 * 不是给用户看的文案（文案在 server.js，一处）。
 */
export function authDecision({ isWrite, presented = '', expected = '' }) {
  if (!isWrite) return { allow: true, reason: 'read' };
  if (!expected) return { allow: false, status: 401, reason: 'server-token-missing' };
  if (!presented) return { allow: false, status: 401, reason: 'missing' };
  if (!tokenMatches(presented, expected)) return { allow: false, status: 401, reason: 'mismatch' };
  return { allow: true, reason: 'ok' };
}

/**
 * 生成一个新 token。
 *
 * `rng` 注入是为了可测：测试要断言的是"够长、且两次不同"，
 * 不是"随机数发生器本身对不对"。
 * base64url 而不是 hex —— 同样长度下熵更高，且放 URL / 头里都不需要转义。
 */
export function newToken(rng = randomBytes) {
  return rng(24).toString('base64url');
}
