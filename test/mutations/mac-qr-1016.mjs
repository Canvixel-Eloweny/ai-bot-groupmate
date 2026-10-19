/**
 * 「Mac 二维码切换不了（显示已刷新、图不变）」（2026-10-16 · G1 单点修复）的变异清单
 * —— 纯数据，供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/mac-qr-1016.mjs` 复跑。
 *
 * 修复本体：`/api/qrcode` 的"本地优先"补上**原生形态门槛**（`panelLocalQr`）。
 * 事故形态：macOS 主线的码写在容器内（compose 只挂 `config`/`QQ`，**没挂 cache**），
 * 而开发树 `napcat/cache/qrcode.png` 躺着一张 2026-09-16 的孤儿文件 ——
 * 旧实现"文件存在就用它"⇒ 接口 200、图非空、日志写着"已换一张新二维码"，
 * 而前端每 5 秒取回的还是同一张旧图（维护者看到的就是"显示已刷新、二维码不变"）。
 *
 * 这次配了两道护栏，本清单**各配一条变异**验证它们都有牙：
 *   · check-wb §105 —— 静态侧（判据本体的形状 + apiQrcode 的接线形状）
 *   · smoke  T386   —— 行为侧（非原生不读盘 / 原生本地优先 / 读不到回 null）
 *
 * ⚠️ 锚点是**字面量**：实现一改形状（改名 / 内联 / 换写法）就是 INVALID ——
 *    先跑 `node scripts/mutate-lint.mjs`，失效的锚点要在这一份里当场修掉，不许留给下一次。
 * ⚠️ 跑测试一律带 `NODE_OPTIONS=` 前缀（R39，漏带 = smoke 内部基线 2 条假红）。
 */
const SERVER = 'panel/server.js';
const NATIVE = 'panel/lib/napcat-native.js';

// ── M1：apiQrcode 退回旧写法（不看形态、文件存在就用）→ 静态侧应该响 ───────────
const M1 = {
  id: 'M1',
  note: '把 apiQrcode 的接线退回旧实现：裸 readLocalQr()（无 native 前提）—— 这就是 2026-10-16 那个 bug 的本体（Mac 上永远发 2026-09-16 那张陈旧的码）。预期 BLOCKED（§105 双向判：接线不在 + 出现裸 readLocalQr，两处都会响；顺带 readLocalQr 已不在 server.js 的 import 里，真跑起来还会 ReferenceError）',
  anchor: /const local = panelLocalQr\(nativePresent\(\)\);/,
  count: 1,
  file: SERVER,
  apply: (s) => s.replace('const local = panelLocalQr(nativePresent());', 'const local = readLocalQr();'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：判据本体丢掉 native 门槛（原生与否都读盘）→ 行为侧应该响 ───────────────
const M2 = {
  id: 'M2',
  note: 'panelLocalQr 丢掉 native 门槛（无条件 return readDisk()）—— 非原生形态又会把盘上那张孤儿的旧码交出去，与 M1 同一个事故形态，只是这次把"形"保住了、把"义"丢了。预期 BLOCKED（T386 ①②两组断言都会响：非原生拿到了旧码 + 还去读了盘）',
  anchor: /isNative \? readDisk\(\) : null/,
  count: 1,
  file: NATIVE,
  apply: (s) => s.replace('return isNative ? readDisk() : null;', 'return readDisk();'),
  layer: 'smoke',
  expect: 'BLOCKED',
};

export default [M1, M2];
