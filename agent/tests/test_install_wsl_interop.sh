#!/usr/bin/env bash
# Behavioural tests for install.sh's ensure_wsl_interop (XERK-2938): on WSL it
# persists the WSLInterop binfmt entry (systemd on WSL can drop it, and every
# Windows program then fails "Exec format error") and re-registers it now,
# never against an operator's [interop] enabled=false, never off WSL.
#
# The real function is extracted from the real install.sh and run against fake
# /proc and /etc trees.
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

# Guarded: a renamed function must fail loudly, not test an empty file.
# shellcheck disable=SC2016  # a sed pattern, not an expansion.
sed -n '/^: "\${WSL_OSRELEASE:=/,/^}$/p;/^ensure_wsl_interop() {/,/^}$/p' "$INSTALL" > "$WORK/fn.sh"
if ! grep -q "ensure_wsl_interop()" "$WORK/fn.sh" || ! grep -q "_wsl_interop_disabled()" "$WORK/fn.sh"; then
  echo "FAIL: could not extract ensure_wsl_interop from $INSTALL (renamed?)"; exit 1
fi

RULE=':WSLInterop:M::MZ::/init:PF'
CONF=""; REG=""

run_case() {  # <name> <osrelease> <wsl.conf body|-> <registered yes|no>
  local d="$WORK/$1"
  mkdir -p "$d/binfmt_misc" "$d/etc"
  echo "$2" > "$d/osrelease"
  : > "$d/binfmt_misc/register"
  if [ "$4" = yes ]; then echo enabled > "$d/binfmt_misc/WSLInterop"; fi
  if [ "$3" != - ]; then printf '%s\n' "$3" > "$d/etc/wsl.conf"; fi
  # shellcheck disable=SC2016  # expanded by the child shell.
  WSL_OSRELEASE="$d/osrelease" WSL_CONF="$d/etc/wsl.conf" BINFMT_MISC="$d/binfmt_misc" \
    BINFMT_D="$d/etc/binfmt.d" bash -c '
      info() { echo "[install] $*"; }; warn() { echo "[install] WARN: $*" >&2; }
      have_sudo() { return 0; }; SUDO=""
      . "$1"; ensure_wsl_interop' _ "$WORK/fn.sh" > "$d/out" 2>&1
  CONF="$d/etc/binfmt.d/WSLInterop.conf"; REG="$d/binfmt_misc/register"
}

WSL=6.6.87.2-microsoft-standard-WSL2
echo "ensure_wsl_interop:"

run_case lost "$WSL" - no
if [ "$(cat "$CONF" 2>/dev/null)" = "$RULE" ]; then ok "persists the rule on WSL"
else fail "no binfmt.d rule: $(cat "$WORK/lost/out")"; fi
if [ "$(cat "$REG")" = "$RULE" ]; then ok "re-registers a lost entry"; else fail "did not re-register"; fi

run_case live "$WSL" - yes
if [ -f "$CONF" ]; then ok "persists even while registered"; else fail "no rule while registered"; fi
if [ ! -s "$REG" ]; then ok "never re-registers a live entry (EEXIST)"; else fail "wrote over a live entry"; fi

run_case off "$WSL" $'[boot]\nsystemd=true\n[interop]\n  Enabled = False' no
if [ ! -e "$CONF" ] && [ ! -s "$REG" ]; then ok "honours [interop] enabled=false"
else fail "overrode enabled=false"; fi

run_case otheroff "$WSL" $'[automount]\nenabled=false' no
if [ -f "$CONF" ]; then ok "enabled=false in another section does not count"; else fail "misread [automount]"; fi

run_case linux "6.1.0-18-amd64" - no
if [ ! -e "$CONF" ] && [ ! -s "$REG" ]; then ok "does nothing off WSL"; else fail "touched a non-WSL host"; fi

exit $FAILED
