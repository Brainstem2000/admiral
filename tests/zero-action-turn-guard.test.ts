import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
/**
 * Zero-action turns and the request sanity check.
 *
 * Bob Comet, 2026-09-11 08:54–09:11 CT: 274 LLM calls in 17 minutes, docked at War
 * Citadel with his mission complete and no orders. Every turn had the same shape —
 * "standing by" on round 0, the one "call the tool" retry, a free query (get_player,
 * view storage), "standing by" again — and because `rounds` was 1 by then the turn
 * scored `completed`, reset the idle counter, and went round again two seconds
 * later. The idle backoff, built for exactly this, never engaged. (The "3/190
 * tokens" summaries that read as empty prompts were fully cached ~60k-token
 * requests; the summary now shows the cached prefix.)
 *
 * The loop runs in a subprocess against a temp workspace (DB_DIR = cwd/data) with a
 * fake OpenAI-compatible server standing in for the model: bun:test's mock.module
 * does not apply outside the runner, and this exercises pi-ai's real request path.
 */
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
// One subprocess for the whole file. A failed spawn is cached too, so a broken helper
// fails every test at once instead of being re-spawned (and re-timed-out) per test.
let cached: Record<string, any> | null = null
let failed: Error | null = null
async function run() {
  if (cached) return cached
  if (failed) throw failed
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-zero-action-')); dirs.push(dir)
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'helpers', 'zero-action-turn-check.ts'), dir], { stdout: 'pipe', stderr: 'pipe' })
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, err).toBe(0)
    const line = out.split('\n').find(l => l.startsWith('__RESULT__')); expect(line, `no __RESULT__ in:\n${out}\n${err}`).toBeDefined()
    const parsed = JSON.parse(line!.slice('__RESULT__'.length)); expect(parsed.error).toBeUndefined()
    cached = parsed; return cached!
  } catch (e) {
    failed = e instanceof Error ? e : new Error(String(e)); throw failed
  }
}
const zeroAction = (r: any) => r.system.filter((s: string) => s.startsWith('Zero-action turn'))

describe('a turn that attempts no action and writes no state is idle', () => {
  test("Bob's shape — prose, retry, one free query, prose — scores idle at the cap", async () => {
    const r = (await run()).bob
    expect(r.outcome).toBe('idle')
    expect(r.calls).toBe(3)
    expect(r.retryNotes).toBe(1)
    expect(zeroAction(r)).toHaveLength(1)
    expect(zeroAction(r)[0]).toMatch(/1 tool round/)
    expect(zeroAction(r)[0]).toMatch(/2\/2 replies without a tool call, per-turn cap reached/)
  }, 90_000)
  test('a free query followed by prose is idle too, without the cap note', async () => {
    const r = (await run()).queryThenProse
    expect(r.outcome).toBe('idle'); expect(r.calls).toBe(2)
    expect(zeroAction(r)).toHaveLength(1); expect(zeroAction(r)[0]).not.toMatch(/cap reached/)
  }, 60_000)
  test('the per-turn cap on replies without a tool call is the retry budget', async () => {
    const { proseTwice, constants } = await run()
    expect(constants.MAX_NO_TOOL_ROUNDS_PER_TURN).toBe(2)
    expect(proseTwice.outcome).toBe('idle')
    expect(proseTwice.calls).toBe(constants.MAX_NO_TOOL_ROUNDS_PER_TURN)
    expect(zeroAction(proseTwice)[0]).toMatch(/cap reached/)
  }, 60_000)
  test('the retry that produces a real action still completes the turn', async () => {
    const r = (await run()).retryThenAction
    expect(r.outcome).toBe('completed'); expect(r.calls).toBe(2); expect(zeroAction(r)).toHaveLength(0)
  }, 60_000)
  test('an action turn is completed', async () => {
    const r = (await run()).action
    expect(r.outcome).toBe('completed'); expect(r.calls).toBe(1); expect(zeroAction(r)).toHaveLength(0)
  }, 60_000)
  test('a TODO write is progress even with no game action', async () => {
    const r = (await run()).todoOnly
    expect(r.outcome).toBe('completed'); expect(r.calls).toBe(2); expect(zeroAction(r)).toHaveLength(0)
  }, 60_000)
})

describe('a request far smaller than a system prompt is refused, not sent', () => {
  test('the floor is a few hundred tokens', async () => {
    const { constants } = await run()
    expect(constants.MIN_EXPECTED_REQUEST_TOKENS).toBeGreaterThanOrEqual(200)
    expect(constants.MIN_EXPECTED_REQUEST_TOKENS).toBeLessThanOrEqual(1000)
  }, 60_000)
  test('a three-character prompt never reaches the model and the turn is idle', async () => {
    const { tinyRefused, constants } = await run()
    expect(tinyRefused.calls).toBe(0)
    expect(tinyRefused.outcome).toBe('idle')
    expect(tinyRefused.system.some((s: string) => /^Refusing to send an LLM request/.test(s))).toBe(true)
    const detail = JSON.parse(tinyRefused.refusalDetail)
    expect(detail.stopReason).toBe('request_refused')
    expect(detail.estimatedTokens.total).toBeLessThan(constants.MIN_EXPECTED_REQUEST_TOKENS)
  }, 60_000)
  test('an empty message list is refused even behind a full-size prompt', async () => {
    const r = (await run()).emptyRefused
    expect(r.calls).toBe(0)
    expect(r.system.some((s: string) => /Refusing to send an LLM request: the message list is empty/.test(s))).toBe(true)
  }, 60_000)
  test('a full-size request is sent', async () => {
    const r = (await run()).fullSent
    expect(r.calls).toBe(1); expect(r.outcome).toBe('completed'); expect(r.refusalDetail).toBeNull()
  }, 60_000)
  test('without the option a tiny prompt is still sent (every in-process loop test relies on it)', async () => {
    const r = (await run()).tinyUnguarded
    expect(r.calls).toBe(1); expect(r.outcome).toBe('completed')
  }, 60_000)
})

describe('housekeeping', () => {
  test('the llm_call summary shows the cached prefix next to the uncached input', async () => {
    const r = (await run()).bob
    expect(r.llmCalls[0]).toMatch(/10\/5 tokens \(40 cached\)/)
  }, 60_000)
  test('the subprocess DB lives in the temp workspace, not data/admiral.db', async () => {
    expect((await run()).dbInsideWorkspace).toBe(true)
  }, 60_000)
})
