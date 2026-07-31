"""Render docs/spacemolt-commands.md from the extracted spec."""
import json, sys, re
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

d = json.load(open('spacemolt-commands.json', encoding='utf-8'))
cmds = d['commands']
ships = json.load(open('spacemolt-ships.json', encoding='utf-8'))

# Meta/auth endpoints agents never issue as game commands.
META = {'login', 'logout', 'register', 'session', 'login_link', 'login_link_poll',
        'api/catalog.json', 'agentlogs'}

GROUPS = [
    ('Ships & hulls', r'^(browse_ships|buy_listed_ship|buy_ship_license|cancel_ship_buy_order|'
                      r'cancel_ship_listing|commission_ship|get_ship|list_ship_for_sale|list_ships|'
                      r'name_ship|place_ship_buy_order|refit_ship|scrap_ship|sell_ship_to_order|'
                      r'switch_ship|view_ship_buy_orders)$'),
    ('Movement & navigation', r'^(jump|travel|dock|undock|find_route|get_nearby|explore|warp|'
                              r'set_course|autopilot|scan_system|get_location)$'),
    ('Market & trading', r'^(view_market|buy|sell|market|place_order|cancel_order|view_orders|'
                         r'analyze_market|estimate_purchase|subscribe_market|unsubscribe_market|trade.*)$'),
    ('Cargo & storage', r'^(get_cargo|deposit_items|withdraw_items|view_storage|jettison|'
                        r'transfer.*|gift.*)$'),
    ('Mining & industry', r'^(mine|refine|craft|salvage.*|survey|scan)$'),
    ('Faction', r'^faction'),
    ('Missions', r'^(accept_mission|decline_mission|abandon_mission|complete_mission|'
                 r'get_missions|list_missions|turn_in_mission)$'),
    ('Combat & drones', r'^(attack|flee|battle.*|get_battle.*|drone.*|get_drone.*|set_drone.*)$'),
    ('Social & log', r'^(chat|forum.*|captains_log.*|.*note.*|get_chat_history|mail.*)$'),
]


def group_of(name):
    for label, pat in GROUPS:
        if re.match(pat, name):
            return label
    return 'Other'


out = []
out.append('# SpaceMolt command reference')
out.append('')
out.append(f"Generated from the live OpenAPI spec. Game version **{d.get('version')}**.")
out.append('')
out.append('**Sources** (both hosts serve byte-identical specs, 215 paths):')
out.append('')
out.append('- `https://game.spacemolt.com/api/openapi.json` — **commands** (this file)')
out.append('- `https://game.spacemolt.com/api/catalog.json` — **game data**: ships, items,')
out.append('  recipes, facilities, skills, achievements. Contains *no* commands.')
out.append('')
out.append('Regenerate with `scratchpad/gen_command_ref.py` + `gen_md.py`.')
out.append('')
out.append('## Read this before guessing a command name')
out.append('')
out.append('Names are not guessable by analogy. Verified traps:')
out.append('')
out.append('| Wrong guess | Actual command |')
out.append('|---|---|')
out.append('| `buy_ship` | **`buy_listed_ship`** (`listing_id`; must be docked at that base) |')
out.append('| `sell_ship` | **`list_ship_for_sale`** (`ship_id`, `price`) or `sell_ship_to_order` |')
out.append('| `store_items` | **`deposit_items`** |')
out.append('| `get_skills` alone | skills also ride along inside `get_status` |')
out.append('')
mut = [c for c in cmds if c['mutation'] and c['command'] not in META]
qry = [c for c in cmds if not c['mutation'] and c['command'] not in META]
out.append(f'## Tick cost: {len(mut)} mutations, {len(qry)} free queries')
out.append('')
out.append('The spec self-labels tick-costing commands ("Rate limited: mutation command,')
out.append('1 per tick / 10 seconds"). Queries are free and do **not** advance a game tick —')
out.append('this is the source of truth for `QUERY_COMMANDS` in `src/server/lib/tools.ts`.')
out.append('')

for label, _ in GROUPS + [('Other', '')]:
    rows = [c for c in cmds if group_of(c['command']) == label and c['command'] not in META]
    if not rows:
        continue
    out.append(f'### {label}')
    out.append('')
    out.append('| command | tick | required | optional | notes |')
    out.append('|---|---|---|---|---|')
    for c in sorted(rows, key=lambda x: x['command']):
        tick = '**action**' if c['mutation'] else 'free'
        req = ', '.join(f'`{x}`' for x in c['required']) or '—'
        opt = ', '.join(f'`{x}`' for x in c['optional'][:6]) or '—'
        if len(c['optional']) > 6:
            opt += ', …'
        note = c['summary'].replace('|', '\\|').replace('\n', ' ')[:110]
        out.append(f"| `{c['command']}` | {tick} | {req} | {opt} | {note} |")
    out.append('')

out.append('## Ship cargo capacities (from catalog.json)')
out.append('')
out.append('Hand-guessed cargo numbers have caused bad purchase decisions — an Archimedes')
out.append('at 44,370cr looks like a hauler and carries **80**. Always check here.')
out.append('')
out.append('### Fleet-relevant hulls')
out.append('')
out.append('| hull | cargo | tier | category |')
out.append('|---|---|---|---|')
for want in ['theoria', 'cobble', 'archimedes', 'promenade', 'prospect', 'floor_price',
             'caravan', 'junk_convoy', 'war_wagon']:
    s = next((x for x in ships if x['id'] == want), None)
    if s:
        out.append(f"| `{s['id']}` | **{s['cargo']}** | T{s['tier']} | {s['category']} |")
out.append('')
out.append('### Largest holds in the game')
out.append('')
out.append('| hull | cargo | tier | category |')
out.append('|---|---|---|---|')
for s in ships[:15]:
    out.append(f"| `{s['id']}` | **{s['cargo']}** | T{s['tier']} | {s['category']} |")
out.append('')

open('spacemolt-commands.md', 'w', encoding='utf-8').write('\n'.join(out))
print('wrote spacemolt-commands.md', len('\n'.join(out)), 'chars')
print('mutations', len(mut), 'queries', len(qry))
