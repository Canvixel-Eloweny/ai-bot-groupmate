import http from 'node:http';

/**
 * 最小 OpenAI 兼容服务端，用来在自测里顶替真实模型。
 * 按最后一个 user 消息里的关键词返回不同结果，覆盖分句 / 潜水 / CQ 注入三种分支。
 *
 * 第 46 轮 B12e-1 起还覆盖 **function calling**：关键词 `用工`（调一次工具就够）
 * 与 `工具死循环`（永远只想调工具，用来验回合上限那条兜底）。
 * 两条都**只在请求真的带上了 function 型 tools 时**才生效 ——
 * 不带 tools 的请求（也就是生产里"一个工具都没注册"的那种）走的还是原来的分支，
 * 所以既有用例的行为一个字都没变。
 */
export function startMockLlm({ port, model = 'mock-model' }) {
  const calls = [];

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400).end('bad json');
          return;
        }
        calls.push(parsed);

        // ── 复刻「思考吃掉额度」这一类真机失败（2026-09-23 加）──────────────
        //
        // 真机实测：配置 `thinking.mode:'on'` 时，自动记忆判断（`maxTokens: 160`）的
        // content **恒为空**、`finish_reason:'length'` —— 额度全花在 `reasoning_content` 上。
        // 表现是结构化记忆在真机上一条都没落过盘，而**四层回归全绿**
        // （原来的 mock 永远返回 200 + 有内容，这一整类失败它模拟不出来）。
        //
        // ⚠️ 触发条件必须**同时**满足「显式 `thinking:{type:'enabled'}`」与「小额度」——
        //    少任何一个条件都会把既有用例卷进来（它们要么不带 thinking、
        //    要么用配置默认的 400，走的仍是原来的分支）。
        if (parsed.thinking?.type === 'enabled' && Number(parsed.max_tokens) <= 200) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            model: parsed.model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: '', reasoning_content: '（思考把 max_tokens 吃光了）' },
              finish_reason: 'length',
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }));
          return;
        }

        const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user');
        const text = lastUser?.content ?? '';
        // 已经回灌过一次工具结果了吗（对话里出现过 role:'tool'）
        const sawToolResult = (parsed.messages ?? []).some((m) => m.role === 'tool');
        const fnTools = (parsed.tools ?? []).filter((t) => t?.type === 'function');
        const toolMsg = toolCallBranch(text, fnTools, sawToolResult);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            model: parsed.model,
            choices: [{
              index: 0,
              message: toolMsg ?? { role: 'assistant', content: pickReply(text) },
              finish_reason: toolMsg ? 'tool_calls' : 'stop',
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      });
      return;
    }

    res.writeHead(404).end('not found');
  });

  server.listen(port);

  return {
    calls,
    listening: new Promise((r) => server.on('listening', r)),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/**
 * function calling 分支。返回 `null` 表示"走原来的纯文本分支"。
 *
 * ⚠️ 三条都必须在：`fnTools` 非空（真带上了 function 型 tools）、关键词命中、
 *    以及"还没回灌过工具结果"（否则会无限调下去，测的就不是回合而是死循环）。
 *    第二条里 `工具死循环` 是**故意**不看 `sawToolResult` 的 —— 它就是用来
 *    把回合上限顶出来的样本。
 */
function toolCallBranch(text, fnTools, sawToolResult) {
  if (!fnTools.length) return null;
  const names = fnTools.map((t) => t?.function?.name ?? '');
  const mk = (args) => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_mock_1', type: 'function', function: { name: names[0], arguments: args } }],
  });
  /**
   * D18：**按名字**挑一个工具（上面那个 `mk` 取的是排在第一位的那个）。
   *
   * ⚠️ 必须按名字挑：`registry.specs()` 是**按名字排序**的，`get_chats` 排在 `send_to` 前面 ——
   *    沿用"取第一个"的话，"跨会话发言"这条用例会**悄悄变成"调了 get_chats"**：
   *    全绿，但真正要验的那条路一步都没走。
   *    （这与"断言存在 ≠ 断言接线"是同一族，只是发生在**夹具**里。）
   */
  const pick = (want, args) => {
    const name = names.includes(want) ? want : names[0];
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_mock_1', type: 'function', function: { name, arguments: args } }],
    };
  };
  if (String(text).includes('工具死循环')) return mk('{"q":"loop"}');
  if (String(text).includes('跨群说') && !sawToolResult) return pick('send_to', '{"group":"20022","text":"你们那边在聊什么"}');
  if (String(text).includes('看看别群') && !sawToolResult) return pick('get_chats', '{}');
  if (String(text).includes('用工') && !sawToolResult) return mk('{"q":"西安"}');
  // 参数故意写成非法 JSON：验"模型偶尔吐错格式"不许炸掉这一轮
  if (String(text).includes('工具坏参数') && !sawToolResult) return mk('{不是JSON');
  return null;
}

function pickReply(text) {
  if (text.includes('分句')) return '第一句||第二句||第三句';
  if (text.includes('潜水')) return '[SILENT]';
  if (text.includes('注入')) return '[CQ:at,qq=all] 都来看这个';
  if (text.includes('超长')) return '啊'.repeat(500);
  return '收到，我在';
}
