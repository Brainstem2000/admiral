/**
 * One-off ledger repair: neutralise the phantom shipping escrow rows.
 *
 * WHAT WENT WRONG
 * ---------------
 * The escrow reconciler in `lib/ledger.ts` booked the mapped rows for a command
 * and *then* called `lastBookedBalance()` to find the balance before them.
 * `lastBookedBalance` takes the newest row by id, so after the insert loop it
 * returned the row just written: `prev === after`, the residual came out as
 * exactly `-explained`, and a mirror escrow row was manufactured for every
 * freight delivery.
 *
 * The effect is invisible in the wallet (the game is the source of truth there)
 * but it silently zeroes real income in the Financials tab: Cass Margin's
 * 88,970cr delivery on 2026-09-03 14:43 sits in the ledger as
 *   id 15093  freight  +88,970
 *   id 15094  escrow   -88,970      <- phantom
 * and nets to nothing, which is what "the 89k freight transaction doesn't show"
 * meant. The reconciler bug itself is already fixed; this repairs the history
 * it left behind.
 *
 * WHY CORRECTING ENTRIES AND NOT A DELETE
 * ---------------------------------------
 * A posted transaction is never removed — you post the entry that offsets it.
 * The phantom rows stay exactly where they are, and each gains a matching
 * `escrow_correction` row carrying the id of the row it reverses in `raw_ref`.
 * The history stays auditable: you can still see the bad posting AND its
 * correction, which a DELETE would have destroyed.
 *
 * The correction is stamped with the ORIGINAL row's timestamp, not "now", so
 * period totals and the running balance chart net correctly in the window where
 * the income actually happened.
 *
 * SAFETY
 * ------
 * - Dry run unless `--apply` is passed.
 * - Only touches escrow rows that EXACTLY negate a same-timestamp freight row
 *   from `shipping_deliver`. A genuine escrow (a real posted bond) has no such
 *   twin and is left alone.
 * - Idempotent: a row already carrying a correction is skipped, so re-running
 *   cannot double-count.
 *
 * Usage:
 *   bun scripts/repair-escrow-ledger.ts            # dry run, prints the plan
 *   bun scripts/repair-escrow-ledger.ts --apply    # write the corrections
 */
import { Database } from 'bun:sqlite'

const APPLY = process.argv.includes('--apply')
const DB_PATH = process.env.ADMIRAL_DB || 'data/admiral.db'
const CORRECTION_KIND = 'escrow_correction'
const CORRECTION_COMMAND = 'admiral_repair_phantom_escrow'

// bun:sqlite rejects `{readonly: false}` — it needs an explicit readwrite flag
// rather than the absence of readonly.
const db = APPLY ? new Database(DB_PATH, { readwrite: true }) : new Database(DB_PATH, { readonly: true })

interface Phantom {
  id: number
  profile_id: string
  name: string | null
  timestamp: string
  amount_signed: number
  freight_id: number
  freight_amount: number
}

// An escrow row is phantom when a freight row for the same profile, at the same
// timestamp, carries exactly the opposite amount. `source_command` pins it to
// the delivery path that produced the bug — both spellings, because the harness
// rewrites the v2 group form `shipping(action=deliver)` to the flat
// `shipping_deliver`, so the same delivery is labelled either way depending on
// which side of that rewrite it went through.
const phantoms = db
  .query<Phantom, []>(
    `SELECT e.id, e.profile_id, p.name, e.timestamp, e.amount_signed,
            f.id AS freight_id, f.amount_signed AS freight_amount
       FROM financial_ledger e
       JOIN financial_ledger f
         ON f.profile_id = e.profile_id
        AND f.timestamp  = e.timestamp
        AND f.kind       = 'freight'
        AND f.amount_signed = -e.amount_signed
       LEFT JOIN profiles p ON p.id = e.profile_id
      WHERE e.kind = 'escrow'
        AND e.amount_signed < 0
        AND e.source_command IN ('shipping_deliver', 'deliver')
        AND NOT EXISTS (
              SELECT 1 FROM financial_ledger c
               WHERE c.kind = ?1
                 AND c.raw_ref = 'reverses:' || e.id
            )
      ORDER BY e.id`.replace('?1', `'${CORRECTION_KIND}'`),
  )
  .all()

// Everything else wearing the escrow label — reported so the operator can see
// what is being deliberately left untouched.
const survivors = db
  .query<{ n: number; total: number }, []>(
    `SELECT count(*) AS n, COALESCE(sum(amount_signed), 0) AS total
       FROM financial_ledger e
      WHERE e.kind = 'escrow'
        AND NOT EXISTS (
              SELECT 1 FROM financial_ledger f
               WHERE f.profile_id = e.profile_id
                 AND f.timestamp  = e.timestamp
                 AND f.kind       = 'freight'
                 AND f.amount_signed = -e.amount_signed
            )`,
  )
  .get()!

const byAgent = new Map<string, { n: number; total: number }>()
for (const p of phantoms) {
  const key = p.name || p.profile_id
  const acc = byAgent.get(key) || { n: 0, total: 0 }
  acc.n += 1
  acc.total += Math.abs(p.amount_signed)
  byAgent.set(key, acc)
}

console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${DB_PATH}\n`)
console.log(`Phantom escrow rows needing a correction: ${phantoms.length}`)
console.log(`Income they are currently hiding:         ${[...byAgent.values()].reduce((a, v) => a + v.total, 0).toLocaleString()} cr\n`)
for (const [name, v] of [...byAgent.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${name.padEnd(26)} ${String(v.n).padStart(3)} rows   ${v.total.toLocaleString().padStart(12)} cr`)
}
console.log(`\nGenuine escrow rows left untouched: ${survivors.n} (net ${survivors.total.toLocaleString()} cr)`)

if (!APPLY) {
  console.log('\nNothing written. Re-run with --apply to post the corrections.')
  process.exit(0)
}

const insert = db.prepare(
  `INSERT INTO financial_ledger
     (profile_id, timestamp, kind, amount_signed, counterparty, source_command, raw_ref)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
)

const run = db.transaction((rows: Phantom[]) => {
  for (const r of rows) {
    insert.run(
      r.profile_id,
      r.timestamp,
      CORRECTION_KIND,
      -r.amount_signed, // phantom is negative; the correction is its positive mirror
      'ledger repair',
      CORRECTION_COMMAND,
      `reverses:${r.id}`,
    )
  }
  return rows.length
})

const written = run(phantoms)
console.log(`\nPosted ${written} correcting entries.`)

const after = db
  .query<{ kind: string; n: number; total: number }, []>(
    `SELECT kind, count(*) AS n, sum(amount_signed) AS total
       FROM financial_ledger
      WHERE kind IN ('freight', 'escrow', '${CORRECTION_KIND}')
      GROUP BY kind ORDER BY kind`,
  )
  .all()
console.log('\nFleet totals now:')
for (const r of after) console.log(`  ${r.kind.padEnd(20)} ${String(r.n).padStart(4)} rows  ${r.total.toLocaleString().padStart(14)} cr`)
