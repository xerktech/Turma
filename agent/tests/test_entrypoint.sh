#!/usr/bin/env bash
# Behavioural tests for entrypoint.sh's run-as identity resolution.
#
# This is PID 1 on every host, and the thing it decides — which uid/gid the
# session manager and every Claude session run as — is exactly what determines
# whether files written into the mounted git root and ~/.claude come back
# owned by the host user or by root. A regression here either silently
# re-roots the operator's repo (the breakage the identity block exists to end)
# or fails to boot the container at all, and ShellCheck can't catch either: it
# checks shell correctness, not behaviour.
#
# So each case builds the REAL entrypoint.sh onto the REAL base image and runs
# it, stubbing only the three things it hands off to (python3/hub-agent.py,
# tunnel-agent.js) so we observe identity and nothing else. That keeps the
# parts most likely to bite us honest: setpriv, the passwd/group reuse against
# the node base image's pre-existing node:node at 1000:1000, and the on-boot
# self-heal chown.
#
# Requires docker (the runner has it; the Node suite already relies on it) and
# **bash 4.4 or newer**: `run_case` expands possibly-empty arrays under `set -u`,
# which is an "unbound variable" fatal on 4.3 and fine from 4.4. ubuntu-latest is
# 5.x, so this only bites someone running the suite somewhere else.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(dirname "$HERE")"
IMG="turma-entrypoint-test:$$"
WORK="$(mktemp -d)"
FAILED=0

# Fixtures get chowned to root/1500 by the very code under test, so a plain rm
# as the invoking user can't remove them — hand them back from a container.
# shellcheck disable=SC2329  # invoked indirectly, via the EXIT trap below.
cleanup() {
  docker run --rm -v "$WORK:/w" busybox chown -R "$(id -u):$(id -g)" /w >/dev/null 2>&1 || true
  rm -rf "$WORK"
  docker rmi -f "$IMG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- Build the harness image -------------------------------------------------
cp "$AGENT_DIR/entrypoint.sh" "$WORK/entrypoint.sh"

# Stands in for both `python3 hub-agent.py --print-device` and the manager
# itself. Reports the identity it was actually launched with.
cat > "$WORK/python3" <<'STUB'
#!/bin/sh
if [ "$2" = "--print-device" ]; then echo "DEVICE_NAME=testbox"; exit 0; fi
# Stand-in for hub-agent.py --wire-azure-git: the entrypoint only calls it when
# AZDO_URL+AZDO_TOKEN are set, so echoing a marker proves the plumbing fired.
if [ "$2" = "--wire-azure-git" ]; then echo "WIRE_AZURE_GIT called"; exit 0; fi
echo "MANAGER uid=$(id -u) gid=$(id -g) home=$HOME"
# Whether the ADO PAT reached the manager's env (and so every session's `az`) —
# reported as set/unset, never the value.
echo "AZDOEXTPAT=${AZURE_DEVOPS_EXT_PAT:+set}"
echo "ROOTDIR_OWNER=$(stat -c '%u:%g' /root)"
touch "$REPOS_ROOT/.probe" 2>/dev/null || true
echo "NEWFILE_OWNER=$(stat -c '%u:%g' "$REPOS_ROOT/.probe" 2>/dev/null || echo none)"
echo "LEFTOVER_ROOT_PATHS=$(find "$REPOS_ROOT" /root/.claude -uid 0 2>/dev/null | wc -l)"
# What the in-cluster kubeconfig block left behind, observed from the process
# that would actually use it. Reported as fields rather than a dump so the token
# PATH is asserted and no credential is ever echoed.
# The values are QUOTED in the file (see KUBECFG_QUOTED below for why), so the
# quotes come off here rather than in every assertion.
echo "KUBECFG_SERVER=$(sed -n 's/^ *server: *"\?\([^"]*\)"\?$/\1/p' /root/.kube/config 2>/dev/null | head -1)"
echo "KUBECFG_TOKENFILE=$(sed -n 's/^ *tokenFile: *"\?\([^"]*\)"\?$/\1/p' /root/.kube/config 2>/dev/null | head -1)"
echo "KUBECFG_NS=$(sed -n 's/^ *namespace: *"\?\([^"]*\)"\?$/\1/p' /root/.kube/config 2>/dev/null | head -1)"
echo "KUBECFG_MODE=$(stat -c %a /root/.kube/config 2>/dev/null || echo none)"
echo "KUBECFG_OWNER=$(stat -c '%u:%g' /root/.kube/config 2>/dev/null || echo none)"
# The DIRECTORY's owner. A session that cannot write it gets no `kubectl config`
# mutation and no discovery cache, while the config file itself reads fine — so
# the file's owner alone says nothing about whether kubectl works.
# NOT `stat -L`: on a symlink shape this must report the LINK, because the
# whole point of the `-h` on the chowns is that the link is what gets re-owned.
echo "KUBEDIR_OWNER=$(stat -c '%u:%g' /root/.kube 2>/dev/null || echo none)"
# The target of a symlink planted at /root/.kube by case 42's stub. Container-
# local, because anything under REPOS_ROOT or ~/.claude is re-owned by the
# identity self-heal before this block runs and could not stay root-owned.
echo "VICTIM_OWNER=$(stat -c '%u:%g' /tmp/victim 2>/dev/null || echo none)"
# The umask the manager INHERITED. The kubeconfig write must not change it: it
# is the mode of every file every session on this host goes on to create.
echo "MANAGER_UMASK=$(umask)"
# Any line the generated config was not supposed to contain. `KUBECFG_SERVER` is
# read with `head -1`, so an injected line landing AFTER it is invisible to
# every other field here — which is exactly how an injection would survive.
echo "KUBECFG_INJECTED=$(grep -ci injected /root/.kube/config 2>/dev/null || true)"
echo "KUBECFG_LINES=$(wc -l < /root/.kube/config 2>/dev/null || echo 0)"
# Are the interpolated scalars QUOTED? A namespace of `no`/`123`/`null` is legal
# in Kubernetes and reads as a bool/number/null in YAML, so an unquoted scalar
# produces a config kubectl refuses to load at all — while a `namespace:` field
# read with sed looks perfectly correct while it happens. Four values come from
# outside: server, certificate-authority, tokenFile, namespace.
echo "KUBECFG_QUOTED=$(grep -cE '^ +(server|certificate-authority|tokenFile|namespace): \"' /root/.kube/config 2>/dev/null || true)"
# Temp files left behind. The write goes through `mktemp`, so a crash between it
# and the `mv` leaves one — and in a pod /root is a persistent volume nothing
# else sweeps, so they accumulate for the life of the agent.
echo "KUBECFG_STRAYS=$(find /root/.kube/.turma-tmp -maxdepth 1 -type f 2>/dev/null | wc -l)"
# Everything in /root/.kube that is NOT the kubeconfig. A real ~/.kube is mostly
# NON-hidden — admin.conf, kubeconfig-prod.yaml, ca.crt — so counting only
# `.config.*` missed the widening a sweep is most likely to get: QA proved a
# sweep of `/root/.kube/*` passed the narrower assertion clean.
echo "KUBECFG_NEIGHBOURS=$(find /root/.kube -maxdepth 1 -mindepth 1 ! -name config ! -name .turma-tmp 2>/dev/null | wc -l)"
# Whether the staging directory survived. A clean boot must leave NOTHING —
# both the code and .claude/rules/agent-image.md state that as fact, and until
# now nothing checked it.
echo "KUBECFG_TMPDIR=$([ -e /root/.kube/.turma-tmp ] && echo present || echo gone)"
# Configurable lifetime: the manager is PID 1, so how long IT lives is how long
# the container lives — the tunnel-supervision case needs a few seconds.
sleep "${STUB_MANAGER_SLEEP:-1}"
STUB
cp "$WORK/python3" "$WORK/hub-agent.py"
echo 'console.log("TUNNEL uid=" + process.getuid() + " gid=" + process.getgid() + " TUNNELHOME=" + process.env.HOME);' \
  > "$WORK/tunnel-agent.js"

# Stand-ins for the cloud CLIs the real image bundles. The preflight only ever
# probes `command -v` and the creds store on disk — it deliberately never runs
# these — so a stub on PATH exercises it exactly as the 1 GB of real ones would.
# The cluster CLIs (XERK-369) ride the same preflight and the same rule.
for cli in aws az terraform kubectl helm talosctl omnictl; do
  printf '#!/bin/sh\necho "%s stub should not be invoked" >&2\nexit 1\n' "$cli" \
    > "$WORK/$cli"
done

# Stand-ins for the Claude Code update check (XERK-254). The real image bakes
# claude at build time and has a real npm; both are stubbed so the case observes
# the DECISION without reaching the npm registry — and so a test run can never
# install anything. Driven by STUB_CLAUDE_VERSION / STUB_NPM_LATEST.
cat > "$WORK/claude" <<'STUB'
#!/bin/sh
if [ "$1" = "--version" ]; then
  # STUB_CLAUDE_HANG: a claude that never answers. Reachable from the very fault
  # the repair branch exists for, so both the probe AND the post-install read
  # have to be bounded.
  [ -n "${STUB_CLAUDE_HANG:-}" ] && sleep "$STUB_CLAUDE_HANG"
  echo "${STUB_CLAUDE_VERSION:-1.0.0} (Claude Code)"
  exit 0
fi
exit 2
STUB
cat > "$WORK/npm" <<'STUB'
#!/bin/sh
case "$1 $2" in
  "view @anthropic-ai/claude-code")
    # A registry that never answers, for the does-it-block case.
    [ -n "${STUB_NPM_HANG:-}" ] && sleep "$STUB_NPM_HANG"
    [ -n "${STUB_NPM_LATEST:-}" ] || exit 1
    echo "$STUB_NPM_LATEST" ;;
  "install -g")
    echo "NPMINSTALL start $(date +%s) $*"
    # A real `npm install -g` leaves claude absent from PATH while it unpacks;
    # $STUB_NPM_INSTALL_SLEEP makes that window long enough to observe.
    [ -n "${STUB_NPM_INSTALL_SLEEP:-}" ] && sleep "$STUB_NPM_INSTALL_SLEEP"
    echo "NPMINSTALL $*"
    # Where npm was pointed. The whole reason the block sets its own HOME is that
    # /root is the operator's bind mount, so this is the assertion that keeps it.
    echo "NPMHOME=$HOME NPMCACHE=${npm_config_cache:-unset}"
    # What a real install changes, so the version echoed afterwards moves.
    STUB_CLAUDE_VERSION="${STUB_NPM_LATEST}"; export STUB_CLAUDE_VERSION ;;
  *) exit 2 ;;
esac
STUB

cat > "$WORK/Dockerfile" <<'DOCKERFILE'
FROM node:24-bookworm-slim
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY python3 /usr/local/bin/python3
COPY hub-agent.py tunnel-agent.js aws az terraform kubectl helm talosctl omnictl /usr/local/bin/
# Last, so they shadow the base image's real npm.
COPY claude npm /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/python3 \
      /usr/local/bin/aws /usr/local/bin/az /usr/local/bin/terraform \
      /usr/local/bin/kubectl /usr/local/bin/helm /usr/local/bin/talosctl \
      /usr/local/bin/omnictl \
      /usr/local/bin/claude /usr/local/bin/npm
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
DOCKERFILE

echo "# building harness image..."
docker build -q -t "$IMG" "$WORK" >/dev/null

# --- Helpers -----------------------------------------------------------------

# make_fixture <dir> <uid> <gid> — a repos root + claude dir owned by uid:gid,
# seeded with root-owned files inside to stand in for what the pre-drop image
# left behind on disk.
make_fixture() {
  local dir="$1" uid="$2" gid="$3"
  rm -rf "$dir"; mkdir -p "$dir/repos" "$dir/claude"
  docker run --rm -v "$dir:/f" busybox sh -c "
    mkdir -p /f/repos/somerepo/.git /f/claude/projects
    touch /f/repos/somerepo/.git/HEAD /f/claude/projects/legacy.jsonl /f/claude/.credentials.json
    chown -R 0:0 /f/repos/somerepo /f/claude/projects
    chown $uid:$gid /f/repos /f/claude /f/claude/.credentials.json" >/dev/null
}

# run_case <fixture-dir> [extra docker -e args...]
#
# BOUNDED, and that is not paranoia: case 19 exists because an unbounded read in
# the entrypoint hung PID 1 forever. Unbounded here, re-introducing that defect
# would hang the GitHub job to its 6-hour ceiling rather than failing it — the
# most expensive possible way to learn about it. `timeout` kills the docker
# CLIENT, so the container is named and force-removed after, and the marker in
# the output fails whatever assertions the case makes.
# RUN_CASE_DOCKER_ARGS  extra docker flags (--read-only, --tmpfs …)
# RUN_CASE_SH           run this through `sh -c` as PID 1 instead of the
#                       entrypoint, for the cases that have to set something up
#                       (a umask, a missing binary) before PID 1 exists.
# Both exist so those cases go through THIS function rather than calling
# `docker run` themselves: a nameless `--rm` container that `timeout` kills is
# leaked, unreachable by name, and — under `set -e` — a non-zero exit aborts the
# whole suite from inside `out="$(…)"` with no FAIL line and no summary, taking
# every later case with it. QA measured exactly that: the mutant case 28 exists
# to catch was reported only as a bare exit 1, and cases 29 and 30 never ran.
run_case() {
  local dir="$1"; shift
  local name="turma-ep-$$-${RANDOM}"
  local rc=0
  local -a extra=() entry=() cmd=()
  if [ -n "${RUN_CASE_DOCKER_ARGS:-}" ]; then
    # `read -ra`, not `extra=($…)`: both split on whitespace, but the bare
    # expansion also GLOBS, so a flag containing `*` or `?` would be replaced by
    # whatever happened to be in the caller's directory.
    read -ra extra <<< "$RUN_CASE_DOCKER_ARGS"
  fi
  if [ -n "${RUN_CASE_SH:-}" ]; then
    entry=(--entrypoint sh)
    cmd=(-c "$RUN_CASE_SH")
  fi
  timeout "${RUN_CASE_TIMEOUT:-180}" \
    docker run --rm --name "$name" \
      -e AGENT=none -e REPOS_ROOT=/f/repos -e DEVICE_NAME=x \
      "${extra[@]}" "$@" \
      -v "$dir/repos:/f/repos" -v "$dir/claude:/root/.claude" \
      "${entry[@]}" "$IMG" "${cmd[@]}" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    if [ "$rc" -eq 124 ]; then
      echo "RUNCASE_TIMEOUT=yes"
    else
      echo "RUNCASE_EXIT=$rc"
    fi
  fi
  return 0
}

# expect <label> <expected> <actual>
expect() {
  if [ "$2" = "$3" ]; then
    echo "  ok: $1 = $2"
  else
    echo "  FAIL: $1 — expected '$2', got '$3'"
    FAILED=1
  fi
}

field() { echo "$1" | grep -oE "$2=[^ ]*" | head -1 | cut -d= -f2; }

# --- Case 1: root-owned git root (the TrueNAS stack) -------------------------
# Must behave exactly as it did before the identity block existed: stay root,
# and touch nothing on disk.
echo "== case: root-owned REPOS_ROOT stays root"
make_fixture "$WORK/fx1" 0 0
out="$(run_case "$WORK/fx1")"
expect "manager uid" "0" "$(field "$out" uid)"
expect "tunnel uid" "0" "$(field "$out" "TUNNEL uid")"
# Scan the two roots themselves, not their $WORK wrapper dir — that wrapper is
# created by whoever runs this suite and is legitimately not root-owned, so
# including it would fail this assertion for a reason that has nothing to do
# with the entrypoint. (busybox find has no -uid; -user takes an id just fine.)
expect "no chown of a root-owned tree" "0" \
  "$(docker run --rm -v "$WORK/fx1:/f" busybox find /f/repos /f/claude ! -user 0 | wc -l | tr -d ' ')"

# --- Case 2: user-owned git root (WSL / desktop) ------------------------------
# The reason this change exists: drop to the owning uid, and reclaim what the
# pre-drop image already left root-owned.
echo "== case: user-owned REPOS_ROOT drops to that uid and self-heals"
make_fixture "$WORK/fx2" 1000 1000
out="$(run_case "$WORK/fx2")"
expect "manager uid" "1000" "$(field "$out" uid)"
expect "tunnel uid" "1000" "$(field "$out" "TUNNEL uid")"
expect "HOME stays /root" "/root" "$(field "$out" home)"
expect "/root handed to run-as user" "1000:1000" "$(field "$out" ROOTDIR_OWNER)"
expect "new files land host-owned" "1000:1000" "$(field "$out" NEWFILE_OWNER)"
expect "legacy root-owned files reclaimed" "0" "$(field "$out" LEFTOVER_ROOT_PATHS)"
expect "nothing root-owned left on host" "0" \
  "$(docker run --rm -v "$WORK/fx2:/f" busybox find /f/repos /f/claude -user 0 | wc -l | tr -d ' ')"

# --- Case 3: PUID/PGID override ----------------------------------------------
# An id with no passwd entry — the entrypoint has to create one.
echo "== case: PUID/PGID override wins over detection"
make_fixture "$WORK/fx3" 0 0
out="$(run_case "$WORK/fx3" -e PUID=1500 -e PGID=1500)"
expect "manager uid" "1500" "$(field "$out" uid)"
expect "manager gid" "1500" "$(field "$out" gid)"

# --- Case 4: PUID=0 escape hatch ---------------------------------------------
echo "== case: PUID=0 forces root on a user-owned root"
make_fixture "$WORK/fx4" 1000 1000
out="$(run_case "$WORK/fx4" -e PUID=0 -e PGID=0)"
expect "manager uid" "0" "$(field "$out" uid)"

# --- Case 5: PUID=0 with a non-zero PGID -------------------------------------
# uid 0 IS root whatever the gid says. Guards the half-dropped state where we'd
# usermod root's primary group but never actually setpriv.
echo "== case: PUID=0 with non-zero PGID is still plain root"
make_fixture "$WORK/fx5" 1000 1000
out="$(run_case "$WORK/fx5" -e PUID=0 -e PGID=1000)"
expect "manager uid" "0" "$(field "$out" uid)"
expect "manager gid" "0" "$(field "$out" gid)"

# --- Case 6: cloud CLIs with no creds on the device --------------------------
# The point of the preflight: a host that mounts no cloud creds is a supported
# configuration, so the CLIs are reported as ignored and the container STILL
# boots. Guards against the preflight ever growing the claude one's idle-forever
# behaviour, which would take a host's sessions down over creds no session needs.
echo "== case: no cloud creds mounted is ignored, not fatal"
make_fixture "$WORK/fx6" 0 0
out="$(run_case "$WORK/fx6")"
for cli in aws az terraform; do
  if echo "$out" | grep -q "\[entrypoint\] ${cli}: installed; no creds on this device"; then
    echo "  ok: ${cli} reported as ignored"
  else
    echo "  FAIL: ${cli} — no 'ignoring' line in output"; FAILED=1
  fi
done
expect "manager still starts" "0" "$(field "$out" uid)"

# --- Case 7: mounted host cred stores are found ------------------------------
# Each store is the host's own, reused read-through like ~/.claude — so what the
# preflight must report is the MOUNT, on the same evidence the CLI itself uses.
echo "== case: mounted cloud cred stores are reported"
make_fixture "$WORK/fx7" 0 0
mkdir -p "$WORK/fx7/aws" "$WORK/fx7/azure" "$WORK/fx7/terraform.d"
touch "$WORK/fx7/aws/credentials" "$WORK/fx7/azure/msal_token_cache.json" \
  "$WORK/fx7/terraform.d/credentials.tfrc.json"
out="$(run_case "$WORK/fx7" \
  -v "$WORK/fx7/aws:/root/.aws" \
  -v "$WORK/fx7/azure:/root/.azure" \
  -v "$WORK/fx7/terraform.d:/root/.terraform.d")"
for pair in "aws:/root/.aws" "az:/root/.azure" "terraform:/root/.terraform.d"; do
  cli="${pair%%:*}"; store="${pair#*:}"
  if echo "$out" | grep -q "\[entrypoint\] ${cli}: host creds mounted at ${store}"; then
    echo "  ok: ${cli} creds found at ${store}"
  else
    echo "  FAIL: ${cli} — ${store} mounted but not reported"; FAILED=1
  fi
done

# --- Case 8: a store with no login in it is still "no creds" -----------------
# The CLIs create their own stores just by running (`az version` writes a whole
# ~/.azure, azureProfile.json and all), so on any host where a session has once
# run one, a directory-presence check claims creds that were never there. Caught
# exactly this way: the first build of this image reported az and terraform
# creds on a container with nothing mounted.
echo "== case: an empty/self-created store is not mistaken for creds"
make_fixture "$WORK/fx8" 0 0
mkdir -p "$WORK/fx8/azure" "$WORK/fx8/terraform.d"
touch "$WORK/fx8/azure/azureProfile.json" "$WORK/fx8/terraform.d/checkpoint_cache"
out="$(run_case "$WORK/fx8" \
  -v "$WORK/fx8/azure:/root/.azure" \
  -v "$WORK/fx8/terraform.d:/root/.terraform.d")"
for cli in az terraform; do
  if echo "$out" | grep -q "\[entrypoint\] ${cli}: installed; no creds on this device"; then
    echo "  ok: ${cli} store without a login reads as no creds"
  else
    echo "  FAIL: ${cli} — self-created store reported as creds"; FAILED=1
  fi
done

# --- Case 9: aws env credentials count as creds ------------------------------
# AWS_* env creds authenticate the CLI with no ~/.aws at all, so reporting that
# host as credential-less would be a lie about a working setup.
echo "== case: AWS_* env creds are recognised without a store"
make_fixture "$WORK/fx9" 0 0
out="$(run_case "$WORK/fx9" -e AWS_ACCESS_KEY_ID=AKIAEXAMPLE)"
if echo "$out" | grep -q "\[entrypoint\] aws: credentials from the environment"; then
  echo "  ok: aws env creds recognised"
else
  echo "  FAIL: aws — env creds not recognised"; FAILED=1
fi

# --- Case 9b: non-GitHub git creds are reported (XERK-54) --------------------
# For an org that doesn't use GitHub, git authenticates through the `store`
# helper reading a host-mounted /root/.git-credentials. The preflight reports
# the mount when present and, like the cloud creds, is non-fatal when absent.
echo "== case: a mounted /root/.git-credentials is reported"
make_fixture "$WORK/fx9b" 0 0
# A benign non-empty stand-in — the preflight only checks the file is non-empty,
# never its contents, so no credential-shaped text is committed here.
printf '# host git credential cache\n' > "$WORK/fx9b/git-credentials"
out="$(run_case "$WORK/fx9b" -v "$WORK/fx9b/git-credentials:/root/.git-credentials")"
if echo "$out" | grep -q "\[entrypoint\] git: non-GitHub creds mounted at /root/.git-credentials"; then
  echo "  ok: mounted git creds reported"
else
  echo "  FAIL: git — /root/.git-credentials mounted but not reported"; FAILED=1
fi
expect "manager still starts" "0" "$(field "$out" uid)"

echo "== case: no /root/.git-credentials is ignored, not fatal"
make_fixture "$WORK/fx9c" 0 0
out="$(run_case "$WORK/fx9c")"
if echo "$out" | grep -q "\[entrypoint\] git: no cached non-GitHub creds"; then
  echo "  ok: absent git creds reported as ignored"
else
  echo "  FAIL: git — absent creds not reported"; FAILED=1
fi
expect "manager still starts" "0" "$(field "$out" uid)"

# --- Case 9d: Azure DevOps git auth is wired when configured (XERK-54) -------
# A non-GitHub ADO org already gives the agent a PAT (AZDO_TOKEN) for the board;
# the entrypoint reuses it to wire plain git. Only fires when both AZDO vars are
# set, and is non-fatal to boot either way.
echo "== case: AZDO_URL+AZDO_TOKEN wires git auth"
make_fixture "$WORK/fx9d" 0 0
out="$(run_case "$WORK/fx9d" -e AZDO_URL=https://tfs.example.com/Col -e AZDO_TOKEN=pat)"
if echo "$out" | grep -q "WIRE_AZURE_GIT called"; then
  echo "  ok: git-auth wiring invoked"
else
  echo "  FAIL: AZDO configured but git-auth wiring not invoked"; FAILED=1
fi
# XERK-226: the same PAT is exported as AZURE_DEVOPS_EXT_PAT so a session's
# `az repos pr create` authenticates — that command is what opens the PR an ADO
# chip then tracks. Exported (never a command-line arg), so `ps` can't leak it.
expect "az repos PAT exported" "set" "$(field "$out" AZDOEXTPAT)"
expect "manager still starts" "0" "$(field "$out" uid)"

echo "== case: no AZDO creds means no git-auth wiring"
make_fixture "$WORK/fx9e" 0 0
out="$(run_case "$WORK/fx9e")"
if echo "$out" | grep -q "WIRE_AZURE_GIT called"; then
  echo "  FAIL: git-auth wiring invoked with no AZDO creds"; FAILED=1
else
  echo "  ok: git-auth wiring skipped without AZDO creds"
fi
expect "no az repos PAT without AZDO creds" "" "$(field "$out" AZDOEXTPAT)"

# An operator-set AZURE_DEVOPS_EXT_PAT is a deliberate override and wins over
# the board's PAT.
echo "== case: an operator-set az repos PAT is not overwritten"
make_fixture "$WORK/fx9f" 0 0
out="$(run_case "$WORK/fx9f" -e AZDO_URL=https://tfs.example.com/Col \
  -e AZDO_TOKEN=pat -e AZURE_DEVOPS_EXT_PAT=mine)"
expect "operator PAT kept" "set" "$(field "$out" AZDOEXTPAT)"

# --- Case 10: the tunnel is supervised (XERK-34) -----------------------------
# A tunnel PROCESS death must not outlive one retry interval. Fire-and-forget
# left a crashed tunnel down until someone restarted the whole container, with
# the heartbeat keeping the host green while every session read "terminal
# offline" — the exact failure the native launcher's supervisor exists to heal.
# The stub tunnel exits the moment it has printed, so a supervised entrypoint
# relaunches it within TUNNEL_RETRY_SEC; count the launches.
echo "== case: a dead tunnel-agent is relaunched"
make_fixture "$WORK/fx10" 0 0
out="$(run_case "$WORK/fx10" -e TUNNEL_RETRY_SEC=1 -e STUB_MANAGER_SLEEP=4)"
starts="$(echo "$out" | grep -c "TUNNEL uid=")"
if [ "$starts" -ge 2 ]; then
  echo "  ok: tunnel relaunched after it exited ($starts starts)"
else
  echo "  FAIL: tunnel started $starts time(s) — a dead tunnel stays dead"; FAILED=1
fi
if echo "$out" | grep -q "tunnel-agent exited; restarting"; then
  echo "  ok: the restart is logged"
else
  echo "  FAIL: no restart log line"; FAILED=1
fi

# --- Case 11: Claude Code is updated on every start (XERK-254) ---------------
# The container cannot self-update — it IS the image, and an image pull is what
# brings it back through this code — but the Claude Code baked in at build time
# then ages for the life of the tag. These cases pin the decision: only when the
# registry really has something newer, never a downgrade, and never at all when
# the operator has pinned it.
#
# STUB_MANAGER_SLEEP keeps the container alive past the backgrounded check, which
# is the only reason its output lands in the same capture.
echo "== case: a newer published Claude Code is installed at boot"
make_fixture "$WORK/fx11" 0 0
out="$(run_case "$WORK/fx11" -e AGENT=claude -e STUB_MANAGER_SLEEP=6 \
  -e STUB_CLAUDE_VERSION=2.0.1 -e STUB_NPM_LATEST=2.0.9)"
if echo "$out" | grep -q "NPMINSTALL install -g @anthropic-ai/claude-code@2.0.9"; then
  echo "  ok: installed the newer version"
else
  echo "  FAIL: no claude install at boot — the bundled version would age forever"; FAILED=1
fi

echo "== case: an already-current Claude Code is a no-op"
out="$(run_case "$WORK/fx11" -e AGENT=claude -e STUB_MANAGER_SLEEP=6 \
  -e STUB_CLAUDE_VERSION=2.0.9 -e STUB_NPM_LATEST=2.0.9)"
if echo "$out" | grep -q "NPMINSTALL"; then
  echo "  FAIL: reinstalled an up-to-date claude on every container start"; FAILED=1
else
  echo "  ok: nothing installed"
fi

echo "== case: an installed version ahead of the registry is not downgraded"
out="$(run_case "$WORK/fx11" -e AGENT=claude -e STUB_MANAGER_SLEEP=6 \
  -e STUB_CLAUDE_VERSION=2.1.0 -e STUB_NPM_LATEST=2.0.9)"
if echo "$out" | grep -q "NPMINSTALL"; then
  echo "  FAIL: downgraded a hand-pinned/unpublished claude"; FAILED=1
else
  echo "  ok: left the newer install alone"
fi

echo "== case: an unreachable registry leaves the install alone"
out="$(run_case "$WORK/fx11" -e AGENT=claude -e STUB_MANAGER_SLEEP=6 \
  -e STUB_CLAUDE_VERSION=2.0.1)"
if echo "$out" | grep -q "NPMINSTALL"; then
  echo "  FAIL: installed something with no answer from the registry"; FAILED=1
else
  echo "  ok: stayed put"
fi

echo "== case: TURMA_CLAUDE_AUTO_UPDATE=0 pins the image's bundled version"
out="$(run_case "$WORK/fx11" -e AGENT=claude -e STUB_MANAGER_SLEEP=6 \
  -e STUB_CLAUDE_VERSION=2.0.1 -e STUB_NPM_LATEST=2.0.9 -e TURMA_CLAUDE_AUTO_UPDATE=0)"
if echo "$out" | grep -q "NPMINSTALL"; then
  echo "  FAIL: updated claude despite TURMA_CLAUDE_AUTO_UPDATE=0"; FAILED=1
else
  echo "  ok: pinned"
fi

echo "== case: a hanging registry delays the boot but cannot stop it"
# Awaiting the check (see the ordering case below) is only safe because every
# call it makes is bounded. A `view` that never answers must end in "stay put"
# and a started manager, not a container that never comes up.
out="$(run_case "$WORK/fx11" -e AGENT=claude -e STUB_MANAGER_SLEEP=3 \
  -e STUB_CLAUDE_VERSION=2.0.1 -e STUB_NPM_LATEST=2.0.9 -e STUB_NPM_HANG=30 \
  -e TURMA_NPM_VIEW_TIMEOUT=2)"
if echo "$out" | grep -q "MANAGER uid="; then
  echo "  ok: the manager started after the check timed out"
else
  echo "  FAIL: a hanging registry blocked the container's boot for good"; FAILED=1
fi
if echo "$out" | grep -q "registry unreachable"; then
  echo "  ok: the timed-out probe read as stay-put"
else
  echo "  FAIL: a timed-out probe did not read as stay-put"; FAILED=1
fi

echo "== case: the check finishes before the manager can launch anything"
# The ordering IS the safety argument. `npm install -g` leaves claude absent
# from PATH for ~1.7s, and resume_on_boot relaunches this host's sessions on a
# 1s stagger right after the manager starts — so a check that ran alongside the
# manager would put that hole under the first relaunches, which then die on exec
# with ENOENT. Every claude line must therefore precede the manager's first.
out="$(run_case "$WORK/fx11" -e AGENT=claude -e STUB_MANAGER_SLEEP=4 \
  -e STUB_CLAUDE_VERSION=2.0.1 -e STUB_NPM_LATEST=2.0.9)"
claude_line="$(echo "$out" | grep -n "claude update:" | head -1 | cut -d: -f1)"
mgr_line="$(echo "$out" | grep -n "MANAGER uid=" | head -1 | cut -d: -f1)"
if [ -n "$claude_line" ] && [ -n "$mgr_line" ] && [ "$claude_line" -lt "$mgr_line" ]; then
  echo "  ok: claude was replaced before the manager existed"
else
  echo "  FAIL: the manager started while claude was being replaced (claude=$claude_line manager=$mgr_line)"; FAILED=1
fi

echo "== case: the check does not leak its throwaway HOME into the boot"
# The scratch HOME is for npm and for `claude --version` — and for nothing else.
# A /bin/sh function is NOT a subshell (and has no `local`), so an exported HOME
# here escapes into the manager, the tunnel and every session, pointing them at
# a /tmp dir this same check then deletes: the registry, the usage ledger and
# the archive would silently move off the mount, and the operator's ~/.claude
# would vanish from under the agent. Assert on the run that actually INSTALLS —
# the rate limit short-circuits before the leak, so a throttled run hides it.
mgr_home="$(field "$out" home)"
if [ "$mgr_home" = "/root" ]; then
  echo "  ok: the manager still boots with HOME=/root"
else
  echo "  FAIL: the manager inherited the check's scratch HOME ($mgr_home)"; FAILED=1
fi
tunnel_home="$(echo "$out" | grep -o 'TUNNELHOME=[^ ]*' | head -1 | cut -d= -f2)"
if [ "$tunnel_home" = "/root" ]; then
  echo "  ok: so does the tunnel"
elif [ -z "$tunnel_home" ]; then
  echo "  FAIL: the tunnel never reported its HOME — this assertion would pass vacuously"; FAILED=1
else
  echo "  FAIL: the tunnel inherited the check's scratch HOME ($tunnel_home)"; FAILED=1
fi

echo "== case: the update writes nothing into the operator's mounted HOME"
# npm's cache and anything claude touches would otherwise land in /root — which
# is a bind mount, ROOT-owned, on a host whose sessions run as somebody else.
if echo "$out" | grep -q "NPMHOME=/tmp/"; then
  echo "  ok: ran against a throwaway HOME"
else
  echo "  FAIL: the update ran against the mounted HOME ($(echo "$out" | grep -o 'NPMHOME=[^ ]*'))"; FAILED=1
fi
if echo "$out" | grep -q "NPMCACHE=/tmp/"; then
  echo "  ok: npm cached outside the mount"
else
  echo "  FAIL: npm's cache was not redirected ($(echo "$out" | grep -o 'NPMCACHE=[^ ]*'))"; FAILED=1
fi
leftover="$(docker run --rm -v "$WORK/fx11:/f" busybox find /f/claude -newer /f/claude/.credentials.json | wc -l | tr -d ' ')"
if [ "$leftover" = "0" ]; then
  echo "  ok: nothing new under the mounted /root/.claude"
else
  echo "  FAIL: the update left $leftover new path(s) in the operator's ~/.claude"; FAILED=1
fi

echo "== case: a futile repair is not repeated on every boot"
# An unreadable version is usually a half-written install, which reinstalling
# repairs — but it can equally be a working claude printing a version shape this
# doesn't parse. There the repair fixes nothing, and repeating it is a real
# `npm install -g` on every boot, forever, inside the awaited path.
make_fixture "$WORK/fx14" 0 0
out="$(run_case "$WORK/fx14" -e AGENT=claude -e STUB_MANAGER_SLEEP=2 \
  -e STUB_CLAUDE_VERSION=not-a-version -e STUB_NPM_LATEST=2.0.9 \
  -v "$WORK/fx14/turma:/root/.turma")"
if echo "$out" | grep -q "NPMINSTALL"; then
  echo "  ok: the first boot tries to repair it"
else
  echo "  FAIL: an unreadable claude was not repaired at all"; FAILED=1
fi
out="$(run_case "$WORK/fx14" -e AGENT=claude -e STUB_MANAGER_SLEEP=2 \
  -e STUB_CLAUDE_VERSION=not-a-version -e STUB_NPM_LATEST=2.0.9 \
  -e TURMA_BOOT_UPDATE_MIN_INTERVAL=0 -v "$WORK/fx14/turma:/root/.turma")"
if echo "$out" | grep -q "NPMINSTALL"; then
  echo "  FAIL: repeated a repair that changed nothing — every boot, forever"; FAILED=1
else
  echo "  ok: the next boot leaves it alone"
fi
if echo "$out" | grep -q "a repair already failed to change that"; then
  echo "  ok: and says why"
else
  echo "  FAIL: no explanation for skipping the repair"; FAILED=1
fi

echo "== case: a claude that never answers cannot wedge the boot"
# Every read of `claude --version` is a child of PID 1 with no outer timeout
# anywhere — the `||` guard only runs once the block RETURNS. An unbounded one
# leaves the container `running` with no manager, no tunnel and no sessions, and
# because PID 1 looks alive no restart policy ever fires: worse than a crash
# loop. The hang is reachable from the same fault the repair branch handles, so
# the post-install verification needs the bound just as much as the probe.
make_fixture "$WORK/fx15" 0 0
t0=$(date +%s)
out="$(run_case "$WORK/fx15" -e AGENT=claude -e STUB_MANAGER_SLEEP=2 \
  -e STUB_CLAUDE_HANG=120 -e TURMA_CLAUDE_PROBE_TIMEOUT=2 -e STUB_NPM_LATEST=2.0.9)"
elapsed=$(( $(date +%s) - t0 ))
# Timed, not just "did it eventually boot": an unbounded read boots too, 120s
# later, so only the clock tells the fixed code from the broken code.
if echo "$out" | grep -q "MANAGER uid=" && [ "$elapsed" -lt 60 ]; then
  echo "  ok: the manager started in ${elapsed}s despite a claude that never answers"
else
  echo "  FAIL: the boot waited ${elapsed}s on a hung claude — running, no manager, no restart"; FAILED=1
fi

echo "== case: the watchdog cannot fire while an install is running"
# A `kill` reaches the check's shell, NEVER its npm grandchild. Fire the watchdog
# mid-install and npm keeps replacing the package while the manager starts
# launching sessions into it — 100 launch failures out of 100 when measured, the
# exact window this design exists to close. So the deadline is DERIVED from the
# per-call bounds and an operator value below that floor is raised, not honoured.
make_fixture "$WORK/fx17" 0 0
out="$(run_case "$WORK/fx17" -e AGENT=claude -e STUB_MANAGER_SLEEP=2 \
  -e STUB_CLAUDE_VERSION=2.0.1 -e STUB_NPM_LATEST=2.0.9 \
  -e STUB_NPM_INSTALL_SLEEP=12 -e TURMA_CLAUDE_UPDATE_TIMEOUT=5 \
  -e TURMA_CLAUDE_PROBE_TIMEOUT=2 -e TURMA_NPM_VIEW_TIMEOUT=2 -e TURMA_NPM_INSTALL_TIMEOUT=30)"
# `|| true` on both: under `set -o pipefail` a grep that finds nothing fails the
# whole pipeline and would abort the suite instead of reporting the defect —
# and "the install line is missing entirely" is exactly what a killed install
# looks like, i.e. the case this is here to catch.
done_line="$(echo "$out" | grep -n "NPMINSTALL install -g" | head -1 | cut -d: -f1 || true)"
mgr_line="$(echo "$out" | grep -n "MANAGER uid=" | head -1 | cut -d: -f1 || true)"
if [ -n "$done_line" ] && [ -n "$mgr_line" ] && [ "$done_line" -lt "$mgr_line" ]; then
  echo "  ok: the install finished before the manager, despite a too-low outer timeout"
else
  echo "  FAIL: the watchdog orphaned an install into the session-relaunch window (install=$done_line manager=$mgr_line)"; FAILED=1
fi
if echo "$out" | grep -q "could fire while an install is running"; then
  echo "  ok: and said it was raising the deadline"
else
  echo "  FAIL: silently honoured a deadline that could fire mid-install"; FAILED=1
fi

echo "== case: the SHIPPED default floor is what it is supposed to be"
# A FIXED generous number, deliberately not arithmetic over the per-call bounds:
# the deadline only ever needed to sit above the legitimate worst case, and every
# attempt to make it tight coupled it to the exact set of calls in the check.
make_fixture "$WORK/fx19" 0 0
out="$(run_case "$WORK/fx19" -e AGENT=claude -e STUB_MANAGER_SLEEP=2 \
  -e STUB_CLAUDE_VERSION=2.0.9 -e STUB_NPM_LATEST=2.0.9)"
bound="$(echo "$out" | sed -n 's/.*claude check bounded at \([0-9]*\)s.*/\1/p' | head -1)"
if [ "$bound" = "1800" ]; then
  echo "  ok: default deadline is 1800s"
else
  echo "  FAIL: default deadline is ${bound:-unreported}s, not the shipped 1800s"; FAILED=1
fi

echo "== case: a timeout of 0 does not disable a bound and shrink the floor"
# `timeout 0 cmd` DISABLES the timeout — so a 0 would leave that call unbounded
# and subtract its whole share from the derived floor at the same time, which is
# both halves of the orphan. 0 is the value an operator reaches for when they
# mean "no limit", so it has to read as "use the default".
out="$(run_case "$WORK/fx19" -e AGENT=claude -e STUB_MANAGER_SLEEP=2 \
  -e STUB_CLAUDE_VERSION=2.0.1 -e STUB_NPM_LATEST=2.0.9 -e STUB_NPM_INSTALL_SLEEP=12 \
  -e TURMA_NPM_INSTALL_TIMEOUT=0 -e TURMA_CLAUDE_UPDATE_TIMEOUT=20)"
done_line="$(echo "$out" | grep -n "NPMINSTALL install -g" | head -1 | cut -d: -f1 || true)"
mgr_line="$(echo "$out" | grep -n "MANAGER uid=" | head -1 | cut -d: -f1 || true)"
if [ -n "$done_line" ] && [ -n "$mgr_line" ] && [ "$done_line" -lt "$mgr_line" ]; then
  echo "  ok: a 0 install timeout reads as the default, floor intact"
else
  echo "  FAIL: a 0 timeout disabled the bound and orphaned the install (install=$done_line manager=$mgr_line)"; FAILED=1
fi

echo "== case: an oversized timeout cannot overflow the derived floor"
# The floor is arithmetic, and `$(( ))` WRAPS: an all-digit but oversized value
# produced a NEGATIVE floor, i.e. one below the very sum it exists to exceed, and
# the operator's short deadline was then honoured verbatim — orphaning the
# install again. Nineteen digits is the shape; a millisecond-style 300000 is not.
make_fixture "$WORK/fx18" 0 0
out="$(run_case "$WORK/fx18" -e AGENT=claude -e STUB_MANAGER_SLEEP=2 \
  -e STUB_CLAUDE_VERSION=2.0.1 -e STUB_NPM_LATEST=2.0.9 -e STUB_NPM_INSTALL_SLEEP=12 \
  -e TURMA_NPM_INSTALL_TIMEOUT=9999999999999999999 -e TURMA_CLAUDE_UPDATE_TIMEOUT=5)"
done_line="$(echo "$out" | grep -n "NPMINSTALL install -g" | head -1 | cut -d: -f1 || true)"
mgr_line="$(echo "$out" | grep -n "MANAGER uid=" | head -1 | cut -d: -f1 || true)"
if [ -n "$done_line" ] && [ -n "$mgr_line" ] && [ "$done_line" -lt "$mgr_line" ]; then
  echo "  ok: an absurd per-call timeout falls back to the default, floor intact"
else
  echo "  FAIL: an oversized timeout overflowed the floor and orphaned the install (install=$done_line manager=$mgr_line)"; FAILED=1
fi

echo "== case: a session cannot wedge the boot with a FIFO in ~/.turma"
# /root/.turma is the manager's REGISTRY_DIR, so the dropped identity — every
# Claude session — can write there. Opening a FIFO BLOCKS until the other end
# appears, with no error for `|| true` to catch, which is the PID-1 wedge again:
# a `running` container with no manager, no tunnel and no restart policy firing.
# Both state files are attacked here, and the boot is TIMED, since a wedge shows
# up as "never finished", not as a wrong answer.
make_fixture "$WORK/fx16" 1000 1000
mkdir -p "$WORK/fx16/turma"
docker run --rm -v "$WORK/fx16/turma:/t" busybox sh -c \
  'mkfifo /t/last-claude-check /t/claude-unparseable; chmod 666 /t/*' >/dev/null 2>&1
t0=$(date +%s)
out="$(run_case "$WORK/fx16" -e AGENT=claude -e PUID=1000 -e PGID=1000 \
  -e STUB_MANAGER_SLEEP=2 -e STUB_CLAUDE_VERSION=2.0.1 -e STUB_NPM_LATEST=2.0.9 \
  -e TURMA_CLAUDE_UPDATE_TIMEOUT=25 -v "$WORK/fx16/turma:/root/.turma")"
elapsed=$(( $(date +%s) - t0 ))
if echo "$out" | grep -q "MANAGER uid=" && [ "$elapsed" -lt 25 ]; then
  echo "  ok: booted in ${elapsed}s with both state files replaced by FIFOs"
else
  echo "  FAIL: a session-planted FIFO held the boot ${elapsed}s (wedge, or only the watchdog saved it)"; FAILED=1
fi
docker run --rm -v "$WORK/fx16/turma:/t" busybox sh -c 'rm -f /t/last-claude-check /t/claude-unparseable' >/dev/null 2>&1

echo "== case: nothing in the check can stop the container booting"
# The check is AWAITED, which puts it in `set -e`'s path at PID 1. It used to
# use a fixed /tmp scratch dir, so any session — running as the dropped identity
# — could `touch /tmp/.turma-claude-update` and the next `mkdir -p` failure
# killed PID 1 with a one-line error, on every restart, forever. /tmp is the
# image's writable layer, so it survived restarts and never self-healed.
make_fixture "$WORK/fx12" 1000 1000
# Through `run_case` like every other case, so a regression here fails with a
# diagnostic rather than aborting the suite from inside the `$( )` — see the
# comment on run_case.
out="$(RUN_CASE_SH='mkdir -p /tmp/.turma-claude-update /tmp/turma-claude-update.XXXXXX; chmod 000 /tmp/turma-claude-update.XXXXXX 2>/dev/null; exec /usr/local/bin/entrypoint.sh' \
  run_case "$WORK/fx12" -e AGENT=claude \
  -e STUB_MANAGER_SLEEP=2 -e STUB_CLAUDE_VERSION=2.0.1 -e STUB_NPM_LATEST=2.0.9)"
if echo "$out" | grep -q "MANAGER uid="; then
  echo "  ok: booted with the scratch paths already taken"
else
  echo "  FAIL: a pre-existing /tmp path stopped the container booting: $out"; FAILED=1
fi

echo "== case: the boot check is rate-limited"
# A container in a restart loop would otherwise hit the registry every few
# seconds and pay the check's latency on every pass. ~/.turma is the agent's own
# state dir, so the stamp rides the same mount the rest of its state does.
make_fixture "$WORK/fx13" 0 0
out="$(run_case "$WORK/fx13" -e AGENT=claude -e STUB_MANAGER_SLEEP=2 \
  -e STUB_CLAUDE_VERSION=2.0.1 -e STUB_NPM_LATEST=2.0.9 -v "$WORK/fx13/turma:/root/.turma")"
if echo "$out" | grep -q "NPMINSTALL"; then
  echo "  ok: the first start checks"
else
  echo "  FAIL: the first start ran no check"; FAILED=1
fi
out="$(run_case "$WORK/fx13" -e AGENT=claude -e STUB_MANAGER_SLEEP=2 \
  -e STUB_CLAUDE_VERSION=2.0.1 -e STUB_NPM_LATEST=2.0.9 -v "$WORK/fx13/turma:/root/.turma")"
if echo "$out" | grep -q "claude check skipped"; then
  echo "  ok: a restart seconds later skips it"
else
  echo "  FAIL: a restart loop would check on every pass: $(echo "$out" | grep claude)"; FAILED=1
fi

# --- Case 14: no cluster creds on the device (XERK-369) ----------------------
# kubectl/helm/talosctl/omnictl ship in every image, and a host that gives them
# nothing to authenticate with is a supported configuration exactly like a host
# with no ~/.aws. Same non-fatal contract as the cloud preflight above.
echo "== case: no cluster creds mounted is ignored, not fatal"
make_fixture "$WORK/fx14" 0 0
out="$(run_case "$WORK/fx14")"
for cli in kubectl talosctl omnictl; do
  if echo "$out" | grep -q "\[entrypoint\] ${cli}: installed; no creds on this device"; then
    echo "  ok: ${cli} reported as ignored"
  else
    echo "  FAIL: ${cli} — no 'ignoring' line in output"; FAILED=1
  fi
done
expect "manager still starts" "0" "$(field "$out" uid)"

# --- Case 15: in-cluster ServiceAccount becomes the kubeconfig (XERK-369) ----
# The cluster-side agent mounts NO kubeconfig; its credential is the pod's own
# projected ServiceAccount token. `tokenFile:` is the assertion that matters —
# an inline token would be baked at boot and start failing hours later, in a pod
# that had been up for days and still looked healthy.
echo "== case: in-cluster ServiceAccount is turned into a kubeconfig"
make_fixture "$WORK/fx15" 0 0
mkdir -p "$WORK/fx15/sa"
printf 'not-a-real-token\n' > "$WORK/fx15/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx15/sa/ca.crt"
printf 'turma\n' > "$WORK/fx15/sa/namespace"
out="$(run_case "$WORK/fx15" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 -e KUBERNETES_SERVICE_PORT=443 \
  -v "$WORK/fx15/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro")"
expect "apiserver from the injected env" "https://10.96.0.1:443" "$(field "$out" KUBECFG_SERVER)"
expect "credential is the rotating token FILE" \
  "/var/run/secrets/kubernetes.io/serviceaccount/token" "$(field "$out" KUBECFG_TOKENFILE)"
expect "context namespace is the pod's own" "turma" "$(field "$out" KUBECFG_NS)"
expect "kubeconfig is not world-readable" "600" "$(field "$out" KUBECFG_MODE)"
if echo "$out" | grep -q "\[entrypoint\] kubectl: in-cluster ServiceAccount credential (ns turma)"; then
  echo "  ok: reported as the in-cluster credential, not as a mounted store"
else
  echo "  FAIL: no in-cluster kubectl line in output"; FAILED=1
fi
if echo "$out" | grep -q "\[entrypoint\] kubectl: installed; no creds"; then
  echo "  FAIL: also reported as credential-less"; FAILED=1
else
  echo "  ok: the 'no creds' line is suppressed"
fi

# --- Case 16: a mounted kubeconfig wins over the ServiceAccount (XERK-369) ---
# A pod that IS given a kubeconfig — another cluster, or a real admin credential
# — must keep it. Overwriting it would silently redirect every kubectl call in
# every session on that host at the local API server.
echo "== case: a mounted kubeconfig is never overwritten"
make_fixture "$WORK/fx16" 0 0
mkdir -p "$WORK/fx16/sa" "$WORK/fx16/kube"
printf 'not-a-real-token\n' > "$WORK/fx16/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx16/sa/ca.crt"
printf 'turma\n' > "$WORK/fx16/sa/namespace"
printf 'apiVersion: v1\nkind: Config\nclusters:\n  - name: other\n    cluster:\n      server: https://elsewhere.example:6443\n' \
  > "$WORK/fx16/kube/config"
out="$(run_case "$WORK/fx16" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx16/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -v "$WORK/fx16/kube:/root/.kube")"
expect "the mounted kubeconfig survives" "https://elsewhere.example:6443" \
  "$(field "$out" KUBECFG_SERVER)"
if echo "$out" | grep -q "\[entrypoint\] kubectl: host creds mounted at /root/.kube"; then
  echo "  ok: reported as a mounted store"
else
  echo "  FAIL: a mounted kubeconfig was not reported"; FAILED=1
fi

# --- Case 17: the generated kubeconfig lands host-owned (XERK-369) -----------
# It is written as root, before the manager starts, into a /root the identity
# block has already handed to the run-as user. Left root-owned it is unreadable
# by every session on a PUID host — kubectl fails with a permission error on a
# file the operator can neither see nor fix.
echo "== case: the generated kubeconfig is owned by the run-as user"
make_fixture "$WORK/fx17" 1000 1000
mkdir -p "$WORK/fx17/sa"
printf 'not-a-real-token\n' > "$WORK/fx17/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx17/sa/ca.crt"
printf 'turma\n' > "$WORK/fx17/sa/namespace"
out="$(run_case "$WORK/fx17" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx17/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro")"
expect "manager uid" "1000" "$(field "$out" uid)"
expect "kubeconfig owner" "1000:1000" "$(field "$out" KUBECFG_OWNER)"

# --- Case 18: the kubeconfig block can never fail the boot (XERK-369) --------
# It runs under `set -e` as PID 1, before the manager starts, so every failure
# in it has to be a log line. QA measured three ways it killed or hung the
# container, and each has a case: a /root/.kube that is a FILE (here), an
# unbounded read of a `namespace` that is a fifo (case 19), and an unguarded
# `mkdir` on a read-only root filesystem (case 28). Case 27 covers the write
# failing inside a directory that already exists.
#
# The reason it is allowed to give up so cheaply is that the credential does not
# depend on it: client-go falls back to the in-cluster ServiceAccount on its
# own, so a pod with NO kubeconfig still authenticates. What this block adds is
# a named context and the pod's namespace, which is not worth a boot.
echo "== case: a broken /root/.kube does not stop the container"
make_fixture "$WORK/fx18" 0 0
mkdir -p "$WORK/fx18/sa"
printf 'not-a-real-token\n' > "$WORK/fx18/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx18/sa/ca.crt"
printf 'turma\n' > "$WORK/fx18/sa/namespace"
# /root/.kube is a FILE. In a pod /root is a persistent volume, so this survives
# every restart and the pod could never be repaired from inside — it would never
# get far enough to run anything.
printf 'not a directory\n' > "$WORK/fx18/kubefile"
out="$(run_case "$WORK/fx18" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx18/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -v "$WORK/fx18/kubefile:/root/.kube")"
expect "manager still starts" "0" "$(field "$out" uid)"
if echo "$out" | grep -q "\[entrypoint\] kubectl: cannot create /root/.kube"; then
  echo "  ok: reported and carried on"
else
  echo "  FAIL: no 'cannot create' line — did it die instead? $(echo "$out" | tail -2)"; FAILED=1
fi

echo "== case: a namespace file that blocks on read does not hang PID 1"
make_fixture "$WORK/fx19" 0 0
mkdir -p "$WORK/fx19/sa"
printf 'not-a-real-token\n' > "$WORK/fx19/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx19/sa/ca.crt"
# A fifo: `cat` on it never returns. The container would sit "up" forever with
# no manager and no heartbeat, which the hub can only show as an offline host.
docker run --rm -v "$WORK/fx19/sa:/sa" busybox mkfifo /sa/namespace >/dev/null
out="$(run_case "$WORK/fx19" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx19/sa:/var/run/secrets/kubernetes.io/serviceaccount")"
expect "manager still starts" "0" "$(field "$out" uid)"
expect "and falls back to the default namespace" "default" "$(field "$out" KUBECFG_NS)"

echo "== case: junk in the injected env cannot corrupt the kubeconfig"
make_fixture "$WORK/fx20" 0 0
mkdir -p "$WORK/fx20/sa"
printf 'not-a-real-token\n' > "$WORK/fx20/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx20/sa/ca.crt"
# Everything here is interpolated into a YAML heredoc. These sources are the
# kubelet's, so this is robustness rather than a threat model — but a namespace
# with a stray newline produces a file that parses as something else entirely,
# and that failure would be silent.
printf 'prod\nbogus: injected\n' > "$WORK/fx20/sa/namespace"
out="$(run_case "$WORK/fx20" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 -e 'KUBERNETES_SERVICE_PORT=443
users2: injected' \
  -v "$WORK/fx20/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro")"
expect "a multi-line namespace is rejected, not embedded" "default" "$(field "$out" KUBECFG_NS)"
expect "a non-numeric port falls back to 443" "https://10.96.0.1:443" "$(field "$out" KUBECFG_SERVER)"
# THE ASSERTION THAT ACTUALLY CATCHES THE PORT CASE. `KUBECFG_SERVER` is read
# with `head -1`, so a payload injected through the PORT lands on a later line
# and every field above still reads correct — QA proved a mutant with the port
# validation deleted passing both assertions above with an injected line in the
# file. Count the whole file instead.
expect "nothing was injected anywhere in the file" "0" "$(field "$out" KUBECFG_INJECTED)"
expect "the file is exactly the 19 lines it should be" "19" "$(field "$out" KUBECFG_LINES)"
# Kubernetes accepts `no`, `on`, `off`, `yes`, `true`, `null` and `123` as
# namespace names, and YAML reads every one of them as a bool, a number or
# null. Unquoted, kubectl then refuses to load the file at all — every call in
# the pod dies at config load — while the `namespace:` line reads correctly to
# anything using sed. Four values come from outside; all four must be quoted.
expect "every interpolated scalar is quoted" "4" "$(field "$out" KUBECFG_QUOTED)"

echo "== case: a symlink at /root/.kube/config is never written through"
make_fixture "$WORK/fx21" 0 0
mkdir -p "$WORK/fx21/sa" "$WORK/fx21/kube"
printf 'not-a-real-token\n' > "$WORK/fx21/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx21/sa/ca.crt"
printf 'turma\n' > "$WORK/fx21/sa/namespace"
# A DANGLING symlink fails `-e`, so a naive absence check reads it as "no
# kubeconfig here" and `cat >` then creates whatever it points at — arbitrary
# root-owned file creation at a path somebody else chose.
docker run --rm -v "$WORK/fx21/kube:/k" busybox ln -s /f/repos/victim /k/config >/dev/null
out="$(run_case "$WORK/fx21" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx21/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -v "$WORK/fx21/kube:/root/.kube")"
expect "manager still starts" "0" "$(field "$out" uid)"
expect "the symlink target was not created" "0" \
  "$(docker run --rm -v "$WORK/fx21:/f" busybox sh -c 'test -e /f/repos/victim && echo 1 || echo 0')"

echo "== case: KUBECONFIG in the environment is reported, not ignored"
# The `aws` branch has had this shape for a while: a host configured through the
# environment must not be reported as credential-less because a directory it
# does not use is empty.
make_fixture "$WORK/fx22" 0 0
mkdir -p "$WORK/fx22/sa"
printf 'not-a-real-token\n' > "$WORK/fx22/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx22/sa/ca.crt"
printf 'turma\n' > "$WORK/fx22/sa/namespace"
out="$(run_case "$WORK/fx22" -e KUBECONFIG=/f/repos/elsewhere.yaml \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx22/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro")"
expect "nothing was written" "none" "$(field "$out" KUBECFG_MODE)"
if echo "$out" | grep -q "\[entrypoint\] kubectl: credentials from the environment"; then
  echo "  ok: reported as env-configured"
else
  echo "  FAIL: KUBECONFIG set but not reported"; FAILED=1
fi

echo "== case: a stale generated kubeconfig is refreshed, a mounted one is not"
# /root is a persistent volume in a pod, so the first boot's config would
# otherwise be frozen there forever — a changed apiserver address or namespace
# would lose silently. The marker line on line 1 is what makes "did we write
# this?" decidable, and it is the only thing that makes overwriting safe.
make_fixture "$WORK/fx23" 0 0
mkdir -p "$WORK/fx23/sa" "$WORK/fx23/kube"
printf 'not-a-real-token\n' > "$WORK/fx23/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx23/sa/ca.crt"
printf 'newns\n' > "$WORK/fx23/sa/namespace"
printf '# generated by turma entrypoint.sh from this pod'"'"'s ServiceAccount\napiVersion: v1\nkind: Config\nclusters:\n  - name: in-cluster\n    cluster:\n      server: https://10.0.0.1:443\ncontexts:\n  - name: in-cluster\n    context:\n      namespace: oldns\n' \
  > "$WORK/fx23/kube/config"
out="$(run_case "$WORK/fx23" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx23/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -v "$WORK/fx23/kube:/root/.kube")"
expect "the stale apiserver was refreshed" "https://10.96.0.1:443" "$(field "$out" KUBECFG_SERVER)"
expect "and so was the namespace" "newns" "$(field "$out" KUBECFG_NS)"
# A 0-byte file is the residue of a half-finished write, not a credential: it
# must be regenerated rather than reported as a mounted store forever.
echo "== case: a 0-byte kubeconfig is residue, not a credential"
make_fixture "$WORK/fx24" 0 0
mkdir -p "$WORK/fx24/sa" "$WORK/fx24/kube"
printf 'not-a-real-token\n' > "$WORK/fx24/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx24/sa/ca.crt"
printf 'turma\n' > "$WORK/fx24/sa/namespace"
: > "$WORK/fx24/kube/config"
out="$(run_case "$WORK/fx24" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx24/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -v "$WORK/fx24/kube:/root/.kube")"
expect "regenerated over the empty file" "https://10.96.0.1:443" "$(field "$out" KUBECFG_SERVER)"
# ...and out of a cluster the same empty file must read as no creds at all.
#
# ITS OWN FIXTURE, and that is not tidiness: the run above mounts the directory
# READ-WRITE and regenerates `config` into it, so re-using it here would test a
# 19-line kubeconfig against an assertion about a 0-byte one — which is a FAIL
# on an entrypoint that is behaving correctly. That is how this case shipped
# broken, and re-using a fixture across two runs with different premises is the
# general form of it.
make_fixture "$WORK/fx24b" 0 0
mkdir -p "$WORK/fx24b/kube"
: > "$WORK/fx24b/kube/config"
out="$(run_case "$WORK/fx24b" -v "$WORK/fx24b/kube:/root/.kube")"
if echo "$out" | grep -q "\[entrypoint\] kubectl: installed; no creds on this device"; then
  echo "  ok: an empty config is not reported as a mounted store"
else
  echo "  FAIL: an empty config was reported as creds"; FAILED=1
fi

# --- Case 25: ca.crt is part of the gate (XERK-369) --------------------------
# Without it the config is written and every call then fails with `unable to
# read certificate-authority`. Writing a config that cannot work is worse than
# writing none: with none, client-go's own in-cluster fallback still
# authenticates.
echo "== case: no ca.crt means no kubeconfig, not a broken one"
make_fixture "$WORK/fx25" 0 0
mkdir -p "$WORK/fx25/sa"
printf 'not-a-real-token\n' > "$WORK/fx25/sa/token"
printf 'turma\n' > "$WORK/fx25/sa/namespace"
out="$(run_case "$WORK/fx25" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx25/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro")"
expect "nothing was written" "none" "$(field "$out" KUBECFG_MODE)"
if echo "$out" | grep -q "\[entrypoint\] kubectl: installed; no creds on this device"; then
  echo "  ok: reported as credential-less"
else
  echo "  FAIL: a config was written without a CA to verify the apiserver"; FAILED=1
fi

# --- Case 26: the write does not touch the process umask (XERK-369) ----------
# The manager is PID 1 and every session inherits its umask, so a `umask 077 …
# umask 022` pair around the write silently changes the mode of every file every
# session on the host goes on to create — and restores a hardcoded value rather
# than the operator's. QA measured exactly that: parent 077, manager 022.
echo "== case: the kubeconfig write leaves the umask alone"
make_fixture "$WORK/fx26" 0 0
mkdir -p "$WORK/fx26/sa"
printf 'not-a-real-token\n' > "$WORK/fx26/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx26/sa/ca.crt"
printf 'turma\n' > "$WORK/fx26/sa/namespace"
# docker has no umask flag, so set it in a shell that then becomes PID 1 —
# the same trick the scratch-path case below uses.
out="$(RUN_CASE_SH='umask 077; exec /usr/local/bin/entrypoint.sh' \
  run_case "$WORK/fx26" -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx26/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro")"
expect "the config was still written" "600" "$(field "$out" KUBECFG_MODE)"
expect "and the manager kept the umask it was given" "0077" "$(field "$out" MANAGER_UMASK)"

# --- Case 27: an unwritable /root/.kube is reported, not fatal (XERK-369) ----
# Reaches the `cannot write` branch, which case 18's unwritable-PARENT case does
# not: here `mkdir -p` succeeds because the directory already exists, and the
# write inside it is what fails. In a pod this is a read-only projected volume
# or a full filesystem.
echo "== case: an unwritable /root/.kube is reported, not fatal"
make_fixture "$WORK/fx27" 0 0
mkdir -p "$WORK/fx27/sa" "$WORK/fx27/kube"
printf 'not-a-real-token\n' > "$WORK/fx27/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx27/sa/ca.crt"
printf 'turma\n' > "$WORK/fx27/sa/namespace"
out="$(run_case "$WORK/fx27" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx27/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -v "$WORK/fx27/kube:/root/.kube:ro")"
expect "manager still starts" "0" "$(field "$out" uid)"
if echo "$out" | grep -q "\[entrypoint\] kubectl: cannot write /root/.kube/config"; then
  echo "  ok: reported and carried on"
else
  echo "  FAIL: no 'cannot write' line: $(echo "$out" | grep -i kubectl || echo none)"; FAILED=1
fi

# --- Case 28: a whole read-only root filesystem still boots (XERK-369) -------
# `readOnlyRootFilesystem: true` is the obvious hardening for the pod XERK-369
# ships, and before this block every preflight in this file survived it. The
# failure it caused was a CrashLoopBackOff with one `mkdir:` line as the only
# clue.
echo "== case: a read-only root filesystem still boots"
make_fixture "$WORK/fx28" 0 0
mkdir -p "$WORK/fx28/sa"
printf 'not-a-real-token\n' > "$WORK/fx28/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx28/sa/ca.crt"
printf 'turma\n' > "$WORK/fx28/sa/namespace"
out="$(RUN_CASE_DOCKER_ARGS='--read-only --tmpfs /tmp --tmpfs /run' \
  run_case "$WORK/fx28" -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx28/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro")"
expect "manager still starts" "0" "$(field "$out" uid)"
if echo "$out" | grep -q "\[entrypoint\] kubectl: cannot create /root/.kube"; then
  echo "  ok: reported and carried on"
else
  echo "  FAIL: no 'cannot create' line — did it die instead? $(echo "$out" | tail -2)"; FAILED=1
fi

# --- Case 29: the marker must match line 1 EXACTLY (XERK-369) ---------------
# A substring match would claim a file whose first line is "<marker> (operator
# copy) do not touch" — someone deliberately recording where their file came
# from is the likeliest way to write that line.
echo "== case: a marker with a suffix is the operator's file, not ours"
make_fixture "$WORK/fx29" 0 0
mkdir -p "$WORK/fx29/sa" "$WORK/fx29/kube"
printf 'not-a-real-token\n' > "$WORK/fx29/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx29/sa/ca.crt"
printf 'turma\n' > "$WORK/fx29/sa/namespace"
printf '# generated by turma entrypoint.sh from this pod'"'"'s ServiceAccount (operator copy) do not touch\nclusters:\n  - name: mine\n    cluster:\n      server: "https://mine.example:6443"\n' \
  > "$WORK/fx29/kube/config"
out="$(run_case "$WORK/fx29" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx29/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -v "$WORK/fx29/kube:/root/.kube")"
expect "the operator's file survives" "https://mine.example:6443" "$(field "$out" KUBECFG_SERVER)"

# --- Case 30: the block is silent when nothing reads a kubeconfig (XERK-369) -
# `cloud_creds` stays silent for a CLI the image does not ship, and this has to
# match: an image with neither kubectl nor helm has nothing to configure.
echo "== case: no kubectl and no helm means no kubeconfig and no log line"
make_fixture "$WORK/fx30" 0 0
mkdir -p "$WORK/fx30/sa"
printf 'not-a-real-token\n' > "$WORK/fx30/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx30/sa/ca.crt"
printf 'turma\n' > "$WORK/fx30/sa/namespace"
# Remove both stubs, so `command -v` finds neither on PATH.
out="$(RUN_CASE_SH='rm -f /usr/local/bin/kubectl /usr/local/bin/helm; exec /usr/local/bin/entrypoint.sh' \
  run_case "$WORK/fx30" -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx30/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro")"
expect "manager still starts" "0" "$(field "$out" uid)"
expect "no kubeconfig was written" "none" "$(field "$out" KUBECFG_MODE)"
if echo "$out" | grep -q "\[entrypoint\] kubectl:"; then
  echo "  FAIL: logged about a CLI the image does not have"; FAILED=1
else
  echo "  ok: silent, like cloud_creds is for an absent CLI"
fi

# ...and helm ALONE still gets a kubeconfig, logged under its own name. helm
# shares client-go's loader, so the file is for it too — but calling the line
# `kubectl:` would break the rule the half above enforces.
echo "== case: helm alone still gets a kubeconfig, named as helm"
out="$(RUN_CASE_SH='rm -f /usr/local/bin/kubectl; exec /usr/local/bin/entrypoint.sh' \
  run_case "$WORK/fx30" -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx30/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro")"
expect "the config was written for helm" "600" "$(field "$out" KUBECFG_MODE)"
if echo "$out" | grep -q "\[entrypoint\] helm: in-cluster ServiceAccount credential"; then
  echo "  ok: logged under the CLI that is actually installed"
else
  echo "  FAIL: not reported as helm: $(echo "$out" | grep -E 'kubectl:|helm:' || echo none)"; FAILED=1
fi

# ...and the same for the PREFLIGHT line, which is the other half of the split.
# Gated on kubectl alone, a helm-only image with host creds mounted says nothing
# at all, while a kubectl-only one reports them — an asymmetry with no reason
# behind it.
echo "== case: helm alone still reports mounted host creds"
mkdir -p "$WORK/fx30/kube"
printf 'apiVersion: v1\nkind: Config\nclusters: []\n' > "$WORK/fx30/kube/config"
out="$(RUN_CASE_SH='rm -f /usr/local/bin/kubectl; exec /usr/local/bin/entrypoint.sh' \
  run_case "$WORK/fx30" -v "$WORK/fx30/kube:/root/.kube")"
if echo "$out" | grep -q "\[entrypoint\] helm: host creds mounted at /root/.kube"; then
  echo "  ok: reported under helm"
else
  echo "  FAIL: helm-only image said nothing about mounted creds: $(echo "$out" | grep -E 'kubectl:|helm:' || echo none)"; FAILED=1
fi

# BOTH branches of that line, not just one: hardcoding `kubectl` in the no-creds
# half passed while the gate and the mounted half were pinned, which puts the
# name of a CLI the image does not ship back in the log.
echo "== case: and names itself in the no-creds line too"
out="$(RUN_CASE_SH='rm -f /usr/local/bin/kubectl; exec /usr/local/bin/entrypoint.sh' \
  run_case "$WORK/fx30")"
if echo "$out" | grep -q "\[entrypoint\] helm: installed; no creds on this device"; then
  echo "  ok: reported under helm"
else
  echo "  FAIL: wrong CLI in the no-creds line: $(echo "$out" | grep -E 'kubectl:|helm:' || echo none)"; FAILED=1
fi

# --- Case 31: the temp sweep is ours, and ONLY ours (XERK-369) --------------
# The write goes through `mktemp`, which — unlike the fixed `config.new` it
# replaced — is not self-limiting: a crash between the mktemp and the mv leaves
# one behind every time, on a volume that in a pod outlives the container. So it
# has to be swept.
#
# BOTH HALVES OR NEITHER. An earlier revision swept with a glob over the whole
# of /root/.kube, and QA measured it destroying a planted `.config.backup` and
# `.config.2026-0` — a wider hazard than the single fixed name the change set
# out to stop clobbering, in the directory the compose deployment documents as
# the operator's own credential store. The second assertion here is the one
# that catches that, and widening the glob passes the first on its own.
echo "== case: stray temp files are swept, and only ours are"
make_fixture "$WORK/fx31" 0 0
mkdir -p "$WORK/fx31/sa" "$WORK/fx31/kube/.turma-tmp"
printf 'not-a-real-token\n' > "$WORK/fx31/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx31/sa/ca.crt"
printf 'turma\n' > "$WORK/fx31/sa/namespace"
# What a crashed write leaves: ours, in our own directory.
: > "$WORK/fx31/kube/.turma-tmp/config.aB3xYz"
: > "$WORK/fx31/kube/.turma-tmp/config.qQ9zPl"
# What an operator plausibly keeps beside their kubeconfig. None of these is
# ours and none may be touched. The first two are the exact names QA destroyed
# with the original glob; the next three are NON-hidden, which is what a real
# ~/.kube mostly contains and what the first version of this assertion missed;
# and the last two are a DIRECTORY and a SYMLINK, because counting regular files
# only let a sweep destroying either pass clean — and `cache/` is a directory
# kubectl creates in there itself.
: > "$WORK/fx31/kube/.config.backup"
: > "$WORK/fx31/kube/.config.2026-0"
: > "$WORK/fx31/kube/.config.bak"
: > "$WORK/fx31/kube/admin.conf"
: > "$WORK/fx31/kube/kubeconfig-prod.yaml"
: > "$WORK/fx31/kube/ca.crt"
mkdir -p "$WORK/fx31/kube/cache/discovery"
docker run --rm -v "$WORK/fx31/kube:/k" busybox ln -s /k/admin.conf /k/prod-link >/dev/null
out="$(run_case "$WORK/fx31" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx31/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -v "$WORK/fx31/kube:/root/.kube")"
expect "the config was still written" "https://10.96.0.1:443" "$(field "$out" KUBECFG_SERVER)"
expect "our own strays are gone" "0" "$(field "$out" KUBECFG_STRAYS)"
expect "and the operator's files are all still there" "8" "$(field "$out" KUBECFG_NEIGHBOURS)"
expect "and the staging directory with them" "gone" "$(field "$out" KUBECFG_TMPDIR)"

# --- Case 32: a symlink at the staging path is not followed (XERK-369) ------
# THE ONE THAT MATTERS MOST IN THIS BLOCK. `mkdir -p` succeeds on a symlink to a
# directory, so a sweep of `$KUBE_TMPDIR/*` globs THROUGH it and root empties
# whatever it points at, with the boot still reporting success. And the planter
# needs no privilege: the identity self-heal re-owns everything under
# /root/.kube on every drop-priv boot and /root itself is chowned there too, so
# any session on the host can create this. (It is NOT the kubeconfig block's own
# `chown` that does it — believing that is what nearly let a narrowing of that
# chown look like it closed this hole.) QA emptied a mounted repo that way.
# `rm -rf` on the path unlinks the LINK and never traverses.
echo "== case: a symlink at .turma-tmp does not get its target emptied"
make_fixture "$WORK/fx32" 0 0
mkdir -p "$WORK/fx32/sa" "$WORK/fx32/kube"
printf 'not-a-real-token\n' > "$WORK/fx32/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx32/sa/ca.crt"
printf 'turma\n' > "$WORK/fx32/sa/namespace"
# The target: three files in the mounted git root, which is the most valuable
# thing reachable from that directory and the one QA actually destroyed.
docker run --rm -v "$WORK/fx32:/f" busybox sh -c \
  'mkdir -p /f/repos/precious && touch /f/repos/precious/a /f/repos/precious/b /f/repos/precious/c
   ln -s /f/repos/precious /f/kube/.turma-tmp' >/dev/null
out="$(run_case "$WORK/fx32" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx32/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -v "$WORK/fx32/kube:/root/.kube")"
expect "manager still starts" "0" "$(field "$out" uid)"
expect "the symlink's target is untouched" "3" \
  "$(docker run --rm -v "$WORK/fx32:/f" busybox sh -c 'ls /f/repos/precious 2>/dev/null | wc -l' | tr -d ' ')"
expect "and the config was still written" "https://10.96.0.1:443" "$(field "$out" KUBECFG_SERVER)"

# --- Case 33: leftovers do not disable generation forever (XERK-369) --------
# `rm -f dir/*` returns non-zero on a subdirectory, so ONE stray directory in
# the staging path failed the whole write condition — and kept failing it on
# every later boot, permanently, while leaving the staging directory behind.
# It failed safe, which is exactly why it would never have been noticed.
echo "== case: a leftover directory in the staging path is cleared, not fatal"
make_fixture "$WORK/fx33" 0 0
mkdir -p "$WORK/fx33/sa" "$WORK/fx33/kube/.turma-tmp/leftover"
printf 'not-a-real-token\n' > "$WORK/fx33/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx33/sa/ca.crt"
printf 'turma\n' > "$WORK/fx33/sa/namespace"
: > "$WORK/fx33/kube/.turma-tmp/leftover/deep"
out="$(run_case "$WORK/fx33" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx33/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -v "$WORK/fx33/kube:/root/.kube")"
expect "the config was written anyway" "https://10.96.0.1:443" "$(field "$out" KUBECFG_SERVER)"
expect "and the staging directory is gone" "gone" "$(field "$out" KUBECFG_TMPDIR)"

# --- Case 34: a regular file at the staging path is cleared (XERK-369) ------
echo "== case: a regular file at .turma-tmp is cleared, not fatal"
make_fixture "$WORK/fx34" 0 0
mkdir -p "$WORK/fx34/sa" "$WORK/fx34/kube"
printf 'not-a-real-token\n' > "$WORK/fx34/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx34/sa/ca.crt"
printf 'turma\n' > "$WORK/fx34/sa/namespace"
printf 'not a directory\n' > "$WORK/fx34/kube/.turma-tmp"
out="$(run_case "$WORK/fx34" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx34/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -v "$WORK/fx34/kube:/root/.kube")"
expect "manager still starts" "0" "$(field "$out" uid)"
expect "the config was written anyway" "https://10.96.0.1:443" "$(field "$out" KUBECFG_SERVER)"

# --- Case 35: /root/.kube ITSELF as a symlink is refused (XERK-369) ---------
# One level up from case 32, and reachable by any session: the identity block
# chowns /root to the run-as identity, so a session can replace the whole
# directory. `mkdir -p` succeeds on a symlink to a directory, and then the
# staging clear-out deletes inside the session's chosen target and the config
# lands there root-owned. QA measured both. Unlike `.turma-tmp`, this path is
# plausibly an operator's own redirect, so it is REFUSED rather than cleared.
echo "== case: /root/.kube as a symlink is refused, not written through"
make_fixture "$WORK/fx35" 0 0
mkdir -p "$WORK/fx35/sa"
printf 'not-a-real-token\n' > "$WORK/fx35/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx35/sa/ca.crt"
printf 'turma\n' > "$WORK/fx35/sa/namespace"
docker run --rm -v "$WORK/fx35:/f" busybox sh -c \
  'mkdir -p /f/repos/target/.turma-tmp
   touch /f/repos/target/a /f/repos/target/b /f/repos/target/.turma-tmp/inner' >/dev/null
out="$(RUN_CASE_SH='ln -s /f/repos/target /root/.kube; exec /usr/local/bin/entrypoint.sh' \
  run_case "$WORK/fx35" -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx35/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro")"
expect "manager still starts" "0" "$(field "$out" uid)"
expect "no config was written into the target" "0" \
  "$(docker run --rm -v "$WORK/fx35:/f" busybox sh -c 'test -e /f/repos/target/config && echo 1 || echo 0')"
expect "and the target's own staging dir was not deleted" "1" \
  "$(docker run --rm -v "$WORK/fx35:/f" busybox sh -c 'test -e /f/repos/target/.turma-tmp/inner && echo 1 || echo 0')"
if echo "$out" | grep -q "\[entrypoint\] kubectl: /root/.kube is a symlink — refusing"; then
  echo "  ok: refused, and said why"
else
  echo "  FAIL: no refusal line: $(echo "$out" | grep -E 'kubectl:' || echo none)"; FAILED=1
fi

# --- Case 36: a failed stage leaves nothing behind (XERK-369) --------------
# The `mkdir` can succeed and only the `mktemp` fail, which is the one exit of
# the three that did NOT clear up while three comments claimed all of them did.
# Removing mktemp from PATH is the only way to reach it.
echo "== case: a failed stage leaves no staging directory"
make_fixture "$WORK/fx36" 0 0
mkdir -p "$WORK/fx36/sa" "$WORK/fx36/kube"
printf 'not-a-real-token\n' > "$WORK/fx36/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx36/sa/ca.crt"
printf 'turma\n' > "$WORK/fx36/sa/namespace"
out="$(RUN_CASE_SH='rm -f /usr/bin/mktemp /bin/mktemp; exec /usr/local/bin/entrypoint.sh' \
  run_case "$WORK/fx36" -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx36/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -v "$WORK/fx36/kube:/root/.kube")"
expect "manager still starts" "0" "$(field "$out" uid)"
expect "nothing was staged" "gone" "$(field "$out" KUBECFG_TMPDIR)"
if echo "$out" | grep -q "\[entrypoint\] kubectl: cannot write /root/.kube/config"; then
  echo "  ok: reported and carried on"
else
  echo "  FAIL: no 'cannot write' line: $(echo "$out" | grep -E 'kubectl:' || echo none)"; FAILED=1
fi

# --- Case 37: the ownership fix-up is the FILE, not the tree (XERK-369) ----
# A dropped session has to read the config we just wrote, and that is all the
# `chown` is for. `-R` also re-homes the operator's own material — and the
# identity self-heal has already re-owned everything root-owned under
# /root/.kube earlier in the same boot, so `-R` adds nothing but that damage.
# The probe file is owned by a THIRD uid, which the self-heal deliberately skips
# (it only touches uid 0), so it isolates what this chown does.
echo "== case: the kubeconfig chown does not re-home the operator's files"
make_fixture "$WORK/fx37" 1000 1000
mkdir -p "$WORK/fx37/sa" "$WORK/fx37/kube"
printf 'not-a-real-token\n' > "$WORK/fx37/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx37/sa/ca.crt"
printf 'turma\n' > "$WORK/fx37/sa/namespace"
docker run --rm -v "$WORK/fx37/kube:/k" busybox sh -c \
  'touch /k/admin.conf && chown 2000:2000 /k/admin.conf /k' >/dev/null
out="$(run_case "$WORK/fx37" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx37/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -v "$WORK/fx37/kube:/root/.kube")"
expect "the config is readable by the session" "1000:1000" "$(field "$out" KUBECFG_OWNER)"
expect "the operator's own file keeps its owner" "2000:2000" \
  "$(docker run --rm -v "$WORK/fx37/kube:/k" busybox stat -c '%u:%g' /k/admin.conf)"
# ...and the directory itself is left alone, because this block did not create
# it. Case 39 is the other half: one it DID create must be handed over. Both
# the directory and the probe file are uid 2000 for the same reason — the
# identity self-heal re-owns anything root-owned under /root/.kube before this
# block runs, so a root-owned probe could not tell the two rules apart.
expect "and the mounted directory is not re-owned" "2000:2000" "$(field "$out" KUBEDIR_OWNER)"

# --- Case 38: a failed replace leaves nothing behind (XERK-369) -------------
# The last of the three exits from the write, and the one that looked
# unreachable: `mv` is called unqualified and /usr/local/bin precedes /bin, so a
# stub that fails for this destination alone reaches the branch without
# disturbing anything else that moves a file.
echo "== case: a failed replace leaves no staging directory"
make_fixture "$WORK/fx38" 0 0
mkdir -p "$WORK/fx38/sa" "$WORK/fx38/kube"
printf 'not-a-real-token\n' > "$WORK/fx38/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx38/sa/ca.crt"
printf 'turma\n' > "$WORK/fx38/sa/namespace"
out="$(RUN_CASE_SH='printf "#!/bin/sh\nfor a in \"\$@\"; do [ \"\$a\" = /root/.kube/config ] && exit 1; done\nexec /bin/mv \"\$@\"\n" > /usr/local/bin/mv; chmod +x /usr/local/bin/mv; exec /usr/local/bin/entrypoint.sh' \
  run_case "$WORK/fx38" -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx38/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -v "$WORK/fx38/kube:/root/.kube")"
expect "manager still starts" "0" "$(field "$out" uid)"
expect "nothing was staged" "gone" "$(field "$out" KUBECFG_TMPDIR)"
if echo "$out" | grep -q "\[entrypoint\] kubectl: cannot replace /root/.kube/config"; then
  echo "  ok: reported and carried on"
else
  echo "  FAIL: no 'cannot replace' line: $(echo "$out" | grep -E 'kubectl:' || echo none)"; FAILED=1
fi

# --- Case 39: a ~/.kube this block CREATED is handed over (XERK-369) --------
# The identity self-heal skips paths that do not exist, and it runs long before
# this block — so a /root/.kube created here is the one directory it never
# re-owns. Left root-owned, the session can read the config and nothing else:
# `kubectl config set-context` fails on config.lock and kubectl gets no
# discovery cache at all, while every assertion about the FILE still passes.
# That is why the directory has an assertion of its own.
echo "== case: a ~/.kube this block created is owned by the run-as user"
make_fixture "$WORK/fx39" 1500 1500
mkdir -p "$WORK/fx39/sa"
printf 'not-a-real-token\n' > "$WORK/fx39/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx39/sa/ca.crt"
printf 'turma\n' > "$WORK/fx39/sa/namespace"
out="$(run_case "$WORK/fx39" \
  -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx39/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro")"
expect "manager uid" "1500" "$(field "$out" uid)"
expect "the config is the session's" "1500:1500" "$(field "$out" KUBECFG_OWNER)"
expect "and so is the directory it sits in" "1500:1500" "$(field "$out" KUBEDIR_OWNER)"

# --- Case 40: a created ~/.kube is handed over even when the write fails ----
# Case 39 covers the success exit. The THREE failure exits — stage-fail here,
# write-fail (case 43) and replace-fail (case 41) — create the directory
# just the same, and the harm is identical: a dropped session can read the
# config it does not have and write nothing — no `kubectl config` mutation, no
# discovery cache — repaired only on the next boot, which on an ephemeral root
# filesystem never comes. So the hand-over belongs where the directory is
# created, not where the write succeeds.
#
# Note the fixture: 1500, and NO /root/.kube mount. Case 38 uses a root fixture,
# so `DROP_PRIV` is `no` there and the ownership question never arises — which
# is exactly why it could not catch this.
echo "== case: a created ~/.kube is handed over even when the write fails"
make_fixture "$WORK/fx40" 1500 1500
mkdir -p "$WORK/fx40/sa"
printf 'not-a-real-token\n' > "$WORK/fx40/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx40/sa/ca.crt"
printf 'turma\n' > "$WORK/fx40/sa/namespace"
out="$(RUN_CASE_SH='rm -f /usr/bin/mktemp /bin/mktemp; exec /usr/local/bin/entrypoint.sh' \
  run_case "$WORK/fx40" -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx40/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro")"
expect "manager uid" "1500" "$(field "$out" uid)"
expect "no config was written" "none" "$(field "$out" KUBECFG_MODE)"
expect "but the directory is still the session's" "1500:1500" "$(field "$out" KUBEDIR_OWNER)"

# --- Case 41: the replace exit hands the directory over too (XERK-369) ------
# Case 38 reaches this exit but cannot see the hand-over: its fixture is
# root-owned, so `DROP_PRIV` is `no` and the ownership question never arises.
# This is the same exit with a dropped identity and no mounted ~/.kube — the
# combination the whole hand-over rule is about.
echo "== case: a created ~/.kube is handed over when the replace fails"
make_fixture "$WORK/fx41" 1500 1500
mkdir -p "$WORK/fx41/sa"
printf 'not-a-real-token\n' > "$WORK/fx41/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx41/sa/ca.crt"
printf 'turma\n' > "$WORK/fx41/sa/namespace"
out="$(RUN_CASE_SH='printf "#!/bin/sh\nfor a in \"\$@\"; do [ \"\$a\" = /root/.kube/config ] && exit 1; done\nexec /bin/mv \"\$@\"\n" > /usr/local/bin/mv; chmod +x /usr/local/bin/mv; exec /usr/local/bin/entrypoint.sh' \
  run_case "$WORK/fx41" -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx41/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro")"
expect "manager uid" "1500" "$(field "$out" uid)"
expect "no config was written" "none" "$(field "$out" KUBECFG_MODE)"
expect "but the directory is still the session's" "1500:1500" "$(field "$out" KUBEDIR_OWNER)"

# --- Case 42: the hand-over chown does not follow a symlink (XERK-369) ------
# `chown` follows a symlink ARGUMENT, so a symlink appearing at /root/.kube
# between the `-L` guard and the chown would have its TARGET re-owned — a
# stronger primitive than anything else in this block, since the target is a
# directory somebody else chose. `-h` chowns the link instead.
#
# The race is not winnable in practice (nothing runs as the session identity
# during boot), so it is staged with a `mkdir` stub that plants the symlink at
# exactly that moment.
#
# THIS PINS THE DIRECTORY CHOWN'S `-h`, AND ONLY THAT ONE. Dropping `-h` from
# the CONFIG chown passes all of this suite, and no case here can catch it:
# `kube_config_is_ours` refuses a symlinked `config`, and `mv -f` replaces the
# destination rather than following it, so the only way to observe that one is a
# race between the `mv` and the `chown`. It stays `-h` as defence in depth
# against a shape this harness cannot construct — do not read its presence as
# tested.
echo "== case: the hand-over chown does not follow a planted symlink"
make_fixture "$WORK/fx42" 1500 1500
mkdir -p "$WORK/fx42/sa"
printf 'not-a-real-token\n' > "$WORK/fx42/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx42/sa/ca.crt"
printf 'turma\n' > "$WORK/fx42/sa/namespace"
out="$(RUN_CASE_SH='printf "#!/bin/sh\nfor a in \"\$@\"; do if [ \"\$a\" = /root/.kube ]; then /bin/mkdir -p /tmp/victim && /bin/ln -s /tmp/victim /root/.kube && exit 0; fi; done\nexec /bin/mkdir \"\$@\"\n" > /usr/local/bin/mkdir; chmod +x /usr/local/bin/mkdir; exec /usr/local/bin/entrypoint.sh' \
  run_case "$WORK/fx42" -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx42/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro")"
expect "manager still starts" "1500" "$(field "$out" uid)"
expect "the link itself was re-owned" "1500:1500" "$(field "$out" KUBEDIR_OWNER)"
expect "and its target was not" "0:0" "$(field "$out" VICTIM_OWNER)"

# --- Case 43: the write exit clears up and hands over (XERK-369) ------------
# The last of the three failure exits, and the one previously written off as
# unreachable. It is not: a `/root` tmpfs filled to 100% lets `mkdir` and
# `mktemp` succeed — they allocate metadata, not blocks — and fails only the
# heredoc, which is exactly this branch. No stub of any kind.
#
# Two things go untested without it, and QA measured both escaping the whole
# suite: this branch's own `rm -rf` (delete it and `.turma-tmp` is left behind
# on a volume that in a pod outlives the container), and the hand-over of a
# directory the block created on the way to failing.
echo "== case: the write exit clears up, and still hands the directory over"
make_fixture "$WORK/fx43" 1500 1500
mkdir -p "$WORK/fx43/sa"
printf 'not-a-real-token\n' > "$WORK/fx43/sa/token"
printf -- '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n' > "$WORK/fx43/sa/ca.crt"
printf 'turma\n' > "$WORK/fx43/sa/namespace"
out="$(RUN_CASE_DOCKER_ARGS='--tmpfs /root:size=64k,mode=0755,exec' \
  RUN_CASE_SH='dd if=/dev/zero of=/root/filler bs=1k count=64 2>/dev/null; exec /usr/local/bin/entrypoint.sh' \
  run_case "$WORK/fx43" -e KUBERNETES_SERVICE_HOST=10.96.0.1 \
  -v "$WORK/fx43/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro")"
expect "manager uid" "1500" "$(field "$out" uid)"
expect "no config was written" "none" "$(field "$out" KUBECFG_MODE)"
expect "nothing was staged" "gone" "$(field "$out" KUBECFG_TMPDIR)"
expect "and the directory is still the session's" "1500:1500" "$(field "$out" KUBEDIR_OWNER)"
if echo "$out" | grep -q "\[entrypoint\] kubectl: cannot write /root/.kube/config"; then
  echo "  ok: reported and carried on"
else
  echo "  FAIL: no 'cannot write' line: $(echo "$out" | grep -E 'kubectl:' || echo none)"; FAILED=1
fi

echo
if [ "$FAILED" -eq 0 ]; then echo "all entrypoint identity cases passed"; else echo "FAILURES"; fi
exit "$FAILED"
