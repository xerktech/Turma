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
# By DEFAULT everything installs into a throwaway DSH_HOME under this
# directory, leaving your real ~/.dsh alone. Overriding DSH_HOME removes that
# protection -- see the guard below. Nothing here needs a global dsh install.
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

# FLEET_DEVICE and the ports are interpolated into YAML below, so validate
# them as WHOLE strings. `grep` is the wrong tool here: it matches per line, so
# any payload whose first line is clean slips through and the trailing lines
# land in the document as sibling keys. `case` globs have no such blind spot.
case "$FLEET_DEVICE" in
  ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
    echo "FAIL: FLEET_DEVICE must start alphanumeric and contain only [A-Za-z0-9._-]"
    printf '      got: %q\n' "$FLEET_DEVICE"
    exit 1 ;;
esac

for _port_var in HUB_PORT DSH_PORT; do
  eval "_port_val=\$$_port_var"
  case "$_port_val" in
    ''|*[!0-9]*)
      echo "FAIL: $_port_var must be a number"
      printf '      got: %q\n' "$_port_val"
      exit 1 ;;
  esac
  if [ "$_port_val" -lt 1 ] || [ "$_port_val" -gt 65535 ]; then
    echo "FAIL: $_port_var out of range: $_port_val"
    exit 1
  fi
done
unset _port_var _port_val

# Proves THIS run's dsh is the one that registered. A device name cannot: an
# abandoned dsh reconnects every 5s under the same name, so asserting on the
# name alone passes on a stale process (and did -- QA reproduced exactly that).
RUN_ID="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"

# Per-device by default, so two workers never share a profile (and so the
# second run's config patch cannot disturb the first worker).
DSH_HOME_DEFAULT="$SCRIPT_DIR/.dsh-test-home/$FLEET_DEVICE"
export DSH_HOME="${DSH_HOME:-$DSH_HOME_DEFAULT}"
PROFILE_DIR="$DSH_HOME/profiles/web"

# This script REWRITES $PROFILE_DIR/package.json and OVERWRITES its
# cordis.patch.yml. Pointed at a real profile that would clobber the user's own
# configuration, so a non-throwaway DSH_HOME has to be opted into explicitly.
if [ "$DSH_HOME" != "$DSH_HOME_DEFAULT" ] && [ "${DSH_HOME_ALLOW_CLOBBER:-}" != "1" ]; then
  echo "FAIL: DSH_HOME is overridden to a profile this script would rewrite:"
  echo "        $DSH_HOME"
  echo "      It overwrites profiles/web/cordis.patch.yml and edits package.json."
  echo "      Re-run with DSH_HOME_ALLOW_CLOBBER=1 if that is really what you want."
  exit 1
fi

LOG_DIR="${TMPDIR:-/tmp}"
HUB_LOG="$LOG_DIR/turma-hub-$HUB_PORT.log"
DSH_LOG="$LOG_DIR/turma-dsh-$FLEET_DEVICE.log"

# ---------------------------------------------------------------- teardown
# npm/tsx spawn grandchildren, so killing the recorded pid leaves the real node
# processes behind, reparented to init. Those orphans hold the ports AND keep
# their hub registration alive, which makes the next run either fail to bind or
# -- worse -- pass on a stale entry. Tear down the whole descendant tree.
HUB_PID=""
DSH_PID=""

# Collect a pid and every descendant. The list is SNAPSHOTTED before any
# signal goes out: `pgrep -P` walks parent links, so once a parent exits its
# children become invisible to a second walk -- which made the KILL escalation
# below unreachable for precisely the process that ignored TERM.
collect_tree() {
  local pid="$1" child
  [ -n "$pid" ] || return 0
  printf '%s\n' "$pid"
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    collect_tree "$child"
  done
}

alive_tree() {
  local pid="$1" child
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null && return 0
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    alive_tree "$child" && return 0
  done
  return 1
}

cleanup() {
  local pids p still
  pids="$(collect_tree "$DSH_PID"; collect_tree "$HUB_PID")"
  [ -n "$pids" ] || return 0
  for p in $pids; do kill -TERM "$p" 2>/dev/null || true; done
  for _ in $(seq 1 20); do
    still=""
    for p in $pids; do kill -0 "$p" 2>/dev/null && { still=1; break; }; done
    [ -n "$still" ] || return 0
    sleep 0.25
  done
  for p in $pids; do kill -KILL "$p" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

# Does the hub currently list an agent whose instanceId is THIS run's?
# Parsed as JSON rather than grepped -- a grep pattern built from a variable
# can match the wrong agent's row.
registered_this_run() {
  curl -sf "http://localhost:$HUB_PORT/api/agents" 2>/dev/null | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const agents = JSON.parse(s)
        process.exit(agents.some(a => a.instanceId === process.argv[1] && a.online) ? 0 : 1)
      } catch { process.exit(1) }
    })
  ' "$RUN_ID"
}

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3<&- ; }

echo "=== Turma 2.0: real dsh + Fleet Hub integration test ==="
echo "  DSH_HOME : $DSH_HOME"
echo "  device   : $FLEET_DEVICE"
echo "  hub      : http://localhost:$HUB_PORT"
echo "  dsh      : http://localhost:$DSH_PORT"
echo

# ------------------------------------------------------------- 0. preflight
# An orphan from an earlier run is the failure mode this catches. Note `ss` is
# absent on some minimal images, so check by connecting, not by listing.
if port_busy "$DSH_PORT"; then
  echo "FAIL: port $DSH_PORT is already in use -- most likely a dsh left over"
  echo "      from an earlier run. Find and stop it with:"
  echo "        pgrep -af 'profile web'"
  echo "      (or pick another port: DSH_PORT=3081 $0)"
  exit 1
fi

# A stale registration under this device name would make the final assertion
# pass without this run proving anything.
if curl -sf "http://localhost:$HUB_PORT/api/agents" 2>/dev/null | grep -q "\"$FLEET_DEVICE\""; then
  echo "FAIL: '$FLEET_DEVICE' is ALREADY registered with the hub on :$HUB_PORT."
  echo "      A leftover dsh is still connected, so a PASS here would be"
  echo "      meaningless. Stop it (pgrep -af 'profile web') or use a"
  echo "      different FLEET_DEVICE."
  exit 1
fi

# ---------------------------------------------------------------- 1. build
echo "[1/5] Building the fleet-agent plugin..."
echo "      (first run installs dependencies -- this can take 10+ minutes)"
npm install
( cd fleet-agent-plugin && npm install && npm run build && rm -f ./*.tgz && npm pack >/dev/null )
TARBALL="$(cd fleet-agent-plugin && ls ./*.tgz | head -1)"
TARBALL="$SCRIPT_DIR/fleet-agent-plugin/${TARBALL#./}"
echo "      packed $(basename "$TARBALL")"

# ------------------------------------------------- 2. scaffold the profile
echo "[2/5] Scaffolding a throwaway dsh profile..."
# Booting any dsh command creates $DSH_HOME/profiles/web on first use.
# Catch the failure ourselves -- under `set -e` dsh's own stack trace would be
# the last thing on screen, which reads as a script bug rather than a bad path.
if ! npm exec -- dsh --profile web --dump-default-config >/dev/null 2>"$LOG_DIR/turma-scaffold.log"; then
  echo "FAIL: dsh could not scaffold a profile under DSH_HOME=$DSH_HOME"
  echo "      (is the path writable?)"
  tail -5 "$LOG_DIR/turma-scaffold.log"
  exit 1
fi
test -d "$PROFILE_DIR" || { echo "FAIL: dsh did not scaffold $PROFILE_DIR"; exit 1; }

# ------------------------------------------------- 3. install as a bundle
echo "[3/5] Installing the plugin into the profile as a bundle..."
( cd "$PROFILE_DIR" && npm install "$TARBALL" )

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
# Values are quoted; FLEET_DEVICE is character-restricted above.
cat > "$PROFILE_DIR/cordis.patch.yml" <<EOF
# Written by test-real-dsh.sh -- overrides the fleet-agent entry for this run.
- id: turma-fleet-agent
  name: '@turma/dsh-fleet-agent'
  config:
    hubUrl: '$HUB_URL'
    device: '$FLEET_DEVICE'
    instanceId: '$RUN_ID'
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
  # The hub reads PORT, not HUB_PORT.
  ( cd fleet-hub && npm install && PORT="$HUB_PORT" npm run dev ) >"$HUB_LOG" 2>&1 &
  HUB_PID=$!
  for _ in $(seq 1 60); do
    curl -sf "http://localhost:$HUB_PORT/api/agents" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -sf "http://localhost:$HUB_PORT/api/agents" >/dev/null 2>&1 || {
    echo "FAIL: Fleet Hub never came up on :$HUB_PORT"; tail -20 "$HUB_LOG"; exit 1; }
  echo "      hub up"
fi

npm exec -- dsh --profile web --no-open --port "$DSH_PORT" >"$DSH_LOG" 2>&1 &
DSH_PID=$!

# --------------------------------------------------------------- 5. assert
echo "[5/5] Waiting for '$FLEET_DEVICE' to register with the hub..."
echo "      (matching instanceId $RUN_ID, so only THIS run's dsh counts)"
REGISTERED=""
for _ in $(seq 1 30); do
  if registered_this_run; then
    REGISTERED=1
    break
  fi
  # Surface a dsh boot crash immediately rather than burning the full timeout.
  if ! alive_tree "$DSH_PID"; then
    echo "FAIL: dsh exited during boot"; tail -30 "$DSH_LOG"; exit 1
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
  echo "Logs            : $HUB_LOG"
  echo "                  $DSH_LOG"
  echo
  echo "Both are still running. Press Ctrl+C to stop."
  wait "$DSH_PID"
else
  echo "=== FAIL ==="
  echo "No agent with this run's instanceId ($RUN_ID) appeared in /api/agents."
  echo "If '$FLEET_DEVICE' IS listed below, that is a DIFFERENT dsh process --"
  echo "an abandoned one still holding the name. Stop it: pgrep -af 'profile web'"
  echo "--- hub sees ---"; curl -s "http://localhost:$HUB_PORT/api/agents"; echo
  echo "--- dsh log ---";  tail -30 "$DSH_LOG"
  exit 1
fi
