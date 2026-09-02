import { describe, expect, test } from 'bun:test'
import { collectTargets } from '../src/server/lib/briefing'

/**
 * get_nearby's own `nearby` array is EMPTY even when the POI is full of things
 * to shoot — the shootable entries live in `creatures` / `pirates` /
 * `empire_npcs`. The briefing read only `nearby`, so it rendered
 * "Nearby objects: 0" while four grazers sat in front of Morg'Thar at Alkaid
 * Gas Pocket on 2026-09-02. He crossed thirteen systems and killed nothing.
 *
 * Payload below is a verbatim capture from his own get_nearby result.
 */
const ALKAID = {
  count: 0,
  creature_count: 4,
  creatures: [
    { creature_id: 'crt_b93785c415cffc66f75529474a19351a', hull: 220, max_hull: 220, in_combat: false, name: 'Pilot-Whale', role: 'grazer', species: 'pilot_whale' },
    { creature_id: 'crt_2c7a341d7c591fbf0870d0a80874f380', hull: 220, max_hull: 220, in_combat: false, name: 'Pilot-Whale', role: 'grazer', species: 'pilot_whale' },
    { creature_id: 'crt_31fb768e729481314a834b0f395a1a14', hull: 45, max_hull: 45, in_combat: false, name: 'Drift-Ray', role: 'grazer', species: 'drift_ray' },
    { creature_id: 'crt_1fd30fb4ed8dc43a7739455daa1ccaf9', hull: 45, max_hull: 45, in_combat: true, name: 'Drift-Ray', role: 'grazer', species: 'drift_ray' },
  ],
  empire_npc_count: 0,
  empire_npcs: [],
  nearby: [],
  pirate_count: 0,
  pirates: [],
  poi_id: 'alkaid_gas_pocket',
}

const EMPTY = { count: 0, creature_count: 0, creatures: [], empire_npcs: [], nearby: [], pirates: [], poi_id: 'gsc_0030_star' }

describe('collectTargets', () => {
  test('finds every creature the empty `nearby` array hid', () => {
    const t = collectTargets(ALKAID)
    expect(t).toHaveLength(4)
    expect(t.map(x => x.id)).toContain('crt_b93785c415cffc66f75529474a19351a')
    expect(t.every(x => x.kind === 'creature')).toBe(true)
  })

  test('carries the hull and in-combat flags a fight decision needs', () => {
    const whale = collectTargets(ALKAID).find(x => x.name === 'Pilot-Whale')!
    expect(whale.hull).toBe(220)
    expect(whale.maxHull).toBe(220)
    expect(collectTargets(ALKAID).filter(x => x.inCombat)).toHaveLength(1)
  })

  test('separates pirates and empire NPCs from creatures', () => {
    const t = collectTargets({
      creatures: [{ creature_id: 'crt_1', name: 'Belt-Grazer' }],
      pirates: [{ pirate_id: 'pir_1', name: 'Scout Raider', hull: 300, max_hull: 300 }],
      empire_npcs: [{ npc_id: 'npc_1', name: '[POLICE] Rim Patrol' }],
      nearby: [],
    })
    expect(t.map(x => x.kind).sort()).toEqual(['creature', 'npc', 'pirate'])
    expect(t.find(x => x.kind === 'pirate')!.id).toBe('pir_1')
  })

  test('an entry with no id is skipped rather than yielding an unusable target', () => {
    expect(collectTargets({ creatures: [{ name: 'Ghost', hull: 1 }], nearby: [] })).toHaveLength(0)
  })

  test('an empty POI yields no targets', () => {
    expect(collectTargets(EMPTY)).toHaveLength(0)
  })

  test('junk input never throws', () => {
    for (const junk of [null, undefined, 'nope', 42, [], { creatures: 'not-an-array' }]) {
      expect(collectTargets(junk)).toEqual([])
    }
  })
})
