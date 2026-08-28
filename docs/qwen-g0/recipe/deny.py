#!/usr/bin/env python3
import sys, json, os, time
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except Exception:
    data = {}
tool = data.get("tool_name") or data.get("toolName") or ""
ti = data.get("tool_input") or data.get("toolInput") or {}
logdir = os.path.join(os.path.dirname(__file__))
with open(os.path.join(logdir, "hook-invocations.log"), "a") as f:
    f.write(f"{time.time()} tool={tool!r} keys={list(data.keys())} input={json.dumps(ti)[:200]}\n")
if tool in ("run_shell_command", "RunShellCommand"):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "SPIKE-GUARD: run_shell_command is hard-denied by policy"
        }
    }))
    sys.exit(0)
sys.exit(0)
