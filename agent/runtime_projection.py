#!/usr/bin/env python3
"""Shared scaffolding for the per-runtime transcript projectors (XERK-528).

A per-session runtime that is NOT Claude Code (dsh — `dsh_transcript.py` [S1];
qwen — `qwen_transcript.py` [Qwen S1]) writes its OWN native event log, and the
launcher's tail PROJECTS that log into the Claude-Code JSONL shape every Turma
surface already reads — so `_entry_blocks`/`entryBlocks`, the usage accountancy,
the PR scan, the archive and the live tail consume it UNCHANGED. That contract
(dsh ADR D3, inherited by qwen) forbids a second reader, a second transcript
shape, or an `agentType` branch on any shared READ path.

This module is the other half of that discipline: the two projectors were, by
construction, near-identical copies of the SAME envelope/uuid/emit scaffolding
around a small per-runtime mapping core (the qwen file was copied from the dsh
one). This holds the identical part ONCE. It does NOT collapse the two projectors
into a single `agentType`-branching reader — each runtime keeps its own
`*Projector` subclass carrying its own event handlers, surface-type names,
tool-name map, usage math and delegation strategy. Only the parts that were
byte-for-byte the same live here:

  * `coerce_int` — a token count coerced to a non-negative int, never raising.
  * `BaseProjector` — the pinned-context envelope, the deterministic per-entry
    uuid (uuid5 over session id + seq + sub-index), the `parentUuid` threading,
    and the empty `feed` contract each subclass fills in.
  * `project_log` / `project_log_lines` — the batch drivers, parameterized by the
    concrete projector class.

Stdlib only, like the projectors it backs — imported by them as a sibling module.
"""

import json
import math
import os
import sys
import uuid as _uuidlib

# Make this module importable as a sibling both when a projector runs as part of
# hub-agent.py (its own dir is already on sys.path) and when a projector is loaded
# by PATH in a test (importlib spec loading does not add the dir, and a transcript
# test execs the projector BEFORE it loads hub-agent.py). Same idiom hub-agent.py
# uses for its own siblings.
_AGENT_DIR = os.path.dirname(os.path.abspath(__file__))
if _AGENT_DIR not in sys.path:
    sys.path.insert(0, _AGENT_DIR)


def coerce_int(v):
    """A token count coerced to a non-negative int (the ledger re-coerces, but a
    clean projection keeps a float/None from ever reaching the wire). Unusable ->
    0; a fractional value truncates; a bool is not a count.

    A projector's `feed()` runs per streamed event in the launcher, so this must
    NEVER raise — a single bad usage field must not abort the projection. Two
    non-finite floats are the trap the codebase has hit before (`_token_count`,
    `read_limits_snapshot`, `_archive_known`): `1e999` is legal RFC-8259 JSON that
    `json.loads` yields as `inf`, and `int(inf)` raises OverflowError — NOT one of
    the obvious two — while `int(nan)` raises ValueError. isfinite screens both,
    and OverflowError is caught as a backstop for any other numeric type `int()`
    cannot render."""
    if isinstance(v, bool):
        return 0
    if isinstance(v, float) and not math.isfinite(v):
        return 0
    try:
        n = int(v)
    except (TypeError, ValueError, OverflowError):
        return 0
    return n if n >= 0 else 0


class BaseProjector:
    """Stateful, single-pass projector scaffolding. A subclass sets `UUID_NS` (a
    fixed namespace so a given (session id, seq, sub-index) always projects to the
    SAME entry uuid — determinism matters because the launcher appends the
    projection incrementally and a re-projection on resume/replay must reproduce
    byte-identical uuids so the file does not fork and the usage de-dup stays
    exact) and `VERSION_TAG` (the visible, runtime-tagged `version` stamped on
    every entry so a projected transcript is never mistaken for a native Claude
    one; not parsed by any reader), then implements `feed`.

    State is only the running `parentUuid` chain and whatever the subclass adds —
    the projection is otherwise a pure per-event map. `cwd`/`git_branch`/`version`
    are the display envelope the read side stamps but does not depend on."""

    # A fixed uuid5 namespace, distinct per runtime so two runtimes can never
    # collide even on the same session id. Subclasses MUST override.
    UUID_NS = _uuidlib.UUID("00000000-0000-0000-0000-000000000000")
    # The default `version` tag when the caller passes none.
    VERSION_TAG = "runtime"

    def __init__(self, session_id, cwd=None, git_branch=None, version=None):
        self.session_id = session_id
        self.cwd = cwd
        self.git_branch = git_branch
        self.version = version or self.VERSION_TAG
        self._parent = None

    def _mk_uuid(self, seq, index=0):
        """Deterministic per-entry uuid (see UUID_NS)."""
        return str(_uuidlib.uuid5(self.UUID_NS, f"{self.session_id}:{seq}:{index}"))

    def _envelope(self, entry_type, seq, index=0):
        e = {
            "type": entry_type,
            "uuid": self._mk_uuid(seq, index),
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
        """Project one native-log event into the 0+ Claude-JSONL entry dicts it
        maps to. Subclasses implement this; it must be tolerant of a malformed
        event (return [])."""
        raise NotImplementedError


def project_log(projector_cls, events, session_id, cwd=None, git_branch=None,
                version=None):
    """Batch convenience: project a whole native event log (an iterable of event
    dicts) into the list of Claude-JSONL entry dicts. Equivalent to feeding each
    event to a fresh `projector_cls` in order."""
    proj = projector_cls(session_id, cwd=cwd, git_branch=git_branch, version=version)
    out = []
    for ev in events:
        out.extend(proj.feed(ev))
    return out


def project_log_lines(projector_cls, events, session_id, **ctx):
    """As `project_log`, but serialized to newline-terminated JSONL strings ready
    to append to a transcript file (`ensure_ascii=False`, matching Claude Code)."""
    return [
        json.dumps(e, ensure_ascii=False) + "\n"
        for e in project_log(projector_cls, events, session_id, **ctx)
    ]
