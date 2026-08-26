#!/usr/bin/env python3
"""Unit tests for agent/dsh_transcript.py — the dsh event log -> Claude-Code
JSONL projection (XERK-464, [dsh][S1]).

The corpus (`dsh_corpus.json`) is built from dsh's OWN message constructors
(@deepseek-ai/dsh-llm 0.1.1-rc.2) by `dsh_corpus_gen.mjs`, so these assertions
run against real dsh shapes, not this repo's guess — the G1 lesson that a mock
hid a wrong API. The projected fixture (`dsh_projected.jsonl`) and the rendered
blocks (`dsh_expected_blocks.json`) are the SAME artifacts the JS parity test in
`tunnel-agent.test.js` asserts against, so both readers are pinned to one
expected result: that is the py/js parity proof this ticket requires.

stdlib unittest only — mirrors the image's no-pip runtime, like test_hub_agent.py.
"""

import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_DIR = os.path.dirname(HERE)


def _load(name, filename):
    path = os.path.join(AGENT_DIR, filename)
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


dt = _load("dsh_transcript", "dsh_transcript.py")
ha = _load("hub_agent", "hub-agent.py")

SID = "11111111-2222-3333-4444-555555555555"
PROJECT_KW = dict(cwd="/repos/x", git_branch="XERK-464", version="dsh-0.1.1-rc.2")


def _corpus():
    with open(os.path.join(HERE, "dsh_corpus.json")) as f:
        return json.load(f)


def _project():
    return dt.project_log(_corpus(), session_id=SID, **PROJECT_KW)


class TestDshProjectionShape(unittest.TestCase):
    def test_only_surface_events_project(self):
        """The 3 dsh SURFACE event types plus a user-cancelled turn/end produce
        entries; every log-only event (turn/step boundaries, request/header,
        assistant/chunk, tool/call) projects to nothing."""
        entries = _project()
        # user, assistant(pr), tool_result(pr), assistant(text), user(prompt2),
        # interrupt, tool_result(error) = 7
        self.assertEqual(len(entries), 7)
        self.assertEqual([e["type"] for e in entries],
                         ["user", "assistant", "user", "assistant", "user", "user", "user"])

    def test_log_only_events_alone_project_nothing(self):
        for etype, data in (
            ("turn/start", {"turn": 1}),
            ("step/start", {"turn": 1, "step": 1}),
            ("step/end", {"turn": 1, "step": 1}),
            ("assistant/chunk", {"turn": 1, "step": 1, "chunk": {}}),
            ("request/header", {"header": {}, "reason": "initial"}),
            ("request/context", {"provider": "p", "model": "m"}),
            ("todo/write", {"todos": []}),
            ("session/title", {"title": "x"}),
            ("tool/call", {"turn": 1, "step": 1, "callId": "c", "name": "Bash",
                           "arguments": "{}"}),
        ):
            proj = dt.DshProjector(SID)
            self.assertEqual(proj.feed({"type": etype, "seq": 1, "time": 0, "data": data}), [],
                             f"{etype} should project to nothing")

    def test_tool_call_event_does_not_duplicate_tool_use(self):
        """The corpus emits BOTH an assistant/message carrying a tool-call block
        AND a redundant standalone tool/call event for the same callId. Exactly
        ONE tool_use must appear across the whole projection."""
        entries = _project()
        tool_uses = [
            b for e in entries
            for b in (e.get("message", {}).get("content") or [])
            if isinstance(b, dict) and b.get("type") == "tool_use"
        ]
        self.assertEqual(len(tool_uses), 1)
        self.assertEqual(tool_uses[0]["name"], "Bash")
        self.assertEqual(tool_uses[0]["id"], "call_abc123")

    def test_deterministic_reprojection(self):
        """A re-projection is byte-identical (stable uuids), so the launcher can
        replay the retained native log without forking the transcript file."""
        self.assertEqual(_project(), _project())

    def test_parent_uuid_chain(self):
        entries = _project()
        self.assertIsNone(entries[0]["parentUuid"])
        for i in range(1, len(entries)):
            self.assertEqual(entries[i]["parentUuid"], entries[i - 1]["uuid"])

    def test_timestamps_are_claude_iso(self):
        for e in _project():
            ts = e["timestamp"]
            self.assertRegex(ts, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


class TestDshProjectionBlocks(unittest.TestCase):
    """The projection renders through the REAL _entry_blocks — the same reader a
    Claude transcript uses — into the expected block shapes."""

    def _blocks(self):
        return [ha._entry_blocks(e, ha.BLOCK_CAPS) for e in _project()]

    def test_matches_committed_expected_blocks(self):
        with open(os.path.join(HERE, "dsh_expected_blocks.json")) as f:
            expected = json.load(f)
        self.assertEqual(self._blocks(), expected)

    def test_user_prompt_and_assistant_shapes(self):
        b = self._blocks()
        self.assertEqual(b[0], [{"t": "text", "text": "Open a PR for the fix, then summarize."}])
        # assistant: reasoning->thinking, text, tool-call->tool_use (+ desc from
        # _tool_use_detail proving the input is a real dict, not opaque text).
        asst = b[1]
        self.assertEqual([x["t"] for x in asst], ["thinking", "text", "tool_use"])
        self.assertEqual(asst[2]["name"], "Bash")
        self.assertEqual(asst[2]["desc"], "Open the PR")

    def test_tool_result_and_interrupt_and_error(self):
        b = self._blocks()
        self.assertEqual(b[2], [{"t": "tool_result",
                                 "text": "https://github.com/xerktech/Turma/pull/999",
                                 "forId": "call_abc123"}])
        self.assertEqual(b[5], [{"t": "interrupt", "text": "[Request interrupted by user]"}])
        self.assertTrue(b[6][0].get("isError"))


class TestDshProjectionAccounting(unittest.TestCase):
    """D4: usage + model + PR attribution ride the projection with no schema
    change, so a dsh session's spend and PRs surface like a Claude session's."""

    def _lines(self):
        return [json.dumps(e) for e in _project()]

    def test_usage_totals_and_model_breakdown(self):
        acc = ha._UsageAcc()
        ha._accumulate_usage(self._lines(), acc)
        self.assertEqual(acc.totals["input"], 1260)   # 1200 + 60
        self.assertEqual(acc.totals["output"], 352)   # 340 + 12
        self.assertEqual(acc.totals["cacheRead"], 5000)
        self.assertEqual(acc.totals["cacheWrite"], 800)
        self.assertIn("bedrock/claude-haiku", acc.models)

    def test_model_actual(self):
        rep = {"modelActual": None}
        for ln in self._lines():
            ha._scan_model_entry(json.loads(ln), rep)
        self.assertEqual(rep["modelActual"], "bedrock/claude-haiku")

    def test_pr_attribution(self):
        """The gh-pr-create tool_use + its tool_result URL is attributed as the
        session's PR — the reason tool calls must project as tool events (D4)."""
        state, report = {}, {"prUrls": []}
        for ln in self._lines():
            ha._scan_pr_line(ln, state, report)
        self.assertEqual(report["prUrls"],
                         ["https://github.com/xerktech/Turma/pull/999"])


class TestDshProjectionEdgeCases(unittest.TestCase):
    def test_malformed_event_projects_nothing(self):
        proj = dt.DshProjector(SID)
        for bad in (None, {}, {"type": "user/message"}, {"type": "user/message", "data": 5},
                    {"type": "assistant/message", "data": {"message": None}}):
            self.assertEqual(proj.feed(bad), [])

    def test_unparseable_tool_arguments_keep_a_dict(self):
        proj = dt.DshProjector(SID)
        ev = {"type": "assistant/message", "seq": 1, "time": 0, "data": {
            "turn": 1, "step": 1, "message": {
                "id": "m", "role": "assistant", "source": {"kind": "model", "model": "x"},
                "content": [{"type": "tool-call", "id": "c", "name": "Bash",
                             "arguments": "not json {{"}]}}}
        entry = proj.feed(ev)[0]
        tu = entry["message"]["content"][0]
        self.assertEqual(tu["type"], "tool_use")
        self.assertIsInstance(tu["input"], dict)

    def test_usage_absent_projects_no_usage_key(self):
        """A step with no usage must project no `usage` — a fabricated zero would
        land a phantom in the per-model denominator."""
        proj = dt.DshProjector(SID)
        ev = {"type": "assistant/message", "seq": 1, "time": 0, "data": {
            "turn": 1, "step": 1, "message": {
                "id": "m", "role": "assistant", "source": {"kind": "model", "model": "x"},
                "content": [{"type": "text", "text": "hi"}]}}}
        entry = proj.feed(ev)[0]
        self.assertNotIn("usage", entry["message"])

    def test_empty_content_projects_nothing(self):
        proj = dt.DshProjector(SID)
        ev = {"type": "user/message", "seq": 1, "time": 0,
              "data": {"role": "user", "source": {"kind": "user"}, "content": []}}
        self.assertEqual(proj.feed(ev), [])

    def test_all_zero_usage_projects_no_usage_key(self):
        """A usage block that is PRESENT but all-zero (a local endpoint that
        reports no counts) must project no `usage` key — else it plants a
        phantom zero-token model in the usage page's per-model table, the defect
        the `<synthetic>` guard removes for Claude ([G0]/XERK-471)."""
        proj = dt.DshProjector(SID)
        ev = {"type": "assistant/message", "seq": 1, "time": 0, "data": {
            "turn": 1, "step": 1,
            "usage": {"inputTokens": 0, "outputTokens": 0,
                      "cacheReadTokens": 0, "cacheWriteTokens": 0},
            "message": {
                "id": "m", "role": "assistant",
                "source": {"kind": "model", "model": "qwen2.5-coder"},
                "content": [{"type": "text", "text": "hi"}]}}}
        entry = proj.feed(ev)[0]
        self.assertNotIn("usage", entry["message"])


class TestDshUsageReportEndToEnd(unittest.TestCase):
    """[G] (XERK-471): a dsh session's spend charts on the Usage page IDENTICALLY
    to a Claude session, because the projection writes the same `message.usage` /
    `message.model` shape the aggregation reads — no schema change (D4). This
    proves the whole chain one layer above _accumulate_usage: a projected dsh
    transcript on disk, named by the pinned session id like any conversation,
    folds through repo_usage_report into the host + per-repo totals AND the
    per-model breakdown, with LOCAL/DeepSeek model ids appearing beside Claude's
    rather than being filtered as synthetic (they may dominate — [G0] D5)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dsh-usage-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        p = mock.patch.object(ha, "PROJECTS_ROOT", self.tmp)
        p.start()
        self.addCleanup(p.stop)

    def _assistant(self, seq, model, inp, out, cw=0, cr=0):
        return {"type": "assistant/message", "seq": seq, "time": 1_750_000_000_000, "data": {
            "turn": 1, "step": seq,
            "usage": {"inputTokens": inp, "outputTokens": out,
                      "cacheReadTokens": cr, "cacheWriteTokens": cw},
            "message": {"id": f"m{seq}", "role": "assistant",
                        "source": {"kind": "model", "model": model},
                        "content": [{"type": "text", "text": "ok"}]}}}

    def _write_projection(self, worktree, events):
        slug = ha._project_slug(worktree)
        d = os.path.join(self.tmp, slug)
        os.makedirs(d, exist_ok=True)
        # Named by the pinned conversation id, exactly as _launch_dsh writes it.
        lines = dt.project_log_lines(events, session_id=SID, cwd=worktree)
        with open(os.path.join(d, f"{SID}.jsonl"), "w") as f:
            f.writelines(lines)
        return slug

    def _fold_full(self, slug):
        acc = ha._UsageAcc()
        ha._aggregate_project(os.path.join(self.tmp, slug), acc)
        return acc

    def test_dsh_spend_and_local_models_flow_into_the_report(self):
        worktree = "/repos/.turma/worktrees/Turma/dsh01"
        # Two turns on a local model, one on the DeepSeek API — both non-Claude.
        slug = self._write_projection(worktree, [
            self._assistant(1, "qwen2.5-coder-32b", 1000, 200, cw=50, cr=4000),
            self._assistant(2, "qwen2.5-coder-32b", 300, 40),
            self._assistant(3, "deepseek-chat", 500, 90),
        ])
        ledger = {worktree: {"repo": "Turma",
                             "remote": "git@github.com:xerktech/Turma.git",
                             "slug": slug}}
        repo_usage, host = ha.repo_usage_report(ledger, self._fold_full)

        # The dsh session's spend is a real host block — "charts identically".
        self.assertIsNotNone(host)
        self.assertEqual(host["totals"]["input"], 1800)
        self.assertEqual(host["totals"]["output"], 330)
        self.assertEqual(host["totals"]["cacheRead"], 4000)
        self.assertEqual(host["totals"]["cacheWrite"], 50)

        turma = next(r for r in repo_usage if r["repo"] == "Turma")
        self.assertEqual(turma["usage"]["totals"]["input"], 1800)

        # Local + DeepSeek ids appear in the per-model breakdown, NOT filtered.
        models = {m["model"]: m for m in host["models"]}
        self.assertEqual(models["qwen2.5-coder-32b"]["totals"]["input"], 1300)
        self.assertEqual(models["deepseek-chat"]["totals"]["input"], 500)
        self.assertNotIn("<synthetic>", models)


class TestDshToolNameMapping(unittest.TestCase):
    """dsh's shell tool is `name:"bash"` (lowercase); the read side keys PR
    attribution and the Bash card on `"Bash"`. The projector must map it in the
    seam — teaching the readers about dsh names is the mirror multiplication this
    exists to avoid. (Real-dsh regression: the corpus must use the real name.)"""

    def test_corpus_uses_the_real_lowercase_tool_name(self):
        # Guards against a fixture regressing to a faked `Bash` — which is what
        # made the first QA pass fail: the test was green against a shape real dsh
        # never emits.
        corpus = _corpus()
        tool_calls = [
            b for e in corpus if e.get("type") == "assistant/message"
            for b in (e["data"].get("message", {}).get("content") or [])
            if isinstance(b, dict) and b.get("type") == "tool-call"
        ]
        self.assertTrue(tool_calls)
        self.assertTrue(all(b["name"] == "bash" for b in tool_calls),
                        "corpus must carry dsh's real lowercase `bash`")

    def test_bash_is_mapped_to_Bash(self):
        proj = dt.DshProjector(SID)
        ev = {"type": "assistant/message", "seq": 1, "time": 0, "data": {
            "turn": 1, "step": 1, "message": {
                "id": "m", "role": "assistant", "source": {"kind": "model", "model": "x"},
                "content": [{"type": "tool-call", "id": "c", "name": "bash",
                             "arguments": '{"command": "ls"}'}]}}}
        tu = proj.feed(ev)[0]["message"]["content"][0]
        self.assertEqual(tu["name"], "Bash")

    def test_unknown_tool_name_passes_through(self):
        proj = dt.DshProjector(SID)
        ev = {"type": "assistant/message", "seq": 1, "time": 0, "data": {
            "turn": 1, "step": 1, "message": {
                "id": "m", "role": "assistant", "source": {"kind": "model", "model": "x"},
                "content": [{"type": "tool-call", "id": "c", "name": "str_replace_editor",
                             "arguments": "{}"}]}}}
        tu = proj.feed(ev)[0]["message"]["content"][0]
        self.assertEqual(tu["name"], "str_replace_editor")


class TestDshFeedNeverCrashes(unittest.TestCase):
    """feed() runs per streamed event in the launcher, so no plausible/hostile
    event may abort the projection. These are the escapes the first QA pass found."""

    def test_out_of_range_and_infinite_time(self):
        proj = dt.DshProjector(SID)
        for bad_time in (float("inf"), float("nan"), 1e999 if False else 10 ** 30,
                         -(10 ** 30), "1e999"):
            ev = {"type": "user/message", "seq": 1, "time": bad_time,
                  "data": {"role": "user", "source": {"kind": "user"},
                           "content": [{"type": "text", "text": "hi"}]}}
            out = proj.feed(ev)  # must not raise
            self.assertEqual(out[0]["timestamp"], "")

    def test_json_infinity_literal_time(self):
        # `1e999` is legal JSON and decodes to inf; int(inf) raises OverflowError.
        proj = dt.DshProjector(SID)
        ev = json.loads('{"type":"user/message","seq":1,"time":1e999,'
                        '"data":{"role":"user","content":[{"type":"text","text":"x"}]}}')
        self.assertEqual(proj.feed(ev)[0]["timestamp"], "")

    def test_tool_result_non_dict_source(self):
        proj = dt.DshProjector(SID)
        for src in ("tool", 1, ["x"], True):
            ev = {"type": "tool/result", "seq": 1, "time": 0, "data": {"message": {
                "role": "user", "source": src,
                "content": [{"type": "tool-result", "content": [
                    {"type": "text", "text": "ok"}]}]}}}
            out = proj.feed(ev)  # must not raise
            self.assertEqual(out[0]["message"]["content"][0]["type"], "tool_result")


if __name__ == "__main__":
    unittest.main()
