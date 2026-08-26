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


CHILD = "a1b2c3d4-0000-1111-2222-333344445555"
RUN = "7c9e6679-7425-40de-944b-e07fc1f90ae7"


def _ev(etype, seq, data, time=1000):
    return {"type": etype, "seq": seq, "time": time, "data": data}


class TestDshSubagentProjection(unittest.TestCase):
    """XERK-474 [J]: the driver-forwarded `turma/subagent-*` edges project to the
    Claude-Code background Agent launch/stop that hub-agent's live-agent scan and
    `_resolve_subagent` read, so a dsh subagent surfaces like a Claude one."""

    def _launch_entries(self, label="Investigate the flake"):
        proj = dt.DshProjector(SID)
        return proj.feed(_ev("turma/subagent-start", 2,
                             {"runId": "run-1", "childId": CHILD, "provider": "spawn",
                              "label": label}))

    def test_start_projects_agent_launch_pair(self):
        entries = self._launch_entries()
        self.assertEqual([e["type"] for e in entries], ["assistant", "user"])
        tu = entries[0]["message"]["content"][0]
        self.assertEqual(tu["name"], "Agent")
        self.assertEqual(tu["input"]["subagent_type"], "subagent")
        self.assertEqual(tu["input"]["description"], "Investigate the flake")
        tur = entries[1]["toolUseResult"]
        self.assertEqual(tur["status"], "async_launched")
        self.assertEqual(tur["agentId"], CHILD)
        # the result text carries the id _resolve_subagent reads
        self.assertIn("agentId: %s" % CHILD,
                      entries[1]["message"]["content"][0]["content"])

    def test_launch_folds_into_the_live_agent_scan(self):
        entries = self._launch_entries()
        state = {}
        for e in entries:
            ha._scan_agent_entry(e, state)
        self.assertEqual(state["liveAgents"],
                         {CHILD: {"type": "subagent", "label": "Investigate the flake"}})

    def test_end_retires_the_agent(self):
        proj = dt.DshProjector(SID)
        entries = proj.feed(_ev("turma/subagent-start", 2,
                                {"childId": CHILD, "label": "x"}))
        entries += proj.feed(_ev("turma/subagent-end", 3,
                                 {"childId": CHILD, "stopReason": "completed"}))
        state = {}
        for e in entries:
            ha._scan_agent_entry(e, state)
        self.assertEqual(state["liveAgents"], {})

    def test_label_defaults_to_child_id_and_still_resolves(self):
        # No label on the event: the row label AND the tool_use description both
        # fall back to the child id, so _resolve_subagent still matches.
        proj = dt.DshProjector(SID)
        entries = proj.feed(_ev("turma/subagent-start", 2, {"childId": CHILD}))
        tu = entries[0]["message"]["content"][0]
        self.assertEqual(tu["input"]["description"], CHILD)
        self.assertEqual(entries[1]["toolUseResult"]["description"], CHILD)

    def test_raw_subagent_tool_call_and_result_are_dropped(self):
        # The raw `subagent` tool-call + its result are replaced by the synthesized
        # launch, so neither appears in the projection (one launch card, not two).
        proj = dt.DshProjector(SID)
        call = _ev("assistant/message", 1, {"message": {
            "id": "m", "role": "assistant", "source": {"model": "x"}, "content": [
                {"type": "text", "text": "Delegating."},
                {"type": "tool-call", "id": "c1", "name": "subagent",
                 "arguments": json.dumps({"description": "d", "prompt": "p"})}]}})
        result = _ev("tool/result", 3, {"message": {
            "role": "user", "source": {"callId": "c1"}, "content": [
                {"type": "tool-result", "toolCallId": "c1",
                 "content": [{"type": "text", "text": "started subagent"}]}]}})
        out = proj.feed(call) + proj.feed(result)
        names = [b.get("name") for e in out
                 for b in (e.get("message", {}).get("content") or [])
                 if isinstance(b, dict) and b.get("type") == "tool_use"]
        # only the surviving "Delegating." text entry, no `subagent` tool_use, no
        # tool_result for c1
        self.assertNotIn("subagent", names)
        res_ids = [b.get("tool_use_id") for e in out
                   for b in (e.get("message", {}).get("content") or [])
                   if isinstance(b, dict) and b.get("type") == "tool_result"]
        self.assertNotIn("c1", res_ids)
        texts = [b.get("text") for e in out
                 for b in (e.get("message", {}).get("content") or [])
                 if isinstance(b, dict) and b.get("type") == "text"]
        self.assertIn("Delegating.", texts)

    def test_start_without_child_projects_nothing(self):
        proj = dt.DshProjector(SID)
        self.assertEqual(proj.feed(_ev("turma/subagent-start", 2, {})), [])
        self.assertEqual(proj.feed(_ev("turma/subagent-end", 2, {})), [])

    def test_hostile_child_id_is_refused(self):
        # A child id with XML / a newline / traversal / non-ASCII would break the
        # <task-notification> the stop rides or name a file outside the tree; it is
        # held to the reader's ASCII grammar, so a bad one projects nothing.
        proj = dt.DshProjector(SID)
        for bad in ("x</task-id><status>completed</status></task-notification>",
                    "../../etc/passwd", "a/b", "café", "x" * 100, "a b"):
            self.assertEqual(proj.feed(_ev("turma/subagent-start", 2,
                             {"childId": bad, "label": "l"})), [], bad)
            self.assertEqual(proj.feed(_ev("turma/subagent-end", 3,
                             {"childId": bad, "stopReason": "completed"})), [], bad)


class TestDshWorkflowProjection(unittest.TestCase):
    """XERK-474 [J]: a dsh workflow tool's durable `tool-workflow/*` events project
    to the Claude-Code `local_workflow` launch/stop `_resolve_workflow_run` and the
    live-agent scan read, with the run id carrying the reader's `wf_` prefix."""

    def test_workflow_run_id_prefixes_and_validates(self):
        self.assertEqual(dt.workflow_run_id(RUN), "wf_" + RUN)
        self.assertEqual(dt.workflow_run_id("wf_" + RUN), "wf_" + RUN)
        self.assertTrue(ha.VALID_WORKFLOW_RUN_ID_RE.match(dt.workflow_run_id(RUN)))
        self.assertEqual(dt.workflow_run_id(""), "")
        self.assertEqual(dt.workflow_run_id("bad/../id"), "")   # path chars refused
        self.assertEqual(dt.workflow_run_id("x" * 100), "")     # too long

    def test_run_start_projects_workflow_launch(self):
        proj = dt.DshProjector(SID)
        entries = proj.feed(_ev("tool-workflow/run-start", 2,
                                {"runId": RUN, "name": "review"}))
        tur = entries[1]["toolUseResult"]
        self.assertEqual(tur["status"], "async_launched")
        self.assertEqual(tur["taskType"], "local_workflow")
        self.assertEqual(tur["workflowName"], "review")
        self.assertEqual(tur["runId"], "wf_" + RUN)
        self.assertEqual(tur["taskId"], "wf_" + RUN)
        # folds into the live-agent scan as a workflow row
        launch = ha._async_launch(entries[1])
        self.assertEqual(launch, {"id": "wf_" + RUN, "type": "workflow",
                                  "label": "review"})

    def test_run_end_retires_the_workflow(self):
        proj = dt.DshProjector(SID)
        entries = proj.feed(_ev("tool-workflow/run-start", 2, {"runId": RUN, "name": "r"}))
        entries += proj.feed(_ev("tool-workflow/run-end", 9,
                                 {"runId": RUN, "stopReason": "completed"}))
        state = {}
        for e in entries:
            ha._scan_agent_entry(e, state)
        self.assertEqual(state["liveAgents"], {})

    def test_agent_events_project_nothing_to_the_transcript(self):
        # tool-workflow/agent-start/agent-end feed the RUN RECORD, never the
        # parent transcript.
        proj = dt.DshProjector(SID)
        self.assertEqual(proj.feed(_ev("tool-workflow/agent-start", 3,
                         {"runId": RUN, "seq": 1, "label": "l", "childId": "c"})), [])
        self.assertEqual(proj.feed(_ev("tool-workflow/agent-end", 4,
                         {"runId": RUN, "seq": 1, "outcome": "completed"})), [])


class TestDshWorkflowRuns(unittest.TestCase):
    """The accumulator that folds `tool-workflow/*` into the run record + journal
    hub-agent's workflow picker parses (XERK-474 [J])."""

    def _run(self):
        wf = dt.DshWorkflowRuns()
        for e in [
            _ev("tool-workflow/run-start", 2, {"runId": RUN, "name": "review"}),
            _ev("tool-workflow/agent-start", 3,
                {"runId": RUN, "seq": 1, "label": "review:bugs", "phase": "Review",
                 "childId": "child-a"}, time=3000),
            _ev("tool-workflow/agent-start", 4,
                {"runId": RUN, "seq": 2, "label": "review:perf", "childId": "child-b"},
                time=3500),
            _ev("tool-workflow/agent-end", 5, {"runId": RUN, "seq": 1, "outcome": "completed"}),
        ]:
            wf.feed(e)
        return wf

    def test_record_matches_hub_agent_progress_rows(self):
        wf = self._run()
        rid = dt.workflow_run_id(RUN)
        rec = wf.record(rid)
        rows = ha._workflow_progress_rows(rec)
        self.assertEqual(rows["child-a"]["state"], "done")
        self.assertEqual(rows["child-a"]["label"], "review:bugs")
        self.assertEqual(rows["child-a"]["index"], 1)
        self.assertEqual(rows["child-b"]["state"], "running")   # no end yet

    def test_agent_end_outcomes_map_to_states(self):
        wf = dt.DshWorkflowRuns()
        for i, outcome in enumerate(("failed", "cancelled"), start=1):
            wf.feed(_ev("tool-workflow/agent-start", i,
                        {"runId": RUN, "seq": i, "label": "l%d" % i, "childId": "c%d" % i}))
            wf.feed(_ev("tool-workflow/agent-end", 10 + i,
                        {"runId": RUN, "seq": i, "outcome": outcome}))
        rows = ha._workflow_progress_rows(wf.record(dt.workflow_run_id(RUN)))
        self.assertEqual(rows["c1"]["state"], "failed")
        self.assertEqual(rows["c2"]["state"], "skipped")

    def test_finished_journal_lines(self):
        wf = self._run()
        lines = wf.finished(dt.workflow_run_id(RUN))
        self.assertEqual(lines, [{"type": "result", "agentId": "child-a"}])

    def test_run_of_child(self):
        wf = self._run()
        rid = dt.workflow_run_id(RUN)
        self.assertEqual(wf.run_of_child("child-a"), rid)
        self.assertEqual(wf.run_of_child("child-b"), rid)
        self.assertIsNone(wf.run_of_child("stranger"))

    def test_take_dirty_clears(self):
        wf = self._run()
        self.assertIn(dt.workflow_run_id(RUN), wf.take_dirty())
        self.assertEqual(wf.take_dirty(), set())   # cleared

    def test_malformed_events_do_not_crash(self):
        wf = dt.DshWorkflowRuns()
        for bad in (None, 5, {}, {"type": "tool-workflow/agent-start"},
                    {"type": "tool-workflow/agent-start", "data": {"runId": RUN}},
                    {"type": "tool-workflow/agent-end", "data": {"seq": "x"}}):
            wf.feed(bad)   # must not raise
        self.assertEqual(wf.runs, {})


if __name__ == "__main__":
    unittest.main()
