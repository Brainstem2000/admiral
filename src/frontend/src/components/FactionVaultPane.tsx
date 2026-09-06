/**
 * Faction Vault — the fleet's shared inventory, in full.
 *
 * Faction storage is where ship-build supplies live: it is the only stock any
 * crewmate docked at the station can draw, where personal storage needs its
 * specific owner standing there. So this page answers two questions the
 * per-station cards on the Faction page could not: what does the fleet hold in
 * total, and is it enough for the builds we are stockpiling for.
 *
 * READING AND DEPOSITING ARE DIFFERENT. A remote read succeeds at every station
 * holding our ledgered stock, so a station showing contents is not a station you
 * can deposit at — that needs a lockbox we own. Six stations read; one accepts
 * deposits. The distinction is drawn explicitly here because collapsing it sent
 * an agent off to mine 200 steel_plate for a lockbox that already existed.
 */
import { useEffect, useMemo, useState } from 'react'
import { Warehouse, RefreshCw, Search, LockOpen, Lock, Hammer, AlertTriangle } from 'lucide-react'

const DISPLAY = { fontFamily: "'Chakra Petch', system-ui, sans-serif" } as const

interface Item { item_id: string; name?: string; quantity: number }
interface Station { station_id: string; status: string; items: Item[]; credits: number | null; message?: string }
interface Payload {
  fetched_at: string
  info: Record<string, unknown>
  storage: {
    aggregate_note: string | null
    hinted_total_items: number | null
    stations: Station[]
    deposit_stations?: string[]
    build_needs?: Array<{ item_id: string; needed: number }>
  }
}

const label = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function FactionVaultPane() {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'qty' | 'name' | 'need'>('qty')
  const [onlyNeeded, setOnlyNeeded] = useState(false)

  const load = async (fresh = false) => {
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/faction${fresh ? '?fresh=1' : ''}`)
      const j = await r.json()
      if (j.error) setError(String(j.error)); else setData(j)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const depositable = useMemo(
    () => new Set(data?.storage.deposit_stations ?? []), [data])
  const needs = useMemo(() => {
    const m = new Map<string, number>()
    for (const b of data?.storage.build_needs ?? []) m.set(b.item_id, n(b.needed))
    return m
  }, [data])

  /** One row per item, aggregated across stations, with where it sits. */
  const rows = useMemo(() => {
    const agg = new Map<string, { item_id: string; name: string; total: number; at: Array<[string, number]> }>()
    for (const s of data?.storage.stations ?? []) {
      for (const it of s.items ?? []) {
        if (!it.item_id || !(n(it.quantity) > 0)) continue
        const e = agg.get(it.item_id) ?? { item_id: it.item_id, name: it.name || it.item_id, total: 0, at: [] }
        e.total += n(it.quantity)
        e.at.push([s.station_id, n(it.quantity)])
        agg.set(it.item_id, e)
      }
    }
    let list = [...agg.values()]
    const needle = q.trim().toLowerCase()
    if (needle) list = list.filter(r => `${r.item_id} ${r.name}`.toLowerCase().includes(needle))
    if (onlyNeeded) list = list.filter(r => needs.has(r.item_id))
    list.sort((a, b) =>
      sort === 'name' ? a.item_id.localeCompare(b.item_id)
      : sort === 'need' ? (needs.get(b.item_id) ?? 0) - (needs.get(a.item_id) ?? 0) || b.total - a.total
      : b.total - a.total)
    return list
  }, [data, q, sort, onlyNeeded, needs])

  const totals = useMemo(() => {
    const units = rows.reduce((s, r) => s + r.total, 0)
    const stations = (data?.storage.stations ?? []).filter(s => (s.items ?? []).length > 0).length
    const covered = [...needs.entries()].filter(([id, need]) => {
      const held = rows.find(r => r.item_id === id)?.total ?? 0
      return held >= need
    }).length
    return { units, types: rows.length, stations, covered, needTotal: needs.size }
  }, [rows, data, needs])

  if (error) return <div className="p-6 text-[12px]" style={{ color: 'hsl(var(--smui-red))' }}>Faction vault unavailable: {error}</div>
  if (!data) return <div className="p-6 text-[12px] text-muted-foreground">Reading the vault…</div>

  const readOnly = (data.storage.stations ?? []).filter(s => (s.items ?? []).length > 0 && !depositable.has(s.station_id))

  return (
    <div className="h-full overflow-y-auto">
      <div className="w-full max-w-[1200px] mx-auto px-4 md:px-6 pt-4 pb-8 space-y-4">

        <div className="flex items-baseline gap-3 flex-wrap border-b-2 pb-3" style={{ borderColor: 'hsl(var(--smui-yellow) / 0.6)' }}>
          <Warehouse size={18} style={{ color: 'hsl(var(--smui-yellow))' }} />
          <h1 className="text-xl font-bold uppercase tracking-[0.06em] m-0" style={DISPLAY}>Faction Vault</h1>
          <span className="text-[11px] text-muted-foreground">shared stock — anyone docked there can draw it</span>
          <span className="ml-auto flex items-center gap-3">
            <span className="text-[10.5px] text-muted-foreground tabular-nums">
              {new Date(data.fetched_at).toLocaleTimeString()}
            </span>
            <button onClick={() => void load(true)} disabled={loading}
              className="text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors">
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </button>
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Item types" value={totals.types.toLocaleString()} />
          <Stat label="Units held" value={totals.units.toLocaleString()} accent="var(--smui-yellow)" />
          <Stat label="Stations holding stock" value={String(totals.stations)} />
          <Stat label="Build lines covered" value={totals.needTotal ? `${totals.covered}/${totals.needTotal}` : '—'}
                accent={totals.needTotal && totals.covered === totals.needTotal ? 'var(--smui-green)' : undefined} />
        </div>

        {/* Reading is not depositing — say so before anyone plans around it. */}
        <div className="dossier-card p-3 flex items-start gap-2">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" style={{ color: 'hsl(var(--smui-yellow))' }} />
          <div className="text-[11.5px] leading-relaxed text-foreground/85">
            Deposits work only where the fleet owns a lockbox:{' '}
            {depositable.size
              ? [...depositable].map(s => <b key={s} style={{ color: 'hsl(var(--smui-green))' }}>{label(s)}</b>)
                  .reduce((a, b) => <>{a}, {b}</>)
              : <b style={{ color: 'hsl(var(--smui-red))' }}>nowhere yet</b>}.
            {readOnly.length > 0 && <> The other {readOnly.length} station{readOnly.length > 1 ? 's' : ''} below can be
              <b> read</b> but will refuse a deposit with <code>no_faction_storage</code>.</>}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[180px]">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter items…"
              className="w-full bg-background border border-border pl-7 pr-2 py-1.5 text-[12px] outline-none focus:border-foreground/40" />
          </div>
          <button onClick={() => setOnlyNeeded(v => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] border transition-colors ${onlyNeeded ? 'border-transparent' : 'border-border text-muted-foreground hover:text-foreground'}`}
            style={onlyNeeded ? { background: 'hsl(var(--smui-yellow) / 0.15)', color: 'hsl(var(--smui-yellow))' } : undefined}>
            <Hammer size={11} /> Needed for a build
          </button>
          {(['qty', 'name', 'need'] as const).map(s => (
            <button key={s} onClick={() => setSort(s)}
              className={`px-2.5 py-1.5 text-[11px] border transition-colors ${sort === s ? 'border-foreground/40 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}`}>
              {s === 'qty' ? 'Most held' : s === 'name' ? 'A–Z' : 'Most needed'}
            </button>
          ))}
        </div>

        <div className="dossier-card">
          <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground border-b border-border/60">
            <span>Item</span><span className="text-right">Held</span><span className="text-right pr-1">Build need</span>
          </div>
          {rows.length === 0 && (
            <div className="px-3 py-6 text-[11.5px] text-muted-foreground/70 italic">Nothing matches.</div>
          )}
          {rows.map(r => {
            const need = needs.get(r.item_id)
            const short = need != null && r.total < need
            return (
              <div key={r.item_id} className="border-t border-border/20 px-3 py-1.5">
                <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-baseline">
                  <span className="text-[12px] truncate text-foreground/90">{(r.name || r.item_id).replace(/_/g, ' ')}</span>
                  <span className="text-[12px] tabular-nums text-right">{r.total.toLocaleString()}</span>
                  <span className="text-[11.5px] tabular-nums text-right pr-1 min-w-[86px]"
                    style={{ color: need == null ? 'hsl(var(--muted-foreground))' : short ? 'hsl(var(--smui-red))' : 'hsl(var(--smui-green))' }}>
                    {need == null ? '—' : short ? `short ${(need - r.total).toLocaleString()}` : `covers ${need.toLocaleString()}`}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                  {r.at.sort((a, b) => b[1] - a[1]).map(([st, qty]) => (
                    <span key={st} className="text-[10.5px] text-muted-foreground flex items-center gap-1">
                      {depositable.has(st)
                        ? <LockOpen size={9} style={{ color: 'hsl(var(--smui-green))' }} />
                        : <Lock size={9} className="text-muted-foreground/50" />}
                      {label(st)} <span className="tabular-nums text-foreground/60">{qty.toLocaleString()}</span>
                    </span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Stat({ label: l, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="dossier-card p-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{l}</div>
      <div className="text-[19px] font-bold tabular-nums mt-0.5" style={{ ...DISPLAY, color: accent ? `hsl(var(${accent}))` : undefined }}>{value}</div>
    </div>
  )
}
