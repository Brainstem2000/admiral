/**
 * ship-match — which hull should this agent be flying, and can we build it?
 *
 * Run it instead of reasoning about ships from memory. It reads the live catalog,
 * the agent's actual skills, and the fleet's actual stock, and ranks hulls by what
 * they would multiply for THAT agent.
 *
 *   bun scripts/ship-match.ts              # every connected agent, top 3 hulls each
 *   bun scripts/ship-match.ts Nova         # one agent, top 8 hulls
 *   bun scripts/ship-match.ts Nova deep_survey   # full build feasibility for one hull
 *
 * Why this exists: the fleet repeatedly concluded "we have no hauler, this is
 * impossible" while a 4x-cargo hull sat on the market for ~7,400 credits, and flew a
 * Mining Laser I (mining_power 5) when Mk III is 22. Those are arithmetic mistakes,
 * so they belong in a script, not in anyone's head. See docs/ship-doctrine.md.
 */
import { Database } from 'bun:sqlite'

const CATALOG = 'https://game.spacemolt.com/api/catalog.json'
const MARKET = 'https://game.spacemolt.com/api/market'
const CACHE_DIR = 'data/.cache'

// Mining Laser III — the yardstick for "how much industry can this hull actually run".
// A slot you cannot power is not a slot.
const ML3 = { cpu: 6, power: 12, miningPower: 22 }

interface Ship {
  id: string; name: string; class: string; tier: number; shipyard_tier: number
  cargo_capacity: number; utility_slots: number; defense_slots: number; weapon_slots: number
  cpu_capacity: number; power_capacity: number; base_hull: number; base_speed: number
  inherent_capabilities?: Array<{ type: string; value: number }>
  build_materials?: Array<{ item_id: string; quantity: number }>
  default_modules?: string[]
}

async function cached(url: string, name: string): Promise<any> {
  const path = `${CACHE_DIR}/${name}`
  try {
    const f = Bun.file(path)
    if (await f.exists()) {
      const age = Date.now() - (await f.stat()).mtimeMs
      if (age < 30 * 60_000) return JSON.parse(await f.text())
    }
  } catch { /* fall through to refetch */ }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  const text = await res.text()
  await Bun.write(path, text)
  return JSON.parse(text)
}

/** The agent's skill sheet, scraped from the most recent get_status that carried one. */
function skillsFor(db: Database, profileId: string): Record<string, number> {
  // Match the SKILL SHEET specifically, not any payload that happens to mention a skill —
  // mission reward blocks contain "piloting: 25" and will otherwise win on recency.
  const row = db.query(
    `SELECT detail, summary FROM log_entries
     WHERE profile_id = ? AND (detail LIKE '%Skills (%' OR summary LIKE '%Skills (%')
     ORDER BY timestamp DESC LIMIT 1`,
  ).get(profileId) as { detail?: string; summary?: string } | null
  // Logs store the status block with escaped \n and \t, so unescape BOTH — leaving \n
  // escaped glues the newline onto the next skill name ("npiloting" instead of "piloting").
  const text = `${row?.detail ?? ''} ${row?.summary ?? ''}`.replace(/\\t/g, '\t').replace(/\\n/g, '\n')
  const out: Record<string, number> = {}
  // rendered as "skill<TAB>level<TAB>xp<TAB>next"
  for (const m of text.matchAll(/(?:^|\n)\s*([a-z_]{4,})\t(\d+)\t/g)) {
    out[m[1]] = Number(m[2])
  }
  return out
}

function capability(s: Ship, type: string): number {
  return s.inherent_capabilities?.find((c) => c?.type === type)?.value ?? 0
}

/** How many Mining Laser IIIs this hull can genuinely run — slots, CPU and power all bind. */
function lasersRunnable(s: Ship): number {
  return Math.min(
    s.utility_slots ?? 0,
    Math.floor((s.cpu_capacity ?? 0) / ML3.cpu),
    Math.floor((s.power_capacity ?? 0) / ML3.power),
  )
}

/**
 * Score a hull for one agent. Deliberately multiplicative: throughput is the product
 * of how fast you extract, how much you can carry, and the hull's own bonuses — which
 * is why a 1,900-cargo hull with zero utility slots scores worse than a 750 that mines.
 */
function score(s: Ship, skills: Record<string, number>) {
  const lasers = lasersRunnable(s)
  const oreEff = 1 + capability(s, 'ore_cargo_efficiency') / 100
  const yieldB = 1 + capability(s, 'ore_yield_bonus') / 100
  const effectiveCargo = (s.cargo_capacity ?? 0) * oreEff
  const miningPower = lasers * ML3.miningPower

  const industrial = (skills.mining ?? 0) + (skills.deep_core_mining ?? 0) + (skills.refining ?? 0)
  const commercial = (skills.trading ?? 0) + (skills.corporation_management ?? 0)
  const martial = (skills.gunnery ?? 0) + (skills.weapons ?? 0) + (skills.tactics ?? 0)

  // An agent who cannot shoot gains nothing from weapon mounts; one who mines wants lasers.
  const fit =
    miningPower * yieldB * Math.max(1, industrial) +
    effectiveCargo * Math.max(1, commercial) / 10 +
    (s.weapon_slots ?? 0) * martial * 5

  return { lasers, miningPower, effectiveCargo, oreEff, yieldB, fit }
}

async function main() {
  const [who, hull] = process.argv.slice(2)
  const cat = await cached(CATALOG, 'catalog.json')
  const db = new Database('data/admiral.db', { readonly: true })
  const profiles = db.query('SELECT id, name FROM profiles').all() as Array<{ id: string; name: string }>
  const targets = who ? profiles.filter((p) => p.name.toLowerCase().startsWith(who.toLowerCase())) : profiles
  if (!targets.length) {
    console.log(`no agent matching "${who}". Known: ${profiles.map((p) => p.name.split(' ')[0]).join(', ')}`)
    return
  }

  const ships: Ship[] = cat.ships
  const heldQ = db.query('SELECT SUM(quantity) q FROM storage_inventory WHERE item_id = ?')

  if (hull) {
    const s = ships.find((x) => x.id === hull)
    if (!s) return console.log(`no hull "${hull}"`)
    const mkt = await cached(MARKET, 'market.json')
    const ask: Record<string, { p: number; q: number }> = {}
    for (const i of mkt.items) {
      if (i.best_ask > 0 && (!ask[i.item_id] || i.best_ask < ask[i.item_id].p)) {
        ask[i.item_id] = { p: i.best_ask, q: i.ask_quantity_at_best }
      }
    }
    console.log(`=== ${s.name} — build feasibility (needs shipyard tier ${s.shipyard_tier}) ===`)
    let buy = 0
    const craft: string[] = []
    for (const m of s.build_materials ?? []) {
      const have = (heldQ.get(m.item_id) as { q: number } | null)?.q ?? 0
      const short = Math.max(0, m.quantity - have)
      const a = ask[m.item_id]
      let note = 'fleet has it'
      if (short > 0) {
        if (a) { buy += short * a.p; note = `buy ${short} @${a.p} = ${(short * a.p).toLocaleString()} (ask depth ${a.q})` }
        else { craft.push(`${m.item_id} x${short}`); note = 'NO MARKET ASK — must craft' }
      }
      console.log(`  ${short === 0 ? '[x]' : '[ ]'} ${m.item_id.padEnd(24)} need ${String(m.quantity).padStart(4)}  fleet ${String(have).padStart(6)}   ${note}`)
    }
    console.log(`  --- purchasable gap ~${Math.round(buy).toLocaleString()}`)
    if (craft.length) console.log(`  must craft: ${craft.join(', ')}`)
    return
  }

  for (const p of targets) {
    const skills = skillsFor(db, p.id)
    if (!Object.keys(skills).length) { console.log(`\n### ${p.name} — no skill sheet in retained logs, skipping`); continue }
    const top = Object.entries(skills).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(' · ')
    console.log(`\n### ${p.name}\n  skills: ${top}`)

    const ranked = ships
      .filter((s) => (s.cargo_capacity ?? 0) > 0)
      .map((s) => ({ s, ...score(s, skills) }))
      .sort((a, b) => b.fit - a.fit)

    // The best hull we can BUILD beats the best hull that exists. Highest shipyard we
    // hold is tier 5 (War Citadel), but tier-4 yards need materials the fleet has never
    // seen — so flag reachability rather than ranking fantasy hulls first.
    const REACHABLE_YARD = Number(process.env.YARD_TIER ?? 2)
    const limit = who ? 8 : 3
    const show = (list: typeof ranked, label: string) => {
      if (!list.length) return
      console.log(`  ${label}`)
      console.log(`  ${'HULL'.padEnd(20)}${'cargo'.padStart(7)}${'oreCargo'.padStart(9)}${'ML3'.padStart(5)}${'minePwr'.padStart(8)}${'hull'.padStart(6)}${'yard'.padStart(5)}   why`)
      for (const r of list) {
        const why = [
          capability(r.s, 'ore_yield_bonus') ? `+${capability(r.s, 'ore_yield_bonus')}% yield` : '',
          capability(r.s, 'ore_cargo_efficiency') ? `+${capability(r.s, 'ore_cargo_efficiency')}% ore eff` : '',
          r.lasers === 0 ? 'CANNOT MINE — no usable utility slot' : '',
        ].filter(Boolean).join(', ')
        console.log(`  ${r.s.id.slice(0, 19).padEnd(20)}${String(r.s.cargo_capacity).padStart(7)}${String(Math.round(r.effectiveCargo)).padStart(9)}${String(r.lasers).padStart(5)}${String(r.miningPower).padStart(8)}${String(r.s.base_hull).padStart(6)}${String(r.s.shipyard_tier).padStart(5)}   ${why}`)
      }
    }
    show(ranked.filter((r) => (r.s.shipyard_tier ?? 0) <= REACHABLE_YARD).slice(0, limit),
      `BUILDABLE NOW (shipyard tier <= ${REACHABLE_YARD}; override with YARD_TIER=n)`)
    show(ranked.filter((r) => (r.s.shipyard_tier ?? 0) > REACHABLE_YARD).slice(0, 3),
      'ASPIRATIONAL (needs a higher-tier yard than we can currently supply)')
  }
  console.log('\n(build feasibility: bun scripts/ship-match.ts <agent> <hull_id>)')
}

main()
