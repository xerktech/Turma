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
// It also pushes edge-triggered alerts to the Android client via Firebase Cloud
// Messaging (turma/push.js): container offline/recovered, crash loops, turn
// finished / question waiting for input, and PR created. Set
// FCM_SERVICE_ACCOUNT_JSON to enable; unset disables push (the alert bus becomes
// a no-op). Devices register their FCM token via POST /api/devices.
//
// stdlib only — no npm dependencies (the agent dials with Node's built-in
// WebSocket; the hub hand-rolls the WebSocket *server* framing with `crypto`).

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Duplex } = require("stream");
// Durable, searchable archive of ended sessions (organized files on /data + a
// node:sqlite FTS index). See archive.js. Lazily opens its DB on first use, so
// requiring it is cheap and side-effect-free.
const archive = require("./archive.js");
// Mobile push (FCM) fan-out for the alert bus. Lazily/gracefully no-ops when
// FCM_SERVICE_ACCOUNT_JSON is unset, so requiring it is side-effect-free.
const push = require("./push.js");

const PORT = parseInt(process.env.PORT || "8300", 10);
const STATE_FILE = process.env.STATE_FILE || "/data/state.json";
const DEVICES_FILE = process.env.DEVICES_FILE || "/data/devices.json";
// Ticket -> agent pins (XERK-38): which HOST a ticket's sessions spawn on,
// chosen by the operator in the board's ticket detail panel. Unlike the repo
// override (an agent-ledger fan-out — triage is agent state), the host choice
// is a ROUTING input, and routing is the hub's job because only the hub sees
// the whole fleet — so the pin lives here, on the same durable /data volume as
// the archive, rather than riding any one agent's ~/.turma.
const TICKET_AGENTS_FILE = process.env.TICKET_AGENTS_FILE || "/data/ticket-agents.json";
// Tickets come and go while pins are only ever set by hand, so the map is
// bounded rather than reconciled: past the cap the oldest pin is evicted.
const TICKET_AGENTS_MAX = 500;
// Per-org auto opt-in (XERK-41): which Jira orgs let the board drive their whole
// session lifecycle — auto-START a session for every To Do ticket that has a repo
// (XERK-41), and auto-STOP a session when its ticket moves to Done (XERK-45; see
// autoStopSweep). This is the SOLE control — it's a hub setting the operator flips
// from the board's org chip, so it can be turned on and off without redeploying an
// agent, and there is no agent-side flag (the original agent env TICKET_AUTO_START
// was removed). Hub-owned for the same reason the agent-pin above is: the decision
// and the routing are the hub's job (only it sees the whole fleet). Durable on the
// /data volume, not the best-effort state.json, because the opt-in must survive a
// hub restart.
const AUTOSTART_ORGS_FILE = process.env.AUTOSTART_ORGS_FILE || "/data/autostart-orgs.json";
const OFFLINE_AFTER_MS = 75 * 1000; // heartbeats arrive every ~20s
// An agent about to restart for an EXPECTED reason (an image update recreating
// its container, or the native updater swapping files) POSTs /updating just
// before it goes silent, so the coming heartbeat gap reads as `updating` rather
// than an unexpected-outage `offline` (XERK-29). We hold that status for this
// grace window; if the agent never comes back within it the update is stuck and
// the host correctly falls through to offline (and alerts).
const UPDATING_GRACE_MS = Number(process.env.UPDATING_GRACE_MS) || 5 * 60 * 1000;
// Control-channel liveness. A heartbeat is a fresh HTTP POST and so proves
// nothing about the tunnel: the two die independently, and a host whose tunnel
// is wedged still reports `online` while every Attach on it reads "terminal
// offline". Both ends therefore prove the channel rather than assume it.
const CONTROL_PING_EVERY_MS = Number(process.env.CONTROL_PING_EVERY_MS) || 30 * 1000;
const CONTROL_DEAD_AFTER_MS = Number(process.env.CONTROL_DEAD_AFTER_MS) || 90 * 1000; // 3 missed beats
const PRUNE_AFTER_MS = 7 * 24 * 3600 * 1000; // drop entries gone for a week
const HISTORY_FRESH_MS = 5 * 60 * 1000; // serve cached session history under this age
const HISTORY_MAX_AGE_MS = 10 * 60 * 1000; // evict cache entries older than this
const HISTORY_MAX_SESSIONS = 8; // cap per-host cache; oldest fetchedAt evicted first
// Board ticket detail (description + comments), fetched on demand from the host
// that owns the org's Jira creds. Cached briefly so reopening a ticket, or two
// dashboards viewing one, doesn't re-hit Jira; kept much shorter-lived than a
// transcript because a ticket is edited by other people while you read it.
const JIRA_ISSUE_FRESH_MS = 60 * 1000; // serve a cached issue under this age
const JIRA_ISSUE_MAX_AGE_MS = 10 * 60 * 1000; // evict cache entries older than this
const JIRA_ISSUE_MAX = 40; // cap per-host cache; oldest fetchedAt evicted first

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
// A dedicated bearer token for the programmatic session-trigger endpoint
// (POST /api/trigger), so external automation (CI, webhooks, cron) can start a
// session without the single-user login. It never opens the endpoint on its
// own: when unset, /api/trigger still accepts the user login (Basic/cookie) but
// nothing else — so leaving it blank locks out token callers rather than
// granting open access.
const TURMA_TRIGGER_TOKEN = process.env.TURMA_TRIGGER_TOKEN || "";

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

// ---- LiteLLM backend (OpenAI-compatible: Whisper STT) -----------------------
// Whisper STT is served by a LiteLLM instance's `/v1` base: LITELLM_URL points
// at it and Whisper hits `${LITELLM_URL}/audio/transcriptions` with LITELLM_API_KEY.
// Unset LITELLM_URL disables STT: transcription returns an `unavailable`
// transcript — a "graceful when unconfigured" contract.
const LITELLM_URL = (process.env.LITELLM_URL || "").replace(/\/$/, "");
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || process.env.WHISPER_API_KEY || "";

// Whisper STT: the glasses client streams mic PCM to us over /audio and we
// wrap+POST it to the same LiteLLM instance's OpenAI-compatible transcription
// endpoint on finalize. Derived from LITELLM_URL / LITELLM_API_KEY by default;
// WHISPER_URL / WHISPER_API_KEY still override if the STT server lives elsewhere.
const WHISPER_URL =
  process.env.WHISPER_URL || (LITELLM_URL ? `${LITELLM_URL}/audio/transcriptions` : "");
const WHISPER_MODEL = process.env.WHISPER_MODEL || "";
const WHISPER_API_KEY = process.env.WHISPER_API_KEY || LITELLM_API_KEY;
// The `language` hint pins the transcription to a language. Default "en", but an
// explicit empty WHISPER_LANGUAGE OMITS the hint so the STT model auto-detects —
// `??` (not `||`) is what lets "" through, since "" is falsy. Needed for
// multilingual ASR like Parakeet-tdt-0.6b-v3, whose auto language detection a
// forced `language=en` would silently defeat.
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE ?? "en";
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

// ---- mobile push device registry -------------------------------------------
// FCM tokens the Android client has registered (POST /api/devices). notify()
// fans every alert out to these. Persisted next to
// STATE_FILE, same best-effort pattern (losing it just means devices re-register
// on their next app launch). Each entry: {token, platform, addedAt, seenAt}.
let devices = [];
try {
  const parsed = JSON.parse(fs.readFileSync(DEVICES_FILE, "utf8"));
  if (Array.isArray(parsed)) devices = parsed;
} catch {
  /* first boot or no volume mounted */
}
let devSaveTimer = null;
function scheduleDeviceSave() {
  if (devSaveTimer) return;
  devSaveTimer = setTimeout(() => {
    devSaveTimer = null;
    fs.mkdir(path.dirname(DEVICES_FILE), { recursive: true }, () => {
      fs.writeFile(DEVICES_FILE, JSON.stringify(devices), (err) => {
        if (err) console.error(`devices save failed: ${err.message}`);
      });
    });
  }, 5 * 1000);
  devSaveTimer.unref();
}
function registerDevice(token, platform) {
  const now = Date.now();
  const existing = devices.find((d) => d.token === token);
  if (existing) {
    existing.platform = platform || existing.platform;
    existing.seenAt = now;
  } else {
    devices.push({ token, platform: platform || "android", addedAt: now, seenAt: now });
  }
  scheduleDeviceSave();
}
function unregisterDevice(token) {
  const before = devices.length;
  devices = devices.filter((d) => d.token !== token);
  if (devices.length !== before) scheduleDeviceSave();
}
function pruneDevices(deadTokens) {
  if (!deadTokens || !deadTokens.length) return;
  const dead = new Set(deadTokens);
  const before = devices.length;
  devices = devices.filter((d) => !dead.has(d.token));
  if (devices.length !== before) scheduleDeviceSave();
}
function listDevices() {
  return devices;
}

// ---- ticket -> agent pins (XERK-38) ----------------------------------------
// The operator's own answer to which HOST a ticket's sessions spawn on,
// overriding findTicketHost's most-available pick. Keyed "<siteKey>/<issueKey>"
// (the agent-side ledgers key the same way); each entry {host, at}. Rarely
// used, but "persistent" is the point of it: the choice must survive a hub
// restart, which is why it has its own file on /data rather than riding the
// best-effort state.json (whose loss is documented as harmless).
let ticketAgents = {};
try {
  const parsed = JSON.parse(fs.readFileSync(TICKET_AGENTS_FILE, "utf8"));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ticketAgents = parsed;
} catch {
  /* first boot or no volume mounted */
}
let taSaveTimer = null;
function scheduleTicketAgentsSave() {
  if (taSaveTimer) return;
  taSaveTimer = setTimeout(() => {
    taSaveTimer = null;
    fs.mkdir(path.dirname(TICKET_AGENTS_FILE), { recursive: true }, () => {
      fs.writeFile(TICKET_AGENTS_FILE, JSON.stringify(ticketAgents), (err) => {
        if (err) console.error(`ticket-agents save failed: ${err.message}`);
      });
    });
  }, 5 * 1000);
  taSaveTimer.unref();
}
function ticketAgentPin(siteKey, issueKey) {
  const p = ticketAgents[`${siteKey}/${issueKey}`];
  return p && typeof p.host === "string" && p.host ? p : null;
}
// Set or clear (host=null) a ticket's pinned host. The caller has already
// validated the host against the fleet; this just owns the map's bookkeeping.
function setTicketAgent(siteKey, issueKey, host) {
  const k = `${siteKey}/${issueKey}`;
  if (!host) delete ticketAgents[k];
  else {
    ticketAgents[k] = { host, at: Date.now() };
    const keys = Object.keys(ticketAgents);
    if (keys.length > TICKET_AGENTS_MAX) {
      keys.sort((a, b) => (ticketAgents[a].at || 0) - (ticketAgents[b].at || 0));
      for (const old of keys.slice(0, keys.length - TICKET_AGENTS_MAX)) {
        delete ticketAgents[old];
      }
    }
  }
  scheduleTicketAgentsSave();
  // The pin rides the /api/agents payload (and its own SSE event), so open
  // boards must see the change without waiting out an ETag match.
  invalidateAgentsCache();
  sseBroadcast("ticketAgents", ticketAgents);
}

// ---- per-org auto-start opt-in (XERK-41) -----------------------------------
// The set of Jira orgs the operator has switched auto-start ON for, keyed by
// siteKey with the value simply `true` (presence = enabled; disabling deletes
// the key). Unlike the ticket->agent pins there's no eviction cap: orgs are
// bounded by how many Jira sites the operator connects (a handful), not by the
// churn of tickets. See AUTOSTART_ORGS_FILE for why it's durable and hub-owned.
let autoStartOrgs = {};
try {
  const parsed = JSON.parse(fs.readFileSync(AUTOSTART_ORGS_FILE, "utf8"));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [k, v] of Object.entries(parsed)) if (v) autoStartOrgs[k] = true;
  }
} catch {
  /* first boot or no volume mounted */
}
let asSaveTimer = null;
function scheduleAutoStartSave() {
  if (asSaveTimer) return;
  asSaveTimer = setTimeout(() => {
    asSaveTimer = null;
    fs.mkdir(path.dirname(AUTOSTART_ORGS_FILE), { recursive: true }, () => {
      fs.writeFile(AUTOSTART_ORGS_FILE, JSON.stringify(autoStartOrgs), (err) => {
        if (err) console.error(`autostart-orgs save failed: ${err.message}`);
      });
    });
  }, 5 * 1000);
  asSaveTimer.unref();
}
// Flip an org's hub-side auto-start opt-in. The caller has already validated the
// siteKey is one the fleet actually reports; this owns the map's bookkeeping.
function setAutoStartOrg(siteKey, enabled) {
  if (enabled) autoStartOrgs[siteKey] = true;
  else delete autoStartOrgs[siteKey];
  scheduleAutoStartSave();
  // Rides the /api/agents payload (and its own SSE event), like the agent pins,
  // so open boards reflect the toggle without waiting out an ETag match.
  invalidateAgentsCache();
  sseBroadcast("autoStartOrgs", autoStartOrgs);
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
// large) on-demand caches (session history, Jira issue detail) stripped — each
// has its own route — plus the two time/tunnel-derived live flags.
// Shared by the fleet payload and the SSE per-agent push so both stay in
// lockstep.
function serializeAgent(key, agent, now) {
  const { history, subagentHistory, jiraIssues, ...a } = agent;
  const online = now - (a.lastSeen || 0) < OFFLINE_AFTER_MS;
  return {
    key,
    ...a,
    online,
    // An expected restart in progress (XERK-29): only meaningful while the host
    // is actually silent — a host that came back is just `online` again, and its
    // heartbeat rebuild already dropped the stored flag — and only until the
    // grace window lapses, past which a stuck update falls through to `offline`.
    updating: !online && a.updating && now < a.updating.until ? a.updating : null,
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
  // ticketAgents (the ticket->host pins) and autoStartOrgs (the per-org
  // auto-start opt-in, XERK-41) ride the same payload: both are tiny,
  // board-scoped, and hub-owned, so this is their one read channel (plus their
  // own SSE events for open boards).
  const body = JSON.stringify({ now, agents: list, ticketAgents, autoStartOrgs });
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
    agent.history[r.sessionId] = { entries: r.entries, truncated: r.truncated,
      queued: Array.isArray(r.queued) ? r.queued : [], fetchedAt: now };
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

// The cache key for one background agent's transcript (see the {type:
// "subagentHistory"} command): a session can run several agents of the same
// type, so the short description/label disambiguates them. NUL-separated
// because neither field can contain it.
function subagentKey(sessionId, type, label) {
  return String(sessionId) + "\0" + String(type || "") + "\0" + String(label || "");
}

// Same lifecycle as ingestHistory, keyed by (session,type,label) — merges the
// agent's `subagentHistoryResults`, then evicts by age and caps the cache.
function ingestSubagentHistory(agent, results) {
  const now = Date.now();
  for (const r of results || []) {
    if (!r || !r.sessionId) continue;
    agent.subagentHistory[subagentKey(r.sessionId, r.type, r.label)] =
      { entries: r.entries, truncated: r.truncated, fetchedAt: now };
  }
  for (const [k, h] of Object.entries(agent.subagentHistory)) {
    if (now - h.fetchedAt > HISTORY_MAX_AGE_MS) delete agent.subagentHistory[k];
  }
  const over = Object.keys(agent.subagentHistory).length - HISTORY_MAX_SESSIONS;
  if (over > 0) {
    Object.entries(agent.subagentHistory)
      .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
      .slice(0, over)
      .forEach(([k]) => delete agent.subagentHistory[k]);
  }
}

// Merge the agent's on-demand Jira issue deliveries (heartbeat
// `jiraIssueResults`) into the host's per-issue cache, bounded the same way as
// ingestHistory. A result carrying an `error` is cached too — otherwise the
// board would re-queue a doomed fetch (a deleted issue, a permissions wall) on
// every poll for as long as the ticket stays open.
function ingestJiraIssues(agent, jiraIssueResults) {
  const now = Date.now();
  for (const r of jiraIssueResults || []) {
    if (!r || !r.key) continue;
    agent.jiraIssues[r.key] = { issue: r.issue || null, error: r.error || null, fetchedAt: now };
  }
  for (const [key, e] of Object.entries(agent.jiraIssues)) {
    if (now - e.fetchedAt > JIRA_ISSUE_MAX_AGE_MS) delete agent.jiraIssues[key];
  }
  const over = Object.keys(agent.jiraIssues).length - JIRA_ISSUE_MAX;
  if (over > 0) {
    Object.entries(agent.jiraIssues)
      .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
      .slice(0, over)
      .forEach(([key]) => delete agent.jiraIssues[key]);
  }
}

// An issue key is interpolated into an agent REST path, so it's allowlist-checked
// before it reaches a URL — the same "nothing free-form" stance the agent takes.
// Two grammars, because the board carries two ticket sources: Jira's PROJECT-123
// keys and Azure DevOps' bare-integer work-item ids.
function isIssueKey(k) {
  return /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/.test(k) || /^[0-9]+$/.test(k);
}

// Which HOST should answer for a Jira org (siteKey): a host whose `jira` block
// reports that site — preferring an ONLINE one, since an offline host's queued
// command would sit undelivered until it returns. null when no host covers the
// org (or the only ones that do are offline, and `requireOnline`).
function findJiraHost(siteKey, requireOnline) {
  const now = Date.now();
  let stale = null;
  for (const [key, a] of Object.entries(agents)) {
    if (!a.jira || a.jira.siteKey !== siteKey) continue;
    if (now - (a.lastSeen || 0) < OFFLINE_AFTER_MS) return key;
    stale = stale || key;
  }
  return requireOnline ? null : stale;
}

// The repo an org's board says a ticket belongs in, as triaged by whichever host
// reported it (see the Jira -> repo triage section in hub-agent.py). null when no
// host reports the ticket, or none has triaged it yet, or the model declined it.
// The FRESHEST reporting block wins, matching how board.js merges the same
// tickets for display — the hub must resolve against what the operator clicked.
function ticketRepo(siteKey, issueKey) {
  let best = null, bestAt = "";
  for (const a of Object.values(agents)) {
    if (!a.jira || a.jira.siteKey !== siteKey) continue;
    const t = (a.jira.tickets || []).find((x) => x && x.key === issueKey);
    if (!t || !t.repoGuess || !t.repoGuess.repo) continue;
    const at = String(a.jira.fetchedAt || "");
    if (!best || at > bestAt) { best = t.repoGuess.repo; bestAt = at; }
  }
  return best;
}

// How many more sessions a host can take RIGHT NOW, as the hub sees it — the
// basis for splitting work across the agents of one org. Starts from the
// agent-reported `capacity.free` (MAX_SESSIONS minus running) and subtracts what
// the hub itself has already committed but the host hasn't reflected yet: its
// queued sessions, and the spawn/spawnTicket commands sitting in its queue since
// its last heartbeat. Without that subtraction, four tickets clicked between two
// beats would all read the same stale `free` and pile onto one host.
//
// An agent predating the capacity block reports no ceiling, so its headroom is
// unknowable; it scores below any capacity-reporting host (which, once a fleet
// runs this build, is all of them) but stays eligible so a mixed fleet still
// routes. Can go negative (more committed than free) — that's fine, it's a
// sortable score, not a count.
function pendingSpawnCount(a) {
  return (a.commands || []).filter(
    (c) => c && (c.type === "spawn" || c.type === "spawnTicket")).length;
}
function hostAvailability(a) {
  const c = a.capacity;
  if (!c || typeof c.free !== "number") {
    // Unknown ceiling: rank only by what we've queued onto it, well below any
    // host that reports real free slots.
    return -1000 - pendingSpawnCount(a);
  }
  return c.free - (c.queued || 0) - pendingSpawnCount(a);
}

// Which HOST should run a ticket's session, splitting load across the org's
// agents. Among the ONLINE hosts reporting the org:
//   - prefer one that already has the repo cloned;
//   - if NONE has it, fall back to any of them — the agent clones the repo on
//     demand and queues the session behind the clone (see spawn_ticket);
//   - within the chosen group, pick the MOST AVAILABLE (hostAvailability), so N
//     sessions on one org spread across its hosts instead of stacking on the
//     first match. A host that's momentarily full is still a valid target — the
//     session simply queues there — so this never fails for lack of a free slot.
//
// Online is required rather than preferred (unlike the read-only GET above, which
// serves an offline host's cache): a spawn queued onto a sleeping host would land
// whenever it next wakes, which is a surprise, not a feature.
//
// A manual pin (ticketAgents, set from the ticket detail panel — XERK-38) is
// authoritative when one exists for the issue: the operator named the machine,
// so the availability ranking never overrides it. It is honored, not worked
// around: a pinned host that's offline (or gone from the org) is an ERROR with
// the pin in the message, never a silent fallback to another host — routing
// elsewhere would contradict the one thing the pin asserts. The auto-start
// sweep treats that error like any no-host result (retry next sweep,
// unrecorded), so a pinned host that's briefly down just delays the spawn.
// Returns {host, needsClone} | {error, status}.
function findTicketHost(siteKey, repo, issueKey) {
  const now = Date.now();
  let anyOrg = false, anyOnline = false;
  const cloned = [], uncloned = [];
  for (const [key, a] of Object.entries(agents)) {
    if (!a.jira || a.jira.siteKey !== siteKey) continue;
    anyOrg = true;
    if (now - (a.lastSeen || 0) >= OFFLINE_AFTER_MS) continue;
    anyOnline = true;
    if ((a.repos || []).some((r) => r && r.name === repo)) cloned.push(key);
    else uncloned.push(key);
  }
  if (!anyOrg) return { status: 404, error: "no host reports that Jira org" };
  const pin = issueKey ? ticketAgentPin(siteKey, issueKey) : null;
  if (pin) {
    const a = agents[pin.host];
    if (!a || !a.jira || a.jira.siteKey !== siteKey) {
      return { status: 409, error:
        `this ticket is pinned to agent "${pin.host}", which no longer reports that Jira org` };
    }
    if (now - (a.lastSeen || 0) >= OFFLINE_AFTER_MS) {
      return { status: 503, error:
        `this ticket is pinned to agent "${pin.host}", which is offline` };
    }
    return { host: pin.host,
      needsClone: !(a.repos || []).some((r) => r && r.name === repo) };
  }
  if (!anyOnline) {
    return { status: 503, error: "every host reporting that Jira org is offline" };
  }
  const pool = cloned.length ? cloned : uncloned;
  const needsClone = cloned.length === 0;
  // Most available first; insertion order breaks ties (stable, deterministic).
  pool.sort((x, y) => hostAvailability(agents[y]) - hostAvailability(agents[x]));
  return { host: pool[0], needsClone };
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

// Trigger auth (POST /api/trigger). A caller passes either the dedicated
// TURMA_TRIGGER_TOKEN as a Bearer token (the programmatic path — CI/webhooks)
// or the ordinary user login (Basic/cookie), so a logged-in operator or curl
// can hit it too. The token check is skipped when TURMA_TRIGGER_TOKEN is unset,
// but that does NOT open the endpoint: it still falls back to userAuthorized,
// which requires the login unless TURMA_PASSWORD is itself unset (fully open
// hub, warned about at boot). A Bearer that isn't the trigger token falls
// through to userAuthorized too (which rejects a bad Bearer).
function triggerAuthorized(req) {
  const header = req.headers.authorization || "";
  if (TURMA_TRIGGER_TOKEN && header.startsWith("Bearer ") &&
      safeEqual(header.slice(7), TURMA_TRIGGER_TOKEN)) {
    return true;
  }
  return userAuthorized(req);
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

// ---- push alerts (Firebase Cloud Messaging) ---------------------------------
// The single alert bus. Every edge-triggered alert (host offline/recovered,
// restart loop, question waiting, PR created, turn finished) funnels through
// notify(), which fans it out to every registered mobile device via FCM. A
// no-op when FCM is unconfigured or no device has registered, and best-effort:
// a push failure only logs, never breaks the beat. tags/priority/click/route
// ride as data so the app picks the notification channel and deep-links a tap to
// the exact session or host.
function notify(title, message, opts = {}) {
  const tokens = listDevices();
  if (!tokens.length) return; // no registered devices; also skips when FCM off
  const data = {
    tags: opts.tags || "",
    priority: opts.priority || "default",
  };
  if (opts.click) data.click = opts.click;
  if (opts.route) {
    if (opts.route.host) data.host = opts.route.host;
    if (opts.route.sessionId) data.sessionId = opts.route.sessionId;
  }
  push
    .sendFcm(tokens.map((d) => d.token), { title, body: message, data })
    .then((r) => pruneDevices(r.dead))
    .catch((e) => console.error(`fcm fan-out failed: ${e.message}`));
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 360) / 10}h`;
}

// Is this session actively working? Primary signal is the agent's live TUI
// probe (paneBusy: the "esc to interrupt" hint is on screen iff the model is
// working). Falls back to transcript freshness — written within
// WORKING_WINDOW_MS (the agent reports the age at beat time; we add the
// staleness since the host's last beat) — when paneBusy wasn't reported (older
// agent, or the pane couldn't be captured). `lastSeen` is the host's last beat.
function sessionWorking(session, lastSeen, now) {
  const s = session.session;
  if (s?.paneBusy != null) return s.paneBusy;
  const age = s?.transcriptAgeSec;
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
      route: { host: key },
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
        route: { host: key },
      });
    }
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

    const route = { host: key, sessionId: session.id };
    if (s.question && s.question !== sa.lastQuestion) {
      sa.lastQuestion = s.question;
      notify(`${label} has a question`, s.question, { tags: "question", priority: "high", route });
    }
    if (!s.question) delete sa.lastQuestion;

    for (const url of s.newPrUrls || []) {
      const seen = sa.prSeen || [];
      if (seen.includes(url)) continue;
      sa.prSeen = [...seen, url].slice(-20);
      notify(`${label} created a PR`, url, { tags: "rocket", click: url, route });
    }

    // Turn finished: was working, transcript went quiet, and the newest entry
    // is plain assistant output (a pending tool call or question means it's
    // still mid-turn / already alerted above). A beat that just recovered from
    // an offline period skips this — "back online" already covers it and the
    // working->idle edge across the gap is stale.
    const working = sessionWorking(session, next.lastSeen, now);
    if (sa.wasWorking && !working && !recovered && s.lastRole === "assistant" && !s.lastHasToolUse) {
      const repo = session.git?.repoName ? ` · ${session.git.repoName}@${session.git.branch}` : "";
      notify(`${label} finished its turn`, `Waiting for input${repo}`, { tags: "checkered_flag", route });
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
    // An announced update in progress isn't an outage — hold the offline alert
    // until its grace window lapses. If the update gets stuck the host crosses
    // to genuinely-offline once `until` passes and this fires as normal (XERK-29).
    const updating = a.updating && now < a.updating.until;
    if (online || updating || a.alerts?.offlineAt) continue;
    a.alerts = a.alerts || {};
    a.alerts.offlineAt = now;
    const where = a.device ? ` on ${a.device}` : "";
    notify(`${key} offline`, `No heartbeat for ${fmtDur(now - (a.lastSeen || 0))}${where}`, {
      tags: "red_circle",
      priority: "high",
      route: { host: key },
    });
    scheduleSave();
    // The host just crossed to offline — invalidate the cached payload (whose
    // `online` flag is now stale) and push the transition to dashboards.
    publishAgent(key);
  }
}, 15 * 1000).unref();

// ---- auto-start To Do tickets (XERK-32) ------------------------------------
// Opt-in PER ORG via the hub's own per-org toggle (autoStartOrgs, XERK-41 —
// hub-only, no agent flag). When an org is toggled on, the hub starts a session
// for every "To Do" ticket that has a repo — by the model's triage or a manual
// pin — and doesn't already have one.
//
// The DECISION and the ROUTING live here, not on the agent, for the reason the
// manual Start button already does (see the /session route): only the hub sees
// the whole fleet, so only it can spread an org's sessions across ALL its agents
// via findTicketHost rather than piling them on one host.
//
// The whole point is to never open a SECOND session for work already started —
// by an operator's click, a prior auto-start, or anything else. Three guards, in
// increasing strength:
//   - autoStarted: a per-ticket ATTEMPT record, bounded and backed off (see
//     below). This is what stops a spawn the agent legitimately REFUSES (e.g. an
//     uncloneable repo) from being re-queued every 15s forever — a refusal leaves
//     no session to see.
//   - startedTicketKeys(): the durable guard — a ticket carrying a session on ANY
//     channel (live, killed, or the resumable scan that outlives a restart) is
//     already handled, whether it was started manually or automatically.
//   - an in-flight spawnTicket on some org host, for the window before that
//     session first heartbeats back.
const AUTO_START_EVERY_MS = 15 * 1000;

// Auto-start is BOUNDED RETRY, not one-shot (XERK-61). Queuing a spawnTicket is
// not evidence that a session started: the agent acks every command it takes,
// including ones it refuses outright (no triaged repo on THAT host, no owner to
// clone with) and ones that simply blow up mid-spawn (a Jira fetch that times
// out, a git failure) — handle_commands logs and acks those exactly like a
// success, and nothing reports the outcome back. Treating "queued once" as
// "started" therefore made a TRANSIENT failure permanent for the hub's lifetime,
// which is what "sometimes it starts and sometimes it doesn't, with every
// condition met" looks like from the board.
//
// So each ticket gets a small budget of attempts spaced by a growing backoff,
// and the retry gate is EVIDENCE, in the same order the sweep already checks it:
// a session for the ticket (on any channel) ends the attempts for good, an
// in-flight command means we're still waiting, and only a ticket that is still
// session-less with nothing in flight past its backoff is tried again. The
// budget is what keeps a genuinely impossible ticket (a repo that cannot be
// cloned) from retrying forever; exhausting it logs once and gives up.
const AUTO_START_MAX_ATTEMPTS = 4;
const AUTO_START_RETRY_MS = 60 * 1000;      // after attempt 1; doubles each time
const AUTO_START_RETRY_MAX_MS = 10 * 60 * 1000;
// "<siteKey>\x00<issueKey>" -> { attempts, nextAt }. Entries are dropped the
// moment the ticket is seen to have a session, so this stays as small as the set
// of tickets currently failing to start.
const autoStarted = new Map();

// When to try again after `attempts` failed attempts: 1min, 2min, 4min, capped.
function autoStartRetryAt(now, attempts) {
  return now + Math.min(AUTO_START_RETRY_MS * 2 ** (attempts - 1),
    AUTO_START_RETRY_MAX_MS);
}

// siteKeys whose org is opted in to auto-start (XERK-41). The opt-in is HUB-ONLY:
// it's the hub's own durable per-org toggle (autoStartOrgs), set from the board —
// there is no agent-side flag. No onlineness gate here (it's hub state, not a host
// report); the sweep still only acts on orgs with a live reporting block and routes
// through findTicketHost, which needs an online host anyway, so a toggled-on org
// with every host down simply no-ops.
function orgsWithAutoStart() {
  return new Set(Object.keys(autoStartOrgs).filter((k) => autoStartOrgs[k]));
}

// Every ticket that already has a session, on any channel — the durable
// dedup key for auto-start. Mirrors board.js's ticketSessionIndex: a ticket is
// "started" if any host's live/stopped registry (a.sessions), its killed history
// (a.closedSessions), or a repo's resumable scan (a.repos[].resumable) carries a
// session whose `ticket` names it. Keyed "<siteKey>\x00<key>" like the routing
// helpers, so a lookup is a plain Set membership test.
function startedTicketKeys() {
  const keys = new Set();
  const add = (s) => {
    const t = s && s.ticket;
    if (t && t.key) keys.add((t.siteKey || "") + "\x00" + t.key);
  };
  for (const a of Object.values(agents)) {
    for (const s of a.sessions || []) add(s);
    for (const c of a.closedSessions || []) add(c);
    for (const r of a.repos || []) for (const t of r.resumable || []) add(t);
  }
  return keys;
}

function autoStartSweep() {
  const orgs = orgsWithAutoStart();
  if (!orgs.size) return;
  const now = Date.now();
  const started = startedTicketKeys();
  for (const siteKey of orgs) {
    // The freshest reporting block owns the ticket list and its repo guesses, the
    // same copy ticketRepo/mergeSites resolve against — so the hub auto-starts on
    // what the board would show, not a lagging host's older view.
    let block = null, bestAt = "";
    for (const a of Object.values(agents)) {
      if (!a.jira || a.jira.siteKey !== siteKey) continue;
      const at = String(a.jira.fetchedAt || "");
      if (!block || at > bestAt) { block = a.jira; bestAt = at; }
    }
    for (const t of (block && block.tickets) || []) {
      if (!t || !t.key) continue;
      if (t.statusCategory !== "todo") continue;      // only "To Do" tickets
      const repo = ticketRepo(siteKey, t.key);         // a repo must be assigned
      if (!repo) continue;
      const k = siteKey + "\x00" + t.key;
      // A session exists on some channel — the work is under way (or was, and
      // was deliberately killed). Done with this ticket for good; drop any
      // attempt record so the map only ever holds tickets still failing.
      if (started.has(k)) { autoStarted.delete(k); continue; }
      // A spawnTicket already riding some org host's queue: the agent hasn't
      // taken it yet, so there is nothing to conclude about it either way.
      const inFlight = Object.values(agents).some((a) =>
        a.jira && a.jira.siteKey === siteKey &&
        (a.commands || []).some((c) => c.type === "spawnTicket" && c.issueKey === t.key));
      if (inFlight) continue;
      // Nothing in flight and still no session: the last attempt (if any) was
      // taken and produced nothing. Retry it, within the budget and its backoff.
      const prior = autoStarted.get(k);
      if (prior) {
        if (prior.attempts >= AUTO_START_MAX_ATTEMPTS) continue;
        if (now < prior.nextAt) continue;
      }
      const { host } = findTicketHost(siteKey, repo, t.key);
      // No online host to route to right now (the org's hosts are down, or the
      // ticket's pinned agent is) — spend no attempt, so the next sweep retries
      // immediately once a host is back rather than sitting out a backoff for a
      // failure that was never the ticket's fault.
      if (!host) continue;
      queueCommand(host, { type: "spawnTicket", issueKey: t.key });
      const attempts = (prior ? prior.attempts : 0) + 1;
      autoStarted.set(k, { attempts, nextAt: autoStartRetryAt(now, attempts) });
      if (attempts > 1) {
        console.log(`auto-start: retrying ${t.key} on ${host} `
          + `(attempt ${attempts}/${AUTO_START_MAX_ATTEMPTS}) — the previous `
          + "spawnTicket was acked but left no session");
      }
      if (attempts >= AUTO_START_MAX_ATTEMPTS) {
        console.log(`auto-start: ${t.key} has used its last attempt; if this one `
          + "leaves no session the hub will stop trying (start it by hand from "
          + "the board to retry)");
      }
    }
  }
}
// The lifecycle counterpart to autoStartSweep (XERK-45): when a ticket in an
// opted-in org moves to Done, stop the session(s) working it. Same per-org
// opt-in as auto-start (orgsWithAutoStart) — turning "auto" on for an org means
// the board drives that org's WHOLE session lifecycle, both halves: start a To
// Do ticket that has a repo, stop a Done one's session.
//
// A ticket only reaches Done by a HUMAN moving it (the board is pull-only — no
// session writes to Jira), so it's a deliberate "this work is finished" signal,
// even more intentional than the To Do state auto-start reacts to. So the hub
// KILLS the session rather than merely interrupting it: a kill ends the session
// cleanly — it moves to the Ended list with its worktree, conversation and PR
// chips intact and still resumable, and frees the MAX_SESSIONS slot the
// auto-started session took (symmetric with auto-start consuming one). An
// interrupt would only cancel the in-flight turn and leave the session running
// idle, still holding that slot with nothing to do.
//
// The DECISION and ROUTING live here for the same reason auto-start's do: only
// the hub sees the whole fleet. The tickets (and which is Done) come from an
// org's freshest jira block, but a session can live on ANY of the org's hosts,
// so the sweep scans the whole fleet and routes each kill to the host that owns
// the session — the kill command is keyed on the sessionId the agent minted.
//
// Guard: autoStopped fires the kill for a given session at most once per hub
// lifetime. A kill drops the session's registry record within a beat or two, but
// it's still reported in that window, so the set stops a duplicate kill riding
// every 15s sweep until the record clears. It needs no durability — unlike
// auto-start's dedup (which stops a REFUSED spawn re-queuing forever), a
// re-issued kill of an already-dead session is a harmless no-op the agent
// ignores, and a still-live session re-derives into the sweep on its own.
const autoStopped = new Set(); // "<host>\x00<sessionId>" already auto-stopped

function autoStopSweep() {
  const orgs = orgsWithAutoStart();
  if (!orgs.size) return;
  // The set of now-Done tickets, per opted-in org, from the freshest reporting
  // block — the same copy the board renders and autoStartSweep reads its To Dos
  // from, so the hub stops on what the board shows, not a lagging host's view.
  const doneKeys = new Set(); // "<siteKey>\x00<issueKey>"
  for (const siteKey of orgs) {
    let block = null, bestAt = "";
    for (const a of Object.values(agents)) {
      if (!a.jira || a.jira.siteKey !== siteKey) continue;
      const at = String(a.jira.fetchedAt || "");
      if (!block || at > bestAt) { block = a.jira; bestAt = at; }
    }
    for (const t of (block && block.tickets) || []) {
      if (t && t.key && t.statusCategory === "done") {
        doneKeys.add(siteKey + "\x00" + t.key);
      }
    }
  }
  if (!doneKeys.size) return;
  for (const [host, a] of Object.entries(agents)) {
    for (const s of a.sessions || []) {
      // Only a LIVE session holds a slot and is worth stopping. A stopped/error
      // session already ended; a killed one is gone from a.sessions entirely.
      // A queued session (its ticket already Done before it ever ran) is killed
      // too — that's its Cancel path, and running it would be pointless.
      if (s.status !== "running" && s.status !== "queued") continue;
      const t = s.ticket;
      if (!t || !t.key) continue;
      if (!doneKeys.has((t.siteKey || "") + "\x00" + t.key)) continue;
      const dk = host + "\x00" + s.id;
      if (autoStopped.has(dk)) continue;
      queueCommand(host, { type: "kill", sessionId: s.id });
      autoStopped.add(dk);
    }
  }
}

// Don't act on freshly-loaded (possibly stale) state right after a hub boot, the
// same reason the offline sweep waits: let agents re-report first. (The opt-in map
// loads from disk at boot, but the sweeps only act on orgs with a live reporting
// block and route through findTicketHost, so they no-op until a host re-heartbeats
// anyway — this is belt-and-suspenders, kept out of the sweeps themselves so they
// stay pure, directly-callable units.)
setInterval(() => {
  if (Date.now() - BOOT_AT < BOOT_GRACE_MS) return;
  autoStartSweep();
  autoStopSweep();
}, AUTO_START_EVERY_MS).unref();

const INDEX = fs.readFileSync(path.join(__dirname, "public", "index.html"));
const USAGE = fs.readFileSync(path.join(__dirname, "public", "usage.html"));
const SESSIONS = fs.readFileSync(path.join(__dirname, "public", "sessions.html"));
const BOARD = fs.readFileSync(path.join(__dirname, "public", "board.html"));
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
  "/chat.js":              { body: fs.readFileSync(path.join(__dirname, "public", "chat.js")),             type: "text/javascript; charset=utf-8",           cache: "public, max-age=300" },
  "/board.js":             { body: fs.readFileSync(path.join(__dirname, "public", "board.js")),            type: "text/javascript; charset=utf-8",           cache: "public, max-age=300" },
  "/nav.js":               { body: fs.readFileSync(path.join(__dirname, "public", "nav.js")),              type: "text/javascript; charset=utf-8",           cache: "public, max-age=300" },
  "/org.js":               { body: fs.readFileSync(path.join(__dirname, "public", "org.js")),              type: "text/javascript; charset=utf-8",           cache: "public, max-age=300" },
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

// Clipboard bridge injected into ttyd's page: the half of "copy out of the
// terminal" that lives in the browser (XERK-7). A copy made inside the session
// travels out as an OSC 52 escape, and xterm.js PARSES OSC 52 but ships no
// handler for one — the sequence arrives and nothing happens — so a copy landed
// in the tab and went no further, pasteable inside the terminal and nowhere
// else. ttyd exposes its xterm instance as window.term, so registering the
// handler it lacks is all the hub has to do. The agent's tmux.conf holds the
// other half: tmux only emits OSC 52 when the outer terminfo advertises Ms.
//
// This is injected into <head>, so window.term won't exist for another beat or
// two — hence the retry rather than a single read at parse time.
const TERM_OSC52_JS =
  "(function(){" +
  "function wire(){" +
  "var t=window.term;" +
  "if(!t||!t.parser)return setTimeout(wire,50);" +
  "t.parser.registerOscHandler(52,function(data){" +
  // "<selection>;<payload>" — but tmux sends an EMPTY selection (";<payload>")
  // where a bare app sends "c;<payload>", so split at the first ';' rather than
  // matching a selection name we'd only have to enumerate.
  "var i=data.indexOf(';');var b64=i<0?data:data.slice(i+1);" +
  // "?" is a clipboard READ request, and this bridge is deliberately write-only:
  // answering one would hand any program running in the pane the operator's
  // whole clipboard. An empty payload is tmux copying an empty selection —
  // dropped rather than written, so a stray one can't wipe the clipboard.
  "if(b64==='?'||b64==='')return true;" +
  "try{" +
  "var bin=atob(b64);" +
  // OSC 52 carries base64 of UTF-8 BYTES; atob yields one char per byte, so the
  // bytes have to be decoded back or anything non-ASCII pastes as mojibake.
  "var text=new TextDecoder().decode(Uint8Array.from(bin,function(c){" +
  "return c.charCodeAt(0);}));" +
  // Rejects if the document isn't focused or the permission is refused. Nothing
  // to fall back to, and throwing here would land inside xterm.js's parser, so
  // swallow it: the operator is left exactly where this fix found them.
  "navigator.clipboard.writeText(text).catch(function(){});" +
  "}catch(e){}" +
  "return true;" +
  "});}" +
  "wire();})();";
const TERM_OSC52_CLIPBOARD = "<script>" + TERM_OSC52_JS + "</script>";

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

// Where the agent should look for a session's transcript, as last reported on a
// heartbeat: its worktree path (which resolves to the project dir) plus the
// transcript id naming its own conversation within that dir. The id matters for
// repos-root sessions, whose project dir is shared by every root session ever
// run — without it the agent tails whichever transcript there is newest, which
// is the previous session's (XERK-6). null if the session isn't known;
// transcriptId is null for an agent predating the pin, which leaves it on the
// newest-mtime rule it always used.
function watchTargetFor(host, sessionId) {
  const sess = (agents[host]?.sessions || []).find((s) => s.id === sessionId);
  if (!sess?.worktreePath) return null;
  return { worktreePath: sess.worktreePath, transcriptId: sess.transcriptId || null };
}

// A watched session's conversation MOVED — "Restart (clear context)" relaunches
// claude on a fresh transcript — so re-arm the agent's tail onto the new one.
//
// A watch is otherwise sent once (on first watcher / control reconnect) and the
// agent holds that target for the life of the watch, so without this the tail
// stays pinned to a file the restarted session will never write to again: it
// reports no deltas, and the chat sits frozen on the pre-restart conversation
// with nothing to correct it (the /history poll only runs while the socket is
// DOWN, and this one is healthy). Naming the transcript is what introduced the
// need — the newest-mtime rule this replaced rolled onto the new file by itself.
function rearmMovedWatches(host, prev, next) {
  const cc = controlChannels[host];
  const watched = liveClients[host];
  if (!cc || !watched) return;
  const before = new Map((prev?.sessions || []).map((s) => [s.id, s.transcriptId || null]));
  for (const sess of next?.sessions || []) {
    if (!watched[sess.id] || !sess.worktreePath) continue;
    const now = sess.transcriptId || null;
    // Only on a real move. An agent predating the pin reports null every beat,
    // which is not a move — and re-arming on every beat would be a no-op anyway.
    if (!before.has(sess.id) || before.get(sess.id) === now) continue;
    cc.sendWatch(sess.id, { worktreePath: sess.worktreePath, transcriptId: now });
  }
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
          // Insert the @font-face + touch-scroll shim + clipboard bridge before
          // </head> (fall back to prepending).
          const inject = TERM_FONT_STYLE + TERM_TOUCH_SCROLL + TERM_OSC52_CLIPBOARD;
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

    // The archive-ingest endpoint is agent-pushed (bearer token), like the
    // heartbeat — it must not require the user login the rest of /api/* does.
    const isArchiveIngest =
      req.method === "POST" && parts[0] === "api" && parts[1] === "agents" &&
      parts[3] === "archive" && parts.length === 5;

    // The expected-restart signal is agent-pushed (bearer token) like the
    // heartbeat: the agent fires it as it goes down, before it could ever hold
    // a user login (XERK-29).
    const isUpdatingSignal =
      req.method === "POST" && parts[0] === "api" && parts[1] === "agents" &&
      parts[3] === "updating" && parts.length === 4;

    // The programmatic trigger endpoint carries its own bearer-token auth (or a
    // user login), so it's gated by triggerAuthorized instead of the
    // browser-only userAuthorized gate below.
    const isTrigger = req.method === "POST" && url.pathname === "/api/trigger";

    if (url.pathname === "/api/heartbeat" || isArchiveIngest || isUpdatingSignal) {
      if (!agentAuthorized(req)) return json(res, 401, { error: "unauthorized" });
    } else if (isTrigger) {
      if (!triggerAuthorized(req)) return json(res, 401, { error: "unauthorized" });
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

    if (req.method === "GET" && (url.pathname === "/usage" || url.pathname === "/usage.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(USAGE);
    }

    // The page was /history until it dropped cost and became token-only. Keep
    // old bookmarks and the Android client's deep links working.
    if (req.method === "GET" && (url.pathname === "/history" || url.pathname === "/history.html")) {
      res.writeHead(301, { Location: "/usage" });
      return res.end();
    }

    if (req.method === "GET" && (url.pathname === "/sessions" || url.pathname === "/sessions.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(SESSIONS);
    }

    // Unified Jira Kanban across every agent's org (the agents' `jira`
    // heartbeat blocks; merging happens client-side in board.js).
    if (req.method === "GET" && (url.pathname === "/board" || url.pathname === "/board.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(BOARD);
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

    // Mobile push device registry. The Android client registers its FCM token
    // here so hub alerts (notify()) fan out to it; it unregisters on
    // sign-out. User-authed like the rest of the browser API (the gate above
    // already enforced it). Unregister takes the token as a query param, not a
    // path segment, because FCM tokens can contain `/`.
    if (req.method === "POST" && url.pathname === "/api/devices") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token) return json(res, 400, { error: "token required" });
      const platform = typeof body.platform === "string" ? body.platform : "android";
      registerDevice(token, platform);
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && url.pathname === "/api/devices") {
      const token = (url.searchParams.get("token") || "").trim();
      if (token) unregisterDevice(token);
      return json(res, 200, { ok: true });
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
      // On-demand background-agent transcripts the agent fetched since the last
      // beat (see the {type:"subagentHistory"} command); cached like history.
      const subagentHistoryResults = payload.subagentHistoryResults;
      delete payload.subagentHistoryResults;
      // On-demand Jira issue detail the agent fetched since the last beat (see
      // the {type:"jiraIssue"} command); cached below, like historyResults.
      const jiraIssueResults = payload.jiraIssueResults;
      delete payload.jiraIssueResults;
      // Archive sync manifest (see hub-agent.py _archive_manifest): the inactive
      // transcripts this host could ship. We upsert their metadata rows and hand
      // back a byte-cursor map so the agent knows what deltas to push. Kept off
      // the persisted record (it's transient, potentially large). Best-effort:
      // an archive/DB hiccup must never break the heartbeat.
      const archiveManifest = payload.archiveManifest;
      delete payload.archiveManifest;
      let archiveHave;
      if (Array.isArray(archiveManifest) && archiveManifest.length) {
        try { archiveHave = archive.manifestCursors(key, archiveManifest); }
        catch (e) { console.error(`archive manifest ingest failed: ${e.message}`); }
      }
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
        // Per-(session,type,label) background-agent transcript cache (see the
        // /subagents/history route); like `history`, survives across beats.
        subagentHistory: prev.subagentHistory || {},
        // Per-issue Jira detail cache (see the /api/jira route); like `history`,
        // survives across beats.
        jiraIssues: prev.jiraIssues || {},
      });
      ingestHistory(next, historyResults);
      ingestSubagentHistory(next, subagentHistoryResults);
      ingestJiraIssues(next, jiraIssueResults);
      heartbeatAlerts(key, prev, next);
      rearmMovedWatches(key, prev, next);
      scheduleSave();
      // A fresh beat landed — refresh the memoized fleet payload and push the
      // updated record to open dashboards so the UI reflects it near-instantly.
      publishAgent(key);
      return json(res, 200, archiveHave ? { commands, archiveHave } : { commands });
    }

    // POST /api/agents/<host>/updating — an agent announcing an EXPECTED restart
    // (an image update recreating its container, or the native self-updater) just
    // before it stops heartbeating, so the coming silence renders as `updating`
    // rather than an unexpected-outage `offline` (XERK-29). Agent-authed above,
    // like the heartbeat/archive. Body: {reason, version}. The status auto-clears
    // the instant the host heartbeats again (the beat rebuilds the record without
    // it) or once the grace window lapses on a stuck update.
    if (isUpdatingSignal) {
      const key = decodeURIComponent(parts[2]);
      const a = agents[key];
      // Only a host we already know can be "updating" — an unknown key has no
      // record to hang the status on and nothing to suppress an alert for.
      if (!a) return json(res, 404, { error: "unknown host" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const now = Date.now();
      a.updating = {
        at: now,
        until: now + UPDATING_GRACE_MS,
        reason: typeof body.reason === "string" ? body.reason.slice(0, 40) : "restart",
        version: typeof body.version === "string" ? body.version.slice(0, 40) : null,
      };
      scheduleSave();
      // Refresh the memoized fleet payload (its `updating`/`online` flags just
      // changed) and push the transition to open dashboards immediately.
      publishAgent(key);
      return json(res, 200, { ok: true });
    }

    // POST /api/agents/<host>/archive/<transcriptId> — an agent pushing one delta
    // chunk of an inactive session's transcript into the durable hub archive.
    // Agent-authed above. Body: {startOffset, endOffset, size, entries, meta}.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "agents" &&
        parts[3] === "archive" && parts.length === 5) {
      const key = decodeURIComponent(parts[2]);
      const transcriptId = decodeURIComponent(parts[4]);
      if (!/^[A-Za-z0-9._-]+$/.test(transcriptId)) return json(res, 400, { error: "bad transcriptId" });
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        const r = archive.ingestChunk(
          key, transcriptId, body.meta || {},
          Number(body.startOffset) || 0, Number(body.endOffset) || 0,
          Array.isArray(body.entries) ? body.entries : []
        );
        return json(res, 200, r);
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // GET /api/search?q=&repo=&host=&limit= — instant hub-local full-text search
    // over every archived session (works even for offline hosts).
    if (req.method === "GET" && url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 2) return json(res, 400, { error: "query too short" });
      try {
        return json(res, 200, archive.searchArchive(q, {
          repo: url.searchParams.get("repo") || undefined,
          host: url.searchParams.get("host") || undefined,
          limit: url.searchParams.get("limit") || undefined,
        }));
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // GET /api/archive?repo=&host=&limit=&offset= — browse ended sessions.
    if (req.method === "GET" && url.pathname === "/api/archive") {
      try {
        return json(res, 200, archive.listArchive({
          repo: url.searchParams.get("repo") || undefined,
          host: url.searchParams.get("host") || undefined,
          limit: url.searchParams.get("limit") || undefined,
          offset: url.searchParams.get("offset") || undefined,
        }));
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // GET /api/archive/<transcriptId> — one archived session's full transcript.
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "archive" && parts.length === 3) {
      const transcriptId = decodeURIComponent(parts[2]);
      const t = archive.getTranscript(transcriptId);
      if (!t) return json(res, 404, { error: "unknown transcript" });
      return json(res, 200, t);
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

    // POST /api/jira/refresh — the /board page's manual refresh: re-poll Jira
    // now rather than waiting out each agent's slow cadence (30 beats). It fans
    // out across hosts because the board is a MERGE of every host's block —
    // refreshing a single org would leave the rest of one board stale under a
    // button that reads "Refresh".
    //
    // Targets `configured` (creds present), not `available` (a poll has
    // succeeded): a host whose polls are failing reports available=false, and
    // that is precisely the host a manual retry is for. `|| siteKey` keeps
    // agents predating the `configured` field targetable on the only evidence
    // they report. Hosts with no Jira at all are skipped, so an unconfigured
    // fleet gets no commands (the agent re-checks anyway).
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "jira" &&
        parts[2] === "refresh" && parts.length === 3) {
      const hosts = Object.keys(agents).filter((k) => {
        const j = agents[k] && agents[k].jira;
        return !!j && (j.configured === true || !!j.siteKey);
      });
      // Collapse a mashed button: a host already holding an unacked refresh
      // would otherwise run one full re-poll per click. `hosts` still reports
      // it as targeted (a refresh IS in flight for it), while `queued` names
      // only what this call actually enqueued.
      const queued = hosts.filter(
        (k) => !(agents[k].commands || []).some((c) => c.type === "refreshJira")
      );
      for (const k of queued) queueCommand(k, { type: "refreshJira" });
      return json(res, 200, { ok: true, hosts, queued });
    }

    // POST /api/agents/<host>/transcripts/<transcriptId>/resume — resume ANY
    // prior Claude session by transcript id (the "Resume any session" picker),
    // not just a killed Turma session from closedSessions. Body: {cwd} is the
    // origin dir the picker showed; the agent re-reads/re-validates it and
    // re-creates the worktree at that path if it was deleted/pruned.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "agents" &&
        parts[3] === "transcripts" && parts[5] === "resume" && parts.length === 6) {
      const key = decodeURIComponent(parts[2]);
      if (!agents[key]) return json(res, 404, { error: "unknown agent" });
      const transcriptId = decodeURIComponent(parts[4]);
      if (!transcriptId) return json(res, 400, { error: "transcriptId required" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const cwd = typeof body.cwd === "string" ? body.cwd : "";
      const cmdId = queueCommand(key, { type: "resumeTranscript", transcriptId, cwd });
      return json(res, 200, { ok: true, cmdId });
    }

    // POST /api/trigger — programmatic "start a session" entry point for
    // external automation (CI, webhooks, scripts). Unlike the browser-oriented
    // POST /api/agents/<host>/sessions (which is user-auth-only and carries the
    // host/repo in the URL with an optional prompt), this takes all three
    // required inputs in the body and is authed by triggerAuthorized (the
    // dedicated TURMA_TRIGGER_TOKEN bearer, or a user login). It validates the
    // host AND the repo against the host's reported repos[] before queuing the
    // same {type:"spawn"} command the composer uses, so a bad hostname/repo
    // fails fast with a clear error instead of silently landing on the agent.
    if (req.method === "POST" && url.pathname === "/api/trigger") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const hostname = typeof body.hostname === "string" ? body.hostname.trim() : "";
      const repo = typeof body.repo === "string" ? body.repo.trim() : "";
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!hostname) return json(res, 400, { error: "hostname required" });
      if (!repo) return json(res, 400, { error: "repo required" });
      if (!prompt) return json(res, 400, { error: "prompt required" });
      if (prompt.length > 10000) return json(res, 400, { error: "prompt too long" });
      const agent = agents[hostname];
      if (!agent) return json(res, 404, { error: "unknown host" });
      // Validate the repo against what the host actually reports (its scanned
      // repos plus the "(root)" pseudo-repo). Skip the check only if the host
      // hasn't reported any repos yet, deferring to the agent's own validation.
      const known = Array.isArray(agent.repos)
        ? agent.repos.map((r) => r && r.name).filter(Boolean)
        : [];
      if (known.length && !known.includes(repo)) {
        return json(res, 404, { error: "unknown repo" });
      }
      const cmd = { type: "spawn", repo, prompt };
      for (const f of ["label", "baseRef", "model", "permissionMode"]) {
        if (typeof body[f] === "string" && body[f].trim()) cmd[f] = body[f].trim();
      }
      const cmdId = queueCommand(hostname, cmd);
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
      // POST /api/agents/<host>/sessions/<id>/interrupt -> stop the turn a
      // running session has in flight (the agent sends Escape to its TUI). The
      // session survives with its conversation intact — this is the gentle
      // sibling of kill/restart, so it takes no body and needs no confirmation.
      if (req.method === "POST" && parts.length === 6 && parts[5] === "interrupt") {
        const cmdId = queueCommand(key, { type: "interrupt", sessionId });
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
      // POST /api/agents/<host>/sessions/<id>/model -> switch a running
      // session's model live, for that session only (the agent drives the
      // /model picker's session-only path). Body: {model}, an alias from the
      // host's probed `models.available` (or the static fallback set); the
      // agent re-validates against its own allowlist before any key is pressed
      // — this check only rejects the plainly malformed.
      if (req.method === "POST" && parts.length === 6 && parts[5] === "model") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const model = typeof body.model === "string" ? body.model : "";
        if (!model) return json(res, 400, { error: "model required" });
        if (model.length > 60 || !/^[a-z0-9.[\]-]+$/i.test(model))
          return json(res, 400, { error: "invalid model" });
        const cmdId = queueCommand(key, { type: "setModel", sessionId, model });
        return json(res, 200, { ok: true, cmdId });
      }
      // POST /api/agents/<host>/sessions/<id>/summary -> rename a session (the
      // few-word name its card leads with, normally auto-generated at spawn).
      // Body: {summary}; an empty/blank one clears the name back to the
      // label/worktree fallback. Purely presentational, so it's allowed on a
      // stopped session too; the agent caps the length it stores.
      if (req.method === "POST" && parts.length === 6 && parts[5] === "summary") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const summary = typeof body.summary === "string" ? body.summary : "";
        if (summary.length > 200) return json(res, 400, { error: "summary too long" });
        const cmdId = queueCommand(key, { type: "setSummary", sessionId, summary });
        return json(res, 200, { ok: true, cmdId });
      }
      // POST /api/agents/<host>/sessions/<id>/mode -> switch a running session's
      // permission mode live (agent injects Shift+Tab presses to cycle to it).
      // Body: {permissionMode}, one of the composer's allowlisted modes; the
      // agent re-validates and no-ops an off-cycle target.
      if (req.method === "POST" && parts.length === 6 && parts[5] === "mode") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const permissionMode = typeof body.permissionMode === "string" ? body.permissionMode : "";
        if (!permissionMode) return json(res, 400, { error: "permissionMode required" });
        const cmdId = queueCommand(key, { type: "setMode", sessionId, permissionMode });
        return json(res, 200, { ok: true, cmdId });
      }
      // POST /api/agents/<host>/sessions/<id>/answer -> answer a pending
      // AskUserQuestion. Body: {optionIndex} (0-based single pick), or
      // {optionIndices} (a list, for a multiSelect question), and/or {custom}
      // (free-text / "Other" answer). The agent drops the answer file the ask.py
      // bridge is blocked on. No option and no text means nothing to answer with.
      if (req.method === "POST" && parts.length === 6 && parts[5] === "answer") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const optionIndex = Number.isInteger(body.optionIndex) ? body.optionIndex : -1;
        const optionIndices = Array.isArray(body.optionIndices)
          ? body.optionIndices.filter((n) => Number.isInteger(n) && n >= 0)
          : null;
        const custom = typeof body.custom === "string" ? body.custom : "";
        const hasPick = optionIndex >= 0 || (optionIndices && optionIndices.length > 0);
        if (!hasPick && !custom.trim()) {
          return json(res, 400, { error: "optionIndex, optionIndices or custom required" });
        }
        if (custom.length > 4000) return json(res, 400, { error: "custom too long" });
        const cmd = { type: "answerQuestion", sessionId, optionIndex };
        if (optionIndices && optionIndices.length) cmd.optionIndices = optionIndices;
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
            queued: cached.queued || [],
            fetchedAt: cached.fetchedAt,
          });
        }
        const pending = (agents[key].commands || [])
          .find((c) => c.type === "history" && c.sessionId === sessionId);
        const cmdId = pending ? pending.cmdId : queueCommand(key, { type: "history", sessionId });
        return json(res, 202, { pending: true, cmdId });
      }
      // GET /api/agents/<host>/sessions/<id>/subagents/history?type=&label= ->
      // the transcript of one live background agent the session spawned (the
      // pane agent-list row identifies it by type + short description). Same
      // fresh-cache / queue-and-202 / single-flight shape as /history.
      if (req.method === "GET" && parts.length === 7 &&
          parts[5] === "subagents" && parts[6] === "history") {
        const agentType = (url.searchParams.get("type") || "").trim();
        const label = (url.searchParams.get("label") || "").trim();
        if (!agentType) return json(res, 400, { error: "type required" });
        const cached = (agents[key].subagentHistory || {})[subagentKey(sessionId, agentType, label)];
        if (cached && Date.now() - cached.fetchedAt < HISTORY_FRESH_MS) {
          return json(res, 200, {
            entries: cached.entries,
            truncated: cached.truncated,
            fetchedAt: cached.fetchedAt,
          });
        }
        const pending = (agents[key].commands || []).find(
          (c) => c.type === "subagentHistory" && c.sessionId === sessionId &&
            c.agentType === agentType && (c.label || "") === label);
        const cmdId = pending ? pending.cmdId
          : queueCommand(key, { type: "subagentHistory", sessionId, agentType, label });
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

    // GET /api/jira/<siteKey>/<issueKey> -> one ticket's full detail
    // (description + comments) for the board's expanded view. The hub holds no
    // Jira creds — they're per-host, user-scoped env — so this routes to a host
    // reporting that org and rides the same {command -> staged result -> next
    // beat} path as session history: a fresh cached issue is served outright,
    // otherwise a fetch is queued (single-flight per key) and reported pending
    // for the client to poll. Read-only; nothing here writes to Jira.
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "jira" && parts.length === 4) {
      const siteKey = decodeURIComponent(parts[2]);
      const issueKey = decodeURIComponent(parts[3]);
      if (!isIssueKey(issueKey)) {
        return json(res, 400, { error: "not a valid issue key" });
      }
      // Fall back to an offline host's cache: its last fetch of this ticket is
      // still worth showing (the board already shows its stale tickets), even
      // though we can't queue a refresh for it.
      const key = findJiraHost(siteKey, true) || findJiraHost(siteKey, false);
      if (!key) return json(res, 404, { error: "no host reports that Jira org" });
      const cached = (agents[key].jiraIssues || {})[issueKey];
      if (cached && Date.now() - cached.fetchedAt < JIRA_ISSUE_FRESH_MS) {
        return json(res, 200, cached.error
          ? { error: cached.error, fetchedAt: cached.fetchedAt }
          : { issue: cached.issue, fetchedAt: cached.fetchedAt });
      }
      if (Date.now() - (agents[key].lastSeen || 0) >= OFFLINE_AFTER_MS) {
        // Offline: a queued command would never be delivered, so answer with
        // whatever we last got rather than leaving the client polling forever.
        if (cached) {
          return json(res, 200, cached.error
            ? { error: cached.error, fetchedAt: cached.fetchedAt, stale: true }
            : { issue: cached.issue, fetchedAt: cached.fetchedAt, stale: true });
        }
        return json(res, 503, { error: `host ${key} is offline` });
      }
      const pending = (agents[key].commands || [])
        .find((c) => c.type === "jiraIssue" && c.issueKey === issueKey);
      const cmdId = pending ? pending.cmdId : queueCommand(key, { type: "jiraIssue", issueKey });
      return json(res, 202, { pending: true, cmdId });
    }

    // POST /api/jira/<siteKey>/<issueKey>/session -> start a session to work
    // this ticket (the board card's start button).
    //
    // The hub's whole job here is ROUTING — picking the one host that can do the
    // work — because it's the only party that sees the whole fleet. It sends just
    // the issue key: the agent re-derives the repo, the ticket text and the branch
    // name from its own local state, so a board that's a beat or two stale can't
    // spawn against a repo the ticket has since been re-triaged away from.
    //
    // That re-derivation is also what makes a manual override (the /repo route
    // below) authoritative here for free: the agent reads its own ledger, where a
    // pin outranks the model, so a ticket the operator re-assigned spawns in the
    // repo THEY chose without this route knowing the override exists.
    //
    // The reply is the queued cmdId, which the agent echoes back on the session it
    // mints as `spawnCmdId` — the same correlation handle the composer's spawn
    // uses, since the session id doesn't exist yet at POST time.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 5 && parts[4] === "session") {
      const siteKey = decodeURIComponent(parts[2]);
      const issueKey = decodeURIComponent(parts[3]);
      if (!isIssueKey(issueKey)) {
        return json(res, 400, { error: "not a valid issue key" });
      }
      // Org first, then the repo: an org nobody reports has no ticket to be
      // untriaged, and answering "no triaged repo yet" for it would send the
      // operator looking for a triage problem they don't have.
      if (!findJiraHost(siteKey, false)) {
        return json(res, 404, { error: "no host reports that Jira org" });
      }
      const repo = ticketRepo(siteKey, issueKey);
      // The button is only enabled on a triaged, cloned ticket, so this is a
      // stale board (or a hand-rolled POST) rather than a normal path.
      if (!repo) {
        return json(res, 409, { error: "that ticket has no triaged repo yet" });
      }
      const { host, error, status, needsClone } = findTicketHost(siteKey, repo, issueKey);
      if (!host) return json(res, status, { error });
      // Single-flight per ticket, like the jiraIssue fetch above: a double-click
      // (or a click while the first spawn is still riding the queue) must not
      // start two sessions on one ticket.
      const pending = (agents[host].commands || [])
        .find((c) => c.type === "spawnTicket" && c.issueKey === issueKey);
      const cmdId = pending ? pending.cmdId
        : queueCommand(host, { type: "spawnTicket", issueKey });
      // needsClone tells the board the chosen host doesn't have the repo yet, so
      // it will clone on demand and the session starts queued behind the clone.
      return json(res, 200, { ok: true, cmdId, host, repo, needsClone });
    }

    // POST /api/jira/<siteKey>/<issueKey>/repo — the operator's own answer to
    // which repo a ticket belongs in, overriding the agent's guess.
    // Body: {repo:"<name>"} to pin one, {repo:null} for "no repo fits", or
    // {auto:true} to release the pin back to the model.
    //
    // This writes to the AGENT's triage ledger, not to Jira — the board stays
    // pull-only with respect to Jira itself; nothing here touches the issue.
    //
    // It fans out to EVERY host reporting that org, not just the one findJiraHost
    // would pick for a read. The ledger is per-host while the board merges hosts
    // by siteKey (freshest block wins), so pinning on only one host would leave
    // the override flickering in and out as the merge picked a different host's
    // block. The repo name is allowlist-checked host-side against that host's own
    // candidates; a host that can't offer it declines and logs, which is why this
    // reports what it queued rather than claiming success for the fleet.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 5 && parts[4] === "repo") {
      const siteKey = decodeURIComponent(parts[2]);
      const issueKey = decodeURIComponent(parts[3]);
      if (!isIssueKey(issueKey)) {
        return json(res, 400, { error: "not a valid issue key" });
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      const auto = body.auto === true;
      // `repo` absent and auto unset is a malformed request, not a decline —
      // "no repo fits" must be an explicit null, exactly as _parse_triage
      // requires of the model. Conflating them would let a body that lost a
      // field silently paint a "no repo" chip.
      if (!auto && !("repo" in body)) {
        return json(res, 400, { error: "body needs {repo} or {auto:true}" });
      }
      const repo = auto ? null : body.repo;
      if (!auto && repo !== null &&
          !(typeof repo === "string" && /^[A-Za-z0-9._-]+$/.test(repo))) {
        return json(res, 400, { error: "not a repo name" });
      }
      // Every host reporting the org, INCLUDING offline ones. Commands are queued
      // and at-least-once, so an offline host takes the pin whenever it returns —
      // which is the point: a host that misses it comes back reporting the model's
      // old guess, and (with the freshest block winning the merge) can silently
      // revert an override the operator already made. Landing late beats never
      // landing. `setJiraRepo` is idempotent, so a delayed delivery is harmless.
      //
      // `online` is still what the BOARD gates its Change control on — an operator
      // watching wants the pin to show up now, not in an hour — but that is a UI
      // judgement about feedback, not a reason to let the fleet diverge.
      const hosts = Object.keys(agents).filter(
        (k) => agents[k] && agents[k].jira && agents[k].jira.siteKey === siteKey);
      if (!hosts.length) {
        return json(res, 404, { error: "no host reports that Jira org" });
      }
      const online = hosts.filter(
        (k) => Date.now() - (agents[k].lastSeen || 0) < OFFLINE_AFTER_MS);
      let cmdId = null;
      for (const k of hosts) {
        cmdId = queueCommand(k, { type: "setJiraRepo", siteKey, issueKey, repo, auto });
      }
      return json(res, 202, { ok: true, hosts, online, cmdId });
    }

    // POST /api/jira/<siteKey>/<issueKey>/agent — pin which HOST this ticket's
    // sessions spawn on, overriding findTicketHost's most-available pick
    // (XERK-38). Body: {host:"<agent key>"} to pin, {auto:true} to release back
    // to automatic routing.
    //
    // Unlike the /repo override above this does NOT fan out to the agents: the
    // pin is a routing input, routing happens here on the hub (the only party
    // that sees the whole fleet), and the store is the hub's own durable
    // ticket-agents file. So the save is authoritative the moment it returns —
    // a 200, not the /repo route's 202-on-queue.
    //
    // The host must currently report the org, but need not be ONLINE: the pin
    // is a persistent choice about future spawns, and pinning a host that's
    // momentarily asleep is a valid answer (the spawn itself still requires it
    // online, in findTicketHost). What it must not be is a name this org's
    // picker never offered — hence the allowlist against the fleet.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 5 && parts[4] === "agent") {
      const siteKey = decodeURIComponent(parts[2]);
      const issueKey = decodeURIComponent(parts[3]);
      if (!isIssueKey(issueKey)) {
        return json(res, 400, { error: "not a valid issue key" });
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      const auto = body.auto === true;
      if (!auto && !(typeof body.host === "string" && body.host)) {
        return json(res, 400, { error: "body needs {host} or {auto:true}" });
      }
      if (!Object.values(agents).some(
        (a) => a && a.jira && a.jira.siteKey === siteKey)) {
        return json(res, 404, { error: "no host reports that Jira org" });
      }
      if (!auto) {
        const a = agents[body.host];
        if (!a || !a.jira || a.jira.siteKey !== siteKey) {
          return json(res, 400, { error: "that agent does not report this Jira org" });
        }
      }
      setTicketAgent(siteKey, issueKey, auto ? null : body.host);
      return json(res, 200, { ok: true, host: auto ? null : body.host });
    }

    // POST /api/jira/<siteKey>/autostart — flip an org's auto-start opt-in
    // (XERK-41). Body: {enabled:true|false}. Hub-owned durable state, so — like
    // the /agent pin and unlike the /repo override — the save is authoritative
    // the moment it returns (a 200, nothing rides a heartbeat). The org must be
    // one the fleet actually reports, so a toggle can't invent a phantom org;
    // the host need NOT be online (the opt-in is a persistent choice, and the
    // sweep gates the actual spawn on a live host itself).
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 4 && parts[3] === "autostart") {
      const siteKey = decodeURIComponent(parts[2]);
      const body = JSON.parse((await readBody(req)) || "{}");
      if (typeof body.enabled !== "boolean") {
        return json(res, 400, { error: "body needs {enabled:true|false}" });
      }
      if (!Object.values(agents).some(
        (a) => a && a.jira && a.jira.siteKey === siteKey)) {
        return json(res, 404, { error: "no host reports that Jira org" });
      }
      setAutoStartOrg(siteKey, body.enabled);
      return json(res, 200, { ok: true, enabled: body.enabled });
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
      // Start/stop the agent's live tail of one session's transcript. See
      // watchTargetFor for what the agent needs to locate it.
      sendWatch: (sessionId, target) =>
        send(0x1, JSON.stringify({ watch: sessionId, ...target })),
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
      const target = watchTargetFor(name, sessionId);
      if (target) controlChannels[name].sendWatch(sessionId, target);
    }
    // Liveness, in both directions — the channel is proven, never assumed.
    //
    // The protocol ping (0x9) beats Cloudflare's idle timeout and is what every
    // agent auto-pongs (Node's built-in WebSocket answers it internally), so the
    // returning 0xa is a liveness signal we get from OLD agents for free — it is
    // how we spot a half-open channel to a host that died without a FIN, which we
    // would otherwise keep reporting as `terminalOnline` while every Attach on it
    // hung until openChannel's timeout.
    //
    // The app-level {ping} is the same beat in a frame the AGENT can see: that
    // same internal handling means a browser-style WebSocket surfaces no ping
    // event and offers no ping method, so a protocol ping is invisible to it and
    // the agent has no way to notice we are gone. This text frame is the one
    // liveness signal its onmessage can observe. Agents predating it ignore an
    // unknown key and are unaffected.
    let lastSeen = Date.now();
    const ping = setInterval(() => {
      const idle = Date.now() - lastSeen;
      if (idle > CONTROL_DEAD_AFTER_MS) {
        // Nothing (not even a pong) for 3 beats: the peer is gone and this
        // socket is half-open. Destroy it so `terminalOnline` tells the truth
        // and the agent's own reconnect isn't racing a channel we still hold.
        console.log(`tunnel silent for ${Math.round(idle / 1000)}s; dropping: ${name}`);
        try { socket.destroy(); } catch {}
        cleanup();
        return;
      }
      send(0x9, Buffer.alloc(0));
      send(0x1, JSON.stringify({ ping: Date.now() }));
    }, CONTROL_PING_EVERY_MS);
    // The agent pushes live deltas back on this same channel: committed
    // transcript entries as `{tail: sessionId, entries}`, and the in-progress
    // assistant turn scraped from the TUI as `{turn: sessionId, text, status}`
    // (real-time streaming — `status` is the parsed working indicator, verb +
    // token counters, for the chat's pinned status bar; empty text + null
    // status clears it once the turn completes and the committed tail owns it).
    // Everything else it sends we ignore.
    const parse = wsParser((op, payload) => {
      // ANY frame proves the peer is alive — including the 0xa pong, which is
      // the only thing an idle agent sends back and which we otherwise ignore.
      lastSeen = Date.now();
      if (op === 0x8) return socket.end();
      if (op !== 0x1) return;
      let msg;
      try { msg = JSON.parse(payload.toString("utf8")); } catch { return; }
      if (msg && msg.tail && Array.isArray(msg.entries)) {
        // `queued` = still-queued prompts typed mid-turn (foldQueueOp in
        // tunnel-agent.js); absent from agents predating it.
        liveFanout(name, msg.tail, { type: "tail", entries: msg.entries,
          queued: Array.isArray(msg.queued) ? msg.queued : [] });
      } else if (msg && msg.turn && typeof msg.text === "string") {
        liveFanout(name, msg.turn, { type: "turn", text: msg.text, status: msg.status || null });
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
      const target = watchTargetFor(host, sessionId);
      if (target && controlChannels[host]) controlChannels[host].sendWatch(sessionId, target);
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
    invalidateAgentsCache,
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
    triggerAuthorized,
    safeEqual,
    credentialsMatch,
    issueSessionToken,
    sessionTokenValid,
    fmtDur,
    TERM_OSC52_JS,
    pcmToWav,
    transcribePcm,
    issueWsToken,
    wsTokenValid,
    registerDevice,
    unregisterDevice,
    listDevices,
    pruneDevices,
    autoStartSweep,
    autoStopSweep,
    startedTicketKeys,
    orgsWithAutoStart,
    autoStarted,
    autoStopped,
    autoStartOrgs,
    setAutoStartOrg,
    ticketAgents,
    findTicketHost,
  };
} else {
  if (!TURMA_PASSWORD) console.warn("WARNING: TURMA_USER/TURMA_PASSWORD not set — UI is unauthenticated");
  if (!TURMA_AGENT_TOKEN) console.warn("WARNING: TURMA_AGENT_TOKEN not set — heartbeat and tunnel endpoints are unauthenticated");
  if (!TURMA_TRIGGER_TOKEN) console.warn("WARNING: TURMA_TRIGGER_TOKEN not set — POST /api/trigger accepts only the user login (no dedicated token)");
  server.listen(PORT, () => {
    console.log(`turma listening on :${PORT}`);
    console.log(
      push.fcmEnabled()
        ? "FCM push alerts -> Android devices"
        : "FCM push alerts disabled (FCM_SERVICE_ACCOUNT_JSON not set)"
    );
    console.log(
      WHISPER_URL ? `whisper STT -> ${WHISPER_URL}` : "whisper STT disabled (LITELLM_URL/WHISPER_URL not set)"
    );
  });
}
