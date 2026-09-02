import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * TOP OFF ALWAYS (Brian, 2026-09-02).
 *
 * The goto_system macro has refuelled after its own docks since 08-29; a manual
 * dock() did not, and "refuel every time you dock" as prose failed again today —
 * Morg'Thar left a dry station on ~200/350 fuel for a 26-jump corridor with no
 * station in it. So a successful manual dock now refuels from the station pump
 * inside the same tool call, books the fuel in the ledger, and says so in the
 * dock result. A dry station is reported, a full tank is left alone, and the
 * `auto_top_off` preference switches it off.
 *
 * Runs in a subprocess because db.ts binds DB_PATH from cwd at module load.
 */

const tempDirectories: string[] = []
afterEach(() => {
  for (const d of tempDirectories.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

let cached: Record<string, any> | null = null
async function runHelper(): Promise<Record<string, any>> {
  if (cached) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-topoff-'))
  tempDirectories.push(dir)
  const helper = path.join(import.meta.dir, 'helpers', 'auto-top-off-check.ts')
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

describe('auto top-off after a manual dock', () => {
  test('a successful dock is followed by refuel, booked and reported', async () => {
    const { basic } = await runHelper()
    expect(basic.calls).toEqual(['dock', 'refuel'])
    expect(basic.note).toContain('AUTO TOP-OFF')
    expect(basic.note).toContain('+143 fuel for 286cr')
    expect(basic.ledger.some((r: any) => r.kind === 'fuel' && Number(r.amount_signed) === -286)).toBe(true)
    expect(basic.logs.some((l: string) => l.includes('Auto top-off after dock'))).toBe(true)
  }, 30_000)

  test('a full tank is left alone', async () => {
    const { full } = await runHelper()
    expect(full.calls).toEqual(['dock'])
    expect(full.note).toContain('Tank already full')
  }, 30_000)

  test('a dry station is reported instead of silently skipped', async () => {
    const { empty } = await runHelper()
    expect(empty.calls).toEqual(['dock', 'refuel'])
    expect(empty.note).toContain('EMPTY')
  }, 30_000)

  test('the auto_top_off preference switches it off', async () => {
    const { off } = await runHelper()
    expect(off.calls).toEqual(['dock'])
    expect(off.note).not.toContain('AUTO TOP-OFF')
  }, 30_000)
})
