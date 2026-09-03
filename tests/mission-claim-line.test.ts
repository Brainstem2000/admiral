import { afterEach, describe, expect, test } from 'bun:test'
import { buildSituationalBriefing, refreshBriefingData, clearBriefingCache } from '../src/server/lib/briefing'

/**
 * A finished contract pays NOTHING until it is turned in at its ISSUING base —
 * not wherever the last kill happened. Morg'Thar's Grazer Cull reached 7/8 at
 * Nashira on 2026-09-02 while its reward sat at cargo_lanes_freight_depot, and
 * the briefing said nothing about where to claim it.
 *
 * So the Missions line now carries claim@<issuing base> for every contract, and
 * a completed one is called out separately with the exact complete_mission call.
 * This is briefing state, so it helps whatever model is driving.
 */

function stubConnection(missions: unknown[]) {
  return {
    mode: 'http_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    onNotification: () => {},
    getLocalState: () => null,
    execute: async (command: string) => {
      if (command === 'get_status') {
        return { structuredContent: { player: { credits: 1000 }, location: { system_name: 'Nashira', docked_at: null }, ship: { hull: 100, max_hull: 100 } } }
      }
      if (command === 'get_active_missions') return { structuredContent: { missions } }
      return { structuredContent: {} }
    },
  } as any
}

const DONE = {
  mission_id: '4cd843d2ca406b5d7b80d38bb4a9d744', title: 'Grazer Cull',
  issuing_base_id: 'cargo_lanes_freight_depot', issuing_system_id: 'cargo_lanes',
  rewards: { credits: 1200 },
  objectives: [{ description: 'Hunt 8 Belt-Grazers', current: 8, required: 8 }],
}
const PARTIAL = {
  mission_id: 'aaaaaaaabbbbbbbbccccccccdddddddd', title: 'Ice-Field Thinning',
  issuing_base_id: 'cargo_lanes_freight_depot', issuing_system_id: 'cargo_lanes',
  rewards: { credits: 1300 },
  objectives: [{ description: 'Hunt 6 Rime-Grazers', current: 3, required: 6 }],
}

const pids: string[] = []
afterEach(() => { for (const p of pids.splice(0)) clearBriefingCache(p) })

async function brief(missions: unknown[]): Promise<string> {
  const pid = `p-claim-${Math.random()}`
  pids.push(pid)
  clearBriefingCache(pid)
  await refreshBriefingData(pid, stubConnection(missions))
  return buildSituationalBriefing(pid)
}

describe('mission claim rendering', () => {
  test('a completed contract is called out with its issuing base and the exact call', async () => {
    const b = await brief([DONE])
    expect(b).toContain('READY TO CLAIM')
    expect(b).toContain('cargo_lanes_freight_depot')
    expect(b).toContain('complete_mission(id="4cd843d2ca406b5d7b80d38bb4a9d744")')
    expect(b).toContain('unpaid until you turn them in')
  })

  test('an unfinished contract is NOT announced as claimable', async () => {
    const b = await brief([PARTIAL])
    expect(b).not.toContain('READY TO CLAIM')
    expect(b).toContain('3/6')
  })

  test('every contract shows where it is claimed, finished or not', async () => {
    const b = await brief([PARTIAL, DONE])
    expect(b).toContain('claim@cargo_lanes_freight_depot')
  })

  test('a mission with no objectives is never treated as complete', async () => {
    const b = await brief([{ mission_id: 'x'.repeat(32), title: 'Vague Job', rewards: { credits: 5 }, objectives: [] }])
    expect(b).not.toContain('READY TO CLAIM')
  })
})
