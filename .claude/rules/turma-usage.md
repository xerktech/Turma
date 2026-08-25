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

- Charts persistent daily/all-time cost from the agents' `repoUsage`/`usage` aggregates — not the
  live session list, so killed/deleted/pruned work still counts. **By repo** unifies a repo's usage
  across every host it runs on (matched by `remoteKey`); **By host** shows per-host totals.
- The usage page renders `(root)` as **Root**, folding older agents' `(other)`/`?` in
  (`normRepo`/`repoLabel`).
- **"Delegated to sub-agents"** (`subagentCard`, XERK-302) names the share of those figures spent by
  background agents. It is a slice of every other number on the page and says so — a reader who adds
  it back double-counts.
  - **The share's denominator is `subagentOf`, not the fleet total**: only the spend that came with a
    split contributes to it, so one older host can't dilute the answer. A host reporting none is left
    out entirely, and with no series reporting one the card shows no percentage at all.
  - **`subagentOf` accumulates per CONTRIBUTION, not per series**, and the coverage caveat is
    measured in SPEND for the same reason: a series merges every host that ran that repo, so a
    series-level check reads full coverage on a series three quarters of whose tokens came from a
    host that can't answer.
  - Android's `SubagentLine` is the one-line rendering of the same three windows.
- Above the chart it shows the **Claude subscription's 5h/7d windows** (XERK-247) from each agent's
  `limits` block — the numbers exist only inside Claude Code (see `.claude/rules/agent-usage.md` for
  how they're captured).
  - **Every token figure on every usage block is coerced at ingest too** (`normalizeUsageTokens`,
    XERK-306) — the host/repo/session windows, the `days` map and each model's windows, which are
    Kotlin `Long`s on Android. Unlike `subagent` the bad FIGURE is zeroed rather than the block
    dropped: absent totals is not a meaningful "can't tell you" when every client renders them
    unconditionally. That understates the host instead of excluding it, so it is logged (throttled).
    A window, `days` or `usage` that is not an object at all IS dropped, and a missing figure is
    never filled in — this walk sits between the raw and coerced `AGENT_RECORD_MAX` measurements, so
    `{}` → four invented zeros on an agent-sized `days` map is an expansion it must not make.
  - **An explicit `null` `usage` is dropped but NOT logged**, because it is the agent's deliberate
    "nothing to report": a host reports `usage: null` until it has spent something, and a session's
    is null until its transcript carries a usage block. Tallying it made every new host warn on
    every beat that it under-reports — false, and worse, those beats spent the fleet-wide throttle
    window and silently swallowed the warnings from hosts genuinely sending the wrong shape. Any
    other non-object still tallies and still names the host. Never restore the tally for `null`.
  - **The drop itself is load-bearing and must stay a `delete`**: `RepoUsage.usage` is NON-nullable
    on Android (`Models.kt`), so serving an explicit `null` there is decode-fatal for the whole
    `/api/agents` array, not just that row. Tests: `a null usage is dropped in silence` asserts the
    key is absent, not merely unlogged.
  - **`normalizeLimits` coerces the block at ingest**, like the per-model usage lists beside it and
    for the same reason: it fans out to web, Android and glasses, and Android decodes it into TYPED
    fields, so a `usedPct` of `"lots"` from one buggy host would fail the decode of the WHOLE fleet
    payload rather than just its own card.
  - **A card is dropped past `LIMIT_MAX_AGE_SEC`, not just coloured** — the agent applies the same
    rule before reporting, but the hub keeps an OFFLINE host's last heartbeat for days, so without
    the client-side mirror a dead host shows a frozen 5-hour window that has since reset many times.
  - Every card is a **SNAPSHOT, and says so**: it carries "captured <age> ago" (amber past
    `LIMIT_STALE_SEC`), because a host only refreshes while it's working. Wording is "captured", not
    "updated" — the header's fleet-wide last-refreshed stamp was removed, and `nav.test.js` guards
    the page against re-growing one.
  - **A window whose `resetsAt` has passed renders as `—`, not as its last percentage**
    (`limitWindowView`'s `expired`): that window has since rolled over, so the stored figure
    describes one that no longer exists. The bar colours by headroom (75% warn, 90% crit).
  - A host reporting no window at all gets **no card** — an older agent, a non-subscription login and
    an unprobed host all mean "can't tell you", never 0% used. The section renders before the
    chart's empty-state returns, so headroom shows on a fleet that has charted nothing.
  - **One card per SUBSCRIPTION, not per host** (XERK-301, `limitGroups`): hosts sharing a Claude
    account are reading one pool, so several cards were one number drawn several times. Grouping is
    on the agent's opaque `subscription.key` (`.claude/rules/agent-usage.md`), and a host reporting
    none keeps a card of its own — **never folded in with another silent host**, since "can't tell
    you" from two hosts does not make them one plan. The card is headed by its hosts; the key is a
    hash, so there is no other name to give a subscription.
    - Each window takes its **FRESHEST** reading, not an average or a maximum: every host reads the
      same counter, and across a window's reset the newest read is the only right answer where a
      maximum would keep the pre-reset figure alive. Per window, since the freshest snapshot need
      not carry both — so a window sourced from an older host **discloses its own read age**, the
      head's stamp being the group's freshest rather than that row's.
    - **Both clients sort freshest-first before folding and replace only on a STRICTLY newer read.**
      Fold in fleet order, or accept an equal `capturedAt`, and two hosts whose snapshots tie to the
      second resolve to a different host on each client — one subscription showing two different
      percentages. Tests: the tie cases in `usage.test.js` and `UsageViewModelTest`.
    - `normalizeSubscription` coerces the block at ingest for the same reason `normalizeLimits`
      does, and because the key is a MAP KEY on every client: anything unusable becomes null, never
      a plausible default that would fold two subscriptions into one set of bars. Its bounds are
      **literals, not module `const`s** — see the restore-TDZ rule below.
  - **`normalizeSpawnRefusals` coerces the served refusal map** (XERK-325) because Android TYPES it,
    and it is the first typed-and-served record field that is deliberately NOT stripped from the
    payload. The heartbeat path cannot produce a bad one (`ingestSpawnFailures` is the only writer);
    the `state.json` restore can, and it is served before any host re-beats. It keeps the ingest
    path's PLAIN object shape — a null-prototype one would make a restored record differ from a
    beaten one — so the explicit `__proto__`/`constructor`/`prototype` key filter is what stops
    `out[id]`'s [[Set]] hitting the prototype setter, not the object's prototype.
  - **Anything a `normalize*` closes over must be reachable from `loadState`'s line.** That loop
    sits near the top of `server.js` and reaches each one only because function declarations hoist;
    a module `const` declared below is in its TDZ there, the `ReferenceError` lands in the restore's
    catch, and the WHOLE registry is emptied — then the 30s save timer rewrites `state.json` from
    only the hosts that have re-beaten, losing every host offline at that moment. XERK-301 shipped
    exactly that and it is invisible to `server.test.js`, which walks the loader's body rather than
    booting; `registry-restore.test.js` boots a hub instead — over **two** records, one usable and
    one unusable in every coerced field, since a `const` on an error BRANCH is invisible to a
    fixture that only ever takes the happy one (and would then fire only on malformed records, in
    production).
  - Tests: `usage.test.js`, the `limits` and subscription-key heartbeat cases in `server.test.js`,
    android `UsageViewModelTest`.

## The durable usage ledger (XERK-338)

- **Token usage outlives the host that spent it.** It is an agent-derived aggregate — the agent
  re-parses every transcript on the box each beat — so the hub's copy used to be one snapshot on the
  registry record: removing, pruning or evicting a host threw all of it away, and a host whose DISK
  was wiped rejoined under the same name reporting near-zero and overwrote its own past in place.
- **The archive is not an answer to this and must not be proposed as one.** It stores each ended
  session's DISPLAYABLE entries (`{uuid, role, ts, text}`) and no token counts at all, it never sees
  a live session, and background-agent transcripts are outside it entirely.
- `usage-ledger.js` is its own store on `/data` (`USAGE_LEDGER_FILE`), never `state.json`: that file
  is documented as losable and is TRIMMED to a budget under pressure, neither of which is acceptable
  for the only copy of a year of spend.

### The model: a per-DAY high-water mark

- What a host spent on a given UTC day is a FACT, and the agent's report of it can only
  under-state — transcripts are deleted, never invented. So the durable answer is the per-day,
  per-token-key **maximum ever reported**, and **an absent day means "not reported", never zero**.
- **It is deliberately not "carry the old total forward when the new one drops", and must not be
  changed into one.** A reported total falls for two reasons that only the day buckets tell apart:
  the whole disk is gone (the old total is entirely additional), or *some* transcripts are gone and
  the rest are not — which is ROUTINE, because Claude Code deletes its own transcripts on
  `cleanupPeriodDays` (30 by default). A carry counts every surviving transcript twice, every month,
  forever. Under the max rule both cases are exact with nothing having to tell them apart.
- The only inexactness is a wipe **on the same day**: today's bucket is the one that legitimately
  grows, so the pre-wipe part of today is held until the post-wipe day exceeds it. Bounded at one
  day, on the rarest event.
- **`pre` is spend older than any day bucket**, and all-time is `pre + sum(days)`. It is taken from
  a report as `totals - sum(its days)`, **minus the days this store still holds that the report has
  stopped sending** — those are inside that figure, so without the subtraction every day aging out
  of the agent's 60-day window lands in the total twice. A day trimmed out of this store's own
  window is ADDED to `pre`, never dropped, or a lifetime total would shrink as it aged.
  - **A series therefore carries a `cutoff`** — the newest date it has ever folded into `pre` — and
    a report re-stating a day at or before it is ignored. Without that the trim is not idempotent:
    the day goes back into `days`, the next trim adds it to `pre` AGAIN, and the all-time total
    climbs on every beat with nothing on screen to say so. It cannot fire while the window is twice
    the agent's, which is exactly why it is closed in code rather than left to the sizing.
    Tests: "re-reporting a day this store has already trimmed does not compound".
- `today`/`week` are recomputed from the day buckets, so no window is ever a stale snapshot of one.
- **Known limits, both deliberate.** The per-model breakdown and the sub-agent split carry no day
  buckets (only the three windows travel), so they can only be high-water marks on their totals and
  recover as spend re-accumulates after a wipe; apportioning invisible spend across models would be
  fabrication. And a repo RENAMED on a live host charts as two series until the old name's days age
  out — the host-level figures are unaffected, being kept independently rather than summed from the
  repo blocks.
- The fold happens in **`serializeAgent`, not at ingest**, so what is stored, size-budgeted and
  saved stays the agent's raw report and a purge takes effect on the next read. It returns null
  unless the store holds something the report does not — which is every host that has never lost a
  transcript, so the common path is one map lookup and the record is served byte-for-byte.
  - What it renders is a COPY of the stored series **raised by the live report**, not the stored
    series alone: `state.json` saves every 30s where this store's ordinary beats ride a 5-minute
    snapshot timer, so after a restart the registry can hold a newer report than the file did, and
    /api/agents is served before any host re-beats.

### What rides the wire

- **`retiredUsage`** is a top-level `/api/agents` array of hosts the registry no longer has, shaped
  as agent records carrying only `usage`/`repoUsage`/`jira.siteKey` and flagged `retired`. Both
  clients append it to the org-scoped agent list and chart it with the code they already have
  (`hostLabel` / `HostTotal.label` say "(removed)", so a name that exists nowhere else in the app
  cannot read as a live host that spent nothing today). **No other page reads the key**, so a
  retired host is never a host anywhere else. Absent from an older hub = "nothing removed".
  - The web page **re-polls on the SSE `removed` event** rather than only patching its cache:
    `retiredUsage` has no SSE event of its own and the 30s poll is skipped while the stream is
    healthy, so the host's spend would fall off the chart until the stream broke. Android polls
    every 6s, so it needs nothing.
  - It is appended AFTER `TurmaOrg.update(data)` so a retired host cannot resurrect an org in the
    header's menu — it can only be filtered by one something live still reports.
- **Removing a host is not a purge.** `DELETE /api/agents/<host>` keeps the history and answers
  `usagePurged:false`; `?usage=purge` is the deliberate second step, with no way back, and is never
  implied by removing the card.

### Recovering a wiped host's history (`turma/tools/recover-usage-from-archive.js`)

- **A host wiped before the ledger ever saw it cannot be recovered from anything measured**, and the
  archive is not the exception people reach for: its rendered layer carries no token counts, and its
  raw layer only ever held what was still on the host's disk when the sync ran — after a wipe, nothing
  older than it. Re-deriving every raw copy MaxAI has reproduced the ledger's own days exactly for
  2026-08-16 → 08-21 (all four figures; 08-22 → 08-25 come back lower, having live sessions the
  archive has not taken yet) and produced NO earlier day at all — the first half says the parser is
  faithful, the second that the raw layer cannot cross a wipe.
- So the tool ESTIMATES, from the rendered text: tokens-per-rendered-character calibrated on sessions
  holding both layers, applied to the rendered-only sessions before the wipe. Accurate in bulk (±20%
  over ~250 sessions), useless per day (±2–6x), and biased LOW on purpose (`--drift`), since a max-rule
  bucket that is too high can never be corrected downwards.
- **Nothing in the ledger marks a bucket as estimated**, so every run must be recorded here **once it
  has actually been applied**, or a later reader reads fabrication as fact — and a run recorded before
  it happens is worse than no record, since it labels measured days as estimates. Runs applied to the
  live ledger, in full:
  - **MaxAI, 2026-06-16 → 2026-08-15, 48 days, 5,379,447,205 estimated tokens** (`--drift 0.8`),
    applied 2026-08-25. OS wipe ~08-15; the ledger was created 08-18, after it, so it held that host
    from 08-16 only. Days from 08-16 are the hub's own measured record and were left alone (verified:
    the 08-16 bucket is byte-identical either side of the merge). The run's own report is
    `/data/recover-maxai-2026-08-25.json` and the pre-merge file
    `/data/usage-ledger.json.pre-recover.2026-08-25T10-57-38-917Z`. Served result: 58 day buckets,
    73 repo rows, 7.465B all-time against the 2.086B that host reports.
- **A figure above `TOKEN_MAX` counts as 0 there too.** `num()` refuses a non-safe integer, so one
  absurd value in a calibration transcript poisons the rate and lands a day bucket that loads back
  ZEROED — destroying the measured figures in it. An estimator that writes into this store has to
  coerce like `_token_count`, not merely like a number.
- **The hub is killed from OUTSIDE the container, immediately after the write, and the result is then
  VERIFIED.** It rewrites the whole ledger from memory on its next save, so anything short of a fresh
  boot loses the merge — and two plausible recipes already did, each silently:
  - `kubectl delete pod` alone: SIGTERM is unhandled, the old process beats through its 30s grace
    period and saves over the merge (04:14:00 → gone 04:15).
  - `kill -9 1` inside the container: PID 1 is immune to signals it has no handler for when they come
    from its OWN namespace, SIGKILL included, so nothing happens at all — `RESTARTS` stays 0 and the
    snapshot timer takes the merge ~4 minutes later.
  `--force --grace-period=0` makes the kubelet SIGKILL it, which works. Pass `--json /data/…` so the
  run's report survives a restarted container's empty `/tmp`.
- **A run's figures are as-of that run.** Its calibration set is the archive, which grows, so the same
  command a day later lands ~1% different — and a wiped host's old project slugs return as repo series
  (for MaxAI, 67 against the 6 it reports live, ~19% of the estimate in bare-name and `hub-agent-mgr-*`
  keys). They are kept: host totals are held independently, so dropping them would leave the page's
  per-repo view under-counting its per-host view.
- Attribution is the `.meta` **`host`** field, never the host segment of an archived file's NAME — a
  migrated session keeps the name it was first archived under, so reading the name credits its spend
  to the wrong host. Repo keys fold a bare name onto a URL key when exactly one URL key claims that
  display name (`reposOf` keys on `remoteKey || repo`, so a repo archived before its origin was
  readable would otherwise chart as a second series).

### Bounds

- **`models` is capped (`USAGE_LEDGER_MODELS`), every agent-supplied NAME is length-bounded, and each
  host is held to a SHARE of the store** (90% of an even split — an exact split leaves nothing for the
  JSON envelope). Without all of it the store grew on agent strings across BEATS while the per-record
  ceiling bounded only ONE beat: 56,000 distinct model names over 40 legal beats took the file past
  `LEDGER_MAX`, and one host destroyed the whole fleet's history.
  - **`enforceHostShare` gives up detail in the order it is least missed, and does not stop until the
    host fits**: day granularity (trimmed days fold into `pre`, so the all-time total is untouched),
    then the per-model breakdown (kept in full as `totals` anyway), then the smallest repos. Days
    ALONE were not enough — a host with 100 repos, 64 models and long names has almost no day bytes
    to give and sat at 6.8x its share forever, with the warning cheerfully reporting `before ==
    after`.
  - **The BYTE ceiling evicts the BIGGEST host; only the COUNT ceiling evicts the stalest.** Least
    -recently-seen is right for "too many hosts" and wrong for "too many bytes": it destroyed a small
    innocent host's durable history while the host that caused the overflow stayed.
  - The **save path must never throw**: `evictOverflow` runs inside `writeNow`, which runs in a
    `setTimeout`, so an exception there is uncaught on the main loop and the hub process EXITS —
    a crash loop under `restart: unless-stopped`, taking the fleet's whole control plane. A dead
    variable reference on the last-host-still-over branch did exactly that. A rarely-reached branch
    that THROWS when reached is worse than no branch; that one is now covered by a test that
    actually reaches it (`USAGE_LEDGER_MAX` below what one host can serialize to).
  - **Per-beat scratch lives OFF the persisted objects** (a `WeakSet`), never as a field filtered out
    of `serialize` by name: a `JSON.stringify` replacer keyed on a bare name matches at EVERY depth,
    so it also deleted a repo whose `remoteKey` was that name — present in memory, absent from
    `/data`, gone after a restart, with no log line.
  - It runs only on a beat that ADDED a day, repo or model. It stringifies the whole entry (4.6 ms at
    100 repos), and a beat that merely raises existing numbers grows the entry by digits.
- Every ceiling is a **fraction of the container limit** (`USAGE_LEDGER_MAX`, a 32nd, clamped
  2–8 MiB), like every other hub bound: the ledger is held in memory and re-serialized whole on each
  save, so a flat number above `mem_limit` could never refuse anything before the OOM killer fires.
  Past it the least-recently-seen host is evicted, which is the only thing here that can be given up.
- `USAGE_LEDGER_DAYS` (120) bounds the day map — a day bucket is ~75 bytes PER REPO, in memory and in
  every `/api/agents` body — and `USAGE_LEDGER_SERVE_MAX` (1 MiB) bounds what `retiredUsage` may add
  to one payload, newest-first. Both truncations and the `USAGE_LEDGER_REPOS` one are **logged**: a
  Usage page quietly missing history reads as a fleet that spent less, with nothing to say otherwise.
  - **Rendering STOPS at the first drop**, because `retiredAgents` runs inside `buildAgentsCache` and
    is therefore a hub-wide stall like every other synchronous step there: 32 retired hosts at the
    day/repo ceilings measured 45.5 ms to render, of which 4 fit, against 13.6 ms once the loop stops.
    Deliberately NOT "stop once `bytes` reaches the ceiling" — the total plateaus below it as soon as
    every remaining host individually overflows what is left, so that version renders all 32 and saves
    nothing (measured: no change). The cost is that a small old host can no longer squeeze in behind a
    large newer one, which is the better rule anyway: what a truncation gives up is always the oldest
    history rather than whatever happened to fit.
- **The fold makes a host's SERVED block bigger than its stored one**, since the stored record stays
  the raw report: measured at 1.8x on a deliberately heavy host (40 repos x 60 days), 218 KB against
  its 123 KB record, and 1.8 ms to build. It is bounded by `USAGE_LEDGER_DAYS` x
  `USAGE_LEDGER_REPOS`, it applies only to hosts that have actually lost history, and
  `safeAgentsCache` is still the backstop if a fleet payload ever cannot be serialized — but
  `agentRecordSize` measures the record, not the fold, so raising either ceiling widens the payload.
- The file is **measured before it is opened** and moved aside when oversized, for the reason the
  `state.json` restore spells out — `readFileSync` materializes the whole thing, so an oversized file
  is an OOM at init on every boot, which `restart: unless-stopped` turns into a crash loop.
- Nothing on the load path throws, and every figure is re-derived through the same reducers the
  ingest uses, so a hand-edited or older-build file cannot put a shape into memory that the merge
  does not expect. A restored entry is assumed to hold more than the next report will, since the
  report it was measured against is gone.
- The ingest sits **after every gate that can still refuse a beat** — a record rolled back to `prev`
  must not have been banked as history first. A beat that ADDS to the history saves promptly; one
  that only re-states what is recorded rides `USAGE_LEDGER_SNAPSHOT_MS`, because rewriting the file
  at the beat rate is ~10,000 rewrites a day to protect nothing.
- Tests: `usage-ledger.test.js`, the `usage:` cases in `server.test.js`, the retired-host cases in
  `usage.test.js` and `UsageViewModelTest`.
