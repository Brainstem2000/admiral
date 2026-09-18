#!/usr/bin/env bun
/**
 * Validate Admiral's faction ledger against the SpaceMolt server's OWN records.
 *
 * Admiral's ledger is inferred: it books a row when one of our agents runs a command and
 * the game replies. That makes it structurally blind twice over — to anything a faction
 * member outside the harness does (UMan is Quartermaster and hand-played), and to any
 * reply we failed to parse or never saw because a turn died mid-call. Reconciling the
 * vault against those books already surfaced 13 unexplained lines at War Citadel.
 *
 * The server keeps the real record. `get_action_log {category:"faction"}` is a QUERY —
 * free, no game tick — is paged, and returns one row per transfer with a plain-language
 * summary. So we can stop inferring and start checking.
 *
 * This walks every agent's faction log, parses each transfer, and compares it to what
 * `faction_ledger` claims. Three outcomes, and the third is the point:
 *   MATCHED   — the server and our books agree.
 *   MISSING   — the server recorded a transfer our books never booked.
 *   UNPARSED  — a line this script could not read. Reported, never dropped: a verifier
 *               that silently skips what it does not understand reports a clean bill on
 *               a broken parse, which is worse than no verifier.
 *
 *   bun scripts/verify-ledger.ts              check every agent, recent pages
 *   bun scripts/verify-ledger.ts --pages 11   walk deeper (each page is ~48 entries)
 *   bun scripts/verify-ledger.ts --agent Morg only one
 *
 * It is READ-ONLY. It never writes to the ledger and never issues a game action.
 */
import { Database } from 'bun:sqlite'

const API = 'http://127.0.0.1:3031/api/profiles'
const argv = process.argv.slice(2)
const arg = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const PAGES = Math.max(1, Number(arg('--pages', '3')))
const ONLY = arg('--agent', '')

interface Transfer { ts: string; item: string; qty: number; toFaction: boolean; raw: string }
type Classified =
  | { kind: 'item'; transfer: Transfer }
  | { kind: 'credits' | 'bulk' | 'admin' | 'unknown'; raw: string }

/**
 * Classify one faction action-log line.
 *
 * The summaries are prose and the server uses SEVERAL wordings for the same movement —
 * the first version of this script knew only "Transferred N x item from personal storage
 * to faction main storage" and flagged 341 "Deposited N x item to faction storage" lines
 * as unparsed. That is why unknown lines are reported rather than skipped: the miss was
 * visible in the first run instead of passing as a clean bill.
 *
 * The full set, counted across eight agents' logs on 2026-09-17:
 *   item movements   Deposited N x I to faction storage            (+)
 *                    Transferred N x I from personal to faction    (+)
 *                    Withdrew N x I from faction storage           (-)
 *                    Transferred N x I from faction to personal    (-)
 *   credits          Deposited/Withdrew N credits, Earned N credits — treasury, not stock
 *   bulk             "N item types (N units) in bulk" — real movements, but the server
 *                    aggregates them, so no per-item quantity exists to verify against
 *   admin            invites, role changes, joins, facility builds
 *
 * Direction is never inferred from position in the sentence; it is read from which side
 * the word "faction" falls on. Guessing direction is how a withdrawal books as a deposit
 * and the totals drift the flattering way.
 *
 * Item ids may contain a colon (`package:<hash>`), so the charset allows it.
 */
export function classify(time: string, summary: string): Classified {
  const raw = summary.trim()

  // Admin FIRST. "Built Polonium Doping Cell for 250000 credits" contains the word
  // "credits" and would otherwise be booked as a treasury movement — and facility builds
  // are precisely what polluted treasury attribution before (74% of "unattributed
  // outflow" turned out to be builds the game never reports as a charge).
  if (/^(Invited|Joined|Left|Changed|Founded|Built)\b/i.test(raw)) return { kind: 'admin', raw }
  if (/\bcredits\b/i.test(raw)) return { kind: 'credits', raw }
  if (/\bin bulk\b/i.test(raw)) return { kind: 'bulk', raw }

  const qtyItem = /([\d,]+)\s*x\s*([a-z0-9_:]+)/i
  const mk = (m: RegExpExecArray, toFaction: boolean): Classified => {
    const qty = Number(m[1].replace(/,/g, ''))
    if (!Number.isFinite(qty) || qty <= 0) return { kind: 'unknown', raw }
    return { kind: 'item', transfer: { ts: time, item: m[2].toLowerCase(), qty, toFaction, raw } }
  }

  // "Deposited N x item to faction storage" / "Withdrew N x item from faction storage"
  let m = qtyItem.exec(raw)
  if (m) {
    if (/^Deposited\b/i.test(raw) && /to faction/i.test(raw)) return mk(m, true)
    if (/^Withdrew\b/i.test(raw) && /from faction/i.test(raw)) return mk(m, false)
    // "Transferred N x item from X to Y" — direction from which side says "faction"
    const t = /Transferred\s+[\d,]+\s*x\s*[a-z0-9_:]+\s+from\s+(.+?)\s+to\s+(.+?)\.?$/i.exec(raw)
    if (t) {
      const fromFaction = /faction/i.test(t[1]), toFaction = /faction/i.test(t[2])
      if (fromFaction !== toFaction) return mk(m, toFaction)
    }
  }
  return { kind: 'unknown', raw }
}

async function cmd(id: string, command: string, args: Record<string, unknown>): Promise<string> {
  const r = await fetch(`${API}/${id}/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, args, silent: true }),
  })
  const j = await r.json() as { result?: unknown }
  return typeof j.result === 'string' ? j.result : JSON.stringify(j.result ?? '')
}

const profiles = await (await fetch(API)).json() as Array<{ id: string; name: string; running: boolean }>
const db = new Database(`${import.meta.dir}/../data/admiral.db`, { readonly: true })

let totalMatched = 0, totalMissing = 0, totalUnparsed = 0
const missingRows: string[] = []

for (const p of profiles) {
  if (ONLY && !p.name.toLowerCase().includes(ONLY.toLowerCase())) continue
  const transfers: Transfer[] = []
  const unparsed: string[] = []
  const counts = { credits: 0, bulk: 0, admin: 0 }
  for (let page = 1; page <= PAGES; page++) {
    let text = ''
    try { text = await cmd(p.id, 'get_action_log', { category: 'faction', page }) } catch { break }
    if (!text || !text.includes('Action log')) break
    const lines = text.split('\n').slice(2)
    let sawRow = false
    for (const line of lines) {
      const c = line.split('\t')
      if (c.length < 4 || !c[0].startsWith('20')) continue
      sawRow = true
      const cl = classify(c[0], c[3])
      if (cl.kind === 'item') transfers.push(cl.transfer)
      else if (cl.kind === 'unknown') unparsed.push(cl.raw.slice(0, 90))
      else counts[cl.kind] += 1
    }
    if (!sawRow) break
  }
  if (!transfers.length && !unparsed.length) continue

  let matched = 0
  const missing: Transfer[] = []
  for (const t of transfers) {
    // Match on agent + item + magnitude + direction, within a minute of the server's stamp.
    // The two clocks are the same source but our row is written when the reply lands, so an
    // exact-second join would report false gaps.
    const row = db.query(`
      SELECT 1 FROM faction_ledger
       WHERE profile_id = ? AND item_id = ? AND ABS(quantity) = ?
         AND kind LIKE ? AND ABS(strftime('%s', timestamp) - strftime('%s', ?)) <= 90
       LIMIT 1`).get(p.id, t.item, t.qty, t.toFaction ? '%deposit%' : '%withdraw%',
                     t.ts.replace('T', ' ').replace('Z', ''))
    if (row) matched += 1; else missing.push(t)
  }
  totalMatched += matched; totalMissing += missing.length; totalUnparsed += unparsed.length

  const flag = missing.length || unparsed.length ? '  <-- GAP' : ''
  console.log(`${p.name.split(' -')[0].padEnd(18)} server ${String(transfers.length).padStart(4)} · matched ${String(matched).padStart(4)} · MISSING ${String(missing.length).padStart(3)}`
    + ` · unparsed ${String(unparsed.length).padStart(3)} · (credits ${counts.credits}, bulk ${counts.bulk}, admin ${counts.admin})${flag}`)
  for (const t of missing.slice(0, 5)) missingRows.push(`    ${t.ts}  ${p.name.split(' -')[0]}  ${t.toFaction ? '+' : '-'}${t.qty} ${t.item}`)
  for (const u of unparsed.slice(0, 3)) missingRows.push(`    UNPARSED  ${p.name.split(' -')[0]}  ${u}`)
}
db.close()

console.log(`\nSERVER-VERIFIED  matched ${totalMatched} · missing from our books ${totalMissing} · unparsed ${totalUnparsed}`)
if (missingRows.length) { console.log('\nNot in Admiral\'s ledger (server says it happened):'); for (const r of missingRows) console.log(r) }
console.log(`\n(server action log is AUTHORITATIVE; faction_ledger is Admiral's inference. Scanned ${PAGES} page(s) per agent.)`)
