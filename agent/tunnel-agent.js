#!/usr/bin/env node
// Reverse-tunnel client for the turma terminal gateway (compose/claude-code.yaml).
//
// Runs in the background of every Turma container (started by
// entrypoint.sh) alongside hub-agent.py — ONE control channel per host, keyed
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
// "worktreePath":<path>} on the control channel; we then tail that ONE
// transcript every LIVE_TAIL_MS and push {"tail":<sessionId>,"entries":[...]}
// deltas straight back on the same control channel (the hub fans them out to
// the watching glasses). {"unwatch":<sessionId>} stops it. Tailing runs only
// while a session is actively watched, so idle sessions cost nothing.
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

// Rich-block caps for the live tail — mirror hub-agent.py BLOCK_CAPS_LIVE. The
// live path ships these ~1s so it uses the tight LIVE caps; a block cut to its
// cap is flagged truncated (the web UI fetches the fuller copy via /history,
// which uses the looser FULL caps on the Python side).
const BLOCK_TEXT_CHARS = Number(process.env.SESSION_BLOCK_TEXT_CHARS) || 4000;
const BLOCK_TOOL_INPUT_CHARS = Number(process.env.SESSION_BLOCK_TOOL_INPUT_CHARS) || 1000;
const BLOCK_TOOL_RESULT_CHARS = Number(process.env.SESSION_BLOCK_TOOL_RESULT_CHARS) || 2000;
const BLOCK_MAX_PER_ENTRY = Number(process.env.SESSION_BLOCK_MAX_PER_ENTRY) || 48;
const BLOCK_CAPS_LIVE = {
  text: BLOCK_TEXT_CHARS,
  input: BLOCK_TOOL_INPUT_CHARS,
  result: BLOCK_TOOL_RESULT_CHARS,
};

// Claude Code's project-dir slug for a worktree cwd: every non-alphanumeric
// char -> '-' (mirrors hub-agent.py _project_slug — a plain '/'->'-' map is
// wrong for the dotted worktree paths this agent uses).
function projectSlug(p) {
  return p.replace(/[^A-Za-z0-9]/g, "-");
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
function tnTag(name, body) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  return m ? m[1].replace(ANSI_RE, "").trim() : "";
}
function parseTaskNotification(text) {
  if (!text) return null;
  const m = TASK_NOTIFICATION_RE.exec(text);
  if (!m) return null;
  const body = m[1];
  return { summary: tnTag("summary", body), status: tnTag("status", body), result: tnTag("result", body) };
}
// Flatten a parsed task-notification to text-feed form (summary + result) —
// mirror of hub-agent.py _tn_preview.
function tnPreview(tn) {
  const parts = [tn.summary || tn.status || "background task update"];
  if (tn.result) parts.push(tn.result);
  return parts.filter(Boolean).join("\n\n");
}

// One transcript entry -> glasses display text, or null to drop it (wrong
// type, no message, tool_result-only turn, empty after ANSI strip). Mirrors
// hub-agent.py _entry_text.
function entryText(entry) {
  const type = entry.type;
  if (type !== "user" && type !== "assistant") return null;
  const msg = entry.message;
  if (!msg || typeof msg !== "object") return null;
  const content = msg.content;
  let text;
  if (typeof content === "string") {
    const tn = parseTaskNotification(content);
    text = tn ? tnPreview(tn) : content;
  } else if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text") {
        const tn = parseTaskNotification(String(block.text || ""));
        parts.push(tn ? tnPreview(tn) : String(block.text || ""));
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

// (clipped, wasTruncated). Mirror of hub-agent.py _clip.
function clip(text, cap) {
  text = text || "";
  if (text.length > cap) return [text.slice(0, cap), true];
  return [text, false];
}

// Common Claude Code tools carry their salient arg under one of these keys.
const TOOL_INPUT_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "prompt"];

// Compact display string for a tool_use `input` — mirror of _tool_input_summary.
function toolInputSummary(inp) {
  if (inp && typeof inp === "object" && !Array.isArray(inp)) {
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

// Flatten a tool_result block's `content` to text — mirror of _tool_result_text.
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        if (block.type === "text") parts.push(String(block.text || ""));
        else if (block.type === "image") parts.push("[image]");
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
  const type = entry.type;
  if (type !== "user" && type !== "assistant") return null;
  const msg = entry.message;
  if (!msg || typeof msg !== "object") return null;
  const content = msg.content;
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
  if (typeof content === "string") {
    const tn = parseTaskNotification(content);
    if (tn) addTaskNotification(tn);
    else addText("text", content, caps.text);
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue;
      if (raw.type === "text") {
        const tn = parseTaskNotification(raw.text || "");
        if (tn) addTaskNotification(tn);
        else addText("text", raw.text || "", caps.text);
      } else if (raw.type === "thinking") {
        addText("thinking", raw.thinking || raw.text || "", caps.text);
      } else if (raw.type === "tool_use" && raw.name) {
        const summary = toolInputSummary(raw.input).replace(ANSI_RE, "").trim();
        const [clipped, trunc] = clip(summary, caps.input);
        const block = { t: "tool_use", name: String(raw.name), input: clipped };
        if (raw.id) block.id = raw.id;
        if (trunc) block.truncated = true;
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

// Last TAIL_MSGS surviving messages of a worktree's newest transcript, oldest
// first: [{id: uuid, role, text}]. [] when there's no transcript yet.
//
// Optional `cache` ({path, mtimeMs, size, result}, one per watched session)
// skips the ~128 KB read+parse when the newest transcript is unchanged since the
// last poll (same file, same mtime+size) — pollWatcher ticks this ~1s per
// session and most ticks find nothing new. newestTranscript already stat'd each
// candidate, so one more stat of the winner is cheap next to re-reading the tail.
function transcriptTail(worktreePath, cache) {
  const p = newestTranscript(worktreePath);
  if (!p) {
    if (cache) { cache.path = null; cache.result = []; }
    return [];
  }
  let st = null;
  try { st = fs.statSync(p); } catch {}
  if (cache && cache.path === p && st &&
      cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    return cache.result; // unchanged since last poll -> reuse, no read+parse
  }
  const tail = [];
  for (const raw of readTailLines(p, TAIL_READ_BYTES)) {
    let entry;
    try { entry = JSON.parse(raw); } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    const text = entryText(entry);
    const blocks = entryBlocks(entry, BLOCK_CAPS_LIVE);
    // Rich path widens inclusion: a tool_result-only turn (text === null) still
    // has renderable blocks, so keep it for the chat UI. text stays the
    // backward-compat flat string the glasses read.
    if (text === null && (!blocks || blocks.length === 0)) continue;
    tail.push({
      id: entry.uuid,
      role: entry.type,
      text: (text || "").slice(0, TAIL_MSG_CHARS),
      blocks: blocks || [],
    });
  }
  const result = tail.slice(-TAIL_MSGS);
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

function sendControl(obj) {
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
// thinking) plus the parsed working-status line as `status` (verb + live token
// up/down counters — see parsePaneStatus), so the hub can pin the working
// indicator to the bottom of the chat instead of letting it bleed into the
// streamed message. Anchored to the stable TUI markers: "esc to interrupt"
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

function parsePaneLiveTurn(pane) {
  const raw = String(pane || "").replace(/\r/g, "");
  if (!/esc to interrupt/i.test(raw)) return { generating: false, text: "", status: null };
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
  let end = lines.length;
  if (bottom >= 0) {
    end = bottom;
    for (let i = bottom - 1; i >= 0 && bottom - i <= 6; i--) {
      if (isRule(lines[i])) { end = i; break; }
    }
  }
  const convo = lines.slice(0, end);
  // The working-status line sits just above the input box. Pull it out (for the
  // pinned status bar) and treat it as the lower bound of the assistant text so
  // its glyph/verb/tokens can't bleed into — or flicker within — the message.
  let statusIdx = -1;
  for (let i = convo.length - 1; i >= 0; i--) {
    if (isStatusLine(convo[i])) { statusIdx = i; break; }
  }
  const status = statusIdx >= 0 ? parsePaneStatus(convo[statusIdx]) : null;
  const body = statusIdx >= 0 ? convo.slice(0, statusIdx) : convo;
  // The in-progress assistant block starts at the last column-0 ● bullet.
  let start = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (/^●\s/.test(body[i])) { start = i; break; }
    if (/^❯/.test(body[i])) break; // hit the user prompt -> no text yet
  }
  if (start < 0) return { generating: true, text: "", status }; // thinking; no text yet
  const block = [];
  for (let i = start; i < body.length; i++) {
    const l = body[i];
    // Stop at the next turn marker (a new ● bullet or the ❯ prompt); the status
    // line is already excluded above, so we needn't guess spinner glyphs here —
    // which also stops markdown "* "/"· " lines being mistaken for a boundary.
    if (i > start && /^[●❯]/.test(l)) break;
    block.push(i === start ? l.replace(/^●\s?/, "") : l.replace(/^ {1,3}/, ""));
  }
  // Reflow the TUI's hard-wrapped lines into flowing text; the glasses re-wrap,
  // and the transcript delivers the authoritative structure on completion.
  const text = block.join(" ").replace(/\s+/g, " ").trim();
  return { generating: true, text, status };
}

// Capture the session's tmux pane (agent-<id>) and extract the in-progress
// assistant turn. Async (execFile, not execFileSync) so a slow/hung capture
// can't block the control-WS event loop.
function captureLiveTurn(sessionId, cb) {
  execFile(
    "tmux",
    ["capture-pane", "-p", "-t", `agent-${sessionId}`],
    { timeout: 2000, maxBuffer: 1 << 20 },
    (err, stdout) => cb(err ? { generating: false, text: "", status: null } : parsePaneLiveTurn(stdout))
  );
}

function pollWatcher(sessionId) {
  const w = watchers.get(sessionId);
  if (!w) return;
  // 1. Committed transcript tail (authoritative history). The per-session cache
  //    skips the read+parse on ticks where the transcript file hasn't changed.
  let entries = null;
  try { entries = transcriptTail(w.worktreePath, w.tailCache); } catch { entries = null; }
  if (entries && entries.length) {
    const json = JSON.stringify(entries);
    if (json !== w.lastJson) {
      w.lastJson = json;
      sendControl({ tail: sessionId, entries });
    }
  }
  // 2. Live in-progress assistant turn scraped from the TUI (real-time). Sent
  //    as its own `turn` delta carrying the streamed text AND the parsed
  //    working-status (verb + token counters) for the hub's pinned status bar;
  //    an empty text + null status clears both (generation ended, so the
  //    committed tail now owns that message). Dedup on text+status together so a
  //    status-only change (the token counter ticking) still pushes an update.
  captureLiveTurn(sessionId, (live) => {
    if (!watchers.has(sessionId)) return; // stopped mid-capture
    const text = live.generating ? live.text : "";
    const status = live.generating ? (live.status || null) : null;
    const key = text + " " + (status ? JSON.stringify(status) : "");
    if (key !== w.lastTurn) {
      w.lastTurn = key;
      sendControl({ turn: sessionId, text, status });
    }
  });
}

function startWatch(sessionId, worktreePath) {
  if (!sessionId || !worktreePath) return;
  const existing = watchers.get(sessionId);
  if (existing) { existing.worktreePath = worktreePath; return; } // already tailing
  if (watchers.size >= MAX_WATCHERS) {
    log(`live tail: at MAX_WATCHERS (${MAX_WATCHERS}); ignoring watch for ${sessionId}`);
    return;
  }
  const w = { worktreePath, lastJson: null, lastTurn: "", timer: null,
    tailCache: { path: null, mtimeMs: 0, size: 0, result: [] } };
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
// to a whole TURMA_INTERVAL later. entrypoint.sh `exec`s hub-agent.py as PID 1
// and starts this tunnel as a child, so PID 1 is the manager; it installs a
// SIGUSR1 handler that cuts its interval sleep short. Best-effort — a failed
// signal (e.g. running outside that entrypoint) just falls back to the
// scheduled beat.
function pokeHeartbeat() {
  try {
    process.kill(1, "SIGUSR1");
  } catch (err) {
    log(`poke failed: ${(err && err.message) || err}`);
  }
}

// ws(s):// base derived from TURMA_URL's scheme.
const WS_BASE = TURMA_URL.replace(/^http/, "ws").replace(/\/+$/, "");

function log(msg) {
  console.log(`[tunnel-agent] ${msg}`);
}

// The physical host name the hub keys agents by. entrypoint.sh resolves it once
// (via `hub-agent.py --print-device`, which includes the SMB probe of the
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

function usableHostname(name) {
  const n = (name || "").trim();
  if (HOSTNAME_PLACEHOLDERS.has(n.toLowerCase())) return "";
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
  for (const env of ["DEVICE_NAME", "COMPUTERNAME"]) {
    const v = (process.env[env] || "").trim();
    if (v) return v;
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

  ws.addEventListener("open", () => {
    backoff = 1000;
    log(`control channel connected to ${WS_BASE} as ${NAME}`);
  });
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
    } catch {
      return;
    }
    if (!msg) return;
    if (msg.open) {
      const port = Number(msg.port) || DEFAULT_TTYD_PORT;
      openDataChannel(String(msg.open), port);
    } else if (msg.watch) {
      // The hub re-sends a watch for every still-attached glasses client on
      // reconnect, so startWatch is idempotent (it just refreshes the path).
      startWatch(String(msg.watch), msg.worktreePath ? String(msg.worktreePath) : "");
    } else if (msg.unwatch) {
      stopWatch(String(msg.unwatch));
    } else if (msg.poke) {
      pokeHeartbeat();
    }
  });
  const reconnect = () => {
    const wait = backoff;
    backoff = Math.min(backoff * 2, 30000);
    setTimeout(connectControl, wait);
  };
  ws.addEventListener("close", () => {
    // The channel the deltas ride is gone; stop every tail loop. The hub
    // re-arms the watches once we reconnect, so no state is lost.
    if (controlWs === ws) controlWs = null;
    stopAllWatches();
    log(`control channel closed; reconnecting in ${Math.round(backoff / 1000)}s`);
    reconnect();
  });
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
  module.exports = { projectSlug, newestTranscript, entryText, entryBlocks, transcriptTail, pokeHeartbeat, parsePaneLiveTurn, parseTaskNotification, parsePaneStatus, isStatusLine, BLOCK_CAPS_LIVE };
}
