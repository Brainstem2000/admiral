/**
 * db-doctor — read-only integrity audit for data/admiral.db.
 *
 * The enforcement mechanism chosen INSTEAD of retrofitting foreign keys and STRICT
 * onto live tables (docs/db-improvement-plan.md, "Deliberately not doing"): schema
 * constraints could reject weird-but-real game payloads mid-capture, an audit cannot.
 *
 * Checks are DISCOVERED from the schema where possible, so new tables are covered
 * automatically:
 *   1. Reference orphans — any column named `profile_id` / `*_profile_id` must
 *      resolve to profiles(id); any `system_id` to fleet_intel_systems(system_id);
 *      system_links a/b likewise.
 *   2. Sentinel timestamps — Go zero-time ('0001-…') or '' in *_at / timestamp /
 *      *_seen / day columns.
 *   3. JSON validity — the fields deliberately encoded as JSON must json_valid().
 *   4. Capture coverage — informational gauges for the tables that fill passively.
 *
 * Usage:  bun scripts/db-doctor.ts [--strict]
 *   --strict  exit 1 if any orphan / sentinel / invalid-JSON finding exists
 */
import { Database } from 'bun:sqlite'
import path from 'node:path'

const db = new Database(path.join(process.cwd(), 'data', 'admiral.db'), { readonly: true })
const strict = process.argv.includes('--strict')
let findings = 0

const tables = (db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
  .all() as { name: string }[]).map(t => t.name)
const columns = new Map<string, string[]>(
  tables.map(t => [t, (db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name)]),
)
const count = (sql: string): number => (db.query(sql).get() as { c: number }).c

console.log(`db-doctor — ${new Date().toISOString().slice(0, 19)}Z — ${tables.length} tables\n`)

// 1 ─ reference orphans ------------------------------------------------------
console.log('── reference orphans')
let orphanTotal = 0
for (const t of tables) {
  if (t === 'profiles') continue
  for (const col of columns.get(t)!) {
    const target =
      (col === 'profile_id' || col.endsWith('_profile_id')) ? ['profiles', 'id']
      : col === 'system_id' && t !== 'fleet_intel_systems' ? ['fleet_intel_systems', 'system_id']
      : null
    if (!target) continue
    const n = count(`SELECT COUNT(*) c FROM ${t} WHERE ${col} IS NOT NULL AND ${col} != ''
      AND NOT EXISTS (SELECT 1 FROM ${target[0]} p WHERE p.${target[1]} = ${t}.${col})`)
    if (n > 0) { console.log(`  ${t}.${col}: ${n} orphaned row(s) → ${target[0]}.${target[1]}`); orphanTotal += n }
  }
}
for (const side of ['a', 'b']) {
  const n = count(`SELECT COUNT(*) c FROM system_links WHERE NOT EXISTS
    (SELECT 1 FROM fleet_intel_systems f WHERE f.system_id = system_links.${side})`)
  if (n > 0) { console.log(`  system_links.${side}: ${n} link end(s) missing from fleet_intel_systems`); orphanTotal += n }
}
console.log(orphanTotal === 0 ? '  none\n' : `  TOTAL: ${orphanTotal}\n`)
findings += orphanTotal

// 2 ─ sentinel / empty timestamps -------------------------------------------
console.log('── sentinel timestamps (Go zero-time or empty string)')
let sentinelTotal = 0
for (const t of tables) {
  for (const col of columns.get(t)!) {
    if (!/(_at$|^timestamp$|_seen$|^day$)/.test(col)) continue
    const n = count(`SELECT COUNT(*) c FROM ${t} WHERE ${col} LIKE '0001-%' OR ${col} = ''`)
    if (n > 0) { console.log(`  ${t}.${col}: ${n} row(s)`); sentinelTotal += n }
  }
}
console.log(sentinelTotal === 0 ? '  none\n' : `  TOTAL: ${sentinelTotal}\n`)
findings += sentinelTotal

// 3 ─ JSON validity ----------------------------------------------------------
console.log('── JSON validity (fields intentionally encoded as JSON)')
const JSON_FIELDS: Array<[string, string]> = [
  ['action_events', 'data'], ['fleet_orders', 'params'], ['fleet_orders', 'next_orders'], ['galaxy_map', 'data'],
]
let jsonTotal = 0
for (const [t, col] of JSON_FIELDS) {
  if (!columns.get(t)?.includes(col)) continue
  const n = count(`SELECT COUNT(*) c FROM ${t} WHERE ${col} IS NOT NULL AND ${col} != '' AND json_valid(${col}) = 0`)
  if (n > 0) { console.log(`  ${t}.${col}: ${n} invalid row(s)`); jsonTotal += n }
}
console.log(jsonTotal === 0 ? '  none\n' : `  TOTAL: ${jsonTotal}\n`)
findings += jsonTotal

// 4 ─ capture coverage (informational — never counts toward --strict) --------
console.log('── capture coverage (informational)')
const ledgerAll = count('SELECT COUNT(*) c FROM financial_ledger')
const ledgerBal = count('SELECT COUNT(*) c FROM financial_ledger WHERE balance_after IS NOT NULL')
console.log(`  financial_ledger.balance_after: ${ledgerBal}/${ledgerAll} (${ledgerAll ? Math.round(100 * ledgerBal / ledgerAll) : 0}%)`)
const empireNewest = (db.query('SELECT MAX(fetched_at) m FROM empire_policy_snapshots').get() as { m: string | null }).m
console.log(`  empire_policy_snapshots: ${count('SELECT COUNT(*) c FROM empire_policy_snapshots')} empires, newest ${empireNewest ?? 'NEVER'}`)
const facAll = count('SELECT COUNT(*) c FROM fleet_intel_facilities')
console.log(`  fleet_intel_facilities: ${facAll} rows | maintenance ${count("SELECT COUNT(*) c FROM fleet_intel_facilities WHERE maintenance IS NOT NULL AND maintenance != ''")} | build_cost ${count('SELECT COUNT(*) c FROM fleet_intel_facilities WHERE build_cost IS NOT NULL')} | owned ${count('SELECT COUNT(*) c FROM fleet_intel_facilities WHERE owned = 1')}`)
console.log(`  fleet_intel_killzones with system: ${count('SELECT COUNT(*) c FROM fleet_intel_killzones WHERE system_id IS NOT NULL')}/${count('SELECT COUNT(*) c FROM fleet_intel_killzones')}`)
console.log(`  fleet_intel_systems with police_level: ${count('SELECT COUNT(*) c FROM fleet_intel_systems WHERE police_level IS NOT NULL')}/${count('SELECT COUNT(*) c FROM fleet_intel_systems')}`)
console.log(`  log_entries with turn_id: ${count('SELECT COUNT(*) c FROM log_entries WHERE turn_id IS NOT NULL')}/${count('SELECT COUNT(*) c FROM log_entries')}`)

console.log(`\n${findings === 0 ? 'CLEAN' : `${findings} finding(s)`} — schema_migrations at v${(db.query('PRAGMA user_version').get() as { user_version: number }).user_version}`)
if (strict && findings > 0) process.exit(1)
