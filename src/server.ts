// ============================================================================
// server.ts — backend ของ "เว็บให้ agent คุยกัน" (เรียก Agent CLI จริง)
//
//   - zero dependency: ใช้แค่ built-in ของ Node (http, fs, path, module)
//   - เสิร์ฟ frontend จากโฟลเดอร์ public/ ; ไฟล์ app.ts จะถูก "ตัด type" สดๆ
//     ด้วย module.stripTypeScriptTypes แล้วส่งเป็น /app.js (ไม่ต้อง build)
//   - /api/run = SSE stream: orchestrate agent จริงแบบ real-time
//        Athena(Claude) วางแผน → Orion/Luna/Atlas ทำขนาน → Athena สังเคราะห์
//
//   รัน:  node src/server.ts   (หรือ PORT=5000 node src/server.ts)
// ============================================================================
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import {
  AGENTS, WORKERS, ORCHESTRATOR, DEFAULT_Q, isInstalled,
  askAthena, RUNNERS, parsePlan, reasonText,
  type AgentKey, type AgentDef, type AgentAnswer,
} from './agents.ts';

// เงียบ ExperimentalWarning ของ stripTypeScriptTypes (ไม่ให้รก log)
const origEmitWarning = process.emitWarning;
process.emitWarning = function (warning: string | Error, ...rest: unknown[]): void {
  const msg = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (typeof msg === 'string' && msg.includes('stripTypeScriptTypes')) return;
  (origEmitWarning as Function).apply(process, [warning, ...rest]);
} as typeof process.emitWarning;

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public');

type Json = Record<string, unknown>;
type Send = (obj: Json) => void;

// roster พร้อมสถานะว่าติดตั้ง CLI ไว้ไหม
function roster(): Record<AgentKey, AgentDef & { installed: boolean }> {
  const out = {} as Record<AgentKey, AgentDef & { installed: boolean }>;
  for (const k of Object.keys(AGENTS) as AgentKey[]) {
    out[k] = { ...AGENTS[k], installed: isInstalled(AGENTS[k].cli) };
  }
  return out;
}

// ── orchestration หลัก: ยิง SSE event ทีละสเต็ป ─────────────────────────────
async function orchestrate(question: string, send: Send): Promise<void> {
  send({ type: 'run_start', question, agents: roster(), workers: WORKERS, orchestrator: ORCHESTRATOR });

  // ── 1) PLAN ──
  send({ type: 'phase', phase: 'planning', label: 'Athena วางแผน' });
  send({ type: 'agent_status', agent: 'athena', status: 'thinking', detail: 'แตกโจทย์เป็น 3 subtask...' });
  send({ type: 'message', from: 'athena', to: 'all', kind: 'plan', text: 'รับโจทย์แล้ว กำลังแตกเป็น 3 subtask เพื่อกระจายให้ทีม' });

  const planPrompt =
    `แตกโจทย์นี้ออกเป็น subtask สำหรับ research แบบขนาน 3 อัน. ` +
    `ตอบกลับเป็น JSON array ของ string 3 อันเท่านั้น ` +
    `(ภาษาไทย สั้น กระชับ ไม่มีเลขนำหน้า ห้ามมี markdown fence). โจทย์: ${question}`;
  const plan = await askAthena(planPrompt);
  const tasks = parsePlan(plan.text, question);
  const planCost = plan.cost || 0;
  const assign = WORKERS.map((w, i) => ({ agent: w, task: tasks[i] }));
  send({ type: 'plan', assign, cost: planCost });
  send({ type: 'agent_status', agent: 'athena', status: 'idle' });

  // ── 2) DISPATCH ──
  send({ type: 'phase', phase: 'dispatch', label: 'มอบหมายงาน' });
  for (const a of assign) send({ type: 'message', from: 'athena', to: a.agent, kind: 'assign', text: a.task });

  // ── 3) WORKING (ขนาน) ──
  send({ type: 'phase', phase: 'working', label: 'worker ทำงานขนานกัน' });
  const suffix = ' — ตอบเป็น bullet สั้นๆ 3-4 ข้อ ภาษาไทย ไม่ต้องเกริ่นนำ';
  const findings: Partial<Record<AgentKey, string>> = {};

  await Promise.all(assign.map(async ({ agent, task }) => {
    send({ type: 'agent_status', agent, status: 'thinking', detail: task });
    const start = Date.now();
    const res: AgentAnswer = await RUNNERS[agent](task + suffix);
    const elapsed = Date.now() - start;
    if (res.ok && res.text) {
      findings[agent] = res.text;
      send({ type: 'finding', agent, text: res.text, elapsed });
      send({ type: 'message', from: agent, to: 'athena', kind: 'finding', text: res.text });
      send({ type: 'agent_status', agent, status: 'done', elapsed });
    } else {
      const reason = reasonText(res.error);
      findings[agent] = '';
      send({ type: 'finding', agent, text: `(${reason})`, elapsed, error: true });
      send({ type: 'message', from: agent, to: 'athena', kind: 'finding', text: `(${reason})`, error: true });
      send({ type: 'agent_status', agent, status: 'error', detail: reason, elapsed });
    }
  }));

  // ── 4) SYNTHESIS ──
  send({ type: 'phase', phase: 'synthesis', label: 'Athena สังเคราะห์' });
  send({ type: 'agent_status', agent: 'athena', status: 'thinking', detail: 'รวม finding เป็นคำตอบเดียว...' });
  send({ type: 'message', from: 'athena', to: 'all', kind: 'synthesis', text: 'ได้รับ finding จากทุกคนแล้ว กำลังสังเคราะห์เป็นคำตอบเดียว' });

  const synthPrompt =
    `รวม finding จาก 3 research agent ต่อไปนี้ให้เป็นคำตอบเดียวที่กระชับ อ่านง่าย ตอบโจทย์ '${question}'. ` +
    `สรุปเป็น bullet ไม่เกิน 6 ข้อ + ปิดท้ายด้วยข้อสรุป 1 บรรทัด.\n\n` +
    `[Orion / Codex]\n${findings.orion || '-'}\n\n` +
    `[Luna / OpenCode]\n${findings.luna || '-'}\n\n` +
    `[Atlas / Antigravity]\n${findings.atlas || '-'}`;
  const synth = await askAthena(synthPrompt);
  const synthCost = synth.cost || 0;
  send({ type: 'synthesis', text: synth.text || '(ไม่มีผลลัพธ์จากการสังเคราะห์)', cost: synthCost });
  send({ type: 'message', from: 'athena', to: 'all', kind: 'synthesis', text: synth.text || '' });
  send({ type: 'agent_status', agent: 'athena', status: 'done' });

  // ── done ──
  send({ type: 'cost', plan: planCost, synthesis: synthCost, total: planCost + synthCost });
  send({ type: 'done' });
}

// ── static file serving ──────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

async function serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // frontend เขียนด้วย TypeScript -> ตัด type สดๆ แล้วเสิร์ฟเป็น JS
  if (u.pathname === '/app.js') {
    try {
      const src = await readFile(path.join(PUBLIC_DIR, 'app.ts'), 'utf8');
      const js = stripTypeScriptTypes(src, { mode: 'strip' });
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(js);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(`console.error(${JSON.stringify('compile error: ' + String(e))});`);
    }
    return;
  }

  if (u.pathname === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ agents: roster(), workers: WORKERS, orchestrator: ORCHESTRATOR, defaultQuestion: DEFAULT_Q }));
    return;
  }

  if (u.pathname === '/api/run') {
    const q = (u.searchParams.get('q') || '').trim() || DEFAULT_Q;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    req.on('close', () => { closed = true; });
    const send: Send = (obj) => { if (!closed) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    send({ type: 'connected' });
    try { await orchestrate(q, send); }
    catch (e) { send({ type: 'error', message: String((e as Error)?.stack || e) }); }
    if (!closed) res.end();
    return;
  }

  await serveStatic(res, u.pathname);
});

server.listen(PORT, () => {
  const line = Object.values(AGENTS)
    .map((a) => `${a.emoji} ${a.name}(${a.cli}${isInstalled(a.cli) ? '' : ' ✗ไม่พบ'})`)
    .join('  ');
  console.log(`\n  🧠 multi-agent web  →  http://localhost:${PORT}\n  agents: ${line}\n`);
});
