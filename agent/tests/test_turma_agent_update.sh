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
[ "$got" = "0.3.5" ] && pass "newer component installs (-> $got)" || fail "expected 0.3.5, got $got"
rm -rf "$d"

# 2. Carried release: tag moved to v0.3.9 but native component stayed 0.3.0 ==
#    installed -> NO-OP (the anti-reinstall-loop invariant). Tag comparison
#    would (wrongly) update; component comparison correctly does nothing.
d="$(new_gh_dir)"
add_unified_release "$d" "v0.3.9" "0.3.0" "v0.3.0"
got="$(run_case "0.3.0" "$d")"
[ "$got" = "0.3.0" ] && pass "carried release is a no-op despite newer tag (stayed $got)" || fail "carried release wrongly changed VERSION to $got"
rm -rf "$d"

# 3. Carried-but-newer asset lives on an OLDER release: manifest on v0.3.9 says
#    native 0.3.4 with release_tag v0.3.4 -> installs 0.3.4 from that release.
d="$(new_gh_dir)"
add_unified_release "$d" "v0.3.9" "0.3.4" "v0.3.4"
got="$(run_case "0.3.0" "$d")"
[ "$got" = "0.3.4" ] && pass "resolves carried asset from its own release_tag (-> $got)" || fail "expected 0.3.4 from v0.3.4, got $got"
rm -rf "$d"

# 4. Checksum mismatch -> refuses, VERSION unchanged.
d="$(new_gh_dir)"
add_unified_release "$d" "v0.3.5" "0.3.5" "v0.3.5"
# Corrupt the tarball after the sha sidecar was written.
echo "corruption" >> "$d/assets/v0.3.5/turma-agent-native-v0.3.5.tar.gz"
got="$(run_case "0.3.0" "$d")"
[ "$got" = "0.3.0" ] && pass "checksum mismatch refuses install (stayed $got)" || fail "installed a corrupt tarball (VERSION now $got)"
rm -rf "$d"

# 5. No unified release, only legacy agent-native-v* -> legacy fallback installs.
d="$(new_gh_dir)"
echo "agent-native-v0.2.9" >> "$d/tags"
mkdir -p "$d/assets/agent-native-v0.2.9"
make_tarball "0.2.9" "$d/assets/agent-native-v0.2.9" >/dev/null
got="$(run_case "0.2.5" "$d")"
[ "$got" = "0.2.9" ] && pass "legacy fallback installs when no unified release exists (-> $got)" || fail "legacy fallback failed, got $got"
rm -rf "$d"

# 6. Unified present but up to date -> no-op.
d="$(new_gh_dir)"
add_unified_release "$d" "v0.3.5" "0.3.5" "v0.3.5"
got="$(run_case "0.3.5" "$d")"
[ "$got" = "0.3.5" ] && pass "up-to-date unified release is a no-op (stayed $got)" || fail "reinstalled an up-to-date version, got $got"
rm -rf "$d"

if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$FAILED"
