import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
/**
 * scripts/build-plan.ts must count stock the way a commission does: the named
 * agent's OWN storage AT the yard station. On 2026-09-11 `--for CyberSpock
 * --faction` (no --at) printed an empty Juggernaut plan because it summed the
 * agent's storage at every station (a stale Obsidian Well snapshot still held 5
 * neutronium he had hauled away) and the faction lockbox at every station (the
 * Haven lockbox held the targeting computers). This runs the real script against
 * a seeded temp DB and fixture feeds and reads the per-line table it now prints.
 */
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
let cached: Record<string, string> | null = null
async function run() {
  if (cached) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-buildplan-')); dirs.push(dir)
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'helpers', 'build-plan-check.ts'), dir], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, err).toBe(0)
  const line = out.split('\n').find(l => l.startsWith('__RESULT__')); expect(line, `no __RESULT__ in:\n${out}\n${err}`).toBeDefined()
  cached = JSON.parse(line!.slice('__RESULT__'.length)); return cached!
}
const row = (out: string, item: string) => out.split('\n').find(l => l.trim().startsWith(item + ' ') || l.trim().startsWith(item + '('))!

describe('build-plan yard lines', () => {
  test('held counts only the agent\'s storage at the yard; the wrong station never covers a line', async () => {
    const r = await run(); const w = row(r.atYard, 'widget')
    expect(w).toBeDefined(); expect(w).toMatch(/\bwidget\s+10\s+6\s+-\s+4\b/)
    expect(w).toContain('BUY 4 @100 in testland (depth 50)')
  })
  test('the lockbox is its own column and a source, never "held"', async () => {
    const r = await run(); const g = row(r.atYard, 'gizmo')
    expect(g).toMatch(/\bgizmo\s+4\s+0\s+3\s+4\b/)
    expect(g).toContain('LOCKBOX pull 3')
    expect(g).toContain('CRAFT 1 via forge_gizmo')
  })
  test('a recorded-only requirement row is reported with its gap and a gather hint', async () => {
    const r = await run(); const s = row(r.atYard, 'sprocket')
    expect(s).toContain('(recorded)'); expect(s).toMatch(/\s2\s+0\s+-\s+2\b/); expect(s).toContain('GATHER 2')
    expect(r.atYard).toContain('YARD LINES (3, 1 recorded-only)')
  })
  test('without --at the script says it is summing every station instead of hiding it', async () => {
    const r = await run()
    expect(r.noYard).toContain('WARNING: no yard given')
    expect(row(r.noYard, 'widget')).toMatch(/\bwidget\s+10\s+10\s+-\s+0\s+covered/)
  })
})
