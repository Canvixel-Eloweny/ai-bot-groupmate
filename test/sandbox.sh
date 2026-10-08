#!/bin/bash
# 一键搭出「隔离沙箱」，用它跑 test/verify-*.mjs，绝不碰真实配置和真实进程。
#
# 手动搭很容易漏步骤，漏了会得到**假失败**（看起来像代码坏了，其实是沙箱不对）：
#   ① 端口不重映射 → 断言的 18765/18080 对不上，报「baseUrl → 本机」失败；
#   ② 不删 panel/effective.json → 真实机器人的进程快照会让「实际生效大脑」永远显示本机；
#   ③ 假 HOME 里没有假模型目录 → 「规格」下拉只剩「没找到本机模型」；
#   ④ 依赖项目里碰巧存在的运行时数据（panel/local-trace.jsonl）—— 用户在面板上点一下
#      「清空对话流」，对话流那几条断言就全挂了。所以脚本**自己造**测试数据。
#
# 用法：
#   bash test/sandbox.sh          # 起沙箱后端（:8790），打印后续怎么跑测试
#   bash test/sandbox.sh --run    # 起沙箱 → 跑完两套测试 → 自动收尾（npm run test:panel 用的就是这个）
#   bash test/sandbox.sh --stop   # 收掉沙箱后端
#
# 注意：沙箱里的后台进程必须脱离当前会话起（本脚本用 Python 的
# start_new_session=True）。直接 nohup & 在 /tmp 下会被系统回收，
# 表现为「刚起好，下一条命令就连不上了」。
set -u

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SB=/tmp/qqbot-sandbox
FAKE_HOME=/tmp/qqbot-sandbox-home
PORT=8790
# 沙箱面板的 token（B9c · AUTH-PANEL）。
#
# 为什么沙箱**也强制鉴权**、而不是"沙箱一律放行"：
#   "放行"要在 `panel/server.js` 里留一条 `if (SANDBOX) return allow` ——
#   那是一条生产环境也存在的旁路；万一真机哪次带了 QQBOT_SANDBOX=1，
#   鉴权会**静默消失**（正是 B9 花了整批去找的那一类 fail-open）。
#   改成"沙箱自己也设一个 token"之后，服务端就**没有**旁路分支了，
#   而强制路径反而被沙箱真实地测到了 —— 比放行更严，也更好验。
#
# 值写死、不是为了保密，是为了**可预测**：面板与测试脚本读同一个值，
# 任何一侧拿错都表现为明确的 401，而不是"时灵时不灵"。
# @sync-with panel-token-env
# 变量名与 `src/panel-auth.js` 的 `TOKEN_ENV`、`test/verify-presets.mjs` 的读取处
# 必须**逐字相同**（由 `check-wb` 第 9 节契约比对）。
# ⚠️ 这里原本还并列点名 `test/verify-panel.mjs`。它已在 S-12 第六批（2026-10-05）
#    随旧页面（`panel/parts/` + `page-parts.js`）一起删除，锚点的登记随之收窄。
#    改名只改一处 → 沙箱会在"没设 token"的状态下跑，而它**不报错**。
QQBOT_PANEL_TOKEN="${QQBOT_PANEL_TOKEN:-SANDBOX-FAKE-TOKEN-0123456789abcdef}"
export QQBOT_PANEL_TOKEN
NODE="${NODE:-$(command -v node)}"
PY="${PY:-$(command -v python3)}"

stop() {
  pids="$(lsof -ti :$PORT 2>/dev/null)"
  [ -n "$pids" ] && kill $pids 2>/dev/null
  # 沙箱面板可能拉起过自己的「假机器人」（比如测试触发了 startBridge）。
  # 必须按沙箱自己的 pid 文件把它一起收掉 —— 只杀面板的话，
  # 那个连着**真实 QQ**的假机器人会成孤儿一直活着（2026-09-19 事故实录）。
  if [ -f "$SB/panel/.bridge.pid" ]; then
    sb_bridge="$(cat "$SB/panel/.bridge.pid" 2>/dev/null)"
    [ -n "$sb_bridge" ] && kill "$sb_bridge" 2>/dev/null
  fi
  sleep 0.5
  # 沙箱是真实 config.json 的**完整副本（含 API Key）**，跑完必须连目录一起删，
  # 不能只杀进程 —— 否则敏感副本一直躺在 /tmp 里。下次要测时脚本会重新建。
  rm -rf "$SB" "$FAKE_HOME"
  lsof -ti :$PORT >/dev/null 2>&1 && echo "⚠️ :$PORT 仍被占用" || echo "✅ 沙箱已停止并清理（:$PORT 已释放）"
}

[ "${1:-}" = "--stop" ] && { stop; exit 0; }
RUN_TESTS=0
[ "${1:-}" = "--run" ] && RUN_TESTS=1

lsof -ti :$PORT >/dev/null 2>&1 && { echo "⚠️ :$PORT 已被占用 —— 先跑 bash test/sandbox.sh --stop"; exit 1; }

rm -rf "$SB" "$FAKE_HOME"
mkdir -p "$FAKE_HOME/models/Qwen3.5-4B-MLX-4bit" "$SB"
# 快照数据（local-trace.jsonl）要带上：对话流卡片是靠它渲染的。
# 但**运行态文件绝不能进沙箱**：.bridge.pid 里是真实机器人的 pid，带进去沙箱就会以为
# 「桥接在跑」—— 此后任何 stopBridge（/api/debug、/api/bridge/stop 都会触发）杀的就是
# 真实进程，startBridge 还会拉起连着真 QQ 的假机器人（2026-09-19 事故实录）。
# .thinking.json / .debug 同理，都是别的进程的私有状态；.backup/ 是 11MB 手工快照，与测试无关。
# 更彻底的一层（2026-09-19 第二次事故后补）：下面起面板时带了 QQBOT_SANDBOX=1，
# 面板在沙箱模式下**根本不会**接管 / 启动 / 停止任何机器人进程——就算 .bridge.pid 漏进来也无害。
#
# ⚠️ `panel/config-history.jsonl` 同样排除（B10b · O-CFGHIST）：它是**全量配置的历史**，
#    一份条目就是一份完整的 config.json（含 API Key）。带进沙箱等于把凭据抄 20 遍到 /tmp。
#    （为什么历史里必须留真 Key：见 src/config-history.js —— 抹空会让"撤销"毁掉凭据。）
# ⚠️ `config.json` 也排除在外（B9 · K-SANDBOX）：它是**含真实 API Key** 的配置，
#    以前整份 rsync 进来，等于每次跑测试都往 /tmp 抄一份凭据，跑完靠脚本自己删干净。
#    现在改成喂**脱敏副本**（下面几步）—— 万一哪次没删成功，躺在 /tmp 的也不是真 Key。
# ⚠️ `panel/prompt-stats.json` 也排除（第 37 轮 · O-CACHESTAT）：
#    它是**本机真实运行**的命中率留档。沙箱里跑的是 mock 对话 + 被测试改过的配置，
#    前缀占比与真机不是一回事；带进去只会让沙箱里的趋势数字看起来像"真机的"。
#    排除它，沙箱里的那一份就是从零开始（与 trace / usage 的处置一致）。
# ⚠️ `plugins/` 与 `skills/` 也排除（第 44 轮 B12d · EX-PLUGIN）：
#    它们是**用户自己装的**第三方扩展包，与 napcat/ 同性质 —— 别人的代码、可能带凭据。
#    带进去的后果有两个：宿主会在 /tmp 里扫到一堆真包、把沙箱日志淹掉；
#    而将来接上执行层之后，更等于在 /tmp 里跑了一份用户的插件代码。
#    （测试要用的扩展包样本放 `test/fixtures/`，由测试自己指 QQBOT_PLUGINS_DIR 过去。）
#    ⚠️ **前导斜杠不能省**：rsync 的 pattern 不带 `/`（末尾那个不计）时匹配**任意层级**，
#       写成 `plugins/` 会把 `test/fixtures/ext/plugins/` 一并排除 ——
#       于是沙箱里的 smoke 找不到 fixture，而那个失败看起来像"测试写错了"。
# ⚠️ 原子写的临时文件也排除（2026-10-01 代码审查补）：
#    `src/atomic-write.js` 头注释第 20 行就写着"这些目录会被 rsync 进沙箱（垃圾会跟着进 /tmp）"，
#    而排除清单里一直**没有**这一条 —— 实测 2026-10-01 已累积 **168 个**
#    `panel/..thinking.json.<pid>.*.tmp`，每次 `--run` 都被原样复制进 /tmp。
#    它们不属任何断言，只增加复制量与噪音（根因见 `src/index.js` 的 THINKING_FILE 注释）。
# ⚠️ 真实用量账本同样排除（同批）：它是**本机真实运行**的账目，理由与 `prompt-stats.json` 逐字相同
#    —— 带进去只会让沙箱里的用量看起来像真机的。下面 ③b 会自己造一份**确定形状**的夹具，
#    Q70 的"按来源分账"行为判据就建在它上面（可复现，不随真机账本漂移）。
rsync -a --exclude 'napcat/' --exclude '.backup/' --exclude '.backup-*' \
  --exclude 'panel/*.log' --exclude 'config.json' \
  --exclude 'panel/.bridge.pid' --exclude 'panel/.thinking.json' --exclude 'panel/.debug' \
  --exclude 'panel/.token' \
  --exclude 'panel/.bridge-cmd.json' \
  --exclude 'panel/.bridge.lock*' \
  --exclude 'panel/config-history.jsonl' \
  --exclude 'panel/session-archive.json' \
  --exclude 'panel/prompt-stats.json' \
  --exclude 'panel/style-profile.json' \
  --exclude 'panel/memory-records.json' \
  --exclude 'panel/reminder-state.json' \
  --exclude 'panel/forward-probe.jsonl' \
  --exclude 'panel/*.tmp' \
  --exclude 'panel/usage*.jsonl' \
  --exclude '/plugins/' --exclude '/skills/' \
  --exclude '/data/' \
  --exclude '/.env' \
  "$SRC/" "$SB/"

# 喂脱敏后的配置。脱敏器与 config.example.json **共用同一份规则与同一份自检**
# （scripts/sanitize-config.mjs）—— 两处各写一份，就会出现"example 抹干净了、
# 沙箱副本漏了"这种从代码上看不出来的差别。
# 它写出前会自检（不允许残留任何非空凭据），自检不过就非 0 退出 → 这里当场中止，
# 宁可测试跑不起来，也不把未脱敏的配置放进 /tmp。
# 注意：只清凭据，**群号保留** —— 那是面板要显示的内容，不是密钥（边界写在这里，免得以后有人以为漏了）。
# 注意两件事：
#   ① 凭据用 `--credentials fake`（一眼可辨的假值）而不是清空。清空会让
#      "切服务商自动换 Key" 那几条断言**永远失去意义**（实测会掉 3 条断言）——
#      测试要跑的是完整路径，不是"全部为空"这条退化路径。假值带服务商名，
#      所以"换成了另一把"仍然判得出来。
#   ② 只清凭据，**群号保留** —— 那是面板要显示的内容，不是密钥（边界写在这里，免得以后有人以为漏了）。
if [ -f "$SRC/config.json" ]; then
  if ! "$NODE" "$SRC/scripts/sanitize-config.mjs" --in "$SRC/config.json" --out "$SB/config.json" --credentials fake; then
    echo "⚠️ 配置脱敏失败 —— 拒绝把未脱敏的配置放进沙箱，已中止"
    rm -rf "$SB" "$FAKE_HOME"
    exit 1
  fi
  # 双保险：回读沙箱里的那一份再验一次。上一步验的是写之前的内存对象，
  # 这一步验的是**真正躺在 /tmp 的那个文件** —— 排查泄漏时要信的只有后者。
  if ! "$NODE" "$SRC/scripts/sanitize-config.mjs" --self-check --in "$SB/config.json"; then
    echo "⚠️ 沙箱配置副本自检不通过，已清理中止"
    rm -rf "$SB" "$FAKE_HOME"
    exit 1
  fi
else
  cp "$SRC/config.example.json" "$SB/config.json"
  echo "· 没有 config.json，用 config.example.json 当沙箱配置"
fi
# ⚠️ 兜底自证（2026-09-29 · 外包任务2 v1 加）：与脱敏器「静默跳过」解耦 ——
#    不管脱敏器因为什么没写出文件（符号链接路径、权限、被将来的改动改了调用形状…），
#    都不许在**缺配置**的状态下继续跑：那会让 presets ENOENT 崩、panel 出一串
#    与代码无关的红，而**退出码仍然是 0 附近的样子**（失败伪装成成功）。
if [ ! -f "$SB/config.json" ]; then
  echo "⚠️ 沙箱配置副本没有生成（脱敏器静默未执行？）—— 中止，绝不在缺配置的状态下跑测试"
  rm -rf "$SB" "$FAKE_HOME"
  exit 1
fi

# ① 端口重映射 —— 现在走**环境变量**，不再改源码（B11b-1 改）。
#    以前这里是 `perl -pi -e` 就地替换 server.js 里的字面量
#    （`const LOCAL_MODEL_PORT = 8080;` / `const QWENCHAT_PORT = 8765;`）。两个问题：
#      ① 那些常量一旦被搬到别的文件（B11b 的拆分正是这么做的），perl **静默找不到** ——
#         不替换、也不报错，于是沙箱又用回真机端口，而"沙箱隔离"是硬约定；
#      ② 它让"就地改源码"变成了测试流程的一环。
#    改成 `QQBOT_LOCAL_MODEL_PORT` / `QQBOT_QWENCHAT_PORT`（与 `QQBOT_PANEL_PORT` 同款约定）后，
#    常量放哪儿都不影响。具体值写在下面起面板的那段 env 里。
#    ⚠️ 别把这两行 perl 加回来 —— 常量现在不在 server.js 里了。
# ② 去掉会带偏「实际生效大脑」的运行态文件
rm -f "$SB/panel/effective.json"

# ③ 造一份对话流测试数据（字段和机器人真写的一致）。
#    断言要验「源文件不止 3 条、页面只显示最新 3 条」，所以这里写 5 条。
"$PY" - "$SB/panel/local-trace.jsonl" <<'PYEOF'
import json, sys, time
path = sys.argv[1]
now = int(time.time() * 1000)
rows = []
for i in range(1, 6):
    rows.append({
        "ts": now - (6 - i) * 60000,
        "group": "100000001",
        "sender": f"群友{i}",
        "reason": "被 @ 了",
        "model": "glm-4.6v-flash",
        "baseUrl": "https://open.bigmodel.cn/api/paas/v4/",
        "used": "glm-4.6v-flash",
        "downgraded": False,
        "thinking": {"mode": "on", "level": "low"},
        "text": f"群友{i}: 这是第 {i} 条测试消息",
        "prompt": "（测试用提示词）\n" + "很长的提示词内容 " * 40,
        "messageCount": 3,
        "ms": 1234,
        "usage": {"prompt": 120, "completion": 30, "reasoning": 0},
        "raw": f"第 {i} 条原始输出 || 第二段 || 第三段",
        "silent": False,
        "chunks": [f"第 {i} 段", "第二段"],
        "error": "",
    })
with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
PYEOF

# ③b 造一份用量账本夹具（2026-10-01 · Q70 的行为层判据建在它上面）。
#     字段形状与 `src/usage.js` 的 `recordUsage` 逐字段一致。
#     刻意的形状：
#       · **四条带 `s`**（`agent` 两笔 + `memoryJudge` 一笔 + `proactiveTopic` 一笔）
#         —— Q70 那版只有前两个来源，B3 补上第三个：「枚举被截断 / 第三来源被吞」才会现形；
#         其中 agent 两笔来源相同、token 不同，所以"取桶结果被丢弃"的表现是这些桶**整个消失**
#         （`readUsage` 末尾按 calls > 0 过滤）；
#       · 一条**不带** `s`（老记录）→ 应归「未标注」（空 key），不猜、不回填。
#     ⚠️ 文件名用 `2026-01` 这个不存在的月份，避免与真机当月账本重名；
#        真实账本已在上面的 rsync 里排除（见那段注释）。
"$PY" - "$SB" <<'PYEOF'
import json, os, sys, time
sb = sys.argv[1]
now = int(time.time() * 1000)
base = "https://open.bigmodel.cn/api/paas/v4/"
def rec(dt, p, c, s=None, k=""):
    r = {"t": now - dt, "model": "glm-4-flash", "b": base, "v": "zhipu",
         "local": False, "think": "off", "level": "low",
         "p": p, "c": c, "r": 0, "h": 0, "a": 1, "k": k}
    if s is not None:
        r["s"] = s
    return r
rows = [
    rec(30000, 100, 20, "agent", "group:100000001"),
    rec(20000, 40, 10, "agent", "group:100000001"),
    rec(10000, 30, 5, "memoryJudge"),
    # ⚠️ 第 5 条（2026-10-01 · 评审件 §3-B3）：**第三个来源**也必须被夹具覆盖 ——
    #    夹具是"断言强度"的**输入侧**：输入只有两个来源时，任何"枚举被截断 / 第三来源被吞"
    #    的改坏都测不出来（回执实测：增强版断言在 `srcKeys.slice(0,2)` 下命中 2 红，现行版全绿）。
    rec(2000, 50, 10, "proactiveTopic"),
    rec(5000, 7, 3),                      # 老记录：没有 s → 未标注
]
path = os.path.join(sb, "panel", "usage-2026-01.jsonl")
with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
PYEOF

# ⑤ 扩展包数据夹具（M-1 · 2026-10-04）：新版面板的真实浏览器自检要验两页
#    「情绪」与「免费额度情报」，而它们读的是**扩展包产出的数据文件**：
#      · `data/bot-state.json`   ← `plugins/本体情绪`
#      · `data/api-deals.json`   ← `skills/AI额度情报`
#    沙箱把整个 `/data/` 排除了（上面 rsync 那段）⇒ 那两页在沙箱里必然显示骨架 ⇒
#    自检会红，而红的原因是**沙箱缺数据**、不是页面坏了（假红最坏的那一类：
#    它会让人去改一个本来就对的页面）。
#    修法与 ④ 同一个口径：**沙箱自己造测试数据**（不碰用户真数据）。
#    ⚠️ 形状必须与 `panel/lib/bot-data.js` 里那两个 `readXxx()` 的期望逐字对齐 ——
#       它是**唯一的读盘口**，形状错了会以"页面渲染出 0 行"的形式静默失败。
mkdir -p "$SB/data"
cat > "$SB/data/bot-state.json" <<'JSONEOF'
{
  "mood": 0.62,
  "arousal": 0.35,
  "energy": { "physical": 0.7, "cognitive": 0.8, "emotional": 0.55, "will": 0.6 },
  "acuteStress": 0.1,
  "chronicStress": 0.2,
  "intent": "看群里在聊什么",
  "emotions": { "anger": 0, "joy": 0.4, "curiosity": 0.7, "loneliness": 0.15, "boredom": 0.05 },
  "lastEvent": { "kind": "chat", "note": "沙箱夹具", "chatKey": "group:20001", "at": 1780000000000 }
}
JSONEOF
cat > "$SB/data/api-deals.json" <<'JSONEOF'
{
  "items": [
    { "id": "fixture-1", "title": "沙箱夹具 · 某模型免费额度", "brand": "夹具厂商", "amount": "100 万 tokens", "deadline": "2026-12-31", "url": "https://example.invalid/deal", "source": "sandbox", "free": true, "at": 1780000000000 },
    { "id": "fixture-2", "title": "沙箱夹具 · 某平台新用户礼包", "brand": "夹具厂商", "amount": "50 元", "deadline": "2026-11-30", "url": "https://example.invalid/deal2", "source": "sandbox", "free": true, "at": 1780000000001 }
  ],
  "lastRefresh": 1780000000000,
  "lastError": ""
}
JSONEOF

# ④ 智谱「资源包余额」接口的离线夹具（B9 · K-SANDBOX）。
#    面板首屏会**真的去调智谱的余额接口**（就是「赠送额度」那 4 条进度条）。
#    沙箱既不该有出站流量、也不该依赖真实凭据 —— 所以喂一份固定响应。
#    条数刻意是「5 条原始 / 4 条有效」：多出来的那条 consumeType=SEARCH 用来证明
#    「只列按 token 计费的推理包」这道过滤是真的在生效（verify-presets 要的就是 4 条）。
cat > "$SB/zhipu-packages.fixture.json" <<'JSONEOF'
{
  "code": 200,
  "msg": "查询成功",
  "total": 5,
  "rows": [
    { "resourcePackageName": "【新用户专享】GLM-4.6 推理包", "suitableModel": "glm-4.6", "availableBalance": 980000000, "tokensMagnitude": 1000000000, "expirationTime": "2026-12-31 23:59:59", "consumeType": "TOKENS", "status": "EFFECTIVE" },
    { "resourcePackageName": "【新用户专享】GLM-4.5 推理包", "suitableModel": "glm-4.5", "availableBalance": 450000000, "tokensMagnitude": 1000000000, "expirationTime": "2026-12-31 23:59:59", "consumeType": "TOKENS", "status": "EFFECTIVE" },
    { "resourcePackageName": "【新用户专享】GLM-4-Flash 推理包", "suitableModel": "glm-4-flash", "availableBalance": 30000000, "tokensMagnitude": 500000000, "expirationTime": "2026-12-31 23:59:59", "consumeType": "TOKENS", "status": "EFFECTIVE" },
    { "resourcePackageName": "【新用户专享】GLM-4-Air 推理包", "suitableModel": "glm-4-air", "availableBalance": 0, "tokensMagnitude": 100000000, "expirationTime": "2026-12-31 23:59:59", "consumeType": "TOKENS", "status": "EFFECTIVE" },
    { "resourcePackageName": "搜索次数包", "suitableModel": "", "availableBalance": 100, "tokensMagnitude": 1000, "expirationTime": "", "consumeType": "SEARCH", "status": "EFFECTIVE" }
  ]
}
JSONEOF

"$PY" - "$SB" "$FAKE_HOME" "$PORT" "$NODE" <<'PY'
import os, subprocess, sys
sb, fake_home, port, node = sys.argv[1:5]
env = dict(os.environ, HOME=fake_home, QQBOT_PANEL_PORT=port, QQBOT_SANDBOX="1",
           # 端口重映射（B11b-1 起走环境变量，不再 perl 改源码，见上面 ①）
           # @sync-with sandbox-port-env
           #   这两个变量名必须与 `panel/lib/paths.js` 读的**逐字相同** —— 由
           #   `check-wb` 第 9 节契约比对。以前只查了 paths.js 一侧，没查这里：
           #   一侧改名、另一侧没跟的表现是"沙箱用回真机端口"，要等真机在跑时才炸。
           QQBOT_LOCAL_MODEL_PORT="18080", QQBOT_QWENCHAT_PORT="18765",
           # 余额接口走夹具：沙箱不发任何出站请求（见上面 ④ 的说明）
           QQBOT_ZHIPU_PACKAGES_FIXTURE=os.path.join(sb, "zhipu-packages.fixture.json"),
           # M-1（2026-10-04）：扩展包数据目录指向**沙箱自己造的夹具**（见上面 ⑤）。
           # ⚠️ 不指它的话，面板会去读真机的 `data/`（那里是**真实**的情绪与额度），
           #    既污染沙箱、又让"验的是不是夹具"这件事说不清。
           QQBOT_DATA_DIR=os.path.join(sb, "data"))
# 清掉沙箱自己的 HTTP 代理设置，免得 127.0.0.1 被塞进代理
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    env.pop(k, None)
# 刻意让 docker 在沙箱里**连不上**：假 HOME 已经让 CLI 找不到 Docker Desktop 的
# per-user socket，这里再把 DOCKER_HOST 也摘掉，保证「一键启动」之类的写操作
# 永远碰不到你真实的容器（代价是 docker 相关分支只能验证优雅失败这条路）。
env.pop("DOCKER_HOST", None)
subprocess.Popen([node, "panel/server.js"], cwd=sb, env=env,
                 stdout=open("/tmp/sb-panel.log", "ab"), stderr=subprocess.STDOUT,
                 start_new_session=True)
PY

for _ in $(seq 1 40); do
  curl -s --noproxy '*' -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/api/state" && break
  sleep 0.3
done
curl -s --noproxy '*' -o /dev/null -w "沙箱后端 HTTP %{http_code}\n" "http://127.0.0.1:$PORT/api/state" || true

if [ "$RUN_TESTS" = "1" ]; then
  cd "$SRC"
  # ⚠️ 退出码必须**如实上抛**（M-1 · 2026-10-04）：本段以前结尾写死 `exit 0`，
  #    会把上面各层的失败**一起吞掉** —— 那是"假绿"的经典形状（跑挂了也返回成功）。
  rc=0
  # ③ 新版面板 —— **真实浏览器**自检（走 CDP 直连本机 Edge，见该文件头）。
  #    它验的是**面板真正在发的那条路径**（`GET /`）；数据夹具见上面 ⑤。
  #    ⚠️ **必须排在 `verify-presets` 之前**（2026-10-04 实测）：预设层会**切换大脑**，
  #       那会改变页面状态；浏览器自检里有一支探针假定"某个节点在"，被预设动过之后就取不到了 ——
  #       表现是 `TypeError: Cannot read properties of undefined (reading 'querySelector')`
  #       直接崩掉整条自检（而它单独跑是 80/80 全绿）。这正是"顺序也是判据"那一类。
  "$NODE" panel/next/verify.mjs --url "http://127.0.0.1:$PORT/" || rc=1
  echo
  VERIFY_BACKEND="http://127.0.0.1:$PORT" VERIFY_CONFIG="$SB/config.json" \
    "$NODE" test/verify-presets.mjs || rc=1
  echo
  # ④（**S-12 第六批已删除**）：这里原来跑 `test/verify-panel.mjs` —— 旧面板那 403 条断言。
  #    那个文件连同 `panel/parts/` + `panel/lib/page-parts.js` 已整块删除（对象是**已下线
  #    的页面**，`docs/FRONTEND-V2.md` 自述"断言的对象已经不是产品面了"）。
  #    现在面板侧的真实验收在上面 ③：`panel/next/verify.mjs`（真实浏览器、真接口、
  #    真写一次）—— 数量少得多，但它验的是**产品面本身**。
  stop
  exit "$rc"
fi

# L-08（2026-10-05 · 第 12 轮 · 开源前审查）：本节原来写着"这里**故意没有**把面板的真实
# 浏览器自检接进来"，并给了两条理由 —— 而那两条在**写下的那一刻就已经过期**：
#   ① "本文件结尾是 `exit 0`，会把各层的退出码吞掉"：`--run` 那条路早在 2026-10-04
#      就改成 `rc` 收集 + `exit "$rc"` 如实上抛（见上面 ③）。这里描述的是**更早的结尾**。
#   ② "那两组断言依赖扩展包的数据文件、沙箱里没有"：沙箱现在**自己造数据夹具**（见上面 ⑤），
#      ③ 跑的就是真实的浏览器自检，实测 89/94（其中 5 条红是插件板的在制品，与沙箱无关）。
# 现在改为**如实描述**。同时**去掉正文里的反引号**：
#
# ⚠️ 这一段在**未加引号**的 heredoc（`cat <<EOF`）里，正文的反引号会被 shell 当作
#    **命令替换**执行掉。旧文本里的 `panel/next/verify.mjs` 就是这种形状：
#    运行时它真的会去执行那个路径、往 stderr 打一行 "No such file or directory"，
#    而正文里那处**静默变成空**（读起来像少打了一个词）。这是一种**不会让你失败、
#    但会静静改掉输出**的缺陷 —— 已登记为 `check-wb` 的判据（含本段在不在的核对）。
#    要在这个位置写字面反引号，得把 heredoc 定界符加引号（`<<'EOF'`）—— 但那样
#    下面的 $SRC / $PORT 就不再展开了，本段是故意要展开的。
cat <<EOF

沙箱就绪。跑测试（$SRC 下）：

  VERIFY_BACKEND=http://127.0.0.1:$PORT VERIFY_CONFIG=$SB/config.json $NODE test/verify-presets.mjs

或者直接一条：bash test/sandbox.sh --run（跑完自动收尾）
收尾：bash test/sandbox.sh --stop

面板侧的**真实浏览器**自检（panel/next/verify.mjs）已经接进 --run 那条路（见上面 ③）：
  它排在 verify-presets 之前，退出码与其余各层一样**如实上抛**（已经没有"故意不接"这回事）。
  要单独跑（沙箱仍在跑着的时候）：

    $NODE panel/next/verify.mjs --url http://127.0.0.1:$PORT/

  ⚠️ 顺序本身就是判据：先跑它、再跑 verify-presets —— 预设层会**切换大脑**，之后页面状态就变了。
EOF
