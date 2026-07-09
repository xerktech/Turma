#!/usr/bin/env python3
"""Session manager + heartbeat agent for the agent-hub dashboard.

ONE of these runs per physical host (started by entrypoint.sh, in the
FOREGROUND — it is the container's long-lived process). It replaces the old
"one container = one repo = one Claude session" model with a host-level
multiplexer:

  - Scans REPOS_ROOT (default /mnt/data/Docker/git) one level deep for git
    repos and reports them to the hub.
  - Owns a persisted session registry (~/.agenthub/sessions.json). Each session
    is a git *worktree* of a repo (branch agent/<id>) running its own
    `claude --remote-control` inside its own tmux (agent-<id>) served by its own
    ttyd (127.0.0.1:<ttydPort>, base path /term/<id>).
  - Executes hub-issued commands (spawn / kill / start / restart / delete /
    resume) that ride back on the heartbeat reply, with at-least-once cmdId
    de-dup.
  - Auto-resumes `running` sessions on boot — WITH their conversation
    (claude --resume against the worktree's newest transcript).
  - Remembers killed sessions (~/.agenthub/closed.json, newest 5 per repo) so
    the hub can offer a per-repo "Resume" picker that brings one back on its
    kept branch with its prior conversation.
  - POSTs a heartbeat to the hub every INTERVAL seconds carrying repos[] +
    sessions[] (per-session git / token-usage / live-session signals computed
    per worktree, so usage PERSISTS in history after a session is killed — the
    transcript under ~/.claude/projects outlives both the worktree files and
    the registry record).

Token usage is parsed from the transcript JSONLs under
/root/.claude/projects/<slug>/ (slug = worktree path with '/'->'-'); this is the
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
import socket
import subprocess
import sys
import time
import urllib.request
from collections import deque

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
# Where Claude Code keeps per-project transcript JSONLs (slug = cwd with
# '/'->'-'). Overridable so the test suite can point it at fixtures; unset in
# production, so the default is the real path.
PROJECTS_ROOT = os.environ.get("CLAUDE_PROJECTS_ROOT", "/root/.claude/projects")

# Delete guard: a session branch that still has unpushed/unmerged commits is
# parked as agent-trash/<id>-<epoch> instead of `branch -D`'d outright, then
# hard-deleted once it has sat in the trash longer than this many days
# (0 = prune trash eagerly). Fully pushed/merged branches skip the trash.
TRASH_RETENTION_DAYS = int(os.environ.get("TRASH_RETENTION_DAYS", "7"))
TRASH_PREFIX = "agent-trash/"
# Trash pruning rides the heartbeat loop; every N beats (~hourly at the 20s
# default interval) is plenty of resolution for a multi-day window.
TRASH_PRUNE_EVERY = 180

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


def normalize_branch_name(name, sid):
    """Resolve the session branch name. Blank -> agent/<id> (today's behavior).
    A custom name is allowlist-validated and forced under the fleet's agent/
    prefix (delete/resume/scan all key off it), de-duping an operator-supplied
    'agent/' so we never produce agent/agent/... . Raises ValueError on junk."""
    name = (name or "").strip()
    if not name:
        return f"agent/{sid}"
    core = name[len("agent/"):] if name.startswith("agent/") else name
    core = core.strip("/")
    if not core:
        return f"agent/{sid}"
    branch = f"agent/{core}"
    if not valid_ref_name(branch):
        raise ValueError(f"invalid branch name {name!r}")
    return branch


def resolve_base_ref(repo_path, base_ref):
    """Validate an operator-chosen base branch to fork the worktree from.
    Blank/HEAD -> None (fork off the repo's current HEAD, today's behavior).
    Otherwise the ref must be allowlist-clean AND actually resolve in the repo
    (a local branch or origin/<x>) before we hand it to `worktree add`."""
    base_ref = (base_ref or "").strip()
    if not base_ref or base_ref == "HEAD":
        return None
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


def device_name():
    # The physical host name the hub keys this agent by. Resolution order:
    #   1. /host/etc/hostname — the Linux host's hostname, bind-mounted in by the
    #      compose file (the container's own hostname is meaningless, all "agent").
    #   2. DEVICE_NAME — explicit override, and the way a Windows host supplies its
    #      name since there is no /host/etc/hostname to mount there.
    #   3. socket.gethostname() — the container/OS hostname. On Windows this is the
    #      container name (COMPUTERNAME); still a real, stable id and far better
    #      than the "unknown-device" placeholder we used to fall through to.
    for path in ("/host/etc/hostname",):
        try:
            with open(path) as f:
                name = f.read().strip()
                if name:
                    return name
        except OSError:
            pass
    name = os.environ.get("DEVICE_NAME", "").strip()
    if name:
        return name
    try:
        name = socket.gethostname().strip()
        if name:
            return name
    except OSError:
        pass
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
    slug = workdir.replace("/", "-")
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


def _last_entry(path):
    """Newest complete JSON line from the tail of a transcript JSONL."""
    try:
        with open(path, "rb") as f:
            f.seek(max(0, os.fstat(f.fileno()).st_size - 65536))
            lines = f.read().split(b"\n")
    except OSError:
        return None
    for raw in reversed(lines):
        raw = raw.strip()
        if not raw:
            continue
        try:
            return json.loads(raw)
        except ValueError:
            continue  # partial write at the tail, or the seek-point fragment
    return None


def session_report(workdir, state):
    """Cheap per-heartbeat session signals (stat + tail reads, no full parse).

    state carries per-file byte offsets between beats so the PR-URL scan only
    reads what was appended since the last beat. The first call primes the
    offsets to EOF for every existing transcript, so a restarted agent never
    replays PR links from old sessions.
    """
    slug = workdir.replace("/", "-")
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
        "prUrls": [],              # PR links newly appended since last beat
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
            if name.startswith(".") or name == ".agenthub":
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
    ref walk (no network). Excludes the fleet's own agent/ and agent-trash/
    branches: you fork off real base branches, not other sessions' worktrees."""
    out = run(["git", "-C", path, "for-each-ref", "--sort=-committerdate",
               "--format=%(refname:short)", "refs/heads"])
    branches = []
    for b in out.splitlines():
        b = b.strip()
        if not b or b.startswith("agent/") or b.startswith(TRASH_PREFIX):
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
        # Base-branch choices for the "New session" composer (#12).
        "branches": repo_branches(path),
    }


def prune_trash_branches():
    """Hard-delete agent-trash/* branches whose grace period has expired.

    delete() embeds the trash time as a unix-epoch suffix in the branch name
    (agent-trash/<id>-<epoch>); a trash branch without one (e.g. renamed by
    hand) falls back to its commit date. Runs on every delete and on a slow
    cadence in the heartbeat loop, across every scanned repo."""
    cutoff = time.time() - TRASH_RETENTION_DAYS * 86400
    for repo in scan_repos():
        out = run(["git", "-C", repo["path"], "for-each-ref",
                   "--format=%(refname:short) %(committerdate:unix)",
                   f"refs/heads/{TRASH_PREFIX}"])
        for line in out.splitlines():
            name, _, cdate = line.rpartition(" ")
            m = re.search(r"-(\d{9,})$", name)
            trashed_at = (int(m.group(1)) if m
                          else int(cdate) if cdate.isdigit() else None)
            if trashed_at is None or trashed_at >= cutoff:
                continue
            if run_ok(["git", "-C", repo["path"], "branch", "-D", name])[0] == 0:
                log(f"pruned trash branch {name} in {repo['name']} "
                    f"(in trash >{TRASH_RETENTION_DAYS}d)")


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
CLONE_TIMEOUT_SEC = 600     # reap a `git clone` subprocess stuck this long
CLONE_DONE_LINGER_SEC = 30  # keep a finished clone job visible this long...
CLONE_ERROR_LINGER_SEC = 300  # ...longer for a failed one (operator reads it)
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


def list_github_repos():
    """Repos the gh login can clone, for the hub's clone dropdown. Lists the
    authenticated user's repos plus any owners named in GH_CLONE_OWNERS
    (space/comma separated — e.g. an org). One `gh repo list --json` call per
    owner; deduped by nameWithOwner, newest-updated first, capped at
    GH_REPO_MAX."""
    owners = [o for o in re.split(r"[\s,]+", os.environ.get("GH_CLONE_OWNERS", "").strip()) if o]
    targets = owners or [None]  # None = the authenticated user's own repos
    found = {}
    for owner in targets:
        cmd = ["gh", "repo", "list"]
        if owner:
            cmd.append(owner)
        cmd += ["--limit", str(GH_REPO_LIMIT), "--json",
                "nameWithOwner,description,isPrivate,updatedAt"]
        raw = run(cmd)
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        for r in data if isinstance(data, list) else []:
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
        # GitHub clone-into-root state: the cached availability/repo-list block
        # (refreshed on a slow cadence, reported every beat) and in-flight/recent
        # clone jobs keyed by dest name (the Popen lives here; only a serializable
        # view is heartbeated).
        self.github = {"available": False, "login": None, "repos": []}
        self.clones = {}
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

    # --- low-level process control ----------------------------------------

    def _drop_bridge_pointer(self, worktree):
        # Never reattach a fresh claude to a dead RC bridge from a prior session
        # (that silently swallows prompts). The project slug matches how Claude
        # keys ~/.claude/projects for a given cwd.
        slug = worktree.replace("/", "-")
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
        slug = worktree.replace("/", "-")
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

    def _worktree_add(self, sess, new_branch, base_ref=None):
        """Add the worktree. new_branch=True creates the session branch (spawn);
        off base_ref when given (a pre-validated local/remote ref, #12), else off
        HEAD as before. new_branch=False re-checks-out the existing branch
        (start/resume)."""
        os.makedirs(os.path.dirname(sess["worktreePath"]), exist_ok=True)
        # Clear any stale worktree registration left by a --force removal that
        # partially failed, so `worktree add` doesn't refuse.
        run(["git", "-C", sess["repoPath"], "worktree", "prune"])
        if new_branch:
            cmd = ["git", "-C", sess["repoPath"], "worktree", "add",
                   sess["worktreePath"], "-b", sess["branch"]]
            if base_ref:
                cmd.append(base_ref)
        else:
            cmd = ["git", "-C", sess["repoPath"], "worktree", "add",
                   sess["worktreePath"], sess["branch"]]
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
              branch_name=None, model=None, permission_mode=None):
        """Create a brand-new worktree-backed session for <repo_name>.

        All keyword options (#11/#12/#13) default to None so a bare spawn
        reproduces today's behavior exactly. label (#13) is presentational: it
        flavors the claude.ai/code display name but the agent/<id> branch and
        agent-<id> tmux stay the canonical internal keys. The remaining options
        (base branch, custom branch name, model, permission mode) are validated
        below; a bad option fails the spawn cleanly as an error card rather than
        reaching git/tmux or crashing the manager."""
        if self._running_count() >= MAX_SESSIONS:
            log(f"spawn refused: at MAX_SESSIONS ({MAX_SESSIONS})")
            return
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
            "worktreePath": os.path.join(WORKTREES_ROOT, repo["name"], sid),
            "branch": f"agent/{sid}",       # may be replaced by a custom name below
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
        }
        self.registry.append(sess)
        try:
            # Validate every interpolated option BEFORE touching git/tmux.
            sess["branch"] = normalize_branch_name(branch_name, sid)
            resolved_base = resolve_base_ref(repo["path"], base_ref)
            sess["baseRef"] = resolved_base
            sess["model"] = resolve_model(model)
            sess["permissionMode"] = resolve_permission_mode(permission_mode)
            self._worktree_add(sess, new_branch=True, base_ref=resolved_base)
            self._launch_tmux(sess, prompt=(prompt or None))
            self._launch_ttyd(sess)
            log(f"spawned session {sid} for {repo['name']} on :{sess['ttydPort']} "
                f"(branch {sess['branch']}"
                + (f", base {resolved_base}" if resolved_base else "")
                + (f", label {label!r}" if label else "") + ")")
        except Exception as e:
            self._set_error(sess, e)

    def _remember_closed(self, sess):
        """Record a killed session in the closed history so the hub can offer
        to resume it. Bounded: only the newest CLOSED_PER_REPO per repo are
        kept — older records fall off (their branch/transcript still exist,
        they just stop being offered)."""
        rec = {k: sess.get(k) for k in (
            "id", "repo", "repoPath", "worktreePath", "branch", "rcName",
            "tmuxName", "createdAt", "label", "model", "permissionMode",
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
        """Stop and remove a session in one step: end tmux/ttyd, delete its
        worktree, and drop the registry record so the card disappears from the
        hub. KEEPS the git branch (agent/<id>) and the transcript, so the work
        stays in the repo and its usage still shows in history — and records it
        in the closed history so the repo's "Resume" picker can bring it back
        with its conversation. (Contrast delete(), which also removes the
        branch — immediately when fully pushed/merged, otherwise parked under
        agent-trash/ for a grace period — forfeiting resume either way.)"""
        sess = self._find(sid)
        if not sess:
            log(f"kill: no such session {sid}")
            return
        self._kill_tmux(sess)
        self._kill_ttyd(sid)
        if os.path.isdir(sess["worktreePath"]):
            self._worktree_remove(sess)
        self.registry = [s for s in self.registry if s.get("id") != sid]
        self._remember_closed(sess)
        self._forget_session_caches(sid)
        log(f"killed session {sid} (worktree removed, branch {sess['branch']} kept, resumable)")

    def start(self, sid):
        """Resume a stopped session: re-add its worktree on the EXISTING branch
        and relaunch on the SAME ttyd port, continuing its prior conversation
        (fresh only if it never had a transcript)."""
        sess = self._find(sid)
        if not sess:
            log(f"start: no such session {sid}")
            return
        if sess.get("status") == "running":
            return
        if self._running_count() >= MAX_SESSIONS:
            log(f"start refused: at MAX_SESSIONS ({MAX_SESSIONS})")
            return
        try:
            if not os.path.isdir(sess["worktreePath"]):
                self._worktree_add(sess, new_branch=False)
            self._launch_tmux(sess, resume=True)
            self._launch_ttyd(sess)
            sess["status"] = "running"
            sess["stoppedAt"] = None
            sess["errorMsg"] = None
            log(f"started (resumed) session {sid} on :{sess['ttydPort']}")
        except Exception as e:
            self._set_error(sess, e)

    def resume(self, sid):
        """Bring back a KILLED session with its conversation: re-register it,
        re-add its worktree on the kept agent/<id> branch, and relaunch claude
        resuming its newest transcript. The record moves out of the closed
        history; a failure surfaces as an error card like any other session."""
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
        sess = {
            "id": sid,
            "repo": rec.get("repo"),
            "repoPath": rec.get("repoPath"),
            "worktreePath": rec.get("worktreePath"),
            "branch": rec.get("branch"),
            "label": rec.get("label"),
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
            if not os.path.isdir(sess["worktreePath"]):
                self._worktree_add(sess, new_branch=False)
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

    def _retire_branch(self, sess):
        """Lost-work guard behind delete(): `branch -D` the session branch only
        when its commits are provably safe (all on origin, or all contained in
        the repo checkout's base branch); otherwise rename it to
        agent-trash/<id>-<epoch> as a grace period, pruned after
        TRASH_RETENTION_DAYS. Anything indeterminate is treated as unsafe."""
        repo, branch = sess["repoPath"], sess["branch"]
        if not branch_exists(repo, f"refs/heads/{branch}"):
            return  # spawn failed before the branch was born, or already gone
        base = run(["git", "-C", repo, "rev-parse", "--abbrev-ref", "HEAD"])
        sync = branch_sync(repo, branch, base or None)
        safe = ((sync["pushed"] and sync["aheadOfRemote"] == 0)
                or sync["aheadOfBase"] == 0)
        if safe:
            run(["git", "-C", repo, "branch", "-D", branch])
            return
        trash = f"{TRASH_PREFIX}{sess['id']}-{int(time.time())}"
        rc, err = run_ok(["git", "-C", repo, "branch", "-m", branch, trash])
        if rc == 0:
            unpushed = (sync["aheadOfRemote"] if sync["pushed"]
                        else sync["aheadOfBase"])
            log(f"branch {branch} has unpushed work "
                f"({unpushed if unpushed is not None else 'unknown'} commits) "
                f"— parked as {trash} for {TRASH_RETENTION_DAYS}d")
        else:
            log(f"could not park {branch} as {trash} ({err}); "
                f"branch left in place")

    def delete(self, sid):
        """Remove a session entirely: worktree + branch + registry record. It
        disappears from the UI and its usage stops being reported. The branch
        is hard-deleted only when its work is safe (pushed or merged); a branch
        with unpushed commits is parked under agent-trash/ instead — see
        _retire_branch(). Dirty worktree files are gone either way (the UI
        warns before confirming)."""
        sess = self._find(sid)
        if not sess:
            log(f"delete: no such session {sid}")
            return
        self._kill_tmux(sess)
        self._kill_ttyd(sid)
        if os.path.isdir(sess["worktreePath"]):
            self._worktree_remove(sess)
        self._retire_branch(sess)
        self.registry = [s for s in self.registry if s.get("id") != sid]
        # The branch is gone, so any stale closed record must not offer resume.
        self.closed = [c for c in self.closed if c.get("id") != sid]
        self._forget_session_caches(sid)
        prune_trash_branches()
        log(f"deleted session {sid}")

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
                        branch_name=cmd.get("branchName"),
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
                elif ctype == "clone":
                    self.clone(cmd.get("repo"))
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
        # Base = whatever the repo's own checkout is on (the branch worktrees
        # were forked from); '' (e.g. repo dir gone) degrades to no comparison.
        base = run(["git", "-C", sess["repoPath"], "rev-parse",
                    "--abbrev-ref", "HEAD"])
        return {
            "id": sid,
            "repo": sess["repo"],
            "repoPath": sess["repoPath"],
            "worktreePath": sess["worktreePath"],
            "branch": sess["branch"],
            "rcName": sess["rcName"],
            "label": sess.get("label"),
            "model": sess.get("model"),
            "permissionMode": sess.get("permissionMode"),
            "baseRef": sess.get("baseRef"),
            "status": sess.get("status"),
            "ttydPort": sess.get("ttydPort"),
            "createdAt": sess.get("createdAt"),
            "stoppedAt": sess.get("stoppedAt"),
            "errorMsg": sess.get("errorMsg"),
            "git": git_info(sess["worktreePath"]),  # of the worktree (None if gone)
            # Branch↔base/origin relation from the shared repo, so it's still
            # reported for stopped sessions whose worktree is gone — exactly
            # when the UI's delete guard needs it.
            "work": branch_sync(sess["repoPath"], sess["branch"], base or None),
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
                "rcName": c.get("rcName"),
                "label": c.get("label"),
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

        return {
            # `device` (the physical host name) is the hub's identity key; agentId
            # is only a last-resort fallback if the host name can't be read.
            "agentId": self.agent_id,
            "device": self.device,
            "startedAt": self.started_at,
            "claudeVersion": self.claude_version,
            "memory": memory_usage(),
            "logTail": log_tail(self.agent_id),
            "reposRoot": REPOS_ROOT,
            "repos": [repo_entry(r) for r in scan_repos()],
            "sessions": [self._session_payload(s) for s in self.registry],
            "closedSessions": self._closed_payload(),
            # GitHub clone-into-root: availability + clonable repos for the hub's
            # clone control, and any in-flight/recent clone jobs.
            "github": self.github,
            "clones": self._clones_payload(),
            "ackedCommands": list(self.acked),
        }

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
            return reply if isinstance(reply, dict) else {}
        except Exception as e:
            log(f"heartbeat failed: {e}")
            return None

    def run_forever(self):
        log(
            f"reporting to {HUB_URL} as {self.device} (container {self.agent_id}); "
            f"reposRoot={REPOS_ROOT} maxSessions={MAX_SESSIONS}"
        )
        self.resume_on_boot()
        beat = 0
        while True:
            if beat % TRASH_PRUNE_EVERY == 0:  # incl. beat 0 = boot
                prune_trash_branches()
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
            time.sleep(INTERVAL)


def main():
    SessionManager().run_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
