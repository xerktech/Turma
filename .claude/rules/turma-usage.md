---
paths:
  - "turma/public/usage.html"
  - "turma/usage-ledger.js"
  - "turma/server.js"
  - "turma/tests/usage.test.js"
  - "turma/tests/usage-models.test.js"
  - "turma/tests/usage-ledger.test.js"
---

# Usage page (`/usage`) and the durable usage ledger

- Charts persistent daily/all-time cost from agents' `repoUsage`/`usage` aggregates, not the live
  session list — killed/deleted/pruned work still counts. **By repo** unifies a repo's usage across
  every host it runs on (matched by `remoteKey`); **By host** shows per-host totals.
- `(root)` renders as **Root**; older agents' `(other)`/`?` fold in (`normRepo`/`repoLabel`).
- **"Delegated to sub-agents"** (`subagentCard`, XERK-302) is a SLICE of every other number on the
  page, and says so — adding it back double-counts.
  - **Denominator is `subagentOf`, not the fleet total** — only hosts reporting a split contribute,
    so a silent older host can't dilute the answer (or, if none report one, the card shows nothing).
  - **Accumulates per CONTRIBUTION, not per series** — a series merging many hosts must not read full
    coverage off a host that can't answer.
  - Android's `SubagentLine` mirrors the same three windows.
- Above the chart: the **Claude subscription's 5h/7d windows** (XERK-247) from each agent's `limits`
  block (capture mechanics: `agent-usage.md`).
  - **Every token figure is coerced at ingest** (`normalizeUsageTokens`, XERK-306) — a bad FIGURE
    zeros rather than dropping the block (unlike `subagent`): absent totals isn't a meaningful
    "can't tell" when every client renders them unconditionally. A window/`days`/`usage` that isn't
    an object at all IS dropped; a missing figure is never invented.
  - **An explicit `null` `usage` is dropped but NOT logged** — it's the agent's deliberate "nothing
    to report yet" (new host, or a session whose transcript carries no usage block), so logging it
    would warn on every new host AND swallow real warnings behind the fleet-wide throttle. Any other
    non-object still tallies and names the host.
  - **The drop must stay a `delete`** — `RepoUsage.usage` is NON-nullable on Android, so an explicit
    `null` there is decode-fatal for the WHOLE `/api/agents` array.
  - **`normalizeLimits`/`normalizeSubscription` coerce at ingest** for the same reason: Android
    decodes into TYPED fields, so one bad value fails the WHOLE fleet payload's decode, not just its
    own card.
  - **A card is dropped past `LIMIT_MAX_AGE_SEC`, not just coloured** — the hub keeps an offline
    host's last heartbeat for days, so without this a dead host shows a frozen window that's since
    reset many times.
  - Every card is a **SNAPSHOT** ("captured <age> ago", amber past `LIMIT_STALE_SEC`) — worded
    "captured" not "updated" (there is deliberately no fleet-wide last-refreshed stamp).
  - **A window whose `resetsAt` has passed renders as `—`**, not its last percentage — that window
    has since rolled over. Bar colours: 75% warn, 90% crit.
  - A host reporting no window gets **no card** (older agent / non-subscription / unprobed all mean
    "can't tell", never 0%).
  - **One card per SUBSCRIPTION, not per host** (XERK-301, `limitGroups`, keyed on the agent's opaque
    `subscription.key`) — hosts sharing an account read one pool, so several cards would repeat one
    number. A host reporting none keeps its own card, never folded into another silent host.
    - Each window takes its **FRESHEST** reading (not average/max) — across a reset, the newest read
      is the only right answer. **Both clients sort freshest-first, replacing only on a STRICTLY
      newer read** — fold order or an equal timestamp resolves differently per client otherwise.
  - **`normalizeSpawnRefusals` coerces the served refusal map** (XERK-325) — the first typed-and-
    served field deliberately NOT stripped from the payload, since the `state.json` restore (unlike
    the heartbeat path) can produce a bad one. Keeps the ingest path's PLAIN object shape (an explicit
    `__proto__`/`constructor`/`prototype` key filter, not a null-prototype object, so a restored
    record doesn't differ from a beaten one).
  - **Anything a `normalize*` closes over must be reachable from `loadState`'s line** — that loop
    sits near the top of `server.js` and relies on function-declaration hoisting; a module `const`
    declared below is in its TDZ there, and a `ReferenceError` empties the WHOLE registry on restore
    (XERK-301). `registry-restore.test.js` boots a hub (rather than walking the loader's body like
    `server.test.js`) specifically to catch this.
  - Tests: `usage.test.js`, the `limits`/subscription-key heartbeat cases in `server.test.js`, android
    `UsageViewModelTest`.

## The durable usage ledger (XERK-338)

- **Token usage outlives the host that spent it.** The agent re-parses every transcript on the box
  each beat, so the hub's copy used to be one snapshot on the registry record — removing/pruning/
  evicting a host threw it all away, and a wiped-disk host rejoining under the same name overwrote
  its own past.
- **The archive is NOT an answer to this** — it stores displayable entries only, no token counts,
  never sees a live session, and excludes background-agent transcripts entirely.
- `usage-ledger.js` is its own store on `/data` (`USAGE_LEDGER_FILE`), never `state.json` (documented
  as losable and
  trimmed under pressure — unacceptable for the only copy of a year of spend).

### The model: a per-day high-water mark

- What a host spent on a given UTC day is a FACT; the agent's report can only UNDER-state
  (transcripts are deleted, never invented). So the durable answer is the per-day, per-token-key
  **maximum ever reported**, and an absent day means "not reported", never zero.
- **Never "carry the old total forward when the new one drops."** A total falls for two reasons only
  the day buckets tell apart: the whole disk is gone (old total is pure addition), or SOME
  transcripts aged out — routine, since Claude Code deletes its own after `cleanupPeriodDays` (30).
  Carrying forward double-counts every surviving transcript, every month, forever.
  - Only inexactness: a wipe on the SAME day — today's bucket legitimately grows, so the pre-wipe
    part is held until the post-wipe day exceeds it (bounded to one day, the rarest case).
- **`pre` is spend older than any day bucket**; all-time = `pre + sum(days)`. Derived from a report as
  `totals - sum(its days)`, minus days this store still holds that the report stopped sending (else a
  day aging out of the agent's 60-day window lands in the total twice). A day trimmed from this
  store's own window is ADDED to `pre`, never dropped.
  - **A series carries a `cutoff`** (the newest date ever folded into `pre`) — a report re-stating a
    day at or before it is ignored, or the trim isn't idempotent and the all-time total climbs every
    beat.
- `today`/`week` are recomputed from the day buckets, never a stale snapshot.
- **Known limits, both deliberate**: the per-model breakdown and sub-agent split carry no day buckets
  (only the three windows travel), so they're high-water marks that recover as spend re-accumulates —
  apportioning invisible spend across models would be fabrication. A repo RENAMED on a live host
  charts as two series until the old name's days age out.
- **The fold happens in `serializeAgent`, not at ingest** — the stored record stays the agent's raw
  report, a purge takes effect on the next read, and what's served is a COPY raised by the live
  report (since `state.json` saves every 30s while this store's own snapshot timer is 5 minutes).

### What rides the wire

- **`retiredUsage`** is a top-level `/api/agents` array of hosts the registry no longer has (agent-
  shaped, carrying only `usage`/`repoUsage`/`jira.siteKey`, flagged `retired`). Both clients append it
  to the org-scoped agent list and chart it with existing code (`hostLabel`/`HostTotal.label` say
  "(removed)"). **No other page reads the key** — a retired host is never a live host anywhere else.
  - The web page **re-polls on the SSE `removed` event** (`retiredUsage` has no SSE event of its own,
    and the 30s poll is skipped while the stream is healthy). Appended AFTER `TurmaOrg.update(data)`
    so a retired host can't resurrect an org in the header menu.
- **Removing a host is not a purge** — `DELETE /api/agents/<host>` keeps history
  (`usagePurged:false`); `?usage=purge` is the deliberate, irreversible second step.

### Recovering a wiped host's history (`turma/tools/recover-usage-from-archive.js`)

- **A host wiped before the ledger ever saw it cannot be recovered from anything measured** — the
  archive isn't the exception people reach for: its rendered layer has no token counts, and its raw
  layer only ever held what was on disk when the sync ran.
- So the tool ESTIMATES from rendered text (tokens-per-character, calibrated on sessions holding both
  layers), biased LOW on purpose (`--drift`) since an over-estimated max-rule bucket can never be
  corrected downward. Accurate in bulk, noisy per-day.
- **Nothing in the ledger marks a bucket as estimated** — every run must be recorded here ONCE IT HAS
  ACTUALLY BEEN APPLIED (a run recorded before it happens is worse than no record). Runs applied to
  the live ledger:
  - **MaxAI, 2026-06-16 → 2026-08-15, 48 days, 5,379,447,205 estimated tokens** (`--drift 0.8`),
    applied 2026-08-25. Report: `/data/recover-maxai-2026-08-25.json`; pre-merge backup:
    `/data/usage-ledger.json.pre-recover.2026-08-25T10-57-38-917Z`. Days from 08-16 on are the hub's
    own measured record and were left untouched.
- **A figure above `TOKEN_MAX` counts as 0 there too** — one absurd calibration value poisons the
  rate and zeroes a whole bucket. Any future estimator writing into this store must coerce the same
  way.
- **The hub must be killed from OUTSIDE the container, immediately after the write, and the merge
  verified** — it rewrites the whole ledger from memory on its next save, so anything short of a
  fresh boot loses the merge. `kubectl delete pod` alone doesn't do it (30s grace period saves over
  the merge); `kill -9 1` inside the container doesn't either (PID 1 is signal-immune from its own
  namespace, so `RESTARTS` stays 0). `--force --grace-period=0` works. Pass `--json /data/…` so the
  report survives a
  restarted container's empty `/tmp`.
- **A run's figures are as-of that run** — its calibration set (the archive) grows, so re-running it
  later gives a slightly different answer, and a wiped host's old project slugs return as separate
  repo series (kept: host totals are independent of the per-repo view).
- Attribution is the `.meta` **`host`** field, never the archived file's NAME (a migrated session
  keeps its original archive name).

### The system-usage fold (`Turma-System-Usage`)

- **Agent-overhead repo series fold at SERVE time into one `Turma-System-Usage` block**
  (`repoBlocks`/`isSystemUsageRepo` in `usage-ledger.js`) instead of listing dozens of phantom repos
  on "By repo". The class is the manager's own `claude -p` helpers (naming/triage/probe, cwd under a
  temp `REGISTRY_DIR`) that a recover run banked here — `hub-agent-mgr-<rand>` names / their
  `-tmp-hub-agent-mgr-` slugs / any LEADING-DOT name (`.turma`, `.switchboard`; `scan_repos` skips
  dot-dirs so a live agent never reports one).
- **Hub-side analogue of `hub-agent.py`'s `_sanitize_junk_repo_entries`** — those fold the same class
  into `(root)` on the AGENT's ledger, which can NEVER reach this durable HUB store, so a phantom
  already banked here (recover tool, or an agent predating those sanitizers) needs a hub-side fold.
- **NON-DESTRUCTIVE**: the stored series are untouched, only the rendered output merges — so a purge
  or a corrected classifier still has the raw history. One pure `foldSystemRepos(list)` (idempotent,
  same-ref when nothing folds) is applied at BOTH serve points: `repoBlocks` (live-augmented hosts via
  `fold`, removed hosts via `retiredAgents`) AND `serializeAgent`'s RAW path in `server.js` — a live
  host whose OWN heartbeat still names an overhead repo has no ledger augment (`fold`→null), so its
  raw `repoUsage` would otherwise serve the junk unfolded (the legacy-agent case the comment cites).
- **DISTINCT repos are ADDITIVE** in the fold (`addUsageBlock`), unlike the per-day high-water raise a
  single series takes across its OWN reports. Client `repoSeries` then merges every host's system
  block into one cross-fleet line, so no client change is needed (parity-exempt: an ordinary block).
- **The structural signatures (`hub-agent-mgr-*`/slug, any leading-dot name) can never name a real
  repo** (`scan_repos` skips dot-dirs; a normalized git origin never starts with `.`);
  host-specific junk (a home-dir username, `git`, `tmp` the recover tool slugified from an orphan cwd)
  is OPERATOR-CONFIGURED via `USAGE_SYSTEM_REPOS` (CSV) after confirming from the archive it is not
  real work — "reattribute the real ones, fold the rest". Tests: the system-usage cases in
  `usage-ledger.test.js`, `usage-system-repos-env.test.js` (env read at require time, own process).

### Bounds

- **`models` is capped (`USAGE_LEDGER_MODELS`), every agent-supplied NAME is length-bounded, and each
  host is held to a SHARE of the store** (90% of an even split) — without this the store grows on
  agent-supplied strings ACROSS beats while the per-record ceiling only bounds ONE beat.
  - **`enforceHostShare` trims in the order least missed, until the host fits**: day granularity
    (trimmed days fold into `pre`) → per-model breakdown (kept in full as `totals`) → smallest repos.
    Days alone are not always enough (a host with many repos/models/long names has little day-byte
    headroom).
  - **The BYTE ceiling evicts the BIGGEST host; only the COUNT ceiling evicts the STALEST** —
    least-recently-seen is right for "too many hosts", wrong for "too many bytes" (it would destroy a
    small innocent host's history while the overflow-causing host stays).
  - **The save path must never throw** — `evictOverflow` runs inside a `setTimeout`, so an uncaught
    exception there EXITS the process (a crash loop under `restart: unless-stopped`).
  - **Per-beat scratch lives OFF the persisted objects** (a `WeakSet`), never a field name-filtered
    out of `serialize` — a name-keyed replacer matches at every depth, silently deleting any
    same-named repo/field too.
  - Runs only on a beat that ADDED a day/repo/model; a beat that merely raises existing numbers costs
    only the digit growth.
- **Every ceiling is a fraction of the container limit** (`USAGE_LEDGER_MAX`, a 32nd, clamped
  2-8 MiB) — held in memory and re-serialized whole on each save, so a flat number above `mem_limit`
  could never refuse anything before the OOM killer. Past it, the least-recently-seen host is evicted.
- `USAGE_LEDGER_DAYS` (120) bounds the day map; `USAGE_LEDGER_SERVE_MAX` (1 MiB) bounds what
  `retiredUsage` may add to one payload, newest-first. Both truncations (and `USAGE_LEDGER_REPOS`) are
  **logged**.
  - **Rendering STOPS at the first drop**, not once total bytes reach the ceiling — the total
    plateaus below it as soon as every remaining host individually overflows what's left, so
    "stop at the byte ceiling" renders everyone and saves nothing. The cost: a small old host can no
    longer squeeze in behind a large newer one — the better rule, since a truncation should always
    give up the OLDEST history.
- **The fold makes a host's SERVED block bigger than its stored one** (bounded by
  `USAGE_LEDGER_DAYS x USAGE_LEDGER_REPOS`) — applies only to hosts that have actually lost history;
  `safeAgentsCache` is still the backstop, but `agentRecordSize` measures the record, not the fold, so
  raising either ceiling widens the payload.
- The file is **measured before it is opened** and moved aside when oversized (an oversized
  `readFileSync` is an OOM at init on every boot).
- Nothing on the load path throws; every figure is re-derived through the same reducers ingest uses,
  so a hand-edited or older-build file can't put an unexpected shape into memory.
- **The ingest sits AFTER every gate that can still refuse a beat** — a record rolled back to `prev`
  must not have been banked as history first. A beat that ADDS history saves promptly; one that only
  re-states rides `USAGE_LEDGER_SNAPSHOT_MS` (rewriting at the beat rate protects nothing).
- Tests: `usage-ledger.test.js`, the `usage:` cases in `server.test.js`, the retired-host cases in
  `usage.test.js` and `UsageViewModelTest`.
