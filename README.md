# 🧠 Multi-Agent Example — real "AI commanding AI" (TypeScript)

Companion examples for the article [`docs/ai-commanding-ai.md`](docs/ai-commanding-ai.md) — a demo of the
**orchestrator-worker** pattern that **calls real Agent CLIs** (not canned responses), written in
**pure TypeScript** and **runnable with no build step** (Node strips the types at runtime).

Two examples:

1. **CLI demo** — Node scripts that show "how to send a command to each agent" plus a full orchestrator
2. **Web app** — a page where named agents talk to each other in real time and produce a synthesized answer

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

- **Node.js ≥ 23.6** (this project runs `.ts` directly via type stripping — no `tsc`/`ts-node` needed)
  ```bash
  node --version   # must be v23.6+ (v24+ recommended)
  ```
- **Agent CLIs installed + logged in** — whichever you have; any missing one is skipped automatically
  - `claude` ([Claude Code](https://code.claude.com/docs/en/headless)) — required for the orchestrator
  - `codex`, `opencode`, `agy` — workers (any number of them)

No `npm install` needed — this project is **zero dependency** (uses only Node built-ins).

---

## 1️⃣ CLI demo — sending commands to agents

### `send-to-each` — fire the same command at each agent, one at a time
Gets the idea across first: how you "send a command to another agent" (each one's headless mode).

```bash
npm run send -- "what is idempotency in a REST API?"
# or: node src/send-to-each.ts "your question"
```

### `orchestrate` — the full orchestrator-worker
Athena plans → fans work out to the whole crew in parallel (with a spinner) → synthesizes one answer.

```bash
npm run orchestrate -- "compare REST vs GraphQL vs gRPC in 2026"
# or: node src/orchestrate.ts "the topic you want researched"
```

> 💡 This example used to be a bash script, but it was rewritten in **Node/TypeScript** to be easier to read
> (a clean `plan() → dispatch() → synthesize()` shape — see [`src/orchestrate.ts`](src/orchestrate.ts)).

---

## 2️⃣ Web app — a page where agents talk to each other (real time)

A page where the named agents communicate as a live thread and then summarize — **firing at real agents**.

```bash
npm run web
# → open http://localhost:4173
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

## 🗂️ Project structure

```
multi-agent-example/
├─ docs/ai-commanding-ai.md   # the source article
├─ src/
│  ├─ agents.ts               # ★ core module: agent defs + real CLI callers (shared everywhere)
│  ├─ ansi.ts                 # terminal color helpers (CLI demo only)
│  ├─ send-to-each.ts         # CLI demo #1
│  ├─ orchestrate.ts          # CLI demo #2 (orchestrator-worker)
│  └─ server.ts               # web backend (SSE + spawns CLIs)
├─ public/
│  ├─ index.html              # the page
│  ├─ styles.css              # "observatory command deck" theme
│  └─ app.ts                  # frontend (TS — the server strips types on the fly and serves it as /app.js)
├─ package.json
└─ tsconfig.json              # for editor/IntelliSense only (not used at runtime)
```

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
| "a web page where agents talk" | `public/` + SSE in `src/server.ts` |

---

## ⚠️ Caveats

- **Cost multiplies** — 1 orchestrator + 3 workers = several times the tokens of a single agent.
  The web/CLI shows Claude's `total_cost_usd` per run (workers are billed on their own CLI provider's side).
- **Workers can run commands / edit files** — that's an attack surface; codex defaults to read-only,
  while `agy --sandbox` only guards the terminal tool (see the article) — don't let them touch secrets/prod unsupervised.
- This demo asks workers for short (bulleted) answers to keep time/cost down — tune the prompts in `src/agents.ts` / `src/*.ts`.
