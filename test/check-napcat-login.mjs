/**
 * 快速登录账号判据（2026-10-22）。
 *
 * 跑法：`node test/check-napcat-login.mjs`
 * 证据只有 NapCat 自己留下的 `napcat_<QQ>.json`；按 mtime 取最近登录的那个。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const PANEL = new URL('../panel/', import.meta.url).pathname;
const TOOLS = new URL('../packaging/windows/tools/', import.meta.url).pathname;
const { qqFromAccountFile, pickKnownAccount, knownAccountsByMtimeIn, resolveLoginQqIn } =
  await import(`${SRC}napcat-login.js`);

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; return; }
  fails.push(detail ? `${name} —— ${detail}` : name);
};

// ── ① 文件名判据 ────────────────────────────────────────────────────────
ok('标准登录记录', qqFromAccountFile('napcat_123456789.json') === '123456789');
ok('protocol 变体', qqFromAccountFile('napcat_protocol_987654321.json') === '987654321');
ok('不是登录记录 → 空', qqFromAccountFile('webui.json') === '' && qqFromAccountFile('napcat_12.json') === '');
ok('大小写不敏感', qqFromAccountFile('NAPCAT_123456.json') === '123456');

// ── ② mtime 取最近 ──────────────────────────────────────────────────────
ok('纯函数：按 mtime 取最大', pickKnownAccount([
  { qq: '111111', mtime: 100 },
  { qq: '222222', mtime: 300 },
  { qq: '333333', mtime: 200 },
]).qq === '222222');
ok('非法号被忽略', pickKnownAccount([{ qq: 'abc', mtime: 999 }, { qq: '123456', mtime: 1 }]).qq === '123456');
ok('空输入 → 空号', pickKnownAccount([]).qq === '' && pickKnownAccount(null).qq === '');

// ── ③ 目录扫描 ──────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-login-'));
try {
  const config = path.join(dir, 'config');
  fs.mkdirSync(config, { recursive: true });
  const a = path.join(config, 'napcat_111111.json');
  const b = path.join(config, 'napcat_222222.json');
  const c = path.join(config, 'webui.json');
  fs.writeFileSync(a, '{}'); fs.writeFileSync(b, '{}'); fs.writeFileSync(c, '{}');
  fs.utimesSync(a, new Date(1000), new Date(1000));
  fs.utimesSync(b, new Date(5000), new Date(5000));

  ok('目录扫描按 mtime 从新到旧', knownAccountsByMtimeIn(config)[0]?.qq === '222222');
  ok('目录扫描忽略非登录文件', knownAccountsByMtimeIn(config).length === 2);
  ok('resolve 取最近登录', resolveLoginQqIn(config).qq === '222222');
  ok('目录不存在 → 走二维码', resolveLoginQqIn(path.join(dir, 'nope')).qq === '');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ④ 接线（工具侧 / 面板侧共用同一判据）─────────────────────────────────
const common = fs.readFileSync(`${TOOLS}lib/common.mjs`, 'utf8');
ok('工具侧不再自己写 mtime 排序', !/out\.sort\(\(a, b\) => b\.mtime - a\.mtime\)/.test(common));
ok('工具侧调用共享叶子', /knownAccountsByMtimeIn/.test(common) && /resolveLoginQqIn/.test(common));
const server = fs.readFileSync(`${PANEL}server.js`, 'utf8');
ok('面板侧有唯一账号入口', /function knownLoginQq\(/.test(server) && /resolveLoginQqIn/.test(server));
ok('自启把号传下去', /startNativeNapcat\(\{ qq: login\.qq \}\)/.test(server));

if (fails.length) {
  console.log(`快速登录判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`快速登录判据：${pass} 项通过，0 项失败`);
console.log('  ✓ 文件名 / mtime / 目录扫描 / 工具与面板同源 都对得上');
