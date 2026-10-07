/**
 * 浏览锁定（browseLock）—— 抓取**范围**判据（D15 · 报告 E11 ②）
 * ══════════════════════════════════════════════════════════════════════════
 *  它只回答一句话：**"这个地址在我们的允许清单里吗"**。
 *
 *  为什么要有它：本项目对"能不能去这个地址"另有一道闸（`src/safe-fetch.js`，
 *  判私网/回环/云元数据），但那是**地址形态**的闸 —— 一个完全合法的公网域名
 *  （比如某个随机站点）它对谁都放行。E11 要的"上网范围限制"是另一件事：
 *  **只允许去我们点名的那几个站**。两者是**互补**的，不是重复：
 *      safe-fetch  拦"不该去的**类别**"（私网、元数据、内嵌凭据…）
 *      browseLock  拦"不在**名单**里的任何人"
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *  ⚠️ 为什么**不**放进 `src/net-rules.js`（报告 §落点 写的是那个文件）
 *  ──────────────────────────────────────────────────────────────────────────
 *  `net-rules.js` 那份判据回答的是"**花不花钱**"（本机/局域网 = 免费），
 *  与本模块**故障代价的方向相反**（R2 已把这条写成硬纪律）：
 *      net-rules   放宽 = 把云端的钱算成本机免费（账错，界面看不出来）
 *      browseLock  放宽 = 放行了不该去的站点（**收窄才是安全的**）
 *  把一条"收窄才安全"的判据塞进那个文件，下一个人照着"那边可以放宽"的先例改一下，
 *  就会**静默**放宽上网范围。所以它自成一个零依赖叶子，与两边都不互相 import。
 *
 *  ⚠️ 与 `custom-config.js` 的 `browseLock` 段配套：那边的默认值是
 *     `{ enabled: false, hosts: [] }` —— 见 `readBrowseLock` 对"关闭态"的说明。
 */

/** 配置段的默认值。**唯一住处** —— 别在别处再写一遍 `{enabled:false, hosts:[]}`。 */
export const BROWSE_LOCK_DEFAULTS = Object.freeze({ enabled: false, hosts: [] });

/** 拒绝原因。**封闭枚举**：调用方要按原因分支，随手加一个不该有的原因必须能被发现。 */
export const BROWSE_REASONS = Object.freeze([
  'lock-off',        // 没开启锁定 —— 这是"功能没开"，不是"放行了一个越界请求"
  'bad-target',      // 不是能识别的 http(s) 绝对地址
  'empty-allowlist', // 开了锁但 名单为空 → 什么都不放行（fail-closed 的真形态）
  'not-in-allowlist',// 名单里没有这个主机
]);

/**
 * 一条"允许项" → 干净的主机名（小写、去掉协议/路径/端口/通配前缀）。
 *
 * 容错方向是**宁可少收，不可错收**：认不出来的一律丢弃（返回空串）。
 * 反过来（猜一个出来）会把 `*`、`.`、空串之类变成**永真**的匹配项 ——
 * 那等于把锁关掉，而且界面上看不出任何异常。
 *
 * @param {unknown} raw
 * @returns {string} 归一化后的主机名；认不出返回 `''`
 */
export function normalizeAllowedHost(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  // 允许写成 `https://example.com/api` 这种整条地址 —— 只取主机名那一段。
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try { s = new URL(s).hostname; } catch { return ''; }
  }
  // 去掉端口与路径（`example.com:443/x` → `example.com`）
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.split(':')[0];
  // 去通配前缀：`*.example.com` 与 `.example.com` 都归一成 `example.com`
  // （子域匹配本来就是默认行为，写不写星号都一样 —— 见 hostAllowed）
  s = s.replace(/^\*\./, '').replace(/^\./, '');
  if (!s) return '';
  // 只收"像主机名"的：至少一个点，且字符集受限。`*` / `localhost` 这类不受理 ——
  // 前者会让整条判据永真，后者是回环（那是 safe-fetch 的管辖，不是"站内"）。
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return '';
  return s;
}

/**
 * 归一化整个白名单：逐项过 `normalizeAllowedHost`，**去重并排序**。
 *
 * 为什么排序：同一个白名单，界面上、日志里、断言里打印出来的顺序必须一致 ——
 * 否则"名单变了没有"要靠肉眼比对两串乱序文本（这是本项目反复踩的那类不可复现）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeAllowedHosts(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const h = normalizeAllowedHost(item);
    if (h && !out.includes(h)) out.push(h);
  }
  return out.sort();
}

/**
 * 把配置段的原始值归一化成判据能吃的形状。
 *
 * ⚠️ **关闭态 = 不锁**（`enabled:false` → 所有地址都不经本判据）：
 *    这不是"fail-open 的漏洞"，而是"这个功能没开" —— 真机默认就是关的，
 *    一开就把三个已启用的联网技能（百科 / B 站 / 额度情报）的可达范围砍到名单之内，
 *    那是**行为面变化**，必须有人明确点头（与 D12b「参数化 + 可观测、总闸不开」同款）。
 *    而**开着的时候**是 fail-closed 的：名单为空 → 什么都不放行。
 *
 * @param {unknown} raw `config.json` 的 `custom.browseLock`
 * @returns {{enabled:boolean, hosts:string[]}}
 */
export function readBrowseLock(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled === true,
    hosts: normalizeAllowedHosts(src.hosts),
  };
}

/**
 * 主机命中判断：**自身或它的子域**。
 *
 * `example.com` 命中 `example.com` 与 `a.b.example.com`，**不**命中
 * `notexample.com`（后缀必须落在点边界上）—— 后者是最容易写错的一种：
 * 用 `endsWith('example.com')` 就把它放进来了。
 *
 * @param {string} host 已小写
 * @param {string} allowed 已归一化
 */
function hostAllowed(host, allowed) {
  const h = String(host ?? '').toLowerCase();
  const a = String(allowed ?? '').toLowerCase();
  if (!h || !a) return false;
  return h === a || h.endsWith(`.${a}`);
}

/**
 * 判据入口：这个 URL 允不允许去。
 *
 * 返回**结论 + 原因**（不抛错）—— 调用方（`ext-fetch.js`）负责把它变成
 * 一条抛给扩展包的、**带指路**的错误信息。
 *
 * ⚠️ 拒绝理由里带 `http(s) only`、`名单为空`、`不在名单` 三种可区分的说法，
 *    而不是"被拦下了" —— 模型/人看到"只能用站内 + 名单是什么"才不会反复空烧轮次
 *    （报告原文：「错误信息提示「只能用站内」，避免模型空烧轮次」）。
 *
 * @param {unknown} rawUrl
 * @param {{enabled?:boolean, hosts?:string[]}} lock 已归一化的配置（`readBrowseLock` 的产物）
 * @returns {{allow:boolean, reason:string, host:string, detail:string}}
 */
export function browseDecision(rawUrl, lock = BROWSE_LOCK_DEFAULTS) {
  const l = lock && typeof lock === 'object' ? lock : BROWSE_LOCK_DEFAULTS;
  const hosts = Array.isArray(l.hosts) ? l.hosts : [];
  // 关闭态：直接放行，且原因**明写是"没开"** —— 别让它看起来像"通过了名单检查"。
  if (l.enabled !== true) {
    return { allow: true, reason: 'lock-off', host: '', detail: '浏览锁定未启用' };
  }

  let u;
  try {
    u = new URL(String(rawUrl ?? ''));
  } catch {
    return {
      allow: false, reason: 'bad-target', host: '',
      detail: '只允许 http/https 的绝对地址（这个地址解析不出来）',
    };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return {
      allow: false, reason: 'bad-target', host: '',
      detail: `只允许 http/https（收到 ${u.protocol}）`,
    };
  }
  const host = u.hostname.toLowerCase();

  if (!hosts.length) {
    return {
      allow: false, reason: 'empty-allowlist', host,
      detail: '浏览锁定开着但允许名单是空的 —— 此时**什么都不放行**（要放行就先在设置里加站）',
    };
  }
  if (hosts.some((a) => hostAllowed(host, a))) {
    return { allow: true, reason: '', host, detail: '' };
  }
  return {
    allow: false, reason: 'not-in-allowlist', host,
    // 把名单原样贴出来：这是给模型看的（它据此换站或放弃），也是给人排障看的。
    detail: `只能用站内：允许的站点是 ${hosts.join(' / ')}（${host} 不在其中）`,
  };
}
