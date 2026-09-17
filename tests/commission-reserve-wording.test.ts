/**
 * A reserve must say what it stops and what it does not.
 *
 * The line read "reserved by YOUR open commission (do not sell)". On 2026-09-16 two agents
 * generalised that to "cannot touch" and HALTED crafting jobs because a commission reserved
 * the steel_plate they were about to consume — which is exactly what the reserve protects it
 * FOR. commissionLock() gates sell / send_gift / sell_cargo only; it never gates craft or
 * facility builds. The wording now says both halves.
 */
import { test, expect } from 'bun:test'

const SRC = await Bun.file('src/server/lib/galaxy-market.ts').text()

test('the reserve line forbids selling AND permits spending, in the same breath', () => {
  const line = SRC.split('\n').find(l => l.includes('reserved by YOUR open commission'))
  expect(line).toBeDefined()
  expect(line!).toContain('DO NOT SELL')
  // The permission half is the part that was missing and cost two halted jobs.
  expect(line!.toLowerCase()).toContain('spend')
  expect(line!.toLowerCase()).toMatch(/craft/)
})

test('commissionLock is wired to the market exits only, never to craft', () => {
  const tools = Bun.file('src/server/lib/tools.ts')
  return tools.text().then(t => {
    const callSites = t.split('\n')
      .map((l, i) => ({ l, i }))
      .filter(x => /commissionLock\(/.test(x.l) && !/^function |^\s*\*/.test(x.l))
    expect(callSites.length).toBeGreaterThan(0)
    // Every guarded call site must sit in a sell/gift path — if one ever appears in a craft
    // path, the reserve really would block consumption and the wording above becomes a lie.
    for (const { i } of callSites) {
      const context = t.split('\n').slice(Math.max(0, i - 40), i + 5).join('\n').toLowerCase()
      const isMarketExit = /sell|gift|macrosellcargo/.test(context)
      expect(isMarketExit).toBe(true)
    }
  })
})
