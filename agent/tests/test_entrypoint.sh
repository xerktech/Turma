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
# Requires docker (the runner has it; the Node suite already relies on it).
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
for cli in aws az terraform; do
  printf '#!/bin/sh\necho "%s stub should not be invoked" >&2\nexit 1\n' "$cli" \
    > "$WORK/$cli"
done

# Stand-ins for the Claude Code update check (XERK-254). The real image bakes
# claude at build time and has a real npm; both are stubbed so the case observes
# the DECISION without reaching the npm registry — and so a test run can never
# install anything. Driven by STUB_CLAUDE_VERSION / STUB_NPM_LATEST.
cat > "$WORK/claude" <<'STUB'
#!/bin/sh
[ "$1" = "--version" ] && { echo "${STUB_CLAUDE_VERSION:-1.0.0} (Claude Code)"; exit 0; }
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
COPY hub-agent.py tunnel-agent.js aws az terraform /usr/local/bin/
# Last, so they shadow the base image's real npm.
COPY claude npm /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/python3 \
      /usr/local/bin/aws /usr/local/bin/az /usr/local/bin/terraform \
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
run_case() {
  local dir="$1"; shift
  docker run --rm -e AGENT=none -e REPOS_ROOT=/f/repos -e DEVICE_NAME=x "$@" \
    -v "$dir/repos:/f/repos" -v "$dir/claude:/root/.claude" "$IMG" 2>&1
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

echo "== case: nothing in the check can stop the container booting"
# The check is AWAITED, which puts it in `set -e`'s path at PID 1. It used to
# use a fixed /tmp scratch dir, so any session — running as the dropped identity
# — could `touch /tmp/.turma-claude-update` and the next `mkdir -p` failure
# killed PID 1 with a one-line error, on every restart, forever. /tmp is the
# image's writable layer, so it survived restarts and never self-healed.
make_fixture "$WORK/fx12" 1000 1000
out="$(docker run --rm -e AGENT=claude -e REPOS_ROOT=/f/repos -e DEVICE_NAME=x \
  -e STUB_MANAGER_SLEEP=2 -e STUB_CLAUDE_VERSION=2.0.1 -e STUB_NPM_LATEST=2.0.9 \
  -v "$WORK/fx12/repos:/f/repos" -v "$WORK/fx12/claude:/root/.claude" \
  --entrypoint /bin/sh "$IMG" -c \
  'mkdir -p /tmp/.turma-claude-update /tmp/turma-claude-update.XXXXXX; \
   chmod 000 /tmp/turma-claude-update.XXXXXX 2>/dev/null; \
   exec /usr/local/bin/entrypoint.sh' 2>&1)"
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

echo
if [ "$FAILED" -eq 0 ]; then echo "all entrypoint identity cases passed"; else echo "FAILURES"; fi
exit "$FAILED"
