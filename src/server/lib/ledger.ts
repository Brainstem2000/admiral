import { getDb } from './db'
import type { LedgerEntry, LedgerKind, LedgerSummary, ReconcileWindow } from '../../shared/ledger-types'

type R = Record<string, unknown>

function str(v: unknown): string { return typeof v === 'string' ? v : '' }
function num(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null }

/** Ledger timestamps are sqlite 'YYYY-MM-DD HH:MM:SS' UTC — an ISO 'T'/'Z' since
 *  param would string-compare past every same-day row, silently dropping them. */
function normSince(s: string): string {
  return s.replace('T', ' ').replace(/Z$/, '').slice(0, 19)
}

interface LedgerRow {
  kind: LedgerKind
  item_id?: string | null
  quantity?: number | null
  unit_price?: number | null
  amount: number // signed: positive = income, negative = expense
  counterparty?: string | null
  order_id?: string | null
  balance_after?: number | null
}

export class LedgerCollector {
  /**
   * Extract credit movements from a game command result and book them as ledger rows.
   * Called ONLY on the normal success path for NON-query commands — must never throw.
   * Amounts are read verbatim from the result; rows without a readable number are skipped.
   */
  static processCommandResult(command: string, result: unknown, profileId: string, profileName: string): void {
    try {
      if (!result || typeof result !== 'object') return
      let r = result as R
      // Some connections nest the payload one level down ({ result: {...} })
      if (!('action' in r) && r.result && typeof r.result === 'object') r = r.result as R
      // lib_v2 mutations resolve to the state DELTA; the command's own response
      // payload (total_earned, fills, ...) is nested at delta.details. Without
      // this unwrap every lib_v2 trade parsed as an empty row and was skipped
      // (observed: financial_ledger flatlined the moment agents moved to lib_v2).
      if (!('action' in r) && r.details && typeof r.details === 'object') r = r.details as R

      // Normalize command: strip spacemolt_ and v2 group prefixes; the result's own
      // `action` field is the most authoritative dispatch key when present.
      const bare = command.replace(/^spacemolt_/, '')
        .replace(/^(?:market|storage|social|intel|faction|faction_admin|salvage|catalog|ship|battle|transfer|facility|auth)_/, '')
      const action = str(r.action) || bare

      const rows = this.mapResult(action, r)
      for (const row of rows) this.insert(profileId, row, command, r)
    } catch { /* ledger must never break game execution */ }
  }

  /**
   * Book async credit events delivered via notifications (order fills, combat bounties,
   * mission rewards). Only events carrying an explicit credit amount are recorded.
   * Called from the Agent's onNotification handler — the single chokepoint every
   * connection funnels notifications through, regardless of which command drained them.
   */
  static processNotifications(notifications: unknown[], profileId: string, profileName: string): void {
    try {
      if (!Array.isArray(notifications)) return
      for (const n of notifications) {
        if (!n || typeof n === 'string' || typeof n !== 'object') continue
        const notif = n as R
        // http/mcp notifications carry `data`; websocket pushes carry `payload`.
        let data = (notif.data ?? notif.payload) as R | string | undefined
        if (typeof data === 'string') {
          try { data = JSON.parse(data) as R } catch { continue }
        }
        if (!data || typeof data !== 'object') continue

        // Combat bounty: {"combat_xp":51,"credits_earned":529,"pirate_id":...,"tick"?:N}
        const bounty = num(data.credits_earned)
        if (bounty !== null && bounty !== 0 && (data.pirate_id || data.target_id)) {
          const pid = str(data.pirate_id || data.target_id)
          const tick = num(data.tick)
          this.insert(profileId, {
            kind: 'combat',
            amount: bounty,
            counterparty: str(data.pirate_name || data.target_name) || null,
            // Informational only ('combat' is not dedupe-indexed): prefer the
            // notification's unique id — live bounty payloads carry no tick.
            order_id: str(notif.id) || (pid && tick !== null ? `${pid}:${tick}` : null),
          }, 'notification', data)
          continue
        }

        // Mission reward: {"mission_id":...,"mission_title":...,"rewards":{"credits":N,...}}
        const rewards = (data.rewards && typeof data.rewards === 'object') ? (data.rewards as R) : null
        const missionCredits = rewards ? num(rewards.credits) : null
        if (data.mission_id && missionCredits !== null && missionCredits !== 0) {
          this.insert(profileId, {
            kind: 'mission_reward',
            amount: missionCredits,
            counterparty: str(data.mission_title) || null,
            order_id: str(data.mission_id) || null,
          }, 'notification', data)
          continue
        }

        // Exchange fill: {item_id, price, quantity, role, total, order_id?}. Only the
        // seller side moves wallet credits on fill — a buy-order fill draws from escrow
        // already booked at order_create, so booking it again would double-count.
        const role = str(data.role)
        const total = num(data.total)
        if (role === 'seller' && total !== null && total !== 0 && data.item_id) {
          this.insert(profileId, {
            kind: 'order_fill',
            item_id: str(data.item_id) || null,
            quantity: num(data.quantity),
            unit_price: num(data.price),
            amount: total,
            order_id: str(data.order_id) || null,
          }, 'notification', data)
        } else if (role === 'buyer' && data.order_id) {
          // Buyer-side fill: the credits already left the wallet as escrow at
          // order_create — book a zero-amount marker so cashflow stays correct
          // while the UI can release the escrowed amount for this order.
          this.insert(profileId, {
            kind: 'order_fill',
            item_id: str(data.item_id) || null,
            quantity: num(data.quantity),
            unit_price: num(data.price),
            amount: 0,
            order_id: str(data.order_id) || null,
          }, 'notification', data)
        }
      }
    } catch { /* ledger must never break game execution */ }
  }

  /** Map a command result to zero or more ledger rows. Field names verified against live results. */
  private static mapResult(action: string, r: R): LedgerRow[] {
    const balance = this.readBalance(r)
    const rows: LedgerRow[] = []

    switch (action) {
      case 'buy': {
        // { action: buy, item_id, quantity, total_cost, fills: [{price_each, quantity, counterparty}] }
        const cost = num(r.total_cost)
        if (cost === null || cost === 0) break
        const qty = num(r.quantity)
        rows.push({
          kind: 'buy',
          item_id: str(r.item_id) || null,
          quantity: qty,
          unit_price: qty && qty > 0 ? cost / qty : null,
          amount: -cost,
          counterparty: this.fillCounterparties(r),
          balance_after: balance,
        })
        break
      }
      case 'sell': {
        // { action: sell, item_id, quantity_sold, total_earned, fills: [...] }
        const earned = num(r.total_earned) ?? num(r.total_revenue)
        if (earned === null || earned === 0) break
        const qty = num(r.quantity_sold) ?? num(r.quantity)
        rows.push({
          kind: 'sell',
          item_id: str(r.item_id) || null,
          quantity: qty,
          unit_price: qty && qty > 0 ? earned / qty : null,
          amount: earned,
          counterparty: this.fillCounterparties(r),
          balance_after: balance,
        })
        break
      }
      case 'create_buy_order': {
        // { action: create_buy_order, item_id, quantity, price_each, total_escrowed, listing_fee, order_id }
        const orderId = str(r.order_id) || null
        const escrowed = num(r.total_escrowed)
        if (escrowed !== null && escrowed !== 0) {
          rows.push({
            kind: 'order_create',
            item_id: str(r.item_id) || null,
            quantity: num(r.quantity),
            unit_price: num(r.price_each),
            amount: -escrowed,
            order_id: orderId,
            balance_after: balance,
          })
        }
        // Immediate fills: a buy order matching standing sell orders spends from the
        // wallet directly ({ fills, total_spent, quantity_filled }, total_escrowed: 0
        // when fully matched) — disjoint from any escrowed remainder.
        const spent = num(r.total_spent)
        if (spent !== null && spent !== 0) {
          const filled = num(r.quantity_filled)
          rows.push({
            kind: 'buy',
            item_id: str(r.item_id) || null,
            quantity: filled,
            unit_price: filled && filled > 0 ? spent / filled : null,
            amount: -spent,
            counterparty: this.fillCounterparties(r),
            order_id: orderId,
            balance_after: balance,
          })
        }
        this.pushListingFee(rows, r, orderId)
        break
      }
      case 'create_sell_order': {
        // { action: create_sell_order, item_id, quantity, price_each, listing_fee, order_id }
        // Items (not credits) are escrowed — only the listing fee moves the wallet.
        // Defensive: an immediately-matched sell order would pay out via total_earned.
        const orderId = str(r.order_id) || null
        const earned = num(r.total_earned)
        if (earned !== null && earned !== 0) {
          const filled = num(r.quantity_filled)
          rows.push({
            kind: 'sell',
            item_id: str(r.item_id) || null,
            quantity: filled,
            unit_price: filled && filled > 0 ? earned / filled : null,
            amount: earned,
            counterparty: this.fillCounterparties(r),
            order_id: orderId,
            balance_after: balance,
          })
        }
        this.pushListingFee(rows, r, orderId)
        break
      }
      case 'cancel_order': {
        // { action: cancel_order, order_id, returned_credits }
        const returned = num(r.returned_credits)
        if (returned === null || returned === 0) break
        rows.push({
          kind: 'order_cancel',
          amount: returned,
          order_id: str(r.order_id) || null,
          balance_after: balance,
        })
        break
      }
      case 'complete_mission': {
        const rewards = (r.rewards && typeof r.rewards === 'object') ? (r.rewards as R) : null
        const credits = (rewards ? num(rewards.credits) : null) ?? num(r.credits_earned) ?? num(r.reward_credits)
        if (credits === null || credits === 0) break
        rows.push({
          kind: 'mission_reward',
          amount: credits,
          counterparty: str(r.mission_title || r.title) || null,
          order_id: str(r.mission_id) || null,
          balance_after: balance,
        })
        break
      }
      case 'refuel': {
        // { action: refuel, source: station, fuel, cost } — item-based refuel has no cost field
        const cost = num(r.cost)
        if (cost === null || cost === 0) break
        rows.push({ kind: 'fuel', quantity: num(r.fuel), amount: -cost, balance_after: balance })
        break
      }
      case 'repair': {
        // { action: repair, source: station, repaired, cost } — repair_kit repairs are free
        const cost = num(r.cost)
        if (cost === null || cost === 0) break
        rows.push({ kind: 'repair', quantity: num(r.repaired), amount: -cost, balance_after: balance })
        break
      }
      case 'buy_insurance': {
        // { action: buy_insurance, premium, coverage, ticks, ... } — premium is the wallet cost.
        const cost = num(r.premium) ?? num(r.cost) ?? num(r.total_cost)
        if (cost === null || cost === 0) break
        rows.push({ kind: 'insurance', amount: -cost, counterparty: str(r.ship_class || r.ship_name) || null, balance_after: balance })
        break
      }
      case 'commission_ship': {
        // { action: commission_ship, ship_class, credit_cost/total_cost, commission_id } — the
        // credits-only portion of a build order hits the wallet (materials are supplied separately).
        const cost = num(r.credits_paid) ?? num(r.credit_cost) ?? num(r.total_cost) ?? num(r.cost)
        if (cost === null || cost === 0) break
        rows.push({ kind: 'commission', amount: -cost, counterparty: str(r.ship_class || r.class_id) || null, order_id: str(r.commission_id) || null, balance_after: balance })
        break
      }
      case 'supply_commission': {
        // Supplying build materials can also pay a reduced credit portion — book only when
        // credits actually moved (material-only supplies don't touch the wallet).
        const cost = num(r.credits_paid) ?? num(r.credit_cost) ?? num(r.cost)
        if (cost === null || cost === 0) break
        rows.push({ kind: 'commission', amount: -cost, counterparty: str(r.ship_class) || null, order_id: str(r.commission_id) || null, balance_after: balance })
        break
      }
      case 'deposit_credits': {
        const amount = num(r.amount) ?? num(r.credits_deposited) ?? num(r.deposited)
        if (amount === null || amount === 0) break
        rows.push({ kind: 'deposit', amount: -amount, counterparty: str(r.faction_name || r.base_id) || null, balance_after: balance })
        break
      }
      case 'withdraw_credits': {
        const amount = num(r.amount) ?? num(r.credits_withdrawn) ?? num(r.withdrawn)
        if (amount === null || amount === 0) break
        rows.push({ kind: 'withdraw', amount, counterparty: str(r.faction_name || r.base_id) || null, balance_after: balance })
        break
      }
    }

    return rows
  }

  /** Listing fee is booked separately from escrow (kind 'other', same order_id). */
  private static pushListingFee(rows: LedgerRow[], r: R, orderId: string | null): void {
    const fee = num(r.listing_fee)
    if (fee === null || fee === 0) return
    rows.push({
      kind: 'other',
      item_id: str(r.item_id) || null,
      amount: -fee,
      order_id: orderId,
      balance_after: this.readBalance(r),
    })
  }

  /** Wallet balance when the result echoes it. NOT vault/faction credits (those are pools, not the wallet). */
  private static readBalance(r: R): number | null {
    const player = (r.player && typeof r.player === 'object') ? (r.player as R) : null
    return (player ? num(player.credits) : null) ?? num(r.wallet)
  }

  private static fillCounterparties(r: R): string | null {
    const fills = Array.isArray(r.fills) ? (r.fills as R[]) : []
    const names: string[] = []
    for (const f of fills) {
      if (!f || typeof f !== 'object') continue
      const cp = str((f as R).counterparty)
      if (cp && !names.includes(cp)) names.push(cp)
    }
    return names.length > 0 ? names.join(', ') : null
  }

  private static insert(profileId: string, row: LedgerRow, sourceCommand: string, raw: unknown): void {
    let rawRef: string | null = null
    try { rawRef = JSON.stringify(raw).slice(0, 200) } catch { /* ignore */ }
    // INSERT OR IGNORE: the partial UNIQUE index (profile_id, order_id, kind) absorbs
    // replays of once-per-order events (order_create/order_cancel/mission_reward/other).
    // order_fill and combat are NOT indexed — partial fills legitimately repeat per
    // order_id, and notifications are single-delivery via the agent handler chokepoint.
    getDb().query(`
      INSERT OR IGNORE INTO financial_ledger
        (profile_id, kind, item_id, quantity, unit_price, amount_signed, counterparty, order_id, balance_after, source_command, raw_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      profileId,
      row.kind,
      row.item_id ?? null,
      row.quantity ?? null,
      row.unit_price !== null && row.unit_price !== undefined ? Math.round(row.unit_price * 100) / 100 : null,
      Math.round(row.amount),
      row.counterparty ?? null,
      row.order_id ?? null,
      row.balance_after ?? null,
      sourceCommand,
      rawRef,
    )
  }

  // --- Read accessors (REST API) ---

  static getEntries(opts: {
    profileId: string
    since?: string
    kind?: string
    itemId?: string
    limit?: number
  }): LedgerEntry[] {
    try {
      const conditions = ['profile_id = ?']
      const params: (string | number)[] = [opts.profileId]
      if (opts.since) { conditions.push('timestamp >= ?'); params.push(normSince(opts.since)) }
      if (opts.kind) { conditions.push('kind = ?'); params.push(opts.kind) }
      if (opts.itemId) { conditions.push('item_id = ?'); params.push(opts.itemId) }
      const limit = Math.min(Math.max(opts.limit || 500, 1), 2000)
      return getDb().query(
        `SELECT * FROM financial_ledger WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ?`
      ).all(...params, limit) as LedgerEntry[]
    } catch { return [] }
  }

  static getSummary(opts: { profileId: string; since?: string; kind?: string; itemId?: string }): LedgerSummary {
    const empty: LedgerSummary = { income: 0, expense: 0, net: 0, by_kind: {}, top_expenses: [] }
    try {
      const conditions = ['profile_id = ?']
      const params: string[] = [opts.profileId]
      if (opts.since) { conditions.push('timestamp >= ?'); params.push(normSince(opts.since)) }
      if (opts.kind) { conditions.push('kind = ?'); params.push(opts.kind) }
      if (opts.itemId) { conditions.push('item_id = ?'); params.push(opts.itemId) }
      const where = conditions.join(' AND ')
      const db = getDb()

      const totals = db.query(`
        SELECT COALESCE(SUM(CASE WHEN amount_signed > 0 THEN amount_signed ELSE 0 END), 0) AS income,
               COALESCE(SUM(CASE WHEN amount_signed < 0 THEN amount_signed ELSE 0 END), 0) AS expense,
               COALESCE(SUM(amount_signed), 0) AS net
        FROM financial_ledger WHERE ${where}
      `).get(...params) as { income: number; expense: number; net: number }

      const byKind = db.query(`
        SELECT kind, COUNT(*) AS count, COALESCE(SUM(amount_signed), 0) AS total
        FROM financial_ledger WHERE ${where} GROUP BY kind
      `).all(...params) as { kind: string; count: number; total: number }[]
      const by_kind: Record<string, { count: number; total: number }> = {}
      for (const k of byKind) by_kind[k.kind] = { count: k.count, total: k.total }

      const top_expenses = db.query(`
        SELECT * FROM financial_ledger WHERE ${where} AND amount_signed < 0
        ORDER BY amount_signed ASC LIMIT 5
      `).all(...params) as LedgerEntry[]

      return { income: totals.income, expense: totals.expense, net: totals.net, by_kind, top_expenses }
    } catch { return empty }
  }

  /**
   * Reconciliation: for each window between consecutive financial_snapshots, compare the
   * snapshot wallet delta against the sum of booked ledger rows. A large residual means
   * untracked credit movement (or a mapping gap).
   */
  static reconcile(profileId: string, since?: string): ReconcileWindow[] {
    try {
      const db = getDb()
      const sinceTs = since ? normSince(since) : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
      // Most RECENT 500 snapshots (then re-ordered ascending): long ranges must
      // reconcile the current window, not a stale ~42h slice at the start of `since`.
      const snaps = (db.query(`
        SELECT timestamp, wallet FROM financial_snapshots
        WHERE profile_id = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 500
      `).all(profileId, sinceTs) as { timestamp: string; wallet: number }[]).reverse()
      if (snaps.length < 2) return []

      const ledgerRows = db.query(`
        SELECT timestamp, amount_signed FROM financial_ledger
        WHERE profile_id = ? AND timestamp > ? AND timestamp <= ?
        ORDER BY timestamp ASC
      `).all(profileId, snaps[0].timestamp, snaps[snaps.length - 1].timestamp) as { timestamp: string; amount_signed: number }[]

      const windows: ReconcileWindow[] = []
      let li = 0
      for (let i = 1; i < snaps.length; i++) {
        const start = snaps[i - 1]
        const end = snaps[i]
        let ledgerDelta = 0
        while (li < ledgerRows.length && ledgerRows[li].timestamp <= end.timestamp) {
          if (ledgerRows[li].timestamp > start.timestamp) ledgerDelta += ledgerRows[li].amount_signed
          li++
        }
        const snapshotDelta = end.wallet - start.wallet
        windows.push({
          window_start: start.timestamp,
          window_end: end.timestamp,
          snapshot_delta: snapshotDelta,
          ledger_delta: ledgerDelta,
          residual: snapshotDelta - ledgerDelta,
        })
      }
      return windows
    } catch { return [] }
  }
}
