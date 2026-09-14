import { describe, expect, test } from 'bun:test'
import { buildSituationalBriefing, clearBriefingCache, refreshBriefingData } from '../src/server/lib/briefing'
import type { GameConnection } from '../src/server/lib/connections/interface'

function stubConnectionWithModuleId(): GameConnection {
  const localState = {
    player: { credits: 1234, current_system: 'haven', current_poi: 'grand_exchange_station', docked: true },
    ship: {
      class_id: 'frigate',
      hull: 95,
      max_hull: 100,
      fuel: 40,
      max_fuel: 80,
      cargo_used: 3,
      cargo_capacity: 20,
      modules: [
        { slot: 'weapon', item_id: 'light_autocannon_i', module_id: 'gun_01', current_ammo: 12, magazine_size: 20 },
      ],
    },
    cargo: [],
    missions: { active: [] },
  } as Record<string, unknown>

  return {
    mode: 'lib_v2',
    connect: async () => {},
    login: async () => ({ success: true }),
    register: async () => ({ success: true }),
    execute: async (command: string) => {
      if (command === 'get_nearby') return { structuredContent: { nearby: [] } }
      if (command === 'get_system') return { structuredContent: { pois: [] } }
      if (command === 'view_market') return { structuredContent: { items: [] } }
      return { structuredContent: {} }
    },
    onNotification: () => {},
    disconnect: async () => {},
    isConnected: () => true,
    supportsNotifications: () => false,
    getLocalState: () => localState,
  }
}

/**
 * A fitted weapon must render with a NAME and a reload ID, whatever shape the
 * payload uses to carry them.
 *
 * lib_v2's get_ship names the instance `module_id` and the class `type_id`, and
 * the briefing already handled that. A payload carrying `item_id` instead had no
 * name source at all, so the gun rendered as the literal "weapon" — the same
 * unusable line the type_id fix was added to stop, reached by a different route.
 * The agent cannot reload what the briefing will not name.
 *
 * Asserted against the briefing's real format rather than a simplified one: the
 * block groups identical guns and prints their reload ids, which is what the
 * agent acts on.
 */
describe('briefing loadout IDs', () => {
  test('names a weapon from item_id and still surfaces its reload id', async () => {
    const profileId = 'p-loadout-module-id'
    clearBriefingCache(profileId)
    await refreshBriefingData(profileId, stubConnectionWithModuleId())
    const briefing = buildSituationalBriefing(profileId)

    expect(briefing).toContain('Weapons (reload uses these ids):')
    // The name comes from item_id; rendering the literal "weapon" is the bug.
    expect(briefing).toContain('light_autocannon_i')
    // module_id is the reload handle, and it must reach the agent.
    expect(briefing).toContain('gun_01')
    // Magazine state rides along on the same line.
    expect(briefing).toContain('12/20')
  })
})

