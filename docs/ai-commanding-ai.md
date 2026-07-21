# ใช้ AI สั่ง AI ตัวอื่นได้ยังไง — จาก Agent CLI สู่ multi-agent orchestration

_ไล่ตั้งแต่ Agent CLI (Claude Code / Codex / Antigravity / OpenCode) คืออะไร → headless mode ที่ทำให้ "สั่งด้วยโปรแกรม" ได้ (claude -p, codex exec) → ไอเดียส่ง prompt ไปมาระหว่าง agent (pipe, server, โปรโตคอล MCP/A2A/ACP) → Hermes agent สั่ง agent ตัวอื่นด้วย delegate_task → จบด้วย demo ที่ Claude รับโจทย์แล้วกระจายงานให้ codex/antigravity/opencode ไป research แล้วสรุปกลับมา_

ปี 2026 เราไม่ได้ใช้ AI แค่ "ถาม-ตอบ" อีกต่อไป — เราเริ่มให้ AI ตัวหนึ่งเป็น "หัวหน้า" ที่แตกงานแล้วสั่ง AI ตัวอื่นไปทำขนานกัน (orchestrator-worker). โพสต์นี้ปูพื้นตั้งแต่ Agent CLI คืออะไร ไปจนถึงกลไกจริงที่ทำให้ agent คุยและสั่งกันได้ พร้อม code ตัวอย่างและ demo แบบกดเล่นได้

## จาก agent เดี่ยว สู่ orchestrator ที่สั่งลูกน้อง

agent ตัวเดียวเก่งแค่ไหนก็ยังทำงานทีละอย่างและมี context จำกัด — พองานใหญ่/ต้องค้นหลายมุมพร้อมกัน การให้ agent หนึ่งเป็น "orchestrator" ที่แตกงานแล้วสั่ง agent อื่นไปทำขนานกัน จะเร็วกว่าและ context ไม่ตัน

Anthropic เล่าในระบบ multi-agent research ของตัวเองว่า pattern ที่ใช้จริงคือ orchestrator-worker: มี lead agent วางแผนและกระจายงานให้ subagent เฉพาะทางทำขนานกัน แล้วรวมผล — ช่วยให้ค้นข้อมูลกว้าง ๆ ได้เร็วกว่าการให้ agent เดียวไล่ทีละอย่าง

> **แก่นของทั้งโพสต์**
>
> "AI สั่ง AI" = ทำให้ผลลัพธ์ของ agent หนึ่งกลายเป็น input/คำสั่งของอีกตัว — ไม่ว่าจะผ่าน command line (pipe), ผ่าน server (HTTP), หรือผ่านโปรโตคอลมาตรฐาน (MCP/A2A). ที่เหลือคือรายละเอียดว่า "ส่งต่อกันยังไง"

## Agent CLI คืออะไร — Claude Code / Codex / Antigravity / OpenCode

Agent CLI คือ AI agent ที่รันในเทอร์มินัล — มันไม่ได้แค่ตอบข้อความ แต่ "ลงมือทำ" ได้: อ่าน/แก้ไฟล์, รันคำสั่ง shell, ค้นเว็บ, วน loop คิด-ทำ-ดูผล จนกว่างานจะเสร็จ. ทั้ง 4 ตัวนี้แนวคิดคล้ายกัน แต่ต่างเจ้าของและจุดเด่น

| Agent CLI | เจ้าของ | จุดเด่น / บทบาท |
| --- | --- | --- |
| Claude Code | Anthropic | coding agent ในเทอร์มินัล + SDK ; มี headless (`claude -p`), subagents, MCP, hooks — เหมาะเป็น orchestrator |
| Codex CLI | OpenAI | coding agent ; `codex exec` รัน non-interactive + `--json` + `resume` ต่อ session ; sandbox คุมสิทธิ์ |
| Antigravity | Google | agentic dev platform (IDE + CLI + SDK) มี "Manager Surface" สั่ง/สังเกต agent หลายตัวแบบ async ; ใช้ Gemini (สืบทอดจาก Gemini CLI) |
| OpenCode | SST (open-source) | agent ในเทอร์มินัล สถาปัตยกรรม client/server — รันบนเครื่องแล้ว drive จาก mobile/API ได้ ; มี Agent System กำหนด mode/สิทธิ์ต่อ agent |

_4 Agent CLI ที่จะใช้ในโพสต์นี้ — แนวคิดเดียวกัน (loop คิด-ทำ-ดูผล) ต่างที่ระบบนิเวศ_

> **อ่านต่อเรื่อง Agent CLI แบบเจาะลึก**
>
> ในเว็บนี้มีโพสต์ที่ผ่ากลไกข้างในของ Agent CLI แบบละเอียด (loop, harness, tools) — ดูโพสต์ /posts/agent-cli และซีรีส์ harness-engineering (ลิงก์ท้ายบทความ)

## Headless mode — ประตูที่ทำให้ "สั่งด้วยโปรแกรม" ได้

หัวใจที่ทำให้ AI สั่ง AI ได้คือ headless / non-interactive mode: รัน agent โดยไม่มี UI โต้ตอบ — ป้อน prompt เข้าไป, มันทำงานจนจบ, แล้วพ่นผลออกทาง stdout แล้วปิดตัว. เมื่อ output เป็นข้อความ/JSON บน stdout ได้ มันก็กลายเป็น "เครื่องมือ command line" ธรรมดาที่เอาไปต่อท่อ (pipe) หรือเรียกจาก script ได้

**Claude Code — claude -p** — flag `-p`/`--print` ให้ Claude รับ prompt แล้วทำงานจบในครั้งเดียว. `--output-format` เลือกได้ 3 แบบ: text (ดีฟอลต์), json (มี result, session_id, total_cost_usd, metadata), stream-json (NDJSON ทีละ event เหมาะ streaming). ออกแบบมาสำหรับ 3 ที่: shell script, cron, และ CI

**`claude -p (headless)`**

```bash
# สั่งงานครั้งเดียว ได้ผลเป็น JSON (มี cost + session id)
claude -p "สรุป bug ที่เสี่ยงสุดใน src/ เป็น bullet" --output-format json

# อ่าน prompt จาก stdin แล้วต่อท่อผลไปคำสั่งอื่น (เหมือน unix tool)
cat error.log | claude -p "จัดกลุ่ม error พวกนี้แล้วบอก root cause"

# ดึงเฉพาะ .result ด้วย jq แล้วส่งต่อให้ codex ทำต่อ
claude -p "list ไฟล์ที่ต้อง refactor" --output-format json \
  | jq -r .result \
  | codex exec "refactor ไฟล์ตามรายการนี้"
```

**Codex — codex exec** — `codex exec "task"` คือโหมด headless ของ Codex — model/tools เดียวกับแบบ interactive แต่ไม่มี UI. `--json` ทำให้ stdout เป็น JSONL ทุก event (รันคำสั่ง/แก้ไฟล์/ข้อความ) parse ด้วย jq ได้ ; `resume --last` ต่อ session เดิมได้ (ทำ pipeline 2 สเต็ป) ; sandbox ดีฟอลต์ read-only (ปรับเป็น workspace-write ได้) ; CI ใช้ API key ผ่าน CODEX_API_KEY

**`codex exec (2-stage pipeline)`**

```bash
# สเต็ป 1: หา race condition (read-only)
codex exec "review การเปลี่ยนแปลงนี้ หา race condition"

# สเต็ป 2: ต่อจาก session เดิม ให้แก้ตามที่เพิ่งเจอ
codex exec resume --last "fix race condition ที่เพิ่งพบ" --sandbox workspace-write
```

**Antigravity — agy --print** — Antigravity CLI (คำสั่ง `agy`) คือ coding agent ของ Google (ใช้ auth ของ host ที่ `~/.gemini/antigravity-cli` — ไม่ต้องมี API key). โหมด headless ใช้ flag `--print` (ต้องวางท้ายสุดเพราะ Go flag กิน arg ถัดไปเป็น value) ให้รับ prompt แล้วทำงานจบครั้งเดียวพ่นผลออก stdout ; `--model` เลือกโมเดล, `--add-dir` เปิดโฟลเดอร์เพิ่มให้ agent เห็น. ⚠️ flag `--sandbox` ของมันกันแค่ terminal tool ไม่ได้กันการเขียนไฟล์ — ถ้าจะรันแบบไม่เชื่อใจ ควรครอบด้วย sandbox ของระบบ (เช่น bwrap) อีกชั้น

**`agy --print (headless)`**

```bash
# สั่งงานครั้งเดียว ได้ผลออก stdout (--print ท้ายสุดเสมอ)
agy --model gemini-2.5-pro --print "สรุปว่าไฟล์ไหนใน src/ เสี่ยง null pointer"

# รับผลจาก agent ตัวอื่นมาต่อ แล้วให้ agy ทำต่อ
claude -p "list ไฟล์ที่ควรเขียน test เพิ่ม" --output-format json \
  | jq -r .result \
  | xargs -I{} agy --print "เขียน unit test ให้ไฟล์ {}"
```

**OpenCode — opencode run** — OpenCode เป็น coding agent แบบ open-source บนเทอร์มินัล. โหมด non-interactive ใช้ `opencode run "message"` — รัน prompt เดียวจบแล้วพ่นผลออก stdout เหมือน unix tool ; `-m provider/model` เลือกโมเดล (เช่น `anthropic/claude-sonnet-5`), `-c`/`--continue` ต่อจาก session ล่าสุดเพื่อทำ pipeline หลายสเต็ป. เพราะ output เป็น stdout ล้วน จึงต่อท่อเข้า/ออกกับ agent ตัวอื่นได้ทันที

**`opencode run (headless)`**

```bash
# สั่งงานครั้งเดียว เลือกโมเดล แล้วพ่นผลออก stdout
opencode run -m anthropic/claude-sonnet-5 "อธิบายว่า auth flow ใน repo นี้ทำงานยังไง"

# 2 สเต็ป: หาแล้วแก้ต่อจาก session เดิม
opencode run "หา dead code ในโฟลเดอร์ lib/"
opencode run -c "ลบ dead code ที่เพิ่งเจอออกให้หมด"
```

## ส่ง prompt ไปมาระหว่าง agent ได้กี่แบบ

เมื่อ agent รัน headless ได้แล้ว การ "ส่งงานให้กัน" มีหลายระดับ ตั้งแต่ง่ายสุด (ท่อ shell) ไปจนถึงเป็นระบบ (server + โปรโตคอล)

- **1) Subprocess / pipe (ง่ายสุด)** เรียก agent อีกตัวเป็น subprocess แล้วต่อท่อ stdout→stdin — เขียน bash/Python สั้น ๆ ก็ได้ orchestrator แล้ว (เช่น `claude -p ... | codex exec ...`). ข้อดี: ไม่ต้องมี infra ; ข้อจำกัด: state น้อย, ต้องจัดการ error เอง
- **2) Server / HTTP API** agent บางตัวเปิดเป็น server ได้ — OpenCode สถาปัตยกรรม client/server (รันบนเครื่องแล้วเรียกจาก API/mobile), Antigravity มี "Manager Surface" spawn/สังเกต agent หลายตัว async. ทำให้ orchestrator เรียก worker ข้ามเครื่อง/ข้ามภาษาได้ผ่าน HTTP
- **3) โปรโตคอลมาตรฐาน (MCP / A2A / ACP)** แทนที่จะ hardcode วิธีคุย ใช้โปรโตคอลกลาง — MCP เชื่อม agent↔tool, A2A เชื่อม agent↔agent (ดูหัวข้อถัดไป). ข้อดี: agent ต่างเจ้าคุยกันได้ด้วยภาษาเดียว
- **4) "เว็บให้ agent คุยกัน"** หลายคนทำหน้าเว็บ/แดชบอร์ดที่ให้ agent หลายตัวส่งข้อความหากันเป็น thread แล้วดูบทสนทนาสด ๆ — จริง ๆ เบื้องหลังคือ pattern orchestrator-worker (หรือ peer-to-peer A2A) ที่ห่อด้วย UI ให้เห็นภาพว่าใครสั่งใคร/ตอบอะไร

**`orchestrator.sh — Claude วางแผน → กระจาย → รวม`**

```bash
#!/usr/bin/env bash
Q="$1"

# 1) Claude วางแผน แตกเป็น 3 subtask (ออกมาเป็น 3 บรรทัด)
mapfile -t TASKS < <(claude -p "แตกโจทย์นี้เป็น 3 subtask สำหรับ research (บรรทัดละ 1): $Q" --output-format json | jq -r .result)

# 2) กระจายให้ 3 agent รันขนานกัน (& = background) แล้วเก็บผล
codex        exec "${TASKS[0]}" > r1.txt &
opencode run "${TASKS[1]}"      > r2.txt &
antigravity  run "${TASKS[2]}"  > r3.txt &
wait   # รอทุกตัวเสร็จ

# 3) Claude รวม finding ทั้งหมดเป็นคำตอบเดียว
cat r1.txt r2.txt r3.txt | claude -p "รวม finding เหล่านี้ตอบโจทย์: $Q"
```

> **สังเกต**
>
> orchestrator ไม่จำเป็นต้องเป็น AI ที่ฉลาดกว่า — บ่อยครั้งมันแค่ "คนวางแผน + คนรวมผล" ส่วน worker คือคนลงมือ. ความเก่งของระบบมาจาก "การแบ่งงาน" ไม่ใช่ agent ตัวใดตัวหนึ่ง

## MCP vs A2A vs ACP — โปรโตคอลให้ agent คุยกัน

ถ้าไม่อยาก hardcode วิธีคุยของแต่ละคู่ agent มีโปรโตคอลกลางเกิดขึ้นในปี 2025–2026 ที่แบ่งบทบาทกันชัด

| โปรโตคอล | เชื่อมอะไร | รูปแบบ | เจ้าของ |
| --- | --- | --- | --- |
| MCP (Model Context Protocol) | agent ↔ tool/data | hub-and-spoke, JSON-RPC 2.0 | Anthropic (ตอนนี้ Linux Foundation) |
| A2A (Agent2Agent) | agent ↔ agent | peer-to-peer, Agent Card ผ่าน HTTP/SSE | Google Cloud + 50+ พาร์ตเนอร์ |
| ACP (Agent Communication Protocol) | agent ↔ agent | REST-based, ไม่ต้องมี SDK | IBM BeeAI |

_MCP = ต่อเครื่องมือให้ agent (แนวตั้ง) ; A2A/ACP = ให้ agent คุยกันเอง (แนวนอน) — ใช้คู่กันได้_

> **เลือกยังไง**
>
> อยากให้ agent เข้าถึงเครื่องมือ/ข้อมูล → MCP ; อยากให้ agent หลายตัว (อาจต่างเจ้า/ต่างองค์กร) มอบหมายงานหากัน → A2A/ACP. ในทางปฏิบัติระบบใหญ่มักใช้ทั้งสองชั้น: A2A ให้ agent สั่งกัน + MCP ให้แต่ละ agent ต่อ tool ของตัวเอง

## Hermes agent สั่ง agent ตัวอื่นด้วย delegate_task

Hermes Agent (open-source personal agent ของ Nous Research) เป็นตัวอย่างที่การ "สั่ง agent อื่น" ถูกฝังเป็น first-class feature ผ่าน tool ชื่อ delegate_task

- **spawn ลูกที่แยกขาดจากกัน** Hermes แตก subagent เป็นลูกที่ทำงานขนานได้ — แต่ละตัวมี conversation, terminal session, และ toolset ของตัวเอง. สำคัญคือ "เฉพาะ summary สุดท้าย" เท่านั้นที่กลับมา ; tool call ระหว่างทางไม่รก context ของพ่อ
- **orchestrator ซ้อนชั้นได้** subagent ที่ตั้ง role="orchestrator" จะยังมี delegate_task ต่อได้ (แตกหลานได้) — แต่ต้องเปิด delegation.max_spawn_depth ให้ >1 (ดีฟอลต์ 1 กันแตกลึกเกิน)
- **ขนาน + async** batch ดีฟอลต์รัน 3 subagent พร้อมกัน (ปรับ delegation.max_concurrent_children ใน config.yaml) ; และ delegate แบบ async ได้ = งานที่มอบหมายไม่บล็อกแชตพ่อ. โหมด CLI โชว์ tree-view ของ tool call แต่ละ subagent แบบ real-time

**`config.yaml — คุมการ delegate ของ Hermes`**

```yaml
delegation:
  max_concurrent_children: 3   # กี่ subagent รันพร้อมกันต่อ batch
  max_spawn_depth: 2           # ให้ orchestrator แตกหลานได้ (ดีฟอลต์ 1)

# subagent ที่เป็น orchestrator จะยังเรียก delegate_task ต่อได้
# ส่วน worker ธรรมดาจะทำงานที่ได้รับมอบหมายแล้วส่ง summary กลับ
```

> **แนวคิดร่วมของทุกเจ้า**
>
> Claude Code (subagents/Task tool), Hermes (delegate_task), Antigravity (Manager Surface) — ทุกตัวใช้ไอเดียเดียวกัน: แตกงานให้ลูกที่ context แยกกัน ทำขนาน แล้วรวมเฉพาะ "ผลสรุป" กลับ เพื่อไม่ให้ context ของ orchestrator ล้น

## Demo — Claude รับโจทย์ แล้วกระจายให้ codex / antigravity / opencode

รวมทุกอย่างเข้าด้วยกันเป็น pattern orchestrator-worker: เลือกโจทย์ กด "เริ่ม" แล้วดู Claude แตกโจทย์เป็น subtask, กระจายให้ 3 agent ไป research ขนานกัน (สังเกต command แบบ headless ที่แต่ละตัวรัน), ทยอยส่ง finding กลับ แล้ว Claude สังเคราะห์เป็นคำตอบเดียว

> **⚠️ demo นี้เป็นการจำลอง**
>
> demo ข้างบนใช้ canned response + หน่วงเวลาเพื่อโชว์ "flow" การกระจายงาน ไม่ได้เรียก CLI จริง (การรัน CLI จริงต้องมี agent ติดตั้ง + คีย์ + backend). แต่ command ที่โชว์ (`codex exec`, `opencode run`, `claude -p`) คือรูปแบบจริงที่ orchestrator script ใช้

## ข้อควรระวัง + สรุป

- **ค่าใช้จ่ายทวีคูณ** orchestrator + N worker = จ่าย token หลายเท่าของ agent เดียว. ใช้ `--output-format json` ดู total_cost_usd ต่อ run และตั้งเพดาน ; มอบหมายเฉพาะงานที่ "แตกแล้วคุ้ม" (ค้นหลายมุม/งานขนานจริง) ไม่ใช่ทุกอย่าง
- **loop / แตกลึกไม่รู้จบ** ถ้า orchestrator แตกลูก-หลานได้ไม่จำกัด อาจวนไม่จบ — จำกัดด้วย max_spawn_depth / max_concurrent (เหมือน Hermes) และกำหนด completion condition ชัด ๆ
- **context + การรวมผล** อย่าดึง output ดิบทั้งหมดของ worker กลับเข้า orchestrator (context ล้าน) — ให้ worker "สรุป" ก่อนส่งกลับ (pattern summary-only ของ subagent) แล้ว orchestrator ค่อยสังเคราะห์
- **ความปลอดภัย** worker ที่รันคำสั่ง shell/แก้ไฟล์ได้ = ผิวสัมผัสความเสี่ยง. ใช้ sandbox (codex read-only เป็นดีฟอลต์), จำกัดสิทธิ์ทีละ agent (OpenCode Agent System), และอย่าให้ agent แตะ secret/prod โดยไม่มีคนกำกับ

> **สรุปบรรทัดเดียว**
>
> "AI สั่ง AI" เกิดได้เพราะ headless mode ทำให้ agent เป็นเครื่องมือ command line — จากนั้นต่อกันด้วย pipe / server / โปรโตคอล (MCP ต่อ tool, A2A ให้ agent คุยกัน) ; pattern ที่ใช้จริงคือ orchestrator-worker (Claude/Hermes แตกงานให้ลูกที่ context แยกกันทำขนาน แล้วรวม summary) — ความเก่งอยู่ที่ "การแบ่งงาน" ไม่ใช่ agent ตัวเดียว

## อ้างอิง

- [Claude Code — Headless / programmatic mode (claude -p, --output-format)](https://code.claude.com/docs/en/headless)
- [OpenAI Codex — Non-interactive mode (codex exec, --json, resume, sandbox)](https://developers.openai.com/codex/noninteractive)
- [Anthropic — How we built our multi-agent research system (orchestrator-worker)](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Google Developers — Announcing the Agent2Agent (A2A) Protocol](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [A Survey of Agent Interoperability Protocols: MCP, ACP, A2A, ANP (arXiv)](https://arxiv.org/abs/2505.02279)
- [Nous Research — Hermes Agent: Subagent Delegation & Delegation Patterns](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation/)
- [Google Developers — Build with Google Antigravity (Manager Surface)](https://developers.googleblog.com/build-with-google-antigravity-our-new-agentic-development-platform/)
- [OpenCode (SST) — Agent System (client/server, agent modes)](https://opencode.ai/docs/)
- [Addy Osmani — The Code Agent Orchestra (multi-agent coding)](https://addyosmani.com/blog/code-agent-orchestra/)
- [โพสต์ในเว็บนี้: Agent CLI คืออะไร + ลองทำเอง](/posts/agent-cli)
