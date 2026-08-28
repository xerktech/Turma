# Qwen G0 spike — committed evidence (XERK-505)

Real Qwen Code `0.22.2` artifacts captured while proving the interactive-TUI drive model. Findings,
recipe and the GO/NO-GO are in [`../qwen-g0-spike.md`](../qwen-g0-spike.md). Everything here is real
output driven against the LiteLLM gateway (`https://lite.xerktech.com`, model `qwen3.8-27b-dflash`);
scanned to contain no API keys or host/org secrets.

## `corpus/` — real native JSONL (S1/C parsers build against these)

- `session-A-write-and-deny.jsonl` — one interactive session: greeting → `write_file` (via deferred
  `tool_search`) with an approved change → an OS-denied `cat /etc/shadow` → a post-**resume** recall
  turn. Shows `user`, `assistant` (text, `{text,thought:true}`, `{functionCall}`), `tool_result`
  (`{functionResponse}`), and `system` subtypes (`attribution_snapshot`, `file_history_snapshot`,
  `ui_telemetry`, `slash_command`); every row carries `uuid`/`parentUuid`/`sessionId`/`timestamp`/
  `cwd`/`version`; assistant rows carry `model`/`usageMetadata`/`contextWindowSize`.
- `session-B-hard-deny.jsonl` — a session whose `run_shell_command` was **hard-denied by the
  PreToolUse hook** (tool never executed).

## `pane/` — `tmux capture-pane -p` frames (crit. 4 markers)

- `01-idle.txt` — idle footer `⏸ Ask permissions (shift + tab to cycle)`.
- `02-busy.txt` — busy: `∵︎ Thinking… Ns`, spinner `(… · esc to cancel)`, footer prefix
  `Enter to steer · Ctrl+Q to queue`. (The spinner phrase randomizes — parse the stable tokens.)
- `03-tool-approval.txt` — the tool-approval prompt (`? WriteFile … / Apply this change? / › 1. Yes,
  allow once / Waiting for user confirmation...`).
- `04-hard-deny.txt` — the PreToolUse deny surfaced in the pane
  (`x Shell … / SPIKE-GUARD: run_shell_command is hard-denied by policy`).

## `recipe/` — how to reproduce

- `workspace-settings.json` — the worktree `.qwen/settings.json`: `approvalMode:"default"`,
  `autoAccept:false`, and the `PreToolUse` deny hook wiring.
- `deny.py` — the PreToolUse command hook (logs its stdin, denies `run_shell_command` via
  `permissionDecision:"deny"`). Also the reference for the **timeout-is-milliseconds** gotcha.
- `pretooluse-hook-input.sample` — the exact JSON Qwen passes a PreToolUse hook on stdin.
- `runtime.json.sample` — the live per-session registry file (`<id>.runtime.json`).
- `qwen-help.txt` — full `qwen --help` for `0.22.2` (documents `--session-id`, `--resume`,
  `--json-file`/`--json-fd`, `--input-file`, `--openai-base-url`/`--openai-api-key`, etc.).
