// Kill watcher (long window) — covers the Broadaxe build + hunt. Fires on pirates_destroyed/ships_destroyed increment.
const API = 'http://127.0.0.1:3031'
const ID = 'a9e3b41a-ed67-4891-b847-eb5a806fffb2'
const DEADLINE = Date.now() + 55 * 60 * 1000
const POLL_MS = 75_000
async function stats() {
  try {
    const r = await fetch(`${API}/api/profiles/${ID}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'get_status', silent: true }) })
    return ((await r.json()) as any)?.result?.player?.stats ?? null
  } catch { return null }
}
let base: any = null
for (let i = 0; i < 5 && !base; i++) { base = await stats(); if (!base) await Bun.sleep(3000) }
if (!base) { console.log('Could not read baseline; Morg offline.'); process.exit(0) }
const b = { p: base.pirates_destroyed ?? 0, s: base.ships_destroyed ?? 0, n: base.npcs_destroyed ?? 0 }
console.log(`Baseline pirates:${b.p} ships:${b.s} npcs:${b.n}`)
let found = false
while (Date.now() < DEADLINE) {
  await Bun.sleep(POLL_MS)
  const s = await stats(); if (!s) continue
  const c = { p: s.pirates_destroyed ?? 0, s: s.ships_destroyed ?? 0, n: s.npcs_destroyed ?? 0 }
  if (c.p > b.p || c.s > b.s || c.n > b.n) {
    console.log(`💀 KILL — Morg destroyed +${c.p - b.p} pirate(s) +${c.s - b.s} ship(s) +${c.n - b.n} npc(s)! (now pirates:${c.p} ships:${c.s}, ship_class active)`)
    found = true; break
  }
}
if (!found) { const s = await stats(); console.log(`No kill in 55 min. pirates:${s?.pirates_destroyed} ships:${s?.ships_destroyed} lost:${s?.ships_lost} fled:${s?.battles_fled}`) }
