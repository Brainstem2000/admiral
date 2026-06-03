import { getProvider, upsertProvider } from './db'
import { isClaudeMaxAvailable, getClaudeMaxInfo } from './claude-max-auth'

const LOCALHOST = '127.0.0.1'

interface DetectResult {
  id: string
  status: 'valid' | 'unreachable'
  baseUrl: string
}

const DEFAULT_URLS: Record<string, string> = {
  ollama: `http://${LOCALHOST}:11434`,
  lmstudio: `http://${LOCALHOST}:1234`,
}

/**
 * Detect local LLM providers (Ollama, LM Studio).
 * Accepts optional custom URLs to override defaults (e.g. when running in a VM).
 */
export async function detectLocalProviders(customUrls?: Record<string, string>): Promise<DetectResult[]> {
  const results: DetectResult[] = []

  // Check Ollama
  const ollamaUrl = customUrls?.ollama || getProvider('ollama')?.base_url?.replace(/\/v1\/?$/, '') || DEFAULT_URLS.ollama
  try {
    const resp = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (resp.ok) {
      const existing = getProvider('ollama')
      const baseUrl = `${ollamaUrl}/v1`
      upsertProvider('ollama', existing?.api_key || '', baseUrl, 'valid')
      results.push({ id: 'ollama', status: 'valid', baseUrl })
    } else {
      results.push({ id: 'ollama', status: 'unreachable', baseUrl: `${ollamaUrl}/v1` })
    }
  } catch {
    results.push({ id: 'ollama', status: 'unreachable', baseUrl: `${ollamaUrl}/v1` })
  }

  // Check LM Studio
  const lmStudioUrl = customUrls?.lmstudio || getProvider('lmstudio')?.base_url?.replace(/\/v1\/?$/, '') || DEFAULT_URLS.lmstudio
  try {
    const resp = await fetch(`${lmStudioUrl}/v1/models`, { signal: AbortSignal.timeout(3000) })
    if (resp.ok) {
      const existing = getProvider('lmstudio')
      const baseUrl = `${lmStudioUrl}/v1`
      upsertProvider('lmstudio', existing?.api_key || '', baseUrl, 'valid')
      results.push({ id: 'lmstudio', status: 'valid', baseUrl })
    } else {
      results.push({ id: 'lmstudio', status: 'unreachable', baseUrl: `${lmStudioUrl}/v1` })
    }
  } catch {
    results.push({ id: 'lmstudio', status: 'unreachable', baseUrl: `${lmStudioUrl}/v1` })
  }

  // Check Claude MAX (local OAuth credentials from Claude Code)
  if (isClaudeMaxAvailable()) {
    const info = getClaudeMaxInfo()
    upsertProvider('claude-max', 'oauth', '', 'valid')
    results.push({ id: 'claude-max', status: 'valid', baseUrl: `Claude MAX (${info.subscriptionType || 'subscription'})` })
  } else {
    results.push({ id: 'claude-max', status: 'unreachable', baseUrl: 'No Claude Code credentials found' })
  }

  return results
}

export type KeyValidationStatus = 'valid' | 'invalid' | 'unknown'

/**
 * Classify an HTTP response from a key-check call:
 *  - 401/403  -> the key was rejected -> invalid
 *  - 200/400  -> the request was authenticated and processed -> valid
 *               (400 = our throwaway probe body was malformed, but auth passed)
 *  - anything else (5xx, 429, etc.) -> the key wasn't actually judged -> unknown
 */
function classifyStatus(status: number): KeyValidationStatus {
  if (status === 401 || status === 403) return 'invalid'
  if (status === 200 || status === 400) return 'valid'
  return 'unknown'
}

/**
 * Validate a cloud API key by making a lightweight API call. Returns a
 * tri-state: a server/network error (5xx, timeout, rate limit) yields 'unknown'
 * rather than mislabeling the key as valid or invalid.
 */
export async function validateApiKey(provider: string, apiKey: string): Promise<KeyValidationStatus> {
  try {
    switch (provider) {
      case 'anthropic': {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
          signal: AbortSignal.timeout(10000),
        })
        return classifyStatus(resp.status)
      }
      case 'openai': {
        const resp = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10000),
        })
        return resp.ok ? 'valid' : classifyStatus(resp.status)
      }
      case 'groq': {
        const resp = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10000),
        })
        return resp.ok ? 'valid' : classifyStatus(resp.status)
      }
      case 'openrouter': {
        const resp = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10000),
        })
        return resp.ok ? 'valid' : classifyStatus(resp.status)
      }
      case 'minimax': {
        const resp = await fetch('https://api.minimax.io/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'MiniMax-M2.5-highspeed',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
          signal: AbortSignal.timeout(10000),
        })
        return classifyStatus(resp.status)
      }
      case 'nvidia': {
        const resp = await fetch('https://integrate.api.nvidia.com/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10000),
        })
        return resp.ok ? 'valid' : classifyStatus(resp.status)
      }
      case 'claude-max':
        // Claude MAX uses OAuth tokens from local Claude Code installation
        return isClaudeMaxAvailable() ? 'valid' : 'invalid'
      default:
        // For unknown providers, assume valid if non-empty (can't probe).
        return apiKey.length > 0 ? 'valid' : 'invalid'
    }
  } catch {
    // Network error / timeout — we couldn't determine the key's validity.
    return 'unknown'
  }
}
