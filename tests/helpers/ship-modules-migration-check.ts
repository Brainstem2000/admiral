/**
 * Subprocess helper: build a PRE-v9 ship_modules table, then let db.ts migrate it.
 *
 * The migration runs once at getDb() init, so it cannot be exercised in the test
 * process (whose database is already current). argv[2] is a throwaway data dir;
 * argv[3] selects the starting shape:
 *   legacy — the original name-keyed table, which is what production had
 *   drift  — the same table after a bare `ALTER TABLE ... ADD COLUMN slot_index`,
 *            i.e. a hotfix that added the column but left the old primary key and
 *            every row at the column default
 */
import { Database } from 'bun:sqlite'
import path from 'node:path'

const dir = process.argv[2]
const shape = process.argv[3] ?? 'legacy'

// Seed the legacy table at user_version 8. migrate() creates everything else on
// open; runVersionedMigrations then has exactly v9 left to apply.
{
  const seed = new Database(path.join(dir, 'admiral.db'), { create: true })
  seed.exec(`CREATE TABLE ship_modules (
    profile_id TEXT NOT NULL,
    ship_id TEXT NOT NULL,
    module_name TEXT NOT NULL,
    slot TEXT NOT NULL DEFAULT '',
    cpu INTEGER NOT NULL DEFAULT 0,
    power INTEGER NOT NULL DEFAULT 0,
    captured_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (profile_id, ship_id, module_name, slot)
  )`)
  const ins = seed.query(`INSERT INTO ship_modules
    (profile_id, ship_id, module_name, slot, cpu, power) VALUES (?, ?, ?, ?, ?, ?)`)
  ins.run('p1', 'ship-a', 'Shield Booster III', 'defense', 4, 9)
  ins.run('p1', 'ship-a', 'Cargo Expander III', 'utility', 3, 3)
  ins.run('p1', 'ship-a', 'Mining Laser II', 'utility', 3, 7)
  ins.run('p1', 'ship-a', 'Mining Laser III', 'utility', 5, 10)
  ins.run('p2', 'ship-b', 'Railgun II', 'weapon', 2, 4)
  if (shape === 'drift') {
    seed.exec('ALTER TABLE ship_modules ADD COLUMN slot_index INTEGER NOT NULL DEFAULT 0')
    seed.exec('UPDATE ship_modules SET slot_index = 7')   // every row on the same value
  }
  seed.exec('PRAGMA user_version = 8')
  seed.close()
}

;(globalThis as { __ADMIRAL_DATA_DIR?: string }).__ADMIRAL_DATA_DIR = dir
const { getDb, recordShipModules } = await import('../../src/server/lib/db')
const db = getDb()

const tableSql = String((db.query(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ship_modules'"
).get() as { sql?: string }).sql).replace(/\s+/g, ' ')

const preserved = db.query(
  'SELECT profile_id, module_name, slot, slot_index, cpu, power FROM ship_modules ORDER BY profile_id, slot, slot_index'
).all() as Array<Record<string, unknown>>

// A fresh capture on the migrated table must keep BOTH duplicate lasers.
recordShipModules('p1', 'ship-a', [
  { name: 'Shield Booster III', slot: 'defense', cpu_usage: 4, power_usage: 9 },
  { name: 'Cargo Expander III', slot: 'utility', cpu_usage: 3, power_usage: 3 },
  { name: 'Mining Laser II', slot: 'utility', cpu_usage: 3, power_usage: 7 },
  { name: 'Mining Laser II', slot: 'utility', cpu_usage: 3, power_usage: 7 },
  { name: 'Mining Laser III', slot: 'utility', cpu_usage: 5, power_usage: 10 },
])
const after = db.query(
  'SELECT COUNT(*) n, SUM(cpu) cpu, SUM(power) power FROM ship_modules WHERE profile_id = ?'
).get('p1') as Record<string, number>

console.log('__RESULT__' + JSON.stringify({
  userVersion: (db.query('PRAGMA user_version').get() as { user_version: number }).user_version,
  tableSql,
  preservedCount: preserved.length,
  preservedIndexes: preserved.map(r => `${r.slot}#${r.slot_index}`),
  afterCapture: after,
}))
