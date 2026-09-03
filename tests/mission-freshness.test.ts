import { describe, expect, test } from 'bun:test'
import { missionsWithObjectives } from '../src/server/lib/briefing'

/**
 * Morg'Thar completed BOTH Sift-Ray contracts at 06:40 on 2026-09-03 — the game
 * read "4/4 [DONE]" and "6/6 [DONE]" — while his briefing still printed
 * "Ghosts in the Cloud 0/4". The READY TO CLAIM block therefore never fired and
 * 3,300cr of finished work sat unclaimed.
 *
 * Cause: for connections with a local-state cache, missions came from that
 * cache, and it lists missions WITHOUT objective progress. An agent that cannot
 * see a finished contract does not turn it in — this is a direct revenue bug,
 * not a cosmetic one.
 */
const withObjectives = [
  { title: 'Ghosts in the Cloud', objectives: [{ description: 'Hunt 4 Sift-Rays', current: 4, required: 4, completed: true }] },
]
// Exactly the shape the lib_v2 cache returns: names, no objective counters.
const cacheShape = [
  { title: 'Ghosts in the Cloud', id: '04c6e7b9' },
  { title: 'Nebula Drift Hunt', id: '9ce471b6' },
]

describe('missionsWithObjectives', () => {
  test('accepts a payload carrying objective progress', () => {
    expect(missionsWithObjectives(withObjectives)).toHaveLength(1)
  })

  test('REJECTS the objective-free cache shape — the actual bug', () => {
    expect(missionsWithObjectives(cacheShape)).toBeNull()
  })

  test('unwraps both wrapper shapes', () => {
    expect(missionsWithObjectives({ missions: withObjectives })).toHaveLength(1)
    expect(missionsWithObjectives({ active: withObjectives })).toHaveLength(1)
  })

  test('rejects empty and malformed payloads rather than blanking good data', () => {
    expect(missionsWithObjectives(null)).toBeNull()
    expect(missionsWithObjectives([])).toBeNull()
    expect(missionsWithObjectives('nonsense')).toBeNull()
    expect(missionsWithObjectives({ missions: [] })).toBeNull()
    expect(missionsWithObjectives([{ objectives: [] }])).toBeNull()
  })

  test('one mission with objectives is enough to prefer the payload', () => {
    expect(missionsWithObjectives([...cacheShape, ...withObjectives])).toHaveLength(3)
  })
})
