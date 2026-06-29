import json, urllib.request, urllib.error, time, sys

BASE = 'http://localhost:3210/api/cost/recommend'

# Large ColdWatch cost context (the committed fixture).
with open('public/__qa-cost-context.json') as f:
    large_ctx = json.load(f)

# Small 3-component PRD (client + Node API + Postgres) — the other acceptance case.
small_ctx = {
    'title': 'Bakery surplus marketplace',
    'context': {
        'userScale': 'small',
        'trafficPattern': 'business-hours',
        'budgetBand': 'hobby',
        'timelineWeeks': 8,
    },
    'components': [
        {'name': 'Web app', 'kind': 'client', 'responsibility': 'Customer UI', 'technology': 'Next.js'},
        {'name': 'API', 'kind': 'service', 'responsibility': 'Listings and orders', 'technology': 'Node.js'},
        {'name': 'Primary DB', 'kind': 'datastore', 'responsibility': 'Orders', 'technology': 'PostgreSQL'},
    ],
    'summary': 'A marketplace for same-day surplus bread pickup.',
}


def call(ctx, label, i):
    body = json.dumps({'costContext': ctx}).encode()
    req = urllib.request.Request(BASE, data=body, headers={'Content-Type': 'application/json'})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = json.load(r)
            rec = data['recommendation']
            dt = time.time() - t0
            print(f'  [{label} run {i}] HTTP {r.status}  provider={rec["recommendedProvider"]}  '
                  f'selections={len(rec["selections"])}  assumptions={len(rec["assumptions"])}  '
                  f'tradeoffs={len(rec["tradeoffs"])}  {dt:.1f}s')
            return r.status == 200
    except urllib.error.HTTPError as e:
        dt = time.time() - t0
        print(f'  [{label} run {i}] HTTP {e.code} FAIL {dt:.1f}s :: {e.read().decode()[:200]}')
        return False
    except Exception as e:
        print(f'  [{label} run {i}] ERROR {e}')
        return False


results = {}
for label, ctx in [('LARGE ColdWatch (9 roles)', large_ctx), ('SMALL 3-component', small_ctx)]:
    print(f'== {label} ==')
    ok = [call(ctx, label, i) for i in range(1, 4)]
    results[label] = ok

print('\n=== SUMMARY ===')
all_ok = True
for label, oks in results.items():
    n = sum(oks)
    print(f'{label}: {n}/3 returned HTTP 200')
    all_ok = all_ok and n == 3
print('ACCEPTANCE', 'PASS' if all_ok else 'FAIL')
sys.exit(0 if all_ok else 1)
