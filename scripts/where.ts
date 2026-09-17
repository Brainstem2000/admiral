#!/usr/bin/env bun
/**
 * where.ts — "where is it, and who can actually reach it?"
 *
 * This exists because the question kept getting answered wrong from memory. The
 * fleet holds material in THREE places that are not interchangeable, and the
 * fleet-wide lookups in db.ts (findItemAcrossFleet, getFleetItemTotals) read only
 * two of them — personal lockers and ship holds — so seven faction vaults were
 * invisible to the API, the dashboard and the Admiral at once. On 2026-09-17 that
 * hid weapon_core 228 in grand_exchange_station while the Devastator bill showed
 * the line unsourceable, and 3,346 steel_plate across four vaults read as missing.
 *
 *   bun scripts/where.ts weapon_core            one item, every holder
 *   bun scripts/where.ts --search plating       every item whose id matches
 *   bun scripts/where.ts --station grand_exchange_station    everything at a place
 *   bun scripts/where.ts --bill crimson_devastator           a ship bill vs holdings
 *
 * Reads the local cache, which DRIFTS. It tells you where to look, never what is
 * there — confirm with a live read before putting a number in a directive.
 */
import { Database } from 'bun:sqlite'

const DB = process.env.ADMIRAL_DB || `${import.meta.dir}/../data/admiral.db`
const db = new Database(DB, { readonly: true })
const args = process.argv.slice(2)
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null }
const num = (n: number) => n.toLocaleString()
const ago = (t: string | null) => {
  if (!t) return '?'                       // a row written before timestamps, or an unplaced ledger entry
  const ms = Date.now() - Date.parse(String(t).replace(' ', 'T') + 'Z')
  if (!Number.isFinite(ms)) return '?'
  const d = Math.floor(ms / 86_400_000), h = Math.floor(ms / 3_600_000)
  return d > 0 ? `${d}d` : h > 0 ? `${h}h` : `${Math.max(0, Math.floor(ms / 60000))}m`
}
const names = new Map<string, string>(
  db.query('SELECT id, name FROM profiles').all().map((p: any) => [p.id, p.name]),
)

/** What each holder can actually feed. Getting this wrong is the recurring error. */
const REACH: Record<string, string> = {
  cargo:  'facility build: last  |  ship commission: FIRST',
  locker: 'facility build: NEVER |  ship commission: second',
  vault:  'facility build: at this station  |  ship commission: NEVER',
}

function locations(itemId: string) {
  return db.query(`
    SELECT 'locker' AS k, profile_id, station_id, quantity, updated_at FROM storage_inventory WHERE item_id=? AND quantity>0
    UNION ALL SELECT 'cargo', profile_id, '(cargo)', quantity, updated_at FROM cargo_inventory WHERE item_id=? AND quantity>0
    UNION ALL SELECT 'vault', NULL, station_id, quantity, updated_at FROM faction_storage_inventory WHERE item_id=? AND quantity>0
    ORDER BY quantity DESC`).all(itemId, itemId, itemId) as any[]
}

function showItem(itemId: string) {
  const rows = locations(itemId)
  if (!rows.length) { console.log(`\n${itemId}: nothing recorded anywhere.`); return }
  const tot = rows.reduce((n, r) => n + r.quantity, 0)
  const by = (k: string) => rows.filter(r => r.k === k).reduce((n, r) => n + r.quantity, 0)
  console.log(`\n=== ${itemId} — ${num(tot)} total  (cargo ${num(by('cargo'))} · lockers ${num(by('locker'))} · vaults ${num(by('vault'))})`)
  console.log('  holder    who                  station                          qty    age   reachable by')
  for (const r of rows) {
    const who = r.k === 'vault' ? 'FACTION' : (names.get(r.profile_id) ?? r.profile_id ?? '?')
    const age = ago(r.updated_at)
      const stale = (age.endsWith('d') || age === '?') ? ' STALE' : ''
    console.log('  ' + String(r.k).padEnd(10) + String(who).slice(0, 20).padEnd(21)
      + String(r.station_id).slice(0, 30).padEnd(33) + String(num(r.quantity)).padStart(7)
      + '  ' + String(age + stale).padStart(9) + '   ' + REACH[r.k])
  }
}

if (flag('--search')) {
  const q = `%${flag('--search')}%`
  const rows = db.query(`
    SELECT item_id, SUM(quantity) total,
           SUM(CASE WHEN src='cargo' THEN quantity ELSE 0 END) c,
           SUM(CASE WHEN src='locker' THEN quantity ELSE 0 END) l,
           SUM(CASE WHEN src='vault' THEN quantity ELSE 0 END) v,
           COUNT(*) locs
      FROM (SELECT item_id, quantity, 'locker' src FROM storage_inventory WHERE quantity>0
            UNION ALL SELECT item_id, quantity, 'cargo' FROM cargo_inventory WHERE quantity>0
            UNION ALL SELECT item_id, quantity, 'vault' FROM faction_storage_inventory WHERE quantity>0)
     WHERE item_id LIKE ? GROUP BY item_id ORDER BY total DESC LIMIT 40`).all(q) as any[]
  console.log(`\nitems matching "${flag('--search')}"`)
  console.log('item                           total     cargo    lockers     vaults   places')
  for (const r of rows)
    console.log('  ' + String(r.item_id).padEnd(28) + String(num(r.total)).padStart(8)
      + String(num(r.c)).padStart(10) + String(num(r.l)).padStart(11) + String(num(r.v)).padStart(11)
      + String(r.locs).padStart(8))
} else if (flag('--station')) {
  const st = flag('--station')!
  console.log(`\neverything recorded at ${st}`)
  const rows = db.query(`
    SELECT 'vault' k, NULL profile_id, item_id, quantity, updated_at FROM faction_storage_inventory WHERE station_id=? AND quantity>0
    UNION ALL SELECT 'locker', profile_id, item_id, quantity, updated_at FROM storage_inventory WHERE station_id=? AND quantity>0
    ORDER BY quantity DESC LIMIT 60`).all(st, st) as any[]
  console.log('  holder   who                  item                            qty     age')
  for (const r of rows)
    console.log('  ' + String(r.k).padEnd(9) + String(r.k === 'vault' ? 'FACTION' : (names.get(r.profile_id) ?? '?')).slice(0, 20).padEnd(21)
      + String(r.item_id).slice(0, 30).padEnd(32) + String(num(r.quantity)).padStart(7) + String(ago(r.updated_at)).padStart(8))
} else if (flag('--bill')) {
  const ship = flag('--bill')!
  const cat = JSON.parse(await Bun.file(`${import.meta.dir}/../data/catalog.json`).text().catch(() => '{}')) as any
  const ships = Array.isArray(cat.ships) ? cat.ships : []
  const s = ships.find((x: any) => x.id === ship)
  if (!s) { console.log(`ship ${ship} not in data/catalog.json — fetch it first`); process.exit(1) }
  console.log(`\n${s.name} bill vs everything we hold`)
  console.log('line                       need    cargo   locker    vault   TOTAL   gap')
  for (const m of (s.build_materials ?? [])) {
    const rows = locations(m.item_id)
    const by = (k: string) => rows.filter(r => r.k === k).reduce((n, r) => n + r.quantity, 0)
    const tot = rows.reduce((n, r) => n + r.quantity, 0)
    const gap = Math.max(0, m.quantity - tot)
    console.log('  ' + String(m.item_id).padEnd(26) + String(m.quantity).padStart(5)
      + String(num(by('cargo'))).padStart(9) + String(num(by('locker'))).padStart(9)
      + String(num(by('vault'))).padStart(9) + String(num(tot)).padStart(8)
      + (gap ? String(num(gap)).padStart(6) : '     -'))
  }
} else if (args.length && !args[0].startsWith('--')) {
  for (const a of args.filter(x => !x.startsWith('--'))) showItem(a)
} else {
  console.log(`usage:
  bun scripts/where.ts <item_id> [item_id...]   one item, every holder and who can reach it
  bun scripts/where.ts --search <text>          every item whose id matches
  bun scripts/where.ts --station <station_id>   everything recorded at one place
  bun scripts/where.ts --bill <ship_id>         a ship's bill against all holdings`)
}
console.log('\n(cache — tells you WHERE to look, never what is there. Confirm live before ordering.)')
