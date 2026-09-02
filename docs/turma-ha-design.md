# Making the Turma hub highly available in k8s — design (XERK-552)

> **A design, not an implementation.** The ticket asks to make the hub survive a rolling update
> without an outage by running 2–3 replicas, expects "large code changes", and poses one design
> question outright: *"Do we need to split API and UI? I'd prefer not, but if we do, we do."* This
> document answers that question, states what actually blocks multiple replicas, lays out the three
> topologies that reach the goal at very different cost, and recommends one. It is written to be
> decided on before any hub code is written, the way `docs/k8s-agent-design.md` (XERK-369) was.

## The goal, stated precisely

The ticket's own words: *"make turma highly available so that a rolling update doesn't cause an
outage."* The driving pain is **image bumps** — a release rewrites the hub image tag in
`xerktech/ArgoCD` `ai/turma/deployment.yaml`, Argo CD syncs, and the pod is replaced. Today that is a
visible gap. Everything below is measured against *that* goal (availability across a deploy), and
where a choice also buys horizontal scale that is called out as a bonus, not the requirement.

**What an "outage" actually costs here, and what it does not.** The fleet's agents run natively on
each host; sessions are tmux + `claude` processes owned by those agents, not by the hub. A hub outage
therefore costs **dashboard visibility and queued commands**, not work — `ai/turma/ingress.yaml` and
`docs/k8s-agent-design.md` both record this, and agents retry their heartbeats and tunnels. So the
target is: **no window where the dashboard is down, terminals are dead, or a queued kill/restart is
silently dropped during a deploy.** It is not "zero dropped packets"; it is "a deploy is invisible to
an operator and to the fleet."

## Why one replica is the current design, in the manifest's own words

`ai/turma/deployment.yaml` is `replicas: 1` + `strategy: Recreate`, and it already documents the two
independent blockers this ticket has to remove:

> `turma-data` is ReadWriteOnce, so a second pod would sit Pending on the volume; and the hub is
> stateful in the way that matters anyway, since the agent tunnels, the browser SSE streams and the
> open terminal channels are all process state that two pods would split between them.

Both blockers must fall for **any** multi-pod topology:

1. **Storage is RWO.** `turma-data` (Longhorn, 20 Gi, `ReadWriteOnce`) holds every durable byte:
   `state.json`, ~10 hand-set policy/pin JSON files, `usage-ledger.json`, `devices.json`, and the
   190 MB+ `archive/` tree with its `node:sqlite` `index.db`. A second pod cannot even mount it, so a
   surged pod sits `Pending` — which is *also* why the strategy is `Recreate`, not `RollingUpdate`:
   the new pod cannot start until the old one releases the volume, so there is always a gap.

2. **The live control plane is in process memory.** The fleet registry, per-host command queues, the
   ticket queue, the migration state machine, SSE fan-out, and the long-lived agent **control-channel
   WebSockets** are all in-RAM on one process. `/data/state.json` is a *best-effort 30 s snapshot* of
   that memory, read once at boot and never re-read — not a shared source of truth.

## The state inventory (what has to move, and how it must be owned)

Grouped by what it forces on a multi-replica design. File:line references are into `turma/server.js`
unless noted.

### A. Durable stores that are single-writer full-file rewrites → **need a shared store**

| Store | Where | Write discipline | What breaks with 2 writers |
|---|---|---|---|
| `agents` registry | `state.json` (`:164`), load `:1265-1365`, save `scheduleSave` `:1391-1425` | 30 s debounce, whole-map serialize, `tmp-$pid`+`rename` | **Last-writer-wins clobber.** Replica B's save erases every host that only beats to A. Rename stops a *torn* file, not the logical overwrite. |
| Policy/pin JSON: `devices.json`, `ticket-agents.json`, `ticket-models.json`, `ticket-runtimes.json`, `autostart-orgs.json`, `triage-policies.json`, `triage-actions.json`, `priority-writeback-orgs.json`, `dedupe-link-orgs.json`, `org-colors.json`, `repo-tiers.json` | `:164-247` | Plain `fs.writeFile`, **no tmp+rename** (`:1513,1565,1618,1711,…`) | Concurrent clobber **and** torn files. Operator-set state, silently lost. |
| Usage ledger | `usage-ledger.js` `USAGE_LEDGER_FILE`, save `:775-798` | Debounce + 5-min snapshot, plain `fs.writeFile` | "The only copy of a year of spend." Each replica rewrites from its **partial** in-memory copy; the per-day high-water model means a low writer clobbers a high one → **history destroyed**. |
| Archive index | `archive.js` `index.db`, single `DatabaseSync` handle `:315` | append-only `.jsonl`+`.meta` (tmp+rename `:377`); `rebuildIndex`+`VACUUM` in `maybeReclaimIndex` | Two processes on one SQLite file → `SQLITE_BUSY`/corruption. **SQLite over Longhorn-RWX (NFS) is itself unsafe.** Needs exactly one writer. |
| Migration spool | `/data/migrations` `:2228`, boot sweep `:2281-2300` | boot `unlink`s every `MIGRATE_SPOOL_RE` file | A second replica booting **deletes the first replica's in-flight bundles**; the spool file and its owning `migrations` record live on different replicas. |

### B. In-memory coordination state → **need a shared store and/or a single leader**

| State | Where | Verdict |
|---|---|---|
| `agents` fleet registry (served by `/api/agents` straight from RAM, `buildAgentsCache` `:2484-2534`) | ingest `:10213` | Each replica holds only hosts that beat to it → **partial, flickering fleet view**. Central blocker. |
| Per-host command queue `a.commands` | `queueCommand` `:2593`, drained on heartbeat reply `:10442` | A command queued on A is delivered only if that host's next beat also lands on A. |
| `controlChannels` / `pendingChannels` | `:1254-1255`, upgrade `:12593-12734` | Agent tunnel pinned to one replica; data-channel dial-back pairs only on the issuing replica. |
| `liveClients` (live-tail), `termAgents` | `:1261`, `:9637` | Must co-locate with that host's control channel. |
| `migrations` state machine | `:2093`, advance `:8998` + heartbeat fast-path `:10429` | Source host, target host, and spool file may sit on three replicas. |
| `ticketQueue` | in-memory (turma-ticket-queue.md) | Each replica gets its own queue and its own drain loop. |
| Single-flight guards: `committedTicketSpawn`, `createInFlight`, `autoStarted`/`autoStopped`, `rememberDispatch`, `resultWaits` | in-memory | Exist **precisely** to prevent double-spawn/double-kill; per-replica they don't coordinate → duplicates. |

### C. Fan-out and background workers

- **SSE fan-out is per-process.** Dashboard live updates ride `/api/events` (`sseClients` `:2338`);
  `sseBroadcast`/`publishAgent` (`:2573-2588`) iterate only the current process's clients. **A client
  on replica A never sees a mutation that happened on replica B.** Needs a pub/sub bus.
- **Every replica runs every sweep** at module load: offline-alert sweep (15 s, `:7456-7479`) →
  duplicate FCM alerts + false-offline against a partial registry; the ticket bundle
  (`AUTO_START_EVERY_MS`, `:8974-8992`: `autoStartSweep`, `autoStopSweep`, `priorityWriteBackSweep`,
  `dedupeLinkSweep`, `drainTicketQueue`, `reclaimStrandedTicketSpawns`) → **double-spawned sessions,
  double kills, duplicate writes back to Jira/ADO**; migration advance (10 s, `:8998`). All need a
  **single leader**.

## The answer to the ticket's question: no, you do not have to split API and UI

Splitting the dashboard (static UI + read API) from the agent/command plane is a real option, but it
does **not** remove either blocker. The UI is already static files served by the same process; the
hard state is the *fleet registry, the command queues and the tunnels*, all of which the "API" half
would still own. What actually unblocks replicas is **externalizing durable state + a pub/sub bus +
leader election + cross-replica channel routing** — independent of whether UI and API are one
Deployment or two. Keep them together (the owner's stated preference); the work is the same either
way. A split only becomes attractive later if the read-only dashboard needs to scale out far beyond
the command plane, which is not this ticket.

## Three topologies that reach the goal

All three require the same unavoidable core, because both blockers are unconditional:

- **Move A + B off the RWO volume into a shared store** (registry, queues, ticket queue, migration
  state, policy/pins, usage ledger). Candidates below.
- **Graceful shutdown + reconnect discipline** in the hub (there is none today — no `SIGTERM`
  handler; `grep` finds only `server.listen`). This alone shrinks the deploy gap and is a
  prerequisite for every option.
- **Give the archive a single owning writer** regardless of topology (SQLite is single-writer and
  NFS-hostile).

They differ in how much *live-plane* machinery they add on top.

### Option 1 — Graceful single replica (the cheap floor)

Keep `replicas: 1`, but add a real `SIGTERM` drain (stop accepting new work, flush saves, close SSE
with a retry hint, let agents reconnect) and a fast, warm boot. Still `Recreate`, still a gap — but a
*bounded, quiet* one dominated by new-pod boot + agent reconnect, not by lost state.

- **Buys:** most of the felt improvement for the least code and **zero new infra**. If the real
  complaint is "a deploy blips the dashboard for 20 s", this may be all that is wanted.
- **Does not buy:** true HA. A node loss or an OOM is still a full (if short) outage, and the gap is
  non-zero. The owner explicitly asked for 2–3 replicas, so this is offered as the honest floor, not
  the recommendation.

### Option 2 — Active-passive, leader-failover (**recommended for the stated goal**)

Run 2 (or 3) replicas; **exactly one is the leader and serves all traffic**, the rest are warm
standbys holding no client connections. The Service routes only to the leader (leader-owned
EndpointSlice, or a leader-gated readiness probe so only the leader is `Ready`). State lives in a
shared store both replicas read; on the leader draining (a deploy) or dying, a standby wins the lease
in ~1–2 s, marks itself `Ready`, and agents + browsers reconnect to it.

- **Why it fits:** the goal is *availability across a deploy*, not load sharing. Because only one pod
  is ever live, the three hardest cross-replica problems **disappear**: no SSE fan-out across replicas
  (only the leader has SSE clients), no cross-replica command/terminal relay (only the leader holds
  tunnels), no partial-fleet view (only the leader ingests). What remains is the unavoidable core
  (shared state + graceful drain + single archive writer) **plus** a leader lease and Service gating —
  a fraction of Option 3's surface.
- **Cost/risk:** medium. The lease + failover path and the state externalization are the real work;
  the 13k-line request-handling code is largely untouched because it still runs as "the one live
  process", just reading/writing a shared store instead of local files.
- **Storage:** the archive can stay on a small RWO volume owned by whoever is leader **only if
  failover tolerates the volume detach/attach latency** — which defeats fast failover. Cleaner: the
  archive blobs move to object storage or an externalized DB too, so a standby is promotable with no
  volume move. This is the main design tail of Option 2 and is called out in Open Questions.

### Option 3 — Active-active, N replicas all serving (full HA + horizontal scale)

Every replica serves; the load balancer spreads clients arbitrarily. On top of the core this needs:

- **Pub/sub fan-out** so every mutation reaches every replica's SSE clients (Redis/NATS).
- **Cross-replica routing for the tunnel plane** — the hard part. An agent's control channel pins to
  one replica; a browser terminal (`/term/<id>`) or `/live` socket, and a queued command, may land on
  another. Either **route by target host name** so a host's control channel + terminal + live-tail +
  command queue always co-locate (needs an app-aware router; a stock L4/L7 LB cannot key on
  app-level host identity), or **relay the byte streams between replicas** over the bus (proxying a
  live ttyd WebSocket pod-to-pod — real engineering, real latency).
- **Leader election still required** for the singleton sweeps and migration advance, since those must
  not run N times even when N replicas serve.

- **Buys:** true N-way availability *and* horizontal scale — the dashboard/API load spreads across
  pods.
- **Cost/risk:** high. This is the "large code changes" scenario in full, touching the tunnel and SSE
  cores that carry the `hub-agent.py` ↔ `tunnel-agent.js` parity contract and the terminal proxy. It
  is the right target only if the hub needs to scale beyond one pod's throughput, which nothing in the
  ticket says it does.

## Recommendation

**Option 2 (active-passive, leader-failover), with the graceful-drain work from Option 1 as its first
increment.** It meets the ticket's actual goal — a deploy causes no outage — with far less risk than
Option 3, keeps API and UI together as the owner prefers, and leaves Option 3 reachable later (the
shared store and leader lease are exactly its foundation) if horizontal scale is ever wanted. Sequence:

1. **Graceful shutdown + reconnect** (ships value on day one, single replica). Add a `SIGTERM` drain;
   confirm agents reconnect cleanly; confirm SSE clients auto-retry.
2. **Externalize durable state** (A + B) into the chosen shared store; the archive gets a single
   writer / object-store blobs.
3. **Leader lease + Service gating**; run the sweeps/migration-advance only under the lease.
4. **Go to 2–3 replicas**, `RollingUpdate` (surge the standby, drain the leader, lease flips).

## The one infra decision this forces

A shared store is a **new stateful dependency in the cluster** — an operator decision, not just a code
one. The realistic choices:

- **Redis** (or Valkey) — natural fit for the pub/sub *and* the hot registry/queues; add a
  Bitnami/operator instance in `xerktech/ArgoCD`. Durable-enough with AOF; pair with object storage
  or Postgres for the archive/ledger of-record.
- **Postgres** (CloudNativePG is already a common pattern in these clusters) — one durable home for
  registry + ledger + policies + archive index, with `LISTEN/NOTIFY` covering SSE fan-out for a
  small fleet. Heavier to operate; strongest durability.
- **Longhorn RWX for the volume alone** — tempting because it looks like "no code change", but it is
  NFS underneath (`docs/k8s-agent-design.md`), and the archive is SQLite → **corruption hazard**. It
  does nothing for the in-memory blockers (B, C). **Not a path on its own.**

Recommendation: **Redis for the live plane (registry, queues, pub/sub) + object storage or Postgres
for the archive/ledger of-record.** Confirm before building — it adds an operational surface to `k8x`.

## Code seams in `turma/server.js`

- **Persistence:** `scheduleSave`/`loadState` (`:1265-1425`) and each policy store's save/load become
  a store adapter (`get`/`set`/`watch`), not a file. Keep the *shapes* identical so the rest of the
  file is unchanged.
- **Registry ingest + read:** heartbeat write (`:10213`) and `buildAgentsCache` (`:2484-2534`) read
  through the store; `/api/agents` becomes whole-fleet from the store, not partial from RAM.
- **SSE:** `sseBroadcast`/`publishAgent` (`:2573-2588`) publish to the bus (Option 3) or are unchanged
  (Option 2, one live process).
- **Sweeps + migration advance:** `:7456-7479`, `:8974-9000` gate on `isLeader()`.
- **Control/tunnel + terminal:** `:12593-12818` — **unchanged in Option 2** (leader owns all tunnels);
  the routing/relay work in Option 3 lives here and is the bulk of that option.
- **Graceful shutdown:** new `SIGTERM` handler around `server.listen` (`:13306`) — drain SSE, flush
  the store, close tunnels with a reconnect hint.

## What changes in `xerktech/ArgoCD` (`ai/turma/`)

- `deployment.yaml`: `replicas: 2` (or 3); `strategy: RollingUpdate` with `maxSurge/maxUnavailable`
  tuned to the topology; add the leader-lease RBAC (a `Lease` in `coordination.k8s.io` needs a
  ServiceAccount + Role — today `automountServiceAccountToken: false`, which Option 2/3 must change);
  a proper `preStop`/`terminationGracePeriodSeconds` for the drain.
- The shared store: a new Application (Redis/Postgres) with its own PVC(s) and ExternalSecret.
- The archive/ledger of-record: object-store bucket or the Postgres above.
- `pvc.yaml`: the RWO `turma-data` shrinks to whatever stays local (ideally nothing that blocks
  failover), or is retired once state is externalized.
- Ingress already carries the WebSocket/SSE/no-buffer annotations; sticky routing (if Option 3)
  is added here.

## Open questions to settle before coding

1. **Topology: Option 1, 2, or 3?** (Recommendation: 2.) This is the decision that gates everything.
2. **Shared store: Redis + object storage, or Postgres for everything?**
3. **Archive of-record:** object storage vs Postgres — it is 190 MB+ today and *"about to accumulate
   much faster"* (XERK-356), and SQLite cannot be the shared answer.
4. **Failover budget:** is ~1–2 s of reconnect (Option 2) acceptable, or is only true zero-drop
   (Option 3) acceptable? The stated goal reads as the former.
5. **`TURMA_AGENT_STRICT` / token rotation** interplay with multiple pods is unaffected (the token is
   validated per-request, stateless) — noted so it is a checked box, not a surprise.
