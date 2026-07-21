// ---------- events from the server (Claude Code stream mapped to this protocol) ----------
interface HEvent {
  type: string;
  question?: string; phase?: string; status?: string; detail?: string;
  kind?: string; text?: string;
  id?: string; subagent_type?: string; task?: string; index?: number; result?: string; error?: boolean;
  total?: number; cost?: number; message?: string;
}

interface Node { id: string; type: string; index: number; color: string; el: HTMLElement; line: SVGLineElement; }

const SUB_ICON: Record<string, string> = {
  researcher: '🔎', explore: '🧭', 'general-purpose': '⚙️', analyst: '📊',
  writer: '✍️', critic: '🧐', planner: '🗺️', coder: '💻', reviewer: '🔬',
};
const PRESETS: string[] = [
  'เปรียบเทียบ React 19 กับ Vue 3.5 สำหรับโปรเจกต์ใหม่ปี 2026',
  'สรุปแนวทาง caching ที่ดีที่สุดสำหรับ REST API',
  'ข้อดีข้อเสียของ microservices เทียบ monolith สำหรับทีมเล็ก',
  'วิธีออกแบบ rate limiting ที่ยืดหยุ่นและกัน abuse',
];

// ---------- helpers ----------
const $ = <T extends Element = HTMLElement>(s: string): T => document.querySelector(s) as T;
const el = (tag: string, cls?: string, html?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

let es: EventSource | null = null;
let finished = false;
const nodes = new Map<string, Node>();

function esc(s: unknown): string {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}
function inline(s: string): string {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+?)`/g, '<code>$1</code>');
}
function mdToHtml(text: string): string {
  const lines = String(text || '').split('\n');
  let out = '', inList = false;
  const closeList = (): void => { if (inList) { out += '</ul>'; inList = false; } };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { closeList(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const li = line.match(/^([-*•]|\d+[.)])\s+(.*)$/);
    if (h) { closeList(); out += `<div class="md-h">${inline(h[2])}</div>`; }
    else if (li) { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${inline(li[2])}</li>`; }
    else { closeList(); out += `<p>${inline(line)}</p>`; }
  }
  closeList();
  return out;
}

function setConn(state: string, text: string): void {
  const c = $('#conn'); c.className = 'conn' + (state ? ' ' + state : '');
  $('#connText').textContent = text;
}
function setPhase(phase: string): void {
  const order = ['plan', 'delegate', 'work', 'synthesize', 'done'];
  const idx = order.indexOf(phase);
  document.querySelectorAll<HTMLElement>('.phase').forEach((p) => {
    const i = order.indexOf(p.dataset.phase || '');
    p.classList.toggle('active', i === idx);
    p.classList.toggle('done', i < idx);
  });
}
function toast(msg: string): void {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 4200);
}
const nodeColor = (index: number): string => `var(--n${index % 6})`;

// ---------- activity feed ----------
function addFeed(from: string, text: string, kind?: string, color?: string): void {
  const ev = el('div', 'ev');
  if (color) ev.style.setProperty('--c', color);
  ev.innerHTML = `<div class="ev-head">${esc(from)}<span class="ev-kind">${esc(kind || '')}</span></div><div class="ev-body">${inline(text)}</div>`;
  const feed = $('#feed'); feed.appendChild(ev); feed.scrollTop = feed.scrollHeight;
}

// ---------- constellation ----------
function layoutNodes(): void {
  const con = $('#constellation');
  const W = con.clientWidth, H = con.clientHeight;
  const cx = W / 2, cy = H / 2;
  const r = Math.min(W, H) * 0.37;
  const arr = [...nodes.values()];
  arr.forEach((node, i) => {
    const ang = (-Math.PI / 2) + (i * 2 * Math.PI / Math.max(arr.length, 1));
    const x = cx + r * Math.cos(ang);
    const y = cy + r * Math.sin(ang);
    node.el.style.left = x + 'px';
    node.el.style.top = y + 'px';
    node.line.setAttribute('x1', String(cx)); node.line.setAttribute('y1', String(cy));
    node.line.setAttribute('x2', String(x)); node.line.setAttribute('y2', String(y));
  });
}
function spawnNode(id: string, type: string, task: string, index: number): void {
  if (nodes.has(id)) return;
  const color = nodeColor(index);
  const node = el('div', 'node working');
  node.style.setProperty('--c', color);
  node.innerHTML =
    `<div class="node-top"><span class="node-ic">${SUB_ICON[type] || '🤖'}</span>` +
    `<span class="node-type">${esc(type)}</span><span class="node-badge" data-status="working">ทำงาน</span></div>` +
    `<div class="node-task">${esc(task)}</div>` +
    `<div class="node-result" data-role="result" hidden></div>`;
  $('#constellation').appendChild(node);
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('class', 'link active');
  line.style.setProperty('--c', color);
  $('#links').appendChild(line);
  nodes.set(id, { id, type, index, color, el: node, line });
  ($('#hint') as HTMLElement).style.display = 'none';
  layoutNodes();
}
function setNodeStatus(id: string, status: string): void {
  const node = nodes.get(id); if (!node) return;
  const badge = node.el.querySelector('.node-badge') as HTMLElement;
  node.el.classList.remove('working', 'done', 'err');
  if (status === 'done') { node.el.classList.add('done'); badge.dataset.status = 'done'; badge.textContent = 'เสร็จ'; node.line.setAttribute('class', 'link done'); }
  else if (status === 'error') { node.el.classList.add('err'); badge.dataset.status = 'error'; badge.textContent = 'พลาด'; node.line.setAttribute('class', 'link'); }
  else { node.el.classList.add('working'); badge.dataset.status = 'working'; badge.textContent = 'ทำงาน'; node.line.setAttribute('class', 'link active'); }
}
function setNodeResult(id: string, text: string, error?: boolean): void {
  const node = nodes.get(id); if (!node) return;
  const r = node.el.querySelector('[data-role="result"]') as HTMLElement;
  r.textContent = text; r.hidden = false;
  if (error) node.el.classList.add('err');
  layoutNodes();
}
function resetHive(): void {
  nodes.clear();
  $('#links').innerHTML = '';
  document.querySelectorAll('.constellation .node').forEach((n) => n.remove());
  ($('#hint') as HTMLElement).style.display = '';
  $('#hub').classList.remove('thinking');
  $('#feed').innerHTML = '';
  $('#synthesis').classList.remove('show');
  $('#synBody').innerHTML = ''; $('#synCost').innerHTML = '';
}
function revealSynthesis(text: string): void {
  const node = $('#synBody'); node.innerHTML = mdToHtml(text);
  Array.from(node.children).forEach((child, i) => {
    const kid = child as HTMLElement;
    kid.style.opacity = '0'; kid.style.transform = 'translateY(8px)';
    kid.style.transition = 'opacity .4s, transform .4s';
    setTimeout(() => { kid.style.opacity = '1'; kid.style.transform = 'none'; }, 110 * i);
  });
}

// ---------- event dispatch ----------
function handle(ev: HEvent): void {
  switch (ev.type) {
    case 'connected':
      setConn('busy', 'เชื่อมต่อแล้ว'); break;

    case 'run_start':
      resetHive();
      ($('#liveTag') as HTMLElement).hidden = false;
      $('#hub').classList.add('thinking');
      addFeed('🧠 Claude Code', 'รับโจทย์: ' + (ev.question || ''), 'start', 'var(--hub-a)');
      break;

    case 'phase':
      setPhase(ev.phase || ''); break;

    case 'main_status':
      $('#hub').classList.toggle('thinking', ev.status === 'thinking'); break;

    case 'main_text':
      addFeed('🧠 Claude Code', ev.text || '', ev.kind || 'note', 'var(--hub-a)'); break;

    case 'spawn': {
      const idx = ev.index ?? nodes.size;
      spawnNode(ev.id || 'n' + idx, ev.subagent_type || 'sub-agent', ev.task || '', idx);
      addFeed(`${SUB_ICON[ev.subagent_type || ''] || '🤖'} spawn → ${ev.subagent_type || 'sub-agent'}`, ev.task || '', 'Task', nodeColor(idx));
      break;
    }

    case 'subagent_status':
      setNodeStatus(ev.id || '', ev.status || ''); break;

    case 'subagent_result': {
      setNodeStatus(ev.id || '', ev.error ? 'error' : 'done');
      setNodeResult(ev.id || '', ev.result || (ev.error ? '(ไม่มีผลลัพธ์)' : ''), ev.error);
      const node = ev.id ? nodes.get(ev.id) : undefined;
      addFeed(`${SUB_ICON[node?.type || ''] || '🤖'} ${node?.type || 'sub-agent'}`, ev.result || '(ไม่มีผลลัพธ์)', ev.error ? 'error' : 'result', node?.color);
      break;
    }

    case 'result':
      $('#synthesis').classList.add('show');
      $('#hub').classList.remove('thinking');
      revealSynthesis(ev.text || '(ไม่มีผลลัพธ์)');
      $('#synthesis').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      break;

    case 'cost':
      $('#synCost').innerHTML = `🪙 Claude Code รวม <b>$${(ev.total || 0).toFixed(4)}</b>`;
      break;

    case 'done':
      finished = true;
      setPhase('done');
      setConn('live', 'สำเร็จ');
      $('#hub').classList.remove('thinking');
      ($('#liveTag') as HTMLElement).hidden = true;
      endRun();
      break;

    case 'error':
      toast('เกิดข้อผิดพลาด: ' + ev.message);
      setConn('err', 'ผิดพลาด');
      break;
  }
}

// ---------- run control ----------
function startRun(): void {
  const q = ($('#q') as HTMLInputElement).value.trim();
  if (!q) { $('#q').focus(); toast('พิมพ์โจทย์ก่อนนะ'); return; }
  if (es) es.close();
  finished = false;
  ($('#launch') as HTMLButtonElement).disabled = true;
  ($('#stop') as HTMLElement).hidden = false;
  setConn('busy', 'กำลังเริ่ม…');
  es = new EventSource('/api/hive?q=' + encodeURIComponent(q));
  es.onmessage = (e: MessageEvent) => {
    try { handle(JSON.parse(e.data)); } catch (err) { console.error('bad event', e.data, err); }
  };
  es.onerror = () => {
    if (finished) return;               // normal close after done
    setConn('err', 'การเชื่อมต่อหลุด');
    toast('การเชื่อมต่อกับ server หลุด');
    endRun();
  };
}
function endRun(): void {
  if (es) { es.close(); es = null; }
  ($('#launch') as HTMLButtonElement).disabled = false;
  ($('#stop') as HTMLElement).hidden = true;
  ($('#liveTag') as HTMLElement).hidden = true;
}
function stopRun(): void {
  finished = true;
  endRun();
  setConn('', 'หยุดแล้ว');
}

// ---------- scripted preview (no real claude) — open /hive.html?demo ----------
function demoHive(): void {
  const ev = (o: HEvent): void => handle(o);
  const q = PRESETS[0];
  const seq: Array<[number, () => void]> = [
    [0,     () => ev({ type: 'connected' })],
    [200,   () => ev({ type: 'run_start', question: q })],
    [300,   () => ev({ type: 'phase', phase: 'plan' })],
    [350,   () => ev({ type: 'main_status', status: 'thinking' })],
    [600,   () => ev({ type: 'main_text', kind: 'plan', text: 'แตกโจทย์เป็น 3 มุม แล้วจะกระจายให้ sub-agent ทำขนานกันด้วย Task tool' })],
    [2300,  () => ev({ type: 'phase', phase: 'delegate' })],
    [2400,  () => ev({ type: 'spawn', id: 'a', subagent_type: 'researcher', task: 'ค้น React 19: ฟีเจอร์ใหม่ + performance', index: 0 })],
    [2750,  () => ev({ type: 'spawn', id: 'b', subagent_type: 'researcher', task: 'ค้น Vue 3.5: ฟีเจอร์ใหม่ + performance', index: 1 })],
    [3100,  () => ev({ type: 'spawn', id: 'c', subagent_type: 'analyst', task: 'เทียบ DX, ecosystem, learning curve', index: 2 })],
    [3300,  () => ev({ type: 'phase', phase: 'work' })],
    [6200,  () => ev({ type: 'subagent_result', id: 'a', result: 'React 19: Actions, use() hook, RSC เสถียร, compiler ช่วยลด re-render อัตโนมัติ' })],
    [7600,  () => ev({ type: 'subagent_result', id: 'b', result: 'Vue 3.5: reactivity เร็วขึ้น ~56%, useTemplateRef, SSR/hydration ดีขึ้น' })],
    [9000,  () => ev({ type: 'subagent_result', id: 'c', result: 'React ecosystem ใหญ่กว่า; Vue เรียนรู้ง่ายกว่า; DX ดีทั้งคู่' })],
    [9600,  () => ev({ type: 'phase', phase: 'synthesize' })],
    [9700,  () => ev({ type: 'main_status', status: 'thinking' })],
    [9900,  () => ev({ type: 'main_text', kind: 'synthesis', text: 'รวมผลจาก sub-agent ทั้ง 3 ตัวแล้ว กำลังเรียบเรียงคำตอบ' })],
    [11600, () => { ev({ type: 'result', text: '- **React 19** — เหมาะทีมใหญ่ / ecosystem กว้าง, ได้ Actions + auto-memo compiler\n- **Vue 3.5** — เขียนกระชับ, reactivity เร็วขึ้นมาก, เหมาะทีมเล็ก–กลาง\n- **เลือกยังไง** — คุ้น JSX/อยากได้ ecosystem → React; อยากเริ่มไว/โค้ดสั้น → Vue\n\n**ข้อสรุป:** ทั้งคู่ production-ready ปี 2026 — เลือกตามความถนัดทีมและขนาดโปรเจกต์' }); ev({ type: 'cost', total: 0 }); }],
    [12200, () => ev({ type: 'done' })],
  ];
  for (const p of seq) setTimeout(p[1], p[0]);
}

// ---------- init ----------
function init(): void {
  const pc = $('#presets');
  PRESETS.forEach((p) => {
    const b = el('button', 'preset', p);
    b.onclick = () => { ($('#q') as HTMLInputElement).value = p; startRun(); };
    pc.appendChild(b);
  });
  ($('#q') as HTMLInputElement).value = PRESETS[0];
  ($('#launch') as HTMLElement).onclick = startRun;
  ($('#stop') as HTMLElement).onclick = stopRun;
  $('#q').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') startRun(); });
  window.addEventListener('resize', layoutNodes);
  if (location.search.includes('demo') || location.hash.includes('demo')) setTimeout(demoHive, 500);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

export {}; // make this file an ES module (loaded via <script type="module">)
