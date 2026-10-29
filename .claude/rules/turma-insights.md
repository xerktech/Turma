---
paths:
  - "turma/public/insights.html"
  - "turma/tests/insights.test.js"
  - "turma/server.js"
  - "turma/tests/server.test.js"
---

# The Insights page (XERK-2386) and the decisions log (XERK-1574)

## The page

- `/insights` (nav `insights`, after Usage) holds the fleet's oversight surfaces as SUB-PAGES:
  Decisions, Permission prompts (`turma-permissions.md`), Model quality (`model-quality.md`).
  - One pane shows at a time, named by the URL hash (`#decisions`, `#permissions`,
    `#model-quality`; anything else is Decisions), so a sub-page is linkable and Back works.
  - **Only the shown pane fetches** (`syncPaneScope`, the minute timers check `pane`): the two
    cards' routes are their own fetches, never `/api/agents`, and a hidden one costs the hub nothing.
  - The cards scope by the header org pick exactly as they did on `/usage` (same code).
- **Web-only by operator decision** — Android has none of it (`android/PARITY.md`).
- **The org brief is retired** (XERK-2386): no sweep, store, push, narrative or page. `/brief`
  301s to `/insights`; the heartbeat still DROPS an older agent's `briefRender`/`briefNarratives`
  (kept in `HEARTBEAT_KNOWN_KEYS`). An existing `/data/briefs.json` is ignored.
  - Do not reintroduce a scheduled brief or its push: the operator found it not useful.
- Tests: the `XERK-2386:` cases in `insights.test.js` and `server.test.js`; `nav.test.js`.

## The decisions log (XERK-1574)

- **Store**: `/data/decisions.json` (`DECISIONS_FILE`), siteKey → oldest-first entries, 200 kept
  (`DECISIONS_KEEP`, oldest evicted). Appended ONLY by operator actions — human rate, so a
  `registerExternalStore` is right; HA rewrites ≤200 short rows per org per answer, not per beat.
  `sanitizeDecision` is the one whitelist (`source` question|permission|note; `question` ≤300,
  `answer` ≤200, `text` ≤500; inline literals; null-proto map; a coerce fixed point).
- **No lone surrogate leaves the whitelist**: a cap through an emoji drops the stranded high half,
  any other becomes U+FFFD (`permissionWhy`'s clip too). The agent writes UTF-8, which cannot
  encode one; `_decision_cell` also replaces them, so one bad row never wedges the file.
- **Writers, always under the DECIDED org (`decidedOrgOf`), never the claimed siteKey**:
  - the answer route → `{question, answer}` = the session's served `question` + the picked
    `questionOptions` labels (an index past them is dropped; "option N" only for a missing
    label) + `, plus a typed answer` for free text
    (`(a typed answer)` alone with no pick) — never its words: the log reaches every same-org
    session, and text typed for one must not;
  - the pane-prompt route → `permissionDecisionQuestion`: the dialog's TOOL title ("Bash",
    "Edit file"; `DIALOG_TITLE_RE`), + the picked option's KIND (`permissionAnswerKind`: "Yes" /
    "Yes, don't ask again" / "No", else "option N") — never the label, which can name the command
    or host ("… don't ask again for docker compose commands");
  - **never the subject's body** (command line, path, URL): it is session content and can carry a
    secret (`curl -H "Authorization: Bearer …"`), cut for the reason a typed answer's words are.
    Do not switch this to `permissionWhy` — that serves the body for the attention line only;
  - the dialog's question rides after the tool ONLY when it is not boilerplate —
    `GENERIC_DIALOG_Q_RE` drops "Do you want to …?" / "Would you like to proceed?", which only pad
    the line; with no title-shaped tool line the question is all there is, generic or not.
  - `POST /api/orgs/<site>/decisions {text}` (operator-authed, 400 empty / 413 >500 / 404 an org no
    host is decided into, minting no key).
  - Nothing is logged for a drifted/unbound host, an unknown session, or no pending question. It is
    logged at the ANSWER, so an answer the agent later drops as stale is still recorded.
- **Delivery**: top-level `decisions` on `/api/agents` + its `decisions` SSE frame (each org's
  newest 20, `decisionsWire`), and on EVERY heartbeat reply as `decisions:{org, entries}` (the
  decided org's newest 30; `org:""` + none for a host in no decided org, which removes its file).
- **A count is `decisionCounts`, never the served list's length** — the tail is capped at 20 of
  200 kept. Top-level on `/api/agents` + its own SSE frame (sent just before `decisions`); clients
  show `max(count, served)` so an older hub's absent count degrades to the tail.
- **`decisionsTick` drops an org's log** `DECISIONS_RETAIN_MS` (30 days) past its newest entry once
  no host is in it (`decidedOrgs`); nothing else removes a store key.
- **Surface**: the Insights page's Decisions sub-page (`decisionsHtml`): one card per org, newest
  first, the note box for a live org; a draft survives repaints via `drafts` + a focus restore.
  - A row's meta names its session (`label`, clipped to `DECISION_LABEL_MAX` 60) — the only tie
    back for an answer with no ticket.
  - **Each meta piece is unbreakable** (`.bit`) and **the "·" ENDS the piece before it** (`.sep`),
    so a line wraps only between pieces and never starts with a dot.
  - **The typed-answer marker is not a choice**: `answerHtml` splits off `, plus a typed answer`
    (or a lone `(a typed answer)`) and shows it muted, never bold.
  - A row's kind is a noun — `question` / `permission` / `note` (`DECISION_KIND`).
- Tests: the `XERK-1574:` cases in `server.test.js` and `insights.test.js`.
