import { describe, expect, test } from 'bun:test'
import { weaponAmmoState, tooDryToHunt } from '../src/server/lib/tools'

/**
 * The ammo gate must read BOTH payload shapes, or it is not a gate.
 *
 * http reports a magazine as one "loaded/capacity" STRING in `ammo`. lib_v2
 * reports two NUMBERS — `current_ammo` and `magazine_size` — and carries no
 * `ammo` field at all. weaponAmmoState originally matched only the string, so
 * every lib_v2 weapon hit the `continue`, `total` stayed 0, and tooDryToHunt
 * returned false ("no ammo-using weapons, not our call") for the whole fleet.
 *
 * The guard therefore never fired once, and it is the guard that exists because
 * Morg'Thar was destroyed at Algol on 2026-09-03 engaging with five of seven
 * magazines empty while carrying 29 unused cases — a 2.6M warship.
 *
 * It went unnoticed until 2026-09-14, when he fought at Nekkar Star from 5:09pm
 * with all five railguns at current_ammo 0: 49 hits taken, zero shots fired, and
 * the game printing "Your weapons cannot fire — magazine empty!" eleven times
 * while hunt_here queued the next target.
 *
 * This is the same silent stand-down the fuel-floor gate had, for the same
 * reason: a gate written against one transport's field names.
 */

/** Exactly how lib_v2's get_ship renders a Railgun II. */
const libV2Gun = (current: number) => ({
  module_id: '9d0d012ecd2ca40cafa51c6adbd30570',
  type_id: 'railgun_ii',
  name: 'Railgun II',
  type: 'weapon',
  slot: 'weapon',
  magazine_size: 7,
  current_ammo: current,
  ammo_type: 'railgun',
  loaded_ammo_id: 'ferrous_slug_case',
})

/** The http shape: one string, no separate numbers. */
const httpGun = (text: string) => ({ name: 'Railgun II', ammo: text })

describe('weaponAmmoState reads both transports', () => {
  test('lib_v2 numeric fields are counted — the shape that was being dropped', () => {
    const s = weaponAmmoState([libV2Gun(7), libV2Gun(7), libV2Gun(0)])
    expect(s.total).toBe(3)
    expect(s.loaded).toBe(2)
    expect(s.dry).toEqual(['Railgun II'])
  })

  test('http string fields still work', () => {
    const s = weaponAmmoState([httpGun('7/7'), httpGun('0/7')])
    expect(s.total).toBe(2)
    expect(s.loaded).toBe(1)
  })

  test('a mixed loadout counts every gun once', () => {
    const s = weaponAmmoState([libV2Gun(3), httpGun('0/7')])
    expect(s.total).toBe(2)
    expect(s.loaded).toBe(1)
  })

  test('Morg at Nekkar: five lib_v2 railguns at zero reads fully dry', () => {
    const s = weaponAmmoState(Array.from({ length: 5 }, () => libV2Gun(0)))
    expect(s.total).toBe(5)
    expect(s.loaded).toBe(0)
    // The whole point: this must now refuse.
    expect(tooDryToHunt(s)).toBe(true)
  })

  test('the pre-fix behaviour is gone — lib_v2 guns no longer read as "no weapons"', () => {
    const s = weaponAmmoState([libV2Gun(0), libV2Gun(0)])
    // total 0 was the bug: it made tooDryToHunt answer false and stand down.
    expect(s.total).not.toBe(0)
    expect(tooDryToHunt(s)).toBe(true)
  })

  test('energy weapons with no ammo fields are still ignored', () => {
    const s = weaponAmmoState([
      { name: 'Pulse Laser I', type: 'weapon', slot: 'weapon' },
      { name: 'Shield Booster I', slot: 'defense' },
    ])
    expect(s.total).toBe(0)
    expect(tooDryToHunt(s)).toBe(false)   // not our call, correctly
  })

  test('half armament is the refusal line, in both shapes', () => {
    expect(tooDryToHunt(weaponAmmoState([libV2Gun(7), libV2Gun(0)]))).toBe(false)      // 1/2 is not under half
    expect(tooDryToHunt(weaponAmmoState([libV2Gun(7), libV2Gun(0), libV2Gun(0)]))).toBe(true)
    expect(tooDryToHunt(weaponAmmoState([httpGun('7/7'), httpGun('0/7'), httpGun('0/7')]))).toBe(true)
  })

  test('a non-array or junk module list is not a crash and not a refusal', () => {
    expect(weaponAmmoState(null).total).toBe(0)
    expect(weaponAmmoState('nonsense').total).toBe(0)
    expect(weaponAmmoState([null, 3, 'x']).total).toBe(0)
  })
})

describe('dryGuns carries what reload actually needs', () => {
  test('a dry lib_v2 gun yields its INSTANCE id and its ammo item', () => {
    const s = weaponAmmoState([libV2Gun(0)])
    expect(s.dryGuns).toEqual([{
      // module_id, never type_id — reload addresses the fitted instance.
      id: '9d0d012ecd2ca40cafa51c6adbd30570',
      name: 'Railgun II',
      ammoId: 'ferrous_slug_case',
    }])
  })

  test('loaded guns are never offered for reload', () => {
    expect(weaponAmmoState([libV2Gun(7), libV2Gun(0)]).dryGuns.length).toBe(1)
  })

  test('a gun the macro cannot address is left out rather than half-built', () => {
    // No instance id and no ammo id: reload would be a guess, so it is not attempted.
    const s = weaponAmmoState([{ name: 'Mystery Gun', current_ammo: 0, magazine_size: 7 }])
    expect(s.total).toBe(1)          // still counted as dry for the refusal
    expect(s.dry).toEqual(['Mystery Gun'])
    expect(s.dryGuns).toEqual([])    // but not reloadable
  })
})
