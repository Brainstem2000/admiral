/**
 * Record the Juggernaut's bill as CyberSpock's commission requirements so the
 * sell / gift / craft guards protect every line in CODE. On 2026-09-10 13:39 a
 * sell_cargo(exclude=[]) sold 50 uranium_ore for 7,500cr: the directive's
 * NEVER SELL list is prose, and the guards only know equipment and recorded
 * commission lines — and the Juggernaut had never been recorded.
 *
 *   bun scripts/record-juggernaut-requirements.ts
 */
import { getDb, setCommissionRequirements, getCommissionRequirement } from '../src/server/lib/db'
const db = getDb()
const row = db.query("SELECT id, name FROM profiles WHERE name LIKE 'CyberSpock%'").get() as { id: string; name: string }
// Hull components (codex build_materials) + the intermediates the build plan resolves them to.
const lines: Array<[string, number]> = [
  ['railgun_capacitor', 18], ['weapon_battery', 4], ['shield_emitter', 30], ['engine_core', 15], ['titanium_alloy', 120],
  ['durasteel_plate', 30], ['weapon_core', 180], ['weapon_housing', 70], ['targeting_computer', 50], ['hull_plating', 40],
  ['power_distribution_grid', 3], ['crimson_ordnance_bay', 3], ['fury_alloy', 80], ['neutronium_ingot', 8],
  ['uranium_ore', 762], ['thorium_ore', 480], ['polonium_ore', 8], ['purified_argon', 683], ['copper_wiring', 830], ['aluminum_sheet', 64],
  ['circuit_board', 575], ['steel_plate', 666], ['tungsten_rod', 386], ['wiring_harness', 15], ['liquid_nitrogen', 67],
  ['superconductor', 114], ['trade_crystal', 33], ['focused_crystal', 54], ['energy_crystal', 200], ['processing_core', 54],
  ['power_cell', 529], ['power_battery', 29], ['synthetic_diamond', 48], ['reactor_fuel_assembly', 16], ['thorium_fuel_rod', 40],
  ['power_core', 16], ['weapons_grade_plutonium', 8], ['fury_crystal', 36], ['cobalt_ore', 60], ['silicon_ore', 135], ['fluorine_gas', 116],
  ['platinum_ore', 64], ['vanadium_ore', 308], ['palladium_ore', 50], ['nickel_billet', 180], ['helium_3', 37],
  // default-fit lines from the yard quote of 2026-09-10 16:52 (the Admiral chose the fitted commission)
  ['railgun_ii', 6], ['crimson_berserker_plating', 1], ['afterburner_i', 1], ['tritium_ice', 160], ['liquid_tritium', 64], ['fusion_fuel_rod', 32],
  // intermediate outputs of the build plan's craft tree (2026-09-10 19:25): the craft lock exempts a
  // craft whose OUTPUT is a still-short line, so every step of the chain must be a line or the lock
  // blocks converting uranium_ore -> uranium_concentrate as "consuming a commission line".
  ['uranium_concentrate', 122], ['uranium_hexafluoride', 31], ['low_enriched_uranium', 16], ['reactor_grade_plutonium', 8], ['ammo_fabricator', 1],
]
setCommissionRequirements('juggernaut', lines.map(([item_id, quantity]) => ({ item_id, quantity })), row.id)
console.log(`recorded ${lines.length} Juggernaut lines for ${row.name}`)
console.log('check: uranium_ore requirement =', getCommissionRequirement('uranium_ore', row.id), '| weapon_core =', getCommissionRequirement('weapon_core', row.id))
