/**
 * 安装中文路径（2026-10-31）的定向变异清单。
 *
 * 目标：验收 `check-wb` §174「安装事务目录复制不许用 fs.cpSync」真的会红。
 * 背景：安装器内嵌 Node 22.23.3，Windows 上源根路径含非 ASCII 时 `fs.cpSync`
 * 以 0xC0000409 直接终止进程（真机复现：`C:\Users\MoonEstrella\安装测试\Estrella-Bot 中文`），
 * 安装器只显示「安装失败」，`.txn.json` 停在 in_progress。
 * 复跑：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/install-unicode-1031.mjs`
 */

export default [
  {
    id: 'M1',
    note: 'copyDir 换回 fs.cpSync —— 中文安装目录会在第一步复制时硬崩（0xC0000409）',
    file: 'packaging/windows/tools/install-commit.mjs',
    anchor: /copyTreeSync\(src, dest\);/m,
    count: 1,
    apply: (s) => s.replace('copyTreeSync(src, dest);', 'fs.cpSync(src, dest, { recursive: true, force: true });'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '递归原语的叶子退回 fs.cpSync —— 名字还在、实现已崩（假绿形状）',
    file: 'packaging/windows/tools/lib/install-layout.mjs',
    anchor: /^  fs\.copyFileSync\(src, dest\);$/m,
    count: 1,
    apply: (s) => s.replace('  fs.copyFileSync(src, dest);', '  fs.cpSync(src, dest);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '安装期工具里再塞一个 fs.cpSync —— 同一类硬崩必须被静态门逮到',
    file: 'packaging/windows/tools/bootstrap.mjs',
    anchor: /^const has = \(\.\.\.names\) => names\.some\(\(n\) => process\.argv\.includes\(n\)\);$/m,
    count: 1,
    apply: (s) => s.replace(
      'const has = (...names) => names.some((n) => process.argv.includes(n));',
      "const has = (...names) => names.some((n) => process.argv.includes(n));\nconst __mutationCpSync = () => fs.cpSync('a', 'b');"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '删掉安装测试对 copyTreeSync 的绑定 —— 以后换实现没人发现',
    file: 'test/installer-p2.mjs',
    anchor: /copyTreeSync/g,
    count: 3,
    apply: (s) => s.replaceAll('copyTreeSync', 'copyTreeX'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '停止链的进程表回到 OEM 码页输出 —— 中文安装根在表里变 ?，旧壳永远停不掉',
    file: 'packaging/windows/tools/stop.mjs',
    anchor: /const ps = PS_UTF8_OUT \+ "\$ErrorActionPreference/m,
    count: 1,
    apply: (s) => s.replace('const ps = PS_UTF8_OUT + "$ErrorActionPreference', 'const ps = "$ErrorActionPreference'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: 'bridge-proc 的 node 进程查询去掉 UTF-8 前缀 —— 面板/机器人身份匹配在中文路径下失效',
    file: 'src/bridge-proc.js',
    anchor: /const WIN_PS_SCRIPT = PS_UTF8_OUT \+ /m,
    count: 1,
    apply: (s) => s.replace('const WIN_PS_SCRIPT = PS_UTF8_OUT + ', 'const WIN_PS_SCRIPT = '),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '面板进程快照去掉 UTF-8 前缀 —— 中文路径的命令行变 ?，实例数/停止判断全错',
    file: 'panel/server.js',
    anchor: /const ps = PS_UTF8_OUT \+ '\$os = Get-CimInstance/m,
    count: 1,
    apply: (s) => s.replace("const ps = PS_UTF8_OUT + '$os = Get-CimInstance", "const ps = '$os = Get-CimInstance"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '启动器的 legacy 面板归属查询去掉 UTF-8 前缀 —— 中文安装根认不出自己的旧面板',
    file: 'packaging/windows/tools/launcher.mjs',
    anchor: /\$\{PS_UTF8_OUT\}\(Get-CimInstance/m,
    count: 1,
    apply: (s) => s.replace('${PS_UTF8_OUT}(Get-CimInstance', '(Get-CimInstance'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
