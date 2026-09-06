/**
 * A nudge was read, acknowledged, and skipped — so the rule became a guard.
 *
 * A Wexler rescue is unpaid charity: the 2026-08-28 rescue of Wexler HHC-A4 left
 * a 3,000cr debt that has never been paid. On 2026-09-05 Morg'Thar accepted
 * "Distress: Wexler EQC-0M in Fumalsamakah" — 25 piloting XP, no credits, into
 * lawless space. The Admiral told him to drop it; he quoted the instruction back
 * in his own reasoning ("The Admiral is explicit: Drop the Wexler distress
 * call") and then routed to Haven without dropping it. It had to be abandoned
 * for him.
 *
 * Mission ids are opaque hashes, so the accept cannot be judged on the id alone.
 * Agents read a board before accepting from it, so titles are cached from those
 * reads; acceptSideEffect is the backstop for anything the cache never saw,
 * reading the title out of the game's own accept response.
 *
 * The rule is deliberately narrow — Wexler AND a rescue. A paying Wexler trade
 * contract is ordinary business, and someone else's distress call is a decision
 * for the agent, not something the harness should pre-empt.
 */
import { test, expect, describe } from 'bun:test'
import { isRefusedMissionTitle, noteMissionTitles, refuseAccept, acceptSideEffect, knownTitle, isAlwaysDroppable } from '../src/server/lib/mission-guard'

const BOARD = `Missions at The Crucible Garrison (3):
--- Distress: Wexler EQC-0M in Fumalsamakah [7d3fe44b93c591d43cfa96926fcf36bc] (distress_response, difficulty 5) ---
MAYDAY: Wexler EQC-0M is stranded at Fumalsamakah Star with 4/120 fuel!
Rewards: +25 piloting XP
--- Emergency Rations [94aaf6bda2406958befe6a8590df8090] (delivery, difficulty 2) ---
Deliver 15 units of Flex Polymer to Iron Reach.
Rewards: 2,500cr, +35 trading XP, +2 rep
--- Grazer Cull [88912e4b7ccb4af14e2b2267cb6ceaeb] (combat, difficulty 2) ---
Rewards: 1,200cr`

describe('the exact mission that prompted this', () => {
  test('its title is refused', () => {
    expect(isRefusedMissionTitle('Distress: Wexler EQC-0M in Fumalsamakah')).toBe(true)
  })

  test('accepting it after reading the board is blocked', () => {
    noteMissionTitles(BOARD)
    expect(knownTitle('7d3fe44b93c591d43cfa96926fcf36bc')).toContain('Wexler')
    const r = refuseAccept({ mission_id: '7d3fe44b93c591d43cfa96926fcf36bc' })
    expect(r).toContain('BLOCKED by Admiral doctrine')
    expect(r).toContain('3,000cr debt')
  })

  test('the id may arrive as `id` or `template_id` instead', () => {
    noteMissionTitles(BOARD)
    expect(refuseAccept({ id: '7d3fe44b93c591d43cfa96926fcf36bc' })).toBeTruthy()
    expect(refuseAccept({ template_id: '7d3fe44b93c591d43cfa96926fcf36bc' })).toBeTruthy()
  })

  test('the refusal points at paying work rather than just saying no', () => {
    noteMissionTitles(BOARD)
    expect(refuseAccept({ mission_id: '7d3fe44b93c591d43cfa96926fcf36bc' })).toContain('crimson station board')
  })
})

describe('everything else on the same board is untouched', () => {
  test('the delivery that pays credits and reputation is allowed', () => {
    noteMissionTitles(BOARD)
    expect(refuseAccept({ mission_id: '94aaf6bda2406958befe6a8590df8090' })).toBeNull()
  })

  test('the winnable combat contract is allowed', () => {
    noteMissionTitles(BOARD)
    expect(refuseAccept({ mission_id: '88912e4b7ccb4af14e2b2267cb6ceaeb' })).toBeNull()
  })

  test('an unseen mission is permitted — the guard never blocks on a guess', () => {
    expect(refuseAccept({ mission_id: 'never_seen_on_any_board' })).toBeNull()
  })

  test('no id at all is permitted', () => {
    expect(refuseAccept({})).toBeNull()
    expect(refuseAccept(undefined)).toBeNull()
  })
})

describe('the rule is narrow on purpose', () => {
  test("a paying Wexler TRADE contract is ordinary business", () => {
    expect(isRefusedMissionTitle('Trade Run: Wexler Consortium to Iron Reach')).toBe(false)
  })

  test("someone else's distress call is the agent's decision", () => {
    expect(isRefusedMissionTitle('Distress: Hauler Mira stranded at Thuban')).toBe(false)
  })

  test('both halves are required — the operator and the rescue', () => {
    expect(isRefusedMissionTitle('MAYDAY: Wexler EQC-0M stranded')).toBe(true)
    expect(isRefusedMissionTitle('Rescue the Wexler crew')).toBe(true)
    expect(isRefusedMissionTitle('Wexler cargo pickup')).toBe(false)
  })
})

describe('the backstop catches what the cache never saw', () => {
  const ACCEPTED = `--- Distress: Wexler EQC-0M in Fumalsamakah [7d3fe44b93c591d43cfa96926fcf36bc] (distress_response) ---
MAYDAY: stranded with 4/120 fuel. Accepted.`

  test('it reads the id back out of the accept response', () => {
    const hit = acceptSideEffect(ACCEPTED, {})
    expect(hit?.id).toBe('7d3fe44b93c591d43cfa96926fcf36bc')
    expect(hit?.title).toContain('Wexler')
  })

  test('it falls back to the argument id when the response carries none', () => {
    expect(acceptSideEffect('MAYDAY Wexler stranded, accepted', { mission_id: 'abc123' })?.id).toBe('abc123')
  })

  test('an ordinary accept produces nothing', () => {
    expect(acceptSideEffect('--- Emergency Rations [94aaf] (delivery) --- accepted', {})).toBeNull()
  })
})

/**
 * Abandon-churn: dropping one bad contract is judgement, dropping every contract
 * is a loop.
 *
 * On 2026-09-05 Morg'Thar accepted 8 missions and abandoned 8 in three hours,
 * completing none. His Crimson reputation sat on its baseline of 20 the whole
 * time, hours after being told to raise it, and he made 22 route calls in the
 * final hour. Four nudges and two directive rewrites did not change it, so the
 * fourth abandon inside an hour is refused.
 *
 * The window rolls rather than latching: this is a floor on commitment, not a
 * ban. He was right to drop a delivery whose pickup was 24 hops away, and that
 * judgement stays available.
 */
import { refuseAbandon, noteAbandon, recentAbandons, resetAbandons } from '../src/server/lib/mission-guard'

describe('abandon-churn guard', () => {
  const P = 'morg-test'
  const T0 = 1_757_000_000_000

  test('the first three drops are allowed — that is judgement', () => {
    resetAbandons(P)
    for (let i = 0; i < 3; i++) {
      expect(refuseAbandon(P, T0 + i * 1000)).toBeNull()
      noteAbandon(P, T0 + i * 1000)
    }
    expect(recentAbandons(P, T0 + 3000)).toBe(3)
  })

  test('the fourth inside the hour is refused', () => {
    resetAbandons(P)
    for (let i = 0; i < 3; i++) noteAbandon(P, T0 + i * 1000)
    const r = refuseAbandon(P, T0 + 4000)
    expect(r).toContain('BLOCKED by Admiral doctrine')
    expect(r).toContain('abandoned 3 missions')
  })

  test('it tells the agent what to do instead of only saying no', () => {
    resetAbandons(P)
    for (let i = 0; i < 3; i++) noteAbandon(P, T0 + i * 1000)
    const r = refuseAbandon(P, T0 + 4000)!
    expect(r).toContain('FINISH A CONTRACT BEFORE DROPPING ANOTHER')
    expect(r).toContain('faction chat')
  })

  test('the window rolls — an hour later dropping is allowed again', () => {
    resetAbandons(P)
    for (let i = 0; i < 3; i++) noteAbandon(P, T0 + i * 1000)
    expect(refuseAbandon(P, T0 + 61 * 60_000)).toBeNull()
  })

  test('one agent churning never restricts another', () => {
    resetAbandons()
    for (let i = 0; i < 5; i++) noteAbandon('morg', T0 + i * 1000)
    expect(refuseAbandon('morg', T0 + 6000)).toBeTruthy()
    expect(refuseAbandon('nova', T0 + 6000)).toBeNull()
  })

  test("Morg's actual rate — 8 in three hours — is caught", () => {
    resetAbandons(P)
    let blocked = 0
    for (let i = 0; i < 8; i++) {
      const t = T0 + i * 5 * 60_000          // one every five minutes
      if (refuseAbandon(P, t)) blocked++; else noteAbandon(P, t)
    }
    expect(blocked).toBeGreaterThan(0)
    expect(recentAbandons(P, T0 + 40 * 60_000)).toBe(3)
  })
})

describe('auto-assigned distress calls', () => {
  /**
   * The accept guard cannot see these. The game auto-assigns distress
   * investigations to every ship in the system — Cass Margin and Vera Lane were
   * both handed "Distress: Wexler R1P-JL in Rasalgethi" on 2026-09-06 without
   * either one calling accept_mission. So the refusal has to be recognisable
   * from the TITLE alone, wherever the mission came from, and dropping one must
   * never be blocked by the abandon-churn guard.
   */
  test('the auto-assigned title is still recognised as refused', () => {
    expect(isRefusedMissionTitle('Distress: Wexler R1P-JL in Rasalgethi')).toBe(true)
  })
  test('and is therefore always droppable, whatever the churn count', () => {
    expect(isAlwaysDroppable('Distress: Wexler R1P-JL in Rasalgethi')).toBe(true)
  })
  test('an ordinary distress call from someone else is not refused', () => {
    expect(isRefusedMissionTitle('Distress: Halloran K2 in Bharani')).toBe(false)
    expect(isAlwaysDroppable('Distress: Halloran K2 in Bharani')).toBe(false)
  })
  test('a Wexler contract that is not a rescue is not refused', () => {
    expect(isRefusedMissionTitle('Wexler Freight: haul 40 steel_plate')).toBe(false)
  })
})
