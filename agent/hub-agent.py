#!/usr/bin/env python3
"""Session manager + heartbeat agent for the agent-hub dashboard.

ONE of these runs per physical host (started by entrypoint.sh, in the
FOREGROUND — it is the container's long-lived process). It replaces the old
"one container = one repo = one Claude session" model with a host-level
multiplexer:

  - Scans REPOS_ROOT (default /mnt/data/Docker/git) one level deep for git
    repos and reports them to the hub.
  - Owns a persisted session registry (~/.agenthub/sessions.json). Each session
    is a git *worktree* of a repo in DETACHED HEAD (the app creates no branch;
    the running agent branches its own work when ready) forked off the latest
    default branch, running its own `claude --remote-control` inside its own tmux
    (agent-<id>) served by its own ttyd (127.0.0.1:<ttydPort>, base /term/<id>).
  - Executes hub-issued commands (spawn / kill / start / restart / delete /
    resume) that ride back on the heartbeat reply, with at-least-once cmdId
    de-dup.
  - Auto-resumes `running` sessions on boot — WITH their conversation
    (claude --resume against the worktree's newest transcript).
  - Remembers killed sessions (~/.agenthub/closed.json, newest 5 per repo) so
    the hub can offer a per-repo "Resume" picker. Killing a session stops its
    processes but KEEPS its worktree on disk (uncommitted work survives), so a
    resume re-attaches to the same worktree with its prior conversation.
  - POSTs a heartbeat to the hub every INTERVAL seconds carrying repos[] +
    sessions[] (per-session git / token-usage / live-session signals computed
    per worktree, so usage PERSISTS in history after a session is killed — the
    transcript under ~/.claude/projects outlives both the worktree files and
    the registry record).

Token usage is parsed from the transcript JSONLs under
/root/.claude/projects/<slug>/ (slug = worktree path via _project_slug); this is the
same data ccusage reads. Live-session signals are bridge-pointer presence,
transcript freshness, the newest entry's role/tool-use, any pending
AskUserQuestion, and PR URLs newly appended to the transcript.

stdlib only — no pip installs in the image.
"""

import json
import os
import re
import secrets
import shlex
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.request
from collections import deque

# Set by a SIGUSR1 handler (installed in run_forever). tunnel-agent.js sends
# SIGUSR1 when the hub pokes it over the control channel because a command was
# just queued, so the heartbeat loop cuts its interval sleep short and delivers
# that command in the next beat's reply instead of up to a whole INTERVAL
# later. A threading.Event lets the loop wait interruptibly (plain time.sleep
# wouldn't wake on the signal).
_poke = threading.Event()

HUB_URL = os.environ.get("HUB_URL", "http://agent-hub:8300")
# Bearer token for the hub's /api/heartbeat (the UI itself sits behind basic
# auth; this lets agents report without those user credentials). Must match
# the hub's HUB_AGENT_TOKEN.
HUB_TOKEN = os.environ.get("HUB_TOKEN", "")
INTERVAL = int(os.environ.get("HUB_INTERVAL", "20"))

# Host-multiplexer configuration (see CONTRACT / entrypoint.sh comments).
REPOS_ROOT = os.environ.get("REPOS_ROOT", "/mnt/data/Docker/git")
MAX_SESSIONS = int(os.environ.get("MAX_SESSIONS", "6"))
TTYD_PORT_BASE = int(os.environ.get("TTYD_PORT_BASE", "7700"))

# Reserved pseudo-repo name for a session that runs directly at REPOS_ROOT
# (spanning every repo) instead of inside one repo's worktree. It is NOT a git
# worktree: no branch, no base/branch-name option, no worktree add/remove —
# claude just runs in REPOS_ROOT. Because all root sessions share that cwd (and
# thus one claude project slug + Remote Control bridge pointer), at most one may
# run at a time. Parens keep it clear of any real (dir-name) repo in the scan.
ROOT_REPO_NAME = "(root)"

# Where worktrees live: under a dot-dir so the repo scan never lists them, and
# on the mounted tree so they survive a container restart.
WORKTREES_ROOT = os.path.join(REPOS_ROOT, ".agenthub", "worktrees")
# Persisted session registry (survives container restart).
REGISTRY_DIR = os.path.expanduser("~/.agenthub")
REGISTRY_PATH = os.path.join(REGISTRY_DIR, "sessions.json")
# Killed-but-resumable session history (branch + transcript survive a kill).
CLOSED_PATH = os.path.join(REGISTRY_DIR, "closed.json")
# Only the newest N closed sessions per repo are kept/offered for resume —
# bounds both the file and the heartbeat payload.
CLOSED_PER_REPO = 5
# Where Claude Code keeps per-project transcript JSONLs (slug = cwd via
# _project_slug below). Overridable so the test suite can point it at
# fixtures; unset in production, so the default is the real path.
PROJECTS_ROOT = os.environ.get("CLAUDE_PROJECTS_ROOT", "/root/.claude/projects")


def _project_slug(path):
    """Claude Code's project-dir slug for a cwd: EVERY non-alphanumeric
    character becomes '-', not just '/'. The worktree paths this agent
    manages always contain a dot (REPOS_ROOT/.agenthub/worktrees/<id>), so
    the old '/'->'-' mapping produced '-.agenthub-' where Claude writes
    '--agenthub-' — every transcript lookup missed, silently blanking
    session signals, tails, history, and usage for worktree sessions."""
    return re.sub(r"[^A-Za-z0-9]", "-", path)
# Glasses-client transcript tail: how many surviving messages to report per
# beat, and how many chars of each to keep (payload-size bounds).
TAIL_MSGS = int(os.environ.get("SESSION_TAIL_MSGS", "30"))
TAIL_MSG_CHARS = int(os.environ.get("SESSION_TAIL_MSG_CHARS", "500"))
# The per-beat tail above is a bounded *preview* shipped for every session on
# every heartbeat, so a long message is clipped to keep the payload small. The
# single-session reading paths — the live tail (tunnel-agent.js) and on-demand
# `history` — instead keep this many chars per message, so a full assistant
# response never shows up cut off mid-sentence on the glasses. The client keeps
# whichever copy of a message is longer, so the preview never clobbers it.
TAIL_MSG_CHARS_FULL = int(os.environ.get("SESSION_TAIL_MSG_CHARS_FULL", "16000"))
# Terminal color/cursor codes sometimes make it into pasted transcript text;
# strip them so the glasses client only ever sees plain text.
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")
# Glasses-client on-demand commands: how much typed text `input` accepts per
# call, and how many surviving messages an on-demand `history` request returns
# (independent of the per-heartbeat TAIL_MSGS above).
INPUT_MAX_CHARS = int(os.environ.get("SESSION_INPUT_MAX_CHARS", "4000"))
HISTORY_MAX_MSGS = int(os.environ.get("SESSION_HISTORY_MSGS", "200"))

# Transcript parsing is the expensive part; refresh it every N heartbeats.
USAGE_EVERY = 15
# Small pause after launching a Claude session. The whole host shares ONE
# ~/.claude login + .claude.json, so several RC sessions coming up at the exact
# same instant contend on that shared state; staggering reduces the contention.
LAUNCH_STAGGER = 1.0

# API-equivalent pricing per MTok (input, output, cache write, cache read).
# Cache write = 1.25x input (5m TTL), cache read = 0.1x input. Sessions run on
# a subscription, so this is a notional "what this would have cost via the
# API" figure, not a bill. Matched by substring on the model id.
PRICING = {
    "fable": (10.0, 50.0, 12.50, 1.00),
    "mythos": (10.0, 50.0, 12.50, 1.00),
    "opus": (5.0, 25.0, 6.25, 0.50),
    "sonnet": (3.0, 15.0, 3.75, 0.30),
    "haiku": (1.0, 5.0, 1.25, 0.10),
}


def log(msg):
    print(f"[hub-agent] {msg}", flush=True)


def load_pricing_extra():
    """Extra pricing entries from the PRICING_JSON env var (inline JSON, per the
    everything-inline-env convention): {"model-substring": [input, output,
    cacheWrite, cacheRead]} per MTok. Consulted ONLY when the built-in PRICING
    table has no match, so it can price new/unknown models but never override a
    built-in rate. Anything malformed is logged loudly and the whole override
    ignored — a bad env var must never take the agent down."""
    raw = os.environ.get("PRICING_JSON", "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("top level must be a JSON object")
        extra = {}
        for key, rates in data.items():
            if not key or not isinstance(key, str):
                raise ValueError(f"bad model key {key!r}")
            if (
                not isinstance(rates, (list, tuple))
                or len(rates) != 4
                or not all(
                    isinstance(r, (int, float)) and not isinstance(r, bool) and r >= 0
                    for r in rates
                )
            ):
                raise ValueError(
                    f"{key!r} must map to [input, output, cacheWrite, cacheRead] per MTok"
                )
            if key in PRICING:
                log(f"PRICING_JSON: {key!r} duplicates a built-in entry — ignored")
                continue
            extra[key] = tuple(float(r) for r in rates)
        return extra
    except ValueError as e:
        log(f"PRICING_JSON invalid — ignoring it entirely: {e}")
        return {}


PRICING_EXTRA = load_pricing_extra()
# Logged unconditionally at boot so a bad/missing override is diagnosable from
# the container-log tail in the hub UI.
log(
    "pricing extras from PRICING_JSON (consulted for unknown models only): "
    + (", ".join(f"{k}={list(v)}" for k, v in PRICING_EXTRA.items()) or "none")
)


def run(cmd, cwd=None):
    """Run a command, return stripped stdout or '' on any failure."""
    try:
        out = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=15
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def run_ok(cmd, cwd=None):
    """Run a command, return (rc, stderr). rc is None if it couldn't launch."""
    try:
        out = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=30
        )
        return out.returncode, (out.stderr or "").strip()
    except Exception as e:
        return None, str(e)


def slugify(s):
    """URL/tmux/filesystem-safe slug: spaces->-, drop other punctuation."""
    s = re.sub(r"\s+", "-", (s or "").strip())
    s = re.sub(r"[^A-Za-z0-9._-]", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s


# --- new-session spawn options (issues #11/#12/#13) ----------------------------
# Every option below is interpolated into a git or tmux command line, so each is
# validated against a fixed allowlist/enum before use — free-form text NEVER
# reaches the shell. All default to "today's behavior" so a bare spawn (no
# options) produces exactly the pre-existing command shape.

# Model aliases the UI offers -> the value handed to `claude --model`. "default"
# (or blank) means "don't pass --model at all" (claude's own default model).
MODEL_ALIASES = {"opus": "opus", "sonnet": "sonnet", "haiku": "haiku"}
# Permission modes the UI offers. "bypassPermissions" is today's behavior and
# the default; "default" means "omit --permission-mode" (claude's own default).
PERMISSION_MODES = {"bypassPermissions", "acceptEdits", "plan", "default"}
# git-ref-safe token: our allowlist is a strict subset of what git accepts, so
# anything matching is also validated below for the few remaining git rules.
_REF_TOKEN_RE = re.compile(r"^[A-Za-z0-9._/-]+$")


def valid_ref_name(ref):
    """Defensive allowlist for a git branch/ref name we interpolate into a
    command. Stricter than git's own rules on purpose: reject anything with
    shell-meaningful or ambiguous characters, leading dash, empty/dot segments,
    '..', trailing '.lock', '@{', etc."""
    if not ref or len(ref) > 200:
        return False
    if not _REF_TOKEN_RE.match(ref):
        return False
    if ref.startswith("-") or ref.startswith("/") or ref.endswith("/"):
        return False
    if ".." in ref or "//" in ref or "@{" in ref or ref.endswith(".lock"):
        return False
    return all(seg not in ("", ".", "..") for seg in ref.split("/"))


def default_branch_name(repo_path):
    """The repo's default branch short name (no network): origin/HEAD's target
    if set, else 'main'/'master' if either exists locally, else the current
    checkout's branch. Feeds the composer's base default; the fetch-and-detach
    happens in default_base_ref() at spawn time."""
    head = run(["git", "-C", repo_path, "symbolic-ref", "--short", "-q",
                "refs/remotes/origin/HEAD"])
    if head.startswith("origin/"):
        return head[len("origin/"):]
    for cand in ("main", "master"):
        if branch_exists(repo_path, f"refs/heads/{cand}"):
            return cand
    return run(["git", "-C", repo_path, "rev-parse", "--abbrev-ref", "HEAD"])


def default_base_ref(repo_path):
    """The commit-ish a *new* session's detached worktree forks from: the LATEST
    default branch. Best-effort `git fetch` of that branch (offline/no-remote is
    fine — we just fall back), then prefer origin/<default> so new work starts
    from current upstream, else the local branch, else None (detach at HEAD)."""
    name = default_branch_name(repo_path)
    if not name or not valid_ref_name(name):
        return None
    run_ok(["git", "-C", repo_path, "fetch", "origin", name])  # best-effort
    if branch_exists(repo_path, f"refs/remotes/origin/{name}"):
        return f"origin/{name}"
    if branch_exists(repo_path, f"refs/heads/{name}"):
        return name
    return None


def resolve_base_ref(repo_path, base_ref):
    """Resolve the commit-ish a session's detached worktree forks from. Blank/HEAD
    -> the latest default branch (default_base_ref: fetch + origin/<default>).
    An explicit operator choice must be allowlist-clean AND actually resolve in
    the repo (a local branch or origin/<x>) before we hand it to `worktree add`."""
    base_ref = (base_ref or "").strip()
    if not base_ref or base_ref == "HEAD":
        return default_base_ref(repo_path)
    if not valid_ref_name(base_ref):
        raise ValueError(f"invalid base ref {base_ref!r}")
    if not branch_exists(repo_path, base_ref):
        raise ValueError(f"base ref {base_ref!r} not found")
    return base_ref


def resolve_model(model):
    """Map a UI model choice to a `claude --model` value, or None to omit the
    flag. Fixed allowlist — never passes free-form text to claude."""
    model = (model or "").strip().lower()
    if not model or model == "default":
        return None
    if model in MODEL_ALIASES:
        return MODEL_ALIASES[model]
    raise ValueError(f"unknown model {model!r}")


def resolve_permission_mode(mode):
    """Validate a UI permission-mode choice against a fixed enum. Blank ->
    bypassPermissions (today's behavior)."""
    mode = (mode or "").strip()
    if not mode:
        return "bypassPermissions"
    if mode in PERMISSION_MODES:
        return mode
    raise ValueError(f"unknown permission mode {mode!r}")


# --- agent safety guard (--settings wiring) ------------------------------

# Host credential / agent-config stores the agent must never write or delete.
# Path rules use Claude Code's gitignore-style matching and win even under
# `--permission-mode bypassPermissions`, unlike fragile Bash arg patterns.
_GUARD_DENY_PATH_RULES = [
    "Edit(~/.ssh/**)",
    "Write(~/.ssh/**)",
    "Edit(~/.aws/**)",
    "Write(~/.aws/**)",
    "Edit(~/.claude/**)",
    "Write(~/.claude/**)",
    "Edit(~/.config/gcloud/**)",
    "Write(~/.config/gcloud/**)",
]


def guard_script_path():
    """Absolute path to the bundled PreToolUse guard hook. Resolves correctly
    both in the repo (``agent/hooks/guard.py``) and in the image
    (``/usr/local/bin/hooks/guard.py``), since guard.py sits in a ``hooks/``
    dir next to this file in both layouts."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks", "guard.py")


def build_guard_settings(python_exe=None, guard_path=None):
    """Build the dict passed to ``claude --settings``: a ``PreToolUse`` guard
    hook over Bash plus deny rules protecting the host credential stores. The
    bypass-mode session runs freely except for what the guard blocks (see
    ``hooks/guard.py``)."""
    python_exe = python_exe or sys.executable or "python3"
    guard_path = guard_path or guard_script_path()
    hook_command = f'"{python_exe}" "{guard_path}"'
    return {
        "permissions": {"deny": list(_GUARD_DENY_PATH_RULES)},
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Bash",
                    "hooks": [{"type": "command", "command": hook_command}],
                }
            ]
        },
    }


# Names that are NOT a usable per-host identity: blank, localhost, our own
# placeholder, the Docker Desktop LinuxKit VM name (shared by every Windows/Mac
# host, so it collides), and the 12-/64-char hex id the kernel hands an unnamed
# container (socket.gethostname() inside a container — the "fe0e38df73b4" bug).
_HOSTNAME_PLACEHOLDERS = {"", "localhost", "unknown-device", "docker-desktop"}
_CONTAINER_ID_RE = re.compile(r"^[0-9a-f]{12}$|^[0-9a-f]{64}$")


def _usable_hostname(name):
    name = (name or "").strip()
    if name.lower() in _HOSTNAME_PLACEHOLDERS:
        return ""
    if _CONTAINER_ID_RE.match(name):
        return ""
    return name


def docker_host_name():
    """The Docker daemon's own hostname, read through the bind-mounted docker
    socket (`docker info`). This is the automated, zero-config way to learn the
    host's name from inside an isolated container:
      - bare Linux: the physical host's hostname;
      - Docker Engine inside a WSL2 distro ("Docker on Windows via WSL"): the
        distro hostname, which WSL sets to the Windows machine name by default.
    Docker Desktop reports the shared LinuxKit VM name "docker-desktop", which
    _usable_hostname() rejects (it collides across every Desktop host)."""
    return run(["docker", "info", "--format", "{{.Name}}"])


# --- SMB host-name discovery (Docker Desktop / WSL2) -----------------------
# Docker Desktop runs the container in an isolated Linux VM, so none of the
# sources above can see the *Windows* host name (docker info reports the shared
# "docker-desktop"). But the container can still reach the host over the network
# (host.docker.internal), and Windows answers an UNAUTHENTICATED SMB2 NEGOTIATE
# + SESSION_SETUP with an NTLM challenge (type 2) whose Target Info carries the
# machine's NetBIOS computer name. Reading it needs no credentials — it's the
# same trick as nmap's smb-os-discovery — and no host/compose config.
SMB_HOST = os.environ.get("SMB_DISCOVERY_HOST", "host.docker.internal")
SMB_PORT = 445
SMB_TIMEOUT = 4


def _smb_recvn(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise EOFError("SMB connection closed")
        buf += chunk
    return buf


def _smb_recv_msg(sock):
    # Direct-TCP transport: 4-byte length prefix (top byte 0), then the message.
    length = struct.unpack(">I", _smb_recvn(sock, 4))[0] & 0xFFFFFF
    return _smb_recvn(sock, length)


def _smb2_header(command, message_id):
    return struct.pack(
        "<4sHHIHHIIQIIQ16s",
        b"\xfeSMB", 64, 0, 0, command, 1, 0, 0, message_id, 0, 0, 0, b"\x00" * 16,
    )


def _smb_parse_computer_name(data):
    """Pull the NetBIOS computer name out of the NTLM challenge embedded in an
    SMB2 SESSION_SETUP response (Target Info AV pair MsvAvNbComputerName=0x1)."""
    i = data.find(b"NTLMSSP\x00")
    if i < 0 or len(data) - i < 48:
        return ""
    ntlm = data[i:]
    ti_len, _, ti_off = struct.unpack("<HHI", ntlm[40:48])
    ti = ntlm[ti_off:ti_off + ti_len]
    o = 0
    while o + 4 <= len(ti):
        av_id, av_len = struct.unpack("<HH", ti[o:o + 4])
        o += 4
        val = ti[o:o + av_len]
        o += av_len
        if av_id == 0:  # MsvAvEOL
            break
        if av_id == 1:  # MsvAvNbComputerName — the short machine name
            return val.decode("utf-16-le", "replace").strip()
    return ""


def smb_host_name():
    """The Windows host's NetBIOS computer name, read from its SMB service
    (SMB_HOST:445) via an unauthenticated SMB2/NTLM handshake — the automated
    path for Docker Desktop / WSL2. Returns '' on any failure (unreachable,
    firewall-blocked, non-Windows host, or an unexpected response)."""
    negotiate = (
        _smb2_header(0x0000, 0)
        + struct.pack("<HHHHI16sQ", 36, 2, 0x01, 0, 0, b"\x00" * 16, 0)
        + struct.pack("<HH", 0x0202, 0x0210)  # dialects 2.0.2, 2.1
    )
    ntlm_negotiate = (
        b"NTLMSSP\x00"
        + struct.pack("<I", 1)             # message type 1 (NEGOTIATE)
        + struct.pack("<I", 0x00088207)    # UNICODE|OEM|REQ_TARGET|NTLM|SIGN|EXT
        + struct.pack("<HHI", 0, 0, 0)     # DomainName fields (empty)
        + struct.pack("<HHI", 0, 0, 0)     # Workstation fields (empty)
    )
    session = (
        _smb2_header(0x0001, 1)
        + struct.pack("<HBBIIHHQ", 25, 0, 0x01, 0, 0, 88, len(ntlm_negotiate), 0)
        + ntlm_negotiate
    )
    sock = None
    try:
        sock = socket.create_connection((SMB_HOST, SMB_PORT), timeout=SMB_TIMEOUT)
        sock.settimeout(SMB_TIMEOUT)
        sock.sendall(struct.pack(">I", len(negotiate)) + negotiate)
        _smb_recv_msg(sock)
        sock.sendall(struct.pack(">I", len(session)) + session)
        return _smb_parse_computer_name(_smb_recv_msg(sock))
    except Exception:
        return ""
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass


def device_name():
    # The physical host name the hub keys this agent by. A container doesn't know
    # its host's name on its own, so we discover it — no env var / compose config
    # required. entrypoint.sh resolves this once and exports DEVICE_NAME so the
    # manager and the reverse tunnel share one identity. Resolution order:
    #   1. DEVICE_NAME / COMPUTERNAME env — the entrypoint-resolved value (or an
    #      explicit operator override); checked first so the one-time resolution
    #      short-circuits both processes and auto-detection isn't re-run.
    #   2. /host/etc/hostname — the host's hostname if the compose file bind-mounts
    #      it (kept ahead of the socket so Linux/TrueNAS behavior is unchanged).
    #   3. `docker info` .Name via the docker socket — bare Linux / Docker-in-WSL.
    #   4. SMB to the Windows host (host.docker.internal:445) — the Docker Desktop
    #      / WSL2 path, where the container is isolated from the host name.
    #   5. socket.gethostname() — only when it isn't a container id (the
    #      "fe0e38df73b4" bug); inside a container it usually is, so it's rejected.
    for env in ("DEVICE_NAME", "COMPUTERNAME"):
        name = os.environ.get(env, "").strip()
        if name:
            return name
    try:
        with open("/host/etc/hostname") as f:
            name = _usable_hostname(f.read())
            if name:
                return name
    except OSError:
        pass
    name = _usable_hostname(docker_host_name())
    if name:
        return name
    name = _usable_hostname(smb_host_name())
    if name:
        return name
    try:
        name = _usable_hostname(socket.gethostname())
        if name:
            return name
    except OSError:
        pass
    log(
        "device name unresolved: no /host/etc/hostname, no usable `docker info` "
        "name, no SMB reply from the host, and the OS hostname is a container id "
        "— falling back to 'unknown-device' (set DEVICE_NAME to override)"
    )
    return "unknown-device"


def git_info(cwd):
    if not run(["git", "rev-parse", "--git-dir"], cwd=cwd):
        return None
    dirty = run(["git", "status", "--porcelain"], cwd=cwd)
    remote = run(["git", "remote", "get-url", "origin"], cwd=cwd)
    # Repo name from the remote (".../xerktech/DockerOps.git" -> "DockerOps"),
    # falling back to the checkout's top-level directory name.
    name = remote.rstrip("/").rsplit("/", 1)[-1].removesuffix(".git")
    if not name:
        top = run(["git", "rev-parse", "--show-toplevel"], cwd=cwd)
        name = os.path.basename(top) if top else ""
    return {
        "repoName": name,
        "branch": run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=cwd),
        "dirtyFiles": len(dirty.splitlines()) if dirty else 0,
        "lastCommit": run(["git", "log", "-1", "--format=%h %s"], cwd=cwd)[:120],
        "remote": remote,
    }


def branch_exists(repo_path, ref):
    """True if the fully-qualified ref resolves in this repo (no network)."""
    return bool(run(["git", "-C", repo_path, "rev-parse", "--verify",
                     "--quiet", ref]))


def branch_sync(repo_path, branch, base_ref):
    """How a session branch relates to its base branch and to origin — the
    "is this work safe yet?" facts behind the UI's work-state line and the
    delete guard. Same cost class as `status --porcelain`: a couple of local
    ref lookups plus rev-list --count, no network (origin/<branch> is the
    remote-tracking ref, which a push from this host updates). Computed
    against the shared repo, so it works even after the worktree is gone.
    Every field degrades to None instead of raising: branch not born yet,
    detached base, no origin, unfetchable counts, etc.

      baseRef       base branch compared against (None if indeterminate)
      aheadOfBase   commits on the branch that the base doesn't have
      pushed        origin/<branch> exists locally (pushed from here at some
                    point); None when the branch itself doesn't exist yet
      aheadOfRemote commits not yet on origin/<branch> (pushed only)
    """
    info = {"baseRef": None, "aheadOfBase": None, "pushed": None,
            "aheadOfRemote": None}
    if not branch or branch == "HEAD":
        return info
    local = f"refs/heads/{branch}"
    if not branch_exists(repo_path, local):
        return info
    info["pushed"] = branch_exists(repo_path, f"refs/remotes/origin/{branch}")
    if info["pushed"]:
        n = run(["git", "-C", repo_path, "rev-list", "--count",
                 f"refs/remotes/origin/{branch}..{local}"])
        info["aheadOfRemote"] = int(n) if n.isdigit() else None
    if base_ref and base_ref != "HEAD" and base_ref != branch:
        n = run(["git", "-C", repo_path, "rev-list", "--count",
                 f"refs/heads/{base_ref}..{local}"])
        if n.isdigit():
            info["baseRef"] = base_ref
            info["aheadOfBase"] = int(n)
    return info


def memory_usage():
    # cgroup v2, then v1.
    for cur, limit in (
        ("/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.max"),
        (
            "/sys/fs/cgroup/memory/memory.usage_in_bytes",
            "/sys/fs/cgroup/memory/memory.limit_in_bytes",
        ),
    ):
        try:
            with open(cur) as f:
                used = int(f.read().strip())
            lim = None
            with open(limit) as f:
                raw = f.read().strip()
                if raw.isdigit() and int(raw) < 1 << 60:
                    lim = int(raw)
            return {"usedBytes": used, "limitBytes": lim}
        except OSError:
            continue
    return None


HISTORY_DAYS = 60  # per-day breakdown reported to the hub (bounds payload size)


def usage_report(workdir):
    """Aggregate token usage for this project from the transcript JSONLs."""
    slug = _project_slug(workdir)
    proj = os.path.join(PROJECTS_ROOT, slug)
    totals = {"input": 0, "output": 0, "cacheWrite": 0, "cacheRead": 0, "cost": 0.0}
    days = {}  # "YYYY-MM-DD" (UTC) -> same shape as totals
    models = {}
    unpriced = set()  # model ids with token usage that no pricing entry matched
    seen = set()
    last_ts = ""
    sessions = 0
    today_str = time.strftime("%Y-%m-%d")

    try:
        files = [f for f in os.listdir(proj) if f.endswith(".jsonl")]
    except OSError:
        return None

    for fname in files:
        sessions += 1
        try:
            with open(os.path.join(proj, fname), errors="replace") as f:
                for line in f:
                    if '"usage"' not in line:
                        continue
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    msg = entry.get("message") or {}
                    usage = msg.get("usage")
                    if not isinstance(usage, dict):
                        continue
                    key = (msg.get("id"), entry.get("requestId"))
                    if key[0] and key in seen:
                        continue
                    seen.add(key)

                    ts = entry.get("timestamp") or ""
                    if ts > last_ts:
                        last_ts = ts
                    model = msg.get("model") or "unknown"
                    models[model] = models.get(model, 0) + 1

                    tok = (
                        usage.get("input_tokens", 0) or 0,
                        usage.get("output_tokens", 0) or 0,
                        usage.get("cache_creation_input_tokens", 0) or 0,
                        usage.get("cache_read_input_tokens", 0) or 0,
                    )
                    # Built-in table first (authoritative); PRICING_EXTRA only
                    # covers models the built-ins don't match.
                    price = next(
                        (p for k, p in PRICING.items() if k in model), None
                    ) or next(
                        (p for k, p in PRICING_EXTRA.items() if k in model), None
                    )
                    cost = (
                        sum(t * p for t, p in zip(tok, price)) / 1e6
                        if price
                        else 0.0
                    )
                    # An unpriced model costs $0.00 — flag every bucket it lands
                    # in so the UI never understates cost silently.
                    is_unpriced = price is None and any(tok)
                    if is_unpriced:
                        unpriced.add(model)
                    buckets = [totals]
                    # Transcript timestamps are UTC ISO; date-prefix bucketing
                    # is close enough for a dashboard.
                    if len(ts) >= 10:
                        buckets.append(
                            days.setdefault(
                                ts[:10],
                                {"input": 0, "output": 0, "cacheWrite": 0, "cacheRead": 0, "cost": 0.0},
                            )
                        )
                    for b in buckets:
                        b["input"] += tok[0]
                        b["output"] += tok[1]
                        b["cacheWrite"] += tok[2]
                        b["cacheRead"] += tok[3]
                        b["cost"] += cost
                        if is_unpriced:
                            b["unpriced"] = True
        except OSError:
            continue

    totals["cost"] = round(totals["cost"], 2)
    days = {d: days[d] for d in sorted(days)[-HISTORY_DAYS:]}
    for day in days.values():
        day["cost"] = round(day["cost"], 2)
    today = days.get(
        today_str, {"input": 0, "output": 0, "cacheWrite": 0, "cacheRead": 0, "cost": 0.0}
    )
    return {
        "totals": totals,
        "today": today,
        "days": days,
        "sessions": sessions,
        "lastActivity": last_ts,
        "models": sorted(models, key=models.get, reverse=True),
        # Models whose usage no pricing entry matched (their cost counted as
        # $0.00) — the UI flags any figure that includes them.
        "unpricedModels": sorted(unpriced),
    }


PR_URL_RE = re.compile(r"https://github\.com/[\w.-]+/[\w.-]+/pull/\d+")
LOG_TAIL_LINES = 50
LOG_TAIL_MAX_BYTES = 12_000


def _read_tail_lines(path, max_bytes):
    """Non-empty raw lines from roughly the last max_bytes of a file, in file
    order. The leading line may be a fragment (seek landed mid-line) — callers
    that json.loads() it get a ValueError and skip it like any other garbage."""
    try:
        with open(path, "rb") as f:
            f.seek(max(0, os.fstat(f.fileno()).st_size - max_bytes))
            raw = f.read()
    except OSError:
        return []
    return [line.strip() for line in raw.split(b"\n") if line.strip()]


def _last_entry(path):
    """Newest complete JSON line from the tail of a transcript JSONL."""
    for raw in reversed(_read_tail_lines(path, 65536)):
        try:
            return json.loads(raw)
        except ValueError:
            continue  # partial write at the tail, or the seek-point fragment
    return None


def _tail_entries(path):
    """Parsed dict entries from roughly the last 128 KB of a transcript JSONL,
    in file order. Tolerant JSONL parse: lines that fail json.loads or don't
    decode to a dict (a truncated seek-point fragment, a partial write) are
    silently skipped rather than aborting the read."""
    entries = []
    for raw in _read_tail_lines(path, 1 << 17):  # ~128 KB
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if isinstance(entry, dict):
            entries.append(entry)
    return entries


def _entry_text(entry):
    """Map one transcript entry to display text for the glasses tail feed, or
    None to drop it (wrong type, no message, tool_result-only turn, or empty
    after stripping ANSI)."""
    if entry.get("type") not in ("user", "assistant"):
        return None
    msg = entry.get("message")
    if not isinstance(msg, dict):
        return None
    content = msg.get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        parts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text":
                parts.append(str(block.get("text") or ""))
            elif btype == "tool_use" and block.get("name"):
                parts.append(f"[{block['name']}]")
            # "thinking" and "tool_result" blocks are dropped.
        text = "".join(parts)
    else:
        return None
    text = ANSI_RE.sub("", text).strip()
    return text or None


def transcript_tail(path):
    """Last TAIL_MSGS surviving messages of a transcript for the glasses
    client's tail feed, oldest first: [{"id": entry uuid, "role": "user"/
    "assistant", "text": text}, ...]. Missing/empty transcript -> []. id is
    the transcript entry's own uuid so clients can merge/dedup on it."""
    tail = []
    for entry in _tail_entries(path):
        text = _entry_text(entry)
        if text is None:
            continue
        tail.append({
            "id": entry.get("uuid"),
            "role": entry.get("type"),
            "text": text[:TAIL_MSG_CHARS],
        })
    return tail[-TAIL_MSGS:]


def _newest_transcript_path(workdir):
    """Newest transcript JSONL for a worktree: same lookup session_report uses
    (worktree path -> project slug dir -> newest *.jsonl). None when the
    project dir is missing or has no transcripts."""
    slug = _project_slug(workdir)
    proj = os.path.join(PROJECTS_ROOT, slug)
    newest, newest_mtime = None, 0.0
    try:
        for fname in os.listdir(proj):
            if not fname.endswith(".jsonl"):
                continue
            path = os.path.join(proj, fname)
            try:
                mtime = os.stat(path).st_mtime
            except OSError:
                continue
            if mtime > newest_mtime:
                newest, newest_mtime = path, mtime
    except OSError:
        return None
    return newest


def _history_entries(path):
    """On-demand `history` read of a transcript: bounded to the last 4 MiB
    (1 << 22, same cap the PR-URL scan uses) rather than transcript_tail's
    ~128 KB, tolerant JSONL parse, entries mapped through _entry_text (no
    duplicated entry->text logic). Returns (entries, byte_capped) — oldest
    first; byte_capped is True when the file is bigger than the 4 MiB window,
    i.e. older content was cut off before parsing even started."""
    read_cap = 1 << 22
    try:
        byte_capped = os.path.getsize(path) > read_cap
    except OSError:
        byte_capped = False
    entries = []
    for raw in _read_tail_lines(path, read_cap):
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        text = _entry_text(entry)
        if text is None:
            continue
        entries.append({
            "id": entry.get("uuid"),
            "role": entry.get("type"),
            "text": text[:TAIL_MSG_CHARS_FULL],
        })
    return entries, byte_capped


def session_report(workdir, state):
    """Cheap per-heartbeat session signals (stat + tail reads, no full parse).

    state carries per-file byte offsets between beats so the PR-URL scan only
    reads what was appended since the last beat. The first call primes the
    offsets to EOF for every existing transcript, so a restarted agent never
    replays PR links from old sessions.
    """
    slug = _project_slug(workdir)
    proj = os.path.join(PROJECTS_ROOT, slug)
    primed = state.get("primed", False)
    offsets = state.setdefault("offsets", {})
    seen = state.setdefault("pr_seen", set())
    report = {
        "bridgeAttached": os.path.exists(os.path.join(proj, "bridge-pointer.json")),
        "transcriptAgeSec": None,  # seconds since the newest transcript write
        "lastRole": None,          # "assistant"/"user"/... of the newest entry
        "lastHasToolUse": False,
        "question": None,          # pending AskUserQuestion text, if any
        "questionOptions": [],     # pending AskUserQuestion option labels, if any
        "prUrls": [],              # PR links newly appended since last beat
        "tail": [],                # recent transcript messages, for the glasses client
    }

    newest, newest_mtime = None, 0.0
    try:
        for fname in os.listdir(proj):
            if not fname.endswith(".jsonl"):
                continue
            path = os.path.join(proj, fname)
            try:
                st = os.stat(path)
            except OSError:
                continue
            if not primed:
                offsets[path] = st.st_size
            if st.st_mtime > newest_mtime:
                newest, newest_mtime = path, st.st_mtime
    except OSError:
        state["primed"] = True
        return report
    state["primed"] = True
    if not newest:
        return report
    report["transcriptAgeSec"] = max(0, int(time.time() - newest_mtime))
    report["tail"] = transcript_tail(newest)

    entry = _last_entry(newest)
    if entry:
        report["lastRole"] = entry.get("type")
        msg = entry.get("message") or {}
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if not (isinstance(block, dict) and block.get("type") == "tool_use"):
                    continue
                report["lastHasToolUse"] = True
                if block.get("name") == "AskUserQuestion" and report["lastRole"] == "assistant":
                    qs = (block.get("input") or {}).get("questions") or []
                    if qs and isinstance(qs[0], dict):
                        report["question"] = str(qs[0].get("question") or "")[:300] or None
                        opts = qs[0].get("options") or []
                        report["questionOptions"] = [
                            opt["label"][:80] for opt in opts[:4]
                            if isinstance(opt, dict) and isinstance(opt.get("label"), str)
                        ]

    # Incremental PR-URL scan over bytes appended to the active transcript.
    try:
        size = os.stat(newest).st_size
        start = offsets.get(newest, 0)
        if size < start:
            start = size  # file was truncated/rewritten; don't rescan
        if size - start > 1 << 22:
            start = size - (1 << 22)  # cap a huge backlog at 4 MiB
        if size > start:
            with open(newest, "rb") as f:
                f.seek(start)
                chunk = f.read(size - start).decode(errors="replace")
            for m in PR_URL_RE.finditer(chunk):
                url = m.group(0)
                if url not in seen:
                    seen.add(url)
                    report["prUrls"].append(url)
        offsets[newest] = size
    except OSError:
        pass
    return report


def log_tail(container_id):
    """Last lines of this container's own log, stdout+stderr interleaved."""
    try:
        out = subprocess.run(
            ["docker", "logs", "--tail", str(LOG_TAIL_LINES), container_id],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            timeout=15,
        )
        text = out.stdout or ""
    except Exception:
        return None
    return text[-LOG_TAIL_MAX_BYTES:] or None


def scan_repos():
    """REPOS_ROOT children that are non-dot dirs (excluding .agenthub) with a
    .git entry. Returns [{"name","path"}] — the multiplexer's repo list."""
    repos = []
    try:
        for name in sorted(os.listdir(REPOS_ROOT)):
            # Skip dot-dirs, our own worktree store, and the reserved root
            # pseudo-repo name so a real dir can never shadow the root entry.
            if name.startswith(".") or name in (".agenthub", ROOT_REPO_NAME):
                continue
            path = os.path.join(REPOS_ROOT, name)
            if not os.path.isdir(path):
                continue
            if not os.path.exists(os.path.join(path, ".git")):
                continue
            repos.append({"name": name, "path": path})
    except OSError:
        pass
    return repos


def repo_branches(path):
    """Local branches an operator might fork a new session from, newest-commit
    first and capped — feeds the composer's base-branch dropdown. Cheap local
    ref walk (no network). The app no longer creates its own branches, so every
    local branch (incl. ones a running session named for its work) is a valid
    detach point; a detached worktree can even fork off a branch checked out
    elsewhere."""
    out = run(["git", "-C", path, "for-each-ref", "--sort=-committerdate",
               "--format=%(refname:short)", "refs/heads"])
    branches = []
    for b in out.splitlines():
        b = b.strip()
        if not b:
            continue
        branches.append(b)
        if len(branches) >= 50:
            break
    return branches


def repo_entry(repo):
    """Heartbeat repos[] entry: light git facts about the repo's own checkout."""
    path = repo["path"]
    dirty = run(["git", "status", "--porcelain"], cwd=path)
    return {
        "name": repo["name"],
        "path": path,
        "branch": run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=path),
        "remote": run(["git", "remote", "get-url", "origin"], cwd=path),
        "dirtyFiles": len(dirty.splitlines()) if dirty else 0,
        # Base-branch choices for the "New session" composer (#12), plus the
        # default the composer pre-selects (new sessions fork off latest main).
        "branches": repo_branches(path),
        "defaultBranch": default_branch_name(path),
    }


def root_repo_entry():
    """Heartbeat repos[] entry for the REPOS_ROOT pseudo-repo, so the hub can
    offer a "New session" affordance that runs directly at the root. Unlike
    repo_entry() it runs no per-branch ref walk (the root isn't a fork source,
    so there's no base-branch list); git facts are best-effort and empty unless
    REPOS_ROOT itself happens to be a git checkout. isRoot flags it for the UI,
    which hides the base-branch/custom-branch/resume/clone bits that don't apply."""
    info = git_info(REPOS_ROOT) or {}
    return {
        "name": ROOT_REPO_NAME,
        "path": REPOS_ROOT,
        "isRoot": True,
        "branch": info.get("branch", ""),
        "remote": info.get("remote", ""),
        "dirtyFiles": info.get("dirtyFiles", 0),
        "branches": [],
        "defaultBranch": "",
    }


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# --- GitHub clone-into-root ----------------------------------------------------
# The hub can ask the agent to `git clone` a GitHub repo into REPOS_ROOT so it
# joins the scanned repo list and becomes spawnable. The whole feature is gated
# on GitHub creds: with no usable `gh` login the hub greys the control out. The
# repo spec (from a dropdown of the login's repos, or free-typed owner/repo) is
# validated down to a bare owner/repo before it is interpolated into a clone URL
# and a filesystem dest, so nothing free-form reaches git or the shell.
GITHUB_REFRESH_EVERY = 15   # beats between gh availability/repo-list refreshes
GH_REPO_LIMIT = 100         # per owner, passed to `gh repo list --limit`
GH_REPO_MAX = 300           # total repos reported (bounds the heartbeat payload)
GH_ORG_MAX = 20             # orgs to auto-sweep for repos (bounds the gh calls)
CLONE_TIMEOUT_SEC = 600     # reap a `git clone` subprocess stuck this long
CLONE_DONE_LINGER_SEC = 30  # keep a finished clone job visible this long...
CLONE_ERROR_LINGER_SEC = 300  # ...longer for a failed one (operator reads it)
PRUNE_RESULT_LINGER_SEC = 60  # keep a repo's prune summary in the heartbeat
# A GitHub owner or repo-name segment: alnum start, then GitHub's own limited
# set. Deliberately strict — the result becomes part of a URL and a path.
_GH_SEG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def normalize_github_repo(spec):
    """Parse an 'owner/repo' out of a slug or GitHub URL and return it validated,
    or raise ValueError. Accepts 'owner/repo',
    'https://github.com/owner/repo(.git)', and 'git@github.com:owner/repo(.git)'.
    Both segments are allowlist-checked (no '..', no leading dash, bounded
    length) so nothing shell- or path-dangerous reaches git."""
    spec = (spec or "").strip()
    if not spec:
        raise ValueError("empty repo spec")
    m = re.match(r"^(?:https?://[^/]+/|git@[^:]+:)(.+)$", spec)
    if m:
        spec = m.group(1)
    spec = spec.strip("/")
    if spec.endswith(".git"):
        spec = spec[:-len(".git")]
    parts = spec.split("/")
    if len(parts) != 2:
        raise ValueError(f"expected owner/repo, got {spec!r}")
    owner, repo = parts
    for seg in (owner, repo):
        if len(seg) > 100 or ".." in seg or not _GH_SEG_RE.match(seg):
            raise ValueError(f"invalid owner/repo segment {seg!r}")
    return f"{owner}/{repo}"


def gh_token_present():
    """True if `gh` has a usable auth token (from the mounted /root/.config/gh
    or a GH_TOKEN/GITHUB_TOKEN env). Local and cheap — `gh auth token` just
    prints the stored token; no network round-trip."""
    return bool(run(["gh", "auth", "token"]))


def _gh_repo_list(owner):
    """`gh repo list [owner] --json ...` -> parsed list ([] on any failure).
    owner=None lists the authenticated user's own repos."""
    cmd = ["gh", "repo", "list"]
    if owner:
        cmd.append(owner)
    cmd += ["--limit", str(GH_REPO_LIMIT), "--json",
            "nameWithOwner,description,isPrivate,updatedAt"]
    raw = run(cmd)
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except ValueError:
        return []
    return data if isinstance(data, list) else []


def _gh_user_orgs():
    """Logins of the orgs the authenticated user belongs to (capped, best
    effort). This is what makes org-owned repos show up in the dropdown without
    any config: `gh repo list` with no owner only returns the user's OWN repos,
    so an org member would otherwise see an empty list."""
    raw = run(["gh", "api", "user/orgs", "--jq", ".[].login"])
    return [o.strip() for o in raw.splitlines() if o.strip()][:GH_ORG_MAX]


def list_github_repos():
    """Repos the gh login can clone, for the hub's clone dropdown. Sweeps, in
    order: the authenticated user's own repos, the orgs they belong to (so
    org-owned repos appear with no config — the common case), and any extra
    owners named in GH_CLONE_OWNERS (space/comma separated). Deduped by
    nameWithOwner, newest-updated first, capped at GH_REPO_MAX."""
    extra = [o for o in re.split(r"[\s,]+", os.environ.get("GH_CLONE_OWNERS", "").strip()) if o]
    # None = the authenticated user's own repos; then their orgs; then overrides.
    targets, seen_targets = [], set()
    for owner in [None] + _gh_user_orgs() + extra:
        key = owner or ""
        if key not in seen_targets:
            seen_targets.add(key)
            targets.append(owner)
    found = {}
    for owner in targets:
        for r in _gh_repo_list(owner):
            nwo = r.get("nameWithOwner")
            if not nwo or nwo in found:
                continue
            found[nwo] = {
                "nameWithOwner": nwo,
                "name": nwo.split("/")[-1],
                "description": (r.get("description") or "")[:120],
                "isPrivate": bool(r.get("isPrivate")),
                "updatedAt": r.get("updatedAt") or "",
            }
    repos = sorted(found.values(), key=lambda r: r["updatedAt"], reverse=True)
    return repos[:GH_REPO_MAX]


def collect_github():
    """The heartbeat's `github` block: whether cloning is available (a gh token
    is present) and, if so, the login + clonable repo list. Any failure degrades
    to available=False rather than raising, so a creds hiccup never breaks the
    heartbeat."""
    if not gh_token_present():
        return {"available": False, "login": None, "repos": []}
    login = run(["gh", "api", "user", "--jq", ".login"]) or None
    return {"available": True, "login": login, "repos": list_github_repos()}


# --- Session activity summaries ------------------------------------------------
# Optionally give each session a few-word "name" describing its task (e.g.
# "Adding Compose Flag"), generated once at spawn from the initial prompt by the
# container's already-authenticated `claude` in headless print mode (`claude -p`,
# Haiku by default). It reuses the mounted login, so there is NO external API or
# key. The call runs as a detached subprocess reaped on later beats (never blocks
# the heartbeat) and is deliberately ONE-SHOT — only at spawn — because every
# session shares the one login, so re-summarizing per beat would draw on the
# working sessions' rate limits. Sessions spawned with no initial prompt (the
# one-click bare spawn, the repos-root pseudo-repo) simply stay unnamed and the
# card falls back to the label/worktree. Off unless SESSION_SUMMARY_ENABLED.
SESSION_SUMMARY_ENABLED = os.environ.get(
    "SESSION_SUMMARY_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")
# Handed straight to `claude --model`; validated only against claude's own
# aliases, but this is a fixed operator-set env, not free-form spawn input.
SESSION_SUMMARY_MODEL = os.environ.get("SESSION_SUMMARY_MODEL", "haiku").strip() or "haiku"
try:
    SUMMARY_TIMEOUT_SEC = int(os.environ.get("SESSION_SUMMARY_TIMEOUT_SEC", "45"))
except ValueError:
    SUMMARY_TIMEOUT_SEC = 45
SUMMARY_MAX_WORDS = 6          # cap a chatty reply so it can't bloat the card
SUMMARY_MAX_CHARS = 48
SUMMARY_PROMPT_CAP = 2000      # cap the task text handed to the summarizer
SUMMARY_INSTRUCTION = (
    "In 2-4 words, give a Title Case name for the coding task below "
    '(e.g. "Adding Compose Flag", "Debugging Heartbeat Parser"). '
    "Reply with ONLY the name — no quotes, no punctuation, no preamble.\n\nTask:\n"
)


def clean_summary(raw):
    """Reduce raw `claude -p` output to a short display name, or None. Takes the
    first non-empty line, strips surrounding quotes/backticks and trailing
    punctuation, and caps to a few words / chars so a verbose reply can't blow
    up the session card."""
    text = (raw or "").strip()
    if not text:
        return None
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    line = re.sub(r"[\"'`]+", " ", line)
    line = re.sub(r"[.\s]+$", "", line).strip()
    if not line:
        return None
    capped = " ".join(line.split()[:SUMMARY_MAX_WORDS])[:SUMMARY_MAX_CHARS].strip()
    return capped or None


class SessionManager:
    """Owns the registry, the live tmux/ttyd/claude processes, and the
    heartbeat loop. Single-threaded: all mutations happen in the main loop, so
    no locking is needed. Every lifecycle op is wrapped so one bad session can
    never take down the manager or the others."""

    def __init__(self):
        # agent_id is the container's own hostname/ID — used only for LOCAL docker
        # self-operations (inspect StartedAt, log tail, self-restart), never as the
        # hub identity. With one container per host, the container name is no longer
        # meaningful (they're all just "agent"); the physical host name (device) is
        # what the hub keys on and displays.
        self.agent_id = run(["hostname"]) or "unknown"
        self.started_at = run(
            ["docker", "inspect", "--format", "{{.State.StartedAt}}", self.agent_id]
        )
        self.claude_version = run(["claude", "--version"])
        self.device = device_name()

        self.registry = self._load_list(REGISTRY_PATH)  # persisted live sessions
        self.closed = self._load_list(CLOSED_PATH)      # killed-but-resumable
        self.ttyd = {}                           # id -> ttyd Popen (in-memory)
        self.sess_state = {}                     # id -> session_report offsets
        self.usage_cache = {}                    # id -> usage_report result
        self.pending_prs = {}                    # id -> undelivered PR urls
        # Staged `history` command results awaiting the next heartbeat payload
        # (historyResults) — held across a failed POST, cleared only once
        # delivery succeeds, same lifecycle as pending_prs above.
        self.history_results = []
        # GitHub clone-into-root state: the cached availability/repo-list block
        # (refreshed on a slow cadence, reported every beat) and in-flight/recent
        # clone jobs keyed by dest name (the Popen lives here; only a serializable
        # view is heartbeated).
        self.github = {"available": False, "login": None, "repos": []}
        self.clones = {}
        # Recent per-repo prune results (merged branches + safe worktrees swept),
        # keyed by repo name, lingered briefly so the UI can show the summary.
        self.prunes = {}
        # In-flight session-summary subprocesses keyed by session id (the Popen
        # + its output file live here; the finished text lands on the session
        # record). Empty unless SESSION_SUMMARY_ENABLED.
        self.summaries = {}
        # at-least-once command de-dup: cmdIds we've already executed.
        self.acked = set()
        self.acked_order = deque(maxlen=1000)

    # --- registry persistence ---------------------------------------------

    def _load_list(self, path):
        try:
            with open(path) as f:
                data = json.load(f)
            return data if isinstance(data, list) else []
        except (OSError, ValueError):
            return []

    def save(self):
        try:
            os.makedirs(REGISTRY_DIR, exist_ok=True)
            for path, data in ((REGISTRY_PATH, self.registry), (CLOSED_PATH, self.closed)):
                tmp = path + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(data, f, indent=2)
                os.replace(tmp, path)
        except OSError as e:
            log(f"registry save failed: {e}")

    def _find(self, sid):
        return next((s for s in self.registry if s.get("id") == sid), None)

    def _new_id(self):
        existing = {s.get("id") for s in self.registry}
        while True:
            sid = secrets.token_hex(3)[:5]
            if sid not in existing:
                return sid

    def _alloc_port(self):
        used = {s.get("ttydPort") for s in self.registry if s.get("ttydPort")}
        p = TTYD_PORT_BASE
        while p in used:
            p += 1
        return p

    def _running_count(self):
        return sum(1 for s in self.registry if s.get("status") == "running")

    def _root_running(self):
        """True if a root session (cwd = REPOS_ROOT) is already live. Root
        sessions share one claude project slug + RC bridge pointer, so only one
        may run at a time; spawn/start/resume all gate on this."""
        return any(s.get("root") and s.get("status") == "running"
                   for s in self.registry)

    # --- low-level process control ----------------------------------------

    def _drop_bridge_pointer(self, worktree):
        # Never reattach a fresh claude to a dead RC bridge from a prior session
        # (that silently swallows prompts). The project slug matches how Claude
        # keys ~/.claude/projects for a given cwd.
        slug = _project_slug(worktree)
        try:
            os.remove(os.path.join(PROJECTS_ROOT, slug, "bridge-pointer.json"))
        except OSError:
            pass

    def _latest_transcript_id(self, worktree):
        """Claude session id of this worktree's newest transcript, or None.

        Transcripts under ~/.claude/projects/<slug>/ are named
        <session-id>.jsonl, so the newest file's stem is the id to hand to
        `claude --resume`. Explicit --resume <id> is used over --continue: one
        slug can hold several transcripts (each clear-context restart starts a
        new one) and --continue's "most recent" pick is opaque, while
        newest-mtime here is deterministic."""
        slug = _project_slug(worktree)
        proj = os.path.join(PROJECTS_ROOT, slug)
        newest, newest_mtime = None, 0.0
        try:
            for fname in os.listdir(proj):
                if not fname.endswith(".jsonl"):
                    continue
                sid = fname[:-len(".jsonl")]
                # The id is interpolated into the tmux command line; never pass
                # through a name that isn't a plain uuid-ish token.
                if not re.fullmatch(r"[A-Za-z0-9-]+", sid):
                    continue
                try:
                    mtime = os.stat(os.path.join(proj, fname)).st_mtime
                except OSError:
                    continue
                if mtime > newest_mtime:
                    newest, newest_mtime = sid, mtime
        except OSError:
            return None
        return newest

    def _ensure_guard_settings(self):
        """Write (once per manager) the Claude ``--settings`` file that wires
        the PreToolUse safety guard, returning its path — or None if it couldn't
        be written, in which case the session launches without the guard layer
        rather than failing to start. The content is identical for every session
        on the host (guard path + interpreter are fixed), so it's written once
        to ``REGISTRY_DIR/guard-settings.json`` and reused."""
        cached = getattr(self, "_guard_settings_path", None)
        if cached and os.path.exists(cached):
            return cached
        path = os.path.join(REGISTRY_DIR, "guard-settings.json")
        try:
            os.makedirs(REGISTRY_DIR, exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(build_guard_settings(), fh, indent=2)
        except OSError as e:
            log(f"guard settings write failed ({e}); launching without --settings")
            return None
        self._guard_settings_path = path
        return path

    def _launch_tmux(self, sess, resume=False, prompt=None):
        """(Re)launch claude for a session inside its own tmux, detached.

        resume=True relaunches the worktree's most recent CONVERSATION
        (claude --resume <newest transcript id>) instead of an empty context;
        it silently falls back to a fresh claude when no transcript exists.

        prompt (spawn only, #11) is delivered as claude's positional initial
        prompt — the race-free path: it is submitted as the first user turn when
        the interactive RC session comes up, with no send-keys timing to get
        wrong. It is shell-quoted (shlex.quote) and placed after `--` so a task
        that happens to start with '-' can't be read as a flag. The per-session
        model (#12) and permission mode (#12) come from the validated fields on
        the session record; both fall back to today's behavior when unset."""
        self._drop_bridge_pointer(sess["worktreePath"])
        # Claude in this worktree. IS_SANDBOX=1 (compose) lets
        # bypassPermissions run under root; --remote-control bridges the session
        # to claude.ai/code + mobile under its per-session display name.
        parts = ["claude"]
        if resume:
            claude_sid = self._latest_transcript_id(sess["worktreePath"])
            if claude_sid:
                parts.append(f"--resume {claude_sid}")
        parts.append(f"--remote-control '{sess['rcName']}'")
        model = sess.get("model")
        if model:
            parts.append(f"--model {model}")
        # Default (unset) preserves today's --permission-mode bypassPermissions;
        # the explicit "default" choice omits the flag (claude's own default).
        perm = sess.get("permissionMode") or "bypassPermissions"
        if perm != "default":
            parts.append(f"--permission-mode {perm}")
        # Wire the PreToolUse safety guard that makes bypassPermissions safe
        # (blocks catastrophic / policy / attribution Bash). Best-effort: if the
        # settings file can't be written the session still launches (bare).
        settings = self._ensure_guard_settings()
        if settings:
            parts.append(f"--settings {shlex.quote(settings)}")
        claude_cmd = " ".join(parts)
        if prompt:
            claude_cmd += f" -- {shlex.quote(prompt)}"
        run(["tmux", "kill-session", "-t", sess["tmuxName"]])  # ensure clean slate
        rc, err = run_ok([
            "tmux", "new-session", "-d", "-s", sess["tmuxName"],
            "-c", sess["worktreePath"], "-x", "220", "-y", "50", claude_cmd,
        ])
        if rc != 0:
            raise RuntimeError(f"tmux launch failed: {err}")

    def _launch_ttyd(self, sess):
        """Ensure a ttyd is serving this session's tmux on its stable port.

        ttyd flags mirror the old single-session entrypoint, now applied
        per-session: loopback-only (the sole reachable path is the local
        tunnel-agent the hub drives), interactive (-W), scoped to base path
        /term/<id> so ttyd's own asset/WS URLs resolve behind the hub prefix,
        JBMNerd font + canvas renderer + disableLeaveAlert for the TUI, and
        basic auth (-c) keyed off the shared agent token as defense in depth."""
        proc = self.ttyd.get(sess["id"])
        if proc is not None and proc.poll() is None:
            return  # already serving (e.g. restart keeps ttyd up)
        args = [
            "ttyd", "-p", str(sess["ttydPort"]), "-i", "127.0.0.1",
            "-b", f"/term/{sess['id']}", "-W", "-m", "8",
            "-t", 'fontFamily=JBMNerd, "JetBrainsMono Nerd Font Mono", "DejaVu Sans Mono", monospace',
            "-t", "fontSize=14",
            "-t", "rendererType=canvas",
            "-t", "disableLeaveAlert=true",
            "-c", f"term:{HUB_TOKEN or 'changeme'}",
            "tmux", "attach", "-t", sess["tmuxName"],
        ]
        try:
            self.ttyd[sess["id"]] = subprocess.Popen(
                args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
        except Exception as e:
            raise RuntimeError(f"ttyd launch failed: {e}")

    def _kill_tmux(self, sess):
        run(["tmux", "kill-session", "-t", sess["tmuxName"]])

    def _kill_ttyd(self, sid):
        proc = self.ttyd.pop(sid, None)
        if proc is not None:
            try:
                proc.terminate()
            except Exception:
                pass

    def _worktree_add(self, sess, base_ref=None):
        """Add the worktree in DETACHED HEAD — the app never creates a branch;
        the running agent branches its own work. base_ref (a pre-validated
        commit-ish, typically origin/<default> for latest main) is the detach
        point; None detaches at the repo's current HEAD. Used by spawn and, as a
        cold-path recovery, by start/resume when the worktree dir has vanished."""
        os.makedirs(os.path.dirname(sess["worktreePath"]), exist_ok=True)
        # Clear any stale worktree registration left by a --force removal that
        # partially failed, so `worktree add` doesn't refuse.
        run(["git", "-C", sess["repoPath"], "worktree", "prune"])
        cmd = ["git", "-C", sess["repoPath"], "worktree", "add", "--detach",
               sess["worktreePath"]]
        if base_ref:
            cmd.append(base_ref)
        rc, err = run_ok(cmd)
        if rc != 0:
            raise RuntimeError(f"git worktree add failed: {err}")

    def _worktree_remove(self, sess):
        run(["git", "-C", sess["repoPath"], "worktree", "remove",
             "--force", sess["worktreePath"]])
        run(["git", "-C", sess["repoPath"], "worktree", "prune"])

    def _forget_session_caches(self, sid):
        self.sess_state.pop(sid, None)
        self.usage_cache.pop(sid, None)
        self.pending_prs.pop(sid, None)

    def _set_error(self, sess, msg):
        sess["status"] = "error"
        sess["errorMsg"] = str(msg)[:500]
        log(f"session {sess['id']} error: {msg}")

    # --- lifecycle (executed container-side; see CONTRACT) ----------------

    def spawn(self, repo_name, *, prompt=None, label=None, base_ref=None,
              model=None, permission_mode=None):
        """Create a brand-new worktree-backed session for <repo_name>.

        The worktree is added in DETACHED HEAD forked off the latest default
        branch (or an operator-chosen base) — the app creates NO branch; the
        running agent branches its own work when ready. label is presentational:
        it flavors the claude.ai/code display name but agent-<id> tmux stays the
        canonical internal key. The options (base branch, model, permission mode)
        are validated below; a bad option fails the spawn cleanly as an error
        card rather than reaching git/tmux or crashing the manager."""
        if self._running_count() >= MAX_SESSIONS:
            log(f"spawn refused: at MAX_SESSIONS ({MAX_SESSIONS})")
            return
        # A root session runs directly at REPOS_ROOT (no worktree/branch). The
        # base option doesn't apply; only one may run at a time.
        is_root = (repo_name == ROOT_REPO_NAME)
        if is_root:
            if self._root_running():
                log("spawn refused: a root session is already running")
                return
            repo = {"name": ROOT_REPO_NAME, "path": REPOS_ROOT}
        else:
            repo = next((r for r in scan_repos() if r["name"] == repo_name), None)
            if not repo:
                log(f"spawn refused: unknown repo {repo_name!r}")
                return
        sid = self._new_id()
        label = (label or "").strip() or None
        # Prefer a slugged label in the RC display name; fall back to the id.
        rc_slug = slugify(label) if label else ""
        sess = {
            "id": sid,
            "repo": repo["name"],
            "repoPath": repo["path"],
            # Root runs in REPOS_ROOT itself; a repo session gets a fresh worktree.
            "worktreePath": (REPOS_ROOT if is_root
                             else os.path.join(WORKTREES_ROOT, repo["name"], sid)),
            "branch": None,        # app owns no branch; the agent names its own
            "root": is_root,
            "label": label,
            "rcName": f"{slugify(self.device)}-{slugify(repo['name'])}-{rc_slug or sid}",
            "tmuxName": f"agent-{sid}",
            "ttydPort": self._alloc_port(),
            "model": None,                  # resolved --model value (None = omit)
            "permissionMode": "bypassPermissions",
            "baseRef": None,                # base branch the worktree forked from
            "status": "running",
            "createdAt": now_iso(),
            "stoppedAt": None,
            "errorMsg": None,
            "summary": None,       # few-word task name, filled in async at spawn
        }
        self.registry.append(sess)
        try:
            # Validate every interpolated option BEFORE touching git/tmux. Model
            # and permission mode apply to root too; base/worktree don't.
            sess["model"] = resolve_model(model)
            sess["permissionMode"] = resolve_permission_mode(permission_mode)
            resolved_base = None
            if not is_root:
                resolved_base = resolve_base_ref(repo["path"], base_ref)
                sess["baseRef"] = resolved_base
                self._worktree_add(sess, base_ref=resolved_base)
            self._launch_tmux(sess, prompt=(prompt or None))
            self._launch_ttyd(sess)
            # Name the session from its initial prompt, once, in the background
            # (no-op unless enabled / no prompt). Never blocks the spawn.
            self._start_summary(sess, prompt)
            wt = os.path.basename(sess["worktreePath"])
            log(f"spawned session {sid} for {repo['name']} on :{sess['ttydPort']} "
                + ("(root)" if is_root else
                   f"(detached worktree {wt}"
                   + (f", base {resolved_base}" if resolved_base else "")
                   + ")")
                + (f" label {label!r}" if label else ""))
        except Exception as e:
            self._set_error(sess, e)

    def _remember_closed(self, sess):
        """Record a killed session in the closed history so the hub can offer
        to resume it. Bounded: only the newest CLOSED_PER_REPO per repo are
        kept — older records fall off (their branch/transcript still exist,
        they just stop being offered)."""
        rec = {k: sess.get(k) for k in (
            "id", "repo", "repoPath", "worktreePath", "branch", "baseRef",
            "rcName", "tmuxName", "createdAt", "label", "summary", "model",
            "permissionMode", "root",
        )}
        rec["closedAt"] = now_iso()
        self.closed = [c for c in self.closed if c.get("id") != rec["id"]]
        self.closed.append(rec)
        # Trim per repo, newest first (the list is in close order).
        keep, per_repo = [], {}
        for c in reversed(self.closed):
            n = per_repo.get(c.get("repo"), 0)
            if n < CLOSED_PER_REPO:
                per_repo[c.get("repo")] = n + 1
                keep.append(c)
        self.closed = list(reversed(keep))

    def kill(self, sid):
        """Stop a session and drop its registry record so the card disappears
        from the hub — but KEEP its worktree on disk (any uncommitted work
        survives) and its transcript. Recorded in the closed history so the
        repo's "Resume" picker can re-attach to the same worktree with its
        conversation. (Contrast delete(), which removes the worktree too.)"""
        sess = self._find(sid)
        if not sess:
            log(f"kill: no such session {sid}")
            return
        self._kill_tmux(sess)
        self._kill_ttyd(sid)
        # The worktree is deliberately left in place — killing must never lose
        # uncommitted work. (Root has no worktree; nothing to leave either way.)
        self.registry = [s for s in self.registry if s.get("id") != sid]
        self._remember_closed(sess)
        self._forget_session_caches(sid)
        log(f"killed session {sid} ("
            + ("root, no worktree" if sess.get("root")
               else "worktree kept on disk")
            + ", resumable)")

    def start(self, sid):
        """Resume a stopped session: relaunch on the SAME ttyd port in its still-
        present worktree, continuing its prior conversation (fresh only if it
        never had a transcript). If the worktree dir has somehow vanished, re-add
        a detached one off the recorded base as a best-effort recovery."""
        sess = self._find(sid)
        if not sess:
            log(f"start: no such session {sid}")
            return
        if sess.get("status") == "running":
            return
        if self._running_count() >= MAX_SESSIONS:
            log(f"start refused: at MAX_SESSIONS ({MAX_SESSIONS})")
            return
        if sess.get("root") and self._root_running():
            log("start refused: a root session is already running")
            return
        try:
            # Root runs in REPOS_ROOT (always present) — no worktree to re-add.
            # Normally the worktree persists (kill keeps it), so this is skipped.
            if not sess.get("root") and not os.path.isdir(sess["worktreePath"]):
                self._worktree_add(sess, base_ref=sess.get("baseRef"))
            self._launch_tmux(sess, resume=True)
            self._launch_ttyd(sess)
            sess["status"] = "running"
            sess["stoppedAt"] = None
            sess["errorMsg"] = None
            log(f"started (resumed) session {sid} on :{sess['ttydPort']}")
        except Exception as e:
            self._set_error(sess, e)

    def resume(self, sid):
        """Bring back a KILLED session with its conversation: re-register it and
        relaunch claude in its kept worktree, resuming its newest transcript
        (re-adding a detached worktree off the recorded base only if the dir has
        vanished). The record moves out of the closed history; a failure surfaces
        as an error card like any other session."""
        if self._find(sid):
            self.start(sid)  # duplicate resume / already back — treat as start
            return
        rec = next((c for c in self.closed if c.get("id") == sid), None)
        if not rec:
            log(f"resume: no closed session {sid}")
            return
        if self._running_count() >= MAX_SESSIONS:
            log(f"resume refused: at MAX_SESSIONS ({MAX_SESSIONS})")
            return
        if rec.get("root") and self._root_running():
            log("resume refused: a root session is already running")
            return
        sess = {
            "id": sid,
            "repo": rec.get("repo"),
            "repoPath": rec.get("repoPath"),
            "worktreePath": rec.get("worktreePath"),
            "branch": rec.get("branch"),
            "baseRef": rec.get("baseRef"),
            "root": rec.get("root"),
            "label": rec.get("label"),
            "summary": rec.get("summary"),   # keep the auto name across resume
            "rcName": rec.get("rcName"),
            "tmuxName": rec.get("tmuxName") or f"agent-{sid}",
            "ttydPort": self._alloc_port(),  # old port may be taken by now
            "model": rec.get("model"),
            "permissionMode": rec.get("permissionMode") or "bypassPermissions",
            "status": "running",
            "createdAt": rec.get("createdAt") or now_iso(),
            "stoppedAt": None,
            "errorMsg": None,
        }
        self.registry.append(sess)
        self.closed = [c for c in self.closed if c.get("id") != sid]
        try:
            # Root has no worktree to re-add; it resumes in place at REPOS_ROOT.
            # The kept worktree normally still exists, so this is skipped.
            if not sess.get("root") and not os.path.isdir(sess["worktreePath"]):
                self._worktree_add(sess, base_ref=sess.get("baseRef"))
            self._launch_tmux(sess, resume=True)
            self._launch_ttyd(sess)
            log(f"resumed closed session {sid} for {sess['repo']} on :{sess['ttydPort']}")
        except Exception as e:
            self._set_error(sess, e)

    def restart(self, sid):
        """Clear context: kill claude/tmux in place, drop the bridge pointer, and
        relaunch a FRESH claude in the same worktree (new transcript/RC session).
        Keeps id/branch/worktree/ttydPort — ttyd stays up and just re-attaches."""
        sess = self._find(sid)
        if not sess:
            log(f"restart: no such session {sid}")
            return
        if sess.get("status") != "running":
            log(f"restart: session {sid} not running")
            return
        try:
            self._kill_tmux(sess)          # ends the current claude
            self.sess_state.pop(sid, None)  # fresh freshness/PR tracking
            self._launch_tmux(sess)         # drops bridge-pointer + new claude
            self._launch_ttyd(sess)         # (re)ensure ttyd if it had died
            sess["errorMsg"] = None
            log(f"restarted (cleared context) session {sid}")
        except Exception as e:
            self._set_error(sess, e)

    def delete(self, sid):
        """Remove a session entirely: its worktree + registry record. It
        disappears from the UI and its usage stops being reported. The app owns
        no branch, so any branch the running agent named for its work — and thus
        every committed change on it — survives in the repo untouched; only
        uncommitted worktree files are lost (the UI warns before confirming)."""
        sess = self._find(sid)
        if not sess:
            log(f"delete: no such session {sid}")
            return
        self._kill_tmux(sess)
        self._kill_ttyd(sid)
        # Root has no worktree to remove — REPOS_ROOT and its repos stay put;
        # delete just tears down the processes and drops the record.
        if not sess.get("root") and os.path.isdir(sess["worktreePath"]):
            gi = git_info(sess["worktreePath"])
            if gi and gi.get("dirtyFiles"):
                log(f"delete {sid}: discarding {gi['dirtyFiles']} "
                    f"uncommitted worktree file(s)")
            self._worktree_remove(sess)
        self.registry = [s for s in self.registry if s.get("id") != sid]
        # The worktree is gone, so any stale closed record must not offer resume.
        self.closed = [c for c in self.closed if c.get("id") != sid]
        self._forget_session_caches(sid)
        log(f"deleted session {sid}")

    # --- on-demand input/history (glasses client) --------------------------

    def send_input(self, sid, text):
        """Type text into a running session's Claude TUI via tmux send-keys:
        one literal keystroke send (-l — no key-name interpretation, no
        shell) followed by a separate Enter. This is also the path an
        AskUserQuestion answer rides: the glasses client sends the digit
        "1".."4" through this same method (it moves the TUI's selection) and
        the Enter this method sends confirms it in the Remote Control TUI;
        free-text answers go through the same path but are best-effort and
        need on-hardware verification. `--` ends tmux's own option parsing
        before the literal text so a dictated/typed string that happens to
        start with '-' (e.g. "-1 on that idea") isn't misread as more
        send-keys flags; -l still applies to everything after it."""
        sess = self._find(sid)
        if not sess or sess.get("status") != "running":
            return
        text = text.replace("\r\n", " ").replace("\r", " ").replace("\n", " ")
        if not text.strip():
            return
        text = text[:INPUT_MAX_CHARS]
        tmux_name = sess["tmuxName"]
        run(["tmux", "send-keys", "-t", tmux_name, "-l", "--", text])
        run(["tmux", "send-keys", "-t", tmux_name, "Enter"])

    def _stage_history(self, sid):
        """Handle a {type:"history"} command: locate sid's newest transcript
        the same way session_report does and stage a bounded read of it for
        the next heartbeat payload (historyResults). Unknown/killed sessionId
        stages an empty result instead of raising — a poison sessionId must
        not take down the heartbeat loop."""
        sess = self._find(sid)
        path = _newest_transcript_path(sess["worktreePath"]) if sess else None
        if not path:
            self.history_results.append(
                {"sessionId": sid, "entries": [], "truncated": False}
            )
            return
        entries, byte_capped = _history_entries(path)
        truncated = byte_capped or len(entries) > HISTORY_MAX_MSGS
        self.history_results.append({
            "sessionId": sid,
            "entries": entries[-HISTORY_MAX_MSGS:],
            "truncated": truncated,
        })

    # --- GitHub clone-into-root -------------------------------------------

    def refresh_github(self):
        """Refresh the cached GitHub availability/repo-list block. Called on a
        slow cadence from build_payload; degrades to unavailable on any error."""
        try:
            self.github = collect_github()
        except Exception as e:
            log(f"github refresh failed: {e}")
            self.github = {"available": False, "login": None, "repos": []}

    def clone(self, repo_spec):
        """Clone a GitHub repo into REPOS_ROOT so it joins the scanned repo list.

        Launched as a DETACHED subprocess and reaped by _poll_clones on later
        beats — `git clone` can take minutes and must never block the heartbeat
        loop (a blocked loop would make the hub mark the host offline). The spec
        is validated to a bare owner/repo first; the dest is that repo name
        directly under REPOS_ROOT and must not already exist. Auth (private
        repos) rides the system git credential helper (`gh auth git-credential`,
        configured in the image)."""
        raw = (repo_spec or "").strip()
        try:
            owner_repo = normalize_github_repo(raw)
        except ValueError as e:
            key = slugify(raw) or "clone"
            self.clones[key] = {
                "name": key, "repo": raw, "status": "error", "error": str(e),
                "startedAt": now_iso(), "startedMono": time.time(),
                "proc": None, "logf": None, "logPath": None,
            }
            log(f"clone refused: {e}")
            return
        name = owner_repo.split("/")[1]
        dest = os.path.join(REPOS_ROOT, name)
        job = {
            "name": name, "repo": owner_repo, "status": "cloning", "error": None,
            "startedAt": now_iso(), "startedMono": time.time(),
            "proc": None, "logf": None,
            "logPath": os.path.join(REGISTRY_DIR, f"clone-{slugify(name)}.log"),
        }
        self.clones[name] = job
        if os.path.exists(dest):
            job["status"] = "error"
            job["error"] = f"'{name}' already exists under the repos root"
            job["startedMono"] = time.time()
            log(f"clone refused: {job['error']}")
            return
        url = f"https://github.com/{owner_repo}.git"
        try:
            os.makedirs(REGISTRY_DIR, exist_ok=True)
            logf = open(job["logPath"], "w")
            proc = subprocess.Popen(
                ["git", "clone", "--", url, dest],
                stdout=logf, stderr=subprocess.STDOUT,
            )
        except Exception as e:
            job["status"] = "error"
            job["error"] = str(e)
            job["startedMono"] = time.time()
            log(f"clone launch failed for {owner_repo}: {e}")
            return
        job["proc"] = proc
        job["logf"] = logf
        log(f"cloning {owner_repo} into {dest}")

    def _clone_log_tail(self, job):
        try:
            with open(job.get("logPath") or "", errors="replace") as f:
                return f.read()[-400:].strip() or None
        except OSError:
            return None

    def _finish_clone(self, job, status, error):
        try:
            if job.get("logf"):
                job["logf"].close()
        except Exception:
            pass
        job["logf"] = None
        job["proc"] = None
        job["status"] = status
        if error:
            job["error"] = error
        job["finishedMono"] = time.time()
        if status == "done":
            log(f"cloned {job['repo']} -> {job['name']}")
        else:
            log(f"clone failed for {job['repo']}: {job.get('error')}")

    def _poll_clones(self):
        """Reap finished `git clone` subprocesses and drop stale terminal jobs.
        Runs every heartbeat (one poll() per active clone). A done job lingers
        briefly (the repo then appears in the scan); a failed one lingers longer
        so the operator can read the error in the UI."""
        now = time.time()
        for name, job in list(self.clones.items()):
            proc = job.get("proc")
            if proc is not None:
                rc = proc.poll()
                if rc is None:
                    if now - job.get("startedMono", now) > CLONE_TIMEOUT_SEC:
                        try:
                            proc.kill()
                        except Exception:
                            pass
                        self._finish_clone(job, "error", "clone timed out")
                    continue
                if rc == 0 and os.path.isdir(os.path.join(REPOS_ROOT, name, ".git")):
                    self._finish_clone(job, "done", None)
                else:
                    self._finish_clone(
                        job, "error",
                        self._clone_log_tail(job) or f"git clone exited {rc}")
                continue
            # Already terminal — prune once it has lingered long enough.
            linger = CLONE_DONE_LINGER_SEC if job.get("status") == "done" else CLONE_ERROR_LINGER_SEC
            if now - job.get("finishedMono", job.get("startedMono", now)) > linger:
                self.clones.pop(name, None)

    def _clones_payload(self):
        """Serializable view of clone jobs for the heartbeat (no Popen/file)."""
        return [
            {"name": j.get("name"), "repo": j.get("repo"),
             "status": j.get("status"), "error": j.get("error"),
             "startedAt": j.get("startedAt")}
            for j in self.clones.values()
        ]

    # --- session activity summaries ----------------------------------------

    def _start_summary(self, sess, prompt):
        """Kick off a one-shot `claude -p` (Haiku) to name a session from its
        initial prompt, as a DETACHED subprocess reaped by _poll_summaries.
        No-op unless the feature is enabled and there's a prompt to summarize.
        Best-effort: any launch failure just leaves the session unnamed."""
        if not SESSION_SUMMARY_ENABLED:
            return
        prompt = (prompt or "").strip()
        if not prompt:
            return
        sid = sess["id"]
        out_path = os.path.join(REGISTRY_DIR, f"summary-{slugify(sid)}.out")
        try:
            os.makedirs(REGISTRY_DIR, exist_ok=True)
            outf = open(out_path, "w")
            # Headless, text-only. cwd is REGISTRY_DIR (NOT the worktree) and no
            # --settings is passed, so it never loads the session safety guard or
            # explores the repo; a summarization prompt won't invoke tools, and
            # the timeout in _poll_summaries backstops anything that hangs. The
            # command is a list (no shell), so the prompt text can't inject.
            proc = subprocess.Popen(
                ["claude", "-p", "--model", SESSION_SUMMARY_MODEL,
                 SUMMARY_INSTRUCTION + prompt[:SUMMARY_PROMPT_CAP]],
                stdout=outf, stderr=subprocess.DEVNULL, cwd=REGISTRY_DIR,
            )
        except Exception as e:
            log(f"summary launch failed for {sid}: {e}")
            return
        self.summaries[sid] = {
            "proc": proc, "outf": outf, "outPath": out_path,
            "startedMono": time.time(),
        }
        log(f"summarizing session {sid} via claude -p ({SESSION_SUMMARY_MODEL})")

    def _finish_summary(self, sid, job, summary):
        """Tear down a summary job's file handle + temp output and, if we got a
        name, store it on the session record (persisted so it survives beats,
        restarts, and resume)."""
        try:
            if job.get("outf"):
                job["outf"].close()
        except Exception:
            pass
        try:
            if job.get("outPath"):
                os.remove(job["outPath"])
        except OSError:
            pass
        self.summaries.pop(sid, None)
        sess = self._find(sid)
        if sess is None:
            return  # killed/deleted while summarizing — nothing to name
        if summary:
            sess["summary"] = summary
            self.save()
            log(f"named session {sid}: {summary!r}")

    def _poll_summaries(self):
        """Reap finished summary subprocesses (one poll() per active job each
        beat, like _poll_clones): on clean exit, set sess['summary'] from the
        cleaned output; kill + drop any that overran the timeout."""
        now = time.time()
        for sid, job in list(self.summaries.items()):
            proc = job.get("proc")
            rc = proc.poll() if proc else 0
            if rc is None:
                if now - job.get("startedMono", now) > SUMMARY_TIMEOUT_SEC:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                    self._finish_summary(sid, job, None)
                continue
            raw = None
            if rc == 0:
                try:
                    with open(job.get("outPath") or "", errors="replace") as f:
                        raw = f.read()
                except OSError:
                    raw = None
            self._finish_summary(sid, job, clean_summary(raw))

    # --- prune merged branches + safe worktrees ----------------------------

    def _repo_worktrees(self, repo_path):
        """Parse `git worktree list --porcelain` into [{path, head, branch}].
        branch is the short name or None when detached; the main checkout is
        included (callers filter it out by path)."""
        out = run(["git", "-C", repo_path, "worktree", "list", "--porcelain"])
        trees, cur = [], None
        for line in out.splitlines():
            if line.startswith("worktree "):
                cur = {"path": line[len("worktree "):], "head": None, "branch": None}
                trees.append(cur)
            elif cur is None:
                continue
            elif line.startswith("HEAD "):
                cur["head"] = line[len("HEAD "):]
            elif line.startswith("branch "):
                ref = line[len("branch "):]
                cur["branch"] = ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref
        return trees

    def prune_repo(self, repo_name):
        """Sweep a repo's finished work: remove session worktrees whose commits
        are fully merged into the latest default branch (skipping any still
        backing a hub session or holding uncommitted changes), then delete local
        branches merged into that default (this also clears branches whose PR was
        merged and remote deleted). Nothing unmerged or dirty is ever touched, so
        no in-progress work is lost. The summary rides the heartbeat briefly."""
        repo = next((r for r in scan_repos() if r["name"] == repo_name), None)
        if not repo:
            self.prunes[repo_name] = {
                "repo": repo_name, "status": "error", "at": now_iso(),
                "error": f"unknown repo {repo_name!r}", "summary": "unknown repo",
                "finishedMono": time.time()}
            log(f"prune refused: unknown repo {repo_name!r}")
            return
        path = repo["path"]
        default = default_branch_name(path)
        # Refresh remote-tracking refs so "merged into main" reflects upstream.
        if default and valid_ref_name(default):
            run_ok(["git", "-C", path, "fetch", "--prune", "origin"])
        tip = None
        for cand in (f"origin/{default}", default):
            if default and branch_exists(path, cand):
                tip = cand
                break
        if not tip:
            self.prunes[repo_name] = {
                "repo": repo_name, "status": "error", "at": now_iso(),
                "error": "no default branch to compare against",
                "summary": "no default branch — nothing pruned",
                "finishedMono": time.time()}
            log(f"prune {repo_name}: no default branch resolved")
            return

        wt_prefix = os.path.join(WORKTREES_ROOT, repo_name) + os.sep
        live = {s.get("worktreePath") for s in self.registry}
        removed_wt, skipped_wt = 0, 0
        for wt in self._repo_worktrees(path):
            p = wt["path"]
            if not p.startswith(wt_prefix):
                continue                      # main checkout / other repo — leave
            if p in live:
                continue                      # backs a hub session — never touch
            if run(["git", "-C", p, "status", "--porcelain"]):
                skipped_wt += 1               # uncommitted work — keep it
                continue
            head = wt["head"]
            merged = head and run_ok(
                ["git", "-C", path, "merge-base", "--is-ancestor", head, tip])[0] == 0
            if not merged:
                skipped_wt += 1               # unmerged commits — keep it
                continue
            if run_ok(["git", "-C", path, "worktree", "remove", p])[0] == 0:
                removed_wt += 1
                self.closed = [c for c in self.closed
                               if c.get("worktreePath") != p]
            else:
                skipped_wt += 1
        run(["git", "-C", path, "worktree", "prune"])

        # Branches merged into the default tip are safe to delete; exclude the
        # default itself and any branch still checked out in a remaining worktree
        # (git would refuse those anyway). -D is safe here: we verified merged.
        checked_out = {wt["branch"] for wt in self._repo_worktrees(path)
                       if wt.get("branch")}
        merged_out = run(["git", "-C", path, "branch", "--merged", tip,
                          "--format", "%(refname:short)"])
        deleted_br, kept_br = 0, 0
        for b in merged_out.splitlines():
            b = b.strip()
            if not b or b == default or b == tip or b in checked_out:
                continue
            if run_ok(["git", "-C", path, "branch", "-D", b])[0] == 0:
                deleted_br += 1
            else:
                kept_br += 1

        bits = [f"{removed_wt} worktree{'' if removed_wt == 1 else 's'}",
                f"{deleted_br} merged branch{'' if deleted_br == 1 else 'es'}"]
        summary = "removed " + " · ".join(bits)
        if skipped_wt:
            summary += f" · kept {skipped_wt} in-progress worktree" + ("" if skipped_wt == 1 else "s")
        self.prunes[repo_name] = {
            "repo": repo_name, "status": "done", "at": now_iso(),
            "error": None, "summary": summary,
            "removedWorktrees": removed_wt, "deletedBranches": deleted_br,
            "skippedWorktrees": skipped_wt, "finishedMono": time.time()}
        log(f"pruned {repo_name}: {summary}")

    def _poll_prunes(self):
        """Drop prune summaries once they've lingered past their window."""
        now = time.time()
        for repo in list(self.prunes):
            if now - self.prunes[repo].get("finishedMono", now) > PRUNE_RESULT_LINGER_SEC:
                self.prunes.pop(repo, None)

    def _prunes_payload(self):
        return [
            {"repo": j.get("repo"), "status": j.get("status"),
             "error": j.get("error"), "summary": j.get("summary"),
             "at": j.get("at")}
            for j in self.prunes.values()
        ]

    # --- boot auto-resume --------------------------------------------------

    def resume_on_boot(self):
        """Relaunch running sessions whose worktree survived — continuing their
        prior conversation, not a fresh context; demote the rest."""
        for sess in self.registry:
            if sess.get("status") != "running":
                continue  # stopped stays stopped (kept for usage; resumable)
            if not os.path.isdir(sess["worktreePath"]):
                sess["status"] = "stopped"
                sess["stoppedAt"] = now_iso()
                log(f"resume: worktree gone for {sess['id']}, marking stopped")
                continue
            try:
                self._launch_tmux(sess, resume=True)
                self._launch_ttyd(sess)
                log(f"resumed session {sess['id']} on :{sess['ttydPort']}")
                time.sleep(LAUNCH_STAGGER)  # stagger shared-login contention
            except Exception as e:
                self._set_error(sess, e)
        self.save()

    # --- command handling (heartbeat reply) -------------------------------

    def _ack(self, cmd_id):
        if len(self.acked_order) == self.acked_order.maxlen and self.acked_order:
            self.acked.discard(self.acked_order[0])
        self.acked_order.append(cmd_id)
        self.acked.add(cmd_id)

    def handle_commands(self, commands):
        """Execute each not-yet-acked command exactly once. Returns True if any
        ran (the caller then fires an immediate extra heartbeat)."""
        did = False
        for cmd in commands or []:
            if not isinstance(cmd, dict):
                continue
            cid = cmd.get("cmdId")
            if not cid or cid in self.acked:
                continue
            ctype = cmd.get("type")
            try:
                if ctype == "spawn":
                    self.spawn(
                        cmd.get("repo"),
                        prompt=cmd.get("prompt"),
                        label=cmd.get("label"),
                        base_ref=cmd.get("baseRef"),
                        model=cmd.get("model"),
                        permission_mode=cmd.get("permissionMode"),
                    )
                elif ctype == "kill":
                    self.kill(cmd.get("sessionId"))
                elif ctype == "start":
                    self.start(cmd.get("sessionId"))
                elif ctype == "restart":
                    self.restart(cmd.get("sessionId"))
                elif ctype == "resume":
                    self.resume(cmd.get("sessionId"))
                elif ctype == "delete":
                    self.delete(cmd.get("sessionId"))
                elif ctype == "input":
                    self.send_input(cmd.get("sessionId"), cmd.get("text") or "")
                elif ctype == "history":
                    self._stage_history(cmd.get("sessionId"))
                elif ctype == "clone":
                    self.clone(cmd.get("repo"))
                elif ctype == "prune":
                    self.prune_repo(cmd.get("repo"))
                else:
                    log(f"unknown command type {ctype!r} (cmdId {cid})")
            except Exception as e:
                # A poison command must not be retried forever, so we still ack;
                # any per-session failure is surfaced via that session's status.
                log(f"command {ctype} ({cid}) failed: {e}")
            self._ack(cid)
            did = True
        if did:
            self.save()
        return did

    # --- heartbeat ---------------------------------------------------------

    def _refresh_usage(self, sid, worktree):
        try:
            self.usage_cache[sid] = usage_report(worktree)
        except Exception as e:
            log(f"usage parse failed for {sid}: {e}")

    def _session_payload(self, sess):
        sid = sess["id"]
        running = sess.get("status") == "running"
        signals = None
        if running:
            try:
                st = self.sess_state.setdefault(sid, {})
                signals = session_report(sess["worktreePath"], st)
                pend = self.pending_prs.setdefault(sid, [])
                pend.extend(signals.pop("prUrls"))
                del pend[:-10]
                signals["newPrUrls"] = list(pend)
            except Exception as e:
                log(f"session probe failed for {sid}: {e}")
                signals = None
        gi = git_info(sess["worktreePath"])  # of the worktree (None if gone)
        # The app owns no branch, so the branch to report is the LIVE one the
        # running agent named for its work ("HEAD" = still detached, not yet
        # branched -> no branch to sync). Compare it against what the session
        # forked from (baseRef, e.g. origin/main), falling back to the repo's
        # current checkout when we didn't record a base.
        live_branch = gi.get("branch") if gi else None
        if live_branch == "HEAD":
            live_branch = None
        base = sess.get("baseRef") or run(
            ["git", "-C", sess["repoPath"], "rev-parse", "--abbrev-ref", "HEAD"])
        return {
            "id": sid,
            "repo": sess["repo"],
            "repoPath": sess["repoPath"],
            "worktreePath": sess["worktreePath"],
            "branch": sess["branch"],           # app branch: always None now
            "root": sess.get("root", False),
            "rcName": sess["rcName"],
            "label": sess.get("label"),
            "summary": sess.get("summary"),   # few-word auto task name (or None)
            "model": sess.get("model"),
            "permissionMode": sess.get("permissionMode"),
            "baseRef": sess.get("baseRef"),
            "status": sess.get("status"),
            "ttydPort": sess.get("ttydPort"),
            "createdAt": sess.get("createdAt"),
            "stoppedAt": sess.get("stoppedAt"),
            "errorMsg": sess.get("errorMsg"),
            "git": gi,
            # The live branch's relation to its base/origin, computed from the
            # shared repo so it's reported even for a stopped session. Empty
            # while the agent is still on detached HEAD (no branch to sync).
            "work": branch_sync(sess["repoPath"], live_branch, base or None),
            "usage": self.usage_cache.get(sid),     # present for stopped too
            "session": signals,                      # running only; null otherwise
        }

    def _closed_payload(self):
        """Killed-but-resumable sessions for the hub's per-repo Resume picker,
        newest first. Already capped at CLOSED_PER_REPO per repo, so this can
        never balloon the heartbeat."""
        return [
            {
                "id": c.get("id"),
                "repo": c.get("repo"),
                "branch": c.get("branch"),
                "worktreePath": c.get("worktreePath"),
                "root": c.get("root", False),
                "rcName": c.get("rcName"),
                "label": c.get("label"),
                "summary": c.get("summary"),
                "createdAt": c.get("createdAt"),
                "closedAt": c.get("closedAt"),
            }
            for c in reversed(self.closed)
        ]

    def build_payload(self, beat):
        # Usage is the expensive parse — refresh on a slow cadence, but make
        # sure any newly-seen session gets a value on first appearance.
        if beat % USAGE_EVERY == 0:
            for s in self.registry:
                self._refresh_usage(s["id"], s["worktreePath"])
        for s in self.registry:
            if s["id"] not in self.usage_cache:
                self._refresh_usage(s["id"], s["worktreePath"])

        # GitHub availability/repo list refreshes on its own slow cadence (a few
        # gh calls); clone jobs are reaped every beat (cheap poll()s).
        if beat % GITHUB_REFRESH_EVERY == 0:
            self.refresh_github()
        self._poll_clones()
        self._poll_prunes()
        self._poll_summaries()

        payload = {
            # `device` (the physical host name) is the hub's identity key; agentId
            # is only a last-resort fallback if the host name can't be read.
            "agentId": self.agent_id,
            "device": self.device,
            "startedAt": self.started_at,
            "claudeVersion": self.claude_version,
            "memory": memory_usage(),
            "logTail": log_tail(self.agent_id),
            "reposRoot": REPOS_ROOT,
            "repos": [root_repo_entry()] + [repo_entry(r) for r in scan_repos()],
            "sessions": [self._session_payload(s) for s in self.registry],
            "closedSessions": self._closed_payload(),
            # GitHub clone-into-root: availability + clonable repos for the hub's
            # clone control, and any in-flight/recent clone jobs.
            "github": self.github,
            "clones": self._clones_payload(),
            "prunes": self._prunes_payload(),
            "ackedCommands": list(self.acked),
        }
        # Purely additive, and only present when something is staged — mirrors
        # how pending_prs stays out of a session's payload until there's
        # something to report.
        if self.history_results:
            payload["historyResults"] = list(self.history_results)
        return payload

    def _clear_pending_prs(self):
        for urls in self.pending_prs.values():
            urls.clear()

    def post(self, payload):
        """POST one heartbeat. Returns the parsed reply dict, or None on failure
        (pending PR links are kept so they aren't lost on a failed beat)."""
        try:
            # Explicit User-Agent: HUB_URL rides the Cloudflare tunnel, and
            # Cloudflare's Browser Integrity Check 403s (error 1010) the default
            # "Python-urllib/3.x" signature before it reaches the hub.
            headers = {"Content-Type": "application/json", "User-Agent": "hub-agent/1.0"}
            if HUB_TOKEN:
                headers["Authorization"] = f"Bearer {HUB_TOKEN}"
            req = urllib.request.Request(
                f"{HUB_URL}/api/heartbeat",
                data=json.dumps(payload).encode(),
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                reply = json.loads(resp.read().decode() or "{}")
            self._clear_pending_prs()  # delivered
            self.history_results.clear()  # delivered — same lifecycle
            return reply if isinstance(reply, dict) else {}
        except Exception as e:
            log(f"heartbeat failed: {e}")
            return None

    def run_forever(self):
        log(
            f"reporting to {HUB_URL} as {self.device} (container {self.agent_id}); "
            f"reposRoot={REPOS_ROOT} maxSessions={MAX_SESSIONS}"
        )
        # SIGUSR1 = "the hub queued a command for you — beat now" (sent by
        # tunnel-agent.js on a control-channel poke). Default disposition of
        # SIGUSR1 is to terminate, so this must be installed before the tunnel
        # can poke; run_forever is the main thread, where signal handlers must
        # be set.
        signal.signal(signal.SIGUSR1, lambda *_: _poke.set())
        self.resume_on_boot()
        beat = 0
        while True:
            # Clear before the beat so a poke that lands *during* it (a command
            # queued while we're mid-cycle) still shortens the next wait rather
            # than being swallowed.
            _poke.clear()
            reply = self.post(self.build_payload(beat))
            beat += 1
            if reply is not None:
                if self.handle_commands(reply.get("commands")):
                    # Fire an immediate extra heartbeat so the UI reflects the
                    # new session state fast (don't wait a whole interval). Its
                    # reply is processed once more; cmdId de-dup stops repeats.
                    reply2 = self.post(self.build_payload(beat))
                    beat += 1
                    if reply2 is not None:
                        self.handle_commands(reply2.get("commands"))
            # Interruptible sleep: returns immediately if a poke arrived, else
            # after the normal interval.
            _poke.wait(INTERVAL)


def main():
    SessionManager().run_forever()


if __name__ == "__main__":
    # entrypoint.sh calls this to resolve the host name once and export it. The
    # "DEVICE_NAME=" prefix lets the caller sed it out cleanly, ignoring the
    # module-level boot logs that also land on stdout.
    if "--print-device" in sys.argv:
        print("DEVICE_NAME=" + device_name())
        sys.exit(0)
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
