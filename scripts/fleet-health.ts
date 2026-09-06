/**
 * Fleet health watch — error bursts, guard-block loops, stalled agents, and
 * agents whose own writing has run away with them.
 *
 * TIMESTAMP FORMAT MATTERS. log_entries.timestamp is SQLite datetime, "2026-09-04
 * 23:51:06" with a SPACE. An earlier version of this watch compared it against
 * `new Date().toISOString()`, which emits a "T": at index 10 a space (0x20)
 * sorts before "T" (0x54), so every `timestamp > ?` was false and the watch
 * matched nothing for hours while looking perfectly healthy. Silence from a
 * watcher must mean "checked and clear", never "never ran".
 *
 * Usage: bun scripts/fleet-health.ts [--once]
 */
import { Database } from 'bun:sqlite'

const ONCE = process.argv.includes('--once')
const INTERVAL_MS = 5 * 60 * 1000

/** SQLite datetime string N minutes ago — the format the column actually uses. */
function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19)
}

/** Which agents are actually running an LLM loop right now.
 *
 *  A parked agent is not stalled, it is parked — and after a fleet-wide
 *  safe-dock this check fired "possible stalled loop" for six agents at once,
 *  every one of them deliberately shut down. Alerting on intended state is how
 *  a watcher trains its reader to ignore it. */
async function runningAgents(): Promise<Set<string>> {
  try {
    const r = await fetch('http://127.0.0.1:3031/api/profiles', { signal: AbortSignal.timeout(20_000) })
    if (!r.ok) return new Set()
    const rows = await r.json() as Array<{ id: string; running?: boolean }>
    return new Set(rows.filter(x => x.running).map(x => x.id))
  } catch {
    return new Set()   // server unreachable: report nothing rather than everything
  }
}

// Findings already reported, so a standing condition is announced ONCE and not
// re-announced every cycle for the 25 minutes its window keeps looking back.
// Cleared when the condition stops firing, so a genuine recurrence is loud again.
const reported = new Set<string>()

function announce(key: string, msg: string, firing: boolean): void {
  if (!firing) { reported.delete(key); return }
  if (reported.has(key)) return
  reported.add(key)
  console.log(msg)
}

async function sweep(): Promise<void> {
  const running = await runningAgents()
  if (running.size === 0) return          // whole fleet parked, or server down
  const db = new Database('data/admiral.db', { readonly: true })
  const recent = ago(6), wider = ago(25)
  const count = (sql: string, ...a: unknown[]) =>
    (db.query(sql).get(...a as never[]) as { c: number }).c

  for (const p of db.query('SELECT id, name FROM profiles WHERE enabled = 1').all() as Array<{ id: string; name: string }>) {
    const n = p.name.split(' - ')[0]
    if (!running.has(p.id)) {            // parked on purpose — nothing to report
      for (const k of ['err', 'blocked', 'silent', 'banner']) reported.delete(`${k}:${p.id}`)
      continue
    }

    const errs = count(`SELECT COUNT(*) c FROM log_entries WHERE profile_id=? AND type='error' AND timestamp>?`, p.id, recent)
    announce(`err:${p.id}`, `[fleet] ${n}: ${errs} errors in 6min`, errs >= 3)

    // A refusal is a tool_result that STARTS with the marker. Matching the words
    // anywhere in any row counted the agent THINKING about a guard: Morg quotes his
    // own directive ("the harness REFUSES a fourth abandon") in llm_thought every
    // turn, which fired this alarm five times in one evening while nothing was
    // actually blocked. A watcher that cries wolf gets switched off, which is worse
    // than no watcher — so match the event, never the narration about it.
    const blocked = count(`SELECT COUNT(*) c FROM log_entries WHERE profile_id=? AND timestamp>?
      AND type='tool_result'
      AND (summary LIKE 'BLOCKED by Admiral doctrine%' OR summary LIKE 'REFUSED%')`, p.id, recent)
    announce(`blocked:${p.id}`, `[fleet] ${n}: ${blocked} guard blocks in 6min — likely looping on a refused call`, blocked >= 4)

    const now = count(`SELECT COUNT(*) c FROM log_entries WHERE profile_id=? AND timestamp>?`, p.id, recent)
    const before = count(`SELECT COUNT(*) c FROM log_entries WHERE profile_id=? AND timestamp>?`, p.id, wider)
    announce(`silent:${p.id}`, `[fleet] ${n}: silent 6min after being active — possible stalled loop`, now === 0 && before > 0)

    // Runaway self-narration. Grit Vane hit 36% of his thoughts carrying alarm
    // framing ("CRITICAL STATE RECONCILIATION") against 1-2% for fleetmates on
    // the SAME model — a style loop through his own TODO, which he rewrites and
    // is then re-injected. Costs output tokens every turn and buries real alarms.
    // Own thoughts only. makeMacroNarrator logs "[mine_until_full 59 mines, ...]"
    // as an llm_thought, so Bob Comet showed 71 "thoughts" against 3 tool calls
    // while inside one mine_until_full that filled 1,319 of 1,550 cargo. Counting
    // those made the fleet's best miner look paralysed.
    const total = count(`SELECT COUNT(*) c FROM log_entries WHERE profile_id=? AND type='llm_thought'
      AND summary NOT LIKE '[%' AND timestamp>?`, p.id, wider)
    const calls = count(`SELECT COUNT(*) c FROM log_entries WHERE profile_id=? AND type='tool_call' AND timestamp>?`, p.id, wider)
    if (total >= 20) {
      // Match the SHAPE, not a word list. The first version keyed on
      // CRITICAL/RECONCIL/🚨 and Grit Vane simply moved to
      // "**🎯 LIVE STATE CONFIRMED — CYCLE 171 STARTING**": identical ritual
      // preamble every turn, zero detections. A keyword watcher that an agent
      // can reword its way around is a false negative dressed as a clean bill.
      //
      // The tell is a thought OPENING with a bold banner — `**`, optionally
      // after a macro prefix like "[mine_until_full 3 mines, cargo 12/120] ".
      // Ordinary reasoning starts with a sentence.
      // A bare "**TODO** - Verified: <one line>" is a compact, useful note, not a
      // ritual alarm — Ledger Voss writes it while labelling his TODO update, and
      // counting it flagged him at 25% on a run with ZERO alarm framing in 65
      // turns. Excluding it keeps the signal on what actually costs output: a
      // bold banner announcing state as an event.
      //
      // THIRD REVISION, and the reason is worth keeping. Counting every
      // bold-opening thought is a formatting metric, not a behavioural one:
      // on 2026-09-05 it held Morg'Thar at 46-67% while he was dock -> sell_cargo
      // -> view_market -> get_missions -> jump, a perfectly good trade loop, and
      // his "banners" were things like "**Analysis of Alzirr mission board:**".
      // Flagging an agent for writing in bold is the same false-positive shape
      // as counting his "**TODO**" labels was.
      //
      // Ritual restatement means the SAME preamble turn after turn — that is
      // what costs output and buries real alarms. So measure repetition: take
      // each banner's opening text and find the most-repeated one. Twenty
      // different bold headers is a writing style; the same header twenty times
      // is the loop.
      // ONLY WHAT THE AGENT WROTE THIS TURN COUNTS. makeMacroNarrator logs
      // `[goto_system hop 7/14 → x] <intent>` where <intent> is captured ONCE
      // when the macro starts and replayed verbatim on every hop — so a 14-hop
      // journey emits 14 identical lines that the agent wrote once. Counting
      // them flagged Vera Lane at 30% on 2026-09-05 while she was progressing
      // cleanly through hops 5,6,7,8,9; 21 of her 30 "thoughts" were the
      // narrator echoing her. The macro-prefixed form is excluded outright.
      // An agent's own repeated banner has no prefix and is still caught.
      const banners = (db.query(`SELECT summary FROM log_entries WHERE profile_id=? AND type='llm_thought' AND timestamp>?
        AND summary LIKE '**%'
        AND summary NOT LIKE '**TODO%'`).all(p.id, wider) as Array<{ summary: string }>)
      const tally = new Map<string, number>()
      for (const b of banners) {
        // Normalise away the macro prefix and the volatile numbers inside a
        // banner ("CYCLE 171", "hull 87/90") so the same ritual with a changing
        // counter still groups as one.
        const head = String(b.summary ?? '')
          .split('\n')[0]
          .slice(0, 70)
          .replace(/\d+/g, '#')
          .toLowerCase()
          .trim()
        if (head) tally.set(head, (tally.get(head) ?? 0) + 1)
      }
      // FOURTH REVISION. A repeated HEADING is not a repeated preamble.
      // Ledger Voss opens his notes "**TODO (updated)**" on its own line and
      // puts real, changing state underneath: measured 2026-09-06, that key
      // grouped 10 of 10 thoughts while 9 of the 10 BODIES were distinct — he
      // was mid-campaign, installing a rad harvester and mining uranium. The
      // key was 18 characters. Grit Vane's genuine ritual
      // ("**LIVE STATE CONFIRMED — CYCLE ### STARTING**") ran ~45, and
      // Morg'Thar's ("**reading current state now — this is authoritative.**")
      // 54. A short heading costs a handful of tokens and buries nothing;
      // requiring real length separates a label from a ceremony without
      // needing another agent-specific exclusion — which is what the
      // '**TODO**' carve-out was, and it missed '**TODO (updated)**'.
      const MIN_BANNER_CHARS = 30
      let worstText = '', worst = 0
      for (const [k, v] of tally) {
        if (k.length < MIN_BANNER_CHARS) continue
        if (v > worst) { worst = v; worstText = k }
      }
      const pct = Math.round((100 * worst) / total)
      // FIFTH REVISION. A ritual banner on an agent who is ACTING is verbosity,
      // not paralysis, and calling it a "loop" sends the Admiral to the wrong
      // agent. Measured 2026-09-06 02:20: Grit Vane repeated a 42-char header on
      // 19 of 59 thoughts while running 36 tool calls and closing 27 turns —
      // "DONE: Cycle 8 sold titanium+iron (7,420cr)". He was the alarm's target
      // and one of the fleet's best earners at the time.
      //
      // What the alarm is actually FOR is an agent narrating instead of doing.
      // So it now requires both: the repeated banner AND fewer than half as many
      // actions as thoughts. Under that rule no agent in the fleet fired at
      // 02:20, which is the correct answer — every one of them was working.
      const narratingNotDoing = calls * 2 < total
      announce(`banner:${p.id}`,
        `[fleet] ${n}: ${worst}/${total} thoughts open with the same banner and only ${calls} actions in 25min — narrating instead of acting: "${worstText.slice(0, 48)}"`,
        worst >= 8 && pct >= 25 && narratingNotDoing)
    }
  }
  db.close()
}

await sweep()
if (!ONCE) {
  setInterval(() => { sweep().catch(() => {}) }, INTERVAL_MS)
  await new Promise(() => {})
}
