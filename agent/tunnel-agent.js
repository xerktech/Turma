#!/usr/bin/env node
// Reverse-tunnel client for the agent-hub terminal gateway (compose/claude-code.yaml).
//
// Runs in the background of every AgentHub container (started by
// entrypoint.sh) alongside hub-agent.py — ONE control channel per host, keyed
// by the host name. It keeps a persistent OUTBOUND WebSocket to the hub's
// control endpoint. When a browser opens a session's terminal in the Agent Hub,
// the hub sends {"open":<ch>,"port":<ttydPort>} on that control channel; we then
// dial back a data WebSocket for <ch> and bridge it to THAT session's local ttyd
// (127.0.0.1:<port>). The host multiplexes N per-session ttyds (one per port,
// allocated from TTYD_PORT_BASE by the manager); data channels fan out to them
// by port while the single control channel stays per-host. Because every
// connection here is outbound to HUB_URL, the hub and this container can live on
// different hosts/networks — no inbound reachability required.
//
// Zero dependencies: Node's built-in global WebSocket does all client-side
// framing/masking; we only shovel bytes between it and a net.Socket.

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HUB_URL = process.env.HUB_URL || "http://agent-hub:8300";
// Same agent token hub-agent.py heartbeats with (the hub's HUB_AGENT_TOKEN).
// Sent as a query param because the browser-style WebSocket client can't set
// an Authorization header.
const TOKEN = process.env.HUB_TOKEN || "";
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
// transcript_tail / _entry_text / _project_slug (kept byte-for-byte compatible
// so the glasses get the same entries whether they arrive via this fast path
// or the 20s heartbeat). If that Python changes shape, change this too.
const PROJECTS_ROOT = process.env.CLAUDE_PROJECTS_ROOT || "/root/.claude/projects";
const LIVE_TAIL_MS = Number(process.env.LIVE_TAIL_MS) || 1000;
const TAIL_MSGS = Number(process.env.SESSION_TAIL_MSGS) || 30;
const TAIL_MSG_CHARS = Number(process.env.SESSION_TAIL_MSG_CHARS) || 500;
const TAIL_READ_BYTES = 1 << 17; // ~128 KB, matches _tail_entries
const MAX_WATCHERS = 16; // safety cap on concurrent live tails
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

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
    text = content;
  } else if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text") parts.push(String(block.text || ""));
      else if (block.type === "tool_use" && block.name) parts.push(`[${block.name}]`);
      // "thinking" and "tool_result" blocks are dropped.
    }
    text = parts.join("");
  } else {
    return null;
  }
  text = text.replace(ANSI_RE, "").trim();
  return text || null;
}

// Last TAIL_MSGS surviving messages of a worktree's newest transcript, oldest
// first: [{id: uuid, role, text}]. [] when there's no transcript yet.
function transcriptTail(worktreePath) {
  const p = newestTranscript(worktreePath);
  if (!p) return [];
  const tail = [];
  for (const raw of readTailLines(p, TAIL_READ_BYTES)) {
    let entry;
    try { entry = JSON.parse(raw); } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    const text = entryText(entry);
    if (text === null) continue;
    tail.push({ id: entry.uuid, role: entry.type, text: text.slice(0, TAIL_MSG_CHARS) });
  }
  return tail.slice(-TAIL_MSGS);
}

// The live control WebSocket the tail deltas ride back on, and the set of
// sessions currently being tailed. Both owned by connectControl below.
let controlWs = null;
const watchers = new Map(); // sessionId -> { worktreePath, lastJson, timer }

function pollWatcher(sessionId) {
  const w = watchers.get(sessionId);
  if (!w) return;
  let entries;
  try { entries = transcriptTail(w.worktreePath); } catch { return; }
  if (!entries.length) return; // no transcript yet, or nothing displayable
  const json = JSON.stringify(entries);
  if (json === w.lastJson) return; // unchanged since the last beat — don't spam
  w.lastJson = json;
  if (controlWs && controlWs.readyState === WebSocket.OPEN) {
    try { controlWs.send(JSON.stringify({ tail: sessionId, entries })); } catch {}
  }
}

function startWatch(sessionId, worktreePath) {
  if (!sessionId || !worktreePath) return;
  const existing = watchers.get(sessionId);
  if (existing) { existing.worktreePath = worktreePath; return; } // already tailing
  if (watchers.size >= MAX_WATCHERS) {
    log(`live tail: at MAX_WATCHERS (${MAX_WATCHERS}); ignoring watch for ${sessionId}`);
    return;
  }
  const w = { worktreePath, lastJson: null, timer: null };
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
// to a whole HUB_INTERVAL later. entrypoint.sh `exec`s hub-agent.py as PID 1
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

// ws(s):// base derived from HUB_URL's scheme.
const WS_BASE = HUB_URL.replace(/^http/, "ws").replace(/\/+$/, "");

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
  module.exports = { projectSlug, newestTranscript, entryText, transcriptTail, pokeHeartbeat };
}
