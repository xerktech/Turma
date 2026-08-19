# Running Turma agents on Kubernetes — design (XERK-369)

**The ticket asks for a design, not an implementation.** It proposes an operator that starts a
container per session, worries about repo storage that has to be reachable from every node, and
asks whether one persistent agent per node would be better even though that "feels more messy".

This is the answer, the evidence behind it, and the design for what to build.

## The recommendation in one page

**Build one agent per *replica*, not one per node, and do not build an operator yet.**

- A Turma agent is deployed as a **StatefulSet of one pod**, one per fleet host you want, rendered
  by an Argo CD **ApplicationSet** list generator. Each agent gets its **own Longhorn RWO PVC**
  holding its `REPOS_ROOT` and its `$HOME`. Adding an agent is a list entry; removing one is
  deleting it. Nodes stay interchangeable — no `hostPath`, no node affinity, no per-node config.
- **Repo storage is per-agent and persistent, not shared and cross-node.** "Don't re-clone every
  time" is a *persistence* requirement, and a PVC satisfies it. Nothing in the fleet model requires
  two agents to see one checkout, and the moment two of them do, one's `prune` deletes the other's
  worktrees.
- **The operator + pod-per-session design is real and worth building later**, but only once
  per-session isolation is the priority. It is written up in full in "Phase 2" below, together with
  the price nobody quotes: it forces `REPOS_ROOT` and `~/.claude` onto shared network storage, and
  everything a session does — `git status`, `npm install`, `gradle build` — is small-file latency
  bound. That is the wrong thing to put on NFS.
- **No hub changes and no agent code changes are needed for phase 1**, beyond deployment plumbing.
  Each replica is an ordinary fleet host: it heartbeats, it takes tickets from the hub's queue, and
  sessions can be migrated between it and any other host by the machinery XERK-101 already built.

The ticket's instinct that "one agent per node feels messy" is right about *nodes* and wrong about
*agents*. Coupling an agent to a node is what makes it messy: it means node-local storage, node
affinity, a DaemonSet whose replica count you cannot choose, and a node reimage that takes an
agent's repos with it. Decouple the agent from the node and the messiness goes away while the
model — a fleet of hosts the hub already knows how to schedule across — stays exactly as it is.

## What the pieces actually are

Read `CLAUDE.md` ("Session Model") and `.claude/rules/agent.md` first. What matters here:

- **An agent is two processes**, `hub-agent.py` (session manager + heartbeat) and `tunnel-agent.js`
  (one reverse tunnel per host), both **outbound-only** to `TURMA_URL`. Nothing connects *to* an
  agent. In k8s that means no Service, no Ingress, no NetworkPolicy for the terminal path.
- **An agent's identity is its host name**, and it is proved by a credential bound to that name
  (`<base64url(device)>.<HMAC(TURMA_AGENT_TOKEN, device)>`, XERK-268). Identity must therefore be
  **stable across restarts** — which is why the agent is a StatefulSet and not a Deployment.
- **A session is a git worktree + a tmux + a ttyd + a `claude` process** inside the agent. The
  manager drives the session through the pane (`send-keys`, `capture-pane` — 27 `tmux` call sites)
  and serves its terminal from `127.0.0.1:<ttydPort>`, which `tunnel-agent.js` bridges.
- **Everything the hub displays is read off the filesystem by the manager**: transcripts under
  `~/.claude/projects/<slug>/<id>.jsonl` (busy state, usage, PR chips, live subagents, history,
  archive) and the worktree's own git state (branch, dirty, prune eligibility).

That last point is the load-bearing one. **Four things must be visible, at the same absolute path,
to whatever process is doing the work:**

| | Written by | Read by | Notes |
|---|---|---|---|
| `REPOS_ROOT` (repos + `.turma/worktrees`) | session, manager | manager every beat | a worktree's `.git` holds an absolute `gitdir:` path, and the repo holds an absolute path back. Both must resolve, identically, in every container that touches either. |
| `~/.claude/projects` | session's `claude` | manager every beat | the transcript is the only source for busy/usage/PR/agents/history |
| `~/.claude/.credentials.json`, `~/.claude.json` | `claude` (OAuth refresh) | every session | one login per agent — see below |
| `~/.turma` | manager | sessions (`--settings` guard file, uploads, `peers.tsv`) | the registry, ledgers and the guard settings every launch passes |

A topology is only viable if it satisfies that table. That single constraint is what decides
between "agent per replica" and "operator + pod per session" — not preference.

## Measured facts (truenas, 2026-08-19)

Sizing guesses are the usual way these designs go wrong, so these are measurements from the running
fleet rather than estimates:

| | |
|---|---|
| A live `claude` session | **470–590 MB RSS** (4 concurrent sessions sampled) |
| Every repo in `REPOS_ROOT`, with history | **4.3 GB** total; Veiller alone is 3.8 GB |
| Worktrees | **32 GB across 168 worktrees** — Veiller 22 GB, Tenir 5.1 GB, Turma 4.7 GB across 99 |
| `~/.claude` | 266 MB, of which 183 MB is 718 transcript slugs |
| Heartbeat cadence | 20 s (`TURMA_INTERVAL`), one `capture-pane` + transcript read per session per beat |
| Agent image `:latest` | 3.0 GB (the `android-build` tier) |
| MaxAI's sizing today | `MAX_SESSIONS: 6`, `mem_limit: 16g`, `cpus: 6.0` |

The worktrees, not the repos, are the disk. Almost all of it is build output and dependencies
(`node_modules`, Gradle caches), which is also why it is the thing you least want on a network
filesystem.

## Cluster facts that constrain this (`k8x`)

From `xerktech/Talos` and the in-flight k8s migration work in `xerktech/ArgoCD`:

- **Three nodes, all control-plane**, scheduling enabled: talos02/03/04. Talos v1.13.8, Kubernetes
  v1.36.2.
- **Only talos02 and talos03 have storage.** They each contribute a spare 2 TB NVMe to Longhorn via
  the `longhorn-storage` role; talos04 has no spare disk and contributes none. Any Longhorn volume
  therefore has its replicas on two of three nodes.
- **The lab's storage convention is already decided**: Longhorn is the default class for
  cluster-owned state at 2 replicas, and pre-existing TrueNAS datasets are consumed as **static NFS
  PVs via `csi-driver-nfs`** (nfsvers=4.1, `storageClassName: ""`, Retain). **Longhorn RWX is not
  used.** A design that needs RWX has to justify introducing it.
- **Everything is GitOps**: Argo CD app-of-apps out of `xerktech/ArgoCD`, secrets via
  ExternalSecrets from Bitwarden Secrets Manager. Nothing is deployed by hand, and Talos'
  `inlineManifests` bootstrap is create-once — it is not where a workload goes.
- **Pod Security Admission is Talos' generated default** (baseline enforced outside `kube-system`).
  Phase 1 needs nothing baseline forbids: no `hostPath`, no privileged, no host network. Running as
  root is allowed under baseline, which matters because the image runs sessions as root with
  `IS_SANDBOX=1` so `bypassPermissions` is permitted.
- **TrueNAS is staying.** The migration explicitly keeps `email.yaml`, `truenas.yaml`, the Windows
  GPU stacks, and treats docker-utils/portainer as the last things off. So a k8s agent **joins** the
  fleet beside the truenas native agent and the MaxAI container; it replaces nothing.

## The three topologies

### A. One agent per node — DaemonSet

The literal reading of "1 persistent agent per node". Each node runs an agent with node-local
storage (a Longhorn strict-local volume or a `local-path` PVC).

- **For**: native NVMe under every git operation and every build. No shared storage anywhere.
- **Against**: replica count is not a knob — it is however many nodes you have, and one of them
  (talos04) has no spare disk. Node identity leaks into the deployment (per-node PVCs, node
  affinity, a node reimage takes an agent's repos with it). Talos node upgrades reboot nodes, and a
  DaemonSet pod does not go anywhere else while it waits.
- **Verdict**: this is the topology the ticket calls messy, and the mess is real — but it comes from
  the node coupling, not from "one persistent agent".

### B. One agent per replica — StatefulSet + Argo CD ApplicationSet  ← **recommended**

Each agent is its own single-replica StatefulSet with its own RWO Longhorn PVC. Which node it lands
on is the scheduler's business; the volume follows the pod.

- **For**: everything phase-1 needs, with **no agent code change**. Elastic capacity: the hub's
  ticket queue already picks the host at dispatch (`CLAUDE.md`, XERK-296), so adding an agent adds
  capacity the queue immediately drains into. Resilience: the PVC is Longhorn-replicated across
  talos02/03, so a pod restart or a node loss brings the agent back elsewhere with its worktrees,
  its uncommitted work and its transcripts intact, and `resume_on_boot` relaunches every session
  with `claude --resume`. Fewer moving parts: one Argo CD app, no hand-run containers, no per-host
  systemd install.
- **Against**: repos are duplicated per agent (~4.3 GB of repos, and realistically 50–150 GB of
  worktrees each — see sizing). No per-session resource isolation: one runaway session can still
  OOM its agent and take its siblings with it, exactly as today. Every agent triages tickets
  independently, which costs N× Jira polls and N× triage model runs (see "Costs that scale with
  agent count").
- **Verdict**: buys the three things this ticket is actually for — elastic capacity, resilience,
  fewer moving parts — at close to zero engineering cost.

### C. Operator + one pod per session

The ticket's preferred shape. A controller watches desired sessions and creates a Pod per session.

- **It requires shared storage, and that is not a detail.** With sessions in their own pods, the
  manager can no longer see the worktree it must run `git status` against, the transcript it reads
  every beat, or the guard settings file it writes for the launch. Either all four rows of the
  table above move onto an RWX volume mounted at an identical path in every pod, or every one of
  those reads becomes a remote call. Under the lab's decided storage convention, RWX means **NFS
  from TrueNAS** — so every `git status`, every `npm install`, every Gradle build in the cluster
  goes over NFS to the box this design was partly meant to stop depending on.
- **It does not need a CRD, and probably should never have one.** `hub-agent.py` is already a
  reconcile loop over desired state: the hub sends commands, the registry is the desired state, and
  `_provision_session()` reconciles. A `TurmaSession` CRD would duplicate that loop and put a second
  writer beside it. Nothing else in the cluster needs to create Turma sessions declaratively, which
  is the only thing a CRD would buy. If it is ever wanted, the seam is `_provision_session()`.
- **What it genuinely buys**: per-session cgroups and limits (a runaway session dies alone), a
  per-session network policy, and a real sandbox boundary — which is also the honest way to hand out
  `bypassPermissions`. Plus manager restarts become free: pods outlive the manager the way tmux does
  today, and adoption becomes "list the pods".
- **Verdict**: the right destination *if* isolation becomes the goal. It is not what this ticket
  asked for — elastic capacity, resilience and fewer moving parts were the stated priorities, and B
  delivers all three without moving a single byte of git onto NFS.

### The rule underneath all three

**Sharing a `REPOS_ROOT` requires exactly one manager.** Two managers over one checkout is not a
performance question, it is corruption: `prune` removes worktrees that are merged and not backing a
*live* session, and it re-reads liveness from **its own** registry (`.claude/rules/agent.md`). The
other manager's sessions are not in it. Both would also allocate worktree directories and mutate
`.git/worktrees/` metadata concurrently.

So: **one manager ⇒ sharing is safe and pod-per-session is reachable. N managers ⇒ N separate
checkouts, full stop.** That is why the storage question and the topology question are the same
question, and why "shared repo storage across all nodes" and "an agent per node" cannot both be
true.

## Storage: the argument, and the answer

Requirements, in order of how hard they bind:

1. A worktree and its repo must resolve each other's absolute paths inside every container that
   touches them. Fix the mount at `/repos` everywhere and this is satisfied by construction.
2. Whatever holds `REPOS_ROOT` must survive a pod restart, or every restart re-clones — the ticket's
   stated concern.
3. It must be fast at small-file operations. This is the requirement that gets ignored. The
   workload is `git status` over 100k files, `npm install`, `gradle build` — latency per file, not
   throughput.
4. It must not be shared between two managers (above).

| Option | Verdict |
|---|---|
| **Longhorn RWO, one volume per agent** | **Recommended.** Meets 1–4. Replicated across talos02/03, so it survives a node loss. Set `dataLocality: best-effort` so a replica sits on the node running the pod and reads stay local. Duplicates repos per agent — which costs disk, and disk is the cheap resource here. |
| NFS from TrueNAS (`csi-driver-nfs`, the lab's decided pattern for existing datasets) | Rejected **for `REPOS_ROOT`**. Fails 3 badly, and makes every session on the cluster depend on a box that reboots for updates. Correct for read-mostly bulk data, which this is not. Also tempting *because* the repos already live there — but that would be sharing one `REPOS_ROOT` with the truenas native agent, which is exactly the two-manager corruption above. |
| Longhorn RWX | Rejected. It is NFS-ganesha behind a share-manager pod, so it inherits the latency problem *and* adds a per-volume pod whose restart stalls every session — and the lab has already decided against RWX. |
| Node-local (`local-path` / Longhorn strict-local) | Rejected for the recommended topology. Fastest, but it pins the agent to a node (topology A) and loses the resilience this ticket asked for. Reasonable as a *build cache* later if measurement demands it. |

### Sizing a per-agent volume

Repos 4.3 GB + worktrees. Worktrees on truenas are 32 GB across 168 of them, but that is a host that
has accumulated 99 Turma worktrees; an agent running `MAX_SESSIONS: 4` with `prune` doing its job
holds far fewer. Budget:

- **150 GiB per agent** for a general agent that clones everything, or **60 GiB** for one restricted
  to small repos (i.e. not Veiller, whose worktrees are 22 GB by themselves).
- Longhorn usable capacity is ~2 TB (2 × 2 TB NVMe at 2 replicas), so 3 agents at 150 GiB is ~450
  GiB of that — under a quarter, with the rest available to the rest of the migration.
- Volumes can be expanded later; Longhorn supports online expansion. Start smaller rather than
  bigger, and **watch `.turma/worktrees` rather than the repos**.

## Phase 1: the design to build

### Shape

One Argo CD `ApplicationSet` with a **list generator**, one entry per agent, each rendering a
single-replica `StatefulSet` + PVC + ExternalSecret. One entry per agent, rather than one
StatefulSet with N replicas, because each agent needs **its own secret** (its host-bound
`TURMA_TOKEN`) and can want its own `MAX_SESSIONS` and volume size — none of which a replica count
expresses.

```yaml
# xerktech/ArgoCD — apps/turma-agents.yaml (sketch)
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
spec:
  generators:
    - list:
        elements:
          - name: k8x-a
            maxSessions: "4"
            storage: 150Gi
          - name: k8x-b
            maxSessions: "4"
            storage: 150Gi
  template:
    spec:
      source:
        path: turma-agent          # a small chart/kustomization, parameterised by the element
        helm: { parameters: [ { name: agent.name, value: '{{name}}' } ] }
      destination: { namespace: turma }
```

```yaml
# StatefulSet, the parts that carry a decision (sketch)
spec:
  replicas: 1                      # identity is the token binding; at-most-one is a correctness rule
  serviceName: turma-agent-{{name}}
  updateStrategy: { type: OnDelete }   # never roll an agent out from under live sessions
  template:
    spec:
      terminationGracePeriodSeconds: 60
      containers:
        - name: agent
          image: ghcr.io/xerktech/turma-agent:2.1.187-42   # pinned; Watchtower does not exist here
          env:
            - { name: DEVICE_NAME,  value: "{{name}}" }    # the hub card's name; must be stable
            - { name: REPOS_ROOT,   value: "/repos" }
            - { name: MAX_SESSIONS, value: "{{maxSessions}}" }
            - { name: TURMA_URL,    value: "https://turma.xerktech.com" }
            - { name: IS_SANDBOX,   value: "1" }
            - { name: PUID,         value: "0" }
            - { name: TZ,           value: "America/New_York" }
          envFrom:
            - secretRef: { name: turma-agent-{{name}} }    # TURMA_TOKEN, JIRA_*, GITLAB_TOKEN
          resources:
            requests: { cpu: "2",  memory: 6Gi }
            limits:   { cpu: "6",  memory: 20Gi }
          volumeMounts:
            - { name: data, mountPath: /repos,  subPath: repos }
            - { name: data, mountPath: /root,   subPath: home }
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: [ ReadWriteOnce ]
        storageClassName: longhorn
        resources: { requests: { storage: "{{storage}}" } }
```

One PVC with `subPath`s rather than two volumes: `REPOS_ROOT` and `$HOME` are sized against each
other (worktrees dominate both budgets) and always live and die together. `HOME` stays `/root` —
`.claude/rules/agent-image.md`'s invariant, and every mount target depends on it — so the home
volume mounts *over* the image's `/root`, and the `gh` Secret nests inside it at
`/root/.config/gh`. Nothing the `:latest` tier bakes into `/root` is needed at runtime (only the
`:emulator` tier's `/root/.android` would be hidden, and that tier is useless here anyway).

### Identity and secrets

- **`DEVICE_NAME` is the agent's whole identity.** It names the hub card, it is what `TURMA_TOKEN`
  is HMAC-bound to (XERK-268), and it keys the tunnel's control channel — `hub-agent.py` and
  `tunnel-agent.js` must resolve the *same* name or the host gets commands while its terminal and
  live tail are dead (`CLAUDE.md`, the parity contract). Set it explicitly from the ApplicationSet
  element; do not let it fall back to the pod hostname, which carries the StatefulSet ordinal.
- Mint each agent's token with `node turma/server.js --agent-token <device>` against the hub's
  master `TURMA_AGENT_TOKEN`, store it in Bitwarden, and pull it in with an ExternalSecret. Same
  path for `JIRA_TOKEN`/`GITLAB_TOKEN`. **The master token never enters the cluster.**
- `gh` auth: mount a Secret containing `hosts.yml` at `/root/.config/gh`. gh OAuth tokens do not
  expire, so this is genuinely static and can be shared by every agent.

### The Claude login is the one credential that must be per-agent

`~/.claude/.credentials.json` is an OAuth token that **`claude` rewrites on refresh**, and DockerOps'
own compose already records the consequence: *"Don't run a `claude` session on the host while this
is up — OAuth refresh-token rotation can invalidate the other copy."* Two agents seeded from one
copied credentials file will fight, and the loser stops working at a moment nobody is watching.

So: **`claude /login` once per agent, into its PVC.**

```
kubectl -n turma exec -it turma-agent-k8x-a-0 -- claude /login
```

Consequences to accept: it is an interactive, manual step per agent (the agent idles cleanly until
it is done — the entrypoint's creds preflight is built for exactly this), and it is the one thing
that makes agents *not* cattle. Do not "fix" it by baking the credentials into an ExternalSecret:
a periodically-resynced ExternalSecret would overwrite a token `claude` had already rotated.

`~/.claude.json` (account/org info Remote Control needs) lives on the same volume and is written by
the same login.

### What the hub sees — nothing new

Each agent is an ordinary host: a card, a `capacity` block, its own repos, its own ticket triage,
its own peer roster rows. That means, with no hub work at all:

- **The ticket queue balances across them.** A queued ticket has no host until dispatch, so whichever
  agent frees a slot first takes the oldest waiting ticket (XERK-296).
- **Sessions can be rebalanced by hand** with the existing migration (XERK-101) — the target must
  already have the repo cloned.
- **Both new agents will be un-eligible for tickets until they have triaged them** (`hostTriagedTicket`,
  XERK-325). Expect a lag of one `JIRA_REFRESH_EVERY` (~10 min) plus a triage run after an agent
  first comes up, and after each new repo it clones.

### What breaks in a container with no Docker socket

The image expects `/var/run/docker.sock`. Talos runs containerd and there is no socket to mount.
The entrypoint already treats it as optional (`if [ -S "$DOCKER_SOCK" ]`), so the agent boots — but
four things degrade, and they should be known rather than discovered:

| Feature | Behaviour without the socket | Verdict |
|---|---|---|
| Device-name probe (`docker info .Name`) | falls through to other sources | irrelevant — `DEVICE_NAME` is set explicitly |
| Container log tail on the host card (`docker logs`) | empty tail | cosmetic; the real fix is `kubectl logs`, and the pod's own stdout is already there |
| Uptime (`docker inspect .State.StartedAt`) | falls back to the manager's own start | cosmetic |
| Hub-initiated container restart | unavailable | correct: in k8s that is `kubectl delete pod`, and the StatefulSet does the rest |
| **A session running `docker build` / `docker compose`** | **fails** | **this is the real one** |

The last one matters because the `qa` agent's whole job is to build and deploy a change, and this
fleet mandates a QA pass. On Talos there is no dockerd for a session to talk to. Options, in the
order I would take them:

1. **Route container work away from the k8s agents.** Host routing already prefers a host with the
   repo cloned, so simply not cloning DockerOps (and anything else whose QA is `docker compose up`)
   onto a k8s agent keeps that work on truenas/MaxAI. Zero engineering, and it is honest about the
   split.
2. Rootless **buildkit or podman** in the image for `docker build` specifically. Solves building,
   not `docker compose up`.
3. A DinD sidecar. Needs privileged, which needs a PSA exemption on the namespace. Not worth it for
   this.

Also gone: `/dev/kvm`, so the `:emulator` image tier is pointless here. `:latest` (android-build)
runs Gradle and unit tests fine, which is what android CI actually does.

### Restarts, upgrades and node loss

- **`updateStrategy: OnDelete`.** A rolling update would kill live sessions on an image bump. With
  `OnDelete`, Argo CD syncs the new spec and nothing happens until an operator deletes the pod —
  which is the same "drain then restart" discipline the fleet already uses. Pin the image tag; there
  is no Watchtower here.
- **A pod restart is survivable, not free.** tmux dies with the pod, so `resume_on_boot` relaunches
  each session with `claude --resume` — conversation preserved, worktree and uncommitted work
  preserved on the PVC, launches staggered. The adopt-in-place path (`.claude/rules/agent.md`) only
  helps a *manager* restart, which is not what a pod restart is.
- **Node loss needs one Longhorn setting to be honest about resilience.** A StatefulSet pod on a
  lost node stays `Terminating` indefinitely — Kubernetes will not create a replacement while it
  cannot prove the old one is gone. Longhorn's `nodeDownPodDeletionPolicy`
  (`delete-statefulset-pod`) is what force-deletes it so the volume detaches and the pod
  reschedules. **Without that setting the resilience claim in this document is false**, so set it
  deliberately and understand it as a fencing decision: it trades at-most-one for availability, and
  it is only safe because the volume is RWO and Longhorn will not attach it twice.
- **Talos node upgrades** drain nodes. Expect an agent to relocate and its sessions to `--resume`.
  Do not add a PodDisruptionBudget that blocks the drain; the resume path is the mitigation.

### Costs that scale with agent count

Worth stating because they argue for **few, larger agents** rather than many small ones:

- Each agent polls Jira independently (~10 min) and runs its **own triage model pass** per ticket.
  Three agents means three times the triage token spend for the same board.
- Each agent clones its own copy of every repo it triages.
- Each agent needs its own `claude /login` and its own subscription usage against the same account.
- Each agent is another card, another peer-roster group, another archive contributor.

Start with **two** agents at `MAX_SESSIONS: 4` (8 slots, ~2 GB of `claude` RSS each before builds)
and scale by editing the list. That is roughly the current MaxAI host's capacity, spread across two
failure domains.

## Phase 2: operator + pod per session, if isolation becomes the priority

Written up so the decision is a choice rather than a rediscovery.

### Shape

Keep **one manager** (the same StatefulSet, one replica) and give it a second session-runtime
backend: instead of `tmux` + local `ttyd`, it creates a **Pod per session**. The manager remains the
reconciler — no CRD, no second controller — because it already holds desired state and the hub
already drives it.

### Seams in the code

- `_provision_session()` / `spawn()` — the split point. Everything below it becomes backend-specific.
- `_launch_tmux`, `_launch_ttyd`, `_kill_ttyd`, `_tmux_alive`, `_alloc_port` — replaced by pod
  create/delete/status. Port allocation disappears: every pod serves ttyd on the same port.
- **Pane I/O is the bulk of the work**: 27 `tmux` call sites, of which 16 are `send-keys`, plus
  `capture-pane` feeding `_busy_from_capture`, `parse_pane_mode`, `parse_model_picker` and the
  paste path (`_type_into_pane`). Do **not** implement these as `kubectl exec` per call — the
  model-picker and mode loops poll with verification between keystrokes. Put a small **shim** in the
  session pod exposing capture/send/paste over HTTP on the pod IP, and let the manager call that.
- `tunnel-agent.js`'s `openDataChannel(ch, port)` dials `127.0.0.1:<port>`; it needs a host as well
  as a port. That is a small change, but it is on the `hub-agent.py` ↔ `tunnel-agent.js` parity
  contract's edge — the hub sends `{open, port}` today, so the *hub* would have to send an endpoint
  too, or the agent resolves the session id to a pod IP itself. Prefer the latter: it keeps the wire
  contract unchanged.
- `_capacity_payload()` — `MAX_SESSIONS` stops being the truth; capacity becomes what the namespace
  can schedule (a ResourceQuota, or nodes × allocatable ÷ per-session request).
- **Unchanged**: everything that reads transcripts (`_session_transcript_path`, usage, PR scan,
  agents, history, archive), because the shared `~/.claude` keeps it on the manager's own filesystem.
  That is the payoff for accepting shared storage, and the reason not to "solve" storage by remoting
  the transcript reads instead.

### The price

- **`/repos` and `/root/.claude` become RWX.** Under the lab's convention that is TrueNAS NFS: every
  git operation and every build in the cluster crosses it, and TrueNAS becomes a hard dependency of
  every session. Measure before committing — clone Veiller onto the candidate volume and time
  `git status` and a full `npm install` against the same on Longhorn RWO.
- The guard settings file, uploads dir, `peers.tsv` and the local-model env file all live on that
  shared volume and are read by every session pod — the same exposure as today within one host, now
  spread across pods.
- Pods need the same `~/.claude` login, so the per-agent login rule becomes a per-*cluster* one.
- New failure modes to design for: pod pending on a full cluster (which is the session queue's
  `capacity` reason, so it maps cleanly), image pull time on a cold node (3.0 GB) as session start
  latency, and orphaned pods after a manager crash (reconcile against the registry on boot — which
  is strictly better than today's tmux adoption).

### When to revisit

Build phase 2 when **any** of these is true, and not before:

- A runaway session has OOM-killed an agent and taken its siblings with it more than once.
- You want `bypassPermissions` sessions with a real boundary rather than a container-shaped one.
- Session count outgrows what two or three fixed agents can hold, and per-agent tuning has become
  the bottleneck.

## What I would do next

1. **Decide the agent count and names** (suggest two: `k8x-a`, `k8x-b`).
2. Mint two host-bound tokens against the hub's master and put them in Bitwarden.
3. Write `apps/turma-agents.yaml` + the chart in `xerktech/ArgoCD`, per the sketches above.
4. Sync, then `claude /login` into each pod once.
5. Clone one small repo onto each and run a real ticket end to end; confirm the card, the terminal,
   the live tail, PR chips and the archive all behave.
6. **Measure the two numbers this design is betting on**: `git status` and a dependency install on a
   Longhorn RWO volume versus the truenas ZFS baseline, and peak RSS for `MAX_SESSIONS` concurrent
   sessions. Both feed straight back into the sizing above.
7. Decide the Docker-dependent-repo split explicitly (option 1 above) and write it down, rather than
   letting it be discovered by a QA agent that cannot build.

## Open questions

- **Node RAM/CPU on talos02/03/04** is not recorded in `xerktech/Talos`. The resource requests above
  are derived from the measured session footprint, not from what the nodes can spare. Two agents at
  `limits: 20Gi` need a node that can actually hold one.
- **Does the hub move into `k8x` too?** If it does, agents can reach it over a ClusterIP Service
  instead of the Cloudflare tunnel. The hub's memory ceilings derive from its cgroup limit
  (`containerMemoryLimit()`, XERK-258), so a k8s `resources.limits.memory` works exactly like
  `mem_limit` does today — but it must be *set*, or the ceilings read the node's memory.
- **Subscription limits across more agents.** More agents on one Claude account means the same
  ceiling spread across more hosts; the fleet's own subscription-limit reporting
  (`.claude/rules/agent-usage.md`) is the place to watch it.
