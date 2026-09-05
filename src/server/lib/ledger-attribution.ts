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

export function readDeclared(ref: Record<string, unknown> | null | undefined): number | null {
  if (!ref) return null
  for (const f of DECLARED_FIELDS) {
    const v = ref[f]
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return Math.abs(v)
  }
  return null
}

/**
 * The kind a residual row should carry.
 *
 * Returns the action's real kind when the movement is consistent with what that
 * action declared, and `coincident` when a movement merely overlapped it — never
 * `unattributed` when we know which command was running, because that discards
 * information we already hold.
 */
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
  return Math.abs(amount) <= plausibleBound(readDeclared(ref)) ? kind : 'coincident'
}
