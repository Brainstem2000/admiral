import { describe, expect, test } from 'bun:test'
import { getDb } from '../src/server/lib/db'
import { FleetIntelCollector } from '../src/server/lib/fleet-intel'

/**
 * A facility roster that lists NAMES but not CAPABILITIES cannot answer the only question
 * anyone asks of it: "do we own something that makes X?"
 *
 * On 2026-09-18 the 150-unit plasma_injector line was blocked on ceramite_plating. The
 * Admiral read the game's `facility list` (which returns only the STATION's facilities),
 * found no Plasma Injector Assembly, and nearly reported the line unbuildable — while
 * `fleet_intel_facilities` had the faction-owned assembly sitting right there with
 * `recipe_id` NULL. The row existed; it just could not say what it was for.
 *
 * Two defects, both fixed here:
 *   - recipe_id was never populated for owned facilities (the payload omits it, and
 *     nothing reversed the catalog's produced_by_facility_ids).
 *   - `public` defaults to 1 and was never written, so every faction row claimed to be
 *     public. The Plasma Injector Assembly read as public for weeks while it was private.
 *     `access` is nullable on purpose: NULL means UNKNOWN, never "public".
 */
const SRC = await Bun.file('src/server/lib/fleet-intel.ts').text()
const SRC_DB = await Bun.file('src/server/lib/db.ts').text()
const CAT = await Bun.file('src/server/lib/catalog.ts').text()

describe('an owned facility records what it can make', () => {
  test('the catalog exposes a facility -> recipes reverse index', () => {
    expect(CAT).toContain('export function recipesForFacility')
    expect(CAT).toContain('recipesByFacility')
    // Built from the recipe side; the facility records do not list their recipes.
    expect(CAT).toContain('produced_by_facility_ids')
  })

  test('the ingest resolves recipe_id from the catalog, not the payload alone', () => {
    expect(SRC).toContain('recipesForFacility(type)')
    expect(SRC).toContain('recipe_id')
  })

  test('per-run economics are captured, not dropped', () => {
    expect(SRC).toContain('rental_fee_per_run')
    expect(SRC).toContain('labor_per_run')
  })

  test('the new columns ship in their OWN migration version, not an edited old one', () => {
    // These were first added inside v11, which every live DB had already applied — so the
    // ALTERs never ran and /api/faction/rent returned 500 "no such column: access" the
    // moment the server restarted. A shipped migration is immutable; extend with a new one.
    const DB = SRC_DB
    const v12 = DB.slice(DB.indexOf('version: 12'))
    expect(v12).toContain('rental_fee_per_run')
    expect(v12).toContain('labor_per_run')
    expect(v12).toContain("ADD COLUMN access TEXT")
    // and v11 must NOT be the one carrying them
    const v11 = DB.slice(DB.indexOf('version: 11'), DB.indexOf('version: 12'))
    expect(v11).not.toContain('ADD COLUMN access TEXT')
  })

  test('the new columns exist on the table', () => {
    const cols = (getDb().query('PRAGMA table_info(fleet_intel_facilities)').all() as { name: string }[])
      .map(c => c.name)
    expect(cols).toContain('recipe_id')
    expect(cols).toContain('rental_fee_per_run')
    expect(cols).toContain('labor_per_run')
    expect(cols).toContain('access')
  })
})

describe('the owned-facility roster is RECORDED, not just read', () => {
  /**
   * `faction_owned` is the authoritative roster: it works undocked and covers every
   * station at once. processOwnedFacilities read it only to expire rent obligations and
   * wrote nothing, so a ceramite_sintering_kiln built at 17:18 on 2026-09-18 did not
   * exist as far as Admiral was concerned — the rent page showed 8 facilities while the
   * game listed 9. The fleet cannot use, rent out or avoid rebuilding what it has no
   * record of.
   */
  test('the owned handler upserts rows, not only lapse checks', () => {
    const owned = SRC.slice(SRC.indexOf('private static processOwnedFacilities'),
                            SRC.indexOf('private static processFacilities'))
    expect(owned).toContain('INSERT INTO fleet_intel_facilities')
    expect(owned).toContain('faction_owned      = 1')
    // and it must carry capability + economics through, like the list path does
    expect(owned).toContain('recipesForFacility(type)')
    expect(owned).toContain('rental_fee_per_run')
  })

  test("the FACTION roster's own action spelling is dispatched", () => {
    // `facility action=faction_owned` answers with action 'faction_owned'. The switch carried
    // only 'owned' and 'facility_owned', so the handler never ran for the faction roster at
    // all — silently, for as long as it has existed.
    expect(SRC).toContain("case 'faction_owned': return this.processOwnedFacilities")
  })

  test('a roster pass retires facilities the game no longer lists', () => {
    const owned = SRC.slice(SRC.indexOf('private static processOwnedFacilities'),
                            SRC.indexOf('private static processFacilities'))
    expect(owned).toContain('faction_owned = 0')
    expect(owned).toContain('no longer faction-owned')
  })

  test('each row is keyed on its OWN base_id, not the caller position', () => {
    const owned = SRC.slice(SRC.indexOf('private static processOwnedFacilities'),
                            SRC.indexOf('private static processFacilities'))
    // The roster spans stations; keying every row to where the agent stands would
    // collapse an iron_reach lockbox onto the War Citadel one.
    expect(owned).toContain('str(f.base_id || f.station_id')
  })

  test('a public_facilities roster is captured too', () => {
    // The alzirr survey returned `public_facilities` and persisted nothing.
    expect(SRC).toContain('rows: r.public_facilities')
  })
})

describe('access is only recorded when the game states it', () => {
  test('set_access is dispatched', () => {
    expect(SRC).toContain("case 'set_access':")
    expect(SRC).toContain('processFacilityAccess')
  })

  test('a set_access response writes the real state', () => {
    const db = getDb()
    db.query(`INSERT OR REPLACE INTO fleet_intel_facilities
      (station_id, facility_type, facility_name, reported_by, facility_uid, faction_owned)
      VALUES ('t_station','t_assembly','T Assembly','test','uid_test_1',1)`).run()
    // The live shape: a details object carrying facility_id + access.
    const F = FleetIntelCollector as unknown as { processFacilityAccess(r: Record<string, unknown>): void }
    F.processFacilityAccess({ details: { action: 'set_access', facility_id: 'uid_test_1', access: 'public' } })
    const row = db.query(`SELECT access, public FROM fleet_intel_facilities WHERE facility_uid='uid_test_1'`)
      .get() as { access: string; public: number }
    expect(row.access).toBe('public')
    expect(row.public).toBe(1)

    // ...and private is recorded as private, which the defaulted column could never say.
    F.processFacilityAccess({ details: { facility_id: 'uid_test_1', access: 'private' } })
    const row2 = db.query(`SELECT access, public FROM fleet_intel_facilities WHERE facility_uid='uid_test_1'`)
      .get() as { access: string; public: number }
    expect(row2.access).toBe('private')
    expect(row2.public).toBe(0)

    db.query(`DELETE FROM fleet_intel_facilities WHERE facility_uid='uid_test_1'`).run()
  })

  test('a response with no access value changes nothing', () => {
    const db = getDb()
    db.query(`INSERT OR REPLACE INTO fleet_intel_facilities
      (station_id, facility_type, facility_name, reported_by, facility_uid, faction_owned, access)
      VALUES ('t_station','t_two','T Two','test','uid_test_2',1,'private')`).run()
    const F = FleetIntelCollector as unknown as { processFacilityAccess(r: Record<string, unknown>): void }
    F.processFacilityAccess({ details: { facility_id: 'uid_test_2', access: 'sort-of' } })
    const row = db.query(`SELECT access FROM fleet_intel_facilities WHERE facility_uid='uid_test_2'`)
      .get() as { access: string }
    expect(row.access).toBe('private')
    db.query(`DELETE FROM fleet_intel_facilities WHERE facility_uid='uid_test_2'`).run()
  })
})
