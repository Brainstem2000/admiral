import { describe, expect, test } from 'bun:test'
import { getDb, getFactionTreasuryStatement, recordFactionTreasurySnapshot } from '../src/server/lib/db'

/**
 * Facility builds are the treasury's largest one-off outflow and the game never reports the
 * charge as a command result — only the build COMMAND lands, in the agent's own log. So the
 * treasury side arrived as a nameless gap and the statement filed it as "unattributed outflow".
 * On 2026-09-16 that was 543,700 of 735,657 gross unattributed (74%), all of it identifiable:
 * -151,000 breeder_reactor_core, -150,000 market_runner, -136,000 plasma_residue_condenser.
 */
const COSTS: Record<string, number> = {
  breeder_reactor_core: 151_000,
  plasma_residue_condenser: 136_000,
  plasma_injector_assembly: 105_000,
  market_runner: 150_000,
}
const facilityCost = (t: string) => COSTS[t] ?? null

function seed(opts: { snapAt: string; from: number; to: number; buildAt: string; type: string }) {
  const d = getDb()
  const pid = `p_treas_${Math.random().toString(36).slice(2, 8)}`
  d.query('INSERT INTO profiles (id, name) VALUES (?, ?)').run(pid, 'Builder ' + pid.slice(-4))
  d.query(`INSERT INTO log_entries (profile_id, timestamp, type, summary)
           VALUES (?, ?, 'tool_call', ?)`)
    .run(pid, opts.buildAt, `game(facility_faction_build, facility_type=${opts.type})`)
  recordFactionTreasurySnapshot('f_test', opts.from, 'tester', 'view', opts.snapAt)
  recordFactionTreasurySnapshot('f_test', opts.to, 'tester', 'view', opts.snapAt.replace(/:(\d\d)$/, ':59'))
  return pid
}

describe('treasury statement names facility builds instead of filing them as unattributed', () => {
  test('an outflow equal to a catalog build cost is named as that build', () => {
    seed({ snapAt: '2031-03-01 10:00:00', from: 3_000_000, to: 3_000_000 - 136_000,
           buildAt: '2031-03-01 10:00:30', type: 'plasma_residue_condenser' })

    const st = getFactionTreasuryStatement({ since: '2031-03-01 00:00:00', facilityCost })
    const hit = st.entries.find(e => e.kind === 'facility_build')
    expect(hit).toBeDefined()
    expect(hit!.credits).toBe(-136_000)
    expect(hit!.reason).toContain('plasma residue condenser')
    expect(hit!.reason).toContain('136,000')
    expect(st.entries.some(e => e.kind === 'unattributed_outflow')).toBe(false)
  })

  test('rent riding along in the same window is reported, not used to reject the match', () => {
    seed({ snapAt: '2031-03-02 10:00:00', from: 2_000_000, to: 2_000_000 - 106_700,
           buildAt: '2031-03-02 10:00:30', type: 'plasma_injector_assembly' })

    const st = getFactionTreasuryStatement({ since: '2031-03-02 00:00:00', facilityCost })
    const hit = st.entries.find(e => e.kind === 'facility_build')
    expect(hit).toBeDefined()
    expect(hit!.credits).toBe(-106_700)
    expect(hit!.reason).toContain('105,000')
    expect(hit!.reason).toContain('1,700')          // the rent remainder, stated
  })

  test('an outflow SMALLER than the build cost is never claimed by it', () => {
    seed({ snapAt: '2031-03-03 10:00:00', from: 2_000_000, to: 2_000_000 - 4_000,
           buildAt: '2031-03-03 10:00:30', type: 'breeder_reactor_core' })

    const st = getFactionTreasuryStatement({ since: '2031-03-03 00:00:00', facilityCost })
    expect(st.entries.some(e => e.kind === 'facility_build')).toBe(false)
  })

  test('a build retried twenty times explains exactly ONE outflow', () => {
    const d = getDb()
    const pid = `p_retry_${Math.random().toString(36).slice(2, 8)}`
    d.query('INSERT INTO profiles (id, name) VALUES (?, ?)').run(pid, 'Retrier')
    // Morg ran plasma_injector_assembly twenty times before one took. Twenty commands,
    // one charge — the statement must not report twenty builds.
    for (let i = 0; i < 20; i++)
      d.query(`INSERT INTO log_entries (profile_id, timestamp, type, summary) VALUES (?, ?, 'tool_call', ?)`)
        .run(pid, `2031-03-04 10:0${Math.floor(i / 10)}:${String(i % 10).padStart(2, '0')}`,
             'game(facility_faction_build, facility_type=market_runner)')
    recordFactionTreasurySnapshot('f_test', 5_000_000, 'tester', 'view', '2031-03-04 10:00:00')
    recordFactionTreasurySnapshot('f_test', 5_000_000 - 150_000, 'tester', 'view', '2031-03-04 10:30:00')

    const st = getFactionTreasuryStatement({ since: '2031-03-04 00:00:00', facilityCost })
    expect(st.entries.filter(e => e.kind === 'facility_build').length).toBe(1)
  })

  test('with no resolver injected the pass is inert — nothing is invented', () => {
    seed({ snapAt: '2031-03-05 10:00:00', from: 1_000_000, to: 1_000_000 - 151_000,
           buildAt: '2031-03-05 10:00:30', type: 'breeder_reactor_core' })

    const st = getFactionTreasuryStatement({ since: '2031-03-05 00:00:00' })   // no facilityCost
    expect(st.entries.some(e => e.kind === 'facility_build')).toBe(false)
    expect(st.entries.some(e => e.kind === 'unattributed_outflow')).toBe(true)
  })
})

/**
 * Rent is per-facility, so the per-cycle bill RISES every time the faction builds:
 * this one went 112 -> 338 -> 664 -> 675. The rent pass used to match accumulated
 * gaps against only the single most FREQUENT rate, so anything billed under a
 * superseded rate stayed unattributed — 33,864 sat unexplained for a week and is
 * exactly 51 cycles of 664.
 */
describe('rent accumulated under a superseded rate is still recognised', () => {
  test('a gap that is an exact multiple of an OLD rate is named as rent', () => {
    const OLD = 664, NEW = 675
    let at = 0
    const stamp = () => `2031-04-01 ${String(10 + Math.floor(at / 60)).padStart(2, '0')}:${String(at++ % 60).padStart(2, '0')}:00`
    let bal = 9_000_000
    recordFactionTreasurySnapshot('f_rate', bal, 'tester', 'view', stamp())
    // three cycles at the old rate, so 664 is an established rate for this faction
    for (let i = 0; i < 3; i++) { bal -= OLD; recordFactionTreasurySnapshot('f_rate', bal, 'tester', 'view', stamp()) }
    // three at the new rate, which becomes the most frequent
    for (let i = 0; i < 3; i++) { bal -= NEW; recordFactionTreasurySnapshot('f_rate', bal, 'tester', 'view', stamp()) }
    // then an overnight gap billed at the OLD rate: 51 cycles, nobody watching
    bal -= OLD * 51
    recordFactionTreasurySnapshot('f_rate', bal, 'tester', 'view', stamp())

    const st = getFactionTreasuryStatement({ since: '2031-04-01 00:00:00' })
    const big = st.entries.find(e => e.credits === -(OLD * 51))
    expect(big).toBeDefined()
    expect(big!.kind).toBe('facility_rent')
    expect(big!.reason).toContain('51 cycles')
    expect(big!.reason).toContain('664')
  })
})
