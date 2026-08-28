import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Package } from 'lucide-react'
import type { Profile } from '@/types'

interface Row {
  item_id: string
  quantity: number
  location: string   // 'Ship cargo' or station id
  inCargo: boolean
  updated_at: string
}

type SortKey = 'item' | 'quantity' | 'location' | 'updated'

function age(iso: string): string {
  if (!iso) return '—'
  const mins = Math.floor((Date.now() - Date.parse(iso.replace(' ', 'T') + 'Z')) / 60000)
  if (isNaN(mins)) return '—'
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function stationLabel(id: string): string {
  return id.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
}

export function InventoryTab({ profile }: { profile: Profile; connected?: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null)
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
        const out: Row[] = []
        for (const c of d.cargo ?? []) {
          out.push({ item_id: c.item_id, quantity: c.quantity, location: 'Ship cargo', inCargo: true, updated_at: c.updated_at ?? '' })
        }
        for (const [station, items] of Object.entries(d.stations ?? {})) {
          for (const it of items as Array<{ item_id: string; quantity: number; updated_at: string }>) {
            out.push({ item_id: it.item_id, quantity: it.quantity, location: station, inCargo: false, updated_at: it.updated_at ?? '' })
          }
        }
        setRows(out)
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
    else { setSortKey(key); setSortDir(key === 'quantity' || key === 'updated' ? 'desc' : 'asc') }
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
        else cmp = (a.updated_at || '').localeCompare(b.updated_at || '')
        return sortDir === 'asc' ? cmp : -cmp
      })
  }, [rows, filter, locFilter, sortKey, sortDir])

  const totalUnits = view.reduce((n, r) => n + r.quantity, 0)
  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '')
  const th = 'text-left px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground cursor-pointer select-none hover:text-foreground'

  return (
    <div className="dossier-card p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[1.5px] text-muted-foreground font-medium">
          <Package size={12} /> Known inventory
        </span>
        <span className="text-[10px] text-muted-foreground/60">
          from the fleet ledger — snapshots refresh as the agent runs storage/cargo queries
        </span>
        <button onClick={() => fetchInv()} className="ml-auto text-muted-foreground hover:text-foreground" title="Refresh">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder='filter items or locations — e.g. "ore", "war citadel"…'
          className="flex-1 min-w-[200px] bg-transparent border border-border px-2 py-1 text-[12px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary"
        />
        {(['all', 'cargo', 'storage'] as const).map(k => (
          <button key={k} onClick={() => setLocFilter(k)}
            className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border ${locFilter === k ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:text--foreground'}`}>
            {k === 'all' ? 'all' : k === 'cargo' ? 'ship cargo' : 'station storage'}
          </button>
        ))}
        <span className="text-[10px] text-muted-foreground tabular-nums">{view.length} lines · {totalUnits.toLocaleString()} units</span>
      </div>

      <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
        <table className="w-full text-[12.5px] tabular-nums">
          <thead className="sticky top-0 bg-card">
            <tr className="border-b border-border">
              <th className={th} onClick={() => toggleSort('item')}>Item{arrow('item')}</th>
              <th className={`${th} text-right`} onClick={() => toggleSort('quantity')}>Qty{arrow('quantity')}</th>
              <th className={th} onClick={() => toggleSort('location')}>Stored at{arrow('location')}</th>
              <th className={`${th} text-right`} onClick={() => toggleSort('updated')}>Seen{arrow('updated')}</th>
            </tr>
          </thead>
          <tbody>
            {rows === null ? (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground text-[11px]">Loading…</td></tr>
            ) : view.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground text-[11px]">No matching inventory.</td></tr>
            ) : view.map((r, i) => (
              <tr key={`${r.item_id}-${r.location}-${i}`} className="border-b border-border/40">
                <td className="px-3 py-1.5 font-medium">{r.item_id}</td>
                <td className="px-3 py-1.5 text-right">{r.quantity.toLocaleString()}</td>
                <td className={`px-3 py-1.5 ${r.inCargo ? 'text-[hsl(var(--smui-frost-2))]' : 'text-muted-foreground'}`}>
                  {r.inCargo ? 'Ship cargo' : stationLabel(r.location)}
                </td>
                <td className="px-3 py-1.5 text-right text-muted-foreground">{age(r.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-muted-foreground/60">
        “Seen” is snapshot age — old rows may be stale until the agent next docks there (an 8-day-old row once claimed 103 crystals that were long gone).
      </p>
    </div>
  )
}
