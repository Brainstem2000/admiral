/**
 * Brian's order 2026-08-28: remove all BoM locks. The Crimson Devastator
 * commission (7f4c3f0c) is placed and paid — materials consumed by the yard —
 * so the craft-guard reserve rows are purpose-complete. This clears them via
 * the app's own setter. The next commission repopulates via the same call.
 *
 *   bun scripts/clear-devastator-bom.ts
 */
import { getDb, setCommissionRequirements, getCommissionRequirement } from '../src/server/lib/db'

getDb() // initialize the module-level connection; setCommissionRequirements reads it directly
setCommissionRequirements('crimson_devastator', [])
console.log('commission_requirements cleared for crimson_devastator')
console.log('spot-check hull_plating requirement now:', getCommissionRequirement('hull_plating'))
