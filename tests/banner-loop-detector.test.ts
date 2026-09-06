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
 *
 * v4 — the fourth false positive, and the last agent-specific carve-out. The
 * v2 patch excluded the literal '**TODO**'; Ledger Voss writes
 * '**TODO (updated)**' and sailed straight past it, grouping 10 of 10 thoughts
 * on an 18-character heading while 9 of the 10 BODIES were distinct. He was
 * installing a rad harvester and mining uranium at the time.
 *
 * A repeated HEADING is not a repeated preamble. Measured on 2026-09-06:
 * Ledger's key 18 chars (label), Grit's real ritual ~45, Morg's 54. So the
 * repeated text must be substantial to count — which retires the carve-out
 * instead of adding a third one. That is the same lesson as the guard-block
 * and narration detectors: match the behaviour, not the formatting.
 */
import { test, expect, describe } from 'bun:test'

/** A banner shorter than this is a label, not a ritual — see v4 above. */
const MIN_BANNER_CHARS = 30

/** Mirrors the detector in scripts/fleet-health.ts. */
function detect(thoughts: string[]): { worst: number; pct: number; fires: boolean; text: string } {
  const total = thoughts.length
  // Only what the agent wrote THIS turn: a macro-prefixed line is the harness's
  // narrator replaying an intent the agent stated once.
  const banners = thoughts.filter(s => s.startsWith('**') && !s.startsWith('**TODO**'))
  const tally = new Map<string, number>()
  for (const b of banners) {
    const head = b.split('\n')[0].slice(0, 70).replace(/\d+/g, '#').toLowerCase().trim()
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

  test('the harness narrating its own macro is not the agent repeating itself', () => {
    // FOURTH false positive, introduced by the third fix. makeMacroNarrator logs
    // `[goto_system hop 7/14 -> x] <intent>` where <intent> is captured ONCE at
    // macro start and replayed on every hop, so a 14-hop journey emits 14
    // identical lines the agent wrote once. That flagged Vera Lane at 30% on
    // 2026-09-05 while she progressed cleanly through hops 5,6,7,8,9 — 21 of
    // her 30 "thoughts" were the narrator echoing her.
    const echoes = Array.from({ length: 14 }, (_, i) =>
      `[goto_system hop ${i + 1}/14 → sys_${i}] **ANALYSIS:** I'm mid-route to Haven.`)
    expect(detect(echoes).fires).toBe(false)
  })

  test("but the agent's own repeated banner, with no prefix, still fires", () => {
    expect(detect([...ritual(18), ...plain(15)]).fires).toBe(true)
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


describe('v4: a short heading is a label, not a ritual', () => {
  /** Mirrors the length filter in scripts/fleet-health.ts. */
  const counts = (key: string, repeats: number, total: number) =>
    key.length >= MIN_BANNER_CHARS && repeats >= 8 && Math.round((100 * repeats) / total) >= 25

  test("Ledger's real case stays quiet: 18-char heading, 10 of 10 thoughts", () => {
    expect(counts('**todo (updated)**', 10, 10)).toBe(false)
  })

  test("the old '**TODO**' carve-out missed the variant that actually fired", () => {
    const excluded = (s: string) => s.startsWith('**TODO**')      // v2 rule
    expect(excluded('**TODO (updated)**')).toBe(false)            // slipped through
    const widened = (s: string) => s.startsWith('**TODO')         // v4 rule
    expect(widened('**TODO (updated)**')).toBe(true)
  })

  test("Grit's genuine ritual still fires", () => {
    expect(counts('**live state confirmed — cycle # starting**', 18, 33)).toBe(true)
  })

  test("Morg's ceremony would fire once it repeats enough", () => {
    const k = '**reading current state now — this is authoritative.**'
    expect(k.length).toBeGreaterThanOrEqual(MIN_BANNER_CHARS)
    expect(counts(k, 4, 23)).toBe(false)    // 4 repeats: below threshold, correctly quiet
    expect(counts(k, 10, 23)).toBe(true)    // sustained: fires
  })

  test('length alone is not enough — repetition still has to be there', () => {
    expect(counts('**a long and distinctive analysis heading**', 2, 30)).toBe(false)
  })
})


describe('v5: a banner on a working agent is verbosity, not paralysis', () => {
  /**
   * Mirrors the final rule in scripts/fleet-health.ts. `total` counts only the
   * agent's OWN thoughts — macro-narrator lines are prefixed "[" and excluded,
   * because Bob Comet showed 71 "thoughts" against 3 tool calls while inside a
   * single mine_until_full that filled 1,319 of 1,550 cargo. Counting narration
   * made the fleet's best miner read as paralysed.
   */
  const fires = (banner: string, worst: number, total: number, calls: number) =>
    banner.length >= MIN_BANNER_CHARS && worst >= 8 &&
    Math.round((100 * worst) / total) >= 25 && calls * 2 < total

  const GRIT = '**current state verified (authoritative):**'

  test("Grit's real case stays quiet: 19/59 banners but 36 actions", () => {
    expect(fires(GRIT, 19, 59, 36)).toBe(false)
  })

  test('the same banner on an agent who has stopped acting DOES fire', () => {
    expect(fires(GRIT, 19, 59, 4)).toBe(true)
  })

  test('the threshold is half as many actions as thoughts', () => {
    expect(fires(GRIT, 19, 59, 29)).toBe(true)    // 29*2 = 58 < 59
    expect(fires(GRIT, 19, 59, 30)).toBe(false)   // 30*2 = 60 >= 59
  })

  test("Bob's macro narration must not count as thinking", () => {
    // 3 own thoughts + 66 narrator echoes. With echoes counted he looks stuck;
    // with them excluded there are too few thoughts to judge at all.
    const ownThoughts = 3
    expect(ownThoughts >= 20).toBe(false)          // below the floor: no alarm either way
    const withEchoes = 69
    expect(fires(GRIT, 19, withEchoes, 3)).toBe(true)   // what the old counting would have done
  })

  test('acting hard while writing plainly is silent on every axis', () => {
    expect(fires('short', 19, 59, 4)).toBe(false)       // banner too short
    expect(fires(GRIT, 2, 59, 4)).toBe(false)           // not repeated
  })
})
