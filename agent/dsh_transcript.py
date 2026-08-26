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
import re
import uuid as _uuidlib
from datetime import datetime, timezone

# A synthesized launch's child id / run id names a LIVE-AGENT id and (for a run)
# a directory, and is embedded verbatim into the `agentId:`/`<task-id>` text the
# scan matches on — so it is held to the ASCII grammar hub-agent's own
# VALID_WORKFLOW_AGENT_ID_RE / VALID_WORKFLOW_RUN_ID_RE accept (NOT `str.isalnum`,
# which is Unicode-aware and would pass a char those readers reject, yielding a
# row that never resolves — and it also refuses an id carrying XML / newlines that
# could otherwise break the `<task-notification>` the stop edge rides). dsh mints
# UUIDs, so this never rejects a real id.
_VALID_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

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

# dsh tool name -> the Claude-Code tool name the read side keys on. Only `bash`
# is mapped, and it is a CORRECTNESS requirement, not cosmetics: dsh's shell tool
# registers as `name:"bash"` (`@deepseek-ai/dsh-tool-bash`, verified) with an
# `args.command`, but `_scan_pr_line`'s PR attribution (D4) and `_tool_use_detail`'s
# Bash card both key on the name being `"Bash"` — so an unmapped `bash` running
# `gh pr create` (or `glab mr create` / `az repos pr create`, all of which run
# THROUGH the one bash tool in dsh) silently fails to chip the PR the session
# opened. The mapping lives HERE, in the one seam, rather than teaching every
# reader mirror about dsh names — which is the multiplication this seam exists to
# avoid. Other dsh tools (`str_replace_editor`, `web`, …) pass through under their
# own names: no reader keys on them AND their argument shapes do not match the
# Claude tool the name would imply, so a rename would misrepresent the call. They
# still render as generic tool cards, correctly.
_TOOL_NAME_MAP = {"bash": "Bash"}

# dsh's delegation tools whose RAW tool-call + result the projection REPLACES with
# a synthesized launch/stop pair (XERK-474 [J]). dsh spawns a subagent through the
# `subagent` tool and a workflow through the `workflow` tool; each also fires
# lifecycle events (`turma/subagent-*` from the driver, `tool-workflow/*` in the
# parent log) that carry the child session id the pickers resolve on. The
# synthesized launch reads to hub-agent EXACTLY like a Claude-Code `Agent`/
# `Workflow` background launch — so `_scan_agent_entry`, `_resolve_subagent` and
# `_resolve_workflow_run` all work with no reader change, which is the whole
# projection philosophy (D3). Keeping the raw tool-call TOO would show two launch
# cards for one delegation, so it is dropped. Keyed on dsh's DEFAULT tool names;
# a host that renames them (both are configurable) sees the raw card as well —
# cosmetic, never a broken read.
_DELEGATION_TOOL_NAMES = frozenset({"subagent", "workflow"})

# dsh stop reasons -> the Claude-Code task-notification <status>. Every dsh
# terminal reason maps to one Claude Code writes, ALL of which retire the agent
# from the live set (hub-agent's AGENT_DONE_STATUSES). "completed" is the clean
# finish; the rest are surfaced as they happened rather than flattened to done,
# since a killed/failed child is worth seeing.
_SUBAGENT_STOP_STATUS = {
    "completed": "completed", "aborted": "stopped", "error": "failed",
    "max-tokens": "failed", "refusal": "failed",
}
_WORKFLOW_STOP_STATUS = {
    "completed": "completed", "cancelled": "stopped", "error": "failed",
}


def workflow_run_id(dsh_run_id):
    """The Claude-Code-shaped run id for a dsh `WorkflowRunId`, or "" if it can't
    be one. Claude Code names a run `wf_<...>` and hub-agent's
    VALID_WORKFLOW_RUN_ID_RE / `_resolve_workflow_run` both REQUIRE that prefix,
    while dsh mints a bare UUID — so the projection (this module) and the run
    directory the tail writes BOTH go through here, keeping them one name. The
    body is charset-checked against the reader's own grammar
    (`^wf_[A-Za-z0-9_-]{1,64}$`): a run id that can't satisfy it would resolve to
    nothing, so it is refused here rather than emitted as a row that never opens."""
    raw = str(dsh_run_id or "").strip()
    if not raw:
        return ""
    if not raw.startswith("wf_"):
        raw = "wf_" + raw
    body = raw[len("wf_"):]
    if not _VALID_ID_RE.match(body):
        return ""
    return raw


def _iso(ms):
    """dsh event `time` (Unix epoch milliseconds) -> the millisecond ISO-8601 Z
    string Claude Code stamps on every entry (`2026-08-25T20:39:22.322Z`). The
    archive dates rows off this (`_last_activity_ts`) and usage buckets off its
    date prefix, so the shape has to match. Anything unusable — non-numeric,
    NaN/inf (`int(inf)` raises OverflowError, and `1e999` is legal JSON), or a
    year out of `datetime`'s range — yields an empty string, which those readers
    already treat as undated. `feed()` runs per streamed event in the launcher,
    so a single bad `time` must NEVER abort the projection."""
    try:
        ms = int(ms)
        dt = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return ""
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
    creation half. `reasoningTokens` is deliberately NOT mapped: the pi-ai adapter
    folds reasoning INTO `outputTokens` (`dsh-llm-pi-ai` mapUsage: "reasoning
    folded into output by pi-ai"), exactly as Claude's `output_tokens` includes
    thinking, so counting it again would double-count the model's spend. Returns
    None when there is nothing countable, so a usage-less step projects no
    `"usage"` key (and thus costs the ledger nothing) rather than a fabricated
    zero."""
    if not isinstance(usage, dict):
        return None
    out = {
        "input_tokens": _int(usage.get("inputTokens")),
        "output_tokens": _int(usage.get("outputTokens")),
        "cache_read_input_tokens": _int(usage.get("cacheReadTokens")),
        "cache_creation_input_tokens": _int(usage.get("cacheWriteTokens")),
    }
    # An all-zero block counts for nothing but the model id, so folding it would
    # plant a phantom zero-token row in the usage page's "Tokens by model" table
    # (the same defect the `<synthetic>` guard removes for Claude). It is a real
    # dsh case, not a hypothetical: a local OpenAI-compatible endpoint that
    # returns no usage yields `{}`->all-zero here, and under [G0] (XERK-460 D5)
    # local models may DOMINATE a dsh host's turns. Project no `usage` key then,
    # exactly as a usage-less step does — the totals lose nothing (they were 0).
    if not any(out.values()):
        return None
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
            name = str(b.get("name") or "")
            name = _TOOL_NAME_MAP.get(name, name)
            block = {"type": "tool_use", "name": name, "input": inp}
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
        # Call ids of the raw delegation tool-calls (subagent/workflow) whose
        # paired tool/result must also be dropped — the launch is synthesized
        # from the lifecycle events instead. Populated in _assistant_message,
        # consumed once each in _tool_result.
        self._skip_calls = set()

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
        # Delegation launch/stop (XERK-474 [J]) — projected into the Claude-Code
        # background-launch shapes the pickers and the live-agent scan read, so a
        # dsh session that delegates surfaces IDENTICALLY to a Claude one.
        # `turma/subagent-*` are the driver's forward of dsh's ctx-bus
        # `subagent/start`/`subagent/end`; `tool-workflow/*` are the workflow
        # tool's OWN durable events, already in the parent log.
        if etype == "turma/subagent-start":
            return self._subagent_start(data, seq, ts)
        if etype == "turma/subagent-end":
            return self._subagent_end(data, seq, ts)
        if etype == "tool-workflow/run-start":
            return self._workflow_run_start(data, seq, ts)
        if etype == "tool-workflow/run-end":
            return self._workflow_run_end(data, seq, ts)
        # Every other event (turn/step boundaries, assistant/chunk, request/*,
        # todo/write, session/*, tool/call, tool-workflow/agent-* — see the
        # docstring and DshWorkflowRuns) is log-only for the TRANSCRIPT.
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
        # Drop the raw delegation tool-call (subagent/workflow): its launch is
        # synthesized from the lifecycle events, so keeping the tool_use too would
        # render two launch cards for one delegation. Remember the call id so the
        # paired tool/result is dropped as well. Other content (the model's text
        # around the call) is kept — only the one block is removed.
        if blocks:
            kept = []
            for b in blocks:
                if (b.get("type") == "tool_use"
                        and b.get("name") in _DELEGATION_TOOL_NAMES):
                    if b.get("id"):
                        self._skip_calls.add(str(b["id"]))
                    continue
                kept.append(b)
            blocks = kept
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
        # `source` is a dict on a well-formed event, but a truthy non-dict (`"tool"`,
        # a list) would make `(source or {}).get(...)` raise — feed() must not crash
        # on a malformed event, so guard with isinstance like the sibling handlers.
        src = msg.get("source") if isinstance(msg.get("source"), dict) else {}
        call_id = trb.get("toolCallId") or src.get("callId")
        # The result of a dropped delegation tool-call is dropped too (its launch
        # was synthesized). Consumed once — a call id pairs with one result.
        if call_id and str(call_id) in self._skip_calls:
            self._skip_calls.discard(str(call_id))
            return []
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

    # ---- delegation launch/stop (XERK-474 [J]) -----------------------------
    # These synthesize the on-disk shape a Claude-Code BACKGROUND launch writes,
    # so hub-agent's existing readers resolve a dsh delegation with no change:
    #   * `_scan_agent_entry`/`asyncLaunch` fold the launch's structured
    #     `toolUseResult{status:"async_launched", …}` into the live-agent set
    #     (the row the operator clicks), and retire it on the `<task-notification>`;
    #   * `_resolve_subagent` maps a clicked Agent row to `subagents/agent-<id>.jsonl`
    #     via the Agent tool_use's `subagent_type`/`description` + the `agentId:` in
    #     its result text;
    #   * `_resolve_workflow_run` maps a workflow row to its run dir via the
    #     `toolUseResult`'s `taskType`/`runId`.
    # A launch is TWO entries (the assistant tool_use, then the user tool_result
    # carrying the structured record) exactly as Claude Code writes it — the type
    # of a subagent row is read off the tool_use's `subagent_type` and the row's
    # live-id off the result's `agentId`, so both halves have to be present.

    def _launch_pair(self, seq, tool_name, tool_input, result_text, tur, ts):
        """The assistant tool_use + user tool_result pair that IS a background
        launch. `tur` is the structured `toolUseResult` the readers key on; the
        call id links the two entries and is derived from the launch's own handle
        so a re-projection is byte-stable."""
        call_id = "dsh-" + str(tur.get("agentId") or tur.get("runId") or seq)
        asst = self._envelope("assistant", seq, 0)
        asst["timestamp"] = ts
        asst["message"] = {"id": "dsh-msg-%s" % seq, "type": "message",
                           "role": "assistant",
                           "content": [{"type": "tool_use", "id": call_id,
                                        "name": tool_name, "input": tool_input}]}
        out = [self._emit(asst)]
        res = self._envelope("user", seq, 1)
        res["timestamp"] = ts
        res["message"] = {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": call_id, "content": result_text}]}
        res["toolUseResult"] = tur
        out.append(self._emit(res))
        return out

    def _task_notification(self, seq, ts, task_id, status):
        """The `<task-notification>` user turn that retires a background launch
        (its `<task-id>` is the launch's `agentId`/run id). A plain string
        message content, like Claude Code's own — hub-agent's `_parse_task_notification`
        / `parseTaskNotification` read it, and `_entry_blocks` renders it as a card."""
        entry = self._envelope("user", seq)
        entry["timestamp"] = ts
        entry["message"] = {"role": "user", "content": (
            "<task-notification><task-id>%s</task-id><status>%s</status>"
            "</task-notification>" % (task_id, status))}
        return [self._emit(entry)]

    def _subagent_start(self, data, seq, ts):
        data = data if isinstance(data, dict) else {}
        child = str(data.get("childId") or data.get("id") or "").strip()
        if not _VALID_ID_RE.match(child):
            return []
        # The row's label AND the tool_use description come from ONE value, so
        # `_resolve_subagent` (which matches the clicked row's label against the
        # tool_use description) always resolves. A real label rides the event when
        # the driver knows it; else the child id keeps resolution self-consistent.
        label = str(data.get("label") or "").strip() or child
        tur = {"status": "async_launched", "agentId": child,
               "agentType": "subagent", "description": label}
        return self._launch_pair(
            seq, "Agent", {"subagent_type": "subagent", "description": label},
            "Async agent launched successfully. agentId: %s" % child, tur, ts)

    def _subagent_end(self, data, seq, ts):
        data = data if isinstance(data, dict) else {}
        child = str(data.get("childId") or data.get("id") or "").strip()
        if not _VALID_ID_RE.match(child):
            return []
        status = _SUBAGENT_STOP_STATUS.get(
            str(data.get("stopReason") or "").strip(), "completed")
        return self._task_notification(seq, ts, child, status)

    def _workflow_run_start(self, data, seq, ts):
        data = data if isinstance(data, dict) else {}
        run_id = workflow_run_id(data.get("runId"))
        if not run_id:
            return []
        name = str(data.get("name") or "").strip()
        # taskId == runId: `_async_launch` keys the live row on `taskId` while
        # `_resolve_workflow_run` keys the run dir on `runId`, so they are one id.
        tur = {"status": "async_launched", "taskType": "local_workflow",
               "workflowName": name, "runId": run_id, "taskId": run_id}
        return self._launch_pair(
            seq, "Workflow", {"name": name},
            "Workflow run started. runId: %s" % run_id, tur, ts)

    def _workflow_run_end(self, data, seq, ts):
        data = data if isinstance(data, dict) else {}
        run_id = workflow_run_id(data.get("runId"))
        if not run_id:
            return []
        status = _WORKFLOW_STOP_STATUS.get(
            str(data.get("stopReason") or "").strip(), "completed")
        return self._task_notification(seq, ts, run_id, status)


class DshWorkflowRuns:
    """Folds a dsh session's durable `tool-workflow/*` events into the per-run
    account the Claude-Code workflow pickers read (XERK-304, XERK-474 [J]): the
    run RECORD (`workflows/<runId>.json` — `workflowProgress[]`), the finished
    set (`journal.jsonl`), and which child agents belong to which run (so the
    tail files each agent's transcript under the run dir rather than flat).

    Fed the SAME parent event stream as `DshProjector` (in file order). Pure and
    in-memory; `agent/dsh_session.py`'s tail turns its output into the files
    hub-agent's `_workflow_run_record` / `_workflow_agents` / `_workflow_finished_agents`
    already parse. dsh's workflow tool is FOREGROUND, but it appends these events
    as the run progresses, so the record exists and carries live states WHILE the
    run is on-screen — unlike Claude Code, which writes its record only at the end.

    Agents are keyed by `seq` (1-based per run): `tool-workflow/agent-start`
    carries `{seq, label, phase?, childId}` and `tool-workflow/agent-end` carries
    `{seq, outcome}` with NO childId, so seq is the only join between the two."""

    # dsh WorkflowAgentOutcome -> the state a Claude workflow record row carries.
    _OUTCOME = {"completed": "done", "failed": "failed", "cancelled": "skipped"}

    def __init__(self):
        # claude runId -> {"name", "agents": {seq: {childId,label,phase,state,startedAt}}}
        self.runs = {}
        self._child_run = {}   # childId -> claude runId
        self._dirty = set()    # runIds whose record/journal the tail should rewrite

    def _run(self, run_id):
        return self.runs.setdefault(run_id, {"name": "", "agents": {}})

    def feed(self, event):
        """Fold one parent event. Tolerant of a malformed event (does nothing)."""
        if not isinstance(event, dict):
            return
        etype = event.get("type")
        data = event.get("data")
        data = data if isinstance(data, dict) else {}
        if etype == "tool-workflow/run-start":
            run_id = workflow_run_id(data.get("runId"))
            if run_id:
                self._run(run_id)["name"] = str(data.get("name") or "").strip()
                self._dirty.add(run_id)
        elif etype == "tool-workflow/agent-start":
            run_id = workflow_run_id(data.get("runId"))
            child = str(data.get("childId") or "").strip()
            seq = data.get("seq")
            if not run_id or not child or not isinstance(seq, int):
                return
            run = self._run(run_id)
            prev = run["agents"].get(seq) or {}
            run["agents"][seq] = {
                "childId": child,
                "label": str(data.get("label") or "").strip(),
                "phase": str(data.get("phase") or "").strip(),
                "state": prev.get("state") or "running",
                "startedAt": event.get("time"),
            }
            self._child_run[child] = run_id
            self._dirty.add(run_id)
        elif etype == "tool-workflow/agent-end":
            run_id = workflow_run_id(data.get("runId"))
            seq = data.get("seq")
            if not run_id or not isinstance(seq, int):
                return
            run = self._run(run_id)
            row = run["agents"].get(seq)
            if not row:
                return
            row["state"] = self._OUTCOME.get(
                str(data.get("outcome") or "").strip(), row.get("state") or "running")
            self._dirty.add(run_id)
        # tool-workflow/run-end needs no record change: per-agent end states carry
        # the outcome, and the run's own stop is the transcript task-notification.

    def run_of_child(self, child_id):
        """The claude runId a workflow agent belongs to, or None for an ordinary
        (non-workflow) subagent — which decides where the tail files its transcript."""
        return self._child_run.get(str(child_id or "").strip())

    def take_dirty(self):
        """The runIds whose record/journal changed since the last call, clearing
        the set — the tail rewrites exactly those files."""
        d, self._dirty = self._dirty, set()
        return d

    def record(self, run_id):
        """The run's `workflows/<runId>.json` body, in the shape
        `_workflow_run_record`/`_workflow_progress_rows` parse, or None if unknown.
        `startedAt` stays epoch ms — `_epoch_ms_iso` normalizes it, and the record
        must not diverge from Claude's (a number there, ISO on the transcript)."""
        run = self.runs.get(run_id)
        if not run:
            return None
        rows = []
        for seq in sorted(run["agents"]):
            a = run["agents"][seq]
            row = {"type": "workflow_agent", "agentId": a["childId"],
                   "label": a["label"], "index": seq, "state": a["state"]}
            if a.get("startedAt") is not None:
                row["startedAt"] = a["startedAt"]
            if a.get("phase"):
                row["phase"] = a["phase"]
            rows.append(row)
        return {"runId": run_id, "workflowName": run["name"], "workflowProgress": rows}

    def finished(self, run_id):
        """The `journal.jsonl` lines for a run — one `{"type":"result","agentId":…}`
        per agent that reached a TERMINAL state — as a list of dicts. The record's
        per-agent `state` already covers the picker, so the journal is the fallback
        `_workflow_finished_agents` reads; writing it keeps the layout complete."""
        run = self.runs.get(run_id)
        if not run:
            return []
        out = []
        for seq in sorted(run["agents"]):
            a = run["agents"][seq]
            if a["state"] in ("done", "failed", "skipped"):
                out.append({"type": "result", "agentId": a["childId"]})
        return out


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
