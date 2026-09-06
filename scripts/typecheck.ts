/**
 * typecheck — separate the errors that CRASH from the errors that never will.
 *
 * `tsc --noEmit` on this repo prints ~20 errors that are genuinely expected:
 * Bun-only globals (`import.meta.dir`, `bun:sqlite`) that tsc cannot resolve
 * because the project builds with Bun's bundler, plus a handful of deliberate
 * `unknown` casts. CLAUDE.md used to say "these are pre-existing, don't treat
 * them as regressions" — and that sentence is how a live crash hid for two days.
 *
 * On 2026-09-05, three doctrine guards referenced an out-of-scope `ctx`.
 * `refuseAbandon(ctx.profileId)` runs unconditionally on every abandon_mission,
 * so from the moment it landed EVERY abandon killed the turn with a
 * ReferenceError — 29 dead turns across Juno Freight, CyberSpock and Morg'Thar.
 * tsc reported it the whole time as five TS2304s, sitting in the middle of the
 * noise everyone had been told to ignore. A fourth instance in ledger.ts was
 * swallowed by a collector catch and silently dropped ledger rows for days.
 *
 * TS2304 "Cannot find name" is NEVER Bun-global noise — it is a name that does
 * not exist at runtime, which is a crash on the line that reaches it. So this
 * script fails on the crash class and stays quiet about the rest, instead of
 * asking a human to eyeball twenty lines and spot the one that matters.
 *
 *   bun scripts/typecheck.ts          # fail on crash-class errors only
 *   bun scripts/typecheck.ts --all    # also list the tolerated ones
 */

/** Errors that mean "this line will throw when reached". Never tolerated. */
const CRASH_CLASS: Record<string, string> = {
  TS2304: 'Cannot find name — the identifier does not exist at runtime (ReferenceError)',
  TS2552: 'Cannot find name, did you mean… — same crash, with a spelling suggestion',
  TS2662: 'Cannot find name (static member referenced as a bare name)',
  TS2663: 'Cannot find name (instance member referenced as a bare name)',
  TS2664: 'Cannot find name (namespace member referenced as a bare name)',
  TS2551: 'Property does not exist, did you mean… — a mistyped member read is undefined at best',
  TS7027: 'Unreachable code — a return/throw above it makes this dead',
}

const proc = Bun.spawn(['bunx', 'tsc', '--noEmit'], { stdout: 'pipe', stderr: 'pipe' })
const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())
await proc.exited

const LINE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/
interface Err { file: string; line: string; code: string; msg: string }
const errors: Err[] = []
for (const l of out.split('\n')) {
  const m = LINE.exec(l.trim())
  if (m) errors.push({ file: m[1], line: m[2], code: m[4], msg: m[5] })
}

const crashes = errors.filter(e => e.code in CRASH_CLASS)
const tolerated = errors.filter(e => !(e.code in CRASH_CLASS))

if (Bun.argv.includes('--all') && tolerated.length) {
  console.log(`tolerated (${tolerated.length}) — Bun globals and deliberate casts, not crashes:`)
  for (const e of tolerated) console.log(`  ${e.code}  ${e.file}:${e.line}  ${e.msg.slice(0, 90)}`)
  console.log()
}

if (!crashes.length) {
  console.log(`OK — no crash-class errors (${tolerated.length} tolerated; --all to list).`)
  process.exit(0)
}

console.error(`FAIL — ${crashes.length} crash-class error(s). These throw at runtime:\n`)
for (const e of crashes) {
  console.error(`  ${e.file}:${e.line}`)
  console.error(`    ${e.code}: ${e.msg}`)
  console.error(`    why it matters: ${CRASH_CLASS[e.code]}\n`)
}
console.error('Fix these before committing. They are not "pre-existing tsc noise".')
process.exit(1)
