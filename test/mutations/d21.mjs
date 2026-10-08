/**
 * D21（扩展包 ZIP 导入）的变异清单 —— 纯数据，供
 * `node scripts/mutate.mjs test/mutations/d21.mjs` 复跑。
 *
 * 为什么每一步都要配变异：这一批**处理的是别人给的二进制**，失效形态全都"不报错"——
 *   · 少一条路径判据 → 一个 `../` 就把文件写到扩展包目录外面（而面板列表看起来正常）；
 *   · 上限失效 → 大包直接进内存 / 解压炸弹把磁盘写满；
 *   · 装完顺手启用 → **别人的代码**第一次被执行，而用户以为"只是装了个包"；
 *   · staging 没进清扫面 → 每次安装留垃圾，还被扫成"坏包"显示出来；
 *   · crc32 两份 → 自己打的包自己读不出，而两边各自看起来都对；
 *   · 覆盖不确认 → 一个同名包把用户原有的覆盖掉，没有回滚点。
 *
 *   | 组  | 打的是 | 该由哪一层拦住 |
 *   |---|---|---|
 *   | M1  | 条目不过路径安全判据 | check-wb §49 ③ + smoke T316 |
 *   | M2  | 上传上限失效（大包进内存） | check-wb §49 ④ |
 *   | M3  | 已存在也直接覆盖（不确认） | check-wb §49 ② + smoke T318 |
 *   | M4  | 装完顺手把包启用 | check-wb §49 ⑦（反向，最值钱的一条） |
 *   | M5  | 清扫改回不带 recursive（临时目录永远清不掉） | check-wb §49 ④ |
 *   | M6  | 自写一份 `..` 判据 | check-wb §49 ③（反向） |
 *   | M7  | server.js 再写一份 crc32 | check-wb §49 ① |
 *   | M8  | 上传改走 base64 + readBody（撞 1MB 上限） | check-wb §49 ② |
 *   | M9  | listSubdirs 不跳过点目录（staging 被当坏包） | check-wb §49 ④ |
 *   | M10 | 判定卡不再分派到专用卡（Q10 回退成"没人画"） | check-wb §49 ⑩ |
 *
 * 期望：十条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️ 跑这一批时若看到 `[safe-delete]`，那是**沙箱的批量删除保护**在冒充"被拦住"
 *    （不是断言失败）—— 换前台 + 非沙箱复跑同一组再下结论（R33/R34/R36 同款）。
 * ⚠️ 另：本机 shell 注入的 `NODE_OPTIONS` 会把 `err.code` 改写成 `CODEBUDDY_BROKER_DENY`
 *    （D17 批实测：T293/T296 因此假红）—— 跑测试要 `NODE_OPTIONS= node …`。
 */

export default [
  {
    id: 'M1',
    note: '条目不过路径安全判据（一个 `../` 就能写到扩展包目录之外）',
    file: 'panel/lib/ext-install.js',
    anchor: /if \(!isSafeRelPath\(e\.name\)\) return/,
    count: 1,
    apply: (s) => s.replace(
      'if (!isSafeRelPath(e.name)) return',
      'if (false) return'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '上传上限失效（大包直接进内存 —— 护内存的那个量没了）',
    file: 'panel/lib/zip.js',
    anchor: /^export const ZIP_UPLOAD_MAX = 4 \* 1024 \* 1024;$/m,
    count: 1,
    apply: (s) => s.replace(
      'export const ZIP_UPLOAD_MAX = 4 * 1024 * 1024;',
      'export const ZIP_UPLOAD_MAX = Number.MAX_SAFE_INTEGER; // 变异：上限失效'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '同名包直接覆盖、不要求显式确认（用户的旧包被无声顶掉，没有回滚点）',
    file: 'panel/lib/ext-install.js',
    anchor: /^  if \(exists && !overwrite\) \{$/m,
    count: 1,
    apply: (s) => s.replace(
      '  if (exists && !overwrite) {',
      '  if (false) { // 变异：不确认就覆盖'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '装完**顺手把包装启用**（别人的代码第一次被执行，而用户以为只是装了个包）',
    file: 'panel/server.js',
    // ⚠️ 第 15 轮（H-10 路由表化）：安装路由从 createServer 回调的 if 链搬成模块级
    //    handler `apiExtensionsInstall`，体只统一缩进（6 → 2 空格）—— 锚点跟着搬。
    anchor: /^ {2}const cfgNow = readConfig\(\) \|\| \{\};$/m,
    count: 1,
    apply: (s) => s.replace(
      '  const cfgNow = readConfig() || {};',
      '  const cfgNow = readConfig() || {};\n'
        + '  (cfgNow.custom.plugins.enabled = cfgNow.custom.plugins.enabled || []).push(r.id); // 变异：装完自动启用'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '清扫改回不带 recursive（临时**目录**永远清不掉，每次启动刷一条 warn）',
    file: 'src/atomic-write.js',
    anchor: /^        fs\.rmSync\(full, \{ recursive: true, force: true \}\);$/m,
    count: 1,
    apply: (s) => s.replace(
      '        fs.rmSync(full, { recursive: true, force: true });',
      '        fs.rmSync(full, { force: true }); // 变异：目录删不掉'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '自己写一份 `..` 判据（与 plugin-manifest 那份必然漂：`..foo.js` 是合法文件名）',
    file: 'panel/lib/ext-install.js',
    anchor: /^  for \(const e of files0\) \{$/m,
    // ⚠️ 这个形状在文件里出现**两次**（安全校验循环 / 组装相对路径循环），
    //    锚点数必须写 2；`apply` 的 `replace` 只改**第一处**（安全那一处）。
    count: 2,
    apply: (s) => s.replace(
      '  for (const e of files0) {',
      "  for (const e of files0) {\n    if (e.name.includes('..')) return { ok: false, error: '越界' }; // 变异：自写一份判据"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: 'server.js 里再写一份 crc32（两份必然漂，而漂的表现是"自己打的包自己读不出"）',
    file: 'panel/lib/audit-log.js',
    anchor: /^const AUDIT_MAX = 500;$/m,
    count: 1,
    apply: (s) => s.replace(
      'const AUDIT_MAX = 500;',
      'function crc32(buf) { return 0; } // 变异：第二份 CRC32\nconst AUDIT_MAX = 500;'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '上传改走 base64 + readBody（包被放大 33%，必然撞 1MB 上限）',
    file: 'panel/server.js',
    anchor: /const got = await readBodyBuffer\(req, \{ maxBytes: ZIP_UPLOAD_MAX \}\);/,
    count: 1,
    apply: (s) => s.replace(
      'const got = await readBodyBuffer(req, { maxBytes: ZIP_UPLOAD_MAX });',
      "const got = { ok: true, buf: Buffer.from(String((await readBody(req)).z || ''), 'base64') }; // 变异：base64"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: 'listSubdirs 不跳过点目录（安装留下的 staging 会被扫成"坏包"显示在面板上）',
    file: 'src/plugin-host.js',
    anchor: /    \.filter\(\(e\) => !e\.name\.startsWith\('\.'\)/,
    count: 1,
    apply: (s) => s.replace(
      "    .filter((e) => !e.name.startsWith('.')",
      '    .filter((e) => true // 变异：不跳过点目录'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '判定卡不再分派到专用标签（Q10 回退成"后端落了卡但没人画"）。⚠️ S-12 第五批：目标从旧页 judgeHtml 改到现役页 app.js 的两处 r.kind === judge',
    file: 'panel/next/app.js',
    anchor: /r\.kind === 'judge'/,
    count: 4,
    apply: (s) => s.replaceAll("r.kind === 'judge'", "r.kind === 'judgeX'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
