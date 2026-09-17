#!/usr/bin/env bun
/**
 * place.ts — "what is there, and how dangerous is getting to it?"
 *
 * Goes through the running Admiral rather than straight to SQLite, because the
 * authoritative station -> system map lives in the in-memory station feed, not in
 * the database. Resolving a station by prefix-matching system ids silently fails
 * whenever a station is not named after its system: grand_exchange_station is in
 * HAVEN, and frontier_station is in THE_TELESCOPE. A hauler burned a turn per
 * guess on exactly that, on 2026-09-17.
 *
 *   bun scripts/place.ts grand_exchange_station        what is at a place
 *   bun scripts/place.ts --route krynn westmark        a path, with every hop graded
 *
 * Route safety is a property of the CORRIDOR, not the destination. A 13-hop
 * zero-police run to a policed station is a dangerous run.
 */
const BASE = process.env.ADMIRAL_URL || 'http://127.0.0.1:3031'
const args = process.argv.slice(2)
const TONE: Record<string, string> = { safe: 'SAFE', policed: 'policed', thin: 'UNSURVEYED', lawless: 'LAWLESS', KILLZONE: '*** KILLZONE ***' }

async function get(path: string) {
  const r = await fetch(BASE + path)
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${path} — is the Admiral running?`)
  return r.json() as Promise<any>
}

if (args[0] === '--route') {
  const [, from, to] = args
  if (!from || !to) { console.log('usage: bun scripts/place.ts --route <from_system> <to_system>'); process.exit(1) }
  const j = await get(`/api/galaxy/route?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
  if (!j.found) { console.log(`\nno known route ${from} -> ${to} (the map graph may not reach it)`); process.exit(0) }
  console.log(`\n${from} -> ${to}:  ${j.jumps} jumps, ${j.lawless_hops} lawless hop(s)`)
  if (j.crosses_killzone) console.log('  *** CROSSES A HARD-BANNED KILLZONE ***')
  if (j.worst) console.log(`  worst hop: ${j.worst.system_id} — ${TONE[j.worst.risk]} (police ${j.worst.police_level ?? '?'})`)
  console.log('')
  for (const [i, h] of j.hops.entries())
    console.log(`  ${String(i).padStart(2)}. ${String(h.system_id).padEnd(24)}${TONE[h.risk].padEnd(18)}police ${String(h.police_level ?? '?').padStart(4)}${h.grade ? '   ' + h.grade : ''}`)
  if (j.detour) console.log(`\n  killzone-free detour exists: ${j.detour.jumps} jumps (${j.detour.lawless_hops} lawless)`)
} else if (args.length && !args[0].startsWith('--')) {
  const j = await get(`/api/galaxy/place/${encodeURIComponent(args[0])}`)
  console.log(`\n=== ${j.id}  (${j.kind}${j.system_id ? ' in ' + j.system_id : ''})`)
  if (j.risk) console.log(`  risk: ${TONE[j.risk.risk]}  police ${j.risk.police_level ?? '?'}${j.risk.grade ? '  graded ' + j.risk.grade : ''}${j.risk.killzone ? '  *** HARD BAN ***' : ''}`)
  if (j.stations?.length) console.log(`  stations here: ${j.stations.map((s: any) => s.station_id).join(', ')}`)
  if (j.agents_here?.length) console.log(`  our agents seen (3h): ${j.agents_here.join(', ')}`)
  if (j.neighbours?.length) console.log(`  neighbours: ${j.neighbours.map((n: any) => `${n.system_id}[${n.risk}]`).join('  ')}`)
  if (j.deposits?.length) {
    console.log('\n  deposits:')
    for (const d of j.deposits.slice(0, 10))
      console.log(`    ${String(d.item_id).padEnd(22)}${String(d.poi_name).slice(0, 28).padEnd(30)}rich ${String(d.richness).padStart(3)}  remaining ${String(d.remaining).padStart(7)}  supports array ${d.supported_power ?? '?'}`)
  }
  if (j.facilities?.length) {
    console.log('\n  facilities:')
    for (const f of j.facilities.slice(0, 10))
      console.log(`    ${String(f.facility_type).padEnd(34)}${f.faction_owned ? 'OURS' : f.public ? 'public' : ''}`)
  }
  if (j.holdings?.length) {
    console.log('\n  what we hold here:')
    for (const h of j.holdings.slice(0, 14))
      console.log(`    ${String(h.holder_kind).padEnd(8)}${String(h.holder).slice(0, 20).padEnd(22)}${String(h.item_id).padEnd(26)}${String(h.quantity).padStart(7)}`)
  }
} else {
  console.log(`usage:
  bun scripts/place.ts <system_or_station>        what is there, who is there, what we hold
  bun scripts/place.ts --route <from> <to>        a path with every hop graded for risk`)
}
console.log('\n(intel is scraped and DRIFTS — deposit "remaining" especially. Confirm live before ordering.)')
