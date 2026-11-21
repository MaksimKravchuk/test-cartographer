---
name: writing-actions
description: Turns a verb the agent has just done through the UI into steps for the project's action library, checked live by the engine, so tests and later runs repeat it with no model. Use when a transition or permit is confirmed and its action has no `run` entry yet.
metadata:
  tools: "model write_action reach act read"
---

# Writing actions

Every click you make costs a model call, and the next run pays for it again. An action in the library is
replayed by the engine: tests and later runs repeat it for free, and `reach()` uses it to set up states. So
once you have done a verb through the UI and confirmed it with `read()`, leave it behind as steps.

## When

- The verb is on the model (`model()`) or in your proposal, and its action has no `run` yet.
- You have done it through the UI at least once and a `read()` showed its effect.
- Not for a verb the library already has: use `act()` for it.

## How

1. Pick a name `<entity>.<verb>`, like `order.pay`.
2. Write the steps you took, as the engine will replay them:

   ```yaml
   description: Buyer pays for the order
   steps:
     - open: /orders/{{key}}
     - click: { testid: action-pay }
     - fill: { label: Card number }
       value: "{{roles.buyer.card}}"
     - click: { role: button, name: Pay }
     - wait: { testid: order-status }
   available: { testid: action-pay }
   ```

   - Steps: `open` (a path of the interface), `click`, `fill` + `value`, `select` + `value`, `press` (a key,
     with an optional `on` target), `wait` (until a target shows), `request` (an API call with the role's own
     sign-in: `{ method, path, body }`, and `key` to take a new instance's key from the JSON answer),
     `keyFromUrl` (a pattern whose first group is the new key, read from the page URL).
   - A target is one of `testid`, `role` with `name`, `label`, `placeholder`, `text`: what you saw in
     snapshots, best first. Never a ref like `e12`: it changes on every snapshot.
   - End with a `wait` for something that shows the page settled.
   - Values may use `{{key}}`, `{{rel.<relation>}}` and the data people attached, `{{roles.<id>.<field>}}` /
     `{{entities.<id>.<field>}}`. Never write a value out: a secret must stay a reference.
   - A creating action (from `@new`) ends with `keyFromUrl` or a `request` with `key`.
   - Where the UI only wraps an API call you saw in the network and the UI step itself is not what is being
     checked, a `request` step is faster and steadier.
   - `available` is the target that shows the action is offered; deny checks use it.
3. Call `write_action({ name, from, expect, action })`. `from` is the state it starts in, `expect` the fields a
   read must show afterwards (the target state's `match`). The engine reaches `from` itself, runs the steps as
   your role and reads the instance back.
4. If it fails, read the message, fix the steps and call again. After three failures, give up: the verb stays
   a manual one, and say why in a gap finding.
5. On success, cite the returned evidence on the op that sets the action's `run` to the name: an `update` of
   an existing action (`set: { run: <name> }`) or the `add` of a new one. When a person accepts that op, the
   steps join the library.
