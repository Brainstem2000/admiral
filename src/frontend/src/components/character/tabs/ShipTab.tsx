/** Ship tab — the shipworks dossier: vitals, budgets with per-module draw,
 *  slot bays with fitted modules and UPGRADE indicators (catalog-computed,
 *  annotated with fleet storage + market availability), inherent hull
 *  capabilities, and a value-aware cargo manifest.
 *  Data: GET /api/profiles/:id/ship-analysis (one free get_ship, zero ticks). */
import { useState, useEffect, useCallback, useRef } from 'react'
import { Rocket, RefreshCw, Heart, Shield, Fuel, Cpu, Zap, Package, Crosshair, ShieldCheck, Wrench, TrendingUp, Sparkles } from 'lucide-react'
import type { Profile } from '@/types'
import { DossierCard } from '../DossierCard'
import { DISPLAY, Bar, StatCell } from '../dossier-shared'

interface UpgradeCandidate {
  id: string; name?: string
  cpu_usage: number; power_usage: number
  damage?: number | null; damage_type?: string | null; reach?: number | null
  base_value: number
  required_skills?: Record<string, number> | null
  fleet_held: number
  market: { station: string; ask: number; depth: number | null; seen: string } | null
}
interface FittedModule {
  module_id?: string; name?: string; slot?: string
  cpu_usage?: number; power_usage?: number; size?: number
  ammo_type?: string; loaded_ammo_name?: string; current_ammo?: number; magazine_size?: number
  stats?: Record<string, unknown>
  upgrades: UpgradeCandidate[]
}
interface OpenSlot { slot: string; open: number; suggestions: UpgradeCandidate[] }
interface CargoRow { item_id: string; name?: string; item_name?: string; quantity: number; size?: number | null; base_value?: number | null }
interface Analysis {
  ship: Record<string, unknown>
  hull_catalog: { tier?: number; class?: string; faction?: string; inherent_capabilities?: Record<string, unknown> | null } | null
  budgets: { cpu_free: number; power_free: number }
  modules: FittedModule[]
  open_slots: OpenSlot[]
  cargo: CargoRow[]
  fetched_at: string
}

const analysisCache = new Map<string, Analysis>()

function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }

const SLOT_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  weapon: { label: 'Weapon Bays', icon: <Crosshair size={11} />, color: 'var(--smui-red)' },
  defense: { label: 'Defense Bays', icon: <ShieldCheck size={11} />, color: 'var(--primary)' },
  utility: { label: 'Utility Bays', icon: <Wrench size={11} />, color: 'var(--smui-frost-2)' },
}

/** One upgrade candidate line: what it is, what it beats, where to get it. */
function CandidateLine({ c, current }: { c: UpgradeCandidate; current?: FittedModule }) {
  const dmgNow = num(current?.stats?.damage ?? (current as Record<string, unknown> | undefined)?.damage)
  const delta = c.damage != null && dmgNow > 0 ? ` (+${num(c.damage) - dmgNow} dmg)` : ''
  const skills = c.required_skills && Object.keys(c.required_skills).length
    ? ` · needs ${Object.entries(c.required_skills).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''
  const source = c.fleet_held > 0
    ? <span style={{ color: 'hsl(var(--smui-green))' }}>fleet holds {c.fleet_held}</span>
    : c.market
      ? <span style={{ color: 'hsl(var(--smui-yellow))' }}>ask {c.market.ask.toLocaleString()}{c.market.depth != null ? ` ×${c.market.depth}` : ''} @ {c.market.station.replace(/_/g, ' ')}</span>
      : <span className="text-muted-foreground/50">no market sighting</span>
  return (
    <div className="flex items-baseline gap-2 text-[10.5px] leading-relaxed min-w-0">
      <span className="text-foreground/85 truncate">{c.name || c.id}{delta}</span>
      <span className="text-muted-foreground/50 tabular-nums shrink-0">{c.cpu_usage}cpu/{c.power_usage}pw{skills}</span>
      <span className="ml-auto shrink-0 tabular-nums">{source}</span>
    </div>
  )
}

/** A fitted module card, with its draw, ammo state, and upgrade indicator. */
function ModuleCard({ m }: { m: FittedModule }) {
  const [open, setOpen] = useState(false)
  const meta = SLOT_META[String(m.slot)] || SLOT_META.utility
  const stats = (m.stats || {}) as Record<string, unknown>
  const dmg = num(stats.damage)
  const hasUpgrade = m.upgrades.length > 0
  const ammoPct = num(m.magazine_size) > 0 ? Math.round((num(m.current_ammo) / num(m.magazine_size)) * 100) : null
  return (
    <div className="border border-border/60 bg-background/40 p-2 min-w-0">
      <div className="flex items-center gap-1.5">
        <span style={{ color: `hsl(${meta.color})` }}>{meta.icon}</span>
        <span className="text-[11.5px] font-medium text-foreground/95 truncate flex-1" style={DISPLAY}>{m.name || m.module_id}</span>
        {hasUpgrade && (
          <button
            onClick={() => setOpen(o => !o)}
            className="flex items-center gap-1 text-[9px] uppercase tracking-wider px-1.5 py-0.5 border transition-colors"
            style={{ color: 'hsl(var(--smui-yellow))', borderColor: 'hsl(var(--smui-yellow) / 0.5)' }}
            title={`${m.upgrades.length} better module(s) fit this slot within budget — click to expand`}
          >
            <TrendingUp size={9} /> upgrade
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[10px] tabular-nums text-muted-foreground">
        <span>{num(m.cpu_usage)} cpu · {num(m.power_usage)} pw</span>
        {dmg > 0 && <span style={{ color: 'hsl(var(--smui-red) / 0.9)' }}>{dmg} dmg{stats.damage_type ? ` ${String(stats.damage_type)}` : ''}</span>}
        {num(stats.reach) > 0 && <span>reach {num(stats.reach)}</span>}
        {num(stats.mining_power) > 0 && <span style={{ color: 'hsl(var(--smui-green))' }}>{num(stats.mining_power)} mining</span>}
        {ammoPct != null && (
          <span style={ammoPct < 25 ? { color: 'hsl(var(--smui-orange))' } : undefined}>
            {m.loaded_ammo_name || m.ammo_type}: {num(m.current_ammo).toLocaleString()}/{num(m.magazine_size).toLocaleString()} ({ammoPct}%)
          </span>
        )}
      </div>
      {open && hasUpgrade && (
        <div className="mt-1.5 pt-1.5 border-t border-border/40 flex flex-col gap-1">
          {m.upgrades.map(u => <CandidateLine key={u.id} c={u} current={m} />)}
        </div>
      )}
    </div>
  )
}

function OpenSlotCard({ slot, suggestions }: { slot: string; suggestions: UpgradeCandidate[] }) {
  const [open, setOpen] = useState(false)
  const meta = SLOT_META[slot] || SLOT_META.utility
  return (
    <div className="border border-dashed border-border/70 p-2 min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground/50">{meta.icon}</span>
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70 flex-1" style={DISPLAY}>open {slot} slot</span>
        {suggestions.length > 0 && (
          <button
            onClick={() => setOpen(o => !o)}
            className="flex items-center gap-1 text-[9px] uppercase tracking-wider px-1.5 py-0.5 border transition-colors"
            style={{ color: 'hsl(var(--smui-frost-2))', borderColor: 'hsl(var(--smui-frost-2) / 0.5)' }}
            title="Modules that fit the current free budget"
          >
            <Sparkles size={9} /> fits
          </button>
        )}
      </div>
      {open && suggestions.length > 0 && (
        <div className="mt-1.5 pt-1.5 border-t border-border/40 flex flex-col gap-1">
          {suggestions.map(u => <CandidateLine key={u.id} c={u} />)}
        </div>
      )}
    </div>
  )
}

export function ShipTab({ profile, connected }: { profile: Profile; connected: boolean }) {
  const [data, setData] = useState<Analysis | null>(() => analysisCache.get(profile.id) || null)
  const [loading, setLoading] = useState(false)
  const profileIdRef = useRef(profile.id)

  useEffect(() => {
    profileIdRef.current = profile.id
    setData(analysisCache.get(profile.id) || null)
  }, [profile.id])

  const fetchShip = useCallback(async () => {
    if (!connected) return
    const targetId = profile.id
    setLoading(true)
    try {
      const resp = await fetch(`/api/profiles/${targetId}/ship-analysis`)
      const body = await resp.json() as Analysis & { error?: string }
      if (profileIdRef.current !== targetId) return
      if (body.error || !body.ship) return
      analysisCache.set(targetId, body)
      setData(body)
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

  if (!data) {
    return (
      <DossierCard title="Ship" icon={<Rocket size={12} />} source="Server" className="min-h-[120px]" bodyClassName="px-3 py-3" action={connected ? refreshAction : undefined}>
        <span className="text-[11px] text-muted-foreground/50 italic">
          {connected ? (loading ? 'Analyzing loadout…' : 'No ship data') : 'Connect to load ship data'}
        </span>
      </DossierCard>
    )
  }

  const { ship, hull_catalog, budgets, modules, open_slots, cargo } = data
  const cargoUsed = num(ship.cargo_used)
  const cargoCap = num(ship.cargo_capacity)
  const upgradeCount = modules.reduce((n, m) => n + (m.upgrades.length > 0 ? 1 : 0), 0)
  const openCount = open_slots.reduce((n, s) => n + s.open, 0)
  const caps = hull_catalog?.inherent_capabilities && typeof hull_catalog.inherent_capabilities === 'object'
    ? Object.entries(hull_catalog.inherent_capabilities as Record<string, unknown>) : []
  const bySlot = (slot: string) => modules.filter(m => String(m.slot) === slot)
  const cargoValue = cargo.reduce((s, r) => s + num(r.base_value) * num(r.quantity), 0)
  const fetchedAge = Math.max(0, Math.round((Date.now() - Date.parse(data.fetched_at)) / 1000))

  return (
    <div className="flex flex-col gap-4">
      {/* ——— Command header: identity + vitals ——— */}
      <DossierCard title="Loadout" icon={<Rocket size={12} />} source="Server" className="min-h-[140px]" bodyClassName="p-3" action={refreshAction}>
        <div className="flex items-baseline gap-2 mb-3 flex-wrap">
          <span className="text-base font-semibold text-foreground truncate tracking-wide" style={DISPLAY}>{String(ship.name || 'Unnamed')}</span>
          <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 border border-border text-muted-foreground">
            {String(ship.class_id ?? '').replace(/_/g, ' ')}
          </span>
          {hull_catalog?.tier != null && (
            <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 border" style={{ color: 'hsl(var(--smui-yellow))', borderColor: 'hsl(var(--smui-yellow) / 0.4)' }}>
              tier {hull_catalog.tier}
            </span>
          )}
          {hull_catalog?.class && <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">{hull_catalog.class}</span>}
          <span className="ml-auto text-[9px] text-muted-foreground/50 tabular-nums" title={data.fetched_at}>as of {fetchedAge}s ago</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3 mb-4">
          <Bar icon={<Heart size={12} />} label="Hull" color="var(--destructive)" cur={num(ship.hull)} max={num(ship.max_hull)} />
          <Bar icon={<Shield size={12} />} label="Shield" color="var(--primary)" cur={num(ship.shield)} max={num(ship.max_shield)} />
          <Bar icon={<Fuel size={12} />} label="Fuel" color="var(--smui-orange)" cur={num(ship.fuel)} max={num(ship.max_fuel)} flagHigh={false} />
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-x-4 gap-y-2">
          <StatCell label="Armor" value={num(ship.armor).toLocaleString()} />
          <StatCell label="Speed" value={num(ship.speed).toLocaleString()} />
          <StatCell label="Shield Regen" value={`${num(ship.shield_recharge).toLocaleString()}/t`} />
          <StatCell label="Crew" value={`${num((ship.personnel as Record<string, unknown> | undefined)?.crew_fit ?? ship.minimum_crew)}${ship.effective_crew_capacity ? `/${num(ship.effective_crew_capacity)}` : ''}`} hint="fit crew / capacity" />
          <StatCell label="Capacitor" value={num(ship.max_capacitor) > 0 ? `${num(ship.capacitor)}/${num(ship.max_capacitor)}` : '—'} />
        </div>
        {caps.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-border/40">
            {caps.map(([k, v]) => (
              <span key={k} className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 border" style={{ color: 'hsl(var(--smui-green))', borderColor: 'hsl(var(--smui-green) / 0.4)' }}
                title="Inherent hull capability — always on, costs no slot">
                {k.replace(/_/g, ' ')}: {String(v)}
              </span>
            ))}
          </div>
        )}
      </DossierCard>

      {/* ——— Budgets: the fitting envelope ——— */}
      <DossierCard title="Fitting Budgets" icon={<Cpu size={12} />} source="Server" className="min-h-[80px]" bodyClassName="p-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 mb-2">
          <Bar icon={<Cpu size={12} />} label="CPU" color="var(--smui-purple)" cur={num(ship.cpu_used)} max={num(ship.cpu_capacity)} flagHigh />
          <Bar icon={<Zap size={12} />} label="Power" color="var(--smui-frost-3)" cur={num(ship.power_used)} max={num(ship.power_capacity)} flagHigh />
        </div>
        <div className="text-[10.5px] text-muted-foreground tabular-nums">
          Headroom: <span className="text-foreground/85">{budgets.cpu_free} cpu · {budgets.power_free} power</span>
          {upgradeCount > 0 && (
            <span className="ml-3" style={{ color: 'hsl(var(--smui-yellow))' }}>▲ {upgradeCount} fitted module{upgradeCount > 1 ? 's' : ''} upgradeable within budget</span>
          )}
          {openCount > 0 && (
            <span className="ml-3" style={{ color: 'hsl(var(--smui-frost-2))' }}>{openCount} slot{openCount > 1 ? 's' : ''} open</span>
          )}
        </div>
      </DossierCard>

      {/* ——— Slot bays ——— */}
      {(['weapon', 'defense', 'utility'] as const).map(slot => {
        const fitted = bySlot(slot)
        const openInfo = open_slots.find(s => s.slot === slot)
        const cap = num(ship[`${slot}_slots`])
        if (!cap && !fitted.length) return null
        const meta = SLOT_META[slot]
        return (
          <DossierCard
            key={slot}
            title={`${meta.label} — ${fitted.length}/${cap || fitted.length}`}
            icon={meta.icon}
            source="Server"
            className="min-h-[60px]"
            bodyClassName="p-3"
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {fitted.map((m, i) => <ModuleCard key={String(m.module_id ?? i)} m={m} />)}
              {openInfo && openInfo.open > 0 && Array.from({ length: openInfo.open }, (_, i) => (
                <OpenSlotCard key={`open-${i}`} slot={slot} suggestions={i === 0 ? openInfo.suggestions : []} />
              ))}
            </div>
          </DossierCard>
        )
      })}

      {/* ——— Cargo manifest with value ——— */}
      <DossierCard title="Cargo" icon={<Package size={12} />} source="Server" className="min-h-[100px]">
        <div className="p-3 pb-2">
          <Bar icon={<Package size={12} />} label="Hold" color="var(--smui-green)" cur={cargoUsed} max={cargoCap} />
        </div>
        {cargo.length === 0 ? (
          <div className="px-3 pb-3 text-[11px] text-muted-foreground/50 italic">Cargo hold empty.</div>
        ) : (
          <>
            <div className="flex items-center gap-2.5 px-3 py-1.5 border-t border-border/40 text-[9px] uppercase tracking-wider text-muted-foreground" style={DISPLAY}>
              <span className="flex-1 min-w-0">Item</span>
              <span className="w-12 shrink-0 text-right">Qty</span>
              <span className="w-12 shrink-0 text-right">Vol</span>
              <span className="w-20 shrink-0 text-right" title="quantity × catalog base value — NOT market realisable">Base Val</span>
            </div>
            {cargo.map(item => (
              <div key={item.item_id} className="flex items-center gap-2.5 px-3 py-1.5 border-t border-border/30 text-xs">
                <span className="flex-1 min-w-0 truncate text-foreground/85">{(item.name || item.item_name || item.item_id).replace(/_/g, ' ')}</span>
                <span className="w-12 shrink-0 text-right tabular-nums text-foreground/90">{num(item.quantity).toLocaleString()}</span>
                <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground/70">{item.size != null ? num(item.size) * num(item.quantity) : '—'}</span>
                <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground/70">{item.base_value != null ? (num(item.base_value) * num(item.quantity)).toLocaleString() : '—'}</span>
              </div>
            ))}
            {cargoValue > 0 && (
              <div className="flex items-center gap-2.5 px-3 py-1.5 border-t border-border/40 text-[10px]">
                <span className="flex-1 text-muted-foreground uppercase tracking-wider" style={DISPLAY}>total base value</span>
                <span className="shrink-0 tabular-nums" style={{ color: 'hsl(var(--smui-yellow))' }} title="Catalog base values — market realisable value depends on bid depth">{cargoValue.toLocaleString()}c</span>
              </div>
            )}
          </>
        )}
      </DossierCard>
    </div>
  )
}
