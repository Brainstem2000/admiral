import { useState, useEffect, useMemo } from 'react'
import { Package, Hammer, Rocket, Factory, GraduationCap, Search, Network, Loader2 } from 'lucide-react'

type Kind = 'item' | 'recipe' | 'ship' | 'facility' | 'skill'

interface Row {
  id: string
  name: string
  category?: string
  base_value?: number
  rarity?: string
  size?: number
  outputs?: Array<{ item_id: string; quantity: number }>
  class?: string
  tier?: number
  faction?: string
  level?: number
  build_cost?: number
}

const KIND_TABS: { key: Kind; label: string; icon: React.ReactNode }[] = [
  { key: 'item', label: 'Items', icon: <Package size={12} /> },
  { key: 'recipe', label: 'Recipes', icon: <Hammer size={12} /> },
  { key: 'ship', label: 'Ships', icon: <Rocket size={12} /> },
  { key: 'facility', label: 'Facilities', icon: <Factory size={12} /> },
  { key: 'skill', label: 'Skills', icon: <GraduationCap size={12} /> },
]

export function CodexPanel() {
  const [kind, setKind] = useState<Kind>('item')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null)
  const [chain, setChain] = useState<string | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  // Cross-kind navigation (e.g. item → producing recipe): the kind-change effect
  // clears the selection, so the target id is handed off through this ref-like state.
  const [pendingSelect, setPendingSelect] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/codex').then(r => r.json()).then(d => setVersion(d.version)).catch(() => {})
  }, [])

  // Debounced list fetch on kind/query change
  useEffect(() => {
    setSelectedId(pendingSelect)
    if (pendingSelect) setPendingSelect(null)
    setDetail(null)
    setChain(null)
    setLoading(true)
    const t = setTimeout(() => {
      fetch(`/api/codex/${kind}?q=${encodeURIComponent(query)}&limit=100`)
        .then(r => r.json())
        .then(d => { if (Array.isArray(d)) setRows(d) })
        .catch(() => setRows([]))
        .finally(() => setLoading(false))
    }, 200)
    return () => clearTimeout(t)
  }, [kind, query])

  useEffect(() => {
    if (!selectedId) return
    setDetail(null)
    setChain(null)
    fetch(`/api/codex/${kind}/${selectedId}`)
      .then(r => r.json())
      .then(d => setDetail(d.error ? null : d))
      .catch(() => setDetail(null))
  }, [kind, selectedId])

  const loadChain = (itemId: string) => {
    setChain('...')
    fetch(`/api/codex/chain/${itemId}?qty=1`)
      .then(r => r.json())
      .then(d => setChain(d.text ?? null))
      .catch(() => setChain(null))
  }

  const summaryLine = useMemo(() => {
    if (!detail) return ''
    const parts: string[] = []
    if (detail.category) parts.push(String(detail.category))
    if (detail.rarity) parts.push(String(detail.rarity))
    if (detail.base_value != null) parts.push(`base_value ${detail.base_value} cr`)
    if (detail.size != null) parts.push(`size ${detail.size}`)
    if (detail.tier != null) parts.push(`tier ${detail.tier}`)
    if (detail.build_cost != null) parts.push(`build_cost ${Number(detail.build_cost).toLocaleString()} cr`)
    return parts.join(' · ')
  }, [detail])

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar + search */}
      <div className="flex items-center gap-0.5 bg-card border-b border-border px-2 py-1.5">
        {KIND_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setKind(t.key)}
            className={`flex items-center gap-1.5 px-3 py-1 text-[11px] uppercase tracking-wider transition-colors ${
              kind === t.key
                ? 'text-primary bg-primary/10 border border-primary/30'
                : 'text-muted-foreground hover:text-foreground border border-transparent'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
        <div className="flex-1" />
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={`search ${kind}s...`}
            className="bg-background border border-border pl-7 pr-2 py-1 text-xs font-jetbrains w-56 focus:outline-none focus:border-primary/50"
          />
        </div>
        {version && <span className="ml-2 text-[10px] text-muted-foreground font-jetbrains">game data v{version}</span>}
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* List */}
        <div className="w-[380px] border-r border-border overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
            </div>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted-foreground font-jetbrains">no matches</div>
          ) : (
            rows.map(r => (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className={`w-full text-left px-3 py-1.5 border-b border-border/40 hover:bg-primary/5 transition-colors ${
                  selectedId === r.id ? 'bg-primary/10' : ''
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium truncate">{r.name}</span>
                  <span className="text-[10px] text-muted-foreground font-jetbrains shrink-0">
                    {kind === 'item' && r.base_value != null ? `${r.base_value} cr` : ''}
                    {kind === 'ship' ? `T${r.tier ?? '?'} ${r.class ?? ''}` : ''}
                    {kind === 'facility' && r.build_cost != null ? `${Number(r.build_cost).toLocaleString()} cr` : ''}
                    {kind === 'recipe' && r.outputs?.length ? `→ ${r.outputs[0].item_id}` : ''}
                  </span>
                </div>
                <div className="text-[10px] text-muted-foreground font-jetbrains truncate">
                  {r.id}{r.category ? ` · ${r.category}` : ''}{kind === 'item' && r.rarity ? ` · ${r.rarity}` : ''}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Detail */}
        <div className="flex-1 overflow-y-auto p-4">
          {!detail ? (
            <div className="h-full flex items-center justify-center text-xs text-muted-foreground font-jetbrains">
              select an entry
            </div>
          ) : (
            <div className="max-w-3xl space-y-4">
              <div>
                <h2 className="text-base font-semibold">{String(detail.name)}</h2>
                <div className="text-[11px] text-muted-foreground font-jetbrains">{String(detail.id)}{summaryLine ? ` — ${summaryLine}` : ''}</div>
                {typeof detail.description === 'string' && detail.description && (
                  <p className="text-xs text-muted-foreground mt-2">{detail.description}</p>
                )}
              </div>

              {/* Recipe inputs/outputs */}
              {Array.isArray(detail.inputs) && (
                <QtyTable title="Inputs" rows={detail.inputs as Array<{ item_id: string; quantity: number }>} />
              )}
              {Array.isArray(detail.outputs) && (
                <QtyTable title="Outputs" rows={detail.outputs as Array<{ item_id: string; quantity: number }>} />
              )}

              {/* Build materials (ships + facilities) */}
              {Array.isArray(detail.build_materials) && (detail.build_materials as unknown[]).length > 0 && (
                <QtyTable title="Build materials" rows={detail.build_materials as Array<{ item_id: string; quantity: number }>} />
              )}

              {/* Item: producing + consuming recipes */}
              {Array.isArray(detail.produced_by) && (
                <RecipeRefs title="Produced by" refs={detail.produced_by as Array<{ id: string; name: string }>} onOpen={id => { setPendingSelect(id); setQuery(''); setKind('recipe') }} />
              )}
              {Array.isArray(detail.consumed_by) && (detail.consumed_by as unknown[]).length > 0 && (
                <RecipeRefs title="Consumed by" refs={detail.consumed_by as Array<{ id: string; name: string }>} onOpen={id => { setPendingSelect(id); setQuery(''); setKind('recipe') }} />
              )}

              {/* Crafting chain for items */}
              {kind === 'item' && (
                <div>
                  <button
                    onClick={() => loadChain(String(detail.id))}
                    className="flex items-center gap-1.5 px-3 py-1 text-[11px] uppercase tracking-wider text-primary bg-primary/10 border border-primary/30 hover:bg-primary/20 transition-colors"
                  >
                    <Network size={12} /> Crafting chain
                  </button>
                  {chain && (
                    <pre className="mt-2 text-[11px] font-jetbrains bg-card border border-border p-3 overflow-x-auto whitespace-pre-wrap">{chain}</pre>
                  )}
                </div>
              )}

              {/* Ship stats */}
              {kind === 'ship' && (
                <div className="grid grid-cols-3 gap-2 text-xs font-jetbrains">
                  {(['base_hull', 'base_shield', 'base_armor', 'base_speed', 'cargo_capacity', 'piloting_required', 'shipyard_tier', 'weapon_slots', 'defense_slots'] as const)
                    .filter(k => detail[k] != null)
                    .map(k => (
                      <div key={k} className="bg-card border border-border px-2 py-1.5">
                        <div className="text-[10px] text-muted-foreground uppercase">{k.replace('base_', '').replace(/_/g, ' ')}</div>
                        <div>{String(detail[k])}</div>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function QtyTable({ title, rows }: { title: string; rows: Array<{ item_id: string; quantity: number }> }) {
  return (
    <div>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{title}</div>
      <div className="bg-card border border-border">
        {rows.map((r, i) => (
          <div key={i} className="flex justify-between px-3 py-1 text-xs font-jetbrains border-b border-border/40 last:border-0">
            <span>{r.item_id}</span>
            <span className="text-muted-foreground">x{r.quantity}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function RecipeRefs({ title, refs, onOpen }: { title: string; refs: Array<{ id: string; name: string }>; onOpen: (id: string) => void }) {
  if (!refs.length) {
    return (
      <div>
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{title}</div>
        <div className="text-xs text-muted-foreground font-jetbrains">no recipe — mined, looted, or bought only</div>
      </div>
    )
  }
  return (
    <div>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {refs.map(r => (
          <button
            key={r.id}
            onClick={() => onOpen(r.id)}
            className="px-2 py-0.5 text-[11px] font-jetbrains bg-card border border-border hover:border-primary/50 transition-colors"
            title={r.name}
          >
            {r.id}
          </button>
        ))}
      </div>
    </div>
  )
}
