/**
 * The ships table went stale after every hull swap, and two plans were built on it.
 *
 * `storage_ships` was written only by `list_ships`. Across the seven days to
 * 2026-09-05 the fleet called `list_ships` 23 times and `get_ship` 550 — so the
 * table recorded whichever hull an agent last happened to enumerate, and drifted
 * silently from then on. `get_ship` carries the live hull in every one of those
 * 550 results and the handler discarded it, keeping only the module list.
 *
 * What that cost: the table had Ledger Voss in a `theoria` while he flew the
 * Siege Breaker he had bought hours earlier, and Morg'Thar in a 1,450-cargo
 * `war_wagon` while he was actually in a 60-cargo scout. A fury_alloy haul was
 * planned against that phantom War Wagon — 252 fury_crystal at size 2 is 504
 * cargo — and only fell apart when the live game was read directly.
 *
 * A stale row is worse than an empty one, because ship-match, the refit planner
 * and the dashboard all report from it with no indication the hull is a guess.
 */
import { test, expect, describe, beforeEach, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'

let db: Database

/** Mirrors recordActiveShip in db.ts. */
function recordActiveShip(profileId: string, shipId: string, classId: string): void {
  if (!shipId || shipId === 'active') return
  const tx = db.transaction(() => {
    db.query(`DELETE FROM storage_ships WHERE profile_id = ? AND station_id = '__active__' AND ship_id != ?`)
      .run(profileId, shipId)
    db.query(`INSERT INTO storage_ships (profile_id, station_id, ship_id, class, updated_at)
              VALUES (?, '__active__', ?, ?, datetime('now'))
              ON CONFLICT(profile_id, station_id, ship_id)
              DO UPDATE SET class = excluded.class, updated_at = excluded.updated_at`)
      .run(profileId, shipId, classId ?? '')
    db.query(`DELETE FROM storage_ships WHERE profile_id = ? AND ship_id = ? AND station_id != '__active__'`)
      .run(profileId, shipId)
  })
  tx()
}

const active = (p: string) =>
  db.query(`SELECT class, ship_id FROM storage_ships WHERE profile_id=? AND station_id='__active__'`).all(p) as any[]
const rows = (p: string) =>
  db.query(`SELECT station_id, class, ship_id FROM storage_ships WHERE profile_id=? ORDER BY station_id`).all(p) as any[]

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE storage_ships (
    profile_id TEXT NOT NULL, station_id TEXT NOT NULL, ship_id TEXT NOT NULL,
    class TEXT DEFAULT '', custom_name TEXT DEFAULT '', module_count INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (profile_id, station_id, ship_id));`)
})
afterAll(() => db?.close())

describe('a get_ship reading corrects the active hull', () => {
  test("Morg's phantom War Wagon is replaced by the hull he is actually in", () => {
    // The exact stale row from 2026-09-05.
    db.query(`INSERT INTO storage_ships (profile_id, station_id, ship_id, class) VALUES ('morg','__active__','old-wagon-id','war_wagon')`).run()
    recordActiveShip('morg', 'f93be93459554798f7d3510c8aa02693', 'catalogue')
    expect(active('morg')).toEqual([{ class: 'catalogue', ship_id: 'f93be93459554798f7d3510c8aa02693' }])
  })

  test("Ledger's theoria row is replaced by the Siege Breaker", () => {
    db.query(`INSERT INTO storage_ships (profile_id, station_id, ship_id, class) VALUES ('ledger','__active__','5f0e86','theoria')`).run()
    recordActiveShip('ledger', 'ec6299361312c1d31c9c9302ee9456ea', 'siege_breaker')
    expect(active('ledger').map(r => r.class)).toEqual(['siege_breaker'])
  })

  test('exactly one hull can be active — no duplicate __active__ rows accumulate', () => {
    recordActiveShip('morg', 'ship-a', 'catalogue')
    recordActiveShip('morg', 'ship-b', 'digger')
    recordActiveShip('morg', 'ship-c', 'shard')
    expect(active('morg')).toHaveLength(1)
    expect(active('morg')[0].class).toBe('shard')
  })

  test('stored hulls belonging to other ships are left alone', () => {
    db.query(`INSERT INTO storage_ships (profile_id, station_id, ship_id, class) VALUES ('morg','the_obsidian_well','wagon-id','war_wagon')`).run()
    db.query(`INSERT INTO storage_ships (profile_id, station_id, ship_id, class) VALUES ('morg','crimson_war_citadel','digger-id','digger')`).run()
    recordActiveShip('morg', 'catalogue-id', 'catalogue')
    expect(rows('morg').map(r => r.class).sort()).toEqual(['catalogue', 'digger', 'war_wagon'])
  })

  test('a ship cannot be active and in storage at the same time', () => {
    // The agent flew away in a hull the table still lists as parked.
    db.query(`INSERT INTO storage_ships (profile_id, station_id, ship_id, class) VALUES ('morg','the_obsidian_well','wagon-id','war_wagon')`).run()
    recordActiveShip('morg', 'wagon-id', 'war_wagon')
    expect(rows('morg')).toEqual([{ station_id: '__active__', class: 'war_wagon', ship_id: 'wagon-id' }])
  })

  test('re-reading the same ship is idempotent', () => {
    recordActiveShip('morg', 'ship-a', 'catalogue')
    recordActiveShip('morg', 'ship-a', 'catalogue')
    expect(rows('morg')).toHaveLength(1)
  })

  test('one agent switching hulls never disturbs another agent', () => {
    recordActiveShip('ledger', 'led-1', 'siege_breaker')
    recordActiveShip('morg', 'morg-1', 'catalogue')
    recordActiveShip('morg', 'morg-2', 'digger')
    expect(active('ledger')).toEqual([{ class: 'siege_breaker', ship_id: 'led-1' }])
  })

  test('a payload with no usable ship id changes nothing', () => {
    // get_ship nests the hull under `ship`; reading the top level yielded the
    // literal string "active", which must never become a row.
    db.query(`INSERT INTO storage_ships (profile_id, station_id, ship_id, class) VALUES ('morg','__active__','real-id','catalogue')`).run()
    recordActiveShip('morg', 'active', 'war_wagon')
    recordActiveShip('morg', '', 'war_wagon')
    expect(active('morg')).toEqual([{ class: 'catalogue', ship_id: 'real-id' }])
  })
})
