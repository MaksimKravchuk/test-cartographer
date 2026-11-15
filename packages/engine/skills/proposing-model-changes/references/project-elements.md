# Project-level element shapes and the backlog

A research or review run hands in groups: one project-level group and one group per entity.

```
{ rationale,
  project:  { ops, findings },                  roles, interfaces, new entities, epics, features, stories
  entities: { <entity id>: { ops, findings } }  that entity's own elements
}
```

## Shapes

The `value` of an `op: add`, by kind. `?` marks an optional field.

- **role**: `{ id, title, kind, interface?, login? }` — `kind` is `human` or `system`; `interface` is an
  interface id; `login` is `{ action, args }`. A scheduled job, queue consumer or integration is a system role.
- **interface**: `{ id, title, baseUrl }`
- **entity**: `{ id, title, description?, key?, reader?, variants? }` — creates the entity. Leave `reader`
  out when nobody knows yet how to read the entity back.
- **epic**: `{ id, title, description?, key?, url? }`
- **feature**: `{ id, title, description?, epic?, key?, url?, actions }` — `actions` lists
  `"<entity>.<action>"`, across entities: a checkout feature is `["order.place", "order.pay"]`.
- **story**: `{ id, title, text?, acceptance, feature?, epic?, key?, url?, trackerStatus?, covers }` —
  `acceptance` is a list of strings; `covers` lists the elements the story specifies, as
  `"<action|transition|permit|rule|journey>:<entity>.<id>"`.

## The backlog is a view, not a second model

Epics group features, a feature is a slice of the model by action, and a story points at the exact elements
it specifies. Everything about behavior belongs in the model; the backlog only says where it came from and
how it is grouped. A story's `covers` may name only elements that exist or are proposed in this run: when
the behavior is not there yet, leave `covers` empty or partial and add a finding (kind=gap).
