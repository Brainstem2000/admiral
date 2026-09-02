import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ACTIONS } from '@spacemolt/lib'
import type { Profile } from '../src/shared/types'
import {
  isCommandForRole,
  PROMPT_ROLE_MARKERS,
  promptRoleMarkers,
  renderPromptForRole,
  resolveAgentRole,
} from '../src/server/lib/role'
import { LibV2Connection, formatLibCommandList } from '../src/server/lib/connections/lib_v2'

/**
 * Role-scoped prompt diet.
 *
 * prompt.md is fleet-wide doctrine — 48K chars, ~59% of it irrelevant to a solo
 * hunter and some of it contradicting his directive (a fleet fuel-reserve rule
 * cost Morg'Thar 9,500cr on 2026-09-01). Sections now carry
 * `<!-- role: all | default | hunter -->` markers; the `default` render is
 * pinned by hash so nobody changes what the parked fleet reads by accident, and
 * the `hunter` render must drop the trading/mining/commission doctrine while
 * keeping hunting, anti-idle and the game-technique sections. The lib command
 * list is scoped the same way.
 *
 * 2026-09-02 stale sweep: the Devastator and Caravan commissions are delivered
 * and every BoM lock was cleared on 2026-08-28, so BoM LOCK / NO BoM SALES became
 * COMMISSION LOCKS (default only), the shield_emitter standing blocker and the
 * "send_gift to Sapper" job line are gone, and the hunter render carries its own
 * Key Tips / NO-JETTISON / HUNTING / EQUIPMENT / SHIPS blocks.
 */

const REPO = path.resolve(import.meta.dir, '..')
const PROMPT_MD = fs.readFileSync(path.join(REPO, 'prompt.md'), 'utf-8')

// sha256 of the DEFAULT render of prompt.md as of the 2026-09-02 stale sweep.
// The default render must still hash to this. If you change the default text
// ON PURPOSE, refresh it with:
//   bun -e 'import fs from "node:fs"; import {createHash} from "node:crypto";
//     import {renderPromptForRole} from "./src/server/lib/role";
//     console.log(createHash("sha256").update(renderPromptForRole(fs.readFileSync("prompt.md","utf-8"),"default")).digest("hex"))'
const DEFAULT_PROMPT_SHA256 = 'e2b06f471886bb10f2ff970ab2d0179e08fc2e063b29425b91270bb67defff56'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

function profile(over: Partial<Profile> & { name: string }): Profile {
  return {
    id: 'p-role-test',
    username: 'tester',
    password: 'hex',
    empire: 'crimson',
    player_id: 'pid',
    provider: 'claude-max',
    model: 'claude-sonnet-4-5',
    planner_provider: null,
    planner_model: null,
    planning_interval: null,
    codex_executor_enabled: false,
    codex_executor_model: null,
    codex_planner_enabled: false,
    codex_planner_model: null,
    directive: '',
    todo: '',
    memory: '',
    context_budget: null,
    connection_mode: 'lib_v2',
    server_url: 'https://game.spacemolt.com',
    autoconnect: true,
    enabled: true,
    sort_order: 0,
    group_name: 'Stellar Alliance',
    created_at: '',
    updated_at: '',
    ...over,
  }
}

const MORG = profile({
  name: "Morg'Thar - Warrior",
  directive: "MORG'THAR — HUNTER'S ORDERS (Admiral, Sep 1 21:50 CT) — SUPERSEDES ALL PRIOR\n\nJOB: hunt the Outer Rim cluster for PAID contracts. You are a battlecruiser\nwith 7 guns and no mining laser. Never mine. Never craft.",
})
const NOVA = profile({
  name: 'Nova Reyes - Miner',
  directive: '<!--ADMIRAL-STANDING-->\n## NOVA — TITANIUM GIFT-TRIP — 2026-08-28 17:55 UTC — ONE JOB, THEN PARK',
})

describe('resolveAgentRole', () => {
  test("a warrior with hunter's orders is a hunter", () => {
    expect(resolveAgentRole(MORG)).toBe('hunter')
  })

  test('a miner, a trader and a hauler are default', () => {
    expect(resolveAgentRole(NOVA)).toBe('default')
    expect(resolveAgentRole(profile({ name: 'Cass Margin - Trader', directive: '## CASS — THE CARAVAN ERA' }))).toBe('default')
    expect(resolveAgentRole(profile({ name: 'Rook Vance - Hauler', directive: 'You are a courier-hauler' }))).toBe('default')
  })

  test('the directive HEAD decides — rules text deeper in the directive does not', () => {
    // "no pirate hunting" in the head is a non-combat signal even for a Warrior.
    expect(resolveAgentRole(profile({ name: 'Old Warrior', directive: 'STANDBY: stay docked, no pirate hunting' }))).toBe('default')
    // ...and a combat word 700 chars in does not make a trader a hunter.
    const deep = 'JOB: haul cobalt.\n' + 'x'.repeat(700) + '\nbounty hunter'
    expect(resolveAgentRole(profile({ name: 'Juno Freight - Trader', directive: deep }))).toBe('default')
  })

  test('name and group are fallbacks when the directive says nothing', () => {
    expect(resolveAgentRole(profile({ name: 'Zed Hunter', directive: '' }))).toBe('hunter')
    expect(resolveAgentRole(profile({ name: 'Zed', directive: '', group_name: 'Combat Wing' }))).toBe('hunter')
    expect(resolveAgentRole(profile({ name: 'Zed', directive: '', group_name: '' }))).toBe('default')
  })
})

describe('macro tools are advertised in the prompt', () => {
  // A macro the prompt never mentions does not get called. hunt_here shipped in
  // the tool list on 2026-09-02 but no prompt block named it, and Morg'Thar went
  // on hand-flying combat (and skipping it) until MACRO TOOLS listed it.
  for (const role of ['hunter', 'default'] as const) {
    test(`${role} render advertises hunt_here`, () => {
      const r = renderPromptForRole(PROMPT_MD, role)
      expect(r).toContain('hunt_here')
      expect(r).toContain('goto_system')
      expect(r).toContain('sell_cargo')
    })
  }
})

describe('prompt.md role rendering', () => {
  const DEFAULT = renderPromptForRole(PROMPT_MD, 'default')
  const HUNTER = renderPromptForRole(PROMPT_MD, 'hunter')

  test('every marker names a known role and every section has one', () => {
    const markers = promptRoleMarkers(PROMPT_MD)
    expect(markers.length).toBeGreaterThan(30)
    for (const m of markers) expect(PROMPT_ROLE_MARKERS.has(m)).toBe(true)
    // Every #/## heading is preceded by a marker line.
    const lines = PROMPT_MD.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (/^#{1,2} /.test(lines[i])) expect(lines[i - 1]).toMatch(/^<!-- role: (all|default|hunter) -->$/)
    }
  })

  test('the default render is pinned by hash', () => {
    expect(sha256(DEFAULT)).toBe(DEFAULT_PROMPT_SHA256)
  })

  test('provably stale content is gone from every render', () => {
    for (const r of [DEFAULT, HUNTER]) {
      // Devastator delivered 2026-08-29, BoM locks cleared 2026-08-28 (scripts/clear-devastator-bom.ts).
      expect(r).not.toContain('## BoM LOCK')
      expect(r).not.toContain('NO BoM SALES')
      expect(r).not.toContain('28-item Devastator lock list')
      // The shield_emitter blocker only ever gated a Devastator line.
      expect(r).not.toContain('shield_emitter')
      // The fleet funding sweep was retired 2026-08-28.
      expect(r).not.toContain('send_gift to Sapper')
      // The Caravan was delivered to Cass Margin.
      expect(r).not.toContain('is the long-term goal')
      expect(r).not.toContain('caravan-class hauler is the goal')
    }
    // The still-true facts were relocated, not lost: the harness lock mechanism and the HALT rule.
    expect(DEFAULT).toContain('## COMMISSION LOCKS')
    expect(DEFAULT).toContain('correct, not a bug')
    expect(DEFAULT).toContain('HALT: tempted to sell <item> x<qty>')
  })

  test('no render leaks markers or the MAPPING comment', () => {
    for (const r of [DEFAULT, HUNTER]) {
      expect(r).not.toContain('<!--')
      expect(r).not.toContain('-->')
      expect(r).not.toContain('MAPPING')
    }
  })

  test('a hunter does not receive the trading, mining or commission doctrine', () => {
    const excludedHeadings = [
      '## Getting Started', '## Empires', '## Security',
      '# INVIOLABLE — MONEY & MATERIAL', '## COMMISSION LOCKS', '## 💰 RESERVE DOCTRINE',
      '## 💼 PROCUREMENT CAPS', '## 🚨 BULK-BUY VERIFICATION', '## TRADING DISCIPLINE',
      '## HOW TO TRADE', '## MINING DISCIPLINE', '## RADIOACTIVE EXTRACTION GUARD',
      '## CRAFT JOB SAFETY', '## 🏛️ FACTION STORAGE', '## 📒 STORAGE LEDGER',
      '## ⛽ FUEL REQUESTS ARE PRE-APPROVED',
    ]
    for (const h of excludedHeadings) {
      expect(DEFAULT).toContain(h)
      expect(HUNTER).not.toContain(h)
    }
    // Body text of the excluded sections, not just their headings.
    for (const s of [
      'WALLET FLOOR of 25,000', 'THREE HARD CAPS', 'liquid_hydrogen is BANNED',
      'Register** with a unique username', 'NEVER send your SpaceMolt password',
      'mine(resource="tritium_ice")', 'craft(job_id=', 'Fleet Munitions Vault',
      '28-item Devastator lock list',
      // Residue that is not the hunter's mission: commission bookkeeping, the storage
      // ledger, mining ladders, crafting, the fleet-wide leviathan ban (his directive
      // holds a Leviathan Bounty), and "query constantly" (the briefing injects state).
      'BoM', 'Devastator', 'STORAGE LEDGER', 'mining_laser    I:5', 'CRAFT IT',
      'Do not hunt leviathans', 'use them constantly', 'Save early',
    ]) {
      expect(HUNTER).not.toContain(s)
    }
  })

  test('a hunter keeps hunting, anti-idle, equipment, ships, macros and reference sources', () => {
    const keptHeadings = [
      '## HUNTING DOCTRINE', '## 🔁 ANTI-IDLE DOCTRINE', '## 🚫 ANTI-CASCADE DOCTRINE',
      '## 🔍 VERIFICATION DOCTRINE', '## WHEN BLOCKED PROTOCOL', '## EQUIPMENT DOCTRINE',
      '## SHIPS — FLY THE RIGHT HULL', '## ⚙️ MACRO TOOLS', '## REFERENCE SOURCES',
      '## STOP MAKING THESE CALLS', '## 🗑️ NO-JETTISON RULE', '## Key Tips', '## Game Knowledge',
      '## COMMAND AUTHORITY',
    ]
    for (const h of keptHeadings) {
      expect(HUNTER).toContain(h)
      // ...exactly once: the compressed hunter block replaces the default one, never adds to it.
      expect(HUNTER.split(h).length - 1).toBe(1)
    }
    // The compressed authority block still carries the load-bearing rules.
    for (const s of ['Human Nudge', 'STATUS:', 'NEED:', 'DONE:', 'HALT:', 'SHIP SURVIVAL LAW', 'DO THE ORDER']) {
      expect(HUNTER).toContain(s)
    }
    // Anti-idle keeps its named-unblock rule and the suspension phrase.
    expect(HUNTER).toContain('NAMED unblock condition')
    expect(HUNTER).toContain('ADMIRAL SUSPENSION ACTIVE')
    // The macro text no longer cites a lock list, but still tells the agent to exclude what it keeps.
    expect(HUNTER).toContain('sell_cargo(exclude=[...])')
    expect(HUNTER).toContain('goto_system(target_system')
    // The hunter's own blocks keep the load-bearing technique and reconcile with his directive.
    expect(HUNTER).toContain('under a paid bounty contract you hold')
    expect(HUNTER).toContain('`scan` the creature first')
    expect(HUNTER).toContain('uninstall_mod every module worth keeping')
    expect(HUNTER).toContain('jettison is legal only if EVERY rung fails')
    expect(HUNTER).toContain('shield_booster I:25')
  })

  test('the hunter render is materially smaller', () => {
    expect(HUNTER.length).toBeLessThan(DEFAULT.length * 0.55)
  })

  test('a file with no markers renders unchanged for every role', () => {
    const plain = '# Title\n\nbody\n'
    expect(renderPromptForRole(plain, 'default')).toBe(plain)
    expect(renderPromptForRole(plain, 'hunter')).toBe(plain)
  })
})

describe('lib_v2 command list scoping', () => {
  const conn = new LibV2Connection('https://game.spacemolt.com')
  const DEFAULT = conn.getCommandList()
  const HUNTER = conn.getCommandList('hunter')
  const defaultLines = DEFAULT.split('\n')
  const hunterLines = HUNTER.split('\n')
  const has = (list: string[], name: string) => list.some((l) => l.startsWith(`- ${name}(`))

  test('the method delegates to the module-level formatter', () => {
    expect(conn.getCommandList('default')).toBe(DEFAULT)
    expect(formatLibCommandList('hunter')).toBe(HUNTER)
    expect(formatLibCommandList()).toBe(DEFAULT)
  })

  test('the hunter list drops exactly the excluded (tool, action) pairs', () => {
    const catalog = Object.values(ACTIONS).filter((d) => d.tool !== 'spacemolt_auth')
    const dropped = catalog.filter((d) => !isCommandForRole(d.tool, d.action, 'hunter')).length
    expect(dropped).toBeGreaterThanOrEqual(70)
    expect(hunterLines.length).toBe(defaultLines.length - dropped)
    // Every hunter line is a default line — scoping never invents a command.
    const defaultSet = new Set(defaultLines)
    for (const l of hunterLines) expect(defaultSet.has(l)).toBe(true)
  })

  test('mining, crafting, facility-build, commission and faction-admin families are gone', () => {
    for (const name of ['mine', 'craft', 'recycle', 'build', 'faction_build', 'job_add', 'ranch_status',
      'commission_ship', 'commission_quote', 'supply_commission', 'post_mission', 'declare_war', 'create_role']) {
      expect(has(defaultLines, name)).toBe(true)
      expect(has(hunterLines, name)).toBe(false)
    }
  })

  test('combat, navigation, market, mission, storage, salvage, insurance and chat survive', () => {
    for (const name of ['attack', 'hunt', 'scan', 'reload', 'engage', 'retreat', 'jump', 'travel', 'dock', 'refuel',
      'repair', 'view_market', 'sell', 'create_sell_order', 'accept_mission', 'get_missions', 'deposit', 'withdraw',
      'loot', 'wrecks', 'insure', 'policies', 'quote', 'chat', 'send_gift', 'switch_ship', 'browse_ships',
      'list', 'owned', 'faction_owned', 'buy_ship_license', 'deploy', 'get_guide', 'forum_list']) {
      expect(has(hunterLines, name)).toBe(true)
    }
  })

  test('reload advertises the ammo item id, for every role', () => {
    for (const list of [DEFAULT, HUNTER]) {
      expect(list).toContain('- reload(id: string, target: string) [action]')
      expect(list).toContain('reload(id, ammo_item_id)')
      expect(list).not.toContain('- reload(id: string, target?: string)')
    }
  })
})

// buildSystemPrompt lives in agent.ts, which pulls in db.ts — and db.ts resolves
// its path from process.cwd() at module load. Point cwd at a throwaway workspace
// (with a copy of prompt.md, which agent.ts also resolves from cwd) BEFORE the
// dynamic import, exactly as tests/briefing-weapon-loadout.test.ts does.
describe('buildSystemPrompt renders by role', () => {
  const cwd = process.cwd()
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-prompt-role-test-'))
  fs.copyFileSync(path.join(REPO, 'prompt.md'), path.join(workspace, 'prompt.md'))
  process.chdir(workspace)
  afterAll(() => {
    process.chdir(cwd)
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  const FULL_LIST = new LibV2Connection('https://game.spacemolt.com').getCommandList()

  test('a default profile gets the default prompt.md and the untouched command list', async () => {
    const { buildSystemPrompt } = await import('../src/server/lib/agent')
    const sys = buildSystemPrompt(NOVA, FULL_LIST)
    expect(sys).toContain(`## Game Knowledge\n${renderPromptForRole(PROMPT_MD, 'default')}\n`)
    expect(sys).toContain(FULL_LIST)
    expect(sys).toContain('## COMMISSION LOCKS')
  })

  test('a hunter profile gets the hunter prompt.md and the scoped command list', async () => {
    const { buildSystemPrompt } = await import('../src/server/lib/agent')
    const sys = buildSystemPrompt(MORG, FULL_LIST)
    expect(sys).toContain(`## Game Knowledge\n${renderPromptForRole(PROMPT_MD, 'hunter')}\n`)
    expect(sys).toContain(formatLibCommandList('hunter'))
    expect(sys).not.toContain('## COMMISSION LOCKS')
    expect(sys).not.toContain('\n- mine(')
    expect(sys).not.toContain('\n- craft(')
    expect(sys).toContain('\n- attack(')
    expect(sys).toContain('## HUNTING DOCTRINE')
    // Materially smaller than the same profile rendered as default.
    expect(sys.length).toBeLessThan(buildSystemPrompt(NOVA, FULL_LIST).length * 0.6)
  })
})
