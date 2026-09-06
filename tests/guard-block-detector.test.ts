import { test, expect, describe } from 'bun:test'

/**
 * The guard-block alarm fired five times in one evening on Morg'Thar while
 * nothing was blocked.
 *
 * It counted `summary LIKE '%BLOCKED%' OR summary LIKE '%REFUSED%'` across
 * every log row, so it matched the agent THINKING about a guard. Morg's
 * directive says "the harness refuses a fourth abandon inside an hour"; he
 * quotes it back in `llm_thought` nearly every turn, and each quote scored as a
 * refusal. Measured on the live table over one 25-minute window: the old rule
 * counted 10, the real number was 0.
 *
 * This is the same mistake the runaway-narration detector made twice — matching
 * the narration instead of the event. A watcher that cries wolf gets switched
 * off, and CLAUDE.md records what that cost the last time: an agent sat blocked
 * for eight minutes with nobody watching. So bias hard toward silence.
 *
 * A real refusal is a `tool_result` that STARTS with the marker, because
 * `checkDoctrineGuards` returns the string and the caller logs it verbatim.
 */

interface Row { type: string; summary: string }

/** Mirrors the detector in scripts/fleet-health.ts. */
function isGuardBlock(r: Row): boolean {
  return r.type === 'tool_result'
    && (r.summary.startsWith('BLOCKED by Admiral doctrine') || r.summary.startsWith('REFUSED'))
}
const countBlocks = (rows: Row[]) => rows.filter(isGuardBlock).length

describe('a real refusal counts', () => {
  test('the doctrine refusal as the tool layer logs it', () => {
    expect(isGuardBlock({ type: 'tool_result', summary:
      'BLOCKED by Admiral doctrine: jettison is disabled fleet-wide (attempted: iron_orex3).' })).toBe(true)
  })
  test('the wind-down refusal', () => {
    expect(isGuardBlock({ type: 'tool_result', summary:
      'REFUSED: you are winding down. This is not a bug.' })).toBe(true)
  })
})

describe('narration about a guard does NOT count', () => {
  const narration: Row[] = [
    { type: 'llm_thought', summary: 'Perfect. I must not abandon — the harness REFUSED a fourth abandon inside an hour.' },
    { type: 'llm_thought', summary: 'Noting that jettison is BLOCKED by Admiral doctrine, so I will deposit instead.' },
    { type: 'llm_thought', summary: '**KEY FACTS** — Wexler rescues are REFUSED. Skipping.' },
    { type: 'system',      summary: 'Directive updated, restarting turn: ... the harness REFUSES a fourth abandon ...' },
    { type: 'tool_call',   summary: 'game(abandon_mission, id=02a8812c)' },
  ]

  test('the exact rows that cried wolf score zero', () => {
    expect(countBlocks(narration)).toBe(0)
  })

  test('the old rule scored these as refusals; the new one does not', () => {
    // The old SQL was LIKE '%BLOCKED%' OR LIKE '%REFUSED%' over every row.
    const old = narration.filter(r => /BLOCKED|REFUSED/.test(r.summary)).length
    expect(old).toBe(3)          // what the alarm used to count
    expect(countBlocks(narration)).toBe(0)  // what is actually happening
  })

  test('a tool_result that merely mentions the word is not a refusal', () => {
    // Board listings and mission text can contain either word.
    expect(isGuardBlock({ type: 'tool_result', summary:
      'KEY FIELDS: 12 mission(s) - Blockade Runner [delivery] ... - REFUSED CARGO recovery [salvage]' })).toBe(false)
  })
})

describe('the threshold still catches a genuine loop', () => {
  test('four real refusals in the window fire the alarm', () => {
    const rows: Row[] = Array.from({ length: 4 }, () => ({
      type: 'tool_result', summary: 'BLOCKED by Admiral doctrine: you already commissioned a shard 3 minute(s) ago',
    }))
    expect(countBlocks(rows) >= 4).toBe(true)
  })
  test('three does not', () => {
    const rows: Row[] = Array.from({ length: 3 }, () => ({
      type: 'tool_result', summary: 'BLOCKED by Admiral doctrine: jettison is disabled fleet-wide',
    }))
    expect(countBlocks(rows) >= 4).toBe(false)
  })
})

describe('hammering one guard vs tripping several', () => {
  /**
   * The alarm fired on five agents in one night and was actionable once.
   * A guard block is normal operation: the gates fire across the fleet all day
   * and the agent adapts. CyberSapper tripped a jettison gate and an abandon
   * gate in the same window while completing 88 missions — two different guards
   * catching two different mistakes, which is the system working. Morg'Thar hit
   * the SAME destination refusal four times in 23 seconds, which is not.
   *
   * So the signal is the most-repeated refusal, not the count of refusals.
   * Replayed over the night's real data, this stops firing on Zibal Prospector
   * (9 distinct refusals, max 3 of any one, +33,820 earned) and Rook Vance
   * (7 distinct, max 2) while still catching Cass Margin (16 repeats of one).
   */
  const worstRepeat = (rows: Row[]) => {
    const tally = new Map<string, number>()
    for (const r of rows.filter(isGuardBlock)) {
      const sig = r.summary.slice(0, 60)
      tally.set(sig, (tally.get(sig) ?? 0) + 1)
    }
    return Math.max(0, ...tally.values())
  }
  const tr = (s: string): Row => ({ type: 'tool_result', summary: s })

  test("Morg's real case fires: the same destination refusal four times", () => {
    const same = 'BLOCKED by Admiral doctrine: you set course for "the_telescope" 4s ago and are already re-routing'
    expect(worstRepeat([tr(same), tr(same), tr(same), tr(same)])).toBeGreaterThanOrEqual(4)
  })

  test('four DIFFERENT guards in one window does not fire', () => {
    expect(worstRepeat([
      tr('BLOCKED by Admiral doctrine: jettison is disabled fleet-wide (attempted: void_dustx3)'),
      tr('BLOCKED by Admiral doctrine: you have abandoned 3 missions in the last hour'),
      tr('BLOCKED by Admiral doctrine: you set course for "krynn" 30s ago'),
      tr('REFUSED: you are winding down. This is not a bug.'),
    ])).toBeLessThan(4)
  })

  test('the volatile tail of a refusal must not split the signature', () => {
    // The elapsed-seconds figure changes on every retry; a 60-char prefix cuts
    // before it, so the same guard groups as one.
    const a = 'BLOCKED by Admiral doctrine: you set course for "the_telescope" 4s ago'
    const b = 'BLOCKED by Admiral doctrine: you set course for "the_telescope" 23s ago'
    expect(a.slice(0, 60)).toBe(b.slice(0, 60))
  })

  test('narration still never counts, however often it repeats', () => {
    const n: Row = { type: 'llm_thought', summary: 'I was BLOCKED by Admiral doctrine again' }
    expect(worstRepeat([n, n, n, n, n, n])).toBe(0)
  })
})
