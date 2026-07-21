// ============================================================================
// app.ts — frontend ของ Agent Orchestra (TypeScript)
//   ไฟล์นี้ถูก "ตัด type" โดย server (module.stripTypeScriptTypes) แล้วเสิร์ฟเป็น
//   /app.js ให้ browser — จึงเขียนเป็น TS ได้โดยไม่ต้อง build (ห้ามมี import/export)
//
//   หน้าที่: ต่อ SSE ที่ /api/run แล้ว render ทีม agent + สายสื่อสาร real-time
// ============================================================================

// ---------- ชนิดข้อมูลที่รับจาก server ----------
interface AgentInfo {
  key: string; name: string; emoji: string; role: 'orchestrator' | 'worker';
  cli: string; model: string; color: string; tagline: string; cmd: string; installed: boolean;
}
type Phase = 'planning' | 'dispatch' | 'working' | 'synthesis' | 'done';
type Kind = 'plan' | 'assign' | 'finding' | 'synthesis';
interface SEvent {
  type: string;
  agent?: string; status?: string; detail?: string; elapsed?: number;
  phase?: Phase; from?: string; to?: string; kind?: Kind; text?: string; error?: boolean;
  agents?: Record<string, AgentInfo>; workers?: string[]; orchestrator?: string;
  assign?: { agent: string; task: string }[];
  plan?: number; synthesis?: number; total?: number; cost?: number; message?: string;
}

// ---------- helpers ----------
const $ = <T extends Element = HTMLElement>(s: string): T => document.querySelector(s) as T;
const el = (tag: string, cls?: string, html?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const PRESETS: string[] = [
  'เปรียบเทียบ REST vs GraphQL vs gRPC สำหรับงาน backend ปี 2026',
  'ควรเลือก PostgreSQL หรือ MongoDB สำหรับแอปใหม่ เพราะอะไร',
  'แนวทางทำ authentication ที่ปลอดภัยใน web app ยุคนี้',
  'microservices กับ monolith เลือกยังไงให้เหมาะกับทีมเล็ก',
];

let agents: Record<string, AgentInfo> = {};
let es: EventSource | null = null;
let finished = false;

// ---------- tiny markdown -> html (escape ก่อนเสมอ) ----------
function esc(s: unknown): string {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}
function inline(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+?)`/g, '<code>$1</code>');
}
function mdToHtml(text: string): string {
  const lines = String(text || '').split('\n');
  let out = '', inList = false;
  const closeList = (): void => { if (inList) { out += '</ul>'; inList = false; } };
  for (const raw of lines) {
    const line = raw.trim();
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

// เน้นชื่อ CLI ในคำสั่งด้วยสีของ agent
function cmdHtml(cmd: string, cli: string): string {
  return esc(cmd).replace(cli, `<span class="tok">${cli}</span>`);
}

// ---------- UI helpers ----------
function setConn(state: string, text: string): void {
  const c = $('#conn');
  c.className = 'conn' + (state ? ' ' + state : '');
  $('#connText').textContent = text;
}
function setPhase(phase: Phase): void {
  const order: Phase[] = ['planning', 'dispatch', 'working', 'synthesis', 'done'];
  const idx = order.indexOf(phase);
  document.querySelectorAll<HTMLElement>('.phase').forEach((p) => {
    const i = order.indexOf(p.dataset.phase as Phase);
    p.classList.toggle('active', i === idx);
    p.classList.toggle('done', i < idx);
  });
  document.querySelectorAll('.connector').forEach((c) =>
    c.classList.toggle('active', phase === 'working' || phase === 'dispatch'));
}
function toast(msg: string): void {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 4200);
}

// ---------- สร้างการ์ด agent ----------
function agentCard(a: AgentInfo): HTMLElement {
  const card = el('article', 'agent-card' + (a.role === 'orchestrator' ? ' orchestrator' : ''));
  card.dataset.agent = a.key;
  card.style.setProperty('--c', a.color);
  const roleTxt = `${a.model} · ${a.role === 'orchestrator' ? 'orchestrator' : 'worker'}`;
  const warn = a.installed ? '' : ' ⚠ ไม่พบ CLI';
  const taskPlaceholder = a.role === 'orchestrator' ? '— รอรับโจทย์ —' : '— ยังไม่ได้รับ subtask —';
  card.innerHTML = `
    <div class="ac-top">
      <div class="ac-avatar">${a.emoji}</div>
      <div class="ac-id">
        <div class="ac-name">${a.name}</div>
        <div class="ac-role">${roleTxt}${warn}</div>
      </div>
      <span class="ac-status" data-status="idle">รอ</span>
    </div>
    <code class="ac-cmd">${cmdHtml(a.cmd, a.cli)}</code>
    <div class="ac-task empty" data-role="task">${taskPlaceholder}</div>
    <div class="ac-finding" data-role="finding"></div>
    <div class="ac-meta"><span data-role="time"></span><span data-role="note"></span></div>`;
  return card;
}

function buildPipeline(rosterMap: Record<string, AgentInfo>, workers: string[], orchestrator: string): void {
  const pipe = $('#pipeline');
  pipe.innerHTML = '';
  pipe.appendChild(agentCard(rosterMap[orchestrator]));
  const conn = el('div', 'connector fanout');
  conn.innerHTML = '<div class="beam"></div><div class="beam"></div><div class="beam"></div>';
  pipe.appendChild(conn);
  const row = el('div', 'workers-row');
  workers.forEach((w) => row.appendChild(agentCard(rosterMap[w])));
  pipe.appendChild(row);
}

function card(key: string): HTMLElement | null {
  return document.querySelector(`.agent-card[data-agent="${key}"]`);
}
function setStatus(key: string, status: string, label: string): void {
  const c = card(key); if (!c) return;
  const s = c.querySelector('.ac-status') as HTMLElement;
  s.dataset.status = status;
  s.textContent = label;
  c.classList.toggle('active', status === 'thinking');
  c.classList.toggle('done', status === 'done');
  c.classList.toggle('errored', status === 'error');
}

// ---------- comms thread ----------
function addMessage(m: SEvent): void {
  const from = m.from ? agents[m.from] : undefined;
  const toName = m.to === 'all' ? 'ทีมทั้งหมด' : (m.to && agents[m.to] ? agents[m.to].name : m.to || '');
  const kindLabel: Record<string, string> =
    { plan: 'แผน', assign: 'มอบงาน', finding: 'ผลลัพธ์', synthesis: 'สังเคราะห์' };
  const label = kindLabel[m.kind || ''] || m.kind || '';
  const msg = el('div', `msg kind-${m.kind}`);
  msg.style.setProperty('--c', from ? from.color : '#8b93ab');
  const body = m.kind === 'assign' ? esc(m.text) : mdToHtml(m.text || '');
  msg.innerHTML = `
    <div class="msg-head">
      <span class="msg-from">${from ? from.emoji + ' ' + from.name : m.from}</span>
      <span class="msg-arrow">→</span>
      <span class="msg-to">${toName}</span>
      <span class="msg-kind">${label}</span>
    </div>
    <div class="msg-body ${m.error ? 'err' : ''}">${body}</div>`;
  const thread = $('#thread');
  thread.appendChild(msg);
  thread.scrollTop = thread.scrollHeight;
}

// พิมพ์คำตอบสังเคราะห์แบบเผยทีละบล็อก
function revealSynthesis(node: HTMLElement, text: string): void {
  node.innerHTML = mdToHtml(text);
  Array.from(node.children).forEach((k, i) => {
    const kid = k as HTMLElement;
    kid.style.opacity = '0';
    kid.style.transform = 'translateY(6px)';
    kid.style.transition = 'opacity .4s, transform .4s';
    setTimeout(() => { kid.style.opacity = '1'; kid.style.transform = 'none'; }, 120 * i);
  });
}

// ---------- event dispatch ----------
function handle(ev: SEvent): void {
  switch (ev.type) {
    case 'connected':
      setConn('busy', 'เชื่อมต่อแล้ว'); break;

    case 'run_start':
      agents = ev.agents || {};
      buildPipeline(ev.agents!, ev.workers!, ev.orchestrator!);
      $('#thread').innerHTML = '';
      ($('#liveTag') as HTMLElement).hidden = false;
      $('#synthesis').classList.remove('show');
      $('#synBody').innerHTML = '';
      $('#synCost').innerHTML = '';
      break;

    case 'phase':
      setPhase(ev.phase as Phase); break;

    case 'agent_status': {
      const labels: Record<string, string> =
        { idle: 'รอ', thinking: 'กำลังคิด…', done: 'เสร็จ', error: 'ผิดพลาด' };
      setStatus(ev.agent!, ev.status!, labels[ev.status!] || ev.status!);
      const c = card(ev.agent!);
      if (c && ev.elapsed != null) {
        (c.querySelector('[data-role="time"]') as HTMLElement).textContent = `⏱ ${(ev.elapsed / 1000).toFixed(1)}s`;
      }
      break;
    }

    case 'plan': {
      (ev.assign || []).forEach((a) => {
        const c = card(a.agent);
        if (c) { const t = c.querySelector('[data-role="task"]') as HTMLElement; t.textContent = a.task; t.classList.remove('empty'); }
      });
      const ath = card('athena');
      if (ath) { const t = ath.querySelector('[data-role="task"]') as HTMLElement; t.textContent = 'แตกโจทย์เป็น 3 subtask แล้ว'; t.classList.remove('empty'); }
      break;
    }

    case 'message':
      addMessage(ev); break;

    case 'finding': {
      const c = card(ev.agent!);
      if (c) {
        const f = c.querySelector('[data-role="finding"]') as HTMLElement;
        f.innerHTML = ev.error ? `<p class="md-h" style="color:var(--err)">${esc(ev.text)}</p>` : mdToHtml(ev.text || '');
        f.classList.add('show');
        if (ev.elapsed != null) (c.querySelector('[data-role="time"]') as HTMLElement).textContent = `⏱ ${(ev.elapsed / 1000).toFixed(1)}s`;
      }
      break;
    }

    case 'synthesis':
      $('#synthesis').classList.add('show');
      revealSynthesis($('#synBody'), ev.text || '');
      $('#synthesis').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      break;

    case 'cost':
      $('#synCost').innerHTML =
        `plan <b>$${(ev.plan || 0).toFixed(4)}</b> + สังเคราะห์ <b>$${(ev.synthesis || 0).toFixed(4)}</b>` +
        `<br>Claude รวม <b>$${(ev.total || 0).toFixed(4)}</b>`;
      break;

    case 'done':
      finished = true;
      setPhase('done');
      setConn('live', 'ภารกิจเสร็จสิ้น');
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

  es = new EventSource('/api/run?q=' + encodeURIComponent(q));
  es.onmessage = (e: MessageEvent) => {
    try { handle(JSON.parse(e.data)); } catch (err) { console.error('bad event', e.data, err); }
  };
  es.onerror = () => {
    if (finished) return;               // ปิดปกติหลัง done
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

  // โหลด roster ล่วงหน้าเพื่อโชว์การ์ดทีม (state idle) ก่อนกดเริ่ม
  fetch('/api/agents').then((r) => r.json()).then((d) => {
    agents = d.agents;
    buildPipeline(d.agents, d.workers, d.orchestrator);
    const missing = Object.values(d.agents as Record<string, AgentInfo>).filter((a) => !a.installed).map((a) => a.name);
    if (missing.length) toast('ไม่พบ CLI ของ: ' + missing.join(', ') + ' (จะข้ามตอนรัน)');
  }).catch(() => { /* เปิดหน้าแบบ static ก็ยังได้ */ });
}

// module script ถูก defer อยู่แล้ว แต่กันไว้เผื่อ DOM ยังไม่พร้อม
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

export {}; // ทำให้ไฟล์เป็น ES module (โหลดด้วย <script type="module">)
