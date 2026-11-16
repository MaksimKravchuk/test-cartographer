import { test } from 'node:test';
import assert from 'node:assert/strict';
import { members, outlineText, typesIn, uncovered } from '../src/outline.ts';

test('outline: fields, variants and doc comments of a Rust module, one line each; bodies left out', async () => {
  const src = `/// A thing to do.
#[derive(Debug)]
pub struct Task {
    pub title: String,
    /// When it is due.
    pub due: Option<Day>,
}

pub enum TaskState { Inbox, Next, Done }

pub fn complete(t: &mut Task) -> Result<(), Error> {
    let inner = 1;
    Ok(())
}
`;
  assert.deepEqual(await outlineText(src, 'x.rs'), [
    '3: pub struct Task {  /// A thing to do.',
    '4:   pub title: String',
    '6:   pub due: Option<Day>  /// When it is due.',
    '9: pub enum TaskState { Inbox, Next, Done }',
    '9:   Inbox',
    '9:   Next',
    '9:   Done',
    '11: pub fn complete(t: &mut Task) -> Result<(), Error> {',
  ]);
  assert.equal(await outlineText('x', 'notes.md'), undefined);
});

test('outline: TypeScript types and exported functions', async () => {
  const lines = await outlineText('export type Order = {\n  id: string;\n  status: "new" | "paid";\n};\nexport function pay(o: Order) {\n  const x = 1;\n}\n', 'a.ts');
  assert.deepEqual(lines, ['1: type Order = {', '2:   id: string', '3:   status: "new" | "paid"', '5: function pay(o: Order) {']);
});

test('outline: uncovered keeps the types and members the model lacks', async () => {
  const lines = await outlineText('pub struct Task {\n  pub title: String,\n  pub due: Day,\n}\npub enum Mood { Calm, Busy }\npub struct Place {\n  pub name: String,\n}\n', 'x.rs');
  const known = new Set(['task', 'title', 'place', 'name']);
  assert.equal(uncovered(`## x.rs\n${lines!.join('\n')}`, (n) => known.has(n.toLowerCase())), '## x.rs\n1: pub struct Task {\n3:   pub due: Day\n5: pub enum Mood { Calm, Busy }\n5:   Calm\n5:   Busy');
});

test('outline: route handlers are marked, and uncovered lists the ones no action explains', async () => {
  const lines = await outlineText('#[utoipa::path(get, path = "/tasks")]\npub async fn list_tasks() {}\n#[utoipa::path(post, path = "/tasks")]\npub async fn create_task() {}\nfn helper() {}\n', 'api.rs');
  assert.deepEqual(lines, ['2: [route] pub async fn list_tasks() {}', '4: [route] pub async fn create_task() {}', '5: fn helper() {}']);
  assert.equal(uncovered(`## api.rs\n${lines!.join('\n')}`, () => false, (h) => h === 'create_task'), '## api.rs\n2: [route] pub async fn list_tasks() {}');
});

test('outline: members lists a type’s fields or variants with their lines', async () => {
  const src = 'pub struct Task {\n    /// Due.\n    pub due: Option<Day>,\n    pub done: bool,\n}\nimpl Task {\n    pub fn x(&self) {}\n}\npub enum TaskState { Inbox, Done }\n';
  assert.deepEqual((await members(src, 'x.rs', 'Task')).map((m) => [m.name, m.row]), [['due', 3], ['done', 4]]);
  assert.deepEqual((await members(src, 'x.rs', 'TaskState')).map((m) => m.name), ['Inbox', 'Done']);
  assert.deepEqual(await members(src, 'x.rs', 'Nope'), []);
});

test('outline: typesIn lists the types with their files', () => {
  assert.deepEqual(typesIn('## a.rs\n1: pub struct Task {\n2:   pub title: String\n\n## b.rs\n4: pub enum TaskState {'), [
    { file: 'a.rs', name: 'Task', enum: false },
    { file: 'b.rs', name: 'TaskState', enum: true },
  ]);
});
