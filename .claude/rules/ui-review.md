---
paths:
  - "turma/public/**"
  - "glasses/src/**"
  - "android/app/src/**"
---

# Present UI changes for screenshot review BEFORE opening a PR

Any change that alters what a person SEES or TOUCHES in a UI — `turma/public/**` (pages, CSS,
`chat.js`/`board.js`/`nav.js`/…), `glasses/src/**`, `android/app/src/**` — is shown to the operator
as a rendered screenshot and approved BEFORE a pull request is created.

## Why

Visual/layout iterations are cheap to eyeball and expensive to churn through QA + CI + PR. A run of
"a bit tighter / move it here / now right-align it" costs a full QA pass, a CI run and a PR revision
each time, when one screenshot up front would have settled the look. Screenshot first, spend the
pipeline once.

## How

- Make the change, render it, and `SendUserFile` the screenshot(s) — the REAL page/screen, in the
  states that matter (e.g. empty vs full, light + dark, phone width) — then wait for the operator's OK.
- Produce that first screenshot with the CHEAPEST faithful render (a booted-hub browser drive / the
  `verify` skill's recipe). Do NOT spend a full `qa` pass just to get a picture.
- Only AFTER the operator approves the look: run `qa`/`qa-delta`, then create the PR and watch CI.
- If the operator asks for another visual tweak, iterate on the screenshot — do not open or update a
  PR, and do not re-run QA, until they approve.
- Exempt: pure non-visual plumbing under these paths (server/agent logic, wire fields, refactors with
  no visible change). This gate is about what a person sees, not every edit to a UI file.
