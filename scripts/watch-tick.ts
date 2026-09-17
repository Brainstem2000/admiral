#!/usr/bin/env bun
/**
 * watch-tick.ts — one pass of the overnight fleet watch. Prints a line per NEW
 * condition and nothing otherwise, so it can be driven by a Monitor loop:
 *
 *   while true; do bun scripts/watch-tick.ts; sleep 180; done
 *
 * State lives in data/watch-state.txt so a condition is reported ONCE, not every
 * tick. A watcher that repeats itself gets muted, and a muted watcher is strictly
 * worse than none — an agent once sat blocked for eight minutes behind one.
 *
 * What it deliberately does NOT report:
 *   - relayed third-party chat (Wexler MAYDAY traffic and the like)
 *   - the Admiral's own directives and nudges echoed back into the log. The server
 *     logs orders verbatim, so any keyword inside an order I wrote would otherwise
 *     read as the agent failing — that fired a false BLOCKED on a hauler.
 *   - agents deliberately parked (PARKED below)
 */
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, writeFileSync } from 'fs'

const DB = process.env.ADMIRAL_DB || `${import.meta.dir}/../data/admiral.db`
const STATE = process.env.WATCH_STATE || `${import.meta.dir}/../data/watch-state.txt`
const db = new Database(DB, { readonly: true })

/** Agents safe-docked on purpose. Silence from these is the intended outcome. */
const PARKED = new Set((process.env.WATCH_PARKED ?? 'CyberSpock - Smuggler,CyberSapper - Smuggler').split(',').map(s => s.trim()).filter(Boolean))

const seen = new Set<string>(existsSync(STATE) ? readFileSync(STATE, 'utf8').split('\n').filter(Boolean) : [])
const out: string[] = []
const emit = (k: string, m: string) => { if (!seen.has(k)) { seen.add(k); out.push(m) } }
const clear = (k: string) => seen.delete(k)
const q = (item: string) => {
  const r = db.query(`SELECT quantity q FROM faction_storage_inventory
    WHERE item_id = ? AND station_id = 'crimson_war_citadel'`).get(item) as { q?: number } | undefined
  return r?.q ?? 0
}

// 1. Silence. A mine_until_full macro still writes log lines, so real silence is real.
for (const r of db.query(`SELECT p.name, MAX(l.timestamp) t FROM profiles p
    JOIN log_entries l ON l.profile_id = p.id GROUP BY p.id`).all() as Array<{ name: string; t: string }>) {
  if (PARKED.has(r.name)) continue
  const mins = (Date.now() - Date.parse(String(r.t).replace(' ', 'T') + 'Z')) / 60000
  if (mins > 25) emit(`q:${r.name}`, `SILENT: ${r.name} no log line ${Math.round(mins)}min`)
  else clear(`q:${r.name}`)
}

// 2. Connected but not turning. A server restart leaves agents in the roster looking
//    alive while their LLM loop is stopped — four sat like that unnoticed on 2026-09-17,
//    including the only agent crafting control nodes. Connection churn writes log lines,
//    so a silence check cannot see it.
//
//    Judged from the SERVER's own view, not by guessing from the log. Every long-running
//    macro — mining, crafting, travelling — occupies a single tool call for many minutes,
//    so an LLM gap says nothing about health. Enumerating the macros by hand produced two
//    false positives in one hour (mine_until_full, then a hauler at hop 26 of 31) and would
//    keep producing them as new macros appear. `running` plus a live `activity` string is
//    macro-agnostic and cannot drift out of date.
try {
  const res = await fetch('http://127.0.0.1:3031/api/profiles', { signal: AbortSignal.timeout(5000) })
  const body = await res.json() as unknown
  const rows = (Array.isArray(body) ? body : (body as { profiles?: unknown[] }).profiles ?? []) as Array<{
    name?: string; running?: boolean; connected?: boolean; activity?: string
  }>
  for (const p of rows) {
    const name = String(p.name ?? '')
    if (!name || PARKED.has(name)) continue
    const busy = /Executing|Planning|Waiting for LLM/i.test(String(p.activity ?? ''))
    if (p.running && busy) { clear(`dead:${name}`); continue }
    if (p.running) { clear(`dead:${name}`); continue }   // paced between turns is healthy
    emit(`dead:${name}`, `NOT RUNNING: ${name} connected=${p.connected} activity="${String(p.activity ?? '').slice(0, 40)}"`)
  }
} catch {
  // The Admiral being unreachable is itself worth one line, but only once.
  emit(`api:${Math.floor(Date.now() / 1800000)}`, 'ADMIRAL API UNREACHABLE — cannot read agent run state')
}

// 3. Genuine agent-side refusals.
for (const r of db.query(`SELECT p.name, l.summary FROM log_entries l JOIN profiles p ON p.id = l.profile_id
    WHERE l.timestamp > datetime('now','-6 minutes') AND l.type IN ('system','tool_call','tool_result')
      AND l.summary NOT LIKE '%CHAT_MESSAGE%' AND l.summary NOT LIKE '%MAYDAY%' AND l.summary NOT LIKE '%Wexler%'
      AND l.summary NOT LIKE 'Directive updated%' AND l.summary NOT LIKE 'Nudge delivered%'
      AND l.summary NOT LIKE '%ADMIRAL%' AND l.summary NOT LIKE 'update_todo%' AND l.summary NOT LIKE 'update_memory%'
      AND (l.summary LIKE '%no_facility%' OR l.summary LIKE '%build_failed%' OR l.summary LIKE '%insufficient_%'
           OR l.summary LIKE '%would fail%' OR l.summary LIKE '%no route%' OR l.summary LIKE '%too_sparse%'
           OR l.summary LIKE '%hull%critical%' OR l.summary LIKE '%cannot afford%')
    ORDER BY l.timestamp DESC LIMIT 8`).all() as Array<{ name: string; summary: string }>) {
  const body = String(r.summary).replace(/\s+/g, ' ').slice(0, 125)
  emit(`b:${r.name}:${body.slice(0, 55)}`, `BLOCKED ${r.name}: ${body}`)
}

// 4. The revenue floor — this is what pays rent and tax.
const sold = (db.query(`SELECT COALESCE(SUM(amount_signed),0) v FROM financial_ledger
  WHERE kind = 'sell' AND timestamp > datetime('now','-90 minutes')`).get() as { v: number }).v
if (sold <= 0) emit(`rev:${Math.floor(Date.now() / 5400000)}`, 'REVENUE FLOOR: no fleet sales in 90min — earners stalled')

// 5. Build gates worth waking for.
if (q('control_node') >= 150) emit('g:n150', `CONTROL_NODE recovering: ${q('control_node')}`)
if (q('silicon_ore') >= 150) emit('g:si', `SILICON ARRIVING: ${q('silicon_ore')}`)
if (q('circuit_board') >= 80) emit('g:cb', `BOARDS LANDED: ${q('circuit_board')} — size the node order now`)
if (q('weapon_housing') >= 80) emit('g:wh', `WEAPON_HOUSING COMPLETE ${q('weapon_housing')}/80`)
if (q('crimson_siege_plating') >= 4) emit('g:sp', `SIEGE_PLATING COMPLETE ${q('crimson_siege_plating')}/4`)

writeFileSync(STATE, [...seen].join('\n'))
for (const line of out) console.log(line)
