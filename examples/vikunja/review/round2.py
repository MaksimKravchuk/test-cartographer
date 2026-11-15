# Second round, after the first test run and the action library's findings:
# what the person adds by hand. Run once: python3 review/round2.py
import yaml

path = 'entities/task.yaml'
e = yaml.safe_load(open(path))
human = {'source': 'human', 'sources': ['help-projects']}

# The research put `by` on the create action instead of a transition from @new,
# so the first run planned "owner can't create a task" and failed on it.
if not any(t['id'] == 'create' for t in e['transitions']):
    e['transitions'].insert(0, {'id': 'create', 'title': 'Create a task', 'from': '@new', 'to': 'open', 'action': 'create',
                                'by': ['owner', 'admin', 'writer'], 'status': 'confirmed', 'provenance': {'source': 'human'}})

# help-projects: "Archiving hides a project from the main working views and makes it read-only."
# Nothing in the model checked that for the project's tasks; these rules make the
# engine plan one negative scenario per transition with the project archived.
for t in ('mark_done', 'reopen', 'trash_open'):
    rid = f'{t}_needs_active_project'
    if not any(r['id'] == rid for r in e['rules']):
        e['rules'].append({'id': rid, 'title': f'No “{t}” in an archived project', 'transition': t,
                           'text': 'An archived project is read-only, so its tasks cannot be changed until it is unarchived.',
                           'requires': [{'kind': 'entity-state', 'relation': 'project', 'states': ['active']}],
                           'status': 'confirmed', 'provenance': human})

yaml.safe_dump(e, open(path, 'w'), sort_keys=False, allow_unicode=True, width=120)
print('round 2 applied')

# The explorers named library entries that don't exist (project.view_shares, task.favorite):
# unset them, so those scenarios plan as blocked instead of failing at run time.
import re
library = set(re.findall(r"^\s+'([a-z]+\.[a-z-]+)':", open('actions/index.ts').read(), re.M))
for eid in ('project', 'task'):
    p = f'entities/{eid}.yaml'
    ent = yaml.safe_load(open(p))
    for a in ent['actions']:
        if a.get('run') and a['run'] not in library:
            print('unset run', eid, a['id'], a.pop('run'))
    yaml.safe_dump(ent, open(p, 'w'), sort_keys=False, allow_unicode=True, width=120)
