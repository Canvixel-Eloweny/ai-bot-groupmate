// 合并转发发送 —— 移植自魔改包 13-send-forward
// 通过 OneBot send_group_forward_msg / send_private_forward_msg 发出。

let cfg = () => ({});
let log = () => {};

function maxNodes() {
  return Math.min(40, Math.max(1, Number(cfg()?.maxNodes) || 20));
}

function defaultLimit() {
  return Math.min(maxNodes(), Math.max(1, Number(cfg()?.defaultLimit) || 10));
}

export function setup(api) {
  cfg = api.config;
  log = (...a) => api.log?.(...a);

  api.registerTool({
    id: 'send_forward',
    name: '发送合并转发',
    description: '把聊天记录打成 QQ 合并转发发出。默认发当前会话。nodes 与 fromArchive 二选一。最多约 20 条。跨群转发请填 targetChatKey（如 group:123 或纯群号）。',
    category: 'message',
    icon: '📜',
    parameters: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description: '节点列表；与 fromArchive 二选一',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '发送者昵称' },
              uin: { type: ['string', 'integer'], description: '发送者 QQ 号' },
              content: { type: 'string', description: '文本内容' }
            },
            required: ['content']
          }
        },
        fromArchive: { type: 'boolean', description: 'true=从当前/指定会话存档取最近消息' },
        sourceChatKey: { type: 'string', description: 'fromArchive 时的源会话，默认当前' },
        query: { type: 'string', description: 'fromArchive 时可选过滤关键词' },
        limit: { type: 'integer', description: 'fromArchive 取最近多少条' },
        targetChatKey: { type: 'string', description: '目标：group:123 / private:456 或纯数字群号。默认当前会话' }
      }
    },
    async execute(ctx, args) {
      try {
        if (!ctx.chatKey) return { content: '缺少当前会话', isError: true };

        let target = ctx.chatKey;
        const rawTarget = String(args?.targetChatKey || '').trim();
        if (rawTarget) {
          if (/^\d{5,15}$/.test(rawTarget)) target = `group:${rawTarget}`;
          else if (/^(group|private):\d{5,15}$/.test(rawTarget)) target = rawTarget;
          else return { content: 'targetChatKey 需要是群号或 group:/private: 形式', isError: true };
        }

        let list = [];
        if (args?.fromArchive === true) {
          const lim = Math.min(maxNodes(), Math.max(1, Number(args?.limit) || defaultLimit()));
          const q = String(args?.query || '').toLowerCase();
          const sourceKey = String(args?.sourceChatKey || '').trim() || ctx.chatKey;
          const recent = ctx.store?.recent?.(sourceKey, { limit: Math.min(200, lim * 8) }) || [];
          list = recent
            .filter((m) => {
              const t = String(m.text || '').trim();
              if (!t || /^\[合并转发聊天记录\]$/.test(t)) return false;
              if (!q) return true;
              return t.toLowerCase().includes(q);
            })
            .slice(-lim)
            .map((m) => ({
              name: m.self ? (ctx.botName || '机器人') : (m.sender?.name || String(m.senderId || '')),
              uin: m.self ? (ctx.selfId || '0') : String(m.senderId || ''),
              content: String(m.text || '').trim()
            }));
        } else if (Array.isArray(args?.nodes)) {
          list = args.nodes.slice(0, maxNodes()).map((n) => ({
            name: String(n?.name || '群友').slice(0, 20),
            uin: String(n?.uin || '0').replace(/^0+/, '') || '0',
            content: String(n?.content || '').trim()
          })).filter((n) => n.content);
        }

        if (!list.length) return { content: '没有可打包的消息节点', isError: true };

        const [kind, id] = target.split(':');
        const forwardNodes = list.map((n) => ({
          type: 'node',
          data: {
            name: n.name,
            uin: String(n.uin || '0'),
            content: [{ type: 'text', text: n.content }]
          }
        }));

        // 优先走 sender 队列；失败再退回 onebot.call
        let okSend = false;
        if (ctx.sender?.sendSegments) {
          try {
            await ctx.sender.sendSegments(target, [{ type: 'forward', data: forwardNodes }]);
            okSend = true;
          } catch (e) {
            log('sendSegments forward 失败，改 onebot.call：', e?.message ?? e);
          }
        }
        if (!okSend) {
          const action = kind === 'private' ? 'send_private_forward_msg' : 'send_group_forward_msg';
          const params = kind === 'private'
            ? { user_id: Number(id), messages: forwardNodes }
            : { group_id: Number(id), messages: forwardNodes };
          await ctx.onebot.call(action, params);
        }

        return { content: `已发送合并转发（${list.length} 条节点）→ ${target}` };
      } catch (e) {
        return { content: `合并转发失败：${e?.message ?? e}`, isError: true };
      }
    }
  });
}
