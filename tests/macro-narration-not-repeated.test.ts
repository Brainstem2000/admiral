import { describe, expect, test } from 'bun:test'
import { __testMakeMacroNarrator } from '../src/server/lib/tools'

/**
 * A macro's "intent" is the agent's original reason for starting it, and it does
 * not change while the macro runs. It used to be re-attached to every narration,
 * so an 18-jump goto_system logged the same 140 characters eighteen times —
 * byte-identical, only the hop tag differing — and the fleet produced 291
 * near-duplicate rows in three hours.
 *
 * Those rows cost no LLM tokens: the macro flies hops server-side and makes no
 * calls (measured 2026-09-17: Rook flew 18 hops with 0 llm_calls). The cost is
 * that they bury the log the watch and the dashboard read.
 */
describe('a macro says its intent once, then reports progress only', () => {
  test('the intent appears on the first line and never again', () => {
    const lines: string[] = []
    const narrate = __testMakeMacroNarrator(
      { log: (_k: string, m: string) => lines.push(m) },
      'goto_system', 'heading to node_beta for the packages',
    )
    for (let i = 1; i <= 5; i++) narrate(`hop ${i}/5 → sys${i}`, true)

    expect(lines.length).toBe(5)
    expect(lines[0]).toBe('[goto_system hop 1/5 → sys1] heading to node_beta for the packages')
    // Every later line keeps the progress and drops the repeated intent.
    expect(lines[1]).toBe('[goto_system hop 2/5 → sys2]')
    expect(lines[4]).toBe('[goto_system hop 5/5 → sys5]')
    expect(lines.filter(l => l.includes('heading to node_beta')).length).toBe(1)
  })

  test('progress is still distinguishable per hop — the useful part is kept', () => {
    const lines: string[] = []
    const narrate = __testMakeMacroNarrator(
      { log: (_k: string, m: string) => lines.push(m) }, 'goto_system', 'x',
    )
    narrate('hop 1/3 → a', true); narrate('hop 2/3 → b', true); narrate('hop 3/3 → c', true)
    expect(new Set(lines).size).toBe(3)
    expect(lines[2]).toContain('hop 3/3 → c')
  })

  test('with no intent given, nothing changes', () => {
    const lines: string[] = []
    const narrate = __testMakeMacroNarrator({ log: (_k: string, m: string) => lines.push(m) }, 'mine_until_full')
    narrate('20 mines', true); narrate('40 mines', true)
    expect(lines).toEqual(['[mine_until_full 20 mines]', '[mine_until_full 40 mines]'])
  })

  test('the throttle still suppresses unforced narration', () => {
    const lines: string[] = []
    const narrate = __testMakeMacroNarrator({ log: (_k: string, m: string) => lines.push(m) }, 'hunt_here', 'i', 60_000)
    narrate('first', true)     // forced
    narrate('second')          // inside the window, unforced -> dropped
    expect(lines.length).toBe(1)
  })
})
