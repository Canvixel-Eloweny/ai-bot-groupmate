import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_LINES = 2000;

function probeFile() {
  return process.env.QQBOT_FORWARD_PROBE_FILE
    ? path.resolve(process.env.QQBOT_FORWARD_PROBE_FILE)
    : path.join(ROOT, 'panel', 'forward-probe.jsonl');
}

function summarize(seg) {
  const data = seg?.data ?? {};
  const type = seg?.type;
  if (type === 'forward') {
    return {
      kind: 'forward',
      hasId: 'id' in data,
      idPreview: String(data.id ?? '').slice(0, 64),
    };
  }
  if (type === 'node') {
    const content = data.content;
    const nodes = Array.isArray(content) ? content : [];
    return {
      kind: 'node',
      name: String(data.name ?? '').slice(0, 64),
      uin: String(data.uin ?? data.qq ?? '').slice(0, 32),
      nodeCount: nodes.length,
      hasNestedForward: nodes.some((s) => s?.type === 'forward' || s?.type === 'node'),
      preview: nodes.slice(0, 3).map((s) => ({
        type: s?.type,
        text: String(s?.data?.text ?? '').slice(0, 120),
      })),
    };
  }
  return { kind: type, keys: Object.keys(data).slice(0, 10) };
}

export function probeForwardSegment(seg) {
  try {
    const file = probeFile();
    const line = JSON.stringify({ ts: Date.now(), ...summarize(seg) }) + '\n';
    fs.appendFileSync(file, line);
    maybeRotate(file);
  } catch {
    /* 探针失败不影响主流程 */
  }
}

function maybeRotate(file) {
  try {
    const stats = fs.statSync(file);
    if (stats.size < 64 * 1024) return;
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    const half = lines.slice(Math.floor(lines.length / 2));
    fs.writeFileSync(file, half.join('\n') + '\n');
  } catch {
    /* ignore */
  }
}
