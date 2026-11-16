# Entity-level element shapes

The `value` of an `op: add`, by kind. `?` marks an optional field. Role and action references are ids, never titles.

- **variant**: `{ id, title }`
- **attribute**: `{ id, title, type, values?, entity?, by?, note? }`
  A parameter of the entity as the product stores it (title, status, price, due date). `id` is the field
  name the entity's reader returns. `type` is one of `text`, `number`, `money`, `date`, `bool`, `enum`,
  `link`, `file`, `other`; `values` lists an enum's values; `entity` is the target of a link. `by` lists the
  roles that may change it — everyone else must be refused; `note` holds a condition in plain words
  ("admin only while Created"). Keep every parameter a user or client can see, system-set ones too. A status-like
  enum is a lifecycle: its values are what states match on.
- **state**: `{ id, title, variants?, match }`
  `match` is `{ <field the reader returns>: <value> }`, or `{}` when it is not known how the state shows.
- **action**: `{ id, title, kind?, changes?, by?, run? }`
  A verb applied to the entity, named after what it does. `kind` is `create`, `read`, `update`, `command`
  or `delete`. `changes` lists the attribute ids it changes. `by` says who performs it when no transition
  or permit says so yet. `run` is the name of its implementation in the actions library — set it only for
  a verb you performed in the live app. Propose a new verb together with the transition or permit that uses it.
- **transition**: `{ id, title, from, to, action, by, variants?, guards?, effects? }`
  `action` is an action id (existing, or added in the same call). `by` lists every role that may perform
  it. `guards` are conditions in plain words; `effects` are `{ description, field?, equals? }`. Creating
  the entity is a transition from `"@new"` to the state a new instance starts in.
- **permit**: `{ id, title, action, by, states?, variants?, effects? }`
  Use a permit instead of a transition when the action leaves the state as it is: a read, an update, a
  command with no state change.
- **rule**: `{ id, title, text, action, transition?, requires? }`
  Knowledge in the product's words. Add `transition` and `requires` when the rule is a checkable condition
  on a transition. Each item of `requires` is `{ kind: "authenticated" }`, `{ kind: "roles", roles: [ids] }`
  or `{ kind: "entity-state", relation, states: [ids] }`.
- **invariant**: `{ id, title, text, states?, holds? }`
  What is always true of the entity in those states, whatever led there ("a shipped order is always paid
  for"). Add `holds: { <field>: <value> }` when a reader field shows it; every test then checks it after
  each read.
- **scenario** (a journey): `{ id, title, start, path }` — `path` is a list of transition ids.
