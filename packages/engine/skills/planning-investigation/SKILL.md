---
name: planning-investigation
description: Plans a research, review or exploration run over a product's sources or its live app - scope, a map of what exists, a list of questions, and a closing status for every question. Use at the start of any run that covers several sources or more than one entity, and again just before handing in the final result.
metadata:
  tools: "model record propose"
---

# Planning an investigation

A run has a fixed budget of tool calls, and the person who reviews the result cannot see what was skipped.
A plan made up front is what lets the final report say, truthfully, what is covered and what is not.

## Workflow

1. **Take the scope as given.** The scope is the task plus what `model()` returns. Do not narrow it on your
   own: if the budget cannot cover everything, that is reported at the end (step 6), not decided silently.
2. **Map before digging.** Get the cheapest overview of everything in scope first — the list of sources and
   their sizes, the top of a file tree, the app's navigation. Read nothing in depth yet.
3. **Write the questions.** Turn the scope into a short list of questions, each with the evidence that would
   answer it. Include every open question `model()` returns from earlier runs.
4. **Split the budget.** Give each question a rough share of the tool calls and keep the last fifth for
   handing in. A question that eats twice its share gets closed as "partly" and you move on.
5. **Work one question at a time**, from where it starts (a page of the requirements, an entry point in the
   code, a screen) to its result. When a question or an entity is done, hand it in with `record()` before
   starting the next: finished work is then safe if the run is cut short.
6. **Close every question.** Go back to the list and give the rationale of the final `propose()` one line
   per question: `answered`, `partly` or `open`, and why. The run log keeps it, so the reviewer sees the plan
   and how it ended. List everything in scope you did not get to in one finding (kind=gap) whose note starts
   with `Not reached:` — a finding is what lands in the reviewer's inbox.

## Example of a question list

```
1. Who may cancel an order, and until when?   needs: a requirement, the cancel handler, the app's refusal
2. What states does an order go through?      needs: status values in the code, wording in the docs
3. (open from an earlier run) Is auto-cancel after 24 h a requirement?   needs: a requirements page
```

## Example of closing lines in the rationale

```
1. answered — requirement and code agree (e3, e7).
2. partly — "refunded" appears in the code only; no requirement found in docs or tracker.
3. open — searched product-overview and the tracker export for "24", "auto", "expire": nothing.
```
