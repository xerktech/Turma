# Deploying the Turma hub — operator guide (both paths)

Turma's hub supports **two deployment shapes**, and both are fully supported:

1. **Single-process (non-HA)** — one hub container on local files/RAM, **no external store**. This
   is the **default**, the zero-config path a normal Docker user runs, and what
   [`examples/compose/hub.yaml`](../examples/compose/hub.yaml) brings up. HA is **off** unless you
   turn it on.
2. **Multi-replica HA on Kubernetes** — 2–3 hub replicas, **every one Ready behind the load
   balancer, with the lease leader as the single writer**: a follower transparently forwards every
   request and WebSocket to the leader (XERK-919), backed by a shared store (Valkey + Postgres +
   object storage). A rolling update causes **no serving gap** (requests arriving mid-handover are
   HELD for ~1-2s, not failed), and the standby is warm. The design rationale is in
   [`turma-ha-design.md`](turma-ha-design.md) and [`turma-ha-store-adr.md`](turma-ha-store-adr.md);
   why serving is single-writer rather than active-active is below.

**A hub outage costs dashboard visibility and queued commands, never work.** The fleet's agents run
natively on each host; sessions are `claude`/tmux processes owned by those agents, not by the hub,
and agents retry their heartbeats and tunnels across a gap. So the non-HA path is a completely
legitimate production choice — HA buys a *deploy with no serving gap and a warm standby*, not more
capability.

---

## Which features require HA infra, and which do not

| Capability | Non-HA (single process) | HA (multi-replica) |
|---|---|---|
| Full fleet management, spawn/kill/resume, sessions | ✅ | ✅ |
| Terminals, live transcript tail, chat | ✅ | ✅ |
| Durable archive, usage ledger, board, triage, migration | ✅ | ✅ |
| OIDC / break-glass login, notifications (FCM) | ✅ | ✅ |
| **Zero-gap rolling updates / pod-loss failover** | ❌ (a deploy = full-restart outage) | ✅ (every replica Ready; the leader hands over after flushing; followers hold, then forward to the successor) |
| **Horizontal scale-out of request serving** | ❌ | ❌ (the leader serves everything; followers only forward bytes) |

**Everything except no-gap deploys works identically on the single-process path** — HA runs the
same single process's semantics, just on whichever replica holds the lease.

### Why the leader serves everything (XERK-919)

Active-active serving (XERK-782: every replica serving its own requests) was reverted. The hub's
request path is built on per-process state, and under a no-affinity LB a request and its follow-up
land on different replicas. Reproduced on a real 2-replica stack:

- **Terminals:** the agent's data-channel dial-back reached the wrong replica about half the time, so
  each failed open was a 5s stall into the reconnect page (the "reconnect several times" symptom).
- **Messages / new sessions:** a command queued on one replica was overwritten by the other
  replica's heartbeat write — 46% of chat inputs lost at a 600ms cadence, every one answered 200.
- **Everything else per-process:** the on-demand results (history, ticket create/status, merge), the
  ticket queue, alert dedup, and a re-dialed tunnel's stale predecessor on the old replica.

With one writer these are single-process again, by construction. Measured after the fix, under
continuous load: 40/40 terminal opens (was 20/40), 50/50 inputs (was 27/50), a follower-then-leader
rolling restart with 240/240 inputs delivered and a 678ms worst request, and a SIGKILLed leader with
0 inputs lost (terminals return once the lease expires, ~15s — shorten `TURMA_LEADER_LEASE_MS` to
shorten that). `TURMA_HA_FORWARD=0` restores active-active serving as an escape hatch only.

---

## Path 1 — single-process (non-HA), the default

Follow the [README Quick start](../README.md#quick-start). In one paragraph:

```sh
cd examples/compose
cp .env.example .env && $EDITOR .env   # set TURMA_PASSWORD + TURMA_AGENT_TOKEN
docker compose -f hub.yaml up -d
```

- **No `HA_MODE`, no store URLs → HA is off.** The hub runs on the `/data` volume (which must
  persist: it holds `state.json`, the policy JSON, and the `archive/` tree). At boot the log says
  `HA: off (single-process)`.
- Nothing in this path needs Valkey, Postgres, or object storage. It is the recommended shape for a
  single operator or a small fleet.

To integration-test the HA wiring locally without Kubernetes, there is an optional
[`hub-ha.yaml`](../examples/compose/hub-ha.yaml) that brings up the hub alongside the shared store
(Valkey + Postgres + MinIO). Read its header first — it is **not** the normal way to run Turma, and a
pre-HA image ignores every store var. It runs **one** hub (no leader contention), so it exercises the
store, not multi-replica serving or failover.

---

## The HA config toggle (`ha-config.js`)

**One switch decides the mode, and it fails loud rather than ever running half-HA.**

- **`HA_MODE` unset** → HA is inferred **on iff `TURMA_STORE_URL` is present**. Adding the store URL
  to the deployment is the single action that turns HA on; a bare `docker compose up` with no such
  env stays single-process with zero config.
- **`HA_MODE=1`** → HA forced on. Every required URL (below) **must** be present, or the hub
  **refuses to boot** with a named error — never a silent fallback to single-process (a hub quietly
  running local while its replicas run shared is the split-brain the whole epic exists to avoid).
- **`HA_MODE=0`** → HA forced off even if store URLs are in the env — the escape hatch to run a
  known-good single-process hub against a cluster that still has the wiring.

Precedence: an explicit `HA_MODE` (1/0) wins over URL presence. The effective mode **prints at boot**
— `HA: on (store=valkey, ledger=postgres, index=postgres, blobs=s3)` or
`HA: off (single-process)` — so you can tell a correctly-wired hub from one whose env moved under it.
The boot line names the backends **actually in use**, each by its own flag: BOTH of-record backends
are Postgres — the usage ledger's high-water (XERK-779, `LedgerStore`) and the archive index
(XERK-780, `IndexStore`, hydrated from Postgres instead of rebuilt from the S3 bytes). `DATABASE_URL`
is required (below) and is consumed by both.

### Required env when HA is on (all-or-nothing)

| Var | Selects | Example |
|---|---|---|
| `TURMA_STORE_URL` | Live plane → Valkey (redis-wire). **Also the HA-on signal when `HA_MODE` is unset.** | `rediss://valkey.turma.svc:6379/0` |
| `DATABASE_URL` | Durable of-record → Postgres (CloudNativePG). **Consumed by BOTH the usage ledger (XERK-779) and the archive index (XERK-780)** — one shared `PgPool`. | `postgres://turma:…@pg.turma.svc:5432/turma` |
| `ARCHIVE_S3_ENDPOINT` | Archive **bytes** → object storage (MinIO/S3) | `https://minio.turma.svc:9000` |
| `ARCHIVE_S3_BUCKET` | " | `turma-archive` |
| `ARCHIVE_S3_REGION` | " (the one S3 var with a default: `us-east-1`) | `us-east-1` |
| `ARCHIVE_S3_ACCESS_KEY` / `ARCHIVE_S3_SECRET_KEY` | " (credentials) | from the store's secret |

A missing or malformed required URL is **fatal at boot** and named in the error. `TURMA_STORE_URL`
must be a `redis://`/`rediss://` URL and `DATABASE_URL` a `postgres://` URL, or the hub refuses to
start.

### Env that MUST be identical across every replica

Because every replica serves traffic, a browser or agent request can land on any of them, so the
identity-bearing env must match on all:

- **`TURMA_AGENT_TOKEN`** — the fleet master. The hub re-derives each agent's per-host token from it,
  so a replica that holds a different master rejects every agent whose token was derived on another.
- **`TURMA_SESSION_SECRET`** — the signing key for the operator's session cookie **and** the derived
  key for the pod-to-pod relay hop (`HMAC(SESSION_KEY, "turma-relay")`, XERK-781). Set it **explicitly
  and identically** on every replica, or (a) a browser signed in against one replica is logged out the
  moment the LB routes its next request to another, and (b) the cross-replica terminal/`/live` relay
  refuses the pod-to-pod hop as unauthorized. (It defaults to a hash of `TURMA_USER`/`TURMA_PASSWORD`
  — identical only as long as those are; setting it explicitly also decouples the cookie from a
  password rotation.)
- **`TURMA_USER` / `TURMA_PASSWORD`**, the store connection URLs, and (if used) the OIDC and FCM
  config — all identical, since any replica may serve any request.

---

## Path 2 — Kubernetes HA (multi-replica, single-writer)

The manifests live in **`xerktech/ArgoCD`, not in this repo**:

- **`ai/turma/`** — the hub `Deployment`, `Service`, `Ingress`, the leader-lease RBAC below, and the
  pod-to-pod relay wiring below. A release rewrites this Application's image tag and Argo CD
  (`automated`) syncs it; that image bump is exactly the deploy this HA work makes invisible.
- **`ai/turma-store/`** — the shared store the [store ADR](turma-ha-store-adr.md) selected: Valkey
  (live plane, and the pub/sub bus for cross-replica SSE + the registry/tunnel/migration watches),
  CloudNativePG (the ledger + archive-index of-record — **actively written**, no longer idle), and
  MinIO/S3 (archive bytes of-record). This is the "new stateful dependency in the cluster" the design
  flags as an operator decision. Point the hub's `TURMA_STORE_URL` / `DATABASE_URL` / `ARCHIVE_S3_*`
  at these services.

This repo owns the hub code and this guide; the sections below are the manifest shapes an operator
adds to `ai/turma/` — they are net-new, because before HA the hub was `replicas: 1` +
`strategy: Recreate` with no RBAC and no pod-to-pod port.

### Replicas, anti-affinity, RollingUpdate

```yaml
# ai/turma/deployment.yaml (excerpt)
spec:
  replicas: 2                     # 2 or 3; all Ready, the lease leader serves
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1                 # surge a fresh pod in during the roll
      maxUnavailable: 0           # keep every existing replica serving through the roll
  template:
    spec:
      terminationGracePeriodSeconds: 20   # ≥ SHUTDOWN_DRAIN_MS (default 10s), room for the drain
      affinity:
        podAntiAffinity:          # keep replicas on different nodes, so a node loss ≠ full outage
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                topologyKey: kubernetes.io/hostname
                labelSelector:
                  matchLabels: { app: turma-hub }
```

Every replica is real serving capacity, not a warm standby. Two replicas gives a no-gap deploy and
survives one pod failing; three tolerates one being down *during* a deploy.

**`maxUnavailable: 0` is now the right value — and it no longer deadlocks.** Under the old
active-passive topology (Option 2) readiness was gated on leadership, so only the leader was ever
`Ready` and `availableReplicas` was permanently 1; `maxUnavailable: 0` demanded
`availableReplicas ≥ replicas`, which could never hold, so the rollout wedged — which is why that
topology was **forced** to `maxUnavailable: 100%` and ate a serving gap. Now readiness is
leader-independent (below): **every** healthy, non-draining replica is `Ready`, so
`availableReplicas == replicas` and a real rolling value works. `maxUnavailable: 0` + `maxSurge: 1`
means Kubernetes surges a fresh pod, waits for it to become `Ready` (and start serving), and only
then drains an old one — so the Service always has other Ready endpoints and a deploy drops no
serving window. **Do not restore `maxUnavailable: 100%`** — it would let Kubernetes drain replicas
before their replacements are Ready, reintroducing the gap the flip removed.

### The leader lease + RBAC (required — it decides who SERVES and who runs the sweeps)

The singleton background work — the offline-alert sweep, the auto-start/stop/ticket-drain bundle
(`masterOrchestrationTick`), migration-advance — must run on **exactly one** replica, or N replicas
double-fire alerts, double-spawn/double-kill sessions, and double-write the tracker. That work gates
on a Kubernetes `Lease` in `coordination.k8s.io`. **The lease no longer decides which replica the
Service routes to** — every replica serves; the lease is purely the "who runs the sweeps" election.
The hub reads its in-cluster ServiceAccount token from
`/var/run/secrets/kubernetes.io/serviceaccount` and runs the election loop itself (stdlib only, no
client library).

**Without a reachable ServiceAccount the hub logs a warning and every replica runs the sweeps** (it
falls back to a standalone always-leader). So for a correct multi-replica deploy the RBAC below is
**required**, and `automountServiceAccountToken` must be `true` (the pre-HA manifest set it `false`).

```yaml
# ai/turma/rbac.yaml (net-new)
apiVersion: v1
kind: ServiceAccount
metadata: { name: turma-hub, namespace: turma }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: turma-hub-leader, namespace: turma }
rules:
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["get", "create", "update"]   # exactly what the elector calls — no list/watch/delete
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: turma-hub-leader, namespace: turma }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: turma-hub-leader }
subjects: [{ kind: ServiceAccount, name: turma-hub, namespace: turma }]
```

Then on the pod template: `serviceAccountName: turma-hub` and `automountServiceAccountToken: true`.

Lease knobs (defaults shown; override via env only if you have a reason):

| Env | Default | Meaning |
|---|---|---|
| `TURMA_LEADER_LEASE` | `turma-hub-leader` | the `Lease` object's name |
| `TURMA_LEADER_NAMESPACE` | the pod's namespace (from the SA), else `default` | where the Lease lives |
| `TURMA_LEADER_LEASE_MS` | `15000` | lease duration a follower honors before it may take over |
| `TURMA_LEADER_RENEW_MS` | `10000` | leader's renew deadline |
| `TURMA_LEADER_RETRY_MS` | `2000` | election retry period |

The holder identity is the pod name (`POD_NAME`/`HOSTNAME`) plus a random suffix, so two processes
that somehow share a name never both believe they hold the lease. `isLeader()` self-expires off the
last confirmed renewal, so a wedged leader drops leadership within the lease window even if its loop
stalls — it can never race a newly-promoted follower into running the sweeps twice.

### Pod-to-pod reachability: the hub port and the relay port

- **Followers forward to the leader's HTTP port** (XERK-919). The leader publishes
  `POD_IP:8300` (`TURMA_HUB_ENDPOINT` overrides), so port `8300` must be reachable pod-to-pod — it
  already is (it is the container port the Service targets). With no `POD_IP` and no override the
  hub falls back to the pod's first IPv4; a leader with no address makes followers serve locally
  (logged `DEGRADED`). Confirm on boot: `serving: single-writer — … (this replica's endpoint <ip>:8300)`.

### The cross-replica byte-stream relay (the handover/degraded path)

With the leader serving everything this relay is rarely used — mid-handover, a tunnel still held by
the outgoing leader is reached through it. Under active-active (`TURMA_HA_FORWARD=0`) a browser's
`/term`, `/live` or `openChannel` socket can land on a **different**
replica than the one holding the target host's agent tunnel. The relay (`turma/relay.js`, XERK-777/781)
proxies those bytes pod-to-pod on a **dedicated TCP transport** (never the store's pub/sub bus, which
carries only a byte-free endpoint directory). Three manifest additions make it reachable:

- **Expose the relay port pod-to-pod.** `RELAY_PORT` (`TURMA_RELAY_PORT`, default `8390`) is where a
  replica listens for peer dials. Add it as a second `containerPort` and allow it between hub pods.
- **Inject `POD_IP`** via the downward API so a replica can publish its own dial address into the
  endpoint directory:
  ```yaml
  env:
    - name: POD_IP
      valueFrom: { fieldRef: { fieldPath: status.podIP } }
  ```
  (Override with `TURMA_RELAY_ENDPOINT` if the pod IP is not the reachable address.) A null endpoint
  is logged, not fatal — the replica can still *originate* relayed streams, but peers can't dial *its*
  owned tunnels, so terminals/`/live` for hosts it owns would fail cross-replica.
- **A NetworkPolicy** allowing ingress on `RELAY_PORT` **from the hub's own pods only** (`app:
  turma-hub`), so the pod-to-pod hop is not otherwise reachable. The hop is additionally authenticated
  by the shared `TURMA_SESSION_SECRET`-derived token, so both the NetworkPolicy and the identical
  secret are load-bearing.

### Ingress — sticky sessions are NOT required

Any pod can accept any request: a follower forwards it to the leader, so a plain round-robin
`Service` is correct and a client that reconnects may land on any replica. Affinity would not help
either — the agents' tunnels, their data-channel dial-backs and the browsers' requests are all
separate connections, and the thing that must be co-located (everything in one process) is what the
forwarding already guarantees. Keep the existing WebSocket/SSE and no-buffer annotations the ingress
carries (they are about upgrade + streaming, unrelated to affinity).

### Probes: `/readyz` (readiness) vs `/healthz` (liveness)

These are **distinct** and must be wired to the right probe:

```yaml
# ai/turma/deployment.yaml — container probes
livenessProbe:                    # process-up only; NEVER reads leadership/drain
  httpGet:  { path: /healthz, port: 8300 }
  periodSeconds: 30
readinessProbe:                   # gates Service membership on drain (NOT leadership)
  httpGet:  { path: /readyz, port: 8300 }
  periodSeconds: 5
```

- **`/healthz`** → `200 {ok:true}` while the process is up. Unauthenticated, leaks nothing. Use it
  for liveness only — it must *not* follow leadership or drain, or a serving replica would be
  restart-looped.
- **`/readyz`** → `200 {ready:true}` on **every healthy, non-draining replica** (leader-INDEPENDENT
  since XERK-782); `503 {ready:false, draining:true}` only while that replica is shutting down. This
  is the **Service gating for graceful drain**: a draining replica answers NotReady so the Service
  pulls it from its EndpointSlice before its sockets are cut, and browsers/agents reconnect to a
  surviving replica. It is **no longer** a leader gate — do not wire readiness to leadership, or you
  re-create the active-passive topology (one Ready pod) and its forced `maxUnavailable: 100%`. With HA
  off there is no elector and `/readyz` is always Ready — a single-replica or docker-compose hub is
  unaffected (the flip only removed a `503` branch a single-process hub never took).

The Docker `healthcheck` in `hub.yaml` already targets `/healthz` — correct.

### The rolling update, step by step (no serving gap)

On `SIGTERM` (which a rolling update sends to a pod being replaced):

1. `/readyz` flips to **503 NotReady** immediately, so the Service pulls *that pod* from its
   EndpointSlice — new connections stop landing on it. **Other replicas stay Ready.** A draining
   LEADER keeps leading (followers keep forwarding to it) through the hold below.
2. The hub holds for `READYZ_DRAIN_DELAY_MS` (default `2000`, capped below `SHUTDOWN_DRAIN_MS`) to let
   the endpoint removal propagate.
3. **Handover (leader only), in this order:** close the listener, flush the fleet registry to the
   store and wait for it, release the lease (backdated `renewTime`, so a follower wins it within one
   election retry, ~2s), and retract the leader endpoint. Followers HOLD requests meanwhile and
   forward them to the successor the moment it publishes — held, not failed. The successor re-reads
   the registry from the store before it serves.
4. Then SSE/WebSocket sockets close with a going-away code and the rest flushes. Force-exit backstop
   at `SHUTDOWN_DRAIN_MS` (default `10000`). Agents re-dial their tunnels through the LB and land on
   the new leader (a terminal open in that ~1s window shows the self-reloading reconnect page once).
5. Kubernetes only surged the replacement pod in once it was `Ready` (because `maxUnavailable: 0`),
   so at no point is the Service left without a Ready endpoint. **There is no cold-promote gap**: the
   successor is a replica that was already running and forwarding, its registry kept hot by the watch.

Set `terminationGracePeriodSeconds` at or above `SHUTDOWN_DRAIN_MS` so Kubernetes doesn't `SIGKILL`
mid-drain.

### Storage under HA — no RWO volume blocks a replica

- **State** (fleet registry, queues, migration record, policy/pins, OIDC side-stores) lives in
  **Valkey**; the **usage ledger** and the **archive index** are the **Postgres** of-record
  (XERK-779 / XERK-780); the **archive bytes** in **object storage**. None of the durable state is on
  a pod-local volume, so every replica reads/writes the same shared truth and a new/replacement pod
  needs no volume detach/attach.
- The archive keeps a **local, disposable SQLite cache** per replica for the synchronous read + beat
  paths, but it is now **hydrated from the Postgres index of-record** (XERK-780), not rebuilt by
  re-parsing the object-store bytes. A freshly-started replica hydrates that cache (a Postgres read of
  indexed rows, far cheaper than the old file walk) plus a local working copy of the bytes before it
  answers `Ready`, so archive reads are served straight away rather than briefly `404`-ing
  "still syncing".
- You do **not** need the `turma-data` RWO PVC under HA. Keep one only if you run a replica with
  `HA_MODE=0` against the same cluster (the escape hatch). The migration spool / `MIGRATE_SPOOL_DIR`
  stays a **per-pod `emptyDir`** — it does **not** need an RWX mount (XERK-785, superseding the earlier
  RWX note): an in-flight migration's bundle bytes are RELAYED from the replica that spooled them to
  the replica the pull lands on, over the same pod-to-pod byte relay `/term`/`/live` use (needs the
  `RELAY_PORT` reachable pod-to-pod + `POD_IP` injected, which HA already requires).

---

## Verifying a deploy

- **Boot line:** `kubectl logs` a hub pod and confirm `HA: on (store=valkey, ledger=postgres,
  index=postgres, blobs=s3)`. `HA: off` on a pod you expected to be HA means the store env didn't
  reach it. The line names the backends actually wired — both of-record backends write Postgres: the
  usage ledger's `usage_host`/`usage_series`/`usage_day`/`usage_model` tables (XERK-779, appear once a
  host reports spend) and the archive index's `archive_sessions`/`archive_entries` tables (XERK-780).
- **All replicas Ready, one serves:** **every** pod's `/readyz` returns `200` (a `503` means that pod
  is draining). The leader logs `forward: serving locally (this replica is the leader)`; every
  follower logs `forward: forwarding to the leader at <ip>:8300`. A follower logging `DEGRADED` means
  it could not reach a leader — check pod-to-pod reachability of 8300 and the lease.
- **Leadership:** exactly one pod holds the lease — `kubectl get lease turma-hub-leader -n <ns> -o
  yaml` shows the current holder. It decides who serves and who runs the sweeps.
- **No-gap deploy:** bump the image (or `kubectl rollout restart deploy/turma-hub`) and hold an
  SSE stream or a terminal open against the public URL — it stays up throughout (a client whose pod is
  drained reconnects within its own retry to an already-serving replica). Poll `/readyz` *through the
  Service* every 200 ms: the Service always has a Ready endpoint, so it should never go non-`200` for
  a whole window (only individual pods flip `503` as they drain).
- **Terminals / tunnels:** every `tunnel connected:` line should appear on the LEADER's log (agents
  reach it through whichever pod the LB picks). Open several terminals in a row — each should connect
  first time. If they stall, check `8300` pod-to-pod, `POD_IP`, and `TURMA_SESSION_SECRET` parity.
- **RBAC:** if pod logs warn "no Kubernetes service account is reachable — leader election is
  DISABLED", the ServiceAccount/Role/RoleBinding or `automountServiceAccountToken` is missing, and
  every replica is running the sweeps (double alerts, double auto-starts). Fix before going wider.
