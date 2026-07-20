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
echo "ROOTDIR_OWNER=$(stat -c '%u:%g' /root)"
touch "$REPOS_ROOT/.probe" 2>/dev/null || true
echo "NEWFILE_OWNER=$(stat -c '%u:%g' "$REPOS_ROOT/.probe" 2>/dev/null || echo none)"
echo "LEFTOVER_ROOT_PATHS=$(find "$REPOS_ROOT" /root/.claude -uid 0 2>/dev/null | wc -l)"
# Configurable lifetime: the manager is PID 1, so how long IT lives is how long
# the container lives — the tunnel-supervision case needs a few seconds.
sleep "${STUB_MANAGER_SLEEP:-1}"
STUB
cp "$WORK/python3" "$WORK/hub-agent.py"
echo 'console.log("TUNNEL uid=" + process.getuid() + " gid=" + process.getgid());' \
  > "$WORK/tunnel-agent.js"

# Stand-ins for the cloud CLIs the real image bundles. The preflight only ever
# probes `command -v` and the creds store on disk — it deliberately never runs
# these — so a stub on PATH exercises it exactly as the 1 GB of real ones would.
for cli in aws az terraform; do
  printf '#!/bin/sh\necho "%s stub should not be invoked" >&2\nexit 1\n' "$cli" \
    > "$WORK/$cli"
done

cat > "$WORK/Dockerfile" <<'DOCKERFILE'
FROM node:24-bookworm-slim
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY python3 /usr/local/bin/python3
COPY hub-agent.py tunnel-agent.js aws az terraform /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/python3 \
      /usr/local/bin/aws /usr/local/bin/az /usr/local/bin/terraform
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
expect "manager still starts" "0" "$(field "$out" uid)"

echo "== case: no AZDO creds means no git-auth wiring"
make_fixture "$WORK/fx9e" 0 0
out="$(run_case "$WORK/fx9e")"
if echo "$out" | grep -q "WIRE_AZURE_GIT called"; then
  echo "  FAIL: git-auth wiring invoked with no AZDO creds"; FAILED=1
else
  echo "  ok: git-auth wiring skipped without AZDO creds"
fi

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

echo
if [ "$FAILED" -eq 0 ]; then echo "all entrypoint identity cases passed"; else echo "FAILURES"; fi
exit "$FAILED"
