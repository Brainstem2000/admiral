export type LedgerKind =
  | 'buy' | 'sell'
  | 'order_create' | 'order_fill' | 'order_cancel'
  | 'mission_reward' | 'fuel' | 'repair' | 'dock_fee' | 'combat'
  | 'insurance' | 'commission'
  | 'deposit' | 'withdraw' | 'transfer' | 'other'

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
