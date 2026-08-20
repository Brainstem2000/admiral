# Agent verification protocol — check it yourself, then publish it

Every agent verifies their own plan before acting, and publishes what they verified so nobody
else pays to learn it twice. The Admiral is one context window and cannot check twelve agents'
assumptions; you each have free queries and you are standing in the place that matters.

This exists because a single evening produced ~15 corrections, and almost all of them were the
same shape: **someone asserted a fact about a place they were not standing in, or a number they
had not re-read.** Including the Admiral. Especially the Admiral.

## The six checks — run before acting, not after failing

Free queries cost no game tick. There is no excuse for skipping these.

**1. AM I THERE?** `view_storage` at the station you are docked at. Storage is per-agent AND
per-station. "The fleet holds 404 durasteel" is meaningless if your station holds zero — that
exact error sent an agent on a 12-jump round trip for nothing.

**2. HOW FAR IS IT?** `find_route` before you accept any plan that names another station.
"Wake Spock, it's a quick handoff" turned out to be 25 jumps each way. "Craft from the lithium at
Starfall" was 14 jumps from the agent told to do it. **Report the jump count back — a plan that
costs 30 jumps may not be worth its payoff.**

**3. WHAT IS THE PRICE *HERE*, AND HOW DEEP?** `view_market` at your station.
`realisable = min(what you hold, the order quantity) × price`. A 14,956 bid one unit deep pays
14,956, not 89,736. A headline price with thin depth is a trap — you climb the ladder and pay far
more than quoted. **Always report price AND depth, never price alone.**

**4. CAN I CARRY IT?** `get_cargo`, then multiply quantity × item size. durasteel_plate is size 2,
so 80 units need 160 space in a 75-unit hold. Check before you plan the trip, not when the
`cargo_full` error arrives.

**5. IS IT THE SHIP?** Before consuming, selling or gifting anything, ask whether it is a
Devastator commission line. Thirteen lines sit at EXACTLY the required quantity and nobody sells
neutronium_ingot. The quota guard blocks selling and gifting, and now blocks crafting too — **a
refusal is the system working. Report it, never route around it.**

**6. DOES THE COMMAND ACTUALLY TAKE THAT PARAMETER?** `help` once, or check the catalog. Do not
guess. `get_missions` takes NO parameters — an invented `sort=reward` cost the fleet ten failed
calls every twelve minutes until someone read the signature.

## Publishing — the collaboration half

A check you ran is worth twelve times what it earns you alone. Post verified findings to faction
chat in a form the next agent can act on without re-checking:

```
VERIFIED <station> <item>: bid <price> x<depth> | ask <price> x<depth>   — <name>
VERIFIED ROUTE <from> -> <to>: <n> jumps, <n> fuel                       — <name>
VERIFIED STOCK <station>: <item> x<qty> (mine)                           — <name>
NO BID <station> <item>                                                  — <name>
FACILITY <station>: <facility name> runs <recipe>                        — <name>
```

Rules for publishing:
- **A negative result is worth as much as a positive one.** "NO BID at war_citadel for
  polonium_ore" stops the next agent hauling 200 units there.
- **Read faction chat before you check something.** If it was published in the last hour, use it.
- **Say when a published figure has moved.** Depth changes within minutes; prices within the hour.
- Use `fleet_order` to hand work to a named agent, and include the preconditions you verified so
  they do not repeat them.

## Escalate to the Admiral only for what you cannot see

The Admiral can read the whole galaxy's order book at once; you can read one station. Ask for:
- **cross-empire prices** — the same item asked 500 in crimson and 33 in nebula on the same day
- **anything over 20,000 credits** to buy
- **releasing a BoM-locked item** — item and exact quantity
- **a plan that needs more than ~10 jumps** — say the jump count and let the Admiral judge

**When you escalate, keep working the parts that are not blocked.** One agent halted everything
for eight minutes waiting on a pricing question while four other tasks sat idle. Post the
question, then carry on.

## The standing rule

**Do not act on a number you have not personally verified or seen published by a named agent in
the last hour** — including numbers the Admiral gives you. The Admiral is working from cached
tables and a context window; you are standing in the actual station. When your reading disagrees
with an order, **your reading wins** — say so in faction chat and hold. That has already saved
this fleet twice.
