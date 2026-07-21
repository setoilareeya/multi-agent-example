// ============================================================================
// send-to-each.ts
//   "ยิงคำสั่งเดียวกัน ไปหาแต่ละเจ้า ทีละตัว" — ให้เห็นภาพก่อนว่าเราส่งคำสั่ง
//   ไปหา Agent CLI ตัวอื่นได้ยังไง (headless mode ของแต่ละเจ้า)
//
//   รัน:  node src/send-to-each.ts "คำถามของคุณ"
//         (ไม่ใส่คำถาม -> ใช้ค่า default)
// ============================================================================
import { AGENTS, WORKERS, ORCHESTRATOR, RUNNERS, isInstalled, type AgentKey } from './agents.ts';
import { raw, paint, AGENT_COLOR, banner, showCmd, indent } from './ansi.ts';

const question = process.argv[2] ||
  'อธิบายสั้นๆ ว่า idempotency ใน REST API คืออะไร ทำไมถึงสำคัญ';

// ลำดับที่จะยิง: orchestrator ก่อน แล้วตามด้วย worker ทั้งหมด
const order: AgentKey[] = [ORCHESTRATOR, ...WORKERS];

async function sendOne(key: AgentKey): Promise<void> {
  const a = AGENTS[key];
  const color = AGENT_COLOR[key];

  // 1) โชว์ว่าเรากำลังยิงหาใคร + ด้วยคำสั่งอะไร
  console.log(`\n${raw[color]}▎ ${raw.bold}${a.name}${raw.reset}  ${raw.dim}(${a.cli} · ${a.model})${raw.reset}`);
  showCmd(a.cmd.replace('<prompt>', '$Q').replace('<task>', '$Q'));

  // 2) ถ้าไม่มี CLI ตัวนั้น -> ข้าม
  if (!isInstalled(a.cli)) {
    console.log(`  ${paint('red', '✗ ไม่พบ CLI นี้บนเครื่อง — ข้าม')}`);
    return;
  }

  // 3) ยิงจริง แล้วพิมพ์คำตอบ
  const t0 = Date.now();
  const res = await RUNNERS[key](question);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (res.ok && res.text) {
    console.log(indent(res.text, raw[color] + '│' + raw.reset));
    console.log(`  ${raw.dim}⏱ ${secs}s${raw.reset}`);
  } else {
    console.log(`  ${paint('yellow', '(ไม่มีผลลัพธ์ — auth หรือ quota อาจมีปัญหา)')}`);
  }
}

async function main(): Promise<void> {
  banner('ส่งคำสั่งเดียวกัน ไปหา 4 เจ้า ทีละตัว');
  console.log(`  ${raw.bold}โจทย์:${raw.reset} ${question}`);

  // ยิงทีละเจ้าตามลำดับ (ไม่ขนาน — ตั้งใจให้เห็นทีละคน)
  for (const key of order) {
    await sendOne(key);
  }

  console.log(`\n${paint('green', '✓ เสร็จ — เห็นแล้วว่า "ส่งคำสั่งไปหาแต่ละเจ้า" ทำยังไง')}`);
  console.log(`${raw.dim}  ขั้นต่อไป: node src/orchestrate.ts "โจทย์ใหญ่" — ให้ Athena สั่งทั้งทีมทำขนานกัน${raw.reset}\n`);
}

main();
