import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * CyberSpock, 2026-09-10: three times he called
 * deposit_items(items=[{uranium_ore, 360}]) while holding 180 uranium_ore.
 * 360 was the hold's CARGO-UNIT figure (uranium_ore is size 2), not the item
 * count. The game answered 200 with the failure buried under `details`
 * (`succeeded: 0`, `insufficient_cargo`) beneath a cargo listing that reads as
 * "here is your hold after the deposit". He read it as success and flew two
 * extra six-jump round trips with the ore still aboard. The 18:13 call with
 * the right count worked.
 *
 * Two fixes, either of which alone would have ended it:
 *  1. PRE-FLIGHT: when the connection's live state carries a cargo array, an
 *     over-ask is cut down to what is held (the call then does what the agent
 *     meant), and a call with nothing to move is refused without a round trip.
 *     Never from the DB cargo snapshot; with no live array the game answers.
 *  2. POST-RESULT: failed lines of the bulk envelope become the FIRST lines of
 *     the result, so the 200-char log summary and the model meet the failure
 *     before the listing.
 *
 * Runs in a subprocess because db.ts binds DB_PATH from cwd at module load and
 * the seeded profiles (and whatever the result path records) must never land
 * in data/admiral.db.
 */

const tempDirectories: string[] = []
afterEach(() => {
  for (const d of tempDirectories.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

let cached: Record<string, any> | null = null
async function runHelper(): Promise<Record<string, any>> {
  if (cached) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-depositclamp-'))
  tempDirectories.push(dir)
  const helper = path.join(import.meta.dir, 'helpers', 'deposit-quantity-guard-check.ts')
  const child = Bun.spawn([process.execPath, helper, dir], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, err).toBe(0)
  const line = out.split('\n').find(l => l.startsWith('__RESULT__'))
  expect(line, `no __RESULT__ in:\n${out}\n${err}`).toBeDefined()
  cached = JSON.parse(line!.slice('__RESULT__'.length))
  return cached!
}

describe('deposit pre-flight clamp against the live hold', () => {
  test('the catalog knows uranium_ore is size 2 — the figure the note explains', async () => {
    const r = await runHelper()
    expect(r.catalogSize).toBe(2)
  })

  test('the incident: 360 asked, 180 held — the game receives 180 and the agent is told why', async () => {
    const r = await runHelper()
    expect(r.clampBulk.sent).toHaveLength(1)
    expect(r.clampBulk.sent[0].items).toEqual([{ item_id: 'uranium_ore', quantity: 180 }])
    expect(r.clampBulk.out).toContain('ℹ️ Admiral clamp: you asked to deposit 360 uranium_ore but hold 180')
    expect(r.clampBulk.out).toContain('quantity is the ITEM COUNT, not cargo units')
    expect(r.clampBulk.out).toContain('uranium_ore is size 2')
    expect(r.clampBulk.out).toContain('360 is your cargo-unit figure')
    expect(r.clampBulk.out).toContain('Deposited 180.')
    expect(r.clampBulk.out).not.toContain('⚠️')
    expect(r.clampBulk.logs.some((l: string) => l.includes('asked 360, live hold 180'))).toBe(true)
  })

  test('the single-item form and the faction_ spelling are clamped the same way', async () => {
    const r = await runHelper()
    expect(r.clampSingle.sent).toHaveLength(1)
    expect(r.clampSingle.sent[0]).toEqual({ item_id: 'uranium_ore', quantity: 180 })
    expect(r.clampSingle.out).toContain('Admiral clamp')
    expect(r.clampFactionForm.sent[0].items).toEqual([{ item_id: 'uranium_ore', quantity: 180 }])
    expect(r.clampFactionForm.out).toContain('Admiral clamp')
  })

  test('an ask within the hold is passed through untouched, with no note', async () => {
    const r = await runHelper()
    expect(r.exactAsk.sent).toHaveLength(1)
    expect(r.exactAsk.sent[0].items).toEqual([{ item_id: 'uranium_ore', quantity: 180 }])
    expect(r.exactAsk.out).not.toContain('Admiral clamp')
    expect(r.exactAsk.logs).toHaveLength(0)
  })

  test('the live hold has none of the item: BLOCKED locally, no round trip', async () => {
    const r = await runHelper()
    expect(r.blockedMissing.sent).toHaveLength(0)
    expect(r.blockedMissing.out).toStartWith('BLOCKED: deposit of 100 uranium_ore — your hold has none (live cargo). Nothing to deposit.')
    expect(r.blockedMissing.out).toContain('iron_ore x50')
    expect(r.blockedSingle.sent).toHaveLength(0)
    expect(r.blockedSingle.out).toContain('BLOCKED: deposit of 100 uranium_ore')
  })

  test('the identical call straight after a refusal is handed to the game — the guard cannot trap an agent', async () => {
    const r = await runHelper()
    expect(r.blockedThenPassthrough.sent).toHaveLength(1)
    expect(r.blockedThenPassthrough.sent[0].items).toEqual([{ item_id: 'uranium_ore', quantity: 100 }])
    expect(r.blockedThenPassthrough.out).not.toContain('BLOCKED')
  })

  test('a bulk call with one absent line drops that line and sends the rest', async () => {
    const r = await runHelper()
    expect(r.partialBulk.sent).toHaveLength(1)
    expect(r.partialBulk.sent[0].items).toEqual([{ item_id: 'uranium_ore', quantity: 100 }])
    expect(r.partialBulk.out).toContain('dropped gold_ore x5 from this deposit — your hold has none (live cargo)')
    expect(r.partialBulk.out).not.toContain('you asked to deposit 100 uranium_ore')
  })

  test('deposits that do not draw on cargo are never clamped or blocked', async () => {
    const r = await runHelper()
    expect(r.sourceStorage.sent).toHaveLength(1)
    expect(r.sourceStorage.sent[0].quantity).toBe(100)
    expect(r.sourceStorage.out).not.toContain('BLOCKED')
    expect(r.creditGift.sent).toHaveLength(1)
    expect(r.creditGift.out).not.toContain('BLOCKED')
  })

  test('with no live cargo array the call goes out unchanged — the DB snapshot is never consulted', async () => {
    const r = await runHelper()
    expect(r.noLiveCargoSuccess.sent).toHaveLength(1)
    expect(r.noLiveCargoSuccess.sent[0].items).toEqual([{ item_id: 'uranium_ore', quantity: 180 }])
    expect(r.noLiveCargoSuccess.out).not.toContain('BLOCKED')
    expect(r.noLiveCargoSuccess.out).not.toContain('Admiral clamp')
    expect(r.noLiveCargoFailure.sent[0].items).toEqual([{ item_id: 'uranium_ore', quantity: 360 }])
  })
})

describe('bulk storage envelope — failures surface as the first line', () => {
  test('the incident envelope: DEPOSIT FAILED leads, with the game\'s reason and the unit hint', async () => {
    const r = await runHelper()
    const lines = r.noLiveCargoFailure.out.split('\n')
    expect(lines[0]).toBe(
      '⚠️ DEPOSIT FAILED — uranium_ore x360: insufficient_cargo — You only have 180 x uranium_ore in cargo. '
      + '(quantity is the ITEM COUNT, not cargo units — uranium_ore is size 2)',
    )
    expect(lines[1]).toBe('Nothing was moved.')
    expect(r.noLiveCargoFailure.out).toContain('insufficient_cargo')
    // The 200-char log summary sees the failure, not the cargo listing.
    expect(r.noLiveCargoFailure.out.slice(0, 200)).toContain('DEPOSIT FAILED')
  })

  test('a normal successful envelope is untouched', async () => {
    const r = await runHelper()
    expect(r.noLiveCargoSuccess.out).not.toContain('⚠️')
    expect(r.noLiveCargoSuccess.out).not.toContain('Nothing was moved')
    expect(r.noLiveCargoSuccess.out).not.toContain('ℹ️')
    expect(r.noLiveCargoSuccess.out).toStartWith('cargo:')
  })

  test('a withdraw envelope gets the WITHDRAW verb and a partial-move count', async () => {
    const r = await runHelper()
    const lines = r.withdrawFailure.out.split('\n')
    expect(lines[0]).toStartWith('⚠️ WITHDRAW FAILED — uranium_ore x50: insufficient_storage — You only have 20 x uranium_ore in storage.')
    expect(lines[1]).toBe('1 of 2 line(s) moved; the rest did not.')
    expect(r.withdrawFailure.out).not.toContain('Nothing was moved')
  })

  test('the single-item form fails as a real error and the hint names the unit', async () => {
    const r = await runHelper()
    expect(r.singleFormError.out).toStartWith('Error: [insufficient_cargo] You only have 180 x uranium_ore in cargo.')
    expect(r.singleFormError.out).toContain('quantity is the ITEM COUNT, not cargo units')
    expect(r.singleFormError.out).toContain('uranium_ore is size 2')
  })
})
