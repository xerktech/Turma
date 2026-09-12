# Deploying the Turma hub — operator guide (both paths)

Turma's hub supports **two deployment shapes**, and both are fully supported:

1. **Single-process (non-HA)** — one hub container on local files/RAM, **no external store**. This
   is the **default**, the zero-config path a normal Docker user runs, and what
   [`examples/compose/hub.yaml`](../examples/compose/hub.yaml) brings up. HA is **off** unless you
   turn it on.
2. **Multi-replica HA on Kubernetes** — 2–3 active-passive hub replicas behind a leader lease, backed
   by a shared store (Valkey + Postgres + object storage), so a rolling update or a pod loss causes
   **no dashboard outage**. This is what the epic
   [XERK-751](https://xerktech.atlassian.net/browse/XERK-751) builds; the design rationale is in
   [`turma-ha-design.md`](turma-ha-design.md) and [`turma-ha-store-adr.md`](turma-ha-store-adr.md).

**A hub outage costs dashboard visibility and queued commands, never work.** The fleet's agents run
natively on each host; sessions are `claude`/tmux processes owned by those agents, not by the hub,
and agents retry their heartbeats and tunnels across a gap. So the non-HA path is a completely
legitimate production choice — HA buys a *~5–6 s reconnect blip on a deploy instead of a
full-restart outage* (measured, XERK-767), not more capability.

---

## Which features require HA infra, and which do not

| Capability | Non-HA (single process) | HA (multi-replica) |
|---|---|---|
| Full fleet management, spawn/kill/resume, sessions | ✅ | ✅ |
| Terminals, live transcript tail, chat | ✅ | ✅ |
| Durable archive, usage ledger, board, triage, migration | ✅ | ✅ |
| OIDC / break-glass login, notifications (FCM) | ✅ | ✅ |
| **Low-blip rolling updates / pod-loss failover** | ❌ (a deploy = full-restart outage) | ✅ (~5–6 s reconnect) |
| **Horizontal scale-out of the dashboard** | ❌ | ❌ — see note below |

**Everything except no-outage deploys works identically on the single-process path.** HA does *not*
add features; it removes the deploy gap. Horizontal scale-out (all replicas serving) is **Option 3**
in the design doc and is deliberately **not** shipped — the HA build runs **Option 2
(active-passive)**: exactly one replica (the leader) serves all traffic, the rest stay warm off the
shared store and take over on failover. The cross-replica terminal/`/live` byte-stream relay is
deferred (XERK-764), which is *why* only the leader serves.

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
store, not failover.

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
— `HA: on (store=valkey, ledger+index=postgres, blobs=s3)` or `HA: off (single-process)` — so you can
tell a correctly-wired hub from one whose env moved under it.

### Required env when HA is on (all-or-nothing)

| Var | Selects | Example |
|---|---|---|
| `TURMA_STORE_URL` | Live plane → Valkey (redis-wire). **Also the HA-on signal when `HA_MODE` is unset.** | `rediss://valkey.turma.svc:6379/0` |
| `DATABASE_URL` | Usage ledger + archive index → Postgres (CloudNativePG) | `postgres://turma:…@pg.turma.svc:5432/turma` |
| `ARCHIVE_S3_ENDPOINT` | Archive **bytes** → object storage (MinIO/S3) | `https://minio.turma.svc:9000` |
| `ARCHIVE_S3_BUCKET` | " | `turma-archive` |
| `ARCHIVE_S3_REGION` | " (the one S3 var with a default: `us-east-1`) | `us-east-1` |
| `ARCHIVE_S3_ACCESS_KEY` / `ARCHIVE_S3_SECRET_KEY` | " (credentials) | from the store's secret |

A missing or malformed required URL is **fatal at boot** and named in the error. `TURMA_STORE_URL`
must be a `redis://`/`rediss://` URL and `DATABASE_URL` a `postgres://` URL, or the hub refuses to
start.

### Env that MUST be identical across every replica

- **`TURMA_AGENT_TOKEN`** — the fleet master. The hub re-derives each agent's per-host token from it,
  so a replica that holds a different master rejects every agent whose token was derived on another.
- **`TURMA_SESSION_SECRET`** — the signing key for the operator's session cookie. Set it **explicitly
  and identically** on every replica, or a browser signed in against one replica is logged out the
  moment failover moves it to another. (It defaults to a hash of `TURMA_USER`/`TURMA_PASSWORD` —
  identical only as long as those are; setting it explicitly also decouples the cookie from a password
  rotation.)
- **`TURMA_USER` / `TURMA_PASSWORD`**, the store connection URLs, and (if used) the OIDC and FCM
  config — all identical, since any replica may become the one serving.

---

## Path 2 — Kubernetes HA (multi-replica active-passive)

The manifests live in **`xerktech/ArgoCD`, not in this repo**:

- **`ai/turma/`** — the hub `Deployment`, `Service`, `Ingress`, and the leader-lease RBAC below. A
  release rewrites this Application's image tag and Argo CD (`automated`) syncs it; that image bump is
  exactly the deploy this HA work makes invisible.
- **`ai/turma-store/`** — the shared store the [store ADR](turma-ha-store-adr.md) selected: Valkey
  (live plane), CloudNativePG (usage ledger + archive index of-record), and MinIO/S3 (archive bytes
  of-record). This is the "new stateful dependency in the cluster" the design flags as an operator
  decision. Point the hub's `TURMA_STORE_URL` / `DATABASE_URL` / `ARCHIVE_S3_*` at these services.

This repo owns the hub code and this guide; the sections below are the manifest shapes an operator
adds to `ai/turma/` — they are net-new, because before HA the hub was `replicas: 1` +
`strategy: Recreate` with no RBAC.

### Replicas, anti-affinity, RollingUpdate

```yaml
# ai/turma/deployment.yaml (excerpt)
spec:
  replicas: 2                     # 2 or 3; only one serves at a time (Option 2)
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1                 # surge a fresh pod in during the roll
      maxUnavailable: 100%        # REQUIRED, not 0 — see the note below
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

Because only the leader serves (below), the second replica is a **warm standby**, not extra capacity.
Two replicas is enough for a low-blip deploy; three tolerates one being down *during* a deploy.

**Why `maxUnavailable` must allow 0 available, not `0`.** Readiness is gated on leadership (`/readyz`
below), so **only the leader is ever Ready** — the Deployment's `availableReplicas` is permanently 1
of `replicas`. `maxUnavailable: 0` would demand `availableReplicas ≥ replicas` throughout the roll,
which can *never* hold, so the rollout **deadlocks** (it surges a new pod, but that pod stays a
NotReady standby and the old leader is never drained). `maxUnavailable: 100%` is what lets the roll
proceed at all — and it means Kubernetes may drain the old leader *before* the surged pod is Ready.
A brief serving gap during a deploy is therefore **inherent** to Option 2 + leadership-gated
readiness, not a tuning miss; see the measured cost in step 4 below.

### The leader lease + RBAC (net-new)

Under HA the singleton work — the offline-alert sweep, the auto-start/stop/ticket-drain bundle,
migration-advance — and **which replica the Service routes to** both gate on a Kubernetes `Lease` in
`coordination.k8s.io`. The hub reads its in-cluster ServiceAccount token from
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
| `TURMA_LEADER_LEASE_MS` | `15000` | lease duration a standby honors before it may take over |
| `TURMA_LEADER_RENEW_MS` | `10000` | leader's renew deadline |
| `TURMA_LEADER_RETRY_MS` | `2000` | election retry period |

The holder identity is the pod name (`POD_NAME`/`HOSTNAME`) plus a random suffix, so two processes
that somehow share a name never both believe they hold the lease. `isLeader()` self-expires off the
last confirmed renewal, so a wedged leader drops leadership within the lease window even if its loop
stalls — it can never race a newly-promoted standby.

### Probes: `/readyz` (readiness) vs `/healthz` (liveness)

These are **distinct** and must be wired to the right probe:

```yaml
# ai/turma/deployment.yaml — container probes
livenessProbe:                    # process-up only; NEVER reads leadership/drain
  httpGet:  { path: /healthz, port: 8300 }
  periodSeconds: 30
readinessProbe:                   # gates Service membership on leadership + drain
  httpGet:  { path: /readyz, port: 8300 }
  periodSeconds: 5
```

- **`/healthz`** → `200 {ok:true}` while the process is up. Unauthenticated, leaks nothing. Use it
  for liveness only — it must *not* follow leadership, or a healthy standby would be restart-looped.
- **`/readyz`** → `200 {ready:true}` **only on the leader that is not draining**; otherwise `503`
  (`{ready:false, leader:false}` on a standby, `{ready:false, draining:true}` while shutting down).
  This is the **Service gating** that makes Option 2 work: a non-leader answers NotReady, so the
  Service removes it from its EndpointSlice and browsers/agents only ever hit the leader. With HA off
  there is no elector and `/readyz` is always Ready — a single-replica or docker-compose hub is
  unaffected.

The Docker `healthcheck` in `hub.yaml` already targets `/healthz` — correct, since a compose hub is
always the leader.

### The rolling update, step by step (a reconnect blip, not a full-restart outage)

On `SIGTERM` (which a rolling update sends to the old pod):

1. `/readyz` flips to **503 NotReady** immediately, so the Service pulls the pod from its
   EndpointSlice — new connections stop landing on it.
2. The draining leader **renounces the lease** (backdated `renewTime`), so a standby can win it now
   rather than waiting out the full lease window.
3. The hub holds for `READYZ_DRAIN_DELAY_MS` (default `2000`, capped below `SHUTDOWN_DRAIN_MS`) to let
   the endpoint removal propagate, **then** closes SSE/WebSocket sockets with a going-away code and
   flushes the store. Force-exit backstop at `SHUTDOWN_DRAIN_MS` (default `10000`).
4. A new leader wins the lease, flips **Ready**, and the Service routes to it; browsers and agents
   re-dial. **Measured reconnect cost (XERK-767, prod, `kubectl rollout restart`, `/readyz` polled
   through the Service every 200 ms): ~5–6 s with no Ready endpoint** — ~4–5 s of `503` from the
   draining old leader (still the sole endpoint until kube-proxy catches up) then ~1 s of
   connection-refused, before the new leader answers `200`. It is a *reconnect blip*, not a
   full-restart outage — but it is **not** the ~1–2 s a warm-standby promotion would cost. In a
   rolling update the old warm standby is *also* being replaced, so the lease goes to a **fresh pod
   that must cold-boot, elect, and hydrate the archive index** before it is Ready; that cold-promote
   is the bulk of the gap. An abrupt leader pod-loss with a surviving warm standby is faster (bounded
   by the lease window + index hydration), but was not measured under XERK-767 (pod deletion is
   guard-blocked in that environment). Shrinking the rollout gap is tracked separately.

Set `terminationGracePeriodSeconds` at or above `SHUTDOWN_DRAIN_MS` so Kubernetes doesn't `SIGKILL`
mid-drain.

### Storage under HA — no RWO volume blocks failover

- **State** (fleet registry, queues, migration record, policy/pins, OIDC side-stores) lives in
  **Valkey**; the **usage ledger** and **archive index** in **Postgres**; the **archive bytes** in
  **object storage**. None of it is on a pod-local volume, so a standby is promotable with no volume
  detach/attach.
- The archive **index is a local, disposable SQLite file rebuilt from the object-store bytes**
  (XERK-759), not a shared file — there is no shared SQLite to corrupt. A **just-promoted** standby
  hydrates and rebuilds it before serving archive reads, so archive queries can briefly `404`
  "still syncing" right after a failover. Accepted for Option 2, where failover is rare.
- You do **not** need the `turma-data` RWO PVC under HA. Keep one only if you run a replica with
  `HA_MODE=0` against the same cluster (the escape hatch).

---

## Verifying a deploy

- **Boot line:** `kubectl logs` a hub pod and confirm `HA: on (store=valkey, ledger+index=postgres,
  blobs=s3)`. `HA: off` on a pod you expected to be HA means the store env didn't reach it.
- **Leadership:** exactly one pod's `/readyz` returns `200`; the rest return `503 {leader:false}`.
  `kubectl get lease turma-hub-leader -n turma -o yaml` shows the current holder.
- **Low-blip deploy:** bump the image (or `kubectl rollout restart deploy/turma-hub`) and hold an
  SSE stream or a terminal open against the public URL — it should reconnect within ~5–6 s (measured,
  XERK-767), not drop for the pod's full boot. Poll `/readyz` *through the Service* every 200 ms to
  measure the gap precisely: the Service routes only to the Ready leader, so any non-`200` there is
  the real serving-gap window.
- **RBAC:** if pod logs warn "no Kubernetes service account is reachable — leader election is
  DISABLED", the ServiceAccount/Role/RoleBinding or `automountServiceAccountToken` is missing, and
  every replica is running the sweeps (double alerts, double auto-starts). Fix before going wider.
