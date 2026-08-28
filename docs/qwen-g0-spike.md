# Qwen Code G0 spike — prove the interactive-TUI drive model (XERK-505)

**Gate for XERK-504** (integrate Qwen Code as a first-class runtime alongside Claude Code, chat +
terminal parity). This is the interactive-TUI analogue of the dsh G1 gate (`.claude/rules/dsh.md`).
It proves the chosen drive model against **real Qwen Code, no mock**, and captures the corpus the
projector/parsers (S1/C children) build against.

## Verdict: **GO**

All six acceptance criteria pass against real Qwen Code, driven as an interactive TUI in tmux over
an OpenAI-compatible endpoint. The drive model that Turma already uses for `claude --remote-control`
— pinned session id, native JSONL on disk, tmux pane injection, `capture-pane` state parsing, a
PreToolUse hard-deny guard — **maps onto Qwen with no fundamentally new mechanism**. The fallback
(ACP headless), which the ticket says to escalate for, is **not needed**.

- **Pinned version for the corpus: `qwen` (`@qwen-code/qwen-code`) `0.22.2`.** See "Auto-update is a
  trap" below — the host auto-updated to `0.22.3` *during this spike*, which is itself a finding.
- **Endpoint used:** the LiteLLM gateway `https://lite.xerktech.com` serving model
  `qwen3.8-27b-dflash` (OpenAI-compatible `/v1`). Node v24.19.0 (ticket requires ≥ 22).
- Evidence lives beside this note under `docs/qwen-g0/` — see [that README](qwen-g0/README.md).

## How Qwen maps onto the Claude drive model, at a glance

| Turma needs (Claude term) | Qwen mechanism (proven) |
|---|---|
| Pin a session id at launch (XERK-6) | `qwen --session-id <uuid4>` (strict uuid4 validation) |
| Resume by that id, same transcript | `qwen --resume <id>` — appends to the **same** `<id>.jsonl`, no fork |
| Native transcript on disk, live | `~/.qwen/projects/<slug>/chats/<id>.jsonl`, append-only, written mid-turn |
| Project-slug keyed by cwd | `<slug>` = cwd with `/`→`-` (same rule as Claude Code) |
| Pane-inject user input | tmux `send-keys` (text + `Enter`); also native `--input-file` JSONL channel |
| `paneBusy` | busy = `esc to cancel` spinner + footer `Enter to steer · Ctrl+Q to queue` |
| `panePrompt` (tool approval) | `? <Tool> …` / `Apply this change?` / `› 1. Yes, allow once` / `Waiting for user confirmation…` |
| PreToolUse `--settings` hard-deny | `hooks.PreToolUse[].hooks[]` command hook, `permissionDecision:"deny"` |
| Local/OpenAI endpoint | `OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL` env **or** `--openai-base-url/--openai-api-key -m` **or** `modelProviders.openai` in settings |
| Live session registry (`ps`) | `<id>.runtime.json` (pid/work_dir/host/version) + `qwen sessions ps` |

## Acceptance criteria — what was run, what was seen

### 1. Session-id pinning + resume — PASS

- `qwen --session-id <uuid4>` pins the id; Qwen **validates it must be a real uuid4** (a v3-shaped
  string was rejected: *"Invalid --session-id … Must be a valid UUID"*). Turma mints uuid4 already.
- The pinned id **names the on-disk file** before the first turn: launching created
  `chats/<id>.runtime.json` immediately and `chats/<id>.jsonl` on the first user message — so the
  transcript is known by name before its first byte, closing the XERK-6 "which transcript is a
  session's" trap with **no newest-mtime rule**. (An empty conversation writes no `.jsonl` yet —
  same truth Claude's pin relies on.)
- `qwen --resume <id>` restored the conversation and **appended to the same `<id>.jsonl`**
  (31 → 34 lines; no second file, no fork). After resume the model correctly answered, with no
  tools, that it had written `HELLO_QWEN` into `hello.txt` earlier — real context continuity.
- `--fork-session` exists for the deliberate fork case; plain `--resume` continues in place.

### 2. Native transcript on disk, live — PASS

- Path: `~/.qwen/projects/<cwd-slug>/chats/<sessionId>.jsonl`, append-only.
- It grows **during** a turn, not only at exit: observed 3 → 7 → 9 → 15 lines across a single
  write-file turn while the pane still showed "working".
- **Requires chat recording on.** `general.chatRecording` (flag `--chat-recording`) gates it; if
  false, `--continue/--resume` and the on-disk log do not work. Turma must set it true.
- Event shape is a `uuid`/`parentUuid`-linked list — structurally very close to Claude Code JSONL.
  Real shapes captured in the corpus (see "Event corpus" below).

### 3. Pane-injected input — PASS

- tmux `send-keys` delivered the initial prompt **and** the approval keystroke (`1` + `Enter`)
  mid-session, both processed reliably. This is the `send_input` path Turma already uses.
- Bonus: Qwen ships a **native remote-input channel** — `--input-file <path>` ("An external process
  writes JSONL commands; the TUI watches and processes them") — a first-class alternative to
  screen-scraping keystrokes. Worth evaluating in the drive child; tmux `send-keys` already suffices.

### 4. Parseable pane state — PASS (record the exact markers)

Captured frames: `docs/qwen-g0/pane/{01-idle,02-busy,03-tool-approval,04-hard-deny}.txt`.

- **Busy vs idle** is in the footer status line:
  - idle: `⏸ Ask permissions (shift + tab to cycle)`
  - busy: `Enter to steer · Ctrl+Q to queue · ⏸ Ask permissions (shift + tab to cycle)`, plus a
    spinner line ending `(… · esc to cancel)` and/or `∵︎ Thinking… Ns`.
  - **PITFALL: the spinner's phrase randomizes** ("Applying percussive maintenance…", "Entangling
    quantum particles…", "Polishing the algorithms…", "Pre-heating the servers…"). A parser MUST
    key on the stable tokens **`esc to cancel`** and the footer prefix **`Enter to steer · Ctrl+Q to
    queue`**, never on the phrase. This is Qwen's exact analogue of Claude's `esc to interrupt`.
- **Tool-approval prompt** (the `panePrompt` analogue), default approval mode:
  ```
  ? WriteFile Writing to notes.txt ←
   1 SPIKE_NOTE_2
   Apply this change?
   › 1. Yes, allow once
     2. Yes, allow always
     3. No, suggest changes (esc)
  ⠏ Waiting for user confirmation...
  ```
  Stable tokens: `Apply this change?`, `› 1. Yes, allow once`, `Waiting for user confirmation...`.
  Approve by injecting the option number + `Enter`.
- **Approval mode matters.** These prompts appear only in `tools.approvalMode:"default"`. The host's
  pre-existing global `~/.qwen/settings.json` had `approvalMode:"auto"` + `autoAccept:true`, which
  **auto-runs tools with no prompt**. Turma launches must pin the approval mode they intend
  (workspace settings override user settings, confirmed).

### 5. Hard-deny guard — PASS (with a real gotcha)

- Qwen's hook contract is **Claude Code's, ported** (`bundled/qc-helper/docs/features/hooks.md`):
  `hooks.PreToolUse[].{matcher,hooks[]}`; a `command` hook returns
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
  "permissionDecisionReason":"…"}}` on stdout, or **exit code 2** (blocking error, stderr → model).
  `permissionDecision` ∈ `allow|deny|ask`; in headless/subagent contexts `ask` falls back to `deny`.
- Proven: a PreToolUse hook denying `run_shell_command` fired **before execution**; the tool never
  ran (the `whoami`/`uname` never executed — 0 hits in the transcript), and the model explicitly
  said it *"can't run it, and won't route around the denial through another path."* **Model cannot
  bypass.** Deny reason is surfaced in the pane (`x Shell … / SPIKE-GUARD: … hard-denied by policy`)
  and to the model.
- Hook stdin is rich (sample: `docs/qwen-g0/recipe/pretooluse-hook-input.sample`): `tool_name`,
  `tool_input`, `tool_use_id`, `tool_call_id`, `session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, `permission_mode`, `timestamp` — enough to port Turma's
  `_GUARD_DENY_*` policy directly.
- **GOTCHA — `timeout` is MILLISECONDS (default 60000).** The first attempt set `"timeout": 10`
  meaning it, thinking seconds — the hook was killed after 10 ms, failed open, and the tool RAN. The
  guard is only as strong as this field: a too-small timeout silently disables it. The drive/guard
  child must set a realistic ms value and treat a hook-runner timeout as **deny**, not allow.
- `disableAllHooks:true` and `--safe-mode` both disable hooks — neither may be set on a guarded
  launch. Folder-trust gates workspace hooks; Turma controls the worktree so this is a launch-config
  decision.

### 6. OpenAI-compatible endpoint — PASS

Three interchangeable ways to point Qwen at an arbitrary OpenAI-compatible endpoint, all proven
against the LiteLLM gateway:

- **Env (the ticket's form):** `OPENAI_BASE_URL` + `OPENAI_API_KEY` + `OPENAI_MODEL` with
  `--auth-type openai`. Works even under `--safe-mode`.
- **Flags:** `--openai-base-url` + `--openai-api-key` + `-m <model>` + `--auth-type openai`.
- **Settings:** `modelProviders.openai:[{id,baseUrl,envKey,generationConfig{contextWindowSize}}]` +
  `security.auth.selectedType:"openai"` (what the host was already configured with).
- **Credential discipline (carry over from local-model-failover):** put the key in the environment,
  **never in argv** — `/proc/<pid>/cmdline` is world-readable. Use `OPENAI_API_KEY`/`envKey`, not
  `--openai-api-key`, on a shared host. `contextWindowSize`/`CLAUDE_CODE_MAX_CONTEXT_TOKENS`-style
  window sizing applies here too (`generationConfig.contextWindowSize`, 262144 for this model).

## Additional findings the epic should build on

- **Auto-update is a trap for a pinned fleet.** Qwen checks for and **auto-installs** updates on
  launch (it upgraded `0.22.2 → 0.22.3` mid-spike: *"Attempting to automatically update now… Update
  successful! The new version will be used on your next run."*). A fleet pinned to a version and a
  corpus **must** disable it: `general.disableAutoUpdate:true` (and `general.disableUpdateNag:true`),
  or env `QWEN_CODE_SKIP_UPDATE_CHECK_ONCE`. Otherwise the binary drifts under the parsers.
- **A cleaner parse channel than the pane exists: `--json-file <path>` / `--json-fd <n>`** —
  "dual output mode": the TUI renders normally on stdout while **structured JSON events** are written
  to the file/fd. For liveness and turn/tool structure this is more robust than `capture-pane`
  scraping; the pane parse (crit. 4) remains the fallback and the source for the human terminal.
  The drive child should prototype `--json-file` for the machine-readable stream and keep pane
  parsing only for what that stream omits.
- **Tools are DEFERRED (two-step).** The model first calls `tool_search {query:"select:write_file"}`,
  then the real tool. A tool_use parser (PR attribution, etc.) must look past the `tool_search`
  call to the actual `functionCall.name` (`write_file`, `run_shell_command`, …).
- **Live session registry:** `<id>.runtime.json` (`schema_version, pid, session_id, work_dir,
  hostname, started_at, qwen_version`) + `qwen sessions ps` / `qwen sessions list` — a native
  answer for "is this session's process alive" without pane heuristics.
- **`--json-schema`, `--max-wall-time`, `--max-tool-calls`, `--max-session-turns`** exist for
  bounded headless runs (exit code 55 on budget breach) — useful for ticket/summary side-turns.
- **`--worktree` is built in** (`<repoRoot>/.qwen/worktrees/<slug>/`), but Turma manages its own
  worktrees under `.turma/worktrees`; do not use Qwen's, to keep one worktree model.

## The projection story (D3 analogue) looks cheap

Qwen's native events map almost 1:1 to Claude Code JSONL, so a `DshProjector`-style
`QwenProjector` should be small:

| Qwen event | → Claude JSONL |
|---|---|
| `type:user`, `message.parts:[{text}]` | `user` message |
| `type:assistant`, `parts:[{text}]` | `assistant` text |
| `parts:[{text,thought:true}]` | thinking block |
| `parts:[{functionCall:{id,name,args}}]` | `tool_use` |
| `type:tool_result`, `functionResponse:{id,name,response:{output|error}}` | `tool_result` (id-linked) |
| `assistant.usageMetadata` / `.model` | `usage` / `model` |
| `system` (attribution/file_history/ui_telemetry/slash_command) | log-only → `[]` |

uuid/parentUuid, sessionId, cwd, timestamp, version are already present on every row.

## Reproduce it (recipe)

Full env-specific driver is not committed (the endpoint is host-specific); the steps and configs
are. `docs/qwen-g0/recipe/` holds `workspace-settings.json`, `deny.py`, `qwen-help.txt`,
`runtime.json.sample`, `pretooluse-hook-input.sample`.

```bash
# 1. endpoint (env; key never in argv on a shared host)
export OPENAI_BASE_URL=https://lite.xerktech.com/v1
export OPENAI_API_KEY=…            # the LiteLLM gateway key
export OPENAI_MODEL=qwen3.8-27b-dflash
# 2. a worktree with .qwen/settings.json (approvalMode default + PreToolUse deny hook + chatRecording
#    on + disableAutoUpdate) and .qwen/hooks/deny.py — see docs/qwen-g0/recipe/
# 3. pin an id and launch the interactive TUI in tmux (isolated -L socket; never touch agent-* tmux)
SID=$(uuidgen)
tmux -L qwenspike new-session -d -s q -x 200 -y 55
tmux -L qwenspike send-keys -t q "cd <worktree> && qwen --auth-type openai --session-id $SID" Enter
# 4. drive: send-keys "<prompt>" + Enter; capture-pane -p to read busy/approval; send "1"+Enter to approve
# 5. resume: qwen --auth-type openai --resume $SID  (same <id>.jsonl, context intact)
```

## Escalations / open questions for Malcolm

None block the GO. Recorded for the epic:

1. **Model quality is out of scope here** (as with local-model-failover): this spike proves the
   *harness/drive model*, not that `qwen3.8-27b-dflash` is a good coding model. The routing/model
   bake-off is separate (`docs/local-model-failover.md`, `bench/`).
2. **Pin + auto-update policy** needs a fleet decision: which Qwen version to pin, and setting
   `general.disableAutoUpdate` on every host so the corpus/parsers stay valid.
3. **`--json-file` vs pane parsing** is a drive-child design call: prefer the structured stream for
   liveness/structure, keep pane parse as the fallback. Both are proven-viable here.
