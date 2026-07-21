// Terminal color/format helpers that make the CLI demo output easy to read.
// (colors auto-disable when not attached to a terminal or when NO_COLOR is set)

export const isTTY = process.stdout.isTTY === true && !process.env.NO_COLOR;

const code = (n: string) => (isTTY ? `\x1b[${n}m` : '');

export const raw = {
  reset: code('0'), bold: code('1'), dim: code('2'),
  red: code('31'), green: code('32'), yellow: code('33'),
  blue: code('34'), magenta: code('35'), cyan: code('36'), gray: code('90'),
};

export type Color = keyof typeof raw;

// paint one span of text, then reset back
export const paint = (c: Color, s: string): string => `${raw[c]}${s}${raw.reset}`;

// map agent name -> its own terminal color
export const AGENT_COLOR: Record<string, Color> = {
  athena: 'magenta', orion: 'blue', luna: 'cyan', atlas: 'yellow',
};

// title box
export function banner(title: string): void {
  const line = '─'.repeat(70);
  console.log(`\n${raw.cyan}╭${line}╮${raw.reset}`);
  console.log(`${raw.cyan}│${raw.reset} ${raw.bold}${title}${raw.reset}`);
  console.log(`${raw.cyan}╰${line}╯${raw.reset}`);
}

// add a colored prefix (e.g. a side bar) in front of every line of a multi-line string
export function indent(text: string, prefix: string): string {
  return text.split('\n').map((l) => `  ${prefix} ${l}`).join('\n');
}

// quote a shell arg for display (only when it contains spaces/quotes)
function quoteArg(a: string): string {
  return /[\s"'\\$]/.test(a) ? `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"` : a;
}

// show the REAL command that runs; long prompt args are shown in full as an indented "query" block
export function showRun(cmd: string, args: string[]): void {
  const prompts: string[] = [];
  const parts = args.map((a) => {
    if (a.length > 42 || a.includes('\n')) { prompts.push(a); return '"…"'; }
    return quoteArg(a);
  });
  console.log(`  ${raw.gray}$ ${[cmd, ...parts].join(' ')}${raw.reset}`);
  for (const p of prompts) {
    console.log(`  ${raw.dim}↳ query ที่ส่งจริง:${raw.reset}`);
    console.log(indent(p, raw.gray + '│' + raw.reset));
  }
}

// show the REAL response text a CLI returned (indented, in the agent's color)
export function showResponse(text: string, color: Color, note?: string): void {
  console.log(`  ${raw.dim}↳ response ที่ได้จริง${note ? ' · ' + note : ''}:${raw.reset}`);
  console.log(indent(text, raw[color] + '│' + raw.reset));
}
