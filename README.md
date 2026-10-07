<div align="center">

# QQ-BOT-Creative

**Turn a spare QQ account into an AI group member.**
It chimes in, picks up running jokes, lurks, and occasionally speaks up on its own.

<p>
  <b>English</b> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p>
  <a href="https://github.com/Canvixel-Eloweny/ai-bot-groupmate/actions/workflows/ci.yml"><img alt="Four-layer gates" src="https://img.shields.io/github/actions/workflow/status/Canvixel-Eloweny/ai-bot-groupmate/ci.yml?branch=main&label=four-layer%20gates&logo=githubactions&logoColor=white&style=for-the-badge"></a>
  <a href="https://github.com/Canvixel-Eloweny/ai-bot-groupmate/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://img.shields.io/github/actions/workflow/status/Canvixel-Eloweny/ai-bot-groupmate/codeql.yml?branch=main&label=CodeQL&logo=github&logoColor=white&style=for-the-badge"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/github/license/Canvixel-Eloweny/ai-bot-groupmate?label=license&logo=gnu&logoColor=white&style=for-the-badge"></a>
</p>

<p>
  <a href="./package.json"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS-2f77c4?logo=apple&logoColor=white&style=for-the-badge"></a>
  <a href="./package.json"><img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=nodedotjs&logoColor=white&style=for-the-badge"></a>
  <a href="./package.json"><img alt="Dependencies" src="https://img.shields.io/badge/dependencies-ws%20only-blue?style=for-the-badge"></a>
  <a href="./package.json"><img alt="Build" src="https://img.shields.io/badge/build-none-lightgrey?style=for-the-badge"></a>
</p>

<p>
  <a href="./README.md#3-three-brain-presets"><img alt="AI" src="https://img.shields.io/badge/AI-OpenAI--compatible-6f42c1?style=for-the-badge"></a>
  <a href="./CHANGELOG.md"><img alt="Release" src="https://img.shields.io/badge/release-v0.1.0-e05d44?style=for-the-badge"></a>
  <a href="https://github.com/Canvixel-Eloweny/ai-bot-groupmate/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/Canvixel-Eloweny/ai-bot-groupmate?logo=git&logoColor=white&style=for-the-badge"></a>
</p>

</div>

---

An **OneBot v11 bridge** that plugs a spare QQ account into any OpenAI-compatible model, plus a
**zero-build browser console** — switch brains, watch state, edit the persona, manage skills and memory.
All by clicking.

```
QQ alt ──► NapCat (Docker, OneBot v11) ──► bridge src/index.js ──► model
             ws/http :3000/:3001            │ trigger / context / prompt / splitting
                                            ├─ local  : MLX(:8080) / QwenChat(:8765)
                                            ├─ cloud  : DeepSeek API
                                            └─ cloud  : Zhipu GLM (only one with web search + vision)
                      ┌─────────────────────┴─────────────────────┐
                      │  console panel/server.js (:8788, 127.0.0.1) │
                      │  ├─ frontend panel/next/ (static, polls /api/state every 3s)
                      │  └─ starts/stops the bridge, 3 brain presets, custom workspace
                      └───────────────────────────────────────────┘
```

> The project was originally named `qq-bot`, renamed `QQ-BOT-Creative` on 2026-09-17; the GitHub slug is
> `ai-bot-groupmate`. The launcher is `QQ-BOT-CONTROL.app`.
> **This English README is the default. The Chinese edition lives in
> [`README.zh-CN.md`](./README.zh-CN.md) and is the authoritative one when the two differ.**

---

## 1. Local self-test (no QQ, no model)

The fastest way to see whether the code is sane — **it needs neither a QQ account nor a model endpoint**:

```bash
npm test        # behaviour regression (all local mocks)
npm run verify  # the full four-layer gate: contracts + regression + presets + panel
```

## 2. Protocol side: two routes (**read this before you start**)

**Route A (recommended): Docker + Linux arm64.** NapCat's Linux arm64 support is current, the container bundles
a matching Linux QQ, and **your local QQ client is not touched at all**.

```bash
bash scripts/bootstrap.sh     # check env → start container → print WebUI login URL
node scripts/check-onebot.js  # liveness probe + list joined groups (get group ids here)
npm start                     # run the bridge
```

Full steps: [`INSTALL-DOCKER.md`](./INSTALL-DOCKER.md).

**Route B: native macOS — currently blocked.** NapCat's Mac installer only whitelists QQ builds
`6.9.82-40768` … `6.9.93-47354`, while current QQ is past that; Tencent does not archive old versions.
Getting this route working requires a delisted QQ build. **Do not install QQ from a third-party mirror** —
the chat client holds every credential for that account.

## 3. Three brain presets

The console organises model settings into **three presets**. Switching only *materialises* one of them into
flat fields for the bridge; presets never bleed into each other, and per-brain edits survive switching away
and back.

| Preset key | Name | baseUrl | Traits |
|---|---|---|---|
| `local` | Local model | `http://127.0.0.1:<port>/v1` (MLX or QwenChat) | Offline, free, data never leaves the machine. The two local channels are **mutually exclusive** (same model memory) |
| `deepseek` | DeepSeek cloud | `https://api.deepseek.com/v1` | Cheap and good, text only |
| `zhipu` | Zhipu GLM | `https://open.bigmodel.cn/api/paas/v4` | **The only one with web search + vision**; also the always-thinking family (glm-5.3 and friends) |

The single source of truth for model capabilities (thinking levels low/high/max, web search, vision,
eligibility for the degradation chain) is `src/model-caps.js`. **The one entry point for vision is
`supportsVision()`.**

## 4. Configuration

```bash
cp config.example.json config.json   # config.json is pre-filled and gitignored
```

Minimal working config (local MLX):

```jsonc
{
  "llm": {
    "baseUrl": "http://127.0.0.1:8080/v1",
    "model": "qwen3-8b",
    "localChannel": "mlx",            // mlx / qwenchat
    "thinking": { "mode": "off", "level": "low" }
  },
  "allow": { "groups": [100000001], "private": [], "allowAllWhenEmpty": false },
  "persona": { "name": "小鱼", "file": "persona/qq-chat.md" }
}
```

Cloud DeepSeek — keep the key in the environment, not in the file:

```jsonc
{ "llm": { "baseUrl": "https://api.deepseek.com/v1", "apiKeyEnv": "QQBOT_API_KEY", "model": "deepseek-flash" } }
```

```bash
export QQBOT_API_KEY=sk-xxxx
node src/index.js
```

### Key options

| Field | Meaning |
|---|---|
| `allow.groups` / `allow.private` | Allow-list. **If empty while `allowAllWhenEmpty:false`, the process refuses to start** |
| `allow.allowAllWhenEmpty` | `true` hands the account to the model — local debugging only |
| `deny.groups` / `deny.users` | Deny-list; takes precedence over the allow-list |
| `trigger.requireAtInGroup` | Whether the bot must be @-mentioned or called by name in groups |
| `trigger.aliases` | Names that count as being addressed (e.g. `["小鱼"]`) |
| `trigger.interjectChance` | Probability of chiming in when not addressed (0–1); default 0 |
| `reply.splitToken` | Token the model uses to separate messages; default `\|\|` |
| `reply.sendDelayMs` | Delay between split messages, to avoid rate limits |
| `throttle.globalConcurrency` | **Set to 1 for local models** — concurrency doubles latency on Apple Silicon |
| `throttle.perMinutePerSession` | Per-session replies per minute |
| `custom` | Custom workspace data (8 sections, see below) |

## 5. Custom workspace

The console's "custom" area is a **data-driven modular workspace**; all structure lives in
`src/custom-config.js` (single source of truth). The frontend renders it dynamically and the backend merges
partial updates via `patchCustom()` — it **never replaces the whole object**, so editing one field cannot
wipe the others.

Sections, in display order: **persona** (12 structured fields) · **enhancements** (12 optional fields) ·
**skills** (`pack`/`persona`, scopes `global`/`group`/`user`, triggers, examples) · **memory** (automatic +
manual) · **scheduled messages** · **play rules** (injected right after the persona) · **security** · **other**.

> Persona fingerprinting invalidates stale session history when the persona changes; memory is deliberately
> excluded from the fingerprint so adding a memory does not clear history.

## 6. Persona

Edit `persona/qq-chat.md` — plain natural language. `buildMessages()` in `src/brain.js` assembles:

style rules → persona → enhancements → play rules → group background → context → current message

To make replies livelier, in order of value: write a **concrete** persona (catchphrases, message length,
when *not* to reply) · add few-shot examples inside the persona file · lower `temperature` (≈0.8 is stable;
above 1.2 it starts making things up) · use a bigger model (a local 8B holds a persona noticeably worse
than a frontier cloud model).

## 7. Design notes (why it is written this way)

- **CQ injection defence** — everything sent to the protocol side is a **message-segment array**, never a CQ
  code string. If the model emits `[CQ:at,qq=all]` it stays ordinary text and is never parsed as an instruction.
- **No self-replies** — events where `user_id === self_id` are dropped, otherwise the bot answers itself forever.
- **Allow-list fails closed** — empty allow-list without an explicit opt-in ⇒ **refuses to start**, rather than
  silently letting everything through.
- **Reconnect** with exponential backoff (1s→30s); in-flight requests are rejected on disconnect, never left hanging.
- **Rate limiting** — per-session minimum interval, per-minute cap, global concurrency semaphore.
- **Long-message splitting** prefers sentence boundaries so the protocol side does not truncate mid-sentence.
- **Degradation chain is validated on both ends** — cross-provider, duplicate and over-long entries, and
  always-thinking models are all rejected with a stated reason (a 400 is not retryable and would waste the chain).
- **Log ring buffer** — `state.logs` is capped, the backend keeps a `dropped` counter so `total` stays
  monotonic, and a lagging frontend cursor triggers a `reset` redraw.
- **Sandbox isolation** — `test/sandbox.sh` starts the panel with `QQBOT_SANDBOX=1`; in that mode the server
  **never adopts or stops a real bridge process**, so regression runs cannot kill your live bot.

## 8. Layout

```
QQ-BOT-Creative/
  README.md / README.zh-CN.md  # English (default) + Chinese (authoritative)
  INSTALL-DOCKER.md            # container install manual (incl. rollback)
  QQ-BOT-CONTROL.app           # double-click launcher: bring up Docker + open the console
  config.json                  # your config (pre-filled, gitignored)
  config.example.json          # sanitised template generated from a real config
  docker-compose.yml           # NapCat container
  persona/qq-chat.md           # persona
  plugins/                     # extensions, deterministic kind (capabilities / hooks) — 5 ship with this repo
  skills/                      # extensions, LLM kind (register tools) — 8 ship with this repo
                               #   this on-disk skills/ is NOT src/skills.js: one is code on disk,
                               #   the other is data inside config.json. The host scans, validates,
                               #   reports, and only loads packages named in the allow-list
                               #   (config.json custom.plugins.enabled), which requires a restart.
                               #   Third-party packages you drop into these directories are NOT
                               #   committed (see the per-package exceptions in .gitignore).
  panel/
    server.js                  # :8788 — every API plus route dispatch
    next/                      # current frontend: zero-build static assets + schema.js control table
    lib/                       # backend layered ESM (path/state layer → config/page/plugin → model/process)
  scripts/
    bootstrap.sh               # start the container and fetch the WebUI token
    check-onebot.js            # protocol-side liveness probe + list groups
    check-wb.mjs               # structural contracts: single entry points, no duplicate implementations,
                               #   capability tables vs measured reality, scanner self-verification
    dryrun.js                  # dry-run the whole reply chain (the console "try one sentence" calls this)
    sniff.js                   # capture OneBot events to debug "@ed but no reaction"
    status.sh                  # one screen of status
  src/                         # the bot itself (ESM, zero build, split by responsibility)
    index.js                   # wiring and main loop
    onebot.js                  # OneBot v11 WS client + message-segment parsing
    bridge-io.js               # protocol-side IO: send, history fetch, reporting
    brain.js                   # trigger decision + context + prompt assembly + splitting
    llm.js                     # OpenAI-compatible client (degradation chain + breaker)
    tool-loop.js               # tool round loop (main LLM path)
    tool-registry.js           # tool registry: names + stable specs (zero-dep leaf)
    pace.js                    # send pacing (single entry point)
    egress.js                  # outbound gate + log sanitisation (shared pattern table)
    interject.js               # unmentioned-message interjection decision
    reply-text.js              # splitting, dive placeholders, internal-mark stripping
    ambient.js / context-budget.js  # sticky context window / prompt budget and eviction
    config.js / custom-config.js / model-caps.js   # config load, workspace schema, capability truth
    field-schema.js            # declared defaults and ranges for numeric fields (zero-dep leaf)
    ── runtime scheduling ──
    sleep.js                   # sleep plan + wake-up (status is recomputed, never persisted)
    reminder.js                # scheduled reminders (three-state window + holiday table)
    notice.js                  # poke / notice-style inbound events
    session-control.js         # per-session abort and retry
    cross-send.js              # cross-session posting (off by default, quota + audit)
    forward-expand.js          # merged-forward expansion (segment/depth caps, text only)
    forward-probe.js           # real-machine probe for forward event shapes
    ── capabilities and contracts ──
    gate-scan.js               # single traversal of gate rule tables (zero-dep leaf)
    injection.js               # injection gate (dirty memory never persisted, fail-open)
    net-rules.js               # "does it cost money" (must not import safe-fetch)
    safe-fetch.js              # SSRF verdicts (extension egress goes through ext-fetch.js)
    browse-lock.js             # browse lock (allow-list + lock switch, fail-closed)
    ext-fetch.js               # extension egress (own quota, safe-fetch + gateway)
    text-hygiene.js            # request-body text hygiene (Unicode / lone surrogates)
    internal-marks.js          # single source of internal markers (never leak into chat)
    tier.js                    # usage tiers and billing rules
    holidays.js                # holiday table (table first, weekday as fallback)
    vision-probe.js            # vision capability probe (synthesised test images)
    speech-rules.js            # speaking rules (splitting / diving / closing)
    skills.js                  # skill matching from config data (prompt injection)
    memory.js / memory-record.js / memory-store.js
    usage.js                   # call accounting (source of the cost panel)
    trace-id.js / trace-stats.js   # trace ids, image hashes, cache-hit records
    ── persistence ──
    atomic-write.js            # atomic writes + startup sweep of stale temp files
    session-archive.js         # archive write/restore (stale archives are refused)
    working-memory.js          # cross-turn working memory (TTL + per-item fade)
    style-profile.js           # per-member speaking profile
    reply-track.js             # who said what in which turn
    unread.js                  # unread model (bounded; no clear-all API)
    custom-faces.js / face-habit.js / face-marks.js   # saved stickers (read-only)
    ephemeral.js / config-history.js
    ── extension execution layer ──
    plugin-manifest.js         # manifest contracts: id / apiVersion / entry
    plugin-host.js             # scans, validates, loads and runs (four states, no hot-plug)
    plugin-api.js              # builds the per-extension api (ctx trimmed)
    plugin-settings.js         # extension settings (sensitive keys, range rejection)
    hook-bus.js / send-guard.js / ext-scope.js
    control-channel.js         # panel -> bot control channel (abort/retry, idempotent)
    ── helpers ──
    logger.js · bridge-proc.js (process verification, fail-closed) · bridge-lock.js
    panel-auth.js (auth decision, pure) · proactive.js
  test/
    smoke.js                   # behaviour regression assertions
    sandbox.sh                 # isolated sandbox + panel regression
    verify-presets.mjs         # three-brain interface assertions
    e2e/                       # real-machine / real-browser scripts (not part of npm test)
```

## 9. API reference

Inputs, outputs, side effects and idempotency for every route: **[`docs/API_CONTRACT.md`](./docs/API_CONTRACT.md)**.

Deeper design documents (also part of the published repository):
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (layering and dependency direction) ·
[`docs/FRONTEND-V2.md`](./docs/FRONTEND-V2.md) (console frontend) ·
[`docs/MOTION-METHODOLOGY.md`](./docs/MOTION-METHODOLOGY.md) (motion parameters).

## 10. Known limitations

- **No streaming** — the whole reply is generated before sending. Incremental character-by-character output
  in a group chat looks less human, not more.
- **Voice and video become placeholder text.** Images are genuinely understood by **vision-capable models**
  (e.g. glm-4.6v-flash); text-only models still receive a placeholder.
- **Cross-restart context relies on session archives**, and archives past a freshness threshold are
  **refused** — better to forget than to resume a topic that ended long ago.
- **Single process, single account.** Multi-account is not implemented.
- The console **reads from disk on every request** (zero build). Editing `server.js` requires restarting the
  panel process (`POST /api/panel/restart` is idempotent).
- **Extensions can execute, but "on disk" and "in effect" are still two different things** — `plugins/` and
  `skills/` are scanned, validated and listed, but only packages named in the allow-list are actually loaded.

## 11. Roadmap

Everything below is **known-not-done**, taken from the limitations above. No time commitments — this is a
one-person project and priorities follow real pain.

- [ ] **Multi-account support** — currently single process / single instance.
- [ ] **Understanding voice and video content** — today they become placeholder text.
- [ ] **Outbound rich media** — sending images / using saved stickers. Stickers are currently read-only.
- [ ] **Native macOS protocol side** (route B) — blocked by NapCat's QQ version allow-list.
- [ ] **Hot-reloading extensions** — changing the allow-list still requires restarting the bot.

## 12. Contributing

Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md). Three things to know before writing code:

1. **The gates are four layers** — `check-wb` structural contracts, `smoke` behaviour regression, and the
   sandboxed `presets` and panel self-checks. Run the whole thing with `npm run verify`.
2. **Every fix needs a mutation test that only catches that one fix.** "The assertion exists" is not the same
   as "the assertion is wired up".
3. **Gate counts are deliberately not hard-coded in this document.** They rotted four times before anyone
   noticed, so the real numbers live in exactly one place: the output of `npm run verify`. If you are tempted
   to write "N assertions" here again — that sentence is the reason you should not.

Also read [`CHANGELOG.md`](./CHANGELOG.md) and [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## 13. Contact

| Channel | Use |
|---|---|
| [Issues](../../issues) | **Preferred.** Questions, bugs, feature requests — public discussion is searchable by the next person; a DM is not |
| [`SECURITY.md`](./SECURITY.md) | Report vulnerabilities **privately**; do not open a public issue |

Two things to do first: **redact real QQ numbers / group ids / chat logs** before posting, and run
`npm run verify` and paste the output — a minimal reproduction beats a long description.

## 14. License and credits

| Item | Value |
|---|---|
| License | **Apache-2.0** — full text in [`LICENSE`](./LICENSE), attribution notice in [`NOTICE`](./NOTICE) |
| Third-party notices | [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) |
| Runtime dependencies | Only `ws` (MIT). Zero build, no other third-party runtime dependency |

**Apache-2.0 in three sentences.** ① Use it freely: read, run, modify, ship it — even closed-source, no
permission needed. ② Just keep `LICENSE` and `NOTICE` with it and mark the files you changed. ③ It grants
an explicit patent license and reserves trademark rights; it does **not** require you to publish your
changes (there is no network clause).

**NapCat is not part of this repository.** Running it requires an OneBot v11 implementation (in practice
NapCatQQ), whose custom *Limited Redistribution License* is not an OSI-approved open-source licence and
explicitly restricts building other projects from its code. This project therefore only calls it through
official channels, shares no code with it, and distributes none of its code or binaries. Obtain it yourself
and follow its licence.

`plugins/` and `skills/` ship **13 extensions written for this project** (5 deterministic + 8 LLM kind) and
are ready to use out of the box. Third-party packages *you* drop into those directories are **not**
committed (see the per-package exceptions in `.gitignore`). Which of them actually load is decided by
`custom.plugins.enabled` in `config.json` — ⚠️ there is **no hot-plug**: changing the allow-list needs a
restart (the console says so when you do). Also not distributed: `napcat/` (the protocol side) and the data
directories extensions write at runtime — see `THIRD-PARTY-NOTICES.md` §3.

---

<div align="center">
  <sub><b>English</b> · <a href="./README.zh-CN.md">简体中文</a></sub>
</div>
