import { describe, expect, test } from 'bun:test'
import { weaponAmmoState, tooDryToHunt } from '../src/server/lib/tools'

/**
 * Morg'Thar, Algol Gas Pocket, 2026-09-03 08:45. He attacked a pirate beside a
 * hostile station with FIVE OF SEVEN magazines empty. 24 hostiles answered. He
 * fired six volleys in three minutes — all the loaded ammo he had — took 1,750
 * hull damage and dealt 105. The Crimson Devastator was destroyed and insurance
 * paid 2,640,487cr.
 *
 * He had 29 ferrous_slug_case in his hold. Six of his guns fired that case, one
 * case per magazine. The ammo was aboard the entire time, and being told about
 * it twice hours earlier did not stop him engaging.
 */

// His actual loadout at the moment of the fight.
const MORG_AT_ALGOL = [
  { name: 'Fury Cannon', ammo: '985/1000' },
  { name: 'Mass Driver', ammo: '10/10' },
  { name: 'Mass Driver', ammo: '0/10' },
  { name: 'Piercing Railgun II', ammo: '0/10' },
  { name: 'Piercing Railgun II', ammo: '0/10' },
  { name: 'Railgun II', ammo: '0/7' },
  { name: 'Railgun II', ammo: '0/7' },
  { name: 'Crimson Berserker Plating' },      // not a weapon
  { name: 'Reactive Armor Hardener' },
  { name: 'Darksteel Armor' },
]

describe('weaponAmmoState', () => {
  test('counts only ammo-bearing modules as weapons', () => {
    const s = weaponAmmoState(MORG_AT_ALGOL)
    expect(s.total).toBe(7)          // armour plates are not guns
    expect(s.loaded).toBe(2)
  })

  test('names the dry guns so the agent can reload them', () => {
    const s = weaponAmmoState(MORG_AT_ALGOL)
    expect(s.dry).toHaveLength(5)
    expect(s.dry).toContain('Piercing Railgun II')
    expect(s.dry).toContain('Railgun II')
  })

  test('survives junk without throwing', () => {
    expect(weaponAmmoState(null).total).toBe(0)
    expect(weaponAmmoState([null, 'x', {}, { ammo: 'weird' }]).total).toBe(0)
    expect(weaponAmmoState([{ name: 'g', ammo: '3/10' }]).loaded).toBe(1)
  })
})

describe('tooDryToHunt', () => {
  test('REFUSES the exact loadout that lost the Devastator', () => {
    expect(tooDryToHunt(weaponAmmoState(MORG_AT_ALGOL))).toBe(true)
  })

  test('allows a fully loaded ship', () => {
    expect(tooDryToHunt({ total: 7, loaded: 7 })).toBe(false)
  })

  test('half armament is the line — exactly half passes, below it refuses', () => {
    expect(tooDryToHunt({ total: 6, loaded: 3 })).toBe(false)
    expect(tooDryToHunt({ total: 6, loaded: 2 })).toBe(true)
    expect(tooDryToHunt({ total: 7, loaded: 4 })).toBe(false)
    expect(tooDryToHunt({ total: 7, loaded: 3 })).toBe(true)
  })

  test('a ship with no ammo-using weapons is not blocked', () => {
    // Energy-only or unarmed fits must not be refused by an ammo rule.
    expect(tooDryToHunt({ total: 0, loaded: 0 })).toBe(false)
  })

  test('one gun, empty, is refused', () => {
    expect(tooDryToHunt({ total: 1, loaded: 0 })).toBe(true)
  })
})
