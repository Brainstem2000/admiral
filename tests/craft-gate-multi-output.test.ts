import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * A craft's `quantity` is OUTPUT ITEMS, not production runs — the game rounds
 * it up to whole runs (docs/crafting: "quantity means output items, not runs").
 * purify_argon turns 5 argon_gas into 3 purified_argon, so x680 is 227 runs and
 * 1,135 argon. The gate multiplied inputs by quantity instead, told CyberSpock
 * on 2026-09-10 that x680 needed 3,400 argon against the 1,241 he held, and sent
 * him two systems away to fetch argon he did not need. Every multi-output
 * recipe was over-counted the same way; single-output recipes were unaffected.
 *
 * Runs in a subprocess because db.ts binds DB_PATH from cwd at module load and
 * the seeded profile/storage rows must never land in data/admiral.db.
 */

const tempDirectories: string[] = []
afterEach(() => {
  for (const d of tempDirectories.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

let cached: Record<string, any> | null = null
async function runHelper(): Promise<Record<string, any>> {
  if (cached) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-craftgate-'))
  tempDirectories.push(dir)
  const helper = path.join(import.meta.dir, 'helpers', 'craft-gate-multi-output-check.ts')
  const child = Bun.spawn([process.execPath, helper, dir], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, err).toBe(0)
  const line = out.split('\n').find(l => l.startsWith('__RESULT__'))
  expect(line, `no __RESULT__ in:\n${out}\n${err}`).toBeDefined()
  cached = JSON.parse(line!.slice('__RESULT__'.length))
  return cached!
}

describe('craft input gate — multi-output recipes', () => {
  test('the catalog says purify_argon is 5 argon_gas -> 3 purified_argon per run', async () => {
    const r = await runHelper()
    expect(r.argon.in.item_id).toBe('argon_gas')
    expect(r.argon.in.quantity).toBe(5)
    expect(r.argon.out.quantity).toBe(3)
    expect(r.wiring.in.quantity).toBe(4)
    expect(r.wiring.out.quantity).toBe(2)
  })

  test('x680 purified_argon is 227 runs = 1,135 argon, so 1,241 in storage passes', async () => {
    const r = await runHelper()
    expect(r.argon680.out).not.toContain('BLOCKED')
    expect(r.argon680.reached).toBe(true)
  })

  test('x760 purified_argon is 254 runs = 1,270 argon; the refusal counts in runs', async () => {
    const r = await runHelper()
    expect(r.argon760.reached).toBe(false)
    expect(r.argon760.out).toContain('BLOCKED')
    expect(r.argon760.out).toContain('need 1270')
    expect(r.argon760.out).toContain('254 run(s) of 3')
    expect(r.argon760.out).not.toContain('need 3800')
  })

  test('process_copper_wiring (4 ore -> 2 wiring): 767 ore covers x382 but not x384', async () => {
    const r = await runHelper()
    expect(r.wiring382.out).not.toContain('BLOCKED')
    expect(r.wiring382.reached).toBe(true)
    expect(r.wiring384.reached).toBe(false)
    expect(r.wiring384.out).toContain('need 768')
  })

  test('a single-output recipe still scales by quantity exactly as before', async () => {
    const r = await runHelper()
    expect(r.iron5.reached).toBe(false)
    expect(r.iron5.out).toContain('need 50')
  })
})
