/**
 * Refresh every agent's storage_inventory at every station they hold stock in.
 *
 * storage_inventory is a ledger since 2026-09-12 (deposits, withdrawals, gifts,
 * fills and crafts apply their delta as they happen), but a `view_storage` read is
 * still the only AUTHORITATIVE figure: it reconciles the ledger, writes a
 * storage_ledger row for every item that drifted, and stamps observed_at — which
 * plan-check/ship-match/the briefing use to call a station STALE after a day.
 * Before the ledger, the table was written only by view_storage, and an agent only
 * views the station it is standing in — so a record went stale the moment they
 * left and stayed stale until they came back. On 2026-09-05 that produced four
 * wrong plans in one afternoon: CyberSpock's 50 circuit_board at War Citadel had
 * been gone for hours, Vera's 82 were actually 32, and a fury_alloy haul was
 * routed against a hull and a stock that no longer existed.
 *
 * `view_storage` accepts a station_id, so the read can be done remotely for
 * every station at once. The response's own hint names the stations holding
 * stock, which is how this discovers where to look rather than guessing.
 *
 * Free: view_storage is a query, costs no game tick and no LLM tokens.
 *
 * Usage: bun scripts/refresh-storage.ts [--quiet]
 */
const API = 'http://127.0.0.1:3031'
const QUIET = process.argv.includes('--quiet')

const post = async (id: string, body: unknown) => {
  const r = await fetch(`${API}/api/profiles/${id}/command`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  })
  return await r.json() as any
}

/** "9,326 items in storage at a, b, c" -> [a, b, c] */
function stationsFromHint(hint: unknown): string[] {
  const m = /in storage at ([^.]+)/i.exec(String(hint ?? ''))
  if (!m) return []
  return m[1].split(',').map(s => s.trim()).filter(s => /^[a-z0-9_]+$/i.test(s))
}

const profiles = await (await fetch(`${API}/api/profiles`)).json() as any[]
let refreshed = 0, agents = 0, failed = 0

for (const p of profiles.filter(x => x.enabled !== false)) {
  const name = p.name.split(' - ')[0]
  const wasIdle = !p.connected
  try {
    if (wasIdle) {
      await fetch(`${API}/api/profiles/${p.id}/connect`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'connect' }), signal: AbortSignal.timeout(180_000) })
    }
    // The first read tells us where this agent keeps things.
    const first = await post(p.id, { command: 'view_storage', silent: true })
    const sc0 = first?.structuredContent ?? first?.result ?? {}
    const stations = new Set<string>(stationsFromHint(sc0?.hint))
    if (sc0?.base_id) stations.add(String(sc0.base_id))
    if (!stations.size) { if (!QUIET) console.log(`  ${name.padEnd(17)} no storage anywhere`); continue }

    let ok = 0
    for (const st of stations) {
      const r = await post(p.id, { command: 'view_storage', args: { station_id: st }, silent: true })
      // The handler behind view_storage writes storage_inventory itself; a
      // successful call is the refresh. Count only reads the game answered.
      if (!r?.error && (r?.structuredContent?.items || r?.result?.items)) ok++
    }
    agents++; refreshed += ok
    if (!QUIET) console.log(`  ${name.padEnd(17)} ${ok}/${stations.size} stations refreshed`)
  } catch (e: any) {
    failed++
    if (!QUIET) console.log(`  ${name.padEnd(17)} FAILED: ${String(e?.message).slice(0, 60)}`)
  } finally {
    if (wasIdle) {
      await fetch(`${API}/api/profiles/${p.id}/connect`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect' }), signal: AbortSignal.timeout(120_000) }).catch(() => {})
    }
  }
}
console.log(`\n  ${refreshed} station records refreshed across ${agents} agents${failed ? `, ${failed} failed` : ''}`)
