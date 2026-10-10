# 变更日志

本项目在 `main` 上持续迭代，每个对外可见的版本打一个 tag。以下按**批次**记录对外可见的变化。
内部批次台账（含未交付项与裁决记录）是**内部件，不随公开仓库发布**。

## Unreleased — 2026-10-09

### 2026-10-09 · Windows: the first run that could never have worked

The portable Windows package had never been run on a real machine. It was reported against a
build dated the same day and, in that build, **no machine could have started it at all** — not a
configuration problem, three independent defects stacked so that each one hid the next.

- **`spawn EINVAL` on the very first step.** The portable package ships its own Node (v22.x) and
  hands the NapCat batch launcher to `spawn` directly. Since the fix for CVE-2024-27980
  (18.20.2 / 20.12.2 / 21.7.3 onward) Node **refuses** to spawn a `.bat` without a shell —
  `errno -4071`. Bundling the runtime is what guaranteed it fired on every machine. The launcher
  is now invoked as an explicit `cmd.exe /d /s /c <launcher>` argv — deliberately *not*
  `shell: true`, which concatenates the command and truncates a package path at its first space
  (the report's own machine hit `'D:\…\AI_Boot' is not recognized`, and "unzip to a path without
  spaces" is advice we give, not something we can enforce).
- **The bot could die silently while the console reported success.** `startBridge()` could only
  see *whether the process was created*, never *whether it survived*. An empty allowlist makes
  `config.js` fail closed on startup — on purpose — and that carefully worded Chinese error went
  only to `bridge.log`, so the console showed "started, pid 1234" while the user waited for a
  reply that was never coming. The console now confirms survival after startup and hands the
  reason straight back to the UI. It does **not** pre-validate by calling `loadConfig()` in the
  panel: `src/config.js` is a heavy module and the panel layer may only import zero-dependency
  leaves, and a pre-check would have covered exactly one way to die where reading the log covers
  all of them — without restating a single business rule. `/api/onekey/start` no longer answers
  `ok: true` when the protocol side or the bot did not come up.
- **Custom brains skipped a check that was already written.** `modelProviderMismatch()` exists
  and `/api/config` uses it; the custom-brain route didn't, so
  `baseUrl=https://platform.deepseek.com/usage` + `model=DS` was stored verbatim and activated.
  Same gate now, restricted to the three cloud providers: for `local` the function demands an MLX
  model directory, which would have rejected the very route the Windows docs point at.
  `consoleHostReject()` also recognises console **paths** (`/usage`, `/dashboard`, `/login` …) on
  a known provider's domain — a per-vendor table of console hostnames rots, the paths don't.
- **Two helper defects behind the same symptom.** The launcher candidate regex matched four
  files in the official package and `find()` returned whichever `readdir` produced first; the
  non-`-user` variants check for admin rights and relaunch themselves elevated before exiting, so
  the original window flashes away and the QR code appears elsewhere — fixed by preferring
  `*-user.bat` and sorting. And `check-env.mjs` looked for QQ only in four fixed `Program Files`
  paths while the launcher reads the `Uninstall\QQ` registry key: with QQ installed off the C:
  drive, the self-check said "QQ NT not found" while the launcher found it and worked. Both now
  share one `findQQExe()`.
- **Two platform facts the docs omitted, now written down:** quit the desktop QQ before scanning
  (QQ NT is single-instance and NapCat works by injection), and keep the process that runs NapCat
  alive afterwards (signing the main account back in kicks the spare off).
- Also improved: the "empty allowlist" error now names the console field a user can actually
  find, since the panel surfaces that same text; and `/api/bridge/start` returns the reason in
  `error`, because the page reads `data.error` on non-2xx and would otherwise show `HTTP 400`.

### 2026-10-09 · Windows: the five things the first real runs turned up

The Windows route shipped in 0.1.1 and had never been run on a real machine. The first runs
turned up five defects — and four of them were **the same defect wearing different hats**:
the console still assumed *"macOS + a Docker container"*, while the Windows route runs a
native NapCat and has no container at all.

- **A console window flashed every few seconds.** The panel is started detached and hidden —
  it has no console of its own — so every `powershell` / `docker` / `taskkill` it spawned got
  a brand-new console window that closed the moment the command finished. `sh()` is the single
  exit for external commands, and it was missing `windowsHide`. Fixed there and at every other
  spawn site. §97 pins it, and it deliberately does **not** fire on injected callbacks merely
  *named* `exec` — a naive grep for `exec(` matched 127 of those instead.
- **"Connected" never showed, and every memory reading was 0.** The port probes were gated on
  "is the container running" — a container is an implementation detail of the macOS route —
  and the ports themselves were hard-coded to 3000 / 3001. Both are gone: the endpoint now
  comes from `onebot.wsUrl`, the same address the bot dials. Memory readings on Windows come
  from one PowerShell call, and when they cannot be read the console says **"not supported"**
  instead of printing `0`: a `0 MB` that means "not measured" is a lie, and this project treats
  failure-disguised-as-success as its most expensive class of defect.
- **"Instances: 0".** The bot was started with a *relative* entry point while the Windows
  identity check only accepts an **absolute** one — so the console could not recognise the bot
  it had just started, and said nothing. Fixed; §96⑦ pins the absolute entry.
- **Messages arrived one character at a time.** The sanitiser's credential rule (`…|token|…$`)
  matched `reply.splitToken` and blanked it in `config.example.json`. An empty split token
  makes `split(new RegExp('|\\n+'))` match *between every character*, so a reply went out as a
  string of single characters — and every fresh install read that template. Four layers now:
  an explicit exception list in the sanitiser, a regenerated template, a `normalizeSplitToken`
  fallback (a `??` default never protected against the empty string), and a guard inside
  `parseReply`. §98 pins all four.
- **Faces were not the faces anyone expected.** 11 of the 15 entries in `FACE_PRESETS` had the
  wrong name for their id (the one labelled "doge"/狗头 is really `/OK`), and ids are passed
  through unvalidated — so the bot kept posting perfectly valid QQ faces, just not the ones the
  console claimed. Corrected against NapCat's own `face_config.json`; §99 pins the shape and
  requires the verification recipe to stay in the comments (`napcat/` is not tracked, so there
  is no second source of truth to check against).

Also: the Windows "local model" card no longer renders buttons whose only possible outcome is
failure. That stack is Apple Silicon only (MLX + QwenChat); on Windows it now says so and
points at **custom brains** with an OpenAI-compatible endpoint — the route that actually works
on both platforms.

### 2026-10-09 · The repository's own front door: what a search engine sees

The project could not be found, and the cause was not quality — both READMEs were already long
and precise. It was that the repository's **own indexable fields carried nothing a visitor would
type**, and that the top of the page showed no evidence of what the thing looks like.

- **The description was the lever — the README body is not searched at all.** Measured rather
  than assumed: searching this repository's own brand name returned **zero results** before the
  change and **one** after, because GitHub repository search matches *name / description /
  topics / owner*. Two probes settled the README question: a phrase that exists only in this
  README's text (`chimes in, picks up running jokes`) returns 0 repositories, and so does a
  phrase that exists only in its `<h1>`. The description now carries the brand name and the
  words people actually type, and `topics` went from 12 to 19 (`apache-license` was noise).
  Crowded terms stay out of reach either way — `napcat` has 1178 repositories — so what this
  buys is *findability on the right words*, not rank.
- **One console preview figure — light and dark side by side — below the badges.** The first
  screen had no evidence that this is a finished program. It sits **under** the status badges
  rather than above them (the badges answer "is it alive", the figure answers "what does it look
  like"), with a caption and a rule above and below so it reads as its own band instead of
  trailing off the hero. The two themes are composed into **one image on purpose**: two
  `width="420"` tags exceeded the README column (~830px) and silently wrapped onto separate
  lines, and no pair of fixed widths is safe at every viewport — one image cannot wrap.
  ⚠️ Both halves show an account nickname, in the top bar and on the account card. The project's
  sentinel table records that nickname as a **real** value, so it was replaced with `小鱼` —
  the same placeholder the sanitiser already uses in `config.example.json` — before either half
  was committed, and the replacement was verified by asserting that zero ink pixels remain in
  the filled region (the dark half needed a **reversed** test: its text is brighter than its
  background).
- **A three-step quick start on the first screen**, because the previous first screen asked a
  visitor to read an architecture diagram before telling them how to run anything.

> **Why the `<h1>` is just the brand name.** An invented brand in the title is not a
> discoverability problem *by itself* — the searchable words belong in the description — and
> both READMEs explain what the thing is in the line directly underneath. A keyword-bearing
> title was tried and reverted once the measurements above showed it bought nothing.
- **The release has an artifact.** `v0.1.1` was published with a tag, release notes and
  **zero downloadable assets**. The packaged Windows zip is attached to it now — after being
  re-scanned against the project's sentinel table, zero hits.

The publish checklist (a held-back internal document, not part of this repository) was brought
back in line with what actually runs: it still described the push as `git push -u origin main`
and carried a `git push --force` note, while the real path has been the Git Data API append
since 2026-10-08. A checklist describing a mechanism nobody uses is the same class of defect as
two implementations of one rule.

### 2026-10-09 · Two download scripts could only report a failure wrongly

`docker/napcat/fetch-linuxqq.sh` and `fetch-napcat.sh` both run under `set -u`, and both print
their size check with `$GOT` or `$VERSION` followed **directly** by a full-width character. Bash
reads those multi-byte bytes as part of the variable name, so the message meant to explain the
failure instead killed the script with `unbound variable` — exit 127, and the real reason never
printed. A failure that reports the wrong reason is worse than one that reports nothing: it sends
the reader after the wrong thing (a download problem that looks like a shell problem). The
variables are braced now, and every `.sh` in the repository passes `bash -n`.

## 0.1.1 — 2026-10-08

### 2026-10-08 · Route C gets the same install shortcut as route A

Both READMEs describe three protocol-side routes, but only route A offered a shortcut to its
install steps; route C's pointer was a sentence trailing after the code block. Route C now
carries the same shortcut in the same shape, pointing at **section 9 of the user guide**,
where the Windows steps actually live. The old trailing sentence stays as prose, so the
section still links to its target exactly once.

The Windows section of each guide now opens with a language switch — the English one with
**切换到中文说明书**, the Chinese one with its mirror image. Both shortcuts land on an anchor
_deep inside_ a document, which skips the language note at the top of the page; that is why
the switch has to exist inside the section it lands on, not only at the top of the file.

### 2026-10-08 · Windows: the same bot, a different protocol side

The project used to be macOS-only, and not by choice. Docker was on the macOS route because
NapCat's Mac build allowlist had stopped half a year earlier than the QQ builds people actually
have — running QQ inside a Linux container was the way around it.

Windows never needed that detour: **NapCat ships a current native Windows build.** So the
Windows route is shorter — no Docker, no WSL2, no Linux subsystem — and it lands on the same
ports (OneBot `3001`/`3000`, console `8788`), so **the bridge and the console are the same code
on both platforms**. What changes is the shell around them: a `QQ-BOT-CONTROL.bat` launcher,
`taskkill` instead of process groups, PowerShell instead of `pgrep`/`lsof`, and a native
NapCat window instead of a container.

Two things were worth being careful about, and both are now pinned by tests. Windows has no
public way to read another process's working directory, so process identity falls back to a
**positive** signal — the command line must carry this repo's absolute `src/index.js` — which
means a bot started by hand with `npm start` shows up as 0 instances in the console (the
multi-instance lock is unaffected; it is keyed on pid). And `process.kill(-pid)` is not
supported there, so "gather the whole process group" would have silently degraded to killing
one process while still reporting success.

### 2026-10-08 · A user guide, in both languages, for both platforms

New: `USER-GUIDE.md` and `USER-GUIDE.zh-CN.md`. The READMEs explain what the project *is*;
these explain what to *do*, in the order you would do it: prerequisites, install, sign in,
the configuration checklist, start, verify, day-to-day use, troubleshooting, uninstall.

They are organised as one guide with a platform split rather than two copies — the
configuration, day-to-day and troubleshooting sections are identical on both platforms, so
duplicating them would have meant two copies of the same truth. A short table at the top says
which section belongs to which platform.

Three traps are called out explicitly, because all three fail *without an error*:

- **The allowlist template is a placeholder, not an empty list.** `config.example.json` ships
  `["填你的群号，例如 123456789"]`. The allowlist is trimmed but never validated as numeric, so
  that string is accepted as if it were a real group ID: the bot starts normally and then
  silently never answers in any group. An genuinely empty list, by contrast, refuses to start
  with a clear message.
- **A key typed into the console may be ignored** if `llm.apiKeyEnv` names an environment
  variable that is actually set — the environment wins, and nothing in the UI says so.
- **"Local model" is our machine, not yours.** That switch automates *this maintainer's*
  MLX / QwenChat layout. To run a local model, add it through **Custom model** with an
  OpenAI-compatible URL (Ollama, LM Studio, a vLLM box on your LAN) — those addresses are
  recognised as local and billed as free.

### 2026-10-08 · Plugin cards tilt as one grid again

The tilt effect had been changed to move each card on its own, which had the side effect of
cards appearing not to react at all. It is back to tilting the whole grid as one unit.

### 2026-10-08 · App icon rebuilt for macOS 26 (Tahoe)

`scripts/make-appicon.py` gains a `--full-bleed` mode, and the app icon is rebuilt with it.
macOS 26's icon system puts its own container around the canvas and **fills transparent areas
with a grey material**, so the traditional 824-of-1024 inset was being rendered as an
unattractive grey frame. The new mode composites a gradient background with the character art
and fills the canvas; `assets/appicon-figure.png` is the source artwork.

### 2026-10-07 · Custom models: bring your own key and endpoint

The four built-in brains are the ones we picked. This adds the one that was missing: **your
own**. Any OpenAI-compatible endpoint works — a company gateway, a self-hosted relay, LM
Studio on another machine, or a provider we have not wired up.

Add one from the console: name, address, key, model name, and then tick what it can actually
do — vision (pictures from the group get sent), thinking (a reasoning parameter is sent),
web search (the search tool is attached). **Only the boxes you tick show up afterwards**, so
there is no row of greyed-out switches you cannot use. Keep as many as you like, switch
between them like any other brain, and **right-click** one to rename or delete it.

Two things worth knowing before you fill the form in:

- The address must be the **API** address, not the provider's console website. Pasting the
  console URL now gets a plain explanation instead of a config that fails on every request —
  that address belongs to no known provider, so the anti-phishing check could not catch it.
- Thinking uses the most common parameter spelling. If the endpoint does not accept it, the
  request is resent without it rather than failing outright.

Custom models live in `llm.customBrains` rather than `llm.presets`: that table is "one
provider → one set of settings", and making it hold user-named, many-of-them entries would
have meant changing a dozen places that all assume a fixed list.

Also fixes a gap left by the Qwen batch: its thinking parameter was never actually wired up,
so the switch existed and did nothing. It now sends `enable_thinking` plus `reasoning_effort`.

### 2026-10-07 · Qwen joins the brain presets, and "free" becomes a single rule

The console now offers a fourth brain: **Qwen** (Alibaba's Qwen Studio, the rebranded DashScope), at
`https://dashscope.aliyuncs.com/compatible-mode/v1` — OpenAI-compatible, so it speaks the same protocol
as the other three. Switching to it is the same one-click action, and its settings are stored, archived
and restored like theirs. The default fallback chain is deliberately long here: Qwen grants its free
tokens **per model**, so a longer chain means more grants in a row.

**"Free" is now one rule instead of three lists.** Whether a call costs money used to be decided by
`FREE_CLOUD_MODELS` / `CREDIT_CLOUD_MODELS` / `isZhipuModel` in `panel/lib/models.js`, plus a second copy
inside the usage report. All of them moved into `src/free-quota.js`, which answers with one of four
outcomes — local / permanently free / granted / metered — for every provider. Records written before the
service provider was logged fall back to the old model-name lookup, so **existing history is unchanged
to the cent**. The console says which case applies and when it ends.

Two of the new bits are deliberate negatives:

- **No live balance for Qwen.** Its usage API is account-scoped, so an API key cannot read it. The
  console says "check the website" and links there, rather than showing a number it does not have.
- **No tool calling for Qwen yet.** Official docs say it is supported, but not one Qwen model has been
  probed on this machine, and a capability with no measurement behind it stays off. Enabling it is three
  documented steps in `src/model-caps.js`.

Also: pasting the *console* address (`platform.qianwenai.com`) instead of the API address now gets a
plain explanation instead of a saved-and-broken config. That address belongs to no known provider, so
the anti-phishing check could not catch it; a fourth guard does, and it says which address to use.

And a bug that had been hiding in plain sight: the "candidate models" pool on the fallback-chain card
read `zhipuMeta.freeModels` — a field that does not exist on the object being sent — so the pool was
always empty and the card always said "not available in this build". It now reads the capability table
for whichever provider is active.

### 2026-10-07 · Logo back above the title, on its own line

The logo had been moved inside the heading (`# <img …><br>QQ-BOT-Creative`) to tighten the gap to the title.
The earlier arrangement turned out to be preferred, so the `<img>` is a separate block again with the heading
below it. The picture and its 200px width are unchanged.

### 2026-10-07 · Renamed the logo asset to `assets/logo-v2.png`

The artwork changed but the URL did not, and both jsDelivr and GitHub's image proxy cache by URL for days — so
the old picture kept being served no matter what. The asset is now `assets/logo-v2.png`, which gives it a fresh
URL and makes both caches fetch it again. A purge request to jsDelivr did not take effect. **Any future change
to the image needs a new file name, for the same reason.**

### 2026-10-07 · Logo artwork and its placement in the README

The logo now uses the complete artwork — the previous crop cut the top of the hair off — and renders at 200px
wide instead of 168px. The `<img>` also moved inside the heading (`# <img …><br>QQ-BOT-Creative`) so the picture
and the title form a single block: previously the picture sat in its own paragraph and GitHub's default margins
left a noticeably large gap between it and the title. The desktop app icon was rebuilt from the same complete
artwork, and the bundle re-signed.

### 2026-10-07 · README logo served through a CDN

Both READMEs now load the logo from jsDelivr's `gcore` endpoint (`gcore.jsdelivr.net/gh/...`). The file itself
is unchanged and still lives at `assets/logo.png` in this repository — only the URL that renders it changed.
The canonical `cdn.jsdelivr.net` host is not usable here: for these paths it answers with a redirect to
`raw.githubusercontent.com`, which is the very host we are trying to avoid, and that redirect chain fails.

Why: every GitHub-hosted raw URL (`./assets/logo.png`, `.../raw/main/...`) ends up being fetched straight from
`raw.githubusercontent.com`, and that host is frequently unreachable on some networks — the logo then renders as
a broken image. Pointing at a non-GitHub host additionally makes GitHub proxy the image through
`camo.githubusercontent.com`, which is reachable where the raw host is not.

### 2026-10-07 · README logo: absolute image URL

The logo was first referenced as `./assets/logo.png`. GitHub's renderer keeps that path relative in the HTML it
hands to the page, which makes the rendered README depend on how the page resolves relative URLs; the logo did
not show up on the repository page. Both READMEs now use the absolute URL GitHub itself generates for a raw
file (`.../raw/main/assets/logo.png`), which removes the dependency on that resolution step. The file is
unchanged and still lives at `assets/logo.png`.

### 2026-10-07 · Desktop console app icon

`QQ-BOT-CONTROL.app` now carries the same artwork as the README logo; the previous icon was a different
illustration. `AppIcon.icns` and `AppIcon-preview.png` were rebuilt from the artwork at 1024x1024 with an
adaptive 256-colour palette, which is what brought the two files down as well (1.5 MB -> 0.98 MB and
793 KB -> 496 KB).

The bundle is ad-hoc signed, so touching any file under `QQ-BOT-CONTROL.app` invalidates its seal — the app
was re-signed with `codesign --force --sign - --identifier local.qqbot.panel`, and `codesign --verify`
passes. Skipping that step does not produce a warning: the app simply fails to start with
`a sealed resource is missing or invalid`.

### 2026-10-07 · Repository logo in the README

Both READMEs (the English default and the Chinese version) now open with the project logo, centred above
the title. The asset lives at `assets/logo.png` and is committed to the repository instead of being linked
from anywhere else, so it renders for everyone who opens the page — on GitHub, in a clone, and in the
publish copy. It is a 384x384 PNG with an adaptive 256-colour palette, which brings the original
1912x1920 / 479 KB artwork down to about 86 KB.

### 2026-10-07 · The identity gate protects contributors too, not just the maintainer

The goal is not "only the maintainer appears on the contributor list" — it is that every name on the list
belongs to someone who actually landed commits. Those are two different things, and the second one means
the gate must not push real contributors away either.

A contributor's commit carries *their* noreply address, which by construction is not on the maintainer
whitelist. So M-08d now applies only to the line we are about to publish: the local development repo
(it still carries `scripts/publish-audit.mjs`) and the publish copy (the `IS_PUBLISH_COPY` stub marker).
Any other clone skips it — in that shape the history is *supposed* to contain contributors' commits, and we
cannot push anything from that shape anyway, so the gate would have nothing to protect while producing
false alarms about people who did the work.

Verified in all three shapes: the development repo passes; a clone of it with a poisoned middle commit
fails and names that commit; a clone without `publish-audit.mjs` — which is what a public clone looks like —
skips instead of flagging contributors.

`CONTRIBUTING.md` now states both halves: what the machine guarantees (every name on the list maps to a
commit that really landed, under the author's own identity) and what only a human can decide (which
submissions are worth merging). It also spells out that the publication flow may no longer reset a branch
that already carries someone else's commits, and fixes an earlier line that implied `plugins/` and
`skills/` never ship — 13 self-owned packs do.

### 2026-10-07 · The identity gate now reads the whole line, not just the last commit

The original incident was eight commits buried in the middle of the history, credited to someone else's
account. A gate that only looked at `HEAD` would not have seen any of them — the last commit was clean.
M-08d now walks every commit reachable from `HEAD` in one pass (one `git log --format`, so a long history
does not spawn a process per commit) and reports offenders by short SHA together with the account they
would be credited to.

Verified three ways. A poisoned **middle** commit in a scratch clone turns it red and names that commit
(`3f81301 · 作者=qqbot@… ⇒ 会记到账号「qqbot」名下`) while `HEAD` stays clean; the same tree with correct
identities stays green; and the publish copy went red on the private address that shipped in the first
release. There is deliberately no mutation entry for M-08d — the mutation harness rewrites file contents,
while this judge reads commit objects — so those three recorded runs are its evidence, with the exact
commands written into the mutation list header.

### 2026-10-07 · The commit identity is now checked on the commit itself, not on the config

Published commits used to be created by a bare `git commit` inside a directory that was freshly
`git init`-ed. That directory has **no `[user]` section**, so the commit inherited whatever the machine's
global identity happened to be — and the only identity gate we had read `.git/config`, which meant it
**silently skipped itself on the very artifact that gets published**. The first release of this
repository shipped with a private e-mail address in its author field; all four layers were green.

- Added **M-08d**: the author *and* committer e-mail of `HEAD` must be either the owner's official
  `noreply` address, GitHub's own `noreply@github.com` (merge commits), or one of the two bot identities.
  Anything else fails — including "someone else's noreply", which is exactly how commits used to be
  credited to a third-party account. It is scoped to the moment we push (local repo + publish copy) and
  skipped in CI, where the commit is already public and a gate cannot stop anything.
- The publish checklist no longer offers a bare `git commit`: the identity is **written into the command**,
  so a different machine or a different global config cannot change who gets credited.
- The one-command publish script now **refuses to reset the branch when the remote has more than one
  commit** — otherwise the next release would erase contributors' commits together with their attribution.
  Contributors are told about this in `CONTRIBUTING.md`, together with the promise that their commits
  keep their own authorship.
- New mutation list `test/mutations/identity-1007.mjs`. M-08d itself cannot be expressed as a
  file-content mutation (it reads a commit object), so its evidence is two recorded live runs — the
  false positive on the published copy, and the same check turning green once the commit is re-signed.

### 2026-10-07 · Relicensed to Apache-2.0, renamed the repository to `ai-bot-groupmate`

**License**
- `LICENSE` is now the verbatim **Apache-2.0** text; `package.json` → `"license": "Apache-2.0"`.
- Added a root **`NOTICE`** file: the attribution notice that Apache §4(d) makes mandatory for anyone who
  redistributes this work.
- **The copyleft network clause is gone by choice.** Anyone may now ship this closed, including as a network
  service, without feeding changes back. In exchange, Apache-2.0 keeps an **explicit patent grant** — the thing
  MIT would have dropped.
- **New constraint, so it is written down:** AGPL / GPLv3 code can no longer be merged into this work (it could
  under AGPL). Borrowed design stays borrowed design — see `THIRD-PARTY-NOTICES.md` §2.
- `CONTRIBUTING.md` now states contribution terms as Apache-2.0 §5 (inbound = outbound, no CLA).

**Fixes (two statements in one repository contradicting each other)**
- `THIRD-PARTY-NOTICES.md` §3 claimed `plugins/` and `skills/` had "never entered version history" and that a
  clone would not receive them. The opposite was true: **13 packs ship with this repository** (5 plugins,
  8 skills). The section now lists them by name.
- Those 13 packs carried `"author": "QQ Agent"` — a name that reads as a third party. They are ours; the field
  now reads `QQ-BOT-Creative`.

**Rename**
- Repository slug `ai-group-chat` → **`ai-bot-groupmate`**: package name, lockfile, `homepage` / `repository`,
  both READMEs' badges and the M-08 package-name gate moved together. The project's **display name stays
  `QQ-BOT-Creative`**.

**Contracts and mutations (a coupled change)**
- §25 no longer pins the license *shape* by byte count. Apache-2.0 is 11,358 bytes against AGPL's 34,523, so the
  old `length < 30000` "this looks truncated" ruler would have flagged a perfectly good file. It now checks both
  ends of the text instead (name + version line · `END OF TERMS AND CONDITIONS` + `APPENDIX`).
- Added a **paired** judge for the pack count: the number is read *out of the declaration* and compared with
  `git ls-files -- plugins skills`. The contradiction above was invisible to all four layers — no judge had ever
  looked at a number.
- `NOTICE` joined the governance files README must link, and §25 now fails if it goes missing or loses its
  copyright line.
- The identity gate's origin allowlist (M-08b) moved with the slug. **Left alone it fails silently**: the
  maintainer's own clone starts looking like someone else's fork, and the identity check is skipped while the
  output stays green. Verified both ways — with the old `qqbot` identity it goes red, with the official one it
  goes green again.
- New mutation list `test/mutations/license-apache-1007.mjs`: 5 mutations, all BLOCKED, anchors 1/1.

### 2026-10-06 · English-first repository: default README in English, centered layout, 9 badges

**Docs**
- **`README.md` is now the English edition** — the one GitHub shows when someone opens the repo. The Chinese
  edition moved to **`README.zh-CN.md`** and stays authoritative whenever the two disagree. Both carry a
  language switcher at the top and the bottom.
- Reworked the header into a centered block (icon · name · one-line pitch · full-width badge wall) so the repo
  reads well on first open. Badges went from 2 to **9**, split into two rows; the CI / CodeQL / license /
  last-commit ones are **dynamic**, so they cannot rot.
- Added `assets/icon.png` (240×240, downscaled from the app icon) — the 1024×1024 original was 793 KB, far too
  heavy to embed in a README.

**Contracts and mutations (a coupled change)**
Switching the default README's language moves several gates, because they read that file:
- the "license and credits section" assertion now accepts either language (`许可与出处` / `License`);
- the "why the counts are not hard-coded" assertion now pins `deliberately not hard-coded` (was `不写死`);
  the wording coupling there is intentional friction — change the sentence, change the gate;
- the ROT list gained **four English shapes** for the same anchors. Without them this contract would have been
  **vacuous** on an English README: writing "449 assertions" would have stayed green;
- mutations `M4` / `M5` / `M6` were re-anchored to the English lines, and `M5` now plants the English count
  form so it actually covers the new patterns.

**Convention**
- **Commit messages are English from now on**, as are new CHANGELOG entries — the repository presents English
  first. Older entries keep the wording they were written with.

### 2026-10-06 · 中英双语 README ＋ 徽章 ＋ 修掉一条只在 CI 上露头的假红

**文档**
- 新增 **`README.en.md`（英文版）**，与中文版逐节对应（含目录树、设计要点、已知限制、路线图）。
  两份开头都加了语言切换。⚠️ 英文版是**精简版**，文件头写明「`README.md` 为权威版本」。
- 中文版标题下徽章从 2 个加到 **9 个**：许可 · 四层门禁 CI 状态 · CodeQL · Node 版本 ·
  运行时依赖（只有 `ws`）· 零构建 · 最后提交 · Issues · PRs welcome。
  其中 CI / CodeQL / 最后提交 / Issues 是**动态**的（跟着仓库走，不会腐烂）。
- ⚠️ 顺手修掉中文版目录树里**两处过时条目**：`panel/parts/`（该目录早已删除，且契约明令不许复活）、
  `src/ 61 个模块`（实际已不是这个数）。**条数改成不写死** —— 它腐烂过一次，就是 M-02 说过的那个形状。

**修复（只在 CI 上露头的假红）**
- `test/smoke.js` 的 **`T348`** 原先只等「跨群那一条」发出，就立刻数「当前群照常回几条」——
  而当前群那条是**第二轮**才发的，trace 里的 `cross` 记账又晚于发送，**三者之间没有顺序保证**。
  公开仓 CI（Ubuntu）实测 `当前群照常回=0 条 · trace.cross=undefined`，而同一提交本机 macOS 上 462/462。
  改成等「三件事都落定」（两条发送 ＋ trace 的 cross 记账），并把 trace 解析收成一处。
  ⚠️ 用例名与夹具一字未动 —— 契约钉着 `'T348 ★ 真入口（D18）'` 这个字符串、变异 `d18.mjs` M14 钉着夹具。

### 2026-10-06 · 发布面自洽：公开仓改成「发布拷贝」形态

**发现（开源当天就暴露的）**：首次发布走的是「原地重写 ＋ 直推」，**绕过了 `make-publish-copy`
的发布白名单** —— 于是公开仓带着**开发仓全量**的文件，其中约 45 份是**只该留在本仓的内部件**
（归档目录全部、内部进度台账、发布清单、逐轮交付报告、外包回执）＋ 发布审计脚本本身。
而按设计这些**都不公开**：`docs/` 的发布面由 `scripts/lib/publish-docs.mjs` 的白名单一处说了算。

**修法**：公开仓改为 `make-publish-copy` 的产物（`docs/` 只留通用技术文档 ＋ 一份桩）。

**连带修掉的三处自相矛盾**（此前那份拷贝若有 CI 必然红）：
- CI 的「发布审计」那一步加 `hashFiles(...)` 守卫：该脚本按设计不随拷贝发布，
  于是**公开仓里这一步跳过、本仓（开发仓）照常跑**。
  ⚠️ 只能放**步骤级** —— `hashFiles` 要在 checkout 之后求值；放 job 级会连开发仓也一起跳过，
  那道真值闸就**静默失效**了（比红了更糟）。
- README / CONTRIBUTING / SECURITY 里几处「`npm run publish:audit`」的指引补上说明：
  **该脚本与它读的去标识对照表都只住在维护者仓库里**，不随公开仓库发布 ——
  否则公开仓里那是一条**点了就报错**的命令。

> 这一批与上一条同源：**「发布」这件事在本项目里有两套形态（开发仓 / 对外拷贝），
> 混着用就会在"看起来一切正常"的状态下多发东西。** 判据是 `make-publish-copy` 的产物复扫，
> 不是"我记得排除了"。

### 2026-10-06 · 进程探针可移植（Linux 上「停止机器人」曾静默失效）

**修复**
- `src/bridge-proc.js` 新增 `PGREP` / `LSOF`（**可移植解析**：先按候选绝对路径找，都找不到就原样交给
  PATH）与 `PGREP_LIST_FLAGS`（**平台旗标**）。此前 `src/bridge-io.js` 与 `panel/server.js` **各自写死**
  `/usr/bin/pgrep`、`/usr/sbin/lsof` 与 `'-fl'` —— 这**两样在 Linux 上都不成立**：
  ① **路径**：`lsof` 在 macOS 住 `/usr/sbin`、在 Debian/Ubuntu 住 `/usr/bin`；
  ② **旗标**：BSD/macOS 的 `-l` 连完整命令行一起打印，而 procps 的 `-l` **只打进程名**
     （要打命令行得用 `-a`，见 man pgrep 的 `--list-full`；`-f` 只改匹配、不改输出）。
  于是 Linux 上不是报错，而是**静默降级**：实例锁退回「探针不可用 → 放行」那支；
  面板**实例数恒为 0、"停止机器人"点了没反应**；面板 `freePort` 清不掉占着端口的僵尸进程。
  而本项目的推荐部署正是 Docker + Linux。
- `test/smoke.js` 的 T334 改为**从被测的同一份实现取**这三个常量（此前两边各写一份字面量，
  所以一起错），并把 `isOurBridge` 的 **`reason` 一并报出来** —— 首轮在 Linux 上只看到 `false`，
  白猜了一轮；探针**真的不可用**时改为**显式 SKIP ＋ 原因**，与 T120 / T126 同一条约定。
- `scripts/check-wb.mjs` 里那两条判据原先钉在 `/usr/bin/pgrep` 与 `'-fl'` 这两个字面量上，
  改为认常量名 —— 它们要判的是「按完整命令行提名」这件事，不是工具住在哪、旗标长什么样。

**CI**
- `契约（check-wb）` job 增加一步 `bash scripts/pre-commit.sh --install`：契约里那条
  「`.git/hooks/pre-commit` 在位」在全新 clone 上必然为假（钩子不入库），首次真跑 CI 正红在这里；
  顺带证明该装法在干净 clone 上可用。
- `行为回归（smoke）` job 增加 `apt-get install lsof`，让 T334 在 Linux 上是**真验**而不是 SKIP。

> 背景：上面这一批是**首次真正跑 CI**（在此之前仓库还没有远端）当场逮出来的。
> 两条都符合本项目那句老话 —— **「改了不报错」的缺陷只能靠"换个平台真跑一遍"暴露**。

### 2026-10-06 · 开源发布面补齐（README 两节 + PR 模板）

**文档**
- `README.md` 新增两节：**`11. 路线图`**（已知未做项，用勾选清单写成、明确标注"不构成时间承诺"）
  与 **`13. 联系方式`**（Issues 为首选渠道，安全问题指向 `SECURITY.md`）。
  原「参与本项目」「许可与出处」顺延为 12 / 14。
  ⚠️ 此前**从 README 进来的人看不到项目往哪走，也找不到提问入口** —— 这是开源前审查列的最后两项文档缺口。
- `README.md` 标题下补两个徽章（许可 / Node 版本要求）。此前一个徽章都没有。
- 新增 **`.github/PULL_REQUEST_TEMPLATE.md`**：提交 PR 时自动出现自查清单
  （四层门禁 · 变异测试 · 发布审计 · 运行时数据不该进 diff · 变更日志 · 第三方声明）。
  ⚠️ 此前**只有 issue 模板、没有 PR 模板**，贡献者在提交前无从知道这个项目对工程纪律的要求。

**仓库形态**
- 开发历史的**提交信息本身**是内部叙事（含批次编号、内部裁决、真实标识符的处置记录），
  而 `docs/` 的内部件与 `.env` 这类敏感路径只在**工作树**层面被排除 —— 提交信息不在任何闸门的射程内。
  因此首次公开发布采用**全新的单提交历史**，与本项目的对外拷贝机制同源。
  （完整历史在仓库外留有可恢复备份，仅作本地留档。）

### 2026-10-06 · 巨型文件拆分 + 对外拷贝可自证

**结构（H-10 · 巨型文件拆分，5 个文件里的 3 个应用层 + 2 个测试资产）**
- `src/brain.js` **1234 → 954**：文本工具族 → `src/reply-text.js`（零依赖叶子）；
  表情标记与出站分段族 → `src/face-marks.js`。`brain.js` 原样转出，外部引用不变。
- `src/index.js` **3172 → 2829**：写盘口那一族（落盘路径常量 / 留档 / 思考标记 /
  进程探测 / trace 追加 / 判定卡 / 未读记账）→ `src/bridge-io.js`。
- `panel/server.js` **3157 → 2790**：审计 → `panel/lib/audit-log.js`；
  用量与花费 → `panel/lib/usage-report.js`（依赖全部注入，模块零 import）。
- `scripts/check-wb.mjs` **14104 → 13868**：`MIN_CONTRACTS` 的 270 行增长账 →
  `scripts/CONTRACTS-HISTORY.md`。
- `test/smoke.js` **10458 → 10343**：测试骨架 → `test/helpers/harness.js`。
  ⚠️ 用例本体**按设计留在原处**（462 个用例共用一个 `main()` 闭包，
  搬它要重排契约的行号锚点，风险大于收益）—— 理由写在 `harness.js` 文件头。

**发布面（这一批让"别人 clone 下来能不能用"第一次可以自证）**
- 对外拷贝里 `node scripts/check-wb.mjs` 与 `node test/smoke.js` **现在是全绿的**：
  此前拷贝里跑分别是 **25 红 / 459-462**，而那全是假红 ——
  `check-wb` 用 `git check-ignore` / `git ls-files` 取证，拷贝刚生成时没有 `.git`；
  三条用例依赖 `plugins/复读拦截` 与 `skills/合并转发发送`，而那两处**都不入库**。
- `check-wb` 新增**发布副本感知**：那几样**按设计不随拷贝发布**的内部件
  （发布审计脚本 / 内部归档目录 / 内部台账 / git 钩子）在拷贝里判**「不许在」**（反向断言），
  在内部开发仓里判「必须在」 —— **不是跳过，是换一条更强的断言**。
- `test/smoke.js` 新增 `SKIP`（显式打印、计入用例数）：夹具不在时跳过并说明原因，
  **不是静默 pass**。`T121` 原来写死的「扫描 13 个」放开成 ≥1（它数的是本机的包数）。
- 发布动作清单补上实测发现漏掉的一步：**验收必须在 `git init` 之后跑**
  （否则 `check-wb` 里靠 `git check-ignore` / `git ls-files` 取证的整段判据会落空，报 25 条假红）。

### 2026-10-04 · 代码质量审查与修复（两轮）

**第一轮 · 安全与卫生**
- 清除被跟踪文件里的真实标识符（本机用户名绝对路径、机器人显示昵称）；
- 把 3 个"被产品代码引用却未纳入版本控制"的模块及其变异清单补进仓库；
- 项目记忆目录移出版本控制（`git rm --cached`，磁盘文件保留）；
- 补 `.gitignore`：`/.workbuddy/`、`/_archive/`、`/docs/*.png`；
- 修复两个扩展包"加载即失败"（导入了本宿主不存在的 `getConfig` / `updateConfig`）；
- 修复记忆检索的死选项名（`includeUnavailable` → `includeDead`）；
- 哨兵表补齐 5 条缺失的 `placeholder`（此前去标识安全网对它们静默失效）。

**第二轮 · 结构与治理**
- 发布审计新增**凭据形态**扫描（与产物复扫共用一份判据 `scripts/credential-shapes.mjs`）；
- `config.example.json` 生成器补齐 6 个"代码会读、模板却没有"的键；
- 补齐治理文件：`CONTRIBUTING.md` / `SECURITY.md` / `CODE_OF_CONDUCT.md` / `.github/` / 本文件；
- 新增 `docs/ARCHITECTURE.md`；`THIRD-PARTY-NOTICES.md` 补录两处前端算法来源（均 MIT）；
- `config.json` 权限收紧为 `0600`；删除与 `ws.json` 逐字节重复的配置模板。

### 更早

见内部批次台账与归档索引（两者都是**内部件，不随公开仓库发布**）。
