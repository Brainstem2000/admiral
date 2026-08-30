/** Faction command view — Stellar Alliance overview: treasury, members and
 *  roles, personnel custody, and the per-station storage picture. Stations
 *  without a lockbox render as LOCKED cards (deposits reach them, withdrawals
 *  cannot) and light up with full item tables once a lockbox is built.
 *  Data: GET /api/faction (free queries through the leader's connection). */
import { useState, useEffect, useCallback } from 'react'
import { Flag, RefreshCw, Users, Coins, Warehouse, Lock, LockOpen, Fuel, HardHat } from 'lucide-react'
import { DISPLAY, StatCell, Chip, Freshness } from './character/dossier-shared'

interface Member { username?: string; name?: string; role?: string; online?: boolean }
interface StorageStation {
  station_id: string
  status: 'unlocked' | 'locked' | 'error'
  items: Array<{ item_id: string; name?: string; quantity: number }>
  credits: number | null
  message?: string
}
interface FactionData {
  fetched_at: string
  info: {
    name?: string; tag?: string; description?: string
    leader?: string; member_count?: number; members_limit?: number
    treasury?: number
    members?: Member[]
    personnel?: Record<string, unknown>
    charter?: string | string[]
    at_war?: boolean
    owned_bases?: unknown[]
    fuel_reserve?: number; fuel_capacity?: number
    created_at?: string
  }
  storage: {
    aggregate_note: string | null
    hinted_total_items: number | null
    stations: StorageStation[]
  }
}

function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }

function stationLabel(id: string): string {
  return id.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
}

export function FactionPane() {
  const [data, setData] = useState<FactionData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (fresh = false) => {
    setLoading(true)
    try {
      const resp = await fetch(`/api/faction${fresh ? '?fresh=1' : ''}`)
      const body = await resp.json()
      if (body.error) { setError(String(body.error)); return }
      setError(null)
      setData(body as FactionData)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(() => load(), 120_000)
    return () => clearInterval(t)
  }, [load])

  if (error && !data) {
    return <div className="p-6 text-sm text-muted-foreground">Faction view unavailable: {error}</div>
  }
  if (!data) {
    return <div className="p-6 text-sm text-muted-foreground italic">{loading ? 'Querying the faction ledger…' : 'No data'}</div>
  }

  const { info, storage } = data
  const members = Array.isArray(info.members) ? info.members : []
  const personnel = (info.personnel ?? {}) as Record<string, unknown>
  const charter = Array.isArray(info.charter) ? info.charter : String(info.charter ?? '').split(/\d+\.\s/).filter(Boolean)
  const unlocked = storage.stations.filter(s => s.status === 'unlocked')
  const locked = storage.stations.filter(s => s.status !== 'unlocked')

  return (
    <div className="h-full overflow-y-auto">
      <div className="w-full max-w-[1200px] mx-auto px-4 md:px-6 pt-4 pb-8 space-y-4">

        {/* ——— Masthead ——— */}
        <div className="flex items-baseline gap-3 flex-wrap border-b-2 pb-3" style={{ borderColor: 'hsl(var(--smui-yellow) / 0.6)' }}>
          <Flag size={18} style={{ color: 'hsl(var(--smui-yellow))' }} />
          <h1 className="text-xl font-bold uppercase tracking-[0.06em] m-0" style={DISPLAY}>
            {String(info.name ?? 'Faction')} <span style={{ color: 'hsl(var(--smui-yellow))' }}>[{String(info.tag ?? '')}]</span>
          </h1>
          {info.at_war ? <Chip label="AT WAR" color="var(--smui-red)" filled /> : <Chip label="at peace" color="var(--smui-green)" />}
          <span className="ml-auto flex items-center gap-3">
            <Freshness at={data.fetched_at} />
            <button onClick={() => load(true)} disabled={loading} className="text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors">
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </button>
          </span>
        </div>

        {/* ——— Stat strip ——— */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="dossier-card p-3"><StatCell label="Treasury" value={`${num(info.treasury).toLocaleString()}c`} accent="var(--smui-yellow)" hint="Withdrawable only at stations with a faction lockbox" /></div>
          <div className="dossier-card p-3"><StatCell label="Leader" value={String(info.leader ?? '—')} /></div>
          <div className="dossier-card p-3"><StatCell label="Members" value={`${num(info.member_count)}${info.members_limit ? `/${num(info.members_limit)}` : ''}`} /></div>
          <div className="dossier-card p-3"><StatCell label="Crew Employed" value={String(personnel.crew_total ?? personnel.crew ?? '—')} hint="Faction payroll — audit in progress" /></div>
          <div className="dossier-card p-3"><StatCell label="Marines" value={String(personnel.marines_total ?? personnel.marines ?? '—')} /></div>
          <div className="dossier-card p-3"><StatCell label="Fuel Reserve" value={info.fuel_capacity ? `${num(info.fuel_reserve).toLocaleString()}/${num(info.fuel_capacity).toLocaleString()}` : '—'} /></div>
        </div>

        {/* ——— Storage ——— */}
        <div className="dossier-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <Warehouse size={13} style={{ color: 'hsl(var(--smui-yellow))' }} />
            <span className="text-[12px] uppercase tracking-[0.14em] font-semibold" style={DISPLAY}>Faction Storage</span>
            {storage.aggregate_note && (
              <span className="text-[11px] text-muted-foreground">{storage.aggregate_note}</span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {unlocked.map(s => (
              <div key={s.station_id} className="border border-border/60 bg-background/40 p-3 min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <LockOpen size={11} style={{ color: 'hsl(var(--smui-green))' }} />
                  <span className="text-[11.5px] font-medium" style={DISPLAY}>{stationLabel(s.station_id)}</span>
                  <Chip label="lockbox online" color="var(--smui-green)" />
                  {s.credits != null && <span className="ml-auto text-[11px] tabular-nums" style={{ color: 'hsl(var(--smui-yellow))' }}>{s.credits.toLocaleString()}c</span>}
                </div>
                {s.items.length === 0 ? (
                  <div className="text-[11px] text-muted-foreground/60 italic">Empty.</div>
                ) : (
                  <div className="max-h-72 overflow-y-auto">
                    {[...s.items].sort((a, b) => num(b.quantity) - num(a.quantity)).map(it => (
                      <div key={it.item_id} className="flex items-center gap-2 py-0.5 text-[11.5px] border-t border-border/20 first:border-t-0">
                        <span className="flex-1 min-w-0 truncate text-foreground/85">{(it.name || it.item_id).replace(/_/g, ' ')}</span>
                        <span className="tabular-nums text-foreground/90">{num(it.quantity).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {locked.map(s => (
              <div key={s.station_id} className="border border-dashed border-border/70 p-3 min-w-0 opacity-80">
                <div className="flex items-center gap-2">
                  <Lock size={11} className="text-muted-foreground/60" />
                  <span className="text-[11.5px] text-muted-foreground" style={DISPLAY}>{stationLabel(s.station_id)}</span>
                  <Chip label="no lockbox" color="var(--smui-orange)" title="Deposits reach this station's ledger, but contents and withdrawals need a faction lockbox built here" />
                </div>
                <div className="text-[10.5px] text-muted-foreground/60 mt-1">Contents hidden until a lockbox is built here.</div>
              </div>
            ))}
            {storage.stations.length === 0 && (
              <div className="text-[11px] text-muted-foreground/60 italic">No faction storage reported.</div>
            )}
          </div>
        </div>

        {/* ——— Members ——— */}
        <div className="dossier-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <Users size={13} style={{ color: 'hsl(var(--smui-frost-2))' }} />
            <span className="text-[12px] uppercase tracking-[0.14em] font-semibold" style={DISPLAY}>Members & Roles</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1">
            {members.map((m, i) => {
              const role = String(m.role ?? 'member').toLowerCase()
              const color = role === 'leader' ? 'var(--smui-yellow)' : role === 'officer' ? 'var(--smui-frost-2)' : 'var(--muted-foreground)'
              return (
                <div key={i} className="flex items-center gap-2 py-1 text-[12px] border-b border-border/20">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${m.online ? 'bg-[hsl(var(--smui-green))]' : 'bg-border'}`} />
                  <span className="flex-1 min-w-0 truncate text-foreground/90">{String(m.username ?? m.name ?? '?')}</span>
                  <span className="text-[9.5px] uppercase tracking-wider px-1.5 border" style={{ color: `hsl(${color})`, borderColor: `hsl(${color} / 0.4)` }}>{role}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* ——— Personnel + Charter ——— */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="dossier-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <HardHat size={13} style={{ color: 'hsl(var(--smui-orange))' }} />
              <span className="text-[12px] uppercase tracking-[0.14em] font-semibold" style={DISPLAY}>Personnel Custody</span>
            </div>
            <pre className="text-[11px] text-foreground/80 whitespace-pre-wrap font-mono m-0">{JSON.stringify(personnel, null, 1).replace(/[{}"]/g, '').trim() || '—'}</pre>
            <div className="text-[10.5px] text-muted-foreground mt-2">Payroll audit pending — wages are the prime suspect in the treasury drawdown.</div>
          </div>
          <div className="dossier-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <Coins size={13} style={{ color: 'hsl(var(--smui-green))' }} />
              <span className="text-[12px] uppercase tracking-[0.14em] font-semibold" style={DISPLAY}>Charter</span>
            </div>
            <ol className="text-[11.5px] text-foreground/80 pl-4 m-0 space-y-1">
              {charter.map((c, i) => <li key={i}>{String(c).trim()}</li>)}
            </ol>
          </div>
        </div>

        <div className="flex items-center gap-2 text-[10px] text-muted-foreground justify-center">
          <Fuel size={10} /> free queries via the leader's connection · refreshes every 2 minutes · lockbox build in progress at War Citadel
        </div>
      </div>
    </div>
  )
}
