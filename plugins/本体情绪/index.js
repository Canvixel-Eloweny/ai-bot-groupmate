// 本体情绪 —— 确定性型插件（hooks + 少量工具）
// 来源：魔改版 src/bot-state.js（去亢奋、去管理员硬编码）
//
// hooks:
//   before-llm-messages  注入状态摘要（可关）
//   after-response       按本轮结果更新情绪（可关）
// tools:
//   bot_state_view / bot_state_set

import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
import {
  configure, botStatePromptLine, botStateView, setBotState,
  applyRunToBotState, detectIncomingHint, parseEmotionTags, insertVolatileLine
} from './lib/state.js';

let api = null;
let cfg = () => ({});

const DEFAULTS = {
  injectPrompt: true,
  autoUpdate: true,
  injectPriority: 25
};

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

const pendingTrigger = new Map();

export function setup(a) {
  api = a;
  cfg = a.config;
  configure({ file: path.join(DATA_DIR, 'bot-state.json') });

  a.registerTool({
    id: 'bot_state_view',
    name: '看本体状态',
    description: '查看跨群共享的心情/精力/压力/情绪摘要。平时不用；被问「你怎么了」或调试时可用。',
    category: 'system',
    icon: '🫧',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const v = botStateView();
        return {
          content: [
            `精力 ${v.energy}（${v.energyLabel}） · 心情 ${v.moodLabel}`,
            v.intent ? `倾向：${v.intent}` : '',
            v.emotionPhrases?.length ? `情绪：${v.emotionPhrases.join('、')}` : '',
            v.promptLine
          ].filter(Boolean).join('\n')
        };
      } catch (e) {
        return { content: `读取失败：${e?.message ?? e}`, isError: true };
      }
    }
  });

  a.registerTool({
    id: 'bot_state_set',
    name: '改本体状态',
    description: '管理员调试：改心情/精力/清情绪。reset=true 全部重置。模型平时不要乱调。',
    category: 'system',
    icon: '🎛️',
    parameters: {
      type: 'object',
      properties: {
        mood: { type: 'integer', description: '心情 0~100' },
        energy: { type: 'integer', description: '精力 0~100（四池同调）' },
        acuteStress: { type: 'integer', description: '急压 0~100' },
        reset: { type: 'boolean', description: 'true=全部重置' }
      }
    },
    async execute(_ctx, args) {
      try {
        const v = setBotState({
          mood: args?.mood,
          energy: args?.energy,
          acuteStress: args?.acuteStress,
          reset: args?.reset === true
        });
        return { content: `已更新：精力 ${v.energy} 心情 ${v.moodLabel}` };
      } catch (e) {
        return { content: `更新失败：${e?.message ?? e}`, isError: true };
      }
    }
  });
}

export function activate() {
  configure({ file: path.join(DATA_DIR, 'bot-state.json') });
}

export const hooks = {
  'before-context': ({ triggerEntries } = {}) => {
    try {
      const texts = (triggerEntries || []).map((e) => String(e?.text || ''));
      pendingTrigger.set('hint', detectIncomingHint(texts));
      pendingTrigger.set('cue', texts.join('\n').slice(0, 400));
      pendingTrigger.set('count', (triggerEntries || []).length);
      pendingTrigger.set('addressed', (triggerEntries || []).some((e) => e?.atMe === true));
    } catch { /* 钩子失败不阻塞 */ }
  },

  'before-llm-messages': ({ messages } = {}) => {
    try {
      if (settings().injectPrompt === false || !Array.isArray(messages)) return;
      const line = botStatePromptLine();
      if (!line) return;
      // 挂到第一条 system —— 位置在**必变段内部、时间行之前**（不是末尾）。
      // 追加到末尾会把 system 的末两行变成「场景 + 状态」，而项目自己的
      // `checkVolatileTail` 正是用那两行判定 trace 属于"改序前/后"
      // → 实测 7/7 条真实 trace 被判成"改序之前"，指标整体失效（见 `insertVolatileLine`）。
      for (const m of messages) {
        if (m?.role !== 'system') continue;
        if (typeof m.content === 'string') {
          m.content = insertVolatileLine(m.content, line);
          break;
        }
        if (Array.isArray(m.content)) {
          const t = m.content.find((c) => c?.type === 'text');
          if (t && typeof t.text === 'string') {
            t.text = insertVolatileLine(t.text, line);
            break;
          }
        }
      }
    } catch { /* ignore */ }
  },

  'after-response': ({ response, session } = {}) => {
    try {
      if (settings().autoUpdate === false) return;
      const sent = Array.isArray(session?.sent)
        ? session.sent.filter((s) => s?.type === 'text').map((s) => s.text)
        : [];
      const toolFailed = Boolean(session?.error)
        || (Array.isArray(session?.toolResults) && session.toolResults.some((r) => r?.isError));
      const moodHint = String(session?.moodTag || session?.finishReason || '');
      const hint = pendingTrigger.get('hint');
      applyRunToBotState({
        sentTexts: sent,
        chatKey: String(session?.chatKey || ''),
        incomingHint: hint,
        toolFailed,
        error: Boolean(session?.error),
        moodHint,
        triggerText: pendingTrigger.get('cue') || '',
        addressed: Boolean(pendingTrigger.get('addressed')),
        triggerCount: Number(pendingTrigger.get('count')) || 0
      });
    } catch {
      // 状态更新失败不影响本轮
    } finally {
      pendingTrigger.clear();
    }
  }
};
