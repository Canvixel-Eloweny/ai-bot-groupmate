// 扩展 ZIP 路径规范化与事务安装（2026-11-05 · 外部评估 P1）
//   ① 顶层 `.` 不得把扩展根当成包目录；
//   ② 规范化后重名（`p/plugin.json` vs `p/./plugin.json`、大小写别名）必须整包拒绝；
//   ③ 覆盖确认必须绑定服务端识别出的 id/kind/摘要；
//   ④ 拒绝发生在任何写入之前，同级扩展一个字节都不动。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalZipPath } from '../src/plugin-manifest.js';
import { planInstall, installArchive } from '../panel/lib/ext-install.js';
import { makeZip, readZip } from '../panel/lib/zip.js';

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${extra ? `  → ${extra}` : ''}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'estrella-ext-archive-'));
const plugins = path.join(tmp, 'plugins');
const skills = path.join(tmp, 'skills');
fs.mkdirSync(plugins, { recursive: true });
fs.mkdirSync(skills, { recursive: true });
const roots = [
  { dir: plugins, kind: 'plugin', name: 'plugins' },
  { dir: skills, kind: 'skill', name: 'skills' },
];
const manifest = (id) => JSON.stringify({ apiVersion: 1, id, name: id, version: '0.0.1', entry: 'index.js' });
const zip = (entries) => makeZip(entries);
// 走真实 readZip：测试覆盖安装口实际拿到的条目形状，而不是手捏对象。
const planZip = (entries) => planInstall(readZip(zip(entries)).entries, { roots });

// ── ① 规范化函数自身的边界 ────────────────────────────────────────────────
{
  const dot = canonicalZipPath('./plugin.json');
  ok('canonical：./plugin.json 去掉 . 段后只剩文件名',
    dot.ok === true && dot.segments.length === 1 && dot.segments[0] === 'plugin.json', JSON.stringify(dot));
  const nested = canonicalZipPath('p/./index.js');
  ok('canonical：包内 ./index.js 合法',
    nested.ok === true && nested.path === 'p/index.js', JSON.stringify(nested));
  const bad = [
    ['../x', '上跳'],
    ['/etc/passwd', '绝对'],
    ['C:\\windows\\x', '盘符'],
    ['p/a:b.js', 'ADS'],
    ['p/a.', '尾点'],
    ['p/a ', '尾空格'],
    ['p/con.js', '设备名'],
    ['p//a.js', '空段'],
  ];
  const badOk = bad.every(([p, why]) => {
    const r = canonicalZipPath(p);
    return r.ok === false && r.error;
  });
  ok('canonical：上跳/绝对/盘符/ADS/尾点/尾空格/设备名/空段全拒', badOk,
    bad.map(([p]) => `${p}=${canonicalZipPath(p).error || 'ACCEPT'}`).join(' · '));
}

// ── ② planInstall 的顶层与别名 ────────────────────────────────────────────
{
  const dotTop = planZip([{ name: './plugin.json', text: manifest('a') }, { name: './index.js', text: '' }]);
  ok('顶层 . 被拒绝（不会把扩展根当包）',
    !dotTop.ok && /多个顶层|包根下的文件|顶层目录名/.test(dotTop.error), dotTop.error);

  const nestedOk = planZip([
    { name: 'p/plugin.json', text: manifest('a') },
    { name: 'p/./index.js', text: 'export default {};' },
  ]);
  ok('包内 ./index.js 仍可安装', nestedOk.ok === true && nestedOk.pkgDir === 'p'
    && nestedOk.files.some((f) => f.rel === 'index.js'), JSON.stringify(nestedOk));

  const alias = planZip([
    { name: 'p/plugin.json', text: manifest('a') },
    { name: 'p/./plugin.json', text: manifest('b') },
  ]);
  ok('规范化后同名条目被整包拒绝', !alias.ok && /同一个路径/.test(alias.error), alias.error);

  const caseAlias = planZip([
    { name: 'p/plugin.json', text: manifest('a') },
    { name: 'p/Plugin.json', text: manifest('b') },
  ]);
  ok('大小写别名被整包拒绝', !caseAlias.ok && /同一个路径/.test(caseAlias.error), caseAlias.error);

  const multi = planZip([
    { name: 'a/plugin.json', text: manifest('a') },
    { name: 'b/index.js', text: '' },
  ]);
  ok('多顶层仍被拒绝', !multi.ok && /多个顶层/.test(multi.error), multi.error);

  const chinese = planZip([
    { name: '复读拦截/plugin.json', text: manifest('echo-guard') },
    { name: '复读拦截/./index.js', text: 'export default {};' },
  ]);
  ok('中文目录名 + 英文 id + 包内 ./ 入口保持可用',
    chinese.ok === true && chinese.pkgDir === '复读拦截' && chinese.id === 'echo-guard', JSON.stringify(chinese));
}

// ── ③ 真 IO：拒绝先于写入，同级扩展不动 ──────────────────────────────────
{
  const sibling = path.join(plugins, 'sibling');
  fs.mkdirSync(sibling, { recursive: true });
  const marker = path.join(sibling, 'keep.txt');
  fs.writeFileSync(marker, 'do not touch');

  const before = fs.readdirSync(plugins).sort().join(',');
  const attacked = installArchive({
    bytes: zip([{ name: './plugin.json', text: manifest('evil') }, { name: './index.js', text: 'x' }]),
    roots,
    overwrite: true,
  });
  const after = fs.readdirSync(plugins).sort().join(',');
  ok('./plugin.json 覆盖安装被拒绝且同级扩展原样',
    attacked.ok === false && fs.readFileSync(marker, 'utf8') === 'do not touch' && before === after,
    `${attacked.error} · ${before} -> ${after}`);

  const aliasAttack = installArchive({
    bytes: zip([
      { name: 'p/plugin.json', text: manifest('a') },
      { name: 'p/./plugin.json', text: manifest('b') },
    ]),
    roots,
    overwrite: true,
  });
  ok('别名包被拒绝且不产生包目录',
    aliasAttack.ok === false && !fs.existsSync(path.join(plugins, 'p')), aliasAttack.error);
}

// ── ④ 覆盖确认绑定 id / 摘要 ──────────────────────────────────────────────
{
  const v1 = zip([
    { name: 'demo/plugin.json', text: manifest('demo') },
    { name: 'demo/index.js', text: 'V1' },
  ]);
  const installed = installArchive({ bytes: v1, roots });
  ok('首次安装成功并返回摘要',
    installed.ok === true && /^[a-f0-9]{64}$/.test(installed.digest || ''), JSON.stringify(installed));

  const wrongId = installArchive({ bytes: v1, roots, overwrite: true, expectedId: 'other' });
  ok('覆盖时 id 不一致被拒（旧包未动）',
    wrongId.ok === false && wrongId.code === 409 && fs.readFileSync(path.join(plugins, 'demo', 'index.js'), 'utf8') === 'V1',
    JSON.stringify(wrongId));

  const wrongDigest = installArchive({
    bytes: v1, roots, overwrite: true, expectedId: 'demo', expectedDigest: '0'.repeat(64),
  });
  ok('覆盖时摘要不一致被拒（旧包未动）',
    wrongDigest.ok === false && wrongDigest.code === 409
      && fs.readFileSync(path.join(plugins, 'demo', 'index.js'), 'utf8') === 'V1',
    JSON.stringify(wrongDigest));

  const v2 = zip([
    { name: 'demo/plugin.json', text: manifest('demo') },
    { name: 'demo/index.js', text: 'V2' },
  ]);
  const digest2 = installArchive({ bytes: v2, roots, expectedId: 'demo', expectedDigest: installed.digest });
  ok('摘要不一致的替换包也被拒（防确认后换包）',
    digest2.ok === false && digest2.code === 409, JSON.stringify(digest2));

  const okDigest = installArchive({
    bytes: v2, roots, overwrite: true, expectedId: 'demo', expectedDigest: digest2.digest,
  });
  ok('id + 摘要一致时覆盖成功',
    okDigest.ok === true && fs.readFileSync(path.join(plugins, 'demo', 'index.js'), 'utf8') === 'V2',
    JSON.stringify(okDigest));
}

fs.rmSync(tmp, { recursive: true, force: true });

if (fails.length) {
  console.log(`扩展 ZIP 判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`扩展 ZIP 判据：${pass} 项通过，0 项失败`);
