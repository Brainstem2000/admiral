export type LedgerKind =
  | 'buy' | 'sell'
  | 'order_create' | 'order_fill' | 'order_cancel'
  | 'mission_reward' | 'fuel' | 'repair' | 'dock_fee' | 'combat'
  | 'insurance' | 'commission'
  | 'deposit' | 'withdraw' | 'transfer' | 'gift_sent' | 'gift_received' | 'trade' | 'freight' | 'escrow' | 'other'
  // Residual rows: a wallet movement the harness saw but no explicit amount
  // field explained. Booked so every credit is accounted for rather than lost.
  //
  // These carry the real action when the amount is consistent with what that
  // action declared about itself — see lib/ledger-attribution.ts. The tax and
  // fee kinds below exist because that is what most residuals actually are.
  | 'sales_tax' | 'purchase_tax' | 'craft_fee' | 'ship_purchase'
  | 'mission_bond' | 'mission_penalty'
  // A movement that merely OVERLAPPED the command being run. One row stamped
  // `refuel` carried +2,019,719 while its payload read cost: 48 — a commission
  // refund landing during a top-up. Calling that "fuel" would have booked two
  // million credits of refunds as fuel spend.
  | 'coincident'
  // Nothing to attribute it to at all — no command was recorded. Station rent
  // (auto-deducted ~every 17 min) lands here.
  | 'unattributed'
  // Posted by scripts/repair-escrow-ledger.ts to reverse the phantom escrow
  // rows the old reconciler manufactured on every freight delivery.
  | 'escrow_correction'
  // A correcting entry posted by the Admiral to reverse a mis-booked row.
  // History is never deleted — the bad posting stays and gains its offset.
  | 'correction'

export interface LedgerEntry {
  id: number
  profile_id: string
  timestamp: string
  kind: LedgerKind
  item_id: string | null
  quantity: number | null
  unit_price: number | null
  amount_signed: number
  counterparty: string | null
  order_id: string | null
  balance_after: number | null
  source_command: string
  raw_ref: string | null
}

export interface LedgerSummary {
  income: number
  expense: number
  net: number
  by_kind: Record<string, { count: number; total: number }>
  top_expenses: LedgerEntry[]
}

export interface LedgerResponse {
  rows: LedgerEntry[]
  summary: LedgerSummary
}

export interface ReconcileWindow {
  window_start: string
  window_end: string
  snapshot_delta: number
  ledger_delta: number
  residual: number
}
