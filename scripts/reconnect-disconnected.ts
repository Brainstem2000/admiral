/**
 * reconnect-disconnected — bring back agents whose GAME connection died while
 * their LLM loop kept running.
 *
 *   bun scripts/reconnect-disconnected.ts     # then run the wake pass
 *
 * `running` (the LLM loop) and `connected` (the game session) are INDEPENDENT,
 * and that gap is invisible to any watcher tracking only the running set. On
 * 2026-09-06 at 08:53:57 a one-second game-side auth blip knocked out ten
 * agents at once — every one logged "Login failed: Invalid username or
 * password" inside the same second, which is a server event and not a
 * credential problem. Their loops auto-restarted and reported running:true
 * while nine had no game session at all, so they burned turns blind and the
 * fleet watch said nothing for fifteen minutes.
 *
 * Two details that matter: the disconnect before the connect is load-bearing,
 * because a half-open session refuses a fresh connect; and reconnecting stops
 * the LLM loop, so follow this with the wake pass or the agents sit connected
 * and idle.
 */
const API = 'http://127.0.0.1:3031'
const profiles = await (await fetch(`${API}/api/profiles`)).json() as any[]
// The gap: recon-all only wakes !running. After a game-side auth blip the LLM
// loop keeps RUNNING while the game connection is dead — the agent burns turns
// blind. Target connected===false regardless of running.
const dead = profiles.filter(p => p.enabled && !p.connected)
console.log(`reconnecting ${dead.length}: ${dead.map(p => p.name.split(' - ')[0]).join(', ')}\n`)
for (const p of dead) {
  let st: any = p
  for (let a = 1; a <= 3 && !st.connected; a++) {
    try {
      // Disconnect first: a half-open session refuses a fresh connect.
      await fetch(`${API}/api/profiles/${p.id}/connect`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect' }), signal: AbortSignal.timeout(60_000),
      }).catch(() => {})
      const r = await fetch(`${API}/api/profiles/${p.id}/connect`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'connect_llm' }), signal: AbortSignal.timeout(240_000),
      })
      st = await r.json()
    } catch (e) { st = { connected: false, err: String(e).slice(0, 50) } }
    if (!st.connected) await new Promise(r2 => setTimeout(r2, 5000))
  }
  const g = st.gameState ?? {}
  console.log(`  ${p.name.split(' - ')[0].padEnd(16)} connected=${st.connected} running=${st.running}  ${g.system ?? '?'} ${st.err ?? ''}`)
}
