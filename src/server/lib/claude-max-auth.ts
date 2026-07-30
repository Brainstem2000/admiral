/**
 * Claude MAX OAuth token management.
 * Reads tokens from Claude Code's local credential storage (~/.claude/.credentials.json)
 * and handles automatic refresh when expired.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json')
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const CLIENT_ID = atob('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl')

interface ClaudeOAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  subscriptionType: string
  rateLimitTier: string
}

interface CredentialsFile {
  claudeAiOauth: ClaudeOAuthCredentials
}

let cachedCredentials: ClaudeOAuthCredentials | null = null
let refreshInFlight: Promise<ClaudeOAuthCredentials> | null = null

function readCredentialsFile(): CredentialsFile | null {
  const main = readCredentialsAt(CREDENTIALS_PATH)
  // Self-heal: a failed atomic rename (see writeCredentialsFile) can leave the
  // freshest credentials stranded in a `.credentials.json.<pid>.tmp` next to a
  // stale main file whose refresh token has already been rotated server-side.
  // If any orphaned tmp holds a newer token, prefer it and promote it back.
  const orphan = newestOrphanTmp()
  if (orphan && (!main || orphan.creds.claudeAiOauth.expiresAt > main.claudeAiOauth.expiresAt)) {
    try {
      fs.copyFileSync(orphan.path, CREDENTIALS_PATH)
      fs.unlinkSync(orphan.path)
      console.warn(`[claude-max-auth] promoted orphaned credential tmp ${path.basename(orphan.path)} over stale main file`)
    } catch (err) {
      console.warn(`[claude-max-auth] could not promote orphaned tmp (using it in-memory): ${err}`)
    }
    return orphan.creds
  }
  return main
}

function readCredentialsAt(p: string): CredentialsFile | null {
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    const data = JSON.parse(raw) as CredentialsFile
    if (data?.claudeAiOauth?.accessToken && data?.claudeAiOauth?.refreshToken) {
      return data
    }
    return null
  } catch {
    return null
  }
}

function newestOrphanTmp(): { path: string; creds: CredentialsFile } | null {
  try {
    const dir = path.dirname(CREDENTIALS_PATH)
    const base = path.basename(CREDENTIALS_PATH)
    let best: { path: string; creds: CredentialsFile } | null = null
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(base + '.') || !name.endsWith('.tmp')) continue
      const p = path.join(dir, name)
      const creds = readCredentialsAt(p)
      if (!creds) continue
      if (!best || creds.claudeAiOauth.expiresAt > best.creds.claudeAiOauth.expiresAt) {
        best = { path: p, creds }
      }
    }
    return best
  } catch {
    return null
  }
}

function writeCredentialsFile(creds: ClaudeOAuthCredentials): void {
  const tmp = `${CREDENTIALS_PATH}.${process.pid}.tmp`
  try {
    const existing = readCredentialsAt(CREDENTIALS_PATH) || ({ claudeAiOauth: {} } as CredentialsFile)
    existing.claudeAiOauth = creds
    // Write to a temp file first so a crash mid-write can't corrupt Claude
    // Code's real credential file (owner-only perms — refresh token inside).
    fs.writeFileSync(tmp, JSON.stringify(existing), { encoding: 'utf-8', mode: 0o600 })
    try {
      fs.renameSync(tmp, CREDENTIALS_PATH)
    } catch {
      // On Windows the rename can fail with EPERM if another process (Claude
      // Code itself) has the destination open. Losing this write is NOT
      // acceptable: the refresh token was already rotated server-side, so a
      // stranded tmp means every future refresh gets invalid_grant (fleet-wide
      // outage 2026-07-24). Fall back to copy + delete.
      fs.copyFileSync(tmp, CREDENTIALS_PATH)
      fs.unlinkSync(tmp)
    }
  } catch (err) {
    // Last resort: leave the tmp in place (readCredentialsFile self-heals from
    // it) but SAY SO — silently swallowing this is what hid the outage.
    console.error(`[claude-max-auth] FAILED to persist refreshed credentials (tmp left at ${tmp}): ${err}`)
  }
}

async function refreshToken(refreshToken: string): Promise<ClaudeOAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Claude MAX token refresh failed: ${error}`)
  }

  const data = await response.json() as {
    access_token: string
    refresh_token: string
    expires_in: number
  }

  const updated: ClaudeOAuthCredentials = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    scopes: cachedCredentials?.scopes || ['user:inference'],
    subscriptionType: cachedCredentials?.subscriptionType || 'max',
    rateLimitTier: cachedCredentials?.rateLimitTier || 'default_claude_max_20x',
  }

  // Persist refreshed token back to disk so Claude Code stays in sync
  writeCredentialsFile(updated)
  cachedCredentials = updated

  return updated
}

/**
 * Check if Claude MAX credentials are available on this machine.
 */
export function isClaudeMaxAvailable(): boolean {
  const file = readCredentialsFile()
  return file !== null
}

/**
 * Get a valid Claude MAX OAuth access token.
 * Reads from ~/.claude/.credentials.json, refreshes if expired.
 * The returned token starts with "sk-ant-oat" which pi-ai auto-detects
 * for Bearer auth + Claude Code headers.
 */
export async function getClaudeMaxToken(): Promise<string> {
  // Re-read from disk each time so we pick up tokens refreshed by Claude Code
  const file = readCredentialsFile()
  if (!file) {
    throw new Error(
      'Claude MAX credentials not found. Run "claude auth login" in your terminal first.'
    )
  }

  // Use disk version if it has a newer/valid token (e.g., refreshed by Claude Code)
  const diskCreds = file.claudeAiOauth
  const now = Date.now()

  if (diskCreds.expiresAt > now + 60_000) {
    cachedCredentials = diskCreds
    return diskCreds.accessToken
  }

  // Token expired — refresh, but deduplicate concurrent requests
  if (refreshInFlight) {
    const result = await refreshInFlight
    return result.accessToken
  }

  const refreshTokenValue = diskCreds.refreshToken
  refreshInFlight = refreshToken(refreshTokenValue).finally(() => {
    refreshInFlight = null
  })

  try {
    cachedCredentials = await refreshInFlight
    return cachedCredentials.accessToken
  } catch (err) {
    // If refresh fails, try re-reading disk in case another process refreshed
    const retry = readCredentialsFile()
    if (retry && retry.claudeAiOauth.expiresAt > Date.now() + 60_000) {
      cachedCredentials = retry.claudeAiOauth
      return cachedCredentials.accessToken
    }
    throw err
  }
}

/**
 * Get subscription info for display purposes.
 */
export function getClaudeMaxInfo(): { available: boolean; subscriptionType?: string; rateLimitTier?: string } {
  const file = readCredentialsFile()
  if (!file) return { available: false }
  return {
    available: true,
    subscriptionType: file.claudeAiOauth.subscriptionType,
    rateLimitTier: file.claudeAiOauth.rateLimitTier,
  }
}
