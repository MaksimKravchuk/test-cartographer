import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { Entity, Workspace, diffEntity, removeRole } from '../src/index.ts';

const task = (actions: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  Entity.parse({ id: 'task', title: 'Task', variants: [{ id: 'default', title: 'Default' }], actions, ...extra });

test('diffEntity names each element added, changed or removed', () => {
  const before = task([{ id: 'create', title: 'Create', by: ['user'] }, { id: 'archive', title: 'Archive' }]);
  const after = task([{ id: 'create', title: 'Create', by: ['user', 'admin'] }, { id: 'done', title: 'Complete' }]);
  assert.deepEqual(
    diffEntity(before, after).map((c) => [c.op, c.ref, c.changes]),
    [
      ['change', 'action:task.create', { by: [['user'], ['user', 'admin']] }],
      ['add', 'action:task.done', undefined],
      ['remove', 'action:task.archive', undefined],
    ],
  );
  assert.deepEqual(diffEntity(null, after).map((c) => c.ref), ['entity:task']);
});

test('the workspace logs saves with their author and skips a broken line', async () => {
  const ws = new Workspace(await mkdtemp(join(tmpdir(), 'tc-history-')));
  await ws.saveEntity(task([]));
  await appendFile(ws.path('history.jsonl'), '{not json\n');
  await ws.saveEntity(task([{ id: 'create', title: 'Create' }]), undefined, { kind: 'agent', agent: 'onboard', proposal: 'p1' });
  const log = await ws.history('entity:task');
  assert.deepEqual(log.map((e) => [e.ref, e.by.kind]), [['entity:task', 'human'], ['action:task.create', 'agent']]);
});

test('removeRole strips a subject that shares the work and blocks where it acts alone', () => {
  const shared = task([{ id: 'create', title: 'Create', by: ['user', 'admin'] }], {
    states: [{ id: 'open', title: 'Open', initial: true, match: {} }],
    transitions: [{ id: 't', title: 'Create it', from: '@new', to: 'open', action: 'create', by: ['admin'] }],
  });
  const ok = removeRole('user', { agents: [], roles: [] }, [shared]);
  assert.deepEqual(ok.blockers, []);
  assert.deepEqual(ok.entities[0].actions[0].by, ['admin']);
  assert.deepEqual(removeRole('admin', { agents: [], roles: [] }, [shared]).blockers, ['Task › Create it']);
  const login = { action: 'auth.login', args: { password: '{{roles.user.password}}' } };
  assert.deepEqual(removeRole('user', { agents: [], roles: [{ id: 'admin', title: 'Admin', kind: 'human', fields: [], login }] }, []).blockers, ['sign-in of “Admin”']);
});
