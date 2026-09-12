/**
 * Directive queue — task-specific directives queued per agent as plan steps and
 * applied automatically at the right time (docs/plans/directive-queue.md).
 *
 * Decided 2026-09-10: the agent sees ONLY the active step's directive; a step is
 * applied BETWEEN TURNS (the loop head in agent.ts), never through restartTurn, so
 * it can never interrupt a route or a running macro; the default gate is "docked".
 * Applying a step writes the profile's directive (and optional TODO) — the existing
 * prompt rebuild picks it up on the next turn. Every fire and completion is a
 * `system` log entry; a condition that does not hold is silent.
 *
 * The two hand-rolled watchers of 2026-09-10 (CyberSpock's crafting phase, Ledger's
 * expedition) are the fixtures this replaces: "docked at X, no macro, storage ≥ N"
 * and "sell_cargo DONE at Nova Terra, then docked".
 */
import type { PlanCondition, PlanStep } from '../../shared/types'
import {
  activePlanStep, addLogEntry, findToolResultSince, getPlanStep, getProfile, getStorageQuantity,
  headQueuedPlanSteps, isStorageDirty, listPlanSteps, storageSnapshotAgeMs, updatePlanStep, updateProfile, type PlanStepRow,
} from './db'
import type { GameConnection } from './connections/interface'
import { recordStorageFromCommand } from './tools'

/** Local-model directives must stay small enough to steer gpt-oss; hosted models get more room. */
export const LOCAL_DIRECTIVE_CAP = 1200
export const HOSTED_DIRECTIVE_CAP = 4000
const LOCAL_PROVIDERS = new Set(['custom', 'ollama', 'lmstudio'])

export function directiveCapFor(profileId: string): number {
  const p = getProfile(profileId)
  return p && LOCAL_PROVIDERS.has(String(p.provider)) ? LOCAL_DIRECTIVE_CAP : HOSTED_DIRECTIVE_CAP
}

export function rowToStep(r: PlanStepRow): PlanStep {
  return {
    id: r.id, profile_id: r.profile_id, plan_id: r.plan_id, plan_name: r.plan_name, seq: r.seq, title: r.title,
    directive: r.directive, todo: r.todo, condition: parseCondition(r.condition_json), completion: r.completion_json ? parseCondition(r.completion_json) : null,
    restore_on_done: !!r.restore_on_done, status: r.status, restore_to: r.restore_to, fired_at: r.fired_at, completed_at: r.completed_at,
    notes: r.notes, created_at: r.created_at, updated_at: r.updated_at,
  }
}

export function parseCondition(json: string | null | undefined): PlanCondition {
  if (!json) return {}
  try { const v = JSON.parse(json); return v && typeof v === 'object' ? v as PlanCondition : {} } catch { return {} }
}

/** What the evaluator reads about the agent right now. Everything comes from harness state; no agent turn is spent. */
export interface PlanEvalContext {
  profileId: string
  connection?: GameConnection | null
  now?: Date
  /** The agent's own logger (persists AND streams to the dashboard); addLogEntry when absent. */
  log?: (type: string, summary: string) => void
}

type StepLogger = ((type: string, summary: string) => void) | undefined
function emit(profileId: string, log: StepLogger, summary: string): void {
  if (log) log('system', summary)
  else addLogEntry(profileId, 'system', summary)
}

interface LiveState {
  dockedAt: string | null; systemId: string | null; credits: number | null; known: boolean
  /** item_id → quantity aboard, or null when the hold has never been read into the local state. */
  cargo: Map<string, number> | null
}

/** The hold as the connection cached it from the last player-scoped result (get_cargo, refuel,
 *  sell …): an array of {item_id, quantity} rows, sometimes wrapped as {cargo: [...]} or {items: [...]}. */
function readCargo(raw: unknown): Map<string, number> | null {
  let rows: unknown = raw
  if (rows && typeof rows === 'object' && !Array.isArray(rows)) {
    const o = rows as Record<string, unknown>
    rows = Array.isArray(o.cargo) ? o.cargo : Array.isArray(o.items) ? o.items : null
  }
  if (!Array.isArray(rows)) return null
  const out = new Map<string, number>()
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const it = r as Record<string, unknown>
    const id = typeof it.item_id === 'string' ? it.item_id : typeof it.id === 'string' ? it.id : null
    const qty = typeof it.quantity === 'number' ? it.quantity : Number(it.quantity ?? NaN)
    if (id && Number.isFinite(qty)) out.set(id, (out.get(id) ?? 0) + qty)
  }
  return out
}

function readLive(ctx: PlanEvalContext): LiveState {
  const gs = ctx.connection?.getLocalState?.() ?? null
  if (!gs) return { dockedAt: null, systemId: null, credits: null, known: false, cargo: null }
  const loc = (gs.location ?? {}) as Record<string, unknown>
  const player = (gs.player ?? {}) as Record<string, unknown>
  const dockedAt = typeof loc.docked_at === 'string' && loc.docked_at ? loc.docked_at : null
  const systemId = typeof loc.system_id === 'string' ? loc.system_id : null
  const credits = typeof gs.credits === 'number' ? gs.credits : (typeof player.credits === 'number' ? player.credits : null)
  return { dockedAt, systemId, credits, known: 'docked_at' in loc || systemId !== null, cargo: readCargo(gs.cargo) }
}

/** Refresh a stale storage snapshot for a station the agent is docked at — the fact a
 *  step depends on must be real, not the last view_storage (deposits do not refresh it). */
const storageRefreshAt = new Map<string, number>()
const STORAGE_REFRESH_COOLDOWN_MS = 60_000
/** A snapshot older than this is re-read even when nothing marked it dirty: a gift
 *  RECEIVED changes the recipient's storage without any command of theirs. */
const STORAGE_SNAPSHOT_STALE_MS = 5 * 60_000
async function refreshStorageIfStale(ctx: PlanEvalContext, stationId: string, live: LiveState): Promise<void> {
  if (!ctx.connection || live.dockedAt !== stationId) return
  const age = storageSnapshotAgeMs(ctx.profileId, stationId)
  const fresh = age !== null && age < STORAGE_SNAPSHOT_STALE_MS
  if (!isStorageDirty(ctx.profileId) && fresh) return
  const key = `${ctx.profileId}:${stationId}`
  const last = storageRefreshAt.get(key) ?? 0
  if (Date.now() - last < STORAGE_REFRESH_COOLDOWN_MS) return
  storageRefreshAt.set(key, Date.now())
  try {
    const resp = await ctx.connection.execute('view_storage', { station_id: stationId })
    const data = (resp as { structuredContent?: unknown; result?: unknown }).structuredContent ?? (resp as { result?: unknown }).result
    recordStorageFromCommand('view_storage', data, ctx.profileId)
  } catch { /* the condition simply keeps waiting */ }
}

/**
 * Does every present key of the condition hold right now? Returns the first
 * unmet reason (for the panel / debugging) or null when it holds.
 */
export async function unmetReason(cond: PlanCondition, step: { since_log_id: number }, ctx: PlanEvalContext): Promise<string | null> {
  const live = readLive(ctx)
  const now = ctx.now ?? new Date()
  if (cond.admiral_go) return 'waiting for the Admiral (fire it from the panel)'
  if (cond.after && now.getTime() < Date.parse(cond.after)) return `waits until ${cond.after}`
  const needDocked = cond.docked !== false || !!cond.docked_at
  if (needDocked) {
    if (!live.known) return 'agent state unknown (not connected)'
    if (!live.dockedAt) return 'not docked'
    if (cond.docked_at && live.dockedAt !== cond.docked_at) return `docked at ${live.dockedAt}, needs ${cond.docked_at}`
  }
  if (cond.in_system) {
    if (!live.known) return 'agent state unknown (not connected)'
    if (live.systemId !== cond.in_system) return `in ${live.systemId ?? '?'}, needs ${cond.in_system}`
  }
  if (typeof cond.wallet_at_least === 'number') {
    if (live.credits === null) return 'wallet unknown'
    if (live.credits < cond.wallet_at_least) return `wallet ${live.credits} < ${cond.wallet_at_least}`
  }
  if (cond.storage_at_least) {
    const s = cond.storage_at_least
    await refreshStorageIfStale(ctx, s.station_id, live)
    const have = getStorageQuantity(ctx.profileId, s.station_id, s.item_id)
    if (have < s.qty) return `${s.item_id} at ${s.station_id}: ${have} < ${s.qty}`
  }
  // The hold itself. 2026-09-11: a load step retired on "docked at War Citadel" while the
  // agent had skipped two of its three withdraw lines, so the next step's orders were
  // wrong for what he actually carried and he flew back. Gate on the cargo, not the dock.
  if (cond.cargo_at_least) {
    const c = cond.cargo_at_least
    if (!live.cargo) return 'cargo unknown'
    const have = live.cargo.get(c.item_id) ?? 0
    if (have < c.qty) return `cargo ${c.item_id}: ${have} < ${c.qty}`
  }
  if (cond.result_matches) {
    const needle = String(cond.result_matches)   // an object here 500'd every plan read on 2026-09-11
    const hit = findToolResultSince(ctx.profileId, step.since_log_id, needle)
    if (!hit) return `no tool result containing "${needle}" yet`
  }
  return null
}

function planPosition(step: PlanStepRow): string {
  const all = listPlanSteps(step.profile_id, step.plan_id)
  const idx = all.findIndex(s => s.id === step.id)
  return `${idx + 1}/${all.length}`
}

/** Write the step's directive (and TODO) to the profile and mark it active. Pure state change — no restart. */
export function applyPlanStep(stepId: string, how: 'condition' | 'fired' = 'condition', log?: StepLogger): PlanStepRow | undefined {
  const step = getPlanStep(stepId)
  if (!step) return undefined
  const profile = getProfile(step.profile_id)
  if (!profile) return undefined
  const prev = activePlanStep(step.profile_id)
  if (prev && prev.id !== step.id) updatePlanStep(prev.id, { status: 'done', completed_at: new Date().toISOString() })
  updateProfile(step.profile_id, { directive: step.directive, ...(step.todo ? { todo: step.todo } : {}) })
  const updated = updatePlanStep(step.id, {
    status: 'active', fired_at: new Date().toISOString(), restore_to: profile.directive ?? '',
    // completion conditions look at results AFTER the step went live, not since it was queued
    since_log_id: currentMaxLogId(step.profile_id),
  })
  const label = step.plan_name ? `Plan «${step.plan_name}» step ${planPosition(step)}` : `Plan step ${planPosition(step)}`
  emit(step.profile_id, log, `${label} ${how === 'fired' ? 'FIRED by the Admiral' : 'applied'}: ${step.title} (${step.directive.length} chars${step.todo ? ', TODO replaced' : ''})`)
  return updated
}

function currentMaxLogId(profileId: string): number {
  const r = findToolResultSince(profileId, 0, '')
  return r?.id ?? 0
}

/** Mark the active step done; optionally restore the directive it displaced. */
export function completePlanStep(stepId: string, reason: string, log?: StepLogger): PlanStepRow | undefined {
  const step = getPlanStep(stepId)
  if (!step) return undefined
  const updated = updatePlanStep(step.id, { status: 'done', completed_at: new Date().toISOString() })
  let restored = ''
  if (step.restore_on_done && step.restore_to) {
    updateProfile(step.profile_id, { directive: step.restore_to })
    restored = '; previous directive restored'
  }
  emit(step.profile_id, log, `Plan step ${planPosition(step)} done: ${step.title} (${reason}${restored})`)
  return updated
}

/**
 * One evaluation at a turn boundary: retire the active step if its completion
 * condition holds, then apply at most ONE queued step whose condition holds.
 * Returns what changed (for the caller's log), or null when nothing did.
 */
export async function advancePlanQueue(ctx: PlanEvalContext): Promise<{ completed?: PlanStepRow; applied?: PlanStepRow } | null> {
  const out: { completed?: PlanStepRow; applied?: PlanStepRow } = {}
  const active = activePlanStep(ctx.profileId)
  // Strict order within a plan: while the active step has a completion condition
  // that does not hold yet, its own successors wait — whatever their conditions say.
  // 2026-09-11: CyberSpock's "buy titanium" step (completion: titanium ≥ 120) and the
  // next step both gated on "docked at War Citadel"; the successor applied one
  // boundary later and displaced the unfinished step, so the titanium was never bought.
  let blockedPlan: string | null = null
  if (active?.completion_json) {
    const why = await unmetReason(parseCondition(active.completion_json), active, ctx)
    if (why === null) out.completed = completePlanStep(active.id, 'completion condition met', ctx.log)
    else blockedPlan = active.plan_id
  }
  // Plans are independent: evaluate the head step of every plan and apply the first
  // whose condition holds (one per boundary).
  for (const next of headQueuedPlanSteps(ctx.profileId)) {
    if (blockedPlan !== null && next.plan_id === blockedPlan) continue
    const why = await unmetReason(parseCondition(next.condition_json), next, ctx)
    if (why === null) { out.applied = applyPlanStep(next.id, 'condition', ctx.log); break }
  }
  return out.completed || out.applied ? out : null
}

/** Panel helper: the queue with each pending step's current blocker spelled out. */
/**
 * Coerce a condition from the API into the documented shapes, dropping anything
 * malformed. A `result_matches` written as an object (2026-09-11) reached the
 * evaluator, which called `.toLowerCase()` on it, and every plan read for that
 * profile answered HTTP 500 until the row was repaired by hand. Returns the
 * usable condition (null when nothing remains) and the keys it rejected.
 */
export function sanitizeCondition(v: unknown): { cond: PlanCondition | null; rejected: string[] } {
  if (v === null || v === undefined) return { cond: null, rejected: [] }
  if (typeof v !== 'object' || Array.isArray(v)) return { cond: null, rejected: ['condition'] }
  const raw = v as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const rejected: string[] = []
  const str = (k: string) => { if (typeof raw[k] === 'string' && raw[k]) out[k] = raw[k]; else if (raw[k] !== undefined) rejected.push(k) }
  const num = (k: string) => { const n = Number(raw[k]); if (raw[k] !== undefined && Number.isFinite(n) && n >= 0) out[k] = n; else if (raw[k] !== undefined) rejected.push(k) }
  if (raw.docked !== undefined) { if (typeof raw.docked === 'boolean') out.docked = raw.docked; else rejected.push('docked') }
  if (raw.admiral_go !== undefined) { if (typeof raw.admiral_go === 'boolean') out.admiral_go = raw.admiral_go; else rejected.push('admiral_go') }
  str('docked_at'); str('in_system'); str('result_matches'); num('wallet_at_least')
  if (raw.after !== undefined) { if (typeof raw.after === 'string' && Number.isFinite(Date.parse(raw.after))) out.after = raw.after; else rejected.push('after') }
  for (const k of ['storage_at_least', 'cargo_at_least'] as const) {
    const o = raw[k] as Record<string, unknown> | undefined
    if (o === undefined) continue
    const ok = !!o && typeof o === 'object' && typeof o.item_id === 'string' && Number.isFinite(Number(o.qty)) && (k === 'cargo_at_least' || typeof o.station_id === 'string')
    if (ok) out[k] = k === 'cargo_at_least' ? { item_id: o.item_id, qty: Number(o.qty) } : { station_id: o.station_id, item_id: o.item_id, qty: Number(o.qty) }
    else rejected.push(k)
  }
  return { cond: Object.keys(out).length ? out as PlanCondition : null, rejected }
}

export async function describePlanQueue(ctx: PlanEvalContext): Promise<Array<PlanStep & { waiting_on: string | null }>> {
  const rows = listPlanSteps(ctx.profileId)
  const out: Array<PlanStep & { waiting_on: string | null }> = []
  // Same rule as advancePlanQueue: an unfinished active step holds its own plan's successors.
  const active = rows.find(r => r.status === 'active' && r.completion_json)
  const activeUnmet = active ? await unmetReason(parseCondition(active.completion_json!), active, ctx) : null
  for (const r of rows) {
    let waiting: string | null = null
    if (r.status === 'queued') {
      waiting = active && activeUnmet !== null && r.plan_id === active.plan_id
        ? `waits for the active step to finish (${activeUnmet})`
        : await unmetReason(parseCondition(r.condition_json), r, ctx)
    } else if (r.status === 'active' && r.completion_json) {
      const w = r.id === active?.id ? activeUnmet : await unmetReason(parseCondition(r.completion_json), r, ctx)
      waiting = w === null ? 'completion condition met — retires at the next turn boundary' : `runs until: ${w}`
    }
    out.push({ ...rowToStep(r), waiting_on: waiting })
  }
  return out
}
