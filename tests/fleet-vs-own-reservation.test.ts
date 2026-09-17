import { describe, expect, test } from 'bun:test'
import { getDb, getCommissionRequirement, getOwnCommissionRequirement } from '../src/server/lib/db'

/**
 * A reservation has to lock fleet-wide but be DESCRIBED honestly.
 *
 * `devastator_industry` rows carry profile_id NULL — the industrial programme's raw
 * materials, reserved against every agent. `getCommissionRequirement` matches
 * (profile_id IS NULL OR profile_id = ?), which is right: a fleet plan should stop a
 * sale exactly as a personal commission does.
 *
 * The briefing then worded every one of those locks as "reserved by YOUR open
 * commission". Juno Freight halted repeatedly on 2026-09-17 because of it: he ran
 * commission_status, got "No active commissions", and could not reconcile that with
 * injected state asserting the opposite every single turn. Injected state outranks any
 * nudge the Admiral can send, so the wording had to change, not the agent.
 *
 * getOwnCommissionRequirement answers the narrower question the wording needs.
 */
const SHIP = `hull_${Math.random().toString(36).slice(2, 8)}`
const FLEET_ITEM = `fleetmat_${Math.random().toString(36).slice(2, 8)}`
const OWN_ITEM = `ownmat_${Math.random().toString(36).slice(2, 8)}`
const PID = `p_res_${Math.random().toString(36).slice(2, 8)}`

function seed() {
  const d = getDb()
  // storage_ships carries a FK to profiles; the hull-retires case below needs a real row.
  d.query('INSERT OR IGNORE INTO profiles (id, name) VALUES (?, ?)').run(PID, 'Reservation Tester')
  d.query('INSERT INTO commission_requirements (ship_class, item_id, quantity, profile_id) VALUES (?,?,?,NULL)')
    .run('devastator_industry', FLEET_ITEM, 26_250)
  d.query('INSERT INTO commission_requirements (ship_class, item_id, quantity, profile_id) VALUES (?,?,?,?)')
    .run(SHIP, OWN_ITEM, 80, PID)
}

describe('a fleet-wide reservation locks everyone but belongs to nobody', () => {
  test('the LOCK covers an agent who has no commission of their own', () => {
    seed()
    // This is the behaviour to preserve — the sale guard must still fire.
    expect(getCommissionRequirement(FLEET_ITEM, PID)).toBe(26_250)
  })

  test('but it is NOT that agent\'s commission, which is what the briefing must say', () => {
    expect(getOwnCommissionRequirement(FLEET_ITEM, PID)).toBe(0)
  })

  test('an agent\'s own bill is still theirs', () => {
    expect(getOwnCommissionRequirement(OWN_ITEM, PID)).toBe(80)
    expect(getCommissionRequirement(OWN_ITEM, PID)).toBe(80)
  })

  test('owning the hull retires the agent\'s own bill, same as the wider check', () => {
    getDb().query('INSERT INTO storage_ships (profile_id, station_id, ship_id, class) VALUES (?,?,?,?)')
      .run(PID, 'crimson_war_citadel', `s_${PID}`, SHIP)
    expect(getOwnCommissionRequirement(OWN_ITEM, PID)).toBe(0)
    // The fleet row is untouched by anyone's hull — it was never tied to a delivery.
    expect(getCommissionRequirement(FLEET_ITEM, PID)).toBe(26_250)
  })

  test('no profile id never invents an ownership claim', () => {
    expect(getOwnCommissionRequirement(FLEET_ITEM, '')).toBe(0)
  })
})

describe('the briefing carries BOTH wordings, and only the fleet one disclaims a commission', () => {
  const SRC = Bun.file('src/server/lib/galaxy-market.ts')

  test('the fleet line tells the agent commission_status will show them none', async () => {
    const t = await SRC.text()
    const line = t.split('\n').find(l => l.includes("reserved by the FLEET's industrial plan"))
    expect(line).toBeDefined()
    // Without this clause the agent is back to reconciling two contradictory sources.
    expect(line!).toContain('commission_status')
    expect(line!).toContain('DO NOT SELL')
    expect(line!.toLowerCase()).toContain('spend')
  })

  test('the personal line is still reserved for an actual own-ship reservation', async () => {
    const t = await SRC.text()
    expect(t).toContain('ownReservation(id, opts.profileId)')
    expect(t).toContain('getOwnCommissionRequirement')
  })
})
