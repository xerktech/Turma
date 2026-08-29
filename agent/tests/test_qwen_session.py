#!/usr/bin/env python3
"""Tests for agent/qwen_session.py — the qwen projection tail (XERK-509 [Qwen C]).

Drives the REAL QwenProjector over real Qwen native-log event shapes (the G0
corpus shapes), the no-mock discipline the runtime children ship under, and
pins the tail's own behaviour: incremental projection, resume-at-EOF, native-log
discovery by glob, and best-effort title capture.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import qwen_session as qs  # noqa: E402


class QwenProjectionTailTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="qwen-tail-")
        self.addCleanup(self._rmtree)
        self.sid = "757253de-b908-4212-9ff7-dfc1f84c5b50"
        # The qwen native log lives at <projects_root>/<slug>/chats/<sid>.jsonl.
        self.projects_root = os.path.join(self.tmp, "qwen-projects")
        self.chats_dir = os.path.join(self.projects_root, "some-slug", "chats")
        os.makedirs(self.chats_dir, exist_ok=True)
        self.native_log = os.path.join(self.chats_dir, f"{self.sid}.jsonl")
        # The projected (Claude-JSONL) transcript the tail appends to. Its dir is
        # created by the tail's _run() thread; these tests drive _pump() directly,
        # so create it here (matching what a launched tail would have).
        self.transcript = os.path.join(self.tmp, "projects", "slug",
                                       f"{self.sid}.jsonl")
        os.makedirs(os.path.dirname(self.transcript), exist_ok=True)
        # The raw-archive store for qwen's native log (XERK-512): a sibling of
        # the transcript under `<slug>/<sid>/qwen/`, walked by _session_files.
        self.store_dir = os.path.join(self.tmp, "projects", "slug",
                                      self.sid, "qwen")
        self.mirror_path = os.path.join(self.store_dir, "chat.jsonl")

    def _rmtree(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _append_native(self, event):
        with open(self.native_log, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(event) + "\n")

    def _read_transcript(self):
        if not os.path.exists(self.transcript):
            return []
        with open(self.transcript, encoding="utf-8") as fh:
            return [json.loads(l) for l in fh if l.strip()]

    def _tail(self, resume=False, use_glob=True, store=False):
        return qs.QwenProjectionTail(
            self.projects_root, self.transcript, self.sid,
            cwd="/work", log=lambda m: None, resume=resume,
            events_path=None if use_glob else self.native_log,
            store_dir=self.store_dir if store else None)

    def _read_mirror(self):
        if not os.path.exists(self.mirror_path):
            return b""
        with open(self.mirror_path, "rb") as fh:
            return fh.read()

    def _native_bytes(self):
        with open(self.native_log, "rb") as fh:
            return fh.read()

    def _user(self, text, uuid="u1"):
        return {"type": "user", "uuid": uuid, "timestamp": "2026-08-28T18:08:40.134Z",
                "message": {"role": "user", "parts": [{"text": text}]}}

    def _assistant(self, text, uuid="a1"):
        return {"type": "assistant", "uuid": uuid,
                "timestamp": "2026-08-28T18:08:41.000Z",
                "model": "qwen3-coder",
                "usageMetadata": {"promptTokenCount": 100,
                                  "cachedContentTokenCount": 40,
                                  "candidatesTokenCount": 20,
                                  "totalTokenCount": 120},
                "message": {"role": "assistant", "parts": [{"text": text}]}}

    # --- discovery + fresh projection ---------------------------------------

    def test_native_log_discovered_by_glob_and_projected_incrementally(self):
        # The tail locates the native log by GLOB (not a computed slug), so it
        # works regardless of the cwd->slug rule (see the module docstring).
        self._append_native(self._user("hello qwen"))
        tail = self._tail(use_glob=True)
        self.addCleanup(tail.stop)
        tail._pump()
        entries = self._read_transcript()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["type"], "user")
        self.assertEqual(entries[0]["message"]["content"][0]["text"], "hello qwen")
        # A second event appended is projected on the next pump, not re-projected.
        self._append_native(self._assistant("hi there"))
        tail._pump()
        entries = self._read_transcript()
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[1]["type"], "assistant")
        # usage is carried (disjoint counts): input = 100-40, cache_read = 40.
        usage = entries[1]["message"]["usage"]
        self.assertEqual(usage["input_tokens"], 60)
        self.assertEqual(usage["cache_read_input_tokens"], 40)
        self.assertEqual(usage["output_tokens"], 20)

    def test_missing_native_log_projects_nothing_and_never_raises(self):
        # No native log on disk yet (an empty conversation writes none until the
        # first turn): the tail creates the (empty) transcript and pumps to a
        # no-op, exactly like a Claude session before its first byte.
        tail = self._tail(use_glob=True)
        self.addCleanup(tail.stop)
        # _run creates the transcript file; _pump alone just no-ops here.
        tail._pump()
        self.assertEqual(self._read_transcript(), [])

    def test_resume_starts_past_already_projected_history(self):
        # On resume the kept native log's history is already in the transcript;
        # qwen --resume appends in place, so the tail must start at EOF and
        # project only NEW events, never re-project the history.
        self._append_native(self._user("old turn"))
        self._append_native(self._assistant("old reply"))
        resumed = self._tail(resume=True, use_glob=False)
        self.addCleanup(resumed.stop)
        resumed._pump()   # primes offset to EOF; projects nothing
        self.assertEqual(self._read_transcript(), [])
        # A NEW event after resume IS projected.
        self._append_native(self._user("new turn"))
        resumed._pump()
        entries = self._read_transcript()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["message"]["content"][0]["text"], "new turn")

    def test_fresh_tail_projects_existing_events_from_zero(self):
        # The contrast to resume: a non-resume tail starts at 0 and projects the
        # existing events (a fresh launch writes a new log, so this never doubles).
        self._append_native(self._user("from zero"))
        fresh = self._tail(resume=False, use_glob=False)
        self.addCleanup(fresh.stop)
        fresh._pump()
        self.assertEqual(len(self._read_transcript()), 1)

    def test_system_events_project_nothing(self):
        # Only user/assistant/tool_result project; a system event is log-only.
        self._append_native({"type": "system", "subtype": "ui_telemetry",
                             "uuid": "s1", "systemPayload": {}})
        tail = self._tail(use_glob=False)
        self.addCleanup(tail.stop)
        tail._pump()
        self.assertEqual(self._read_transcript(), [])

    def test_malformed_line_is_skipped_not_fatal(self):
        with open(self.native_log, "a", encoding="utf-8") as fh:
            fh.write("{not json\n")
        self._append_native(self._user("after junk"))
        tail = self._tail(use_glob=False)
        self.addCleanup(tail.stop)
        tail._pump()
        entries = self._read_transcript()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["message"]["content"][0]["text"], "after junk")

    # --- title capture (tier 1; dormant per G0) -----------------------------

    def test_title_is_none_without_a_title_event(self):
        # The G0 corpus emits no title event, so title() stays None and naming
        # falls to the qwen -p one-shot (tier 2).
        self._append_native(self._user("no title here"))
        tail = self._tail(use_glob=False)
        self.addCleanup(tail.stop)
        tail._pump()
        self.assertIsNone(tail.title())
        self.assertFalse(tail.title_final())

    def test_title_captured_best_effort_if_qwen_ever_writes_one(self):
        # A future qwen that writes a title event is honoured (final), without a
        # code change — read on the beat by _seed_qwen_summary's tier 1.
        self._append_native({"type": "session_title", "uuid": "t1",
                             "data": {"title": "  Refactor The Widget  "}})
        tail = self._tail(use_glob=False)
        self.addCleanup(tail.stop)
        tail._pump()
        self.assertEqual(tail.title(), "Refactor The Widget")
        self.assertTrue(tail.title_final())


    # --- native-log mirror into the raw-archive store (XERK-512 [Qwen E]) ----

    def test_mirror_copies_the_native_log_byte_for_byte(self):
        # The tail mirrors qwen's native event log into <slug>/<sid>/qwen/ so it
        # rides the raw archive layer — kept in FULL, not a rendering of it.
        self._append_native(self._user("hello"))
        self._append_native(self._assistant("hi there"))
        tail = self._tail(use_glob=False, store=True)
        self.addCleanup(tail.stop)
        tail._pump()
        self.assertEqual(self._read_mirror(), self._native_bytes())

    def test_mirror_is_incremental_and_append_only(self):
        # Only the bytes appended since the last pump are copied — the raw layer
        # ships append-only deltas, so the mirror must grow that way too.
        self._append_native(self._user("one"))
        tail = self._tail(use_glob=False, store=True)
        self.addCleanup(tail.stop)
        tail._pump()
        after_first = self._read_mirror()
        self.assertEqual(after_first, self._native_bytes())
        self._append_native(self._assistant("two"))
        tail._pump()
        full = self._read_mirror()
        self.assertEqual(full, self._native_bytes())
        # The second pump appended; it did not rewrite the prefix.
        self.assertTrue(full.startswith(after_first))

    def test_mirror_is_complete_even_when_the_projection_resumes_at_eof(self):
        # The mirror is INDEPENDENT of the projection cursor: on resume the
        # projection starts at EOF (to avoid doubling the transcript), but the
        # mirror does not yet exist, so it must still copy the WHOLE native log —
        # the canonical record for metrics must be complete regardless.
        self._append_native(self._user("old turn"))
        self._append_native(self._assistant("old reply"))
        resumed = self._tail(resume=True, use_glob=False, store=True)
        self.addCleanup(resumed.stop)
        resumed._pump()
        # Projection skipped the history (resume-at-EOF)...
        self.assertEqual(self._read_transcript(), [])
        # ...but the raw mirror carries it in full.
        self.assertEqual(self._read_mirror(), self._native_bytes())

    def test_mirror_resumes_from_its_own_size_across_a_restart(self):
        # A manager restart (adopt) makes a NEW tail over the SAME native log
        # while a partial mirror already exists on disk. The new tail must resume
        # the copy from the mirror's current size — catching up bytes qwen wrote
        # while the tail was dead, and never re-copying from zero (which would
        # double the mirror).
        self._append_native(self._user("before restart"))
        first = self._tail(use_glob=False, store=True)
        first._pump()
        first.stop()
        mirrored = self._read_mirror()
        self.assertEqual(mirrored, self._native_bytes())
        # qwen keeps appending while the tail is dead, then a fresh tail adopts.
        self._append_native(self._assistant("during the gap"))
        self._append_native(self._user("after restart"))
        adopted = self._tail(resume=True, use_glob=False, store=True)
        self.addCleanup(adopted.stop)
        adopted._pump()
        full = self._read_mirror()
        self.assertEqual(full, self._native_bytes())
        self.assertTrue(full.startswith(mirrored))          # no re-copy from zero
        self.assertEqual(full.count(b"before restart"), 1)  # prefix not doubled

    def test_mirror_freezes_intact_when_the_native_log_is_rewritten(self):
        # If the native log is rewritten shorter than the mirror, the mirror
        # holds the longer history — never truncate the archived copy to match
        # (the same rule the raw archive draws for a shrunk source). And once a
        # rewrite is seen the mirror FREEZES: a subsequent regrow within the same
        # tail must NOT splice a diverged prefix onto the archived copy (removing
        # the freeze would corrupt it here — this pins the guard as load-bearing).
        self._append_native(self._user("kept history"))
        self._append_native(self._assistant("more history"))
        tail = self._tail(use_glob=False, store=True)
        self.addCleanup(tail.stop)
        tail._pump()
        kept = self._read_mirror()
        self.assertEqual(kept, self._native_bytes())
        # Rewrite the native log to something shorter, then let it regrow LARGER
        # than the original — the pathological rewrite case.
        with open(self.native_log, "wb") as fh:
            fh.write(b"{}\n")
        tail._pump()
        self.assertEqual(self._read_mirror(), kept)  # unchanged, longer copy wins
        self._append_native(self._user("this is a much longer replacement turn"))
        self._append_native(self._assistant("and another one to grow well past"))
        tail._pump()
        # Still exactly the pre-rewrite bytes: frozen, not appended-onto.
        self.assertEqual(self._read_mirror(), kept)

    def test_no_store_dir_disables_the_mirror(self):
        # store_dir=None (older callers / a non-archiving context) is a clean
        # no-op: the projection still runs, nothing is written to a store.
        self._append_native(self._user("no store"))
        tail = self._tail(use_glob=False, store=False)
        self.addCleanup(tail.stop)
        tail._pump()
        self.assertEqual(len(self._read_transcript()), 1)
        self.assertFalse(os.path.exists(self.mirror_path))


class QwenDelegationTailTest(unittest.TestCase):
    """[Qwen J] (XERK-517): the tail projects each subagent's native log
    (`<slug>/subagents/<parent>/agent-<id>.jsonl`) into the Claude `subagents/`
    layout hub-agent's pickers resolve, so a Qwen delegation's drill-in
    transcript populates and its tokens are counted/migrated unchanged. Driven
    over a corpus CAPTURED from a real Qwen 0.22.x delegation on disk."""

    AID = "Explore-call_b01c582ff5fb496987c52ded"
    FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)))

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="qwen-deleg-tail-")
        self.addCleanup(self._rmtree)
        self.sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        self.projects_root = os.path.join(self.tmp, "qwen-projects")
        slug = os.path.join(self.projects_root, "some-slug")
        self.chats_dir = os.path.join(slug, "chats")
        os.makedirs(self.chats_dir, exist_ok=True)
        self.native_log = os.path.join(self.chats_dir, f"{self.sid}.jsonl")
        # The Qwen subagent native log lives at <slug>/subagents/<parent>/, a
        # SIBLING of chats/ — exactly where the tail resolves it off events_path.
        self.child_dir = os.path.join(slug, "subagents", self.sid)
        os.makedirs(self.child_dir, exist_ok=True)
        self.child_native = os.path.join(self.child_dir, f"agent-{self.AID}.jsonl")
        self.transcript = os.path.join(self.tmp, "projects", "slug",
                                       f"{self.sid}.jsonl")
        os.makedirs(os.path.dirname(self.transcript), exist_ok=True)
        # Where the projected child must land (the Claude layout _resolve_subagent
        # derives from the main transcript).
        self.projected_child = os.path.join(
            self.tmp, "projects", "slug", self.sid, "subagents",
            f"agent-{self.AID}.jsonl")

    def _rmtree(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, path, events):
        with open(path, "a", encoding="utf-8") as fh:
            for e in events:
                fh.write(json.dumps(e) + "\n")

    def _fixture(self, name):
        with open(os.path.join(self.FIXTURES, name)) as f:
            return json.load(f)

    def _tail(self):
        return qs.QwenProjectionTail(
            self.projects_root, self.transcript, self.sid,
            cwd="/repos/wt", log=lambda m: None, events_path=None)

    def test_child_log_is_projected_into_the_claude_layout_and_resolves(self):
        # Parent delegation native log + the child's OWN native log on disk.
        self._write(self.native_log, self._fixture("qwen_delegation_corpus.json"))
        self._write(self.child_native, self._fixture("qwen_delegation_child.json"))
        tail = self._tail()
        self.addCleanup(tail.stop)
        tail._pump()
        # The projected child landed in the Claude subagents/ layout, non-empty.
        self.assertTrue(os.path.isfile(self.projected_child))
        self.assertGreater(os.path.getsize(self.projected_child), 0)
        # And hub-agent's REAL reader resolves the launch row to exactly it.
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "hub_agent", os.path.join(os.path.dirname(self.FIXTURES), "hub-agent.py"))
        ha = importlib.util.module_from_spec(spec)
        sys.modules["hub_agent"] = ha
        spec.loader.exec_module(ha)
        resolved = ha._resolve_subagent(
            self.transcript, "Explore", "Find org selector dropdown")
        self.assertEqual(resolved, self.projected_child)

    def test_child_projection_is_incremental(self):
        self._write(self.native_log, self._fixture("qwen_delegation_corpus.json"))
        child = self._fixture("qwen_delegation_child.json")
        self._write(self.child_native, child[:1])
        tail = self._tail()
        self.addCleanup(tail.stop)
        tail._pump()
        with open(self.projected_child, encoding="utf-8") as f:
            first = [json.loads(l) for l in f if l.strip()]
        self.assertEqual(len(first), 1)
        # Appending more child events projects only the new ones on the next pump.
        self._write(self.child_native, child[1:])
        tail._pump()
        with open(self.projected_child, encoding="utf-8") as f:
            full = [json.loads(l) for l in f if l.strip()]
        self.assertGreater(len(full), len(first))
        self.assertEqual(full[0], first[0])   # prefix not re-projected

    def test_no_subagents_dir_is_a_clean_no_op(self):
        # A session that never delegates has no subagents dir — the tail projects
        # the parent and touches no child layout.
        import shutil
        shutil.rmtree(self.child_dir)
        self._write(self.native_log, self._fixture("qwen_delegation_corpus.json"))
        tail = self._tail()
        self.addCleanup(tail.stop)
        tail._pump()   # must not raise
        self.assertFalse(os.path.exists(os.path.dirname(self.projected_child)))

    def test_a_symlinked_child_log_is_refused(self):
        # isfile() follows a symlink, so a planted link would be a phantom child
        # whose "transcript" is whatever it points at — refused (islink beside
        # isfile), the file half of os.walk's dir-symlink rule.
        self._write(self.native_log, self._fixture("qwen_delegation_corpus.json"))
        target = os.path.join(self.tmp, "elsewhere.jsonl")
        self._write(target, self._fixture("qwen_delegation_child.json"))
        os.symlink(target, self.child_native)
        tail = self._tail()
        self.addCleanup(tail.stop)
        tail._pump()
        self.assertFalse(os.path.exists(self.projected_child))


if __name__ == "__main__":
    unittest.main()
