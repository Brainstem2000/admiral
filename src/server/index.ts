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
import analytics from './routes/analytics'
import schedules from './routes/schedules'
import { startScheduler } from './lib/scheduler'
import { pruneOldData } from './lib/db'
import { startCatalogService } from './lib/catalog'

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
app.route('/api/fleet-intel', fleetIntel)
app.route('/api/analytics', analytics)
app.route('/api/schedules', schedules)

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

// Prune aged logs/snapshots/intel on startup, then every 6 hours, so these
// tables don't grow without bound.
function runPrune() {
  try {
    const { logs, snapshots, intel, ledger } = pruneOldData()
    if (logs || snapshots || intel || ledger) {
      console.log(`[Prune] removed ${logs} log rows, ${snapshots} snapshots, ${intel} intel rows, ${ledger} ledger rows`)
    }
  } catch (err) {
    console.warn('[Prune] failed:', err)
  }
}
runPrune()
setInterval(runPrune, 6 * 60 * 60 * 1000)

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
