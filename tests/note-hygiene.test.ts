/**
 * An agent that writes live state into its notes is writing tomorrow's contradiction.
 *
 * The prompt injects location, ship, hull, shield, fuel, cargo and wallet fresh
 * every 60 seconds and tells the agent that reading is authoritative. Copying
 * those figures into a TODO guarantees the note is wrong on the next turn — the
 * agent moved, spent, or took damage.
 *
 * Morg'Thar spent 2026-09-05 on precisely that. His turns opened "CRITICAL
 * TRIPLE MISMATCH — MY TODO SAYS Location: Blood Forge... CURRENT STATE
 * OVERRIDES EVERYTHING", he re-derived the discrepancy, rewrote the note with
 * the new location, and the next turn found the same contradiction. He changed
 * hull four times in a day and finished nothing. Four remedies failed — nudges,
 * a memory rewrite, a directive order, a clean boot — because each was a
 * request, and the next note he wrote undid it. Ten of twelve agents were doing
 * some of this.
 *
 * A snapshot is dropped. A rule ABOUT state is kept, because "sell when cargo is
 * over 400" is a plan while "Cargo: 118/120" is a stale fact in waiting.
 */
import { test, expect, describe } from 'bun:test'
import { scrubLiveState, scrubNotice } from '../src/server/lib/note-hygiene'

describe("Morg'Thar's actual note lines are dropped", () => {
  test('the location line that drove the loop', () => {
    const r = scrubLiveState('- **Location:** Krynn > Blood Arena — IN SPACE')
    expect(r.text).toBe('')
    expect(r.removed).toHaveLength(1)
  })

  test('a full state block collapses to nothing', () => {
    const r = scrubLiveState([
      '### GROUND TRUTH THIS TURN (AUTHORITATIVE)',
      '- Status: IN SPACE at Albireo > Albireo Ice Fields',
      '- Hull: 90/90 (100%) | Shield: 55/55 | Fuel: 108/110',
      '- Cargo: 118/120 (standard_rounds_box x118)',
      '- Wallet: 1.398Mcr',
    ].join('\n'))
    expect(r.removed).toHaveLength(4)
    expect(r.text).not.toContain('Albireo')
    expect(r.text).not.toContain('1.398Mcr')
  })

  test('an active-ship record goes too — it is why he kept swapping hulls', () => {
    expect(scrubLiveState('- Active ship: **Shard** (110 hull)').text).toBe('')
  })

  test('numbered and bold variants are caught, not just bullets', () => {
    expect(scrubLiveState('1. Fuel: 105/110').text).toBe('')
    expect(scrubLiveState('**Wallet:** 1.4Mcr').text).toBe('')
    expect(scrubLiveState('> Cargo = 20/450').text).toBe('')
  })
})

describe('plans and decisions survive untouched', () => {
  test('a rule about cargo is a plan, not a snapshot', () => {
    const line = '- Sell when cargo is above 400 units'
    expect(scrubLiveState(line).text).toBe(line)
  })

  test('a fuel threshold is a rule', () => {
    const line = '- Fuel: must stay above 40% before any jump'
    expect(scrubLiveState(line).text).toBe(line)
  })

  test('ordinary task lines are untouched', () => {
    const t = ['## LOCKBOX — the only job', '[ ] Buy 50 circuit_board under 1,400 each', '[ ] Then build'].join('\n')
    expect(scrubLiveState(t).text).toBe(t)
  })

  test('durable facts about the world are kept', () => {
    const line = '- The fury tempering forge exists only at Blood Forge and Sirius Observatory.'
    expect(scrubLiveState(line).text).toBe(line)
  })

  test('a clean note is returned unchanged with nothing removed', () => {
    const t = 'Mine at War Materials, sell at the Citadel, repeat.'
    const r = scrubLiveState(t)
    expect(r.text).toBe(t)
    expect(r.removed).toHaveLength(0)
  })
})

describe('the agent is told what happened, not silently edited', () => {
  test('the notice names the dropped lines and the reason', () => {
    const n = scrubNotice(['Location: Krynn', 'Hull: 90/90'])
    expect(n).toContain('Location: Krynn')
    expect(n).toContain('every 60 seconds')
    expect(n).toContain('never a snapshot')
  })

  test('long lists are truncated rather than dumped back', () => {
    const n = scrubNotice(['a: 1', 'b: 2', 'c: 3', 'd: 4', 'e: 5'])
    expect(n).toContain('5 line(s)')
    expect(n).toContain('…')
  })
})

describe('formatting survives the removal', () => {
  test('blank runs left behind are collapsed', () => {
    const r = scrubLiveState('## Plan\n\n- Location: Krynn\n\n- Buy the boards')
    expect(r.text).toBe('## Plan\n\n- Buy the boards')
  })
})

describe('mission state is injected too — recording it is the same bug', () => {
  /**
   * `get_status` returns missions.active[] with ids, objectives and progress
   * every turn. Morg'Thar also wrote them into his TODO, completed one, re-read
   * the note four minutes later and announced "MY TODO IS FROM A COMPLETELY
   * DIFFERENT SESSION" — then HALTed and asked the Admiral for guidance he did
   * not need (2026-09-06). Same shape as the location mismatch, one field short.
   */
  test('a mission slot tally is dropped', () => {
    const r = scrubLiveState('## STATUS\nMISSIONS HELD: 5/5 FULL\n- keep hunting')
    expect(r.text).not.toContain('5/5')
    expect(r.text).toContain('keep hunting')
  })

  test('a per-mission progress readout is dropped', () => {
    const r = scrubLiveState('Active missions: Grazer Cull 2/8, Lucrative Sideline 0/3')
    expect(r.removed.length).toBe(1)
    expect(r.text.trim()).toBe('')
  })

  test('but a PLAN about missions survives', () => {
    const plan = 'Take a crimson delivery when a mission slot frees up'
    expect(scrubLiveState(plan).text).toContain(plan)
  })

  test('and so does a rule with a threshold', () => {
    const rule = 'Missions: never hold more than one I cannot finish'
    expect(scrubLiveState(rule).text).toContain(rule)
  })
})
