// ansi.ts — helper แต่งสีข้อความบน terminal ให้ CLI demo อ่านง่าย
// (ปิดสีอัตโนมัติถ้าไม่ได้ต่อ terminal หรือ NO_COLOR ถูกตั้ง)

export const isTTY = process.stdout.isTTY === true && !process.env.NO_COLOR;

const code = (n: string) => (isTTY ? `\x1b[${n}m` : '');

export const raw = {
  reset: code('0'), bold: code('1'), dim: code('2'),
  red: code('31'), green: code('32'), yellow: code('33'),
  blue: code('34'), magenta: code('35'), cyan: code('36'), gray: code('90'),
};

export type Color = keyof typeof raw;

// ทาสีสตริงหนึ่งช่วง แล้วรีเซ็ตกลับ
export const paint = (c: Color, s: string): string => `${raw[c]}${s}${raw.reset}`;

// map ชื่อ agent -> สีประจำตัวบน terminal
export const AGENT_COLOR: Record<string, Color> = {
  athena: 'magenta', orion: 'blue', luna: 'cyan', atlas: 'yellow',
};

// กล่องหัวข้อ
export function banner(title: string): void {
  const line = '─'.repeat(70);
  console.log(`\n${raw.cyan}╭${line}╮${raw.reset}`);
  console.log(`${raw.cyan}│${raw.reset} ${raw.bold}${title}${raw.reset}`);
  console.log(`${raw.cyan}╰${line}╯${raw.reset}`);
}

// แสดง "คำสั่งที่กำลังจะยิง" — หัวใจของ demo คือให้เห็นคำสั่ง headless นี้
export function showCmd(cmd: string): void {
  console.log(`  ${raw.gray}$ ${cmd}${raw.reset}`);
}

// เติม prefix สี (เช่นขีดข้าง) หน้าทุกบรรทัดของข้อความหลายบรรทัด
export function indent(text: string, prefix: string): string {
  return text.split('\n').map((l) => `  ${prefix} ${l}`).join('\n');
}
