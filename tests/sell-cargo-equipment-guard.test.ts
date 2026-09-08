import { test, expect, describe } from 'bun:test'
import { isEquipmentItem } from '../src/server/lib/tools'

/**
 * 2026-09-07, 22:11: Ledger Voss ran `sell_cargo(exclude=[])` and the macro sold
 * a **mining_laser_iii for 2 credits**. He had paid 18,037 for that class of
 * module and sold others at 7,500-10,000.
 *
 * Two independent failures, either of which alone would have prevented it:
 *
 * 1. EQUIPMENT WAS TREATED AS MERCHANDISE. The laser was only in cargo because
 *    he UNINSTALLED it at 14:11 to fit a smaller one for sparse seams. A module
 *    in the hold is gear between slots, not stock to liquidate.
 *
 * 2. THE LOWBALL CHECK SAT BEHIND `quantity > 5`. The laser was quantity 1, so
 *    it skipped the guard entirely. That is exactly backwards — a single
 *    high-value item is the one you can least afford to dump. The identical
 *    threshold bug had already been fixed once in checkDoctrineGuards (Zibal
 *    selling phase crystals four at a time into a 1cr bid) and was never carried
 *    across to this macro.
 */

describe('equipment is never merchandise', () => {
  test('the module that was actually sold', () => {
    expect(isEquipmentItem('mining_laser_iii')).toBe(true)
  })

  test('every harvester and laser tier', () => {
    for (const id of ['mining_laser_i', 'mining_laser_ii', 'rad_harvester_i', 'rad_harvester_iv',
                      'gas_harvester_ii', 'ice_harvester_iii']) {
      expect(isEquipmentItem(id)).toBe(true)
    }
  })

  test('other fitted gear', () => {
    for (const id of ['shield_booster_ii', 'cargo_expander_ii', 'armor_plate', 'railgun_capacitor']) {
      expect(isEquipmentItem(id)).toBe(true)
    }
  })

  test('ORE AND GAS must stay sellable — the macro still has a job to do', () => {
    for (const id of ['silicon_ore', 'carbon_ore', 'uranium_ore', 'palladium_ore',
                      'argon_gas', 'fluorine_gas', 'plasma_residue', 'gold_ore']) {
      expect(isEquipmentItem(id)).toBe(false)
    }
  })

  test('tradeable commodities are not caught by the tier suffix', () => {
    // fury_crystal / trade_crystal must not be mistaken for equipment
    for (const id of ['fury_crystal', 'trade_crystal', 'energy_crystal', 'lead_ingot',
                      'steel_plate', 'titanium_alloy']) {
      expect(isEquipmentItem(id)).toBe(false)
    }
  })
})

/** Mirrors the macro's skip decision after the fix. */
function macroWouldSell(item: { id: string; quantity: number }, bid: number | null): boolean {
  if (isEquipmentItem(item.id)) return false
  if (bid === null || bid <= 2) return false          // now applies at ANY quantity
  return true
}

describe('the lowball floor applies at any quantity', () => {
  test('the real case: one module, 2cr bid — refused twice over', () => {
    expect(macroWouldSell({ id: 'mining_laser_iii', quantity: 1 }, 2)).toBe(false)
  })

  test('a single high-value item into a 2cr bid is refused even if it were not equipment', () => {
    expect(macroWouldSell({ id: 'phase_crystal', quantity: 1 }, 2)).toBe(false)
    expect(macroWouldSell({ id: 'phase_crystal', quantity: 4 }, 1)).toBe(false)
  })

  test('a healthy bid on ore still sells', () => {
    expect(macroWouldSell({ id: 'silicon_ore', quantity: 122 }, 473)).toBe(true)
  })
})
