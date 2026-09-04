# Fleet upgrade plan — 2026-09-04

What every agent flies, what they should fly, and what it costs. Produced by a
12-agent survey with an adversarial verification pass; **nine of twelve initial
recommendations were refuted**, so the failure patterns at the end are the most
reusable part of this document.

**Funding pool:** 16,470,775cr — 6,396,733 cash + 10,074,042 depth-validated
holdings, zero unvalidated. Total programme is ~1.2M, about 7%.

---

## 1. Hulls — verified purchases

Every listing below was re-confirmed live with its id and price. Prices move;
`browse_ships` before buying. All are **self-funded** from that agent's own
holdings, so no gift mechanics are involved.

| agent | hull | station | listing | price |
|---|---|---|---|---|
| Ledger Voss | Siege Breaker T3 | ironhearth_station | `b64ea11c1f4664d9005e0161bb010cd8` | 452,679 |
| Bob Comet | War Wagon T2 | iron_reach_mining_colony | `4221be79c5a33ce75d910074a83b4f0e` | 253,734 |
| Zibal Prospector | Repo Man T2 | unknown_edge_waystation | `eec261f664e75487f92316a6ae76f15e` | 146,729 |
| Vera Lane | Bulk Terms T2 | cargo_lanes_freight_depot | `1615a7455302eb39b63c987cb3961cf1` | 36,940 |
| Grit Vane | Maul T1 (stopgap) | iron_reach_mining_colony | `8755be134d325a4f7c6d748d45f47402` | 22,481 |
| Rook Vance | Bonanza T1 | cargo_lanes_freight_depot | `9f3f91470f585c0b2a6fe90f666221a0` | 21,619 |

**Total 934,182cr.**

**KEEP — verified, nothing purchasable beats what they fly:** Cass Margin
(Caravan), Juno Freight (War Wagon — the only hull she can fly with 8 utility
slots), CyberSpock (Gas Tanker).

**Re-run required:** Morg'Thar and CyberSapper. Both initial recommendations
were refuted on regression analysis; the verifier's advice was explicitly
"re-run, not a counter-proposal."

---

## 2. Morg'Thar — the fleet warship

Role changed to **protector and hunter**. He currently flies a War Wagon with
**zero weapon slots** — the designated warrior cannot mount a gun.

Nothing listed anywhere fixes this: the best-armed hull for sale across all 12
boards is a `polearm` at 3W. So the battleship must be **commissioned**.

**Target: `crimson_devastator`** — 7W/3D/3U, cpu 90, power 185, tier 4,
requires a **tier-3 yard**, which Crimson War Citadel is. Quoted live there:

```
provide materials:    859,628cr + 12 short material lines   <- the plan
credits only:      ~6,500,000cr                             <- never; a credits-only
                                                               yard buys ONLY from its
                                                               own station market and
                                                               has already failed once
build time:           3,900 ticks (~10.6 hours)
```

**Tier 5 is skill-gated, not money-gated.** `annihilator` (9W/4D/4U) returns
`Flying a Tier 5 ship requires Piloting level 50`. Morg is at **34**, the
fleet's highest. Jumps train piloting (+6 each), so travel is the path.
Tier 5 additionally needs a **tier-4 yard** (War Citadel is 3) and is 24–26
material lines short.

---

## 3. Fury crystal is not for sale

`fury_crystal` refines **3:1** into `fury_alloy`, which appears in the
build_materials of **47 crimson hulls** — siege_breaker 30, crimson_devastator
120, guillotine 140, armageddon 750.

The fleet holds **7,222 crystal (6,762 at War Citadel) = ~2,455 alloy**, enough
for twenty tier-4 hulls. Nova Reyes had begun liquidating 5,435 of it into a
320 bid — 1.74M credits — and was halted mid-sale. It is worth more as warships
than as credits, and it is the one material for a Devastator the fleet is
already rich in.

Before dumping any refined or exotic material, check what it is an input to.

---

## 4. Equipment refit — ~289,700cr

`bun scripts/fleet-refit.ts` computes this live. **Almost the entire fleet flies
`mining_laser_i`, mining power 5** — the weakest in the game; only Grit (22) and
Ledger (12) are above it, and nine ships have empty slots.

Three rules the planner encodes, each of which produced a wrong answer by eye:

- **A slot you cannot power is not a slot.** The budget is free capacity PLUS
  what the swapped-out module returns.
- **`special` is role-critical.** `gas_harvesting` only harvests gas, so a
  higher-`mining_power` laser is a *downgrade* for a gas rig. `common_only`
  strip miners take only iron (5cr) and copper (8cr) — raw mining power is not
  the ranking.
- **Never remove the last harvesting module** from a rig that earns by
  harvesting. An early scoring pass weighted a +4 afterburner level with a
  40-power laser and proposed exactly that.

`mining_laser_v` fits **nobody**: it needs 13 CPU / 24 power and the largest
headroom on any hull is 10. CyberSpock alone has the budget, but it would cost
him gas harvesting, so he takes `gas_harvester_iv` instead.

---

## 5. Why nine of twelve recommendations were refuted

These are the patterns to check before acting on any future ship analysis.

1. **Cost priced from catalog `base_value`, not live asks.** Affected Rook,
   Vera and Cass. Base value is not what you pay.
2. **Modules with zero ask depth in the agent's own empire** — unbuyable at any
   price, however good the plan reads. Cass's afterburner had no asks in
   Crimson space at all.
3. **"Does it fix the binding limit" never actually checked.** CyberSapper's
   378,468cr Survey Vessel was a *downgrade* on his own stated constraint
   (utility slots).
4. **Crew requirements ignored.** The standout: Zibal was recommended a
   202,737cr `junk_convoy` requiring **minimum_crew 60 against his crew of 1** —
   a hull he could not have flown.
5. **Station assumptions asserted from stale position data.** Several agents
   had moved or were in transit; the surveying agents caught this and corrected
   it rather than inventing a board. Always re-read position before routing.

---

## Commands worth recording

- Purchase is **`buy_listed_ship(listing_id=...)`**. There is no `buy_ship`.
- `browse_ships` is **per-station**; it accepts an explicit `base_id`, which
  works even when the caller is not docked there.
- `commission_quote` quotes at the **caller's current station** — it takes no
  `base_id`. To price a yard, an agent must be standing in it.
