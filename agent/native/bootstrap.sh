#!/usr/bin/env bash
# bootstrap.sh — one-command install of the latest native Turma agent.
#
# For a host that just wants the agent, not the source: fetches the newest
# native release tarball, checksum-verifies it, unpacks it to a temp dir, and
# hands off to the install.sh inside it. Every argument is passed straight
# through, so the curl|bash form supports the same options as a checkout:
#
#   curl -fsSL .../bootstrap.sh | bash
#   curl -fsSL .../bootstrap.sh | bash -s -- --autostart --prefix /opt/turma
#
# Once installed, turma-agent-update keeps the host current on its own; this
# script is only the way IN. It deliberately duplicates none of install.sh —
# prerequisites, config, and the service unit are all still that script's job.
#
# Anonymous by design: the repo is public, so there is no `gh` login or token
# here (unlike turma-agent-update, which must also work against a private repo
# post-install). Needs only curl + tar + sha256sum + sort -V, because it runs
# BEFORE install.sh has had a chance to apt-install anything — notably python3,
# which is why the release stream is read with grep/sed rather than a JSON
# parser.
set -euo pipefail

REPO="${TURMA_REPO:-xerktech/turma}"
API="https://api.github.com/repos/$REPO/releases?per_page=100"

die() { echo "[bootstrap] ERROR: $*" >&2; exit 1; }
info() { echo "[bootstrap] $*"; }

for tool in curl tar sha256sum sort; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done

# ---- resolve the newest native tarball ------------------------------------
# Picked by the version in the ASSET's own filename, not by release tag. A
# release is an umbrella that carries an unchanged component forward under its
# original older name (turma-agent-native-v0.3.0.tar.gz can sit on the v0.4.0
# release), so the highest tag does not always name the highest native build —
# but the highest filename version always IS the newest native build. Matching
# on asset names also means the legacy agent-native-v* stream is covered by the
# same line, with no tag-scheme branch to keep in sync with the release logic.
info "resolving the latest native agent from $REPO"
releases="$(curl -fsSL "$API")" || die "cannot reach the GitHub release API"

asset_url="$(
  printf '%s' "$releases" \
    | grep -o "https://[^\"]*/turma-agent-native-v[0-9][0-9.]*\.tar\.gz" \
    | sort -u \
    | sed 's#.*/turma-agent-native-v\([0-9.]*\)\.tar\.gz$#\1 &#' \
    | sort -V \
    | tail -n1 \
    | cut -d' ' -f2
)" || true
[ -n "$asset_url" ] || die "no native agent release found for $REPO"

asset="${asset_url##*/}"
info "found $asset"

# ---- download, verify, unpack ---------------------------------------------
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

curl -fsSL -o "$asset" "$asset_url" || die "download failed: $asset_url"
curl -fsSL -o "$asset.sha256" "$asset_url.sha256" \
  || die "no checksum published for $asset — refusing to install unverified bits"
sha256sum -c "$asset.sha256" >/dev/null 2>&1 \
  || die "checksum mismatch on $asset — refusing to install"
info "checksum OK"

tar xzf "$asset"
[ -f install.sh ] || die "$asset has no install.sh — malformed release asset"

# The tarball is flat: install.sh sits beside hub-agent.py, which is the layout
# its own source-probe expects. Hand off; it prints the next steps (config,
# claude login, service).
chmod +x install.sh
exec ./install.sh "$@"
