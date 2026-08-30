import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { existsSync } from 'fs'
import { join } from 'path'
import profiles from './routes/profiles'
import logs from './routes/logs'
import providers from './routes/providers'
import models from './routes/models'
import commands from './routes/commands'
import preferences from './routes/preferences'
import galaxy from './routes/galaxy'
import fleetIntel from './routes/fleet-intel'
import inventory from './routes/inventory'
import combat from './routes/combat'
import playbook from './routes/playbook'
import analytics from './routes/analytics'
import schedules from './routes/schedules'
import codexRoutes from './routes/codex'
import factionRoutes from './routes/faction'
import { startScheduler } from './lib/scheduler'
import { pruneOldData, backfillSystemsFromStations } from './lib/db'
import { startCatalogService } from './lib/catalog'
import { startGalaxyMarketCollector } from './lib/galaxy-market'
import { startGalaxyMapRefresher } from './lib/galaxy-refresh'

// Admiral manages long-running agent connections; a single escaped error must
// never kill the whole process. Known case: @spacemolt/lib rejects/throws
// ConnectionClosedError (ws code 1006) from its close handler when the GAME
// server restarts — e.g. the v0.533.0 update killed admiral.exe with three of
// these. The lib's auto-reconnect recovers the sessions on its own; the only
// correct process-level response is to log and keep serving.
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
  console.error(`[unhandledRejection] ${msg}`)
})
process.on('uncaughtException', (err) => {
  console.error(`[uncaughtException] ${err?.name ?? 'Error'}: ${err?.message ?? err}`)
})

const app = new Hono()

// CORS is restricted to same-origin and localhost only. Admiral stores plaintext
// secrets (SpaceMolt passwords, LLM API keys), so we must not let arbitrary
// websites issue cross-origin requests to the local API. Same-origin requests
// (the bundled UI) send no Origin header and are always allowed.
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return '*' // same-origin / non-browser clients
    try {
      const host = new URL(origin).hostname
      return (host === 'localhost' || host === '127.0.0.1' || host === '::1') ? origin : null
    } catch {
      return null
    }
  },
}))

// API routes
app.route('/api/profiles', profiles)
app.route('/api/profiles', logs)      // logs routes include /:id/logs
app.route('/api/providers', providers)
app.route('/api/models', models)
app.route('/api/commands', commands)
app.route('/api/preferences', preferences)
app.route('/api/galaxy', galaxy)
app.route('/api/combat', combat)
app.route('/api/playbook', playbook)
app.route('/api/fleet-intel', fleetIntel)
app.route('/api/inventory', inventory)
app.route('/api/analytics', analytics)
app.route('/api/schedules', schedules)
app.route('/api/codex', codexRoutes)
app.route('/api/faction', factionRoutes)

// Health check
app.get('/api/health', (c) => c.json({ ok: true }))

// Static file serving (production) or dev proxy
// Detect production by checking for dist/ directory alongside the binary/entrypoint.
// This is more reliable than NODE_ENV because `bun build --compile` may inline
// process.env.NODE_ENV at compile time, making it unreliable at runtime.
const distDir = join(import.meta.dir, 'dist')
const hasDistDir = existsSync(distDir) || existsSync('./dist/index.html')
const isDev = !hasDistDir && process.env.NODE_ENV !== 'production'

if (isDev) {
  // Proxy non-API requests to Vite dev server
  app.all('*', async (c) => {
    try {
      const url = new URL(c.req.url)
      url.port = '3030'
      const resp = await fetch(url.toString(), {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
      })
      return new Response(resp.body, {
        status: resp.status,
        headers: resp.headers,
      })
    } catch {
      return c.text('Vite dev server not running. Start it with: bun run dev:frontend', 502)
    }
  })
} else {
  // Serve static files from dist/
  // Assets use content-hashed filenames so they can be cached forever.
  // index.html must never be cached so the browser always picks up new asset hashes.
  app.use('/*', async (c, next) => {
    await next()
    if (c.req.path === '/' || c.req.path.endsWith('.html')) {
      c.header('Cache-Control', 'no-cache, no-store, must-revalidate')
    }
  })
  app.use('/*', serveStatic({ root: './dist' }))
  // SPA fallback
  app.get('*', serveStatic({ path: './dist/index.html' }))
}

// Start cron scheduler
startScheduler()
startCatalogService()

// Galaxy-wide market feed relay (agents cannot fetch HTTP; briefings can).
startGalaxyMarketCollector()

// Keep the Map page's galaxy snapshot tracking discoveries (explorer-preferred).
startGalaxyMapRefresher()

// Fill station presence + services for every system from the free public endpoint
// (zero agent turns; only-fill, never overwrites gameplay observations).
backfillSystemsFromStations()
  .then(n => { if (n > 0) console.log(`[Intel] stations backfill touched ${n} systems`) })
  .catch(err => console.warn('[Intel] stations backfill failed:', err?.message ?? err))

// Prune aged logs/snapshots/intel on startup, then every 6 hours, so these
// tables don't grow without bound.
function runPrune() {
  try {
    const { logs, snapshots, intel, ledger, events, history } = pruneOldData()
    if (logs || snapshots || intel || ledger || events || history) {
      console.log(`[Prune] removed ${logs} log rows, ${snapshots} snapshots, ${intel} intel rows, ${ledger} ledger rows, ${events} events, ${history} state-history rows`)
    }
  } catch (err) {
    console.warn('[Prune] failed:', err)
  }
}
runPrune()
setInterval(runPrune, 6 * 60 * 60 * 1000)

// Offline wallet refresher: rent and taxes bill server-side while agents are
// disconnected, so a wallet frozen at disconnect time drifts from the truth within
// minutes (observed: a card showing 278c while the game said 17c). Every 20 minutes,
// briefly game-connect each credentialed, disconnected profile — NO LLM loop — read
// the live balance into the snapshot stream, and disconnect. Serial with gaps so a
// 12-profile fleet never hammers the login endpoint.
async function refreshOfflineWallets() {
  const { listProfiles: lp, addFinancialSnapshot, getDb } = await import('./lib/db')
  // Imported here rather than top-level: index.ts otherwise never references the
  // agent manager, and the original omission made every sweep iteration throw the
  // same ReferenceError into its per-profile catch — a silent total failure.
  const { agentManager } = await import('./lib/agent-manager')
  const db = getDb()
  for (const p of lp()) {
    try {
      if (!p.username || !p.password) continue
      if (agentManager.getAgent(p.id)?.isConnected) continue
      await agentManager.connect(p.id)
      const gs = agentManager.getStatus(p.id).gameState as Record<string, unknown> | null
      const credits = Number(gs?.credits)
      if (Number.isFinite(credits)) {
        // Carry the last-known storage value forward — this sweep learns nothing about
        // storage, and writing 0 would corrupt the wealth-over-time series.
        const prev = db.query('SELECT storage FROM financial_snapshots WHERE profile_id = ? ORDER BY id DESC LIMIT 1')
          .get(p.id) as { storage: number } | undefined
        addFinancialSnapshot(p.id, credits, prev?.storage ?? 0)
      }
      // While connected anyway, refresh the durable character sheet: position/ship into
      // profile_last_state, and list_ships/get_ship through the agent's command path so
      // the capture hooks re-sync the ship registry and module manifest. All silent —
      // no LLM is involved and nothing lands in the agent's context.
      try {
        const { upsertProfileLastState } = await import('./lib/db')
        const agent = agentManager.getAgent(p.id)
        let shipClass = '', shipName = '', hull = '', fuel = '', cargo = ''
        if (agent) {
          try {
            const ls = await agent.executeCommand('list_ships', {}, { silent: true }) as Record<string, unknown>
            const ships = (ls?.structuredContent as Record<string, unknown> | undefined)?.ships as Array<Record<string, unknown>> | undefined
            const active = ships?.find((sh) => sh.is_active)
            if (active) {
              shipClass = String(active.class_id ?? '')
              shipName = String(active.class_name ?? '')
              hull = String(active.hull ?? '')
              fuel = String(active.fuel ?? '')
            }
            await agent.executeCommand('get_ship', {}, { silent: true })
          } catch { /* enrichment optional */ }
        }
        upsertProfileLastState(p.id, {
          system: String(gs?.system ?? ''), poi: String(gs?.poi ?? ''),
          ship_class: shipClass, ship_name: shipName, hull, fuel, cargo,
          credits: Number.isFinite(credits) ? credits : 0,
        })
      } catch { /* state sheet is best-effort */ }
      await agentManager.disconnect(p.id)
      await new Promise((r) => setTimeout(r, 2500))
    } catch { /* one profile failing must not stop the sweep */ }
  }
}
setTimeout(refreshOfflineWallets, 60 * 1000) // first pass shortly after boot
setInterval(refreshOfflineWallets, 20 * 60 * 1000)

// Connected-agent snapshot writer: the offline sweep above skips connected
// profiles, so their profile_last_state froze at whatever the last sweep saw
// before they connected (observed 36h stale). Every 2 minutes, copy each
// connected agent's in-memory gameState — no game round-trip — into the
// durable sheet, so the fleet map, offline fallbacks, and post-disconnect
// cards inherit a current wallet instead of a fossil.
async function snapshotConnectedState() {
  const { listProfiles: lp, upsertProfileLastState } = await import('./lib/db')
  const { agentManager } = await import('./lib/agent-manager')
  for (const p of lp()) {
    try {
      const agent = agentManager.getAgent(p.id)
      if (!agent?.isConnected) continue
      const gs = agent.gameState as Record<string, unknown> | null
      if (!gs) continue
      // get_status shape nests under player/location/ship; slim states put
      // system/poi/credits at the top level. Accept either.
      const player = gs.player as Record<string, unknown> | undefined
      const loc = gs.location as Record<string, unknown> | undefined
      const ship = gs.ship as Record<string, unknown> | undefined
      const credits = Number(player?.credits ?? gs.credits)
      const system = String(loc?.system_name ?? loc?.system_id ?? gs.system ?? '')
      const poi = String(loc?.poi_name ?? loc?.docked_at ?? loc?.poi_id ?? gs.poi ?? '')
      if (!Number.isFinite(credits) || !system) continue
      upsertProfileLastState(p.id, {
        system, poi,
        ship_class: String(ship?.class_id ?? ship?.ship_class ?? ''),
        ship_name: String(ship?.class_name ?? ship?.name ?? ''),
        hull: String(ship?.hull ?? ''),
        fuel: String(ship?.fuel ?? ''),
        cargo: '',
        credits,
      })
    } catch { /* one profile failing must not stop the sweep */ }
  }
}
setInterval(snapshotConnectedState, 2 * 60 * 1000)

const port = parseInt(process.env.PORT || '3031')
// Bind to loopback by default so the API (which serves plaintext secrets) is not
// exposed to the LAN. Set ADMIRAL_HOST=0.0.0.0 to intentionally expose it.
const hostname = process.env.ADMIRAL_HOST || '127.0.0.1'
console.log(`Admiral listening on http://${hostname}:${port}`)
if (hostname === '0.0.0.0') {
  console.warn('WARNING: ADMIRAL_HOST=0.0.0.0 exposes Admiral (and stored credentials) to your network. Ensure the network is trusted.')
}

export default {
  port,
  hostname,
  fetch: app.fetch,
  idleTimeout: 120, // seconds; must exceed SSE heartbeat interval for log streaming
}
