<div align="center">

<img src="https://gcore.jsdelivr.net/gh/Canvixel-Eloweny/ai-bot-groupmate@main/assets/logo-v5.svg" alt="Estrella Bot" width="140">

# Estrella Bot · QQ-BOT-Creative

**Turn a spare QQ account into an AI group member.**
It chimes in, picks up running jokes, lurks, and occasionally speaks up on its own.

OneBot v11 · NapCat · a local model or DeepSeek / Zhipu / Qwen · a zero-build web console

<p>
  <b>English</b> · <a href="./docs/README.zh-CN.md">简体中文</a>
</p>

<p>
  <a href="https://github.com/Canvixel-Eloweny/ai-bot-groupmate/actions/workflows/ci.yml"><img alt="Four-layer gates" src="https://img.shields.io/github/actions/workflow/status/Canvixel-Eloweny/ai-bot-groupmate/ci.yml?branch=main&label=four-layer%20gates&logo=githubactions&logoColor=white&style=for-the-badge"></a>
  <a href="https://github.com/Canvixel-Eloweny/ai-bot-groupmate/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://img.shields.io/github/actions/workflow/status/Canvixel-Eloweny/ai-bot-groupmate/codeql.yml?branch=main&label=CodeQL&logo=github&logoColor=white&style=for-the-badge"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/github/license/Canvixel-Eloweny/ai-bot-groupmate?label=license&logo=gnu&logoColor=white&style=for-the-badge"></a>
</p>

<p>
  <a href="./package.json"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-2f77c4?style=for-the-badge"></a>
  <a href="./package.json"><img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=nodedotjs&logoColor=white&style=for-the-badge"></a>
  <a href="./package.json"><img alt="Dependencies" src="https://img.shields.io/badge/dependencies-ws%20only-blue?style=for-the-badge"></a>
  <a href="./package.json"><img alt="Build" src="https://img.shields.io/badge/build-none-lightgrey?style=for-the-badge"></a>
</p>

<p>
  <a href="./README.md#4-interfaces-plugins-and-skills"><img alt="AI" src="https://img.shields.io/badge/AI-OpenAI--compatible-6f42c1?style=for-the-badge"></a>
  <a href="./docs/release/CHANGELOG.md"><img alt="Release" src="https://img.shields.io/badge/release-v0.1.6-e05d44?style=for-the-badge"></a>
  <a href="https://github.com/Canvixel-Eloweny/ai-bot-groupmate/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/Canvixel-Eloweny/ai-bot-groupmate?logo=git&logoColor=white&style=for-the-badge"></a>
</p>

<hr>

<p><sub><b>Console preview</b> · 控制台预览画面 — run overview, persona, glass lab and persona studio</sub></p>

<p><img src="https://gcore.jsdelivr.net/gh/Canvixel-Eloweny/ai-bot-groupmate@main/assets/panel-preview-v3.jpg" alt="The console: run overview, persona, glass lab and persona studio" width="880"></p>

<hr>

<p><sub>The English README is the default. The Chinese edition lives in
<a href="./docs/README.zh-CN.md"><code>docs/README.zh-CN.md</code></a> and is authoritative when the two differ.</sub></p>

</div>

<p align="center"><sub>
<a href="#1-what-this-is">1. What this is</a> ·
<a href="#2-why-estrella-bot">2. Why Estrella Bot</a> ·
<a href="#3-install">3. Install</a> ·
<a href="#4-interfaces-plugins-and-skills">4. Interfaces, plugins and skills</a> ·
<a href="#5-how-it-works">5. How it works</a> ·
<a href="#6-known-limitations">6. Known limitations</a> ·
<a href="#7-roadmap">7. Roadmap</a> ·
<a href="#8-contributing">8. Contributing</a> ·
<a href="#9-contact">9. Contact</a> ·
<a href="#10-license-and-credits">10. License and credits</a>
</sub></p>

## 1. What this is

Estrella Bot is an **OneBot v11 bridge** that plugs a spare QQ account into any OpenAI-compatible model, plus a **zero-build browser console**. It is built to act like a group member, not a command bot: it follows the conversation, answers when addressed, sometimes joins in on its own, remembers people and running jokes, and goes quiet when that is the natural thing to do.

At a glance:

- **Group-native chat** — @-mentions, name aliases, probability-based interjections with cooldowns, sleep hours, message splitting and human-paced sending.
- **Bring your own brain** — a local model (MLX / QwenChat), DeepSeek, Zhipu GLM, Qwen, or any OpenAI-compatible endpoint.
- **A real control room** — start/stop the bot, switch models, edit the persona, manage memory and extensions, watch logs and usage, all from a local browser UI.
- **Small and self-contained** — a single-process bot, one runtime dependency (`ws`), no build step, no central service.

You supply three things: a **spare QQ account**, an **OneBot v11 implementation** (NapCatQQ in practice), and a **model** (a local endpoint or an API key). Source runs need Node.js ≥22.13; the Windows installer bundles its own runtime.

> **The name.** Estrella Bot is the software name. The project began as `qq-bot`, was renamed twice, and keeps the GitHub slug `ai-bot-groupmate` on purpose so existing links and search results still land here. The full history is in [`CHANGELOG.md`](./docs/release/CHANGELOG.md).

## 2. Why Estrella Bot

- **It behaves like a member, not a reply machine.** A dedicated decision layer decides whether a message deserves an answer at all — @-mention, alias, question shape, interjection chance with cooldown, sleep window, per-member speaking style. Replies are split and paced like human messages, and the bot never answers itself.
- **Model freedom without lock-in.** Four presets keep local and cloud brains separate; switching only materialises the chosen preset, so settings never bleed across providers. Any OpenAI-compatible endpoint can be added as a custom brain, with per-model capability switches and an automatic degradation chain when a provider fails.
- **Local-first and private.** The bot, console, memory and logs live on your machine. Local models never leave it; cloud calls go only to the provider you configure. There is no central account system or hosted service.
- **Everything is operable by click.** The console is a zero-build static frontend plus a local HTTP server. Start and stop the bot, scan the protocol-side QR code, edit persona and memory, inspect logs, usage and traces — no bundler, no rebuild after an edit.
- **Safety is the default, not a setting.** The allow-list fails closed (an empty list refuses to start), outbound text is built as message segments so CQ codes from the model cannot become instructions, self-replies are dropped, SSRF and browse paths are gated, and test sandboxes never touch a live bot.
- **Extensible without becoming a framework.** Plugins and skills share one host, one loader and one settings UI. Deterministic hooks and model-callable tools are two kinds of the same package, not two APIs.
- **Cross-platform, with the trade-offs stated.** Windows gets a native installer and needs no Docker; macOS uses a Docker container because NapCat's macOS QQ allowlist is stale. No hidden platform magic.
- **Small footprint, strong gates.** The runtime dependency is only `ws`, and the UI has no build step. Changes go through a four-layer gate plus mutation tests. Gate counts are not frozen in this README — `npm run verify` is the only authoritative source for the numbers.

## 3. Install

Every route ends at the same local console. Pick the one that matches your OS.

### What you need

| Piece | Notes |
|---|---|
| A spare QQ account | Use an alt account; third-party protocol implementations carry a risk of account restrictions |
| OneBot v11 implementation | NapCatQQ in practice. It is **not bundled** — its license does not allow redistribution |
| A model | A local OpenAI-compatible endpoint, or an API key for DeepSeek / Zhipu / Qwen |
| Node.js ≥22.13 | Source runs only. The Windows installer embeds its runtime |
| Docker Desktop | macOS / Linux container route only. The Windows installer needs no Docker |

### Windows — installer (recommended)

1. Download `Estrella-Bot-Setup-<version>.exe` from [Releases](../../releases/latest).
2. Run it. On the **protocol side** page, either let the installer download NapCat, or point it at an already-unzipped `NapCat.Shell` folder. NapCat is **not** bundled.
3. Launch **Estrella Bot** from the desktop or Start menu. The console opens, and the protocol side starts in the background.
4. In the console's protocol page, scan the QR code with the spare account.
5. Fill in the allowed group IDs and the model API key, then click **One-click start**.

Notes:

- **Quit your desktop QQ before scanning**, and keep the protocol-side process alive afterwards. NapCat works by injecting into QQ NT, which is single-instance; this is the most common "it worked yesterday" cause.
- No Docker, no WSL2 and no separate Node install are required.
- Prefer a manual or portable setup? Follow [USER-GUIDE §9](./docs/guides/USER-GUIDE.md#9-windows-users).

### macOS / Linux — Docker (recommended on macOS)

Docker exists on macOS to route around NapCat's stale QQ allowlist: the container bundles a matching Linux QQ, so **your own QQ client is never touched**.

```bash
git clone https://github.com/Canvixel-Eloweny/ai-bot-groupmate.git
cd ai-bot-groupmate
npm install
cp config.example.json config.json        # then set allow.groups
bash scripts/bootstrap.sh                 # start the container and print the WebUI login URL
node scripts/check-onebot.js              # verify the protocol side and list your groups
```

Start the console and click **One-click start** in the page; or run the console and the bot as two commands:

```bash
node panel/server.js    # console at http://127.0.0.1:8788
npm start               # bot only; the console can also start it
```

On macOS you can double-click **`Estrella-Bot.app`** instead: it starts the console, opens the page, then brings Docker and the container up in the background.

- Full container guide, including rollback: [`INSTALL-DOCKER.md`](./docs/guides/INSTALL-DOCKER.md).
- The native macOS route is **blocked** by NapCat's allowlist. Do not install QQ from a third-party mirror — the chat client holds every credential for that account.
- There is no macOS installer or DMG; macOS runs from the repository.

### Manual / development route (any OS)

On Windows, install Node.js, QQ NT and native NapCat, open the WebSocket server on `3001` and the HTTP server on `3000`, then:

```bat
npm install
copy config.example.json config.json
```

Start the console with `scripts\Estrella-Bot.bat`, or run `node panel/server.js` and `npm start` separately. Step-by-step instructions, including what to do when a step fails: [USER-GUIDE](./docs/guides/USER-GUIDE.md) · [用户使用说明](./docs/guides/USER-GUIDE.zh-CN.md).

### First run

1. Sign in to NapCat with the spare account.
2. Put the group IDs you allow into `allow.groups`. An empty list with `allowAllWhenEmpty:false` makes the process refuse to start.
3. Set the model endpoint and key in the console, or in `config.json` (`apiKeyEnv` is safer than pasting a key into the file).
4. Open the console. Desktop builds write the URL to `USER_ROOT/panel/.panel.json`; source runs default to `http://127.0.0.1:8788`.
5. Click **One-click start**, then @ the bot or call it by name in an allowed group.

### Verify the installation

If you run from source, `npm test` exercises the behaviour regression without needing QQ or a model, and `npm run verify` runs the full four-layer gate. The gate numbers in this README are not frozen; the output of `npm run verify` is the only authoritative count.

## 4. Interfaces, plugins and skills

There are four interfaces worth knowing — the protocol side, the model, the console API, and extensions.

| Interface | Between | What it is |
|---|---|---|
| OneBot v11 | QQ ↔ bot | WebSocket on `3001` and HTTP on `3000`; NapCat in practice |
| Model | bot ↔ LLM | Any OpenAI-compatible `/chat/completions` endpoint |
| Console API | browser ↔ panel | Local HTTP on `127.0.0.1`; every route is documented |
| Extensions | package ↔ host | Plugins and skills share one host and one loader |

### Console — the human interface

The console is served by `panel/server.js` on `127.0.0.1`. It is the control room: run overview, start/stop, protocol login, persona studio, memory, scheduled messages, extensions, logs, usage, traces and settings. The frontend is static assets under `panel/next/` with a data-driven control table (`schema.js`), so there is no build step. The server binds to an OS-assigned port in desktop builds and writes the actual URL to `USER_ROOT/panel/.panel.json`; development runs default to `127.0.0.1:8788`.

More: [`docs/FRONTEND-V2.md`](./docs/FRONTEND-V2.md) · [`docs/MOTION-METHODOLOGY.md`](./docs/MOTION-METHODOLOGY.md).

### Local HTTP API — the automation interface

Everything the console does is a local HTTP route: state, config, bridge start/stop, protocol login, model switching, memory, extensions, logs and diagnostics. Inputs, outputs, side effects and idempotency for every route are in [`docs/API_CONTRACT.md`](./docs/API_CONTRACT.md). The frontend polls `/api/state`; external tools can do the same, or call specific routes. The panel binds loopback only and checks Host and Origin, so it is not exposed to your LAN by default.

### Models — four presets, plus your own endpoint

The console organises model settings into four presets. Switching only **materialises** one preset into flat fields for the bridge; presets never bleed into each other, and per-brain edits survive switching away and back.

| Preset | Name | baseUrl | Traits |
|---|---|---|---|
| `local` | Local model | `http://127.0.0.1:<port>/v1` (MLX or QwenChat) | Offline, free, data never leaves the machine. The two local channels are mutually exclusive (same model memory) |
| `deepseek` | DeepSeek cloud | `https://api.deepseek.com/v1` | Cheap and good, text only |
| `zhipu` | Zhipu GLM | `https://open.bigmodel.cn/api/paas/v4` | The only preset with web search + vision; also the always-thinking family |
| `qwen` | Qwen (Alibaba) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Free grant per model (1M tokens, 90 days); the fallback chain is long on purpose. The grant runs out, and the platform's "stop when free quota is used up" switch is off by default — turn it on |

**Custom models — bring your own key.** Any OpenAI-compatible endpoint works: a company gateway, a self-hosted relay, LM Studio on another machine, or a provider we have not wired up. Give it a name, paste the API address and key, fill in the model name, then tick what it can actually do:

| Tick | What it changes |
|---|---|
| Vision | Pictures from the group get sent to it. Unticked, they become `[图片]`. |
| Thinking | A reasoning parameter is sent. If the server rejects it, the request is automatically resent without it. |
| Web search | The search tool is attached. ⚠️ This is Zhipu's shape; most other endpoints will not recognise it. |

Only the boxes you tick appear afterwards. You can keep as many custom models as you like, switch between them like any other brain, and **right-click** one to rename or delete it. The address must be the **API** address (the one serving `/chat/completions`), not the provider's console page.

Custom models are stored in `llm.customBrains`, one entry per brain, not in `llm.presets`. The single source of truth for model capabilities (thinking levels, web search, vision, degradation-chain eligibility) is `src/model-caps.js`; the entry point for vision is `supportsVision()`.

### Plugins and skills — the extension interface

`plugins/` and `skills/` share **one host, one loader, one manifest contract, one tool registry and one hook bus**. `kind` only decides the default semantics; it is not a second API and it is **not a sandbox**.

| | Plugin (`plugins/<id>/`) | Skill (`skills/<id>/`) |
|---|---|---|
| Best for | Deterministic capabilities: hooks, guards, fixed-time actions | Model-facing capabilities: tools plus optional prompt guidance |
| Entry | `setup` / `activate` / `hooks` (at least one) | Same, or `prompt.sections` for a prompt-only skill |
| Execution | Guaranteed when a hook fires | The model decides whether to call the tool |
| Prompt | Optional extension guidance | Optional `skillExt` section |
| Enable list | `custom.extensions.plugins.enabled` | `custom.extensions.skills.enabled` |
| Console page | Factory → Plugins | Factory → Skills |

A minimal prompt-only skill is two files:

```text
skills/group-etiquette/
  skill.json   # id / apiVersion / entry + prompt.sections[]
  index.js     # may be just: export {};
```

What both kinds share:

- One manifest contract (`plugin.json` / `skill.json`): `id`, `apiVersion`, `entry`, optional `permissions`.
- One tool registry and one tool cap; one hook bus with a per-hook timeout.
- One settings UI, with sensitive-key handling and range checks.
- One enable list per kind. A package sitting in the directory is **scanned and reported, but not loaded** until its id is in the allow-list.
- **No hot plug**: changing the allow-list requires restarting the bot.
- Failure is visible: load failures, missing hooks and unregistered tools are reported instead of silently ignored.
- Extension hooks are **fail-open** (a broken package should not silence the bot); the outbound credential gate is fail-closed.

Extensions are **not sandboxed** — they load in the bot process and can `import fs`. Install only packages you trust. The host limits them with a permission-trimmed API (`fetch` allow-list, read-only OneBot proxy), egress quota and manifest checks, but that is a boundary, not a jail. See [`docs/SKILLS.md`](./docs/SKILLS.md) and [`.github/SECURITY.md`](./.github/SECURITY.md).

**None ship by default.** The packages written for this project were removed; drop your own into `plugins/` or `skills/`, install a ZIP from the console, then enable it in the allow-list. Third-party packages you add are not committed (see `.gitignore`).

> Do not confuse the on-disk `skills/` packages with `custom.skills` in `config.json`: the former is executable code, the latter is prompt data.

## 5. How it works

### The shape of the system

```text
QQ alt ──► NapCat (OneBot v11) ──► src/index.js ──► model
             ws 3001 / http 3000     │ trigger → context → prompt → split
                                      ├─ local  : MLX / QwenChat
                                      ├─ cloud  : DeepSeek / Zhipu / Qwen
                                      └─ custom : any OpenAI-compatible endpoint
                 ┌────────────────────┴────────────────────┐
                 │ panel/server.js (127.0.0.1)              │
                 │  ├─ panel/next/ static UI, polls state   │
                 │  └─ start/stop, config, memory, extensions│
                 └──────────────────────────────────────────┘
```

### Message lifecycle

1. `src/onebot.js` flattens a OneBot event into text, image URLs and "was I mentioned".
2. `src/index.js` applies allow/deny lists, sleep and wake rules, and rate gates.
3. `src/brain.js` `decide()` answers one question with a pure function: **should this message get a reply at all?**
4. `src/context-budget.js` assembles the prompt: stable sections first, volatile context last, within a character budget.
5. `src/llm.js` calls the model with the degradation chain and explicit 400 handling.
6. `src/tool-loop.js` runs tool rounds when the model asks for a tool.
7. `src/brain.js` splits the reply and strips internal markers; `src/egress.js` runs the outbound gate.
8. `src/pace.js` sends at a human pace and re-checks the allow-list before each send.

### Configuration

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

Key options:

| Field | Meaning |
|---|---|
| `allow.groups` / `allow.private` | Allow-list. **If empty while `allowAllWhenEmpty:false`, the process refuses to start** |
| `allow.allowAllWhenEmpty` | `true` hands the account to the model — local debugging only |
| `deny.groups` / `deny.users` | Deny-list; takes precedence over the allow-list |
| `trigger.requireAtInGroup` | Whether the bot must be @-mentioned or called by name in groups |
| `trigger.aliases` | Names that count as being addressed (e.g. `["小鱼"]`) |
| `trigger.interjectChance` | Probability of chiming in when not addressed (0–1); default 0 |
| `trigger.interjectCooldownMs` | Cooldown between unmentioned interjections |
| `reply.splitToken` | Token the model uses to separate messages; default `\|\|` |
| `reply.sendDelayMs` | Delay between split messages, to avoid rate limits |
| `throttle.globalConcurrency` | **Set to 1 for local models** — concurrency doubles latency on Apple Silicon |
| `throttle.perMinutePerSession` | Per-session replies per minute |
| `llm.presets.<key>` | Per-brain settings; materialised on switch, do not edit the semantics by hand |
| `custom` | Workspace data (persona, enhancements, skills, memory, scheduled messages, play rules, security, other) |

### Persona and memory

Persona is plain natural language in `persona/qq-chat.md`. `buildMessages()` in `src/brain.js` assembles the prompt in this order:

```text
style rules → persona → enhancements → play rules → group background → context → current message
```

To make replies livelier, in order of value: write a concrete persona (catchphrases, message length, when *not* to reply) · add few-shot examples inside the persona file · lower `temperature` (≈0.8 is stable; above 1.2 it starts making things up) · use a bigger model.

The custom workspace is data-driven; its structure lives in `src/custom-config.js`. Partial updates go through `patchCustom()`, which merges instead of replacing, so editing one field cannot wipe the others. Persona changes invalidate stale session history via a fingerprint; memory is deliberately excluded, so adding a memory does not clear history.

### Repository layout

| Path | What lives there |
|---|---|
| `src/` | The bot: protocol IO, trigger decision, prompt assembly, model client, tools, memory, extensions |
| `panel/` | `server.js` (local HTTP API) + `next/` (zero-build frontend) + `lib/` (backend layers) |
| `plugins/` · `skills/` | Extension packages — none ship by default |
| `scripts/` | Bootstrap, OneBot probe, dry run, event sniffing, contract gates |
| `test/` | Behaviour regression, sandbox, panel boot/DOM checks, mutation tests, E2E scripts |
| `packaging/` | Windows NSIS installer, portable build, update manifests and signing |
| `docs/` | User guides, API contract, architecture, skills, legal notices |
| `persona/` | Persona text |
| `config.example.json` · `docker-compose.yml` | Sanitised config template and NapCat container |

Layering and dependency direction are explained in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

### Design decisions

- **CQ injection defence** — everything sent to the protocol side is a **message-segment array**, never a CQ code string. If the model emits `[CQ:at,qq=all]`, it stays ordinary text.
- **No self-replies** — events where `user_id === self_id` are dropped, otherwise the bot answers itself forever.
- **Allow-list fails closed** — an empty allow-list without an explicit opt-in refuses to start, rather than silently letting everything through.
- **Reconnect with exponential backoff** (1s→30s); in-flight requests are rejected on disconnect, never left hanging.
- **Rate limiting** — per-session minimum interval, per-minute cap, global concurrency semaphore.
- **Long-message splitting** prefers sentence boundaries so the protocol side does not truncate mid-sentence.
- **Degradation chain is validated on both ends** — cross-provider, duplicate and over-long entries, and always-thinking models are rejected with a stated reason.
- **Log ring buffer** — `state.logs` is capped, the backend keeps a `dropped` counter so `total` stays monotonic, and a lagging frontend cursor triggers a reset redraw.
- **Sandbox isolation** — `test/sandbox.sh` starts the panel with `QQBOT_SANDBOX=1`; in that mode the server never adopts or stops a real bridge process, so regression runs cannot kill your live bot.

## 6. Known limitations

- **No streaming** — the whole reply is generated before sending. Character-by-character output in a group chat looks less human, not more.
- **Voice and video become placeholder text.** Images are genuinely understood by vision-capable models; text-only models still receive a placeholder.
- **Cross-restart context relies on session archives**, and archives past a freshness threshold are refused — better to forget than to resume a topic that ended long ago.
- **The bot is single-process and single-account.** Multi-account is not implemented.
- **The console reads from disk on every request** (zero build). Editing `server.js` requires restarting the panel process (`POST /api/panel/restart` is idempotent).
- **Extensions can execute, but "on disk" and "in effect" are two different things** — packages are scanned and listed, but only ids in the allow-list are loaded, and there is no hot plug.

## 7. Roadmap

Everything below is **known-not-done**, taken from the limitations above. No time commitments — this is a one-person project and priorities follow real pain.

- [ ] **Multi-account support** — currently single process / single instance.
- [ ] **Understanding voice and video content** — today they become placeholder text.
- [ ] **Outbound rich media** — sending images. (Sticker output was removed: the bot only ever picked from QQ's built-in faces.)
- [ ] **Native macOS protocol side** — blocked by NapCat's QQ version allow-list.
- [ ] **Hot-reloading extensions** — changing the allow-list still requires restarting the bot.

## 8. Contributing

Start with [`.github/CONTRIBUTING.md`](./.github/CONTRIBUTING.md). Three things to know before writing code:

1. **The gates have four layers** — `check-wb` structural contracts, `smoke` behaviour regression, and the sandboxed `presets` and panel self-checks. Run the whole thing with `npm run verify`.
2. **Every fix needs a mutation test that only catches that one fix.** "The assertion exists" is not the same as "the assertion is wired up".
3. **Gate counts are deliberately not hard-coded in this document.** They rotted four times before anyone noticed; the real numbers live in exactly one place: the output of `npm run verify`.

Also read [`docs/release/CHANGELOG.md`](./docs/release/CHANGELOG.md), [`.github/SECURITY.md`](./.github/SECURITY.md) (including the known design boundaries), [`.github/CODE_OF_CONDUCT.md`](./.github/CODE_OF_CONDUCT.md), and [`docs/legal/THIRD-PARTY-NOTICES.md`](./docs/legal/THIRD-PARTY-NOTICES.md).

## 9. Contact

| Channel | Use |
|---|---|
| [Issues](../../issues) | **Preferred.** Questions, bugs, feature requests — public discussion is searchable by the next person; a DM is not |
| [`.github/SECURITY.md`](./.github/SECURITY.md) | Report vulnerabilities **privately**; do not open a public issue |

Two things to do first: **redact real QQ numbers / group ids / chat logs** before posting, and run `npm run verify` and paste the output — a minimal reproduction beats a long description.

## 10. License and credits

| Item | Value |
|---|---|
| License | **Apache-2.0** — full text in [`LICENSE`](./LICENSE), attribution notice in [`NOTICE`](./docs/legal/NOTICE) |
| Third-party notices | [`THIRD-PARTY-NOTICES.md`](./docs/legal/THIRD-PARTY-NOTICES.md) |
| Runtime dependencies | Only `ws` (MIT). Zero build, no other third-party runtime dependency |

**Apache-2.0 in three sentences.** ① Use it freely: read, run, modify, ship it — even closed-source, no permission needed. ② Keep `LICENSE` and `NOTICE` with it and mark the files you changed. ③ It grants an explicit patent license and reserves trademark rights; it does **not** require you to publish your changes (there is no network clause).

**NapCat is not part of this repository.** Running it requires an OneBot v11 implementation (in practice NapCatQQ), whose custom *Limited Redistribution License* is not an OSI-approved open-source license and explicitly restricts building other projects from its code. This project therefore only calls it through official channels, shares no code with it, and distributes none of its code or binaries. Obtain it yourself and follow its license.

`plugins/` and `skills/` ship **no extensions by default**: the packages written for this project were removed. The host still loads any package you drop into either directory, subject to the allow-list in `custom.extensions.plugins.enabled` / `custom.extensions.skills.enabled` (the legacy `custom.plugins.enabled` is derived for old configs). There is **no hot-plug**: changing the allow-list needs a restart (the console says so). See [`docs/SKILLS.md`](./docs/SKILLS.md) for the two kinds. Also not distributed: `napcat/` (the protocol side) and the data directories extensions write at runtime — see [`docs/legal/THIRD-PARTY-NOTICES.md`](./docs/legal/THIRD-PARTY-NOTICES.md) §3.

---

<div align="center">
  <sub><b>English</b> · <a href="./docs/README.zh-CN.md">简体中文</a></sub>
</div>
