#!/usr/bin/env python3
"""Translate a dsh (DeepSeek Harness) session event log into the Claude-Code
JSONL transcript shape every Turma surface already parses (XERK-464, [dsh][S1]).

This is the ONE translation seam the dsh integration is built around (XERK-460
G0/D3): dsh's native event-sourced log stays canonical and is retained in full
for metrics, while the agent emits a DERIVED Claude-Code JSONL PROJECTION of it
so the existing read side keeps reading one shape. Projecting here — at the
agent, once — is what keeps the five `readyForReview` mirrors from becoming ten:
`_entry_blocks`/`entryBlocks`, `_entry_text`, the usage accountancy, the PR-chip
scan and the live tail all read the projected JSONL UNCHANGED, so there is no
second transcript shape to teach any client, hub, archive or android surface.

Design contract (do not undo without re-reading D3/D4 in .claude/rules/dsh.md):

- The projection is a PURE FUNCTION of the dsh event log plus a small pinned
  context (session id, cwd, branch, harness version). `DshProjector.feed(event)`
  returns the 0+ Claude-JSONL entry dicts one dsh event projects to, so the
  launcher (D1) appends them to the pinned `<claudeSessionId>.jsonl` INCREMENTALLY
  as events arrive — the existing transcript tail (hub-agent + tunnel-agent) then
  works with no change. `project_log()` is the batch convenience over a whole log.

- Only the three dsh SURFACE event types carry model-visible messages and are
  projected: `user/message`, `assistant/message`, `tool/result` (dsh's own
  `SurfaceEventType`). Everything else — turn/step boundaries, raw chunks,
  request headers, todo snapshots, titles — is log-only and projects to nothing.
  A cancelled turn (`turn/end` reason `aborted`/`user`) projects the same
  `[Request interrupted by user]` marker Claude Code writes, so it renders as an
  interrupt status row rather than vanishing.

- LIVENESS IS DELIBERATELY NOT IN THE PROJECTION. Claude's `paneBusy` reads pane
  content, which a transcript never carries; a dsh session has no pane, so its
  "working" signal (an in-flight turn / `agent.status`) is a heartbeat field for
  [D], read from dsh directly — never inferred from this JSONL. Injecting a
  dsh-only turn marker into the projection would force `entryBlocks` to grow a
  new case, i.e. the exact mirror multiplication this seam exists to avoid.

- TOOL CALLS RIDE THE ASSISTANT MESSAGE. dsh's `assistant/message` carries the
  assembled model turn whose `content` already includes the `tool-call` blocks
  (dsh `AssistantMessage.content` is "Exact model-facing blocks"), so tool_use is
  projected from there and the redundant standalone `tool/call` event is skipped.
  This is what makes PR attribution (D4) work for free: the `gh pr create` call
  lands as a real `tool_use`/`tool_result` pair, not opaque assistant text.

- USAGE + MODEL travel with the assistant turn (D4): `message.usage` and
  `message.model` are populated from the dsh event's `usage`/`message.source`, so
  the per-model token ledger attributes a dsh session's spend with no schema
  change — new (local / DeepSeek) model ids just appear in the breakdown.

Stdlib only — this module is imported by `hub-agent.py`'s dsh launcher and is
kept dependency-free like the rest of `agent/`.
"""

import json
import uuid as _uuidlib
from datetime import datetime, timezone

# A fixed namespace so a given (session id, event seq, sub-index) always projects
# to the SAME entry uuid. Determinism matters: the launcher appends the projection
# incrementally, and a re-projection (resume, replay of the retained native log)
# must reproduce byte-identical uuids so the file does not fork and the usage
# de-dup — keyed on (message id, requestId) — stays exact.
_UUID_NS = _uuidlib.UUID("6f1d3c2a-4b5e-4a6f-8c9d-0e1f2a3b4c5d")

# dsh's three surface event types (its own SurfaceEventType), the only events that
# produce model-visible messages and therefore the only ones we project.
SURFACE_EVENT_TYPES = ("user/message", "assistant/message", "tool/result")

# The interrupt marker Claude Code writes for a user-cancelled turn; INTERRUPT_RE
# in hub-agent.py / tunnel-agent.js matches it and renders it as an interrupt row.
INTERRUPT_MARKER = "[Request interrupted by user]"


def _iso(ms):
    """dsh event `time` (Unix epoch milliseconds) -> the millisecond ISO-8601 Z
    string Claude Code stamps on every entry (`2026-08-25T20:39:22.322Z`). The
    archive dates rows off this (`_last_activity_ts`) and usage buckets off its
    date prefix, so the shape has to match. A non-numeric/absent time yields an
    empty string, which those readers already treat as undated."""
    try:
        ms = int(ms)
    except (TypeError, ValueError):
        return ""
    dt = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _mk_uuid(session_id, seq, index=0):
    """Deterministic per-entry uuid (see _UUID_NS)."""
    return str(_uuidlib.uuid5(_UUID_NS, f"{session_id}:{seq}:{index}"))


def _map_usage(usage):
    """dsh TokenUsage -> Claude Code `message.usage`, the shape `_accumulate_usage`
    / `_token_count` read (`input_tokens`, `output_tokens`,
    `cache_creation_input_tokens`, `cache_read_input_tokens`). dsh's counts are
    disjoint (uncached input in `inputTokens`; cache split out), which is exactly
    Claude's own convention, so the mapping is 1:1. `cacheWriteTokens` is the
    creation half. Returns None when there is nothing countable, so a usage-less
    step projects no `"usage"` key (and thus costs the ledger nothing) rather than
    a fabricated zero."""
    if not isinstance(usage, dict):
        return None
    out = {
        "input_tokens": _int(usage.get("inputTokens")),
        "output_tokens": _int(usage.get("outputTokens")),
        "cache_read_input_tokens": _int(usage.get("cacheReadTokens")),
        "cache_creation_input_tokens": _int(usage.get("cacheWriteTokens")),
    }
    return out


def _int(v):
    """A dsh count coerced to a non-negative int (the ledger re-coerces, but a
    clean projection keeps a float/None from ever reaching the wire). Unusable ->
    0; a fractional value truncates."""
    try:
        n = int(v)
    except (TypeError, ValueError):
        return 0
    return n if n >= 0 else 0


def _content_to_text_blocks(content):
    """dsh ContentBlock[] -> Claude text/thinking blocks for a USER-role or
    tool-result payload (no tool-call blocks are valid here). `text` stays text;
    `reasoning` becomes a `thinking` block; an `image` block projects to a short
    text placeholder (dsh only carries images on user content today, and the raw
    bytes live in the retained native log, not this display projection). An
    unknown block type is passed through as its text if it has one, else dropped —
    the merge-extensible fall-through dsh's own consumers use."""
    blocks = []
    if isinstance(content, str):
        if content:
            blocks.append({"type": "text", "text": content})
        return blocks
    if not isinstance(content, list):
        return blocks
    for b in content:
        if not isinstance(b, dict):
            continue
        bt = b.get("type")
        if bt == "text":
            blocks.append({"type": "text", "text": str(b.get("text") or "")})
        elif bt == "reasoning":
            blocks.append({"type": "thinking", "thinking": str(b.get("text") or "")})
        elif bt == "image":
            blocks.append({"type": "text", "text": "[image]"})
        elif isinstance(b.get("text"), str):
            blocks.append({"type": "text", "text": b["text"]})
    return blocks


def _assistant_content(content):
    """dsh AssistantMessage content -> Claude assistant content blocks, preserving
    the tool-call blocks (which is where tool_use is projected from — see the
    module docstring). `text`->text, `reasoning`->thinking, `tool-call`->tool_use
    with the model's raw `arguments` JSON parsed into `input` (an unparseable
    argument string keeps the model's bytes under `input._raw` so nothing is lost
    and `_tool_use_detail` still gets a dict)."""
    blocks = []
    if not isinstance(content, list):
        return blocks
    for b in content:
        if not isinstance(b, dict):
            continue
        bt = b.get("type")
        if bt == "text":
            blocks.append({"type": "text", "text": str(b.get("text") or "")})
        elif bt == "reasoning":
            blocks.append({"type": "thinking", "thinking": str(b.get("text") or "")})
        elif bt == "tool-call":
            args = b.get("arguments")
            try:
                inp = json.loads(args) if isinstance(args, str) else (args or {})
            except (ValueError, TypeError):
                inp = {}
            if not isinstance(inp, dict):
                inp = {"_value": inp}
            block = {"type": "tool_use", "name": str(b.get("name") or ""), "input": inp}
            if b.get("id"):
                block["id"] = str(b["id"])
            blocks.append(block)
        elif bt == "image":
            blocks.append({"type": "text", "text": "[image]"})
        elif isinstance(b.get("text"), str):
            blocks.append({"type": "text", "text": b["text"]})
    return blocks


class DshProjector:
    """Stateful, single-pass projector: `feed(event)` returns the Claude-JSONL
    entry dicts one dsh event projects to (usually 0 or 1), so a launcher can
    append them to the pinned transcript as events stream in. State is only the
    running `parentUuid` chain — the projection is otherwise a pure per-event map.

    `context` carries the pinned session id and the display envelope the read side
    stamps but does not depend on (cwd, git branch, harness version)."""

    def __init__(self, session_id, cwd=None, git_branch=None, version=None):
        self.session_id = session_id
        self.cwd = cwd
        self.git_branch = git_branch
        # A visible, dsh-tagged version so a projected transcript is never mistaken
        # for a native Claude one and clients that surface `version` say what wrote
        # it. Not parsed by any reader.
        self.version = version or "dsh"
        self._parent = None

    def _envelope(self, entry_type, seq, index=0):
        e = {
            "type": entry_type,
            "uuid": _mk_uuid(self.session_id, seq, index),
            "parentUuid": self._parent,
            "sessionId": self.session_id,
            "isSidechain": False,
            "userType": "external",
            "version": self.version,
        }
        if self.cwd is not None:
            e["cwd"] = self.cwd
        if self.git_branch is not None:
            e["gitBranch"] = self.git_branch
        return e

    def _emit(self, entry):
        """Thread the parentUuid chain and hand the finished entry back."""
        self._parent = entry["uuid"]
        return entry

    def feed(self, event):
        """Project one dsh session event. Returns a list of entry dicts (possibly
        empty). Tolerant of a malformed event (returns [])."""
        if not isinstance(event, dict):
            return []
        etype = event.get("type")
        seq = event.get("seq")
        ts = _iso(event.get("time"))
        data = event.get("data")

        if etype == "user/message":
            return self._user_message(data, seq, ts)
        if etype == "assistant/message":
            return self._assistant_message(data, seq, ts)
        if etype == "tool/result":
            return self._tool_result(data, seq, ts)
        if etype == "turn/end":
            return self._turn_end(data, seq, ts)
        # Every other event (turn/step boundaries, assistant/chunk, request/*,
        # todo/write, session/*, tool/call — see the docstring) is log-only.
        return []

    def _user_message(self, data, seq, ts):
        msg = data if isinstance(data, dict) else {}
        blocks = _content_to_text_blocks(msg.get("content"))
        if not blocks:
            return []
        entry = self._envelope("user", seq)
        entry["timestamp"] = ts
        entry["message"] = {"role": "user", "content": blocks}
        return [self._emit(entry)]

    def _assistant_message(self, data, seq, ts):
        data = data if isinstance(data, dict) else {}
        msg = data.get("message") if isinstance(data.get("message"), dict) else {}
        blocks = _assistant_content(msg.get("content"))
        if not blocks:
            return []
        entry = self._envelope("assistant", seq)
        entry["timestamp"] = ts
        # requestId completes the (message id, requestId) usage-dedup key; a stable
        # per-seq value keeps a re-projected turn from double-counting.
        entry["requestId"] = f"dsh-{seq}"
        message = {
            "id": str(msg.get("id") or f"dsh-msg-{seq}"),
            "type": "message",
            "role": "assistant",
            "content": blocks,
        }
        # Model id: dsh AssistantMessage.source is a ModelMessageSource {provider,
        # model}; the ledger's per-model breakdown keys on message.model.
        src = msg.get("source") if isinstance(msg.get("source"), dict) else {}
        if src.get("model"):
            message["model"] = str(src["model"])
        usage = _map_usage(data.get("usage"))
        if usage is not None:
            message["usage"] = usage
        entry["message"] = message
        return [self._emit(entry)]

    def _tool_result(self, data, seq, ts):
        data = data if isinstance(data, dict) else {}
        msg = data.get("message") if isinstance(data.get("message"), dict) else {}
        # ToolResultMessage.content is a single tool-result block carrying the
        # correlated callId and the model-facing inner content.
        content = msg.get("content")
        trb = content[0] if isinstance(content, list) and content and isinstance(content[0], dict) else {}
        call_id = trb.get("toolCallId") or (msg.get("source") or {}).get("callId")
        inner = _content_to_text_blocks(trb.get("content"))
        result_block = {"type": "tool_result"}
        if call_id:
            result_block["tool_use_id"] = str(call_id)
        result_block["content"] = inner if inner else ""
        if trb.get("isError") or data.get("error"):
            result_block["is_error"] = True
        entry = self._envelope("user", seq)
        entry["timestamp"] = ts
        entry["message"] = {"role": "user", "content": [result_block]}
        return [self._emit(entry)]

    def _turn_end(self, data, seq, ts):
        """A turn cancelled by the user projects the same interrupt marker Claude
        Code writes; every other end reason is log-only (completion is implicit in
        the messages already projected, and errors surface through [D], not as a
        forged transcript turn)."""
        data = data if isinstance(data, dict) else {}
        reason = data.get("reason") if isinstance(data.get("reason"), dict) else {}
        if reason.get("kind") != "aborted":
            return []
        cause = reason.get("reason") if isinstance(reason.get("reason"), dict) else {}
        if cause.get("kind") != "user":
            return []
        entry = self._envelope("user", seq)
        entry["timestamp"] = ts
        entry["message"] = {"role": "user", "content": INTERRUPT_MARKER}
        return [self._emit(entry)]


def project_log(events, session_id, cwd=None, git_branch=None, version=None):
    """Batch convenience: project a whole dsh event log (an iterable of event
    dicts) into the list of Claude-JSONL entry dicts. Equivalent to feeding each
    event to a fresh DshProjector in order."""
    proj = DshProjector(session_id, cwd=cwd, git_branch=git_branch, version=version)
    out = []
    for ev in events:
        out.extend(proj.feed(ev))
    return out


def project_log_lines(events, session_id, **ctx):
    """As project_log, but serialized to newline-terminated JSONL strings ready to
    append to a transcript file (`ensure_ascii=False`, matching Claude Code)."""
    return [
        json.dumps(e, ensure_ascii=False) + "\n"
        for e in project_log(events, session_id, **ctx)
    ]
