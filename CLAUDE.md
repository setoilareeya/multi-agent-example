# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A demo of the **orchestrator-worker** pattern that calls **real Agent CLIs** (not canned responses),
written in **pure TypeScript with no build step**. Runs on Node ≥23.6 or Bun ≥1.1 — the runtime strips
TS types on the fly (`module.stripTypeScriptTypes` on Node, `Bun.Transpiler` on Bun). It is a companion to
the article in `docs/ai-commanding-ai.md`.

**Zero dependencies** — no `npm install` needed (only runtime built-ins). `@types/node` is a dev dependency
for editor IntelliSense only; there is no lockfile.

## Commands

```bash
# Web server — serves all 4 web modes (open http://localhost:4173)
npm run web            # Node        npm run web:bun     # Bun
PORT=5000 npm run web  # change port

# CLI demos — print the real command + query + response for each agent
npm run send -- "what is idempotency in a REST API?"                  # fire same prompt at each agent, serially
npm run orchestrate -- "compare REST vs GraphQL vs gRPC in 2026"      # full orchestrator-worker (plan→fan out→synthesize)
# :bun variants exist for all three (web:bun / send:bun / orchestrate:bun)

# Type-check (there is no build, lint, or test suite)
npx tsc --noEmit
```

There is **no build step, no test runner, and no linter config** in this repo — `tsc --noEmit` is the only
static check. Type-check after edits. `tsconfig.json` is for the editor only (`noEmit`, `erasableSyntaxOnly`,
`verbatimModuleSyntax`, `allowImportingTsExtensions`) — it is never invoked at runtime.

## Running things costs real money and requires external CLIs

The web/CLI paths **spawn real agent CLIs** (`claude`, `codex`, `opencode`, `agy`) as subprocesses and spend
API credits. When developing:
- **Do not run `/api/hive`, `/api/quest`, `npm run send`, or `npm run orchestrate` to "verify"** unless you
  intend to spend credits. Each web mode has a **`?demo` query param** (`/rpg.html?demo`, `/hive.html?demo`)
  that drives the full UI choreography with canned data — no CLIs, no cost. Use that to verify frontend work.
- Any CLI that isn't installed on PATH is **skipped automatically** (`resolveBin()` returns null → `ENOENT`
  handled). Only `claude` is strictly required (it's the orchestrator).

## Architecture

Everything runs through **one core module, `src/agents.ts`** — both CLI demos and all web modes import the
same agent callers, so changes to how a CLI is invoked or parsed belong there, once.

**`src/agents.ts`** is the single source of truth for:
- `AGENTS` persona map: 🦉 Athena→`claude` (orchestrator), 🔭 Orion→`codex`, 🌙 Luna→`opencode`, 🗺️ Atlas→`agy` (workers)
- `buildCmd(key, prompt)` — the **only** place argv is assembled per CLI (switch statement). Change a flag here.
- `runCLI()` — spawns via `resolveBin()` (absolute path, PATH-scan for an executable file — **not** `which`),
  `stdin` closed, timeout, ENOENT→skip. Each CLI has its own output parser (`parsePlan`, `parseCodex`, etc.).
- `routeToWorker()` + `parsePick()` — the **routing brain** for RPG mode (Athena returns `{agent,reason,title}` JSON).
- `runClaudeHive()` — spawns **one** `claude -p … --output-format stream-json --verbose --allowedTools <HIVE_ALLOWED_TOOLS>`
  and parses the NDJSON to surface each `Task`/`Agent` tool-use (a sub-agent spawn) and its `tool_result`. **The stream-json
  schema is undocumented**, so this parser is deliberately defensive (tolerates multiple field shapes); don't assume a
  canonical format. The whole hive page is that **single subprocess** — every activity-feed badge (`start`→`run_start`,
  `plan`/`synthesis`→`main_text`, `Task`→`spawn`, `result`→`subagent_result`) is an event parsed out of its stream, **not**
  a separate CLI call; `spawn → researcher` is Claude Code invoking its own `Task` tool, not a shell command.

**The four web modes** are four coordination patterns on **one server** (`src/server.ts`, zero-dep Node http,
streams over **SSE**). The server transpiles any `public/<name>.ts` → `/<name>.js` on the fly (a generalized
route), so frontend files are plain ES-module TS served without a build:

| Mode | Page | Endpoint → handler | Pattern |
|------|------|--------------------|---------|
| 2 | `index.html` / `app.ts` | `/api/run` → `orchestrate()` | parallel fan-out — all 3 workers, then synthesize |
| 3 | `rpg.html` / `rpg.ts` | `/api/quest` → `questRoute()` | routing — Athena picks **exactly 1** worker, summarizes its report |
| 4 | `hive.html` / `hive.ts` | `/api/hive` → `hive()` | self-delegation — one `claude -p` fans out to its **own** sub-agents |

Mode 3's `rpg.ts` is a 2.5D isometric canvas (`Stage` class) driven off the same SSE events that fill the DOM panels.

**`.claude/agents/researcher.md`** is a real Claude Code sub-agent that mode 4's hive can delegate to.

## Config knobs (env vars — no code edits)

- `PORT` (default 4173) — web server port
- `AGENT_TIMEOUT_MS` (default 180000) — per-CLI subprocess timeout
- `HIVE_ALLOWED_TOOLS` (default `Task,Agent,WebSearch,WebFetch,Read,Grep,Glob`) — tools the hive's `claude -p`
  may use. Sub-agents can't spawn in headless mode unless `Task`/`Agent` is allowed.
- `HIVE_CLAUDE_ARGS` — extra args appended to the hive `claude` call (e.g. `--permission-mode bypassPermissions`).
  The demo does **not** default to `bypassPermissions` — it uses an explicit allow-list. Only bypass on trusted prompts.
- `HIVE_TIMEOUT_MS` (default 300000), `NO_COLOR` (disables ANSI in CLI demos)

## Conventions

- **Comments are in English; user-facing string literals are Thai** (this is a Thai-audience demo). Keep both.
- **Prefer top-level `await`** in entry scripts over an `async function main() { … } main()` wrapper.
- File-purpose documentation lives in `README.md` ("What each file does" table), **not** in top-of-file header
  comment blocks — keep source files lean.
