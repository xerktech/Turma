#!/usr/bin/env python3
"""Unit tests for agent/qwen_transcript.py — the Qwen Code native session log ->
Claude-Code JSONL projection (XERK-508, [Qwen][S1]).

The corpus (`qwen_corpus.json`) is built by `qwen_corpus_gen.mjs` from the REAL
Qwen Code 0.22.2 output the [Qwen G0] spike captured (`docs/qwen-g0/corpus/`), so
these assertions run against shapes real Qwen actually emits — the G1 no-mock
lesson. The projected fixture (`qwen_projected.jsonl`) and the rendered blocks
(`qwen_expected_blocks.json`) are the SAME artifacts the JS parity test in
`tunnel-agent.test.js` asserts against, so both readers are pinned to one expected
result: that is the py/js parity proof this ticket requires.

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


qt = _load("qwen_transcript", "qwen_transcript.py")
ha = _load("hub_agent", "hub-agent.py")

SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
PROJECT_KW = dict(cwd="/repos/x", git_branch="XERK-508", version="qwen-0.22.2")


def _corpus():
    with open(os.path.join(HERE, "qwen_corpus.json")) as f:
        return json.load(f)


def _project():
    return qt.project_log(_corpus(), session_id=SID, **PROJECT_KW)


class TestQwenProjectionShape(unittest.TestCase):
    def test_only_surface_events_project(self):
        """The 3 Qwen SURFACE event types (user/assistant/tool_result) produce
        entries; every `system` event (attribution/file-history/telemetry/slash)
        projects to nothing. The corpus is 5 user + 9 assistant + 4 tool_result
        surface events (18) and 29 system events (0)."""
        entries = _project()
        self.assertEqual(len(entries), 18)
        # The two recorded sessions strictly alternate user/assistant turns with
        # tool_result folded onto the user side.
        self.assertEqual(
            [e["type"] for e in entries],
            ["user", "assistant"] * 9,
        )

    def test_system_events_project_nothing(self):
        for subtype in ("attribution_snapshot", "file_history_snapshot",
                        "ui_telemetry", "slash_command"):
            proj = qt.QwenProjector(SID)
            ev = {"type": "system", "subtype": subtype, "timestamp": "",
                  "systemPayload": {"anything": True}}
            self.assertEqual(proj.feed(ev), [], subtype)

    def test_ui_telemetry_token_counts_are_not_the_usage_source(self):
        """A `ui_telemetry` api_response row carries its own token counts, but it
        is log-only — usage rides the assistant event's `usageMetadata`, so the
        telemetry row must NOT be double-counted."""
        proj = qt.QwenProjector(SID)
        ev = {"type": "system", "subtype": "ui_telemetry", "timestamp": "",
              "systemPayload": {"uiEvent": {"event.name": "qwen-code.api_response",
                                            "input_token_count": 9999,
                                            "output_token_count": 42}}}
        self.assertEqual(proj.feed(ev), [])

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

    def test_envelope_carries_pinned_context(self):
        e = _project()[0]
        self.assertEqual(e["sessionId"], SID)
        self.assertEqual(e["cwd"], "/repos/x")
        self.assertEqual(e["gitBranch"], "XERK-508")
        self.assertEqual(e["version"], "qwen-0.22.2")
        self.assertEqual(e["isSidechain"], False)
        self.assertEqual(e["userType"], "external")


class TestQwenProjectionBlocks(unittest.TestCase):
    """The projection renders through the REAL _entry_blocks — the same reader a
    Claude transcript uses — into the expected block shapes."""

    def _blocks(self):
        return [ha._entry_blocks(e, ha.BLOCK_CAPS) for e in _project()]

    def test_matches_committed_expected_blocks(self):
        with open(os.path.join(HERE, "qwen_expected_blocks.json")) as f:
            expected = json.load(f)
        self.assertEqual(self._blocks(), expected)

    def test_committed_projection_matches_live(self):
        """The committed qwen_projected.jsonl (which the JS parity test reads) is
        exactly what the projector produces now — the two fixtures cannot drift
        apart silently."""
        with open(os.path.join(HERE, "qwen_projected.jsonl")) as f:
            committed = [json.loads(ln) for ln in f if ln.strip()]
        self.assertEqual(committed, _project())

    def test_user_prompt_shape(self):
        b = self._blocks()
        self.assertEqual(b[0], [{"t": "text", "text":
            "Create a file named hello.txt containing exactly HELLO_QWEN. "
            "Use the write_file tool."}])

    def test_assistant_reasoning_text_tool_shapes(self):
        # First assistant turn: reasoning(thought:true)->thinking, text,
        # functionCall(tool_search)->tool_use. The desc proves the input is a real
        # dict, not opaque text.
        asst = self._blocks()[1]
        self.assertEqual([x["t"] for x in asst], ["thinking", "text", "tool_use"])
        self.assertEqual(asst[2]["name"], "tool_search")

    def test_tool_result_success_and_error_blocks(self):
        b = self._blocks()
        # b[2] is the tool_search result (success, no is_error).
        self.assertEqual(b[2][0]["t"], "tool_result")
        self.assertNotIn("isError", b[2][0])
        # The last tool_result in the corpus is the hard-denied shell call.
        errs = [blk for e in b for blk in e
                if blk.get("t") == "tool_result" and blk.get("isError")]
        self.assertTrue(errs)
        self.assertTrue(any("hard-denied by policy" in blk["text"] for blk in errs))


class TestQwenProjectionAccounting(unittest.TestCase):
    """usage + model ride the projection with no schema change, so a Qwen
    session's spend and model surface like a Claude session's."""

    def _lines(self):
        return [json.dumps(e) for e in _project()]

    def test_usage_totals_and_model_breakdown(self):
        acc = ha._UsageAcc()
        ha._accumulate_usage(self._lines(), acc)
        # Sum of the 9 assistant turns' promptTokenCount (all cached=0 in the
        # corpus, so input == prompt) and candidatesTokenCount.
        self.assertEqual(acc.totals["input"], 181381)
        self.assertEqual(acc.totals["output"], 2063)
        self.assertEqual(acc.totals["cacheRead"], 0)
        self.assertEqual(acc.totals["cacheWrite"], 0)
        # The local endpoint's model id appears in the breakdown, not filtered.
        self.assertIn("qwen3.8-27b-dflash", acc.models)
        self.assertNotIn("<synthetic>", acc.models)

    def test_model_actual(self):
        rep = {"modelActual": None}
        for ln in self._lines():
            ha._scan_model_entry(json.loads(ln), rep)
        self.assertEqual(rep["modelActual"], "qwen3.8-27b-dflash")

    def test_usage_dedup_key_is_stable(self):
        # Folding the same lines twice (a message re-seen across incremental
        # beats) counts each turn once, via the (message id, requestId) key.
        acc = ha._UsageAcc()
        lines = self._lines()
        ha._accumulate_usage(lines, acc)
        ha._accumulate_usage(lines, acc)
        self.assertEqual(acc.totals["input"], 181381)


class TestQwenUsageMapping(unittest.TestCase):
    """The Gemini-shaped usageMetadata -> Claude's disjoint counts, and the traps
    the corpus (all cached=0) cannot exercise on its own."""

    def _usage(self, meta):
        proj = qt.QwenProjector(SID)
        ev = {"type": "assistant", "timestamp": "", "model": "m",
              "usageMetadata": meta,
              "message": {"role": "model", "parts": [{"text": "hi"}]}}
        return proj.feed(ev)[0]["message"].get("usage")

    def test_cached_prompt_splits_into_disjoint_input_and_cache_read(self):
        # promptTokenCount is the WHOLE prompt (cached included); input is the
        # UNCACHED remainder, so the two sum to the prompt like Claude's.
        u = self._usage({"promptTokenCount": 1000, "candidatesTokenCount": 50,
                         "cachedContentTokenCount": 300})
        self.assertEqual(u["input_tokens"], 700)
        self.assertEqual(u["cache_read_input_tokens"], 300)
        self.assertEqual(u["output_tokens"], 50)
        self.assertEqual(u["cache_creation_input_tokens"], 0)

    def test_thoughts_are_not_added_to_output(self):
        # candidatesTokenCount already includes thoughtsTokenCount, so output is
        # candidates alone — counting thoughts again would double the reasoning.
        u = self._usage({"promptTokenCount": 100, "candidatesTokenCount": 80,
                         "thoughtsTokenCount": 30})
        self.assertEqual(u["output_tokens"], 80)

    def test_cached_over_prompt_clamps_input_to_zero(self):
        u = self._usage({"promptTokenCount": 10, "candidatesTokenCount": 5,
                         "cachedContentTokenCount": 99})
        self.assertEqual(u["input_tokens"], 0)

    def test_no_usage_metadata_projects_no_usage_key(self):
        proj = qt.QwenProjector(SID)
        ev = {"type": "assistant", "timestamp": "", "model": "m",
              "message": {"role": "model", "parts": [{"text": "hi"}]}}
        self.assertNotIn("usage", proj.feed(ev)[0]["message"])

    def test_all_zero_usage_projects_no_usage_key(self):
        """A usage block present but all-zero (a local endpoint that reports no
        counts) projects no `usage` — else it plants a phantom zero-token model in
        the usage page's per-model table (the `<synthetic>` defect for Claude)."""
        proj = qt.QwenProjector(SID)
        ev = {"type": "assistant", "timestamp": "", "model": "qwen-local",
              "usageMetadata": {"promptTokenCount": 0, "candidatesTokenCount": 0,
                                "cachedContentTokenCount": 0, "totalTokenCount": 0},
              "message": {"role": "model", "parts": [{"text": "hi"}]}}
        self.assertNotIn("usage", proj.feed(ev)[0]["message"])


class TestQwenUsageReportEndToEnd(unittest.TestCase):
    """[Qwen G] (XERK-513): a Qwen session's spend charts on the Usage page and
    the dashboard token tiles IDENTICALLY to a Claude session, because the
    projection writes the same `message.usage` / `message.model` shape the
    aggregation reads — no schema change and no `agentType` branch (D4, the dsh
    [G]/XERK-471 analogue). This proves the whole chain one layer above
    `_accumulate_usage`: a projected Qwen transcript on disk, named by the pinned
    session id like any conversation, folds through `repo_usage_report` into the
    host + per-repo totals AND the per-model breakdown, with LOCAL / OpenAI-compat
    model ids appearing beside Claude's rather than being filtered as synthetic
    (they may dominate a Qwen host's turns). Mirrors `TestDshUsageReportEndToEnd`
    in `test_dsh_transcript.py`."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="qwen-usage-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        p = mock.patch.object(ha, "PROJECTS_ROOT", self.tmp)
        p.start()
        self.addCleanup(p.stop)

    def _assistant(self, seq, model, prompt, cand, cached=0):
        # A Qwen assistant event carries Gemini-shaped `usageMetadata` at the top
        # level (promptTokenCount is the WHOLE prompt, cachedContentTokenCount the
        # cached subset), which `_map_usage` splits into Claude's disjoint counts.
        return {"type": "assistant", "uuid": f"u{seq}",
                "timestamp": "2025-06-15T12:00:00.000Z", "model": model,
                "usageMetadata": {"promptTokenCount": prompt,
                                  "candidatesTokenCount": cand,
                                  "cachedContentTokenCount": cached,
                                  "totalTokenCount": prompt + cand},
                "message": {"role": "model", "parts": [{"text": "ok"}]}}

    def _write_projection(self, worktree, events):
        slug = ha._project_slug(worktree)
        d = os.path.join(self.tmp, slug)
        os.makedirs(d, exist_ok=True)
        # Named by the pinned conversation id, exactly as the launcher's tail
        # (`QwenProjectionTail`) writes it under PROJECTS_ROOT.
        lines = qt.project_log_lines(events, session_id=SID, cwd=worktree)
        with open(os.path.join(d, f"{SID}.jsonl"), "w") as f:
            f.writelines(lines)
        return slug

    def _fold_full(self, slug):
        acc = ha._UsageAcc()
        ha._aggregate_project(os.path.join(self.tmp, slug), acc)
        return acc

    def test_qwen_spend_and_local_models_flow_into_the_report(self):
        worktree = "/repos/.turma/worktrees/Turma/qwen01"
        # Two turns on a local qwen model (the first with a cached prompt), one on
        # an OpenAI-compatible endpoint — none of them Claude.
        slug = self._write_projection(worktree, [
            self._assistant(1, "qwen3-coder-30b-a3b", 5000, 200, cached=4000),
            self._assistant(2, "qwen3-coder-30b-a3b", 300, 40),
            self._assistant(3, "deepseek-v3", 500, 90),
        ])
        ledger = {worktree: {"repo": "Turma",
                             "remote": "git@github.com:xerktech/Turma.git",
                             "slug": slug}}
        repo_usage, host = ha.repo_usage_report(ledger, self._fold_full)

        # The Qwen session's spend is a real host block — "charts identically".
        self.assertIsNotNone(host)
        self.assertEqual(host["totals"]["input"], 1800)   # 1000 + 300 + 500
        self.assertEqual(host["totals"]["output"], 330)   # 200 + 40 + 90
        self.assertEqual(host["totals"]["cacheRead"], 4000)
        # Qwen has NO cache-CREATION concept, so cacheWrite is always 0 — unlike
        # dsh, which maps a real cacheWriteTokens.
        self.assertEqual(host["totals"]["cacheWrite"], 0)

        turma = next(r for r in repo_usage if r["repo"] == "Turma")
        self.assertEqual(turma["usage"]["totals"]["input"], 1800)

        # Local qwen + OpenAI-compat ids appear in the per-model breakdown, NOT
        # filtered out the way `<synthetic>` is.
        models = {m["model"]: m for m in host["models"]}
        self.assertEqual(models["qwen3-coder-30b-a3b"]["totals"]["input"], 1300)
        self.assertEqual(models["deepseek-v3"]["totals"]["input"], 500)
        self.assertNotIn("<synthetic>", models)


class TestQwenToolNameMapping(unittest.TestCase):
    """Qwen's shell tool is `run_shell_command`; the read side keys PR attribution
    and the Bash card on `"Bash"`. The projector must map it in the seam — teaching
    the readers about Qwen names is the mirror multiplication this exists to avoid."""

    def test_corpus_uses_the_real_shell_tool_name(self):
        # Guards against a fixture regressing to a faked `Bash` — assert the raw
        # corpus carries Qwen's real `run_shell_command`.
        corpus = _corpus()
        shell_calls = [
            p["functionCall"] for e in corpus if e.get("type") == "assistant"
            for p in (e.get("message", {}).get("parts") or [])
            if isinstance(p, dict) and isinstance(p.get("functionCall"), dict)
            and p["functionCall"].get("name") == "run_shell_command"
        ]
        self.assertTrue(shell_calls, "corpus must carry a real run_shell_command call")

    def test_run_shell_command_maps_to_Bash(self):
        proj = qt.QwenProjector(SID)
        ev = {"type": "assistant", "timestamp": "", "model": "m", "message": {
            "role": "model", "parts": [{"functionCall": {
                "id": "c", "name": "run_shell_command",
                "args": {"command": "ls", "description": "list"}}}]}}
        tu = proj.feed(ev)[0]["message"]["content"][0]
        self.assertEqual(tu["name"], "Bash")
        self.assertEqual(tu["input"]["command"], "ls")

    def test_other_tools_pass_through(self):
        proj = qt.QwenProjector(SID)
        for name in ("write_file", "read_file", "tool_search"):
            ev = {"type": "assistant", "timestamp": "", "model": "m", "message": {
                "role": "model", "parts": [{"functionCall": {
                    "id": "c", "name": name, "args": {}}}]}}
            tu = proj.feed(ev)[0]["message"]["content"][0]
            self.assertEqual(tu["name"], name)


class TestQwenPrAttribution(unittest.TestCase):
    """The reason the shell tool must map to `Bash` and a tool call must project
    as a real tool_use/tool_result pair: a `gh pr create` is attributed as the
    session's PR ([Qwen H]). The G0 corpus opens no PR, so this drives a
    realistically-shaped Qwen `run_shell_command` event through the real projector
    and the real `_scan_pr_line`."""

    def test_gh_pr_create_is_attributed(self):
        proj = qt.QwenProjector(SID)
        call = {"type": "assistant", "timestamp": "2026-08-28T18:20:00.000Z",
                "model": "qwen3.8-27b-dflash", "uuid": "u1", "message": {
                    "role": "model", "parts": [
                        {"text": "Opening the PR.", "thought": True},
                        {"functionCall": {"id": "call_pr", "name": "run_shell_command",
                         "args": {"command": 'gh pr create --title "Fix" --body "..."',
                                  "description": "Open the PR"}}}]}}
        result = {"type": "tool_result", "timestamp": "2026-08-28T18:20:05.000Z",
                  "toolCallResult": {"status": "success"}, "message": {
                      "role": "user", "parts": [{"functionResponse": {
                          "id": "call_pr", "name": "run_shell_command", "response": {
                              "output": "https://github.com/xerktech/Turma/pull/321"}}}]}}
        entries = proj.feed(call) + proj.feed(result)
        state, report = {}, {"prUrls": []}
        for e in entries:
            ha._scan_pr_line(json.dumps(e), state, report)
        self.assertEqual(report["prUrls"],
                         ["https://github.com/xerktech/Turma/pull/321"])


class TestQwenProjectionEdgeCases(unittest.TestCase):
    def test_malformed_event_projects_nothing(self):
        proj = qt.QwenProjector(SID)
        for bad in (None, 5, "x", [], {}, {"type": "user"},
                    {"type": "user", "message": None},
                    {"type": "assistant", "message": {"parts": None}}):
            self.assertEqual(proj.feed(bad), [], repr(bad))

    def test_empty_user_content_projects_nothing(self):
        proj = qt.QwenProjector(SID)
        ev = {"type": "user", "timestamp": "",
              "message": {"role": "user", "parts": [{"text": ""}]}}
        self.assertEqual(proj.feed(ev), [])

    def test_empty_assistant_content_projects_nothing(self):
        proj = qt.QwenProjector(SID)
        ev = {"type": "assistant", "timestamp": "", "model": "m",
              "message": {"role": "model", "parts": []}}
        self.assertEqual(proj.feed(ev), [])

    def test_non_dict_function_args_keep_a_dict(self):
        proj = qt.QwenProjector(SID)
        ev = {"type": "assistant", "timestamp": "", "model": "m", "message": {
            "role": "model", "parts": [{"functionCall": {
                "id": "c", "name": "x", "args": "not-a-dict"}}]}}
        tu = proj.feed(ev)[0]["message"]["content"][0]
        self.assertIsInstance(tu["input"], dict)

    def test_bad_timestamp_becomes_empty_string(self):
        proj = qt.QwenProjector(SID)
        for bad in (None, 123, "not-a-date", "2026/08/28", float("nan")):
            ev = {"type": "user", "timestamp": bad, "message": {
                "role": "user", "parts": [{"text": "hi"}]}}
            self.assertEqual(proj.feed(ev)[0]["timestamp"], "", repr(bad))

    def test_tool_result_without_call_id(self):
        proj = qt.QwenProjector(SID)
        ev = {"type": "tool_result", "timestamp": "", "message": {
            "role": "user", "parts": [{"functionResponse": {
                "name": "x", "response": {"output": "ok"}}}]}}
        block = proj.feed(ev)[0]["message"]["content"][0]
        self.assertEqual(block["type"], "tool_result")
        self.assertNotIn("tool_use_id", block)
        self.assertEqual(block["content"], "ok")

    def test_tool_result_error_via_toolCallResult(self):
        # An error signalled only by toolCallResult (no `error` in the response)
        # still rides through as is_error.
        proj = qt.QwenProjector(SID)
        ev = {"type": "tool_result", "timestamp": "",
              "toolCallResult": {"status": "error"}, "message": {
                  "role": "user", "parts": [{"functionResponse": {
                      "id": "c", "response": {"output": "partial"}}}]}}
        block = proj.feed(ev)[0]["message"]["content"][0]
        self.assertTrue(block["is_error"])

    def test_infinite_or_nan_usage_never_crashes(self):
        """feed() runs per streamed event in the launcher, so a usage field that
        is a JSON infinity (`1e999` is legal RFC-8259 → inf, and int(inf) raises
        OverflowError) or NaN must NOT abort the projection — it drops to a 0
        count. The trap the codebase already guards elsewhere (`_token_count`)."""
        proj = qt.QwenProjector(SID)
        for field in ("promptTokenCount", "candidatesTokenCount",
                      "cachedContentTokenCount"):
            for bad in (float("inf"), float("-inf"), float("nan")):
                meta = {"promptTokenCount": 100, "candidatesTokenCount": 50,
                        "cachedContentTokenCount": 0}
                meta[field] = bad
                ev = {"type": "assistant", "timestamp": "", "model": "m",
                      "usageMetadata": meta, "message": {
                          "role": "model", "parts": [{"text": "hi"}]}}
                out = proj.feed(ev)  # must not raise
                self.assertEqual(out[0]["type"], "assistant", (field, bad))

    def test_json_infinity_literal_usage_never_crashes(self):
        # `1e999` decodes to inf straight from a native log line; int(inf) is the
        # OverflowError _int must swallow.
        proj = qt.QwenProjector(SID)
        ev = json.loads('{"type":"assistant","timestamp":"","model":"m",'
                        '"usageMetadata":{"promptTokenCount":1e999,'
                        '"candidatesTokenCount":5},'
                        '"message":{"role":"model","parts":[{"text":"hi"}]}}')
        out = proj.feed(ev)  # must not raise
        # inf input drops to 0, so with only a finite output count the usage block
        # survives (output_tokens=5); the poisoned input is 0, never inf.
        self.assertEqual(out[0]["message"]["usage"]["input_tokens"], 0)
        self.assertEqual(out[0]["message"]["usage"]["output_tokens"], 5)

    def test_interrupt_marker_flows_through_as_a_user_turn(self):
        # Qwen has no dedicated interrupt event; if it writes the marker as user
        # text, it projects as a user message and the reader's INTERRUPT_RE
        # classifies it — no special case in the projector.
        proj = qt.QwenProjector(SID)
        ev = {"type": "user", "timestamp": "", "message": {
            "role": "user", "parts": [{"text": "[Request interrupted by user]"}]}}
        entry = proj.feed(ev)[0]
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS),
                         [{"t": "interrupt", "text": "[Request interrupted by user]"}])


if __name__ == "__main__":
    unittest.main()
