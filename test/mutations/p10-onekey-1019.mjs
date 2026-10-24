/**
 * P10「桌面图标一键起全套 / 安装版 README / Windows 不跌 Docker」门禁的定向变异（2026-10-19）。
 * 群友回执原话：「一键启动在哪？我没找到」+ 截图里冒出的「没找到 Docker Desktop」。
 * 这几条证明 §114 的新判据真会红。
 */
export default [
  {
    id: 'M32',
    note: '安装版 payload 改回拷便携 README —— 群友又会照着 README 找不存在的「一键安装.bat」',
    file: 'packaging/windows/installer/make-installer-payload.mjs',
    anchor: /copyFile\(path\.join\(REPO, 'packaging', 'windows', 'launcher', 'README-installed\.html'\), path\.join\(out, 'README\.html'\)\);/g,
    count: 1,
    apply: (s) => s.replace("'launcher', 'README-installed.html')", "'launcher', 'README.html')"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M33',
    note: '摘掉面板启动时的协议端自起 —— 桌面图标又只管控制台，NapCat 要用户自己想办法',
    file: 'panel/server.js',
    anchor: /void autoStartNapcatIfInstalled\(\);/,
    count: 1,
    apply: (s) => s.replace('void autoStartNapcatIfInstalled();', ';'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M34',
    note: '「协议端未安装」守卫不再 return —— Windows 又跌进容器分支，冒出「没找到 Docker Desktop」',
    file: 'panel/server.js',
    anchor: /return sendJson\(res, \{ ok: false, output: m \}, 400\);/g,
    count: 1,
    apply: (s) => s.replace('    return sendJson(res, { ok: false, output: m }, 400);\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M35',
    note: '换二维码的提示改回「先双击一键安装.bat」—— 安装版根目录里根本没有这个文件',
    file: 'panel/server.js',
    anchor: /读不到 NapCat 的 token —— 协议端未安装：打开「总览 → 运行 → 运行状态」/g,
    count: 1,
    apply: (s) => s.replace(
      "        ? (MODE === 'installed'\n          ? '读不到 NapCat 的 token —— 协议端未安装：打开「总览 → 运行 → 运行状态」，点『自动查找并安装』；找不到就点『打开协议端文件夹』把文件拖进去'\n          : '读不到 NapCat 的 token —— 协议端还没装好（先双击「一键安装.bat」）')",
      "        ? '读不到 NapCat 的 token —— 协议端还没装好（先双击「一键安装.bat」）'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M36',
    note: '给同步永不抛的 maybeSyncModelCatalog 再挂 .catch —— 真机每次启动红一条未处理拒绝（VM 日志亲见）',
    file: 'panel/server.js',
    anchor: /if \(!SANDBOX\) setImmediate\(\(\) => maybeSyncModelCatalog\(\)\);/g,
    count: 1,
    apply: (s) => s.replace('if (!SANDBOX) setImmediate(() => maybeSyncModelCatalog());', 'if (!SANDBOX) maybeSyncModelCatalog().catch(() => {});'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'C1',
    note: '对照组：只给自起函数加一行注释，不应被拦截',
    file: 'panel/server.js',
    anchor: /async function autoStartNapcatIfInstalled\(\) \{\n/g,
    count: 1,
    apply: (s) => s.replace('async function autoStartNapcatIfInstalled() {\n', 'async function autoStartNapcatIfInstalled() {\n  // p10 control\n'),
    layer: 'check-wb',
    expect: 'NOT-BLOCKED',
  },
];
