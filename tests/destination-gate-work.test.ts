/**
 * The destination gate refused the fleet's most productive pattern.
 *
 * The gate stops an agent re-picking its destination without working the one it
 * is in — a real failure it was built for (Morg'Thar set course for three
 * systems in six minutes on 2026-09-01 and worked none of them).
 *
 * But on 2026-09-05 it blocked Nova Reyes six times in thirty minutes while she
 * ran her ordinary earning circuit: mine at Bharani, sell at The Crucible,
 * deposit ore at Iron Reach, repeat. Her log:
 *
 *   21:40:43  sell_cargo(exclude=[iron_ore, copper_ore])
 *   21:40:52  goto_system(iron_reach)      -> BLOCKED, "done nothing at the_crucible"
 *   21:43:23  deposit(iron_ore x44)
 *   21:43:27  deposit(copper_ore x22)
 *   21:43:51  goto_system(bharani)         -> BLOCKED, "done nothing at iron_reach"
 *
 * Both blocks were wrong. WORK_COMMANDS listed bare `sell` but not `sell_cargo`,
 * the macro agents actually sell with, and omitted `deposit` entirely — so the
 * two commands that end nearly every hauling leg did not count. She was on cycle
 * 29 with a 225,995cr wallet, being told she had accomplished nothing at
 * stations where she had just sold and banked ore.
 *
 * A gate that refuses productive work is worse than no gate: it burns the turns
 * it exists to save, and teaches agents to fight the harness. The list now errs
 * toward inclusion.
 */
import { test, expect, describe } from 'bun:test'

// Mirrors WORK_COMMANDS and the bare-name normalisation in tools.ts.
const WORK_COMMANDS = new Set([
  'scan', 'get_nearby', 'get_wrecks', 'survey', 'dock',
  'mine', 'mine_until_full', 'attack', 'loot', 'salvage', 'salvage_wreck', 'hunt_here',
  'view_market', 'analyze_market', 'buy', 'sell', 'sell_cargo',
  'create_sell_order', 'create_buy_order', 'cancel_order',
  'deposit', 'withdraw', 'deposit_items', 'withdraw_items',
  'faction_deposit_items', 'faction_withdraw_items', 'send_gift',
  'refuel', 'repair', 'craft', 'reload', 'install_mod', 'uninstall_mod',
  'accept_mission', 'complete_mission', 'get_missions',
])

function countsAsWork(command: string): boolean {
  const bare = command.replace(/^spacemolt_/, '')
    .replace(/^(?:market|storage|social|intel|faction|faction_admin|salvage|catalog|ship|battle|transfer|facility|auth)_/, '')
  return WORK_COMMANDS.has(bare)
}

describe("Nova's earning circuit is never called idle", () => {
  test('selling with the sell_cargo macro is work', () => {
    // The exact call at 21:40:43 that the gate ignored.
    expect(countsAsWork('sell_cargo')).toBe(true)
  })

  test('depositing ore into storage is work', () => {
    // The exact call at 21:43:23 that the gate ignored.
    expect(countsAsWork('deposit')).toBe(true)
    expect(countsAsWork('deposit_items')).toBe(true)
  })

  test('the whole mine-sell-deposit leg registers at every stop', () => {
    for (const c of ['mine_until_full', 'dock', 'sell_cargo', 'deposit', 'undock_not_a_thing'].slice(0, 4))
      expect(countsAsWork(c)).toBe(true)
  })

  test('moving faction stock counts, since that is now fleet doctrine', () => {
    expect(countsAsWork('faction_deposit_items')).toBe(true)
    expect(countsAsWork('faction_withdraw_items')).toBe(true)
  })

  test('station services count — refuelling and crafting are not passing through', () => {
    expect(countsAsWork('refuel')).toBe(true)
    expect(countsAsWork('craft')).toBe(true)
    expect(countsAsWork('reload')).toBe(true)
    expect(countsAsWork('install_mod')).toBe(true)
  })

  test('prefixed forms normalise to the same verb', () => {
    expect(countsAsWork('storage_deposit_items')).toBe(true)
    expect(countsAsWork('market_view_market')).toBe(true)
    expect(countsAsWork('spacemolt_storage_deposit_items')).toBe(true)
  })
})

describe('macros credit work too — they run on a different code path', () => {
  // MACRO_TOOLS are dispatched before the game-command executor that calls
  // noteDestinationWork, so listing them in WORK_COMMANDS was not enough on its
  // own. Nova Reyes was blocked leaving The Crucible on 2026-09-05 ten seconds
  // after a successful sell_cargo there; her entire earning loop is macros, so
  // the gate blocked her all day while she worked every stop correctly.
  const MACROS = ['mine_until_full', 'sell_cargo', 'hunt_here', 'goto_system']
  const creditsWork = (macro: string) => macro !== 'goto_system' && countsAsWork(macro)

  test('selling a hold at a station is work', () => {
    expect(creditsWork('sell_cargo')).toBe(true)
  })

  test('mining a belt is work', () => {
    expect(creditsWork('mine_until_full')).toBe(true)
  })

  test('hunting at a POI is work', () => {
    expect(creditsWork('hunt_here')).toBe(true)
  })

  test('but travelling is not — that is what the gate exists to stop', () => {
    expect(creditsWork('goto_system')).toBe(false)
  })

  test('every macro except goto_system credits work', () => {
    expect(MACROS.filter(creditsWork).sort()).toEqual(['hunt_here', 'mine_until_full', 'sell_cargo'])
  })
})

describe('the gate still catches what it was built for', () => {
  test('routing and re-routing is not work', () => {
    expect(countsAsWork('goto_system')).toBe(false)
    expect(countsAsWork('jump')).toBe(false)
    expect(countsAsWork('find_route')).toBe(false)
    expect(countsAsWork('travel')).toBe(false)
  })

  test('narrating a plan is not work — this is the churn the gate exists to stop', () => {
    expect(countsAsWork('update_todo')).toBe(false)
    expect(countsAsWork('update_memory')).toBe(false)
    expect(countsAsWork('status_log')).toBe(false)
  })

  test('undocking is not work — arriving and leaving is exactly passing through', () => {
    expect(countsAsWork('undock')).toBe(false)
  })
})
