/**
 * 插件 / Skill 创建提示词（2026-11-01）。
 *
 * 「创造插件」弹窗把用户填写的基本信息和宿主的真实接口规范拼成一段提示词，
 * 用户复制后交给外部 AI；AI 按规范产出扩展包，再回控制台导入。
 *
 * ⚠️ 模板里的事实必须与真实宿主一致：
 *   · apiVersion 来自 `src/plugin-manifest.js` 的 PLUGIN_API_VERSION；
 *   · 钩子点来自 `src/hook-bus.js` 的 HOOK_POINTS；
 *   · 标签归一化来自 `src/plugin-manifest.js` 的 normalizeTagList。
 *   在这里再抄一份常量，宿主升级后提示词就会教出装不上的包。
 *
 * 本模块零 IO、零网络、不读配置，纯字符串拼装。
 */
import { PLUGIN_API_VERSION, normalizeTagList } from './plugin-manifest.js';
import { HOOK_POINTS } from './hook-bus.js';

const KIND_LABEL = Object.freeze({ plugin: '插件', skill: 'Skill' });
const NAME_MAX = 40;
const DESC_MAX = 200;
const PROMPT_MAX = 2000;

function text(value, max, fallback = '') {
  const s = String(value == null ? '' : value).trim();
  return (s || fallback).slice(0, max);
}

function tagList(value) {
  return normalizeTagList(Array.isArray(value) ? value : String(value || '').split(/[,，\s]+/))
    .filter(Boolean);
}

/**
 * @param {{kind?:string,id?:string,name?:string,description?:string,category?:string,
 *          toolName?:string,toolDescription?:string,prompt?:string,tags?:string[]|string}} meta
 * @returns {{ok:true,kind:string,name:string,tags:string[],prompt:string}|{ok:false,error:string}}
 */
export function buildCreatePrompt(meta = {}) {
  const kind = meta.kind === 'skill' ? 'skill' : 'plugin';
  const label = KIND_LABEL[kind];
  const name = text(meta.name, NAME_MAX);
  if (!name) return { ok: false, error: '先填显示名称。' };
  const id = text(meta.id, NAME_MAX);
  if (id && !/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
    return { ok: false, error: 'id 只能用字母、数字、下划线、连字符（1–40 字）。' };
  }
  const category = text(meta.category, 40);
  const description = text(meta.description, DESC_MAX);
  const toolName = text(meta.toolName, NAME_MAX);
  const toolDescription = text(meta.toolDescription, DESC_MAX);
  const promptBody = text(meta.prompt, PROMPT_MAX);
  const tags = tagList(meta.tags);

  const L = [];
  L.push(`你是 Estrella Bot 的扩展包生成器。请根据下面的「用户填写信息」和「宿主接口规范」，`
    + `生成一个可以直接导入控制台的${label}扩展包。`);
  L.push('');
  L.push('【用户填写的基本信息】');
  L.push(`- 类型：${label}（清单 kind = ${JSON.stringify(kind)}）`);
  L.push(`- 显示名称：${name}`);
  L.push(`- id：${id || '（未填写。请根据显示名称生成一个合法英文 id，并用它作为顶层文件夹名）'}`);
  L.push(`- 分类：${category || '（未填写。请按功能给一个短分类）'}`);
  L.push(`- 说明：${description || '（未填写。请写一句不超过 200 字的说明）'}`);
  if (kind === 'plugin') {
    L.push(`- 工具名：${toolName || '（未填写。请基于 id 生成一个合法工具 id）'}`);
    L.push(`- 工具说明：${toolDescription || '（未填写。请写一句模型能看懂的工具说明）'}`);
  } else {
    L.push(`- Skill 提示词内容：${promptBody || '（未填写。请根据名称/说明写一段什么时候该用这个 Skill 的指引）'}`);
  }
  L.push(`- 标签：${tags.length ? tags.join('、') : '（未填写。请按功能生成 3–6 个短标签，每个不超过 20 字）'}`);
  L.push('');
  L.push('【宿主接口规范（必须逐条遵守）】');
  L.push('');
  L.push('1. 包结构');
  L.push('- 顶层只能有一个扩展包目录，目录名建议与 id 相同；包内必须恰好有一份 plugin.json 或 skill.json。');
  L.push('- 入口 index.js 必须真实存在（纯提示词 Skill 也要有 index.js，内容写 export {};）。');
  L.push('- 不要使用 npm 依赖、不要 package.json、不要构建步骤；只能用 Node 内置模块和包内相对文件。');
  L.push('- 文件数 < 200，单文件 < 2 MB，整包 < 3 MB；不要塞大资源。');
  L.push('- 不要写本机绝对路径；不要读写包外文件；不要把凭据写进代码。');
  L.push('');
  L.push(`2. 清单字段（apiVersion 必须是 ${PLUGIN_API_VERSION}）`);
  L.push('- id：英文、字母/数字/下划线/连字符，≤40 字；它会成为启用名单的键。');
  L.push(`- name：显示名称；version：字符串（如 1.0.0）；apiVersion：${PLUGIN_API_VERSION}；kind：${JSON.stringify(kind)}；entry："index.js"。`);
  L.push('- description：≤200 字；category：可空、≤40 字；tags：3–6 个短标签（用户填了就原样使用）。');
  L.push('- settings：该包的默认设置对象（没有就写 {}）；可选 configSchema：{ key: { label, description } }。');
  L.push('- permissions：只有确实需要时才写；可用值只有 web_fetch / send_image / storage。需要联网才写 web_fetch。');
  L.push('');
  if (kind === 'plugin') {
    L.push('3. 插件入口 index.js');
    L.push('用 ESM 导出 setup(api)，在 setup 里注册工具或导出 hooks。示例：');
    L.push('');
    L.push('export function setup(api) {');
    L.push('  api.registerTool({');
    L.push('    id: \'your_tool_id\',');
    L.push('    description: \'一句话说明这个工具做什么（单行，≤512 字）\',');
    L.push('    parameters: {');
    L.push('      type: \'object\',');
    L.push('      properties: { query: { type: \'string\', description: \'用户要查询的内容\' } },');
    L.push('      required: [\'query\'],');
    L.push('      additionalProperties: false,');
    L.push('    },');
    L.push('    execute: async (ctx, args) => ({ content: \'这里返回给模型看的文本\' }),');
    L.push('  });');
    L.push('}');
    L.push('');
    L.push('可选钩子（只有需要“条件满足必跑”时才用）：');
    L.push('export const hooks = {');
    L.push('  \'before-tool\': async (ctx) => {');
    L.push('    if (/* 条件 */ false) return { block: true, reason: \'为什么拦下\' };');
    L.push('    return undefined;');
    L.push('  },');
    L.push('};');
    L.push(`支持的钩子点只有：${HOOK_POINTS.join(' / ')}。不在这个表里的名字会被拒绝。`);
    L.push('只有 before-tool 的 { block: true, reason } 是否决；其余钩子点是只读/改写，抛错按 fail-open 放行。');
  } else {
    L.push('3. Skill 入口 index.js 与 prompt.sections');
    L.push('- 纯提示词 Skill 的 index.js 写 export {}; 即可。');
    L.push('- 需要工具时同样用 export function setup(api) { api.registerTool({...}) } 注册；execute 形状与插件相同。');
    L.push('- 不要在 Skill 里导出 hooks（会被标成混合型，面板不推荐）。');
    L.push(`- skill.json 必须有 prompt.sections：最多 5 段，单段正文 ≤600 字，全部正文合计 ≤1600 字；title 会变成小标题。`);
    L.push('- 想让模型知道什么时候用，把指引写进 prompt.sections.content；里面可以直接写裸工具 id，宿主注入时会补上真实注册名。');
  }
  L.push('');
  L.push('4. 工具与 api 的硬约束');
  L.push('- registerTool 定义：{ id, description, parameters, execute }。');
  L.push('- id 写裸工具 id；宿主实际注册名是 <包id>__<工具id>（总长 ≤64）。');
  L.push('- description 必须压成单行，≤512 字。');
  L.push('- parameters 必须是 object 型 JSON Schema：{ type: \'object\', properties: {...}, required: [...] }；type 不要写成数组。');
  L.push('- execute(ctx, args) 可以是 async；返回字符串或 { content: \'...\' }；抛错会变成给模型的错误文本。');
  L.push('- 工具结果会按宿主上限截断，返回内容保持简短（建议 < 2000 字）。');
  L.push('- ctx 是只读的；不要自己发送消息，不要绕过宿主直接调用协议端。');
  L.push('- api 可用面：config()（读取该包设置）、log / warn / error、has(permission)、isActive(other)、registerTool；');
  L.push('  只有清单 permissions 里声明 web_fetch 才会拿到受出站策略约束的 api.fetch。');
  L.push('');
  L.push('5. 输出格式');
  L.push('请按文件逐个输出完整内容，不要省略、不要写“其余同上”：');
  L.push('- 先写顶层文件夹名；');
  L.push('- 再逐个写“文件路径 + 完整文件内容”；');
  L.push('- 最后写一段简短的导入步骤。');
  L.push('');
  L.push('6. 用户导入步骤（你在结尾复述一次即可）');
  L.push('把输出文件收进一个顶层文件夹；回到控制台「插件技能工厂 → 导入插件」，选择这个文件夹或把它压成 ZIP。');
  L.push('装完默认不启用：回列表勾选并重启机器人后生效。');

  return { ok: true, kind, name, tags, prompt: L.join('\n') };
}
