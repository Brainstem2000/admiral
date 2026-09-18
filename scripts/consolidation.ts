#!/usr/bin/env bun
/**
 * How much is STILL sitting in personal lockers instead of the War Citadel vault.
 *
 * Brian asked four times whether consolidation was done and got an assumption back each
 * time, because nobody had counted. On 2026-09-17 the real figure was 290,890 units —
 * 31,858 of them in lockers AT War Citadel, one deposit command from the vault.
 *
 * Run it to get the number instead of an opinion:  bun scripts/consolidation.ts
 * Add --sites to list every outstanding location for a given agent.
 *
 * This reads the CACHE (storage_inventory), so it tells you WHERE to look and roughly how
 * much — never exactly what is there. An agent's live `view_storage` is the truth.
 */
import { Database } from 'bun:sqlite'

const HOME = 'crimson_war_citadel'
const db = new Database(`${import.meta.dir}/../data/admiral.db`, { readonly: true })

type Row = { name: string; station_id: string; units: number; lines: number; packages: number }
const rows = db.query<Row, []>(`
  SELECT p.name AS name, si.station_id AS station_id,
         SUM(si.quantity) AS units, COUNT(*) AS lines,
         SUM(CASE WHEN si.item_id LIKE 'package:%' THEN 1 ELSE 0 END) AS packages
    FROM storage_inventory si JOIN profiles p ON p.id = si.profile_id
   WHERE si.quantity > 0 AND si.station_id IS NOT NULL
   GROUP BY p.name, si.station_id
`).all()

// The station id has been seen both as an id and as a display name ("Crimson War Citadel"),
// so compare case- and separator-insensitively rather than with ===. Getting this wrong
// counts a zero-travel deposit as a cross-galaxy haul.
const atHome = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '') === HOME.replace(/_/g, '')

const per = new Map<string, { home: number; remote: number; sites: Row[]; packages: number }>()
for (const r of rows) {
  const a = per.get(r.name) ?? { home: 0, remote: 0, sites: [], packages: 0 }
  if (atHome(r.station_id)) a.home += r.units
  else { a.remote += r.units; a.sites.push(r) }
  a.packages += r.packages
  per.set(r.name, a)
}

const home = [...per.values()].reduce((n, a) => n + a.home, 0)
const remote = [...per.values()].reduce((n, a) => n + a.remote, 0)
const packages = [...per.values()].reduce((n, a) => n + a.packages, 0)

console.log(`\nSTILL IN PERSONAL LOCKERS: ${(home + remote).toLocaleString()} units · ${packages} packages`)
console.log(`  at War Citadel (zero travel, one deposit): ${home.toLocaleString()}`)
console.log(`  elsewhere (withdraw, carry, deposit):      ${remote.toLocaleString()}\n`)
console.log(`${'agent'.padEnd(22)}${'@citadel'.padStart(10)}${'remote'.padStart(10)}${'sites'.padStart(7)}${'pkgs'.padStart(6)}`)
for (const [name, a] of [...per].sort((x, y) => (y[1].home + y[1].remote) - (x[1].home + x[1].remote))) {
  console.log(`${name.split(' -')[0].slice(0, 21).padEnd(22)}${a.home.toLocaleString().padStart(10)}`
    + `${a.remote.toLocaleString().padStart(10)}${String(a.sites.length).padStart(7)}${String(a.packages).padStart(6)}`)
  if (process.argv.includes('--sites')) {
    for (const s of a.sites.sort((p, q) => q.units - p.units)) {
      console.log(`${' '.repeat(6)}${s.units.toLocaleString().padStart(8)} · ${s.lines} lines · ${s.station_id}`
        + (s.packages ? `  <-- ${s.packages} package(s)` : ''))
    }
  }
}
console.log('\n(cache — where to look, not what is there. A live view_storage is the truth.)\n')
