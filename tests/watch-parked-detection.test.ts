import { describe, expect, test } from 'bun:test'

/**
 * The watch's PARKED set was a hardcoded default — 'CyberSpock - Smuggler,CyberSapper - Smuggler',
 * two names frozen in from some earlier session. By 2026-09-17 both were flying active missions,
 * so the watch was BLIND to the fleet's two smugglers while crying "NOT RUNNING" every single tick
 * about Zibal, who had just been safe-docked on purpose. Exactly inverted.
 *
 * CLAUDE.md is explicit about why that matters: "a watcher that cries wolf gets turned off, which
 * is strictly worse than no watcher."
 *
 * Parked-ness is now derived from the server. safe-dock stops the loop AND clears autoconnect;
 * a crash or a server restart leaves autoconnect SET, because the fleet is still trying to bring
 * that agent back. So "not running and not trying to" is the honest signal for intent.
 */
const SRC = await Bun.file('scripts/watch-tick.ts').text()
const parked = (p: { running?: boolean; autoconnect?: boolean }) => !p.running && !p.autoconnect

describe('the watch distinguishes parked from crashed', () => {
  test('a safe-docked agent is parked', () => {
    expect(parked({ running: false, autoconnect: false })).toBe(true)
  })

  test('a CRASHED agent is not parked — autoconnect is still trying', () => {
    expect(parked({ running: false, autoconnect: true })).toBe(false)
  })

  test('a working agent is never parked, with autoconnect either way', () => {
    expect(parked({ running: true, autoconnect: true })).toBe(false)
    // Grit ran with autoconnect false on 2026-09-17 after a manual connect.
    expect(parked({ running: true, autoconnect: false })).toBe(false)
  })

  test('the hardcoded name default is gone', () => {
    expect(SRC).not.toContain("?? 'CyberSpock - Smuggler,CyberSapper - Smuggler'")
    expect(SRC).toContain("process.env.WATCH_PARKED ?? ''")
  })

  test('BOTH checks honour it — silence and liveness — from one roster read', () => {
    // The silence check ran off the DB alone, so a parked agent went quiet and then tripped
    // "SILENT: no log line" from the other direction.
    expect(SRC).toContain('const quiet =')
    expect(SRC).toContain('if (quiet(r.name)) continue')      // silence check
    expect(SRC).toContain('if (!name || quiet(name)) continue') // liveness check
    // One fetch, not two.
    expect(SRC.split('api/profiles').length - 1).toBe(1)
  })
})
