#!/usr/bin/env bash
# Behavioural tests for the non-systemd process controller, turma-agentctl.
#
# It manages the native manager via a pidfile under $XDG_RUNTIME_DIR (falling
# back to ~/.turma). The trap it exists to survive: on the WSL-without-logind
# hosts it is FOR, logind never creates /run/user/<uid>, so XDG_RUNTIME_DIR is
# set but points at a path a non-root user can't mkdir under. `${VAR:-default}`
# does NOT fall back for a set-but-unusable value, so every pidfile write failed
# there — `start` errored out, and `stop`/`restart` couldn't read the pid they
# needed to kill and silently left the old manager running while spawning a
# second one (two managers double-heartbeating the hub). These cases pin that a
# broken runtime dir falls back to the durable ~/.turma, that the pidfile then
# round-trips, and that a usable runtime dir is still honoured — none of which
# ShellCheck can see (it checks shell correctness, not what the script does).
#
# The real turma-agentctl runs, with only the manager/updater it launches stubbed
# by long-lived sleeps, so the parts most likely to bite — the RUNDIR resolution,
# `$!` capture, and the _pid/_alive round-trip — stay honest.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$(dirname "$HERE")/native"
WORK="$(mktemp -d)"
FAILED=0

# shellcheck disable=SC2329  # invoked indirectly, via the EXIT trap below.
cleanup() {
  # Reap any stub manager/updater the tests left running, by their fixture path.
  pkill -f "$WORK/prefix/bin/turma-agent" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

ok()   { echo "  ok: $1"; }
fail() { echo "  FAIL: $1"; FAILED=1; }

# --- Fixture: a PREFIX laid out the way install.sh lays one out --------------
PREFIX="$WORK/prefix"
mkdir -p "$PREFIX/bin"
cp "$NATIVE_DIR/turma-agentctl" "$PREFIX/bin/turma-agentctl"
chmod +x "$PREFIX/bin/turma-agentctl"

# Stand-ins for the manager and update poller: each execs a long sleep so it
# stays alive to be found and killed. `exec` means the pid the launcher captures
# in $! is this sleep's own pid, exactly as in production.
for name in turma-agent turma-agent-update; do
  cat > "$PREFIX/bin/$name" <<'STUB'
#!/bin/sh
exec sleep 300
STUB
  chmod +x "$PREFIX/bin/$name"
done

CTL="$PREFIX/bin/turma-agentctl"

# Each case gets its own HOME so pidfiles/logs don't leak between them.
new_home() { HOME_DIR="$WORK/home-$1"; mkdir -p "$HOME_DIR"; }

# ---------------------------------------------------------------------------
# Case 1: a set-but-unusable XDG_RUNTIME_DIR falls back to ~/.turma, start
# succeeds, and the pidfile lands under ~/.turma (not the broken runtime dir).
# ---------------------------------------------------------------------------
echo "case: broken XDG_RUNTIME_DIR falls back to ~/.turma"
new_home broken
# A regular file, so any path under it is un-mkdir-able for root and non-root
# alike (ENOTDIR) — a root-proof stand-in for the missing /run/user/<uid>.
touch "$WORK/notadir"
if HOME="$HOME_DIR" XDG_RUNTIME_DIR="$WORK/notadir/run" "$CTL" start >/dev/null 2>&1; then
  ok "start exited 0 with an unusable runtime dir"
else
  fail "start errored with an unusable runtime dir"
fi
if [ -f "$HOME_DIR/.turma/turma-agent.pid" ]; then
  ok "pidfile fell back to ~/.turma"
else
  fail "pidfile did not fall back to ~/.turma"
fi
if [ ! -e "$WORK/notadir/run" ]; then
  ok "did not write under the broken runtime dir"
else
  fail "wrote under the broken runtime dir"
fi

# ---------------------------------------------------------------------------
# Case 2: with the pidfile readable, status sees the manager and stop KILLS it.
# This is the property the bug destroyed: an unreadable pid meant stop was a
# silent no-op that orphaned the manager.
# ---------------------------------------------------------------------------
echo "case: status/stop round-trip through the fallback pidfile"
MPID="$(cat "$HOME_DIR/.turma/turma-agent.pid" 2>/dev/null || true)"
if [ -n "$MPID" ] && kill -0 "$MPID" 2>/dev/null; then
  ok "manager process is alive after start"
else
  fail "manager process not found after start"
fi
# Capture then match with a case glob rather than piping to grep: `set -o
# pipefail` + a `grep -q` that exits on first match SIGPIPEs status and would
# fail the pipeline even though the match succeeded.
STATUS_OUT="$(HOME="$HOME_DIR" XDG_RUNTIME_DIR="$WORK/notadir/run" "$CTL" status 2>/dev/null)"
case "$STATUS_OUT" in
  *"turma-agent: running"*) ok "status reports running" ;;
  *)                        fail "status did not report running" ;;
esac
HOME="$HOME_DIR" XDG_RUNTIME_DIR="$WORK/notadir/run" "$CTL" stop >/dev/null 2>&1 || true
# Give the signal a moment to land.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 "$MPID" 2>/dev/null || break
  sleep 0.2
done
if [ -n "$MPID" ] && ! kill -0 "$MPID" 2>/dev/null; then
  ok "stop killed the manager"
else
  fail "stop left the manager running"
fi

# ---------------------------------------------------------------------------
# Case 3: a USABLE XDG_RUNTIME_DIR is still honoured — the fix must not force
# everything to ~/.turma, only rescue the broken case.
# ---------------------------------------------------------------------------
echo "case: usable XDG_RUNTIME_DIR is honoured"
new_home usable
RUN="$WORK/run-usable"; mkdir -p "$RUN"
HOME="$HOME_DIR" XDG_RUNTIME_DIR="$RUN" "$CTL" start >/dev/null 2>&1 || true
if [ -f "$RUN/turma-agent.pid" ]; then
  ok "pidfile lands in a usable runtime dir"
else
  fail "pidfile did not land in the usable runtime dir"
fi
HOME="$HOME_DIR" XDG_RUNTIME_DIR="$RUN" "$CTL" stop >/dev/null 2>&1 || true

if [ "$FAILED" -eq 0 ]; then
  echo "all turma-agentctl tests passed"
else
  echo "turma-agentctl tests FAILED"
fi
exit "$FAILED"
