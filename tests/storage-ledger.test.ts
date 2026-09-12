import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Storage is a LEDGER, not a snapshot (Brian, 2026-09-12: "every single
 * transaction is recorded in the database and there's no question about its
 * legitimacy").
 *
 * storage_inventory used to be refreshed only by view_storage, so every
 * deposit, withdrawal, gift, fill, craft and ship switch left it wrong until
 * the next view — it told the Admiral CyberSapper held 4 focused_crystal at War
 * Citadel while the live view showed 0 (and 766 fury_crystal). Now every change
 * goes through applyStorageDelta and lands in storage_ledger: command results
 * apply at once (exact), action-log events attach to those rows or are placed
 * from position_history, unplaceable events are journaled and mark the profile
 * dirty, and a view_storage snapshot reconciles — writing a ledger row for every
 * item that drifted — instead of silently overwriting.
 *
 * Runs in a subprocess because db.ts binds DB_PATH from cwd at module load.
 */

const tempDirectories: string[] = []
afterEach(() => {
  for (const d of tempDirectories.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

let cached: Record<string, any> | null = null
async function runHelper(): Promise<Record<string, any>> {
  if (cached) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-storage-ledger-'))
  tempDirectories.push(dir)
  const helper = path.join(import.meta.dir, 'helpers', 'storage-ledger-check.ts')
  const child = Bun.spawn([process.execPath, helper, dir], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, err).toBe(0)
  const line = out.split('\n').find(l => l.startsWith('__RESULT__'))
  expect(line, `no __RESULT__ in:\n${out}\n${err}`).toBeDefined()
  cached = JSON.parse(line!.slice('__RESULT__'.length))
  return cached!
}

describe('storage ledger — command-time hooks (confidence exact)', () => {
  test('a deposit through executeTool (lib_v2 delta shape) lands in storage with a command ledger row', async () => {
    const { deposit } = await runHelper()
    expect(deposit.qty).toBe(10)
    expect(deposit.dirty).toBe(false)
    expect(deposit.ledger).toEqual([{ station: 'crimson_war_citadel', item: 'fury_alloy', delta: 10, source: 'command', ref: 'deposit', confidence: 'exact', event_id: null }])
  }, 60_000)

  test('a withdraw (v1 bare shape) decrements the seeded snapshot and journals it', async () => {
    const { withdraw } = await runHelper()
    expect(withdraw.qty).toBe(60)
    expect(withdraw.ledger.at(-1)).toMatchObject({ item: 'steel_plate', delta: -40, source: 'command', confidence: 'exact' })
  }, 60_000)

  test('an item gift from storage debits the sender and credits the fleet recipient at the same base', async () => {
    const { gift, giftFromCargo, giftOutsider } = await runHelper()
    expect(gift.rows).toBe(2)
    expect(gift.sender).toBe(736)
    expect(gift.recipient).toBe(30)
    expect(gift.mirrored).toEqual([{ profileId: 'p-morg', itemId: 'fury_crystal', quantity: 30, station: 'crimson_war_citadel' }])
    expect(gift.senderLedger.at(-1)).toMatchObject({ delta: -30, ref: 'send_gift', confidence: 'exact', station: 'crimson_war_citadel' })
    expect(gift.recipientLedger).toEqual([{ station: 'crimson_war_citadel', item: 'fury_crystal', delta: 30, source: 'command', ref: 'send_gift~mirror', confidence: 'exact', event_id: null }])
    // from cargo: the sender's storage is untouched, the recipient's still gains
    expect(giftFromCargo).toEqual({ rows: 1, sender: 0, recipient: 9 })
    // an outsider gets no mirror row
    expect(giftOutsider).toEqual({ rows: 1, mirrored: 0, sender: 735 })
  }, 60_000)

  test('buy/create_sell_order/switch_ship/craft apply only what the response itemises; install_mod and supply_commission never guess', async () => {
    const { hooks } = await runHelper()
    expect(hooks.buy).toBe(1)          // delivered_to_storage: 3
    expect(hooks.buyCargo).toBe(0)     // delivered_to_cargo only
    expect(hooks.steel).toBe(3)
    expect(hooks.sw).toBe(1)
    expect(hooks.housing).toBe(7)
    expect(hooks.craft).toBe(1)
    expect(hooks.carapace).toBe(0)     // -4 on a station that had none: journaled, row deleted at <= 0
    expect(hooks.ledger.some((r: any) => r.item === 'creature_carapace' && r.delta === -4 && r.ref === 'craft')).toBe(true)
    expect(hooks.sell).toBe(1)
    expect(hooks.vanadium).toBe(0)
    expect(hooks.ledger.some((r: any) => r.item === 'vanadium_ore' && r.delta === -40 && r.ref === 'create_sell_order')).toBe(true)
    expect(hooks.mod).toBe(0)
    expect(hooks.supplyDirty).toContain('supply_commission')
    expect(hooks.undocked).toEqual({ rows: 1, dirty: 'deposit: station unknown' })
    expect(hooks.ledger.some((r: any) => r.item === 'iron_ore' && r.confidence === 'unplaced' && r.station === null)).toBe(true)
    expect(hooks.errored).toBe(0)
  }, 60_000)
})

describe('storage ledger — action-log events', () => {
  test('an event that matches a command-time row is attached to it and never applied twice', async () => {
    const { dedupe } = await runHelper()
    expect(dedupe.sent).toEqual({ applied: 0, attached: 1, unplaced: 0, reflected: 0, dirtyReasons: [] })
    expect(dedupe.recv).toEqual({ applied: 0, attached: 1, unplaced: 0, reflected: 0, dirtyReasons: [] })
    expect(dedupe.depSummary).toEqual({ applied: 0, attached: 1, unplaced: 0, reflected: 0, dirtyReasons: [] })
    expect(dedupe.sender).toBe(735)
    expect(dedupe.recipient).toBe(30)
    expect(dedupe.depQty).toBe(10) // quantity unchanged
    expect(dedupe.senderLedger.find((r: any) => r.delta === -30).event_id).toBe(101)
    expect(dedupe.recipientLedger[0].event_id).toBe(202)
    // an attached event is not a placement failure: nobody is marked dirty by it
    expect([dedupe.depDirty, dedupe.sapperDirty, dedupe.morgDirty]).toEqual([false, false, false])
  }, 60_000)

  test('an unmatched event is placed from position_history; after an undock it is not', async () => {
    const { placed } = await runHelper()
    expect(placed.s).toMatchObject({ applied: 2, attached: 0, unplaced: 0 })
    expect(placed.gas).toBe(1)
    expect(placed.rad).toBe(2)
    expect(placed.ledger[0]).toMatchObject({ station: 'crimson_war_citadel', source: 'action_log', ref: 'storage.bulk_deposit', confidence: 'placed', event_id: 404 })
    expect(placed.positionAt).toBe('crimson_war_citadel')
    expect(placed.placeDirty).toBe(false)
    // seen undocked since: the deposit is unplaced, not pinned to the old station
    expect(placed.s2).toMatchObject({ applied: 0, unplaced: 1 })
    expect(placed.iron).toBe(0)
    expect(placed.placeDirtyAfterUndock).toBe(true)
    // an observation older than 10 minutes places nothing
    expect(placed.s3).toMatchObject({ applied: 0, unplaced: 1 })
    expect(placed.lostDirty).toBe(true)
    expect(placed.lostLedger[0]).toMatchObject({ station: null, confidence: 'unplaced', delta: -5 })
    expect(placed.throttled).toBe(true)
  }, 60_000)

  test('an unplaceable event is journaled with station NULL and marks the profile dirty without touching quantities', async () => {
    const { unplaced } = await runHelper()
    expect(unplaced.s).toMatchObject({ applied: 0, attached: 0, unplaced: 1 })
    expect(unplaced.qty).toBe(0)
    expect(unplaced.dirty).toBe(true)
    expect(unplaced.row).toEqual([{ station: null, item: 'gold_ore', delta: 12, source: 'action_log', ref: 'trading.gift_received', confidence: 'unplaced', event_id: 507 }])
  }, 60_000)

  test('crafting.queued consumes inputs×runs, completed produces outputs×runs, cancelled refunds; older-than-snapshot completions are skipped', async () => {
    const { crafting } = await runHelper()
    expect(crafting.facilityStation).toEqual(['crimson_war_citadel', null])
    expect(crafting.q).toMatchObject({ applied: 1, unplaced: 0 })
    expect(crafting.done).toMatchObject({ applied: 1 })
    expect(crafting.cancel).toMatchObject({ applied: 1 })
    expect(crafting.carapace).toBe(20 - 6 + 2)
    expect(crafting.plating).toBe(3)
    expect(crafting.ledger.map((r: any) => [r.item, r.delta, r.confidence, r.event_id])).toEqual([
      ['creature_carapace', 20, 'exact', null], ['creature_carapace', -6, 'exact', 701], ['carapace_plating', 3, 'exact', 702], ['creature_carapace', 2, 'exact', 703],
    ])
    expect(crafting.stale).toMatchObject({ applied: 0, reflected: 1 })
    expect(crafting.faction.effects).toEqual([])
    expect(crafting.unknown.dirty).toContain('recipe mystery unknown')
    expect(crafting.priv).toEqual([{ item_id: 'creature_carapace', delta: -6, station_id: 'the_obsidian_well', confidence: 'placed' }])
  }, 60_000)

  test('spot fills are left to the buy/sell command hook; order fills and cancels place at the order station', async () => {
    const { fills } = await runHelper()
    expect(fills.spot).toEqual([])
    expect(fills.order).toEqual([{ item_id: 'fluorine_gas', delta: 5, station_id: 'grand_exchange_station', confidence: 'placed' }])
    expect(fills.ambiguous).toEqual([['unplaced'], null])   // placement failures ride on the effect; the applier reports them
    expect(fills.sellerFill).toEqual([])
    expect(fills.cancelled).toEqual([{ item_id: 'vanadium_ore', delta: 48, station_id: 'nova_terra_central', confidence: 'placed' }])
  }, 60_000)

  test('ingestActionLog banks a cold category without applying, applies the warm page once, and ignores a replay', async () => {
    const { ingest } = await runHelper()
    expect(ingest.first.added).toBe(1)
    expect(ingest.first.storage.applied).toBe(0)
    expect(ingest.oldOre).toBe(0)
    expect(ingest.second.added).toBe(1)
    expect(ingest.second.storage).toMatchObject({ applied: 1, unplaced: 0 })
    expect(ingest.newOre).toBe(7)
    expect(ingest.third.added).toBe(0)
    expect(ingest.third.storage.applied).toBe(0)
    expect(ingest.ledger).toEqual([{ station: 'crimson_war_citadel', item: 'new_ore', delta: 7, source: 'action_log', ref: 'storage.deposit_items', confidence: 'placed', event_id: 2 }])
  }, 60_000)
})

describe('storage ledger — snapshots reconcile', () => {
  test('a view_storage explains every corrected item with a snapshot row, clears dirty, and stamps observed_at', async () => {
    const { reconcile, logs } = await runHelper()
    expect(reconcile.before).toMatchObject({ qty: 10, dirty: true, observed: null })
    expect(reconcile.drift.sort((a: any, b: any) => a.item_id.localeCompare(b.item_id))).toEqual([
      { item_id: 'fury_alloy', before: 10, after: 7, delta: -3 },
      { item_id: 'fury_crystal', before: 0, after: 766, delta: 766 },
    ])
    expect(reconcile.line).toBe('storage reconciled at crimson_war_citadel: 2 items drifted (fury_crystal +766, fury_alloy −3)')
    expect(reconcile.after).toEqual([{ item: 'fury_alloy', qty: 7, observed: true }, { item: 'fury_crystal', qty: 766, observed: true }])
    expect(reconcile.dirty).toBe(false)
    expect(reconcile.ledger.filter((r: any) => r.source === 'snapshot').map((r: any) => [r.item, r.delta, r.ref, r.confidence]))
      .toEqual(expect.arrayContaining([['fury_alloy', -3, 'view_storage', 'exact'], ['fury_crystal', 766, 'view_storage', 'exact']]))
    expect(reconcile.ageMs).toBeLessThan(60_000)
    expect(reconcile.noDrift).toBe(0)
    expect(reconcile.emptyStationClock).toBe(true)
    expect(logs).toEqual([])   // the helper's direct calls do not log; the tool/agent paths do
  }, 60_000)

  test('the migration adds observed_at and the new tables', async () => {
    const { schema } = await runHelper()
    expect(schema.cols).toContain('observed_at')
    expect(schema.tables).toEqual(['position_history', 'storage_ledger', 'storage_snapshots'])
    expect(schema.migrated).toBe(7)
  }, 60_000)
})
