/**
 * Mission Board generator — renders the shareable ops board (an Artifact) from
 * LIVE state: profiles API (wallets, models, connection), the ledger, and the
 * commission math. The watch regenerates + republishes every tick, so the
 * canvas can never drift from the game again (it was hand-patched before, and
 * hand-patched numbers rot).
 *
 *   bun scripts/mission-board.ts <output.html>
 */
import { Database } from 'bun:sqlite'

const OUT = process.argv[2]
if (!OUT) { console.error('usage: bun scripts/mission-board.ts <output.html>'); process.exit(1) }

const API = 'http://127.0.0.1:3031'
const MORG = 'a9e3b41a-ed67-4891-b847-eb5a806fffb2'

// Commission 7f4c3f0c — PLACED 2026-08-28 16:43:35Z, 1,797,923 cr, materials provided.
// Build clock is tick-anchored: 3,900 ticks at a measured 10.0 s/tick.
const BUILD_START_MS = Date.parse('2026-08-28T16:43:36Z')
const BUILD_TICKS = 3_900
const TICK_SECONDS = 10
const BUILD_END_MS = BUILD_START_MS + BUILD_TICKS * TICK_SECONDS * 1000
const COMMISSION_PAID = 1_797_923

const db = new Database('data/admiral.db', { readonly: true })
const profiles = (await (await fetch(`${API}/api/profiles`)).json()) as Array<Record<string, any>>

const fmt = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-US')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const morg = profiles.find(p => p.id === MORG)
const wallet = Number(morg?.gameState?.credits ?? 0) ||
  Number((db.query(`SELECT balance_after FROM financial_ledger WHERE profile_id=? AND balance_after IS NOT NULL ORDER BY id DESC LIMIT 1`).get(MORG) as any)?.balance_after ?? 0)
const buildPct = Math.min(100, Math.max(0, ((Date.now() - BUILD_START_MS) / (BUILD_END_MS - BUILD_START_MS)) * 100))
const buildDone = Date.now() >= BUILD_END_MS
const etaLeftMs = Math.max(0, BUILD_END_MS - Date.now())
const etaH = Math.floor(etaLeftMs / 3600_000)
const etaM = Math.floor((etaLeftMs % 3600_000) / 60_000)
const etaUtc = new Date(BUILD_END_MS).toISOString().slice(11, 16)
const etaCst = new Date(BUILD_END_MS - 5 * 3600_000).toISOString().slice(11, 16)
const nowIso = new Date().toISOString()
const stamp = nowIso.slice(0, 10) + ' · ' + nowIso.slice(11, 16) + ' UTC'

// Roster
const PILL: Record<string, string> = { [MORG]: 'treasurer' }
const modelLabel = (p: Record<string, any>) => {
  let m = String(p.model ?? '')
  if (m.includes('haiku')) m = 'haiku-4.5'
  else if (m.includes('Qwen')) m = 'Qwen3.6-35B · local'
  else if (m.includes('muse')) m = 'muse v3 · local'
  else if (m.includes('sonnet')) m = 'sonnet-5'
  const planner = String(p.planner_model ?? '')
  return planner.includes('sonnet') ? `${m} + sonnet planner` : planner ? `${m} + haiku planner` : m
}
const jobLabel = (p: Record<string, any>) => {
  const d = String(p.directive ?? '')
  const m = d.match(/^##\s*(.+?)(?:\s*[—-]\s*\d{4}.*)?$/m)
  let j = (m?.[1] ?? '').replace(/[A-Z']{2,}[^—-]*—\s*/, '').trim()
  if (j.length > 60) j = j.slice(0, 57) + '…'
  return j || '—'
}
const running = profiles.filter(p => p.running)
const rosterRows = profiles
  .sort((a, b) => Number(b.gameState?.credits ?? 0) - Number(a.gameState?.credits ?? 0))
  .map(p => {
    const gs = p.gameState ?? {}
    const isLocal = /muse|Qwen/i.test(String(p.model ?? ''))
    const pill = p.id === MORG ? '<span class="pill earn">treasurer</span>'
      : !p.running ? '<span class="pill parked">parked</span>'
      : /EXPLORATION/i.test(String(p.directive ?? '')) ? '<span class="pill explore">explorer</span>'
      : /SPRINT/i.test(String(p.directive ?? '')) ? '<span class="pill eval">data sprint</span>'
      : '<span class="pill earn">earning</span>'
    const credits = gs.credits ?? (db.query(`SELECT balance_after FROM financial_ledger WHERE profile_id=? AND balance_after IS NOT NULL ORDER BY id DESC LIMIT 1`).get(p.id) as any)?.balance_after
    return `<tr><td><span class="agent-name">${esc(String(p.name).split(' - ')[0])}</span> ${pill}</td>` +
      `<td class="model${isLocal ? ' local' : ''}">${esc(p.running ? modelLabel(p) : '—')}</td>` +
      `<td class="job">${esc(p.running ? jobLabel(p) : 'offline')}</td>` +
      `<td class="num">${credits != null ? fmt(Number(credits)) : '—'}</td></tr>`
  }).join('\n          ')

// Ledger: notable events last 8h
const events = db.query(`
  SELECT p.name AS name, f.timestamp AS ts, f.kind AS kind, f.item_id AS item, f.quantity AS qty, f.amount_signed AS amt
  FROM financial_ledger f JOIN profiles p ON p.id = f.profile_id
  WHERE f.timestamp > datetime('now','-8 hours')
    AND (ABS(f.amount_signed) >= 5000 OR (f.kind IN ('sell','gift_received','mission_reward') AND ABS(f.amount_signed) >= 1000))
    AND f.kind NOT IN ('escrow')
  ORDER BY f.id DESC LIMIT 12`).all() as Array<Record<string, any>>
const eventRows = events.map(e => {
  const t = String(e.ts).slice(11, 16)
  const who = String(e.name).split(' - ')[0]
  const what = e.item ? `${e.kind} ${esc(String(e.item))}${e.qty ? ' x' + e.qty : ''}` : e.kind
  const cls = e.amt >= 0 ? 'up' : 'down'
  const sign = e.amt >= 0 ? '+' : '−'
  return `<li><span class="t">${t}</span><span>${esc(who)}: ${what} <span class="amt ${cls}">${sign}${fmt(Math.abs(e.amt))}</span></span></li>`
}).join('\n      ')

// Intel snapshot for the stat strip
const intel = (await (await fetch(`${API}/api/fleet-intel/dashboard`)).json()) as any
const localCount = running.filter(p => /muse|Qwen/i.test(String(p.model ?? ''))).length

const html = `<title>Admiral Mission Board</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
  :root {
    --ground: #0B0E14; --panel: #141926; --panel-2: #10141F; --wire: #26304A;
    --ink: #D9E0ED; --muted: #8A94A8; --brass: #F2B33D;
    --good: #63B57E; --warn: #E0823F; --crit: #D96060; --local: #7FA8D9;
    --display: "Chakra Petch", "Arial Narrow", sans-serif;
    --body: "IBM Plex Sans", "Helvetica Neue", sans-serif;
    --mono: "IBM Plex Mono", "Menlo", monospace;
  }
  * { box-sizing: border-box; }
  body { background: var(--ground); color: var(--ink); font-family: var(--body); margin: 0; padding: 24px 20px 48px; line-height: 1.55; }
  .board { max-width: 1080px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
  header.masthead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 18px; border-bottom: 2px solid var(--brass); padding-bottom: 12px; }
  .masthead h1 { font-family: var(--display); font-weight: 700; font-size: 26px; letter-spacing: .06em; text-transform: uppercase; margin: 0; }
  .masthead h1 .dim { color: var(--brass); }
  .stamp { font-family: var(--mono); font-size: 12px; color: var(--muted); margin-left: auto; }
  .statstrip { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .stat { background: var(--panel); border: 1px solid var(--wire); padding: 10px 14px; }
  .stat .k { font-family: var(--display); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
  .stat .v { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 20px; font-weight: 600; }
  .stat .v small { font-size: 12px; color: var(--muted); font-weight: 400; }
  section.panel { background: var(--panel); border: 1px solid var(--wire); padding: 18px 20px; }
  section.panel > h2 { font-family: var(--display); font-size: 14px; letter-spacing: .14em; text-transform: uppercase; color: var(--brass); margin: 0 0 12px; }
  section.panel > h2 span.sub { color: var(--muted); letter-spacing: .04em; text-transform: none; font-family: var(--body); font-weight: 400; font-size: 12px; margin-left: 10px; }
  .rail-wrap { margin: 14px 0 6px; }
  .rail { position: relative; height: 34px; background: var(--panel-2); border: 1px solid var(--wire); }
  .rail .fill { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg, #6E5A22, var(--brass)); transition: width .6s; }
  .rail .tick { position: absolute; top: -6px; bottom: -6px; width: 2px; background: var(--ink); opacity: .85; }
  .rail .tick.target { display: none; }
  .rail .tick.trigger { left: 100%; background: var(--crit); }
  .rail-labels { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 12px; color: var(--muted); margin-top: 10px; flex-wrap: wrap; gap: 4px 16px; }
  .rail-labels b { color: var(--ink); font-weight: 600; }
  .money { font-variant-numeric: tabular-nums; font-family: var(--mono); }
  .hero-figures { display: flex; flex-wrap: wrap; gap: 8px 28px; align-items: baseline; }
  .hero-figures .big { font-family: var(--mono); font-size: 34px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .hero-figures .big small { font-size: 15px; color: var(--muted); font-weight: 400; }
  .gap-chip { font-family: var(--mono); font-size: 13px; color: var(--warn); border: 1px solid var(--warn); padding: 3px 10px; }
  .note { color: var(--muted); font-size: 13px; margin: 10px 0 0; max-width: 72ch; }
  .cols { display: grid; grid-template-columns: 3fr 2fr; gap: 20px; align-items: start; }
  @media (max-width: 860px) { .cols { grid-template-columns: 1fr; } }
  .tbl-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th { font-family: var(--display); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--wire); white-space: nowrap; }
  td { padding: 7px 10px; border-bottom: 1px solid var(--panel-2); vertical-align: top; }
  td.num { font-family: var(--mono); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  .pill { display: inline-block; font-family: var(--display); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; padding: 2px 8px; border: 1px solid; white-space: nowrap; }
  .pill.earn { color: var(--good); border-color: var(--good); }
  .pill.eval { color: var(--local); border-color: var(--local); }
  .pill.explore { color: var(--brass); border-color: var(--brass); }
  .pill.parked { color: var(--muted); border-color: var(--wire); }
  .model { font-family: var(--mono); font-size: 12px; }
  .model.local { color: var(--local); }
  .agent-name { font-weight: 600; }
  .job { color: var(--muted); font-size: 12px; }
  ul.guards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
  ul.guards li { border-left: 3px solid var(--good); background: var(--panel-2); padding: 8px 12px; font-size: 13px; }
  ul.guards li b { font-family: var(--mono); font-size: 12.5px; }
  ul.guards li .why { color: var(--muted); font-size: 12px; display: block; }
  ol.incidents { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
  ol.incidents li { display: grid; grid-template-columns: 58px 1fr; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--panel-2); }
  ol.incidents li:last-child { border-bottom: none; }
  ol.incidents .t { font-family: var(--mono); font-size: 12px; color: var(--muted); }
  ol.incidents .amt { font-family: var(--mono); font-variant-numeric: tabular-nums; }
  .up { color: var(--good); } .down { color: var(--crit); }
  footer { color: var(--muted); font-family: var(--mono); font-size: 11.5px; text-align: center; }
</style>

<div class="board">
  <header class="masthead">
    <h1>Admiral <span class="dim">Mission Board</span></h1>
    <span class="stamp"><span id="stamp-age" data-snap="${nowIso}">${stamp}</span> · auto-generated from live state</span>
  </header>

  <div class="statstrip">
    <div class="stat"><div class="k">Agents running</div><div class="v">${running.length} <small>of ${profiles.length}</small></div></div>
    <div class="stat"><div class="k">Treasury (Morg)</div><div class="v">${(wallet / 1e6).toFixed(2)}M <small>cr</small></div></div>
    <div class="stat"><div class="k">Devastator build</div><div class="v">${buildDone ? 'DONE' : buildPct.toFixed(0) + '%'} <small>${buildDone ? 'collect at yard' : 'eta ' + etaH + 'h ' + etaM + 'm'}</small></div></div>
    <div class="stat"><div class="k">Local-model agents</div><div class="v">${localCount} <small>of ${running.length}</small></div></div>
    <div class="stat"><div class="k">Systems surveyed</div><div class="v">${intel?.coverage?.systems_surveyed ?? '—'} <small>/ ${intel?.coverage?.galaxy_charted ?? '—'}</small></div></div>
    <div class="stat"><div class="k">Stations priced</div><div class="v">${intel?.coverage?.stations_priced ?? '—'}</div></div>
  </div>

  <section class="panel">
    <h2>Crimson Devastator — BUILDING<span class="sub">commission 7f4c3f0c · placed 2026-08-28 16:43Z · ${fmt(COMMISSION_PAID)} cr paid, materials provided</span></h2>
    <div class="hero-figures">
      <div class="big" id="build-eta">${buildDone ? 'READY AT THE YARD' : `${etaH}h ${etaM}m`} <small>${buildDone ? 'Crimson War Citadel' : 'until hull completion'}</small></div>
      <div class="gap-chip" style="color:var(--good);border-color:var(--good)">${buildDone ? 'COLLECT + INSURE + FIT' : `ETA ${etaUtc} UTC · ${etaCst} CST`}</div>
    </div>
    <div class="rail-wrap">
      <div class="rail"><div class="fill" id="build-fill" style="width:${buildPct.toFixed(1)}%"></div></div>
      <div class="rail-labels">
        <span><b class="money" id="build-pct">${buildPct.toFixed(1)}%</b> of 3,900 build ticks (10s each)</span>
        <span><b>on delivery:</b> dock → insurance quote → fit check → hunting doctrine</span>
        <span><b class="money">${fmt(wallet)}</b> Morg's wallet <span id="wallet-age"></span></span>
      </div>
    </div>
    <p class="note">Stock loadout: 7/7 weapons (2×mass driver, 2×piercing railgun II, 2×railgun II, fury cannon — 490 dmg/volley), 3/3 armor, 3 utility slots EMPTY. Countdown is live; the board also regenerates every fleet-watch tick.</p>
  </section>

  <div class="cols">
    <section class="panel">
      <h2>Fleet Roster<span class="sub">live wallets, sorted by holdings</span></h2>
      <div class="tbl-wrap"><table>
        <thead><tr><th>Agent</th><th>Model</th><th>Assignment</th><th style="text-align:right">Wallet</th></tr></thead>
        <tbody>
          ${rosterRows}
        </tbody>
      </table></div>
      <p class="note">Treasury sweep RETIRED 2026-08-28 — agents keep their own earnings. Parked agents stay at zero until the repossession probe.</p>
    </section>

    <section class="panel">
      <h2>Mechanical Guards<span class="sub">each born from a real loss</span></h2>
      <ul class="guards">
        <li><b>loss-churn gate</b><span class="why">sell blocked if bought &lt;45 min ago and bid &lt; 80% of price paid</span></li>
        <li><b>depth consumption</b><span class="why">our own fills burn down the observed bid depth — no more 1cr walks</span></li>
        <li><b>order-book legend</b><span class="why">every market read glossed: best_buy = BID, best_sell = ASK</span></li>
        <li><b>loop escalation → auto context flush</b><span class="why">3 identical calls past the warning wipe the conversation</span></li>
        <li><b>sell-depth gate</b><span class="why">bulk sells capped to fresh observed bid depth</span></li>
        <li><b>fuel-cell gate</b><span class="why">8-cell emergency reserve, top-up only</span></li>
        <li><b>BoM vault locks</b><span class="why">sell / gift / craft blocked on Devastator lines; quota-metered exceptions</span></li>
        <li><b>jettison ban</b><span class="why">nothing with a bid is scrap</span></li>
        <li><b>directive-keyed market relay</b><span class="why">briefings auto-refresh both-sides galaxy quotes</span></li>
        <li><b>tool-pairing repair + bounded retries</b><span class="why">malformed histories heal instead of 400-storming</span></li>
      </ul>
    </section>
  </div>

  <section class="panel">
    <h2>Ledger — notable events, last 8h<span class="sub">auto-selected from the financial ledger</span></h2>
    <ol class="incidents">
      ${eventRows || '<li><span class="t">—</span><span>quiet</span></li>'}
    </ol>
  </section>

  <footer>auto-generated ${stamp} · regenerates every fleet-watch tick · the Admiral UI is the live source · the commission order waits for Brian</footer>
</div>
<script>
  (function () {
    var el = document.getElementById('stamp-age'), wa = document.getElementById('wallet-age')
    if (!el) return
    var snap = Date.parse(el.getAttribute('data-snap') || '')
    if (!snap) return
    function render() {
      var mins = Math.max(0, Math.floor((Date.now() - snap) / 60000))
      var label = mins < 1 ? 'just now' : mins < 60 ? mins + 'm ago' : Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm ago'
      var stale = mins >= 20
      if (wa) { wa.textContent = '· snapshot ' + label; wa.style.color = stale ? 'var(--warn)' : 'var(--muted)' }
      el.style.color = stale ? 'var(--warn)' : ''
    }
    render(); setInterval(render, 30000)
  })()
  ;(function () {
    var END = ${BUILD_END_MS}, START = ${BUILD_START_MS}
    var eta = document.getElementById('build-eta'), fill = document.getElementById('build-fill'), pct = document.getElementById('build-pct')
    if (!eta || !fill) return
    function tick() {
      var now = Date.now()
      if (now >= END) {
        eta.innerHTML = 'READY AT THE YARD <small>Crimson War Citadel</small>'
        fill.style.width = '100%'; if (pct) pct.textContent = '100%'
        return
      }
      var left = END - now, h = Math.floor(left / 3600000), m = Math.floor(left % 3600000 / 60000)
      eta.innerHTML = h + 'h ' + m + 'm <small>until hull completion</small>'
      var p2 = ((now - START) / (END - START) * 100)
      fill.style.width = p2.toFixed(2) + '%'; if (pct) pct.textContent = p2.toFixed(1) + '%'
    }
    tick(); setInterval(tick, 30000)
  })()
</script>
`
await Bun.write(OUT, html)
console.log(`board written: ${OUT} (wallet ${fmt(wallet)}, build eta ${etaH}h${etaM}m, ${running.length} running)`)
