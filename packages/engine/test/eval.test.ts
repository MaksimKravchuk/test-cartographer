import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Workspace } from '@tc/model';
import { flattenReference, flattenWorkspace, matchModel, nameScore, Reference, score } from '../src/eval.ts';

const repo = resolve(import.meta.dirname, '../../..');

test('eval: the demo model against itself finds everything and invents nothing', async () => {
  const items = await flattenWorkspace(new Workspace(resolve(repo, 'workspace')), { proposals: false });
  const e = score(items, items, matchModel(items, items));
  for (const s of e.scores.filter((s) => s.ref)) {
    assert.equal(s.recall, 100, `${s.cat} recall`);
    assert.equal(s.precision, 100, `${s.cat} precision`);
  }
});

test('eval: names match across wording, synonyms and wildcard transitions; extras lower precision', () => {
  assert.equal(nameScore('Create task', 'add', new Set(['task']), true), 1);
  assert.equal(nameScore('signUp', 'sign up'), 1);
  assert.ok(nameScore('colour', 'color') >= 0.8);
  assert.equal(nameScore('Archive project', 'Delete project', new Set(['project']), true), 0);

  const ref = flattenReference(
    Reference.parse({
      subjects: [{ id: 'member', names: ['Signed-in user', 'owner'] }, { id: 'operator', conf: 'low' }],
      objects: [
        {
          id: 'task',
          names: ['Next step'],
          params: [{ id: 'due_date' }, { id: 'waiting_for' }],
          states: [{ id: 'inbox' }, { id: 'next' }, { id: 'completed', names: ['done'] }],
          actions: [{ id: 'create', names: ['Create task'] }],
          transitions: [{ from: ['@new'], to: ['inbox', 'next'] }, { from: ['*'], to: ['completed'] }],
          rules: [{ text: 'A waiting task needs who it waits for' }],
        },
      ],
    }),
  );
  const cand = flattenReference(
    Reference.parse({
      subjects: [{ id: 'user', names: ['Signed-in user'] }],
      objects: [
        {
          id: 'tasks',
          params: [{ id: 'dueDate' }, { id: 'priority' }],
          states: [{ id: 'inbox' }, { id: 'done' }],
          actions: [{ id: 'add', names: ['Add task'] }],
          transitions: [{ from: ['@new'], to: ['inbox'] }, { from: ['inbox'], to: ['done'] }],
        },
      ],
    }),
  );
  const e = score(ref, cand, matchModel(ref, cand));
  const by = Object.fromEntries(e.scores.map((s) => [s.cat, s]));
  assert.equal(by.subject.found, 1);
  assert.equal(by.subject.recallHigh, 100); // the low-confidence operator doesn't count there
  assert.equal(by.object.found, 1);
  assert.deepEqual([by.param.found, by.param.precision], [1, 50]); // dueDate = due_date; priority is an extra
  assert.equal(by.state.found, 2); // done = completed through its synonym
  assert.equal(by.action.found, 1);
  assert.equal(by.transition.found, 2); // inbox → done fits "* → completed"
  assert.equal(by.rule.found, 0); // prose is left to the judge
  assert.deepEqual(e.extras.map((x) => x.key), ['tasks/param:priority']);
});
