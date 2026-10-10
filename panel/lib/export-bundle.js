/**
 * 「导出当前配置」这条命令的实现（H-10 第二半 · 第 19 轮从主文件搬出）。
 * ══════════════════════════════════════════════════════════════════════════
 * 层号 **L2**：只依赖 `panel/lib/` 的读盘口与 `src/` 的纯判据，不依赖任何
 * `server.js` 顶层的判据 —— 这是三块里搬得最干净的一块（零注入面）。
 *
 * 为什么它先能搬而 `collectState` 不能：它要的 `listAutoMemory` / `readRecords`
 * 是 `src/memory.js` 里**两个纯读函数**（体内零 log 引用），
 * 而 `memory.js` 静态 import `logger.js` → `egress.js`（import 期就编译凭据特征表）
 * 会把机器人的凭据装载拖进面板进程 —— 那正是 §82 白名单要防的。
 * 解耦办法见 `src/memory.js` 的 `setMemoryLog`：日志判据改成**入参**，
 * 于是本模块只引它那份纯读实现，机器人的启动链一点没被拖进来。
 *
 * @returns {object} 可直接 JSON.stringify 的导出包
 */
// ⚠️ `path` / `fs` 是**本模块自己**要用的：下面 :38 拼人格文件的绝对路径、:216 读运行日志。
//    第 19 轮把它从 `server.js` 搬出来时漏带了这两行（`server.js` 顶层本来有），于是
//    **每个** `/api/custom/export` 都在第一处 `path.join` 抛 `ReferenceError: path is not defined`
//    ⇒ HTTP 500、导出 100% 不可用。而 `check-wb` 是静态扫描器，"该 import 的有没有 import"
//    它查不到 ⇒ 只有运行期那一层（`sandbox --run`）能抓到。第 57 轮 B1 补回。
import fs from 'node:fs';
import path from 'node:path';
import {
  SCENES, REPLY_LENGTHS, ENHANCE, ENHANCE_KEYS, PLAY_RULES, SKILL_IN_PROMPT, FACE_PRESETS, readCustom,
} from '../../src/custom-config.js';
import { listAutoMemory, readRecords } from '../../src/memory-store.js';
import { isSafeRelPath } from '../../src/plugin-manifest.js';
import { ROOT } from './paths.js';
import { readTrace } from './trace-io.js';

export function makeExportBundle() {
  return function buildExport(cfg, what, mask = true) {
    const custom = readCustom(cfg);
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    const files = {};

    const personaFile = cfg?.persona?.file || '';
    // H-03（2026-10-05 · 第 10 轮 · 开源前审查）：这条路径来自**用户可见配置**，
    // 而下面会把它读成文本塞进导出包。原来只 `path.join(ROOT, personaFile)` 就直接读 ——
    // 于是 `persona.file = "../../.env"` 会让「导出人格」顺带把 `.env` 全文交出去。
    // 现在先过**唯一那份**包含性判据（`isSafeRelPath`：挡 NUL / 绝对路径 / 盘符 / `..`）。
    // ⚠️ 不可利用 ≠ 不用防：`/api/config` 目前写不了 `persona.file`，但那属于"输入面恰好很窄"，
    //    不是"这条路径是安全的" —— 判据要按路径本身写，不按"今天谁能改它"写。
    const personaSafe = !!personaFile && isSafeRelPath(personaFile);
    const personaAbs = personaSafe ? path.join(ROOT, personaFile) : '';
    const personaText = personaAbs && fs.existsSync(personaAbs)
      ? fs.readFileSync(personaAbs, 'utf8')
      : '（人格文件不存在或未设置）';

    files['人格.md'] = [
      `# 机器人人格`,
      ``,
      `- 昵称：${cfg?.persona?.name || '(未设置)'}`,
      `- 人格文件：${personaFile || '(未设置)'}`,
      ``,
      `## 工作台里填的日常人设`,
      ``,
      `- 年龄：${custom.persona.age || '(未填)'}`,
      `- 身份：${custom.persona.role || '(未填)'}`,
      `- 时代/世界：${custom.persona.world || '(未填)'}`,
      `- 核心欲望：${custom.persona.desire || '(未填)'}`,
      `- 核心恐惧/弱点：${custom.persona.fear || '(未填)'}`,
      `- 性格：${custom.persona.traits || '(未填)'}`,
      `- 说话语气：${custom.persona.tone || '(未填)'}`,
      `- 行为逻辑：${custom.persona.logic || '(未填)'}`,
      `- 对群里人的态度：${custom.persona.attitude || '(未填)'}`,
      `- 当前状态：${custom.persona.status || '(未填)'}`,
      `- 口头禅：${custom.persona.catch || '(未填)'}`,
      `- 爱用表情：${custom.persona.faces || '(未填)'}`,
      ``,
      `## 增强项（填了的才会写进提示词）`,
      ``,
      ...ENHANCE_KEYS.map((k) => `- ${ENHANCE[k].label}：${custom.enhance?.[k] || '(未填)'}`),
      ``,
      `- 改人设后丢弃旧发言：${custom.personaResetOnChange ? '是' : '否'}`,
      `- 扮演规则（底层逻辑）：${custom.playRules ? `开启，共 ${PLAY_RULES.length} 条` : '已关闭'}`,
      ...(custom.playRules ? PLAY_RULES.map((r) => `  ${r.text}`) : []),
      ``,
      `## 人格文件原文`,
      ``,
      personaText,
    ].join('\n');

    // 真正逐字的完整提示词：取最近一次真实调用的记录
    const lastTrace = readTrace(1)[0];
    files['提示词-最近一次真实调用.txt'] = lastTrace?.prompt
      ? [
          `以下是你机器人**最近一次真实回复**时发给模型的完整提示词（逐字，未加工）。`,
          `时间：${new Date(lastTrace.t || Date.now()).toLocaleString('zh-CN', { hour12: false })}`,
          `模型：${lastTrace.model || ''}${lastTrace.downgraded ? `（实际用了 ${lastTrace.used}）` : ''}`,
          `原因：${lastTrace.reason || ''}`,
          ``,
          '──────── 提示词原文 ────────',
          lastTrace.prompt,
        ].join('\n')
      : '还没有任何真实调用记录。机器人回一条之后再看这里。';

    files['提示词-素材.md'] = [
      `# 工作台往提示词里加的东西（素材，不是最终拼好的提示词）`,
      ``,
      `> 逐字的完整提示词请看「提示词-最近一次真实调用.txt」。`,
      `> 这一份只是你填的素材清单，方便备份和核对。`,
      ``,
      `## 人设`,
      `- 年龄 / 身份 / 世界：${[custom.persona.age, custom.persona.role, custom.persona.world].filter(Boolean).join(' · ') || '(未填)'}`,
      `- 核心欲望：${custom.persona.desire || '(未填)'}`,
      `- 核心恐惧/弱点：${custom.persona.fear || '(未填)'}`,
      `- 性格：${custom.persona.traits || '(未填)'}`,
      `- 语气：${custom.persona.tone || '(未填)'}`,
      `- 行为逻辑：${custom.persona.logic || '(未填)'}`,
      `- 对群里人的态度：${custom.persona.attitude || '(未填)'}`,
      `- 当前状态：${custom.persona.status || '(未填)'}`,
      `- 口头禅：${custom.persona.catch || '(未填)'}`,
      `- 爱用表情：${custom.persona.faces || '(未填)'}`,
      ``,
      `## 回复方式`,
      `- 长短：${REPLY_LENGTHS[custom.replyStyle.length]?.label || custom.replyStyle.length}`,
      `- 一件事多条消息发：${custom.replyStyle.multiMessage === false ? '否（合并成一条长消息）' : '是'}`,
      `- 回复时 @ 人：${custom.replyStyle.mentionAt ? '是' : '否'}`,
      `- 连续回复最小间隔：${custom.replyStyle.cooldownSec} 秒`,
      ``,
      `## 技能（共 ${custom.skills.length} 条，注入时最多同时上 ${SKILL_IN_PROMPT} 条）`,
      ...(custom.skills.length
        ? custom.skills.map((s) => `- [${s.enabled ? '启用' : '停用'}] ${s.name}（${s.kind === 'persona' ? '角色卡' : '知识包'} · ${s.scope.type === 'global' ? '全局' : `${s.scope.type}:${s.scope.id}`}）`)
        : ['(还没有技能)']),
      ``,
      `## 特殊场景`,
      ...Object.entries(SCENES).map(([k, v]) => `- ${v.label}：${custom.scenes[k] || '(未填，不干预)'}`),
    ].join('\n');

    files['规则与触发.md'] = [
      `# 触发方式与安全设置`,
      ``,
      `## 触发`,
      `- 群里必须 @ 才回话：${cfg?.trigger?.requireAtInGroup !== false ? '是' : '否'}`,
      `- 叫名字也回（别名）：${(cfg?.trigger?.aliases || []).join('、') || '(未设置)'}`,
      `- 关键词触发：${custom.trigger.keywords.join('、') || '(未设置)'}`,
      `- 随机插话概率：${Math.round((cfg?.trigger?.interjectChance ?? 0) * 100)}%`,
      `- 主动发言总闸：${custom.allowProactive === false ? '已关闭（它不会自己开口）' : '开启'}`,
      `- 定时主动开话题：${custom.trigger.proactive.enabled ? `每 ${custom.trigger.proactive.intervalMin} 分钟` : '未开启'}`,
      `- 免打扰时段：${custom.trigger.quietHours.from === custom.trigger.quietHours.to
        ? '未设置（可以全天主动说话）'
        : `${String(custom.trigger.quietHours.from).padStart(2, '0')}:00 – ${String(custom.trigger.quietHours.to).padStart(2, '0')}:00 不主动开口`}`,
      ...(custom.trigger.scheduled.length
        ? ['', '## 定时消息', ...custom.trigger.scheduled.map((s) => `- ${s.at} ${s.enabled === false ? '(已停用)' : ''} ${s.text}`)]
        : []),
      ``,
      `## 安全设置`,
      `- 敏感词：${custom.safety.banned.join('、') || '(未设置)'}`,
      `- 防刷屏：${custom.safety.antiFlood ? '开（每条最多 2 段）' : '关'}`,
      `- 过滤链接：${custom.safety.filterLinks ? '开' : '关'}`,
      ``,
      `## 放行的群`,
      ...(cfg?.allow?.groups || []).map((g) => `- ${g}`),
      ``,
      `## 拉黑的群 / 人（这些地方它完全不回话）`,
      `- 群：${(cfg?.deny?.groups || []).join('、') || '(无)'}`,
      `- 人：${(cfg?.deny?.users || []).join('、') || '(无)'}`,
    ].join('\n');

    const auto = listAutoMemory();
    files['记忆.md'] = [
      `# 自我记忆`,
      ``,
      `## 手动记忆（永远生效，不受自动记录开关影响）`,
      ...(custom.memory.manual.length
        ? custom.memory.manual.map((m) => `- [${m.on === false ? '停用' : '启用'}] ${m.text}`)
        : ['(空)']),
      ``,
      `## 自动记录（${custom.memory.auto ? '开关：开' : '开关：关'}）`,
      ...(auto.length
        ? auto.map((m) => `- ${new Date(m.t || Date.now()).toLocaleString('zh-CN', { hour12: false })} ${m.text}`)
        : ['(空)']),
      ``,
      `## 结构化记忆（ATI-3：按会话隔离；**未被独立复证的不进提示词**）`,
      ...(() => {
        const rs = readRecords();
        if (!rs.length) return ['(空)'];
        return rs.map((r) => {
          const when = new Date(r.lastSeenAt || Date.now()).toLocaleString('zh-CN', { hour12: false });
          const scope = r.provenance?.chatKey || '(无会话)';
          return `- [${r.status}] ×${r.samples} ${r.kind}｜${r.text}${r.detail ? `（${r.detail}）` : ''}｜${scope}｜${when}`;
        });
      })(),
    ].join('\n');

    if (what === 'all' || what === 'skills') {
      const list = custom.skills || [];
      const scopeText = (s) => (s.type === 'global'
        ? '全局（所有群 / 私聊）'
        : s.type === 'group' ? `只在群 ${s.id || '(没填)'}` : `只对 ${s.id || '(没填)'} 生效`);
      files['技能.md'] = [
        `# 技能（共 ${list.length} 条，注入时最多同时上 ${SKILL_IN_PROMPT} 条）`,
        ``,
        ...(list.length
          ? list.flatMap((s) => [
              `## ${s.name}　${s.enabled ? '' : '（已停用）'}`.trimEnd(),
              `- 类型：${s.kind === 'persona' ? '角色卡（一整套人格）' : '知识包'}`,
              `- 生效范围：${scopeText(s.scope)}`,
              `- 触发词：${s.triggers.length ? s.triggers.join('、') : '（没填 → 每轮都带上）'}`,
              ``,
              s.background || '(没有背景内容)',
              ...(s.examples?.length ? ['', '示例台词（只学语气，别照抄）：', ...s.examples.map((e) => `- ${e}`)] : []),
              '',
            ])
          : ['(还没有技能)']),
      ].join('\n');
    }

    files['QQ表情ID表.md'] = [
      `# QQ 内置表情 ID 表（机器人用 [face:ID] 这种写法发送）`,
      ``,
      '| ID | 表情 |',
      '|---|---|',
      ...FACE_PRESETS.map(([id, name]) => `| ${id} | ${name} |`),
      ``,
      `> 只有在「能力开关 → 发送表情包」打开时才会真的发出去。`,
    ].join('\n');

    if (what === 'all' || what === 'log') {
      let logText = '(没有日志)';
      try {
        logText = fs
          .readFileSync(path.join(ROOT, 'panel', 'bridge.log'), 'utf8')
          .split('\n')
          .slice(-400)
          .join('\n');
      } catch { /* 日志不存在很正常 */ }
      files['运行日志-末尾400行.txt'] = logText;
    }

    if (what === 'all' || what === 'config') {
      // 脱敏。**不提供"连 Key 都不清"的导出** —— 那等于把账号送人，
      // 不该由一个下载按钮完成。但群号要不要一起藏掉，交给用户选：
      //   mask=1（默认）：清空 Key/Token + 群号与 QQ 号换成占位 → 这份可以放心发给别人
      //   mask=0         ：只清空 Key/Token，保留群号 → 自己留档用
      const safe = JSON.parse(JSON.stringify(cfg || {}));
      const scrub = (o) => {
        if (!o || typeof o !== 'object') return;
        for (const k of Object.keys(o)) {
          if (/key|token|secret/i.test(k)) { o[k] = ''; continue; }
          scrub(o[k]);
        }
      };
      scrub(safe);
      if (mask) {
        const hide = (arr) => (Array.isArray(arr) ? arr.map((_, i) => `<已隐藏${i + 1}>`) : arr);
        for (const key of ['allow', 'deny']) {
          if (safe[key]?.groups) safe[key].groups = hide(safe[key].groups);
          if (safe[key]?.private) safe[key].private = hide(safe[key].private);
          if (safe[key]?.users) safe[key].users = hide(safe[key].users);
        }
      }
      files['config-已脱敏.json'] = JSON.stringify(safe, null, 2);
    }

    // what 不是 all 时只留对应的那几份，避免"我点了下载人格，结果拿到一整个包"
    const only = {
      persona: ['人格.md'],
      prompt: ['提示词-最近一次真实调用.txt', '提示词-素材.md'],
      rules: ['规则与触发.md'],
      memory: ['记忆.md'],
      skills: ['技能.md'],
      faces: ['QQ表情ID表.md'],
      log: ['运行日志-末尾400行.txt'],
      config: ['config-已脱敏.json'],
    }[what];
    const picked = only ? Object.fromEntries(Object.entries(files).filter(([k]) => only.includes(k))) : files;

    return { generatedAt: stamp, root: ROOT, files: picked };
  };
}
