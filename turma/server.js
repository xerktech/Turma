// turma — central dashboard + terminal gateway for the Claude Code containers.
//
// Agents (agent image) reach this server purely OUTBOUND, so hub and
// agents can live on any host/network (all traffic rides turma.xerktech.com):
//   1. hub-agent.py POSTs a status heartbeat every ~20s (a HOST with its repos[]
//      and multiplexed Claude sessions[]) and picks up queued host commands
//      (per-session spawn/kill/start/restart/resume/delete) on the reply, acking
//      each by cmdId so the hub stops re-sending it.
//   2. tunnel-agent.js holds a persistent WebSocket "control" channel here. To
//      show a live terminal, the hub asks that agent (over the control channel)
//      to dial back a "data" WebSocket; the agent bridges it to its local ttyd
//      (the tmux/Claude TUI). The hub then proxies the browser's /term traffic
//      through that data channel. See the reverse-tunnel section below.
//
// It also pushes edge-triggered alerts to the self-hosted ntfy (grafana.yaml)
// on the `agents` topic: container offline/recovered, crash loops, daily
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
const HISTORY_FRESH_MS = 5 * 60 * 1000; // serve cached session history under this age
const HISTORY_MAX_AGE_MS = 10 * 60 * 1000; // evict cache entries older than this
const HISTORY_MAX_SESSIONS = 8; // cap per-host cache; oldest fetchedAt evicted first

// Single-user auth: TURMA_USER/TURMA_PASSWORD gate the UI and browser API. The
// browser signs in through a real login form (/login -> POST /api/login) and
// gets a signed, HttpOnly session cookie it replays on every same-origin
// request; Basic auth is still accepted (curl, and the agent heartbeat
// fallback) but browsers never see the native credential popup. TURMA_AGENT_TOKEN
// is a bearer token that lets the heartbeat agents in the agent containers
// report without user credentials. Leaving a var unset disables that check
// (open access) — logged loudly at boot since the hub is exposed through the
// Cloudflare tunnel.
const TURMA_USER = process.env.TURMA_USER || "";
const TURMA_PASSWORD = process.env.TURMA_PASSWORD || "";
const TURMA_AGENT_TOKEN = process.env.TURMA_AGENT_TOKEN || "";

// Browser sessions: instead of the native HTTP Basic popup, the UI POSTs to
// /api/login and we hand back a signed, HttpOnly cookie the browser replays on
// every same-origin request (page loads, API, ttyd iframe + WebSocket). Basic
// auth still works for curl/agents, but browsers never see the credential
// prompt. The signing key defaults to a hash of the configured credentials so
// rotating the password invalidates outstanding sessions for free; set
// TURMA_SESSION_SECRET to decouple that (e.g. to survive a password rotation).
const SESSION_COOKIE = "hub_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // stay signed in for 30 days
const SESSION_KEY =
  process.env.TURMA_SESSION_SECRET ||
  crypto.createHash("sha256").update(`${TURMA_USER}\n${TURMA_PASSWORD}`).digest("hex");

// Injected on every proxied ttyd request so ttyd's own basic-auth
// (-c term:$TURMA_TOKEN, loopback-bound in the container) is satisfied without
// the browser ever seeing the credentials. The terminal shares the agent
// token — one credential per agent container for heartbeat, tunnel, and ttyd.
const TTYD_AUTH = "Basic " + Buffer.from(`term:${TURMA_AGENT_TOKEN || "changeme"}`).toString("base64");

const NTFY_URL = (process.env.NTFY_URL || "").replace(/\/$/, "");
const NTFY_TOPIC = process.env.NTFY_TOPIC || "agents";
const NTFY_USER = process.env.NTFY_USER || "";
const NTFY_PASS = process.env.NTFY_PASS || "";
const COST_ALERT_USD = parseFloat(process.env.COST_ALERT_USD || "75");

// Whisper STT: the glasses client streams mic PCM to us over /audio and we
// wrap+POST it to an external OpenAI-compatible Whisper server on finalize.
// Unset WHISPER_URL disables STT (the WS endpoint still works; it just
// returns an `unavailable` transcript instead of erroring).
const WHISPER_URL = process.env.WHISPER_URL || "";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "";
const WHISPER_API_KEY = process.env.WHISPER_API_KEY || "";
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || "en";
const WHISPER_TIMEOUT_MS = parseInt(process.env.WHISPER_TIMEOUT_MS || "30000", 10);
// A session counts as "working" while its transcript was written to within
// this window (agents report the age at beat time; add staleness since).
const WORKING_WINDOW_MS = 90 * 1000;
// No offline alerts right after hub boot: agents get a chance to re-report
// before we conclude anything from a freshly-loaded (possibly stale) state.
const BOOT_AT = Date.now();
const BOOT_GRACE_MS = 90 * 1000;

// Keyed by the host name (`device`), value = last heartbeat payload +
// bookkeeping. One container per host, so the host name is the stable identity.
let agents = {};

// Reverse-tunnel state. controlChannels[name] = the live control connection for
// that container's tunnel-agent; pendingChannels[ch] = resolver awaiting the
// agent's data-WS dial-back for channel `ch`.
const controlChannels = {};
const pendingChannels = {};
// Live transcript subscribers: liveClients[host][sessionId] = Set of glasses
// WebSocket sockets watching that session's transcript in near-real-time (see
// the /live upgrade handler). The hub asks the host's tunnel-agent to tail a
// session only while at least one socket here is watching it, and fans the
// agent's `{tail, entries}` deltas back out to that set.
const liveClients = {};

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

// ---- /api/agents payload cache + SSE fanout ---------------------------------
// The dashboard fleet payload is polled by every browser but changes only on a
// heartbeat ingest or a state mutation (a command queued, a host removed, a
// tunnel coming up/down, the offline sweep) — NOT between the ~20s beats.
// Memoize the serialized body + its ETag so an idle poll costs a cheap 304,
// and invalidate on every event that can change it. Separately, /api/events is
// an SSE stream that pushes the updated per-agent record to open dashboards the
// instant a beat lands, so Kill/Spawn/Restart/new-question/finished-turn show
// near-instantly instead of on the next poll (see FIX 1/#1, FIX 3/#9).
let agentsCache = null; // { body, etag } or null when stale
const sseClients = new Set(); // open /api/events response streams

function invalidateAgentsCache() { agentsCache = null; }

// One agent record shaped exactly as /api/agents returns it: the (potentially
// large) history cache stripped, plus the two time/tunnel-derived live flags.
// Shared by the fleet payload and the SSE per-agent push so both stay in
// lockstep.
function serializeAgent(key, agent, now) {
  const { history, ...a } = agent;
  return {
    key,
    ...a,
    online: now - (a.lastSeen || 0) < OFFLINE_AFTER_MS,
    // Only true when this container's reverse tunnel is live right now.
    terminalOnline: !!controlChannels[key],
  };
}

// Build (and memoize) the full fleet payload the way /api/agents returns it.
function buildAgentsCache() {
  prune();
  const now = Date.now();
  const list = Object.entries(agents).map(([key, a]) => serializeAgent(key, a, now));
  list.sort((x, y) => (x.device + x.key).localeCompare(y.device + y.key));
  const body = JSON.stringify({ now, agents: list });
  const etag = '"' + crypto.createHash("sha1").update(body).digest("base64") + '"';
  agentsCache = { body, etag };
  return agentsCache;
}

// Push one Server-Sent Event to every open /api/events stream (best-effort; a
// dead stream is dropped on its next failed write and by its "close" handler).
function sseBroadcast(event, dataObj) {
  if (!sseClients.size) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { sseClients.delete(res); }
  }
}

// A host's serialized state changed: drop the cached fleet payload and push the
// fresh record to every subscribed dashboard. Safe to call for a missing key
// (invalidates the cache; skips the push).
function publishAgent(key) {
  invalidateAgentsCache();
  const a = agents[key];
  if (a) sseBroadcast("agent", serializeAgent(key, a, Date.now()));
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
  // The queued command is part of the serialized record — refresh the cache and
  // push it so other open dashboards reflect the in-flight command right away.
  publishAgent(key);
  // Poke the agent (if its control tunnel is up) to heartbeat immediately, so
  // the command it just enqueued is delivered in the next beat's reply within
  // ~a round-trip rather than up to a whole TURMA_INTERVAL later. A missed poke
  // (tunnel down) just falls back to the normal interval — the command still
  // rides the next scheduled beat.
  const cc = controlChannels[key];
  if (cc) {
    try {
      cc.sendPoke();
    } catch {
      /* best-effort; the interval beat is the fallback */
    }
  }
  return cmdId;
}

// Merge the agent's on-demand history deliveries (heartbeat `historyResults`)
// into the host's per-session cache, then bound its memory: drop entries older
// than HISTORY_MAX_AGE_MS and cap the cache at HISTORY_MAX_SESSIONS, evicting
// the oldest `fetchedAt` first. Runs on every heartbeat ingest, even absent new
// results, so the sweep still bounds memory on quiet hosts.
function ingestHistory(agent, historyResults) {
  const now = Date.now();
  for (const r of historyResults || []) {
    if (!r || !r.sessionId) continue;
    agent.history[r.sessionId] = { entries: r.entries, truncated: r.truncated, fetchedAt: now };
  }
  for (const [sessionId, h] of Object.entries(agent.history)) {
    if (now - h.fetchedAt > HISTORY_MAX_AGE_MS) delete agent.history[sessionId];
  }
  const over = Object.keys(agent.history).length - HISTORY_MAX_SESSIONS;
  if (over > 0) {
    Object.entries(agent.history)
      .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
      .slice(0, over)
      .forEach(([sessionId]) => delete agent.history[sessionId]);
  }
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
  return safeEqual(user || "", TURMA_USER) && safeEqual(pass || "", TURMA_PASSWORD);
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

// ---- ws-token (short-lived, query-string auth for the /audio WebSocket) ----
// Browser `WebSocket` can't send an Authorization header, so the glasses
// client fetches one of these over authenticated HTTP (GET /api/ws-token)
// and passes it as ?auth=. Same "<payload>.<hmac>" shape as the session
// cookie, but scoped with a "ws." prefix in both the token and the MAC input
// so session cookies and ws-tokens can never be used in place of each other.
const WS_TOKEN_TTL_MS = 5 * 60 * 1000;
function issueWsToken() {
  const expiry = Date.now() + WS_TOKEN_TTL_MS;
  const mac = crypto.createHmac("sha256", SESSION_KEY).update(`ws.${expiry}`).digest("base64url");
  return `ws.${expiry}.${mac}`;
}

function wsTokenValid(token) {
  if (!token || !token.startsWith("ws.")) return false;
  const rest = token.slice(3);
  const dot = rest.indexOf(".");
  if (dot < 0) return false;
  const expiry = rest.slice(0, dot);
  const expNum = parseInt(expiry, 10);
  if (!Number.isFinite(expNum) || expNum < Date.now()) return false;
  const expected = crypto.createHmac("sha256", SESSION_KEY).update(`ws.${expiry}`).digest("base64url");
  const got = Buffer.from(rest.slice(dot + 1));
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
//
// Over HTTPS the cookie is SameSite=None; Secure; Partitioned so the dashboard
// works when it's embedded as a cross-site iframe (the glasses client's phone
// view loads the real dashboard in an iframe). SameSite=Lax would be dropped
// in that third-party context. Partitioned (CHIPS) keys the cookie to the
// embedding top-level site, so it still works where third-party cookies are
// blocked AND is never shared with any other embedder — it doesn't broaden
// the hub's cross-site exposure the way a bare SameSite=None would. Plain
// HTTP (LAN/dev) can't use SameSite=None (it requires Secure), so it stays Lax.
function sessionSetCookie(req, token) {
  const https =
    (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" ||
    !!(req.socket && req.socket.encrypted);
  const maxAge = token ? Math.floor(SESSION_TTL_MS / 1000) : 0;
  const base = `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Max-Age=${maxAge}`;
  return https
    ? `${base}; SameSite=None; Secure; Partitioned`
    : `${base}; SameSite=Lax`;
}

// Browser/user auth (UI + all API except the heartbeat). A valid login cookie
// or the equivalent Basic-auth header (kept for curl and the agent heartbeat
// fallback) both pass.
function userAuthorized(req) {
  if (!TURMA_PASSWORD) return true;
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
  if (!TURMA_AGENT_TOKEN) return true;
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return safeEqual(header.slice(7), TURMA_AGENT_TOKEN);
  return userAuthorized(req) && !!TURMA_PASSWORD;
}

// Agent auth for the tunnel WebSockets. Node's browser-style WebSocket client
// (used by tunnel-agent.js) can't set headers, so the token rides a query
// param; a Bearer header is accepted too for tools that can send one.
function agentWsAuthorized(url, req) {
  if (!TURMA_AGENT_TOKEN) return true;
  const token = url.searchParams.get("token");
  if (token) return safeEqual(token, TURMA_AGENT_TOKEN);
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

  // Crash loop: several distinct container boots in a short window (the
  // container restarting itself, e.g. on repeated crashes).
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

  // Daily cost threshold (API-equivalent estimate), once per UTC day. Prefer the
  // host-level `usage` block, which the agent aggregates from ALL transcripts —
  // so killed/deleted sessions still count. Fall back to summing live sessions
  // for agents that predate that block.
  const cost = next.usage
    ? (next.usage.today?.cost || 0)
    : (next.sessions || []).reduce((sum, s) => sum + (s.usage?.today?.cost || 0), 0);
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
    a.alerts = a.alerts || {};
    a.alerts.offlineAt = now;
    const where = a.device ? ` on ${a.device}` : "";
    notify(`${key} offline`, `No heartbeat for ${fmtDur(now - (a.lastSeen || 0))}${where}`, {
      tags: "red_circle",
      priority: "high",
    });
    scheduleSave();
    // The host just crossed to offline — invalidate the cached payload (whose
    // `online` flag is now stale) and push the transition to dashboards.
    publishAgent(key);
  }
}, 15 * 1000).unref();

const INDEX = fs.readFileSync(path.join(__dirname, "public", "index.html"));
const HISTORY = fs.readFileSync(path.join(__dirname, "public", "history.html"));
const SESSIONS = fs.readFileSync(path.join(__dirname, "public", "sessions.html"));
const LOGIN = fs.readFileSync(path.join(__dirname, "public", "login.html"));

// Branded static assets: the shared stylesheet, self-hosted UI fonts (Inter +
// Space Grotesk), and the icon/favicon set + web manifest. Read once into memory
// and served UNAUTHENTICATED from an explicit allowlist (see the router) — the
// login page must render its CSS/fonts/icon before any session cookie exists,
// and none of this leaks anything (same rationale as /healthz). Icons/fonts are
// content-hash-stable so they cache hard; app.css uses a short TTL so UI edits
// propagate on the next deploy without a stale cache.
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
// Filenames are hardcoded string literals (no request data reaches path.join) so
// there's no path-traversal surface; the request only ever indexes this fixed map.
const STATIC_ASSETS = {
  "/app.css":              { body: fs.readFileSync(path.join(__dirname, "public", "app.css")),             type: "text/css; charset=utf-8",                  cache: "public, max-age=300" },
  "/favicon.svg":          { body: fs.readFileSync(path.join(__dirname, "public", "favicon.svg")),         type: "image/svg+xml",                            cache: IMMUTABLE_CACHE },
  "/favicon.ico":          { body: fs.readFileSync(path.join(__dirname, "public", "favicon.ico")),         type: "image/x-icon",                             cache: IMMUTABLE_CACHE },
  "/favicon-16.png":       { body: fs.readFileSync(path.join(__dirname, "public", "favicon-16.png")),      type: "image/png",                                cache: IMMUTABLE_CACHE },
  "/favicon-32.png":       { body: fs.readFileSync(path.join(__dirname, "public", "favicon-32.png")),      type: "image/png",                                cache: IMMUTABLE_CACHE },
  "/apple-touch-icon.png": { body: fs.readFileSync(path.join(__dirname, "public", "apple-touch-icon.png")), type: "image/png",                               cache: IMMUTABLE_CACHE },
  "/icon-192.png":         { body: fs.readFileSync(path.join(__dirname, "public", "icon-192.png")),        type: "image/png",                                cache: IMMUTABLE_CACHE },
  "/icon-512.png":         { body: fs.readFileSync(path.join(__dirname, "public", "icon-512.png")),        type: "image/png",                                cache: IMMUTABLE_CACHE },
  "/site.webmanifest":     { body: fs.readFileSync(path.join(__dirname, "public", "site.webmanifest")),    type: "application/manifest+json; charset=utf-8", cache: "public, max-age=3600" },
  "/fonts/inter-latin-wght-normal.woff2":         { body: fs.readFileSync(path.join(__dirname, "public", "fonts", "inter-latin-wght-normal.woff2")),         type: "font/woff2", cache: IMMUTABLE_CACHE },
  "/fonts/space-grotesk-latin-wght-normal.woff2": { body: fs.readFileSync(path.join(__dirname, "public", "fonts", "space-grotesk-latin-wght-normal.woff2")), type: "font/woff2", cache: IMMUTABLE_CACHE },
};

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

// Touch-scroll shim injected into ttyd's page for phones. The Claude TUI owns
// the alternate screen buffer, so xterm.js has no scrollable viewport — it only
// scrolls by translating *wheel* events into arrow-key sequences. A touchscreen
// produces no wheel events, so a finger drag scrolls nothing. This maps a
// one-finger vertical drag onto synthetic WheelEvents on the terminal element,
// which xterm.js then turns into scrolling just like a real mouse wheel.
// `touch-action:none` stops the browser hijacking the same drag for pan/refresh.
// STEP is dispatched a whole chunk at a time (well above any plausible row
// height) so each synthetic wheel is >=1 line and never rounds to zero in the
// alt buffer; the accumulator carries the sub-STEP remainder, keeping total
// scroll proportional to finger travel — a fast flick emits many chunks.
const TERM_TOUCH_SCROLL =
  "<style>.xterm,.xterm-viewport,.xterm-screen{touch-action:none;}</style>" +
  "<script>(function(){var STEP=30,y=null,acc=0;" +
  "function el(){return document.querySelector('.xterm');}" +
  "addEventListener('touchstart',function(e){" +
  "if(e.touches.length===1){y=e.touches[0].clientY;acc=0;}else{y=null;}}," +
  "{passive:false});" +
  "addEventListener('touchmove',function(e){" +
  "if(y===null||e.touches.length!==1)return;var t=el();if(!t)return;" +
  "var ny=e.touches[0].clientY;acc+=y-ny;y=ny;e.preventDefault();" +
  "while(Math.abs(acc)>=STEP){var d=acc>0?STEP:-STEP;acc-=d;" +
  "t.dispatchEvent(new WheelEvent('wheel',{deltaY:d," +
  "deltaMode:0,bubbles:true,cancelable:true}));}},{passive:false});" +
  "addEventListener('touchend',function(){y=null;},{passive:false});" +
  "})();</script>";

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

// ---- Whisper STT -------------------------------------------------------------
// The glasses client streams raw 16 kHz signed 16-bit little-endian mono PCM
// over the /audio WebSocket; on finalize we wrap it in a WAV container and
// POST it to an external OpenAI-compatible Whisper server.

// Pure function: raw PCM -> a Buffer with a 44-byte RIFF/WAVE header in front
// of it, describing 16 kHz s16le mono audio.
function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(16000, 24); // sample rate
  header.writeUInt32LE(32000, 28); // byte rate (sampleRate * blockAlign)
  header.writeUInt16LE(2, 32); // block align (channels * bitsPerSample/8)
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Never throws — every failure mode (disabled, non-OK response, network
// error/timeout, bad JSON) resolves to {text:"", unavailable:true, reason}.
async function transcribePcm(pcm) {
  if (!WHISPER_URL) return { text: "", unavailable: true, reason: "whisper not configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append("file", new Blob([pcmToWav(pcm)]), "audio.wav");
    form.append("response_format", "json");
    if (WHISPER_MODEL) form.append("model", WHISPER_MODEL);
    if (WHISPER_LANGUAGE) form.append("language", WHISPER_LANGUAGE);
    const headers = {};
    if (WHISPER_API_KEY) headers.Authorization = `Bearer ${WHISPER_API_KEY}`;
    const res = await fetch(WHISPER_URL, {
      method: "POST",
      body: form,
      headers,
      signal: controller.signal,
    });
    if (!res.ok) return { text: "", unavailable: true, reason: `whisper returned ${res.status}` };
    const body = await res.json();
    let text = body.text;
    if (text == null && body.transcription != null) {
      text = Array.isArray(body.transcription)
        ? body.transcription.map((seg) => (seg && seg.text) || "").join("")
        : body.transcription;
    }
    const result = { text: String(text == null ? "" : text).trim() };
    if (body.language != null) result.language = body.language;
    return result;
  } catch (e) {
    return { text: "", unavailable: true, reason: e.message };
  } finally {
    clearTimeout(timer);
  }
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

// ---- live transcript relay --------------------------------------------------
// The near-real-time tail path. The glasses open /live/<host>/<session>; the
// hub tells that host's tunnel-agent (over the persistent control channel) to
// start tailing the one transcript, and fans the agent's `{tail, entries}`
// deltas back to every socket watching that session. Everything here is
// best-effort: if the control channel is offline the glasses simply keep
// getting the (slower) heartbeat tail via the poll.

// The session's worktree path as last reported on a heartbeat — what the agent
// needs to locate the transcript. null if the session isn't known.
function worktreePathFor(host, sessionId) {
  const sess = (agents[host]?.sessions || []).find((s) => s.id === sessionId);
  return sess?.worktreePath || null;
}

// Send one JSON text frame to a single live subscriber socket (best-effort).
function sendLive(socket, obj) {
  try {
    socket.write(wsEncode(0x1, JSON.stringify(obj)));
  } catch {
    /* socket already gone; cleanup runs on its close/error */
  }
}

// Fan a delta out to every socket watching (host, sessionId).
function liveFanout(host, sessionId, obj) {
  const set = liveClients[host]?.[sessionId];
  if (!set) return;
  for (const socket of set) sendLive(socket, obj);
}

// ---- terminal proxy ---------------------------------------------------------
// Proxy an HTTP asset request (ttyd HTML/JS/token) through the agent's tunnel.
//
// FIX 4/#8: ttyd serves several assets (HTML, JS, CSS, the auth token) plus the
// WS upgrade for one terminal open. Opening a fresh data channel per asset — a
// full agent dial-back handshake (openChannel, ~a Cloudflare round-trip) each —
// serialized the terminal's time-to-interactive. Instead we keep a per-host:port
// keep-alive http.Agent whose createConnection dials a data channel via
// openChannel: HTTP/1.1 keep-alive to ttyd (libwebsockets) lets the browser's
// asset requests reuse a warm channel instead of each re-handshaking, and Node's
// Agent transparently opens a new one if a pooled channel died. The separate WS
// upgrade path (browser terminal socket) still opens its own dedicated channel.
const termAgents = new Map(); // "host:port" -> keep-alive http.Agent over the tunnel
function termAgentFor(name, port) {
  const key = name + ":" + port;
  let agent = termAgents.get(key);
  if (agent) return agent;
  agent = new http.Agent({ keepAlive: true, maxSockets: 6, maxFreeSockets: 4, timeout: 60000 });
  // Each "socket" the Agent needs is a fresh tunnel data channel to this ttyd;
  // once ttyd keeps it alive the Agent reuses it for the next asset request.
  agent.createConnection = (_opts, cb) => {
    openChannel(name, port).then((channel) => cb(null, channel), (err) => cb(err));
  };
  termAgents.set(key, agent);
  return agent;
}
// Tear down a host's pooled terminal channels when its tunnel drops, so a later
// asset request opens a fresh channel instead of reusing a dead one.
function dropTermAgents(name) {
  for (const [key, agent] of termAgents) {
    if (key === name || key.startsWith(name + ":")) {
      try { agent.destroy(); } catch {}
      termAgents.delete(key);
    }
  }
}
async function proxyTerm(req, res, name, port) {
  const headers = { ...req.headers, host: "ttyd", authorization: TTYD_AUTH };
  // Keep-alive over the pooled channel — drop any client-sent Connection header
  // so ttyd keeps the tunnel channel open for the next asset instead of closing.
  delete headers.connection;
  // We rewrite ttyd's HTML document to inject the terminal web font, so ask for
  // it uncompressed (small file; avoids having to gunzip before injecting).
  delete headers["accept-encoding"];
  const up = http.request(
    { agent: termAgentFor(name, port), host: name, port, method: req.method, path: req.url, headers },
    (upRes) => {
      // Only the top-level HTML document is buffered + rewritten; every other
      // asset (JS, token, favicon) streams straight through as before.
      const ctype = upRes.headers["content-type"] || "";
      if (req.method === "GET" && ctype.includes("text/html")) {
        const chunks = [];
        upRes.on("data", (c) => chunks.push(c));
        upRes.on("end", () => {
          let html = Buffer.concat(chunks).toString("utf8");
          // Insert the @font-face + touch-scroll shim before </head> (fall
          // back to prepending).
          const inject = TERM_FONT_STYLE + TERM_TOUCH_SCROLL;
          html = html.includes("</head>")
            ? html.replace("</head>", inject + "</head>")
            : inject + html;
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
  const parts = url.pathname.split("/").filter(Boolean); // e.g. api/agents/<id>/sessions

  try {
    // CORS for the cross-origin glasses WebView client: only /api/* and
    // /term/* opt in, and only when the request actually carries an Origin
    // (same-origin requests — the dashboard UI itself — never send one, so
    // this never fires for them). OPTIONS preflights are answered here,
    // before any auth gate — they're credential-less by spec and must not 401.
    const origin = req.headers.origin;
    if ((parts[0] === "api" || parts[0] === "term") && origin) {
      // Reflection (not "*") is required for credentialed CORS, and the
      // glasses WebView's origin isn't fixed; auth still gates every route.
      // nosemgrep: javascript.express.security.cors-misconfiguration.cors-misconfiguration
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
    }

    // Unauthenticated liveness probe for the Docker healthcheck (everything
    // informative sits behind auth; this leaks nothing). Without it the
    // healthcheck 401s and autoheal restart-loops the container.
    if (url.pathname === "/healthz") {
      return json(res, 200, { ok: true });
    }

    // Branded static assets (stylesheet, UI fonts, icon/favicon set, manifest):
    // public and served before the auth gate so the login page renders before a
    // session exists. Explicit allowlist — no arbitrary path -> file mapping.
    if (req.method === "GET" && Object.prototype.hasOwnProperty.call(STATIC_ASSETS, url.pathname)) {
      const asset = STATIC_ASSETS[url.pathname];
      res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": asset.cache });
      return res.end(asset.body);
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
      if (TURMA_PASSWORD && !credentialsMatch(body.username, body.password)) {
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

    // Short-lived token for the /audio WebSocket (browser WebSocket can't set
    // an Authorization header, so the token rides the query string instead).
    if (req.method === "GET" && url.pathname === "/api/ws-token") {
      return json(res, 200, { token: issueWsToken(), expiresInSec: WS_TOKEN_TTL_MS / 1000 });
    }

    // SSE stream (FIX 1/#1): authenticated dashboards subscribe here and get an
    // `agent` event (one serialized host record, same shape as /api/agents
    // returns per agent) on every heartbeat ingest / state change, plus a
    // `removed` event when a host is dropped. Rides the same login cookie/Basic
    // auth as the rest of the UI (the auth gate above already enforced it), so
    // there's no new token flow. Keepalive comments every 25s keep Cloudflare/
    // proxies from dropping the otherwise-idle stream.
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        // Ask nginx/Cloudflare not to buffer the stream (else events pool up).
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 3000\n\n"); // client reconnect backoff hint
      res.write(": connected\n\n");
      sseClients.add(res);
      const keepalive = setInterval(() => {
        try { res.write(": keepalive\n\n"); } catch { /* dropped; close cleans up */ }
      }, 25000);
      keepalive.unref();
      const drop = () => { clearInterval(keepalive); sseClients.delete(res); };
      req.on("close", drop);
      res.on("close", drop);
      res.on("error", drop);
      return;
    }

    // The fleet payload polled by every dashboard. Memoized (FIX 3/#9): the
    // serialized body + ETag are cached and only rebuilt when invalidated by a
    // heartbeat/mutation/tunnel/offline event, so an unchanged poll costs a
    // cheap 304. `Cache-Control: no-cache` (not no-store) so the browser keeps
    // the body+ETag and revalidates with If-None-Match on its next poll. The
    // history cache is excluded from the payload (see serializeAgent).
    if (req.method === "GET" && url.pathname === "/api/agents") {
      const cached = agentsCache || buildAgentsCache();
      if ((req.headers["if-none-match"] || "") === cached.etag) {
        res.writeHead(304, { ETag: cached.etag, "Cache-Control": "no-cache" });
        return res.end();
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        ETag: cached.etag,
      });
      return res.end(cached.body);
    }

    if (req.method === "POST" && url.pathname === "/api/heartbeat") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      // Identity is the physical host name (`device`); with one container per
      // host the container name is no longer meaningful. agentId is a last-resort
      // fallback if the host name couldn't be read.
      const key = payload.device || payload.agentId;
      if (!key) return json(res, 400, { error: "device/agentId required" });
      const prev = agents[key] || {};
      // At-least-once command delivery: drop any queued command the agent
      // reports as executed; keep re-sending the rest until acked.
      const acked = new Set(payload.ackedCommands || []);
      const commands = (prev.commands || []).filter((c) => !acked.has(c.cmdId));
      delete payload.ackedCommands; // don't persist the transient ack list
      // On-demand session history the agent fetched since the last beat (see
      // the {type:"history"} command); ingested into the cache below, not
      // stored on the record verbatim.
      const historyResults = payload.historyResults;
      delete payload.historyResults;
      const next = (agents[key] = {
        ...payload,
        // Pending host commands (spawn/kill/start/restart/resume/delete)
        // queued by the UI; re-sent on every reply below until acked.
        commands,
        lastSeen: Date.now(),
        // Per-agent alert bookkeeping survives across beats and hub restarts.
        alerts: prev.alerts || {},
        // Per-session history cache (see the /history route); survives across
        // beats like the rest of agent state.
        history: prev.history || {},
      });
      ingestHistory(next, historyResults);
      heartbeatAlerts(key, prev, next);
      scheduleSave();
      // A fresh beat landed — refresh the memoized fleet payload and push the
      // updated record to open dashboards so the UI reflects it near-instantly.
      publishAgent(key);
      return json(res, 200, { commands });
    }

    // POST /api/agents/<host>/clone — queue a GitHub clone into the host's
    // repos root. Body: {repo} (owner/repo or a GitHub URL); the agent validates
    // and clones it (gated on the host actually having GitHub creds — the UI
    // greys the control out otherwise). The new repo joins the scan and becomes
    // spawnable once the clone lands.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "agents" &&
        parts[3] === "clone" && parts.length === 4) {
      const key = decodeURIComponent(parts[2]);
      if (!agents[key]) return json(res, 404, { error: "unknown agent" });
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body.repo) return json(res, 400, { error: "repo required" });
      const cmdId = queueCommand(key, { type: "clone", repo: String(body.repo) });
      return json(res, 200, { ok: true, cmdId });
    }

    // POST /api/agents/<host>/repos/<repo>/prune — sweep a repo's finished work
    // on that host: the agent removes session worktrees whose commits are merged
    // into the latest default branch (leaving anything unmerged or dirty) and
    // deletes local branches merged into it. The result rides the heartbeat.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "agents" &&
        parts[3] === "repos" && parts[5] === "prune" && parts.length === 6) {
      const key = decodeURIComponent(parts[2]);
      if (!agents[key]) return json(res, 404, { error: "unknown agent" });
      const repo = decodeURIComponent(parts[4]);
      if (!repo) return json(res, 400, { error: "repo required" });
      const cmdId = queueCommand(key, { type: "prune", repo });
      return json(res, 200, { ok: true, cmdId });
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
        for (const f of ["prompt", "label", "baseRef", "model", "permissionMode"]) {
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
      // POST /api/agents/<host>/sessions/<id>/input -> forward free-text input
      // to a running session (typing a message into the session). Body: {text}.
      if (req.method === "POST" && parts.length === 6 && parts[5] === "input") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim()) return json(res, 400, { error: "text required" });
        if (text.length > 4000) return json(res, 400, { error: "text too long" });
        const cmdId = queueCommand(key, { type: "input", sessionId, text });
        return json(res, 200, { ok: true, cmdId });
      }
      // POST /api/agents/<host>/sessions/<id>/answer -> answer a pending
      // AskUserQuestion. Body: {optionIndex} (0-based option pick) and/or
      // {custom} (free-text / "Other" answer). The agent drops the answer file
      // the ask.py bridge is blocked on. optionIndex -1 (or omitted) means a
      // pure free-text answer; a valid answer needs at least one of the two.
      if (req.method === "POST" && parts.length === 6 && parts[5] === "answer") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const optionIndex = Number.isInteger(body.optionIndex) ? body.optionIndex : -1;
        const custom = typeof body.custom === "string" ? body.custom : "";
        if (optionIndex < 0 && !custom.trim()) {
          return json(res, 400, { error: "optionIndex or custom required" });
        }
        if (custom.length > 4000) return json(res, 400, { error: "custom too long" });
        const cmd = { type: "answerQuestion", sessionId, optionIndex };
        if (custom) cmd.custom = custom;
        const cmdId = queueCommand(key, cmd);
        return json(res, 200, { ok: true, cmdId });
      }
      // GET /api/agents/<host>/sessions/<id>/history -> that session's recent
      // transcript. Serves a fresh cached result (see ingestHistory) or, on a
      // cache miss/stale entry, queues a fetch and reports it pending; a
      // history command already outstanding for this session is reused
      // (single-flight) instead of piling up duplicates.
      if (req.method === "GET" && parts.length === 6 && parts[5] === "history") {
        const cached = (agents[key].history || {})[sessionId];
        if (cached && Date.now() - cached.fetchedAt < HISTORY_FRESH_MS) {
          return json(res, 200, {
            entries: cached.entries,
            truncated: cached.truncated,
            fetchedAt: cached.fetchedAt,
          });
        }
        const pending = (agents[key].commands || [])
          .find((c) => c.type === "history" && c.sessionId === sessionId);
        const cmdId = pending ? pending.cmdId : queueCommand(key, { type: "history", sessionId });
        return json(res, 202, { pending: true, cmdId });
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
      invalidateAgentsCache();
      sseBroadcast("removed", { key });
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
      // Start/stop the agent's live tail of one session's transcript. worktreePath
      // is where the agent looks up the transcript (see tunnel-agent.js).
      sendWatch: (sessionId, worktreePath) => send(0x1, JSON.stringify({ watch: sessionId, worktreePath })),
      sendUnwatch: (sessionId) => send(0x1, JSON.stringify({ unwatch: sessionId })),
      // Nudge the agent to heartbeat NOW so a just-queued command is delivered
      // in that beat's reply instead of waiting up to a whole TURMA_INTERVAL.
      sendPoke: () => send(0x1, JSON.stringify({ poke: true })),
    };
    console.log(`tunnel connected: ${name}`);
    // Terminal tunnel just came up — the host's `terminalOnline` flag flipped,
    // so refresh the cached payload and push it (Attach buttons enable live).
    publishAgent(name);
    // A fresh (or reconnected) tunnel doesn't know which sessions the hub still
    // has live watchers for — re-arm each so an agent restart / control-channel
    // flap doesn't silently stop the live stream to already-attached glasses.
    for (const sessionId of Object.keys(liveClients[name] || {})) {
      const wp = worktreePathFor(name, sessionId);
      if (wp) controlChannels[name].sendWatch(sessionId, wp);
    }
    const ping = setInterval(() => send(0x9, Buffer.alloc(0)), 30000); // beat CF idle timeout
    // The agent pushes live deltas back on this same channel: committed
    // transcript entries as `{tail: sessionId, entries}`, and the in-progress
    // assistant turn scraped from the TUI as `{turn: sessionId, text}` (real-
    // time streaming — empty text clears it once the turn completes and the
    // committed tail owns it). Everything else it sends we ignore.
    const parse = wsParser((op, payload) => {
      if (op === 0x8) return socket.end();
      if (op !== 0x1) return;
      let msg;
      try { msg = JSON.parse(payload.toString("utf8")); } catch { return; }
      if (msg && msg.tail && Array.isArray(msg.entries)) {
        liveFanout(name, msg.tail, { type: "tail", entries: msg.entries });
      } else if (msg && msg.turn && typeof msg.text === "string") {
        liveFanout(name, msg.turn, { type: "turn", text: msg.text });
      }
    });
    socket.on("data", parse);
    const cleanup = () => {
      clearInterval(ping);
      if (controlChannels[name] && controlChannels[name].socket === socket) {
        delete controlChannels[name];
        dropTermAgents(name); // discard pooled terminal channels (now dead)
        console.log(`tunnel gone: ${name}`);
        // Tunnel down — `terminalOnline` flipped back to false; push it.
        publishAgent(name);
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

  // Glasses live-transcript WebSocket: /live/<host>/<sessionId>?auth=<ws-token>.
  // The hub asks the host's tunnel-agent to tail that one session (over the
  // control channel) and streams back the agent's `{type:"tail", entries}`
  // deltas. Same short-lived ws-token auth as /audio (browser WebSocket can't
  // set an Authorization header).
  if (parts[0] === "live" && parts.length >= 3) {
    if (!wsTokenValid(url.searchParams.get("auth"))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    const host = decodeURIComponent(parts[1]);
    const sessionId = decodeURIComponent(parts[2]);
    if (!agents[host]) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      return socket.destroy();
    }
    // Reject a bogus/stale sessionId up front rather than accepting a socket
    // that can never tail anything (no worktree to watch, empty seed) and
    // just sits idle until the client backs off. A known-but-stopped session
    // still connects — it seeds from cache and simply never arms a watch.
    const known = (agents[host].sessions || []).some((s) => s.id === sessionId);
    if (!known) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      return socket.destroy();
    }
    wsHandshake(socket, req);

    const byHost = (liveClients[host] = liveClients[host] || {});
    const set = (byHost[sessionId] = byHost[sessionId] || new Set());
    const first = set.size === 0;
    set.add(socket);

    // Immediately seed the client with the most recent tail we already have
    // (from the last heartbeat) so it isn't blank until the first live delta.
    const cachedTail = (agents[host].sessions || []).find((s) => s.id === sessionId)?.session?.tail;
    if (Array.isArray(cachedTail) && cachedTail.length) {
      sendLive(socket, { type: "tail", entries: cachedTail });
    }

    // First watcher for this session -> ask the agent to start tailing it.
    if (first) {
      const wp = worktreePathFor(host, sessionId);
      if (wp && controlChannels[host]) controlChannels[host].sendWatch(sessionId, wp);
    }

    const ping = setInterval(() => {
      try { socket.write(wsEncode(0x9, Buffer.alloc(0))); } catch {}
    }, 30000);
    const parse = wsParser((op, payload) => {
      if (op === 0x8) return socket.end();
      if (op === 0x9) { try { socket.write(wsEncode(0xa, payload)); } catch {} } // ping -> pong
    });
    socket.on("data", parse);

    // Safe to run more than once: after the first pass the subscriber is gone,
    // so the guard below returns early (no double unwatch).
    const cleanup = () => {
      clearInterval(ping);
      const s = liveClients[host]?.[sessionId];
      if (!s) return;
      s.delete(socket);
      if (s.size > 0) return;
      delete liveClients[host][sessionId];
      // Last watcher gone -> tell the agent to stop tailing (frees the ~1s
      // file-tail loop when nobody's looking).
      if (controlChannels[host]) controlChannels[host].sendUnwatch(sessionId);
      if (Object.keys(liveClients[host]).length === 0) delete liveClients[host];
    };
    // A graceful WS close arrives as a 0x8 frame (handled above -> socket.end
    // -> "close"), but a client that half-closes the TCP side (or the SDK
    // WebView being torn down) only ever emits "end". Handle both, and end our
    // own writable side so the ping interval's handle doesn't keep the socket
    // (and the process) alive.
    socket.on("end", () => { cleanup(); try { socket.end(); } catch {} });
    socket.on("close", cleanup);
    socket.on("error", cleanup);
    return;
  }

  // Glasses mic-audio WebSocket: /audio?auth=<ws-token>. The client streams
  // raw 16kHz s16le mono PCM as binary frames; a {"type":"finalize"} text
  // frame triggers a Whisper transcription of everything buffered so far,
  // replied as one audio_result text frame, then we close the socket.
  if (parts[0] === "audio") {
    if (!wsTokenValid(url.searchParams.get("auth"))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    wsHandshake(socket, req);
    const send = (op, payload) => {
      try { socket.write(wsEncode(op, payload)); } catch {}
    };

    const AUDIO_CAP_BYTES = 1920000; // 60s of 16kHz s16le mono
    const AUDIO_IDLE_TIMEOUT_MS = 90 * 1000;
    let chunks = [];
    let bytes = 0;
    let capped = false;
    let firstByteAt = null;
    let finalized = false;
    let idleTimer;

    const cleanup = () => {
      clearTimeout(idleTimer);
    };
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { try { socket.destroy(); } catch {} }, AUDIO_IDLE_TIMEOUT_MS);
      idleTimer.unref();
    };
    resetIdle();

    const finalize = async () => {
      if (finalized) return;
      finalized = true;
      clearTimeout(idleTimer);
      const pcm = Buffer.concat(chunks);
      chunks = [];
      const transcript = await transcribePcm(pcm);
      const durationMs = firstByteAt ? Date.now() - firstByteAt : 0;
      const reply = { type: "audio_result", transcript, durationMs, bytes };
      if (capped) reply.capped = true;
      send(0x1, JSON.stringify(reply));
      send(0x8, Buffer.alloc(0));
      try { socket.end(); } catch {}
    };

    const parse = wsParser((op, payload) => {
      resetIdle();
      if (finalized) return;
      if (op === 0x2) {
        if (firstByteAt == null) firstByteAt = Date.now();
        if (bytes + payload.length > AUDIO_CAP_BYTES) {
          capped = true; // frame beyond the cap: dropped entirely
          return;
        }
        chunks.push(payload);
        bytes += payload.length;
      } else if (op === 0x9) {
        send(0xa, payload);
      } else if (op === 0x1) {
        let msg;
        try { msg = JSON.parse(payload.toString("utf8")); } catch { return; }
        if (msg && msg.type === "finalize") finalize();
      } else if (op === 0x8) {
        finalized = true; // discard buffered audio, no STT call
        chunks = [];
        clearTimeout(idleTimer);
        send(0x8, Buffer.alloc(0));
        try { socket.end(); } catch {}
      }
    });
    socket.on("data", parse);
    socket.on("close", cleanup);
    socket.on("error", cleanup);
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

// Test hooks: when TURMA_TEST is set (never in the image — the Dockerfile
// runs `node server.js` with it unset), export the internals for the test
// suite and skip binding the production port (tests listen on an ephemeral
// port themselves). Production behavior is identical: the guard only decides
// whether to listen.
if (process.env.TURMA_TEST) {
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
    pcmToWav,
    transcribePcm,
    issueWsToken,
    wsTokenValid,
  };
} else {
  if (!TURMA_PASSWORD) console.warn("WARNING: TURMA_USER/TURMA_PASSWORD not set — UI is unauthenticated");
  if (!TURMA_AGENT_TOKEN) console.warn("WARNING: TURMA_AGENT_TOKEN not set — heartbeat and tunnel endpoints are unauthenticated");
  server.listen(PORT, () => {
    console.log(`turma listening on :${PORT}`);
    console.log(
      NTFY_URL
        ? `ntfy alerts -> ${NTFY_URL}/${NTFY_TOPIC} (cost threshold $${COST_ALERT_USD}/day)`
        : "ntfy alerts disabled (NTFY_URL not set)"
    );
    console.log(
      WHISPER_URL ? `whisper STT -> ${WHISPER_URL}` : "whisper STT disabled (WHISPER_URL not set)"
    );
  });
}
