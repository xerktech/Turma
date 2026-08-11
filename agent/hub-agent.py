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

import base64
import datetime
import html
import io
import ipaddress
import json
import math
import os
import re
import secrets
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib
from collections import deque
from html.parser import HTMLParser

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

# A transcript reconciliation can't tie to a repo this host has (a bare
# `claude` run outside a managed worktree, a foreign dev-machine session on the
# shared login) folds into ROOT_REPO_NAME, so the usage page lists only real
# repos plus the one root bucket (XERK-147). The old separate "(other)" bucket
# is gone; _sanitize_junk_repo_entries retires ledger entries that carry it.

# The coding agent this build launches for its sessions. Only a fallback: the
# name is normally read out of the CLI's own `--version` reply (coding_agent()),
# so it stays right if the product renames itself.
CODING_AGENT_NAME = "Claude Code"

# Where worktrees live: under a dot-dir so the repo scan never lists them, and
# on the mounted tree so they survive a container restart.
WORKTREES_ROOT = os.path.join(REPOS_ROOT, ".turma", "worktrees")
# Persisted session registry (survives container restart).
REGISTRY_DIR = os.path.expanduser("~/.turma")
REGISTRY_PATH = os.path.join(REGISTRY_DIR, "sessions.json")
# Expected-restart signal (XERK-29). Before the manager goes down for a restart
# it can't heartbeat through — an image update recreating the whole container,
# or the native updater swapping files and `systemctl restart`ing us — it POSTs
# the hub a one-shot "I'm updating" so the coming heartbeat gap renders as an
# `updating` status instead of an unexpected-outage `offline`. The native
# updater drops the target version here for our SIGTERM handler to read and
# enrich the announcement with; a container update (Watchtower) leaves no file
# and we announce a generic restart. Lives beside the other ~/.turma ledgers.
UPDATING_FLAG_PATH = os.path.join(REGISTRY_DIR, "updating.json")
UPDATING_ANNOUNCE_TIMEOUT_SEC = float(
    os.environ.get("TURMA_UPDATING_ANNOUNCE_TIMEOUT_SEC", "4"))
# Rendezvous dir for the AskUserQuestion bridge (agent/hooks/ask.py). A pending
# question lives here as `<sessionId>.req.json`; the answer the glasses client
# sends rides back as `<sessionId>.ans.json`. See _hook_question / answer_question.
QUESTIONS_DIR = os.path.join(REGISTRY_DIR, "questions")
# Killed-but-resumable session history (branch + transcript survive a kill).
#
# This is a CACHE of what a kill knew, not the record of it. It buys a killed
# session two things the transcript scan below can't recover — the PRs it opened
# and its original session id, so `resume` can hand it straight back — and it
# buys them from the moment of the kill, without waiting out a slow beat. It is
# NOT the history: it holds only the newest CLOSED_PER_REPO per repo, so the 6th
# kill in a repo evicts the oldest however durably the file is stored. Anything
# that has to still be there afterwards belongs on the durable side (the
# transcripts, the hub's archive, and the ledgers this dir keeps beside it).
#
# It lives in ~/.turma, whose durability is the HOST's to provide: a native
# install puts it in the invoking user's $HOME, and a container must bind-mount
# it or it is the image's writable layer, which an agent update recreates. The
# deployed stack mounts it (DockerOps compose/turma-truenas.yaml) — but that is a
# deployment promise, not an invariant of this file, so nothing here may assume
# it and every ledger beside it reconciles from disk rather than trusting itself.
CLOSED_PATH = os.path.join(REGISTRY_DIR, "closed.json")
# Only the newest N closed sessions per repo are kept/offered for resume —
# bounds both the file and the heartbeat payload. Older kills don't fall out of
# the hub's Ended list when they fall out of here; they keep listing through the
# resumable scan, just without their PR chips.
CLOSED_PER_REPO = 5
# Newest N resumable transcripts reported per repo. This is the durable side of
# the hub's Ended-sessions list and the "Resume any session" picker: unlike
# closed.json it is re-derived from the transcripts on disk, so it is what makes
# both survive an agent restart. Sized well above CLOSED_PER_REPO because "every
# session I ended" is the point of it, and bounded at all only to bound the
# heartbeat — the hub's archive holds the tail beyond this, searchably.
RESUMABLE_PER_REPO = 50
# Durable worktree-path -> {repo, remote, slug} attribution ledger. Written at
# spawn and NEVER dropped on kill/delete, so a transcript's token usage stays
# traceable to its repo long after the session (and even its worktree) is gone.
# This is what makes host/repo usage persist regardless of active sessions.
USAGE_LEDGER_PATH = os.path.join(REGISTRY_DIR, "repo-usage.json")
# Cached Jira-ticket -> repo triage decisions, keyed by "<siteKey>/<issueKey>".
# Persisted so a triaged board survives a manager restart without re-running the
# model over every ticket. See the "Jira -> repo triage" section.
TRIAGE_LEDGER_PATH = os.path.join(REGISTRY_DIR, "jira-repos.json")
# Durable transcriptId -> ticket ledger: which Jira ticket a conversation was
# spawned to work. The exact counterpart of USAGE_LEDGER_PATH above, for the same
# reason — the session record answers this only while it exists, and the board's
# ticket chips have to outlive it.
#
# A killed session's ticket rides its closed record, but closed.json keeps only
# CLOSED_PER_REPO per repo; past that the record is gone and the only channel
# still reporting the session is the resumable scan, which is re-derived from the
# transcripts on disk and so knows nothing of tickets. Keying here on the
# transcript id — the handle that scan reports and the hub's Ended list dedupes
# on — is what re-attaches the two.
#
# Written wherever a launch names its conversation (_launch_tmux), so a
# restart-clear-context's NEW transcript is recorded alongside the old rather
# than replacing it: both were that ticket's work.
TICKET_LEDGER_PATH = os.path.join(REGISTRY_DIR, "jira-sessions.json")
# Bound on the above. Entries are small and only ticket-backed sessions make one,
# so this is a runaway backstop rather than a working limit; the oldest fall off.
TICKET_LEDGER_MAX = 500
# Durable transcriptId -> {urls, at} ledger: the PR links each conversation
# opened. The exact counterpart of TICKET_LEDGER_PATH above, and for the same
# reason — the PR chips on a session's card (and in the hub's Ended-sessions
# list) have to outlive the in-memory scan that first found the links.
#
# The set of PRs a session opened lived ONLY in the in-memory session_pr_urls,
# rebuilt by an incremental transcript scan that primes to EOF on restart — so a
# manager restart blanked a running session's chips (the `gh pr create` lines
# are behind the primed offset and never re-read), and a session aged out of
# closed.json lost its chips entirely (the resumable scan carries no PRs). Keying
# here on the transcript id — the handle the resumable scan reports and the hub's
# Ended list dedupes on — is what re-attaches links to a session across all of it.
PR_LEDGER_PATH = os.path.join(REGISTRY_DIR, "pr-sessions.json")
# Bound on the above, oldest-first — a runaway backstop, like the ticket ledger.
PR_LEDGER_MAX = 500
# Durable url -> compact `gh pr view` status ledger, so the chip keeps its
# state/CI PILL (not just a bare link) across a restart. The in-memory
# pr_status_cache seeds from this at boot; running sessions re-poll and refresh
# it, but an ENDED session's PR is never re-polled, so its last-known status
# would otherwise degrade to a bare link the moment the cache was lost.
PR_STATUS_LEDGER_PATH = os.path.join(REGISTRY_DIR, "pr-status.json")
# Where Claude Code keeps per-project transcript JSONLs (slug = cwd via
# _project_slug below). Overridable so the test suite can point it at
# fixtures; unset in production, so the default is the real path.
PROJECTS_ROOT = os.environ.get("CLAUDE_PROJECTS_ROOT", "/root/.claude/projects")
# The subscription login every session and headless probe on this host shares.
# Its refresh-token expiry is the "re-login required" signal the hub alerts on
# (XERK-98). Derived from PROJECTS_ROOT's parent so the CLAUDE_PROJECTS_ROOT
# override (native install) and the test suite move both together; overridable
# on its own too.
CLAUDE_CREDS_PATH = os.environ.get(
    "CLAUDE_CREDS_PATH",
    os.path.join(os.path.dirname(PROJECTS_ROOT), ".credentials.json"),
)
# Nudge the operator this long before the refresh token lapses, so a "re-login
# soon" warning lands before sessions actually start failing. Env override in
# seconds; 0 disables the early warning (the hard needsLogin edge still fires).
CLAUDE_AUTH_WARN_MS = int(
    os.environ.get("TURMA_CLAUDE_AUTH_WARN_SEC", str(3 * 24 * 3600)) or 0) * 1000

# Archive sync: ship INACTIVE-session transcripts to the hub's durable, searchable
# store (see turma/archive.js). The agent enumerates ended transcripts, and pushes
# each as append-only byte-range deltas the hub asks for (via the archiveHave map on
# the heartbeat reply). Bounded so a big backfill trickles in rather than flooding
# the tunnel or blocking a beat.
ARCHIVE_MANIFEST_MAX = int(os.environ.get("ARCHIVE_MANIFEST_MAX", "200"))
ARCHIVE_CHUNK_BYTES = 1 << 23   # 8 MiB read+POST per delta
ARCHIVE_BEAT_BUDGET = 1 << 25   # ~32 MiB pushed per sync pass (backfill throttle)
# The compressed transcript bundle a session migration ships through the hub
# (source host -> hub -> target host). A single gzipped POST, capped so a
# pathologically long conversation fails loudly rather than OOM-ing the hub's
# in-memory relay. Transcripts are JSON and compress ~10x, so this covers very
# large sessions; the guard is a backstop, not an expected limit (XERK-101).
MIGRATION_BLOB_MAX = int(os.environ.get("TURMA_MIGRATION_BLOB_MAX", str(1 << 26)))  # 64 MiB


def _project_slug(path):
    """Claude Code's project-dir slug for a cwd: EVERY non-alphanumeric
    character becomes '-', not just '/'. The worktree paths this agent
    manages always contain a dot (REPOS_ROOT/.turma/worktrees/<id>), so
    the old '/'->'-' mapping produced '-.turma-' where Claude writes
    '--turma-' — every transcript lookup missed, silently blanking
    session signals, tails, history, and usage for worktree sessions."""
    return re.sub(r"[^A-Za-z0-9]", "-", path)
# A claude session id, which is both a transcript FILENAME and a token we
# interpolate into the tmux command line (--session-id / --resume). Never let
# anything through that isn't a plain uuid-ish word.
VALID_CLAUDE_SID_RE = re.compile(r"[A-Za-z0-9-]+")
# A migration id, minted hub-side (crypto random hex) and echoed into the blob
# relay URL — validated the same strict way as a transcript id since it also
# reaches a URL path.
VALID_MIGRATION_ID_RE = re.compile(r"[A-Za-z0-9-]+")
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
# SendUserFile inline preview (XERK-221): the agent reads the image/SVG/HTML files
# a session delivers via SendUserFile and embeds them ON the tool_use block (a
# base64 data: URI for images, the raw markup for HTML) so the chat renders them
# inline instead of showing a bare "SendUserFile" card. Bounded so a delivery
# can't bloat a heartbeat/tail frame: at most SEND_FILE_MAX_FILES files, each up
# to SEND_FILE_MAX_BYTES; a bigger/unreadable/non-renderable file degrades to a
# name-only chip. Keep the extension→mime map and caps in lockstep with
# tunnel-agent.js (sendUserFileDetail).
SEND_FILE_MAX_FILES = int(os.environ.get("SESSION_SEND_FILE_MAX_FILES", "16"))
SEND_FILE_MAX_BYTES = int(os.environ.get("SESSION_SEND_FILE_MAX_BYTES", str(512 * 1024)))
SEND_FILE_IMG_MIME = {
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
}
SEND_FILE_HTML_EXT = {".html", ".htm"}
# Terminal color/cursor codes sometimes make it into pasted transcript text;
# strip them so the glasses client only ever sees plain text.
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")
# Glasses-client on-demand commands: how much typed text `input` accepts per
# call, and how many surviving messages an on-demand `history` request returns
# (independent of the per-heartbeat TAIL_MSGS above).
#
# The cap is a payload backstop, not a product limit (XERK-227): the operator
# pastes logs and specs into the chat compose box, and the raw terminal takes
# them at any size, so the chat must too. send_input hands the text to the pane
# as a tmux PASTE (a keystroke send is capped by tmux's own command length at
# ~16 KiB), which costs the same handful of milliseconds at 100 KiB as at 100
# bytes. Keep this at or below the hub's own INPUT_MAX_CHARS, which rejects an
# over-long message with an error the composer shows rather than truncating it.
INPUT_MAX_CHARS = int(os.environ.get("SESSION_INPUT_MAX_CHARS", "100000"))
HISTORY_MAX_MSGS = int(os.environ.get("SESSION_HISTORY_MSGS", "200"))

# File attachments (XERK-234). The operator attaches an image or a document in
# the chat composer; the hub stages the bytes and names them on the `input`
# command, and this agent writes each one to disk HERE, then prefixes the message
# with their paths so the session reads them with its ordinary Read tool.
#
# They land under ~/.turma, deliberately NOT in the session's worktree: a file
# dropped into the repo shows up as an uncommitted change, which is the signal
# `prune` and `delete` use to decide a worktree is holding work. build_guard
# _settings pre-approves Read on this tree so an attachment never costs a
# permission prompt.
UPLOADS_DIR = os.path.join(REGISTRY_DIR, "uploads")
UPLOAD_MAX_BYTES = int(os.environ.get("TURMA_UPLOAD_MAX_BYTES", str(1 << 25)))  # 32 MiB
UPLOAD_MAX_PER_MESSAGE = int(os.environ.get("TURMA_UPLOAD_MAX_PER_MESSAGE", "10"))
UPLOAD_DOWNLOAD_TIMEOUT_SEC = int(os.environ.get("TURMA_UPLOAD_TIMEOUT_SEC", "60"))
# How long an ended session's attachments stay on disk. They are part of a
# conversation that is still resumable (and still references their paths), so
# they outlive the session by a good margin; only a session DELETE drops them at
# once. Swept on the slow usage cadence.
UPLOAD_RETENTION_SEC = int(os.environ.get("TURMA_UPLOAD_RETENTION_SEC", str(30 * 86400)))
# Filename charset, mirrored from the hub's safeUploadName. The hub sanitizes
# first so the operator's chip shows the landing name; this repeats it because a
# name arriving over the wire must never be able to escape UPLOADS_DIR.
UPLOAD_NAME_BAD_RE = re.compile(r"[^A-Za-z0-9._ ()+-]")
UPLOAD_NAME_MAX = 100
# Ticket attachments (XERK-242). A ticket's own screenshots and files are part of
# what it asks for, and the session has no board creds to go and fetch them with
# — so they are pulled off the tracker at spawn and written into that session's
# uploads directory, exactly where a chat attachment lands, and their paths go in
# the initial prompt. Bounded separately from the composer's: nobody chose these
# file by file, so a ticket carrying a 200 MB capture must not stall a spawn.
TICKET_ATTACH_MAX = int(os.environ.get("TURMA_TICKET_ATTACH_MAX", "10"))
TICKET_ATTACH_MAX_BYTES = int(
    os.environ.get("TURMA_TICKET_ATTACH_MAX_BYTES", str(1 << 24)))   # 16 MiB each
TICKET_ATTACH_TOTAL_BYTES = int(
    os.environ.get("TURMA_TICKET_ATTACH_TOTAL_BYTES", str(1 << 26)))  # 64 MiB total
TICKET_ATTACH_TIMEOUT_SEC = int(
    os.environ.get("TURMA_TICKET_ATTACH_TIMEOUT_SEC", "20"))
# ...and a HARD wall-clock budget for the whole batch, not just per file. This
# runs on the manager's one loop, inside a spawn, so a tracker that stays on the
# line would otherwise hold the beat and take the host OFFLINE (the hub gives up
# at 75s). Everything else the loop blocks on is bounded the same way —
# FETCH_TIMEOUT_SEC, JIRA_TIMEOUT_SEC. The timeout above is NOT what enforces
# this: it caps the wait for the next byte, which a server dribbling bytes resets
# forever. fetch_board_attachment's chunked read is what makes this a real bound.
TICKET_ATTACH_DEADLINE_SEC = int(
    os.environ.get("TURMA_TICKET_ATTACH_DEADLINE_SEC", "40"))
# How much of a body one read1() may ask for. Small enough that a trickling
# server is cut off promptly by the deadline check between chunks, big enough
# that a real download costs a handful of iterations per MiB.
ATTACH_CHUNK_BYTES = 1 << 16
# Operator messages are EXEMPT from the history window (XERK-186): a
# tool-heavy session fills HISTORY_MAX_MSGS with tool_use/tool_result turns in
# minutes, evicting the few messages the operator actually typed — measured
# over this host's corpus, 43 of 57 interactive transcripts lost operator
# messages from the on-open view (worst case 1 of 48 shown). _history_entries
# folds every operator text turn in the WHOLE transcript back into its reply,
# so the chat always shows every message the operator sent. This cap bounds
# only that exempt set (newest first), a payload backstop, not a window.
HISTORY_USER_MSGS = int(os.environ.get("SESSION_HISTORY_USER_MSGS", "200"))

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


def run_stdin(cmd, data, timeout=15):
    """Run a command with `data` on its stdin; True on a clean exit, False on
    any failure. The payload rides stdin rather than an argv element, which is
    what lets `tmux load-buffer -` carry text of any size (XERK-227) — tmux
    refuses a command line past ~16 KiB, and the kernel a single argument past
    128 KiB."""
    try:
        out = subprocess.run(
            cmd, input=data, capture_output=True, text=True, timeout=timeout
        )
        return out.returncode == 0
    except Exception:
        return False


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


def _port_open(port, host="127.0.0.1", timeout=0.3):
    """Whether something is already listening on a local TCP port. Used to detect
    a per-session ttyd that survived a *manager* restart (tmux and ttyd are their
    own daemons, so they outlive this process) — the loopback bridge the tunnel
    drives is still up, so we can adopt it instead of rebinding the port. Cheap
    connect-probe; any error (nothing listening, bad port) reads as closed."""
    try:
        port = int(port)
    except (TypeError, ValueError):
        return False
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            return s.connect_ex((host, port)) == 0
    except OSError:
        return False


def _pid_alive(pid):
    """Whether a pid is a live process (signal 0 probes without delivering)."""
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, TypeError, ValueError):
        return False


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
# The static floor, not the whole story: the account's REAL alias list is probed
# from the CLI itself on a slow cadence (see "available-models probe" below) and
# resolve_model() accepts those probed aliases too, so a model the login gains
# (e.g. fable) is offerable without a rebuild.
MODEL_ALIASES = {"opus": "opus", "sonnet": "sonnet", "haiku": "haiku",
                 "fable": "fable"}
# A probed alias that may be interpolated into a launch command line: lowercase
# word-ish, no brackets — `--model sonnet[1m]` unquoted is a shell glob, so the
# bracketed aliases are valid to SWITCH to live (the picker path types nothing)
# but are never accepted into a spawn's command string.
SPAWN_MODEL_RE = re.compile(r"^[a-z0-9.-]{1,40}$")
# A token from the CLI's own "Available: …" alias list (bracketed 1M variants
# included).
MODEL_ALIAS_TOKEN_RE = re.compile(r"^[a-z0-9.-]{1,40}(\[1m\])?$")
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

# --- local-model failover (XERK-246) --------------------------------------
# Running out of Claude usage stops every session on the host at once, which is
# the whole reason this exists. A session can be moved onto a SELF-HOSTED model
# and carry on: Claude Code speaks the Anthropic Messages API, and the LiteLLM
# gateway serves /v1/messages against our own gpt-oss box, so the SAME claude
# binary runs against a different brain with nothing but environment variables.
#
# It is deliberately env-driven and per-launch rather than a second agent
# binary: everything a session depends on — the transcript format the whole
# chat/usage/PR-chip stack parses, `--resume`, Remote Control, the AskUserQuestion
# bridge, and above all the `--settings` safety guard — keeps working untouched.
# A separate coding agent loses all of it (see docs/local-model-failover.md for
# the six-harness bake-off that settled this).
LOCAL_MODEL_BASE_URL = os.environ.get("LOCAL_MODEL_BASE_URL", "").strip()
LOCAL_MODEL_API_KEY = os.environ.get("LOCAL_MODEL_API_KEY", "").strip()
LOCAL_MODEL_NAME = os.environ.get("LOCAL_MODEL_NAME", "gpt-oss:120b").strip()
# Claude Code assumes a 200k window for a model it does not recognise and would
# compact far too late — the tail then silently truncates server-side instead of
# compacting. Must match what the server ACTUALLY serves: DockerOps sizes
# Tenir-Ollama-Cue's per-slot window (81920 as of the sizing recorded in
# docs/opencode-model-eval-2026-08.md), and this default tracks it. Overriding
# it per host is what LOCAL_MODEL_CONTEXT is for.
# No self-hosted context we would plausibly serve is larger than this; beyond it
# a typo is likelier than an intent.
MAX_LOCAL_MODEL_CONTEXT = 2_000_000


def _positive_int_env(name, default):
    """Read a positive int from the environment, falling back on junk.

    Deliberately NOT a bare int() at module scope like the older settings: a
    typo in one of these new vars would raise during import and stop every
    session on the host — precisely the outage this feature exists to prevent.
    A wrong-but-sane context is recoverable; a dead agent is not."""
    raw = (os.environ.get(name) or "").strip()
    try:
        value = int(raw)
    except ValueError:
        if raw:
            log(f"{name}={raw!r} is not an integer — using {default}")
        return default
    if value <= 0:
        log(f"{name}={value} must be positive — using {default}")
        return default
    if value > MAX_LOCAL_MODEL_CONTEXT:
        # Overstating the window is the exact failure this setting exists to
        # prevent: Claude Code compacts far too late and the server truncates
        # the tail silently instead.
        log(f"{name}={value} exceeds {MAX_LOCAL_MODEL_CONTEXT} — using {default}")
        return default
    return value


LOCAL_MODEL_CONTEXT = _positive_int_env("LOCAL_MODEL_CONTEXT", 81920)
# Where a session's model comes from. "subscription" is the mounted ~/.claude
# login (the default, and what every existing session is); "local" is the
# self-hosted model above.
MODEL_SOURCES = {"subscription", "local"}
# The model name is interpolated into a launch command line, so it is charset
# checked like every other launch input. Ollama-style tags carry a colon.
LOCAL_MODEL_NAME_RE = re.compile(r"^[A-Za-z0-9._:/-]{1,60}$")


_local_model_complaints = set()


def local_model_configured():
    """True when this host can run a session on the self-hosted model.

    Both halves are required: an endpoint with no key (or the reverse) would
    launch a session that dies on its first request, which is strictly worse
    than not offering the switch at all.

    A PARTIAL configuration is the confusing case — the control simply never
    appears and /model-source 409s — so it says why, once per distinct reason
    (this runs every heartbeat)."""
    if not LOCAL_MODEL_BASE_URL and not LOCAL_MODEL_API_KEY:
        return False                       # feature simply off; nothing to say
    reason = None
    if not LOCAL_MODEL_BASE_URL:
        reason = "LOCAL_MODEL_API_KEY is set but LOCAL_MODEL_BASE_URL is not"
    elif not LOCAL_MODEL_API_KEY:
        reason = "LOCAL_MODEL_BASE_URL is set but LOCAL_MODEL_API_KEY is not"
    elif not LOCAL_MODEL_NAME_RE.fullmatch(LOCAL_MODEL_NAME):
        reason = f"LOCAL_MODEL_NAME {LOCAL_MODEL_NAME!r} is not a usable model name"
    if reason:
        if reason not in _local_model_complaints:
            _local_model_complaints.add(reason)
            log(f"local model unavailable: {reason} — the failover is off on this host")
        return False
    return True


def resolve_model_source(source):
    """Validate a model-source choice against a fixed enum. Blank ->
    subscription (what every session was before this existed)."""
    source = (source or "").strip()
    if not source:
        return "subscription"
    if source not in MODEL_SOURCES:
        raise ValueError(f"unknown model source {source!r}")
    if source == "local" and not local_model_configured():
        raise ValueError("local model not configured on this host")
    return source


def _messages_api_base(url):
    """Trim a configured OpenAI-style `/v1` base back to what Claude Code wants.

    Claude Code appends `/v1/messages` itself, so a base ending in `/v1` has to
    lose exactly that suffix — and ONLY that suffix. A plain rstrip/rpartition
    turns `https://v1.example.com` into `https:/` and silently drops the path of
    `https://gw.example.com/v1/openai`, both of which pass every configuration
    check and then die on the first request."""
    base = (url or "").rstrip("/")
    return base[:-3].rstrip("/") if base.endswith("/v1") else base


def write_local_model_env(path):
    """Write the self-hosted-model settings to a 0600 file and return its path.

    The credential must not appear in ANY process's argv. A command-line prefix
    puts it in the tmux SERVER's argv, and `tmux -e VAR=VALUE` puts it in the
    tmux CLIENT's — /proc/<pid>/cmdline is world-readable (0444) in both cases,
    so every uid on the host could read the gateway key. Sourcing a 0600 file
    keeps it out of every argv; only the PATH is ever visible there.

    0600 stops OTHER uids, not the sessions themselves — they run as the uid
    that owns this file. `_GUARD_DENY_PATH_RULES` denies Read on it, which stops
    a casual `cat` but is NOT containment: a local session holds the same secret
    in its own environment as ANTHROPIC_AUTH_TOKEN, because that is how it
    authenticates. The threat this file actually closes is the world-readable
    argv one.

    Rewritten on every launch, so a rotated key or a changed endpoint takes
    effect without an agent restart."""
    # Per-process temp name: a shared one makes two concurrent writers race on
    # os.replace, and the loser raises FileNotFoundError mid-launch.
    tmp = f"{path}.{os.getpid()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        for pair in local_model_env_pairs():
            key, _, value = pair.partition("=")
            fh.write(f"{key}={shlex.quote(value)}\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)          # atomic: a launch never sees a partial file
    return path


def discard_local_model_env(path):
    """Remove the settings file when the host no longer has a local model.

    It holds the gateway credential and lives under REGISTRY_DIR, which the
    deployment mounts from the host — so a rotated or removed configuration
    would otherwise leave a working key on disk forever."""
    try:
        os.remove(path)
        log(f"removed stale {path} (local model no longer configured)")
    except FileNotFoundError:
        pass
    except OSError as e:
        log(f"could not remove {path}: {e}")


def local_model_env_pairs():
    """`KEY=VALUE` settings that repoint Claude Code at the self-hosted model.

    Written to a 0600 file by write_local_model_env and SOURCED by the launch
    line — never a command-line prefix and never `tmux -e`, both of which put
    the credential into a process's argv where /proc makes it world-readable.

    Kept out of the shared guard settings file because the choice is PER
    SESSION: one session can fail over while its neighbours stay on the
    subscription. Quoting is applied by the writer, since these end up in a
    file a shell reads."""
    return [
        f"ANTHROPIC_BASE_URL={_messages_api_base(LOCAL_MODEL_BASE_URL)}",
        f"ANTHROPIC_AUTH_TOKEN={LOCAL_MODEL_API_KEY}",
        f"ANTHROPIC_MODEL={LOCAL_MODEL_NAME}",
        f"ANTHROPIC_SMALL_FAST_MODEL={LOCAL_MODEL_NAME}",
        f"CLAUDE_CODE_MAX_CONTEXT_TOKENS={LOCAL_MODEL_CONTEXT}",
        # An ambient API key outranks ANTHROPIC_AUTH_TOKEN and would quietly
        # bill the very account this failover exists to stop depending on.
        "ANTHROPIC_API_KEY=",
    ]
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


def resolve_model(model, extra=()):
    """Map a UI model choice to a `claude --model` value, or None to omit the
    flag. Allowlist only — never passes free-form text to claude: the static
    MODEL_ALIASES, plus `extra` (the aliases the CLI itself reported available,
    from the models probe), each still charset-checked because they end up
    interpolated into a launch command line."""
    model = (model or "").strip().lower()
    if not model or model == "default":
        return None
    if model in MODEL_ALIASES:
        return MODEL_ALIASES[model]
    if model in extra and SPAWN_MODEL_RE.fullmatch(model):
        return model
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


# --- new-work branching policy (--append-system-prompt) -------------------

# Every session's checkout can be behind the real upstream default branch. A
# Turma worktree is detached at origin/<default> as of SPAWN time (see
# default_base_ref) — minutes or hours stale by the time the agent branches, and
# staler still if that spawn-time `git fetch` timed out and fell back to a local
# ref. A repos-root session is worse: it works in the repo dirs themselves,
# sitting on whatever branch the host last left checked out.
#
# There is no settings.json field that carries instructions, so the policy rides
# --append-system-prompt on every launch. It tells the agent to refresh the base
# ITSELF at the moment it starts work, which is the only place with enough
# context to do it smartly: it knows whether a fetch failure is worth retrying,
# whether there's uncommitted work to carry across, and which of several repos it
# is about to touch. Deliberately a directive, not enforcement — the manager
# can't know when "new work" begins.
NEW_WORK_SYSTEM_PROMPT = """\
Branching policy for this session (set by Turma, the agent host):

Do not assume this checkout is at the latest default branch. It is either a
detached worktree forked when this session spawned, or a repo left on whatever
branch was last checked out on this host. Either can be well behind origin.

Before starting new work in a repo — and before creating the branch you will
commit it to — refresh the base yourself:
  1. `git fetch origin` in that repo.
  2. Find the default branch: `git symbolic-ref --short refs/remotes/origin/HEAD`
     (typically origin/main, else origin/master).
  3. Create your branch from that REMOTE ref, not from the current HEAD:
     `git switch -c <your-branch> origin/main`.

Handle the exceptions with judgment rather than stopping:
  - If the fetch fails (offline, no remote, auth), base off the best local ref
    instead, and say the base may be stale in your first reply and in the PR.
  - If the checkout already has uncommitted work, carry it onto the fresh branch
    rather than discarding it; if you can't, explain why instead of forcing it.
  - If you are continuing existing work on a branch you already made, stay on it
    — this applies when work STARTS, not to every commit.

A session working across several repos applies this per repo, as it reaches each.
"""

# Extends the policy above for a session spawned to work a Jira ticket. The
# branch name is decided at spawn (see _reserve_ticket_branch) rather than left
# to the agent for two reasons: it has to be derivable from the ticket by a human
# scanning branches, and the -1/-2 suffix needs a scan of every existing local
# and remote branch that the agent has no particular reason to do correctly.
#
# It rides the same --append-system-prompt as the policy it extends, on every
# launch including resume. The name is persisted on the session record, so a
# resumed session is told the same name it was told at spawn rather than
# re-deriving one against a repo whose branches have since moved.
TICKET_BRANCH_PROMPT = """
This session is work on Jira ticket {key}, whose full text is in your first
user message.

Name the branch you create for it exactly: {branch}

That exact name is reserved for this session and already accounts for any branch
this ticket has been worked on before (hence a possible -1/-2 suffix), so use it
rather than deriving your own name from the ticket key.

Everything above still applies: cut that branch from the REFRESHED remote default
branch, not from this checkout.
"""


# --- agent safety guard (--settings wiring) ------------------------------

# Host credential / agent-config stores the agent must never write or delete.
# Path rules use Claude Code's gitignore-style matching and win even under
# `--permission-mode bypassPermissions`, unlike fragile Bash arg patterns.
# Read rules the app grants every session outright. The uploads tree is written
# BY this agent, on the operator's instruction, and lives outside every repo
# (XERK-234) — so reading it is outside the session's working directory and
# would otherwise cost a permission prompt on a file the operator just attached.
_GUARD_ALLOW_PATH_RULES = [
    "Read(~/.turma/uploads/**)",
]

# `Edit(path)` is the ONLY spelling file permission checks honour, and it covers
# every file-editing tool (Write and NotebookEdit included). A paired
# `Write(path)` rule is not merely redundant: Claude Code rejects it at startup
# and prints a warning per rule, so each session's pane opened with seven lines
# of noise — the first thing the operator sees, in the same pane the agent
# scrapes for its busy/mode signals. Do not add `Write(...)` twins back.
_GUARD_DENY_PATH_RULES = [
    "Edit(~/.ssh/**)",
    "Edit(~/.aws/**)",
    "Edit(~/.azure/**)",
    "Edit(~/.terraform.d/**)",
    "Edit(~/.claude/**)",
    "Edit(~/.config/gcloud/**)",
    # The host's cached non-GitHub git creds (the `store` helper's file), shared
    # by every session on the box exactly like ~/.aws.
    "Edit(~/.git-credentials)",
    # The self-hosted gateway credential (XERK-246). READ, not just Edit: unlike
    # the stores above — which a session could only misuse by writing — this
    # file's whole content IS the secret, and sessions run as the same uid that
    # owns it.
    #
    # Defense in depth against a CASUAL read, and nothing more. A local session
    # necessarily has the same secret in its own environment as
    # ANTHROPIC_AUTH_TOKEN (that is how it authenticates), so `echo
    # $ANTHROPIC_AUTH_TOKEN` reads it in one call and no permission rule can
    # change that. Do not treat this line as containment. Keeping the token out
    # of child environments would need Claude Code's apiKeyHelper.
    "Read(~/.turma/local-model.env)",
    "Edit(~/.turma/local-model.env)",
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


def statusline_script_path():
    """Absolute path to the bundled subscription-limits statusLine hook
    (``hooks/statusline.py``), resolved the same way as ``guard_script_path``."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks",
                        "statusline.py")


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
    perms["allow"] = list(_GUARD_ALLOW_PATH_RULES)
    for rule in allow:  # operator allow unions on top of the app's own rules
        if rule not in perms["allow"]:
            perms["allow"].append(rule)
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


def build_limits_settings(python_exe=None, statusline_path=None):
    """Build the dict passed to ``claude --settings`` by the LIMITS PROBE alone
    (XERK-247): a ``statusLine`` command wired to ``hooks/statusline.py``, which
    records the login's 5-hour and 7-day subscription windows out of the blob
    Claude Code hands every status line.

    **This must never be merged into a session's settings.** Configuring a
    statusLine makes Claude Code stop painting the footer's ``esc to interrupt``
    hint, and that hint is what `_busy_from_capture` (and tunnel-agent's
    `paneShowsBusy`) read to know a session is working. Measured on a 54-column
    pane mid-stream, busy detection falls from 53/54 captures to 10/41 — the
    XERK-130 defect, on every session on the host, in exchange for a usage
    widget. So the statusLine lives on a throwaway probe whose pane nothing
    parses, and real sessions keep the hint.

    No hooks and no permissions here either: the probe runs one trivial turn and
    is killed, so the guard has nothing to guard.
    """
    python_exe = python_exe or sys.executable or "python3"
    statusline_path = statusline_path or statusline_script_path()
    return {
        "statusLine": {
            "type": "command",
            "command": f'"{python_exe}" "{statusline_path}"',
            "padding": 0,
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


def agent_version():
    """This build's own version — the unified release version (see RELEASING.md)
    of the code currently running, reported on the heartbeat so the hub's host
    header can show which build a host is on.

    The two install shapes stamp it differently, so both are read here:
      1. TURMA_AGENT_VERSION env — the container image bakes it at build time
         (release.yml passes the release version as a build-arg), and it doubles
         as an operator override anywhere.
      2. A VERSION file next to this script — what native/install.sh writes into
         its prefix, alongside hub-agent.py, on every install and self-update.
      3. The repo-root VERSION (a dev checkout running agent/hub-agent.py
         straight out of the tree) — bare MAJOR.MINOR, same fallback install.sh
         uses.
    None when nothing stamped it, which the hub renders as unknown rather than
    guessing a number.
    """
    env = os.environ.get("TURMA_AGENT_VERSION", "").strip()
    if env:
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    for path in (os.path.join(here, "VERSION"), os.path.join(here, os.pardir, "VERSION")):
        try:
            with open(path) as f:
                ver = f.read().strip()
            if ver:
                return ver
        except OSError:
            pass
    return None


def coding_agent():
    """Which coding agent this host runs for its sessions, and its version —
    heartbeated as `codingAgent` for the hub's host header.

    The NAME is reported rather than left for the hub to assume: this image is
    deliberately agent-generic (Claude Code today, another CLI later), and this
    process is the only party that knows which one it actually execs.

    `claude --version` prints "<version> (<product>)" — "2.1.211 (Claude Code)" —
    so the parenthesized product name is preferred over the hardcoded default.
    An unparseable reply keeps the whole string as the version, which still tells
    the operator more than nothing. None when the CLI can't be run at all, which
    the hub renders as unknown.
    """
    out = run(["claude", "--version"])
    if not out:
        return None
    m = re.match(r"^(\S+)\s+\((.+)\)$", out)
    if m:
        return {"name": m.group(2).strip(), "version": m.group(1)}
    return {"name": CODING_AGENT_NAME, "version": out}


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


def claude_auth_status(path=None, now_ms=None):
    """The shared subscription login's health, for the heartbeat (XERK-98).

    Claude Code stores an OAuth pair in ~/.claude/.credentials.json under
    `claudeAiOauth`. Two expiries live there and they mean different things:

      * `expiresAt` is the ACCESS token — short-lived (hours) and silently
        refreshed on every run, so it is NOT a re-login signal on its own.
      * `refreshTokenExpiresAt` is the REFRESH token — it only lapses when
        claude has not refreshed inside its ~30-day window, i.e. the login has
        gone stale on an idle or logged-out host. THAT is when a human must run
        `claude /login`, so it is what `needsLogin`/`expiringSoon` key off.

    A missing file, unreadable JSON, or a login with no access token reads as
    not-logged-in (`present:false`, `needsLogin:true`). A present login whose
    refresh expiry is unknown (an older credential shape) is reported healthy —
    without a timestamp to stand on we never cry wolf. All times are epoch ms,
    matching the file's own format and the hub's Date.now().
    """
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    status = {
        "present": False,
        "needsLogin": True,
        "expiringSoon": False,
        "expiresAt": None,
        "refreshExpiresAt": None,
        "subscriptionType": None,
        "at": now_ms,
    }
    try:
        with open(path or CLAUDE_CREDS_PATH) as f:
            oauth = (json.load(f) or {}).get("claudeAiOauth") or {}
    except (OSError, ValueError):
        return status  # missing/unreadable => not logged in
    if not oauth.get("accessToken"):
        return status  # a file without a token is not a login
    status["present"] = True
    status["subscriptionType"] = oauth.get("subscriptionType")
    access = oauth.get("expiresAt")
    refresh = oauth.get("refreshTokenExpiresAt")
    status["expiresAt"] = access if isinstance(access, (int, float)) else None
    status["refreshExpiresAt"] = refresh if isinstance(refresh, (int, float)) else None
    if isinstance(refresh, (int, float)):
        if refresh <= now_ms:
            status["needsLogin"] = True        # refresh token lapsed: must re-login
        else:
            status["needsLogin"] = False
            status["expiringSoon"] = bool(
                CLAUDE_AUTH_WARN_MS and refresh - now_ms <= CLAUDE_AUTH_WARN_MS)
    else:
        status["needsLogin"] = False           # present, expiry unknown: assume ok
    return status


HISTORY_DAYS = 60  # per-day breakdown reported to the hub (bounds payload size)


TOKEN_KEYS = ("input", "output", "cacheWrite", "cacheRead")
WEEK_DAYS = 7  # rolling window (UTC days, today inclusive) behind the `week` bucket


def _usage_bucket():
    return {k: 0 for k in TOKEN_KEYS}


def _add_tokens(bucket, tok):
    """Fold one message's (input, output, cacheWrite, cacheRead) into `bucket`."""
    for k, n in zip(TOKEN_KEYS, tok):
        bucket[k] += n


def _model_acc():
    return {"totals": _usage_bucket(), "days": {}}


class _UsageAcc:
    """Mutable accumulator folded over one or more Claude project dirs. Kept
    separate from the public report shape so several worktrees' transcripts can
    be aggregated into one repo total (share one `seen` set so a message can't
    double-count across a repo's worktrees). A per-slug instance is also carried
    across beats for the incremental parse (see _aggregate_project)."""

    def __init__(self):
        self.totals = _usage_bucket()
        self.days = {}      # "YYYY-MM-DD" (UTC) -> bucket
        # model id -> {"totals": bucket, "days": {"YYYY-MM-DD": bucket}}. The
        # per-model day buckets never leave the agent: _finalize_usage derives
        # each model's today/week from them and drops them, so the per-model
        # breakdown costs a few scalars per model on the wire rather than a
        # whole second days matrix.
        self.models = {}
        self.seen = set()   # (message id, requestId) dedup keys
        self.last_ts = ""
        self.sessions = 0   # transcript files folded in


def _accumulate_usage(lines, acc):
    """Fold transcript JSONL lines into `acc` in place. Only lines that mention a
    usage block count for anything; each message is deduped on
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

        tok = (
            usage.get("input_tokens", 0) or 0,
            usage.get("output_tokens", 0) or 0,
            usage.get("cache_creation_input_tokens", 0) or 0,
            usage.get("cache_read_input_tokens", 0) or 0,
        )
        # Transcript timestamps are UTC ISO; date-prefix bucketing is close
        # enough for a dashboard.
        day = ts[:10] if len(ts) >= 10 else ""
        buckets = [acc.totals]
        if day:
            buckets.append(acc.days.setdefault(day, _usage_bucket()))
        # "<synthetic>" (and any "<...>") is Claude Code's stamp on assistant
        # entries it fabricates itself — a session-limit notice, a "No response
        # requested." placeholder — not a model that ran. Such entries carry an
        # all-zero usage block, so folding them into the totals is a no-op; keep
        # them OUT of the per-model breakdown so the usage page's "Tokens by
        # model" table doesn't list a phantom "<synthetic>" model that consumed
        # nothing. Mirrors _scan_model_entry's same guard.
        if not model.startswith("<"):
            m = acc.models.setdefault(model, _model_acc())
            buckets.append(m["totals"])
            if day:
                buckets.append(m["days"].setdefault(day, _usage_bucket()))
        for b in buckets:
            _add_tokens(b, tok)


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


def _total_tokens(bucket):
    return sum(bucket.get(k, 0) for k in TOKEN_KEYS)


def _utc_today():
    """Today's UTC date. Day buckets are keyed off the transcripts' UTC ISO
    timestamps, so `today`/`week` MUST be resolved in UTC too — reading them
    against local time silently mis-slices the window on any host that isn't
    on UTC (and skips/double-counts a day around its midnight)."""
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")


def _week_window(today=None):
    """The WEEK_DAYS UTC dates ending `today` (inclusive), newest last. Dated in
    UTC via date arithmetic rather than epoch-second subtraction, which would
    skip or repeat a day across a DST boundary on a non-UTC host."""
    end = datetime.date.fromisoformat(today or _utc_today())
    return [
        (end - datetime.timedelta(days=i)).isoformat()
        for i in range(WEEK_DAYS - 1, -1, -1)
    ]


def _sum_days(days, window):
    """Total the buckets of `window`'s dates out of a {date: bucket} map."""
    out = _usage_bucket()
    for d in window:
        b = days.get(d)
        if b:
            _add_tokens(out, [b[k] for k in TOKEN_KEYS])
    return out


def _finalize_usage(acc):
    """Snapshot the running accumulator into the heartbeat's usage shape. Builds
    COPIES throughout: the same per-slug acc is reused across beats and merged
    into repo/host totals, so a report must never alias (let alone mutate) the
    accumulator's own buckets.

    `today`/`week` are pre-sliced here rather than left to each client: the day
    buckets are UTC and the clients aren't, and three surfaces (hub, Android,
    glasses) would otherwise each re-derive the same window."""
    window = _week_window()
    days = {d: dict(acc.days[d]) for d in sorted(acc.days)[-HISTORY_DAYS:]}
    return {
        "totals": dict(acc.totals),
        "today": days.get(window[-1], _usage_bucket()),
        "week": _sum_days(acc.days, window),
        "days": days,
        "sessions": acc.sessions,
        "lastActivity": acc.last_ts,
        # Per-model token counts, biggest consumer first. Each model's day
        # buckets stay agent-side (see _UsageAcc.models) — only the three
        # windows the UI shows travel.
        "models": sorted(
            (
                {
                    "model": name,
                    "totals": dict(m["totals"]),
                    "today": dict(m["days"].get(window[-1]) or _usage_bucket()),
                    "week": _sum_days(m["days"], window),
                }
                for name, m in acc.models.items()
            ),
            key=lambda m: _total_tokens(m["totals"]),
            reverse=True,
        ),
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


def _merge_bucket(dst, src):
    for k in TOKEN_KEYS:
        dst[k] += src.get(k, 0)


def _merge_acc(dst, src):
    """Fold accumulator `src` into `dst` (pre-finalize). Buckets are merged by
    value, so later finalizing one side never disturbs the other, and `src` (a
    persistent per-slug acc) is left intact."""
    _merge_bucket(dst.totals, src.totals)
    for d, b in src.days.items():
        _merge_bucket(dst.days.setdefault(d, _usage_bucket()), b)
    for name, m in src.models.items():
        tgt = dst.models.setdefault(name, _model_acc())
        _merge_bucket(tgt["totals"], m["totals"])
        for d, b in m["days"].items():
            _merge_bucket(tgt["days"].setdefault(d, _usage_bucket()), b)
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
    [{repo, remote, remoteKey, usage}] sorted by total tokens desc (repos that
    never consumed anything are omitted); host_usage is the merged report, or
    None when no transcript exists at all."""
    by_repo = {}  # repo name -> {"remote": str, "slugs": set()}
    for path, meta in (ledger or {}).items():
        meta = meta or {}
        if meta.get("internal"):
            continue  # the manager's own claude -p helper, not a repo (XERK-27)
        repo = meta.get("repo") or ROOT_REPO_NAME
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
    repo_usage.sort(key=lambda r: _total_tokens(r["usage"]["totals"]), reverse=True)
    return repo_usage, host_usage


# --- subscription limit snapshot (XERK-247) ---------------------------------
#
# Token usage above is what THIS host spent; the limits below are how much of
# the Claude subscription's 5-hour and 7-day windows is gone — a single pool
# shared across claude.ai, Claude Code and every other surface, with no API
# behind it (the Usage & Cost API is org-scoped, admin-keyed, and reports API
# spend instead). Claude Code hands the numbers to a `statusLine` command and
# nowhere else, so hooks/statusline.py captures them into this file and the beat
# folds the file onto the heartbeat.
#
# The write is out-of-band (a probe process, see _start_limits_probe) and the
# read is a plain file read, which is what keeps the ingest one-directional: the
# agent never holds a credential for this and the hub never sees anything but
# the two percentages.
LIMITS_PATH = os.environ.get("TURMA_LIMITS_PATH") or os.path.join(
    REGISTRY_DIR, "limits.json")
LIMITS_SETTINGS_PATH = os.path.join(REGISTRY_DIR, "limits-settings.json")
# A snapshot older than this is not reported at all. The UI ages what it gets
# and marks it stale on its own (capturedAt rides along), but a snapshot from
# last week describes a window that has since reset several times over — it is
# not stale data, it is wrong data.
LIMITS_MAX_AGE_SEC = int(os.environ.get("TURMA_LIMITS_MAX_AGE_SEC", "86400") or 86400)
LIMITS_WINDOW_KEYS = ("fiveHour", "sevenDay")
# The snapshot is a couple of hundred bytes; anything near this is not one.
LIMITS_MAX_BYTES = 64 << 10
# Bounds on the two timestamps. `EPOCH_MAX` (year ~5138) keeps a wild number
# away from int() and away from clients that type these as a 64-bit integer;
# `RESET_HORIZON` keeps a reset time near the windows it can describe (5 hours
# and 7 days); `FUTURE_SKEW` allows ordinary clock drift on capturedAt but not a
# stamp that would never age.
LIMITS_EPOCH_MAX = 10 ** 11
LIMITS_RESET_HORIZON_SEC = 60 * 86400
LIMITS_FUTURE_SKEW_SEC = 300


# The last problem logged about the snapshot file. read_limits_snapshot runs on
# EVERY beat, so a file that stays broken would otherwise repeat its complaint
# every TURMA_INTERVAL seconds, forever, into a log tail that rides the
# heartbeat. Say each distinct problem once; a changed one is news again.
_limits_last_problem = None


def _log_limits_problem(msg):
    global _limits_last_problem
    if msg != _limits_last_problem:
        _limits_last_problem = msg
        log(msg)


def _finite_epoch(value, limit):
    """A finite epoch-second number as an int, or None. `limit` bounds the
    magnitude, so `1e308`, `NaN` and `inf` never reach `int()` — which RAISES on
    the last two, and `int()` on a float that large yields a number no client can
    render (a Kotlin `Long` field can't even decode it)."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if abs(value) > limit:
        return None
    return int(value)


def read_limits_snapshot(path=None, now=None, max_age=None):
    """The heartbeat's `limits` block, read from the snapshot file — or None when
    there is no usable one (no file, unreadable, unparseable, no window, or a
    timestamp that makes the numbers meaningless).

    Re-validated field by field rather than passed through, and **this function
    never raises**: it is called on the heartbeat's critical path, the file is
    written by a separate process from a shape Claude Code owns and may change,
    and `~/.turma` is not in the guard's deny list — so any session on the host
    can put anything there. An exception escaping here would take the beat loop,
    and with it the host, down on every restart until someone deleted the file.

    `capturedAt` is carried as the epoch second the hook stamped, so staleness is
    measured against the READING clock on each surface rather than against the
    agent's idea of now."""
    path = path or LIMITS_PATH
    now = int(now if now is not None else time.time())
    max_age = LIMITS_MAX_AGE_SEC if max_age is None else max_age
    try:
        # The READ is bounded, not just the file's stat: the snapshot is a couple
        # of hundred bytes, and `json.load` on a path pointed at something
        # enormous is an unbounded allocation on the beat loop. A stat-only check
        # wouldn't do — /dev/zero reports st_size 0 and then hands over bytes
        # forever, which OOM-kills the agent.
        with open(path, encoding="utf-8") as fh:
            text = fh.read(LIMITS_MAX_BYTES + 1)
        if len(text) > LIMITS_MAX_BYTES:
            _log_limits_problem(
                f"limits snapshot at {path} is implausibly large; ignoring it")
            return None
        raw = json.loads(text)
        if not isinstance(raw, dict):
            return None
        captured = _finite_epoch(raw.get("capturedAt"), LIMITS_EPOCH_MAX)
        if captured is None:
            return None
        if max_age and captured < now - max_age:
            return None
        # A snapshot stamped in the future would read as freshly captured
        # forever, so it never goes stale in any UI. A little skew is ordinary
        # (the writer's clock, or a beat that crosses a second); a lot is a
        # broken or hostile stamp.
        if captured > now + LIMITS_FUTURE_SKEW_SEC:
            return None
        out = {}
        for key in LIMITS_WINDOW_KEYS:
            win = raw.get(key)
            if not isinstance(win, dict):
                continue
            clean = {}
            pct = win.get("usedPct")
            if (isinstance(pct, (int, float)) and not isinstance(pct, bool)
                    and not (isinstance(pct, float) and not math.isfinite(pct))):
                clean["usedPct"] = round(min(100.0, max(0.0, float(pct))), 1)
            # A reset time is only meaningful near now — these windows are 5
            # hours and 7 days long. An absurd one renders as an absurd
            # countdown ("resets in 1.15e+303d"), so drop the field and let the
            # UI show the percentage alone.
            resets = _finite_epoch(win.get("resetsAt"), LIMITS_EPOCH_MAX)
            if resets is not None and abs(resets - now) <= LIMITS_RESET_HORIZON_SEC:
                clean["resetsAt"] = resets
            if "usedPct" in clean:  # a reset time with no percentage draws nothing
                out[key] = clean
        if not out:
            return None
        out["capturedAt"] = captured
        out["source"] = "statusline"
        return out
    except FileNotFoundError:
        # The ordinary state on a host that hasn't probed yet (and forever on one
        # whose login has no windows). Silent: this runs every beat, and the log
        # tail rides the heartbeat to the hub.
        return None
    except Exception as e:
        _log_limits_problem(f"limits snapshot at {path} unreadable ({e}); ignoring it")
        return None


PR_URL_RE = re.compile(r"https://github\.com/[\w.-]+/[\w.-]+/pull/\d+")
# A GitLab merge request's URL, on any GitLab host (XERK-162): the `/-/`
# namespace separator plus `merge_requests/<n>` is the discriminator, and the
# leading path segments cover nested groups and a subpath install alike. A
# plain `git push`'s "to create a merge request … visit" hint ends in
# /merge_requests/new, which the \d+ deliberately doesn't match.
MR_URL_RE = re.compile(r"https://[\w.-]+(?::\d+)?(?:/[\w.-]+)+/-/merge_requests/\d+")
# An Azure DevOps pull request's URL, on Services or a self-hosted collection
# (XERK-226): the `/_git/<repo>/` repository namespace plus `pullrequest/<n>`.
# The leading segments cover the org/collection, a subpath install, and the
# optional project segment (ADO serves the PR with or without it). ADO's own
# `git push` hint ends in `/pullrequestcreate?sourceRef=…` — a link to the
# CREATE form, which the `/<digits>` deliberately doesn't match, exactly as
# GitLab's `/merge_requests/new` doesn't.
AZDO_PR_URL_RE = re.compile(
    r"https://[\w.-]+(?::\d+)?(?:/[^\s/?#\"']+)*/_git/[^\s/?#\"']+/pullrequest/\d+",
    re.IGNORECASE)
# The pull-request id inside such a URL, for the places that need the number
# without re-deciding whether the URL is ours.
AZDO_PR_URL_ID_RE = re.compile(r"/pullrequest/(\d+)", re.IGNORECASE)

# The Bash commands that OPEN a pull/merge request. `gh pr create` (and its
# counterparts — `glab mr create`, a `git push` carrying the
# `merge_request.create` push option, or `az repos pr create`) reports the new
# PR/MR as its own output, and that pairing — this command, this output — is
# the only thing in a transcript that says the session opened the PR rather
# than merely looked at one. See _scan_pr_line.
PR_CREATE_RE = re.compile(
    r"\bgh\s+pr\s+create\b|\bglab\s+mr\s+create\b|\bmerge_request\.create\b"
    r"|\baz\s+repos\s+pr\s+create\b")
# Unresolved `gh pr create` tool_use ids remembered per session between beats.
# Capped: a call whose result never lands (the turn was interrupted, the pane
# died) must not grow the set for the life of the session.
PR_CALLS_MAX = 20

# Beats between `gh pr view` status refreshes for the PR links a session opened
# (~INTERVAL*N sec). Faster than the github-block cadence so CI/merge state on a
# session card stays reasonably live, but not every beat (each is a gh network
# call). Bounded per refresh so a host with many PRs never stalls a beat.
PR_STATUS_REFRESH_EVERY = int(os.environ.get("TURMA_PR_REFRESH_EVERY", "3"))
PR_STATUS_MAX = 20

# PR-comment delivery (XERK-49): poll the PRs running sessions opened for new
# review activity and TYPE it into the authoring session, so a reply asking for
# corrections continues the work in the session that made the PR — no operator
# in the loop. Same cadence and per-beat cap as the status poll (one gh call per
# PR, or two when the inline-review-thread fetch runs). Disable with =0.
PR_COMMENTS_DELIVER = os.environ.get("TURMA_PR_COMMENTS", "1") != "0"
PR_COMMENTS_REFRESH_EVERY = int(os.environ.get("TURMA_PR_COMMENTS_EVERY", "3"))
PR_COMMENTS_MAX = 20               # PRs polled per beat, like PR_STATUS_MAX
PR_COMMENTS_SEEN_MAX = 500         # per-PR seen-key ceiling (newest kept)
PR_COMMENTS_BODY_CAP = 1200        # per-comment body chars folded into the message

# Merge-conflict auto-resolution (XERK-223): a PR whose branch conflicts with
# its base merges nowhere, and the session that opened it is the one thing on
# this host that can fix it. The conflict is already known — refresh_pr_status
# fetches `mergeable` every PR beat — so this costs no extra network call, only
# a message typed into the authoring session. Disable with =0.
PR_CONFLICT_RESOLVE = os.environ.get("TURMA_PR_CONFLICTS", "1") != "0"
# Bounded nudging: a session that tried and failed must not be told the same
# thing every beat forever, and one that ignored the first message deserves more
# than one chance. Spaced, and capped per conflict episode.
PR_CONFLICT_MAX_ATTEMPTS = int(os.environ.get("TURMA_PR_CONFLICT_ATTEMPTS", "3"))
PR_CONFLICT_RETRY_SEC = int(os.environ.get("TURMA_PR_CONFLICT_RETRY_SEC", "1800"))


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


def _merge_ready(state, checks, mergeable):
    """The card's single merge-readiness verdict: 'ready' | 'blocked' |
    'pending' | None, from the CI rollup AND GitHub's mergeability.

    Green CI is only half of "can this land": a PR whose branch conflicts with
    its base merges nowhere, however clean its checks are, and a ✓ that says
    otherwise is the one claim this mark must never make. So a conflict blocks
    on its own, and a pass requires GitHub to have affirmatively said MERGEABLE.

    Mergeability is computed lazily server-side, so a just-opened PR reports
    UNKNOWN for a beat or two; that's 'pending' rather than 'ready' — unproven
    is not proven, and the next refresh resolves it.

    Conflicts are only a question for a PR that is still open: a MERGED or
    CLOSED one merges nowhere by definition, and its mark reports CI alone, as
    it always has. Likewise a PR with no checks at all keeps its no-mark unless
    it CONFLICTS — absent CI is not evidence of anything, but a conflict is."""
    if mergeable == "CONFLICTING" and state in ("OPEN", "DRAFT"):
        return "blocked"
    if checks == "failing":
        return "blocked"
    if checks == "pending":
        return "pending"
    if checks == "passing":
        if state in ("OPEN", "DRAFT") and mergeable != "MERGEABLE":
            return "pending"
        return "ready"
    return None


def _summarize_pr(data):
    """Condense `gh pr view --json …` output to the compact status the hub cards
    render: number, title, state (OPEN/DRAFT/MERGED/CLOSED), a CI-check rollup
    ('passing'/'failing'/'pending'/None) with per-bucket counts, GitHub's raw
    mergeability, and the merge-readiness verdict the two combine into.

    `base` (the PR's target branch) rides along for the conflict nudge
    (XERK-223), which has to name the branch to merge in; no renderer reads
    it."""
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
    # MERGEABLE / CONFLICTING / UNKNOWN. Reported raw beside the verdict so the
    # card can say WHY it is blocked rather than only that it is.
    mergeable = str(data.get("mergeable") or "").upper() or None
    # DRAFT is really an OPEN sub-state in the API; surface it as its own state
    # so the card can grey it out like GitHub does.
    state = "DRAFT" if draft and state == "OPEN" else state
    return {
        "url": data.get("url"),
        "number": data.get("number"),
        "title": (data.get("title") or "")[:120],
        "state": state,
        "checks": checks,
        "checkCounts": counts if total else None,
        "mergeable": mergeable,
        "ready": _merge_ready(state, checks, mergeable),
        "base": data.get("baseRefName") or None,
    }


def pr_status(url):
    """Fetch a PR's state, CI-check rollup and mergeability via `gh pr view
    <url>`. Returns the compact status dict, or None on any failure (gh accepts
    the full URL, so this works from any cwd as long as the login can see the
    repo). Best-effort and network-cheap — one gh call, capped by run()'s
    timeout. A GitLab merge-request URL dispatches to mr_status (XERK-162) and
    an Azure DevOps one to azdo_pr_status (XERK-226); both answer in the same
    shape, so every renderer treats the three alike."""
    if MR_URL_RE.match(str(url or "")):
        return mr_status(url)
    if AZDO_PR_URL_RE.match(str(url or "")):
        return azdo_pr_status(url)
    raw = run(["gh", "pr", "view", url, "--json",
               "number,title,state,isDraft,url,statusCheckRollup,mergeable,"
               "baseRefName"])
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return _summarize_pr(data)


def _mr_url_parts(url):
    """(project_path, iid) when `url` is a merge-request URL under the
    configured GITLAB_URL, else None. Prefix-matched against gitlab_base() so a
    GitLab installed under a subpath still resolves its project path; an MR on
    any OTHER GitLab host stays None — this host holds no credential for it,
    so its chip renders as a bare link, like a PR gh can't see."""
    base = gitlab_base()
    if not base or not gitlab_configured():
        return None
    u = str(url or "")
    if not u.startswith(base + "/"):
        return None
    m = re.match(r"(.+?)/-/merge_requests/(\d+)$", u[len(base) + 1:])
    if not m:
        return None
    return m.group(1), m.group(2)


def _mr_check_class(status):
    """Map a GitLab head-pipeline status to 'pass' | 'fail' | 'pending' | None,
    mirroring _check_class's buckets: skipped is a non-blocking pass, canceled
    blocks like a failure, and anything still moving — or waiting on a human
    (manual) — is pending."""
    s = str(status or "").lower()
    if s in ("success", "skipped"):
        return "pass"
    if s in ("failed", "canceled", "cancelled"):
        return "fail"
    if s in ("created", "waiting_for_resource", "preparing", "pending",
             "running", "manual", "scheduled"):
        return "pending"
    return None


def _summarize_mr(data):
    """Condense a GitLab merge-request API payload into the SAME compact status
    dict _summarize_pr builds, so every renderer treats an MR chip exactly like
    a PR chip (XERK-162). GitLab's vocabulary maps as: state opened→OPEN
    (draft→DRAFT), merged→MERGED, closed→CLOSED, locked→OPEN (a transient
    in-between); the head pipeline is the whole CI rollup (GitLab exposes no
    per-check rollup on the MR itself), one entry classed by _mr_check_class;
    mergeability comes from detailed_merge_status ("mergeable"→MERGEABLE,
    "conflict"→CONFLICTING, anything else UNKNOWN — unproven is not proven,
    exactly the discipline _merge_ready applies to GitHub's UNKNOWN), with the
    older merge_status can/cannot_be_merged as the fallback vocabulary."""
    raw_state = str(data.get("state") or "").lower()
    state = {"opened": "OPEN", "locked": "OPEN", "merged": "MERGED",
             "closed": "CLOSED"}.get(raw_state, raw_state.upper())
    draft = bool(data.get("draft") or data.get("work_in_progress"))
    state = "DRAFT" if draft and state == "OPEN" else state
    counts = {"pass": 0, "fail": 0, "pending": 0}
    pipeline = data.get("head_pipeline") or data.get("pipeline")
    cls = _mr_check_class((pipeline or {}).get("status")) if isinstance(
        pipeline, dict) else None
    if cls:
        counts[cls] += 1
    total = counts["pass"] + counts["fail"] + counts["pending"]
    checks = None
    if total:
        checks = ("failing" if counts["fail"]
                  else "pending" if counts["pending"] else "passing")
    detailed = str(data.get("detailed_merge_status") or "").lower()
    legacy = str(data.get("merge_status") or "").lower()
    if detailed == "mergeable" or (not detailed and legacy == "can_be_merged"):
        mergeable = "MERGEABLE"
    elif detailed == "conflict" or (not detailed and legacy == "cannot_be_merged"):
        mergeable = "CONFLICTING"
    else:
        mergeable = "UNKNOWN"
    return {
        "url": data.get("web_url"),
        "number": data.get("iid"),
        "title": (data.get("title") or "")[:120],
        "state": state,
        "checks": checks,
        "checkCounts": counts if total else None,
        "mergeable": mergeable,
        "ready": _merge_ready(state, checks, mergeable),
        "base": data.get("target_branch") or None,
    }


def mr_status(url):
    """pr_status for a GitLab merge request: state, head-pipeline rollup and
    mergeability from the configured GitLab's REST API — the MR counterpart of
    `gh pr view`, answering in the identical compact shape. None when the MR
    isn't under GITLAB_URL (no credential for a foreign GitLab) or on any
    fetch failure."""
    parts = _mr_url_parts(url)
    if not parts:
        return None
    proj, iid = parts
    data = _gitlab_get(
        f"projects/{urllib.parse.quote(proj, safe='')}/merge_requests/{iid}")
    if not isinstance(data, dict):
        return None
    out = _summarize_mr(data)
    out["url"] = out["url"] or url
    return out


# --- Azure DevOps pull requests (XERK-226) ---------------------------------
# The third PR source, answering everywhere GitHub and GitLab do. It reuses the
# board's PAT (AZDO_URL + AZDO_TOKEN) exactly as the MR half reuses GITLAB_URL:
# an ADO org already hands this host a credential, so a PR chip on an ADO repo
# costs no new config.

# url -> (projectId, repositoryId) for a PR this host has already resolved. The
# comment poller needs the project + repo to reach the threads API, and neither
# is in the PR's URL (which may omit the project entirely); caching the answer
# keeps a settled PR at ONE call per beat instead of two.
_AZDO_PR_REF = {}
_AZDO_PR_REF_MAX = 200

# Lowercased identity spellings of the PAT's own user, for is_self on comments —
# the ADO counterpart of GitHub's `viewerDidAuthor` and _gitlab_self_username.
# None until a successful probe, so a transient failure retries on a later beat.
_AZDO_SELF = {"ids": None}

# The policy types that ARE a pull request's CI. Azure DevOps has no "checks"
# concept: build validation and external status posts arrive as branch POLICY
# evaluations, alongside policies that are governance rather than CI (minimum
# reviewers, linked work items, comment resolution). Folding those in would make
# a PR merely waiting on a human reviewer report "CI pending", so `checks` is
# narrowed to the two CI-bearing types. Keyed on the policy type GUID, which is
# stable across locales and server versions; the English display names are the
# fallback for a payload that omits the id.
AZDO_CI_POLICY_IDS = {
    "0609b952-1397-4640-95ec-e00a01b2c241",  # Build (build validation)
    "cbdc66da-9728-4af8-aada-9a5a32e4a226",  # Status (an external CI's post)
}
AZDO_CI_POLICY_NAMES = {"build", "status"}


def _azure_get(path, params=None):
    """GET one Azure DevOps REST path with the configured PAT; parsed JSON, or
    None on any failure. The quiet best-effort shape the PR status/comment
    pollers need — unlike azure_req, whose raise carries the error into the
    board block."""
    try:
        return azure_req(path, params or {})
    except Exception:
        return None


def _azdo_pr_id(url):
    """The pull-request id when `url` is an Azure DevOps PR under the configured
    AZDO_URL, else None. Prefix-matched against azure_base() so a self-hosted
    collection (and a subpath install) resolves, while a PR on any OTHER ADO
    org stays None — this host holds no credential for it, so its chip renders
    as a bare link, like a PR gh can't see.

    Known limit, shared with the GitLab half: an org reached through its legacy
    `<org>.visualstudio.com` alias while AZDO_URL names `dev.azure.com/<org>`
    (or vice versa) doesn't prefix-match, and degrades to a bare link."""
    base = azure_base()
    if not base or not azure_configured():
        return None
    u = str(url or "")
    if not AZDO_PR_URL_RE.match(u):
        return None
    if not u.lower().startswith(base.lower() + "/"):
        return None
    m = AZDO_PR_URL_ID_RE.search(u)
    return m.group(1) if m else None


def _azdo_self_ids():
    """Every spelling of the PAT owner's own identity, lowercased, for marking a
    comment as the agent's own. ADO returns a comment's author as an IdentityRef
    (id + uniqueName + displayName) and which of those is populated varies by
    server, so all of them are compared. An empty set means "unknown" — the
    poller then treats every comment as someone else's, which is the safe way
    round (it delivers, it never silently swallows)."""
    if _AZDO_SELF["ids"] is None:
        data = _azure_get("/_apis/connectionData")
        au = (data or {}).get("authenticatedUser") or {}
        if au:
            props = (au.get("properties") or {}).get("Account") or {}
            vals = (au.get("id"), au.get("uniqueName"), au.get("mailAddress"),
                    au.get("providerDisplayName"), au.get("customDisplayName"),
                    props.get("$value"))
            _AZDO_SELF["ids"] = {str(v).strip().lower()
                                 for v in vals if str(v or "").strip()}
    return _AZDO_SELF["ids"] or set()


def _azdo_check_class(status):
    """Map one Azure DevOps policy-evaluation status to _check_class's buckets:
    approved passes, rejected/broken block, queued/running are pending, and
    notApplicable (or an enum this build doesn't know) counts for nothing."""
    s = str(status or "").lower()
    if s == "approved":
        return "pass"
    if s in ("rejected", "broken"):
        return "fail"
    if s in ("queued", "running"):
        return "pending"
    return None


def _azdo_is_ci_policy(ev):
    """Whether one policy-evaluation record is CI rather than governance —
    see AZDO_CI_POLICY_IDS."""
    ptype = ((ev.get("configuration") or {}).get("type") or {})
    if str(ptype.get("id") or "").lower() in AZDO_CI_POLICY_IDS:
        return True
    return str(ptype.get("displayName") or "").strip().lower() in AZDO_CI_POLICY_NAMES


def _azdo_policy_evals(pr):
    """The branch-policy evaluations for a fetched PR — the ADO stand-in for a
    CI rollup — or None when they can't be read.

    The evaluations API is keyed on a CodeReview artifact id, which is composed
    (not returned): `vstfs:///CodeReview/CodeReviewId/<projectId>/<prId>`. Note
    this is NOT the PR's own `artifactId` field, which is the /Git/PullRequestId
    form and addresses a different artifact."""
    repo = pr.get("repository") or {}
    project = repo.get("project") or {}
    proj = project.get("id") or project.get("name")
    pr_id = pr.get("pullRequestId")
    if not proj or pr_id is None:
        return None
    data = _azure_get(
        f"/{urllib.parse.quote(str(proj), safe='')}/_apis/policy/evaluations",
        {"artifactId": f"vstfs:///CodeReview/CodeReviewId/{proj}/{pr_id}",
         "api-version": f"{AZDO_API_VERSION}-preview.1"})
    value = (data or {}).get("value") if isinstance(data, dict) else None
    return value if isinstance(value, list) else None


def _summarize_azdo_pr(data, evals=None):
    """Condense an Azure DevOps pull-request payload into the SAME compact
    status dict _summarize_pr builds, so every renderer treats an ADO chip
    exactly like a GitHub one (XERK-226).

    ADO's vocabulary maps as: status active→OPEN (isDraft→DRAFT),
    completed→MERGED, abandoned→CLOSED. `checks` is the CI-bearing branch
    policies (see _azdo_policy_evals); `mergeable` comes from `mergeStatus`
    (succeeded→MERGEABLE, conflicts→CONFLICTING, anything else UNKNOWN —
    unproven is not proven, the discipline _merge_ready applies to GitHub's own
    UNKNOWN), which like GitHub's `mergeable` reports CONFLICTS ALONE, not
    whether every policy is satisfied.

    `evals` None means the policies weren't readable (no permission, an older
    server, a failed call), which reports as no CI rather than costing the whole
    chip — the same place a GitHub PR with no workflows lands."""
    raw = str(data.get("status") or "").lower()
    state = {"active": "OPEN", "completed": "MERGED",
             "abandoned": "CLOSED"}.get(raw, raw.upper())
    if data.get("isDraft") and state == "OPEN":
        state = "DRAFT"
    counts = {"pass": 0, "fail": 0, "pending": 0}
    for ev in evals or []:
        if not isinstance(ev, dict) or not _azdo_is_ci_policy(ev):
            continue
        cls = _azdo_check_class(ev.get("status"))
        if cls:
            counts[cls] += 1
    total = counts["pass"] + counts["fail"] + counts["pending"]
    checks = None
    if total:
        checks = ("failing" if counts["fail"]
                  else "pending" if counts["pending"] else "passing")
    merge = str(data.get("mergeStatus") or "").lower()
    mergeable = ("MERGEABLE" if merge == "succeeded"
                 else "CONFLICTING" if merge == "conflicts" else "UNKNOWN")
    base = str(data.get("targetRefName") or "")
    if base.startswith("refs/heads/"):
        base = base[len("refs/heads/"):]
    return {
        "url": None,
        "number": data.get("pullRequestId"),
        "title": (data.get("title") or "")[:120],
        "state": state,
        "checks": checks,
        "checkCounts": counts if total else None,
        "mergeable": mergeable,
        "ready": _merge_ready(state, checks, mergeable),
        "base": base or None,
    }


def _azdo_fetch_pr(url):
    """The raw pull-request payload for an ADO PR url, or None.

    Fetched org-scoped by id (`/_apis/git/pullrequests/<id>`) rather than
    through the repository route, because the URL need not carry the project or
    repo — the response is what names them, and the (project, repo) pair it
    yields is cached for the comment poller."""
    pr_id = _azdo_pr_id(url)
    if not pr_id:
        return None
    data = _azure_get(f"/_apis/git/pullrequests/{pr_id}")
    if not isinstance(data, dict) or data.get("pullRequestId") is None:
        return None
    repo = data.get("repository") or {}
    proj = (repo.get("project") or {}).get("id") or (repo.get("project") or {}).get("name")
    rid = repo.get("id") or repo.get("name")
    if proj and rid:
        if len(_AZDO_PR_REF) >= _AZDO_PR_REF_MAX:
            _AZDO_PR_REF.clear()
        _AZDO_PR_REF[url] = (str(proj), str(rid))
    return data


def azdo_pr_status(url):
    """pr_status for an Azure DevOps pull request: state, CI-policy rollup and
    mergeability from the configured org's REST API, in the identical compact
    shape. None when the PR isn't under AZDO_URL (no credential for a foreign
    org) or on any fetch failure.

    Two calls, not one: the policy evaluations are keyed on an artifact id that
    only the fetched PR can supply."""
    data = _azdo_fetch_pr(url)
    if data is None:
        return None
    out = _summarize_azdo_pr(data, _azdo_policy_evals(data))
    out["url"] = url
    return out


PR_URL_PARTS_RE = re.compile(r"github\.com/([^/]+)/([^/]+)/pull/(\d+)")
MR_URL_IID_RE = re.compile(r"/-/merge_requests/(\d+)")


def _pr_ref(url):
    """How to NAME a pull/merge request in a message typed into the session:
    ("PR"|"MR", "#12"|"!12"), or ("PR", "") for a url that carries no number.

    GitHub writes `#12`; GitLab and Azure DevOps both write `!12` (in ADO `#12`
    addresses a WORK ITEM, so the sigil is not interchangeable)."""
    m = PR_URL_PARTS_RE.search(url or "")
    if m:
        return "PR", f"#{m.group(3)}"
    m = MR_URL_IID_RE.search(url or "")
    if m:
        return "MR", f"!{m.group(1)}"
    m = AZDO_PR_URL_ID_RE.search(url or "")
    if m:
        return "PR", f"!{m.group(1)}"
    return "PR", ""


def _pr_comment_events(url, self_login):
    """Every human-visible comment on a PR, normalized to the fields the
    delivery poller needs (XERK-49). Three channels, because "reply in a PR"
    means any of them and a correction routinely arrives as an inline note on a
    diff line:

      - conversation comments (`gh pr view --json comments`),
      - review summaries with a body (`--json reviews` — a bare approve carries
        no correction text and is skipped),
      - inline review-thread comments on specific lines
        (`gh api repos/<o>/<r>/pulls/<n>/comments`).

    Each event is `{key, author, body, kind, loc, is_self}`. `key` is the item's
    stable GitHub id (its url as a fallback) — what the seen-set dedupes on.
    `is_self` marks a comment the agent's own login wrote (via GitHub's
    `viewerDidAuthor` where present, else a login compare), so the poller can
    baseline it as seen yet never react to the session's own words.

    Returns the event list (possibly empty — a real PR with no comments), or
    None on a hard fetch failure so the caller leaves the baseline untouched
    rather than treating "gh errored" as "every prior comment vanished".

    A GitLab merge-request URL dispatches to _mr_comment_events (XERK-162) and
    an Azure DevOps one to _azdo_pr_comment_events (XERK-226); both answer in
    the same event shape."""
    if MR_URL_RE.match(str(url or "")):
        return _mr_comment_events(url)
    if AZDO_PR_URL_RE.match(str(url or "")):
        return _azdo_pr_comment_events(url)
    raw = run(["gh", "pr", "view", url, "--json", "comments,reviews"])
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None

    def _login(obj):
        return str(((obj or {}).get("author") or {}).get("login") or "")

    def _is_self(obj, login):
        if obj.get("viewerDidAuthor"):
            return True
        return bool(self_login) and login == self_login

    events = []
    for c in data.get("comments") or []:
        if not isinstance(c, dict):
            continue
        body = str(c.get("body") or "").strip()
        if not body:
            continue
        login = _login(c)
        events.append({
            "key": str(c.get("id") or c.get("url") or ""),
            "author": login, "body": body, "kind": "comment", "loc": None,
            "is_self": _is_self(c, login),
        })
    for r in data.get("reviews") or []:
        if not isinstance(r, dict):
            continue
        body = str(r.get("body") or "").strip()
        if not body:                       # a bare approve/comment carries no text
            continue
        login = _login(r)
        state = str(r.get("state") or "").replace("_", " ").title()
        events.append({
            "key": str(r.get("id") or r.get("url") or ""),
            "author": login, "body": body,
            "kind": f"review {state}".strip(), "loc": None,
            "is_self": _is_self(r, login),
        })
    # Inline review-thread comments aren't in `gh pr view`; fetch them straight
    # from the API. Best-effort — a failure just leaves inline notes uncovered
    # this beat rather than losing the conversation ones already gathered.
    m = PR_URL_PARTS_RE.search(url or "")
    if m:
        owner, repo, num = m.group(1), m.group(2), m.group(3)
        raw2 = run(["gh", "api", f"repos/{owner}/{repo}/pulls/{num}/comments",
                    "--paginate"])
        if raw2:
            try:
                inline = json.loads(raw2)
            except ValueError:
                inline = None
            for c in inline or []:
                if not isinstance(c, dict):
                    continue
                body = str(c.get("body") or "").strip()
                if not body:
                    continue
                login = str((c.get("user") or {}).get("login") or "")
                loc = c.get("path") or None
                if loc and c.get("line"):
                    loc = f"{loc}:{c['line']}"
                events.append({
                    "key": str(c.get("id") or c.get("html_url") or ""),
                    "author": login, "body": body, "kind": "inline", "loc": loc,
                    "is_self": bool(self_login) and login == self_login,
                })
    return [e for e in events if e["key"]]


def _mr_comment_events(url):
    """_pr_comment_events for a GitLab merge request: every human note on the
    MR from one notes-API call — GitLab's notes cover both the conversation
    and inline diff notes (a `position` marks the latter, mapped to the same
    'inline' kind + file:line loc the GitHub channel emits). GitLab's own
    bookkeeping notes (`system: true` — "added 1 commit", approvals) are
    dropped; is_self compares the author against the token's own username.
    Same contract: the event list, or None on a hard fetch failure so the
    caller keeps its baseline."""
    parts = _mr_url_parts(url)
    if not parts:
        return None
    proj, iid = parts
    notes = _gitlab_get(
        f"projects/{urllib.parse.quote(proj, safe='')}/merge_requests/{iid}"
        f"/notes?per_page=100&order_by=created_at&sort=asc")
    if not isinstance(notes, list):
        return None
    self_user = _gitlab_self_username() or ""
    events = []
    for n in notes:
        if not isinstance(n, dict) or n.get("system"):
            continue
        body = str(n.get("body") or "").strip()
        if not body:
            continue
        author = str((n.get("author") or {}).get("username") or "")
        pos = n.get("position") if isinstance(n.get("position"), dict) else None
        loc = None
        if pos:
            loc = pos.get("new_path") or pos.get("old_path") or None
            line = pos.get("new_line") or pos.get("old_line")
            if loc and line:
                loc = f"{loc}:{line}"
        events.append({
            "key": str(n.get("id") or ""),
            "author": author, "body": body,
            "kind": "inline" if pos else "comment", "loc": loc,
            "is_self": bool(self_user) and author == self_user,
        })
    return [e for e in events if e["key"]]


def _azdo_pr_comment_events(url):
    """_pr_comment_events for an Azure DevOps pull request: every human comment
    on the PR from one threads call — ADO keeps the conversation and the inline
    diff notes in the same thread list, a `threadContext` marking the latter
    (mapped to the same 'inline' kind + file:line loc the GitHub channel emits).

    ADO's own bookkeeping ("X voted", "updated the source branch") arrives as
    comments of type `system`, and is dropped like GitLab's `system: true`
    notes. A comment id is only unique WITHIN its thread, so the seen-key is the
    pair.

    Same contract: the event list, or None on a hard fetch failure so the caller
    keeps its baseline."""
    pr_id = _azdo_pr_id(url)
    if not pr_id:
        return None
    ref = _AZDO_PR_REF.get(url)
    if not ref:
        pr = _azdo_fetch_pr(url)
        ref = _AZDO_PR_REF.get(url) if pr is not None else None
    if not ref:
        return None
    proj, repo = ref
    data = _azure_get(
        f"/{urllib.parse.quote(proj, safe='')}/_apis/git/repositories/"
        f"{urllib.parse.quote(repo, safe='')}/pullRequests/{pr_id}/threads")
    threads = (data or {}).get("value") if isinstance(data, dict) else None
    if not isinstance(threads, list):
        return None
    mine = _azdo_self_ids()
    events = []
    for th in threads:
        if not isinstance(th, dict) or th.get("id") is None:
            continue
        ctx = th.get("threadContext")
        ctx = ctx if isinstance(ctx, dict) else None
        loc = None
        if ctx:
            loc = ctx.get("filePath") or None
            pos = ctx.get("rightFileStart") or ctx.get("leftFileStart") or {}
            line = pos.get("line") if isinstance(pos, dict) else None
            if loc and line:
                loc = f"{loc}:{line}"
        for c in th.get("comments") or []:
            if not isinstance(c, dict) or c.get("id") is None:
                continue
            if str(c.get("commentType") or "").lower() == "system":
                continue
            body = str(c.get("content") or "").strip()
            if not body:
                continue
            author = c.get("author") if isinstance(c.get("author"), dict) else {}
            spellings = {str(v).strip().lower() for v in (
                author.get("id"), author.get("uniqueName"),
                author.get("displayName")) if str(v or "").strip()}
            events.append({
                "key": f"{th['id']}:{c['id']}",
                "author": str(author.get("displayName")
                              or author.get("uniqueName") or ""),
                "body": body,
                "kind": "inline" if ctx else "comment", "loc": loc,
                "is_self": bool(mine & spellings),
            })
    return events


def _pr_comment_message(url, events):
    """Fold new PR comments into the single free-text message typed into the
    session (XERK-49). One flat paragraph — a header naming the PR and telling
    the agent to act on it in THIS session, then each comment as
    `@author (kind, loc): body`, each body collapsed to one line and capped so
    one long comment can't crowd out the rest before INPUT_MAX_CHARS truncates."""
    if not events:
        return ""
    what, num = _pr_ref(url)
    parts = [f"New review activity on the {what} {num} you opened ({url}). "
             f"Address it and update the {what} — continue in this session:"]
    for e in events:
        who = f"@{e['author']}" if e.get("author") else "someone"
        tag = e.get("kind") or "comment"
        if e.get("loc"):
            tag = f"{tag} on {e['loc']}"
        body = " ".join(str(e.get("body") or "").split())[:PR_COMMENTS_BODY_CAP]
        parts.append(f"[{who} — {tag}] {body}")
    return "  ".join(parts)


def _pr_conflict_message(url, base, again=False):
    """The message typed into the authoring session when its own PR/MR stops
    being mergeable (XERK-223).

    It asks for a MERGE of the base branch, never a rebase: a merge lands with
    an ordinary `git push`, while a rebase rewrites the branch and needs a force
    push — more ways to lose work, for no gain on a branch that is about to be
    squashed anyway. The base branch is named when we know it (`base`, off the
    PR status) so the agent doesn't have to guess which branch to merge.

    Deliberately says what to achieve and leaves the how to the session: it is
    the only thing on this host that knows what the conflicting code MEANS."""
    what, num = _pr_ref(url)
    into = f"origin/{base}" if base else "the base branch (see the PR)"
    lead = ("still has merge conflicts" if again else "has merge conflicts")
    return (
        f"The {what} {num} you opened ({url}) {lead} with its base branch and "
        f"cannot be merged. Resolve them in this session now, without being "
        f"asked again: git fetch origin, merge {into} into the {what}'s branch, "
        f"resolve every conflict on its merits (keep both sides' intent — do "
        f"not discard someone else's work to make the merge trivial), make sure "
        f"the build and tests still pass, then commit and push so the {what} "
        f"goes back to mergeable. Do not rebase or force-push the branch, and "
        f"do not merge the {what} itself. If a conflict genuinely needs a human "
        f"decision, say so on the {what} instead of guessing.")


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


def _last_activity_ts(path):
    """ISO timestamp of the newest transcript entry that carries one — the true
    'last new message' time (XERK-73). This is the accurate sort key for the
    ended list, immune to the file-mtime drift the `resumable` scan otherwise
    inherits: a week-old conversation copied onto this host (a synced ~/.claude,
    a backup restore) gets mtime=now and sorts to the top though nothing was
    said, but its entries keep their original UTC timestamps. Scans the tail
    newest-first and returns the first entry's `timestamp`; None when no tail
    entry has one (an older/odd transcript), leaving the caller its mtime
    fallback."""
    for raw in reversed(_read_tail_lines(path, 1 << 17)):  # ~128 KB
        try:
            entry = json.loads(raw)
        except ValueError:
            continue  # partial write at the tail, or the seek-point fragment
        if isinstance(entry, dict) and entry.get("timestamp"):
            return entry["timestamp"]
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
        # Which background agent this is about — the same id its launch reported
        # as `agentId:`. It is what makes the notification a usable STOPPED edge
        # for the live-agent scan (XERK-245), not just display text.
        "taskId": _tn_tag("task-id", body),
    }


def _tn_preview(tn):
    """Flatten a parsed task-notification to display text (summary + result), the
    text-feed form used by the glasses tail, heartbeat preview and archive."""
    parts = [tn["summary"] or tn["status"] or "background task update"]
    if tn["result"]:
        parts.append(tn["result"])
    return "\n\n".join(p for p in parts if p)


# Running a slash command writes three more XML-ish user-role turns that are not
# the human talking either: a boilerplate <local-command-caveat> telling the
# model to ignore what follows, the <command-name>/<command-args> invocation
# wrapper, and the command's <local-command-stdout>/<local-command-stderr>.
# Rendered verbatim they read as the operator typing raw XML into chat, so —
# exactly as with <task-notification> above — we parse them here into structured
# blocks the web chat renders as a command chip / output card, and drop the
# caveat outright. Keep mirrored with tunnel-agent.js parseLocalCommand().
#
# Matched with `search`, not `match`: Claude Code emits the wrapper tags indented
# and sometimes with sibling text, so anchoring to the whole string would miss
# them. The caveat, by contrast, is the ENTIRE entry when present, hence fullmatch.
LOCAL_COMMAND_CAVEAT_RE = re.compile(
    r"\s*<local-command-caveat>.*?</local-command-caveat>\s*", re.DOTALL)
COMMAND_NAME_RE = re.compile(r"<command-name>(.*?)</command-name>", re.DOTALL)
COMMAND_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.DOTALL)
COMMAND_STDOUT_RE = re.compile(
    r"<local-command-stdout>(.*?)</local-command-stdout>", re.DOTALL)
COMMAND_STDERR_RE = re.compile(
    r"<local-command-stderr>(.*?)</local-command-stderr>", re.DOTALL)

# The `!` prefix runs a shell command straight from the composer/TUI, and
# Claude Code records it as two more XML-ish user turns: the command
# (<bash-input>) and its output (<bash-stdout>/<bash-stderr>). Not the human
# talking either — parse them into the SAME command/output shapes the slash
# commands produce (name "!", the exact prefix the operator typed), so the chat
# renders a chip + output card instead of a raw-XML user bubble. Keep mirrored
# with tunnel-agent.js parseLocalCommand.
BASH_INPUT_RE = re.compile(r"<bash-input>(.*?)</bash-input>", re.DOTALL)
BASH_STDOUT_RE = re.compile(r"<bash-stdout>(.*?)</bash-stdout>", re.DOTALL)
BASH_STDERR_RE = re.compile(r"<bash-stderr>(.*?)</bash-stderr>", re.DOTALL)


def _parse_local_command(text):
    """Parse one of Claude Code's slash-command / `!`-shell bookkeeping turns,
    or None when `text` isn't one. Mirror of tunnel-agent.js parseLocalCommand().
    Returns:
      {"kind": "caveat"}                        -> drop the entry entirely
      {"kind": "command", "name", "args"}       -> the /slash or ! invocation
      {"kind": "output", "text", "isError"}     -> the command's stdout/stderr
    stderr wins over stdout when a turn carries both, so a failing command reads
    as an error rather than silently showing its (usually empty) stdout — the
    same rule for both the slash and the bash tags."""
    if not text:
        return None
    if LOCAL_COMMAND_CAVEAT_RE.fullmatch(text):
        return {"kind": "caveat"}
    m = COMMAND_NAME_RE.search(text)
    if m:
        name = ANSI_RE.sub("", m.group(1)).strip()
        args = COMMAND_ARGS_RE.search(text)
        if name:
            return {
                "kind": "command",
                "name": name,
                "args": ANSI_RE.sub("", args.group(1)).strip() if args else "",
            }
    m = BASH_INPUT_RE.search(text)
    if m:
        cmd = ANSI_RE.sub("", m.group(1)).strip()
        if cmd:
            return {"kind": "command", "name": "!", "args": cmd}
    first = None
    for regex, is_error in ((COMMAND_STDERR_RE, True), (BASH_STDERR_RE, True),
                            (COMMAND_STDOUT_RE, False), (BASH_STDOUT_RE, False)):
        m = regex.search(text)
        if m:
            out = {
                "kind": "output",
                "text": ANSI_RE.sub("", m.group(1)).strip(),
                "isError": is_error,
            }
            # stderr wins over stdout ONLY when it carries text — a bash turn
            # routinely ships both tags with one of them empty, and an empty
            # stderr must not swallow the stdout beside it (or vice versa).
            if out["text"]:
                return out
            if first is None:
                first = out
    return first


def _lc_preview(lc):
    """Flatten a parsed local-command turn to display text, the text-feed form
    used by the glasses tail, heartbeat preview and archive — or None to drop it
    (the caveat, and an output turn that carried nothing)."""
    if lc["kind"] == "caveat":
        return None
    if lc["kind"] == "command":
        return " ".join(p for p in (lc["name"], lc["args"]) if p)
    return lc["text"] or None


def _entry_first_text(entry):
    """The entry's first raw text payload (string content, or the first `text`
    block of list content), or "" — the pre-flatten form callers need to ask
    what KIND of turn this is."""
    msg = entry.get("message")
    if not isinstance(msg, dict):
        return ""
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                return str(block.get("text") or "")
    return ""


def _entry_local_command(entry):
    """The parsed slash-command turn this entry IS, or None. Callers that want
    to skip command plumbing must ask this rather than sniffing _entry_text's
    output, which has already flattened the wrapper away."""
    return _parse_local_command(_entry_first_text(entry))


# Pressing Esc (or the hub's Stop button) mid-turn writes a user-role
# "[Request interrupted by user]" / "[Request interrupted by user for tool
# use]" marker entry. That is a statement ABOUT the turn, not something the
# operator typed, so _entry_blocks classifies it as an `interrupt` block the
# chat renders as a muted status marker instead of a user bubble. The text
# feed (_entry_text) keeps the raw bracket line: glasses/heartbeat/archive are
# one-dimensional text, where it already reads as the marker it is. Keep
# mirrored with tunnel-agent.js INTERRUPT_RE.
INTERRUPT_RE = re.compile(r"^\s*\[Request interrupted by user[^\]\n]*\]\s*$")


# Claude Code's "while you were away" recap: a `system` entry (subtype
# "away_summary") whose content is prose the model wrote about what happened
# since the operator left — the TUI paints it as a recap box, so the chat
# should too rather than dropping it with the rest of the system bookkeeping
# (turn_duration, bridge_status, …, which stay dropped). The trailing
# "(disable recaps in /config)" hint is a TUI affordance the chat has no
# equivalent of, so it is stripped.
AWAY_HINT_RE = re.compile(r"\s*\(disable recaps in /config\)\s*$")


def _away_summary_text(entry):
    """The recap text of an away_summary system entry, or None when `entry`
    isn't one (any other type/subtype, or empty content). Mirror of
    tunnel-agent.js awaySummaryText."""
    if entry.get("type") != "system" or entry.get("subtype") != "away_summary":
        return None
    text = AWAY_HINT_RE.sub("", ANSI_RE.sub("", str(entry.get("content") or ""))).strip()
    return text or None


def _entry_tool_source(entry):
    """The tool_use id this user turn was PRODUCED BY, or None.

    Claude Code feeds a skill's body back to the model by writing it as a
    user-role turn — role `user` is the only channel tool output can travel on —
    tagged with `sourceToolUseID`, the id of the `Skill` tool_use that pulled it
    in. So on a user turn that field means "the tooling authored this, not the
    operator": every such entry on this box resolves to a Skill call.

    Taken at its wire role the entry renders as the human typing a whole
    SKILL.md into chat (151KB for some skills). It is really the tool's result,
    so that's what we emit: _entry_blocks() hands it back as the tool_result of
    its own Skill call, which the chat pairs into that call's action card, and
    _entry_text() drops it like any other tool_result. Keyed on sourceToolUseID
    rather than the broader `isMeta`, which also tags hook feedback, command
    caveats and resume prompts — turns with quite different authors.

    Mirror of tunnel-agent.js entryToolSource()."""
    if entry.get("type") != "user":
        return None
    return entry.get("sourceToolUseID") or None


def _entry_id(entry):
    """The entry's own uuid, or a synthesized stable id for the entry types
    Claude Code writes WITHOUT one (pr-link): the client's tail merge dedups on
    id and drops id-less entries, so without this a pr_link block never reaches
    the chat. Mirror of tunnel-agent.js entryId().

    A pr-link keys on its URL ALONE, deliberately excluding the timestamp: Claude
    Code re-stamps a session's PR links in the metadata preamble it writes at the
    top of every user turn (beside last-prompt/ai-title/mode/permission-mode), so
    one PR yields ~6 entries differing only in `timestamp`. They are re-records of
    one fact, not separate events, and sharing an id is what lets the tail merge
    collapse them to the FIRST — which lands within a few entries of the `gh pr
    create` that opened it, i.e. where the PR really landed in the conversation."""
    eid = entry.get("uuid")
    if eid:
        return eid
    if entry.get("type") == "pr-link":
        return "pr-link:%s" % (entry.get("prUrl") or "",)
    return None


def _entry_role(entry):
    """Display role for a transcript entry. Normally the entry type, but a
    compact summary is written as a USER turn carrying text the model wrote
    about itself — showing it on the human's side (as the raw transcript role
    would) misattributes it, so it reports as the assistant. A system entry
    only ever survives the feeds as an away_summary recap (see
    _away_summary_text), which the model also wrote — same rule."""
    if entry.get("isCompactSummary"):
        return "assistant"
    if entry.get("type") == "system":
        return "assistant"
    return entry.get("type")


def _flatten_text(raw):
    """One text payload -> its text-feed form: a <task-notification> or
    slash-command bookkeeping turn flattened to its preview, anything else
    verbatim. None to drop the payload (a caveat / empty command output)."""
    tn = _parse_task_notification(raw)
    if tn:
        return _tn_preview(tn)
    lc = _parse_local_command(raw)
    if lc:
        return _lc_preview(lc)
    return raw


def _entry_text(entry):
    """Map one transcript entry to display text for the glasses tail feed, or
    None to drop it (wrong type, no message, tool_result-only turn, a skill body
    (_entry_tool_source), a slash-command caveat, or empty after stripping
    ANSI). An away_summary system entry survives as its recap text (role
    "assistant" via _entry_role); every other system subtype stays dropped."""
    away = _away_summary_text(entry)
    if away is not None:
        return away
    if entry.get("type") not in ("user", "assistant"):
        return None
    # Tool-authored: a tool_result by another name, and this feed drops those.
    # The invoking `[Skill]` tool_use still shows in the assistant turn, and its
    # arguments ride that call's input, so nothing readable is lost — only the
    # SKILL.md wall, which would otherwise dominate the tail, the heartbeat
    # preview and the archive's search index.
    if _entry_tool_source(entry):
        return None
    msg = entry.get("message")
    if not isinstance(msg, dict):
        return None
    content = msg.get("content")
    if isinstance(content, str):
        text = _flatten_text(content)
        if text is None:
            return None
    elif isinstance(content, list):
        parts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text":
                flat = _flatten_text(str(block.get("text") or ""))
                if flat is not None:
                    parts.append(flat)
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
_TOOL_INPUT_KEYS = ("command", "file_path", "path", "pattern", "url", "query", "prompt",
                    "skill", "subject")


def _tool_input_summary(inp):
    """A compact display string for a tool_use `input` object: the salient arg
    for known tools, else a compact JSON dump, else str(). An AskUserQuestion
    call's salient arg is the question text itself, nested in its `questions`
    list — joined here so the card reads as the question(s) asked, not a JSON
    dump of the whole picker structure."""
    if isinstance(inp, dict):
        questions = inp.get("questions")
        if isinstance(questions, list):
            texts = [q["question"].strip() for q in questions
                     if isinstance(q, dict) and isinstance(q.get("question"), str)
                     and q["question"].strip()]
            if texts:
                return " · ".join(texts)
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


def _send_user_file_detail(inp):
    """Read the image/SVG/HTML files a SendUserFile call delivered and return a
    list of preview entries for its tool_use block (XERK-221), or None:
      image -> {"name", "kind":"image", "src": "data:<mime>;base64,<b64>"}
      html  -> {"name", "kind":"html",  "html": "<markup>"}   (display:"render" only)
      else  -> {"name", "kind":"file"}   (attach-mode HTML, oversize, unreadable, or
                                          a non-renderable type — a bare name chip)
    Images render regardless of `display` (they ARE the delivery); HTML renders
    only when the call asked to (`display:"attach"` is a download, not a preview).
    Only image/html paths are ever opened, and each is read at most
    SEND_FILE_MAX_BYTES, so a delivery can neither bloat the frame nor leak an
    arbitrary file's bytes. Mirror of tunnel-agent.js sendUserFileDetail()."""
    files = inp.get("files")
    if not isinstance(files, list) or not files:
        return None
    display = inp.get("display")
    out = []
    for path in files[:SEND_FILE_MAX_FILES]:
        if not isinstance(path, str) or not path:
            continue
        name = os.path.basename(path)
        ext = os.path.splitext(path)[1].lower()
        mime = SEND_FILE_IMG_MIME.get(ext)
        render_html = ext in SEND_FILE_HTML_EXT and display != "attach"
        entry = {"name": name, "kind": "file"}
        if mime or render_html:
            try:
                with open(path, "rb") as fh:
                    data = fh.read(SEND_FILE_MAX_BYTES + 1)
                if len(data) <= SEND_FILE_MAX_BYTES:
                    if mime:
                        entry = {"name": name, "kind": "image",
                                 "src": "data:%s;base64,%s" % (mime, base64.b64encode(data).decode("ascii"))}
                    else:
                        entry = {"name": name, "kind": "html", "html": data.decode("utf-8", "replace")}
            except OSError:
                pass  # unreadable / gone → name chip
        out.append(entry)
    return out or None


def _tool_use_detail(block, name, inp, caps):
    """Attach the reviewable payload of a known tool call to its tool_use block,
    beyond the one-line `input` summary — the part an operator otherwise opens
    the raw terminal to see. Returns True when a payload was clipped by its cap
    (the caller flags the block truncated so "Show more" refetches the FULL copy).

      Edit          -> edit: {old, new, replaceAll?}   (the actual change, as a diff)
      Write         -> content: the file body written
      ExitPlanMode  -> plan: the plan markdown the operator was asked to approve
      SendUserFile  -> files: [{name, kind, src|html}] + caption  (inline preview)
      any tool      -> desc: its human `description` arg (Bash, Agent, Monitor, …)

    Mirror of tunnel-agent.js toolUseDetail()."""
    if not isinstance(inp, dict):
        return False
    truncated = False
    if name == "Edit":
        old, new = inp.get("old_string"), inp.get("new_string")
        if isinstance(old, str) or isinstance(new, str):
            old_c, old_t = _clip(ANSI_RE.sub("", str(old or "")), caps["result"])
            new_c, new_t = _clip(ANSI_RE.sub("", str(new or "")), caps["result"])
            edit = {"old": old_c, "new": new_c}
            if inp.get("replace_all"):
                edit["replaceAll"] = True
            block["edit"] = edit
            truncated = old_t or new_t
    elif name == "Write":
        content = inp.get("content")
        if isinstance(content, str) and content.strip():
            clipped, trunc = _clip(ANSI_RE.sub("", content), caps["result"])
            block["content"] = clipped
            truncated = trunc
    elif name == "ExitPlanMode":
        plan = inp.get("plan")
        if isinstance(plan, str) and plan.strip():
            clipped, trunc = _clip(ANSI_RE.sub("", plan).strip(), caps["text"])
            block["plan"] = clipped
            truncated = trunc
    elif name == "SendUserFile":
        files = _send_user_file_detail(inp)
        if files:
            block["files"] = files
            cap = inp.get("caption")
            if isinstance(cap, str) and cap.strip():
                block["caption"] = _clip(ANSI_RE.sub("", cap).strip(), caps["input"])[0]
    desc = inp.get("description")
    if isinstance(desc, str) and desc.strip():
        block["desc"] = _clip(ANSI_RE.sub("", desc).strip(), caps["input"])[0]
    return truncated


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
                elif block.get("type") == "tool_reference":
                    # A ToolSearch result names the tools it loaded as
                    # tool_reference blocks; flattening them away left the
                    # call's output card reading empty. Own line each.
                    parts.append(f"\n[tool: {block.get('tool_name') or 'tool'}]")
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    if content is None:
        return ""
    return str(content)


def _scan_pr_line(raw, state, report):
    """Fold one appended transcript line into a session's PR-URL scan.

    Attribution is deliberately narrow: a URL counts only when it comes back in
    a PR/MR-creating call's OWN tool_result (`gh pr create`, `glab mr create`,
    `az repos pr create`, or a `git push` carrying the `merge_request.create`
    push option — see PR_CREATE_RE) — i.e. the session literally opened that PR. A PR link reaches a transcript a dozen other ways (`gh pr
    list`/`view`/`checks` output, a link the operator pasted, the model quoting
    a PR another session opened), and taking any of those as "this session's
    PR" is what used to hang a chip — and fire a "created a PR" alert — on the
    wrong card, for a PR the session never touched.

    The call and its result are separate entries and routinely land in
    different beats, so the pending tool_use ids live in `state` across beats.
    """
    try:
        entry = json.loads(raw)
    except ValueError:
        return  # partial write, or the backlog cap's leading fragment
    if isinstance(entry, dict):
        _scan_pr_entry(entry, state, report)


# A repository's own web URL, as the Azure DevOps API reports it — the base the
# PR's browser link is built on. Anchored whole so nothing but a repo root is
# ever extended into a PR link.
AZDO_REPO_WEB_RE = re.compile(
    r"^https://[\w.-]+(?::\d+)?(?:/[^\s/?#]+)*/_git/[^\s/?#]+$", re.IGNORECASE)
# `{` probes tried when looking for a JSON object in a tool result. The az
# output starts with one, so a real create hits on the first; the cap keeps a
# result that is merely full of braces from costing a re-parse per brace.
JSON_OBJECT_PROBES = 5


def _first_json_object(text):
    """The first complete JSON object in `text`, or None. A CLI prints its JSON
    with whatever banner/warning lines it feels like, so the object is located
    rather than assumed to be the whole output."""
    s = str(text or "")
    dec = json.JSONDecoder()
    idx = s.find("{")
    for _ in range(JSON_OBJECT_PROBES):
        if idx < 0:
            break
        try:
            obj, _end = dec.raw_decode(s, idx)
        except ValueError:
            idx = s.find("{", idx + 1)
            continue
        if isinstance(obj, dict):
            return obj
        idx = s.find("{", idx + 1)
    return None


def _azdo_created_pr_url(text):
    """The browser URL of the pull request an `az repos pr create` just opened,
    composed from that command's OWN output, or None (XERK-226).

    Unlike `gh pr create` / `glab mr create`, the Azure DevOps CLI prints the
    created pull-request OBJECT and no link — the browser URL exists nowhere in
    the output. It is composed here the way the ADO web UI composes it,
    `<repository web url>/pullrequest/<id>`, and only when BOTH halves are
    present and the repository url is really a repository root, so nothing is
    invented. This is not a widening of attribution: it runs only inside a
    tool_result already tied to a PR-creating call."""
    data = _first_json_object(text)
    if not isinstance(data, dict):
        return None
    repo = data.get("repository")
    pr_id = data.get("pullRequestId")
    if not isinstance(repo, dict) or not isinstance(pr_id, int):
        return None
    web = str(repo.get("webUrl") or repo.get("remoteUrl") or "").strip()
    # `remoteUrl` can carry a `user@` prefix on some collections; the link the
    # chip points at must not.
    web = re.sub(r"^(https://)[^/@]+@", r"\1", web).rstrip("/")
    if not AZDO_REPO_WEB_RE.match(web):
        return None
    return f"{web}/pullrequest/{pr_id}"


def _scan_pr_entry(entry, state, report):
    """_scan_pr_line's fold, taking the already-parsed entry (the shared
    per-line scan parses each line once for every scanner)."""
    msg = entry.get("message") if isinstance(entry, dict) else None
    content = msg.get("content") if isinstance(msg, dict) else None
    if not isinstance(content, list):
        return
    calls = state.setdefault("pr_calls", [])
    seen = state.setdefault("pr_seen", set())
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "tool_use":
            cmd = (block.get("input") or {}).get("command")
            if (block.get("name") == "Bash" and isinstance(cmd, str)
                    and PR_CREATE_RE.search(cmd) and block.get("id")):
                calls.append(block["id"])
                del calls[:-PR_CALLS_MAX]
        elif block.get("type") == "tool_result" and block.get("tool_use_id") in calls:
            text = _tool_result_text(block.get("content"))
            found = []
            for rx in (PR_URL_RE, MR_URL_RE, AZDO_PR_URL_RE):
                found.extend(m.group(0) for m in rx.finditer(text))
            if not any(AZDO_PR_URL_RE.match(u) for u in found):
                # `az repos pr create` reports the PR it opened as a JSON object
                # carrying no browser link at all, so the URL is composed from
                # that object (XERK-226). Only consulted when the output printed
                # no ADO PR link of its own, so one create can't chip twice.
                composed = _azdo_created_pr_url(text)
                if composed:
                    found.append(composed)
            for url in found:
                if url not in seen:
                    seen.add(url)
                    report["prUrls"].append(url)


# The confirmation line Claude Code prints (and transcribes as local-command
# stdout) when its model changes: "Set model to <X> for this session only" /
# "…and saved as your default for new sessions". The captured label ("Sonnet 5")
# is display text, not a model id. "Kept model as X" (a cancelled picker) is
# deliberately not matched — nothing changed.
SET_MODEL_STDOUT_RE = re.compile(
    r"Set model to\s+(.+?)"
    r"(?:\s+for this session only|\s+and saved as your default\b.*)?\s*$",
    re.MULTILINE)


def _scan_model_entry(entry, report):
    """Fold one parsed transcript entry into the session's actual-model read.

    Two signals, both chronological (the scan feeds lines in order, so the last
    one seen wins): an assistant entry's `message.model` — the id of the model
    that actually produced that turn — and the "Set model to X" local-command
    stdout a live `/model` switch writes, which confirms a switch the instant it
    lands rather than a whole turn later. The result is a model ID in the first
    case and a display label in the second; the hub's prettifier renders both."""
    if entry.get("type") == "assistant":
        model = (entry.get("message") or {}).get("model")
        # "<synthetic>" is Claude Code's stamp on entries it fabricates itself
        # (e.g. error placeholders) — not a model that answered.
        if isinstance(model, str) and model and not model.startswith("<"):
            report["modelActual"] = model
        return
    if entry.get("type") == "system" and entry.get("subtype") == "local_command":
        lc = _parse_local_command(entry.get("content") or "")  # `claude -p` shape
    else:
        lc = _entry_local_command(entry)  # the interactive-TUI (user turn) shape
    if not lc or lc.get("kind") != "output" or not lc.get("text"):
        return
    m = SET_MODEL_STDOUT_RE.search(lc["text"])
    if m:
        report["modelActual"] = m.group(1).strip()


def _scan_entry_line(raw, state, report):
    """Fold one appended transcript line into every incremental per-beat scan
    (PR attribution + actual model) with a single JSON parse."""
    try:
        entry = json.loads(raw)
    except ValueError:
        return  # partial write, or the backlog cap's leading fragment
    if not isinstance(entry, dict):
        return
    _scan_pr_entry(entry, state, report)
    _scan_model_entry(entry, report)
    _scan_agent_entry(entry, state)


# ---- live background agents, off the transcript (XERK-245) -------------------
#
# WHICH background agents this session has in flight. The transcript records
# BOTH edges exactly, so this is derived from data rather than inferred from the
# screen:
#
#   started  a Task tool_use ({subagent_type, description}) whose paired
#            tool_result says "Async agent launched successfully … agentId: X"
#   stopped  a <task-notification> carrying <task-id>X</task-id> and a terminal
#            <status> (completed / failed / killed / stopped)
#
# **The TUI's footer list is NOT the source and must not become one again.** It
# was, and it failed twice: its rows are pane CONTENT, so a quoted footer plus a
# composer-less full-screen view forged them (a session named after a sentence,
# reading "working" forever and held out of Ready for review) — and, measured on
# a live TUI, the rows LINGER ~24s after an agent finishes, so a single capture
# cannot tell a running agent from a just-finished one at all. Same reason
# pending questions come from the ask.py bridge and never from scraping.
#
# Failure direction is EMPTY: a launch this scan never saw (an agent restart
# primes the byte offsets to EOF) reports no agents, which is the behaviour that
# predates the feature. A phantom would instead strand work silently.
# Every status Claude Code writes is terminal — "the agent stopped" — so the set
# is a guard against a future non-terminal one, not a filter of today's.
AGENT_DONE_STATUSES = frozenset({"completed", "failed", "killed", "stopped", "error"})
# One session's fan-out is a handful; this bounds a pathological transcript.
LIVE_AGENTS_MAX = 32


def _async_launch(entry):
    """`{id, type, label}` iff this entry is a BACKGROUND WORK launch, else None.

    Keyed on the structured record Claude Code writes beside the tool_result —
    `{status: "async_launched", …}` — which across the corpus is produced by
    exactly three tools and nothing else: `Agent` and `Task` (carrying
    `agentId`/`description`) and `Workflow` (carrying `taskId`/`workflowName`,
    and no `isAsync` at all).

    **Never scan loose text for `agentId:`.** That was tried and is exactly how a
    permanent phantom gets in: the string appears in the OUTPUT of any ordinary
    tool — a `grep`/`cat`/`Read` over a transcript, a QA fixture, another
    session's scratch file — and an id belonging to some other session can never
    receive its own notification here, so the phantom never clears. (The earlier
    pane-scrape phantoms at least self-cleared.) A structured field cannot be
    produced by a tool printing text: `async_launched` appears on none of the
    12k+ `Bash`, 3k `Read` or 4k `Edit` results, and no MCP tool writes a dict
    `toolUseResult` at all.

    It also excludes a SYNCHRONOUS subagent result, which is already finished
    when it lands (its shape carries `content`/`usage`, and no `status`).
    **`isAsync` is deliberately NOT required**: it would exclude `Workflow`,
    whose background runs are the longest-lived work on a host — a session
    running a background `code-review` read idle for its whole duration."""
    tur = entry.get("toolUseResult") if isinstance(entry, dict) else None
    if not isinstance(tur, dict) or tur.get("status") != "async_launched":
        return None
    ident = tur.get("agentId") or tur.get("taskId")
    if not ident:
        return None
    if tur.get("taskType") == "local_workflow":
        return {"id": str(ident), "type": "workflow",
                "label": str(tur.get("workflowName") or tur.get("summary") or "").strip()}
    return {"id": str(ident), "type": str(tur.get("agentType") or "agent"),
            "label": str(tur.get("description") or "").strip()}


def _scan_agent_entry(entry, state):
    """Fold one transcript entry into `state["liveAgents"]` ({id: {type,label}}).

    The launch's own record carries the description, so the only thing kept from
    the CALL is the agent type, which lives on the tool_use input and not on the
    result. The tool is named `Agent` in current Claude Code and `Task` in older
    transcripts — **both count**; keying on `Task` alone made every real launch
    fall back to an unnamed row."""
    live = state.setdefault("liveAgents", {})
    tasks = state.setdefault("agentTasks", {})
    stopped = state.setdefault("stoppedAgents", [])
    msg = entry.get("message") if isinstance(entry, dict) else None
    content = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use" and block.get("name") in ("Agent", "Task"):
                inp = block.get("input") or {}
                atype = str(inp.get("subagent_type") or "").strip()
                if block.get("id") and atype:
                    tasks[block["id"]] = atype
                    # Bounded: a long conversation would otherwise accumulate one
                    # entry per launch for the life of the session.
                    while len(tasks) > LIVE_AGENTS_MAX * 4:
                        tasks.pop(next(iter(tasks)))
    launch = _async_launch(entry)
    if launch and len(live) < LIVE_AGENTS_MAX:
        # A notification can be WRITTEN BEFORE the launch it refers to (observed:
        # the queued copy lands at an earlier file offset than the launch, with a
        # LATER timestamp). Registering here would then never be undone, so a
        # stop already seen wins over a later-read launch.
        if launch["id"] not in stopped:
            tool_id = None
            for block in (content if isinstance(content, list) else []):
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    tool_id = block.get("tool_use_id")
            # The call's subagent_type is the only place a real agent TYPE
            # appears — the launch record never carries one — so it wins when we
            # saw the call.
            live[launch["id"]] = {"type": tasks.get(tool_id) or launch["type"],
                                  "label": launch["label"]}
    # The notification rides a queued operation, the user turn it becomes once
    # dequeued, or an attachment — never an ASSISTANT turn, which is skipped so
    # that a session merely QUOTING a notification (this feature's own fixtures,
    # say) cannot retire an agent that is still running.
    if entry.get("type") != "assistant":
        for text in _entry_texts_for_scan(entry):
            tn = _parse_task_notification(text)
            if not tn or not tn.get("taskId"):
                continue
            if not tn.get("status") or tn["status"] in AGENT_DONE_STATUSES:
                live.pop(tn["taskId"], None)
                if tn["taskId"] not in stopped:
                    stopped.append(tn["taskId"])
                    del stopped[:-LIVE_AGENTS_MAX * 4]


def _entry_texts_for_scan(entry):
    """The raw strings on one entry that could BE a `<task-notification>`: a
    queue-operation's content, and any string/text-block message content."""
    out = []
    if isinstance(entry.get("content"), str):
        out.append(entry["content"])
    msg = entry.get("message")
    content = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(content, str):
        out.append(content)
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                out.append(block["text"])
    return out


def live_agents_report(state):
    """`state["liveAgents"]` as the heartbeat's [{type, label}] (no ids: they are
    internal, and the chat resolves a row back to its transcript by type+label)."""
    return [{"type": a["type"], "label": a["label"]}
            for a in (state.get("liveAgents") or {}).values()]


def _entry_blocks(entry, caps):
    """Rich, order-preserving block list for one transcript entry, or None to
    drop it (wrong type / no message dict). Additive companion to _entry_text:
    it PRESERVES the thinking text, tool_use inputs and tool_result outputs that
    _entry_text() flattens away, so the native chat UI can show/hide each
    component by verbosity. `caps` is a {text, input, result} char-limit dict
    (BLOCK_CAPS_LIVE for the ~1s tail, BLOCK_CAPS_FULL for on-demand history); a
    block cut to its cap gets truncated:true. Blocks:
      {t:"text",           text}
      {t:"thinking",       text, truncated?}
      {t:"tool_use",       id, name, input, truncated?}
      {t:"tool_result",    forId, text, isError?, truncated?}
      {t:"compact_summary", text, truncated?}
      {t:"command",        name, args?, truncated?}
      {t:"command_output", text, isError?, truncated?}
      {t:"interrupt",      text}
      {t:"away_summary",   text, truncated?}
      {t:"compact_boundary", trigger?, preTokens?, postTokens?}
      {t:"pr_link",        url, number?, repo?}
    A tool_use block for a known tool also carries its reviewable payload —
    edit/content/plan/desc, see _tool_use_detail — so the chat can show the
    actual change/plan instead of just the salient argument.
    A skill body — a user turn Claude Code wrote as the result of a `Skill` tool
    call (see _entry_tool_source) — becomes that call's {t:"tool_result"} block,
    so the chat folds it into the Skill action card it belongs to instead of
    rendering a SKILL.md-sized operator bubble.
    A `<task-notification>` user turn becomes a single {t:"task_notification",
    summary, status?, result?, truncated?} block (see _parse_task_notification)
    so the web chat renders it as an action card, not raw XML. The slash-command
    bookkeeping turns get the same treatment via _parse_local_command: the
    invocation becomes a `command` block, its stdout/stderr a `command_output`
    block, and the boilerplate caveat is dropped (yielding []).
    An "[Request interrupted by user…]" marker turn (INTERRUPT_RE) becomes an
    `interrupt` block — a statement about the turn, rendered as a status
    marker, not operator prose. An away_summary system entry (the "while you
    were away" recap — see _away_summary_text) becomes an `away_summary` block.
    A compact_boundary system entry — the record that a compaction actually
    RAN, with its trigger and before/after token counts — becomes a
    `compact_boundary` status marker (the TUI shows the compaction; without
    this the chat's context silently resets). All other system entries still
    drop. A `pr-link` entry (Claude Code's own record of a PR it opened)
    becomes a `pr_link` marker so the reader sees where in the conversation
    the PR landed; such entries carry no uuid, so the feeds synthesize an id
    (_entry_id / entryId).
    Returns [] for a user/assistant message with no renderable blocks. Keep this
    mirrored with tunnel-agent.js entryBlocks()."""
    away = _away_summary_text(entry)
    if away is not None:
        clipped, trunc = _clip(away, caps["text"])
        block = {"t": "away_summary", "text": clipped}
        if trunc:
            block["truncated"] = True
        return [block]
    if entry.get("type") == "system" and entry.get("subtype") == "compact_boundary":
        meta = entry.get("compactMetadata") or {}
        block = {"t": "compact_boundary"}
        if isinstance(meta.get("trigger"), str) and meta["trigger"]:
            block["trigger"] = meta["trigger"]
        for key in ("preTokens", "postTokens"):
            if isinstance(meta.get(key), int):
                block[key] = meta[key]
        return [block]
    if entry.get("type") == "pr-link":
        url = entry.get("prUrl")
        if not isinstance(url, str) or not url:
            return None
        block = {"t": "pr_link", "url": url}
        if isinstance(entry.get("prNumber"), int):
            block["number"] = entry["prNumber"]
        if isinstance(entry.get("prRepository"), str) and entry["prRepository"]:
            block["repo"] = entry["prRepository"]
        return [block]
    if entry.get("type") not in ("user", "assistant"):
        return None
    msg = entry.get("message")
    if not isinstance(msg, dict):
        return None
    content = msg.get("content")

    # A skill body is the result of the Skill call that pulled it in: emit it as
    # that call's tool_result and let the chat's existing tool_use/tool_result
    # pairing fold it into the action card. Ahead of the content walk, because
    # the body arrives as an ordinary text block and would otherwise read as
    # operator prose.
    tool_src = _entry_tool_source(entry)
    if tool_src:
        text = ANSI_RE.sub("", _entry_first_text(entry)).strip()
        clipped, trunc = _clip(text, caps["result"])
        block = {"t": "tool_result", "text": clipped, "forId": tool_src}
        if trunc:
            block["truncated"] = True
        return [block]

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

    def add_local_command(lc):
        """The caveat contributes no block (its entry drops out entirely)."""
        if lc["kind"] == "command":
            name, _ = _clip(lc["name"], caps["input"])
            args, atrunc = _clip(lc["args"], caps["input"])
            block = {"t": "command", "name": name}
            if args:
                block["args"] = args
            if atrunc:
                block["truncated"] = True
            blocks.append(block)
        elif lc["kind"] == "output" and lc["text"]:
            text, trunc = _clip(lc["text"], caps["result"])
            block = {"t": "command_output", "text": text}
            if lc["isError"]:
                block["isError"] = True
            if trunc:
                block["truncated"] = True
            blocks.append(block)

    def add_payload(raw):
        """One text payload -> its block(s): a task-notification card, a
        slash-command / `!`-shell chip/output card, an interrupt marker, else
        plain text."""
        tn = _parse_task_notification(raw)
        if tn:
            add_task_notification(tn)
            return
        lc = _parse_local_command(raw)
        if lc:
            add_local_command(lc)
            return
        if INTERRUPT_RE.match(raw):
            blocks.append({"t": "interrupt", "text": ANSI_RE.sub("", raw).strip()})
            return
        # A compact summary is prose the model wrote about the conversation so
        # far, injected as a user turn. It gets its own block so the chat can
        # render it as a collapsed agent-side card rather than a wall of text in
        # a user bubble. _entry_role() puts it on the assistant's side.
        add_text("compact_summary" if entry.get("isCompactSummary") else "text",
                 raw, caps["text"])

    if isinstance(content, str):
        add_payload(content)
    elif isinstance(content, list):
        for raw in content:
            if not isinstance(raw, dict):
                continue
            btype = raw.get("type")
            if btype == "text":
                add_payload(str(raw.get("text") or ""))
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
                if _tool_use_detail(block, str(raw["name"]), raw.get("input"), caps):
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
            "role": _entry_role(entry),
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


def _pinned_transcript_path(workdir, claude_sid):
    """Path of the transcript claude was PINNED to for a session, or None.

    Every launch fixes claude's session id (--session-id on a fresh one, the
    --resume id otherwise), and Claude Code names the transcript after it, so
    the file is <claude_sid>.jsonl under the cwd's project slug. None when the
    session predates the pin (no id) or claude hasn't written its first entry
    yet — see _session_transcript_path for why that is NOT a fallback."""
    if not claude_sid or not VALID_CLAUDE_SID_RE.fullmatch(claude_sid):
        return None
    path = os.path.join(PROJECTS_ROOT, _project_slug(workdir),
                        f"{claude_sid}.jsonl")
    return path if os.path.exists(path) else None


def _session_transcript_path(sess):
    """The transcript THIS session's conversation lives in, or None.

    Resolved from the session's own pinned claude id rather than "whichever
    *.jsonl in the project dir was written most recently". The two rules agree
    for a worktree session — its cwd is unique, so its slug dir holds only its
    own transcripts — and disagree for exactly one thing: the repos-root
    pseudo-repo, where every root session ever run shares REPOS_ROOT as its cwd
    and therefore one slug dir. There, newest-mtime resolved a brand-new root
    session to the PREVIOUS root session's conversation, which is what made a
    fresh root session open onto the last one's whole chat history (XERK-6),
    seed its name off that session's first prompt, and — worst — resume it.

    A pinned session with no transcript on disk yet has not started a
    conversation, and returns None rather than falling back to newest-mtime.
    The fallback IS the bug: in a shared slug dir it silently answers with a
    neighbour's conversation. Sessions launched by an agent predating the pin
    carry no id and keep the newest-mtime rule, which is all they ever had."""
    wt = sess.get("worktreePath") or (REPOS_ROOT if sess.get("root") else None)
    if not wt:
        return None
    if sess.get("claudeSessionId"):
        return _pinned_transcript_path(wt, sess["claudeSessionId"])
    return _newest_transcript_path(wt)


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
                if entry.get("isCompactSummary"):
                    continue  # the model's own summary, injected as a user turn
                if _entry_local_command(entry):
                    continue  # slash-command plumbing, not a real prompt
                text = _entry_text(entry)
                if not text:
                    continue  # tool_result-only turn, or empty after stripping
                return text
    except OSError:
        return None
    return None


def _first_command_name(path, max_lines=50):
    """The first slash-command invocation recorded at the top of a transcript
    ("/model", …), or None. The complement of _first_user_text — which
    deliberately skips command plumbing — for recognizing a transcript that IS
    nothing but a command, like the manager's own models probe."""
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
                lc = _entry_local_command(entry)
                if lc and lc.get("kind") == "command" and lc.get("name"):
                    return lc["name"]
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


# The prompt queue: a message typed mid-turn is enqueued, and Claude Code
# records the queue's life as `queue-operation` transcript entries — enqueue
# carries the text, dequeue pops the OLDEST into a real user turn, remove
# withdraws one by content. The TUI shows the still-queued prompts below the
# input box; the chat view reads them off these entries, folded in file order,
# so a prompt sent mid-turn shows as "queued" instead of vanishing until the
# turn ends (when its dequeue lands, the real user turn takes over — no
# duplicate). A read window that opens mid-sequence can see a dequeue whose
# enqueue was cut off; popping an empty queue is a no-op, which errs toward
# briefly hiding a queued prompt rather than inventing a phantom one.
QUEUED_PROMPTS_MAX = 10
QUEUED_PROMPT_CHARS = 4000


def _fold_queue_op(entry, queue):
    """Fold one queue-operation entry into `queue` (still-queued prompt texts,
    oldest first). Mirror of tunnel-agent.js foldQueueOp."""
    op = entry.get("operation")
    content = entry.get("content")
    if op == "enqueue":
        if isinstance(content, str) and content.strip():
            queue.append(content.strip()[:QUEUED_PROMPT_CHARS])
    elif op == "dequeue":
        if queue:
            queue.pop(0)
    elif op == "remove":
        if isinstance(content, str):
            c = content.strip()[:QUEUED_PROMPT_CHARS]
            if c in queue:
                queue.remove(c)


def _queued_display(queue):
    """The queue entries worth SHOWING as queued prompts: capped, and minus the
    tooling's own payloads. A background task finishing mid-turn rides the same
    queue as a `<task-notification>` XML wall — rendering that as a queued
    operator bubble is the exact misclassification the block parsers exist to
    fix. It must still occupy its FIFO slot in `queue` (dequeues are
    positional), so it is filtered here at report time, never at fold time.
    Prefix-matched (not parsed): the enqueue copy is clipped to
    QUEUED_PROMPT_CHARS, which can cut the closing tag a full parse needs.
    Mirror of tunnel-agent.js queuedDisplay."""
    return [q for q in queue
            if not q.startswith("<task-notification>")][-QUEUED_PROMPTS_MAX:]


# A conversation that auto-compacts (context near-full, ~95%) rewrites its own
# history, and a message the operator sent that was still QUEUED — or was typed
# straight into the pane as compaction began — can be dropped by it instead of
# consumed: it never becomes a real user turn and never reaches the model, so
# the operator's message silently vanishes (XERK-47). send_input records every
# sent message on the session record and _poll_pending_inputs gives it an
# at-least-once guarantee across a compaction: it reaps the record on delivery,
# and on a FRESH compaction that ate the message re-types it once the pane has
# settled. A compaction is detected authoritatively from the transcript's own
# `compact_boundary` system entry (written when a compaction completes), not by
# scraping the pane for an undocumented "Compacting…" string.
PENDING_INPUT_MAX = 20                # cap the per-session outbox
PENDING_INPUT_MAX_ATTEMPTS = int(os.environ.get("SESSION_INPUT_RESEND_MAX", "3"))
# Drop an outbox entry that never lands and never sees a compaction (some
# non-compaction loss, e.g. a tmux hiccup) so the record can't leak forever.
PENDING_INPUT_TTL_SEC = float(os.environ.get("SESSION_INPUT_PENDING_TTL_SEC", "900"))


def _pending_scan(path):
    """Read a session's transcript tail for the three facts the resend-across-
    compaction guarantee needs (XERK-47), in one pass:

      - delivered:  stripped texts of genuine user turns (a queued message the
                    model consumed becomes one) — a sent message present here has
                    LANDED and its outbox record is reaped;
      - queued:     the still-queued prompt texts (folded, see _fold_queue_op) —
                    IN-FLIGHT, neither delivered nor lost, so it is left to land;
      - compactions: how many `compact_boundary` system entries the transcript
                    holds — a rise since a message was sent means a compaction
                    happened that could have dropped it.

    Same 4 MiB tail window _history_entries reads. Delivered is matched by text
    with no timestamp/offset filter, which is deliberately biased AGAINST a
    resend: the only cost is that a message re-sending the EXACT text of an older
    turn is treated as already delivered and not resent (a missed resend, never a
    duplicate) — and a duplicate is the worse failure to show the operator."""
    delivered, queued, compactions = [], [], 0
    for raw in _read_tail_lines(path, 1 << 22):
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        etype = entry.get("type")
        if etype == "queue-operation":
            _fold_queue_op(entry, queued)
        elif etype == "system" and entry.get("subtype") == "compact_boundary":
            compactions += 1
        elif (etype == "user" and not entry.get("isMeta")
              and not entry.get("isCompactSummary")
              and entry.get("promptSource") != "system"):
            text = _entry_text(entry)
            if text:
                delivered.append(text.strip())
    return delivered, _queued_display(queued), compactions


def _history_row(entry):
    """One parsed transcript entry -> the history feed's row shape, or None to
    drop it. Rich path: widens inclusion beyond _entry_text — a turn that
    carries only tool_result blocks (text is None) still has renderable blocks
    and is kept, so the chat UI can show tool output. transcript_tail keeps the
    old drop-when-None rule (heartbeat/archive stay lean)."""
    text = _entry_text(entry)
    blocks = _entry_blocks(entry, BLOCK_CAPS_FULL)
    if text is None and not blocks:
        return None
    return {
        "id": _entry_id(entry),
        "role": _entry_role(entry),
        "text": (text or "")[:TAIL_MSG_CHARS_FULL],
        "blocks": blocks or [],
    }


def _is_operator_row(row):
    """True when a history row renders as an operator (blue) bubble in the
    chat: user role with at least one text block. This is the same test the
    web/android/glasses builders apply (a text block on a user entry becomes a
    user message bubble), so what this keeps is exactly what the operator sees
    as "a message I sent"."""
    if row.get("role") != "user":
        return False
    return any(b.get("t") == "text" for b in row.get("blocks") or [])


# Cheap byte prefilter for the operator-message scan: only `user` entries can
# be operator messages, and Claude Code writes compact JSON — but test fixtures
# and any re-serialized transcript may carry a space, so match both spellings.
# False positives just cost one json.loads; false negatives would hide a
# message, so the marker must stay a superset of real user lines.
_USER_LINE_MARKERS = (b'"type":"user"', b'"type": "user"')


def _operator_entries(path):
    """Every operator-authored text message in the WHOLE transcript, oldest
    first, as _history_row rows (XERK-186).

    The windowed history read below cuts old entries wholesale, and in a
    tool-heavy session the few messages the operator typed are exactly what a
    byte/entry window evicts first — the transcript is dominated by
    tool_use/tool_result traffic. Operator prose is rare (~1% of entries over
    this host's corpus) and small, so re-reading the whole file for it is
    affordable for an on-demand call: the byte prefilter skips every
    non-user line without parsing it (~17ms for an 8 MB transcript)."""
    rows = []
    try:
        with open(path, "rb") as f:
            for raw in f:
                if not any(m in raw for m in _USER_LINE_MARKERS):
                    continue
                try:
                    entry = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(entry, dict) or entry.get("type") != "user":
                    continue
                row = _history_row(entry)
                if row is not None and _is_operator_row(row):
                    rows.append(row)
    except OSError:
        return []
    return rows


def _history_entries(path):
    """On-demand `history` read of a transcript: bounded to the last 4 MiB
    (1 << 22, same cap the PR-URL scan uses) rather than transcript_tail's
    ~128 KB, tolerant JSONL parse, entries mapped through _history_row (no
    duplicated entry->text logic). Returns (entries, truncated, queued) —
    entries oldest first, already capped to the last HISTORY_MAX_MSGS;
    truncated is True when older content was cut (the file outgrew the byte
    window, or the entry cap dropped entries); queued is the still-queued
    prompt texts (see _fold_queue_op).

    One exemption from the window (XERK-186): OPERATOR MESSAGES. Whenever the
    window cut anything, every operator text turn older than the window is
    folded back in ahead of it (deduped by id, newest HISTORY_USER_MSGS kept),
    so however much tool traffic a session generates, the chat can always show
    every message the operator sent. File order is preserved: any operator row
    not in the window precedes it in the file, and the scan reads oldest
    first."""
    read_cap = 1 << 22
    try:
        byte_capped = os.path.getsize(path) > read_cap
    except OSError:
        byte_capped = False
    entries = []
    queued = []
    for raw in _read_tail_lines(path, read_cap):
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        if entry.get("type") == "queue-operation":
            _fold_queue_op(entry, queued)
            continue
        row = _history_row(entry)
        if row is not None:
            entries.append(row)
    truncated = byte_capped or len(entries) > HISTORY_MAX_MSGS
    window = entries[-HISTORY_MAX_MSGS:]
    if truncated:
        shown = {row["id"] for row in window if row.get("id")}
        older = [row for row in _operator_entries(path)
                 if row.get("id") and row["id"] not in shown]
        window = older[-HISTORY_USER_MSGS:] + window
    return window, truncated, _queued_display(queued)


# The Task tool's result text carries the spawned agent's id ("agentId: <id>"),
# which is also its subagent-transcript filename (subagents/agent-<id>.jsonl).
_AGENT_ID_RE = re.compile(r"agentId:\s*([A-Za-z0-9_-]+)")


def _subagents_dir(main_path):
    """The subagents/ dir Claude Code writes background-agent transcripts into,
    a sibling of the main transcript keyed on its id:
    <PROJECTS_ROOT>/<slug>/<id>.jsonl -> <PROJECTS_ROOT>/<slug>/<id>/subagents/."""
    stem = main_path[:-len(".jsonl")] if main_path.endswith(".jsonl") else main_path
    return os.path.join(stem, "subagents")


def _strip_pane_ellipsis(cell):
    """(text, truncated) for a cell scraped off a pane row: the TUI ellipsizes
    a long cell with its own "…" on a narrow window, and that ellipsis is not
    part of the real value — a prefix match against it can never succeed
    (XERK-130). "..." is accepted alongside for safety."""
    if cell.endswith("…"):
        return cell[:-1].rstrip(), True
    if cell.endswith("..."):
        return cell[:-3].rstrip(), True
    return cell, False


def _resolve_subagent(main_path, agent_type, label):
    """Map a pane agent-list row (its `type` + short `label`/description) to the
    background agent's transcript file, via the main transcript's Task calls.

    A Task tool_use carries {subagent_type, description}; its paired tool_result
    text carries "agentId: <id>", and that id names the subagent transcript
    (subagents/agent-<id>.jsonl). We read the main transcript, index Task calls
    by tool_use id, resolve each id's agentId from its result, then pick the
    NEWEST call whose type+description match the clicked row (exact, else a
    prefix match so a pane-truncated label still resolves — the TUI ellipsizes
    a long cell with "…" on a narrow window, so a trailing ellipsis is stripped
    first and marks the cell as a prefix, XERK-130). Returns the subagent
    transcript path, or None when nothing matches / the file is absent — a miss
    must not raise (the caller stages an empty result)."""
    want_type, type_trunc = _strip_pane_ellipsis((agent_type or "").strip())
    want_label, _ = _strip_pane_ellipsis((label or "").strip())
    if not want_type:
        return None
    tasks = []          # [(tool_use_id, description)] for the wanted type, in order
    agent_ids = {}      # tool_use_id -> agentId (from the paired result)
    for raw in _read_tail_lines(main_path, 1 << 23):  # last 8 MiB
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        msg = entry.get("message") if isinstance(entry, dict) else None
        content = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            # `Agent` is the tool's current name and `Task` the older one; only
            # `Task` was matched here, so on today's transcripts NO clicked row
            # resolved and every subagent view opened empty.
            if block.get("type") == "tool_use" and block.get("name") in ("Agent", "Task"):
                inp = block.get("input") or {}
                have_type = str(inp.get("subagent_type") or "").strip()
                # A background launch carries NO subagent_type, so its row's type
                # is the generic "agent" the scan falls back to. Matching that
                # against the call's (absent) type resolves nothing, so treat it
                # as a wildcard and let the description alone decide.
                if (want_type == "agent" or have_type == want_type
                        or (type_trunc and have_type.startswith(want_type))):
                    tasks.append((block.get("id"),
                                  str(inp.get("description") or "").strip()))
            elif block.get("type") == "tool_result":
                m = _AGENT_ID_RE.search(_tool_result_text(block.get("content")))
                if m and block.get("tool_use_id"):
                    agent_ids[block["tool_use_id"]] = m.group(1)

    def _matches(desc):
        if not want_label or desc == want_label:
            return True
        return desc.startswith(want_label) or want_label.startswith(desc)

    for tool_id, desc in reversed(tasks):  # newest matching call wins
        if not _matches(desc):
            continue
        aid = agent_ids.get(tool_id)
        if not aid:
            continue
        path = os.path.join(_subagents_dir(main_path), f"agent-{aid}.jsonl")
        if os.path.isfile(path):
            return path
    return None


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
    bridge for `session_id`, as a rich dict or None. The bridge blocks the tool
    call while this request file exists, so its presence is an exact "a question
    is waiting right now" signal — no pane scraping, no transcript timing.

    The dict carries everything the native chat needs to render the picker the
    TUI shows: ``question`` text, backward-compat ``labels`` (option labels
    only), the richer ``options`` (``[{label, description?, preview?}]``), the
    question ``header`` chip, its ``index``/``total`` position in a multi-question
    call, and whether it's ``multi``-select. None when no question is pending.

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
        return None
    path = os.path.join(QUESTIONS_DIR, f"{session_id}.req.json")
    ans_path = os.path.join(QUESTIONS_DIR, f"{session_id}.ans.json")
    try:
        mtime = os.stat(path).st_mtime
    except OSError:
        return None
    # Orphaned by a dead bridge (too old to still be blocking) — drop and tidy.
    if time.time() - mtime > QUESTION_STALE_AFTER_SEC:
        for p in (path, ans_path):
            try:
                os.remove(p)
            except OSError:
                pass
        return None
    # Answer already delivered — the bridge is consuming it, not still asking.
    if os.path.exists(ans_path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            req = json.load(f)
    except (FileNotFoundError, ValueError, OSError):
        return None
    if not isinstance(req, dict):
        return None
    question = str(req.get("question") or "")[:300] or None
    if not question:
        return None
    return {
        "question": question,
        "labels": _question_labels(req.get("options")),
        "options": _question_options(req.get("options")),
        "header": _question_header(req.get("header")),
        "index": req.get("index") if isinstance(req.get("index"), int) else 0,
        "total": req.get("total") if isinstance(req.get("total"), int) else 1,
        "multi": req.get("multiSelect") is True,
    }


# Per-option caps for the heartbeat. Previews (rendered mockups/code) are the
# heaviest field, so they're capped hardest here — the on-demand history read
# isn't a factor since a pending question rides the live heartbeat, not history.
_Q_LABEL_MAX = 80
_Q_DESC_MAX = 400
_Q_PREVIEW_MAX = 1200
_Q_OPTS_MAX = 4


def _question_labels(opts):
    """Backward-compat: the option *labels* only, for older clients (glasses,
    android) that render a flat pick list."""
    if not isinstance(opts, list):
        return []
    return [
        opt["label"][:_Q_LABEL_MAX] for opt in opts[:_Q_OPTS_MAX]
        if isinstance(opt, dict) and isinstance(opt.get("label"), str)
    ]


def _question_options(opts):
    """Rich options — ``[{label, description?, preview?}]`` — for the native chat
    to render option cards with the description and preview the TUI shows."""
    out = []
    if not isinstance(opts, list):
        return out
    for opt in opts[:_Q_OPTS_MAX]:
        if not (isinstance(opt, dict) and isinstance(opt.get("label"), str)):
            continue
        item = {"label": opt["label"][:_Q_LABEL_MAX]}
        desc = opt.get("description")
        if isinstance(desc, str) and desc:
            item["description"] = desc[:_Q_DESC_MAX]
        preview = opt.get("preview")
        if isinstance(preview, str) and preview:
            item["preview"] = preview[:_Q_PREVIEW_MAX]
        out.append(item)
    return out


def _question_header(header):
    """The question's short header chip (e.g. "Semantics"), or None."""
    if isinstance(header, str) and header.strip():
        return header[:24]
    return None


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

# The hint alone is not enough on a NARROW pane (XERK-130). tmux sizes the
# window to its smallest-ever attached client, so a session once viewed from a
# phone renders ~54 columns wide — and at that width the TUI ellipsizes the
# footer's ") · esc to interrupt" suffix to ") · esc to inte…", which the plain
# substring match reads as idle. Every working session on a narrowed pane
# reported idle for its whole turn, which is the "active sessions are marked
# idle" defect. Two extra shapes, each verified against live panes, recover it:
#
# - PANE_BUSY_TRUNC_RE — the mode footer line with any width-truncation of the
#   hint: a line carrying the mode marker's ⏸/⏵ glyph whose LAST "·"-separated
#   segment is a PREFIX of "esc to interrupt" (character class, so every cut
#   point matches) ending in the TUI's own "…" ellipsis. Anchored on the glyph
#   rather than fixed wording because the middle segments vary — "(shift+tab
#   to cycle)" comes and goes, a "· PR #98" chip can sit between the mode and
#   the hint — while the hint is always the segment being cut. The idle
#   footer's "· ← for agents" suffix cannot match (it never starts with "e").
#   This is the ONLY visible signal while text streams on a narrow pane (no
#   spinner line is painted then) and while the operator has scrolled the
#   conversation up (the spinner is off-screen).
#
# - PANE_SPINNER_RE — the column-0 working spinner line itself, e.g.
#   "✢ Determining… (12m 19s · ↓ 44.2k tokens)" or "· Perusing… (54m 38s ·
#   still thinking)": a single spinner glyph (glyph-agnostic — the frames vary
#   by version — but never the assistant-turn "●" bullet or the "❯" prompt),
#   one capitalized gerund, then the TUI's ellipsis and "(" detail. The
#   ellipsis is load-bearing: the completed-turn line left on an IDLE pane
#   ("✻ Brewed for 9s") has none, and prose can't sit at column 0 (assistant
#   text is bulleted then indented).
#
# Both fail toward idle (today's behaviour) if the TUI wording shifts, and both
# are disabled with the markers (empty TURMA_PANE_BUSY_MARKERS = feature off).
PANE_BUSY_TRUNC_RE = re.compile(
    r"[⏸⏵][^\n]*·\s*e[sc to interup]*…\s*$",
    re.IGNORECASE | re.MULTILINE)
PANE_SPINNER_RE = re.compile(
    r"^[^\sA-Za-z0-9●❯]\s+[A-Z][a-z]+(?:…|\.\.\.)(?:\s*\(|\s*$)")


def _pane_busy(tmux_name):
    """Whether the session's live TUI shows the model actively working.

    True  = the interrupt hint is on screen (generating or running a tool),
    False = it isn't (turn finished, awaiting input),
    None  = unknown — no tmux_name, markers disabled, or the pane couldn't be
            captured (e.g. the tmux session is gone). Callers fall back to the
            transcript-mtime heuristic on None, so an old/crashed pane degrades
            gracefully rather than reporting a wrong state."""
    if not tmux_name:
        return None
    return _busy_from_capture(_capture_pane(tmux_name))


def _busy_from_capture(cap):
    """The paneBusy read off an already-taken capture (None-capture = unknown).

    Busy is any of: a configured marker ("esc to interrupt" on a pane wide
    enough to show it whole), the width-truncated remnant of that hint on the
    mode footer line, or the column-0 working-spinner line — see the regexes'
    comment for why all three are needed (XERK-130)."""
    if cap is None or not PANE_BUSY_MARKERS:
        return None
    low = cap.lower()
    if any(m in low for m in PANE_BUSY_MARKERS):
        return True
    if PANE_BUSY_TRUNC_RE.search(cap):
        return True
    return any(PANE_SPINNER_RE.match(line) for line in cap.splitlines())


# A single capture can read "idle" while the model is really still working:
# Claude Code's TUI repaints its spinner (and the "esc to interrupt" hint that
# rides it) several times a second by CLEARING the status line and rewriting it,
# so a capture that lands in that sub-frame gap sees no marker even though the
# turn hasn't ended. It's a momentary artifact — but paneBusy is sampled only
# once per heartbeat (TURMA_INTERVAL, 20s by default), so a single missed frame
# shows the session "idle" for a whole interval on EVERY status surface (the
# fleet dots, the session cards, the glasses glyph, the Android list — all key
# off this one field) AND fires a bogus "finished its turn" notification on the
# hub's working->idle edge. That interval-long flip off and back is the "flaky
# status icons" this guards against.
#
# The asymmetry is the whole idea: a redraw gap can fake IDLE while working, but
# nothing fakes BUSY while idle (once a turn ends the marker is gone from the
# grid for good). So a busy read is trusted instantly — status must light up
# promptly — while an idle read is distrusted only on the busy->idle EDGE, where
# we re-capture once after a short delay and believe idle only if it HOLDS. A
# genuinely finished turn confirms in a frame; a redraw gap doesn't. A steady
# idle session needs no confirmation and pays nothing.
#
# 0 disables (report the raw single read). The delay must clear one repaint
# cycle — a couple hundred ms — without meaningfully taxing the beat, and it is
# spent only on the transition, not every idle beat.
PANE_IDLE_CONFIRM_SEC = float(os.environ.get("TURMA_PANE_IDLE_CONFIRM_SEC", "0.2"))


def _stable_pane_busy(tmux_name, state):
    """paneBusy with the busy->idle flicker suppressed, using per-session `state`
    (persisted across beats) to remember the last stable reading. See
    PANE_IDLE_CONFIRM_SEC for the mechanism and why it's asymmetric.

    None (unknown — no pane, capture failed) is passed straight through and
    leaves the remembered state untouched, so the transcript-mtime fallback still
    decides and a transient capture failure can't be mistaken for "went idle"."""
    raw = _pane_busy(tmux_name)
    if raw is None:
        return None
    if raw:
        state["paneBusyStable"] = True
        return True
    # raw is False. Only distrust it on the busy->idle edge.
    if state.get("paneBusyStable") and PANE_IDLE_CONFIRM_SEC > 0:
        time.sleep(PANE_IDLE_CONFIRM_SEC)
        if _pane_busy(tmux_name):  # the marker was one frame away -> still working
            state["paneBusyStable"] = True
            return True
    state["paneBusyStable"] = False
    return False

# The TUI names the ACTIVE permission mode on its footer at all times — even
# mid-generation — as "⏸ manual mode on" / "⏵⏵ accept edits on" / "⏸ plan mode
# on" / "⏵⏵ auto mode on" / "⏵⏵ bypass permissions on". Anchored on the leading
# glyph so conversation text that merely SAYS "plan mode on" can't read as the
# marker. This read is what makes set_mode a closed loop (press, read, repeat)
# instead of a press-count computed against a guessed cycle: the real cycle is
# account- AND model-dependent (auto joins it when the account enables it —
# observed even on a bypass-launched session, where perm_cycle_for guesses it
# absent — and drops out for models that can't do auto), so any precomputed
# count lands on the wrong mode somewhere.
PANE_MODE_RE = re.compile(
    r"[⏸⏵]+\s+(bypass permissions|accept edits|plan mode|auto mode|manual mode) on")
_PANE_MODE_NAMES = {
    "bypass permissions": "bypassPermissions",
    "accept edits": "acceptEdits",
    "plan mode": "plan",
    "auto mode": "auto",
    "manual mode": "default",
}


def parse_pane_mode(cap):
    """The permission mode the session's TUI is REALLY in, read off the footer
    marker, or None when no marker is visible (pane gone, or a TUI wording this
    parser predates). Scanned bottom-up: the footer owns the last lines, so a
    marker quoted higher up in the conversation can't shadow the live one."""
    if not cap:
        return None
    for line in reversed(cap.splitlines()):
        m = PANE_MODE_RE.search(line)
        if m:
            return _PANE_MODE_NAMES[m.group(1)]
    return None


# Claude Code blocks a turn on a CHOICE DIALOG the transcript never records: a
# tool-permission request ("Bash command … Do you want to proceed?") or a plan
# approval ("Claude has written up a plan … Would you like to proceed?"). It is
# a TUI affordance, like the AskUserQuestion picker the ask.py bridge
# intercepts — but this one has no hook to intercept it, so nothing about it
# reaches the transcript, the tail, or the chat.
#
# Worse, while a dialog is up the pane shows NEITHER the "esc to interrupt"
# hint NOR the mode footer (the composer is replaced by the dialog), so
# `paneBusy` reads False and every status surface calls the session IDLE. It is
# in fact blocked on a human, and the only way to see that — or to answer — was
# to open the raw terminal. So we read the dialog off the pane, the same way
# `parse_pane_mode` reads the mode marker.
#
# Shapes verified against live panes (Claude Code 2.1.220), a permission
# dialog and a plan approval:
#
#     Bash command                    │   Claude has written up a plan and is
#                                     │   ready to execute. Would you like to
#       touch /tmp/marker             │   proceed?
#       Create marker file in /tmp    │
#                                     │   ❯ 1. Yes, and use auto mode
#     Do you want to proceed?         │     2. Yes, manually approve edits
#     ❯ 1. Yes                        │     3. No, refine with Ultraplan …
#       2. Yes, and always allow …    │     4. Tell Claude what to change
#       3. No                         │
#
# The wordings differ, so nothing keys on them. What both share, and what an
# ordinary numbered list in conversation text does not, is all four of:
#   1. a contiguous run of >= 2 options numbered 1..N in order;
#   2. exactly one carrying the TUI's "❯" selection cursor;
#   3. a question line (ends in "?") directly above the run;
#   4. NO mode footer below it — the footer marker rides the composer, which a
#      dialog replaces, so its absence is what says "this is a live dialog"
#      rather than transcript text that happens to look like one.
PANE_PROMPT_OPTION_RE = re.compile(r"^\s*(❯\s+)?(\d+)\.\s+(\S.*?)\s*$")
# A box/rule line the TUI draws between sections. The dialog's context is the
# nearest block ABOVE the question fenced by these, which is why they are
# skipped before the block and end it after: a permission dialog's block sits
# directly above the question ("Bash command" + the command + its description),
# while a plan's body sits one rule further up (the approval sentence has its
# own rule under it), and one walk has to find both.
PANE_PROMPT_RULE_RE = re.compile(r"^[\s─╌━▔▁═_│╭╮╰╯┌┐└┘├┤┬┴┼-]+$")
# How much context above the question to carry (the tool's command + its
# description, or the plan's body): enough to decide on, bounded for the beat.
PANE_PROMPT_DETAIL_LINES = 14
PANE_PROMPT_DETAIL_CHARS = 800
PANE_PROMPT_MAX_OPTIONS = 9   # answered by typing the digit; 10+ isn't one key


def parse_pane_prompt(cap):
    """The blocking choice dialog the session's TUI is showing, or None.

    Returns {prompt, options: [{number, label, selected}], detail} — `detail`
    being the context lines above the question (the command being asked about,
    or the plan). See the comment above for the four conditions a run of lines
    must meet, and why an idle/working pane can't produce a false positive.

    Scanned bottom-up: the dialog owns the bottom of the pane, so an earlier
    dialog still scrolled on screen can't shadow the live one."""
    if not cap:
        return None
    lines = cap.splitlines()
    # A mode footer anywhere below means the composer is live -> no dialog.
    for i in range(len(lines) - 1, -1, -1):
        line = lines[i]
        m = PANE_PROMPT_OPTION_RE.match(line)
        if not m or m.group(2) == "0":
            if PANE_MODE_RE.search(line):
                return None          # composer footer: nothing is blocking
            continue
        # Walk up while the numbers keep descending to 1.
        end = i
        start = i
        want = int(m.group(2))
        while start >= 0:
            om = PANE_PROMPT_OPTION_RE.match(lines[start])
            if not om or int(om.group(2)) != want:
                break
            start -= 1
            want -= 1
        if want != 0 or end - start < 2:
            continue                 # not 1..N, or fewer than two options
        start += 1
        opts = []
        for line_no in range(start, end + 1):
            om = PANE_PROMPT_OPTION_RE.match(lines[line_no])
            opts.append({"number": int(om.group(2)),
                         "label": om.group(3)[:200],
                         "selected": bool(om.group(1))})
        if sum(1 for o in opts if o["selected"]) != 1:
            continue                 # no cursor (or several): not a live picker
        if len(opts) > PANE_PROMPT_MAX_OPTIONS:
            continue
        # The question sits directly above, skipping blanks.
        q = start - 1
        while q >= 0 and not lines[q].strip():
            q -= 1
        if q < 0 or not lines[q].strip().endswith("?"):
            continue
        prompt = lines[q].strip()
        # Walk up for the fenced block above the question: skip blanks and rules
        # until real text starts, then stop at the rule that closes it.
        detail = []
        for line in reversed(lines[:q]):
            text = line.strip()
            if not text:
                continue         # a blank never closes the block (the TUI puts
                                 # one between a dialog's title and its body)
            if PANE_PROMPT_RULE_RE.match(line):
                if detail:
                    break        # the rule fencing the block we just collected
                continue         # still above/between rules — keep looking
            detail.append(text)
            if len(detail) >= PANE_PROMPT_DETAIL_LINES:
                break
        detail.reverse()
        out = {"prompt": prompt[:300], "options": opts}
        if detail:
            out["detail"] = "\n".join(detail)[:PANE_PROMPT_DETAIL_CHARS]
        return out
    return None


def _pane_status(tmux_name, state):
    """(paneBusy, modeActual, panePrompt) for one beat: the busy half goes
    through _stable_pane_busy's busy->idle flicker suppression (hence `state`),
    the mode and blocking-dialog halves read one shared capture.

    Live background agents are deliberately NOT read here — see
    _scan_agent_entry for why the pane cannot answer that question."""
    if not tmux_name:
        return None, None, None
    busy = _stable_pane_busy(tmux_name, state)
    cap = _capture_pane(tmux_name)
    return busy, parse_pane_mode(cap), parse_pane_prompt(cap)


def _capture_pane(tmux_name):
    """The session pane's current text, or None when it can't be captured
    (tmux gone, timeout)."""
    if not tmux_name:
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
    return out.stdout


# Control bytes that must never reach a pane. The text is delivered as a
# bracketed paste, so an ESC — or a literal end-of-paste marker — inside it
# would close the paste early and have everything after it read as KEYSTROKES;
# and the text is not always the operator's own (a PR review comment is typed
# into the session by _poll_pr_comments). Tab and newline are real content and
# survive; \r is normalized to \n first.
INPUT_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
# The fallback keystroke send carries the text as a tmux COMMAND argument, which
# tmux refuses past ~16 KiB ("command too long"), so a long message goes in
# CHUNKS of this size rather than being clipped to it: a message the operator
# believes they sent whole must never arrive with its end missing (XERK-227).
SENDKEYS_MAX_CHARS = 4000


def _clean_input_text(text):
    """Normalize free text on its way into a pane: CRLF/CR to LF, control bytes
    (bar tab and newline) dropped. Newlines SURVIVE — see _type_into_pane."""
    text = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    return INPUT_CTRL_RE.sub("", text)


# ---- file attachments (XERK-234) --------------------------------------------

def safe_upload_name(name):
    """A filename that can only ever land INSIDE the uploads directory.

    Mirrors the hub's safeUploadName. The hub sanitizes first (so the chip the
    operator sees names the file that lands), but this is not a formality: the
    name arrives over the wire, and a `../` or an absolute path reaching
    os.path.join would write anywhere the agent can. Everything outside a
    conservative ASCII set becomes `_`; the extension survives a length cut,
    because it is what tells Claude Code's Read what kind of file this is."""
    s = str(name or "")
    s = re.split(r"[\\/]", s)[-1]           # basename, both separators
    s = UPLOAD_NAME_BAD_RE.sub("_", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = s.lstrip(".")                        # never a dotfile — a hidden upload
    s = s.strip()
    if len(s) > UPLOAD_NAME_MAX:
        stem, dot, ext = s.rpartition(".")
        ext = f".{ext}" if dot and stem and len(ext) <= 11 else ""
        s = s[:UPLOAD_NAME_MAX - len(ext)] + ext
    return s or "upload"


def upload_dir_for(session_id):
    """Where one session's attachments live: ~/.turma/uploads/<sessionId>. The
    id is app-minted (uuid4/registry key), but it is joined onto a path, so it
    gets the same treatment as the filename."""
    return os.path.join(UPLOADS_DIR, safe_upload_name(session_id))


def _write_new_file(path, blob):
    """Write `blob` to a file this call CREATES, 0600, or raise.

    O_EXCL|O_NOFOLLOW rather than open(path, "wb"): `_unique_upload_path` asks
    os.path.exists(), which FOLLOWS a symlink, so a dangling one in the uploads
    tree reads as a free name and a plain write would create its target instead.
    Creating the file outright is also what makes the mode 0600 from the start
    rather than for the moment after the bytes land."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(blob)
    except Exception:
        # Don't leave a half-written file behind under a name the prompt names.
        try:
            os.unlink(path)
        except Exception:
            pass
        raise


def _unique_upload_path(dirpath, name):
    """`dirpath/name`, suffixed `-2`, `-3`, … if that name is already taken.
    Attaching screenshot.png twice must not have the second silently replace the
    first — an earlier message's path still points at it."""
    path = os.path.join(dirpath, name)
    if not os.path.exists(path):
        return path
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    else:
        ext = f".{ext}"
    for n in range(2, 1000):
        cand = os.path.join(dirpath, f"{stem}-{n}{ext}")
        if not os.path.exists(cand):
            return cand
    return os.path.join(dirpath, f"{stem}-{uuid.uuid4().hex[:8]}{ext}")


def attachment_message(paths, failed, text):
    """The message actually typed into the pane for a message with attachments.

    The files are already on disk by the time this runs, so the session is told
    where they are and left to read them with its ordinary tools — nothing is
    inlined into the prompt. The operator's own text follows, so a message that
    had one reads normally underneath the header.

    A file that failed to transfer is NAMED rather than dropped: the operator
    saw it attached, and a session that quietly never received it would be asked
    about a file it has no way to know existed."""
    lines = []
    if paths:
        lines.append("[The operator attached %s to this message. Read %s from disk:]"
                     % ("a file" if len(paths) == 1 else f"{len(paths)} files",
                        "it" if len(paths) == 1 else "them"))
        lines.extend(paths)
    for name in failed or []:
        lines.append(f"[The operator attached {name}, but it failed to transfer "
                     f"— ask them to send it again.]")
    body = str(text or "").strip()
    if body:
        lines.append("")
        lines.append(body)
    return "\n".join(lines)


def _type_into_pane(tmux_name, text):
    """Put `text` into a session pane's input line and submit it with Enter.

    The text is delivered as a tmux PASTE — `load-buffer` it into a per-session
    buffer over STDIN, then `paste-buffer -d -p` into the pane — rather than as
    a `send-keys -l` keystroke send (XERK-227). send-keys carries the text as a
    tmux command argument, which tmux refuses past ~16 KiB, so a pasted log or
    spec could never reach the session through the chat composer even though the
    raw terminal has always accepted one. A paste has no such limit and costs
    the same few milliseconds at 100 KiB as at 100 bytes.

    The paste is also what keeps NEWLINES: `-p` wraps the text in bracketed-paste
    markers when the pane's application asked for them (Claude Code does), so a
    multi-line message lands as ONE message instead of submitting a turn per
    line. `-p` is conditional, so an application that never requested bracketed
    paste is sent the bare text and is never shown a stray escape sequence.

    Falls back to a keystroke send when the paste can't be made — a tmux too old
    for either subcommand must still deliver the message. That path types the
    text in SENDKEYS_MAX_CHARS **chunks** (newlines flattened, since nothing
    brackets them there) rather than clipping it: a message the operator believes
    they sent whole must never arrive with its end quietly missing. Returns True
    when the text was pasted."""
    if not tmux_name:
        return False
    buf = f"turma-input-{tmux_name}"      # per-pane, so two sessions can't race
    pasted = run_stdin(["tmux", "load-buffer", "-b", buf, "-"], text)
    if pasted:
        # -d drops the buffer once it has been pasted, so a message never sits
        # in tmux's paste history waiting to be re-pasted by hand.
        rc, _err = run_ok(["tmux", "paste-buffer", "-d", "-p", "-b", buf,
                           "-t", tmux_name], timeout=15)
        pasted = rc == 0
        if not pasted:
            run(["tmux", "delete-buffer", "-b", buf])
    if not pasted:
        flat = text.replace("\n", " ")
        chunks = [flat[i:i + SENDKEYS_MAX_CHARS]
                  for i in range(0, len(flat), SENDKEYS_MAX_CHARS)] or [""]
        log(f"paste into {tmux_name} failed; falling back to send-keys "
            f"({len(flat)} chars in {len(chunks)} chunk(s))")
        for chunk in chunks:
            # `--` ends tmux's own option parsing before the literal text, so a
            # message starting with '-' isn't misread as more send-keys flags.
            # Each chunk appends to the input line; only the Enter below submits.
            run(["tmux", "send-keys", "-t", tmux_name, "-l", "--", chunk])
    run(["tmux", "send-keys", "-t", tmux_name, "Enter"])
    return pasted


def session_report(workdir, state, tmux_name=None, session_id=None,
                   claude_sid=None):
    """Cheap per-heartbeat session signals (stat + tail reads, no full parse).

    state carries per-file byte offsets between beats so the PR-URL scan only
    reads what was appended since the last beat (plus the scan's own carry-over
    — see _scan_pr_line). The first call primes the offsets to EOF for every
    existing transcript, so a restarted agent never replays PR links from old
    sessions.

    claude_sid pins WHICH transcript in the project dir is this session's (see
    _session_transcript_path); without one — a session from an agent predating
    the pin — the newest by mtime is the best guess available.
    """
    slug = _project_slug(workdir)
    proj = os.path.join(PROJECTS_ROOT, slug)
    primed = state.get("primed", False)
    offsets = state.setdefault("offsets", {})
    pane_busy, mode_actual, pane_prompt = _pane_status(tmux_name, state)
    report = {
        "bridgeAttached": os.path.exists(os.path.join(proj, "bridge-pointer.json")),
        # Live "is it working right now" read straight off the session's TUI —
        # the primary working/idle signal; transcriptAgeSec is the fallback.
        # Flicker-suppressed via `state` (see _stable_pane_busy) so a single
        # capture landing in a spinner-repaint gap can't flip every status icon
        # to idle for a whole interval.
        "paneBusy": pane_busy,
        # The permission mode the TUI is REALLY in (footer marker), or None.
        # The record reconciles to it each beat (_session_payload), so a mode
        # the operator cycled by hand in the terminal doesn't leave the stored
        # mode — and every switch computed from it — wrong forever.
        "modeActual": mode_actual,
        # The blocking choice dialog the TUI is showing (tool permission / plan
        # approval), or None. Nothing about it reaches the transcript, and it
        # suppresses the busy hint — so without this read the session looks idle
        # while it waits on a human. See parse_pane_prompt.
        "panePrompt": pane_prompt,
        # The background agents this session has in flight, [{type, label}]
        # (empty when none), derived from the transcript's own launch/stop edges
        # — see _scan_agent_entry. The OTHER thing paneBusy cannot see: a session
        # that delegated work and ended its own turn keeps no interrupt hint, so
        # it read idle on every surface while an agent was still working. Every
        # working/idle mirror ORs this with paneBusy; an agent predating the
        # field sends none, which reads as "can't tell", i.e. today's behaviour.
        # Filled by _finish() once the incremental scan has run this beat.
        "agents": [],
        "transcriptAgeSec": None,  # seconds since the newest transcript write
        "lastRole": None,          # "assistant"/"user"/... of the newest entry
        "lastHasToolUse": False,
        "lastActivityTs": None,    # that entry's own ISO timestamp (XERK-224)
        "question": None,          # pending AskUserQuestion text, if any
        "questionOptions": [],     # pending AskUserQuestion option labels, if any
        # Rich pending-question fields for the native chat picker (backward-compat
        # clients ignore these and read `questionOptions` labels):
        "questionOptionsRich": [], # [{label, description?, preview?}] for option cards
        "questionHeader": None,    # short header chip, e.g. "Semantics"
        "questionIndex": None,     # 0-based position in a multi-question call
        "questionTotal": None,     # count of questions in the call
        "questionMulti": False,    # multiSelect (pick several, then submit)
        "questionSource": None,    # "transcript" | "hook" | None — which detector fired
        "prUrls": [],              # PR links newly appended since last beat
        "modelActual": None,       # newest actual-model signal appended this beat
        "tail": [],                # recent transcript messages, for the glasses client
    }

    def _finish():
        # Live background agents, accumulated across beats by _scan_agent_entry
        # into `state`. Reported on EVERY exit path (including the ones that
        # never reach a transcript this beat), so a session with agents still in
        # flight keeps reporting them on a beat that appended nothing.
        report["agents"] = live_agents_report(state)
        # The ask.py PreToolUse bridge publishes a request file for exactly as
        # long as a question is actually blocking the tool call, so it's the
        # authoritative pending signal — prefer it over the transcript scan
        # (which can only see a question once it's already answered/denied).
        hq = _hook_question(session_id)
        if hq:
            report["question"] = hq["question"]
            report["questionOptions"] = hq["labels"]
            report["questionOptionsRich"] = hq["options"]
            report["questionHeader"] = hq["header"]
            report["questionIndex"] = hq["index"]
            report["questionTotal"] = hq["total"]
            report["questionMulti"] = hq["multi"]
            report["questionSource"] = "hook"
        return report

    # One listdir serves both jobs: priming every file's offset (so a restarted
    # agent doesn't replay old PR links) and finding this session's transcript.
    # An unusable id matches no file rather than falling back — a session that
    # HAS an id reports on its own conversation or on none, same as
    # _session_transcript_path.
    pinned = (os.path.join(proj, f"{claude_sid}.jsonl")
              if claude_sid and VALID_CLAUDE_SID_RE.fullmatch(claude_sid) else "")
    newest, newest_mtime = None, 0.0
    found, found_mtime = None, 0.0
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
            if path == pinned:
                found, found_mtime = path, st.st_mtime
            if st.st_mtime > newest_mtime:
                newest, newest_mtime = path, st.st_mtime
    except OSError:
        state["primed"] = True
        return _finish()
    state["primed"] = True
    if claude_sid:
        # A pinned session reports on its own transcript or on none at all: an
        # absent file means it hasn't spoken yet, NOT that the newest neighbour
        # in a shared project dir is its conversation.
        newest, newest_mtime = found, found_mtime
    if not newest:
        return _finish()
    report["transcriptAgeSec"] = max(0, int(time.time() - newest_mtime))
    report["tail"] = transcript_tail(newest)

    entry = _last_entry(newest)
    if entry:
        report["lastRole"] = entry.get("type")
        # The newest entry's OWN timestamp — the conversation's clock, not the
        # file's. `_session_payload` compares it against `prsLandedTs` to answer
        # "has this session said anything since its PRs landed?" (XERK-224);
        # both sides come from transcript entries, so no wall-clock skew enters.
        report["lastActivityTs"] = entry.get("timestamp")
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
                        q0 = qs[0]
                        report["question"] = str(q0.get("question") or "")[:300] or None
                        opts = q0.get("options") or []
                        report["questionOptions"] = _question_labels(opts)
                        report["questionOptionsRich"] = _question_options(opts)
                        report["questionHeader"] = _question_header(q0.get("header"))
                        report["questionIndex"] = 0
                        report["questionTotal"] = len(qs)
                        report["questionMulti"] = q0.get("multiSelect") is True
                        if report["question"]:
                            report["questionSource"] = "transcript"

    # Incremental scan over the bytes appended to the active transcript, for the
    # PRs this session OPENED (see _scan_pr_line for what counts) and the model
    # actually answering (_scan_model_entry). Only COMPLETE JSONL lines are
    # consumed — the offset stops at the last newline, so an entry still being
    # written is re-read whole next beat rather than parsed in half and lost.
    try:
        size = os.stat(newest).st_size
        start = offsets.get(newest, 0)
        if size < start:
            start = size  # file was truncated/rewritten; don't rescan
        if size - start > 1 << 22:
            start = size - (1 << 22)  # cap a huge backlog at 4 MiB
        consumed = start
        if size > start:
            with open(newest, "rb") as f:
                f.seek(start)
                raw = f.read(size - start)
            end = raw.rfind(b"\n") + 1  # 0 when no line has completed yet
            for line in raw[:end].split(b"\n"):
                if line.strip():
                    _scan_entry_line(line, state, report)
            consumed = start + end
        offsets[newest] = consumed
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


# --- Extra git sources (XERK-155) ----------------------------------------------
# Beyond GitHub, a host can list and clone repos from the Azure DevOps
# org/collection whose PAT it already holds for the board (AZDO_URL/AZDO_TOKEN)
# and from a GitLab host (GITLAB_URL + GITLAB_TOKEN — the token only LISTS;
# cloning goes over SSH with the host's mounted ~/.ssh key). The extra sources'
# listings ride the heartbeat as the `gitSources` block BESIDE the legacy
# `github` block, which keeps its exact contract — both older hubs and the
# agent's own gh-gated features (PR comments, the triage gh sweep) read it.
# A clone request is resolved back against these cached listings, so the clone
# URL always comes from the source's own API, never from the request.
GITLAB_URL = os.environ.get("GITLAB_URL", "").strip()
GITLAB_TOKEN = os.environ.get("GITLAB_TOKEN", "").strip()
GITLAB_PAGE_MAX = 3   # pages of 100 projects swept per refresh (bounds the HTTP)

# A non-GitHub repo path segment ('My Project' in 'My Project/repo'): printable,
# no path separators, no leading dash/dot. Looser than _GH_SEG_RE because Azure
# DevOps project names routinely carry spaces; the segment only ever feeds
# fingerprints, labels and prompts — never a shell.
_SRC_SEG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]*$")


def valid_source_repo(path):
    """True when a listing's repo path ('owner/repo', 'group/sub/project') is
    safe to carry: 2-6 loose-checked segments, and a LAST segment (the repo
    name, which becomes the clone's directory under REPOS_ROOT) passing the
    strict GitHub charset. An entry that fails is dropped at collection time
    rather than sanitized, so nothing downstream ever re-validates."""
    segs = (path or "").split("/")
    if not 2 <= len(segs) <= 6:
        return False
    if not all(len(s) <= 100 and ".." not in s and _SRC_SEG_RE.match(s)
               for s in segs):
        return False
    return bool(_GH_SEG_RE.match(segs[-1]))


def gitlab_configured():
    return bool(GITLAB_URL and GITLAB_TOKEN)


def gitlab_base():
    """GITLAB_URL -> a scheme-qualified, trailing-slash-free API base."""
    b = GITLAB_URL
    if not b:
        return ""
    if not re.match(r"^[a-zA-Z][\w.+-]*://", b):
        b = "https://" + b
    return b.rstrip("/")


def gitlab_host():
    """The bare host of GITLAB_URL — the source's UI label."""
    return re.sub(r"^[a-zA-Z][\w.+-]*://", "", gitlab_base()).split("/")[0]


def _gitlab_get(path):
    """GET one GitLab REST path (relative to /api/v4/) with the configured
    token; parsed JSON, or None on any failure. The quiet best-effort shape
    the MR status/comment pollers need — unlike collect_gitlab_repos, whose
    raise carries the error into the git-sources block."""
    try:
        req = urllib.request.Request(
            f"{gitlab_base()}/api/v4/{path}",
            headers={"PRIVATE-TOKEN": GITLAB_TOKEN,
                     "Accept": "application/json",
                     "User-Agent": "turma-agent/1.0"})
        with urllib.request.urlopen(req, timeout=JIRA_TIMEOUT_SEC) as resp:
            return json.loads(resp.read().decode() or "null")
    except Exception:
        return None


# The token's own GitLab username, cached after the first successful probe —
# the MR counterpart of the gh login compare in _pr_comment_events. A failed
# probe stays None and retries on a later poll.
_GITLAB_SELF = {"username": None}


def _gitlab_self_username():
    if _GITLAB_SELF["username"] is None:
        data = _gitlab_get("user")
        if isinstance(data, dict) and data.get("username"):
            _GITLAB_SELF["username"] = str(data["username"])
    return _GITLAB_SELF["username"]


def collect_gitlab_repos():
    """The GitLab projects the token's user is a member of, shaped like the
    github listing (nameWithOwner = path_with_namespace, which may nest as
    group/subgroup/project). cloneUrl is the project's SSH URL — GitLab repos
    clone over ssh, so the mounted ~/.ssh key is the git credential and the
    token never reaches git. Raises on HTTP failure (the caller keeps the last
    good list); a malformed entry is dropped."""
    out = []
    for page in range(1, GITLAB_PAGE_MAX + 1):
        q = urllib.parse.urlencode({
            "membership": "true", "archived": "false",
            "order_by": "last_activity_at", "sort": "desc",
            "per_page": 100, "page": page,
        })
        req = urllib.request.Request(
            f"{gitlab_base()}/api/v4/projects?{q}",
            headers={"PRIVATE-TOKEN": GITLAB_TOKEN,
                     "Accept": "application/json",
                     "User-Agent": "turma-agent/1.0"})
        with urllib.request.urlopen(req, timeout=JIRA_TIMEOUT_SEC) as resp:
            data = json.loads(resp.read().decode() or "[]")
        if not isinstance(data, list) or not data:
            break
        for p in data:
            p = p if isinstance(p, dict) else {}
            path = p.get("path_with_namespace") or ""
            ssh = p.get("ssh_url_to_repo") or ""
            if not (valid_source_repo(path) and ssh):
                continue
            out.append({
                "nameWithOwner": path,
                "name": path.split("/")[-1],
                "description": (p.get("description") or "")[:120],
                "isPrivate": (p.get("visibility") or "private") != "public",
                "updatedAt": p.get("last_activity_at") or "",
                "cloneUrl": ssh,
            })
        if len(data) < 100 or len(out) >= GH_REPO_MAX:
            break
    return out[:GH_REPO_MAX]


def collect_azure_repos():
    """The git repos of the board's Azure DevOps org/collection — the same
    AZDO_URL/AZDO_TOKEN the board polls with — across every project the PAT can
    see (the collection-level repositories API enumerates them all in one call).
    nameWithOwner = 'Project/Repo'; cloneUrl is the https remoteUrl, which plain
    git already authenticates against via the extraHeader wired at boot
    (--wire-azure-git). Raises on HTTP failure; malformed entries are dropped."""
    data = azure_req("/_apis/git/repositories", {})
    out = []
    for r in (data.get("value") or []):
        r = r if isinstance(r, dict) else {}
        if r.get("isDisabled"):
            continue
        name = r.get("name") or ""
        proj = (r.get("project") or {}).get("name") or ""
        url = r.get("remoteUrl") or ""
        path = f"{proj}/{name}"
        if not (proj and name and url and valid_source_repo(path)):
            continue
        out.append({
            "nameWithOwner": path,
            "name": name,
            "description": "",
            # The repos API reports no visibility; an ADO org's repos are
            # private to it, which is what the lock glyph means in the UI.
            "isPrivate": True,
            "updatedAt": str((r.get("project") or {}).get("lastUpdateTime") or ""),
            "cloneUrl": url,
        })
    out.sort(key=lambda e: e["updatedAt"], reverse=True)
    return out[:GH_REPO_MAX]


# --- Jira Cloud ticket polling --------------------------------------------------
# Optional: with user-scoped Jira Cloud creds in the env (JIRA_SITE + JIRA_EMAIL
# + JIRA_TOKEN — an ordinary Atlassian API token, Basic auth), the agent polls
# the tickets assigned to that user on a slow cadence and reports them as the
# heartbeat's `jira` block. The hub's /board page merges every host's block into
# one cross-org Kanban, keyed by siteKey (normalized site host) so several
# agents sharing an org collapse to one board. Almost entirely read-only: the
# only calls are issue search + on-demand detail, plus the one WRITE path the
# board exposes — creating a ticket (XERK-137), which POSTs a single new issue.
# Unset env = feature off: zero Jira HTTP calls, and the block heartbeats as
# available=False.
JIRA_SITE = os.environ.get("JIRA_SITE", "").strip()
JIRA_EMAIL = os.environ.get("JIRA_EMAIL", "").strip()
JIRA_TOKEN = os.environ.get("JIRA_TOKEN", "").strip()
try:
    JIRA_REFRESH_EVERY = int(os.environ.get("TURMA_JIRA_REFRESH_EVERY", "30"))
except ValueError:
    JIRA_REFRESH_EVERY = 30   # beats between polls (30 × 20s beat ≈ 10 min)
# Ticket auto-start (XERK-32) is opt-in PER ORG so the hub starts a session for
# every "To Do" ticket the moment it has a repo assigned (by the model's triage or
# a manual pin). The opt-in is HUB-ONLY (XERK-41): the operator flips it from the
# board's per-org auto-start switch (a durable hub setting — see the hub's
# autostart-orgs store), so there is no agent-side config for it and this host
# reports no auto-start flag. The hub owns the decision and the routing anyway,
# because only it sees the whole fleet and can spread the org's sessions across
# ALL its agents.
JIRA_TIMEOUT_SEC = 15
JIRA_PAGE_SIZE = 100    # /search/jql hard-caps maxResults at 100
JIRA_MAX_ACTIVE = 150   # not-Done tickets reported (bounds the heartbeat)
JIRA_MAX_DONE = 50      # recently-Done tickets reported
JIRA_DONE_DAYS = 14     # how far back the Done column reaches
JIRA_MAX_PAGES = 5      # hard bound on pagination per query

# On-demand single-issue detail (the board's expanded ticket view). The board
# card's fields ride the heartbeat for every ticket; description + comments are
# far too big for that, so they're fetched one issue at a time when an operator
# actually opens a ticket — the same {command -> staged result -> next beat}
# path the session `history` command uses.
JIRA_DESC_MAX_CHARS = 8000      # per-issue description text kept
JIRA_COMMENT_MAX = 20           # newest comments kept
JIRA_COMMENT_MAX_CHARS = 2000   # per-comment text kept
JIRA_DETAIL_LABELS_MAX = 20     # labels kept (the card shape caps at 5)

# Ticket creation (XERK-137). The board's "New ticket" form fetches the create
# metadata (projects, issue types, existing labels) on demand — the same
# {command -> staged result -> next beat} path as issue detail — then POSTs one
# new issue. Bounded so a big org can't make the meta fetch block a heartbeat.
CREATE_META_MAX_PROJECTS = 100  # projects offered in the New-ticket picker
CREATE_META_MAX_LABELS = 200    # existing labels/tags offered as suggestions
CREATE_TITLE_MAX_CHARS = 250    # summary/title cap (Jira's own limit is 255)
CREATE_DESC_MAX_CHARS = 30000   # description cap
CREATE_LABELS_MAX = 20          # labels/tags accepted on one new ticket
# An issue key is interpolated into a REST path, so it's allowlist-checked
# against Jira's own key grammar (PROJECT-123) before it ever reaches a URL —
# the same "nothing free-form reaches the shell" stance as the spawn options.
JIRA_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*-[0-9]+$")

# Full block schema even when off/unavailable, mirroring the github block's
# contract: the hub always sees every field, never a partial dict.
#
# `configured` is creds-present, which is NOT the same as `available` (a
# successful poll). It is what lets the hub aim a manual refresh at the
# configured-but-failing host that most needs the retry. A configured block also
# carries its locally-derived `siteKey` (see jira_empty/azure_empty), so a
# failing org is still visible on the board and org filters — `available` is what
# tells the two apart, not the presence of a siteKey.
JIRA_EMPTY = {"available": False, "configured": False, "source": "jira",
              "site": None, "siteKey": None, "user": None, "fetchedAt": None,
              "error": None, "truncated": False, "tickets": []}

# fields.status.statusCategory.key is one of Jira's three fixed, cross-org
# categories — the only workflow facet guaranteed to unify orgs with different
# status schemes, hence the board's column model.
_JIRA_CATEGORY = {"new": "todo", "indeterminate": "inprogress", "done": "done"}


def jira_configured():
    return bool(JIRA_SITE and JIRA_EMAIL and JIRA_TOKEN)


def jira_empty():
    """The off/never-polled block, stamped with whether creds are present. The
    creds are read once at import, so `configured` is fixed for the process —
    every later block (success or fail-open) carries it forward unchanged.

    A CONFIGURED org's identity (`site`/`siteKey`, and the operator's `orgName`
    override) is derivable from local config alone — no successful poll needed —
    so it is stamped here too. That is what makes a configured-but-unreachable
    org (its very first poll failing, e.g. a self-hosted host behind a downed
    VPN) still appear on the board and in every org filter, as an errored,
    zero-ticket org, instead of vanishing until a poll finally succeeds. The
    siteKey is byte-identical to the one a successful poll produces, so nothing
    churns when it recovers."""
    block = dict(JIRA_EMPTY)
    block["configured"] = jira_configured()
    if block["configured"]:
        site = normalize_jira_site(JIRA_SITE)
        block["site"] = site
        block["siteKey"] = site
        block["orgName"] = BOARD_ORG_NAME or None
    return block


def normalize_jira_site(raw):
    """A Jira site spec ('myorg.atlassian.net', 'https://MyOrg.atlassian.net/',
    even a pasted board URL) -> the bare lowercase host, the cross-host
    `siteKey` the hub dedupes boards on. '' when nothing host-like remains."""
    r = (raw or "").strip()
    r = re.sub(r"^[a-zA-Z][\w.+-]*://", "", r)   # scheme
    r = re.sub(r"^[^/@]+@", "", r)               # credentials
    r = r.split("/", 1)[0].split(":", 1)[0]      # path, port
    return r.strip(".").lower()


# --- Tracker HTTP --------------------------------------------------------------
# Every Jira and Azure DevOps request funnels through _board_urlopen so a
# rejection reads the same wherever it surfaces (a block's `error`, a staged
# command result, the New-ticket dialog).
BOARD_ERROR_MAX_CHARS = 200


def _http_error_detail(err):
    """A failed tracker request as text an operator can act on.

    urllib's HTTPError stringifies to just "HTTP Error 400: Bad Request" and
    DISCARDS the response body — but that body is the only place either tracker
    says why: a field the work-item type doesn't have, an identity the
    collection can't resolve, a workflow rule. Without it every rejected write
    reads as the same unactionable sentence, with nothing to act on and no way
    to tell two unrelated failures apart.
    """
    code = getattr(err, "code", None) or "?"
    body = ""
    try:
        body = (err.read() or b"").decode("utf-8", "replace")
    except Exception:
        pass
    msg = ""
    try:
        parsed = json.loads(body) if body.strip() else None
        if isinstance(parsed, dict):
            # Azure DevOps says {"message": ...}; Jira says {"errorMessages":
            # [...]} and/or a per-field {"errors": {field: why}}.
            msg = str(parsed.get("message") or "").strip()
            if not msg:
                msg = "; ".join(str(m) for m in (parsed.get("errorMessages") or []))
            errors = parsed.get("errors")
            if not msg and isinstance(errors, dict):
                msg = "; ".join(f"{k}: {v}" for k, v in errors.items())
    except Exception:
        pass
    if not msg:
        # Not JSON: an HTML error page from a proxy or IIS in front of a
        # self-hosted server. Strip the markup so the sentence inside survives.
        msg = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", body)
        msg = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", msg)).strip()
    msg = msg[:BOARD_ERROR_MAX_CHARS].strip()
    return f"HTTP {code}: {msg}" if msg else f"HTTP {code}"


class BoardHttpError(RuntimeError):
    """A tracker request the server REFUSED, carrying its status. The code is
    what lets a caller tell "rejected, nothing happened" (4xx) from "we don't
    know what happened" (a timeout, a 5xx) — the difference between a retry that
    is safe and one that can duplicate a write."""

    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def _board_urlopen(req):
    """Send one prepared tracker request and parse its JSON reply ({} when the
    body is empty — a Jira transition answers 204). An HTTP error is re-raised
    carrying the server's own explanation; everything else (DNS, TLS, timeout)
    propagates untouched, since urllib already stringifies those usefully."""
    try:
        with urllib.request.urlopen(req, timeout=JIRA_TIMEOUT_SEC) as resp:
            raw = resp.read().decode()
    except urllib.error.HTTPError as e:
        raise BoardHttpError(_http_error_detail(e), getattr(e, "code", None)) from e
    return json.loads(raw) if raw.strip() else {}


def _write_was_refused(err):
    """Whether a failed write provably changed NOTHING, so re-sending it can't
    duplicate anything. Only a 4xx says that: the server parsed the request and
    declined it. A timeout or a 5xx may have applied the write anyway."""
    code = getattr(err, "code", None)
    return isinstance(code, int) and 400 <= code < 500


# --- Attachment download (XERK-242) --------------------------------------------
# The one path that fetches BYTES rather than JSON off a tracker. It is separate
# from _board_urlopen for two reasons: the reply is binary and must be read under
# a byte cap, and an attachment download is the one tracker request that leaves
# the tracker's host — Jira answers /attachment/content with a 30x to a media CDN.

def _url_host(url):
    """A URL's lowercase host[:port], '' if it has none."""
    try:
        return urllib.parse.urlsplit(str(url or "")).netloc.lower()
    except Exception:
        return ""


def board_attachment_host():
    """The one host this agent will fetch an attachment from: the configured
    tracker's. Every attachment URL we act on is checked against it — the URLs
    come out of a tracker response, but they are the only field in a ticket that
    we turn into an outbound request carrying a credential, so a compromised or
    misbehaving server must not be able to point that request anywhere else."""
    if board_source() == "azure":
        return _url_host(azure_base())
    return normalize_jira_site(JIRA_SITE)


def _host_is_public(hostname):
    """Whether `hostname` resolves ONLY to addresses outside the ranges an
    attachment fetch has no business reaching — loopback, link-local (which is
    where cloud instance metadata lives), private, reserved, multicast.

    Deny on anything we can't resolve or can't parse: this gates a redirect the
    TRACKER chose, so "don't know" must not mean "go ahead"."""
    if not hostname:
        return False
    try:
        infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
    except Exception:
        return False
    if not infos:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except Exception:
            return False
        # is_global, not `not is_private`: it is the one flag that also excludes
        # carrier-NAT (100.64/10), benchmarking and documentation space, and it
        # reads an IPv4-mapped IPv6 address (::ffff:10.0.0.1) as what it maps to.
        # Multicast is excluded separately — 224.0.0.0/4 counts as global.
        if not ip.is_global or ip.is_multicast:
            return False
    return True


def attachment_redirect_ok(newurl):
    """Whether an attachment download may FOLLOW `newurl`.

    Following a redirect off the tracker is required, not optional — Jira answers
    /attachment/content with a 30x to a media CDN — so the initial URL's
    tracker-only check cannot simply be repeated here. What is enforced instead:
      - http/https only (urllib's own redirect check would also permit ftp:, and
        the opener carries an FTP handler);
      - back to the tracker is always fine, INCLUDING a tracker on a private
        address, which a self-hosted TFS/Jira routinely is;
      - anywhere else must be a public address, so a tracker cannot turn this
        into a read of 169.254.169.254, a neighbour on the LAN, or localhost.

    Known limit: we resolve the name and http.client then resolves it AGAIN to
    connect, so a tracker that also runs low-TTL DNS can answer the two calls
    differently. Closing that needs connecting to a pinned address with an
    explicit Host header, which urllib doesn't offer; it is left open knowingly,
    since reaching it means already controlling the configured tracker.
    """
    parts = urllib.parse.urlsplit(str(newurl or ""))
    if parts.scheme not in ("http", "https"):
        return False
    # `and host` so an unconfigured board (host "") isn't a wildcard matching a
    # netloc-less URL — belt to fetch_board_attachment's braces.
    host = board_attachment_host()
    if host and parts.netloc.lower() == host:
        return True
    try:
        return _host_is_public(parts.hostname)
    except Exception:
        return False


class _StripAuthRedirect(urllib.request.HTTPRedirectHandler):
    """Police an attachment redirect: where it may go, and what it may carry.

    urllib copies a request's headers onto the redirected one verbatim, so the
    default behaviour would hand our Jira Basic auth to the CDN the download
    redirects to — which both leaks the credential to a third party and (since
    the presigned URL carries its own auth) is what makes the fetch fail.

    The credential survives only a redirect that stays on the SAME ORIGIN —
    scheme included, so an `https -> http` hop on one host drops it rather than
    putting the tracker's Basic auth on the wire in cleartext. Where the hop may
    point at all is attachment_redirect_ok's business; a refused target raises,
    which fetch_board_attachment turns into a named miss like any other failure.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not attachment_redirect_ok(newurl):
            raise urllib.error.HTTPError(
                req.full_url, code,
                f"refused redirect to {str(newurl)[:120]}", headers, fp)
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and _url_origin(req.full_url) != _url_origin(newurl):
            for h in ("Authorization", "Proxy-authorization", "Cookie"):
                new.remove_header(h)
        return new


def _url_origin(url):
    """(scheme, host[:port]) — what "the same place" means for carrying a
    credential. The SCHEME is part of it: https://h and http://h are the same
    host but not the same trust, and a downgrade is how a credential ends up in
    cleartext."""
    try:
        p = urllib.parse.urlsplit(str(url or ""))
        return (p.scheme.lower(), p.netloc.lower())
    except Exception:
        return ("", "")


_ATTACH_OPENER = urllib.request.build_opener(_StripAuthRedirect())


def _attachment_decoder(encoding):
    """An INCREMENTAL decompressor for a content-encoded body, or None when the
    body is already what it says. Raises on an encoding we can't undo.

    Incremental, and fed a `max_length` per chunk by the read loop, because the
    byte cap has to bound what comes OUT. Bounding only the compressed body is
    no bound at all: gzip does ~1000:1 on repetitive data, so 2 MB on the wire
    inflates to gigabytes, and a one-shot `gzip.decompress` allocates all of it
    before any size check can run — on the manager's own process, which is PID 1
    in the container and dies to the OOM killer rather than raising.

    We ask for `identity`, so this only fires for a proxy or self-hosted front
    end that compressed anyway — which is exactly a party we don't control."""
    enc = (encoding or "").strip().lower()
    if enc in ("", "identity"):
        return None
    if enc == "gzip":
        return zlib.decompressobj(16 + zlib.MAX_WBITS)
    if enc == "deflate":
        return zlib.decompressobj()
    raise ValueError(f"unsupported Content-Encoding {enc!r}")


def fetch_board_attachment(url, max_bytes, timeout=None, deadline=None):
    """One attachment's bytes off the configured tracker, or None.

    Total and best-effort: every failure (a rejected URL, a refused redirect, an
    HTTP error, a timeout, a body past `max_bytes`) returns None and logs,
    because the caller NAMES a file that didn't arrive rather than pretending it
    did.

    `deadline` (a time.monotonic() stamp) is a HARD stop, and the read loop is
    what makes it one. A socket timeout bounds only how long we wait for the
    NEXT byte, and one `read(n)` blocks until it has all n — so a server that
    dribbles bytes under every byte cap resets the clock forever and holds the
    manager's one loop with it. Reading a chunk at a time off `read1` (at most
    one underlying read, returns what has arrived) puts a deadline check between
    chunks, so a trickle is cut off instead of waited out. One byte past
    `max_bytes` is fetched deliberately: it is how an oversized body is detected
    rather than silently clipped to the cap."""
    host = board_attachment_host()
    parts = urllib.parse.urlsplit(str(url or ""))
    if parts.scheme not in ("http", "https") or not host or parts.netloc.lower() != host:
        log(f"attachment refused: {str(url)[:120]!r} is not on {host or '(no tracker)'}")
        return None
    if board_source() == "azure":
        auth = base64.b64encode(f":{AZDO_TOKEN}".encode()).decode()
    else:
        auth = base64.b64encode(f"{JIRA_EMAIL}:{JIRA_TOKEN}".encode()).decode()
    req = urllib.request.Request(url, headers={
        "Authorization": f"Basic {auth}",
        "Accept": "*/*",
        # Ask for the bytes as they are: nothing downstream inflates a body, and
        # a silently-gzipped .png is worse than a slightly bigger download.
        "Accept-Encoding": "identity",
        "User-Agent": "turma-agent/1.0",
    }, method="GET")
    per_read = timeout or TICKET_ATTACH_TIMEOUT_SEC
    if deadline is None:
        deadline = time.monotonic() + per_read
    try:
        with _ATTACH_OPENER.open(req, timeout=per_read) as resp:
            dec = _attachment_decoder(resp.headers.get("Content-Encoding"))
            # `want` bounds BOTH sides: the bytes off the wire, and — when the
            # body is compressed — the bytes they inflate to. `raw` is the wire
            # count, `got` the count that ends up on disk.
            want, raw, got = max_bytes + 1, 0, 0
            chunks = []
            while raw < want and got < want:
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"past the download budget with {got} bytes read")
                chunk = resp.read1(min(ATTACH_CHUNK_BYTES, want - raw))
                if not chunk:
                    break
                raw += len(chunk)
                if dec is None:
                    chunks.append(chunk)
                    got += len(chunk)
                    continue
                piece = dec.decompress(chunk, want - got)
                chunks.append(piece)
                got += len(piece)
                if dec.unconsumed_tail:
                    # The decompressor stopped at max_length with input left:
                    # this body inflates past the cap. Refuse it here rather
                    # than let the next chunk allocate the rest of the bomb.
                    got = want
                    break
            blob = b"".join(chunks)
            # A body that stopped early is a TRUNCATED file, and a half-written
            # screenshot the session is told to read is worse than a named miss
            # (the same call this repo makes for an over-long message). Only
            # checked when we didn't stop deliberately at the cap: there, the
            # short read IS the point. A stream with neither a length nor an
            # end marker can't be judged, and is taken at face value.
            if len(blob) <= max_bytes:
                declared = resp.headers.get("Content-Length")
                if dec is not None and not dec.eof:
                    raise ValueError("compressed body ended mid-stream")
                if (declared or "").strip().isdigit() and raw != int(declared):
                    raise ValueError(
                        f"body ended at {raw} of {declared} bytes")
    except Exception as e:
        log(f"attachment download failed ({str(url)[:120]}): {e}")
        return None
    if len(blob) > max_bytes:
        log(f"attachment {str(url)[:120]} is past {max_bytes} bytes; skipping it")
        return None
    return blob


def jira_req(path, params, body=None):
    """One authenticated request against the configured Jira Cloud site, parsed
    JSON out. GET when `body` is None, else a JSON POST — the board's status
    change (XERK-138) is the one write path, a transitions POST. A transition
    returns 204 with an empty body, so an empty response parses to {} rather
    than raising. Exceptions propagate — the read callers turn them into the
    block's `error` (stale-cache fail-open); the write caller stages them as a
    per-command error result."""
    site = normalize_jira_site(JIRA_SITE)
    url = f"https://{site}{path}?{urllib.parse.urlencode(params)}"
    auth = base64.b64encode(f"{JIRA_EMAIL}:{JIRA_TOKEN}".encode()).decode()
    headers = {
        "Authorization": f"Basic {auth}",
        "Accept": "application/json",
        # Explicit UA for parity with the hub POSTs (some edges 403 the
        # default Python-urllib signature).
        "User-Agent": "turma-agent/1.0",
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method="POST" if body is not None else "GET")
    return _board_urlopen(req)


def jira_get(path, params):
    """A read against the configured Jira Cloud site — jira_req with no body."""
    return jira_req(path, params)


def jira_post(path, body):
    """One authenticated POST against the configured Jira Cloud site (issue
    creation, XERK-137) — the write counterpart of jira_get. Same Basic auth and
    UA; a JSON body in, parsed JSON out. Exceptions propagate to the create
    command's staged result. An empty 201 body (some endpoints) parses to {}."""
    site = normalize_jira_site(JIRA_SITE)
    url = f"https://{site}{path}"
    auth = base64.b64encode(f"{JIRA_EMAIL}:{JIRA_TOKEN}".encode()).decode()
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={
        "Authorization": f"Basic {auth}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "turma-agent/1.0",
    }, method="POST")
    return _board_urlopen(req)


def _shape_issue(issue, site_key):
    """One raw REST-v3 search issue -> the compact wire ticket the board
    renders. Everything optional degrades to None/[] rather than raising."""
    fields = issue.get("fields") or {}
    key = issue.get("key") or ""
    status = fields.get("status") or {}
    category = ((status.get("statusCategory") or {}).get("key") or "").lower()

    def name_of(field):
        v = fields.get(field)
        return (v or {}).get("name") if isinstance(v, dict) else None

    project = fields.get("project") or {}
    parent = fields.get("parent") or {}
    labels = fields.get("labels")
    return {
        "key": key,
        "url": f"https://{site_key}/browse/{key}",
        "summary": (fields.get("summary") or "")[:200],
        "status": status.get("name"),                 # org-specific name (pill)
        "statusCategory": _JIRA_CATEGORY.get(category, "todo"),  # column
        "priority": name_of("priority"),
        "type": name_of("issuetype"),
        "project": project.get("key"),
        "projectName": project.get("name"),
        "labels": labels[:5] if isinstance(labels, list) else [],
        "updated": fields.get("updated"),
        "created": fields.get("created"),
        "dueDate": fields.get("duedate"),
        "parentKey": parent.get("key"),
    }


def fetch_jira_issues(jql, max_issues):
    """All issues matching a JQL, shaped, via GET /rest/api/3/search/jql —
    the nextPageToken-paginated replacement for the removed (410 since 2025)
    /rest/api/3/search. Returns (tickets, truncated): truncated means the cap
    (or the page bound) cut the result short."""
    site_key = normalize_jira_site(JIRA_SITE)
    tickets, token = [], None
    for _ in range(JIRA_MAX_PAGES):
        params = {
            "jql": jql,
            "maxResults": min(JIRA_PAGE_SIZE, max_issues - len(tickets)),
            "fields": "summary,status,priority,issuetype,updated,created,"
                      "duedate,labels,project,parent",
        }
        if token:
            params["nextPageToken"] = token
        data = jira_get("/rest/api/3/search/jql", params)
        for issue in data.get("issues") or []:
            tickets.append(_shape_issue(issue, site_key))
        token = data.get("nextPageToken")
        if not token:
            return tickets, False
        if len(tickets) >= max_issues:
            return tickets[:max_issues], True
    return tickets[:max_issues], True


def collect_jira():
    """The heartbeat's `jira` block: the configured user's assigned tickets on
    this host's org. Two separate queries — active work, and a bounded window
    of recently-Done so that column is populated without growing forever —
    with separate caps so neither can crowd the other out."""
    if not jira_configured():
        return jira_empty()
    site_key = normalize_jira_site(JIRA_SITE)
    active, trunc_active = fetch_jira_issues(
        "assignee = currentUser() AND statusCategory != Done"
        " ORDER BY updated DESC", JIRA_MAX_ACTIVE)
    done, trunc_done = fetch_jira_issues(
        "assignee = currentUser() AND statusCategory = Done"
        f" AND updated >= -{JIRA_DONE_DAYS}d ORDER BY updated DESC",
        JIRA_MAX_DONE)
    return {
        "available": True,
        "configured": True,
        "source": "jira",
        "site": site_key,
        "siteKey": site_key,
        "user": JIRA_EMAIL,
        "fetchedAt": now_iso(),
        "error": None,
        "truncated": trunc_active or trunc_done,
        "tickets": active + done,
    }


# --- Jira issue detail (on-demand) ---------------------------------------------
# Jira Cloud's REST v3 returns rich text (descriptions, comment bodies) as ADF —
# Atlassian Document Format, a nested {type, content[], attrs} node tree, not
# HTML or markdown. The board renders plain text, so the agent flattens it here
# rather than shipping the tree and re-implementing the walk in the browser.
# Only the shapes Jira actually emits are special-cased; anything unrecognized
# still recurses into its `content`, so an unknown node degrades to its text
# instead of vanishing.

_ADF_BLOCKS = {"paragraph", "heading", "blockquote", "codeBlock", "panel",
               "bulletList", "orderedList", "taskList", "table", "mediaGroup",
               "mediaSingle", "expand", "nestedExpand"}


def adf_text(node):
    """An ADF node (or a plain string — REST v2 and some webhooks send one) ->
    plain text. Best-effort and total: never raises on a malformed tree, just
    returns what it could read."""
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(adf_text(n) for n in node)
    if not isinstance(node, dict):
        return ""
    t = node.get("type")
    attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}

    if t == "text":
        txt = node.get("text") or ""
        # A link's href is part of the detail an operator is reviewing, so keep
        # it alongside the anchor text unless the text already is the URL.
        for m in node.get("marks") or []:
            if isinstance(m, dict) and m.get("type") == "link":
                href = (m.get("attrs") or {}).get("href")
                if href and href != txt:
                    txt = f"{txt} ({href})"
        return txt
    if t == "hardBreak":
        return "\n"
    if t == "rule":
        return "\n---\n"
    if t == "mention":
        return "@" + str(attrs.get("text") or attrs.get("displayName") or "").lstrip("@")
    if t == "emoji":
        return str(attrs.get("text") or attrs.get("shortName") or "")
    if t in ("inlineCard", "blockCard", "embedCard"):
        return str(attrs.get("url") or "")
    if t == "media":
        return f"[attachment: {attrs.get('alt') or attrs.get('id') or ''}]"
    if t == "tableRow":
        cells = [adf_text(c).strip() for c in node.get("content") or []]
        return " | ".join(cells) + "\n"

    inner = "".join(adf_text(c) for c in node.get("content") or [])
    if t in ("listItem", "taskItem"):
        return "- " + inner.strip() + "\n"
    if t in _ADF_BLOCKS:
        return inner.strip("\n") + "\n\n"
    return inner


def adf_plain(node, limit):
    """adf_text() normalized for display and clipped: (text, truncated). Runs of
    blank lines collapse to one so a paragraph-heavy description doesn't render
    as a column of gaps."""
    text = re.sub(r"\n{3,}", "\n\n", adf_text(node)).strip()
    if len(text) <= limit:
        return text, False
    return text[:limit].rstrip(), True


# --- Status change (XERK-138) --------------------------------------------------
# The board's one write path. A ticket's changeable statuses are workflow- and
# current-status-dependent, so the detail view carries the AVAILABLE targets it
# fetched (Jira's transitions, Azure's states) and the operator picks one; the
# agent re-reads them at write time and only applies a target still on offer.
# statusOptions is a source-agnostic [{id, name, category}]: `id` is what the
# write submits (Jira's transition id, Azure's state name), `name` is what the
# picker shows, `category` maps to the board's todo/inprogress/done column.

def _shape_transitions(transitions):
    """Jira's `transitions` expansion -> the source-agnostic statusOptions shape.
    Labelled with the RESULTING status (`to.name`), not the transition action's
    own name, since the operator is choosing a status to land in; the submit
    value is the transition id. Anything malformed is skipped, not raised."""
    out = []
    for tr in transitions or []:
        if not isinstance(tr, dict):
            continue
        to = tr.get("to") if isinstance(tr.get("to"), dict) else {}
        cat = ((to.get("statusCategory") or {}).get("key") or "").lower()
        name = to.get("name") or tr.get("name")
        tid = tr.get("id")
        if tid is None or not name:
            continue
        out.append({"id": str(tid), "name": name,
                    "category": _JIRA_CATEGORY.get(cat, "todo")})
    return out


def _jira_status_options(key):
    """The transitions available from an issue's current status, fetched fresh —
    the allowlist set_board_status validates a requested change against."""
    data = jira_req(
        f"/rest/api/3/issue/{urllib.parse.quote(key)}/transitions", {})
    return _shape_transitions(data.get("transitions"))


def _shape_attachments(raw, name_of, size_of, url_of, mime_of=None):
    """The source-agnostic attachment list a detail carries (XERK-242):
    ([{name, size, url, mime}], total) — capped at TICKET_ATTACH_MAX, and the
    count BEFORE the cap beside it.

    Only what a download needs plus what names it in the prompt — deliberately
    NOT the bytes, which are fetched once, at spawn, by the session that will
    read them. An entry missing a name or a URL is dropped from both counts:
    there is nothing to fetch and nothing to call it.

    The cap keeps the NEWEST, as the comment shaping does: both trackers list
    attachments oldest-first, so keeping the first N would drop exactly the
    screenshot someone added because the ticket is about it. `total` is reported
    so nothing is dropped SILENTLY — the prompt says how many it isn't showing
    rather than stating a count that is quietly wrong."""
    usable = []
    for a in raw or []:
        if not isinstance(a, dict):
            continue
        name = str(name_of(a) or "").strip()
        url = str(url_of(a) or "").strip()
        if not name or not url:
            continue
        size = size_of(a)
        usable.append({
            "name": name[:UPLOAD_NAME_MAX * 2],
            "url": url,
            "size": size if isinstance(size, int) else None,
            "mime": (str(mime_of(a))[:100] if mime_of and mime_of(a) else None),
        })
    return usable[-TICKET_ATTACH_MAX:], len(usable)


def _shape_issue_detail(issue, site_key):
    """One raw REST-v3 GET-issue response -> the card shape plus everything the
    expanded view adds: description, comments, people, full labels, the
    available status transitions (from the `transitions` expansion), and the
    ticket's attachments."""
    detail = _shape_issue(issue, site_key)
    fields = issue.get("fields") or {}

    def person(field):
        v = fields.get(field)
        return (v or {}).get("displayName") if isinstance(v, dict) else None

    desc, desc_trunc = adf_plain(fields.get("description"), JIRA_DESC_MAX_CHARS)
    detail["description"] = desc
    detail["descriptionTruncated"] = desc_trunc
    detail["reporter"] = person("reporter")
    detail["assignee"] = person("assignee")
    detail["resolution"] = (fields.get("resolution") or {}).get("name") \
        if isinstance(fields.get("resolution"), dict) else None
    labels = fields.get("labels")
    detail["labels"] = labels[:JIRA_DETAIL_LABELS_MAX] if isinstance(labels, list) else []
    parent = fields.get("parent") or {}
    detail["parentSummary"] = ((parent.get("fields") or {}).get("summary")
                               if isinstance(parent.get("fields"), dict) else None)

    # `comment` is a paginated container: {comments:[…oldest first], total}. We
    # keep the NEWEST few — a long thread's recent replies are the ones being
    # reviewed — and report `commentTotal` so the UI can say what it dropped.
    block = fields.get("comment") if isinstance(fields.get("comment"), dict) else {}
    raw = block.get("comments") if isinstance(block.get("comments"), list) else []
    comments = []
    for c in raw[-JIRA_COMMENT_MAX:]:
        if not isinstance(c, dict):
            continue
        body, trunc = adf_plain(c.get("body"), JIRA_COMMENT_MAX_CHARS)
        author = c.get("author")
        comments.append({
            "id": c.get("id"),
            "author": (author or {}).get("displayName") if isinstance(author, dict) else None,
            "created": c.get("created"),
            "updated": c.get("updated"),
            "body": body,
            "truncated": trunc,
        })
    detail["comments"] = comments
    total = block.get("total")
    detail["commentTotal"] = total if isinstance(total, int) else len(comments)
    detail["statusOptions"] = _shape_transitions(issue.get("transitions"))
    # `content` is the authenticated download URL Jira hands out for the file;
    # it covers inline images too, which are ordinary attachments referenced by
    # a media node in the description's ADF.
    detail["attachments"], detail["attachmentTotal"] = _shape_attachments(
        fields.get("attachment"),
        name_of=lambda a: a.get("filename"),
        size_of=lambda a: a.get("size"),
        url_of=lambda a: a.get("content"),
        mime_of=lambda a: a.get("mimeType"))
    detail["fetchedAt"] = now_iso()
    return detail


def fetch_jira_issue(key):
    """One issue's full detail. `expand=transitions` rides the one GET so the
    available status changes come back with the issue rather than costing a
    second call. Exceptions propagate — _stage_jira_issue turns them into the
    staged result's `error` so the board can say why."""
    site_key = normalize_jira_site(JIRA_SITE)
    data = jira_get(
        f"/rest/api/3/issue/{urllib.parse.quote(key)}",
        {"fields": "summary,status,priority,issuetype,updated,created,duedate,"
                   "labels,project,parent,description,reporter,assignee,"
                   "resolution,comment,attachment",
         "expand": "transitions"},
    )
    return _shape_issue_detail(data, site_key)


# --- Jira ticket creation (XERK-137) -------------------------------------------
# The board's "New ticket" form. The metadata (projects + per-project issue types
# + existing labels) is fetched on demand so the picker offers real choices; the
# create itself POSTs one issue and self-assigns it to the configured user, so the
# new ticket lands on the board (which shows assignee = currentUser) straight away.

# The account id of the configured Jira user, looked up once and cached, so a
# created issue can be assigned to them (Jira Cloud's create wants an accountId,
# not the email we hold). None if the lookup fails — self-assignment is then
# skipped and the ticket is created unassigned (still valid, just not on the
# board until someone assigns it).
_JIRA_MYSELF = {"accountId": None, "tried": False}


def _jira_account_id():
    """The configured user's Jira accountId (cached, best-effort)."""
    if _JIRA_MYSELF["tried"]:
        return _JIRA_MYSELF["accountId"]
    _JIRA_MYSELF["tried"] = True
    try:
        me = jira_get("/rest/api/3/myself", {})
        _JIRA_MYSELF["accountId"] = me.get("accountId") or None
    except Exception as e:
        log(f"jira myself lookup failed: {e}")
    return _JIRA_MYSELF["accountId"]


def _text_to_adf(text):
    """Plain text -> a minimal Atlassian Document Format doc (Jira Cloud's create
    API takes ADF, not plain text/markdown). One paragraph per line; a blank line
    is an empty paragraph, so the operator's line breaks survive the round trip.
    The reverse of adf_plain."""
    lines = str(text or "").split("\n")
    content = []
    for line in lines:
        if line:
            content.append({"type": "paragraph",
                            "content": [{"type": "text", "text": line}]})
        else:
            content.append({"type": "paragraph"})
    return {"type": "doc", "version": 1, "content": content or [{"type": "paragraph"}]}


def jira_create_meta():
    """The New-ticket form's project + label choices for a Jira org: the projects
    the user can see (issue types are fetched per-project by jira_issue_types) and
    a bounded list of existing labels to suggest. Exceptions propagate to the
    staged result."""
    data = jira_get("/rest/api/3/project/search",
                    {"maxResults": CREATE_META_MAX_PROJECTS, "orderBy": "name"})
    projects = [{"key": p.get("key"), "name": p.get("name") or p.get("key")}
                for p in (data.get("values") or []) if p.get("key")]
    labels = []
    try:
        ld = jira_get("/rest/api/3/label", {"maxResults": CREATE_META_MAX_LABELS})
        labels = [l for l in (ld.get("values") or []) if isinstance(l, str)]
    except Exception as e:
        log(f"jira label suggestions fetch failed: {e}")
    return {"projects": projects, "labels": labels, "source": "jira"}


def jira_issue_types(project):
    """The issue types creatable in one Jira project (subtasks excluded — the
    board has no parent to hang them off). [{id, name}]."""
    data = jira_get(
        f"/rest/api/3/issue/createmeta/{urllib.parse.quote(project)}/issuetypes",
        {"maxResults": 100})
    out = []
    for it in (data.get("issueTypes") or data.get("values") or []):
        if it.get("subtask") or not it.get("id"):
            continue
        out.append({"id": str(it.get("id")), "name": it.get("name") or ""})
    return out


def create_jira_issue(project, issue_type, summary, description, labels):
    """Create one Jira issue and return {key, url}. `issue_type` is an issue-type
    id (from jira_issue_types); labels are the array Jira stores verbatim. The
    issue is assigned to the configured user (best-effort) so it lands on their
    board immediately."""
    site_key = normalize_jira_site(JIRA_SITE)
    fields = {
        "project": {"key": project},
        "summary": summary,
        "issuetype": {"id": str(issue_type)},
    }
    if description:
        fields["description"] = _text_to_adf(description)
    if labels:
        fields["labels"] = labels
    acct = _jira_account_id()
    if acct:
        fields["assignee"] = {"id": acct}
    data = jira_post("/rest/api/3/issue", {"fields": fields})
    key = data.get("key")
    if not key:
        raise RuntimeError("Jira returned no issue key")
    return {"key": key, "url": f"https://{site_key}/browse/{key}",
            "assigned": bool(acct)}


# --- Azure DevOps work-item polling --------------------------------------------
# Optional second board source (XERK-43): with a PAT in the env (AZDO_URL +
# AZDO_TOKEN) the agent polls the work items assigned to that PAT's owner and
# reports them in the SAME heartbeat block, ticket shape and detail shape as Jira
# — so the hub, the board, and every downstream client render an Azure DevOps
# org exactly like a Jira one with zero changes on their side. An agent serves
# exactly ONE org (one board's creds), so a host is either a Jira host or an
# Azure host, never both; `board_source()` picks which collector runs.
#
# Self-hosted is the point (AZDO_URL is any base — `https://tfs.company.com/
# DefaultCollection`), and Azure DevOps Services (`https://dev.azure.com/org`)
# is the same REST surface, so both work off the one base URL. Almost entirely
# read-only — WIQL search, work-item GET, the work-item-type states GET — plus
# two operator-driven writes: creating a work item (XERK-137) and a single
# System.State PATCH for a status change (XERK-138).
AZDO_URL = os.environ.get("AZDO_URL", "").strip()
AZDO_TOKEN = os.environ.get("AZDO_TOKEN", "").strip()
# Optional: scope the poll to one project (else org-wide, every project the PAT
# can see). Display-only creds for the board's `user` merge field; the poll uses
# the PAT's own identity via WIQL's @Me, so no email/username is ever required.
AZDO_PROJECT = os.environ.get("AZDO_PROJECT", "").strip()
AZDO_USER = os.environ.get("AZDO_USER", "").strip()
# Self-hosted servers trail cloud on api-version; 6.0 is supported by Azure
# DevOps Server 2019+ and Services alike. Override for an older TFS (4.1/5.0).
AZDO_API_VERSION = os.environ.get("AZDO_API_VERSION", "").strip() or "6.0"
AZDO_MAX_IDS = 300      # most-recently-changed assigned items pulled before bucketing
AZDO_BATCH = 200        # ids per work-items GET (the API's own hard cap)

# Azure exposes a work item's cross-process "state category" (metastate) the same
# way Jira exposes statusCategory — the one facet that unifies orgs with custom
# state names. We read it from the work-item-type states API when reachable and
# fall back to a name map for older/locked-down servers. Both collapse to the
# board's three columns.
_AZDO_META_CATEGORY = {
    "proposed": "todo",
    "inprogress": "inprogress",
    "resolved": "inprogress",
    "completed": "done",
    "removed": "done",
}
_AZDO_STATE_CATEGORY = {
    "new": "todo", "to do": "todo", "approved": "todo", "proposed": "todo",
    "open": "todo", "backlog": "todo", "design": "todo",
    "active": "inprogress", "committed": "inprogress", "in progress": "inprogress",
    "doing": "inprogress", "resolved": "inprogress", "in review": "inprogress",
    "code review": "inprogress", "testing": "inprogress", "ready": "inprogress",
    "done": "done", "closed": "done", "completed": "done", "removed": "done",
}
# (siteKey, project, workItemType) -> {state_name_lower: column}. Populated
# lazily from the states API, so a settled poll costs one cached lookup.
_AZDO_STATE_CACHE = {}

# Work item ids are bare integers, so the JIRA_KEY_RE grammar (PROJECT-123) would
# reject every one. This is the allowlist gate before an id reaches a REST path.
AZDO_KEY_RE = re.compile(r"^[0-9]+$")

AZDO_EMPTY = {"available": False, "configured": False, "source": "azure",
              "site": None, "siteKey": None, "user": None, "fetchedAt": None,
              "error": None, "truncated": False, "tickets": []}


def azure_configured():
    return bool(AZDO_URL and AZDO_TOKEN)


def azure_empty():
    """The off/never-polled Azure block, stamped with whether creds are present —
    the counterpart of jira_empty(), same full-schema contract. A configured org
    carries its locally-derived identity (site/siteKey/orgName) even before a
    successful poll, so a configured-but-unreachable Azure org still shows up on
    the board and org filters instead of vanishing (see jira_empty)."""
    block = dict(AZDO_EMPTY)
    block["configured"] = azure_configured()
    if block["configured"]:
        site = normalize_azure_site(AZDO_URL)
        block["site"] = site
        block["siteKey"] = site
        block["orgName"] = BOARD_ORG_NAME or None
    return block


def azure_base():
    """AZDO_URL -> the API/link base: a scheme-qualified, trailing-slash-free
    org/collection URL. A pasted deep link (`.../_workitems/...`, `.../_apis/...`)
    is trimmed back to the collection root so links and REST paths rebuild cleanly."""
    b = (AZDO_URL or "").strip()
    if not b:
        return ""
    if not re.match(r"^[a-zA-Z][\w.+-]*://", b):
        b = "https://" + b
    b = b.rstrip("/")
    # Trim anything from a pasted board/REST URL back to the collection root.
    b = re.split(r"/_(?:apis|workitems|git|boards|dashboards|wiki|build)\b", b, maxsplit=1)[0]
    return b.rstrip("/")


def azure_git_auth_config():
    """The `git config` that lets plain git (clone/fetch/push) authenticate
    against the configured Azure DevOps org, or None when ADO isn't configured.

    Returns (key, value) for `git config --system`:
      http.<base>.extraHeader = Authorization: Basic <base64(":<PAT>")>
    URL-scoped to the ADO base, so no other host ever receives the header. The
    PAT is the same AZDO_TOKEN the board already uses; Basic with an empty
    username matches azure_req().

    Why extraHeader and not a credential helper: self-hosted TFS / Azure DevOps
    Server often does not issue a Basic challenge git can act on, so a helper is
    never invoked at all (which is why such hosts set `http.proactiveAuth=basic`).
    The image's git is too old for proactiveAuth (Debian bookworm ships git 2.39;
    it landed in 2.46), whereas extraHeader (git 2.4+) forces the header
    proactively on every request and works on the shipped git. This is the
    non-GitHub counterpart to github.com going through `gh auth git-credential`."""
    base = azure_base()
    if not (base and AZDO_TOKEN):
        return None
    token = base64.b64encode(f":{AZDO_TOKEN}".encode()).decode()
    return (f"http.{base}.extraHeader", f"Authorization: Basic {token}")


def normalize_azure_site(url):
    """An Azure DevOps base URL -> the cross-host `siteKey` the hub dedupes on:
    the bare lowercase host (with port) plus the org/collection path, no scheme or
    creds. `https://dev.azure.com/MyOrg/` -> `dev.azure.com/myorg`;
    `https://tfs.co:8080/tfs/DefaultCollection` -> `tfs.co:8080/tfs/defaultcollection`.
    Unlike the Jira siteKey this keeps the path — that org/collection segment IS
    the org identity, and the host alone (`dev.azure.com`) would merge every
    unrelated cloud org into one board."""
    r = (url or "").strip()
    r = re.sub(r"^[a-zA-Z][\w.+-]*://", "", r)   # scheme
    r = re.sub(r"^[^/@]+@", "", r)               # credentials
    r = re.split(r"/_(?:apis|workitems|git|boards|dashboards|wiki|build)\b", r, maxsplit=1)[0]
    return r.strip("/").lower()


def azure_req(path, params, body=None, method=None, content_type="application/json"):
    """One authenticated request against the configured Azure DevOps org. GET
    when `body` is None, else `method` (default POST). A System.State change
    (XERK-138) is the one write: a PATCH carrying a JSON-Patch document, which
    needs `content_type="application/json-patch+json"`. PAT auth is Basic with
    an empty username (`:PAT`), which both Services and Server accept.
    Exceptions propagate — the read callers turn them into the block's `error`,
    the write caller stages them as a per-command error result."""
    q = dict(params or {})
    q.setdefault("api-version", AZDO_API_VERSION)
    url = f"{azure_base()}{path}?{urllib.parse.urlencode(q)}"
    auth = base64.b64encode(f":{AZDO_TOKEN}".encode()).decode()
    headers = {
        "Authorization": f"Basic {auth}",
        "Accept": "application/json",
        "User-Agent": "turma-agent/1.0",
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = content_type
    req = urllib.request.Request(
        url, data=data, headers=headers,
        method=method or ("POST" if body is not None else "GET"))
    return _board_urlopen(req)


def _azure_states(site_key, project, wtype):
    """The ordered [{name, category}] a (project, work-item-type) can be in, from
    the states API, cached. [] when the call fails or is unavailable, so the
    caller falls back to the static name map (category) or offers no status
    options (XERK-138). Best-effort and total."""
    ck = ("states", site_key, project or "", wtype or "")
    if ck in _AZDO_STATE_CACHE:
        return _AZDO_STATE_CACHE[ck]
    out = []
    if project and wtype:
        try:
            data = azure_req(
                f"/{urllib.parse.quote(project)}/_apis/wit/workItemTypes/"
                f"{urllib.parse.quote(wtype)}/states", {})
            for s in data.get("value") or []:
                name = str(s.get("name") or "").strip()
                cat = str(s.get("stateCategory") or "").strip().lower()
                if name and cat in _AZDO_META_CATEGORY:
                    out.append({"name": name, "category": _AZDO_META_CATEGORY[cat]})
        except Exception as e:
            log(f"azure states fetch failed for {project}/{wtype}: {e}")
    _AZDO_STATE_CACHE[ck] = out
    return out


def _azure_state_map(site_key, project, wtype):
    """{state_name_lower: column} for one (project, work-item-type), derived from
    the cached states list. {} when unavailable, so the caller falls back to the
    static name map."""
    return {s["name"].lower(): s["category"]
            for s in _azure_states(site_key, project, wtype)}


def _azure_status_options(site_key, project, wtype, current):
    """The states this work item can be moved TO — every state of its type except
    the one it's already in — in the source-agnostic statusOptions shape. For
    Azure the submit value IS the state name (there is no transition id). [] when
    the states API is unreachable (a locked-down server), so the row stays
    read-only rather than offering a change that can't be validated."""
    cur = str(current or "").strip().lower()
    return [{"id": s["name"], "name": s["name"], "category": s["category"]}
            for s in _azure_states(site_key, project, wtype)
            if s["name"].strip().lower() != cur]


def _azure_category(site_key, project, wtype, state):
    """An Azure work item's `System.State` -> the board's todo/inprogress/done.
    Prefers the per-type state metadata (handles custom processes), then the
    static name map, then `todo` — the same safe default as Jira's unknowns."""
    name = str(state or "").strip().lower()
    live = _azure_state_map(site_key, project, wtype)
    if name in live:
        return live[name]
    return _AZDO_STATE_CATEGORY.get(name, "todo")


def _azure_org_user():
    """The board block's `user` (the merge/union axis): the operator's AZDO_USER
    if given, else the org/collection segment of the site — a stable per-org
    label, which is all mergeSites needs it to be."""
    if AZDO_USER:
        return AZDO_USER
    seg = [s for s in normalize_azure_site(AZDO_URL).split("/") if s]
    return seg[-1] if seg else normalize_azure_site(AZDO_URL)


def _azure_item_url(base, project, wid):
    proj = f"/{urllib.parse.quote(str(project))}" if project else ""
    return f"{base}{proj}/_workitems/edit/{wid}"


def _shape_azure_item(wi, site_key, base):
    """One raw work item (from the batch GET) -> the compact wire ticket the
    board renders — the SAME shape _shape_issue produces for Jira, so the board
    can't tell them apart. Everything optional degrades to None/[]."""
    f = wi.get("fields") or {}
    wid = wi.get("id")
    key = str(wid) if wid is not None else ""
    project = f.get("System.TeamProject")
    wtype = f.get("System.WorkItemType")
    state = f.get("System.State")
    prio = f.get("Microsoft.VSTS.Common.Priority")
    tags = f.get("System.Tags")
    labels = [t.strip() for t in str(tags).split(";") if t.strip()] if tags else []
    parent = f.get("System.Parent")
    return {
        "key": key,
        "url": _azure_item_url(base, project, key),
        "summary": (f.get("System.Title") or "")[:200],
        "status": state,                                         # org state (pill)
        "statusCategory": _azure_category(site_key, project, wtype, state),
        "priority": f"P{prio}" if isinstance(prio, int) else None,
        "type": wtype,
        "project": project,
        "projectName": project,
        "labels": labels[:5],
        "updated": f.get("System.ChangedDate"),
        "created": f.get("System.CreatedDate"),
        "dueDate": f.get("Microsoft.VSTS.Scheduling.DueDate"),
        "parentKey": str(parent) if parent is not None else None,
    }


_AZDO_LIST_FIELDS = [
    "System.Id", "System.Title", "System.State", "System.WorkItemType",
    "System.TeamProject", "System.ChangedDate", "System.CreatedDate",
    "System.Tags", "Microsoft.VSTS.Common.Priority", "System.Parent",
    "Microsoft.VSTS.Scheduling.DueDate",
]


def fetch_azure_items(ids, site_key, base):
    """Batch-GET work items by id (chunked to the API's 200 cap), shaped. Missing
    ids are omitted (errorPolicy) rather than failing the whole batch."""
    out = []
    for i in range(0, len(ids), AZDO_BATCH):
        chunk = ids[i:i + AZDO_BATCH]
        data = azure_req("/_apis/wit/workitems", {
            "ids": ",".join(str(x) for x in chunk),
            "fields": ",".join(_AZDO_LIST_FIELDS),
            "errorPolicy": "omit",
        })
        for wi in data.get("value") or []:
            if isinstance(wi, dict) and wi.get("id") is not None:
                out.append(_shape_azure_item(wi, site_key, base))
    return out


def collect_azure():
    """The heartbeat's board block, Azure edition: the PAT owner's assigned work
    items, bucketed into the same active + recently-done windows as collect_jira
    and returned in the identical block shape (source:"azure"). One WIQL search
    for the ids, then batched detail GETs; @Me resolves the assignee, so no
    username is needed."""
    if not azure_configured():
        return azure_empty()
    site_key = normalize_azure_site(AZDO_URL)
    base = azure_base()
    where = ["[System.AssignedTo] = @Me"]
    if AZDO_PROJECT:
        where.append(f"[System.TeamProject] = '{AZDO_PROJECT.replace(chr(39), chr(39) * 2)}'")
    wiql = ("SELECT [System.Id] FROM WorkItems WHERE " + " AND ".join(where) +
            " ORDER BY [System.ChangedDate] DESC")
    res = azure_req("/_apis/wit/wiql", {}, body={"query": wiql})
    ids = [w.get("id") for w in (res.get("workItems") or []) if w.get("id") is not None]
    truncated = len(ids) > AZDO_MAX_IDS
    tickets = fetch_azure_items(ids[:AZDO_MAX_IDS], site_key, base)

    # Same two-window model as Jira: all active work, plus a bounded tail of
    # recently-changed done items so the Done column is populated without growing
    # forever. WIQL already sorted by ChangedDate desc, so slicing preserves it.
    cutoff = (datetime.datetime.now(datetime.timezone.utc)
              - datetime.timedelta(days=JIRA_DONE_DAYS)).isoformat()
    active = [t for t in tickets if t["statusCategory"] != "done"][:JIRA_MAX_ACTIVE]
    done = [t for t in tickets if t["statusCategory"] == "done"
            and str(t.get("updated") or "") >= cutoff][:JIRA_MAX_DONE]
    if len(active) < len([t for t in tickets if t["statusCategory"] != "done"]):
        truncated = True
    return {
        "available": True,
        "configured": True,
        "source": "azure",
        "site": site_key,
        "siteKey": site_key,
        "user": _azure_org_user(),
        "fetchedAt": now_iso(),
        "error": None,
        "truncated": truncated,
        "tickets": active + done,
    }


# --- Azure DevOps work-item detail (on-demand) ---------------------------------
# Azure returns description and comment bodies as HTML (not ADF, not markdown),
# so the ADF flattener's counterpart here is a small HTML->text pass, keeping the
# same (text, truncated) contract adf_plain has.

class _HTMLTextExtractor(HTMLParser):
    """Flattens HTML to plain text: block tags become newlines, <li> a bullet,
    <a href> keeps its target, and entities are unescaped. Best-effort, total."""
    _BLOCK = {"p", "div", "br", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
              "ul", "ol", "table", "blockquote", "section", "pre"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self._href = None

    def handle_starttag(self, tag, attrs):
        if tag == "li":
            self.parts.append("\n- ")
        elif tag in self._BLOCK:
            self.parts.append("\n")
        elif tag == "a":
            self._href = dict(attrs).get("href")

    def handle_endtag(self, tag):
        if tag == "a" and self._href:
            if self._href not in "".join(self.parts[-3:]):
                self.parts.append(f" ({self._href})")
            self._href = None
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        self.parts.append(data)

    def text(self):
        return "".join(self.parts)


def azure_html_to_text(raw):
    """HTML (or a plain string) -> plain text. Never raises on malformed markup."""
    if not raw:
        return ""
    if not isinstance(raw, str):
        return str(raw)
    try:
        p = _HTMLTextExtractor()
        p.feed(raw)
        p.close()
        return p.text()
    except Exception:
        # A last-ditch tag strip so unparseable markup still degrades to its text.
        return html.unescape(re.sub(r"<[^>]+>", " ", raw))


def azure_plain(raw, limit):
    """azure_html_to_text normalized and clipped: (text, truncated) — the exact
    contract adf_plain gives the Jira detail shape."""
    text = re.sub(r"[ \t]+\n", "\n", azure_html_to_text(raw))
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) <= limit:
        return text, False
    return text[:limit].rstrip(), True


def _shape_azure_detail(wi, comments_data, site_key, base):
    """A GET work item ($expand=all) + its comments -> the same detail shape
    _shape_issue_detail produces for Jira."""
    detail = _shape_azure_item(wi, site_key, base)
    f = wi.get("fields") or {}

    def person(field):
        v = f.get(field)
        return v.get("displayName") if isinstance(v, dict) else (v or None)

    desc, desc_trunc = azure_plain(f.get("System.Description"), JIRA_DESC_MAX_CHARS)
    detail["description"] = desc
    detail["descriptionTruncated"] = desc_trunc
    detail["reporter"] = person("System.CreatedBy")
    detail["assignee"] = person("System.AssignedTo")
    detail["resolution"] = f.get("System.Reason") or None
    tags = f.get("System.Tags")
    detail["labels"] = ([t.strip() for t in str(tags).split(";") if t.strip()]
                        [:JIRA_DETAIL_LABELS_MAX] if tags else [])
    detail["parentSummary"] = None   # would need a second fetch; parentKey suffices

    raw = (comments_data or {}).get("comments") or []
    raw = [c for c in raw if isinstance(c, dict)]
    raw.sort(key=lambda c: str(c.get("createdDate") or ""))   # oldest-first, like Jira
    comments = []
    for c in raw[-JIRA_COMMENT_MAX:]:
        body, trunc = azure_plain(c.get("text"), JIRA_COMMENT_MAX_CHARS)
        author = c.get("createdBy")
        comments.append({
            "id": c.get("id"),
            "author": author.get("displayName") if isinstance(author, dict) else None,
            "created": c.get("createdDate"),
            "updated": c.get("modifiedDate"),
            "body": body,
            "truncated": trunc,
        })
    detail["comments"] = comments
    total = (comments_data or {}).get("totalCount")
    detail["commentTotal"] = total if isinstance(total, int) else len(comments)
    # Azure keeps attachments as work-item RELATIONS rather than a field: the
    # `AttachedFile` ones ($expand=all brings them back), whose `url` is the
    # attachments endpoint and whose name/size live under `attributes`.
    rel = [r for r in (wi.get("relations") or [])
           if isinstance(r, dict) and r.get("rel") == "AttachedFile"]
    detail["attachments"], detail["attachmentTotal"] = _shape_attachments(
        rel,
        name_of=lambda r: (r.get("attributes") or {}).get("name"),
        size_of=lambda r: (r.get("attributes") or {}).get("resourceSize"),
        url_of=lambda r: r.get("url"))
    detail["fetchedAt"] = now_iso()
    return detail


def fetch_azure_issue(key):
    """One work item's full detail. Comments ride a separate endpoint (and a
    preview api-version); a comments failure degrades to no comments rather than
    losing the whole detail. Exceptions on the item itself propagate."""
    site_key = normalize_azure_site(AZDO_URL)
    base = azure_base()
    wi = azure_req(f"/_apis/wit/workitems/{urllib.parse.quote(key)}",
                   {"$expand": "all"})
    f = wi.get("fields") or {}
    project = f.get("System.TeamProject")
    comments_data = {}
    if project:
        try:
            comments_data = azure_req(
                f"/{urllib.parse.quote(project)}/_apis/wit/workItems/"
                f"{urllib.parse.quote(key)}/comments",
                {"api-version": f"{AZDO_API_VERSION}-preview.3"})
        except Exception as e:
            log(f"azure comments fetch failed for {key}: {e}")
    detail = _shape_azure_detail(wi, comments_data, site_key, base)
    detail["statusOptions"] = _azure_status_options(
        site_key, project, f.get("System.WorkItemType"), f.get("System.State"))
    return detail


# --- Azure DevOps work-item creation (XERK-137) --------------------------------
# The Azure counterpart of the Jira create path. Work-item create is a JSON-Patch
# POST (application/json-patch+json) — a different content type than azure_req's
# plain-JSON search/GET — with the work-item TYPE in the URL (`.../workitems/$Bug`).
# "Labels" map to System.Tags (a `;`-joined string, not an array), and self-assign
# walks an identity ladder (_azure_identities) so the new item lands on the board
# (which filters by @Me).
_AZDO_ME = {"names": [], "tried": False}
_AZDO_MINE = {"names": [], "tried": False}
_AZDO_FIELD_CACHE = {}

# Where a work-item type keeps its long description. Most types use
# System.Description, but the Agile and Scrum process templates give Bug
# Microsoft.VSTS.TCM.ReproSteps INSTEAD, and no System.Description at all — and a
# patch naming a field the type doesn't have is rejected outright, so the whole
# create fails rather than the description being dropped. Ordered by preference;
# the first one the type actually has wins.
AZDO_DESCRIPTION_FIELDS = ("System.Description", "Microsoft.VSTS.TCM.ReproSteps")


def _azure_type_fields(site_key, project, wtype):
    """The field reference names a (project, work-item type) accepts, cached like
    _azure_states. An empty set means "couldn't ask" (the lookup failed, or the
    args were incomplete), which callers read as unknown rather than as none."""
    ck = ("fields", site_key, project or "", wtype or "")
    if ck in _AZDO_FIELD_CACHE:
        return _AZDO_FIELD_CACHE[ck]
    out = set()
    if project and wtype:
        try:
            data = azure_req(
                f"/{urllib.parse.quote(project)}/_apis/wit/workItemTypes/"
                f"{urllib.parse.quote(wtype)}/fields", {})
            for f in data.get("value") or []:
                ref = str(f.get("referenceName") or "").strip()
                if ref:
                    out.add(ref)
        except Exception as e:
            log(f"azure field list failed for {project}/{wtype}: {e}")
    _AZDO_FIELD_CACHE[ck] = out
    return out


def _azure_description_field(site_key, project, wtype):
    """The field to put a new work item's description in, or None to send none.

    Falls back to System.Description when the field list is unknown — the old
    unconditional behaviour, and right for every type that has it. Returning
    None only happens when the type demonstrably has neither field, where
    dropping the text beats losing the ticket to a 400."""
    fields = _azure_type_fields(site_key, project, wtype)
    if not fields:
        return AZDO_DESCRIPTION_FIELDS[0]
    for ref in AZDO_DESCRIPTION_FIELDS:
        if ref in fields:
            return ref
    return None


def _azure_identity_strings(value):
    """Every way to spell ONE identity value, best first.

    A modern api-version returns an identity as an object; an older one returns
    a bare string, which is then already the exact text that server stores."""
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if not isinstance(value, dict):
        return []
    disp = str(value.get("displayName") or "").strip()
    uniq = str(value.get("uniqueName") or "").strip()
    out = []
    if uniq:
        out.append(uniq)
    if disp and uniq:
        # The classic TFS identity-field spelling, and the one an on-prem
        # collection often insists on where a bare email won't resolve.
        out.append(f"{disp} <{uniq}>")
    for extra in (value.get("id"), disp):
        if str(extra or "").strip():
            out.append(str(extra).strip())
    return out


def _azure_mine_identities():
    """Identity spellings harvested from work items ALREADY assigned to the PAT
    owner, cached. [] when there are none or the lookup fails.

    This is the only source that cannot be wrong about spelling: the same WIQL
    `@Me` the board polls with names items this server itself decided belong to
    this user, so their `System.AssignedTo` is a value it has already resolved.
    Every other candidate is a guess at what it will accept.

    An operator with no assigned work item yet gets nothing here and falls
    through to the guesses — and the first item that lands on their board (by
    any route) teaches this host the spelling for every create after it."""
    if _AZDO_MINE["tried"]:
        return list(_AZDO_MINE["names"])
    out = []
    try:
        where = ["[System.AssignedTo] = @Me"]
        if AZDO_PROJECT:
            where.append("[System.TeamProject] = '"
                         f"{AZDO_PROJECT.replace(chr(39), chr(39) * 2)}'")
        res = azure_req("/_apis/wit/wiql", {"$top": 1}, body={
            "query": "SELECT [System.Id] FROM WorkItems WHERE "
                     + " AND ".join(where)
                     + " ORDER BY [System.ChangedDate] DESC"})
        ids = [w.get("id") for w in (res.get("workItems") or [])
               if w.get("id") is not None][:1]
        if ids:
            data = azure_req("/_apis/wit/workitems", {
                "ids": ",".join(str(i) for i in ids),
                "fields": "System.AssignedTo", "errorPolicy": "omit"})
            for wi in data.get("value") or []:
                if isinstance(wi, dict):
                    out.extend(_azure_identity_strings(
                        (wi.get("fields") or {}).get("System.AssignedTo")))
        # Cache only a SUCCESSFUL probe (as _AZDO_ME does), but cache an empty
        # result too: "this user has no assigned items" is an answer.
        _AZDO_MINE["names"] = out
        _AZDO_MINE["tried"] = True
    except Exception as e:
        log(f"azure assigned-item identity lookup failed: {e}")
    return out


def _azure_identities():
    """Every identity string worth trying as `System.AssignedTo`, best first.

    There is no single spelling that works everywhere: Services wants an email,
    a self-hosted collection usually wants `DOMAIN\\user` or the classic
    `Display Name <unique>`, and some accept only the display name or the guid.
    Rather than guess one and lose the assignment when it's the wrong one, offer
    them in order and let the create fall through (`create_azure_issue`).

    `AZDO_USER` leads because it is the operator saying so explicitly — but it
    is documented as (and `_azure_org_user` uses it as) the board's display
    LABEL, so it is frequently NOT an assignable identity. The harvested
    spellings come next because they are the server's OWN, and only then the
    connection-data guesses."""
    out = []
    if AZDO_USER:
        out.append(AZDO_USER)
    out.extend(_azure_mine_identities())
    if not _AZDO_ME["tried"]:
        try:
            data = azure_req("/_apis/connectionData", {})
            au = data.get("authenticatedUser") or {}
            props = (au.get("properties") or {}).get("Account") or {}
            disp = au.get("providerDisplayName") or au.get("customDisplayName")
            names = [str(v).strip() for v in (
                props.get("$value"), au.get("uniqueName"), au.get("mailAddress"),
                disp, au.get("id"),
            ) if str(v or "").strip()]
            # …plus the same `Display Name <unique>` pairing the harvest offers,
            # which is the spelling a classic on-prem collection resolves.
            for uniq in (props.get("$value"), au.get("uniqueName"),
                         au.get("mailAddress")):
                if str(disp or "").strip() and str(uniq or "").strip():
                    names.append(f"{str(disp).strip()} <{str(uniq).strip()}>")
            _AZDO_ME["names"] = names
            # Cache only a SUCCESSFUL probe: marking it tried up-front turns one
            # transient failure into a process that never self-assigns again.
            _AZDO_ME["tried"] = True
        except Exception as e:
            log(f"azure connection-data lookup failed: {e}")
    out.extend(_AZDO_ME["names"])
    seen, ordered = set(), []
    for name in out:
        if name not in seen:
            seen.add(name)
            ordered.append(name)
    return ordered


def azure_create_workitem(project, wtype, ops):
    """POST a JSON-Patch work-item create and return the raw work item. `ops` is
    the /fields patch list; the type rides the URL as `$<type>`. Separate from
    azure_req because create requires the json-patch content type."""
    q = {"api-version": AZDO_API_VERSION}
    path = (f"/{urllib.parse.quote(project)}/_apis/wit/workitems/"
            f"${urllib.parse.quote(wtype)}")
    url = f"{azure_base()}{path}?{urllib.parse.urlencode(q)}"
    auth = base64.b64encode(f":{AZDO_TOKEN}".encode()).decode()
    req = urllib.request.Request(url, data=json.dumps(ops).encode(), headers={
        "Authorization": f"Basic {auth}",
        "Accept": "application/json",
        "Content-Type": "application/json-patch+json",
        "User-Agent": "turma-agent/1.0",
    }, method="POST")
    return _board_urlopen(req)


def azure_create_meta():
    """The New-ticket form's project + tag choices for an Azure org: the projects
    the PAT can see (work-item types are fetched per-project by azure_workitem_types)
    plus a bounded list of existing tags to suggest."""
    data = azure_req("/_apis/projects", {"$top": CREATE_META_MAX_PROJECTS})
    projects = [{"key": p.get("name"), "name": p.get("name")}
                for p in (data.get("value") or []) if p.get("name")]
    tags = []
    try:
        # Org-wide tags endpoint (preview); a failure just means no suggestions.
        td = azure_req("/_apis/wit/tags",
                       {"api-version": f"{AZDO_API_VERSION}-preview.1"})
        tags = [t.get("name") for t in (td.get("value") or []) if t.get("name")]
    except Exception as e:
        log(f"azure tag suggestions fetch failed: {e}")
    return {"projects": projects, "labels": tags[:CREATE_META_MAX_LABELS],
            "source": "azure"}


def azure_workitem_types(project):
    """The creatable work-item types in one Azure project (hidden/disabled ones
    excluded). [{id, name}] — id == name for Azure, so the wire shape matches
    Jira's issue-type list."""
    data = azure_req(f"/{urllib.parse.quote(project)}/_apis/wit/workitemtypes", {})
    out = []
    for wt in (data.get("value") or []):
        name = wt.get("name")
        if not name or wt.get("isDisabled"):
            continue
        out.append({"id": name, "name": name})
    return out


def create_azure_issue(project, wtype, title, description, tags):
    """Create one Azure work item and return {key, url}. `wtype` is the work-item
    type name; `tags` become System.Tags. Self-assigns to the PAT owner
    (best-effort) so the item lands on the board."""
    site_key = normalize_azure_site(AZDO_URL)
    base = azure_base()
    ops = [{"op": "add", "path": "/fields/System.Title", "value": title}]
    if description:
        field = _azure_description_field(site_key, project, wtype)
        if field:
            # The description field is HTML; escape the plain text, keep breaks.
            body_html = html.escape(str(description)).replace("\n", "<br>")
            ops.append({"op": "add", "path": f"/fields/{field}",
                        "value": body_html})
        else:
            log(f"azure type {wtype!r} has no description field; "
                "creating without one")
    if tags:
        ops.append({"op": "add", "path": "/fields/System.Tags",
                    "value": "; ".join(tags)})
    # Try each candidate identity, then unassigned. Self-assignment is
    # best-effort BY CONTRACT, so it must never cost the operator the ticket —
    # but an item created unassigned falls outside the board's own @Me filter,
    # so silently giving up on the first rejection is nearly as bad. Only a
    # REFUSED write (4xx) is retried: after a timeout the create may have
    # landed, and re-sending would duplicate it.
    data, assigned, first, refused = None, None, None, None
    candidates = _azure_identities()
    for me in candidates + [None]:
        attempt = list(ops)
        if me:
            attempt.append({"op": "add", "path": "/fields/System.AssignedTo",
                            "value": me})
        try:
            data = azure_create_workitem(project, wtype, attempt)
            assigned = me
            break
        except Exception as e:
            # Keep the FIRST error: it describes the real problem, where a later
            # one only says the identity after it didn't work either.
            first = first if first is not None else e
            if not _write_was_refused(e):
                raise first from None
            if me is not None:
                refused = refused if refused is not None else e
                log(f"azure create rejected assignee {me!r} ({e})")
    if data is None:
        raise first
    assign_error = None
    if assigned is None:
        # Say what was tried and what the server said. An unassigned item is
        # invisible on the board, so this line (and the warning built from it)
        # is the operator's only lead on which spelling their server wants.
        tried = ", ".join(repr(c) for c in candidates) or "no candidate identity"
        reason = str(refused or "").strip().splitlines()
        assign_error = (
            f"the server refused every identity this host could find "
            f"({reason[0][:BOARD_ERROR_MAX_CHARS]})" if reason else
            "this host could not work out your identity")
        log(f"azure work item in {project} created UNASSIGNED — tried {tried}")
    wid = data.get("id")
    if wid is None:
        raise RuntimeError("Azure returned no work-item id")
    return {"key": str(wid), "url": _azure_item_url(base, project, wid),
            "assigned": bool(assigned), "assignError": assign_error}


# --- Board source dispatch -----------------------------------------------------
# The board is source-agnostic downstream: the hub, board.js and every client
# read one `jira` block per agent and never branch on where its tickets came
# from. These helpers pick the collector for the one source THIS host is
# configured for, so a host is a Jira host or an Azure host but the wire contract
# is identical. Azure takes precedence if both are somehow set (one org per host).

# The board chip's org label is DERIVED from the siteKey by every client
# (board.js `orgName`), which reads well for Jira Cloud ("myorg.atlassian.net" ->
# "myorg") and for Azure DevOps Services ("dev.azure.com/myorg" -> "myorg"), but
# not for a self-hosted collection: "tfs.company.com/tfs/DefaultCollection" is
# named after its COLLECTION ("defaultcollection"), which is a deployment detail,
# not the org. So the operator can override the label from the agent's env.
#
# Presentational ONLY, and deliberately not part of the siteKey: the siteKey is
# what the hub keys, merges and routes on, and what /api/jira/<siteKey>/... paths
# and the hub's own ticket-agent/auto-start ledgers are stored under. Renaming it
# would orphan every one of those; renaming the LABEL costs nothing.
ORG_NAME_MAX_CHARS = 40


def clean_org_name(raw):
    """BOARD_ORG_NAME as the board may render it: first line, whitespace
    collapsed, capped. "" for anything blank, so an unset or whitespace-only
    override falls straight back to the client's derived name."""
    text = str(raw or "").strip()
    first = text.splitlines()[0] if text else ""
    return re.sub(r"\s+", " ", first).strip()[:ORG_NAME_MAX_CHARS]


BOARD_ORG_NAME = clean_org_name(os.environ.get("BOARD_ORG_NAME", ""))


def board_source():
    """"azure" | "jira" | None — which ticket source this host polls."""
    if azure_configured():
        return "azure"
    if jira_configured():
        return "jira"
    return None


def board_configured():
    """Whether ANY ticket source is configured (the gate that used to be
    jira_configured() alone)."""
    return jira_configured() or azure_configured()


def collect_board():
    """The heartbeat board block from whichever source is configured: Azure when
    its creds are set, else Jira. collect_jira() itself returns the empty block
    when Jira is unconfigured too, so it's the safe default (and refresh_jira only
    runs at all behind a board_configured() gate).

    The operator's `orgName` override rides here rather than in either collector
    because it is presentational and source-agnostic — the siteKey a board is
    keyed, merged and routed on is untouched."""
    block = collect_azure() if azure_configured() else collect_jira()
    block["orgName"] = BOARD_ORG_NAME or None
    return block


def _board_error_summary(e):
    """A short, human-readable summary of a board-poll failure for the block's
    `error` field (shown on the dashboard's board). An upstream 5xx (e.g. the
    Cloudflare-family HTTP 530 a self-hosted org's front returns when its origin
    is unreachable) or a connection failure means the tracker was momentarily
    unreachable — NOT a bug in the request — so say that plainly rather than
    surfacing a cryptic `HTTP Error 530: <none>`. Auth and rate-limit failures
    get their own hint; anything unrecognised falls back to the raw text. The
    raw exception is still logged verbatim for diagnosis; only this UI-facing
    string is cleaned up."""
    src = "Azure DevOps" if board_source() == "azure" else "Jira"
    if isinstance(e, urllib.error.HTTPError):
        code = e.code
        if code >= 500:
            return f"{src} temporarily unreachable (HTTP {code})"
        if code == 429:
            return f"{src} rate-limited the request (HTTP 429)"
        if code in (401, 403):
            return f"{src} rejected the credentials (HTTP {code})"
        reason = str(getattr(e, "reason", "") or "").strip()
        return f"{src} request failed: HTTP {code}" + (f" {reason}" if reason else "")
    if isinstance(e, (urllib.error.URLError, TimeoutError)):
        reason = getattr(e, "reason", None)
        detail = str(reason if reason is not None else e).strip()
        return f"{src} unreachable" + (f" ({detail})" if detail else "")
    return str(e)[:200]


def board_empty():
    """The off/never-polled block for the configured source (or a Jira-shaped
    empty when nothing is configured — the historical default)."""
    if azure_configured():
        return azure_empty()
    return jira_empty()


def valid_issue_key(key):
    """The allowlist gate for an issue key reaching a REST path, source-aware:
    Jira's PROJECT-123 grammar, or Azure's bare integer work-item id."""
    k = (key or "").strip()
    if board_source() == "azure":
        return bool(AZDO_KEY_RE.match(k))
    return bool(JIRA_KEY_RE.match(k))


def fetch_board_issue(key):
    """One ticket's full detail from the configured source."""
    if azure_configured():
        return fetch_azure_issue(key)
    return fetch_jira_issue(key)


def board_site_key():
    """This host's siteKey for the configured source (the ledger/routing key)."""
    if azure_configured():
        return normalize_azure_site(AZDO_URL)
    return normalize_jira_site(JIRA_SITE)


def board_status_options(key):
    """The statuses `key` can be moved to right now, from the configured source
    (Jira transitions / Azure states). The allowlist a status change is checked
    against at write time — re-read fresh, never trusted from the client."""
    if azure_configured():
        wi = azure_req(f"/_apis/wit/workitems/{urllib.parse.quote(key)}",
                       {"fields": "System.TeamProject,System.WorkItemType,System.State"})
        f = wi.get("fields") or {}
        return _azure_status_options(
            normalize_azure_site(AZDO_URL), f.get("System.TeamProject"),
            f.get("System.WorkItemType"), f.get("System.State"))
    return _jira_status_options(key)


# Board columns a status change can target by name (XERK-141, drag-and-drop). A
# label for each so a "nothing moves it there" refusal reads in the operator's
# own board vocabulary.
_COLUMN_LABEL = {"todo": "To Do", "inprogress": "In Progress",
                 "review": "In Review", "done": "Done"}
# The In Review column is carved out of `inprogress` by the status NAME, matched
# on word boundaries — mirrors board.js REVIEW_STATUS_RE / isReviewStatus exactly.
_REVIEW_STATUS_RE = re.compile(r"\b(review|reviewing|testing|test|qa)\b", re.I)


def _board_column(name, category):
    """A status's board COLUMN — todo/inprogress/review/done — from its wire
    category (todo/inprogress/done) plus its name. Mirrors board.js categoryOf:
    an `inprogress` status whose name reads as review/testing/QA lands in the
    review column; everything else keeps its category, unknowns fall to todo.
    This is how a drop onto a column is resolved to a status to move to."""
    base = category if category in ("inprogress", "done") else "todo"
    if base == "inprogress" and _REVIEW_STATUS_RE.search(str(name or "")):
        return "review"
    return base


def _status_option_for_column(options, column):
    """The first available status option that lands in board `column`
    (todo/inprogress/review/done), or None. First-match: a workflow with two
    transitions into one column is rare, and the drop names the column, not the
    exact status — the operator can still pick a specific one from the panel."""
    target = str(column or "").strip().lower()
    return next((o for o in options or []
                 if _board_column(o.get("name"), o.get("category")) == target), None)


def apply_board_status(key, value):
    """Push a status change to the configured board (XERK-138). Jira: POST the
    chosen transition id. Azure: PATCH System.State to the chosen state name via
    a JSON-Patch document. Exceptions propagate to set_board_status, which stages
    them as the command's error result."""
    if azure_configured():
        azure_req(
            f"/_apis/wit/workitems/{urllib.parse.quote(key)}", {},
            body=[{"op": "add", "path": "/fields/System.State", "value": value}],
            method="PATCH", content_type="application/json-patch+json")
    else:
        jira_req(f"/rest/api/3/issue/{urllib.parse.quote(key)}/transitions", {},
                 body={"transition": {"id": value}})


def board_create_meta():
    """The New-ticket form's project + label choices from the configured source
    (XERK-137)."""
    if azure_configured():
        return azure_create_meta()
    return jira_create_meta()


def board_issue_types(project):
    """The creatable issue/work-item types in one project, from the configured
    source. [{id, name}]."""
    if azure_configured():
        return azure_workitem_types(project)
    return jira_issue_types(project)


def create_board_issue(project, issue_type, summary, description, labels):
    """Create one ticket in the configured source and return {key, url}."""
    if azure_configured():
        return create_azure_issue(project, issue_type, summary, description, labels)
    return create_jira_issue(project, issue_type, summary, description, labels)


# --- Jira ticket sessions ------------------------------------------------------
# Spawn a session to WORK a ticket: the board's per-card start button. Like the
# triage above, this runs agent-side because this host is the only place the
# three inputs meet — the Jira creds (hence the ticket's full text), the triage
# ledger (hence which repo it belongs in), and the repos themselves.

TICKET_PROMPT_COMMENTS = 10          # newest comments inlined into the prompt
TICKET_BRANCH_MAX_SUFFIX = 200       # -1..-200 before we give up naming it


def next_ticket_branch(issue_key, taken):
    """The branch name for a new session on `issue_key`: the bare ticket key, or
    the first free key-1/key-2/... when it's already taken. None when even the
    suffixes are exhausted (the caller then just lets the agent name its own —
    an absurd number of branches for one ticket is not worth failing a spawn)."""
    taken = {str(t).strip() for t in (taken or []) if str(t or "").strip()}
    if issue_key not in taken:
        return issue_key
    for n in range(1, TICKET_BRANCH_MAX_SUFFIX + 1):
        cand = f"{issue_key}-{n}"
        if cand not in taken:
            return cand
    return None


def ticket_branch_base(key, detail):
    """The branch base a ticket session cuts from — kept human-scannable per the
    branch-naming policy. A Jira key (PROJECT-123) already reads that way and is
    used as-is. An Azure work-item id is a bare integer, so we prefix it with the
    project for the same at-a-glance mapping (`MyProject-1234`), falling back to
    `wi-<id>` when the project is unknown."""
    if board_source() != "azure":
        return key
    project = (detail or {}).get("project") or (detail or {}).get("projectName")
    if project:
        slug = re.sub(r"-{2,}", "-", re.sub(r"[^A-Za-z0-9._]+", "-", str(project))).strip("-.")
        if slug:
            return f"{slug}-{key}"
    return f"wi-{key}"


def branch_names(repo_path):
    """Every branch name a new branch here could collide with: local heads, plus
    remote-tracking branches reduced to the name they'd have locally (a pushed
    `origin/PROJ-123` means that ticket already has a branch, even on a host that
    has never checked it out). origin/HEAD is skipped — it's a symbolic alias for
    the default branch, not a name anyone would take."""
    out = run(["git", "-C", repo_path, "for-each-ref", "--format=%(refname)",
               "refs/heads", "refs/remotes"])
    names = set()
    for line in out.splitlines():
        ref = line.strip()
        if ref.startswith("refs/heads/"):
            names.add(ref[len("refs/heads/"):])
        elif ref.startswith("refs/remotes/"):
            rest = ref[len("refs/remotes/"):]
            # "<remote>/<branch>" -> "<branch>"; a bare "refs/remotes/<remote>"
            # has no branch part to take.
            if "/" in rest:
                name = rest.split("/", 1)[1]
                if name != "HEAD":
                    names.add(name)
    return names


def _ticket_attachment_lines(detail, attachments):
    """The prompt's `## Attachments` section, or [] when the ticket has none.

    `attachments` is _store_ticket_attachments' (paths, failed_names): the files
    that landed on disk, and the ones that didn't. Like a chat attachment, a file
    is NAMED rather than dropped when it fails — a screenshot the ticket is built
    around is exactly what the session needs to know it is missing. `None` means
    no download was attempted at all, so the files are named without paths.

    Nothing is inlined; the session reads them with its ordinary tools, and an
    image is a Read away because they land under the pre-approved uploads tree."""
    d = detail or {}
    have = [a for a in d.get("attachments") or [] if isinstance(a, dict)]
    if not have:
        return []
    # What the ticket really carries, which is not always what we shaped: the
    # detail keeps only the newest TICKET_ATTACH_MAX. Saying so is the point —
    # a count that quietly means "the ones we kept" is a lie the session can't
    # check. Older agents/details carry no total; then what we have IS all of it.
    total = d.get("attachmentTotal")
    total = total if isinstance(total, int) and total >= len(have) else len(have)
    lines = ["", "## Attachments", ""]
    lines.append(f"This ticket has {total} attached file"
                 f"{'' if total == 1 else 's'}.")
    if attachments is None:
        lines.append("They are NOT on this machine — open them from the ticket"
                     " URL above if you need them:")
        lines += [f"- {a.get('name')}" for a in have]
    else:
        paths, failed = attachments
        if paths:
            lines.append(
                "%s downloaded to this machine; read %s from disk (images"
                " included):" % ("One is" if len(paths) == 1 else f"{len(paths)} are",
                                 "it" if len(paths) == 1 else "them"))
            lines += [f"- {p}" for p in paths]
        for name in failed or []:
            lines.append(f"- {name} — could not be downloaded; open it from the"
                         " ticket URL above.")
    dropped = total - len(have)
    if dropped > 0:
        lines.append(f"\n_The {dropped} oldest are not listed here — they are in"
                     " the ticket._")
    return lines


def build_ticket_prompt(detail, attachments=None):
    """A fetched ticket -> the initial task prompt for its session: everything the
    agent would otherwise have to go and read, inlined.

    The session has no board creds of its own (they live in the manager's env, not
    the worktree), so this text is all it will ever see of the ticket — hence the
    header saying plainly that it's a spawn-time snapshot and pointing at the URL
    for the live copy, and hence the ticket's own attachments being fetched FOR it
    (XERK-242) rather than left behind a login it doesn't have. Caps mirror the
    detail fetch's own (description and comment bodies are already clipped
    agent-side by the shaping)."""
    d = detail or {}
    key = d.get("key") or ""
    summary = (d.get("summary") or "").strip()
    # Name the source in the prompt so the session knows what it's working, and
    # phrase an Azure work-item id as `#1234` the way that tracker does.
    if board_source() == "azure":
        source_name, noun, ref = "Azure DevOps", "work item", (f"#{key}" if key else "")
    else:
        source_name, noun, ref = "Jira", "ticket", key
    head = f"Work {source_name} {noun} {ref}." if ref else f"Work the {source_name} {noun} below."
    out = [
        head + f" Its full text, as fetched from {source_name} when this session"
        " spawned, follows. That is a snapshot — if something looks stale or"
        " contradictory, the ticket's own URL below is the live copy.",
        "",
        f"# {ref}: {summary}".strip(": ") if (ref or summary) else "# Ticket",
    ]
    project = d.get("projectName") or d.get("project")
    if (project and d.get("projectName") and d.get("project")
            and d["projectName"] != d["project"]):
        project = f"{d['projectName']} ({d['project']})"
    parent = d.get("parentKey")
    if parent and d.get("parentSummary"):
        parent = f"{parent} — {d['parentSummary']}"
    labels = d.get("labels")
    fields = [
        ("URL", d.get("url")),
        ("Status", d.get("status")),
        ("Type", d.get("type")),
        ("Priority", d.get("priority")),
        ("Assignee", d.get("assignee")),
        ("Reporter", d.get("reporter")),
        ("Project", project),
        ("Parent", parent),
        ("Due", d.get("dueDate")),
        ("Labels", ", ".join(labels) if isinstance(labels, list) and labels else None),
    ]
    rows = [f"- {label}: {value}" for label, value in fields if value]
    if rows:
        out += ["", *rows]

    desc = (d.get("description") or "").strip()
    out += ["", "## Description", ""]
    out.append(desc or "_No description._")
    if d.get("descriptionTruncated"):
        out.append(f"\n_(description truncated — the rest is in {source_name})_")

    comments = [c for c in (d.get("comments") or []) if isinstance(c, dict)]
    shown = comments[-TICKET_PROMPT_COMMENTS:]
    total = d.get("commentTotal")
    total = total if isinstance(total, int) else len(comments)
    out += ["", f"## Comments ({total})", ""]
    if not shown:
        out.append("_No comments._")
    else:
        dropped = total - len(shown)
        if dropped > 0:
            out.append(f"_Showing the {len(shown)} newest; {dropped} older are in {source_name}._\n")
        for c in shown:
            who = c.get("author") or "Unknown"
            when = c.get("created") or ""
            body = (c.get("body") or "").strip() or "_(empty)_"
            out.append(f"**{who}**{f' — {when}' if when else ''}\n{body}\n")

    out += _ticket_attachment_lines(d, attachments)

    out += [
        "",
        "Start by working out what this ticket actually asks for, then do it. If"
        " the ticket is ambiguous enough that you'd be guessing at the goal, ask"
        " rather than guess.",
    ]
    return "\n".join(out)


# --- Jira -> repo triage -------------------------------------------------------
# Guess WHICH REPO each assigned ticket's work belongs in, so the board card can
# say where a ticket would be worked. Like the session summaries below, this runs
# on the container's already-authenticated `claude` in headless print mode (Haiku
# by default) — the mounted login, so no external API, key, or cost env — as a
# detached subprocess reaped on later beats.
#
# It runs on the AGENT rather than the hub because this host is the only place
# the three inputs meet: the Jira creds (hence the tickets), the scanned repos in
# REPOS_ROOT, and the `gh` sweep of clonable repos. That colocation is also what
# enforces "same org": only the host holding an org's Jira creds ever classifies
# that org's tickets, so a ticket can only ever be matched to a repo that host can
# actually reach. Candidates are its cloned repos (preferred — see the prompt)
# plus everything its gh login can clone, so an uncloned repo is still selectable.
#
# The model picks from a fixed candidate list and its answer is validated back
# against that list (_parse_triage): a name that isn't a candidate is DROPPED, not
# rendered. Nothing here is trusted into a shell, a path, or a URL — the guess is
# presentational, and the board never acts on it.
#
# Triage is cached in a ledger (~/.turma/jira-repos.json) keyed by site+issue, so
# it runs ONCE per ticket rather than per beat: re-triage only when the ticket's
# own text changes or the candidate repo set does (cloning a repo should let it
# win a ticket it's a better fit for). The candidate fingerprint deliberately
# hashes only repo NAMES — the gh block's `updatedAt` churns constantly and would
# otherwise re-triage the whole board on every sweep.
JIRA_TRIAGE_MODEL = os.environ.get("JIRA_TRIAGE_MODEL", "haiku").strip() or "haiku"
try:
    JIRA_TRIAGE_TIMEOUT_SEC = int(os.environ.get("JIRA_TRIAGE_TIMEOUT_SEC", "120"))
except ValueError:
    JIRA_TRIAGE_TIMEOUT_SEC = 120
JIRA_TRIAGE_BATCH = 25          # tickets per `claude -p` call (one call in flight)
JIRA_TRIAGE_CANDIDATES = 200    # candidate repos shown to the model (bounds the prompt)
JIRA_TRIAGE_MAX_ATTEMPTS = 3    # tries before a ticket stays unclassified for good
JIRA_TRIAGE_BACKOFF_SEC = 300   # base gap between tries; grows with the try count
JIRA_TRIAGE_REASON_MAX = 120    # per-ticket rationale kept (a card tooltip, not an essay)
JIRA_TRIAGE_LEDGER_MAX = 500    # ledger entries kept (bounds the file)
JIRA_TRIAGE_INSTRUCTION = (
    "You are triaging Jira tickets to the code repository each one's work "
    "belongs in.\n\n"
    "Rules:\n"
    "- Choose ONLY from the candidate repositories listed below. Never invent a "
    "name.\n"
    "- Prefer a repository marked [cloned] when it fits the ticket as well as an "
    "uncloned one; pick an uncloned one when it is a clearly better fit.\n"
    "- If no repository plausibly fits (for example a pure design, meeting, or "
    "access-request ticket), use null. Do not guess.\n\n"
    "Reply with ONLY a JSON object mapping each ticket key to either null or "
    '{\"repo\": \"<exact candidate name>\", \"why\": \"<max 12 words>\"}. '
    "No markdown fences, no preamble.\n\n"
)


def _triage_candidates(repos, github):
    """The repos a ticket on this host may be matched to: its cloned repos first
    (they carry `cloned`, which the prompt tells the model to prefer), then every
    repo its gh login can clone. Deduped by repo name — a cloned repo and its gh
    listing are the same repo, and the cloned copy is the one worth preferring.

    Keyed on the bare repo NAME (not owner/repo) because that is what the board
    shows and what a scanned REPOS_ROOT dir is called; a name collision across two
    owners collapses to the first, which is the cloned one when there is one.

    A cloned repo INHERITS its gh listing's description and owner rather than
    shadowing them: the scan knows a repo's name and nothing else, so dropping the
    gh half would leave the candidates the prompt says to PREFER as bare names —
    describing worst exactly the repos most likely to win.

    The gh tail is sorted by name, not left in gh's `updatedAt` order, because it
    is about to be truncated: an updatedAt-ordered cut makes the surviving NAME set
    move whenever anyone pushes to a cold repo, which would defeat
    _candidates_fingerprint's whole reason for hashing names only and re-triage the
    board every gh sweep."""
    by_name = {}
    for r in github or []:
        nwo = (r or {}).get("nameWithOwner") or ""
        name = (r or {}).get("name") or nwo.split("/")[-1]
        if name and name not in by_name:
            by_name[name] = r
    out, seen = [], set()
    for r in repos or []:
        name = (r or {}).get("name")
        if not name or name == ROOT_REPO_NAME or name in seen:
            continue
        seen.add(name)
        gh = by_name.get(name) or {}
        out.append({"name": name, "cloned": True,
                    "nameWithOwner": gh.get("nameWithOwner") or None,
                    "source": gh.get("source") or ("github" if gh else None),
                    "description": (gh.get("description") or "")[:120]})
    for name in sorted(by_name):
        if name in seen:
            continue
        seen.add(name)
        r = by_name[name]
        out.append({"name": name, "cloned": False,
                    "nameWithOwner": r.get("nameWithOwner") or None,
                    "source": r.get("source") or "github",
                    "description": (r.get("description") or "")[:120]})
    return out[:JIRA_TRIAGE_CANDIDATES]


def _triage_fingerprint(parts):
    """A stable fingerprint for cache invalidation. crc32 for the same reason
    _usage_slot uses it — the builtin hash is salted per process and would
    invalidate the whole ledger on every restart."""
    return zlib.crc32("\x00".join(parts).encode()) & 0xFFFFFFFF


def _ticket_fingerprint(t):
    """Changes when the text a triage decision was made FROM changes. Deliberately
    not `updated`, which moves on any field edit (a status transition, an assignee
    change) and would re-triage a ticket whose description never moved."""
    labels = (t or {}).get("labels")
    return _triage_fingerprint([
        str((t or {}).get("summary") or ""),
        str((t or {}).get("type") or ""),
        str((t or {}).get("project") or ""),
        ",".join(labels) if isinstance(labels, list) else "",
    ])


def _candidates_fingerprint(cands):
    """Changes when the repos on offer change — names and cloned-ness only. NOT
    descriptions or gh's `updatedAt`, which churn on their own and would re-triage
    every ticket on the board for no new information."""
    return _triage_fingerprint(
        sorted(f"{c['name']}:{int(bool(c.get('cloned')))}" for c in cands))


def _triage_key(site_key, issue_key):
    return f"{site_key or ''}/{issue_key}"


# A ledger entry holds two independent things, and keeping them apart is what
# makes the cache safe:
#
#   the DECISION   — repo/cloned/nameWithOwner/reason/at, plus ticketFp/candFp
#                    recording the question it ANSWERS.
#   the ATTEMPT RUN — attempts/retryAt, plus tryTicketFp/tryCandFp recording the
#                    question currently being ASKED.
#
# They were originally one blob, and the two bugs that produced are worth
# remembering: starting an attempt overwrote the decision, so an unrelated
# transient (a `gh` hiccup blanking the repo list) blanked every repo chip on the
# board until a replacement landed; and the attempt counter, never reset, made
# three invalidations spread over a ticket's whole life a PERMANENT ban on
# re-triaging it — the exact opposite of what invalidation exists for.

def _triage_stale(entry, ticket_fp, cand_fp):
    """True when an entry's decision doesn't answer the question now being asked —
    never decided, decided from different ticket text, or decided against a
    different candidate set. Stale means "re-triage this"; it does NOT mean "stop
    showing it". The old answer keeps rendering until a new one lands, because a
    slightly outdated repo chip beats a board that blanks whenever a repo is
    cloned or a gh sweep stumbles."""
    if not isinstance(entry, dict) or not entry.get("decided"):
        return True
    return entry.get("ticketFp") != ticket_fp or entry.get("candFp") != cand_fp


def _triage_attempts(entry, ticket_fp, cand_fp):
    """How many attempts have been spent on the question currently being asked.

    Scoped to the question rather than to the ticket's lifetime: a changed ticket
    or candidate set is a NEW question, and it gets a fresh budget. A lifetime
    counter would let three invalidations spaced months apart disqualify a ticket
    from ever being triaged again, freezing a now-wrong chip on the board for
    good."""
    if not isinstance(entry, dict):
        return 0
    if entry.get("tryTicketFp") != ticket_fp or entry.get("tryCandFp") != cand_fp:
        return 0    # the attempts on record were spent answering something else
    n = entry.get("attempts")
    return n if isinstance(n, int) else 0


def _triage_prompt(tickets, cands):
    """The candidate list + the ticket list, as text. Ticket text is DATA here: it
    reaches `claude -p` as a single argv element (no shell), the model's reply is
    allowlist-checked against `cands`, and the result is only ever rendered as a
    chip — so a ticket summary carrying prompt-injection text can at worst make a
    card name the wrong candidate repo."""
    lines = [JIRA_TRIAGE_INSTRUCTION, "Candidate repositories:"]
    for c in cands:
        mark = " [cloned]" if c.get("cloned") else ""
        desc = f" — {c['description']}" if c.get("description") else ""
        lines.append(f"- {c['name']}{mark}{desc}")
    lines.append("\nTickets:")
    for t in tickets:
        bits = [f"- {t.get('key')}: {t.get('summary') or ''}"]
        if t.get("type"):
            bits.append(f"(type: {t['type']})")
        if t.get("project"):
            bits.append(f"(project: {t['project']})")
        labels = t.get("labels")
        if isinstance(labels, list) and labels:
            bits.append(f"(labels: {', '.join(labels)})")
        lines.append(" ".join(bits))
    return "\n".join(lines)


def _extract_json_object(raw):
    """The outermost {...} in a model reply, parsed. `claude -p` is asked for bare
    JSON but will sometimes wrap it in prose or a ```json fence; slicing to the
    outermost braces handles both without a fence-stripping special case."""
    text = (raw or "").strip()
    if not text:
        return None
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(text[start:end + 1])
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _parse_triage(raw, tickets, cands):
    """Model reply -> {issueKey: {repo, cloned, nameWithOwner, reason}}, where
    repo is None for "no repo fits".

    This is the trust boundary, and it draws a sharp line between the model's two
    very different kinds of non-answer:

    - An EXPLICIT null is a verdict. It was asked for, it means "no repo fits", and
      it becomes a decision the board renders as the muted "no repo" chip.
    - Anything unreadable — a value whose shape we can't parse, or a repo name that
      isn't on the candidate list (a hallucination; the model is choosing from a
      list, so off-list is definitionally made up) — is a FAILED ATTEMPT. Its key
      is simply omitted, leaving the ticket undecided so the caller's retry picks
      it up.

    Conflating the two is the trap: recording a garbled reply as "no repo fits"
    would paint a confident chip asserting something the model never said, and —
    because a decision is never re-triaged — leave it there for good. A key that
    wasn't asked about is ignored outright. An entirely unusable reply returns {},
    which the caller likewise counts as a failed attempt."""
    data = _extract_json_object(raw)
    if data is None:
        return {}
    by_name = {c["name"]: c for c in cands}
    asked = {t.get("key") for t in tickets}
    decline = {"repo": None, "cloned": False, "nameWithOwner": None, "reason": ""}
    out = {}
    for key, val in data.items():
        if key not in asked:
            continue
        if val is None:
            out[key] = dict(decline)   # the model was asked for null and meant it
            continue
        why = ""
        if isinstance(val, dict):
            if "repo" not in val:
                continue      # unreadable shape -> no answer for this ticket
            name = val.get("repo")
            why = str(val.get("why") or "")[:JIRA_TRIAGE_REASON_MAX]
        elif isinstance(val, str):
            name = val        # tolerate a bare "KEY": "repo" reply
        else:
            continue          # a list/number is not an answer we can read
        if name is None:
            out[key] = dict(decline)   # explicit {"repo": null}
            continue
        cand = by_name.get(name) if isinstance(name, str) else None
        if cand is None:
            # A name that isn't on the list is a BROKEN attempt, not a verdict of
            # "no repo fits" — recording it as the latter would render a confident
            # muted chip that is never revisited. Omitting the key leaves the
            # ticket undecided, so the caller's retry picks it back up.
            log(f"triage: dropping non-candidate repo {name!r} for {key}")
            continue
        out[key] = {
            "repo": cand["name"],
            "cloned": bool(cand.get("cloned")),
            "nameWithOwner": cand.get("nameWithOwner"),
            "source": cand.get("source"),
            "reason": why,
        }
    return out


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

# The manager runs its OWN one-shot `claude -p` helpers — session naming
# (SUMMARY_INSTRUCTION) and Jira repo triage (JIRA_TRIAGE_INSTRUCTION) — with
# cwd=REGISTRY_DIR (see _start_summary / _start_jira_triage). Headless or not,
# each still writes a transcript into the shared ~/.claude/projects, so the usage
# reconciler would otherwise adopt the manager's own machinery as a phantom repo
# on the usage page — the registry dir's basename (".turma" in production, or a
# "hub-agent-mgr-*" temp dir when a test/verify harness boots the manager against
# a mkdtemp REGISTRY_DIR). These are stable leading-text signatures of those two
# prompts, matched against a transcript's first user turn so such a transcript is
# recognized path- and process-independently (production AND any harness), and
# even after a prompt reword leaves older transcripts still on disk. A test pins
# them to the instructions above so a reword can't silently break the match. See
# _looks_like_internal_tool_prompt / SessionManager._is_internal_tool_slug (XERK-27).
INTERNAL_TOOL_PROMPT_SIGS = (
    "You are triaging Jira tickets",
    "In 2-4 words, give a Title Case name",
    # The subscription-limits probe (XERK-247). Load-bearing wherever `~/.turma`
    # is a symlink: claude resolves the path before slugifying it, so the
    # transcript lands under the RESOLVED dir's slug and the direct
    # REGISTRY_DIR match in _is_internal_tool_slug can't fire.
    "turma limits probe",
)


def _looks_like_internal_tool_prompt(text):
    """True when `text` opens with one of the manager's own `claude -p` helper
    prompts (session naming / Jira triage) — i.e. this transcript is the agent's
    own tooling, not a coding session, and must not surface as a repo on the usage
    page. See INTERNAL_TOOL_PROMPT_SIGS."""
    if not text:
        return False
    head = text.lstrip()
    return any(head.startswith(sig) for sig in INTERNAL_TOOL_PROMPT_SIGS)


# --- available-models probe + live model switching ------------------------------
# The chat page's model menu used to be a hardcoded guess, and "Default" was all
# it could say about the model a session was really running (XERK-33). Two reads
# fix that, both from claude itself rather than a rate table baked here:
#   - `claude -p "/model"` prints "Current model: <label>" and "Usage: /model
#     <name>. Available: <aliases>…" — the login's REAL alias list and what
#     "default" currently resolves to, probed on a slow cadence (below).
#   - each session's transcript names the model that actually answered
#     (_scan_model_entry), which the heartbeat carries as `modelActual`.
# The probe is a detached one-shot like the summary/triage helpers (same shared
# login, cwd=REGISTRY_DIR so its transcript is tombstoned as internal overhead —
# see _is_internal_tool_slug, which also recognizes it by its command name in a
# harness's foreign REGISTRY_DIR slug).
# The limits probe (XERK-247): a throwaway interactive claude whose only job is
# to make Claude Code populate `rate_limits` for hooks/statusline.py to capture.
# It is a real turn against the subscription, so everything here is sized to make
# that turn as small as one can be — the cheapest model, a one-line system prompt
# replacing the default one, and an answer of one word.
LIMITS_TMUX = "turma-limits"                 # its own tmux; no session parses it
LIMITS_PROBE_SYSTEM_PROMPT = "You are a no-op probe. Reply with exactly: ok"
# Distinctive on purpose. `~/.turma` is a SYMLINK on some hosts, so claude writes
# the probe's transcript under the resolved path's slug and
# _is_internal_tool_slug's direct REGISTRY_DIR match never fires; the fallback
# then has to recognise this by its first user text, and a bare "ok" would also
# match a real session that opened with "ok". See INTERNAL_TOOL_PROMPT_SIGS.
LIMITS_PROBE_PROMPT = "turma limits probe: reply ok"
LIMITS_PROBE_MODEL = (os.environ.get("TURMA_LIMITS_PROBE_MODEL", "haiku").strip()
                      or "haiku")
# How stale a snapshot may get before a running host spends another probe.
# 0 disables the probe entirely (the Usage page then shows its empty state, or
# whatever a hand-wired statusLine last left in the snapshot file).
LIMITS_PROBE_SEC = int(os.environ.get("TURMA_LIMITS_PROBE_SEC", "1800") or 0)
LIMITS_PROBE_TIMEOUT_SEC = int(
    os.environ.get("TURMA_LIMITS_PROBE_TIMEOUT_SEC", "120") or 120)
# Backoff after a probe that captured nothing, doubling to the cap. The failure
# that matters is the PERMANENT one — a login with no subscription windows can
# never produce a snapshot, and without a backoff that host spends a real turn
# every beat forever, chasing a number it will never have.
LIMITS_PROBE_RETRY_SEC = int(
    os.environ.get("TURMA_LIMITS_PROBE_RETRY_SEC", "900") or 900)
LIMITS_PROBE_MAX_BACKOFF_SEC = int(
    os.environ.get("TURMA_LIMITS_PROBE_MAX_BACKOFF_SEC", "21600") or 21600)
LIMITS_PROBE_TRUST_SEC = 4  # let the TUI paint before answering its trust dialog

MODEL_PROBE_PROMPT = "/model"
MODELS_REFRESH_EVERY = int(os.environ.get("TURMA_MODELS_REFRESH_EVERY", "1080")
                           or 1080)   # beats (~6h at the 20s interval)
MODELS_RETRY_EVERY = 45               # beats (~15 min) until the first success
MODELS_PROBE_TIMEOUT_SEC = int(
    os.environ.get("TURMA_MODELS_PROBE_TIMEOUT_SEC", "90") or 90)
# How long set_model waits for the /model picker to paint after opening it:
# up to TRIES polls, WAIT_SEC apart. Runs on the command path of the heartbeat
# loop, so the worst case (a few seconds) is bounded well under a spawn's git
# fetch.
MODEL_PICKER_TRIES = 10
MODEL_PICKER_WAIT_SEC = 0.3
# The arrow loop: one press at a time, each verified by re-reading the ❯
# before the next (MAX_STEPS bounds a cursor that never converges). STEP_*
# pace the per-press readback; CONFIRM_* pace the wait for the "Set model to…"
# confirmation after `s`.
MODEL_PICKER_MAX_STEPS = 12
MODEL_STEP_TRIES = 8
MODEL_STEP_WAIT_SEC = 0.12
MODEL_CONFIRM_TRIES = 10
MODEL_CONFIRM_WAIT_SEC = 0.2
# What the TUI prints once a picker selection lands (session-only or saved
# default) or is dismissed on the current model. Either wording proves the
# picker acted and closed.
MODEL_CONFIRM_RE = re.compile(r"Set model to\s+.+|Kept model as\s+.+")
# How set_mode's closed loop is bounded: more presses than any real cycle has
# modes (a wrap back to the start stops it earlier), each press's readback
# polled STEP_TRIES × STEP_WAIT.
MODE_CYCLE_MAX_PRESSES = 6
MODE_STEP_TRIES = 8
MODE_STEP_WAIT_SEC = 0.15


def parse_model_probe(text):
    """Parse `claude -p "/model"` output into {"available": [aliases],
    "defaultLabel": str|None}, or None when the Available list can't be read
    (treat as a failed attempt, never as "no models"). Tokens that aren't
    alias-shaped — the trailing "or a full model ID." — are dropped; "default"
    is guaranteed onto the list since picking it is always legal."""
    text = ANSI_RE.sub("", text or "")
    m = re.search(r"Available:\s*(.+)", text)
    if not m:
        return None
    avail = []
    for tok in m.group(1).split(","):
        tok = tok.strip().rstrip(".").strip()
        if tok and MODEL_ALIAS_TOKEN_RE.fullmatch(tok) and tok not in avail:
            avail.append(tok)
    if not avail:
        return None
    if "default" not in avail:
        avail.append("default")
    dm = re.search(r"Current model:\s*(.+)", text)
    label = dm.group(1).strip() if dm else None
    return {"available": avail, "defaultLabel": label or None}


def parse_model_picker(text):
    """Parse a pane capture of Claude Code's /model picker into its option rows.

    Returns (labels, current): the row labels top-to-bottom (description column
    stripped — it sits 2+ spaces right of the label; the ✔ current-model mark
    dropped) and the index the ❯ cursor is on, or ([], None) when the capture
    holds no picker. Only the region from the last "Select model" heading down
    is read, so numbered lines in the conversation above can't parse as rows."""
    text = ANSI_RE.sub("", text or "")
    pos = text.rfind("Select model")
    if pos < 0:
        return [], None
    rows, cur = [], None
    for line in text[pos:].splitlines():
        m = re.match(r"^\s*(❯\s+)?(\d+)\.\s+(.+?)\s*$", line)
        if not m:
            continue
        label = re.split(r"\s{2,}", m.group(3))[0].replace("✔", "").strip()
        if not label:
            continue
        rows.append(label)
        if m.group(1):
            cur = len(rows) - 1
    return rows, cur


def _picker_index_for(rows, resolved):
    """The picker row a resolved model alias (None = default) selects, or None
    when the picker doesn't offer it. Rows lead with the alias as a word —
    "Default (recommended)", "Opus", "Fable ✔" — so the match is on the first
    word, case-folded."""
    want = (resolved or "default").lower()
    for i, label in enumerate(rows):
        head = label.split()[0].lower() if label.split() else ""
        if head == want:
            return i
    return None


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
    # rstrip, NOT re.sub(r"[.\s]+$", ...): that pattern backtracks quadratically
    # on a long run of trailing whitespace, and this runs on unbounded `claude
    # -p` output ON THE HEARTBEAT THREAD — 50k trailing spaces stalled every
    # session's beat for ~10s (XERK-235). rstrip is O(n) and does the same job.
    line = line.rstrip(". \t\n\r\f\v").strip()
    if not line:
        return None
    capped = " ".join(line.split()[:SUMMARY_MAX_WORDS])[:SUMMARY_MAX_CHARS].strip()
    return capped or None


def clean_manual_summary(raw):
    """Reduce an operator-typed session name to a display name, or None to clear
    it. Unlike clean_summary (which tames a chatty model reply), this keeps the
    text the operator actually typed — only the first line, whitespace collapsed,
    and capped to the same width the card can show. Nothing is stripped from
    inside it: an apostrophe or a version number is a deliberate part of a name a
    human chose, where in a model's reply it was noise."""
    line = next((ln.strip() for ln in (raw or "").splitlines() if ln.strip()), "")
    return " ".join(line.split())[:SUMMARY_MAX_CHARS].strip() or None


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
        # The container's own StartedAt where docker can answer, else THIS
        # process's start — never empty. The fallback is what puts a native host
        # on the hub's restart-loop radar (XERK-34): the alert keys on heartbeat
        # `startedAt` CHANGING, so a host reporting none can crash-loop under
        # systemd's Restart=always without a single notification, and its card's
        # Uptime reads "–". The manager's start is the honest native equivalent
        # of a container boot — with KillMode=process each crash restarts exactly
        # this process — and in the container the manager IS PID 1, so the two
        # times only differ by the entrypoint's preflight anyway.
        self.started_at = run(
            ["docker", "inspect", "--format", "{{.State.StartedAt}}", self.agent_id]
        ) or now_iso()
        # Which coding agent this host runs, and its version. The raw string is
        # kept alongside the parsed {name, version} purely for hubs predating
        # `codingAgent` — the two update independently, so a new agent must not
        # blank an old hub's header.
        self.claude_version = run(["claude", "--version"])
        self.coding_agent = coding_agent()
        # This build's own version (baked env / installed VERSION file), read once
        # — it can't change without the process being replaced.
        self.agent_version = agent_version()
        self.device = device_name()

        # AskUserQuestion bridge rendezvous dir (ask.py writes req files here).
        try:
            os.makedirs(QUESTIONS_DIR, exist_ok=True)
        except OSError:
            pass
        # We've just (re)started, so any expected-restart hint the updater left
        # for the PREVIOUS shutdown has served its purpose — clear it so a later
        # SIGKILL (no handler) can't leak a stale version into a future announce
        # (XERK-29). The hub already cleared the `updating` status the instant
        # this boot's first heartbeat landed.
        try:
            os.unlink(UPDATING_FLAG_PATH)
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
        # survives past the beat the URL was first scraped. Deduped + capped.
        self.session_pr_urls = {}                # id -> [unique PR urls, capped]
        # Rehydrated from the registry on boot: a running session mirrors its
        # opened-PR links onto its own record (sess["prUrls"], saved as they grow
        # in _session_payload), so the chips survive an AGENT restart the same way
        # a killed session's do off its closed record. Without this the map
        # started empty and the transcript scan primes its offsets to EOF (so it
        # never replays the old links), which blanked a running card's PR chips on
        # every restart until it happened to open another PR. (XERK-15)
        for _sess in self.registry:
            _urls = _sess.get("prUrls")
            if _urls:
                self.session_pr_urls[_sess["id"]] = list(_urls)
        # PR link -> compact status (state + CI checks), refreshed via `gh pr
        # view` on the PR_STATUS_REFRESH_EVERY cadence and attached to each
        # session's payload. Keyed by URL so several sessions can share one.
        # Seeded from the durable PR-status ledger so a chip keeps its state/CI
        # pill across a restart (an ended session's PR is never re-polled).
        self.pr_status_cache = self._load_pr_status_ledger()
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
        # Staged `subagentHistory` results (one background agent's transcript,
        # fetched when an operator clicks a live agent-list row) — same
        # staged-until-delivered lifecycle as history_results.
        self.subagent_history_results = []
        # Staged `jiraIssue` command results (one issue's description/comments,
        # fetched on demand when an operator expands a board ticket) awaiting
        # the next heartbeat payload — same held-across-a-failed-POST lifecycle
        # as history_results.
        self.jira_issue_results = []
        # Staged `setTicketStatus` results (the outcome of a board status change,
        # XERK-138) — each `{cmdId, key, ok, error, ...}` awaiting the next
        # heartbeat, keyed back to the request by the command's cmdId. Same
        # held-across-a-failed-POST lifecycle as jira_issue_results.
        self.ticket_status_results = []
        # Staged New-ticket (XERK-137) results: the board's create form fetches
        # the project/type/label metadata (create_meta_results) and then POSTs a
        # new ticket (create_ticket_results), both riding the next beat with the
        # same held-across-a-failed-POST lifecycle as jira_issue_results.
        self.create_meta_results = []
        self.create_ticket_results = []
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
        # Extra clone sources (XERK-155), keyed by source ("azure"/"gitlab"),
        # present only when that source's creds are configured. Each holds the
        # last GOOD listing (repos keep their internal cloneUrl; the payload
        # strips it) — a failed sweep records the error but never blanks the
        # repos, for the same reason triage_gh_repos exists.
        self.git_sources = {}
        if azure_configured():
            self.git_sources["azure"] = {"available": False, "repos": [], "error": None}
        if gitlab_configured():
            self.git_sources["gitlab"] = {"available": False, "repos": [], "error": None}
        # Jira Cloud assigned-ticket block (refreshed on its own slow cadence
        # or on a hub `refreshJira` command, reported every beat; stays the
        # empty shape on unconfigured hosts).
        self.jira = board_empty()
        # Recent per-repo prune results (merged branches + safe worktrees swept),
        # keyed by repo name, lingered briefly so the UI can show the summary.
        self.prunes = {}
        # In-flight session-summary subprocesses keyed by session id (the Popen
        # + its output file live here; the finished text lands on the session
        # record). Empty when no session has a prompt to summarize.
        self.summaries = {}
        # The login's real model list, from the `claude -p "/model"` probe:
        # {"available": [aliases], "defaultLabel": "Fable 5", "at": iso} once a
        # probe has succeeded, None until then (the hub falls back to its static
        # menu). In-memory only — a restart re-probes within a beat or two.
        self.models_info = None
        self.models_probe = None       # the in-flight probe job, or None
        # Sessions whose modelActual has been seeded from their transcript tail
        # this process — the seed is a one-shot bounded read per session, for
        # records predating the field (the per-beat scan only sees new bytes).
        self._model_seeded = set()
        # Cached Jira-ticket -> repo triage decisions (persisted), plus the single
        # in-flight triage subprocess. At most one runs at a time: a backlog
        # trickles out a batch per jira beat rather than forking N models at once
        # against the one shared login. Both stay empty on unconfigured hosts.
        self.triage_ledger = self._load_triage_ledger()
        self.triage_job = None
        # Durable transcript -> ticket attribution (persisted). Keeps the board's
        # ticket chips answerable after the session record behind them is gone —
        # killed, aged out of closed.json, or never in either. Backfilled from the
        # records that still carry both, so it doesn't start empty.
        self.ticket_ledger = self._load_ticket_ledger()
        self._backfill_ticket_ledger()
        # Durable transcript -> PR-links attribution (persisted). Keeps a
        # session's PR chips answerable after the in-memory scan is lost (manager
        # restart) and after the session record itself is gone (aged out of
        # closed.json). Backfilled from the closed history, and re-seeds the live
        # working set so a restart re-polls a running session's PRs rather than
        # blanking them. See PR_LEDGER_PATH.
        self.pr_ledger = self._load_pr_ledger()
        self._backfill_pr_ledger()
        # Last SUCCESSFUL gh repo sweep, held so a failed one (which blanks the
        # github block to repos:[]) can't be mistaken for an empty org — see
        # _start_jira_triage.
        self.triage_gh_repos = []
        # The repos a ticket may be assigned to on this host, recomputed each beat
        # by _refresh_triage_candidates. It is deliberately ONE list serving two
        # callers: the choice list the model triages from, and (heartbeated as
        # jira.repoOptions) the options the board's manual picker offers. They must
        # not drift — the picker exists to offer exactly what set_jira_repo will
        # accept, and both validate against this.
        self.triage_cands = []
        # at-least-once command de-dup: cmdIds we've already executed.
        self.acked = set()
        self.acked_order = deque(maxlen=1000)
        # A dashboard-requested manager restart (restartAgent). Set by the
        # command handler and consumed by run_forever, which exits for the
        # supervisor to bring us back — but only AFTER a heartbeat carrying the
        # command's ack reached the hub, so the still-queued command can't
        # re-fire on the next boot and restart-loop us.
        self._restart_pending = False

    # --- registry persistence ---------------------------------------------

    def _load_list(self, path):
        """Load a persisted list, quarantining a damaged file instead of eating it.

        A truncated or non-list `sessions.json` used to return [] silently, and
        the next beat's save() overwrote the damaged file with `[]` — so every
        session went unmanaged (tmux and ttyd still running, ports leaked) with
        no log line, and the evidence was destroyed by the recovery (XERK-235).
        The copy is what makes the loss diagnosable after the fact.
        """
        if not os.path.exists(path):
            return []
        try:
            with open(path) as f:
                data = json.load(f)
            if isinstance(data, list):
                return data
            bad = f"not a list ({type(data).__name__})"
        except OSError as e:
            # Unreadable rather than corrupt — don't quarantine, we may not be
            # able to read it next beat either and there's nothing to preserve.
            print(f"[hub-agent] WARNING: cannot read {path} ({e}); "
                  "continuing with an empty list", file=sys.stderr, flush=True)
            return []
        except ValueError as e:
            bad = str(e)
        quarantine = f"{path}.corrupt.{int(time.time())}"
        try:
            shutil.copy2(path, quarantine)
        except OSError:
            quarantine = "(copy failed)"
        print(f"[hub-agent] WARNING: {path} is unusable ({bad}); "
              f"kept a copy at {quarantine}. Any session it described is now "
              "unmanaged — check `tmux ls` for orphans.",
              file=sys.stderr, flush=True)
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

    # --- Jira -> repo triage ----------------------------------------------

    def _load_triage_ledger(self):
        try:
            with open(TRIAGE_LEDGER_PATH) as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save_triage_ledger(self):
        try:
            os.makedirs(REGISTRY_DIR, exist_ok=True)
            tmp = TRIAGE_LEDGER_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self.triage_ledger, f, indent=2)
            os.replace(tmp, TRIAGE_LEDGER_PATH)
        except OSError as e:
            log(f"triage ledger save failed: {e}")

    def _triage_due(self, tickets, cand_fp, now, site_key):
        """The tickets wanting a decision right now: stale, attempts left, and
        past the backoff a previous failed attempt set. Bounded to one batch —
        the rest come back on later beats."""
        due = []
        for t in tickets:
            key = t.get("key")
            if not key:
                continue
            entry = self.triage_ledger.get(_triage_key(site_key, key))
            # An operator's own answer outranks anything the model would decide, so
            # a manual pin is never re-triaged and never spends an attempt. It is
            # the same rule _summary_due applies to a hand-renamed session, and the
            # ONLY way back to auto is the operator clearing it (set_jira_repo with
            # auto=True), which drops the entry outright.
            if isinstance(entry, dict) and entry.get("manual"):
                continue
            tfp = _ticket_fingerprint(t)
            if not _triage_stale(entry, tfp, cand_fp):
                continue
            attempts = _triage_attempts(entry, tfp, cand_fp)
            if attempts >= JIRA_TRIAGE_MAX_ATTEMPTS:
                continue
            # The backoff is only this question's to enforce; `attempts` is 0 when
            # the retryAt on record was armed answering a different one.
            if attempts and now < (entry.get("retryAt") or 0):
                continue
            due.append(t)
            if len(due) >= JIRA_TRIAGE_BATCH:
                break
        return due

    def _refresh_triage_candidates(self):
        """Recompute the repos a ticket may be assigned to on this host, and cache
        them on `self.triage_cands`.

        refresh_github blanks the block to repos:[] on ANY error, which on this
        field alone is indistinguishable from "the org has no repos". Triaging
        against that would drop every uncloned candidate, restale every ticket, and
        re-run the whole board through the model twice — once when gh stumbles and
        again when it recovers. So only a SUCCESSFUL sweep updates the candidate
        repos; otherwise the last good list stands. A host with no gh at all never
        sets it and triages against its cloned repos, which is the correct
        candidate set for that host.

        The same list is the operator's picker options and set_jira_repo's
        allowlist, so a repo the board offers is by construction one this host will
        accept.

        The extra git sources (XERK-155) join the clonable tail: their listings
        are already keep-last-good (refresh_git_sources never blanks on error),
        so they need no gate of their own. gh first, so a cross-source name
        collision keeps its legacy GitHub resolution."""
        gh = self.github or {}
        if gh.get("available"):
            self.triage_gh_repos = list(gh.get("repos") or [])
        clonable = list(self.triage_gh_repos)
        for src in ("azure", "gitlab"):
            state = self.git_sources.get(src) or {}
            clonable.extend(dict(r, source=src)
                            for r in state.get("repos") or [])
        self.triage_cands = _triage_candidates(self._triage_repos(), clonable)
        return self.triage_cands

    def _start_jira_triage(self):
        """Kick off one batch of ticket -> repo triage as a DETACHED
        `claude -p` reaped by _poll_jira_triage. No-op when a job is already in
        flight, when the board is off, when there are no candidate repos, or when
        every ticket already has a fresh decision — so a settled board costs
        nothing. Source-agnostic: it reads only the ticket text in self.jira."""
        if not board_configured():
            return
        # Refreshed BEFORE the in-flight check: the board's picker reads this list
        # every beat, and freezing it for the length of a triage job would offer
        # the operator a stale set of repos (a just-cloned one missing) for as long
        # as the model happened to be running.
        cands = self._refresh_triage_candidates()
        if self.triage_job is not None:
            return
        tickets = self.jira.get("tickets") or []
        if not tickets:
            return
        if not cands:
            return  # nothing to choose from; leave the tickets untriaged
        cand_fp = _candidates_fingerprint(cands)
        site_key = self.jira.get("siteKey")
        batch = self._triage_due(tickets, cand_fp, time.time(), site_key)
        if not batch:
            return
        out_path = os.path.join(REGISTRY_DIR, "jira-triage.out")
        outf = None
        try:
            os.makedirs(REGISTRY_DIR, exist_ok=True)
            outf = open(out_path, "w")
            # Same posture as _start_summary: headless, cwd is REGISTRY_DIR (NOT a
            # repo) and no --settings, so it never loads the session guard or
            # explores a worktree — it decides from the candidate list in the
            # prompt alone. The command is a list (no shell), so ticket text can't
            # inject, and _poll_jira_triage's timeout backstops a hang.
            proc = subprocess.Popen(
                ["claude", "-p", "--model", JIRA_TRIAGE_MODEL,
                 _triage_prompt(batch, cands)],
                stdout=outf, stderr=subprocess.DEVNULL, cwd=REGISTRY_DIR,
            )
        except Exception as e:
            log(f"jira triage launch failed: {e}")
            if outf is not None:
                try:
                    outf.close()
                except Exception:
                    pass
            self._spend_triage_attempts(batch, cand_fp, site_key)
            return
        self.triage_job = {
            "proc": proc, "outf": outf, "outPath": out_path,
            "startedMono": time.time(), "batch": batch, "cands": cands,
            "candFp": cand_fp,
            # Pinned rather than re-read at reap time: the ledger key a decision
            # lands under must be the one its attempt was counted under, and a job
            # outlives the beat that started it.
            "siteKey": site_key,
        }
        self._spend_triage_attempts(batch, cand_fp, site_key)
        log(f"triaging {len(batch)} jira ticket(s) to repos via claude -p "
            f"({JIRA_TRIAGE_MODEL}), {len(cands)} candidates")

    def _spend_triage_attempts(self, batch, cand_fp, site_key):
        """Count an attempt against each ticket in a batch and arm its backoff.
        Armed up-front like _spend_summary_attempt: if the manager dies mid-batch
        the job dies with it, and the persisted count is what makes the reload
        retry once rather than loop.

        Touches ONLY the attempt-run fields. Any decision already on the entry is
        left intact and keeps rendering while this attempt runs — it is the best
        answer available until a better one lands, and destroying it here would
        blank the board on nothing more than a transient."""
        for t in batch:
            lkey = _triage_key(site_key, t.get("key"))
            entry = dict(self.triage_ledger.get(lkey) or {})
            tfp = _ticket_fingerprint(t)
            prev = _triage_attempts(entry, tfp, cand_fp)
            entry["attempts"] = prev + 1
            entry["retryAt"] = time.time() + JIRA_TRIAGE_BACKOFF_SEC * (prev + 1)
            entry["tryTicketFp"] = tfp
            entry["tryCandFp"] = cand_fp
            self.triage_ledger[lkey] = entry
        self._prune_triage_ledger()
        self._save_triage_ledger()

    def _finish_jira_triage(self, job, results):
        """Tear down a triage job and merge whatever it decided into the ledger.
        A ticket the reply didn't cover keeps the attempt it spent and comes back
        on the next beat once its backoff elapses."""
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
        self.triage_job = None
        decided = 0
        for t in job.get("batch") or []:
            key = t.get("key")
            if key not in results:
                continue
            lkey = _triage_key(job.get("siteKey"), key)
            entry = dict(self.triage_ledger.get(lkey) or {})
            # The operator overrode this ticket while the model was still deciding
            # it. Their answer wins: the batch was built before the override
            # existed, so this reply is an answer to a question that is no longer
            # being asked. Mirrors _finish_summary declining to clobber a manual
            # rename.
            if entry.get("manual"):
                continue
            entry.update(results[key])
            entry["decided"] = True
            entry["at"] = now_iso()
            # Stamp the question this decision ANSWERS (the one the batch was built
            # from, not whatever the block says now), and close out the attempt run
            # — a landed answer owes no more retries, and leaving the counter to
            # accumulate across a ticket's life would eventually ban it from being
            # re-triaged at all.
            entry["ticketFp"] = _ticket_fingerprint(t)
            entry["candFp"] = job.get("candFp")
            for k in ("attempts", "retryAt", "tryTicketFp", "tryCandFp"):
                entry.pop(k, None)
            self.triage_ledger[lkey] = entry
            decided += 1
        if decided:
            self._save_triage_ledger()
            self._apply_triage()
        missed = len(job.get("batch") or []) - decided
        log(f"jira triage: decided {decided} ticket(s)"
            + (f", {missed} unanswered (will retry)" if missed else ""))

    def _poll_jira_triage(self):
        """Reap the in-flight triage subprocess (one non-blocking poll() per beat,
        like _poll_summaries): on clean exit merge the validated decisions; kill
        and drop anything that overran the timeout."""
        job = self.triage_job
        if job is None:
            return
        proc = job.get("proc")
        rc = proc.poll() if proc else 0
        if rc is None:
            if time.time() - job.get("startedMono", 0) > JIRA_TRIAGE_TIMEOUT_SEC:
                try:
                    proc.kill()
                except Exception:
                    pass
                log("jira triage timed out")
                self._finish_jira_triage(job, {})
            return
        raw = None
        if rc == 0:
            try:
                with open(job.get("outPath") or "", errors="replace") as f:
                    raw = f.read()
            except OSError:
                raw = None
        else:
            log(f"jira triage exited {rc}")
        self._finish_jira_triage(
            job, _parse_triage(raw, job.get("batch") or [], job.get("cands") or []))

    def _triage_repos(self):
        """The host's cloned repos as triage candidates. Reads the scan directly
        rather than _sorted_repo_entries: triage only needs names, and the scan is
        the cheap half (no per-repo git calls, no root pseudo-repo)."""
        try:
            return scan_repos()
        except Exception as e:
            log(f"triage repo scan failed: {e}")
            return []

    def _prune_triage_ledger(self):
        """Bound the ledger. Entries are dropped oldest-decision-first; an
        undecided entry (in flight or awaiting a retry) sorts newest so a prune
        can't silently cancel work still owed.

        A MANUAL entry sorts alongside those and is evicted last: an auto decision
        the prune drops is simply recomputed on the next beat, but a pin the
        operator typed is the one thing here that cannot be regenerated, and losing
        it would silently hand the ticket back to the model."""
        over = len(self.triage_ledger) - JIRA_TRIAGE_LEDGER_MAX
        if over <= 0:
            return
        order = sorted(self.triage_ledger.items(),
                       key=lambda kv: ("￿" if (kv[1] or {}).get("manual")
                                       else (kv[1] or {}).get("at") or "￿"))
        for lkey, _ in order[:over]:
            self.triage_ledger.pop(lkey, None)

    def _apply_triage(self):
        """Stamp each cached decision onto its ticket in the live jira block, so
        the guess rides the ordinary heartbeat rather than needing a channel of its
        own. Idempotent — called after every jira refresh and every merge.

        Only DECIDED entries produce a repoGuess: a ticket that hasn't been triaged
        yet carries no key at all (the board shows no chip, which is honest — it
        isn't "no repo fits", it's "not looked at yet"), while one the model
        declined carries repo=None, which the board renders as the greyed
        no-repo chip.

        A `manual` decision is the operator's own and reads identically apart from
        the flag, which the board uses to say who chose."""
        site_key = self.jira.get("siteKey")
        by_name = {c["name"]: c for c in (self.triage_cands or [])}
        for t in self.jira.get("tickets") or []:
            entry = self.triage_ledger.get(_triage_key(site_key, t.get("key")))
            if not isinstance(entry, dict) or not entry.get("decided"):
                t.pop("repoGuess", None)
                continue
            repo = entry.get("repo")
            # Clone state is re-read from the CURRENT candidates rather than
            # trusted from when the decision landed. Cloning a repo re-triages an
            # auto guess (candFp moves), but a manual pin never re-triages at all,
            # so a stored `cloned:false` would outlive the clone forever and the
            # chip would stay dashed for good.
            #
            # A repo missing from the list right now keeps its stored state: the
            # list blanks on a failed gh sweep, and absence there is not evidence a
            # repo stopped being cloned.
            cand = by_name.get(repo) if repo else None
            t["repoGuess"] = {
                "repo": repo,
                "cloned": bool(cand.get("cloned")) if cand else bool(entry.get("cloned")),
                "nameWithOwner": (cand or {}).get("nameWithOwner") or entry.get("nameWithOwner"),
                "source": (cand or {}).get("source") or entry.get("source"),
                "reason": entry.get("reason") or "",
                "manual": bool(entry.get("manual")),
                "at": entry.get("at"),
            }

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

    # --- ticket attribution ledger -----------------------------------------

    def _load_ticket_ledger(self):
        try:
            with open(TICKET_LEDGER_PATH) as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save_ticket_ledger(self):
        try:
            os.makedirs(REGISTRY_DIR, exist_ok=True)
            tmp = TICKET_LEDGER_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self.ticket_ledger, f, indent=2)
            os.replace(tmp, TICKET_LEDGER_PATH)
        except OSError as e:
            log(f"ticket ledger save failed: {e}")

    def _remember_ticket(self, sess, save=True):
        """Record a ticket-backed session's transcript -> ticket attribution, so
        the board can still say which conversation worked a ticket once the
        session record behind it is gone (see TICKET_LEDGER_PATH). Idempotent;
        keyed by the transcript id, so a restart-clear-context adds its new
        conversation rather than replacing the old one.

        No-op for the ordinary session, which has no ticket, and for one not yet
        launched, which has no transcript to key on. Returns whether anything
        moved, so a bulk caller can save once.

        The id is the PINNED one, falling back to the closed record's resolved
        `transcriptId` — which is all a record written by an agent predating the
        pin ever had (see _remember_closed)."""
        tid = sess.get("claudeSessionId") or sess.get("transcriptId")
        ticket = sess.get("ticket")
        if not tid or not ticket or not ticket.get("key"):
            return False
        prev = self.ticket_ledger.get(tid)
        entry = {
            "key": ticket.get("key"),
            "siteKey": ticket.get("siteKey"),
            "url": ticket.get("url"),
            "summary": ticket.get("summary"),
            # The branch this session was TOLD to cut. The live git branch is the
            # better label and the board prefers it, but it is only readable while
            # the worktree exists — this is what a chip falls back to afterwards.
            "branch": ticket.get("branch"),
            "repo": sess.get("repo"),
            # First-seen, not last-touched: this is the sort key _prune_ticket_ledger
            # evicts on, and a resume must not make an old session look new and
            # push a genuinely newer one off the end.
            "at": (prev or {}).get("at") or now_iso(),
        }
        if prev == entry:
            return False    # nothing moved; don't rewrite the file every launch
        self.ticket_ledger[tid] = entry
        self._prune_ticket_ledger()
        if save:
            self._save_ticket_ledger()
        return True

    def _prune_ticket_ledger(self):
        """Bound the ticket ledger, oldest first. Unlike the usage ledger this is
        NOT pruned against the transcripts on disk: a transcript can be archived
        off this host and still be the answer to "which session worked PROJ-123",
        and an entry is a few hundred bytes."""
        if len(self.ticket_ledger) <= TICKET_LEDGER_MAX:
            return
        order = sorted(self.ticket_ledger.items(),
                       key=lambda kv: (kv[1] or {}).get("at") or "")
        for tid, _ in order[:len(self.ticket_ledger) - TICKET_LEDGER_MAX]:
            self.ticket_ledger.pop(tid, None)

    def _backfill_ticket_ledger(self):
        """Adopt ticket-backed sessions that predate the ledger, from the two
        records that already carry both a ticket and a transcript id: the live
        registry and the closed history. Runs once at construction.

        This is the same reconcile-from-what-we-have rule _reconcile_orphan_transcripts
        applies to usage, and it is what stops the ledger starting empty on the
        very update that makes it durable."""
        changed = False
        for sess in list(self.registry) + list(self.closed):
            changed |= self._remember_ticket(sess, save=False)
        if changed:
            self._save_ticket_ledger()

    def _load_pr_ledger(self):
        try:
            with open(PR_LEDGER_PATH) as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save_pr_ledger(self):
        try:
            os.makedirs(REGISTRY_DIR, exist_ok=True)
            tmp = PR_LEDGER_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self.pr_ledger, f, indent=2)
            os.replace(tmp, PR_LEDGER_PATH)
        except OSError as e:
            log(f"pr ledger save failed: {e}")

    def _remember_prs(self, sess, save=True):
        """Record a session's transcript -> PR-links attribution durably, so its
        chips survive the in-memory scan being lost (a manager restart) and the
        session record itself being gone (aged out of closed.json). Idempotent;
        keyed by the transcript id, so a restart-clear-context's new conversation
        gets its own entry rather than clobbering the old one.

        The URLs are read from the live session_pr_urls (what the scan has found
        so far); a session that has opened none, or has no transcript to key on,
        is a no-op. Returns whether anything moved, so a bulk caller saves once.

        The id is the PINNED one, falling back to a closed record's resolved
        transcriptId — all a pre-pin record ever had (see _remember_closed)."""
        tid = sess.get("claudeSessionId") or sess.get("transcriptId")
        urls = self.session_pr_urls.get(sess.get("id")) or []
        if not tid or not urls:
            return False
        prev = self.pr_ledger.get(tid)
        merged = list((prev or {}).get("urls") or [])
        moved = False
        for u in urls:
            if u not in merged:
                merged.append(u)
                moved = True
        del merged[:-10]
        if not moved and prev is not None:
            return False    # nothing new; don't rewrite the file every beat
        self.pr_ledger[tid] = {
            "urls": merged,
            # First-seen, not last-touched: the prune's sort key, so a session
            # that keeps opening PRs doesn't push a genuinely older one off.
            "at": (prev or {}).get("at") or now_iso(),
        }
        self._prune_pr_ledger()
        if save:
            self._save_pr_ledger()
        return True

    def _prune_pr_ledger(self):
        """Bound the PR ledger, oldest first. Like the ticket ledger and unlike
        the usage one, NOT pruned against the transcripts on disk: a transcript
        archived off this host is still the answer to "which PRs did it open"."""
        if len(self.pr_ledger) <= PR_LEDGER_MAX:
            return
        order = sorted(self.pr_ledger.items(),
                       key=lambda kv: (kv[1] or {}).get("at") or "")
        for tid, _ in order[:len(self.pr_ledger) - PR_LEDGER_MAX]:
            self.pr_ledger.pop(tid, None)

    def _backfill_pr_ledger(self):
        """Seed the durable PR ledger from what's already on disk. Runs once at
        construction, after the registry/closed history are loaded (and after
        XERK-15's session_pr_urls rehydration, which this defers to below).

        Two jobs, both the reconcile-from-what-we-have rule the other ledgers
        follow:
        - Fold in every closed record's own prUrls snapshot (keyed by
          transcriptId), so a ledger added after the fact adopts the sessions
          already ended — the ones whose chips it most needs to keep once their
          closed record ages out of closed.json.
        - Backfill session_pr_urls for any LIVE session the XERK-15 rehydration
          missed — a registry record predating that mirror carries no
          `sess["prUrls"]`, but its ledgered links (written on a prior run) still
          name its PRs. setdefault, so XERK-15's copy stays authoritative when it
          has one; this only fills a gap it left."""
        changed = False
        for rec in self.closed:
            tid = rec.get("transcriptId") or rec.get("claudeSessionId")
            urls = rec.get("prUrls") or []
            if not tid or not urls:
                continue
            prev = self.pr_ledger.get(tid)
            merged = list((prev or {}).get("urls") or [])
            for u in urls:
                if u not in merged:
                    merged.append(u)
            del merged[:-10]
            if merged != ((prev or {}).get("urls") or []):
                self.pr_ledger[tid] = {
                    "urls": merged, "at": (prev or {}).get("at") or now_iso()}
                changed = True
        if changed:
            self._prune_pr_ledger()
            self._save_pr_ledger()
        for sess in self.registry:
            tid = sess.get("claudeSessionId")
            entry = self.pr_ledger.get(tid) if tid else None
            if entry and entry.get("urls"):
                self.session_pr_urls.setdefault(sess["id"], list(entry["urls"]))

    def _ledger_prs(self, tid):
        """PR-status objects for a transcript's ledgered PR links, newest last —
        the durable-side counterpart of _session_prs / _closed_prs, reading the
        PR ledger by transcript id. This is the only channel that answers for a
        session aged out of closed.json (the resumable scan). None when it opened
        no PR, or predates the ledger."""
        entry = self.pr_ledger.get(tid) if tid else None
        urls = (entry or {}).get("urls")
        if not urls:
            return None
        return [self.pr_status_cache.get(u) or {"url": u} for u in urls]

    def _seed_prs(self, sess):
        """Re-derive a resumed/migrated session's PR chips from its transcript.

        A live session's chips come from session_report's incremental per-beat
        scan, which primes a transcript's byte offset to EOF the first time it
        sees the file (so a restarted agent never replays old PR links). That is
        exactly wrong for a session that RESUMES an existing transcript — a
        host-local resume-any, or a session migrated in from another agent: the
        `gh pr create` events that opened its PRs are already in the conversation
        the moment it launches, past the EOF the scan primes to, so the chips
        never reappear even though the PR is right there. And session_pr_urls is
        keyed by session id, which is freshly minted here, so nothing carries the
        source's links either.

        So scan the whole transcript once at launch, keyed like the live scan,
        and seed session_pr_urls + the record's prUrls + the durable ledger. The
        transcript id is preserved across a migration, so the target lands the
        same URLs the source reported. Idempotent (dedups into whatever the live
        scan later finds) and a no-op for a session that opened no PR."""
        sid = sess.get("id")
        path = _session_transcript_path(sess)
        if not sid or not path or not os.path.isfile(path):
            return
        report = {"prUrls": []}
        state = {}
        try:
            with open(path, "rb") as f:
                raw = f.read()
        except OSError:
            return
        end = raw.rfind(b"\n") + 1  # only complete lines, like the live scan
        for line in raw[:end].split(b"\n"):
            if line.strip():
                _scan_pr_line(line, state, report)
        if not report["prUrls"]:
            return
        known = self.session_pr_urls.setdefault(sid, [])
        grew = False
        for url in report["prUrls"]:
            if url not in known:
                known.append(url)
                grew = True
        del known[:-10]
        if grew:
            sess["prUrls"] = list(known)
            self._remember_prs(sess, save=False)
            self.save()
            self._save_pr_ledger()

    def _save_pr_status_ledger(self):
        try:
            os.makedirs(REGISTRY_DIR, exist_ok=True)
            tmp = PR_STATUS_LEDGER_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self.pr_status_cache, f, indent=2)
            os.replace(tmp, PR_STATUS_LEDGER_PATH)
        except OSError as e:
            log(f"pr status ledger save failed: {e}")

    def _load_pr_status_ledger(self):
        try:
            with open(PR_STATUS_LEDGER_PATH) as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

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
        """A free ttyd port: unclaimed in the registry AND not actually bound.

        The registry alone is not enough. Anything holding a port this manager
        doesn't know about — a ttyd orphaned by a lost/corrupt registry, a
        second agent on the host, an unrelated service — still owns the bind,
        and ttyd's failure to take it is silent (stderr goes to DEVNULL). The
        session then serves ANOTHER session's terminal on its port, or none,
        for its whole life with nothing logged (XERK-235).
        """
        used = {s.get("ttydPort") for s in self.registry if s.get("ttydPort")}
        p = TTYD_PORT_BASE
        while p in used or _port_open(p):
            p += 1
        return p

    def _running_count(self):
        return sum(1 for s in self.registry if s.get("status") == "running")

    def _queued_count(self):
        return sum(1 for s in self.registry if s.get("status") == "queued")

    def _capacity_payload(self):
        """This host's session ceiling and what is against it.

        MAX_SESSIONS never used to reach the wire at all, which left the hub
        unable to tell a host with room from one at its limit — so it routed a
        ticket to whichever host matched FIRST and a spawn that overran the cap
        was refused with a log line nobody reads. This is what the hub ranks
        hosts by; everything else in the queue depends on it being here.

        Cheap enough to send every beat (three counts over the registry), and it
        has to be: capacity is exactly the fact that goes stale fastest, and a
        stale read is what makes the hub pile work onto a host that just
        filled up."""
        running = self._running_count()
        return {
            "maxSessions": MAX_SESSIONS,
            "running": running,
            "queued": self._queued_count(),
            # Never negative: MAX_SESSIONS can be lowered under a host that is
            # already over it, and "-2 free slots" is not something the hub
            # should have to reason about.
            "free": max(0, MAX_SESSIONS - running),
            # A second, orthogonal ceiling — one root session per host — so the
            # hub can see a root spawn is blocked without inferring it.
            "rootRunning": self._root_running(),
        }

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
                if not VALID_CLAUDE_SID_RE.fullmatch(sid):
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

    def _session_transcript_id(self, sess):
        """Claude session id of THIS session's conversation, or None if it has
        not had one yet. See _session_transcript_path — this is the same
        resolution, reported as an id rather than opened as a path.

        Re-validated on the way out, like _latest_transcript_id: the pinned
        branch validates the id before building a path from it, but the unpinned
        one derives an id from a FILENAME on disk, which nothing vets. Both feed
        callers that put it on a command line."""
        path = _session_transcript_path(sess)
        if not path:
            return None
        sid = os.path.basename(path)[:-len(".jsonl")]
        return sid if VALID_CLAUDE_SID_RE.fullmatch(sid) else None

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
        # Fix WHICH conversation this session is, on every launch. A resume joins
        # an existing one; anything else opens a new one under an id we mint here
        # rather than letting claude pick its own — see _session_transcript_path
        # for why the session has to know its own transcript by name.
        claude_sid = None
        if resume:
            if resume_id and VALID_CLAUDE_SID_RE.fullmatch(resume_id):
                claude_sid = resume_id  # a specific transcript from the picker
            elif sess.get("claudeSessionId"):
                # This session's OWN conversation, not the newest one sharing its
                # project dir: for a root session those differ, and resuming the
                # neighbour would hand it someone else's context. Resolved only
                # if it's really on disk — claude errors out on an id it can't
                # resolve, and a session killed before its first turn has none to
                # rejoin, so it (correctly) opens a fresh one below.
                claude_sid = self._session_transcript_id(sess)
            else:
                # Launched by an agent predating the pin: newest-mtime is the only
                # handle it ever had on its conversation. Keep it.
                claude_sid = self._latest_transcript_id(sess["worktreePath"])
        if claude_sid:
            parts.append(f"--resume {claude_sid}")
        else:
            # Fresh conversation (spawn, restart-clear-context, or a resume with
            # nothing to resume). --session-id names its transcript up front, so
            # this session is identifiable from its first byte rather than from
            # whenever it happens to out-mtime its neighbours.
            claude_sid = str(uuid.uuid4())
            parts.append(f"--session-id {claude_sid}")
        sess["claudeSessionId"] = claude_sid
        # This session now knows which conversation it is, which is the one moment
        # a ticket-backed one can be tied to its transcript. Every launch passes
        # here (spawn, resume, restart-clear-context), so the ledger picks up a
        # cleared session's new transcript too — both worked the ticket, and the
        # board should chip both. No-op unless this session has a ticket.
        self._remember_ticket(sess)
        parts.append(f"--remote-control '{sess['rcName']}'")
        # Failover (XERK-246): a session moved onto the self-hosted model runs the
        # SAME claude with its endpoint repointed. Read off the record on EVERY
        # launch, so a resume/restart of a failed-over session stays failed over
        # rather than silently going back to the exhausted subscription.
        on_local = sess.get("modelSource") == "local"
        local_env_file = None
        if on_local:
            if local_model_configured():
                local_env_file = write_local_model_env(
                    os.path.join(REGISTRY_DIR, "local-model.env"))
            else:
                # Configuration was removed under a session that was already on
                # local. Launching anyway would hit the subscription without
                # saying so; drop back explicitly and leave the reason visible.
                log(f"launch: session {sess['id']} wants the local model but this "
                    f"host has none configured — launching on the subscription")
                sess["modelSource"] = "subscription"
                on_local = False
                # Persist it: without this sessions.json keeps saying `local`
                # while the session actually runs on the subscription, and the
                # UI mark disagrees with reality until something else saves.
                try:
                    self.save()
                except Exception:
                    pass
                # The configuration is gone, so the key on disk is stale. It
                # lives in a host bind mount, so leaving it there keeps a live
                # credential around indefinitely after a rotation or removal.
                discard_local_model_env(os.path.join(REGISTRY_DIR, "local-model.env"))
        model = sess.get("model")
        # A session on the self-hosted model takes its model from ANTHROPIC_MODEL
        # in the env prefix, and --model OVERRIDES that: launching with both asks
        # the gateway for a Claude alias it will never serve, so every turn 403s
        # ("key not allowed to access model") while the record still reads
        # running/local. The composer remembers a model per repo, so this is the
        # common case, not an exotic one — never re-add --model here for a local
        # session.
        if model and not on_local:
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
        # Tell the agent to fork new work off the LATEST default branch rather
        # than this (possibly stale) checkout — see NEW_WORK_SYSTEM_PROMPT. Rides
        # every launch, including resume: it's session policy, not spawn state.
        # A ticket-backed session extends that policy with the exact branch name
        # reserved for it at spawn (TICKET_BRANCH_PROMPT) — concatenated onto the
        # same flag rather than passed as a second one, since it's a continuation
        # of the same policy, and the reserved name is read from the persisted
        # record so a resume repeats the name spawn chose.
        policy = NEW_WORK_SYSTEM_PROMPT
        ticket = sess.get("ticket") or {}
        if ticket.get("branch"):
            policy += TICKET_BRANCH_PROMPT.format(
                key=ticket.get("key") or "this session's ticket",
                branch=ticket["branch"])
        parts.append(f"--append-system-prompt {shlex.quote(policy)}")
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
        if local_env_file:
            # SOURCED, never inlined and never passed as `tmux -e`: both put the
            # gateway credential into a process's argv, and /proc/<pid>/cmdline
            # is world-readable. Only the file PATH is ever visible; the file
            # itself is 0600. `set -a` exports what it defines to claude and to
            # every tool subprocess it spawns.
            claude_cmd = (f"set -a; . {shlex.quote(local_env_file)}; set +a; "
                          + claude_cmd)
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
            return  # already serving (e.g. an in-process restart keeps ttyd up)
        # Adopt a ttyd of OURS that outlived a *manager* restart: ttyd is its own
        # daemon, so on a native in-place update (systemd KillMode=process /
        # manager-only kill) the old ttyd keeps holding this session's stable
        # port. Re-binding would fail; instead adopt it — its `tmux attach -t
        # <name>` re-resolves to the (same-named) live tmux per browser
        # connection, so it keeps serving with no rebind and no terminal blip.
        # Gate on OUR persisted `ttydPid` still being alive (not the bare port):
        # a fresh spawn has no ttydPid, so a port just freed by a killed session
        # and reallocated here can't be mistaken for a survivor to adopt.
        adopted = sess.get("ttydPid")
        if adopted and _pid_alive(adopted) and _port_open(sess.get("ttydPort")):
            return
        args = [
            "ttyd", "-p", str(sess["ttydPort"]), "-i", "127.0.0.1",
            "-b", f"/term/{sess['id']}", "-W", "-m", "8",
            "-t", 'fontFamily=JBMNerd, "JetBrainsMono Nerd Font Mono", "DejaVu Sans Mono", monospace',
            "-t", "fontSize=14",
            "-t", "rendererType=canvas",
            "-t", "disableLeaveAlert=true",
            # A mouse-tracking app (the Claude TUI is one) takes the drag, so
            # xterm.js only makes a SELECTION when a modifier forces one — the
            # prerequisite for copying any text out at all. That modifier is
            # Shift everywhere except macOS, where xterm.js ignores Shift and
            # honours Alt instead, but only with this option on; it defaults
            # off, so a Mac operator could not select terminal text at all
            # (XERK-7). Costs Mac's Alt+drag column-select, which is what every
            # terminal trades it for.
            "-t", "macOptionClickForcesSelection=true",
            "-c", f"term:{TURMA_TOKEN or 'changeme'}",
            "tmux", "attach", "-t", sess["tmuxName"],
        ]
        try:
            proc = subprocess.Popen(
                args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            self.ttyd[sess["id"]] = proc
            sess["ttydPid"] = proc.pid  # persisted so a later manager can reap it
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
        # Also reap a ttyd we ADOPTED rather than launched (one that outlived a
        # prior manager, so it's not in self.ttyd): the persisted pid is that same
        # live process. Without this, stop/delete would leak the orphan and its
        # port. Best-effort — a recycled/dead pid just fails harmlessly.
        sess = self._find(sid)
        pid = sess.get("ttydPid") if sess else None
        if pid and (proc is None or proc.pid != pid):
            try:
                os.kill(int(pid), signal.SIGTERM)
            except (OSError, ValueError):
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
              model=None, permission_mode=None, ticket=None, ticket_detail=None,
              cmd_id=None, await_clone=None, await_clone_owner=None,
              model_source=None):
        """Create a brand-new worktree-backed session for <repo_name>.

        The worktree is added in DETACHED HEAD forked off the latest default
        branch (or an operator-chosen base) — the app creates NO branch; the
        running agent branches its own work when ready. label is presentational:
        it flavors the claude.ai/code display name but agent-<id> tmux stays the
        canonical internal key. The options (base branch, model, permission mode)
        are validated below; a bad option fails the spawn cleanly as an error
        card rather than reaching git/tmux or crashing the manager.

        ticket is the Jira ticket this session was spawned to work (spawn_ticket's
        caller shape: key/siteKey/url/summary/branch), or None for an ordinary
        session. It is carried on the record rather than acted on here: it names
        the session, rides the heartbeat so the board can link ticket -> session,
        and its reserved `branch` is what _launch_tmux tells the agent to use.

        ticket_detail is the fetched ticket that prompt would be built FROM, and
        a ticket spawn passes it INSTEAD of prompt: the prompt names the ticket's
        downloaded attachments (XERK-242), whose paths are keyed on the session
        id minted here, so it can only be built once provisioning starts — which
        for a queued session is a beat or an on-demand clone later.

        cmd_id is the hub's queued-command id. The session id is minted HERE, so
        the hub has no handle on the session it just asked for until a later
        beat; echoing the command id back on the record (reported as
        `spawnCmdId`) is what lets the UI recognize its own spawn and open it.

        A spawn that can't run RIGHT NOW is no longer refused: it lands as a
        `queued` record and _drain_queue provisions it when a slot frees, the
        clone finishes, or the root slot opens. `await_clone` (a repo name) is
        the ticket-router's promise that this host is cloning that repo — it lets
        the record exist before its repo does, so the session waits for the clone
        instead of failing the unknown-repo check. See _drain_queue."""
        # A root session runs directly at REPOS_ROOT (no worktree/branch). The
        # base option doesn't apply; only one may run at a time.
        is_root = (repo_name == ROOT_REPO_NAME)
        awaiting_clone = False
        if is_root:
            repo = {"name": ROOT_REPO_NAME, "path": REPOS_ROOT}
        else:
            repo = next((r for r in scan_repos() if r["name"] == repo_name), None)
            if not repo:
                if await_clone and repo_name == await_clone:
                    # The repo is being cloned to THIS host on purpose — the
                    # ticket router picked the most-available host in the org and
                    # none had it. Let the record exist against where the clone
                    # will land; _drain_queue waits for the .git dir to appear.
                    repo = {"name": repo_name,
                            "path": os.path.join(REPOS_ROOT, repo_name)}
                    awaiting_clone = True
                else:
                    log(f"spawn refused: unknown repo {repo_name!r}")
                    return
        # Decide run-now vs queue HERE, before the record is appended, so the
        # counts don't include the session we're about to add (a root session
        # would otherwise see itself and always read root-busy; a capacity check
        # would be off by one). Three orthogonal blocks, each re-checked by
        # _drain_queue before it lets the session run:
        #   root-busy — another root session already holds the one root slot;
        #   capacity — the host is at MAX_SESSIONS;
        #   awaiting-clone — the repo is being cloned to this host right now.
        reason = None
        if is_root and self._root_running():
            reason = "root-busy"
        elif self._running_count() >= MAX_SESSIONS:
            reason = "capacity"
        elif awaiting_clone:
            reason = "awaiting-clone"
        sid = self._new_id()
        label = (label or "").strip() or None
        # Prefer a slugged label in the RC display name; fall back to the id.
        rc_slug = slugify(label) if label else ""
        # A ticket-backed session already HAS a good name — the ticket's key and
        # summary, which is what an operator scanning cards is looking for — so it
        # is named here rather than paying a `claude -p` to derive a worse one from
        # the (now ticket-sized) prompt we built. Cleaned like an operator-typed
        # name, not like a model's chatty reply: every word of it is deliberate.
        ticket_summary = None
        if ticket and ticket.get("key"):
            ticket_summary = clean_manual_summary(
                f"{ticket['key']} {ticket.get('summary') or ''}")
        sess = {
            "id": sid,
            "repo": repo["name"],
            "repoPath": repo["path"],
            # Root runs in REPOS_ROOT itself; a repo session gets a fresh worktree.
            "worktreePath": (REPOS_ROOT if is_root
                             else os.path.join(WORKTREES_ROOT, repo["name"], sid)),
            "branch": None,        # app owns no branch; the agent names its own
            "root": is_root,
            # The claude conversation this session IS; pinned by _launch_tmux.
            "claudeSessionId": None,
            "label": label,
            "rcName": f"{slugify(self.device)}-{slugify(repo['name'])}-{rc_slug or sid}",
            "tmuxName": f"agent-{sid}",
            "ttydPort": self._alloc_port(),
            "model": None,                  # resolved --model value (None = omit)
            "permissionMode": "auto",
            # Subscription or the self-hosted model (XERK-246). Spawning
            # straight onto local matters as much as failing an existing
            # session over: when usage runs out you cannot start NEW work
            # either, which is the halt this ticket is about.
            "modelSource": "subscription",
            "baseRef": None,                # base branch the worktree forked from
            # A queued record has no worktree/tmux/ttyd yet — _provision_session
            # (via _drain_queue) makes it real when it's allowed to run.
            "status": "queued" if reason else "running",
            "createdAt": now_iso(),
            "stoppedAt": None,
            "errorMsg": None,
            # Few-word task name: already known for a ticket, else filled in async.
            "summary": ticket_summary,
            # The Jira ticket this session works, or None. Set before the try
            # below so even a spawn that fails validation lands as an error card
            # the board can still tie back to its ticket.
            "ticket": ticket or None,
            # The hub command that asked for this session, echoed back so the UI
            # can correlate its POST with the id we just minted (see docstring).
            "spawnCmdId": cmd_id,
        }
        self.registry.append(sess)
        # Validate every interpolated option BEFORE anything else, so a bad model
        # or permission mode fails the spawn cleanly whether it runs now or waits
        # in the queue. Model and permission mode apply to root too.
        try:
            sess["model"] = resolve_model(model, self.models_available())
            sess["permissionMode"] = resolve_permission_mode(permission_mode)
            sess["modelSource"] = resolve_model_source(model_source)
        except Exception as e:
            self._set_error(sess, e)
            return
        # The base branch and prompt are provisioning inputs; stash them so a
        # queued session (which resolves its base only once its repo exists, e.g.
        # after an on-demand clone) carries them across the wait. Cleared by
        # _provision_session.
        sess["_pendingBaseRef"] = base_ref
        sess["_pendingPrompt"] = prompt
        if ticket_detail is not None:
            sess["_pendingTicketDetail"] = ticket_detail
        if reason:
            sess["queuedReason"] = reason
            sess["queuedAt"] = now_iso()
            # What _drain_queue waits on before provisioning (None once cloned /
            # for a root or capacity wait), plus the owner/repo to re-clone from
            # if the clone job is lost to a manager restart mid-clone.
            if reason == "awaiting-clone":
                sess["awaitClone"] = repo["name"]
                sess["awaitCloneOwner"] = await_clone_owner
            else:
                sess["awaitClone"] = None
            log(f"queued session {sid} for {repo['name']} ({reason}); "
                f"{self._running_count()}/{MAX_SESSIONS} running, "
                f"{self._queued_count()} queued"
                + (f" ticket {ticket['key']}" if ticket else ""))
            return
        self._provision_session(sess)

    def _provision_session(self, sess):
        """Bring a session's record to life: add its worktree, launch claude +
        ttyd, start naming it. This is the second half of a spawn — split out so
        a session that had to WAIT (for a slot, a clone, or the root slot) starts
        through exactly this code rather than a second, divergent path. Called by
        spawn() when a slot is free and by _drain_queue() when one frees up."""
        sid = sess["id"]
        is_root = sess.get("root")
        ticket = sess.get("ticket") or None
        base_ref = sess.pop("_pendingBaseRef", None)
        prompt = sess.pop("_pendingPrompt", None)
        ticket_detail = sess.pop("_pendingTicketDetail", None)
        try:
            resolved_base = None
            if not is_root:
                # A ticket whose branch reservation was deferred (it queued before
                # its repo was cloned, so there was no repo to scan for a free
                # name) reserves it now, against the repo that now exists.
                if ticket and not ticket.get("branch") and ticket.get("key"):
                    ticket["branch"] = self._reserve_ticket_branch(
                        sess["repoPath"],
                        ticket.get("branchBase") or ticket["key"])
                resolved_base = resolve_base_ref(sess["repoPath"], base_ref)
                sess["baseRef"] = resolved_base
                self._worktree_add(sess, base_ref=resolved_base)
            sess["status"] = "running"
            # Shed the queue markers — the record is a live session now.
            for k in ("queuedReason", "queuedAt", "awaitClone", "awaitCloneOwner"):
                sess.pop(k, None)
            if ticket_detail is not None:
                # A ticket session's prompt is built HERE rather than at spawn,
                # because it names the files just pulled off the tracker into
                # this session's own uploads dir (XERK-242).
                prompt = build_ticket_prompt(
                    ticket_detail,
                    self._store_ticket_attachments(
                        sess, ticket_detail.get("attachments")))
            self._launch_tmux(sess, prompt=(prompt or None))
            self._launch_ttyd(sess)
            # Record the worktree -> repo attribution so this session's token
            # usage stays traceable to its repo after it (and its worktree) are
            # gone — the basis of persistent host/repo usage.
            self._remember_usage(sess)
            # Name the session from its initial prompt, once, in the background
            # (no-op when there's no prompt). Never blocks the spawn. Skipped when
            # the session already has a name (a ticket named it at spawn).
            if not sess.get("summary"):
                self._start_summary(sess, prompt)
            wt = os.path.basename(sess["worktreePath"])
            log(f"provisioned session {sid} for {sess['repo']} on :{sess['ttydPort']} "
                + ("(root)" if is_root else
                   f"(detached worktree {wt}"
                   + (f", base {resolved_base}" if resolved_base else "")
                   + ")")
                + (f" label {sess.get('label')!r}" if sess.get("label") else "")
                + (f" ticket {ticket['key']}"
                   + (f" -> branch {ticket['branch']}" if ticket.get("branch") else "")
                   if ticket else ""))
        except Exception as e:
            self._set_error(sess, e)

    def _drain_queue(self):
        """Provision queued sessions that can run now. Runs every heartbeat.

        Oldest first, and at most ONE per beat: provisioning adds a worktree and
        launches claude against the one shared ~/.claude login — exactly the
        contention resume_on_boot staggers — so draining a backlog all at once
        would hammer it. The next beat takes the next one; a poke shortens the
        wait when a kill just freed a slot.

        Head-of-line is skipped, not blocking: a session still waiting on its
        clone doesn't hold up a capacity-only one behind it."""
        if self._running_count() >= MAX_SESSIONS:
            return  # no slot to drain into; nothing below can change that
        for sess in self.registry:
            if sess.get("status") != "queued":
                continue
            if sess.get("root"):
                if self._root_running():
                    continue  # the one root slot is still taken
            elif sess.get("awaitClone"):
                if not os.path.isdir(os.path.join(sess["repoPath"], ".git")):
                    job = self.clones.get(sess["awaitClone"])
                    if job and job.get("status") == "error":
                        # The repo will never arrive — fail the session rather
                        # than wait forever. (A terminal clone job lingers briefly
                        # in self.clones; this catches it before it's pruned.)
                        self._set_error(
                            sess, f"clone of {sess['awaitClone']} failed: "
                                  f"{job.get('error') or 'unknown error'}")
                    elif not job and sess.get("awaitCloneOwner"):
                        # No job at all: the clone was lost to a manager restart
                        # mid-flight. Re-trigger it from the owner we stored.
                        self.clone(sess["awaitCloneOwner"])
                    continue
            self._provision_session(sess)
            return  # one per beat

    def _reserve_ticket_branch(self, repo_path, branch_base):
        """The branch name a new session will be told to use, cut from
        `branch_base` (the ticket key for Jira, a project-prefixed id for Azure —
        see ticket_branch_base).

        "Taken" is the union of two things, and it needs both:
          - what git knows — local heads plus remote branches, after a best-effort
            fetch, so a branch pushed for this ticket from another host (or one
            merged and pruned locally months ago) still counts;
          - what THIS manager has already handed out — a session that hasn't
            branched yet owns its name without git knowing anything about it, so
            two sessions started back-to-back on one ticket must not both be told
            "PROJ-123".

        The fetch is short-bounded like every other spawn-time fetch: this runs on
        the main loop, and offline just means we name against what we have."""
        run_ok(["git", "-C", repo_path, "fetch", "origin"],
               timeout=FETCH_TIMEOUT_SEC)
        taken = branch_names(repo_path)
        for s in self.registry:
            t = s.get("ticket") or {}
            if t.get("branch") and s.get("repoPath") == repo_path:
                taken.add(t["branch"])
        branch = next_ticket_branch(branch_base, taken)
        # The base is already grammar-clean, but this name reaches a command line
        # via the system prompt and the record, so it gets the same allowlist gate
        # as any other ref we hand out.
        if branch and not valid_ref_name(branch):
            return None
        return branch

    def spawn_ticket(self, issue_key, cmd_id=None, model=None):
        """Spawn a session to work a ticket (Jira or Azure DevOps) — the board's
        per-card start button.

        `model` is the operator's per-ticket model pin (XERK-123), an alias the
        hub carries on the command because the model choice is hub-owned durable
        state with no agent-side ledger to read it from. None (unpinned) spawns
        with the login's default model, exactly as before. It is validated the
        same way a composer spawn's model is — resolve_model in spawn() — so a
        model this host can't run fails as an error card rather than silently.

        Everything is re-derived from LOCAL state rather than trusted from the
        command: the hub only chooses which host (an online one reporting the org,
        preferring one with the repo already cloned but falling back to the
        most-available one, which then clones on demand), and a board that is a
        beat or two stale must not be able to spawn against the wrong repo. So the
        repo comes from this host's own triage ledger, and the ticket text comes
        from a fresh fetch rather than the heartbeat's card fields.

        The repo NOT being cloned here is no longer a refusal: this host was
        chosen precisely because it could clone it, so we start the clone and
        queue the session behind it (see spawn's await_clone). Refusals that
        remain log and return — a bad key, no creds, no triaged repo, or a repo
        with no known owner to clone — each one the board's button already
        prevents. A fetch that fails raises to handle_commands, which logs and
        acks."""
        key = (issue_key or "").strip()
        if not valid_issue_key(key):
            log(f"spawnTicket refused: {key[:50]!r} is not a valid issue key")
            return
        # Re-checked here (the hub already targets a host reporting this org) to
        # keep "unset creds = zero board HTTP, ever" a property of the agent rather
        # than of hub-side targeting — same stance as refreshJira.
        if not board_configured():
            log(f"spawnTicket refused: no board credentials on this host ({key})")
            return
        site_key = board_site_key()
        entry = self.triage_ledger.get(_triage_key(site_key, key))
        if not isinstance(entry, dict) or not entry.get("decided") or not entry.get("repo"):
            log(f"spawnTicket refused: {key} has no triaged repo on this host")
            return
        repo_name = entry["repo"]
        # The ledger's `cloned` is as of triage time; scan_repos() is now.
        repo = next((r for r in scan_repos() if r["name"] == repo_name), None)
        await_clone = None
        if not repo:
            # The repo isn't cloned here. The hub routed this ticket to us because
            # we're the most-available host in the org and NO host had it — so
            # clone it on demand and let the session queue behind the clone
            # (_drain_queue provisions it, and reserves its branch, once the .git
            # dir lands). The owner/repo comes from the triage ledger, which
            # recorded it when it chose the repo; without one there is nothing to
            # clone, so refuse before spending a Jira fetch.
            nwo = entry.get("nameWithOwner")
            if not nwo:
                log(f"spawnTicket refused: {key}'s repo {repo_name!r} is not "
                    "cloned here and no owner is known to clone it")
                return
            job = self.clones.get(repo_name)
            if not job or job.get("status") == "error":
                # The ledger's source (when it has one) routes the clone to the
                # right listing; a bare nwo still resolves by search.
                self.clone(nwo, source=entry.get("source"))
            await_clone = repo_name
        # Committed to spawning now — fetch the ticket text for the prompt, and
        # (when the repo already exists) reserve the branch name against it.
        detail = fetch_board_issue(key)
        branch_base = ticket_branch_base(key, detail)
        branch = self._reserve_ticket_branch(repo["path"], branch_base) if repo else None
        ticket = {
            "key": key,
            "siteKey": site_key,
            "url": detail.get("url") or f"https://{site_key}/browse/{key}",
            "summary": (detail.get("summary") or "")[:200],
            # None when the name couldn't be reserved (or was deferred to the
            # clone) — the agent then names its own branch under the ordinary
            # policy, which is worse but not broken.
            "branch": branch,
        }
        # branchBase carries the human-scannable base across a deferred
        # (post-clone) reservation. Omitted when it just equals the key (Jira),
        # so a Jira ticket record is byte-for-byte what it always was.
        if branch_base != key:
            ticket["branchBase"] = branch_base
        # The ticket text goes as the DETAIL, not as a built prompt: the prompt
        # names the attachments this ticket's session downloads for itself, and
        # those land under the session id spawn() is about to mint (XERK-242).
        self.spawn(repo_name, ticket_detail=detail, ticket=ticket,
                   model=model, cmd_id=cmd_id, await_clone=await_clone,
                   await_clone_owner=(entry.get("nameWithOwner") if await_clone
                                      else None))

    def _remember_closed(self, sess):
        """Record a killed session in the closed history so the hub can offer
        to resume it. Bounded: only the newest CLOSED_PER_REPO per repo are
        kept — older records fall off (their branch/transcript still exist,
        they just stop being offered)."""
        rec = {k: sess.get(k) for k in (
            "id", "repo", "repoPath", "worktreePath", "branch", "baseRef",
            "rcName", "tmuxName", "createdAt", "label", "summary",
            "summaryManual", "model", "permissionMode", "root", "ticket",
            # Which model this session was running against (XERK-246). Without
            # it a resume silently returns a failed-over session to the
            # exhausted subscription — and restores its --model alias, which the
            # gateway refuses — with no mark and no error.
            "modelSource",
            # Which conversation this session WAS. Carried so a resume rejoins
            # its own rather than whatever now happens to be newest in a shared
            # project dir (root sessions share one) — see _launch_tmux.
            "claudeSessionId",
        )}
        rec["closedAt"] = now_iso()
        # Snapshot the two things the live caches are about to forget, so the
        # hub's Ended-sessions view can still show what this session did:
        #
        # - prUrls: the PRs it opened. session_pr_urls is keyed by session id and
        #   dropped by _forget_session_caches moments from now, so the URLs have
        #   to move onto the record itself. Their STATUS stays in pr_status_cache
        #   (refresh_pr_status counts these as referenced, so it won't evict them).
        # - transcriptId: which conversation was this session's. Resolved now,
        #   while the worktree→slug mapping is unambiguous, rather than re-derived
        #   later from a path that a delete/prune may since have removed.
        #
        # Both are persisted with the record (closed.json), so they survive a
        # manager restart exactly as the rest of the closed history does.
        rec["prUrls"] = list(self.session_pr_urls.get(sess["id"]) or [])
        rec["transcriptId"] = self._session_transcript_id(sess)
        # Also persist to the durable PR ledger, keyed by the resolved transcript
        # id, so the chips survive this record aging out of closed.json — the one
        # channel left reporting the session then (the resumable scan) reads its
        # PRs from there. _session_pr_urls is still populated (forget runs next).
        self._remember_prs(rec)
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
            "summary": rec.get("summary"),   # keep the name across resume...
            "summaryManual": rec.get("summaryManual"),  # ...pinned if it was typed
            # The ticket (and its reserved branch name) survives a kill/resume:
            # it's what this session IS, and _launch_tmux re-tells the agent the
            # same branch name rather than reserving a fresh one.
            "ticket": rec.get("ticket"),
            # The conversation this session was having, so _launch_tmux rejoins
            # THAT one. Root sessions share a project dir, so "the newest
            # transcript here" is not the same question as "this session's".
            "claudeSessionId": rec.get("claudeSessionId"),
            "rcName": rec.get("rcName"),
            "tmuxName": rec.get("tmuxName") or f"agent-{sid}",
            "ttydPort": self._alloc_port(),  # old port may be taken by now
            "model": rec.get("model"),
            "permissionMode": rec.get("permissionMode") or "auto",
            # Resuming an ended session keeps whichever model it was running
            # against; usage has not come back just because it was killed.
            "modelSource": rec.get("modelSource") or "subscription",
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
        if not transcript_id or not VALID_CLAUDE_SID_RE.fullmatch(transcript_id):
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
        # A resume-any of a session THIS host killed must keep the model it was
        # running against (XERK-246). The dashboard's Resume picker routes here
        # rather than through resume(), and the closed record already knows the
        # answer — without this, resuming a failed-over session silently returns
        # it to the exhausted subscription, which is the halt this exists to
        # prevent. A transcript we have no closed record for (a foreign or
        # pruned one) has no answer, and correctly defaults to subscription.
        # Match on the transcript id first, then on the WORKTREE. "Restart
        # (clear context)" moves a session's claudeSessionId, so its earlier
        # conversations stay resumable while matching no record by id — and
        # resuming one of those would silently return a failed-over session to
        # the exhausted subscription. Every conversation in a worktree belongs
        # to the same lineage, so the closed record for that worktree is the
        # answer for all of them.
        # NEWEST first, for the same reason as the worktree fallback below: a
        # resume-any PINS the resumed transcript id onto the session it creates,
        # so killing that session leaves a SECOND closed record carrying the
        # same id. Append-order would answer with the first one, which is the
        # state before the operator last changed their mind.
        closed = next((c for c in reversed(self.closed)
                       if c.get("claudeSessionId") == transcript_id), None)
        if closed is None and cwd:
            # NEWEST first: self.closed is append-ordered, so a plain next()
            # yields the EARLIEST record for this worktree — a session that was
            # later switched back to the subscription and killed again would be
            # resumed onto the local model anyway, which is this bug in the
            # opposite (and quieter) direction.
            closed = next((c for c in reversed(self.closed)
                           if c.get("worktreePath")
                           and os.path.normpath(c["worktreePath"]) == os.path.normpath(cwd)),
                          None)
        extra = {"modelSource": closed.get("modelSource")} if closed else None
        self._resume_at_cwd(transcript_id, cwd, cmd_id=cmd_id, extra=extra)

    def _resume_at_cwd(self, transcript_id, cwd, *, cmd_id=None, extra=None):
        """Launch `claude --resume <transcript_id>` cwd'd at `cwd`, the shared
        core of resume_transcript (host-local resume-any) and import_session
        (a session migrated in from another agent). The transcript file must
        already be present under PROJECTS_ROOT/<slug(cwd)>/ — resume_transcript
        located it there, import_session unpacked it there. Only a cwd under
        REPOS_ROOT is resumable, and the origin worktree is re-created at the
        EXACT path if missing so its slug matches the transcript and claude
        resolves the id (see resume_transcript's docstring).

        `extra` carries fields a plain resume-any has no source for but a
        migration does — the session's ticket, name, model and mode — so the
        moved session lands looking like its old self rather than an anonymous
        resume. Returns the new session record, or None if it couldn't launch."""
        # Only a cwd under REPOS_ROOT is resumable here — never let a free-form
        # path reach git/tmux.
        cls = self._resumable_cwd_class(cwd, {r["name"] for r in scan_repos()})
        if not cls:
            log(f"resume: cwd {cwd!r} not resumable on this host")
            return None
        repo, _origin, is_root = cls
        cwd = os.path.normpath(cwd)
        if self._running_count() >= MAX_SESSIONS:
            log(f"resume refused: at MAX_SESSIONS ({MAX_SESSIONS})")
            return None
        if is_root and self._root_running():
            log("resume refused: a root session is already running")
            return None
        # One live session per cwd: two claudes in the same dir share a project
        # slug + RC bridge pointer and would collide (the same reason root is
        # single). A worktree resume gets its own dir, so this only bites a repo-
        # dir / repos-root re-resume while one is already up.
        if any(s.get("status") == "running"
               and os.path.normpath(s.get("worktreePath") or "") == cwd
               for s in self.registry):
            log(f"resume refused: a session is already running in {cwd}")
            return None
        repo_path = REPOS_ROOT if is_root else os.path.join(REPOS_ROOT, repo)
        if not is_root and not os.path.isdir(repo_path):
            log(f"resume: repo {repo!r} is gone; cannot resume")
            return None
        extra = extra or {}
        sid = self._new_id()
        sess = {
            "id": sid,
            "repo": repo,
            "repoPath": repo_path,
            "worktreePath": cwd,
            "branch": None,
            "root": is_root,
            # The transcript being resumed IS this session's conversation;
            # _launch_tmux pins it from resume_id.
            "claudeSessionId": None,
            "label": extra.get("label"),
            # A migration carries the moved session's name/ticket/model/mode; a
            # plain resume-any has none of these and seeds the name from the
            # transcript on later beats.
            "summary": extra.get("summary"),
            "summaryManual": extra.get("summaryManual"),
            "ticket": extra.get("ticket"),
            "migratedFrom": extra.get("migratedFrom"),
            "rcName": f"{slugify(self.device)}-{slugify(repo)}-{sid}",
            "tmuxName": f"agent-{sid}",
            "ttydPort": self._alloc_port(),
            "model": extra.get("model"),
            "permissionMode": extra.get("permissionMode") or "auto",
            # A migrated (or resumed-any) session keeps the model it was running
            # against. Validated rather than trusted: it crosses a host boundary,
            # and the TARGET may have no local model configured even though the
            # source did — in which case this falls back to the subscription
            # instead of launching against an endpoint that isn't there.
            "modelSource": (resolve_model_source(extra.get("modelSource"))
                            if extra.get("modelSource") in MODEL_SOURCES
                            and local_model_configured() else "subscription"),
            "baseRef": None,
            "status": "running",
            "createdAt": now_iso(),
            "stoppedAt": None,
            "errorMsg": None,
            "spawnCmdId": cmd_id,
        }
        self.registry.append(sess)
        try:
            # A deleted/pruned Turma worktree (or a migrated session, whose
            # worktree only ever existed on the source host): re-add a detached
            # one at the exact origin path so its slug matches the transcript and
            # claude resolves the id. Repo-dir / repos-root cwds always exist, so
            # this is skipped.
            if not is_root and not os.path.isdir(cwd):
                sess["baseRef"] = resolve_base_ref(repo_path, None)
                self._worktree_add(sess, base_ref=sess["baseRef"])
            self._remember_usage(sess)
            self._launch_tmux(sess, resume=True, resume_id=transcript_id)
            self._launch_ttyd(sess)
            # The transcript already holds this session's history — including any
            # PR it opened before the resume. The per-beat scan primes past that,
            # so re-derive the chips once here (covers migration and resume-any).
            self._seed_prs(sess)
            log(f"resumed transcript {transcript_id} for {repo} in {cwd} "
                f"on :{sess['ttydPort']}")
            return sess
        except Exception as e:
            self._set_error(sess, e)
            return None

    # --- session migration across hosts (XERK-101) ------------------------

    def export_session(self, session_id, migration_id):
        """Source half of a migration: snapshot this running session's raw
        transcript (the ONLY copy that `claude --resume` can replay — the hub's
        archive keeps a rendered projection, not resumable bytes) and ship it to
        the hub's migration relay, which hands it to the chosen target agent.

        The snapshot is truncated to the last complete line so a turn caught
        mid-write can't hand the target a half-JSON tail. The source session
        keeps running until the hub confirms the target is up and queues its
        kill, so any turn that lands after this snapshot survives on the source
        (killed = resumable), never lost."""
        if not migration_id or not VALID_MIGRATION_ID_RE.fullmatch(migration_id):
            log(f"exportSession: bad migration id {migration_id!r}")
            return
        sess = self._find(session_id)
        if not sess:
            log(f"exportSession: no such session {session_id}")
            return
        path = _session_transcript_path(sess)
        if not path or not os.path.isfile(path):
            log(f"exportSession: session {session_id} has no transcript to move")
            return
        try:
            blob = self._pack_transcript(path)
        except Exception as e:
            log(f"exportSession: pack failed for {session_id}: {e}")
            return
        if len(blob) > MIGRATION_BLOB_MAX:
            log(f"exportSession: transcript bundle {len(blob)} bytes exceeds "
                f"{MIGRATION_BLOB_MAX}; migration aborted")
            return
        self._migration_upload(migration_id, blob)

    def import_session(self, cmd):
        """Target half of a migration: pull the transcript bundle the source
        shipped, unpack it under this host's PROJECTS_ROOT at the origin cwd's
        slug, then resume it here carrying the moved session's identity. A NEW
        Turma id/rcName/port is minted like a resume; the transcript id (hence
        the conversation) is preserved, so the target continues in place."""
        migration_id = cmd.get("migrationId")
        transcript_id = cmd.get("transcriptId")
        # The source ships its OWN absolute worktree path; remap it onto this
        # host's REPOS_ROOT so a fleet with differing mounts (WSL-native vs
        # container) can move sessions. Both the slug and the re-created worktree
        # below use this localized cwd, so they stay self-consistent.
        cwd = self._localize_migrated_cwd(cmd.get("cwd"))
        if not migration_id or not VALID_MIGRATION_ID_RE.fullmatch(migration_id):
            log(f"importSession: bad migration id {migration_id!r}")
            return
        if not transcript_id or not VALID_CLAUDE_SID_RE.fullmatch(transcript_id):
            log(f"importSession: bad transcript id {transcript_id!r}")
            return
        # Classify the cwd BEFORE spending a download — a foreign path or a
        # missing repo can't be resumed here, and the hub already vetted the org
        # + repo, so this only trips on a genuinely inconsistent target.
        cls = self._resumable_cwd_class(cwd, {r["name"] for r in scan_repos()})
        if not cls:
            log(f"importSession: cwd {cwd!r} not resumable on this host")
            return
        blob = self._migration_download(migration_id)
        if blob is None:
            log(f"importSession: could not fetch bundle for {migration_id}")
            return
        slug_dir = os.path.join(PROJECTS_ROOT,
                                _project_slug(os.path.normpath(cwd)))
        try:
            os.makedirs(slug_dir, exist_ok=True)
            self._unpack_transcript(blob, slug_dir)
        except Exception as e:
            log(f"importSession: unpack failed for {migration_id}: {e}")
            return
        extra = {
            "ticket": cmd.get("ticket"),
            "summary": cmd.get("summary"),
            "summaryManual": cmd.get("summaryManual"),
            "label": cmd.get("label"),
            "model": cmd.get("model"),
            "permissionMode": cmd.get("permissionMode"),
            "modelSource": cmd.get("modelSource"),
            "migratedFrom": cmd.get("migratedFrom"),
        }
        self._resume_at_cwd(transcript_id, cwd,
                            cmd_id=cmd.get("cmdId"), extra=extra)

    def _pack_transcript(self, path):
        """Bundle a transcript file (+ its subagents/ dir, if any) into gzipped
        tar bytes, laid out relative to the project-slug dir so the target
        unpacks straight into PROJECTS_ROOT/<slug>/: `<id>.jsonl` and, when
        present, `<id>/subagents/...`. The main file is truncated to its last
        complete line."""
        tid = os.path.basename(path)[:-len(".jsonl")]
        with open(path, "rb") as f:
            raw = f.read()
        nl = raw.rfind(b"\n")
        complete = raw[:nl + 1] if nl >= 0 else raw
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            ti = tarfile.TarInfo(name=os.path.basename(path))
            ti.size = len(complete)
            tar.addfile(ti, io.BytesIO(complete))
            sub = _subagents_dir(path)
            if os.path.isdir(sub):
                tar.add(sub, arcname=os.path.join(tid, "subagents"))
        return buf.getvalue()

    def _unpack_transcript(self, blob, dest_dir):
        """Extract a _pack_transcript bundle into dest_dir. A bundle crosses a
        host boundary, so it is never trusted: each member is written by hand to
        a path re-checked to stay inside dest_dir (no tar.extract/extractall,
        which would honour an absolute path, a `..`, or a symlink), and only
        regular files and directories are unpacked."""
        root = os.path.realpath(dest_dir)
        buf = io.BytesIO(blob)
        with tarfile.open(fileobj=buf, mode="r:gz") as tar:
            for m in tar.getmembers():
                parts = m.name.split("/")
                if m.name.startswith("/") or os.path.isabs(m.name) or ".." in parts:
                    raise ValueError(f"unsafe tar member {m.name!r}")
                out = os.path.join(dest_dir, m.name)
                if os.path.realpath(out) != root and \
                        not os.path.realpath(out).startswith(root + os.sep):
                    raise ValueError(f"tar member escapes dest {m.name!r}")
                if m.isdir():
                    os.makedirs(out, exist_ok=True)
                elif m.isreg():
                    os.makedirs(os.path.dirname(out), exist_ok=True)
                    src = tar.extractfile(m)
                    if src is None:
                        continue
                    with src, open(out, "wb") as f:
                        shutil.copyfileobj(src, f)
                # anything else (symlink/device/fifo) is silently skipped

    def _migration_upload(self, migration_id, blob):
        """POST a transcript bundle to the hub's migration relay (octet-stream,
        agent-authed). Best-effort: a failure leaves the migration to time out
        hub-side rather than raising into the command loop."""
        try:
            headers = {"Content-Type": "application/octet-stream",
                       "User-Agent": "hub-agent/1.0"}
            if TURMA_TOKEN:
                headers["Authorization"] = f"Bearer {TURMA_TOKEN}"
            url = (f"{TURMA_URL}/api/agents/"
                   f"{urllib.parse.quote(self.device, safe='')}"
                   f"/migrations/{urllib.parse.quote(migration_id, safe='')}/blob")
            req = urllib.request.Request(url, data=blob, headers=headers,
                                         method="POST")
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp.read()
            log(f"migration {migration_id}: uploaded {len(blob)} bytes")
        except Exception as e:
            log(f"migration upload failed for {migration_id}: {e}")

    def _migration_download(self, migration_id):
        """GET a transcript bundle from the hub's migration relay. Returns the
        raw bytes, or None on any failure."""
        try:
            headers = {"User-Agent": "hub-agent/1.0"}
            if TURMA_TOKEN:
                headers["Authorization"] = f"Bearer {TURMA_TOKEN}"
            url = (f"{TURMA_URL}/api/agents/"
                   f"{urllib.parse.quote(self.device, safe='')}"
                   f"/migrations/{urllib.parse.quote(migration_id, safe='')}/blob")
            req = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except Exception as e:
            log(f"migration download failed for {migration_id}: {e}")
            return None

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
            # A message queued for the pre-restart conversation is contextually
            # gone with it — never re-inject it into the fresh one (XERK-47).
            sess.pop("pendingInputs", None)
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

    def set_model_source(self, sid, source):
        """Move a running session between the subscription and the self-hosted
        model, KEEPING its conversation (XERK-246).

        This is the failover: when Claude usage runs out every session on the
        host stops at once, and the work should continue rather than halt.

        It relaunches with `--resume <this session's transcript id>` — the same
        path a container restart already uses — so the session carries on in the
        SAME conversation with the same worktree, branch and uncommitted work.
        Nothing is exported, summarised or handed over; only the endpoint the
        next request goes to changes.

        Deliberately NOT `restart` (which clears context): failing over is the
        moment you least want to lose what the session has already worked out.

        Also deliberately NOT deferred on a busy pane, unlike `set_model`: the
        turn in flight is usually the one erroring on exhausted usage, and
        waiting for it to finish would withhold the switch exactly when it is
        needed. The cost is that a genuinely productive turn is discarded — the
        conversation survives, so the work is re-askable."""
        sess = self._find(sid)
        if not sess:
            log(f"setModelSource: no such session {sid}")
            return
        if sess.get("status") != "running":
            log(f"setModelSource: session {sid} not running")
            return
        try:
            source = resolve_model_source(source)
        except ValueError as e:
            self._set_error(sess, e)
            return
        if sess.get("modelSource", "subscription") == source:
            return                                  # already there; no relaunch
        previous = sess.get("modelSource", "subscription")
        if source == "local":
            # set_model refuses a local session, so a pick waiting for an idle
            # pane would be silently discarded later. Drop it now rather than
            # leave it heartbeat-visible and then unexplained.
            sess.pop("pendingModel", None)
        sess["modelSource"] = source
        try:
            self._kill_tmux(sess)      # ends claude; tmux/ttyd are re-made below
            self._clear_question_files(sid)  # the old claude's question dies with it
            # Resume THIS session's own conversation. _launch_tmux reads
            # modelSource (set above) to decide the endpoint.
            self._launch_tmux(sess, resume=True)
            self._launch_ttyd(sess)
            sess["errorMsg"] = None
            # Same role as restartCount: the only heartbeat-visible proof the
            # relaunch actually happened, so the UI can drop its spinner on a
            # fact instead of a timer.
            sess["restartCount"] = sess.get("restartCount", 0) + 1
            sess["modelSourceAt"] = now_iso()
            log(f"session {sid} moved from {previous} to {source} model")
        except Exception as e:
            sess["modelSource"] = previous          # never claim a move that failed
            self._set_error(sess, e)
        self.save()

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
        # The files the operator attached to this conversation go with it — the
        # conversation that named their paths is no longer resumable (XERK-234).
        shutil.rmtree(upload_dir_for(sid), ignore_errors=True)
        self._forget_session_caches(sid)
        log(f"deleted session {sid}")

    # --- on-demand input/history (glasses client) --------------------------

    def _download_upload(self, upload_id):
        """GET one staged attachment's bytes from the hub's upload relay
        (agent-authed, like the migration bundle). Returns the bytes, or None on
        any failure — the caller names the file in the message rather than
        pretending it arrived."""
        try:
            headers = {"User-Agent": "hub-agent/1.0"}
            if TURMA_TOKEN:
                headers["Authorization"] = f"Bearer {TURMA_TOKEN}"
            url = (f"{TURMA_URL}/api/agents/"
                   f"{urllib.parse.quote(self.device, safe='')}"
                   f"/uploads/{urllib.parse.quote(str(upload_id), safe='')}/blob")
            req = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(
                    req, timeout=UPLOAD_DOWNLOAD_TIMEOUT_SEC) as resp:
                return resp.read(UPLOAD_MAX_BYTES + 1)
        except Exception as e:
            log(f"upload {upload_id}: download failed: {e}")
            return None

    def _store_uploads(self, sess, uploads):
        """Write a message's attachments into this session's uploads directory.

        Returns (paths, failed_names): the absolute paths that landed, and the
        names of any that didn't. Bounded by UPLOAD_MAX_PER_MESSAGE and
        UPLOAD_MAX_BYTES — the hub caps both too, but this is the side that
        writes to the disk."""
        paths, failed = [], []
        try:
            os.makedirs(upload_dir_for(sess["id"]), mode=0o700, exist_ok=True)
        except Exception as e:
            log(f"uploads: cannot create the directory for session "
                f"{sess.get('id')}: {e}")
            return [], [safe_upload_name((u or {}).get("name"))
                        for u in (uploads or [])[:UPLOAD_MAX_PER_MESSAGE]]
        dirpath = upload_dir_for(sess["id"])
        for item in (uploads or [])[:UPLOAD_MAX_PER_MESSAGE]:
            if not isinstance(item, dict):
                continue
            name = safe_upload_name(item.get("name"))
            blob = self._download_upload(item.get("id"))
            if blob is None:
                failed.append(name)
                continue
            if len(blob) > UPLOAD_MAX_BYTES:
                log(f"upload {item.get('id')}: {len(blob)} bytes is past "
                    f"UPLOAD_MAX_BYTES ({UPLOAD_MAX_BYTES}); not writing it")
                failed.append(name)
                continue
            path = _unique_upload_path(dirpath, name)
            try:
                _write_new_file(path, blob)
                paths.append(path)
                log(f"session {sess['id']}: attached {len(blob)} bytes as {path}")
            except Exception as e:
                log(f"upload {item.get('id')}: write to {path} failed: {e}")
                failed.append(name)
        return paths, failed

    def _store_ticket_attachments(self, sess, attachments):
        """Pull a ticket's own files off the tracker into this session's uploads
        directory (XERK-242), returning (paths, failed_names) like _store_uploads.

        Same destination as a chat attachment on purpose: ~/.turma/uploads/<id>,
        never the worktree (a file dropped in the repo reads as the uncommitted
        work `prune`/`delete` key on), pre-approved for Read by the guard, and
        already swept/deleted with the session that owns it.

        Nobody picked these file by file — a ticket can carry a screen recording
        as easily as a screenshot — so the caps are the point: at most
        TICKET_ATTACH_MAX files, TICKET_ATTACH_MAX_BYTES each and
        TICKET_ATTACH_TOTAL_BYTES together, all of it inside one
        TICKET_ATTACH_DEADLINE_SEC wall clock (this blocks the manager's beat).
        A file whose REPORTED size is already past the cap is skipped without
        spending the download. Total by construction: this runs inside a spawn,
        and a ticket whose files can't be fetched still gets its session (with
        the misses named in the prompt)."""
        items = [a for a in (attachments or []) if isinstance(a, dict)][:TICKET_ATTACH_MAX]
        if not items:
            return [], []
        paths, failed, budget = [], [], TICKET_ATTACH_TOTAL_BYTES
        deadline = time.monotonic() + TICKET_ATTACH_DEADLINE_SEC
        dirpath = upload_dir_for(sess["id"])
        try:
            os.makedirs(dirpath, mode=0o700, exist_ok=True)
        except Exception as e:
            log(f"ticket attachments: cannot create the directory for session "
                f"{sess.get('id')}: {e}")
            return [], [safe_upload_name(a.get("name")) for a in items]
        for item in items:
            name = safe_upload_name(item.get("name"))
            size = item.get("size")
            cap = min(TICKET_ATTACH_MAX_BYTES, budget)
            if isinstance(size, int) and size > cap:
                log(f"ticket attachment {name}: {size} bytes is past the "
                    f"{cap}-byte budget; not downloading it")
                failed.append(name)
                continue
            left = deadline - time.monotonic()
            if left <= 0:
                log(f"ticket attachment {name}: past the "
                    f"{TICKET_ATTACH_DEADLINE_SEC}s download budget; skipping it")
                failed.append(name)
                continue
            # Both bounds go in: the per-file timeout caps how long we wait for
            # the next byte, `deadline` caps the batch however slowly they come.
            blob = fetch_board_attachment(
                item.get("url"), cap, timeout=min(TICKET_ATTACH_TIMEOUT_SEC, left),
                deadline=deadline)
            if blob is None:
                failed.append(name)
                continue
            path = _unique_upload_path(dirpath, name)
            try:
                _write_new_file(path, blob)
            except Exception as e:
                log(f"ticket attachment {name}: write to {path} failed: {e}")
                failed.append(name)
                continue
            budget -= len(blob)
            paths.append(path)
            log(f"session {sess['id']}: ticket attachment {len(blob)} bytes as {path}")
        return paths, failed

    def _sweep_uploads(self):
        """Drop attachment directories for sessions this agent no longer knows
        about, once they are past UPLOAD_RETENTION_SEC. A live or resumable
        session's files stay: its conversation still names their paths, and a
        resumed session re-reading one must find it there.

        Deliberately mtime-based and bounded to the unknown ids — the ledger of
        what is resumable lives elsewhere, and deleting a file a transcript
        points at is the one mistake here that can't be undone."""
        if not os.path.isdir(UPLOADS_DIR):
            return
        live = {s.get("id") for s in self.registry}
        live |= {c.get("id") for c in self.closed}
        now = time.time()
        for entry in os.listdir(UPLOADS_DIR):
            if entry in live:
                continue
            path = os.path.join(UPLOADS_DIR, entry)
            try:
                if not os.path.isdir(path):
                    continue
                if now - os.path.getmtime(path) < UPLOAD_RETENTION_SEC:
                    continue
                shutil.rmtree(path, ignore_errors=True)
                log(f"uploads: swept {path} (no such session, past retention)")
            except Exception as e:
                log(f"uploads: sweep of {path} failed: {e}")

    def send_input(self, sid, text, uploads=None):
        """Type free-text into a running session's Claude TUI and submit it.
        This is the plain "type a message into the session" path (the chat
        composer's Send, the glasses actions menu, the PR-comment delivery);
        AskUserQuestion answers no longer ride it — they go through
        answer_question below. See _type_into_pane for how the text lands.

        A message past INPUT_MAX_CHARS is REFUSED, never clipped to it
        (XERK-227): the operator has no way to tell a delivered stub from the
        whole message, so half a message is worse than none — and the hub, which
        caps at the `inputMaxChars` this agent heartbeats, has already refused it
        with an error the composer shows. This is the backstop for a caller that
        didn't.

        `uploads` are the files the operator attached to this message (XERK-234):
        they are written to disk HERE, before anything is typed, and the message
        that goes into the pane carries their paths (see attachment_message). The
        composed text is what lands on the outbox, so a compaction resend re-types
        the same paths at files that are already there."""
        sess = self._find(sid)
        if not sess or sess.get("status") != "running":
            return
        text = _clean_input_text(text)
        # What the operator actually typed, kept aside before the attachment
        # header is folded in: it is what names an unnamed session below, and a
        # name built out of upload paths would say nothing about the task.
        typed = text
        if uploads:
            paths, failed = self._store_uploads(sess, uploads)
            # Nothing landed and nothing was typed: there is no message to send,
            # and a bare "an attachment failed" turn would just confuse the
            # session. The failure is in the log where the operator can see it.
            if not paths and not failed and not text.strip():
                return
            text = _clean_input_text(attachment_message(paths, failed, text))
        if not text.strip():
            return
        if len(text) > INPUT_MAX_CHARS:
            log(f"refused a {len(text)}-char message for session {sid}: past "
                f"INPUT_MAX_CHARS ({INPUT_MAX_CHARS}); sending nothing rather "
                f"than a truncated message")
            return
        # Name a still-unnamed session (bare/quick spawn or repos-root, where the
        # spawn-time summary was a no-op for lack of an initial prompt) from its
        # first typed prompt — this message is our next chance. Deliberately the
        # FIRST attempt only: this is a fast path that saves waiting a beat for
        # _seed_summaries, and later attempts belong there, where the transcript
        # still names the session from its first prompt rather than from whatever
        # turn happens to be typed when a retry comes due.
        if (typed.strip() and not sess.get("summary")
                and _summary_attempts(sess) == 0 and sid not in self.summaries):
            self._start_summary(sess, typed)
        _type_into_pane(sess["tmuxName"], text)
        # Record it on the session's outbox so _poll_pending_inputs can confirm it
        # landed and re-send it if a compaction drops it (XERK-47). `attempts:1`
        # counts this first type; a resend needs a fresh compaction to fire again.
        pend = sess.setdefault("pendingInputs", [])
        pend.append({"text": text, "at": time.time(), "attempts": 1})
        del pend[:-PENDING_INPUT_MAX]
        self.save()

    def _poll_pending_inputs(self):
        """Confirm each session's recently-sent messages landed and re-send any a
        compaction dropped (XERK-47). See _pending_scan and the send_input outbox.

        Runs every beat but short-circuits on a session with an empty outbox, so a
        settled fleet pays one dict lookup per session. For a session that has an
        outbox: read its transcript once, then for each queued message —
          - drop it once it appears as a genuine user turn (delivered);
          - leave it while it is still in the live queue (in-flight, will land);
          - once a NEW compaction has happened since it was sent AND the pane has
            settled to idle (so anything the compaction was going to keep has
            already been consumed — this is what makes the resend duplicate-safe),
            re-type it, up to PENDING_INPUT_MAX_ATTEMPTS, one resend per beat;
          - drop it if it ages past PENDING_INPUT_TTL_SEC never having landed
            (lost to something other than a compaction — out of this fix's scope).
        """
        now = time.time()
        for sess in self.registry:
            pend = sess.get("pendingInputs")
            if not pend:
                continue
            if sess.get("status") != "running":
                # Nothing to type into, and the record is meaningless once the
                # session ends — drop it.
                sess.pop("pendingInputs", None)
                self.save()
                continue
            path = _session_transcript_path(sess)
            if not path or not os.path.exists(path):
                continue
            delivered, queued, compactions = _pending_scan(path)
            tmux_name = sess.get("tmuxName")
            # Only judge a message "lost" once the pane is settled: True=busy,
            # False=idle, None=unknown (uncapturable) — treat anything but a
            # confirmed idle as "wait", so a transient capture failure or an
            # in-progress turn never triggers a resend.
            idle = _pane_busy(tmux_name) is False
            keep, changed, resent = [], False, False
            for item in pend:
                text = (item.get("text") or "")
                stripped = text.strip()
                if "compactBase" not in item:
                    # Baseline the compaction count the FIRST time we see this
                    # message, and persist it now: a resend fires only when the
                    # count rises above this, so a restart that lost an unsaved
                    # baseline (re-taken post-compaction) would miss the resend.
                    item["compactBase"] = compactions
                    changed = True
                base = item["compactBase"]
                if stripped in delivered:
                    changed = True          # landed — reap it
                    continue
                if stripped in queued:
                    keep.append(item)       # in-flight — leave it
                    continue
                if compactions > base and idle:
                    # A compaction fired since this was sent and the pane is idle,
                    # yet it is neither a delivered turn nor still queued: the
                    # compaction ate it. Re-send (bounded), one per beat.
                    if item.get("attempts", 1) >= PENDING_INPUT_MAX_ATTEMPTS:
                        changed = True
                        log(f"gave up re-sending a compaction-dropped message "
                            f"in session {sess['id']}")
                        continue
                    if resent:
                        keep.append(item)   # already re-sent one this beat
                        continue
                    _type_into_pane(tmux_name, text)
                    item["attempts"] = item.get("attempts", 1) + 1
                    item["compactBase"] = compactions  # only a NEWER compaction re-loses it
                    item["at"] = now
                    resent = changed = True
                    keep.append(item)
                    log(f"re-sent a message dropped by compaction in "
                        f"session {sess['id']}")
                    continue
                if now - item.get("at", now) > PENDING_INPUT_TTL_SEC:
                    changed = True          # never landed, no compaction — give up
                    log(f"pending message expired unconfirmed in "
                        f"session {sess['id']}")
                    continue
                keep.append(item)           # still in-flight (busy, or awaiting a beat)
            if changed:
                trimmed = keep[-PENDING_INPUT_MAX:]
                if trimmed:
                    sess["pendingInputs"] = trimmed
                else:
                    sess.pop("pendingInputs", None)
                self.save()

    def interrupt(self, sid):
        """Stop a running session's in-flight turn without ending the session:
        send Escape to its Claude TUI — exactly the key an operator sitting at
        the live terminal would press. Claude Code cancels the generation or
        tool call in flight and drops back to the prompt with the conversation
        intact, so the session stays running and can be typed at again. This is
        the gentle counterpart to kill (which ends the session) and restart
        (which clears its context).

        Deliberately NOT gated on paneBusy: that read is up to a beat stale by
        the time the operator clicks Stop, and Escape into an idle pane is
        harmless (it clears whatever is half-typed on the input line), so
        refusing on a stale idle read would break the case the button is for."""
        sess = self._find(sid)
        if not sess or sess.get("status") != "running":
            return
        run(["tmux", "send-keys", "-t", sess["tmuxName"], "Escape"])
        log(f"interrupted session {sid}")

    def answer_pane_prompt(self, sid, number):
        """Answer the blocking choice dialog a session's TUI is showing (a tool
        permission request or a plan approval — see parse_pane_prompt) by typing
        its option digit, exactly the key an operator at the live terminal would
        press. This is what makes the dialog answerable from the chat page
        instead of only from the raw terminal.

        The pane is RE-READ first and the number checked against what is
        actually on screen right now. That is the whole safety property: the
        heartbeat a click was made against is up to a beat stale, and by the
        time it lands the dialog may be gone — typing a bare digit into a live
        composer would silently prepend a stray character to the operator's next
        message. So a stale answer is dropped rather than sent."""
        sess = self._find(sid)
        if not sess or sess.get("status") != "running":
            return
        try:
            number = int(number)
        except (TypeError, ValueError):
            return
        prompt = parse_pane_prompt(_capture_pane(sess.get("tmuxName")))
        if not prompt:
            log(f"pane-prompt answer for {sid} dropped: no dialog on screen")
            return
        if not any(o["number"] == number for o in prompt["options"]):
            log(f"pane-prompt answer {number} for {sid} dropped: not an option")
            return
        run(["tmux", "send-keys", "-t", sess["tmuxName"], str(number)])
        log(f"answered pane prompt for session {sid}: option {number}")

    def set_summary(self, sid, summary):
        """Rename a session: replace the auto-generated few-word name the card
        leads with by one the operator typed. Works on a stopped session too (the
        name is presentational — no process is touched), and is persisted like the
        auto name, so it survives beats, restart and resume.

        A manual name pins the card: `summaryManual` stops _finish_summary from
        clobbering it should a naming job still be in flight, and _summary_due
        already declines to start new ones while a session has any name. A blank
        rename clears the name — the card falls back to the label/worktree, and
        auto-naming resumes if the session still has attempts left, which is the
        only way back to it."""
        sess = self._find(sid)
        if not sess:
            return
        name = clean_manual_summary(summary)
        sess["summary"] = name
        sess["summaryManual"] = bool(name)
        if name:
            sess.pop("summaryRetryAt", None)
        self.save()
        log(f"renamed session {sid} -> {name!r}" if name
            else f"cleared name of session {sid}")

    def set_model(self, sid, model):
        """Switch a running session's model live — for THIS SESSION ONLY — by
        driving Claude Code's /model picker: open it, arrow to the chosen row,
        and press `s` ("use this session only").

        It used to type `/model <name>`, which looks equivalent and isn't: the
        argument form ALSO saves the pick as the login-wide default for new
        sessions, and every session on the host shares that one login — so
        switching one session's model silently changed what "Default" meant for
        every future session on every host (XERK-33). The picker's `s` is the
        only session-scoped switch the CLI exposes, so the picker is driven for
        real: capture the pane, find the target row and the ❯ cursor, press the
        arrows between them. A pane the picker never appears on, or a picker
        with no row for the target (the bracketed 1M aliases have none), is
        Escaped out of and logged — the record keeps the real model, and the
        heartbeat corrects the UI's optimistic guess.

        Two reliability fixes ride along: the input line is cleared (C-u)
        first, so a half-typed operator prompt can't fuse with the command into
        garbage; and a FRESH busy read gates the whole thing — typed into a
        mid-turn pane the command would only be queued as a prompt, so it is
        refused (log-only) rather than misfired. Unlike interrupt(), which
        tolerates a stale idle read because Escape is harmless, this path types
        into the pane, so it checks the pane NOW rather than trusting the
        beat-old paneBusy."""
        sess_early = self._find(sid)
        # A session on the self-hosted model takes its model from ANTHROPIC_MODEL
        # (XERK-246). The picker only lists the LOGIN's Claude aliases — none of
        # which the gateway will serve — and "Default" resolves to the login
        # default, so every row here breaks the session with a 403 on the next
        # turn, nothing in errorMsg, and no row to switch back to.
        if sess_early and sess_early.get("modelSource") == "local":
            log(f"set_model: session {sid} runs on the self-hosted model; "
                f"its model is fixed by the host configuration")
            return
        sess = self._find(sid)
        if not sess or sess.get("status") != "running":
            return
        # None for default, else a validated alias (static or probed); raises on
        # junk. The alias never reaches a command line here (the picker is
        # arrow-driven), but the same allowlist keeps the two paths honest.
        resolved = resolve_model(model, self.models_available())
        arg = resolved or "default"
        tmux_name = sess["tmuxName"]
        if _pane_busy(tmux_name):
            # DEFER, don't drop: the click used to be refused log-only here,
            # which read as the button doing nothing. The pending pick is
            # persisted, heartbeated (so the chip can say it's switching), and
            # applied by _apply_pending_switches on the first idle beat.
            sess["pendingModel"] = arg
            self.save()
            log(f"set model of {sid} -> {arg}: turn in flight; deferred until idle")
            return
        sess.pop("pendingModel", None)
        run(["tmux", "send-keys", "-t", tmux_name, "C-u"])
        run(["tmux", "send-keys", "-t", tmux_name, "-l", "--", "/model"])
        run(["tmux", "send-keys", "-t", tmux_name, "Enter"])
        rows, cur = [], None
        for _ in range(MODEL_PICKER_TRIES):
            time.sleep(MODEL_PICKER_WAIT_SEC)
            rows, cur = parse_model_picker(_capture_pane(tmux_name) or "")
            if rows:
                break
        if not rows or cur is None:
            # No picker appeared (or no cursor to navigate from): back out.
            # The pane was idle a moment ago, so Escape lands on the prompt (or
            # closes a half-painted picker) and destroys nothing.
            run(["tmux", "send-keys", "-t", tmux_name, "Escape"])
            log(f"set model of {sid} -> {arg}: /model picker did not appear")
            self.save()
            return
        # Arrow toward the target ONE press at a time, re-reading the ❯ before
        # the next. The old burst of abs(target-cur) presses trusted every key
        # to land exactly once — a dropped or doubled key put the cursor one
        # row off and `s` then silently selected the WRONG model. Here a
        # dropped key just means the next read still shows the gap (press
        # again), and a doubled one flips the press direction; MAX_STEPS bounds
        # a cursor that never converges.
        steps = 0
        while True:
            target = _picker_index_for(rows, resolved)
            if target is None:
                run(["tmux", "send-keys", "-t", tmux_name, "Escape"])
                log(f"set model of {sid} -> {arg}: picker offers no such row "
                    f"({', '.join(rows)})")
                self.save()
                return
            if cur == target:
                break
            if steps >= MODEL_PICKER_MAX_STEPS:
                run(["tmux", "send-keys", "-t", tmux_name, "Escape"])
                log(f"set model of {sid} -> {arg}: cursor never reached the row "
                    f"(at {cur} after {steps} presses)")
                self.save()
                return
            run(["tmux", "send-keys", "-t", tmux_name,
                 "Down" if target > cur else "Up"])
            steps += 1
            rows, cur = self._await_picker_step(tmux_name, rows, cur)
            if not rows or cur is None:
                run(["tmux", "send-keys", "-t", tmux_name, "Escape"])
                log(f"set model of {sid} -> {arg}: picker vanished mid-navigation")
                self.save()
                return
        run(["tmux", "send-keys", "-t", tmux_name, "-l", "s"])
        # The record updates only on the TUI's own confirmation — "Set model
        # to X for this session only" (or "Kept model as X" when the row was
        # already current). Unconfirmed, the record keeps the old value and the
        # transcript scan's modelActual settles what the chip shows either way.
        if self._await_model_confirmation(tmux_name):
            sess["model"] = resolved
            self.save()
            log(f"set model of {sid} -> {arg} (session only, confirmed)")
        else:
            self.save()
            log(f"set model of {sid} -> {arg}: selection sent but no "
                f"confirmation read; record unchanged (modelActual will settle it)")

    def _await_picker_step(self, tmux_name, rows, prev_cur):
        """Poll the picker after an arrow press until the ❯ moves off prev_cur,
        returning the fresh (rows, cur). On timeout returns the LAST read even
        if unmoved — the caller's loop just presses again, bounded by
        MAX_STEPS — and ([], None) when the picker is gone entirely."""
        for _ in range(MODEL_STEP_TRIES):
            time.sleep(MODEL_STEP_WAIT_SEC)
            rows, cur = parse_model_picker(_capture_pane(tmux_name) or "")
            if not rows:
                return [], None
            if cur is not None and cur != prev_cur:
                return rows, cur
        return rows, cur

    def _await_model_confirmation(self, tmux_name):
        """Whether the picker's selection visibly landed: poll for the TUI's
        own "Set model to…"/"Kept model as…" line (MODEL_CONFIRM_RE)."""
        for _ in range(MODEL_CONFIRM_TRIES):
            time.sleep(MODEL_CONFIRM_WAIT_SEC)
            cap = _capture_pane(tmux_name)
            if cap and MODEL_CONFIRM_RE.search(cap):
                return True
        return False

    def _apply_pending_switches(self):
        """Apply model switches that arrived while their session's pane was
        mid-turn (set_model defers them as sess['pendingModel']). Runs each
        beat; set_model re-defers if a new turn has started, so a pick chases
        the first idle moment instead of being dropped."""
        for sess in list(self.registry):
            pend = sess.get("pendingModel")
            if not pend or sess.get("status") != "running":
                continue
            if _pane_busy(sess["tmuxName"]):
                continue
            sess.pop("pendingModel", None)
            try:
                self.set_model(sess["id"], pend)
            except Exception as e:
                log(f"deferred model switch for {sess['id']} failed: {e}")
                self.save()

    def set_mode(self, sid, mode):
        """Switch a running session's permission mode live as a CLOSED LOOP:
        press Shift+Tab (BTab), read the footer's mode marker back
        (parse_pane_mode), repeat until the target reads back or the cycle
        wraps to where it started.

        It used to compute a press count against `perm_cycle_for`'s guessed
        cycle — but the real cycle is account- AND model-dependent (auto joins
        it when the account enables it, even on a bypass-launched session where
        the guess says it's absent, and drops out for models that can't do
        auto), and the record's idea of "current" goes stale the moment the
        operator cycles by hand in the terminal. Every one of those made a
        computed count land on the wrong mode. Reading the marker after each
        press needs none of that knowledge: the loop stops ON the target, a
        wrap back to the start proves the target isn't in this session's cycle
        (a logged no-op), and what's STORED is always what was read, so the
        record can't lie.

        No busy gate, deliberately: BTab types nothing into the input line and
        the TUI cycles modes mid-generation (verified live), with the marker
        staying visible throughout. Falls back to the old computed presses only
        when the marker can't be read at all (a TUI wording this parser
        predates)."""
        sess = self._find(sid)
        if not sess or sess.get("status") != "running":
            return
        target = resolve_permission_mode(mode)  # validated enum; raises on junk
        tmux_name = sess["tmuxName"]
        cur = parse_pane_mode(_capture_pane(tmux_name))
        if cur is None:
            self._set_mode_blind(sess, target)
            return
        start, presses = cur, 0
        while cur != target and presses < MODE_CYCLE_MAX_PRESSES:
            run(["tmux", "send-keys", "-t", tmux_name, "BTab"])
            presses += 1
            nxt = self._await_mode_step(tmux_name, cur)
            if nxt is None:
                log(f"set mode of {sid}: marker unreadable after {presses} "
                    f"presses; keeping last read {cur!r}")
                break
            cur = nxt
            if cur == start:
                break  # full wrap: the target isn't in this session's cycle
        sess["permissionMode"] = cur  # what was READ, not what was wanted
        self.save()
        if cur == target:
            log(f"set mode of {sid} -> {target} ({presses} Shift+Tab, read back)")
        else:
            log(f"set mode of {sid}: {target} not reached (cycle read back "
                f"{cur!r} after {presses} presses); record keeps the real mode")

    def _await_mode_step(self, tmux_name, prev):
        """Poll the pane after a BTab until its mode marker reads differently
        from `prev` (the repaint landed), returning the new mode — or None when
        it never reads back (pane gone / marker wording changed mid-flight).
        A press that shows the SAME mode after the wait window reads as None
        too: with every real cycle ≥3 modes, BTab can never map a mode to
        itself, so an unmoved marker means the read is not to be trusted."""
        for _ in range(MODE_STEP_TRIES):
            time.sleep(MODE_STEP_WAIT_SEC)
            nxt = parse_pane_mode(_capture_pane(tmux_name))
            if nxt and nxt != prev:
                return nxt
        return None

    def _set_mode_blind(self, sess, target):
        """The pre-closed-loop fallback for a pane whose mode marker can't be
        read: presses computed against perm_cycle_for's guessed cycle from the
        record's stored mode. Kept only for TUIs whose footer wording this
        build's parser doesn't know; wrong whenever the guess is (see
        set_mode's docstring), which is why it is no longer the primary path."""
        sid = sess["id"]
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
        log(f"set mode of {sid} -> {target} ({presses} Shift+Tab, blind)")

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

    def answer_question(self, sid, option_index, custom, option_indices=None):
        """Answer a session's pending AskUserQuestion by dropping the answer file
        the ask.py bridge is polling for. option_index is 0-based into the
        question's options (or -1 for a free-text / "Other" answer carried in
        custom); option_indices is the multiSelect equivalent (a list of picks).
        Only writes when a request file is actually pending, so a stray answer
        for a session with no live question is a no-op. Written atomically
        (temp + replace) so the blocked hook never reads a partial."""
        sess = self._find(sid)
        if not sess or sess.get("status") != "running":
            return
        req_path, ans_path = self._question_paths(sid)
        if not os.path.exists(req_path):
            return  # nothing waiting on this session
        # A multiSelect answer carries a list of picks; a single-select one a
        # lone index. Sanitize the list and prefer it when non-empty.
        idxs = None
        if isinstance(option_indices, list):
            idxs = []
            for v in option_indices:
                try:
                    n = int(v)
                except (TypeError, ValueError):
                    continue
                if n >= 0 and n not in idxs:
                    idxs.append(n)
        try:
            idx = int(option_index)
        except (TypeError, ValueError):
            idx = -1
        has_text = isinstance(custom, str) and bool(custom.strip())
        answer = {}
        if idxs is not None and idxs:
            answer["optionIndices"] = idxs
            answer["optionIndex"] = idxs[0]  # compat for a single-answer reader
        else:
            answer["optionIndex"] = idx
            if idx < 0 and not has_text:
                return  # no option and no text — nothing to answer with
        if has_text:
            answer["custom"] = custom[:INPUT_MAX_CHARS]
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
        path = _session_transcript_path(sess) if sess else None
        if not path:
            self.history_results.append(
                {"sessionId": sid, "entries": [], "truncated": False,
                 "queued": []}
            )
            return
        # _history_entries caps internally (operator messages exempt, XERK-186)
        # — re-slicing here would evict the exempt rows it folded back in.
        entries, truncated, queued = _history_entries(path)
        self.history_results.append({
            "sessionId": sid,
            "entries": entries,
            "truncated": truncated,
            # Still-queued prompts (typed mid-turn, not yet consumed) so the
            # chat's /history fallback shows them like the live tail does.
            "queued": queued,
        })

    def _stage_subagent_history(self, sid, agent_type, label):
        """Handle a {type:"subagentHistory"} command: resolve the clicked pane
        agent-list row (type + label) to its background-agent transcript and
        stage a bounded read for the next heartbeat (subagentHistoryResults).
        The row key (sessionId+type+label) is echoed back so the hub can match
        the delivery to the outstanding request. Any miss (unknown session,
        unresolved agent, absent file) stages an empty result rather than
        raising — a poison row must not take down the heartbeat loop."""
        result = {"sessionId": sid, "type": agent_type or "",
                  "label": label or "", "entries": [], "truncated": False}
        sess = self._find(sid)
        main = _session_transcript_path(sess) if sess else None
        path = _resolve_subagent(main, agent_type, label) if main else None
        if not path:
            self.subagent_history_results.append(result)
            return
        # Subagents take no operator input, so their queued list is dropped.
        entries, truncated, _ = _history_entries(path)
        result["entries"] = entries
        result["truncated"] = truncated
        self.subagent_history_results.append(result)

    def set_jira_repo(self, issue_key, repo, auto=False, site_key=None):
        """Handle a {type:"setJiraRepo"} command: the operator's own answer to
        "which repo does this ticket belong in", overriding the model's guess.

        Three outcomes, matching the three the board can ask for:
          auto=True     -> drop the entry entirely, releasing the pin. The ticket
                           re-triages from scratch on a later beat with a FULL
                           attempt budget, which is what "use the AI guess again"
                           has to mean — reusing a spent budget could leave a
                           cleared ticket permanently unguessed.
          repo=None     -> a manual "no repo fits" (the muted chip). Explicit, and
                           deliberately distinct from auto=True: the operator
                           asserting nothing fits is an ANSWER, not an absence.
          repo="<name>" -> pin that repo.

        The name is allowlist-checked against this host's own candidates, exactly
        like the model's reply in _parse_triage, and the recorded repo/cloned/
        nameWithOwner are read off the CANDIDATE — never off the request. The
        operator is more trustworthy than the model, but the request still arrives
        over HTTP, and a value that only ever renders as a chip has no business
        being anything but a name this host already knows.

        An unknown repo is refused rather than recorded: a name this host can't
        offer is one its picker never showed, so it is a bug or a stale client, and
        recording it would paint a chip for a repo that doesn't exist here."""
        k = (issue_key or "").strip()
        if not valid_issue_key(k):
            log(f"setJiraRepo: ignoring bad issue key {k[:50]!r}")
            return
        mine = self.jira.get("siteKey")
        if not mine:
            log(f"setJiraRepo: no board org on this host, ignoring {k}")
            return
        # The hub routes by siteKey, so a mismatch means the command reached the
        # wrong host. Filing it under our own org would corrupt a ledger key that
        # another host's board is reading.
        if site_key and site_key != mine:
            log(f"setJiraRepo: {k} is for {site_key!r}, not this host's {mine!r}")
            return
        lkey = _triage_key(mine, k)
        if auto:
            if self.triage_ledger.pop(lkey, None) is None:
                return
            self._save_triage_ledger()
            self._apply_triage()
            log(f"setJiraRepo: {k} released back to auto triage")
            return
        entry = {"decided": True, "manual": True, "at": now_iso(), "reason": ""}
        if repo is None:
            entry.update({"repo": None, "cloned": False, "nameWithOwner": None})
        else:
            cand = next((c for c in (self.triage_cands or [])
                         if c.get("name") == repo), None)
            if cand is None:
                log(f"setJiraRepo: refusing non-candidate repo {str(repo)[:80]!r} for {k}")
                return
            entry.update({"repo": cand["name"], "cloned": bool(cand.get("cloned")),
                          "nameWithOwner": cand.get("nameWithOwner"),
                          "source": cand.get("source")})
        self.triage_ledger[lkey] = entry
        self._prune_triage_ledger()
        self._save_triage_ledger()
        self._apply_triage()
        log(f"setJiraRepo: {k} -> {entry['repo'] or 'no repo'} (manual)")

    def _jira_payload(self):
        """The jira block as it ships: what the poll returned, plus the repo
        choices the board's manual picker offers (`repoOptions`).

        Composed here rather than stamped onto self.jira because collect_jira
        builds fresh dicts on every poll — the same reason _apply_triage has to
        re-stamp the guesses. It stays out of collect_jira itself, which owns only
        what Jira told us; repos are this host's knowledge, not Jira's.

        Only the name and clone state ride: the picker labels a repo and marks
        whether it's here, and the candidates' descriptions (up to 200 × 120 chars)
        would be dead weight on every beat for a tooltip nobody reads. An
        unconfigured host has no board and ships nothing extra."""
        if not self.jira.get("configured"):
            return self.jira
        opts = [{"name": c["name"], "cloned": bool(c.get("cloned")),
                 "nameWithOwner": c.get("nameWithOwner"),
                 "source": c.get("source")}
                for c in (self.triage_cands or [])]
        return dict(self.jira, repoOptions=opts)

    def _stage_jira_issue(self, key):
        """Handle a {type:"jiraIssue"} command: fetch that issue's full detail
        and stage it for the next heartbeat payload (jiraIssueResults). Every
        failure path stages a result carrying an `error` rather than raising —
        the board is waiting on this key, so it needs an answer either way, and
        a poison key must not take down the heartbeat loop."""
        k = (key or "").strip()
        if not valid_issue_key(k):
            self.jira_issue_results.append(
                {"key": k[:50], "issue": None, "error": "not a valid issue key"})
            return
        if not board_configured():
            self.jira_issue_results.append(
                {"key": k, "issue": None, "error": "no board credentials on this host"})
            return
        try:
            issue = fetch_board_issue(k)
            self.jira_issue_results.append({"key": k, "issue": issue, "error": None})
        except Exception as e:
            log(f"board issue fetch failed for {k}: {e}")
            self.jira_issue_results.append(
                {"key": k, "issue": None, "error": str(e)[:200]})

    def set_board_status(self, cmd_id, issue_key, value, category=None):
        """Handle a {type:"setTicketStatus"} command: push a status change to the
        configured board (Jira/Azure) — the one thing Turma writes back to a
        board (XERK-138). The outcome is staged keyed by the command's cmdId so
        the panel that requested it can poll for its own answer.

        The target is either an exact option `value` (the detail panel's picker)
        or a board `category` — todo/inprogress/review/done — the operator
        dropped a card onto (XERK-141). Either way it is re-validated against a
        FRESH read of the available options, never trusted from the client (the
        same stance set_jira_repo takes against the repo picker): the request
        arrives over HTTP, and the board's own workflow, not the browser, decides
        what a ticket can move to. A `category` is resolved to a transition HERE,
        against that fresh read, so a drag never carries a stale transition id.

        On success it also re-fetches the issue and stages it into
        jira_issue_results, so the hub's issue cache carries the new status +
        the transitions available FROM it, and the panel's re-read is instant."""
        k = (issue_key or "").strip()
        result = {"cmdId": cmd_id, "key": k[:50], "ok": False, "error": None}

        def stage(err=None, **extra):
            if err is not None:
                result["error"] = err
            result.update(extra)
            self.ticket_status_results.append(result)

        if not valid_issue_key(k):
            return stage("not a valid issue key")
        if not board_configured():
            return stage("no board credentials on this host")
        v = str(value or "").strip()
        col = str(category or "").strip().lower()
        if not v and not col:
            return stage("no status given")
        try:
            opts = board_status_options(k)
        except Exception as e:
            log(f"status options fetch failed for {k}: {e}")
            return stage(f"couldn't read available statuses: {str(e)[:150]}")
        # A drop names a column; resolve it to a concrete transition against the
        # fresh options before the exact-id validation below runs unchanged.
        if not v:
            match = _status_option_for_column(opts, col)
            if match is None:
                label = _COLUMN_LABEL.get(col, col or "there")
                return stage(f"nothing can move it to {label}")
            v = match["id"]
        match = next((o for o in opts if o.get("id") == v), None)
        if match is None:
            return stage("that status is no longer an available change")
        try:
            apply_board_status(k, v)
        except Exception as e:
            log(f"status change failed for {k}: {e}")
            return stage(str(e)[:200])
        # Refresh the cached detail so the panel's re-read shows the new status
        # and the transitions now available from it (best-effort: the change
        # already landed, so a failed re-read doesn't fail the command).
        try:
            issue = fetch_board_issue(k)
            self.jira_issue_results.append({"key": k, "issue": issue, "error": None})
        except Exception as e:
            log(f"post-change issue re-fetch failed for {k}: {e}")
        log(f"setTicketStatus: {k} -> {match['name']}")
        stage(ok=True, status=match["name"], statusCategory=match["category"])

    # --- New-ticket creation (XERK-137) -----------------------------------
    # The board's create form. Two staged results, same fail-into-`error`
    # discipline as _stage_jira_issue (the form is waiting on an answer either
    # way): the metadata a form open needs, and the outcome of a create POST.

    def _stage_create_meta(self, project):
        """Handle a {type:"boardCreateMeta"} command. With no `project`, stage the
        project + label choices (createMetaResults, no `project` key); with one,
        stage that project's issue/work-item types (a `project`-keyed result). A
        failure stages the same shape carrying an `error`."""
        proj = (project or "").strip()
        if not board_configured():
            self.create_meta_results.append(
                {"project": proj or None,
                 "error": "no board credentials on this host"})
            return
        try:
            if proj:
                self.create_meta_results.append(
                    {"project": proj, "types": board_issue_types(proj), "error": None})
            else:
                meta = board_create_meta()
                self.create_meta_results.append({
                    "project": None,
                    "projects": meta.get("projects") or [],
                    "labels": meta.get("labels") or [],
                    "source": meta.get("source"),
                    "error": None,
                })
        except Exception as e:
            log(f"board create meta failed ({proj or 'projects'}): {e}")
            self.create_meta_results.append(
                {"project": proj or None, "error": str(e)[:200]})

    def _stage_create_ticket(self, cmd):
        """Handle a {type:"createTicket"} command: create the ticket and stage the
        outcome keyed by the command's cmdId (so the hub can hand the created key
        back to the one client that submitted it). Validated defensively even
        though the hub already checked — this is the only thing between a request
        and a write to the tracker."""
        cid = cmd.get("cmdId")
        summary = (cmd.get("summary") or "").strip()[:CREATE_TITLE_MAX_CHARS]
        project = (cmd.get("project") or "").strip()
        issue_type = (cmd.get("issueType") or "").strip()
        description = (cmd.get("description") or "")[:CREATE_DESC_MAX_CHARS]
        labels = [str(l).strip() for l in (cmd.get("labels") or [])
                  if str(l).strip()][:CREATE_LABELS_MAX]

        def fail(msg):
            self.create_ticket_results.append(
                {"cmdId": cid, "key": None, "url": None, "error": msg})

        # A ticket that lands UNASSIGNED is a success the operator must still be
        # told about: the board filters on the tracker user, so it is created
        # and then invisible there, which reads exactly like a create that
        # didn't happen.
        def unassigned_warning(created):
            # The reason comes from the creator, which is the only layer that
            # knows what it tried and what the tracker said back. Telling the
            # operator to "set AZDO_USER" is worse than useless here — it is
            # already a candidate, and being refused is how we got here.
            why = str(created.get("assignError") or "").strip()
            return ("created, but it couldn't be assigned to you, so it won't "
                    "show on your board" + (f" — {why}" if why else ""))

        if not board_configured():
            return fail("no board credentials on this host")
        if not summary:
            return fail("a title is required")
        if not project:
            return fail("a project is required")
        if not issue_type:
            return fail("an issue type is required")
        try:
            created = create_board_issue(project, issue_type, summary,
                                         description, labels)
            self.create_ticket_results.append(
                {"cmdId": cid, "key": created.get("key"),
                 "url": created.get("url"), "error": None,
                 "warning": None if created.get("assigned")
                            else unassigned_warning(created)})
            log(f"created ticket {created.get('key')} in {project}")
        except Exception as e:
            log(f"ticket creation failed in {project}: {e}")
            fail(str(e)[:300])

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

    def _carded_slugs(self):
        """Project slugs backing ANY registry session, running or stopped — the
        ones that already have a session card of their own, with its own Start.
        _resumable_report skips these so the picker never offers to resume a
        session the hub is already showing."""
        slugs = set()
        for s in self.registry:
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

    def _localize_migrated_cwd(self, cwd):
        """Remap a migrated session's origin worktree path from the SOURCE host's
        REPOS_ROOT onto THIS host's, so a fleet whose hosts mount their git root
        at DIFFERENT paths (a WSL-native agent at /home/<user>/git vs a container
        at /mnt/data/Docker/git) can still move sessions between them.

        XERK-101 originally assumed one shared REPOS_ROOT across the fleet, so it
        handed the target the source's absolute worktree path verbatim — which
        `_resumable_cwd_class` then rejected as foreign whenever the mounts
        differed, wedging every such migration in `importing` forever.

        A migration is always a worktree session (the hub's /migrate guard
        rejects root), so the path always ends `.../.turma/worktrees/<repo>/<dir>`
        — a REPOS_ROOT-independent tail that rebuilds under the LOCAL
        WORKTREES_ROOT. Returns the local-equivalent path, or the input unchanged
        when it already sits under this host's REPOS_ROOT (the same-mount fleet,
        untouched) or carries no recognizable worktree tail (left for the caller
        to reject as foreign)."""
        if not cwd:
            return cwd
        norm = os.path.normpath(cwd)
        local_root = os.path.normpath(REPOS_ROOT)
        if norm == local_root or norm.startswith(local_root + os.sep):
            return norm  # already under this host's REPOS_ROOT — nothing to remap
        marker = os.sep + os.path.join(".turma", "worktrees") + os.sep
        idx = norm.find(marker)
        if idx < 0:
            return cwd  # not a worktree path we recognize; caller rejects it
        rel = norm[idx + len(marker):].split(os.sep)
        if len(rel) != 2 or not rel[0] or not rel[1]:
            return cwd  # not <repo>/<dir>; leave it for the caller to reject
        return os.path.join(WORKTREES_ROOT, rel[0], rel[1])

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

        Returns repo-name -> [{transcriptId, cwd, repo, root, origin, slug,
        summary, endedTs}] newest-first."""
        # Slugs already represented by a session card (running or stopped). This
        # is the scan-time cut; because the scan is cached across the slow beats
        # between refreshes, _sorted_repo_entries() re-applies it against
        # registry every beat — see the filter there.
        carded = self._carded_slugs()
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
                if not VALID_CLAUDE_SID_RE.fullmatch(tid):
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
                    # Reported, not dropped: it picks the summary source below,
                    # and _sorted_repo_entries()'s per-beat carded filter keys on it.
                    "slug": slug,
                    "mtime": mtime,        # dropped below; sort/cap key
                })
        sess_meta = self._session_meta_by_slug()
        for repo, lst in by_repo.items():
            # Cap by mtime (a cheap stat, already in hand) so the accurate
            # last-message read below is paid only for the survivors. mtime can
            # be inflated by a file copy, but that only ever KEEPS a transcript
            # that a truthful key would have dropped — never the reverse — so the
            # cap stays a safe superset; the hub sorts the survivors by endedTs.
            lst.sort(key=lambda e: e["mtime"], reverse=True)
            del lst[RESUMABLE_PER_REPO:]
            for e in lst:
                path = os.path.join(PROJECTS_ROOT, e["slug"], e["transcriptId"] + ".jsonl")
                sm = sess_meta.get(e["slug"], {})
                e["summary"] = sm.get("summary") or _first_user_text(path)
                # The last new message's own timestamp, not the file mtime — see
                # _last_activity_ts. Falls back to mtime only when the transcript
                # carries no timestamped entry.
                e["endedTs"] = _last_activity_ts(path) or time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime(e["mtime"]))
                # Which Jira ticket this conversation was spawned to work, or None
                # for the ordinary session. This scan is re-derived from the
                # transcripts on disk, which know nothing of tickets, so it is the
                # durable ledger that re-attaches the two — and this is the only
                # channel still reporting a session once its record has aged out
                # of closed.json (see TICKET_LEDGER_PATH).
                e["ticket"] = self.ticket_ledger.get(e["transcriptId"])
                # The PRs this conversation opened, from the durable PR ledger —
                # same story as the ticket above. This scan is the only channel
                # still reporting a session once its closed record has aged out,
                # so without the ledger its PR chips would be lost for good (a
                # resumable row has no record to have snapshotted them onto).
                e["prs"] = self._ledger_prs(e["transcriptId"])
                e.pop("mtime", None)
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
            if m.get("internal"):
                continue  # the manager's own claude -p helper, never archived (XERK-27)
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
                    "path": path,
                    "createdAt": sm.get("createdAt"),
                    "summary": sm.get("summary"),
                })
        out.sort(key=lambda m: m["mtime"], reverse=True)
        out = out[:ARCHIVE_MANIFEST_MAX]
        for m in out:
            # The last new message's own timestamp, not the file mtime (XERK-73) —
            # the archive orders and dates its rows by this, so a synced/restored
            # transcript with an inflated mtime must not read as recently ended.
            # Paid only for the capped survivors. Falls back to mtime.
            m["endedTs"] = _last_activity_ts(m["path"]) or time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime(m["mtime"]))
            m.pop("mtime", None)   # internal sort key; not part of the payload
            m.pop("path", None)
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
                        # _entry_id, not the raw uuid: a pr-link entry has none,
                        # and the archived row's synthesized id must match the
                        # live feeds' so the viewer keys cards the same way.
                        "uuid": _entry_id(entry),
                        "role": _entry_role(entry),
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
        self.refresh_git_sources()

    def refresh_git_sources(self):
        """Refresh the extra clone sources' listings (XERK-155), on the same
        cadence as the gh sweep. Keep-last-good per source: a failed sweep
        records the error but leaves the previous repos standing — a transient
        must not blank the board's uncloned candidates (the same reason
        _refresh_triage_candidates only updates from a successful gh sweep)."""
        collectors = {"azure": collect_azure_repos, "gitlab": collect_gitlab_repos}
        for src, state in self.git_sources.items():
            try:
                state["repos"] = collectors[src]()
                state["available"] = True
                state["error"] = None
            except Exception as e:
                state["error"] = str(e)[:200]
                log(f"{src} repo listing failed: {e}")

    def _git_sources_payload(self):
        """The heartbeat's `gitSources` block (XERK-155): the EXTRA clone
        sources beyond GitHub — clients render the legacy `github` block as the
        GitHub section and append these, so the repo list is never carried
        twice. cloneUrl is stripped: the hub and clients identify a repo by
        (source, nameWithOwner) and the agent re-resolves the URL from its own
        cached listing at clone time, so no URL ever round-trips."""
        labels = {"azure": normalize_azure_site(AZDO_URL) or "Azure DevOps",
                  "gitlab": gitlab_host() or "GitLab"}
        users = {"azure": AZDO_USER or None, "gitlab": None}
        out = []
        for src in ("azure", "gitlab"):
            state = self.git_sources.get(src)
            if not state:
                continue
            out.append({
                "source": src, "label": labels[src],
                "available": bool(state.get("available")),
                "user": users[src], "error": state.get("error"),
                "repos": [
                    {k: v for k, v in dict(r, source=src).items()
                     if k != "cloneUrl"}
                    for r in state.get("repos") or []],
            })
        return out

    def _resolve_clone_source(self, spec, source=None):
        """Resolve a requested repo to (source, listing entry): the exact
        (source, nameWithOwner) the UI's picker sent, or a bare nameWithOwner
        from an older hub / the triage ledger — searched github first (the
        legacy meaning of a bare owner/repo), then each extra source in a fixed
        order so a cross-source name collision resolves deterministically.
        (None, None) when nothing in the cached listings matches."""
        spec = (spec or "").strip().strip("/")
        if spec.endswith(".git"):
            spec = spec[:-len(".git")]
        order = [source] if source else ["github", "azure", "gitlab"]
        for src in order:
            if src == "github":
                for r in (self.github or {}).get("repos") or []:
                    if r.get("nameWithOwner") == spec:
                        return "github", r
            else:
                for r in (self.git_sources.get(src) or {}).get("repos") or []:
                    if r.get("nameWithOwner") == spec:
                        return src, r
        return None, None

    def refresh_jira(self):
        """Refresh the cached assigned-tickets block from the configured source
        (Jira or Azure DevOps). Fail-open the pr_status way, not the github-block
        way: a fetch error KEEPS the prior tickets/fetchedAt and only records the
        error string, so a transient hiccup degrades the board to stale-but-shown
        (with the error surfaced) rather than blanking it until the next slow beat."""
        try:
            self.jira = collect_board()
        except Exception as e:
            log(f"board refresh failed: {e}")
            prev = dict(self.jira)
            prev["error"] = _board_error_summary(e)
            self.jira = prev
        # Re-stamp cached repo guesses onto the freshly-collected tickets: a
        # collect_jira() builds new ticket dicts, so without this every beat that
        # refreshed would blank the board's repo chips until the next triage.
        self._apply_triage()

    def refresh_pr_status(self):
        """Refresh cached state + CI checks for the PRs live sessions opened, via
        `gh pr view`. Slow-ish cadence, best-effort; skipped when gh has no
        login. Only RUNNING sessions' PRs are re-polled (bounded by
        PR_STATUS_MAX so a host with many PRs never stalls the beat), but a
        stopped session keeps its last-known status — cache entries are pruned
        only when NO session (running or not) references them anymore, so a
        killed session's card still shows the merged/closed state it reached.

        "No session" spans the closed history too: a killed session is dropped
        from the registry but keeps its own `prUrls` snapshot (_remember_closed),
        and the hub's Ended-sessions view renders those chips. Without counting
        them as referenced, the very act of killing a session would evict the PR
        status its ended card is about to show.

        GitLab merge requests (XERK-162) and Azure DevOps pull requests
        (XERK-226) refresh through the same sweep: each URL is polled only
        through the source that can answer for it (_pr_source_ok), so a gh-less
        GitLab or ADO host still refreshes its own, and a host without that
        source doesn't burn beats on PRs it can't see."""
        if not (self.github.get("available") or gitlab_configured()
                or azure_configured()):
            return
        referenced, wanted, seen = set(), [], set()
        for sess in self.registry:
            urls = self.session_pr_urls.get(sess["id"], [])
            referenced.update(urls)
            if sess.get("status") != "running":
                continue
            for url in urls:
                if url not in seen and self._pr_source_ok(url):
                    seen.add(url)
                    wanted.append(url)
        # Closed records are never re-polled — same rule as a stopped session,
        # whose last-known status is what its card has always shown.
        for rec in self.closed:
            referenced.update(rec.get("prUrls") or [])
        # Every ledgered PR too: an ended session aged out of closed.json is
        # reported only through the resumable scan, which reads its links from
        # the ledger — so its last-known status has to survive this sweep the
        # same way a killed session's does, or its ended card shows a bare link.
        for entry in self.pr_ledger.values():
            referenced.update((entry or {}).get("urls") or [])
        changed = False
        for url in list(self.pr_status_cache):
            if url not in referenced:
                del self.pr_status_cache[url]
                changed = True
        for url in wanted[:PR_STATUS_MAX]:
            st = pr_status(url)
            if st is not None:
                self.pr_status_cache[url] = st
                changed = True
        # Persist the refreshed status so the pill survives a restart. An ended
        # session's PR is never re-polled, so without this its state/CI degrades
        # to a bare link the moment the in-memory cache is lost.
        if changed:
            self._save_pr_status_ledger()

    def _pr_source_ok(self, url):
        """Whether THIS host can fetch status/comments for a PR/MR url: a
        GitLab merge request needs the configured GITLAB_URL to cover it, an
        Azure DevOps pull request the configured AZDO_URL, anything else the gh
        login. What can't be fetched keeps its last-known status (or a bare link
        chip) rather than costing calls."""
        if MR_URL_RE.match(str(url or "")):
            return _mr_url_parts(url) is not None
        if AZDO_PR_URL_RE.match(str(url or "")):
            return _azdo_pr_id(url) is not None
        return bool(self.github.get("available"))

    def _session_prs(self, sid):
        """The PR-status objects for a session's known PR links, newest last
        (the order they were scraped). Each is the cached `gh pr view` summary,
        or a bare {url} until the next status refresh fills it in. None when the
        session has opened no PR."""
        urls = self.session_pr_urls.get(sid)
        if not urls:
            return None
        return [self.pr_status_cache.get(u) or {"url": u} for u in urls]

    def _poll_pr_comments(self):
        """Deliver new PR review activity into the RUNNING session that opened
        the PR (XERK-49): a reply asking for corrections is typed into that
        session so the agent continues the work, with no operator relaying it.

        Only running sessions, only their OWN PRs (`session_pr_urls`, the same
        map the status pill reads). Delivery goes through send_input, so it
        inherits the whole compose path — the compaction-survival outbox
        (XERK-47) if the message lands mid-turn, and the queue if a turn is in
        flight — exactly like an operator typing the correction by hand.

        Each PR carries a per-session `prCommentBase` seen-key set. The FIRST
        time a PR is seen its whole current comment set is baselined silently:
        the session shouldn't re-litigate history (or, on the beat this feature
        deploys, every existing comment on every open PR). After that, only keys
        that are NEW *and* not the agent's own writing are delivered. The
        session's own comments are still folded into the seen-set so they are
        never mistaken for someone else's on a later beat.

        Best-effort and bounded: each URL polls only through the source that
        can answer for it (_pr_source_ok — gh for GitHub PRs, the configured
        GitLab for MRs (XERK-162), the configured Azure DevOps org for its own
        PRs (XERK-226)), capped at PR_COMMENTS_MAX PRs per beat, and a fetch
        failure leaves that PR's baseline untouched (a fetch error is not
        evidence the comments vanished)."""
        if not PR_COMMENTS_DELIVER or not (
                self.github.get("available") or gitlab_configured()
                or azure_configured()):
            return
        self_login = self.github.get("login") or ""
        polled = 0
        for sess in self.registry:
            if sess.get("status") != "running":
                continue
            urls = self.session_pr_urls.get(sess["id"]) or []
            if not urls:
                continue
            base = sess.get("prCommentBase")
            if not isinstance(base, dict):
                base = {}
            changed = False
            for url in urls:
                if not self._pr_source_ok(url):
                    continue
                if polled >= PR_COMMENTS_MAX:
                    break
                polled += 1
                events = _pr_comment_events(url, self_login)
                if events is None:
                    continue                       # fetch failed — keep baseline
                seen = set(base.get(url) or [])
                first = url not in base
                fresh = [e for e in events
                         if e["key"] not in seen and not e["is_self"]]
                # Fold EVERY current key (self-authored included) into the seen
                # set — a first sighting baselines them all; later beats only add
                # the newcomers. Cap newest-kept so a chatty PR can't grow it
                # without bound.
                keys = [e["key"] for e in events]
                merged = list(seen) + [k for k in keys if k not in seen]
                base[url] = merged[-PR_COMMENTS_SEEN_MAX:]
                changed = True
                if first or not fresh:
                    continue
                msg = _pr_comment_message(url, fresh)
                if msg:
                    self.send_input(sess["id"], msg)
            if changed:
                sess["prCommentBase"] = base
                self.save()

    def _poll_prs_landed(self):
        """Stamp WHEN a session's PRs all landed, so "merging IS the review" can
        expire (XERK-224).

        The Ready-for-review rule demotes a session whose every PR reached
        MERGED/CLOSED — the operator merged it, so it goes back to Idle to be
        parked until the build is verified. But a session is a conversation, not
        a pull request: give the same session a NEW task after that merge and it
        will finish new work with no new PR to show for it, and the landed one
        would hide it forever.

        So the demotion is scoped in TIME rather than being absolute. This
        records the session's own last-activity timestamp at the moment the
        sweep first sees every PR landed; `_session_payload` then reports
        `newWorkSincePrs` = "the conversation has moved past that point", and the
        clients fall through to the finished-turn signal when it has.

        Both sides of that comparison are transcript timestamps (the
        conversation's clock), never wall time or file mtime, so a synced
        ~/.claude or a clock skew can't fake progress. Runs straight off the
        status the PR sweep just refreshed, like `_poll_pr_conflicts` — no
        network call of its own.

        A newly opened PR clears the stamp: the session is back to having
        something unlanded, and whenever THAT lands it gets a fresh mark rather
        than being measured against the previous round."""
        for sess in self.registry:
            urls = self.session_pr_urls.get(sess["id"]) or []
            if not urls:
                continue
            states = [(self.pr_status_cache.get(u) or {}).get("state") for u in urls]
            # Only decide once every PR has a fetched state: an unfetched one is
            # "not looked at", and treating it as landed would stamp too early.
            landed = all(s in ("MERGED", "CLOSED") for s in states) if all(states) else False
            if not landed:
                if sess.pop("prsLandedTs", None) is not None:
                    self.save()
                continue
            if sess.get("prsLandedTs"):
                continue                        # already marked; don't move it
            path = _session_transcript_path(sess)
            ts = _last_activity_ts(path) if path else None
            if not ts:
                continue                        # no dated entry to measure from
            sess["prsLandedTs"] = ts
            self.save()

    def _poll_pr_conflicts(self):
        """Tell a running session to resolve the merge conflicts on its OWN PR,
        without an operator relaying it (XERK-223).

        Runs straight off the status the PR sweep just refreshed
        (`pr_status_cache`), so it costs no network call of its own: the
        conflict is already known the moment a card can render it. Delivery is
        send_input, so it inherits the compose path exactly like an operator
        typing the fix request by hand — the compaction-survival outbox
        (XERK-47) and the queue when a turn is in flight.

        Per (session, PR) episode bookkeeping lives on the record as
        `prConflicts` = {url: {at, attempts}}:

          - CONFLICTING on an OPEN/DRAFT PR arms the episode. The first sighting
            nudges; later beats re-nudge only past PR_CONFLICT_RETRY_SEC and
            only while attempts remain, so a session that tried and failed isn't
            told the same thing every beat.
          - MERGEABLE, or a PR that is no longer open, CLEARS the episode — the
            conflict is proven gone, and a conflict that comes back later gets a
            fresh budget.
          - UNKNOWN clears nothing and nudges nothing. Mergeability is computed
            lazily server-side, so UNKNOWN is what a just-pushed resolution
            looks like while GitHub recomputes; treating it as resolved would
            hand a still-conflicted PR an unbounded supply of retries.

        Only RUNNING sessions: a nudge is a message typed into a live TUI, and
        there is nobody to receive it otherwise (an ended session's conflicting
        PR stays for a human, same scope as PR-comment delivery)."""
        if not PR_CONFLICT_RESOLVE:
            return
        now = time.time()
        for sess in self.registry:
            if sess.get("status") != "running":
                continue
            urls = self.session_pr_urls.get(sess["id"]) or []
            if not urls:
                continue
            eps = sess.get("prConflicts")
            if not isinstance(eps, dict):
                eps = {}
            changed = False
            for url in urls:
                st = self.pr_status_cache.get(url) or {}
                mergeable = st.get("mergeable")
                open_ = st.get("state") in ("OPEN", "DRAFT")
                if not open_ or mergeable == "MERGEABLE":
                    if eps.pop(url, None) is not None:
                        changed = True          # resolved (or landed): re-arm
                    continue
                if mergeable != "CONFLICTING":
                    continue                    # UNKNOWN / not fetched yet
                ep = eps.get(url) or {"attempts": 0, "at": 0}
                attempts = int(ep.get("attempts") or 0)
                if attempts >= PR_CONFLICT_MAX_ATTEMPTS:
                    continue
                if attempts and now - float(ep.get("at") or 0) < PR_CONFLICT_RETRY_SEC:
                    continue
                msg = _pr_conflict_message(url, st.get("base"), again=bool(attempts))
                eps[url] = {"attempts": attempts + 1, "at": now}
                changed = True
                log(f"pr conflict: nudging {sess['id']} to resolve {url} "
                    f"(attempt {attempts + 1})")
                self.send_input(sess["id"], msg)
            # Drop episodes for PRs this session no longer owns, so the record
            # can't accumulate them for the life of a long session.
            for stale in [u for u in eps if u not in urls]:
                del eps[stale]
                changed = True
            if changed:
                if eps:
                    sess["prConflicts"] = eps
                else:
                    sess.pop("prConflicts", None)
                self.save()

    def clone(self, repo_spec, source=None):
        """Clone a repo into REPOS_ROOT so it joins the scanned repo list.

        Launched as a DETACHED subprocess and reaped by _poll_clones on later
        beats — `git clone` can take minutes and must never block the heartbeat
        loop (a blocked loop would make the hub mark the host offline).

        The spec is resolved against the cached source listings first
        (_resolve_clone_source), so a listed Azure DevOps or GitLab repo clones
        from the URL its own API reported — never one built from the request.
        Anything unlisted falls back to the legacy free-text GitHub path,
        validated to a bare owner/repo. Auth: GitHub rides the system git
        credential helper (`gh auth git-credential`), Azure DevOps the
        extraHeader wired at boot (--wire-azure-git), GitLab the host's mounted
        ~/.ssh key (its listing URLs are ssh). The dest is the repo name
        directly under REPOS_ROOT and must not already exist."""
        raw = (repo_spec or "").strip()
        src, entry = self._resolve_clone_source(raw, source)
        if entry:
            name = entry["name"]
            url = (f"https://github.com/{entry['nameWithOwner']}.git"
                   if src == "github" else entry.get("cloneUrl"))
            repo_id = entry["nameWithOwner"]
        elif source and source != "github":
            # An explicit non-GitHub source has no free-text form: the clone
            # URL only exists in that source's listing, so an unlisted repo is
            # a refusal, not a guess.
            key = slugify(raw) or "clone"
            self.clones[key] = {
                "name": key, "repo": raw, "status": "error",
                "error": f"{raw!r} is not in the {source} repo listing",
                "startedAt": now_iso(), "startedMono": time.time(),
                "proc": None, "logf": None, "logPath": None,
            }
            log(f"clone refused: {raw!r} not listed for source {source!r}")
            return
        else:
            try:
                repo_id = normalize_github_repo(raw)
            except ValueError as e:
                key = slugify(raw) or "clone"
                self.clones[key] = {
                    "name": key, "repo": raw, "status": "error", "error": str(e),
                    "startedAt": now_iso(), "startedMono": time.time(),
                    "proc": None, "logf": None, "logPath": None,
                }
                log(f"clone refused: {e}")
                return
            src = "github"
            name = repo_id.split("/")[1]
            url = f"https://github.com/{repo_id}.git"
        job = {
            "name": name, "repo": repo_id, "status": "cloning", "error": None,
            "source": src, "startedAt": now_iso(), "startedMono": time.time(),
            "proc": None, "logf": None,
            "logPath": os.path.join(REGISTRY_DIR, f"clone-{slugify(name)}.log"),
        }
        self.clones[name] = job
        dest = os.path.join(REPOS_ROOT, name)
        if os.path.exists(dest):
            job["status"] = "error"
            job["error"] = f"'{name}' already exists under the repos root"
            job["startedMono"] = time.time()
            log(f"clone refused: {job['error']}")
            return
        # Headless: never let git or ssh sit on a prompt — a missing credential
        # or unknown host key should fail fast into the job's error, which the
        # UI shows, rather than hang until CLONE_TIMEOUT_SEC reaps it.
        env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
        if url.startswith(("git@", "ssh://")):
            env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
        try:
            os.makedirs(REGISTRY_DIR, exist_ok=True)
            logf = open(job["logPath"], "w")
            proc = subprocess.Popen(
                ["git", "clone", "--", url, dest],
                stdout=logf, stderr=subprocess.STDOUT, env=env,
            )
        except Exception as e:
            job["status"] = "error"
            job["error"] = str(e)
            job["startedMono"] = time.time()
            log(f"clone launch failed for {repo_id}: {e}")
            return
        job["proc"] = proc
        job["logf"] = logf
        log(f"cloning {repo_id} ({src}) into {dest}")

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
             "source": j.get("source"), "startedAt": j.get("startedAt")}
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
        if sess.get("summaryManual"):
            return  # operator renamed it mid-flight; their name wins
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
            path = _session_transcript_path(sess)
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

    # --- available-models probe --------------------------------------------

    def _start_models_probe(self):
        """Kick off the `claude -p "/model"` probe (see parse_model_probe) as a
        DETACHED subprocess reaped by _poll_models_probe — the same shape as the
        summary/triage helpers: cwd=REGISTRY_DIR (its transcript is internal
        overhead, tombstoned off the usage page), no --settings, argv list.
        No-op while one is already in flight."""
        if self.models_probe:
            return
        out_path = os.path.join(REGISTRY_DIR, "models-probe.out")
        outf = None
        try:
            os.makedirs(REGISTRY_DIR, exist_ok=True)
            outf = open(out_path, "w")
            proc = subprocess.Popen(
                ["claude", "-p", MODEL_PROBE_PROMPT],
                stdout=outf, stderr=subprocess.DEVNULL, cwd=REGISTRY_DIR,
            )
        except Exception as e:
            log(f"models probe launch failed: {e}")
            if outf is not None:
                try:
                    outf.close()
                except Exception:
                    pass
            return
        self.models_probe = {"proc": proc, "outf": outf, "outPath": out_path,
                             "startedMono": time.time()}

    def _poll_models_probe(self):
        """Reap a finished models probe: parse its output into models_info, or
        log and leave the previous read standing (an unparseable/failed run is a
        property of the attempt — never downgrade a good list over it). Kills a
        probe that overran its timeout, like _poll_summaries."""
        job = self.models_probe
        if not job:
            return
        proc = job.get("proc")
        rc = proc.poll() if proc else 1
        if rc is None:
            if time.time() - job.get("startedMono", 0) > MODELS_PROBE_TIMEOUT_SEC:
                try:
                    proc.kill()
                except Exception:
                    pass
                log("models probe timed out")
                self._finish_models_probe(job, None)
            return
        raw = None
        if rc == 0:
            try:
                with open(job.get("outPath") or "", errors="replace") as f:
                    raw = f.read()
            except OSError:
                raw = None
        else:
            log(f"models probe exited {rc}")
        self._finish_models_probe(job, raw)

    def _finish_models_probe(self, job, raw):
        try:
            if job.get("outf"):
                job["outf"].close()
        except Exception:
            pass
        try:
            os.unlink(job.get("outPath") or "")
        except OSError:
            pass
        self.models_probe = None
        parsed = parse_model_probe(raw) if raw else None
        if parsed:
            self.models_info = {**parsed, "at": now_iso()}
            log(f"models probe: {', '.join(parsed['available'])}"
                + (f" (default {parsed['defaultLabel']})"
                   if parsed.get("defaultLabel") else ""))
        elif raw is not None:
            log("models probe output unparseable; keeping previous list")

    # --- subscription limits probe (XERK-247) -------------------------------

    def _ensure_limits_settings(self):
        """Write (once per manager) the ``--settings`` file the limits probe
        launches with, returning its path — or None if it couldn't be written,
        in which case the probe is skipped (a probe with no statusLine captures
        nothing, so there is no degraded mode worth launching)."""
        cached = getattr(self, "_limits_settings_path", None)
        if cached and os.path.exists(cached):
            return cached
        try:
            os.makedirs(REGISTRY_DIR, exist_ok=True)
            with open(LIMITS_SETTINGS_PATH, "w", encoding="utf-8") as fh:
                json.dump(build_limits_settings(), fh, indent=2)
        except OSError as e:
            log(f"limits settings write failed ({e}); skipping the limits probe")
            return None
        self._limits_settings_path = LIMITS_SETTINGS_PATH
        return LIMITS_SETTINGS_PATH

    def _limits_probe_due(self):
        """Whether to spend a probe this beat.

        Three gates, all about not paying for a number that cannot have moved.

        With one snapshot in hand we probe only when it has aged past
        LIMITS_PROBE_SEC **and** a session is actually running: the windows are a
        shared pool, but this host only pushes them while it's working, and a
        settled host re-probing all night would burn the very quota it reports.
        A snapshot nothing refreshes goes stale in the UI, which is the honest
        rendering of "nobody has asked Claude anything here in a while".

        With NO snapshot the backoff is what bounds the cost, and it has to,
        because a host that can never produce one is a normal outcome, not a
        failure: an API-key/Bedrock/Vertex login has no subscription windows, so
        every probe times out having spent a real turn. Unbounded, that is a turn
        every beat, forever. Each failure doubles the wait to
        LIMITS_PROBE_MAX_BACKOFF_SEC; a success resets it."""
        if not LIMITS_PROBE_SEC:
            return False
        waited = time.time() - getattr(self, "_limits_probe_at", 0)
        if waited < getattr(self, "_limits_probe_backoff", 0):
            return False
        snap = read_limits_snapshot()
        if not snap:
            return True
        if time.time() - snap.get("capturedAt", 0) < LIMITS_PROBE_SEC:
            return False
        return any(s.get("status") == "running" for s in self.registry)

    def _limits_probe_outcome(self, ok):
        """Record a finished probe: a success clears the backoff, a failure
        doubles it (from LIMITS_PROBE_RETRY_SEC, capped)."""
        if ok:
            self._limits_probe_backoff = 0
            return
        prev = getattr(self, "_limits_probe_backoff", 0)
        self._limits_probe_backoff = min(
            LIMITS_PROBE_MAX_BACKOFF_SEC,
            LIMITS_PROBE_RETRY_SEC if not prev else prev * 2)
        log(f"limits probe failed; next attempt in ~{self._limits_probe_backoff}s")

    def _start_limits_probe(self):
        """Run the limits probe on a daemon thread, single-flight.

        Unlike the summary/models helpers this can't be a `claude -p` reaped on
        the beat: print mode never invokes a statusLine (verified), so the probe
        has to be a real interactive claude on a TTY — hence tmux — and it needs
        a keypress and a poll for the snapshot to land, which is a few seconds of
        waiting the heartbeat loop must not do. Nothing outside the thread is
        mutated: the thread drives tmux and the hook writes the file, while the
        beat only ever READS that file."""
        thread = getattr(self, "_limits_probe", None)
        if thread is not None and thread.is_alive():
            return
        settings = self._ensure_limits_settings()
        if not settings:
            self._limits_probe_outcome(False)
            return
        # Stamped BEFORE the thread starts, so the backoff also spaces attempts
        # that die without reaching _limits_probe_outcome.
        self._limits_probe_at = time.time()
        self._limits_probe = threading.Thread(
            target=self._run_limits_probe, args=(settings,),
            name="limits-probe", daemon=True)
        self._limits_probe.start()

    def _run_limits_probe(self, settings):
        """The probe, start to finish: launch a throwaway claude, let one turn
        land so Claude Code populates `rate_limits`, wait for hooks/statusline.py
        to write the snapshot, and kill it.

        Kept as cheap as a turn can be — the cheapest model, a one-line system
        prompt in place of the default one, no MCP servers, a one-word answer —
        because it is billed against the very windows it measures. Measured at
        ~36k tokens (nearly all of it prompt cache) and ~15s.

        **`--model` is a request, not a guarantee**: it sets the session's model
        (the statusLine payload reports haiku at launch), but on a login whose
        routing picks per turn, the turn itself is answered by whatever that
        routing chooses — every interactive run measured here came back
        `claude-sonnet-5`. Nothing to fix agent-side; it means the cost figure is
        the one above, not a Haiku one. cwd is REGISTRY_DIR, which
        is what keeps its transcript off the usage page (`_is_internal_tool_slug`
        tombstones the registry dir's slug), and plan mode plus a prompt with
        nothing to do keeps it from touching a repo."""
        started = int(time.time())
        # It measures the SUBSCRIPTION's windows, so it must run against the
        # mounted ~/.claude login — never the local-model failover's endpoint
        # (XERK-246), which has no such windows and would make every probe time
        # out. That holds because the failover's credentials are SOURCED into one
        # session's launch line, never exported process-wide; this command
        # deliberately sources nothing.
        parts = [
            # hooks/statusline.py resolves its own default path, which would be
            # the right one anyway — but only if it inherits this process's
            # environment through tmux AND claude. Pinned as a shell assignment
            # (like _launch_tmux's ask-bridge vars) so the hook writes exactly
            # where read_limits_snapshot reads, override included.
            f"TURMA_LIMITS_PATH={shlex.quote(LIMITS_PATH)}",
            "claude",
            f"--settings {shlex.quote(settings)}",
            f"--model {shlex.quote(LIMITS_PROBE_MODEL)}",
            "--permission-mode plan",
            # The operator's MCP servers would be loaded (and their tool
            # definitions billed) for a turn that uses none of them.
            "--strict-mcp-config",
            f"--system-prompt {shlex.quote(LIMITS_PROBE_SYSTEM_PROMPT)}",
            f"-- {shlex.quote(LIMITS_PROBE_PROMPT)}",
        ]
        self._kill_limits_probe()  # clean slate
        rc, err = run_ok([
            "tmux", "new-session", "-d", "-s", LIMITS_TMUX,
            "-c", REGISTRY_DIR, "-x", "80", "-y", "24", " ".join(parts),
        ])
        if rc != 0:
            log(f"limits probe launch failed: {err}")
            self._limits_probe_outcome(False)
            return
        ok = False
        try:
            # One Enter, once: a directory claude has never been trusted in
            # opens a "do you trust this folder" dialog whose default is Yes, and
            # nothing else happens until it's answered — the turn never runs, so
            # the snapshot never lands. On an already-trusted dir this presses
            # Enter on an empty composer, which does nothing.
            time.sleep(LIMITS_PROBE_TRUST_SEC)
            run(["tmux", "send-keys", "-t", LIMITS_TMUX, "Enter"])
            deadline = time.time() + LIMITS_PROBE_TIMEOUT_SEC
            while time.time() < deadline:
                time.sleep(1)
                snap = read_limits_snapshot()
                if snap and snap.get("capturedAt", 0) >= started:
                    ok = True
                    log("limits probe: 5h "
                        f"{(snap.get('fiveHour') or {}).get('usedPct')}%, 7d "
                        f"{(snap.get('sevenDay') or {}).get('usedPct')}%")
                    return
            # A login with no subscription windows (API key, Bedrock/Vertex) never
            # populates rate_limits, so this is a normal outcome on such a host,
            # not an error — it just means the Usage page keeps its empty state,
            # and the backoff keeps that host from paying for a turn per beat.
            log("limits probe: no rate limits reported before the timeout")
        finally:
            self._kill_limits_probe()
            self._limits_probe_outcome(ok)

    def _kill_limits_probe(self):
        """Tear down the probe's tmux (and the claude inside it). Idempotent.

        Called from the probe's own `finally`, from the shutdown handler and at
        boot, because the `finally` is NOT enough on its own: the probe runs on a
        daemon thread, whose `finally` never runs when the interpreter exits, and
        tmux outlives the manager by design. A restart mid-probe (the native
        updater does exactly that) would otherwise leave an interactive claude
        sitting in a detached tmux until some later probe's clean-slate kill —
        up to LIMITS_MAX_AGE_SEC away on an idle host."""
        run(["tmux", "kill-session", "-t", LIMITS_TMUX])

    def models_available(self):
        """The probed alias list, or () before the first successful probe —
        the `extra` allowlist resolve_model/set_model accept beyond the static
        MODEL_ALIASES."""
        return tuple((self.models_info or {}).get("available") or ())

    def _seed_model_actual(self, sess):
        """One-shot: the newest actual-model signal already IN a session's
        transcript, for a record that predates the field (the per-beat scan
        primes to EOF, so history never replays through it). Bounded to the
        transcript's last 64 KiB — an assistant turn sits within that in any
        conversation that has one."""
        path = _session_transcript_path(sess)
        if not path:
            return None
        try:
            with open(path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - (64 << 10)))
                raw = f.read()
        except OSError:
            return None
        tmp = {"modelActual": None}
        # Skip the first fragment of a mid-entry start; fold the rest in order
        # so the newest signal wins, exactly like the live scan.
        lines = raw.split(b"\n")
        for line in (lines[1:] if size > (64 << 10) else lines):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if isinstance(entry, dict):
                _scan_model_entry(entry, tmp)
        return tmp["modelActual"]

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
        """Bring running sessions back under management. Two paths:

        * ADOPT — the session's claude tmux is STILL ALIVE. tmux is its own
          daemon, so it (and the running claude, mid-turn included) survives a
          restart of just THIS manager process — the native in-place-update case
          (systemd KillMode=process, or a manager-only kill). Re-launching would
          `tmux kill-session` the live claude and abort its turn, so instead we
          leave it untouched and only re-ensure the ttyd bridge. This is what lets
          an agent update itself without stopping active sessions.
        * RELAUNCH — the tmux is gone (the whole process tree died, e.g. a Docker
          container restart, a host reboot, or a crash). Then we relaunch with
          --resume, continuing the prior CONVERSATION (not a fresh context).

        Either way, a session whose worktree vanished is demoted to stopped."""
        for sess in self.registry:
            if sess.get("status") != "running":
                continue  # stopped stays stopped (kept for usage; resumable)
            if not os.path.isdir(sess["worktreePath"]):
                sess["status"] = "stopped"
                sess["stoppedAt"] = now_iso()
                log(f"resume: worktree gone for {sess['id']}, marking stopped")
                continue
            try:
                if self._tmux_alive(sess.get("tmuxName")):
                    # Adopt: claude keeps running; just re-ensure the ttyd (adopts
                    # a surviving one by port, else relaunches). No launch stagger
                    # — nothing contends on the shared login, we started no claude.
                    self._launch_ttyd(sess)
                    log(f"adopted live session {sess['id']} on :{sess['ttydPort']}")
                    continue
                self._launch_tmux(sess, resume=True)
                self._launch_ttyd(sess)
                log(f"resumed session {sess['id']} on :{sess['ttydPort']}")
                time.sleep(LAUNCH_STAGGER)  # stagger shared-login contention
            except Exception as e:
                self._set_error(sess, e)
        # A limits probe the previous manager was running when it died is NOT a
        # session and is never adopted: its tmux holds an interactive claude
        # nothing is waiting on. Reaped here so a crash mid-probe can't leave one
        # sitting until the next probe happens to be due.
        self._kill_limits_probe()
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
                        model_source=cmd.get("modelSource"),
                        cmd_id=cid,
                    )
                elif ctype == "spawnTicket":
                    self.spawn_ticket(cmd.get("issueKey"), cmd_id=cid,
                                      model=cmd.get("model"))
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
                elif ctype == "exportSession":
                    self.export_session(
                        cmd.get("sessionId"), cmd.get("migrationId"))
                elif ctype == "importSession":
                    self.import_session(cmd)
                elif ctype == "delete":
                    self.delete(cmd.get("sessionId"))
                elif ctype == "input":
                    self.send_input(cmd.get("sessionId"), cmd.get("text") or "",
                                    uploads=cmd.get("uploads"))
                elif ctype == "interrupt":
                    self.interrupt(cmd.get("sessionId"))
                elif ctype == "setSummary":
                    self.set_summary(cmd.get("sessionId"), cmd.get("summary"))
                elif ctype == "setModel":
                    self.set_model(cmd.get("sessionId"), cmd.get("model"))
                elif ctype == "setMode":
                    self.set_mode(cmd.get("sessionId"), cmd.get("permissionMode"))
                elif ctype == "setModelSource":
                    self.set_model_source(
                        cmd.get("sessionId"), cmd.get("modelSource"))
                elif ctype == "answerQuestion":
                    self.answer_question(
                        cmd.get("sessionId"),
                        cmd.get("optionIndex"),
                        cmd.get("custom"),
                        cmd.get("optionIndices"),
                    )
                elif ctype == "answerPanePrompt":
                    self.answer_pane_prompt(
                        cmd.get("sessionId"), cmd.get("optionNumber"))
                elif ctype == "history":
                    self._stage_history(cmd.get("sessionId"))
                elif ctype == "subagentHistory":
                    self._stage_subagent_history(
                        cmd.get("sessionId"), cmd.get("agentType"), cmd.get("label"))
                elif ctype == "jiraIssue":
                    self._stage_jira_issue(cmd.get("issueKey"))
                elif ctype == "setTicketStatus":
                    self.set_board_status(
                        cid, cmd.get("issueKey"), cmd.get("value"),
                        cmd.get("category"))
                elif ctype == "boardCreateMeta":
                    self._stage_create_meta(cmd.get("project"))
                elif ctype == "createTicket":
                    self._stage_create_ticket(cmd)
                elif ctype == "setJiraRepo":
                    self.set_jira_repo(
                        cmd.get("issueKey"), cmd.get("repo"),
                        auto=bool(cmd.get("auto")), site_key=cmd.get("siteKey"))
                elif ctype == "clone":
                    self.clone(cmd.get("repo"), source=cmd.get("source"))
                elif ctype == "prune":
                    self.prune_repo(cmd.get("repo"))
                elif ctype == "refreshJira":
                    # The board's manual refresh. Re-checking configured() here
                    # (the hub already targets configured hosts) keeps the
                    # "unset env = zero Jira HTTP calls, ever" guarantee a
                    # property of the agent rather than of hub-side targeting.
                    # Runs inline like the scheduled poll it short-circuits, so
                    # it costs the beat exactly what that poll already does, and
                    # handle_commands' immediate follow-up beat carries the
                    # fresh block straight back.
                    if board_configured():
                        self.refresh_jira()
                elif ctype == "restartAgent":
                    # The dashboard's "Restart agent" button (XERK-157). We only
                    # arm a flag here — the actual exit happens in run_forever
                    # once this command's ack has been delivered to the hub, so
                    # the command is off the queue before we go and can't
                    # re-fire on boot.
                    self.request_restart()
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
        the lossy project slug can (…/personal/Widget -> "Widget"). Splits
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

    def _is_internal_tool_slug(self, slug):
        """True when a PROJECTS_ROOT slug holds the manager's OWN internal
        `claude -p` helper transcripts (session naming + Jira triage) rather than
        a real coding session — see INTERNAL_TOOL_PROMPT_SIGS for why they leak
        into ~/.claude/projects and must be kept off the usage page (XERK-27).

        The REPOS_ROOT slug is never internal: it is the root pseudo-repo's
        shared project dir, holding EVERY root session's transcript, and this
        check reads only the newest one — a root session in which the operator
        typed nothing but /model reads exactly like the models probe, and one
        such transcript must not tombstone the whole root history (XERK-147).

        Those helpers run with cwd=REGISTRY_DIR, so in production every one lands
        under the registry dir's own slug — matched here directly, with no
        transcript read. A test/verify harness that boots the manager against a
        temp REGISTRY_DIR writes the identical one-shots into the SHARED
        ~/.claude/projects under a different slug (…-tmp-hub-agent-mgr-<rand>),
        so fall back to the prompt signature of the newest transcript, which is
        path- and process-independent. This is the one carve-out to the usage
        ledger's 'every transcript on the box counts' rule: the agent's own
        overhead is not a repo."""
        if slug == _project_slug(REPOS_ROOT):
            return False
        if slug == _project_slug(REGISTRY_DIR):
            return True
        proj = os.path.join(PROJECTS_ROOT, slug)
        try:
            files = [f for f in os.listdir(proj) if f.endswith(".jsonl")]
        except OSError:
            return False
        if not files:
            return False
        newest = max(files,
                     key=lambda f: os.path.getmtime(os.path.join(proj, f)))
        newest_path = os.path.join(proj, newest)
        first = _first_user_text(newest_path)
        if _looks_like_internal_tool_prompt(first):
            return True
        # The models probe's prompt IS a slash command ("/model"), which
        # _first_user_text deliberately skips — so its transcript has no genuine
        # user text at all. Recognize it by its first (and only) command; a real
        # session that OPENS with /model goes on to carry genuine prompts, which
        # makes `first` non-None and keeps it counted.
        return first is None and _first_command_name(newest_path) == MODEL_PROBE_PROMPT

    def _sanitize_internal_tool_entries(self):
        """Retire ledger entries that actually point at the manager's own internal
        `claude -p` helper transcripts (see _is_internal_tool_slug). Earlier builds
        adopted them as phantom repos on the usage page — ".turma", "hub-agent-mgr-*"
        (XERK-27) — so flip any such surviving entry to an `internal` tombstone,
        which repo_usage_report and _archive_manifest skip. Already-tombstoned
        entries are passed over, so the signature read is paid at most once each
        rather than every usage beat. Runs before _reconcile_orphan_transcripts,
        which tombstones the same shape as it first encounters it."""
        changed = False
        for path, meta in list(self.usage_ledger.items()):
            meta = meta or {}
            if meta.get("internal"):
                continue
            slug = meta.get("slug") or _project_slug(path)
            # Cheap outs before the per-entry transcript read: a recorded git
            # remote or a worktree-shaped slug is a real session beyond doubt — the
            # manager's cwd=REGISTRY_DIR helpers are neither — so only genuinely
            # ambiguous (remote-less, non-worktree) entries pay the signature read,
            # and it's paid at most once each (the survivor becomes a tombstone).
            if meta.get("remote") or _repo_from_worktree_slug(slug):
                continue
            if self._is_internal_tool_slug(slug):
                self.usage_ledger[path] = {"internal": True, "slug": slug}
                changed = True
        if changed:
            self._save_ledger()

    def _sanitize_junk_repo_entries(self):
        """Fold ledger entries whose repo names nothing real into the root
        bucket (XERK-147). Earlier builds attributed an orphan transcript by its
        worktree-shaped slug or its cwd's last path segment UNVALIDATED, so the
        usage page grew phantom repos: "<worktree>-…-scratchpad" (a claude run
        inside a session's scratchpad dir, whose slugified cwd embeds
        "-worktrees-" and false-matches _repo_from_worktree_slug), "tmp",
        "repo", "repos", "root", "(other)". A stored name now only stands when
        the entry records a git remote (a real repo beyond doubt, even if since
        deleted from this host) or names a repo this host scans; anything else
        is re-attributed to ROOT_REPO_NAME, per the rule that usage belongs to
        a repo or to root — never to a phantom.

        Also lifts an `internal` tombstone off the REPOS_ROOT slug: before
        _is_internal_tool_slug's root guard, one /model-only root session
        tombstoned the whole root history, and the tombstone persists until
        retired here.

        Skipped entirely when the repo scan comes back empty — an unreadable
        REPOS_ROOT (or a fresh box) must not permanently fold every real repo's
        history into root."""
        known = {r["name"] for r in scan_repos()}
        if not known:
            return
        root_slug = _project_slug(REPOS_ROOT)
        changed = False
        for path, meta in list(self.usage_ledger.items()):
            meta = meta or {}
            slug = meta.get("slug") or _project_slug(path)
            if meta.get("internal"):
                if slug == root_slug:
                    self.usage_ledger[path] = {
                        "repo": ROOT_REPO_NAME, "remote": "", "slug": slug}
                    changed = True
                continue
            repo = meta.get("repo")
            if repo == ROOT_REPO_NAME or repo in known or meta.get("remote"):
                continue
            self.usage_ledger[path] = {
                "repo": ROOT_REPO_NAME, "remote": "", "slug": slug}
            changed = True
        if changed:
            self._save_ledger()

    def _reconcile_orphan_transcripts(self):
        """Adopt EVERY transcript sitting in PROJECTS_ROOT that no ledger entry
        covers, so persistent token usage reflects every session on disk — not
        only sessions in the live registry or the last-5 closed history that
        _backfill_ledger sees. A session killed long ago (its card gone, its
        worktree maybe surviving) or one predating _remember_usage would
        otherwise silently drop out of the totals, since repo_usage_report only
        folds slugs the ledger names. A REAL session is never excluded — an
        unattributable one still counts, folded into the root bucket rather
        than being dropped (XERK-147). The single carve-out is the manager's OWN
        internal `claude -p` helper transcripts (_is_internal_tool_slug), which
        are its overhead, not a repo; those are tombstoned so they never surface
        on the usage page (XERK-27).

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
          4. still nothing -> bucketed under ROOT_REPO_NAME so it always counts.
        Cases 2 and 3 only stand when the derived name matches a repo this host
        scans: both are lossy heuristics, and unvalidated they invented phantom
        repos on the usage page — a scratchpad cwd (/tmp/claude-0/<slugified
        worktree cwd>/…) embeds "-worktrees-" once slugified and false-matches
        the slug shape, and a cwd tail can be "tmp"/"repo"/"repos" (XERK-147).
        A miss falls through to case 4 rather than minting a name.
        New entries are persisted and keyed so _prune_ledger removes them once
        the transcript dir finally disappears."""
        try:
            names = os.listdir(PROJECTS_ROOT)
        except OSError:
            return
        known = {(m or {}).get("slug") or _project_slug(p)
                 for p, m in self.usage_ledger.items()}
        existing = None      # built lazily — the listdirs aren't free
        repo_names = None    # likewise (a scan_repos listdir + .git checks)
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
            # The manager's own summary/triage `claude -p` is never worktree-shaped
            # (its cwd is REGISTRY_DIR), so a worktree slug skips the signature read
            # below and goes straight to attribution. A match is tombstoned — kept
            # off usage + archive and, now in the ledger, never re-evaluated (it
            # lands in `known` next beat).
            if _repo_from_worktree_slug(slug) is None \
                    and self._is_internal_tool_slug(slug):
                self.usage_ledger[proj] = {"internal": True, "slug": slug}
                known.add(slug)
                added = True
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
            # slug shape (case 2), then the recorded cwd (case 3), each accepted
            # only when it names a repo this host scans, then the root catch-all
            # (case 4) — either way it's adopted, nothing is dropped.
            if repo_names is None:
                repo_names = {r["name"] for r in scan_repos()}
            repo = _repo_from_worktree_slug(slug)
            if repo not in repo_names:
                repo = self._repo_from_transcript_cwd(proj)
            if repo not in repo_names:
                repo = ROOT_REPO_NAME
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
        self._sanitize_internal_tool_entries()
        self._sanitize_junk_repo_entries()
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
        # Attachments of long-gone sessions, on the same slow cadence (XERK-234).
        try:
            self._sweep_uploads()
        except Exception as e:
            log(f"uploads sweep failed: {e}")

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

    def _new_work_since_prs(self, sess, signals):
        """Has this session said anything since every PR it opened landed?

        The comparison `_poll_prs_landed` exists for: its stamp is the session's
        last-activity timestamp at the moment the sweep saw the PRs land, and
        this is the same reading now. Both are transcript entry timestamps, so
        they share the conversation's clock and sort as ISO-8601 strings.

        False whenever the question can't be answered — no stamp yet, no dated
        entry, a stopped session with no live signals. The Ready-for-review rule
        reads it as "the merge still counts as the review", which is the
        behaviour that shipped before this expiry existed."""
        landed = sess.get("prsLandedTs")
        if not landed:
            return False
        now_ts = (signals or {}).get("lastActivityTs")
        return bool(now_ts and str(now_ts) > str(landed))

    def _session_payload(self, sess, refresh=True):
        sid = sess["id"]
        running = sess.get("status") == "running"
        signals = None
        if running:
            try:
                st = self.sess_state.setdefault(sid, {})
                signals = session_report(sess["worktreePath"], st, sess.get("tmuxName"),
                                         session_id=sess.get("id"),
                                         claude_sid=sess.get("claudeSessionId"))
                pend = self.pending_prs.setdefault(sid, [])
                pend.extend(signals.pop("prUrls"))
                del pend[:-10]
                signals["newPrUrls"] = list(pend)
                # Also remember them persistently: pending_prs is cleared on the
                # next delivered beat, so the durable PR-status feature reads from
                # session_pr_urls instead (deduped, newest-last, capped). Mirror
                # the same list onto the session record and save when it grows, so
                # the chips survive an agent restart (rehydrated in __init__) —
                # not just across beats. (XERK-15)
                if pend:
                    known = self.session_pr_urls.setdefault(sid, [])
                    grew = False
                    for url in pend:
                        if url not in known:
                            known.append(url)
                            grew = True
                    del known[:-10]
                    if grew:
                        sess["prUrls"] = list(known)
                        self.save()
                    # Also record to the durable transcriptId-keyed PR ledger.
                    # sess["prUrls"] above (XERK-15) only survives while the
                    # registry record does; the ledger is what carries the chips
                    # into a session's ENDED life — reported then only by the
                    # resumable scan, past closed.json's cap. (XERK-13)
                    self._remember_prs(sess)
                # The model that actually answered (or a live /model switch's
                # confirmation), persisted on the record so the chip survives
                # beats and restarts. The per-beat scan only sees new bytes, so
                # a record predating the field seeds once from the tail.
                actual = signals.pop("modelActual", None)
                if (not actual and not sess.get("modelActual")
                        and sid not in self._model_seeded):
                    actual = self._seed_model_actual(sess)
                self._model_seeded.add(sid)
                if actual and actual != sess.get("modelActual"):
                    sess["modelActual"] = actual
                    self.save()
                # Reconcile the stored permission mode to the one the TUI's
                # footer really shows (the operator can cycle by hand in the
                # live terminal, which no command ever reports) — so the mode
                # chip, and any restart's --permission-mode, follow the truth.
                ma = signals.get("modeActual")
                if ma and ma != sess.get("permissionMode"):
                    sess["permissionMode"] = ma
                    self.save()
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
            "summary": sess.get("summary"),   # few-word task name (or None)
            # The Jira ticket this session was spawned to work — {key, siteKey,
            # url, summary, branch} — or None. The board reverse-indexes it to
            # link a ticket to its sessions; the session card links back out.
            "ticket": sess.get("ticket"),
            # The hub command that created this session (spawn / resumeTranscript),
            # so the UI that issued it can find the id the agent minted and open
            # the session. None for sessions predating the echo, or restored ones.
            "spawnCmdId": sess.get("spawnCmdId"),
            "model": sess.get("model"),
            # The model REALLY answering, read from the transcript (a model id
            # like "claude-opus-4-8", or a switch confirmation's display label
            # like "Sonnet 5") — what the chat chip shows instead of "Default".
            # None until the session's first assistant turn.
            "modelActual": sess.get("modelActual"),
            # A model pick that arrived mid-turn, waiting for the first idle
            # beat (_apply_pending_switches). The chip shows it as in-flight
            # rather than looking like a dropped click. Absent when none.
            "pendingModel": sess.get("pendingModel"),
            "permissionMode": sess.get("permissionMode"),
            # Which model this session is actually running against (XERK-246):
            # "subscription" (the mounted ~/.claude login) or "local" (the
            # self-hosted model it failed over to). Always present, so a client
            # never has to infer "not local" from an absent field.
            "modelSource": sess.get("modelSource") or "subscription",
            # When it last moved, so the UI's mark can say WHEN a session failed
            # over rather than only that it did. Absent on a session that never
            # switched.
            "modelSourceAt": sess.get("modelSourceAt"),
            # The permission modes this session's live Shift+Tab cycle can reach
            # (base modes + whichever optional it was launched into) — the hub's
            # mode selector offers only these, since a switch to any other mode is
            # a no-op agent-side. Launch-dependent; see perm_cycle_for / set_mode.
            "permissionModes": perm_cycle_for(sess.get("launchPermissionMode")),
            "baseRef": sess.get("baseRef"),
            "status": sess.get("status"),
            # Why a `queued` session is waiting (capacity / awaiting-clone /
            # root-busy) and since when — so the card can say "waiting for a
            # slot" rather than looking like a stuck spawn. Absent (None) for any
            # session that isn't queued.
            "queuedReason": sess.get("queuedReason"),
            "queuedAt": sess.get("queuedAt"),
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
            # Has the conversation moved on since every PR it opened landed?
            # (XERK-224 — see _poll_prs_landed.) "Merging IS the review" demotes
            # a session out of Ready-for-review, and this is what lets that
            # expire when the SAME session is handed a new task and finishes it
            # with no new PR to show. Both timestamps are transcript entries, so
            # the comparison is on the conversation's own clock. False (never
            # None) so an older hub reading it gets the pre-XERK-224 behaviour
            # rather than a truthy surprise.
            "newWorkSincePrs": self._new_work_since_prs(sess, signals),
            # Which conversation this session is having: the hub opens it
            # read-only from the archive once the session has ENDED, and points
            # the live tail at it (rather than at whatever shares its project
            # dir) while it runs.
            #
            # Reported whether running or not. Free for a pinned session, which
            # already knows its id; an unpinned one (an agent predating the pin)
            # costs a listdir to guess at, and the hot path now pays that every
            # beat on purpose. It's the id the hub's Ended list dedupes on, and a
            # RUNNING session is the one case where a duplicate is intolerable:
            # the durable side of that list is a transcript scan that's minutes
            # stale by design, so without this there is nothing to recognise a
            # just-resumed session by and it shows as running and ended at once.
            #
            # Deliberately not _session_transcript_id, which answers None until
            # the file exists: the pinned id is the conversation this session
            # WILL have, and the hub needs it before the first turn lands.
            "transcriptId": (sess.get("claudeSessionId")
                             or self._latest_transcript_id(sess["worktreePath"])),
            "session": signals,                      # running only; null otherwise
        }

    def _closed_payload(self):
        """Killed-but-resumable sessions for the hub's per-repo Resume picker and
        its Ended-sessions list, newest first. Already capped at CLOSED_PER_REPO
        per repo, so this can never balloon the heartbeat."""
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
                # Whether that summary is an operator's own rename rather than a
                # generated name. Carried for the same reason the live payload
                # carries it: it decides how the board labels this session's chip,
                # and the label must not change just because the session was
                # killed.
                "summaryManual": c.get("summaryManual"),
                # Which model this session RAN against (XERK-246). Reading an
                # ended session's transcript is exactly when "which model wrote
                # this" matters, and the Ended card's mark reads this field.
                "modelSource": c.get("modelSource"),
                "createdAt": c.get("createdAt"),
                "closedAt": c.get("closedAt"),
                # The Jira ticket this session was spawned to work. _remember_closed
                # has always snapshotted it onto the record, but it never reached
                # the wire, so the board — which reverse-indexes session.ticket to
                # chip a ticket with its sessions — lost the link the moment the
                # session was killed, and could only ever answer "which session is
                # working PROJ-123", never "which one worked it".
                "ticket": c.get("ticket"),
                # The conversation this session had, so the Ended-sessions view
                # can open it read-only from the hub's archive. Absent on records
                # written by an agent predating the snapshot (see _remember_closed).
                "transcriptId": c.get("transcriptId"),
                # Its PRs, resolved through the same status cache a live card
                # reads — so an ended session's chips carry the state/CI rollup
                # they reached, not a bare link. None when it opened none, which
                # matches the live payload's "no PRs" shape.
                "prs": self._closed_prs(c),
            }
            for c in reversed(self.closed)
        ]

    def _closed_prs(self, rec):
        """PR-status objects for a closed record's snapshotted PR links, in the
        order they were scraped — the closed-history counterpart of
        _session_prs, reading the record instead of the live session_pr_urls
        (which kill() drops). None when the session opened no PR."""
        urls = rec.get("prUrls")
        if not urls:
            return None
        return [self.pr_status_cache.get(u) or {"url": u} for u in urls]

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
        # cadence in _refresh_repo_usage) for the "Resume any session" picker and
        # the hub's Ended-sessions list.
        #
        # The cut against carded slugs is re-applied here, every beat, rather than
        # trusted from the scan: the scan is minutes stale by design, so between
        # refreshes it still lists a session that has since been resumed and is
        # running right now. Reporting that would offer "Resume" for a live
        # session and, on the hub, show it in both the Active and Ended lists at
        # once. The registry is current every beat, so this is where the answer is.
        carded = self._carded_slugs()
        for e in out:
            e["resumable"] = [r for r in self.resumable.get(e["name"], [])
                              if r.get("slug") not in carded]
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
        # Assigned tickets (Jira or Azure DevOps) on their own slow cadence; the
        # configured() guard keeps unconfigured hosts at zero board HTTP calls forever.
        if not light and beat % JIRA_REFRESH_EVERY == 0 and board_configured():
            self.refresh_jira()
        # Ticket -> repo triage. Attempted every beat rather than on the slow jira
        # cadence: it's one batch in flight at a time, so a freshly-polled board
        # would otherwise take an hour of 10-minute beats to classify instead of a
        # few minutes. Both calls no-op immediately on a settled board (nothing
        # stale) and on an unconfigured host (no tickets), so the steady-state cost
        # is a fingerprint check.
        # Both halves are wrapped, not just the start: this runs on the heartbeat
        # path of the PID-1 manager, and a repo chip is never worth taking the
        # host's sessions down for.
        if not light:
            try:
                self._poll_jira_triage()
                self._start_jira_triage()
            except Exception as e:
                log(f"jira triage failed: {e}")
        # PR state + CI checks for the links live sessions opened, on a faster
        # cadence than the github block so a card's merge/CI status stays live.
        if not light and beat % PR_STATUS_REFRESH_EVERY == 0:
            try:
                self.refresh_pr_status()
            except Exception as e:
                log(f"pr status refresh failed: {e}")
            # A PR that just came back CONFLICTING is told to the session that
            # opened it (XERK-223) — same beat, off the status we just fetched,
            # so no extra call. Wrapped separately: a nudge failing must not
            # cost the refresh above, nor take the host's sessions down.
            try:
                self._poll_pr_conflicts()
            except Exception as e:
                log(f"pr conflict poll failed: {e}")
            # And a PR that just LANDED marks where the conversation stood, so
            # the Ready-for-review demotion it triggers expires the moment the
            # session is given new work (XERK-224). Same beat, same cached
            # status; wrapped for the same reason.
            try:
                self._poll_prs_landed()
            except Exception as e:
                log(f"pr landed poll failed: {e}")
        # New review activity on a session's PR is typed back into that session
        # so a reply asking for corrections continues the work (XERK-49). Own
        # cadence + per-beat cap; wrapped, because a PR comment is never worth
        # taking the host's sessions down for.
        if not light and PR_COMMENTS_DELIVER and (
                beat % PR_COMMENTS_REFRESH_EVERY == 0):
            try:
                self._poll_pr_comments()
            except Exception as e:
                log(f"pr comment poll failed: {e}")
        self._poll_clones()
        self._poll_prunes()
        # Start any queued session that can now run — a freed slot, a finished
        # on-demand clone, or the root slot opening. One per beat; see the method.
        if not light:
            self._drain_queue()
        # Drop AskUserQuestion rendezvous files left behind by a turn that died
        # outside our kill/restart cleanup, so a long-answered/abandoned question
        # can't keep showing as pending on the card.
        self._sweep_orphan_questions()
        # Seed names for bare-spawned sessions from their transcript's first
        # prompt (channel-agnostic; the live terminal bypasses send_input), then
        # reap any finished naming subprocess.
        self._seed_summaries()
        self._poll_summaries()
        # Confirm recently-sent messages landed, and re-send any a compaction
        # dropped (XERK-47). Cheap on a settled fleet — it short-circuits on any
        # session with an empty outbox.
        self._poll_pending_inputs()
        # Probe the login's real model list on its own slow cadence (beat 0
        # covers boot), retrying faster until the first success so the hub's
        # model menu isn't a static guess for hours after a restart.
        if not light and (beat % MODELS_REFRESH_EVERY == 0 or (
                self.models_info is None and beat % MODELS_RETRY_EVERY == 0)):
            self._start_models_probe()
        self._poll_models_probe()
        # Refresh the subscription's 5h/7d limit snapshot when it's due (see
        # _limits_probe_due for what "due" costs). The probe runs on its own
        # thread; this beat reports whatever snapshot is already on disk.
        if not light and self._limits_probe_due():
            self._start_limits_probe()
        # Apply model switches deferred while their session was mid-turn.
        if not light:
            try:
                self._apply_pending_switches()
            except Exception as e:
                log(f"pending switch drain failed: {e}")

        payload = {
            # `device` (the physical host name) is the hub's identity key; agentId
            # is only a last-resort fallback if the host name can't be read.
            "agentId": self.agent_id,
            "device": self.device,
            "startedAt": self.started_at,
            "agentVersion": self.agent_version,
            "codingAgent": self.coding_agent,
            "claudeVersion": self.claude_version,
            # Health of the shared subscription login: present/needsLogin/
            # expiringSoon + the refresh-token expiry the hub alerts on when the
            # login lapses (XERK-98). Read fresh each beat — it's a tiny JSON
            # read and this is the fact that decides whether sessions can run.
            "claudeAuth": claude_auth_status(),
            # The login's real model list + what "default" currently resolves
            # to, from the models probe. None until the first successful probe;
            # the hub's model menu falls back to its static list then.
            "models": self.models_info,
            "memory": memory_usage(),
            "logTail": self._log_tail(beat, light),
            "reposRoot": REPOS_ROOT,
            # The longest message THIS agent can put into a session (XERK-227).
            # The hub caps a typed message at what the receiving agent will
            # actually deliver: an agent too old to report this can only take
            # 4k and would SILENTLY TRUNCATE the rest, so the hub refuses past
            # its cap instead — a visible "too long" beats a message the
            # operator believes they sent whole. Rises on its own as hosts
            # update, with no hub-side version table to keep in step.
            "inputMaxChars": INPUT_MAX_CHARS,
            # Whether this host can fail a session over to a self-hosted model
            # (XERK-246). Doubles as the capability flag, exactly like
            # inputMaxChars and uploadMaxBytes: an agent predating the failover —
            # or one with no LOCAL_MODEL_* env — reports nothing, and the hub and
            # composers hide the control rather than queue a command that host
            # will silently ack and drop.
            "localModel": {
                "available": local_model_configured(),
                "model": LOCAL_MODEL_NAME if local_model_configured() else None,
                "contextTokens": LOCAL_MODEL_CONTEXT if local_model_configured() else None,
            },
            # The largest file this agent will take as a message attachment
            # (XERK-234). Doubles as the capability flag, exactly like
            # inputMaxChars above: an agent predating attachments reports nothing
            # and would drop the `uploads` on an input command without a word, so
            # the hub refuses the upload and the composers hide their 📎 rather
            # than let the operator attach into a void.
            "uploadMaxBytes": UPLOAD_MAX_BYTES,
            # Session ceiling + what's against it, so the hub can rank hosts by
            # free slots (ticket routing) and show a queued session's wait. Cheap
            # enough to send every beat, and it has to be: capacity is the fact
            # that goes stale fastest.
            "capacity": self._capacity_payload(),
            "repos": self._sorted_repo_entries(refresh),
            "sessions": [self._session_payload(s, refresh) for s in self.registry],
            "closedSessions": self._closed_payload(),
            # Persistent usage, independent of active sessions: per-repo (keyed by
            # normalized origin so the hub can unify a repo across hosts) plus this
            # host's merged total. Survives kill/delete/prune.
            "repoUsage": self.repo_usage,
            "usage": self.host_usage,
            # How much of the Claude SUBSCRIPTION's 5-hour and 7-day windows is
            # gone (XERK-247) — a different question from the token counts above,
            # and one only Claude Code can answer (hooks/statusline.py captures
            # it; read_limits_snapshot validates it). None on a host whose login
            # has no such windows or hasn't been probed yet, which the clients
            # read as "this agent can't tell you", never as "0% used".
            "limits": read_limits_snapshot(),
            # GitHub clone-into-root: availability + clonable repos for the hub's
            # clone control, and any in-flight/recent clone jobs.
            "github": self.github,
            # Extra clone sources beyond GitHub (XERK-155): Azure DevOps /
            # GitLab listings, rendered by clients as sections beside the
            # github block's repos. [] on a host with neither configured.
            "gitSources": self._git_sources_payload(),
            # Jira Cloud assigned tickets (user-scoped creds); the hub's /board
            # merges these across hosts by siteKey into one cross-org Kanban.
            "jira": self._jira_payload(),
            "clones": self._clones_payload(),
            "prunes": self._prunes_payload(),
            "ackedCommands": list(self.acked),
        }
        # Purely additive, and only present when something is staged — mirrors
        # how pending_prs stays out of a session's payload until there's
        # something to report.
        if self.history_results:
            payload["historyResults"] = list(self.history_results)
        if self.subagent_history_results:
            payload["subagentHistoryResults"] = list(self.subagent_history_results)
        if self.jira_issue_results:
            payload["jiraIssueResults"] = list(self.jira_issue_results)
        if self.ticket_status_results:
            payload["ticketStatusResults"] = list(self.ticket_status_results)
        if self.create_meta_results:
            payload["createMetaResults"] = list(self.create_meta_results)
        if self.create_ticket_results:
            payload["createTicketResults"] = list(self.create_ticket_results)
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
            self.subagent_history_results.clear()  # delivered — same lifecycle
            self.jira_issue_results.clear()  # delivered — same lifecycle
            self.ticket_status_results.clear()  # delivered — same lifecycle
            self.create_meta_results.clear()  # delivered — same lifecycle
            self.create_ticket_results.clear()  # delivered — same lifecycle
            return reply if isinstance(reply, dict) else {}
        except Exception as e:
            log(f"heartbeat failed: {e}")
            return None

    def _read_updating_flag(self):
        """Consume the native updater's hint file (reason + target version) if it
        left one just before triggering our restart. Returns (reason, version),
        both None when absent/garbled — a container update leaves no file, so a
        missing one just means a generic restart with no known version."""
        try:
            with open(UPDATING_FLAG_PATH) as f:
                d = json.load(f)
        except (OSError, ValueError):
            return None, None
        if not isinstance(d, dict):
            return None, None
        return d.get("reason"), d.get("version")

    def _announce_updating(self, reason="restart", version=None):
        """Tell the hub we're going down for an EXPECTED restart, so it renders an
        `updating` status rather than treating the coming heartbeat silence as an
        unexpected outage (XERK-29). Fire-and-forget with a short timeout: we're
        on the shutdown path and must never block the exit if the hub is slow or
        unreachable. The hub drops the status the instant we heartbeat from the
        far side, so no one has to clear it."""
        if not TURMA_URL:
            return
        try:
            body = {"reason": reason or "restart"}
            if version:
                body["version"] = version
            headers = {"Content-Type": "application/json", "User-Agent": "hub-agent/1.0"}
            if TURMA_TOKEN:
                headers["Authorization"] = f"Bearer {TURMA_TOKEN}"
            url = (f"{TURMA_URL}/api/agents/"
                   f"{urllib.parse.quote(self.device, safe='')}/updating")
            req = urllib.request.Request(
                url, data=json.dumps(body).encode(), headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=UPDATING_ANNOUNCE_TIMEOUT_SEC) as resp:
                resp.read()
            log(f"announced updating to hub (reason={reason or 'restart'}"
                f"{', v' + version if version else ''})")
        except Exception as e:
            log(f"updating announce failed (continuing shutdown): {e}")

    def request_restart(self):
        """Arm a dashboard-requested manager restart (restartAgent command). We
        do NOT restart inline in handle_commands: run_forever calls
        _restart_if_delivered once the ack for this command has reached the hub,
        so the command leaves the queue before we exit and can't re-fire on the
        next boot (a restart loop)."""
        self._restart_pending = True
        log("restartAgent: queued; will restart once the ack reaches the hub")

    def _restart_if_delivered(self, delivered):
        """Perform an armed restart, but only once `delivered` says a heartbeat
        carrying the command's ack (in `ackedCommands`) reached the hub — which
        means the hub has dropped the command from this host's queue. Exiting
        before that risks the still-queued command re-firing on boot."""
        if self._restart_pending and delivered:
            self._restart_pending = False
            self._perform_restart()

    def _perform_restart(self):
        """Bring the manager back the way a SIGTERM restart (XERK-29) does, but
        triggered from the dashboard rather than the supervisor. Announce the
        expected downtime so the coming heartbeat gap reads as `updating` (not an
        outage), then hand off to whatever will restart us:

        - **Under systemd** (`INVOCATION_ID` set) — a clean exit is enough;
          `Restart=always` brings us back. KillMode=process keeps the sessions.
        - **In a container** — likewise; Docker's restart policy recreates us
          (there's no turma-agentctl to call).
        - **Native without systemd** (turma-agentctl/nohup) — there is NO
          supervisor to restart us on exit, so we relaunch through the ctl
          script (detached so it outlives us). It SIGTERMs this manager, which
          `_handle_shutdown` turns into the announce + exit, then starts a fresh
          one that re-adopts the live sessions."""
        self._announce_updating("restart")
        under_systemd = bool(os.environ.get("INVOCATION_ID"))
        ctl = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "bin", "turma-agentctl")
        if not under_systemd and os.path.isfile(ctl):
            try:
                subprocess.Popen([ctl, "restart"], start_new_session=True,
                                 stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
                log("restartAgent: handed off to turma-agentctl restart")
                return  # the ctl script will SIGTERM us
            except Exception as e:
                log(f"restartAgent: turma-agentctl handoff failed ({e}); exiting")
        log("restartAgent: exiting for the supervisor to restart us")
        raise SystemExit(0)

    def _handle_shutdown(self, signum, frame):
        """SIGTERM/SIGINT: we're being stopped for a restart we can't heartbeat
        through — a container recreate on an image update, or the native updater's
        `systemctl restart`. Announce it as EXPECTED (XERK-29), then exit so the
        supervisor (systemd / Docker) brings us back. Sessions survive natively
        (KillMode=process) and are re-adopted on boot; a container recreate takes
        the whole stack down, which is exactly the outage this status explains."""
        reason, version = self._read_updating_flag()
        self._announce_updating(reason or "restart", version)
        # A probe in flight is on a daemon thread, whose `finally` will NOT run
        # through this exit — so its tmux (and the claude in it) is reaped here
        # instead. Sessions are deliberately left alone; this is only ours.
        self._kill_limits_probe()
        raise SystemExit(0)

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
        # SIGTERM/SIGINT = the supervisor is restarting us (an update swapping
        # files, or a container recreate). Announce it to the hub as an EXPECTED
        # restart before we go silent (XERK-29), then exit for the supervisor to
        # bring us back. Must be set on the main thread, like SIGUSR1 above.
        signal.signal(signal.SIGTERM, self._handle_shutdown)
        signal.signal(signal.SIGINT, self._handle_shutdown)
        self.resume_on_boot()
        beat = 0
        while True:
            # Clear before the beat so a poke that lands *during* it (a command
            # queued while we're mid-cycle) still shortens the next wait rather
            # than being swallowed.
            _poke.clear()
            reply = self.post(self.build_payload(beat))
            beat += 1
            # If a prior beat armed a restart but couldn't confirm its ack
            # reached the hub, this successful beat just carried the ack
            # (ackedCommands rides every payload), so it's now safe to restart.
            self._restart_if_delivered(reply is not None)
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
                    # A restartAgent just acked this beat restarts here — the
                    # follow-up heartbeat above delivered its ack, so we don't
                    # wait a whole interval for the top-of-loop check.
                    self._restart_if_delivered(reply2 is not None)
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
    if "--wire-azure-git" in sys.argv:
        # entrypoint.sh calls this once at boot (as root, before the privilege
        # drop, since it writes --system git config) so plain git can push to a
        # non-GitHub Azure DevOps org using the PAT the board already has.
        # Non-fatal and secret-safe: it logs the host, never the token, and any
        # failure just leaves git unwired.
        cfg = azure_git_auth_config()
        if cfg:
            key, value = cfg
            try:
                subprocess.run(["git", "config", "--system", key, value],
                               check=True)
                site = normalize_azure_site(AZDO_URL) or azure_base()
                print(f"[entrypoint] git: Azure DevOps auth wired for {site} "
                      "(http.extraHeader)")
            except Exception as e:  # pragma: no cover - best effort
                print(f"[entrypoint] git: Azure DevOps auth NOT wired ({e})",
                      file=sys.stderr)
        sys.exit(0)
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
