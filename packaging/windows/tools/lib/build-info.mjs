/**
 * BUILD-INFO 的**唯一解析/写入实现**（P3-5 · 2026-10-24）。
 *
 * 安装器 payload 与 ④ 便携包都要写同形的一份；对账器只解析这一种格式。
 * 两份各写一套 `commit=` / `worktree=` 的后果是「对账时字段名对不上，
 * 而两边都打印成功」—— 本项目反复清过的那类静默漂移。
 *
 * 格式：一行标题 + 若干 `key=value`。`builtAt` 每次都不同，对账时显式忽略。
 */
import fs from 'node:fs';
import path from 'node:path';

export const BUILD_INFO_SCHEMA = 1;

const ORDER = [
  'schema', 'version', 'appId',
  'sourceCommit', 'sourceCommitShort', 'sourceWorktree',
  'buildCommit', 'buildRef', 'commit',
  'builtAt',
  'nodeRuntime', 'electronRuntime', 'electronFiles', 'electronBytes', 'ws',
  'listItems', 'scan', 'signing',
];

const cleanValue = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();

export function parseBuildInfo(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^([A-Za-z0-9_.-]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function readBuildInfo(file) {
  return parseBuildInfo(fs.readFileSync(file, 'utf8'));
}

export function writeBuildInfo(file, fields = {}) {
  const all = { schema: BUILD_INFO_SCHEMA, ...fields };
  const keys = [...ORDER.filter((k) => all[k] !== undefined && all[k] !== null),
    ...Object.keys(all).filter((k) => !ORDER.includes(k)).sort()];
  const lines = [
    'Estrella Bot · Windows 构建信息',
    '================================================================',
  ];
  for (const k of keys) lines.push(`${k}=${cleanValue(all[k])}`);
  lines.push('');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return parseBuildInfo(lines.join('\n'));
}

/** 取短哈希；输入已经是短的就原样返回。 */
export function shortCommit(commit) {
  const s = String(commit || '').trim();
  return /^[0-9a-f]{7,40}$/i.test(s) ? s.slice(0, 7) : s;
}
