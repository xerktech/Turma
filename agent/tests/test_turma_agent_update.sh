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
make_tarball() {  # <version> <outdir> [nohooks]
  local version="$1" out="$2" staged
  staged="$(mktemp -d)"
  mkdir -p "$staged/hooks"
  echo "# hub-agent $version" >"$staged/hub-agent.py"
  echo "// tunnel $version" >"$staged/tunnel-agent.js"
  echo "# guard" >"$staged/hooks/guard.py"
  # A payload missing hooks/ — the swap DELETES the installed hooks before it
  # moves the staged ones in, so this must be refused outright.
  [ "${3:-}" = nohooks ] && rm -rf "$staged/hooks"
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
# Neutralise every restart path the updater can take. It tries, in order:
#   systemctl --user restart turma-agent   (a user manager is reachable)
#   systemctl restart turma-agent          (system scope)
#   $PREFIX/bin/turma-agentctl restart     (no systemd at all)
# The inline stub covered only the last of those, which made the comment it
# carried ("so a successful install doesn't try to touch systemd") untrue: on a
# systemd host both systemctl branches were live and would have hit the REAL
# unit. Measured with a PATH sentinel, today's cases never actually reach the
# restart, so this is latent rather than a bug anyone has hit — but a test that
# claims to isolate systemd should isolate all three paths, not one.
install_fake_restart() {  # <bindir>
  cat > "$1/turma-agentctl" <<'EOF'
#!/bin/sh
echo "turma-agentctl $*" >> "${TURMA_TEST_RESTART_LOG:-/dev/null}"
exit 0
EOF
  cat > "$1/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >> "${TURMA_TEST_RESTART_LOG:-/dev/null}"
exit 0
EOF
  chmod +x "$1/turma-agentctl" "$1/systemctl"
}

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
  install_fake_restart "$bin"
  install_fake_gh "$bin"

  # The Claude Code half is exercised by its own cases below; these are about
  # the release scheme, and leaving it on would reach the REAL npm registry
  # (every CI runner has npm) and try to install claude for real.
  FAKE_GH_DIR="$ghdir" HOME="$root/home" PATH="$bin:$PATH" \
    TURMA_REPO="xerktech/turma" TURMA_CLAUDE_AUTO_UPDATE=0 \
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
install_fake_restart "$bin"

install_fake_gh "$bin"
FAKE_GH_DIR="$d" HOME="$root/home" PATH="$bin:$PATH" TURMA_REPO="xerktech/turma" \
  TURMA_CLAUDE_AUTO_UPDATE=0 "$bin/turma-agent-update" >/dev/null 2>&1 || true
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
  install_fake_restart "$bin"
  install_unauthed_gh "$bin"
  install_fake_curl "$bin"
  FAKE_GH_DIR="$ghdir" HOME="$root/home" PATH="$bin:$PATH" \
    TURMA_REPO="xerktech/turma" GH_TOKEN="$token" TURMA_CLAUDE_AUTO_UPDATE=0 \
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

# --- Claude Code updates (XERK-254) ------------------------------------------
# The agent ships the manager, not the coding agent, so `claude` used to be
# installed once and never touched again. These cases pin the decision, which is
# deliberately a version COMPARE rather than an unconditional `npm i -g @latest`:
# the install replaces the package directory under live sessions, so it must fire
# only when there is really something newer.

# A `claude` that reports a version, and an `npm` serving a canned registry.
# Both record what they were asked to do in $CLAUDE_LOG, which is the assertion.
# <managed> picks which install path the code should take:
#   yes        npm knows the package AND npm's global prefix is where PATH finds
#              claude -> the npm path
#   no         npm doesn't know it (Anthropic's native installer) -> claude update
#   elsewhere  npm knows it, but PATH resolves claude from somewhere else -> the
#              npm copy is not the one this host runs, so npm must NOT be used
install_fake_claude_toolchain() {  # <bindir> <installed|none> <latest|none> <yes|no|elsewhere>
  local bin="$1" installed="$2" latest="$3" managed="$4" prefix
  prefix="$(dirname "$bin")"
  # `npm prefix -g` — the dir npm installs into. Only "yes" has it contain the
  # claude that PATH resolves ($bin is $prefix/bin).
  case "$managed" in
    yes) echo "$prefix" > "$bin/.npm-prefix" ;;
    *)   echo "$prefix/somewhere-else" > "$bin/.npm-prefix" ;;
  esac
  if [ "$installed" != "none" ]; then
    cat > "$bin/claude" <<STUB
#!/bin/sh
case "\$1" in
  --version)
     [ -n "\${STUB_CLAUDE_HANG:-}" ] && sleep "\$STUB_CLAUDE_HANG"
     echo "\$(cat "$bin/.claude-version") (Claude Code)" ;;
  update)
     echo "claude-update" >> "\$CLAUDE_LOG"
     # \$STUB_CLAUDE_UPDATE_NOOP: exits 0 having changed nothing, which is what
     # a native-installer channel lagging npm's published latest does.
     [ -n "\${STUB_CLAUDE_UPDATE_NOOP:-}" ] || echo "$latest" > "$bin/.claude-version" ;;
  *) exit 2 ;;
esac
STUB
    chmod +x "$bin/claude"
    printf '%s\n' "$installed" > "$bin/.claude-version"
  else
    rm -f "$bin/claude" "$bin/.claude-version"
  fi
  cat > "$bin/npm" <<STUB
#!/bin/sh
case "\$1 \$2" in
  "view @anthropic-ai/claude-code")
     [ "$latest" = none ] && exit 1
     echo "$latest" ;;
  "ls -g")
     echo "ls-g" >> "\$CLAUDE_LOG"
     [ "$managed" != no ] ;;
  "prefix -g") cat "$bin/.npm-prefix" ;;
  "install -g")
     echo "npm-install \$*" >> "\$CLAUDE_LOG"
     # \$STUB_NPM_FAIL makes the FIRST install fail the way an EACCES against a
     # root-owned global prefix does, so the fallback is observable.
     # \$STUB_NPM_ALWAYS_FAIL is the network-is-down shape: the install never
     # reaches the registry, on this start and the next.
     [ -n "\${STUB_NPM_ALWAYS_FAIL:-}" ] && exit 243
     if [ -n "\${STUB_NPM_FAIL:-}" ] && [ ! -f "$bin/.npm-failed-once" ]; then
       : > "$bin/.npm-failed-once"; exit 243
     fi
     # \$STUB_NPM_NOOP installs "successfully" without moving the version PATH
     # resolves — what really happens when npm's copy isn't the one on PATH.
     [ -n "\${STUB_NPM_NOOP:-}" ] && exit 0
     printf '%s\n' "$latest" > "$bin/.claude-version" ;;
  *) exit 2 ;;
esac
STUB
  chmod +x "$bin/npm"
}

# Run the Claude Code check the way the launcher does (--claude-only). The
# release half is a no-op here — it is a separate command now, precisely so a
# claude update only ever happens at agent start.
# Echoes the recorded claude/npm calls, one per line.
run_claude_case() {  # <installed_claude|none> <latest|none> <yes|no|elsewhere> [env=val...]
  local installed="$1" latest="$2" managed="$3"; shift 3
  local root prefix bin ghdir
  root="$(mktemp -d)"; prefix="$root/prefix"; bin="$prefix/bin"; mkdir -p "$bin"
  cp "$SCRIPT" "$bin/turma-agent-update"; chmod +x "$bin/turma-agent-update"
  echo "# old" >"$prefix/hub-agent.py"; echo "// old" >"$prefix/tunnel-agent.js"
  mkdir -p "$prefix/hooks"; echo "# old" >"$prefix/hooks/guard.py"
  echo "0.3.0" >"$prefix/VERSION"
  install_fake_restart "$bin"
  install_fake_gh "$bin"
  install_fake_claude_toolchain "$bin" "$installed" "$latest" "$managed"
  ghdir="$(new_gh_dir)"
  add_unified_release "$ghdir" "v0.3.0" "0.3.0" "v0.3.0"

  # A NARROW PATH, not "$bin:$PATH": the "claude is missing" case is only
  # missing if the developer's own claude (typically ~/.local/bin, the very
  # prefix install.sh blesses) can't be found behind the stubs. $bin carries
  # every stub; /usr/bin + /bin carry the coreutils the script needs.
  env FAKE_GH_DIR="$ghdir" HOME="$root/home" PATH="$bin:/usr/bin:/bin" \
    TURMA_REPO="xerktech/turma" CLAUDE_LOG="$root/claude.log" "$@" \
    "$bin/turma-agent-update" --claude-only >"$root/out.log" 2>&1 || true

  cat "$root/claude.log" 2>/dev/null || true
  # The updater's own log lines, so a case can assert on what it REPORTED.
  sed 's/^/LOG /' "$root/out.log" 2>/dev/null || true
  rm -rf "$root" "$ghdir"
}

# 10. Newer published version -> installs it.
got="$(run_claude_case "2.0.1" "2.0.9" yes)"
if printf '%s' "$got" | grep -q 'npm-install .*@anthropic-ai/claude-code@latest'; then
  pass "a newer Claude Code is installed"
else
  fail "newer Claude Code was not installed (log: $got)"
fi

# 11. Already current -> nothing is touched. This is the load-bearing one: the
#     boot check now runs on EVERY restart, so an up-to-date host must be a true
#     no-op, not a reinstall under whatever sessions are live.
got="$(run_claude_case "2.0.9" "2.0.9" yes)"
if printf '%s' "$got" | grep -q 'npm-install'; then
  fail "reinstalled an already-current Claude Code (log: $got)"
else
  pass "an up-to-date Claude Code is a no-op"
fi

# 12. Installed is AHEAD of the registry (a hand-pinned or unpublished build)
#     -> never downgraded.
got="$(run_claude_case "2.1.0" "2.0.9" yes)"
if printf '%s' "$got" | grep -q 'npm-install'; then
  fail "downgraded a Claude Code that was ahead of the registry (log: $got)"
else
  pass "an installed version ahead of the registry is left alone"
fi

# 13. Registry unreachable -> stay put. An unanswerable "what's latest?" must
#     never read as "reinstall".
got="$(run_claude_case "2.0.1" none yes)"
if printf '%s' "$got" | grep -q 'npm-install'; then
  fail "installed something with an unreachable registry (log: $got)"
else
  pass "an unreachable registry leaves the install alone"
fi

# 14. claude MISSING -> installed, not merely reported. Without it every session
#     this agent launches dies on exec, so this is a repair, not an upgrade.
got="$(run_claude_case none "2.0.9" no)"
if printf '%s' "$got" | grep -q 'npm-install'; then
  pass "a missing Claude Code is installed"
else
  fail "a missing Claude Code was not installed (log: $got)"
fi

# 15. Not npm-managed (Anthropic's native installer owns it) -> `claude update`,
#     never `npm install -g`, which would lay a second claude beside the first
#     and leave PATH order deciding the version.
got="$(run_claude_case "2.0.1" "2.0.9" no)"
if printf '%s' "$got" | grep -q 'claude-update' && ! printf '%s' "$got" | grep -q 'npm-install'; then
  pass "a native-installer claude updates through 'claude update'"
else
  fail "wrong update path for a non-npm claude (log: $got)"
fi

# 16. TURMA_CLAUDE_AUTO_UPDATE=0 pins the host.
got="$(run_claude_case "2.0.1" "2.0.9" yes TURMA_CLAUDE_AUTO_UPDATE=0)"
if printf '%s' "$got" | grep -q 'npm-install\|claude-update'; then
  fail "TURMA_CLAUDE_AUTO_UPDATE=0 still touched claude (log: $got)"
else
  pass "TURMA_CLAUDE_AUTO_UPDATE=0 pins the installed Claude Code"
fi

# 16a. npm KNOWS the package, but PATH resolves claude from somewhere else — the
#      shape this host is one `npm i -g` away from (npm's prefix is ~/.local/node,
#      claude lives in ~/.local/bin). Using npm here "updates" a copy nobody runs,
#      reports the unchanged old version as success, and does it again on every
#      check, forever.
got="$(run_claude_case "2.0.1" "2.0.9" elsewhere)"
if printf '%s' "$got" | grep -q 'npm-install'; then
  fail "npm-updated a copy that is not the claude on PATH (log: $got)"
else
  pass "an npm copy that isn't the claude on PATH is not the one updated"
fi

# 16b. An install that reports success without moving the version on PATH is
#      REPORTED as such, not logged as if it had worked.
got="$(run_claude_case "2.0.1" "2.0.9" yes STUB_NPM_NOOP=1)"
if printf '%s' "$got" | grep -q 'LOG .*still resolves 2.0.1'; then
  pass "an install that changes nothing is called out, not reported as success"
else
  fail "a no-op install was reported as a successful update (log: $got)"
fi

# 16c. A claude that RUNS but prints no parseable version is a half-written
#      install, not a stale one: it is REPAIRED rather than compared, and the
#      repair is verified — a claude that still can't say what it is afterwards
#      must be reported, never logged as a success.
got="$(run_claude_case "garbage-not-a-version" "2.0.9" yes)"
if printf '%s' "$got" | grep -q 'npm-install'; then
  pass "an unreadable claude is reinstalled"
else
  fail "an unreadable claude was left broken forever (log: $got)"
fi
if printf '%s' "$got" | grep -q 'LOG .*no readable version'; then
  pass "a repair that changed nothing is reported, not claimed"
else
  fail "an unverified repair was reported as success (log: $got)"
fi

# 16c-ii. ...and it is not attempted AGAIN while claude keeps printing the same
#      thing. An unreadable version is usually a half-written install, but it can
#      equally be a working claude whose version shape this doesn't parse (a
#      future two-component or calver string) — and there, reinstalling fixes
#      nothing, so repeating it every start is a real `npm install -g` on every
#      boot forever, inside the awaited path.
root="$(mktemp -d)"; prefix="$root/prefix"; bin="$prefix/bin"; mkdir -p "$bin"
cp "$SCRIPT" "$bin/turma-agent-update"; chmod +x "$bin/turma-agent-update"
echo "# old" >"$prefix/hub-agent.py"; echo "// old" >"$prefix/tunnel-agent.js"
mkdir -p "$prefix/hooks"; echo "# old" >"$prefix/hooks/guard.py"
echo "0.3.0" >"$prefix/VERSION"
install_fake_restart "$bin"; install_fake_gh "$bin"
# A claude whose version this cannot parse, and an npm install that (correctly)
# does not change that — the shape where the repair is futile.
install_fake_claude_toolchain "$bin" "not-a-parseable-version" "not-a-parseable-version" yes
d="$(new_gh_dir)"; add_unified_release "$d" "v0.3.0" "0.3.0" "v0.3.0"
: > "$root/claude.log"
for _ in 1 2 3; do
  env FAKE_GH_DIR="$d" HOME="$root/home" PATH="$bin:/usr/bin:/bin" \
    TURMA_REPO="xerktech/turma" CLAUDE_LOG="$root/claude.log" \
    TURMA_BOOT_UPDATE_MIN_INTERVAL=0 \
    "$bin/turma-agent-update" --claude-only >>"$root/out.log" 2>&1 || true
done
installs="$(grep -c 'npm-install' "$root/claude.log" 2>/dev/null || true)"
if [ "${installs:-0}" = "1" ]; then
  pass "a futile repair is tried once, not on every start ($installs install)"
else
  fail "an unparseable version was reinstalled $installs time(s) — once per start, forever"
fi
if grep -q 'a repair already failed to change that' "$root/out.log"; then
  pass "and says why it is leaving it alone"
else
  fail "no explanation for skipping the repair: $(cat "$root/out.log")"
fi
rm -rf "$root" "$d"

# 16c-iii. A repair that never RAN must not be remembered as tried. "The host
#      restarted while its network was down" is an ordinary condition, and
#      remembering that failed install as "already tried" would brick Claude Code
#      on the host permanently — every session launch failing, one log line as
#      the evidence.
root="$(mktemp -d)"; prefix="$root/prefix"; bin="$prefix/bin"; mkdir -p "$bin"
cp "$SCRIPT" "$bin/turma-agent-update"; chmod +x "$bin/turma-agent-update"
echo "# old" >"$prefix/hub-agent.py"; echo "// old" >"$prefix/tunnel-agent.js"
mkdir -p "$prefix/hooks"; echo "# old" >"$prefix/hooks/guard.py"
echo "0.3.0" >"$prefix/VERSION"
install_fake_restart "$bin"; install_fake_gh "$bin"
# A genuinely broken claude (the shape a half-extracted package prints) and an
# install that cannot reach the registry.
install_fake_claude_toolchain "$bin" "Error: Cannot find module cli.js" "2.0.9" yes
d="$(new_gh_dir)"; add_unified_release "$d" "v0.3.0" "0.3.0" "v0.3.0"
: > "$root/claude.log"
for _ in 1 2 3; do
  env FAKE_GH_DIR="$d" HOME="$root/home" PATH="$bin:/usr/bin:/bin" \
    TURMA_REPO="xerktech/turma" CLAUDE_LOG="$root/claude.log" \
    TURMA_BOOT_UPDATE_MIN_INTERVAL=0 STUB_NPM_ALWAYS_FAIL=1 \
    "$bin/turma-agent-update" --claude-only >>"$root/out.log" 2>&1 || true
done
installs="$(grep -c 'npm-install' "$root/claude.log" 2>/dev/null || true)"
if [ "${installs:-0}" -ge 3 ]; then
  pass "a repair that never ran is retried, not remembered ($installs attempts)"
else
  fail "a failed install was remembered as 'already tried' — claude stays broken forever ($installs attempts)"
fi
if [ -f "$root/home/.turma/claude-unparseable" ]; then
  fail "wrote the give-up marker for a repair that never ran"
else
  pass "no give-up marker without a repair"
fi
rm -rf "$root" "$d"

# 16d. A registry answering with something that is not a version must read as
#      "stay put": sort -V ranks any non-numeric string ABOVE a semver, so a
#      proxy error line would otherwise look like an upgrade every single time.
got="$(run_claude_case "2.0.1" "not-a-version" yes)"
if printf '%s' "$got" | grep -q 'npm-install'; then
  fail "treated unparseable registry output as a newer version (log: $got)"
else
  pass "unparseable registry output is not an upgrade"
fi

# 16e. The EACCES fallback. A non-root user against a root-owned global prefix
#      must retry into the prefix install.sh blesses and the launcher puts on
#      PATH — and ROOT must not, because root can write the real prefix and a
#      retry would put claude somewhere PATH may not reach.
got="$(run_claude_case "2.0.1" "2.0.9" yes STUB_NPM_FAIL=1)"
if [ "$(id -u)" = 0 ]; then
  if printf '%s' "$got" | grep -q 'npm-install .*--prefix'; then
    fail "root retried into a user prefix instead of failing (log: $got)"
  else
    pass "root does not fall back to a user prefix"
  fi
else
  # run_claude_case gives the updater its own HOME and then discards it, so
  # match the shape rather than this shell's $HOME.
  if printf '%s' "$got" | grep -qE 'npm-install install -g --prefix .*/home/\.local'; then
    pass "a non-root EACCES retries into \$HOME/.local"
  else
    fail "no ~/.local retry after an EACCES-shaped failure (log: $got)"
  fi
fi

# 16f. Claude Code is NOT part of the hourly/manual agent check: replacing the
#      package makes `claude` briefly absent from PATH, which is only safe when
#      no session can be launching — i.e. at agent start, before the manager
#      exists. A plain run must therefore touch claude not at all.
root="$(mktemp -d)"; prefix="$root/prefix"; bin="$prefix/bin"; mkdir -p "$bin"
cp "$SCRIPT" "$bin/turma-agent-update"; chmod +x "$bin/turma-agent-update"
echo "# old" >"$prefix/hub-agent.py"; echo "// old" >"$prefix/tunnel-agent.js"
mkdir -p "$prefix/hooks"; echo "# old" >"$prefix/hooks/guard.py"
echo "0.3.0" >"$prefix/VERSION"
install_fake_restart "$bin"; install_fake_gh "$bin"
install_fake_claude_toolchain "$bin" "2.0.1" "2.0.9" yes
d="$(new_gh_dir)"; add_unified_release "$d" "v0.3.0" "0.3.0" "v0.3.0"
FAKE_GH_DIR="$d" HOME="$root/home" PATH="$bin:/usr/bin:/bin" TURMA_REPO="xerktech/turma" \
  CLAUDE_LOG="$root/claude.log" "$bin/turma-agent-update" >/dev/null 2>&1 || true
if [ -s "$root/claude.log" ]; then
  fail "the hourly/manual agent check touched claude ($(cat "$root/claude.log"))"
else
  pass "a plain agent check leaves claude alone"
fi
rm -rf "$root" "$d"

# 16g. npm's global prefix is somewhere this agent's PATH never looks. Installing
#      there is not an install: claude still isn't runnable, the next check finds
#      it MISSING again, and the whole thing repeats inside the boot path forever.
#      It must go where the launcher can actually reach it.
got="$(run_claude_case none "2.0.9" elsewhere)"
if printf '%s' "$got" | grep -qE 'npm-install install -g --prefix .*/home/\.local'; then
  pass "an unreachable npm prefix is installed around, not into"
else
  fail "installed into a prefix this agent's PATH can't reach (log: $got)"
fi

# 16h. `claude update` exits 0 whether or not it changed anything — its channel
#      can lag npm's `latest`. An update that moved nothing must say so, or the
#      log is indistinguishable from a real one and it re-fires on every start.
got="$(run_claude_case "2.0.1" "2.0.9" no STUB_CLAUDE_UPDATE_NOOP=1)"
if printf '%s' "$got" | grep -q 'LOG .*still resolves 2.0.1'; then
  pass "a 'claude update' that changed nothing is called out"
else
  fail "a no-op claude update was logged as success (log: $got)"
fi

# 16i. The probe is bounded on its OWN, not merely by the launcher's outer
#      timeout: this script holds the update lock while it runs, so a hung claude
#      would block every later update — including the one shipping the fix.
start=$(date +%s)
got="$(run_claude_case "2.0.1" "2.0.9" yes STUB_CLAUDE_HANG=60 TURMA_CLAUDE_PROBE_TIMEOUT=2)"
elapsed=$(( $(date +%s) - start ))
if [ "$elapsed" -lt 30 ]; then
  pass "a hung 'claude --version' is cut short by its own timeout (${elapsed}s)"
else
  fail "the version probe ran unbounded (${elapsed}s)"
fi

# 16j. ~/.turma is writable by the identity the SESSIONS run as, so every file
#      this script opens there is a denial-of-service surface: opening a FIFO
#      blocks until the other end appears, with NO error for `|| true` to catch,
#      and this runs inside an awaited agent start. Stamp, marker, log and lock
#      are all attacked at once; the run must complete regardless.
if command -v mkfifo >/dev/null 2>&1; then
  root="$(mktemp -d)"; prefix="$root/prefix"; bin="$prefix/bin"; mkdir -p "$bin"
  cp "$SCRIPT" "$bin/turma-agent-update"; chmod +x "$bin/turma-agent-update"
  echo "# old" >"$prefix/hub-agent.py"; echo "// old" >"$prefix/tunnel-agent.js"
  mkdir -p "$prefix/hooks"; echo "# old" >"$prefix/hooks/guard.py"
  echo "0.3.0" >"$prefix/VERSION"
  install_fake_restart "$bin"; install_fake_gh "$bin"
  install_fake_claude_toolchain "$bin" "2.0.1" "2.0.1" yes
  d="$(new_gh_dir)"; add_unified_release "$d" "v0.3.0" "0.3.0" "v0.3.0"
  mkdir -p "$root/home/.turma"
  mkfifo "$root/home/.turma/last-claude-check" \
         "$root/home/.turma/claude-unparseable" \
         "$root/home/.turma/update.log" \
         "$root/home/.turma/update.lock" 2>/dev/null || true
  rc=0
  env FAKE_GH_DIR="$d" HOME="$root/home" PATH="$bin:/usr/bin:/bin" \
    TURMA_REPO="xerktech/turma" CLAUDE_LOG="$root/claude.log" \
    timeout 30 "$bin/turma-agent-update" --claude-only >"$root/out.log" 2>&1 || rc=$?
  if [ "$rc" = 124 ]; then
    fail "a FIFO in ~/.turma blocked the check — on a real host that is a delayed or wedged start"
  else
    pass "FIFOs planted in ~/.turma don't block the check"
  fi
  if grep -q 'claude up to date' "$root/out.log"; then
    pass "and it still did its job"
  else
    fail "the check didn't run with FIFOs present: $(cat "$root/out.log")"
  fi
  rm -rf "$root" "$d"
else
  pass "mkfifo unavailable; FIFO case skipped"
fi

# 16k. A malformed timeout knob must not be mistaken for a broken claude.
#      `timeout -k abc 30 cmd` exits 125 WITHOUT running the command, so an
#      unsanitised value doesn't disable a check — it makes every `claude
#      --version` look unreadable, and every start then attempts a futile repair
#      while no update check ever happens.
for bad in abc -5 0 30.5; do
  got="$(run_claude_case "2.0.1" "2.0.9" yes "TURMA_KILL_GRACE=$bad")"
  if printf '%s' "$got" | grep -q 'LOG .*no readable version'; then
    fail "TURMA_KILL_GRACE=$bad made a healthy claude read as broken (log: $got)"
  else
    pass "TURMA_KILL_GRACE=$bad is sanitised, not obeyed"
  fi
done

# 16l. The poller's interval reaches `sleep` — where 0 is not "no delay" but a
#      HOT LOOP (a full release check several times a second, rate-limiting the
#      host against api.github.com), and garbage fails the other way: `sleep abc`
#      exits and, under set -e, the poller stops auto-updating this host with no
#      sign it has. Both are sanitised, so neither reaches `sleep`.
for bad in 0 abc -5; do
  root="$(mktemp -d)"; prefix="$root/prefix"; bin="$prefix/bin"; mkdir -p "$bin"
  cp "$SCRIPT" "$bin/turma-agent-update"; chmod +x "$bin/turma-agent-update"
  echo "# old" >"$prefix/hub-agent.py"; echo "// old" >"$prefix/tunnel-agent.js"
  mkdir -p "$prefix/hooks"; echo "# old" >"$prefix/hooks/guard.py"
  echo "0.3.0" >"$prefix/VERSION"
  install_fake_restart "$bin"; install_fake_gh "$bin"
  d="$(new_gh_dir)"; add_unified_release "$d" "v0.3.0" "0.3.0" "v0.3.0"
  FAKE_GH_DIR="$d" HOME="$root/home" PATH="$bin:$PATH" TURMA_REPO="xerktech/turma" \
    TURMA_CLAUDE_AUTO_UPDATE=0 TURMA_UPDATE_INTERVAL="$bad" \
    "$bin/turma-agent-update" --loop >"$root/loop.log" 2>&1 &
  loop_pid=$!
  sleep 3
  runs="$(grep -c 'up to date' "$root/loop.log" 2>/dev/null || true)"
  alive=no; kill -0 "$loop_pid" 2>/dev/null && alive=yes
  kill "$loop_pid" 2>/dev/null || true; wait "$loop_pid" 2>/dev/null || true
  if [ "${runs:-0}" -le 2 ] && [ "$alive" = yes ]; then
    pass "TURMA_UPDATE_INTERVAL=$bad neither hot-loops nor kills the poller ($runs run(s) in 3s)"
  else
    fail "TURMA_UPDATE_INTERVAL=$bad gave $runs run(s) in 3s, poller alive=$alive"
  fi
  rm -rf "$root" "$d"
done

# --- The --boot rate limit (XERK-254) ----------------------------------------
# The launcher fires --boot on every start, and systemd's Restart=always makes a
# crash-looping manager start every 5s. Unthrottled that is a release+registry
# check — and possibly a download, swap and restart — every five seconds, so the
# limit is what makes "check on every restart" safe to promise.
run_boot_case() {  # <installed_version> <fake_gh_dir> <stamp_age_sec|none>
  local installed="$1" ghdir="$2" age="$3" root prefix bin
  root="$(mktemp -d)"; prefix="$root/prefix"; bin="$prefix/bin"; mkdir -p "$bin"
  cp "$SCRIPT" "$bin/turma-agent-update"; chmod +x "$bin/turma-agent-update"
  echo "# old" >"$prefix/hub-agent.py"; echo "// old" >"$prefix/tunnel-agent.js"
  mkdir -p "$prefix/hooks"; echo "# old" >"$prefix/hooks/guard.py"
  echo "$installed" >"$prefix/VERSION"
  install_fake_restart "$bin"; install_fake_gh "$bin"
  mkdir -p "$root/home/.turma"
  if [ "$age" != none ]; then
    echo $(( $(date +%s) - age )) > "$root/home/.turma/last-update-check"
  fi
  FAKE_GH_DIR="$ghdir" HOME="$root/home" PATH="$bin:$PATH" \
    TURMA_REPO="xerktech/turma" TURMA_CLAUDE_AUTO_UPDATE=0 \
    TURMA_BOOT_UPDATE_MIN_INTERVAL=300 \
    "$bin/turma-agent-update" --boot >/dev/null 2>&1 || true
  tr -d '[:space:]' < "$prefix/VERSION"
  rm -rf "$root"
}

# 17. A check seconds ago -> this boot's check is skipped, update or not.
d="$(new_gh_dir)"; add_unified_release "$d" "v0.4.0" "0.4.0" "v0.4.0"
got="$(run_boot_case "0.3.0" "$d" 30)"
assert_eq "0.3.0" "$got" "--boot skips when a check just ran (stayed $got)" \
  "--boot ignored the rate limit and updated to $got"
rm -rf "$d"

# 18. Past the interval -> the boot check runs and updates normally.
d="$(new_gh_dir)"; add_unified_release "$d" "v0.4.0" "0.4.0" "v0.4.0"
got="$(run_boot_case "0.3.0" "$d" 3600)"
assert_eq "0.4.0" "$got" "--boot runs once past the interval (-> $got)" \
  "--boot was throttled by a stale stamp, got $got"
rm -rf "$d"

# 19. No stamp at all (a first boot) -> runs.
d="$(new_gh_dir)"; add_unified_release "$d" "v0.4.0" "0.4.0" "v0.4.0"
got="$(run_boot_case "0.3.0" "$d" none)"
assert_eq "0.4.0" "$got" "--boot runs on a host that has never checked (-> $got)" \
  "first-boot check was skipped, got $got"
rm -rf "$d"

# 20. A stamp from the FUTURE (clock skew, a restored backup) is not a recent
#     check — it must not block updates until the clock catches up.
d="$(new_gh_dir)"; add_unified_release "$d" "v0.4.0" "0.4.0" "v0.4.0"
got="$(run_boot_case "0.3.0" "$d" -86400)"
assert_eq "0.4.0" "$got" "a future-dated stamp doesn't block the boot check (-> $got)" \
  "a future stamp wedged the boot check, got $got"
rm -rf "$d"

# 21. Every run leaves the stamp behind, which is what bounds the NEXT boot
#     check — including the plain timer run, so a restart right after one is
#     correctly a no-op.
d="$(new_gh_dir)"; add_unified_release "$d" "v0.3.0" "0.3.0" "v0.3.0"
root="$(mktemp -d)"; prefix="$root/prefix"; bin="$prefix/bin"; mkdir -p "$bin"
cp "$SCRIPT" "$bin/turma-agent-update"; chmod +x "$bin/turma-agent-update"
echo "# old" >"$prefix/hub-agent.py"; echo "// old" >"$prefix/tunnel-agent.js"
mkdir -p "$prefix/hooks"; echo "# old" >"$prefix/hooks/guard.py"
echo "0.3.0" >"$prefix/VERSION"
install_fake_restart "$bin"; install_fake_gh "$bin"
FAKE_GH_DIR="$d" HOME="$root/home" PATH="$bin:$PATH" TURMA_REPO="xerktech/turma" \
  TURMA_CLAUDE_AUTO_UPDATE=0 "$bin/turma-agent-update" >/dev/null 2>&1 || true
if [ -s "$root/home/.turma/last-update-check" ]; then
  pass "a plain run stamps the last-check time"
else
  fail "no last-update-check stamp after a run"
fi
rm -rf "$root" "$d"

# 22. A zero-padded / partially-written stamp must not wedge the check. bash
#     reads a leading-zero number as OCTAL, so `09` is an arithmetic ERROR that
#     (under set -e) took the whole boot check down on every restart until
#     somebody deleted the file.
d="$(new_gh_dir)"; add_unified_release "$d" "v0.4.0" "0.4.0" "v0.4.0"
root="$(mktemp -d)"; prefix="$root/prefix"; bin="$prefix/bin"; mkdir -p "$bin"
cp "$SCRIPT" "$bin/turma-agent-update"; chmod +x "$bin/turma-agent-update"
echo "# old" >"$prefix/hub-agent.py"; echo "// old" >"$prefix/tunnel-agent.js"
mkdir -p "$prefix/hooks"; echo "# old" >"$prefix/hooks/guard.py"
echo "0.3.0" >"$prefix/VERSION"
install_fake_restart "$bin"; install_fake_gh "$bin"
mkdir -p "$root/home/.turma"; echo "09" > "$root/home/.turma/last-update-check"
FAKE_GH_DIR="$d" HOME="$root/home" PATH="$bin:$PATH" TURMA_REPO="xerktech/turma" \
  TURMA_CLAUDE_AUTO_UPDATE=0 "$bin/turma-agent-update" --boot >/dev/null 2>&1 || true
got="$(tr -d '[:space:]' < "$prefix/VERSION")"
assert_eq "0.4.0" "$got" "an octal-looking stamp doesn't wedge the check (-> $got)" \
  "a stamp of 09 killed the boot check, VERSION stayed $got"
rm -rf "$root" "$d"

# 23. The --loop poller must NOT hold the update lock across its hour-long sleep.
#     It did, and since turma-agentctl starts that poller on every non-systemd
#     host, EVERY start-fired check on those hosts exited immediately as
#     "another update run holds the lock" — the whole feature, silently inert.
d="$(new_gh_dir)"; add_unified_release "$d" "v0.3.0" "0.3.0" "v0.3.0"
root="$(mktemp -d)"; prefix="$root/prefix"; bin="$prefix/bin"; mkdir -p "$bin"
cp "$SCRIPT" "$bin/turma-agent-update"; chmod +x "$bin/turma-agent-update"
echo "# old" >"$prefix/hub-agent.py"; echo "// old" >"$prefix/tunnel-agent.js"
mkdir -p "$prefix/hooks"; echo "# old" >"$prefix/hooks/guard.py"
echo "0.3.0" >"$prefix/VERSION"
install_fake_restart "$bin"; install_fake_gh "$bin"
FAKE_GH_DIR="$d" HOME="$root/home" PATH="$bin:$PATH" TURMA_REPO="xerktech/turma" \
  TURMA_CLAUDE_AUTO_UPDATE=0 "$bin/turma-agent-update" --loop --interval 60 \
  >"$root/loop.log" 2>&1 &
loop_pid=$!
for _ in $(seq 1 60); do grep -q "up to date" "$root/loop.log" 2>/dev/null && break; sleep 0.2; done
out="$(FAKE_GH_DIR="$d" HOME="$root/home" PATH="$bin:$PATH" TURMA_REPO="xerktech/turma" \
  TURMA_CLAUDE_AUTO_UPDATE=0 TURMA_BOOT_UPDATE_MIN_INTERVAL=0 \
  "$bin/turma-agent-update" --boot 2>&1 || true)"
kill "$loop_pid" 2>/dev/null || true; wait "$loop_pid" 2>/dev/null || true
if printf '%s' "$out" | grep -q "holds the lock"; then
  fail "a sleeping --loop poller blocked the start-fired check (that host never updates)"
else
  pass "the poller releases the lock between runs"
fi
rm -rf "$root" "$d"

# 24. The two start checks throttle INDEPENDENTLY. They are fired back to back by
#     the launcher, so one shared stamp would mean the first always suppressed
#     the second.
root="$(mktemp -d)"; prefix="$root/prefix"; bin="$prefix/bin"; mkdir -p "$bin"
cp "$SCRIPT" "$bin/turma-agent-update"; chmod +x "$bin/turma-agent-update"
echo "# old" >"$prefix/hub-agent.py"; echo "// old" >"$prefix/tunnel-agent.js"
mkdir -p "$prefix/hooks"; echo "# old" >"$prefix/hooks/guard.py"
echo "0.3.0" >"$prefix/VERSION"
install_fake_restart "$bin"; install_fake_gh "$bin"
install_fake_claude_toolchain "$bin" "2.0.1" "2.0.1" yes
d="$(new_gh_dir)"; add_unified_release "$d" "v0.4.0" "0.4.0" "v0.4.0"
env FAKE_GH_DIR="$d" HOME="$root/home" PATH="$bin:/usr/bin:/bin" TURMA_REPO="xerktech/turma" \
  CLAUDE_LOG="$root/claude.log" "$bin/turma-agent-update" --claude-only >/dev/null 2>&1 || true
FAKE_GH_DIR="$d" HOME="$root/home" PATH="$bin:$PATH" TURMA_REPO="xerktech/turma" \
  TURMA_CLAUDE_AUTO_UPDATE=0 "$bin/turma-agent-update" --boot >/dev/null 2>&1 || true
got="$(tr -d '[:space:]' < "$prefix/VERSION")"
assert_eq "0.4.0" "$got" "a claude check doesn't throttle the agent check (-> $got)" \
  "the claude check's stamp suppressed the agent check, VERSION stayed $got"
if [ -s "$root/home/.turma/last-claude-check" ]; then
  pass "the claude check keeps its own stamp"
else
  fail "no last-claude-check stamp after --claude-only"
fi
rm -rf "$root" "$d"

# 25. A payload without hooks/ is refused BEFORE anything is swapped. The swap
#     removes the installed hooks first, and a missing hook command is a
#     NON-BLOCKING hook — the safety guard would fail open while VERSION, the
#     restart and the log all reported a clean update.
d="$(new_gh_dir)"
echo "v0.4.0" >> "$d/tags"
cat > "$d/manifests/v0.4.0.json" <<EOF
{ "schema":1, "version":"0.4.0", "tag":"v0.4.0",
  "components": { "agent-native": {
      "version":"0.4.0", "kind":"asset",
      "asset":"turma-agent-native-v0.4.0.tar.gz",
      "sha256_asset":"turma-agent-native-v0.4.0.tar.gz.sha256",
      "release_tag":"v0.4.0", "built":true } } }
EOF
mkdir -p "$d/assets/v0.4.0"
cp "$d/manifests/v0.4.0.json" "$d/assets/v0.4.0/manifest.json"
make_tarball "0.4.0" "$d/assets/v0.4.0" nohooks >/dev/null
root="$(mktemp -d)"; prefix="$root/prefix"; bin="$prefix/bin"; mkdir -p "$bin"
cp "$SCRIPT" "$bin/turma-agent-update"; chmod +x "$bin/turma-agent-update"
echo "# old" >"$prefix/hub-agent.py"; echo "// old" >"$prefix/tunnel-agent.js"
mkdir -p "$prefix/hooks"; echo "# guard" >"$prefix/hooks/guard.py"
echo "0.3.0" >"$prefix/VERSION"
install_fake_restart "$bin"; install_fake_gh "$bin"
export TURMA_TEST_RESTART_LOG="$root/restart.log"; : > "$TURMA_TEST_RESTART_LOG"
FAKE_GH_DIR="$d" HOME="$root/home" PATH="$bin:$PATH" TURMA_REPO="xerktech/turma" \
  TURMA_CLAUDE_AUTO_UPDATE=0 "$bin/turma-agent-update" >/dev/null 2>&1 || true
got="$(tr -d '[:space:]' < "$prefix/VERSION")"
assert_eq "0.3.0" "$got" "a payload without hooks/ is refused (stayed $got)" \
  "installed a hook-less payload, VERSION now $got"
if [ -f "$prefix/hooks/guard.py" ]; then
  pass "the installed guard hook survives a refused payload"
else
  fail "the guard hook was deleted by a payload that didn't carry one — the guard fails OPEN"
fi
if [ -s "$TURMA_TEST_RESTART_LOG" ]; then
  fail "restarted the manager for an install that was refused"
else
  pass "no restart for a refused payload"
fi
unset TURMA_TEST_RESTART_LOG
rm -rf "$root" "$d"

if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$FAILED"
