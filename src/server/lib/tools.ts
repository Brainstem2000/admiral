import { Type, StringEnum } from '@mariozechner/pi-ai'
import type { Tool } from '@mariozechner/pi-ai'
import type { GameConnection } from './connections/interface'
import { updateProfile, createFleetOrder, getFleetOrders, getFleetOrdersByChain, updateFleetOrder, listProfiles, getPreference, getSellQuota, decrementSellQuota, recordStorageSnapshot, recordCargoSnapshot, clearStorageDirty, setCommissionRequirements, getCommissionRequirement, getStorageQuantity, getStorageElsewhere, getMostRecentStation, getStorageTotalForProfile, replaceInsurancePolicies, replaceShipsForProfile, recordShipModules, upsertFreightContracts, recordEmpirePolicy, recordSystemLinks, getKnownLinks, assessSystemDanger, getFreshMarketDepth, getCargoQuantity, getRecentBuyUnitPrice, bookOrderFillsFromView, closeOrderOnCancel, getProfileLastState, getNavIntel, getDb, getProfile, FORBIDDEN_SYSTEMS } from './db'
import { FleetIntelCollector } from './fleet-intel'
import { LedgerCollector } from './ledger'
import { agentManager } from './agent-manager'
import { invalidateBriefingCache, collectTargets } from './briefing'
import { resolveAgentRole } from './role'
import { safeTruncate } from './text-safe'
import { codexLookup, codexChain, priceAdvisory, codexGet } from './catalog'

// Extended query result cache: keyed by "profileId:command:argsJSON"
const queryCache = new Map<string, { result: string; timestamp: number }>()
const marketNoSupply = new Map<string, Array<{ itemId: string; baseId: string; timestamp: number }>>()
const MARKET_DEAD_END_WINDOW_MS = 15 * 60_000

export interface MarketPurchaseVerdict {
  itemId: string
  baseId: string
  unavailable: boolean
  message: string
}

/** Turn adversarial order-book fields into an explicit purchase decision. */
export function buildMarketPurchaseVerdict(
  resultData: unknown,
  commandArgs: Record<string, unknown> | undefined,
): MarketPurchaseVerdict | null {
  const itemId = String(commandArgs?.item_id ?? commandArgs?.item ?? '').toLowerCase()
  if (!itemId || !resultData || typeof resultData !== 'object') return null
  const data = resultData as Record<string, unknown>
  const baseId = String(data.base_id ?? data.station_id ?? data.base ?? 'this station')
  const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>>
    : Array.isArray(data.market) ? data.market as Array<Record<string, unknown>> : []
  const item = items.find(i => String(i.item_id ?? i.id ?? '').toLowerCase() === itemId)
  if (!item) {
    return {
      itemId, baseId, unavailable: true,
      message: `PURCHASE VERDICT — ${itemId} is NOT FOR SALE at ${baseId}: no matching orders. Do not repeat this market query; record the sourcing blocker and continue the higher-level objective.`,
    }
  }
  const asks = Array.isArray(item.sell_orders) ? item.sell_orders : []
  const ask = Number(item.best_sell ?? item.sell_price ?? 0) || 0
  const askQty = Number(item.best_sell_qty ?? item.sell_quantity ?? 0) || 0
  if (asks.length === 0 || ask <= 0 || askQty <= 0) {
    const bid = Number(item.best_buy ?? item.buy_price ?? 0) || 0
    const bidOnly = bid > 0
    return {
      itemId, baseId, unavailable: true,
      message: bidOnly
        ? `PURCHASE VERDICT — BID ONLY at ${baseId}: the station will PAY YOU ${bid}cr for ${itemId}; it has none for sale. You cannot buy here. Do not repeat this query or attempt buy.`
        : `PURCHASE VERDICT — ${itemId} is NOT FOR SALE at ${baseId}: there is no ASK/sell depth. Do not repeat this query or attempt buy.`,
    }
  }
  return {
    itemId, baseId, unavailable: false,
    message: `PURCHASE VERDICT — AVAILABLE at ${baseId}: ASK ${ask}cr, sell depth ${askQty}. This is what you pay to buy.`,
  }
}

/** Return a deterministic no-op when reload would consume cargo for no benefit. */
export function fullWeaponReloadVerdict(
  shipData: unknown,
  commandArgs: Record<string, unknown> | undefined,
): string | null {
  if (!shipData || typeof shipData !== 'object') return null
  const data = shipData as Record<string, unknown>
  const modules = Array.isArray(data.modules) ? data.modules as Array<Record<string, unknown>>
    : Array.isArray((data.ship as Record<string, unknown> | undefined)?.modules)
      ? (data.ship as Record<string, unknown>).modules as Array<Record<string, unknown>> : []
  const targetId = String(
    commandArgs?.weapon_instance_id ?? commandArgs?.weapon_id ?? commandArgs?.module_id ?? commandArgs?.id ?? '',
  )
  if (!targetId) return null
  const weapon = modules.find(m => String(m.module_id ?? m.instance_id ?? m.id ?? '') === targetId)
  if (!weapon) return null
  const current = Number(weapon.current_ammo ?? weapon.ammo ?? NaN)
  const capacity = Number(weapon.magazine_size ?? weapon.max_ammo ?? NaN)
  if (!Number.isFinite(current) || !Number.isFinite(capacity) || capacity <= 0 || current < capacity - 1) return null
  const name = String(weapon.name ?? weapon.type_id ?? 'weapon')
  return `NO-OP: ${name} (${targetId}) is already combat-ready at ${current}/${capacity}. Reload was not sent and no cargo ammo was consumed. Continue the mission; do not shop for ammo or retry reload for this weapon.`
}

// --- Tool Definitions ---

export const allTools: Tool[] = [
  {
    name: 'game',
    description: 'Execute a SpaceMolt game command. See the system prompt for available commands. Queries read only your current location; get_system/get_poi/view_market/get_missions take no system or station argument.',
    parameters: Type.Object({
      command: Type.String({ description: 'The game command name (e.g. mine, travel, get_status)' }),
      args: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: 'Command arguments as key-value pairs' })),
    }),
  },
  {
    name: 'mine_until_full',
    description: 'MACRO: mine repeatedly until the cargo hold is full (or the resource depletes). Runs as one bounded code loop — vastly cheaper than calling mine one turn at a time. Requires being at a mineable POI. Returns how much was mined and why it stopped.',
    parameters: Type.Object({
      max_mines: Type.Optional(Type.Number({ description: 'Max mine actions before stopping (default 30, cap 60)' })),
      stop_at_pct: Type.Optional(Type.Number({ description: 'Stop when cargo reaches this % full (default 100)' })),
    }),
  },
  {
    name: 'goto_system',
    description: 'MACRO: plot a route with find_route and jump every hop to the target system in one bounded code loop — instead of one jump per turn. Optionally docks at a POI on arrival. Verifies fuel first. Returns arrival status, hops taken, fuel remaining.',
    parameters: Type.Object({
      target_system: Type.String({ description: 'Destination system id (snake_case, e.g. "iron_reach")' }),
      dock_at_poi: Type.Optional(Type.String({ description: 'POI id to travel to and dock at after arriving (e.g. "war_citadel")' })),
    }),
  },
  {
    name: 'hunt_here',
    description: 'MACRO: hunt everything beatable at your CURRENT POI in one bounded code loop — scan, pick a target, attack, close range, kill it, loot the wreck, repeat. Skips empire NPCs and police, skips anything tougher than your hull allows, and breaks off if your hull drops below the floor. Use this instead of attack/advance/loot by hand. Returns kills, loot and why it stopped.',
    parameters: Type.Object({
      poi: Type.Optional(Type.String({ description: 'POI id to hunt at (e.g. "krynn_asteroid_belt"). The macro undocks and travels there first. Omit to hunt where you already are.' })),
      max_kills: Type.Optional(Type.Number({ description: 'Stop after this many kills (default 3, max 8)' })),
      hull_floor_pct: Type.Optional(Type.Number({ description: 'Break off and stop hunting below this hull percentage (default 60)' })),
      species: Type.Optional(Type.String({ description: 'Only hunt this species/name (e.g. "belt_grazer" for a Grazer Cull contract). Omit to hunt anything beatable.' })),
    }),
  },
  {
    name: 'sell_cargo',
    description: 'MACRO: sell every cargo item at the current docked station in one bounded code loop (skips items you list in exclude). Items with no buyers are reported, not errors. Returns per-item results and total credits gained. You MUST pass exclude for anything your directive forbids selling (e.g. BoM-locked items).',
    parameters: Type.Object({
      exclude: Type.Optional(Type.Array(Type.String(), { description: 'item_ids to NOT sell (BoM-locked / mission cargo)' })),
    }),
  },
  {
    name: 'save_credentials',
    description: 'Save your login credentials locally. Do this IMMEDIATELY after registering!',
    parameters: Type.Object({
      username: Type.String({ description: 'Your username' }),
      password: Type.String({ description: 'Your password (256-bit hex)' }),
      empire: Type.String({ description: 'Your empire' }),
      player_id: Type.String({ description: 'Your player ID' }),
    }),
  },
  {
    name: 'update_todo',
    description: 'Update your local TODO list to track goals and progress.',
    parameters: Type.Object({
      content: Type.String({ description: 'Full TODO list content (replaces existing)' }),
    }),
  },
  {
    name: 'read_todo',
    description: 'Read your current TODO list.',
    parameters: Type.Object({}),
  },
  {
    name: 'read_memory',
    description: 'Read your persistent memory - accumulated knowledge, routes, market intel, storage inventories, lessons learned, strategic plans. Persists across all sessions.',
    parameters: Type.Object({}),
  },
  {
    name: 'fleet_route',
    description: "Route estimate between ANY two systems from the fleet's learned jump graph (every route any agent has ever flown) — no game tick, works without being at either end, and AVOIDS forbidden systems (goldcrest, bluerift) automatically, which the game's find_route will not do. Distances are upper bounds that improve as the fleet flies; before committing to a trip, confirm with a live find_route from your position.",
    parameters: Type.Object({
      from: Type.String({ description: 'Origin system_id (e.g. krynn)' }),
      to: Type.String({ description: 'Destination system_id (e.g. haven)' }),
    }),
  },
  {
    name: 'update_memory',
    description: 'Update your persistent memory. Save important discoveries, routes, market intel, storage inventories, combat data, lessons. Replaces entire memory - include everything you want to keep.',
    parameters: Type.Object({
      content: Type.String({ description: 'Full memory content (replaces existing). Use markdown.' }),
    }),
  },
  {
    name: 'status_log',
    description: 'Log a status message visible to the human watching.',
    parameters: Type.Object({
      category: StringEnum(['mining', 'travel', 'combat', 'trade', 'chat', 'info', 'craft', 'faction', 'mission', 'setup'], {
        description: 'Message category',
      }),
      message: Type.String({ description: 'Status message' }),
    }),
  },
  {
    name: 'fleet_order',
    description: 'Send an order to another fleet agent. Use this to delegate tasks like delivery, crafting, or buying. The target agent will see the order in their next turn. Use chain_id + next_orders to create dependency chains that auto-trigger on completion.',
    parameters: Type.Object({
      target_agent: Type.String({ description: 'Name of the target agent (e.g. "Bob Comet", "CyberSapper")' }),
      type: StringEnum(['deliver', 'buy', 'sell', 'craft', 'travel', 'mine', 'custom'], {
        description: 'Order type',
      }),
      description: Type.String({ description: 'What the target should do. Be specific: item, quantity, destination.' }),
      params: Type.Optional(Type.String({ description: 'JSON params (item_id, quantity, destination, etc.)' })),
      chain_id: Type.Optional(Type.String({ description: 'Chain name to group related orders (e.g. "iron-pipeline"). Orders in the same chain are tracked together.' })),
      next_orders: Type.Optional(Type.String({ description: 'JSON array of follow-up orders to auto-create when THIS order completes. Format: [{"target_agent":"Bob","type":"deliver","description":"Haul ore to hub"}]. Supports nesting.' })),
    }),
  },
  {
    name: 'read_fleet_orders',
    description: 'Read orders assigned to you by other fleet agents, and orders you have issued. Update order status when completing tasks. Use action="chain" to view all orders in a dependency chain.',
    parameters: Type.Object({
      action: StringEnum(['inbox', 'sent', 'accept', 'complete', 'reject', 'chain'], {
        description: 'inbox = orders for you, sent = orders you issued, accept/complete/reject = update order status, chain = view all orders in a chain',
      }),
      order_id: Type.Optional(Type.String({ description: 'Order ID (required for accept/complete/reject)' })),
      chain_id: Type.Optional(Type.String({ description: 'Chain ID (required for action=chain)' })),
      progress: Type.Optional(Type.String({ description: 'Progress note when accepting or completing' })),
    }),
  },
  {
    name: 'codex',
    description: 'FREE local lookup in the official game codex (items, recipes, ships, facilities, skills) — no game tick, no network. Returns stats, base_value, recipe inputs/outputs, ship/facility build materials. ALWAYS prefer this over in-game catalog/types/dry-run discovery calls.',
    parameters: Type.Object({
      query: Type.String({ description: 'id or name (fuzzy) to look up, e.g. "shield_emitter" or "Devastator"' }),
      kind: Type.Optional(StringEnum(['item', 'recipe', 'ship', 'facility', 'skill'], {
        description: 'Restrict to one kind (default: search all kinds)',
      })),
    }),
  },
  {
    name: 'codex_chain',
    description: 'FREE local crafting-chain analysis: the full recursive input tree to craft an item, with aggregate raw-material totals and base-value cost estimate. Use before committing to any crafting or sourcing plan.',
    parameters: Type.Object({
      item_id: Type.String({ description: 'Exact item id to analyze (use codex() first if unsure)' }),
      quantity: Type.Optional(Type.Number({ description: 'How many to craft (default 1)' })),
    }),
  },
]

const LOCAL_TOOLS = new Set(['save_credentials', 'update_todo', 'read_todo', 'update_memory', 'read_memory', 'status_log', 'fleet_order', 'read_fleet_orders', 'codex', 'codex_chain', 'fleet_route'])

/**
 * Extract jump-graph edges from any game result and bank them. Two shapes exist in the
 * wild and they are NOT co-located: jump/travel results carry `system_id` in `details`
 * while the arrival's `connections` array sits under `location` — so same-node pairing
 * alone never matched (the original sniffer's bug; its unit test fixture was built with
 * the wrong shape and passed anyway). Contextual rule: pair same-node when possible,
 * otherwise pair a connections array with the result's system_id ONLY when exactly one
 * distinct system_id appears in the whole payload — never guess between two systems.
 */
export function captureSystemLinks(resultData: unknown, source: string): void {
  try {
    const pairs: Array<[string, string]> = []
    const sysIds = new Set<string>()
    const orphanConnections: string[][] = []
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return
      const o = node as Record<string, unknown>
      // Owner id: jump/location shapes use system_id; get_system's system node uses bare
      // `id` — accept it only when connections are co-located, so POI/ship ids never pair.
      const sys = typeof o.system_id === 'string' ? o.system_id
        : (typeof o.id === 'string' && Array.isArray(o.connections)) ? o.id : undefined
      if (typeof o.system_id === 'string') sysIds.add(o.system_id.toLowerCase())
      if (Array.isArray(o.connections)) {
        // Two wire shapes: plain strings (jump/location) or {system_id, name, distance}
        // objects (get_system). Object entries' ids must NOT feed the orphan-candidate
        // set — they are neighbors, not context.
        const conns = o.connections
          .map((c) => typeof c === 'string' ? c
            : (c && typeof c === 'object' && typeof (c as Record<string, unknown>).system_id === 'string')
              ? String((c as Record<string, unknown>).system_id) : null)
          .filter((c): c is string => !!c)
        for (const c of conns) sysIds.delete(c.toLowerCase())
        if (sys) for (const c of conns) pairs.push([sys, c])
        else if (conns.length) orphanConnections.push(conns)
      }
      if (Array.isArray(o.route)) {
        const ids = (o.route as Array<Record<string, unknown>>)
          .map((h) => (typeof h?.system_id === 'string' ? h.system_id : null))
        for (let i = 1; i < ids.length; i++) if (ids[i - 1] && ids[i]) pairs.push([ids[i - 1]!, ids[i]!])
      }
      for (const v of Object.values(o)) walk(v)
    }
    walk(resultData)
    if (orphanConnections.length && sysIds.size === 1) {
      const sys = [...sysIds][0]
      for (const conns of orphanConnections) for (const c of conns) pairs.push([sys, c])
    }
    if (pairs.length) recordSystemLinks(pairs, source)
  } catch { /* capture must never break execution */ }
}
// Macro tools: bounded code loops over game commands — one LLM call replaces
// dozens of per-step calls. They pace themselves (lib_v2 mutations await the
// tick; other modes sleep between steps), so they bypass the single-action
// cooldown gate and re-arm it when they finish.
const MACRO_TOOLS = new Set(['mine_until_full', 'goto_system', 'sell_cargo', 'hunt_here'])

export function isMacroTool(name: string): boolean {
  return MACRO_TOOLS.has(name)
}

const MAX_RESULT_CHARS = 4000

// Cooldown tracking for action commands to prevent spam loops (e.g. mine → "Action pending" → mine → ...)
// Maps profileId → last action timestamp + whether it was pending
const actionCooldowns = new Map<string, { timestamp: number; wasPending: boolean }>()
const COOLDOWN_AFTER_SUCCESS = 4000   // 4s between actions when last succeeded (allows fast successive actions)
const COOLDOWN_AFTER_PENDING = 10000  // 10s when last action was pending (match game tick cadence)
// Residual cooldowns at or below this are absorbed at execution time — sleep them off and run the
// command — instead of surfacing the block. Surfacing ends the turn, and the agent's next LLM call
// exists only to reissue the same command a few seconds later (observed on every freight-circuit
// station stop: dock arms the gate, the first shipping_list eats the block). Post-success residuals
// (≤4s) always qualify; the post-pending 10s pacing still surfaces unless most of it has already
// elapsed. Doubles as the hard cap on how long the executor will ever sleep.
const COOLDOWN_ABSORB_MAX_MS = 5000

// Remaining cooldown before this profile's next action command, or null if clear to act.
function actionCooldownRemaining(profileId: string): number | null {
  const lastAction = actionCooldowns.get(profileId)
  if (!lastAction) return null
  const cooldownMs = lastAction.wasPending ? COOLDOWN_AFTER_PENDING : COOLDOWN_AFTER_SUCCESS
  const remainingMs = cooldownMs - (Date.now() - lastAction.timestamp)
  return remainingMs > 0 ? remainingMs : null
}

// Identical-failure loop breaker. Agents across model families get stuck reissuing the SAME
// failing call (same command, same args, same error) because an unchanged context deterministically
// reproduces the same output — observed: muse-v2 fb7eb134 lookups (2026-08-26), muse-v3 jumping to
// "alnita" 6+ times (2026-08-27, needed a manual nudge). Directive prose ("same command fails
// twice → STOP") does not break it; only changing the context does. So on the Nth identical
// failure inside the window we append a loud LOOP BREAK block to the error — the distinctive text
// itself perturbs the context enough that the next completion is no longer a replay.
// Maps profileId → recent failure fingerprints (command + canonical args + error code).
const recentFailures = new Map<string, Array<{ key: string; timestamp: number }>>()
// Fuel-floor checkpoint state: last blocked jump per profile (see fuel floor guard).
const fuelFloorBlocks = new Map<string, { dest: string; at: number }>()
/** Stations that refused docking on reputation, per profile. Reputation
 *  recovers slowly if at all, so a refusal is treated as sticky for a while
 *  rather than re-tested every few minutes.
 *
 *  SCOPED to the refusing system (keyed on location.system_id, never the
 *  display name). The first version of this gate was one flag per profile and
 *  blocked docking EVERYWHERE for an hour after a single refusal — a hunter
 *  refused at Voss Redoubt could not dock at his own home citadel either. A
 *  refusal is evidence about one station's faction, not about the galaxy. */
interface ReputationLockout { systemId: string | null; label: string; rep: string | null; at: number }
const reputationLockouts = new Map<string, ReputationLockout[]>()
const REPUTATION_LOCKOUT_MS = 60 * 60_000

/** Record a docking refusal so the dock gate can stop the repeat trip to THAT system. */
export function noteReputationRefusal(
  profileId: string,
  resultText: string,
  where: { systemId: string | null; label: string },
): void {
  if (!/insufficient_reputation/i.test(resultText)) return
  const m = /current:\s*(-?\d+)/i.exec(resultText)
  const systemId = where.systemId ? normalizeSystemId(where.systemId) : null
  const now = Date.now()
  const list = (reputationLockouts.get(profileId) ?? [])
    .filter((l) => now - l.at < REPUTATION_LOCKOUT_MS && !(systemId && l.systemId === systemId))
  list.push({ systemId, label: where.label, rep: m ? m[1] : null, at: now })
  reputationLockouts.set(profileId, list)
}

/** The live lockout for one system, if the station there refused this profile recently. */
function reputationLockoutFor(profileId: string, systemId: string | null): ReputationLockout | null {
  if (!systemId) return null
  const id = normalizeSystemId(systemId)
  const now = Date.now()
  return (reputationLockouts.get(profileId) ?? [])
    .find((l) => l.systemId === id && now - l.at < REPUTATION_LOCKOUT_MS) ?? null
}

/** Systems where a station refused this profile on reputation inside the
 *  lockout window — so the hunting briefing can leave them out. */
export function reputationLockedSystemIds(profileId: string): string[] {
  const now = Date.now()
  return (reputationLockouts.get(profileId) ?? [])
    .filter((l) => !!l.systemId && now - l.at < REPUTATION_LOCKOUT_MS)
    .map((l) => l.systemId as string)
}
const FAILURE_LOOP_WINDOW_MS = 5 * 60_000
const FAILURE_LOOP_THRESHOLD = 3   // fire on the 3rd identical failure
const FAILURE_LOOP_KEEP = 20       // per-profile history cap — this is a breaker, not a log

// Escalation past note injection. A deterministic local model (v3, greedy
// sampling) replays an unchanged context byte-for-byte, so the injected LOOP
// BREAK / QUERY LOOP notes provably get ignored (Bob: get_missions 11x on
// 2026-08-27, straight through the note). The only cure that has worked every
// time is a context flush — what a manual disconnect+connect_llm does. These
// thresholds trigger that flush automatically: ~3 more identical calls AFTER
// the note means the note failed, stop nudging and reboot the conversation.
const FAILURE_LOOP_FLUSH_THRESHOLD = 6
const QUERY_LOOP_FLUSH_THRESHOLD = 7
const contextFlushRequests = new Set<string>()
// Prefix on the escalated tool result — loop.ts ends the turn on it instead of
// letting the model burn its remaining rounds against a context about to be wiped.
export const LOOP_FLUSH_SENTINEL = '🔁 LOOP ESCALATION: '
/** True once per request: the agent loop consumes this and flushes its conversation context. */
export function consumeContextFlushRequest(profileId: string): boolean {
  if (!contextFlushRequests.has(profileId)) return false
  contextFlushRequests.delete(profileId)
  marketNoSupply.delete(profileId)
  return true
}

// JSON with object keys sorted at every depth, so key order cannot split a fingerprint.
// (JSON.stringify's replacer-array form is NOT usable here — it filters nested keys.)
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

// Record one failed game command and return how many identical failures (same command, same
// args, same error code) this profile has produced inside the window, including this one.
// The v2 API exposes the same query in two spellings: a grouped command name
// (`facility_owned`) and a group command carrying the action as an argument
// (`facility` + {action:'owned'}). They are the same question and return the
// same answer, but keyed literally they look like different calls — so the
// query cache misses and, worse, the loop breakers never see a repeat.
//
// Morg'Thar 2026-09-01 asked "what facilities do I own" 22 times across four
// spellings (facility_owned, facility{action:owned}, facility_list,
// facility{action:list}) while the game answered `facilities: []` every time.
// The identical-call breaker counted them as four different questions and did
// not fire until a fifth exact repeat happened to line up.
//
// Fold the action-argument form into the underscore form for KEYING ONLY. The
// command actually sent to the game is untouched.
function canonicalKey(command: string, args: Record<string, unknown> | undefined): string {
  let name = command.replace(/^spacemolt_/, '')
  const rest = { ...(args ?? {}) }
  const action = rest.action
  if (typeof action === 'string' && action && !name.endsWith(`_${action}`)) {
    name = `${name}_${action}`
    delete rest.action
  }
  // Drop the v2 tool-group prefix last, so `facility` + action:'owned' and
  // `facility_owned` both reduce to the same bare name.
  name = name.replace(/^(?:market|storage|social|intel|faction|faction_admin|salvage|catalog|ship|battle|transfer|facility|auth)_/, '')
  return `${name}|${stableStringify(rest)}`
}

function recordFailureAndCountRepeats(
  profileId: string,
  command: string,
  commandArgs: Record<string, unknown> | undefined,
  errorCode: string,
): number {
  const key = `${canonicalKey(command, commandArgs)}|${errorCode}`
  const now = Date.now()
  const list = (recentFailures.get(profileId) ?? []).filter((f) => now - f.timestamp < FAILURE_LOOP_WINDOW_MS)
  list.push({ key, timestamp: now })
  if (list.length > FAILURE_LOOP_KEEP) list.splice(0, list.length - FAILURE_LOOP_KEEP)
  recentFailures.set(profileId, list)
  return list.filter((f) => f.key === key).length
}

// Track when memory is updated so system prompt caching can skip rebuilds
export const memoryDirtyFlags = new Map<string, boolean>()

/**
 * Drop all per-profile state held in module-level maps when an agent stops.
 * Without this these maps only ever grow, leaking memory across the lifetime of
 * the process as profiles connect/disconnect.
 */
export function cleanupProfileToolState(profileId: string): void {
  actionCooldowns.delete(profileId)
  memoryDirtyFlags.delete(profileId)
  recentFailures.delete(profileId)
  contextFlushRequests.delete(profileId)
  fuelFloorBlocks.delete(profileId)
  reputationLockouts.delete(profileId)
  lastDestinations.delete(profileId)
  tactical.delete(profileId)
  const prefix = `${profileId}:`
  for (const key of queryCache.keys()) {
    if (key.startsWith(prefix)) queryCache.delete(key)
  }
}

// ─── Tactical state: what the tool layer itself has observed ──────────────
//
// Several gates below need to know where the agent is standing, whether it is
// docked, what threatens it and what the local order book looked like a
// minute ago. lib_v2 keeps an authoritative state cache (getLocalState) for
// the first two; the rest is only ever visible as results pass through this
// file. This is the per-profile scratch memory those gates read. It is
// observation, never a source of truth over a live answer from the game.

const GROUP_PREFIX_RX = /^(?:market|storage|social|intel|faction|faction_admin|faction_commerce|salvage|catalog|ship|battle|transfer|facility|auth|shipping|fleet|drone|citizenship)_/

/** v2 tool groups whose group form (`facility` + {action}) has no lib_v2 route. */
const V2_GROUPS = new Set(['market', 'storage', 'social', 'intel', 'faction', 'faction_admin', 'faction_commerce', 'salvage', 'catalog', 'ship', 'battle', 'transfer', 'facility', 'shipping', 'fleet', 'drone', 'citizenship'])

function normalizeSystemId(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, '_')
}

interface MarketSnapshot {
  stationId: string
  /** true when the read was the whole board (no item/category filter), so an absent item means "no order". */
  full: boolean
  at: number
  items: Map<string, { ask: number | null; askQty: number | null; bid: number | null; bidQty: number | null }>
}

interface SystemSnapshot {
  systemId: string
  systemName: string
  at: number
  pois: Array<{ id: string; name: string; type: string; has_base: boolean; base_id?: string; base_name?: string }>
}

interface TacticalState {
  systemId: string | null
  systemName: string | null
  poiId: string | null
  /** undefined = never observed; null = observed undocked. */
  dockedAt: string | null | undefined
  /** When a result last carried a location block — freshness relative to lastMovementAt. */
  locationAt: number
  /** Last movement command this profile dispatched through the tool layer. */
  lastMovementAt: number
  hull: number | null
  hullDropAt: number
  pirates: number
  piratesAt: number
  lastBattleAt: number
  repByEmpire: Record<string, number> | null
  localEmpire: string | null
  system: SystemSnapshot | null
  market: MarketSnapshot | null
}

const tactical = new Map<string, TacticalState>()

function tacticalFor(profileId: string): TacticalState {
  let t = tactical.get(profileId)
  if (!t) {
    t = {
      systemId: null, systemName: null, poiId: null, dockedAt: undefined, locationAt: 0, lastMovementAt: 0,
      hull: null, hullDropAt: 0, pirates: 0, piratesAt: 0, lastBattleAt: 0, repByEmpire: null, localEmpire: null,
      system: null, market: null,
    }
    tactical.set(profileId, t)
  }
  return t
}

const MOVEMENT_COMMANDS = new Set(['jump', 'travel', 'dock', 'undock'])
const THREAT_MEMORY_MS = 10 * 60_000
const BATTLE_RECENT_MS = 2 * 60_000
const MARKET_SNAPSHOT_MAX_AGE_MS = 10 * 60_000

function noteHull(t: TacticalState, hull: number, now: number): void {
  if (t.hull !== null && hull < t.hull) t.hullDropAt = now
  t.hull = hull
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/** Note that a movement command went out, so a cached location older than it is suspect. */
function noteMovement(profileId: string, command: string): void {
  const deep = command.replace(/^spacemolt_/, '').replace(GROUP_PREFIX_RX, '')
  if (MOVEMENT_COMMANDS.has(deep)) tacticalFor(profileId).lastMovementAt = Date.now()
}

/**
 * Bank whatever a game result reveals about position, docking, threats and the
 * local market. Called on every successful result through executeTool AND on
 * every macro step (macros bypass executeTool entirely). Must never throw.
 */
export function observeTacticalResult(
  profileId: string,
  command: string,
  commandArgs: Record<string, unknown> | undefined,
  data: unknown,
  notifications?: unknown[],
): void {
  try {
    const t = tacticalFor(profileId)
    const now = Date.now()
    const bare = command.replace(/^spacemolt_/, '')
    const deep = bare.replace(GROUP_PREFIX_RX, '')
    if (bare === 'attack' || bare === 'battle' || bare.startsWith('battle_')) t.lastBattleAt = now
    if (Array.isArray(notifications)) {
      for (const n of notifications) {
        let s = ''
        try { s = JSON.stringify(n).toLowerCase() } catch { s = '' }
        if (/battle|combat|under_attack|attacked/.test(s)) { t.lastBattleAt = now; break }
      }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return
    const d = data as Record<string, unknown>

    // Location block: get_status / get_location / every lib_v2 mutation delta.
    const loc = d.location as Record<string, unknown> | undefined
    if (loc && typeof loc === 'object' && !Array.isArray(loc)) {
      if (typeof loc.system_id === 'string' && loc.system_id) t.systemId = normalizeSystemId(loc.system_id)
      else if (typeof loc.system_name === 'string' && loc.system_name) t.systemId = normalizeSystemId(loc.system_name)
      if (typeof loc.system_name === 'string' && loc.system_name) t.systemName = loc.system_name
      if (typeof loc.poi_id === 'string' && loc.poi_id) t.poiId = loc.poi_id
      if ('docked_at' in loc) t.dockedAt = typeof loc.docked_at === 'string' && loc.docked_at ? loc.docked_at : null
      if (typeof loc.empire === 'string' && loc.empire) t.localEmpire = loc.empire
      const pc = typeof loc.nearby_pirate_count === 'number' ? loc.nearby_pirate_count
        : Array.isArray(loc.nearby_pirates) ? loc.nearby_pirates.length : null
      if (pc !== null) { t.pirates = pc; t.piratesAt = now }
      if (typeof loc.system_id === 'string' || 'docked_at' in loc) t.locationAt = now
    }

    const player = d.player as Record<string, unknown> | undefined
    if (player && typeof player === 'object') {
      const rep = player.reputation
      if (rep && typeof rep === 'object' && !Array.isArray(rep)) t.repByEmpire = rep as Record<string, number>
    }

    // Hull: get_status nests it under ship; get_ship may be flat or nested.
    const ship = (d.ship && typeof d.ship === 'object' ? d.ship : deep === 'get_ship' ? d : undefined) as Record<string, unknown> | undefined
    const hull = ship ? numOrNull(ship.hull) : null
    if (hull !== null) noteHull(t, hull, now)

    // get_nearby: the only call that sees named pirates on-site.
    if (deep === 'get_nearby' || typeof d.pirate_count === 'number' || Array.isArray(d.pirates)) {
      const pc = typeof d.pirate_count === 'number' ? d.pirate_count : Array.isArray(d.pirates) ? d.pirates.length : null
      if (pc !== null) { t.pirates = pc; t.piratesAt = now }
    }

    // get_system: the POI list with has_base is what the docked-state refusal
    // needs to name the station instead of just saying "go dock".
    const sys = d.system as Record<string, unknown> | undefined
    if (sys && typeof sys === 'object' && typeof sys.id === 'string' && Array.isArray(sys.pois)) {
      const systemId = normalizeSystemId(sys.id)
      t.system = {
        systemId,
        systemName: String(sys.name ?? sys.id),
        at: now,
        pois: (sys.pois as Array<Record<string, unknown>>)
          .filter((p) => p && typeof p === 'object' && typeof p.id === 'string')
          .map((p) => ({
            id: String(p.id),
            name: String(p.name ?? p.id),
            type: String(p.type ?? ''),
            has_base: p.has_base === true || (typeof p.base_id === 'string' && p.base_id.length > 0),
            ...(typeof p.base_id === 'string' && p.base_id ? { base_id: p.base_id } : {}),
            ...(typeof p.base_name === 'string' && p.base_name ? { base_name: p.base_name } : {}),
          })),
      }
      // get_system always describes the system the agent is standing in.
      if (!loc) { t.systemId = systemId; t.systemName = t.system.systemName }
      if (typeof sys.empire === 'string' && sys.empire) t.localEmpire = sys.empire
      const poi = d.poi as Record<string, unknown> | undefined
      if (poi && typeof poi === 'object' && typeof poi.id === 'string') t.poiId = poi.id
    }

    // A battle at this POI (ours or not) — get_system/get_poi carry active_battle;
    // get_battle_status carries battle_id + is_participant.
    if (d.active_battle && typeof d.active_battle === 'object') t.lastBattleAt = now
    if (typeof d.battle_id === 'string' && d.battle_id && (d.is_participant === true || d.combat_state)) t.lastBattleAt = now

    // view_market: keep the station's order book so a buy with no ask can be
    // refused locally, with the depth, instead of round-tripping to fail.
    if (deep === 'view_market' || d.action === 'view_market') {
      const items = Array.isArray(d.items) ? d.items : Array.isArray(d.market) ? d.market : null
      const stationId = String(d.base_id ?? d.station_id ?? t.dockedAt ?? '')
      if (items && stationId) {
        const filtered = !!(commandArgs?.item_id || commandArgs?.item || commandArgs?.category || commandArgs?.search)
        const map = new Map<string, { ask: number | null; askQty: number | null; bid: number | null; bidQty: number | null }>()
        for (const raw of items as Array<Record<string, unknown>>) {
          if (!raw || typeof raw !== 'object') continue
          const id = String(raw.item_id ?? raw.id ?? '').toLowerCase()
          if (!id) continue
          map.set(id, {
            ask: numOrNull(raw.best_sell_price ?? raw.best_sell ?? raw.best_ask ?? raw.sell_price),
            askQty: numOrNull(raw.best_sell_qty ?? raw.ask_quantity_at_best),
            bid: numOrNull(raw.best_buy_price ?? raw.best_buy ?? raw.best_bid ?? raw.buy_price),
            bidQty: numOrNull(raw.best_buy_qty ?? raw.bid_quantity_at_best),
          })
        }
        t.market = { stationId, full: !filtered, at: now, items: map }
      }
    }
  } catch { /* observation must never break execution */ }
}

interface CurrentLocation {
  systemId: string | null
  systemName: string | null
  poiId: string | null
  poiName: string | null
  /** undefined = no authoritative docked_at key available. */
  dockedAt: string | null | undefined
  inTransit: boolean
  pirates: number | null
  empire: string | null
  hull: number | null
  repByEmpire: Record<string, number> | null
  /** true when the answer came from the connection's live state cache. */
  live: boolean
}

/** Where the agent is, from the connection's own state cache first and the tool layer's observations second. */
function currentLocation(ctx: ToolContext): CurrentLocation {
  const t = tacticalFor(ctx.profileId)
  let gs: Record<string, unknown> | null = null
  try { gs = ctx.connection.getLocalState?.() ?? null } catch { gs = null }
  const loc = gs?.location as Record<string, unknown> | undefined
  const player = gs?.player as Record<string, unknown> | undefined
  const ship = gs?.ship as Record<string, unknown> | undefined
  const rep = player?.reputation
  if (loc && typeof loc === 'object' && !Array.isArray(loc)) {
    // Some state shapes carry only the display name; ids are its snake_case.
    const nameAsId = typeof loc.system_name === 'string' && loc.system_name ? normalizeSystemId(loc.system_name) : null
    return {
      systemId: typeof loc.system_id === 'string' && loc.system_id ? normalizeSystemId(loc.system_id) : (nameAsId ?? t.systemId),
      systemName: typeof loc.system_name === 'string' && loc.system_name ? loc.system_name : t.systemName,
      poiId: typeof loc.poi_id === 'string' && loc.poi_id ? loc.poi_id : t.poiId,
      poiName: typeof loc.poi_name === 'string' && loc.poi_name ? loc.poi_name : null,
      dockedAt: 'docked_at' in loc ? (typeof loc.docked_at === 'string' && loc.docked_at ? loc.docked_at : null) : t.dockedAt,
      inTransit: loc.in_transit === true,
      pirates: typeof loc.nearby_pirate_count === 'number' ? loc.nearby_pirate_count
        : Array.isArray(loc.nearby_pirates) ? loc.nearby_pirates.length : null,
      empire: typeof loc.empire === 'string' && loc.empire ? loc.empire : t.localEmpire,
      hull: numOrNull(ship?.hull),
      repByEmpire: rep && typeof rep === 'object' && !Array.isArray(rep) ? rep as Record<string, number> : t.repByEmpire,
      live: true,
    }
  }
  return {
    systemId: t.systemId, systemName: t.systemName, poiId: t.poiId, poiName: null, dockedAt: t.dockedAt,
    inTransit: false, pirates: null, empire: t.localEmpire, hull: numOrNull(ship?.hull),
    repByEmpire: t.repByEmpire, live: false,
  }
}

/** Parse SQLite's `datetime('now')` text (UTC, no zone marker) to epoch ms. */
function parseSqliteUtc(s: string): number {
  if (!s) return NaN
  const iso = /Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`
  return new Date(iso).getTime()
}

/**
 * One labelled line from fleet_intel_systems for a system the agent asked about
 * but is not standing in. LABELLED because it is a record, not a reading: the
 * station flag in particular can only ever latch on, so a phantom survives.
 */
function fleetRecordLine(systemId: string): string {
  const id = normalizeSystemId(systemId)
  try {
    const row = getDb().query(
      `SELECT system_id, system_name, has_station, station_services, police_level, updated_at
       FROM fleet_intel_systems WHERE system_id = ?`,
    ).get(id) as { system_id: string; system_name: string; has_station: number; station_services: string | null; police_level: number | null; updated_at: string } | null
    if (!row) return `Fleet record for ${id}: none — no fleet agent has surveyed this system.`
    const ageMs = Date.now() - parseSqliteUtc(row.updated_at)
    const age = Number.isFinite(ageMs) ? `${Math.max(0, Math.round(ageMs / 3_600_000))}h` : '?'
    const danger = assessSystemDanger(id).grade
    const name = row.system_name && normalizeSystemId(row.system_name) !== id ? ` (${row.system_name})` : ''
    return (
      `Fleet record for ${id}${name} (age ${age}): station ${row.has_station ? 'yes' : 'no'}, ` +
      `services ${row.station_services || 'unknown'}, police ${row.police_level ?? 'unknown'}, danger ${danger}. ` +
      `This is the fleet's RECORD, not a live reading.`
    )
  } catch {
    return `Fleet record for ${id}: unavailable.`
  }
}

/** Commands that only work while docked. `view` is the storage group's read. */
const DOCKED_ONLY_COMMANDS = new Set([
  'view_market', 'buy', 'sell', 'create_sell_order', 'create_buy_order',
  'get_missions', 'accept_mission', 'get_base', 'view_storage', 'view', 'deposit', 'withdraw',
])

function isDockedOnly(deep: string, args: Record<string, unknown> | undefined): boolean {
  if (DOCKED_ONLY_COMMANDS.has(deep)) return true
  // Bare repair/refuel draw on the station; with an item they consume cargo
  // (fuel cells, repair kits) and work in space — never refuse those.
  if ((deep === 'repair' || deep === 'refuel') && !args?.id && !args?.item_id && !args?.target) return true
  return false
}

/**
 * Local refusal for a docked-only command issued while the connection's own
 * state says docked_at is null. Names the dockable POI and the exact commands
 * to get there, so the refusal replaces the not_docked/no_base round trip AND
 * the get_system/get_poi the agent would run next (34 not_docked + 19 no_base
 * in one day on one agent). docked_at is authoritative; when the state has no
 * such key, or a movement is more recent than the last confirmed location,
 * the game answers instead.
 */
async function checkDockedState(
  ctx: ToolContext,
  deep: string,
  commandArgs: Record<string, unknown> | undefined,
): Promise<string | null> {
  if (!isDockedOnly(deep, commandArgs) || getPreference('docked_gate') === 'off') return null
  const t = tacticalFor(ctx.profileId)
  let gs: Record<string, unknown> | null = null
  try { gs = ctx.connection.getLocalState?.() ?? null } catch { gs = null }
  const loc = gs?.location as Record<string, unknown> | undefined
  if (!loc || typeof loc !== 'object' || Array.isArray(loc) || !('docked_at' in loc)) return null
  if (loc.docked_at) return null
  // A movement issued after the cache last confirmed a location (travel's
  // auto-undock, a dock still resolving) makes the snapshot suspect.
  if (t.lastMovementAt > t.locationAt) return null

  const cur = currentLocation(ctx)
  const systemId = cur.systemId
  const systemName = cur.systemName ?? systemId ?? 'this system'
  const poiId = cur.poiId
  const poiLabel = cur.poiName ?? poiId ?? 'deep space'

  let pois = t.system && (!systemId || t.system.systemId === systemId) ? t.system.pois : null
  if (!pois) {
    try {
      const r = await ctx.connection.execute('get_system')
      if (!r.error) {
        observeTacticalResult(ctx.profileId, 'get_system', undefined, r.structuredContent ?? r.result)
        const s = tacticalFor(ctx.profileId).system
        if (s && (!systemId || s.systemId === systemId)) pois = s.pois
      }
    } catch { /* fall through to the generic hint */ }
  }

  let where: string
  if (!pois) {
    where = 'Run get_system (free) and look for a POI with has_base: true, then travel(target_poi="<poi id>") and dock().'
  } else {
    const bases = pois.filter((p) => p.has_base)
    if (bases.length === 0) {
      let nearest = ''
      try {
        const nb = systemId ? getNavIntel(systemId).neighbours.filter((n) => n.has_station).slice(0, 3) : []
        nearest = nb.length
          ? ` Nearest stations on the fleet map (one jump each): ${nb.map((n) => n.system_id + (n.station_services ? ` [${n.station_services}]` : '')).join(', ')}.`
          : ' Use fleet_route or find_route to reach a station system.'
      } catch { /* nav intel is a bonus */ }
      where = `There is NO station in ${systemName} — nothing here to dock at.${nearest}`
    } else {
      const here = poiId ? bases.find((b) => b.id === poiId) : undefined
      if (here) {
        where = `You are AT ${here.base_name ?? here.name} (POI ${here.id}) but not docked — run dock() first, then ${deep}.`
      } else {
        const b = bases[0]
        const others = bases.slice(1).map((x) => `${x.base_name ?? x.name} (${x.id})`)
        where =
          `The station here is ${b.base_name ?? b.name} at POI "${b.id}" — run travel(target_poi="${b.id}"), then dock(), then ${deep}.` +
          (others.length ? ` Other stations in this system: ${others.join(', ')}.` : '')
      }
    }
  }
  return (
    `NOT DOCKED: ${deep} needs a station and you are ${cur.inTransit ? 'in transit' : 'in space'} at ${poiLabel} ` +
    `in ${systemName} (docked_at is null). ${where}`
  )
}

/**
 * A buy against a board with no ask fills nothing and costs a tick. The
 * station's last view_market (this process) or the fleet's station-scoped
 * market table says so before the round trip — and says how deep the ask is.
 */
function checkBuyAsk(ctx: ToolContext, deep: string, commandArgs: Record<string, unknown> | undefined): string | null {
  if (deep !== 'buy' || getPreference('buy_ask_gate') === 'off') return null
  const itemId = String(commandArgs?.id ?? commandArgs?.item_id ?? '').toLowerCase()
  const qty = Number(commandArgs?.quantity ?? 0) || 0
  if (!itemId) return null
  const station = currentLocation(ctx).dockedAt
  if (!station) return null
  const t = tacticalFor(ctx.profileId)
  const snap = t.market
  const now = Date.now()
  if (snap && snap.stationId === station && now - snap.at < MARKET_SNAPSHOT_MAX_AGE_MS) {
    const ageS = Math.round((now - snap.at) / 1000)
    const e = snap.items.get(itemId)
    if (!e) {
      if (!snap.full) return null // filtered read — absence proves nothing
      return (
        `BLOCKED: ${itemId} is not on the ${station} board at all — your view_market ${ageS}s ago listed no order ` +
        `for it (ask depth 0). Nobody here sells it. Buy it where you have SEEN an ask, or create_buy_order here and wait.`
      )
    }
    if (e.ask === null || e.ask <= 0 || e.askQty === 0) {
      return (
        `BLOCKED: no ask for ${itemId} at ${station} (view_market ${ageS}s ago: bid ${e.bid ?? 0}cr x${e.bidQty ?? '?'}, ` +
        `ASK none — depth 0). A buy with no ask fills nothing. Buy where an ask exists, or create_buy_order.`
      )
    }
    if (e.askQty !== null && qty > e.askQty) {
      return (
        `BLOCKED: the ${itemId} ask at ${station} is only ${e.askQty} deep at ${e.ask}cr (view_market ${ageS}s ago) ` +
        `and you asked for ${qty}. Buy at most ${e.askQty} now; past the depth the fill walks up the book or fails.`
      )
    }
    return null
  }
  try {
    const row = getDb().query(
      `SELECT best_sell, best_sell_qty, updated_at FROM fleet_intel_market
       WHERE station_id = ? AND item_id = ? AND updated_at > datetime('now', '-30 minutes')`,
    ).get(station, itemId) as { best_sell: number | null; best_sell_qty: number | null; updated_at: string } | null
    if (!row) return null
    if (row.best_sell === null || row.best_sell <= 0 || row.best_sell_qty === 0) {
      return (
        `BLOCKED: the fleet's market record for ${station} (under 30 minutes old) shows NO ask for ${itemId} ` +
        `(depth 0). A buy with no ask fills nothing. Run view_market if you believe the board changed, ` +
        `otherwise buy elsewhere or create_buy_order.`
      )
    }
    if (row.best_sell_qty !== null && qty > row.best_sell_qty) {
      return (
        `BLOCKED: the fleet's market record for ${station} shows the ${itemId} ask only ${row.best_sell_qty} deep ` +
        `at ${row.best_sell}cr; you asked for ${qty}. Buy at most ${row.best_sell_qty}, or view_market first if the board moved.`
      )
    }
  } catch { /* no record — the game answers */ }
  return null
}

// Sentinel prefix for action pending results — loop.ts detects this to exit the turn early
export const ACTION_PENDING_SENTINEL = '⚠️ ACTION_PENDING: '
// Prefix of the cooldown-gate rejection. The loop watches for this to end the turn early instead
// of letting the model re-fire into the gate for the rest of its round budget.
export const COOLDOWN_BLOCKED_SENTINEL = '⏳ ACTION BLOCKED'

// Commands that are free queries (no tick cost) — exempt from cooldown.
// Includes both v1 bare names AND v2 grouped names (e.g. market_view_market, storage_view).
const QUERY_COMMANDS = new Set([
  // v1 bare names
  'get_status', 'get_location', 'get_ship', 'get_cargo', 'get_system', 'get_poi', 'get_base',
  'get_map', 'get_skills', 'get_nearby', 'get_wrecks', 'get_trades', 'get_player', 'get_queue',
  'get_missions', 'get_active_missions', 'get_notifications', 'get_chat_history',
  'get_battle_status', 'get_commands', 'get_guide', 'get_version', 'get_notes',
  'get_insurance_quote', 'get_action_log', 'view_market', 'view_orders',
  'view_storage', 'view_faction_storage', 'view_completed_mission',
  'estimate_purchase', 'analyze_market', 'find_route', 'search_systems',
  'scan', 'help', 'catalog', 'browse_ships', 'commission_quote', 'commission_status',
  'completed_missions', 'read_note', 'get_notes', 'captains_log_list', 'captains_log_get',
  'faction_info', 'faction_list', 'faction_get_invites', 'faction_rooms',
  'faction_visit_room', 'faction_intel_status', 'faction_query_intel',
  'faction_query_trade_intel', 'faction_trade_intel_status', 'faction_list_missions',
  'forum_list', 'forum_get_thread', 'read_fleet_orders', 'claim_insurance',
  // v2 grouped names (tool_action format from MCP v2 / HTTP v2)
  'market_view_market', 'market_view_orders', 'market_analyze_market', 'market_estimate_purchase',
  'storage_view', 'storage_view_faction',
  'social_captains_log_list', 'social_captains_log_get', 'social_get_notes', 'social_read_note',
  'social_get_chat_history', 'social_forum_list', 'social_forum_get_thread',
  'intel_query_intel', 'intel_query_trade_intel', 'intel_intel_status', 'intel_trade_intel_status',
  'faction_info', 'faction_list', 'faction_get_invites', 'faction_rooms', 'faction_visit_room',
  'faction_list_missions',
  'faction_admin_list_roles',
  'salvage_wrecks', 'salvage_policies',
  // Facility READS. These are lookups — "what do I own", "what is here", "what
  // exists" — and cost no game tick, but were absent, so every one was charged
  // an action cooldown. Morg'Thar ran 22 facility calls in one session chasing
  // a rental he did not have and paid a tick for each. The MUTATIONS
  // (build, upgrade, dismantle, faction_build, rent...) are deliberately NOT
  // listed here and remain rate-limited.
  'facility_owned', 'facility_list', 'facility_types', 'facility_upgrades',
  'facility_faction_list', 'facility_faction_owned', 'facility_job_list',
  'facility_personal_visit',
  'owned', 'upgrades', 'job_list', 'personal_visit',
  'catalog_catalog', 'catalog_browse_ships',
  'ship_get_ship', 'ship_get_cargo',
  'battle_get_battle_status',
])

/**
 * Query vs action classification, shared by BOTH command paths (executeTool and the
 * manual/API path via bookLedgerFromCommand). Queries are free — no game tick, no
 * cooldown — and never move credits, so they are never booked to the ledger.
 */
export function isQueryCommand(command: string, args?: Record<string, unknown>): boolean {
  // The v2 group form carries the verb in an `action` argument
  // (`facility` + {action:'owned'}), so the command name alone says nothing
  // about whether it reads or writes. Fold the action in before classifying,
  // or every group-form read gets charged an action cooldown.
  let name = command.replace(/^spacemolt_/, '')
  const action = args?.action
  if (typeof action === 'string' && action && !name.endsWith(`_${action}`)) {
    name = `${name}_${action}`
  }
  const bare = name
  const deep = bare.replace(/^(?:market|storage|social|intel|faction|faction_admin|salvage|catalog|ship|battle|transfer|facility|auth)_/, '')
  return QUERY_COMMANDS.has(command) || QUERY_COMMANDS.has(bare) || QUERY_COMMANDS.has(deep)
    // Heuristic: commands starting with get_/view_/list_/query_/browse_/search_/find_/estimate_ are queries
    || /^(?:get_|view_|list_|query_|browse_|search_|find_|estimate_|help|scan|catalog)/.test(deep)
}

export type LogFn = (type: string, summary: string, detail?: string) => void

export interface ToolContext {
  connection: GameConnection
  profileId: string
  profileName: string
  log: LogFn
  todo: string
  memory: string
  /** Optional probe for pending operator interrupts — see LoopOptions.interruptPending. */
  interruptPending?: () => string | null
}

/**
 * Deterministic Admiral doctrine guards, shared by BOTH command paths — the
 * agent LLM tool layer (executeTool) and the manual/API path
 * (Agent.executeCommand). Returns a refusal string, or null to allow.
 *
 * Every rule here earned its place by failing as prose first: wildlife missions
 * (three ignored written bans on one agent), BoM sell quotas (agent-memory
 * tracking oversold twice in one night), and jettison (four agents, one
 * identical rationalization, one full rebuild). Keep them free of side effects
 * so either caller can run them before dispatch.
 */
/**
 * Mirror any view_storage response into the DB storage ledger.
 *
 * Every agent is told to keep a prose STORAGE LEDGER in memory, and every agent
 * drifts — the fleet lost a gas_harvester_i across three stations once, and
 * Nova's Confederacy Central Command depot (1,148 nickel ore, a spare mining
 * laser, 3 parked ships) sat forgotten while we hunted the same materials. This
 * makes the ledger machine-kept: view_storage is a FREE query agents already run
 * constantly, so the table stays warm at zero extra cost and can never disagree
 * with what the game actually reported.
 */
export function recordStorageFromCommand(command: string, data: unknown, profileId: string): void {
  const sc = data as {
    action?: string
    base_id?: string
    items?: Array<{ item_id?: string; name?: string; quantity?: number }>
    ships?: Array<{ ship_id?: string; class_id?: string; custom_name?: string; modules?: number }>
  } | null
  // Match on what the GAME says it did, not on what we were called.
  //
  // This gate used to test the command name only, and it never once fired in
  // production: agents reach storage through `view(target=storage)`, not
  // `view_storage`. 54 calls to the former and 0 to the latter in a single day,
  // so every row in the ledger came from manual refreshes and the table silently
  // rotted for days. The response payload always carries `action: view_storage`
  // whichever spelling was used, so trust that and keep the name check only as a
  // fallback for responses that omit it.
  const bare = command.replace(/^spacemolt_/, '').replace(/^storage_/, '')
  const byName = bare === 'view_storage' || bare.endsWith('_view_storage')
  if (sc?.action !== 'view_storage' && !byName) return
  const station = sc?.base_id
  if (!station || !Array.isArray(sc?.items)) return // shape we don't recognise — record nothing
  // A real snapshot supersedes any "we know something moved but not where" flag.
  clearStorageDirty(profileId)
  recordStorageSnapshot(
    profileId,
    station,
    sc.items
      .filter((i) => i?.item_id && typeof i.quantity === 'number')
      .map((i) => ({ item_id: i.item_id!, item_name: i.name ?? '', quantity: i.quantity! })),
    (sc.ships ?? [])
      .filter((s) => s?.ship_id)
      .map((s) => ({
        ship_id: s.ship_id!,
        class: s.class_id ?? '',
        custom_name: s.custom_name ?? '',
        module_count: typeof s.modules === 'number' ? s.modules : 0,
      })),
  )
}

/**
 * Mirror any cargo-bearing response into the DB cargo ledger.
 *
 * Station storage alone is blind to everything in flight. A hauler carrying 200
 * thorium between systems showed as owning nothing, so the fleet re-mined
 * material it was already carrying and deliveries appeared to arrive from
 * nowhere. `get_cargo` and `get_ship` are FREE queries agents run constantly, so
 * this stays warm at zero tick cost.
 */
export function recordCargoFromCommand(command: string, data: unknown, profileId: string): void {
  const sc = data as {
    action?: string
    cargo?: Array<{ item_id?: string; name?: string; quantity?: number }>
    ship?: { id?: string }
  } | null
  if (!Array.isArray(sc?.cargo)) return // no cargo block — not a response we can use
  const bare = command.replace(/^spacemolt_/, '').replace(/^ship_/, '')
  const looksRight =
    sc?.action === 'get_cargo' || sc?.action === 'get_ship' ||
    bare === 'get_cargo' || bare === 'get_ship' || bare === 'view' ||
    bare.endsWith('_get_cargo') || bare.endsWith('_get_ship')
  if (!looksRight) return
  recordCargoSnapshot(
    profileId,
    sc.cargo
      .filter((i) => i?.item_id && typeof i.quantity === 'number')
      .map((i) => ({ item_id: i.item_id!, item_name: i.name ?? '', quantity: i.quantity! })),
    sc.ship?.id ?? '',
  )
}

export function checkDoctrineGuards(
  command: string,
  commandArgs: Record<string, unknown> | undefined,
  profileId: string,
  /** Where the caller believes the agent is (location.system_id). Falls back to
   *  what the tool layer last observed; unknown means location-scoped gates stand down. */
  currentSystemId?: string | null,
): string | null {
  // Wildlife hunts: LIFTED 2026-08-06. The original ban assumed targets did not
  // reliably spawn. The changelog says otherwise — herds gather where the ore or
  // gas is still RICH and thin out in mined-over fields (0.536.0), so agents were
  // hunting exhausted belts and blaming the game. Creature drops now also refine
  // into titanium_alloy, superconductor, focused_crystal and silicate_composite
  // (0.528.0) — precisely the lines the Devastator is short of — and adamant_tooth
  // comes off an adamant-grinder, which is the cheap route to the mass drivers.
  //
  // The block is simply gone — the failure mode was method, not the feature.
  // Technique guidance lives in the HUNTING DOCTRINE directive block instead:
  // find herds with get_nearby in RICH fields, scan before engaging, and do not
  // hunt a belt you have already mined thin.

  // Reputation lockout: a system that has already refused you does not change
  // its mind because you flew back. Morg'Thar attacked a faction target under
  // Voss Redoubt Station's guns on 2026-09-01, dropped to -5 reputation, was
  // refused docking, left — then returned to Alhena twice more and was refused
  // again at -10, each trip costing fuel and turns for a guaranteed rejection.
  // The refusal names the alternative rather than just blocking.
  //
  // Scoped to the refusing SYSTEM: the gate fires only when the agent is back
  // in the system that refused it. Anywhere else — including home — docking
  // goes to the game. Unknown position means the game answers.
  {
    const bareRep = command.replace(/^spacemolt_/, '').replace(/^ship_/, '')
    if (bareRep === 'dock' && getPreference('reputation_gate') !== 'off') {
      const here = currentSystemId ?? tacticalFor(profileId).systemId
      const locked = reputationLockoutFor(profileId, here)
      if (locked) {
        return (
          `BLOCKED by Admiral doctrine: ${locked.label} in ${locked.systemId} refused you docking ` +
          `${Math.round((Date.now() - locked.at) / 60_000)} minute(s) ago for insufficient reputation ` +
          `(${locked.rep ?? 'negative'}), and you are back in ${locked.systemId}. Reputation does not recover by ` +
          `flying back — this dock is a guaranteed rejection.\n\n` +
          `Go somewhere you are WELCOME instead: your home space (crimson_war_citadel at Krynn) or any ` +
          `station of a faction you have not attacked — docking anywhere OUTSIDE ${locked.systemId} is not ` +
          `blocked. Record in your TODO that this station is closed to you, so you stop routing here.`
        )
      }
    }
  }

  // Jettison: nothing with a bid is worthless.
  {
    const bare = command.replace(/^spacemolt_/, '').replace(/^ship_/, '')
    if ((bare === 'jettison' || bare.endsWith('_jettison')) && getPreference('jettison_gate') !== 'off') {
      const items = Array.isArray(commandArgs?.items)
        ? (commandArgs.items as Array<Record<string, unknown>>)
            .map(i => `${i.item_id ?? i.id ?? '?'}x${i.quantity ?? '?'}`).join(', ')
        : `${commandArgs?.item_id ?? commandArgs?.id ?? 'cargo'}${commandArgs?.quantity ? 'x' + commandArgs.quantity : ''}`
      return (
        `BLOCKED by Admiral doctrine: jettison is disabled fleet-wide (attempted: ${items}). ` +
        `Nothing with a bid is worthless, and the fleet decides what is scrap — not you. ` +
        `Instead: deposit the cargo at your next station (storage is free), gift it to an agent ` +
        `who needs it, or sell it at a hub that actually bids. If your hold is full and you are ` +
        `far from a station, finish the run and deposit on arrival.`
      )
    }
  }

  // BoM sell lock: locked items sell only against a remaining DB quota.
  {
    const bare = command.replace(/^spacemolt_/, '').replace(/^market_/, '')
    if (bare === 'sell' || bare === 'create_sell_order') {
      const orders = Array.isArray(commandArgs?.orders)
        ? (commandArgs.orders as Array<Record<string, unknown>>)
        : [commandArgs ?? {}]
      for (const o of orders) {
        const itemId = String(o.item_id ?? o.id ?? '').toLowerCase()
        const qty = Number(o.quantity ?? 0) || 0
        if (itemId && SELL_CARGO_ALWAYS_EXCLUDE.has(itemId)) {
          const remaining = getSellQuota(profileId, itemId)
          if (remaining === null || remaining <= 0) {
            return `BLOCKED: ${itemId} is BoM-locked and you have no remaining Admiral sell quota for it${remaining !== null ? ' (quota exhausted)' : ''}. Locked items go to the war_citadel vault, never to market.`
          }
          if (qty > remaining) {
            return `BLOCKED: quota for ${itemId} has only ${remaining} remaining (you tried ${qty}). Sell at most ${Math.floor(remaining)} or leave it vaulted.`
          }
        }
      }
    }
  }

  // Fuel-cell hoarding guard. Fuel cells deliver fuel at 60+cr/unit vs 2-20cr
  // from any station tank, and directive prose ("never buy another fuel cell")
  // failed THREE times in one day — 42 cells (66.5k), 15 cells (19.7k), then
  // 113 cells (180k) on 2026-08-27. Fleet doctrine: cells are an emergency
  // reserve of at most 8; purchases only top the reserve back up.
  {
    const bareF = command.replace(/^spacemolt_/, '').replace(/^market_/, '')
    if (bareF === 'buy' && getPreference('fuel_cell_gate') !== 'off') {
      const itemId = String(commandArgs?.item_id ?? commandArgs?.id ?? '').toLowerCase()
      if (itemId === 'fuel_cell' || itemId === 'premium_fuel_cell' || itemId === 'military_fuel_cell') {
        const qty = Number(commandArgs?.quantity ?? 0) || 0
        const held = getCargoQuantity(profileId, itemId)
        const allowance = Math.max(0, 8 - held)
        if (qty > allowance) {
          return (
            `BLOCKED: fuel cells are an EMERGENCY RESERVE of at most 8 — you hold ${held} and ` +
            `tried to buy ${qty}${allowance > 0 ? ` (you may buy at most ${allowance})` : ' (you may buy none)'}. ` +
            `Cells cost 60+cr per fuel unit; station tanks cost 2-20cr. Refuel from the station ` +
            `tank while docked, and plan long routes station-to-station.`
          )
        }
      }
    }
  }

  // Fuel floor guard. A jump from a nearly-dry tank strands the ship wherever
  // it lands — the Devastator drifted 8+ hours at Dheneb Cryobelt on 2026-08-29
  // after jumping into a dry-tank pocket on fumes. Prose doctrine ("count fuel
  // BEFORE jumping") failed twice in one day; this makes it mechanical: no jump
  // when the tank is under the floor unless cargo cells (20/50/100 restore by
  // tier) can bring it back above. Escape valve: a ship ALREADY below the floor
  // in a stationless system must still be able to jump toward fuel, so repeating
  // the identical jump within 10 minutes proceeds — the block is a checkpoint
  // against absent-minded dry jumps, never a trap (the same ship, same day,
  // would have been trapped mid-corridor at 35/350 by an unconditional block).
  {
    const bareJ = command.replace(/^spacemolt_/, '').replace(/^nav_/, '').replace(/^ship_/, '')
    if (bareJ === 'jump' && getPreference('fuel_floor_gate') !== 'off') {
      const st = getProfileLastState(profileId)
      const m = /^(\d+)\s*\/\s*(\d+)/.exec(String(st?.fuel ?? ''))
      if (m) {
        const fuel = Number(m[1])
        const max = Number(m[2])
        const floorPct = Number(getPreference('fuel_floor_pct') ?? 20) || 20
        const floor = Math.max(10, Math.round(max * (floorPct / 100)))
        if (max > 0 && fuel < floor) {
          const restore = getCargoQuantity(profileId, 'fuel_cell') * 20
            + getCargoQuantity(profileId, 'premium_fuel_cell') * 50
            + getCargoQuantity(profileId, 'military_fuel_cell') * 100
          if (fuel + restore < floor) {
            const dest = String(commandArgs?.system_id ?? commandArgs?.destination ?? commandArgs?.system ?? '?')
            const prior = fuelFloorBlocks.get(profileId)
            if (prior && prior.dest === dest && Date.now() - prior.at < 10 * 60 * 1000) {
              fuelFloorBlocks.delete(profileId)
            } else {
              fuelFloorBlocks.set(profileId, { dest, at: Date.now() })
              return (
                `CHECKPOINT by fuel floor: tank ${fuel}/${max} is under the ${floor}-unit floor and your ` +
                `cargo cells can only restore ${restore}. A jump on a dry tank strands the ship wherever ` +
                `it lands. If you can fix fuel HERE, do that instead: station tank refuel (2-20cr/unit), ` +
                `or buy cells up to the 8-cell reserve and run \`refuel\`. If there is NO fuel here and ` +
                `this jump moves you toward a station whose tank you have verified works (get_poi shows ` +
                `reserves), repeat the exact same jump now to proceed — the checkpoint clears once per leg.`
              )
            }
          }
        }
      }
    }
  }

  // Depth guard on market sells. A market `sell` has no limit price: quantity
  // beyond the honest bid depth cascades down the book into 1cr lowballs (110
  // circuit boards went 645 → 395 → 1cr on 2026-08-27, ~30k left on the table).
  // "Depth before size" was prose doctrine; this makes it mechanical: a bulk
  // sell requires a FRESH market observation and is capped to the observed depth.
  {
    const bareD = command.replace(/^spacemolt_/, '').replace(/^market_/, '')
    if (bareD === 'sell' && getPreference('sell_depth_gate') !== 'off') {
      const itemId = String(commandArgs?.item_id ?? commandArgs?.id ?? '').toLowerCase()
      const qty = Number(commandArgs?.quantity ?? 0) || 0
      if (itemId && itemId !== 'fuel' && qty > 0) {
        const obs = getFreshMarketDepth(itemId, 30)
        // Fresh-observation and depth-cap requirements apply to bulk sells only;
        // the lowball block below applies to ANY quantity (Zibal sold phase
        // crystals worth ~500cr each into a 1cr bid four at a time — the old
        // qty>5 threshold let micro-dumps through).
        if (!obs) {
          if (qty <= 5) { /* small sell with no observation — allowed */ }
          else return (
            `BLOCKED: no fresh market observation for ${itemId}. Run view_market here first ` +
            `(free, no tick), then sell AT MOST the bid depth. Market sells walk the whole ` +
            `book — quantity beyond the real depth fills at 1cr lowballs.`
          )
        }
        if (obs && (obs.best_buy ?? 0) <= 2) {
          return (
            `BLOCKED: best bid for ${itemId} is ${obs.best_buy ?? 0}cr (${obs.station_name}) — a lowball ` +
            `trap. create_sell_order at a fair price or haul to a station that actually bids.`
          )
        }
        if (obs && qty > 5 && obs.best_buy_qty !== null && qty > obs.best_buy_qty) {
          return (
            `BLOCKED: the ${itemId} bid is only ${obs.best_buy_qty} deep at ${obs.best_buy}cr ` +
            `(you tried ${qty}). Sell at most ${obs.best_buy_qty} now, then create_sell_order ` +
            `the remainder at a fair price — never dump past the depth.`
          )
        }
      }
    }
  }

  // Loss-churn gate. Grit (Qwen, 2026-08-28) read `best_buy: 596 / best_sell: 3000`
  // as "buy at 596, sell at 3000", bought 6 cells AT THE ASK (3,000) and sold them
  // into the BID (596) minutes later — −14,424 in four minutes. Morg's carbon-ore
  // buy was the same inversion. A sell within the window at a bid far below what
  // was just paid is near-certainly that misread, never a strategy — block it and
  // spell out which side is which.
  {
    const bareL = command.replace(/^spacemolt_/, '').replace(/^market_/, '')
    if (bareL === 'sell' && getPreference('loss_churn_gate') !== 'off') {
      const itemId = String(commandArgs?.item_id ?? commandArgs?.id ?? '').toLowerCase()
      const qty = Number(commandArgs?.quantity ?? 0) || 0
      if (itemId && qty > 0) {
        const paid = getRecentBuyUnitPrice(profileId, itemId, 45)
        if (paid !== null && paid > 0) {
          const obs = getFreshMarketDepth(itemId, 30)
          if (obs?.best_buy != null && obs.best_buy < paid * 0.8) {
            return (
              `BLOCKED: you BOUGHT ${itemId} at ${paid}cr within the last 45 minutes and are now ` +
              `selling into a ${obs.best_buy}cr bid — a guaranteed ${Math.round((paid - obs.best_buy) * qty)}cr loss. ` +
              `You are almost certainly misreading the order book: best_sell (the ASK) is what YOU PAY ` +
              `to buy; best_buy (the BID) is what the station pays YOU. There is no profit buying at the ` +
              `ask and selling into the bid at the same station. Keep the goods (use fuel cells via ` +
              `refuel; haul cargo to a station whose BID exceeds what you paid) or ask the Admiral.`
            )
          }
        }
      }
    }
  }

  // BoM CRAFT lock. The sell and gift guards above stopped material leaving the fleet, but
  // nothing stopped an agent consuming a commission line INTO a recipe — and a consumed line is
  // gone in exactly the same way. Thirteen of the Devastator's 24 lines sit at EXACTLY the
  // required quantity, and nobody in the galaxy sells neutronium_ingot, so a broken line may be
  // unrecoverable. The near-miss: the Bonanza King BoM needs durasteel_plate 60 / hull_plating 25
  // / shield_emitter 5, against War Citadel spares of 14 / 19 / 4.
  //
  // The reserve comes from the recorded commission_quote, not a constant, so it follows the real
  // order as lines are delivered. Items in SELL_CARGO_ALWAYS_EXCLUDE with no recorded requirement
  // are left alone here — that list guards trade, and blocking every craft on it would stop the
  // fleet building anything at all. The reserve is per-profile: only the agent whose quote
  // recorded the requirement is held to it (legacy rows with no owner still bind everyone).
  // 2026-08-29: CassMargin's caravan quote was blocking Morg'Thar's ammo crafts at war_citadel.
  {
    const bare = command.replace(/^spacemolt_/, '').replace(/^craft_/, '')
    if (bare === 'craft' || bare.endsWith('_craft')) {
      const recipeId = String(commandArgs?.id ?? commandArgs?.recipe_id ?? '').trim()
      const runs = Math.max(1, Number(commandArgs?.quantity ?? commandArgs?.count ?? commandArgs?.runs ?? 1) || 1)
      const isDryRun = commandArgs?.dry_run === true
      // The guard is not handed a location, so fall back to the last station this agent
      // recorded storage at — storage snapshots are written on every view_storage.
      const stationId = String(commandArgs?.base_id ?? commandArgs?.station_id ?? getMostRecentStation(profileId) ?? '')

      if (recipeId && !isDryRun && stationId) {
        const recipe = codexGet('recipe', recipeId) as { inputs?: Array<{ item_id?: string; quantity?: number }> } | null
        for (const input of recipe?.inputs ?? []) {
          const itemId = String(input?.item_id ?? '').toLowerCase()
          if (!itemId) continue
          const required = getCommissionRequirement(itemId, profileId)
          if (required <= 0) continue // not a commission line — crafting with it is fine

          const consuming = Number(input?.quantity ?? 0) * runs

          // Two tiers. The agent's TOTAL is the unrecoverable one — if that falls below the
          // requirement the line cannot be refilled by moving crates around. The per-station
          // check is the recoverable one, and is only as good as our guess at where they are
          // standing, so it never fires alone when the total is still healthy elsewhere.
          const total = getStorageTotalForProfile(profileId, itemId)
          const held = getStorageQuantity(profileId, stationId, itemId)
          const breaksTotal = total - consuming < required
          const breaksHere = held > 0 && held - consuming < required
          if (!breaksTotal && !breaksHere) continue

          const elsewhere = getStorageElsewhere(stationId, itemId)
          const where = elsewhere.length
            ? elsewhere.map((e) => `${e.quantity} at ${e.station_id}`).join(', ')
            : 'nowhere else in the fleet'
          const scope = breaksTotal
            ? `you hold ${total} in total across every station`
            : `you hold ${held} at this station (${total} fleet-wide)`
          return (
            `BLOCKED by Admiral doctrine: crafting ${recipeId} x${runs} would consume ${consuming} ${itemId}, ` +
            `but your active ship commission requires ${required} and ${scope}. ` +
            `That line is reserved for your commission; some inputs are sold by nobody, so a broken ` +
            `line may be unrecoverable.

💡 Stock outside this station: ${where}. ` +
            (breaksTotal
              ? `There is no surplus to draw on — do NOT craft this.`
              : `Source it from there and craft again, or say the exact shortfall in faction chat.`) +
            ` Never take the last units off a commission line to finish a hull.`
          )
        }
      }
    }
  }

  // BoM gift lock: gifting is the doctrine-approved way to move material between
  // agents (the jettison guard explicitly recommends it), and send_gift reaches
  // the game through the REST fallback — so it never passes the market sell lock
  // above. Without this, "gift it to a friendly trader" walks BoM material out of
  // the fleet with no quota check at all. Fleet-internal gifts stay unrestricted.
  {
    const bare = command.replace(/^spacemolt_/, '').replace(/^social_/, '')
    if (bare === 'send_gift' || bare.endsWith('_send_gift')) {
      const itemId = String(commandArgs?.item_id ?? '').toLowerCase()
      if (itemId && SELL_CARGO_ALWAYS_EXCLUDE.has(itemId)) {
        const recipient = String(commandArgs?.recipient ?? '').trim().toLowerCase()
        const fleet = new Set<string>()
        for (const p of listProfiles()) {
          if (p.username) fleet.add(p.username.toLowerCase())
          if (p.player_id) fleet.add(p.player_id.toLowerCase())
        }
        const isFleetFaction = recipient.startsWith('faction:')
        if (!recipient || (!fleet.has(recipient) && !isFleetFaction)) {
          return (
            `BLOCKED: ${itemId} is BoM-locked and "${commandArgs?.recipient ?? ''}" is not a fleet agent. ` +
            `Devastator material moves between OUR agents or into the war_citadel vault — never to an outside player. ` +
            `Gift it to a fleet callsign, or deposit it to storage instead.`
          )
        }
      }
    }
  }

  return null
}

/**
 * Self-accounting captures (2026-08-21): bank authoritative reads as they pass. Each of
 * these fills a table whose absence cost something real — see the schema comment in db.ts.
 *
 * Shared by BOTH command paths — the LLM tool layer (executeTool) and the manual/API
 * path (Agent.executeCommand). A capture that lives on only one path silently misses
 * everything the other path sees: the empire-policy hook sat dead for weeks because
 * silent admin commands take the manual path (found 2026-08-25).
 */
export function captureFromCommandResult(command: string, resultData: unknown, profileId: string, source = 'result'): void {
  const bare = command.replace(/^spacemolt_/, '').replace(/^(salvage_|ship_|facility_|social_)/, '')
  try {
    const d = resultData as Record<string, unknown> | undefined
    if (bare === 'view_orders' || bare === 'market_view_orders') {
      // Sell-order fills credit the wallet with no notification — this diff is
      // the only path that books them (Cass's 50.7k of crystal fills, 2026-08-28).
      bookOrderFillsFromView(profileId, d)
    }
    if (bare === 'cancel_order' || bare === 'market_cancel_order') {
      // Close the tracked order NOW, before the trading.order_cancelled event
      // lands via action-log ingestion — otherwise the next view_orders read
      // could book the cancelled remainder as a phantom fill.
      const det = (d?.details ?? d) as Record<string, unknown> | undefined
      const orderId = String(det?.order_id ?? '')
      const ret = det?.returned_items as Record<string, unknown> | undefined
      const qty = ret && !Array.isArray(ret) ? Number(ret.quantity ?? NaN) : NaN
      if (orderId) closeOrderOnCancel(profileId, orderId, Number.isFinite(qty) ? qty : null)
    }
    if (bare === 'policies' && Array.isArray(d?.policies)) {
      replaceInsurancePolicies(profileId, d!.policies as never[])
    } else if (bare === 'list_ships' && Array.isArray(d?.ships)) {
      replaceShipsForProfile(profileId, d!.ships as never[])
    } else if (bare === 'get_ship' && Array.isArray(d?.modules)) {
      const shipId = String((d as Record<string, unknown>).ship_id ?? (d as Record<string, unknown>).id ?? 'active')
      recordShipModules(profileId, shipId, d!.modules as never[])
    } else if ((bare === 'shipping_list' || bare === 'shipping') && Array.isArray(d?.shipments)) {
      const rows = (d!.shipments as Array<Record<string, unknown>>).map((s) => {
        const c = (s.contract ?? s) as Record<string, unknown>
        return {
          contract_id: String(c.contract_id ?? c.id ?? s.id ?? ''),
          origin_base: String(c.origin_base_id ?? c.origin ?? ''),
          dest_base: String(c.destination_base_id ?? c.destination ?? ''),
          base_reward: Number(c.base_reward ?? 0) || 0,
          appraised_value: Number(c.appraised_value ?? 0) || 0,
          status: c.breached_at ? 'breached' : c.delivered_at ? 'delivered' : c.accepted_at && String(c.accepted_at) > '0002' ? 'accepted' : 'open',
          accepted_at: String(c.accepted_at ?? ''),
          completed_at: String(c.delivered_at ?? c.breached_at ?? ''),
        }
      })
      upsertFreightContracts(profileId, rows)
    }
    // Learned jump-graph edges — shape-sniffed from ANY result rather than keyed on
    // command names, because connections lists appear on jump, travel, dock, get_system
    // and get_status results alike. Each arrival teaches the destination's whole node.
    captureSystemLinks(resultData, source)
    if (bare === 'get_empire_info' && resultData != null) {
      // http_v2 delivers structuredContent: { empires: [{ empire_id, *_bps rates,
      // eviction_grace_cycles, fuel_tax_per_unit, ... }] } — richer than the text
      // report and the reason the original text-only regex hook NEVER fired (weeks
      // of empty empire_policy_snapshots). Prefer the structured form; keep the
      // text parse as the v1/string fallback.
      const empires = Array.isArray(d?.empires) ? (d!.empires as Array<Record<string, unknown>>) : null
      if (empires) {
        const pct = (bps: unknown) => typeof bps === 'number' ? `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%` : ''
        for (const e of empires) {
          const id = String(e.empire_id ?? '')
          if (!id) continue
          recordEmpirePolicy(id, {
            property: pct(e.property_tax_bps),
            income: pct(e.income_tax_bps),
            salesCitizen: pct(e.sales_tax_bps),
            evictionGrace: Number(e.eviction_grace_cycles) || 0,
            fuelTax: Number(e.fuel_tax_per_unit) || 0,
          }, JSON.stringify(e))
        }
      } else if (typeof resultData === 'string') {
        const text = resultData
        const re = /=== (\w+) ===/g
        let m: RegExpExecArray | null
        const marks: Array<{ empire: string; at: number }> = []
        while ((m = re.exec(text))) marks.push({ empire: m[1], at: m.index })
        for (let i = 0; i < marks.length; i++) {
          const block = text.slice(marks[i].at, marks[i + 1]?.at ?? text.length)
          const g = (rx: RegExp) => (block.match(rx) ?? [])[1] ?? ''
          recordEmpirePolicy(marks[i].empire, {
            property: g(/Property tax[^%]*?Rate: ([\d.]+%)/s),
            income: g(/Income tax[^%]*?Rate: ([\d.]+%)/s),
            salesCitizen: g(/Citizens: ([\d.]+%)/),
            evictionGrace: Number(g(/Eviction grace: (\d+)/)) || 0,
            fuelTax: Number(g(/Fuel tax: (\d+)/)) || 0,
          }, block)
        }
      }
    }
  } catch (err) {
    // Never break execution — but never hide the miss either: a silent catch here
    // cost weeks of empty empire_policy_snapshots before anyone noticed.
    console.warn(`[Capture] ${command} capture failed:`, (err as Error)?.message ?? err)
  }
}

/**
 * Book credit movements from a command result — the ONE ledger chokepoint for BOTH
 * command paths: executeTool's resolved-success path and Agent.executeCommand
 * (manual/API, silent included). Booking used to live only on the tool path, so
 * silent mutations bypassed the ledger entirely: three silent send_gift refunds
 * (212,618cr) left Morg's wallet on 2026-08-25 with zero ledger rows while every
 * response confirmed credits_sent.
 *
 * Queries book nothing (no credits move). Action-pending echoes book nothing — the
 * resolved result repeats the same trade payload, and booking both double-counts
 * (same rule as executeTool's sentinel path, which returns before its booking site).
 * Callers pass success results only: a refused or errored command moved nothing.
 */
export function bookLedgerFromCommand(
  command: string,
  commandArgs: Record<string, unknown> | undefined,
  resultData: unknown,
  resultText: string,
  profileId: string,
  profileName: string,
): void {
  if (isQueryCommand(command)) return
  const lower = resultText.toLowerCase()
  if (lower.includes('action pending') || lower.includes('resolves next tick') || lower.includes('already pending')) return
  try {
    LedgerCollector.processCommandResult(command, resultData, profileId, profileName, commandArgs)
  } catch { /* ledger must never break game execution */ }
  // Player-to-player credit gifts via deposit{credits,target} carry no bookable
  // fields in the result — book from the args (these bypassed the ledger until 2026-07-21).
  try {
    const bareG = command.replace(/^spacemolt_/, '').replace(/^storage_/, '')
    const giftCredits = Number(commandArgs?.credits ?? 0)
    const giftTarget = String(commandArgs?.target ?? '')
    if (bareG === 'deposit' && giftCredits > 0 && giftTarget && giftTarget.toLowerCase() !== 'faction') {
      LedgerCollector.bookGift(profileId, giftTarget, giftCredits)
    }
  } catch { /* ledger must never break game execution */ }
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  reason?: string,
): Promise<string> {
  if (LOCAL_TOOLS.has(name)) {
    ctx.log('tool_call', `${name}(${formatArgs(args)})`)
    return executeLocalTool(name, args, ctx)
  }

  if (MACRO_TOOLS.has(name)) {
    ctx.log('tool_call', `${name}(${formatArgs(args)})`)
    const summary = await executeMacroTool(name, args, ctx, reason)
    // A macro just performed real game actions: refresh passive awareness and
    // arm the normal cooldown so the next direct action is properly paced.
    actionCooldowns.set(ctx.profileId, { timestamp: Date.now(), wasPending: false })
    invalidateBriefingCache(ctx.profileId, ctx.connection)
    ctx.log('tool_result', truncate(summary, 200), summary)
    return summary
  }

  let command: string
  let commandArgs: Record<string, unknown> | undefined
  if (name === 'game') {
    command = String(args.command || '')
    commandArgs = args.args as Record<string, unknown> | undefined
    if (!command) return 'Error: missing \'command\' argument'
    // Models sometimes flatten command args to the top level — game({command:'deposit',
    // item_id:'x'}) instead of game({command:'deposit', args:{item_id:'x'}}). Those keys
    // were silently dropped (observed live: 10 consecutive argless deposit calls).
    // Fold any extra top-level keys into the command args; explicit args.args wins.
    const extras: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args)) {
      if (k !== 'command' && k !== 'args' && v !== undefined) extras[k] = v
    }
    if (Object.keys(extras).length > 0) commandArgs = { ...extras, ...(commandArgs ?? {}) }
  } else {
    command = name
    commandArgs = Object.keys(args).length > 0 ? args : undefined
  }

  // Repair two malformations seen from gpt-oss models on the local MLX server.
  // Both are recoverable with certainty, and both otherwise cost a full tool
  // round out of the turn's 12 on a guaranteed `unknown_command`.
  //
  // 1. Leaked harmony control tokens. gpt-oss speaks the harmony format, whose
  //    channel markers (`<|channel|>`, `<|message|>`, ...) are meant to be
  //    consumed by the serving layer's parser. It occasionally emits one inside
  //    a tool call instead: `facility<|channel|>commentary`. Everything from the
  //    first marker on is transcript, not command.
  //
  // 2. A game() call nested inside another game(), which is how the same
  //    malformation usually arrives in practice — observed verbatim:
  //    `game(game<|channel|>commentary, command=spacemolt_market_view_market
  //    args={"item_id":"cargo_expander_i"})`. Stripping the marker alone leaves
  //    the bare wrapper name `game`, which is still not a command; the real call
  //    is one level down in the args.
  //
  // Interleaved because unwrapping can expose another marked name. Bounded, so
  // a pathological payload cannot spin here.
  for (let pass = 0; pass < 3; pass++) {
    if (command.includes('<|')) {
      const cleaned = command.slice(0, command.indexOf('<|')).trim()
      if (!cleaned) break
      ctx.log('system', `Stripped model control tokens from command name: "${command}" -> "${cleaned}"`)
      command = cleaned
    }
    // Only unwrap the wrapper tool's own name. Unwrapping any command that
    // happens to carry a `command` argument would corrupt legitimate calls.
    const nested = commandArgs?.command
    if ((command === 'game' || command === 'spacemolt_game') && typeof nested === 'string' && nested) {
      const innerArgs = commandArgs?.args
      ctx.log('system', `Unwrapped nested game() call: "${command}" -> "${nested}"`)
      command = nested
      commandArgs = innerArgs && typeof innerArgs === 'object' && !Array.isArray(innerArgs)
        ? innerArgs as Record<string, unknown>
        : undefined
      continue
    }
    break
  }

  // The model sometimes names a LOCAL tool inside game(): sell_cargo, codex,
  // goto_system... Sent to the server those are unknown_command and the round
  // is gone. Run the tool it meant and say so, so the next call is the right shape.
  if (name === 'game' && (LOCAL_TOOLS.has(command) || MACRO_TOOLS.has(command))) {
    ctx.log('system', `Dispatched game(${command}) to the local tool ${command} — game() is for server commands only`)
    const out = await executeTool(command, commandArgs ?? {}, ctx, reason)
    return (
      `${out}\n\n(Dispatched: "${command}" is a LOCAL tool, not a game command — the harness ran ` +
      `${command}(${formatArgs(commandArgs ?? {})}) for you. Call the ${command} tool directly next time.)`
    )
  }

  // lib_v2 has no route for the v2 GROUP form (`facility` + {action:'list'}):
  // those fell through to REST v1 and failed there. Rewrite to the flat name
  // the route index knows. battle(action=reload) is the plain `reload` command.
  if (ctx.connection.mode === 'lib_v2' && commandArgs && typeof commandArgs.action === 'string') {
    const group = command.replace(/^spacemolt_/, '')
    if (V2_GROUPS.has(group)) {
      const action = (commandArgs.action as string).trim().toLowerCase()
      const flat = group === 'battle' && action === 'reload' ? 'reload' : `${group}_${action}`
      ctx.log('system', `Rewrote group form ${group}(action=${action}) -> ${flat} (no lib_v2 route for the group form)`)
      command = flat
      delete commandArgs.action
    }
  }

  // Auto-correct common parameter mistakes to reduce wasted API calls
  if (commandArgs) {
    const bare = command.replace(/^spacemolt_/, '')
    // reload: the real signature is reload(id=<weapon instance id>, target=<ammo
    // item id>). Agents write the v1 doc names (weapon_instance_id / ammo_item_id)
    // and burn the round on invalid_payload.
    if ((bare === 'reload' || bare.endsWith('_reload')) && ctx.connection.mode === 'lib_v2') {
      for (const k of ['weapon_instance_id', 'weapon_id', 'module_id', 'instance_id', 'weapon']) {
        if (!commandArgs.id && commandArgs[k]) { commandArgs.id = commandArgs[k]; delete commandArgs[k] }
      }
      for (const k of ['ammo_item_id', 'ammo_id', 'ammo', 'item_id']) {
        if (!commandArgs.target && commandArgs[k]) { commandArgs.target = commandArgs[k]; delete commandArgs[k] }
      }
    }
    // travel uses target_poi, not destination/target_system/target
    if ((bare === 'travel' || bare.endsWith('_travel')) && !commandArgs.target_poi) {
      if (commandArgs.destination) { commandArgs.target_poi = commandArgs.destination; delete commandArgs.destination }
      else if (commandArgs.target) { commandArgs.target_poi = commandArgs.target; delete commandArgs.target }
      else if (commandArgs.target_system) { commandArgs.target_poi = commandArgs.target_system; delete commandArgs.target_system }
    }
    // travel/dock: auto-fix POI names to snake_case (e.g. "Cargo Station" → "cargo_station")
    if (bare === 'travel' || bare.endsWith('_travel') || bare === 'dock' || bare.endsWith('_dock')) {
      const poi = String(commandArgs.target_poi || '')
      if (poi && poi !== poi.toLowerCase().replace(/\s+/g, '_')) {
        commandArgs.target_poi = poi.toLowerCase().replace(/\s+/g, '_')
      }
    }
    // jump uses target_system, not destination/target/target_poi
    if ((bare === 'jump' || bare.endsWith('_jump')) && !commandArgs.target_system) {
      if (commandArgs.destination) { commandArgs.target_system = commandArgs.destination; delete commandArgs.destination }
      else if (commandArgs.target) { commandArgs.target_system = commandArgs.target; delete commandArgs.target }
      else if (commandArgs.target_poi) { commandArgs.target_system = commandArgs.target_poi; delete commandArgs.target_poi }
    }
    // find_route uses target_system, not destination/text/target
    if ((bare === 'find_route' || bare.endsWith('_find_route')) && !commandArgs.target_system) {
      if (commandArgs.destination) { commandArgs.target_system = commandArgs.destination; delete commandArgs.destination }
      else if (commandArgs.target) { commandArgs.target_system = commandArgs.target; delete commandArgs.target }
      else if (commandArgs.text) { commandArgs.target_system = commandArgs.text; delete commandArgs.text }
    }
    // find_route / jump: auto-fix station names passed as system names
    // e.g. "Grand Exchange Station" → "haven", "Starfall Salvage Station" → "starfall"
    if (bare === 'find_route' || bare.endsWith('_find_route') || bare === 'jump' || bare.endsWith('_jump')) {
      const ts = String(commandArgs.target_system || '')
      if (ts && /station|exchange|colony|outpost|hub|depot|citadel|nexus|resort/i.test(ts)) {
        // Strip common station suffixes to extract likely system name
        const cleaned = ts.replace(/\s*(station|exchange|colony|outpost|hub|depot|citadel|nexus|resort|salvage|mining|industrial|colonial|processing|freight|research)\s*/gi, ' ').trim().replace(/\s+/g, '_').toLowerCase()
        commandArgs.target_system = cleaned
      }
    }
    // search_systems uses query, not text
    if ((bare === 'search_systems' || bare.endsWith('_search_systems')) && !commandArgs.query && commandArgs.text) {
      commandArgs.query = commandArgs.text; delete commandArgs.text
    }
    // catalog uses type, not category; also fix singular→plural and default to 'items' if missing
    if (bare === 'catalog' || bare.endsWith('_catalog')) {
      if (!commandArgs.type && commandArgs.category) { commandArgs.type = commandArgs.category; delete commandArgs.category }
      if (!commandArgs.type && commandArgs.search) { commandArgs.type = 'items' } // default to items search
      const SINGULAR_FIX: Record<string, string> = { recipe: 'recipes', skill: 'skills', ship: 'ships', item: 'items' }
      if (commandArgs.type && SINGULAR_FIX[commandArgs.type]) { commandArgs.type = SINGULAR_FIX[commandArgs.type] }
    }
    // view_market: strip unknown params — only item_id and category are valid
    if (bare === 'view_market' || bare === 'market_view_market' || bare.endsWith('_view_market')) {
      if (commandArgs.search && !commandArgs.item_id) { commandArgs.item_id = commandArgs.search; delete commandArgs.search }
      if (commandArgs.item && !commandArgs.item_id) { commandArgs.item_id = commandArgs.item; delete commandArgs.item }
    }
    // analyze_market: needs search param, not item_id
    if (bare === 'analyze_market' || bare === 'market_analyze_market' || bare.endsWith('_analyze_market')) {
      if (commandArgs.item_id && !commandArgs.search) { commandArgs.search = commandArgs.item_id; delete commandArgs.item_id }
      if (commandArgs.item && !commandArgs.search) { commandArgs.search = commandArgs.item; delete commandArgs.item }
    }
    // send_chat: fix common channel names
    if (bare === 'send_chat' || bare === 'social_send_chat' || bare.endsWith('_send_chat')) {
      const ch = String(commandArgs.channel || '').toLowerCase()
      const CHANNEL_FIX: Record<string, string> = { 'global': 'system', 'general': 'system', 'local': 'system', 'faction': 'faction', 'trade': 'trading', 'help': 'system' }
      if (ch && CHANNEL_FIX[ch]) { commandArgs.channel = CHANNEL_FIX[ch] }
      // Truncate over-long messages before send — the game rejects them with [message_too_long]
      // (232 wasted calls in 36h), usually from agents pasting multi-paragraph SITREPs into chat.
      const CHAT_MAX = 480
      for (const k of ['content', 'message', 'text']) {
        const v = commandArgs[k]
        if (typeof v === 'string' && v.length > CHAT_MAX) commandArgs[k] = safeTruncate(v, CHAT_MAX - 1, '…')
      }
    }
    // scan/attack: the game API expects `target_id`. Normalize id/target -> target_id.
    // (Do NOT rename target_id away — an earlier version mapped target_id -> id, which the
    //  current API rejects with [invalid_payload] Unknown parameter(s): id, making all
    //  combat impossible while gaslighting the agent into thinking it wrote the wrong key.)
    if (bare === 'scan' || bare.endsWith('_scan') || bare === 'attack' || bare.endsWith('_attack')) {
      if (commandArgs.id && !commandArgs.target_id) { commandArgs.target_id = commandArgs.id; delete commandArgs.id }
      if (commandArgs.target && !commandArgs.target_id) { commandArgs.target_id = commandArgs.target; delete commandArgs.target }
    }
    // items passed as a JSON string instead of an array (bulk deposit/withdraw) —
    // parse it so the server sees a real array (observed live: "Parameter 'items'
    // must be an array, but received a string").
    if (typeof commandArgs.items === 'string') {
      try {
        const parsed = JSON.parse(commandArgs.items as string)
        if (Array.isArray(parsed)) commandArgs.items = parsed
      } catch { /* leave as-is; server error will surface it */ }
    }
    // Strip empty-string values from args — they cause invalid_target/invalid_payload errors
    for (const key of Object.keys(commandArgs)) {
      if (commandArgs[key] === '' || commandArgs[key] === null || commandArgs[key] === undefined) {
        delete commandArgs[key]
      }
    }
  }

  // Normalize: strip spacemolt_ prefix from direct command names so http_v2 route map finds them.
  // e.g. "spacemolt_browse_ships" → "browse_ships", "spacemolt_catalog" → "catalog"
  // Grouped v2 names like "spacemolt_market_view_market" are already handled by the route map.
  if (command.startsWith('spacemolt_')) {
    command = command.slice('spacemolt_'.length)
  }

  // scan() with no target = agent wants to see nearby entities → redirect to get_nearby
  // scan REQUIRES a target_id/id; there is no "area scan" mode
  if ((command === 'scan' || command.endsWith('_scan')) && !commandArgs) {
    command = 'get_nearby'
  }

  // Redirect deprecated commands
  const bareFinal = command
  if (bareFinal === 'get_ships' || bareFinal.endsWith('_get_ships')) {
    command = command.replace('get_ships', 'browse_ships')
  }

  // Strip MCP v2 prefix (e.g. "spacemolt_get_system" → "get_system") for lookup,
  // then the v2 tool group prefix (e.g. "market_view_market" → "view_market").
  let bareCommand = command.replace(/^spacemolt_/, '')
  let deepBare = bareCommand.replace(GROUP_PREFIX_RX, '')

  // get_system / get_poi with a system argument. The game ignores the argument
  // and answers for the CURRENT system — 84 times in one day on one agent,
  // each silently wrong. get_map(system_id) IS honored, so a request for
  // another system is remapped to it and the fleet's own record for that
  // system is appended, labelled. A request for the current system (or no
  // argument) goes out live, untouched.
  let remapNote = ''
  let fleetRecord = ''
  if ((deepBare === 'get_system' || deepBare === 'get_poi') && commandArgs) {
    const keys = deepBare === 'get_system'
      ? ['system_id', 'id', 'system', 'system_name', 'target_system', 'name']
      : ['system_id', 'system', 'system_name', 'target_system']
    const key = keys.find((k) => typeof commandArgs![k] === 'string' && (commandArgs![k] as string).trim())
    if (key) {
      const requested = normalizeSystemId(String(commandArgs[key]))
      let cur = currentLocation(ctx)
      if (!cur.systemId) {
        // No cached position at all: one free get_status settles it rather than guessing.
        try {
          const r = await ctx.connection.execute('get_status')
          if (!r.error) observeTacticalResult(ctx.profileId, 'get_status', undefined, r.structuredContent ?? r.result)
        } catch { /* stay unknown */ }
        cur = currentLocation(ctx)
      }
      const isCurrent = !!cur.systemId &&
        (requested === cur.systemId || (!!cur.systemName && requested === normalizeSystemId(cur.systemName)))
      if (isCurrent || !cur.systemId) {
        // Live call for where you are; the argument is not a parameter the game knows.
        delete commandArgs[key]
        if (!cur.systemId) remapNote = `NOTE: ${deepBare} takes no system argument and reads only your current location; "${requested}" was ignored.\n`
      } else {
        remapNote =
          `NOTE: you are in ${cur.systemId}. ${deepBare} reads only your CURRENT system and cannot see "${requested}" — ` +
          `the game would have silently answered for ${cur.systemId}. Remapped to get_map(system_id="${requested}"), which the game honors.\n`
        fleetRecord = fleetRecordLine(requested)
        ctx.log('system', `Remapped ${deepBare}(${key}=${requested}) -> get_map(system_id=${requested}); agent is in ${cur.systemId}`)
        command = 'get_map'
        commandArgs = { system_id: requested }
      }
    }
    // get_poi with a POI argument naming somewhere else: same story, one level down.
    if (deepBare === 'get_poi' && command !== 'get_map') {
      const pk = ['poi_id', 'id', 'poi', 'target_poi'].find((k) => typeof commandArgs![k] === 'string' && (commandArgs![k] as string).trim())
      if (pk) {
        const want = String(commandArgs[pk]).toLowerCase().trim().replace(/\s+/g, '_')
        const cur = currentLocation(ctx)
        if (cur.poiId && want !== cur.poiId.toLowerCase()) {
          remapNote += `NOTE: get_poi reads only the POI you are AT (${cur.poiId}); it cannot describe "${want}". travel(target_poi="${want}") first if you need it.\n`
        }
        delete commandArgs[pk]
      }
    }
    bareCommand = command.replace(/^spacemolt_/, '')
    deepBare = bareCommand.replace(GROUP_PREFIX_RX, '')
  }

  // Admiral doctrine guards — shared with the manual/API path so a rule cannot
  // be enforced on one entry point and silently skipped on the other.
  {
    const refusal = checkDoctrineGuards(command, commandArgs, ctx.profileId, currentLocation(ctx).systemId)
    if (refusal) {
      ctx.log('tool_call', `game(${command}, ${formatArgs(commandArgs ?? {})})`)
      ctx.log('tool_result', refusal)
      return refusal
    }
  }

  // Docked-only command while the connection says docked_at is null: refuse
  // here, naming the station and the way to it. Repeats escalate like any
  // other identical failure — a refusal the model ignores is still a loop.
  {
    const refusal = await checkDockedState(ctx, deepBare, commandArgs)
    if (refusal) {
      ctx.log('tool_call', `game(${command}, ${formatArgs(commandArgs ?? {})})`)
      const esc = localRefusalRepeat(ctx, command, commandArgs, 'not_docked_local')
      const out = esc.flush ?? refusal + esc.note
      ctx.log('tool_result', out)
      return out
    }
  }

  // Buy with no ask at this station: the depth is known before the round trip.
  {
    const refusal = checkBuyAsk(ctx, deepBare, commandArgs)
    if (refusal) {
      ctx.log('tool_call', `game(${command}, ${formatArgs(commandArgs ?? {})})`)
      ctx.log('tool_result', refusal)
      return refusal
    }
  }

  // A raw jump departs exactly like goto_system does — same commitment gate,
  // same safety exemptions — so the macro cannot be bypassed by hand-flying.
  if (deepBare === 'jump') {
    const target = normalizeSystemId(String(commandArgs?.target_system ?? commandArgs?.id ?? ''))
    const refusal = checkRawJumpCommit(ctx, target)
    if (refusal) {
      ctx.log('tool_call', `game(${command}, ${formatArgs(commandArgs ?? {})})`)
      ctx.log('tool_result', refusal)
      return refusal
    }
  }

  const fmtArgs = commandArgs ? formatArgs(commandArgs) : ''
  ctx.log('tool_call', `game(${command}${fmtArgs ? ', ' + fmtArgs : ''})`)

  // Cooldown check for action commands to prevent spam loops
  const isQuery = isQueryCommand(command, commandArgs)

  // Reload is a mutation that consumes one cargo ammo item. Verify the target
  // against the free live get_ship query before spending the tick or the item.
  // This converts "reload a full gun" into a deterministic, informative no-op.
  if (deepBare === 'reload') {
    try {
      const shipResp = await ctx.connection.execute('get_ship')
      if (!shipResp.error) {
        const verdict = fullWeaponReloadVerdict(shipResp.structuredContent ?? shipResp.result, commandArgs)
        if (verdict) {
          ctx.log('tool_result', verdict)
          return verdict
        }
      }
    } catch { /* inability to verify must not block a legitimate reload */ }
  }

  if (!isQuery) {
    let remainingMs = actionCooldownRemaining(ctx.profileId)
    if (remainingMs !== null && remainingMs <= COOLDOWN_ABSORB_MAX_MS) {
      // Short residual cooldown: wait it out here and re-check the gate once, transparently —
      // the LLM never sees the block, so the turn continues instead of ending early.
      ctx.log('system', `Cooldown: ${command} — ${(remainingMs / 1000).toFixed(1)}s remaining, absorbing server-side (wait + retry, not surfaced)`)
      await new Promise<void>((r) => setTimeout(r, Math.min(remainingMs, COOLDOWN_ABSORB_MAX_MS)))
      remainingMs = actionCooldownRemaining(ctx.profileId) // single retry; if re-armed meanwhile, surface below
    }
    if (remainingMs !== null) {
      const waitSec = Math.ceil(remainingMs / 1000)
      ctx.log('tool_result', `Cooldown: ${command} blocked (${waitSec}s remaining)`)
      return `${COOLDOWN_BLOCKED_SENTINEL} — cooldown active (${waitSec}s remaining). Game actions cost 1 tick (~10s). You just performed an action. Use query commands (get_status, get_cargo, view_market, read_todo, etc.) while waiting, or STOP calling tools and end your turn.`
    }
    actionCooldowns.set(ctx.profileId, { timestamp: Date.now(), wasPending: false })
  }

  // Extended query cache only. The situational briefing is NO LONGER used to short-circuit an
  // agent's explicit query calls. When an agent deliberately runs get_status / get_system /
  // get_active_missions / get_cargo / get_nearby, it must always receive LIVE ground-truth — never a
  // lossy or stale briefing snapshot. Intercepting these caused agents to (a) get a summary-only
  // get_system with no POI ids/types (breaking pirate-belt hunting), (b) act on the wrong system
  // after a jump, and (c) loop "the cache is stale, force a fresh query", burning turns. The briefing
  // still provides zero-token passive awareness via the system prompt; it just never overrides an
  // explicit query. In-game queries are free (no tick), so this costs only a round-trip.
  if (isQuery && getPreference('situational_briefing') !== 'off') {
    // Extended query cache: catalog (static, 1h TTL) and market queries (60s TTL)
    const cacheKey = `${ctx.profileId}:${canonicalKey(command, commandArgs)}`
    const cached = queryCache.get(cacheKey)
    const CATALOG_COMMANDS = new Set(['catalog', 'browse_ships', 'commission_quote'])
    const MARKET_COMMANDS = new Set(['view_market', 'analyze_market', 'view_orders', 'estimate_purchase'])
    const isCatalog = CATALOG_COMMANDS.has(deepBare)
    const isMarket = MARKET_COMMANDS.has(deepBare)
    if (cached && (isCatalog || isMarket)) {
      const ttl = isCatalog ? 3600_000 : 60_000 // 1h for catalog, 60s for market
      if (Date.now() - cached.timestamp < ttl) {
        const hint = `[Cached ${isCatalog ? 'catalog' : 'market'} data, ${Math.round((Date.now() - cached.timestamp) / 1000)}s old]\n${cached.result}`
        ctx.log('tool_result', `(cached) ${truncate(cached.result, 150)}`)
        noteDestinationWork(ctx.profileId, command)
        return hint
      }
    }
  }

  try {
    // A movement going out makes any cached location older than it suspect.
    noteMovement(ctx.profileId, command)
    const resp = await ctx.connection.execute(command, commandArgs && Object.keys(commandArgs).length > 0 ? commandArgs : undefined)

    if (resp.error) {
      let errMsg = `Error: [${resp.error.code}] ${resp.error.message}`

      // Augment common errors with actionable hints to reduce wasted turns
      const errCode = resp.error.code

      // Remember a reputation refusal so the dock gate can stop the repeat trip
      // to THIS system — keyed on location.system_id, labelled with the station.
      if (errCode === 'insufficient_reputation') {
        const cur = currentLocation(ctx)
        const label = String(cur.dockedAt ?? cur.poiName ?? cur.poiId ?? cur.systemName ?? cur.systemId ?? 'that station')
        noteReputationRefusal(ctx.profileId, errMsg, { systemId: cur.systemId, label })
        const here = cur.systemName ?? cur.systemId ?? 'this system'
        errMsg += `\n\nReputation does not recover by returning. Do NOT route back to ${here} — go to a station of a faction you have not attacked (your home space is crimson_war_citadel at Krynn), and record in your TODO that this one is closed to you.`
      }

      // The battle has already dropped you. Re-issuing battle commands here is
      // the loop that kept a hunter parked next to the thing he escaped from.
      if (errCode === 'not_in_battle') {
        tacticalFor(ctx.profileId).lastBattleAt = Date.now()
        errMsg += `\n\n💡 HINT: not_in_battle right after an escape/retreat means the battle has already DROPPED you — you are out and free to move. Do not re-issue battle commands; jump away now (jump(target_system="<adjacent system>")) before anything re-engages.`
      }

      // A `no_facility` refusal names the nearest public site for the recipe. That sentence
      // is free intelligence the fleet has been discarding — it is the only reason we ever
      // located the Legend's Anvil, the Heavy Railgun Assembly Facility or the Thorium
      // Roaster, and only after agents had flown to the wrong station first. Bank it.
      if (errCode === 'no_facility') {
        try {
          const recipeId = String(commandArgs?.id ?? commandArgs?.recipe_id ?? '')
          FleetIntelCollector.processNoFacility(resp.error.message, recipeId, ctx.profileName)
        } catch { /* intel capture must never break execution */ }
      }

      if (errCode === 'invalid_poi') {
        const target = commandArgs?.target_poi || commandArgs?.target || ''
        const snaked = String(target).toLowerCase().replace(/\s+/g, '_')
        const snakeHint = target !== snaked ? ` POI names use snake_case format (e.g. "${snaked}").` : ''
        errMsg += `\n\n💡 HINT: "${target}" was not found as a POI at your current location.${snakeHint} Use get_poi() to see available POIs here. If "${target}" is a star system (not a POI), use jump(target_system="${snaked}") instead of travel().`
      }
      if (errCode === 'not_connected') {
        // Agent tried to jump to a non-adjacent system — suggest find_route
        const target = commandArgs?.target_system || commandArgs?.target || ''
        errMsg += `\n\n💡 HINT: "${target}" is not adjacent to your current system. Use find_route(target_system="${target}") first to get a step-by-step route, then jump along each hop.`
      }
      if (errCode === 'unknown_command') {
        errMsg += `\n\n💡 HINT: Use help() to see all available commands, or catalog() to browse game data.`
      }
      if (errCode === 'connection_failed') {
        errMsg += `\n\n💡 HINT: The game connection is down. You CANNOT fix this — login and reconnection are managed by the harness, not by game commands, so do NOT call login or keep retrying. Stop issuing commands and end your turn; the connection will be restored automatically.`
      }
      if (errCode === 'not_docked' || errCode === 'no_base') {
        // Name the station and the way to it when the tool layer knows them,
        // so the agent is not sent off to get_poi/get_system for the answer.
        const route = describeDockRoute(ctx, deepBare)
        errMsg += route
          ? `\n\n💡 HINT: You must be docked at a station for this. ${route}`
          : `\n\n💡 HINT: You must be docked at a station for this action. Use get_poi() to check if your current location has a base, then dock() to dock. If there's no base here, travel(target_poi="...") to a station POI first.`
      }
      if (errCode === 'invalid_channel') {
        errMsg += `\n\n💡 HINT: Valid chat channels are: "system" (all players in system), "local" (players at your POI), "faction" (faction members), "private" (DM — requires target_id). There is no "global", "general", or "trade" channel.`
      }
      if (errCode === 'system_not_found') {
        const target = commandArgs?.target_system || commandArgs?.target || ''
        errMsg += `\n\n💡 HINT: "${target}" was not found as a system name. If you used a station name (e.g. "Grand Exchange Station"), use the system name instead (e.g. "haven"). Use search_systems(query="...") to find the correct system name.`
      }
      if (errCode === 'invalid_target') {
        const target = commandArgs?.target_id || commandArgs?.target || ''
        if (!target && (deepBare === 'scan' || deepBare === 'attack')) {
          errMsg += `\n\n💡 HINT: ${deepBare}() requires a target_id. Use get_nearby() first to see players/NPCs at your location, then ${deepBare}(target_id="their_id").`
        } else {
          errMsg += `\n\n💡 HINT: Target "${target}" is not at your current location. Use get_nearby() to see who is here. The target may have left or you may have the wrong ID.`
        }
      }
      if (errCode === 'invalid_type') {
        errMsg += `\n\n💡 HINT: Valid catalog types are: "ships", "skills", "recipes", "items". Use catalog(type="items") for materials/resources, catalog(type="recipes") for crafting recipes.`
      }
      if (errCode === 'invalid_payload') {
        if (deepBare === 'view_market' || deepBare === 'market_view_market') {
          errMsg += `\n\n💡 HINT: view_market accepts only "item_id" and "category" parameters. There is no "scope" or "search" parameter. Use catalog(search="...", type="items") to search items first, then view_market(item_id="exact_id") to see market data. For galaxy-wide trade intel, use intel_query_trade_intel(item_id="...").`
        }
      }

      // Identical-failure loop breaker (see recentFailures above): on the 3rd identical
      // (command, args, error) inside the window, make the result visibly DIFFERENT so the
      // agent's context stops deterministically reproducing the same retry.
      {
        const repeats = recordFailureAndCountRepeats(ctx.profileId, command, commandArgs, String(errCode))
        if (repeats >= FAILURE_LOOP_FLUSH_THRESHOLD) {
          // The note fired at FAILURE_LOOP_THRESHOLD and was ignored — this
          // context is deterministically stuck. Request an automatic flush.
          contextFlushRequests.add(ctx.profileId)
          recentFailures.delete(ctx.profileId)
          const flushMsg =
            `${LOOP_FLUSH_SENTINEL}this exact call has now failed identically ${repeats} times, ` +
            `straight through the LOOP BREAK warning. Your turn is ending and your conversation ` +
            `context will be reset — you will restart fresh from your directive.`
          ctx.log('system', `[loop-break] ESCALATION: ${command} failed identically ${repeats}x through the injected note — automatic context flush requested`)
          ctx.log('tool_result', flushMsg)
          return flushMsg
        }
        if (repeats >= FAILURE_LOOP_THRESHOLD) {
          errMsg +=
            `\n\n🔁🔁🔁 LOOP BREAK — READ THIS 🔁🔁🔁\n` +
            `You have now issued this EXACT call (same command, same arguments) ${repeats} times ` +
            `in the last few minutes and received the SAME error every time. The game state that ` +
            `produced this error has not changed, so repeating the call CANNOT succeed. Do NOT ` +
            `issue it again. Choose a DIFFERENT approach: change the arguments, run a free query ` +
            `(get_status, get_poi, get_system, find_route, help) to re-check the assumption behind ` +
            `this call, pick a different command entirely, or end your turn and record the blocker ` +
            `in your status/todo so the Admiral can see it.`
          ctx.log('system', `[loop-break] ${command} failed identically ${repeats}x within ${FAILURE_LOOP_WINDOW_MS / 60_000}min ([${errCode}]) — injected LOOP BREAK`)
        }
      }

      ctx.log('tool_result', errMsg)
      return errMsg
    }

    // MCP v2 returns structuredContent (JSON) separately from result (text summary).
    // Prefer structuredContent for the LLM — it has the actual data.
    const resultData = resp.structuredContent ?? resp.result
    let result = formatToolResult(command, resultData, resp.notifications)

    // Field-first rendering for the reads whose tails were getting cut: fuel,
    // hull and mission counters go at the top so no cap can drop them.
    {
      const prelude = keyFieldsPrelude(deepBare, resultData)
      if (prelude) result = `${prelude}\n${result}`
    }
    if (remapNote) result = remapNote + result

    // Bank position / docking / threat / market observations for the gates,
    // and credit real work against the current destination — on SUCCESS only,
    // so a failed dock cannot clear the destination commitment.
    observeTacticalResult(ctx.profileId, command, commandArgs, resultData, resp.notifications)
    noteDestinationWork(ctx.profileId, command)

    // A specific-item market read should answer the question the agent is
    // actually asking: "can I buy this here?" Raw best_buy/best_sell fields
    // made a BID look like cheap inventory and sustained station-to-station
    // sourcing loops. Put the computed verdict before the raw book.
    if (deepBare === 'view_market') {
      const verdict = buildMarketPurchaseVerdict(resultData, commandArgs)
      if (verdict) {
        let deadEnd = ''
        const now = Date.now()
        let recent = (marketNoSupply.get(ctx.profileId) ?? [])
          .filter(x => now - x.timestamp < MARKET_DEAD_END_WINDOW_MS)
        if (verdict.unavailable) {
          recent = recent.filter(x => !(x.itemId === verdict.itemId && x.baseId === verdict.baseId))
          recent.push({ itemId: verdict.itemId, baseId: verdict.baseId, timestamp: now })
          const stations = new Set(recent.filter(x => x.itemId === verdict.itemId).map(x => x.baseId))
          if (stations.size >= 2) {
            deadEnd = `\nSOURCING DEAD END — ${verdict.itemId} was unavailable at ${stations.size} recently checked stations. Stop making this purchase a prerequisite: update the TODO with the blocker and continue the higher-level mission.`
          }
        } else {
          recent = recent.filter(x => x.itemId !== verdict.itemId)
        }
        marketNoSupply.set(ctx.profileId, recent)
        result = verdict.message + deadEnd + '\n\n' + result
      }
    }

    // Order-book legend. The game's field names are adversarial — `best_buy` is
    // the BID (station pays you) and `best_sell` is the ASK (you pay). Three
    // agents across two model families have inverted them (Grit −14,424cr,
    // Morg's carbon ore, v2 throughout). Gloss every market read at the source
    // so no model has to infer the semantics from bare field names.
    {
      const bareM = command.replace(/^spacemolt_/, '').replace(/^market_/, '')
      if (bareM === 'view_market' || bareM === 'analyze_market' || bareM === 'view_orders') {
        const legend =
          `ORDER BOOK LEGEND — read before acting:\n` +
          `  best_buy  = BID = what the station PAYS YOU when you sell (with best_buy_qty depth).\n` +
          `  best_sell = ASK = what YOU PAY when you buy.\n` +
          `  Profit means selling into a BID somewhere that is HIGHER than the ASK you paid.\n` +
          `  Buying at the ask and selling into the bid at the SAME station is always a loss.\n`
        if (result.startsWith('PURCHASE VERDICT')) {
          const split = result.indexOf('\n\n')
          result = split >= 0
            ? result.slice(0, split) + '\n\n' + legend + result.slice(split + 2)
            : result + '\n\n' + legend
        } else {
          result = legend + result
        }
      }
    }

    // Query-loop breaker: the failure breaker's success-side twin. Bob (v3,
    // 2026-08-27) re-read the same mission board 6+ times with an identical
    // thought — every call SUCCEEDED, so the failure breaker never fired, and
    // an unchanged context kept reproducing the same re-read instead of a
    // decision. get_status is exempt: agents legitimately re-poll it while a
    // jump or macro is in flight.
    {
      const bareQ = command.replace(/^spacemolt_/, '')
      if (bareQ !== 'get_status' && isQueryCommand(command, commandArgs)) {
        const repeats = recordFailureAndCountRepeats(ctx.profileId, command, commandArgs, '__ok__')
        if (repeats >= QUERY_LOOP_FLUSH_THRESHOLD) {
          // Note injected at 4 and ignored — escalate to an automatic context flush.
          contextFlushRequests.add(ctx.profileId)
          recentFailures.delete(ctx.profileId)
          const flushMsg =
            `${LOOP_FLUSH_SENTINEL}you have now run this exact query ${repeats} times, straight ` +
            `through the QUERY LOOP warning. Your turn is ending and your conversation context ` +
            `will be reset — you will restart fresh from your directive.`
          ctx.log('system', `[loop-break] ESCALATION: ${command} repeated ${repeats}x through the injected note — automatic context flush requested`)
          ctx.log('tool_result', flushMsg)
          return flushMsg
        }
        if (repeats >= 4) {
          result +=
            `\n\n🔁 QUERY LOOP — you have run this exact query ${repeats} times in a few minutes ` +
            `and the answer is not changing. You already have this information. Your next action ` +
            `must be a DECISION that uses it (accept something, travel somewhere, buy/sell, or ` +
            `record a blocker and move on) — never this query again.`
          ctx.log('system', `[loop-break] ${command} repeated identically ${repeats}x while succeeding — injected QUERY LOOP note`)
        }
      }
    }

    // A commission_quote is the only authoritative statement of what the ship needs, and it is
    // a FREE query — so bank it whenever one goes past. The craft guard below reads these rows
    // instead of a hardcoded list, which means it tracks delivered lines as the order evolves.
    {
      const bare = command.replace(/^spacemolt_/, '').replace(/^ship_/, '')
      if (bare === 'commission_quote' || bare.endsWith('_commission_quote')) {
        try {
          const d = resultData as Record<string, unknown> | undefined
          const mats = d?.build_materials as Array<{ item_id?: string; quantity?: number }> | undefined
          const shipClass = String(d?.ship_class ?? commandArgs?.ship_class ?? commandArgs?.id ?? '').toLowerCase()
          if (shipClass && Array.isArray(mats) && mats.length) {
            setCommissionRequirements(
              shipClass,
              mats.filter((m) => m?.item_id && Number.isFinite(m.quantity))
                .map((m) => ({ item_id: String(m.item_id), quantity: Number(m.quantity) })),
              ctx.profileId,
            )
            ctx.log('system', `[commission] recorded ${mats.length} required lines for ${shipClass} — the craft guard now protects them (for this agent only).`)
          }
        } catch { /* capture must never break execution */ }
      }
    }

    // Self-accounting captures — shared with the manual/API command path.
    captureFromCommandResult(command, resultData, ctx.profileId, deepBare || 'result')

    // Price-sanity advisory on sells AND buys: catalog base_value vs price.
    // Advisory only — but the buy-side one is loud (267K overpay incident).
    const PRICE_ADVISED: Record<string, 'sell' | 'buy'> = {
      sell: 'sell', create_sell_order: 'sell', buy: 'buy', create_buy_order: 'buy',
    }
    const advisorySide = PRICE_ADVISED[deepBare]
    if (advisorySide) {
      try {
        const orders = Array.isArray(commandArgs?.orders)
          ? (commandArgs.orders as Array<Record<string, unknown>>)
          : [commandArgs ?? {}]
        const advisories = orders
          .map((o) => priceAdvisory(
            String(o.item_id ?? o.id ?? ''),
            Number(o.price_each ?? o.price ?? o.unit_price ?? NaN),
            advisorySide,
          ))
          .filter((a): a is string => !!a)
        if (advisories.length) result += '\n\n' + advisories.join('\n')
      } catch { /* advisory must never break execution */ }
    }
    ctx.log('tool_result', truncate(result, 200), result)

    // Detect "action pending" responses — enforce extended cooldown and signal turn exit
    const resultLower = result.toLowerCase()
    if (resultLower.includes('action pending') || resultLower.includes('resolves next tick') || resultLower.includes('already pending')) {
      ctx.log('tool_result', `Action pending detected for ${command} — extended cooldown enforced`)
      // Mark cooldown as pending so next action waits full tick duration
      actionCooldowns.set(ctx.profileId, { timestamp: Date.now(), wasPending: true })
      // Sentinel prefix triggers early turn exit in loop.ts
      const pendingResult = ACTION_PENDING_SENTINEL + result + '\n\n⚠️ STOP — Your action is QUEUED and will resolve on the next game tick (~10 seconds). Do NOT call this command again. Either use query commands (get_status, get_cargo, read_todo, view_market) to check on things, or end your turn and wait.'
      // Passively collect fleet intel. Pass resultData (structuredContent-preferred): under
      // lib_v2, resp.result is a text rendering — the parsed object the collector needs
      // (nearby players, market items, system POIs) only exists in structuredContent.
      try {
        FleetIntelCollector.processCommandResult(command, resultData, ctx.profileName)
        if (resp.notifications) FleetIntelCollector.processNotifications(resp.notifications, ctx.profileName)
        recordStorageFromCommand(command, resultData, ctx.profileId)
        recordCargoFromCommand(command, resultData, ctx.profileId)
      } catch { /* never break game execution */ }
      // Invalidate briefing cache — action changed game state; trigger async refresh
      invalidateBriefingCache(ctx.profileId, ctx.connection)
      return truncateResult(pendingResult, deepBare) + (fleetRecord ? `\n\n${fleetRecord}` : '')
    }

    // Passively collect fleet intel from game results (resultData: see note above —
    // lib_v2 puts the parsed object in structuredContent, resp.result is text).
    try {
      FleetIntelCollector.processCommandResult(command, resultData, ctx.profileName)
      if (resp.notifications) FleetIntelCollector.processNotifications(resp.notifications, ctx.profileName)
      recordStorageFromCommand(command, resultData, ctx.profileId)
      recordCargoFromCommand(command, resultData, ctx.profileId)
    } catch { /* never break game execution */ }

    // Book credit movements from the resolved result — via bookLedgerFromCommand, the
    // chokepoint shared with Agent.executeCommand so silent/manual mutations book
    // identically. The action-pending sentinel path above returned before this point
    // (the resolved result echoes the same trade payload again; booking both would
    // double-count every trade). Notification-borne credits (bounties, fills, mission
    // rewards) are NOT booked here: they attach to whatever response comes next (usually
    // a query) and are booked once in the Agent's onNotification handler — the chokepoint
    // every connection and command path funnels notifications through.
    if (!isQuery) {
      bookLedgerFromCommand(command, commandArgs, resultData, result, ctx.profileId, ctx.profileName)
      // Decrement Admiral sell quotas on successful locked-item sells/listings
      // (listing counts: escrowed stock has left vault control).
      try {
        const bareQ = command.replace(/^spacemolt_/, '').replace(/^market_/, '')
        if (bareQ === 'sell' || bareQ === 'create_sell_order') {
          const orders = Array.isArray(commandArgs?.orders)
            ? (commandArgs.orders as Array<Record<string, unknown>>)
            : [commandArgs ?? {}]
          // Charge the quota for what actually SOLD, not what was requested.
          //
          // This used to decrement by the requested quantity. Morg'Thar asked to sell
          // 2 fury_cannon into a book holding a single bid; one filled, and the quota
          // was consumed for both — silently destroying authorisation for a unit that
          // never left the vault. A thin order book should cost you a trip, not your
          // permission to sell.
          const filled = (() => {
            const d = (resultData ?? {}) as Record<string, unknown>
            const det = (d.details ?? d) as Record<string, unknown>
            for (const k of ['quantity_filled', 'filled', 'quantity_sold', 'sold_quantity']) {
              const n = Number(det[k])
              if (Number.isFinite(n) && n >= 0) return n
            }
            return null
          })()
          for (const o of orders) {
            const itemId = String(o.item_id ?? o.id ?? '').toLowerCase()
            const requested = Number(o.quantity ?? 0) || 0
            // Fall back to the requested amount only when the response does not report
            // a fill — never charge more than was asked for.
            const qty = filled === null ? requested : Math.min(filled, requested)
            if (itemId && qty > 0 && SELL_CARGO_ALWAYS_EXCLUDE.has(itemId)) {
              decrementSellQuota(ctx.profileId, itemId, qty)
            }
          }
        }
      } catch { /* never break game execution */ }
    }

    // After a successful action, invalidate caches so the next
    // query fetches live data instead of returning stale pre-action state.
    if (!isQuery) {
      invalidateBriefingCache(ctx.profileId, ctx.connection)
      // Also purge market query cache entries for this profile (catalog stays — it's static)
      for (const [key] of queryCache) {
        if (key.startsWith(ctx.profileId + ':') && !key.includes(':catalog:') && !key.includes(':browse_ships:') && !key.includes(':commission_quote:')) {
          queryCache.delete(key)
        }
      }
    }

    // Store cacheable query results for future intercept
    if (isQuery && getPreference('situational_briefing') !== 'off') {
      const CACHEABLE = new Set(['catalog', 'browse_ships', 'commission_quote', 'view_market', 'analyze_market', 'view_orders', 'estimate_purchase'])
      if (CACHEABLE.has(deepBare)) {
        const cacheKey = `${ctx.profileId}:${canonicalKey(command, commandArgs)}`
        queryCache.set(cacheKey, { result, timestamp: Date.now() })
        // Prune cache if it grows too large (max 200 entries)
        if (queryCache.size > 200) {
          const oldest = [...queryCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)
          for (let i = 0; i < 50; i++) queryCache.delete(oldest[i][0])
        }
      }
    }

    // TOP OFF ALWAYS: a manual dock refuels exactly like a macro dock does.
    const topOff = !isQuery && deepBare === 'dock' ? await autoTopOffAfterDock(ctx) : ''

    // The fleet record rides OUTSIDE the cap so a long map cannot cut it.
    return truncateResult(result, deepBare) + topOff + (fleetRecord ? `\n\n${fleetRecord}` : '')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const errMsg = `Error executing ${command}: ${msg}`
    ctx.log('error', errMsg)
    return errMsg
  }
}

/**
 * Identical local refusals escalate like identical game errors: a LOOP BREAK
 * note on the third, an automatic context flush past the sixth. A refusal the
 * model keeps walking into is the same deterministic replay the game-error
 * breaker exists for.
 */
function localRefusalRepeat(
  ctx: ToolContext,
  command: string,
  args: Record<string, unknown> | undefined,
  code: string,
): { flush: string | null; note: string } {
  const repeats = recordFailureAndCountRepeats(ctx.profileId, command, args, code)
  if (repeats >= FAILURE_LOOP_FLUSH_THRESHOLD) {
    contextFlushRequests.add(ctx.profileId)
    recentFailures.delete(ctx.profileId)
    ctx.log('system', `[loop-break] ESCALATION: ${command} refused locally ${repeats}x through the injected note — automatic context flush requested`)
    return {
      flush:
        `${LOOP_FLUSH_SENTINEL}this call has now been refused identically ${repeats} times, straight through ` +
        `the LOOP BREAK warning. Your turn is ending and your conversation context will be reset — you will ` +
        `restart fresh from your directive.`,
      note: '',
    }
  }
  if (repeats >= FAILURE_LOOP_THRESHOLD) {
    ctx.log('system', `[loop-break] ${command} refused locally ${repeats}x within ${FAILURE_LOOP_WINDOW_MS / 60_000}min (${code}) — injected LOOP BREAK`)
    return {
      flush: null,
      note:
        `\n\n🔁 LOOP BREAK — you have issued this exact call ${repeats} times and it is refused for the same ` +
        `reason every time. Nothing changes until you act on the instruction above.`,
    }
  }
  return { flush: null, note: '' }
}

/**
 * "The station here is X at POI Y — travel there, then dock" from what the
 * tool layer already knows about the current system. Empty when it knows
 * nothing (the caller falls back to the generic get_poi/get_system advice).
 */
function describeDockRoute(ctx: ToolContext, deep: string): string {
  try {
    const t = tacticalFor(ctx.profileId)
    const cur = currentLocation(ctx)
    if (!t.system || (cur.systemId && t.system.systemId !== cur.systemId)) return ''
    const bases = t.system.pois.filter((p) => p.has_base)
    if (bases.length === 0) return `There is NO station in ${cur.systemName ?? t.system.systemName} — nothing here to dock at; move to a system with one.`
    const here = cur.poiId ? bases.find((b) => b.id === cur.poiId) : undefined
    if (here) return `You are AT ${here.base_name ?? here.name} (POI ${here.id}) but not docked — run dock() first, then ${deep}.`
    const b = bases[0]
    return `The station here is ${b.base_name ?? b.name} at POI "${b.id}" — run travel(target_poi="${b.id}"), then dock(), then ${deep}.`
  } catch {
    return ''
  }
}

/**
 * The fields that must never fall off a truncated read. get_status/get_ship
 * lose fuel and hull past the cap; the mission boards lose their counters.
 * Rendered first, in one line (or one line per mission), before the YAML.
 */
function keyFieldsPrelude(deep: string, data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ''
  const d = data as Record<string, unknown>
  const str = (v: unknown): string | null => v === undefined || v === null || v === '' ? null : String(v)
  const pair = (a: unknown, b: unknown): string | null => {
    const x = str(a); const y = str(b)
    return x === null ? null : y === null ? x : `${x}/${y}`
  }
  try {
    if (deep === 'get_status' || deep === 'get_ship') {
      const ship = (d.ship && typeof d.ship === 'object' ? d.ship : deep === 'get_ship' ? d : {}) as Record<string, unknown>
      const loc = (d.location && typeof d.location === 'object' ? d.location : {}) as Record<string, unknown>
      const player = (d.player && typeof d.player === 'object' ? d.player : {}) as Record<string, unknown>
      const bits: string[] = []
      const cls = str(ship.class_id ?? ship.class)
      if (deep === 'get_ship' && cls) bits.push(`ship ${cls}`)
      const sys = str(loc.system_id ?? loc.system_name ?? player.current_system); if (sys) bits.push(`system ${sys}`)
      const poi = str(loc.poi_id ?? loc.poi_name ?? player.current_poi); if (poi) bits.push(`poi ${poi}`)
      if ('docked_at' in loc) bits.push(`docked_at ${loc.docked_at ? String(loc.docked_at) : 'null (IN SPACE)'}`)
      if (loc.in_transit === true) bits.push('IN TRANSIT')
      const fuel = pair(ship.fuel, ship.max_fuel ?? ship.fuel_capacity); if (fuel) bits.push(`fuel ${fuel}`)
      const hull = pair(ship.hull, ship.max_hull); if (hull) bits.push(`hull ${hull}`)
      const shield = pair(ship.shield, ship.max_shield); if (shield) bits.push(`shield ${shield}`)
      const cargo = pair(ship.cargo_used, ship.cargo_capacity ?? ship.max_cargo); if (cargo) bits.push(`cargo ${cargo}`)
      const credits = str(player.credits ?? d.credits); if (credits) bits.push(`credits ${credits}`)
      const pirates = typeof loc.nearby_pirate_count === 'number' ? loc.nearby_pirate_count
        : Array.isArray(loc.nearby_pirates) ? loc.nearby_pirates.length : null
      if (pirates !== null && pirates > 0) bits.push(`PIRATES HERE ${pirates}`)
      return bits.length ? `KEY FIELDS: ${bits.join(' | ')}` : ''
    }
    if (deep === 'get_missions' || deep === 'get_active_missions') {
      const ms = d.missions
      const list = Array.isArray(ms) ? ms
        : ms && typeof ms === 'object' && Array.isArray((ms as Record<string, unknown>).active) ? (ms as Record<string, unknown>).active as unknown[]
        : null
      if (!list) return ''
      const lines = list.slice(0, 20).map((m) => {
        const x = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
        const rewards = (x.rewards && typeof x.rewards === 'object' ? x.rewards : {}) as Record<string, unknown>
        const objs = Array.isArray(x.objectives) ? x.objectives as Array<Record<string, unknown>> : []
        const counter = objs
          .filter((o) => o && typeof o.current === 'number' && typeof o.required === 'number')
          .map((o) => `${o.current}/${o.required}`).join(',')
        const exp = str(x.expires_in_ticks)
        return `  - ${str(x.title ?? x.mission_id) ?? '?'}${x.type ? ` [${x.type}]` : ''}${counter ? ` ${counter}` : ''} reward ${str(rewards.credits) ?? '?'}cr${exp ? ` expires ${exp}t` : ''}`
      })
      return `KEY FIELDS: ${list.length} mission(s)${list.length > 20 ? ' (first 20 listed)' : ''}\n${lines.join('\n')}`
    }
  } catch { /* the prelude is a bonus */ }
  return ''
}

function executeLocalTool(name: string, args: Record<string, unknown>, ctx: ToolContext): string {
  switch (name) {
    case 'codex': {
      const result = codexLookup(args.kind as string | undefined, String(args.query ?? ''))
      ctx.log('tool_result', truncate(result, 200), result)
      return truncateResult(result)
    }
    case 'codex_chain': {
      const result = codexChain(String(args.item_id ?? ''), Number(args.quantity ?? 1))
      ctx.log('tool_result', truncate(result, 200), result)
      return truncateResult(result)
    }
    case 'fleet_route': {
      // BFS over the learned jump graph (system_links: every edge any agent has flown,
      // seeded from the galaxy map), with fleet-banned systems excluded outright. The
      // graph is partial by nature — answers are upper bounds, and "no route" only means
      // the fleet has not learned one yet.
      const FORBIDDEN = new Set(['goldcrest', 'bluerift'])
      const from = String(args.from ?? '').toLowerCase().trim()
      const to = String(args.to ?? '').toLowerCase().trim()
      let result: string
      if (!from || !to) {
        result = 'fleet_route needs both from and to system_ids.'
      } else {
        const adj = new Map<string, Set<string>>()
        for (const l of getKnownLinks()) {
          if (FORBIDDEN.has(l.a) || FORBIDDEN.has(l.b)) continue
          if (!adj.has(l.a)) adj.set(l.a, new Set())
          if (!adj.has(l.b)) adj.set(l.b, new Set())
          adj.get(l.a)!.add(l.b)
          adj.get(l.b)!.add(l.a)
        }
        if (!adj.has(from)) result = `Unknown origin "${from}" — the fleet has no learned links there yet. Use the game's find_route.`
        else if (!adj.has(to)) result = `Unknown destination "${to}" — the fleet has no learned links there yet. Use the game's find_route.`
        else {
          const prev = new Map<string, string>()
          const q = [from]; const seen = new Set([from])
          let found = false
          while (q.length && !found) {
            const n = q.shift()!
            for (const x of adj.get(n) ?? []) {
              if (seen.has(x)) continue
              seen.add(x); prev.set(x, n)
              if (x === to) { found = true; break }
              q.push(x)
            }
          }
          if (!found) result = `No route learned from ${from} to ${to} avoiding ${[...FORBIDDEN].join('/')} — the real graph may still have one; try the game's find_route.`
          else {
            const path = [to]; let c = to
            while (c !== from) { c = prev.get(c)!; path.unshift(c) }
            // Danger annotation per hop: SAFE hops print bare; anything worse is tagged so
            // the route reads as a risk briefing, not just a distance.
            let risky = 0, dangerous = 0
            const annotated = path.map((s) => {
              const d = assessSystemDanger(s)
              if (d.grade === 'RISKY') { risky++; return `${s}[RISKY]` }
              if (d.grade === 'DANGEROUS') { dangerous++; return `${s}[DANGEROUS]` }
              return s
            })
            const warn = dangerous > 0
              ? `\n⚠ ${dangerous} DANGEROUS hop(s) — "only go if you are strapped": armed, shielded, and cleared by the Admiral for unpoliced space.`
              : risky > 0 ? `\n${risky} RISKY hop(s) (low/unknown police) — get_nearby on arrival, leave on hostile contact.` : ''
            result = `LEARNED ROUTE (${path.length - 1} jumps, goldcrest/bluerift excluded): ${annotated.join(' > ')}${warn}\n` +
              `Upper bound from the fleet's learned graph — the real route may be shorter. Confirm with a live find_route before committing fuel.`
          }
        }
      }
      ctx.log('tool_result', truncate(result, 200), result)
      return result
    }
    case 'save_credentials': {
      const creds = {
        username: String(args.username),
        password: String(args.password),
        empire: String(args.empire),
        player_id: String(args.player_id),
      }
      updateProfile(ctx.profileId, {
        username: creds.username,
        password: creds.password,
        empire: creds.empire,
        player_id: creds.player_id,
      })
      ctx.log('system', `Credentials saved for ${creds.username}`)
      return `Credentials saved successfully for ${creds.username}.`
    }
    case 'update_todo': {
      ctx.todo = String(args.content)
      updateProfile(ctx.profileId, { todo: ctx.todo })
      ctx.log('system', 'TODO list updated')
      return 'TODO list updated.'
    }
    case 'read_todo': {
      return ctx.todo || '(empty TODO list)'
    }
    case 'update_memory': {
      ctx.memory = String(args.content)
      updateProfile(ctx.profileId, { memory: ctx.memory })
      memoryDirtyFlags.set(ctx.profileId, true)
      ctx.log('system', 'Memory updated')
      return 'Memory updated.'
    }
    case 'read_memory': {
      return ctx.memory || '(empty memory)'
    }
    case 'status_log': {
      ctx.log('system', `[${args.category}] ${args.message}`)
      return 'Logged.'
    }
    case 'fleet_order': {
      const targetName = String(args.target_agent)
      const profiles = listProfiles()
      const target = profiles.find(p => p.name.toLowerCase() === targetName.toLowerCase())
      if (!target) return `Error: No agent named "${targetName}". Available: ${profiles.map(p => p.name).join(', ')}`

      const orderId = crypto.randomUUID()
      const chainId = args.chain_id ? String(args.chain_id) : null
      const nextOrders = args.next_orders ? String(args.next_orders) : null
      createFleetOrder({
        id: orderId,
        from_profile_id: ctx.profileId,
        to_profile_id: target.id,
        type: String(args.type),
        description: String(args.description),
        params: args.params ? String(args.params) : null,
        chain_id: chainId,
        next_orders: nextOrders,
      })

      // Nudge the target agent if they're running
      const chainTag = chainId ? ` (chain: ${chainId})` : ''
      const orderMsg = `Fleet order from ${ctx.profileName}: [${args.type}] ${args.description}${chainTag}`
      agentManager.nudge(target.id, `## Fleet Order Received\n${orderMsg}\nUse read_fleet_orders(action="inbox") to see details and accept/complete orders.`)

      ctx.log('system', `Fleet order sent to ${target.name}: [${args.type}] ${args.description}${chainTag}`)
      const chainInfo = nextOrders ? ` Chain continues with ${JSON.parse(nextOrders).length} follow-up order(s).` : ''
      return `Order sent to ${target.name} (id: ${orderId.slice(0, 8)}).${chainInfo} They will be notified.`
    }
    case 'read_fleet_orders': {
      const action = String(args.action)
      const profiles = listProfiles()
      const nameOf = (id: string) => profiles.find(p => p.id === id)?.name || id.slice(0, 8)

      if (action === 'inbox') {
        const orders = getFleetOrders({ toProfileId: ctx.profileId })
        if (orders.length === 0) return 'No orders in your inbox.'
        return orders.map(o =>
          `[${o.id.slice(0, 8)}] ${o.status.toUpperCase()} | From: ${nameOf(o.from_profile_id)} | Type: ${o.type}\n  ${o.description}${o.progress ? `\n  Progress: ${o.progress}` : ''}`
        ).join('\n\n')
      }
      if (action === 'sent') {
        const orders = getFleetOrders({ fromProfileId: ctx.profileId })
        if (orders.length === 0) return 'No orders sent.'
        return orders.map(o =>
          `[${o.id.slice(0, 8)}] ${o.status.toUpperCase()} | To: ${nameOf(o.to_profile_id)} | Type: ${o.type}\n  ${o.description}${o.progress ? `\n  Progress: ${o.progress}` : ''}`
        ).join('\n\n')
      }
      if (action === 'chain') {
        const chainId = String(args.chain_id || '')
        if (!chainId) return 'Error: chain_id is required for action=chain'
        const chainOrders = getFleetOrdersByChain(chainId)
        if (chainOrders.length === 0) return `No orders found in chain "${chainId}".`
        const statusIcon = (s: string) => s === 'completed' ? '✅' : s === 'accepted' ? '🔄' : s === 'rejected' ? '❌' : '⏳'
        return `Chain: ${chainId}\n` + chainOrders.map((o, i) =>
          `  [${i + 1}] ${statusIcon(o.status)} ${o.status.toUpperCase()} | ${nameOf(o.to_profile_id)}: ${o.description}${o.next_orders ? ' → (has follow-ups)' : ''}`
        ).join('\n')
      }
      if (['accept', 'complete', 'reject'].includes(action)) {
        const orderId = String(args.order_id || '')
        if (!orderId) return 'Error: order_id is required'
        // Support short IDs
        const allOrders = getFleetOrders({ toProfileId: ctx.profileId })
        const order = allOrders.find(o => o.id === orderId || o.id.startsWith(orderId))
        if (!order) return `Error: Order "${orderId}" not found in your inbox.`

        const newStatus = action === 'accept' ? 'accepted' : action === 'complete' ? 'completed' : 'rejected'
        updateFleetOrder(order.id, { status: newStatus, progress: args.progress ? String(args.progress) : undefined })

        // Notify the sender
        const statusMsg = `Order [${order.id.slice(0, 8)}] ${newStatus} by ${ctx.profileName}${args.progress ? `: ${args.progress}` : ''}`
        agentManager.nudge(order.from_profile_id, `## Fleet Order Update\n${statusMsg}`)

        // Chain completion hook: auto-create next orders when this one completes
        let chainInfo = ''
        if (newStatus === 'completed' && order.next_orders) {
          try {
            const children = JSON.parse(order.next_orders) as Array<{ target_agent: string; type: string; description: string; params?: string; next_orders?: string }>
            const created: string[] = []
            for (const child of children) {
              const childTarget = profiles.find(p => p.name.toLowerCase() === child.target_agent.toLowerCase())
              if (!childTarget) {
                ctx.log('error', `Chain: could not find agent "${child.target_agent}" for follow-up order`)
                continue
              }
              const childId = crypto.randomUUID()
              createFleetOrder({
                id: childId,
                from_profile_id: order.from_profile_id,
                to_profile_id: childTarget.id,
                type: child.type,
                description: child.description,
                params: child.params || null,
                chain_id: order.chain_id,
                next_orders: child.next_orders ? JSON.stringify(child.next_orders) : null,
              })
              const chainTag = order.chain_id ? ` (chain: ${order.chain_id})` : ''
              agentManager.nudge(childTarget.id, `## Fleet Order Received${chainTag}\nChain follow-up from ${nameOf(order.from_profile_id)}: [${child.type}] ${child.description}\nUse read_fleet_orders(action="inbox") to see details and accept/complete orders.`)
              created.push(`${childTarget.name}: [${child.type}] ${child.description}`)
              ctx.log('system', `Chain: auto-created follow-up order for ${childTarget.name}: [${child.type}] ${child.description}`)
            }
            if (created.length > 0) {
              chainInfo = `\nChain: ${created.length} follow-up order(s) auto-created:\n` + created.map(c => `  → ${c}`).join('\n')
            }
          } catch (e) {
            ctx.log('error', `Chain: failed to parse next_orders: ${e instanceof Error ? e.message : String(e)}`)
          }
        }

        ctx.log('system', `Fleet order ${order.id.slice(0, 8)} → ${newStatus}`)
        return `Order ${order.id.slice(0, 8)} marked as ${newStatus}.${chainInfo}`
      }
      return `Error: Unknown action "${action}". Use inbox, sent, accept, complete, reject, or chain.`
    }
    default:
      return `Unknown local tool: ${name}`
  }
}

// ─── Macro tools: bounded deterministic loops over game commands ───────────

const macroSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * TOP OFF ALWAYS (Brian, 2026-09-02): after any successful manual `dock`, refuel
 * from the station pump before the model gets its next word. The goto_system
 * macro has done this on its own docks since 08-29; a manual dock() did not, and
 * fuel discipline as prose failed again today — Morg'Thar left a dry station on
 * ~200/350 fuel for a 26-jump corridor with no station in it. Preference
 * `auto_top_off` = 'off' disables it. Returns a note for the dock result; never throws.
 */
export async function autoTopOffAfterDock(ctx: ToolContext): Promise<string> {
  if (getPreference('auto_top_off') === 'off') return ''
  try {
    const gs = ctx.connection.getLocalState?.() ?? null
    const ship = (gs?.ship ?? {}) as Record<string, unknown>
    const fuel = numOrNull(ship.fuel)
    const max = numOrNull(ship.max_fuel ?? ship.fuel_capacity)
    if (fuel !== null && max !== null && fuel >= max) return ' ⛽ Tank already full.'
    await macroSleep(macroStepDelayMs(ctx.connection))
    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = await ctx.connection.execute('refuel')
      if (!resp.error) {
        const data = resp.structuredContent ?? resp.result
        const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
        const det = (d.details && typeof d.details === 'object' ? d.details : d) as Record<string, unknown>
        try {
          observeTacticalResult(ctx.profileId, 'refuel', undefined, data, resp.notifications)
          bookLedgerFromCommand('refuel', undefined, data, formatToolResult('refuel', data, resp.notifications), ctx.profileId, ctx.profileName)
          invalidateBriefingCache(ctx.profileId, ctx.connection)
        } catch { /* accounting must never break the dock */ }
        const got = numOrNull(det.fuel)
        const cost = numOrNull(det.cost)
        const what = got !== null ? `+${got} fuel${cost !== null ? ` for ${cost}cr` : ''}` : 'topped from the station pump'
        ctx.log('system', `Auto top-off after dock: ${what}`)
        return ` ⛽ AUTO TOP-OFF (every dock): ${what}.`
      }
      const code = String(resp.error.code ?? '')
      if (MACRO_RETRYABLE.has(code) && attempt < 2) {
        await macroSleep(Math.max((resp.error.retry_after ?? 5) * 1000, 2000))
        continue
      }
      if (code === 'station_fuel_empty') {
        return " ⛽ AUTO TOP-OFF: this station's fuel tank is EMPTY — plan your departure fuel from another stop; never buy cells above your directive's price cap."
      }
      if (/full/i.test(code)) return ' ⛽ Tank already full.'
      return ` ⛽ AUTO TOP-OFF skipped [${code}]${resp.error.message ? ': ' + String(resp.error.message).slice(0, 80) : ''}.`
    }
  } catch { /* never break the dock result */ }
  return ''
}

/** Per-step pause: lib_v2 mutations already await the game tick; other modes need real pacing. */
function macroStepDelayMs(conn: GameConnection): number {
  return conn.mode === 'lib_v2' ? 500 : 8000
}

/** Errors that mean "wait and retry this same step", not "the step failed". */
// mutation_timeout means the game ACKED the order and the result did not arrive
// in time — the order is usually live. Retrying is right; treating it as a hard
// failure ended hunts that had actually landed (Morg'Thar, 2026-09-02).
const MACRO_RETRYABLE = new Set(['action_pending', 'cooldown', 'in_transit', 'rate_limited', 'action_in_progress', 'mutation_timeout'])

/** Read {credits, cargoUsed, cargoCapacity, systemId, docked} — local cache when available, else a get_status query. */
async function macroReadState(conn: GameConnection): Promise<{
  credits: number | null; cargoUsed: number | null; cargoCapacity: number | null
  systemId: string | null; docked: boolean; cargo: Array<{ item_id: string; quantity: number }>
}> {
  let gs: Record<string, unknown> | null = conn.getLocalState?.() ?? null
  if (!gs) {
    try {
      const resp = await conn.execute('get_status')
      const data = resp.structuredContent ?? resp.result
      if (data && typeof data === 'object') gs = data as Record<string, unknown>
    } catch { /* fall through with null */ }
  }
  const player = (gs?.player ?? {}) as Record<string, unknown>
  const ship = (gs?.ship ?? {}) as Record<string, unknown>
  const location = (gs?.location ?? {}) as Record<string, unknown>
  const cargoRaw = gs?.cargo
  const cargo: Array<{ item_id: string; quantity: number }> = Array.isArray(cargoRaw)
    ? (cargoRaw as Array<Record<string, unknown>>)
        .filter((c) => typeof c.item_id === 'string' || typeof c.item === 'string')
        .map((c) => ({ item_id: String(c.item_id ?? c.item), quantity: Number(c.quantity ?? 1) }))
    : []
  // cargo_used/capacity: numeric fields, or the "10/60" string some shapes use
  let used = typeof ship.cargo_used === 'number' ? ship.cargo_used : null
  let cap = typeof ship.cargo_capacity === 'number' ? ship.cargo_capacity : (typeof ship.max_cargo === 'number' ? ship.max_cargo : null)
  if ((used === null || cap === null) && typeof ship.cargo === 'string') {
    const m = /^(\d+)\/(\d+)/.exec(ship.cargo)
    if (m) { used = used ?? Number(m[1]); cap = cap ?? Number(m[2]) }
  }
  const systemId = (location.system_id ?? player.current_system ?? null) as string | null
  const docked = Boolean(location.docked_at) || player.docked === true || player.is_docked === true
  return {
    credits: typeof player.credits === 'number' ? player.credits : null,
    cargoUsed: used, cargoCapacity: cap, systemId: systemId ? String(systemId) : null, docked, cargo,
  }
}

/** Execute one game action inside a macro, retrying transient pacing errors a bounded number of times. */
async function macroAction(
  ctx: ToolContext,
  command: string,
  args: Record<string, unknown> | undefined,
  maxRetries = 6,
): Promise<{ ok: boolean; errorCode?: string; errorMessage?: string }> {
  const conn = ctx.connection
  for (let attempt = 0; ; attempt++) {
    noteMovement(ctx.profileId, command)
    const resp = await conn.execute(command, args)
    if (!resp.error) {
      // Macros bypass executeTool's capture path entirely (this was why zero links were
      // learned while agents flew all day on goto_system) — sniff hop results here too.
      captureSystemLinks(resp.structuredContent ?? resp.result, `macro_${command}`)
      observeTacticalResult(ctx.profileId, command, args, resp.structuredContent ?? resp.result, resp.notifications)
      return { ok: true }
    }
    if (resp.error.code === 'not_in_battle') tacticalFor(ctx.profileId).lastBattleAt = Date.now()
    if (MACRO_RETRYABLE.has(resp.error.code) && attempt < maxRetries) {
      await macroSleep(Math.max((resp.error.retry_after ?? 10) * 1000, 5000))
      continue
    }
    return { ok: false, errorCode: resp.error.code, errorMessage: resp.error.message }
  }
}

/**
 * Progress narrator for long-running macros.
 *
 * A macro is ONE tool call that can run for many minutes (a 25-hop
 * goto_system is ~21 minutes at ~60s/hop). The model does not speak while it
 * runs, so the LLM log lane shows one line and then dead air — which reads as
 * a hung agent. It is worse for Codex-routed agents, whose turn ends at the
 * macro, so they emit exactly one thought per journey.
 *
 * Narration is logged as `llm_thought` so it lands in the same lane as the
 * model's own reasoning, and carries the model's stated intent (`reason`)
 * beside live progress. Throttled by wall time so fast macros
 * (mine_until_full fires several times a minute) cannot flood the lane.
 */
function makeMacroNarrator(ctx: ToolContext, macro: string, reason?: string, minIntervalMs = 15_000) {
  const intent = (reason || '').trim().replace(/\s+/g, ' ').slice(0, 140)
  let last = 0
  return (progress: string, force = false): void => {
    const now = Date.now()
    if (!force && now - last < minIntervalMs) return
    last = now
    ctx.log('llm_thought', intent ? `[${macro} ${progress}] ${intent}` : `[${macro} ${progress}]`)
  }
}

// Destination-commit gate. An agent that re-picks its destination every turn
// travels constantly and accomplishes nothing at any of them. Morg'Thar on
// 2026-09-01 set course for stillwater, then bharani, then the_crucible inside
// six minutes without working a single one — and the last was a system his own
// memory recorded as already explored and depleted. An earlier stretch bounced
// krynn -> iron_reach -> krynn twice.
//
// Prose did not hold it: the directive said "PICK A DESTINATION AND COMMIT" in
// capitals throughout, and the churn continued. So it is enforced here.
//
// A new destination is refused only when the agent has done NOTHING at the
// current one — arriving and immediately re-routing. Any real work (scan,
// market, mission, combat, mining, docking, looting) clears the gate, as does
// simply waiting out the window. Toggle: preference `destination_gate` = 'off'.
const lastDestinations = new Map<string, { system: string; at: number; workedSince: boolean }>()
const DESTINATION_COMMIT_MS = 4 * 60_000

/** Commands that count as actually working a system rather than passing through. */
const WORK_COMMANDS = new Set([
  'scan', 'get_nearby', 'get_wrecks', 'mine', 'mine_until_full', 'attack', 'loot',
  'salvage_wreck', 'dock', 'view_market', 'analyze_market', 'buy', 'sell',
  'accept_mission', 'complete_mission', 'get_missions', 'survey', 'salvage',
])

function noteDestinationWork(profileId: string, command: string): void {
  const bare = command.replace(/^spacemolt_/, '')
    .replace(/^(?:market|storage|social|intel|faction|faction_admin|salvage|catalog|ship|battle|transfer|facility|auth)_/, '')
  if (!WORK_COMMANDS.has(bare)) return
  const cur = lastDestinations.get(profileId)
  if (cur) cur.workedSince = true
}

function destinationRefusal(prevSystem: string, target: string, elapsedMs: number): string {
  const secs = Math.round(elapsedMs / 1000)
  return (
    `BLOCKED by Admiral doctrine: you set course for "${prevSystem}" ${secs}s ago and are already ` +
    `re-routing to "${target}" without having done anything there. Changing destination mid-plan is ` +
    `the single biggest waste of your turns — you arrive nowhere.\n\n` +
    `WORK THE SYSTEM YOU ARE IN FIRST: scan it, check its belts and POIs, read the mission board, ` +
    `look at the market, engage something you can safely beat. Once you have actually done one of ` +
    `those, you may pick a new destination. If "${prevSystem}" is genuinely worthless, say so in ` +
    `your TODO with the reason, then move on.`
  )
}

/**
 * Safety exemptions: the gate must NEVER hold a ship in a system that is
 * trying to kill it. It did exactly that on 2026-09-01 — Morg'Thar's escape
 * from Alhena was refused with 14 pirates and a hostile station present.
 * Returns the reason a departure is waived, or null when it is not.
 */
function departureWaiver(ctx: ToolContext): string | null {
  const t = tacticalFor(ctx.profileId)
  const now = Date.now()
  const cur = currentLocation(ctx)
  const pirates = cur.pirates ?? (now - t.piratesAt < THREAT_MEMORY_MS ? t.pirates : 0)
  if (pirates > 0) return `${pirates} pirate(s) at your position`
  if (cur.hull !== null) noteHull(t, cur.hull, now)
  if (t.hullDropAt && now - t.hullDropAt < THREAT_MEMORY_MS) return `hull dropped to ${t.hull} — you are taking damage`
  if (t.lastBattleAt && now - t.lastBattleAt < BATTLE_RECENT_MS) return 'a battle was active or ended within the last 2 minutes'
  const locked = reputationLockoutFor(ctx.profileId, cur.systemId)
  if (locked) return `a hostile station here (${locked.label}) refused you on reputation`
  const empire = cur.empire
  const rep = empire && cur.repByEmpire ? cur.repByEmpire[empire] : undefined
  if (typeof rep === 'number' && rep < 0) return `reputation ${rep} with the local empire (${empire})`
  return null
}

/** Returns a refusal string when the agent is re-routing without having worked
 *  the system it just travelled to, or null to allow. */
function checkDestinationCommit(ctx: ToolContext, target: string): string | null {
  const profileId = ctx.profileId
  if (!target || getPreference('destination_gate') === 'off') return null
  const now = Date.now()
  const prev = lastDestinations.get(profileId)

  if (prev && prev.system !== target && !prev.workedSince && now - prev.at < DESTINATION_COMMIT_MS) {
    const waiver = departureWaiver(ctx)
    if (!waiver) return destinationRefusal(prev.system, target, now - prev.at)
    ctx.log('system', `Destination gate waived (${waiver}) — leaving ${prev.system} for ${target}`)
  }

  if (!prev || prev.system !== target) {
    lastDestinations.set(profileId, { system: target, at: now, workedSince: false })
  }
  return null
}

/**
 * The same commitment applied to a raw `jump`. Raw hops never OPEN a
 * commitment (hand-flying a route leg by leg must stay legal), and hops made
 * while still en route to the committed system pass; only jumping OUT of the
 * committed system without having worked it is refused — and never past a
 * safety waiver.
 */
function checkRawJumpCommit(ctx: ToolContext, target: string): string | null {
  if (!target || getPreference('destination_gate') === 'off') return null
  const prev = lastDestinations.get(ctx.profileId)
  if (!prev) return null
  const now = Date.now()
  if (prev.system === target || prev.workedSince || now - prev.at >= DESTINATION_COMMIT_MS) return null
  const cur = currentLocation(ctx)
  if (!cur.systemId || cur.systemId !== prev.system) return null
  const waiver = departureWaiver(ctx)
  if (waiver) {
    ctx.log('system', `Destination gate waived (${waiver}) — jumping ${prev.system} -> ${target}`)
    lastDestinations.set(ctx.profileId, { system: target, at: now, workedSince: false })
    return null
  }
  return destinationRefusal(prev.system, target, now - prev.at)
}

async function executeMacroTool(name: string, args: Record<string, unknown>, ctx: ToolContext, reason?: string): Promise<string> {
  if (name === 'goto_system') {
    const target = String(args.target_system ?? args.system ?? '')
    const refusal = checkDestinationCommit(ctx, target)
    if (refusal) {
      ctx.log('tool_result', refusal)
      return refusal
    }
  }
  try {
    switch (name) {
      case 'mine_until_full': return await macroMineUntilFull(args, ctx, reason)
      case 'goto_system': return await macroGotoSystem(args, ctx, reason)
      case 'hunt_here': return await macroHuntHere(args, ctx, reason)
      case 'sell_cargo': return await macroSellCargo(args, ctx, reason)
      default: return `Error: unknown macro tool ${name}`
    }
  } catch (err) {
    return `MACRO ERROR (${name}): ${err instanceof Error ? err.message : String(err)}. State may have partially changed — verify with get_status.`
  }
}

/**
 * HUNT THIS POI — scan, engage, kill, loot, repeat.
 *
 * Why this is a macro and not prose. gpt-oss-120b follows a single next action
 * reliably and multi-step loops badly. Told in three separate directive
 * rewrites to "arrive, get_nearby, attack, loot, move on", Morg'Thar instead
 * commuted: on 2026-09-02 he crossed thirteen systems in 45 minutes with zero
 * attacks, including a gas pocket holding four grazers. goto_system solved the
 * same class of problem for travel — one call the model cannot half-execute.
 *
 * Safety is in code, not in the prompt: empire NPCs and police are never
 * targeted, anything whose hull exceeds `MAX_TARGET_HULL_RATIO` of our own is
 * skipped, and the loop breaks off the moment hull falls under the floor.
 */
const MAX_TARGET_HULL_RATIO = 0.5   // never pick a target tougher than half our hull
const HUNT_TICK_MS = 10_000         // the game's combat tick
const HUNT_BATTLE_MAX_TICKS = 45    // ~7.5 min per fight before we disengage

async function macroHuntHere(args: Record<string, unknown>, ctx: ToolContext, reason?: string): Promise<string> {
  const conn = ctx.connection
  const narrate = makeMacroNarrator(ctx, 'hunt_here', reason)
  const maxKills = Math.min(Math.max(Number(args.max_kills) || 3, 1), 8)
  const hullFloorPct = Math.min(Math.max(Number(args.hull_floor_pct) || 60, 10), 95)
  const wantSpecies = String(args.species ?? '').toLowerCase().trim()

  const readShip = async (): Promise<{ hull: number | null; maxHull: number | null; inBattle: boolean; zone: unknown; reach: unknown }> => {
    let gs: Record<string, unknown> | null = null
    try { gs = conn.getLocalState?.() ?? null } catch { gs = null }
    if (!gs) {
      const r = await conn.execute('get_status')
      const d = r.structuredContent ?? r.result
      if (d && typeof d === 'object') gs = d as Record<string, unknown>
    }
    const ship = (gs?.ship ?? {}) as Record<string, unknown>
    const battle = (gs?.active_battle ?? null) as Record<string, unknown> | null
    const combat = (gs?.combat_state ?? battle?.combat_state ?? null) as Record<string, unknown> | null
    const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : null }
    return {
      hull: n(ship.hull), maxHull: n(ship.max_hull ?? ship.hull_max),
      inBattle: !!battle && !!(battle.battle_id ?? battle.id),
      zone: combat?.your_zone ?? battle?.your_zone ?? null,
      reach: combat?.max_weapon_reach ?? null,
    }
  }
  const hullPct = (s: { hull: number | null; maxHull: number | null }) =>
    s.hull !== null && s.maxHull ? (s.hull / s.maxHull) * 100 : 100

  // COMBAT ROLES ONLY. Advertising this macro in the default prompt block put
  // it in front of Cass Margin — a trader flying an UNINSURED 540-cargo
  // Caravan with one weapon slot, under orders to stay in policed space and
  // dock on any damage. She called it on 2026-09-02 and got lucky: the gas
  // cloud was empty. A pirate there would have cost the fleet its hauler.
  // The prompt is guidance; this is the guard.
  {
    const prof = getProfile(ctx.profileId)
    if (prof && resolveAgentRole(prof) !== 'hunter') {
      const refusal =
        `hunt_here REFUSED: you are not a combat agent. This macro picks fights, and your ` +
        `directive is not a hunter's — engaging would risk your ship and your cargo for nothing. ` +
        `Do the job your directive actually gives you.`
      ctx.log('system', `hunt_here refused for non-combat role (${prof.name})`)
      return refusal
    }
  }

  const start = await readShip()
  if (hullPct(start) < hullFloorPct) {
    return `hunt_here ABORT: hull is ${start.hull}/${start.maxHull} (${hullPct(start).toFixed(0)}%), already under the ${hullFloorPct}% floor. Repair before hunting.`
  }

  // Get to the hunting ground ourselves. A turn ends on the first action, so a
  // model handed a three-step plan ("undock, travel, hunt") re-reads its TODO
  // next turn and starts again at step one — Morg'Thar undocked and re-docked
  // in a loop for twenty minutes on 2026-09-02 and never reached the hunt. One
  // call has to cover the whole stop.
  const prelude: string[] = []
  {
    let gs: Record<string, unknown> | null = null
    try { gs = conn.getLocalState?.() ?? null } catch { gs = null }
    const loc = (gs?.location ?? {}) as Record<string, unknown>
    if (loc.docked_at) {
      const u = await macroAction(ctx, 'undock', undefined, 3)
      prelude.push(u.ok ? 'Undocked.' : `Undock failed [${u.errorCode}].`)
      if (!u.ok && u.errorCode !== 'not_docked') {
        return `hunt_here ABORT: could not undock [${u.errorCode}] ${u.errorMessage ?? ''}`.trim()
      }
      await macroSleep(macroStepDelayMs(conn))
    }
    let wantPoi = String(args.poi ?? '').trim()

    // No POI named? Find one. Creatures live at belts, gas clouds and ice
    // fields — never at the star you arrive on. Morg'Thar jumped into
    // GSC-0030 (which has both a gas cloud and an ice field), called a bare
    // hunt_here() at the arrival POI, got nothing, and jumped away. The macro
    // knows how to read get_system; the model should not have to.
    if (!wantPoi) {
      const cur = String((conn.getLocalState?.()?.location as Record<string, unknown> | undefined)?.poi_id ?? '')
      const probe = await conn.execute('get_nearby')
      const here = probe.error ? [] : collectTargets(probe.structuredContent ?? probe.result)
      if (here.filter((t) => t.kind !== 'npc').length === 0) {
        const sys = await conn.execute('get_system')
        if (!sys.error) {
          const sd = (sys.structuredContent ?? sys.result) as Record<string, unknown> | undefined
          const node = (sd?.system ?? sd) as Record<string, unknown> | undefined
          const pois = Array.isArray(node?.pois) ? node!.pois as Array<Record<string, unknown>> : []
          const hunting = pois.filter((p) => /asteroid_belt|gas_cloud|ice_field|nebula|debris/i.test(String(p.type ?? '')))
          const pick = hunting.find((p) => String(p.id ?? '') && String(p.id) !== cur)
          if (pick) {
            wantPoi = String(pick.id)
            prelude.push(`No targets at ${cur || 'arrival POI'}; moving to ${pick.name ?? wantPoi} (${pick.type}).`)
          }
        }
      }
    }

    if (wantPoi) {
      const here = String((conn.getLocalState?.()?.location as Record<string, unknown> | undefined)?.poi_id ?? '')
      if (here !== wantPoi) {
        const t = await macroAction(ctx, 'travel', { target_poi: wantPoi }, 6)
        if (!t.ok) {
          return `hunt_here ABORT: could not travel to "${wantPoi}" [${t.errorCode}] ${t.errorMessage ?? ''}. ` +
            `Run get_system to see the POI ids here.`.trim()
        }
        prelude.push(`Travelled to ${wantPoi}.`)
        await macroSleep(macroStepDelayMs(conn))
      }
    }
  }

  const kills: string[] = []
  const looted: string[] = []
  const skipped: string[] = []
  let stopReason = `reached max_kills (${maxKills})`

  for (let k = 0; k < maxKills; k++) {
    if (!conn.isConnected()) { stopReason = 'disconnected'; break }
    const interrupt = ctx.interruptPending?.()
    if (interrupt) { stopReason = `operator interrupt (${interrupt})`; break }

    // Let the previous engagement settle before touching the game again.
    // Without this the macro attacked into its own unfinished fight: the game
    // answered `action_pending: Another action is already pending (attack)`,
    // the macro reported NO KILLS, the model called it again, and it span —
    // observed on Morg'Thar at Nekkar Belt on 2026-09-02 immediately after its
    // first successful kill.
    for (let settle = 0; settle < 18; settle++) {
      const s = await readShip()
      if (!s.inBattle) break
      if (settle === 0) narrate('waiting for the current battle to finish', true)
      await macroSleep(HUNT_TICK_MS)
    }

    const scan = await conn.execute('get_nearby')
    if (scan.error) { stopReason = `get_nearby failed [${scan.error.code}]`; break }
    const data = scan.structuredContent ?? scan.result
    observeTacticalResult(ctx.profileId, 'get_nearby', undefined, data, scan.notifications)
    const targets = collectTargets(data)

    const ship = await readShip()
    const ourHull = ship.hull ?? 0
    const beatable = targets.filter((t) => {
      if (t.kind === 'npc') { skipped.push(`${t.name} (empire NPC — never attacked)`); return false }
      if (wantSpecies && !`${t.species} ${t.name}`.toLowerCase().includes(wantSpecies)) return false
      if (t.hull !== null && ourHull > 0 && t.hull > ourHull * MAX_TARGET_HULL_RATIO) {
        skipped.push(`${t.name} (hull ${t.hull} — too tough)`); return false
      }
      return true
    })
    if (beatable.length === 0) {
      stopReason = targets.length === 0
        ? 'nothing at this POI'
        : `nothing beatable here (${skipped.slice(0, 3).join('; ')})`
      break
    }

    // Weakest first: fastest kill, least damage taken, most contract ticks per minute.
    beatable.sort((a, b) => (a.hull ?? 1e9) - (b.hull ?? 1e9))
    const target = beatable[0]
    narrate(`engaging ${target.name} (${kills.length + 1}/${maxKills})`, true)

    // action_pending and mutation_timeout are pacing, not failure: the game
    // acked the order and is still resolving it. Give attack a generous retry
    // budget (macroAction already backs off on MACRO_RETRYABLE codes) rather
    // than ending the hunt on a transient.
    const atk = await macroAction(ctx, 'attack', { id: target.id }, 8)
    if (!atk.ok) {
      if (atk.errorCode === 'mutation_timeout' || atk.errorCode === 'action_pending') {
        // The order is probably live; fall through to the battle watch and let
        // it decide, instead of reporting a failure that did not happen.
        narrate(`attack on ${target.name} is still resolving (${atk.errorCode}) — watching the battle`, true)
      } else {
        stopReason = `attack failed [${atk.errorCode}] ${atk.errorMessage ?? ''}`.trim()
        break
      }
    }

    // Fight it out. Close the range when out of reach, break off on the floor.
    let ticks = 0
    let broke = false
    for (; ticks < HUNT_BATTLE_MAX_TICKS; ticks++) {
      await macroSleep(HUNT_TICK_MS)
      const s = await readShip()
      if (hullPct(s) < hullFloorPct) {
        narrate(`hull ${hullPct(s).toFixed(0)}% — breaking off`, true)
        await macroAction(ctx, 'stance', { id: 'flee' }, 2)
        for (let r = 0; r < 3; r++) await macroAction(ctx, 'retreat', undefined, 2)
        stopReason = `hull fell to ${s.hull}/${s.maxHull} (${hullPct(s).toFixed(0)}%) — disengaged`
        broke = true
        break
      }
      if (!s.inBattle) break   // target dead, or the battle dropped us
      // "Guns can't reach" until the range closes — advance while we are outside it.
      if (typeof s.zone === 'string' && s.zone.toLowerCase() === 'outer') {
        await macroAction(ctx, 'advance', undefined, 2)
      }
      if (ticks % 6 === 5) narrate(`fighting ${target.name}, hull ${hullPct(s).toFixed(0)}%`)
    }
    if (broke) break
    if (ticks >= HUNT_BATTLE_MAX_TICKS) {
      stopReason = `battle with ${target.name} ran past ${HUNT_BATTLE_MAX_TICKS} ticks — disengaged`
      await macroAction(ctx, 'stance', { id: 'flee' }, 2)
      await macroAction(ctx, 'retreat', undefined, 2)
      break
    }
    kills.push(target.name)

    // Loot whatever the kill left. The wreck does not exist the instant the
    // target dies — it appears on the next game tick — and the payload names
    // it `id`, not `wreck_id`:
    //   wrecks: [{ id: cf5ce1df…, type: creature, victim_name: Belt-Grazer,
    //              cargo: [{ item_id: creature_carapace, quantity: 1 }] }]
    // Checking 500ms early with the wrong key is why three Belt-Grazer kills
    // at Nekkar Belt on 2026-09-02 reported "No wrecks looted".
    await macroSleep(HUNT_TICK_MS)
    const wr = await conn.execute('wrecks')
    if (!wr.error) {
      const wd = (wr.structuredContent ?? wr.result) as Record<string, unknown> | undefined
      const list = Array.isArray(wd?.wrecks) ? wd!.wrecks as Array<Record<string, unknown>> : []
      // Only our own kills, and only ones still holding cargo.
      const mine = list.filter((w) => {
        const killer = String(w.killer_name ?? '')
        return !killer || killer === ctx.profileName
      })
      for (const w of mine.slice(0, 4)) {
        const wid = String(w.id ?? w.wreck_id ?? '')
        if (!wid) continue
        let lt = await macroAction(ctx, 'loot', { id: wid }, 2)
        // Two signatures are documented for loot; try the other key before giving up.
        if (!lt.ok && /invalid_payload|unknown parameter/i.test(`${lt.errorCode} ${lt.errorMessage ?? ''}`)) {
          lt = await macroAction(ctx, 'loot', { wreck_id: wid }, 2)
        }
        if (lt.ok) {
          const cargo = Array.isArray(w.cargo) ? w.cargo as Array<Record<string, unknown>> : []
          const what = cargo.map((c) => `${c.item_id} x${c.quantity ?? 1}`).join(', ')
          looted.push(what || String(w.victim_name ?? wid))
        } else if (lt.errorCode) {
          skipped.push(`wreck ${wid.slice(0, 8)} [${lt.errorCode}]`)
        }
      }
    }
  }

  const end = await readShip()
  return [
    prelude.join(' '),
    `hunt_here ${kills.length > 0 ? 'DONE' : 'NO KILLS'}: ${kills.length} kill(s)${kills.length ? ` (${kills.join(', ')})` : ''}.`,
    // Name the haul, not just a count — the agent has to decide whether it is
    // worth a trip to a market, and the operator wants to see income happening.
    looted.length ? `Looted ${looted.length} wreck(s): ${looted.join('; ')}.` : 'No wrecks looted.',
    `Stopped: ${stopReason}.`,
    `Hull ${end.hull ?? '?'}/${end.maxHull ?? '?'}.`,
    skipped.length ? `Skipped: ${[...new Set(skipped)].slice(0, 4).join('; ')}.` : '',
    kills.length === 0 && stopReason.startsWith('nothing') ? 'This POI is worked out — travel to another POI or jump to the next system.' : '',
  ].filter(Boolean).join(' ')
}

async function macroMineUntilFull(args: Record<string, unknown>, ctx: ToolContext, reason?: string): Promise<string> {
  const conn = ctx.connection
  const narrate = makeMacroNarrator(ctx, 'mine_until_full', reason)
  // Bounds sized to fill a typical hold in ONE call: ~1 unit per ~10s tick means
  // a 70-slot hold needs ~70 mines / ~12 min (observed live: 30 mines stopped at 60/70).
  const maxMines = Math.min(Number(args.max_mines) || 80, 120)
  const stopPct = Math.min(Math.max(Number(args.stop_at_pct) || 100, 10), 100)
  const deadline = Date.now() + 15 * 60_000
  const start = await macroReadState(conn)
  if (start.cargoCapacity === null) return 'MACRO ABORT: could not read cargo capacity — run get_status and retry.'

  let mines = 0
  let noYieldStrikes = 0
  let stopReason = 'max_mines'
  let lastUsed = start.cargoUsed ?? 0

  while (mines < maxMines) {
    if (!conn.isConnected()) { stopReason = 'disconnected'; break }
    if (Date.now() > deadline) { stopReason = 'deadline (5min)'; break }
    const st = await macroReadState(conn)
    const used = st.cargoUsed ?? lastUsed
    if (st.cargoCapacity && used >= (st.cargoCapacity * stopPct) / 100) { stopReason = used >= st.cargoCapacity ? 'full' : `reached ${stopPct}%`; break }

    const act = await macroAction(ctx,'mine', undefined)
    mines++
    if (!act.ok) {
      stopReason = `error [${act.errorCode}] ${act.errorMessage ?? ''}`.trim()
      break
    }
    const after = await macroReadState(conn)
    const afterUsed = after.cargoUsed ?? used
    if (afterUsed <= used) {
      noYieldStrikes++
      if (noYieldStrikes >= 3) { stopReason = 'no yield 3x (depleted?)'; break }
    } else {
      noYieldStrikes = 0
    }
    lastUsed = afterUsed
    ctx.log('system', `mine_until_full: ${mines} mines, cargo ${afterUsed}/${after.cargoCapacity ?? '?'}`)
    narrate(`${mines} mines, cargo ${afterUsed}/${after.cargoCapacity ?? '?'}`)
    await macroSleep(macroStepDelayMs(conn))
  }

  const end = await macroReadState(conn)
  const minedUnits = (end.cargoUsed ?? lastUsed) - (start.cargoUsed ?? 0)
  return `mine_until_full DONE: ${mines} mine actions, +${minedUnits} cargo units, cargo now ${end.cargoUsed ?? '?'}/${end.cargoCapacity ?? '?'}. Stopped: ${stopReason}.`
}

/**
 * Shortest path over the learned system_links graph (fleet-banned systems
 * excluded), or null when either endpoint is unknown or no learned route
 * exists. The graph is partial — a null is "not learned", never "impossible".
 */
function knownShortestPath(from: string, to: string): string[] | null {
  const FORBIDDEN = new Set(['goldcrest', 'bluerift'])
  const adj = new Map<string, Set<string>>()
  for (const l of getKnownLinks()) {
    if (FORBIDDEN.has(l.a) || FORBIDDEN.has(l.b)) continue
    if (!adj.has(l.a)) adj.set(l.a, new Set())
    if (!adj.has(l.b)) adj.set(l.b, new Set())
    adj.get(l.a)!.add(l.b)
    adj.get(l.b)!.add(l.a)
  }
  if (!adj.has(from) || !adj.has(to)) return null
  const prev = new Map<string, string>()
  const q = [from]; const seen = new Set([from])
  while (q.length) {
    const n = q.shift()!
    for (const x of adj.get(n) ?? []) {
      if (seen.has(x)) continue
      seen.add(x); prev.set(x, n)
      if (x === to) {
        const path = [to]; let c = to
        while (c !== from) { c = prev.get(c)!; path.unshift(c) }
        return path
      }
      q.push(x)
    }
  }
  return null
}

async function macroGotoSystem(args: Record<string, unknown>, ctx: ToolContext, reason?: string): Promise<string> {
  const narrate = makeMacroNarrator(ctx, 'goto_system', reason)
  const conn = ctx.connection
  const target = String(args.target_system || '').toLowerCase().replace(/\s+/g, '_')
  if (!target) return 'MACRO ABORT: target_system is required.'
  let dockPoi = args.dock_at_poi ? String(args.dock_at_poi).toLowerCase().replace(/\s+/g, '_') : null
  // Hops take ~65s of game time each; 12 min covers the fleet's standard 8-10 hop
  // commutes in one call (observed live: 8 min split a 9-hop route into PARTIAL+resume).
  const deadline = Date.now() + 12 * 60_000

  const start = await macroReadState(conn)
  if (start.systemId === target) {
    if (!dockPoi) return `goto_system DONE: already in ${target}.`
  } else {
    // Plot the route
    const routeResp = await conn.execute('find_route', { target_system: target })
    const rc = (routeResp.structuredContent ?? routeResp.result) as Record<string, unknown> | undefined
    captureSystemLinks(rc, 'macro_find_route')
    if (routeResp.error || !rc) return `MACRO ABORT: find_route failed${routeResp.error ? ` [${routeResp.error.code}]` : ''}. Check the system name with search_systems.`
    if (rc.found === false) return `MACRO ABORT: no route to ${target}: ${rc.message ?? 'unreachable'}.`
    const route = Array.isArray(rc.route) ? (rc.route as Array<Record<string, unknown>>) : []
    const hopIds = route
      .map((h) => String(h.system_id ?? h.id ?? h.system ?? ''))
      .filter((id) => id && id !== start.systemId)
    if (hopIds.length === 0) return `MACRO ABORT: route to ${target} had no parseable hops — jump manually.`
    if (hopIds.length > 25) return `MACRO ABORT: route is ${hopIds.length} hops (cap 25) — too far for one macro; refuel/plan waypoints.`
    // Hard fleet bans are absolute: the game's own router happily plotted a ship
    // THROUGH Goldcrest on 2026-08-30, and the macro flew it. Screen every hop.
    {
      const banned = hopIds.find((h) => FORBIDDEN_SYSTEMS.has(h))
      if (banned) {
        return (
          `MACRO ABORT: the game's route crosses ${banned} — a fleet-FORBIDDEN system, no ` +
          `exceptions. Plot around it: fleet_route avoids banned systems; jump its path leg ` +
          `by leg, or pick a different destination.`
        )
      }
    }
    // Route sanity vs the learned map. find_route returned three catastrophic
    // routes on 2026-08-29 alone — 25 hops market_prime→haven (adjacent), 20+
    // hops through the lawless Dheneb pocket for an adjacent-system trip — and
    // the fleet's own link graph knew better each time. When the game's route
    // is wildly longer than a path the fleet has actually flown, refuse it and
    // hand the agent the known path instead. A partial graph can only shorten,
    // never lengthen, so this cannot false-positive on honest routes.
    if (start.systemId) {
      const known = knownShortestPath(start.systemId, target)
      if (known && known.length > 1 && hopIds.length > Math.max(3, 2 * (known.length - 1))) {
        return (
          `MACRO ABORT: find_route wants ${hopIds.length} hops to ${target}, but the fleet's ` +
          `learned map knows a ${known.length - 1}-hop path: ${known.join(' → ')}. ` +
          `The game route is not trustworthy here — jump the known path LEG BY LEG ` +
          `(verify each leg's security first), or re-run goto_system after moving one hop.`
        )
      }
    }
    const estFuel = Number(rc.estimated_fuel ?? hopIds.length)
    const fuelAvail = Number(rc.fuel_available ?? NaN)
    // Launch margin: routes must be affordable WITH a 25% reserve on top, not
    // just barely. Every stranding this fleet has suffered began with a launch
    // that "exactly" covered the route — then one detour, one dry tank, one
    // recalc ate the margin (Devastator, 8 hours adrift, 2026-08-29). Arriving
    // on fumes in a system whose tank you have not verified is a stranding
    // with extra steps.
    const needWithReserve = Math.ceil(estFuel * 1.25)
    if (!Number.isNaN(fuelAvail) && needWithReserve > fuelAvail) {
      return (
        `MACRO ABORT: route needs ~${estFuel} fuel and the fleet launch rule requires ` +
        `${needWithReserve} (cost + 25% reserve); you have ${fuelAvail}. REFUEL FIRST — ` +
        `dock and fill the tank (2-20cr/unit) before any multi-hop route. No exceptions: ` +
        `margin is what survives detours.`
      )
    }

    // Undock if needed, then jump each hop
    if (start.docked) await macroAction(ctx,'undock', undefined)
    let hops = 0
    for (const hop of hopIds) {
      if (!conn.isConnected()) return `goto_system PARTIAL: disconnected after ${hops}/${hopIds.length} hops. Verify position with get_status.`
      if (Date.now() > deadline) return `goto_system PARTIAL: deadline (8min) after ${hops}/${hopIds.length} hops — re-run goto_system(target_system="${target}") to continue.`
      const interrupt = ctx.interruptPending?.()
      if (interrupt) {
        return `goto_system INTERRUPTED after ${hops}/${hopIds.length} hops (${interrupt}). ` +
          `You are mid-route to ${target} — read the new guidance FIRST, then either ` +
          `re-run goto_system(target_system="${target}") to continue or follow the new orders.`
      }
      const act = await macroAction(ctx,'jump', { target_system: hop }, 12)
      if (!act.ok) {
        return `goto_system PARTIAL: jump to ${hop} failed [${act.errorCode}] ${act.errorMessage ?? ''} after ${hops}/${hopIds.length} hops. Verify position with get_status.`
      }
      hops++
      ctx.log('system', `goto_system: hop ${hops}/${hopIds.length} → ${hop}`)
      narrate(`hop ${hops}/${hopIds.length} → ${hop}`, true)
      await macroSleep(macroStepDelayMs(conn))
    }
  }

  let dockNote = ''
  if (dockPoi) {
    let t = await macroAction(ctx,'travel', { target_poi: dockPoi }, 12)
    // Agents routinely pass the STATION/base id where a POI id is wanted — the
    // citadel is base `crimson_war_citadel` but POI `war_citadel`, and two agents
    // burned round trips on it in one session. The empire prefix is the whole
    // difference, so on a not-found retry once without it rather than stranding
    // them a hop short of the vault.
    if (!t.ok && /not_found|no_poi|invalid/i.test(`${t.errorCode ?? ''}`)) {
      const stripped = dockPoi.replace(/^(crimson|nebula|solarian|voidborn|outerrim)_/, '')
      if (stripped !== dockPoi) {
        const retry = await macroAction(ctx,'travel', { target_poi: stripped }, 12)
        if (retry.ok) {
          dockPoi = stripped
          t = retry
        }
      }
    }
    if (t.ok) {
      await macroSleep(macroStepDelayMs(conn))
      const d = await macroAction(ctx,'dock', undefined, 6)
      dockNote = d.ok
        ? ` Docked at ${dockPoi}.`
        : ` You are AT ${dockPoi} (travel complete — no further travel needed); dock skipped [${d.errorCode}]${d.errorCode === 'no_base' ? ' — this POI has no station, e.g. a belt: just start working it' : ''}.`
      // Auto-refuel on every macro dock. Fuel discipline as prose failed all
      // day (two strandings, one aborted hunt); as a dock side effect it cannot
      // be forgotten. Station fuel is 2-20cr/unit — topping up is always right,
      // and a dry tank gets surfaced to the agent instead of discovered later.
      if (d.ok) {
        await macroSleep(macroStepDelayMs(conn))
        const rf = await macroAction(ctx,'refuel', undefined, 3)
        if (rf.ok) dockNote += ' Tank auto-topped from the station pump.'
        else if (rf.errorCode === 'station_fuel_empty') dockNote += ' NOTE: this station\'s fuel tank is EMPTY — plan your departure fuel from cargo cells or another stop.'
        else if (rf.errorCode) dockNote += ` (auto-refuel skipped [${rf.errorCode}])`
      }
    } else {
      dockNote = ` Arrived but travel to ${dockPoi} failed [${t.errorCode}] ${t.errorMessage ?? ''}.`
    }
  }
  const end = await macroReadState(conn)
  return `goto_system DONE: now in ${end.systemId ?? '?'}.${dockNote} Credits ${end.credits ?? '?'}.`
}

// Devastator BoM lock list — sell_cargo refuses to sell these regardless of the
// caller's exclude list. Observed live: an agent passed exclude=[] with iron_ore
// aboard and the macro sold a locked item. Doctrine must not depend on LLM diligence.
// EMPTIED 2026-08-28 on Brian's order: the Crimson Devastator commission was
// placed and paid (7f4c3f0c, materials consumed by the yard), so the campaign
// this list protected is over. The mechanism stays — sell/gift guards and the
// sell_quotas release valve all key off this set — so the NEXT commission locks
// its BoM by repopulating the list (and setCommissionRequirements for the craft
// guard). History of what it held and why: git log this block.
const SELL_CARGO_ALWAYS_EXCLUDE = new Set<string>([])

/** Ammunition the ship's own fitted weapons consume, read off get_ship.
 *
 *  sell_cargo(exclude=[]) means "sell everything sellable", and ammo is
 *  sellable — so on 2026-09-01 Morg'Thar sold the reload supply he had bought
 *  20 minutes earlier specifically to fight with: 30 standard_rounds_box
 *  bought at 12cr, dumped at ~7.7cr for a 130cr LOSS, immediately before
 *  leaving to hunt. The BoM lock did not catch it (that list is empty since
 *  the commission closed) and the jettison gate does not cover selling.
 *
 *  Derived from the ship rather than hardcoded, so it is correct for any agent,
 *  hull or ammo type without maintenance. */
async function fittedAmmoIds(conn: GameConnection): Promise<Set<string>> {
  const ids = new Set<string>()
  try {
    const resp = await conn.execute('get_ship')
    const data = (resp.structuredContent ?? resp.result) as Record<string, unknown> | undefined
    const modules = (data as any)?.modules ?? (data as any)?.ship?.modules
    if (Array.isArray(modules)) {
      for (const m of modules as Array<Record<string, unknown>>) {
        for (const k of ['loaded_ammo_id', 'ammo_id', 'ammo_type_id', 'compatible_ammo']) {
          const v = m[k]
          if (typeof v === 'string' && v) ids.add(v.toLowerCase())
          else if (Array.isArray(v)) for (const a of v) if (typeof a === 'string') ids.add(a.toLowerCase())
        }
      }
    }
  } catch { /* no ship read — fall through; the caller still applies its own excludes */ }
  return ids
}

async function macroSellCargo(args: Record<string, unknown>, ctx: ToolContext, reason?: string): Promise<string> {
  const narrate = makeMacroNarrator(ctx, 'sell_cargo', reason)
  const conn = ctx.connection
  const exclude = new Set(
    (Array.isArray(args.exclude) ? args.exclude : []).map((x) => String(x).toLowerCase()),
  )
  for (const locked of SELL_CARGO_ALWAYS_EXCLUDE) exclude.add(locked)
  // Never bulk-sell the ammunition this ship's own guns fire. An agent heading
  // out to hunt needs its reload supply more than it needs the ~8cr a box
  // fetches. A deliberate, itemised `sell` is still allowed — this guards the
  // "sell everything" path only.
  const ammoIds = await fittedAmmoIds(conn)
  for (const a of ammoIds) exclude.add(a)
  const deadline = Date.now() + 3 * 60_000
  const start = await macroReadState(conn)
  if (!start.docked) return 'MACRO ABORT: not docked — dock at a station first.'
  if (start.cargo.length === 0) return 'sell_cargo DONE: cargo is empty, nothing to sell.'

  // Depth map from a live market read: macro sells bypass checkDoctrineGuards,
  // and a market `sell` walks the book past the honest depth into 1cr lowballs
  // (the 2026-08-27 circuit-board cascade). view_market is free; read it once
  // and cap every item at its observed bid depth.
  const depth = new Map<string, { buy: number; qty: number | null }>()
  try {
    const mkt = await conn.execute('view_market')
    const payload = (mkt.structuredContent ?? mkt.result) as Record<string, unknown> | undefined
    const items = Array.isArray((payload as any)?.items) ? (payload as any).items : []
    for (const it of items) {
      const id = String(it.item_id ?? '').toLowerCase()
      if (id) depth.set(id, { buy: Number(it.best_buy ?? 0), qty: typeof it.best_buy_qty === 'number' ? it.best_buy_qty : null })
    }
  } catch { /* no market data — items sell unguarded below only when qty <= 5 */ }

  const sold: string[] = []
  const skipped: string[] = []
  const failed: string[] = []
  let prevCredits = start.credits
  for (const item of start.cargo.slice(0, 20)) {
    if (Date.now() > deadline) { failed.push('(deadline hit — remaining items not attempted)'); break }
    if (exclude.has(item.item_id.toLowerCase())) {
      const isBom = SELL_CARGO_ALWAYS_EXCLUDE.has(item.item_id.toLowerCase())
      skipped.push(`${item.item_id} x${item.quantity} (${isBom ? 'BoM-locked — never sellable via this macro' : 'excluded'})`)
      continue
    }
    const obs = depth.get(item.item_id.toLowerCase())
    let sellQty = item.quantity
    if (item.quantity > 5) {
      if (!obs || obs.buy <= 2) {
        skipped.push(`${item.item_id} x${item.quantity} (${obs ? `lowball bid ${obs.buy}cr` : 'no local bid'} — deposit or create_sell_order instead)`)
        continue
      }
      if (obs.qty !== null && obs.qty < item.quantity) {
        sellQty = obs.qty
        if (sellQty <= 0) { skipped.push(`${item.item_id} x${item.quantity} (bid depth 0)`); continue }
      }
    }
    const act = await macroAction(ctx,'sell', { item_id: item.item_id, quantity: sellQty }, 3)
    if (!act.ok) {
      failed.push(`${item.item_id} x${item.quantity} [${act.errorCode}]`)
    } else {
      // A no-error response is NOT proof of a fill (observed live: "sold" with
      // zero buyers and unchanged cargo). Verify the units actually left.
      const after = await macroReadState(conn)
      const remaining = after.cargo.find((c) => c.item_id === item.item_id)?.quantity ?? 0
      if (remaining < item.quantity) {
        const soldQty = item.quantity - remaining
        sold.push(`${item.item_id} x${soldQty}${remaining > 0 ? ` (${remaining} unsold)` : ''}`)
        narrate(`sold ${item.item_id} x${soldQty}`)
        // Book the sale in the financial ledger — macro sells bypass the normal
        // per-command booking path in executeTool (observed: a +35K macro sale
        // left no cashflow/transaction rows). Amount = verified credit delta.
        const delta = after.credits !== null && prevCredits !== null ? after.credits - prevCredits : null
        if (delta !== null && delta > 0) {
          try {
            LedgerCollector.processCommandResult('sell', {
              action: 'sell', item_id: item.item_id, quantity_sold: soldQty,
              total_earned: delta, credits: after.credits,
            }, ctx.profileId, ctx.profileName)
          } catch { /* ledger must never break the macro */ }
        }
        prevCredits = after.credits ?? prevCredits
      } else {
        failed.push(`${item.item_id} x${item.quantity} [no buyers — cargo unchanged]`)
      }
    }
    await macroSleep(macroStepDelayMs(conn))
  }
  const end = await macroReadState(conn)
  const gained = end.credits !== null && start.credits !== null ? end.credits - start.credits : null
  return [
    `sell_cargo DONE${gained !== null ? `: +${gained.toLocaleString()} cr` : ''}. Wallet ${end.credits?.toLocaleString() ?? '?'} cr.`,
    sold.length ? `Sold: ${sold.join(', ')}` : 'Sold: nothing',
    skipped.length ? `Skipped (excluded): ${skipped.join(', ')}` : '',
    ammoIds.size ? `Ammo protected (your guns fire it — sell it deliberately with \`sell\` if you really mean to): ${[...ammoIds].join(', ')}` : '',
    failed.length ? `Not sold: ${failed.join(', ')}` : '',
  ].filter(Boolean).join('\n')
}

// Reads whose tails carry what the agent needs (fuel, hull, mission counters)
// get a taller cap; keyFieldsPrelude guards those fields even past it. The
// 4,000-char default cut get_status at the ship block on lib_v2, so the model
// re-queried for fuel it had just been sent.
const RESULT_CHAR_CAPS: Record<string, number> = {
  get_status: 12_000, get_ship: 12_000, get_missions: 12_000, get_active_missions: 12_000,
}

function truncateResult(text: string, deepCommand?: string): string {
  const cap = (deepCommand && RESULT_CHAR_CAPS[deepCommand]) || MAX_RESULT_CHARS
  return safeTruncate(text, cap, '\n\n... (truncated)')
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return safeTruncate(text, max - 3, '...')
}

const REDACTED_KEYS = new Set(['password', 'token', 'secret', 'api_key'])

function formatArgs(args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    if (REDACTED_KEYS.has(key)) { parts.push(`${key}=XXX`); continue }
    const str = typeof value === 'string' ? value : JSON.stringify(value)
    const t = str.length > 60 ? str.slice(0, 57) + '...' : str
    parts.push(`${key}=${t}`)
  }
  return parts.join(' ')
}

function formatToolResult(name: string, result: unknown, notifications?: unknown[]): string {
  const parts: string[] = []
  if (notifications && Array.isArray(notifications) && notifications.length > 0) {
    parts.push('Notifications:')
    for (const n of notifications) {
      const parsed = parseNotification(n)
      if (parsed) parts.push(`  > [${parsed.tag}] ${parsed.text}`)
    }
    parts.push('')
  }
  if (typeof result === 'string') {
    parts.push(result)
  } else {
    parts.push(jsonToYaml(result))
  }
  return parts.join('\n')
}

function parseNotification(n: unknown): { tag: string; text: string } | null {
  if (typeof n === 'string') return { tag: 'EVENT', text: n }
  if (typeof n !== 'object' || n === null) return null

  const notif = n as Record<string, unknown>
  const type = notif.type as string | undefined
  const msgType = notif.msg_type as string | undefined
  let data = notif.data as Record<string, unknown> | string | undefined

  if (typeof data === 'string') {
    try { data = JSON.parse(data) as Record<string, unknown> } catch { /* leave as string */ }
  }

  if (msgType === 'chat_message' && data && typeof data === 'object') {
    const channel = (data.channel as string) || '?'
    const sender = (data.sender as string) || 'Unknown'
    const content = (data.content as string) || ''
    if (sender === '[ADMIN]') return { tag: 'BROADCAST', text: content }
    if (channel === 'private') return { tag: `DM from ${sender}`, text: content }
    return { tag: `CHAT ${channel.toUpperCase()}`, text: `${sender}: ${content}` }
  }

  const tag = (type || msgType || 'EVENT').toUpperCase()
  let message: string
  if (data && typeof data === 'object') {
    message = (data.message as string) || (data.content as string) || JSON.stringify(data)
  } else if (typeof data === 'string') {
    message = data
  } else {
    message = (notif.message as string) || JSON.stringify(n)
  }
  return { tag, text: message }
}

function jsonToYaml(value: unknown, indent: number = 0): string {
  const pad = '  '.repeat(indent)

  if (value === null || value === undefined) return `${pad}~`
  if (typeof value === 'boolean') return `${pad}${value}`
  if (typeof value === 'number') return `${pad}${value}`
  if (typeof value === 'string') {
    if (
      value === '' || value === 'true' || value === 'false' ||
      value === 'null' || value === '~' ||
      value.includes('\n') || value.includes(': ') ||
      value.startsWith('{') || value.startsWith('[') ||
      value.startsWith("'") || value.startsWith('"') ||
      value.startsWith('#') || /^[\d.e+-]+$/i.test(value)
    ) {
      return `${pad}"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
    }
    return `${pad}${value}`
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`
    if (value.every(v => v === null || typeof v !== 'object')) {
      const items = value.map(v => {
        if (typeof v === 'string') return `"${v.replace(/"/g, '\\"')}"`
        return String(v ?? '~')
      })
      const oneLine = `${pad}[${items.join(', ')}]`
      if (oneLine.length < 120) return oneLine
    }
    const lines: string[] = []
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        lines.push(`${pad}- ${jsonToYaml(item, indent + 1).trimStart()}`)
      } else {
        lines.push(`${pad}- ${jsonToYaml(item, 0).trimStart()}`)
      }
    }
    return lines.join('\n')
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return `${pad}{}`
    const lines: string[] = []
    for (const [key, val] of entries) {
      if (val !== null && typeof val === 'object') {
        lines.push(`${pad}${key}:`)
        lines.push(jsonToYaml(val, indent + 1))
      } else {
        lines.push(`${pad}${key}: ${jsonToYaml(val, 0).trimStart()}`)
      }
    }
    return lines.join('\n')
  }

  return `${pad}${String(value)}`
}
