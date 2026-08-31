#!/usr/bin/env python3
"""Project a Qwen Code native session log into the Claude-Code JSONL transcript
shape every Turma surface already parses (XERK-508, [Qwen][S1]).

This is the read-side load-bearing piece of the Qwen runtime (XERK-504), the
interactive-TUI analogue of dsh's `dsh_transcript.py` ([dsh][S1], XERK-464).
Qwen Code (`@qwen-code/qwen-code`) writes a native JSONL log whose events are a
`uuid`/`parentUuid`-linked list — structurally close to Claude Code's, but NOT
identical: roles, block shapes, tool calls and token counts all differ. Rather
than teach every reader mirror a second shape, the launcher's tail projects the
native log ONCE, agent-side, into the shape the existing read side already
consumes — so `_entry_blocks`/`entryBlocks`, `_entry_text`, the usage
accountancy, the PR-chip scan and the live tail all read the projection
UNCHANGED. There is NO new reader, NO JS translator: the "py/js parity" this
ticket names is that the projected JSONL renders IDENTICALLY under
`_entry_blocks` (py) and `entryBlocks` (js). Adding a second reader/shape is the
mirror multiplication this seam exists to avoid.

Design contract (verified against real Qwen Code 0.22.2, `docs/qwen-g0-spike.md`
and the corpus under `docs/qwen-g0/corpus/`):

- The projection is a PURE FUNCTION of the Qwen event log plus a small pinned
  context (session id, cwd, branch, version). `QwenProjector.feed(event)`
  returns the 0+ Claude-JSONL entry dicts one Qwen event projects to, so the
  launcher (XERK-507 [Qwen B]) appends them to the pinned `<claudeSessionId>.jsonl`
  INCREMENTALLY as events arrive. `project_log()` is the batch form.

- Only the three Qwen SURFACE event types carry model-visible messages and are
  projected: `user`, `assistant`, `tool_result`. Every `system` event
  (`attribution_snapshot`, `file_history_snapshot`, `ui_telemetry`,
  `slash_command`, …) is log-only and projects to nothing — including the
  `ui_telemetry` `api_response` rows, whose token counts are NOT the usage
  source (that rides the assistant event's `usageMetadata`, below), so nothing is
  double-counted. A user turn Qwen writes carrying the `[Request interrupted by
  user]` marker flows through as an ordinary user text message and the reader's
  own `INTERRUPT_RE` classifies it — no special case here.

- TOOL CALLS RIDE THE ASSISTANT MESSAGE. A Qwen assistant turn's `message.parts`
  carries the model's `functionCall` blocks inline; tool_use is projected from
  there. The `ui_telemetry` `qwen-code.tool_call` row that mirrors each call is a
  `system` event and drops, so exactly ONE tool_use appears per call — which is
  what makes PR attribution ([Qwen H]) work: `gh pr create` lands as a real
  `tool_use`/`tool_result` pair, not opaque text.

- `run_shell_command` -> `Bash` NAME MAP. Qwen's shell tool registers as
  `run_shell_command` with an `args.command` (verified in the corpus), while
  `_scan_pr_line`'s PR attribution and `_tool_use_detail`'s Bash card both key on
  the tool_use `name` being `"Bash"`. Mapping it HERE, in the one seam, is what
  makes a `gh pr create` (or `glab mr create` / `az repos pr create`, all run
  through the one shell tool) chip the PR it opened. Every other Qwen tool
  (`write_file`, `read_file`, `tool_search`, …) passes through under its own name:
  no reader keys on it, and its argument shape does not match the Claude tool a
  rename would imply, so it renders as a generic tool card, correctly.

- USAGE + MODEL ride the assistant entry. Qwen's Gemini-shaped `usageMetadata`
  maps into Claude's DISJOINT `input/output/cache_read/cache_creation` counts (see
  `_map_usage`), and `message.model` comes from the event's real `model` id — so
  the per-model token ledger attributes a Qwen session's spend with no schema
  change, and local/OpenAI-endpoint model ids simply appear in the breakdown. A
  step with no usage (or an all-zero block) projects NO `usage` key — never a
  fabricated zero, which would poison the per-model denominator.

- DETERMINISTIC UUIDS (uuid5 over session id + seq), so replaying the retained
  native log re-projects BYTE-IDENTICALLY: the launcher appends the projection
  incrementally, and a re-projection (resume, replay) must reproduce the same
  uuids so the file does not fork and the usage de-dup stays exact.

- DELEGATION rides the SAME seam (XERK-517 [Qwen J]). Qwen's subagent tool is a
  near-Claude `Agent` launch (`agent` name mapped to `Agent`), but its
  tool_result is a `task_execution` resultDisplay rather than Claude's
  `async_launched` toolUseResult, so `_subagent_launch` RESHAPES it into the
  Claude background-launch record — the launch row and drill-in resolve with no
  reader change (the XERK-304 contract). Qwen already writes an exact Claude
  `<task-notification>` for the STOP edge, which passes through as a user turn.
  Each child's own native log is projected into the Claude `subagents/` layout by
  the tail (`agent/qwen_session.py`), never by this module. Workflows have no
  Claude-shaped on-disk mapping evidenced yet and are a stated residual gap.

Stdlib only — imported by the Qwen launcher/tail in `hub-agent.py`, kept
dependency-free like the rest of `agent/`.
"""

import os
import re
import sys
import uuid as _uuidlib

# Import the shared projector scaffolding as a sibling module — the identical
# envelope/uuid/emit core and the batch drivers live in runtime_projection.py
# (XERK-528). Ensure this dir is on sys.path first: a transcript test execs THIS
# module by path before hub-agent.py runs, so the dir is not yet on the path
# (same idiom hub-agent.py uses for its own siblings).
_AGENT_DIR = os.path.dirname(os.path.abspath(__file__))
if _AGENT_DIR not in sys.path:
    sys.path.insert(0, _AGENT_DIR)
from runtime_projection import (  # noqa: E402
    BaseProjector,
    coerce_int as _int,
    project_log as _project_log,
    project_log_lines as _project_log_lines,
)

# A fixed namespace so a given (session id, event seq, sub-index) always projects
# to the SAME entry uuid — see the DETERMINISTIC UUIDS note above.
_UUID_NS = _uuidlib.UUID("b2c7f4e1-9a3d-4e6f-8b0c-1d2e3f4a5b6c")

# A subagent's agentId names a live-agent row AND its transcript file
# (subagents/agent-<id>.jsonl), and is written verbatim into the `agentId:` text
# `_resolve_subagent` matches on — so it is held to the ASCII grammar hub-agent's
# own `VALID_WORKFLOW_AGENT_ID_RE` / `_AGENT_ID_RE` accept (NOT `str.isalnum`,
# which is Unicode-aware and would pass a char those readers reject, or an id
# carrying XML/newlines that could break the `<task-notification>` the stop edge
# rides). Qwen mints `<subagent_type>-call_<hex>`, so this never rejects a real id.
_VALID_AGENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# The `task_id: <id>` line Qwen writes into a BACKGROUND `agent` launch's tool
# result output — the authoritative agentId (it also names the child transcript
# `agent-<id>.jsonl`). A foreground subagent's result carries the agent's real
# output instead, so the id is reconstructed as `<subagentName>-<callId>` there.
_TASK_ID_RE = re.compile(r"task_id:\s*(\S+)")

# Qwen's three surface event types — the only ones producing model-visible
# messages and therefore the only ones projected. Everything else is log-only.
SURFACE_EVENT_TYPES = ("user", "assistant", "tool_result")

# Qwen tool name -> the Claude-Code tool name the read side keys on. Only the
# shell tool is mapped, and it is a CORRECTNESS requirement, not cosmetics: Qwen's
# shell tool registers as `run_shell_command` with `args.command` (verified in the
# corpus), but `_scan_pr_line`'s PR attribution and `_tool_use_detail`'s Bash card
# both key on the name being `"Bash"`. The mapping lives HERE, in the one seam,
# rather than teaching every reader mirror about Qwen names.
_TOOL_NAME_MAP = {"run_shell_command": "Bash", "agent": "Agent"}

# Qwen's subagent-delegation tool (`agent`, mapped to `Agent` above). Its
# tool_result carries a `toolCallResult.resultDisplay` of type `task_execution`
# — NOT Claude Code's `toolUseResult{status:"async_launched"}` — so the launch
# is invisible to `_scan_agent_entry` / `_resolve_subagent` until [Qwen J]
# reshapes it (XERK-517). `_subagent_launch` below detects that shape.
_QWEN_AGENT_TOOL = "agent"

# A permissive ISO-8601 UTC shape. Qwen already stamps each row with a
# millisecond ISO-8601 Z timestamp — the EXACT shape Claude Code writes
# (`2026-08-28T18:08:40.134Z`) — so it is passed through VERBATIM when it matches
# (keeping the byte-identical reprojection), and dropped to "" otherwise, which
# the archive's `_last_activity_ts` and the usage date-bucketer already treat as
# undated. `feed()` runs per streamed event, so one bad timestamp must never abort
# the projection.
_ISO_TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$")


def _iso(ts):
    """A Qwen row's `timestamp` passed through verbatim when it is a well-formed
    ISO-8601 UTC string, else "" (undated)."""
    if isinstance(ts, str) and _ISO_TS_RE.match(ts):
        return ts
    return ""


def _map_usage(usage):
    """Qwen `usageMetadata` (Gemini-shaped) -> Claude Code `message.usage`, the
    shape `_accumulate_usage`/`_token_count` read (`input_tokens`, `output_tokens`,
    `cache_creation_input_tokens`, `cache_read_input_tokens`).

    Claude's convention is DISJOINT counts: `input_tokens` is the UNCACHED prompt
    and `cache_read_input_tokens` is the cached prompt, the two summing to the
    whole prompt. Qwen/Gemini's `promptTokenCount` is the WHOLE prompt (cached
    included) and `cachedContentTokenCount` is the cached subset, so the uncached
    input is `promptTokenCount - cachedContentTokenCount` (clamped at 0 against
    malformed data). `candidatesTokenCount` is the output and ALREADY INCLUDES
    `thoughtsTokenCount` (verified against the corpus: promptTokenCount +
    candidatesTokenCount == totalTokenCount, with thoughts a subset of
    candidates), exactly as Claude's `output_tokens` includes thinking — so
    `thoughtsTokenCount` is deliberately NOT added again, which would double-count
    the model's reasoning spend. Qwen has no cache-CREATION concept, so that count
    is 0.

    Returns None when nothing is countable, so a usage-less step projects no
    `"usage"` key (costing the ledger nothing) rather than a fabricated zero. An
    all-zero block — a local OpenAI-compatible endpoint that returns no usage,
    which under Qwen may DOMINATE a host's turns — is likewise dropped, so it does
    not plant a phantom zero-token model in the usage page's per-model table (the
    `<synthetic>` defect for Claude)."""
    if not isinstance(usage, dict):
        return None
    prompt = _int(usage.get("promptTokenCount"))
    cached = _int(usage.get("cachedContentTokenCount"))
    out = {
        "input_tokens": prompt - cached if prompt > cached else 0,
        "output_tokens": _int(usage.get("candidatesTokenCount")),
        "cache_read_input_tokens": cached,
        "cache_creation_input_tokens": 0,
    }
    if not any(out.values()):
        return None
    return out


def _user_content(parts):
    """Qwen user `message.parts` -> Claude user content blocks. A user turn
    carries only `{text}` parts (its tool responses are their own `tool_result`
    events); anything else with a `text` is kept as text, else dropped."""
    blocks = []
    if isinstance(parts, str):
        if parts:
            blocks.append({"type": "text", "text": parts})
        return blocks
    if not isinstance(parts, list):
        return blocks
    for p in parts:
        if not isinstance(p, dict):
            continue
        if isinstance(p.get("text"), str) and p["text"]:
            blocks.append({"type": "text", "text": p["text"]})
    return blocks


def _assistant_content(parts):
    """Qwen assistant `message.parts` -> Claude assistant content blocks,
    preserving the tool-call blocks (where tool_use is projected from). Qwen
    distinguishes visible text from reasoning by a `thought:true` flag on a text
    part (NOT a separate block type), so a `{text, thought:true}` becomes a
    `thinking` block and a plain `{text}` stays text. A `{functionCall:{id,name,
    args}}` becomes a `tool_use` — `args` is already the parsed argument object,
    and the tool name is run through `_TOOL_NAME_MAP`."""
    blocks = []
    if not isinstance(parts, list):
        return blocks
    for p in parts:
        if not isinstance(p, dict):
            continue
        fc = p.get("functionCall")
        if isinstance(fc, dict):
            args = fc.get("args")
            if not isinstance(args, dict):
                args = {} if args is None else {"_value": args}
            name = str(fc.get("name") or "")
            name = _TOOL_NAME_MAP.get(name, name)
            block = {"type": "tool_use", "name": name, "input": args}
            if fc.get("id"):
                block["id"] = str(fc["id"])
            blocks.append(block)
        elif isinstance(p.get("text"), str) and p["text"]:
            if p.get("thought"):
                blocks.append({"type": "thinking", "thinking": p["text"]})
            else:
                blocks.append({"type": "text", "text": p["text"]})
    return blocks


def _subagent_launch(fr, resp, tcr, call_id):
    """Detect a Qwen `agent`-tool subagent launch and return
    `(agentId, subagentType, description, backgrounded)`, or None if `fr` is not
    an `agent` tool response Qwen wrote a `task_execution` result for (XERK-517
    [Qwen J]). This is the ONE Qwen-specific delegation shape; everything the
    reshaped entry then feeds — `_scan_agent_entry`, `_resolve_subagent` — is
    Claude-Code-native and unchanged.

    Qwen's delegation is a near-Claude launch pair (verified against real Qwen
    0.22.x captures): the assistant `agent` tool_use carries
    `{description, subagent_type, prompt}` (projected to a Claude `Agent`
    tool_use via `_TOOL_NAME_MAP`), and the tool_result carries a
    `toolCallResult.resultDisplay` of type `task_execution` with `subagentName`,
    `taskDescription` and `status` ("background" for an in-flight launch, else a
    terminal state for a synchronous one). The agentId — which names the child
    transcript `agent-<id>.jsonl` — is the `task_id:` Qwen prints into a
    background launch's output, reconstructed as `<subagentName>-<callId>` for a
    synchronous one (that is exactly how Qwen names the on-disk file). A malformed
    or grammar-failing id yields None, so the result projects as a plain tool card
    rather than an unresolvable row."""
    if not isinstance(fr, dict) or str(fr.get("name") or "") != _QWEN_AGENT_TOOL:
        return None
    rd = tcr.get("resultDisplay") if isinstance(tcr, dict) else None
    if not isinstance(rd, dict) or rd.get("type") != "task_execution":
        return None
    subagent_type = str(rd.get("subagentName") or "").strip()
    description = str(rd.get("taskDescription") or "").strip()
    output = str(resp.get("output") or "") if isinstance(resp, dict) else ""
    m = _TASK_ID_RE.search(output)
    aid = m.group(1).strip() if m else ""
    if not aid and subagent_type and call_id:
        aid = "%s-%s" % (subagent_type, call_id)
    if not _VALID_AGENT_ID_RE.match(aid):
        return None
    backgrounded = rd.get("status") == "background"
    return aid, subagent_type, description, backgrounded


class QwenProjector(BaseProjector):
    """Stateful, single-pass projector: `feed(event)` returns the Claude-JSONL
    entry dicts one Qwen native-log event projects to (usually 0 or 1), so a
    launcher can append them to the pinned transcript as events stream in. State
    is only the running `parentUuid` chain (BaseProjector) and the per-feed
    sequence counter — the projection is otherwise a pure per-event map.

    `context` carries the pinned session id and the display envelope the read side
    stamps but does not depend on (cwd, git branch, version). The envelope, the
    deterministic uuid and the parentUuid threading are BaseProjector's; only the
    per-event mapping below is Qwen-specific."""

    UUID_NS = _UUID_NS
    # A visible, qwen-tagged version so a projected transcript is never mistaken
    # for a native Claude one and clients that surface `version` say what wrote it.
    # Not parsed by any reader.
    VERSION_TAG = "qwen"

    def __init__(self, session_id, cwd=None, git_branch=None, version=None):
        super().__init__(session_id, cwd=cwd, git_branch=git_branch, version=version)
        # Increments per fed event (whether or not it projects), so the seq the
        # deterministic uuid is derived from is the event's position in the log —
        # stable across a replay of the same log in the same order.
        self._seq = -1

    def feed(self, event):
        """Project one Qwen native-log event. Returns a list of entry dicts
        (possibly empty). Tolerant of a malformed event (returns [])."""
        self._seq += 1
        if not isinstance(event, dict):
            return []
        etype = event.get("type")
        ts = _iso(event.get("timestamp"))
        msg = event.get("message") if isinstance(event.get("message"), dict) else {}

        if etype == "user":
            return self._user_message(msg, ts)
        if etype == "assistant":
            return self._assistant_message(event, msg, ts)
        if etype == "tool_result":
            return self._tool_result(event, msg, ts)
        # Every `system` event (attribution/file-history/telemetry/slash-command)
        # and anything unknown is log-only for the transcript.
        return []

    def _user_message(self, msg, ts):
        blocks = _user_content(msg.get("parts"))
        if not blocks:
            return []
        entry = self._envelope("user", self._seq)
        entry["timestamp"] = ts
        entry["message"] = {"role": "user", "content": blocks}
        return [self._emit(entry)]

    def _assistant_message(self, event, msg, ts):
        blocks = _assistant_content(msg.get("parts"))
        if not blocks:
            return []
        entry = self._envelope("assistant", self._seq)
        entry["timestamp"] = ts
        # requestId completes the (message id, requestId) usage-dedup key; a stable
        # per-seq value keeps a re-projected turn from double-counting.
        entry["requestId"] = f"qwen-{self._seq}"
        # The event's own uuid is a stable, unique per-turn id — reuse it as the
        # message id (the other half of the dedup key) rather than minting one.
        mid = str(event.get("uuid") or "").strip() or f"qwen-msg-{self._seq}"
        message = {
            "id": mid,
            "type": "message",
            "role": "assistant",
            "content": blocks,
        }
        model = event.get("model")
        if isinstance(model, str) and model:
            message["model"] = model
        usage = _map_usage(event.get("usageMetadata"))
        if usage is not None:
            message["usage"] = usage
        entry["message"] = message
        return [self._emit(entry)]

    def _tool_result(self, event, msg, ts):
        # A tool_result carries a single `functionResponse` part correlating the
        # call id with the model-facing output (or error).
        parts = msg.get("parts")
        fr = {}
        if isinstance(parts, list):
            for p in parts:
                if isinstance(p, dict) and isinstance(p.get("functionResponse"), dict):
                    fr = p["functionResponse"]
                    break
        call_id = fr.get("id")
        resp = fr.get("response") if isinstance(fr.get("response"), dict) else {}
        # A well-formed response carries exactly one of `output`/`error`; error
        # wins if both are somehow present.
        is_error = False
        if "error" in resp:
            text = str(resp.get("error") or "")
            is_error = True
        else:
            text = str(resp.get("output") or "")
        # `toolCallResult` corroborates the error state (a hard-denied /
        # non-started call still carries an `error` response, so this is
        # belt-and-suspenders, not the only signal).
        tcr = event.get("toolCallResult")
        if isinstance(tcr, dict) and (
                tcr.get("status") == "error" or tcr.get("executionStatus") == "error"):
            is_error = True
        # Delegation (XERK-517 [Qwen J]): reshape a Qwen `agent`-tool launch into
        # the Claude-Code background-launch record the readers already parse, so
        # `_scan_agent_entry` registers the live row and `_resolve_subagent` opens
        # the child transcript with NO reader change (the XERK-304 contract). The
        # subagent's OWN turns never touch this parent transcript — they live in
        # the child log (`subagents/<parent>/agent-<id>.jsonl`), which the tail
        # projects into the Claude `subagents/` layout.
        tool_use_result = None
        launch = _subagent_launch(fr, resp, tcr, call_id)
        if launch:
            aid, subagent_type, description, backgrounded = launch
            if backgrounded:
                # An in-flight background launch: the async_launched record makes
                # it a LIVE agent row, and Qwen's own `<task-notification>` (a
                # plain user turn this projector passes through) retires it later.
                # The clean launch text replaces Qwen's verbose output (which
                # leaks the internal output_file path) and carries the `agentId:`
                # `_resolve_subagent` keys on.
                text = "Async agent launched successfully. agentId: %s" % aid
                tool_use_result = {"status": "async_launched", "agentId": aid,
                                   "agentType": subagent_type or "agent",
                                   "description": description}
                is_error = False
            elif aid not in text:
                # A synchronous subagent that already finished: keep its result
                # (the parent model consumed it) but make it RESOLVABLE — NOT a
                # live row, since no `<task-notification>` will retire it, so
                # marking it async_launched would strand a permanent phantom
                # (the same reason `_async_launch` excludes a sync subagent).
                text = "agentId: %s\n%s" % (aid, text)
        result_block = {"type": "tool_result"}
        if call_id:
            result_block["tool_use_id"] = str(call_id)
        result_block["content"] = text
        if is_error:
            result_block["is_error"] = True
        entry = self._envelope("user", self._seq)
        entry["timestamp"] = ts
        entry["message"] = {"role": "user", "content": [result_block]}
        if tool_use_result is not None:
            entry["toolUseResult"] = tool_use_result
        return [self._emit(entry)]


def project_log(events, session_id, cwd=None, git_branch=None, version=None):
    """Batch convenience: project a whole Qwen event log (an iterable of event
    dicts) into the list of Claude-JSONL entry dicts. Equivalent to feeding each
    event to a fresh QwenProjector in order."""
    return _project_log(QwenProjector, events, session_id, cwd=cwd,
                        git_branch=git_branch, version=version)


def project_log_lines(events, session_id, **ctx):
    """As project_log, but serialized to newline-terminated JSONL strings ready to
    append to a transcript file (`ensure_ascii=False`, matching Claude Code)."""
    return _project_log_lines(QwenProjector, events, session_id, **ctx)
