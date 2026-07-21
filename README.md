# 🧠 Multi-Agent Example — real "AI commanding AI" (TypeScript)

Companion examples for the article [`docs/ai-commanding-ai.md`](docs/ai-commanding-ai.md) — a demo of the
**orchestrator-worker** pattern that **calls real Agent CLIs** (not canned responses), written in
**pure TypeScript** and **runnable with no build step** — works on **Node.js *or* Bun**, each stripping
the types at runtime.

Two kinds of example:

1. **CLI demos** — Node scripts that show "how to send a command to each agent" plus a full orchestrator
2. **Web apps** — four pages, each a different **coordination pattern**: parallel fan-out, single-worker routing,
   an isometric RPG office, and **Claude Code delegating to its own sub-agents**

---

## 🤖 The agent crew (each one is named)

Every agent has a persona nickname mapped to a real Agent CLI running in headless mode:

| Name | Real CLI | Headless command | Role |
|------|----------|------------------|------|
| 🦉 **Athena** | `claude` (Claude Code) | `claude -p "…" --output-format json` | **orchestrator** — plans + synthesizes |
| 🔭 **Orion** | `codex` (Codex) | `codex exec --json --skip-git-repo-check "…"` | worker — the scout |
| 🌙 **Luna** | `opencode` (OpenCode) | `opencode run "…"` | worker — the analyst |
| 🗺️ **Atlas** | `agy` (Antigravity) | `agy --print "…"` | worker — the researcher |

> Athena takes the question → splits it into 3 subtasks → fans them out to Orion/Luna/Atlas **in parallel** →
> collects their findings → synthesizes a single answer.

---

## 📟 The command each agent uses to receive work (headless)

Each CLI has its own way of accepting a prompt non-interactively. The table below is the exact command this
code sends in (see all the callers in [`src/agents.ts`](src/agents.ts)), plus a few handy variations.

### 🦉 Athena — `claude` (Claude Code)
```bash
# What this code uses (JSON output so we can read .result + .total_cost_usd)
claude -p "<prompt>" --output-format json

# Other usable forms
claude -p "summarize the riskiest bugs in src/"          # plain text output
cat error.log | claude -p "group these errors + root cause"  # read prompt from stdin (pipe)
claude -p "…" --output-format stream-json                # stream NDJSON, one event at a time
```
- **How the code parses it:** `JSON.parse(stdout).result` and `.total_cost_usd` → `askAthena()`
- `-p`/`--print` = headless mode ; `--output-format` = `text` (default) / `json` / `stream-json`

### 🔭 Orion — `codex` (Codex)
```bash
# What this code uses (--json emits JSONL per event; --skip-git-repo-check because this folder isn't a git repo)
codex exec --json --skip-git-repo-check "<task>"

# Other usable forms
codex exec "review this change, find race conditions"    # plain text output
codex exec resume --last "fix what you just found" \
  --sandbox workspace-write                              # continue the same session + allow file writes
```
- **How the code parses it:** read JSONL line by line, take the last event where `item.type === "agent_message"` → `.item.text` (`parseCodex()`)
- Sandbox defaults to **read-only**; switch to `workspace-write` if the agent must edit files

### 🌙 Luna — `opencode` (OpenCode)
```bash
# What this code uses (prints the result straight to stdout)
opencode run "<task>"

# Other usable forms
opencode run -m anthropic/claude-sonnet-5 "explain the auth flow in this repo"  # pick a model
opencode run -c "delete the dead code you just found"                           # continue latest session (pipeline)
```
- **How the code parses it:** strip ANSI + drop the `> build · …` header line + trim leading whitespace → `askLuna()`
- `-m provider/model` picks a model ; `-c`/`--continue` continues the previous session

### 🗺️ Atlas — `agy` (Antigravity)
```bash
# What this code uses (--print must come last: the Go flag parser eats the next arg as its value)
agy --print "<task>"

# Other usable forms
agy --model gemini-2.5-pro --print "which files in src/ risk a null pointer?"  # pick a model
agy --add-dir ./lib --print "…"                                               # expose an extra folder to the agent
```
- **How the code parses it:** strip ANSI then trim → `askAtlas()`
- ⚠️ agy's `--sandbox` flag only guards the terminal tool, **not file writes** — if you don't trust it, wrap it in a system sandbox (e.g. `bwrap`)

> Every command runs as a **subprocess with stdin closed** (`stdio: ['ignore','pipe','pipe']`) inside `runCLI()`,
> with a timeout (`AGENT_TIMEOUT_MS`, default 180s) and automatic skipping when a CLI is missing (`ENOENT`).

---

## ✅ Prerequisites

- **A runtime that runs `.ts` directly** (no `tsc`/`ts-node`, no build) — either one:
  - **Node.js ≥ 23.6** (v24+ recommended) — strips types via `module.stripTypeScriptTypes`
  - **Bun ≥ 1.1** — strips types via the built-in `Bun.Transpiler`
  ```bash
  node --version   # v23.6+
  bun --version    # 1.1+
  ```
- **Agent CLIs installed + logged in** — whichever you have; any missing one is skipped automatically
  - `claude` ([Claude Code](https://code.claude.com/docs/en/headless)) — required for the orchestrator
  - `codex`, `opencode`, `agy` — workers (any number of them)

No `npm install`/`bun install` needed — this project is **zero dependency** (uses only runtime built-ins).

---

## 1️⃣ CLI demo — sending commands to agents

Both demos print the **exact command** that runs (e.g. `$ codex exec --json --skip-git-repo-check "…"`), the
**real query** sent, and the **real response** returned — so you can see precisely how each headless CLI is invoked.

### `send-to-each` — fire the same command at each agent, one at a time
Gets the idea across first: how you "send a command to another agent" (each one's headless mode).

```bash
npm run send -- "what is idempotency in a REST API?"      # Node
npm run send:bun -- "what is idempotency in a REST API?"   # Bun
# or directly: node src/send-to-each.ts "…"   /   bun src/send-to-each.ts "…"
```

### `orchestrate` — the full orchestrator-worker
Athena plans → fans work out to the whole crew in parallel (with a spinner) → synthesizes one answer.

```bash
npm run orchestrate -- "compare REST vs GraphQL vs gRPC in 2026"       # Node
npm run orchestrate:bun -- "compare REST vs GraphQL vs gRPC in 2026"    # Bun
# or directly: node src/orchestrate.ts "…"   /   bun src/orchestrate.ts "…"
```

> 💡 This example used to be a bash script, but it was rewritten in **Node/TypeScript** to be easier to read
> (a clean `plan() → dispatch() → synthesize()` shape — see [`src/orchestrate.ts`](src/orchestrate.ts)).

---

## 2️⃣ Web app — a page where agents talk to each other (real time)

A page where the named agents communicate as a live thread and then summarize — **firing at real agents**.

```bash
npm run web        # Node   → open http://localhost:4173
npm run web:bun    # Bun    → open http://localhost:4173
# (change the port: PORT=5000 npm run web)
```

**What you see on the page**
- A card per agent (name + CLI + headless command + status + finding)
- **Live comms thread** — showing who commands whom / who answers what, in real time
- A phase stepper: plan → dispatch → work in parallel → synthesize
- The final answer + Claude's token cost (plan + synthesis)

**Under the hood:** the backend (`src/server.ts`) spawns the real CLIs as subprocesses and streams results
back to the frontend via **SSE** (Server-Sent Events).

---

## 3️⃣ Web app — ⚔️ RPG "Guild Hall" mode (routing)

Same server, same real agents, a **different coordination pattern**. Instead of fanning out to everyone, the
**guild master routes the quest to the single best-fit adventurer**, then turns their report into the answer.

```bash
npm run web        # same server as mode 2
# then open http://localhost:4173/rpg.html   (or click "⚔️ โหมด RPG" on the main page)
```

**The flow** — `assess → choose → quest → report → verdict`:
1. 🦉 **Athena** (guild master = `claude`) reads the quest and **picks ONE** of Orion/Luna/Atlas that fits best (+ a reason).
2. The chosen adventurer is spotlighted; the rest are benched.
3. That **one** adventurer runs its real CLI and returns a report.
4. Athena summarizes the report into the **Guild Master's Verdict** — the final answer.

**Orchestrator-worker (mode 2) vs routing (mode 3)**

| | Mode 2 — parallel | Mode 3 — routing (RPG) |
|---|---|---|
| Workers used | **all 3**, in parallel | **exactly 1**, chosen by Athena |
| Claude's job | plan + synthesize | route + summarize |
| Final answer | synthesis of 3 findings | the chosen worker's report, summarized |
| Endpoint | `/api/run` → `orchestrate()` | `/api/quest` → `questRoute()` |

**The scene:** the page renders a **2.5D isometric "guild office"** (a `<canvas>` in `public/rpg.ts`) where the
four agents are little characters that **wander around when idle** and **act out the quest** when one runs — the
guild master steps to the board, the chosen adventurer **walks back to its own desk and shows a "⚙ กำลังทำงาน"
(working) bubble** while its CLI runs, then **walks over to report** the result before the verdict. While it works, a
**work console** overlays the office showing the input it received (quest + assignment + the exact CLI command) and a
live "thinking process." Below the stage sit the character sheets, narrator log, and verdict.

> 💡 Open **`/rpg.html?demo`** to preview the whole choreography with canned data — no agent CLIs or Claude credits needed.

**Under the hood:** `questRoute()` in `src/server.ts` calls `routeToWorker()`/`parsePick()` in `src/agents.ts`
(Athena replies with `{"agent","reason","title"}` JSON). The page (`public/rpg.ts`) reads the same SSE channel and
drives both the isometric office animation and the DOM panels off the same events.

---

## 4️⃣ Web app — 🧠 Claude Hive (self-delegation via sub-agents)

The other three examples orchestrate **separate CLIs from the outside**. This one is different: it makes **one**
`claude -p` call and lets **Claude Code delegate to its OWN sub-agents** (the built-in `Task` tool) — Claude Code
fans the work out to sub-agents like `researcher` (see [`.claude/agents/researcher.md`](.claude/agents/researcher.md))
and pulls their results back itself.

```bash
npm run web        # same server
# then open http://localhost:4173/hive.html   (or click "🧠 Claude Hive" on the main page)
```

**What you see:** a central **Claude Code hub** that spawns sub-agent nodes on an orbit as it delegates; each node
shows its `subagent_type` + task, then fills in with its result; an activity feed logs every delegation; the final
answer is Claude Code's own synthesis.

**Under the hood:** `runClaudeHive()` in `src/agents.ts` spawns `claude -p … --output-format stream-json --verbose`
and parses the NDJSON stream, surfacing each `Task` tool-use (a sub-agent spawn) and its `tool_result` over **SSE**
(`/api/hive` → `hive()`). The stream-json schema isn't officially documented, so the parser is deliberately defensive.

### ⚠️ Enabling sub-agents in headless mode

For Claude Code to spawn sub-agents non-interactively, the `Task`/`Agent` tool (and the sub-agents' own tools) must
be allowed. By default this demo passes `--allowedTools Task,Agent,WebSearch,WebFetch,Read,Grep,Glob`. Override or
extend via env vars — no code edits:

```bash
HIVE_ALLOWED_TOOLS="Task,Agent,WebSearch,WebFetch,Read,Bash" npm run web   # change the allowed tools
HIVE_CLAUDE_ARGS="--permission-mode bypassPermissions" npm run web         # skip all prompts (see caveat)
```

> `bypassPermissions` skips **all** tool prompts — convenient but only use it on prompts you trust. The demo does
> **not** enable it by default (it uses an explicit allow-list instead). If no sub-agents spawn, the page still
> shows Claude Code's direct answer.

> 💡 No `claude` set up, or don't want to spend credits? Open **`/hive.html?demo`** to preview the whole flow with canned data.

---

## 🗂️ Project structure

```
multi-agent-example/
├─ docs/ai-commanding-ai.md   # the source article
├─ src/
│  ├─ agents.ts               # ★ core: agent defs + CLI callers + routing brain + hive stream-json parser
│  ├─ ansi.ts                 # terminal color helpers (CLI demo only)
│  ├─ send-to-each.ts         # CLI demo #1
│  ├─ orchestrate.ts          # CLI demo #2 (orchestrator-worker)
│  └─ server.ts               # web backend (SSE; /api/run + /api/quest + /api/hive)
├─ public/
│  ├─ index.html · styles.css · app.ts    # mode 2 — "observatory command deck" (parallel fan-out)
│  ├─ rpg.html   · rpg.css    · rpg.ts     # mode 3 — RPG "Guild Hall" (single-worker routing)
│  └─ hive.html  · hive.css   · hive.ts    # mode 4 — "Claude Hive" (Claude Code → its own sub-agents)
│                                          #   (each *.ts is served as /*.js, transpiled on the fly)
├─ .claude/agents/
│  └─ researcher.md           # a Claude Code sub-agent — the hive (mode 4) delegates to it
├─ package.json
└─ tsconfig.json              # for editor/IntelliSense only (not used at runtime)
```

### What each file does

> Each source file used to carry a header comment block explaining its purpose; that documentation now lives
> here so the code stays lean.

| File | What it is | Run it |
|------|-----------|--------|
| [`src/agents.ts`](src/agents.ts) | ★ **Core module** — agent definitions + the real headless CLI callers (`runCLI`, `askAthena/Orion/Luna/Atlas`, `parsePlan`, `reasonText`) **+ the routing brain** (`routeToWorker`, `parsePick`) **+ the hive stream parser** (`runClaudeHive`). Shared by the CLI demos and all web modes. Each persona maps to a real CLI: Athena→`claude` (orchestrator), Orion→`codex`, Luna→`opencode`, Atlas→`agy` (workers). | _imported everywhere_ |
| [`src/ansi.ts`](src/ansi.ts) | Terminal color/format helpers for the CLI demos (auto-disabled when not a TTY or when `NO_COLOR` is set). | _imported_ |
| [`src/send-to-each.ts`](src/send-to-each.ts) | **CLI demo #1** — fires the _same_ command at each agent, one at a time (orchestrator first, then the workers), to show how a prompt reaches each headless CLI. | `node src/send-to-each.ts "…"` |
| [`src/orchestrate.ts`](src/orchestrate.ts) | **CLI demo #2** — the full **orchestrator-worker**: Athena plans → splits the question into 3 subtasks → Orion/Luna/Atlas run in parallel (with a spinner) → Athena synthesizes one answer. | `node src/orchestrate.ts "…"` |
| [`src/server.ts`](src/server.ts) | **Web backend** — zero-dependency Node HTTP server. Serves `public/`, transpiles any `public/<name>.ts` → `/<name>.js` on the fly (`module.stripTypeScriptTypes` on Node / `Bun.Transpiler` on Bun — no build), and streams both demos over **SSE**: `/api/run` (parallel `orchestrate()`) and `/api/quest` (routing `questRoute()`). | `node src/server.ts` (or `PORT=5000 …`) |
| [`public/app.ts`](public/app.ts) | **Mode 2 frontend** (TypeScript, transpiled on the fly). Connects to `/api/run` and renders the agent cards + real-time comms thread + synthesized answer. | served as `/app.js` |
| [`public/index.html`](public/index.html) · [`styles.css`](public/styles.css) | Mode 2 page shell + the "observatory command-deck" theme. | open `/` |
| [`public/rpg.html`](public/rpg.html) · [`rpg.css`](public/rpg.css) · [`rpg.ts`](public/rpg.ts) | **Mode 3 — RPG "Guild Hall"** (routing). A retro-JRPG party of character cards; Athena spotlights one adventurer, benches the rest, and the verdict is Athena's summary of that one's report. `rpg.ts` is served as `/rpg.js`. | open `/rpg.html` |
| [`public/hive.html`](public/hive.html) · [`hive.css`](public/hive.css) · [`hive.ts`](public/hive.ts) | **Mode 4 — "Claude Hive"** (self-delegation). ONE `claude -p` call; Claude Code spawns its own sub-agents (Task tool). A radial hub renders each spawn/result that `runClaudeHive()` parses out of the stream-json output. | open `/hive.html` |
| [`.claude/agents/researcher.md`](.claude/agents/researcher.md) | A Claude Code **sub-agent** — deep multi-source research with real reference links, never guesses. The mode-4 hive delegates to it (also usable directly in Claude Code). | via Claude Code |

**The heart is [`src/agents.ts`](src/agents.ts)** — both the CLI demo and the web app use the same agent
callers (`askAthena`, `askOrion`, `askLuna`, `askAtlas`), which wrap CLI spawning + output parsing + error/timeout handling.

---

## 🧩 How it maps to the article

| Concept in the article | Where it lives in the code |
|------------------------|----------------------------|
| headless mode (`claude -p`, `codex exec` …) | `runCLI()` + `ask*()` in `src/agents.ts` |
| subprocess / pipe between agents | `spawn()` inside `runCLI()` |
| orchestrator-worker | `src/orchestrate.ts` and `orchestrate()` in `src/server.ts` |
| split → parallel → merge summaries | `plan()` → `Promise.all(...)` → `synthesize()` |
| routing / dispatch (pick one, don't fan out) | `routeToWorker()` + `parsePick()` in `src/agents.ts`, `questRoute()` in `src/server.ts` |
| self-delegation (Claude Code → its own sub-agents) | `runClaudeHive()` in `src/agents.ts` + `hive()` in `src/server.ts` — the `Task` tool inside one `claude -p` call |
| "a web page where agents talk" | `public/` + SSE in `src/server.ts` |

---

## ⚠️ Caveats

- **Cost multiplies** — 1 orchestrator + 3 workers = several times the tokens of a single agent.
  The web/CLI shows Claude's `total_cost_usd` per run (workers are billed on their own CLI provider's side).
- **Workers can run commands / edit files** — that's an attack surface; codex defaults to read-only,
  while `agy --sandbox` only guards the terminal tool (see the article) — don't let them touch secrets/prod unsupervised.
- This demo asks workers for short (bulleted) answers to keep time/cost down — tune the prompts in `src/agents.ts` / `src/*.ts`.
