import { Hono } from 'hono'
import { listProviders, getProvider, upsertProvider } from '../lib/db'
import { validateApiKey, detectLocalProviders } from '../lib/providers'

const providers = new Hono()

// Never send raw API keys to the client. Expose has_key so the UI can show that
// a key is stored without leaking it.
function sanitizeProvider(p: { id: string; api_key: string; base_url: string; status: string }) {
  const { api_key, ...rest } = p
  return { ...rest, api_key: '', has_key: !!api_key }
}

providers.get('/', (c) => c.json(listProviders().map(sanitizeProvider)))

providers.put('/', async (c) => {
  const { id, api_key, base_url } = await c.req.json()
  if (!id) return c.json({ error: 'Missing provider id' }, 400)

  const existing = getProvider(id)

  // Reject non-http(s) base URLs. The custom/local provider flow fetches this URL
  // with the stored API key attached, so an unvalidated value is an SSRF /
  // key-exfiltration vector.
  if (base_url) {
    let scheme: string
    try { scheme = new URL(base_url).protocol } catch { return c.json({ error: 'Invalid base_url' }, 400) }
    if (scheme !== 'http:' && scheme !== 'https:') return c.json({ error: 'base_url must be http(s)' }, 400)
  }

  // An empty api_key means "keep the existing key" rather than wipe it — the UI
  // never receives the stored key, so it cannot echo it back on save.
  const effectiveKey = (api_key && api_key.length > 0) ? api_key : (existing?.api_key || '')

  let status = 'unknown'
  if ((id === 'custom' || id === 'ollama' || id === 'lmstudio') && base_url) {
    try {
      const modelsUrl = id === 'ollama'
        ? base_url.replace(/\/v1\/?$/, '') + '/api/tags'
        : base_url.replace(/\/+$/, '') + '/models'
      const headers: Record<string, string> = {}
      if (effectiveKey) headers['Authorization'] = `Bearer ${effectiveKey}`
      const resp = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(5000) })
      status = resp.ok ? 'valid' : 'unreachable'
    } catch { status = 'unreachable' }
  } else if (effectiveKey) {
    status = (await validateApiKey(id, effectiveKey)) ? 'valid' : 'invalid'
  }

  upsertProvider(id, effectiveKey, base_url || '', status)
  return c.json({ id, status, has_key: !!effectiveKey })
})

providers.post('/detect', async (c) => {
  let customUrls: Record<string, string> = {}
  try { const body = await c.req.json(); customUrls = body?.urls || {} } catch {}
  return c.json(await detectLocalProviders(customUrls))
})

export default providers
