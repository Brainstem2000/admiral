import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
/**
 * goto_system must not abort on find_route's `no_current_system` — the ship is
 * mid-jump (usually right after a reconnect) and arrives seconds later. It
 * waits and asks again; only after the retry budget does it abort, and then it
 * says "wait for arrival, call goto_system again" instead of "check the name".
 */
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
let cached: Record<string, any> | null = null
async function run() {
  if (cached) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-goto-transit-')); dirs.push(dir)
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'helpers', 'goto-transit-retry-check.ts'), dir], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, err).toBe(0)
  const line = out.split('\n').find((l) => l.startsWith('__RESULT__')); expect(line, `no __RESULT__ in:\n${out}\n${err}`).toBeDefined()
  cached = JSON.parse(line!.slice('__RESULT__'.length)); return cached!
}
describe('goto_system while the ship is still mid-jump', () => {
  test('waits for arrival and completes the route instead of aborting', async () => {
    const r = await run()
    expect(r.arrives.out).toContain('goto_system DONE')
    expect(r.arrives.routeCalls).toBe(3)
    expect(r.arrives.waits).toBe(2)
    expect(r.arrives.jumps).toBe(1)
  })
  test('after the retry budget it aborts with the real cause, not "check the system name"', async () => {
    const r = await run()
    expect(r.stuck.out).toContain('MACRO ABORT')
    expect(r.stuck.out).toContain('mid-jump')
    expect(r.stuck.out).toContain('goto_system(target_system="markab")')
    expect(r.stuck.out).not.toContain('search_systems')
    expect(r.stuck.routeCalls).toBe(4)
    expect(r.stuck.jumps).toBe(0)
  })
})
