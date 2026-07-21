import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

export type AgentKey = 'athena' | 'orion' | 'luna' | 'atlas';

export interface AgentDef {
  key: AgentKey;
  name: string;
  emoji: string;
  role: 'orchestrator' | 'worker';
  cli: string;       // actual command name on the machine
  model: string;     // product name of that CLI
  color: string;     // hex color for the web UI
  tagline: string;
  cmd: string;       // example headless command (for display)
}

export interface AgentAnswer {
  ok: boolean;
  text: string;
  cost?: number;     // only Athena/Claude returns total_cost_usd
  error?: string;    // not_installed | timeout | no_output | ...
}

interface RunResult {
  ok: boolean;
  code?: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export const AGENTS: Record<AgentKey, AgentDef> = {
  athena: {
    key: 'athena', name: 'Athena', emoji: '🦉', role: 'orchestrator',
    cli: 'claude', model: 'Claude Code', color: '#b191ff',
    tagline: 'หัวหน้าทีม — วางแผน & สังเคราะห์',
    cmd: 'claude -p "<prompt>" --output-format json',
  },
  orion: {
    key: 'orion', name: 'Orion', emoji: '🔭', role: 'worker',
    cli: 'codex', model: 'Codex', color: '#5aa2ff',
    tagline: 'นักสำรวจ — ค้นเร็ว',
    cmd: 'codex exec --json --skip-git-repo-check "<task>"',
  },
  luna: {
    key: 'luna', name: 'Luna', emoji: '🌙', role: 'worker',
    cli: 'opencode', model: 'OpenCode', color: '#2fd9e6',
    tagline: 'นักวิเคราะห์ — เจาะลึก',
    cmd: 'opencode run "<task>"',
  },
  atlas: {
    key: 'atlas', name: 'Atlas', emoji: '🗺️', role: 'worker',
    cli: 'agy', model: 'Antigravity', color: '#fbbf3f',
    tagline: 'นักค้นข้อมูล — รอบด้าน',
    cmd: 'agy --print "<task>"',
  },
};

export const WORKERS: AgentKey[] = ['orion', 'luna', 'atlas'];
export const ORCHESTRATOR: AgentKey = 'athena';
export const DEFAULT_Q =
  'เปรียบเทียบ REST vs GraphQL vs gRPC สำหรับงาน backend ปี 2026 ควรเลือกอันไหนตอนไหน';

const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 180_000);

// ---------- utils ----------
export const stripAnsi = (s: string): string =>
  s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');

// find a CLI's absolute path on PATH (an executable file), or null — no spawning `which`,
// and callers spawn the absolute path (deterministic; not a PATH-searched command name)
export function resolveBin(cli: string): string | null {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const full = path.join(d, cli);
    try {
      const st = statSync(full);
      if (st.isFile() && (st.mode & 0o111) !== 0) return full;   // real file with an execute bit
    } catch { /* not in this dir — keep scanning */ }
  }
  return null;
}
export const isInstalled = (cli: string): boolean => resolveBin(cli) !== null;

// Run one CLI headless and return all of stdout (with timeout + ENOENT handling).
// Buffer the chunks and concat at the end — prevents multibyte UTF-8 (Thai) from
// being split across data chunks and turning into replacement chars (�).
export function runCLI(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const bin = resolveBin(cmd);
    if (!bin) { resolve({ ok: false, stdout: '', stderr: '', error: 'not_installed' }); return; }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: String(e), error: 'spawn_failed' });
      return;
    }
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let done = false;
    const decode = (chunks: Buffer[]): string => Buffer.concat(chunks).toString('utf8');
    const finish = (r: RunResult): void => {
      if (done) return;
      done = true; clearTimeout(timer); resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ ok: false, stdout: decode(outChunks), stderr: decode(errChunks), error: 'timeout' });
    }, AGENT_TIMEOUT_MS);
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish({
        ok: false, stdout: decode(outChunks), stderr: String(e),
        error: e.code === 'ENOENT' ? 'not_installed' : 'spawn_error',
      }));
    child.stdout!.on('data', (d: Buffer) => outChunks.push(d));
    child.stderr!.on('data', (d: Buffer) => errChunks.push(d));
    child.on('close', (code) =>
      finish({ ok: code === 0, code: code ?? undefined, stdout: decode(outChunks), stderr: decode(errChunks) }));
  });
}

// ---------- per-agent callers (return {ok, text, cost?, error?}) ----------

// the EXACT argv each agent runs — one source of truth for running AND for display
export function buildCmd(key: AgentKey, prompt: string): { cmd: string; args: string[] } {
  const cmd = AGENTS[key].cli;
  switch (key) {
    case 'athena': return { cmd, args: ['-p', prompt, '--output-format', 'json'] };
    case 'orion':  return { cmd, args: ['exec', '--json', '--skip-git-repo-check', prompt] };
    case 'luna':   return { cmd, args: ['run', prompt] };
    case 'atlas':  return { cmd, args: ['--print', prompt] };
  }
}

// Athena = Claude Code -> stdout is a single JSON blob; pull .result + .total_cost_usd
export async function askAthena(prompt: string): Promise<AgentAnswer> {
  const { cmd, args } = buildCmd('athena', prompt);
  const r = await runCLI(cmd, args);
  if (r.error === 'not_installed') return { ok: false, text: '', error: 'not_installed' };
  try {
    const j = JSON.parse(r.stdout.trim());
    return { ok: true, text: String(j.result || '').trim(), cost: j.total_cost_usd || 0 };
  } catch {
    return { ok: r.ok, text: r.stdout.trim(), cost: 0, error: r.ok ? undefined : (r.error || 'parse_error') };
  }
}

// Orion = Codex -> one JSONL event per line; take the whole last agent_message
function parseCodex(stdout: string): string {
  let last = '';
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const ev = JSON.parse(s);
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') last = ev.item.text || '';
    } catch { /* non-JSON line — skip */ }
  }
  return last.trim();
}
export async function askOrion(prompt: string): Promise<AgentAnswer> {
  const { cmd, args } = buildCmd('orion', prompt);
  const r = await runCLI(cmd, args);
  if (r.error === 'not_installed') return { ok: false, text: '', error: 'not_installed' };
  const text = parseCodex(r.stdout);
  return { ok: !!text, text, error: text ? undefined : (r.error || 'no_output') };
}

// Luna = OpenCode -> plain stdout (strip ANSI + the "> build · ..." header line + leading whitespace)
export async function askLuna(prompt: string): Promise<AgentAnswer> {
  const { cmd, args } = buildCmd('luna', prompt);
  const r = await runCLI(cmd, args);
  if (r.error === 'not_installed') return { ok: false, text: '', error: 'not_installed' };
  const text = stripAnsi(r.stdout)
    .split('\n')
    .filter((l) => !/^\s*>\s/.test(l))
    .join('\n')
    .replace(/^\s+/, '')
    .trim();
  return { ok: !!text, text, error: text ? undefined : (r.error || 'no_output') };
}

// Atlas = Antigravity (agy) -> plain stdout (strip ANSI)
export async function askAtlas(prompt: string): Promise<AgentAnswer> {
  const { cmd, args } = buildCmd('atlas', prompt);
  const r = await runCLI(cmd, args);
  if (r.error === 'not_installed') return { ok: false, text: '', error: 'not_installed' };
  const text = stripAnsi(r.stdout).trim();
  return { ok: !!text, text, error: text ? undefined : (r.error || 'no_output') };
}

export const RUNNERS: Record<AgentKey, (p: string) => Promise<AgentAnswer>> = {
  athena: askAthena, orion: askOrion, luna: askLuna, atlas: askAtlas,
};

// Turn Athena's plan output (expected to be a JSON array) into exactly 3 subtasks
export function parsePlan(resultText: string, question: string): string[] {
  const s = (resultText || '').trim().replace(/```[a-z]*\n?/gi, '').replaceAll('```', '').trim();
  let tasks: string[] = [];
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) tasks = arr.map(String);
  } catch { /* not JSON — fall back to splitting by line */ }
  if (tasks.length < 3) {
    tasks = s.split('\n')
      .map((l) => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').trim())
      .filter(Boolean);
  }
  while (tasks.length < 3) tasks.push(`${question} (มุมที่ ${tasks.length + 1})`);
  return tasks.slice(0, 3);
}

// human-readable text for each error code
export function reasonText(error?: string): string {
  if (error === 'not_installed') return 'ยังไม่ได้ติดตั้ง CLI';
  if (error === 'timeout') return 'หมดเวลา (timeout)';
  return 'ไม่มีผลลัพธ์';
}

// ── routing (RPG mode): Athena picks the ONE best-fit worker for a quest ──

export interface Pick {
  agent: AgentKey;   // the chosen worker
  reason: string;    // why it was chosen (short Thai)
  title: string;     // flavor quest title
  cost: number;      // Claude cost of the routing call
}

// Parse Athena's routing reply (expected JSON {agent, reason, title}) into a Pick.
// Falls back to a keyword scan, then returns null so the caller can auto-assign.
export function parsePick(text: string, workers: AgentKey[]): Omit<Pick, 'cost'> | null {
  const s = (text || '').replace(/```[a-z]*/gi, '').trim();
  if (!s) return null;
  // slice out the {...} block by braces (no backtracking regex needed)
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      const obj = JSON.parse(s.slice(first, last + 1)) as { agent?: string; reason?: string; title?: string };
      const agent = String(obj.agent || '').toLowerCase() as AgentKey;
      if (workers.includes(agent)) {
        return {
          agent,
          reason: String(obj.reason || '').trim() || 'เหมาะกับเควสนี้ที่สุด',
          title: String(obj.title || '').trim() || 'ภารกิจปริศนา',
        };
      }
    } catch { /* not valid JSON — fall through to keyword scan */ }
  }
  const lower = s.toLowerCase();
  for (const w of workers) {
    if (lower.includes(w) || s.includes(AGENTS[w].name)) {
      return { agent: w, reason: 'เหมาะกับเควสนี้ที่สุด', title: 'ภารกิจปริศนา' };
    }
  }
  return null;
}

// Ask Athena (the guild master) to route the quest to a single best-fit worker.
// If Claude is unavailable, auto-assign the first installed worker so the demo still runs.
export async function routeToWorker(question: string): Promise<Pick> {
  const party = WORKERS
    .map((w) => `- ${w} (${AGENTS[w].emoji} ${AGENTS[w].name} / ${AGENTS[w].cli}): ${AGENTS[w].tagline}`)
    .join('\n');
  const prompt =
    `คุณคือ "หัวหน้ากิลด์" ต้องเลือกนักผจญภัยเพียง 1 คนที่เหมาะกับเควสนี้ที่สุด.\n` +
    `เควส: "${question}"\n` +
    `ปาร์ตี้ที่มี:\n${party}\n\n` +
    `ตอบกลับเป็น JSON ก้อนเดียวเท่านั้น ห้ามมี markdown fence:\n` +
    `{"agent":"${WORKERS.join('|')}","reason":"เหตุผลสั้นๆ ภาษาไทย 1 ประโยค","title":"ชื่อฉายาเควสเท่ๆ ภาษาไทยสั้นๆ"}`;
  const res = await askAthena(prompt);
  const picked = parsePick(res.text, WORKERS);
  if (!picked) {
    const fallback = WORKERS.find((w) => isInstalled(AGENTS[w].cli)) || WORKERS[0];
    return { agent: fallback, reason: 'หัวหน้ากิลด์ไม่ว่าง — มอบหมายให้โดยอัตโนมัติ', title: 'เควสเร่งด่วน', cost: res.cost || 0 };
  }
  return { ...picked, cost: res.cost || 0 };
}

// ── self-delegation (Hive mode): run `claude -p` in stream-json and surface when
//    Claude Code spawns its OWN sub-agents (the Task/Agent tool). The NDJSON schema
//    is not officially documented, so parse defensively (tolerate both shapes). ──

export interface HiveHandlers {
  onText?: (text: string) => void;                                   // main agent text block
  onSpawn?: (id: string, subagentType: string, task: string) => void; // a sub-agent was spawned
  onResult?: (id: string, result: string, isError: boolean) => void;  // that sub-agent returned
  onDone?: (result: string, cost: number, isError: boolean) => void;  // final result line
  onError?: (msg: string) => void;
}

interface StreamBlock {
  type?: string; text?: string;
  id?: string; name?: string;
  input?: { subagent_type?: string; type?: string; prompt?: string; description?: string };
  tool_use_id?: string; parent_tool_use_id?: string; is_error?: boolean; content?: unknown;
}
interface StreamObj {
  type?: string;
  message?: { content?: StreamBlock[] };
  content?: StreamBlock[];
  total_cost_usd?: number; result?: string; is_error?: boolean;
}

const isDelegation = (b: StreamBlock): boolean => {
  const name = (b.name || '').toLowerCase();
  return name === 'task' || name === 'agent';
};
const blockText = (content: unknown): string => {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : (c as { text?: string })?.text || '')).join('\n').trim();
  if (content && typeof content === 'object') return ((content as { text?: string }).text || '').trim();
  return '';
};

export function runClaudeHive(prompt: string, h: HiveHandlers): Promise<void> {
  return new Promise((resolve) => {
    // tools the sub-agents may use; override with HIVE_ALLOWED_TOOLS, add flags with HIVE_CLAUDE_ARGS
    const allow = process.env.HIVE_ALLOWED_TOOLS || 'Task,Agent,WebSearch,WebFetch,Read,Grep,Glob';
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--allowedTools', allow];
    const extra = (process.env.HIVE_CLAUDE_ARGS || '').trim();
    if (extra) args.push(...extra.split(/\s+/));

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };

    const bin = resolveBin('claude');
    if (!bin) { h.onError?.('not_installed'); finish(); return; }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { h.onError?.('spawn_failed: ' + String(e)); finish(); return; }

    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      h.onError?.('timeout'); finish();
    }, Number(process.env.HIVE_TIMEOUT_MS || 300_000));

    const seen = new Set<string>();   // tool_use_ids that are sub-agent delegations
    const onAssistant = (blocks: StreamBlock[]): void => {
      for (const b of blocks) {
        if (b.type === 'text' && b.text?.trim()) h.onText?.(b.text.trim());
        else if (b.type === 'tool_use' && isDelegation(b)) {
          const id = String(b.id || '');
          const subType = String(b.input?.subagent_type ?? b.input?.type ?? 'sub-agent');
          const task = String(b.input?.description ?? b.input?.prompt ?? '').trim();
          seen.add(id);
          h.onSpawn?.(id, subType, task);
        }
      }
    };
    const onUser = (blocks: StreamBlock[]): void => {
      for (const b of blocks) {
        if (b.type !== 'tool_result') continue;
        const id = String(b.tool_use_id ?? b.parent_tool_use_id ?? '');
        if (seen.has(id)) h.onResult?.(id, blockText(b.content), b.is_error === true);
      }
    };
    const onObj = (o: StreamObj): void => {
      const raw = o.message?.content ?? o.content ?? [];
      const blocks = Array.isArray(raw) ? raw : [];
      if (o.type === 'assistant') onAssistant(blocks);
      else if (o.type === 'user') onUser(blocks);
      else if (o.type === 'result') h.onDone?.(String(o.result ?? ''), Number(o.total_cost_usd || 0), o.is_error === true);
    };

    let buf = '';   // carry partial lines across chunks (setEncoding handles multibyte UTF-8)
    const pump = (chunk: string): void => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) { try { onObj(JSON.parse(line) as StreamObj); } catch { /* non-JSON line — ignore */ } }
        nl = buf.indexOf('\n');
      }
    };

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => pump(d));
    child.on('error', (e: NodeJS.ErrnoException) => { h.onError?.(e.code === 'ENOENT' ? 'not_installed' : String(e)); finish(); });
    child.on('close', () => {
      const last = buf.trim();
      if (last) { try { onObj(JSON.parse(last) as StreamObj); } catch { /* ignore */ } }
      finish();
    });
  });
}
