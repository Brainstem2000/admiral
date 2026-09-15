import { Hono } from 'hono'
import { getAllPreferences, getPreference, setPreference } from '../lib/db'
import { DISPLAY_TZ_KEY, isValidTimeZone, resolveDisplayTimeZone, formatInTz } from '../lib/time'

const preferences = new Hono()

preferences.get('/', (c) => c.json(getAllPreferences()))

/**
 * The zone every timestamp should be RENDERED in.
 *
 * The database stores UTC and always will — this is a display setting, not a
 * storage one. Returns the resolved value (preference, then ADMIRAL_TZ, then
 * America/Chicago) plus `now` in that zone so a caller can sanity-check the
 * offset without doing the arithmetic itself, which is exactly where this
 * keeps going wrong.
 */
preferences.get('/timezone', (c) => {
  const stored = getPreference(DISPLAY_TZ_KEY)
  const timezone = resolveDisplayTimeZone(stored)
  const nowUtc = new Date().toISOString().slice(0, 19).replace('T', ' ')
  return c.json({
    timezone,
    source: stored ? 'preference' : (process.env.ADMIRAL_TZ ? 'ADMIRAL_TZ' : 'default'),
    now_utc: nowUtc,
    now_local: formatInTz(nowUtc, timezone),
  })
})

preferences.put('/', async (c) => {
  const { key, value } = await c.req.json()
  if (!key || typeof value !== 'string') return c.json({ error: 'Missing key or value' }, 400)
  // A bad zone name would silently fall back to Central on every read, so the
  // operator would believe a setting had taken that never did. Refuse it here.
  if (key === DISPLAY_TZ_KEY && !isValidTimeZone(value)) {
    return c.json({
      error: `Unknown time zone "${value}". Use an IANA name such as America/Chicago — `
        + `not an abbreviation like CST, which is a fixed offset and would be an hour wrong for half the year.`,
    }, 400)
  }
  setPreference(key, value)
  return c.json({ key, value })
})

export default preferences
