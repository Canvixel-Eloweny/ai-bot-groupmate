# User Guide

> **This guide is for people who just want it working.** Start to finish, follow along and you're done.
> For how the project is designed, how the code is layered, and what the gates are, read
> [`README.md`](./README.md) instead.
>
> The Chinese edition lives in [`USER-GUIDE.zh-CN.md`](./USER-GUIDE.zh-CN.md)
> and is the authoritative one when the two differ.

---

## 0. First things first: does your machine work?

| Your system | Supported | Notes |
|---|---|---|
| **macOS (Apple silicon / M-series)** | **Yes** | Sections 1–8 are all you need. The protocol side runs in Docker |
| **Windows 10 / 11** | **Yes** | Uses **native NapCat** (**no Docker**); the experience is the same as macOS. See **[section 9](#9-windows-users)** |
| Linux | Untested | Should work in principle (the protocol side already runs inside a Linux container), but nobody has actually tried it |

The two routes differ **only in the protocol side**. The bridge and the console are **the same code
and the same ports**:

```
                          macOS                        Windows
QQ alt ──►  NapCat (Docker container · Linux QQ)   NapCat (native Windows)
                              │                            │
              ws/http 3001/3000 (identical on both) ◄──────┘
                              │
                     bridge src/index.js  ──►  console :8788
```

> **Why macOS needs Docker and Windows doesn't**: on macOS, Docker exists to **route around**
> NapCat's stale macOS version allowlist (README section 2, "Route B blocked"). Windows doesn't
> need to route around anything — NapCat ships a current native Windows build.

### How to read this guide (which section belongs to which platform)

| Sections | What's in them | Platform |
|---|---|---|
| §1 Prerequisites · §2 Get the project | Requirements, download | **Both** |
| **§3 Connect your QQ** | Start the container → scan → open two channels | **macOS** (Windows equivalent is in §9) |
| §4 Configuration checklist | Group IDs / model / persona — **identical on both** | **Both** |
| §5 Start · §6 Did it work · §7 Day-to-day | Where to click, what to watch | **Both** |
| §8 Troubleshooting · §10 Security · §11 Uninstall | — | **Both** |
| **§9** | Install NapCat (native) → one-click start → the **nine platform differences** | **Windows** |
| [`INSTALL-DOCKER.md`](./INSTALL-DOCKER.md) | The **detailed macOS install manual**: installing Docker Desktop, mirror fallback, daily ops, rollback | **macOS** |

> ⚠️ The command examples in §1–§8 are **written for macOS** (`bash scripts/…`, `chmod`,
> `docker logs`). Windows users should jump straight to **[section 9](#9-windows-users)** — it spells
> out what to use instead.

---

## 1. What you need

| # | Item | Notes | Where to get it |
|---|---|---|---|
| 1 | A macOS machine | **Apple silicon** (M1 or later). Intel Macs are untested | — |
| 2 | **Node.js 22.13 or newer** | Both the bot and the console run on it | <https://nodejs.org> — get the LTS build |
| 3 | **Docker Desktop** | Choose the **Apple Chip** build. QQ and the protocol side run inside it | <https://www.docker.com/products/docker-desktop/> |
| 4 | **A spare QQ account** | ⚠️ **Do not use your main account.** Third-party protocol clients carry a ban risk | Register a new one |
| 5 | A model source — **a cloud key or a local model**, either one | Cloud: a key from any provider. Local: add an **OpenAI-compatible endpoint through "Custom model"** (Ollama / LM Studio / a vLLM box on your LAN all work — see section 4). ⚠️ The built-in entry named "local model" is **macOS-only** (it automates *our* MLX / QwenChat setup) — **nobody else's machine needs it** | See section 4 |
| 6 | Disk space | macOS: roughly 3–4 GB (container image 1.5 GB + Linux QQ 200 MB + optional local model). **Windows: roughly 1–2 GB** (QQ + NapCat, no container image) | — |

Once the first two are installed, verify:

```bash
node --version     # should print v22.13.0 or higher
docker ps          # an empty table with just headers means Docker is running
```

> **`docker ps` says `Cannot connect to the Docker daemon`**: Docker isn't up yet.
> Open Applications → Docker and wait until the whale icon in the menu bar stops animating
> (1–2 minutes), then try again.

---

## 2. Get the project (about 3 minutes)

```bash
git clone https://github.com/Canvixel-Eloweny/ai-bot-groupmate.git QQ-BOT-Creative
cd QQ-BOT-Creative
npm install
```

> **No `git`?** On the GitHub page click **Code → Download ZIP**, unzip it, **rename the folder to
> `QQ-BOT-Creative`**, `cd` into it, and continue from `npm install`.

---

## 3. Connect your QQ account (about 10 minutes)

> ⚠️ **This section is the macOS route** (the protocol side runs inside a Docker container).
> **Windows users: see [section 9](#9-windows-users)** — that route uses native NapCat and no Docker.
> A more detailed macOS manual (installing Docker Desktop, mirror fallback, daily ops, rollback)
> lives in [`INSTALL-DOCKER.md`](./INSTALL-DOCKER.md).

### 3.1 Start the protocol container

```bash
bash scripts/bootstrap.sh
```

The script checks Docker → checks that ports 3000/3001/6099 are free → prepares the image
(the first run takes a few minutes, don't interrupt it) → starts the container → **prints a URL
with a token in it**.

Open that URL in your browser:

```
http://127.0.0.1:6099/webui?token=xxxxxxxx
```

> ⚠️ That token **is the way into your bot account**. Don't post it in a group, don't screenshot it,
> don't paste it into an issue.

### 3.2 Sign in, then open two channels

1. **Scan the QR code with the QQ app on your phone** to sign in with your spare account.
2. In the left menu, go to **Network Config** → create a **WebSocket Server**
   - Port: `3001`
   - Token: leave empty (the bridge sends no token by default)
   - Save and enable
3. On the same page → create an **HTTP Server**
   - Port: `3000`
   - Save and enable

> Those two ports must be **3000 / 3001** — that's what the bot connects to by default.
> Using different ports means editing `config.json` and `docker-compose.yml`. Not worth it for a first run.

### 3.3 Verify the channel and grab your group IDs

```bash
node scripts/check-onebot.js
```

Output like this means you're good:

```
✓ connected to the protocol side
  account: 小鱼 (123456789)
  joined 3 groups:
    100000001   some group
✓ channel OK.
```

**Those group numbers are exactly what section 4 asks for.** Write them down.

---

## 4. Configuration checklist (just fill it in)

Almost everything is clickable in the **console UI** — no hand-editing needed.
But two things must be done manually, once:

### ① Create the config file

```bash
cp config.example.json config.json
```

> **Why this is required**: `config.json` will hold your API key, so it is **not tracked by git** —
> a fresh clone simply doesn't have it.

### ② Create `.env` (so restarting the container doesn't force a new QR scan)

```bash
printf 'ACCOUNT=<your bot QQ number>\n' > .env
chmod 600 .env
```

> Optional — without it, every container rebuild needs a fresh QR scan.
> Put the **bot account's** QQ number, no spaces.

### The full checklist

| What | Where | What to enter | If you skip it |
|---|---|---|---|
| **Allowed group IDs** | Console → **Speaking & timing** → "Allowed group IDs" (or click "Load group list") | The IDs from step 3.3, comma-separated | ⚠️ **With none set, the bot refuses to start** |
| **Model source** | Console → **Brain** → "API Key" (cloud) or "**Custom model**" (local / self-hosted) | Cloud: a DeepSeek / Zhipu / Qwen key. Local: an OpenAI-compatible URL such as `http://127.0.0.1:11434/v1` | No model to use ⇒ the bot won't come up. ⚠️ **This is not "a key is required"** — local models come in through "Custom model" and work just as well |
| **Bot QQ number** | `ACCOUNT=` in the project root `.env` | Your spare account | New QR scan on every container rebuild |
| Bot nickname | Console → **Persona** → "Bot nickname" | Whatever you want to call it | Defaults to "小鱼" |
| Trigger words (being called by name counts) | Console → **Speaking & timing** → trigger words | Nickname, aliases | In groups it only answers when **@-mentioned** |
| Personality | `persona/qq-chat.md`, or the **Persona / Custom** tabs | A plain-language self-description | Ships with a default persona |
| Schedule / timers / proactive messages | Console → **Mood & world** / **Speaking & timing** | Toggle as needed | Proactive messages are off by default |

### Two traps you must know about

**Trap 1 — a key you typed in the console may not take effect.**
A key entered in the console is written into `config.json`. But if `config.json` still has
`llm.apiKeyEnv` set (the template ships `QQBOT_API_KEY`) **and that environment variable actually
has a value**, the **environment variable wins** and the key you typed is ignored. You'll get a
warning line in the log, but nothing visible in the UI.

> Easiest fix: **don't `export QQBOT_API_KEY`.** Just enter the key in the console.

**Trap 2 — an empty allowlist refuses to start.**
When `allow.groups` is empty and `allowAllWhenEmpty` is `false` (the default), the bot
**refuses to start**. That's a deliberate guard: better to fail loudly than to quietly answer
in every group you're in. Only set `allowAllWhenEmpty: true` while debugging locally — it hands
the account to the model.

**Trap 3 — the template's group ID is a *placeholder*, not an empty value (copying it as-is gives you the worst outcome).**
`config.example.json` ships this:

```jsonc
"groups": ["填你的群号，例如 123456789"]
```

That line must be **deleted entirely and replaced with your own group ID** — don't append to it.
The allowlist only trims whitespace; it doesn't validate that entries are numbers, so that
placeholder string is **accepted as if it were a real group ID**:

| What you end up with | Result |
|---|---|
| `groups: []` (genuinely empty) | ✅ **Refuses to start** with "allowlist is empty" — you find out immediately |
| `groups: ["填你的群号，例如 123456789"]` | ❌ **Starts fine**, but that ID never matches ⇒ **it silently never answers in any group while the process looks perfectly healthy** |
| `groups: [123456789]` (your real ID) | ✅ Works |

> That middle row is the exact failure shape this project treats as its worst: **it doesn't error**.
> So when the bot seems dead in a group, first go look at "Allowed group IDs" and check whether
> what's in there is actually numbers.

---

## 5. Start it

### Option A: double-click the icon (recommended)

Double-click **`QQ-BOT-CONTROL.app`** inside the project folder.

It starts the console → **immediately** opens the page in your browser → then heads off to bring up
Docker and the container in the background (the slow parts don't block the page).

> **The bot does not start talking on its own.** Opening the console is not the same as letting the
> bot speak. Click **"One-click start"** in the top-right of the page (or "Start bot" on the Run tab).

### Option B: command line

```bash
npm start          # bot only (the container must already be running)
```

> The UI, brain switching, and persona editing all live in the console. The command line just runs
> the bot. To open the console: `node panel/server.js`, then browse to <http://127.0.0.1:8788/>.

---

## 6. Did it work?

Mention it in a group — **@ it**, or **call it by name** (defaults to "小鱼").

If nothing happens, check in this order (details in section 8):

```bash
node scripts/check-onebot.js    # 1. is the protocol channel up?
bash scripts/status.sh          # 2. container / ports / bot process, all on one screen (**macOS only**; on Windows use the console's Run tab)
```

---

## 7. Day-to-day use

The console page is the whole control surface. The left side has eight areas:

| Area | What's in it |
|---|---|
| **Run** | Status overview (bot / container / account / memory), startup chain, process start-stop, sessions, archives, logs, conversation stream, "Try a line" |
| **Brain** | Pick a model (local / DeepSeek / Zhipu / Qwen / your own), enter the API key, thinking mode, web-search and vision toggles, usage and spend, context budget |
| **Persona** | Its name, age, speaking style, and other structured fields |
| **Memory & knowledge** | Auto memory, manual memory, skills, group-member impressions |
| **Mood & world** | Mood/energy, quiet hours, holidays |
| **Speaking & timing** | Group allowlist, trigger words, interjection chance and cooldown, scheduled messages |
| **Plugins** | Install / remove extensions, enable allowlist (⚠️ requires a bot **restart**, no hot-plugging) |
| **System** | Import/export config, backups, change QR code, restart the console, etc. |

The top bar has global status pills (bot / container / local model / memory) plus
**"One-click start"** and **"End this run"**.

**After changing settings**: a "Save & apply / Discard" bar appears at the bottom.
Nothing takes effect until you click **Save & apply**.

### Common tasks

| I want to… | How |
|---|---|
| Switch models | **Brain** → click a preset, fill in the key, save & apply |
| Make it more talkative | **Speaking & timing** → raise "interjection chance", lower the cooldown |
| Change its personality | Edit `persona/qq-chat.md`, or fill the structured fields on the **Persona** tab |
| See what it costs | **Brain** → "Usage & spend" |
| Preview a reply | **Run** → "Try a line" (nothing is sent to the group) |
| Add my own endpoint | **Brain** → add a custom model: base URL + your key + model name |

### Watching logs

```bash
docker logs --tail 50 napcat     # protocol side (the QQ half)
tail -f panel/bridge.log         # bot side (the model half)
```

---

## 8. When something breaks

| Symptom | Fix |
|---|---|
| `docker: command not found` | Docker Desktop isn't installed properly, or you didn't reopen the terminal after installing |
| `Cannot connect to the Docker daemon` | Docker isn't running: open Applications → Docker and wait for the whale icon to settle |
| `failed to resolve reference ... registry-1.docker.io` | Docker Hub is unreachable. `bootstrap.sh` has built-in fallback mirrors — just run it again |
| Ports 3000/3001/6099 already in use | `lsof -nP -iTCP:3001 -sTCP:LISTEN` to find the process, or change the port mapping in `docker-compose.yml` |
| Container keeps restarting | `docker logs --tail 50 napcat` for the reason. Usually bind-mount permissions — re-run `bootstrap.sh` |
| WebUI won't open | Use <http://127.0.0.1:6099/webui> — **local only**, don't use a LAN IP |
| Disconnects right after scanning | The spare account got flagged. Try another account, or another network (not a corporate/campus one) |
| **Every container rebuild needs a new QR scan** | Most likely `ACCOUNT` is missing from `.env`. Set it per section 4, then `docker compose up -d --force-recreate` |
| **Mentioned in a group, no reply** | 1. `node scripts/check-onebot.js` to confirm the channel; 2. confirm the group is in the allowlist; 3. `docker logs napcat` to see whether events arrive; 4. `tail -f panel/bridge.log` for bot-side errors |
| **The bot won't start at all** | Almost always an empty allowlist (trap 2), or a wrong `llm.baseUrl` in `config.json` |
| "Stop bot" in the console does nothing | Check "instance count" on the Run tab; on macOS you can also run `bash scripts/status.sh` for real processes (that script doesn't exist on Windows — the panel is authoritative there). If it still won't die, restart the console |
| Replies are slow | A local model is slow, and that's normal (models under 8B). Switch to a cloud model for speed |
| It doesn't feel "human enough" | In order of return on effort: write a more specific persona → paste real dialogue samples into the persona file → lower the temperature → use a bigger model |

> Before filing a bug, run `npm run verify` and paste the output — far more useful than a long
> description. Questions go to GitHub Issues (public answers are searchable by the next person
> who hits the same thing).

---

## 9. Windows users

> 🌐 这一节对应的中文版：**[切换到中文说明书](./USER-GUIDE.zh-CN.md#9-windows-用户)**（`USER-GUIDE.zh-CN.md` 第 9 节）

**It works now.** Windows takes a different **protocol-side** route, but from where you sit there is
no difference: double-click the icon → the console opens in your browser → enter your key and group
IDs → click **"One-click start"** → mention it in a group and it answers.

### Why Windows doesn't need Docker

On macOS, Docker exists to **route around** NapCat's stale macOS version allowlist (it stopped half
a year ago, and none of the QQ builds on your machine match — see README section 2, "Route B
blocked"). Windows has nothing to route around: **NapCat ships a current, native Windows build.**

So the Windows route is shorter — **no Docker, no WSL2, no Linux subsystem.**

| Piece | macOS | Windows |
|---|---|---|
| QQ protocol side | NapCat + Linux QQ, inside a Docker container | **NapCat for Windows, installed natively** |
| Double-click launcher | `QQ-BOT-CONTROL.app` | `QQ-BOT-CONTROL.bat` |
| Bridge + console | Same code · same ports (3001 / 3000 / 8788) | Same code · same ports |
| Config, brain switching, status | The console page | **Identical** |

### Installing (Windows)

1. **Node.js 22 or newer** — get the LTS build from <https://nodejs.org>, then **reopen your terminal**.
2. **QQ (NT edition)** — download and install from <https://im.qq.com>.
3. **NapCat** — grab the latest `NapCat.Shell.zip` from
   <https://github.com/NapNeko/NapCatQQ/releases>, unzip it anywhere (e.g. `D:\NapCat`), and
   double-click the launcher inside.
   > ⚠️ The launcher's filename has changed between versions (`launcher.bat` / `launcher-user.bat` /
   > `launcher-win10.bat`). **Follow the official Releases page.** We deliberately don't hard-code
   > it — a hard-coded name just rots.
   > 💡 **Don't want to install QQ separately?** NapCat also ships two bundles that **include QQ**:
   > `NapCat.Shell.Windows.Node.zip` (it bundles Node.js too) and `NapCat.Shell.Windows.OneKey.zip`.
   > They're bigger, but they remove step 2 above.
   > ⚠️ The standard launcher **reads the registry to locate your QQ install**, so it sometimes needs
   > to run **as administrator**. If it says it can't find QQ, try that first.
4. **Scan the QR code to sign in with your spare account**, then open two channels in NapCat's
   WebUI — **word for word the same** as section 3.2:
   - **WebSocket Server**, port `3001`
   - **HTTP Server**, port `3000`
5. Back in the project directory, do the two prep steps (same as section 4):
   ```bat
   npm install
   copy config.example.json config.json
   ```
6. **Double-click `QQ-BOT-CONTROL.bat`** → the console opens in your browser → enter your API key
   and your **allowed group IDs** → click **"One-click start"** in the top-right.

> ⚠️ **Order matters: start NapCat and sign in first, *then* click "One-click start".**
> On Windows that button prints "skipping the container step" (there is no Docker on this route)
> and then does just two things: **check the protocol side is reachable** and **start the bot**.
> So if it reports "protocol side not responding", it means **NapCat isn't up or isn't signed in** —
> the bot isn't broken.
>
> 📌 Windows does **not** need a `.env` file (that one exists on the Docker route to avoid
> re-scanning; here NapCat remembers its own login). From section 4, only two things apply to
> Windows: **entering your API key** and **filling in the allowed group IDs**.

> Those ports aren't a coincidence: the bridge connects to `3001`/`3000` by default, and that is
> **the same on both platforms**.

### Nine ways Windows **differs** from macOS (read this first, so you don't think it's broken)

| What you'll see | Why | Is it a bug? |
|---|---|---|
| **Quit the desktop QQ before scanning** (added in round 54) | NapCat works by **injecting into** the QQ NT client process, and QQ NT is **single-instance** per machine: a desktop QQ that's already signed in owns that instance, so the injected instance can't open a login window. The symptom is "I double-clicked `3-START-NAPCAT.bat` and no QR code ever appears". Quit the desktop QQ completely (including the **tray icon**) first | Not a bug — that's how NapCat works |
| **After scanning, the window/process running NapCat must stay alive** (added in round 54) | From the moment you scan, that QQ process on this machine belongs to the spare account. **Signing the desktop QQ (your main account) back in kicks the spare off** ⇒ NapCat drops, the console shows "not signed in"; closing that window or pressing `Ctrl+C` kills it too. For everyday use run `2-START.bat` (it pushes the protocol side into the background); keep `3-START-NAPCAT.bat` for the first scan and for troubleshooting | Not a bug, but it's the most common cause of "it worked yesterday and now it doesn't" |
| **The built-in "local model" entry doesn't apply on Windows** | It exists to automate **our own** stack (MLX / QwenChat, including launching the model process) and is macOS-only — nobody else's machine needs it. **To run a local model, use "Custom model"**: just give it an OpenAI-compatible URL (Ollama / LM Studio / a vLLM box on your LAN). `127.0.0.1`, `localhost`, `192.168.x` and `10.x` are all recognised as local ⇒ **billed as free** | Not a bug — a division of labour |
| **The memory / resources card is empty** | That section reads macOS's `vm_stat` / `sysctl`; Windows has no equivalent. It **stays honestly blank rather than inventing a number** | No, by design |
| "End this run" doesn't shut Docker down | There is no Docker in the Windows route | No |
| A bot started with `npm start` shows as 0 instances in the console | Windows can't read another process's working directory, so the console only recognises launches whose command line carries this repo's **absolute path**. **Anything started from the console's "One-click start" is always recognised** | Known limitation |
| Double-clicking the `.bat` flashes a black window | That's the launcher itself; it disappears in a few seconds (the macOS `.app` has no such window) | Not a bug, just a different shape |

> ⚠️ **Multi-instance protection is unaffected**: it's backed by a lock file the bot writes itself
> (keyed on pid), independent of whether the console can see it.

### This build **has not been run on real hardware yet** — you're the first

Every platform branch ships with assertions and mutation tests (`check-wb` §96 plus the behaviour
layer `T-WIN1…6`), but **real-machine verification hasn't happened**. So if something doesn't work
on your first run, **don't assume it's you** — check it against this table first:

| Where it sticks | Run this |
|---|---|
| **Double-clicking `3-START-NAPCAT.bat` never shows a QR code** | 1. **Quit the desktop QQ completely first** (single instance — see the table above). 2. If the window shows `Error: spawn EINVAL`, that's a build from before round 54 (fixed — grab the new package). 3. Run `runtime\node\node.exe tools\check-env.mjs` and read the "QQ 协议端" / "QQ 客户端" lines |
| **"One-click start" reports success but the bot never replies in a group** | From round 54 there is **no more "false success"**: if the bot exits right after starting, the console surfaces the reason directly and points at `app\panel\bridge.log`. On an older build, check "instances" on the Run page and read `app\panel\bridge.log` |
| **After signing in it flips back to "not signed in"** | Most likely you (or the desktop QQ) signed the main account back in — a single QQ NT instance means the main account kicks the spare one off. See the second row of the table above |
| The `.bat` window flashes and vanishes | Open a terminal in the project directory and run `node scripts\win-launcher.mjs` by hand to see what it prints |
| The console page won't open | Run `node panel\server.js` in the foreground to see the error, or read `panel\panel.log` |
| The page opens but "One-click start" fails | `node scripts\check-onebot.js` — it tells you whether NapCat's 3001 is reachable |
| Mentioned in a group, no reply | 1. Look at "Allowed group IDs" and check whether the entries are **actually numbers** — the template's placeholder (`填你的群号…`) is accepted as a real ID, so the bot starts fine and then never recognises that group (section 4, trap 3). 2. Does `check-onebot.js` list the right IDs? |

Post the output of those to GitHub Issues — what this build needs most is exactly your first run.

## 10. Security notes (please read)

- ⚠️ **Use a spare account.** Third-party protocol clients carry a ban risk — don't gamble your main.
- ⚠️ **The WebUI token is the way into your account** (`http://127.0.0.1:6099/webui?token=...`).
  Don't post it in a group, don't screenshot it, don't paste it into an issue.
- ⚠️ **Never commit, screenshot, or sync `config.json` or `.env`.** The first holds your API key,
  the second your bot's QQ number. Both are already in `.gitignore`.
- ✅ The console **listens on localhost only** (127.0.0.1:8788), and the container ports are
  **bound to the loopback interface**. Nobody else on your network can reach them.
  **Don't change that to `0.0.0.0`.**
- ✅ **Start with a narrow allowlist.** Put it in one test group first; once you're happy with how it
  talks, add more.
- ✅ Outgoing messages use **message segments** rather than raw CQ-code strings, so even if the model
  emits `[CQ:at,qq=all]` it stays plain text and is never parsed as a real command. That's a
  built-in guard — but **still don't open the allowlist to groups you don't know**.
- ✅ Chat history, memory, and session archives stay on your machine (`panel/`, `data/`) and are
  never uploaded anywhere. Your chosen model provider does see the conversation content you send
  it — that's the inherent cost of using a cloud model.

---

## 11. Uninstall / start over

### Update to the latest version

```bash
cd ~/QQ-BOT-Creative     # wherever you cloned it
git pull
npm install              # only does anything if the dependencies changed
```

Then **restart the console**: double-click `QQ-BOT-CONTROL.app` again (`.bat` on Windows). It
notices that the code on disk is newer than the running process and swaps the panel over for you.
Manually: Console → **System** → "Restart panel".

> ⚠️ **The bot is a separate process**: code changes only take effect after you **restart the bot**.
> On the Run tab, click "Stop bot" then "Start bot".
> ⚠️ The plugin allowlist (`custom.plugins.enabled`) also **requires a bot restart** — there is no
> hot-plugging.

### Stop and remove the container

```bash
docker compose down
```

### Full reset (wipes the login state too)

```bash
docker compose down
rm -rf napcat/          # as if it had never signed in; you'll re-scan next time
```

### Remove Docker Desktop as well

Quit Docker → drag Applications/Docker to the Trash →
(optional) `rm -rf ~/Library/Containers/com.docker.docker ~/.docker`.

> **Your own QQ client was never touched, so there's nothing to restore.**

### Reset only the bot's config (keeps the QQ login)

```bash
rm config.json && cp config.example.json config.json    # config back to factory
rm -rf data/ panel/*.jsonl panel/session-archive.json   # clear memory and archives
```

---

## 12. Still stuck?

| Looking for | Go to |
|---|---|
| How the project is designed, known limits | [`README.md`](./README.md) |
| The full container-route install manual (with rollback) | [`INSTALL-DOCKER.md`](./INSTALL-DOCKER.md) |
| Contributing / changing code | [`CONTRIBUTING.md`](./CONTRIBUTING.md) |
| What changed in each release | [`CHANGELOG.md`](./CHANGELOG.md) |
| License and credits | [`LICENSE`](./LICENSE) · [`NOTICE`](./NOTICE) |
| Questions / bugs | GitHub Issues — for bugs, please include the output of `npm run verify` |
