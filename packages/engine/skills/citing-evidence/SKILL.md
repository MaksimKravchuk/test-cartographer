---
name: citing-evidence
description: Backs every proposed operation and finding with an exact quote from a source, says what kind of proof that quote is, and reports a failed search with its scope. Use whenever a claim about the product comes from documents, tracker items, code or MCP sources - before each record or propose call.
metadata:
  tools: "quote fetch search"
---

# Citing evidence

A person accepts or rejects each operation in seconds, without rereading the source. They can only do that
if the evidence sits next to the claim and says exactly what the claim says.

## Quoting

1. Find the sentence or line that decides the point — the condition itself, not the paragraph around it.
   One to three lines is the right size.
2. Call `quote({ source, text, path? })` with that text exactly. Line wrapping may differ; words and
   punctuation may not. A code folder needs `path`; an MCP source must be read with `fetch()` first.
3. If `quote()` fails, the text is not in the source as you wrote it. Reread and fix the quote. Do not
   paraphrase and do not drop the evidence.
4. Put the returned id in the `evidence` array of the operation or finding it supports — each one carries
   its own. An operation without evidence will not be trusted.

## What a quote proves

The same sentence weighs differently depending on where it came from. Keep the three apart, in your own
reasoning and in every note you write:

| Source kind | What it shows | How to word it |
|---|---|---|
| Requirements: docs, wiki, tracker | Intent — what the product should do | "The spec requires…" |
| Code | Inference — what the product would do; nobody watched it run | "The code allows…" |
| The live app | Observation — what it did, once | "The app refused with…" |

A conclusion you drew is not a quote. "The handler checks the status, so cancellation after shipping is
presumably refused" is an inference: word it as one.

## When sources disagree

Quote every side and report a finding (kind=contradiction) rather than choosing silently. Say which source
wins by priority and why, or that priorities are off and the person decides.

## When you find nothing

"Not found" only means something next to where you looked. Report it as a finding (kind=gap) with the source
ids in `searched` and the files, pages or queries in the note; `search()` tells you how many files it covered.

```
kind: gap
refs: ["rule:order.cancel-window"]
searched: ["product-overview", "shop-code"]
note: No time limit on cancelling found. Searched product-overview for "cancel", "refund", "within";
  searched shop-code (41 of 41 files) for cancel.*(days|hours|expire).
```
