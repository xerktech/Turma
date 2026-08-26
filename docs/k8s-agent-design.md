# Running Turma agents on Kubernetes — design (XERK-369)

> **SUPERSEDED.** This design was written around the agent **container image**, which the repo no
> longer builds — the agent is native-only now, and `k8x` runs a native (Ubuntu) agent. References
> below to `agent/Dockerfile`, `agent/entrypoint.sh`, `.claude/rules/agent-image.md` and a
> `turma-agent` StatefulSet describe that removed container path; kept for design history only.

**A design, not an implementation.** The ticket asks for a k8s agent for Turma: an operator that
starts a container per session, persistent repo storage that does not re-clone and is reachable from
every node, and whether one persistent agent per node would be better even though that "feels more
messy".

**The shape is now decided by the ticket owner** and this document is written to it:

- The cluster appears in Turma as **one agent**, not three.
- **One** Claude login, one `gh`, one `~/.aws`, one `~/.azure`, one `~/.terraform.d` — not a set per
  node.
- Shared storage is **Longhorn**, not NFS from TrueNAS.
- Longhorn will eventually have disks on all three nodes, not just talos02/03.

Everything below follows from that. Where a constraint fights one of those choices, it is called out
rather than quietly designed around.

## One correction, because it changes an input to the decision

**Longhorn RWX is NFS.** A Longhorn `ReadWriteMany` volume is attached RWO to a per-volume
**share-manager pod** which exports it over **NFSv4 (Ganesha)**; every consumer pod mounts that NFS
export. There is no Longhorn RWX filesystem that is not NFS underneath.

That does not sink the plan — it changes what "not NFS" is buying:

- **What you do get** by choosing Longhorn RWX over TrueNAS NFS: replicas on cluster NVMe, no
  dependency on the TrueNAS box for any session to run, one storage system to operate, and the
  volume follows the cluster's own failure domains.
- **What you do not get**: local-disk latency. Every `git status`, `npm install` and Gradle build
  crosses NFS to the share-manager pod, and that pod's writes are then synchronously replicated to
  two (soon three) nodes.
- **What it adds**: a share-manager pod per volume, which is a single point of failure for every
  session at once. Longhorn restarts it and clients recover through the NFS grace period, but IO
  stalls fleet-wide while that happens.

If a genuinely distributed multi-writer filesystem is wanted later, the honest option is **CephFS
(Rook)** rather than Longhorn RWX — it is a real clustered filesystem instead of one node re-exporting
a block device. It is also a second storage system to run beside Longhorn, which is a much bigger
decision than this ticket. Not recommended now; recorded so it is a choice rather than an oversight.

## The decision

**One manager for the cluster, always. Sessions move into their own pods in a second step, gated on
a measurement.**

- **Phase 1 — ship this.** One `turma-agent` pod (a single-replica StatefulSet) with one **Longhorn
  RWO** volume holding `REPOS_ROOT` and `$HOME`. Sessions run inside it exactly as they do on
  truenas and MaxAI today. This is **one agent in Turma, one credential set, Longhorn storage, and
  zero code change** — it satisfies every stated preference except spreading sessions across nodes.
- **Phase 2 — the target shape.** Same manager, same host card, same credentials; the volume becomes
  **Longhorn RWX** and each session becomes its own **Pod**, scheduled anywhere in the cluster. This
  is the ticket's operator idea, and it is reachable *because* there is one manager — see the rule
  below.
- **No CRD, and no separate operator process.** `hub-agent.py` is already a reconcile loop over
  desired state: the hub issues commands, the registry is the desired state, `_provision_session()`
  reconciles. A `TurmaSession` CRD would duplicate that loop and add a second writer. Nothing else
  in the cluster needs to create Turma sessions declaratively, which is the only thing a CRD buys.
  The seam, if it is ever wanted, is `_provision_session()`.

Phase 1 is not a throwaway. It is the same pod, the same volume layout, the same identity, the same
secrets and the same host card as phase 2 — the only thing phase 2 changes is *where the session
process runs*. Nothing built in phase 1 is discarded.

### The rule that makes this coherent

**Sharing a `REPOS_ROOT` requires exactly one manager.** `prune` removes worktrees that are merged
and not backing a live session, and it re-reads liveness from **its own** registry
(`.claude/rules/agent.md`) — another manager's sessions are not in it, so their worktrees look
removable. Both managers would also allocate worktree directories and mutate `.git/worktrees/`
metadata concurrently.

So: **one manager ⇒ a shared store is safe and pod-per-session is reachable. N managers ⇒ N separate
checkouts, full stop.** Choosing "the cluster is one agent" is therefore also what makes "a central
RWX store shared by all nodes" a legal design. The two preferences in the ticket reinforce each
other; they are not independent.

## What has to be visible, and to whom

Read `CLAUDE.md` ("Session Model") and `.claude/rules/agent.md` first. What matters here:

- **An agent is two processes** — `hub-agent.py` (session manager + heartbeat) and `tunnel-agent.js`
  (one reverse tunnel per host) — both **outbound-only** to `TURMA_URL`. Nothing connects *to* an
  agent, so there is no Service, no Ingress and no NetworkPolicy on the terminal path.
- **An agent's identity is its host name**, proved by a credential bound to that name
  (`<base64url(device)>.<HMAC(TURMA_AGENT_TOKEN, device)>`, XERK-268). Identity must be stable across
  restarts — hence a StatefulSet, not a Deployment.
- **A session is a git worktree + a tmux + a ttyd + a `claude` process.** The manager drives it
  through the pane (27 `tmux` call sites, 16 of them `send-keys`) and `tunnel-agent.js` bridges its
  ttyd from `127.0.0.1:<ttydPort>`.
- **Everything the hub displays is read off the filesystem by the manager**: transcripts under
  `~/.claude/projects/<slug>/<id>.jsonl` (busy state, usage, PR chips, live subagents, history,
  archive) and the worktree's own git state.

| | Written by | Read by | Why it binds |
|---|---|---|---|
| `REPOS_ROOT` (repos + `.turma/worktrees`) | session, manager | manager every beat | a worktree's `.git` holds an absolute `gitdir:` path and the repo holds an absolute path back — both must resolve, identically, in every container that touches either |
| `~/.claude/projects` | the session's `claude` | manager every beat | the transcript is the only source for busy/usage/PR/agents/history/archive |
| `~/.claude/.credentials.json`, `~/.claude.json` | `claude`, on OAuth refresh | every session | one login, and only one writer at a time — see below |
| `~/.turma` | manager | sessions (`--settings` guard file, uploads, `peers.tsv`) | registry, ledgers, and the guard settings every launch passes |

In phase 1 all four are one RWO volume in one pod. In phase 2 all four are one RWX volume mounted at
identical paths in the manager and every session pod. **Mount `REPOS_ROOT` at `/repos` and `HOME` at
`/root` in every container** — `HOME` stays `/root` (`.claude/rules/agent-image.md`), and the paths
must not differ between manager and session or worktrees stop resolving.

## Measured facts (truenas, 2026-08-19)

Sizing guesses are the usual way these designs go wrong, so these are measurements from the running
fleet:

| | |
|---|---|
| A live `claude` session | **470–590 MB RSS** (4 concurrent sessions sampled) |
| Every repo in `REPOS_ROOT`, with history | **4.3 GB**; Veiller alone is 3.8 GB |
| Worktrees | **32 GB across 168 worktrees** — Veiller 22 GB, Tenir 5.1 GB, Turma 4.7 GB across 99 |
| `~/.claude` | 266 MB, of which 183 MB is 718 transcript slugs |
| Heartbeat cadence | 20 s, one `capture-pane` + transcript read per session per beat |
| Agent image `:latest` | 3.0 GB (the `android-build` tier) |
| MaxAI's sizing today | `MAX_SESSIONS: 6`, `mem_limit: 16g`, `cpus: 6.0` |

**The worktrees, not the repos, are the disk** — and almost all of that is build output and
dependencies (`node_modules`, Gradle caches). That is also precisely the data you least want on a
network filesystem, which is what phase 2's benchmark exists to check.

## Cluster facts that constrain this (`k8x`)

From `xerktech/Talos` and `xerktech/ArgoCD`:

- **Three nodes, all control-plane**, scheduling enabled. Talos v1.13.8, Kubernetes v1.36.2.
- **Longhorn 1.x, `defaultReplicaCount: 2`, `replicaSoftAntiAffinity: false`, disks only on
  talos02/03** (the `longhorn-storage` role; talos04 has no spare disk). Adding talos04 means adding
  it to `NODE_ROLES` in `xerktech/Talos` and *then* raising the replica counts in
  `apps/longhorn.yaml` — the cross-repo contract in `.claude/rules/longhorn.md`. It changes replica
  placement; it changes nothing about RWX being NFS.
- **Talos enforces the Pod Security `baseline` profile cluster-wide, exempting only `kube-system`.**
  The agent needs nothing baseline forbids — no `hostPath`, no privileged, no host network — so the
  `turma` namespace needs **no** `privileged` label (unlike `longhorn-system`). Running as root is
  allowed under baseline, which matters: sessions run as root with `IS_SANDBOX=1` so
  `bypassPermissions` is permitted.
- **Everything is GitOps**: Argo CD app-of-apps out of `xerktech/ArgoCD`, secrets via ExternalSecrets
  from Bitwarden. Talos' `inlineManifests` bootstrap is create-once and is not where a workload goes.
- **NFS mounting demonstrably works on these nodes** — `csi-driver-nfs` is deployed and serving
  static TrueNAS PVs. That de-risks Longhorn RWX's client side, though Longhorn's own RWX path is
  unproven here and phase 2 should prove it early.
- **TrueNAS is staying** (the in-flight migration keeps `email.yaml`, `truenas.yaml`, the Windows GPU
  stacks, and treats docker-utils/portainer as the last off). So the k8s agent **joins** the fleet
  beside the truenas native agent and the MaxAI container; it replaces nothing.

## Phase 1 — one agent pod, Longhorn RWO

### Shape

One Argo CD Application rendering a namespace, an ExternalSecret and a single-replica StatefulSet
with one PVC. No ApplicationSet, no list generator, no per-node anything.

```yaml
# StatefulSet — the parts that carry a decision (sketch)
spec:
  replicas: 1                          # at-most-one is a correctness rule: one manager per store
  serviceName: turma-agent
  updateStrategy: { type: OnDelete }   # never roll an image out from under live sessions
  template:
    spec:
      terminationGracePeriodSeconds: 60
      containers:
        - name: agent
          image: ghcr.io/xerktech/turma-agent:2.1.187-42   # pinned; there is no Watchtower here
          env:
            - { name: DEVICE_NAME,  value: "k8x" }         # the hub card's name; must be stable
            - { name: REPOS_ROOT,   value: "/repos" }
            - { name: MAX_SESSIONS, value: "6" }
            - { name: TURMA_URL,    value: "https://turma.xerktech.com" }
            - { name: IS_SANDBOX,   value: "1" }
            - { name: PUID,         value: "0" }
          envFrom:
            - configMapRef: { name: turma-agent }          # the non-secret config, all of it
            - secretRef:    { name: turma-agent }          # TURMA_TOKEN, JIRA_*, GITLAB_TOKEN
          resources:
            requests: { cpu: "2", memory: 8Gi }
            limits:   { cpu: "8", memory: 32Gi }           # MAX_SESSIONS x session + build headroom
          volumeMounts:
            - { name: data, mountPath: /repos, subPath: repos }
            - { name: data, mountPath: /root,  subPath: home }
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: [ ReadWriteOnce ]
        storageClassName: longhorn
        resources: { requests: { storage: 200Gi } }
```

One PVC with `subPath`s rather than two volumes: `REPOS_ROOT` and `$HOME` are sized against each
other (worktrees dominate both budgets) and always live and die together. The home volume mounts
*over* the image's `/root`; the `gh` credential Secret nests inside it at `/root/.config/gh`.
Nothing the `:latest` tier bakes into `/root` is needed at runtime.

Set **`dataLocality: best-effort`** on the StorageClass (or the volume) so a replica sits on the node
running the pod and reads stay local. This is the single biggest performance lever in phase 1, and it
is the one thing phase 2 gives up.

### Sizing the volume

Repos are 4.3 GB. Worktrees are the budget: 32 GB across 168 of them on a host that has accumulated
99 Turma worktrees. **200 GiB** is comfortable for an agent that clones everything including Veiller;
100 GiB is enough if Veiller stays on truenas. Longhorn usable capacity today is ~2 TB (2 × 2 TB at 2
replicas), so this is a rounding error. Volumes expand online — start smaller and **watch
`.turma/worktrees`, not the repos**.

### Identity and secrets — the part that gets simpler

This is what the ticket owner asked for, and it falls out of having one agent:

- **One `claude` login.** `claude /login` once, into the PVC. It is interactive and manual, and the
  entrypoint idles the container cleanly until it is done.
  **It must not be seeded from a Secret**: `~/.claude/.credentials.json` is rewritten on OAuth
  refresh, and DockerOps' own compose records the consequence — *"Don't run a `claude` session on the
  host while this is up — OAuth refresh-token rotation can invalidate the other copy."* A
  periodically-resynced ExternalSecret would overwrite a token `claude` had already rotated. **One
  agent means this problem does not exist here** — it is the reason a fleet-of-agents design would
  have been annoying, and it is now solved by the shape rather than by a mechanism.
- **One `gh` login.** A Secret containing `hosts.yml` mounted at `/root/.config/gh`. gh OAuth tokens
  do not expire, so this one really is static.
- **One `~/.aws`, `~/.azure`, `~/.terraform.d`.** They live on the PVC exactly as they live on a host
  bind mount today, and the guard's `permissions.deny` rules already protect them from the Edit/Write
  tools (`.claude/rules/agent-hooks.md`) while leaving an explicit `aws sso login` working.
- **The cluster credential is the pod's own ServiceAccount, and there is no kubeconfig anywhere.**
  The agent's job here is to manage `k8x`, so the image now carries `kubectl`, `helm`, `talosctl` and
  `omnictl` (`.claude/rules/agent-image.md`) and the pod runs under a `turma-agent` ServiceAccount
  bound to `cluster-admin`; `entrypoint.sh` turns the projected token into `/root/.kube/config` at
  boot — a convenience rather than the mechanism, since client-go falls back to the in-cluster
  token on its own and what the file adds is a named context and the pod's own namespace. The
  alternative — putting the cluster's `admin@k8x` client certificate in Bitwarden and
  mounting it — was rejected: it is the strongest static credential the cluster has, copying it adds
  a third place to hold it, it cannot be revoked without rotating the cluster PKI, and it expires
  (2027-08-17) with nothing watching. A projected token rotates itself and is revoked by deleting
  one binding.
  - **`talosctl` and `omnictl` get no such treatment** — their credentials are a Talos PKI client
    cert and an Omni service-account key, which no in-cluster identity can stand in for. Those are
    mounted from Bitwarden, read-only, and are the only cluster credentials this pod holds as files.
  - The pod therefore needs `automountServiceAccountToken: true`, unlike the hub beside it.
  - **The token, not the kubeconfig, is the boundary.** Kubernetes projects it 0644, so on a `PUID`
    host every session's uid reads it directly whatever the kubeconfig's mode is — and the guard's
    `permissions.deny` rules cover the file-editing tools only. A session on `k8x` has
    cluster-admin, full stop; treat the pod as an operator's console rather than as a sandbox that
    happens to hold a credential.
- **`DEVICE_NAME` is the agent's whole identity** — it names the hub card, `TURMA_TOKEN` is
  HMAC-bound to it (XERK-268), and it keys the tunnel's control channel. `hub-agent.py` and
  `tunnel-agent.js` must resolve the *same* name or the host gets commands while its terminal and
  live tail are dead (`CLAUDE.md`, the parity contract). Set it explicitly to `k8x`; do not let it
  fall back to the pod hostname, which carries the StatefulSet ordinal.
- Mint the token with `node turma/server.js --agent-token k8x` against the hub's master
  `TURMA_AGENT_TOKEN`, store it in Bitwarden, pull it in with an ExternalSecret. **The master token
  never enters the cluster.**

### What the hub sees — nothing new

An ordinary host: one card, one `capacity` block, its own repos, its own ticket triage, its own peer
roster group. The ticket queue drains into it as slots free (XERK-296), and sessions can be migrated
to and from truenas/MaxAI by the machinery XERK-101 already built. **Triage cost stays at 1×** —
one Jira poll cadence, one triage model run per ticket — which is the other thing a fleet of agents
would have multiplied.

### What breaks with no Docker socket

The image expects `/var/run/docker.sock`; Talos runs containerd and there is none. The entrypoint
already treats it as optional (`if [ -S "$DOCKER_SOCK" ]`), so the agent boots, but:

| Feature | Without the socket | Verdict |
|---|---|---|
| Device-name probe (`docker info .Name`) | falls through to other sources | irrelevant — `DEVICE_NAME` is explicit |
| Host-card log tail (`docker logs`) | empty | cosmetic; `kubectl logs` has it, and the pod's stdout is already there |
| Uptime (`docker inspect .State.StartedAt`) | falls back to the manager's start | cosmetic |
| Hub-initiated container restart | unavailable | correct — in k8s that is `kubectl delete pod` |
| **A session running `docker build` / `docker compose`** | **fails** | **the real one** |

The last matters because the `qa` agent's job is to build and deploy, and this fleet mandates a QA
pass. Options, in the order I would take them:

1. **Route container work away from the k8s agent.** Host routing already prefers a host with the
   repo cloned, so not cloning DockerOps (and anything else whose QA is `docker compose up`) onto
   `k8x` keeps that work on truenas/MaxAI. Zero engineering, and honest about the split.
2. Rootless **buildkit** or **podman** in the image for `docker build`. Solves building, not
   `compose up`.
3. A DinD sidecar — needs privileged, needs a PSA exemption on the namespace. Not worth it.

Also gone: `/dev/kvm`, so the `:emulator` tier is pointless here. `:latest` runs Gradle and unit
tests, which is what android CI actually does.

### Restarts, upgrades, node loss

- **`updateStrategy: OnDelete`.** A rolling update would kill live sessions on an image bump. Argo CD
  syncs the new spec; nothing happens until someone deletes the pod — the same drain-then-restart
  discipline the fleet already uses.
- **A pod restart is survivable, not free.** tmux dies with the pod, so `resume_on_boot` relaunches
  every session with `claude --resume` — conversation, worktree and uncommitted work all preserved on
  the PVC, launches staggered. The adopt-in-place path only covers a *manager* restart, which a pod
  restart is not. **In phase 1 this is fleet-wide for the cluster: one pod restart restarts every
  session on it.** Phase 2 removes exactly that.
- **Node loss needs one Longhorn setting or the resilience claim is false.** A StatefulSet pod on a
  lost node stays `Terminating` indefinitely — Kubernetes will not replace it while it cannot prove
  the old one is gone. Longhorn's **`nodeDownPodDeletionPolicy: delete-statefulset-pod`** is what
  force-deletes it so the volume detaches and the pod reschedules. It is **not** set in
  `apps/longhorn.yaml` today (the default is `do-nothing`), so this is a real change to make there.
  Understand it as a fencing decision: it trades at-most-one for availability, and it is only safe
  because the volume is RWO and Longhorn will not attach it twice.
- **Talos node upgrades** drain nodes; expect the agent to relocate and its sessions to `--resume`.
  Do not add a PodDisruptionBudget that blocks the drain — the resume path is the mitigation.

### The limit of phase 1, stated plainly

**Capacity is one node's worth**, because every session is a process in one pod. `MAX_SESSIONS: 6` at
470–590 MB per `claude` is ~3.5 GB before builds; a Gradle or `npm ci` session adds multiples of
that, which is why the sketch asks for a 32 GiB limit. If that exceeds what a node can spare, phase 1
caps lower than truenas does today — and that, not elegance, is the argument for phase 2.

## Phase 2 — pod per session on a shared Longhorn RWX volume

Same manager, same card, same credentials, same identity. The volume becomes RWX and
`_provision_session()` creates a Pod instead of a tmux.

### Storage

One **Longhorn RWX** volume, mounted at `/repos` and `/root` in the manager and in every session pod.
Everything in the visibility table stays on the manager's own filesystem, which is what keeps the
transcript readers, the archive, the usage scan, the PR scan and `prune` **completely unchanged**.
That is the payoff for accepting a network filesystem, and the reason not to "solve" storage instead
by remoting the transcript reads.

Two mitigations worth building in from the start:

- **Redirect tool caches off the shared volume.** `GRADLE_USER_HOME`, `npm_config_cache`,
  `PIP_CACHE_DIR`, `GOMODCACHE`, `CARGO_HOME` → an `emptyDir` on the session pod's node. These are
  pure caches, they are the heaviest small-file traffic after `node_modules`, and nothing needs them
  to survive the session. `node_modules` itself must stay in the worktree, so it stays on RWX.
- **`gc.auto=0`** on the shared repos, and let `prune` remain the only writer that removes worktrees.
  Concurrent `git fetch` from many sessions already happens on one host today; phase 2 changes the
  protocol underneath it, not the concurrency.

### Why not per-session volumes instead

Tempting — give each session its own Longhorn RWO volume and keep the hot data off NFS — but it does
not work without deep changes:

- `git worktree add` needs the parent repo, so the repo cache has to be in the session pod too:
  either shared anyway, or a full clone per session.
- The manager could no longer read the worktree for the branch chip, the dirty check, or `prune`'s
  removability re-checks — all of which are re-read at removal time on purpose (XERK-256).
- Cloning a 200 GiB cache volume per session is a full data copy in Longhorn, not copy-on-write.

So: shared RWX, or sessions stay in the manager's pod. There is no third option that keeps the
current code honest.

### Code seams

- `_provision_session()` / `spawn()` — the split point; everything below it becomes backend-specific.
- `_launch_tmux`, `_launch_ttyd`, `_kill_ttyd`, `_tmux_alive`, `_alloc_port` — replaced by pod
  create/delete/status. Port allocation disappears: every pod serves ttyd on the same port.
- **Keep tmux inside the session pod.** `_busy_from_capture`, `parse_pane_mode`, `parse_model_picker`
  and the paste path all parse the TUI pane; replacing tmux would invalidate every one of them and
  the `hub-agent.py` ↔ `tunnel-agent.js` parity contract with it. The pod runs tmux + `claude` +
  ttyd, exactly as today — only *reaching* it changes.
- **Pane I/O is the bulk of the work**: 27 `tmux` call sites, 16 of them `send-keys`. Do **not**
  implement them as `kubectl exec` per call — the model-picker and mode loops poll with verification
  between keystrokes, and every beat captures a pane per session. Put a small **shim** in the session
  pod exposing capture/send/paste over HTTP on the pod IP and have the manager call that; keep
  `exec` as the fallback.
- `tunnel-agent.js`'s `openDataChannel(ch, port)` dials `127.0.0.1:<port>` and needs a host too.
  Resolve the session id to a pod IP **agent-side** rather than having the hub send an endpoint, so
  the wire contract stays unchanged.
- `_capacity_payload()` — `MAX_SESSIONS` stops being the truth. Capacity becomes what the namespace
  can schedule (a ResourceQuota, or nodes × allocatable ÷ per-session request). The session queue's
  `capacity` reason maps cleanly onto a Pending pod.
- **Unchanged**: `_session_transcript_path`, usage, PR scan, live agents, history, archive, `prune`.

### What phase 2 actually buys

- **Sessions spread across all three nodes**, so capacity is the cluster's, not one node's.
- **Per-session limits**: a runaway session is OOM-killed alone instead of taking its siblings with
  it — which is also the honest way to hand out `bypassPermissions`.
- **A manager restart stops killing sessions.** Pods outlive the manager the way tmux does today, and
  adoption on boot becomes "list the pods", which is more robust than the tmux adopt path.

### New failure modes to design for

- **The share-manager pod is a fleet-wide SPOF.** Its restart stalls IO for every session until the
  NFS grace period expires. Nothing in phase 1 has this property, and it should be named in the
  runbook rather than discovered.
- **Image pull is session-start latency** — 3.0 GB on a cold node. Pre-pull with a tiny DaemonSet, or
  accept a slow first start per node.
- **Orphaned pods after a manager crash** — reconcile against the registry on boot.
- **Pending pods on a full cluster** — surface as the queue's `capacity` reason, not as a failure.

### The benchmark that gates phase 2

Do not build it on faith. On a Longhorn RWX volume, and on the phase-1 RWO volume as the control:

1. `git status` on a Veiller-sized checkout, cold and warm.
2. `npm ci` (or the repo's real dependency install) end to end.
3. A Gradle build with `GRADLE_USER_HOME` on the shared volume, then on an `emptyDir`, to size the
   cache-redirection mitigation.
4. Peak concurrent sessions before the share-manager saturates.

If RWX lands within ~2× of RWO on 1 and 2, phase 2 is comfortable. If it is 5–10× worse — which is
the plausible outcome for `node_modules`-shaped trees — then the right answer is to **stay on phase 1
and grow it vertically**, and revisit when either CephFS or per-node Longhorn locality changes the
arithmetic.

## Rejected, and why

| Option | Why not |
|---|---|
| **One agent per node (DaemonSet)** | The ticket's "messy" instinct is right: replica count is not a knob, node identity leaks into the deployment, talos04 has no spare disk, and it multiplies credentials — the thing the owner explicitly does not want. |
| **A fleet of per-replica agents** (StatefulSet each, RWO each) | Would give cross-node capacity with **no code change** and no network filesystem — the strongest technical alternative. Rejected on the owner's call: N Turma cards, N Claude logins (which cannot be safely copied — see the refresh-token rotation above), N credential stores, and N× ticket-triage model spend. Revisit only if phase 2's benchmark fails *and* phase 1's vertical capacity is not enough. |
| **TrueNAS NFS for `REPOS_ROOT`** | Ruled out by the owner, and independently: it makes every session depend on a box that reboots for updates, and pointing it at the existing git root would mean two managers over one `REPOS_ROOT` — the corruption case above. |
| **Per-session Longhorn RWO volumes** | Breaks `git worktree`, the branch chip, the dirty check and `prune`; a per-session clone of the cache volume is a full copy. |
| **CephFS (Rook)** | The technically superior shared filesystem, and the right answer if RWX proves too slow — but a second storage system to operate. Recorded as the escalation, not the plan. |
| **An operator with a `TurmaSession` CRD** | `hub-agent.py` is already the reconcile loop; a CRD adds a second writer and buys nothing nobody has asked for. |

## Costs and limits of "the cluster is one agent"

Stated so they are choices:

- **The hub caps one host record at 8 MiB** (`AGENT_RECORD_MAX`) and a heartbeat at 32 MiB. Every
  session on the cluster now rides *one* record. Today's hosts carry ≤6 sessions; a cluster manager
  running 20 concentrates staged history and per-session payload into one record. Watch it, and
  treat a ceiling breach as the signal to split into a second manager (with its own store) rather
  than as a bug.
- **Phase 1 concentrates blast radius**: one pod restart restarts every cluster session. Phase 2
  removes it.
- **One triage, one login, one credential set** — the upside of the same concentration, and the
  reason this shape was chosen.

## What shipped, and where

Phase 1 is split across two repos, because the image and the workload live in different ones:

- **`xerktech/Turma`** — the cluster CLIs in `agent/Dockerfile`, the in-cluster kubeconfig and the
  cluster-creds preflight in `agent/entrypoint.sh`, and `Edit(~/.kube/**)` / `Edit(~/.talos/**)` /
  `Edit(~/.config/omni/**)` on the guard's deny list.
- **`xerktech/ArgoCD`** — `ai/turma-agent/`: the ConfigMap holding every non-secret setting, the
  ExternalSecret holding the rest, the ServiceAccount and its binding, and the StatefulSet. It is a
  second Application in the `turma` namespace beside the hub, at its own path, for the reason
  `apps/turma.yaml` already records: an Application's `path:` is not recursive.

## Next steps

1. Namespace `turma`, ExternalSecret, and the phase-1 Application in `xerktech/ArgoCD`.
2. Mint the `k8x` host token against the hub's master and put it in Bitwarden.
3. Add `nodeDownPodDeletionPolicy: delete-statefulset-pod` and a `dataLocality: best-effort`
   StorageClass to `apps/longhorn.yaml` (cross-repo contract in `.claude/rules/longhorn.md`).
4. Sync; `claude /login` and `gh auth login` into the pod once each.
5. Clone one small repo, run a real ticket end to end, and confirm the card, the terminal, the live
   tail, PR chips and the archive all behave.
6. **Run the phase-2 benchmark** (above) on a scratch RWX volume before committing to any of the
   phase-2 code.

## Open questions

- **Node RAM/CPU for talos02/03/04** is not recorded in `xerktech/Talos`, and phase 1's capacity is
  exactly one node's spare memory. The 32 GiB limit in the sketch is derived from the measured
  session footprint, not from what a node can give.
- **Does the hub move into `k8x` too?** If so the agent can reach it over a ClusterIP Service rather
  than the Cloudflare tunnel. The hub's memory ceilings derive from its cgroup limit
  (`containerMemoryLimit()`, XERK-258), so a k8s `resources.limits.memory` behaves exactly like
  `mem_limit` — but it must be *set*, or the ceilings read the whole node's memory.
- **Which repos never get cloned onto `k8x`** — the Docker-dependent ones, decided deliberately
  rather than discovered by a QA agent that cannot build.
