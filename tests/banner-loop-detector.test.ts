/**
 * The runaway-narration detector has now been wrong in all three directions.
 *
 * v1 keyed on words (CRITICAL / RECONCIL / 🚨). Grit Vane reworded to
 * "**🎯 LIVE STATE CONFIRMED — CYCLE 171 STARTING**" and scored 0% while doing
 * it on 28 of 29 thoughts. A false NEGATIVE.
 *
 * v2 matched any thought opening with `**`, and counted Ledger Voss's compact
 * "**TODO** - Verified:" labels, flagging him at 25% across 65 turns with zero
 * alarm framing. A false POSITIVE, patched by excluding that one label.
 *
 * v3 still measured FORMATTING. On 2026-09-05 it held Morg'Thar at 46-67% while
 * he ran dock -> sell_cargo -> view_market -> get_missions -> jump — an ordinary
 * trade loop — because he writes headers like "**Analysis of Alzirr mission
 * board:**". Flagging an agent for writing in bold is the same mistake as
 * counting his TODO labels.
 *
 * What the alert actually means is "the SAME preamble every turn", which is what
 * costs output and buries real alarms. So it measures repetition. Validated
 * against the real data both ways: during Morg's confirmed ritual loop one
 * banner accounted for 18 of 33 thoughts (fires); during his normal trade loop
 * the most repeated banner appeared 3 times in 39 (quiet), where the old rule
 * cried wolf at 74%.
 */
import { test, expect, describe } from 'bun:test'

/** Mirrors the detector in scripts/fleet-health.ts. */
function detect(thoughts: string[]): { worst: number; pct: number; fires: boolean; text: string } {
  const total = thoughts.length
  const banners = thoughts.filter(s =>
    (s.startsWith('**') || /^\[[^\]]*\]\s*\*\*/.test(s))
    && !s.startsWith('**TODO**') && !/^\[[^\]]*\]\s*\*\*TODO\*\*/.test(s))
  const tally = new Map<string, number>()
  for (const b of banners) {
    const head = b.replace(/^\[[^\]]*\]\s*/, '').split('\n')[0].slice(0, 70)
      .replace(/\d+/g, '#').toLowerCase().trim()
    if (head) tally.set(head, (tally.get(head) ?? 0) + 1)
  }
  let text = '', worst = 0
  for (const [k, v] of tally) if (v > worst) { worst = v; text = k }
  const pct = total ? Math.round((100 * worst) / total) : 0
  return { worst, pct, fires: worst >= 8 && pct >= 25, text }
}

const ritual = (n: number, cycle = 0) => Array.from({ length: n }, (_, i) =>
  `**🎯 GROUND TRUTH FROM CURRENT STATE (authoritative, auto-injected):** cycle ${cycle + i} hull ${90 - i}/90`)
const varied = (n: number) => Array.from({ length: n }, (_, i) =>
  `**Analysis of ${['Alzirr', 'Krynn', 'Albireo', 'Bharani', 'Haven'][i % 5]} mission board:** option ${i}`)
const plain = (n: number) => Array.from({ length: n }, (_, i) => `Good — I am now docked. Selling ore batch ${i}.`)

describe('the same preamble every turn is the loop', () => {
  test("Morg's real ritual — one banner across most thoughts — fires", () => {
    expect(detect([...ritual(18), ...plain(15)]).fires).toBe(true)
  })

  test('a changing counter inside the banner does not disguise it', () => {
    // "CYCLE 171" vs "CYCLE 172" must group as one ritual.
    const d = detect(ritual(20, 171))
    expect(d.worst).toBe(20)
    expect(d.fires).toBe(true)
  })

  test('the alert names the offending preamble so it can be removed', () => {
    expect(detect(ritual(12)).text).toContain('ground truth from current state')
  })

  test('a macro prefix does not split one ritual into many', () => {
    const withPrefix = ritual(10).map((t, i) => `[mine_until_full ${i} mines, cargo ${i}/120] ${t}`)
    expect(detect(withPrefix).fires).toBe(true)
  })
})

describe('writing in bold is a style, not a malfunction', () => {
  test("Morg's varied analysis headers stay quiet", () => {
    // The v3 false positive: every thought opens with ** and none repeat.
    const d = detect(varied(30))
    expect(d.worst).toBeLessThan(8)
    expect(d.fires).toBe(false)
  })

  test('plain prose never fires', () => {
    expect(detect(plain(40)).fires).toBe(false)
  })

  test("Ledger's compact TODO labels are still excluded", () => {
    const labels = Array.from({ length: 30 }, (_, i) => `**TODO** - Verified: cargo ${i}/450`)
    expect(detect(labels).fires).toBe(false)
  })

  test('a handful of repeats in a long run is not a loop', () => {
    expect(detect([...ritual(3), ...plain(36)]).fires).toBe(false)
  })
})

describe('both thresholds must be met, so short runs cannot trip it', () => {
  test('a high percentage on very few thoughts does not fire', () => {
    // 5 of 6 is 83%, but five occurrences is not yet a ritual.
    expect(detect([...ritual(5), ...plain(1)]).fires).toBe(false)
  })

  test('many repeats diluted across a huge run does not fire', () => {
    expect(detect([...ritual(9), ...plain(200)]).fires).toBe(false)
  })
})
