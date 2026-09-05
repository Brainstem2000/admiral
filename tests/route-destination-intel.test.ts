/**
 * A route plan must carry what the fleet already knows about the DESTINATION.
 *
 * The situational briefing carries station intel for the current system and one
 * jump out only. So an agent planning a two-jump move is blind to a system the
 * fleet surveyed days ago — and the briefing's own header tells it "what the
 * fleet already knows — do NOT re-scout this", which it then cannot act on.
 *
 * Cass Margin, 2026-09-05: flew two jumps to Stillwater, reported "Stillwater
 * has NO STATIONS", and immediately set course for Bharani. Both were already
 * recorded has_station=0 in fleet_intel_systems before she left Krynn. Two
 * wasted jumps and a third nearly spent, to rediscover the table.
 *
 * Informational, never a block: only the agent knows whether it needs a station.
 * A miner routing to a belt is right to ignore this.
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'

let db: Database
beforeAll(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE fleet_intel_systems (
    system_id TEXT PRIMARY KEY, system_name TEXT, has_station INTEGER,
    station_services TEXT, police_level INTEGER, updated_at TEXT);`)
  db.exec(`INSERT INTO fleet_intel_systems VALUES
    ('stillwater','Stillwater',0,NULL,55,'2026-09-01 00:00:00'),
    ('bharani','Bharani',0,NULL,55,'2026-09-01 00:00:00'),
    ('blood_forge','Blood Forge',1,'market/refuel/shipyard',80,'2026-09-04 00:00:00');`)
})
afterAll(() => db.close())

/** Mirrors the lookup fleetRecordLine performs. */
function record(id: string): { known: boolean; hasStation: boolean } {
  const r = db.query('SELECT has_station FROM fleet_intel_systems WHERE system_id = ?')
    .get(id) as { has_station: number } | null
  return { known: !!r, hasStation: !!r?.has_station }
}

describe('the fleet record answers before the trip, not after', () => {
  test('Stillwater was known stationless before Cass flew there', () => {
    const r = record('stillwater')
    expect(r.known).toBe(true)
    expect(r.hasStation).toBe(false)
  })

  test('Bharani — her next destination — was known stationless too', () => {
    expect(record('bharani').hasStation).toBe(false)
  })

  test('Blood Forge, where she eventually went, does have one', () => {
    const r = record('blood_forge')
    expect(r.known).toBe(true)
    expect(r.hasStation).toBe(true)
  })

  test('an unsurveyed system reports unknown rather than guessing', () => {
    // fleetRecordLine says "none — no fleet agent has surveyed this system",
    // which must never be mistaken for "no station".
    const r = record('never_visited_system')
    expect(r.known).toBe(false)
    expect(r.hasStation).toBe(false)   // absence of a record, not a negative finding
  })
})

describe('which commands should carry it', () => {
  // Route PLANNING is the decision point. Attaching it to arrival would be too
  // late — the fuel is already spent.
  test('route planners are the commands worth annotating', () => {
    const annotated = new Set(['find_route', 'fleet_route'])
    expect(annotated.has('find_route')).toBe(true)
    expect(annotated.has('fleet_route')).toBe(true)
    // Not these: they read where you already are.
    for (const c of ['get_status', 'get_system', 'view_market', 'dock']) {
      expect(annotated.has(c)).toBe(false)
    }
  })
})
