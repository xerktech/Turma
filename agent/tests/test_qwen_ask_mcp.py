#!/usr/bin/env python3
"""Tests for agent/qwen/ask_mcp.py — the qwen AskUserQuestion MCP server
(XERK-509 [Qwen C]).

Pins the JSON-RPC/MCP handshake and, load-bearingly, that a `tools/call` writes
the EXACT rendezvous file `ask.py`/`_hook_question` use and returns the operator's
answer resolved to option labels — so the existing answer_question path answers a
qwen question with no client change.
"""

import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MCP = os.path.join(os.path.dirname(_HERE), "qwen", "ask_mcp.py")
_spec = importlib.util.spec_from_file_location("qwen_ask_mcp", _MCP)
ask_mcp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ask_mcp)


class AskMcpHandshakeTest(unittest.TestCase):
    def test_initialize_advertises_tools_capability(self):
        resp = ask_mcp._handle({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                "params": {}})
        self.assertEqual(resp["id"], 1)
        self.assertIn("tools", resp["result"]["capabilities"])
        self.assertEqual(resp["result"]["serverInfo"]["name"], "turma-ask")

    def test_initialized_notification_gets_no_reply(self):
        self.assertIsNone(ask_mcp._handle({"jsonrpc": "2.0",
                                           "method": "notifications/initialized"}))

    def test_tools_list_exposes_ask_user_question(self):
        resp = ask_mcp._handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        tools = resp["result"]["tools"]
        self.assertEqual(len(tools), 1)
        self.assertEqual(tools[0]["name"], "ask_user_question")
        schema = tools[0]["inputSchema"]
        self.assertEqual(set(schema["required"]), {"question", "options"})

    def test_unknown_method_is_a_jsonrpc_error(self):
        resp = ask_mcp._handle({"jsonrpc": "2.0", "id": 9, "method": "no/such"})
        self.assertEqual(resp["error"]["code"], -32601)

    def test_calling_an_unknown_tool_errors(self):
        resp = ask_mcp._handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                "params": {"name": "other", "arguments": {}}})
        self.assertEqual(resp["error"]["code"], -32602)


class AskMcpRoundTripTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="qwen-ask-")
        self.addCleanup(self._rmtree)
        self.sid = "sess-1"
        self.qdir = os.path.join(self.tmp, "questions")
        os.makedirs(self.qdir, exist_ok=True)
        self._patch_env({
            "TURMA_SESSION_ID": self.sid,
            "TURMA_QUESTIONS_DIR": self.qdir,
            "TURMA_QUESTION_TIMEOUT_SEC": "5",
        })
        self.req_path = os.path.join(self.qdir, f"{self.sid}.req.json")
        self.ans_path = os.path.join(self.qdir, f"{self.sid}.ans.json")

    def _rmtree(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _patch_env(self, env):
        saved = {k: os.environ.get(k) for k in env}
        os.environ.update(env)

        def restore():
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        self.addCleanup(restore)

    def test_call_writes_the_bridge_req_file_and_returns_the_answer(self):
        # Drop the answer a beat after the call starts blocking, then assert the
        # req file matched the ask.py shape and the tool result names the choice.
        seen_req = {}

        def answer_later():
            for _ in range(50):
                if os.path.exists(self.req_path):
                    with open(self.req_path) as f:
                        seen_req.update(json.load(f))
                    break
                time.sleep(0.05)
            with open(self.ans_path, "w") as f:
                json.dump({"optionIndex": 1}, f)

        t = threading.Thread(target=answer_later)
        t.start()
        resp = ask_mcp._handle({
            "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": {"name": "ask_user_question", "arguments": {
                "question": "Which database?",
                "options": ["Postgres", "SQLite"],
                "multiSelect": False,
                "header": "DB choice",
            }}})
        t.join()
        # The req file is the exact rendezvous shape every question surface reads.
        self.assertEqual(seen_req["sessionId"], self.sid)
        self.assertEqual(seen_req["question"], "Which database?")
        self.assertEqual([o["label"] for o in seen_req["options"]],
                         ["Postgres", "SQLite"])
        self.assertEqual(seen_req["header"], "DB choice")
        # The tool result names the chosen option; the rendezvous files are gone.
        text = resp["result"]["content"][0]["text"]
        self.assertIn("SQLite", text)
        self.assertFalse(os.path.exists(self.req_path))
        self.assertFalse(os.path.exists(self.ans_path))

    def test_multiselect_answer_resolves_all_labels(self):
        def answer_later():
            for _ in range(50):
                if os.path.exists(self.req_path):
                    break
                time.sleep(0.05)
            with open(self.ans_path, "w") as f:
                json.dump({"optionIndices": [0, 2]}, f)

        t = threading.Thread(target=answer_later)
        t.start()
        resp = ask_mcp._handle({
            "jsonrpc": "2.0", "id": 8, "method": "tools/call",
            "params": {"name": "ask_user_question", "arguments": {
                "question": "Pick features",
                "options": ["A", "B", "C"],
                "multiSelect": True,
            }}})
        t.join()
        text = resp["result"]["content"][0]["text"]
        self.assertIn("A", text)
        self.assertIn("C", text)

    def test_timeout_returns_a_benign_no_answer_result(self):
        # No answer dropped: with a tiny timeout the call returns cleanly rather
        # than blocking forever, and cleans up the req file.
        os.environ["TURMA_QUESTION_TIMEOUT_SEC"] = "0.2"
        resp = ask_mcp._handle({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": {"name": "ask_user_question", "arguments": {
                "question": "Anyone there?", "options": ["Yes", "No"]}}})
        self.assertNotIn("error", resp)
        self.assertIn("did not answer", resp["result"]["content"][0]["text"])
        self.assertFalse(os.path.exists(self.req_path))

    def test_no_turma_env_returns_a_benign_result_without_blocking(self):
        os.environ.pop("TURMA_SESSION_ID", None)
        resp = ask_mcp._handle({
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": {"name": "ask_user_question", "arguments": {
                "question": "Q?", "options": ["a", "b"]}}})
        self.assertIn("No Turma operator", resp["result"]["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
