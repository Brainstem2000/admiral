/**
 * faction-ledger-backfill — replay the logged faction moves into faction_ledger and
 * the lockbox/treasury snapshots. Reads log_entries (14-day retention): each
 * tool_call is paired with the tool_result that followed it; errors are skipped.
 * Idempotent: rows dedupe on (profile, kind, item, qty, tick-or-minute).
 *
 *   bun scripts/faction-ledger-backfill.ts [--since 2026-09-01]
 */
import { getDb } from '../src/server/lib/db'
import { captureFactionFromCommand } from '../src/server/lib/faction-ledger'

const since = (() => { const i = process.argv.indexOf('--since'); return i > 0 ? process.argv[i + 1] : '2026-08-01' })()
const db = getDb()

const calls = db.query(`
  SELECT l.id, l.profile_id, p.name AS profile_name, l.timestamp, l.summary, l.detail
  FROM log_entries l JOIN profiles p ON p.id = l.profile_id
  WHERE l.type = 'tool_call' AND l.timestamp >= ?
    AND (l.summary LIKE 'game(view, target=faction%' OR l.summary LIKE 'game(view_faction_storage%'
      OR l.summary LIKE 'game(deposit%target=faction%' OR l.summary LIKE 'game(deposit_items%target=faction%'
      OR l.summary LIKE 'game(withdraw%source=faction%' OR l.summary LIKE 'game(withdraw_items%source=faction%'
      OR l.summary LIKE 'game(faction_deposit%' OR l.summary LIKE 'game(faction_withdraw%'
      OR l.summary LIKE 'game(send_gift, recipient=faction:%' OR l.summary LIKE 'manual: %faction%' OR l.summary LIKE 'manual: send_gift%faction%'
      OR l.summary LIKE 'manual: deposit%' OR l.summary LIKE 'manual: withdraw%' OR l.summary LIKE 'manual: view%')
  ORDER BY l.id ASC
`).all(since) as Array<{ id: number; profile_id: string; profile_name: string; timestamp: string; summary: string; detail: string | null }>

const nextResult = db.query(`SELECT summary, detail FROM log_entries WHERE profile_id = ? AND type = 'tool_result' AND id > ? ORDER BY id ASC LIMIT 1`)
// Where the agent was docked AT THE TIME: the newest earlier result that echoes a real docked_at.
// (getMostRecentStation() would answer with wherever they last read storage TODAY.)
const dockedBefore = db.query(`SELECT detail FROM log_entries WHERE profile_id = ? AND type = 'tool_result' AND id < ? AND detail LIKE '%docked_at: %' AND detail NOT LIKE '%docked_at: ~%' AND detail NOT LIKE '%docked_at: null%' ORDER BY id DESC LIMIT 1`)
function stationAt(profileId: string, beforeId: number): string | null {
  const row = dockedBefore.get(profileId, beforeId) as { detail: string } | null
  const m = row ? /docked_at:\s*([a-z0-9_]+)/.exec(row.detail) : null
  return m ? m[1] : null
}

/** Parse "game(cmd, k=v k2=v2)" / "manual: cmd({json})" summaries into command + args. */
function parseCall(summary: string, detail: string | null): { command: string; args: Record<string, unknown> } | null {
  let m = /^manual:\s*([a-z_]+)\((.*)\)\s*$/s.exec(summary)
  if (m) { try { return { command: m[1], args: m[2] ? JSON.parse(m[2]) : {} } } catch { return { command: m[1], args: {} } } }
  m = /^game\(([a-z_]+)(?:,\s*(.*))?\)\s*$/s.exec(detail && detail.startsWith('game(') ? detail : summary)
  if (!m) return null
  const args: Record<string, unknown> = {}
  const body = m[2] ?? ''
  // items=[...] JSON first, then k=v tokens
  const items = /items=(\[.*?\])(?:\s|$)/s.exec(body)
  if (items) { try { args.items = JSON.parse(items[1]) } catch { /* ignore */ } }
  for (const kv of body.replace(/items=\[.*?\](?:\s|$)/s, '').matchAll(/([a-z_]+)=("[^"]*"|\S+)/g)) {
    const v = kv[2].replace(/^"|"$/g, '')
    args[kv[1]] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
  }
  return { command: m[1], args }
}

/** Results are logged as YAML-ish text; recover the fields the capture needs. */
function parseResult(summary: string, detail: string | null): unknown {
  const t = detail ?? summary
  if (!t || /^Error/.test(t)) return { error: true }
  if (t.trim().startsWith('{')) { try { return JSON.parse(t) } catch { /* fall through */ } }
  const r: Record<string, unknown> = {}
  const grab = (k: string) => { const m = new RegExp(`(?:^|\\n|\\s)${k}:\\s*([^\\n]+)`).exec(t); return m ? m[1].trim() : undefined }
  for (const k of ['action', 'base_id', 'faction_id', 'faction_tag', 'faction_name', 'source', 'destination', 'item_id', 'recipient']) { const v = grab(k); if (v !== undefined) r[k] = v }
  for (const k of ['credits', 'quantity', 'credits_sent', 'tick', 'amount', 'wallet_remaining']) { const v = grab(k); if (v !== undefined && /^-?\d+$/.test(v)) r[k] = Number(v) }
  if (/items:\s*\n/.test(t) || /items:\s+-/.test(t)) {
    const items: Array<{ item_id: string; name: string; quantity: number }> = []
    for (const m of t.matchAll(/item_id:\s*([a-z_0-9]+)\s+name:\s*([^\n]+?)\s+quantity:\s*(\d+)/g)) items.push({ item_id: m[1], name: m[2].trim(), quantity: Number(m[3]) })
    if (items.length) r.items = items
  }
  return r
}

let rows = 0, seen = 0
for (const c of calls) {
  const call = parseCall(c.summary, c.detail)
  if (!call) continue
  const res = nextResult.get(c.profile_id, c.id) as { summary: string; detail: string | null } | null
  if (!res) continue
  const data = parseResult(res.summary, res.detail)
  seen++
  rows += captureFactionFromCommand(call.command, call.args, data, c.profile_id, c.profile_name, { at: c.timestamp, source: `backfill:${call.command}`, station: stationAt(c.profile_id, c.id) })
}
// Second source: the per-agent credit ledger. Faction-bound gifts and deposits that ran
// as SILENT manual commands never reached log_entries (the 2,720,802cr nine-agent levy
// of 2026-09-07 is only in financial_ledger), so mirror those rows here — this is also
// the agent-side <-> faction-side match the Admiral asked for.
const { insertFactionLedger } = await import('../src/server/lib/db')
const mirror = db.query(`
  SELECT id, timestamp, profile_id, kind, amount_signed, counterparty, source_command FROM financial_ledger
  WHERE timestamp >= ? AND (
    (kind = 'gift_sent' AND lower(counterparty) LIKE 'faction:%')
    OR (kind IN ('deposit','withdraw') AND (lower(coalesce(counterparty,'')) LIKE '%faction%' OR lower(coalesce(counterparty,'')) LIKE '%stellar%'))
  ) ORDER BY id ASC`).all(since) as Array<{ id: number; timestamp: string; profile_id: string; kind: string; amount_signed: number; counterparty: string | null; source_command: string }>
let mirrored = 0
for (const m of mirror) {
  const kind = m.kind === 'gift_sent' ? 'treasury_gift' : m.kind === 'deposit' ? 'treasury_deposit' : 'treasury_withdraw'
  const tag = m.counterparty && m.counterparty.toLowerCase().startsWith('faction:') ? m.counterparty.split(':')[1] : null
  const credits = kind === 'treasury_withdraw' ? -Math.abs(m.amount_signed) : Math.abs(m.amount_signed)
  if (insertFactionLedger({ faction_id: null, faction_tag: tag, kind, profile_id: m.profile_id, station_id: null, item_id: null, quantity: null,
    credits_signed: credits, source_command: `ledger:${m.source_command}`, raw_ref: null, tick: null, dedupe_key: `ledger:${m.id}`, timestamp: m.timestamp })) mirrored++
}
console.log(`mirrored ${mirrored} faction-bound rows from financial_ledger (${mirror.length} candidates)`)
const totals = db.query('SELECT kind, count(*) n, COALESCE(SUM(credits_signed),0) credits, COALESCE(SUM(quantity),0) qty FROM faction_ledger GROUP BY kind').all()
const snaps = db.query('SELECT count(*) n, max(at) latest FROM faction_treasury_snapshots').get()
const lock = db.query('SELECT station_id, count(*) lines FROM faction_storage_inventory GROUP BY station_id').all()
console.log(`replayed ${seen} faction calls since ${since}; ${rows} new ledger rows`)
console.log('ledger by kind:', totals)
console.log('treasury snapshots:', snaps)
console.log('lockbox stations:', lock)
