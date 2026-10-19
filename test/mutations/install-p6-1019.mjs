/**
 * P6「NapCat 获取与离线放包」（2026-10-19 批次号沿用开工日 2026-10-18 的命名法）的定向变异清单。
 *
 * 目标：验收 `check-wb` §114 真的会红，而不是一条漂亮的空断言。
 * 复跑：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/install-p6-1019.mjs`
 *
 * 这一批的病根写在 §114 的头注释里：安装器在 nsExec 里同步下载，NSIS 进度条不会推进，
 * 于是"一条没有超时的 fetch"在用户屏幕上就叫做卡死。**每条变异都对应一次真实的写法退化**，
 * 不是为了让数量好看而编的。
 */

export default [
  {
    id: 'M1',
    note: '把"逐块重挂空闲计时"删掉 —— 连上了但不再发数据的镜像（实测 46,919 B/s 那一档、25 秒只拉到 1.17MB）就再也看不出来，安装器挂着不动',
    file: 'packaging/windows/tools/lib/common.mjs',
    anchor: /armStall\(\); \/\/ 活着就重新计时/m,
    count: 1,
    apply: (s) => s.replace(/armStall\(\); \/\/ 活着就重新计时/, '; // mutation: no per-chunk re-arm'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '不读 content-range 就接受 206 —— 服务端记的是另一份内容时，残段会被接到一起，得到一个哈希对不上的文件',
    file: 'packaging/windows/tools/lib/common.mjs',
    anchor: /const cr = res\.headers\.get\('content-range'\) \|\| '';/m,
    count: 1,
    apply: (s) => s.replace(
      "const cr = res.headers.get('content-range') || '';",
      "const cr = '';"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2P',
    note: '同一条退化发生在面板更新器里 —— §114 必须同时盯着两个下载口，否则"只测安装侧"等于半个闸',
    file: 'panel/lib/update-download.js',
    anchor: /const cr = res\.headers\.get\('content-range'\) \|\| '';/m,
    count: 1,
    apply: (s) => s.replace(
      "const cr = res.headers.get('content-range') || '';",
      "const cr = '';"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '先改名后算哈希 —— 校验不过时那份没验过的 35MB 已经躺在目标路径上，下一次运行会被当成"已下好"',
    file: 'packaging/windows/tools/lib/common.mjs',
    anchor: /const gotHex = sha256File\(part\);/m,
    count: 1,
    apply: (s) => s.replace(
      'const gotHex = sha256File(part);',
      'fs.renameSync(part, dest); const gotHex = sha256File(dest);'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: 'fallbackSha256 与 knownGood 各说一套 —— 兜底那版根本不在表里时，"兜底"就变成了一次没有校验的下载',
    file: 'packaging/windows/tools/napcat.json',
    anchor: /"fallbackSha256": "[0-9a-f]{64}",/m,
    count: 1,
    apply: (s) => s.replace(
      '4b8e20e6d22288586d99eb0b34fff6c7ee1d88b00353039326f8c459a86df667',
      '1111111111111111111111111111111111111111111111111111111111111111'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '把面板口的空闲超时改成 0（"这样就不会误杀了"）—— 0 不是没有超时，是立刻中止/永不中止取决于实现，两种都毁掉上限',
    file: 'panel/lib/update-download.js',
    anchor: /export const IDLE_TIMEOUT_MS = 30_000;/m,
    count: 1,
    apply: (s) => s.replace('export const IDLE_TIMEOUT_MS = 30_000;', 'export const IDLE_TIMEOUT_MS = 0;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '冒出第三个下载口（复制粘贴一份改改就能用）—— 这正是 single-entry 历来没有机器判据的那一格',
    file: 'packaging/windows/tools/lib/common.mjs',
    anchor: /function fmtEta\(sec\) \{/m,
    count: 1,
    apply: (s) => s.replace(
      'function fmtEta(sec) {',
      'export async function downloadExtra(urls, dest) { return downloadWithMirrors(urls, dest, {}); }\nfunction fmtEta(sec) {'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: 'assetMinBytes 退到 1000 —— 994,134 字节的 NapCat.Shell.Windows.OneKey.zip 是安装器壳不是协议端，尺寸地板是唯一拦得住它的东西',
    file: 'packaging/windows/tools/napcat.json',
    anchor: /"assetMinBytes": 8000000,/m,
    count: 1,
    apply: (s) => s.replace('"assetMinBytes": 8000000,', '"assetMinBytes": 1000,'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '关掉 bootstrap 的本地件分支 —— "我已经有包"重新变成必须先问 GitHub，离线机器又回到白等超时',
    file: 'packaging/windows/tools/bootstrap.mjs',
    anchor: /mode === 'zip' \|\| mode === 'folder'/m,
    count: 1,
    apply: (s) => s.replace("mode === 'zip' || mode === 'folder'", "mode === 'zip-disabled'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: '把路径判据换成手搓的 startsWith —— 相等不算 inside、大小写、盘根、UNC 全漏，正是"选到 NAPCAT_DIR 自己"那一类 bug 的来源',
    file: 'packaging/windows/tools/lib/napcat-local.mjs',
    anchor: /import \{ pathEq, pathInside \} from '\.\/install-layout\.mjs';/m,
    count: 1,
    apply: (s) => s.replace(
      "import { pathEq, pathInside } from './install-layout.mjs';",
      "const pathEq = (a, b) => String(a) === String(b);\nconst pathInside = (c, p) => String(c).toLowerCase().startsWith(String(p).toLowerCase());"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '装完顺手删用户带来的原件 —— 一次误点就不可逆，而"只复制"是本功能唯一的可逆保证',
    file: 'packaging/windows/tools/lib/napcat-local.mjs',
    anchor: /const sha = sha256File\(abs\);/m,
    count: 1,
    apply: (s) => s.replace(
      'const sha = sha256File(abs);',
      'const sha = sha256File(abs); fs.rmSync(abs, { force: true }); // mutation: tidy up the user\'s file'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M11',
    note: '把 findNapcatLauncher 的 dir 参数拿掉 —— 暂存目录就没法先验形状再提交，等于回到"先落盘再说"',
    file: 'packaging/windows/tools/lib/common.mjs',
    anchor: /export function findNapcatLauncher\(dir = NAPCAT_DIR\) \{/m,
    count: 1,
    apply: (s) => s.replace('export function findNapcatLauncher(dir = NAPCAT_DIR) {', 'export function findNapcatLauncher() {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M12',
    note: '本地件优先被关掉（`if (false)`）—— 手放的包不再被认，非兜底版本又要被按兜底哈希判死',
    file: 'packaging/windows/tools/lib/repair.mjs',
    anchor: /^    if \(exists\(NAPCAT_ZIP\)\) \{/m,
    count: 1,
    apply: (s) => s.replace('    if (exists(NAPCAT_ZIP)) {', '    if (false) {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M13',
    note: '安装器把协议端默认改回"下载" —— 慢网络下人人默认中一次 2.6-12.7 分钟的"看起来卡死"',
    file: 'packaging/windows/installer/Estrella-Bot.nsi',
    anchor: /StrCpy \$NapcatMode "skip"\n  StrCpy \$NapcatPath ""/m,
    count: 1,
    apply: (s) => s.replace('StrCpy $NapcatMode "skip"\n  StrCpy $NapcatPath ""', 'StrCpy $NapcatMode "auto"\n  StrCpy $NapcatPath ""'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M14',
    note: '给"联网下载"那颗复选框加默认勾选 —— check-nsi 与 §114 两头都得红',
    file: 'packaging/windows/installer/Estrella-Bot.nsi',
    anchor: /\$\{NSD_CreateCheckbox\} 0 108u/m,
    count: 2,
    apply: (s) => s.replace(
      '${NSD_CreateCheckbox} 0 108u',
      '${NSD_Check} $CheckAutoNapcat\n  ${NSD_CreateCheckbox} 0 108u'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M15',
    note: '构建脚本又抄一份启动器正则 —— 官方改名时 tools 认得、构建脚本认不得，红了会被读成"包坏了"',
    file: 'packaging/windows/make-vm-copy.mjs',
    anchor: /if \(isNapcatLauncherName\(name\)\) return true;/m,
    count: 1,
    apply: (s) => s.replace(
      'if (isNapcatLauncherName(name)) return true;',
      "if (/^launcher[\\w-]*\\.bat$/i.test(name) || /^NapCatWinBootMain\\.exe$/i.test(name)) return true;"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M16',
    note: '把 napcat-local.mjs 从 SHA256SUMS 点名清单里摘掉 —— 包内那份是旧的也不会有人报，症状是"改了没生效"',
    file: 'packaging/windows/make-sums.py',
    anchor: /"tools\/lib\/napcat-local\.mjs",/m,
    count: 1,
    apply: (s) => s.replace('    "tools/lib/napcat-local.mjs",\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M17',
    note: '把选包对话框的初始目录改回不存在的 $DOWNLOADS —— makensis 只打警告（6000）、EXE 照出，初始目录静默变空',
    file: 'packaging/windows/installer/Estrella-Bot.nsi',
    anchor: /"\$PROFILE\\Downloads"/g,
    count: 1,
    apply: (s) => s.replaceAll('"$PROFILE\\Downloads"', '"$DOWNLOADS"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M18',
    note: '在 .onInit 里加回“静默就强制 skip”的兜底 —— 静默安装下 /NAPCATZIP= / /NAPCATFOLDER= 被覆盖，离线选包整条失效',
    file: 'packaging/windows/installer/Estrella-Bot.nsi',
    anchor: /  ; Do NOT add a silent-mode fallback here/g,
    count: 1,
    apply: (s) => s.replace('  ; Do NOT add a silent-mode fallback here', '  IfSilent isSilent\n  isSilent:\n    StrCpy $NapcatMode "skip"\n  notSilent:\n  ; Do NOT add a silent-mode fallback here'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M19',
    note: '去掉 GetOptions 返回值的前导 = 剥离 —— 路径变成 =C:\\...，静默离线选包必被拒（VM 实测 REFUSED）',
    file: 'packaging/windows/installer/Estrella-Bot.nsi',
    anchor: /StrCpy \$R1 \$R1 "" 1/g,
    count: 4,
    apply: (s) => s.replaceAll('      StrCpy $R1 $R1 "" 1\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M20',
    note: '把首装默认 launch.mode 改回 window —— Edge --app 独立窗口首跑必出灰色空窗（群友测试原话：还得再双击一次）',
    file: 'packaging/windows/tools/bootstrap.mjs',
    anchor: /mode: 'browser'/g,
    count: 1,
    apply: (s) => s.replace("mode: 'browser'", "mode: 'window'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'C1',
    note: '对照组：只加一行注释，不应被拦截',
    file: 'src/user-root.js',
    anchor: /export const PROGRAM_ROOT/m,
    count: 1,
    apply: (s) => s.replace('export const PROGRAM_ROOT', '// control\nexport const PROGRAM_ROOT'),
    layer: 'check-wb',
    expect: 'NOT-BLOCKED',
  },
];
