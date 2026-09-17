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
import { Warehouse, RefreshCw, Search, LockOpen, Lock, Hammer, AlertTriangle, Receipt, Factory, Rocket } from 'lucide-react'

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
  // Two jobs live here and they are read at different times: 'what do we hold against the
  // builds' and 'where did the money go'. One page made both harder to scan, so they are
  // separate views rather than one long scroll.
  const [tab, setTab] = useState<'inventory' | 'ledger' | 'rent' | 'build' | 'ship'>('inventory')

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
          <span className="text-[11px] text-muted-foreground">
            {tab === 'inventory'
              ? 'shared stock — anyone docked there can draw it'
              : tab === 'ledger' ? 'every credit in and out of the faction treasury, with a reason'
              : tab === 'rent' ? 'what the fleet pays to keep its facilities standing'
              : 'the facility programme in build order — each entry measured against what the one above leaves behind'}
          </span>
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

        <div className="flex items-center gap-1.5">
          <TabButton active={tab === 'inventory'} onClick={() => setTab('inventory')} icon={<Warehouse size={12} />}>
            Inventory
          </TabButton>
          <TabButton active={tab === 'ledger'} onClick={() => setTab('ledger')} icon={<Receipt size={12} />}>
            Treasury ledger
          </TabButton>
          <TabButton active={tab === 'rent'} onClick={() => setTab('rent')} icon={<Factory size={12} />}>
            Facility rent
          </TabButton>
          <TabButton active={tab === 'build'} onClick={() => setTab('build')} icon={<Hammer size={12} />}>
            Build queue
          </TabButton>
          <TabButton active={tab === 'ship'} onClick={() => setTab('ship')} icon={<Rocket size={12} />}>
            Ship build
          </TabButton>
        </div>

        {tab === 'build' && <BuildQueue />}

        {tab === 'ship' && <ShipBuild />}


        {tab === 'rent' && <FacilityRent />}

        {tab === 'ledger' && <TreasuryStatement />}

        {tab === 'inventory' && <>
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
        </>}
      </div>
    </div>
  )
}

/** Tab switch. Two distinct readings of the same vault, not two halves of one page. */
function TabButton({ active, onClick, icon, children }:
  { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-[11.5px] uppercase tracking-[0.1em] border transition-colors ${
        active ? 'border-transparent' : 'border-border text-muted-foreground hover:text-foreground'}`}
      style={active ? { background: 'hsl(var(--smui-yellow) / 0.15)', color: 'hsl(var(--smui-yellow))' } : undefined}>
      {icon}{children}
    </button>
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

/**
 * Treasury statement — every credit in and out, with a reason.
 *
 * The game never reports facility rent as a command result; it is auto-deducted
 * every ~17-minute facility cycle "wherever you are". A ledger built only from
 * command results therefore loses the single biggest recurring outflow, and on
 * 2026-09-16 roughly 193,000 credits had drained from the treasury with nothing
 * to point at. The server reconstructs those by differencing the balances the
 * game DID state against the movements we booked, so this table shows the
 * unattributed remainder as its own line rather than hiding it.
 */
interface TEntry {
  at: string; kind: string; reason: string; credits: number
  balance_after: number | null; profile_name: string | null; inferred: boolean
}
interface TPayload {
  opening: { credits: number; at: string } | null
  closing: { credits: number; at: string; reported_by: string | null } | null
  entries: TEntry[]
  totals: { in: number; out: number; booked: number; inferred: number; net: number; rent: number; rent_cycles: number }
}

// Timestamps are stored UTC without a zone marker; the Admiral reads in Central.
const ct = (iso: string) => {
  const raw = String(iso).trim().replace(' ', 'T')
  const d = new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw + 'Z')
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function TreasuryStatement() {
  const [t, setT] = useState<TPayload | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/faction/treasury/statement?limit=500')
        const j = await r.json()
        if (j.error) setErr(String(j.error)); else setT(j)
      } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    })()
  }, [])

  if (err) return <div className="dossier-card p-3 text-[11.5px]" style={{ color: 'hsl(var(--smui-red))' }}>Treasury statement unavailable: {err}</div>
  if (!t) return <div className="dossier-card p-3 text-[11.5px] text-muted-foreground">Reading the treasury statement…</div>

  const rows = showAll ? t.entries : t.entries.slice(-25)
  // Rent bills every ~17 minutes; express it per day so it can be compared to income.
  const rentPerDay = t.totals.rent_cycles > 0
    ? Math.round((t.totals.rent / t.totals.rent_cycles) * (1440 / 17))
    : 0
  const colourFor = (e: TEntry) =>
    e.kind === 'facility_rent' ? 'hsl(var(--smui-yellow))'
      : e.credits > 0 ? 'hsl(var(--smui-green))' : 'hsl(var(--smui-red))'

  return (
    <div className="dossier-card p-3 space-y-2">
      <div className="flex items-baseline gap-2 flex-wrap">
        <Receipt size={13} style={{ color: 'hsl(var(--smui-yellow))' }} />
        <h2 className="text-[12px] font-bold uppercase tracking-[0.12em] m-0" style={DISPLAY}>Treasury statement</h2>
        <span className="text-[10.5px] text-muted-foreground">every credit in and out, with a reason</span>
        {t.closing && (
          <span className="ml-auto text-[11px] tabular-nums">
            <span className="text-muted-foreground">balance </span>
            <b style={{ color: 'hsl(var(--smui-green))' }}>{t.closing.credits.toLocaleString()}</b>
            <span className="text-muted-foreground"> as of {ct(t.closing.at)} CT</span>
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Paid in" value={t.totals.in.toLocaleString()} accent="var(--smui-green)" />
        <Stat label="Paid out" value={t.totals.out.toLocaleString()} accent="var(--smui-red)" />
        <Stat label="Facility rent / day" value={rentPerDay ? rentPerDay.toLocaleString() : '—'} accent="var(--smui-yellow)" />
        <Stat label="Unattributed" value={(t.totals.inferred - t.totals.rent).toLocaleString()} />
      </div>

      {rentPerDay !== 0 && (
        <div className="text-[11px] leading-relaxed text-foreground/80">
          Rent is charged every ~17-minute facility cycle wherever the owner is — being docked or
          present changes nothing. Unpaid cycles accrue as arrears and the facility is repossessed
          once the station&apos;s grace period lapses, so the treasury has to stay funded even when idle.
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-[11.5px] tabular-nums">
          <thead>
            <tr className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground text-left">
              <th className="font-normal py-1 pr-3">When (CT)</th>
              <th className="font-normal py-1 pr-3">Reason</th>
              <th className="font-normal py-1 pr-3 text-right">Amount</th>
              <th className="font-normal py-1 text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice().reverse().map((e, i) => (
              <tr key={`${e.at}-${i}`} className="border-t border-border/40">
                <td className="py-1 pr-3 whitespace-nowrap text-muted-foreground">{ct(e.at)}</td>
                <td className="py-1 pr-3">
                  <span style={{ color: colourFor(e) }}>{e.reason}</span>
                  {e.inferred && e.kind !== 'facility_rent' && (
                    <span className="ml-1 text-[9.5px] uppercase tracking-wider text-muted-foreground">inferred</span>
                  )}
                </td>
                <td className="py-1 pr-3 text-right" style={{ color: colourFor(e) }}>
                  {e.credits > 0 ? '+' : ''}{e.credits.toLocaleString()}
                </td>
                <td className="py-1 text-right text-foreground/70">
                  {e.balance_after === null ? '—' : e.balance_after.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {t.entries.length > 25 && (
        <button onClick={() => setShowAll(v => !v)}
          className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground transition-colors">
          {showAll ? 'Show recent only' : `Show all ${t.entries.length} entries`}
        </button>
      )}
    </div>
  )
}

/**
 * Facility rent — the treasury's largest standing outflow.
 *
 * The game never reports rent as a command result: it is auto-deducted every facility
 * cycle from the owner's wallet (the faction treasury for faction facilities) wherever
 * the owner is, so it is invisible to a command-result ledger. The per-facility rate IS
 * stated in `facility action=list`, which is captured whenever an agent docks — so this
 * page is only as complete as our last visit to each station, and says so.
 */
interface RentRow {
  station_id: string; facility_type: string; facility_name: string | null
  level: number | null; rent_per_cycle: number; per_day: number
  faction_owned: number; build_cost: number | null; last_seen: string
}
interface RentPayload {
  cycles_per_day: number; cycle_minutes: number
  facilities: RentRow[]
  totals: { per_cycle: number; per_day: number }
  note: string
}

interface BuiltFacility {
  facility_id: string; type: string; name: string
  station_id: string; station_name: string; system_id: string
  rent_per_cycle: number; labor_per_run: number
  under_construction: boolean; first_seen: string | null
}

interface QueueMaterial { item_id: string; needed: number; available: number; short: number; pct: number }
interface QueueEntry {
  id: string; name: string; order: number
  build_cost: number; build_time: number | null; credits_ok: boolean
  materials: QueueMaterial[]; pct: number; buildable: boolean; built?: boolean
  binding: string | null; short_count: number
  missing_from_catalog?: boolean
}

/**
 * The facility programme as an ordered queue.
 *
 * Two things this shows that the flat "needed" column on the Inventory tab cannot:
 *
 *  - **It measures the FACTION VAULT, not fleet-wide stock.** A `faction_build`
 *    draws from faction storage then the builder's cargo and never sees a personal
 *    locker, so fleet totals overstate readiness — a count of 436 control_node on
 *    2026-09-16 was only 202 buildable.
 *  - **The queue is sequential.** Building the first facility consumes its bill, so
 *    each entry is measured against what the entries above it leave behind. That is
 *    why #2 can read 0% on an item the vault visibly holds: #1 has claimed it.
 *
 * Percent is the BINDING ratio — the scarcest input — because that is what gates a
 * build. Averaging would report a facility 100% stocked on steel and 0% on nodes as
 * half done, which is the opposite of useful.
 */
interface PendingBuild {
  definition_id: string; name: string; status: string; build_cost?: number
  materials?: Array<{ item_id: string; name?: string; quantity_required: number; quantity_in_storage?: number; quantity_missing?: number }>
}
interface RentableVenue {
  type: string; name: string; recipe_id: string
  fee_per_run: number; items_per_hour: number; backlog_ticks: number; owner: string; copies: number
}

function BuildQueue() {
  const [data, setData] = useState<{
    station: string; treasury: number; queue: QueueEntry[]; built?: BuiltFacility[]
    under_construction?: PendingBuild[]; rentable?: RentableVenue[]
  } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await fetch('/api/faction/build-queue')
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = await r.json()
        if (alive) { setData(j); setErr(null) }
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : String(e)) }
    }
    void load()
    const t = setInterval(load, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  if (err) return <div className="text-[12px] text-muted-foreground px-1 py-4">Build queue unavailable: {err}</div>
  if (!data) return <div className="text-[12px] text-muted-foreground px-1 py-4">Loading build queue…</div>

  // 'Next up' is the first entry that is neither already standing nor unbuildable-
  // for-lack-of-catalog. A built facility is not next up; it is done.
  const next = data.queue.find(q => !q.missing_from_catalog && !q.built && !q.buildable)
  const ready = data.queue.filter(q => q.buildable)

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat label="Treasury" value={`${data.treasury.toLocaleString()} cr`} accent="var(--smui-yellow)" />
        <Stat label="Buildable now" value={String(ready.length)} accent={ready.length ? 'var(--smui-green)' : undefined} />
        <Stat label="Next up" value={next ? `${(next.pct * 100).toFixed(0)}%` : '—'}
          accent={next && next.pct > 0.8 ? 'var(--smui-green)' : 'var(--smui-orange)'} />
      </div>

      <p className="text-[10.5px] text-muted-foreground/70 px-1">
        Measured against the faction vault at <span className="font-mono">{data.station}</span> — a build cannot
        see personal lockers. Entries are sequential: each is measured against what the ones above it leave behind.
        Percent is the scarcest input, not an average.
      </p>

      {/* What the GAME says is under construction, ahead of anything we merely PLAN.
          The curated list below missed a Tungsten Drawing Frame and then a Railgun Capacitor
          Assembly Line that was already standing at waiting_for_materials — both invisible
          while agents worked on them. This section cannot go stale: it is the live answer. */}
      {!!data.under_construction?.length && (
        <div className="flex flex-col gap-2">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground px-1">
            Under construction — live from the station
          </div>
          {data.under_construction.map(b => {
            const gaps = (b.materials ?? []).filter(m => (m.quantity_missing ?? 0) > 0)
            return (
              <div key={b.definition_id} className="border border-border/60 px-3 py-2 text-[11.5px]">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{b.name}</span>
                  <span className="font-mono text-[10.5px]" style={{ color: gaps.length ? 'var(--smui-orange)' : 'var(--smui-green)' }}>
                    {gaps.length ? `${gaps.length} line${gaps.length > 1 ? 's' : ''} short` : 'materials met'}
                  </span>
                </div>
                <div className="text-[10.5px] text-muted-foreground">
                  {b.status}{b.build_cost ? ` · ${b.build_cost.toLocaleString()} cr` : ''}
                </div>
                {gaps.map(m => (
                  <div key={m.item_id} className="font-mono text-[10.5px] tabular-nums">
                    {m.name ?? m.item_id}: {(m.quantity_in_storage ?? 0).toLocaleString()} / {m.quantity_required.toLocaleString()}
                    <span style={{ color: 'var(--smui-orange)' }}> — short {(m.quantity_missing ?? 0).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}

      {/* Rent before you build. On 2026-09-17 an afternoon went into assembling 102,000 cr and
          ~4,100 units of material for a facility the station already ran 14 idle public copies of
          at 32 cr a run. */}
      {!!data.rentable?.length && (
        <details className="border border-border/60 px-3 py-2">
          <summary className="text-[11px] uppercase tracking-wide text-muted-foreground cursor-pointer">
            Rentable here — {data.rentable.length} recipes, no build required
          </summary>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 text-[10.5px] font-mono tabular-nums">
            {[...data.rentable].sort((a, b) => a.fee_per_run - b.fee_per_run).map(r => (
              <div key={r.recipe_id} className="flex justify-between gap-2">
                <span className="truncate">{r.recipe_id}{r.copies > 1 ? ` x${r.copies}` : ''}</span>
                <span style={{ color: r.backlog_ticks ? 'var(--smui-orange)' : 'var(--smui-green)' }}>
                  {r.fee_per_run}/run
                </span>
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="flex flex-col gap-2">
        {data.queue.map(q => {
          if (q.missing_from_catalog) {
            return (
              <div key={q.id} className="border border-border/60 px-3 py-2 text-[11.5px] text-muted-foreground">
                {q.order}. <span className="font-mono">{q.id}</span> — not in the catalog
              </div>
            )
          }
          if (q.built) {
            return (
              <div key={q.id} className="border px-3 py-2 flex items-baseline gap-2 flex-wrap"
                style={{ borderColor: 'hsl(var(--smui-green) / 0.35)' }}>
                <span className="text-[10px] text-muted-foreground tabular-nums">{q.order}.</span>
                <span className="text-[13px] font-semibold" style={{ color: 'hsl(var(--smui-green))' }}>{q.name}</span>
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5"
                  style={{ color: 'hsl(var(--smui-green))', border: '1px solid hsl(var(--smui-green) / 0.5)' }}>built</span>
                <span className="text-[10.5px] text-muted-foreground">
                  already standing — its bill is spent and reserves nothing from the entries below
                </span>
              </div>
            )
          }
          const tone = q.buildable ? 'var(--smui-green)' : q.pct > 0.8 ? 'var(--smui-yellow)' : 'var(--smui-orange)'
          return (
            <div key={q.id} className="border px-3 py-2.5"
              style={{ borderColor: q.buildable ? 'hsl(var(--smui-green) / 0.6)' : 'hsl(var(--border))' }}>
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-[10px] text-muted-foreground tabular-nums">{q.order}.</span>
                <span className="text-[13px] font-semibold">{q.name}</span>
                <span className="text-[11px] tabular-nums font-semibold" style={{ color: `hsl(${tone})` }}>
                  {(q.pct * 100).toFixed(1)}%
                </span>
                {q.buildable
                  ? <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5"
                      style={{ color: 'hsl(var(--smui-green))', border: '1px solid hsl(var(--smui-green) / 0.5)' }}>buildable now</span>
                  : <span className="text-[10.5px] text-muted-foreground">
                      blocked on <span className="font-mono" style={{ color: `hsl(${tone})` }}>{q.binding}</span>
                      {q.short_count > 1 ? ` (+${q.short_count - 1} more short)` : ''}
                    </span>}
                <span className="ml-auto text-[10.5px] text-muted-foreground tabular-nums">
                  {q.build_cost.toLocaleString()} cr
                  {!q.credits_ok && <span style={{ color: 'hsl(var(--smui-orange))' }}> · treasury short</span>}
                </span>
              </div>

              {/* One bar per material: filled to its own ratio, so the binding line is visible at a glance. */}
              <div className="mt-2 flex flex-col gap-1">
                {q.materials.map(m => (
                  <div key={m.item_id} className="flex items-center gap-2 text-[11px]">
                    <span className="font-mono w-[172px] shrink-0 truncate" title={m.item_id}>{m.item_id}</span>
                    <span className="relative h-[9px] flex-1 min-w-[60px] bg-border/40 overflow-hidden">
                      <span className="absolute inset-y-0 left-0"
                        style={{
                          width: `${Math.max(m.pct * 100, m.pct > 0 ? 1.5 : 0)}%`,
                          background: m.short === 0 ? 'hsl(var(--smui-green) / 0.75)' : 'hsl(var(--smui-orange) / 0.75)',
                        }} />
                    </span>
                    <span className="tabular-nums text-muted-foreground w-[124px] shrink-0 text-right">
                      {m.available.toLocaleString()} / {m.needed.toLocaleString()}
                    </span>
                    <span className="tabular-nums w-[92px] shrink-0 text-right"
                      style={{ color: m.short === 0 ? 'hsl(var(--smui-green))' : 'hsl(var(--smui-orange))' }}>
                      {m.short === 0 ? 'met' : `short ${m.short.toLocaleString()}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {(data.built?.length ?? 0) > 0 && (
        <div className="mt-2">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-baseline gap-2">
            <span>Standing — what the faction already owns</span>
            <span className="text-muted-foreground/50 normal-case tracking-normal">
              {data.built!.filter(b => !b.under_construction).length} active
              {data.built!.some(b => b.under_construction) ? ', 1 building' : ''}
              {' · '}
              {data.built!.reduce((n, b) => n + b.rent_per_cycle, 0).toLocaleString()} cr/cycle
              {' · '}
              {(data.built!.reduce((n, b) => n + b.rent_per_cycle, 0) * 86).toLocaleString()} cr/day
            </span>
          </div>
          <div className="border border-border/60">
            {data.built!.map(b => (
              <div key={b.facility_id || `${b.station_id}-${b.type}`}
                className="flex items-baseline gap-2 flex-wrap px-3 py-1.5 border-b border-border/30 last:border-b-0 text-[11.5px]">
                <span className="font-semibold" style={{ color: b.under_construction ? 'hsl(var(--smui-yellow))' : undefined }}>
                  {b.name}
                </span>
                {b.under_construction && (
                  <span className="text-[9px] uppercase tracking-wider px-1.5"
                    style={{ color: 'hsl(var(--smui-yellow))', border: '1px solid hsl(var(--smui-yellow) / 0.5)' }}>
                    building
                  </span>
                )}
                {/* Location is the point: faction storage and builds are per-station,
                    so "we own one" is meaningless without knowing where it stands. */}
                <span className="text-muted-foreground">
                  {b.station_name}
                  {b.system_id ? <span className="text-muted-foreground/50"> · {b.system_id}</span> : null}
                </span>
                <span className="ml-auto tabular-nums text-muted-foreground/80">
                  {b.rent_per_cycle.toLocaleString()} cr/cycle
                  <span className="text-muted-foreground/40"> · {(b.rent_per_cycle * 86).toLocaleString()}/day</span>
                </span>
                <span className="tabular-nums text-muted-foreground/50 w-[86px] text-right"
                  title={b.first_seen ? 'Earliest record WE have of it, not the game’s build date' : 'No prior record — newly observed'}>
                  {b.first_seen ? b.first_seen.slice(0, 10) : 'new'}
                </span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground/60 mt-1">
            Read live from <span className="font-mono">facility action=faction_owned</span>, not the intel cache —
            that cache held 2 facilities at 338 cr/cycle when the game returned 4 at 708. Dates are our earliest
            record, not the game's build date; the game does not report one.
          </p>
        </div>
      )}
    </div>
  )
}

function FacilityRent() {
  const [d, setD] = useState<RentPayload | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/faction/rent')
        const j = await r.json()
        if (j.error) setErr(String(j.error)); else setD(j)
      } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    })()
  }, [])

  if (err) return <div className="dossier-card p-3 text-[11.5px]" style={{ color: 'hsl(var(--smui-red))' }}>Rent unavailable: {err}</div>
  if (!d) return <div className="dossier-card p-3 text-[11.5px] text-muted-foreground">Reading facility rents…</div>

  const byStation = new Map<string, RentRow[]>()
  for (const f of d.facilities) {
    const k = f.station_id || '(unknown station)'
    byStation.set(k, [...(byStation.get(k) ?? []), f])
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Facilities billed" value={String(d.facilities.length)} />
        <Stat label="Rent per cycle" value={d.totals.per_cycle.toLocaleString()} accent="var(--smui-yellow)" />
        <Stat label="Rent per day" value={d.totals.per_day.toLocaleString()} accent="var(--smui-red)" />
        <Stat label="Cycle length" value={`~${d.cycle_minutes} min`} />
      </div>

      <div className="dossier-card p-3 text-[11.5px] leading-relaxed text-foreground/85">
        Rent bills <b>every ~{d.cycle_minutes} minutes</b> ({d.cycles_per_day} cycles a day) from the
        faction treasury, wherever the owner happens to be — being docked or present changes nothing.
        Unpaid cycles accrue as arrears and the facility is repossessed once the station&apos;s grace
        period lapses, so an idle facility still has to be funded. Selling it is the only way to stop the bill.
      </div>

      {[...byStation.entries()].map(([station, rows]) => {
        const cyc = rows.reduce((s, r) => s + r.rent_per_cycle, 0)
        return (
          <div key={station} className="dossier-card">
            <div className="flex items-baseline gap-2 px-3 py-2 border-b border-border/60">
              <span className="text-[12px] font-bold" style={DISPLAY}>{label(station)}</span>
              <span className="ml-auto text-[11.5px] tabular-nums text-muted-foreground">
                {cyc.toLocaleString()}/cycle · <b style={{ color: 'hsl(var(--smui-red))' }}>
                  {(cyc * d.cycles_per_day).toLocaleString()}/day</b>
              </span>
            </div>
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-1.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground border-b border-border/30">
              <span>Facility</span><span className="text-right">Per cycle</span>
              <span className="text-right">Per day</span><span className="text-right pr-1">Built for</span>
            </div>
            {rows.map(f => (
              <div key={f.facility_type} className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-1.5 border-t border-border/20 items-baseline">
                <span className="text-[12px] truncate">
                  {(f.facility_name || f.facility_type).replace(/_/g, ' ')}
                  {f.level != null && <span className="text-[10px] text-muted-foreground ml-1.5">L{f.level}</span>}
                  {!!f.faction_owned && <span className="text-[9.5px] uppercase tracking-wider ml-1.5" style={{ color: 'hsl(var(--smui-yellow))' }}>faction</span>}
                </span>
                <span className="text-[12px] tabular-nums text-right">{f.rent_per_cycle.toLocaleString()}</span>
                <span className="text-[12px] tabular-nums text-right" style={{ color: 'hsl(var(--smui-red))' }}>{f.per_day.toLocaleString()}</span>
                <span className="text-[11px] tabular-nums text-right pr-1 text-muted-foreground">
                  {f.build_cost ? f.build_cost.toLocaleString() : '—'}
                </span>
              </div>
            ))}
          </div>
        )
      })}

      <div className="text-[11px] text-muted-foreground leading-relaxed">{d.note}</div>
    </div>
  )
}

interface ShipLine {
  item_id: string; name: string; needed: number
  cargo: number; locker: number; commission_ready: number
  vault: number; elsewhere: number; short: number
  other_vaults: number
  pct: number; status: 'ready' | 'withdraw' | 'withdraw_partial' | 'other_vault' | 'fetch' | 'short'
}
interface ShipPayload {
  ship: string; ship_name: string; station: string; pilot: string
  bare_hull: boolean; shipyard_tier_required: number | null; build_time: number | null
  treasury: number; lines: ShipLine[]; pct: number; binding: string | null
  ready_count: number; withdraw_count: number; total: number
}

/**
 * The ship commission bill. Deliberately NOT shaped like the facility queue,
 * because the two consumers read opposite places: a facility build reads the
 * FACTION VAULT and never a personal locker, while `supply_commission` reads the
 * pilot's CARGO then their PERSONAL locker and never the vault.
 *
 * So the vault column here is a WARNING, not stock. Parts sitting in the vault
 * are in the right station and the wrong pocket — the yard cannot see them, and
 * a page that added them into "have" would show the ship ready to order while
 * the shipyard reported nothing. That is why `commission_ready` is only
 * cargo + locker, and vault surfaces as a "withdraw" action.
 */
function ShipBuild() {
  const [d, setD] = useState<ShipPayload | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await fetch('/api/faction/ship-build')
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = await r.json()
        if (alive) { setD(j); setErr(null) }
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : String(e)) }
    }
    void load()
    const t = setInterval(load, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  if (err) return <div className="text-[12px] text-muted-foreground px-1 py-4">Ship build unavailable: {err}</div>
  if (!d) return <div className="text-[12px] text-muted-foreground px-1 py-4">Loading ship bill…</div>

  const TONE: Record<ShipLine['status'], string> = {
    ready: 'var(--smui-green)', withdraw: 'var(--smui-yellow)', withdraw_partial: 'var(--smui-yellow)',
    other_vault: 'var(--smui-yellow)', fetch: 'var(--smui-orange)', short: 'var(--smui-red)',
  }
  const VERB: Record<ShipLine['status'], string> = {
    ready: 'ready', withdraw: 'in vault — withdraw', withdraw_partial: 'withdraw vault, then top up',
    other_vault: 'OUR stock, another vault — retrieve', fetch: 'elsewhere — haul it in', short: 'buy, craft or mine',
  }
  const rows = [...d.lines].sort((a, b) => a.pct - b.pct)

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Lines ready" value={`${d.ready_count}/${d.total}`}
          accent={d.ready_count === d.total ? 'var(--smui-green)' : undefined} />
        <Stat label="Binding line" value={d.binding ? d.binding.replace(/_/g, ' ') : '—'}
          accent={d.binding ? 'var(--smui-orange)' : 'var(--smui-green)'} />
        <Stat label="In vault, not visible" value={String(d.withdraw_count)}
          accent={d.withdraw_count ? 'var(--smui-yellow)' : undefined} />
        <Stat label="Treasury" value={`${d.treasury.toLocaleString()} cr`} accent="var(--smui-yellow)" />
      </div>

      <div className="flex items-baseline gap-2 flex-wrap px-1">
        <span className="text-[13px] font-semibold" style={DISPLAY}>{d.ship_name}</span>
        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5"
          style={{ color: 'hsl(var(--smui-green))', border: '1px solid hsl(var(--smui-green) / 0.5)' }}>bare hull</span>
        <span className="text-[10.5px] text-muted-foreground">
          pilot <span className="font-mono">{d.pilot}</span> at <span className="font-mono">{d.station}</span>
          {d.build_time ? ` · ${d.build_time.toLocaleString()} ticks` : ''}
        </span>
      </div>

      <p className="text-[10.5px] text-muted-foreground/70 px-1">
        The faction holds stock at <strong>seven stations</strong> and every one is withdrawable, but only
        crimson_war_citadel accepts deposits — so anything shown under "other faction vaults" is ours already
        and one retrieval run away, not something to buy.
      </p>
      <p className="text-[10.5px] text-muted-foreground/70 px-1">
        A commission takes materials from the pilot's <strong>cargo first, then their personal station
        storage</strong> — it never reads faction storage (that applies only at a station the faction owns,
        and we own none). So the vault column below is <strong>not stock</strong>: those parts are in the right
        station and the wrong pocket, and must be withdrawn before the yard can see them. This is the exact
        opposite of the facility Build queue tab, which reads the vault and never a locker.
      </p>
      <p className="text-[10.5px] text-muted-foreground/70 px-1">
        This is the <strong>bare hull</strong> — the catalog's own bill. A commission quote with no arguments
        prices the <em>default loadout</em> instead and adds fitted modules (fury cannon, mass driver,
        piercing railgun), three of which have no seller anywhere and would each need a seven-figure
        facility. Those are not part of the ship; fit them afterwards.
      </p>

      <div className="flex flex-col gap-1">
        {rows.map(l => (
          <div key={l.item_id} className="border px-3 py-2"
            style={{ borderColor: l.status === 'ready' ? 'hsl(var(--smui-green) / 0.35)' : 'hsl(var(--border))' }}>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-[12.5px] font-semibold font-mono">{l.name}</span>
              <span className="text-[11px] tabular-nums font-semibold" style={{ color: `hsl(${TONE[l.status]})` }}>
                {l.commission_ready.toLocaleString()} / {l.needed.toLocaleString()}
              </span>
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5"
                style={{ color: `hsl(${TONE[l.status]})`, border: `1px solid hsl(${TONE[l.status]} / 0.5)` }}>
                {VERB[l.status]}
              </span>
              <span className="ml-auto text-[10.5px] text-muted-foreground tabular-nums">
                {l.cargo > 0 && <span>cargo {l.cargo.toLocaleString()} · </span>}
                {l.locker > 0 && <span>locker {l.locker.toLocaleString()} · </span>}
                {l.vault > 0 && (
                  <span style={{ color: 'hsl(var(--smui-yellow))' }}>vault {l.vault.toLocaleString()} (not visible) · </span>
                )}
                {l.other_vaults > 0 && (
                  <span style={{ color: 'hsl(var(--smui-yellow))' }}>other faction vaults {l.other_vaults.toLocaleString()} · </span>
                )}
                {l.elsewhere > 0 && <span>elsewhere {l.elsewhere.toLocaleString()} · </span>}
                {l.short > 0 ? <span style={{ color: `hsl(${TONE[l.status]})` }}>short {l.short.toLocaleString()}</span> : <span>complete</span>}
              </span>
            </div>
            <div className="mt-1.5 h-[3px] w-full bg-border/40">
              <div className="h-full" style={{ width: `${Math.round(l.pct * 100)}%`, background: `hsl(${TONE[l.status]})` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
