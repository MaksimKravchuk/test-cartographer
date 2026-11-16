import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outlineText } from '../src/outline.ts';

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
