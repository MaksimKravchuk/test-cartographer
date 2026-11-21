---
name: exploring-app
description: Explores a running web application as one role through a browser to learn how one entity behaves - its states, actions, transitions and what the role is refused - and confirms each change by reading the entity back. Use in an exploration run against a live app.
metadata:
  tools: "model prepare reach act read browser_navigate browser_snapshot browser_click browser_type browser_select_option browser_fill_form browser_press_key browser_network_requests login contract"
---

# Exploring a live app

You act as one role through one interface. What you see is what the app does today, which is not the same
as what it is required to do: you report behavior with evidence, and a person decides whether it is intended.

## Workflow

1. Call `model()` to see what is already known about the entity and its roles.
2. **Map first.** Open the entity's screens with `browser_navigate()`, `browser_snapshot()` each, and list the verbs the interface offers this
   role (buttons, menu items, links, editable fields) before trying any of them.
3. **Check one verb at a time, each on a fresh instance.** Create the instance with `prepare()` and `read()`
   it to confirm the state it starts in. An instance already changed by an earlier check gives misleading results.
   When the model already knows how to get to a state, use `reach()`: the engine runs that path itself
   (setup tools and library actions), so you don't spend steps clicking through what is known. For a verb the
   action library already has, `act()` runs it; click by hand only what the library doesn't cover yet.
4. Do the action through the interface, then `read()` the instance again and compare the two reads.
5. Note the app's answer when it refuses: the message is part of the behavior.
6. Hand in what you have worked out before moving to the next verb.

## When a change counts as confirmed

A transition is confirmed only when a `read()` after the action shows its effect. The interface saying
"Saved" is not enough. If you cannot confirm it, still propose the operation, and add a finding (kind=gap)
with the reason:

- the entity could not be read back (say what `read()` answered);
- the read shows no change;
- the read contradicts what the interface showed;
- the action changed something else instead.

## The model is a closed world

For a human role, anything not allowed by a confirmed transition or permit is already denied. Do not
propose what a role cannot do. Report the two kinds of mismatch as a finding (kind=contradiction) with
evidence: the app lets the role do something the model does not allow, or refuses something the model allows.

Behavior that looks like a bug is still proposed as observed, with a finding next to it — a contradiction
when the model says otherwise, a question when only intent is unclear.

## Evidence

`browser_snapshot()`, `browser_network_requests()` and `read()` return evidence ids. Every operation and finding cites the ids that show it, in
its own `evidence` array: for a transition, the read before and the read after.

## Using the tools

- The browser tools are Playwright's. `browser_snapshot()` marks elements with `[ref=…]` and lists the page's
  test ids. Pass a ref as `target` to `browser_click()`, `browser_type()` or `browser_select_option()`, or a
  test id as a locator (`getByTestId` and the id, quoted). Refs go stale when the page changes: take a new snapshot first.
  An action does not return the page: call `browser_snapshot()` to see it, and to save it as evidence.
- `browser_navigate()` takes a path inside your own interface (`/orders/42`); other sites are refused.
- `browser_network_requests()` shows the API calls the page made: use it when the screen alone doesn't show
  what an action did.
- You are already signed in. If the app signs you out, call `login()`.
- A secret appears only as a `{{…}}` reference. Pass the reference to `browser_type()` or `browser_fill_form()` as it is; the engine types
  the real value.
- Create data only with `prepare()`, and change only instances you prepared: the app may be shared.
- `contract()` reads an API contract when the task lists one.
