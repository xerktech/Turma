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
echo "MANAGER uid=$(id -u) gid=$(id -g) home=$HOME"
echo "ROOTDIR_OWNER=$(stat -c '%u:%g' /root)"
touch "$REPOS_ROOT/.probe" 2>/dev/null || true
echo "NEWFILE_OWNER=$(stat -c '%u:%g' "$REPOS_ROOT/.probe" 2>/dev/null || echo none)"
echo "LEFTOVER_ROOT_PATHS=$(find "$REPOS_ROOT" /root/.claude -uid 0 2>/dev/null | wc -l)"
sleep 1
STUB
cp "$WORK/python3" "$WORK/hub-agent.py"
echo 'console.log("TUNNEL uid=" + process.getuid() + " gid=" + process.getgid());' \
  > "$WORK/tunnel-agent.js"

cat > "$WORK/Dockerfile" <<'DOCKERFILE'
FROM node:24-bookworm-slim
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY python3 /usr/local/bin/python3
COPY hub-agent.py tunnel-agent.js /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/python3
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

# --- Case 2: user-owned git root (WSL / desktop, e.g. maxai) -----------------
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

echo
if [ "$FAILED" -eq 0 ]; then echo "all entrypoint identity cases passed"; else echo "FAILURES"; fi
exit "$FAILED"
