// ---------- data shapes received from the server ----------
interface AgentInfo {
  key: string; name: string; emoji: string; role: 'orchestrator' | 'worker';
  cli: string; model: string; color: string; tagline: string; cmd: string; installed: boolean;
}
interface QEvent {
  type: string;
  agent?: string; status?: string; detail?: string; elapsed?: number;
  phase?: string; from?: string; text?: string; error?: boolean;
  agents?: Record<string, AgentInfo>; workers?: string[]; orchestrator?: string;
  reason?: string; title?: string; by?: string; chosen?: string;
  assess?: number; verdict?: number; total?: number; cost?: number;
  question?: string; message?: string;
}

// ---------- RPG flavor per agent (cosmetic: class, icon, stat pips out of 5) ----------
interface Klass { role: string; th: string; icon: string; blurb: string; stats: [string, number][]; }
const CLASS: Record<string, Klass> = {
  athena: { role: 'GUILD MASTER', th: 'หัวหน้ากิลด์',    icon: '👑', blurb: 'วางแผน · ประเมิน · สรุป', stats: [['INT', 5], ['WIS', 5], ['CMD', 5]] },
  orion:  { role: 'SCOUT',        th: 'นักสำรวจ',        icon: '🏹', blurb: 'ค้นเร็ว · ว่องไว',        stats: [['SPD', 5], ['INT', 3], ['LCK', 4]] },
  luna:   { role: 'MAGE',         th: 'นักเวทวิเคราะห์', icon: '🔮', blurb: 'เจาะลึก · เหตุผลแน่น',    stats: [['INT', 5], ['WIS', 4], ['SPD', 2]] },
  atlas:  { role: 'SAGE',         th: 'นักคัมภีร์',      icon: '📜', blurb: 'รอบด้าน · มองภาพกว้าง',  stats: [['WIS', 5], ['INT', 4], ['DEF', 4]] },
};
const STATUS_TH: Record<string, string> = {
  idle: 'พร้อม', thinking: 'กำลังลุย…', chosen: 'ถูกเลือก!', bench: 'พักก่อน', done: 'สำเร็จ', error: 'พลาด',
};

const PRESETS: string[] = [
  'เปรียบเทียบ REST vs GraphQL vs gRPC สำหรับ backend ปี 2026',
  'ออกแบบ authentication ที่ปลอดภัยสำหรับ web app ยุคนี้',
  'เลือก PostgreSQL หรือ MongoDB สำหรับแอปใหม่ เพราะอะไร',
  'สรุปวิธีทำ caching ให้ API เร็วขึ้นแบบเข้าใจง่าย',
];

// ---------- helpers ----------
const $ = <T extends Element = HTMLElement>(s: string): T => document.querySelector(s) as T;
const el = (tag: string, cls?: string, html?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

let agents: Record<string, AgentInfo> = {};
let es: EventSource | null = null;
let finished = false;
let stage: Stage | null = null;

// state shown in the "work console" while a worker runs
let questionText = '';
let pickInfo: { title: string; reason: string } | null = null;
let workTimer: number | null = null;
let workStart = 0;
const THINK = ['กำลังตีความโจทย์', 'กำลังค้นข้อมูลที่เกี่ยวข้อง', 'กำลังวิเคราะห์ทางเลือก', 'กำลังชั่งน้ำหนักข้อดี–ข้อเสีย', 'กำลังเรียบเรียงคำตอบ'];

// ---------- tiny markdown -> html (always escape first) ----------
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

// highlight the CLI name in the command using the agent's color
function cmdHtml(cmd: string, cli: string): string {
  return esc(cmd).replace(cli, `<span class="tok">${cli}</span>`);
}

// ---------- UI helpers ----------
function setConn(state: string, text: string): void {
  const c = $('#conn');
  c.className = 'conn' + (state ? ' ' + state : '');
  $('#connText').textContent = text;
}
function setPhase(phase: string): void {
  const order = ['assess', 'choose', 'quest', 'report', 'verdict', 'done'];
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

// ---------- work console: what the working agent received + its (live) process ----------
function showWorkHud(key: string): void {
  const a = agents[key]; if (!a) return;
  const hud = $('#workhud');
  const q = questionText || '—';
  const task = q.length > 70 ? q.slice(0, 68) + '…' : q;
  const cmd = a.cmd.replace('<prompt>', task).replace('<task>', task);
  const title = pickInfo?.title || 'ภารกิจ';
  const reason = pickInfo?.reason || '';
  hud.style.setProperty('--c', a.color);
  hud.innerHTML =
    `<div class="wh-head"><span class="wh-who">${CLASS[key]?.icon || a.emoji} ${a.name} <b>กำลังทำงาน</b></span>` +
    `<span class="wh-timer" id="whTimer">⏱ 0.0s</span></div>` +
    `<div class="wh-sec"><span class="wh-k">📥 ข้อมูลที่รับมา</span>` +
    `<div class="wh-quest">⚔ ${esc(title)}${reason ? ' — ' + esc(reason) : ''}</div>` +
    `<div class="wh-input">“${esc(q)}”</div></div>` +
    `<div class="wh-sec"><span class="wh-k">💻 คำสั่งที่กำลังรัน</span>` +
    `<code class="wh-cmd">${esc(cmd)}</code></div>` +
    `<div class="wh-sec"><span class="wh-k">⚙ กระบวนการคิด</span>` +
    `<ul class="wh-steps"><li class="done">รับโจทย์ &amp; ตีความเควส</li>` +
    `<li class="active"><span id="whThink">กำลังคิด</span></li>` +
    `<li>เรียบเรียงคำตอบเป็น bullet</li></ul></div>`;
  hud.hidden = false;
  workStart = performance.now();
  if (workTimer) clearInterval(workTimer);
  workTimer = window.setInterval(() => {
    const secs = (performance.now() - workStart) / 1000;
    const t = document.getElementById('whTimer'); if (t) t.textContent = `⏱ ${secs.toFixed(1)}s`;
    const think = document.getElementById('whThink');
    if (think) think.textContent = THINK[Math.floor(secs / 2.2) % THINK.length] + '.'.repeat(1 + (Math.floor(secs * 2) % 3));
  }, 120);
}
function hideWorkHud(): void {
  if (workTimer) { clearInterval(workTimer); workTimer = null; }
  const hud = document.getElementById('workhud'); if (hud) (hud as HTMLElement).hidden = true;
}

// ============================================================================
// 2.5D isometric "guild office" — the agents are characters that walk around
// and act out the quest (idle-wander → assemble → send one out the portal →
// return with the report → gather for the verdict).
// ============================================================================
interface Char {
  key: string; name: string; color: string; icon: string;
  gx: number; gy: number; tx: number; ty: number;      // position + target (tile coords)
  moving: boolean; bob: number; face: number;
  chosen: boolean; dim: boolean; working: boolean;
  speech: string; speechUntil: number; wanderAt: number;
}
const HOME: Record<string, { gx: number; gy: number }> = {
  athena: { gx: 3.6, gy: 4.7 },
  orion:  { gx: 1.3, gy: 1.5 },
  luna:   { gx: 3.6, gy: 1.0 },
  atlas:  { gx: 5.9, gy: 1.5 },
};
const SPOT = {
  board:  { gx: 3.4, gy: 3.0 },
  meet:   { gx: 4.8, gy: 3.4 },
  podium: { gx: 3.6, gy: 4.3 },
};
const GRID_W = 8, GRID_D = 6;

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

class Stage {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  chars: Record<string, Char> = {};
  order: string[] = ['orion', 'luna', 'atlas', 'athena'];
  w = 0; h = 0; tw = 0; th = 0; ox = 0; oy = 0;
  playing = false; last = 0; phase = '';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    requestAnimationFrame(this.tick);
  }

  resize(): void {
    const wrap = this.canvas.parentElement as HTMLElement;
    const cssW = wrap.clientWidth, cssH = wrap.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = cssW; this.h = cssH;
    this.tw = Math.min(cssW / 11, 104);
    this.th = this.tw / 2;
    this.ox = cssW / 2;
    this.oy = cssH * 0.30;
  }

  iso(gx: number, gy: number): { x: number; y: number } {
    return { x: this.ox + (gx - gy) * (this.tw / 2), y: this.oy + (gx + gy) * (this.th / 2) };
  }

  setRoster(map: Record<string, AgentInfo>): void {
    for (const key of this.order) {
      const a = map[key]; if (!a) continue;
      const home = HOME[key];
      const ex = this.chars[key];
      this.chars[key] = {
        key, name: a.name, color: a.color, icon: CLASS[key]?.icon || a.emoji,
        gx: ex ? ex.gx : home.gx, gy: ex ? ex.gy : home.gy, tx: home.gx, ty: home.gy,
        moving: false, bob: Math.random() * 6, face: 1,
        chosen: false, dim: false, working: false,
        speech: '', speechUntil: 0, wanderAt: 0,
      };
    }
  }

  // ── choreography ──
  reset(map?: Record<string, AgentInfo>): void {
    if (map) this.setRoster(map);
    for (const k of this.order) {
      const c = this.chars[k]; if (!c) continue;
      c.chosen = false; c.dim = false; c.working = false; c.speech = '';
      c.tx = c.gx; c.ty = c.gy;   // stop wherever they are; the quest events move them from here
    }
    this.playing = true;
  }
  goTo(key: string, gx: number, gy: number): void {
    const c = this.chars[key]; if (c) { c.tx = gx; c.ty = gy; }
  }
  say(key: string | undefined, text: string, ms = 3600): void {
    if (!key) return;
    const c = this.chars[key]; if (!c) return;
    c.speech = text.length > 26 ? text.slice(0, 25) + '…' : text;
    c.speechUntil = performance.now() + ms;
  }
  onPhase(phase: string): void {
    this.phase = phase;
    if (phase === 'assess') this.goTo('athena', SPOT.board.gx, SPOT.board.gy);
    else if (phase === 'verdict') this.goTo('athena', SPOT.podium.gx, SPOT.podium.gy);
  }
  onStatus(key: string, status: string): void {
    const c = this.chars[key]; if (!c) return;
    if (key === 'athena') {
      if (status === 'thinking') {
        const to = this.phase === 'verdict' ? SPOT.podium : SPOT.board;
        this.goTo('athena', to.gx, to.gy);
      }
      return;
    }
    // workers: when picked/working they head back to their OWN desk; when done they walk over to report
    if (status === 'chosen') { c.chosen = true; c.dim = false; this.goTo(key, HOME[key].gx, HOME[key].gy); }
    else if (status === 'bench') { c.dim = true; c.chosen = false; this.goTo(key, HOME[key].gx, HOME[key].gy); }
    else if (status === 'thinking') { c.working = true; c.chosen = true; this.goTo(key, HOME[key].gx, HOME[key].gy); }
    else if (status === 'done' || status === 'error') { c.working = false; this.goTo(key, SPOT.meet.gx, SPOT.meet.gy); }
  }
  celebrate(): void {
    this.playing = false;
    for (const k of this.order) {
      const c = this.chars[k]; if (!c) continue;
      c.dim = false; c.working = false; c.chosen = false;
    }
  }

  // ── loop ──
  tick = (now: number): void => {
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 0.016;
    this.last = now;
    this.update(dt, now);
    this.render(now);
    requestAnimationFrame(this.tick);
  };

  update(dt: number, now: number): void {
    for (const k of this.order) {
      const c = this.chars[k]; if (!c) continue;
      const dx = c.tx - c.gx, dy = c.ty - c.gy;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.04) {
        const step = Math.min(2.4 * dt, dist);
        c.gx += (dx / dist) * step; c.gy += (dy / dist) * step;
        c.moving = true; c.bob += dt * 11;
        c.face = (dx - dy) >= 0 ? 1 : -1;
      } else {
        c.gx = c.tx; c.gy = c.ty; c.moving = false;
        if (!this.playing && now > c.wanderAt) {
          const hh = HOME[k];
          c.tx = Math.max(0.6, Math.min(GRID_W - 0.8, hh.gx + (Math.random() - 0.5) * 2.4));
          c.ty = Math.max(0.6, Math.min(GRID_D - 0.8, hh.gy + (Math.random() - 0.5) * 1.8));
          c.wanderAt = now + 1600 + Math.random() * 3400;
        }
      }
      if (c.speech && now > c.speechUntil) c.speech = '';
    }
  }

  // ── render ──
  render(now: number): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    this.drawFloor();
    this.drawWalls();

    const items: Array<{ d: number; f: () => void }> = [];
    for (const k of this.order) {
      if (k === 'athena') continue;
      const hh = HOME[k]; const c = this.chars[k]; if (!c) continue;
      items.push({ d: hh.gx + (hh.gy - 0.9), f: () => this.drawDesk(hh.gx, hh.gy - 0.9, c.color, false) });
    }
    const ah = HOME.athena;
    items.push({ d: ah.gx + (ah.gy + 0.6), f: () => this.drawDesk(ah.gx, ah.gy + 0.6, this.chars.athena?.color || '#ffd76a', true) });
    items.push({ d: 0.6, f: () => this.drawPlant(0.5, 0.5) });
    items.push({ d: GRID_W - 1.4, f: () => this.drawPlant(GRID_W - 1.2, 0.5) });
    for (const k of this.order) {
      const c = this.chars[k]; if (!c) continue;
      items.push({ d: c.gx + c.gy + 0.5, f: () => this.drawChar(c, now) });
    }
    items.sort((a, b) => a.d - b.d);
    for (const it of items) it.f();

    for (const k of this.order) {
      const c = this.chars[k]; if (!c || (!c.speech && !c.working)) continue;
      this.drawBubble(c);
    }
  }

  drawFloor(): void {
    const ctx = this.ctx;
    for (let gx = 0; gx < GRID_W; gx++) for (let gy = 0; gy < GRID_D; gy++) {
      const p = this.iso(gx, gy), p2 = this.iso(gx + 1, gy), p3 = this.iso(gx + 1, gy + 1), p4 = this.iso(gx, gy + 1);
      const rug = gx >= 2 && gx <= 5 && gy >= 2 && gy <= 5;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.closePath();
      ctx.fillStyle = rug ? ((gx + gy) % 2 ? '#2c2246' : '#251c3c') : ((gx + gy) % 2 ? '#181b30' : '#141627');
      ctx.fill();
      ctx.strokeStyle = 'rgba(130,150,230,0.05)'; ctx.lineWidth = 1; ctx.stroke();
    }
  }

  drawWalls(): void {
    const ctx = this.ctx; const H = this.th * 3;
    const a = this.iso(0, 0), b = this.iso(GRID_W, 0), d = this.iso(0, GRID_D);
    // back wall (gy = 0)
    ctx.fillStyle = '#0f1228';
    ctx.beginPath(); ctx.moveTo(a.x, a.y - H); ctx.lineTo(b.x, b.y - H); ctx.lineTo(b.x, b.y); ctx.lineTo(a.x, a.y); ctx.closePath(); ctx.fill();
    // left wall (gx = 0)
    ctx.fillStyle = '#0a0d20';
    ctx.beginPath(); ctx.moveTo(a.x, a.y - H); ctx.lineTo(d.x, d.y - H); ctx.lineTo(d.x, d.y); ctx.lineTo(a.x, a.y); ctx.closePath(); ctx.fill();
    // windows on the back wall (glowing night panes)
    for (let i = 1; i <= 5; i += 2) {
      const w0 = this.iso(i, 0), w1 = this.iso(i + 1.2, 0);
      const grad = ctx.createLinearGradient(0, w0.y - H * 0.8, 0, w0.y - H * 0.3);
      grad.addColorStop(0, 'rgba(120,150,255,0.22)'); grad.addColorStop(1, 'rgba(90,120,220,0.05)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(w0.x, w0.y - H * 0.82); ctx.lineTo(w1.x, w1.y - H * 0.82);
      ctx.lineTo(w1.x, w1.y - H * 0.34); ctx.lineTo(w0.x, w0.y - H * 0.34); ctx.closePath(); ctx.fill();
    }
    // top edge highlight
    ctx.strokeStyle = 'rgba(255,215,106,0.18)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(d.x, d.y - H); ctx.lineTo(a.x, a.y - H); ctx.lineTo(b.x, b.y - H); ctx.stroke();
  }

  isoBox(gx: number, gy: number, w: number, d: number, h: number, top: string, left: string, right: string): void {
    const ctx = this.ctx;
    const b = this.iso(gx + w, gy), c = this.iso(gx + w, gy + d), e = this.iso(gx, gy + d), a = this.iso(gx, gy);
    ctx.fillStyle = right;
    ctx.beginPath(); ctx.moveTo(b.x, b.y - h); ctx.lineTo(c.x, c.y - h); ctx.lineTo(c.x, c.y); ctx.lineTo(b.x, b.y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = left;
    ctx.beginPath(); ctx.moveTo(e.x, e.y - h); ctx.lineTo(c.x, c.y - h); ctx.lineTo(c.x, c.y); ctx.lineTo(e.x, e.y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = top;
    ctx.beginPath(); ctx.moveTo(a.x, a.y - h); ctx.lineTo(b.x, b.y - h); ctx.lineTo(c.x, c.y - h); ctx.lineTo(e.x, e.y - h); ctx.closePath(); ctx.fill();
  }

  drawDesk(gx: number, gy: number, color: string, big: boolean): void {
    const ctx = this.ctx; const w = big ? 1.5 : 0.95, d = 0.55, h = 15;
    this.isoBox(gx - w / 2, gy - d / 2, w, d, h, '#2b2c40', '#1f2030', '#181926');
    const c = this.iso(gx, gy);
    const mx = c.x, my = c.y - h - 9;
    ctx.fillStyle = '#0b0c17'; rr(ctx, mx - 12, my - 9, 24, 15, 3); ctx.fill();
    ctx.save(); ctx.globalAlpha = 0.85; ctx.fillStyle = color; rr(ctx, mx - 10, my - 7, 20, 11, 2); ctx.fill(); ctx.restore();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(mx, my + 6); ctx.lineTo(mx, my + 11); ctx.stroke();
  }

  drawPlant(gx: number, gy: number): void {
    const ctx = this.ctx;
    this.isoBox(gx - 0.16, gy - 0.16, 0.32, 0.32, 10, '#6a4326', '#553420', '#432818');
    const p = this.iso(gx, gy);
    ctx.fillStyle = '#3f9d5a';
    for (const o of [[-5, -16], [5, -16], [0, -22], [-3, -12], [3, -12]]) {
      ctx.beginPath(); ctx.arc(p.x + o[0], p.y + o[1], 6, 0, Math.PI * 2); ctx.fill();
    }
  }

  drawChar(c: Char, now: number): void {
    const ctx = this.ctx; const p = this.iso(c.gx, c.gy);
    const bob = c.moving ? Math.abs(Math.sin(c.bob)) * 4 : Math.sin(now / 600 + c.gx) * 1.3;
    const alpha = c.dim ? 0.4 : 1;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.beginPath(); ctx.ellipse(p.x, p.y, 13, 6, 0, 0, Math.PI * 2); ctx.fill();
    if (c.chosen) {
      const pulse = 0.5 + Math.sin(now / 300) * 0.25;
      ctx.strokeStyle = c.color; ctx.globalAlpha = alpha * pulse; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, 17, 8, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = alpha;
    }
    const cy = p.y - 20 - bob;
    ctx.fillStyle = c.color; ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 2;
    rr(ctx, p.x - 10, cy - 2, 20, 22, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    rr(ctx, p.x - 6 * c.face - (c.face < 0 ? 6 : 0), cy, 6, 13, 3); ctx.fill();
    ctx.font = '20px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(c.icon, p.x, cy - 10);
    // name label
    ctx.font = '700 10px "Baloo Thai 2", sans-serif';
    const wlab = ctx.measureText(c.name).width + 12;
    ctx.globalAlpha = alpha * 0.92;
    ctx.fillStyle = 'rgba(8,6,18,0.72)'; rr(ctx, p.x - wlab / 2, cy - 34, wlab, 15, 5); ctx.fill();
    ctx.fillStyle = c.color; ctx.fillText(c.name, p.x, cy - 26);
    ctx.globalAlpha = 1; ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }

  drawBubble(c: Char): void {
    const ctx = this.ctx; const p = this.iso(c.gx, c.gy);
    const work = !c.speech && c.working;
    const dots = '.'.repeat(1 + (Math.floor(performance.now() / 400) % 3));
    const text = c.speech || (work ? '⚙ กำลังทำงาน' + dots : '');
    if (!text) return;
    ctx.font = '600 11px "IBM Plex Sans Thai", sans-serif';
    const tw = ctx.measureText(text).width;
    const bw = tw + 18, bh = 22, bx = p.x - bw / 2, by = p.y - 74;
    ctx.fillStyle = work ? 'rgba(255,222,140,0.97)' : 'rgba(250,246,235,0.97)';
    rr(ctx, bx, by, bw, bh, 8); ctx.fill();
    ctx.beginPath(); ctx.moveTo(p.x - 5, by + bh); ctx.lineTo(p.x + 5, by + bh); ctx.lineTo(p.x, by + bh + 7); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#241a2e'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, p.x, by + bh / 2); ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }
}

// ---------- build party (leader + adventurers) ----------
function statsHtml(stats: [string, number][]): string {
  return stats.map(([k, v]) => {
    const pips = Array.from({ length: 5 }, (_, i) => `<span class="pip${i < v ? ' on' : ''}"></span>`).join('');
    return `<div class="stat"><span class="stat-k">${k}</span><span class="pips">${pips}</span></div>`;
  }).join('');
}
function heroCard(a: AgentInfo, leader: boolean): HTMLElement {
  const k: Klass = CLASS[a.key] || { role: a.role.toUpperCase(), th: '', icon: a.emoji, blurb: a.tagline, stats: [] };
  const card = el('article', 'hero' + (leader ? ' leader' : '') + (a.installed ? '' : ' is-missing'));
  card.dataset.agent = a.key;
  card.style.setProperty('--c', a.color);
  card.innerHTML = `
    <div class="hero-ribbon">CHOSEN!</div>
    <div class="hero-top">
      <div class="portrait">${k.icon}</div>
      <div class="hero-id">
        <div class="hero-name">${a.name}</div>
        <div class="hero-class">${k.role}${k.th ? ' · ' + k.th : ''}</div>
      </div>
      <span class="hero-badge" data-status="idle">${leader ? 'หัวหน้า' : 'พร้อม'}</span>
    </div>
    <div class="hero-blurb">${k.blurb} · <b>${a.model}</b></div>
    <div class="stats">${statsHtml(k.stats)}</div>
    <code class="hero-cmd">${cmdHtml(a.cmd, a.cli)}</code>
    <div class="hero-quest" data-role="quest" hidden></div>
    <div class="hpbar"><div class="hp-fill"></div></div>
    <div class="hero-report" data-role="report" hidden></div>
    <div class="hero-meta"><span data-role="time"></span></div>`;
  return card;
}
function buildParty(map: Record<string, AgentInfo>, workers: string[], orchestrator: string): void {
  const lw = $('#leaderwrap'); lw.innerHTML = '';
  if (map[orchestrator]) lw.appendChild(heroCard(map[orchestrator], true));
  const party = $('#party'); party.innerHTML = '';
  workers.forEach((w, i) => {
    if (!map[w]) return;
    const c = heroCard(map[w], false);
    c.style.animationDelay = (0.07 * i) + 's';
    party.appendChild(c);
  });
}

function card(key: string): HTMLElement | null {
  return document.querySelector(`.hero[data-agent="${key}"]`);
}
function setStatus(key: string, status: string, elapsed?: number): void {
  const c = card(key); if (!c) return;
  const badge = c.querySelector('.hero-badge') as HTMLElement;
  badge.dataset.status = status;
  badge.textContent = STATUS_TH[status] || status;
  // is-chosen / is-benched persist once set; is-working/done/error are transient
  if (status === 'chosen') { c.classList.add('is-chosen'); c.classList.remove('is-benched'); }
  else if (status === 'bench') { c.classList.add('is-benched'); }
  else if (status === 'thinking') { c.classList.add('is-working'); c.classList.remove('is-done', 'is-error'); }
  else if (status === 'done') { c.classList.remove('is-working'); c.classList.add('is-done'); }
  else if (status === 'error') { c.classList.remove('is-working'); c.classList.add('is-error'); }
  else if (status === 'idle') { c.classList.remove('is-working', 'is-done', 'is-error'); }
  if (elapsed != null) (c.querySelector('[data-role="time"]') as HTMLElement).textContent = `⏱ ${(elapsed / 1000).toFixed(1)}s`;
}

// ---------- narrator dialogue ----------
function addDialogue(from: string | undefined, text: string, error?: boolean): void {
  const who = from && agents[from] ? agents[from] : null;
  const line = el('div', 'dlg-line' + (error ? ' err' : ''));
  line.style.setProperty('--c', who ? who.color : '#ffd76a');
  const icon = who ? (CLASS[who.key]?.icon || who.emoji) : '📖';
  const name = who ? who.name : 'ผู้บรรยาย';
  line.innerHTML = `<div class="dlg-ava">${icon}</div><div><div class="dlg-who">${name}</div><div class="dlg-text">${esc(text)}</div></div>`;
  const box = $('#dialogue');
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// reveal the verdict block by block
function revealVerdict(node: HTMLElement, text: string): void {
  node.innerHTML = mdToHtml(text);
  Array.from(node.children).forEach((child, i) => {
    const kid = child as HTMLElement;
    kid.style.opacity = '0';
    kid.style.transform = 'translateY(8px)';
    kid.style.transition = 'opacity .4s, transform .4s';
    setTimeout(() => { kid.style.opacity = '1'; kid.style.transform = 'none'; }, 110 * i);
  });
}

// ---------- event dispatch ----------
function handle(ev: QEvent): void {
  switch (ev.type) {
    case 'connected':
      setConn('busy', 'เข้ากิลด์แล้ว'); break;

    case 'quest_start':
      agents = ev.agents || {};
      buildParty(ev.agents!, ev.workers!, ev.orchestrator!);
      $('#dialogue').innerHTML = '';
      ($('#liveTag') as HTMLElement).hidden = false;
      $('#verdict').classList.remove('show');
      $('#vdBody').innerHTML = '';
      $('#vdCost').innerHTML = '';
      questionText = ev.question || '';
      pickInfo = null;
      hideWorkHud();
      stage?.reset(ev.agents!);
      break;

    case 'phase':
      setPhase(ev.phase || ''); stage?.onPhase(ev.phase || ''); break;

    case 'agent_status':
      setStatus(ev.agent!, ev.status!, ev.elapsed);
      stage?.onStatus(ev.agent!, ev.status!);
      if (ev.agent !== 'athena' && ev.status === 'thinking') showWorkHud(ev.agent!);
      else if (ev.agent !== 'athena' && (ev.status === 'done' || ev.status === 'error')) hideWorkHud();
      break;

    case 'narration':
      addDialogue(ev.from, ev.text || '', ev.error); stage?.say(ev.from, ev.text || '', 4200); break;

    case 'decision': {
      const c = card(ev.agent!);
      if (c) {
        const q = c.querySelector('[data-role="quest"]') as HTMLElement;
        q.innerHTML = `⚔ <b>${esc(ev.title || 'ภารกิจ')}</b> — ${esc(ev.reason || '')}`;
        q.hidden = false;
      }
      pickInfo = { title: ev.title || 'ภารกิจ', reason: ev.reason || '' };
      stage?.say(ev.agent, '⚔ ' + (ev.title || 'ภารกิจ'), 4200);
      break;
    }

    case 'finding': {
      const c = card(ev.agent!);
      if (c) {
        const r = c.querySelector('[data-role="report"]') as HTMLElement;
        if (ev.error) { r.classList.add('err'); r.innerHTML = `<p class="md-h">${esc(ev.text)}</p>`; }
        else { r.classList.remove('err'); r.innerHTML = mdToHtml(ev.text || ''); }
        r.hidden = false;
        if (ev.elapsed != null) (c.querySelector('[data-role="time"]') as HTMLElement).textContent = `⏱ ${(ev.elapsed / 1000).toFixed(1)}s`;
      }
      stage?.say(ev.agent, ev.error ? '💥 พลาด' : '📜 สำเร็จ!', 3200);
      break;
    }

    case 'verdict': {
      $('#verdict').classList.add('show');
      const hero = ev.chosen && agents[ev.chosen] ? agents[ev.chosen] : null;
      if (hero) $('#vdSub').textContent = `Athena สรุปจากรายงานของ ${hero.emoji} ${hero.name}`;
      revealVerdict($('#vdBody'), ev.text || '');
      $('#verdict').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      break;
    }

    case 'cost':
      $('#vdCost').innerHTML =
        `🪙 ประเมิน <b>$${(ev.assess || 0).toFixed(4)}</b>` +
        `<br>🪙 สรุป <b>$${(ev.verdict || 0).toFixed(4)}</b>` +
        `<br>รวม <b>$${(ev.total || 0).toFixed(4)}</b>`;
      break;

    case 'done':
      finished = true;
      setPhase('done');
      stage?.celebrate();
      setConn('live', 'เควสสำเร็จ!');
      ($('#liveTag') as HTMLElement).hidden = true;
      // clear the per-round card highlights so the roster returns to neutral (matches the office)
      document.querySelectorAll('.hero').forEach((c) => c.classList.remove('is-chosen', 'is-benched'));
      endQuest();
      break;

    case 'error':
      toast('เกิดข้อผิดพลาด: ' + ev.message);
      setConn('err', 'ผิดพลาด');
      break;
  }
}

// ---------- run control ----------
function startQuest(): void {
  const q = ($('#q') as HTMLInputElement).value.trim();
  if (!q) { $('#q').focus(); toast('จารึกเควสก่อนนะ'); return; }
  if (es) es.close();
  finished = false;
  ($('#launch') as HTMLButtonElement).disabled = true;
  ($('#stop') as HTMLElement).hidden = false;
  setConn('busy', 'กำลังเรียกกิลด์…');

  es = new EventSource('/api/quest?q=' + encodeURIComponent(q));
  es.onmessage = (e: MessageEvent) => {
    try { handle(JSON.parse(e.data)); } catch (err) { console.error('bad event', e.data, err); }
  };
  es.onerror = () => {
    if (finished) return;               // normal close after done
    setConn('err', 'สัญญาณขาด');
    toast('การเชื่อมต่อกับกิลด์หลุด');
    endQuest();
  };
}
function endQuest(): void {
  if (es) { es.close(); es = null; }
  hideWorkHud();   // always tear down the work console + its timer, even on cancel/disconnect
  ($('#launch') as HTMLButtonElement).disabled = false;
  ($('#stop') as HTMLElement).hidden = true;
  ($('#liveTag') as HTMLElement).hidden = true;
}
function stopQuest(): void {
  finished = true;
  endQuest();
  setConn('', 'ยกเลิกแล้ว');
}

// ---------- scripted preview (no real CLIs) — open /rpg.html?demo ----------
function demoQuest(): void {
  const chosen = 'luna';
  const ev = (o: QEvent): void => handle(o);
  const seq: Array<[number, () => void]> = [
    [0,     () => ev({ type: 'quest_start', agents, workers: ['orion', 'luna', 'atlas'], orchestrator: 'athena', question: 'เลือก PostgreSQL หรือ MongoDB สำหรับแอปใหม่ เพราะอะไร' })],
    [300,   () => ev({ type: 'phase', phase: 'assess' })],
    [360,   () => ev({ type: 'agent_status', agent: 'athena', status: 'thinking' })],
    [500,   () => ev({ type: 'narration', from: 'athena', text: 'หัวหน้ากิลด์กำลังประเมินเควส…' })],
    [2600,  () => ev({ type: 'phase', phase: 'choose' })],
    [2650,  () => ev({ type: 'decision', agent: chosen, title: 'ไขปริศนาข้อมูล', reason: 'เหมาะกับงานวิเคราะห์เชิงลึก' })],
    [2700,  () => ev({ type: 'agent_status', agent: 'athena', status: 'done' })],
    [2760,  () => ev({ type: 'agent_status', agent: chosen, status: 'chosen' })],
    [2820,  () => { ev({ type: 'agent_status', agent: 'orion', status: 'bench' }); ev({ type: 'agent_status', agent: 'atlas', status: 'bench' }); }],
    [2900,  () => ev({ type: 'narration', from: 'athena', text: 'เลือก Luna ให้ลุยเควสนี้!' })],
    [4300,  () => ev({ type: 'phase', phase: 'quest' })],
    [4350,  () => ev({ type: 'agent_status', agent: chosen, status: 'thinking' })],
    [4400,  () => ev({ type: 'narration', from: chosen, text: 'กลับไปที่โต๊ะ เริ่มลงมือทำ…' })],
    [11000, () => ev({ type: 'phase', phase: 'report' })],
    [11050, () => ev({ type: 'finding', agent: chosen, text: '- ประเด็นสำคัญข้อที่หนึ่ง\n- ประเด็นสำคัญข้อที่สอง\n- ข้อควรระวังหนึ่งอย่าง' })],
    [11100, () => ev({ type: 'agent_status', agent: chosen, status: 'done' })],
    [11160, () => ev({ type: 'narration', from: chosen, text: 'เดินมารายงานผลให้หัวหน้า!' })],
    [12800, () => ev({ type: 'phase', phase: 'verdict' })],
    [12850, () => ev({ type: 'agent_status', agent: 'athena', status: 'thinking' })],
    [14600, () => { ev({ type: 'verdict', chosen, text: '- สรุปแนวทางที่เหมาะสม\n- เหตุผลประกอบสั้น ๆ\n\n**ข้อสรุป:** เลือกแนวทางนี้เพราะสมดุลที่สุด' }); ev({ type: 'cost', assess: 0, verdict: 0, total: 0 }); }],
    [15000, () => ev({ type: 'done' })],
  ];
  for (const pair of seq) setTimeout(pair[1], pair[0]);
}

// ---------- init ----------
function init(): void {
  const pc = $('#presets');
  PRESETS.forEach((p) => {
    const b = el('button', 'preset', p);
    b.onclick = () => { ($('#q') as HTMLInputElement).value = p; startQuest(); };
    pc.appendChild(b);
  });
  ($('#q') as HTMLInputElement).value = PRESETS[0];
  ($('#launch') as HTMLElement).onclick = startQuest;
  ($('#stop') as HTMLElement).onclick = stopQuest;
  $('#q').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') startQuest(); });

  const canvas = document.getElementById('office') as HTMLCanvasElement | null;
  if (canvas) stage = new Stage(canvas);

  // preload the roster to show the party (idle) before any quest starts
  fetch('/api/agents').then((r) => r.json()).then((d) => {
    agents = d.agents;
    buildParty(d.agents, d.workers, d.orchestrator);
    stage?.setRoster(d.agents);
    const missing = Object.values(d.agents as Record<string, AgentInfo>).filter((a) => !a.installed).map((a) => a.name);
    if (missing.length) toast('ยังไม่พบ CLI ของ: ' + missing.join(', ') + ' (จะข้ามตอนออกเควส)');
    if (location.search.includes('demo') || location.hash.includes('demo')) setTimeout(demoQuest, 700);
  }).catch(() => { /* opening the page statically is fine too */ });
}

// module scripts are already deferred, but guard in case the DOM isn't ready yet
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

export {}; // make this file an ES module (loaded via <script type="module">)
