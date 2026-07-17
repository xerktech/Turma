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

# --- Case 5: a non-assignment config line idles, and does NOT crash-loop -----
# The launcher SOURCES the config, so a YAML-style line runs as a command and
# exits 127. Under systemd's Restart=always that became a silent forever-loop
# that reaped the tunnel on every pass — the host read ONLINE while every session
# on it read "terminal offline". The fix is to refuse to start, not to die: these
# cases pin the difference, which is the whole bug.
echo "case: an invalid config line is reported and idled on"
BADCFG="$WORK/bad.env"
cat > "$BADCFG" <<'EOF'
# a comment, and a blank line, are both fine

TURMA_URL=https://hub.invalid
JIRA_SITE: "xerktech.atlassian.net"
JIRA_TOKEN: "ATATT3xFf-s3cret-whose-value-contains=an-equals-sign"
EOF
rm -f "$WORK/manager.log"
TURMA_AGENT_ENV="$BADCFG" PATH="$WORK/stub-bin:$PATH" setsid \
  "$PREFIX/bin/turma-agent" >"$WORK/bad.log" 2>&1 &
BADPID=$!
if wait_for logged "Invalid line" "$WORK/bad.log"; then
  ok "named the file as the problem"
else
  fail "no invalid-config report: $(cat "$WORK/bad.log")"
fi
# Both offending lines, by number — including the one whose VALUE holds an `=`,
# which is what a looser "does it contain =" check would wave through.
if grep -q 'line 4: JIRA_SITE' "$WORK/bad.log" && grep -q 'line 5: JIRA_TOKEN' "$WORK/bad.log"; then
  ok "named both bad lines with their line numbers"
else
  fail "did not report both bad lines: $(cat "$WORK/bad.log")"
fi
# This banner goes to the journal; the config is chmod 600 and holds tokens. A
# malformed secret is still a secret, so the report carries names, never values.
if grep -q 's3cret' "$WORK/bad.log"; then
  fail "the invalid-config report leaked a token value into the journal"
else
  ok "reported the bad lines without echoing their values"
fi
sleep 1
if kill -0 "$BADPID" 2>/dev/null; then
  ok "idled instead of exiting — systemd has nothing to restart-loop"
else
  fail "launcher exited on a bad config; Restart=always would loop it forever"
fi
# Nothing may start against a config we refused to load: not the manager (it
# would report to the wrong hub, or none), and not the tunnel — the thing the
# crash loop was reaping every RestartSec in the first place.
if pgrep -f "$PREFIX/bin/turma-agent --tunnel-supervisor" >/dev/null 2>&1; then
  fail "a supervisor was started despite the config being rejected"
else
  ok "started no tunnel against a config it never loaded"
fi
if [ -f "$WORK/manager.log" ]; then
  fail "the manager was started with a config that never loaded"
else
  ok "started no manager either"
fi
kill "$BADPID" 2>/dev/null || true
pkill -f "$PREFIX/bin/turma-agent" 2>/dev/null || true

# --- Case 6: --preflight reports the same fault but never hangs --------------
# install.sh --verify calls this; it must answer and leave.
echo "case: --preflight reports an invalid config and exits nonzero"
rc=0
TURMA_AGENT_ENV="$BADCFG" PATH="$WORK/stub-bin:$PATH" timeout 10 \
  "$PREFIX/bin/turma-agent" --preflight >"$WORK/pre.log" 2>&1 || rc=$?
if [ "$rc" = "1" ]; then
  ok "exited 1 rather than idling"
elif [ "$rc" = "124" ]; then
  fail "--preflight hung on a bad config — install.sh --verify would never return"
else
  fail "expected exit 1, got $rc: $(cat "$WORK/pre.log")"
fi

# --- Case 7: a valid config still loads, `export` and all --------------------
# The guard must not fail a config that works today: sourcing has always taken an
# `export` prefix and shell expansion in values.
echo "case: a valid config is unaffected"
GOODCFG="$WORK/good.env"
cat > "$GOODCFG" <<'EOF'
TURMA_URL=https://hub.invalid
export TURMA_TOKEN=t
MAX_SESSIONS=6
EOF
rc=0
TURMA_AGENT_ENV="$GOODCFG" PATH="$WORK/stub-bin:$PATH" timeout 10 \
  "$PREFIX/bin/turma-agent" --preflight >"$WORK/pre2.log" 2>&1 || rc=$?
if [ "$rc" = "0" ]; then
  ok "a plain KEY=value config (with an export line) still passes"
else
  fail "valid config rejected (rc=$rc): $(cat "$WORK/pre2.log")"
fi

if [ "$FAILED" = 0 ]; then echo "all turma-agent launcher tests passed"; else echo "FAILURES"; fi
exit "$FAILED"
