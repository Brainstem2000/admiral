import { describe, expect, test } from 'bun:test'
import { executeTool, type ToolContext } from '../src/server/lib/tools'
import type { GameConnection } from '../src/server/lib/connections/types'

/**
 * Jettison gate (2026-07-30). Four agents jettisoned sellable cargo in one
 * campaign on identical reasoning ("no local bid -> free the space"); written
 * doctrine failed every time, one incident triggered a full agent rebuild.
 * These tests pin the deterministic refusal so it cannot regress.
 */

function makeCtx(): { ctx: ToolContext; reachedGame: () => boolean } {
  let reached = false
  const connection = {
    execute: async () => { reached = true; return { ok: true } },
    isConnected: () => true,
    supportsNotifications: () => false,
  } as unknown as GameConnection
  return {
    ctx: {
      connection,
      profileId: 'test-profile',
      profileName: 'Test Agent',
      log: () => {},
      todo: '',
      memory: '',
    },
    reachedGame: () => reached,
  }
}

describe('jettison gate', () => {
  test('blocks a bare jettison and never reaches the game', async () => {
    const { ctx, reachedGame } = makeCtx()
    const out = await executeTool('game', { command: 'jettison', item_id: 'aluminum_ore', quantity: 21 }, ctx)
    expect(out).toContain('BLOCKED by Admiral doctrine')
    expect(reachedGame()).toBe(false)
  })

  test('blocks the spacemolt_-prefixed and ship_-grouped variants', async () => {
    for (const command of ['spacemolt_jettison', 'ship_jettison', 'spacemolt_ship_jettison']) {
      const { ctx, reachedGame } = makeCtx()
      const out = await executeTool('game', { command, item_id: 'vanadium_ore', quantity: 5 }, ctx)
      expect(out).toContain('BLOCKED by Admiral doctrine')
      expect(reachedGame()).toBe(false)
    }
  })

  test('blocks the multi-item form and names every item in the refusal', async () => {
    const { ctx } = makeCtx()
    const out = await executeTool('game', {
      command: 'jettison',
      items: [
        { item_id: 'aluminum_ore', quantity: 21 },
        { item_id: 'vanadium_ore', quantity: 14 },
      ],
    }, ctx)
    expect(out).toContain('aluminum_orex21')
    expect(out).toContain('vanadium_orex14')
  })

  test('refusal names the three legitimate alternatives', async () => {
    const { ctx } = makeCtx()
    const out = await executeTool('game', { command: 'jettison', item_id: 'copper_ore', quantity: 7 }, ctx)
    expect(out).toMatch(/deposit/i)
    expect(out).toMatch(/gift/i)
    expect(out).toMatch(/sell/i)
  })

  test('does not block unrelated commands', async () => {
    const { ctx, reachedGame } = makeCtx()
    const out = await executeTool('game', { command: 'get_cargo' }, ctx)
    expect(out).not.toContain('BLOCKED by Admiral doctrine')
    expect(reachedGame()).toBe(true)
  })
})

describe('doctrine guards are shared across both command paths', () => {
  test('checkDoctrineGuards blocks jettison and allows unrelated commands', async () => {
    const { checkDoctrineGuards } = await import('../src/server/lib/tools')
    expect(checkDoctrineGuards('jettison', { item_id: 'iron_ore', quantity: 3 }, 'p1'))
      .toContain('BLOCKED by Admiral doctrine')
    expect(checkDoctrineGuards('get_cargo', undefined, 'p1')).toBeNull()
  })

  test('checkDoctrineGuards does NOT block wildlife missions (ban lifted 2026-08-06)', async () => {
    const { checkDoctrineGuards } = await import('../src/server/lib/tools')
    // The wildlife/creature-hunt ban was deliberately removed: herds gather in
    // RICH fields and thin out in mined-over ones, so the original "targets do
    // not spawn" premise was wrong, and creature drops refine into exactly the
    // lines the Devastator is short of (adamant_tooth -> mass drivers). The
    // failure mode was method, not the feature, so the guidance moved to the
    // HUNTING DOCTRINE directive block. This asserts the block stays gone.
    expect(checkDoctrineGuards('accept_mission', { mission_id: 'cull_grazer_01' }, 'p1')).toBeNull()
  })
})
