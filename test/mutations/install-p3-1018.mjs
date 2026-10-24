/**
 * P3 更新协议（2026-10-18）的定向变异清单。
 *
 * 目标：验收 `check-wb` §109「更新协议与两击契约」真的会红，而不是一条漂亮的空断言。
 * 复跑：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/install-p3-1018.mjs`
 */

export default [
  {
    id: 'M1',
    note: '跳过清单签名校验 —— 任何人改清单都能通过',
    file: 'panel/lib/update.js',
    anchor: /verifyRawSignature\(fetched\.raw, fetched\.sig, publicKey\)/g,
    count: 1,
    apply: (s) => s.replace(
      'if (!verifyRawSignature(fetched.raw, fetched.sig, publicKey)) {',
      'if (false) {'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '先 JSON.parse 后验签 —— 签名对象从“原始字节”被换成“解析后的对象”',
    file: 'panel/lib/update.js',
    anchor: /const fetched = fetchManifest \? await fetchManifest\(\) : await defaultFetchManifest\(\);/g,
    count: 1,
    apply: (s) => s.replace(
      'const fetched = fetchManifest ? await fetchManifest() : await defaultFetchManifest();',
      'const fetched = fetchManifest ? await fetchManifest() : await defaultFetchManifest();\n      JSON.parse(fetched.raw.toString(\'utf8\'));'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '跳过 SHA-256 校验 —— 下载到被篡改的安装包也会落盘',
    file: 'panel/lib/update-download.js',
    anchor: /if \(expectedSha256 && sha256 !== expectedSha256\.toLowerCase\(\)\)/g,
    count: 1,
    apply: (s) => s.replace(
      'if (expectedSha256 && sha256 !== expectedSha256.toLowerCase())',
      'if (false)'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '跳过尺寸校验 —— 截断/超长文件可以落盘',
    file: 'panel/lib/update-download.js',
    anchor: /if \(expectedSize && got !== expectedSize\)/g,
    count: 1,
    apply: (s) => s.replace('if (expectedSize && got !== expectedSize)', 'if (false)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '跳过过期校验 —— 旧清单可以被重放',
    file: 'panel/lib/update-manifest.js',
    anchor: /if \(Number\.isFinite\(expires\) && expires <= now\) errors\.push\('清单已过期'\);/g,
    count: 1,
    apply: (s) => s.replace(
      "if (Number.isFinite(expires) && expires <= now) errors.push('清单已过期');",
      "if (false) errors.push('清单已过期');"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: 'minVersion 校验被换成常量 —— 低于桥接版要求的旧版也会被放行',
    file: 'panel/lib/update-manifest.js',
    anchor: /compareVersions\(currentVersion, obj\.minVersion\)/g,
    count: 1,
    apply: (s) => s.replace(
      'compareVersions(currentVersion, obj.minVersion)',
      "compareVersions(currentVersion, '0.0.0')"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '允许 http —— 清单/安装包可被中间人替换（签名仍能挡，但协议被降级）',
    file: 'panel/lib/update-manifest.js',
    anchor: /if \(u\.protocol !== 'https:'\)/g,
    count: 1,
    apply: (s) => s.replace("if (u.protocol !== 'https:')", "if (u.protocol !== 'http:')"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '自动检查后直接调用 install —— 用户没点也会跑安装器',
    file: 'panel/lib/update.js',
    anchor: /const t = setTimeout\(async \(\) => \{\n        await check\(\{ manual: false \}\);\n        scheduleNextCheck\(\);\n      \}, 3000\);/g,
    count: 1,
    apply: (s) => s.replace(
      "      const t = setTimeout(async () => {\n        await check({ manual: false });\n        scheduleNextCheck();\n      }, 3000);",
      "      const t = setTimeout(async () => {\n        await check({ manual: false });\n        await install({ silent: true });\n        scheduleNextCheck();\n      }, 3000);"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: '取消下载不清 .part —— 残留残段可能被下一次续传拼进坏文件',
    file: 'panel/lib/update-download.js',
    anchor: /if \(signal\?\.aborted \|\| e\?\.code === 'ABORTED'\) \{\n          dropPart\(\);/g,
    count: 1,
    apply: (s) => s.replace(
      "        if (signal?.aborted || e?.code === 'ABORTED') {\n          dropPart();",
      "        if (signal?.aborted || e?.code === 'ABORTED') {\n          /* mutation: no cleanup */"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '把 4 条更新 POST 从 WRITE_ROUTES 摘掉 —— 绕过 token 与审计',
    file: 'panel/server.js',
    anchor: /  '\/api\/update\/check', '\/api\/update\/download', '\/api\/update\/cancel', '\/api\/update\/install',\n/g,
    count: 1,
    apply: (s) => s.replace(
      "  '/api/update/check', '/api/update/download', '/api/update/cancel', '/api/update/install',\n",
      '  // mutation: not classified\n'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M11',
    note: '把 update 控件从 schema 摘掉 —— 页面上没有更新入口',
    file: 'panel/next/schema.js',
    anchor: /              \{ t: 'update', id: 'upd' \},\n/g,
    count: 1,
    apply: (s) => s.replace("              { t: 'update', id: 'upd' },\n", '\n'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'C1',
    note: '对照组：只加一行注释，不应被拦截',
    file: 'panel/lib/update.js',
    anchor: /export function createUpdater\(deps = \{\}\) \{/g,
    count: 1,
    apply: (s) => s.replace(
      'export function createUpdater(deps = {}) {',
      '// control\nexport function createUpdater(deps = {}) {'
    ),
    layer: 'check-wb',
    expect: 'NOT-BLOCKED',
  },
];
