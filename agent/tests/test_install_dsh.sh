#!/usr/bin/env bash
# Behavioural tests for install.sh's dsh (DeepSeek Harness) toolchain lay-down
# (XERK-496) — the decision to SHIP the dsh bits on --with-dsh / TURMA_DSH=1,
# the file placement that must match hub-agent.py's path resolution, and the
# marker + config seeding that keep install.sh and turma-agent-update in step.
#
# install.sh is a monolithic script we must not run (it apt-installs, writes
# units, restarts services), so the same pattern as test_install_sudo.sh: the
# dsh decision functions are extracted verbatim from the real install.sh and run
# against a throwaway prefix + a fake source tree.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL="$(dirname "$HERE")/native/install.sh"
WORK="$(mktemp -d)"
FAILED=0

# shellcheck disable=SC2317,SC2329  # invoked indirectly, via the EXIT trap below.
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

ok()   { echo "  ok: $1"; }
fail() { echo "  FAIL: $1"; FAILED=1; }

# --- Extract the real functions ----------------------------------------------
# Guarded: a renamed function fails loudly rather than silently testing nothing.
extract() {  # <name>  -> prints the function body to stdout
  python3 - "$INSTALL" "$1" <<'PY'
import sys
name = sys.argv[2]
lines = open(sys.argv[1], encoding='utf-8').read().splitlines()
out, started = [], False
for ln in lines:
    if ln.startswith(name + '() {'):
        started, out = True, [ln]
        continue
    if started:
        out.append(ln)
        if ln.strip() == '}':
            print('\n'.join(out))
            sys.exit(0)
print('FATAL: function %r not found in %s' % (name, sys.argv[1]), file=sys.stderr)
sys.exit(1)
PY
}

for fn in dsh_wanted install_dsh_files install_config install_files; do
  extract "$fn" > "$WORK/$fn.sh" || exit 1
done

cat > "$WORK/harness.sh" <<'HARNESS'
info() { echo "[install] $*"; }
warn() { echo "[install] WARN: $*" >&2; }
HARNESS

# --- dsh_wanted() ------------------------------------------------------------
# Gated on --with-dsh or TURMA_DSH in the environment. The runner passes both as
# env vars on `bash`, so nothing is interpolated at build time.
cat > "$WORK/want_tail.sh" <<'EOF'
if dsh_wanted; then echo WANTED; else echo NOTWANTED; fi
EOF
cat "$WORK/harness.sh" "$WORK/dsh_wanted.sh" "$WORK/want_tail.sh" > "$WORK/t1.sh"
t() {  # <label> <WITH_DSH> <TURMA_DSH> <expect>
  local label="$1" w="$2" envval="$3" expect="$4" got
  got="$(WITH_DSH="$w" TURMA_DSH="$envval" bash "$WORK/t1.sh" | tail -n1)"
  if [ "$got" = "$expect" ]; then ok "dsh_wanted: $label"; else fail "dsh_wanted: $label (got $got, want $expect)"; fi
}
t "disabled by default (no flag, no env)"   no ""      NOTWANTED
t "--with-dsh forces on"                    yes ""     WANTED
t "TURMA_DSH=1 opts in"                     no 1       WANTED
t "TURMA_DSH=true opts in"                  no true    WANTED
t "TURMA_DSH=0 stays off (no flag)"         no 0       NOTWANTED

# --- install_dsh_files() -----------------------------------------------------
# Lays dsh_session.py / dsh_transcript.py beside hub-agent.py and the driver +
# guard dirs at the exact paths hub-agent.py resolves (DSH_PLUGIN_DIR =
# <dir>/dsh-session-driver, guard at <dir>/dsh/guard), stamps the marker, and
# warns (does not fail) when the committed dist/ is missing.
make_src() {  # <dir> [nodist]
  local dir="$1"
  mkdir -p "$dir/hooks"
  echo "# hub" >"$dir/hub-agent.py"
  echo "# sess" >"$dir/dsh_session.py"
  echo "# trans" >"$dir/dsh_transcript.py"
  mkdir -p "$dir/dsh-session-driver/dist" "$dir/dsh/guard"
  echo "// driver" >"$dir/dsh-session-driver/dist/index.js"
  echo "// guard" >"$dir/dsh/guard/index.mjs"
  [ "${2:-}" = nodist ] && rm -rf "$dir/dsh-session-driver/dist"
}

stub_prefix() {  # <root> -> echoes PREFIX, sets up dirs
  local root="$1" prefix
  prefix="$root/prefix"
  mkdir -p "$prefix"
  echo "$prefix"
}

# Files land in the right places and the marker is stamped.
src="$WORK/src-good"; make_src "$src"
prefix="$(stub_prefix "$WORK/r1")"
cat > "$WORK/t2.sh" <<EOF
$(cat "$WORK/harness.sh")
$(cat "$WORK/install_dsh_files.sh")
PREFIX="$prefix"; SRC_DIR="$src"
DSH_MARKER="$prefix/.dsh"
install_dsh_files >/dev/null
EOF
bash "$WORK/t2.sh"
if [ -f "$prefix/dsh_session.py" ] && [ -f "$prefix/dsh_transcript.py" ] \
   && [ -f "$prefix/dsh-session-driver/dist/index.js" ] \
   && [ -f "$prefix/dsh/guard/index.mjs" ]; then
  ok "install_dsh_files lays every dsh file at the hub-agent.py-relative paths"
else
  fail "install_dsh_files did not lay all dsh files where hub-agent.py resolves them"
fi
if [ -f "$prefix/.dsh" ] && [ -s "$prefix/.dsh" ]; then
  ok "install_dsh_files stamps the \$PREFIX/.dsh marker turma-agent-update reads"
else
  fail "install_dsh_files did not write the dsh marker"
fi

# A missing committed dist/ warns but still lays the rest + marker (the failure
# is _ensure_dsh_profile's, at runtime) — but missing dist must be reported.
src2="$WORK/src-nodist"; make_src "$src2" nodist
prefix2="$(stub_prefix "$WORK/r2")"
cat > "$WORK/t3.sh" <<EOF
$(cat "$WORK/harness.sh")
$(cat "$WORK/install_dsh_files.sh")
PREFIX="$prefix2"; SRC_DIR="$src2"
DSH_MARKER="$prefix2/.dsh"
install_dsh_files 2>&1
EOF
out="$(bash "$WORK/t3.sh")"
if echo "$out" | grep -q "dist/index.js is MISSING"; then
  ok "install_dsh_files warns when the committed dist/ is absent"
else
  fail "install_dsh_files silently shipped a driver with no dist/"
fi
if [ -f "$prefix2/.dsh" ]; then
  ok "still stamps the marker even when dist/ is missing"
else
  fail "marker not stamped on a dist-less source"
fi

# --- install_config() dsh seeding --------------------------------------------
# On a --with-dsh install the FRESH config gets TURMA_DSH=1 (the runtime gate
# hub-agent.py reads); a preserved config is left alone even under --with-dsh.
seed_cfg_dir() {  # <root> -> echoes CFG dir, creates it
  local root="$1"
  mkdir -p "$root/cfg"; echo "$root/cfg"
}

envsrc="$WORK/env"; mkdir -p "$envsrc"
cat > "$envsrc/turma-agent.env" <<'ENV'
TURMA_URL=https://x.example
TURMA_TOKEN=
DEVICE_NAME=host1
ENV

# Fresh config + --with-dsh -> TURMA_DSH=1 seeded.
cfgdir="$(seed_cfg_dir "$WORK/c1")"
cat > "$WORK/t4.sh" <<EOF
$(cat "$WORK/harness.sh")
$(cat "$WORK/dsh_wanted.sh")
$(cat "$WORK/install_config.sh")
WITH_DSH=yes
CFG_DIR="$cfgdir"; CFG="$cfgdir/turma-agent.env"
SELF_DIR="$envsrc"
install_config >/dev/null
EOF
bash "$WORK/t4.sh"
if [ -f "$cfgdir/turma-agent.env" ] && grep -q '^TURMA_DSH=1$' "$cfgdir/turma-agent.env"; then
  ok "install_config seeds TURMA_DSH=1 into a fresh --with-dsh config"
else
  fail "fresh --with-dsh config missing TURMA_DSH=1"
fi

# Fresh config, no dsh -> no TURMA_DSH line at all.
cfgdir2="$(seed_cfg_dir "$WORK/c2")"
cat > "$WORK/t5.sh" <<EOF
$(cat "$WORK/harness.sh")
$(cat "$WORK/dsh_wanted.sh")
$(cat "$WORK/install_config.sh")
WITH_DSH=no
CFG_DIR="$cfgdir2"; CFG="$cfgdir2/turma-agent.env"
SELF_DIR="$envsrc"
install_config >/dev/null
EOF
bash "$WORK/t5.sh"
if [ -f "$cfgdir2/turma-agent.env" ] && ! grep -q '^TURMA_DSH=' "$cfgdir2/turma-agent.env"; then
  ok "install_config leaves a plain install without TURMA_DSH"
else
  fail "a plain install unexpectedly got a TURMA_DSH line"
fi

# Preserved config under --with-dsh is NOT rewritten (config edits survive).
cfgdir3="$(seed_cfg_dir "$WORK/c3")"
echo "TURMA_TOKEN=keepme" >"$cfgdir3/turma-agent.env"
cat > "$WORK/t6.sh" <<EOF
$(cat "$WORK/harness.sh")
$(cat "$WORK/dsh_wanted.sh")
$(cat "$WORK/install_config.sh")
WITH_DSH=yes
CFG_DIR="$cfgdir3"; CFG="$cfgdir3/turma-agent.env"
SELF_DIR="$envsrc"
install_config >/dev/null
EOF
bash "$WORK/t6.sh"
if [ "$(cat "$cfgdir3/turma-agent.env")" = "TURMA_TOKEN=keepme" ]; then
  ok "a preserved config is left untouched even under --with-dsh"
else
  fail "install_config rewrote a preserved config"
fi

# --- install_files() lays the qwen runtime UNCONDITIONALLY (XERK-523) --------
# The qwen Python siblings + qwen/ ship beside hub-agent.py on EVERY install (no
# --with-qwen, no marker — they are stdlib-only and qwen is core-enabled). A
# missing qwen_session.py is the "No module named 'qwen_session'" spawn failure
# on a TURMA_QWEN=1 host, so install_files must place them at the exact
# hub-agent.py-relative paths the agent resolves.
qsrc="$WORK/src-full"
mkdir -p "$qsrc/hooks" "$qsrc/qwen/guard"
echo "# hub" >"$qsrc/hub-agent.py"
echo "// tunnel" >"$qsrc/tunnel-agent.js"
echo "# tmux" >"$qsrc/tmux.conf"
echo "# guard" >"$qsrc/hooks/guard.py"
echo "# qwen_session" >"$qsrc/qwen_session.py"
echo "# qwen_transcript" >"$qsrc/qwen_transcript.py"
echo "# ask_mcp" >"$qsrc/qwen/ask_mcp.py"
echo "# peer_mcp" >"$qsrc/qwen/peer_mcp.py"
echo "# peer_inbox" >"$qsrc/qwen/peer_inbox.py"
echo "# shim" >"$qsrc/qwen/guard/shim.py"
echo "9.9" >"$qsrc/VERSION"
# SELF_DIR holds the bin scripts install_files copies; content is irrelevant here.
qself="$WORK/self-full"; mkdir -p "$qself"
for b in turma-agent turma-agentctl turma-agent-update; do echo "# $b" >"$qself/$b"; done
qprefix="$(stub_prefix "$WORK/rq")"
cat > "$WORK/t7.sh" <<EOF
$(cat "$WORK/harness.sh")
$(cat "$WORK/install_files.sh")
PREFIX="$qprefix"; SRC_DIR="$qsrc"; SELF_DIR="$qself"
install_files >/dev/null 2>&1
EOF
bash "$WORK/t7.sh"
if [ -f "$qprefix/qwen_session.py" ] && [ -f "$qprefix/qwen_transcript.py" ] \
   && [ -f "$qprefix/qwen/ask_mcp.py" ] && [ -f "$qprefix/qwen/peer_mcp.py" ] \
   && [ -f "$qprefix/qwen/peer_inbox.py" ] && [ -f "$qprefix/qwen/guard/shim.py" ]; then
  ok "install_files lays the qwen siblings + qwen/ at the hub-agent.py-relative paths"
else
  fail "install_files did not lay the qwen runtime files (spawn -> No module named 'qwen_session')"
fi

if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$FAILED"
