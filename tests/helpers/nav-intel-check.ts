/**
 * Subprocess helper for the fleet-intel briefing tests.
 *
 * db.ts resolves DB_PATH from process.cwd() AT MODULE LOAD, so a test that
 * chdir's into a temp workspace and then imports db.ts only gets an isolated
 * database if NOTHING ELSE in the same process imported db.ts first. In a
 * full-suite run something always has, which means the test would open the
 * REAL data/admiral.db and write fixtures into live fleet state.
 *
 * That is not hypothetical: it happened once and put 43 fake systems and 42
 * fake links into the fleet's intel tables, which then showed up in an agent's
 * navigation briefing. Running in a fresh process (the same approach as
 * helpers/db-migration-check.ts) makes the isolation structural.
 *
 * Prints one __RESULT__<json> line for the parent to assert on.
 */
const workspace = process.argv[2]
if (!workspace) throw new Error('temporary workspace path is required')
process.chdir(workspace)

const fs = await import('node:fs')
const { getDb, getNavIntel, getHuntIntel } = await import('../../src/server/lib/db')

const db = getDb()
const opened = fs.realpathSync((db as unknown as { filename: string }).filename)
if (!opened.startsWith(fs.realpathSync(workspace))) {
  throw new Error(`db opened outside the temp workspace: ${opened}`)
}

// A tiny galaxy: a hub with a full-service station, a pirate den, a dead end.
const upsertSystem = (id: string, name: string, empire: string | null, pois: number, station: number, services: string | null, police: number) =>
  db.query(`INSERT OR REPLACE INTO fleet_intel_systems
    (system_id, system_name, empire, poi_count, has_station, station_services, police_level, discovered_by)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, name, empire, pois, station, services, police, 'fixture')

upsertSystem('hub', 'Hub', 'outerrim', 4, 1, 'missions,refuel,repair,market', 80)
upsertSystem('den', 'Den', null, 3, 0, null, 0)
upsertSystem('dead_end', 'Dead End', null, 1, 0, null, 0)

db.query(`INSERT OR REPLACE INTO system_links (a, b, source) VALUES (?,?,?)`).run('hub', 'den', 'fixture')
// Stored in the opposite direction on purpose: links are undirected.
db.query(`INSERT OR REPLACE INTO system_links (a, b, source) VALUES (?,?,?)`).run('dead_end', 'hub', 'fixture')

db.query(`INSERT OR REPLACE INTO system_danger_daily (system_id, day, grade, evidence) VALUES (?,?,?,?)`)
  .run('den', '2026-09-01', 'DANGEROUS', 'fixture')
db.query(`INSERT OR REPLACE INTO fleet_intel_killzones
  (poi_id, system_id, system_name, poi_name, poi_type, pirate_seen, wreck_seen, discovered_by)
  VALUES (?,?,?,?,?,?,?,?)`).run('den_cloud', 'den', 'Den', 'Den Gas Cloud', 'cloud', 9, 0, 'fixture')

// Over-connect the hub to prove the neighbour cap holds.
for (let i = 0; i < 40; i++) {
  upsertSystem(`far_${i}`, `Far ${i}`, null, 1, 0, null, 0)
  db.query(`INSERT OR REPLACE INTO system_links (a, b, source) VALUES (?,?,?)`).run('hub', `far_${i}`, 'fixture')
}
// ...and over-report killzones to prove the hunting cap holds.
for (let i = 0; i < 30; i++) {
  db.query(`INSERT OR REPLACE INTO fleet_intel_killzones
    (poi_id, system_id, system_name, poi_name, poi_type, pirate_seen, wreck_seen, discovered_by)
    VALUES (?,?,?,?,?,?,?,?)`).run(`kz_${i}`, `kzsys_${i}`, `KZ ${i}`, `KZ POI ${i}`, 'belt', 5, 0, 'fixture')
}

const fromHub = getNavIntel('hub')
const fromDeadEnd = getNavIntel('dead_end')

console.log('__RESULT__' + JSON.stringify({
  hubNeighbourIds: fromHub.neighbours.map(n => n.system_id).sort(),
  hubNeighbourCount: fromHub.neighbours.length,
  hubCurrentId: fromHub.current?.system_id ?? null,
  hubFirstHasStation: fromHub.neighbours[0]?.has_station ?? null,
  hubFromDeadEnd: fromDeadEnd.neighbours.find(n => n.system_id === 'hub') ?? null,
  den: getNavIntel('den').current,
  unknown: getNavIntel('never_visited_xyz'),
  hunt: getHuntIntel('hub'),
}))
