import { describe, expect, test } from 'bun:test'
import { isOperationalConsumable, isEquipmentItem } from '../src/server/lib/tools'

/**
 * A tool the agent is carrying in order to DO something is not merchandise.
 *
 * 2026-09-15: Ledger Voss bought 2 cargo_container at 213cr specifically for the
 * Haven crew-bunk dismantle, flew thirty-odd jumps to Haven, then ran sell_cargo
 * — which sold both at 119cr, at a loss, seven hours after he bought them. The
 * dismantle then failed for want of a container and he burned turns re-deriving
 * why. The nearest replacement stock is fifteen jumps from Haven.
 *
 * Neither existing guard covered it: cargo_container is category "component",
 * stackable, tradeable, 160cr base — it looks exactly like trade stock, and the
 * commission ledger had no line for it. This is the third instance of one bug
 * class, after ammunition (Morg'Thar, 2026-09-01) and commission stock
 * (CyberSpock, 2026-09-10).
 */
describe('sell_cargo never bulk-sells job tools', () => {
  test('a cargo container is a tool, not stock — the case that cost the Haven run', () => {
    expect(isOperationalConsumable('cargo_container')).toBe(true)
  })

  test('the ore the macro exists to sell is still sellable', () => {
    // The guard must not widen into "refuse to sell anything". sell_cargo's whole
    // job is dumping a hold full of mined ore.
    for (const ore of ['darksteel_ore', 'plasma_residue', 'copper_ore', 'iron_ore',
                       'silicon_ore', 'gold_ore', 'uranium_ore', 'fury_crystal']) {
      expect(isOperationalConsumable(ore)).toBe(false)
    }
  })

  test('other carried-to-act consumables are covered, not just the one that burned us', () => {
    for (const tool of ['survey_probe', 'repair_kit', 'emergency_beacon', 'salvage_kit', 'mining_charge']) {
      expect(isOperationalConsumable(tool)).toBe(true)
    }
  })

  test('it is matched on the id, so an unknown container variant is still protected', () => {
    // Same reasoning as isEquipmentItem: the catalog cache may not have seen the
    // item, so the guard cannot depend on a category lookup succeeding.
    expect(isOperationalConsumable('reinforced_cargo_container')).toBe(true)
    expect(isOperationalConsumable('container')).toBe(true)
  })

  test('the two guards are independent — a module is equipment, a container is not', () => {
    // isEquipmentItem never matched cargo_container, which is exactly why the
    // Haven run failed. Pin that so neither regex is "fixed" by folding it into
    // the other and silently changing what the equipment guard reports.
    expect(isEquipmentItem('cargo_container')).toBe(false)
    expect(isEquipmentItem('mining_laser_iii')).toBe(true)
    expect(isOperationalConsumable('mining_laser_iii')).toBe(false)
  })
})
