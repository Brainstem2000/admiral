/** Ship tab — get_ship loadout: vitals, CPU/power budgets, slots/modules, cargo manifest. */
import { useState, useEffect, useCallback, useRef } from 'react'
import { Rocket, RefreshCw, Heart, Shield, Fuel, Cpu, Zap, Package, Wrench } from 'lucide-react'
import type { Profile } from '@/types'
import { DossierCard } from '../DossierCard'

interface CargoItem { item_id: string; name?: string; quantity: number }
interface ModuleDetail { id: string; name?: string; type?: string }
interface Ship {
  class_id?: string
  name?: string
  hull?: number; max_hull?: number
  shield?: number; max_shield?: number
  shield_recharge?: number; armor?: number; speed?: number
  fuel?: number; max_fuel?: number
  cargo_used?: number; cargo_capacity?: number
  cpu_used?: number; cpu_capacity?: number
  power_used?: number; power_capacity?: number
  weapon_slots?: number; defense_slots?: number; utility_slots?: number
  modules?: string[]
  cargo?: CargoItem[]
}

interface ShipData { ship: Ship; moduleDetails: ModuleDetail[]; cargo: CargoItem[] }

const shipCache = new Map<string, ShipData>()

async function runCommand(profileId: string, command: string) {
  const resp = await fetch(`/api/profiles/${profileId}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, silent: true }),
  })
  return resp.json()
}

function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }

function Bar({ icon, label, color, cur, max, flagHigh }: {
  icon: React.ReactNode; label: string; color: string; cur: number; max: number; flagHigh?: boolean
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0
  const hot = flagHigh && pct > 90
  const barColor = hot ? 'var(--smui-orange)' : color
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 mb-1">
        <span style={{ color: `hsl(${barColor})` }}>{icon}</span>
        <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] flex-1 truncate">{label}</span>
        {hot && (
          <span className="text-[9px] uppercase tracking-wider px-1 border" style={{ color: 'hsl(var(--smui-orange))', borderColor: 'hsl(var(--smui-orange) / 0.4)' }}>
            {Math.round(pct)}%
          </span>
        )}
        <span className="text-xs tabular-nums text-foreground/90">{cur.toLocaleString()}<span className="text-muted-foreground/50">/{max.toLocaleString()}</span></span>
      </div>
      <div className="h-1.5 w-full bg-border/40 overflow-hidden">
        <div className="h-full transition-all duration-300" style={{ width: `${pct}%`, background: `hsl(${barColor})` }} />
      </div>
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

export function ShipTab({ profile, connected }: { profile: Profile; connected: boolean }) {
  const [data, setData] = useState<ShipData | null>(() => shipCache.get(profile.id) || null)
  const [loading, setLoading] = useState(false)
  const profileIdRef = useRef(profile.id)

  useEffect(() => {
    profileIdRef.current = profile.id
    setData(shipCache.get(profile.id) || null)
  }, [profile.id])

  const fetchShip = useCallback(async () => {
    if (!connected) return
    const targetId = profile.id
    setLoading(true)
    try {
      const raw = await runCommand(targetId, 'get_ship')
      if (profileIdRef.current !== targetId) return
      const result = raw.structuredContent || raw.result || raw
      const ship = result?.ship as Ship | undefined
      if (!ship || typeof ship !== 'object') return
      const moduleDetails = Array.isArray(result.modules) ? (result.modules as ModuleDetail[]) : []
      let cargo = Array.isArray(ship.cargo) ? ship.cargo : null
      if (!cargo || (cargo.length === 0 && num(ship.cargo_used) > 0)) {
        // Slim shapes omit the manifest (or return an empty array despite a non-zero
        // hold) — fall back to the free get_cargo query.
        const cargoRaw = await runCommand(targetId, 'get_cargo').catch(() => null)
        if (profileIdRef.current !== targetId) return
        const cargoResult = cargoRaw?.structuredContent || cargoRaw?.result
        cargo = Array.isArray(cargoResult?.cargo) ? (cargoResult.cargo as CargoItem[]) : []
      }
      const next: ShipData = { ship, moduleDetails, cargo }
      shipCache.set(targetId, next)
      setData(next)
    } catch { /* ignore */ } finally {
      if (profileIdRef.current === targetId) setLoading(false)
    }
  }, [profile.id, connected])

  useEffect(() => {
    if (!connected) return
    fetchShip()
    const t = setInterval(fetchShip, 60_000)
    return () => clearInterval(t)
  }, [connected, fetchShip])

  const refreshAction = (
    <button onClick={fetchShip} disabled={!connected || loading} className="text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors">
      <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
    </button>
  )

  if (!connected && !data) {
    return (
      <DossierCard title="Ship" icon={<Rocket size={12} />} source="Server" className="min-h-[120px]" bodyClassName="px-3 py-3">
        <span className="text-[11px] text-muted-foreground/50 italic">Connect to load ship data</span>
      </DossierCard>
    )
  }
  if (!data) {
    return (
      <DossierCard title="Ship" icon={<Rocket size={12} />} source="Server" className="min-h-[120px]" bodyClassName="px-3 py-3" action={refreshAction}>
        <span className="text-[11px] text-muted-foreground/50 italic">{loading ? 'Loading...' : 'No ship data'}</span>
      </DossierCard>
    )
  }

  const { ship, moduleDetails, cargo } = data
  const moduleNames = new Map(moduleDetails.map(m => [m.id, m.name]))
  const moduleIds = Array.isArray(ship.modules) ? ship.modules : []
  const cargoUsed = num(ship.cargo_used)
  const cargoCap = num(ship.cargo_capacity)

  return (
    <div className="flex flex-col gap-4">
      <DossierCard title="Loadout" icon={<Rocket size={12} />} source="Server" className="min-h-[140px]" bodyClassName="p-3" action={refreshAction}>
        <div className="flex items-baseline gap-2 mb-3 flex-wrap">
          <span className="text-sm font-medium text-foreground truncate">{ship.name || 'Unnamed'}</span>
          {ship.class_id && (
            <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 border border-border text-muted-foreground">
              {String(ship.class_id).replace(/_/g, ' ')}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3 mb-4">
          <Bar icon={<Heart size={12} />} label="Hull" color="var(--destructive)" cur={num(ship.hull)} max={num(ship.max_hull)} />
          <Bar icon={<Shield size={12} />} label="Shield" color="var(--primary)" cur={num(ship.shield)} max={num(ship.max_shield)} />
          <Bar icon={<Fuel size={12} />} label="Fuel" color="var(--smui-orange)" cur={num(ship.fuel)} max={num(ship.max_fuel)} />
        </div>
        <div className="grid grid-cols-3 gap-x-4">
          <StatCell label="Armor" value={num(ship.armor).toLocaleString()} />
          <StatCell label="Speed" value={num(ship.speed).toLocaleString()} />
          <StatCell label="Shield Recharge" value={`${num(ship.shield_recharge).toLocaleString()}/t`} />
        </div>
      </DossierCard>

      <DossierCard title="Budgets" icon={<Cpu size={12} />} source="Server" className="min-h-[80px]" bodyClassName="p-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
          <Bar icon={<Cpu size={12} />} label="CPU" color="var(--smui-purple)" cur={num(ship.cpu_used)} max={num(ship.cpu_capacity)} flagHigh />
          <Bar icon={<Zap size={12} />} label="Power" color="var(--smui-frost-3)" cur={num(ship.power_used)} max={num(ship.power_capacity)} flagHigh />
        </div>
      </DossierCard>

      <DossierCard title="Slots & Modules" icon={<Wrench size={12} />} source="Server" className="min-h-[100px]" bodyClassName="p-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 mb-3">
          <StatCell label="Weapon Slots" value={num(ship.weapon_slots).toLocaleString()} accent="var(--smui-red)" />
          <StatCell label="Defense Slots" value={num(ship.defense_slots).toLocaleString()} accent="var(--primary)" />
          <StatCell label="Utility Slots" value={num(ship.utility_slots).toLocaleString()} accent="var(--smui-frost-2)" />
          <StatCell label="Modules Fitted" value={moduleIds.length.toLocaleString()} />
        </div>
        {moduleIds.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {moduleIds.map(id => (
              <span key={id} className="text-[9px] px-1.5 py-0.5 border border-border text-muted-foreground" title={id}>
                {moduleNames.get(id) || `${id.slice(0, 8)}…`}
              </span>
            ))}
          </div>
        )}
      </DossierCard>

      <DossierCard title="Cargo" icon={<Package size={12} />} source="Server" className="min-h-[100px]">
        <div className="p-3 pb-2">
          <Bar icon={<Package size={12} />} label="Hold" color="var(--smui-green)" cur={cargoUsed} max={cargoCap} />
        </div>
        {cargo.length === 0 ? (
          <div className="px-3 pb-3 text-[11px] text-muted-foreground/50 italic">Cargo hold empty.</div>
        ) : (
          <>
            <div className="flex items-center gap-2.5 px-3 py-1.5 border-t border-border/40 text-[9px] uppercase tracking-wider text-muted-foreground">
              <span className="flex-1 min-w-0">Item</span>
              <span className="w-14 shrink-0 text-right">Qty</span>
            </div>
            {cargo.map(item => (
              <div key={item.item_id} className="flex items-center gap-2.5 px-3 py-1.5 border-t border-border/30 text-xs">
                <span className="flex-1 min-w-0 truncate text-foreground/85">{(item.name || item.item_id).replace(/_/g, ' ')}</span>
                <span className="w-14 shrink-0 text-right tabular-nums text-foreground/90">{num(item.quantity).toLocaleString()}</span>
              </div>
            ))}
          </>
        )}
      </DossierCard>
    </div>
  )
}
