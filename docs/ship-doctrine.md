# Ship doctrine — match the hull to the agent, and check before you conclude

**Run `bun scripts/ship-match.ts <agent>` before reasoning about ships at all.** It reads the live
catalog, the agent's real skill sheet, and the fleet's real stock. Everything below explains what
that script encodes and why — but the script is the source of truth, because the market moves.

```bash
bun scripts/ship-match.ts                    # all agents, top 3 buildable hulls each
bun scripts/ship-match.ts Nova               # one agent, top 8 + aspirational tier
bun scripts/ship-match.ts Nova bonanza_king  # full bill of materials, fleet stock vs market asks
```

## Why this file exists

The fleet has repeatedly reached wrong conclusions that a thirty-second query would have prevented:

- Concluded "we have no hauler, this haul is impossible" **three times in one day** — while a
  400-cargo freighter sat on the market for **7,376 credits**. The 191,682cr fury-tempered
  contract was abandoned on those grounds.
- Flew a **Mining Laser I (mining_power 5)** for weeks when Mk III is **22** — a 4.4x difference
  in the same slot.
- Recommended the **Congregation** (1,900 cargo) as a hauler upgrade. It has **zero utility,
  weapon and defense slots** — it can never mount a laser, an expander or a shield. Its own
  catalog tags read `massive-cargo, deathtrap, zero-survivability`.
- Picked **Deep Survey** over **Bonanza King** on a stale market snapshot. Bonanza King was
  39,000 cheaper *and* 25% better on throughput; the difference was one line item
  (`navigation_core x9 @10,303`) that Deep Survey needs and Bonanza King does not.

These are arithmetic mistakes, not judgement calls. They belong in a script.

## The rules

**1. Cargo capacity alone is never the criterion.** A hull with no utility slots cannot mine,
cannot expand its hold, and cannot defend itself. Rank by what the agent will actually *do*.

**2. A slot you cannot power is not a slot.** Mining Laser III costs 6 CPU and 12 power. Multiply
out against `cpu_capacity` and `power_capacity` before believing a slot count. The script's
`lasersRunnable()` does this.

**3. Throughput is multiplicative, so upgrades compound.** Extraction rate x effective hold x
hull bonuses. Nova's Prospect (100 cargo, mining_power 5, no bonuses) against a Bonanza King
(900 effective ore cargo, mining_power 132, +20% yield) is not "a bit better" — it is two orders
of magnitude.

**4. Read `inherent_capabilities`.** `ore_cargo_efficiency: 50` means ore takes **half** the
space — a 600-cargo miner holds 900 of ore. `ore_yield_bonus` multiplies every extraction. These
bonuses are why a purpose-built Miner beats a bigger generic hauler.

**5. Match the hull to the agent's skills, not to the role in their name.** Nova is titled
"Miner" but her top skill is `trading 21`, and `piloting 31` means no hull in the game gates her.
Agents with `gunnery 3 / weapons 2 / tactics 2` gain nothing from weapon mounts.

**6. Price the build before declaring anything impossible.** Half a bill of materials is usually
already in fleet storage. Check `storage_inventory` before assuming a purchase.

**7. Read ask DEPTH, not the headline ask.** `engine_core` shows 7,148 with an ask depth of
**two**. Buying eleven means climbing the ladder and paying far more. The same rule as selling:
`realisable = min(qty, depth) x price`. See `docs/../CLAUDE.md` live-data section.

**8. Fit the ship before flying it.** Both large haulers the fleet lost were unarmed freighters
with mining lasers and a single weapon slot. Fill the defense slots. An unfitted hauler is how
you donate 540 cargo to a leviathan.

## Standing hazard

**The Gold Crest belt, Goldcrest system.** A Rainbow Leviathan there destroyed five fleet ships in
one day (2026-08-06), including both large haulers — CyberSapper's Caravan (540 cargo) and Juno's
Floor Price (400 cargo), plus three Mining Laser IIIs. Run `get_nearby` before working any belt
and leave apex wildlife on sight. Never take a slow, high-value hull there.

## Reference — what the fleet flies vs what exists

| hull | cargo | util | def | wpn | hull | yard tier | note |
|---|---|---|---|---|---|---|---|
| prospect | 100 | 2 | 1 | 1 | 95 | – | what most agents fly |
| caravan | 540 | 3 | 1 | 1 | 200 | – | lost to the leviathan |
| war_wagon | 1,200 | 8 | 2 | 0 | 300 | 1 | best pure hauler we can build |
| bonanza_king | 600 | 6 | 1 | 0 | 380 | 2 | best miner: +20% yield, +50% ore efficiency |
| deep_survey | 750 | 5 | 1 | 1 | 420 | 2 | more hold, pricier, +15% yield |
| congregation | 1,900 | **0** | **0** | **0** | 100 | 0 | **trap — cannot fit anything** |
| tellurian | 2,400 | 10 | 3 | 1 | 1,800 | 4 | aspirational; needs a tier-4 yard |

Crimson War Citadel is shipyard tier 5, so yard tier is rarely the binding constraint —
materials are. Set `YARD_TIER=n` to change what the script considers buildable.
