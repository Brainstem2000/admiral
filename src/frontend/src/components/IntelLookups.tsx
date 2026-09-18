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
  // A partial name is the NORMAL way to type a place. "iron" matches five systems; the
  // lookup used to answer found:false and show nothing, which reads as "no route exists".
  const [choices, setChoices] = useState<{ field: 'from' | 'to'; ids: string[] } | null>(null)
  const [showDetour, setShowDetour] = useState(false)

  const go = async (overrideFrom?: string, overrideTo?: string) => {
    setErr(null); setChoices(null)
    const f = overrideFrom ?? from, t = overrideTo ?? to
    try {
      if (t.trim()) {
        const r = await fetch(`/api/galaxy/route?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`)
        const j = await r.json()
        if (j.candidates?.length) { setChoices({ field: j.ambiguous === 'from' ? 'from' : 'to', ids: j.candidates }); setRoute(null); setPlace(null); return }
        setRoute(j); setPlace(null)
      } else {
        const r = await fetch(`/api/galaxy/place/${encodeURIComponent(f)}`)
        const j = await r.json()
        if (j.candidates?.length) { setChoices({ field: 'from', ids: j.candidates }); setPlace(null); setRoute(null); return }
        setPlace(j); setRoute(null)
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  const pick = (id: string) => {
    if (choices?.field === 'from') { setFrom(id); void go(id, undefined) }
    else { setTo(id); void go(undefined, id) }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <input value={from} onChange={e => setFrom(e.target.value)} placeholder="system or station"
          onKeyDown={e => { if (e.key === 'Enter') void go() }}
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

      {choices && (
        <div className="border px-3 py-2.5" style={{ borderColor: 'hsl(var(--smui-yellow) / 0.5)' }}>
          <div className="text-[11.5px] mb-1.5">
            <span style={{ color: 'hsl(var(--smui-yellow))' }}>Several places match that.</span>
            <span className="text-muted-foreground"> Which did you mean?</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {choices.ids.map(id => (
              <button key={id} onClick={() => pick(id)}
                className="text-[11px] font-mono px-2 py-0.5 border border-border/60 hover:border-foreground/40">
                {id}
              </button>
            ))}
          </div>
        </div>
      )}

      {route && (
        <div className="border px-3 py-2.5" style={{ borderColor: route.crosses_killzone ? 'hsl(var(--smui-red) / 0.6)' : 'hsl(var(--border))' }}>
          {!route.found ? <div className="text-[12px] text-muted-foreground">No known route — the map graph may not reach it.</div> : <>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-[17px] font-semibold tabular-nums">{route.jumps} jumps</span>
              {route.note && (
                <span className="text-[12px] text-muted-foreground">({route.note})</span>
              )}
              <span className="text-[13px]" style={{ color: route.lawless_hops ? 'hsl(var(--smui-orange))' : 'hsl(var(--smui-green))' }}>
                {route.lawless_hops} lawless hop{route.lawless_hops === 1 ? '' : 's'}
              </span>
              {route.crosses_killzone && <span className="text-[13px] font-semibold" style={{ color: 'hsl(var(--smui-red))' }}>CROSSES A HARD-BANNED KILLZONE</span>}
              {route.worst && <span className="text-[12px] text-muted-foreground">worst hop <span className="font-mono">{route.worst.system_id}</span> (police {route.worst.police_level ?? '?'})</span>}
            </div>
            {/* The safe alternative was being COMPUTED and never shown. A red
                "CROSSES A HARD-BANNED KILLZONE" with no way around it reads as
                "this trip is the only option and it is dangerous" — when for
                krynn -> gold_run the detour costs exactly the same 24 jumps.
                Warning someone into a dead end is worse than not warning them. */}
            {route.crosses_killzone && route.detour?.found && (
              <div className="mt-2 border px-2.5 py-2" style={{ borderColor: 'hsl(var(--smui-green) / 0.5)' }}>
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-[13.5px] font-semibold" style={{ color: 'hsl(var(--smui-green))' }}>
                    KILLZONE-FREE DETOUR EXISTS
                  </span>
                  <span className="text-[13px] tabular-nums font-semibold">{route.detour.jumps} jumps</span>
                  <span className="text-[12px] text-muted-foreground">
                    {route.detour.jumps === route.jumps
                      ? 'same length as the dangerous path — take it'
                      : route.detour.jumps > route.jumps
                        ? `${route.detour.jumps - route.jumps} jump${route.detour.jumps - route.jumps === 1 ? '' : 's'} longer`
                        : `${route.jumps - route.detour.jumps} jump${route.jumps - route.detour.jumps === 1 ? '' : 's'} shorter`}
                  </span>
                  <span className="text-[12px]" style={{ color: route.detour.lawless_hops ? 'hsl(var(--smui-orange))' : 'hsl(var(--smui-green))' }}>
                    {route.detour.lawless_hops} lawless hop{route.detour.lawless_hops === 1 ? '' : 's'}
                  </span>
                  <button onClick={() => setShowDetour(v => !v)}
                    className="ml-auto text-[12px] text-muted-foreground hover:text-foreground underline">
                    {showDetour ? 'hide hops' : 'show hops'}
                  </button>
                </div>
                {showDetour && (
                  <div className="mt-1.5 flex flex-col gap-1">
                    {route.detour.hops.map((h: any, i: number) => (
                      <div key={i} className="flex items-baseline gap-3 text-[13px]">
                        <span className="w-7 text-right text-muted-foreground tabular-nums">{i}</span>
                        <span className="font-mono w-60">{h.system_id}</span>
                        <span className="w-28" style={{ color: `hsl(${RISK_TONE[h.risk] ?? 'var(--smui-orange)'})` }}>{h.risk}</span>
                        <span className="text-muted-foreground tabular-nums">police {h.police_level ?? '?'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {route.crosses_killzone && !route.detour?.found && (
              <div className="mt-2 text-[13px]" style={{ color: 'hsl(var(--smui-orange))' }}>
                No killzone-free path exists — every known route passes through a banned system.
              </div>
            )}

            <div className="mt-2 flex flex-col gap-1">
              {route.hops.map((h: any, i: number) => (
                <div key={i} className="flex items-baseline gap-3 text-[13px]">
                  <span className="w-7 text-right text-muted-foreground tabular-nums">{i}</span>
                  <span className="font-mono w-60">{h.system_id}</span>
                  <span className="w-28" style={{ color: `hsl(${RISK_TONE[h.risk] ?? 'var(--smui-orange)'})` }}>{h.risk}</span>
                  <span className="text-muted-foreground tabular-nums">police {h.police_level ?? '?'}</span>
                  {h.grade && <span className="text-muted-foreground text-[11.5px]">{h.grade}</span>}
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

interface OreRow {
  item_id: string; item_name: string; pois: number; systems: number
  best_richness: number; best_power: number; last_seen_total: number; newest: string
}
interface DepositRow {
  poi_id: string; item_id: string; system_id: string; system_name: string
  poi_name: string; poi_type: string; item_name: string
  richness: number; remaining: number; supported_power: number
  reported_by: string; first_seen: string; last_seen: string; age_days: number
  jumps: number | null; worst_hop: string | null
  lawless_hops: number | null; crosses_killzone: boolean
}

/** How much a reading can still be believed. Deliberately pessimistic. */
function freshness(days: number): { label: string; tone: string } {
  if (days < 1) return { label: 'today', tone: 'var(--smui-green)' }
  if (days < 3) return { label: `${Math.round(days)}d old`, tone: 'var(--smui-green)' }
  if (days < 14) return { label: `${Math.round(days)}d old`, tone: 'var(--smui-yellow)' }
  return { label: `${Math.round(days)}d old`, tone: 'var(--smui-orange)' }
}

/**
 * Where to mine — every place the fleet has actually seen an ore in the ground.
 *
 * The deposits table has held this since the first survey (1,200-odd readings
 * across ~385 POIs) and nothing ever showed it, so the standing answer to "where
 * can we mine titanium" was to send somebody to go and find out again — past
 * belts we had already logged.
 *
 * Two things this view refuses to do, both because they have cost us trips:
 *
 *  - It does not rank on `remaining`. Richness is a property of the seam; the
 *    remaining count is a reading that was true once and moves in both directions
 *    as a belt is mined and regenerates. The game gates extraction on `too_sparse`
 *    against a `lock_minimum_stock` we do not store, so no cached number here can
 *    tell you a belt is open. A survey claiming 18,879 units got an agent refused
 *    at the rock face.
 *  - It does not hide the age of a reading. A 43-day-old survey reads exactly like
 *    a fresh one in a table that omits the date, and one nearly sent a miner eight
 *    jumps to a seam nobody had looked at since August.
 *
 * So every row leads with richness and the age of the reading, carries the trip
 * from Krynn with its worst hop, and says plainly that `get_poi` is the verdict.
 */
export function WhereToMine() {
  const [q, setQ] = useState('')
  const [ores, setOres] = useState<OreRow[] | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [rows, setRows] = useState<DepositRow[] | null>(null)
  const [from, setFrom] = useState('')
  const [origin, setOrigin] = useState('krynn')
  const [choices, setChoices] = useState<string[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/fleet-intel/deposits?q=${encodeURIComponent(q)}`)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = await r.json()
        // `items` is an ARRAY here and a COUNT on the summary route of an older
        // server. Rendering is not the place to find that out: mapping over a
        // number white-screens the whole Intel page.
        if (alive) { setOres(Array.isArray(j.items) ? j.items : []); setErr(null) }
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : String(e)) }
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [q])

  const open = async (itemId: string, fromWhere = from) => {
    setSel(itemId); setRows(null); setChoices(null)
    try {
      const q = fromWhere.trim() ? `&from=${encodeURIComponent(fromWhere.trim())}` : ''
      const r = await fetch(`/api/fleet-intel/deposits?item=${encodeURIComponent(itemId)}&limit=60&empty=1${q}`)
      const j = await r.json()
      if (Array.isArray(j.ambiguous) && j.ambiguous.length) { setChoices(j.ambiguous); return }
      setOrigin(String(j.from ?? 'krynn'))
      setRows(Array.isArray(j.deposits) ? j.deposits : [])
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  // Changing where you are measuring from re-grades the open list rather than
  // closing it — the whole point is to compare the same sites from a new spot.
  useEffect(() => {
    if (!sel) return
    const t = setTimeout(() => { void open(sel, from) }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Search size={13} className="text-muted-foreground" />
        <input
          value={q} onChange={e => { setQ(e.target.value); setSel(null); setRows(null) }}
          placeholder="which ore? — titanium, silicon, energy crystal, gold…"
          className="flex-1 bg-transparent border border-border/60 px-2 py-1 text-[12.5px] font-mono outline-none focus:border-foreground/40"
        />
        <span className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground shrink-0">from</span>
        <input
          value={from} onChange={e => setFrom(e.target.value)}
          placeholder="krynn"
          title="Measure jumps from here — a system, a station, or part of a name. Blank means home."
          className="w-44 bg-transparent border border-border/60 px-2 py-1 text-[12.5px] font-mono outline-none focus:border-foreground/40"
        />
      </div>

      {choices && (
        <div className="border px-3 py-2 text-[11.5px]" style={{ borderColor: 'hsl(var(--smui-yellow) / 0.5)' }}>
          <span className="text-muted-foreground">“{from}” matches several places — which one?</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {choices.map(c => (
              <button key={c} onClick={() => setFrom(c)}
                className="font-mono px-1.5 py-0.5 border border-border/60 hover:bg-foreground/10">{c}</button>
            ))}
          </div>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground/70 px-1 leading-relaxed">
        Every place the fleet has <strong>actually surveyed</strong> this ore — not where it might be.
        Ranked on <strong>richness</strong>, which is a property of the seam, never on the remaining count,
        which was true once and moves as a belt is mined and regenerates. <strong>No number here says a
        belt is open.</strong> The game gates extraction on <code>too_sparse</code> against a minimum stock
        we do not hold, so <code>get_poi</code> at the rock face is the only verdict.
      </p>

      {err && <div className="text-[12px]" style={{ color: 'hsl(var(--smui-orange))' }}>Lookup failed: {err}</div>}

      {sel && (
        <div className="border px-3 py-2.5" style={{ borderColor: 'hsl(var(--smui-green) / 0.4)' }}>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[14px] font-semibold font-mono">{sel}</span>
            <span className="text-[11.5px] text-muted-foreground">
              {rows ? `${rows.length} known site${rows.length === 1 ? '' : 's'}` : 'loading…'} · jumps from <span className="font-mono">{origin}</span>
            </span>
            <button onClick={() => { setSel(null); setRows(null) }}
              className="ml-auto text-[11px] text-muted-foreground hover:text-foreground">close</button>
          </div>

          <div className="mt-2.5 flex items-baseline gap-2 text-[10px] uppercase tracking-wider text-muted-foreground px-1 pb-1">
            <span className="flex-1">site</span>
            <span className="w-24">system</span>
            <span className="w-16 text-right">richness</span>
            <span className="w-16 text-right">power</span>
            <span className="w-24 text-right">last seen</span>
            <span className="w-16 text-right">jumps</span>
            <span className="w-28 text-right">corridor</span>
          </div>

          <div className="flex flex-col">
            {(rows ?? []).map(d => {
              const f = freshness(Number(d.age_days ?? 0))
              const tone = d.crosses_killzone ? 'var(--smui-red)'
                : RISK_TONE[String(d.worst_hop ?? '')] ?? 'var(--smui-green)'
              return (
                <div key={d.poi_id} className="flex items-baseline gap-2 text-[12.5px] px-1 py-1 border-b border-border/20">
                  <span className="flex-1 truncate" title={`${d.poi_name} (${d.poi_id})`}>
                    {d.poi_name || d.poi_id}
                    <span className="ml-1.5 text-[10px] text-muted-foreground/70">{d.poi_type}</span>
                  </span>
                  <span className="w-24 font-mono text-[11.5px] text-muted-foreground truncate" title={d.system_id}>
                    {d.system_name || d.system_id || '—'}
                  </span>
                  <span className="w-16 text-right tabular-nums font-semibold">{d.richness || '—'}</span>
                  <span className="w-16 text-right tabular-nums text-muted-foreground" title="supported_power — the array this seam will carry">
                    {d.supported_power || '—'}
                  </span>
                  <span className="w-24 text-right tabular-nums text-[11px]" style={{ color: `hsl(${f.tone})` }}
                    title={`${d.remaining?.toLocaleString?.() ?? d.remaining} seen on ${String(d.last_seen).slice(0, 10)} by ${d.reported_by}`}>
                    {(d.remaining ?? 0).toLocaleString()} · {f.label}
                  </span>
                  <span className="w-16 text-right tabular-nums">{d.jumps == null ? '—' : d.jumps}</span>
                  <span className="w-28 text-right text-[11px]" style={{ color: `hsl(${tone})` }}>
                    {d.crosses_killzone ? 'KILLZONE' : (d.worst_hop ?? 'unknown')}
                    {!!d.lawless_hops && <span className="text-muted-foreground"> ·{d.lawless_hops}</span>}
                  </span>
                </div>
              )
            })}
            {rows && !rows.length && (
              <div className="text-[12px] text-muted-foreground px-1 py-3">
                Nobody has ever reported <span className="font-mono">{sel}</span> in the ground. That is a gap in
                our survey, not proof it is unmineable — check <code>extracted_by</code> in the codex.
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline gap-2 text-[10px] uppercase tracking-wider text-muted-foreground px-2 pb-1">
          <span className="flex-1">ore</span>
          <span className="w-16 text-right">sites</span>
          <span className="w-20 text-right">systems</span>
          <span className="w-20 text-right">best rich</span>
          <span className="w-24 text-right">newest look</span>
        </div>
        {(ores ?? []).map(o => (
          <button key={o.item_id} onClick={() => open(o.item_id)}
            className="flex items-baseline gap-2 text-[12.5px] px-2 py-1 hover:bg-foreground/5 text-left border-b border-border/20">
            <span className="flex-1 font-mono">{o.item_id}
              {o.item_name && <span className="ml-2 text-[11px] text-muted-foreground/70">{o.item_name}</span>}
            </span>
            <span className="w-16 text-right tabular-nums font-semibold">{o.pois}</span>
            <span className="w-20 text-right tabular-nums text-muted-foreground">{o.systems}</span>
            <span className="w-20 text-right tabular-nums" style={{ color: 'hsl(var(--smui-green))' }}>{o.best_richness || '—'}</span>
            <span className="w-24 text-right tabular-nums text-[11px] text-muted-foreground">{String(o.newest ?? '').slice(0, 10)}</span>
          </button>
        ))}
        {ores && !ores.length && <div className="text-[12px] text-muted-foreground px-2 py-3">No surveyed ore matches “{q}”.</div>}
      </div>
    </div>
  )
}
