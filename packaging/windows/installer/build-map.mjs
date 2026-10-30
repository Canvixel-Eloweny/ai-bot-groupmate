/**
 * 安装器 stage ↔ ④ 便携包的显式路径映射（P3-5 · 2026-10-24）。
 *
 * 两种包的分发面不同：stage 只带面板/运行时/Electron/安装器入口，④ 还带
 * 便携启动器、docs、test、Mac .app 等。对账不能假设两棵树全等，也不该把
 * 差异藏进一段 "if 路径看起来差不多" 的启发式 —— 这里逐类写死。
 */
export const SHELL_FILES = new Set(['main.js', 'preload.js', 'error.html', 'package.json']);

/** stage 根上只属于安装器的文件（不要求和 ④ 同名存在）。 */
export const STAGE_ONLY_ROOT = new Set(['BUILD-INFO.txt', 'payload-manifest.json']);

/** stage 的路径 → ④ 的相对路径。 */
export function stageTarget(rel) {
  const p = String(rel);
  if (p === 'README.html') return { to: 'README-installed.html', kind: 'mapped' };
  if (p === 'LICENSE') return { to: 'app/LICENSE', kind: 'mapped' };
  if (p === 'THIRD-PARTY-NOTICES.md') return { to: 'app/docs/legal/THIRD-PARTY-NOTICES.md', kind: 'mapped' };
  if (p === 'resources/estrella-bot.ico') return { to: 'estrella-bot.ico', kind: 'mapped' };
  if (p === 'resources/update-pubkey.pem') return { kind: 'stage-only' };
  if (STAGE_ONLY_ROOT.has(p)) return { kind: 'stage-only' };
  if (p.startsWith('launcher/')) return { to: p.slice('launcher/'.length), kind: 'mapped' };
  if (p.startsWith('app/electron/')) {
    return SHELL_FILES.has(p.slice('app/electron/'.length))
      ? { to: p, kind: 'mapped' }
      : { kind: 'stage-only' };
  }
  if (p.startsWith('app/') || p.startsWith('tools/') || p.startsWith('runtime/node/')) {
    return { to: p, kind: 'mapped' };
  }
  return { kind: 'unexpected' };
}

/** ④ 根上允许存在、但 stage 不产的文件。 */
export const PORTABLE_ALLOW_ROOT = new Set([
  '1-SETUP.bat', '2-START.bat', '3-START-NAPCAT.bat', '4-DIAG.bat', '7-VERIFY.bat',
  'BUILD-INFO.txt', 'PUBLISH-PROVENANCE.json', 'README.html', 'README-installed.html',
  'SHA256SUMS.txt', 'launch-hidden.vbs', 'start-fake-chat.bat', '一键安装.bat',
  'Estrella-Bot.vbs', 'run-hidden.vbs', 'launch-napcat-hidden.vbs', 'estrella-bot.ico', 'estrella-bot-v5.ico',
]);

/** ④ app/ 根上允许存在、但 stage 只带其中一部分的文件。 */
export const PORTABLE_ALLOW_APP_ROOT = new Set([
  'README.md', 'docker-compose.yml',
]);

/** ④ 里按设计比 stage 多出来的子树（stage 只带白名单中的少量文件）。 */
export const PORTABLE_ALLOW_PREFIXES = [
  'app/.', 'app/docs/', 'app/test/', 'app/assets/', 'app/Estrella-Bot.app/', 'app/docker/',
  'app/persona/', 'app/plugins/', 'app/scripts/',
];

/**
 * 这些子树里 ④ 的每一个文件都必须能在 stage manifest 里找到；
 * 多出来 = ④ 漂移（不是"便携包多带了东西"那么简单）。
 */
export const PORTABLE_STRICT_PREFIXES = [
  'app/panel/', 'app/src/', 'app/node_modules/ws/', 'tools/', 'runtime/node/', 'app/electron/',
];

/** ④ 里这个路径属于哪一类：mapped / portable-only / unexpected。 */
export function portableKind(rel, mapped) {
  const p = String(rel);
  if (mapped.has(p)) return 'mapped';
  if (!p.includes('/') && PORTABLE_ALLOW_ROOT.has(p)) return 'portable-only';
  if (p.startsWith('app/') && PORTABLE_ALLOW_APP_ROOT.has(p.slice(4))) return 'portable-only';
  if (PORTABLE_ALLOW_PREFIXES.some((x) => p.startsWith(x))) return 'portable-only';
  return 'unexpected';
}
