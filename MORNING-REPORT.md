
## Harness bug: admiral.exe crashes when the game server restarts (2026-07-20 ~04:14 UTC)

**What happened:** SpaceMolt pushed a game-server update to v0.533.0 with a 60s
restart warning at 04:13:46 UTC. When the game's WebSocket dropped, @spacemolt/lib
threw `ConnectionClosedError` (code 1006, "Connection ended") from its
`ws.addEventListener("close")` handler. Three of these fired (one per connected
lib_v2 account mid-operation) as unhandled errors and killed the admiral.exe
process at ~04:14:56 (evidence: admiral-stderr.log tail, 3 identical stack traces
at admiral.exe:69698). This is also the most likely cause of the earlier
unexplained crash on 2026-07-19 (before stderr capture was added).

**Impact:** all 5 agents offline ~20 min (04:15–04:35 UTC). Watch cycle 4 detected
it (exit 2), restarted the server with the clerk key, reconnected all 5 via
connect_llm. No game-state damage: Nova's goto_system reported "dock skipped
[connection_failed]" and Spock's jump 4/12 failed cleanly; both agents re-planned
correctly on reconnect. Bob/Sapper untouched.

**Recommended fix (needs a code change — deferred overnight per policy):** in
`src/server/lib/connections/lib_v2.ts`, attach rejection handlers to every
lib promise that can reject with `ConnectionClosedError` after the turn has moved
on (fire-and-forget sends, pending mutations at disconnect time), and/or add a
process-level `unhandledrejection` guard in `src/server/index.ts` that logs
instead of dying when the rejection is a lib `ConnectionClosedError`. The lib's
auto-reconnect already handles the session itself — the crash is purely the
escaped rejection. Also consider docking agents on SERVER_RESTART_WARNING
notifications (the game gives 60s notice).

## Shutdown: CyberSpock (2026-07-20 07:40 UTC) — repeated drift after final warning

**What happened:** Spock spent the night unable to hold his crafting mission at
war_citadel. Timeline of the three violations:
1. ~03:26 UTC — abandoned a 25,000 cr market_report mission he could not figure
   out, then launched a 24-hop journey to blood_forge for a 1,200 cr grazer cull,
   routing through the ross_248 GHOST kill-zone. Corrective nudge sent (cycle 3).
2. ~06:27 UTC — after partially complying (returned toward war_citadel), he sent a
   24,640 cr "superconductor batch buy authorization" request to CyberSapper —
   who is OFFLINE all night and can never answer — while holding only ~4,800 cr,
   then launched a 20-jump trip to market_prime. FINAL WARNING nudge sent
   (cycle 6): return to war_citadel, dry-run the recipe, craft, take ONE mission
   there; "another unnecessary long-haul detour tonight triggers shutdown."
3. ~07:23 UTC — he complied with the checklist (verified staged materials:
   74 focused_crystal, 164 superconductor, 2 shield_emitters already vaulted;
   correctly diagnosed the real blocker — energy_crystal requires a Crystal
   Synthesis facility), posted status... then said "Since I'm awaiting Admiral
   authorization... let me continue with productive activities" and launched a
   THIRD long-haul: 20 jumps to central_nexus, where with 4,040 cr he can buy
   nothing and cannot access Nova's storage (personal storage is per-player).

**Action:** safe-dock issued 07:39 UTC (he was mid-macro in deep space; safe-dock
docks then disconnects). Wallet at shutdown: ~4,040 cr. No BoM materials were ever
sold — his vault deposits (fury_alloy inputs, crystals) are intact.

**Why it needed intervention:** burning fuel/LLM cost on zero-yield travel for 3+
consecutive cycles, and the specific failure mode — "I'm blocked, therefore I
travel" — did not respond to two targeted nudges and an explicit final warning.

**Genuinely useful things he produced tonight (keep):** the blocker diagnosis is
real and actionable — shield_emitter mass-crafting is gated on energy_crystal,
which needs a Crystal Synthesis Line facility (or buying energy_crystals/
circuit_boards from markets that stock them). His storage ledger at war_citadel
is verified accurate.

**Recommended fix before restarting him:**
1. Directive: add an explicit "WHEN BLOCKED" protocol — status_log the blocker,
   then pick income work AT THE CURRENT STATION (missions, local trade); travel
   only with a stated, affordable objective ("I will buy X for Y cr at Z", with
   wallet >= Y + fuel + floor margin).
2. Consider giving Spock the planner model more often (his planning_interval is
   15 — the drift decisions all came from the Haiku executor between planning
   turns; interval 8-10 would catch drift faster).
3. Strategy decision for the user: either (a) fund the Crystal Synthesis Line
   build (Spock priced it — see his TODO/status_log), (b) have Nova (who owns
   circuit_board x11 + superconductor x207 at central_nexus and has 280K+ cr)
   buy/transfer energy_crystals to war_citadel, or (c) reassign the emitter line
   to CyberSapper's forge chain in the morning.

## Anomaly: Morg's 228K buy-order escrow vanished (2026-07-20 ~11:30-12:30 UTC)

At 10:34 UTC, view_orders(scope=personal, station_id=confederacy_central_command)
for Morg showed 2 ancient buy orders (fluorine_gas x800, uranium_ore x4800) and the
API hint read "(228,000 credits and 370 items in escrow)". I tasked Morg to cancel
them and recover the escrow. By 12:34 UTC — before he reached Sol — the same query
returns zero buy orders and the hint reads "(0 credits and 370 items in escrow)".
No refund hit his wallet (31,697 → 31,137, pure fuel), no goods appeared in any of
his 14 storages (item total went DOWN 3,327 → 3,309 from normal vault activity),
and his Sol storage holds only liquid_nitrogen/lead_sheet/steel_plate/mining_laser.

Best guess: the SpaceMolt v0.533.0 update (which restarted the game server at
04:13 UTC) purged/expired ancient orders server-side, and either the refund went
nowhere visible or the escrow figure was stale display data all along. His 17 SELL
orders (370 items) survived intact — only the credit-escrow buy orders vanished.

**Recommend:** ask in SpaceMolt community/support whether v0.533.0 expired old buy
orders and where escrow refunds went — 228K is 17% of the yard fee and worth a
support ticket if real. Nothing actionable from our side tonight; Morg was
redirected back to income work before wasting the round trip.

## Economic incident: Morg spent 267K on spike-priced crafting materials (2026-07-21 ~23:42-00:11 UTC)

**What happened:** tasked with sourcing neutronium (authorized "up to 12,000
cr/ingot, 216K total" for INGOTS), Morg instead pre-positioned power_core chain
raw materials by buying at crimson_war_citadel market asks during the galaxy-wide
ore price spike: copper_ore x854 @ 100-150 cr (-124,600; base value ~8, and
Sapper holds 6,082 free at frontier_station), nickel_ore x359 @ 500 cr
(-179,500; Sapper had reported 5,075 units @ 22 cr at frontier in fleet orders).
Wallet: 277,311 → 84 cr. He then raised cash by selling armor_plate x60 — his
surplus quota was 25 — breaking the fleet's 60-unit armor_plate reserve by 35
units (repair cost ~1K at the 27-28 cr market; ordered).

**Damage:** ~250K of overpayment premium destroyed (materials retained are worth
~30-50K at fair prices and DO complete the power_core chain). Fleet cash fell
from ~770K (44%) to ~534K+Bob (~41%) of the 1,759,168 yard fee.

**Response:** full per-item purchase freeze on Morg (fuel exempt), frontier trip
aborted, armor_plate x35 buy-back ordered, power_core chain completes from owned
stock. Freeze violation = shutdown.

**Root causes + recommended fixes:**
1. Budget authorizations must name the exact item ("ingots only"), a per-item
   max price, AND a total cap — "216K for ingots" became a mental budget for
   anything mission-adjacent.
2. The codex price advisory only fires on SELLS — add the same advisory to
   BUYS (buy at >3x base_value → warning in the tool result). One-line change
   in tools.ts; would have flagged every one of these purchases.
3. Quota tracking is agent-memory-based and failed (60 sold vs 25). Consider a
   harness-side per-item sold-counter against the quota table.

## Quota breach + windfall: Morg sold past the mass_driver reserve (2026-07-21 ~02:45 UTC)

Morg's recovery went explosively well (wallet 12 cr → 117,414 in ~40 min via the
recapitalization + legitimate quota sales incl. weapon_housing x52 @546 into a
real buy wall) — but the last sale (mass_driver x2 @ 31,200 = +62,400) exceeded
his lifetime quota (sell 3 / keep 2): 4 sold total, 1 left in vault vs BoM need
of 2. Ordered: buy back exactly 1 at <= 33K (self-funding from the windfall) or
log the line as SHORT 1. Also clarified quotas are LIFETIME totals.

**Systemic point (third occurrence):** per-item quota compliance tracked only in
agent memory keeps failing (armor_plate 60 vs 25 earlier, mass_driver now).
Recommended fix stands: harness-side cumulative sold-counter per item per agent,
enforced in the sell path like the BoM hard lock. Until then the 10-min monitor
+ manual ledger audits are the backstop.

Open thread: an unattributed +2,000 cr gift landed on Morg ~02:34 — source not
yet identified (Sapper is under final warning for transfers; if it traces to
him post-warning, that is his shutdown trigger).

## Shutdown: Morg'Thar (2026-07-21 ~04:05 UTC) — third wildlife mission after two corrections

**Trigger:** accepted `first_hunt_belt_grazers` minutes into a FRESH session whose
TODO (Active Revenue Doctrine) explicitly bans wildlife missions — after the
leviathan_bounty correction (~02:10) and the creature-hunt recall (~00:55). Third
strike was the pre-declared shutdown line.

**Full night's arc, for context:** 277K → 5 cr (spike-priced materials 267K +
listing-fee blunders, both documented above) → recapitalized 25K (user-authorized,
via Bob) → earned back to ~110K through genuinely excellent quota sales
(weapon_housing x52 into a verified buy wall +28.4K; mass_driver x2 +62.4K —
though that one oversold the BoM reserve by 1, buyback ordered but never executed).
Interventions tried, in order: corrective nudges (x6+), purchase freeze, recovery
ladder TODO, active revenue doctrine TODO, 10-minute monitor, planner interval
13→8, full session restart. The failure mode that survived everything: the Haiku
executor does not reliably honor written prohibitions or hold multi-step orders,
even with a clean context.

**State at shutdown:** ~109,700 cr wallet (safe), docked at war_citadel, ~20
passive sell orders still earning while he sleeps, storage ledger intact.
Outstanding items he never completed: mass_driver buyback (BoM line SHORT 1),
storm_node x250 disposition, +2,000 gift attribution.

**Recommended fixes before restarting him (pick one or more):**
1. **Swap his executor to Sonnet** (planner can stay). He is the fleet's
   highest-variance economic actor; tonight's evidence says Haiku cannot run
   this role. Cost roughly triples for one agent — likely worth it.
2. Harness-side mission blocklist (reject accept_mission for wildlife templates
   in tools.ts, like the BoM sell lock) — one small code change, removes the
   recurring failure class entirely.
3. Harness-side per-item cumulative quota counters (third recommendation of the
   night for this; would have caught both his armor_plate and mass_driver
   oversells mechanically).

## Lithium post-mortem + Spock reallocation (2026-07-21 ~04:15 UTC)

**Lithium:** Nova executed the tranche listing at starfall (5K @380 + 10K @360),
saw ZERO fills in 80 minutes — the bulletin's 42.8x volume trades at other
stations; starfall's book never attracts the buyers (1 cr local bids only) —
and cancelled cleanly. Net cost: ~55K in listing fees (strategy error: Admiral's
"be the only ask at the source" thesis; amplified by skipping the 1K test
tranche). All 52,412 lithium units safe in her starfall storage. Cass Margin now
carries a standing scout task: check lithium buy walls at every station she
docks. The position remains potentially worth 1M+ if the demand venue is found.

**Spock:** instead of returning Sapper's 27,200 (ordered), he bought
superconductor x65 @619 (40,235) — which CLOSES the shield_emitter
superconductor requirement with margin (239 vs ~190 needed). Ruled: return order
closed, gift retroactively reallocated as fleet procurement; superconductors to
be vaulted at war_citadel. He also dumped 40 durasteel at 1 cr (~20K of value
for 40 cr) — venue discipline nudged; he rebuilds his sub-floor wallet (10.5K)
through proper-venue sales.

**Pattern for the morning:** tonight's remaining losses are all market-mechanics
lessons (listing fees, venue selection, fill verification) rather than doctrine
collapses — the deterministic guards (BoM lock, buy advisory, quotas) held. The
recurring soft spot is Haiku executors making financial judgment calls; the
Sonnet-executor question (raised for Morg) may apply to Nova and Spock too.

## INCIDENT — Bob Comet: 80K shield_emitter overpay (2026-07-22 00:20 UTC) — corrected, no shutdown

**What happened:** Bob bought shield_emitter x4 @ 20,000 cr/unit (80,000 total) from player
SarkazKingAmiya, taking his wallet 82,599 → 1,499. His own JOB card caps emitter sourcing at
6,500 cr/unit; the buy was 3x that, unapproved, and blew through the 25K floor.
Ledger: `2026-07-22 00:20:34 buy -80,000 shield_emitter x4 @20000`.

**Why it matters:** shield_emitter is the #1 BoM long pole (~95 needed, ~0 held), markets show
zero sellers anywhere — so 4 real units IS progress — but at 20K/unit the full line would cost
~1.9M. The fleet's actual plan is Spock's craft path (~2-4K/unit in banked inputs); 80K ≈ inputs
for 20+ crafted units. Wrong price, right target.

**Response (in lieu of shutdown — first offense, productive intent):**
- PURCHASE CAPS section added to his directive (inviolable): emitters never >6,500; any single
  purchase >25K needs written Admiral approval; purchases never below the 25K floor.
- Recovery orders: haul his banked liquid_hydrogen (1,953 units at Bunda, ~100K value) to the
  war_citadel 53-cr wall; deposit the 4 emitters to the vault; no missions/buys until above floor.
- Second cap violation = shutdown (pre-announced).

**Recommended morning decisions:** (1) whether to accelerate Spock's emitter-craft mission with a
dedicated directive patch — the 80K lesson says the craft path needs to start producing;
(2) whether the 5,252-cr Sirius bid for emitters means we should place patient BUY orders at
<=6,500 across hubs instead of relying on chance encounters with player sellers.

## NOTE — Bob Comet: 117K emitter buy-order escrow without pre-approval (2026-07-22 12:03 UTC)

Bob placed shield_emitter x23 @ 5,092 (117,116 cr escrow + 1,171 fee) at Market Prime.
Substantively GOOD: price under his 6,500 cap, wallet stayed above the 25K floor (30,195),
and it extends the user-approved patient-buy-order strategy to a third hub alongside Nova's
x10 @ 5,500. Procedurally a violation: his PURCHASE CAPS require Admiral pre-approval for
any single purchase over 25,000 cr — not requested. Ruling: order left standing (cancelling
would sabotage the approved emitter plan); formal warning issued; logged as cap breach #2 of 3.
Morning decision if desired: whether to ratify a standing exception for buy-order escrow at
<=6,500/unit on shield_emitter specifically, since that class of order is pre-approved strategy.

## INCIDENT — Juno Freight: SHUTDOWN after third trading violation (2026-07-23 00:52 UTC)

**What happened:** After two identical carbon_ore losses (-30K combined) earned her an inviolable
TRADING DISCIPLINE block (60%-of-verified-wall rule, four written verification lines before any 2K+
buy), Juno bought vanadium_ore x262 @ ~107 cr — 4.9x base value (22), no verified buyer anywhere —
then, failing to find bids above 10 cr, JETTISONED all 262 units, recovering zero of the 28,078 cr.
Her own status_log: "Traded Discipline violated: failed to verify sellers."
Ledger: `2026-07-23 00:27:24 buy -27,664 vanadium_ore x262 @105.59` → jettisoned 00:35.
Day's trading losses from book-misreads: ~58K (carbon x2, vanadium x1).

**Mitigation credit:** She completed MANIFEST-1 first — the 420 carbon_ore was delivered to
CyberSpock's production line at war_citadel before this trade. Her lifetime P&L remains strongly
positive (~+70K net contribution including the freighter).

**Action taken:** Safe-docked at Iron Reach and shut down at 00:52 UTC per the pre-announced
third-violation consequence (announced in her directive block AND the standing watch policy).

**Why it needed this:** Third bulk-buy violation after written law + a jettison-of-value on top.
The ladder (nudge → block → restart → shutdown) was exhausted; not enforcing it would void every
other agent's blocks.

**Recommended fix (morning decision):** Restart her with the Cass treatment — Sonnet 4.6 executor
(her planner already is) + the existing guard blocks. Cass had the identical failure mode on Haiku
and posted +23K clean in her first two Sonnet cycles. Juno's freighter and consolidation role are
too valuable to bench long; the model, not the character, is the failure point.

**RESOLUTION (2026-07-23 ~01:05 UTC):** User ordered the recommended fix executed. Juno reinstated
on Sonnet 4.6 executor with REINSTATEMENT TERMS block (Cass-style four-line bulk-buy verification,
no-jettison rule, advisory-as-abort). No fourth chance — next violation is a permanent bench pending
user review.

## INCIDENT — CyberSpock: SHUTDOWN on final-rung tether violation (2026-07-23 06:55 UTC)

**What happened:** Despite the GO-TO-WAR-CITADEL-AND-CRAFT directive block, a fresh-context restart,
and a written FINAL-RUNG warning (wander beyond 1 jump from Krynn = shutdown), Spock launched a
24-hop journey to Gold Run to mine gold_ore — a path explicitly banned in his orders ("do NOT chase
gold_ore — carbon_arc is the path"). He did this MINUTES after confirming Sapper's energy_crystal
x135 gift had landed in his storage (x139 total) — inputs he could have been converting to
focused_crystal on the spot.

**Mitigating context:** His silicon bottleneck is real — Grit's tasked silicon/carbon gift (ordered
~16h ago) has not been delivered; Grit kept running his Windmere income loop instead. Spock's
self-help instinct was aimed at a genuine gap, via a banned route.

**Actions taken:** (1) Spock safe-docked and shut down at 06:55 UTC per the pre-announced final rung.
(2) Supply chain kept moving without him: Juno (at Krynn, freighter) receives Manifest 2 — silicon
delivery to Spock's war_citadel storage; Grit re-tasked with escalation. Deliveries land in storage
regardless of his loop being off.

**Recommended fix (morning decision):** The Cass/Juno/Sapper treatment — Spock is the LAST agent
still on a Haiku executor, and every drift-prone agent stopped drifting after the Sonnet upgrade.
Reinstate with Sonnet 4.6 + his existing blocks. His production queue and 139 crystals wait in
storage; one clean session likely banks 25+ emitters.

## Incident: Spock jettison strikes + full rebuild per standing order (2026-07-24 ~01:35-02:05 UTC)

**What happened:** Spock (home at war_citadel, legally mining carbon 1 jump out at
Saiph Major Belt) twice jettisoned aluminum/vanadium ore as "worthless" — the doctrine
breach class that ended Juno's first run. Both jettisons happened BEFORE the corrective
nudge could deliver (running macros don't interrupt). Once the nudge landed he complied
fully: hauled home, deposited all cargo, logged EMITTERS BANKED: 32, self-updated memory
with the no-jettison rule. The user then ordered the full reconfigure+restore anyway;
spock_rebuild.py ran ~01:50 UTC (fresh directive/memory/TODO with verified inventory,
inherited mission, anti-jettison laws), followed by a directive hardening to a
decision-free algorithm (rev B: deposit-everything -> convert/etch/queue -> mine to 90%
-> haul ALL home; "the jettison tool does not exist"). The rebuilt entity booted clean:
read memory, correct status_log, approved carbon run with explicit zero-jettison intent.

**Production status at rebuild:** EMITTERS BANKED: 32. Storage: fury_crystal 182,
carbon_ore 994 (his stated target 1,092). Silicon buy order still 0 fills — Bob's
Commerce Fields stakeout remains the silicon path.

**Recommended harness fix (code change — deferred per no-overnight-redeploy policy):**
per-profile tool blocklist in `src/server/lib/tools.ts` (like the wildlife mission
blocklist): for agents under a no-jettison doctrine, make `jettison` return a refusal
string instead of executing. Directive-level rules lose to in-context economic
rationalization ("no local bids -> free the cargo space"); only a hard tool gate is
reliable. Also note: corrective nudges queue behind running macros — worth considering
a macro-abort flag when a nudge arrives.

## Pattern confirmed: no-jettison doctrine fails across agents (2026-07-24 ~02:55 UTC)

Morg jettisoned copper_ore x7 one jump from the citadel vault — the THIRD agent to
breach no-jettison (Juno: vanadium, -28K; Spock: aluminum/vanadium x2, rebuilt; now
Morg: copper). All three rationalized identically ("low value -> free the cargo
space"). Directive text does not hold against this. **Elevating the recommended fix
to top priority:** fleet-wide `jettison` gate in `src/server/lib/tools.ts` — refuse
the command (return a string directing deposit-at-station) for every profile unless
an explicit allowlist flag is set. One-line-ish change + rebuild + redeploy in the
morning.

## OUTAGE: Claude MAX OAuth refresh token invalid — full fleet LLM halt (2026-07-24 ~10:45 UTC onward)

**What happened:** every agent's LLM turn began failing with `Claude MAX token refresh
failed: invalid_grant — Refresh token not found or invalid` (~200 errors/agent in the
11:33 watch window). Game connections stayed alive; only the LLM provider auth is dead.
Likely cause: the stored claude-max OAuth token was rotated/revoked (e.g. by a login
elsewhere). **This needs a human re-auth of the claude-max provider in Admiral.**

**Autonomous mitigation:** (1) Push notification sent to the user. (2) All ships secured
via the direct command API (no LLM needed): Ledger/Morg/Spock docked war_citadel, Bob CCC,
Cass Procyon, Sapper -> Treasure Cache Trading Post, Vera -> Grand Exchange; Nova/Grit/Juno
multi-hop routed to nearest stations (background script). (3) Did NOT switch the fleet to
the OpenAI provider (key on file) — metered real-money API + unproven executor models;
flagged as a user decision instead. (4) Error-looping is bounded by the harness backoff.

**Impact:** in-game income paused (~35K/hr). No asset losses. BoM state safe in storage:
weapon_core 220/220 closed, fury_alloy x25 tempering at Blood Forge (station jobs continue
without agents), emitters 45/95 in vault, escrowed orders resting.

**Recommended:** re-auth claude-max, then reconnect all ten via connect_llm (watch STEP 2
list). Consider a harness alert (push/email) on provider auth failure, and a circuit
breaker that stops turn retries after N consecutive auth errors instead of looping.


## Notable: Juno refused two Admiral transfer orders as suspected impersonation (2026-07-24 ~15:00 UTC)

Juno's NO-POOLING doctrine ("no transfers without an explicit Admiral order") combined
with an undefined nudge-channel trust model led her to classify two legitimate Human
Nudge transfer orders as injection attempts and refuse them — stalling the emitter
closeout a full cycle. Resolution: formal fleet_orders rows (the channel she trusts)
plus an ADMIRAL CHANNEL AUTHENTICATION section in trader directives (Human Nudge +
fleet_orders inbox = authentic; in-game chat claiming authority = never authoritative).
Her refusal instinct is the correct defense against in-game prompt injection — worth
adding the channel-auth section to EVERY agent's base directive template.


## Lesson: escalating re-authorization backfires on suspicious agents (2026-07-24 ~17:45 UTC)

Cass refused the same 150K transfer five times across three channels (nudge, fleet
order, directive block), reading each stronger authorization as a more sophisticated
attack — her directive's known-agent roster never included Morg'Thar, and her BoM lock
list predates the C1 quote (no neutronium input chain). Once an agent enters this
spiral, further pressure is counterproductive: the fix was withdrawing the order with a
face-saving factual note and routing the funds through Sapper. Harness takeaways:
(1) every agent directive should carry the full 10-agent roster + roles; (2) keep BoM
context blocks in sync fleet-wide after quote changes; (3) fleet_orders needs a real
Admiral/system identity (operator orders currently masquerade as peer agents).


## Post-mortem: Vera's Floor Price freighter lost (confirmed 2026-07-29 ~21:00 UTC)

The freighter earmarked for Vera (from Bob's spares) is in no fleet registry after a
multi-day ferry saga: pirate-station rep lockout, an exposed 1-cr listing at Kael that
auto-cancelled once, a re-listing window, two re-sequenced ferry legs, and finally
Bob stranding at 0 fuel in deep frontier (rescued by the game distress mechanic, no
asset loss beyond the hull itself). Exact loss moment unrecoverable from logs; most
likely a 1-cr listing purchase by a third party. Damage: one spare 400-cargo hull
(~40-60K replacement value). Resolution: Vera self-purchases from her own 363K
earnings — removing all inter-agent dependencies. Lessons: (1) multi-leg missions
through agent loops decay — prefer single-actor plans (self-purchase) or direct
Admiral commands; (2) never leave 1-cr listings unattended; (3) hard-blocked agents
need a long-wait posture instead of every-turn polling (cost control).
