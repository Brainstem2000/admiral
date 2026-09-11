import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
/**
 * 2026-09-10 20:38-20:41: CyberSpock, told to "stay docked and await orders" after a
 * delivery, accepted a combat bounty and bought a 50,001cr Catalogue hull, then flew it
 * into six lawless systems. No order said either. Buying a ship and accepting a mission
 * now require the directive to say so; a directive that forbids missions blocks them
 * even though it mentions the word.
 */
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
let cached: Record<string, any> | null = null
async function run() {
  if (cached) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-shipauth-')); dirs.push(dir)
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'helpers', 'ship-mission-authorization-check.ts'), dir], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, err).toBe(0)
  const line = out.split('\n').find(l => l.startsWith('__RESULT__')); expect(line, `no __RESULT__ in:\n${out}\n${err}`).toBeDefined()
  cached = JSON.parse(line!.slice('__RESULT__'.length)); return cached!
}
describe('ship purchase and mission acceptance need the directive\'s word', () => {
  test('an idle courier may not buy a ship or take a mission', async () => {
    const r = await run(); expect(r.shipIdle).toContain('BLOCKED'); expect(r.missionIdle).toContain('BLOCKED')
  }, 60_000)
  test('a refit order that names buying a hull passes', async () => { const r = await run(); expect(r.shipAuthorized).toBeNull() }, 60_000)
  test('a contract-running directive may accept missions', async () => { const r = await run(); expect(r.missionAuthorized).toBeNull() }, 60_000)
  test('a directive that forbids missions blocks them despite naming them', async () => { const r = await run(); expect(r.missionForbidden).toContain('forbids') }, 60_000)
})
