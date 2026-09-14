import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * A read that only ADVISES the sell must never be able to kill it.
 *
 * sell_cargo consults the commission ledger per cargo line to keep materials an
 * unbuilt ship still needs off the market. That lookup was unguarded while the
 * storage lookup beside it was wrapped, so any database error escaped the lock,
 * escaped the macro, and reached the agent as:
 *
 *   MACRO ERROR (sell_cargo): null is not an object (evaluating 'db.query').
 *   State may have partially changed — verify with get_status.
 *
 * Two things were wrong with that. Nothing sold — the macro died on the first
 * cargo line, so a full hold came back from market untouched. And the message
 * told the agent state may have changed when nothing had, which invites a
 * verify-then-retry loop against a fault that will simply recur.
 *
 * Failing OPEN is not the alternative: on 2026-09-10 the lock read as "nothing
 * reserved" and CyberSpock sold 50 uranium_ore the Juggernaut needed for
 * 7,500cr. Unreadable has to mean unknown, and unknown has to mean refuse.
 *
 * Runs in a subprocess that never calls getDb(), because db.ts binds its handle
 * lazily and any other test sharing the process may already have opened it.
 */

const tempDirectories: string[] = []
afterEach(() => {
  for (const d of tempDirectories.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

let cached: { out: string; sold: string[] } | null = null
async function sellWithNoDatabase(): Promise<{ out: string; sold: string[] }> {
  if (cached) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-sell-nodb-'))
  tempDirectories.push(dir)
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
  const helper = path.join(import.meta.dir, 'helpers', 'sell-cargo-no-db-check.ts')
  const child = Bun.spawn([process.execPath, helper, path.join(dir, 'data')], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect(code, err).toBe(0)
  const line = out.split('\n').find(l => l.startsWith('__RESULT__'))
  expect(line, `no __RESULT__ in:\n${out}\n${err}`).toBeDefined()
  cached = JSON.parse(line!.slice('__RESULT__'.length))
  return cached!
}

describe('sell_cargo with an unreadable commission ledger', () => {
  test('refuses instead of throwing a raw database error at the agent', async () => {
    const { out } = await sellWithNoDatabase()
    expect(out).toContain('MACRO ABORT')
    expect(out).toContain('commission ledger')
    // The raw fault must not be what the agent reads.
    expect(out).not.toContain('db.query')
    expect(out).not.toContain('MACRO ERROR')
  }, 60_000)

  test('sells nothing, and says so, rather than selling blind', async () => {
    const { out, sold } = await sellWithNoDatabase()
    expect(sold).toEqual([])
    expect(out).toContain('Nothing was sold')
  }, 60_000)

  test('does not claim state may have changed when nothing was attempted', async () => {
    const { out } = await sellWithNoDatabase()
    // The old message sent the agent to verify a state that never moved.
    expect(out).not.toContain('may have partially changed')
    expect(out).toContain('nothing changed')
  }, 60_000)

  test('names the single-item escape so the agent is not simply stuck', async () => {
    const { out } = await sellWithNoDatabase()
    expect(out).toContain('`sell`')
  }, 60_000)
})
