#!/usr/bin/env node
// Reverse-tunnel client for the turma terminal gateway (compose/claude-code.yaml).
//
// Runs in the background of every Turma agent (started by the native launcher
// agent/native/turma-agent) alongside hub-agent.py — ONE control channel per host, keyed
// by the host name. It keeps a persistent OUTBOUND WebSocket to the hub's
// control endpoint. When a browser opens a session's terminal in the Turma,
// the hub sends {"open":<ch>,"port":<ttydPort>} on that control channel; we then
// dial back a data WebSocket for <ch> and bridge it to THAT session's local ttyd
// (127.0.0.1:<port>). The host multiplexes N per-session ttyds (one per port,
// allocated from TTYD_PORT_BASE by the manager); data channels fan out to them
// by port while the single control channel stays per-host. Because every
// connection here is outbound to TURMA_URL, the hub and this container can live on
// different hosts/networks — no inbound reachability required.
//
// Zero dependencies: Node's built-in global WebSocket does all client-side
// framing/masking; we only shovel bytes between it and a net.Socket.

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, execFile } = require("child_process");

const TURMA_URL = process.env.TURMA_URL || "http://turma:8300";
// Same agent token hub-agent.py heartbeats with (the hub's TURMA_AGENT_TOKEN).
// Sent as a query param because the browser-style WebSocket client can't set
// an Authorization header.
const TOKEN = process.env.TURMA_TOKEN || "";
const TTYD_HOST = "127.0.0.1";
// Fallback ttyd port when the hub doesn't specify one in the open message
// (safety only — the multiplexed sessions always send their own port).
const DEFAULT_TTYD_PORT = 7681;

// ---- live transcript tail ---------------------------------------------------
// The near-real-time path for the glasses' session screen. When a glasses
// client is watching a session, the hub sends {"watch":<sessionId>,
// "worktreePath":<path>,"transcriptId":<id>} on the control channel — the id
// naming which transcript in that cwd's project dir is the session's own (see
// sessionTranscript). We then tail that ONE transcript every LIVE_TAIL_MS and
// push {"tail":<sessionId>,"entries":[...]} deltas straight back on the same
// control channel (the hub fans them out to the watching glasses).
// {"unwatch":<sessionId>} stops it. Tailing runs only while a session is
// actively watched, so idle sessions cost nothing.
//
// The transcript read here is a deliberate re-implementation of hub-agent.py's
// transcript_tail / _entry_text / _project_slug (same entry->text mapping,
// ordering and dedup so the glasses get the same entries whether they arrive
// via this fast path or the 20s heartbeat). The one intentional difference:
// this live path keeps the FULL per-message text (TAIL_MSG_CHARS below mirrors
// the Python reading paths' TAIL_MSG_CHARS_FULL, not the heartbeat's smaller
// per-message preview). If that Python changes shape, change this too.
//
// entryBlocks() below is the same story: a line-for-line mirror of hub-agent.py
// _entry_blocks(), the rich block feed the native chat UI renders (thinking,
// tool inputs, tool outputs that entryText flattens away). entryText stays the
// lossy backward-compat contract (glasses + heartbeat preview); entryBlocks is
// the additive rich contract. Both must be changed in lockstep.
const PROJECTS_ROOT = process.env.CLAUDE_PROJECTS_ROOT || "/root/.claude/projects";
const LIVE_TAIL_MS = Number(process.env.LIVE_TAIL_MS) || 1000;
const TAIL_MSGS = Number(process.env.SESSION_TAIL_MSGS) || 30;
// The live tail only runs while a glasses client is watching one session, so it
// carries the full message text — a long assistant response must not arrive cut
// off mid-sentence. The heartbeat's transcript_tail ships a smaller per-message
// preview (SESSION_TAIL_MSG_CHARS); the glasses keep whichever copy is longer.
const TAIL_MSG_CHARS = Number(process.env.SESSION_TAIL_MSG_CHARS_FULL) || 16000;
const TAIL_READ_BYTES = 1 << 17; // ~128 KB, matches _tail_entries
const MAX_WATCHERS = 16; // safety cap on concurrent live tails
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

// dsh (DeepSeek Harness) sessions (XERK-460) have no Claude TUI pane to scrape
// for the live in-progress turn, but their native event log carries the raw LLM
// stream as `assistant/chunk` deltas. Tunnel-agent folds those deltas into the
// same `turn` frame a Claude pane scrape produces, so the chat page streams a
// dsh response as it generates instead of only when the whole `assistant/message`
// commits. The events file nests at <slug>/<transcriptId>/<dsh>/events.jsonl —
// the same <tid>/dsh/ nest hub-agent.py's _launch_dsh writes and the raw archive
// walk retains (dsh.md [E]). The path is mirrored here, not shared, because the
// hub-agent.py and this JS tail are separate processes; keep it in lockstep with
// _launch_dsh. A claude session never writes this nest, so its presence is what
// tells the watcher a session is dsh (no protocol/hub change needed).
const DSH_STORE_DIRNAME = "dsh";
const DSH_EVENTS_FILE = "events.jsonl";
// Cap the accumulated live stream text so a long generated message can't build
// an unbounded chat frame. The committed `assistant/message` (which the dsh
// projection writes in full to the transcript) supersedes it the moment the turn
// ends, so a live cap clips neither history nor the final rendering.
const DSH_LIVE_TEXT_CHARS = Number(process.env.DSH_LIVE_TEXT_CHARS) || 16000;

// Rich-block caps for the live tail — mirror hub-agent.py BLOCK_CAPS, which is
// the SAME set the on-demand `history` read uses (XERK-347): the live path used
// to clip to a quarter of what history returned, and the chat put a "Show more…"
// button on every block cut that way. A frame is bounded by the ~128 KB
// transcript window it is parsed from (TAIL_READ_BYTES), not by these numbers,
// so the tighter live caps bought nothing but that button. A block cut to its
// cap is still flagged truncated.
const BLOCK_TEXT_CHARS = Number(process.env.SESSION_BLOCK_TEXT_CHARS) || 100000;
const BLOCK_TOOL_INPUT_CHARS = Number(process.env.SESSION_BLOCK_TOOL_INPUT_CHARS) || 4000;
const BLOCK_TOOL_RESULT_CHARS = Number(process.env.SESSION_BLOCK_TOOL_RESULT_CHARS) || 8000;
const BLOCK_MAX_PER_ENTRY = Number(process.env.SESSION_BLOCK_MAX_PER_ENTRY) || 48;
const BLOCK_CAPS = {
  text: BLOCK_TEXT_CHARS,
  input: BLOCK_TOOL_INPUT_CHARS,
  result: BLOCK_TOOL_RESULT_CHARS,
};
// SendUserFile inline-preview embedding (XERK-221) — mirror hub-agent.py's
// SEND_FILE_* constants exactly (the block shape must match byte-for-byte).
const SEND_FILE_MAX_FILES = Number(process.env.SESSION_SEND_FILE_MAX_FILES) || 16;
const SEND_FILE_MAX_BYTES = Number(process.env.SESSION_SEND_FILE_MAX_BYTES) || 512 * 1024;
const SEND_FILE_IMG_MIME = {
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
};
const SEND_FILE_HTML_EXT = new Set([".html", ".htm"]);

// Claude Code's project-dir slug for a worktree cwd: every non-alphanumeric
// char -> '-' (mirrors hub-agent.py _project_slug — a plain '/'->'-' map is
// wrong for the dotted worktree paths this agent uses).
function projectSlug(p) {
  return p.replace(/[^A-Za-z0-9]/g, "-");
}

// The transcript to tail for a watched session: the one the hub named
// (<transcriptId>.jsonl in the session cwd's project-slug dir), else the newest
// in that dir. Null when the named one doesn't exist yet, or when there is
// nothing in the dir at all.
//
// The id is what makes a repos-root session tail its OWN conversation: every
// root session shares REPOS_ROOT as its cwd, hence one project dir, so newest-
// mtime hands a fresh root session the previous one's transcript (XERK-6). A
// named-but-absent file means the session hasn't spoken yet — never fall back to
// newest there, that IS the bug. A hub predating the pin sends no id, leaving
// the newest-mtime rule it always used. Mirrors _session_transcript_path in
// hub-agent.py.
function sessionTranscript(worktreePath, transcriptId) {
  if (!transcriptId) return newestTranscript(worktreePath);
  // Same containment argument as newestTranscript's slug, applied to the id: a
  // path can only be built from a plain uuid-ish word, so it names a child of
  // the slug dir and nothing else.
  if (!/^[A-Za-z0-9-]+$/.test(transcriptId)) return null;
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const p = path.join(PROJECTS_ROOT, projectSlug(worktreePath), `${transcriptId}.jsonl`);
  return fs.existsSync(p) ? p : null;
}

// Newest *.jsonl transcript for a worktree (its project-slug dir), or null.
function newestTranscript(worktreePath) {
  // Not path-traversable: projectSlug() rewrites EVERY non-alphanumeric char
  // (including '/' and '.') to '-', so the slug is a single flat path
  // component with no separators or '..' — it can only ever name a child of
  // PROJECTS_ROOT.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const dir = path.join(PROJECTS_ROOT, projectSlug(worktreePath));
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  let newest = null;
  let newestMtime = 0;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    // `name` is a single directory entry from readdirSync (never contains a
    // path separator), so this stays inside `dir`.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const full = path.join(dir, name);
    let mtime;
    try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
    if (mtime > newestMtime) { newest = full; newestMtime = mtime; }
  }
  return newest;
}

// Non-empty trimmed lines from roughly the last maxBytes of a file. The
// leading line may be a mid-line fragment; JSON.parse rejects it and the
// caller skips it, exactly like hub-agent.py _read_tail_lines.
function readTailLines(p, maxBytes) {
  let fd;
  try { fd = fs.openSync(p, "r"); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString("utf8").split("\n").map((l) => l.trim()).filter((l) => l.length);
  } catch {
    return [];
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// A background Task/agent finishing injects a `<task-notification>…` payload as
// a user-role turn — an XML-ish blob carrying <summary>, <status> and the
// child's <result>. Parsed into {summary, status, result} (or null when it
// isn't one) so it renders as an action card instead of raw XML. Mirror of
// hub-agent.py _parse_task_notification.
const TASK_NOTIFICATION_RE = /^\s*<task-notification>([\s\S]*)<\/task-notification>\s*$/;
// Literal (not dynamically-built) per-tag regexes — a hardcoded regex sidesteps
// the ReDoS surface of new RegExp(`<${name}>…`) and keeps the tag set closed.
const TN_TAG_RE = {
  summary: /<summary>([\s\S]*?)<\/summary>/,
  status: /<status>([\s\S]*?)<\/status>/,
  result: /<result>([\s\S]*?)<\/result>/,
  "task-id": /<task-id>([\s\S]*?)<\/task-id>/,
};
function tnTag(name, body) {
  const re = TN_TAG_RE[name];
  const m = re ? re.exec(body) : null;
  return m ? m[1].replace(ANSI_RE, "").trim() : "";
}
function parseTaskNotification(text) {
  if (!text) return null;
  const m = TASK_NOTIFICATION_RE.exec(text);
  if (!m) return null;
  const body = m[1];
  // `taskId` is what makes this a usable STOPPED edge for the live-agent scan,
  // not just display text (XERK-245). Mirrors _parse_task_notification.
  return { summary: tnTag("summary", body), status: tnTag("status", body),
           result: tnTag("result", body), taskId: tnTag("task-id", body) };
}
// Flatten a parsed task-notification to text-feed form (summary + result) —
// mirror of hub-agent.py _tn_preview.
function tnPreview(tn) {
  const parts = [tn.summary || tn.status || "background task update"];
  if (tn.result) parts.push(tn.result);
  return parts.filter(Boolean).join("\n\n");
}

// Claude Code's slash-command bookkeeping turns (the ignore-this caveat, the
// <command-name>/<command-args> invocation wrapper, and the command's
// stdout/stderr) also land as user-role turns of raw XML. Parse them into
// {kind:"caveat"|"command"|"output"} so entryBlocks can render a chip / output
// card and drop the caveat. Mirror of hub-agent.py _parse_local_command.
const LOCAL_COMMAND_CAVEAT_RE = /^\s*<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*$/;
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_STDOUT_RE = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;
const COMMAND_STDERR_RE = /<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/;
// The `!` prefix runs a shell command straight from the composer/TUI; Claude
// Code records the command as <bash-input> and its output as
// <bash-stdout>/<bash-stderr> user turns. Parsed into the same
// command/output shapes (name "!") so the chat renders a chip + output card
// instead of raw XML. Mirror of hub-agent.py BASH_*_RE.
const BASH_INPUT_RE = /<bash-input>([\s\S]*?)<\/bash-input>/;
const BASH_STDOUT_RE = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/;
const BASH_STDERR_RE = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/;
function parseLocalCommand(text) {
  if (!text) return null;
  if (LOCAL_COMMAND_CAVEAT_RE.test(text)) return { kind: "caveat" };
  const nameM = COMMAND_NAME_RE.exec(text);
  if (nameM) {
    const name = nameM[1].replace(ANSI_RE, "").trim();
    if (name) {
      const argsM = COMMAND_ARGS_RE.exec(text);
      return { kind: "command", name, args: argsM ? argsM[1].replace(ANSI_RE, "").trim() : "" };
    }
  }
  const bashM = BASH_INPUT_RE.exec(text);
  if (bashM) {
    const cmd = bashM[1].replace(ANSI_RE, "").trim();
    if (cmd) return { kind: "command", name: "!", args: cmd };
  }
  // stderr wins over stdout when a turn carries both — but ONLY when it
  // carries text: a bash turn routinely ships both tags with one empty, and an
  // empty stderr must not swallow the stdout beside it (or vice versa).
  let first = null;
  for (const [re, isError] of [[COMMAND_STDERR_RE, true], [BASH_STDERR_RE, true],
    [COMMAND_STDOUT_RE, false], [BASH_STDOUT_RE, false]]) {
    const m = re.exec(text);
    if (m) {
      const out = { kind: "output", text: m[1].replace(ANSI_RE, "").trim(), isError };
      if (out.text) return out;
      if (!first) first = out;
    }
  }
  return first;
}
// Flatten a parsed local-command turn to text-feed form, or null to drop it —
// mirror of hub-agent.py _lc_preview.
function lcPreview(lc) {
  if (lc.kind === "caveat") return null;
  if (lc.kind === "command") return [lc.name, lc.args].filter(Boolean).join(" ");
  return lc.text || null;
}

// The tool_use id this user turn was PRODUCED BY, or null — mirror of
// hub-agent.py _entry_tool_source, where the reasoning lives. Claude Code
// writes a skill's body back as a user turn tagged with the id of the `Skill`
// tool_use that pulled it in; on a user turn that field means the tooling
// authored the entry, not the operator, so it is really that call's result.
function entryToolSource(entry) {
  if (entry.type !== "user") return null;
  return entry.sourceToolUseID || null;
}

// The entry's first raw text payload (string content, or the first `text` block
// of list content), or "" — mirror of hub-agent.py _entry_first_text.
function entryFirstText(entry) {
  const msg = entry.message;
  if (!msg || typeof msg !== "object") return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "text") return String(block.text || "");
    }
  }
  return "";
}

// Pressing Esc (or the hub's Stop) mid-turn writes a user-role "[Request
// interrupted by user…]" marker entry — a statement about the turn, not
// something the operator typed. Mirror of hub-agent.py INTERRUPT_RE.
const INTERRUPT_RE = /^\s*\[Request interrupted by user[^\]\n]*\]\s*$/;

// Claude Code's "while you were away" recap: a `system` entry (subtype
// "away_summary") whose content the model wrote. Every other system subtype is
// TUI bookkeeping and stays dropped; the trailing "(disable recaps in
// /config)" hint is a TUI affordance and is stripped. Mirror of hub-agent.py
// _away_summary_text.
const AWAY_HINT_RE = /\s*\(disable recaps in \/config\)\s*$/;
function awaySummaryText(entry) {
  if (entry.type !== "system" || entry.subtype !== "away_summary") return null;
  const text = String(entry.content || "").replace(ANSI_RE, "").replace(AWAY_HINT_RE, "").trim();
  return text || null;
}

// Display role for an entry — mirror of hub-agent.py _entry_role. A compact
// summary is written as a USER turn carrying text the model wrote about itself;
// it reports as the assistant so the chat doesn't misattribute it to the human.
// A system entry only ever survives the feeds as an away_summary recap, which
// the model also wrote — same rule.
function entryRole(entry) {
  if (entry.isCompactSummary) return "assistant";
  if (entry.type === "system") return "assistant";
  return entry.type;
}

// One text payload -> its text-feed form, or null to drop it. Mirror of
// hub-agent.py _flatten_text.
function flattenText(raw) {
  const tn = parseTaskNotification(raw);
  if (tn) return tnPreview(tn);
  const lc = parseLocalCommand(raw);
  if (lc) return lcPreview(lc);
  return raw;
}

// One transcript entry -> glasses display text, or null to drop it (wrong
// type, no message, tool_result-only turn, empty after ANSI strip). Mirrors
// hub-agent.py _entry_text.
function entryText(entry) {
  const away = awaySummaryText(entry);
  if (away !== null) return away;
  const type = entry.type;
  if (type !== "user" && type !== "assistant") return null;
  const msg = entry.message;
  if (!msg || typeof msg !== "object") return null;
  // Tool-authored: a tool_result by another name, and this feed drops those.
  if (entryToolSource(entry)) return null;
  const content = msg.content;
  let text;
  if (typeof content === "string") {
    text = flattenText(content);
    if (text === null) return null;
  } else if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text") {
        const flat = flattenText(String(block.text || ""));
        if (flat !== null) parts.push(flat);
      } else if (block.type === "tool_use" && block.name) parts.push(`[${block.name}]`);
      // "thinking" and "tool_result" blocks are dropped.
    }
    text = parts.join("");
  } else {
    return null;
  }
  text = text.replace(ANSI_RE, "").trim();
  return text || null;
}

// The entry's own uuid, or a synthesized stable id for the entry types Claude
// Code writes WITHOUT one (pr-link): the chat's tail merge dedups on id and
// drops id-less entries. Mirror of hub-agent.py _entry_id.
//
// A pr-link keys on its URL ALONE, deliberately excluding the timestamp: Claude
// Code re-stamps a session's PR links in the metadata preamble it writes at the
// top of every user turn, so one PR yields ~6 entries differing only in
// `timestamp`. Sharing an id collapses them to the first — where the PR landed.
function entryId(entry) {
  if (entry.uuid) return entry.uuid;
  if (entry.type === "pr-link") return `pr-link:${entry.prUrl || ""}`;
  return undefined;
}

// (clipped, wasTruncated). Mirror of hub-agent.py _clip.
function clip(text, cap) {
  text = text || "";
  if (text.length > cap) return [text.slice(0, cap), true];
  return [text, false];
}

// Common Claude Code tools carry their salient arg under one of these keys.
const TOOL_INPUT_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "prompt",
  "skill", "subject"];

// Compact display string for a tool_use `input` — mirror of _tool_input_summary.
// An AskUserQuestion call's salient arg is the question text itself, nested in
// its `questions` list — joined so the card reads as the question(s) asked.
function toolInputSummary(inp) {
  if (inp && typeof inp === "object" && !Array.isArray(inp)) {
    if (Array.isArray(inp.questions)) {
      const texts = inp.questions
        .map((q) => (q && typeof q === "object" && typeof q.question === "string") ? q.question.trim() : "")
        .filter(Boolean);
      if (texts.length) return texts.join(" · ");
    }
    for (const key of TOOL_INPUT_KEYS) {
      const val = inp[key];
      if (typeof val === "string" && val.trim()) return val;
    }
    try { return JSON.stringify(inp); } catch { return String(inp); }
  }
  if (typeof inp === "string") return inp;
  if (inp == null) return "";
  return String(inp);
}

// Read the image/SVG/HTML files a SendUserFile call delivered and return preview
// entries for its tool_use block (XERK-221), or null. Mirror of hub-agent.py
// _send_user_file_detail(): image -> {name, kind:"image", src:data URI};
// html (render only) -> {name, kind:"html", html}; else -> {name, kind:"file"}.
function sendUserFileDetail(inp) {
  const files = inp.files;
  if (!Array.isArray(files) || !files.length) return null;
  const display = inp.display;
  const out = [];
  for (const p of files.slice(0, SEND_FILE_MAX_FILES)) {
    if (typeof p !== "string" || !p) continue;
    const name = path.basename(p);
    const ext = path.extname(p).toLowerCase();
    const mime = SEND_FILE_IMG_MIME[ext];
    const renderHtml = SEND_FILE_HTML_EXT.has(ext) && display !== "attach";
    let entry = { name, kind: "file" };
    if (mime || renderHtml) {
      try {
        if (fs.statSync(p).size <= SEND_FILE_MAX_BYTES) { // bound the read (mirrors Python's read(cap+1))
          const data = fs.readFileSync(p);
          if (data.length <= SEND_FILE_MAX_BYTES) {
            entry = mime
              ? { name, kind: "image", src: "data:" + mime + ";base64," + data.toString("base64") }
              : { name, kind: "html", html: data.toString("utf8") };
          }
        }
      } catch { /* unreadable / gone → name chip */ }
    }
    out.push(entry);
  }
  return out.length ? out : null;
}

// Attach the reviewable payload of a known tool call to its tool_use block —
// the part an operator otherwise opens the raw terminal to see. Returns true
// when a payload was clipped by its cap. Mirror of hub-agent.py
// _tool_use_detail(): Edit -> edit {old, new, replaceAll?}; Write -> content;
// A TodoWrite/todo_write snapshot -> a sanitized, capped [{content, status,
// activeForm?}] the chat renders as a checklist. Mirror of hub-agent.py
// _todo_items(): Claude's TodoWrite and dsh's todo_write share the whole-list
// {content, status} shape (dsh has no activeForm), both write a fresh snapshot
// per call (last-wins). Bounded so a hostile/oversized list can't bloat a frame.
const TODO_ITEMS_MAX = 100;
const TODO_STATUSES = ["pending", "in_progress", "completed"];
function todoItems(raw, caps) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const it of raw.slice(0, TODO_ITEMS_MAX)) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const content = it.content;
    if (typeof content !== "string" || !content.trim()) continue;
    let status = it.status;
    if (!TODO_STATUSES.includes(status)) status = "pending";
    const item = { content: clip(content.replace(ANSI_RE, "").trim(), caps.input)[0], status };
    if (typeof it.activeForm === "string" && it.activeForm.trim()) {
      item.activeForm = clip(it.activeForm.replace(ANSI_RE, "").trim(), caps.input)[0];
    }
    out.push(item);
  }
  return out.length ? out : null;
}

// ExitPlanMode -> plan; SendUserFile -> files + caption (inline preview);
// TodoWrite/todo_write -> todos (checklist); any tool's `description` arg -> desc.
function toolUseDetail(block, name, inp, caps) {
  if (!inp || typeof inp !== "object" || Array.isArray(inp)) return false;
  let truncated = false;
  if (name === "Edit") {
    const old = inp.old_string, nw = inp.new_string;
    if (typeof old === "string" || typeof nw === "string") {
      const [oldC, oldT] = clip(String(old || "").replace(ANSI_RE, ""), caps.result);
      const [newC, newT] = clip(String(nw || "").replace(ANSI_RE, ""), caps.result);
      const edit = { old: oldC, new: newC };
      if (inp.replace_all) edit.replaceAll = true;
      block.edit = edit;
      truncated = oldT || newT;
    }
  } else if (name === "Write") {
    if (typeof inp.content === "string" && inp.content.trim()) {
      const [clipped, trunc] = clip(inp.content.replace(ANSI_RE, ""), caps.result);
      block.content = clipped;
      truncated = trunc;
    }
  } else if (name === "ExitPlanMode") {
    if (typeof inp.plan === "string" && inp.plan.trim()) {
      const [clipped, trunc] = clip(inp.plan.replace(ANSI_RE, "").trim(), caps.text);
      block.plan = clipped;
      truncated = trunc;
    }
  } else if (name === "SendUserFile") {
    const files = sendUserFileDetail(inp);
    if (files) {
      block.files = files;
      if (typeof inp.caption === "string" && inp.caption.trim()) {
        block.caption = clip(inp.caption.replace(ANSI_RE, "").trim(), caps.input)[0];
      }
    }
  } else if (name === "TodoWrite" || name === "todo_write") {
    const todos = todoItems(inp.todos, caps);
    if (todos) block.todos = todos;
  }
  if (typeof inp.description === "string" && inp.description.trim()) {
    block.desc = clip(inp.description.replace(ANSI_RE, "").trim(), caps.input)[0];
  }
  return truncated;
}

// Flatten a tool_result block's `content` to text — mirror of _tool_result_text.
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        if (block.type === "text") parts.push(String(block.text || ""));
        else if (block.type === "image") parts.push("[image]");
        // A ToolSearch result names the tools it loaded as tool_reference
        // blocks; flattening them away left the call's output card empty.
        else if (block.type === "tool_reference") parts.push(`\n[tool: ${block.tool_name || "tool"}]`);
      } else if (typeof block === "string") {
        parts.push(block);
      }
    }
    return parts.join("");
  }
  if (content == null) return "";
  return String(content);
}

// Rich, order-preserving block list for one transcript entry, or null to drop
// it (wrong type / no message object). Additive companion to entryText —
// preserves thinking / tool_use inputs / tool_result outputs that entryText
// flattens away. `caps` is {text, input, result}. A block cut to its cap gets
// truncated:true. Returns [] for a user/assistant message with no renderable
// blocks. Line-for-line mirror of hub-agent.py _entry_blocks — keep in lockstep.
function entryBlocks(entry, caps) {
  // The "while you were away" recap becomes its own block (assistant-side
  // card); all other system entries still drop. Mirror of _entry_blocks.
  const away = awaySummaryText(entry);
  if (away !== null) {
    const [clipped, trunc] = clip(away, caps.text);
    const block = { t: "away_summary", text: clipped };
    if (trunc) block.truncated = true;
    return [block];
  }
  // A compaction that RAN (trigger + before/after token counts) becomes a
  // status marker; a pr-link entry (Claude Code's own record of a PR it
  // opened) becomes a pr_link marker. Mirror of _entry_blocks.
  if (entry.type === "system" && entry.subtype === "compact_boundary") {
    const meta = entry.compactMetadata || {};
    const block = { t: "compact_boundary" };
    if (typeof meta.trigger === "string" && meta.trigger) block.trigger = meta.trigger;
    if (Number.isInteger(meta.preTokens)) block.preTokens = meta.preTokens;
    if (Number.isInteger(meta.postTokens)) block.postTokens = meta.postTokens;
    return [block];
  }
  if (entry.type === "pr-link") {
    if (typeof entry.prUrl !== "string" || !entry.prUrl) return null;
    const block = { t: "pr_link", url: entry.prUrl };
    if (Number.isInteger(entry.prNumber)) block.number = entry.prNumber;
    if (typeof entry.prRepository === "string" && entry.prRepository) block.repo = entry.prRepository;
    return [block];
  }
  const type = entry.type;
  if (type !== "user" && type !== "assistant") return null;
  const msg = entry.message;
  if (!msg || typeof msg !== "object") return null;
  const content = msg.content;

  // A skill body is the result of the Skill call that pulled it in: emit it as
  // that call's tool_result so the chat folds it into the action card. Ahead of
  // the content walk — the body arrives as an ordinary text block.
  const toolSrc = entryToolSource(entry);
  if (toolSrc) {
    const text = entryFirstText(entry).replace(ANSI_RE, "").trim();
    const [clipped, trunc] = clip(text, caps.result);
    const block = { t: "tool_result", text: clipped, forId: toolSrc };
    if (trunc) block.truncated = true;
    return [block];
  }

  const blocks = [];
  const addText = (kind, text, cap) => {
    text = String(text || "").replace(ANSI_RE, "").trim();
    if (!text) return;
    const [clipped, trunc] = clip(text, cap);
    const block = { t: kind, text: clipped };
    if (trunc) block.truncated = true;
    blocks.push(block);
  };
  const addTaskNotification = (tn) => {
    const [summary] = clip(tn.summary, caps.input);
    const [result, rtrunc] = clip(tn.result, caps.result);
    const block = { t: "task_notification", summary };
    if (tn.status) block.status = tn.status;
    if (result) block.result = result;
    if (rtrunc) block.truncated = true;
    blocks.push(block);
  };
  // The caveat contributes no block (its entry drops out entirely).
  const addLocalCommand = (lc) => {
    if (lc.kind === "command") {
      const [name] = clip(lc.name, caps.input);
      const [args, atrunc] = clip(lc.args, caps.input);
      const block = { t: "command", name };
      if (args) block.args = args;
      if (atrunc) block.truncated = true;
      blocks.push(block);
    } else if (lc.kind === "output" && lc.text) {
      const [text, trunc] = clip(lc.text, caps.result);
      const block = { t: "command_output", text };
      if (lc.isError) block.isError = true;
      if (trunc) block.truncated = true;
      blocks.push(block);
    }
  };
  // One text payload -> its block(s): a task-notification card, a slash-command
  // chip/output card, else plain text. A compact summary is prose the model
  // wrote about the conversation so far, injected as a user turn — it gets its
  // own block so the chat renders it as a collapsed agent-side card rather than
  // a wall of text in a user bubble. entryRole() puts it on the assistant side.
  const addPayload = (raw) => {
    const tn = parseTaskNotification(raw);
    if (tn) return addTaskNotification(tn);
    const lc = parseLocalCommand(raw);
    if (lc) return addLocalCommand(lc);
    // An interrupt marker is a statement about the turn, not operator prose.
    if (INTERRUPT_RE.test(raw)) {
      blocks.push({ t: "interrupt", text: String(raw).replace(ANSI_RE, "").trim() });
      return;
    }
    addText(entry.isCompactSummary ? "compact_summary" : "text", raw, caps.text);
  };
  if (typeof content === "string") {
    addPayload(content);
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue;
      if (raw.type === "text") {
        addPayload(raw.text || "");
      } else if (raw.type === "thinking") {
        addText("thinking", raw.thinking || raw.text || "", caps.text);
      } else if (raw.type === "tool_use" && raw.name) {
        const summary = toolInputSummary(raw.input).replace(ANSI_RE, "").trim();
        const [clipped, trunc] = clip(summary, caps.input);
        const block = { t: "tool_use", name: String(raw.name), input: clipped };
        if (raw.id) block.id = raw.id;
        if (trunc) block.truncated = true;
        if (toolUseDetail(block, String(raw.name), raw.input, caps)) block.truncated = true;
        blocks.push(block);
      } else if (raw.type === "tool_result") {
        const text = toolResultText(raw.content).replace(ANSI_RE, "").trim();
        const [clipped, trunc] = clip(text, caps.result);
        const block = { t: "tool_result", text: clipped };
        if (raw.tool_use_id) block.forId = raw.tool_use_id;
        if (raw.is_error) block.isError = true;
        if (trunc) block.truncated = true;
        blocks.push(block);
      }
      if (blocks.length >= BLOCK_MAX_PER_ENTRY) break;
    }
  } else {
    return null;
  }
  return blocks;
}

// The prompt queue: a message typed mid-turn is enqueued, and Claude Code
// records the queue's life as `queue-operation` transcript entries (enqueue
// carries the text; dequeue pops the OLDEST into a real user turn; remove
// withdraws one by content). Folded in file order so the chat can show a
// still-queued prompt instead of it vanishing until the turn ends — when its
// dequeue lands, the real user turn takes over, so there's no duplicate. A
// window opening mid-sequence can see a dequeue whose enqueue was cut off;
// popping an empty queue is a no-op, erring toward briefly hiding a queued
// prompt rather than inventing a phantom one. Mirror of hub-agent.py
// _fold_queue_op / QUEUED_*.
const QUEUED_PROMPTS_MAX = 10;
const QUEUED_PROMPT_CHARS = 4000;
function foldQueueOp(entry, queue) {
  const op = entry.operation;
  const content = entry.content;
  if (op === "enqueue") {
    if (typeof content === "string" && content.trim()) queue.push(content.trim().slice(0, QUEUED_PROMPT_CHARS));
  } else if (op === "dequeue") {
    if (queue.length) queue.shift();
  } else if (op === "remove") {
    if (typeof content === "string") {
      const c = content.trim().slice(0, QUEUED_PROMPT_CHARS);
      const i = queue.indexOf(c);
      if (i >= 0) queue.splice(i, 1);
    }
  }
}

// The queue entries worth SHOWING: capped, minus the tooling's own payloads —
// a background task finishing mid-turn rides the same queue as a
// `<task-notification>` XML wall, which must keep its FIFO slot (dequeues are
// positional) but must not render as a queued operator bubble. Prefix-matched:
// the enqueue copy is clipped, which can cut the closing tag a parse needs.
// Mirror of hub-agent.py _queued_display.
function queuedDisplay(queue) {
  return queue.filter((q) => !q.startsWith("<task-notification>")).slice(-QUEUED_PROMPTS_MAX);
}

// Last TAIL_MSGS surviving messages of a worktree's newest transcript, oldest
// first, plus the still-queued prompts: {entries: [{id: uuid, role, text,
// blocks}], queued: [text]}. Empty both when there's no transcript yet.
//
// Optional `cache` ({path, mtimeMs, size, result}, one per watched session)
// skips the ~128 KB read+parse when the transcript is unchanged since the last
// poll (same file, same mtime+size) — pollWatcher ticks this ~1s per session and
// most ticks find nothing new. sessionTranscript already stat'd the candidates,
// so one more stat of the winner is cheap next to re-reading the tail.
function transcriptTail(worktreePath, cache, transcriptId, agentState) {
  const p = sessionTranscript(worktreePath, transcriptId);
  if (!p) {
    if (cache) { cache.path = null; cache.result = { entries: [], queued: [] }; }
    return { entries: [], queued: [] };
  }
  let st = null;
  try { st = fs.statSync(p); } catch {}
  if (cache && cache.path === p && st &&
      cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    return cache.result; // unchanged since last poll -> reuse, no read+parse
  }
  const tail = [];
  const queued = [];
  for (const raw of readTailLines(p, TAIL_READ_BYTES)) {
    let entry;
    try { entry = JSON.parse(raw); } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    // Live background agents, folded from the SAME parse (XERK-245). The state
    // persists across polls, so an entry scrolling out of the tail window never
    // un-does what it established; and because a launch always precedes its own
    // notification in the file, a window holding the launch holds the stop too.
    if (agentState) scanAgentEntry(entry, agentState);
    if (entry.type === "queue-operation") { foldQueueOp(entry, queued); continue; }
    const text = entryText(entry);
    const blocks = entryBlocks(entry, BLOCK_CAPS);
    // Rich path widens inclusion: a tool_result-only turn (text === null) still
    // has renderable blocks, so keep it for the chat UI. text stays the
    // backward-compat flat string the glasses read.
    if (text === null && (!blocks || blocks.length === 0)) continue;
    tail.push({
      id: entryId(entry),
      role: entryRole(entry),
      text: (text || "").slice(0, TAIL_MSG_CHARS),
      blocks: blocks || [],
    });
  }
  const result = { entries: tail.slice(-TAIL_MSGS), queued: queuedDisplay(queued) };
  if (cache) {
    cache.path = p;
    cache.mtimeMs = st ? st.mtimeMs : 0;
    cache.size = st ? st.size : 0;
    cache.result = result;
  }
  return result;
}

// The live control WebSocket the tail deltas ride back on, and the set of
// sessions currently being tailed. Both owned by connectControl below.
let controlWs = null;
const watchers = new Map(); // sessionId -> { worktreePath, lastJson, timer }

// Tests substitute a sink here so the whole watch -> tail -> frame path can be
// driven without a socket. The four cut points between scanAgentEntry and the
// wire (the agentState threading, the watcher seed, the frame's `agents`, and
// this send) were each individually severable with a green CI until that path
// was covered end to end.
let controlSink = null;
function sendControl(obj) {
  if (controlSink) { controlSink(obj); return; }
  if (controlWs && controlWs.readyState === WebSocket.OPEN) {
    try { controlWs.send(JSON.stringify(obj)); } catch {}
  }
}

// Claude Code writes each assistant message to the transcript JSONL only when
// the turn COMPLETES — there is no partial/streaming entry (confirmed: no
// isPartial field, and there is no supported streaming tap for an interactive
// `claude --remote-control` session). So the transcript tail can't show a
// response until it finishes generating. The live TUI does stream tokens,
// though, so we ALSO scrape the tmux pane for the in-progress assistant turn
// and push it as a `turn` delta — real-time streaming — while the transcript
// tail stays the authoritative record that supersedes it on completion.
//
// Pure so it's unit-testable against captured pane fixtures. Returns the
// current in-progress assistant `text` (empty when not generating / still
// thinking) plus the parsed working footer as `status` (verb + live token
// up/down counters from the spinner line — see parsePaneStatus — and, when
// present, the contextual hint/task line beneath it as `status.hint`), so the
// hub can pin the whole working indicator to the bottom of the chat instead of
// letting any of it bleed into the streamed message. Anchored to the stable TUI
// markers: "esc to interrupt"
// (shown only while generating), a column-0 ● bullet (assistant text; the right-
// aligned "● high · /effort" indicator has leading spaces and is excluded),
// 2-space-indented continuation lines, and the input box's long ─ rule.
// The working-status line is the spinner-glyph + gerund line Claude Code paints
// just above the input box (e.g. "Cogitating… (esc to interrupt · up 1.2k
// tokens · down 340)"). The spinner cycles through MANY glyphs, so we match it
// glyph-agnostically — a leading non-alphanumeric symbol, then a single
// capitalized gerund ending in an ellipsis — plus any line carrying the "esc to
// interrupt" hint or a token counter. Excluding it glyph-agnostically is what
// stops the verb + token count from flickering into the assistant bubble as the
// spinner animates through frames the old fixed glyph set didn't cover.
function isStatusLine(l) {
  const t = String(l == null ? "" : l).trim();
  if (!t) return false;
  if (/esc to interrupt/i.test(t)) return true;
  if (/[↑↓]\s*[\d.,]+\s*[kKmM]?\s*tokens/i.test(t)) return true;
  return /^[^\sA-Za-z0-9]\s+[A-Z][a-z]+(?:…|\.\.\.)(?:\s*\(|\s*$)/.test(t);
}

// Claude Code paints a second, indented contextual line just under the spinner
// — a rotating tip ("⌊ Tip: Use /btw …") or an active-task hint — with a corner
// glyph connector. It's part of the working footer, not the assistant's reply,
// so we detect it (to keep it out of the streamed text) and surface it beside
// the status for the pinned bar. Match the corner-glyph connector or an
// explicit "Tip:"; keep it narrow so real prose isn't swallowed.
function isHintLine(l) {
  const t = String(l == null ? "" : l).trim();
  if (!t) return false;
  if (/^[⌊⌞└⎿⎣]\s/.test(t)) return true;
  return /^tip:/i.test(t);
}

// Strip the leading corner glyph so the hint reads cleanly in the UI.
function cleanHint(l) {
  return String(l == null ? "" : l).trim().replace(/^[⌊⌞└⎿⎣]\s*/, "").trim();
}

// Claude Code (≥2.1) paints its collapsed tool-activity summary as prose-shaped
// lines inside the assistant ● block — indented under the prose while a call
// runs ("  Running 1 shell command…"), past-tense once it finishes ("  Ran 1
// shell command"), or as the block's own bullet when the turn has no prose yet
// ("● Reading 1 file, listing 1 directory, running 1 shell command…"). No glyph
// marks them, so the block scan reflows them INTO the streamed text, where
// every Running→Ran flip and count tick mutates the block's tail; the chat
// clients read that as a genuinely different prose block and retype it from 0
// — the "previous text adds and removes over and over" flicker. They are
// activity ABOUT the turn (the transcript's tool_use owns the real rendering),
// so strip them off the reflowed text's tail: one-or-more comma-joined
// "<Verb> <count> <noun words>" clauses, optionally ellipsized. Matched on the
// REFLOWED text, not per physical line, so a narrow pane wrapping mid-clause
// can't hide one. Biased toward matching like chat.js's isToolBullet: a false
// strip only trims the live preview's tail (the committed transcript still
// renders the prose in full), while a missed clause brings the flicker back.
// A clause is "<Verb> <count> <words>", where the words may include diff-stat
// tokens ("Making 1 scratchpad edit +3 -2"); clauses comma-join, and the line
// may close with the TUI's own "· 26s" / "· 1m 3s" elapsed and an ellipsis.
// The vocabulary EVOLVES across Claude Code releases — committedDupe's
// prefix-plus-garnish rule below is the phrasing-independent net behind this.
const ACTIVITY_WORD = "(?:[a-z]+|[+-]\\d+)";
const ACTIVITY_CLAUSE = `\\d+ ${ACTIVITY_WORD}(?: ${ACTIVITY_WORD}){0,4}`;
const PANE_ACTIVITY_TAIL_RE = new RegExp(
  `(?:^|\\s)[A-Z][a-z]+ ${ACTIVITY_CLAUSE}(?:, [a-z]+ ${ACTIVITY_CLAUSE})*` +
  `(?: · \\d+[smh](?: \\d+[smh])*)?(?:…|\\.\\.\\.)?$`);
function stripActivityTail(text) {
  let t = text;
  for (;;) {
    const next = t.replace(PANE_ACTIVITY_TAIL_RE, "").trim();
    if (next === t) return t;
    t = next;
  }
}

// An active-task checklist item Claude Code paints beneath the spinner: an
// optional tree connector then a to-do status glyph (done ✓ / active ■ /
// pending □). Only the first item carries the connector; the rest are bare, so
// isHintLine alone catches just that first item. Requiring a status glyph is
// what keeps this from swallowing a `⎿`-connected tool-result line (its glyph
// is followed by prose, not a checkbox).
function isChecklistLine(l) {
  const t = String(l == null ? "" : l).trim();
  if (!t) return false;
  return /^(?:[⌊⌞└⎿⎣]\s*)?[✓✔☑☒☐□■◼◻▪▫]\s/u.test(t);
}

// Claude Code's agent-manager list (opened with ↓/← from the working footer)
// paints one row per live agent below the input box: a radio glyph
// (◉/● = the one currently in focus, ○/◯ = a background agent), then the agent
// type, then — for a subagent — its short description. e.g. "◉ main",
// "○ Explore   Explore Jira agent-side code". We surface it beside the working
// status so the web chat can list the live agents and open one. Type and label
// are separated by the TUI's 2+-space gutter; "main" has no label. Scanned only
// in the footer region (below the input box) — see parsePaneLiveTurn — so the
// column-0 ● assistant-text bullet can never be mistaken for a focused agent.
const AGENT_ROW_RE = /^\s*([◉●◯○])\s+(\S.*?)\s*$/;
function parseAgentList(lines) {
  const agents = [];
  for (const raw of lines || []) {
    const m = AGENT_ROW_RE.exec(String(raw == null ? "" : raw));
    if (!m) continue;
    const parts = m[2].split(/\s{2,}/);
    const type = (parts[0] || "").trim();
    if (!type) continue;
    agents.push({
      sel: /[◉●]/.test(m[1]),
      type,
      label: parts.slice(1).join(" ").trim(),
    });
  }
  return agents;
}

// ---- live background agents, off the transcript (XERK-245) ------------------
// Mirror of hub-agent.py's _scan_agent_entry / live_agents_report — read there
// for why the TUI's footer list is NOT the source and must not become one
// again: its rows are pane CONTENT (a quoted footer plus a composer-less
// full-screen view forged them) and, measured on a live TUI, they LINGER ~24s
// after an agent finishes, so no single capture can tell running from finished.
const AGENT_DONE_STATUSES = new Set(["completed", "failed", "killed", "stopped", "error"]);
const LIVE_AGENTS_MAX = 32;

// `{id, type, label}` iff this entry is a BACKGROUND WORK launch. Mirror of
// hub-agent.py's _async_launch — read there for why loose `agentId:` text must
// never be the signal (a grep/cat of any transcript registers a permanent
// phantom), why a synchronous subagent result must not register, and why
// `isAsync` is deliberately not required (it would exclude `Workflow`).
function asyncLaunch(entry) {
  const tur = entry && entry.toolUseResult;
  if (!tur || typeof tur !== "object" || tur.status !== "async_launched") return null;
  const ident = tur.agentId || tur.taskId;
  if (!ident) return null;
  if (tur.taskType === "local_workflow") {
    return { id: String(ident), type: "workflow",
             label: String(tur.workflowName || tur.summary || "").trim() };
  }
  return { id: String(ident), type: String(tur.agentType || "agent"),
           label: String(tur.description || "").trim() };
}

function scanAgentEntry(entry, state) {
  if (!entry || typeof entry !== "object" || !state) return;
  const live = state.live || (state.live = new Map());
  const tasks = state.tasks || (state.tasks = new Map());
  const stopped = state.stopped || (state.stopped = new Set());
  const content = entry.message && entry.message.content;
  let toolId = null;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      // `Agent` in current Claude Code, `Task` in older transcripts — both.
      if (block.type === "tool_use" && (block.name === "Agent" || block.name === "Task") && block.id) {
        const atype = String((block.input || {}).subagent_type || "").trim();
        if (atype) {
          tasks.set(block.id, atype);
          while (tasks.size > LIVE_AGENTS_MAX * 4) tasks.delete(tasks.keys().next().value);
        }
      } else if (block.type === "tool_result") {
        toolId = block.tool_use_id;
      }
    }
  }
  const launch = asyncLaunch(entry);
  if (launch && live.size < LIVE_AGENTS_MAX && !stopped.has(launch.id)) {
    // A stop already seen wins over a later-read launch: a notification can be
    // written at an EARLIER file offset than the launch it refers to. The
    // call's subagent_type is the only place a real agent TYPE appears.
    live.set(launch.id, { type: tasks.get(toolId) || launch.type, label: launch.label });
  }
  // Never an ASSISTANT turn — a session merely QUOTING a notification must not
  // retire an agent that is still running.
  if (entry.type !== "assistant") {
    for (const text of entryTextsForScan(entry)) {
      const tn = parseTaskNotification(text);
      if (!tn || !tn.taskId) continue;
      if (!tn.status || AGENT_DONE_STATUSES.has(tn.status)) {
        live.delete(tn.taskId);
        stopped.add(tn.taskId);
        while (stopped.size > LIVE_AGENTS_MAX * 4) stopped.delete(stopped.values().next().value);
      }
    }
  }
}

// The raw strings on one entry that could BE a `<task-notification>`: a
// queue-operation's content, and any string/text-block message content.
function entryTextsForScan(entry) {
  const out = [];
  if (typeof entry.content === "string") out.push(entry.content);
  const content = entry.message && entry.message.content;
  if (typeof content === "string") out.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) if (b && typeof b.text === "string") out.push(b.text);
  }
  return out;
}

function liveAgentsReport(state) {
  if (!state || !state.live) return [];
  return [...state.live.values()].map((a) => ({ type: a.type, label: a.label }));
}

// Parse a working-status line into { verb, up, down, elapsed } — display strings
// kept verbatim from the TUI (e.g. up: "1.2k", down: "340", elapsed: "12s").
// Absent fields come back as "". Order/format vary across Claude Code versions,
// so each field is matched independently rather than positionally.
function parsePaneStatus(l) {
  const t = String(l == null ? "" : l).trim();
  const verb = t.match(/([A-Za-z][A-Za-z-]*)(?:…|\.\.\.)/);
  const up = t.match(/↑\s*([\d.,]+\s*[kKmM]?)/);
  const down = t.match(/↓\s*([\d.,]+\s*[kKmM]?)/);
  const elapsed = t.match(/(?:^|[\s(·])(\d+)\s*s\b/);
  const clean = (m) => (m ? m[1].replace(/\s+/g, "") : "");
  let u = clean(up), d = clean(down);
  // No arrows but a bare "1.2k tokens" -> treat as the primary (up) count.
  if (!u && !d) { const tok = t.match(/([\d.,]+\s*[kKmM]?)\s*tokens/i); if (tok) u = clean(tok); }
  return { verb: verb ? verb[1] : "", up: u, down: d, elapsed: elapsed ? elapsed[1] + "s" : "" };
}

// "Is a turn running" read off the whole capture — the same three shapes
// hub-agent.py's _busy_from_capture keys on (XERK-130), because the full
// "esc to interrupt" hint alone misses a NARROW pane: tmux sizes the window to
// its smallest-ever attached client (a phone leaves ~54 columns), and at that
// width the TUI ellipsizes the footer hint to "· esc to inte…", so every
// working session on such a pane read "not generating" and the live working
// bar never appeared. Busy is any of:
//  - the full hint (wide pane), as before;
//  - the width-truncated hint on the mode footer line — a line carrying the
//    mode marker's ⏸/⏵ glyph whose LAST "·"-separated segment is a PREFIX of
//    "esc to interrupt" (character class, so every cut point matches) ending
//    in the TUI's own "…". Glyph-anchored because the middle segments vary
//    ("(shift+tab to cycle)" comes and goes, a "· PR #98" chip can sit before
//    the hint); the idle footer's "· ← for agents" suffix can't match (it
//    never starts with "e"). The only visible signal while text streams on a
//    narrow pane (no spinner line then) or the conversation is scrolled up
//    (spinner off-screen);
//  - the column-0 spinner line ("✢ Determining… (12m 19s · ↓ 44.2k tokens)",
//    "· Perusing… (54m 38s · still thinking)"): glyph-agnostic but never the
//    assistant "●" bullet or "❯" prompt, one capitalized gerund, then the
//    ellipsis — which the completed-turn line an IDLE pane keeps on screen
//    ("✻ Brewed for 9s") lacks, so it can't fake busy.
const PANE_BUSY_TRUNC_RE = /[⏸⏵][^\n]*·\s*e[sc to interup]*…\s*$/im;
const PANE_SPINNER_RE = /^[^\sA-Za-z0-9●❯]\s+[A-Z][a-z]+(?:…|\.\.\.)(?:\s*\(|\s*$)/;
function paneShowsBusy(raw) {
  if (/esc to interrupt/i.test(raw)) return true;
  if (PANE_BUSY_TRUNC_RE.test(raw)) return true;
  return raw.split("\n").some((l) => PANE_SPINNER_RE.test(l));
}

function parsePaneLiveTurn(pane) {
  const raw = String(pane || "").replace(/\r/g, "");
  const lines = raw.split("\n");
  const isRule = (l) => /^─{20,}$/.test(l.trim());
  // Drop the whole bottom input box (its top border ─, the ❯ prompt line(s),
  // its bottom border ─, and the status line). Find the bottom border (the
  // last ─ rule), then the top border just above it, and cut from the top
  // border — otherwise the box's own empty ❯ prompt would end the scan before
  // we reach the assistant block.
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isRule(lines[i])) { bottom = i; break; }
  }
  // Live background agents do NOT come from here — see scanAgentEntry. The
  // footer's rows are pane content and linger ~24s past completion, so they
  // cannot answer "is an agent running right now"; the transcript can.
  if (!paneShowsBusy(raw)) return { generating: false, text: "", status: null, agents: [] };
  let end = lines.length;
  if (bottom >= 0) {
    end = bottom;
    for (let i = bottom - 1; i >= 0 && bottom - i <= 6; i--) {
      if (isRule(lines[i])) { end = i; break; }
    }
  }
  const convo = lines.slice(0, end);
  // The working footer (status line + its contextual hint/task line) sits just
  // above the input box. Grab both — they're the last such lines — for the
  // pinned bar; scanning independently means their order doesn't matter.
  let statusLine = null, hintIdx = -1;
  for (let i = convo.length - 1; i >= 0; i--) {
    if (statusLine == null && isStatusLine(convo[i])) statusLine = convo[i];
    if (hintIdx < 0 && isHintLine(convo[i])) hintIdx = i;
    if (statusLine != null && hintIdx >= 0) break;
  }
  let status = null;
  if (statusLine != null || hintIdx >= 0) {
    status = statusLine != null ? parsePaneStatus(statusLine) : { verb: "", up: "", down: "", elapsed: "" };
    if (hintIdx >= 0) {
      // The hint is either a single rotating tip / active-task line or the head
      // of a multi-line to-do checklist (a corner-glyph item followed by bare
      // checkbox items). When it's a checklist, gather the contiguous block that
      // follows so the WHOLE list — not just its first item — reaches the footer.
      const hintBlock = [convo[hintIdx]];
      if (isChecklistLine(convo[hintIdx])) {
        for (let j = hintIdx + 1; j < convo.length && isChecklistLine(convo[j]); j++) {
          hintBlock.push(convo[j]);
        }
      }
      const h = hintBlock.map(cleanHint).filter(Boolean).join("\n");
      if (h) status.hint = h;
    }
  }
  // The pane's own footer rows still ride `status.agents` while a turn runs:
  // they carry the live elapsed/token counters the transcript has no way to
  // know, and an older hub forwards only `status`. They are DISPLAY ONLY —
  // liveness is the transcript's answer (scanAgentEntry).
  const paneRows = bottom >= 0 ? parseAgentList(lines.slice(bottom + 1)) : [];
  if (paneRows.length) {
    status = status || { verb: "", up: "", down: "", elapsed: "" };
    status.agents = paneRows;
  }
  // The in-progress assistant block starts at the last column-0 ● bullet.
  let start = -1;
  for (let i = convo.length - 1; i >= 0; i--) {
    if (/^●\s/.test(convo[i])) { start = i; break; }
    if (/^❯/.test(convo[i])) break; // hit the user prompt -> no text yet
  }
  if (start < 0) return { generating: true, text: "", status, agents: [] }; // thinking; no text yet
  const block = [];
  for (let i = start; i < convo.length; i++) {
    const l = convo[i];
    // Stop at the next turn marker (a new ● bullet or the ❯ prompt) OR any
    // footer line — the status/spinner line and its hint/task line — so none of
    // the working footer bleeds into the message regardless of its order.
    if (i > start && (/^[●❯]/.test(l) || isStatusLine(l) || isHintLine(l) || isChecklistLine(l))) break;
    block.push(i === start ? l.replace(/^●\s?/, "") : l.replace(/^ {1,3}/, ""));
  }
  // Reflow the TUI's hard-wrapped lines into flowing text; the glasses re-wrap,
  // and the transcript delivers the authoritative structure on completion.
  const text = stripActivityTail(block.join(" ").replace(/\s+/g, " ").trim());
  return { generating: true, text, status, agents: [] };
}

// Suppress a single-frame busy->idle blip in the live turn scrape. Claude Code
// repaints its spinner (and the "esc to interrupt" hint parsePaneLiveTurn keys
// on) several times a second by clearing and rewriting the status line, so one
// capture can read "not generating" mid-repaint while the model is still
// working. Clearing the hub's pinned working bar (and the chat's Stop button) on
// that blip makes it flicker off for a poll. So on the busy->idle EDGE we HOLD
// one poll before clearing: if the very next poll is still generating it was a
// redraw gap and nothing flickered; if it's still idle the turn really ended and
// we clear (the committed transcript tail owns the finished message either way,
// so the ~1s hold is invisible). Busy is never held — status must light up
// promptly, and nothing fakes busy while idle. This mirrors _stable_pane_busy in
// hub-agent.py, which guards the heartbeat's paneBusy the same way; the shorter
// (1s) live cadence lets a poll-hold stand in for that one's re-capture.
//
// Pure so it's unit-testable: given the prior (gen, pending) hold state and this
// poll's `generating`, returns whether to `emit` this frame plus the next hold
// state. emit=false means skip the frame, leaving the last one on screen.
function liveTurnDecision(prevGen, prevPending, generating) {
  if (generating) return { emit: true, gen: true, pending: false };
  if (prevGen && !prevPending) return { emit: false, gen: true, pending: true };
  return { emit: true, gen: false, pending: false };
}

// Capture the session's tmux pane (agent-<id>) and extract the in-progress
// assistant turn. Async (execFile, not execFileSync) so a slow/hung capture
// can't block the control-WS event loop.
function captureLiveTurn(sessionId, cb) {
  execFile(
    "tmux",
    ["capture-pane", "-p", "-t", `agent-${sessionId}`],
    { timeout: 2000, maxBuffer: 1 << 20 },
    (err, stdout) => cb(err ? { generating: false, text: "", status: null, agents: [] }
                            : parsePaneLiveTurn(stdout))
  );
}

// Is this scraped live text a block the transcript has ALREADY committed?
// While a tool call runs, the TUI keeps the finished prose on screen and
// re-paints the block area every second, alternating between rendering the
// activity summary as its own ● bullet (-> the scrape yields "") and indented
// under the prose bullet (-> the scrape yields the prose again). Forwarding
// those frames verbatim makes the chat bubble clear and re-type the SAME
// already-committed prose over and over, beside its committed copy, for the
// whole tool run. The watcher holds the committed tail, so it can tell: a live
// text a recent assistant entry already ends with is a re-paint of history,
// not streaming — suppress it and both alternating states emit "".
// The compare is on a lowercase alphanumeric SKELETON, not raw text: the pane
// renders markdown (no **/`/list dashes, re-wrapped whitespace) while the
// transcript keeps the raw syntax, so no text-level equality survives
// formatting. endsWith (not ===) because the transcript entry can carry more
// than one paragraph of which the pane block is the tail; short skeletons
// (< COMMITTED_MIN_SKEL) must match exactly so a new block that merely opens
// with the old one's last words isn't swallowed. Scans the last few assistant
// entries because tool_use entries commit right behind the prose. Biased
// toward suppressing: a false positive hides a live preview of text the
// committed tail is already rendering.
const COMMITTED_SCAN = 8;
const COMMITTED_MIN_SKEL = 24;
const COMMITTED_GARNISH_MAX = 120; // max skeleton excess for prefix-plus-garnish
function textSkeleton(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function committedDupe(liveText, entries) {
  const live = textSkeleton(liveText);
  if (!live) return false;
  const list = Array.isArray(entries) ? entries : [];
  let seen = 0;
  for (let i = list.length - 1; i >= 0 && seen < COMMITTED_SCAN; i--) {
    const e = list[i];
    if (!e || e.role !== "assistant") continue;
    seen++;
    const committed = textSkeleton(e.text);
    if (!committed) continue;
    if (live.length >= COMMITTED_MIN_SKEL ? committed.endsWith(live) : committed === live) return true;
    // Prefix-plus-garnish: the TUI appends short activity/elapsed garnish when
    // it re-paints a finished block ("<the whole prose>: Making 1 scratchpad
    // edit +3 -2, running 1 shell command · 26s…"), and that vocabulary evolves
    // faster than PANE_ACTIVITY_TAIL_RE can chase it. A live text that STARTS
    // with a substantial committed entry and adds only a short excess is that
    // entry re-painted, whatever the garnish says. The excess cap is what keeps
    // a genuinely new block that happens to open with the old text streaming:
    // once it outgrows the cap it renders normally.
    if (committed.length >= COMMITTED_MIN_SKEL && live.startsWith(committed) &&
        live.length - committed.length <= COMMITTED_GARNISH_MAX) return true;
  }
  return false;
}

// Decide the live text to emit this frame, holding uncommitted prose across
// the TUI's paint gaps. Within one generating turn the pane's last ● bullet
// SWAPS every second or two — streaming prose, then a tool/activity bullet or
// nothing at all, then prose again — and at a block boundary the tool bullet
// paints BEFORE the transcript entry for that prose lands on disk. Forwarding
// those frames verbatim cleared the bubble into that 1-3s gap with no committed
// copy on screen, then the text "reappeared" when the entry committed: every
// block boundary blinked (the appear/disappear the operator reports).
// So the resolver only ever moves the bubble forward:
//  - a tool-use bullet ("Bash(…)") or an already-committed text is NOT prose
//    to stream (committedDupe: a re-paint of history);
//  - with no prose in this frame, the previously HELD text stays up while it
//    is still uncommitted — the moment it commits, the frame goes empty and
//    the committed bubble takes over with no gap;
//  - the same block grown or re-captured keeps the LONGER text (never
//    shrinks); a genuinely different prose block replaces the held one.
// Pure so it's unit-testable; pollWatcher threads w.heldText through it.
const TOOL_BULLET_RE = /^[\w-]+\(/;
function resolveLiveText(generating, captured, held, entries) {
  if (!generating) return "";
  let t = typeof captured === "string" ? captured : "";
  if (TOOL_BULLET_RE.test(t)) t = "";
  if (t && committedDupe(t, entries)) t = "";
  if (!t) return held && !committedDupe(held, entries) ? held : "";
  if (held && (t.startsWith(held) || held.startsWith(t))) {
    return t.length >= held.length ? t : held;
  }
  return t;
}

// The dsh native event-log path for a watched session, or null when it is not a
// dsh session (no events file at the derived nest). Mirrors _launch_dsh's
// `store_dir` `<slug>/<tid>/<dsh>/events.jsonl`, so a claude session — which
// never writes that nest — keeps the pane-scrape live path below. The
// transcriptId is the pinned claude_sid for dsh, exactly as sessionTranscript
// reads it. Path-traversal-safe: transcriptId is validated to a plain word and
// projectSlug rewrites every non-alphanumeric char to '-', so both only name a
// child of PROJECTS_ROOT.
function dshEventsPath(worktreePath, transcriptId) {
  if (!transcriptId || !/^[A-Za-z0-9-]+$/.test(transcriptId)) return null;
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const p = path.join(PROJECTS_ROOT, projectSlug(worktreePath), transcriptId,
    DSH_STORE_DIRNAME, DSH_EVENTS_FILE);
  return fs.existsSync(p) ? p : null;
}

// dsh's working verb is a fixed cosmetic gerund (its own web UI hardcodes
// "Deep diving…"), and the elapsed clock only appears once a turn has run a
// while — matching dsh-client-ui-conversation's `showClock = elapsedMs >= 15e3`.
const DSH_VERB = "Deep diving";
const DSH_CLOCK_AFTER_MS = 15000;

// Whole-seconds elapsed, formatted like dsh's formatRunDuration: "47s" under a
// minute, "1m 03s" beyond. Pure and time-input-only (elapsed comes from dsh's
// own event timestamps, never a wall clock), so the frame stays deterministic.
function fmtDshElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

// The working-status a dsh `turn` frame carries while generating, or null when
// idle. It REUSES the claude status shape the chat's working bar already reads
// {verb, elapsed}, plus `noStop: true` — a dsh turn has no pane-Escape interrupt
// (kill ends the whole session), so the chat must keep Stop hidden for it even
// though the bar now shows the verb. Elapsed is dsh's own turn duration and only
// once past DSH_CLOCK_AFTER_MS, matching its web UI.
function dshStatus(view, startMs, lastMs) {
  if (!view || !view.generating) return null;
  const st = { verb: DSH_VERB, noStop: true };
  if (typeof startMs === "number" && typeof lastMs === "number") {
    const elapsed = lastMs - startMs;
    if (elapsed >= DSH_CLOCK_AFTER_MS) st.elapsed = fmtDshElapsed(elapsed);
  }
  return st;
}

// Fold one dsh native event into the live streaming view {text, generating}.
// This is the dsh analogue of the pane-scrape classifier (XERK-19/251) — it
// turns the raw LLM stream into a monotonic bubble for the chat page:
//  - `assistant/chunk` with a `text-delta` grows `text` (streaming), capped at
//    DSH_LIVE_TEXT_CHARS so no frame is unbounded;
//  - the committed `assistant/message` CLEARS `text` — the projection just wrote
//    it in full, so the committed transcript tail owns that bubble (never keep
//    streaming it);
//  - only `turn/end` (and a fresh `user/message`, which opens a new turn) ends
//    the generating read, mirroring the driver's own turn/start->running /
//    turn/end->idle liveness edge (XERK-479 D3) so the working bar never blinks
//    between a multi-step turn's steps.
// Pure so it's unit-testable against captured events; `view` may be mutated in
// place (the caller owns it per-session).
function foldDshView(view, event) {
  const e = (event && typeof event === "object") ? event : null;
  if (!e) return view;
  const t = e.type;
  if (t === "turn/start" || t === "user/message") {
    // A turn opened; any held stream text from a prior turn is stale.
    return { text: "", generating: true };
  }
  if (t === "assistant/chunk") {
    const chunk = (e.data && typeof e.data === "object") ? e.data.chunk : null;
    if (chunk && chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text) {
      return { text: (String(view.text === undefined ? "" : view.text) + chunk.text)
        .slice(0, DSH_LIVE_TEXT_CHARS), generating: true };
    }
    return { text: view.text, generating: true };
  }
  if (t === "assistant/message") {
    // The full message committed to the projection; the transcript tail owns it.
    return { text: "", generating: view.generating };
  }
  if (t === "turn/end") {
    return { text: "", generating: false };
  }
  return view;
}

// Tail a watched dsh session's native event log and push `turn` frames carrying
// the streaming assistant text (the dsh counterpart of the pane scrape in
// pollWatcher's claude branch). Reads only the bytes appended since the last
// poll, folds each complete event via foldDshView, and sends on a text or
// generating change — a blank text + null status clears the bubble and the
// working bar, exactly like a finished claude turn. Best-effort: a missing or
// transiently unreadable events file is skipped, never fatal to the tail.
function pollDshTurn(w, sessionId) {
  let fd;
  try { fd = fs.openSync(w.dshEvents, "r"); } catch { return; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < w.dshOffset) {
      // The log was truncated/rewritten (a fresh launch / clear-context) — start
      // over, like DshProjectionTail's defensive reset.
      w.dshOffset = 0; w.dshPartial = ""; w.dshView = { text: "", generating: false };
      w.dshTurnStartMs = null; w.dshLastEventMs = null;
    }
    const len = size - w.dshOffset;
    let buf = "";
    if (len > 0) {
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, w.dshOffset);
      w.dshOffset = size;
      buf = b.toString("utf8");
    }
    w.dshPartial += buf;
    const lines = [];
    let idx;
    while ((idx = w.dshPartial.indexOf("\n")) !== -1) {
      const line = w.dshPartial.slice(0, idx).trim();
      w.dshPartial = w.dshPartial.slice(idx + 1);
      if (line) lines.push(line);
    }
    if (!lines.length) return; // nothing new appended — no frame to recompute
    for (const raw of lines) {
      let event;
      try { event = JSON.parse(raw); } catch { continue; }
      const t = event && typeof event === "object" ? event.type : null;
      // A turn opens on turn/start (or a fresh user/message); stamp its start
      // from dsh's own clock so the elapsed is that turn's real duration.
      if (t === "turn/start" || t === "user/message") {
        const tm = event.time;
        w.dshTurnStartMs = typeof tm === "number" ? tm : null;
        w.dshLastEventMs = w.dshTurnStartMs;
      } else if (event && typeof event.time === "number") {
        w.dshLastEventMs = event.time;
      }
      w.dshView = foldDshView(w.dshView, event);
    }
    // dsh DOES carry a working status now — the fixed "Deep diving…" verb + an
    // elapsed clock (dshStatus) — but with `noStop: true`, because Stop for a
    // dsh session would send Escape into its (non-Claude) tmux pane, a no-op:
    // the chat's composeBusy() hides Stop on that flag while the bar still shows
    // the verb. The heartbeat's `paneBusy` (dsh_pane_busy, [D]) is unchanged.
    const status = dshStatus(w.dshView, w.dshTurnStartMs, w.dshLastEventMs);
    // NUL separator: a byte that cannot occur in stream text (same escape as the
    // claude branch — a literal NUL makes grep treat this file as binary).
    const key = String(w.dshView.text || "") + "\u0000" + (status ? JSON.stringify(status) : "");
    if (key !== w.lastTurn) {
      w.lastTurn = key;
      sendControl({ turn: sessionId, text: String(w.dshView.text || ""), status,
        agents: liveAgentsReport(w.agentState) });
    }
  } catch {
    /* transient read error — keep the old view; never let this kill the tail */
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

function pollWatcher(sessionId) {
  const w = watchers.get(sessionId);
  if (!w) return;
  // 1. Committed transcript tail (authoritative history) plus the still-queued
  //    prompts. The per-session cache skips the read+parse on ticks where the
  //    transcript file hasn't changed. `queued` joins the dedup key because a
  //    queue op is a transcript line that changes NO entry — without it, the
  //    frame that reports "your prompt is queued" would never fire.
  let tail = null;
  try { tail = transcriptTail(w.worktreePath, w.tailCache, w.transcriptId, w.agentState); }
  catch { tail = null; }
  if (tail && (tail.entries.length || tail.queued.length)) {
    // The serialize is INSIDE the try, not beside it (XERK-347). A turn holding
    // BLOCK_MAX_PER_ENTRY SendUserFile deliveries builds a frame past V8's
    // ~512 MB string ceiling — previews are read from disk, so no transcript
    // window bounds them (XERK-355) — and this runs in a setInterval with no
    // uncaughtException handler in this file: the RangeError killed the whole
    // tunnel process, which the native launcher then restarted in a loop for as
    // long as that session was watched. Skipping one frame is a stale tail; dying is
    // every session's terminal, live tail and heartbeat poke on this host.
    try {
      const json = JSON.stringify(tail);
      if (json !== w.lastJson) {
        w.lastJson = json;
        sendControl({ tail: sessionId, entries: tail.entries, queued: tail.queued });
      }
    } catch (e) {
      log(`live tail: could not serialize ${sessionId}'s tail (${e && e.message}); skipping this frame`);
    }
  }
  // 2. Live in-progress assistant turn, streamed (real-time). Sent as its own
  //    `turn` delta carrying the streamed text AND the working-status for the
  //    hub's pinned status bar; an empty text + null status clears both
  //    (generation ended, so the committed tail now owns that message). Dedup
  //    on text+status together so a status-only change still pushes an update.
  //    Two sources, one frame shape (the chat page can't tell them apart):
  //    a claude session is scraped from the TUI pane (below); a dsh session
  //    folds its native event log's `assistant/chunk` deltas (pollDshTurn).
  if (w.dshEvents) {
    pollDshTurn(w, sessionId);
    return;
  }
  captureLiveTurn(sessionId, (live) => {
    if (!watchers.has(sessionId)) return; // stopped mid-capture
    const d = liveTurnDecision(w.liveGen === true, w.livePending === true, live.generating);
    w.liveGen = d.gen;
    w.livePending = d.pending;
    if (!d.emit) return; // holding a busy->idle blip for one poll; keep last frame
    // See resolveLiveText: suppress re-paints of committed history, hold
    // uncommitted prose across the TUI's paint gaps, never shrink a block.
    const tailEntries = w.tailCache && w.tailCache.result && w.tailCache.result.entries;
    const text = resolveLiveText(live.generating, live.text, w.heldText || "", tailEntries);
    w.heldText = text;
    const status = live.generating ? (live.status || null) : null;
    // NUL separator: a byte that cannot occur in pane text. Written as an
    // escape, not a literal: a raw NUL makes grep treat this whole file as
    // binary and silently report no matches for anything in it (the same
    // reason the tests keep ESC as String.fromCharCode(27)).
    const key = text + "\u0000" + (status ? JSON.stringify(status) : "");
    // The live agent list rides the FRAME, not `status`, because the two answer
    // different questions and stop being true at different moments (XERK-245):
    // `status` is "a turn is running" — it drives the chat's Stop button, so it
    // must clear the instant the turn ends — while agents stay live past that,
    // which is exactly when the operator most needs to see them. Sending them
    // inside `status` would either hide them or fake a running turn.
    const agents = liveAgentsReport(w.agentState);
    // They join the dedup key for the same reason `status` does: a background
    // agent's row ticks (elapsed, tokens) while the text and status hold still,
    // and without this the list would freeze on whatever its first frame said.
    const frameKey = key + (agents.length ? JSON.stringify(agents) : "");
    if (frameKey !== w.lastTurn) {
      w.lastTurn = frameKey;
      sendControl({ turn: sessionId, text, status, agents });
    }
  });
}

function startWatch(sessionId, worktreePath, transcriptId) {
  if (!sessionId || !worktreePath) return;
  const existing = watchers.get(sessionId);
  if (existing) {
    // A re-armed watch (control-channel flap) carries the hub's current view of
    // where this session's transcript is; a restart-clear-context moves it, so
    // take the newer answer rather than keeping the one we started with.
    existing.worktreePath = worktreePath;
    existing.transcriptId = transcriptId || null;
    // A restart-clear-context may also have recreated the dsh events log (fresh
    // launch truncates it), so re-detect the runtime; the offset reset in
    // pollDshTurn handles a rewritten file.
    existing.dshEvents = dshEventsPath(worktreePath, transcriptId || null);
    return; // already tailing
  }
  if (watchers.size >= MAX_WATCHERS) {
    log(`live tail: at MAX_WATCHERS (${MAX_WATCHERS}); ignoring watch for ${sessionId}`);
    return;
  }
  const w = { worktreePath, transcriptId: transcriptId || null,
    lastJson: null, lastTurn: "", timer: null,
    liveGen: false, livePending: false, // busy->idle blip hold; see liveTurnDecision
    heldText: "", // uncommitted prose held across paint gaps; see resolveLiveText
    // dsh live stream state (null dshEvents = a claude session): the native
    // event-log path plus the incremental-read cursor and the current folded
    // streaming view. See pollDshTurn / foldDshView. The cursor is seeded to the
    // file's CURRENT size so a chat opened on a session mid-way only streams
    // events appended after the watch armed — never re-folds the finished
    // history (which could echo a completed turn's stale text into the bubble).
    dshEvents: dshEventsPath(worktreePath, transcriptId || null),
    dshOffset: 0, dshPartial: "", dshView: { text: "", generating: false },
    // dsh working-status timing: the current turn's start and newest event
    // times (dsh's OWN epoch-ms clock, from the native events — no wall clock,
    // so the "Deep diving…" elapsed is deterministic). See pollDshTurn.
    dshTurnStartMs: null, dshLastEventMs: null,
    // Live background agents, accumulated from the transcript across polls
    // (scanAgentEntry). Not derived from the pane — see that function.
    agentState: { live: new Map(), tasks: new Map() },
    tailCache: { path: null, mtimeMs: 0, size: 0, result: [] } };
  if (w.dshEvents) {
    try { w.dshOffset = fs.statSync(w.dshEvents).size; } catch { /* missing */ }
  }
  watchers.set(sessionId, w);
  w.timer = setInterval(() => pollWatcher(sessionId), LIVE_TAIL_MS);
  pollWatcher(sessionId); // emit an immediate snapshot, don't wait a full interval
  log(`live tail: watching ${sessionId}`);
}

function stopWatch(sessionId) {
  const w = watchers.get(sessionId);
  if (!w) return;
  clearInterval(w.timer);
  watchers.delete(sessionId);
  log(`live tail: stopped ${sessionId}`);
}

function stopAllWatches() {
  for (const w of watchers.values()) clearInterval(w.timer);
  watchers.clear();
}

// Nudge the session-manager process (hub-agent.py) to heartbeat immediately so
// a just-queued hub command is delivered in that beat's reply rather than up
// to a whole TURMA_INTERVAL later. The manager installs a SIGUSR1 handler that
// cuts its interval sleep short.
//
// The launcher names the manager's pid: turma-agent exports TURMA_MANAGER_PID
// (its own $$, which `exec` makes the manager's). The bare `|| 1` fallback is a
// last resort only — under systemd PID 1 is init, and signalling it raised EPERM
// on every poke, so every hub command silently waited out a full beat instead of
// landing in about a round-trip. Still best-effort: a failed signal costs
// latency, never correctness, since the scheduled beat delivers the command anyway.
function pokeHeartbeat() {
  const pid = Number(process.env.TURMA_MANAGER_PID) || 1;
  try {
    process.kill(pid, "SIGUSR1");
  } catch (err) {
    log(`poke failed (pid ${pid}): ${(err && err.message) || err}`);
  }
}

// ws(s):// base derived from TURMA_URL's scheme.
const WS_BASE = TURMA_URL.replace(/^http/, "ws").replace(/\/+$/, "");

// How long the control channel may go completely silent before we treat the hub
// as gone and reconnect. The hub beats every CONTROL_PING_EVERY_MS (30s), so
// this is 3 missed beats — long enough that a slow link or a paused hub isn't
// mistaken for a dead one.
const CONTROL_IDLE_TIMEOUT_MS = Number(process.env.TURMA_CONTROL_IDLE_TIMEOUT_MS) || 90 * 1000;
const CONTROL_WATCHDOG_EVERY_MS = Number(process.env.TURMA_CONTROL_WATCHDOG_EVERY_MS) || 15 * 1000;

function log(msg) {
  console.log(`[tunnel-agent] ${msg}`);
}

// The physical host name the hub keys agents by. The native launcher resolves it
// once (via `hub-agent.py --print-device`, which includes the SMB probe of the
// Windows host on Docker Desktop) and exports DEVICE_NAME, so here we read that
// env FIRST — that's how the tunnel and the heartbeat register under one
// identity and /term/<name> lines up. The remaining sources mirror
// hub-agent.py's device_name() (same rejects) purely as a fallback if the env
// wasn't set. Crucially we never report the kernel-assigned container id
// (os.hostname() inside a container) as the device — the "fe0e38df73b4" bug.
const HOSTNAME_PLACEHOLDERS = new Set([
  "",
  "localhost",
  "unknown-device",
  "docker-desktop",
]);
const CONTAINER_ID_RE = /^[0-9a-f]{12}$|^[0-9a-f]{64}$/;
// Mirrors hub-agent.py's _DOT_SEGMENT_NAMES. A name that is a URL dot segment is
// unaddressable: the manager's /api/agents/<host>/... routes collapse it away
// (XERK-269). The tunnel registers by QUERY PARAM, which no URL parser collapses,
// so "." works here — but only here, and the two MUST agree: openChannel() keys
// controlChannels by the name, so a tunnel under "." and a manager under its
// fallback name is a host with working commands and a dead terminal + live tail.
const DOT_SEGMENT_NAMES = new Set([".", ".."]);

function usableHostname(name) {
  const n = (name || "").trim();
  if (HOSTNAME_PLACEHOLDERS.has(n.toLowerCase())) return "";
  if (DOT_SEGMENT_NAMES.has(n)) {
    log(
      `ignoring device name ${JSON.stringify(n)}: a URL dot segment is ` +
        "unaddressable on /api/agents/<host>/... routes",
    );
    return "";
  }
  if (CONTAINER_ID_RE.test(n)) return "";
  return n;
}

// The Docker daemon's own hostname via the bind-mounted socket — the automated
// cross-OS source (bare Linux -> host hostname; Docker-in-WSL -> the Windows
// machine name). See hub-agent.py docker_host_name().
function dockerHostName() {
  try {
    return execFileSync("docker", ["info", "--format", "{{.Name}}"], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function deviceName() {
  // The env override outranks the placeholder rules (an operator naming a host
  // "localhost" means it), but a dot segment is unaddressable no matter who
  // chose it — and the native launcher exports an operator-set DEVICE_NAME to BOTH
  // processes unvalidated, so this is the path that would split the identity.
  for (const env of ["DEVICE_NAME", "COMPUTERNAME"]) {
    const v = (process.env[env] || "").trim();
    if (!v) continue;
    if (DOT_SEGMENT_NAMES.has(v)) {
      log(
        `ignoring $${env}=${JSON.stringify(v)}: a URL dot segment is ` +
          "unaddressable on /api/agents/<host>/... routes",
      );
      continue;
    }
    return v;
  }
  try {
    const n = usableHostname(fs.readFileSync("/host/etc/hostname", "utf8"));
    if (n) return n;
  } catch {
    /* fall through */
  }
  const dockerName = usableHostname(dockerHostName());
  if (dockerName) return dockerName;
  try {
    const n = usableHostname(os.hostname());
    if (n) return n;
  } catch {
    /* fall through */
  }
  log(
    "device name unresolved: DEVICE_NAME unset, no /host/etc/hostname, no usable " +
      "`docker info` name, and the OS hostname is a container id — falling back " +
      "to 'unknown-device'",
  );
  return "unknown-device";
}

const NAME = deviceName();

// Bridge one data channel: hub data-WS <-> the target session's local ttyd TCP.
// `port` selects which per-session ttyd to dial (defaults to 7681 for safety).
function openDataChannel(ch, port) {
  const url = `${WS_BASE}/agent/data?ch=${encodeURIComponent(ch)}&token=${encodeURIComponent(TOKEN)}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const sock = net.connect(port || DEFAULT_TTYD_PORT, TTYD_HOST);
  // Disable Nagle: terminal traffic is a stream of tiny keystroke/echo packets,
  // and Nagle would coalesce them behind delayed-ACKs (~40ms bursts), making
  // live typing feel choppy. We want each byte on the wire immediately.
  sock.setNoDelay(true);
  let open = false;
  const outbox = []; // ttyd bytes produced before the WS finished connecting

  const closeBoth = () => {
    try { ws.close(); } catch {}
    try { sock.destroy(); } catch {}
  };

  ws.addEventListener("open", () => {
    open = true;
    for (const b of outbox.splice(0)) ws.send(b);
  });
  ws.addEventListener("message", (ev) => {
    const data = typeof ev.data === "string" ? Buffer.from(ev.data) : Buffer.from(ev.data);
    sock.write(data);
  });
  ws.addEventListener("close", closeBoth);
  ws.addEventListener("error", closeBoth);

  sock.on("data", (buf) => {
    if (open) ws.send(buf);
    else outbox.push(Buffer.from(buf));
  });
  sock.on("close", closeBoth);
  sock.on("error", (e) => {
    log(`ttyd connection error on channel ${ch}: ${e.message}`);
    closeBoth();
  });
}

let backoff = 1000;
function connectControl() {
  const url = `${WS_BASE}/agent/control?name=${encodeURIComponent(NAME)}&token=${encodeURIComponent(TOKEN)}`;
  const ws = new WebSocket(url);
  controlWs = ws;

  // Liveness. A dead hub does not necessarily close this socket: when the hub
  // is reached through Cloudflare, the edge holds our end open after the origin
  // dies, so no 'close' ever fires and the reconnect below never runs. The
  // channel then stays wedged forever — every session reads "terminal offline"
  // while hub-agent.py's heartbeat (a separate HTTP POST) keeps the host green.
  //
  // We cannot see the hub's protocol ping: Node's built-in WebSocket answers it
  // internally and exposes neither a ping event nor a ping method. So the hub
  // also sends an app-level {ping} we CAN see, and silence is what we act on.
  let lastMsgAt = Date.now();
  let hubPings = false; // set once the hub proves it sends app-level pings
  let watchdog = null;

  // Reconnect at most once per socket, whether we got here from a real close or
  // from the watchdog. Deliberately does NOT wait on ws.close(): closing a
  // half-open socket waits for a peer close frame that is never coming, so the
  // 'close' event we would be relying on may never arrive. We schedule the
  // reconnect ourselves and let the doomed socket be reaped whenever it likes.
  let retired = false;
  const retire = (reason) => {
    if (retired) return;
    retired = true;
    if (watchdog) clearInterval(watchdog);
    // The channel the deltas ride is gone; stop every tail loop. The hub
    // re-arms the watches once we reconnect, so no state is lost.
    if (controlWs === ws) controlWs = null;
    stopAllWatches();
    const wait = backoff;
    backoff = Math.min(backoff * 2, 30000);
    log(`control channel ${reason}; reconnecting in ${Math.round(wait / 1000)}s`);
    try { ws.close(); } catch {}
    setTimeout(connectControl, wait);
  };

  ws.addEventListener("open", () => {
    backoff = 1000;
    lastMsgAt = Date.now();
    log(`control channel connected to ${WS_BASE} as ${NAME}`);
    // Armed only once the hub has proven it pings (below), so a hub predating
    // the app-level ping never trips this — it just keeps the old behaviour.
    watchdog = setInterval(() => {
      if (!hubPings || retired) return;
      const idle = Date.now() - lastMsgAt;
      if (idle > CONTROL_IDLE_TIMEOUT_MS) retire(`silent for ${Math.round(idle / 1000)}s (hub gone)`);
    }, CONTROL_WATCHDOG_EVERY_MS);
  });
  ws.addEventListener("message", (ev) => {
    lastMsgAt = Date.now(); // any frame proves the hub is still there
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
    } catch {
      return;
    }
    if (!msg) return;
    if (msg.ping) {
      // The hub's liveness beat. Nothing to do but note that this hub sends
      // them, which is what arms the watchdog above.
      hubPings = true;
    } else if (msg.open) {
      const port = Number(msg.port) || DEFAULT_TTYD_PORT;
      openDataChannel(String(msg.open), port);
    } else if (msg.watch) {
      // The hub re-sends a watch for every still-attached glasses client on
      // reconnect, and again whenever a watched session's transcript moves, so
      // startWatch is idempotent (it just refreshes the target).
      startWatch(String(msg.watch), msg.worktreePath ? String(msg.worktreePath) : "",
        msg.transcriptId ? String(msg.transcriptId) : "");
    } else if (msg.unwatch) {
      stopWatch(String(msg.unwatch));
    } else if (msg.poke) {
      pokeHeartbeat();
    }
  });
  ws.addEventListener("close", () => retire("closed"));
  ws.addEventListener("error", (e) => {
    // 'close' fires after 'error'; let it drive the reconnect to avoid double.
    log(`control channel error: ${e.message || "connection failed"}`);
  });
}

// Run-as-script starts the tunnel; being require()d (the parity test in
// agent/tests) just exposes the pure transcript-tail helpers.
if (require.main === module) {
  log(`starting; hub=${WS_BASE} name=${NAME}`);
  connectControl();
} else {
  module.exports = { projectSlug, newestTranscript, sessionTranscript, entryText, entryBlocks, entryRole, entryToolSource, transcriptTail, pokeHeartbeat, parsePaneLiveTurn, liveTurnDecision, parseTaskNotification, parseLocalCommand, parsePaneStatus, isStatusLine, isHintLine, isChecklistLine, cleanHint, stripActivityTail, committedDupe, resolveLiveText, parseAgentList, scanAgentEntry, liveAgentsReport, dshEventsPath, foldDshView, pollDshTurn,
    startWatch, stopWatch, pollWatcher, __setControlSink: (f) => { controlSink = f; }, awaySummaryText, foldQueueOp, entryId, BLOCK_CAPS,
    toolUseDetail, todoItems, fmtDshElapsed, dshStatus,
    usableHostname, deviceName };
}
