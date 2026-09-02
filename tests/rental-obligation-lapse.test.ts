import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Rent obligations lapse on the GAME'S word, never on age.
 *
 * Morg'Thar's Lithium Cell Foundry row (last billed 2026-08-06) was still in
 * his briefing on 2026-09-02, after the game had answered `facilities: []`
 * twice. The register had no way to retire a row except a dismantle event —
 * and nobody dismantles a facility they no longer own. Age cannot be the
 * trigger either: wallet-zero agents accrue real arrears in silence, and a
 * silent rent row there is a debt, not a phantom.
 *
 * Runs in a subprocess because db.ts binds DB_PATH from cwd at module load
 * (see nav-intel-injection.test.ts).
 */

const tempDirectories: string[] = []
afterEach(() => {
  for (const d of tempDirectories.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

let cached: Record<string, any> | null = null
async function runHelper(): Promise<Record<string, any>> {
  if (cached) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-obligations-'))
  tempDirectories.push(dir)
  const helper = path.join(import.meta.dir, 'helpers', 'obligation-lapse-check.ts')
  const child = Bun.spawn([process.execPath, helper, dir], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, err).toBe(0)
  const line = out.split('\n').find(l => l.startsWith('__RESULT__'))
  expect(line, `no __RESULT__ in:\n${out}\n${err}`).toBeDefined()
  cached = JSON.parse(line!.slice('__RESULT__'.length))
  return cached!
}

describe('rental lapse: the helpers', () => {
  test('a month-old rent row is still active — age is not evidence', async () => {
    const r = await runHelper()
    expect(r.initial.all).toContain('rent:lithium_cell_foundry:active')
    expect(r.initial.active).toEqual(['rent:crew_bunk', 'rent:ledger_desk', 'rent:lithium_cell_foundry', 'tax:property_paid'])
  })

  test('markObligationLapsed retires one row, idempotently, and listActiveObligations hides it', async () => {
    const r = await runHelper()
    expect(r.lapsedOne).toBe(1)
    expect(r.lapsedAgain).toBe(0)
    expect(r.afterOne.all).toContain('rent:lithium_cell_foundry:lapsed')
    expect(r.afterOne.active).not.toContain('rent:lithium_cell_foundry')
    // The audit list still shows it.
    expect(r.afterOne.all).toHaveLength(4)
  })

  test('markAllRentLapsed retires every active rent row and nothing else', async () => {
    const r = await runHelper()
    expect(r.markAll).toBe(1)
    expect(r.final.all.filter((s: string) => s.startsWith('rent:')).every((s: string) => s.endsWith(':lapsed'))).toBe(true)
    expect(r.final.active).toEqual(['tax:property_paid'])
  })
})

describe('rental lapse: the capture path', () => {
  test('an enumerated station lapses the facilities it omits and keeps the ones it lists', async () => {
    const r = await runHelper()
    expect(r.afterPartial).toContain('rent:ledger_desk:lapsed')
    expect(r.afterPartial).toContain('rent:crew_bunk:active')
  })

  test('a fresh rent bill revives a lapsed row', async () => {
    const r = await runHelper()
    expect(r.afterRevive).toContain('rent:ledger_desk:active')
  })

  test('"you own nothing" — either spelling — lapses every rent row and leaves taxes alone', async () => {
    const r = await runHelper()
    expect(r.afterEmpty.all).toEqual([
      'rent:crew_bunk:lapsed', 'rent:ledger_desk:lapsed', 'rent:lithium_cell_foundry:lapsed', 'tax:property_paid:active',
    ])
    expect(r.afterEmpty.active).toEqual(['tax:property_paid'])
  })

  test('an unrecognised payload shape, or an unknown reporter, lapses nothing', async () => {
    const r = await runHelper()
    expect(r.afterUnknownShape).toContain('rent:crew_bunk:active')
    expect(r.afterUnknownReporter).toContain('rent:crew_bunk:active')
  })
})
