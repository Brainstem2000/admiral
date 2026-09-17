import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'

/**
 * Fleet lookups: find any item across every holder, list the sealed packages, and
 * describe a place or grade a route. These live on the Intel page rather than the
 * Vault page because they answer questions about the whole galaxy and the whole
 * fleet — ship holds, every personal locker, all seven faction vaults, and the
 * corridors between them — not about the faction vault specifically.
 */

const DISPLAY = { fontFamily: "'Chakra Petch', system-ui, sans-serif" } as const

function Stat({ label: l, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="border border-border/60 px-3 py-2">
      <div className="text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">{l}</div>
      <div className="text-[15px] font-semibold tabular-nums" style={{ ...DISPLAY, color: accent ? `hsl(${accent})` : undefined }}>{value}</div>
    </div>
  )
}

interface WhereLoc {
  holder_kind: 'cargo' | 'locker' | 'vault'
  holder: string; station_id: string; quantity: number
  updated_at: string; stale: boolean
  reachable_by: { facility_build: string; ship_commission: string }
}
interface WherePayload {
  item_id: string; total: number; in_cargo: number; in_lockers: number; in_vaults: number
  stale_rows: number; stations: Array<{ station_id: string; quantity: number }>
  locations: WhereLoc[]
}
interface EveryRow {
  item_id: string; item_name: string; total: number
  in_cargo: number; in_lockers: number; in_vaults: number; locations: number
}

/**
 * Find anything — one search across ship holds, every personal locker, and all
 * faction vaults.
 *
 * It exists because the fleet-wide lookups read only two of the three holders:
 * personal lockers and cargo, never faction storage. That blind spot hid seven
 * faction vaults from this dashboard and from the Admiral at once — weapon_core
 * 228 sat in grand_exchange_station while the ship bill called the line
 * unsourceable, and 3,346 steel_plate across four vaults read as missing.
 *
 * A total is deliberately NOT presented as "what we can use": the three holders
 * feed different consumers, so each row states what can actually reach it.
 */
export function FindAnything() {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<EveryRow[] | null>(null)
  const [sel, setSel] = useState<WherePayload | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/inventory/everything?q=${encodeURIComponent(q)}&limit=60`)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = await r.json()
        if (alive) { setRows(j.items ?? []); setErr(null) }
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : String(e)) }
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [q])

  const open = async (itemId: string) => {
    try {
      const r = await fetch(`/api/inventory/where/${encodeURIComponent(itemId)}`)
      setSel(await r.json())
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  const KIND: Record<WhereLoc['holder_kind'], { label: string; tone: string }> = {
    vault:  { label: 'faction vault', tone: 'var(--smui-green)' },
    locker: { label: 'personal locker', tone: 'var(--smui-yellow)' },
    cargo:  { label: 'ship hold', tone: 'var(--smui-orange)' },
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Search size={13} className="text-muted-foreground" />
        <input
          value={q} onChange={e => { setQ(e.target.value); setSel(null) }}
          placeholder="search everything we own — steel, weapon_core, silicon…"
          className="flex-1 bg-transparent border border-border/60 px-2 py-1 text-[12px] font-mono outline-none focus:border-foreground/40"
        />
      </div>

      <p className="text-[10.5px] text-muted-foreground/70 px-1">
        Searches <strong>ship holds, every personal locker, and all faction vaults</strong> together. A total
        is not what any one consumer can reach: a facility build never reads a personal locker, and a ship
        commission never reads faction storage. Click an item to see who can actually get at it.
      </p>

      {err && <div className="text-[11.5px]" style={{ color: 'hsl(var(--smui-orange))' }}>Lookup failed: {err}</div>}

      {sel && (
        <div className="border px-3 py-2.5" style={{ borderColor: 'hsl(var(--smui-green) / 0.4)' }}>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[13px] font-semibold font-mono">{sel.item_id}</span>
            <span className="text-[12px] tabular-nums font-semibold">{sel.total.toLocaleString()} total</span>
            <span className="text-[10.5px] text-muted-foreground">
              vaults {sel.in_vaults.toLocaleString()} · lockers {sel.in_lockers.toLocaleString()} · cargo {sel.in_cargo.toLocaleString()}
            </span>
            {sel.stale_rows > 0 && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5"
                style={{ color: 'hsl(var(--smui-orange))', border: '1px solid hsl(var(--smui-orange) / 0.5)' }}>
                {sel.stale_rows} row{sel.stale_rows > 1 ? 's' : ''} over a day old
              </span>
            )}
            <button onClick={() => setSel(null)} className="ml-auto text-[10.5px] text-muted-foreground hover:text-foreground">close</button>
          </div>
          <div className="mt-2 flex flex-col gap-1">
            {sel.locations.map((l, i) => (
              <div key={i} className="flex items-baseline gap-2 text-[11px] flex-wrap">
                <span className="text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 shrink-0"
                  style={{ color: `hsl(${KIND[l.holder_kind].tone})`, border: `1px solid hsl(${KIND[l.holder_kind].tone} / 0.45)` }}>
                  {KIND[l.holder_kind].label}
                </span>
                <span className="font-mono">{l.holder}</span>
                <span className="text-muted-foreground font-mono">{l.station_id}</span>
                <span className="tabular-nums font-semibold">{l.quantity.toLocaleString()}</span>
                {l.stale && <span style={{ color: 'hsl(var(--smui-orange))' }} className="text-[10px]">stale</span>}
                <span className="ml-auto text-[10px] text-muted-foreground">
                  build: {l.reachable_by.facility_build} · ship: {l.reachable_by.ship_commission}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline gap-2 text-[10px] uppercase tracking-wider text-muted-foreground px-2 pb-1">
          <span className="flex-1">item</span>
          <span className="w-20 text-right">total</span>
          <span className="w-20 text-right">vaults</span>
          <span className="w-20 text-right">lockers</span>
          <span className="w-16 text-right">cargo</span>
          <span className="w-14 text-right">places</span>
        </div>
        {(rows ?? []).map(r => (
          <button key={r.item_id} onClick={() => open(r.item_id)}
            className="flex items-baseline gap-2 text-[11.5px] px-2 py-1 hover:bg-foreground/5 text-left border-b border-border/20">
            <span className="flex-1 font-mono">{r.item_id}</span>
            <span className="w-20 text-right tabular-nums font-semibold">{r.total.toLocaleString()}</span>
            <span className="w-20 text-right tabular-nums" style={{ color: 'hsl(var(--smui-green))' }}>{r.in_vaults.toLocaleString()}</span>
            <span className="w-20 text-right tabular-nums" style={{ color: 'hsl(var(--smui-yellow))' }}>{r.in_lockers.toLocaleString()}</span>
            <span className="w-16 text-right tabular-nums text-muted-foreground">{r.in_cargo.toLocaleString()}</span>
            <span className="w-14 text-right tabular-nums text-muted-foreground">{r.locations}</span>
          </button>
        ))}
        {rows && !rows.length && <div className="text-[11.5px] text-muted-foreground px-2 py-3">Nothing matches “{q}”.</div>}
      </div>
    </div>
  )
}

const RISK_TONE: Record<string, string> = {
  safe: 'var(--smui-green)', policed: 'var(--smui-yellow)',
  thin: 'var(--smui-orange)', lawless: 'var(--smui-orange)', KILLZONE: 'var(--smui-red)',
}

/**
 * Sealed packages, where they are, and how safe the station is.
 *
 * They were always in the data as `package:<hash>` inventory rows, but nothing
 * listed them AS packages, so the only record of what we held lived in a memory
 * note that went stale (it said 37; there are 28). A package occupies 100 cargo
 * whatever is inside, so the count per station is what plans a run — not a total.
 */
export function Packages() {
  const [d, setD] = useState<{ total_packages: number; stations: Array<{ station_id: string; packages: number; holders: string[]; risk: { risk: string; police_level: number | null } | null }> } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/inventory/packages')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(j => { if (alive) { setD(j); setErr(null) } })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [])

  if (err) return <div className="text-[12px] text-muted-foreground px-1 py-4">Packages unavailable: {err}</div>
  if (!d) return <div className="text-[12px] text-muted-foreground px-1 py-4">Loading packages…</div>

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat label="Sealed packages" value={String(d.total_packages)} accent="var(--smui-yellow)" />
        <Stat label="Stations holding them" value={String(d.stations.length)} />
        <Stat label="At lawless stations" value={String(d.stations.filter(s => s.risk?.risk === 'lawless' || s.risk?.risk === 'KILLZONE').length)}
          accent={d.stations.some(s => s.risk?.risk === 'lawless') ? 'var(--smui-orange)' : 'var(--smui-green)'} />
      </div>
      <p className="text-[10.5px] text-muted-foreground/70 px-1">
        A sealed package occupies <strong>100 cargo whatever is inside</strong>, so they are opened on site
        rather than hauled sealed. Contents are not recorded until something opens one.
      </p>
      <div className="flex flex-col gap-1">
        {d.stations.map(s => (
          <div key={s.station_id} className="border border-border/60 px-3 py-2 flex items-baseline gap-2 flex-wrap">
            <span className="text-[12.5px] font-mono font-semibold">{s.station_id}</span>
            <span className="text-[11px] tabular-nums font-semibold" style={{ color: 'hsl(var(--smui-yellow))' }}>
              {s.packages} package{s.packages > 1 ? 's' : ''}
            </span>
            {s.risk && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5"
                style={{ color: `hsl(${RISK_TONE[s.risk.risk] ?? 'var(--smui-orange)'})`, border: `1px solid hsl(${RISK_TONE[s.risk.risk] ?? 'var(--smui-orange)'} / 0.5)` }}>
                {s.risk.risk} · police {s.risk.police_level ?? '?'}
              </span>
            )}
            <span className="ml-auto text-[10.5px] text-muted-foreground">{s.holders.join(', ')}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Places and routes. The game's find_route returns a path and says nothing about
 * its safety, and grading a corridor by its DESTINATION is how 228 weapon_core
 * were sent down a 13-hop zero-police run. Every hop is graded here, and the
 * worst intermediate one is called out, because a corridor is exactly as safe as
 * its most dangerous jump.
 */
export function Places() {
  const [from, setFrom] = useState('krynn')
  const [to, setTo] = useState('')
  const [route, setRoute] = useState<any>(null)
  const [place, setPlace] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)

  const go = async () => {
    setErr(null)
    try {
      if (to.trim()) {
        const r = await fetch(`/api/galaxy/route?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
        setRoute(await r.json()); setPlace(null)
      } else {
        const r = await fetch(`/api/galaxy/place/${encodeURIComponent(from)}`)
        setPlace(await r.json()); setRoute(null)
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <input value={from} onChange={e => setFrom(e.target.value)} placeholder="system or station"
          className="bg-transparent border border-border/60 px-2 py-1 text-[12px] font-mono outline-none focus:border-foreground/40 w-56" />
        <span className="text-[11px] text-muted-foreground">→</span>
        <input value={to} onChange={e => setTo(e.target.value)} placeholder="destination (blank = describe the place)"
          onKeyDown={e => { if (e.key === 'Enter') void go() }}
          className="flex-1 min-w-[16rem] bg-transparent border border-border/60 px-2 py-1 text-[12px] font-mono outline-none focus:border-foreground/40" />
        <button onClick={() => void go()} className="text-[11px] px-3 py-1 border border-border/60 hover:border-foreground/40">look up</button>
      </div>
      <p className="text-[10.5px] text-muted-foreground/70 px-1">
        Leave the destination blank to see what is at a place. With a destination you get the path
        <strong> with every hop graded</strong> — a run is only as safe as its worst jump, not its endpoint.
      </p>
      {err && <div className="text-[11.5px]" style={{ color: 'hsl(var(--smui-orange))' }}>{err}</div>}

      {route && (
        <div className="border px-3 py-2.5" style={{ borderColor: route.crosses_killzone ? 'hsl(var(--smui-red) / 0.6)' : 'hsl(var(--border))' }}>
          {!route.found ? <div className="text-[12px] text-muted-foreground">No known route — the map graph may not reach it.</div> : <>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-[13px] font-semibold">{route.jumps} jumps</span>
              <span className="text-[11px]" style={{ color: route.lawless_hops ? 'hsl(var(--smui-orange))' : 'hsl(var(--smui-green))' }}>
                {route.lawless_hops} lawless hop{route.lawless_hops === 1 ? '' : 's'}
              </span>
              {route.crosses_killzone && <span className="text-[11px] font-semibold" style={{ color: 'hsl(var(--smui-red))' }}>CROSSES A HARD-BANNED KILLZONE</span>}
              {route.worst && <span className="text-[10.5px] text-muted-foreground">worst hop <span className="font-mono">{route.worst.system_id}</span> (police {route.worst.police_level ?? '?'})</span>}
            </div>
            <div className="mt-2 flex flex-col gap-0.5">
              {route.hops.map((h: any, i: number) => (
                <div key={i} className="flex items-baseline gap-2 text-[11px]">
                  <span className="w-6 text-right text-muted-foreground tabular-nums">{i}</span>
                  <span className="font-mono w-52">{h.system_id}</span>
                  <span className="w-24" style={{ color: `hsl(${RISK_TONE[h.risk] ?? 'var(--smui-orange)'})` }}>{h.risk}</span>
                  <span className="text-muted-foreground tabular-nums">police {h.police_level ?? '?'}</span>
                  {h.grade && <span className="text-muted-foreground text-[10px]">{h.grade}</span>}
                </div>
              ))}
            </div>
          </>}
        </div>
      )}

      {place && (
        <div className="border border-border/60 px-3 py-2.5">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[13px] font-semibold font-mono">{place.id}</span>
            <span className="text-[10.5px] text-muted-foreground">{place.kind}{place.system_id ? ` in ${place.system_id}` : ''}</span>
            {place.risk && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5"
                style={{ color: `hsl(${RISK_TONE[place.risk.risk] ?? 'var(--smui-orange)'})`, border: `1px solid hsl(${RISK_TONE[place.risk.risk] ?? 'var(--smui-orange)'} / 0.5)` }}>
                {place.risk.risk} · police {place.risk.police_level ?? '?'}
              </span>
            )}
            {place.agents_here?.length > 0 && <span className="ml-auto text-[10.5px] text-muted-foreground">here now: {place.agents_here.join(', ')}</span>}
          </div>
          {place.deposits?.length > 0 && <>
            <div className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground">deposits</div>
            {place.deposits.slice(0, 8).map((d: any, i: number) => (
              <div key={i} className="flex items-baseline gap-2 text-[11px]">
                <span className="font-mono w-44">{d.item_id}</span>
                <span className="text-muted-foreground flex-1">{d.poi_name}</span>
                <span className="tabular-nums">rich {d.richness}</span>
                <span className="tabular-nums text-muted-foreground">remaining {d.remaining?.toLocaleString?.() ?? d.remaining}</span>
                <span className="tabular-nums text-muted-foreground">supports array {d.supported_power ?? '?'}</span>
              </div>
            ))}
          </>}
          {place.holdings?.length > 0 && <>
            <div className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground">what we hold here</div>
            {place.holdings.slice(0, 12).map((h: any, i: number) => (
              <div key={i} className="flex items-baseline gap-2 text-[11px]">
                <span className="w-20" style={{ color: h.holder_kind === 'vault' ? 'hsl(var(--smui-green))' : 'hsl(var(--smui-yellow))' }}>{h.holder_kind}</span>
                <span className="w-44 font-mono">{h.holder}</span>
                <span className="flex-1 font-mono">{h.item_id}</span>
                <span className="tabular-nums font-semibold">{h.quantity.toLocaleString()}</span>
              </div>
            ))}
          </>}
          {place.neighbours?.length > 0 && (
            <div className="mt-2 text-[10.5px] text-muted-foreground">
              neighbours: {place.neighbours.map((n: any) => `${n.system_id} [${n.risk}]`).join(' · ')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
