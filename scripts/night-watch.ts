/**
 * Night Watch board — overnight progress canvas for the sleeping operator.
 * Renders from live state (profiles API, ledger) + a training-status JSON the
 * watch maintains + the mlx_lm training log when one exists.
 *
 *   bun scripts/night-watch.ts <output.html> [status.json] [training.log]
 */
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'fs'

const OUT = process.argv[2]
const STATUS_PATH = process.argv[3]
const TRAIN_LOG = process.argv[4]
if (!OUT) { console.error('usage: bun scripts/night-watch.ts <out.html> [status.json] [train.log]'); process.exit(1) }

const API = 'http://127.0.0.1:3031'
const QUOTE = 1_747_571
const TRIGGER = 1_800_000
const MORG = 'a9e3b41a-ed67-4891-b847-eb5a806fffb2'
const NIGHT_START = '2026-08-28 04:00'

const db = new Database('data/admiral.db', { readonly: true })
const profiles = (await (await fetch(`${API}/api/profiles`)).json()) as Array<Record<string, any>>
const fmt = (n: number) => n.toLocaleString('en-US')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Training status (watch-maintained JSON) + loss from mlx log
type TStatus = { stage: string; detail: string; started_at?: string; eta?: string; stages_done?: string[] }
let ts: TStatus = { stage: 'corpus', detail: 'corpus build + smoke test running', stages_done: [] }
if (STATUS_PATH && existsSync(STATUS_PATH)) { try { ts = JSON.parse(readFileSync(STATUS_PATH, 'utf8')) } catch {} }
let lossPoints: Array<{ it: number; loss: number }> = []
let valPoints: Array<{ it: number; loss: number }> = []
let lastTrainLine = ''
let lastIter = 0
let lastTokS = 0
if (TRAIN_LOG && existsSync(TRAIN_LOG)) {
  // mlx_lm colorizes its output — strip ANSI escapes before parsing/rendering.
  // Table format:  "    10    2.874 ▼       69      6.8k"  /  "     1    val 3.137    5.71s"
  const lines = readFileSync(TRAIN_LOG, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n')
  for (const l of lines) {
    let m = l.match(/^\s*(\d+)\s+val\s+([\d.]+)/)
    if (m) { valPoints.push({ it: +m[1], loss: +m[2] }); lastIter = Math.max(lastIter, +m[1]); continue }
    m = l.match(/^\s*(\d+)\s+([\d.]+)\s*[▼▲]?\s+(\d+)\s/)
    if (m) { lossPoints.push({ it: +m[1], loss: +m[2] }); lastIter = Math.max(lastIter, +m[1]); lastTokS = +m[3]; continue }
    if (l.includes('Error') || l.includes('RuntimeError')) lastTrainLine = l.trim().slice(0, 140)
  }
  if (!lastTrainLine && lossPoints.length) {
    const p = lossPoints[lossPoints.length - 1]
    lastTrainLine = `iter ${p.it} · train loss ${p.loss.toFixed(3)} · ${lastTokS} tok/s`
  }
}
// Progress meter + ETA
const totalIters = Number((ts as any).total_iters ?? 0)
let meterHtml = ''
if (totalIters > 0 && lastIter > 0) {
  const pct = Math.min(100, (lastIter / totalIters) * 100)
  let etaStr = ''
  if (ts.started_at) {
    const elapsedMin = (Date.now() - Date.parse(ts.started_at)) / 60000
    if (elapsedMin > 1) {
      const remMin = Math.max(0, (totalIters - lastIter) * (elapsedMin / lastIter))
      etaStr = ` · ~${Math.floor(remMin / 60)}h ${Math.round(remMin % 60)}m remaining`
    }
  }
  meterHtml = `<div class="rail" style="margin-top:12px"><div class="fill" style="width:${pct.toFixed(1)}%;background:linear-gradient(90deg,#2A5A50,var(--moon))"></div></div>
  <div class="rail-labels"><span><b>iter ${lastIter} / ${totalIters}</b> (${pct.toFixed(1)}%)</span><span>${lastTokS ? lastTokS + ' tok/s' : ''}${etaStr}</span></div>`
}

const STAGES = [
  { id: 'corpus', label: 'Corpus build' },
  { id: 'smoke', label: 'Smoke test' },
  { id: 'training', label: 'QLoRA training' },
  { id: 'eval', label: 'Eval drills' },
  { id: 'done', label: 'Ready for review' },
]
const curIdx = Math.max(0, STAGES.findIndex(s => s.id === ts.stage))
const stageRow = STAGES.map((s, i) => {
  const cls = i < curIdx ? 'done' : i === curIdx ? 'now' : 'todo'
  return `<div class="stage ${cls}"><span class="dot"></span>${s.label}</div>`
}).join('<div class="stage-link"></div>')

// Loss sparkline (inline SVG)
let lossSvg = ''
if (lossPoints.length >= 2) {
  const w = 560, h = 120, pad = 8
  const xs = lossPoints.map(p => p.it), ys = lossPoints.map(p => p.loss)
  const xmin = Math.min(...xs), xmax = Math.max(...xs)
  const ymin = Math.min(...ys), ymax = Math.max(...ys)
  const X = (v: number) => pad + ((v - xmin) / Math.max(1, xmax - xmin)) * (w - 2 * pad)
  const Y = (v: number) => h - pad - ((v - ymin) / Math.max(0.001, ymax - ymin)) * (h - 2 * pad)
  const path = lossPoints.map((p, i) => `${i ? 'L' : 'M'}${X(p.it).toFixed(1)},${Y(p.loss).toFixed(1)}`).join(' ')
  const last = lossPoints[lossPoints.length - 1]
  lossSvg = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;max-width:${w}px;display:block">
    <path d="${path}" fill="none" stroke="#7FD4C1" stroke-width="2"/>
    <circle cx="${X(last.it).toFixed(1)}" cy="${Y(last.loss).toFixed(1)}" r="4" fill="#7FD4C1"/>
    <text x="${w - pad}" y="14" text-anchor="end" fill="#8A94A8" font-size="11" font-family="monospace">iter ${last.it} · loss ${last.loss.toFixed(3)} (start ${lossPoints[0].loss.toFixed(3)})</text>
  </svg>`
}

// Fleet
const morg = profiles.find(p => p.id === MORG)
const wallet = Number(morg?.gameState?.credits ?? 0) ||
  Number((db.query(`SELECT balance_after FROM financial_ledger WHERE profile_id=? AND balance_after IS NOT NULL ORDER BY id DESC LIMIT 1`).get(MORG) as any)?.balance_after ?? 0)
const trigPct = Math.min(100, (wallet / TRIGGER) * 100).toFixed(1)
const nowIso = new Date().toISOString()
const stamp = nowIso.slice(0, 10) + ' · ' + nowIso.slice(11, 16) + ' UTC'

const lastLog = (pid: string) => (db.query(`SELECT timestamp FROM log_entries WHERE profile_id = ? ORDER BY id DESC LIMIT 1`).get(pid) as any)?.timestamp ?? ''
const age = (t: string) => { if (!t) return '—'; const m = Math.floor((Date.now() - Date.parse(t.replace(' ', 'T') + 'Z')) / 60000); return m < 1 ? 'now' : m + 'm' }
const riderRows = profiles.filter(p => p.running).map(p => {
  const gs = p.gameState ?? {}
  return `<tr><td class="agent-name">${esc(String(p.name).split(' - ')[0])}</td><td class="job">${esc(String(gs.system || '—'))}</td><td class="num">${gs.credits != null ? fmt(Number(gs.credits)) : '—'}</td><td class="num">${age(lastLog(p.id))}</td></tr>`
}).join('')
const parkedRows = profiles.filter(p => !p.running).map(p => {
  const dock = (db.query(`SELECT summary FROM log_entries WHERE profile_id=? AND (summary LIKE '%docked_at:%' OR summary LIKE '%Docked at%') ORDER BY id DESC LIMIT 1`).get(p.id) as any)?.summary ?? ''
  const m = String(dock).match(/[Dd]ocked(?:_at:| at) ([a-z_A-Z' ]+)/)
  return `<tr><td class="agent-name">${esc(String(p.name).split(' - ')[0])}</td><td class="job">${esc(m?.[1]?.trim() ?? 'docked')}</td></tr>`
}).join('')

// Overnight events
const events = db.query(`
  SELECT p.name AS name, f.timestamp AS ts, f.kind AS kind, f.item_id AS item, f.amount_signed AS amt
  FROM financial_ledger f JOIN profiles p ON p.id=f.profile_id
  WHERE f.timestamp > ? AND f.kind NOT IN ('escrow','fuel') AND ABS(f.amount_signed) >= 1000
  ORDER BY f.id DESC LIMIT 14`).all(NIGHT_START) as Array<Record<string, any>>
const eventRows = events.map(e =>
  `<li><span class="t">${String(e.ts).slice(11, 16)}</span><span>${esc(String(e.name).split(' - ')[0])}: ${e.kind}${e.item ? ' ' + esc(String(e.item)) : ''} <span class="amt ${e.amt >= 0 ? 'up' : 'down'}">${e.amt >= 0 ? '+' : '−'}${fmt(Math.abs(e.amt))}</span></span></li>`
).join('') || '<li><span class="t">—</span><span>quiet so far</span></li>'

const html = `<title>Night Watch</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
  :root { --ground:#080B12; --panel:#10141F; --panel-2:#0C0F18; --wire:#1F2A44; --ink:#D6DEEA; --muted:#7E8AA3;
    --moon:#7FD4C1; --brass:#F2B33D; --good:#63B57E; --warn:#E0823F; --crit:#D96060;
    --display:"Chakra Petch","Arial Narrow",sans-serif; --body:"IBM Plex Sans",sans-serif; --mono:"IBM Plex Mono",monospace; }
  *{box-sizing:border-box} body{background:var(--ground);color:var(--ink);font-family:var(--body);margin:0;padding:24px 20px 48px;line-height:1.55}
  .board{max-width:940px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
  header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 18px;border-bottom:2px solid var(--moon);padding-bottom:12px}
  h1{font-family:var(--display);font-weight:700;font-size:24px;letter-spacing:.08em;text-transform:uppercase;margin:0}
  h1 .dim{color:var(--moon)}
  .stamp{font-family:var(--mono);font-size:12px;color:var(--muted);margin-left:auto}
  section{background:var(--panel);border:1px solid var(--wire);padding:16px 18px}
  section>h2{font-family:var(--display);font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--moon);margin:0 0 12px}
  section>h2 .sub{color:var(--muted);letter-spacing:.04em;text-transform:none;font-family:var(--body);font-weight:400;font-size:12px;margin-left:10px}
  .stages{display:flex;align-items:center;flex-wrap:wrap;gap:6px 0;margin-bottom:10px}
  .stage{display:flex;align-items:center;gap:7px;font-family:var(--display);font-size:12px;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
  .stage .dot{width:10px;height:10px;border-radius:50%;border:2px solid var(--wire);background:var(--panel-2)}
  .stage.done{color:var(--good)} .stage.done .dot{background:var(--good);border-color:var(--good)}
  .stage.now{color:var(--moon)} .stage.now .dot{background:var(--moon);border-color:var(--moon);box-shadow:0 0 8px var(--moon)}
  .stage.todo{color:var(--muted)}
  .stage-link{flex:1 0 18px;height:2px;background:var(--wire);margin:0 8px;min-width:14px}
  .detail{font-family:var(--mono);font-size:13px;color:var(--ink)}
  .detail small{color:var(--muted)}
  .rail{position:relative;height:26px;background:var(--panel-2);border:1px solid var(--wire);margin-top:10px}
  .rail .fill{position:absolute;inset:0 auto 0 0;width:${trigPct}%;background:linear-gradient(90deg,#5A4A1E,var(--brass))}
  .rail .tick{position:absolute;top:-5px;bottom:-5px;width:2px;background:var(--crit);left:100%}
  .rail-labels{display:flex;justify-content:space-between;font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-top:8px;flex-wrap:wrap;gap:4px 12px}
  .rail-labels b{color:var(--ink)}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start}
  @media(max-width:760px){.cols{grid-template-columns:1fr}}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th{font-family:var(--display);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);text-align:left;padding:5px 8px;border-bottom:1px solid var(--wire)}
  td{padding:6px 8px;border-bottom:1px solid var(--panel-2)} tr:last-child td{border-bottom:none}
  td.num{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
  .agent-name{font-weight:600} .job{color:var(--muted);font-size:12px}
  ol.ev{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:13px}
  ol.ev li{display:grid;grid-template-columns:50px 1fr;gap:10px;padding:4px 0;border-bottom:1px solid var(--panel-2)}
  ol.ev li:last-child{border-bottom:none}
  ol.ev .t{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
  .amt{font-family:var(--mono);font-variant-numeric:tabular-nums} .up{color:var(--good)} .down{color:var(--crit)}
  .morning{border-left:3px solid var(--moon);background:var(--panel-2);padding:10px 14px;font-size:13.5px}
  .morning b{color:var(--moon)}
  footer{color:var(--muted);font-family:var(--mono);font-size:11px;text-align:center}
</style>
<div class="board">
  <header>
    <h1>Night <span class="dim">Watch</span></h1>
    <span class="stamp"><span id="stamp-age" data-snap="${nowIso}">${stamp}</span> · regenerated each tick</span>
  </header>

  <section>
    <h2>v4 Training Pipeline<span class="sub">QLoRA on Qwen3.6-35B-A3B · GPU cleared, servers parked</span></h2>
    <div class="stages">${stageRow}</div>
    <div class="detail">${esc(ts.detail)}${ts.eta ? ` <small>· ETA ${esc(ts.eta)}</small>` : ''}</div>
    ${meterHtml}
    ${lastTrainLine ? `<div class="detail" style="margin-top:6px"><small>${esc(lastTrainLine)}</small></div>` : ''}
    ${lossSvg ? `<div style="margin-top:12px">${lossSvg}</div>` : ''}
  </section>

  <section>
    <h2>Commission<span class="sub">the go/no-go waits for Brian — never auto-placed</span></h2>
    <div class="detail"><b class="amt">${fmt(wallet)}</b> cr of <b class="amt">1,800,000</b> trigger <small>(quote ${fmt(QUOTE)})</small></div>
    <div class="rail"><div class="fill"></div><div class="tick"></div></div>
    <div class="rail-labels"><span><b>${trigPct}%</b> to trigger</span><span>at trigger: Morg docks War Citadel, quotes, and HOLDS</span></div>
  </section>

  <div class="cols">
    <section>
      <h2>Riding tonight<span class="sub">all on Haiku for the training window</span></h2>
      <table><thead><tr><th>Agent</th><th>System</th><th style="text-align:right">Wallet</th><th style="text-align:right">Last log</th></tr></thead>
      <tbody>${riderRows}</tbody></table>
    </section>
    <section>
      <h2>Parked · safe-docked</h2>
      <table><thead><tr><th>Agent</th><th>Dock</th></tr></thead><tbody>${parkedRows}</tbody></table>
      <p class="job" style="margin:8px 0 0">Wallet-zero four stay parked until the Friday repossession probe.</p>
    </section>
  </div>

  <section>
    <h2>Overnight ledger<span class="sub">events ≥1,000cr since 04:00 UTC</span></h2>
    <ol class="ev">${eventRows}</ol>
  </section>

  <section class="morning">
    <b>For 9am:</b> expect the trained v4 adapter + loss curve, the market-drill eval score, the commission
    go/no-go if the trigger crossed, and the restored local-model lineup (Bob/Rook back on v3, Grit back on
    Qwen) once training releases the GPU. Anything that broke overnight is in this board's ledger and the
    session transcript.
  </section>

  <footer>the watch runs every 15 min · nothing irreversible happens while you sleep</footer>
</div>
<script>
  (function(){var el=document.getElementById('stamp-age');if(!el)return;var snap=Date.parse(el.getAttribute('data-snap')||'');if(!snap)return;
  function r(){var m=Math.max(0,Math.floor((Date.now()-snap)/60000));var lab=m<1?'just now':m<60?m+'m ago':Math.floor(m/60)+'h '+(m%60)+'m ago';
  el.textContent=el.textContent.replace(/( · .*)?$/,'')||el.textContent;el.title='Snapshot '+lab;el.style.color=m>=25?'var(--warn)':''}
  r();setInterval(r,30000)})()
</script>
`
await Bun.write(OUT, html)
console.log(`night watch written: ${OUT} (stage ${ts.stage}, wallet ${fmt(wallet)}, ${profiles.filter(p => p.running).length} riding)`)
