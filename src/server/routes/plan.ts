import { Hono } from 'hono'
import { agentManager } from '../lib/agent-manager'
import { deletePlanStep, getPlanStep, getProfile, insertPlanStep, listPlanSteps, updatePlanStep } from '../lib/db'
import { applyPlanStep, completePlanStep, describePlanQueue, directiveCapFor, rowToStep, sanitizeCondition, type PlanEvalContext } from '../lib/plan-queue'
import type { PlanCondition } from '../../shared/types'

/**
 * The directive queue for one agent (docs/plans/directive-queue.md).
 *
 *   GET    /api/profiles/:id/plan                 the queue, each pending step with what it waits on
 *   POST   /api/profiles/:id/plan                 { plan_id?, plan_name?, steps: [{ title, directive, todo?, condition?, completion?, restore_on_done?, notes? }] }
 *   PUT    /api/profiles/:id/plan/:stepId         edit fields; status 'cancelled' | 'skipped' | 'queued' allowed here
 *   DELETE /api/profiles/:id/plan/:stepId
 *   POST   /api/profiles/:id/plan/:stepId/fire    apply NOW regardless of condition, then restart the turn (operator override)
 *   POST   /api/profiles/:id/plan/:stepId/done    retire the active step now (restores the displaced directive if the step says so)
 *
 * Steps apply between turns from the agent loop; this file never applies one
 * except through the explicit fire action.
 */
const plan = new Hono()

function evalCtx(profileId: string): PlanEvalContext {
  const agent = agentManager.getAgent(profileId)
  const state = agent?.gameState ?? null
  // The evaluator only needs getLocalState here; the loop-head hook passes the real connection.
  const connection = state ? ({ getLocalState: () => state } as unknown as PlanEvalContext['connection']) : null
  return { profileId, connection }
}

function cleanCondition(v: unknown): PlanCondition | null {
  return sanitizeCondition(v).cond
}
/** Names of condition keys the caller sent in a shape the evaluator cannot use. */
function rejectedConditionKeys(v: unknown): string[] { return sanitizeCondition(v).rejected }

function validateDirective(profileId: string, directive: unknown): string | null {
  if (typeof directive !== 'string' || !directive.trim()) return 'directive is required'
  const cap = directiveCapFor(profileId)
  if (directive.length > cap) return `directive is ${directive.length} chars; the cap for this agent is ${cap}`
  return null
}

plan.get('/:id/plan', async (c) => {
  const id = c.req.param('id')
  if (!getProfile(id)) return c.json({ error: 'Profile not found' }, 404)
  const steps = await describePlanQueue(evalCtx(id))
  return c.json({ steps, cap: directiveCapFor(id) })
})

plan.post('/:id/plan', async (c) => {
  const id = c.req.param('id')
  if (!getProfile(id)) return c.json({ error: 'Profile not found' }, 404)
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  const stepsIn = Array.isArray(body?.steps) ? body!.steps as Array<Record<string, unknown>> : null
  if (!stepsIn || stepsIn.length === 0) return c.json({ error: 'steps[] is required' }, 400)
  const planId = String(body?.plan_id ?? crypto.randomUUID().slice(0, 8))
  const planName = String(body?.plan_name ?? '')
  const existing = listPlanSteps(id, planId)
  let seq = existing.reduce((m, s) => Math.max(m, s.seq), 0)
  const created = []
  for (const s of stepsIn) {
    const bad = [...rejectedConditionKeys(s.condition), ...rejectedConditionKeys(s.completion)]
    if (bad.length) return c.json({ error: `condition field(s) in an unusable shape: ${bad.join(', ')} — result_matches is a substring, after is an ISO time, docked_at/in_system are ids` }, 400)
    const err = validateDirective(id, s.directive)
    if (err) return c.json({ error: err, step: s.title ?? created.length + 1 }, 400)
    seq += 1
    created.push(rowToStep(insertPlanStep({
      id: crypto.randomUUID(), profile_id: id, plan_id: planId, plan_name: planName, seq,
      title: String(s.title ?? `Step ${seq}`), directive: String(s.directive), todo: typeof s.todo === 'string' && s.todo.trim() ? s.todo : null,
      condition_json: JSON.stringify(cleanCondition(s.condition) ?? {}),
      completion_json: cleanCondition(s.completion) ? JSON.stringify(cleanCondition(s.completion)) : null,
      restore_on_done: s.restore_on_done ? 1 : 0, notes: String(s.notes ?? ''),
    })))
  }
  return c.json({ plan_id: planId, steps: created }, 201)
})

plan.put('/:id/plan/:stepId', async (c) => {
  const id = c.req.param('id'); const stepId = c.req.param('stepId')
  const step = getPlanStep(stepId)
  if (!step || step.profile_id !== id) return c.json({ error: 'Step not found' }, 404)
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return c.json({ error: 'JSON body required' }, 400)
  const patch: Record<string, unknown> = {}
  if ('directive' in body) { const err = validateDirective(id, body.directive); if (err) return c.json({ error: err }, 400); patch.directive = body.directive }
  if ('title' in body) patch.title = String(body.title ?? '')
  if ('todo' in body) patch.todo = typeof body.todo === 'string' && body.todo.trim() ? body.todo : null
  {
    const bad = [...('condition' in body ? rejectedConditionKeys(body.condition) : []), ...('completion' in body ? rejectedConditionKeys(body.completion) : [])]
    if (bad.length) return c.json({ error: `condition field(s) in an unusable shape: ${bad.join(', ')}` }, 400)
  }
  if ('condition' in body) patch.condition_json = JSON.stringify(cleanCondition(body.condition) ?? {})
  if ('completion' in body) patch.completion_json = cleanCondition(body.completion) ? JSON.stringify(cleanCondition(body.completion)) : null
  if ('restore_on_done' in body) patch.restore_on_done = body.restore_on_done ? 1 : 0
  if ('seq' in body) patch.seq = Number(body.seq) || step.seq
  if ('notes' in body) patch.notes = String(body.notes ?? '')
  if ('plan_name' in body) patch.plan_name = String(body.plan_name ?? '')
  if ('status' in body) {
    const st = String(body.status)
    if (!['queued', 'cancelled', 'skipped'].includes(st)) return c.json({ error: "status may only be set to 'queued', 'cancelled' or 'skipped' here; use /fire and /done for the rest" }, 400)
    if (step.status === 'active' && st !== 'cancelled') return c.json({ error: 'an active step can only be cancelled (or retired with /done)' }, 400)
    patch.status = st
  }
  const updated = updatePlanStep(stepId, patch as never)
  return c.json(updated ? rowToStep(updated) : null)
})

plan.delete('/:id/plan/:stepId', (c) => {
  const id = c.req.param('id'); const stepId = c.req.param('stepId')
  const step = getPlanStep(stepId)
  if (!step || step.profile_id !== id) return c.json({ error: 'Step not found' }, 404)
  if (step.status === 'active') return c.json({ error: 'cancel or retire the active step before deleting it' }, 400)
  deletePlanStep(stepId)
  return c.json({ ok: true })
})

plan.post('/:id/plan/:stepId/fire', (c) => {
  const id = c.req.param('id'); const stepId = c.req.param('stepId')
  const step = getPlanStep(stepId)
  if (!step || step.profile_id !== id) return c.json({ error: 'Step not found' }, 404)
  if (step.status === 'done' || step.status === 'cancelled') return c.json({ error: `step is ${step.status}` }, 400)
  const applied = applyPlanStep(stepId, 'fired')
  // The operator chose "now": the turn restarts so the new orders take effect immediately.
  agentManager.restartTurn(id)
  return c.json(applied ? rowToStep(applied) : null)
})

plan.post('/:id/plan/:stepId/done', (c) => {
  const id = c.req.param('id'); const stepId = c.req.param('stepId')
  const step = getPlanStep(stepId)
  if (!step || step.profile_id !== id) return c.json({ error: 'Step not found' }, 404)
  if (step.status !== 'active') return c.json({ error: 'only the active step can be retired' }, 400)
  const done = completePlanStep(stepId, 'retired by the Admiral')
  return c.json(done ? rowToStep(done) : null)
})

export default plan
