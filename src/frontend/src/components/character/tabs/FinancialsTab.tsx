/**
 * Financials tab — wallet statement for one agent: net worth, balance chart with
 * big-move annotations, alerts, cashflow by kind, and the transaction ledger.
 * Ledger endpoints may not be deployed yet — the old server's SPA catch-all
 * answers unknown /api paths with 200 + index.html (NOT 404), so responses are
 * only parsed when the content-type is JSON; every panel degrades to a calm
 * "not available yet" state instead of crashing.
 */
import { useState, useEffect, useMemo } from 'react'
import { Wallet, TrendingUp, AlertTriangle, BarChart3, Receipt, ArrowUpRight, ArrowDownRight } from 'lucide-react'
import type { Profile } from '@/types'
import type { LedgerEntry, LedgerResponse, ReconcileWindow } from '@shared/ledger-types'
import { formatTime } from '@/components/log/log-shared'
import { DossierCard } from '../DossierCard'

interface Snapshot { profile_id: string; timestamp: string; wallet: number; storage: number; total: number }

type Period = '24h' | '7d' | 'all'
const PERIODS: Period[] = ['24h', '7d', 'all']

/** UTC timestamps in sqlite "YYYY-MM-DD HH:MM:SS" form, matching server storage. */
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

function parseTs(ts: string): number {
  const t = Date.parse(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`)
  return Number.isFinite(t) ? t : 0
}

function fmtCr(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
  if (abs >= 10_000) return `${sign}${Math.round(abs / 1_000)}k`
  return `${sign}${abs.toLocaleString()}`
}
function fmtSigned(n: number): string { return n > 0 ? `+${fmtCr(n)}` : fmtCr(n) }

const KIND_COLORS: Record<string, string> = {
  buy: 'var(--smui-red)',
  sell: 'var(--smui-green)',
  order_create: 'var(--smui-orange)',
  order_fill: 'var(--smui-green)',
  order_cancel: 'var(--smui-frost-2)',
  mission_reward: 'var(--smui-green)',
  combat: 'var(--smui-purple)',
  fuel: 'var(--smui-orange)',
  repair: 'var(--smui-orange)',
  dock_fee: 'var(--smui-orange)',
  deposit: 'var(--smui-frost-2)',
  withdraw: 'var(--smui-frost-2)',
  transfer: 'var(--smui-frost-2)',
  other: 'var(--muted-foreground)',
}

// ── Data hook ────────────────────────────────────────────────────────────────

/** undefined = in flight; null = endpoint unavailable (pre-deploy 404) or error. */
function useFinancials(profileId: string, connected: boolean, period: Period) {
  const [ledger, setLedger] = useState<LedgerResponse | null | undefined>(undefined)
  const [reconcile, setReconcile] = useState<ReconcileWindow[] | null | undefined>(undefined)
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null)
  const [liveWallet, setLiveWallet] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const pid = encodeURIComponent(profileId)
    const since = encodeURIComponent(sinceFor(period))
    setLedger(undefined)
    setReconcile(undefined)
    setSnaps(null)

    const asJson = (r: Response): Promise<unknown> | null =>
      r.ok && r.headers.get('content-type')?.includes('application/json') ? r.json() : null

    fetch(`/api/analytics/ledger?profileId=${pid}&since=${since}&limit=2000`)
      .then(asJson)
      .then((data: unknown) => {
        if (cancelled) return
        const d = data as LedgerResponse | null
        setLedger(d && Array.isArray(d.rows) && d.summary ? d : null)
      })
      .catch(() => { if (!cancelled) setLedger(null) })

    fetch(`/api/analytics/ledger/reconcile?profileId=${pid}&since=${since}`)
      .then(asJson)
      .then((data: unknown) => { if (!cancelled) setReconcile(Array.isArray(data) ? (data as ReconcileWindow[]) : null) })
      .catch(() => { if (!cancelled) setReconcile(null) })

    fetch(`/api/analytics/snapshots?profileId=${pid}&since=${since}`)
      .then(r => (r.ok ? r.json() : []))
      .then((data: unknown) => { if (!cancelled) setSnaps(Array.isArray(data) ? (data as Snapshot[]) : []) })
      .catch(() => { if (!cancelled) setSnaps([]) })

    return () => { cancelled = true }
  }, [profileId, period])

  // Live wallet via get_status (free query command), refreshed every 60s like the
  // other tabs — the "live" tag must not go stale; falls back to latest snapshot.
  useEffect(() => {
    if (!connected) { setLiveWallet(null); return }
    let cancelled = false
    const fetchWallet = () => {
      fetch(`/api/profiles/${profileId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'get_status', silent: true }),
      })
        .then(r => r.json())
        .then(data => {
          if (cancelled) return
          const result = data.structuredContent || data.result || data
          const credits = (result?.player as Record<string, unknown> | undefined)?.credits
          if (typeof credits === 'number') setLiveWallet(credits)
        })
        .catch(() => { /* ignore — snapshot fallback */ })
    }
    fetchWallet()
    const t = setInterval(fetchWallet, 60_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [profileId, connected])

  return { ledger, reconcile, snaps, liveWallet }
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[1.5px] text-muted-foreground mb-0.5">{label}</div>
      {children}
    </div>
  )
}

function KindChip({ kind }: { kind: string }) {
  const c = KIND_COLORS[kind] || 'var(--muted-foreground)'
  return (
    <span
      className="text-[9px] uppercase tracking-wider px-1 py-0.5 border inline-block max-w-full truncate align-middle"
      style={{ color: `hsl(${c})`, borderColor: `hsl(${c} / 0.35)` }}
    >
      {kind.replace(/_/g, ' ')}
    </span>
  )
}

const NOT_DEPLOYED = 'Ledger not available yet — deploys with the next server update.'

interface ChartMarker { x: number; y: number; label: string; neg: boolean }
interface AlertItem { severity: 'red' | 'orange' | 'info'; tag: string; text: string }
const SEVERITY_COLOR: Record<AlertItem['severity'], string> = {
  red: 'var(--smui-red)',
  orange: 'var(--smui-orange)',
  info: 'var(--smui-frost-2)',
}

// ── Tab ──────────────────────────────────────────────────────────────────────

export function FinancialsTab({ profile, connected }: { profile: Profile; connected: boolean }) {
  const [period, setPeriod] = useState<Period>('24h')
  const [sortKey, setSortKey] = useState<'amount' | 'time'>('amount')
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')
  const { ledger, reconcile, snaps, liveWallet } = useFinancials(profile.id, connected, period)

  const points = useMemo(() =>
    (snaps || [])
      .filter(s => typeof s.wallet === 'number')
      .map(s => ({ t: parseTs(s.timestamp), v: s.wallet }))
      .filter(p => p.t > 0),
  [snaps])

  const maxWallet = points.length ? Math.max(...points.map(p => p.v)) : 0
  const wallet = liveWallet ?? (points.length ? points[points.length - 1].v : null)
  const pnl = points.length >= 2 ? points[points.length - 1].v - points[0].v : null

  // Escrow = order_create rows with no matching fill/cancel in the period.
  const escrow = useMemo(() => {
    if (!ledger) return null
    const closed = new Set<string>()
    for (const r of ledger.rows) {
      if ((r.kind === 'order_cancel' || r.kind === 'order_fill') && r.order_id) closed.add(r.order_id)
    }
    let sum = 0
    for (const r of ledger.rows) {
      if (r.kind === 'order_create' && (!r.order_id || !closed.has(r.order_id))) sum += Math.abs(r.amount_signed)
    }
    return sum
  }, [ledger])

  const chart = useMemo(() => {
    if (points.length < 2) return null
    const t0 = points[0].t
    const t1 = points[points.length - 1].t
    const span = t1 - t0 || 1
    const vals = points.map(p => p.v)
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const range = max - min || 1
    const xPct = (t: number) => ((t - t0) / span) * 100
    const yPct = (v: number) => 94 - ((v - min) / range) * 88
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPct(p.t).toFixed(2)} ${yPct(p.v).toFixed(2)}`).join(' ')

    // Annotate ledger moves >= 10% of the period max wallet (top 8 by magnitude).
    const markers: ChartMarker[] = []
    if (ledger && max > 0) {
      const big = ledger.rows
        .map(r => ({ r, t: parseTs(r.timestamp) }))
        .filter(({ r, t }) => Math.abs(r.amount_signed) >= max * 0.1 && t >= t0 && t <= t1)
        .sort((a, b) => Math.abs(b.r.amount_signed) - Math.abs(a.r.amount_signed))
        .slice(0, 8)
      for (const { r, t } of big) {
        const j = points.findIndex(p => p.t >= t)
        let v: number
        if (j <= 0) v = points[j === 0 ? 0 : points.length - 1].v
        else {
          const a = points[j - 1]
          const b = points[j]
          v = a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t || 1))
        }
        markers.push({
          x: xPct(t),
          y: yPct(v),
          label: `${fmtSigned(r.amount_signed)} ${r.kind.replace(/_/g, ' ')}${r.item_id ? ` ${r.item_id}` : ''}`,
          neg: r.amount_signed < 0,
        })
      }
    }
    return { path, markers, min, max }
  }, [points, ledger])

  const alerts = useMemo<AlertItem[]>(() => {
    const out: AlertItem[] = []
    if (ledger) {
      // Oversized single buy: >= 50% of the balance it drew from (and >= 1,000 cr so
      // small-wallet restocks don't qualify). One alert per item, top 3 by spend —
      // an unbounded loop here can flood the panel and drown the other signals.
      const bigBuys = new Map<string, { r: LedgerEntry; spend: number; pct: number }>()
      for (const r of ledger.rows) {
        if (r.kind !== 'buy') continue
        const spend = Math.abs(r.amount_signed)
        const denom = r.balance_after != null ? r.balance_after + spend : maxWallet
        if (spend < 1000 || denom <= 0 || spend < denom * 0.5) continue
        const key = r.item_id || '?'
        const prev = bigBuys.get(key)
        if (!prev || spend > prev.spend) bigBuys.set(key, { r, spend, pct: spend / denom })
      }
      const topBuys = [...bigBuys.values()].sort((a, b) => b.spend - a.spend).slice(0, 3)
      for (const { r, pct } of topBuys) {
        out.push({
          severity: 'red',
          tag: 'big buy',
          text: `${fmtCr(r.amount_signed)} cr on ${r.item_id || '?'} — ${Math.round(pct * 100)}% of balance`,
        })
      }
      // Sold below weighted-average buy price for the same item in the period.
      const buys = new Map<string, { cost: number; qty: number }>()
      for (const r of ledger.rows) {
        if (r.kind !== 'buy' || !r.item_id || !r.quantity || r.quantity <= 0) continue
        const b = buys.get(r.item_id) || { cost: 0, qty: 0 }
        b.cost += Math.abs(r.amount_signed)
        b.qty += r.quantity
        buys.set(r.item_id, b)
      }
      const flagged = new Set<string>()
      for (const r of ledger.rows) {
        if (r.kind !== 'sell' || !r.item_id || r.unit_price == null || flagged.has(r.item_id)) continue
        const b = buys.get(r.item_id)
        if (!b || b.qty <= 0) continue
        const avg = b.cost / b.qty
        if (r.unit_price < avg) {
          flagged.add(r.item_id)
          out.push({
            severity: 'orange',
            tag: 'below cost',
            text: `sold ${r.item_id} @ ${Math.round(r.unit_price).toLocaleString()} cr vs avg buy ${Math.round(avg).toLocaleString()} cr`,
          })
        }
      }
    }
    // Rapid drawdown: wallet fell >= 40% from a period peak.
    let peak = 0
    let worst = 0
    let peakAt = 0
    let troughAt = 0
    for (const p of points) {
      if (p.v > peak) peak = p.v
      else if (peak > 0) {
        const dd = (peak - p.v) / peak
        if (dd > worst) { worst = dd; peakAt = peak; troughAt = p.v }
      }
    }
    if (worst >= 0.4) {
      out.push({
        severity: 'red',
        tag: 'drawdown',
        text: `wallet fell ${Math.round(worst * 100)}% (${fmtCr(peakAt)} → ${fmtCr(troughAt)} cr) within the period`,
      })
    }
    // Books don't balance: reconcile residuals (only when the endpoint responds).
    // Small residuals are expected (snapshots read a cached get_status that can lag
    // its timestamp, and a few movement types are unmapped) — only surface when the
    // net residual is material vs the period's booked volume.
    if (Array.isArray(reconcile)) {
      const bad = reconcile.filter(w => w.residual !== 0)
      if (bad.length > 0) {
        const net = bad.reduce((a, w) => a + w.residual, 0)
        const volume = ledger ? ledger.summary.income + Math.abs(ledger.summary.expense) : 0
        if (Math.abs(net) >= Math.max(500, volume * 0.02)) {
          out.push({
            severity: 'info',
            tag: 'unbooked',
            text: `${bad.length} snapshot window${bad.length === 1 ? '' : 's'} with unbooked movement (net ${fmtSigned(net)} cr)`,
          })
        }
      }
    }
    return out
  }, [ledger, reconcile, points, maxWallet])

  const kinds = useMemo(() =>
    Object.entries(ledger?.summary.by_kind || {}).sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total)),
  [ledger])
  const maxKindAbs = Math.max(...kinds.map(([, v]) => Math.abs(v.total)), 1)

  const sortedRows = useMemo(() => {
    const rows = [...(ledger?.rows || [])]
    rows.sort((a, b) => {
      const cmp = sortKey === 'amount'
        ? Math.abs(a.amount_signed) - Math.abs(b.amount_signed)
        : parseTs(a.timestamp) - parseTs(b.timestamp)
      return sortDir === 'desc' ? -cmp : cmp
    })
    return rows
  }, [ledger, sortKey, sortDir])
  const shown = sortedRows.slice(0, 50)
  const totalCount = ledger
    ? Object.values(ledger.summary.by_kind).reduce((a, v) => a + v.count, 0) || ledger.rows.length
    : 0

  function toggleSort(k: 'amount' | 'time') {
    if (k === sortKey) setSortDir(d => (d === 'desc' ? 'asc' : 'desc'))
    else { setSortKey(k); setSortDir('desc') }
  }
  const sortMark = (k: 'amount' | 'time') => (sortKey === k ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '')

  const periodSelector = (
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
  )

  return (
    <div className="flex flex-col gap-4">
      <DossierCard title="Net Worth" icon={<Wallet size={12} />} source="Server" className="min-h-[80px]" bodyClassName="p-3" action={periodSelector}>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
          <Cell label="Wallet">
            {wallet != null ? (
              <div className="text-sm font-medium tabular-nums truncate" style={{ color: 'hsl(var(--smui-yellow))' }}>
                {wallet.toLocaleString()} cr
                <span className="text-[9px] text-muted-foreground/60 ml-1.5 normal-case">{liveWallet != null ? 'live' : 'snapshot'}</span>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground/50">{snaps == null ? 'Loading...' : '—'}</div>
            )}
          </Cell>
          <Cell label="Period P&L">
            {pnl != null ? (
              <div className="flex items-center gap-1 text-sm font-medium tabular-nums" style={{ color: `hsl(${pnl >= 0 ? 'var(--smui-green)' : 'var(--smui-red)'})` }}>
                {pnl >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
                {fmtSigned(pnl)} cr
              </div>
            ) : (
              <div className="text-sm text-muted-foreground/50">{snaps == null ? 'Loading...' : '—'}</div>
            )}
          </Cell>
          <Cell label="Escrowed">
            {escrow != null ? (
              <div className="text-sm font-medium tabular-nums truncate" style={{ color: 'hsl(var(--smui-orange))' }}>
                {escrow.toLocaleString()} cr
                <span className="text-[9px] text-muted-foreground/60 ml-1.5 normal-case">open orders</span>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground/50">{ledger === undefined ? 'Loading...' : '—'}</div>
            )}
          </Cell>
        </div>
      </DossierCard>

      <DossierCard title={`Balance — ${period}`} icon={<TrendingUp size={12} />} source="Server" className="min-h-[120px]" bodyClassName="p-3">
        {snaps == null ? (
          <span className="text-[11px] text-muted-foreground/50 italic">Loading...</span>
        ) : !chart ? (
          <span className="text-[11px] text-muted-foreground/50 italic">Not enough snapshot history for a chart yet.</span>
        ) : (
          <div className="relative h-36 w-full">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
              <path d={chart.path} fill="none" stroke="hsl(var(--smui-frost-2))" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
            </svg>
            <span className="absolute top-0 left-0 text-[9px] text-muted-foreground/60 tabular-nums">{fmtCr(chart.max)}</span>
            <span className="absolute bottom-0 left-0 text-[9px] text-muted-foreground/60 tabular-nums">{fmtCr(chart.min)}</span>
            {chart.markers.map((m, i) => (
              <div
                key={i}
                className="group absolute -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${Math.min(98, Math.max(2, m.x))}%`, top: `${m.y}%` }}
                title={m.label}
              >
                <div className="w-2 h-2 border border-background" style={{ background: `hsl(${m.neg ? 'var(--smui-red)' : 'var(--smui-green)'})` }} />
                <div
                  className={`hidden group-hover:block absolute left-1/2 -translate-x-1/2 px-1.5 py-0.5 border border-border bg-card text-[9px] whitespace-nowrap z-10 ${
                    m.y < 35 ? 'top-full mt-1' : 'bottom-full mb-1'
                  }`}
                >
                  {m.label}
                </div>
              </div>
            ))}
          </div>
        )}
      </DossierCard>

      {alerts.length > 0 && (
        <DossierCard title="Alerts" icon={<AlertTriangle size={12} />} source="Server" bodyClassName="px-3 py-2">
          {alerts.map((a, i) => (
            <div key={i} className="flex items-baseline gap-2 py-1 border-t border-border/30 first:border-t-0">
              <span
                className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 border shrink-0"
                style={{ color: `hsl(${SEVERITY_COLOR[a.severity]})`, borderColor: `hsl(${SEVERITY_COLOR[a.severity]} / 0.4)`, background: `hsl(${SEVERITY_COLOR[a.severity]} / 0.08)` }}
              >
                {a.tag}
              </span>
              <span className="text-[11px] text-foreground/85">{a.text}</span>
            </div>
          ))}
        </DossierCard>
      )}

      <DossierCard title="Cashflow" icon={<BarChart3 size={12} />} source="Server" className="min-h-[100px]" bodyClassName="p-3">
        {ledger === undefined ? (
          <span className="text-[11px] text-muted-foreground/50 italic">Loading...</span>
        ) : ledger === null ? (
          <span className="text-[11px] text-muted-foreground/50 italic">{NOT_DEPLOYED}</span>
        ) : kinds.length === 0 ? (
          <span className="text-[11px] text-muted-foreground/50 italic">No transactions in this period.</span>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-x-4">
              <Cell label="Income">
                <div className="text-sm font-medium tabular-nums" style={{ color: 'hsl(var(--smui-green))' }}>{fmtSigned(ledger.summary.income)} cr</div>
              </Cell>
              <Cell label="Expense">
                <div className="text-sm font-medium tabular-nums" style={{ color: 'hsl(var(--smui-red))' }}>{fmtCr(ledger.summary.expense)} cr</div>
              </Cell>
              <Cell label="Net">
                <div className="text-sm font-medium tabular-nums" style={{ color: `hsl(${ledger.summary.net >= 0 ? 'var(--smui-green)' : 'var(--smui-red)'})` }}>
                  {fmtSigned(ledger.summary.net)} cr
                </div>
              </Cell>
            </div>
            <div className="space-y-1.5">
              {kinds.map(([kind, v]) => (
                <div key={kind} className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-28 shrink-0 truncate">{kind.replace(/_/g, ' ')}</span>
                  <span className="text-[9px] text-muted-foreground/60 tabular-nums w-8 shrink-0 text-right">{v.count}×</span>
                  <div className="flex-1 h-2 bg-border/30 overflow-hidden">
                    <div
                      className="h-full transition-all duration-300"
                      style={{ width: `${(Math.abs(v.total) / maxKindAbs) * 100}%`, background: `hsl(${v.total >= 0 ? 'var(--smui-green)' : 'var(--smui-red)'})` }}
                    />
                  </div>
                  <span className="w-20 shrink-0 text-right text-[11px] tabular-nums" style={{ color: `hsl(${v.total >= 0 ? 'var(--smui-green)' : 'var(--smui-red)'})` }}>
                    {fmtSigned(v.total)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </DossierCard>

      <DossierCard title="Transactions" icon={<Receipt size={12} />} source="Server" className="min-h-[120px]">
        {ledger === undefined ? (
          <div className="px-3 py-3 text-[11px] text-muted-foreground/50 italic">Loading...</div>
        ) : ledger === null ? (
          <div className="px-3 py-3 text-[11px] text-muted-foreground/50 italic">{NOT_DEPLOYED}</div>
        ) : ledger.rows.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-muted-foreground/50 italic">No transactions in this period.</div>
        ) : (
          <>
            <div className="flex items-center gap-2.5 px-3 py-1.5 border-b border-border/40 text-[9px] uppercase tracking-wider text-muted-foreground">
              <span className="w-20 shrink-0">Kind</span>
              <span className="flex-1 min-w-0">Item</span>
              <span className="w-24 shrink-0 text-right hidden sm:block">Qty × Price</span>
              <button onClick={() => toggleSort('amount')} className="w-20 shrink-0 text-right hover:text-foreground transition-colors">
                Amount{sortMark('amount')}
              </button>
              <span className="w-24 shrink-0 hidden md:block">Counterparty</span>
              <button onClick={() => toggleSort('time')} className="w-14 shrink-0 text-right hover:text-foreground transition-colors">
                Time{sortMark('time')}
              </button>
            </div>
            {shown.map(r => (
              <TransactionRow key={r.id} r={r} />
            ))}
            {totalCount > shown.length && (
              <div className="px-3 py-1.5 text-[10px] text-muted-foreground/60 border-t border-border/30">
                Showing top {shown.length} of {totalCount.toLocaleString()}
                {totalCount > 2000 ? ' (sorted within the newest 2,000)' : ''}
              </div>
            )}
          </>
        )}
      </DossierCard>
    </div>
  )
}

function TransactionRow({ r }: { r: LedgerEntry }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-1.5 border-t border-border/30 first:border-t-0 text-xs">
      <span className="w-20 shrink-0"><KindChip kind={r.kind} /></span>
      <span className="flex-1 min-w-0 truncate text-foreground/85">{r.item_id ? r.item_id.replace(/_/g, ' ') : '—'}</span>
      <span className="w-24 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums hidden sm:block">
        {r.quantity != null && r.unit_price != null ? `${r.quantity.toLocaleString()} × ${Math.round(r.unit_price).toLocaleString()}` : ''}
      </span>
      <span className="w-20 shrink-0 text-right tabular-nums" style={{ color: `hsl(${r.amount_signed >= 0 ? 'var(--smui-green)' : 'var(--smui-red)'})` }}>
        {fmtSigned(r.amount_signed)}
      </span>
      <span className="w-24 shrink-0 truncate text-[10px] text-muted-foreground hidden md:block">{r.counterparty || ''}</span>
      <span className="w-14 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums">{formatTime(r.timestamp)}</span>
    </div>
  )
}
