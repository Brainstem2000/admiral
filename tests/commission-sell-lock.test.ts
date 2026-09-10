import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
/**
 * A recorded commission line must not leave the fleet through the market or a
 * gift to an outsider. The sell, sell_cargo and send_gift guards keyed only on
 * SELL_CARGO_ALWAYS_EXCLUDE — an empty set since the Devastator was dropped — so
 * on 2026-09-10 13:39 sell_cargo(exclude=[]) sold 50 uranium_ore the Juggernaut
 * needs. Now the exits consult getCommissionRequirement() like the craft lock:
 * a sale or outside gift is refused when it would drop the agent's total below
 * the requirement; genuine surplus and fleet-internal gifts pass.
 */
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
let cached: Record<string, any> | null = null
async function run() {
  if (cached) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-selllock-')); dirs.push(dir)
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'helpers', 'commission-sell-lock-check.ts'), dir], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, err).toBe(0)
  const line = out.split('\n').find(l => l.startsWith('__RESULT__')); expect(line, `no __RESULT__ in:\n${out}\n${err}`).toBeDefined()
  cached = JSON.parse(line!.slice('__RESULT__'.length)); return cached!
}
describe('commission sell lock', () => {
  test('selling a commission line below the requirement is refused before the wire', async () => {
    const r = await run(); expect(r.sellUranium).toContain('BLOCKED'); expect(r.sellUranium).toContain('needs 762'); expect(r.sellUraniumReached).toBe(false)
  })
  test('an item with no requirement still sells', async () => { const r = await run(); expect(r.sellIron).not.toContain('BLOCKED'); expect(r.sellIronReached).toBe(true) })
  test('a standing sell order on the line is refused too', async () => { const r = await run(); expect(r.orderUranium).toContain('BLOCKED') })
  test('gifting the line outside the fleet is refused; to a fleet callsign it passes', async () => {
    const r = await run(); expect(r.giftOutside).toContain('BLOCKED'); expect(r.giftFleet).not.toContain('BLOCKED'); expect(r.giftFleetReached).toBe(true)
  })
  test('sell_cargo(exclude=[]) skips the line and says why, and still sells the rest', async () => {
    const r = await run(); expect(r.macroSold).not.toContain('uranium_ore'); expect(r.macroSold).toContain('iron_ore'); expect(r.macro).toContain('commission line')
  })
})
