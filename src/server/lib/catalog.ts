import { readFileSync, writeFileSync, existsSync } from 'fs'
import path from 'path'
import { GENERATED_SPEC_VERSION } from '@spacemolt/lib'

/**
 * Game-data codex service backed by the official bulk-download endpoint
 * (https://spacemolt.com/codex → https://game.spacemolt.com/api/catalog.json).
 *
 * The endpoint is ETag'd with Cache-Control max-age=3600, so we revalidate
 * with If-None-Match hourly and keep a disk cache in data/ so a boot without
 * network (or before first fetch) still has a codex. All lookups are local —
 * agents pay zero game ticks and zero discovery turns for game knowledge.
 */

const CATALOG_URL = 'https://game.spacemolt.com/api/catalog.json'
const CACHE_FILE = path.join(process.cwd(), 'data', 'catalog-cache.json')
const ETAG_FILE = path.join(process.cwd(), 'data', 'catalog-etag.txt')
const REFRESH_MS = 60 * 60 * 1000 // matches the endpoint's max-age=3600

interface QtyRef { item_id: string; quantity: number }
export interface CatalogItem {
  id: string; name: string; description: string; category: string
  size: number; base_value: number; stackable: boolean; tradeable: boolean; rarity: string
}
export interface CatalogRecipe {
  id: string; name: string; description: string; category: string
  inputs: QtyRef[]; outputs: QtyRef[]; crafting_time: number; no_recycle?: boolean
}
export interface CatalogShip {
  id: string; name: string; class: string; tier: number; faction: string; category: string
  base_hull: number; base_shield: number; base_armor: number; base_speed: number
  cargo_capacity: number; piloting_required?: number; shipyard_tier?: number
  build_materials?: QtyRef[]; build_time?: number
  [key: string]: unknown
}
export interface CatalogFacility {
  id: string; name: string; description: string; category: string; level?: number
  recipe_id?: string; build_cost?: number; build_materials?: QtyRef[]; build_time?: number
  [key: string]: unknown
}
interface Catalog {
  version: string
  ships: CatalogShip[]
  skills: Array<Record<string, unknown> & { id: string; name: string }>
  recipes: CatalogRecipe[]
  items: CatalogItem[]
  facilities: CatalogFacility[]
  achievements: Array<Record<string, unknown> & { id: string; name: string }>
}

let catalog: Catalog | null = null
let itemsById = new Map<string, CatalogItem>()
let recipesById = new Map<string, CatalogRecipe>()
let recipesByOutput = new Map<string, CatalogRecipe[]>()
let shipsById = new Map<string, CatalogShip>()
let facilitiesById = new Map<string, CatalogFacility>()
let skillsById = new Map<string, Record<string, unknown> & { id: string; name: string }>()
let refreshTimer: ReturnType<typeof setInterval> | null = null

function buildIndexes(c: Catalog): void {
  itemsById = new Map(c.items.map((i) => [i.id, i]))
  recipesById = new Map(c.recipes.map((r) => [r.id, r]))
  recipesByOutput = new Map()
  for (const r of c.recipes) {
    for (const out of r.outputs ?? []) {
      const list = recipesByOutput.get(out.item_id) ?? []
      list.push(r)
      recipesByOutput.set(out.item_id, list)
    }
  }
  shipsById = new Map(c.ships.map((s) => [s.id, s]))
  facilitiesById = new Map(c.facilities.map((f) => [f.id, f]))
  skillsById = new Map(c.skills.map((s) => [s.id, s]))
}

async function fetchCatalog(): Promise<void> {
  const headers: Record<string, string> = {}
  if (existsSync(ETAG_FILE)) {
    try { headers['If-None-Match'] = readFileSync(ETAG_FILE, 'utf-8').trim() } catch { /* ignore */ }
  }
  const res = await fetch(CATALOG_URL, { headers })
  if (res.status === 304) return // disk/in-memory copy is current
  if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`)
  const body = await res.text()
  const parsed = JSON.parse(body) as Catalog
  if (!parsed.version || !Array.isArray(parsed.items)) throw new Error('catalog response malformed')
  catalog = parsed
  buildIndexes(parsed)
  try {
    writeFileSync(CACHE_FILE, body)
    const etag = res.headers.get('etag')
    if (etag) writeFileSync(ETAG_FILE, etag)
  } catch { /* cache write is best-effort */ }
  console.log(`[Catalog] v${parsed.version}: ${parsed.items.length} items, ${parsed.recipes.length} recipes, ${parsed.ships.length} ships, ${parsed.facilities.length} facilities`)
  // The lib's command spec and the game's data catalog version independently;
  // large drift means commands/recipes may have changed shape underneath us.
  if (!GENERATED_SPEC_VERSION.includes(parsed.version)) {
    console.warn(`[Catalog] version drift: game data v${parsed.version} vs @spacemolt/lib spec ${GENERATED_SPEC_VERSION} — check for a lib update`)
  }
}

/** Load from disk immediately (if cached), then revalidate; refresh hourly. */
export function startCatalogService(): void {
  if (existsSync(CACHE_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as Catalog
      catalog = parsed
      buildIndexes(parsed)
      console.log(`[Catalog] loaded v${parsed.version} from disk cache`)
    } catch { /* fall through to network */ }
  }
  fetchCatalog().catch((err) => console.warn(`[Catalog] initial fetch: ${err instanceof Error ? err.message : err}`))
  refreshTimer = setInterval(() => {
    fetchCatalog().catch((err) => console.warn(`[Catalog] refresh: ${err instanceof Error ? err.message : err}`))
  }, REFRESH_MS)
  // Do not hold the process open just for catalog refreshes.
  if (typeof (refreshTimer as unknown as { unref?: () => void }).unref === 'function') {
    (refreshTimer as unknown as { unref: () => void }).unref()
  }
}

export function catalogVersion(): string | null {
  return catalog?.version ?? null
}

export function getItem(id: string): CatalogItem | undefined { return itemsById.get(id) }

// --- lookup (fuzzy across all kinds, or one kind) ---

const KINDS = ['item', 'recipe', 'ship', 'facility', 'skill'] as const
type Kind = (typeof KINDS)[number]

function searchKind(kind: Kind, q: string): Array<{ id: string; name: string }> {
  const pools: Record<Kind, Array<{ id: string; name: string }>> = {
    item: catalog?.items ?? [], recipe: catalog?.recipes ?? [], ship: catalog?.ships ?? [],
    facility: catalog?.facilities ?? [], skill: catalog?.skills ?? [],
  }
  const ql = q.toLowerCase()
  const pool = pools[kind]
  const exact = pool.filter((e) => e.id === ql)
  if (exact.length) return exact
  return pool.filter((e) => e.id.includes(ql) || e.name.toLowerCase().includes(ql)).slice(0, 8)
}

function fmt(o: unknown): string {
  return JSON.stringify(o, null, 1)
}

function describe(kind: Kind, id: string): string {
  switch (kind) {
    case 'item': {
      const it = itemsById.get(id)
      if (!it) return `item ${id}: not found`
      const producers = (recipesByOutput.get(id) ?? []).map((r) => r.id)
      return `ITEM ${it.id} (${it.name}) — ${it.category}/${it.rarity}, size ${it.size}, base_value ${it.base_value} cr, tradeable ${it.tradeable}` +
        (producers.length ? `\n  crafted by: ${producers.join(', ')}` : '\n  crafted by: (no recipe — mined/looted/bought only)') +
        `\n  ${it.description}`
    }
    case 'recipe': {
      const r = recipesById.get(id)
      if (!r) return `recipe ${id}: not found`
      const ins = r.inputs.map((i) => `${i.item_id} x${i.quantity}`).join(' + ')
      const outs = r.outputs.map((o) => `${o.item_id} x${o.quantity}`).join(' + ')
      return `RECIPE ${r.id} (${r.name}) — ${r.category}\n  ${ins} → ${outs}  (time ${r.crafting_time})`
    }
    case 'ship': {
      const s = shipsById.get(id)
      if (!s) return `ship ${id}: not found`
      const mats = (s.build_materials ?? []).map((m) => `${m.item_id} x${m.quantity}`).join(', ')
      return `SHIP ${s.id} (${s.name}) — ${s.class} T${s.tier} ${s.faction}\n  hull ${s.base_hull} shield ${s.base_shield} armor ${s.base_armor} speed ${s.base_speed} cargo ${s.cargo_capacity}` +
        `\n  piloting_required ${s.piloting_required ?? '?'} shipyard_tier ${s.shipyard_tier ?? '?'}` +
        (mats ? `\n  build_materials: ${mats}` : '')
    }
    case 'facility': {
      const f = facilitiesById.get(id)
      if (!f) return `facility ${id}: not found`
      const mats = (f.build_materials ?? []).map((m) => `${m.item_id} x${m.quantity}`).join(', ')
      return `FACILITY ${f.id} (${f.name}) — ${f.category} L${f.level ?? '?'}` +
        `\n  build_cost ${f.build_cost ?? '?'} cr${mats ? `, materials: ${mats}` : ''}, build_time ${f.build_time ?? '?'}` +
        (f.recipe_id ? `\n  runs recipe: ${f.recipe_id}` : '') +
        `\n  ${f.description}`
    }
    case 'skill': {
      const s = skillsById.get(id)
      return s ? `SKILL ${s.id} (${s.name}):\n${fmt(s)}` : `skill ${id}: not found`
    }
  }
}

/** Free local lookup for the `codex` tool. */
export function codexLookup(kindArg: string | undefined, query: string): string {
  if (!catalog) return 'Codex unavailable (catalog not loaded yet — try again shortly).'
  const kinds: Kind[] = kindArg && KINDS.includes(kindArg as Kind) ? [kindArg as Kind] : [...KINDS]
  const out: string[] = []
  for (const kind of kinds) {
    const matches = searchKind(kind, query.trim())
    if (matches.length === 1) out.push(describe(kind, matches[0].id))
    else if (matches.length > 1) out.push(`${kind} matches: ${matches.map((m) => m.id).join(', ')} — call again with the exact id`)
  }
  if (!out.length) return `No codex entry matches "${query}" (game data v${catalog.version}).`
  return `[codex v${catalog.version}]\n` + out.join('\n\n')
}

/** Recursive crafting chain for the `codex_chain` tool: full input tree + aggregate raws. */
export function codexChain(itemId: string, quantity: number): string {
  if (!catalog) return 'Codex unavailable (catalog not loaded yet — try again shortly).'
  const item = itemsById.get(itemId)
  if (!item) return `Unknown item_id "${itemId}". Use codex(kind="item", query=...) to find the exact id.`
  const lines: string[] = []
  const raws = new Map<string, number>()
  const visiting = new Set<string>()

  const walk = (id: string, qty: number, depth: number): void => {
    const indent = '  '.repeat(depth)
    const recipes = recipesByOutput.get(id) ?? []
    if (!recipes.length || visiting.has(id) || depth > 6) {
      lines.push(`${indent}${id} x${qty}  [RAW — mine/loot/buy]`)
      raws.set(id, (raws.get(id) ?? 0) + qty)
      return
    }
    const r = recipes[0] // first producing recipe; alternates noted below
    const outQty = r.outputs.find((o) => o.item_id === id)?.quantity ?? 1
    const runs = Math.ceil(qty / outQty)
    const alt = recipes.length > 1 ? `  (+${recipes.length - 1} alternate recipe(s))` : ''
    lines.push(`${indent}${id} x${qty}  ← recipe ${r.id} x${runs} run(s)${alt}`)
    visiting.add(id)
    for (const input of r.inputs) walk(input.item_id, input.quantity * runs, depth + 1)
    visiting.delete(id)
  }

  walk(itemId, Math.max(1, Math.floor(quantity)), 0)
  const rawSummary = [...raws.entries()]
    .map(([id, q]) => {
      const bv = itemsById.get(id)?.base_value
      return `${id} x${q}${bv ? ` (~${(bv * q).toLocaleString()} cr at base_value)` : ''}`
    })
    .join('\n  ')
  return `[codex v${catalog.version}] crafting chain for ${itemId} x${quantity}:\n` +
    lines.join('\n') + `\n\nAGGREGATE RAW INPUTS:\n  ${rawSummary}`
}

/** Price-sanity advisory for sell listings (Phase 2). Returns null when price is unremarkable. */
export function priceAdvisory(itemId: string, priceEach: number): string | null {
  const it = itemsById.get(itemId)
  if (!it || !it.base_value || !Number.isFinite(priceEach)) return null
  const ratio = priceEach / it.base_value
  if (ratio > 3) {
    return `[codex advisory] ${itemId} listed at ${priceEach} cr = ${ratio.toFixed(1)}x catalog base_value (${it.base_value}). High listings only fill in scarce markets — verify buy-side depth or expect no fills.`
  }
  if (ratio < 1 / 3) {
    return `[codex advisory] ${itemId} listed at ${priceEach} cr = ${(ratio * 100).toFixed(0)}% of catalog base_value (${it.base_value}). You may be underpricing — check other stations before dumping.`
  }
  return null
}
