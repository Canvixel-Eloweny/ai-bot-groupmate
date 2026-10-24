/**
 * ══════════════════════════════════════════════════════════════════════════
 *  Estrella Bot Console v2 · 页面骨架的**唯一声明处**
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
/**
 * 「健康与占用」的一格内存读数（2026-10-09 · 第 53 轮 · B2）。
 *
 * ⚠️ **拿不到数据时返回 `null`**（前端渲染成"暂不支持"），**绝不许返回 0**：
 *    `readMemory()` 在 Windows 上如实返回 `null`（那边没有 `vm_stat`/`sysctl`/`ps -Ao`），
 *    而这一格原来写的是 `j(s, ['memory','procs','bridgeMB'], 0)` —— 于是整张卡片
 *    显示成一片 `0 MB` / `0%`。那是**谎话**：读的人会以为"它几乎不占内存"，
 *    而不可能想到"这个数字根本没采到"。
 *    「失败伪装成成功」是本项目反复在清的那一类，所以这里统一走这个辅助。
 */
const memCell = (label, path, unit, hi = false) =>
  metric(label, (s) => {
    const v = j(s, path);
    return v == null ? null : `${v}${unit}`;
  }, hi);
/* ⚠️ `ico` / `icoTo` 是 2026-10-02 加的两个可选参数（图标变形）：
     `ico`    静态图标名
     `icoTo`  变形目标（**可以是函数**，按状态算）。给了它，
              状态一变图标就"化"过去 —— 见app.js 的 `mountMorphIcons`。
   放在最后是为了不改动已有调用点（前四个参数的位置没变）。 */
const act = (label, action, style = 'btn-ghost', hint = '', ico = '', icoTo = '') =>
  ({ t: 'button', label, action, style, hint, ico, icoTo });
/* HUD 信息岛（顶栏）的设置：存浏览器 localStorage，不进 config.json。
   本页控件只读写它，岛本体在 island.js（window.Island）。 */
const hudCfg = () => (typeof window !== 'undefined' && window.Island
  ? window.Island.cfg()
  : { enabled: [], interval: 7000, width: 360, height: 38, speed: 1 });
const hudOn = (id) => hudCfg().enabled.indexOf(id) >= 0;
const hudItem = (id) => (v) => {
  if (!(typeof window !== 'undefined' && window.Island)) throw new Error('HUD 岛未加载（island.js 未取到），设置没有保存');
  window.Island.setItem(id, !!v);
  return null;
};
const hudSave = (patch) => (v) => {
  if (!(typeof window !== 'undefined' && window.Island)) throw new Error('HUD 岛未加载（island.js 未取到），设置没有保存');
  const out = {};
  Object.keys(patch).forEach((k) => { out[k] = patch[k](v); });
  window.Island.set(out);
  return null;
};

/* ────────────────────────────────────────────────────────────────────────
   1. 页面骨架
   ──────────────────────────────────────────────────────────────────────── */
/* 一级顺序 = 使用频次（2026-10-22 B2）：运行 → 发言 → 人格 → 模型 → 记忆 → 维护。
   ⚠️ 改顺序时同步 `panel/next/verify.mjs` 里按序号点击的断言（或改成按 title 找）——
   那里有维护 / 插件 / 人格等几处仍按 0-based 序号点，重建顺序会让它们静默点到别的域。 */
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
                { ico: 'bot', label: '机器人', go: 'run/overview',
                  value: (s) => (j(s, ['bridge', 'running']) ? '在跑' : '没在跑'),
                  sub: (s) => (j(s, ['bridge', 'running'])
                    ? `pid ${j(s, ['bridge', 'pid'], '—')} · ${fmtDur(j(s, ['bridge', 'uptimeMs'], 0))}`
                    : '点「启动机器人」开起来'),
                  st: (s) => (j(s, ['bridge', 'running']) ? 'ok' : 'bad') },
                { ico: 'layers', label: '实例数', go: 'run/overview',
                  value: (s) => `${j(s, ['bridge', 'instances'], 0)} 个`,
                  sub: () => '面板只认自己的入口进程',
                  st: (s) => (j(s, ['bridge', 'instances'], 0) > 1 ? 'warn' : 'ok') },
                /* ⚠️ 第 53 轮（B2）：Windows 便携版走**原生 NapCat**、不装 Docker ⇒
                   "容器没跑"在那边是一句**假警报**（用户会去查一个根本不存在的容器）。
                   所以先看 `applicable`：false 时这格说"原生 NapCat"、状态给 ok。
                   ⚠️ 判据在**后端**（`container.applicable`），前端不自己按平台猜 ——
                      "这台机器走没走容器"是事实，不该由页面重算一遍。 */
                { ico: 'container', label: '容器', go: 'run/overview',
                  value: (s) => {
                    if (j(s, ['container', 'applicable']) !== false) return j(s, ['container', 'line'], '') || '—';
                    // P11：Windows 原生形态下这一格实际就是「协议端」。没装时必须说"未安装"，
                    // 不能拿"原生 NapCat"当成正常状态（群友就是被这格骗过：面板一片绿，二维码却取不到）。
                    return j(s, ['napcat', 'present']) === false ? '协议端未安装' : '原生 NapCat';
                  },
                  sub: (s) => (j(s, ['container', 'applicable']) === false
                    ? (j(s, ['napcat', 'present']) === false
                      ? `放进 ${j(s, ['napcat', 'dir'], 'userdata\\napcat')}`
                      : '不走 Docker（Windows 原生安装）')
                    : 'NapCat（QQ 协议端）'),
                  st: (s) => {
                    if (j(s, ['container', 'applicable']) !== false) return j(s, ['container', 'line']) ? 'ok' : 'bad';
                    return j(s, ['napcat', 'present']) === false ? 'bad' : 'ok';
                  } },
                { ico: 'monitor', label: '面板', go: 'sys/panel',
                  value: (s) => `pid ${j(s, ['panel', 'pid'], '—')}`,
                  sub: (s) => `已运行 ${fmtDur(j(s, ['panel', 'uptimeMs'], 0))}`,
                  st: 'ok' },
                { ico: 'user', label: '登录账号', go: 'speak/trigger',
                  value: (s) => j(s, ['account', 'nickname'], '未登录'),
                  sub: () => '真 QQ 号只在本机 .env 里',
                  st: (s) => (j(s, ['account', 'nickname']) ? 'ok' : 'warn') },
              ] },
              /* 协议端**进程级**守护（2026-10-22）：连接看门狗只重连，进程没了它管不了。
                 ⚠️ 刻意**不塞进 statusGrid**：上面那段注释已经踩过 —— 多一张卡会把
                    下面的按钮挤出可视区，也会改变卡片高度让倾斜回归的取景坐标漂移。
                 这里只摆一行状态；手动拉起入口在「排查与运维」里。 */
              { t: 'note', text: (s) => {
                const g = j(s, ['protocolGuard'], {});
                if (!g.configured) return '协议端进程守护：不适用（macOS / 未装原生协议端）。';
                if (g.gaveUp) return `协议端进程守护：已停手（${g.lastError || '连续拉起失败'}）。`;
                if (g.lastError) return `协议端进程守护：${g.lastError}。`;
                const left = g.nextRetryAt ? Math.max(0, Math.ceil((Number(g.nextRetryAt) - Date.now()) / 1000)) : 0;
                return left
                  ? `协议端进程守护：下次重试约 ${left} 秒后（已拉起 ${g.attempts || 0} 次）。`
                  : `协议端进程守护：在盯着（已拉起 ${g.attempts || 0} 次）。`;
              } },
              /* P11（2026-10-19 维护者回执）：协议端没装时**不许再让用户去 AppData 里放文件**。
                 面板自己去常见目录找（下载/桌面/文档），找不到就打开目标文件夹让用户拖进去。
                 ⚠️ 必须放在「启动链路」与五张状态卡**之间**的空行里，且 `label` 留空：
                   塞进 statusGrid 的 items 会被当成第六张卡，按钮掉到窗口可视区外
                   （2026-10-19 VM 截图：用户只能看到卡片标题、点不到按钮）。
                 只在 Windows 且确实没装时出现 —— 装好后这两颗按钮自动消失。 */
              { t: 'buttons', label: '', when: (s) => j(s, ['napcat', 'present']) === false && j(s, ['napcat', 'win32']) === true, items: [
                act('自动查找并安装', 'napcat.importAuto', 'btn-primary', '扫描「下载 / 桌面 / 文档」里已解压的 NapCat 并复制进来（只复制，原件不动）', 'search'),
                act('打开协议端文件夹', 'napcat.openFolder', 'btn-ghost', '打开后把 NapCat.Shell 里的文件拖进去即可，页面每 3 秒自动检测'),
              ] },
              /* 端口**拆成三格**而不是拼成一行 `HTTP 通 · WS 通 · WebUI 通` ——
                 三条各自独立（HTTP 通但 WS 断是真实故障），
                 拼一行时坏的那个要被逐字读出来，拆开它自己会变红。
                 ⚠️ 第 53 轮（B2）：名字里带上**探的是哪个端口** ——
                 端口现在跟着配置的 `onebot.wsUrl` 走，而"端口对不上"的表现就是"断"，
                 把号摆在名字里，用户一眼能核对（原生 NapCat 的端口是自己配的）。 */
              { t: 'ports', label: '协议端端口', items: [
                { label: (s) => `HTTP ${j(s, ['ports', 'onebot', 'http'], '')}`.trim(), get: (s) => j(s, ['ports', 'onebotHttp']) },
                { label: (s) => `WS ${j(s, ['ports', 'onebot', 'ws'], '')}`.trim(), get: (s) => j(s, ['ports', 'onebotWs']) },
                { label: 'WebUI 6099', get: (s) => j(s, ['ports', 'webui']) },
              ] },
              { t: 'note', text: '睡眠那一行是**只读**的：改作息在「发言 → 主动与免打扰」的作息表，手动让它睡 / 叫它醒走的是控制通道（不改配置）。' },
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
                act('拉起协议端', 'protocol.start', '', '进程没了或冷却结束后手动拉起一次（账号掉线时不会拉）', 'play'),
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
                memCell('内存占用率', ['memory', 'pressure'], '%', true),
                memCell('空闲内存', ['memory', 'freeGB'], ' GB'),
                memCell('机器人进程', ['memory', 'procs', 'bridgeMB'], ' MB'),
                memCell('本机模型', ['memory', 'procs', 'localModelMB'], ' MB'),
                memCell('Docker', ['memory', 'procs', 'dockerMB'], ' MB'),
                memCell('面板自身', ['memory', 'procs', 'panelMB'], ' MB'),
              ] },
              { t: 'kv', rows: (s) => [
                kv('可回滚的配置版本', () => `${j(s, ['configHistory'], 0)} 步`),
                kv('运行中的代码', () => (j(s, ['effective', 'alive']) ? `pid ${s.effective.pid} · ${j(s, ['effective', 'model'], '—')}` : '机器人没在跑')),
                kv('插件（磁盘）', () => `${j(s, ['extensions', 'sum', 'total'], 0)} 个 · 可加载 ${j(s, ['extensions', 'sum', 'load'], 0)}`),
              ] },
            ],
          },
        ],
      },
      {
        id: 'sessions', label: '会话', title: '会话与存档（现在 / 历史）',
        desc: '数据源是 <code>local-trace.jsonl</code>：有界窗口，反映最近活动；下面的「消息存档」是机器人退出 / 定时归档的全量历史（只读）。两套数据源分开读，不做合并写入 —— 合并会在截断时静默丢数据。',
        cards: [
          {
            id: 'sessions', title: '会话列表与明细', span: 12,
            ctrls: [{ t: 'sesList', from: 'sessions' }, { t: 'sesDetail' }],
          },
          {
            id: 'chats', title: '消息存档', span: 12,
            ctrls: [{ t: 'chatList', from: 'chats' }, { t: 'chatDetail' }],
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
        /* ══════════════ 假 QQ（2026-10-21 · Win-v0.1.2 移植）══════════════
           这一页起的是**真的程序**（scripts/fake-qq.mjs 起假 OneBot + 真 src/index.js），
           只是把 QQ 那一层换成本地假的。会话逻辑不在这页里：斜杠命令由脚本解释，
           面板只转发 stdin 行。 */
        id: 'fake', label: '假 QQ', title: '调试台（假 QQ / 终端 / 试一句）',
        desc: '真程序 + 假 QQ 传输层：<b>真模型</b>（或勾离线假模型）、真人设、真记忆落盘。定时消息、夜间产出这些"没有界面"的能力，在这一页打一句话就能验；终端与「试一句」也收在这页。',
        cards: [
          {
            id: 'fake', title: '会话（打字 = 发消息）', span: 12,
            desc: '真实的程序在后台跑，回显就是它真的输出。斜杠命令：<code>/at</code> 开关 @、<code>/private</code> 切私聊、<code>/group</code> 切回群、<code>/as QQ 名字</code> 换身份、<code>/log</code> 看程序日志、<code>/quit</code> 退出。',
            ctrls: [
              { t: 'fakeView' },
              { t: 'text', id: 'fake.text', label: '你要说的话', ph: '直接打字就是一条群消息（默认带 @，机器人一定回）', wide: true, volatile: true },
              { t: 'buttons', label: '', items: [
                act('发送', 'fake.send', 'btn-primary'),
                act('清屏', 'fake.clear'),
              ] },
              { t: 'note', kind: 'warn', text: '⚠️ 真机器人正在跑时<b>不许</b>用真数据起第二个程序（会抢同一份 <code>data\\</code>，把记忆写乱）—— 先停机器人，或勾「沙箱数据」（换成空的一份临时 data）。' },
            ],
          },
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
            id: 'term', title: '实时日志', span: 12,
            desc: '上面三个灯依次是：机器人在不在跑 / 协议端（NapCat）在不在 / 控制台自己。日志是服务端**推**过来的（不是定时刷的），新的一行出来就到。',
            ctrls: [
              { t: 'termView' },
              {
                t: 'buttons', label: '常用动作', items: [
                  act('起机器人', 'bridge.start', 'btn-primary'),
                  act('结束本次运行', 'onekey.stop', 'btn-danger'),
                  act('重启协议端', 'napcat.restart'),
                  act('打开二维码登录', 'open.webui'),
                  act('连接自检', 'check'),
                  act('退出控制台', 'panel.quit', 'btn-danger'),
                ],
              },
            ],
          },
        ],
      },
    ],
  },


  /* ══════════════════ ② 发言 ══════════════════ */
  {
    id: 'speak', label: '发言',
    subs: [
      {
        id: 'trigger', label: '触发方式', title: '触发方式、巡逻与跨会话',
        desc: '什么情况下它才开口。放行 / 拉黑名单写在同一份 config.json 的 <code>allow</code> 里 —— 别的入口看到的也是这一份。',
        draft: true,
        cards: [
          {
            id: 'trg', title: '被叫到', span: 6,
            ctrls: [
              { t: 'switch', id: 't.at', label: '群里必须 @ 才回话', bindSys: 'requireAtInGroup' },
              { t: 'tags', id: 't.kw', label: '包含这些词就回', bind: 'trigger.keywords', ph: '小鱼, 肥鱼, 在吗',
                hint: '命中任意一个就会回，不受「必须 @」限制。关键词触发属于"被叫到"，所以<b>不受主动发言总闸影响</b>。' },
              /* 同意私聊的 QQ 号（2026-10-12 补；2026-10-14 改名并挪到「放行的群号」之前）——
                 机器人侧一直在按 `allow.private` 判定私聊放行，但**面板上原先没有这一格**：
                 用户想让它在私聊里回话，只能手工编辑 config.json。
                 同一个闸缺了半扇门 ⇒ 私聊不回时，用户在界面上看不见也改不了，
                 只会以为"机器人坏了"。三段链路（下发 → 编辑 → 落盘）已一起补齐。
                 ⚠️ 改名时**必须**同步 `src/config.js` 里那条"去哪儿填"的报错文案 ——
                    它的注释写着"面板导航改名时这一行必须跟着改"。 */
              { t: 'tags', id: 't.priv', label: '同意私聊的 QQ 号', bindSys: 'privateUsers', ph: '100000001',
                hint: '填入同意私聊的 QQ 号（纯数字、逗号隔开）。填好后，这些人直接私聊它，它就会回话 —— 私聊相当于"直接点名"，<b>不用 @ 也不用关键词</b>。<b>留空 = 谁私聊都不回</b>。' },
              { t: 'switch', id: 't.fpriv', label: '好友私聊按群友接待', bind: 'allowFriendsPrivate',
                hint: '开着：机器人<b>加过的 QQ 好友</b>私聊它，即使没填进上面那格，也按群友的方式回话（好友表来自协议端，最多晚 10 分钟生效）。<b>好友不等于管理员</b> —— 叫醒、夜间产出收件人这些仍只认主人号。关掉：只有上面那格的号能私聊它。' },
              { t: 'tags', id: 't.owner', label: '主人 QQ（叫醒 / 私聊兜底）', bindSys: 'ownerQq', ph: '100000001',
                hint: '主人的 QQ 号（纯数字、逗号隔开）。加载配置时会<b>自动补进「同意私聊的 QQ 号」</b>，并允许在睡眠期间用私聊叫醒它。<b>留空 = 叫醒路整体关闭</b>（自然起床不受影响）。' },
              { t: 'tags', id: 't.allow', label: '放行的群号', bindSys: 'groups', ph: '100000001, 987654321',
                hint: '留空 = 群里它谁都不回。至少填一个要它说话的群（纯数字、逗号隔开）。' },
            ],
          },
          {
            id: 'deny', title: '拉黑', span: 6, col: 'r',
            ctrls: [
              { t: 'tags', id: 't.dg', label: '拉黑的群号', bindSys: 'denyGroups', ph: '这些群里它完全不回话' },
              { t: 'tags', id: 't.du', label: '拉黑的 QQ 号', bindSys: 'denyUsers', ph: '哪怕被 @ 也不回' },
              { t: 'note', kind: 'warn', text: '<b>拉黑优先于放行</b> —— 一个群同时出现在两个名单里，结果是<b>不回</b>。另外「必须 @」和关键词触发都拦不住拉黑。' },
            ],
          },
          /* ── 插话冷却（2026-10-17）────────────────────────────────────────
             为什么它单独占一块玻璃板、并且**只**是一条进度条：

             ① 它此前**根本没有界面**。`trigger.interjectCooldownMs` 从机器人第一版起就在
                `src/brain.js` 里判（`lastInterjectAt < interjectCooldownMs` ⇒ deny「插话冷却中」），
                而面板既不下发、也不接受写入 —— 用户想改只能手改 config.json。
                所以这块板的第一职责是「让它存在」，不是「让它更好看」。
             ② 用户点名要的是**进度条**，不是输入框：这个量是"两次主动接话之间至少隔多久"，
                适合用位置表达（越靠右越安静），而一个 5 位数的毫秒输入框两者都给不了。
             ③ `col: 'r'` —— 落点就是「拉黑」卡下方那块空白（12 列栅格的右半）。
                不用 `span: 12`：那会把左列「被叫到」顶下去一整行，红框那块反而空着。 */
          {
            id: 'cool', title: '插话冷却', span: 6, col: 'r', tone: 'liquid',
            ctrls: [
              { t: 'range', id: 't.cool', label: '两次主动插话之间至少隔',
                bindSys: 'interjectCooldownMs',
                /* `scale: 60000` = 界面上的**分钟** × 60000 = 盘上的毫秒。
                   换算只在 app.js 的 valueOf / setValue 里做一次（与 `pct` 同一条纪律）——
                   控件自己只声明单位，不在渲染函数里乘除。 */
                scale: 60000, min: 1, max: 300, log: true, unit: '分钟',
                // 刻线只标三处（5 分钟 / 半小时 / 2 小时）：对数刻度下"5 分钟"落在 28%
                // 而不是 1/300 —— 没有刻线时这个位置会被读成"滑块坏了"。
                marks: [5, 30, 120],
                hint: '两次<b>主动接话</b>之间至少隔这么久。被 @、被关键词叫到<b>不受</b>它限制 —— 冷却只拦它自己起话头。拖到最右（5 小时）≈ 只在你叫它时才说话。' },
            ],
          },
          {
            id: 'pt', title: '巡逻规则', span: 6,
            ctrls: [
              { t: 'switch', id: 'pt.on', label: '群安静后翻积压（巡逻）', bind: 'trigger.patrol.enabled',
                hint: '关掉就只有「被点名 / 关键词 / 插话 / 定时主动」这四条开口路径。巡逻是唯一会读积压的那条。' },
              { t: 'number', id: 'pt.min', label: '至少攒几条积压', bind: 'trigger.patrol.minUnread', min: 1, max: 200, step: 1, hint: '默认 5。' },
              { t: 'number', id: 'pt.silence', label: '群里安静多少分钟后才翻', bind: 'trigger.patrol.silenceMin', min: 0, max: 1440, step: 1, hint: '默认 10 分钟。' },
              { t: 'number', id: 'pt.gap', label: '同一个群两轮巡逻至少隔多少分钟', bind: 'trigger.patrol.minGapMin', min: 0, max: 1440, step: 1, hint: '默认 20 分钟。' },
              { t: 'number', id: 'pt.chance', label: '基础概率（%）', bind: 'trigger.patrol.chance', min: 0, max: 100, step: 5, pct: true,
                hint: '实际掷骰时还会乘热度权重（群越冷越不容易开口）。被 @ / 关键词 / 私聊不受这个数影响。' },
              { t: 'number', id: 'pt.lines', label: '一轮最多带几条消息', bind: 'trigger.patrol.maxLines', min: 1, max: 60, step: 1,
                hint: '默认 24。只截巡逻摘要，不改未读计数；太长会挤掉别的背景。' },
              { t: 'number', id: 'pt.chars', label: '一轮摘要最多多少字', bind: 'trigger.patrol.maxChars', min: 100, max: 6000, step: 100,
                hint: '默认 1800。按字符截，消息条目仍按上面的条数保留。' },
              { t: 'note', text: '一轮巡逻 = 一批积压的摘要进提示词，模型可以接一句，也可以 <code>qq_quiet</code> 照常安静。它不是每条都问模型 —— 攒够、安静够才问一次。' },
            ],
          },
          {
            id: 'ptv', title: '现在的热度与积压', span: 6,
            ctrls: [
              { t: 'patrolView' },
              { t: 'note', text: '「关系温度」是它对某个人在这个群里的热络程度（0–100%）：连着找它聊天会往下掉，安静下来慢慢回升。「群活跃」看最近 30 分钟的消息量。数据每 30 秒刷新一次（机器人没在跑时显示上一次的快照）。' },
            ],
          },
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
        id: 'scheduled', label: '定时消息', title: '定时消息与节假日',
        desc: '到点自动在那个群发一句。日期与频次两个维度已在 2026-10-02 修通（此前会被归一化静默剥掉）。',
        draft: true,
        cards: [
          {
            id: 'sc', title: '时刻表', span: 12,
            ctrls: [
              { t: 'schedList', path: 'trigger.scheduled', detailed: true },
              { t: 'note', kind: 'ok',
                text: '<b>「日期」与「频次」现在真的生效了。</b>修之前 <code>scheduledItems</code> 的白名单里只有 <code>{id, at, text, enabled}</code>，两个维度被静默剥掉 —— 机器人侧 <code>matchesOn(s.on)</code> 恒真、只能按"每天"跑，<b>而回归全绿</b>（D17 的用例把纯函数直接喂字段，没有一条走"经 readCustom 一遍"）。修法是<b>一处</b>（<code>src/custom-config.js</code>），并且契约 §46 已升级成"<b>往返之后仍在</b>"，不再只盯"面板有没有带上"。' },
            ],
          },
          {
            id: 'cal', title: '节假日表', span: 6,
            ctrls: [
              { t: 'holidays' },
              { t: 'note', kind: 'ok',
                text: '<b>2026-10-02 修好的一条数据链路。</b>此前 <code>custom.holidays</code> 不在 <code>readCustom</code> 的白名单里，而面板保存走整体替换 —— 于是<b>任何一次保存都会把这张表从 config.json 里抹掉</b>（机器人侧只能退化成按星期几兜底）。前端当时其实"带上了它"，但补救写在了白名单的错的一侧，所以从来没生效。现在它进了白名单，<b>往返实测通过</b>（见 <code>docs/FRONTEND-V2.md</code> §5①）。' },
            ],
          },
        ],
      },
      {
        id: 'waiting', label: '聊天等待与图片', title: '聊天等待与图片 —— 回得更像人，也能发图 / 看图',
        desc: '回话之前的<b>停顿</b>、同一个人连发几条时<b>攒成一轮</b>、模型慢时先<b>垫一句</b>，以及「正在输入」气泡；'
          + '下面还有<b>发图</b>与<b>看图</b>两个工具。全部只影响观感与能力，不改变判定（闸门、限流、额度不受影响）。',
        draft: true,
        cards: [
          {
            id: 'cw', title: '聊天等待', span: 6,
            ctrls: [
              { t: 'switch', id: 'cw.on', label: '回之前先停一会儿（拟人停顿）', bind: 'wait.enabled',
                hint: '关掉 = 判定一过立刻调模型（改造前的行为）。下面几个数都只在它开着时生效。' },
              { t: 'number', id: 'cw.min', label: '最短停顿（毫秒）', bind: 'wait.minMs', min: 0, max: 10000, step: 100, hint: '默认 400。' },
              { t: 'number', id: 'cw.max', label: '最长停顿（毫秒）', bind: 'wait.maxMs', min: 0, max: 20000, step: 100, hint: '默认 2500。长消息会按字数往上加，但不会超过这个值。' },
              { t: 'number', id: 'cw.per', label: '每多一个字再多停（毫秒）', bind: 'wait.perCharMs', min: 0, max: 200, step: 5, hint: '默认 15。' },
              { t: 'number', id: 'cw.merge', label: '连发合并：安静这么多毫秒才回（0 = 不合并）', bind: 'wait.mergeMs', min: 0, max: 30000, step: 100,
                hint: '默认 1200。<b>只合并群聊</b>里同一个人连着发的几条；私聊不合并（紧急唤醒要按连发计数）。被合并掉的几句会进背景段，不会丢。' },
              { t: 'number', id: 'cw.hold', label: '模型慢时先垫一句：超过多少毫秒（0 = 不垫）', bind: 'wait.holdMs', min: 0, max: 120000, step: 500, hint: '默认 6000。' },
              { t: 'text', id: 'cw.text', label: '垫的那句话（留空 = 不垫）', bind: 'wait.holdText', ph: '例如：我想想…' },
              { t: 'switch', id: 'cw.typing', label: '私聊里显示「正在输入」', bind: 'wait.typing', hint: '群聊协议端不支持这个状态，只对私聊生效。' },
            ],
          },
          {
            id: 'img', title: '图片工具', span: 6,
            ctrls: [
              { t: 'switch', id: 'img.send', label: '允许它主动发图', bind: 'image.send',
                hint: '开着时模型多一个 send_image 工具。改完要<b>重启机器人</b>才生效（工具在启动时注册）。' },
              { t: 'switch', id: 'img.view', label: '允许它按需看图', bind: 'image.view',
                hint: '开着时模型多一个 view_image 工具（给地址 / 路径 / 消息号）。当前模型必须真的支持 vision。' },
              { t: 'text', id: 'img.root', label: '本机图片目录', bind: 'image.root', ph: '默认 images-out（相对 data/）',
                hint: '本机路径只允许这个目录内的文件（符号链接逃逸会被 realpath 拦下）。留空 = 禁用本机路径，远端 http(s) 仍可用。' },
              { t: 'note', kind: 'warn', text: '图片先<b>下载成本地字节</b>再交给协议端：内网地址、私网 IP、超过 8MB 的一律发不出去，也会在日志里写明原因。' },
            ],
          },
        ],
      },
      {
        id: 'proactive', label: '主动与免打扰', title: '主动、免打扰、峰谷与作息',
        desc: '"什么时候它自己起话头"以及"什么时候绝对不许出声"。',
        draft: true,
        cards: [
          {
            id: 'pro', title: '定时主动与插话', span: 6,
            ctrls: [
              { t: 'switch', id: 'cfg.proactive', label: '主动发言', volatile: true,
                hint: '总闸：关掉之后插话 / 定时主动 / 定时消息全都不再发声（关键词触发不受影响）。',
                read: (s) => j(s, ['custom', 'allowProactive'], true),
                save: (v) => ({ url: '/api/config', body: { custom: { allowProactive: v } } }) },
              { t: 'switch', id: 'pro.on', label: '隔一段时间自己起个新话题', bind: 'trigger.proactive.enabled' },
              { t: 'number', id: 'pro.min', label: '间隔（分钟）', bind: 'trigger.proactive.intervalMin', bounds: 'proactiveIntervalMin',
                when: (s) => !!j(s, ['custom', 'trigger', 'proactive', 'enabled']) },
              { t: 'text', id: 'pro.text', label: '想让它说什么', bind: 'trigger.proactive.text',
                ph: '留空 = 每次由模型自己编一句', when: (s) => !!j(s, ['custom', 'trigger', 'proactive', 'enabled']) },
              /* ⚠️ `pct: true` 是**必须**的（2026-10-12 修）：这一格画的是 0–100 的百分数，
                 而盘上 `trigger.interjectChance` 是 0–1 的小数。缺了它，写方向的
                 `Math.min(1, 15)` 会把**每一次保存都夹成 1**（=100%）—— 症状是
                 「改了不生效」，而读方向会回显 `0.15`（症状「改了不显示」）。
                 换算收在 app.js 的 valueOf / setValue 里，控件只负责声明单位。 */
              { t: 'number', id: 'pr.chance', label: '随机插话概率（%）', bindSys: 'interjectChance', min: 0, max: 100, step: 5, pct: true,
                hint: '0 = 只有被点名才回。仅在上面的「必须 @」关掉后有效。' },
              { t: 'number', id: 'pr.hour', label: '单会话每小时最多回复', bindSys: 'perHourPerSession', bounds: 'perHourPerSession',
                hint: '<b>私聊 / @ / 叫名字 / 命中关键词不受这一格限制</b>（它们仍受 1.5 秒与每分钟 8 条约束）；随机插话与主动发言会吃这个总额。' },
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
          {
            id: 'pk', title: '高峰时刻表', span: 6,
            ctrls: [
              { t: 'switch', id: 'pk.on', label: '启用峰谷闸（高峰时也不主动找话）', bind: 'peak.enabled',
                hint: '默认开。这是总闸：关掉之后，工作日白天它和平时一样爱接话、也照常起话题 —— 代价是那几个小时最费钱、也最容易被当成刷屏。' },
              { t: 'switch', id: 'pk.mute', label: '高峰时群里没人叫就不接话', bind: 'peak.muteUnmentioned',
                hint: '默认开。只解除"群里没被叫到"的沉默；上面的总闸关掉后这一格不再起作用。被 @ / 引用 / 关键词 / 拍一拍都不受这一格影响。' },
              { t: 'note', text: '时段是写死的两段（<b>工作日</b>才知道：周六周日整天都算谷）。要改时刻就改 <code>src/peak.js</code> 的 <code>PEAK_WINDOWS</code> —— 别在面板上造第二份数字。' },
            ],
          },
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


  /* ══════════════════ ③ 人格 ══════════════════ */
  {
    id: 'persona', label: '人格',
    subs: [
      {
        id: 'who', label: '人格设定', title: '人格设定与情绪状态',
        desc: '决定它说话像谁。文件路径相对 <code>persona/</code>：可写 <code>qq-chat.md</code>，也兼容旧的 <code>persona/qq-chat.md</code>；留空则只使用下方结构化人设。改完点页面底部的「保存并生效」。',
        draft: true,
        cards: [
          {
            id: 'basic', title: '他是谁', span: 6,
            ctrls: [
              { t: 'text', id: 'p.name', label: '机器人昵称', bindSys: 'personaName', ph: '例如：小鱼',
                hint: '键名是**顶层** personaName（不在 custom 里）—— 换到别的页面看到的也是同一个值。' },
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
          { id: 'estate', title: '此刻的状态', span: 7, ctrls: [{ t: 'emotionState' }] },
          { id: 'eset', title: '注入与更新', span: 5, ctrls: [{ t: 'pluginSettings', extId: 'bot-emotion' }] },
        ],
      },
      {
        id: 'enhance', label: '底层规则', title: '底层规则（增强项与扮演规则）',
        desc: '上一屏是"这个人是谁"，这里是"演得有多像"。12 项全部<b>可留空</b> —— 空着的不进提示词。名称 / 说明 / 示例 / 分组全部由后端下发。',
        draft: true,
        cards: [
          { id: 'enh', title: '12 项细节', span: 12, ctrls: [{ t: 'enhance' }] },
          {
            id: 'pr', title: '12 条', span: 12,
            ctrls: [
              { t: 'switch', id: 'pr.on', label: '把扮演规则写进提示词', bind: 'playRules',
                hint: '关掉之后，模型就没有"不替用户说话 / 不编造 / 关系要渐进"这些约束了 —— 除非你清楚自己在做什么，否则别关。' },
              { t: 'playRules' },
            ],
          },
        ],
      },
      {
        id: 'reply', label: '回复设置', title: '回复设置与特殊场景',
        desc: '它一条消息多长、要不要 @ 人、两条之间隔多久。',
        draft: true,
        cards: [
          {
            id: 'reply', title: '长短与习惯', span: 12,
            ctrls: [
              /* ⚠️ 档位进度条（`ticks`）而不是 `seg`：
                 短→中→长**有顺序**，而 `.seg` 把三档排成等宽按钮 ——
                 按钮间距表达的是"它们同类"，不表达"谁比谁多"。
                 横向液面直接画出"现在走到第几档"，不用读文字再排序。
                 数据来源与 `seg` 完全相同（`customMeta.replyLengths`），
                 进度条不另存一份。 */
              { t: 'ticks', id: 'r.len', label: '回复长短', bind: 'replyStyle.length',
                options: (s) => Object.entries(j(s, ['customMeta', 'replyLengths'], {})).map(([v, o]) => ({ v, l: o.label, title: o.hint })) },
              { t: 'switch', id: 'r.multi', label: '允许一件事拆成几条发', bind: 'replyStyle.multiMessage',
                hint: '关掉就不管内容多长都合并成一条长消息。' },
              /* 分条标记（第 53 轮 · B4）。它以前**只有直接编辑 config.json 才能改** ——
                 于是它被脱敏器清成空串时，用户既看不见也改不了，只能在群里看到自己被逐字刷屏。
                 bindSys 走顶层字段，写入路径在 panel/lib/config-route.js（空串会被忽略）。 */
              { t: 'text', id: 'r.tok', label: '分条标记', bindSys: 'splitToken', ph: '默认 ||',
                hint: '模型用它把一件事拆成几条发（如「今天天气不错 || 出去走走」）。默认 ||；'
                  + '清空会被忽略 —— 空标记会让分条正则逐字符匹配，回复会被一个字一个字地发出去。' },
              { t: 'switch', id: 'r.at', label: '回复时 @ 上说话的人', bind: 'replyStyle.mentionAt' },
              { t: 'number', id: 'r.cool', label: '连续回复的最小间隔（秒）', bind: 'replyStyle.cooldownSec',
                bounds: 'cooldownSec',
                hint: (s) => `0 = 只保留底层的 ${fieldNum(s, 'minIntervalMsSec')} 秒防抖。区间由后端下发（field-schema）。` },
            ],
          },
          { id: 'sc', title: '9 种场景', span: 12, ctrls: [{ t: 'scenes' }] },
        ],
      },
    ],
  },


  /* ══════════════════ ④ 模型 ══════════════════ */
  {
    id: 'brain', label: '模型',
    subs: [
      {
        id: 'model', label: '模型与线路', title: '大脑（用哪个模型聊天）',
        desc: '每套大脑各自有一套设置，只摆当前那套 —— 在 DeepSeek 页面上能点到智谱的模型，正是上一版误报错的来源。',
        cards: [
          {
            id: 'switch', title: '一键切换', span: 4,
            desc: '点一下<b>立即生效</b>，不用再点保存。切到云端会自动关掉本机模型，把内存还给你。',
            ctrls: [
              /* `id` 只给 DOM 守卫当锚点用（横幅渲染成 `data-mb`）——
                 页面上有两条横幅（这条 + 计费页那条），不标出来就没法精确断言。 */
              { t: 'modebar', id: 'brain.now', calc: (s) => brainModeOf(s) },
              /* 2026-10-17 第二轮：标签行**就是"我建过的模型"** ——
                 本机 / DeepSeek / 智谱 / 千问 这些预设标签不再占位（维护者点名），
                 新建的云端或本地模型自动出现在这里；右键改名 / 改设置 / 删除。
                 下面那张「自定义模型」列表**整块删掉**：模型都跑到这一行了，
                 再摆一份列表就是同一件事的两个入口。 */
              { t: 'brainTags' },
              { t: 'kv', rows: (s) => [
                /* 这一整组都是「现在这套是什么」，所以**和横幅同源**（`brainPickOf`）。
                   上一版这里取 `effective`（机器人上次读到的），切换后要等热重载才变 ——
                   于是横幅、标签、这四行在同一个页面上互相打架（2026-10-17 实测截图）。
                   唯一还取 `effective` 的是最后一行：它说的就是"机器人什么时候读的配置"，
                   换源会变成一句谎话。 */
                kv('当前厂商', () => brainPickOf(s).vendor),
                kv('正在使用', () => brainPickOf(s).model),
                kv('接口地址', () => brainPickOf(s).baseUrl || '—'),
                kv('降级链', () => (j(s, ['config', 'fallbackModels'], []) || []).join(' → ') || '无'),
                kv('机器人读入配置于', () => (j(s, ['effective', 'since']) ? new Date(s.effective.since).toLocaleString() : '—')),
              ] },
              /* 免费额度：**一颗按钮**（2026-10-17 维护者第二次点名，去掉整块卡片）。
                 位置就在卡片右下角（红框标的大致位置）；点一下打开那家的额度/余额官网。
                 本机模型不摆 —— 它没有额度也没有账单。 */
              { t: 'quotaBtn', calc: (s) => quotaBtnOf(s), when: (s) => brainPickOf(s).isLocal === false },
            ],
          },
          {
            id: 'local', title: '本机模型', span: 4,
            /* ⚠️ 两个条件都成立才显示（第 53 轮 · B6）：
               `isLocal` —— 当前大脑就是本机模型那套；
               `supported` —— **这个平台上真有这套实现**。
               第二个条件是新增的：Windows 上 MLX / QwenChat 一个都不存在，
               而它原来照样显示一整张死控件（状态恒"没在跑"、启动按钮点了必然失败）。
               用户的真实反应（实测截图）是去「自定义模型」里填 llama.cpp 的目录路径。
               ⚠️ `isLocal` 取 `brainPickOf`（面板已选定），与横幅/标签同一个判据 ——
                  取 `effective` 的话，刚切到本机、机器人还没重读时这张卡**不出现**。 */
            when: (s) => brainPickOf(s).isLocal === true
              && j(s, ['localModel', 'supported']) !== false,
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
            /* ⚠️ 与上面那张**互斥**（第 53 轮 · B6）：Windows 上本机模型那套实现
               （MLX 模型格式 + mlx_lm.server / QwenChat）**根本不存在**，
               所以这里一个控件都不摆 —— 只给一句**能照着做**的替代方案。
               摆一堆点了必然失败的按钮，比不显示更坏（M7 那条教训）。
               ⚠️ 文案来自**后端**（`localModel.unsupportedWhy`）：前端不自存一份，
                  否则两处会慢慢说不一样的话（"一份数据维护两遍"那条纪律的镜像）。 */
            id: 'local-unsupported', title: '本机模型（此平台不适用）', span: 4,
            when: (s) => j(s, ['localModel', 'supported']) === false,
            ctrls: [
              { t: 'note', text: (s) => j(s, ['localModel', 'unsupportedWhy'], '') },
            ],
          },
          {
            id: 'cloud', title: '云端设置', span: 4,
            // 与「本机模型」那张互斥，判据同样是 `brainPickOf`（见上面那条注释）。
            when: (s) => brainPickOf(s).isLocal === false,
            desc: '地址按当前大脑自动填并且锁住 —— 手填地址正是上一版误报错的来源。',
            ctrls: [
              { t: 'text', id: 'cfg.baseUrl', label: '模型接口地址', readonly: true, wide: true,
                read: (s) => j(s, ['config', 'baseUrl'], '') },
              { t: 'password', id: 'cfg.apiKey', label: 'API Key', ph: '留空则不修改已保存的 Key',
                save: (v) => (v ? { url: '/api/config', body: { apiKey: v } } : null),
                hint: (s) => (j(s, ['config', 'hasKey']) ? `已保存：${j(s, ['config', 'keyMasked'], '')}` : '尚未配置（本机模型不需要 Key）') },
              { t: 'modelPick', label: '模型' },
              { t: 'number', id: 'cfg.maxTokens', label: '最大回复长度（tokens）', bindSys: 'maxTokens',
                min: 200, max: 8000, step: 100,
                hint: '这是**上限**，不按上限计费。思考型模型 400 容易被 reasoning 吃满、正文为空；建议 1200 以上。' },
            ],
          },
          {
            id: 'route', title: '优先级线路', span: 6,
            // 2026-10-07 接千问：从"只给智谱"放宽成"两家云端都给"。
            // ⚠️ 标题**不再写死"（智谱）"** —— 写死之后千问的页面上会出现
            //    "优先级线路（智谱）"配千问的模型，那是最容易让人误判的一类文案错。
            when: (s) => ['zhipu', 'qwen'].includes(j(s, ['config', 'provider'])),
            desc: '机器人先试<b>主模型</b>，被限流 / 超时 / 故障时按这里的顺序往下换。列表里只放<b>这一家的模型</b> —— 候选名单由后端按服务商下发，别家的模型放进这条链一条都不会被响应（放不进去：保存时会被拦下并说清）。',
            ctrls: [
              { t: 'routeBoard' },
              // ⚠️ 赠送额度进度条**只有智谱有**（它的资源包接口用 API Key 就能查）。
              //    千问查不到实时余额（用量查询要账号级签名），所以这一格对它是**隐藏**的。
              //    留着不隐藏的后果很具体：它会去查**智谱**那边的余额、
              //    然后显示在千问的页面上 —— 一条看起来很正常、其实是指向另一家的读数。
              { t: 'packages', label: '赠送额度（智谱）', when: (s) => j(s, ['config', 'provider']) === 'zhipu' },
            ],
          },
          /* 2026-10-17（维护者第二次点名）：**不再单独占一块**。
             整张「免费额度」卡删掉，收成「一键切换」卡右下角**一颗按钮** ——
             点一下直接去那家能看额度/余额的官网页面；解释文案全部塞进 `title`。
             理由：它要传达的只有"这家会不会扣钱、额度去哪看"，不值得半屏版面。 */
          {
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
          },
        ],
      },
      {
        id: 'thinking', label: '思考与能力', title: '思考模式与能力开关',
        cards: [
          {
            id: 'think', title: '思考模式', span: 6,
            // 自定义大脑**没勾**"能思考" ⇒ 整张卡不显示（勾了才有得开）。
            when: (s) => customFeatureVisible(s, 'thinking'),
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
            desc: '上面两格是<b>模型能力</b>：当前大脑做不到的会灰掉并写明原因（摆在页面上能点却不生效更糟）。',
            ctrls: [
              // 自定义大脑：**只显示勾过的那几项**（下发的 `customVisibleFeatures` 是结论）。
              // 没勾的连开关都不摆 —— 摆出来又关不掉，正是"点了没用"那一类。
              { t: 'featSwitch', feat: 'webSearch', label: '联网查询', hint: '遇到不懂的梗、新闻、人物时让它上网查，每条多花 2–8 秒',
                when: (s) => customFeatureVisible(s, 'webSearch') },
              { t: 'featSwitch', feat: 'vision', label: '识图', hint: '群里有人发图时，它能看懂图里说了什么',
                when: (s) => customFeatureVisible(s, 'vision') },
              { t: 'note', text: '这两项与模型能力表同源：改任一处另一处立刻跟上 —— 本页只摆一次，不做两份副本。' },
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
                metric('缓存命中率', (s) => {
                  const r = Number(j(s, ['usage', 'cacheHitRate'], 0));
                  return Number.isFinite(r) ? `${(r * 100).toFixed(1)}%` : '—';
                }),
              ] },
              { t: 'usageBySource', label: '按来源分开算账（D29）' },
              { t: 'usageByChat', label: '按群 / 私聊分开算账' },
              { t: 'usageByDay', label: '近 30 天' },
              { t: 'usageTable', label: '最近记录' },
              { t: 'buttons', label: '', items: [
                act('查余额', 'balance.load'),
                act('清零统计', 'usage.reset', 'btn-danger', '清掉 panel/ 下**所有** usage*.jsonl（账本按月切分，只删当月那份按下去看着没反应）'),
              ] },
            ],
          },
          {
            id: 'deals', title: '抓到的条目', span: 12,
            ctrls: [{ t: 'apiDeals' }],
          },
        ],
      },
    ],
  },


  /* ══════════════════ ⑤ 记忆 ══════════════════ */
  {
    id: 'know', label: '记忆',
    subs: [
      {
        id: 'memory', label: '自我记忆', title: '自我记忆与导入导出',
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
              { t: 'number', id: 'm.promptMax', label: '每轮最多注入几条', bind: 'memory.promptMax',
                bounds: 'memoryPromptMax', min: 1, step: 1,
                hint: '默认 12。只封顶“进提示词”的条数，记忆本身不会丢；改完点底部的「保存并生效」。' },
              { t: 'memList', label: '手动记忆', path: 'memory.manual',
                note: '只能你自己加。每一条都会保存；每轮最多带上面设定的条数进提示词 —— 与自动记录的开关无关。改完点底部的「保存并生效」。' },
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
                act('运行日志', 'export.log'), act('诊断包', 'export.diag', 'btn-ghost', '含崩溃/退出记录与更新日志，自动脱敏'),
              ] },
              { t: 'kv', rows: (s) => [kv('上次面板退出', () => j(s, ['panel', 'lastExitText'], 0) || '（没有记录）')] },
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
      {
        id: 'skills', label: '知识包与角色卡', title: '知识包与角色卡（含十维分级）',
        desc: '<b>知识包</b>＝某方面的本事，命中触发词才拿出来用；<b>角色卡</b>＝成套的人格，存多张，点「套用到人格设定」就换一套人。',
        draft: true,
        cards: [
          {
            id: 'sk', title: '技能清单', span: 12,
            ctrls: [
              { t: 'number', id: 'skill.promptMax', label: '每轮最多注入几条', bind: 'skillPrompt.max',
                bounds: 'skillPromptMax', min: 1, step: 1,
                hint: '默认 3。只影响“同时注入”的条数，技能本身不会丢。' },
              { t: 'number', id: 'skill.promptChars', label: '每轮注入总字数上限', bind: 'skillPrompt.chars',
                bounds: 'skillPromptChars', min: 200, step: 100,
                hint: '默认 2000。所有命中技能的背景文字加起来不超过这个数；只影响提示词，不影响保存。' },
              { t: 'skills' },
              { t: 'buttons', label: '', items: [
                act('加知识包', 'skill.add.pack'),
                act('加角色卡', 'skill.add.persona'),
              ] },
            ],
          },
          { id: 'cg', title: '卡库', span: 12, ctrls: [{ t: 'cardGrade' }] },
        ],
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
        /* 2026-10-17：这一页原叫「表情与图库」，左边那张是 QQ 收藏表情。
           收藏表情随「发 QQ 表情」能力一起下线（它本来就是同一套决策链的二级分支），
           于是这一页只剩图库 —— 名字跟着改，免得点进来找不到表情。
           ⚠️ 子页 id 保留 `faces`：没有深链路由依赖它，但改 id 会让"我从哪一页来的"
              这类排查对不上旧截图；label 才是给人看的。 */
        id: 'faces', label: '图库', title: '图库',
        desc: '可发送的图片库（需自行安装 <code>自定义图库</code> 插件；默认未安装）。',
        draft: true,
        cards: [
          { id: 'img', title: '自定义图库', span: 12, ctrls: [{ t: 'gallery' }, { t: 'pluginSettings', extId: 'image-lib' }] },
        ],
      },
    ],
  },


  /* ══════════════════ ⑥ 维护 ══════════════════ */
  {
    id: 'sys', label: '维护',
    subs: [
      {
        id: 'safety', label: '安全红线', title: '安全设置与联网护栏',
        desc: '兜底红线。命中就丢<b>那一段</b>回复，不是整条哑掉。',
        draft: true,
        cards: [
          {
            id: 'sf', title: '敏感词与防护', span: 6,
            ctrls: [
              { t: 'tags', id: 's.banned', label: '敏感词', bind: 'safety.banned', ph: '加群, 私聊我, 微信' },
              { t: 'switch', id: 's.af', label: '防刷屏', bind: 'safety.antiFlood',
                hint: (s) => `每条回复最多 ${fieldNum(s, 'antiFloodChunks')} 段（段数由后端下发，改它要动 src/field-schema.js）。` },
              { t: 'switch', id: 's.fl', label: '过滤链接', bind: 'safety.filterLinks', hint: '自动去掉回复里的网址。' },
              { t: 'note', text: '还有两道**不在本页**的红线：提示词注入闸门（<code>src/injection.js</code>）与出站凭据闸门（<code>src/egress.js</code>）。它们没有配置项 —— 有开关就等于给自己留了一条关掉它的路。' },
            ],
          },
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
        ],
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
              /* 应用内更新（P3）：检查/下载/取消/安装；自动检查，但绝不自动安装。 */
              { t: 'update', id: 'upd' },
              { t: 'buttons', label: '', items: [
                act('重启面板', 'panel.restart', 'btn-ghost', '代码没变就回「已是最新」，绝不无谓重启'),
                act('打开控制台主页', 'open.home'),
                act('刷新二维码', 'qrcode.refresh'),
              ] },
            ],
          },
          { id: 'about', title: '这一页是什么', span: 6, ctrls: [{ t: 'protoInfo' }] },
          {
            /* 桌面端「启动方式」（2026-10-16）：控制台以什么形态呈现。
               ⚠️ 这两项**只在启动的一瞬间**被读一次（启动器读 config.json 的 launch 段）——
                  所以提示语必须说"下次启动生效"（走控件的 `savedMsg`，app.js 的保存回报），
                  否则用户会以为"没保存"或盯着当前这个旧标签页纳闷。
               ⚠️ 文案里的"找不到浏览器自动回落"不是修饰 —— 它是判据的真实行为
                  （src/launch-mode.js，fail-open）。 */
            id: 'startmode', title: '启动方式（桌面端）', span: 6,
            desc: '外观、启动与关闭行为已移到左下角「设置」。这里只保留最近一次启动的记录，方便排障。',
            ctrls: [
              { t: 'kv', rows: (s) => {
                /* 「上次启动」= 启动跟踪里最近一条（三个启动器每次都会写一行）。
                   设置搬到左下角后，这一行仍留在维护页：它回答的是"双击之后实际
                   走了哪条路"，与"在哪里改设置"不是同一件事。 */
                const l = j(s, ['config', 'launch', 'last'], null);
                if (!l) return [kv('上次启动', () => '还没有记录 —— 下次启动后这里会出现')];
                const ts = String(l.t || '').replace('T', ' ').slice(0, 16) || '—';
                const how = l.skipped
                  ? '按设置未打开界面'
                  : (l.opened === false
                    ? `打开失败（${l.error || '原因未知'}）`
                    : (l.kind === 'window' ? `独立窗口 · ${l.used || '浏览器'}` : '浏览器标签页'));
                const why = l.reason === 'no-window-browser'
                  ? '（没找到 Edge / Chrome，已回落）'
                  : (l.reason ? `（${l.reason}）` : '');
                return [
                  kv('上次启动', () => `${ts} · ${how}${why}`),
                  kv('来自', () => String(l.entryLabel || l.entry || '未知入口')),
                  ...(l.unknownMode
                    ? [kv('注意', () => `配置里的 launch.mode 是「${l.unknownMode}」，认不出 —— 已按浏览器处理`)]
                    : []),
                ];
              } },
              { t: 'note', text: '打开方式、开机自启、启动时自动拉起协议端与<b>关闭窗口行为</b>都在左下角 <b>设置 → 启动</b>。这些设置存进 <code>config.json</code> 的 <code>launch</code> 段，由启动器 / 桌面壳在启动时读取 —— 它们<b>不影响</b>当前这个已经开着的页面。每次启动的实际形态仍记在 <code>panel/launch-log.jsonl</code>，上面那行就是最近一条。' },
            ],
          },
        ],
      },
      {
        id: 'plugins', label: '插件', title: '插件',
        desc: '装在 <code>plugins/</code> 与 <code>skills/</code> 里的第三方插件。目录里有<b>不等于</b>会生效 —— 必须在这里勾上，且要重启机器人（不支持热插拔）。',
        draft: true,
        cards: [
          {
            id: 'plugsum', title: '插件总览与安装', span: 12,
            ctrls: [
              { t: 'pluginSummary' },
              /* 2026-10-23：上限不再写死 20 / 24。区间由 `src/field-schema.js` 的
                 `pluginMax` / `toolMax` 提供（`bounds` 读的是服务端下发的 fieldMeta），
                 这里不抄 1024 / 256 两个数字。 */
              { t: 'number', id: 'plug.max', label: '最多启用插件数', bind: 'plugins.max', bounds: 'pluginMax', min: 1, step: 1,
                hint: '默认 256。超出的会显示「超上限·未加载」，不会静默丢弃；改完要重启机器人。' },
              { t: 'number', id: 'tool.max', label: '最多注册工具数', bind: 'tools.max', bounds: 'toolMax', min: 1, step: 1,
                hint: '默认 64。工具 schema 会进每一轮请求，别调太大；改完要重启机器人。' },
              { t: 'number', id: 'plug.hookTimeout', label: '钩子单条超时（毫秒）', bind: 'plugins.hookTimeoutMs',
                bounds: 'hookTimeoutMs', min: 100, step: 100,
                hint: '默认 5000。超时的钩子会被放行并记一条警告；改完要重启机器人。' },
              { t: 'importZip', label: '装 ZIP' },
            ],
          },
          {
            id: 'pluggrid', title: '插件清单与设置', span: 12,
            /* ⚠️ `bare: true` = **不套外层 .card**（`cardHtml` 走 `bareHtml`）。
               插件网格自己就是完整的板集合：外面再罩一张 span-12 玻璃板，
               视觉上就变成「大玻璃板里切了 N 块」—— 而用户要的是每块独立浮着。
     （这里原本写着"13 块"：那是当时装着的包数，2026-10-17 那 13 个包已全部删除 ——
       数字会腐烂，写 N 才不会在下一次变成"注释说一件不再成立的事"。）
               那层外壳不是设计，是容器，所以这里把它整个脱掉。 */
            bare: true,
            ctrls: [{ t: 'pluginList' }],
          },
          {
            id: 'scope', title: '插件能做什么 / 不能做什么', span: 12,
            ctrls: [{ t: 'pluginScope' }],
          },
        ],
      },
      {
        id: 'hud', label: 'HUD调整', title: '顶栏 HUD 信息岛',
        desc: '调试顶栏状态岛的轮播项、尺寸与节奏。材质固定为玻璃并跟随主题（已去掉 HUD 核）；设置只存在这台机器的浏览器里。',
        cards: [
          {
            id: 'hudItems', title: '轮播信息项', span: 6,
            ctrls: [
              { t: 'note', text: '每项改动会立即保存到本机浏览器，重开面板仍生效。至少保留一项；灰圈只在切换时出现，并被岛体圆角裁切。' },
              { t: 'switch', id: 'hud.i.usage', label: '今日用量', read: () => hudOn('usage'), save: hudItem('usage') },
              { t: 'switch', id: 'hud.i.bridge', label: '机器人运行', read: () => hudOn('bridge'), save: hudItem('bridge') },
              { t: 'switch', id: 'hud.i.container', label: '协议端登录', read: () => hudOn('container'), save: hudItem('container') },
              { t: 'switch', id: 'hud.i.model', label: '本机模型', read: () => hudOn('model'), save: hudItem('model') },
              { t: 'switch', id: 'hud.i.memory', label: '内存占用', read: () => hudOn('memory'), save: hudItem('memory') },
              { t: 'switch', id: 'hud.i.panel', label: '面板连接', read: () => hudOn('panel'), save: hudItem('panel') },
              { t: 'switch', id: 'hud.i.account', label: '账号', read: () => hudOn('account'), save: hudItem('account') },
              { t: 'range', id: 'hud.interval', label: '轮播间隔', min: 3, max: 15, step: 1,
                read: () => Math.round(hudCfg().interval / 1000), save: hudSave({ interval: (v) => v * 1000 }) },
            ],
          },
          {
            id: 'hudLook', title: '尺寸与动效', span: 6,
            ctrls: [
              { t: 'range', id: 'hud.w', label: '宽度', min: 200, max: 640, step: 10,
                read: () => hudCfg().width, save: hudSave({ width: (v) => v }) },
              { t: 'range', id: 'hud.h', label: '高度', min: 28, max: 48, step: 1,
                read: () => hudCfg().height, save: hudSave({ height: (v) => v }) },
              { t: 'range', id: 'hud.speed', label: '动效倍速（%）', min: 50, max: 200, step: 10,
                read: () => Math.round((hudCfg().speed || 1) * 100), save: hudSave({ speed: (v) => v / 100 }) },
              { t: 'buttons', label: '', items: [
                act('重播入场', 'hud.entrance', 'btn-primary', '再看一次展开 + Welcome + 遮罩交接', 'play'),
                act('恢复默认', 'hud.reset', 'btn-ghost', '清掉本地 HUD 设置并回到默认三项轮播', 'reload'),
              ] },
              { t: 'note', text: '数据来自 <code>/api/state</code>；发送条数还没有统计源，所以暂不提供「今日发送」项。' },
            ],
          },
        ],
      },
    ],
  },
];

/* 导航用的短标签：一级 2 字、二级 2–4 字。
   完整名称仍保留在 label / title 里；页面头与面包屑继续用全名。
   2026-10-22 导航改版：把二级栏收进一级下方后，长标签会把窄条撑开。 */
const NAV_SHORT = {
  run: {
    group: '运行',
    subs: { overview: '总览', sessions: '会话', logs: '日志', fake: '假QQ' },
  },
  speak: {
    group: '发言',
    subs: { trigger: '触发', scheduled: '定时', waiting: '等待', proactive: '安静' },
  },
  persona: {
    group: '人格',
    subs: { who: '设定', enhance: '规则', reply: '回复' },
  },
  brain: {
    group: '模型',
    subs: { model: '模型', thinking: '思考', usage: '用量' },
  },
  know: {
    group: '记忆',
    subs: { memory: '自我', skills: '知识包', people: '群友', faces: '图库' },
  },
  sys: {
    group: '维护',
    subs: { safety: '安全', history: '历史', panel: '维护', plugins: '插件' },
  },
};
for (const g of GROUPS) {
  const m = NAV_SHORT[g.id];
  if (!m) continue;
  g.short = m.group;
  for (const su of g.subs) {
    if (m.subs[su.id]) su.short = m.subs[su.id];
  }
}

/* ────────────────────────────────────────────────────────────────────────
   2. 只读展示用到的取值函数
   ──────────────────────────────────────────────────────────────────────── */
function controlHintOf(s) {
  const c = j(s, ['bridge', 'control']);
  if (!c) return '';
  return c.done ? `上一次命令 ${c.cmd}：${c.done}` : `已下发 ${c.cmd}，等机器人取走`;
}
/* 服务商 → 人话名（四家写全）。⚠️ **唯一**的消费者是 `brainPickOf()` ——
   别处再抄一份映射，就会出现"横幅说一家、下面那行说另一家"（这个形状踩过）。
   兜底给 '云端' 而不是'智谱云端'：认不出时说"不知道是哪家"比指错一家安全。 */
const CLOUD_VENDOR = { deepseek: 'DeepSeek 云端', zhipu: '智谱云端', qwen: '千问云端' };

/**
 * 「现在用的是哪一套」—— **唯一判据**（2026-10-17 第三轮 · 维护者点名）。
 *
 * ⚠️⚠️ 只读 `config`（面板已选定、已经写进 config.json 的那一套），**不读 `effective`**。
 *    这不是"少判一层"，而是把两个互相打架的源头收成一个：
 *
 *      `config`    = 面板这一侧的事实：用户点了哪个，磁盘上现在就是哪个；
 *      `effective` = 机器人那一侧的事实：它**上次读到**的是哪个（切换要热重载才更新）。
 *
 *    上一版的实现是"横幅取 effective、标签高亮也靠 effective 匹配、提示语再拿 config
 *    去比对" ⇒ 刚切换完的那几十秒里页面三处各说一套（横幅还是上一家、选中的那颗挂着
 *    虚线「待生效」）。维护者 2026-10-17 明确：**点了就是它，用户自己会测** ——
 *    中间态整块去掉。
 *
 *    `effective` 的痕迹只保留在「机器人读入配置于」那一行：它描述的是**机器人的动作**，
 *    不该冒充"我在用哪个模型"。所以这里也不把 effective 的旧值混进来拼读数。
 *
 * ⚠️ `provider` 由后端 `providerOf(baseUrl)` 算好下发（唯一实现），前端不按域名重算 ——
 *    重算就是第二份会漂的规则（本项目在这件事上踩过好几次）。
 *
 * @param {object} s `/api/state` 的完整状态
 * @returns {{provider:string,isLocal:boolean,model:string,baseUrl:string,
 *            vendor:string,label:string,customId:string}}
 */
export function brainPickOf(s) {
  const provider = String(j(s, ['config', 'provider'], '')
    || j(s, ['effective', 'provider'], '') || '');
  const isLocal = provider === 'local';
  const model = j(s, ['config', 'model'], '') || j(s, ['effective', 'model'], '') || '—';
  const baseUrl = j(s, ['config', 'baseUrl'], '') || j(s, ['effective', 'baseUrl'], '') || '';
  let vendor = CLOUD_VENDOR[provider] || '';
  if (!vendor) {
    if (isLocal) vendor = '本机模型';
    // 自建 / 中转网关：写清是哪台机器，比一句"自定义"有用得多（排查时就是靠它）。
    else {
      try { const host = new URL(baseUrl).hostname; vendor = host ? `自定义（${host}）` : '自定义'; }
      catch { vendor = '云端'; }
    }
  }
  return {
    provider,
    isLocal,
    model,
    baseUrl,
    vendor,
    label: isLocal ? '本机模型（免费·不联网）' : vendor,
    customId: String(j(s, ['config', 'activeCustomId'], '') || ''),
  };
}

/**
 * 顶部那条横幅：**只报"现在这套是什么"**，不再报"哪套还没生效" ——
 * 后者是维护者点名去掉的（2026-10-17）：点一下就是它，剩下的他自己会测。
 *
 * 颜色仍然说实话：机器人没在跑时是黄条（`effective.alive` 是**另一件事**的判断，
 * 不是模型身份判断，所以留在这里合法）。
 */
function brainModeOf(s) {
  const p = brainPickOf(s);
  const alive = j(s, ['effective', 'alive']) === true;
  return {
    title: `现在在用：${p.label} · ${p.model}`,
    hint: p.isLocal
      ? '切到本机模型会自动把内存还给你。'
      : (alive ? '' : '机器人没在运行 —— 启动后就按这套走。'),
    cls: alive ? 'ok' : 'warn',
  };
}

/**
 * 「免费额度」**一颗按钮**的数据（2026-10-17 维护者第二次点名：不再单独成块）。
 *
 * 按钮上只放两样：`免费额度` + 一个 4 字左右的标签（会不会花钱）。其余（额度规则、
 * 能不能在面板里查余额、那句"用完即停要自己开"）全部进 `title` —— 鼠标停一下就有，
 * 不占版面。**文案仍然全部来自 `state.quotaPlans`**（唯一实现住 `src/free-quota.js`），
 * 前端一个字都不自己写：那句"用尽即停"是真会让人被扣钱的提醒，抄一份就多一处会烂的地方。
 */
function quotaBtnOf(s) {
  const provider = j(s, ['config', 'provider'], 'zhipu');
  const pl = j(s, ['quotaPlans', provider], null);
  const tag = provider === 'deepseek' ? '按量计费'
    : provider === 'zhipu' ? 'Flash 免费'
      : provider === 'qwen' ? '限时赠送'
        : (pl?.label || '官网查看');
  const tip = [
    pl?.kindNote || (pl ? '' : '这一版后端还没下发额度说明（重启一次面板即可）'),
    pl?.liveBalance === 'api' ? '面板能查实时余额' : '实时余额要登录官网看（面板拿不到，不编数字）',
    pl?.mustDo || '',
  ].filter(Boolean).join('\n');
  return {
    label: `免费额度 · ${tag}`,
    title: tip,
    mustDo: !!pl?.mustDo,
    hasUrl: !!pl?.controlUrl,
  };
}

/**
 * 自定义大脑：**只显示用户勾过的能力**（内置那几家不受影响）。
 *
 * ⚠️ 判据**不在前端** —— 后端下发 `config.customVisibleFeatures`（结论数组），
 *    这里只照结论决定显示与否。自己按 `features` 再判一遍就会变成两套口径，
 *    而两套口径的表现是"页面显示的"与"后端认的"不一致，两边看起来都正常。
 *    （本项目在"前端自存一份名单/判据"上已经踩过好几次，这是既有纪律。）
 *
 * @param {object} s 状态
 * @param {string} key 'vision' | 'thinking' | 'webSearch'
 */
function customFeatureVisible(s, key) {
  const vis = j(s, ['config', 'customVisibleFeatures'], null);
  if (!vis || !Array.isArray(vis)) return true; // 内置大脑（或旧版后端没下发）⇒ 照旧全显示
  return vis.includes(key);
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
  /* `ticks`：**有序档位**的横向进度条（2026-10-21 由竖向刻度改来）。
     与 `seg` 同一套数据契约（同一个 `options` / 同一个 `valueOf`/`setValue`），
     差别只在呈现：液面覆盖到第几段，所以顺序与当前档位**一眼可见**。
     ⚠️ 少于 3 档时它**自动退回 `seg`**（2 档时进度条表达不了顺序，
        白占一行高度与一套指针逻辑）。 */
  'ticks',
  /* `range`（2026-10-17）：**连续量**的进度条（区别于 `ticks` 的有限档位）。
     数据契约与 `number` 相同（`bind` / `bindSys` / `min` / `max`），额外认：
       · `scale` —— 界面值 × scale = 盘上的值（插话冷却：分钟 × 60000 = 毫秒）；
       · `log: true` —— 对数刻度（1 分钟–5 小时这种跨两个数量级的量，线性刻度会把
         常用的前半小时挤在最左边 10% 里，拖都拖不准）；
       · `marks` —— 只画刻线不写字（文字只标两端，免得窄卡里挤成一团）。
     ⚠️ 它与 `ticks` **不是**一回事：`ticks` 是有序少量档位的选择器（键盘换档语义），
        这个是真滑块（连续值 + 原生 range 的无障碍语义）。不要合并。 */
  'range',
  'sleepLine', 'sleepDetail', 'modelPick', 'routeBoard', 'packages',
  // 自定义大脑列表（2026-10-07）：渲染用户自己造的那几套 + 右键菜单（改名 / 删除）。
  // ⚠️ 与 `modelPick` 分开：那个是"选模型"，这个是"选大脑"，两件事的数据源也不同。
  // ⚠️ 2026-10-17 第二轮：列表控件已从页面上摘掉（模型都显示在 `brainTags` 里），
  //    `brainList` 不再登记 —— 控件类型清单只列**页面上真的会用到**的那些。
  /* 2026-10-17 维护者点名的重做：
     · `brainTags`  —— 顶部切换标签（只放自定义模型，右键改名/删除）
     · `quotaBtn`   —— 「一键切换」卡右下角的**一颗**「免费额度 ↗」按钮
                       （同一天先说"底部一条"，第二次又说"不要单独成块"⇒ 收成按钮） */
  'brainTags', 'quotaBtn',
  'usageBySource', 'usageByChat', 'usageByDay', 'usageTable',
  'enhance', 'scenes', 'playRules', 'skills', 'cardGrade', 'memOverview', 'memList', 'memRecords', 'autoMemList',
  'patrolView',
  'schedList', 'holidays', 'emotionState', 'pluginSummary', 'pluginList', 'pluginSettings', 'pluginScope',
  'people', 'unread', 'gallery', 'apiDeals',
  'sesList', 'sesDetail', 'chatList', 'chatDetail', 'traceList', 'logList', 'auditList',
  /* `termView`：网页内置终端（2026-10-11）—— 取代那个关不掉的前台 cmd 窗口。
     它不是一个"控件"，而是一个**自己管连接的面板**：日志由服务端经 SSE 推过来
     （`/api/console/stream`），页面重画时靠模块级状态重填，不重新建连接。 */
  'termView', 'fakeView',
  'update',
  'tryOut', 'importFile', 'importZip', 'protoInfo',
];
