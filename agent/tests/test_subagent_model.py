#!/usr/bin/env python3
"""Tests for the QA/review sub-agent model pin hook (agent/hooks/subagent_model.py,
XERK-1851). Driven through main() with a patched stdin/stdout, and once as the
real `python3 -SI` subprocess Claude Code runs."""

import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import unittest
from unittest import mock

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE_PATH = os.path.join(AGENT_DIR, "hooks", "subagent_model.py")

spec = importlib.util.spec_from_file_location("subagent_model_hook", MODULE_PATH)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class _Stdin:
    """A stdin exposing only .buffer, as the hook must read it."""
    def __init__(self, data):
        self.buffer = io.BytesIO(data)


def run_main(event, pin="opus"):
    stdin = event if isinstance(event, (str, bytes)) else json.dumps(event)
    if isinstance(stdin, str):
        stdin = stdin.encode("utf-8")
    env = {"TURMA_PIN_SUBAGENT_MODEL": pin} if pin is not None else {}
    out = io.StringIO()
    with mock.patch.object(sys, "stdin", _Stdin(stdin)), \
            mock.patch.object(sys, "stdout", out), \
            mock.patch.dict(os.environ, env, clear=False):
        if pin is None:
            os.environ.pop("TURMA_PIN_SUBAGENT_MODEL", None)
        rc = hook.main()
    return rc, out.getvalue()


def agent_call(**tool_input):
    return {"hook_event_name": "PreToolUse", "tool_name": "Agent",
            "tool_input": {"description": "d", "prompt": "p", **tool_input}}


class TestSubagentModelPin(unittest.TestCase):
    def updated(self, out):
        body = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(body["hookEventName"], "PreToolUse")
        # No decision: the call still goes through the normal permission flow.
        self.assertNotIn("permissionDecision", body)
        return body["updatedInput"]

    def test_qa_with_no_model_is_pinned(self):
        rc, out = run_main(agent_call(subagent_type="qa"))
        self.assertEqual(rc, 0)
        self.assertEqual(self.updated(out),
                         {"description": "d", "prompt": "p",
                          "subagent_type": "qa", "model": "opus"})

    def test_a_cheaper_model_on_the_call_is_overridden(self):
        # The call's own model beats the definition's frontmatter (measured),
        # so this is the case a pinned qa.md alone could not cover.
        rc, out = run_main(agent_call(subagent_type="qa-delta", model="haiku",
                                      run_in_background=True))
        upd = self.updated(out)
        self.assertEqual(upd["model"], "opus")
        self.assertTrue(upd["run_in_background"])      # other fields kept

    def test_reviewers_are_pinned(self):
        for name in ("code-reviewer", "Review", "security-review", "pr_reviews",
                     "CodeReviewer", "prreview", "peer-reviewing"):
            _, out = run_main(agent_call(subagent_type=name))
            self.assertEqual(self.updated(out)["model"], "opus", name)

    def test_search_and_work_agents_stay_on_the_default(self):
        for name in ("Explore", "general-purpose", "Plan", "qa-helper", None, 3,
                     "ui-preview", "previewer", "Preview"):
            rc, out = run_main(agent_call(subagent_type=name, model="haiku"))
            self.assertEqual((rc, out), (0, ""), name)
        rc, out = run_main(agent_call(prompt="no type"))
        self.assertEqual((rc, out), (0, ""))

    def test_already_on_the_pin_emits_nothing(self):
        self.assertEqual(run_main(agent_call(subagent_type="qa", model="opus")),
                         (0, ""))

    def test_no_pin_in_env_passes_through(self):
        # Local-model sessions and claude run outside Turma carry no pin.
        self.assertEqual(run_main(agent_call(subagent_type="qa"), pin=None), (0, ""))
        self.assertEqual(run_main(agent_call(subagent_type="qa"), pin="  "), (0, ""))

    def test_non_ascii_prompt_round_trips_byte_exact(self):
        # The hook echoes the whole prompt back: reading text stdin on Windows
        # (cp1252) turned "—" into "â€”" (XERK-1851 QA).
        prompt = "Verify the fix — café → ✓ 日本"
        _, out = run_main(agent_call(subagent_type="qa", prompt=prompt))
        self.assertTrue(out.isascii())
        self.assertEqual(self.updated(out)["prompt"], prompt)

    def test_malformed_input_never_blocks(self):
        for bad in ("", "{not json", "[]", '"x"', b"\xff\xfe", json.dumps({"tool_input": []}),
                    json.dumps({"tool_input": None})):
            self.assertEqual(run_main(bad), (0, ""), bad)

    def test_runs_isolated_as_claude_code_invokes_it(self):
        env = dict(os.environ, TURMA_PIN_SUBAGENT_MODEL="opus")
        r = subprocess.run([sys.executable, "-SI", MODULE_PATH], env=env,
                           input=json.dumps(agent_call(subagent_type="qa", model="haiku")),
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.updated(r.stdout)["model"], "opus")


META = """// a header: export const meta = { name: 'decoy' }
export const meta = {
  name: 'qa-run', description: 'it\\'s a } and "}" // not a comment',
  phases: [{ title: 'QA' }], /* } */
}"""
BODY = """
const a = await agent('check', { agentType: 'qa', model: 'haiku', label: 'qa' })
const b = await agent('find', { agentType: 'general-purpose' })
const c = await agent('rev', { agentType: 'Code-Reviewer' })
const d = await agent('prev', { agentType: 'ui-preview' })
const e = await agent('plain')
return [a, b, c, d, e]
"""
SCRIPT = META + BODY
EXPECTED = ["check:opus", "find:-", "rev:opus", "prev:-", "plain:-"]


def workflow_call(**tool_input):
    return {"hook_event_name": "PreToolUse", "tool_name": "Workflow",
            "tool_input": tool_input}


def body_of(script):
    """The body the runtime runs: what follows the meta literal, with its
    `^[;\\s]*\\n` lead stripped (both read from 2.1.296)."""
    assert script.startswith(META), script
    return re.sub(r"^[;\s]*\n", "", script[len(META):], count=1)


def run_body(body):
    """Run a script body as Claude Code's Workflow runtime does (2.1.296):
    `async () => {'use strict'; body}` in a vm context with `agent` a context
    global, here one echoing the model it was handed."""
    js = ("const vm = require('vm');"
          "const ctx = vm.createContext({agent: async (p, o) => `${p}:${o && o.model || '-'}`});"
          "vm.runInContext(\"(async () => {'use strict';\" + process.argv[1] + \"\\n})()\", ctx)"
          ".then(r => console.log(JSON.stringify(r)), e => { console.error(String(e)); process.exit(1) })")
    r = subprocess.run(["node", "-e", js, body], capture_output=True, text=True, timeout=30)
    if r.returncode:
        raise AssertionError(r.stderr)
    return json.loads(r.stdout)


class TestWorkflowPin(unittest.TestCase):
    """A Workflow script's agent() is no Agent call (XERK-1856): the hook rebinds
    the script's `agent` global so grader calls carry the pinned model."""

    def pinned(self, out, source=SCRIPT):
        script = json.loads(out)["hookSpecificOutput"]["updatedInput"]["script"]
        # The meta literal is untouched and the pin adds no line, so the
        # runtime's error line numbers stay the ones the model wrote.
        self.assertTrue(script.startswith(META), script)
        # The pin adds no line to the body the runtime runs, so its stack
        # lines stay the ones the model wrote (XERK-1856 QA).
        self.assertEqual(body_of(script).count("\n"), body_of(source).count("\n"))
        self.assertEqual(body_of(script).split("\n")[1:], body_of(source).split("\n")[1:])
        return script

    def test_only_grader_agent_calls_are_pinned(self):
        rc, out = run_main(workflow_call(script=SCRIPT, args=[1]))
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out)["hookSpecificOutput"]["updatedInput"]["args"], [1])
        self.assertEqual(run_body(body_of(self.pinned(out))), EXPECTED)

    def test_a_body_declaring_its_own_agent_still_runs(self):
        # Wrapping the body in a function with an `agent` parameter made this a
        # SyntaxError (XERK-1856 QA); rebinding the global keeps it legal.
        body = ("\nconst agent = (p, o) => globalThis.agent(p, o)\n"
                "return [await agent('x', { agentType: 'qa' })]\n")
        _, out = run_main(workflow_call(script=META + body))
        self.assertEqual(run_body(body_of(self.pinned(out, META + body))), ["x:opus"])

    def test_a_non_writable_agent_global_lapses_the_pin_not_the_run(self):
        _, out = run_main(workflow_call(script=SCRIPT))
        body = ("Object.defineProperty(globalThis, 'agent', {value: globalThis.agent, writable: false});"
                + body_of(self.pinned(out)))
        self.assertEqual(run_body(body)[0], "check:haiku")

    def test_same_line_and_blank_line_bodies_keep_their_lines(self):
        for body in ("; const r = await agent('x', { agentType: 'qa' }); return [r]\n",
                     "\n\n  \n;\nreturn [await agent('x', { agentType: 'qa' })]\n",
                     "\n(await Promise.resolve(0))\nreturn [await agent('x', { agentType: 'qa' })]\n",
                     "\n/x/.test('x')\nreturn [await agent('x', { agentType: 'qa' })]\n"):
            _, out = run_main(workflow_call(script=META + body))
            self.assertEqual(run_body(body_of(self.pinned(out, META + body))), ["x:opus"], body)

    def test_an_already_pinned_script_is_not_pinned_again(self):
        _, out = run_main(workflow_call(script=SCRIPT))
        self.assertEqual(run_main(workflow_call(script=self.pinned(out))), (0, ""))

    def test_script_path_is_inlined(self):
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False,
                                         encoding="utf-8") as f:
            f.write(SCRIPT)
        self.addCleanup(os.unlink, f.name)
        _, out = run_main(workflow_call(scriptPath=f.name, resumeFromRunId="wf_abc123"))
        upd = json.loads(out)["hookSpecificOutput"]["updatedInput"]
        self.assertNotIn("scriptPath", upd)     # it would win over `script`
        self.assertEqual(upd["resumeFromRunId"], "wf_abc123")
        self.assertEqual(run_body(body_of(self.pinned(out))), EXPECTED)

    def test_unpinnable_input_passes_through(self):
        for ti in ({"name": "saved-flow"}, {"scriptPath": "/nonexistent.js"},
                   {"script": "phase('x')\nawait agent('p')"},
                   {"script": "const x = 1\nexport const meta = { name: 'x' }"},
                   {"script": "/* open comment export const meta = { name: 'x' }"},
                   {"script": "export const meta = { name: 'x' "}, {"script": 3},
                   # past the tool's size cap once pinned: left for the tool to judge
                   {"script": SCRIPT + "//" + "x" * (hook.SCRIPT_MAX_BYTES - len(SCRIPT) - 10)},
                   # the cap is BYTES: few characters, but over it in UTF-8
                   {"script": SCRIPT + "//" + "é" * ((hook.SCRIPT_MAX_BYTES - len(SCRIPT) - 100) // 2)}):
            self.assertEqual(run_main(workflow_call(**ti)), (0, ""), str(ti)[:80])
        self.assertEqual(run_main(workflow_call(script=SCRIPT), pin=None), (0, ""))


if __name__ == "__main__":
    unittest.main()
