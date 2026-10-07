/**
 * 出站抓取的**地址判据** —— 防 SSRF（第 40 轮 B13 · NET-SSRF）
 * ══════════════════════════════════════════════════════════════════════════
 *  这个模块只回答一个问题：
 *
 *      「这个 URL，能不能去？」
 *
 *  ⚠️ 它**不回答**「这个地址花不花钱」—— 那是 `src/net-rules.js`
 *     （判据是**主机名字符串**，因为它要判的地址全部来自可信配置：
 *      `llm.baseUrl` / `custom.*.baseUrl`）。
 *     两者刻意**不合并、也不互相调用**，理由见下面「为什么不能复用 net-rules」。
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  为什么要有这个模块（现在还没有调用方）
 * ──────────────────────────────────────────────────────────────────────────
 *  当前仓库里**没有任何"抓取用户给的 URL"的代码**：
 *      `src/llm.js`            只去 `llm.baseUrl`（配置，可信）
 *      `panel/server.js`       一处固定 DeepSeek、两处本机回环、一处配置里的 baseUrl
 *      `panel/lib/models.js`   固定智谱的包版本 API
 *  QQ 消息里的图片是**由服务商去取**的（我们只转发 URL），所以本机也没有这个面。
 *
 *  那为什么现在做：**联网（P3）一旦落地，第一个抓取点就会出现** ——
 *  而"私网段怎么判"这类判据在本项目的历史上**每次都是被抄成好几份**
 *  （地址判据曾经五份拷贝 + 两处内联，真的漂过一次、把账算错了，见 `src/net-rules.js`）。
 *  在第一个调用方出现**之前**把判据立起来，是**唯一能避免重演那个过程**的时机。
 *  等有了五个调用方再做，就是在做"收敛"，而收敛的成本远高于一开始只写一份。
 *
 *  ⚠️ **生产调用方：1 个**（`src/ext-fetch.js` —— 扩展包 `api.fetch` 那条路）。
 *     这个数字是**被断言的事实**，不是自由文本：`scripts/check-wb.mjs` 第 11 节契约
 *     盯着"谁 import 了它"，调用方变化时那条契约会红，逼着人回来同步这一行。
 *     ⚠️ 2026-10-04 审查轮修正：此处原写「**本模块当前 0 个生产调用方**」，而第 55 轮
 *     接入 `src/ext-fetch.js` 时没回来改这句 —— 过期文案的代价是**误导排障**
 *     （人会按"0 调用方"去找一个不存在的调用点，而真实的那个就在隔壁文件里）。
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  判据本身：六条，缺一条就等于没防
 * ──────────────────────────────────────────────────────────────────────────
 *  ① **只许 http / https**。`file:` / `data:` / `ftp:` 之类一律拒绝。
 *  ② **禁内嵌凭据**（`http://user:pass@host/`）。它既是凭据泄漏，
 *     也是"同一个 URL 在不同解析器里主机名不同"的经典混淆点。
 *  ③ **解析后按地址判，不按主机名字符串判**。`127.0.0.1.example.com`
 *     这种域名长得像本机但不是；反过来 `evil.test` 解析到 `127.0.0.1` 就是本机。
 *     判据必须落在**解析结果**上。
 *  ④ **全部解析结果都要是公网地址**（任一私有即整体拒绝）。
 *     只看第一条会被"轮询 DNS / 一公一私"绕过。
 *  ⑤ **连接时固定用刚才审过的那个 IP**（`lookup` 钉死）。
 *     否则"审完再做第二次解析"之间可以换答案（DNS rebinding）。
 *  ⑥ **每一跳都要重判**。重定向的 `Location` 是**对端给的输入**，
 *     和第 1 跳的 URL 一样不可信；跳数还要有上限。
 *
 *  另外：读取**限量**、请求**限时** —— 目标可以回一个 100GB 的响应或永不到头。
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  ⚠️ 为什么不能复用 `net-rules.isLocalBase()` 来做这个判定
 * ──────────────────────────────────────────────────────────────────────────
 *  它判的是**主机名字符串**，而且只覆盖"环回 + 三段 RFC1918"。
 *  拿它当 SSRF 判据会漏掉：`169.254.169.254`（云元数据，最经典的一个）、
 *  `100.64/10`、IPv6 的 `fc00::/7` / `fe80::/10` / `::ffff:127.0.0.1`，
 *  以及**"域名解析到私网"**这一整类。
 *  反过来，把 `net-rules` 改宽会**改坏计费判定**（那是它的语义：本机 = 不花钱，
 *  所以只能收窄不能放宽）。两件事的**故障代价指向相反的方向**，
 *  所以它们必须是两份实现 —— 这一条是**有意**的，别再合并。
 */

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';

/**
 * 默认策略。
 * ⚠️ 这几个数字都是**经验值，非官方阈值**（呼应本项目"不编造风控阈值"那条纪律）：
 *    凭据是从"要抓一个网页正文"这个用途倒推的，不是任何规范规定的值。
 *    要改请连着这条注释一起改，别让下一个读的人以为是标准。
 */
const NET_POLICY = {
  /** 只许这两种协议 */
  protocols: ['http:', 'https:'],
  /** 最多跟几跳重定向（第 4 个 3xx 就拒绝） */
  maxRedirects: 3,
  /** 单次响应最多读多少字节，超了断开（防止被一个超大响应拖死） */
  maxBytes: 2 * 1024 * 1024,
  /** 单跳的超时（不是整链的总超时） */
  timeoutMs: 10_000,
};

/**
 * 拒绝原因**封闭枚举**。
 * 用意同 `net-rules.providerOf()` 的 `'other'`：调用方要按原因分支，
 * 所以原因集合必须是有限的、被断言过的 —— 允许随手写新字符串，
 * 等于允许"某天多一个原因而调用方的 switch 悄悄走了 default 分支"。
 */
export const FETCH_REASONS = [
  'not-a-url',
  'bad-protocol',
  'embedded-credentials',
  'resolve-failed',
  'blocked-address',
  'too-many-redirects',
  'bad-redirect',
  /** https 被重定向降级成 http（Q27 裁决：拦。见 `nextTarget()` 的注释）。 */
  'insecure-downgrade',
  'too-large',
  'timeout',
  'request-failed',
];

// ── 地址判据 ─────────────────────────────────────────────────────────────

/** 点分四段 → uint32。形式不合法返回 null（不做"猜一个值"的容错）。 */
function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/**
 * IPv4 的**不可访问 / 非公网**网段表。
 *
 * `[基址, 前缀长度, 人话]`。带最后一项是因为拒绝信息要能直接进日志 ——
 * "被 169.254.0.0/16 拦下"和"被链路本地地址拦下"对排查的人是两种信息量。
 *
 * 覆盖：本网络 / 三段 RFC1918 / 环回 / 链路本地 / 运营商级 NAT /
 * IETF 保留 / 三个文档用网段 / 已废弃的 6to4 中继 / 基准测试 / 组播 / 保留段。
 */
const V4_BLOCKS = [
  ['0.0.0.0', 8, '「本网络」（0/8）'],
  ['10.0.0.0', 8, '私有网段（10/8）'],
  ['100.64.0.0', 10, '运营商级 NAT（100.64/10）'],
  ['127.0.0.0', 8, '环回（127/8）'],
  ['169.254.0.0', 16, '链路本地（169.254/16，云元数据走这里）'],
  ['172.16.0.0', 12, '私有网段（172.16/12）'],
  ['192.0.0.0', 24, 'IETF 保留（192.0.0/24）'],
  ['192.0.2.0', 24, '文档用（TEST-NET-1）'],
  ['192.88.99.0', 24, '6to4 中继（已废弃）'],
  ['192.168.0.0', 16, '私有网段（192.168/16）'],
  ['198.18.0.0', 15, '基准测试（198.18/15）'],
  ['198.51.100.0', 24, '文档用（TEST-NET-2）'],
  ['203.0.113.0', 24, '文档用（TEST-NET-3）'],
  ['224.0.0.0', 4, '组播（224/4）'],
  ['240.0.0.0', 4, '保留（240/4，含 255.255.255.255）'],
].map(([base, len, who]) => [ipv4ToInt(base), len, who]);

/** 命中哪个 v4 网段；不命中返回 null。 */
function v4Reason(n) {
  for (const [base, len, who] of V4_BLOCKS) {
    // len === 32 的掩码用 `1 << 0` 表达更麻烦，这里统一走"移位 + 无符号化"，
    // 只有 len === 0 需要特判（`1 << 32` 在 JS 里等于 `1 << 0`，是个陷阱）。
    const mask = len === 0 ? 0 : (~((1 << (32 - len)) - 1)) >>> 0;
    if (((n & mask) >>> 0) === ((base & mask) >>> 0)) return who;
  }
  return null;
}

/** IPv6 → 8 个 16 位字。形式不合法返回 null。 */
function ipv6Words(ip) {
  let s = String(ip).trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  // 作用域后缀（`fe80::1%en0`）不影响网段判定，去掉
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  if (s.includes('.')) {
    // 尾部的 IPv4 形式（`::ffff:127.0.0.1`）→ 换成两段十六进制
    const cut = s.lastIndexOf(':');
    const v4 = ipv4ToInt(s.slice(cut + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, cut + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 && fill < 1) return null;
  const words = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail];
  if (words.length !== 8) return null;
  const nums = words.map((w) => (/^[0-9a-f]{1,4}$/i.test(w) ? parseInt(w, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

/** 命中哪个 v6 网段；不命中返回 null。内嵌 IPv4 的形式会**递归**判那个 IPv4。 */
function v6Reason(w) {
  if (w.every((x) => x === 0)) return '未指定地址（::）';
  const isV4Tail = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0;
  // IPv4 映射（::ffff:0:0/96）与 IPv4 兼容（::/96，已废弃）：
  // ⚠️ 不能整体判死 `::ffff:0:0/96` —— 它也能合法地装一个**公网** IPv4。
  //    正确做法是**看着里面那个 v4 说话**（内嵌的是 127.0.0.1 就必须拦）。
  if (isV4Tail && w[5] === 0xffff) {
    return v4Reason(((w[6] << 16) | w[7]) >>> 0) || null;
  }
  if (isV4Tail && w[5] === 0) {
    if (w[6] === 0 && w[7] === 1) return '环回（::1）';
    return 'IPv4 兼容地址（::/96，已废弃）';
  }
  if ((w[0] & 0xfe00) === 0xfc00) return '唯一本地地址（fc00::/7）';
  if ((w[0] & 0xffc0) === 0xfe80) return '链路本地（fe80::/10）';
  if ((w[0] & 0xff00) === 0xff00) return '组播（ff00::/8）';
  if (w[0] === 0x100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return '丢弃前缀（100::/64）';
  if (w[0] === 0x2001 && w[1] === 0x0db8) return '文档用（2001:db8::/32）';
  // 6to4 / NAT64 都把 IPv4 嵌在里面 —— 同样只看里面那个 v4
  if (w[0] === 0x2002) return v4Reason(((w[1] << 16) | w[2]) >>> 0) || null;
  if (w[0] === 0x64 && w[1] === 0xff9b) return v4Reason(((w[6] << 16) | w[7]) >>> 0) || null;
  return null;
}

/**
 * 这个地址是不是**不能去**的。命中返回人话理由，公网地址返回 `null`。
 *
 * ⚠️ 传进来的必须是**解析结果或 URL 归一化后的字面 IP**，不能是域名 ——
 *    域名的判定必须等到解析之后（见文件头判别 ③）。
 */
export function blockedReasonOf(ip) {
  const s = String(ip || '');
  if (!s) return '空地址';
  if (s.includes(':')) {
    const w = ipv6Words(s);
    return w ? v6Reason(w) : '无法解析的 IPv6 地址';
  }
  const n = ipv4ToInt(s);
  return n === null ? '无法解析的 IPv4 地址' : v4Reason(n);
}

/** 便捷布尔版（给人读的判定走 `blockedReasonOf`）。 */
export function isBlockedAddress(ip) {
  return blockedReasonOf(ip) !== null;
}

/**
 * 一批解析结果 → 能不能去。
 *
 * **任一被拦就整体拒绝**（fail-closed）：DNS 可以轮询，
 * "第一条公网、第二条私网"这种答案下，你连上哪一条是不可控的。
 */
function scanAddresses(addrs) {
  const list = Array.isArray(addrs) ? addrs : [];
  if (!list.length) return { ok: false, reason: 'resolve-failed', detail: '解析结果为空' };
  const blocked = [];
  for (const a of list) {
    const ip = typeof a === 'string' ? a : a && a.address;
    const why = blockedReasonOf(ip);
    if (why) blocked.push(`${ip}（${why}）`);
  }
  if (blocked.length) {
    return { ok: false, reason: 'blocked-address', detail: blocked.join('、'), blocked };
  }
  return { ok: true };
}

// ── URL 判据 ─────────────────────────────────────────────────────────────

/** 主机名去掉 IPv6 的方括号（`new URL('http://[::1]/').hostname` 是带括号的）。 */
function bareHost(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '');
}

/**
 * 这个主机名是不是**字面 IP**（而不是域名）。
 *
 * ⚠️ 区分它不是为了"看起来整齐"，而是因为 `blockedReasonOf()` 对
 *    **域名**会返回「无法解析的 IPv4 地址」—— 那是"这不是个 IP"的意思，
 *    不是"这个地址不能去"。把域名直接喂给地址判据，`localhost` / 任何域名
 *    都会被判成被拦（假阳性），而假阳性会让这条防线在某天被整体注释掉。
 */
function isIpLiteral(host) {
  return String(host).includes(':') ? ipv6Words(host) !== null : ipv4ToInt(host) !== null;
}

/**
 * 字符串 → 可信的 `URL` 对象。三道闸：能解析 / 协议在白名单 / 无内嵌凭据。
 *
 * 为什么这一步有价值：**WHATWG URL 会把各种写法归一化**，实测
 *   `http://2130706433/` → `127.0.0.1`
 *   `http://0177.0.0.1/` → `127.0.0.1`
 *   `http://0x7f.0.0.1/` → `127.0.0.1`
 * 所以拿到 `url.hostname` 再判是可靠的；而**不能拿原始字符串判**。
 * 反过来也有一条实测教训：`dns.lookup('0177.0.0.1')` 得到的是 `177.0.0.1`，
 * 与 URL 的归一化**不一致** —— 这就是"两处都要判"的原因（见 `safeFetch`）。
 */
export function parseTarget(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, reason: 'not-a-url', detail: String(raw).slice(0, 120) };
  }
  if (!NET_POLICY.protocols.includes(url.protocol)) {
    return { ok: false, reason: 'bad-protocol', detail: `只许 ${NET_POLICY.protocols.join(' / ')}，拿到 ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'embedded-credentials', detail: 'URL 里带了用户名/口令（凭据会被写进日志与对端记录）' };
  }
  return { ok: true, url };
}

/**
 * 重定向：相对 `Location` 要按当前地址解析成绝对地址，然后再过一遍**同一套**闸。
 * `Location` 是对端给的输入，和第 1 跳的 URL 一样不可信 —— 不能只判第一跳。
 *
 * ── 额外一条：**不许 https → http 降级**（Q27 裁决「拦」，第 42 轮 B12c）──
 * 第 40 轮（B13）落地时这里只做"如实跟随"，把"要不要拦降级"登记成待裁决的 Q27。
 * 本轮裁决为**拦**，理由是这条路径的语义发生了变化：
 * 调用方**只在 https 上**才会带上凭据 / 正文，而降级之后这些都以明文走 ——
 * 攻击面从"对端可信即可"变成"链路上任何一跳都可信才可"。
 *
 * ⚠️ 只判**重定向**，不判第 1 跳：首跳是调用方自己给的地址，
 *    他显式写 `http://…` 是他的选择；对端把他**悄悄换掉**才是这里要防的事。
 * ⚠️ 顺序在 `parseTarget()` **之前**：协议白名单只认 http/https，
 *    放它后面判的话这条原因会被 `bad-protocol` 抢先，永远看不到。
 */
export function nextTarget(location, currentUrl) {
  const loc = String(location == null ? '' : location).trim();
  if (!loc) return { ok: false, reason: 'bad-redirect', detail: 'Location 为空' };
  let base;
  let abs;
  try {
    // 先把**基地址**单独解析出来：降级判定需要它的协议，
    // 而 `new URL(loc, base)` 在 loc 是绝对地址时会忽略 base。
    base = currentUrl instanceof URL ? currentUrl : new URL(String(currentUrl));
    abs = new URL(loc, base);
  } catch {
    return { ok: false, reason: 'bad-redirect', detail: `Location 无法解析：${loc.slice(0, 120)}` };
  }
  if (base.protocol === 'https:' && abs.protocol === 'http:') {
    return {
      ok: false,
      reason: 'insecure-downgrade',
      detail: `重定向要把 https 降级成 http（${base.href} → ${abs.href}）——降级之后凭据与正文都以明文走`,
    };
  }
  // 复用 parseTarget 的三道闸（协议 / 凭据），别在这里再写一遍
  return parseTarget(abs.href);
}

// ── 传输 ─────────────────────────────────────────────────────────────────

/**
 * 默认解析器：**拿全部 A/AAAA 记录**，不做"取第一条"。
 * 取第一条就等于把"第二条是不是私网"交给运气。
 * （可注入 —— 测试里换成确定性实现，见文件头判别纪律）
 */
async function defaultResolve(hostname) {
  return dns.lookup(bareHost(hostname), { all: true, verbatim: true });
}

/**
 * 发一跳（**不跟重定向**）。导出是为了能被单独测：
 * 它是"传输"，不含地址判据，所以测试里直接拿它打本机回环服务器是正当的。
 *
 * `pinned` = `{ address, family }`：**连接时改用这个已审过的地址**，
 * 而不是让 `net` 再解析一次（那中间的窗口就是 DNS rebinding）。
 * ⚠️ Node 在开了 Happy Eyeballs 时会用 `{ all: true }` 调 `lookup`，
 *    那时回调要回**数组** —— 两种形状都要处理，只处理一种会静默拿到错误类型。
 */
export function sendOnce(url, { pinned, timeoutMs = NET_POLICY.timeoutMs, maxBytes = NET_POLICY.maxBytes } = {}) {
  return new Promise((resolve) => {
    const mod = url.protocol === 'https:' ? https : http;
    const options = { method: 'GET' };
    if (pinned) {
      options.lookup = (hostname, opts, cb) => {
        if (opts && opts.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
        else cb(null, pinned.address, pinned.family);
      };
    }
    const done = (v) => resolve(v);

    const req = mod.request(url, options, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > maxBytes) {
          res.destroy();
          done({ ok: false, reason: 'too-large', detail: `响应超过 ${maxBytes} 字节` });
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => done({ ok: true, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), bytes }));
      res.on('error', (e) => done({ ok: false, reason: 'request-failed', detail: e.message }));
    });

    req.on('error', (e) => done({ ok: false, reason: 'request-failed', detail: e.message }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done({ ok: false, reason: 'timeout', detail: `超过 ${timeoutMs}ms` });
    });
    req.end();
  });
}

// ── 主链路 ───────────────────────────────────────────────────────────────

/**
 * 受策略约束的 GET。
 *
 * 返回两种形状，**`ok` 的含义只有一种**：
 *   `{ ok: true,  status, headers, body, bytes, hops, trail }` —— 请求真的送达了
 *       （含 3xx 跟完之后的状态码；**404 也是 `ok: true`**，那是业务问题不是策略问题）
 *   `{ ok: false, reason, detail }` —— 被策略拦下 / 解析失败 / 传输失败 / 超时 / 超量
 *
 * `hops` = 实际发了几跳，`trail` = 每跳的 `{ host, address }`（进日志用，不含正文）。
 *
 * 注入点（`opts`）：`resolve` / `request` / `policy` —— 全部有默认值，
 * 生产代码不该传；测试传了才能把"逐跳重校验""固定 IP"这些行为断言下来，
 * 而不必真的去连一台会重定向到 169.254.169.254 的服务器。
 */
export async function safeFetch(rawUrl, opts = {}) {
  const policy = { ...NET_POLICY, ...(opts.policy || {}) };
  const resolve = opts.resolve || defaultResolve;
  const request = opts.request || sendOnce;

  let cur = parseTarget(rawUrl);
  if (!cur.ok) return cur;

  const trail = [];
  for (let hop = 0; ; hop += 1) {
    const host = bareHost(cur.url.hostname);

    // ⓵ URL 里直接写的**字面 IP** 先就地判一次 —— 这一道**不依赖 DNS**，
    //    所以"URL 里直接写 169.254.169.254"这种最省事的攻击连解析都到不了。
    //    （域名走不到这一道：它必须等 ⓶ 拿到解析结果才判得了。）
    if (isIpLiteral(host)) {
      const why = blockedReasonOf(host);
      if (why) {
        return { ok: false, reason: 'blocked-address', detail: `${host}（${why}）`, blocked: [`${host}（${why}）`] };
      }
    }

    // ⓶ 解析并**全量**判
    let addrs;
    try {
      addrs = await resolve(host);
    } catch (e) {
      return { ok: false, reason: 'resolve-failed', detail: `${host}：${e.message}` };
    }
    const scan = scanAddresses(addrs);
    if (!scan.ok) return { ...scan, detail: `${host} → ${scan.detail}` };

    // ⓷ 连接时钉住第一条（已审过的）地址
    const first = addrs[0];
    const pinned = { address: first.address, family: first.family };
    trail.push({ host, address: pinned.address });

    const res = await request(cur.url, { pinned, timeoutMs: policy.timeoutMs, maxBytes: policy.maxBytes });
    if (!res.ok) return res;

    const status = res.status;
    const loc = res.headers && res.headers.location;
    if (status >= 300 && status < 400 && loc) {
      if (hop >= policy.maxRedirects) {
        return { ok: false, reason: 'too-many-redirects', detail: `超过 ${policy.maxRedirects} 跳（最后一跳 ${cur.url.href} → ${loc}）` };
      }
      const nx = nextTarget(loc, cur.url);
      if (!nx.ok) return { ...nx, detail: `${loc} 处重定向不可信：${nx.detail}` };
      cur = nx; // 下一圈会**重新**走 ⓵⓶（这正是"每一跳都重判"）
      continue;
    }

    return { ok: true, status, headers: res.headers, body: res.body, bytes: res.bytes, hops: hop + 1, trail };
  }
}
