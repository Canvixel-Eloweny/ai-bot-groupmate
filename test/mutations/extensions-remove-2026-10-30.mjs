const SRV = 'panel/server.js';
const INS = 'panel/lib/ext-install.js';

export default [
  {
    id: 'M1',
    note: 'planRemove 去掉 realpath 囚笼 —— §173③ 必须变红（目标可逃出扩展根）。预期 BLOCKED',
    file: INS,
    anchor: /if \(realTarget !== path\.join\(realRoot, dirName\)\) \{/,
    count: 1,
    apply: (s) => s.replace('if (realTarget !== path.join(realRoot, dirName)) {', 'if (false) {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '卸载 handler 开始信任客户端 dirName —— §173② 必须变红。预期 BLOCKED',
    file: SRV,
    anchor: /const plan = planRemove\(\{ item, kind, roots: extensionRoots\(USER_ROOT\) \}\);/,
    count: 1,
    apply: (s) => s.replace(
      'const plan = planRemove({ item, kind, roots: extensionRoots(USER_ROOT) });',
      'const plan = planRemove({ item: { ...item, dirName: String(body.dirName || item.dirName) }, kind, roots: extensionRoots(USER_ROOT) });'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '卸载跳过配置清理 —— §173④ 必须变红（启用名单还挂着空包）。预期 BLOCKED',
    file: SRV,
    anchor: /cfg\.custom = stripExtensionFromCustom\(cfg\.custom \|\| \{\}, kind, id\);/,
    count: 1,
    apply: (s) => s.replace('cfg.custom = stripExtensionFromCustom(cfg.custom || {}, kind, id);', 'cfg.custom = cfg.custom || {};'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
