import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Migration v9 rebuilds ship_modules so a fitted slot, not a module NAME, is the
 * row key — and it must survive the shape production was actually in, plus the
 * shape a hotfix could leave behind.
 *
 * The drift case is the one worth a test. If someone patches the missing column
 * in with a bare `ALTER TABLE ... ADD COLUMN slot_index`, the old name-based
 * primary key stays and every row sits on the column default. A column-only
 * guard would then skip the rebuild forever, and copying those defaults into the
 * new key collides and throws mid-migration — which is a boot failure, not a bug
 * report. The migration renumbers unconditionally for exactly that reason.
 *
 * Runs in a subprocess: migrations execute once at getDb() init, and the test
 * process's own database is already current.
 */

const tempDirectories: string[] = []
afterEach(() => {
  for (const d of tempDirectories.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

async function migrateFrom(shape: 'legacy' | 'drift'): Promise<Record<string, any>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `admiral-shipmod-${shape}-`))
  tempDirectories.push(dir)
  const helper = path.join(import.meta.dir, 'helpers', 'ship-modules-migration-check.ts')
  const child = Bun.spawn([process.execPath, helper, dir, shape], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect(code, err).toBe(0)
  const line = out.split('\n').find(l => l.startsWith('__RESULT__'))
  expect(line, `no __RESULT__ in:\n${out}\n${err}`).toBeDefined()
  return JSON.parse(line!.slice('__RESULT__'.length))
}

describe('ship_modules migration v9', () => {
  test('a legacy name-keyed table is rebuilt on the slot key', async () => {
    const r = await migrateFrom('legacy')
    expect(r.userVersion).toBe(9)
    expect(r.tableSql).toContain('PRIMARY KEY (profile_id, ship_id, slot, slot_index)')
  })

  test('the rebuild preserves every historical row', async () => {
    const r = await migrateFrom('legacy')
    expect(r.preservedCount).toBe(5)
    // Numbered within each slot family, so no two rows share a key.
    expect(r.preservedIndexes.sort()).toEqual(['defense#0', 'utility#0', 'utility#1', 'utility#2', 'weapon#0'])
  })

  test('a bare-ALTER hotfix is still rebuilt, and its colliding indexes renumbered', async () => {
    // Every seeded row carries slot_index 7. Copying that through would violate
    // the new primary key and abort the migration.
    const r = await migrateFrom('drift')
    expect(r.userVersion).toBe(9)
    expect(r.tableSql).toContain('PRIMARY KEY (profile_id, ship_id, slot, slot_index)')
    expect(r.preservedCount).toBe(5)
    expect(r.preservedIndexes.sort()).toEqual(['defense#0', 'utility#0', 'utility#1', 'utility#2', 'weapon#0'])
  })

  for (const shape of ['legacy', 'drift'] as const) {
    test(`after migrating from ${shape}, a capture keeps both duplicate modules`, async () => {
      const r = await migrateFrom(shape)
      // The bug reported 4 rows / 15 CPU / 29 power for this exact loadout.
      expect(r.afterCapture.n).toBe(5)
      expect(r.afterCapture.cpu).toBe(18)
      expect(r.afterCapture.power).toBe(36)
    })
  }
})
