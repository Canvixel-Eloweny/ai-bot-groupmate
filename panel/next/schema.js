/**
 * ══════════════════════════════════════════════════════════════════════════
 *  QQ-BOT-CONTROL v2 · 页面骨架的**唯一声明处**
 * ══════════════════════════════════════════════════════════════════════════
 *  这个文件里没有一行渲染代码。整个控制台长什么样，就是下面这份数据：
 *
 *      GROUPS[]        一级导航（功能域）
 *        .subs[]       二级导航（页面）
 *          .cards[]    页面里的卡片
 *            .ctrls[]  卡片里的控件 / 读数 / 按钮
 *
 *  ── 想加一个页面？ ──────────────────────────────────────────────────────
 *  在某个 `subs` 里插一项，`id/label/title/cards` 四样写全即可。
 *  想删一个页面？删掉那一项。**不需要改 app.js、不需要改 CSS。**
 *
 *  ── 想加一个控件？ ──────────────────────────────────────────────────────
 *  在 `ctrls` 里插一项并写明 `t`（类型）。可选类型见文件末尾的 `CTRL_KINDS`。
 *  凡是「存进 custom」的控件，写 `bind:'<custom 下的点号路径>'`；
 *  凡是「顶层 config 字段」，写 `bindSys:'<字段名>'`；
 *  凡是「立即生效」的，写 `save:(v, s) => ({ url, body })`。
 *  渲染器不认识某个 `t` 时**会当场画出红框报错**，不会静默跳过
 *  （静默跳过 = 页面上少一个控件，而没人会往"少写了类型"上想）。
 *
 *  ── 两条纪律（与本仓库既有约定一致） ────────────────────────────────────
 *  ① **中文文案不许在别处再抄一份**：能由后端下发的（增强项 12 项、场景 9 项、
 *     回复长短、扮演规则、插件设置项类型）一律走 `s.customMeta` / `s.extensions`，
 *     本文件只写"摆在哪一格"。写死的那几处是**首屏兜底**，后端一到就被覆盖。
 *  ② **接口地址只写真的**：`save()` 返回的 url 必须在 `panel/server.js` 里存在，
 *     且请求体字段与 `docs/API_CONTRACT.md` 一致。新增控件前先核一遍。
 *
 *  ⚠️ 它**就是现役控制台**（2026-10-02 换主）：服务端 `GET /` 发的就是本页。
 *     旧的那套（`panel/parts/` 的 16 片段 + 它的清单模块）已在 **S-12 第六批
 *     （2026-10-05）整块删除** —— 文件都不在仓库里了（反向闸门在 check-wb §66：
 *     那套机制不许回到运行时）。
 *     它也是一份**用真实数据**的控制台：读的是本机真实的 `panel/` 与 `data/`。
 *     ⚠️ 2026-10-04 修正：此处原写「可独立运行的原型：`node tools/serve-next.mjs`」，
 *     而那个文件与 `tools/` 目录**从未入库** —— 照它敲命令只会得到 no such file。
 */

/* ────────────────────────────────────────────────────────────────────────
   0. 常用小工具（只在本文件内用）
   ──────────────────────────────────────────────────────────────────────── */
const j = (s, p, d) => p.reduce((o, k) => (o == null ? undefined : o[k]), s) ?? d;
const activePreset = (s) => j(s, ['config', 'activePreset'], 'zhipu');
const metric = (label, calc, hi = false) => ({ n: calc, l: label, hi });
const kv = (k, calc) => [k, calc];
/* ⚠️ `ico` / `icoTo` 是 2026-10-02 加的两个可选参数（图标变形）：
     `ico`    静态图标名
     `icoTo`  变形目标（**可以是函数**，按状态算）。给了它，
              状态一变图标就"化"过去 —— 见app.js 的 `mountMorphIcons`。
   放在最后是为了不改动已有调用点（前四个参数的位置没变）。 */
const act = (label, action, style = 'btn-ghost', hint = '', ico = '', icoTo = '') =>
  ({ t: 'button', label, action, style, hint, ico, icoTo });

/* ────────────────────────────────────────────────────────────────────────
   1. 页面骨架
   ──────────────────────────────────────────────────────────────────────── */
export const GROUPS = [
  /* ══════════════════ ① 运行 ══════════════════ */
  {
    id: 'run', label: '运行',
    subs: [
      {
        id: 'overview', label: '总览', title: '运行总览',
        desc: '机器人在不在跑、容器登没登录、内存够不够 —— 以及所有"出问题时才点"的动作。',
        cards: [
          {
            id: 'status', title: '运行状态', span: 8,
            desc: '从下往上：Docker → 容器 → 协议端 → 机器人。哪一步断了，这里会停在哪一步。',
            ctrls: [
              { t: 'steps', label: '启动链路', source: (s) => s.__steps || [] },
              /* ⚠️ 原来是 6 行 `kv`（等权两列文本）。改成状态卡组 + 端口三态：
                 原来那 6 行把「进程 / 实例数 / 容器 / 端口 / 面板 / 账号」
                 压成等权文本，读者得**逐行读字**才找得到坏的那个。
                 而这页的信息**天然分三态**，三态就该有三种视觉（`data-st`）。
                 数据一个没丢，只是从"文字"变成了"卡片"。 */
              { t: 'statusGrid', items: [
                { ico: 'bot', label: '机器人',
                  value: (s) => (j(s, ['bridge', 'running']) ? '在跑' : '没在跑'),
                  sub: (s) => (j(s, ['bridge', 'running'])
                    ? `pid ${j(s, ['bridge', 'pid'], '—')} · ${fmtDur(j(s, ['bridge', 'uptimeMs'], 0))}`
                    : '点「启动机器人」开起来'),
                  st: (s) => (j(s, ['bridge', 'running']) ? 'ok' : 'bad') },
                { ico: 'layers', label: '实例数',
                  value: (s) => `${j(s, ['bridge', 'instances'], 0)} 个`,
                  sub: () => '面板只认自己的入口进程',
                  st: (s) => (j(s, ['bridge', 'instances'], 0) > 1 ? 'warn' : 'ok') },
                { ico: 'container', label: '容器',
                  value: (s) => (j(s, ['container', 'line'], '') || '—'),
                  sub: () => 'NapCat（QQ 协议端）',
                  st: (s) => (j(s, ['container', 'line']) ? 'ok' : 'bad') },
                { ico: 'monitor', label: '面板',
                  value: (s) => `pid ${j(s, ['panel', 'pid'], '—')}`,
                  sub: (s) => `已运行 ${fmtDur(j(s, ['panel', 'uptimeMs'], 0))}`,
                  st: 'ok' },
                { ico: 'user', label: '登录账号',
                  value: (s) => j(s, ['account', 'nickname'], '未登录'),
                  sub: () => '真 QQ 号只在本机 .env 里',
                  st: (s) => (j(s, ['account', 'nickname']) ? 'ok' : 'warn') },
              ] },
              /* 端口**拆成三格**而不是拼成一行 `HTTP 通 · WS 通 · WebUI 通` ——
                 三条各自独立（HTTP 通但 WS 断是真实故障），
                 拼一行时坏的那个要被逐字读出来，拆开它自己会变红。 */
              { t: 'ports', label: '协议端端口', items: [
                { label: 'HTTP', get: (s) => j(s, ['ports', 'onebotHttp']) },
                { label: 'WS', get: (s) => j(s, ['ports', 'onebotWs']) },
                { label: 'WebUI', get: (s) => j(s, ['ports', 'webui']) },
              ] },
              { t: 'note', text: '睡眠那一行是**只读**的：改作息在「发言与时机 → 睡眠作息」页，手动让它睡 / 叫它醒走的是控制通道（不改配置）。' },
              { t: 'sleepLine', label: '作息' },
              { t: 'buttons', label: '让它睡 / 叫它醒', items: [
                act('让它睡', 'cmd.sleep', 'btn-ghost', '内存态：重启机器人即恢复按作息走', 'moon'),
                act('叫它醒', 'cmd.wake', '', '', 'sun'),
              ] },
              /* ⚠️ 启动/停止这一对用**图标变形**：
                 状态变时 play ��� stop 连贯地化过去，而不是突然换一张图。
                 `icoTo` 由状态算出 ⇒ 同一个按钮，两种形态。
                 （行内开关那些没配图标 —— 液态效果已经在那里了，再加图标会过载。） */
              { t: 'buttons', label: '进程', items: [
                act('启动机器人', 'bridge.start', 'btn-primary', '', 'play',
                    (s) => (j(s, ['bridge', 'running']) ? 'stop' : 'play')),
                act('停止机器人', 'bridge.stop', 'btn-danger', '', 'stop',
                    (s) => (j(s, ['bridge', 'running']) ? 'stop' : 'play')),
                { t: 'pill', calc: (s) => ({ text: j(s, ['bridge', 'running']) ? '机器人在跑' : '机器人没在跑', cls: j(s, ['bridge', 'running']) ? 'on' : '' }) },
              ] },
              { t: 'buttons', label: '当前这一轮', hint: '动的是"正在进行的那一轮"，不是进程。结果由机器人写回命令文件，这里只显示状态。', items: [
                act('中止本轮', 'cmd.abort', '', '', 'stop'),
                act('重试本轮', 'cmd.retry', '', '', 'reload'),
                { t: 'hint', calc: (s) => controlHintOf(s) },
              ] },
              { t: 'buttons', label: '排查与运维', items: [
                act('连接自检', 'check', '', '', 'search'),
                act('读取群列表', 'groups.load', '', '', 'list'),
                act('打开 QQ 登录页', 'open.webui', '', '', 'network'),
                act('重启 QQ 容器', 'napcat.restart', '', '', 'reload'),
              ] },
              { t: 'switch', id: 'dbg.log', label: '详细日志',
                hint: '打开后，每条被忽略的消息都会写清是被什么规则挡掉的。',
                read: (s) => !!s.debugLog,
                save: (v) => ({ url: '/api/debug', body: { on: v } }) },
              { t: 'buttons', label: '危险', items: [
                act('一键全停', 'stopall', 'btn-danger', '机器人 + 本机模型 + QQ 容器一起停（Docker Desktop 保留）'),
              ] },
            ],
          },
          {
            id: 'health', title: '健康与占用', span: 4,
            desc: '内存吃紧时本机模型 + Docker 会很挤 —— 与其被系统悄悄杀掉，不如提前看见。',
            ctrls: [
              { t: 'metrics', items: [
                metric('内存占用率', (s) => `${j(s, ['memory', 'pressure'], 0)}%`, true),
                metric('空闲内存', (s) => `${j(s, ['memory', 'freeGB'], '—')} GB`),
                metric('机器人进程', (s) => `${j(s, ['memory', 'procs', 'bridgeMB'], 0)} MB`),
                metric('本机模型', (s) => `${j(s, ['memory', 'procs', 'localModelMB'], 0)} MB`),
                metric('Docker', (s) => `${j(s, ['memory', 'procs', 'dockerMB'], 0)} MB`),
                metric('面板自身', (s) => `${j(s, ['memory', 'procs', 'panelMB'], 0)} MB`),
              ] },
              { t: 'kv', rows: (s) => [
                kv('实例锁', () => (j(s, ['bridge', 'lock']) ? `被 pid ${s.bridge.lock.pid} 持有` : '无')),
                kv('可回滚的配置版本', () => `${j(s, ['configHistory'], 0)} 步`),
                kv('运行中的代码', () => (j(s, ['effective', 'alive']) ? `pid ${s.effective.pid} · ${j(s, ['effective', 'model'], '—')}` : '机器人没在跑')),
                kv('插件（磁盘）', () => `${j(s, ['extensions', 'sum', 'total'], 0)} 个 · 可加载 ${j(s, ['extensions', 'sum', 'load'], 0)}`),
              ] },
              { t: 'note', text: '「实例锁」出现而机器人没在跑，就是"点了启动会被拒"的那一刻 —— 面板**不提供**强制接管（删锁是危险动作，交脚本或人工）。' },
            ],
          },
        ],
      },
      {
        id: 'sessions', label: '会话', title: '会话（现在在跟谁聊）',
        desc: '数据源是 <code>local-trace.jsonl</code>：有界窗口，反映最近活动。与「存档」故意不合并 —— 合并会在截断时静默丢数据。',
        cards: [{
          id: 'sessions', title: '会话列表与明细', span: 12,
          ctrls: [{ t: 'sesList', from: 'sessions' }, { t: 'sesDetail' }],
        }],
      },
      {
        id: 'chats', label: '存档', title: '存档（之前聊过什么）',
        desc: '机器人退出 / 定时归档时写的全量历史。面板**只读** —— "该不该恢复存档"是机器人的判据。',
        cards: [{
          id: 'chats', title: '消息存档', span: 12,
          ctrls: [{ t: 'chatList', from: 'chats' }, { t: 'chatDetail' }],
        }],
      },
      {
        id: 'trace', label: '对话流', title: '模型对话流',
        desc: '一条条摆出来：群里说了什么 → 发给模型的完整提示词 → 模型原始输出 → 实际发到群里的分段。本机模型答得不好时不用猜。',
        cards: [
          {
            id: 'try', title: '试一句', span: 12,
            desc: '走真配置、真人格、真模型，只是不碰 QQ。云端会花几分钱，本机免费但慢十几秒。',
            ctrls: [
              { t: 'text', id: 'try.text', label: '要它回什么', ph: '例如：小鱼在不，随便聊两句呗', wide: true, volatile: true },
              { t: 'buttons', label: '', items: [act('试一句', 'try.run', 'btn-primary')] },
              { t: 'tryOut' },
            ],
          },
          {
            id: 'tracelist', title: '最近的经过', span: 12,
            ctrls: [
              { t: 'traceList', from: 'trace' },
              { t: 'buttons', label: '', items: [act('清空记录', 'trace.clear', 'btn-danger')] },
            ],
          },
        ],
      },
      {
        id: 'logs', label: '日志与审计', title: '日志与审计留档',
        desc: '日志是面板内存里的环形缓冲（封顶 600 行）；审计是 <code>audit.jsonl</code>（谁在什么时候改了什么）。',
        cards: [
          {
            id: 'logs', title: '运行日志', span: 6,
            ctrls: [
              { t: 'logList', from: 'logs' },
              { t: 'buttons', label: '', items: [act('清空日志', 'logs.clear', 'btn-danger')] },
            ],
          },
          {
            id: 'audit', title: '审计留档', span: 6,
            desc: '只读路由 <code>GET /api/audit</code>。旧页面**不读它** —— 这里第一次把它摆出来。',
            ctrls: [{ t: 'auditList', from: 'audit' }],
          },
        ],
      },
    ],
  },

  /* ══════════════════ ② 大脑 ══════════════════ */
  {
    id: 'brain', label: '大脑',
    subs: [
      {
        id: 'model', label: '模型与线路', title: '大脑（用哪个模型聊天）',
        desc: '三套大脑各自有一套设置，只摆当前那套 —— 在 DeepSeek 页面上能点到智谱的模型，正是上一版误报错的来源。',
        cards: [
          {
            id: 'switch', title: '一键切换', span: 4,
            desc: '点一下<b>立即生效</b>，不用再点保存。切到云端会自动关掉本机模型，把内存还给你。',
            ctrls: [
              { t: 'modebar', calc: (s) => brainModeOf(s) },
              { t: 'buttons', label: '', items: [
                act('用本机模型（免费·不联网）', 'switch.local', 'btn-ghost'),
                act('用 DeepSeek 云端', 'switch.cloud', 'btn-ghost'),
                act('用智谱免费云端', 'switch.zhipu', 'btn-ghost'),
              ] },
              { t: 'kv', rows: (s) => [
                kv('正在生效', () => j(s, ['effective', 'model'], '—')),
                kv('接口地址', () => j(s, ['effective', 'baseUrl'], '—')),
                kv('降级链', () => (j(s, ['effective', 'fallbackModels'], []) || []).join(' → ') || '无'),
                kv('机器人读入配置于', () => (j(s, ['effective', 'since']) ? new Date(s.effective.since).toLocaleString() : '—')),
              ] },
            ],
          },
          {
            id: 'local', title: '本机模型', span: 4,
            when: (s) => j(s, ['effective', 'isLocal']) === true,
            ctrls: [
              { t: 'kv', rows: (s) => [
                kv('状态', () => (j(s, ['localModel', 'running']) ? '在跑' : (j(s, ['localModel', 'starting']) ? '启动中…' : '没在跑'))),
                kv('当前通道', () => j(s, ['localModel', 'channel'], '—')),
                kv('MLX 端口', () => `${j(s, ['localModel', 'ports', 'mlx'], '—')}`),
                kv('QwenChat 端口', () => `${j(s, ['localModel', 'ports', 'qwenchat'], '—')}`),
              ] },
              { t: 'select', id: 'local.size', label: '规格', volatile: true,
                options: (s) => (j(s, ['localModel', 'ids'], []) || []).map((x) => ({ v: x, l: x })),
                read: (s) => j(s, ['config', 'localSize'], '4b'),
                save: (v) => ({ url: '/api/switch', body: { target: 'local', size: v } }) },
              { t: 'seg', id: 'local.channel', label: '推理通道', volatile: true,
                options: [{ v: 'mlx', l: 'MLX · 稳' }, { v: 'qwenchat', l: 'QwenChat · 带前缀缓存' }],
                read: (s) => j(s, ['localModel', 'wantChannel'], 'mlx'),
                hint: '同一个模型有两套本地服务，二选一。前缀缓存让长对话不必重算整段历史。',
                save: (v) => ({ url: '/api/config', body: { localChannel: v } }) },
              { t: 'buttons', label: '', items: [
                act('启动本机模型', 'local.start', 'btn-primary'),
                act('停止本机模型', 'local.stop', 'btn-danger'),
                act('打开 QwenChat 界面', 'open.qwenchat'),
              ] },
            ],
          },
          {
            id: 'cloud', title: '云端设置', span: 4,
            when: (s) => j(s, ['effective', 'isLocal']) === false,
            desc: '地址按当前大脑自动填并且锁住 —— 手填地址正是上一版误报错的来源。',
            ctrls: [
              { t: 'text', id: 'cfg.baseUrl', label: '模型接口地址', readonly: true, wide: true,
                read: (s) => j(s, ['config', 'baseUrl'], '') },
              { t: 'password', id: 'cfg.apiKey', label: 'API Key', ph: '留空则不修改已保存的 Key',
                save: (v) => (v ? { url: '/api/config', body: { apiKey: v } } : null),
                hint: (s) => (j(s, ['config', 'hasKey']) ? `已保存：${j(s, ['config', 'keyMasked'], '')}` : '尚未配置（本机模型不需要 Key）') },
              { t: 'modelPick', label: '模型' },
            ],
          },
          {
            id: 'route', title: '优先级线路（智谱）', span: 6,
            when: (s) => j(s, ['config', 'provider']) === 'zhipu',
            desc: '机器人按这里的顺序从上往下试，谁先应就用谁。第 1 条是主模型；被限流 / 超时 / 故障时自动换下一条。',
            ctrls: [
              { t: 'routeBoard' },
              { t: 'packages', label: '赠送额度' },
            ],
          },
        ],
      },
      {
        id: 'thinking', label: '思考与能力', title: '思考模式与能力开关',
        cards: [
          {
            id: 'think', title: '思考模式', span: 6,
            desc: '开启后模型先把推理过程写一遍再回答：复杂问题更准，但更慢更贵。档位名各家不同，按当前服务商换选项。',
            ctrls: [
              { t: 'seg', id: 'cfg.thinkMode', label: '模式', volatile: true,
                options: (s) => thinkModesOf(s),
                read: (s) => j(s, ['config', 'thinking', 'mode'], 'on'),
                save: (v, s) => ({ url: '/api/config', body: { thinking: { mode: v, level: j(s, ['config', 'thinking', 'level']) } } }) },
              { t: 'seg', id: 'cfg.thinkLevel', label: '强度', volatile: true,
                options: (s) => thinkLevelsOf(s),
                read: (s) => j(s, ['config', 'thinking', 'level'], 'low'),
                save: (v, s) => ({ url: '/api/config', body: { thinking: { mode: j(s, ['config', 'thinking', 'mode']), level: v } } }) },
              { t: 'note', text: '两格共用同一个 <code>thinking</code> 对象，所以提交时会把当前另一格的值一起带上（不能只发半份）—— 服务端按 <code>normalizeThinking</code> 归一化，非法档位会被驳回并如实告知。' },
            ],
          },
          {
            id: 'caps', title: '能力开关', span: 6,
            desc: '前三个是<b>模型能力</b>：当前大脑做不到的会灰掉并写明原因（摆在页面上能点却不生效更糟）。「主动发言」与模型无关，是行为层总闸。',
            ctrls: [
              { t: 'featSwitch', feat: 'webSearch', label: '联网查询', hint: '遇到不懂的梗、新闻、人物时让它上网查，每条多花 2–8 秒' },
              { t: 'featSwitch', feat: 'vision', label: '识图', hint: '群里有人发图时，它能看懂图里说了什么' },
              { t: 'featSwitch', feat: 'stickers', label: '发 QQ 表情', hint: '允许它在回复里插 QQ 表情' },
              { t: 'switch', id: 'cfg.proactive', label: '主动发言', volatile: true,
                hint: '总闸：关掉之后插话 / 定时主动 / 定时消息全都不再发声（关键词触发不受影响）。',
                read: (s) => j(s, ['custom', 'allowProactive'], true),
                save: (v) => ({ url: '/api/config', body: { custom: { allowProactive: v } } }) },
              { t: 'note', text: '这四个和「人格 → 能力开关」是<b>同一份配置</b>，改任一处另一处立刻跟上 —— 本页只在一处摆它们，不做两份副本。' },
            ],
          },
        ],
      },
      {
        id: 'usage', label: '用量与花费', title: '用量与花费',
        cards: [
          {
            id: 'cost', title: '花费', span: 12,
            ctrls: [
              { t: 'modebar', calc: (s) => costModeOf(s) },
              { t: 'metrics', items: [
                metric('剩余余额', (s) => j(s, ['__balance'], '点「查余额」')),
                metric('今日花费', (s) => `¥${Number(j(s, ['usage', 'today', 'cost'], 0)).toFixed(4)}`, true),
                metric('累计花费', (s) => `¥${Number(j(s, ['usage', 'cost'], 0)).toFixed(4)}`),
                metric('平均每条', (s) => (j(s, ['usage', 'calls'], 0) ? `¥${Number(j(s, ['usage', 'avgCost'], 0)).toFixed(4)}` : '—')),
                metric('输出 token（含思考）', (s) => fmtNum(j(s, ['usage', 'completion'], 0))),
                metric('累计条数', (s) => `${fmtNum(j(s, ['usage', 'calls'], 0))}（免费 ${fmtNum(j(s, ['usage', 'freeCalls'], 0))}）`),
              ] },
              { t: 'usageBySource', label: '按来源分开算账（D29）' },
              { t: 'usageTable', label: '最近记录' },
              { t: 'buttons', label: '', items: [
                act('查余额', 'balance.load'),
                act('清零统计', 'usage.reset', 'btn-danger', '清掉 panel/ 下**所有** usage*.jsonl（账本按月切分，只删当月那份按下去看着没反应）'),
              ] },
            ],
          },
        ],
      },
      {
        id: 'deals', label: '免费额度情报', title: '免费额度情报（旧页面的骨架页）',
        desc: '插件 <code>AI额度情报</code>（api-deals）定时抓的「哪些模型现在免费 / 有什么限时活动」。旧控制台里这一页写着"已有等价物，只缺一个看得见的地方" —— <b>这里就是那个地方</b>：面板直接读 <code>data/api-deals.json</code>。',
        cards: [{
          id: 'deals', title: '抓到的条目', span: 12,
          ctrls: [{ t: 'apiDeals' }],
        }],
      },
      {
        id: 'context', label: '上下文预算', title: '上下文预算',
        desc: '发多少历史给模型、带多少条群里闲聊当背景。这两格属于<b>当前大脑的预设</b>，旧页面没有控件。',
        cards: [{
          id: 'ctx', title: '条数与背景', span: 6,
          ctrls: [
            { t: 'number', id: 'ctx.turns', label: '带入最近几轮对话', min: 0, max: 40, step: 1, volatile: true,
              read: (s) => j(s, ['config', 'presets', activePreset(s), 'context', 'recentTurns'], 6),
              save: (v) => ({ url: '/api/config', body: { context: { recentTurns: Number(v) } } }) },
            { t: 'number', id: 'ctx.ambient', label: '带入几条群里闲聊当背景', min: 0, max: 60, step: 1, volatile: true,
              read: (s) => j(s, ['config', 'presets', activePreset(s), 'context', 'ambientMessages'], 8),
              save: (v) => ({ url: '/api/config', body: { context: { ambientMessages: Number(v) } } }) },
            { t: 'note', text: '这两格属于<b>当前大脑的预设</b>：切大脑时各自记各自的值（服务端 <code>stashCurrentPreset</code> 负责归档）。' },
          ],
        }],
      },
    ],
  },

  /* ══════════════════ ③ 人格 ══════════════════ */
  {
    id: 'persona', label: '人格',
    subs: [
      {
        id: 'who', label: '人格设定', title: '人格设定（它是谁）',
        desc: '决定它说话像谁。留空就用 <code>persona/</code> 里的人设文件，填了就叠加上去。改完点页面底部的「保存并生效」。',
        draft: true,
        cards: [
          {
            id: 'basic', title: '他是谁', span: 6,
            ctrls: [
              { t: 'text', id: 'p.name', label: '机器人昵称', bindSys: 'personaName', ph: '例如：小鱼',
                hint: '与「机器人设置 → 通用设置」共用同一个值（顶层 personaName，不在 custom 里）。' },
              { t: 'text', id: 'p.age', label: '年龄', bind: 'persona.age', ph: '例如：24' },
              { t: 'text', id: 'p.role', label: '身份', bind: 'persona.role', ph: '例如：刚毕业的程序员' },
              { t: 'text', id: 'p.world', label: '时代 / 世界观', bind: 'persona.world',
                ph: '例如：当代都市 / 修真世界 / 近未来赛博城', hint: '影响他举什么例子、用什么词。' },
              { t: 'textarea', id: 'p.desire', label: '核心欲望', bind: 'persona.desire', rows: 2, ph: '例如：想让群里的人认可他' },
              { t: 'textarea', id: 'p.fear', label: '核心恐惧 / 弱点', bind: 'persona.fear', rows: 2, ph: '例如：最怕没人理他' },
            ],
          },
          {
            id: 'voice', title: '他怎么说话', span: 6,
            ctrls: [
              { t: 'text', id: 'p.traits', label: '性格关键词', bind: 'persona.traits', ph: '活泼、爱吐槽、嘴贫但没恶意' },
              { t: 'textarea', id: 'p.tone', label: '说话方式', bind: 'persona.tone', rows: 2, ph: '短句为主，多用语气词……' },
              { t: 'text', id: 'p.catch', label: '口头禅', bind: 'persona.catch', ph: '有一说一 / 绷不住了' },
              { t: 'text', id: 'p.faces', label: '喜欢用的表情', bind: 'persona.faces', ph: '狗头、呲牙、拿捏' },
            ],
          },
          {
            id: 'decide', title: '他怎么决定、现在什么状态', span: 12,
            ctrls: [
              { t: 'textarea', id: 'p.logic', label: '行为逻辑', bind: 'persona.logic', rows: 3,
                ph: '遇事怎么决定、压力下什么反应、底线是什么' },
              { t: 'text', id: 'p.attitude', label: '对群里人的态度', bind: 'persona.attitude', ph: '对熟人是损友式亲近，对陌生人先观察两句' },
              { t: 'textarea', id: 'p.status', label: '当前状态', bind: 'persona.status', rows: 2,
                ph: '现在在哪、想做什么、情绪如何 —— 你随时可以手改' },
              { t: 'switch', id: 'p.reset', label: '改人设后丢弃它用旧人设说过的话', bind: 'personaResetOnChange',
                hint: '关掉的话，模型会先照旧口吻说几句，看上去像"人设没改成功"。丢掉的是它自己的发言，你说过的话会留着。' },
            ],
          },
        ],
      },
      {
        id: 'enhance', label: '增强项', title: '增强项（演得有多像）',
        desc: '上一屏是"这个人是谁"，这里是"演得有多像"。12 项全部<b>可留空</b> —— 空着的不进提示词。名称 / 说明 / 示例 / 分组全部由后端下发。',
        draft: true,
        cards: [{ id: 'enh', title: '12 项细节', span: 12, ctrls: [{ t: 'enhance' }] }],
      },
      {
        id: 'reply', label: '回复设置', title: '回复设置',
        desc: '它一条消息多长、要不要 @ 人、两条之间隔多久。',
        draft: true,
        cards: [{
          id: 'reply', title: '长短与习惯', span: 12,
          ctrls: [
            /* ⚠️ 档位刻度（`ticks`）而不是 `seg`：
               短→中→长**有顺序**，而 `.seg` 把三档排成等宽按钮 ——
               按钮间距表达的是"它们同类"，不表达"谁比谁多"。
               刻度把高度接上（近→高），不用读文字就知道大概在哪一档。
               数据来源与 `seg` 完全相同（`customMeta.replyLengths`），
               刻度不另存一份。 */
            { t: 'ticks', id: 'r.len', label: '回复长短', bind: 'replyStyle.length',
              options: (s) => Object.entries(j(s, ['customMeta', 'replyLengths'], {})).map(([v, o]) => ({ v, l: o.label, title: o.hint })) },
            { t: 'switch', id: 'r.multi', label: '允许一件事拆成几条发', bind: 'replyStyle.multiMessage',
              hint: '关掉就不管内容多长都合并成一条长消息。' },
            { t: 'switch', id: 'r.at', label: '回复时 @ 上说话的人', bind: 'replyStyle.mentionAt' },
            { t: 'number', id: 'r.cool', label: '连续回复的最小间隔（秒）', bind: 'replyStyle.cooldownSec',
              bounds: 'cooldownSec',
              hint: (s) => `0 = 只保留底层的 ${fieldNum(s, 'minIntervalMsSec')} 秒防抖。区间由后端下发（field-schema）。` },
            { t: 'note', text: '「要不要发表情包」不在这里 —— 它就是「大脑 → 能力开关 → 发 QQ 表情」，摆两处只会让人以为有两个开关。' },
          ],
        }],
      },
      {
        id: 'scenes', label: '特殊场景', title: '特殊场景',
        desc: '预置几种情况，填了就会作为行为规则加进提示词。留空 = 不干预，它自由发挥。名称与说明由后端下发。',
        draft: true,
        cards: [{ id: 'sc', title: '9 种场景', span: 12, ctrls: [{ t: 'scenes' }] }],
      },
      {
        id: 'rules', label: '扮演规则', title: '扮演规则（底层逻辑）',
        desc: '这不是人设的一部分，而是"扮演这件事本身的规矩"。清单由后端下发（<code>customMeta.playRules</code>），面板不自存。',
        draft: true,
        cards: [{
          id: 'pr', title: '12 条', span: 12,
          ctrls: [
            { t: 'switch', id: 'pr.on', label: '把扮演规则写进提示词', bind: 'playRules',
              hint: '关掉之后，模型就没有"不替用户说话 / 不编造 / 关系要渐进"这些约束了 —— 除非你清楚自己在做什么，否则别关。' },
            { t: 'playRules' },
          ],
        }],
      },
    ],
  },

  /* ══════════════════ ④ 记忆与知识 ══════════════════ */
  {
    id: 'know', label: '记忆与知识',
    subs: [
      {
        id: 'memory', label: '自我记忆', title: '自我记忆',
        desc: '让它长期记住一些事。手动记忆永远生效；自动记录要打开开关。',
        draft: true,
        cards: [
          {
            id: 'overview', title: '它现在记得什么', span: 12,
            desc: '这一栏列出的，是<b>这一轮真的会进提示词</b>的记忆 —— 手动记忆里开着开关的，加上结构化记忆里「已确认」的。',
            ctrls: [{ t: 'memOverview' }],
          },
          {
            id: 'manual', title: '手动管理', span: 6,
            ctrls: [
              { t: 'switch', id: 'm.auto', label: '开启自动记录', bind: 'memory.auto',
                hint: '机器人自己判断哪些话值得长期记住。' },
              { t: 'memList', label: '手动记忆', path: 'memory.manual',
                note: '只能你自己加。这里的每一条都会一直跟着它 —— 与自动记录的开关无关。改完点底部的「保存并生效」。' },
            ],
          },
          {
            id: 'records', title: '结构化记忆', span: 6,
            desc: '机器人自己从群里提炼、且带来源的记忆。每条要被独立观察到几次才会进提示词。点下面的按钮<b>立即生效</b>。',
            ctrls: [{ t: 'memRecords' }],
          },
          {
            id: 'auto', title: '自动记录 · 历史存量', span: 12,
            desc: '早期（第 5 轮之前）攒下来的记录，现在<b>只读、不再新增</b>。留着是为了让你看得见历史；新的记忆都进上面的「结构化记忆」。',
            ctrls: [
              { t: 'autoMemList' },
              { t: 'buttons', label: '', items: [
                act('清空这份历史存量', 'mem.auto.clear', 'btn-danger', '手动记忆与结构化记忆不受影响'),
              ] },
            ],
          },
        ],
      },
      {
        id: 'skills', label: '知识包与角色卡', title: '知识包与角色卡',
        desc: '<b>知识包</b>＝某方面的本事，命中触发词才拿出来用；<b>角色卡</b>＝成套的人格，存多张，点「套用到人格设定」就换一套人。',
        draft: true,
        cards: [{
          id: 'sk', title: '技能清单', span: 12,
          ctrls: [
            { t: 'skills' },
            { t: 'buttons', label: '', items: [
              act('加知识包', 'skill.add.pack'),
              act('加角色卡', 'skill.add.persona'),
            ] },
          ],
        }],
      },
      {
        id: 'people', label: '群友档案', title: '群友档案（旧「知识库」页的真身）',
        desc: '插件 <code>群友印象</code>（people-memory）按 QQ 号跨群记的长期印象与好感度。<b>这一页现在读的是真数据</b> —— 面板直接读 <code>data/memory/people/*.json</code>，一档一文件。',
        cards: [{
          id: 'ppl', title: '印象与好感度', span: 12,
          ctrls: [{ t: 'people' }],
        }],
      },
      {
        id: 'transfer', label: '导入导出', title: '导入 / 导出',
        cards: [
          {
            id: 'exp', title: '下载', span: 6,
            desc: 'Key / Token <b>任何时候都会被清空</b> —— 不提供"连 Key 都不脱敏"的导出。下面这个开关只决定群号与 QQ 号要不要一起藏起来。',
            ctrls: [
              { t: 'seg', id: 'ex.fmt', label: '格式', volatile: true,
                options: [{ v: 'json', l: 'JSON' }, { v: 'txt', l: 'TXT' }, { v: 'zip', l: 'ZIP' }], read: () => 'json' },
              { t: 'switch', id: 'ex.mask', label: '连群号也一起隐藏', volatile: true, read: () => true,
                hint: '发给别人用；关掉则是自己留档。' },
              { t: 'buttons', label: '', items: [
                act('完整配置', 'export.all'), act('人格', 'export.persona'), act('提示词', 'export.prompt'),
                act('规则与场景', 'export.rules'), act('记忆', 'export.memory'), act('技能', 'export.skills'),
                act('运行日志', 'export.log'), act('表情 ID 表', 'export.faces'),
              ] },
            ],
          },
          {
            id: 'imp', title: '导入', span: 6,
            desc: '导入的是<b>工作台这一块</b>（人格、技能、回复、触发、场景、记忆、安全），不会动模型和 Key。<b>导入前先给你看变更清单</b>。',
            ctrls: [
              { t: 'importFile' },
              { t: 'note', text: '确认清单由 <code>POST /api/custom/preview</code> 算：字段级差异 + 技能/记忆/定时的增删改 + 「同一件事记两遍」的冲突提醒 + <b>本次不会碰的字段</b>（让你敢点确认）。' },
            ],
          },
        ],
      },
    ],
  },

  /* ══════════════════ ⑤ 情绪与世界 ══════════════════ */
  {
    id: 'emo', label: '情绪与世界',
    subs: [
      {
        id: 'emotion', label: '情绪世界', title: '情绪世界',
        desc: '本体情绪跨群共享：心情 / 精力 / 压力 / 离散情绪。每轮极轻注入一句状态；聊天事件自动加减情绪。<b>这一页现在读的是真数据</b> —— 面板直接读插件落的 <code>data/bot-state.json</code>，所以机器人没在跑也能看。',
        draft: true,
        cards: [
          { id: 'estate', title: '此刻的状态', span: 7, ctrls: [{ t: 'emotionState' }] },
          { id: 'eset', title: '注入与更新', span: 5, ctrls: [{ t: 'pluginSettings', extId: 'bot-emotion' }] },
        ],
      },
      {
        id: 'world', label: '世界日历', title: '世界日历（节假日与提醒）',
        desc: '给机器人一个"最近发生了什么"的共同背景。真实存在的是 <b>D17 提醒三件套</b>：定时消息的日期维度 + 工作日/休息日 + 30 分钟重试窗。',
        draft: true,
        cards: [
          {
            id: 'cal', title: '节假日表', span: 6,
            ctrls: [
              { t: 'holidays' },
              { t: 'note', kind: 'ok',
                text: '<b>2026-10-02 修好的一条数据链路。</b>此前 <code>custom.holidays</code> 不在 <code>readCustom</code> 的白名单里，而面板保存走整体替换 —— 于是<b>任何一次保存都会把这张表从 config.json 里抹掉</b>（机器人侧只能退化成按星期几兜底）。前端当时其实"带上了它"，但补救写在了白名单的错的一侧，所以从来没生效。现在它进了白名单，<b>往返实测通过</b>（见 <code>docs/FRONTEND-V2.md</code> §5①）。' },
            ],
          },
          {
            id: 'sched', title: '定时消息（提醒）', span: 6,
            ctrls: [
              { t: 'schedList', path: 'trigger.scheduled', detailed: true },
              { t: 'note', kind: 'ok',
                text: '<b>同样修好了一条。</b><code>date</code>（只在那天发一次）与 <code>on</code>（只工作日 / 只休息日）此前被 <code>scheduledItems</code> 归一化时静默剥掉，机器人侧因此 <code>matchesOn(undefined)</code> 恒真、只能按"每天"跑。现在两个字段都在白名单里，且认不出的日期<b>留空而不回落成每天</b>（写错的日子静默变成每天，比不生效更难查）。' },
            ],
          },
        ],
      },
      {
        id: 'unread', label: '未读与跨会话', title: '未读与跨会话发言',
        desc: '两件已交付但面板看不见的事：<b>D30 未读模型</b>（谁消费、何时消费）与 <b>D18 跨会话发言</b>（它能去别的群说一句话）。',
        draft: true,
        cards: [
          {
            id: 'cross', title: '跨会话发言', span: 6,
            ctrls: [
              { t: 'switch', id: 'x.on', label: '允许它去别的群发言', bind: 'crossSend.enabled',
                hint: '开闸后模型才会拿到 get_chats / send_to 两个工具（只在开闸时注册）。出口走独立配额与审计。' },
              { t: 'note', text: '关着的时候这两个工具<b>根本不注册</b> —— 不是"注册了但拒绝"，所以模型不会以为自己有这个能力。' },
            ],
          },
          {
            id: 'unread', title: '未读队列', span: 6,
            ctrls: [{ t: 'unread' }],
          },
        ],
      },
      {
        id: 'faces', label: '表情与图库', title: '表情与图库',
        desc: '它自己的表情资产：QQ 收藏表情（只读接入）+ 可发送的图片库（插件 <code>自定义图库</code>）。',
        draft: true,
        cards: [
          {
            id: 'faces', title: '收藏表情', span: 6,
            ctrls: [
              { t: 'faces' },
              { t: 'note', text: 'D14 是<b>只读接入</b>：令牌 = 图片 URL 的短哈希，出站时按令牌分流。素材由你自己在 QQ 里收藏。' },
            ],
          },
          { id: 'img', title: '自定义图库', span: 6, ctrls: [{ t: 'gallery' }, { t: 'pluginSettings', extId: 'image-lib' }] },
        ],
      },
    ],
  },

  /* ══════════════════ ⑥ 发言与时机 ══════════════════ */
  {
    id: 'speak', label: '发言与时机',
    subs: [
      {
        id: 'trigger', label: '触发方式', title: '触发方式',
        desc: '什么情况下它才开口。放行 / 拉黑名单与「机器人设置」里的通用设置共用同一份配置。',
        draft: true,
        cards: [
          {
            id: 'trg', title: '被叫到', span: 6,
            ctrls: [
              { t: 'switch', id: 't.at', label: '群里必须 @ 才回话', bindSys: 'requireAtInGroup' },
              { t: 'tags', id: 't.kw', label: '包含这些词就回', bind: 'trigger.keywords', ph: '小鱼, 肥鱼, 在吗',
                hint: '命中任意一个就会回，不受「必须 @」限制。关键词触发属于"被叫到"，所以<b>不受主动发言总闸影响</b>。' },
              { t: 'tags', id: 't.allow', label: '放行的群号', bindSys: 'groups', ph: '100000001, 987654321',
                hint: '留空 = 所有群都能放开聊。' },
            ],
          },
          {
            id: 'deny', title: '拉黑', span: 6,
            ctrls: [
              { t: 'tags', id: 't.dg', label: '拉黑的群号', bindSys: 'denyGroups', ph: '这些群里它完全不回话' },
              { t: 'tags', id: 't.du', label: '拉黑的 QQ 号', bindSys: 'denyUsers', ph: '哪怕被 @ 也不回' },
              { t: 'note', kind: 'warn', text: '<b>拉黑优先于放行</b> —— 一个群同时出现在两个名单里，结果是<b>不回</b>。另外「必须 @」和关键词触发都拦不住拉黑。' },
            ],
          },
        ],
      },
      {
        id: 'scheduled', label: '定时消息', title: '定时消息',
        desc: '到点自动在那个群发一句。日期与频次两个维度已在 2026-10-02 修通（此前会被归一化静默剥掉）。',
        draft: true,
        cards: [{
          id: 'sc', title: '时刻表', span: 12,
          ctrls: [
            { t: 'schedList', path: 'trigger.scheduled', detailed: true },
            { t: 'note', kind: 'ok',
              text: '<b>「日期」与「频次」现在真的生效了。</b>修之前 <code>scheduledItems</code> 的白名单里只有 <code>{id, at, text, enabled}</code>，两个维度被静默剥掉 —— 机器人侧 <code>matchesOn(s.on)</code> 恒真、只能按"每天"跑，<b>而回归全绿</b>（D17 的用例把纯函数直接喂字段，没有一条走"经 readCustom 一遍"）。修法是<b>一处</b>（<code>src/custom-config.js</code>），并且契约 §46 已升级成"<b>往返之后仍在</b>"，不再只盯"面板有没有带上"。' },
          ],
        }],
      },
      {
        id: 'proactive', label: '主动与免打扰', title: '主动发言与免打扰',
        desc: '"什么时候它自己起话头"以及"什么时候绝对不许出声"。',
        draft: true,
        cards: [
          {
            id: 'pro', title: '定时主动与插话', span: 6,
            ctrls: [
              { t: 'switch', id: 'pro.on', label: '隔一段时间自己起个新话题', bind: 'trigger.proactive.enabled' },
              { t: 'number', id: 'pro.min', label: '间隔（分钟）', bind: 'trigger.proactive.intervalMin', bounds: 'proactiveIntervalMin',
                when: (s) => !!j(s, ['custom', 'trigger', 'proactive', 'enabled']) },
              { t: 'text', id: 'pro.text', label: '想让它说什么', bind: 'trigger.proactive.text',
                ph: '留空 = 每次由模型自己编一句', when: (s) => !!j(s, ['custom', 'trigger', 'proactive', 'enabled']) },
              { t: 'number', id: 'pr.chance', label: '随机插话概率（%）', bindSys: 'interjectChance', min: 0, max: 100, step: 5,
                hint: '0 = 只有被点名才回。仅在上面的「必须 @」关掉后有效。' },
              { t: 'note', text: '插话还有一层<b>时机</b>判定（活跃期提权 / 冷场降权，D12b）：上面这个概率是基准值，实际掷骰时会乘以因子。因子表在 trace 的 <code>interject</code> 那一格里可见。' },
            ],
          },
          {
            id: 'quiet', title: '免打扰时段', span: 6,
            ctrls: [
              { t: 'number', id: 'q.from', label: '从（点）', bind: 'trigger.quietHours.from', bounds: 'quietFrom' },
              { t: 'number', id: 'q.to', label: '到（点）', bind: 'trigger.quietHours.to', bounds: 'quietTo' },
              { t: 'note', text: '按<b>小时</b>算（24 小时制）。两个数字填成<b>一样</b>就等于关掉免打扰。跨零点会自动处理，不用你操心。' },
              { t: 'note', kind: 'warn', text: '免打扰内：插话、定时主动、定时消息<b>全都不发</b>。但到点的提醒会留在 30 分钟窗口里，出了静默期仍会补发（用户 Q24 裁决）。' },
            ],
          },
        ],
      },
      {
        id: 'sleep', label: '睡眠作息', title: '睡眠 / 作息（D31）',
        desc: '睡着时<b>零 token</b>，消息留着不读；醒来有两条路：正式关键词（限主人）+ 紧急连发。旧页面这一块<b>只有一行只读提示和两个按钮</b>，作息本身没有控件。',
        draft: true,
        cards: [
          {
            id: 'sl', title: '作息表', span: 6,
            ctrls: [
              { t: 'switch', id: 'sl.on', label: '启用作息', bind: 'sleep.enabled',
                hint: '关掉 = 从不睡（自然醒永远为真）。关着的时候下面几格只是**先填好**，不会生效。' },
              { t: 'time', id: 'sl.bed', label: '几点睡', bind: 'sleep.bed' },
              { t: 'time', id: 'sl.wake', label: '几点自然醒', bind: 'sleep.wake' },
              { t: 'tags', id: 'sl.words', label: '叫醒关键词', bind: 'sleep.wakeWords', ph: '起床, 醒醒',
                hint: '只有 <code>owner.qq</code> 里的人说才生效 —— 那一格是顶层配置，旧页面没有控件，<b>也不接受面板写入</b>（不在 /api/config 的入参里）。' },
              { t: 'text', id: 'sl.gn', label: '睡前道晚安', bind: 'sleep.goodnight', ph: '留空 = 不说' },
            ],
          },
          {
            id: 'slnow', title: '现在的睡眠状态', span: 6,
            ctrls: [
              { t: 'sleepDetail' },
              { t: 'buttons', label: '手动', items: [
                act('让它睡', 'cmd.sleep', 'btn-ghost', '内存态，重启即恢复按作息走'),
                act('叫它醒', 'cmd.wake'),
              ] },
            ],
          },
        ],
      },
    ],
  },

  /* ══════════════════ ⑦ 插件 ══════════════════ */
  {
    id: 'plugin', label: '插件',
    subs: [
      {
        id: 'plugins', label: '插件', title: '插件',
        desc: '装在 <code>plugins/</code> 与 <code>skills/</code> 里的第三方插件。目录里有<b>不等于</b>会生效 —— 必须在这里勾上，且要重启机器人（不支持热插拔）。',
        draft: true,
        cards: [
          {
            id: 'plugsum', title: '插件总览与安装', span: 12,
            ctrls: [
              { t: 'pluginSummary' },
              { t: 'importZip', label: '装 ZIP' },
            ],
          },
          {
            id: 'pluggrid', title: '插件清单与设置', span: 12,
            /* ⚠️ `bare: true` = **不套外层 .card**（`cardHtml` 走 `bareHtml`）。
               插件网格自己就是完整的板集合：外面再罩一张 span-12 玻璃板，
               视觉上就变成「大玻璃板里切了 13 块」—— 而用户要的是每块独立浮着。
               那层外壳不是设计，是容器，所以这里把它整个脱掉。 */
            bare: true,
            ctrls: [{ t: 'pluginList' }],
          },
        ],
      },
      {
        id: 'net', label: '联网与范围', title: '联网范围与出站护栏',
        desc: 'D15 的两道护栏：<b>浏览锁定</b>（它只能访问你列出的域名）与<b>图片护栏</b>（一轮最多带几张图出去）。旧页面这两个开关都没有。',
        draft: true,
        cards: [
          {
            id: 'lock', title: '浏览锁定', span: 6,
            ctrls: [
              { t: 'switch', id: 'b.on', label: '启用域名白名单', bind: 'browseLock.enabled',
                hint: '开着时 fail-closed：名单为空 = 谁都不许访问。关掉则按各技能自己声明的权限走。' },
              { t: 'tags', id: 'b.hosts', label: '允许访问的域名', bind: 'browseLock.hosts', ph: 'zh.wikipedia.org, api.bilibili.com',
                hint: '白名单<b>含子域</b>：写 <code>wikipedia.org</code> 就包含 <code>zh.wikipedia.org</code>。',
                when: (s) => !!j(s, ['custom', 'browseLock', 'enabled']) },
              { t: 'note', kind: 'warn', text: '⚠️ <b>技能自带的 fetch 不受这道闸约束</b>：插件里自己写的 <code>fetch()</code> 走的是它自己的路（列表里会标「自带联网」）。这是已知边界，不是配置项。' },
            ],
          },
          {
            id: 'outbound', title: '合并转发与图片护栏', span: 6,
            ctrls: [
              { t: 'switch', id: 'f.on', label: '展开合并转发的正文', bind: 'forwardExpand.enabled',
                hint: 'D23-2：有人发"聊天记录"时，把里面每条消息的文本取出来喂给模型。展开只进 text 不进 bareText，不参与触发判定。' },
              { t: 'note', text: '图片护栏（一轮最多 2 张图出去）是<b>经验值常量</b>，在 <code>src/brain.js</code> 里，没有配置项 —— 与其做一个没人调的滑块，不如把理由写在这里。' },
            ],
          },
          {
            id: 'scope', title: '插件能做什么 / 不能做什么', span: 12,
            ctrls: [{ t: 'pluginScope' }],
          },
        ],
      },
    ],
  },

  /* ══════════════════ ⑧ 系统 ══════════════════ */
  {
    id: 'sys', label: '系统',
    subs: [
      {
        id: 'safety', label: '安全红线', title: '安全设置',
        desc: '兜底红线。命中就丢<b>那一段</b>回复，不是整条哑掉。',
        draft: true,
        cards: [{
          id: 'sf', title: '敏感词与防护', span: 6,
          ctrls: [
            { t: 'tags', id: 's.banned', label: '敏感词', bind: 'safety.banned', ph: '加群, 私聊我, 微信' },
            { t: 'switch', id: 's.af', label: '防刷屏', bind: 'safety.antiFlood',
              hint: (s) => `每条回复最多 ${fieldNum(s, 'antiFloodChunks')} 段（段数由后端下发，改它要动 src/field-schema.js）。` },
            { t: 'switch', id: 's.fl', label: '过滤链接', bind: 'safety.filterLinks', hint: '自动去掉回复里的网址。' },
            { t: 'note', text: '还有两道**不在本页**的红线：提示词注入闸门（<code>src/injection.js</code>）与出站凭据闸门（<code>src/egress.js</code>）。它们没有配置项 —— 有开关就等于给自己留了一条关掉它的路。' },
          ],
        }],
      },
      {
        id: 'history', label: '配置历史', title: '配置历史与回滚',
        desc: '<code>config.json</code> 被 gitignore，没有版本历史 —— 点错一次保存就无从回去。',
        cards: [{
          id: 'hist', title: '回滚', span: 6,
          ctrls: [
            { t: 'kv', rows: (s) => [kv('可回滚的版本数', () => `${j(s, ['configHistory'], 0)} 步`)] },
            { t: 'buttons', label: '', items: [
              act('撤销上一次保存', 'config.undo', 'btn-ghost', '把配置整份退回那一版；撤销自己不进历史（否则再撤同样步数会跳回刚离开的那一版）'),
            ] },
            { t: 'note', text: '<code>panel/config-history.jsonl</code> 里是完整的 config.json（含 API Key），所以 <code>/api/state</code> <b>只下发条数</b>，不下发内容。' },
          ],
        }],
      },
      {
        id: 'panel', label: '面板维护', title: '面板自身',
        cards: [
          {
            id: 'pnl', title: '进程与代码版本', span: 6,
            ctrls: [
              { t: 'kv', rows: (s) => [
                kv('面板 pid', () => String(j(s, ['panel', 'pid'], '—'))),
                kv('启动于', () => new Date(j(s, ['panel', 'bootedAt'], 0)).toLocaleString()),
                kv('服务端代码是不是旧的', () => (j(s, ['panel', 'stale']) ? '是 —— 新接口还没生效（表现为某些按钮点了没反应）' : '否')),
              ] },
              { t: 'buttons', label: '', items: [
                act('重启面板', 'panel.restart', 'btn-ghost', '代码没变就回「已是最新」，绝不无谓重启'),
                act('打开控制台主页', 'open.home'),
                act('刷新二维码', 'qrcode.refresh'),
              ] },
            ],
          },
          { id: 'about', title: '这一页是什么', span: 6, ctrls: [{ t: 'protoInfo' }] },
        ],
      },
    ],
  },
];

/* ────────────────────────────────────────────────────────────────────────
   2. 只读展示用到的取值函数
   ──────────────────────────────────────────────────────────────────────── */
function controlHintOf(s) {
  const c = j(s, ['bridge', 'control']);
  if (!c) return '';
  return c.done ? `上一次命令 ${c.cmd}：${c.done}` : `已下发 ${c.cmd}，等机器人取走`;
}
function brainModeOf(s) {
  const isLocal = j(s, ['effective', 'isLocal']);
  const provider = j(s, ['config', 'provider'], '?');
  const model = j(s, ['effective', 'model'], '—');
  const label = isLocal ? '本机模型（免费·不联网）' : provider === 'deepseek' ? 'DeepSeek 云端' : '智谱云端';
  return {
    title: `现在在用：${label} · ${model}`,
    hint: isLocal ? '切换后首次要加载约 20–60 秒。' : '切到本机模型会自动把内存还给你。',
    cls: j(s, ['effective', 'alive']) ? 'ok' : 'warn',
  };
}
function costModeOf(s) {
  const isLocal = j(s, ['effective', 'isLocal']);
  return {
    title: isLocal ? '当前：本机模型 —— 聊天不花钱' : '当前：云端 —— 每条都计费',
    hint: isLocal ? '账本里本机调用只记条数，不计费。' : '云端与本机分开记账，各算各的，不会互相污染。',
    cls: isLocal ? 'ok' : 'warn',
  };
}
function thinkModesOf(s) {
  const caps = capsOf(s);
  const out = [];
  const m = caps?.thinkModes;
  if (!m || m.auto !== false) out.push({ v: 'auto', l: '自动' });
  if (!m || m.off !== false) out.push({ v: 'off', l: '关闭 · 快且省' });
  if (!m || m.on !== false) out.push({ v: 'on', l: '开启 · 更准' });
  return out.length ? out : [{ v: 'auto', l: '自动' }];
}
function thinkLevelsOf(s) {
  const caps = capsOf(s);
  const map = { low: '低 · 快', medium: '中', high: '高 · 更准更慢', max: '最高 · 想最久' };
  const list = Array.isArray(caps?.levels) && caps.levels.length ? caps.levels : ['low', 'high'];
  return list.map((v) => ({ v, l: map[v] || v }));
}
function capsOf(s) {
  const provider = j(s, ['config', 'provider'], 'zhipu');
  const model = j(s, ['config', 'model'], '');
  return j(s, ['modelCaps', provider, model], null);
}
function fieldNum(s, key) {
  return j(s, ['customMeta', 'fieldMeta', 'numbers', key], '');
}
function fmtNum(n) { return Number(n || 0).toLocaleString(); }
function fmtDur(ms) {
  const t = Math.floor(Number(ms || 0) / 1000);
  if (t < 60) return `${t} 秒`;
  if (t < 3600) return `${Math.floor(t / 60)} 分钟`;
  return `${Math.floor(t / 3600)} 小时 ${Math.floor((t % 3600) / 60)} 分`;
}

/** 给外部（app.js / 文档）用的只读工具，避免两处各写一份 */
export const $ = { j, activePreset, capsOf, fmtNum, fmtDur };

/* ────────────────────────────────────────────────────────────────────────
   3. 控件类型清单（给改动者看的索引；app.js 的 RENDER 表是它的实现）
   app.js 启动时会核对：schema 里出现的每个 `t` 都在这里，否则当场报错。
   ──────────────────────────────────────────────────────────────────────── */
export const CTRL_KINDS = [
  'note', 'metrics', 'kv', 'steps', 'modebar', 'pill', 'hint',
  'button', 'buttons',
  'switch', 'featSwitch',
  /* `statusGrid` / `ports`：运行总览页重排加的（2026-10-02）——
     把等权 kv 行换成有状态色的卡片，坏的那格自己会变红。 */
  'statusGrid', 'ports',
  'text', 'textarea', 'password', 'number', 'time', 'select', 'seg', 'tags',
  /* `ticks`：**有序档位**的刻度选择器（抄 bencho.dev「Progress ticks」）。
     与 `seg` 同一套数据契约（同一个 `options` / 同一个 `valueOf`/`setValue`），
     差别只在呈现：刻度把高度接上，所以顺序是**看得见的**。
     ⚠️ 少于 3 档时它**自动退回 `seg`**（2 档时高度差表达不了顺序，
        白占一行高度与一套指针逻辑）。 */
  'ticks',
  'sleepLine', 'sleepDetail', 'modelPick', 'routeBoard', 'packages',
  'usageBySource', 'usageTable',
  'enhance', 'scenes', 'playRules', 'skills', 'memOverview', 'memList', 'memRecords', 'autoMemList',
  'schedList', 'holidays', 'emotionState', 'pluginSummary', 'pluginList', 'pluginSettings', 'pluginScope',
  'faces', 'people', 'unread', 'gallery', 'apiDeals',
  'sesList', 'sesDetail', 'chatList', 'chatDetail', 'traceList', 'logList', 'auditList',
  'tryOut', 'importFile', 'importZip', 'protoInfo',
];
