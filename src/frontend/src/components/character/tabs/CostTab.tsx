/** Cost tab — LLM config, token spend, and ROI for one agent. Analytics only, no game commands. */
import { useState, useEffect } from 'react'
import { Cpu, Coins, TrendingUp } from 'lucide-react'
import type { Profile } from '@/types'
import { DossierCard } from '../DossierCard'

interface TokenStats {
  calls: number
  inputTokens: number
  outputTokens: number
  cost: number
}

interface TokenAnalytics {
  byProfile: Record<string, TokenStats>
  byModel: Record<string, TokenStats>
  timeline: unknown[]
}

interface RoiProfile {
  id: string
  name: string
  totalCredits: number
  apiCost: number
  creditsPerDollar: number
}

type Period = '24h' | '7d' | 'all'
const PERIODS: Period[] = ['24h', '7d', 'all']

/** UTC timestamps in sqlite "YYYY-MM-DD HH:MM:SS" form, matching log_entries storage. */
function sqliteSince(hoursAgo: number): string {
  const d = new Date(Date.now() - hoursAgo * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

function sinceFor(period: Period): string {
  if (period === '24h') return sqliteSince(24)
  if (period === '7d') return sqliteSince(24 * 7)
  return '2000-01-01 00:00:00'
}

function fmtCost(cost: number): string {
  return `$${cost.toFixed(cost >= 100 ? 0 : 2)}`
}

function ConfigRow({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex items-baseline gap-2 py-1 border-t border-border/30 first:border-t-0">
      <span className="text-[10px] uppercase tracking-[1.5px] text-muted-foreground w-32 shrink-0">{label}</span>
      <span className="text-xs truncate" style={accent ? { color: `hsl(${accent})` } : undefined}>{value}</span>
    </div>
  )
}

function StatCell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[1.5px] text-muted-foreground mb-0.5">{label}</div>
      <div className="text-sm font-medium tabular-nums truncate" style={accent ? { color: `hsl(${accent})` } : undefined}>{value}</div>
    </div>
  )
}

export function CostTab({ profile, connected: _connected }: { profile: Profile; connected: boolean }) {
  const [period, setPeriod] = useState<Period>('24h')
  const [tokens, setTokens] = useState<TokenAnalytics | null>(null)
  // undefined = in flight, null = fetch completed with no data for this profile
  const [roi, setRoi] = useState<RoiProfile | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setTokens(null)
    fetch(`/api/analytics/tokens?profileId=${encodeURIComponent(profile.id)}&since=${encodeURIComponent(sinceFor(period))}`)
      .then(r => r.json())
      .then((data: TokenAnalytics) => { if (!cancelled) setTokens(data) })
      .catch(() => { if (!cancelled) setTokens({ byProfile: {}, byModel: {}, timeline: [] }) })
    return () => { cancelled = true }
  }, [profile.id, period])

  useEffect(() => {
    let cancelled = false
    setRoi(undefined)
    fetch('/api/analytics/roi')
      .then(r => r.json())
      .then((data: { profiles: RoiProfile[] }) => {
        if (cancelled) return
        setRoi(Array.isArray(data?.profiles) ? data.profiles.find(p => p.id === profile.id) || null : null)
      })
      .catch(() => { if (!cancelled) setRoi(null) })
    return () => { cancelled = true }
  }, [profile.id])

  const stats = tokens?.byProfile?.[profile.id]
  const models = Object.entries(tokens?.byModel || {}).sort((a, b) => b[1].cost - a[1].cost)

  return (
    <div className="flex flex-col gap-4">
      <DossierCard title="LLM Config" icon={<Cpu size={12} />} source="Local" className="min-h-[100px]" bodyClassName="px-3 py-2">
        <ConfigRow
          label="Model"
          value={profile.provider && profile.model ? `${profile.provider}/${profile.model}` : 'Not configured'}
          accent={profile.provider && profile.model ? 'var(--smui-purple)' : undefined}
        />
        <ConfigRow
          label="Planner"
          value={
            profile.planner_model
              // planner_provider is optional — the backend falls back to the main provider
              ? `${profile.planner_provider || profile.provider}/${profile.planner_model}${profile.planning_interval ? ` · every ${profile.planning_interval} turns` : ''}`
              : 'None'
          }
          accent={profile.planner_model ? 'var(--smui-frost-2)' : undefined}
        />
        <ConfigRow
          label="Context budget"
          value={profile.context_budget ? `${profile.context_budget.toLocaleString()} tokens` : 'Default'}
        />
      </DossierCard>

      <DossierCard
        title="Usage"
        icon={<Coins size={12} />}
        source="Server"
        className="min-h-[120px]"
        bodyClassName="p-3"
        action={
          <span className="flex items-center gap-1">
            {PERIODS.map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-1.5 py-0.5 text-[9px] uppercase tracking-wider border transition-colors ${
                  period === p
                    ? 'border-primary/60 text-primary bg-primary/10'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                {p}
              </button>
            ))}
          </span>
        }
      >
        {!tokens ? (
          <span className="text-[11px] text-muted-foreground/50 italic">Loading...</span>
        ) : !stats || stats.calls === 0 ? (
          <span className="text-[11px] text-muted-foreground/50 italic">No LLM calls in this period.</span>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
              <StatCell label="Calls" value={stats.calls.toLocaleString()} />
              <StatCell label="Input tok" value={stats.inputTokens.toLocaleString()} />
              <StatCell label="Output tok" value={stats.outputTokens.toLocaleString()} />
              <StatCell label="Cost" value={fmtCost(stats.cost)} accent="var(--smui-yellow)" />
            </div>
            {models.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-[1.5px] text-muted-foreground mb-1">By model</div>
                {models.map(([model, m]) => (
                  <div key={model} className="flex items-baseline gap-2 py-1 border-t border-border/30 first:border-t-0">
                    <span className="text-[11px] text-[hsl(var(--smui-purple))] truncate flex-1">{model}</span>
                    <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{m.calls.toLocaleString()} calls</span>
                    <span className="text-[11px] tabular-nums shrink-0" style={{ color: 'hsl(var(--smui-yellow))' }}>{fmtCost(m.cost)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </DossierCard>

      <DossierCard title="ROI" icon={<TrendingUp size={12} />} source="Server" className="min-h-[80px]" bodyClassName="p-3">
        {roi ? (
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-medium tabular-nums" style={{ color: 'hsl(var(--smui-green))' }}>
              {roi.creditsPerDollar.toLocaleString()} cr / $
            </span>
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {roi.totalCredits.toLocaleString()} cr earned · {fmtCost(roi.apiCost)} spent (24h cost window)
            </span>
          </div>
        ) : (
          <span className="text-[11px] text-muted-foreground/50 italic">{roi === undefined ? 'Loading...' : 'No ROI data.'}</span>
        )}
      </DossierCard>
    </div>
  )
}
