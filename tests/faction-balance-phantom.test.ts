/**
 * The ledger mistook the faction treasury for a player's wallet.
 *
 * `view_faction_storage` answers with the faction's money in a top-level field
 * called `credits`:
 *
 *   {"action":"view_faction_storage","base_id":"crimson_war_citadel",
 *    "credits":256300,"faction_id":"fd63...","faction_name":"Stellar Alliance"}
 *
 * readBalance treated any top-level `credits` as the wallet, so on 2026-09-05 it
 * concluded Morg'Thar's balance had dropped from ~1.4M to 256,300 and booked a
 * -1,143,949 residual to reconcile. Ten minutes later the next command that
 * reported his real balance booked +1,143,791 straight back. Neither movement
 * happened; he had actually bought 120 ammo boxes for 1,200 credits.
 *
 * The Admiral found it by asking what a 1,143,791 purchase was for. Fleet-wide
 * the bug had manufactured 31 rows and 2,193,600 of fictional credit movement
 * across seven agents, and because residual rows carry no item or quantity they
 * showed in the transaction log as unexplained million-credit swings.
 *
 * `player.credits` is still trusted on a faction payload — it says whose it is.
 * Only the ambiguous top-level `credits` is refused there.
 */
import { test, expect, describe } from 'bun:test'

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** Mirrors readBalance + isFactionScoped in ledger.ts. */
function readBalance(r: Record<string, any>): number | null {
  const player = (r.player && typeof r.player === 'object') ? r.player : null
  const factionScoped =
    r.faction_id !== undefined || r.faction_tag !== undefined || r.faction_name !== undefined
  const topLevelCredits = factionScoped ? null : num(r.credits)
  return (player ? num(player.credits) : null) ?? num(r.wallet) ?? topLevelCredits ?? num(r.wallet_remaining)
}

describe('a faction payload never supplies a wallet balance', () => {
  test('the exact view_faction_storage response that caused it', () => {
    expect(readBalance({
      action: 'view_faction_storage',
      base_id: 'crimson_war_citadel',
      credits: 256300,
      faction_id: 'fd6310fbe39520866a0e5338391eb04a',
      faction_name: 'Stellar Alliance',
      faction_tag: 'STLR',
    })).toBeNull()
  })

  test('any one faction marker is enough to disqualify top-level credits', () => {
    expect(readBalance({ credits: 256300, faction_id: 'x' })).toBeNull()
    expect(readBalance({ credits: 256300, faction_tag: 'STLR' })).toBeNull()
    expect(readBalance({ credits: 256300, faction_name: 'Stellar Alliance' })).toBeNull()
  })

  test('faction_info, which also reports a treasury, is refused too', () => {
    expect(readBalance({ action: 'faction_info', credits: 256300, faction_tag: 'STLR' })).toBeNull()
  })
})

describe('ordinary wallet reads still work', () => {
  test('a plain buy result yields the wallet', () => {
    expect(readBalance({ action: 'buy', credits: 1398891 })).toBe(1398891)
  })

  test('player.credits wins wherever it appears', () => {
    expect(readBalance({ player: { credits: 500 }, credits: 999 })).toBe(500)
  })

  test('player.credits is still trusted ON a faction payload — it names its owner', () => {
    expect(readBalance({ player: { credits: 1398891 }, credits: 256300, faction_tag: 'STLR' })).toBe(1398891)
  })

  test('wallet outranks top-level credits', () => {
    expect(readBalance({ wallet: 700, credits: 999 })).toBe(700)
  })

  test("send_gift's wallet_remaining still resolves", () => {
    expect(readBalance({ action: 'send_gift', wallet_remaining: 42 })).toBe(42)
  })

  test('a response with no balance at all yields null, not a guess', () => {
    expect(readBalance({ action: 'jump' })).toBeNull()
  })
})
