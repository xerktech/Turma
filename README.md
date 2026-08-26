# Turma

**Turma** — /TUR-mah/, like the start of *terminal* — from the Latin *turma*, "a cavalry squadron": a small
troop of riders that fights as one unit.

Run a fleet of [Claude Code](https://claude.ai/code) agents across your own
machines, and drive them from one dashboard — in a browser, on your phone, or on
a pair of smart glasses.

Point Turma at a directory of git repos on any machine. It finds the repos, and
from the dashboard you spawn a Claude Code session against any of them. Each
session gets its own git worktree, so a dozen can run at once — on one repo or
many — without treading on each other. You watch them work, answer their
questions, stop a turn that's going wrong, and collect the PRs they open.

Agents connect **outbound only**. A laptop, a NAS, and a WSL box behind three
different NATs join the same fleet with no port forwarding, no static address,
and nothing inbound exposed.

```
                    ┌──────────────┐
   browser ───────► │              │ ◄──── outbound ──── agent @ NAS      (repos)
   phone   ───────► │  turma hub   │ ◄──── outbound ──── agent @ WSL box  (repos)
   glasses ───────► │  :8300       │ ◄──── outbound ──── agent @ laptop   (repos)
                    └──────────────┘
                       archive
```

## Components

| | What it is | Where it runs |
|---|---|---|
| **`agent/`** | One [native install](agent/native/README.md) per host (systemd + a shipped tarball), mounted at a git root. Scans it for repos and multiplexes many worktree-backed Claude Code sessions, each in its own tmux + loopback ttyd. Heartbeats state; carries terminals and live transcripts back over one outbound tunnel. | Every machine with repos |
| **`turma/`** | The hub: dashboard, terminal gateway, and durable searchable archive of every ended session. Node **stdlib only** — zero npm dependencies. | Once, anywhere reachable |
| **`glasses/`** | An [Even Realities G2](https://www.evenrealities.com/) smart-glasses client (Vite + TypeScript). Sessions, transcripts, question answering, and mic dictation. | Even Hub plugin |
| **`android/`** | Native Android client (Kotlin + Compose). Everything the web dashboard does, plus push notifications and voice. | Phone |

Full architecture, the session model, and the design rationale behind each piece
live in [`CLAUDE.md`](CLAUDE.md).

## Quick start

The fastest path: **the hub on one machine, plus one native agent on it.** The
hub runs as a container; the agent runs **natively** on each host it manages.

**Prerequisites.** Docker with the Compose plugin (for the hub), a directory of
git repos, and — on each agent host — git, node, python, and a logged-in Claude
Code:

```sh
claude /login    # required — a subscription OAuth login, not a setup token
gh auth login    # optional; needed for private repos and `gh pr create`
```

The agent **reuses that host login** and never logs in itself — no API key.
Without it the agent runs and idles, waiting.

**1. Start the hub.**

```sh
git clone https://github.com/xerktech/turma.git
cd turma/examples/compose
cp .env.example .env
$EDITOR .env     # set the two secrets (TURMA_PASSWORD, TURMA_AGENT_TOKEN)

docker compose -f hub.yaml up -d
```

Open <http://localhost:8300> and log in with the `TURMA_USER` / `TURMA_PASSWORD`
you set.

> **Heads up:** `ghcr.io/xerktech/turma` is not yet published for anonymous
> pulls, so the hub image may fail with `unauthorized`. Until it is, build it
> locally — everything else is the same:
> ```sh
> docker build -t ghcr.io/xerktech/turma:latest ../../turma
> ```

**2. Install the agent natively** on the host with your repos. It fetches the
latest native release, verifies its checksum, and installs a systemd user
service — no checkout needed:

```sh
curl -fsSL https://raw.githubusercontent.com/xerktech/turma/main/agent/native/bootstrap.sh | bash
```

Then edit `~/.config/turma-agent/turma-agent.env` — set `TURMA_URL` to the hub,
`REPOS_ROOT` to your git root, and `TURMA_TOKEN` to this host's own agent token
(`node turma/server.js --agent-token <device-name>`, run on the hub). Options
pass through after `-s --`:

```sh
curl -fsSL .../bootstrap.sh | bash -s -- --autostart
curl -fsSL .../bootstrap.sh | bash -s -- --verify     # files, tools, config, service, login
```

From a checkout, `cd agent/native && ./install.sh` does the same thing. Full
detail is in [`agent/native/README.md`](agent/native/README.md).

Your host then appears in the dashboard with its repos under it. Pick one, hit
**+ New session**, and you land in the session.

### Going wider

To add a machine, install the agent natively on it (step 2 above), point
`TURMA_URL` at the hub's public URL, give it a distinct `DEVICE_NAME`, and give
it **its own** agent token — `node turma/server.js --agent-token <that device
name>`, run on the hub, prints it. Because agents dial out, that machine needs no
inbound exposure — only the hub does. Put the hub behind TLS (a reverse proxy or
a Cloudflare tunnel) before exposing it: the login is single-user HTTP Basic and
should not cross the internet in the clear.

The one compose file, [`hub.yaml`](examples/compose/hub.yaml), and its
[`.env.example`](examples/compose/.env.example), are commented in full; the three
things worth knowing up front:

- **Every hub auth check fails *open* when its variable is unset**, warning at
  boot rather than refusing to start. `TURMA_PASSWORD` unset means an
  unauthenticated dashboard; `TURMA_AGENT_TOKEN` unset means anyone can
  heartbeat. Set both. Generate the token with `openssl rand -hex 32`.
- **`TURMA_AGENT_TOKEN` is the fleet MASTER, and no agent should hold it.** Each
  agent gets only its own derived token (`node turma/server.js --agent-token
  <device>`) as its `TURMA_TOKEN`; the hub re-derives it to check that the host
  a request names is the host its credential is for. Handing every agent the
  master instead still works — it is what a fleet mid-rollover looks like — but
  then any agent can act as any other, so set **`TURMA_AGENT_STRICT=1`** on the
  hub once every agent has rolled over, and the master stops being accepted.
- **The hub's `/data` volume must persist.** It holds the archive — the
  transcript history of every ended session, plus a byte-for-byte copy of each
  session's own files beside it. The search index inside it is disposable and
  rebuilds from the files; the files are not.

It self-updates from the release stream afterwards without stopping running
sessions. See [`agent/native/README.md`](agent/native/README.md).

## Clients

Both clients talk to the hub over HTTP Basic and are configured with a hub URL
at their login screen. **Get the hub running first** — neither is useful without
one.

### Glasses (`glasses/`)

```sh
cd glasses
npm install
npm run mock-hub                                  # terminal 1 — fake hub on :8301
echo 'VITE_HUB_URL=http://localhost:8301' > .env.local
npm run dev                                       # terminal 2 — :5173
npm test && npm run typecheck                     # vitest + tsc
npm run build && npm run pack                     # dist/ → ../turma.ehpk
npx evenhub qr                                    # sideload to the glasses
```

Node 24. **Before packaging for your own hub**, edit `app.json`: the network
`whitelist` is enforced at the WebView layer, so it must name your hub for both
`https://` and `wss://`, and `package_id` must be your own. It currently carries
this project's values. Details and on-hardware QA in
[`glasses/README.md`](glasses/README.md).

### Android (`android/`)

```sh
cd android
gradle wrapper --gradle-version 8.11.1            # one-time; needs a system gradle
./gradlew testDebugUnitTest                       # JVM unit tests
./gradlew assembleDebug                           # → app/build/outputs/apk/debug/
adb install app/build/outputs/apk/debug/app-debug.apk
```

JDK 17, Android SDK (compileSdk 35, build-tools 35.0.0), `minSdk 26`. The
wrapper is not committed, hence the bootstrap step. Enter your hub URL at the
login screen. Push notifications are optional: drop your own
`google-services.json` into `android/app/` (the Firebase plugin only applies if
it exists) and set `FCM_SERVICE_ACCOUNT_JSON` on the hub. Prebuilt APKs on the
releases page are **debug-signed** — fine for sideloading, not for the Play
Store. See [`android/README.md`](android/README.md).

## Automation

`POST /api/trigger` starts a session from a single JSON body, for CI and
webhooks:

```sh
curl -X POST https://turma.example.com/api/trigger \
  -H "Authorization: Bearer $TURMA_TRIGGER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"hostname":"my-host","repo":"my-repo","prompt":"Fix the flaky test in CI"}'
```

`hostname`, `repo`, and `prompt` are required; `label`, `baseRef`, `model`, and
`permissionMode` are optional. Unlike the rest of the API this endpoint never
fails open — with `TURMA_TRIGGER_TOKEN` unset it simply accepts no token caller.

## How a session works

- **Spawn** cuts a git worktree under `REPOS_ROOT/.turma/worktrees`, detached at
  the latest default branch (fetched fresh), and starts `claude` in its own tmux.
  Many run at once, including several on one repo.
- **Turma creates no branch.** The agent names and creates its own when its work
  is ready; the card shows it once it exists.
- **Kill** drops the session but keeps its worktree, conversation, and usage
  history. **Delete** additionally removes the worktree — any branch the agent
  committed to survives, since Turma never owned it.
- **Resume** relaunches any prior transcript for a repo, re-creating its worktree
  if needed.
- A **repos-root** pseudo-repo runs a session across every repo at once, with no
  worktree and no branch.

Sessions run hands-off by default, so every launch is wired with a `PreToolUse`
guard that hard-denies three narrow categories — host/repo destruction, pushing
to `main` or merging a PR, and AI self-attribution in commits — plus deny rules
protecting the host's credential stores. Ordinary work is untouched. See the
Safety guard section of [`CLAUDE.md`](CLAUDE.md).

## Development

```sh
node --test turma/tests/*.test.js agent/tests/*.test.js    # hub + agent (Node 24)
cd glasses && npm test                                     # glasses (vitest)
cd android && ./gradlew testDebugUnitTest                   # android (JVM)
```

The hub has no build step and no dependencies — `node turma/server.js` runs it,
given `PORT`, `TURMA_USER`/`TURMA_PASSWORD`, `TURMA_AGENT_TOKEN`, and
`STATE_FILE`/`ARCHIVE_DIR` pointed somewhere writable (they default under
`/data`).

PRs are gated by Semgrep + hadolint + ShellCheck, a Trivy CVE scan of both
images, and each client's own suite. Both images build from the root `VERSION`
file plus the CI run number, and publish to GHCR.

## License

No license has been declared yet, so default copyright applies: the source is
readable here, but not yet licensed for reuse.
