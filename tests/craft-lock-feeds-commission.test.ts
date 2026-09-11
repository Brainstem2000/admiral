import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
/**
 * The commission lines are recorded at several depths of the build tree (the yard's
 * bill AND the raws/intermediates it resolves to), so on 2026-09-10 18:40 the craft
 * lock refused synthesize_argon_power_cell x137 at Blood Forge: "would consume 207
 * purified_argon, but your commission requires 683 and you hold 684" — the 683 argon
 * IS for those power cells. The lock now stands down when the recipe's output is a
 * recorded line the agent is still short of (material moving UP the tree toward the
 * yard), and still holds when the output is not a line or the line is already met.
 */
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
let cached: Record<string, any> | null = null
async function run() {
  if (cached) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-craftfeeds-')); dirs.push(dir)
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'helpers', 'craft-lock-feeds-commission-check.ts'), dir], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, err).toBe(0)
  const line = out.split('\n').find(l => l.startsWith('__RESULT__')); expect(line, `no __RESULT__ in:\n${out}\n${err}`).toBeDefined()
  cached = JSON.parse(line!.slice('__RESULT__'.length)); return cached!
}
describe('craft lock: converting a line into a still-short parent line', () => {
  test('power cells from purified argon pass when power_cell is a short line', async () => {
    const r = await run(); expect(r.powerCells).not.toContain('BLOCKED'); expect(r.powerCellsReached).toBe(true)
  }, 60_000)
  test('consuming a line into a non-line output is still refused', async () => {
    const r = await run(); expect(r.concentrateNoLine).toContain('BLOCKED'); expect(r.concentrateNoLineReached).toBe(false)
  }, 60_000)
  test('once the output is recorded as a line, the same craft passes', async () => {
    const r = await run(); expect(r.concentrateWithLine).not.toContain('BLOCKED'); expect(r.concentrateWithLineReached).toBe(true)
  }, 60_000)
  test('withdraw with the default source/target spelled out is sent bare; a faction move keeps its arguments', async () => {
    const r = await run()
    expect(r.withdrawArgs).toEqual({ item_id: 'uranium_ore', quantity: 355 })
    expect(r.withdrawFactionArgs).toEqual({ item_id: 'uranium_ore', quantity: 10, source: 'faction', target: 'self' })
  }, 60_000)
  test('target=self and a station-id source are the same default and are dropped too', async () => {
    const r = await run()
    expect(r.withdrawSelfArgs).toEqual({ item_id: 'purified_argon', quantity: 15 })
    expect(r.withdrawStationArgs).toEqual({ item_id: 'purified_argon', quantity: 15 })
  }, 60_000)
  test('an output line that is already met gives no exemption', async () => {
    const r = await run(); expect(r.concentrateSatisfied).toContain('BLOCKED'); expect(r.concentrateSatisfiedReached).toBe(false)
  }, 60_000)
})
