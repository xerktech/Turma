#!/bin/sh
set -e

# ONE container per physical host. It no longer bakes a single repo/session:
# the Python session manager (hub-agent.py) scans REPOS_ROOT and multiplexes N
# worktree-backed Claude sessions, each with its own tmux (agent-<id>) + ttyd
# (127.0.0.1:<port>, base /term/<id>), created/killed from the Turma UI.
# This entrypoint resolves the identity to run as, does the Claude creds
# preflight, starts the reverse tunnel, and then hands off to the manager as the
# long-lived foreground process. The container stays up with ZERO sessions (no
# more "session ends -> PID 1 exits -> container restarts" loop;
# restart/clear-context is now a per-session op the manager performs).

# Which coding agent this container runs. Selected by the AGENT env var (set
# per-stack in DockerOps). Defaults to claude, and claude is the ONLY agent
# installed or supported: it reuses the host's login via the /root/.claude bind
# mount and is the only agent the manager knows how to Remote-Control
# (hub-agent.py launches `claude` unconditionally — it never reads AGENT).
# The image used to also carry codex/copilot/opencode against a dispatch that
# was never built; they were dropped rather than keep shipping 959 MB of
# binaries nothing could reach. All this var still does is gate the claude
# credential preflight below, so a non-claude value skips that check and then
# gets a claude session anyway. Wire up real dispatch here (and re-add the
# install in agent/Dockerfile) if a second agent is ever supported.
AGENT="${AGENT:-claude}"

# --- Run-as identity (agent-agnostic) --------------------------------------
# Everything this container produces lands in bind-mounted HOST directories: the
# git root (worktree checkouts and every file a session edits) and the Claude
# login (~/.claude transcripts + settings). Running as root means all of it is
# written back root-owned, and the operator can't touch their own repo or
# settings without sudo. So run as the uid/gid that OWNS the git root — by
# definition the host user whose repos these are.
#
# Auto-detected from REPOS_ROOT's owner, so no per-host config is needed:
#   * root-owned git root (the TrueNAS stack)   -> 0:0, we stay root as before
#   * user-owned git root (WSL / a desktop)     -> that uid:gid, we drop to it
# PUID/PGID in the compose env override the detection if a host needs something
# else; PUID=0 forces the old always-root behaviour.
REPOS_ROOT="${REPOS_ROOT:-/mnt/data/Docker/git}"
export REPOS_ROOT
PUID="${PUID:-$(stat -c %u "$REPOS_ROOT" 2>/dev/null || echo 0)}"
PGID="${PGID:-$(stat -c %g "$REPOS_ROOT" 2>/dev/null || echo 0)}"

RUN_USER=root
DROP_PRIV=no

# Gate on PUID alone: uid 0 IS root whatever the gid says, so a PUID=0 host stays
# on the byte-for-byte original path and PGID is moot there.
if [ "$PUID" = "0" ]; then
  echo "[entrypoint] identity: root — nothing to drop (REPOS_ROOT is root-owned, or PUID=0 forces it)"
else
  DROP_PRIV=yes
  # Reuse whatever passwd/group entry already claims these ids and only create
  # one when the id is genuinely free — the node base image ships node:node at
  # 1000:1000, which is exactly where a WSL/desktop host user usually lands.
  RUN_GROUP="$(getent group "$PGID" | cut -d: -f1)"
  if [ -z "$RUN_GROUP" ]; then
    RUN_GROUP=agent
    groupadd -g "$PGID" "$RUN_GROUP"
  fi
  RUN_USER="$(getent passwd "$PUID" | cut -d: -f1)"
  if [ -z "$RUN_USER" ]; then
    RUN_USER=agent
    useradd -u "$PUID" -g "$PGID" -M -d /root -s /bin/sh "$RUN_USER"
  else
    usermod -g "$PGID" -d /root "$RUN_USER"
  fi

  # HOME stays /root: every bind mount targets /root/.claude, /root/.claude.json
  # and /root/.config/gh, and hub-agent.py resolves ~/.turma and
  # /root/.claude/projects off it. Moving HOME would mean re-plumbing all of that
  # plus the DockerOps compose, so instead give /root to the run-as user.
  # Deliberately NOT recursive: /root's children are the host's own bind mounts,
  # already correctly owned host-side, and recursing would rewrite the
  # operator's real ~/.claude wholesale.
  export HOME=/root
  export USER="$RUN_USER"
  export LOGNAME="$RUN_USER"
  chown "$PUID:$PGID" /root

  # The docker socket: `docker` CLI backs the container self-inspect behind the
  # device-name probe and log tail, plus the hub-initiated restart. Root got that
  # for free; a dropped user needs to be in the group that owns the socket.
  # NOTE: on a host where the socket is root:root this joins group 0 — broad, but
  # it is the only way to keep those features working once we're not root.
  DOCKER_SOCK=/var/run/docker.sock
  if [ -S "$DOCKER_SOCK" ]; then
    SOCK_GID="$(stat -c %g "$DOCKER_SOCK")"
    SOCK_GROUP="$(getent group "$SOCK_GID" | cut -d: -f1)"
    if [ -z "$SOCK_GROUP" ]; then
      SOCK_GROUP=dockersock
      groupadd -g "$SOCK_GID" "$SOCK_GROUP"
    fi
    usermod -aG "$SOCK_GROUP" "$RUN_USER"
    echo "[entrypoint] docker socket: joined ${SOCK_GROUP}(${SOCK_GID})"
  fi

  # Self-heal the legacy root-owned files. Everything written before this image
  # learned to drop privileges is still root-owned on the host — which is the
  # very breakage this exists to end, and it does NOT fix itself, because the
  # operator can no longer chown what they no longer own. Reclaim it here, once:
  # after the first boot this is a scan that finds nothing. -h so a symlink is
  # retargeted rather than followed out of the tree.
  echo "[entrypoint] identity: ${RUN_USER}(${PUID}:${PGID}) — reclaiming root-owned leftovers..."
  for p in "$REPOS_ROOT" /root/.claude /root/.claude.json /root/.turma \
           /root/.aws /root/.azure /root/.terraform.d \
           /root/.kube /root/.talos /root/.config/omni; do
    [ -e "$p" ] || continue
    find "$p" -uid 0 -exec chown -h "$PUID:$PGID" {} + 2>/dev/null || true
  done
  echo "[entrypoint] identity: ${RUN_USER}(${PUID}:${PGID}) ready"
fi

# Run a command as the resolved identity. A plain pass-through when we stayed
# root, so the TrueNAS stack executes byte-for-byte the same commands as before.
run_as() {
  if [ "$DROP_PRIV" = "no" ]; then
    "$@"
  else
    setpriv --reuid "$PUID" --regid "$PGID" --init-groups "$@"
  fi
}

# exec form of run_as — replaces this shell, for the final long-lived process.
exec_as() {
  if [ "$DROP_PRIV" = "no" ]; then
    exec "$@"
  else
    exec setpriv --reuid "$PUID" --regid "$PGID" --init-groups "$@"
  fi
}

# --- Claude-only preflight -------------------------------------------------
# Reuse the host's subscription login. Remote Control requires a subscription
# OAuth login (a setup-token is inference-only and can't host RC). Per-worktree
# bridge-pointer cleanup is NOT done here anymore — the manager drops each
# worktree's stale bridge pointer right before it (re)launches that session's
# claude, so a fresh session never reattaches to a dead RC bridge.
if [ "$AGENT" = "claude" ] || [ "$AGENT" = "claude-code" ]; then
  CREDS="/root/.claude/.credentials.json"
  if [ ! -f "$CREDS" ]; then
    echo "=================================================================="
    echo " No Claude subscription credentials at $CREDS"
    echo
    echo " This container reuses the host's login via the bind mount"
    echo "   /root/.claude:/root/.claude"
    echo " Make sure you're logged in on the host ('claude /login'), then"
    echo " restart this container. Remote Control requires a subscription"
    echo " OAuth login (a setup-token is inference-only and can't host RC)."
    echo
    echo " Idling until credentials exist..."
    echo "=================================================================="
    exec sleep infinity
  fi
fi

# --- Claude Code update on every start (XERK-254) --------------------------
# The native launcher fires its updater on every start; this is the container's
# half of the same rule, and it covers ONE of the two things that updater does.
#
# The agent itself cannot self-update here: it IS the image, so its update is an
# image pull (Watchtower, per DockerOps) followed by a recreate — which is what
# brings us through this code again. Claude Code, though, is baked in at build
# time (CLAUDE_CODE_VERSION in agent/Dockerfile) and then frozen for the life of
# the tag, so a host that only ever pulls a carried-forward agent image runs a
# Claude Code that keeps aging. This closes that half.
#
# As root, because `npm install -g` writes /usr/local, which the dropped
# identity cannot. The result is world-readable, so the sessions — which run as
# that dropped identity — execute it fine.
#
# AWAITED, and deliberately not backgrounded: `npm install -g` leaves `claude`
# absent from PATH for ~1.7s while it replaces the package, and resume_on_boot
# relaunches this host's sessions on a 1s stagger seconds after the manager
# starts — so a backgrounded check puts the hole exactly under the first
# relaunches, which then die on exec with ENOENT. Finishing before the manager
# exists means nothing can be launching while the package moves. Each call is
# bounded by `timeout` instead, so a wedged registry delays the boot but cannot
# stop it; it is two version reads unless something newer is really published.
#
# Being awaited puts it in `set -e`'s path at PID 1, so NOTHING in here may be
# allowed to abort the boot: the whole block is `||`-guarded, and its scratch
# HOME is an mktemp dir rather than a fixed path. A fixed /tmp path was a denial
# of service — any session, running as the dropped identity, could `touch
# /tmp/.turma-claude-update`, and the next `mkdir -p` failure then killed PID 1
# with a one-line error and no self-heal, on every restart, forever.
#
# TURMA_CLAUDE_AUTO_UPDATE=0 pins the image's bundled version.
# A SUBSHELL body — `() ( … )`, not `() { … }`. A /bin/sh function is not a
# subshell and has no `local`, so the throwaway HOME below would escape into
# everything the entrypoint starts afterwards: the manager (whose ~/.turma
# registry, usage ledger and archive state would land in a /tmp dir this
# function then deletes), the tunnel, and every session. That is precisely the
# `export HOME=/root` invariant the identity block above exists to hold. The
# `||` guard that keeps this off `set -e`'s path lives at the CALL site, so
# making the body a subshell costs nothing.
#
# Its two state files live in /root/.turma, which the DROPPED IDENTITY can write
# — it is the manager's own REGISTRY_DIR. So a session can replace either with a
# FIFO, and opening a FIFO for reading or writing BLOCKS until the other end
# appears: `2>/dev/null || true` cannot help, because there is no error, only a
# block. That is the PID-1 wedge again through a different door — a `running`
# container with no manager, no tunnel and no restart. Hence these two helpers:
# nothing here ever opens a path that isn't a regular file, and the write goes
# through a fresh temp file and a rename, so there is no check-then-open window
# to race either.
turma_read_file() {  # <path> — prints nothing for anything that isn't a plain file
  [ -f "$1" ] || return 0
  cat "$1" 2>/dev/null || true
}

# A plausible whole number of seconds, or the given default. Env values reach
# arithmetic here: a non-numeric one would abort the shell, and an ALL-DIGIT but
# oversized one silently overflows `$(( ))` to a NEGATIVE result — which would
# put the derived floor below the sum it exists to exceed. A day is far past any
# sane timeout, so anything beyond it is a typo, not an intention.
_num() {  # <value> <default>
  case "$1" in
    ''|*[!0-9]*) printf '%s' "$2"; return ;;
  esac
  # Leading zeros stripped first: they are not octal here, but they DO make a
  # sane value fail the length test below. All-zero then reads as empty, which
  # is the point of the next line.
  _v="${1#"${1%%[!0]*}"}"
  # ZERO IS NOT "no limit" here, however much it looks like it: `timeout 0 cmd`
  # disables the timeout, so a 0 would leave that call unbounded AND subtract
  # its whole share from the derived floor — the two halves of the orphan this
  # arithmetic exists to prevent. It reads as "use the default" instead.
  [ -n "$_v" ] || { printf '%s' "$2"; return; }
  if [ "${#_v}" -le 6 ] && [ "$_v" -le 86400 ]; then printf '%s' "$_v"; else printf '%s' "$2"; fi
}

turma_write_file() {  # <path> <content>
  _dir="$(dirname "$1")"
  [ -d "$_dir" ] || return 0
  _tmp="$(mktemp "$_dir/.turma-tmp.XXXXXX" 2>/dev/null)" || return 0
  printf '%s\n' "$2" >"$_tmp" 2>/dev/null \
    && mv -f "$_tmp" "$1" 2>/dev/null && return 0
  rm -f "$_tmp" 2>/dev/null || true
}

claude_update_check() (
  # `timeout` WITHOUT -k only signals at the deadline and then waits for the
  # child to leave: measured at 30s for a `trap "" TERM` child given `timeout 2`.
  # Every bound below would then be nominal, and the watchdog floor at the call
  # site is arithmetic over those numbers — so they have to be enforceable. -k
  # escalates to SIGKILL after a grace period. (A process in uninterruptible
  # sleep on stalled storage takes neither signal; nothing in userspace can
  # bound that, which is why the watchdog's message is worded the way it is.)
  _grace="$(_num "${TURMA_KILL_GRACE:-10}" 10)"

  # Rate-limited like the native launcher's, and for the same reason: a
  # container in a restart loop would otherwise hit the registry every few
  # seconds, and pay the check's latency on every pass.
  stamp=/root/.turma/last-claude-check
  now="$(date +%s)"
  # Read through the guard above — which also fixes a first boot printing
  # "cannot open /root/.turma/last-claude-check" as its very first log line
  # (dash reports the failed redirect itself; a `2>/dev/null` on the pipeline
  # belongs to `tr`, not to the shell's open).
  last="$(turma_read_file "$stamp" | tr -cd '0-9')"
  # Strip leading zeros before the arithmetic: this is /bin/sh, where a
  # zero-padded number is OCTAL and `09` is an error — and bash's `10#` prefix
  # is undefined here. An implausibly long value is treated as no stamp rather
  # than risking an overflow whose result is unspecified.
  last="$(printf '%s' "$last" | sed 's/^0*//')"
  [ "${#last}" -le 12 ] || last=""
  if [ -n "$last" ]; then
    age=$((now - last))
    if [ "$age" -ge 0 ] && [ "$age" -lt "${TURMA_BOOT_UPDATE_MIN_INTERVAL:-300}" ]; then
      echo "[entrypoint] claude check skipped: last check ${age}s ago"
      exit 0
    fi
  fi

  # Run against a throwaway HOME. /root is the operator's bind mount: npm would
  # leave a cache of tarballs nothing reads later (the Dockerfile deletes them
  # for the same reason), and anything `claude` touches on the way to printing
  # its version would land there ROOT-owned on a host whose sessions run as
  # somebody else — re-creating, one file at a time, the breakage the identity
  # block exists to end.
  scratch="$(mktemp -d /tmp/turma-claude-update.XXXXXX)" || exit 1
  mkdir -p /root/.turma 2>/dev/null || true
  turma_write_file "$stamp" "$now"
  HOME="$scratch"; export HOME
  npm_config_cache="$scratch/npm"; export npm_config_cache

  # Both the parsed version and what claude actually PRINTED: an unparseable
  # version is not the same fault as a missing one, and telling them apart is
  # what stops a futile reinstall on every boot (see the marker below).
  raw=""
  command -v claude >/dev/null 2>&1 && raw="$(timeout -k "$_grace" "$(_num "${TURMA_CLAUDE_PROBE_TIMEOUT:-30}" 30)" claude --version 2>/dev/null | head -n1 | tr -s '[:space:]' ' ')"
  cur="$(printf '%s' "$raw" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
  unparseable=/root/.turma/claude-unparseable
  latest="$(timeout -k "$_grace" "$(_num "${TURMA_NPM_VIEW_TIMEOUT:-45}" 45)" npm view @anthropic-ai/claude-code version \
            --fetch-retries=1 --fetch-timeout=20000 2>/dev/null | tr -d '[:space:]')"
  # A registry that answers with anything but a version is "stay put", not an
  # upgrade: `sort -V` ranks a non-numeric string ABOVE a semver, so a proxy
  # error line or a warning on stdout would otherwise replace the package on
  # every single boot.
  echo "$latest" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' || latest=""
  if [ -z "$latest" ]; then
    echo "[entrypoint] claude: registry unreachable or unreadable; staying at ${cur:-unknown}"
  elif [ -n "$cur" ] && [ "$cur" = "$latest" ]; then
    echo "[entrypoint] claude up to date ($cur)"
  elif [ -n "$cur" ] \
       && [ "$(printf '%s\n%s\n' "$cur" "$latest" | sort -V | tail -n1)" = "$cur" ]; then
    # Installed is NEWER than the registry's latest — a version pinned by hand
    # or an unpublished build. Never downgrade it.
    echo "[entrypoint] claude: installed $cur is ahead of published $latest; leaving it"
  elif [ -z "$cur" ] && [ -n "$raw" ] && [ "$raw" = "$(turma_read_file "$unparseable" | head -n1)" ]; then
    # Present, running, and printing a version shape this can't parse — a future
    # two-component or calver string, say. Reinstalling fixed nothing last time,
    # so don't do it again until what claude prints CHANGES. Without this memory
    # it is a real install on every boot, forever, inside the awaited path.
    echo "[entrypoint] claude: unrecognised version ($raw); a repair already failed to change that"
  else
    # An unreadable version reaches here too (claude present, $cur empty): most
    # often a half-written install, which reinstalling repairs. Verified below
    # rather than assumed, and remembered when it doesn't help.
    echo "[entrypoint] claude update: ${cur:-none-or-unreadable} -> $latest"
    if timeout -k "$_grace" "$(_num "${TURMA_NPM_INSTALL_TIMEOUT:-300}" 300)" \
         npm install -g "@anthropic-ai/claude-code@$latest"; then
      # BOUNDED, like the probe above. This is a child of PID 1 with no outer
      # timeout anywhere: an unbounded read that never returns leaves the
      # container `running` with no manager, no tunnel and no sessions, and
      # since PID 1 is alive and healthy-looking, no restart policy ever fires.
      # A hang here is reachable from exactly the fault this branch repairs.
      now_raw="$(timeout -k "$_grace" "$(_num "${TURMA_CLAUDE_PROBE_TIMEOUT:-30}" 30)" claude --version 2>/dev/null | head -n1 | tr -s '[:space:]' ' ')"
      echo "[entrypoint] claude: now ${now_raw:-?}"
      if printf '%s' "$now_raw" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+'; then
        rm -f "$unparseable" 2>/dev/null || true
      else
        turma_write_file "$unparseable" "$now_raw"
      fi
    else
      echo "[entrypoint] claude: update FAILED; staying at ${cur:-none}"
    fi
  fi
  rm -rf "$scratch"
)

if [ "${TURMA_CLAUDE_AUTO_UPDATE:-1}" != "0" ] \
   && { [ "$AGENT" = "claude" ] || [ "$AGENT" = "claude-code" ]; } \
   && command -v npm >/dev/null 2>&1; then
  # `|| echo` so nothing inside can abort the boot: this runs at PID 1 under
  # `set -e`, and an agent that will not start is far worse than a stale claude.
  #
  # Bounded as a WHOLE, and not only call by call. Every call inside is
  # individually bounded today, but this block runs as a child of PID 1 with
  # nothing above it — so one future unbounded call, or one blocking open nobody
  # predicted, is a container that stays `running` forever with no manager and
  # no restart. The watchdog is the structural guarantee; the per-call bounds
  # and the regular-file guards are what stop it ever firing.
  #
  # Its deadline is a FIXED, deliberately generous number — not arithmetic over
  # the per-call bounds. It only ever needed to sit above the legitimate worst
  # case; every attempt to make it TIGHT coupled it to the exact set of calls
  # below and produced a run of defects (a floor that overflowed on a large
  # value, multipliers that miscounted the calls, a count taken as the wrong
  # uid, clock arithmetic inside the budget that fed it). What must remain true
  # is only that it cannot fire while an install is running — a `kill` reaches
  # this shell and NOT its npm grandchild, and npm would then keep replacing the
  # package while the manager starts launching sessions into it. So the single
  # coupling kept is to the one bound that dominates: 2.5x the install budget —
  # two for the install's own clock-skewed worst case and a half for the bounded
  # work that runs before it — so the deadline cannot land inside an install
  # however that knob is set. Interrupting a version read or a registry query
  # orphans nothing, so nothing else needs covering.
  _deadline="$(_num "${TURMA_CLAUDE_UPDATE_TIMEOUT:-1800}" 1800)"
  _min=$(( $(_num "${TURMA_NPM_INSTALL_TIMEOUT:-300}" 300) * 5 / 2 ))
  if [ "$_deadline" -lt "$_min" ]; then
    echo "[entrypoint] claude: TURMA_CLAUDE_UPDATE_TIMEOUT=${_deadline}s could fire while an" \
      "install is running; using ${_min}s"
    _deadline="$_min"
  fi
  echo "[entrypoint] claude check bounded at ${_deadline}s"
  claude_update_check &
  _check_pid=$!
  ( sleep "$_deadline"; kill -TERM "$_check_pid" 2>/dev/null ) &
  _watchdog_pid=$!
  wait "$_check_pid" \
    || echo "[entrypoint] claude: update check did not finish in ${_deadline}s; carrying on." \
            "If it was mid-install, that install can still be replacing claude —" \
            "a session started in the next few minutes may fail to launch."
  kill -TERM "$_watchdog_pid" 2>/dev/null || true
fi

# --- GitHub auth preflight (agent-agnostic) --------------------------------
# git authenticates through the image's system credential helper
# (`gh auth git-credential`, set in /etc/gitconfig), so private clone/fetch/push
# and `gh pr create` all need a usable gh login in the mounted /root/.config/gh.
# This is a Linux container with NO OS keyring, so the token must be present as
# PLAINTEXT there (hosts.yml: oauth_token):
#   * Linux hosts store it that way already, so mounting the host's ~/.config/gh
#     works out of the box.
#   * Windows hosts keep it in Credential Manager, which this container can't
#     read; the mounted dir must be seeded FROM WITHIN THIS CONTAINER (never a
#     host script) — see the seed command printed below.
# Probed as the run-as identity, not root, so what it reports is what the
# sessions will actually get.
# Non-fatal: we log the state (and the fix) but still start the manager, so
# sessions that don't touch private git keep working.
if command -v gh >/dev/null 2>&1; then
  if run_as gh auth status >/dev/null 2>&1; then
    echo "[entrypoint] gh: authenticated as $(run_as gh api user -q .login 2>/dev/null || echo '?')"
  else
    echo "[entrypoint] gh: NOT authenticated — private git ops and 'gh pr create' will fail."
    echo "[entrypoint]   Seed/refresh the token from WITHIN this container (the host keyring"
    echo "[entrypoint]   is not readable here); it persists to the mounted /root/.config/gh:"
    echo "[entrypoint]     docker exec -it $(hostname) gh auth login --hostname github.com"
  fi
fi

# --- Non-GitHub git creds preflight (agent-agnostic) -----------------------
# github.com authenticates through gh (above); every OTHER git host (GitLab,
# Bitbucket, Azure DevOps, self-hosted) authenticates through the `store` helper
# wired in the Dockerfile, which reads the host's own cached git credentials from
# an OPTIONAL bind mount at /root/.git-credentials. For an org that doesn't use
# GitHub this is how private clone/fetch/push works at all.
# Non-fatal and presence-only, exactly like the cloud creds below: a host that
# mounts none is supported (it just has no non-GitHub git auth). The file is a
# sound marker on its own — nothing in this image creates it by merely running
# (unlike ~/.azure), so its existence means the host really seeded it.
if [ -s /root/.git-credentials ]; then
  echo "[entrypoint] git: non-GitHub creds mounted at /root/.git-credentials"
else
  echo "[entrypoint] git: no cached non-GitHub creds (/root/.git-credentials) — github.com still works via gh"
fi

# --- Azure DevOps git auth (XERK-54) ---------------------------------------
# When the board is pointed at an Azure DevOps org (AZDO_URL + AZDO_TOKEN), the
# agent already holds a PAT — so reuse it for plain git instead of mounting the
# host's creds. hub-agent.py wires a URL-scoped http.extraHeader (--system, hence
# run as root here, BEFORE the privilege drop) so clone/fetch/push against the
# ADO host authenticate with no mount and no credential helper — the counterpart
# of github.com going through gh. extraHeader (not proactiveAuth) because the
# image's git predates proactiveAuth; see azure_git_auth_config(). Non-fatal and
# secret-safe: it logs the host, never the token.
if [ -n "${AZDO_URL:-}" ] && [ -n "${AZDO_TOKEN:-}" ]; then
  python3 /usr/local/bin/hub-agent.py --wire-azure-git || true
  # The same PAT is what `az repos pr create` authenticates with (XERK-226) —
  # the azure-devops CLI extension reads it from AZURE_DEVOPS_EXT_PAT, which is
  # what lets a session OPEN the pull request its chip then tracks. Exported
  # (not passed on a command line) so it never shows up in `ps`; the extension
  # resolves the org/project from the clone's own git remote, so nothing else
  # needs configuring. An operator-set value wins.
  if [ -z "${AZURE_DEVOPS_EXT_PAT:-}" ]; then
    AZURE_DEVOPS_EXT_PAT="$AZDO_TOKEN"
    export AZURE_DEVOPS_EXT_PAT
  fi
fi

# --- Cloud CLI creds preflight (agent-agnostic) ----------------------------
# terraform, az and aws are installed in every image, but their credentials are
# the HOST's, reused through bind mounts exactly like claude (/root/.claude) and
# gh (/root/.config/gh):
#   /root/.aws          aws  — config + credentials
#   /root/.azure        az   — azureProfile.json + the MSAL token cache
#   /root/.terraform.d  terraform — credentials.tfrc.json (Terraform Cloud)
# A host with none of them mounted is a SUPPORTED configuration, not an error:
# the CLIs stay on PATH and unauthenticated, which is all a host that never
# touches a cloud needs. So this block only ever logs — it is not fatal, it
# creates nothing, and it must never idle the container the way the claude
# preflight above does, because a missing ~/.azure says nothing about whether
# this host can run sessions.
#
# Deliberately a presence check rather than `aws sts get-caller-identity` /
# `az account show`: those are slow (the aws one is a network round trip with
# its own retry budget) and would tax boot on every host — most of them — to
# report what the mount's absence already says. A stale/expired token is the
# CLI's problem to report at the point of use, in the session, where the agent
# can actually see the error and re-login.
env_creds_set() {
  for v in "$@"; do
    eval "val=\${$v:-}"
    [ -n "$val" ] && return 0
  done
  return 1
}

# cloud_creds <label> <cli> <store> <marker>... — report where (if anywhere)
# this CLI's credentials come from. Silent for a CLI that isn't installed, so an
# image that drops one doesn't log about it.
#
# Keyed on a marker FILE that only a real login leaves behind, never on the store
# directory existing: each CLI creates its OWN store the first time it runs at
# all. `az version` alone writes a whole /root/.azure — including an empty
# azureProfile.json, which is why even that isn't a marker — and `terraform
# version` writes /root/.terraform.d. So on any host where a session has ever run
# one of these, a directory check reports creds that aren't there.
cloud_creds() {
  label="$1"; cli="$2"; store="$3"; shift 3
  command -v "$cli" >/dev/null 2>&1 || return 0
  for marker in "$@"; do
    if [ -e "$marker" ]; then
      echo "[entrypoint] ${label}: host creds mounted at ${store}"
      return 0
    fi
  done
  echo "[entrypoint] ${label}: installed; no creds on this device (${store}) — ignoring"
}

# aws also authenticates straight from AWS_* env creds with no ~/.aws at all, so
# a host set up that way must not be reported as credential-less. az has no
# equivalent (its env vars only feed `az login --service-principal`, an explicit
# command) and terraform's Terraform Cloud token can also arrive as a
# TF_TOKEN_<host> var whose name is per-host and so not probed here. Provider
# creds (AWS_*, ARM_*) are the provider's business, not ours.
if command -v aws >/dev/null 2>&1 \
   && env_creds_set AWS_ACCESS_KEY_ID AWS_PROFILE AWS_ROLE_ARN; then
  echo "[entrypoint] aws: credentials from the environment"
else
  cloud_creds "aws" aws /root/.aws /root/.aws/credentials /root/.aws/config
fi
cloud_creds "az" az /root/.azure \
  /root/.azure/msal_token_cache.json /root/.azure/service_principal_entries.json
cloud_creds "terraform" terraform /root/.terraform.d \
  /root/.terraform.d/credentials.tfrc.json

# --- In-cluster kubeconfig (agent-agnostic) --------------------------------
# When this container IS a pod — XERK-369's cluster-side agent — kubectl and
# helm authenticate as the pod's own ServiceAccount, and NO kubeconfig is
# mounted. That is the whole credential story there: the token is projected by
# the kubelet, it rotates on its own, and it is revoked by deleting one
# ClusterRoleBinding. Nothing is copied into a vault and nothing expires quietly
# the way the cluster's static `admin` client certificate does.
#
# `tokenFile:` rather than an inline `token:` is what makes the rotation work.
# A projected token is re-written in place roughly hourly; a kubeconfig that
# baked the value at boot would authenticate until that copy expired and then
# start failing, in a pod that had been up for days and looked healthy.
#
# Written ONLY when there is nothing else to use — a mounted /root/.kube/config
# or an explicit KUBECONFIG wins, so a host that mounts a real kubeconfig (or a
# pod that is later given one) is unaffected. Outside a cluster the whole block
# is skipped: there is no ServiceAccount token to read.
KUBE_SA_DIR=/var/run/secrets/kubernetes.io/serviceaccount
KUBE_FROM_SA=no
if [ -z "${KUBECONFIG:-}" ] && [ ! -e /root/.kube/config ] \
   && [ -n "${KUBERNETES_SERVICE_HOST:-}" ] && [ -r "${KUBE_SA_DIR}/token" ]; then
  # An IPv6 apiserver address has to be bracketed in the URL. This cluster is
  # v4-only, so the branch is untested there and costs two lines to be right.
  case "${KUBERNETES_SERVICE_HOST}" in
    *:*) KUBE_API_HOST="[${KUBERNETES_SERVICE_HOST}]" ;;
    *)   KUBE_API_HOST="${KUBERNETES_SERVICE_HOST}" ;;
  esac
  KUBE_NS="$(cat "${KUBE_SA_DIR}/namespace" 2>/dev/null || echo default)"
  mkdir -p /root/.kube
  umask 077
  cat > /root/.kube/config <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: in-cluster
    cluster:
      server: https://${KUBE_API_HOST}:${KUBERNETES_SERVICE_PORT:-443}
      certificate-authority: ${KUBE_SA_DIR}/ca.crt
users:
  - name: in-cluster
    user:
      tokenFile: ${KUBE_SA_DIR}/token
contexts:
  - name: in-cluster
    context:
      cluster: in-cluster
      user: in-cluster
      namespace: ${KUBE_NS}
current-context: in-cluster
EOF
  umask 022
  if [ "$DROP_PRIV" = "yes" ]; then
    chown -R "$PUID:$PGID" /root/.kube
  fi
  KUBE_FROM_SA=yes
  echo "[entrypoint] kubectl: in-cluster ServiceAccount credential (ns ${KUBE_NS})"
fi

# --- Cluster CLI creds preflight (agent-agnostic) --------------------------
# kubectl, helm, talosctl and omnictl, on the same terms as the cloud CLIs
# above: installed in every image, credentials supplied by the host (or, for
# kubectl, by the block above), never fatal, log-only.
#
#   /root/.kube/config          kubectl, helm
#   /root/.talos/config         talosctl
#   /root/.config/omni/config   omnictl
#
# Same caveat as ~/.azure, and it bites hardest on talosctl: `talosctl config`
# writes ~/.talos/config the first time it is run at all, so the file can exist
# holding `context: ""` and no contexts — which is exactly what the truenas host
# has. A presence check says a store is there, never that a usable context is.
# The CLI reports the real answer at the point of use, in the session, where an
# agent can act on it.
if [ "$KUBE_FROM_SA" = "no" ]; then
  cloud_creds "kubectl" kubectl /root/.kube /root/.kube/config
fi
cloud_creds "talosctl" talosctl /root/.talos /root/.talos/config
cloud_creds "omnictl" omnictl /root/.config/omni /root/.config/omni/config

# --- Host identity (agent-agnostic) ----------------------------------------
# The hub keys each agent by its physical host name (device). A container can't
# see that on its own, so hub-agent.py --print-device auto-detects it (host
# mount -> docker socket -> SMB to the Windows host on Docker Desktop / WSL2).
# Resolve it ONCE here and export, so the reverse tunnel and the session manager
# both register under the same identity (no per-process re-resolution, and the
# SMB probe runs at most once). An explicit DEVICE_NAME from the compose still
# wins. The sed pulls the DEVICE_NAME= line out of the manager's boot logs.
if [ -z "${DEVICE_NAME:-}" ]; then
  DEVICE_NAME="$(run_as python3 /usr/local/bin/hub-agent.py --print-device 2>/dev/null | sed -n 's/^DEVICE_NAME=//p' | tail -n1)"
  export DEVICE_NAME
  echo "[entrypoint] resolved device name: ${DEVICE_NAME:-<unresolved>}"
fi

# --- Hub infrastructure (agent-agnostic) -----------------------------------
# Background reverse tunnel to the hub for the web terminals. Keeps a persistent
# OUTBOUND WebSocket to TURMA_URL so the hub can reach this container's per-session
# ttyds from any network/host. The hub tells it which port to bridge per data
# channel (see agent/tunnel-agent.js + turma/server.js).
#
# SUPERVISED, like the native launcher's --tunnel-supervisor and for the tail
# end of the same reason (XERK-34): the tunnel dying while the manager lives is
# the one failure that reads as a perfectly healthy host — the heartbeat (a
# separate HTTP POST) keeps the card green while every session on it says
# "terminal offline". Fire-and-forget made a tunnel PROCESS death (an uncaught
# exception — socket-level failures self-heal via its own reconnect loop) stick
# until someone restarted the whole container. No node check inside the loop,
# unlike the native supervisor's: node is a baked image layer here, not an apt
# prerequisite that can be missing.
TUNNEL_RETRY_SEC="${TUNNEL_RETRY_SEC:-10}"
(
  while :; do
    run_as node /usr/local/bin/tunnel-agent.js || true
    echo "[entrypoint] tunnel-agent exited; restarting in ${TUNNEL_RETRY_SEC}s"
    sleep "$TUNNEL_RETRY_SEC"
  done
) &

# Session manager + heartbeat, in the FOREGROUND as the container's long-lived
# process. It owns the persisted registry (~/.turma/sessions.json), scans
# REPOS_ROOT for repos, auto-resumes running sessions, executes hub commands
# (spawn/kill/start/restart/delete), and heartbeats repos[]+sessions[] to the
# hub. exec so it becomes the main process (clean signal handling / restarts).
echo "Starting Turma session manager (REPOS_ROOT=${REPOS_ROOT})..."
exec_as python3 /usr/local/bin/hub-agent.py
