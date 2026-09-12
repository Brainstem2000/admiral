import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
/**
 * "Make the macro mine until full, one call per hold" (Brian, 2026-09-11 08:25).
 * The per-call action cap is gone by default: a call ends only when the hold is full,
 * the deposit is dry, an explicit max_mines is reached, the 3-hour guard trips, or the
 * hull falls under half (an attack). The old 80-action chunks put a DONE line in front
 * of a local model every ten minutes, and one of them was read as "hold full".
 */
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
let cached: Record<string, any> | null = null
async function run() {
  if (cached) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-mine1-')); dirs.push(dir)
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'helpers', 'mine-until-full-check.ts'), dir], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, err).toBe(0)
  const line = out.split('\n').find(l => l.startsWith('__RESULT__')); expect(line, `no __RESULT__ in:\n${out}\n${err}`).toBeDefined()
  cached = JSON.parse(line!.slice('__RESULT__'.length)); return cached!
}
describe('mine_until_full: one call per hold', () => {
  test('without a cap it mines until the hold is full and says DONE … full', async () => {
    const r = await run(); expect(r.fullMines).toBe(6); expect(r.fullCargo).toBe(12); expect(r.fullText).toContain('mine_until_full DONE'); expect(r.fullText).toContain('Stopped: full')
  }, 60_000)
  test('an explicit max_mines still caps the call and reads as PAUSED', async () => {
    const r = await run(); expect(r.capMines).toBe(2); expect(r.capText).toContain('PAUSED'); expect(r.capText).toContain('Call mine_until_full again')
  }, 60_000)
  test('a hull under half ends the call', async () => {
    const r = await run(); expect(r.hullMines).toBe(2); expect(r.hullText).toContain('hull 40/100'); expect(r.hullText).toContain('mine_until_full DONE')
  }, 60_000)
  test('keep=silicon_ore dumps the filler back into the belt and fills the hold with silicon', async () => {
    const r = await run()
    expect(r.keepJettisoned.every((j: any) => j.item_id === 'iron_ore')).toBe(true)
    expect(r.keepJettisoned.length).toBeGreaterThan(0)
    expect(r.keepCargo).toEqual([{ item_id: 'silicon_ore', quantity: 12 }])
    expect(r.keepText).toContain('mine_until_full DONE'); expect(r.keepText).toContain('full of silicon_ore'); expect(r.keepText).toContain('Jettisoned back into the deposit')
  }, 60_000)
  test('keep at a belt that holds no such deposit aborts before mining', async () => {
    const r = await run(); expect(r.keepAbortMines).toBe(0); expect(r.keepAbortText).toContain('MACRO ABORT'); expect(r.keepAbortText).toContain('no silicon_ore deposit')
  }, 60_000)
  test('a dump cycle that adds no kept ore ends the call instead of dumping forever', async () => {
    const r = await run(); expect(r.keepStallJettisoned).toBe(2); expect(r.keepStallText).toContain('not yielding it')
  }, 60_000)
})
