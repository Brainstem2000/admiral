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
  isStorageDirty, listPlanSteps, nextQueuedPlanStep, updatePlanStep, updateProfile, type PlanStepRow,
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

interface LiveState { dockedAt: string | null; systemId: string | null; credits: number | null; known: boolean }

function readLive(ctx: PlanEvalContext): LiveState {
  const gs = ctx.connection?.getLocalState?.() ?? null
  if (!gs) return { dockedAt: null, systemId: null, credits: null, known: false }
  const loc = (gs.location ?? {}) as Record<string, unknown>
  const player = (gs.player ?? {}) as Record<string, unknown>
  const dockedAt = typeof loc.docked_at === 'string' && loc.docked_at ? loc.docked_at : null
  const systemId = typeof loc.system_id === 'string' ? loc.system_id : null
  const credits = typeof gs.credits === 'number' ? gs.credits : (typeof player.credits === 'number' ? player.credits : null)
  return { dockedAt, systemId, credits, known: 'docked_at' in loc || systemId !== null }
}

/** Refresh a stale storage snapshot for a station the agent is docked at — the fact a
 *  step depends on must be real, not the last view_storage (deposits do not refresh it). */
const storageRefreshAt = new Map<string, number>()
const STORAGE_REFRESH_COOLDOWN_MS = 60_000
async function refreshStorageIfStale(ctx: PlanEvalContext, stationId: string, live: LiveState): Promise<void> {
  if (!ctx.connection || live.dockedAt !== stationId) return
  if (!isStorageDirty(ctx.profileId)) return
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
  if (cond.result_matches) {
    const hit = findToolResultSince(ctx.profileId, step.since_log_id, cond.result_matches)
    if (!hit) return `no tool result containing "${cond.result_matches}" yet`
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
  if (active?.completion_json) {
    const why = await unmetReason(parseCondition(active.completion_json), active, ctx)
    if (why === null) out.completed = completePlanStep(active.id, 'completion condition met', ctx.log)
  }
  const next = nextQueuedPlanStep(ctx.profileId)
  if (next) {
    const why = await unmetReason(parseCondition(next.condition_json), next, ctx)
    if (why === null) out.applied = applyPlanStep(next.id, 'condition', ctx.log)
  }
  return out.completed || out.applied ? out : null
}

/** Panel helper: the queue with each pending step's current blocker spelled out. */
export async function describePlanQueue(ctx: PlanEvalContext): Promise<Array<PlanStep & { waiting_on: string | null }>> {
  const rows = listPlanSteps(ctx.profileId)
  const out: Array<PlanStep & { waiting_on: string | null }> = []
  for (const r of rows) {
    let waiting: string | null = null
    if (r.status === 'queued') waiting = await unmetReason(parseCondition(r.condition_json), r, ctx)
    else if (r.status === 'active' && r.completion_json) {
      const w = await unmetReason(parseCondition(r.completion_json), r, ctx)
      waiting = w === null ? 'completion condition met — retires at the next turn boundary' : `runs until: ${w}`
    }
    out.push({ ...rowToStep(r), waiting_on: waiting })
  }
  return out
}
