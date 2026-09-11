/** Plan tab — the agent's directive queue: plan steps with conditions, applied between turns (docs/plans/directive-queue.md). */
import { useState, useEffect, useCallback } from 'react'
import { ListChecks, Plus, Play, Check, X, Trash2, ChevronUp, ChevronDown, RefreshCw, Pencil } from 'lucide-react'
import type { Profile, PlanStep, PlanCondition } from '@/types'
import { DossierCard } from '../DossierCard'
import { DISPLAY, Chip, Freshness } from '../dossier-shared'

type QueuedStep = PlanStep & { waiting_on: string | null }

const STATUS_COLOR: Record<PlanStep['status'], string> = {
  queued: 'var(--muted-foreground)', active: 'var(--chart-2, #4ade80)', done: 'var(--chart-1, #60a5fa)', cancelled: '#f87171', skipped: '#fbbf24',
}

function describeCondition(c: PlanCondition | null): string {
  if (!c || Object.keys(c).length === 0) return 'docked (default)'
  const parts: string[] = []
  if (c.admiral_go) parts.push('Admiral fires it')
  if (c.docked_at) parts.push(`docked at ${c.docked_at}`)
  else if (c.docked !== false) parts.push('docked')
  if (c.in_system) parts.push(`in ${c.in_system}`)
  if (c.result_matches) parts.push(`a result contains "${c.result_matches}"`)
  if (c.storage_at_least) parts.push(`${c.storage_at_least.item_id} ≥ ${c.storage_at_least.qty} at ${c.storage_at_least.station_id}`)
  if (typeof c.wallet_at_least === 'number') parts.push(`wallet ≥ ${c.wallet_at_least.toLocaleString()}`)
  if (c.after) parts.push(`after ${c.after}`)
  return parts.join(' · ')
}

interface Draft {
  plan_name: string; title: string; directive: string; todo: string
  docked_at: string; result_matches: string; storage_station: string; storage_item: string; storage_qty: string
  wallet_at_least: string; admiral_go: boolean; completion_matches: string; restore_on_done: boolean
}
const EMPTY: Draft = { plan_name: '', title: '', directive: '', todo: '', docked_at: '', result_matches: '', storage_station: '', storage_item: '', storage_qty: '',
  wallet_at_least: '', admiral_go: false, completion_matches: '', restore_on_done: false }

function draftToBody(d: Draft) {
  const condition: PlanCondition = {}
  if (d.docked_at.trim()) condition.docked_at = d.docked_at.trim()
  if (d.result_matches.trim()) condition.result_matches = d.result_matches.trim()
  if (d.storage_station.trim() && d.storage_item.trim() && Number(d.storage_qty) > 0) condition.storage_at_least = { station_id: d.storage_station.trim(), item_id: d.storage_item.trim(), qty: Number(d.storage_qty) }
  if (d.wallet_at_least.trim()) condition.wallet_at_least = Number(d.wallet_at_least)
  if (d.admiral_go) condition.admiral_go = true
  const completion: PlanCondition | null = d.completion_matches.trim() ? { docked: false, result_matches: d.completion_matches.trim() } : null
  return { title: d.title.trim() || undefined, directive: d.directive, todo: d.todo.trim() || undefined, condition, completion, restore_on_done: d.restore_on_done }
}

export function PlanTab({ profile }: { profile: Profile; connected: boolean }) {
  const [steps, setSteps] = useState<QueuedStep[]>([])
  const [cap, setCap] = useState<number>(1200)
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [editDirective, setEditDirective] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/profiles/${profile.id}/plan`)
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || r.statusText)
      setSteps(j.steps); setCap(j.cap); setFetchedAt(Date.now()); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [profile.id])

  useEffect(() => { void load(); const t = setInterval(() => void load(), 15_000); return () => clearInterval(t) }, [load])

  const call = useCallback(async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`/api/profiles/${profile.id}/plan${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { setError(j.error || r.statusText); return null }
    setError(null); await load(); return j
  }, [profile.id, load])

  const submit = async () => {
    if (!draft.directive.trim()) { setError('directive is required'); return }
    const body = draftToBody(draft)
    const planId = draft.plan_name.trim() ? draft.plan_name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') : undefined
    const ok = await call('POST', '', { plan_id: planId, plan_name: draft.plan_name.trim(), steps: [body] })
    if (ok) { setDraft({ ...EMPTY, plan_name: draft.plan_name }); setShowForm(false) }
  }

  const move = async (s: QueuedStep, dir: -1 | 1) => {
    const same = steps.filter(x => x.plan_id === s.plan_id).sort((a, b) => a.seq - b.seq)
    const i = same.findIndex(x => x.id === s.id); const j = i + dir
    if (j < 0 || j >= same.length) return
    await call('PUT', `/${s.id}`, { seq: same[j].seq }); await call('PUT', `/${same[j].id}`, { seq: s.seq })
  }

  const plans = Array.from(new Set(steps.map(s => s.plan_id)))
  const over = draft.directive.length > cap

  return (
    <div className="grid gap-3 h-full min-h-0 grid-rows-[auto_1fr]">
      <DossierCard title="Directive queue" icon={<ListChecks size={12} />}
        action={<div className="flex items-center gap-2">
          {fetchedAt && <Freshness at={fetchedAt} />}
          <button className="text-[10px] uppercase tracking-wider px-2 py-0.5 border border-border hover:bg-accent flex items-center gap-1" onClick={() => void load()} title="Refresh"><RefreshCw size={10} /></button>
          <button className="text-[10px] uppercase tracking-wider px-2 py-0.5 border border-border hover:bg-accent flex items-center gap-1" onClick={() => setShowForm(v => !v)}><Plus size={10} /> Step</button>
        </div>}>
        <div className="px-3 py-2 text-[11px] text-muted-foreground leading-relaxed">
          Steps apply <span className="text-foreground">between turns</span> when their condition holds — never mid-route or mid-macro. The agent sees only the active step.
          Directive cap for this agent: <span className="text-foreground tabular-nums">{cap.toLocaleString()}</span> chars.
          {error && <div className="mt-1 text-red-400">{error}</div>}
        </div>
        {showForm && (
          <div className="px-3 pb-3 grid gap-2 text-[11px]">
            <div className="grid grid-cols-2 gap-2">
              <input className="bg-background border border-border px-2 py-1" placeholder="Plan name (groups steps)" value={draft.plan_name} onChange={e => setDraft({ ...draft, plan_name: e.target.value })} />
              <input className="bg-background border border-border px-2 py-1" placeholder="Step title" value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} />
            </div>
            <textarea className={`bg-background border px-2 py-1 font-mono text-[11px] min-h-[120px] ${over ? 'border-red-500' : 'border-border'}`} placeholder="Directive text — replaces the agent's directive when the step applies" value={draft.directive} onChange={e => setDraft({ ...draft, directive: e.target.value })} />
            <div className={`text-[10px] tabular-nums ${over ? 'text-red-400' : 'text-muted-foreground'}`}>{draft.directive.length.toLocaleString()} / {cap.toLocaleString()} chars</div>
            <input className="bg-background border border-border px-2 py-1" placeholder="TODO to seed at the same time (optional, one-time facts only)" value={draft.todo} onChange={e => setDraft({ ...draft, todo: e.target.value })} />
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-1" style={DISPLAY}>Applies when (all that are set; docked is always required)</div>
            <div className="grid grid-cols-2 gap-2">
              <input className="bg-background border border-border px-2 py-1" placeholder="docked at station id" value={draft.docked_at} onChange={e => setDraft({ ...draft, docked_at: e.target.value })} />
              <input className="bg-background border border-border px-2 py-1" placeholder='a tool result contains… e.g. "sell_cargo DONE"' value={draft.result_matches} onChange={e => setDraft({ ...draft, result_matches: e.target.value })} />
              <input className="bg-background border border-border px-2 py-1" placeholder="storage station id" value={draft.storage_station} onChange={e => setDraft({ ...draft, storage_station: e.target.value })} />
              <div className="grid grid-cols-[1fr_80px] gap-2">
                <input className="bg-background border border-border px-2 py-1" placeholder="item id" value={draft.storage_item} onChange={e => setDraft({ ...draft, storage_item: e.target.value })} />
                <input className="bg-background border border-border px-2 py-1" placeholder="≥ qty" value={draft.storage_qty} onChange={e => setDraft({ ...draft, storage_qty: e.target.value })} />
              </div>
              <input className="bg-background border border-border px-2 py-1" placeholder="wallet at least (credits)" value={draft.wallet_at_least} onChange={e => setDraft({ ...draft, wallet_at_least: e.target.value })} />
              <label className="flex items-center gap-2"><input type="checkbox" checked={draft.admiral_go} onChange={e => setDraft({ ...draft, admiral_go: e.target.checked })} /> only when I fire it (never automatic)</label>
            </div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-1" style={DISPLAY}>Retires when (optional)</div>
            <div className="grid grid-cols-2 gap-2">
              <input className="bg-background border border-border px-2 py-1" placeholder='a later tool result contains… e.g. "deposit_items DONE"' value={draft.completion_matches} onChange={e => setDraft({ ...draft, completion_matches: e.target.value })} />
              <label className="flex items-center gap-2"><input type="checkbox" checked={draft.restore_on_done} onChange={e => setDraft({ ...draft, restore_on_done: e.target.checked })} /> restore the displaced directive when done</label>
            </div>
            <div className="flex gap-2 justify-end">
              <button className="text-[10px] uppercase tracking-wider px-2 py-1 border border-border hover:bg-accent" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="text-[10px] uppercase tracking-wider px-2 py-1 border border-border bg-accent hover:bg-accent/70 disabled:opacity-50" disabled={over || !draft.directive.trim()} onClick={() => void submit()}>Queue step</button>
            </div>
          </div>
        )}
      </DossierCard>

      <DossierCard title={`Steps (${steps.length})`} icon={<ListChecks size={12} />}>
        {steps.length === 0 && <div className="px-3 py-4 text-[11px] text-muted-foreground">No steps queued. The agent runs on its standing directive.</div>}
        {plans.map(planId => {
          const mine = steps.filter(s => s.plan_id === planId).sort((a, b) => a.seq - b.seq)
          return (
            <div key={planId} className="border-b border-border/60 last:border-b-0">
              <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-[1.5px] text-muted-foreground" style={DISPLAY}>{mine[0]?.plan_name || planId} · {mine.filter(s => s.status === 'done').length}/{mine.length} done</div>
              {mine.map((s, i) => (
                <div key={s.id} className={`px-3 py-2 grid gap-1 border-t border-border/40 ${s.status === 'active' ? 'bg-accent/30' : ''}`}>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="tabular-nums text-muted-foreground w-5">{i + 1}.</span>
                    <span className="font-medium flex-1 truncate">{s.title}</span>
                    <Chip label={s.status} color={STATUS_COLOR[s.status]} filled={s.status === 'active'} />
                    <span className="tabular-nums text-[10px] text-muted-foreground" title="directive length">{s.directive.length.toLocaleString()}c{s.todo ? ' +todo' : ''}</span>
                    <div className="flex items-center gap-1">
                      {s.status === 'queued' && <button title="Fire now (applies immediately and restarts the turn)" className="p-0.5 border border-border hover:bg-accent" onClick={() => { if (confirm(`Fire "${s.title}" now? This restarts the agent's turn.`)) void call('POST', `/${s.id}/fire`) }}><Play size={10} /></button>}
                      {s.status === 'active' && <button title="Retire now" className="p-0.5 border border-border hover:bg-accent" onClick={() => void call('POST', `/${s.id}/done`)}><Check size={10} /></button>}
                      {(s.status === 'queued' || s.status === 'active') && <button title="Cancel" className="p-0.5 border border-border hover:bg-accent" onClick={() => void call('PUT', `/${s.id}`, { status: 'cancelled' })}><X size={10} /></button>}
                      {s.status === 'queued' && <>
                        <button title="Move up" className="p-0.5 border border-border hover:bg-accent" onClick={() => void move(s, -1)}><ChevronUp size={10} /></button>
                        <button title="Move down" className="p-0.5 border border-border hover:bg-accent" onClick={() => void move(s, 1)}><ChevronDown size={10} /></button>
                        <button title="Edit directive" className="p-0.5 border border-border hover:bg-accent" onClick={() => { setEditing(editing === s.id ? null : s.id); setEditDirective(s.directive) }}><Pencil size={10} /></button>
                      </>}
                      {s.status !== 'active' && <button title="Delete" className="p-0.5 border border-border hover:bg-accent text-red-400" onClick={() => { if (confirm(`Delete "${s.title}"?`)) void call('DELETE', `/${s.id}`) }}><Trash2 size={10} /></button>}
                    </div>
                  </div>
                  <div className="pl-7 text-[10px] text-muted-foreground">
                    <span className="text-foreground/70">when:</span> {describeCondition(s.condition)}
                    {s.completion && <> · <span className="text-foreground/70">until:</span> {describeCondition(s.completion)}{s.restore_on_done ? ' → restores previous directive' : ''}</>}
                  </div>
                  {s.waiting_on && <div className="pl-7 text-[10px] text-amber-400/90">waiting on: {s.waiting_on}</div>}
                  {(s.fired_at || s.completed_at) && <div className="pl-7 text-[10px] text-muted-foreground tabular-nums">{s.fired_at ? `fired ${new Date(s.fired_at).toLocaleTimeString()}` : ''}{s.completed_at ? ` · done ${new Date(s.completed_at).toLocaleTimeString()}` : ''}</div>}
                  <details className="pl-7">
                    <summary className="text-[10px] text-muted-foreground cursor-pointer">directive</summary>
                    <pre className="mt-1 text-[10px] font-mono whitespace-pre-wrap text-foreground/80 max-h-48 overflow-y-auto">{s.directive}</pre>
                    {s.todo && <pre className="mt-1 text-[10px] font-mono whitespace-pre-wrap text-foreground/60">TODO: {s.todo}</pre>}
                  </details>
                  {editing === s.id && (
                    <div className="pl-7 grid gap-1">
                      <textarea className={`bg-background border px-2 py-1 font-mono text-[11px] min-h-[100px] ${editDirective.length > cap ? 'border-red-500' : 'border-border'}`} value={editDirective} onChange={e => setEditDirective(e.target.value)} />
                      <div className="flex items-center gap-2 text-[10px] tabular-nums text-muted-foreground">{editDirective.length.toLocaleString()} / {cap.toLocaleString()}
                        <button className="ml-auto px-2 py-0.5 border border-border hover:bg-accent uppercase tracking-wider" onClick={() => setEditing(null)}>Cancel</button>
                        <button className="px-2 py-0.5 border border-border bg-accent hover:bg-accent/70 uppercase tracking-wider disabled:opacity-50" disabled={editDirective.length > cap} onClick={async () => { const ok = await call('PUT', `/${s.id}`, { directive: editDirective }); if (ok) setEditing(null) }}>Save</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        })}
      </DossierCard>
    </div>
  )
}
