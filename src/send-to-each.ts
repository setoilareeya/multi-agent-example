import { AGENTS, WORKERS, ORCHESTRATOR, RUNNERS, isInstalled, buildCmd, type AgentKey } from './agents.ts';
import { raw, paint, AGENT_COLOR, banner, showRun, showResponse } from './ansi.ts';

const question = process.argv[2] ||
  'อธิบายสั้นๆ ว่า idempotency ใน REST API คืออะไร ทำไมถึงสำคัญ';

// order to fire in: the orchestrator first, then all the workers
const order: AgentKey[] = [ORCHESTRATOR, ...WORKERS];

async function sendOne(key: AgentKey): Promise<void> {
  const a = AGENTS[key];
  const color = AGENT_COLOR[key];

  // 1) show who we're firing at + the REAL command (with the real query) that runs
  console.log(`\n${raw[color]}▎ ${raw.bold}${a.name}${raw.reset}  ${raw.dim}(${a.cli} · ${a.model})${raw.reset}`);
  const { cmd, args } = buildCmd(key, question);
  showRun(cmd, args);

  // 2) if that CLI isn't installed -> skip
  if (!isInstalled(a.cli)) {
    console.log(`  ${paint('red', '✗ ไม่พบ CLI นี้บนเครื่อง — ข้าม')}`);
    return;
  }

  // 3) actually fire it, then print the real response it returned
  const t0 = Date.now();
  const res = await RUNNERS[key](question);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (res.ok && res.text) {
    showResponse(res.text, color, `⏱ ${secs}s`);
  } else {
    console.log(`  ${paint('yellow', '(ไม่มีผลลัพธ์ — auth หรือ quota อาจมีปัญหา)')}`);
  }
}

// run at top level — this file is an ES module, so top-level await is fine
banner('ส่งคำสั่งเดียวกัน ไปหา 4 เจ้า ทีละตัว');
console.log(`  ${raw.bold}โจทย์:${raw.reset} ${question}`);

// fire one agent at a time, in order (not parallel — intentionally, to see each one)
for (const key of order) {
  await sendOne(key);
}

console.log(`\n${paint('green', '✓ เสร็จ — เห็นแล้วว่า "ส่งคำสั่งไปหาแต่ละเจ้า" ทำยังไง')}`);
console.log(`${raw.dim}  ขั้นต่อไป: node src/orchestrate.ts "โจทย์ใหญ่" — ให้ Athena สั่งทั้งทีมทำขนานกัน${raw.reset}\n`);
