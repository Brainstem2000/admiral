/**
 * A commission bill reserves stock only while the hull is UNBUILT.
 *
 * `commission_requirements` is never cleared on delivery — setCommissionRequirements
 * only replaces rows for the same ship_class — so a completed build leaves its bill
 * behind indefinitely. Juno Freight's caravan was delivered and parked at War Citadel
 * on 2026-09-04 while her 13 requirement rows from that morning still stood.
 *
 * This matters because the briefing's "reserved by your open commission" label now
 * reads this table. It replaced a HARDCODED stale list (galaxy-market.ts `LOCKED`)
 * that had told every agent for a week that 36,027 units of ore were unsellable.
 * Swapping one stale source for another would have reproduced the same false-lock
 * bug one layer down — Juno owned the titanium_alloy, steel_plate and copper_wiring
 * her own delivered commission would have "reserved".
 *
 * Owning the hull retires its bill, so the check is self-correcting rather than
 * depending on a cleanup that has never run.
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'

// Mirrors the NOT EXISTS clause in getCommissionRequirement.
const OWNED = `SELECT 1 FROM storage_ships ss
                WHERE ss.profile_id = commission_requirements.profile_id
                  AND LOWER(ss.class) = LOWER(commission_requirements.ship_class)`

let db: Database
beforeAll(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE commission_requirements (ship_class TEXT, item_id TEXT, quantity INTEGER, profile_id TEXT);
           CREATE TABLE storage_ships (profile_id TEXT, station_id TEXT, ship_id TEXT, class TEXT);`)
  // Two agents, identical bills. One has taken delivery, one has not.
  db.exec(`INSERT INTO commission_requirements VALUES
             ('caravan','titanium_alloy',50,'delivered-agent'),
             ('devastator','titanium_alloy',80,'building-agent');
           INSERT INTO storage_ships VALUES ('delivered-agent','war_citadel','s1','caravan');`)
})
afterAll(() => db.close())

function requirement(itemId: string, profileId: string): number {
  const r = db.query(`SELECT MAX(quantity) AS q FROM commission_requirements
     WHERE item_id = ? AND (profile_id IS NULL OR profile_id = ?) AND NOT EXISTS (${OWNED})`)
    .get(itemId, profileId) as { q: number | null }
  return r?.q ?? 0
}

describe('commission bills retire on delivery', () => {
  test('a delivered hull no longer reserves its materials', () => {
    expect(requirement('titanium_alloy', 'delivered-agent')).toBe(0)
  })

  test('an UNBUILT hull still reserves them — the mechanism must keep working', () => {
    expect(requirement('titanium_alloy', 'building-agent')).toBe(80)
  })

  test("one agent's bill never reserves another agent's stock", () => {
    // Commissions consume only the commissioning player's own storage, so
    // Juno's open caravan bill must not gag Morg.
    expect(requirement('titanium_alloy', 'unrelated-agent')).toBe(0)
  })

  test('class matching is case-insensitive', () => {
    db.exec(`UPDATE storage_ships SET class = 'CARAVAN' WHERE profile_id = 'delivered-agent'`)
    expect(requirement('titanium_alloy', 'delivered-agent')).toBe(0)
    db.exec(`UPDATE storage_ships SET class = 'caravan' WHERE profile_id = 'delivered-agent'`)
  })

  test('owning a DIFFERENT hull does not retire the bill', () => {
    db.exec(`INSERT INTO storage_ships VALUES ('building-agent','x','s2','prospect')`)
    expect(requirement('titanium_alloy', 'building-agent')).toBe(80)
  })
})
