/**
 * plan-check — validate a plan BEFORE putting it in a directive.
 *
 *   bun scripts/plan-check.ts Nova enriched_uranium_rod:27 fuel_cell:20
 *   bun scripts/plan-check.ts Morg --to krynn cargo_container:200 engine_core:6
 *
 * For each item it answers the questions that produced most of this project's wrong
 * directives: does this agent hold it, AT WHICH STATION, how far is that from where they
 * actually are, will it fit in their hold, is it a commission line, and what is the live
 * price *with depth* rather than a headline.
 *
 * Written after a single session produced ~15 corrections. Nearly all were the same shape:
 * a fact asserted about a place the asserter was not standing in, or a number not re-read.
 * The checks that were made mechanical (ship-match.ts, the craft guard) have produced none
 * since; the ones left to discipline kept failing. So this is a gate, not a reminder.
 *
 * Companion doc: docs/agent-verification-protocol.md (the agent-side version of this).
 */
import { Database } from 'bun:sqlite'

const MARKET = 'https://game.spacemolt.com/api/market'
const CATALOG = 'https://game.spacemolt.com/api/catalog.json'
const CACHE = 'data/.cache'
const FRESH_MS = 15 * 60_000 // market data older than this is reported as stale, loudly

async function cached(url: string, name: string, maxAgeMs = 30 * 60_000) {
  const path = `${CACHE}/${name}`
  let ageMs = Infinity
  try {
    const f = Bun.file(path)
    if (await f.exists()) {
      ageMs = Date.now() - (await f.stat()).mtimeMs
      if (ageMs < maxAgeMs) return { data: JSON.parse(await f.text()), ageMs }
    }
  } catch { /* refetch */ }
  try {
    const res = await fetch(url)
    if (res.ok) {
      const text = await res.text()
      await Bun.write(path, text)
      return { data: JSON.parse(text), ageMs: 0 }
    }
  } catch { /* fall back to whatever is on disk */ }
  const f = Bun.file(path)
  if (await f.exists()) return { data: JSON.parse(await f.text()), ageMs }
  throw new Error(`no data for ${name}`)
}

function bfsFactory(db: Database) {
  const row = db.query('SELECT data FROM galaxy_map ORDER BY fetched_at DESC LIMIT 1').get() as { data: string } | null
  if (!row) return () => null
  const g = JSON.parse(row.data) as { systems: Array<{ system_id: string; connections?: string[] }> }
  const adj = new Map(g.systems.map((s) => [s.system_id, [...(s.connections ?? [])]]))
  // Merge LEARNED links (system_links) over the blob. The blob only knows visited systems'
  // connections (435/505 had none) and once said horizon->krynn = 30j where the game's router
  // flew 12 — every agent traversal has banked real edges since. Distances stay upper bounds;
  // they just converge toward truth as coverage grows. Live find_route remains authoritative.
  try {
    for (const l of db.query('SELECT a, b FROM system_links').all() as Array<{ a: string; b: string }>) {
      if (!adj.has(l.a)) adj.set(l.a, [])
      if (!adj.has(l.b)) adj.set(l.b, [])
      if (!adj.get(l.a)!.includes(l.b)) adj.get(l.a)!.push(l.b)
      if (!adj.get(l.b)!.includes(l.a)) adj.get(l.b)!.push(l.a)
    }
  } catch { /* table absent on old DBs — blob-only is still correct */ }
  return (a: string, b: string): number | null => {
    if (!adj.has(a) || !adj.has(b)) return null
    const q: Array<[string, number]> = [[a, 0]]
    const seen = new Set([a])
    while (q.length) {
      const [n, d] = q.shift()!
      if (n === b) return d
      for (const x of adj.get(n) ?? []) if (!seen.has(x)) { seen.add(x); q.push([x, d + 1]) }
    }
    return null
  }
}

/** Where the agent actually is — from their own most recent live reading, not a cached table. */
function currentSystem(db: Database, profileId: string): string | null {
  const hop = db.query(
    `SELECT summary FROM log_entries WHERE profile_id = ? AND summary LIKE '%hop %' ORDER BY timestamp DESC LIMIT 1`,
  ).get(profileId) as { summary: string } | null
  const m = hop?.summary?.match(/→ ([a-z0-9_]+)/)
  if (m) return m[1]
  const res = db.query(
    `SELECT summary, detail FROM log_entries WHERE profile_id = ? AND type = 'tool_result' AND (summary LIKE '%system_id%' OR detail LIKE '%system_id%') ORDER BY timestamp DESC LIMIT 1`,
  ).get(profileId) as { summary?: string; detail?: string } | null
  return (`${res?.summary ?? ''} ${res?.detail ?? ''}`.match(/system_id:\s*([a-z0-9_]+)/) ?? [])[1] ?? null
}

// Station -> system. The stations feed keys on player factions, not systems, so this is the
// mapping the fleet has actually observed.
const STATION_SYSTEM: Record<string, string> = {
  crimson_war_citadel: 'krynn', grand_exchange_station: 'haven', starfall_salvage_station: 'starfall',
  market_prime_exchange: 'market_prime', nova_terra_central: 'nova_terra', frontier_station: 'first_step',
  blood_forge_smelting_works: 'blood_forge', iron_reach_mining_colony: 'iron_reach',
  cargo_lanes_freight_depot: 'cargo_lanes', the_crucible_garrison: 'the_crucible',
  the_rampart_checkpoint: 'the_rampart', the_anvil_arsenal: 'the_anvil', gold_run_extraction_hub: 'gold_run',
  procyon_colonial_station: 'procyon', sirius_observatory_station: 'sirius', central_nexus: 'central_nexus',
  confederacy_central_command: 'confederacy', ironhearth_station: 'ironhearth', node_beta_industrial_station: 'node_beta',
  deep_range_outpost: 'deep_range', node_gamma_relay_station: 'node_gamma',
}

async function main() {
  const args = process.argv.slice(2)
  const who = args.shift()
  if (!who) {
    console.log('usage: bun scripts/plan-check.ts <agent> [--to <system>] <item:qty> ...')
    return
  }
  let destination: string | null = null
  const toIdx = args.indexOf('--to')
  if (toIdx >= 0) { destination = args[toIdx + 1]; args.splice(toIdx, 2) }

  const db = new Database('data/admiral.db', { readonly: true })
  const profile = (db.query('SELECT id, name FROM profiles').all() as Array<{ id: string; name: string }>)
    .find((p) => p.name.toLowerCase().startsWith(who.toLowerCase()))
  if (!profile) return console.log(`no agent matching "${who}"`)

  const { data: mkt, ageMs } = await cached(MARKET, 'market.json')
  const { data: cat } = await cached(CATALOG, 'catalog.json', 6 * 60 * 60_000)
  const size = new Map<string, number>((cat.items ?? []).map((i: any) => [i.id, i.size ?? 1]))
  const jumps = bfsFactory(db)
  const here = currentSystem(db, profile.id)

  console.log(`\n### plan-check — ${profile.name}`)
  console.log(`  currently in: ${here ?? 'UNKNOWN'}${destination ? `   → destination ${destination} (${jumps(here ?? '', destination) ?? '?'} jumps)` : ''}`)
  if (ageMs > FRESH_MS) console.log(`  ⚠ MARKET DATA IS ${Math.round(ageMs / 60000)} MINUTES OLD — prices and depth move within minutes. Re-run to refresh.`)

  let fatal = 0, warn = 0
  for (const spec of args) {
    const [item, qtyRaw] = spec.split(':')
    const want = Number(qtyRaw ?? 0) || 0
    console.log(`\n  ── ${item} ×${want}`)

    // 1. does this agent hold it, and where
    const rows = db.query(
      'SELECT station_id, quantity FROM storage_inventory WHERE profile_id = ? AND item_id = ? AND quantity > 0 ORDER BY quantity DESC',
    ).all(profile.id, item) as Array<{ station_id: string; quantity: number }>
    const total = rows.reduce((a, b) => a + b.quantity, 0)
    if (!rows.length) {
      console.log(`     HOLDS: none. (fleet-wide: ${(db.query('SELECT SUM(quantity) q FROM storage_inventory WHERE item_id = ?').get(item) as any)?.q ?? 0})`)
    } else {
      for (const r of rows.slice(0, 4)) {
        const sys = STATION_SYSTEM[r.station_id]
        const d = sys && here ? jumps(here, sys) : null
        const far = d != null && d > 10
        if (far) warn++
        console.log(`     HOLDS: ${String(r.quantity).padStart(6)} at ${r.station_id.replace('_station', '')}${d != null ? `  (${d} jumps${far ? ' — FAR' : ''})` : '  (distance unknown)'}`)
      }
      if (total < want) { fatal++; console.log(`     ✗ SHORT ${want - total} — agent holds ${total} in total`) }
    }

    // 2. commission reserve
    const req = (db.query('SELECT MAX(quantity) q FROM commission_requirements WHERE item_id = ?').get(item) as any)?.q ?? 0
    if (req > 0) {
      const free = total - req
      if (free < want) { fatal++; console.log(`     ✗ COMMISSION LINE: needs ${req}. Using ${want} leaves ${total - want} — BELOW the reserve.`) }
      else console.log(`     commission needs ${req}; ${free} genuinely spare`)
    }

    // 3. live price and depth, cross-empire
    const listings = (mkt.items ?? []).filter((i: any) => i.item_id === item)
    const bid = listings.filter((i: any) => i.best_bid > 0).sort((a: any, b: any) => b.best_bid - a.best_bid)[0]
    const ask = listings.filter((i: any) => i.best_ask > 0).sort((a: any, b: any) => a.best_ask - b.best_ask)[0]
    if (bid) {
      const realisable = Math.min(want || total, bid.bid_quantity_at_best ?? 0) * bid.best_bid
      const thin = (bid.bid_quantity_at_best ?? 0) < want
      if (thin) warn++
      console.log(`     SELL: ${bid.best_bid} in ${bid.empire}, depth ${bid.bid_quantity_at_best}${thin ? ` — THIN, you want ${want}` : ''}  → realisable ${realisable.toLocaleString()}`)
    }
    if (ask) {
      const thin = (ask.ask_quantity_at_best ?? 0) < want
      if (thin) warn++
      console.log(`     BUY:  ${ask.best_ask} in ${ask.empire}, depth ${ask.ask_quantity_at_best}${thin ? ` — THIN, you want ${want}; expect to climb the ladder` : ''}`)
    }

    // 4. cargo
    const sz = size.get(item) ?? 1
    if (want) console.log(`     CARGO: size ${sz} × ${want} = ${sz * want} units of hold`)
  }

  console.log(`\n  ${fatal ? `✗ ${fatal} BLOCKING problem(s)` : '✓ no blocking problems'}${warn ? `, ${warn} warning(s)` : ''}`)
  console.log('  (agent-side equivalent: docs/agent-verification-protocol.md)\n')
}

main()
