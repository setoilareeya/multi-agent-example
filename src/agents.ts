// ============================================================================
// agents.ts — โมดูลกลาง: นิยาม "เจ้าต่างๆ" + ตัวเรียก Agent CLI จริงแบบ headless
//   ใช้ร่วมกันทั้ง CLI demo (send-to-each.ts, orchestrate.ts) และ web (server.ts)
//
//   ทุก agent มี "ชื่อเล่น" (persona) แล้ว map ไปยัง CLI จริง:
//     Athena  -> claude   (claude -p ... --output-format json)      [orchestrator]
//     Orion   -> codex    (codex exec --json --skip-git-repo-check) [worker]
//     Luna    -> opencode (opencode run ...)                        [worker]
//     Atlas   -> agy      (agy --print ...)                         [worker]
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';

export type AgentKey = 'athena' | 'orion' | 'luna' | 'atlas';

export interface AgentDef {
  key: AgentKey;
  name: string;
  emoji: string;
  role: 'orchestrator' | 'worker';
  cli: string;       // ชื่อคำสั่งจริงบนเครื่อง
  model: string;     // ชื่อ product ของ CLI นั้น
  color: string;     // สี hex สำหรับหน้าเว็บ
  tagline: string;
  cmd: string;       // ตัวอย่างคำสั่ง headless (ไว้โชว์)
}

export interface AgentAnswer {
  ok: boolean;
  text: string;
  cost?: number;     // เฉพาะ Athena/Claude ที่คืน total_cost_usd
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

export const isInstalled = (cli: string): boolean => {
  try { return spawnSync('which', [cli]).status === 0; } catch { return false; }
};

// รัน CLI ตัวหนึ่งแบบ headless แล้วคืน stdout ทั้งหมด (มี timeout + จับ ENOENT)
// เก็บ output เป็น Buffer ก่อนแล้ว concat ตอนจบ — กัน multibyte UTF-8 (อักษรไทย)
// ถูกตัดคร่อม data chunk จนกลายเป็นตัว replacement (�)
export function runCLI(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

// ---------- ตัวเรียก agent แต่ละเจ้า (คืน {ok, text, cost?, error?}) ----------

// Athena = Claude Code -> stdout เป็น JSON ก้อนเดียว, ดึง .result + .total_cost_usd
export async function askAthena(prompt: string): Promise<AgentAnswer> {
  const r = await runCLI('claude', ['-p', prompt, '--output-format', 'json']);
  if (r.error === 'not_installed') return { ok: false, text: '', error: 'not_installed' };
  try {
    const j = JSON.parse(r.stdout.trim());
    return { ok: true, text: String(j.result || '').trim(), cost: j.total_cost_usd || 0 };
  } catch {
    return { ok: r.ok, text: r.stdout.trim(), cost: 0, error: r.ok ? undefined : (r.error || 'parse_error') };
  }
}

// Orion = Codex -> JSONL ทีละ event, เอา agent_message "ก้อนสุดท้าย" ทั้งก้อน
function parseCodex(stdout: string): string {
  let last = '';
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const ev = JSON.parse(s);
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') last = ev.item.text || '';
    } catch { /* บรรทัดที่ไม่ใช่ JSON — ข้าม */ }
  }
  return last.trim();
}
export async function askOrion(prompt: string): Promise<AgentAnswer> {
  const r = await runCLI('codex', ['exec', '--json', '--skip-git-repo-check', prompt]);
  if (r.error === 'not_installed') return { ok: false, text: '', error: 'not_installed' };
  const text = parseCodex(r.stdout);
  return { ok: !!text, text, error: text ? undefined : (r.error || 'no_output') };
}

// Luna = OpenCode -> stdout ล้วน (ตัด ANSI + บรรทัด header "> build · ..." + ช่องว่างนำหน้า)
export async function askLuna(prompt: string): Promise<AgentAnswer> {
  const r = await runCLI('opencode', ['run', prompt]);
  if (r.error === 'not_installed') return { ok: false, text: '', error: 'not_installed' };
  const text = stripAnsi(r.stdout)
    .split('\n')
    .filter((l) => !/^\s*>\s/.test(l))
    .join('\n')
    .replace(/^\s+/, '')
    .trim();
  return { ok: !!text, text, error: text ? undefined : (r.error || 'no_output') };
}

// Atlas = Antigravity (agy) -> stdout ล้วน (ตัด ANSI)
export async function askAtlas(prompt: string): Promise<AgentAnswer> {
  const r = await runCLI('agy', ['--print', prompt]);
  if (r.error === 'not_installed') return { ok: false, text: '', error: 'not_installed' };
  const text = stripAnsi(r.stdout).trim();
  return { ok: !!text, text, error: text ? undefined : (r.error || 'no_output') };
}

export const RUNNERS: Record<AgentKey, (p: string) => Promise<AgentAnswer>> = {
  athena: askAthena, orion: askOrion, luna: askLuna, atlas: askAtlas,
};

// แปลงผลวางแผนของ Athena (คาดว่าเป็น JSON array) ให้เป็น subtask 3 อันเสมอ
export function parsePlan(resultText: string, question: string): string[] {
  const s = (resultText || '').trim().replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
  let tasks: string[] = [];
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) tasks = arr.map(String);
  } catch { /* ไม่ใช่ JSON — ไปใช้ fallback แยกบรรทัด */ }
  if (tasks.length < 3) {
    tasks = s.split('\n')
      .map((l) => l.replace(/^\s*([0-9]+[.)]|[-*•])\s*/, '').trim())
      .filter(Boolean);
  }
  while (tasks.length < 3) tasks.push(`${question} (มุมที่ ${tasks.length + 1})`);
  return tasks.slice(0, 3);
}

// ข้อความอธิบาย error code ให้อ่านง่าย
export function reasonText(error?: string): string {
  if (error === 'not_installed') return 'ยังไม่ได้ติดตั้ง CLI';
  if (error === 'timeout') return 'หมดเวลา (timeout)';
  return 'ไม่มีผลลัพธ์';
}
