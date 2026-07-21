import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AGENTS, WORKERS, ORCHESTRATOR, DEFAULT_Q, isInstalled,
  askAthena, RUNNERS, parsePlan, reasonText, routeToWorker, runClaudeHive,
  type AgentKey, type AgentDef, type AgentAnswer,
} from './agents.ts';

// support both Node and Bun — detect the runtime once
const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
const RUNTIME = IS_BUN ? 'Bun' : 'Node';

// silence the stripTypeScriptTypes ExperimentalWarning (Node only, keeps the log clean)
const origEmitWarning = process.emitWarning;
process.emitWarning = function (warning: string | Error, ...rest: unknown[]): void {
  const msg = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (typeof msg === 'string' && msg.includes('stripTypeScriptTypes')) return;
  (origEmitWarning as Function).apply(process, [warning, ...rest]);
} as typeof process.emitWarning;

// transpile TypeScript -> JS for the browser (the frontend is written in TS), on either runtime
//   Bun  : uses the built-in Bun.Transpiler
//   Node : uses the built-in module.stripTypeScriptTypes
async function tsToBrowserJs(src: string): Promise<string> {
  const bun = (globalThis as { Bun?: { Transpiler: new (o: { loader: string }) => { transformSync(s: string): string } } }).Bun;
  if (bun) return new bun.Transpiler({ loader: 'ts' }).transformSync(src);
  const { stripTypeScriptTypes } = await import('node:module');
  return stripTypeScriptTypes(src, { mode: 'strip' });
}

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public');

type Json = Record<string, unknown>;
type Send = (obj: Json) => void;

// roster with each CLI's installed status
function roster(): Record<AgentKey, AgentDef & { installed: boolean }> {
  const out = {} as Record<AgentKey, AgentDef & { installed: boolean }>;
  for (const k of Object.keys(AGENTS) as AgentKey[]) {
    out[k] = { ...AGENTS[k], installed: isInstalled(AGENTS[k].cli) };
  }
  return out;
}

// ── main orchestration: emit SSE events step by step ──
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

  // ── 3) WORKING (parallel) ──
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

// ── routing flow (RPG mode): Athena picks ONE worker, that worker runs the quest,
//    then Athena summarizes its report into the final verdict ──
async function questRoute(question: string, send: Send): Promise<void> {
  send({ type: 'quest_start', question, agents: roster(), workers: WORKERS, orchestrator: ORCHESTRATOR });

  // 1) ASSESS — the guild master sizes up the quest
  send({ type: 'phase', phase: 'assess', label: 'ประเมินเควส' });
  send({ type: 'agent_status', agent: 'athena', status: 'thinking', detail: 'หัวหน้ากิลด์กำลังพิเคราะห์เควส...' });
  send({ type: 'narration', from: 'athena', text: 'หัวหน้ากิลด์ Athena เพ่งมองเควส แล้วประเมินว่าใครในปาร์ตี้เหมาะที่สุด...' });

  const pick = await routeToWorker(question);
  const chosen = pick.agent;
  const hero = AGENTS[chosen];

  // 2) CHOOSE — announce the chosen adventurer, bench the rest
  send({ type: 'phase', phase: 'choose', label: 'เลือกผู้กล้า' });
  send({ type: 'decision', agent: chosen, reason: pick.reason, title: pick.title, cost: pick.cost });
  send({ type: 'agent_status', agent: 'athena', status: 'done' });
  send({ type: 'agent_status', agent: chosen, status: 'chosen', detail: pick.reason });
  for (const w of WORKERS) if (w !== chosen) {
    send({ type: 'agent_status', agent: w, status: 'bench', detail: 'รอเควสถัดไป' });
  }
  send({ type: 'narration', from: 'athena', text: `เลือก ${hero.emoji} ${hero.name} ให้ออกเดินทาง! — ${pick.reason}` });

  // 3) QUEST — the chosen one ventures out (real CLI call)
  send({ type: 'phase', phase: 'quest', label: 'ออกผจญภัย' });
  send({ type: 'agent_status', agent: chosen, status: 'thinking', detail: 'กำลังนั่งทำงานที่โต๊ะ...' });
  send({ type: 'narration', from: chosen, text: `${hero.emoji} ${hero.name} กลับไปที่โต๊ะ เริ่มลงมือทำ "${pick.title}"...` });

  const suffix = ' — ตอบเป็น bullet สั้นๆ 4-6 ข้อ ภาษาไทย ไม่ต้องเกริ่นนำ';
  const start = Date.now();
  const res: AgentAnswer = await RUNNERS[chosen](question + suffix);
  const elapsed = Date.now() - start;

  // 4) REPORT — the adventurer returns
  send({ type: 'phase', phase: 'report', label: 'รายงานผล' });
  let report = '';
  if (res.ok && res.text) {
    report = res.text;
    send({ type: 'finding', agent: chosen, text: report, elapsed });
    send({ type: 'agent_status', agent: chosen, status: 'done', elapsed });
    send({ type: 'narration', from: chosen, text: `${hero.emoji} ${hero.name} เดินมารายงานผลให้หัวหน้ากิลด์!` });
  } else {
    const why = reasonText(res.error);
    send({ type: 'finding', agent: chosen, text: `(${why})`, elapsed, error: true });
    send({ type: 'agent_status', agent: chosen, status: 'error', detail: why, elapsed });
    send({ type: 'narration', from: chosen, text: `${hero.emoji} ${hero.name} กลับมามือเปล่า — ${why}`, error: true });
  }

  // 5) VERDICT — the guild master turns the report into the final answer
  send({ type: 'phase', phase: 'verdict', label: 'บทสรุปหัวหน้า' });
  send({ type: 'agent_status', agent: 'athena', status: 'thinking', detail: 'สรุปผลให้ผู้ว่าจ้าง...' });

  let verdict = report;
  let verdictCost = 0;
  if (report) {
    const summaryPrompt =
      `นักผจญภัย ${hero.name} กลับมาจากเควสพร้อมรายงานนี้:\n"""${report}"""\n\n` +
      `ในฐานะหัวหน้ากิลด์ สรุปให้ผู้ว่าจ้างเข้าใจง่าย ตอบโจทย์ '${question}'. ` +
      `สรุปเป็น bullet ไม่เกิน 5 ข้อ + ปิดท้ายด้วยบรรทัดสรุป 1 ประโยค.`;
    const s = await askAthena(summaryPrompt);
    if (s.ok && s.text) { verdict = s.text; verdictCost = s.cost || 0; }
  } else {
    verdict = 'เควสนี้ยังไม่มีผู้กล้าที่พร้อมออกเดินทาง — ลองติดตั้ง/ล็อกอิน CLI ของนักผจญภัยแล้วรับเควสอีกครั้ง';
  }
  send({ type: 'verdict', text: verdict, by: 'athena', chosen, cost: verdictCost });
  send({ type: 'agent_status', agent: 'athena', status: 'done' });

  // done
  send({ type: 'cost', assess: pick.cost, verdict: verdictCost, total: pick.cost + verdictCost });
  send({ type: 'done' });
}

// ── hive flow (self-delegation): ONE `claude -p` call; Claude Code spawns its own
//    sub-agents via the Task tool, and we surface each spawn/result over SSE ──
async function hive(question: string, send: Send): Promise<void> {
  send({ type: 'run_start', question });
  send({ type: 'phase', phase: 'plan' });
  send({ type: 'main_status', status: 'thinking' });

  const prompt =
    `คุณคือหัวหน้าทีมวิจัย และมีสิทธิ์เรียก Task tool เพื่อ spawn sub-agent ของตัวเองได้. ` +
    `แตกโจทย์นี้ออกเป็น 3 มุมมองย่อย แล้ว "ใช้ Task tool กระจายงานให้ sub-agent (subagent_type: \"researcher\" หรือ \"general-purpose\") ` +
    `ทำขนานกัน 3 ตัว" ตัวละ 1 มุม. เมื่อได้ผลครบ ให้สังเคราะห์เป็นคำตอบภาษาไทยที่กระชับ: ` +
    `bullet ไม่เกิน 6 ข้อ + ปิดท้ายด้วยข้อสรุป 1 บรรทัด. โจทย์: ${question}`;

  let spawnCount = 0;
  let delegated = false;
  await runClaudeHive(prompt, {
    onText: (text) => send({ type: 'main_text', kind: delegated ? 'synthesis' : 'plan', text }),
    onSpawn: (id, subType, task) => {
      if (!delegated) { delegated = true; send({ type: 'phase', phase: 'delegate' }); }
      send({ type: 'spawn', id, subagent_type: subType, task, index: spawnCount++ });
      send({ type: 'phase', phase: 'work' });
    },
    onResult: (id, result, isError) => send({ type: 'subagent_result', id, result, error: isError }),
    onDone: (result, cost, isError) => {
      send({ type: 'phase', phase: 'synthesize' });
      if (spawnCount === 0) {
        send({ type: 'main_text', kind: 'note', text: 'Claude Code ตอบเองโดยไม่ได้ spawn sub-agent (อาจเพราะ Task tool ถูกปิดสิทธิ์ — ดูวิธีเปิดใน README)' });
      }
      send({ type: 'result', text: (isError && !result) ? 'Claude Code ทำงานไม่สำเร็จ — ดู log ฝั่ง server และหัวข้อ permission ใน README' : (result || '(ไม่มีผลลัพธ์)') });
      send({ type: 'cost', total: cost });
    },
    onError: (msg) => send({ type: 'main_text', kind: 'error', text: 'claude error: ' + msg }),
  });

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

// open an SSE stream, run `flow`, and always close cleanly (shared by both demos)
function startSSE(req: http.IncomingMessage, res: http.ServerResponse, flow: (send: Send) => Promise<void>): Promise<void> {
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
  return flow(send)
    .catch((e) => send({ type: 'error', message: String((e as Error)?.stack || e) }))
    .finally(() => { if (!closed) res.end(); });
}

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // any /<name>.js is transpiled on the fly from public/<name>.ts (Node/Bun) — no build step
  if (/^\/[\w-]+\.js$/.test(u.pathname)) {
    const tsPath = path.join(PUBLIC_DIR, u.pathname.replace(/\.js$/, '.ts'));
    if (tsPath.startsWith(PUBLIC_DIR)) {
      try {
        const src = await readFile(tsPath, 'utf8');
        const js = await tsToBrowserJs(src);
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(js);
        return;
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {   // a real transpile error (not just a missing .ts twin)
          res.writeHead(500, { 'Content-Type': 'text/javascript; charset=utf-8' });
          res.end(`console.error(${JSON.stringify('compile error: ' + String(e))});`);
          return;
        }
        // no matching .ts — fall through to static serving (maybe a real .js file)
      }
    }
  }

  if (u.pathname === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ agents: roster(), workers: WORKERS, orchestrator: ORCHESTRATOR, defaultQuestion: DEFAULT_Q }));
    return;
  }

  // both demos stream over SSE: /api/run = parallel fan-out, /api/quest = single-worker routing (RPG)
  if (u.pathname === '/api/run') {
    const q = (u.searchParams.get('q') || '').trim() || DEFAULT_Q;
    await startSSE(req, res, (send) => orchestrate(q, send));
    return;
  }

  if (u.pathname === '/api/quest') {
    const q = (u.searchParams.get('q') || '').trim() || DEFAULT_Q;
    await startSSE(req, res, (send) => questRoute(q, send));
    return;
  }

  // /api/hive = self-delegation: one `claude -p` call that spawns its own sub-agents
  if (u.pathname === '/api/hive') {
    const q = (u.searchParams.get('q') || '').trim() || DEFAULT_Q;
    await startSSE(req, res, (send) => hive(q, send));
    return;
  }

  await serveStatic(res, u.pathname);
});

server.listen(PORT, () => {
  const line = Object.values(AGENTS)
    .map((a) => `${a.emoji} ${a.name}(${a.cli}${isInstalled(a.cli) ? '' : ' ✗ไม่พบ'})`)
    .join('  ');
  console.log(`\n  🧠 multi-agent web  →  http://localhost:${PORT}   (runtime: ${RUNTIME})\n  agents: ${line}\n`);
});
