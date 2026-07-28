#!/usr/bin/env bash
# Behavioural tests for agent/native/turma-agent-update.
#
# The updater is the ONLY runtime consumer of the release tag scheme, and it
# runs on deployed hosts we can't push to — so a bug here mis-updates the whole
# native fleet. ShellCheck covers syntax; this covers the decision. Each case
# stages a fake $PREFIX + a fake `gh` on PATH serving canned releases, runs the
# real script, and asserts what it installed and stamped.
#
# The load-bearing assertion is the carried-release NO-OP: a unified release
# whose tag moved ahead (v0.3.9) but whose agent-native COMPONENT was carried
# (still 0.3.0) must not reinstall — comparing the tag instead of the component
# version would reinstall the same bits on every poll and mis-stamp VERSION
# forever. See the header of turma-agent-update.
#
# Pure POSIX tooling (tar/sha256sum/python3/gh-stub); no docker needed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$(dirname "$HERE")/native"
SCRIPT="$NATIVE_DIR/turma-agent-update"
FAILED=0

pass() { echo "  ok: $1"; }
fail() { echo "  FAIL: $1"; FAILED=1; }
# assert <expected> <actual> <ok-msg> <fail-msg>
assert_eq() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$4"; fi; }

# --- Build a valid native tarball + sha256 sidecar for a given version -------
# The payload must satisfy install_payload's completeness check (hub-agent.py +
# tunnel-agent.js + hooks/).
make_tarball() {  # <version> <outdir>
  local version="$1" out="$2" staged
  staged="$(mktemp -d)"
  mkdir -p "$staged/hooks"
  echo "# hub-agent $version" >"$staged/hub-agent.py"
  echo "// tunnel $version" >"$staged/tunnel-agent.js"
  echo "# guard" >"$staged/hooks/guard.py"
  echo "$version" >"$staged/VERSION"
  local tgz="$out/turma-agent-native-v${version}.tar.gz"
  tar czf "$tgz" -C "$staged" .
  ( cd "$out" && sha256sum "turma-agent-native-v${version}.tar.gz" > "turma-agent-native-v${version}.tar.gz.sha256" )
  rm -rf "$staged"
  echo "$tgz"
}

# --- Fake `gh` ---------------------------------------------------------------
# Data-driven from $FAKE_GH_DIR:
#   tags               newline-separated release tags
#   manifests/<tag>.json
#   assets/<tag>/<file>...
# Supports: `gh auth status`, `gh api .../releases?... -q '.[].tag_name'`,
#           `gh release download <tag> --pattern P... --dir D --clobber`.
install_fake_gh() {  # <bindir>
  cat > "$1/gh" <<'STUB'
#!/usr/bin/env bash
set -eu
D="$FAKE_GH_DIR"
case "${1:-}" in
  auth) exit 0 ;;
  api) cat "$D/tags" 2>/dev/null || true; exit 0 ;;
  release)
    # gh release download <tag> [--repo R] --pattern P [--pattern P] --dir DIR --clobber
    shift # 'release'
    shift # 'download'
    tag=""; dir=""; patterns=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --pattern) shift; patterns+=("$1") ;;
        --dir) shift; dir="$1" ;;
        --repo) shift ;;
        --clobber) ;;
        -*) ;;
        *) [ -z "$tag" ] && tag="$1" ;;
      esac
      shift
    done
    mkdir -p "$dir"
    got=1
    for p in "${patterns[@]}"; do
      matched=0
      for f in "$D/assets/$tag/"*; do
        [ -e "$f" ] || continue
        base="$(basename "$f")"
        # shellcheck disable=SC2254
        case "$base" in $p) cp "$f" "$dir/$base"; matched=1 ;; esac
      done
      [ "$matched" = 1 ] || got=0
    done
    [ "$got" = 1 ] || exit 1
    exit 0 ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "$1/gh"
}

# --- Run the updater against a staged prefix ---------------------------------
# Echoes the resulting installed VERSION.
run_case() {  # <installed_version> <fake_gh_dir>
  local installed="$1" ghdir="$2" root prefix bin
  root="$(mktemp -d)"
  prefix="$root/prefix"; bin="$prefix/bin"
  mkdir -p "$bin"
  cp "$SCRIPT" "$bin/turma-agent-update"; chmod +x "$bin/turma-agent-update"
  # Existing runtime files (so a refused install leaves a coherent prefix).
  echo "# old" >"$prefix/hub-agent.py"
  echo "// old" >"$prefix/tunnel-agent.js"
  mkdir -p "$prefix/hooks"; echo "# old" >"$prefix/hooks/guard.py"
  echo "$installed" >"$prefix/VERSION"
  # Stub the restart so a successful install doesn't try to touch systemd.
  cat > "$bin/turma-agentctl" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "$bin/turma-agentctl"
  install_fake_gh "$bin"

  FAKE_GH_DIR="$ghdir" HOME="$root/home" PATH="$bin:$PATH" \
    TURMA_REPO="xerktech/turma" \
    "$bin/turma-agent-update" >/dev/null 2>&1 || true

  tr -d '[:space:]' < "$prefix/VERSION"
  rm -rf "$root"
}

# --- Fixture builders --------------------------------------------------------
new_gh_dir() { local d; d="$(mktemp -d)"; mkdir -p "$d/manifests" "$d/assets"; echo "$d"; }

# Add a unified release: tag, native component version, and (optionally) the
# tarball on a possibly-DIFFERENT release_tag (for the carried-asset case).
add_unified_release() {  # <ghdir> <tag> <native_version> <asset_release_tag>
  local d="$1" tag="$2" nver="$3" atag="$4"
  echo "$tag" >> "$d/tags"
  cat > "$d/manifests/$tag.json" <<EOF
{ "schema":1, "version":"${tag#v}", "tag":"$tag",
  "components": {
    "agent-native": {
      "version":"$nver", "kind":"asset",
      "asset":"turma-agent-native-v${nver}.tar.gz",
      "sha256_asset":"turma-agent-native-v${nver}.tar.gz.sha256",
      "release_tag":"$atag", "built":true
    }
  }
}
EOF
  mkdir -p "$d/assets/$tag"
  cp "$d/manifests/$tag.json" "$d/assets/$tag/manifest.json"
  # Put the tarball on the release the manifest points at (may be an older tag).
  mkdir -p "$d/assets/$atag"
  make_tarball "$nver" "$d/assets/$atag" >/dev/null
}

echo "test_turma_agent_update.sh"

# 1. Component newer than installed -> installs and stamps the component version.
d="$(new_gh_dir)"
add_unified_release "$d" "v0.3.5" "0.3.5" "v0.3.5"
got="$(run_case "0.3.0" "$d")"
assert_eq "0.3.5" "$got" "newer component installs (-> $got)" "expected 0.3.5, got $got"
rm -rf "$d"

# 2. Carried release: tag moved to v0.3.9 but native component stayed 0.3.0 ==
#    installed -> NO-OP (the anti-reinstall-loop invariant). Tag comparison
#    would (wrongly) update; component comparison correctly does nothing.
d="$(new_gh_dir)"
add_unified_release "$d" "v0.3.9" "0.3.0" "v0.3.0"
got="$(run_case "0.3.0" "$d")"
assert_eq "0.3.0" "$got" "carried release is a no-op despite newer tag (stayed $got)" "carried release wrongly changed VERSION to $got"
rm -rf "$d"

# 3. Carried-but-newer asset lives on an OLDER release: manifest on v0.3.9 says
#    native 0.3.4 with release_tag v0.3.4 -> installs 0.3.4 from that release.
d="$(new_gh_dir)"
add_unified_release "$d" "v0.3.9" "0.3.4" "v0.3.4"
got="$(run_case "0.3.0" "$d")"
assert_eq "0.3.4" "$got" "resolves carried asset from its own release_tag (-> $got)" "expected 0.3.4 from v0.3.4, got $got"
rm -rf "$d"

# 4. Checksum mismatch -> refuses, VERSION unchanged.
d="$(new_gh_dir)"
add_unified_release "$d" "v0.3.5" "0.3.5" "v0.3.5"
# Corrupt the tarball after the sha sidecar was written.
echo "corruption" >> "$d/assets/v0.3.5/turma-agent-native-v0.3.5.tar.gz"
got="$(run_case "0.3.0" "$d")"
assert_eq "0.3.0" "$got" "checksum mismatch refuses install (stayed $got)" "installed a corrupt tarball (VERSION now $got)"
rm -rf "$d"

# 5. No unified release, only legacy agent-native-v* -> legacy fallback installs.
d="$(new_gh_dir)"
echo "agent-native-v0.2.9" >> "$d/tags"
mkdir -p "$d/assets/agent-native-v0.2.9"
make_tarball "0.2.9" "$d/assets/agent-native-v0.2.9" >/dev/null
got="$(run_case "0.2.5" "$d")"
assert_eq "0.2.9" "$got" "legacy fallback installs when no unified release exists (-> $got)" "legacy fallback failed, got $got"
rm -rf "$d"

# 6. Unified present but up to date -> no-op.
d="$(new_gh_dir)"
add_unified_release "$d" "v0.3.5" "0.3.5" "v0.3.5"
got="$(run_case "0.3.5" "$d")"
assert_eq "0.3.5" "$got" "up-to-date unified release is a no-op (stayed $got)" "reinstalled an up-to-date version, got $got"
rm -rf "$d"

# 7. A successful install leaves the running manager an EXPECTED-restart hint
#    (~/.turma/updating.json) carrying the target version, so its SIGTERM handler
#    announces `updating` to the hub instead of the restart looking like an
#    outage (XERK-29). run_case discards the home dir, so drive it inline here.
d="$(new_gh_dir)"
add_unified_release "$d" "v0.3.5" "0.3.5" "v0.3.5"
root="$(mktemp -d)"; prefix="$root/prefix"; bin="$prefix/bin"; mkdir -p "$bin"
cp "$SCRIPT" "$bin/turma-agent-update"; chmod +x "$bin/turma-agent-update"
echo "# old" >"$prefix/hub-agent.py"; echo "// old" >"$prefix/tunnel-agent.js"
mkdir -p "$prefix/hooks"; echo "# old" >"$prefix/hooks/guard.py"
echo "0.3.0" >"$prefix/VERSION"
printf '#!/bin/sh\nexit 0\n' > "$bin/turma-agentctl"; chmod +x "$bin/turma-agentctl"
install_fake_gh "$bin"
FAKE_GH_DIR="$d" HOME="$root/home" PATH="$bin:$PATH" TURMA_REPO="xerktech/turma" \
  "$bin/turma-agent-update" >/dev/null 2>&1 || true
flag="$root/home/.turma/updating.json"
if [ -f "$flag" ] && grep -q '"version":"0.3.5"' "$flag" && grep -q '"reason":"update"' "$flag"; then
  pass "install writes the updating hint (reason + target version)"
else
  fail "no/incorrect updating.json after install ($(cat "$flag" 2>/dev/null))"
fi
rm -rf "$root" "$d"

# --- No GitHub login at all (XERK-151) ---------------------------------------
# The repo is PUBLIC, so reading the release stream needs no credential — but
# the updater used to require `gh auth` or $GH_TOKEN and reported "no native
# release found (or auth unavailable)" forever on a host with neither. That is
# exactly a host that only ever talks to a non-GitHub tracker, and it silently
# pinned it to whatever version it was installed at.

# A `gh` that EXISTS but is not logged in — deterministically false `have_gh`
# whether or not the runner has a real gh on PATH, and the real-world shape of
# the failure (a work box with gh installed and never authed).
install_unauthed_gh() {  # <bindir>
  # Always fails, so `gh auth status` (the whole of have_gh's second half) is
  # false and no gh path can be taken.
  printf '#!/bin/sh\nexit 1\n' > "$1/gh"
  chmod +x "$1/gh"
}

# A `curl` serving the same $FAKE_GH_DIR fixtures over the public REST shapes
# the script falls back to: the release list, one release's assets, and an
# asset's bytes. Logs every header it was given so a case can assert on auth.
install_fake_curl() {  # <bindir>
  cat > "$1/curl" <<'STUB'
#!/usr/bin/env bash
set -eu
D="$FAKE_GH_DIR"
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1" ;;
    -H) shift; printf '%s\n' "$1" >> "$D/curl-headers.log" ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
printf '%s\n' "$url" >> "$D/curl-urls.log"
case "$url" in
  TESTASSET:*)
    rest="${url#TESTASSET:}"; tag="${rest%%:*}"; name="${rest#*:}"
    [ -f "$D/assets/$tag/$name" ] || exit 1
    if [ -n "$out" ]; then cp "$D/assets/$tag/$name" "$out"; else cat "$D/assets/$tag/$name"; fi ;;
  *releases/tags/*)
    tag="${url##*/}"
    printf '{"assets":['
    first=1
    for f in "$D/assets/$tag/"*; do
      [ -e "$f" ] || continue
      b="$(basename "$f")"
      [ "$first" = 1 ] || printf ','
      printf '{"name":"%s","url":"TESTASSET:%s:%s"}' "$b" "$tag" "$b"; first=0
    done
    printf ']}' ;;
  *releases*per_page*)
    printf '['
    first=1
    while IFS= read -r t; do
      [ -n "$t" ] || continue
      [ "$first" = 1 ] || printf ','
      printf '{"tag_name":"%s"}' "$t"; first=0
    done < "$D/tags"
    printf ']' ;;
  *) exit 1 ;;
esac
STUB
  chmod +x "$1/curl"
}

# Run the updater with NO usable gh, so only the curl path can work.
run_noauth_case() {  # <installed_version> <fake_gh_dir> [GH_TOKEN]
  local installed="$1" ghdir="$2" token="${3:-}" root prefix bin
  root="$(mktemp -d)"
  prefix="$root/prefix"; bin="$prefix/bin"; mkdir -p "$bin"
  cp "$SCRIPT" "$bin/turma-agent-update"; chmod +x "$bin/turma-agent-update"
  echo "# old" >"$prefix/hub-agent.py"; echo "// old" >"$prefix/tunnel-agent.js"
  mkdir -p "$prefix/hooks"; echo "# old" >"$prefix/hooks/guard.py"
  echo "$installed" >"$prefix/VERSION"
  printf '#!/bin/sh\nexit 0\n' > "$bin/turma-agentctl"; chmod +x "$bin/turma-agentctl"
  install_unauthed_gh "$bin"
  install_fake_curl "$bin"
  FAKE_GH_DIR="$ghdir" HOME="$root/home" PATH="$bin:$PATH" \
    TURMA_REPO="xerktech/turma" GH_TOKEN="$token" \
    "$bin/turma-agent-update" >/dev/null 2>&1 || true
  tr -d '[:space:]' < "$prefix/VERSION"
  rm -rf "$root"
}

# 8. No gh login and no token -> the anonymous public read still updates.
d="$(new_gh_dir)"
add_unified_release "$d" "v0.6.4" "0.6.4" "v0.6.4"
got="$(run_noauth_case "0.5.38" "$d")"
assert_eq "0.6.4" "$got" "updates with no gh login and no token (-> $got)" "a host with no GitHub auth stayed at $got"
# ...and it sent no Authorization header it doesn't have.
if grep -qi 'authorization' "$d/curl-headers.log" 2>/dev/null; then
  fail "sent an Authorization header with no token available"
else
  pass "anonymous read sends no Authorization header"
fi
rm -rf "$d"

# 9. No gh login but $GH_TOKEN set -> same path, and the token is carried (a
#    private fork / a rate-limited host still authenticates).
d="$(new_gh_dir)"
add_unified_release "$d" "v0.6.4" "0.6.4" "v0.6.4"
got="$(run_noauth_case "0.5.38" "$d" "tok123")"
assert_eq "0.6.4" "$got" "updates via GH_TOKEN when gh is unusable (-> $got)" "GH_TOKEN path failed, got $got"
if grep -q 'Authorization: Bearer tok123' "$d/curl-headers.log" 2>/dev/null; then
  pass "GH_TOKEN rides the request when set"
else
  fail "GH_TOKEN was set but never sent"
fi
rm -rf "$d"

if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$FAILED"
