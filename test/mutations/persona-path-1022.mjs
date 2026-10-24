/**
 * P1 人设路径回归（2026-10-22）的变异清单。
 *
 * 修复前：`loadPersona` 直接 `path.resolve(PERSONA_DIR, relFile)`，而配置与 README
 * 写的是 `persona/qq-chat.md` ⇒ 实际读 `<userRoot>/persona/persona/qq-chat.md`，
 * 文件存在也读不到，机器人静默使用空人设。T421 用两种历史路径 + 一条 `../`
 * 越界路径把这件事钉住。
 *
 * 这条变异把 resolver 退回旧行为（只认 `<personaDir>/<relFile>`），
 * T421 必须变红；否则说明测试没有真的盯住路径解析。
 *
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/persona-path-1022.mjs`
 * ⚠️ 串行；会改写真实工作树。
 */

const FILE = 'src/user-root.js';
const ANCHOR = /export function resolvePersonaFile\(relFile, \{ personaDir = ROOTS\.personaDir, exists = fs\.existsSync \} = \{\}\) \{[\s\S]*?\n\}/;

export default [
  {
    id: 'M1',
    note: '把 resolvePersonaFile 退回旧行为（只认 personaDir/relFile）—— T421 必须变红。预期 BLOCKED',
    file: FILE,
    anchor: ANCHOR,
    count: 1,
    apply: (s) => s.replace(
      ANCHOR,
      'export function resolvePersonaFile(relFile, { personaDir = ROOTS.personaDir, exists = fs.existsSync } = {}) {\n'
      + "  const raw = String(relFile ?? '').trim();\n"
      + "  if (!raw) return '';\n"
      + '  const file = path.resolve(personaDir, raw);\n'
      + '  return exists(file) ? file : "";\n'
      + '}'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
];
