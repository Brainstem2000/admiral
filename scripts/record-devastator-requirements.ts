/**
 * Lock the Crimson Devastator's bill of materials so no agent can sell it out from under us.
 *
 * The guard mechanism in tools.ts is sound — commissionLock() gates all three
 * market exits (`sell`, `sell_cargo`, `send_gift`) — but it only reserves what
 * `commission_requirements` actually lists, and the Devastator's rows were
 * emptied on 2026-08-28 when that campaign was dropped (scripts/clear-devastator-bom.ts).
 * The programme restarted on 2026-09-15 and nobody put them back, which left
 * station_reactor_core x2 — irreplaceable, zero sellers in the galaxy — and 113
 * freshly tempered fury_alloy worth ~2.26M at market sitting completely unguarded.
 *
 * Quantities are the BARE-HULL bill from a live commission_quote at Crimson War
 * Citadel: the default loadout is deliberately excluded because the ship is being
 * fitted with energy weapons, so its stock railguns are not worth reserving.
 *
 * profile_id is NULL on purpose. A profile-scoped row reserves stock for that
 * agent alone, and this bill is being filled out of faction storage plus the
 * private holdings of at least five different agents — Nova's fury_crystal,
 * Bob's copper, CyberSpock's and CyberSapper's contributions. Fleet-wide is the
 * only scope that actually protects it.
 *
 * The lock is self-retiring: getCommissionRequirement() suppresses any row whose
 * owner already holds the hull, so delivering the Devastator releases the stock
 * without anyone remembering to run a cleanup.
 */
import { getDb, setCommissionRequirements, getCommissionRequirement } from '../src/server/lib/db'

getDb() // initialise the module-level connection; setCommissionRequirements uses it directly

const BARE_HULL: Array<[string, number]> = [
  ['durasteel_plate', 80],
  ['capital_ship_frame', 12],
  ['weapon_core', 220],
  ['targeting_computer', 70],
  ['reinforced_bulkhead', 3],
  ['station_reactor_core', 2],
  ['hull_plating', 140],
  ['armor_plate', 60],
  ['weapon_battery', 2],
  ['crimson_ordnance_bay', 2],
  ['railgun_capacitor', 12],
  ['fury_alloy', 120],
  ['neutronium_ingot', 18],
  ['weapon_housing', 80],
  ['shield_emitter', 95],
  ['power_distribution_grid', 2],
  ['crimson_siege_plating', 4],
]

// The Warmaul was destroyed at Voss Redoubt on 2026-09-14. Its 14 rows still
// stood, and because the self-retiring check keys off OWNING the hull, a hull
// that no longer exists never retires its own bill — so those rows were still
// reserving Morg's stock for a ship at the bottom of Alhena.
setCommissionRequirements('warmaul', [])
console.log('cleared: warmaul (hull destroyed 2026-09-14, rows were still locking stock)')

setCommissionRequirements('crimson_devastator', BARE_HULL.map(([item_id, quantity]) => ({ item_id, quantity })), null)
console.log(`locked:  crimson_devastator — ${BARE_HULL.length} lines, fleet-wide (profile_id NULL)`)

console.log('\nverification — getCommissionRequirement() now returns:')
let bad = 0
for (const [item, qty] of BARE_HULL) {
  const got = getCommissionRequirement(item)
  const ok = got === qty
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${item.padEnd(26)} ${String(got).padStart(4)} (expected ${qty})`)
}
console.log(bad === 0 ? '\nall lines reserved.' : `\n${bad} LINE(S) DID NOT TAKE`)
