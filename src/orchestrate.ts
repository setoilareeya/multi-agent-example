// ============================================================================
// orchestrate.ts  —  "AI สั่ง AI" ตัวจริง (orchestrator-worker) ในแบบ Node/TS
//
//   Athena (Claude) รับโจทย์ → แตกเป็น 3 subtask → กระจายให้
//   Orion (Codex) / Luna (OpenCode) / Atlas (Antigravity) ทำ "ขนานกัน" →
//   ทยอยส่ง finding กลับ → Athena สังเคราะห์เป็นคำตอบเดียว
//
//   รัน:  node src/orchestrate.ts "โจทย์ที่อยาก research"
// ============================================================================
import {
  AGENTS, WORKERS, DEFAULT_Q, askAthena, RUNNERS, parsePlan, reasonText,
  type AgentKey, type AgentAnswer,
} from './agents.ts';
import { raw, paint, AGENT_COLOR, banner, showCmd, indent } from './ansi.ts';

const question = process.argv[2] || DEFAULT_Q;
const WORKER_SUFFIX = ' — ตอบเป็น bullet สั้นๆ 3-4 ข้อ ภาษาไทย ไม่ต้องเกริ่นนำ';

// ── STEP 1: Athena วางแผน แตกโจทย์เป็น 3 subtask ────────────────────────────
async function plan(): Promise<{ tasks: string[]; cost: number }> {
  console.log(`\n${raw.magenta}${raw.bold}[1/4] Athena (Claude) กำลังวางแผน...${raw.reset}`);
  showCmd('claude -p "แตกโจทย์เป็น 3 subtask (JSON array)" --output-format json');

  const prompt =
    `แตกโจทย์นี้ออกเป็น subtask สำหรับ research แบบขนาน 3 อัน. ` +
    `ตอบกลับเป็น JSON array ของ string 3 อันเท่านั้น ` +
    `(ภาษาไทย สั้น กระชับ ไม่มีเลขนำหน้า ห้ามมี markdown fence). โจทย์: ${question}`;

  const res = await askAthena(prompt);
  const tasks = parsePlan(res.text, question);
  console.log(`  ${paint('green', '✓ แตกได้ 3 subtask')}  ${raw.dim}($${(res.cost || 0).toFixed(4)})${raw.reset}`);
  return { tasks, cost: res.cost || 0 };
}

// ── STEP 2+3: มอบหมาย + ยิง worker ขนานกัน (พร้อม spinner) ───────────────────
async function dispatch(tasks: string[]): Promise<Record<AgentKey, AgentAnswer>> {
  console.log(`\n${raw.yellow}${raw.bold}[2/4] มอบหมายงาน → กระจายให้ worker ทำขนานกัน${raw.reset}`);
  WORKERS.forEach((w, i) => {
    const a = AGENTS[w];
    console.log(`  ${raw[AGENT_COLOR[w]]}${raw.bold}${a.name.padEnd(7)}${raw.reset} → ${tasks[i]}`);
  });
  showCmd('codex exec ... &   opencode run ... &   agy --print ...   (Promise.all)');

  console.log(`\n${raw.green}${raw.bold}[3/4] worker กำลังทำงาน...${raw.reset}`);

  // ยิงทั้ง 3 เจ้าพร้อมกันด้วย Promise.all — ใครเสร็จก่อนก็ mark ก่อน
  const running = new Set<AgentKey>(WORKERS);
  const started = Date.now();
  const results = {} as Record<AgentKey, AgentAnswer>;

  const jobs = WORKERS.map(async (w, i) => {
    results[w] = await RUNNERS[w](tasks[i] + WORKER_SUFFIX);
    running.delete(w);
  });

  // spinner: วาดบรรทัดเดียวโชว์ว่าใครยังวิ่งอยู่ (เฉพาะตอนต่อ terminal)
  const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  let frame = 0;
  const timer = setInterval(() => {
    if (!process.stdout.isTTY) return;
    const names = [...running].map((w) => raw[AGENT_COLOR[w]] + AGENTS[w].name + raw.reset).join(' ');
    const secs = Math.floor((Date.now() - started) / 1000);
    process.stdout.write(`\r  ${raw.green}${spin[frame++ % spin.length]}${raw.reset}  กำลังรอ: ${names}  (${secs}s)   `);
  }, 120);

  await Promise.all(jobs);
  clearInterval(timer);
  const total = Math.floor((Date.now() - started) / 1000);
  process.stdout.write(`\r  ${paint('green', '✓ worker ทั้งหมดเสร็จแล้ว')}  (${total}s)${' '.repeat(20)}\n`);

  // โชว์ finding ของแต่ละเจ้า
  for (const w of WORKERS) {
    const a = AGENTS[w];
    const color = AGENT_COLOR[w];
    const res = results[w];
    console.log(`\n${raw[color]}▎ ${raw.bold}${a.name}${raw.reset}${raw[color]} ส่ง finding กลับ:${raw.reset}`);
    if (res.ok && res.text) console.log(indent(res.text, raw[color] + '│' + raw.reset));
    else console.log(`  ${paint('yellow', '(' + reasonText(res.error) + ')')}`);
  }
  return results;
}

// ── STEP 4: Athena สังเคราะห์ finding ทั้งหมด ───────────────────────────────
async function synthesize(results: Record<AgentKey, AgentAnswer>): Promise<{ text: string; cost: number }> {
  console.log(`\n${raw.magenta}${raw.bold}[4/4] Athena (Claude) กำลังสังเคราะห์ finding ทั้งหมด...${raw.reset}`);
  showCmd('cat findings | claude -p "รวมเป็นคำตอบเดียว" --output-format json');

  const prompt =
    `รวม finding จาก 3 research agent ต่อไปนี้ให้เป็นคำตอบเดียวที่กระชับ อ่านง่าย ตอบโจทย์ '${question}'. ` +
    `สรุปเป็น bullet ไม่เกิน 6 ข้อ + ปิดท้ายด้วยข้อสรุป 1 บรรทัด.\n\n` +
    `[Orion / Codex]\n${results.orion?.text || '-'}\n\n` +
    `[Luna / OpenCode]\n${results.luna?.text || '-'}\n\n` +
    `[Atlas / Antigravity]\n${results.atlas?.text || '-'}`;

  const res = await askAthena(prompt);
  return { text: res.text || '<ไม่มีผลลัพธ์>', cost: res.cost || 0 };
}

// ── main flow ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  banner('🧠 AI สั่ง AI — orchestrator-worker (เรียก CLI จริง)');
  console.log(`  ${raw.bold}โจทย์:${raw.reset} ${question}`);

  const { tasks, cost: planCost } = await plan();
  const results = await dispatch(tasks);
  const { text: final, cost: synthCost } = await synthesize(results);

  banner('✅ คำตอบสุดท้าย (สังเคราะห์โดย Athena)');
  console.log(indent(final, ' '));

  console.log(`\n${raw.dim}─────────────────────────────────────────────${raw.reset}`);
  console.log(`${raw.dim}💰 ค่า Claude (plan+synthesis): $${planCost.toFixed(4)} + $${synthCost.toFixed(4)} = $${(planCost + synthCost).toFixed(4)}${raw.reset}`);
  console.log(`${raw.dim}   (ยังไม่รวม token ของ Orion/Luna/Atlas — worker คิดเงินฝั่งเจ้าของ CLI นั้นๆ)${raw.reset}\n`);
}

main();
