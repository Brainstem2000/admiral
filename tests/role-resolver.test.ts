import { describe, expect, test } from 'bun:test'
import { resolveAgentRole } from '../src/server/lib/role'

/**
 * Role resolution for the real fleet roster (names and directive heads as
 * stored on 2026-09-02). The hunter render drops mining/crafting/trading
 * doctrine and the mine/craft commands, so a false 'hunter' is expensive:
 * Zibal Prospector ("EXPLORER & HUNTER" in his directive head) is a
 * prospector who mines, and must stay on the default render.
 */
const roster: Array<[string, string, 'hunter' | 'default']> = [
  ["Morg'Thar - Warrior", "MORG'THAR — HUNTER'S ORDERS (Admiral, Sep 1 21:50 CT) — SUPERSEDES ALL PRIOR\nJOB: hunt the Outer Rim cluster for PAID contracts. Never mine. Never craft.", 'hunter'],
  ['Zibal Prospector', '## ZIBAL — EXPLORER & HUNTER — first orders\nYou are an explorer-prospector flying a Pathfinder.', 'default'],
  ['Grit Vane - Miner', '## GRIT VANE — INDEPENDENT MINER — first orders', 'default'],
  ['Ledger Voss - Miner', '## LEDGER VOSS — THE TWINS EXPERIMENT — first orders', 'default'],
  ['Juno Freight - Trader', '## JUNO — THE COBALT LOOP — SUPERSEDES ALL PRIOR', 'default'],
  ['Bob Comet - Smuggler', '## BOB — STEEL DONE. REVENUE, THEN THE WAGON', 'default'],
  ['Rook Vance - Hauler', '## ROOK VANCE — APPRENTICE HAULER — first orders', 'default'],
  ['Cass Margin - Trader', '## CASS — THE CARAVAN ERA — SUPERSEDES ALL PRIOR', 'default'],
  ['Vera Lane - Trader', '## VERA LANE — BACK ON THE DESK', 'default'],
]

describe('resolveAgentRole on the fleet roster', () => {
  for (const [name, directive, expected] of roster) {
    test(`${name} -> ${expected}`, () => {
      expect(resolveAgentRole({ name, directive, group_name: 'Stellar Alliance' })).toBe(expected)
    })
  }

  test('a hunting directive head still wins for an unlabelled name', () => {
    expect(resolveAgentRole({ name: 'Kestrel', directive: 'KESTREL — BOUNTY HUNTER. Kill pirates for contracts.', group_name: null })).toBe('hunter')
  })

  test('a non-combat job word in the NAME beats a combat word in the directive head', () => {
    expect(resolveAgentRole({ name: 'Anyone Prospector', directive: 'EXPLORER & HUNTER — survey belts, hunt what you find', group_name: null })).toBe('default')
  })
})
