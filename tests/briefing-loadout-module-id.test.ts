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

describe('briefing loadout IDs', () => {
  test('uses module_id as weapon identifier fallback', async () => {
    const profileId = 'p-loadout-module-id'
    clearBriefingCache(profileId)
    await refreshBriefingData(profileId, stubConnectionWithModuleId())
    const briefing = buildSituationalBriefing(profileId)
    expect(briefing).toContain('Weapons:')
    expect(briefing).toContain('light_autocannon_i#gun_01 ammo:12/20')
  })
})

