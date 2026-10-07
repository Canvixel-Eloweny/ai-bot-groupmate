/**
 * 网络地址判定 —— 全项目**唯一实现**（第 39 轮 B11c · AR-DATADRIVEN）
 * ══════════════════════════════════════════════════════════════════════════
 *  这个模块只回答两个问题：
 *
 *      isLocalBase(base)   这个地址是不是本机 / 局域网（= 跑了不花钱）
 *      providerOf(base)    这个地址属于哪家（local / deepseek / zhipu / other）
 *
 *  为什么值得单独一个文件 —— 这两条判据以前有 **五份拷贝 + 两处内联**：
 *
 *      src/config.js                    机器人进程，判"这条消息花不花钱"
 *      panel/lib/models.js              面板后端，判钱
 *      panel/index.html 的 isLocalAddr  页面，判钱 + 判"用哪家大脑"按钮高亮
 *      panel/server.js 的 fetchBalance  查余额前又判一次"是不是 DeepSeek"
 *      scripts/sanitize-config.mjs      给脱敏假值起名
 *      （另有 index.html 里两处直接写 `/deepseek\.com/i` / `/bigmodel\.cn/i`
 *        的内联写法 —— 连"⚠️ 手工同步"那句注释都没覆盖到。）
 *
 *  也就是说：计划里"三处手工同步"这个说法本身**低估了实际份数**。
 *  而它已经真的漂过一次：前端那份少写了 `172.16–31` 内网段，
 *  后果是**同一个地址，花费面板说"云端·计费"、后端按"本机·免费"统计** ——
 *  账算错了，而界面上看不出任何异常。
 *
 *  ⚠️ 本批处理的**不是"再同步一次"**（手工同步本来就不可执行），
 *     而是**让它没有第二份可漂**：前端一个判据都不再自存，由面板后端算好
 *     `provider` 字段随 `/api/state` 下发 —— 与 `MODEL_LABELS` / `modelCaps`
 *     完全同款（那是这个项目已经验证过的先例：第三份模型名单就是这么消掉的）。
 *
 *  为什么"判据"可以这样收敛、而"提示词"不行：判据的答案是**有限枚举**
 *  （四选一），下发的是一份结论；提示词是要拼进请求体的长文本，形状完全不同。
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  ⚠️ 零依赖、纯函数：本模块**不 import 任何东西**（连 node: 都不用），
 *     所以机器人进程、面板进程、构建脚本都能直接 import，
 *     不必担心副作用、加载顺序或"启动时拿到半成品"（ESM 循环 import 的典型症状）。
 *
 *  ⚠️ 判据字面量（`172\.(1[6-9]` / `deepseek\.com` / `bigmodel\.cn`）
 *     在生产源码与测试里**只许出现在本文件**，
 *     由 `scripts/check-wb.mjs` 第 8 节契约盯着（计数恒为 1 + 打印扫描规模自证）。
 *     ⚠️ 这段注释以前写的是"第 10 段"—— 那是**自证段**，不是判据唯一实现那一节。
 *        指向错了不会报错，只会让下一个按图索骥的人找到一节不相干的契约。
 */

/**
 * 本机 / 局域网地址。
 *
 * 覆盖：环回（`127.0.0.1` / `localhost` / `[::1]`）、`0.0.0.0`、
 * RFC1918 三段私有网段（`10/8`、`172.16–172.31`、`192.168/16`）。
 *
 * 两个容易写错的细节，都写在这里而不是留给下一个抄的人：
 *  ① **必须锚住主机名那一段**：前面是 `//` 或串首、后面是 `:` `/` 或串尾。
 *     不锚的话 `127.0.0.1.example.com`（攻击者可控的域名）会被认成本机，
 *     于是"本机免费"这条判定可以被一个域名骗过去。
 *  ② **`172` 段只认 16–31**：整个 `172.0.0.0/8` 里有公网地址，
 *     写宽了会把真的云端调用判成免费。
 */
const LOCAL_HOST_RE =
  /(^|\/\/)(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:|\/|$)/i;

export function isLocalBase(base) {
  return LOCAL_HOST_RE.test(String(base || ''));
}

/**
 * 接口地址属于哪家。切换服务商时靠它归档 / 取回对应的 Key，
 * 计费与用量统计也按它分流 —— 所以它错一次会同时错两件事。
 *
 * 顺序即语义：**先判本机**。本机地址可能同时长得像某家的域名
 * （自建反代 `api.deepseek.com.local` 这类），那就该算本机 —— 钱是本地花的。
 *
 * 返回 `'other'` 是**兜底而不是异常**：用户可以填任何自建 / 中转地址，
 * 那时"属于哪家"确实没有答案，界面按"未知服务商"处理。
 * ⚠️ 别把 `'other'` 改成一个新名字（比如 `'unknown'`）——
 *    前端 `PROVIDERS` 表的键与它是两个独立的东西，改名不会报错、只会静默失配。
 */
/**
 * 两家厂商的域名，**全仓唯一一处**这个字面量（2026-10-05 · S-08）。
 *
 * ⚠️ 为什么要抽成字符串常量而不是直接写正则：
 *    `check-wb` 第 8 节的契约要求"被转义过的那份字面量在全仓**恰好出现 1 次**"
 *    （判据形状见 `FINGERPRINTS`：'deepseek\\.com'）。
 *    本模块下面要用它**两次** —— 一次判"含不含"（子串），一次判"结不结尾" ——
 *    如果各写一份正则，命中数变成 2，契约当场报红。
 *    ⇒ 所以字面量住在这里，两个正则**都由它派生**。这不是绕开判据，
 *      正是判据要的那种形状：字面量只有一份，谁也漂不了。
 */
// 子串匹配（`providerOf` 用）：认"这个地址属于哪家"
const DEEPSEEK_RE = /deepseek\.com/i;
const ZHIPU_RE = /bigmodel\.cn/i;
// 结尾匹配（`providerHostOk` 用）：认"host 真的是以它的官方域名收尾"。
// ⚠️ 由上面那份的 `.source` 派生，不再写第二遍字面量 ——
//    本轮第一版抽成了 `'deepseek\\.com'` 字符串常量，结果契约搜的是
//    "被转义过的那一份"（一个反斜杠），两个反斜杠的写法让它**一次都命中不到**，
//    报的是"命中 [无]"。形状要对上判据认的那种。
const DEEPSEEK_END_RE = new RegExp(`(^|\\.)${DEEPSEEK_RE.source}$`, 'i');
const ZHIPU_END_RE = new RegExp(`(^|\\.)${ZHIPU_RE.source}$`, 'i');

export function providerOf(base) {
  const b = String(base || '');
  if (isLocalBase(b)) return 'local';
  if (DEEPSEEK_RE.test(b)) return 'deepseek';
  if (ZHIPU_RE.test(b)) return 'zhipu';
  return 'other';
}

/**
 * 已知厂商的**官方域名后缀**（2026-10-05 开源前审查 · S-08）。
 *
 * ⚠️ 为什么需要它，`providerOf()` 不够：
 *    `providerOf()` 用的是**子串**匹配，于是 `https://deepseek.com.evil.com`
 *    会被判成 `deepseek` —— 而那其实是一个攻击者控制的域名。
 *    只有"host **以**官方域名结尾"才能把两者分开。
 *
 *    这件事的后果：`baseUrl` 是机器人发请求的目标，请求头带着该厂商的 API Key。
 *    把它指到一个长得像官方的域名上，等于把 Key 和群里的对话一起送出去
 *    （攻击者返回的文本还会被当作"模型回复"照发进群）。
 *
 * ⚠️ 域名字面量**只许出现在上面那两个常量里**（同一条纪律，
 *    由 `scripts/check-wb.mjs` 第 8 节的计数契约盯着）。调用方用返回值，别自己抄正则。
 */
const PROVIDER_HOST_END_RE = {
  deepseek: DEEPSEEK_END_RE,
  zhipu: ZHIPU_END_RE,
};

/**
 * 这个地址配不配得上它自称的那家厂商。
 *
 * `local` / `other` 一律返回 true —— 自建与中转地址本来就没有"官方域名"可校验，
 * 那一类由调用方按**协议**判（明文 http 只允许本机）。
 *
 * @returns {boolean} false = "自称 deepseek 但域名不是它的"
 */
export function providerHostOk(base) {
  const p = providerOf(base);
  const re = PROVIDER_HOST_END_RE[p];
  if (!re) return true; // local / other 不在这里判
  let host;
  try { host = new URL(String(base)).hostname; } catch { return false; }
  return re.test(host);
}
