import type { Profile } from '../../shared/types'

// The prompt diet is role-scoped: a hunter carries no mining, crafting, trading
// or bill-of-materials doctrine, and its command list drops the commands those
// doctrines govern. Everything keys off ONE resolver so prompt.md, the command
// list, the volatile block and the briefing agree on who the agent is. Only
// `hunter` is distinguished today; every other agent is `default` and renders
// exactly what it rendered before the diet.
//
// Detection reads the TOP of the directive (the current-objective block) plus
// the profile name and group. Matching the whole directive misfired once: rules
// text like "no pirate hunting" classified every agent as combat.
export type AgentRole = 'hunter' | 'default'

/** Every role a prompt.md marker may name. `all` is a marker value, not a role. */
export const PROMPT_ROLE_MARKERS: ReadonlySet<string> = new Set(['all', 'hunter', 'default'])

const NON_COMBAT_HEAD_RX = /standby|stay docked|crafter|coordinator|verify-only|miner|prospector|no (pirate )?hunt/i
/** The job label in the profile NAME ("Zibal Prospector", "Grit Vane - Miner")
 *  is the operator's own classification and beats a combat word in the
 *  directive head: Zibal's head reads "EXPLORER & HUNTER" but he mines. */
const NON_COMBAT_NAME_RX = /prospector|miner|hauler|trader|smuggler|crafter|courier/i
const COMBAT_HEAD_RX = /combat specialist|bounty.?hunt|\bhunter\b|warrior/i
const COMBAT_NAME_RX = /warrior|hunter/i
const COMBAT_GROUP_RX = /combat|hunt(er|ing)?|warrior/i

export function resolveAgentRole(profile: Pick<Profile, 'name' | 'directive'> & { group_name?: string | null }): AgentRole {
  const head = (profile.directive || '').slice(0, 600)
  if (NON_COMBAT_HEAD_RX.test(head)) return 'default'
  if (NON_COMBAT_NAME_RX.test(profile.name || '')) return 'default'
  if (COMBAT_HEAD_RX.test(head) || COMBAT_NAME_RX.test(profile.name || '') || COMBAT_GROUP_RX.test(profile.group_name || '')) {
    return 'hunter'
  }
  return 'default'
}

// ---------------------------------------------------------------------------
// prompt.md role markers
//
// prompt.md is one file for every role. Each section is preceded by an HTML
// comment marker — `<!-- role: all -->`, `<!-- role: default -->` or
// `<!-- role: hunter -->` — and runs until the next marker. Rendering for a
// role keeps `all` blocks plus the blocks for that role, drops the marker
// lines themselves, and drops any other HTML comment (the MAPPING note at the
// top of the file). A file with no markers renders unchanged for every role,
// and the `default` render is byte-identical to the file with the comments
// removed — tests/prompt-role.test.ts pins that with a hash.
// ---------------------------------------------------------------------------

const ROLE_MARKER_RX = /^[ \t]*<!--\s*role:\s*([a-z_]+)\s*-->[ \t]*$/
const COMMENT_OPEN_RX = /^[ \t]*<!--/
const COMMENT_ONE_LINE_RX = /^[ \t]*<!--.*-->[ \t]*$/

/** Every role name used by a `<!-- role: X -->` marker, in file order (duplicates kept). */
export function promptRoleMarkers(md: string): string[] {
  const out: string[] = []
  for (const line of md.split('\n')) {
    const m = ROLE_MARKER_RX.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

/** Render prompt.md for one role: `all` blocks + that role's blocks, comments stripped. */
export function renderPromptForRole(md: string, role: AgentRole): string {
  const out: string[] = []
  let current = 'all'
  let inComment = false
  for (const line of md.split('\n')) {
    if (inComment) {
      if (line.includes('-->')) inComment = false
      continue
    }
    const marker = ROLE_MARKER_RX.exec(line)
    if (marker) {
      current = marker[1]
      continue
    }
    if (COMMENT_ONE_LINE_RX.test(line)) continue
    if (COMMENT_OPEN_RX.test(line)) {
      inComment = true
      continue
    }
    if (current === 'all' || current === role) out.push(line)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Command list scoping
//
// (tool, action) pairs from @spacemolt/lib's ACTIONS catalog. Names alone are
// ambiguous — `repair` is both a ship command and a facility command, `list`
// exists in five groups — so the predicate takes the tool group too.
//
// A hunter keeps every combat, navigation, market, mission, storage, salvage,
// insurance, shipping, passenger, drone, intel, citizenship, transfer and
// social command. It drops:
//   mining / crafting / refining   mine, craft, recycle, facility job_* queues
//   facility build + management    everything under spacemolt_facility except
//                                  the reads list/owned/faction_list/faction_owned
//                                  and buy_ship_license (a ship purchase step)
//   ship commissions               commission_quote/ship/status, cancel/supply_commission
//   faction administration         spacemolt_faction_admin, spacemolt_faction_commerce,
//                                  and the faction diplomacy/membership mutations
// ---------------------------------------------------------------------------

const HUNTER_DROP_SPACEMOLT = new Set(['mine', 'craft', 'recycle'])
const HUNTER_KEEP_FACILITY = new Set(['list', 'owned', 'faction_list', 'faction_owned', 'buy_ship_license'])
const HUNTER_DROP_FACTION = new Set([
  'create', 'declare_war', 'propose_ally', 'accept_ally', 'remove_ally', 'propose_peace', 'accept_peace',
  'set_enemy', 'remove_enemy', 'invite', 'withdraw_invite', 'kick', 'leave', 'join',
  'delete_role', 'delete_room', 'cancel_mission', 'prepay_tax',
])

/** Whether a lib command (tool group + action) is advertised to an agent of this role. */
export function isCommandForRole(tool: string, action: string, role: AgentRole): boolean {
  if (role !== 'hunter') return true
  switch (tool) {
    case 'spacemolt': return !HUNTER_DROP_SPACEMOLT.has(action)
    case 'spacemolt_facility': return HUNTER_KEEP_FACILITY.has(action)
    case 'spacemolt_ship': return !action.includes('commission')
    case 'spacemolt_faction': return !HUNTER_DROP_FACTION.has(action)
    case 'spacemolt_faction_admin': return false
    case 'spacemolt_faction_commerce': return false
    default: return true
  }
}
