/**
 * 日流水（`src/day-log.js`）判据（2026-10-22 · C4）。
 *
 * 跑法：`node test/check-day-log.mjs`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const { MAX_LINE_TEXT, stampOf, safeChatDir, dayLogPath, appendDayLog, dayLogTextOf, dayLogTextRecent } =
  await import(`${SRC}day-log.js`);
const { dayKeyOf } = await import(`${SRC}holidays.js`);

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; return; }
  fails.push(detail ? `${name} —— ${detail}` : name);
};

const now = Date.parse('2026-10-22T21:03:00');
ok('本地日期键', dayKeyOf(new Date(now)) === '2026-10-22');
ok('时间戳', stampOf(now) === '21:03');
ok('会话键安全化（Windows 不允许冒号）', safeChatDir('group:123') === 'group_123');
ok('日文件按群/日期分', dayLogPath('/x', 'group:123', now).endsWith(`/daylog/group_123/2026-10-22.raw.md`));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daylog-'));
try {
  ok('写入一行', appendDayLog(root, 'group:123', { who: '老张', text: '今天吃啥' }, now) === true);
  ok('多行压成一行', appendDayLog(root, 'group:123', { who: '小李', text: '第一行\n第二行' }, now) === true);
  ok('纯图片占位不占行', appendDayLog(root, 'group:123', { who: '小王', text: '[图片]' }, now) === false);
  ok('空文本不占行', appendDayLog(root, 'group:123', { who: '小王', text: '   ' }, now) === false);
  const text = dayLogTextOf(root, 'group:123', now);
  ok('读回两行', text.split('\n').length === 2, text);
  ok('带时间与说话人', /- \[21:03\] 老张：今天吃啥/.test(text) && /小李：第一行 第二行/.test(text));
  ok('超长截断', appendDayLog(root, 'group:123', { who: '长', text: 'x'.repeat(500) }, now) === true
    && dayLogTextOf(root, 'group:123', now).includes('x'.repeat(MAX_LINE_TEXT)));

  // 夜岗在凌晨跑时"今天"是新的一天，昨晚的流水在昨天文件里。
  appendDayLog(root, 'group:999', { who: '昨天', text: '昨晚的聊天' }, now - 86400000);
  ok('最近日流水能回退到昨天', dayLogTextRecent(root, 'group:999', now).includes('昨晚的聊天'));
  ok('今天没有就回退昨天（不返回空）', dayLogTextRecent(root, 'group:999', now).includes('昨晚的聊天'));

  const index = fs.readFileSync(`${SRC}index.js`, 'utf8');
  ok('入站落流水接线', /appendDayLog\(DATA_DIR, session\.key/.test(index));
  ok('夜间产出优先读最近日流水', /dayLogTextRecent\(DATA_DIR, key\)/.test(index));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (fails.length) {
  console.log(`日流水判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`日流水判据：${pass} 项通过，0 项失败`);
console.log('  ✓ 日期/时间/安全键/占位跳过/截断/入站与夜间接线 都对得上');
