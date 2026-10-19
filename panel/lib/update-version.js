/**
 * 更新清单的版本比较（P3 · 2026-10-18）。
 *
 * 与 `packaging/windows/tools/lib/install-layout.mjs` 的 `compareVersions` 同口径：
 * 只处理 `x.y.z[-tag]`；预发布 < 同核心版本的正式版。
 *
 * ⚠️ 两份实现不能互相 import：安装器 stage 里只有 `tools/` 与 `app/`，
 *    `tools/lib/install-layout.mjs` 刻意只依赖 `node:`；面板侧也不能 import
 *    `packaging/`（它不在 app payload 里）。一致性由 `test/installer-p3.mjs`
 *    的对照表逐项钉住，而不是靠“记得改两边”。
 */

export function parseVersion(value) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(.+))?$/.exec(String(value || '').trim());
  if (!m) return null;
  return {
    parts: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)],
    prerelease: m[4] ? 1 : 0,
    raw: String(value).trim(),
  };
}

/** a<b 返回 -1，相等 0，a>b 返回 1；任一侧解析不出来返回 null。 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) {
    if (x.parts[i] !== y.parts[i]) return x.parts[i] < y.parts[i] ? -1 : 1;
  }
  if (x.prerelease !== y.prerelease) return x.prerelease > y.prerelease ? -1 : 1;
  return 0;
}

export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) === 1;
}
