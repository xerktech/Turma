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
  - Executes hub-issued commands (spawn / kill / start / restart / delete) that
    ride back on the heartbeat reply, with at-least-once cmdId de-dup.
  - Auto-resumes `running` sessions on boot.
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

The hub's reply can also carry {"restart": true} for a whole-container restart
(legacy) which the agent performs through the bind-mounted docker socket.

stdlib only — no pip installs in the image.
"""

import json
import os
import re
import secrets
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


def device_name():
    # The compose file mounts the host root at /host.
    for path in ("/host/etc/hostname",):
        try:
            with open(path) as f:
                name = f.read().strip()
                if name:
                    return name
        except OSError:
            pass
    return os.environ.get("DEVICE_NAME", "unknown-device")


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
    proj = f"/root/.claude/projects/{slug}"
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
    proj = f"/root/.claude/projects/{slug}"
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
    }


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class SessionManager:
    """Owns the registry, the live tmux/ttyd/claude processes, and the
    heartbeat loop. Single-threaded: all mutations happen in the main loop, so
    no locking is needed. Every lifecycle op is wrapped so one bad session can
    never take down the manager or the others."""

    def __init__(self):
        self.agent_id = run(["hostname"]) or "unknown"
        self.container_name = (
            run(["docker", "inspect", "--format", "{{.Name}}", self.agent_id]).lstrip("/")
            or self.agent_id
        )
        self.started_at = run(
            ["docker", "inspect", "--format", "{{.State.StartedAt}}", self.agent_id]
        )
        self.claude_version = run(["claude", "--version"])
        self.device = device_name()

        self.registry = self._load_registry()   # list[dict], the persisted state
        self.ttyd = {}                           # id -> ttyd Popen (in-memory)
        self.sess_state = {}                     # id -> session_report offsets
        self.usage_cache = {}                    # id -> usage_report result
        self.pending_prs = {}                    # id -> undelivered PR urls
        # at-least-once command de-dup: cmdIds we've already executed.
        self.acked = set()
        self.acked_order = deque(maxlen=1000)

    # --- registry persistence ---------------------------------------------

    def _load_registry(self):
        try:
            with open(REGISTRY_PATH) as f:
                data = json.load(f)
            return data if isinstance(data, list) else []
        except (OSError, ValueError):
            return []

    def save(self):
        try:
            os.makedirs(REGISTRY_DIR, exist_ok=True)
            tmp = REGISTRY_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self.registry, f, indent=2)
            os.replace(tmp, REGISTRY_PATH)
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
            os.remove(f"/root/.claude/projects/{slug}/bridge-pointer.json")
        except OSError:
            pass

    def _launch_tmux(self, sess):
        """(Re)launch claude for a session inside its own tmux, detached."""
        self._drop_bridge_pointer(sess["worktreePath"])
        # Fresh claude in this worktree. IS_SANDBOX=1 (compose) lets
        # bypassPermissions run under root; --remote-control bridges the session
        # to claude.ai/code + mobile under its per-session display name.
        claude_cmd = (
            f"claude --remote-control '{sess['rcName']}' "
            f"--permission-mode bypassPermissions"
        )
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

    def _worktree_add(self, sess, new_branch):
        """Add the worktree. new_branch=True creates agent/<id> off HEAD (spawn);
        False re-checks-out the existing branch (start/resume)."""
        os.makedirs(os.path.dirname(sess["worktreePath"]), exist_ok=True)
        # Clear any stale worktree registration left by a --force removal that
        # partially failed, so `worktree add` doesn't refuse.
        run(["git", "-C", sess["repoPath"], "worktree", "prune"])
        if new_branch:
            cmd = ["git", "-C", sess["repoPath"], "worktree", "add",
                   sess["worktreePath"], "-b", sess["branch"]]
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

    def spawn(self, repo_name):
        """Create a brand-new worktree-backed session for <repo_name>."""
        if self._running_count() >= MAX_SESSIONS:
            log(f"spawn refused: at MAX_SESSIONS ({MAX_SESSIONS})")
            return
        repo = next((r for r in scan_repos() if r["name"] == repo_name), None)
        if not repo:
            log(f"spawn refused: unknown repo {repo_name!r}")
            return
        sid = self._new_id()
        sess = {
            "id": sid,
            "repo": repo["name"],
            "repoPath": repo["path"],
            "worktreePath": os.path.join(WORKTREES_ROOT, repo["name"], sid),
            "branch": f"agent/{sid}",
            "rcName": f"{slugify(self.device)}-{slugify(repo['name'])}-{sid}",
            "tmuxName": f"agent-{sid}",
            "ttydPort": self._alloc_port(),
            "status": "running",
            "createdAt": now_iso(),
            "stoppedAt": None,
            "errorMsg": None,
        }
        self.registry.append(sess)
        try:
            self._worktree_add(sess, new_branch=True)
            self._launch_tmux(sess)
            self._launch_ttyd(sess)
            log(f"spawned session {sid} for {repo['name']} on :{sess['ttydPort']}")
        except Exception as e:
            self._set_error(sess, e)

    def kill(self, sid):
        """Stop and remove a session in one step: end tmux/ttyd, delete its
        worktree, and drop the registry record so the card disappears from the
        hub. KEEPS the git branch (agent/<id>) and the transcript, so the work
        stays in the repo and its usage still shows in history — it just leaves
        the dashboard and is not resumable. (Contrast delete(), which also runs
        `git branch -D` to erase the branch and history.)"""
        sess = self._find(sid)
        if not sess:
            log(f"kill: no such session {sid}")
            return
        self._kill_tmux(sess)
        self._kill_ttyd(sid)
        if os.path.isdir(sess["worktreePath"]):
            self._worktree_remove(sess)
        self.registry = [s for s in self.registry if s.get("id") != sid]
        self._forget_session_caches(sid)
        log(f"killed session {sid} (worktree removed, branch {sess['branch']} kept)")

    def start(self, sid):
        """Resume a stopped session: re-add its worktree on the EXISTING branch
        and relaunch on the SAME ttyd port."""
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
            self._launch_tmux(sess)
            self._launch_ttyd(sess)
            sess["status"] = "running"
            sess["stoppedAt"] = None
            sess["errorMsg"] = None
            log(f"started (resumed) session {sid} on :{sess['ttydPort']}")
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
        """Remove a session entirely: worktree + branch + registry record. It
        disappears from the UI and its usage stops being reported."""
        sess = self._find(sid)
        if not sess:
            log(f"delete: no such session {sid}")
            return
        self._kill_tmux(sess)
        self._kill_ttyd(sid)
        if os.path.isdir(sess["worktreePath"]):
            self._worktree_remove(sess)
        run(["git", "-C", sess["repoPath"], "branch", "-D", sess["branch"]])
        self.registry = [s for s in self.registry if s.get("id") != sid]
        self._forget_session_caches(sid)
        log(f"deleted session {sid}")

    # --- boot auto-resume --------------------------------------------------

    def resume_on_boot(self):
        """Relaunch running sessions whose worktree survived; demote the rest."""
        for sess in self.registry:
            if sess.get("status") != "running":
                continue  # stopped stays stopped (kept for usage; resumable)
            if not os.path.isdir(sess["worktreePath"]):
                sess["status"] = "stopped"
                sess["stoppedAt"] = now_iso()
                log(f"resume: worktree gone for {sess['id']}, marking stopped")
                continue
            try:
                self._launch_tmux(sess)
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
                    self.spawn(cmd.get("repo"))
                elif ctype == "kill":
                    self.kill(cmd.get("sessionId"))
                elif ctype == "start":
                    self.start(cmd.get("sessionId"))
                elif ctype == "restart":
                    self.restart(cmd.get("sessionId"))
                elif ctype == "delete":
                    self.delete(cmd.get("sessionId"))
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
        return {
            "id": sid,
            "repo": sess["repo"],
            "repoPath": sess["repoPath"],
            "worktreePath": sess["worktreePath"],
            "branch": sess["branch"],
            "rcName": sess["rcName"],
            "status": sess.get("status"),
            "ttydPort": sess.get("ttydPort"),
            "createdAt": sess.get("createdAt"),
            "stoppedAt": sess.get("stoppedAt"),
            "errorMsg": sess.get("errorMsg"),
            "git": git_info(sess["worktreePath"]),  # of the worktree (None if gone)
            "usage": self.usage_cache.get(sid),     # present for stopped too
            "session": signals,                      # running only; null otherwise
        }

    def build_payload(self, beat):
        # Usage is the expensive parse — refresh on a slow cadence, but make
        # sure any newly-seen session gets a value on first appearance.
        if beat % USAGE_EVERY == 0:
            for s in self.registry:
                self._refresh_usage(s["id"], s["worktreePath"])
        for s in self.registry:
            if s["id"] not in self.usage_cache:
                self._refresh_usage(s["id"], s["worktreePath"])

        return {
            "agentId": self.agent_id,
            "containerName": self.container_name,
            "device": self.device,
            "startedAt": self.started_at,
            "claudeVersion": self.claude_version,
            "memory": memory_usage(),
            "logTail": log_tail(self.agent_id),
            "reposRoot": REPOS_ROOT,
            "repos": [repo_entry(r) for r in scan_repos()],
            "sessions": [self._session_payload(s) for s in self.registry],
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

    def container_restart(self):
        log("restart requested by hub — restarting container")
        # Fire-and-forget: the daemon finishes the restart even after this
        # process (and the whole container) is killed by it.
        subprocess.Popen(["docker", "restart", self.agent_id])
        time.sleep(60)  # if docker restart failed, fall through
        log("docker restart did not take effect, sending SIGTERM to pid 1")
        os.kill(1, 15)

    def run_forever(self):
        log(
            f"reporting to {HUB_URL} as {self.container_name} ({self.agent_id}) "
            f"on {self.device}; reposRoot={REPOS_ROOT} maxSessions={MAX_SESSIONS}"
        )
        self.resume_on_boot()
        beat = 0
        while True:
            reply = self.post(self.build_payload(beat))
            beat += 1
            if reply is not None:
                if reply.get("restart"):
                    self.container_restart()
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
