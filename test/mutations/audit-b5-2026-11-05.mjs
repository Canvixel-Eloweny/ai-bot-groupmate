/**
 * B5 首次启动与构建输入定向变异（2026-11-05 · §187）。
 *
 * 三条都是"本机有配置/有素材，所以看不出干净检出会坏"：
 *   · 假 QQ 被硬塞一个不存在的 config.json；
 *   · 预设把全局 budget/ambientBatch 抄进每个服务商；
 *   · Docker 回退只检查两个大文件，entrypoint/templates 缺失时先 COPY 失败。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/audit-b5-2026-11-05.mjs
 */

const FAKE = 'panel/lib/fake-session.js';
const FAKE_QQ = 'scripts/fake-qq.mjs';
const MODELS = 'panel/lib/models.js';
const SERVER = 'panel/server.js';
const INPUTS = 'docker/napcat/ensure-inputs.sh';
const BOOT = 'scripts/bootstrap.sh';
const NAP = 'docker/napcat/fetch-napcat.sh';
const PKG = 'package.json';

export default [
  {
    id: 'M1',
    note: '假 QQ 又无条件注入 config 路径 —— §187① 必须变红（干净检出 ENOENT）',
    file: FAKE,
    anchor: /if \(fs\.existsSync\(CONFIG_FILE\)\) env\.QQBOT_CONFIG = CONFIG_FILE;/g,
    count: 1,
    apply: (s) => s.replace(
      'if (fs.existsSync(CONFIG_FILE)) env.QQBOT_CONFIG = CONFIG_FILE;',
      'env.QQBOT_CONFIG = CONFIG_FILE;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: 'fake-qq 不再对缺失的环境变量路径回退示例配置 —— §187① 必须变红',
    file: FAKE_QQ,
    anchor: /if \(!explicit && \(opts\.offline \|\| opts\.sandbox\)\) \{/g,
    count: 1,
    apply: (s) => s.replace(
      'if (!explicit && (opts.offline || opts.sandbox)) {',
      'if (false) {',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: 'local 预设又把整份全局 context 抄进去 —— §187② 必须变红',
    file: MODELS,
    anchor: /context: ownedContextOf\(cfg\?\.context\),/g,
    count: 2,
    apply: (s) => s.replace('context: ownedContextOf(cfg?.context),', 'context: { ...(cfg?.context || {}) },'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '应用预设时又整份合并 P.context —— §187② 必须变红',
    file: SERVER,
    anchor: /ownedContextOf\(P\.context\)/g,
    count: 2,
    apply: (s) => s.replaceAll('ownedContextOf(P.context)', '(P.context || {})'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '输入清单漏掉 linuxqq.deb —— §187③ 必须变红（缺 QQ 包也放行 build）',
    file: INPUTS,
    anchor: /have_file linuxqq\.deb \|\| missing\+=\("linuxqq\.deb"\)\n/g,
    count: 1,
    apply: (s) => s.replace('have_file linuxqq.deb || missing+=("linuxqq.deb")\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: 'bootstrap 不再调用集中检查 —— §187③ 必须变红',
    file: BOOT,
    anchor: /bash \.\/ensure-inputs\.sh/g,
    count: 2,
    apply: (s) => s.replaceAll('bash ./ensure-inputs.sh', 'true'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '下载脚本退回 BSD 专用 stat —— §187③ 必须变红（Linux 上大小恒 0）',
    file: NAP,
    anchor: /GOT=\$\(fsize "\$OUT"\)/g,
    count: 1,
    apply: (s) => s.replace('GOT=$(fsize "$OUT")', 'GOT=$(stat -f%z "$OUT" 2>/dev/null || echo 0)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '预设回归从 check:features 摘掉 —— §187④ 必须变红',
    file: PKG,
    anchor: /node test\/check-preset-context\.mjs && /g,
    count: 1,
    apply: (s) => s.replace('node test/check-preset-context.mjs && ', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: 'Docker 输入回归从 check:features 摘掉 —— §187④ 必须变红',
    file: PKG,
    anchor: /node test\/check-bootstrap-inputs\.mjs && /g,
    count: 1,
    apply: (s) => s.replace('node test/check-bootstrap-inputs.mjs && ', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
