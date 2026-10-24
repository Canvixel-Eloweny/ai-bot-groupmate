/**
 * 25 插件端到端验收（2026-10-23）。
 *
 * 验的不是"插件代码写对了"，而是**宿主这一侧的接线**：
 *   · 25 个启用项真的全部 loaded（不再是第 21 个被静默截断）；
 *   · 每个包的 `after-incoming-message` 都收到了一次真实入站消息（带 chatKey/senderId/media）；
 *   · `tools.max` 生效时失败原因可见；
 *   · `plugins.max=20` 时 5 个 over、20 个 loaded。
 *
 * 跑法：`NODE_OPTIONS= node test/plugin-compat-e2e.mjs`
 * 它是**独立脚本**，不进 `npm run verify`（要起真进程 + 假 QQ，放门禁里会拖慢并制造端口竞争）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE_GROUP = '900000001';
const IDS = Array.from({ length: 25 }, (_, i) => `qa${String(i + 1).padStart(2, '0')}`);
const fails = [];
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) fails.push(msg); };

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-e2e-'));
const pluginsDir = path.join(work, 'plugins');
const skillsDir = path.join(work, 'skills');
fs.mkdirSync(pluginsDir, { recursive: true });
fs.mkdirSync(skillsDir, { recursive: true });

for (const id of IDS) {
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id, name: `QA ${id}`, version: '1.0.0', apiVersion: 1, entry: 'index.js',
    capabilities: [], permissions: [], requires: [], settings: {}, configSchema: {},
  }, null, 2), 'utf8');
  // 钩子真的写日志（父进程继承 QA_HOOK_LOG），setup 真的注册一个工具。
  fs.writeFileSync(path.join(dir, 'index.js'), `import fs from 'node:fs';\n`
    + `export const hooks = {\n`
    + `  'after-incoming-message': async (p) => {\n`
    + `    const f = process.env.QA_HOOK_LOG;\n`
    + `    if (f) fs.appendFileSync(f, JSON.stringify({ id: '${id}', chatKey: p.chatKey, senderId: p.senderId, self: p.self, media: p.media }) + '\\n');\n`
    + `  },\n`
    + `};\n`
    + `export function setup(api) {\n`
    + `  api.registerTool({ id: 'ping', description: 'ping', parameters: { type: 'object', properties: {} }, execute: () => ({ content: 'pong' }) });\n`
    + `}\n`, 'utf8');
}

const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
base.custom = base.custom || {};
base.llm = { ...(base.llm || {}), maxTokens: 400 };

function writeConfig(name, { pluginMax, toolMax }) {
  const cfg = structuredClone(base);
  cfg.custom.plugins = { enabled: [...IDS], settings: {}, max: pluginMax };
  cfg.custom.tools = { max: toolMax };
  const f = path.join(work, name);
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2), 'utf8');
  return f;
}

function runOnce({ config, tag }) {
  const hooksLog = path.join(work, `${tag}-hooks.log`);
  const effective = path.join(work, `${tag}-effective.json`);
  try { fs.rmSync(hooksLog, { force: true }); } catch { /* 本来就没有 */ }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'fake-qq.mjs'), '--sandbox', '--offline', '--config', config,
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        QQBOT_PLUGINS_DIR: pluginsDir,
        QQBOT_SKILLS_DIR: skillsDir,
        QA_HOOK_LOG: hooksLog,
        QQBOT_EFFECTIVE_FILE: effective,
        NODE_OPTIONS: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    // 留足启动时间（25 个包的真实 import + setup），再发一条群消息，收到回复后退出。
    setTimeout(() => { try { child.stdin.write('你好\n'); } catch { /* 已退 */ } }, 3500);
    setTimeout(() => { try { child.stdin.write('/quit\n'); } catch { /* 已退 */ } }, 6500);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退 */ } }, 25000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      let eff = null;
      try { eff = JSON.parse(fs.readFileSync(effective, 'utf8')); } catch { /* 读不到就红 */ }
      let hooks = [];
      try {
        hooks = fs.readFileSync(hooksLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch { /* 没写就是 0 行 */ }
      resolve({ code, out, eff, hooks });
    });
  });
}

const EXT = (eff) => eff?.extensions || {};

try {
  // ① 25 个全加载 + 25 条入站钩子
  {
    const r = await runOnce({ config: writeConfig('cfg-256.json', { pluginMax: 256, toolMax: 64 }), tag: 'full' });
    const ext = EXT(r.eff);
    ok(r.code === 0, `25 插件：假 QQ 正常退出（exit=${r.code}）`);
    ok(ext.sum?.loaded === 25, `25 插件：loaded=25（实际 ${ext.sum?.loaded}）`);
    ok(ext.sum?.over === 0, `25 插件：over=0（实际 ${ext.sum?.over}）`);
    ok(ext.sum?.tools === 25, `25 插件：插件工具合计=25（实际 ${ext.sum?.tools}）`);
    ok(ext.sum?.hooks === 25, `25 插件：钩子合计=25（实际 ${ext.sum?.hooks}）`);
    ok(ext.limits?.plugins === 256 && ext.limits?.tools === 64, `limits=256/64（实际 ${JSON.stringify(ext.limits)}）`);
    ok(r.hooks.length === 25, `after-incoming-message：25 条日志（实际 ${r.hooks.length}）`);
    ok(r.hooks.every((h) => h.chatKey === `group:${FAKE_GROUP}`), '每条载荷的 chatKey 都是 group:假群号');
    ok(r.hooks.every((h) => typeof h.senderId === 'string' && h.senderId.length > 0 && h.self === false && typeof h.media === 'number'),
      '每条载荷都有 senderId / self=false / media 数字');
  }

  // ② plugins.max=20 ⇒ 20 loaded + 5 over + 20 条钩子
  {
    const r = await runOnce({ config: writeConfig('cfg-20.json', { pluginMax: 20, toolMax: 64 }), tag: 'cap20' });
    const ext = EXT(r.eff);
    ok(ext.sum?.loaded === 20, `上限 20：loaded=20（实际 ${ext.sum?.loaded}）`);
    ok(ext.sum?.over === 5, `上限 20：over=5（实际 ${ext.sum?.over}）`);
    ok(r.hooks.length === 20, `上限 20：只有 20 个包收到钩子（实际 ${r.hooks.length}）`);
    ok((ext.items || []).filter((i) => i.state === 'over').every((i) => /上限 20/.test(i.detail || '')),
      '超限项 detail 写明「超过上限 20」');
  }

  // ③ tools.max=3 ⇒ 注册表被钳住 + 插件工具失败原因可见
  {
    const r = await runOnce({ config: writeConfig('cfg-tools3.json', { pluginMax: 256, toolMax: 3 }), tag: 'tools3' });
    const ext = EXT(r.eff);
    const errs = (ext.items || []).reduce((n, i) => n + (i.toolErrors || []).length, 0);
    ok(ext.limits?.tools === 3, `工具上限 3：limits.tools=3（实际 ${ext.limits?.tools}）`);
    ok(ext.limits?.toolsUsed <= 3, `工具上限 3：实际注册数 ≤3（实际 ${ext.limits?.toolsUsed}）`);
    ok(errs > 0, `工具上限 3：失败原因可见（toolErrors=${errs}）`);
  }
} finally {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 清不掉就留给 tmp */ }
}

console.log(fails.length ? `\nFAIL ${fails.length} 条` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
