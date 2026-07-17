#!/usr/bin/env bash
# Behavioural tests for the native launcher's reverse-tunnel supervision.
#
# The tunnel is what backs every web terminal, and on a native install it is the
# one piece whose runtime can be absent: node is an apt prerequisite, not a baked
# image layer. When it was fire-and-forget, a host that came up before node was
# installed heartbeated ONLINE forever while every session on it read "terminal
# offline" — a silent, permanent failure with one `node: command not found` line
# in the journal to explain it. These cases pin the three behaviours that ended
# that, none of which ShellCheck can see (it checks shell correctness, not what
# the script does):
#
#   1. the tunnel is respawned when it dies,
#   2. a missing node is survived and HEALED when node appears — no restart,
#   3. the manager pid is exported for the tunnel's SIGUSR1 poke.
#
# The real launcher runs, with only what it hands off to stubbed (node, the
# tunnel, python3/hub-agent.py), so the parts most likely to bite — the pkill
# keys, `exec` preserving $$, the supervisor's config inheritance — stay honest.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$(dirname "$HERE")/native"
WORK="$(mktemp -d)"
FAILED=0

# shellcheck disable=SC2329  # invoked indirectly, via the EXIT trap below.
cleanup() {
  pkill -f "$WORK/prefix/bin/turma-agent --tunnel-supervisor" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

ok()   { echo "  ok: $1"; }
fail() { echo "  FAIL: $1"; FAILED=1; }

# --- Fixture: a PREFIX laid out the way install.sh lays one out --------------
PREFIX="$WORK/prefix"
mkdir -p "$PREFIX/bin" "$WORK/stub-bin" "$WORK/home/.claude"
cp "$NATIVE_DIR/turma-agent" "$PREFIX/bin/turma-agent"
chmod +x "$PREFIX/bin/turma-agent"

# The launcher's one fatal check — without this it idles instead of running.
echo '{}' > "$WORK/home/.claude/.credentials.json"

# Stands in for the tunnel: records each start, then exits so the supervisor's
# respawn is observable. `node` is looked up on PATH exactly as the real one is.
cat > "$PREFIX/tunnel-agent.js" <<'STUB'
// stub tunnel
STUB
cat > "$WORK/stub-bin/node" <<STUB
#!/bin/sh
echo "tunnel-start \$*" >> "$WORK/tunnel.log"
exit 0
STUB
chmod +x "$WORK/stub-bin/node"

# Stands in for the session manager. Reports the pid the launcher named against
# its own — \`exec\` means they must be the same process.
cat > "$WORK/stub-bin/python3" <<STUB
#!/bin/sh
echo "named=\${TURMA_MANAGER_PID:-unset} actual=\$\$" > "$WORK/manager.log"
sleep 30
STUB
chmod +x "$WORK/stub-bin/python3"

export TURMA_AGENT_ENV="$WORK/agent.env"
cat > "$WORK/agent.env" <<EOF
TURMA_URL=https://hub.invalid
TURMA_TOKEN=t
EOF

# A short retry so the respawn/heal cases finish in a test's time budget.
export TUNNEL_RETRY_SEC=1
export HOME="$WORK/home"
export REPOS_ROOT="$WORK/home/git"
mkdir -p "$REPOS_ROOT"

# Wait (up to ~5s) for a condition rather than sleeping a fixed guess: run the
# given command until it succeeds. The predicates below are invoked through it.
wait_for() {  # <command> [args...]
  for _ in $(seq 1 50); do
    if "$@" 2>/dev/null; then return 0; fi
    sleep 0.1
  done
  return 1
}

count_starts() { if [ -f "$WORK/tunnel.log" ]; then wc -l < "$WORK/tunnel.log"; else echo 0; fi; }

# shellcheck disable=SC2329  # each is invoked indirectly, through wait_for.
starts_at_least() { [ "$(count_starts)" -ge "$1" ]; }
# shellcheck disable=SC2329
logged() { grep -q "$1" "$2"; }
# shellcheck disable=SC2329
file_has_content() { [ -s "$1" ]; }

# --- Case 1: the supervisor respawns a tunnel that exits ---------------------
echo "case: supervisor respawns the tunnel"
: > "$WORK/tunnel.log"
PATH="$WORK/stub-bin:$PATH" setsid "$PREFIX/bin/turma-agent" --tunnel-supervisor \
  >"$WORK/sup.log" 2>&1 &
if wait_for starts_at_least 2; then
  ok "tunnel restarted after it exited ($(count_starts) starts)"
else
  fail "tunnel was not respawned (starts=$(count_starts)); see $WORK/sup.log"
fi
if grep -q "tunnel exited" "$WORK/sup.log"; then
  ok "logged the exit"
else
  fail "no exit logged: $(cat "$WORK/sup.log")"
fi
pkill -f "$PREFIX/bin/turma-agent --tunnel-supervisor" 2>/dev/null || true

# --- Case 2: node missing is survived, then HEALED when node appears ---------
# This is the reported bug's exact shape: the agent came up before node existed.
echo "case: node missing — survives, then heals when node appears"
: > "$WORK/tunnel.log"
# A PATH holding exactly the tools the launcher needs and NO node — the host's
# own /usr/bin/node would otherwise satisfy the very lookup under test.
mkdir -p "$WORK/nonode-bin"
for t in bash env dirname sleep hostname pkill setsid; do
  ln -sf "$(command -v "$t")" "$WORK/nonode-bin/$t"
done
PATH="$WORK/nonode-bin" setsid "$PREFIX/bin/turma-agent" --tunnel-supervisor \
  >"$WORK/sup2.log" 2>&1 &
SUP2=$!
if wait_for logged "node not on PATH" "$WORK/sup2.log"; then
  ok "said why the terminals are offline"
else
  fail "no node guidance logged: $(cat "$WORK/sup2.log")"
fi
if kill -0 "$SUP2" 2>/dev/null; then
  ok "supervisor survived the missing runtime"
else
  fail "supervisor died on missing node — the failure would be permanent again"
fi
# node arrives (the operator apt-installs it) — no restart of anything.
cp "$WORK/stub-bin/node" "$WORK/nonode-bin/node"
if wait_for starts_at_least 1; then
  ok "healed without a restart once node existed"
else
  fail "tunnel never started after node appeared"
fi
pkill -f "$PREFIX/bin/turma-agent --tunnel-supervisor" 2>/dev/null || true

# --- Case 3: the run path names the manager pid and starts one supervisor ----
echo "case: run path exports the manager pid and supervises the tunnel"
: > "$WORK/tunnel.log"
rm -f "$WORK/manager.log"
PATH="$WORK/stub-bin:$PATH" setsid "$PREFIX/bin/turma-agent" >"$WORK/run.log" 2>&1 &
if wait_for file_has_content "$WORK/manager.log"; then
  named="$(sed -n 's/named=\([0-9]*\).*/\1/p' "$WORK/manager.log")"
  actual="$(sed -n 's/.*actual=\([0-9]*\)/\1/p' "$WORK/manager.log")"
  if [ -n "$named" ] && [ "$named" = "$actual" ]; then
    ok "TURMA_MANAGER_PID ($named) is the manager's own pid — the poke can land"
  else
    fail "manager pid mismatch: named=$named actual=$actual (poke would EPERM/mis-signal)"
  fi
else
  fail "manager never started: $(cat "$WORK/run.log")"
fi
if wait_for starts_at_least 1; then
  ok "tunnel started through the supervisor"
else
  fail "run path started no tunnel"
fi

# --- Case 4: a re-run replaces the supervisor rather than duplicating it -----
echo "case: a second launch leaves exactly one supervisor"
PATH="$WORK/stub-bin:$PATH" setsid "$PREFIX/bin/turma-agent" >"$WORK/run2.log" 2>&1 &
sleep 1
n="$(pgrep -f -c "$PREFIX/bin/turma-agent --tunnel-supervisor" 2>/dev/null || echo 0)"
if [ "$n" = "1" ]; then
  ok "exactly one supervisor after a restart"
else
  fail "expected 1 supervisor, found $n (a duplicate tunnel fights for the channel)"
fi

pkill -f "$WORK/stub-bin/python3" 2>/dev/null || true
pkill -f "$PREFIX/bin/turma-agent" 2>/dev/null || true

if [ "$FAILED" = 0 ]; then echo "all turma-agent launcher tests passed"; else echo "FAILURES"; fi
exit "$FAILED"
