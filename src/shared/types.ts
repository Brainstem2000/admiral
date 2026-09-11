export interface Provider {
  id: string
  api_key: string
  base_url: string
  status: 'valid' | 'invalid' | 'unknown' | 'unreachable'
  // Set on API responses instead of api_key: true when a key is stored.
  // The raw key is never sent to the client.
  has_key?: boolean
}

export interface Profile {
  id: string
  name: string
  username: string | null
  password: string | null
  empire: string
  player_id: string | null
  provider: string | null
  model: string | null
  planner_provider: string | null
  planner_model: string | null
  planning_interval: number | null
  /** 1 = deliver volatile state (memory, todo, briefings, fleet orders) as a
   *  per-turn message instead of inside the cached system prompt. */
  volatile_split?: number
  // Additive ChatGPT Business/Codex overlays. The provider/model fields above
  // remain the rollback baseline and are never overwritten by these switches.
  codex_executor_enabled: boolean
  codex_executor_model: string | null
  codex_planner_enabled: boolean
  codex_planner_model: string | null
  directive: string
  todo: string
  memory: string
  context_budget: number | null
  connection_mode: 'http' | 'http_v2' | 'websocket' | 'mcp' | 'mcp_v2' | 'lib_v2'
  server_url: string
  autoconnect: boolean
  enabled: boolean
  sort_order: number
  group_name: string
  created_at: string
  updated_at: string
  // Set on API responses instead of password: true when a password is stored.
  // The raw password is never sent to the client.
  has_password?: boolean
}

export interface LogEntry {
  id: number
  profile_id: string
  timestamp: string
  type: LogType
  summary: string
  detail: string | null
}

export type LogType =
  | 'connection'
  | 'error'
  | 'llm_call'
  | 'llm_thought'
  | 'tool_call'
  | 'tool_result'
  | 'server_message'
  | 'notification'
  | 'system'

export interface AgentStatus {
  profileId: string
  connected: boolean
  mode: 'llm' | 'manual'
  playerData?: Record<string, unknown>
  gameState?: Record<string, unknown> | null
}

export interface GameCommandParam {
  name: string
  type: string
  required: boolean
  description: string
}

export interface GameCommandInfo {
  name: string
  description: string
  isMutation: boolean
  params: GameCommandParam[]
}

/** One queued directive for an agent's plan (see docs/plans/directive-queue.md). */
export type PlanStepStatus = 'queued' | 'active' | 'done' | 'cancelled' | 'skipped'

/** Every present key must hold (AND). Evaluated between turns, so "no macro in flight" is implicit. */
export interface PlanCondition {
  docked?: boolean                 // default true: a step only applies while docked
  docked_at?: string               // station id the agent must be docked at
  in_system?: string               // system id the agent must be in
  result_matches?: string          // a tool result logged after the step was queued contains this text
  storage_at_least?: { station_id: string; item_id: string; qty: number }
  cargo_at_least?: { item_id: string; qty: number }   // the ship's hold, from the live local state
  wallet_at_least?: number
  after?: string                   // ISO timestamp
  admiral_go?: boolean             // never applies on its own; the fire action releases it
}

export interface PlanStep {
  id: string
  profile_id: string
  plan_id: string
  plan_name: string
  seq: number
  title: string
  directive: string
  todo: string | null
  condition: PlanCondition
  completion: PlanCondition | null
  restore_on_done: boolean
  status: PlanStepStatus
  restore_to: string | null
  fired_at: string | null
  completed_at: string | null
  notes: string
  created_at: string
  updated_at: string
}
