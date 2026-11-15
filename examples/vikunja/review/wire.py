# The person's wiring after the first research: what no source can say —
# how to read an instance back, how to prepare each state, which library entry
# performs each action. Plus the two read permits re-added without the rejected
# link-share role. Run once: python3 review/wire.py
import yaml

RUN = {
    'project': {'read': 'project.view', 'update': 'project.edit', 'archive': 'project.archive',
                'unarchive': 'project.unarchive', 'trash': 'project.delete', 'restore': 'project.restore'},
    'task': {'create': 'task.create', 'read': 'task.view', 'update': 'task.edit', 'mark_done': 'task.done',
             'reopen': 'task.undone', 'trash': 'task.delete', 'restore': 'task.restore'},
}
STATUS = {'active': 'active', 'archived': 'archived', 'in_trash': 'trashed', 'open': 'open', 'done': 'done'}
MINE = {'source': 'human'}

def wire(eid, tool, setup_tool, extra_setup=None):
    path = f'entities/{eid}.yaml'
    e = yaml.safe_load(open(path))
    e['reader'] = {'tool': f'vikunja.{tool}', 'args': {'id': '{{key}}'}}
    for s in e['states']:
        if s['id'] in STATUS:
            s['match'] = {'status': STATUS[s['id']]}
            s['setup'] = [{'kind': 'tool', 'tool': f'vikunja.{setup_tool}', 'args': {'status': STATUS[s['id']], 'tag': '{{runTag}}', **(extra_setup or {})}}]
    for a in e['actions']:
        if a['id'] in RUN[eid]:
            a['run'] = RUN[eid][a['id']]
    # Variants that only split scenarios without a different setup: one variant each.
    e['variants'] = [v for v in e['variants'] if v['id'] not in ('default',)]
    for v in e['variants']:
        if v['id'] in ('sub_project', 'repeating'):
            v['status'] = 'observed'
    readers = ['owner', 'admin', 'writer', 'reader']
    states = ['active', 'archived'] if eid == 'project' else ['open', 'done']
    # Fixes to what the agent proposed (each listed in the case study):
    # a permit on a create-kind action is invalid; a rule may not name a "self" relation;
    # a state nobody can read back needs a field to match, even when only observed.
    e['permits'] = [p for p in e['permits'] if p['id'] not in ('duplicate', 'read')]
    for r in e['rules']:
        if any(q.get('relation') == 'self' for q in r.get('requires', [])):
            r.pop('requires')
    for s in e['states']:
        if s['id'] == 'purged':
            s['match'] = {'status': 'purged'}
    e['permits'].insert(0, {'id': 'read', 'title': f'View the {eid}', 'action': 'read', 'by': readers, 'states': states,
                            'status': 'confirmed', 'provenance': MINE})
    return path, e

p_path, project = wire('project', 'get_project', 'create_project')
t_path, task = wire('task', 'get_task', 'create_task', {'projectId': '{{rel.project}}'})
# A task lives inside a project: setup prepares an active project first.
task['relations'] = [{'id': 'project', 'entity': 'project', 'field': 'project_id', 'kind': 'part-of', 'requires': 'active'}]
for path, e in ((p_path, project), (t_path, task)):
    yaml.safe_dump(e, open(path, 'w'), sort_keys=False, allow_unicode=True, width=120)
print('wired', p_path, t_path)
