#!/usr/bin/env bash
# Behavioural tests for install.sh's sudo probe — the decision that gates every
# apt prerequisite.
#
# This is worth its own harness because getting it wrong is SILENT: the probe
# only decides whether to *offer* to install things, so a wrong "no" skips node
# behind one warning and the install still reports success. The host then comes
# up, heartbeats ONLINE, and every session on it reads "terminal offline",
# because node is what runs the reverse tunnel. That is exactly what a
# `sudo -n`-only probe did under the README's `curl … | bash` quickstart: an
# ordinary password-sudo host looks sudo-less to it. sudo prompts on /dev/tty,
# not stdin, so the pipe never stopped it asking — only the probe did.
#
# The real function is extracted from the real install.sh and run against stub
# `sudo`s modelling each kind of host, under a real pty where the terminal
# matters (`script`), since `[ -t 2 ]` is the gate under test.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL="$(dirname "$HERE")/native/install.sh"
WORK="$(mktemp -d)"
FAILED=0

# shellcheck disable=SC2329  # invoked indirectly, via the EXIT trap below.
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

ok()   { echo "  ok: $1"; }
fail() { echo "  FAIL: $1"; FAILED=1; }

# --- Extract the real probe --------------------------------------------------
# Guarded: if the function is ever renamed, this must fail loudly rather than
# quietly test an empty file and pass.
sed -n '/^SUDO_PROBE=/,/^}/p' "$INSTALL" > "$WORK/probe.sh"
if ! grep -q "have_sudo()" "$WORK/probe.sh"; then
  echo "FAIL: could not extract have_sudo() from $INSTALL (renamed?)"; exit 1
fi
cat >> "$WORK/probe.sh" <<'EOF'
info() { echo "[install] $*"; }
if have_sudo; then echo "RESULT=yes"; else echo "RESULT=no"; fi
# A second call must not ask again — a declined prompt re-asked once per
# prerequisite would be worse than not asking at all.
have_sudo >/dev/null 2>&1 && echo "SECOND=yes" || echo "SECOND=no"
EOF

# --- Stub hosts --------------------------------------------------------------
mk_sudo() {  # <dir> <n_rc> <v_rc>
  mkdir -p "$WORK/$1"
  cat > "$WORK/$1/sudo" <<EOF
#!/bin/sh
if [ "\$1" = "-n" ]; then exit $2; fi
if [ "\$1" = "-v" ]; then echo "PROMPTED" >&2; exit $3; fi
exit 0
EOF
  chmod +x "$WORK/$1/sudo"
}
mk_sudo passwd   1 0   # ordinary sudo: -n refuses, prompt succeeds
mk_sudo nopasswd 0 0   # NOPASSWD: -n already works
mk_sudo declined 1 1   # user declines / wrong password
# A PATH with the shell but deliberately NO sudo — the host's real /usr/bin/sudo
# would otherwise satisfy the very lookup under test.
mkdir -p "$WORK/nosudo"
for t in bash sh; do ln -sf "$(command -v "$t")" "$WORK/nosudo/$t"; done

# Run the probe with <stub dir> on PATH, as `curl … | bash` does it: stdin is a
# PIPE, stderr is a terminal. `script` supplies the pty.
run_piped_tty() {  # <stub dir>
  script -qec "PATH=$WORK/$1:/usr/bin:/bin; echo | bash $WORK/probe.sh" /dev/null 2>&1
}

# --- Case 1: password sudo + a terminal — THE quickstart case ----------------
echo "case: password-sudo host running the piped quickstart"
out="$(run_piped_tty passwd)"
if grep -q "RESULT=yes" <<<"$out"; then
  ok "asks for the password and installs the prereqs"
else
  fail "probe said no on a host that HAS sudo — prereqs would be skipped: $out"
fi
if grep -q "PROMPTED" <<<"$out"; then
  ok "the pipe on stdin did not stop sudo prompting"
else
  fail "never prompted: $out"
fi

# --- Case 2: unattended (no tty) must fail FAST, never hang ------------------
echo "case: unattended run (CI/cron) — no terminal to ask on"
start=$SECONDS
out="$(PATH="$WORK/passwd:/usr/bin:/bin" bash "$WORK/probe.sh" 2>/dev/null </dev/null)"
took=$((SECONDS - start))
if grep -q "RESULT=no" <<<"$out"; then
  ok "skips rather than hanging on a password nobody will type"
else
  fail "expected no-sudo without a tty, got: $out"
fi
if [ "$took" -lt 10 ]; then
  ok "failed fast (${took}s)"
else
  fail "took ${took}s — it is waiting on something"
fi

# --- Case 3: NOPASSWD sudo is used without prompting -------------------------
echo "case: NOPASSWD host"
out="$(run_piped_tty nopasswd)"
if grep -q "RESULT=yes" <<<"$out" && ! grep -q "PROMPTED" <<<"$out"; then
  ok "uses the existing credential, no prompt"
else
  fail "expected a silent yes, got: $out"
fi

# --- Case 4: a declined prompt is remembered, not re-asked -------------------
echo "case: password declined"
out="$(run_piped_tty declined)"
if grep -q "RESULT=no" <<<"$out"; then
  ok "treated as no-sudo"
else
  fail "expected no, got: $out"
fi
if [ "$(grep -c "PROMPTED" <<<"$out")" = "1" ]; then
  ok "asked exactly once (not once per prerequisite)"
else
  fail "re-prompted after being declined: $out"
fi

# --- Case 5: no sudo at all --------------------------------------------------
echo "case: host with no sudo binary"
out="$(script -qec "PATH=$WORK/nosudo; echo | bash $WORK/probe.sh" /dev/null 2>&1)"
if grep -q "RESULT=no" <<<"$out"; then
  ok "no sudo, no root, no crash"
else
  fail "expected no, got: $out"
fi

if [ "$FAILED" = 0 ]; then echo "all install.sh sudo-probe tests passed"; else echo "FAILURES"; fi
exit "$FAILED"
