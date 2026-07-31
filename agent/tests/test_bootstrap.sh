#!/usr/bin/env bash
# Behavioural tests for agent/native/bootstrap.sh.
#
# bootstrap.sh is the front door for a host with no checkout: it is fetched and
# piped to bash straight off main, so a bug here misfires on every new install
# and there is no deployed copy to fix — the next person just pipes the broken
# script again. ShellCheck covers syntax; this covers the decisions.
#
# The load-bearing assertion is CARRIED-ASSET RESOLUTION: a release umbrella
# carries an unchanged native build forward under its ORIGINAL older name, so
# the newest release tag (v0.9.0) can hold turma-agent-native-v0.3.0.tar.gz.
# Deriving the asset name from the tag would ask for a v0.9.0 tarball that was
# never built; only the URL the release actually publishes is real. See the
# header of agent/native/bootstrap.sh and .github/scripts/manifest.js.
#
# So the fake curl below serves assets by their FULL URL PATH, not by basename:
# a URL bootstrap invented rather than read out of the stream 404s here, the
# same as it would against GitHub. Serving by basename made this suite pass
# against a deliberately wrong resolver.
#
# Each case stages a fake release stream + a fake `curl` on PATH, runs the real
# script, and asserts what it unpacked and handed to install.sh.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$(dirname "$HERE")/native/bootstrap.sh"
FAILED=0

pass() { echo "  ok: $1"; }
fail() { echo "  FAIL: $1"; FAILED=1; }
assert_eq() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$4 (expected '$1', got '$2')"; fi; }

# --- A native tarball whose install.sh records how it was called -------------
# Mirrors the real asset's flat layout (install.sh beside hub-agent.py), which
# is what bootstrap hands off to.
make_tarball() {  # <version> <outdir>
  local version="$1" out="$2" staged
  mkdir -p "$out"
  staged="$(mktemp -d)"
  mkdir -p "$staged/hooks"
  echo "# hub-agent $version" >"$staged/hub-agent.py"
  echo "// tunnel $version" >"$staged/tunnel-agent.js"
  echo "$version" >"$staged/VERSION"
  cat >"$staged/install.sh" <<'STUB'
#!/usr/bin/env bash
# Stand-in for the real installer: records the version it came from and the
# args bootstrap passed through, so the test can assert both.
set -eu
cat VERSION > "$INSTALL_RECORD.version"
echo "$@" > "$INSTALL_RECORD.args"
STUB
  chmod +x "$staged/install.sh"
  ( cd "$staged" && tar czf "$out/turma-agent-native-v${version}.tar.gz" . )
  ( cd "$out" && sha256sum "turma-agent-native-v${version}.tar.gz" \
      > "turma-agent-native-v${version}.tar.gz.sha256" )
  rm -rf "$staged"
}

# --- Fake `curl` -------------------------------------------------------------
# Serves the releases API from $FAKE_DIR/releases.json, and an asset URL from
# $FAKE_DIR/assets/<tag>/<name> — keyed on the URL's own tag+name path, so an
# asset URL bootstrap invented instead of reading out of the stream 404s here
# exactly as it would against GitHub (see the header). Speaks only the flags
# bootstrap.sh actually uses (-fsSL, optional -o), so a change in how it calls
# curl fails loudly here.
install_fake_curl() {  # <bindir>
  cat > "$1/curl" <<'STUB'
#!/usr/bin/env bash
set -eu
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1" ;;
    -*) : ;;
    *) url="$1" ;;
  esac
  shift
done
case "$url" in
  *api.github.com*) src="$FAKE_DIR/releases.json" ;;
  */releases/download/*)
    # .../releases/download/<tag>/<name> -> assets/<tag>/<name>
    src="$FAKE_DIR/assets/${url#*/releases/download/}" ;;
  *) exit 22 ;;
esac
[ -f "$src" ] || exit 22          # curl's "HTTP error" exit, as a 404 would
if [ -n "$out" ]; then cp "$src" "$out"; else cat "$src"; fi
STUB
  chmod +x "$1/curl"
}

# Build a releases.json listing the given "<tag>:<asset-version>" pairs, in the
# API's newest-first order.
write_releases_json() {  # <file> <tag:version>...
  local file="$1"; shift
  {
    echo '['
    local first=1 pair tag ver
    for pair in "$@"; do
      tag="${pair%%:*}"; ver="${pair##*:}"
      [ $first -eq 1 ] || echo ','
      first=0
      cat <<JSON
{"tag_name": "$tag", "assets": [
  {"name": "manifest.json",
   "browser_download_url": "https://github.com/o/r/releases/download/$tag/manifest.json"},
  {"name": "turma-agent-native-v$ver.tar.gz",
   "browser_download_url": "https://github.com/o/r/releases/download/$tag/turma-agent-native-v$ver.tar.gz"},
  {"name": "turma-agent-native-v$ver.tar.gz.sha256",
   "browser_download_url": "https://github.com/o/r/releases/download/$tag/turma-agent-native-v$ver.tar.gz.sha256"}
]}
JSON
    done
    echo ']'
  } > "$file"
}

# run_bootstrap <fake-dir> [args...] -> exit code; stdout+stderr in $OUTPUT
run_bootstrap() {
  local fake="$1"; shift
  local bin="$fake/bin"
  set +e
  OUTPUT="$(FAKE_DIR="$fake" INSTALL_RECORD="$fake/record" \
            PATH="$bin:$PATH" bash "$SCRIPT" "$@" 2>&1)"
  local rc=$?
  set -e
  return $rc
}

new_fake() {  # -> prints a staged fake dir
  local fake; fake="$(mktemp -d)"
  mkdir -p "$fake/bin" "$fake/assets"
  install_fake_curl "$fake/bin"
  echo "$fake"
}

# Publish a native build under a release tag: the tarball is BUILT at
# <asset-version> and served from <tag>'s download path. Passing a tag whose
# version differs from the asset's is how a carried release is staged.
publish() {  # <fake-dir> <tag> <asset-version>
  make_tarball "$3" "$1/assets/$2"
}

echo "test_bootstrap.sh"

# --- Case 1: picks the newest native build, and passes args through ----------
echo "case: newest native version wins"
fake="$(new_fake)"
publish "$fake" v0.3.0 0.3.0
publish "$fake" v0.4.1 0.4.1
write_releases_json "$fake/releases.json" "v0.4.1:0.4.1" "v0.3.0:0.3.0"
if run_bootstrap "$fake" --autostart --prefix /opt/turma; then
  assert_eq "0.4.1" "$(cat "$fake/record.version")" \
    "unpacked and installed the newest native build" "installed the wrong version"
  assert_eq "--autostart --prefix /opt/turma" "$(cat "$fake/record.args")" \
    "passed its args through to install.sh" "dropped or mangled install.sh args"
else
  fail "bootstrap exited non-zero on a good release stream: $OUTPUT"
fi

# --- Case 2: carried asset on a newer tag (the load-bearing one) -------------
# v0.9.0 carries the unchanged 0.3.0 native build under its original name. The
# asset the tag would name (…-v0.9.0.tar.gz) does not exist anywhere.
echo "case: carried asset under an older name on a newer tag"
fake="$(new_fake)"
publish "$fake" v0.3.0 0.3.0      # where it was built
publish "$fake" v0.9.0 0.3.0      # carried onto the newer umbrella, same name
write_releases_json "$fake/releases.json" "v0.9.0:0.3.0" "v0.3.0:0.3.0"
if run_bootstrap "$fake"; then
  assert_eq "0.3.0" "$(cat "$fake/record.version")" \
    "resolved the carried asset by its own filename version" \
    "failed to resolve a carried asset"
else
  fail "bootstrap failed on a carried release: $OUTPUT"
fi

# --- Case 3: a bad checksum must refuse to install ---------------------------
echo "case: checksum mismatch refuses"
fake="$(new_fake)"
publish "$fake" v0.4.1 0.4.1
write_releases_json "$fake/releases.json" "v0.4.1:0.4.1"
# Corrupt the tarball, leaving the sidecar checksum describing the original.
echo "tampered" >> "$fake/assets/v0.4.1/turma-agent-native-v0.4.1.tar.gz"
if run_bootstrap "$fake"; then
  fail "installed a tarball whose checksum did not match"
else
  case "$OUTPUT" in
    *"checksum mismatch"*) pass "refused a tampered tarball" ;;
    *) fail "refused, but not for the checksum: $OUTPUT" ;;
  esac
  if [ -f "$fake/record.version" ]; then
    fail "ran install.sh despite the bad checksum"
  else
    pass "never reached install.sh"
  fi
fi

# --- Case 4: a missing checksum sidecar must refuse too ----------------------
echo "case: missing checksum refuses"
fake="$(new_fake)"
publish "$fake" v0.4.1 0.4.1
write_releases_json "$fake/releases.json" "v0.4.1:0.4.1"
rm "$fake/assets/v0.4.1/turma-agent-native-v0.4.1.tar.gz.sha256"
if run_bootstrap "$fake"; then
  fail "installed unverified bits when no checksum was published"
else
  case "$OUTPUT" in
    *"no checksum published"*) pass "refused unverified bits" ;;
    *) fail "refused, but not for the missing checksum: $OUTPUT" ;;
  esac
fi

# --- Case 5: a stream with no native asset fails clearly ---------------------
echo "case: no native release found"
fake="$(new_fake)"
echo '[{"tag_name": "glasses-v0.2.22", "assets": [{"name": "turma-hud-v0.2.22.ehpk",
  "browser_download_url": "https://github.com/o/r/releases/download/glasses-v0.2.22/turma-hud-v0.2.22.ehpk"}]}]' \
  > "$fake/releases.json"
if run_bootstrap "$fake"; then
  fail "claimed success with no native asset in the stream"
else
  case "$OUTPUT" in
    *"no native agent release found"*) pass "reported an empty native stream clearly" ;;
    *) fail "failed, but without a usable message: $OUTPUT" ;;
  esac
fi

# --- Case 6: an unreachable API fails clearly --------------------------------
echo "case: unreachable release API"
fake="$(new_fake)"
rm -f "$fake/releases.json"
if run_bootstrap "$fake"; then
  fail "claimed success when the release API was unreachable"
else
  case "$OUTPUT" in
    *"cannot reach the GitHub release API"*) pass "reported the unreachable API clearly" ;;
    *) fail "failed, but without a usable message: $OUTPUT" ;;
  esac
fi

echo
if [ "$FAILED" -eq 0 ]; then echo "all bootstrap tests passed"; else echo "FAILURES"; fi
exit "$FAILED"
