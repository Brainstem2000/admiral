/**
 * Tell a swallowed DATA error apart from a swallowed CODE DEFECT.
 *
 * Collector paths (ledger, briefing, intel) end in `catch {}` on purpose: they
 * observe game traffic and must never break the command they are watching. A
 * malformed payload, a locked database, a field that is a string this time —
 * all expected, all correctly silent.
 *
 * That guarantee has twice turned a bug in our own code into invisible data
 * loss. On 2026-09-05 `LedgerCollector.mapResult` referenced an out-of-scope
 * `profileId` in its `trade_accept` branch; the ReferenceError was caught by
 * "ledger must never break game execution" and EVERY ledger row for that
 * command was dropped without a trace. The code was written to fix an 18,676cr
 * settlement that booked nothing, and it never once ran.
 *
 * A ReferenceError, TypeError or SyntaxError is never the game's fault — it is
 * ours. Report it (once per site, so a hot path cannot flood the log) and keep
 * the never-throw guarantee intact.
 */

const reported = new Set<string>()

/** True for errors that can only come from a defect in our own code. */
export function isCodeDefect(err: unknown): boolean {
  return err instanceof ReferenceError || err instanceof TypeError || err instanceof SyntaxError
}

/**
 * Call from a catch that would otherwise be silent. Returns true if the error
 * was a code defect (and was reported); false for ordinary data errors.
 *
 * @param where  a stable site name, e.g. 'ledger.mapResult'
 */
export function swallow(where: string, err: unknown, sink: (msg: string) => void = console.error): boolean {
  if (!isCodeDefect(err)) return false
  const e = err as Error
  const key = `${where}:${e.message}`
  if (reported.has(key)) return true
  reported.add(key)
  sink(`[defect] ${where} threw ${e.name}: ${e.message} — this is a bug in Admiral, not the game. ` +
       `Whatever this path collects is being dropped silently.\n${e.stack ?? ''}`)
  return true
}

/** Test seam: forget which sites have already been reported. */
export function resetSwallowed(): void { reported.clear() }
