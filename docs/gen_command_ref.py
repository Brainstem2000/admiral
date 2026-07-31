"""Generate the authoritative SpaceMolt command reference from the live OpenAPI
spec, plus a ship-capacity table from catalog.json.

Sources (both hosts serve byte-identical specs):
  https://game.spacemolt.com/api/openapi.json   -> commands
  https://game.spacemolt.com/api/catalog.json   -> ships/items/recipes/facilities
"""
import json, sys, re
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

spec = json.load(open('openapi_game.json', encoding='utf-8'))
cat = json.load(open('catalog.json', encoding='utf-8'))


def deref(o):
    seen = 0
    while isinstance(o, dict) and '$ref' in o and seen < 10:
        t = spec
        for x in o['$ref'].lstrip('#/').split('/'):
            t = t[x]
        o = t
        seen += 1
    return o


rows = []
for path, ops in sorted(spec.get('paths', {}).items()):
    name = path.lstrip('/')
    for method, op in ops.items():
        if method.lower() not in ('post', 'get'):
            continue
        op = deref(op)
        desc = (op.get('description') or op.get('summary') or '').strip()
        sch = deref(((deref(op.get('requestBody') or {}).get('content') or {})
                     .get('application/json') or {}).get('schema') or {})
        props = sch.get('properties') or {}
        req = list(sch.get('required') or [])
        opt = [k for k in props if k not in req]
        # The spec self-labels tick-costing commands.
        mutation = bool(re.search(r'mutation command|1 per tick', desc, re.I))
        first = desc.split('\n')[0].strip()
        rows.append({
            'command': name,
            'mutation': mutation,
            'required': req,
            'optional': opt,
            'params': {k: (v.get('type') if isinstance(v, dict) else '?')
                       for k, v in props.items()},
            'summary': first[:200],
        })

muts = [r for r in rows if r['mutation']]
queries = [r for r in rows if not r['mutation']]
print(f'commands: {len(rows)}  mutations: {len(muts)}  queries: {len(queries)}')

json.dump({'version': spec.get('info', {}).get('version') or cat.get('version'),
           'commands': rows},
          open('spacemolt-commands.json', 'w', encoding='utf-8'), indent=1)

# ---- ship capacity table (fixes hand-guessed cargo numbers) ----
ships = []
for s in cat.get('ships', []):
    ships.append({
        'id': s.get('id'), 'name': s.get('name'), 'class': s.get('class'),
        'tier': s.get('tier'), 'category': s.get('category'),
        'cargo': s.get('cargo_capacity'), 'fuel': s.get('max_fuel'),
        'hull': s.get('max_hull'), 'speed': s.get('speed'),
    })
ships.sort(key=lambda x: (x['cargo'] or 0), reverse=True)
json.dump(ships, open('spacemolt-ships.json', 'w', encoding='utf-8'), indent=1)
print('\ntop cargo hulls:')
for s in ships[:12]:
    print(f"  {s['id']:<22} {str(s['cargo']):>6} cargo  T{s['tier']} {s['category']}")
print('\nfleet-relevant:')
for want in ['theoria', 'prospect', 'caravan', 'floor_price', 'archimedes',
             'junk_convoy', 'war_wagon', 'cobble', 'promenade', 'syllogism']:
    m = next((s for s in ships if s['id'] == want), None)
    print(f"  {want:<14} -> {m['cargo'] if m else 'NOT FOUND'} cargo"
          + (f"  ({m['name']}, T{m['tier']} {m['category']})" if m else ''))
