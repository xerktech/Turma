#!/usr/bin/env python3
"""Heartbeat agent for the agent-hub dashboard (compose/claude-code.yaml).

Runs in the background of every Claude Code container (started by
entrypoint.sh) and POSTs a heartbeat to the hub every INTERVAL seconds with:
  - physical device name (read from the /host bind mount)
  - container name/id, working dir, git branch/dirty state
  - memory usage from the cgroup
  - per-project Claude token usage parsed from the transcript JSONLs under
    /root/.claude/projects/<slug>/ (same data ccusage reads)
  - live session signals: bridge-pointer presence (a Remote Control session is
    attached), transcript freshness (is Claude mid-turn right now), the role of
    the newest transcript entry (turn finished vs. waiting on a tool), any
    pending AskUserQuestion text, and PR URLs newly appended to the transcript
  - the last ~50 lines of this container's own log (docker logs via the
    mounted socket) for crash diagnosis in the hub UI

The hub turns the session signals into ntfy push alerts (turn finished,
question waiting, PR created) — see agent-hub/server.js.

The hub's reply can carry {"restart": true}; the agent then restarts its own
container through the bind-mounted docker socket. Doing the restart from
inside the container (rather than from the hub) means it works even when the
container runs on a different physical host than the hub.

stdlib only — no pip installs in the image.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.request

HUB_URL = os.environ.get("HUB_URL", "http://agent-hub:8300")
# Bearer token for the hub's /api/heartbeat (the UI itself sits behind basic
# auth; this lets agents report without those user credentials). Must match
# the hub's HUB_AGENT_TOKEN.
HUB_TOKEN = os.environ.get("HUB_TOKEN", "")
INTERVAL = int(os.environ.get("HUB_INTERVAL", "20"))
# Transcript parsing is the expensive part; refresh it every N heartbeats.
USAGE_EVERY = 15

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


def run(cmd, cwd=None):
    """Run a command, return stripped stdout or '' on any failure."""
    try:
        out = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=15
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


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
                    price = next(
                        (p for k, p in PRICING.items() if k in model), None
                    )
                    cost = (
                        sum(t * p for t, p in zip(tok, (price[0], price[1], price[2], price[3]))) / 1e6
                        if price
                        else 0.0
                    )
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


def main():
    agent_id = run(["hostname"]) or "unknown"
    workdir = os.getcwd()
    container_name = (
        run(["docker", "inspect", "--format", "{{.Name}}", agent_id]).lstrip("/")
        or os.environ.get("APP_NAME", agent_id)
    )
    started_at = run(
        ["docker", "inspect", "--format", "{{.State.StartedAt}}", agent_id]
    )
    claude_version = run(["claude", "--version"])
    device = device_name()
    log(f"reporting to {HUB_URL} as {container_name} ({agent_id}) on {device}")

    usage = None
    beat = 0
    sess_state = {}
    pending_prs = []  # PR URLs not yet delivered (kept across failed beats)
    while True:
        if beat % USAGE_EVERY == 0:
            try:
                usage = usage_report(workdir)
            except Exception as e:
                log(f"usage parse failed: {e}")
        beat += 1

        session = None
        try:
            session = session_report(workdir, sess_state)
            pending_prs.extend(session.pop("prUrls"))
            del pending_prs[:-10]
            session["newPrUrls"] = list(pending_prs)
        except Exception as e:
            log(f"session probe failed: {e}")

        payload = {
            "agentId": agent_id,
            "containerName": container_name,
            "device": device,
            "workingDir": workdir,
            "appName": os.environ.get("APP_NAME", ""),
            "claudeVersion": claude_version,
            "startedAt": started_at,
            "git": git_info(workdir),
            "memory": memory_usage(),
            "usage": usage,
            "session": session,
            "logTail": log_tail(agent_id),
        }
        try:
            # Explicit User-Agent: HUB_URL rides the Cloudflare tunnel, and
            # Cloudflare's Browser Integrity Check 403s (error 1010) the
            # default "Python-urllib/3.x" signature before the request ever
            # reaches the hub.
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
            pending_prs.clear()  # delivered
            if reply.get("restart"):
                log("restart requested by hub — restarting container")
                # Fire-and-forget: the daemon finishes the restart even after
                # this process (and the whole container) is killed by it.
                subprocess.Popen(["docker", "restart", agent_id])
                time.sleep(60)  # if docker restart failed, fall through
                log("docker restart did not take effect, sending SIGTERM to pid 1")
                os.kill(1, 15)
        except Exception as e:
            log(f"heartbeat failed: {e}")
        time.sleep(INTERVAL)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
