---
paths:
  - "turma/server.js"
  - "turma/public/sessions.html"
  - "turma/public/index.html"
  - "turma/public/chat.js"
  - "android/app/src/main/java/com/xerktech/turma/core/Sessions.kt"
  - "android/app/src/main/java/com/xerktech/turma/ui/CommonUi.kt"
  - "glasses/src/sessions.ts"
  - "agent/hub-agent.py"
  - "agent/tunnel-agent.js"
  - "turma/tests/server.test.js"
  - "turma/tests/sessions.test.js"
  - "turma/tests/dashboard-livestate.test.js"
  - "agent/tests/test_hub_agent.py"
  - "agent/tests/tunnel-agent.test.js"
---

# Is a session "working"? — the five-mirror read (XERK-245, XERK-1570)

Moved out of `CLAUDE.md` (size ceiling). This read spans the agent (`hub-agent.py` ⇄
`tunnel-agent.js`), the hub and every client, so it lives in a file scoped to all of them.

## Working is `paneBusy` OR live background WORK

- **Five mirrors must agree**: `sessionWorking` in `turma/server.js`, `liveState` in
  `turma/public/sessions.html` and `turma/public/index.html`, android `core/Sessions.kt`, and
  `glasses/src/sessions.ts`. Change the rule → change all five in the same PR.
- **A session that delegates work ENDS ITS OWN TURN**: the pane drops the interrupt hint, so
  `paneBusy` says False while an agent it launched keeps going — which read idle everywhere AND
  qualified as ready-for-review (XERK-245). The session's `agents[]` is the second input.
- `agents[]` sits BEHIND the offline and no-transcript gates like `paneBusy`, and an absent field
  means "that agent can't tell", never "no agents".
- **It comes from the TRANSCRIPT** (`_scan_agent_entry`/`scanAgentEntry`: the structured launch
  record, `<task-notification>`/`TaskStop` on stop), **never from the TUI's footer rows** — those
  are forgeable pane content and linger ~24s past completion. Mechanics: `agent.md`.

## The published live-agent set survives a restart (XERK-1587)

- The manager publishes its whole-conversation scan to `~/.turma/live-agents/<sessionId>.json`
  (`_publish_live_agents`): the live/stopped sets + call maps, bound to the transcript FILE NAME
  and the byte offset they are true at. Rewritten on change or every 1 MiB of offset drift.
- A restarted manager (`_restore_live_agents`) and a newly armed chat watch (`restoreLiveAgents`)
  seed from it and fold offset→EOF, so card and bar read ONE source and a launch far older than
  the 4 MiB back-scan stays live. Every stop written while down lies in that gap, so it applies.
- **Revalidate, never trust**: wrong conversation, offset past EOF or mid-line, gap > 16 MiB
  (`LIVE_SNAPSHOT_GAP_MAX`) or a malformed body → the bounded back-scan. Rows are retyped to the
  scan's own shape (`_snapshot_row`/`snapshotRow`) — the file is outside the process.
- **Offsets are LINE BOUNDARIES, both ways.** A snapshot is published only at one, and the restart
  beat resumes the incremental scan at the last COMPLETE line restore/back-scan read (not the EOF
  prime). A line claude was mid-writing at the restart is otherwise skipped; if it held a stop,
  the snapshot persists that launch as a phantom across every later restart.
- **Expiry is the relaunch**: background work dies with the runtime and its stop is never written,
  so `_launch_tmux` and teardown drop the snapshot AND the in-memory set
  (`_forget_live_agents`). Remove that and a killed shell is a phantom across restarts.
- Tests: `TestSessionReport` (`test_a_restart_sees_a_launch_older_than…` and siblings),
  `test_a_launch_drops_the_live_agent_snapshot`, `restoreLiveAgents` in `tunnel-agent.test.js`.

## Background shells carry a `kind`; only WORK counts (XERK-1570)

- A background shell row is `{type:"shell", label, kind, startedAt?, eta?}`. `kind` is classified
  off the call's COMMAND (`_shell_kind`/`shellKind`), never its description:
  - `wait-timed` — `sleep N`, `timeout N <wait>`, a loop whose only body is sleep/date; `eta` =
    start + N when N is a literal;
  - `wait-external` — `gh pr checks --watch`, `gh run watch`, `kubectl wait|rollout status`,
    `docker logs -f`, `tail -f`, `watch`, an `until …; do sleep …; done` poll;
  - `work` — anything else.
- **Anything unrecognised is `work`** — that is the pre-XERK-1570 reading, so a classifier miss
  costs nothing new; the reverse miss (work read as waiting) would hide a busy session. Every rule
  errs toward `work`; nested timeouts/loops classify as work rather than recurse on the beat.
- **The classifier runs on the BEAT, so it is bounded in TIME, not just guarded** (XERK-395): a
  command over 4096 chars or with a word over 256 is `work` before tokenizing, and no rule is a
  backtracking regex (the old `tail -f` regex took ~48s on one 128 KB `-fff…!` word). Py regexes use
  `re.ASCII` + `\Z` so `\d`/`$` mean what JS's do. `kubectl` waits only at the SUBCOMMAND position.
- `startedAt`/`eta` come from `_ts_ms`/`tsMs` (strict ISO, no offset = UTC) — never `Date.parse`,
  which reads an offset-less stamp as LOCAL time.
- `startedAt` is the Bash CALL's timestamp, else the launch record's (a shell moved to the
  background on its timeout launches minutes after it started). Agent/workflow rows carry no `kind`.
- **The py/js classifiers read ONE vector file** (`agent/tests/shell_kind_vectors.json`, asserted by
  `TestShellKind` and the `shellKind` case in `tunnel-agent.test.js`). Add a vector there, never to
  one side only.
- **Absent `kind` = work on READ, never on the WIRE.** `sanitizeLiveAgents` (both call sites: the
  heartbeat ingest and the `normalizeSessions` restore) keeps `kind` only as the strict enum
  `wait-timed|wait-external|work` and `startedAt`/`eta` only as positive safe integers, else OMITS
  the key — Android types all three (`LiveAgent`), so a coerced plausible default would be a lie and
  a wrong type is decode-fatal for the whole fleet.
- **A session whose live rows are ALL waits is waiting, not working** — a distinct live kind
  (`holding` in the clients; `sessionWait` → `{state:"waiting"|"stalled", eta}` in the hub):
  - waiting while any ETA is ahead — never Ready for review, never the review alert, never
    auto-merged (`autoMergeSweep` skips it like a working session);
  - **stalled** once the newest ETA passed by `WAIT_ETA_GRACE_MS` (2 min — a finished sleep's own
    stop notification needs a beat to land) with no transcript write since, OR the transcript has
    been silent `ATTENTION_WAIT_STALL_MIN` (hub env, default 45; clients hardcode the default). A
    stalled session is judged like any idle one, so a dead shell surfaces in Ready for review;
  - `paneBusy` true still means working; with `paneBusy` unknown an all-wait session is NOT working
    (the freshness fallback would otherwise say it is).
- Stalled is only COMPUTED here; the attention layer renders it as `needs-you:stalled` and owns
  the stalled alert, which REPLACES the review alert for it (`turma-attention.md`, XERK-1571).
- **The chat bar labels a wait**: `agentsHtml` reads a wait row's type as `waiting`, and an all-wait
  bar's verb is `Waiting…` (`backgroundBarVerb`, Android `ChatScreen.kt` mirrors it).
- Tests: `TestShellKind`, `TestLiveAgentsScan` ↔ `scanAgentEntry` in `tunnel-agent.test.js`; the
  `XERK-1570:` cases in `server.test.js`; `background shell kinds` in `sessions.test.js`;
  `dashboard-livestate.test.js`; `chat.test.js`; glasses `sessions.test.ts`; android `SessionsTest`,
  `AgentDecodeTest`.
