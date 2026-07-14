#!/usr/bin/env python3
"""Session manager + heartbeat agent for the turma dashboard.

ONE of these runs per physical host (started by entrypoint.sh, in the
FOREGROUND — it is the container's long-lived process). It replaces the old
"one container = one repo = one Claude session" model with a host-level
multiplexer:

  - Scans REPOS_ROOT (default /mnt/data/Docker/git) one level deep for git
    repos and reports them to the hub.
  - Owns a persisted session registry (~/.turma/sessions.json). Each session
    is a git *worktree* of a repo in DETACHED HEAD (the app creates no branch;
    the running agent branches its own work when ready) forked off the latest
    default branch, running its own `claude --remote-control` inside its own tmux
    (agent-<id>) served by its own ttyd (127.0.0.1:<ttydPort>, base /term/<id>).
  - Executes hub-issued commands (spawn / kill / start / restart / delete /
    resume) that ride back on the heartbeat reply, with at-least-once cmdId
    de-dup.
  - Auto-resumes `running` sessions on boot — WITH their conversation
    (claude --resume against the worktree's newest transcript).
  - Remembers killed sessions (~/.turma/closed.json, newest 5 per repo) so
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
AskUserQuestion (surfaced by the ask.py PreToolUse bridge as a request file
under QUESTIONS_DIR while the question blocks; a transcript scan is a fallback
for the already-answered case), and PR URLs newly appended to the transcript.

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
import urllib.parse
import urllib.request
import zlib
from collections import deque

# Set by a SIGUSR1 handler (installed in run_forever). tunnel-agent.js sends
# SIGUSR1 when the hub pokes it over the control channel because a command was
# just queued, so the heartbeat loop cuts its interval sleep short and delivers
# that command in the next beat's reply instead of up to a whole INTERVAL
# later. A threading.Event lets the loop wait interruptibly (plain time.sleep
# wouldn't wake on the signal).
_poke = threading.Event()

TURMA_URL = os.environ.get("TURMA_URL", "http://turma:8300")
# Bearer token for the hub's /api/heartbeat (the UI itself sits behind basic
# auth; this lets agents report without those user credentials). Must match
# the hub's TURMA_AGENT_TOKEN.
TURMA_TOKEN = os.environ.get("TURMA_TOKEN", "")
INTERVAL = int(os.environ.get("TURMA_INTERVAL", "20"))

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

# Usage bucket for a transcript on disk that reconciliation can't attribute to
# any repo (a bare `claude` run outside a managed worktree). Parenthesized like
# ROOT_REPO_NAME so it never collides with a real repo name, and so every
# transcript still counts toward the host total rather than being dropped.
OTHER_REPO_NAME = "(other)"

# Where worktrees live: under a dot-dir so the repo scan never lists them, and
# on the mounted tree so they survive a container restart.
WORKTREES_ROOT = os.path.join(REPOS_ROOT, ".turma", "worktrees")
# Persisted session registry (survives container restart).
REGISTRY_DIR = os.path.expanduser("~/.turma")
REGISTRY_PATH = os.path.join(REGISTRY_DIR, "sessions.json")
# Rendezvous dir for the AskUserQuestion bridge (agent/hooks/ask.py). A pending
# question lives here as `<sessionId>.req.json`; the answer the glasses client
# sends rides back as `<sessionId>.ans.json`. See _hook_question / answer_question.
QUESTIONS_DIR = os.path.join(REGISTRY_DIR, "questions")
# Killed-but-resumable session history (branch + transcript survive a kill).
CLOSED_PATH = os.path.join(REGISTRY_DIR, "closed.json")
# Only the newest N closed sessions per repo are kept/offered for resume —
# bounds both the file and the heartbeat payload.
CLOSED_PER_REPO = 5
# Newest N resumable transcripts offered per repo in the "Resume any session"
# picker — bounds the heartbeat (the durable archive holds the full history).
RESUMABLE_PER_REPO = 15
# Durable worktree-path -> {repo, remote, slug} attribution ledger. Written at
# spawn and NEVER dropped on kill/delete, so a transcript's token usage stays
# traceable to its repo long after the session (and even its worktree) is gone.
# This is what makes host/repo usage persist regardless of active sessions.
USAGE_LEDGER_PATH = os.path.join(REGISTRY_DIR, "repo-usage.json")
# Where Claude Code keeps per-project transcript JSONLs (slug = cwd via
# _project_slug below). Overridable so the test suite can point it at
# fixtures; unset in production, so the default is the real path.
PROJECTS_ROOT = os.environ.get("CLAUDE_PROJECTS_ROOT", "/root/.claude/projects")

# Archive sync: ship INACTIVE-session transcripts to the hub's durable, searchable
# store (see turma/archive.js). The agent enumerates ended transcripts, and pushes
# each as append-only byte-range deltas the hub asks for (via the archiveHave map on
# the heartbeat reply). Bounded so a big backfill trickles in rather than flooding
# the tunnel or blocking a beat.
ARCHIVE_MANIFEST_MAX = int(os.environ.get("ARCHIVE_MANIFEST_MAX", "200"))
ARCHIVE_CHUNK_BYTES = 1 << 23   # 8 MiB read+POST per delta
ARCHIVE_BEAT_BUDGET = 1 << 25   # ~32 MiB pushed per sync pass (backfill throttle)


def _project_slug(path):
    """Claude Code's project-dir slug for a cwd: EVERY non-alphanumeric
    character becomes '-', not just '/'. The worktree paths this agent
    manages always contain a dot (REPOS_ROOT/.turma/worktrees/<id>), so
    the old '/'->'-' mapping produced '-.turma-' where Claude writes
    '--turma-' — every transcript lookup missed, silently blanking
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
# Rich-block caps (native chat UI). _entry_blocks() preserves the thinking,
# tool_use inputs and tool_result outputs that _entry_text() flattens away, so
# the web chat can show/hide each component by verbosity. The live tail
# (tunnel-agent.js) pushes these ~1s, so it uses the tight LIVE caps; on-demand
# `history` uses the looser FULL caps so an "Expand" reveals genuinely more. A
# block cut to its cap is flagged truncated:true. Keep these mirrored in
# tunnel-agent.js.
BLOCK_TEXT_CHARS = int(os.environ.get("SESSION_BLOCK_TEXT_CHARS", "4000"))
BLOCK_TOOL_INPUT_CHARS = int(os.environ.get("SESSION_BLOCK_TOOL_INPUT_CHARS", "1000"))
BLOCK_TOOL_RESULT_CHARS = int(os.environ.get("SESSION_BLOCK_TOOL_RESULT_CHARS", "2000"))
BLOCK_TEXT_CHARS_FULL = int(os.environ.get("SESSION_BLOCK_TEXT_CHARS_FULL", "16000"))
BLOCK_TOOL_INPUT_CHARS_FULL = int(os.environ.get("SESSION_BLOCK_TOOL_INPUT_CHARS_FULL", "4000"))
BLOCK_TOOL_RESULT_CHARS_FULL = int(os.environ.get("SESSION_BLOCK_TOOL_RESULT_CHARS_FULL", "8000"))
# Defensive per-entry block cap so one pathological turn can't blow the tail
# frame (each block is already char-capped above).
BLOCK_MAX_PER_ENTRY = int(os.environ.get("SESSION_BLOCK_MAX_PER_ENTRY", "48"))
BLOCK_CAPS_LIVE = {
    "text": BLOCK_TEXT_CHARS,
    "input": BLOCK_TOOL_INPUT_CHARS,
    "result": BLOCK_TOOL_RESULT_CHARS,
}
BLOCK_CAPS_FULL = {
    "text": BLOCK_TEXT_CHARS_FULL,
    "input": BLOCK_TOOL_INPUT_CHARS_FULL,
    "result": BLOCK_TOOL_RESULT_CHARS_FULL,
}
# Terminal color/cursor codes sometimes make it into pasted transcript text;
# strip them so the glasses client only ever sees plain text.
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")
# Glasses-client on-demand commands: how much typed text `input` accepts per
# call, and how many surviving messages an on-demand `history` request returns
# (independent of the per-heartbeat TAIL_MSGS above).
INPUT_MAX_CHARS = int(os.environ.get("SESSION_INPUT_MAX_CHARS", "4000"))
HISTORY_MAX_MSGS = int(os.environ.get("SESSION_HISTORY_MSGS", "200"))

# Transcript parsing is the expensive part; refresh each session's usage every N
# heartbeats — but staggered (see _usage_slot) so they don't all reparse on the
# same beat. The same cadence gates the slow-changing git-fact cache.
USAGE_EVERY = 15


def _usage_slot(sid):
    """Stable per-session beat-slot in [0, USAGE_EVERY): the session refreshes
    its usage on beats where `beat % USAGE_EVERY == _usage_slot(sid)`, spreading
    the transcript re-parses across the window. A stable hash (crc32, not the
    salted builtin hash()) keeps the slot reproducible across runs."""
    return zlib.crc32(sid.encode()) % USAGE_EVERY
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


def run_ok(cmd, cwd=None, timeout=30):
    """Run a command, return (rc, stderr). rc is None if it couldn't launch.
    `timeout` is capped short (FETCH_TIMEOUT_SEC) for the network `git fetch`es
    that run on the heartbeat loop's critical path, so a slow remote can't stall
    the loop long enough for the hub to mark the host offline."""
    try:
        out = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout
        )
        return out.returncode, (out.stderr or "").strip()
    except Exception as e:
        return None, str(e)


# Short bound for the two network `git fetch`es that run synchronously inside a
# command handler on the main heartbeat loop (default_base_ref on spawn,
# prune_repo). A fetch is best-effort — both already fall open to local refs —
# so capping it can only make the loop more responsive, never less correct.
FETCH_TIMEOUT_SEC = 8


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
# Permission modes the UI offers. "auto" is the default (claude's classifier-
# gated hands-off mode); "bypassPermissions" disables prompts entirely; "default"
# means "omit --permission-mode" (claude's own manual-review default).
PERMISSION_MODES = {"auto", "bypassPermissions", "acceptEdits", "plan", "default"}
# Claude Code's Shift+Tab permission-mode cycle. The three BASE modes are always
# present, in this order; each Shift+Tab press advances one step and wraps at the
# end. The two OPTIONAL modes are conditional: `bypassPermissions` is in the cycle
# only when the session was launched into it, and `auto` only when the launch /
# account enables it — so the cycle a *running* session actually exposes depends
# on how that session was launched. Computing presses against a fixed all-modes
# list therefore lands on the wrong mode (the whole point of `perm_cycle_for`).
PERM_CYCLE_BASE = ["default", "acceptEdits", "plan"]
PERM_CYCLE_OPTIONAL = ["bypassPermissions", "auto"]  # canonical trailing order
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
    # Best-effort, short-bounded: this runs on the main loop at spawn time, so a
    # slow remote must not stall the heartbeat (offline/no-remote just falls back).
    run_ok(["git", "-C", repo_path, "fetch", "origin", name],
           timeout=FETCH_TIMEOUT_SEC)
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
    auto (claude's classifier-gated hands-off default)."""
    mode = (mode or "").strip()
    if not mode:
        return "auto"
    if mode in PERMISSION_MODES:
        return mode
    raise ValueError(f"unknown permission mode {mode!r}")


def perm_cycle_for(launch_mode):
    """The ordered Shift+Tab permission-mode cycle a running session actually
    exposes, given the mode it was LAUNCHED into. The three base modes are always
    present; an optional mode (bypassPermissions / auto) is included only when the
    session was launched into it — that's the one optional we can be certain sits
    in this session's live cycle (bypassPermissions appears solely when claude was
    started with it; auto only when the launch/account enables it). Appended in
    Claude Code's canonical trailing order. `set_mode` computes its BTab presses
    against this so the switch lands on the chosen mode instead of drifting off a
    cycle that doesn't contain the target."""
    cycle = list(PERM_CYCLE_BASE)
    launch_mode = launch_mode or "auto"
    for opt in PERM_CYCLE_OPTIONAL:
        if launch_mode == opt:
            cycle.append(opt)
    return cycle


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

# Operator-supplied extra permissions. Claude Code does NOT read a *user-level*
# ~/.claude/settings.local.json — it only honors settings.local.json at the
# PROJECT level — so any allow/deny an operator puts there is silently dropped
# from every session. We already inject a --settings file that IS merged into
# each session, so we fold that file's permissions.allow/deny into it and the
# operator's pre-approvals take effect. Only the permissions block is consumed
# (not arbitrary keys), keeping this narrow and predictable.
USER_LOCAL_SETTINGS = os.path.join(
    os.path.expanduser("~"), ".claude", "settings.local.json"
)


def operator_local_permissions(path=None):
    """Best-effort read of permissions.allow / permissions.deny from the
    operator's user-level ~/.claude/settings.local.json (a file Claude Code
    itself ignores). Returns (allow, deny): de-duplicated, order-preserving
    lists of strings. Fails open to ([], []) on a missing/malformed file or any
    non-list / non-string content."""
    path = path or USER_LOCAL_SETTINGS
    try:
        with open(path, "r", encoding="utf-8") as fh:
            perms = json.load(fh).get("permissions", {})
    except (OSError, ValueError, AttributeError):
        return [], []
    if not isinstance(perms, dict):
        return [], []

    def clean(key):
        val = perms.get(key)
        if not isinstance(val, list):
            return []
        seen, out = set(), []
        for item in val:
            if isinstance(item, str) and item not in seen:
                seen.add(item)
                out.append(item)
        return out

    return clean("allow"), clean("deny")


def guard_script_path():
    """Absolute path to the bundled PreToolUse guard hook. Resolves correctly
    both in the repo (``agent/hooks/guard.py``) and in the image
    (``/usr/local/bin/hooks/guard.py``), since guard.py sits in a ``hooks/``
    dir next to this file in both layouts."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks", "guard.py")


def ask_script_path():
    """Absolute path to the bundled AskUserQuestion bridge hook (``hooks/ask.py``),
    resolved the same way as ``guard_script_path``."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks", "ask.py")


# The ask.py bridge blocks the AskUserQuestion tool call while it waits for the
# glasses answer, so its Claude-Code hook timeout must comfortably exceed the
# bridge's own per-question block (TURMA_QUESTION_TIMEOUT_SEC, default 600) or
# Claude would kill the hook first. A little headroom over the 600s default.
ASK_HOOK_TIMEOUT_SEC = 660


def build_guard_settings(python_exe=None, guard_path=None, ask_path=None,
                         local_settings_path=None):
    """Build the dict passed to ``claude --settings``: ``PreToolUse`` hooks over
    Bash (the safety guard) and AskUserQuestion (the glasses answer bridge),
    plus deny rules protecting the host credential stores. The bypass-mode
    session runs freely except for what the guard blocks (see ``hooks/guard.py``);
    the ask bridge routes interactive questions to the glasses (see
    ``hooks/ask.py``).

    Also folds in the operator's user-level ~/.claude/settings.local.json
    permissions.allow/deny (which Claude Code itself ignores) so their
    pre-approvals reach every session. The guard's own credential-store deny
    rules are always present and can't be dropped by that file."""
    python_exe = python_exe or sys.executable or "python3"
    guard_path = guard_path or guard_script_path()
    ask_path = ask_path or ask_script_path()
    guard_command = f'"{python_exe}" "{guard_path}"'
    ask_command = f'"{python_exe}" "{ask_path}"'
    allow, deny = operator_local_permissions(local_settings_path)
    perms = {"deny": list(_GUARD_DENY_PATH_RULES)}
    for rule in deny:  # operator deny unions on top of the guard's own rules
        if rule not in perms["deny"]:
            perms["deny"].append(rule)
    if allow:
        perms["allow"] = allow
    return {
        "permissions": perms,
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Bash",
                    "hooks": [{"type": "command", "command": guard_command}],
                },
                {
                    "matcher": "AskUserQuestion",
                    "hooks": [{
                        "type": "command",
                        "command": ask_command,
                        "timeout": ASK_HOOK_TIMEOUT_SEC,
                    }],
                },
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


def git_info_cheap(cwd):
    """Fast, fast-changing worktree facts read EVERY heartbeat: the current
    checked-out branch and the `git status --porcelain` dirty count. None when
    `cwd` is no longer a git worktree (e.g. removed). The slow-changing facts
    (repo name, remote URL, last-commit line) are read separately and cached
    across beats — see git_info_slow / SessionManager._session_git."""
    if not run(["git", "rev-parse", "--git-dir"], cwd=cwd):
        return None
    dirty = run(["git", "status", "--porcelain"], cwd=cwd)
    return {
        "branch": run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=cwd),
        "dirtyFiles": len(dirty.splitlines()) if dirty else 0,
    }


def git_info_slow(cwd):
    """Slow-changing worktree facts, cached across beats: the repo name (from the
    remote ".../xerktech/DockerOps.git" -> "DockerOps", else the checkout's dir),
    the origin remote URL, and the newest-commit line. {} when `cwd` isn't a git
    worktree."""
    if not run(["git", "rev-parse", "--git-dir"], cwd=cwd):
        return {}
    remote = run(["git", "remote", "get-url", "origin"], cwd=cwd)
    name = remote.rstrip("/").rsplit("/", 1)[-1].removesuffix(".git")
    if not name:
        top = run(["git", "rev-parse", "--show-toplevel"], cwd=cwd)
        name = os.path.basename(top) if top else ""
    return {
        "repoName": name,
        "lastCommit": run(["git", "log", "-1", "--format=%h %s"], cwd=cwd)[:120],
        "remote": remote,
    }


def git_info(cwd):
    """Full worktree facts (cheap + slow merged) — same shape as before the
    cheap/slow split. Used off the heartbeat's hot path (root pseudo-repo entry,
    the delete dirty-file check); the per-session heartbeat path reads the two
    halves separately so it can cache the slow one."""
    cheap = git_info_cheap(cwd)
    if cheap is None:
        return None
    info = git_info_slow(cwd)
    info.update(cheap)
    return info


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


def _usage_bucket():
    return {"input": 0, "output": 0, "cacheWrite": 0, "cacheRead": 0, "cost": 0.0}


class _UsageAcc:
    """Mutable accumulator folded over one or more Claude project dirs. Kept
    separate from the public report shape so several worktrees' transcripts can
    be aggregated into one repo total (share one `seen` set so a message can't
    double-count across a repo's worktrees). A per-slug instance is also carried
    across beats for the incremental parse (see _aggregate_project)."""

    def __init__(self):
        self.totals = _usage_bucket()
        self.days = {}      # "YYYY-MM-DD" (UTC) -> bucket
        self.models = {}    # model id -> message count
        self.unpriced = set()
        self.seen = set()   # (message id, requestId) dedup keys
        self.last_ts = ""
        self.sessions = 0   # transcript files folded in


def _accumulate_usage(lines, acc):
    """Fold transcript JSONL lines into `acc` in place. Only lines that mention a
    usage block cost anything; each priced message is deduped on
    (message id, requestId) via acc.seen, so a message re-seen across files or
    across incremental beats counts exactly once."""
    for line in lines:
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
        if key[0] and key in acc.seen:
            continue
        acc.seen.add(key)

        ts = entry.get("timestamp") or ""
        if ts > acc.last_ts:
            acc.last_ts = ts
        model = msg.get("model") or "unknown"
        acc.models[model] = acc.models.get(model, 0) + 1

        tok = (
            usage.get("input_tokens", 0) or 0,
            usage.get("output_tokens", 0) or 0,
            usage.get("cache_creation_input_tokens", 0) or 0,
            usage.get("cache_read_input_tokens", 0) or 0,
        )
        # Built-in table first (authoritative); PRICING_EXTRA only covers
        # models the built-ins don't match.
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
        # An unpriced model costs $0.00 — flag every bucket it lands in so the
        # UI never understates cost silently.
        is_unpriced = price is None and any(tok)
        if is_unpriced:
            acc.unpriced.add(model)
        buckets = [acc.totals]
        # Transcript timestamps are UTC ISO; date-prefix bucketing is close
        # enough for a dashboard.
        if len(ts) >= 10:
            buckets.append(acc.days.setdefault(ts[:10], _usage_bucket()))
        for b in buckets:
            b["input"] += tok[0]
            b["output"] += tok[1]
            b["cacheWrite"] += tok[2]
            b["cacheRead"] += tok[3]
            b["cost"] += cost
            if is_unpriced:
                b["unpriced"] = True


def _aggregate_project(proj, acc, offsets=None):
    """Fold one Claude project dir's transcript token usage into `acc`.

    With an `offsets` dict {filename: byte-offset} this parses INCREMENTALLY:
    only bytes appended since the last call are read, and each offset advances
    only to a newline boundary, so an entry still mid-write at a beat boundary
    is re-read whole next beat rather than split. Returns False — without
    counting anything more — when a tracked file shrank or vanished (its
    already-counted bytes can't be un-counted), signalling the caller to rebuild
    from a fresh acc. With `offsets=None` it does a plain full read (tests /
    one-shot callers) and always returns True. Silently no-ops on a
    missing/unreadable dir (the source of truth is best-effort)."""
    try:
        files = [f for f in os.listdir(proj) if f.endswith(".jsonl")]
    except OSError:
        return True
    if offsets is not None:
        # A tracked transcript that shrank/disappeared can't be reconciled
        # incrementally — tell the caller to start this slug's acc over.
        present = set(files)
        for f, off in offsets.items():
            path = os.path.join(proj, f)
            try:
                size = os.stat(path).st_size
            except OSError:
                size = -1
            if f not in present or size < off:
                return False
    for fname in files:
        path = os.path.join(proj, fname)
        if offsets is None:
            try:
                with open(path, errors="replace") as fh:
                    _accumulate_usage(fh, acc)
            except OSError:
                continue
            continue
        try:
            size = os.stat(path).st_size
        except OSError:
            continue
        start = offsets.get(fname, 0)
        if size <= start:
            offsets[fname] = size
            continue
        try:
            with open(path, "rb") as fh:
                fh.seek(start)
                chunk = fh.read(size - start)
        except OSError:
            continue
        # Consume only whole lines; leave any trailing partial (an in-progress
        # write) for a later beat, so the offset always sits on a line boundary.
        nl = chunk.rfind(b"\n")
        if nl < 0:
            continue
        _accumulate_usage(
            chunk[:nl + 1].decode(errors="replace").splitlines(), acc)
        offsets[fname] = start + nl + 1
    # `sessions` is a display stat (transcript files folded in). A persistent
    # per-slug acc holds just its own slug's file count (set, since the acc
    # outlives the call); the full-read path accumulates across the several dirs
    # a caller may fold into one acc.
    if offsets is None:
        acc.sessions += len(files)
    else:
        acc.sessions = len(files)
    return True


def _finalize_usage(acc):
    """Snapshot the running accumulator into the heartbeat's usage shape. Rounds
    into COPIES so the accumulator keeps its raw floats — rounding in place would
    drift the running total a little more every incremental beat, and the same
    per-slug acc is reused across beats and merged into repo/host totals."""
    totals = dict(acc.totals)
    totals["cost"] = round(totals["cost"], 2)
    days = {d: dict(acc.days[d]) for d in sorted(acc.days)[-HISTORY_DAYS:]}
    for day in days.values():
        day["cost"] = round(day["cost"], 2)
    today = days.get(time.strftime("%Y-%m-%d"), _usage_bucket())
    return {
        "totals": totals,
        "today": today,
        "days": days,
        "sessions": acc.sessions,
        "lastActivity": acc.last_ts,
        "models": sorted(acc.models, key=acc.models.get, reverse=True),
        # Models whose usage no pricing entry matched (their cost counted as
        # $0.00) — the UI flags any figure that includes them.
        "unpricedModels": sorted(acc.unpriced),
    }


def usage_report(workdir):
    """Aggregate token usage for one session's project (its worktree cwd) from
    the transcript JSONLs, full-parse. Returns None when the project dir doesn't
    exist. The live heartbeat parses incrementally instead (the manager's
    _fold_slug); this full parse stays for tests and one-shot callers."""
    proj = os.path.join(PROJECTS_ROOT, _project_slug(workdir))
    if not os.path.isdir(proj):
        return None
    acc = _UsageAcc()
    _aggregate_project(proj, acc)
    return _finalize_usage(acc)


def _merge_acc(dst, src):
    """Fold accumulator `src` into `dst` (pre-finalize, so costs stay full
    precision). Buckets are copied by value, so later finalizing one side never
    disturbs the other, and `src` (a persistent per-slug acc) is left intact."""
    for k in ("input", "output", "cacheWrite", "cacheRead", "cost"):
        dst.totals[k] += src.totals[k]
    if src.totals.get("unpriced"):
        dst.totals["unpriced"] = True
    for d, b in src.days.items():
        tgt = dst.days.setdefault(d, _usage_bucket())
        for k in ("input", "output", "cacheWrite", "cacheRead", "cost"):
            tgt[k] += b[k]
        if b.get("unpriced"):
            tgt["unpriced"] = True
    for m, c in src.models.items():
        dst.models[m] = dst.models.get(m, 0) + c
    dst.unpriced |= src.unpriced
    dst.seen |= src.seen
    dst.sessions += src.sessions
    if src.last_ts > dst.last_ts:
        dst.last_ts = src.last_ts


def normalize_remote(remote):
    """Stable cross-host identity for a git origin URL, so the same repo cloned
    on several hosts unifies. Drops scheme, credentials, user@, :port, trailing
    slash and .git, then lowercases — collapsing e.g.
    git@github.com:Xerk/DockerOps.git and https://github.com/Xerk/DockerOps to
    github.com/xerk/dockerops. Empty string when there's no remote."""
    if not remote:
        return ""
    r = remote.strip()
    m = re.match(r"^[\w.+-]+@([^:/]+):(.+)$", r)  # scp-like git@host:owner/repo
    if m:
        r = m.group(1) + "/" + m.group(2)
    else:
        r = re.sub(r"^[a-zA-Z][\w.+-]*://", "", r)  # strip scheme
        r = re.sub(r"^[^/@]+@", "", r)              # strip user[:pass]@ creds
    r = re.sub(r":\d+/", "/", r, count=1)           # strip :port after host
    r = r.rstrip("/")
    if r.endswith(".git"):
        r = r[:-4]
    return r.lower()


def _usage_is_empty(report):
    t = report["totals"]
    return not any(t.get(k) for k in ("input", "output", "cacheWrite", "cacheRead"))


def _repo_from_worktree_slug(slug):
    """Recover the repo name from a worktree's project slug when the worktree
    itself is gone (so _existing_worktree_attrib can't map it and its git
    origin can't be read). Agent worktrees live at .../worktrees/<repo>/<id>,
    whose slug ends ...-worktrees-<repo>-<id> (id = the short session id) — true
    for Turma's own .turma/worktrees and any sibling tool's worktrees dir alike,
    so the whole fleet's history attributes to a named repo rather than a
    catch-all bucket. Returns the (slugified) repo name, or None when the slug
    carries no worktrees marker (a bare `claude` run outside a managed
    worktree). rpartition keeps repo names that themselves contain a slugified
    '-'; only the trailing <id> segment is dropped."""
    marker = "-worktrees-"
    i = slug.rfind(marker)
    if i < 0:
        return None
    repo, _, _sid = slug[i + len(marker):].rpartition("-")
    return repo or None


def repo_usage_report(ledger, fold_slug):
    """Aggregate token usage per repo across ALL known worktree transcripts, plus
    a merged host-level total. `ledger` maps worktreePath -> {repo, remote, slug}.
    `fold_slug` is a callable slug -> _UsageAcc returning that project slug's
    persistent, incrementally-updated accumulator, so each transcript is parsed
    once per beat (only appended bytes) and the work is shared with per-session
    usage rather than re-reading every transcript from scratch.

    Usage is folded from PROJECTS_ROOT by slug, so a repo's figure spans every
    worktree it ever had and survives kill AND delete (the transcripts outlive
    both). Each repo carries `remoteKey` (normalized origin) so the hub can unify
    the same repo across hosts.

    Returns (repo_usage, host_usage): repo_usage is
    [{repo, remote, remoteKey, usage}] sorted by cost desc (repos that never
    spent anything are omitted); host_usage is the merged report, or None when no
    transcript exists at all."""
    by_repo = {}  # repo name -> {"remote": str, "slugs": set()}
    for path, meta in (ledger or {}).items():
        meta = meta or {}
        repo = meta.get("repo") or "?"
        slug = meta.get("slug") or _project_slug(path)
        g = by_repo.setdefault(repo, {"remote": "", "slugs": set()})
        g["slugs"].add(slug)
        if not g["remote"] and meta.get("remote"):
            g["remote"] = meta["remote"]

    repo_usage = []
    host = _UsageAcc()
    for repo, g in by_repo.items():
        acc = _UsageAcc()
        for slug in g["slugs"]:
            # fold_slug returns the persistent per-slug acc (already folded this
            # beat if per-session usage touched it); merging is cheap arithmetic.
            _merge_acc(acc, fold_slug(slug))
        _merge_acc(host, acc)  # fold into the host total (seen-set union dedups)
        report = _finalize_usage(acc)
        if _usage_is_empty(report):
            continue
        repo_usage.append({
            "repo": repo,
            "remote": g["remote"],
            "remoteKey": normalize_remote(g["remote"]) or repo,
            "usage": report,
        })

    host_usage = _finalize_usage(host) if host.sessions else None
    repo_usage.sort(key=lambda r: r["usage"]["totals"]["cost"], reverse=True)
    return repo_usage, host_usage


PR_URL_RE = re.compile(r"https://github\.com/[\w.-]+/[\w.-]+/pull/\d+")

# Beats between `gh pr view` status refreshes for the PR links a session opened
# (~INTERVAL*N sec). Faster than the github-block cadence so CI/merge state on a
# session card stays reasonably live, but not every beat (each is a gh network
# call). Bounded per refresh so a host with many PRs never stalls a beat.
PR_STATUS_REFRESH_EVERY = int(os.environ.get("TURMA_PR_REFRESH_EVERY", "3"))
PR_STATUS_MAX = 20


def _check_class(entry):
    """Map one `statusCheckRollup` entry to 'pass' | 'fail' | 'pending' | None.

    Rollup entries are either CheckRuns (a `status` that's COMPLETED/… plus a
    `conclusion`) or legacy StatusContexts (a single `state`). An unfinished run
    is pending regardless of conclusion; neutral/skipped count as non-blocking
    passes, mirroring how GitHub renders the overall rollup."""
    if not isinstance(entry, dict):
        return None
    status = str(entry.get("status") or "").upper()
    if status and status != "COMPLETED":
        return "pending"  # QUEUED / IN_PROGRESS / WAITING / PENDING / REQUESTED
    concl = str(entry.get("conclusion") or entry.get("state") or "").upper()
    if concl in ("SUCCESS", "NEUTRAL", "SKIPPED", "EXPECTED"):
        return "pass"
    if concl in ("FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED",
                 "ERROR", "STARTUP_FAILURE", "STALE"):
        return "fail"
    if concl in ("PENDING", ""):
        return "pending"
    return None


def _summarize_pr(data):
    """Condense `gh pr view --json …` output to the compact status the hub cards
    render: number, title, state (OPEN/DRAFT/MERGED/CLOSED), and a CI-check
    rollup ('passing'/'failing'/'pending'/None) with per-bucket counts."""
    state = str(data.get("state") or "").upper()  # OPEN / MERGED / CLOSED
    draft = bool(data.get("isDraft"))
    counts = {"pass": 0, "fail": 0, "pending": 0}
    for entry in data.get("statusCheckRollup") or []:
        cls = _check_class(entry)
        if cls:
            counts[cls] += 1
    total = counts["pass"] + counts["fail"] + counts["pending"]
    checks = None
    if total:
        checks = ("failing" if counts["fail"]
                  else "pending" if counts["pending"] else "passing")
    return {
        "url": data.get("url"),
        "number": data.get("number"),
        "title": (data.get("title") or "")[:120],
        # DRAFT is really an OPEN sub-state in the API; surface it as its own
        # state so the card can grey it out like GitHub does.
        "state": "DRAFT" if draft and state == "OPEN" else state,
        "checks": checks,
        "checkCounts": counts if total else None,
    }


def pr_status(url):
    """Fetch a PR's state + CI-check rollup via `gh pr view <url>`. Returns the
    compact status dict, or None on any failure (gh accepts the full URL, so this
    works from any cwd as long as the login can see the repo). Best-effort and
    network-cheap — one gh call, capped by run()'s timeout."""
    raw = run(["gh", "pr", "view", url, "--json",
               "number,title,state,isDraft,url,statusCheckRollup"])
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return _summarize_pr(data)


LOG_TAIL_LINES = 50
LOG_TAIL_MAX_BYTES = 12_000
# `docker logs` shells out; the tail changes slowly and isn't worth a subprocess
# every beat. Recompute it only every N beats and reuse the cache in between.
LOG_TAIL_EVERY = 5


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


# A background Task/agent finishing injects a `<task-notification>…` payload as a
# user-role turn (origin.kind == "task-notification"), an XML-ish blob carrying a
# <summary>, <status>, optional <note> boilerplate and the child's <result>.
# Rendered verbatim it reads as the human typing raw XML into chat; instead we
# parse it into a structured `task_notification` block (see _entry_blocks) that
# the web chat shows as an action-style card, exactly like a tool call. Keep this
# mirrored with tunnel-agent.js parseTaskNotification().
TASK_NOTIFICATION_RE = re.compile(r"^\s*<task-notification>(.*)</task-notification>\s*$", re.DOTALL)


def _tn_tag(name, body):
    """Inner text of the first <name>…</name> in `body`, ANSI-stripped and
    trimmed, or "" when absent."""
    m = re.search(r"<%s>(.*?)</%s>" % (name, name), body, re.DOTALL)
    return ANSI_RE.sub("", m.group(1)).strip() if m else ""


def _parse_task_notification(text):
    """Parse a `<task-notification>` payload into {summary, status, result}, or
    None when `text` isn't one. Mirror of tunnel-agent.js parseTaskNotification."""
    if not text:
        return None
    m = TASK_NOTIFICATION_RE.match(text)
    if not m:
        return None
    body = m.group(1)
    return {
        "summary": _tn_tag("summary", body),
        "status": _tn_tag("status", body),
        "result": _tn_tag("result", body),
    }


def _tn_preview(tn):
    """Flatten a parsed task-notification to display text (summary + result), the
    text-feed form used by the glasses tail, heartbeat preview and archive."""
    parts = [tn["summary"] or tn["status"] or "background task update"]
    if tn["result"]:
        parts.append(tn["result"])
    return "\n\n".join(p for p in parts if p)


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
        tn = _parse_task_notification(content)
        text = _tn_preview(tn) if tn else content
    elif isinstance(content, list):
        parts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text":
                raw = str(block.get("text") or "")
                tn = _parse_task_notification(raw)
                parts.append(_tn_preview(tn) if tn else raw)
            elif btype == "tool_use" and block.get("name"):
                parts.append(f"[{block['name']}]")
            # "thinking" and "tool_result" blocks are dropped.
        text = "".join(parts)
    else:
        return None
    text = ANSI_RE.sub("", text).strip()
    return text or None


def _clip(text, cap):
    """(clipped, was_truncated). None/empty -> ("", False)."""
    text = text or ""
    if len(text) > cap:
        return text[:cap], True
    return text, False


# Common Claude Code tools carry their salient argument under one of these keys;
# surface it as the tool_use's one-line summary rather than a raw JSON dump.
_TOOL_INPUT_KEYS = ("command", "file_path", "path", "pattern", "url", "query", "prompt")


def _tool_input_summary(inp):
    """A compact display string for a tool_use `input` object: the salient arg
    for known tools, else a compact JSON dump, else str()."""
    if isinstance(inp, dict):
        for key in _TOOL_INPUT_KEYS:
            val = inp.get(key)
            if isinstance(val, str) and val.strip():
                return val
        try:
            return json.dumps(inp, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):
            return str(inp)
    if isinstance(inp, str):
        return inp
    if inp is None:
        return ""
    return str(inp)


def _tool_result_text(content):
    """Flatten a tool_result block's `content` (a string, or a list of
    {type:'text'|'image', ...} blocks) to plain text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    parts.append(str(block.get("text") or ""))
                elif block.get("type") == "image":
                    parts.append("[image]")
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    if content is None:
        return ""
    return str(content)


def _entry_blocks(entry, caps):
    """Rich, order-preserving block list for one transcript entry, or None to
    drop it (wrong type / no message dict). Additive companion to _entry_text:
    it PRESERVES the thinking text, tool_use inputs and tool_result outputs that
    _entry_text() flattens away, so the native chat UI can show/hide each
    component by verbosity. `caps` is a {text, input, result} char-limit dict
    (BLOCK_CAPS_LIVE for the ~1s tail, BLOCK_CAPS_FULL for on-demand history); a
    block cut to its cap gets truncated:true. Blocks:
      {t:"text",        text}
      {t:"thinking",    text, truncated?}
      {t:"tool_use",    id, name, input, truncated?}
      {t:"tool_result", forId, text, isError?, truncated?}
    A `<task-notification>` user turn becomes a single {t:"task_notification",
    summary, status?, result?, truncated?} block (see _parse_task_notification)
    so the web chat renders it as an action card, not raw XML.
    Returns [] for a user/assistant message with no renderable blocks. Keep this
    mirrored with tunnel-agent.js entryBlocks()."""
    if entry.get("type") not in ("user", "assistant"):
        return None
    msg = entry.get("message")
    if not isinstance(msg, dict):
        return None
    content = msg.get("content")
    blocks = []

    def add_text(kind, text, cap):
        text = ANSI_RE.sub("", text or "").strip()
        if not text:
            return
        clipped, trunc = _clip(text, cap)
        block = {"t": kind, "text": clipped}
        if trunc:
            block["truncated"] = True
        blocks.append(block)

    def add_task_notification(tn):
        summary, _ = _clip(tn["summary"], caps["input"])
        result, rtrunc = _clip(tn["result"], caps["result"])
        block = {"t": "task_notification", "summary": summary}
        if tn["status"]:
            block["status"] = tn["status"]
        if result:
            block["result"] = result
        if rtrunc:
            block["truncated"] = True
        blocks.append(block)

    if isinstance(content, str):
        tn = _parse_task_notification(content)
        if tn:
            add_task_notification(tn)
        else:
            add_text("text", content, caps["text"])
    elif isinstance(content, list):
        for raw in content:
            if not isinstance(raw, dict):
                continue
            btype = raw.get("type")
            if btype == "text":
                tn = _parse_task_notification(str(raw.get("text") or ""))
                if tn:
                    add_task_notification(tn)
                else:
                    add_text("text", str(raw.get("text") or ""), caps["text"])
            elif btype == "thinking":
                add_text("thinking", str(raw.get("thinking") or raw.get("text") or ""), caps["text"])
            elif btype == "tool_use" and raw.get("name"):
                summary = ANSI_RE.sub("", _tool_input_summary(raw.get("input"))).strip()
                clipped, trunc = _clip(summary, caps["input"])
                block = {"t": "tool_use", "name": str(raw["name"]), "input": clipped}
                if raw.get("id"):
                    block["id"] = raw["id"]
                if trunc:
                    block["truncated"] = True
                blocks.append(block)
            elif btype == "tool_result":
                text = ANSI_RE.sub("", _tool_result_text(raw.get("content"))).strip()
                clipped, trunc = _clip(text, caps["result"])
                block = {"t": "tool_result", "text": clipped}
                if raw.get("tool_use_id"):
                    block["forId"] = raw["tool_use_id"]
                if raw.get("is_error"):
                    block["isError"] = True
                if trunc:
                    block["truncated"] = True
                blocks.append(block)
            if len(blocks) >= BLOCK_MAX_PER_ENTRY:
                break
    else:
        return None
    return blocks


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


def _first_user_text(path, max_lines=500):
    """The first genuine human prompt from the START of a transcript, or None.

    Reads forward from the top and returns the first `user` entry that carries
    real text, skipping the transcript's non-message header (mode/bridge/system
    rows), Claude Code's `isMeta` caveat entries, and `<command-…>` slash-command
    wrappers — so what comes back is what an initial task prompt would have been.
    This is how a session that spawned with NO initial prompt gets named: its
    first prompt is almost always typed into the live ttyd terminal, which writes
    straight to the tmux pane and never reaches send_input, so the transcript —
    which every input path lands in — is the only channel-agnostic place to find
    it. Reading from the top also means a naming RETRY sees the same first prompt
    the original attempt saw, however many turns later it runs. Bounded to the
    first max_lines lines so an already-long resumed transcript can't make this
    walk expensive (the real first prompt sits within the first handful of entries
    anyway)."""
    try:
        with open(path, errors="replace") as f:
            for i, line in enumerate(f):
                if i >= max_lines:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(entry, dict):
                    continue
                if entry.get("type") != "user" or entry.get("isMeta"):
                    continue
                if entry.get("promptSource") == "system":
                    continue  # injected turn (e.g. a task-notification), not human
                text = _entry_text(entry)
                if not text:
                    continue  # tool_result-only turn, or empty after stripping
                if text.startswith("<command-") or text.startswith("<local-command"):
                    continue  # slash-command plumbing, not a real prompt
                return text
    except OSError:
        return None
    return None


def _transcript_cwd(path):
    """The real working directory a transcript was recorded from, or None.

    Claude Code stamps the un-slugified `cwd` on its early entries; reading it
    back is the authoritative way to invert a transcript to its origin path (the
    project slug is lossy — every non-alphanumeric collapsed to '-'). Used both
    to name a repo (_repo_from_transcript_cwd) and to pick the cwd a resumed
    session must relaunch in so `claude --resume <id>` resolves it (Claude scopes
    id lookup to the current repo's LIVE git worktrees + repo dir, so the
    resumed session's cwd has to be that origin path). Bounded head-scan — the
    cwd sits on the first handful of entries."""
    try:
        with open(path, errors="replace") as fh:
            for _i, line in zip(range(200), fh):  # cwd is on early entries
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if isinstance(e, dict) and e.get("cwd"):
                    return e["cwd"]
    except OSError:
        return None
    return None


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
        blocks = _entry_blocks(entry, BLOCK_CAPS_FULL)
        # Rich path widens inclusion beyond _entry_text: a turn that carries only
        # tool_result blocks (text is None) still has renderable blocks and is
        # kept, so the chat UI can show tool output. transcript_tail keeps the
        # old drop-when-None rule (heartbeat/archive stay lean).
        if text is None and not blocks:
            continue
        entries.append({
            "id": entry.get("uuid"),
            "role": entry.get("type"),
            "text": (text or "")[:TAIL_MSG_CHARS_FULL],
            "blocks": blocks or [],
        })
    return entries, byte_capped


# A req file only marks a *live* pending question while the ask.py bridge is
# still blocked on it; the bridge self-times-out at TURMA_QUESTION_TIMEOUT_SEC
# and Claude kills the hook at ASK_HOOK_TIMEOUT_SEC regardless, so a req older
# than that ceiling (plus clock-skew margin) can only be an orphan the bridge
# left behind when its turn was killed/restarted/crashed mid-question. Reporting
# such a stale req is exactly how a long-answered question keeps showing on the
# card and re-opens in the chat; past this age we drop (and clean up) instead.
QUESTION_STALE_AFTER_SEC = ASK_HOOK_TIMEOUT_SEC + 60


def _hook_question(session_id):
    """Read a *live* pending AskUserQuestion published by the ask.py PreToolUse
    bridge for `session_id`, as (question, options) or (None, []). The bridge
    blocks the tool call while this request file exists, so its presence is an
    exact "a question is waiting right now" signal — no pane scraping, no
    transcript timing.

    A req is only live while the bridge is actually blocked on it, so two states
    are *not* reported (both are how an already-answered question would linger):
      * an `.ans.json` sits beside the req — the answer has been delivered and
        the bridge is consuming it (or died before it could), so the question is
        effectively answered, not pending;
      * the req has outlived the bridge's max block window — the owning bridge
        can no longer be waiting on it (it self-times-out well before this), so
        the file is an orphan from a killed/restarted/crashed turn.
    A stale orphan is also cleaned up so it can't accumulate; the answered-but-
    fresh case is left on disk for the bridge to consume normally.

    Best-effort: a missing/half-written file is just no question."""
    if not session_id:
        return None, []
    path = os.path.join(QUESTIONS_DIR, f"{session_id}.req.json")
    ans_path = os.path.join(QUESTIONS_DIR, f"{session_id}.ans.json")
    try:
        mtime = os.stat(path).st_mtime
    except OSError:
        return None, []
    # Orphaned by a dead bridge (too old to still be blocking) — drop and tidy.
    if time.time() - mtime > QUESTION_STALE_AFTER_SEC:
        for p in (path, ans_path):
            try:
                os.remove(p)
            except OSError:
                pass
        return None, []
    # Answer already delivered — the bridge is consuming it, not still asking.
    if os.path.exists(ans_path):
        return None, []
    try:
        with open(path, encoding="utf-8") as f:
            req = json.load(f)
    except (FileNotFoundError, ValueError, OSError):
        return None, []
    if not isinstance(req, dict):
        return None, []
    question = str(req.get("question") or "")[:300] or None
    opts = req.get("options") or []
    labels = [
        opt["label"][:80] for opt in opts[:4]
        if isinstance(opt, dict) and isinstance(opt.get("label"), str)
    ]
    return question, labels


# Claude Code's TUI paints an "esc to interrupt" hint on its status line for
# exactly as long as the model is actively working — while it's generating and
# while a tool call it launched is still running — and drops it the instant the
# turn ends and it's back to awaiting input. Capturing the session's tmux pane
# and looking for that hint is the most accurate "is it working right now"
# signal we have: it's literally the icon a human watches in the terminal, so
# unlike transcript-mtime it stays true through a long silent Bash/build tool
# call and flips false the moment the turn finishes (instead of lingering
# "working" for the mtime window). The marker set is env-overridable so a TUI
# wording change can be patched without rebuilding the image.
PANE_BUSY_MARKERS = tuple(
    m.strip().lower() for m in
    os.environ.get("TURMA_PANE_BUSY_MARKERS", "esc to interrupt").split("|")
    if m.strip()
)


def _pane_busy(tmux_name):
    """Whether the session's live TUI shows the model actively working.

    True  = the interrupt hint is on screen (generating or running a tool),
    False = it isn't (turn finished, awaiting input),
    None  = unknown — no tmux_name, markers disabled, or the pane couldn't be
            captured (e.g. the tmux session is gone). Callers fall back to the
            transcript-mtime heuristic on None, so an old/crashed pane degrades
            gracefully rather than reporting a wrong state."""
    if not tmux_name or not PANE_BUSY_MARKERS:
        return None
    try:
        out = subprocess.run(
            ["tmux", "capture-pane", "-p", "-t", tmux_name],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return None
    if out.returncode != 0:
        return None
    low = out.stdout.lower()
    return any(m in low for m in PANE_BUSY_MARKERS)


def session_report(workdir, state, tmux_name=None, session_id=None):
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
        # Live "is it working right now" read straight off the session's TUI —
        # the primary working/idle signal; transcriptAgeSec is the fallback.
        "paneBusy": _pane_busy(tmux_name),
        "transcriptAgeSec": None,  # seconds since the newest transcript write
        "lastRole": None,          # "assistant"/"user"/... of the newest entry
        "lastHasToolUse": False,
        "question": None,          # pending AskUserQuestion text, if any
        "questionOptions": [],     # pending AskUserQuestion option labels, if any
        "questionSource": None,    # "transcript" | "hook" | None — which detector fired
        "prUrls": [],              # PR links newly appended since last beat
        "tail": [],                # recent transcript messages, for the glasses client
    }

    def _finish():
        # The ask.py PreToolUse bridge publishes a request file for exactly as
        # long as a question is actually blocking the tool call, so it's the
        # authoritative pending signal — prefer it over the transcript scan
        # (which can only see a question once it's already answered/denied).
        hq, hopts = _hook_question(session_id)
        if hq:
            report["question"] = hq
            report["questionOptions"] = hopts
            report["questionSource"] = "hook"
        return report

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
        return _finish()
    state["primed"] = True
    if not newest:
        return _finish()
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
                        if report["question"]:
                            report["questionSource"] = "transcript"

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
    return _finish()


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
    """REPOS_ROOT children that are non-dot dirs (excluding .turma) with a
    .git entry. Returns [{"name","path"}] — the multiplexer's repo list."""
    repos = []
    try:
        for name in sorted(os.listdir(REPOS_ROOT)):
            # Skip dot-dirs, our own worktree store, and the reserved root
            # pseudo-repo name so a real dir can never shadow the root entry.
            if name.startswith(".") or name in (".turma", ROOT_REPO_NAME):
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


def repo_last_commit_iso(path):
    """Committer date of HEAD as UTC ISO (YYYY-MM-DDTHH:MM:SSZ), '' when the repo
    has no commits. The "modified" half of a repo's activity ranking; %ct (unix
    ts) normalized to UTC so it compares lexicographically against the transcript
    timestamps that supply the "used" half."""
    ct = run(["git", "-C", path, "log", "-1", "--format=%ct", "HEAD"])
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(ct)))
    except (TypeError, ValueError):
        return ""


def repo_slow_facts(path):
    """Slow-changing repo git facts, cached across beats (each spawns a git
    subprocess or two): the origin remote URL, the composer's base-branch choices
    plus the default it pre-selects, and the newest-commit time (the "modified"
    input to the activity sort — the manager combines it with per-repo session
    activity into lastActivity and orders repos[] by it, most-recent first; see
    build_payload)."""
    return {
        "remote": run(["git", "remote", "get-url", "origin"], cwd=path),
        "branches": repo_branches(path),
        "defaultBranch": default_branch_name(path),
        "lastCommit": repo_last_commit_iso(path),
    }


def repo_entry(repo, slow):
    """Heartbeat repos[] entry: the CHEAP, fast-changing reads done every beat
    (current checked-out branch + `git status --porcelain` dirty count) merged
    with the cached `slow` facts (repo_slow_facts, refreshed on the slow cadence).
    """
    path = repo["path"]
    dirty = run(["git", "status", "--porcelain"], cwd=path)
    return {
        "name": repo["name"],
        "path": path,
        "branch": run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=path),
        "dirtyFiles": len(dirty.splitlines()) if dirty else 0,
        **slow,
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
# the heartbeat). A session spawned with no initial prompt (the one-click bare
# spawn, the repos-root pseudo-repo) is named instead from its FIRST user prompt,
# read straight out of its transcript by _seed_summaries() each beat (see
# _first_user_text). That transcript read is the channel-agnostic path: the first
# prompt is usually typed into the live ttyd terminal, which writes to the tmux
# pane and never reaches send_input, so keying off any single input channel misses
# it — the transcript is where every input path lands. send_input still kicks the
# FIRST attempt off immediately when a prompt does arrive that way (a fast path).
# A session with no prompt yet stays unnamed and the card falls back to the
# label/worktree until one lands.
#
# Naming is attempted at most SUMMARY_MAX_ATTEMPTS times, spaced by a growing
# backoff, and only ever while a session is unnamed. It is NOT one-shot: an
# attempt can come back with no name for reasons that have nothing to do with the
# session (a nonzero `claude -p` exit, an empty reply, the timeout below, or a
# rate limit from the one login every session shares), and a single attempt made
# those transient failures permanent — the card kept showing the raw session id
# for the rest of its life, on an arbitrary subset of sessions. Retries are
# bounded and backed off rather than per-beat precisely because of that shared
# login: a handful of spaced attempts costs little, re-summarizing every beat
# would eat the working sessions' rate limits. _seed_summaries() drives the
# retries off the transcript, so a retry still names from the session's FIRST
# prompt no matter how many turns have passed.
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
SUMMARY_MAX_ATTEMPTS = 3       # naming tries before a session stays unnamed for good
SUMMARY_RETRY_BACKOFF_SEC = 90  # base gap between tries; grows with the try count
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


def _summary_attempts(sess):
    """How many naming attempts a session has already spent.

    `summaryStarted` was the original one-shot boolean and still sits on records
    persisted by an older agent (and on ones this agent wrote before the retry
    counter existed). Read it as "one attempt spent" rather than as a permanent
    gate, so a session an earlier attempt failed to name becomes eligible for the
    remaining retries instead of staying stuck on its id forever."""
    n = sess.get("summaryAttempts")
    if isinstance(n, int):
        return n
    return 1 if sess.get("summaryStarted") else 0


def _summary_due(sess, now):
    """True when a session still wants a name: unnamed, attempts left, and past
    the backoff a previous failed attempt set."""
    if sess.get("summary"):
        return False
    if _summary_attempts(sess) >= SUMMARY_MAX_ATTEMPTS:
        return False
    return now >= (sess.get("summaryRetryAt") or 0)


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

        # AskUserQuestion bridge rendezvous dir (ask.py writes req files here).
        try:
            os.makedirs(QUESTIONS_DIR, exist_ok=True)
        except OSError:
            pass
        self.registry = self._load_list(REGISTRY_PATH)  # persisted live sessions
        self.closed = self._load_list(CLOSED_PATH)      # killed-but-resumable
        # Durable worktreePath -> {repo, remote, slug} attribution map, so a
        # transcript's usage stays traceable to its repo after kill/delete.
        self.usage_ledger = self._load_ledger()
        # Cached host/repo usage aggregated across ALL known transcripts (refreshed
        # on the slow USAGE_EVERY cadence, reported every beat, independent of the
        # live registry so it persists regardless of active sessions).
        self.repo_usage = []
        self.host_usage = None
        # Per-repo list of resumable transcripts (EVERY prior Claude session for
        # the repo whose origin cwd is under REPOS_ROOT — Turma worktrees, repo-dir
        # "terminal" runs, and the repos-root pseudo-repo alike, not just the last
        # few killed sessions). Refreshed on the slow USAGE_EVERY cadence.
        self.resumable = {}                      # repo name -> [resumable entry]
        self.ttyd = {}                           # id -> ttyd Popen (in-memory)
        self.sess_state = {}                     # id -> session_report offsets
        self.usage_cache = {}                    # id -> usage_report result
        self.slug_usage = {}                     # project slug -> {acc, offsets}
                                                 # persistent incremental usage fold,
                                                 # shared by per-session + repo usage
        self.pending_prs = {}                    # id -> undelivered PR urls
        # The PR links each session has opened, PERSISTENT across beats — unlike
        # pending_prs, which _clear_pending_prs empties after every delivered
        # heartbeat (it's a one-shot "new since last beat" delivery queue). This
        # is what _session_prs / refresh_pr_status key off, so a card's PR status
        # survives past the beat the URL was first scraped. Deduped + capped,
        # in-memory (a restart re-learns links as new PRs appear).
        self.session_pr_urls = {}                # id -> [unique PR urls, capped]
        # PR link -> compact status (state + CI checks), refreshed via `gh pr
        # view` on the PR_STATUS_REFRESH_EVERY cadence and attached to each
        # session's payload. Keyed by URL so several sessions can share one.
        self.pr_status_cache = {}
        # Slow-changing git facts cached across beats (recomputed on the slow
        # USAGE_EVERY cadence, or on first sight): repo path -> repo_slow_facts,
        # session id -> {liveBranch, slow git_info, branch_sync work}.
        self.repo_facts = {}
        self.session_facts = {}
        # Throttled `docker logs` tail (LOG_TAIL_EVERY beats); reused in between.
        self.log_tail_cache = None
        # Staged `history` command results awaiting the next heartbeat payload
        # (historyResults) — held across a failed POST, cleared only once
        # delivery succeeds, same lifecycle as pending_prs above.
        self.history_results = []
        # Archive sync: the manifest of inactive transcripts sent on the last slow
        # beat, keyed by transcriptId, so when the reply's archiveHave cursors come
        # back we know each one's size/slug/meta to push deltas for.
        self._archive_pending = {}
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
        # record). Empty when no session has a prompt to summarize.
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

    # --- usage attribution ledger -----------------------------------------

    def _load_ledger(self):
        try:
            with open(USAGE_LEDGER_PATH) as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save_ledger(self):
        try:
            os.makedirs(REGISTRY_DIR, exist_ok=True)
            tmp = USAGE_LEDGER_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self.usage_ledger, f, indent=2)
            os.replace(tmp, USAGE_LEDGER_PATH)
        except OSError as e:
            log(f"usage ledger save failed: {e}")

    def _remember_usage(self, sess):
        """Record a session's worktree -> repo attribution so its transcript's
        token usage stays traceable to the repo forever (survives kill/delete).
        Idempotent; keyed by worktree path (root sessions key on REPOS_ROOT).
        `remote` is the repo's git origin, used cross-host to unify the same
        repo across hosts."""
        path = sess.get("worktreePath")
        if not path:
            return
        remote = ""
        try:
            remote = run(["git", "remote", "get-url", "origin"],
                         cwd=sess.get("repoPath") or path) or ""
        except Exception:
            pass
        self.usage_ledger[path] = {
            "repo": sess.get("repo"),
            "remote": remote,
            "slug": _project_slug(path),
        }
        self._save_ledger()

    def _prune_ledger(self):
        """Drop ledger entries whose transcript dir no longer exists — nothing
        left to attribute, so the map can't grow without bound. Runs on the slow
        usage cadence."""
        stale = [
            p for p, m in self.usage_ledger.items()
            if not os.path.isdir(os.path.join(
                PROJECTS_ROOT, (m or {}).get("slug") or _project_slug(p)))
        ]
        if stale:
            for p in stale:
                self.usage_ledger.pop(p, None)
            self._save_ledger()
        # Keep the per-slug usage folds bounded to slugs the ledger still tracks,
        # so a killed/deleted session's accumulator doesn't linger forever.
        live_slugs = {(m or {}).get("slug") or _project_slug(p)
                      for p, m in self.usage_ledger.items()}
        self.slug_usage = {s: v for s, v in self.slug_usage.items()
                           if s in live_slugs}

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
        to ``REGISTRY_DIR/guard-settings.json`` and reused. The operator's
        ~/.claude/settings.local.json permissions are snapshotted into it at this
        first write; restart the manager to pick up later edits to that file."""
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

    def _launch_tmux(self, sess, resume=False, prompt=None, resume_id=None):
        """(Re)launch claude for a session inside its own tmux, detached.

        resume=True relaunches the worktree's most recent CONVERSATION
        (claude --resume <newest transcript id>) instead of an empty context;
        it silently falls back to a fresh claude when no transcript exists.
        resume_id pins a SPECIFIC transcript to resume (the "resume any prior
        session" picker) instead of the worktree's newest — it's validated
        uuid-ish before reaching the tmux command line.

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
            claude_sid = None
            if resume_id and re.fullmatch(r"[A-Za-z0-9-]+", resume_id):
                claude_sid = resume_id  # a specific transcript from the picker
            else:
                claude_sid = self._latest_transcript_id(sess["worktreePath"])
            if claude_sid:
                parts.append(f"--resume {claude_sid}")
        parts.append(f"--remote-control '{sess['rcName']}'")
        model = sess.get("model")
        if model:
            parts.append(f"--model {model}")
        # Default (unset) -> --permission-mode auto; the explicit "default" choice
        # omits the flag (claude's own manual-review default).
        perm = sess.get("permissionMode") or "auto"
        # Remember the mode we actually launch into: it fixes which optional modes
        # this session's live Shift+Tab cycle exposes (see perm_cycle_for), so a
        # later live set_mode computes presses against the real cycle rather than a
        # fixed all-modes list. Re-set on every (re)launch, so restart/resume into
        # a switched mode updates the basis.
        sess["launchPermissionMode"] = perm
        if perm != "default":
            parts.append(f"--permission-mode {perm}")
        # Wire the PreToolUse safety guard (blocks catastrophic / policy /
        # attribution Bash) — defense in depth under any mode, and what makes
        # bypassPermissions safe. Best-effort: if the settings file can't be
        # written the session still launches (bare).
        settings = self._ensure_guard_settings()
        if settings:
            parts.append(f"--settings {shlex.quote(settings)}")
        claude_cmd = " ".join(parts)
        if prompt:
            claude_cmd += f" -- {shlex.quote(prompt)}"
        # The AskUserQuestion bridge (hooks/ask.py) reads these off the claude
        # process env to key its request/answer rendezvous files. Prefixed as
        # shell assignments so tmux's `sh -c` exports them to claude and its
        # hook subprocesses. Only sessions launched with --settings get the
        # bridge; the one-shot summary claude (no --settings) has neither var,
        # so ask.py passes through there.
        env_prefix = (
            f"TURMA_SESSION_ID={shlex.quote(sess['id'])} "
            f"TURMA_QUESTIONS_DIR={shlex.quote(QUESTIONS_DIR)} "
        )
        claude_cmd = env_prefix + claude_cmd
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
            "-c", f"term:{TURMA_TOKEN or 'changeme'}",
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
        # Not slug_usage: the transcript survives kill/delete and still counts
        # toward the persistent per-repo/host usage. It's keyed by slug (not
        # session id) and bounded by _prune_ledger when the transcript is gone.
        self.session_facts.pop(sid, None)
        self.pending_prs.pop(sid, None)
        self.session_pr_urls.pop(sid, None)
        # A killed/deleted session's tmux (and its blocked ask.py hook) is gone;
        # drop any leftover question rendezvous files so a dead question can't
        # surface as a phantom on the next beat.
        self._clear_question_files(sid)

    def _set_error(self, sess, msg):
        sess["status"] = "error"
        sess["errorMsg"] = str(msg)[:500]
        log(f"session {sess['id']} error: {msg}")

    # --- lifecycle (executed container-side; see CONTRACT) ----------------

    def spawn(self, repo_name, *, prompt=None, label=None, base_ref=None,
              model=None, permission_mode=None, cmd_id=None):
        """Create a brand-new worktree-backed session for <repo_name>.

        The worktree is added in DETACHED HEAD forked off the latest default
        branch (or an operator-chosen base) — the app creates NO branch; the
        running agent branches its own work when ready. label is presentational:
        it flavors the claude.ai/code display name but agent-<id> tmux stays the
        canonical internal key. The options (base branch, model, permission mode)
        are validated below; a bad option fails the spawn cleanly as an error
        card rather than reaching git/tmux or crashing the manager.

        cmd_id is the hub's queued-command id. The session id is minted HERE, so
        the hub has no handle on the session it just asked for until a later
        beat; echoing the command id back on the record (reported as
        `spawnCmdId`) is what lets the UI recognize its own spawn and open it."""
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
            "permissionMode": "auto",
            "baseRef": None,                # base branch the worktree forked from
            "status": "running",
            "createdAt": now_iso(),
            "stoppedAt": None,
            "errorMsg": None,
            "summary": None,       # few-word task name, filled in async at spawn
            # The hub command that asked for this session, echoed back so the UI
            # can correlate its POST with the id we just minted (see docstring).
            "spawnCmdId": cmd_id,
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
            # Record the worktree -> repo attribution so this session's token
            # usage stays traceable to its repo after it (and its worktree) are
            # gone — the basis of persistent host/repo usage.
            self._remember_usage(sess)
            # Name the session from its initial prompt, once, in the background
            # (no-op when there's no prompt). Never blocks the spawn.
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
            "permissionMode": rec.get("permissionMode") or "auto",
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

    def resume_transcript(self, transcript_id, cwd_hint=None, cmd_id=None):
        """Resume ANY prior Claude session by its transcript id (the "resume any
        session" picker), not just a killed Turma session in closed.json. Locate
        the transcript, read its ORIGIN cwd, re-create that worktree at the exact
        path if it was deleted/pruned (Claude scopes id lookup to the repo's LIVE
        worktrees, so the origin dir must exist for --resume to resolve), then
        launch a fresh session cwd'd there with `claude --resume <id>`. Running
        with cwd == the transcript's origin keeps transcript-slug == worktree-slug,
        so all per-session reporting (tail/usage/questions/summary) keeps working.
        A new Turma id/rcName/port is minted like spawn; the record moves nothing
        out of closed.json (the picker lists transcripts, not closed records).

        cmd_id is echoed onto the record as `spawnCmdId` for the same reason as
        in spawn(): a resume-by-transcript creates a session whose id the hub
        can't predict, so that's the UI's only handle on the one it asked for."""
        if not transcript_id or not re.fullmatch(r"[A-Za-z0-9-]+", transcript_id):
            log(f"resumeTranscript: bad transcript id {transcript_id!r}")
            return
        # Find the transcript dir: trust the picker's cwd hint if it still holds
        # the file, else scan PROJECTS_ROOT for it.
        proj = None
        if cwd_hint:
            cand = os.path.join(PROJECTS_ROOT, _project_slug(cwd_hint))
            if os.path.isfile(os.path.join(cand, transcript_id + ".jsonl")):
                proj = cand
        if proj is None:
            proj = self._find_transcript_dir(transcript_id)
        if proj is None:
            log(f"resumeTranscript: no transcript {transcript_id}")
            return
        path = os.path.join(proj, transcript_id + ".jsonl")
        cwd = _transcript_cwd(path) or cwd_hint
        # Only a cwd under REPOS_ROOT is resumable here — never let a free-form
        # path reach git/tmux.
        cls = self._resumable_cwd_class(cwd, {r["name"] for r in scan_repos()})
        if not cls:
            log(f"resumeTranscript: cwd {cwd!r} not resumable on this host")
            return
        repo, _origin, is_root = cls
        cwd = os.path.normpath(cwd)
        if self._running_count() >= MAX_SESSIONS:
            log(f"resumeTranscript refused: at MAX_SESSIONS ({MAX_SESSIONS})")
            return
        if is_root and self._root_running():
            log("resumeTranscript refused: a root session is already running")
            return
        # One live session per cwd: two claudes in the same dir share a project
        # slug + RC bridge pointer and would collide (the same reason root is
        # single). A worktree resume gets its own dir, so this only bites a repo-
        # dir / repos-root re-resume while one is already up.
        if any(s.get("status") == "running"
               and os.path.normpath(s.get("worktreePath") or "") == cwd
               for s in self.registry):
            log(f"resumeTranscript refused: a session is already running in {cwd}")
            return
        repo_path = REPOS_ROOT if is_root else os.path.join(REPOS_ROOT, repo)
        if not is_root and not os.path.isdir(repo_path):
            log(f"resumeTranscript: repo {repo!r} is gone; cannot resume")
            return
        sid = self._new_id()
        sess = {
            "id": sid,
            "repo": repo,
            "repoPath": repo_path,
            "worktreePath": cwd,
            "branch": None,
            "root": is_root,
            "label": None,
            "summary": None,       # seeded from the transcript on later beats
            "rcName": f"{slugify(self.device)}-{slugify(repo)}-{sid}",
            "tmuxName": f"agent-{sid}",
            "ttydPort": self._alloc_port(),
            "model": None,
            "permissionMode": "auto",
            "baseRef": None,
            "status": "running",
            "createdAt": now_iso(),
            "stoppedAt": None,
            "errorMsg": None,
            "spawnCmdId": cmd_id,
        }
        self.registry.append(sess)
        try:
            # A deleted/pruned Turma worktree: re-add a detached one at the exact
            # origin path so its slug matches the transcript and claude resolves
            # the id. Repo-dir / repos-root cwds always exist, so this is skipped.
            if not is_root and not os.path.isdir(cwd):
                sess["baseRef"] = resolve_base_ref(repo_path, None)
                self._worktree_add(sess, base_ref=sess["baseRef"])
            self._remember_usage(sess)
            self._launch_tmux(sess, resume=True, resume_id=transcript_id)
            self._launch_ttyd(sess)
            log(f"resumed transcript {transcript_id} for {repo} in {cwd} "
                f"on :{sess['ttydPort']}")
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
            self._clear_question_files(sid)  # drop any question the old claude was blocked on
            self._launch_tmux(sess)         # drops bridge-pointer + new claude
            self._launch_ttyd(sess)         # (re)ensure ttyd if it had died
            sess["errorMsg"] = None
            # Monotonic restart marker: restart keeps id/rcName/worktree, so this
            # counter is the only heartbeat-visible signal that the relaunch
            # actually happened — the hub clears its "Restarting…" spinner the
            # moment it changes instead of waiting out a blind timer.
            sess["restartCount"] = sess.get("restartCount", 0) + 1
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
        """Type free-text into a running session's Claude TUI via tmux send-keys:
        one literal keystroke send (-l — no key-name interpretation, no shell)
        followed by a separate Enter. This is the plain "type a message into the
        session" path (the glasses actions-menu Send); AskUserQuestion answers
        no longer ride it — they go through answer_question below. `--` ends
        tmux's own option parsing before the literal text so a typed string that
        happens to start with '-' isn't misread as more send-keys flags; -l
        still applies to everything after it."""
        sess = self._find(sid)
        if not sess or sess.get("status") != "running":
            return
        text = text.replace("\r\n", " ").replace("\r", " ").replace("\n", " ")
        if not text.strip():
            return
        text = text[:INPUT_MAX_CHARS]
        # Name a still-unnamed session (bare/quick spawn or repos-root, where the
        # spawn-time summary was a no-op for lack of an initial prompt) from its
        # first typed prompt — this message is our next chance. Deliberately the
        # FIRST attempt only: this is a fast path that saves waiting a beat for
        # _seed_summaries, and later attempts belong there, where the transcript
        # still names the session from its first prompt rather than from whatever
        # turn happens to be typed when a retry comes due.
        if (not sess.get("summary") and _summary_attempts(sess) == 0
                and sid not in self.summaries):
            self._start_summary(sess, text)
        tmux_name = sess["tmuxName"]
        run(["tmux", "send-keys", "-t", tmux_name, "-l", "--", text])
        run(["tmux", "send-keys", "-t", tmux_name, "Enter"])

    def set_model(self, sid, model):
        """Switch a running session's model live by typing `/model <name>` into
        its Claude TUI — the CLI applies it immediately (no picker). `default`
        (or blank) resets to claude's own default model. Validation reuses
        resolve_model, so only an allowlisted alias/`default` ever reaches the
        pane, and the resolved value is stored back on the record so the
        heartbeat/UI reflect the new model."""
        sess = self._find(sid)
        if not sess or sess.get("status") != "running":
            return
        resolved = resolve_model(model)  # None for default, else alias; raises on junk
        arg = resolved or "default"
        tmux_name = sess["tmuxName"]
        run(["tmux", "send-keys", "-t", tmux_name, "-l", "--", f"/model {arg}"])
        run(["tmux", "send-keys", "-t", tmux_name, "Enter"])
        sess["model"] = resolved
        self.save()
        log(f"set model of {sid} -> {arg}")

    def set_mode(self, sid, mode):
        """Switch a running session's permission mode live by injecting the number
        of Shift+Tab (BTab) presses that cycles it from its current mode to the
        target. Claude Code exposes no set-mode-by-name command (only `/plan`), so
        cycling is the only live path — but the cycle a session exposes is
        launch-dependent (bypassPermissions/auto are in it only when launched into
        them), so the presses are computed against THIS session's real cycle
        (`perm_cycle_for(launchPermissionMode)`), which is what makes the switch
        land on the chosen mode instead of drifting. A target the session's cycle
        can't reach (e.g. bypassPermissions on an auto-launched session) is a no-op:
        the record keeps the real mode, so the heartbeat corrects the UI's
        optimistic guess. On success the target (validated) is stored so the UI
        reflects it."""
        sess = self._find(sid)
        if not sess or sess.get("status") != "running":
            return
        target = resolve_permission_mode(mode)  # validated enum; raises on junk
        current = sess.get("permissionMode") or "auto"
        if current == target:
            return
        cycle = perm_cycle_for(sess.get("launchPermissionMode"))
        if current not in cycle or target not in cycle:
            log(f"set mode of {sid}: {current}->{target} not both reachable in "
                f"cycle {cycle}; skipping")
            return
        presses = (cycle.index(target) - cycle.index(current)) % len(cycle)
        tmux_name = sess["tmuxName"]
        for _ in range(presses):
            run(["tmux", "send-keys", "-t", tmux_name, "BTab"])
        sess["permissionMode"] = target
        self.save()
        log(f"set mode of {sid} -> {target} ({presses} Shift+Tab)")

    def _question_paths(self, sid):
        """(req, ans) rendezvous file paths for a session's pending question."""
        return (
            os.path.join(QUESTIONS_DIR, f"{sid}.req.json"),
            os.path.join(QUESTIONS_DIR, f"{sid}.ans.json"),
        )

    def _clear_question_files(self, sid):
        """Drop any pending question rendezvous files for a session (on kill /
        delete) so a stale question can't linger or be answered into a dead
        hook. Best-effort — a missing file is fine."""
        for path in self._question_paths(sid):
            try:
                os.remove(path)
            except OSError:
                pass

    def _tmux_alive(self, tmux_name):
        """Whether the session's claude tmux is still up. The claude process is
        that tmux session's only command, so a missing session means claude
        exited (a killed/crashed/finished turn)."""
        if not tmux_name:
            return False
        rc, _ = run_ok(["tmux", "has-session", "-t", tmux_name], timeout=5)
        return rc == 0

    def _sweep_orphan_questions(self):
        """Clear AskUserQuestion rendezvous files whose owning ask.py bridge can
        no longer be blocking on them. The bridge lives inside the session's
        claude tmux and cleans up its own req/ans files when it unblocks; but a
        turn that dies WITHOUT routing through our kill/restart cleanup (claude
        crashed or exited on its own) strands them, and a stranded req is exactly
        how a question the agent has already moved past keeps showing as pending.
        For every session id with a leftover file, if the session isn't running
        or its claude tmux is gone, no live bridge owns the file — drop it. A
        still-running session with a live tmux is left alone (a real pending
        question, or a multi-question flow mid-advance). _hook_question's own
        answered/stale guards cover the narrower window where the tmux is still
        up but the bridge died; this closes the common session-ended case fast
        and keeps the rendezvous dir from accumulating orphans."""
        try:
            names = os.listdir(QUESTIONS_DIR)
        except OSError:
            return
        sids = {
            name[: -len(sfx)]
            for name in names
            for sfx in (".req.json", ".ans.json")
            if name.endswith(sfx)
        }
        for sid in sids:
            sess = self._find(sid)
            if sess and sess.get("status") == "running" \
                    and self._tmux_alive(sess.get("tmuxName")):
                continue  # a live bridge may still own it
            self._clear_question_files(sid)

    def answer_question(self, sid, option_index, custom):
        """Answer a session's pending AskUserQuestion by dropping the answer file
        the ask.py bridge is polling for. option_index is 0-based into the
        question's options (or -1 for a free-text / "Other" answer carried in
        custom). Only writes when a request file is actually pending, so a stray
        answer for a session with no live question is a no-op. Written
        atomically (temp + replace) so the blocked hook never reads a partial."""
        sess = self._find(sid)
        if not sess or sess.get("status") != "running":
            return
        req_path, ans_path = self._question_paths(sid)
        if not os.path.exists(req_path):
            return  # nothing waiting on this session
        try:
            idx = int(option_index)
        except (TypeError, ValueError):
            idx = -1
        answer = {"optionIndex": idx}
        if isinstance(custom, str) and custom.strip():
            answer["custom"] = custom[:INPUT_MAX_CHARS]
        elif idx < 0:
            return  # no option and no text — nothing to answer with
        try:
            tmp = f"{ans_path}.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(answer, f)
            os.replace(tmp, ans_path)
        except OSError as e:
            log(f"answer_question write failed for {sid}: {e}")

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

    # --- durable archive sync ---------------------------------------------
    # Ship every INACTIVE session's transcript to the hub so history is durable
    # (survives this host being wiped/offline) and searchable there. The agent
    # is outbound-only, so it pushes: a manifest of what it has rides the slow
    # heartbeat, the hub replies with per-transcript byte cursors (archiveHave),
    # and the agent POSTs the missing append-only byte-range deltas.

    def _running_slugs(self):
        """Project slugs backing a currently-RUNNING session — excluded from the
        archive (their transcript is still being written; sync it once it ends)."""
        slugs = set()
        for s in self.registry:
            if s.get("status") != "running":
                continue
            wt = s.get("worktreePath") or (REPOS_ROOT if s.get("root") else None)
            if wt:
                slugs.add(_project_slug(wt))
        return slugs

    def _session_meta_by_slug(self):
        """slug -> {createdAt, summary} drawn from live + closed session records,
        so an archived transcript inherits its session's date and task name.
        Newest record wins on collision (multiple sessions per worktree slug)."""
        meta = {}
        for rec in list(self.registry) + list(self.closed):
            wt = rec.get("worktreePath") or (REPOS_ROOT if rec.get("root") else None)
            if not wt:
                continue
            slug = _project_slug(wt)
            summary = rec.get("summary") or rec.get("label")
            cur = meta.get(slug)
            created = rec.get("createdAt")
            if cur is None or (created and created >= (cur.get("createdAt") or "")):
                meta[slug] = {"createdAt": created, "summary": summary}
            elif summary and not cur.get("summary"):
                cur["summary"] = summary
        return meta

    def _resumable_cwd_class(self, cwd, repo_names):
        """Classify a transcript's origin cwd for the resume picker, or None when
        it isn't resumable on this host. Returns (repo, origin_label, is_root):
          - cwd == REPOS_ROOT           -> (ROOT_REPO_NAME, "repos root", True)
          - cwd under WORKTREES_ROOT    -> (<repo>, <worktree-dir>, False)
          - cwd == REPOS_ROOT/<repo>    -> (<repo>, "repo dir", False)
          - anything else (a foreign dev-machine path, or a deeper subdir) -> None
        Paths are normalized so a trailing slash / '..' can't slip a cwd past the
        containment checks. WORKTREES_ROOT lives under REPOS_ROOT, so it must be
        tested before the plain repo-dir case; the repo-dir case additionally
        requires a single segment that names a real scanned repo (so `.turma`
        and nested subdirs are excluded)."""
        if not cwd:
            return None
        norm = os.path.normpath(cwd)
        if norm == os.path.normpath(REPOS_ROOT):
            return (ROOT_REPO_NAME, "repos root", True)
        wt_root = os.path.normpath(WORKTREES_ROOT)
        if norm.startswith(wt_root + os.sep):
            rel = norm[len(wt_root) + 1:].split(os.sep)
            if len(rel) == 2 and rel[0] and rel[1]:   # <repo>/<worktree-id>
                return (rel[0], rel[1], False)
            return None
        root = os.path.normpath(REPOS_ROOT)
        if norm.startswith(root + os.sep):
            rel = norm[len(root) + 1:].split(os.sep)
            if len(rel) == 1 and rel[0] in repo_names:
                return (rel[0], "repo dir", False)
        return None

    def _find_transcript_dir(self, transcript_id):
        """The PROJECTS_ROOT/<slug> dir holding <transcript_id>.jsonl, or None —
        used to resume a picked transcript whose slug the caller didn't pin."""
        fname = transcript_id + ".jsonl"
        try:
            slugs = os.listdir(PROJECTS_ROOT)
        except OSError:
            return None
        for slug in slugs:
            if os.path.isfile(os.path.join(PROJECTS_ROOT, slug, fname)):
                return os.path.join(PROJECTS_ROOT, slug)
        return None

    def _resumable_report(self):
        """Per-repo list of EVERY prior Claude session resumable on this host —
        the "Resume any session" picker's source, not just the last-5 killed
        Turma sessions in closed.json. Enumerates transcripts under PROJECTS_ROOT
        and keeps those whose ORIGIN cwd (_transcript_cwd, falling back to the
        ledger's real-path key) is resumable here — a Turma worktree, a repo-dir
        "terminal" run, or the repos-root pseudo-repo (see _resumable_cwd_class).
        A dev-machine session synced through the shared ~/.claude has a foreign
        cwd and is skipped: visible in history/search, resumable only where it
        ran. Transcripts backing a registered session (running or stopped — they
        already have a card with Start) are skipped. Capped to the newest
        RESUMABLE_PER_REPO per repo to bound the heartbeat; the summary read is
        deferred until after the cap so it's paid only for the survivors.

        Returns repo-name -> [{transcriptId, cwd, repo, root, origin, summary,
        endedTs}] newest-first."""
        # Slugs already represented by a session card (running or stopped).
        carded = set()
        for s in self.registry:
            wt = s.get("worktreePath") or (REPOS_ROOT if s.get("root") else None)
            if wt:
                carded.add(_project_slug(wt))
        repo_names = {r["name"] for r in scan_repos()}
        # slug -> a real worktree path the ledger recorded, so a transcript whose
        # own cwd we can't read still classifies when the ledger keyed its path.
        slug_path = {}
        for wt, m in (self.usage_ledger or {}).items():
            slug = (m or {}).get("slug") or _project_slug(wt)
            slug_path.setdefault(slug, wt)

        by_repo = {}
        try:
            slugs = os.listdir(PROJECTS_ROOT)
        except OSError:
            slugs = []
        for slug in slugs:
            if slug in carded:
                continue
            proj = os.path.join(PROJECTS_ROOT, slug)
            try:
                names = [f for f in os.listdir(proj) if f.endswith(".jsonl")]
            except OSError:
                continue
            for fname in names:
                tid = fname[:-len(".jsonl")]
                # The id is interpolated onto the tmux command line at resume.
                if not re.fullmatch(r"[A-Za-z0-9-]+", tid):
                    continue
                path = os.path.join(proj, fname)
                cwd = _transcript_cwd(path)
                if not cwd:
                    lp = slug_path.get(slug)
                    cwd = lp if lp and _project_slug(lp) == slug else None
                cls = self._resumable_cwd_class(cwd, repo_names)
                if not cls:
                    continue
                repo, origin, root = cls
                try:
                    mtime = os.stat(path).st_mtime
                except OSError:
                    continue
                by_repo.setdefault(repo, []).append({
                    "transcriptId": tid,
                    "cwd": os.path.normpath(cwd),
                    "repo": repo,
                    "root": root,
                    "origin": origin,
                    "slug": slug,          # dropped below; picks the summary source
                    "mtime": mtime,        # dropped below; sort/cap key
                })
        sess_meta = self._session_meta_by_slug()
        for repo, lst in by_repo.items():
            lst.sort(key=lambda e: e["mtime"], reverse=True)
            del lst[RESUMABLE_PER_REPO:]
            for e in lst:
                sm = sess_meta.get(e["slug"], {})
                e["summary"] = sm.get("summary") or _first_user_text(
                    os.path.join(PROJECTS_ROOT, e["slug"], e["transcriptId"] + ".jsonl"))
                e["endedTs"] = time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime(e["mtime"]))
                e.pop("mtime", None)
                e.pop("slug", None)
        return by_repo

    def _archive_manifest(self):
        """Manifest of inactive-session transcripts eligible for archive: enumerate
        every ledger slug's *.jsonl, attribute it to a repo via the durable usage
        ledger, skip transcripts backing a running session, and cap to the newest
        ARCHIVE_MANIFEST_MAX (scalars only — bounds the heartbeat)."""
        running = self._running_slugs()
        sess_meta = self._session_meta_by_slug()
        # slug -> {repo, remoteKey, worktree}, from the durable attribution ledger.
        slug_attr = {}
        for wt, m in (self.usage_ledger or {}).items():
            m = m or {}
            slug = m.get("slug") or _project_slug(wt)
            slug_attr[slug] = {
                "repo": m.get("repo") or "?",
                "remoteKey": normalize_remote(m.get("remote")) or (m.get("repo") or "?"),
                "worktree": wt,
            }
        out = []
        for slug, attr in slug_attr.items():
            if slug in running:
                continue
            proj = os.path.join(PROJECTS_ROOT, slug)
            try:
                names = os.listdir(proj)
            except OSError:
                continue
            sm = sess_meta.get(slug, {})
            for fname in names:
                if not fname.endswith(".jsonl"):
                    continue
                path = os.path.join(proj, fname)
                try:
                    st = os.stat(path)
                except OSError:
                    continue
                out.append({
                    "transcriptId": fname[:-6],  # strip ".jsonl"
                    "slug": slug,
                    "repo": attr["repo"],
                    "remoteKey": attr["remoteKey"],
                    "worktree": attr["worktree"],
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "endedTs": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime)),
                    "createdAt": sm.get("createdAt"),
                    "summary": sm.get("summary"),
                })
        out.sort(key=lambda m: m["mtime"], reverse=True)
        out = out[:ARCHIVE_MANIFEST_MAX]
        for m in out:
            m.pop("mtime", None)  # internal sort key; not part of the payload
        return out

    def _archive_deltas(self, archive_have):
        """Push the byte-range deltas the hub is missing for each manifest entry,
        using the archiveHave cursors it returned. Append-only and bounded: at most
        ARCHIVE_BEAT_BUDGET bytes per pass, so a big backfill trickles across beats.
        A failed POST just stops this pass — the next manifest re-offers it."""
        if not self._archive_pending:
            return
        budget = ARCHIVE_BEAT_BUDGET
        for tid, m in list(self._archive_pending.items()):
            have = int((archive_have or {}).get(tid, 0) or 0)
            size = int(m.get("size", 0))
            if have >= size:
                continue
            path = os.path.join(PROJECTS_ROOT, m["slug"], tid + ".jsonl")
            meta = {
                "remoteKey": m.get("remoteKey"), "repo": m.get("repo"),
                "worktree": m.get("worktree"), "slug": m.get("slug"),
                "createdAt": m.get("createdAt"), "endedTs": m.get("endedTs"),
                "summary": m.get("summary"),
            }
            while have < size and budget > 0:
                try:
                    with open(path, "rb") as f:
                        f.seek(have)
                        raw = f.read(ARCHIVE_CHUNK_BYTES)
                except OSError:
                    break
                if not raw:
                    break
                nl = raw.rfind(b"\n")
                if nl < 0:
                    break  # no complete line in the window (pathological); skip
                complete = raw[:nl + 1]
                end = have + len(complete)
                entries = []
                for line in complete.split(b"\n"):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    text = _entry_text(entry)
                    # Rich path (parity with _history_entries): ship the full
                    # blocks[] — thinking, tool_use inputs, tool_result outputs —
                    # so the hub's chat UI renders an archived session exactly like
                    # a live one. FULL caps (the durable record is the fullest
                    # copy; the archive has no /history to expand into). Inclusion
                    # widens like _history_entries: a tool_result-only turn (text
                    # is None) still has blocks and is kept.
                    blocks = _entry_blocks(entry, BLOCK_CAPS_FULL)
                    if text is None and not blocks:
                        continue
                    entries.append({
                        "uuid": entry.get("uuid"),
                        "role": entry.get("type"),
                        "ts": entry.get("timestamp"),
                        "text": text or "",
                        "blocks": blocks or [],
                    })
                body = {"startOffset": have, "endOffset": end, "size": size,
                        "entries": entries, "meta": meta}
                reply = self._post_archive_chunk(tid, body)
                if reply is None:
                    return  # POST failed; retry on a later beat
                budget -= len(complete)
                new_have = int(reply.get("bytesStored", have) or have)
                if new_have <= have:
                    break  # no forward progress (offset realign / hub cursor) — stop
                have = new_have

    def _post_archive_chunk(self, transcript_id, body):
        """POST one archive delta to the hub. Returns the parsed reply
        ({bytesStored}) or None on failure."""
        try:
            headers = {"Content-Type": "application/json", "User-Agent": "hub-agent/1.0"}
            if TURMA_TOKEN:
                headers["Authorization"] = f"Bearer {TURMA_TOKEN}"
            url = (f"{TURMA_URL}/api/agents/{urllib.parse.quote(self.device, safe='')}"
                   f"/archive/{urllib.parse.quote(transcript_id, safe='')}")
            req = urllib.request.Request(
                url, data=json.dumps(body).encode(), headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=15) as resp:
                reply = json.loads(resp.read().decode() or "{}")
            return reply if isinstance(reply, dict) else {}
        except Exception as e:
            log(f"archive push failed for {transcript_id}: {e}")
            return None

    # --- GitHub clone-into-root -------------------------------------------

    def refresh_github(self):
        """Refresh the cached GitHub availability/repo-list block. Called on a
        slow cadence from build_payload; degrades to unavailable on any error."""
        try:
            self.github = collect_github()
        except Exception as e:
            log(f"github refresh failed: {e}")
            self.github = {"available": False, "login": None, "repos": []}

    def refresh_pr_status(self):
        """Refresh cached state + CI checks for the PRs live sessions opened, via
        `gh pr view`. Slow-ish cadence, best-effort; skipped when gh has no
        login. Only RUNNING sessions' PRs are re-polled (bounded by
        PR_STATUS_MAX so a host with many PRs never stalls the beat), but a
        stopped session keeps its last-known status — cache entries are pruned
        only when NO session (running or not) references them anymore, so a
        killed session's card still shows the merged/closed state it reached."""
        if not self.github.get("available"):
            return
        referenced, wanted, seen = set(), [], set()
        for sess in self.registry:
            urls = self.session_pr_urls.get(sess["id"], [])
            referenced.update(urls)
            if sess.get("status") != "running":
                continue
            for url in urls:
                if url not in seen:
                    seen.add(url)
                    wanted.append(url)
        for url in list(self.pr_status_cache):
            if url not in referenced:
                del self.pr_status_cache[url]
        for url in wanted[:PR_STATUS_MAX]:
            st = pr_status(url)
            if st is not None:
                self.pr_status_cache[url] = st

    def _session_prs(self, sid):
        """The PR-status objects for a session's known PR links, newest last
        (the order they were scraped). Each is the cached `gh pr view` summary,
        or a bare {url} until the next status refresh fills it in. None when the
        session has opened no PR."""
        urls = self.session_pr_urls.get(sid)
        if not urls:
            return None
        return [self.pr_status_cache.get(u) or {"url": u} for u in urls]

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
        """Kick off a `claude -p` (Haiku) to name a session from its initial
        prompt, as a DETACHED subprocess reaped by _poll_summaries. No-op when
        there's no prompt to summarize (bare spawns, repos-root) — that costs no
        attempt, since there was nothing to name yet. Best-effort: a launch
        failure spends an attempt and schedules the next one, so a transient
        failure doesn't leave the session unnamed for good."""
        prompt = (prompt or "").strip()
        if not prompt:
            return
        sid = sess["id"]
        out_path = os.path.join(REGISTRY_DIR, f"summary-{slugify(sid)}.out")
        outf = None
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
            if outf is not None:
                try:
                    outf.close()
                except Exception:
                    pass
            self._spend_summary_attempt(sess)
            return
        self.summaries[sid] = {
            "proc": proc, "outf": outf, "outPath": out_path,
            "startedMono": time.time(),
        }
        self._spend_summary_attempt(sess)
        attempts = _summary_attempts(sess)
        log(f"summarizing session {sid} via claude -p ({SESSION_SUMMARY_MODEL}), "
            f"attempt {attempts}/{SUMMARY_MAX_ATTEMPTS}")

    def _spend_summary_attempt(self, sess):
        """Count a naming attempt against a session and arm the backoff for the
        next one. Persisted, so a manager restart mid-attempt can neither lose the
        count (and retry forever) nor skip the retries still owed."""
        sess["summaryAttempts"] = _summary_attempts(sess) + 1
        sess["summaryStarted"] = True  # kept for older readers of the registry
        # Armed up-front rather than on failure: if the manager dies while this
        # attempt is in flight the job is lost with it, and the backoff is what
        # makes the reload retry once instead of immediately.
        sess["summaryRetryAt"] = (
            time.time() + SUMMARY_RETRY_BACKOFF_SEC * sess["summaryAttempts"]
        )
        self.save()

    def _finish_summary(self, sid, job, summary):
        """Tear down a summary job's file handle + temp output and, if we got a
        name, store it on the session record (persisted so it survives beats,
        restarts, and resume). With no name, leave the session for the retry the
        attempt counter still owes it (_seed_summaries picks it back up once the
        backoff elapses) — an empty reply, a nonzero exit or a rate limit is a
        property of the attempt, not of the session."""
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
            sess.pop("summaryRetryAt", None)
            self.save()
            log(f"named session {sid}: {summary!r}")
            return
        attempts = _summary_attempts(sess)
        if attempts >= SUMMARY_MAX_ATTEMPTS:
            log(f"giving up naming session {sid} after {attempts} attempts")
        else:
            log(f"summary attempt {attempts} for {sid} produced no name; "
                f"retrying in ~{SUMMARY_RETRY_BACKOFF_SEC * attempts}s")

    def _seed_summaries(self):
        """Name any running, still-unnamed session from the first user message in
        its transcript — the input-channel-agnostic naming path, run every beat.

        A session spawned with no initial prompt (the one-click bare spawn, the
        repos-root pseudo-repo) has nothing to summarize at spawn, and its first
        prompt usually arrives by the user typing into the live ttyd terminal,
        which goes straight to the tmux pane and never reaches send_input — so the
        send_input trigger alone never fires for the most common flow. Reading the
        transcript catches the first prompt no matter how it was entered (terminal,
        glasses/compose-bar input, or a resumed session).

        This is also where a failed naming attempt gets retried, for a session
        spawned WITH an initial prompt just as much as a bare one: the transcript
        holds that same first prompt, so re-reading it is all a retry needs. Gated
        by _summary_due (unnamed + attempts left + past the backoff) plus the
        in-flight check, so at most SUMMARY_MAX_ATTEMPTS `claude -p` calls ever run
        for a session and they stay spaced out. Until a first prompt lands it finds
        nothing, spends no attempt, and looks again next beat."""
        now = time.time()
        for sess in self.registry:
            if sess.get("status") != "running":
                continue
            if not _summary_due(sess, now):
                continue
            if sess["id"] in self.summaries:
                continue
            path = _newest_transcript_path(sess["worktreePath"])
            if not path:
                continue
            text = _first_user_text(path)
            if text:
                self._start_summary(sess, text)

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
            else:
                log(f"summary for {sid} exited {rc}")
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
        # Short-bounded: prune runs on the main loop, so a slow fetch must not
        # stall the heartbeat — a stale/failed fetch just compares against the
        # refs we already have.
        if default and valid_ref_name(default):
            run_ok(["git", "-C", path, "fetch", "--prune", "origin"],
                   timeout=FETCH_TIMEOUT_SEC)
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
                        cmd_id=cid,
                    )
                elif ctype == "kill":
                    self.kill(cmd.get("sessionId"))
                elif ctype == "start":
                    self.start(cmd.get("sessionId"))
                elif ctype == "restart":
                    self.restart(cmd.get("sessionId"))
                elif ctype == "resume":
                    self.resume(cmd.get("sessionId"))
                elif ctype == "resumeTranscript":
                    self.resume_transcript(
                        cmd.get("transcriptId"), cmd.get("cwd"), cmd_id=cid)
                elif ctype == "delete":
                    self.delete(cmd.get("sessionId"))
                elif ctype == "input":
                    self.send_input(cmd.get("sessionId"), cmd.get("text") or "")
                elif ctype == "setModel":
                    self.set_model(cmd.get("sessionId"), cmd.get("model"))
                elif ctype == "setMode":
                    self.set_mode(cmd.get("sessionId"), cmd.get("permissionMode"))
                elif ctype == "answerQuestion":
                    self.answer_question(
                        cmd.get("sessionId"),
                        cmd.get("optionIndex"),
                        cmd.get("custom"),
                    )
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
        """Per-session usage for the session card, parsed incrementally: folds
        only the bytes appended to this worktree's transcripts since the last
        beat (see _fold_slug), rather than re-reading them from scratch."""
        try:
            slug = _project_slug(worktree)
            if not os.path.isdir(os.path.join(PROJECTS_ROOT, slug)):
                self.usage_cache[sid] = None
                return
            self.usage_cache[sid] = _finalize_usage(self._fold_slug(slug))
        except Exception as e:
            log(f"usage parse failed for {sid}: {e}")

    def _fold_slug(self, slug):
        """Return a project slug's persistent usage accumulator, folding any
        bytes appended to its transcripts since the last beat (incremental).
        Rebuilt from scratch if a transcript was truncated/rewritten so totals
        can't overcount. Shared by per-session usage and the per-repo/host
        aggregation, so each transcript is parsed at most once per beat."""
        st = self.slug_usage.get(slug)
        if st is None:
            st = self.slug_usage[slug] = {"acc": _UsageAcc(), "offsets": {}}
        proj = os.path.join(PROJECTS_ROOT, slug)
        if not _aggregate_project(proj, st["acc"], st["offsets"]):
            # A tracked transcript shrank/vanished — start this slug over so the
            # running total still matches a from-scratch parse.
            st = self.slug_usage[slug] = {"acc": _UsageAcc(), "offsets": {}}
            _aggregate_project(proj, st["acc"], st["offsets"])
        return st["acc"]

    def _backfill_ledger(self):
        """Ensure live and recently-closed sessions are in the attribution
        ledger — covers the first run after upgrade (ledger empty but transcripts
        already on disk) and any session predating _remember_usage."""
        changed = False
        for s in list(self.registry) + list(self.closed):
            path = s.get("worktreePath")
            if not path or path in self.usage_ledger:
                continue
            remote = ""
            try:
                remote = run(["git", "remote", "get-url", "origin"],
                             cwd=s.get("repoPath") or path) or ""
            except Exception:
                pass
            self.usage_ledger[path] = {
                "repo": s.get("repo"),
                "remote": remote,
                "slug": _project_slug(path),
            }
            changed = True
        if changed:
            self._save_ledger()

    def _existing_worktree_attrib(self):
        """Map project-slug -> (repo, worktreePath) for every worktree still on
        disk under WORKTREES_ROOT, plus the repos-root pseudo-repo. Built the
        non-lossy way (path -> slug), so a transcript slug that matches here can
        be attributed exactly, using the worktree's own git origin as the
        remote. Used by _reconcile_orphan_transcripts."""
        by_slug = {}
        try:
            repos = os.listdir(WORKTREES_ROOT)
        except OSError:
            repos = []
        for repo in repos:
            rd = os.path.join(WORKTREES_ROOT, repo)
            if not os.path.isdir(rd):
                continue
            try:
                sids = os.listdir(rd)
            except OSError:
                continue
            for sid in sids:
                wt = os.path.join(rd, sid)
                if os.path.isdir(wt):
                    by_slug[_project_slug(wt)] = (repo, wt)
        # Root sessions run in REPOS_ROOT itself (no worktree).
        by_slug.setdefault(_project_slug(REPOS_ROOT), (ROOT_REPO_NAME, REPOS_ROOT))
        return by_slug

    def _repo_from_transcript_cwd(self, proj):
        """Best-effort repo name for a transcript that no worktree map or slug
        shape identifies, read from the session's own recorded cwd (Claude Code
        stamps `cwd` on transcript entries). The cwd is the real, un-slugified
        working dir, so its final path segment names the repo far better than
        the lossy project slug can (…/personal/ClaudeHUD -> "ClaudeHUD"). Splits
        on both separators, since a shared ~/.claude login also carries the
        operator's own dev-machine sessions with Windows paths. Returns None when
        no entry within a bounded head-scan records a cwd."""
        try:
            files = [f for f in os.listdir(proj) if f.endswith(".jsonl")]
        except OSError:
            return None
        if not files:
            return None
        newest = max(files,
                     key=lambda f: os.path.getmtime(os.path.join(proj, f)))
        cwd = _transcript_cwd(os.path.join(proj, newest))
        if not cwd:
            return None
        name = re.split(r"[\\/]+", str(cwd).strip().rstrip("\\/"))[-1]
        return name or None

    def _reconcile_orphan_transcripts(self):
        """Adopt EVERY transcript sitting in PROJECTS_ROOT that no ledger entry
        covers, so persistent usage/cost reflects every session on disk — not
        only sessions in the live registry or the last-5 closed history that
        _backfill_ledger sees. A session killed long ago (its card gone, its
        worktree maybe surviving) or one predating _remember_usage would
        otherwise silently drop out of the totals, since repo_usage_report only
        folds slugs the ledger names. Nothing is excluded — an unattributable
        transcript still counts under OTHER_REPO_NAME rather than being dropped.

        Attribution, most precise first:
          1. slug matches a worktree still on disk -> exact repo + git remote,
             keyed by the real worktree path (same fidelity as _remember_usage,
             and dedups with a future spawn there).
          2. slug has the .../worktrees/<repo>/<id> shape but the worktree is
             gone (a deleted Turma worktree, or a sibling tool's session) ->
             repo recovered from the slug; remote read from the repo dir under
             REPOS_ROOT if it's still there, else left empty (the hub then
             unifies cross-host by repo name, like any remote-less entry).
          3. neither of those (a bare `claude` run, or the operator's own
             dev-machine session on the shared login) -> repo read from the
             transcript's recorded cwd (_repo_from_transcript_cwd).
          4. still nothing (no cwd recorded) -> bucketed under OTHER_REPO_NAME
             so it always counts.
        New entries are persisted and keyed so _prune_ledger removes them once
        the transcript dir finally disappears."""
        try:
            names = os.listdir(PROJECTS_ROOT)
        except OSError:
            return
        known = {(m or {}).get("slug") or _project_slug(p)
                 for p, m in self.usage_ledger.items()}
        existing = None  # built lazily — the listdirs aren't free
        added = False
        for slug in names:
            proj = os.path.join(PROJECTS_ROOT, slug)
            if slug in known or not os.path.isdir(proj):
                continue
            try:
                if not any(f.endswith(".jsonl") for f in os.listdir(proj)):
                    continue  # no transcript here — nothing to attribute
            except OSError:
                continue
            if existing is None:
                existing = self._existing_worktree_attrib()
            if slug in existing:                                  # case 1
                repo, wt = existing[slug]
                remote = ""
                try:
                    remote = run(["git", "remote", "get-url", "origin"],
                                 cwd=wt) or ""
                except Exception:
                    pass
                self.usage_ledger[wt] = {
                    "repo": repo, "remote": remote, "slug": slug}
                known.add(slug)
                added = True
                continue
            # slug shape (case 2), then the recorded cwd (case 3), then the
            # catch-all (case 4) — either way it's adopted, nothing is dropped.
            repo = (_repo_from_worktree_slug(slug)
                    or self._repo_from_transcript_cwd(proj)
                    or OTHER_REPO_NAME)
            remote = ""
            repo_dir = os.path.join(REPOS_ROOT, repo)
            if os.path.isdir(repo_dir):
                try:
                    remote = run(["git", "remote", "get-url", "origin"],
                                 cwd=repo_dir) or ""
                except Exception:
                    pass
            # Worktree gone, so no real path to key on — key by the project dir;
            # the stored slug keeps _prune_ledger/repo_usage_report resolving it.
            self.usage_ledger[proj] = {
                "repo": repo, "remote": remote, "slug": slug}
            known.add(slug)
            added = True
        if added:
            self._save_ledger()

    def _refresh_repo_usage(self):
        """Recompute the persistent host/repo usage from every known transcript.
        Independent of the live registry, so killed/deleted sessions still count.
        Runs on the slow usage cadence; folds each slug incrementally (only bytes
        appended since the last beat) via _fold_slug, so it no longer re-reads
        every transcript from scratch."""
        self._backfill_ledger()
        self._reconcile_orphan_transcripts()
        self._prune_ledger()
        try:
            self.repo_usage, self.host_usage = repo_usage_report(
                self.usage_ledger, self._fold_slug)
        except Exception as e:
            log(f"repo usage parse failed: {e}")
        # The "resume any prior session" picker's per-repo list, computed on the
        # same slow cadence and reported (from cache) every beat.
        try:
            self.resumable = self._resumable_report()
        except Exception as e:
            log(f"resumable scan failed: {e}")

    def _session_git(self, sess, refresh):
        """(git-info dict | None, branch-sync work dict) for a session's payload.
        The CHEAP current-branch + dirty reads run every beat; the SLOW facts —
        repo name / remote URL / last-commit line, and the branch<->base/origin
        sync counts — are cached and only recomputed on the slow cadence
        (`refresh`), when the session is first seen, or when its live branch
        changed (so a session that just named its work branch updates promptly
        without re-walking refs every beat)."""
        sid = sess["id"]
        gi = git_info_cheap(sess["worktreePath"])  # None if the worktree is gone
        # The app owns no branch, so the branch to report is the LIVE one the
        # running agent named for its work ("HEAD" = still detached, not yet
        # branched -> no branch to sync).
        live_branch = gi.get("branch") if gi else None
        if live_branch == "HEAD":
            live_branch = None
        cached = self.session_facts.get(sid)
        if refresh or cached is None or cached.get("liveBranch") != live_branch:
            # Compare the live branch against what the session forked from
            # (baseRef, e.g. origin/main), falling back to the repo's current
            # checkout when we didn't record a base.
            base = sess.get("baseRef") or run(
                ["git", "-C", sess["repoPath"], "rev-parse", "--abbrev-ref", "HEAD"])
            cached = {
                "liveBranch": live_branch,
                "slow": git_info_slow(sess["worktreePath"]),
                "work": branch_sync(sess["repoPath"], live_branch, base or None),
            }
            self.session_facts[sid] = cached
        if gi is not None:
            gi.update(cached["slow"])  # fold cached repoName/remote/lastCommit in
        return gi, cached["work"]

    def _session_payload(self, sess, refresh=True):
        sid = sess["id"]
        running = sess.get("status") == "running"
        signals = None
        if running:
            try:
                st = self.sess_state.setdefault(sid, {})
                signals = session_report(sess["worktreePath"], st, sess.get("tmuxName"),
                                         session_id=sess.get("id"))
                pend = self.pending_prs.setdefault(sid, [])
                pend.extend(signals.pop("prUrls"))
                del pend[:-10]
                signals["newPrUrls"] = list(pend)
                # Also remember them persistently: pending_prs is cleared on the
                # next delivered beat, so the durable PR-status feature reads from
                # session_pr_urls instead (deduped, newest-last, capped).
                if pend:
                    known = self.session_pr_urls.setdefault(sid, [])
                    for url in pend:
                        if url not in known:
                            known.append(url)
                    del known[:-10]
            except Exception as e:
                log(f"session probe failed for {sid}: {e}")
                signals = None
        gi, work = self._session_git(sess, refresh)
        return {
            "id": sid,
            "repo": sess["repo"],
            "repoPath": sess["repoPath"],
            "worktreePath": sess["worktreePath"],
            "branch": sess["branch"],           # app branch: always None now
            "root": sess.get("root", False),
            "rcName": sess["rcName"],
            "restartCount": sess.get("restartCount", 0),  # bumps on clear-context restart
            "label": sess.get("label"),
            "summary": sess.get("summary"),   # few-word auto task name (or None)
            # The hub command that created this session (spawn / resumeTranscript),
            # so the UI that issued it can find the id the agent minted and open
            # the session. None for sessions predating the echo, or restored ones.
            "spawnCmdId": sess.get("spawnCmdId"),
            "model": sess.get("model"),
            "permissionMode": sess.get("permissionMode"),
            # The permission modes this session's live Shift+Tab cycle can reach
            # (base modes + whichever optional it was launched into) — the hub's
            # mode selector offers only these, since a switch to any other mode is
            # a no-op agent-side. Launch-dependent; see perm_cycle_for / set_mode.
            "permissionModes": perm_cycle_for(sess.get("launchPermissionMode")),
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
            "work": work,
            "usage": self.usage_cache.get(sid),     # present for stopped too
            # PR links this session opened + their state/CI checks (from
            # pr_status_cache). Kept even after the session stops, as long as the
            # session record survives. None until it opens a PR.
            "prs": self._session_prs(sid),
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

    def _repo_activity(self):
        """repo-name -> newest session-activity ISO ts, the "used" half of the
        repo activity ranking. Live sessions contribute their transcript's
        lastActivity (from the usage cache); closed sessions fall back to when
        they were killed. '' for a repo with no session history."""
        activity = {}
        for s in self.registry:
            repo = s.get("repo")
            u = self.usage_cache.get(s["id"]) or {}
            ts = u.get("lastActivity") or s.get("createdAt") or ""
            if repo and ts > activity.get(repo, ""):
                activity[repo] = ts
        for c in self.closed:
            repo = c.get("repo")
            ts = c.get("closedAt") or c.get("createdAt") or ""
            if repo and ts > activity.get(repo, ""):
                activity[repo] = ts
        return activity

    def _repo_slow_facts(self, path, refresh):
        """Cached slow git facts for a repo (remote/branches/default/lastCommit).
        Recomputed on the slow cadence (`refresh`) or on the repo's first sight,
        so a freshly-cloned repo gets its facts on its first appearance rather
        than waiting up to USAGE_EVERY beats; reused from cache in between."""
        facts = self.repo_facts.get(path)
        if refresh or facts is None:
            facts = repo_slow_facts(path)
            self.repo_facts[path] = facts
        return facts

    def _sorted_repo_entries(self, refresh=True):
        """Scanned repos ordered most-recently-active first (see #-activity-sort):
        each repo's lastActivity is the later of its newest commit ("modified")
        and its newest session activity ("used"). The root pseudo-repo is pinned
        first and never ranked. Ties (e.g. never-touched repos) keep the scan's
        alphabetical order, since Python's sort is stable. The cheap current-
        branch/dirty reads run every beat; the slow facts are cached (`refresh`)."""
        activity = self._repo_activity()
        repos = scan_repos()
        entries = [repo_entry(r, self._repo_slow_facts(r["path"], refresh))
                   for r in repos]
        # Drop cache entries for repos that are gone (renamed/removed).
        live_paths = {r["path"] for r in repos}
        self.repo_facts = {p: f for p, f in self.repo_facts.items()
                           if p in live_paths}
        for e in entries:
            e["lastActivity"] = max(
                e.get("lastCommit") or "", activity.get(e["name"], "")
            )
        entries.sort(key=lambda e: e.get("lastActivity") or "", reverse=True)
        out = [root_repo_entry()] + entries
        # Attach each repo's resumable-session list (cached; refreshed on the slow
        # cadence in _refresh_repo_usage) for the "Resume any session" picker.
        for e in out:
            e["resumable"] = self.resumable.get(e["name"], [])
        return out

    def _log_tail(self, beat, light):
        """This container's `docker logs` tail, throttled: recomputed every
        LOG_TAIL_EVERY beats (never on a `light` follow-up beat) and reused from
        cache in between — it changes slowly and isn't worth a subprocess a beat."""
        if not light and (beat % LOG_TAIL_EVERY == 0 or self.log_tail_cache is None):
            self.log_tail_cache = log_tail(self.agent_id)
        return self.log_tail_cache

    def build_payload(self, beat, light=False):
        """Assemble one heartbeat payload. `light` (the post-command extra beat,
        whose only job is to reflect command results fast) skips the expensive
        work — no slow-fact refresh, no `docker logs`, no gh sweep — and reuses
        the caches; a session/repo that first appears on that beat still gets its
        facts computed (cache-miss → compute now)."""
        # Slow-changing git facts (repo remote/branches/default/lastCommit,
        # per-session remote/lastCommit + branch-sync counts) refresh on the same
        # cadence as usage; the cheap branch/dirty reads stay every beat.
        refresh = (not light) and (beat % USAGE_EVERY == 0)

        # Persistent host/repo usage — the whole-fleet, session-independent
        # aggregation that survives kill/delete. On the slow cadence it folds
        # every ledger slug incrementally (only bytes appended since last beat),
        # so it no longer re-reads every transcript from scratch.
        if refresh:
            self._refresh_repo_usage()

        # Per-session usage is parsed incrementally now (cheap), but still
        # staggered per session (each refreshes on its own beat within the
        # USAGE_EVERY window instead of all at once) and always given a value on
        # first appearance.
        slot = beat % USAGE_EVERY
        for s in self.registry:
            sid = s["id"]
            if sid not in self.usage_cache or (
                    not light and _usage_slot(sid) == slot):
                self._refresh_usage(sid, s["worktreePath"])

        # GitHub availability/repo list refreshes on its own slow cadence (a few
        # gh calls); clone jobs are reaped every beat (cheap poll()s).
        if not light and beat % GITHUB_REFRESH_EVERY == 0:
            self.refresh_github()
        # PR state + CI checks for the links live sessions opened, on a faster
        # cadence than the github block so a card's merge/CI status stays live.
        if not light and beat % PR_STATUS_REFRESH_EVERY == 0:
            try:
                self.refresh_pr_status()
            except Exception as e:
                log(f"pr status refresh failed: {e}")
        self._poll_clones()
        self._poll_prunes()
        # Drop AskUserQuestion rendezvous files left behind by a turn that died
        # outside our kill/restart cleanup, so a long-answered/abandoned question
        # can't keep showing as pending on the card.
        self._sweep_orphan_questions()
        # Seed names for bare-spawned sessions from their transcript's first
        # prompt (channel-agnostic; the live terminal bypasses send_input), then
        # reap any finished naming subprocess.
        self._seed_summaries()
        self._poll_summaries()

        payload = {
            # `device` (the physical host name) is the hub's identity key; agentId
            # is only a last-resort fallback if the host name can't be read.
            "agentId": self.agent_id,
            "device": self.device,
            "startedAt": self.started_at,
            "claudeVersion": self.claude_version,
            "memory": memory_usage(),
            "logTail": self._log_tail(beat, light),
            "reposRoot": REPOS_ROOT,
            "repos": self._sorted_repo_entries(refresh),
            "sessions": [self._session_payload(s, refresh) for s in self.registry],
            "closedSessions": self._closed_payload(),
            # Persistent usage, independent of active sessions: per-repo (keyed by
            # normalized origin so the hub can unify a repo across hosts) plus this
            # host's merged total. Survives kill/delete/prune.
            "repoUsage": self.repo_usage,
            "usage": self.host_usage,
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
        # Archive sync manifest on the slow cadence: the inactive transcripts the
        # hub could pull. Remember it by id so the reply's archiveHave cursors map
        # back to each one for the delta push (in run_forever).
        if refresh:
            manifest = self._archive_manifest()
            self._archive_pending = {m["transcriptId"]: m for m in manifest}
            if manifest:
                payload["archiveManifest"] = manifest
        return payload

    def _clear_pending_prs(self):
        for urls in self.pending_prs.values():
            urls.clear()

    def post(self, payload):
        """POST one heartbeat. Returns the parsed reply dict, or None on failure
        (pending PR links are kept so they aren't lost on a failed beat)."""
        try:
            # Explicit User-Agent: TURMA_URL rides the Cloudflare tunnel, and
            # Cloudflare's Browser Integrity Check 403s (error 1010) the default
            # "Python-urllib/3.x" signature before it reaches the hub.
            headers = {"Content-Type": "application/json", "User-Agent": "hub-agent/1.0"}
            if TURMA_TOKEN:
                headers["Authorization"] = f"Bearer {TURMA_TOKEN}"
            req = urllib.request.Request(
                f"{TURMA_URL}/api/heartbeat",
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
            f"reporting to {TURMA_URL} as {self.device} (container {self.agent_id}); "
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
                # Push archive deltas the hub asked for (byte cursors on the reply).
                # Best-effort: a sync hiccup must never disrupt the beat loop.
                if reply.get("archiveHave"):
                    try:
                        self._archive_deltas(reply["archiveHave"])
                    except Exception as e:
                        log(f"archive sync failed: {e}")
                if self.handle_commands(reply.get("commands")):
                    # Fire an immediate extra heartbeat so the UI reflects the
                    # new session state fast (don't wait a whole interval). Its
                    # reply is processed once more; cmdId de-dup stops repeats.
                    # `light` keeps this follow-up cheap — its only job is to
                    # reflect the command results, reusing the caches.
                    reply2 = self.post(self.build_payload(beat, light=True))
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
