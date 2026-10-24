#!/usr/bin/env node
/**
 * CI 的四层回归入口（P3-5 · 2026-10-24）。
 *
 * 为什么不直接在 CI 里写 `npm run verify`：公开拷贝按设计没有 `scripts/publish-audit.mjs`，
 * 而 `verify` 的步骤里包含它。手抄第二份步骤清单会与 `package.json` 漂移，所以这里
 * **从 `package.json.scripts.verify` 派生**步骤，只允许跳过「发布拷贝 + 该脚本按设计不发布」
 * 这一种情况；其它任何缺失都 fail-closed。
 *
 * 用法：`node scripts/ci-verify.mjs [--json]`
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isPublishCopy, isHeldBackForGates } from './lib/publish-copy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const publishCopy = isPublishCopy(ROOT);
const steps = String(pkg.scripts && pkg.scripts.verify || '')
  .split(' && ')
  .map((s) => s.trim())
  .filter(Boolean);

if (!steps.length) {
  console.error('✗ package.json 的 verify 为空 —— 拒绝在空集合上给结论');
  process.exit(2);
}

const results = [];
/**
 * 公开拷贝没有 `config.json`（gitignored），而 `check:features` 里的假 QQ 真会话
 * 与 sandbox 的预设验收都需要一份带假凭据的配置。夹具只在缺失时复制进来，
 * 跑完删掉；不把夹具路径写进产品逻辑。
 */
const fixture = path.join(ROOT, 'test', 'fixtures', 'ci-config.json');
let createdConfig = false;
if (!fs.existsSync(path.join(ROOT, 'config.json')) && fs.existsSync(fixture)) {
  fs.copyFileSync(fixture, path.join(ROOT, 'config.json'));
  createdConfig = true;
  console.log('ℹ️ 没有 config.json：临时使用 test/fixtures/ci-config.json（跑完删除）');
}
const cleanupConfig = () => {
  if (!createdConfig) return;
  try { fs.rmSync(path.join(ROOT, 'config.json'), { force: true }); } catch { /* 尽力 */ }
};
const resetConfig = (cmd) => {
  if (!createdConfig) return;
  if (!/check:features|sandbox\.sh/.test(cmd)) return;
  fs.copyFileSync(fixture, path.join(ROOT, 'config.json'));
};
const stepEnv = {
  ...process.env,
  NODE_OPTIONS: '',
  // Linux 的 ephemeral 端口范围包含 39990–39997；smoke 的固定夹具端口在 Linux 上
  // 可能被内核先分给别的 socket（实测 Docker 里就撞过）。挪到 31000（低于 32768），
  // 让固定端口与临时端口不再同一区间。smoke 自身也改成基于 SMOKE_BASE_PORT 的偏移。
  QQBOT_SMOKE_BASE_PORT: process.env.QQBOT_SMOKE_BASE_PORT || '31000',
};
const missingTargets = (cmd) => {
  const out = [];
  for (const m of cmd.matchAll(/(?:^|\s)(?:node|bash)\s+([\w@./-]+\.(?:mjs|js|sh))/g)) {
    const rel = m[1];
    if (!fs.existsSync(path.join(ROOT, rel))) out.push(rel);
  }
  return out;
};

let failed = false;
for (const [i, raw] of steps.entries()) {
  const cmd = raw.replace(/^NODE_OPTIONS=\s*/, '');
  const missing = missingTargets(cmd);
  const onlyHeldBack = missing.length > 0 && missing.every((rel) => isHeldBackForGates(rel));
  if (missing.length) {
    if (publishCopy && onlyHeldBack) {
      console.log(`SKIP ${i + 1}/${steps.length} · ${missing.join('、')} 按设计不随公开拷贝发布`);
      results.push({ cmd, status: 'skipped', missing });
      continue;
    }
    console.error(`✗ ${i + 1}/${steps.length} · 缺文件且不是「发布拷贝 + held-back」：${missing.join('、')}`);
    failed = true;
    results.push({ cmd, status: 'missing', missing });
    break;
  }
  console.log(`\n── ${i + 1}/${steps.length} · ${cmd}`);
  resetConfig(cmd);
  const r = spawnSync('bash', ['-lc', cmd], {
    cwd: ROOT,
    stdio: 'inherit',
    env: stepEnv,
  });
  const status = r.status == null ? 1 : r.status;
  results.push({ cmd, status });
  if (status !== 0) {
    console.error(`✗ ${i + 1}/${steps.length} 退出码 ${status} —— CI 四层回归中止`);
    failed = true;
    break;
  }
}

const code = failed ? 1 : 0;
cleanupConfig();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ schema: 1, publishCopy, code, results }, null, 2));
}
console.log(code === 0
  ? `\n✓ CI 四层回归：${results.filter((r) => r.status === 0).length} 步通过 · ${results.filter((r) => r.status === 'skipped').length} 步按发布面跳过`
  : '\n✗ CI 四层回归未通过');
process.exit(code);
