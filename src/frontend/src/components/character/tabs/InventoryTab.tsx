/** Inventory tab — the fleet ledger's view of this agent's holdings, value-aware:
 *  realisable value uses min(held, bid depth) × best bid, never price × holdings. */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Package } from 'lucide-react'
import type { Profile } from '@/types'
import { DossierCard } from '../DossierCard'
import { DISPLAY, StatCell, Freshness, ageOf, parseTs, fmtCr } from '../dossier-shared'

interface Bid { price: number; qty: number | null; station: string; observed_at: string }

interface Row {
  item_id: string
  quantity: number
  location: string   // 'Ship cargo' or station id
  inCargo: boolean
  updated_at: string
  bid?: Bid
}

type SortKey = 'item' | 'quantity' | 'location' | 'updated' | 'value'

const STALE_MS = 48 * 3600_000

function stationLabel(id: string): string {
  return id.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
}

/** Realisable = min(held, bid depth) × price. Depth-less bids are an unvalidated ceiling. */
function realisable(r: Row): { value: number; capped: boolean; depthKnown: boolean } | null {
  if (!r.bid) return null
  const depthKnown = r.bid.qty != null
  const sellable = depthKnown ? Math.min(r.quantity, r.bid.qty!) : r.quantity
  return { value: sellable * r.bid.price, capped: depthKnown && r.bid.qty! < r.quantity, depthKnown }
}

export function InventoryTab({ profile }: { profile: Profile; connected?: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [locFilter, setLocFilter] = useState<'all' | 'cargo' | 'storage'>('all')
  const [sortKey, setSortKey] = useState<SortKey>('item')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const fetchInv = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const resp = await fetch(`/api/inventory/profile/${profile.id}`)
      if (resp.ok) {
        const d = await resp.json()
        const bids: Record<string, Bid> = d.bids ?? {}
        const out: Row[] = []
        for (const c of d.cargo ?? []) {
          out.push({ item_id: c.item_id, quantity: c.quantity, location: 'Ship cargo', inCargo: true, updated_at: c.updated_at ?? '', bid: bids[c.item_id] })
        }
        for (const [station, items] of Object.entries(d.stations ?? {})) {
          for (const it of items as Array<{ item_id: string; quantity: number; updated_at: string }>) {
            out.push({ item_id: it.item_id, quantity: it.quantity, location: station, inCargo: false, updated_at: it.updated_at ?? '', bid: bids[it.item_id] })
          }
        }
        setRows(out)
        setFetchedAt(Date.now())
      }
    } catch { /* keep last */ }
    setLoading(false)
  }, [profile.id])

  useEffect(() => {
    fetchInv()
    const t = setInterval(() => fetchInv(true), 30000)
    return () => clearInterval(t)
  }, [fetchInv])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir(key === 'quantity' || key === 'updated' || key === 'value' ? 'desc' : 'asc') }
  }

  const view = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return (rows ?? [])
      .filter(r => locFilter === 'all' || (locFilter === 'cargo' ? r.inCargo : !r.inCargo))
      .filter(r => !needle || r.item_id.toLowerCase().includes(needle) || r.location.toLowerCase().includes(needle))
      .slice()
      .sort((a, b) => {
        let cmp = 0
        if (sortKey === 'item') cmp = a.item_id.localeCompare(b.item_id)
        else if (sortKey === 'quantity') cmp = a.quantity - b.quantity
        else if (sortKey === 'location') cmp = a.location.localeCompare(b.location)
        else if (sortKey === 'value') cmp = (realisable(a)?.value ?? -1) - (realisable(b)?.value ?? -1)
        else cmp = (a.updated_at || '').localeCompare(b.updated_at || '')
        return sortDir === 'asc' ? cmp : -cmp
      })
  }, [rows, filter, locFilter, sortKey, sortDir])

  const stats = useMemo(() => {
    const totalUnits = view.reduce((n, r) => n + r.quantity, 0)
    let realisableSum = 0
    let pricedLines = 0
    let depthUnknown = 0
    let staleLines = 0
    const now = Date.now()
    for (const r of view) {
      const v = realisable(r)
      if (v) {
        realisableSum += v.value
        pricedLines++
        if (!v.depthKnown) depthUnknown++
      }
      const seen = parseTs(r.updated_at)
      if (seen > 0 && now - seen > STALE_MS) staleLines++
    }
    return { totalUnits, realisableSum, pricedLines, depthUnknown, staleLines }
  }, [view])

  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '')
  const th = 'text-left px-3 py-1.5 text-[9px] uppercase tracking-wider text-muted-foreground cursor-pointer select-none hover:text-foreground'

  return (
    <DossierCard
      title="Known Inventory"
      icon={<Package size={12} />}
      source="Server"
      className="min-h-[140px]"
      action={
        <span className="flex items-center gap-2">
          <Freshness at={fetchedAt} />
          <button onClick={() => fetchInv()} className="text-muted-foreground hover:text-foreground transition-colors" title="Refresh">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </span>
      }
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 px-3 py-3 border-b border-border/40">
        <StatCell label="Lines" value={view.length.toLocaleString()} sub={`${stats.totalUnits.toLocaleString()} units`} />
        <StatCell
          label="Realisable"
          value={stats.pricedLines > 0 ? `${fmtCr(stats.realisableSum)} cr` : '—'}
          accent={stats.pricedLines > 0 ? 'var(--smui-yellow)' : undefined}
          sub={stats.pricedLines > 0 ? `${stats.pricedLines} priced line${stats.pricedLines === 1 ? '' : 's'}` : 'no market lookups yet'}
          hint="min(held, bid depth) × best bid, summed over lines with a known bid — never price × holdings"
        />
        <StatCell
          label="Depth Unknown"
          value={String(stats.depthUnknown)}
          accent={stats.depthUnknown > 0 ? 'var(--smui-orange)' : undefined}
          sub={stats.depthUnknown > 0 ? 'value is a ceiling' : undefined}
          hint="Bids recorded before depth capture existed — realisable value unvalidated"
        />
        <StatCell
          label="Stale >48h"
          value={String(stats.staleLines)}
          accent={stats.staleLines > 0 ? 'var(--smui-orange)' : undefined}
          hint="Snapshot rows older than 48h — may claim items that are long gone"
        />
      </div>

      <div className="flex items-center gap-2 flex-wrap px-3 py-2 border-b border-border/40">
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder='filter items or locations — e.g. "ore", "war citadel"…'
          className="flex-1 min-w-[200px] bg-transparent border border-border px-2 py-1 text-[12px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary"
        />
        {(['all', 'cargo', 'storage'] as const).map(k => (
          <button key={k} onClick={() => setLocFilter(k)}
            className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border ${locFilter === k ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
            {k === 'all' ? 'all' : k === 'cargo' ? 'ship cargo' : 'station storage'}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
        <table className="w-full text-[12.5px] tabular-nums">
          <thead className="sticky top-0 bg-card" style={DISPLAY}>
            <tr className="border-b border-border">
              <th className={th} onClick={() => toggleSort('item')}>Item{arrow('item')}</th>
              <th className={`${th} text-right`} onClick={() => toggleSort('quantity')}>Qty{arrow('quantity')}</th>
              <th className={`${th} text-right`} title="min(held, bid depth) × best bid" onClick={() => toggleSort('value')}>Realisable{arrow('value')}</th>
              <th className={th}>Best bid</th>
              <th className={th} onClick={() => toggleSort('location')}>Stored at{arrow('location')}</th>
              <th className={`${th} text-right`} onClick={() => toggleSort('updated')}>Seen{arrow('updated')}</th>
            </tr>
          </thead>
          <tbody>
            {rows === null ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground text-[11px]">Loading…</td></tr>
            ) : view.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground text-[11px]">No matching inventory.</td></tr>
            ) : view.map((r, i) => {
              const v = realisable(r)
              const seenTs = parseTs(r.updated_at)
              const stale = seenTs > 0 && Date.now() - seenTs > STALE_MS
              return (
                <tr key={`${r.item_id}-${r.location}-${i}`} className="border-b border-border/40">
                  <td className="px-3 py-1.5 font-medium">{r.item_id}</td>
                  <td className="px-3 py-1.5 text-right">{r.quantity.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right">
                    {v ? (
                      <span
                        style={{ color: `hsl(${v.depthKnown ? 'var(--smui-yellow)' : 'var(--smui-orange)'})` }}
                        title={v.depthKnown
                          ? (v.capped ? `bid depth ${r.bid!.qty!.toLocaleString()} caps the sellable quantity` : 'full holding fits inside bid depth')
                          : 'depth unknown — pre-depth-capture bid; value is a ceiling'}
                      >
                        {v.value.toLocaleString()}{v.capped ? '*' : ''}{!v.depthKnown ? '?' : ''}
                      </span>
                    ) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground text-[11.5px]">
                    {r.bid ? (
                      <>
                        {r.bid.price.toLocaleString()}
                        <span className="text-muted-foreground/60">{r.bid.qty != null ? ` ×${r.bid.qty.toLocaleString()}` : ' (depth unknown)'}</span>
                        <span className="text-muted-foreground/50"> · {stationLabel(r.bid.station)} · {ageOf(r.bid.observed_at)}</span>
                      </>
                    ) : <span className="text-muted-foreground/40">no lookup</span>}
                  </td>
                  <td className={`px-3 py-1.5 ${r.inCargo ? 'text-[hsl(var(--smui-frost-2))]' : 'text-muted-foreground'}`}>
                    {r.inCargo ? 'Ship cargo' : stationLabel(r.location)}
                  </td>
                  <td className="px-3 py-1.5 text-right" style={stale ? { color: 'hsl(var(--smui-orange))' } : undefined} title={r.updated_at || undefined}>
                    <span className={stale ? '' : 'text-muted-foreground'}>{ageOf(r.updated_at)}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="px-3 py-2 border-t border-border/40 text-[10px] text-muted-foreground/60">
        “Seen” is snapshot age — <span style={{ color: 'hsl(var(--smui-orange))' }}>orange</span> rows are 48h+ old and may be stale until the agent next docks there.
        Realisable values marked * are capped by bid depth; ? means the bid predates depth capture and the value is an unvalidated ceiling.
      </p>
    </DossierCard>
  )
}
