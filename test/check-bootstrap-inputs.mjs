// Docker 源码回退输入（2026-11-05 · 外部评估 P2）
//   ① 四样输入齐全才允许 build：entrypoint.sh / templates/ / NapCat.Shell.zip / linuxqq.deb；
//   ② 缺项可自动补齐；补不齐时在 docker compose build 之前停止并列清单；
//   ③ fsize 在 GNU/BSD 两种 stat 下都能读字节数；bootstrap 调的是同一份检查。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${extra ? `  → ${extra}` : ''}`);
};

const srcDir = path.join(ROOT, 'docker', 'napcat');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'estrella-inputs-'));
fs.copyFileSync(path.join(srcDir, 'ensure-inputs.sh'), path.join(tmp, 'ensure-inputs.sh'));
fs.copyFileSync(path.join(srcDir, 'fsize.sh'), path.join(tmp, 'fsize.sh'));
const marker = path.join(tmp, 'called.log');
const fake = (name, body) => fs.writeFileSync(path.join(tmp, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
fs.writeFileSync(marker, '');

const run = (args = []) => spawnSync('bash', ['./ensure-inputs.sh', ...args], { cwd: tmp, encoding: 'utf8' });
const reset = () => {
  for (const f of ['entrypoint.sh', 'NapCat.Shell.zip', 'linuxqq.deb', 'called.log']) {
    try { fs.rmSync(path.join(tmp, f), { force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(path.join(tmp, 'templates'), { recursive: true, force: true }); } catch { /* ignore */ }
  fs.writeFileSync(marker, '');
};
const make = (f, body = 'x') => {
  if (f === 'templates/') fs.mkdirSync(path.join(tmp, 'templates'), { recursive: true }), fs.writeFileSync(path.join(tmp, 'templates', 'ws.json'), '{}');
  else fs.writeFileSync(path.join(tmp, f), body);
};
const all = () => { make('entrypoint.sh'); make('templates/'); make('NapCat.Shell.zip'); make('linuxqq.deb'); };
const called = () => fs.readFileSync(marker, 'utf8');

// 假抓取脚本：调用时写标记并按需创建文件。
fake('fetch-docker-assets.sh', `echo docker >> ${JSON.stringify(marker)}\necho x > entrypoint.sh\nmkdir -p templates\necho '{}' > templates/ws.json`);
fake('fetch-napcat.sh', `echo napcat >> ${JSON.stringify(marker)}\necho zip > NapCat.Shell.zip`);
fake('fetch-linuxqq.sh', `echo linuxqq >> ${JSON.stringify(marker)}\necho deb > linuxqq.deb`);

try {
  reset(); all();
  let r = run(['--no-fetch']);
  ok('四样齐全 → exit 0', r.status === 0 && /输入齐全/.test(r.stdout), `${r.status} ${r.stdout}`);

  reset(); make('NapCat.Shell.zip'); make('linuxqq.deb');
  r = run();
  ok('缺 entrypoint/templates → 自动补齐后通过',
    r.status === 0 && /docker/.test(called()) && fs.existsSync(path.join(tmp, 'entrypoint.sh'))
      && fs.existsSync(path.join(tmp, 'templates')),
    `${r.status} · ${r.stdout} · ${called()}`);

  reset(); make('entrypoint.sh'); make('templates/');
  r = run();
  ok('缺两个大文件 → 自动补齐后通过',
    r.status === 0 && /napcat/.test(called()) && /linuxqq/.test(called()),
    `${r.status} · ${called()}`);

  reset();
  r = run(['--no-fetch']);
  ok('--no-fetch 缺项：exit 1 且列全四项、不调用抓取脚本',
    r.status === 1 && ['entrypoint.sh', 'templates/', 'NapCat.Shell.zip', 'linuxqq.deb']
      .every((x) => r.stdout.includes(x)) && called().trim() === '',
    `${r.status} · ${r.stdout} · ${called()}`);

  reset();
  fs.writeFileSync(path.join(tmp, 'fetch-napcat.sh'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  r = run();
  ok('抓取失败：exit 1 且仍列缺项', r.status === 1 && r.stdout.includes('NapCat.Shell.zip'), `${r.status} ${r.stdout}`);

  // fsize：GNU/BSD 两种 stat 的参数在本机至少有一种可用；缺失文件返回 0。
  fs.writeFileSync(path.join(tmp, 'probe.bin'), 'hello');
  const fsRun = spawnSync('bash', ['-c', 'source ./fsize.sh; fsize probe.bin; fsize nope.bin'], { cwd: tmp, encoding: 'utf8' });
  ok('fsize：真实文件字节数正确、缺失文件为 0',
    fsRun.status === 0 && fsRun.stdout.trim().split('\n').join(',') === '5,0', `${fsRun.status} ${fsRun.stdout}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const boot = fs.readFileSync(path.join(ROOT, 'scripts', 'bootstrap.sh'), 'utf8');
const checkAt = boot.indexOf('bash ./ensure-inputs.sh');
const guardAt = boot.indexOf('ensure_build_inputs || return 1');
const buildAt = boot.indexOf('docker compose build napcat');
ok('bootstrap 在 build 之前调用同一份 ensure-inputs.sh',
  checkAt >= 0 && guardAt >= 0 && buildAt > guardAt,
  `def=${checkAt} guard=${guardAt} build=${buildAt}`);

const linux = fs.readFileSync(path.join(ROOT, 'docker', 'napcat', 'fetch-linuxqq.sh'), 'utf8');
const nap = fs.readFileSync(path.join(ROOT, 'docker', 'napcat', 'fetch-napcat.sh'), 'utf8');
ok('两个下载脚本都走可移植 fsize（不再只认 BSD stat）',
  /source \.\/fsize\.sh/.test(linux) && /source \.\/fsize\.sh/.test(nap)
  && !/stat -f%z/.test(linux + nap));

if (fails.length) {
  console.log(`Docker 回退输入判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`Docker 回退输入判据：${pass} 项通过，0 项失败`);
