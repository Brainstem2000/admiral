/**
 * Frontend-only, best-effort activity detection for the Character dossier page.
 *
 * Combines three signals that already reach the frontend — the SSE `activity`
 * string, the most-recent `tool_call` log summaries, and the cached game state —
 * into a single normalized `ActivityKind` used to pick an animated scene.
 *
 * No backend changes: this is purely a read-side interpretation of existing data.
 */

export type ActivityKind =
  | 'offline'
  | 'idle'
  | 'thinking'
  | 'traveling'
  | 'docking'
  | 'docked'
  | 'combat'
  | 'mining'
  | 'crafting'
  | 'trading'

export interface LogRef {
  /** The log summary, e.g. `game(jump, target_system=valor)` */
  summary: string
  /** ISO-ish timestamp (SQLite UTC `YYYY-MM-DD HH:MM:SS` or full ISO) */
  timestamp: string
}

export interface DeriveInput {
  /** The latest SSE activity string (free text), e.g. "Executing tool: game" */
  activityString: string
  /** Recent `tool_call` log entries (any order) */
  recentToolCalls: LogRef[]
  /** Recent `notification` / `server_message` log entries (any order) */
  recentNotifications: LogRef[]
  /** Cached slim or full game state */
  gameState: Record<string, unknown> | null
  connected: boolean
  running: boolean
  /** Current time in ms; injectable for the staleness tick / tests */
  now?: number
}

export interface ActivityResult {
  kind: ActivityKind
  label: string
  source: 'tool' | 'activity' | 'notification' | 'gamestate' | 'default'
  /** True when the winning signal is aged — the scene should dim/slow. */
  stale: boolean
}

/** A game tick is ~10s; allow generous slack before a tool action is "stale". */
const STALE_MS = 45_000
/** Combat notifications are very fresh-sensitive. */
const COMBAT_NOTIFY_WINDOW_MS = 20_000

const COMBAT_NOTIFY_RE = /attacking you|weapons?[_ ]?fired|under attack|\bbattle\b|hostile|incoming fire|shield_hit|hull_hit/i

/** Station-like POI suffixes — mirrors briefing.ts STATION_POI_RX for docked inference. */
const STATION_POI_RX = /(station|citadel|outpost|trading_post|_post|_hub|_depot|_market|_yard|_dock|_port|_base|_terminal|_spire|_haven|_anchorage|_nexus|_command|_prime)$/i

/** Map a game subcommand to an activity kind. Tunable in one place. */
const SUBCOMMAND_KIND: Record<string, ActivityKind> = {
  jump: 'traveling',
  travel: 'traveling',
  undock: 'traveling',
  dock: 'docking',
  attack: 'combat',
  scan: 'combat',
  battle: 'combat',
  fire: 'combat',
  loot_wreck: 'combat',
  mine: 'mining',
  salvage_wrecks: 'mining',
  craft: 'crafting',
  buy: 'trading',
  sell: 'trading',
  refuel: 'trading',
  view_market: 'trading',
  create_buy_order: 'trading',
  create_sell_order: 'trading',
}

/** Parse `game(<cmd>, <args>)` → { cmd, args }, or null if it isn't a game tool call. */
export function parseGameSubcommand(summary: string): { cmd: string; args: string } | null {
  const m = summary.match(/^game\(\s*([a-z_]+)\s*(?:,\s*([\s\S]*))?\)\s*$/i)
  if (!m) return null
  return { cmd: m[1].toLowerCase(), args: (m[2] || '').trim() }
}

/** Pull a single `key=value` out of a game-args string (best effort, cosmetic). */
function arg(args: string, key: string): string | null {
  const m = args.match(new RegExp(`(?:^|[,\\s])${key}\\s*=\\s*([^,]+)`, 'i'))
  return m ? m[1].trim() : null
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Build a friendly caption from a game subcommand. Cosmetic only. */
export function buildLabel(cmd: string, args: string): string {
  switch (cmd) {
    case 'jump': {
      const t = arg(args, 'target_system')
      return t ? `Jumping to ${t}` : 'Jumping'
    }
    case 'travel': {
      const t = arg(args, 'target_poi')
      return t ? `Traveling to ${t}` : 'Traveling'
    }
    case 'undock':
      return 'Undocking'
    case 'dock':
      return 'Docking'
    case 'attack':
      return 'Attacking'
    case 'battle':
      return 'In battle'
    case 'scan':
      return 'Scanning'
    case 'loot_wreck':
      return 'Looting wreck'
    case 'mine':
      return 'Mining'
    case 'salvage_wrecks':
      return 'Salvaging'
    case 'craft':
      return 'Crafting'
    case 'buy':
      return 'Buying'
    case 'sell':
      return 'Selling'
    case 'refuel':
      return 'Refueling'
    case 'view_market':
      return 'Checking market'
    case 'create_buy_order':
    case 'create_sell_order':
      return 'Trading'
    default:
      return titleCase(cmd.replace(/_/g, ' '))
  }
}

/** Parse a SQLite/ISO timestamp to epoch ms. Mirrors LogPane's toISO handling. */
function parseTs(ts: string): number {
  if (!ts) return 0
  let s = ts.replace(' ', 'T')
  if (!s.includes('Z') && !s.includes('+') && !s.includes('-', 10)) s += 'Z'
  const n = Date.parse(s)
  return isNaN(n) ? 0 : n
}

function newest(refs: LogRef[]): LogRef | null {
  let best: LogRef | null = null
  let bestTs = -1
  for (const r of refs) {
    const t = parseTs(r.timestamp)
    if (t >= bestTs) { bestTs = t; best = r }
  }
  return best
}

function readPoi(gs: Record<string, unknown> | null): string {
  if (!gs) return ''
  const player = gs.player as Record<string, unknown> | undefined
  const location = gs.location as Record<string, unknown> | undefined
  const poi = player?.current_poi ?? location?.poi_name ?? gs.poi
  return typeof poi === 'string' ? poi : ''
}

function isDocked(gs: Record<string, unknown> | null): boolean {
  if (!gs) return false
  const player = gs.player as Record<string, unknown> | undefined
  const location = gs.location as Record<string, unknown> | undefined
  if (player?.docked === true || player?.is_docked === true) return true
  if (gs.docked === true) return true
  if (location && Boolean(location.docked_at)) return true
  const poi = readPoi(gs)
  if (poi && STATION_POI_RX.test(poi)) return true
  if (player?.home_base && poi === player.home_base) return true
  return false
}

/**
 * Derive the current activity from all available signals.
 * Precedence (highest first) — see plan: notifications → fresh tool_call →
 * activity string → game state → idle.
 */
export function deriveActivity(input: DeriveInput): ActivityResult {
  const now = input.now ?? Date.now()

  // 1. Offline short-circuit.
  if (!input.connected) {
    return { kind: 'offline', label: 'Offline', source: 'default', stale: false }
  }

  // 2. Fresh combat notification (catches defensive combat the agent didn't initiate).
  const notif = newest(input.recentNotifications.filter(n => COMBAT_NOTIFY_RE.test(n.summary)))
  if (notif && now - parseTs(notif.timestamp) <= COMBAT_NOTIFY_WINDOW_MS) {
    return { kind: 'combat', label: 'In combat', source: 'notification', stale: false }
  }

  // 3. Freshest mapped tool_call. Primary, most-specific signal.
  const tool = newest(input.recentToolCalls)
  if (tool) {
    const parsed = parseGameSubcommand(tool.summary)
    if (parsed && SUBCOMMAND_KIND[parsed.cmd]) {
      const age = now - parseTs(tool.timestamp)
      if (age <= STALE_MS) {
        return {
          kind: SUBCOMMAND_KIND[parsed.cmd],
          label: buildLabel(parsed.cmd, parsed.args),
          source: 'tool',
          stale: false,
        }
      }
    }
  }

  // 4. SSE activity string.
  const a = input.activityString || ''
  if (/waiting for llm|connecting/i.test(a)) {
    return { kind: 'thinking', label: 'Thinking', source: 'activity', stale: false }
  }
  const exec = a.match(/executing tool:\s*([a-z_]+)/i)
  if (exec) {
    const name = exec[1].toLowerCase()
    if (SUBCOMMAND_KIND[name]) {
      return { kind: SUBCOMMAND_KIND[name], label: buildLabel(name, ''), source: 'activity', stale: false }
    }
    // "Executing tool: game" (no subcommand) or a local tool — agent is busy.
    return { kind: 'thinking', label: 'Working', source: 'activity', stale: false }
  }
  if (/sleeping/i.test(a)) {
    return { kind: 'idle', label: 'Sleeping', source: 'activity', stale: false }
  }
  if (/polling/i.test(a)) {
    return { kind: 'idle', label: 'Standing by', source: 'activity', stale: false }
  }

  // 5. Game state: docked vs adrift. Mark stale (no live action signal).
  if (isDocked(input.gameState)) {
    const poi = readPoi(input.gameState)
    return { kind: 'docked', label: poi ? `Docked · ${poi}` : 'Docked', source: 'gamestate', stale: true }
  }

  // 6. Default idle.
  return { kind: 'idle', label: 'Idle', source: 'default', stale: true }
}
