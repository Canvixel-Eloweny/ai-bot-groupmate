/**
 * P0 更新链（2026-10-23）的变异清单 —— 纯数据。
 *
 * 四条各打一个失效面，每条都必须只让 check-wb §109 变红：
 *   U1 删掉 release-assets host；
 *   U2 往 ALLOWED_HOSTS 塞通配 '*'；
 *   U3 把离线上限回落到 64 MiB；
 *   U4 把最终 URL 校验改回初始 URL（两处）。
 *
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/update-offline-1023.mjs`
 * ⚠️ 串行；会改写真实工作树；失败后用 `--restore`。
 */

const MANIFEST = 'panel/lib/update-manifest.js';
const DOWNLOAD = 'panel/lib/update-download.js';

export default [
  {
    id: 'U1',
    note: "删掉 release-assets.githubusercontent.com —— §109 必须变红（GitHub 302 后的清单/EXE 会被拒）",
    file: MANIFEST,
    anchor: /  'release-assets\.githubusercontent\.com',\n/,
    count: 1,
    apply: (s) => s.replace("  'release-assets.githubusercontent.com',\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'U2',
    note: "往 ALLOWED_HOSTS 塞通配 '*' —— §109 必须变红（白名单被放宽到任意域名）",
    file: MANIFEST,
    anchor: /  'ghproxy\.net',\n/,
    count: 1,
    apply: (s) => s.replace("  'ghproxy.net',\n", "  'ghproxy.net',\n  '*',\n"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'U3',
    note: '把离线上限回落到 64 MiB —— §109 必须变红（Electron 载荷装不进传输层）',
    file: MANIFEST,
    anchor: /OFFLINE_INSTALLER_MAX_BYTES = 256 \* 1024 \* 1024/,
    count: 1,
    apply: (s) => s.replace(
      'OFFLINE_INSTALLER_MAX_BYTES = 256 * 1024 * 1024',
      'OFFLINE_INSTALLER_MAX_BYTES = 64 * 1024 * 1024'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'U4',
    note: '把最终 URL 校验改回初始 URL（两处）—— §109 必须变红（GitHub 302 再次失败）',
    file: DOWNLOAD,
    anchor: /validateUrl\(res\.url \|\| url\)/g,
    count: 2,
    apply: (s) => s.replaceAll('validateUrl(res.url || url)', 'validateUrl(url)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
