---
paths:
  - "turma/server.js"
  - "turma/push.js"
---

# Turma notifications (FCM alerts)

The hub half of the push pipeline: edge-triggered alerts, the runaway-spend detector, and the FCM
transport. Read `.claude/rules/turma.md` first (dashboard + auth) and `CLAUDE.md` for the heartbeat
wire contract and Web ⇄ Android parity — Android's channels/`Notifications.kt` are the client half.

## Notifications

- Hub pushes edge-triggered alerts to the Android client via **FCM**, the sole transport: host
  offline/recovered, restart loop, per-session ready-for-review/question/runaway spend, Claude login
  required/expiring/restored.
- **One alert per piece of work** (XERK-224): "ready for review" fires entering the Sessions page's
  Ready-for-review group (`readyForReview`), replacing the old separate turn/PR notices. Tags `mag` →
  Android's `CH_TURN` (renamed "Ready for review", id kept so channel settings survive); retracted
  when it leaves. Fires only on something NEW (a just-finished turn or just-settled PR); a pending
  question suppresses it (already that session's buzz).
  - **A PR still waiting on CI HOLDS the alert** (XERK-153) — never fire on the URL being scraped. A
    settled verdict is read off `session.prs`, never the per-beat scrape list alone (which empties on
    a PR scraped pre-boot or reopened later).
  - Four rules in `prAlertDecision`'s doc comment must not be undone: a **CONFLICTING** open PR never
    alerts (XERK-223 — merges nowhere however green); `failing` stays quiet permanently; absent
    `checks` is "not fetched yet" not "no CI" (`PR_NO_CI_GRACE_MS`); an inconclusive wait ages out and
    fires anyway (may delay, never lose).

### Runaway session spend (XERK-310)

- A session's cost is invisible until somebody opens `/usage` and adds it up, so a run that takes
  the fleet's whole day is only ever found afterwards. The heartbeat already carries per-session
  usage, so `heartbeatAlerts` checks it for free.
- **Two ABSOLUTE stages** (`SESSION_SPEND_WARN_TOKENS` 100M, `SESSION_SPEND_HIGH_TOKENS` 200M, read
  by `spendThresholdEnv`), each fired once on the crossing. Deliberately not a multiple of a rolling
  median: a threshold that drifts up with spend stops firing exactly as spend gets worse.
- **The pair is validated and SORTED at load** into `SESSION_SPEND_STAGES`: if an operator sets WARN
  above HIGH, the stages are re-ordered ascending so the stage-1 body can never name a ceiling above
  the number in the title (D7), and the alert names `SESSION_SPEND_STAGES[stage-1]`, the threshold
  actually crossed. A stage set to an explicit **`0` is dropped (disabled)** — `spendThresholdEnv`
  reads `0` as "off" where `positiveEnv` would refuse it — so a single-stage alert is set by zeroing
  one; an ABSENT var still takes the default, never disables.
- **`sessionSpendTokens` sums the same four counters `usage.html` does**, `cacheRead` included —
  that is ~97% of real spend and the whole reason a long session gets expensive. A malformed bucket
  contributes 0 rather than a plausible figure. **The SUM is finite-checked too, not just each
  field**: two individually valid `Number.MAX_VALUE` counters overflow to `Infinity`, which would
  otherwise format as a bogus "InfinityB" stage-2 alert — a non-finite sum is treated as 0, and
  `fmtSpendTokens` guards its own input.
- Stages are **counted, not matched**, so a session crossing both between two of the staggered usage
  refreshes lands on stage 2 and never emits the one it skipped.
- **Both stages ride ONE `notifKey`** (`spend:<host>:<id>`), so the escalation replaces the first
  notice rather than stacking beside it. **Never retracted** — spend only grows, so there is no
  addressed edge a `dismiss` could fire on.
- **The stage reached is remembered in `alerts.spendSeen`, NOT only on the per-session `sa`.** `sa`
  is swept the instant a beat omits a session (the `liveIds` cleanup), and a momentarily empty beat —
  an agent restart whose `~/.turma` registry did not survive, or a session migrated to another host —
  would otherwise re-announce the same still-high spend at stage 2. `spendSeen` is a bounded
  `{id: stage}` map (`SPEND_SEEN_MAX`, newest kept, same idiom as `prSeen`) that survives the sweep
  and is persisted, so the crossing fires exactly once across restarts, empty beats and re-listing.
  - **A still-LISTED session refreshes its slot every beat** (`recordSpendStage` on the no-crossing
    branch): a session pinned at its top stage never crosses again, so without the refresh it would
    age to the oldest slot and be evicted — then re-announce — once `SPEND_SEEN_MAX` OTHER sessions
    crossed on the host. Eviction is thus kept to ids the host no longer reports. `spendSeen` is
    per-HOST, so a migration to another host does re-announce there (new host, still expensive).
- **`spendSeen` and `sa` both persist, but persistence has a 30s debounce** (`scheduleSave`): a hub
  killed within 30s of the flagging beat, before `state.json` is written, re-announces on reboot.
  Same window the command queue already carries; acceptable, since the alert is informational and a
  double-buzz on a hard restart is not a correctness problem.
- **It is the one session alert outside the XERK-224 one-alert-per-piece-of-work rule**: a session
  can be both mid-turn and far too expensive, and the review alert would not be the thing to say.
- Gated on `running` — a stopped session's total is history and its record keeps reporting `usage`;
  it announces if resumed, which is when the number can move again. **Notification only**: nothing
  here throttles, interrupts or kills, since a session mid-repro on an expensive bug is allowed to
  be expensive.
- **Repos-root sessions are UNCOVERED and deliberately gated out** (`session.root`). Their
  `usage.totals` is NOT one session's cost: every root session's `worktreePath` is `REPOS_ROOT`, and
  `_refresh_usage` folds every `.jsonl` in that one `_project_slug` dir — "that ONE slug dir
  accumulates EVERY root session's transcript", and nothing deletes a transcript after archiving. So
  a root session's total is the whole root-session history on the host, and alerting on it would buzz
  every new root session at stage 2 on its first beat for spend it did not incur. Covering root
  sessions properly needs a per-session usage figure from the agent (an agent-side change across the
  hub/agent seam, since `usage_report(workdir)` is slug-scoped); tracked separately.
- Android routes `money_with_wings` to its own `CH_SPEND` channel (mutable independently of host
  status); a build predating it falls through to `CH_ALERTS`, so the alert still arrives.
- **The stage-2 `priority: "high"` does not make the phone buzz harder, and nothing here should be
  written as though it does.** `Notifications.kt` never reads `data["priority"]` — on Android 8+
  urgency is the CHANNEL's `IMPORTANCE`, and `push.js` already sets the FCM *transport* priority
  high for every message (delivery/doze, not presentation). The escalation the operator sees is
  textual and replacing: a higher token figure in the title, a different body, the stage-1 notice
  replaced under the shared `notifKey`. `CH_SPEND` is `IMPORTANCE_DEFAULT` deliberately — the warn
  stage fires several times on a busy day, and a channel that buzzes for it would be muted outright;
  raising the urgency is the operator's own channel setting, the reason this alert has its own
  channel rather than folding into `CH_HOST`.
- Tests: the `spend:` cases in `server.test.js`, and the persistence case in `registry-restore.test.js`.
- **Claude login alerts** (XERK-98): edge-triggered `needsLogin`/`expiringSoon` off `claudeAuth`,
  deduped, hard state supersedes soft (a lapse-then-recover fires only "restored"). Routes to Android
  `CH_HOST`.
- Every alert funnels through `notify()` → `turma/push.js` (FCM HTTP v1, service-account JWT via
  `node:crypto`, enabled by `FCM_SERVICE_ACCOUNT_JSON`), carrying `tags`/`priority`/`click`/
  `route:{host,sessionId}`. No-op with no device/FCM off. Devices register via `POST /api/devices`,
  unregister via `DELETE /api/devices?token=`; dead tokens pruned on send.
- **An addressed alert is retracted from the phone** (XERK-154): stable `notifKey`
  (`question:<host>:<id>`, `review:<host>:<id>`), `dismiss(notifKey)` sends a title-less FCM message,
  once per edge. **Capability-gated** to `features:["dismiss"]` — an older build renders a data-only
  message as a blank notification and keeps the stale alert.
- **Push health is VISIBLE, not just logged** (XERK-152): `pushEnabled = push.fcmEnabled()` on
  `/api/agents` (a hub with no `FCM_SERVICE_ACCOUNT_JSON` silently delivers zero notifications
  otherwise). Tests: `push.test.js`, `prAlertDecision`/`readyForReview`/`XERK-154`/`pushEnabled` in
  `server.test.js`.
