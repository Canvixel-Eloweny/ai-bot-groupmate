// 扩展卸载判据（2026-10-31）：
//   ① 只信服务端扫描结果，客户端不能借 dirName 逃出扩展根；
//   ② 符号链接 / 缺清单 / 类型不符一律拒绝；
//   ③ 配置清理只动目标 id，另一类扩展与其它键不受影响；
//   ④ 更新时 expectedId 不一致必须在落盘前拒绝。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planRemove, removeExtension, stripExtensionFromCustom, installArchive,
} from '../panel/lib/ext-install.js';
import { makeZip } from '../panel/lib/zip.js';

let pass = 0;
const fails = [];
const ok = (name, cond) => {
  if (cond) { pass += 1; return; }
  fails.push(name);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'estrella-ext-remove-'));
const plugins = path.join(tmp, 'plugins');
const skills = path.join(tmp, 'skills');
fs.mkdirSync(plugins, { recursive: true });
fs.mkdirSync(skills, { recursive: true });
const roots = [
  { dir: plugins, kind: 'plugin', name: 'plugins' },
  { dir: skills, kind: 'skill', name: 'skills' },
];

function makePkg(root, dirName, manifest, id = 'demo') {
  const d = path.join(root, dirName);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, manifest), JSON.stringify({ id, name: id, version: '0.0.1', entry: 'index.js' }));
  fs.writeFileSync(path.join(d, 'index.js'), 'export default {};\n');
  return d;
}

const pluginDir = makePkg(plugins, 'demo-plugin', 'plugin.json', 'demo');
const pluginItem = { id: 'demo', dirName: 'demo-plugin', kind: 'plugin' };

// ── ① 路径安全 ───────────────────────────────────────────────────────────
const good = planRemove({ item: pluginItem, kind: 'plugin', roots });
ok('合法插件目录可以卸载', good.ok && good.target === pluginDir);

const traverse = planRemove({
  item: { id: 'demo', dirName: '../evil', kind: 'plugin' }, kind: 'plugin', roots,
});
ok('dirName 带 .. 被拒绝', !traverse.ok && /目录名不安全/.test(traverse.error));

const missing = planRemove({
  item: { id: 'demo', dirName: 'not-there', kind: 'plugin' }, kind: 'plugin', roots,
});
ok('不存在的目录被拒绝', !missing.ok && /不存在/.test(missing.error));

const noManifest = path.join(plugins, 'no-manifest');
fs.mkdirSync(noManifest, { recursive: true });
fs.writeFileSync(path.join(noManifest, 'index.js'), 'export default {};\n');
const noMan = planRemove({
  item: { id: 'no-manifest', dirName: 'no-manifest', kind: 'plugin' }, kind: 'plugin', roots,
});
ok('没有 plugin.json 的目标被拒绝', !noMan.ok && /plugin\.json/.test(noMan.error));

if (process.platform !== 'win32') {
  fs.symlinkSync(pluginDir, path.join(plugins, 'link-plugin'), 'dir');
  const link = planRemove({
    item: { id: 'demo', dirName: 'link-plugin', kind: 'plugin' }, kind: 'plugin', roots,
  });
  ok('符号链接目录被拒绝', !link.ok && /符号链接/.test(link.error));
} else {
  ok('符号链接目录被拒绝（Windows 跳过创建）', true);
}

// ── ② 删目录 ─────────────────────────────────────────────────────────────
const busy = removeExtension({
  target: pluginDir,
  io: { rmSync: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } },
});
ok('目录被占用时给出可读错误与停机器人提示',
  !busy.ok && /先停止机器人/.test(busy.error));

const rmOk = removeExtension({ target: pluginDir });
ok('正常情况下目录被删掉', rmOk.ok && !fs.existsSync(pluginDir));

// ── ③ 配置清理 ───────────────────────────────────────────────────────────
const custom = {
  extensions: {
    plugins: { enabled: ['demo', 'demo2'], settings: { demo: { mode: 'a' }, demo2: { mode: 'b' } } },
    skills: { enabled: ['sk1'], settings: { sk1: { voice: 'x' } } },
  },
  plugins: { enabled: ['demo', 'demo2', 'sk1'], settings: { demo: { mode: 'a' } } },
  memory: { manual: ['keep'] },
};
const afterPlugin = stripExtensionFromCustom(custom, 'plugin', 'demo');
ok('插件：启用名单只删目标 id',
  JSON.stringify(afterPlugin.extensions.plugins.enabled) === JSON.stringify(['demo2']));
ok('插件：目标设置被删、其它包设置保留',
  !('demo' in afterPlugin.extensions.plugins.settings)
  && afterPlugin.extensions.plugins.settings.demo2.mode === 'b');
ok('插件：Skill 命名空间不受影响',
  JSON.stringify(afterPlugin.extensions.skills.enabled) === JSON.stringify(['sk1'])
  && afterPlugin.extensions.skills.settings.sk1.voice === 'x');
ok('旧别名 plugins 同步删目标 id',
  JSON.stringify(afterPlugin.plugins.enabled) === JSON.stringify(['demo2', 'sk1']));
ok('其它 custom 键原样保留', JSON.stringify(afterPlugin.memory.manual) === JSON.stringify(['keep']));
ok('原对象未被原地修改', JSON.stringify(custom.extensions.plugins.enabled) === JSON.stringify(['demo', 'demo2']));

const afterSkill = stripExtensionFromCustom(custom, 'skill', 'sk1');
ok('Skill：只删 Skill 名单与设置',
  JSON.stringify(afterSkill.extensions.skills.enabled) === JSON.stringify([])
  && !('sk1' in afterSkill.extensions.skills.settings)
  && JSON.stringify(afterSkill.extensions.plugins.enabled) === JSON.stringify(['demo', 'demo2']));

// ── ④ 更新目标 id 校验 ───────────────────────────────────────────────────
const zip = makeZip([
  { name: 'demo-plugin/plugin.json', text: JSON.stringify({ apiVersion: 1, id: 'demo', name: 'Demo', version: '0.0.2', entry: 'index.js' }) },
  { name: 'demo-plugin/index.js', text: 'export default {};\n' },
]);
const wrong = installArchive({ bytes: zip, roots, expectedId: 'other' });
ok('expectedId 不一致时拒绝且不落盘',
  !wrong.ok && /不一致/.test(wrong.error) && !fs.existsSync(path.join(plugins, 'demo-plugin')));
const right = installArchive({ bytes: zip, roots, expectedId: 'demo' });
ok('expectedId 一致时正常安装', right.ok && fs.existsSync(path.join(plugins, 'demo-plugin')));

fs.rmSync(tmp, { recursive: true, force: true });

if (fails.length) {
  console.log(`扩展卸载判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`扩展卸载判据：${pass} 项通过，0 项失败`);
