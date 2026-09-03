import { describe, expect, test } from 'bun:test'
import { executeTool } from '../src/server/lib/tools'
import { getDb } from '../src/server/lib/db'
import { startCatalogService, codexGet } from '../src/server/lib/catalog'

// tools.ts guards read the DB and the catalog directly; open both before dispatch.
getDb()
startCatalogService()

/**
 * Crafting draws ONLY from station storage — never from cargo (verified live
 * 2026-09-02: "cannot_craft: ... Deposit the inputs into station storage first
 * (crafting no longer pulls from cargo)").
 *
 * The game's refusal does not say which input is short, by how much, or that
 * the missing units may be in the agent's own hold one `deposit` away. This
 * gate answers all three before a tick is spent, and it is a dispatch-site
 * refusal, so it holds for any model driving the agent.
 */

function harness(opts: { docked?: string | null } = {}) {
  const calls: Array<{ cmd: string; args: any }> = []
  const conn = {
    mode: 'lib_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    onNotification: () => {},
    getLocalState: () => ({
      location: { system_id: 'krynn', docked_at: opts.docked === undefined ? 'crimson_war_citadel' : opts.docked },
      ship: { hull: 100, max_hull: 100 },
      player: { credits: 1000 },
    }),
    execute: async (cmd: string, args?: any) => {
      calls.push({ cmd, args })
      return { result: 'ok' }
    },
  } as any
  const ctx = { connection: conn, profileId: `p-craft-${Math.random()}`, profileName: 'Test', log: () => {}, todo: '', memory: '' } as any
  return { ctx, calls }
}

describe('craft input gate', () => {
  test('the catalog resolves the recipe this gate depends on', () => {
    const r = codexGet('recipe', 'basic_iron_smelting') as any
    expect(Array.isArray(r?.inputs)).toBe(true)
    expect(r.inputs[0].item_id).toBe('iron_ore')
  })

  test('a craft with empty station storage is refused locally, naming the shortfall', async () => {
    const { ctx, calls } = harness()
    const out = await executeTool('game', { command: 'craft', args: { recipe_id: 'basic_iron_smelting', quantity: 5 } }, ctx)
    // Refused before the wire: no craft reached the game.
    expect(calls.some(c => c.cmd === 'craft')).toBe(false)
    expect(out).toContain('BLOCKED')
    expect(out).toContain('iron_ore')
    expect(out).toContain('station storage')
    // It must state the REQUIRED amount, scaled by quantity (10 per unit x5).
    expect(out).toContain('need 50')
    expect(out).toContain('no game tick was spent')
  })

  test('an unknown recipe is left to the game rather than guessed at', async () => {
    const { ctx, calls } = harness()
    await executeTool('game', { command: 'craft', args: { recipe_id: 'not_a_real_recipe' } }, ctx)
    expect(calls.some(c => c.cmd === 'craft')).toBe(true)
  })

  test('a craft with no recipe_id is passed through untouched', async () => {
    const { ctx, calls } = harness()
    await executeTool('game', { command: 'craft', args: {} }, ctx)
    expect(calls.some(c => c.cmd === 'craft')).toBe(true)
  })

  test('the gate can be switched off by preference', async () => {
    const { setPreference } = await import('../src/server/lib/db')
    const { ctx, calls } = harness()
    setPreference('craft_gate', 'off')
    try {
      await executeTool('game', { command: 'craft', args: { recipe_id: 'basic_iron_smelting' } }, ctx)
      expect(calls.some(c => c.cmd === 'craft')).toBe(true)
    } finally {
      setPreference('craft_gate', '')
    }
  })
})
