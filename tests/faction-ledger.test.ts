import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Faction ledger — every treasury credit movement and lockbox item movement, plus
 * the game's own lockbox/treasury snapshots. Requested by the Admiral 2026-09-10
 * after a Juggernaut progress count missed six complete component lines that sat
 * in the War Citadel lockbox: nothing in the DB knew faction storage existed.
 * Payload shapes are the ones recorded live. Runs in a temp-workspace subprocess.
 */
const tempDirectories: string[] = []
afterEach(() => { for (const d of tempDirectories.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
let cached: Record<string, any> | null = null
async function run(): Promise<Record<string, any>> {
  if (cached) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-faction-'))
  tempDirectories.push(dir)
  const helper = path.join(import.meta.dir, 'helpers', 'faction-ledger-check.ts')
  const child = Bun.spawn([process.execPath, helper, dir], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, err).toBe(0)
  const line = out.split('\n').find(l => l.startsWith('__RESULT__'))
  expect(line, `no __RESULT__ in:\n${out}\n${err}`).toBeDefined()
  cached = JSON.parse(line!.slice('__RESULT__'.length))
  return cached!
}

describe('faction ledger', () => {
  test('view target=faction records the lockbox per station and the treasury balance', async () => {
    const r = await run()
    expect(r.storage).toEqual([['hull_plating', 195], ['shield_emitter', 172]])
    expect(r.shield).toBe(172)
    expect(r.treasury.latest.credits).toBe(2914065)
  })
  test('a storage->faction transfer books one lockbox_deposit and replays dedupe', async () => {
    const r = await run()
    expect(r.transferRows).toEqual([1, 0])
    expect(r.ledger.some((l: any[]) => l[0] === 'lockbox_deposit' && l[1] === 'reactor_fuel_assembly' && l[2] === 8 && l[4] === 'crimson_war_citadel')).toBe(true)
  })
  test('a faction withdrawal that only returns the ship payload is derived from the args', async () => {
    const r = await run()
    expect(r.withdrawRows).toBe(1)
    expect(r.ledger.some((l: any[]) => l[0] === 'lockbox_withdraw' && l[1] === 'weapon_core' && l[2] === -182)).toBe(true)
  })
  test('a gift to faction:* books a treasury_gift; a player gift and an error book nothing', async () => {
    const r = await run()
    expect(r.giftRows).toEqual([1, 0, 0])
    expect(r.ledger.some((l: any[]) => l[0] === 'treasury_gift' && l[3] === 50000 && l[5] === 'STLR')).toBe(true)
    expect(r.treasury.booked_since_latest).toBe(50000)
    expect(r.treasury.implied_now).toBe(2914065 + 50000)
  })
})
