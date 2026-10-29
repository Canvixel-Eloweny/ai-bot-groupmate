/**
 * 扩展包的「模板创建 + 文件夹打包」（2026-10-28 · 0.1.5 接口收尾）。
 *
 * 插件工厂以前只有 ZIP 导入：创造插件是写死的 toast，选择文件夹直接说不支持。
 * 这里把两件事都收敛到同一份「校验 → makeZip」实现，安装仍走唯一入口
 * `POST /api/extensions/install`（不新增第二条落盘路径）。
 *
 * ⚠️ 只做模板填充，不接模型生成代码。模板里的字符串全部 JSON.stringify，
 *    用户输入不会拼进可执行语句。
 */
import {
  isSafeRelPath, isValidPluginId, normalizeManifest, stripBom,
} from '../../src/plugin-manifest.js';
import { makeZip } from './zip.js';

export const PACK_REQUEST_MAX = 6 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const ROOT_MAX = 80;
const NAME_MAX = 40;
const DESC_MAX = 200;
const PROMPT_MAX = 2000;

function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

function text(v, max, fallback = '') {
  const s = String(v == null ? '' : v).trim();
  return (s || fallback).slice(0, max);
}

function safeRoot(raw) {
  const root = String(raw == null ? '' : raw).trim();
  if (!root || root.length > ROOT_MAX) fail('包目录名长度不合法（1–80 字）');
  if (root === '.' || root === '..' || /[\\/\u0000-\u001f\u007f]/.test(root)) {
    fail('包目录名不能含路径分隔符或控制字符');
  }
  return root;
}

function safeRelPath(rel) {
  const p = String(rel == null ? '' : rel).trim();
  if (!p || p.length > 200) fail('文件路径为空或过长');
  if (p.includes('\\') || p.startsWith('/') || /[\u0000-\u001f\u007f]/.test(p)) {
    fail(`文件路径不合法：${p}`);
  }
  const segs = p.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..')) fail(`文件路径不合法：${p}`);
  if (!isSafeRelPath(p)) fail(`文件路径不合法：${p}`);
  return p;
}

function decodeBase64(raw, pathLabel) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, '');
  if (!s) return Buffer.alloc(0);
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    fail(`文件内容不是合法 base64：${pathLabel}`);
  }
  const buf = Buffer.from(s, 'base64');
  if (buf.length > MAX_FILE_BYTES) fail(`单个文件超过 2 MB：${pathLabel}`, 413);
  return buf;
}

function manifestNameOf(kind) {
  return kind === 'skill' ? 'skill.json' : 'plugin.json';
}

function toolIdOf(id) {
  return `${id.replace(/[^A-Za-z0-9_]/g, '_')}_tool`;
}

/**
 * 生成模板文件（路径相对包根目录）。
 * @returns {Array<{path:string, data:Buffer, text:string}>}
 */
export function buildScaffoldFiles(meta = {}) {
  const kind = meta.kind === 'skill' ? 'skill' : 'plugin';
  const id = text(meta.id, NAME_MAX);
  if (!isValidPluginId(id)) fail('插件 id 只能用小写字母/数字/下划线/连字符，且不超过 40 字');
  const name = text(meta.name, NAME_MAX, id);
  const description = text(meta.description, DESC_MAX, '');
  const category = text(meta.category, 40, '');
  const toolName = text(meta.toolName, NAME_MAX) || toolIdOf(id);
  if (!/^[A-Za-z][A-Za-z0-9_-]{1,39}$/.test(toolName)) {
    fail('工具名只能以字母开头，后接字母/数字/下划线/连字符，2–40 字');
  }
  const toolDescription = text(meta.toolDescription, DESC_MAX, `「${name}」注册的工具`);
  const prompt = text(meta.prompt, PROMPT_MAX, '');
  const files = [];

  if (kind === 'skill') {
    const manifest = {
      id,
      name,
      version: '0.1.0',
      apiVersion: 1,
      kind: 'skill',
      entry: 'index.js',
      description,
      category,
      settings: {},
      prompt: {
        sections: [{
          id: 'guide',
          title: `${name} 使用指引`,
          priority: 40,
          content: prompt || `当任务与「${name}」相关时，再按需要参考这个 Skill。`,
        }],
      },
    };
    files.push({ path: 'skill.json', text: `${JSON.stringify(manifest, null, 2)}\n` });
    files.push({ path: 'index.js', text: 'export {};\n' });
  } else {
    const manifest = {
      id,
      name,
      version: '0.1.0',
      apiVersion: 1,
      kind: 'plugin',
      entry: 'index.js',
      description,
      category,
      settings: {},
    };
    const result = `「${name}」已创建。请把 index.js 里 execute 的逻辑换成你要做的事。`;
    const code = [
      'export function setup(api) {',
      '  api.registerTool({',
      `    id: ${JSON.stringify(toolName)},`,
      `    description: ${JSON.stringify(toolDescription)},`,
      "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
      `    execute: async () => ({ content: ${JSON.stringify(result)} }),`,
      '  });',
      '}',
      '',
    ].join('\n');
    files.push({ path: 'plugin.json', text: `${JSON.stringify(manifest, null, 2)}\n` });
    files.push({ path: 'index.js', text: code });
  }
  return files.map((f) => ({ ...f, data: Buffer.from(f.text, 'utf8') }));
}

/**
 * 把一批文件打成扩展包 ZIP。
 *
 * @param {{mode?:'create'|'folder', kind?:string, root?:string, files?:Array<{path:string,contentBase64:string}>, meta?:object}} input
 * @returns {{ok:true, kind:string, root:string, zip:Buffer, files:Array<{path:string,bytes:number,text?:string}>}}
 */
export function packExtension(input = {}) {
  const mode = input.mode === 'create' ? 'create' : 'folder';
  if (mode === 'create') {
    const meta = input.meta && typeof input.meta === 'object' ? input.meta : {};
    const kind = meta.kind === 'skill' ? 'skill' : 'plugin';
    const root = safeRoot(meta.id);
    const entries = buildScaffoldFiles({ ...meta, kind });
    const files = [];
    for (const e of entries) {
      const rel = safeRelPath(e.path);
      files.push({ path: `${root}/${rel}`, data: e.data, text: e.text });
    }
    return finish(kind, root, files, true);
  }

  const kind = input.kind === 'skill' ? 'skill' : 'plugin';
  let root = input.root ? safeRoot(input.root) : '';
  const rawFiles = Array.isArray(input.files) ? input.files : [];
  if (!rawFiles.length) fail('文件夹里没有可打包的文件');
  if (rawFiles.length > MAX_FILES) fail(`文件数量超过 ${MAX_FILES}`, 413);

  const entries = [];
  let total = 0;
  for (const f of rawFiles) {
    if (!f || typeof f !== 'object') continue;
    let rel = safeRelPath(f.path);
    if (!root) root = safeRoot(rel.split('/')[0]);
    if (rel.startsWith(`${root}/`)) rel = rel.slice(root.length + 1);
    const data = decodeBase64(f.contentBase64, rel);
    total += data.length;
    if (total > MAX_TOTAL_BYTES) fail('文件夹内容超过 3 MB（打包后不能超过安装上限）', 413);
    entries.push({ path: `${root}/${rel}`, data });
  }
  if (!entries.length) fail('文件夹里没有可打包的文件');

  return finish(kind, root, entries, false);
}

function finish(kind, root, entries, withText) {
  const manifestPath = `${root}/${manifestNameOf(kind)}`;
  const manifests = entries.filter((e) => /^([^/]+)\/(plugin|skill)\.json$/.test(e.path));
  if (manifests.length !== 1 || manifests[0].path !== manifestPath) {
    fail(`包根目录必须恰好有一份 ${manifestNameOf(kind)}（顶层目录只能有一个）`);
  }
  let raw;
  try {
    raw = JSON.parse(stripBom(entries.find((e) => e.path === manifestPath).data.toString('utf8')));
  } catch (e) {
    fail(`清单不是合法 JSON：${e.message}`);
  }
  const { manifest, fatal } = normalizeManifest(raw, { fallbackId: root, kind });
  if (!manifest || fatal.length) {
    fail(`清单校验失败：${(fatal[0] && fatal[0].text) || '未知原因'}`);
  }
  const entryPath = `${root}/${safeRelPath(manifest.entry || 'index.js')}`;
  if (!entries.some((e) => e.path === entryPath)) fail(`清单声明的入口不存在：${manifest.entry || 'index.js'}`);

  const zip = makeZip(entries.map((e) => ({ name: e.path, data: e.data })));
  return {
    ok: true,
    kind,
    root,
    zip,
    files: entries.map((e) => ({
      path: e.path,
      bytes: e.data.length,
      ...(withText && e.text != null ? { text: e.text } : {}),
    })),
  };
}
