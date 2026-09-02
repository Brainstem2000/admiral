/**
 * Subprocess helper for the ghost-station tests (see station-intel.test.ts).
 *
 * Runs in its own process for the same reason nav-intel-check.ts does: db.ts
 * binds DB_PATH from cwd at module load, so only a fresh process that chdir's
 * BEFORE importing gets an isolated database instead of the live fleet one.
 * The stations feed is stubbed through its test seam — no network, no disk.
 *
 * Prints one __RESULT__<json> line for the parent to assert on.
 */
const workspace = process.argv[2]
if (!workspace) throw new Error('temporary workspace path is required')
process.chdir(workspace)

const fs = await import('node:fs')
const { getDb, applyStationsFeed } = await import('../../src/server/lib/db')
const { FleetIntelCollector } = await import('../../src/server/lib/fleet-intel')
const { __setStationsFeedForTests } = await import('../../src/server/lib/stations-feed')

const db = getDb()
const opened = fs.realpathSync((db as unknown as { filename: string }).filename)
if (!opened.startsWith(fs.realpathSync(workspace))) {
  throw new Error(`db opened outside the temp workspace: ${opened}`)
}

type Row = { system_id: string; has_station: number; station_services: string | null } | null
const sys = (id: string): Row =>
  db.query('SELECT system_id, has_station, station_services FROM fleet_intel_systems WHERE system_id = ?').get(id) as Row
const seed = (id: string, station: number, services: string | null) =>
  db.query(`INSERT OR REPLACE INTO fleet_intel_systems (system_id, system_name, has_station, station_services, discovered_by)
    VALUES (?, ?, ?, ?, 'fixture')`).run(id, id.toUpperCase(), station, services)

const belt = { id: 'belt', name: 'Belt', type: 'asteroid_belt', has_base: false }
const dock = (id: string) => ({ id: `${id}_poi`, name: 'Station', type: 'station', has_base: true, base_id: `${id}_station` })
const getSystem = (id: string, pois?: unknown[]) => ({
  action: 'get_system',
  system: { id, name: id.toUpperCase(), police_level: 50, connections: [], ...(pois ? { pois } : {}) },
})
const ingest = (command: string, payload: unknown) => FleetIntelCollector.processCommandResult(command, payload, 'Tester')

const out: Record<string, unknown> = {}

// ---- Feed unavailable: observations alone must still clear and set the flag ----
__setStationsFeedForTests(null)

// The latch: a phantom flagged with copied services, then a live get_system showing no base.
seed('phantom', 1, 'missions,refuel,repair')
ingest('get_system', getSystem('phantom', [belt]))
out.latchCleared = sys('phantom')

// No POI list at all is not evidence either way.
seed('kept', 1, 'market')
ingest('get_system', getSystem('kept'))
out.noPoisKept = sys('kept')

// Without the feed, get_base's own system_id is the only lead and is used.
seed('lonely', 0, null)
ingest('get_base', { base: { id: 'lonely_station', poi_id: 'p', name: 'Lonely' }, services: ['refuel'], system_id: 'lonely' })
out.noFeedBaseSets = sys('lonely')

// ...and a get_system with a base POI sets it on a brand-new row.
ingest('get_system', getSystem('newsys', [dock('newsys')]))
out.noFeedSystemSets = sys('newsys')

// ---- Feed available (padded past the plausibility floor) ----
const feed: Array<Record<string, unknown>> = [
  { id: 'real_station', base_id: 'real_station', poi_id: 'real_poi', name: 'Real', type: 'station',
    system_id: 'realsys', system_name: 'Realsys', services: ['market', 'missions'] },
]
for (let i = 0; i < 45; i++) {
  feed.push({ id: `pad_${i}`, base_id: `pad_${i}`, poi_id: `padpoi_${i}`, name: `Pad ${i}`, type: 'station',
    system_id: `padsys_${i}`, system_name: `Padsys ${i}`, services: ['refuel'] })
}
__setStationsFeedForTests(feed)

// A base POI in a system the feed does not list is refused.
ingest('get_system', getSystem('ghost', [dock('ghost')]))
out.ghostRefused = sys('ghost')

// A real one is flagged, with the feed's service list filled in.
ingest('get_system', getSystem('realsys', [dock('realsys')]))
out.realFlagged = sys('realsys')

// COPY-ID: a get_base for the real station arrives carrying somebody else's system_id.
seed('ghost2', 0, null)
ingest('get_base', { base: { id: 'real_station', poi_id: 'real_poi', name: 'Real' },
  services: ['market', 'missions', 'refuel'], system_id: 'ghost2' })
out.copyIdGhost = sys('ghost2')
out.copyIdReal = sys('realsys')

// An unknown base claiming a feed-refuted system is refused outright.
seed('ghost3', 0, null)
ingest('get_base', { base: { id: 'mystery_base', poi_id: 'q', name: 'Mystery' }, services: ['refuel'], system_id: 'ghost3' })
out.unknownBaseRefused = sys('ghost3')

// The latch clears even when the payload CLAIMS a base but the feed refutes it.
seed('phantom2', 1, 'missions,refuel')
ingest('get_system', getSystem('phantom2', [dock('phantom2')]))
out.feedRefutesLatch = sys('phantom2')

// ---- Backfill reconcile ----
seed('phantom3', 1, 'copied,services')
const full = applyStationsFeed(feed as Array<{ system_id: string; system_name?: string; services?: unknown }>)
out.backfill = { touched: full.touched, cleared: full.cleared, phantom3: sys('phantom3'), pad0: sys('padsys_0'), realsys: sys('realsys') }

// A short (implausible) list fills in but never clears.
seed('phantom4', 1, 'copied,services')
const short = applyStationsFeed(feed.slice(0, 3) as Array<{ system_id: string; system_name?: string; services?: unknown }>)
out.shortFeed = { cleared: short.cleared, phantom4: sys('phantom4') }

// ---- Stale feed (two days old) counts as unavailable: observations rule again ----
__setStationsFeedForTests(feed, Date.now() - 48 * 60 * 60 * 1000)
ingest('get_system', getSystem('stale_ghost', [dock('stale_ghost')]))
out.staleFeedIgnored = sys('stale_ghost')

console.log('__RESULT__' + JSON.stringify(out))
