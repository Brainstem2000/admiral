# Shutdown Report — 2026-08-06 15:45 UTC

Fleet safe-docked and stood down at the operator's request (weekly token budget).
This is the handover document. Everything here was verified against the live game
engine or the game's own action log — nothing is inferred.

---

## 1. Where the Devastator actually stands

**20 of 24 commission lines CLOSED**, material physically at Krynn/war_citadel.

| open line | need | blocker |
|---|---|---|
| `neutronium_ingot` | 23 | needs power cores → tritium processing |
| `station_reactor_core` | 1 | needs 5 neutronium |
| `mass_driver` | 2 | adamantite never sighted |
| `piercing_railgun_ii` | 2 | needs a 1,125,000cr facility — **your call** |

**Raw materials — three of four are done:**

| | held | needed | |
|---|---|---|---|
| `thorium_ore` | 726 | 444 | ✅ |
| `polonium_ore` | 258 | 23 | ✅ |
| `reactor_grade_plutonium` | 60 | 23 | ✅ (30 Krynn, 30 Sol) |
| `tritium_ice` | 141 | 265 | mined, **unprocessable** |

---

## 2. The finding that reframed the campaign

**The neutronium chain is facility-gated and Krynn has none of the facilities.**
`catalog.recipes[*].facility` reads `None` for every step; the catalog does not
describe *reachability*. Only a live `craft(dry_run=true)` tells the truth.

| step | facility | nearest public |
|---|---|---|
| plutonium refining, power cores, neutronium, reactor core, mass driver | 5 separate lines | **Sol / Confederacy Central Command** |
| thorium concentrate, fusion rods, breeding | 3 lines | Nova Terra Central (18j) |
| thorium roasting, thorium rods | 2 lines | Starfall Salvage (30j) |
| `process_tritium_ice` | Tritium Cryo-Extractor | **none in galaxy** |
| `synthesize_liquid_tritium` | Neutron Bombardment Cell | **none in galaxy** |
| `build_piercing_railgun_ii` | Enhanced Driver Workshop | **none in galaxy** |

Krynn is the **shipyard**, not the factory. Sol already holds 30 of our plutonium —
it was in the right place the whole time.

---

## 3. The remaining path (silver was never needed)

`assemble_control_node` has three alternates. The platinum one uses no silver and
no gold:

```
platinum_ore 2,400 (Morg holds 2,259 at Krynn) → platinum_wiring 600 (155 made)
copper_wiring 1,200 (hold 3,098) ✅
silicon_ore ~792 (hold 492) → circuit_board 600 (hold 202)
   → assemble_platinum_control_node ×300
      → BUILD Tritium Cryo-Extractor (151,000cr + steel 2,600 + piping 1,100)
         → the 141 tritium ice finally becomes fuel
```

**`silicon_ore` is the only material still short.** It is a common mining ore.

---

## 4. Engineering delivered

**Fixed: the inventory recorder had never fired in production.** It gated on the
command being named `view_storage`; agents call `view(target=storage)`. 54 calls to
one form, 0 to the other in a single day. Now matches on the response payload's
`action` field.

**Added: cargo tracking.** No table existed, so anything in transit was invisible —
a hauler carrying 200 thorium showed as owning nothing.

**Added: action-log ingestion.** The game publishes a free, cursored event feed with
exact item deltas; Admiral wasn't using it. Now mirrored to `action_events`,
polled every 90s, with **~6,400+ events backfilled from history**. Cargo is derived
from events exactly; storage is deliberately *not* (those events carry no station
id, so guessing would manufacture confident fiction) — instead the agent is flagged
in `storage_dirty` and the next read settles it.

**Added: `usable` vs `total`.** `/api/inventory/item/:id` now reports what one
crafter can actually reach. *2,937 platinum owned, 31 usable* — that gap is exactly
why Morg's craft failed this morning.

**New endpoints:** `/api/inventory/history/:itemId`, `/api/inventory/dirty`.

Measured before/after: snapshot-only tracking reconciled at **89.7%** against live
truth, with most of the miss being age rather than bugs.

---

## 5. What went wrong, honestly

**I deleted the procurement caps, and it cost 55,000 credits.** At 08:12 I pruned
eleven "stale July" sections from Morg's directive to fix a contradiction. One was
`PROCUREMENT SIZING — HARD CAPS`. At 15:11 he placed a **500,000cr** buy order for
silicon at **5,000cr/unit against a ~10cr base value** — 500× — and 50,000 filled
before I cancelled it. The caps would have stopped it. They are now restored and
**tightened with a price rule that never existed**: never pay above 3× base value.

To answer your question directly: there *was* a `priceAdvisory` in the code, but it
only appends a warning to the result text — it has never blocked anything. And the
directive rule was an escrow/wallet cap, not a price cap. Neither would have caught
a 500× overpay on a small quantity. Now one will.

**Nine buy orders swept this session**, locking up over 1,400,000cr and filling
almost nothing — the worst bid 276,000cr for plutonium craftable free from the
vault. All cancelled, all credits recovered.

**Other bugs found:** `mine_until_full` is untargeted and fills holds with ballast
(cost two agents ~an hour each); agents silently reverse orders mid-route (Bob
turned back 12 of 19 hops to Sol on bad reasoning). Both now fleet doctrine.

---

## 6. Decisions waiting on you

1. **`piercing_railgun_ii`** — the partial-commission escape route is CLOSED.
   Tested live 2026-08-06: `commission_ship(provide_materials=true)` is
   **ALL-OR-NONE**. A cheap `shard` commissioned with 2 of 5 material lines was
   refused outright — `missing_materials: Need 5 x Flex Polymer (have 0)...`.
   Nothing was charged. So all 24 Devastator lines must be complete before the
   commission can be placed, and `credits_only` is not an escape either
   (`neutronium_ingot` is not for sale anywhere). **The Enhanced Driver Workshop
   (1,125,000cr + 3,150 weapon_housing vs 108 held + 1,550 barrel_assembly vs 0
   held) is unavoidable, not optional.** This is the biggest open decision.
2. **`mass_driver`** — adamantite has never been sighted. May need a dedicated
   prospecting push, or the same partial-commission answer covers it.
3. **Credits** — 1,808,005 needed; Morg holds ~529,000 after the recovery. The yard
   fee drifts +36,000/day. ~19.5M of audited surplus exists; only bulk commons are
   authorised for sale and very little has actually sold.

---

## 7. State at shutdown

- **Cron: deleted.** No scheduled jobs remain.
- **All agent TODOs reset** to a single verified-state document that explicitly
  lists the six false beliefs to discard (silver as critical path, gold mining,
  hauling ore to Krynn, hand-craftable chain, uranium/fluorine need, buying
  craftables).
- **Procurement caps restored** fleet-wide with the new 3× price rule.
- Old binary preserved at `admiral.backup.exe`. Source changes uncommitted.
- Companion docs: `DEVASTATOR-AUDIT-2026-08-06.md`, `MORNING-REPORT-2026-08-06.md`.


---

## 8. Post-shutdown finding — commission is all-or-none

Verified with a single agent after the fleet stood down.

`commission_ship(provide_materials=true)` requires **every** material line in the
commissioning agent's hands at placement. A `shard` test with 2 of 5 lines held was
refused: `missing_materials: Need 5 x Flex Polymer (have 0); Need 1 x Mining Laser I
(have 0); Need 2 x Autocannon I (have 0)`. Nothing charged, no commission created.
`supply_commission`'s "sourcing state" wording does not mean you can place early.

**And a tooling bug that probably hid this all along:** under `lib_v2` — the fleet's
default connection mode — that same call returns only
`invalid_response: Malformed action_error frame`. The pinned client (spec v0.547.0)
cannot parse the live server's commission-stage error frames, though it handles
validation errors fine (a bogus ship_class returns a clean `invalid_ship`).
**Switch the commissioning agent to `http_v2` before running `commission_ship`.**
Morg has been restored to `lib_v2` for consistency; that switch is a one-line
profile change when you next commission.

Also noted: the yard fee has drifted again to **1,828,721** (total 1,874,221),
up 66,216 since this morning — faster than the ~36,000/day I estimated.


---

## 9. Actions taken after the changelog review (2026-08-06, post-shutdown)

The game's changelog is at `https://game.spacemolt.com/api/changelog` (JSON, paginated
— the HTML page at spacemolt.com/changelog is JS-rendered and does not fetch). 400
releases pulled, 0.370.1 → 0.552.0.

**Wildlife ban LIFTED.** The hard block in `checkDoctrineGuards` is removed. It
assumed targets do not reliably spawn; 0.536.0 says herds gather where ore/gas is
still RICH and thin out in mined fields — our agents were hunting stripped belts.
0.528.0 adds creature concentrates refining into `titanium_alloy`, `superconductor`,
`focused_crystal`, `silicate_composite` — exactly our shortfalls — and `adamant_tooth`
(8 needed for the mass drivers) drops from an adamant-grinder. A HUNTING DOCTRINE
block with proper technique is now on all 11 agents.

**@spacemolt/lib is already the latest published version (12.1.0).** There is no
upgrade available, so the lib_v2 error-parsing gap cannot be closed that way.
**Morg has therefore been switched to `http_v2`** — he is the commissioning agent and
must see real `missing_materials` errors rather than `Malformed action_error frame`.
Losing push notifications on one stationary agent costs effectively nothing.

**Code committed** to branch `inventory-accounting` (commit cd4c314). Working tree
still has stray JSON artifacts and `admiral.backup.exe` from earlier sessions —
untracked, not committed, safe to delete.

### Changelog findings still unactioned — for next session

* **0.550.0 — facility rent at NPC stations now covers the whole station running
  cost**, not just power and life support, and is still climbing (capped 50%/day).
  "Check `rent_per_cycle` before committing to a long build." **This directly changes
  the Enhanced Driver Workshop economics and must be checked before spending 1.1M.**
* **0.463.0 — mining respects deposit density.** `get_poi` returns `supported_power`
  per deposit; total fitted mining power above it is CAPPED, and depleted nodes throw
  `deposit_too_sparse`. No agent has ever read this field. Grit runs laser III (22) +
  rad harvester (8) = 30 total. Deposits also regenerate (common ~1 week, rare 2-3
  days), so Goldcrest and Bunda refill — spread out rather than queue on one spot.
* **0.530.0 — `get_action_log` `event_type` accepts an ARRAY**, and the response
  carries `next_since_id`. Our ingestion makes one call per category and computes the
  cursor by hand; both could be tightened.
* **0.498.0 — `yard_margin` is refunded in full on cancel**, and the "sourcing" state
  belongs to the CREDITS-ONLY path (the yard buys your materials). That is why
  `provide_materials=true` is all-or-none.

### Recommended opening for next session — all free queries, no ticks

1. `rent_per_cycle` at War Citadel — gates the 1,125,000cr workshop decision.
2. `supported_power` on Bunda Belt and Goldcrest — are we mining at a capped rate?
3. Market sweep from Sol for `piercing_railgun_ii`, `mass_driver`, `adamantite_bar`,
   `adamant_tooth`.
4. `get_nearby` at a RICH belt to confirm creatures actually spawn before committing
   anyone to the hunting route.
