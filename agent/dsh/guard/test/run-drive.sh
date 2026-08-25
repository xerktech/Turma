#!/usr/bin/env bash
#
# Run drive-real-dsh.mjs against a real dsh install (XERK-470 [F]).
#
# The harness imports `@deepseek-ai/dsh-tools` etc. Node ESM resolves those by
# walking up from the harness file, so this script symlinks a `node_modules`
# into the guard package pointing at a real dsh install, runs the harness, then
# removes the symlink. The symlink is gitignored.
#
# dsh install is located, in order: $DSH_MODULES (a node_modules dir), a global
# `dsh` on PATH (its node_modules), or the npx cache. Set DSH_MODULES to override.
set -euo pipefail

GUARD_DIR="$(cd "$(dirname "$0")/.." && pwd)"

find_modules() {
  if [[ -n "${DSH_MODULES:-}" ]]; then echo "$DSH_MODULES"; return; fi
  # npx cache: any dir carrying @deepseek-ai/dsh-tools
  local hit
  hit="$(find "${HOME}/.npm/_npx" -maxdepth 5 -type d -path '*/node_modules/@deepseek-ai/dsh-tools' 2>/dev/null | head -1 || true)"
  if [[ -n "$hit" ]]; then dirname "$(dirname "$hit")"; return; fi
  echo "FATAL: no dsh install found. Install dsh or set DSH_MODULES to a node_modules dir carrying @deepseek-ai/dsh-tools." >&2
  exit 2
}

MODULES="$(find_modules)"
echo "Using dsh modules: $MODULES"

LINK="$GUARD_DIR/node_modules"
CFG_JSON="$(mktemp -t dsh-guard-config-XXXX.json)"
cleanup() {
  [[ -L "$LINK" ]] && rm -f "$LINK" || true
  rm -f "$CFG_JSON" || true
}
trap cleanup EXIT

# Generate the REAL production guard config (build_dsh_guard_config) so the drive
# proves the exact ruleset a launch passes, not a hand-written stand-in.
HUB_AGENT="$(cd "$GUARD_DIR/../.." && pwd)/hub-agent.py"
if python3 -c "
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('hubagent', '$HUB_AGENT')
m = importlib.util.module_from_spec(spec)
sys.argv = ['hub-agent.py']
spec.loader.exec_module(m)
json.dump(m.build_dsh_guard_config(), open('$CFG_JSON', 'w'))
" 2>/dev/null; then
  export DSH_GUARD_CONFIG_JSON="$CFG_JSON"
  echo "Generated production guard config at $CFG_JSON"
fi

ln -sfn "$MODULES" "$LINK"
node "$GUARD_DIR/test/drive-real-dsh.mjs"
