#!/bin/bash
#
# End-to-end test: a REAL dsh instance running the fleet-agent plugin,
# registering with the Fleet Hub.
#
# Usage:
#   ./test-real-dsh.sh                    # single worker, asserts it registers
#   FLEET_DEVICE=my-host ./test-real-dsh.sh
#   DSH_PORT=3081 FLEET_DEVICE=host-2 ./test-real-dsh.sh   # second worker
#
# Everything installs into a throwaway DSH_HOME under this directory, so your
# real ~/.dsh profile is never touched. Nothing here needs a global dsh install.
#
# Why the install looks like this: dsh resolves plugins through a PROFILE
# BUNDLE, not through --patch. A `--patch` overlay can only override an entry
# some bundle already declared -- pointing one at a plugin dsh has never heard
# of just logs `patch: entry "..." not found` and boots without it. So the
# plugin is packed, installed into the profile, and registered in
# dsh.profile.bundles; the profile's own cordis.patch.yml then overrides the
# entry's config (same entry name) to set this run's device and hub URL.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

HUB_PORT="${HUB_PORT:-3000}"
DSH_PORT="${DSH_PORT:-3080}"
FLEET_DEVICE="${FLEET_DEVICE:-dsh-test-host}"
HUB_URL="ws://localhost:${HUB_PORT}/ws"

# Per-device by default, so two workers never share a profile (and so the
# second run's config patch cannot disturb the first worker).
export DSH_HOME="${DSH_HOME:-$SCRIPT_DIR/.dsh-test-home/$FLEET_DEVICE}"
PROFILE_DIR="$DSH_HOME/profiles/web"

HUB_PID=""
DSH_PID=""
cleanup() {
  [ -n "$DSH_PID" ] && kill "$DSH_PID" 2>/dev/null || true
  [ -n "$HUB_PID" ] && kill "$HUB_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Turma 2.0: real dsh + Fleet Hub integration test ==="
echo "  DSH_HOME : $DSH_HOME"
echo "  device   : $FLEET_DEVICE"
echo "  hub      : http://localhost:$HUB_PORT"
echo "  dsh      : http://localhost:$DSH_PORT"
echo

# ---------------------------------------------------------------- 1. build
echo "[1/5] Building the fleet-agent plugin..."
npm install --silent
( cd fleet-agent-plugin && npm install --silent && npm run --silent build && rm -f ./*.tgz && npm pack --silent >/dev/null )
TARBALL="$(cd fleet-agent-plugin && ls ./*.tgz | head -1)"
TARBALL="$SCRIPT_DIR/fleet-agent-plugin/${TARBALL#./}"
echo "      packed $(basename "$TARBALL")"

# ------------------------------------------------- 2. scaffold the profile
echo "[2/5] Scaffolding a throwaway dsh profile..."
# Booting any dsh command creates $DSH_HOME/profiles/web on first use.
npm exec -- dsh --profile web --dump-default-config >/dev/null
test -d "$PROFILE_DIR" || { echo "FAIL: dsh did not scaffold $PROFILE_DIR"; exit 1; }

# ------------------------------------------------- 3. install as a bundle
echo "[3/5] Installing the plugin into the profile as a bundle..."
( cd "$PROFILE_DIR" && npm install --silent "$TARBALL" )

# Register the plugin in dsh.profile.bundles (idempotent).
node -e '
  const fs = require("fs"), p = process.argv[1] + "/package.json";
  const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
  const bundles = pkg.dsh.profile.bundles;
  if (!bundles.includes("@turma/dsh-fleet-agent")) bundles.push("@turma/dsh-fleet-agent");
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
' "$PROFILE_DIR"

# The profile patch layer overrides the bundle entry config for THIS run.
# The `name` must match the bundle entry exactly or dsh skips the patch.
cat > "$PROFILE_DIR/cordis.patch.yml" <<EOF
# Written by test-real-dsh.sh -- overrides the fleet-agent entry for this run.
- id: turma-fleet-agent
  name: '@turma/dsh-fleet-agent'
  config:
    hubUrl: $HUB_URL
    device: $FLEET_DEVICE
EOF

# Prove the entry actually made it into the composed tree before booting.
if ! npm exec -- dsh --profile web --dump-config 2>&1 | grep -q 'id: turma-fleet-agent'; then
  echo "FAIL: turma-fleet-agent is not in the composed plugin tree"
  npm exec -- dsh --profile web --dump-config 2>&1 | grep -iE 'turma|patch:' || true
  exit 1
fi
echo "      plugin present in composed tree"

# ------------------------------------------------------------- 4. run both
echo "[4/5] Starting the Fleet Hub and dsh..."
# Reuse a hub that is already up -- that is how a SECOND worker joins the
# fleet. Starting another would just fight for the port.
if curl -sf "http://localhost:$HUB_PORT/api/agents" >/dev/null 2>&1; then
  echo "      hub already running on :$HUB_PORT, reusing it"
else
  ( cd fleet-hub && npm install --silent && npm run dev ) >/tmp/turma-hub.log 2>&1 &
  HUB_PID=$!
  for _ in $(seq 1 30); do
    curl -sf "http://localhost:$HUB_PORT/api/agents" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -sf "http://localhost:$HUB_PORT/api/agents" >/dev/null 2>&1 || {
    echo "FAIL: Fleet Hub never came up on :$HUB_PORT"; tail -20 /tmp/turma-hub.log; exit 1; }
  echo "      hub up"
fi

npm exec -- dsh --profile web --no-open --port "$DSH_PORT" >/tmp/turma-dsh.log 2>&1 &
DSH_PID=$!

# --------------------------------------------------------------- 5. assert
echo "[5/5] Waiting for '$FLEET_DEVICE' to register with the hub..."
REGISTERED=""
for _ in $(seq 1 30); do
  if curl -sf "http://localhost:$HUB_PORT/api/agents" 2>/dev/null | grep -q "\"$FLEET_DEVICE\""; then
    REGISTERED=1
    break
  fi
  # Surface a dsh boot crash immediately rather than burning the full timeout.
  if ! kill -0 "$DSH_PID" 2>/dev/null; then
    echo "FAIL: dsh exited during boot"; tail -30 /tmp/turma-dsh.log; exit 1
  fi
  sleep 1
done

echo
if [ -n "$REGISTERED" ]; then
  echo "=== PASS ==="
  echo "The dsh instance registered with the hub:"
  curl -s "http://localhost:$HUB_PORT/api/agents"
  echo
  echo
  echo "Fleet dashboard : http://localhost:$HUB_PORT"
  echo "dsh web UI      : http://localhost:$DSH_PORT"
  echo
  echo "Both are still running. Press Ctrl+C to stop."
  wait "$DSH_PID"
else
  echo "=== FAIL ==="
  echo "'$FLEET_DEVICE' never appeared in /api/agents."
  echo "--- hub sees ---"; curl -s "http://localhost:$HUB_PORT/api/agents"; echo
  echo "--- dsh log ---";  tail -30 /tmp/turma-dsh.log
  exit 1
fi
