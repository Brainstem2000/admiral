import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
/**
 * Directive queue (docs/plans/directive-queue.md): plan steps per agent, each with
 * a condition, applied between turns by advancePlanQueue(). Replaces the hand-rolled
 * watcher scripts of 2026-09-10. The agent only ever sees the active step's
 * directive; the docked gate is on by default; a completion condition retires the
 * step and can restore the directive it displaced; admiral_go steps wait for a fire.
 */
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
let cached: Record<string, any> | null = null
async function run() {
  if (cached) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-planq-')); dirs.push(dir)
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'helpers', 'plan-queue-check.ts'), dir], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, err).toBe(0)
  const line = out.split('\n').find(l => l.startsWith('__RESULT__')); expect(line, `no __RESULT__ in:\n${out}\n${err}`).toBeDefined()
  cached = JSON.parse(line!.slice('__RESULT__'.length)); return cached!
}
describe('directive queue', () => {
  test('a step waits silently until every condition holds, and says what it waits on', async () => {
    const r = await run(); expect(r.a).toBeNull(); expect(r.aDirective).toContain('LOOP'); expect(r.aWaiting[0][2]).toContain('sell_cargo DONE'); expect(r.b).toBeNull()
  })
  test('when it holds, the directive and TODO are replaced and the old directive is kept', async () => {
    const r = await run(); expect(r.cApplied).toBe('s1'); expect(r.cDirective).toContain('EXPEDITION'); expect(r.cTodo).toBe('go now'); expect(r.cStatus).toBe('active'); expect(r.cRestoreTo).toContain('LOOP'); expect(r.cLog).toContain('step 1/2 applied')
  })
  test('completion only counts results after the step fired, then restores the loop directive', async () => {
    const r = await run(); expect(r.dEarly).toBeNull(); expect(r.dCompleted).toBe('s1'); expect(r.dStatus).toBe('done'); expect(r.dDirective).toContain('LOOP'); expect(r.dApplied).toBeNull()
  })
  test('an admiral_go step never fires on its own, but the fire action applies it', async () => {
    const r = await run(); expect(r.e).toBeNull(); expect(r.eStatus).toBe('queued'); expect(r.fDirective).toContain('COMMISSION'); expect(r.fStatus).toBe('active'); expect(r.fLog).toContain('FIRED')
  })
  test('a storage threshold gates on the recorded quantity', async () => {
    const r = await run(); expect(r.gLow).toBeNull(); expect(r.gHigh).toBe('s3'); expect(r.count).toBe(7)
  })
  test('one plan\'s blocked head does not hide another plan\'s ready step', async () => {
    const r = await run(); expect(r.hApplied).toBe('h2'); expect(r.hBlockedStatus).toBe('queued')
  })
  test('a successor waits while its plan\'s active step is unfinished, then follows at the boundary that completes it', async () => {
    const r = await run()
    expect(r.iFirst).toBe('i1'); expect(r.iSecondBoundary).toBeNull(); expect(r.iStatuses).toEqual(['active', 'queued'])
    expect(r.iWaiting).toContain('waits for the active step'); expect(r.iWaiting).toContain('titanium_alloy')
    expect(r.iCompleted).toBe('i1'); expect(r.iApplied).toBe('i2'); expect(r.iDirective).toContain('STRICT 2')
  })
})
