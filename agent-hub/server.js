// agent-hub — central dashboard + terminal gateway for the Claude Code containers.
//
// Agents (agent image) reach this server purely OUTBOUND, so hub and
// agents can live on any host/network (all traffic rides agents.xerktech.com):
//   1. hub-agent.py POSTs a status heartbeat every ~20s (a HOST with its repos[]
//      and multiplexed Claude sessions[]) and picks up queued host commands
//      (container restart + per-session spawn/kill/start/restart/resume/delete)
//      on the reply, acking each by cmdId so the hub stops re-sending it.
//   2. tunnel-agent.js holds a persistent WebSocket "control" channel here. To
//      show a live terminal, the hub asks that agent (over the control channel)
//      to dial back a "data" WebSocket; the agent bridges it to its local ttyd
//      (the tmux/Claude TUI). The hub then proxies the browser's /term traffic
//      through that data channel. See the reverse-tunnel section below.
//
// It also pushes edge-triggered alerts to the self-hosted ntfy (grafana.yaml)
// on the `agents` topic: container offline/recovered, restart loops, daily
// cost threshold, turn finished / question waiting for input, and PR created.
// Set NTFY_URL (plus NTFY_USER/NTFY_PASS) to enable; unset disables alerts.
//
// stdlib only — no npm dependencies (the agent dials with Node's built-in
// WebSocket; the hub hand-rolls the WebSocket *server* framing with `crypto`).

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Duplex } = require("stream");

const PORT = parseInt(process.env.PORT || "8300", 10);
const STATE_FILE = process.env.STATE_FILE || "/data/state.json";
const OFFLINE_AFTER_MS = 75 * 1000; // heartbeats arrive every ~20s
const PRUNE_AFTER_MS = 7 * 24 * 3600 * 1000; // drop entries gone for a week

// Single-user auth: HUB_USER/HUB_PASSWORD gate the UI and browser API. The
// browser signs in through a real login form (/login -> POST /api/login) and
// gets a signed, HttpOnly session cookie it replays on every same-origin
// request; Basic auth is still accepted (curl, and the agent heartbeat
// fallback) but browsers never see the native credential popup. HUB_AGENT_TOKEN
// is a bearer token that lets the heartbeat agents in the agent containers
// report without user credentials. Leaving a var unset disables that check
// (open access) — logged loudly at boot since the hub is exposed through the
// Cloudflare tunnel.
const HUB_USER = process.env.HUB_USER || "";
const HUB_PASSWORD = process.env.HUB_PASSWORD || "";
const HUB_AGENT_TOKEN = process.env.HUB_AGENT_TOKEN || "";

// Browser sessions: instead of the native HTTP Basic popup, the UI POSTs to
// /api/login and we hand back a signed, HttpOnly cookie the browser replays on
// every same-origin request (page loads, API, ttyd iframe + WebSocket). Basic
// auth still works for curl/agents, but browsers never see the credential
// prompt. The signing key defaults to a hash of the configured credentials so
// rotating the password invalidates outstanding sessions for free; set
// HUB_SESSION_SECRET to decouple that (e.g. to survive a password rotation).
const SESSION_COOKIE = "hub_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // stay signed in for 30 days
const SESSION_KEY =
  process.env.HUB_SESSION_SECRET ||
  crypto.createHash("sha256").update(`${HUB_USER}\n${HUB_PASSWORD}`).digest("hex");

// Injected on every proxied ttyd request so ttyd's own basic-auth
// (-c term:$HUB_TOKEN, loopback-bound in the container) is satisfied without
// the browser ever seeing the credentials. The terminal shares the agent
// token — one credential per agent container for heartbeat, tunnel, and ttyd.
const TTYD_AUTH = "Basic " + Buffer.from(`term:${HUB_AGENT_TOKEN || "changeme"}`).toString("base64");

const NTFY_URL = (process.env.NTFY_URL || "").replace(/\/$/, "");
const NTFY_TOPIC = process.env.NTFY_TOPIC || "agents";
const NTFY_USER = process.env.NTFY_USER || "";
const NTFY_PASS = process.env.NTFY_PASS || "";
const COST_ALERT_USD = parseFloat(process.env.COST_ALERT_USD || "75");
// A session counts as "working" while its transcript was written to within
// this window (agents report the age at beat time; add staleness since).
const WORKING_WINDOW_MS = 90 * 1000;
// No offline alerts right after hub boot: agents get a chance to re-report
// before we conclude anything from a freshly-loaded (possibly stale) state.
const BOOT_AT = Date.now();
const BOOT_GRACE_MS = 90 * 1000;

// Keyed by containerName (stable across recreates), value = last heartbeat
// payload + bookkeeping.
let agents = {};

// Reverse-tunnel state. controlChannels[name] = the live control connection for
// that container's tunnel-agent; pendingChannels[ch] = resolver awaiting the
// agent's data-WS dial-back for channel `ch`.
const controlChannels = {};
const pendingChannels = {};

// ---- persistence (best-effort: survives hub restarts so the UI isn't blank
// for the first heartbeat interval; losing it is harmless) -------------------
try {
  agents = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  console.log(`loaded ${Object.keys(agents).length} agents from ${STATE_FILE}`);
} catch {
  /* first boot or no volume mounted */
}
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdir(path.dirname(STATE_FILE), { recursive: true }, () => {
      fs.writeFile(STATE_FILE, JSON.stringify(agents), (err) => {
        if (err) console.error(`state save failed: ${err.message}`);
      });
    });
  }, 30 * 1000);
  // Never the only thing keeping the process alive (the listening server is);
  // lets the test runner exit cleanly after exercising the heartbeat handler.
  saveTimer.unref();
}

function prune() {
  const now = Date.now();
  for (const [key, a] of Object.entries(agents)) {
    if (now - (a.lastSeen || 0) > PRUNE_AFTER_MS) delete agents[key];
  }
}

// Append a command to a host's queue with a fresh, stable cmdId. The heartbeat
// reply re-sends the queue every beat until the agent acks the cmdId (at-least-
// once delivery; the agent dedupes). Returns the cmdId for the API response.
function queueCommand(key, cmd) {
  const a = agents[key];
  const cmdId = crypto.randomBytes(6).toString("hex");
  a.commands = a.commands || [];
  a.commands.push({ ...cmd, cmdId });
  scheduleSave();
  return cmdId;
}

// Which HOST owns a given sessionId, and that session's ttyd port. Sessions are
// per-host but sessionIds are globally unique, so /term/<sessionId> can be
// routed by scanning every host's sessions[]. null if no host reports it.
function findSession(sessionId) {
  for (const [key, a] of Object.entries(agents)) {
    for (const s of a.sessions || []) {
      if (s.id === sessionId) return { host: key, port: s.ttydPort };
    }
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1 << 20) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// The single-user credentials, compared in constant time.
function credentialsMatch(user, pass) {
  return safeEqual(user || "", HUB_USER) && safeEqual(pass || "", HUB_PASSWORD);
}

// ---- Login sessions (signed cookie) -----------------------------------------
// A session token is "<expiryMs>.<hmac>" — the browser can't forge it and it
// self-expires. HttpOnly keeps it out of reach of any injected script.
function issueSessionToken() {
  const expiry = Date.now() + SESSION_TTL_MS;
  const mac = crypto.createHmac("sha256", SESSION_KEY).update(String(expiry)).digest("base64url");
  return `${expiry}.${mac}`;
}

function sessionTokenValid(token) {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const expiry = token.slice(0, dot);
  const expNum = parseInt(expiry, 10);
  if (!Number.isFinite(expNum) || expNum < Date.now()) return false;
  const expected = crypto.createHmac("sha256", SESSION_KEY).update(expiry).digest("base64url");
  const got = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(expected);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Mark the cookie Secure only when the request actually arrived over HTTPS
// (Cloudflare sets x-forwarded-proto) so plain-HTTP LAN access still works.
function sessionSetCookie(req, token) {
  const https =
    (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" ||
    !!(req.socket && req.socket.encrypted);
  const maxAge = token ? Math.floor(SESSION_TTL_MS / 1000) : 0;
  return (
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
    (https ? "; Secure" : "")
  );
}

// Browser/user auth (UI + all API except the heartbeat). A valid login cookie
// or the equivalent Basic-auth header (kept for curl and the agent heartbeat
// fallback) both pass.
function userAuthorized(req) {
  if (!HUB_PASSWORD) return true;
  if (sessionTokenValid(cookies(req)[SESSION_COOKIE])) return true;
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString();
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  return credentialsMatch(decoded.slice(0, sep), decoded.slice(sep + 1));
}

// Agent auth (heartbeats). The user credentials also work here, so a curl
// with the basic-auth login can exercise the endpoint.
function agentAuthorized(req) {
  if (!HUB_AGENT_TOKEN) return true;
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return safeEqual(header.slice(7), HUB_AGENT_TOKEN);
  return userAuthorized(req) && !!HUB_PASSWORD;
}

// Agent auth for the tunnel WebSockets. Node's browser-style WebSocket client
// (used by tunnel-agent.js) can't set headers, so the token rides a query
// param; a Bearer header is accepted too for tools that can send one.
function agentWsAuthorized(url, req) {
  if (!HUB_AGENT_TOKEN) return true;
  const token = url.searchParams.get("token");
  if (token) return safeEqual(token, HUB_AGENT_TOKEN);
  return agentAuthorized(req);
}

// ---- ntfy push alerts -------------------------------------------------------
function notify(title, message, opts = {}) {
  if (!NTFY_URL) return;
  const headers = {
    Title: title,
    Tags: opts.tags || "robot",
    Priority: opts.priority || "default",
  };
  if (opts.click) headers.Click = opts.click;
  if (NTFY_USER)
    headers.Authorization =
      "Basic " + Buffer.from(`${NTFY_USER}:${NTFY_PASS}`).toString("base64");
  fetch(`${NTFY_URL}/${NTFY_TOPIC}`, { method: "POST", body: message, headers })
    .then((r) => {
      if (!r.ok) console.error(`ntfy ${r.status} for "${title}"`);
    })
    .catch((e) => console.error(`ntfy failed: ${e.message}`));
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 360) / 10}h`;
}

// Is this session actively working? True while its transcript was written to
// within WORKING_WINDOW_MS (the agent reports the age at beat time; we add the
// staleness since the host's last beat). `lastSeen` is the host's last beat.
function sessionWorking(session, lastSeen, now) {
  const age = session.session?.transcriptAgeSec;
  if (age == null) return false;
  return age * 1000 + Math.max(0, now - (lastSeen || 0)) < WORKING_WINDOW_MS;
}

// Alert checks that key off a fresh heartbeat. `next.alerts` is per-agent
// bookkeeping carried across beats (and persisted, so hub restarts don't
// re-fire or drop edges).
function heartbeatAlerts(key, prev, next) {
  const now = next.lastSeen;
  const alerts = next.alerts;
  const where = next.device ? ` on ${next.device}` : "";

  // Recovery from an alerted offline period.
  const recovered = !!alerts.offlineAt;
  if (recovered) {
    notify(`${key} back online`, `Was offline ${fmtDur(now - alerts.offlineAt)}${where}`, {
      tags: "green_circle",
    });
    delete alerts.offlineAt;
  }

  // Restart loop: several distinct container boots in a short window. A
  // hub-initiated restart contributes one boot, so it can't trip this alone.
  if (next.startedAt && next.startedAt !== prev.startedAt) {
    const boots = (alerts.boots || []).filter((b) => now - b.at < 15 * 60 * 1000);
    boots.push({ s: next.startedAt, at: now });
    alerts.boots = boots.slice(-10);
    const recent = alerts.boots.filter((b) => now - b.at < 10 * 60 * 1000);
    if (recent.length >= 3 && now - (alerts.loopAlertedAt || 0) > 30 * 60 * 1000) {
      alerts.loopAlertedAt = now;
      notify(`${key} restart loop`, `${recent.length} container starts in 10 minutes${where}`, {
        tags: "rotating_light",
        priority: "urgent",
      });
    }
  }

  // Daily cost threshold (API-equivalent estimate): sum across the host's
  // sessions, once per UTC day. Usage persists for stopped sessions too, so a
  // killed session still counts toward the day's total.
  const cost = (next.sessions || []).reduce((sum, s) => sum + (s.usage?.today?.cost || 0), 0);
  const day = new Date(now).toISOString().slice(0, 10);
  if (cost >= COST_ALERT_USD && alerts.costDay !== day) {
    alerts.costDay = day;
    notify(`${key} cost alert`, `Est. $${cost.toFixed(2)} today (threshold $${COST_ALERT_USD})`, {
      tags: "moneybag",
      priority: "high",
    });
  }

  // Per-session events from each session's transcript probe. Bookkeeping is
  // nested per sessionId so questions/PRs/turns don't cross-fire between the
  // several Claude sessions a host runs at once.
  alerts.sessions = alerts.sessions || {};
  const liveIds = new Set();
  for (const session of next.sessions || []) {
    liveIds.add(session.id);
    const sa = (alerts.sessions[session.id] = alerts.sessions[session.id] || { prSeen: [] });
    const label = session.rcName || `${key} · ${session.repo}@${session.branch}`;
    const s = session.session || {}; // null for stopped sessions

    if (s.question && s.question !== sa.lastQuestion) {
      sa.lastQuestion = s.question;
      notify(`${label} has a question`, s.question, { tags: "question", priority: "high" });
    }
    if (!s.question) delete sa.lastQuestion;

    for (const url of s.newPrUrls || []) {
      const seen = sa.prSeen || [];
      if (seen.includes(url)) continue;
      sa.prSeen = [...seen, url].slice(-20);
      notify(`${label} created a PR`, url, { tags: "rocket", click: url });
    }

    // Turn finished: was working, transcript went quiet, and the newest entry
    // is plain assistant output (a pending tool call or question means it's
    // still mid-turn / already alerted above). A beat that just recovered from
    // an offline period skips this — "back online" already covers it and the
    // working->idle edge across the gap is stale.
    const working = sessionWorking(session, next.lastSeen, now);
    if (sa.wasWorking && !working && !recovered && s.lastRole === "assistant" && !s.lastHasToolUse) {
      const repo = session.git?.repoName ? ` · ${session.git.repoName}@${session.git.branch}` : "";
      notify(`${label} finished its turn`, `Waiting for input${repo}`, { tags: "checkered_flag" });
    }
    sa.wasWorking = working;
  }
  // Forget bookkeeping for sessions the host no longer reports (deleted ones;
  // stopped sessions stay in sessions[] and keep theirs).
  for (const id of Object.keys(alerts.sessions)) {
    if (!liveIds.has(id)) delete alerts.sessions[id];
  }
}

// Offline detection is time-driven, not heartbeat-driven, so it needs a sweep.
// unref'd for the same reason as the save timer: the server socket is what
// keeps the process alive in production.
setInterval(() => {
  const now = Date.now();
  if (now - BOOT_AT < BOOT_GRACE_MS) return;
  for (const [key, a] of Object.entries(agents)) {
    const online = now - (a.lastSeen || 0) < OFFLINE_AFTER_MS;
    if (online || a.alerts?.offlineAt) continue;
    // Expected outage: a hub-initiated restart takes the container down for
    // ~30-60s. Alert anyway if it still isn't back after 3 minutes.
    if (a.restartSentAt && now - a.restartSentAt < 3 * 60 * 1000) continue;
    a.alerts = a.alerts || {};
    a.alerts.offlineAt = now;
    const where = a.device ? ` on ${a.device}` : "";
    notify(`${key} offline`, `No heartbeat for ${fmtDur(now - (a.lastSeen || 0))}${where}`, {
      tags: "red_circle",
      priority: "high",
    });
    scheduleSave();
  }
}, 15 * 1000).unref();

const INDEX = fs.readFileSync(path.join(__dirname, "public", "index.html"));
const HISTORY = fs.readFileSync(path.join(__dirname, "public", "history.html"));
const SESSIONS = fs.readFileSync(path.join(__dirname, "public", "sessions.html"));
const LOGIN = fs.readFileSync(path.join(__dirname, "public", "login.html"));
// Bundled web font served to the live terminal. ttyd's page is same-origin
// (proxied under /term/<name>/), so its xterm.js can load this from the hub;
// proxyTerm() injects the matching @font-face. A Nerd Font gives the TUI full
// Unicode + icon coverage regardless of what fonts the viewer's machine has.
const TERM_FONT = fs.readFileSync(path.join(__dirname, "public", "jbm-nerd-mono.woff2"));
// <style> injected into ttyd's HTML document defining that font as 'JBMNerd' —
// the family name the agent points ttyd's fontFamily at (see agent/entrypoint.sh).
const TERM_FONT_STYLE =
  "<style>@font-face{font-family:'JBMNerd';" +
  "src:url('/term-font.woff2') format('woff2');font-display:swap;}</style>";

// ---- minimal WebSocket server framing (RFC 6455) ----------------------------
// We only need enough to carry an opaque byte stream (the agent's ttyd TCP
// wire) plus text control JSON, ping/pong keepalive, and close. Frames FROM the
// agent (a WS client) are masked; frames we send are not. No fragmentation on
// send (one frame per chunk); on receive we treat every data/continuation frame
// as a byte run (order is preserved on the single connection).
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function wsAccept(key) {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}
function wsHandshake(socket, req) {
  const key = req.headers["sec-websocket-key"];
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );
}
function wsEncode(opcode, payload) {
  payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}
// Returns a stateful function fed raw socket chunks; invokes onFrame(op, data).
function wsParser(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      let mask;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);
      onFrame(opcode, payload);
    }
  };
}

// Wrap a handshaken data-WS socket as a raw-byte Duplex: writes become binary
// frames to the agent; the agent's binary frames become readable bytes. Stub
// socket-ish methods so Node's http client can drive it via createConnection.
function channelDuplex(socket) {
  const d = new Duplex({
    write(chunk, _enc, cb) {
      socket.write(wsEncode(0x2, chunk));
      cb();
    },
    read() {},
    final(cb) {
      try { socket.write(wsEncode(0x8, Buffer.alloc(0))); } catch {}
      cb();
    },
    destroy(err, cb) {
      try { socket.destroy(); } catch {}
      cb(err);
    },
  });
  d.setNoDelay = d.setKeepAlive = d.setTimeout = () => d;
  d.ref = d.unref = () => d;
  const parse = wsParser((op, payload) => {
    if (op === 0x8) { d.push(null); socket.end(); }        // close
    else if (op === 0x9) socket.write(wsEncode(0xa, payload)); // ping -> pong
    else if (op === 0xa) { /* pong */ }
    else if (payload.length) d.push(payload);              // binary/text/cont
  });
  socket.on("data", parse);
  socket.on("close", () => { d.push(null); d.destroy(); });
  socket.on("error", () => d.destroy());
  return d;
}

// Ask `name`'s tunnel-agent to dial back a data channel bridged to the given
// local ttyd `port`; resolves with its Duplex once the agent connects (or
// rejects if the tunnel is offline / slow). One control channel per host fans
// out to per-session ttyds by port.
function openChannel(name, port) {
  return new Promise((resolve, reject) => {
    const cc = controlChannels[name];
    if (!cc) return reject(new Error("agent tunnel offline"));
    const ch = crypto.randomBytes(9).toString("hex");
    const timer = setTimeout(() => {
      delete pendingChannels[ch];
      reject(new Error("channel open timeout"));
    }, 10000);
    pendingChannels[ch] = (duplex) => {
      clearTimeout(timer);
      delete pendingChannels[ch];
      resolve(duplex);
    };
    cc.sendOpen(ch, port);
  });
}

// ---- terminal proxy ---------------------------------------------------------
// Proxy an HTTP asset request (ttyd HTML/JS/token) through the agent's tunnel.
// A fresh channel per request, closed by ttyd via Connection: close.
async function proxyTerm(req, res, name, port) {
  let channel;
  try {
    channel = await openChannel(name, port);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    return res.end(`terminal offline: ${e.message}`);
  }
  const headers = { ...req.headers, host: "ttyd", authorization: TTYD_AUTH, connection: "close" };
  // We rewrite ttyd's HTML document to inject the terminal web font, so ask for
  // it uncompressed (small file; avoids having to gunzip before injecting).
  delete headers["accept-encoding"];
  const up = http.request(
    { createConnection: () => channel, method: req.method, path: req.url, headers },
    (upRes) => {
      // Only the top-level HTML document is buffered + rewritten; every other
      // asset (JS, token, favicon) streams straight through as before.
      const ctype = upRes.headers["content-type"] || "";
      if (req.method === "GET" && ctype.includes("text/html")) {
        const chunks = [];
        upRes.on("data", (c) => chunks.push(c));
        upRes.on("end", () => {
          let html = Buffer.concat(chunks).toString("utf8");
          // Insert the @font-face before </head> (fall back to prepending).
          html = html.includes("</head>")
            ? html.replace("</head>", TERM_FONT_STYLE + "</head>")
            : TERM_FONT_STYLE + html;
          const body = Buffer.from(html, "utf8");
          const h = { ...upRes.headers };
          // Content changed; drop framing headers and any CSP that would block
          // an inline <style>/font (the hub is the single-user trust boundary).
          delete h["content-length"];
          delete h["transfer-encoding"];
          delete h["content-security-policy"];
          delete h["content-encoding"];
          h["content-length"] = Buffer.byteLength(body);
          res.writeHead(upRes.statusCode, h);
          res.end(body);
        });
        upRes.on("error", () => {
          if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("terminal error");
        });
        return;
      }
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    }
  );
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`terminal error: ${e.message}`);
  });
  req.pipe(up);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean); // e.g. api/agents/<id>/restart

  try {
    // Unauthenticated liveness probe for the Docker healthcheck (everything
    // informative sits behind auth; this leaks nothing). Without it the
    // healthcheck 401s and autoheal restart-loops the container.
    if (url.pathname === "/healthz") {
      return json(res, 200, { ok: true });
    }

    // Public routes: the login page and its API need no session, and the
    // agent heartbeat carries its own bearer token.
    const isLoginRoute =
      url.pathname === "/login" ||
      url.pathname === "/login.html" ||
      url.pathname === "/api/login" ||
      url.pathname === "/api/logout";

    if (url.pathname === "/api/heartbeat") {
      if (!agentAuthorized(req)) return json(res, 401, { error: "unauthorized" });
    } else if (isLoginRoute) {
      // fall through to the handlers below
    } else if (!userAuthorized(req)) {
      // Everything else — UI, browser API, and the /term/ terminal proxy —
      // rides the login cookie (the browser attaches it to iframe asset
      // requests and WebSocket upgrades automatically). We deliberately do NOT
      // send a WWW-Authenticate header, so browsers never raise the native
      // Basic popup: page navigations bounce to the login form; XHR/asset
      // requests get a plain 401 the client-side code turns into a redirect.
      const wantsHtml = req.method === "GET" && (req.headers.accept || "").includes("text/html");
      if (wantsHtml) {
        const next = url.pathname + url.search;
        const to = next && next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login";
        res.writeHead(302, { Location: to, "Cache-Control": "no-store" });
        return res.end();
      }
      res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }

    // Login form (public). Already-authenticated visitors skip straight in.
    if (req.method === "GET" && (url.pathname === "/login" || url.pathname === "/login.html")) {
      if (userAuthorized(req)) {
        res.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(LOGIN);
    }

    // Validate credentials and hand back the session cookie.
    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (HUB_PASSWORD && !credentialsMatch(body.username, body.password)) {
        return json(res, 401, { error: "invalid credentials" });
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": sessionSetCookie(req, issueSessionToken()),
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    // Drop the session cookie.
    if (req.method === "POST" && url.pathname === "/api/logout") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": sessionSetCookie(req, ""),
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(INDEX);
    }

    if (req.method === "GET" && (url.pathname === "/history" || url.pathname === "/history.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(HISTORY);
    }

    if (req.method === "GET" && (url.pathname === "/sessions" || url.pathname === "/sessions.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(SESSIONS);
    }

    // Web font for the live terminal (referenced by the @font-face proxyTerm
    // injects into ttyd's page). Immutable + long-lived so the browser fetches
    // the ~1 MB file once and caches it.
    if (req.method === "GET" && url.pathname === "/term-font.woff2") {
      res.writeHead(200, {
        "Content-Type": "font/woff2",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      return res.end(TERM_FONT);
    }

    if (req.method === "GET" && url.pathname === "/api/agents") {
      prune();
      const now = Date.now();
      const list = Object.entries(agents).map(([key, a]) => ({
        key,
        ...a,
        online: now - (a.lastSeen || 0) < OFFLINE_AFTER_MS,
        // Only true when this container's reverse tunnel is live right now.
        terminalOnline: !!controlChannels[key],
      }));
      list.sort((x, y) => (x.device + x.key).localeCompare(y.device + y.key));
      return json(res, 200, { now, agents: list });
    }

    if (req.method === "POST" && url.pathname === "/api/heartbeat") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const key = payload.containerName || payload.agentId;
      if (!key) return json(res, 400, { error: "containerName/agentId required" });
      const prev = agents[key] || {};
      const restart = !!prev.restartPending;
      // At-least-once command delivery: drop any queued command the agent
      // reports as executed; keep re-sending the rest until acked.
      const acked = new Set(payload.ackedCommands || []);
      const commands = (prev.commands || []).filter((c) => !acked.has(c.cmdId));
      delete payload.ackedCommands; // don't persist the transient ack list
      const next = (agents[key] = {
        ...payload,
        // Pending host commands (spawn/kill/start/restart/resume/delete)
        // queued by the UI; re-sent on every reply below until acked.
        commands,
        lastSeen: Date.now(),
        restartPending: false,
        // Keep a marker so the UI can show "restarting…" until the container
        // comes back with a fresh startedAt.
        restartSentAt: restart ? Date.now() : prev.restartSentAt,
        // Per-agent alert bookkeeping survives across beats and hub restarts.
        alerts: prev.alerts || {},
      });
      heartbeatAlerts(key, prev, next);
      scheduleSave();
      return json(res, 200, { restart, commands });
    }

    if (req.method === "POST" && parts[0] === "api" && parts[1] === "agents" && parts[3] === "restart") {
      const key = decodeURIComponent(parts[2]);
      if (!agents[key]) return json(res, 404, { error: "unknown agent" });
      agents[key].restartPending = true;
      console.log(`restart queued for ${key}`);
      scheduleSave();
      return json(res, 200, { ok: true });
    }

    // Session command endpoints — each queues a cmdId onto the host's command
    // queue for the agent to pick up on its next heartbeat reply. The host owns
    // the actual worktree/tmux/ttyd lifecycle; the hub only relays intent.
    if (parts[0] === "api" && parts[1] === "agents" && parts[3] === "sessions") {
      const key = decodeURIComponent(parts[2]);
      if (!agents[key]) return json(res, 404, { error: "unknown agent" });

      // POST /api/agents/<host>/sessions -> spawn a new session. Body: {repo}
      // plus the optional "New session" composer fields (#11/#12/#13). Only
      // repo is required; every other field is forwarded verbatim to the agent
      // (which validates it), and omitted when blank so a bare one-click spawn
      // queues exactly {type:"spawn", repo} as before.
      if (req.method === "POST" && parts.length === 4) {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!body.repo) return json(res, 400, { error: "repo required" });
        const cmd = { type: "spawn", repo: body.repo };
        for (const f of ["prompt", "label", "baseRef", "branchName", "model", "permissionMode"]) {
          if (body[f] != null && body[f] !== "") cmd[f] = body[f];
        }
        const cmdId = queueCommand(key, cmd);
        return json(res, 200, { ok: true, cmdId });
      }

      const sessionId = decodeURIComponent(parts[4] || "");
      // POST /api/agents/<host>/sessions/<id>/{kill|start|restart|resume}
      // (resume targets a KILLED session from the host's closedSessions list —
      // the agent re-registers it and relaunches its prior conversation.)
      if (req.method === "POST" && parts.length === 6 &&
          (parts[5] === "kill" || parts[5] === "start" || parts[5] === "restart" || parts[5] === "resume")) {
        const cmdId = queueCommand(key, { type: parts[5], sessionId });
        return json(res, 200, { ok: true, cmdId });
      }
      // DELETE /api/agents/<host>/sessions/<id>
      if (req.method === "DELETE" && parts.length === 5) {
        const cmdId = queueCommand(key, { type: "delete", sessionId });
        return json(res, 200, { ok: true, cmdId });
      }
    }

    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "agents" && parts.length === 3) {
      const key = decodeURIComponent(parts[2]);
      delete agents[key];
      scheduleSave();
      return json(res, 200, { ok: true });
    }

    // Terminal proxy: /term/<sessionId>/… -> the ttyd of the host that owns
    // that session, tunneled to its per-session ttydPort. User auth already
    // enforced by the gate above.
    if (parts[0] === "term" && parts.length >= 2) {
      const sessionId = decodeURIComponent(parts[1]);
      const loc = findSession(sessionId);
      if (!loc) return json(res, 404, { error: "unknown session" });
      return proxyTerm(req, res, loc.host, loc.port);
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 400, { error: err.message });
  }
});

// ---- WebSocket upgrades -----------------------------------------------------
// Three kinds, all on this one port:
//   /agent/control      — an agent's tunnel-agent registering its reverse tunnel
//   /agent/data         — an agent dialing back a data channel we requested
//   /term/<sessionId>/… — a browser attaching to a live session terminal
//                         (routed to the owning host + its ttyd port via tunnel)
server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);

  // Agent control channel: persistent, carries {open:ch, port} requests to the agent.
  if (parts[0] === "agent" && parts[1] === "control") {
    if (!agentWsAuthorized(url, req)) return socket.destroy();
    const name = url.searchParams.get("name");
    if (!name) return socket.destroy();
    wsHandshake(socket, req);
    const send = (op, payload) => {
      try { socket.write(wsEncode(op, payload)); } catch {}
    };
    // Replace any stale channel for this name.
    if (controlChannels[name]) { try { controlChannels[name].socket.destroy(); } catch {} }
    controlChannels[name] = {
      socket,
      // Tell the agent which ttyd port to bridge this data channel to (per
      // session); it defaults to 7681 if the port is ever absent.
      sendOpen: (ch, port) => send(0x1, JSON.stringify({ open: ch, port })),
    };
    console.log(`tunnel connected: ${name}`);
    const ping = setInterval(() => send(0x9, Buffer.alloc(0)), 30000); // beat CF idle timeout
    const parse = wsParser((op) => { if (op === 0x8) socket.end(); }); // agent sends us no data
    socket.on("data", parse);
    const cleanup = () => {
      clearInterval(ping);
      if (controlChannels[name] && controlChannels[name].socket === socket) {
        delete controlChannels[name];
        console.log(`tunnel gone: ${name}`);
      }
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
    return;
  }

  // Agent data channel: pair it with the pending openChannel() awaiting `ch`.
  if (parts[0] === "agent" && parts[1] === "data") {
    if (!agentWsAuthorized(url, req)) return socket.destroy();
    const ch = url.searchParams.get("ch");
    const resolver = pendingChannels[ch];
    if (!resolver) return socket.destroy();
    wsHandshake(socket, req);
    resolver(channelDuplex(socket));
    return;
  }

  // Browser terminal WebSocket: proxy through the agent's tunnel. The browser
  // re-sends the cached basic-auth credentials on same-origin WS upgrades (it
  // already authenticated to load the ttyd iframe assets).
  if (parts[0] === "term" && parts.length >= 2) {
    if (!userAuthorized(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    const sessionId = decodeURIComponent(parts[1]);
    const loc = findSession(sessionId);
    if (!loc) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      return socket.destroy();
    }
    let channel;
    try {
      channel = await openChannel(loc.host, loc.port);
    } catch {
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return socket.destroy();
    }
    // Re-issue the browser's upgrade request to ttyd over the channel; ttyd's
    // 101 + WS frames flow straight back (its accept is keyed off the browser's
    // Sec-WebSocket-Key, which we forward verbatim).
    let reqLines = `${req.method} ${req.url} HTTP/1.1\r\n`;
    const hdrs = { ...req.headers, host: "ttyd", authorization: TTYD_AUTH };
    for (const [k, v] of Object.entries(hdrs)) reqLines += `${k}: ${v}\r\n`;
    channel.write(Buffer.from(reqLines + "\r\n"));
    if (head && head.length) channel.write(head);
    channel.pipe(socket);
    socket.pipe(channel);
    const bail = () => { channel.destroy(); socket.destroy(); };
    channel.on("error", bail);
    channel.on("close", bail);
    socket.on("error", bail);
    socket.on("close", bail);
    return;
  }

  socket.destroy();
});

// Test hooks: when AGENTHUB_TEST is set (never in the image — the Dockerfile
// runs `node server.js` with it unset), export the internals for the test
// suite and skip binding the production port (tests listen on an ephemeral
// port themselves). Production behavior is identical: the guard only decides
// whether to listen.
if (process.env.AGENTHUB_TEST) {
  module.exports = {
    server,
    agents,
    queueCommand,
    findSession,
    wsAccept,
    wsEncode,
    wsParser,
    channelDuplex,
    heartbeatAlerts,
    sessionWorking,
    userAuthorized,
    agentAuthorized,
    agentWsAuthorized,
    safeEqual,
    credentialsMatch,
    issueSessionToken,
    sessionTokenValid,
    fmtDur,
  };
} else {
  if (!HUB_PASSWORD) console.warn("WARNING: HUB_USER/HUB_PASSWORD not set — UI is unauthenticated");
  if (!HUB_AGENT_TOKEN) console.warn("WARNING: HUB_AGENT_TOKEN not set — heartbeat and tunnel endpoints are unauthenticated");
  server.listen(PORT, () => {
    console.log(`agent-hub listening on :${PORT}`);
    console.log(
      NTFY_URL
        ? `ntfy alerts -> ${NTFY_URL}/${NTFY_TOPIC} (cost threshold $${COST_ALERT_USD}/day)`
        : "ntfy alerts disabled (NTFY_URL not set)"
    );
  });
}
