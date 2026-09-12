/**
 * Naming the action behind a residual ledger row — without inventing one.
 *
 * The universal residual catch books any wallet movement the explicit rows did
 * not explain, so nothing vanishes. It stamped every such row `unattributed`
 * even though `source_command` already held the action it was observed during,
 * which made 424 rows read as mysteries in the transaction log when most were
 * ordinary fuel, tax and mission fees.
 *
 * But the action a residual is observed DURING is not always its cause. The
 * clearest example in the data: a row stamped `refuel` carrying +2,019,719 whose
 * own payload reads {"action":"refuel","cost":48} — a 48-credit top-up that
 * happened to coincide with a commission refund landing. Mapping refuel -> fuel
 * blindly would have booked two million credits of refunds as fuel spend and
 * quietly wrecked every fuel figure in the analytics.
 *
 * So attribution is conditional: the residual must be consistent with what the
 * action itself declared it was doing. Where it is, the row gets the real kind.
 * Where it is not, it stays explicitly unexplained and keeps the command it was
 * seen during, which is a smaller claim and a true one.
 */

import type { LedgerKind } from '../../shared/ledger-types'

/** Kind to use when a residual is genuinely explained by its action. */
const ACTION_KIND: Record<string, LedgerKind> = {
  refuel: 'fuel',
  sell: 'sales_tax',            // a NEGATIVE residual on a sale is the tax
  sell_cargo: 'sales_tax',
  buy: 'purchase_tax',
  buy_listed_ship: 'ship_purchase',
  commission_ship: 'commission',
  cancel_commission: 'commission',
  accept_mission: 'mission_bond',
  complete_mission: 'mission_reward',
  abandon_mission: 'mission_penalty',
  craft: 'craft_fee',
  repair: 'repair',
  create_buy_order: 'order_create',
  create_sell_order: 'order_create',
  cancel_order: 'order_cancel',
  send_gift: 'gift_sent',
  shipping_pay_debt: 'freight',
  install_mod: 'repair',
  reload: 'other',
}

/** Amount fields an action states about itself, in the order we trust them. */
const DECLARED_FIELDS = [
  'cost', 'total_cost', 'total_earned', 'total_price', 'price', 'amount',
  'reward', 'credits_sent', 'refunded', 'tax_amount', 'market_cost', 'fee',
]

/** The largest residual we will still call "consistent" with a declared figure.
 *  Tax and fees are a fraction of the trade, so a residual several times the
 *  declared amount is a different event that merely overlapped. The floor keeps
 *  ordinary small charges (a 90cr refuel, a 174cr tax) attributable even when
 *  the payload declares nothing. */
export function plausibleBound(declared: number | null): number {
  return Math.max((declared ?? 0) * 4, 5_000)
}

/**
 * A BULK order states its amounts one level down, inside `results[]`, and has no
 * top-level cost field at all:
 *
 *   {"action":"create_buy_order","mode":"bulk","results":[
 *      {"item_id":"titanium_alloy","quantity":120,"price_each":2500, "fills":[...]}]}
 *
 * Reading only the top level returns null, `plausibleBound(null)` floors at
 * 5,000, and any real bulk order dwarfs that — so a correct, on-plan purchase is
 * stamped `coincident` and loses its item attribution. CyberSpock's
 * titanium_alloy x120 @2,500 booked as an unexplained -305,733 that way.
 *
 * Sum the results instead. A per-result cost field wins; otherwise quantity x
 * price_each, which is what the bulk envelope actually carries.
 */
function declaredFromResults(ref: Record<string, unknown>): number | null {
  const results = ref.results
  if (!Array.isArray(results) || results.length === 0) return null
  let total = 0
  for (const entry of results) {
    if (!entry || typeof entry !== 'object') continue
    const r = entry as Record<string, unknown>
    const direct = DECLARED_FIELDS
      .map(f => r[f])
      .find(v => typeof v === 'number' && Number.isFinite(v) && v !== 0) as number | undefined
    if (direct !== undefined) { total += Math.abs(direct); continue }
    const qty = r.quantity ?? r.quantity_sold
    const each = r.price_each ?? r.unit_price
    if (typeof qty === 'number' && typeof each === 'number'
        && Number.isFinite(qty) && Number.isFinite(each)) total += Math.abs(qty * each)
  }
  return total > 0 ? total : null
}

export function readDeclared(ref: Record<string, unknown> | null | undefined): number | null {
  if (!ref) return null
  for (const f of DECLARED_FIELDS) {
    const v = ref[f]
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return Math.abs(v)
  }
  // Only when the top level declared nothing. A payload that DOES declare its own
  // figure is answering for itself, and a nested array must not override it — a
  // 1,100cr Refueling Pump sale carrying a 68,523 residual is genuinely coincident
  // and has to stay that way.
  return declaredFromResults(ref)
}

/**
 * The kind a residual row should carry.
 *
 * Returns the action's real kind when the movement is consistent with what that
 * action declared, and `coincident` when a movement merely overlapped it — never
 * `unattributed` when we know which command was running, because that discards
 * information we already hold.
 */
/** Kinds that are always a COST. A negative movement during one of these is a
 *  fee by construction; a positive one is something else arriving. */
const OUTGOING: ReadonlySet<LedgerKind> = new Set<LedgerKind>([
  'fuel', 'sales_tax', 'purchase_tax', 'craft_fee', 'repair', 'mission_bond',
  'mission_penalty', 'gift_sent', 'freight', 'ship_purchase', 'order_create',
])

/** Kinds that are always money ARRIVING. A negative movement during one of
 *  these is something else leaving (an unbooked fee, rent, a top-up). */
const INCOMING: ReadonlySet<LedgerKind> = new Set<LedgerKind>(['mission_reward'])

/** Payload markers proving the action actually completed, so an unpriced charge
 *  alongside one is that action's fee rather than a coincidence. */
function actionConfirmed(ref: Record<string, unknown> | null | undefined): boolean {
  if (!ref) return false
  return typeof ref.job_id === 'string' || typeof ref.recipe === 'string'
    || typeof ref.order_id === 'string' || typeof ref.mission_id === 'string'
}

export function classifyResidual(
  action: string | null | undefined,
  amount: number,
  ref?: Record<string, unknown> | null,
): LedgerKind {
  const a = String(action ?? '').replace(/^spacemolt_/, '')
    .replace(/^(?:market|storage|social|intel|faction|salvage|catalog|ship|battle|transfer|facility|auth)_/, '')
  if (!a) return 'unattributed'                 // genuinely nothing to go on
  const kind = ACTION_KIND[a]
  if (!kind) return 'coincident'                // a query or unknown verb was running

  // DIRECTION. A kind that is a cost by construction cannot explain money
  // arriving, and a reward cannot explain money leaving — whatever the size.
  // On 2026-09-12 01:19Z Morg'Thar's complete_mission carried a -90 residual
  // (the station top-up from a goto_system dock a minute earlier, unbooked at
  // the time) and was stamped `mission_reward`: a negative reward.
  if (OUTGOING.has(kind) && amount > 0) return 'coincident'
  if (INCOMING.has(kind) && amount < 0) return 'coincident'

  const declared = readDeclared(ref)

  // NOTHING DECLARED. The plausibility test compares a movement against a figure
  // the action stated about itself — with no figure there is nothing to be
  // inconsistent with, and the 5,000 floor becomes arbitrary. A craft is the
  // clearest case: its payload carries a job_id and a recipe but no cost, so
  // CyberSpock's 20,090 fee for Temper Crimson Fury Alloy booked as
  // "coincident" and read to the operator as an unexplained loss.
  //
  // So when the payload PROVES the action happened and the money moved in that
  // action's expected direction, name it. The false positive this guard was
  // built for went the other way — a +2,019,719 commission refund landing during
  // a refuel that DID declare cost:48 — and that case still fails the test below
  // because it declares a figure.
  if (declared === null && actionConfirmed(ref) && OUTGOING.has(kind) && amount < 0) return kind

  return Math.abs(amount) <= plausibleBound(declared) ? kind : 'coincident'
}
