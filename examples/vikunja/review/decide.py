# The human review of the first research, as a policy: what I accepted as a
# requirement (✓), kept as observed behavior (≈) or struck out (✕), and why.
# Run against a live engine: python3 review/decide.py [proposal-id-prefix]
import json, sys, urllib.request, urllib.error, glob, yaml

API = 'http://localhost:4317/api'
SCOPE_OUT = {  # elements the action library doesn't drive: kept, but not tested
    'project': {'move', 'duplicate', 'share_team', 'change_share_permission', 'create_link_share', 'delete_link_share',
                'view_trash', 'delete_permanently', 'purge_expired', 'purged'},
    'task': {'move', 'duplicate', 'assign', 'unassign', 'view_trash', 'delete_permanently', 'purge_expired', 'purged',
             'repeating', 'mark_done_repeating', 'restore_done'},
}

def post(path, body):
    req = urllib.request.Request(API + path, json.dumps(body).encode(), {'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(req))

def verdict(p, op):
    v = op.get('value') or {}
    oid = op.get('id') or v.get('id')
    if op['kind'] == 'role':
        return 'reject' if oid.startswith('link_share') else 'accept'  # link shares are out of this case's scope
    if op['kind'] in ('entity', 'epic', 'feature', 'story'):
        return 'accept'
    if oid in SCOPE_OUT.get(p['entity'], ()):  # out of scope for tests
        return 'observe'
    if op['kind'] in ('action', 'state', 'variant'):  # structure, not claims: always accepted
        return 'accept'
    ev = {e['id']: e for e in p['evidence']}
    docs = any(ev.get(e, {}).get('source', '').startswith('help-') for e in op.get('evidence', []))
    # Requirements outrank code: an element only the code backs is behavior, not a requirement.
    return 'accept' if docs else 'observe'

prefix = sys.argv[1] if len(sys.argv) > 1 else ''
for f in sorted(glob.glob('proposals/*.yaml'), key=lambda f: (yaml.safe_load(open(f)).get('entity') is not None, f)):
    p = yaml.safe_load(open(f))
    if p['status'] != 'pending' or not p['id'].startswith(prefix):
        continue
    done = {d['op'] for d in p['decisions']}
    ds = [{'op': i, 'verdict': verdict(p, o)} for i, o in enumerate(p['ops']) if i not in done]
    for d in ds:  # one at a time, so one op the engine refuses doesn't block the rest
        try:
            post(f"/proposals/{p['id']}/decide", {'decisions': [d]})
        except urllib.error.HTTPError as e:
            print('  op', d['op'], d['verdict'], 'refused:', e.read().decode()[:300])
    count = {k: sum(d['verdict'] == k for d in ds) for k in ('accept', 'observe', 'reject')}
    print(p['id'], p.get('entity') or 'project-level', count)
