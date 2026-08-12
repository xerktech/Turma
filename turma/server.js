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
// Ticket -> model pins (XERK-123): which MODEL a ticket's session runs, chosen
// by the operator in the board's ticket detail panel. Like the agent pin (and
// unlike the repo override) this is hub-owned durable state on /data: the model
// is carried on the spawnTicket command the hub already routes, so the hub is
// the one party that has to remember it. The alias ("opus"/"sonnet"/…) the agent
// resolves at spawn, never a raw model id.
const TICKET_MODELS_FILE = process.env.TICKET_MODELS_FILE || "/data/ticket-models.json";
const TICKET_MODELS_MAX = 500;
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
// Manual org-color pins (XERK-145): siteKey -> palette slot 1..8, the operator's
// override of the hash-assigned org color. Hub-owned durable state like the
// auto-start opt-in (same reasons: per-org, tiny, must survive a restart, and
// shared by web + android through the fleet payload + its own SSE event).
const ORG_COLORS_FILE = process.env.ORG_COLORS_FILE || "/data/org-colors.json";
const ORG_COLOR_SLOTS = 8; // categorical palette --s1..--s8 (app.css / TurmaColors.series)
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
// How long a message typed into a session may be (XERK-227). The operator pastes
// logs and specs into the chat composer and the raw terminal takes them at any
// size, so this is a payload backstop — the agent delivers the text to the pane
// as a tmux paste, which has no length limit of its own — not a product limit.
// Kept under readBody's 1 MiB request cap, and refused explicitly so the composer
// can say "too long" instead of the generic "Send failed".
const INPUT_MAX_CHARS = Number(process.env.INPUT_MAX_CHARS) || 100000;
// What an agent that doesn't report `inputMaxChars` can take. Such an agent
// predates the paste delivery: it types the message as a tmux `send-keys`
// argument and CLIPS it to 4k first, silently, so a longer message arrives with
// its end missing and the operator is never told. The hub is the only side that
// can see that mismatch, so it enforces the receiving agent's own limit and lets
// the cap rise per host as hosts update — no version table to drift.
const LEGACY_INPUT_MAX_CHARS = 4000;

/**
 * The longest message this agent will deliver INTACT — its heartbeated
 * `inputMaxChars`, clamped to the hub's own cap; the conservative legacy limit
 * when it doesn't report one. Never trust it to be larger than the hub allows.
 */
function inputCapFor(agent) {
  const reported = Number(agent && agent.inputMaxChars);
  if (!Number.isFinite(reported) || reported <= 0) return LEGACY_INPUT_MAX_CHARS;
  return Math.min(reported, INPUT_MAX_CHARS);
}

// Whether a host can run a session on its own self-hosted model (XERK-246).
// Same contract as inputCapFor above: an agent that predates the failover — or
// one with no LOCAL_MODEL_* env — reports nothing, and an ABSENT flag means
// "that agent cannot do it", never "assume it can". Clients hide the control
// rather than queue a command the host will ack and drop.
function localModelAvailable(agent) {
  return Boolean(agent && agent.localModel && agent.localModel.available);
}

// Which model source a host reports for one of its sessions, "" when unknown.
function sessionModelSource(hostKey, sessionId) {
  const s = (agents[hostKey]?.sessions || []).find((x) => x.id === sessionId);
  return (s && s.modelSource) || "";
}

// Validate a spawn's optional modelSource the same way the switch route does.
// Returns null when fine, else {status, error}. Spawning onto the local model is
// how you start NEW work once usage is gone, so it gets the same enum check and
// the same capability gate rather than failing later as an errored session card.
function checkSpawnModelSource(cmd, hostKey) {
  if (cmd.modelSource == null) return null;
  if (!["subscription", "local"].includes(cmd.modelSource)) {
    return { status: 400, error: "modelSource must be subscription or local" };
  }
  if (cmd.modelSource === "local" && !localModelAvailable(agents[hostKey])) {
    return { status: 409, error: "host has no local model configured" };
  }
  return null;
}

// ---- file attachments (XERK-234) --------------------------------------------
// The composer's 📎 uploads a file, which lands on the agent's host as a real
// file the session can Read; the message typed into the pane carries its path.
// The hub is the RELAY, not the store: agents are outbound-only, so a client
// POSTs the bytes here, they sit in memory under an id, and the agent GETs them
// when it picks up the `input` command carrying that id. Nothing touches /data —
// an upload that is never collected simply expires.
const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES) || (1 << 25); // 32 MiB per file
// The whole relay's memory ceiling. Held blobs are RAM, so this is the number
// that keeps a hub with a fat pipe and a slow agent from being OOM'd; a POST
// arriving over it is refused rather than evicting someone else's pending file.
const UPLOAD_TOTAL_MAX_BYTES = Number(process.env.UPLOAD_TOTAL_MAX_BYTES) || (1 << 27); // 128 MiB
// How long a staged blob waits to be collected. Generous, because the operator
// attaches files and then keeps typing before pressing Send — the clock starts
// at the upload, not at the message.
const UPLOAD_TTL_MS = 20 * 60 * 1000;
const UPLOAD_MAX_PER_MESSAGE = 10;

// uploadId -> {id, host, sessionId, name, size, bytes, at}
const uploads = new Map();

/**
 * A filename safe to hand an agent that will join it onto a directory path.
 * Both sides sanitize (the agent must never trust a name off the wire), but the
 * hub does it FIRST so the name the operator sees on the chip is the name the
 * file lands under. Keeps a readable ASCII skeleton: basename only, no
 * separators, no control bytes, no leading dot (a dotfile hides the upload).
 */
function safeUploadName(name) {
  let s = String(name == null ? "" : name);
  s = s.split(/[\\/]/).pop() || "";               // basename, both separators
  s = s.replace(/[\u0000-\u001f\u007f]/g, "");     // control bytes
  s = s.replace(/[^A-Za-z0-9._ ()+-]/g, "_");     // conservative charset
  s = s.replace(/\s+/g, " ").trim().replace(/^\.+/, "").trim();
  if (s.length > 100) {
    // Keep the extension — it is what tells the agent (and Claude Code's Read)
    // what kind of file this is; truncating it away would make a .png unreadable.
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : "";
    s = s.slice(0, 100 - ext.length) + ext;
  }
  return s || "upload";
}

/** Total bytes the relay is currently holding. */
function uploadsHeldBytes() {
  let n = 0;
  for (const u of uploads.values()) n += u.size;
  return n;
}

/** Drop staged blobs nobody collected. Called before every accept and read. */
function sweepUploads(now = Date.now()) {
  for (const [id, u] of uploads) {
    if (now - u.at > UPLOAD_TTL_MS) uploads.delete(id);
  }
}

/**
 * The largest file this host can take, or 0 when it can't take one at all.
 * `uploadMaxBytes` is the agent's capability flag as well as its cap (like
 * `inputMaxChars`): an agent predating attachments reports nothing and would
 * silently drop the `uploads` on an input command, so the clients hide the 📎
 * rather than let the operator attach into a void.
 */
function uploadCapFor(agent) {
  const reported = Number(agent && agent.uploadMaxBytes);
  if (!Number.isFinite(reported) || reported <= 0) return 0;
  return Math.min(reported, UPLOAD_MAX_BYTES);
}
// Board ticket detail (description + comments), fetched on demand from the host
// that owns the org's Jira creds. Cached briefly so reopening a ticket, or two
// dashboards viewing one, doesn't re-hit Jira; kept much shorter-lived than a
// transcript because a ticket is edited by other people while you read it.
const JIRA_ISSUE_FRESH_MS = 60 * 1000; // serve a cached issue under this age
const JIRA_ISSUE_MAX_AGE_MS = 10 * 60 * 1000; // evict cache entries older than this
const JIRA_ISSUE_MAX = 40; // cap per-host cache; oldest fetchedAt evicted first

// New-ticket create metadata + results (XERK-137), cached per host like the
// issue detail above. Project/type/label meta changes rarely, so it's served for
// longer; a create RESULT is kept just long enough for the submitting client to
// poll it back (the created ticket then shows on the board via the normal poll).
const CREATE_META_FRESH_MS = 5 * 60 * 1000; // serve cached create-meta under this age
const CREATE_META_MAX_AGE_MS = 30 * 60 * 1000; // evict meta/type cache entries older
const CREATE_TYPES_MAX = 40; // cap the per-project type cache; oldest evicted
const CREATE_RESULT_MAX_AGE_MS = 10 * 60 * 1000; // evict a create result older than this
const CREATE_RESULT_MAX = 40; // cap the per-cmdId create-result cache

// A command an agent doesn't implement is ACKED, not refused (hub-agent.py's
// handle_commands logs `unknown command type` and acks so a poison command
// can't be retried forever). So a host running an agent that PREDATES a board
// write feature is indistinguishable from a merely slow one: the routes that
// wait on a staged result 202 forever and the client gives up with "the host
// didn't answer in time" (XERK-151 — an ADO host on agent v0.5.38, which has
// no boardCreateMeta, so the New-ticket form's project list never loaded).
//
// The ack IS the evidence. These commands stage their result inside the same
// handle_commands call, so the result rides the SAME beat as the ack: an ack
// carrying no result means the agent did not handle the command, and the route
// can say so in a beat or two instead of hanging. Version-free by design — the
// agent proves what it can do rather than the hub keeping a version table.
const RESULT_WAIT_MAX_MS = 5 * 60 * 1000; // forget a wait whose command never got acked
// A proven gap is re-probed this often. The precise signal that an agent grew
// the feature is its version CHANGING (below), which clears every gap at once;
// this is the backstop for the update that doesn't move the string — a dev
// build, a same-version reinstall, or a gap recorded from a one-off ack.
const UNSUPPORTED_TTL_MS = 30 * 60 * 1000;

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

// A PR alert is held until that PR's CI is green (XERK-153), so these two
// windows are what stop "held" from meaning "lost".
//
// A PR that genuinely has NO CI has to alert on creation, but a just-opened one
// reports an empty check rollup for a beat or two before its workflows
// register — indistinguishable from a repo with no CI at all. So "no CI" only
// counts once it has held for this long (a couple of the agent's ~60s PR-status
// refreshes), which is also the floor on how fast a CI-less repo's PR alerts.
const PR_NO_CI_GRACE_MS = 2 * 60 * 1000;
// Backstop for a PR whose CI verdict never arrives: an agent with no `gh`
// login never fills in the status at all, and a session stopped mid-run freezes
// its PRs at whatever they last read. Neither is a reason to lose the alert
// entirely, so an inconclusive wait fires anyway once it ages out. A wait that
// went FAILING is exempt — staying quiet on red is the point of the feature.
const PR_ALERT_MAX_WAIT_MS = 30 * 60 * 1000;
// Per-session ceiling on both PR bookkeeping lists (newest kept).
const PR_ALERT_MAX_TRACKED = 20;

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
  // Records written before the ingest-side coercion below (and any host that is
  // OFFLINE, so no beat will ever rewrite its record) still carry the legacy
  // per-model usage shape — normalize what we load, not just what arrives.
  for (const a of Object.values(agents)) normalizeUsage(a);
  console.log(`loaded ${Object.keys(agents).length} agents from ${STATE_FILE}`);
} catch {
  /* first boot or no volume mounted */
}
// The state blob, or null when it cannot be produced. JSON.stringify throws
// RangeError once the aggregate passes V8's ~512 MiB string ceiling, and it runs
// inside the save TIMER — an unguarded throw is an uncaught exception on the
// main loop, so the whole hub exits, taking every host's control plane with it
// and losing the very file the save exists to protect. Failing to save is
// survivable; dying is not (XERK-235). Lifted out of scheduleSave so the
// failure path is reachable from a test.
function serializeAgentsForSave() {
  try {
    return JSON.stringify(agents);
  } catch (e) {
    console.error(`state save skipped — could not serialize agent state: ${e.message}`);
    return null;
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // JSON.stringify throws RangeError once the aggregate passes V8's ~512 MiB
    // string ceiling. It runs INSIDE this timer callback, so an unguarded throw
    // is an uncaught exception on the main loop — the whole hub exits, taking
    // every host's control plane with it, and state.json is the one thing the
    // crash was supposed to protect. Failing to save is survivable; dying is
    // not (XERK-235).
    const blob = serializeAgentsForSave();
    if (blob === null) return;
    fs.mkdir(path.dirname(STATE_FILE), { recursive: true }, () => {
      fs.writeFile(STATE_FILE, blob, (err) => {
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
function registerDevice(token, platform, features) {
  const now = Date.now();
  // What this app build can do (XERK-154). Only a build that declares "dismiss"
  // is sent retractions — an older one has no handler for them and would render
  // the data-only dismiss as a blank "Turma" notification. Omitted on re-register
  // keeps the stored set (an old app can't erase a newer one's capabilities).
  const caps = Array.isArray(features) ? features.filter((f) => typeof f === "string") : null;
  const existing = devices.find((d) => d.token === token);
  if (existing) {
    existing.platform = platform || existing.platform;
    if (caps) existing.features = caps;
    existing.seenAt = now;
  } else {
    devices.push({ token, platform: platform || "android", features: caps || [], addedAt: now, seenAt: now });
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

// ---- ticket -> model pins (XERK-123) ---------------------------------------
// The operator's own answer to which MODEL a ticket's session runs, overriding
// the login's default. Keyed "<siteKey>/<issueKey>" like the agent pin; each
// entry {model, at} where `model` is a plain alias. Hub-owned and durable for
// the same reason the agent pin is: the model is delivered on the spawnTicket
// command the hub routes, so the hub must remember the choice across a restart.
let ticketModels = {};
try {
  const parsed = JSON.parse(fs.readFileSync(TICKET_MODELS_FILE, "utf8"));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ticketModels = parsed;
} catch {
  /* first boot or no volume mounted */
}
let tmSaveTimer = null;
function scheduleTicketModelsSave() {
  if (tmSaveTimer) return;
  tmSaveTimer = setTimeout(() => {
    tmSaveTimer = null;
    fs.mkdir(path.dirname(TICKET_MODELS_FILE), { recursive: true }, () => {
      fs.writeFile(TICKET_MODELS_FILE, JSON.stringify(ticketModels), (err) => {
        if (err) console.error(`ticket-models save failed: ${err.message}`);
      });
    });
  }, 5 * 1000);
  tmSaveTimer.unref();
}
function ticketModelPin(siteKey, issueKey) {
  const p = ticketModels[`${siteKey}/${issueKey}`];
  return p && typeof p.model === "string" && p.model ? p : null;
}
// Set or clear (model=null) a ticket's pinned model. The caller has already
// validated the alias against the org's offered models; this just owns the
// map's bookkeeping and eviction.
function setTicketModel(siteKey, issueKey, model) {
  const k = `${siteKey}/${issueKey}`;
  if (!model) delete ticketModels[k];
  else {
    ticketModels[k] = { model, at: Date.now() };
    const keys = Object.keys(ticketModels);
    if (keys.length > TICKET_MODELS_MAX) {
      keys.sort((a, b) => (ticketModels[a].at || 0) - (ticketModels[b].at || 0));
      for (const old of keys.slice(0, keys.length - TICKET_MODELS_MAX)) {
        delete ticketModels[old];
      }
    }
  }
  scheduleTicketModelsSave();
  invalidateAgentsCache();
  sseBroadcast("ticketModels", ticketModels);
}

// The set of model aliases a ticket may be pinned to for an org: the aliases the
// org's hosts actually probed available, unioned across every reporting host,
// dropped to the non-bracketed ones (a bracketed "[1m]" alias is a live-switch
// affordance the agent's resolve_model rejects for a spawn command line), plus
// the static family aliases every login can name. "default" is always legal (it
// releases the pin, so it never reaches this allowlist). Empty aliases beyond the
// static set only when no host has probed yet.
const STATIC_MODEL_ALIASES = ["opus", "sonnet", "haiku", "fable"];
function orgModelAliases(siteKey) {
  const set = new Set(STATIC_MODEL_ALIASES);
  for (const a of Object.values(agents)) {
    if (!a || !a.jira || a.jira.siteKey !== siteKey) continue;
    const avail = a.models && Array.isArray(a.models.available) ? a.models.available : [];
    for (const m of avail) {
      if (typeof m === "string" && m && m !== "default" &&
          /^[a-z0-9.-]{1,40}$/.test(m)) {
        set.add(m);
      }
    }
  }
  return set;
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

// ---- manual org colors (XERK-145) ------------------------------------------
// The operator's per-org palette pins, keyed by siteKey with the value the slot
// number (1..8). Loaded like the auto-start opt-in: only well-formed entries
// survive a read, so a hand-edited or corrupt file degrades to auto colors.
let orgColors = {};
try {
  const parsed = JSON.parse(fs.readFileSync(ORG_COLORS_FILE, "utf8"));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [k, v] of Object.entries(parsed)) {
      if (Number.isInteger(v) && v >= 1 && v <= ORG_COLOR_SLOTS) orgColors[k] = v;
    }
  }
} catch {
  /* first boot or no volume mounted */
}
let ocSaveTimer = null;
function scheduleOrgColorsSave() {
  if (ocSaveTimer) return;
  ocSaveTimer = setTimeout(() => {
    ocSaveTimer = null;
    fs.mkdir(path.dirname(ORG_COLORS_FILE), { recursive: true }, () => {
      fs.writeFile(ORG_COLORS_FILE, JSON.stringify(orgColors), (err) => {
        if (err) console.error(`org-colors save failed: ${err.message}`);
      });
    });
  }, 5 * 1000);
  ocSaveTimer.unref();
}
// Pin an org's palette slot, or release it back to auto (slot = null). The
// caller has validated the siteKey and the slot range; this owns the map.
function setOrgColor(siteKey, slot) {
  if (slot) orgColors[siteKey] = slot;
  else delete orgColors[siteKey];
  scheduleOrgColorsSave();
  invalidateAgentsCache();
  sseBroadcast("orgColors", orgColors);
}

// ---- session migration across hosts (XERK-101) -----------------------------
// Move a running session from one agent to another in the same org (e.g. to the
// host that has the container whose logs the conversation needs). The hub can't
// touch a worktree, and agents are outbound-only, so a migration is composed
// from agent commands + a hub-brokered relay of the one thing `claude --resume`
// needs and the archive doesn't keep — the RAW transcript bytes:
//   1. exportSession -> source host packs its transcript and POSTs it here;
//   2. the blob lands -> importSession queued on the target, which pulls it,
//      unpacks it, recreates the worktree off the repo's default branch, and
//      resumes the same conversation there;
//   3. target session comes up -> the source session is KILLED (kept, so its
//      worktree/uncommitted work stays resumable on the origin as a fallback).
// State is in-memory and short-lived (the blob rides in the record); a hub
// restart mid-migration aborts it, leaving the source session intact.
const migrations = new Map(); // migrationId -> record (see startMigration)
const MIGRATE_TIMEOUT_MS = Number(process.env.MIGRATE_TIMEOUT_MS) || 5 * 60 * 1000;
const MIGRATE_DONE_KEEP_MS = 30 * 1000; // keep a done/failed record briefly so UI can observe
const MIGRATIONS_MAX = 40; // backstop against unbounded growth
// Upload cap for the relay: a hair above the agent's own 64 MiB pack limit so a
// legitimate at-cap bundle isn't rejected for framing overhead.
const MIGRATE_BLOB_MAX = (1 << 26) + (1 << 20); // 65 MiB

// The wire shape (blob stripped) the /api/agents payload and SSE carry, so the
// UI can follow a migration to its new host and surface a failure.
function serializeMigration(m) {
  return {
    id: m.id, srcHost: m.srcHost, srcSessionId: m.srcSessionId,
    targetHost: m.targetHost, siteKey: m.siteKey, repo: m.repo,
    transcriptId: m.transcriptId, phase: m.phase, error: m.error || null,
    importCmdId: m.importCmdId || null, targetSessionId: m.targetSessionId || null,
    at: m.at,
  };
}
function migrationList() {
  return Array.from(migrations.values()).map(serializeMigration);
}
function publishMigrations() {
  invalidateAgentsCache();
  sseBroadcast("migrations", migrationList());
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
// A queued command as anyone outside the hub may see it. `deliveredAt` is the
// hub's own record of having handed the command over (XERK-241) — it lives on
// the command because that is exactly how long it is meaningful, but it is
// internal bookkeeping, so neither the agent's reply nor the fleet payload
// carries it. Returns the same array when there is nothing to strip.
function publicCommands(cmds) {
  if (!cmds || !cmds.some((c) => c && c.deliveredAt)) return cmds;
  return cmds.map((c) => {
    if (!c || !c.deliveredAt) return c;
    const { deliveredAt, ...rest } = c;
    return rest;
  });
}

function serializeAgent(key, agent, now) {
  // `resultWaits` is per-command bookkeeping with timestamps (XERK-151) — pure
  // internal state, stripped like the caches. `unsupported` is NOT: it's a tiny,
  // rarely-changing map of what this host's agent can't do, worth reading.
  const { history, subagentHistory, jiraIssues, statusResults,
          createMeta, createTypes, createResults, resultWaits, ...a } = agent;
  const online = now - (a.lastSeen || 0) < OFFLINE_AFTER_MS;
  return {
    key,
    ...a,
    commands: publicCommands(a.commands),
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
  const body = JSON.stringify({
    now, agents: list, ticketAgents, ticketModels, autoStartOrgs, orgColors,
    // In-flight (and just-settled) session migrations, so the Sessions page can
    // follow a moved session onto its new host and surface a failure (XERK-101).
    migrations: migrationList(),
    // Whether the hub can actually deliver mobile push (FCM configured). Surfaced
    // so a disabled/misconfigured push is VISIBLE on the dashboard instead of
    // silently swallowing every alert — the failure mode of XERK-152, whose only
    // prior signal was a boot log line. Hub-wide, not per-agent; constant for the
    // process's life (the service account is parsed once at startup).
    pushEnabled: push.fcmEnabled(),
  });
  const etag = '"' + crypto.createHash("sha1").update(body).digest("base64") + '"';
  agentsCache = { body, etag };
  lastGoodAgentsCache = agentsCache;
  return agentsCache;
}

// `buildAgentsCache` stringifies the whole fleet, so it can still throw past
// V8's string ceiling however well the per-record bound holds. Unguarded that
// reached the route's generic catch as a 400 — to EVERY dashboard, Android and
// glasses client, and permanently, because the records that caused it live for
// PRUNE_AFTER_MS. Serving the last good payload (or an empty fleet) keeps the
// UI alive and puts the reason in the log (XERK-235).
let lastGoodAgentsCache = null;
function safeAgentsCache() {
  try {
    return buildAgentsCache();
  } catch (e) {
    console.error(`agents payload could not be serialized: ${e.message}`);
    // The route calls this as `agentsCache || safeAgentsCache()`, so the live
    // cache is null by the time we get here — the last good payload has to be
    // remembered separately or this branch is dead and every host vanishes from
    // the dashboard, which is a more alarming failure than the one it replaces.
    if (lastGoodAgentsCache) return lastGoodAgentsCache;
    const body = JSON.stringify({ now: Date.now(), agents: [], error: "payload too large" });
    return { body, etag: '"' + crypto.createHash("sha1").update(body).digest("base64") + '"' };
  }
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

// Has this command been handed to the agent? The queue drains on ACK, not on
// delivery, so being queued does NOT mean it never ran — an agent that took a
// command, ran it and died before acking leaves it sitting there too. Only the
// `deliveredAt` stamp separates "provably did nothing" from "unknowable", and
// the two must be reported differently (XERK-241).
function commandDelivered(key, cmdId, kind) {
  const a = agents[key];
  return !!((a && a.commands) || []).find(
    (c) => c && c.cmdId === cmdId && c.type === kind && c.deliveredAt);
}

// Withdraw a queued command the hub has given up on. This is unconditional, and
// deliberately so: delivery is at-least-once, and the agent's de-dup of an
// already-executed cmdId is IN-MEMORY (hub-agent.py's `self.acked`, rebuilt
// empty at boot), so a command left in a dead host's queue is re-delivered and
// re-RUN when that host returns. Leaving a delivered create there to "maybe
// finish" is therefore not the cautious choice — it is a second ticket, landing
// after the operator has already remade the one they were told had failed.
//
// Withdrawing costs at most a create that was genuinely lost, which the
// operator is being told to retry anyway. Making this safe to skip needs a
// DURABLE acked-set on the agent side; until then the hub must not re-arm work
// it has just written off.
function dropQueuedCommand(key, cmdId, kind) {
  const a = agents[key];
  if (!a || !a.commands) return false;
  const before = a.commands.length;
  // `kind` is not belt-and-braces: this runs from a GET that is handed a bare
  // cmdId, so without it a create poll would delete whatever command that id
  // happened to name — a repo pin queued for an offline host, say.
  a.commands = a.commands.filter((c) => !c || c.cmdId !== cmdId || c.type !== kind);
  if (a.commands.length === before) return false;
  delete (a.resultWaits || {})[cmdId];
  scheduleSave();
  publishAgent(key);
  return true;
}

// An agent's org, or "" if it reports none — the one predicate that partitions
// the fleet (see org.js siteKeyOf). A migration may only cross hosts that share
// this, so two hosts of one Jira org can trade sessions but no session ever
// leaves its org (or leaks between an org host and an org-less one).
function siteKeyOf(a) {
  return (a && a.jira && a.jira.siteKey) || "";
}

// Begin a migration: queue exportSession on the source and record the pending
// move. The caller validated the source session + target host; this owns the
// bookkeeping. Returns the migration record.
function startMigration(srcHost, s, targetHost) {
  // Bound the map: drop the oldest settled record if we're at the cap (an
  // in-flight one is never evicted — that would strand a live handoff).
  if (migrations.size >= MIGRATIONS_MAX) {
    let oldest = null;
    for (const m of migrations.values()) {
      if (m.phase === "done" || m.phase === "failed") {
        if (!oldest || m.at < oldest.at) oldest = m;
      }
    }
    if (oldest) migrations.delete(oldest.id);
  }
  const id = crypto.randomBytes(8).toString("hex");
  const m = {
    id, srcHost, srcSessionId: s.id, targetHost,
    siteKey: siteKeyOf(agents[srcHost]), repo: s.repo,
    // The agent reports a session's pinned conversation id as `transcriptId`
    // (it never sends a `claudeSessionId` field) — that is the id
    // `claude --resume` needs on the target.
    transcriptId: s.transcriptId,
    // Metadata the moved session should keep — the hub has it all from the
    // heartbeat, so the source only ships the raw transcript.
    meta: {
      model: s.model || null,
      permissionMode: s.permissionMode || null,
      // Which model the moved session was running against (XERK-246). The
      // target re-validates it against its OWN local-model configuration, so a
      // move onto a host without one falls back rather than launching at an
      // endpoint that isn't there.
      modelSource: s.modelSource || null,
      summary: s.summary || null,
      summaryManual: s.summaryManual || null,
      label: s.label || null,
      ticket: s.ticket || null,
    },
    phase: "exporting", // exporting -> importing -> done | failed
    blob: null, importCmdId: null, targetSessionId: null,
    // The reason an agent gave for declining its half (XERK-265), staged here by
    // ingestSpawnFailures and turned into a terminal failure by advanceMigrations
    // rather than applied on the spot — the handoff check must still win the tie.
    refusal: null,
    error: null, startedAt: Date.now(), at: Date.now(),
  };
  migrations.set(id, m);
  queueCommand(srcHost, { type: "exportSession", sessionId: s.id, migrationId: id });
  publishMigrations();
  return m;
}

// Drive every in-flight migration one step (called from the target's heartbeat
// for a fast handoff, and from the sweep interval for timeouts/cleanup). Pure
// bookkeeping over `migrations` + the fleet — safe to call often.
function advanceMigrations() {
  const now = Date.now();
  for (const m of migrations.values()) {
    // The target session reported itself up (its spawnCmdId is the importCmdId
    // the hub minted): hand off — kill the source (kept, resumable) and finish.
    if (m.phase === "importing" && m.importCmdId) {
      const a = agents[m.targetHost];
      const up = a && (a.sessions || []).find(
        (s) => s.spawnCmdId === m.importCmdId && s.status === "running");
      if (up) {
        m.targetSessionId = up.id;
        m.phase = "done";
        m.error = null;
        m.blob = null;
        m.at = now;
        if (agents[m.srcHost]) {
          queueCommand(m.srcHost, { type: "kill", sessionId: m.srcSessionId });
        }
        publishMigrations();
        continue;
      }
    }
    // The agent REFUSED its half of the move and said so on a beat (XERK-265):
    // fail now, carrying its reason, instead of leaving the operator watching a
    // move that can no longer complete for the whole MIGRATE_TIMEOUT_MS. Read
    // after the handoff above so a success always wins the tie, and covers both
    // halves — an export that never shipped a blob as well as a refused import.
    if ((m.phase === "exporting" || m.phase === "importing") && m.refusal) {
      m.phase = "failed";
      m.error = m.refusal;
      m.blob = null;
      m.at = now;
      publishMigrations();
      continue;
    }
    // A move that never completed: fail it so the UI stops waiting. The source
    // session was never killed, so nothing is lost — the operator retries.
    if ((m.phase === "exporting" || m.phase === "importing") &&
        now - m.startedAt > MIGRATE_TIMEOUT_MS) {
      m.phase = "failed";
      m.error = "migration timed out";
      m.blob = null;
      m.at = now;
      publishMigrations();
      continue;
    }
    // Retire a settled record after a short grace so open UIs can observe the
    // terminal state before it disappears.
    if ((m.phase === "done" || m.phase === "failed") &&
        now - m.at > MIGRATE_DONE_KEEP_MS) {
      migrations.delete(m.id);
      publishMigrations();
    }
  }
}

// Normalize an agent's per-model usage lists to the current wire shape.
//
// A usage block's `models` is [{model, totals, today, week}], but agents built
// before the token-only usage rewrite report it as a bare list of model-name
// STRINGS. Every client walks that list — and one host on an old build must not
// be able to break the others: the dashboard's shortModels() read `m.model` off
// a string, threw mid-render, and left the fleet list EMPTY, so "All orgs"
// showed nothing while any single org still rendered. Android is stricter
// still: kotlinx refuses a string where ModelUsage is declared, failing the
// whole /api/agents decode.
//
// So the coercion happens once, at the hub's ingest boundary, rather than in
// each of the three clients (none of which then needs a release to survive an
// old host). A name-less entry is DROPPED — it can't be rendered or merged by
// name, and carries no windows worth keeping.
function normalizeModelUsage(usage) {
  if (!usage || !Array.isArray(usage.models)) return;
  usage.models = usage.models
    .map((m) => (typeof m === "string" ? { model: m } : m))
    .filter((m) => m && typeof m.model === "string" && m.model);
}

// Every place a usage block rides the heartbeat: the host-wide aggregate, the
// per-repo ones, and each live session's own.
function normalizeUsage(payload) {
  if (!payload || typeof payload !== "object") return;
  normalizeModelUsage(payload.usage);
  for (const r of payload.repoUsage || []) normalizeModelUsage(r && r.usage);
  for (const s of payload.sessions || []) normalizeModelUsage(s && s.usage);
}

// The subscription-limit snapshot (XERK-247), coerced to numbers or dropped, for
// the same reason the model lists above are: this block is agent-authored and
// fans out to web, Android and glasses, and the Android client decodes it into
// TYPED fields — a `usedPct` of "lots" from one buggy host would fail the decode
// of the WHOLE fleet payload, not just its own card. The agent validates before
// reporting; this is the boundary that makes one that didn't survivable.
function normalizeLimits(payload) {
  if (!payload || typeof payload !== "object") return;
  const lim = payload.limits;
  if (!lim || typeof lim !== "object" || Array.isArray(lim)) {
    if ("limits" in payload) payload.limits = null;
    return;
  }
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const out = {};
  for (const key of ["fiveHour", "sevenDay"]) {
    const win = lim[key];
    if (!win || typeof win !== "object") continue;
    const pct = num(win.usedPct);
    if (pct === undefined) continue;   // a window with no percentage draws nothing
    const clean = { usedPct: Math.min(100, Math.max(0, pct)) };
    const resets = num(win.resetsAt);
    if (resets !== undefined) clean.resetsAt = resets;
    out[key] = clean;
  }
  const captured = num(lim.capturedAt);
  if (!Object.keys(out).length || captured === undefined) {
    payload.limits = null;
    return;
  }
  out.capturedAt = captured;
  if (typeof lim.source === "string") out.source = lim.source.slice(0, 32);
  payload.limits = out;
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

// Merge the agent's board-status-change outcomes (heartbeat `ticketStatusResults`,
// XERK-138) into a per-cmdId cache, so the panel that fired a change can poll
// GET .../status?cmdId for its own answer. Keyed by cmdId (not issueKey) so two
// changes to one ticket don't clobber each other's result, and bounded oldest-
// first exactly like the issue cache.
function ingestStatusResults(agent, ticketStatusResults) {
  const now = Date.now();
  for (const r of ticketStatusResults || []) {
    if (!r || !r.cmdId) continue;
    agent.statusResults[r.cmdId] = {
      key: r.key || null, ok: !!r.ok, error: r.error || null,
      status: r.status || null, statusCategory: r.statusCategory || null,
      at: now,
    };
  }
  for (const [id, e] of Object.entries(agent.statusResults)) {
    if (now - e.at > JIRA_ISSUE_MAX_AGE_MS) delete agent.statusResults[id];
  }
  const over = Object.keys(agent.statusResults).length - JIRA_ISSUE_MAX;
  if (over > 0) {
    Object.entries(agent.statusResults)
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, over)
      .forEach(([id]) => delete agent.statusResults[id]);
  }
}

// How long a staged session-start refusal (XERK-265) stays readable, and how
// many one host may hold. It exists to answer a wait that is already running —
// the Sessions page's SPAWN_FOLLOW_MS, or a migration — so minutes is generous.
const SPAWN_FAILURE_MAX_AGE_MS = 10 * 60 * 1000;
const SPAWN_FAILURE_MAX = 40;

// Merge the agent's refusals of a session-creating command (heartbeat
// `spawnFailures`, XERK-265) into a per-cmdId cache, and stamp any it names onto
// the migration waiting on it.
//
// Every one of these used to be a line in the agent's container log: the command
// is ACKed whether the agent ran it or refused it, so the hub could not tell a
// refused resume from a slow one. It kept the Sessions page spinning out its
// follow window with no reason, and left a migration in `importing` until
// MIGRATE_TIMEOUT_MS — which XERK-256's prune/resume race made an ordinary event
// rather than an operator error.
//
// Unlike `statusResults` this cache is NOT stripped from the fleet payload: the
// point is that the client following the spawn can see it. It is small, capped
// and short-lived, so it costs the record almost nothing. It is named apart from
// the wire field it comes from (`spawnRefusals`, keyed by cmdId, vs the beat's
// `spawnFailures` list) so the two shapes can't be mistaken for each other.
function ingestSpawnFailures(hostKey, agent, results) {
  const now = Date.now();
  for (const r of results || []) {
    if (!r) continue;
    const error = typeof r.error === "string" && r.error ? r.error : "the agent refused it";
    if (r.cmdId) agent.spawnRefusals[r.cmdId] = { error, at: now };
    // A migration's own handle. The refusal can arrive for either half, so match
    // the record by id — the export half has no importCmdId to key on. Only a
    // host actually IN the move may fail it: every agent shares one token, so
    // without this any host could kill any other host's migration.
    if (r.migrationId) {
      const m = migrations.get(r.migrationId);
      if (m && (m.phase === "exporting" || m.phase === "importing") &&
          (m.srcHost === hostKey || m.targetHost === hostKey)) m.refusal = error;
    }
  }
  for (const [id, e] of Object.entries(agent.spawnRefusals)) {
    if (now - e.at > SPAWN_FAILURE_MAX_AGE_MS) delete agent.spawnRefusals[id];
  }
  const over = Object.keys(agent.spawnRefusals).length - SPAWN_FAILURE_MAX;
  if (over > 0) {
    Object.entries(agent.spawnRefusals)
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, over)
      .forEach(([id]) => delete agent.spawnRefusals[id]);
  }
}

// Merge the agent's New-ticket create metadata (heartbeat `createMetaResults`,
// XERK-137) into the host caches. Two shapes ride the one deque, told apart by
// a `project` key: a project-keyed result carries that project's issue TYPES; a
// project-less result carries the org's project + label list. A result carrying
// an `error` is cached too (a doomed fetch mustn't re-queue every poll).
function ingestCreateMeta(agent, results) {
  const now = Date.now();
  for (const r of results || []) {
    if (!r) continue;
    if (r.project) {
      agent.createTypes[r.project] = {
        types: r.types || [], error: r.error || null, fetchedAt: now,
      };
    } else {
      agent.createMeta = {
        projects: r.projects || [], labels: r.labels || [],
        source: r.source || null, error: r.error || null, fetchedAt: now,
      };
    }
  }
  for (const [k, e] of Object.entries(agent.createTypes)) {
    if (now - e.fetchedAt > CREATE_META_MAX_AGE_MS) delete agent.createTypes[k];
  }
  const over = Object.keys(agent.createTypes).length - CREATE_TYPES_MAX;
  if (over > 0) {
    Object.entries(agent.createTypes)
      .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
      .slice(0, over)
      .forEach(([k]) => delete agent.createTypes[k]);
  }
}

// Merge the agent's create OUTCOMES (heartbeat `createTicketResults`) into the
// host cache, keyed by the create command's cmdId — the correlation handle the
// submitting client polls with (GET /api/jira/<siteKey>/tickets/<cmdId>).
function ingestCreateResults(agent, results) {
  const now = Date.now();
  for (const r of results || []) {
    if (!r || !r.cmdId) continue;
    agent.createResults[r.cmdId] = {
      key: r.key || null, url: r.url || null, error: r.error || null,
      // A create that succeeded but couldn't be assigned: a success the client
      // still has to say something about, since the board won't show it.
      warning: r.warning || null, fetchedAt: now,
    };
  }
  for (const [k, e] of Object.entries(agent.createResults)) {
    if (now - e.fetchedAt > CREATE_RESULT_MAX_AGE_MS) delete agent.createResults[k];
  }
  const over = Object.keys(agent.createResults).length - CREATE_RESULT_MAX;
  if (over > 0) {
    Object.entries(agent.createResults)
      .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
      .slice(0, over)
      .forEach(([k]) => delete agent.createResults[k]);
  }
}

// --- Proven capability gaps (XERK-151) ---------------------------------------
// Record that `cmdId` is a command whose whole answer is a staged result, so the
// beat that acks it can decide whether the agent actually implements it. `extra`
// carries whatever resultLanded needs to find that result (the project, for a
// per-project boardCreateMeta).
function awaitResult(agent, cmdId, kind, extra) {
  agent.resultWaits = agent.resultWaits || {};
  agent.resultWaits[cmdId] = { kind, at: Date.now(), ...(extra || {}) };
}

// Did the beat that acked this command also carry its staged result? The create
// meta/type caches aren't cmdId-keyed (the agent stages them by shape), so they
// are matched on being REFRESHED since the command was queued; the two per-cmdId
// caches are matched by id. An unknown kind reads as landed — a capability gap
// is only ever asserted from positive evidence.
function resultLanded(agent, cmdId, wait) {
  if (wait.kind === "boardCreateMeta") {
    const e = wait.project
      ? (agent.createTypes || {})[wait.project]
      : agent.createMeta;
    return !!e && e.fetchedAt >= wait.at;
  }
  if (wait.kind === "createTicket") return !!(agent.createResults || {})[cmdId];
  if (wait.kind === "setTicketStatus") return !!(agent.statusResults || {})[cmdId];
  return true;
}

// Settle every awaited command this beat acked (i.e. that has just left the
// queue). Runs AFTER the ingests, so `next` already holds anything the beat
// carried. A landed result also CLEARS the gap — an agent must be able to earn
// a feature back the moment it demonstrably has it.
//
// A version change wipes every gap up front: an update is the one event that
// makes what this host can do genuinely unknown again, and re-proving a gap
// costs a single command.
function resolveResultWaits(prev, next, commands) {
  if ((prev.agentVersion || null) !== (next.agentVersion || null)) next.unsupported = {};
  const waits = next.resultWaits;
  if (!waits) return;
  const queued = new Set((commands || []).map((c) => c.cmdId));
  const now = Date.now();
  for (const [cmdId, w] of Object.entries(waits)) {
    if (queued.has(cmdId)) {
      // Still undelivered (an offline host's queue, or a beat that crossed it).
      // Nothing is concluded from a command the agent hasn't taken yet.
      if (now - w.at > RESULT_WAIT_MAX_MS) delete waits[cmdId];
      continue;
    }
    delete waits[cmdId];
    if (resultLanded(next, cmdId, w)) delete next.unsupported[w.kind];
    else next.unsupported[w.kind] = now;
  }
}

// The operator-facing reason a host can't serve a request, or "" when it can.
// `what` completes "…is too old to <what>". A gap past its TTL reads as absent,
// so the next request re-probes rather than refusing on old evidence forever.
function agentGapError(agent, kind, what) {
  const at = ((agent || {}).unsupported || {})[kind];
  if (!at || Date.now() - at > UNSUPPORTED_TTL_MS) return "";
  const v = agent.agentVersion ? ` (v${agent.agentVersion})` : "";
  // Semicolon, not a dash: every caller renders this inside its own
  // "Couldn't load projects — <error>" sentence.
  return `this host's Turma agent${v} is too old to ${what}; update the agent`;
}

// An issue key is interpolated into an agent REST path, so it's allowlist-checked
// before it reaches a URL — the same "nothing free-form" stance the agent takes.
// Two grammars, because the board carries two ticket sources: Jira's PROJECT-123
// keys and Azure DevOps' bare-integer work-item ids.
function isIssueKey(k) {
  return /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/.test(k) || /^[0-9]+$/.test(k);
}

// Every host whose `jira` block reports this org, best first (XERK-241). An org
// is routinely polled by SEVERAL hosts, and until this ranking existed the pick
// was whichever one happened to sit first in the agents map — so one sick host
// could absorb every board read and write for its org for as long as it stayed
// in that slot.
//
// Two health signals, in order, because they fail differently:
//   - ONLINE (heartbeating): a command queued onto a silent host sits undelivered
//     until it returns, so an offline host can only ever serve its own cache.
//   - `jira.available`: the host's LAST TRACKER POLL SUCCEEDED. A host can
//     heartbeat perfectly while its creds/network to Jira are broken — online
//     but unable to answer a single board request. `available` is only trusted
//     when the host says so explicitly; an agent that omits it ranks with the
//     healthy (never assume a gap is a failure).
// Ties keep insertion order, so the pick is stable and deterministic.
// The ONE health predicate — both the ranking and the write rotation read it,
// so the rule can't drift between them. `available` is trusted only when the
// host says false; an agent that omits it ranks with the healthy, because a
// missing field means "older agent", never "broken tracker".
const jiraHostHealthy = (a) => a.jira.available !== false;
function jiraHostPool(siteKey, requireOnline) {
  const now = Date.now();
  const pool = [];
  for (const [key, a] of Object.entries(agents)) {
    if (!a.jira || a.jira.siteKey !== siteKey) continue;
    const online = now - (a.lastSeen || 0) < OFFLINE_AFTER_MS;
    if (requireOnline && !online) continue;
    pool.push({ key, online, healthy: jiraHostHealthy(a) });
  }
  // Stable sort (Array#sort is stable in Node), so equal-scoring hosts stay in
  // insertion order and the pick doesn't wander between requests.
  pool.sort((x, y) => (y.online - x.online) || (y.healthy - x.healthy));
  return pool.map((p) => p.key);
}

// Which single HOST should answer for a Jira org — the head of that pool.
// null when no host covers the org (or the only ones that do are offline, and
// `requireOnline`). A read that can fall back to an offline host's cache passes
// requireOnline=false and gets the online one anyway, because the pool already
// ranks them first — no need to ask twice. Deliberately STICKY rather than
// rotating: the read paths
// cache per host (createMeta, createTypes, jiraIssues), so spreading reads would
// just multiply cache misses. Writes use pickBoardWriteHost below.
function findJiraHost(siteKey, requireOnline) {
  return jiraHostPool(siteKey, requireOnline)[0] || null;
}

// Which HOST should run a board WRITE (create a ticket, change a status) for an
// org with several agents (XERK-241). Same health ranking as above, but the
// equally-healthy leaders are taken ROUND-ROBIN instead of always the first.
//
// The point isn't throughput — a create is one REST call. It's that a retry
// lands somewhere ELSE: when a host is failing in a way its heartbeat doesn't
// show, hammering the same one repeats the same failure, while rotating gets the
// operator a working host on the next attempt. Rotation is confined to hosts of
// the TOP health tier, so a sick host is never re-elected just because its turn
// came round — and `kind` further excludes any host that has already PROVEN it
// can't run this command (XERK-151). Without that, an org with one too-old agent
// refuses every other click, which reads as flakiness rather than as the one bad
// host it is. When EVERY host is gapped nothing is excluded, so the caller still
// reaches the honest refusal.
//
// The turn counter is keyed by siteKey and only written for an org with a live
// reporting host, so an unknown key from a URL can never grow it.
const boardWriteTurn = new Map(); // siteKey -> next index into its healthy leaders
function pickBoardWriteHost(siteKey, kind) {
  const pool = jiraHostPool(siteKey, true);
  if (!pool.length) return null;
  const top = jiraHostHealthy(agents[pool[0]]);
  let leaders = pool.filter((k) => jiraHostHealthy(agents[k]) === top);
  const able = kind ? leaders.filter((k) => !agentGapError(agents[k], kind, "")) : leaders;
  if (able.length) leaders = able;
  const n = (boardWriteTurn.get(siteKey) || 0) % leaders.length;
  boardWriteTurn.set(siteKey, (n + 1) % leaders.length);
  return leaders[n];
}

// Which HOST a queued board command was routed to (XERK-241). A create/status
// poll carries only its cmdId, and reading the outcome off the WRONG host of a
// multi-agent org is what made a healthy create report a failure: the poll took
// the org's first host for its offline check, so an offline sibling 503'd every
// create the online host was busy running — and each retry made another ticket.
//
// Kept hub-side because ownership must outlive every per-agent trace of the
// command: the queue entry goes on the ack, the resultWait with it, and the
// result cache ages out. Bounded and TTL'd; a hub restart mid-create simply
// falls back to the fleet scan, which is what the poll did before.
const cmdHosts = new Map(); // cmdId -> {host, at}
const CMD_HOST_TTL_MS = 30 * 60 * 1000;
const CMD_HOST_MAX = 200;
function rememberCmdHost(cmdId, host, kind) {
  const now = Date.now();
  for (const [id, e] of cmdHosts) {
    if (now - e.at > CMD_HOST_TTL_MS) cmdHosts.delete(id);
  }
  cmdHosts.set(cmdId, { host, kind, at: now });
  while (cmdHosts.size > CMD_HOST_MAX) cmdHosts.delete(cmdHosts.keys().next().value);
}
// The recorded owner if it still reports the org, else any host of the org that
// already holds the command or its outcome — an equivalent answer that also
// covers a hub restart. null when nothing claims it.
//
// Matched on cmdId AND `kind`, because a cmdId names a command of a PARTICULAR
// type and these routes act on what they find: a create poll handed a repo-pin
// or create-meta id must not adopt it, report a create verdict about it, or
// withdraw it. The org check is the same rule one level up — an owner that has
// since moved to another org no longer answers for this one.
function commandHost(siteKey, cmdId, kind, resultKey) {
  const owner = cmdHosts.get(cmdId);
  const claims = (a) =>
    (a.commands || []).some((c) => c && c.cmdId === cmdId && c.type === kind) ||
    ((a.resultWaits || {})[cmdId] || {}).kind === kind ||
    !!(a[resultKey] || {})[cmdId];
  if (owner && owner.kind === kind && agents[owner.host] && agents[owner.host].jira &&
      agents[owner.host].jira.siteKey === siteKey) return owner.host;
  for (const [key, a] of Object.entries(agents)) {
    if (!a.jira || a.jira.siteKey !== siteKey) continue;
    if (claims(a)) return key;
  }
  return null;
}

// The create still awaiting an outcome for this exact (org, project, type,
// title), if there is one (XERK-241). What actually cost the operator four
// tickets was a retry loop: the create kept succeeding and kept LOOKING like it
// had failed, so each attempt made a real ticket. A retry that arrives while the
// first is unresolved rejoins it instead of opening a second write.
//
// Held hub-side rather than read off the agent's queue, because the queue entry
// disappears the moment the agent ACKS — precisely the window a retry lands in.
// What actually releases an entry is EVIDENCE, checked below: an outcome
// landed, the host went quiet, or it proved it can't run the command. The TTL
// is only the backstop for a create that vanished leaving none of those, so it
// is deliberately set WELL PAST the client's own 60s give-up (newticket.js).
//
// Matching the client's deadline instead would be the worst of both: the TTL
// starts when the create is queued and the client's when the response lands, so
// the entry would expire microseconds BEFORE the operator is told it timed out
// — guaranteeing their next click opens a second write. That is the duplicate
// this whole mechanism exists to prevent, so the backstop is the same 5 minutes
// after which the hub stops expecting an answer at all (RESULT_WAIT_MAX_MS).
const createInFlight = new Map(); // fingerprint -> {cmdId, host, at}
// Env-tunable for the same reason CONTROL_PING_EVERY_MS is: a multi-minute
// expiry can only be tested by winding it down to milliseconds.
const CREATE_INFLIGHT_TTL_DEFAULT_MS = RESULT_WAIT_MAX_MS;
const CREATE_INFLIGHT_TTL_MS =
  Number(process.env.CREATE_INFLIGHT_TTL_MS) || CREATE_INFLIGHT_TTL_DEFAULT_MS;
// Hashed, and over the WHOLE body rather than the title alone: two tickets that
// share a title but differ in description or labels are DIFFERENT tickets, and
// folding them would not just suppress a retry — it would discard the second
// one's text and report it created under the first one's key. Hashing also keeps
// an unbounded operator-supplied summary out of the map's keys.
const createFp = (siteKey, project, issueType, summary, description, labels) =>
  crypto.createHash("sha256")
    .update(JSON.stringify([siteKey, project, issueType, summary, description, labels]))
    .digest("hex");
function findCreateInFlight(siteKey, project, issueType, summary, description, labels) {
  const now = Date.now();
  for (const [fp, e] of createInFlight) {
    if (now - e.at > CREATE_INFLIGHT_TTL_MS) createInFlight.delete(fp);
  }
  const e = createInFlight.get(
    createFp(siteKey, project, issueType, summary, description, labels));
  if (!e) return null;
  const a = agents[e.host];
  // Resolved (or its host is gone): it's a finished piece of work, so an
  // identical create from here is a deliberate second ticket.
  if (!a || (a.createResults || {})[e.cmdId]) return null;
  // An agent that has proven it can't run createTicket will never answer, so
  // rejoining it would hand the retry a dead cmdId; let it through to refuse on
  // its own merits (XERK-151).
  if (agentGapError(a, "createTicket", "create tickets")) return null;
  // Nor is a create still in flight once its host has gone quiet holding it:
  // rejoining would hand the retry a cmdId nothing can answer, and the poll has
  // by now withdrawn the command anyway. (Reachable because a host picked while
  // it was merely stale can cross the offline line inside the backstop window.)
  if (Date.now() - (a.lastSeen || 0) >= OFFLINE_AFTER_MS) return null;
  return e;
}
// Stop treating a create as in flight. Called where the hub REPORTS a create as
// failed: from that moment the operator is expected to try again, so the retry
// must open a new write rather than rejoin the one just written off.
function forgetCreateInFlight(cmdId) {
  for (const [fp, e] of createInFlight) {
    if (e.cmdId === cmdId) createInFlight.delete(fp);
  }
}
function rememberCreateInFlight(fields, cmdId, host) {
  createInFlight.set(createFp(...fields), { cmdId, host, at: Date.now() });
  while (createInFlight.size > CMD_HOST_MAX) {
    createInFlight.delete(createInFlight.keys().next().value);
  }
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

// Default cap for a JSON body. Generous, because the expensive one is the
// heartbeat (below) and everything else is small.
const BODY_MAX = 1 << 20; // 1 MiB

// A heartbeat is not a user request: it carries the agent's on-demand
// `historyResults`, which at the documented FULL block caps (HISTORY_MAX_MSGS
// entries × BLOCK_TEXT_CHARS_FULL, plus base64 SendUserFile images) reaches
// ~5 MiB on an ordinary "open the chat history" click. At 1 MiB the hub
// destroyed the socket, the agent saw ECONNRESET rather than a status code,
// and — because it holds staged results until a POST succeeds — re-sent the
// same oversized body every beat, so the host stayed offline forever with
// nothing logged (XERK-235).
const HEARTBEAT_MAX = 32 << 20; // 32 MiB

// Longest prompt/label/baseRef a queued spawn may carry. A queued command is
// re-serialized into every /api/agents response, every SSE broadcast and
// state.json, and an offline host never acks — so an unbounded field is a
// fleet-wide cost that grows without limit (XERK-235). Comfortably above any
// real task prompt; /api/trigger applies its own 10k cap on prompt alone.
const SPAWN_FIELD_MAX = 100000;

// Top-level keys a heartbeat is known to carry — the agent's own payload plus
// the on-demand `*Results` deliveries, which the handler extracts and deletes
// from the payload itself before the spread. Anything else is bounded by
// HEARTBEAT_UNKNOWN_MAX (see sanitizeHeartbeat).
const HEARTBEAT_KNOWN_KEYS = new Set([
  "agentId", "agentVersion", "archiveManifest", "capacity", "claudeAuth",
  "claudeVersion", "clones", "closedSessions", "codingAgent", "device",
  "gitSources", "github", "inputMaxChars", "jira", "limits", "localModel",
  "logTail", "memory", "models", "prunes", "repoUsage", "repos", "reposRoot",
  "sessions", "startedAt", "uploadMaxBytes", "usage",
  "historyResults", "subagentHistoryResults", "jiraIssueResults",
  "ticketStatusResults", "createMetaResults", "createTicketResults",
  "spawnFailures",
]);

// How much an UNRECOGNISED heartbeat key may contribute to the persisted
// record. Deliberately a size bound rather than a drop: agents are routinely
// newer than the hub, so a field this hub has not learned about yet must still
// pass through to the clients that have (the `github` block is exactly that
// contract). Bounding instead of allowlisting keeps that forward compatibility
// while closing the amplification.
const HEARTBEAT_UNKNOWN_MAX = 64 << 10; // 64 KiB

// The ceiling on ONE host's record as it appears in the fleet payload. The
// per-key bound above is necessary but not sufficient: it left KNOWN keys
// unbounded (30 MiB under `sessions` amplified just as well) and it had no
// aggregate, so 400 unknown keys each just under the per-key limit added 25 MiB
// through the very path meant to stop it. Enough of those and `buildAgentsCache`
// throws past V8's ~512 MiB string ceiling, which answered 400 to every
// dashboard, Android and glasses client — permanently, since records live 7
// days. Bounding the whole record closes known keys, unknown keys and the
// aggregate in one place (XERK-235).
//
// Measured EXCLUDING the on-demand caches, which `serializeAgent` strips from
// the payload and which are separately bounded by count: a legitimate ~5 MiB
// `/history` delivery lands there and must not cost the host its heartbeat.
const AGENT_RECORD_MAX = 8 << 20; // 8 MiB

// Which hosts are already over half the ceiling, so the warning above fires on
// the crossing rather than on every beat.
const recordSizeWarned = new Map();

// The cache keys `serializeAgent` strips; see AGENT_RECORD_MAX.
const AGENT_CACHE_KEYS = [
  "history", "subagentHistory", "jiraIssues", "statusResults",
  "createMeta", "createTypes", "createResults", "resultWaits",
];

// The serialized size of what this record contributes to /api/agents.
function agentRecordSize(record) {
  try {
    return JSON.stringify(record, (k, v) =>
      AGENT_CACHE_KEYS.includes(k) && v && typeof v === "object" ? undefined : v
    ).length;
  } catch {
    return Infinity; // circular or unserializable — it cannot be persisted anyway
  }
}

// Drop unrecognised keys that are too large to be a plausible new field.
//
// `agents[key] = {...payload}` persisted the WHOLE payload with no bound, so a
// single beat under the (32 MiB) transport cap could park 30 MiB on the record
// — re-serialized into state.json, every /api/agents response and every SSE
// frame from then on. Enough distinct hosts doing that pushed the aggregate
// past V8's ~512 MiB string ceiling, which threw inside the save timer and
// exited the whole hub. All agents share one token, so one buggy or
// compromised agent could take down the fleet's control plane (XERK-235).
function sanitizeHeartbeat(payload, key) {
  if (!payload || typeof payload !== "object") return payload;
  for (const k of Object.keys(payload)) {
    if (HEARTBEAT_KNOWN_KEYS.has(k)) continue;
    let size = 0;
    try {
      size = JSON.stringify(payload[k] ?? null).length;
    } catch {
      size = Infinity; // circular or unserializable — cannot persist it anyway
    }
    if (size > HEARTBEAT_UNKNOWN_MAX) {
      console.error(
        `heartbeat from ${key}: dropped unknown field ${JSON.stringify(k)} ` +
          `(${size} bytes, limit ${HEARTBEAT_UNKNOWN_MAX})`
      );
      delete payload[k];
    }
  }
  // `sessions` is a KNOWN key, so the sweep above never looks inside it. Each
  // session's live agent rows come from a pane scrape and are re-shaped and
  // bounded here for the same reason the `turn` frame's are — the clients turn
  // this list into a count and a label, and nothing else bounds it.
  if (Array.isArray(payload.sessions)) {
    for (const s of payload.sessions) {
      const live = s && typeof s === "object" ? s.session : null;
      if (live && typeof live === "object" && "agents" in live) {
        live.agents = sanitizeLiveAgents(live.agents) || [];
      }
    }
  }
  return payload;
}

// Thrown past the cap so a route can answer 413 instead of leaking a generic
// 400 (or, worse, nothing at all).
class BodyTooLarge extends Error {
  constructor(cap) {
    super("body too large");
    this.tooLarge = true;
    this.cap = cap;
  }
}

// Collect a request body as a string. Past `cap` it keeps DRAINING for a while
// rather than destroying the socket: draining is what lets the route write a
// 413 on the same connection, where a mid-body destroy reaches the client as a
// socket hang-up with no status to branch on. Same rule readRawBody follows.
function readBody(req, cap = BODY_MAX) {
  return new Promise((resolve, reject) => {
    let data = "";
    let len = 0;
    let over = false;
    req.on("data", (c) => {
      len += c.length;
      if (over) {
        if (len > cap + RAW_BODY_DRAIN_SLACK) req.destroy();
        return;
      }
      if (len > cap) {
        over = true;
        data = ""; // release it — it is not going to be used
        reject(new BodyTooLarge(cap));
        return;
      }
      data += c;
    });
    req.on("end", () => { if (!over) resolve(data); });
    req.on("error", reject);
  });
}

// How much past `cap` readRawBody keeps draining before it gives up on saying
// anything and cuts the socket. Draining is what lets the route answer 413 on
// the same connection — destroying it mid-body reaches the client as a socket
// hang up, and "the network broke" is the wrong thing to tell someone whose
// file was simply too big (XERK-234).
const RAW_BODY_DRAIN_SLACK = 1 << 20; // 1 MiB

// Collect a request body as raw bytes (for the binary migration relay and the
// attachment uploads, which readBody's 1 MiB string cap would truncate). Rejects
// past `cap` so a huge or runaway upload can't exhaust the hub's memory: the
// bytes already held are dropped on the spot, and what follows is discarded
// rather than buffered.
function readRawBody(req, cap) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let len = 0;
    let over = false;
    req.on("data", (c) => {
      len += c.length;
      if (over) {
        // Still coming after we've said no: read and throw it away up to a
        // point, then stop paying for a client that won't.
        if (len > cap + RAW_BODY_DRAIN_SLACK) req.destroy();
        return;
      }
      if (len > cap) {
        over = true;
        chunks = []; // release what we'd buffered — it is not going to be used
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks)); });
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
  // A stable per-notification key so a later beat can retract this exact alert
  // once its subject is addressed (XERK-154, dismiss() below). The app posts the
  // notification under it and cancels by it; alerts sharing a key collapse.
  if (opts.notifKey) data.notifKey = opts.notifKey;
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

// Retract an already-delivered notification once the thing it flagged has been
// addressed elsewhere — a merged/closed PR, an answered question, a resumed
// turn (XERK-154). A data-only FCM message the app recognises by
// `action:"dismiss"` and cancels by the same `notifKey` the original alert
// carried. Best-effort and a no-op with no devices / FCM off, exactly like
// notify(); carries no title/body, so it shows nothing itself.
function dismiss(notifKey) {
  if (!notifKey) return;
  // Only devices whose app build declared "dismiss" support — a retraction is a
  // data-only message an older build would show as a blank notification instead
  // of cancelling (XERK-154). Withheld devices simply keep the stale alert until
  // the app updates, which is strictly better than a blank one.
  const tokens = listDevices()
    .filter((d) => Array.isArray(d.features) && d.features.includes("dismiss"))
    .map((d) => d.token);
  if (!tokens.length) return;
  push
    .sendFcm(tokens, { data: { action: "dismiss", notifKey } })
    .then((r) => pruneDevices(r.dead))
    .catch((e) => console.error(`fcm dismiss failed: ${e.message}`));
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
// Two rules the web's `liveState` applies, in ITS order, which this mirror did
// not (XERK-235):
//  - no transcript yet is IDLE, decided BEFORE paneBusy is consulted;
//  - working requires the HOST to be online. paneBusy is a value on a record the
//    host last pushed, so a host that dies mid-turn leaves `paneBusy:true` behind
//    and its session reads WORKING forever. Here that also meant `readyForReview`
//    short-circuited, so the operator's phone never buzzed for exactly the
//    stranded work that most needs a look.
// The hub is the trust boundary between an agent's pane scrape and the browser,
// so a `turn` frame's agent rows are re-shaped here rather than forwarded raw:
// elements are coerced to {sel,type,label}, non-objects and empty types dropped,
// and the list bounded. Unvalidated, one `null` element threw in `agentsHtml`
// and cost that repaint; the cap matches the agent's own PANE_AGENTS_MAX.
// `null` (not `[]`) for a frame with no `agents` key at all, so the chat can
// tell "this agent can't report them" from "no agents are running".
const LIVE_AGENTS_MAX = 32;
const LIVE_AGENT_FIELD_MAX = 400;
function sanitizeLiveAgents(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const type = String(a.type == null ? "" : a.type).slice(0, LIVE_AGENT_FIELD_MAX);
    if (!type) continue;
    out.push({ sel: !!a.sel, type,
      label: String(a.label == null ? "" : a.label).slice(0, LIVE_AGENT_FIELD_MAX) });
    if (out.length >= LIVE_AGENTS_MAX) break;
  }
  return out;
}

// Does this session have background agents in flight? The agent reports the
// TUI's own live agent list (`live_subagents`, hub-agent.py), which is non-empty
// for exactly as long as delegated work is running (XERK-245).
//
// It is checked AHEAD of paneBusy in every working/idle mirror, and only ever
// adds working — a session that ended its own turn to wait on a background agent
// paints no interrupt hint, so paneBusy says False while it is plainly still
// working. It stays BEHIND the offline and no-transcript rules, which paneBusy
// also loses to: this is a value on the record a host last pushed, so a host
// that dies mid-run must not leave its sessions reading working forever.
//
// An agent predating the field sends none, which reads as "can't tell" and
// leaves that host's behaviour exactly as it was — never as "no agents".
function hasLiveAgents(s) {
  return Array.isArray(s?.agents) && s.agents.length > 0;
}

function sessionWorking(session, lastSeen, now) {
  const s = session.session;
  const age = s?.transcriptAgeSec;
  if (age == null) return false;
  if (now - (lastSeen || 0) >= OFFLINE_AFTER_MS) return false;
  if (hasLiveAgents(s)) return true;
  if (s?.paneBusy != null) return s.paneBusy;
  return age * 1000 + Math.max(0, now - (lastSeen || 0)) < WORKING_WINDOW_MS;
}

// Should a held PR alert fire yet (XERK-153)? `w` is that PR's wait record
// ({at} when first seen, plus the sticky markers this advances), `status` the
// PR-status object the agent reports for that URL on this beat, if any.
//
// A PR alert used to fire the instant the agent scraped the URL out of the
// transcript, which is the moment the work is LEAST ready to look at: CI hasn't
// run. So the alert now waits for the CI rollup to come back green, and the
// interesting cases are the ones that aren't green:
//
//   - No status yet. `checks` is absent until the agent's PR-status refresh has
//     fetched this PR at least once, so absence means "not looked at", never
//     "no CI". Hold.
//   - `checks: null` — the PR really has no checks. Fire, but only once it has
//     held for PR_NO_CI_GRACE_MS (see there): a brand-new PR looks exactly like
//     this while GitHub registers its workflows.
//   - `failing`. Stay quiet, permanently: the session that opened the PR is
//     expected to fix it and push again, and the alert is for the PR being
//     ready, not for every round trip through red. Sticky, so the age-out
//     backstop can't leak an alert for a PR that is known-broken.
//   - `pending`, or anything inconclusive, until PR_ALERT_MAX_WAIT_MS. Hold,
//     then fire regardless — the wait is meant to delay the alert, not to lose
//     it to a host whose `gh` can't answer.
//
// One more state outranks all of those: an open PR GitHub says is CONFLICTING
// merges nowhere however green its CI is, so no alert may claim it is ready
// (XERK-223). It holds — including past the age-out backstop, which exists for
// an UNKNOWABLE state, not a known-bad one — and unlike `failing` the hold is
// NOT sticky: the authoring session is nudged to resolve the conflict
// (_poll_pr_conflicts), and once it has, this PR alerts like any other.
//
// Returns the body prefix to send, or null to keep holding. Mutates `w`.
function prAlertDecision(w, status, now) {
  const known = !!status && "checks" in status;
  const checks = known ? status.checks : undefined;
  const open = status?.state === "OPEN" || status?.state === "DRAFT";
  const conflicted = open && status?.mergeable === "CONFLICTING";
  if (checks === "failing") w.red = true;
  if (conflicted) return null;
  if (checks === "passing") return "All checks passed";
  if (known && checks == null) {
    w.noCiAt = w.noCiAt || now;
    if (now - w.noCiAt >= PR_NO_CI_GRACE_MS) return "No CI configured";
  } else {
    delete w.noCiAt; // checks appeared (or vanished): it isn't a CI-less PR
  }
  if (!w.red && now - (w.at || now) >= PR_ALERT_MAX_WAIT_MS) return "CI state unknown";
  return null;
}

// Has this PR left the operator's plate? MERGED/CLOSED are the two end states;
// everything else — OPEN, DRAFT, and an unfetched/unknown state — counts as
// still live. An unreadable state must never be what drops work off the review
// list. Mirrors sessions.html.
function prLanded(p) {
  const st = String((p && p.state) || "").toUpperCase();
  return st === "MERGED" || st === "CLOSED";
}

// "Ready for review" (XERK-224): a running session that has stopped and is now
// waiting on the OPERATOR rather than on itself. The mirror of the Sessions
// page's `readyForReview` (public/sessions.html) — the section a session enters
// is what the alert below announces, so the two rules have to be the same one.
//
// Qualifies on a pending question / blocking dialog (blocked on a human, so the
// busy read doesn't matter), a PR that hasn't landed (a diff to read), or a
// finished turn — newest entry is plain assistant output with nothing pending,
// which is the only trace a research task with no PR leaves. A session that
// opened a PR is judged on the PR alone: it leaves when the session works
// again, or when every PR it opened has landed (merged or closed IS the
// review). `working` is the caller's already-computed busy read.
function readyForReview(session, working) {
  if (session.status !== "running") return false;
  const s = session.session || {};
  if (s.question || (s.panePrompt && s.panePrompt.prompt)) return true;
  if (working) return false;
  const prs = session.prs || [];
  if (prs.some((p) => !prLanded(p))) return true;
  // Landed PRs stop being a reason to look, but must not become a reason NOT
  // to: the same session can be given a new task after the merge, and would
  // otherwise be hidden for good. `newWorkSincePrs` (XERK-224) expires the
  // demotion once the conversation moves past the landing.
  if (prs.length && !session.newWorkSincePrs) return false;
  return s.lastRole === "assistant" && !s.lastHasToolUse;
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

  // Claude login health (XERK-98): the agent reports the shared subscription
  // login's refresh-token expiry. `needsLogin` (lapsed/missing) is the urgent
  // edge — the host keeps heartbeating but its sessions and headless probes
  // can't authenticate until someone runs `claude /login` there. `expiringSoon`
  // is the proactive nudge before that happens. Both edge-trigger once and
  // clear on recovery, mirroring the offline/online pair. Guarded so an older
  // agent that reports no block fires nothing.
  const ca = next.claudeAuth;
  if (ca) {
    if (ca.needsLogin) {
      if (!alerts.claudeLoginAt) {
        alerts.claudeLoginAt = now;
        notify(`Claude login required${where}`, `Run 'claude /login' on ${key} — sessions can't authenticate until then.`, {
          tags: "key",
          priority: "high",
          route: { host: key },
        });
      }
      // The hard state supersedes the soft one, so a lapsed login never also
      // carries a stale "expiring soon" marker to re-fire on recovery.
      delete alerts.claudeExpiringAt;
    } else {
      if (alerts.claudeLoginAt) {
        delete alerts.claudeLoginAt;
        notify(`Claude login restored${where}`, `${key} is authenticated again.`, {
          tags: "green_circle",
          route: { host: key },
        });
      }
      if (ca.expiringSoon) {
        if (!alerts.claudeExpiringAt) {
          alerts.claudeExpiringAt = now;
          const when = ca.refreshExpiresAt ? ` (expires ${fmtDur(ca.refreshExpiresAt - now)} from now)` : "";
          notify(`Claude login expiring${where}`, `Re-login soon on ${key}${when} — run 'claude /login'.`, {
            tags: "key",
            route: { host: key },
          });
        }
      } else {
        delete alerts.claudeExpiringAt;
      }
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
    const questionKey = `question:${key}:${session.id}`;
    if (s.question && s.question !== sa.lastQuestion) {
      sa.lastQuestion = s.question;
      notify(`${label} has a question`, s.question, { tags: "question", priority: "high", route, notifKey: questionKey });
    }
    if (!s.question) {
      // Answered/cleared elsewhere (e.g. from the desktop) — retract the
      // phone's now-stale question notification (XERK-154). The guard fires the
      // dismiss once, on the edge, not every quiet beat.
      if (sa.lastQuestion) dismiss(questionKey);
      delete sa.lastQuestion;
    }

    const working = sessionWorking(session, next.lastSeen, now);

    // A new PR goes into a per-session wait list rather than alerting straight
    // away, and leaves it when its CI settles (prAlertDecision). `prSeen` keeps
    // its old meaning — URLs already alerted — so PRs an older hub announced
    // don't re-fire after this upgrade.
    const wait = (sa.prWait = sa.prWait || {});
    for (const url of s.newPrUrls || []) {
      if ((sa.prSeen || []).includes(url)) continue;
      if (!wait[url]) wait[url] = { at: now };
    }
    // Statuses ride the session record (session.prs), not the per-beat signals:
    // they're refreshed on the agent's slower PR cadence and persist between.
    const prStatus = new Map();
    for (const p of session.prs || []) if (p && p.url) prStatus.set(p.url, p);
    // A settled PR no longer alerts on its own (XERK-224). Its verdict is held
    // here and spent by the one ready-for-review alert below, so a session that
    // finished a turn AND opened a PR buzzes once instead of twice — which is
    // the whole point of collapsing these. `prSeen` still records the URL, so a
    // note is minted once per PR and the hold can never become a loop.
    for (const url of Object.keys(wait)) {
      const note = prAlertDecision(wait[url], prStatus.get(url), now);
      if (!note) continue;
      delete wait[url];
      sa.prSeen = [...(sa.prSeen || []), url].slice(-PR_ALERT_MAX_TRACKED);
      sa.prNotes = [...(sa.prNotes || []), { url, note }].slice(-PR_ALERT_MAX_TRACKED);
    }
    // Bound the wait list the way prSeen is bounded: a PR whose CI never
    // resolves ages out via the backstop, but a host that somehow outruns that
    // must not grow this without limit. Oldest-first.
    const waiting = Object.keys(wait);
    if (waiting.length > PR_ALERT_MAX_TRACKED) {
      waiting
        .sort((a, b) => (wait[a].at || 0) - (wait[b].at || 0))
        .slice(0, waiting.length - PR_ALERT_MAX_TRACKED)
        .forEach((url) => delete wait[url]);
    }

    // Turn finished: was working, transcript went quiet, and the newest entry
    // is plain assistant output (a pending tool call or question means it's
    // still mid-turn / already alerted above). A beat that just recovered from
    // an offline period skips this — "back online" already covers it and the
    // working->idle edge across the gap is stale. It no longer alerts on its
    // own either; it ARMS the ready-for-review alert below.
    if (sa.wasWorking && !working && !recovered && s.lastRole === "assistant" && !s.lastHasToolUse) {
      sa.reviewAt = now;
    }

    // The one per-session alert (XERK-224), replacing the separate "finished
    // its turn" and "created a PR" notices: the operator wants ONE buzz per
    // piece of work, not one per signal the work happened to leave behind.
    //
    //   - It fires when the session ENTERS the Sessions page's Ready-for-review
    //     section (readyForReview — the same rule the page renders), and only
    //     on something new: a turn that just finished, or a PR that just
    //     settled. A session already sitting there when the hub boots is not
    //     re-announced.
    //   - A PR still waiting on its CI HOLDS the alert, so it lands when the
    //     work is genuinely reviewable and carries the verdict. Nothing is lost
    //     to a stuck wait — prAlertDecision ages out and answers anyway.
    //   - A pending question suppresses it: the high-priority question alert
    //     above is already that session's buzz, and it says more.
    const reviewKey = `review:${key}:${session.id}`;
    const ready = readyForReview(session, working);
    // Only PRs still in play are worth naming — one merged while the alert was
    // held has answered itself.
    const notes = (sa.prNotes || []).filter((n) => !prLanded(prStatus.get(n.url)));
    // What holds the alert is read off the SESSION's PRs, not off the CI wait
    // list alone: a URL only ever enters that list through the per-beat
    // `newPrUrls` scrape, so a PR whose scrape landed before this hub booted —
    // or one already announced once, whose session has since worked and
    // finished again — leaves the list empty while the PR is still open. Gating
    // on the list alone therefore fired the alert for work that merges nowhere,
    // captioned "nothing to merge".
    const livePrs = (session.prs || []).filter((p) => p && !prLanded(p));
    const holdingPr = Object.keys(wait).length > 0
      // A CONFLICTING PR merges nowhere however green its CI is (XERK-223), and
      // prAlertDecision holds it past the age-out for the same reason. Every
      // verdict now feeds this one alert, so the hold has to reach it too.
      || livePrs.some((p) => p.mergeable === "CONFLICTING");
    if (ready && !sa.reviewAlerted && !s.question && !holdingPr && (sa.reviewAt || notes.length)) {
      const repo = session.git?.repoName ? ` · ${session.git.repoName}@${session.git.branch}` : "";
      // "Nothing to merge" is a claim about the session, so it may only be made
      // when the session really opened nothing. A live PR with no banked verdict
      // (its alert was spent on an earlier turn) is still named, minus the CI line.
      const body = notes.length
        ? notes.map((n) => `${n.note} · ${n.url}`).join("\n")
        : livePrs.length
          ? livePrs.map((p) => p.url).join("\n")
          : `Finished — nothing to merge${repo}`;
      const click = notes.length ? notes[notes.length - 1].url
        : livePrs.length ? livePrs[livePrs.length - 1].url : null;
      notify(`${label} is ready for review`, body, {
        tags: "mag",
        route,
        notifKey: reviewKey,
        ...(click ? { click } : {}),
      });
      sa.reviewAlerted = true;
      delete sa.reviewAt;
      delete sa.prNotes;
    }
    // Retract it once the reason to look is gone (XERK-154's dismiss contract):
    // the session left the section, either by working again (the operator
    // replied, or it picked the work back up) or by its PRs landing — a merge
    // IS the review. Fires once, on the edge, via the reviewAlerted flag.
    if (sa.reviewAlerted && !ready) {
      dismiss(reviewKey);
      delete sa.reviewAlerted;
    }
    // A stale finish edge must not outlive the turn that follows it; a held PR
    // note must, since its alert is still owed.
    if (working) delete sa.reviewAt;
    // An older hub delivered "finished its turn" under its own key. Retract that
    // one on the same edge it used to, so an upgrade doesn't strand it on the
    // phone with nothing left to clear it.
    if (working && sa.turnAlerted) {
      dismiss(`turn:${key}:${session.id}`);
      delete sa.turnAlerted;
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

// Auto-start RETRIES until it succeeds, backing off but NEVER giving up (XERK-61
// added the retry; XERK-109 removed the give-up). Queuing a spawnTicket is not
// evidence that a session started: the agent acks every command it takes,
// including ones it refuses outright (no triaged repo on THAT host, no owner to
// clone with) and ones that simply blow up mid-spawn (a Jira fetch that times
// out, a git failure) — handle_commands logs and acks those exactly like a
// success, and nothing reports the outcome back. Treating "queued once" as
// "started" made such a failure permanent, which is what "sometimes it starts and
// sometimes it doesn't, with every condition met" looks like from the board.
//
// XERK-61's first fix retried a failed attempt on a growing backoff, but it CAPPED
// the retries and gave up after a handful — so a ticket that flaked a few times for
// a purely transient reason (Jira briefly down, the shared login momentarily
// unavailable, a git hiccup) stayed blacklisted for the hub's lifetime even once
// the condition cleared and every visible condition was met. That is the XERK-109
// report. So the cap is gone: the backoff climbs to a ceiling and HOLDS there, and
// the sweep keeps trying indefinitely. A genuinely-stuck ticket therefore re-queues
// at most once per ceiling interval (cheap — the agent refuses an impossible spawn
// before it ever fetches Jira), while a transiently-blocked one self-heals on the
// first sweep after its condition returns.
//
// The retry gate is EVIDENCE, in the same order the sweep already checks it: a
// session for the ticket (on any channel) ends the attempts for good and drops the
// record, an in-flight command means we're still waiting, and only a ticket still
// session-less with nothing in flight past its backoff is tried again.
const AUTO_START_RETRY_MS = 60 * 1000;      // after attempt 1; doubles each time
const AUTO_START_RETRY_MAX_MS = 10 * 60 * 1000;   // backoff ceiling; retries never stop
// Doublings before the backoff reaches its ceiling (1→2→4→8→10min). The attempt
// counter is capped here so it settles into a steady once-per-ceiling retry rather
// than climbing without bound on a ticket that never manages to start.
const AUTO_START_BACKOFF_STEPS = 5;
// "<siteKey>\x00<issueKey>" -> { attempts, nextAt }. Entries are dropped the
// moment the ticket is seen to have a session, so this stays as small as the set
// of tickets currently failing to start.
const autoStarted = new Map();

// When to try again after `attempts` failed attempts: 1min, 2min, 4min, 8min, then
// held at AUTO_START_RETRY_MAX_MS (10min) for good.
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
      // taken and produced nothing. Retry it once its backoff has elapsed — the
      // backoff is the ONLY gate now, so a ticket blocked by a transient failure
      // recovers on its own the moment the block clears (XERK-109).
      const prior = autoStarted.get(k);
      if (prior && now < prior.nextAt) continue;
      const { host } = findTicketHost(siteKey, repo, t.key);
      // No online host to route to right now (the org's hosts are down, or the
      // ticket's pinned agent is) — spend no attempt, so the next sweep retries
      // immediately once a host is back rather than sitting out a backoff for a
      // failure that was never the ticket's fault.
      if (!host) continue;
      const mpin = ticketModelPin(siteKey, t.key);   // XERK-123, see /session
      queueCommand(host, { type: "spawnTicket", issueKey: t.key,
        ...(mpin ? { model: mpin.model } : {}) });
      // Grow the backoff toward its ceiling; the counter is capped there so it
      // settles into a steady once-per-ceiling retry instead of climbing forever.
      const attempts = Math.min((prior ? prior.attempts : 0) + 1,
        AUTO_START_BACKOFF_STEPS);
      autoStarted.set(k, { attempts, nextAt: autoStartRetryAt(now, attempts) });
      if (attempts > 1) {
        console.log(`auto-start: retrying ${t.key} on ${host} — the previous `
          + "spawnTicket was acked but left no session (backing off, but the hub "
          + "keeps trying so it recovers once the block clears)");
      }
    }
  }
}
// The lifecycle counterpart to autoStartSweep (XERK-45): when a ticket moves to
// Done, stop the session(s) working it.
//
// UNLIKE auto-start, this is UNCONDITIONAL — it is NOT gated on the per-org
// "auto" opt-in (orgsWithAutoStart), which governs ONLY whether the hub
// auto-STARTS work (XERK-161). A ticket only reaches Done by a HUMAN moving it
// (the board is pull-only — no session writes to Jira), so it's a deliberate
// "this work is finished" signal that should always retire its session, whatever
// the org's auto-start preference. So this sweep runs for EVERY org that reports
// a board block. It can only ever touch a session that was spawned to WORK a
// ticket (s.ticket is set) whose key now reads Done on the board — a
// manually-started session carries no ticket and is never affected.
//
// The hub KILLS the session rather than merely interrupting it: a kill ends the
// session cleanly — it moves to the Ended list with its worktree, conversation
// and PR chips intact and still resumable, and frees the MAX_SESSIONS slot. An
// interrupt would only cancel the in-flight turn and leave the session running
// idle, still holding that slot with nothing to do.
//
// The DECISION and ROUTING live here for the same reason auto-start's do: only
// the hub sees the whole fleet. The tickets (and which is Done) come from each
// org's freshest jira block, but a session can live on ANY host, so the sweep
// scans the whole fleet and routes each kill to the host that owns the session —
// the kill command is keyed on the sessionId the agent minted.
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
  // The set of now-Done tickets across EVERY reporting org — no opt-in gate —
  // each taken from that org's freshest block, the same copy the board renders,
  // so the hub stops on what the board shows, not a lagging host's view.
  const freshest = new Map(); // siteKey -> { block, at }
  for (const a of Object.values(agents)) {
    const j = a && a.jira;
    if (!j || !j.siteKey) continue;
    const at = String(j.fetchedAt || "");
    const cur = freshest.get(j.siteKey);
    if (!cur || at > cur.at) freshest.set(j.siteKey, { block: j, at });
  }
  const doneKeys = new Set(); // "<siteKey>\x00<issueKey>"
  for (const { block } of freshest.values()) {
    for (const t of block.tickets || []) {
      if (t && t.key && t.statusCategory === "done") {
        doneKeys.add(block.siteKey + "\x00" + t.key);
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

// Migration timeouts + settled-record cleanup (the fast handoff runs on the
// target's heartbeat; this is the fallback that fails a stuck move and retires a
// done one). Runs regardless of boot grace — a migration is only ever created
// after boot, by an explicit operator action.
setInterval(() => {
  if (migrations.size) advanceMigrations();
}, 10 * 1000).unref();

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
  "/newticket.js":         { body: fs.readFileSync(path.join(__dirname, "public", "newticket.js")),        type: "text/javascript; charset=utf-8",           cache: "public, max-age=300" },
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

    // The migration transcript relay is agent-pushed/pulled (bearer token) like
    // the heartbeat/archive — a source agent POSTs the bundle, the target agent
    // GETs it (XERK-101). The user-triggered /migrate endpoint that starts it
    // all rides the normal user login below.
    const isMigrationBlob =
      (req.method === "POST" || req.method === "GET") &&
      parts[0] === "api" && parts[1] === "agents" &&
      parts[3] === "migrations" && parts[5] === "blob" && parts.length === 6;

    // The attachment relay's READ side is the agent collecting a staged file
    // (XERK-234), so it rides the agent token like the migration bundle above.
    // The upload itself is the OPERATOR's, and stays on the normal user login.
    const isUploadBlob =
      req.method === "GET" && parts[0] === "api" && parts[1] === "agents" &&
      parts[3] === "uploads" && parts[5] === "blob" && parts.length === 6;

    if (url.pathname === "/api/heartbeat" || isArchiveIngest || isUpdatingSignal ||
        isMigrationBlob || isUploadBlob) {
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
      const features = Array.isArray(body.features) ? body.features : undefined;
      registerDevice(token, platform, features);
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
      const cached = agentsCache || safeAgentsCache();
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
      const raw = JSON.parse((await readBody(req, HEARTBEAT_MAX)) || "{}");
      const payload = sanitizeHeartbeat(raw, (raw && raw.device) || "unknown host");
      // Coerce an old agent's per-model usage lists to the current shape before
      // anything (the record, the cache, every client) sees them.
      normalizeUsage(payload);
      normalizeLimits(payload);
      // Identity is the physical host name (`device`); with one container per
      // host the container name is no longer meaningful. agentId is a last-resort
      // fallback if the host name couldn't be read.
      const key = payload.device || payload.agentId;
      if (!key) return json(res, 400, { error: "device/agentId required" });
      // `agents` is a plain object keyed by host name, so a non-string or a
      // prototype key is not a host: `__proto__` 200'd while the beat was
      // silently discarded (and replaced the registry's prototype), and an
      // object key landed as "[object Object]" (XERK-235). Refuse it loudly —
      // a beat the hub throws away must never report success.
      if (typeof key !== "string" || key.length > 200 ||
          key === "__proto__" || key === "constructor" || key === "prototype") {
        return json(res, 400, { error: "device must be a plain host name" });
      }
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
      // Outcomes of board status changes the agent applied since the last beat
      // (the {type:"setTicketStatus"} command, XERK-138); cached by cmdId below
      // so the panel that asked can poll for its own answer.
      const ticketStatusResults = payload.ticketStatusResults;
      delete payload.ticketStatusResults;
      // New-ticket create metadata + outcomes the agent produced since the last
      // beat (see the {type:"boardCreateMeta"|"createTicket"} commands, XERK-137);
      // cached below like jiraIssueResults, off the persisted record.
      const createMetaResults = payload.createMetaResults;
      delete payload.createMetaResults;
      const createTicketResults = payload.createTicketResults;
      delete payload.createTicketResults;
      // Session-creating commands this agent REFUSED since the last beat
      // (XERK-265) — cached by cmdId below and applied to any migration they
      // name, so a refusal fails the move now rather than at its timeout.
      const spawnFailures = payload.spawnFailures;
      delete payload.spawnFailures;
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
        // Per-cmdId board-status-change outcome cache (see the /status route,
        // XERK-138); survives across beats like `jiraIssues`.
        statusResults: prev.statusResults || {},
        // Per-cmdId refusals of a session-creating command (XERK-265). Survives
        // across beats like the caches above, but is SERVED with the record
        // rather than stripped — the client following that spawn is who needs it.
        spawnRefusals: prev.spawnRefusals || {},
        // New-ticket create caches (XERK-137): the org's project/label metadata,
        // per-project issue types, and per-cmdId create outcomes. Like the other
        // on-demand caches, they survive across beats and are stripped from the
        // fleet payload (served by their own routes).
        createMeta: prev.createMeta || null,
        createTypes: prev.createTypes || {},
        createResults: prev.createResults || {},
        // Commands awaiting a staged result, and the capability gaps their acks
        // have proved (XERK-151). Both survive across beats like the caches
        // above; `unsupported` is what the board routes refuse on.
        resultWaits: prev.resultWaits || {},
        unsupported: prev.unsupported || {},
      });
      // The whole-record ceiling, checked BEFORE the ingests run. The caches are
      // aliased from `prev` (`history: prev.history || {}`), so ingesting first
      // and then restoring `prev` restored an object the ingests had already
      // mutated — a refused beat still poisoned the caches and its content came
      // back out of /history with a 413 on the wire.
      const recordSize = agentRecordSize(next);
      // Visible BEFORE it 413s. Measured against the operator's real fleet the
      // largest record is 0.30 MiB, so half the ceiling means something has
      // changed shape (~158 repos or ~83 sessions on one host). Logged on the
      // CROSSING EDGE only, and re-armed when it drops back: beats arrive every
      // ~8s, so warning per-beat would be ~10,800 lines a day, forever, for a
      // host that legitimately settles above the line.
      const overHalf = recordSize > AGENT_RECORD_MAX / 2 && recordSize <= AGENT_RECORD_MAX;
      if (overHalf && !recordSizeWarned.get(key)) {
        console.warn(
          `heartbeat from ${key}: record is ${recordSize} bytes, over half the ` +
            `${AGENT_RECORD_MAX} limit`
        );
      }
      recordSizeWarned.set(key, overHalf);
      if (recordSize > AGENT_RECORD_MAX) {
        if (prev && Object.keys(prev).length) agents[key] = prev;
        else delete agents[key];
        console.error(
          `heartbeat from ${key}: record is ${recordSize} bytes, over the ` +
            `${AGENT_RECORD_MAX} limit — beat refused`
        );
        return json(res, 413, { error: "agent record too large", limit: AGENT_RECORD_MAX });
      }
      ingestHistory(next, historyResults);
      ingestSubagentHistory(next, subagentHistoryResults);
      ingestJiraIssues(next, jiraIssueResults);
      ingestStatusResults(next, ticketStatusResults);
      ingestCreateMeta(next, createMetaResults);
      ingestCreateResults(next, createTicketResults);
      ingestSpawnFailures(key, next, spawnFailures);
      // Ordered after every ingest above: an ack settles against what this same
      // beat delivered, which is the whole basis of the gap detection.
      resolveResultWaits(prev, next, commands);
      heartbeatAlerts(key, prev, next);
      rearmMovedWatches(key, prev, next);
      // A migration finishes the instant its target session heartbeats in — do
      // the handoff (kill source, mark done) now rather than waiting out the
      // sweep interval (XERK-101). Cheap: a no-op unless a migration is live.
      if (migrations.size) advanceMigrations();
      // Stamp what this reply hands over. Delivery is the line between "the
      // agent never saw this" and "the agent may already have run it" — the
      // hub's only evidence for either, since the queue drains on ACK, not on
      // delivery. dropQueuedCommand and the create poll both turn on it.
      for (const c of commands) if (c && !c.deliveredAt) c.deliveredAt = Date.now();
      const reply = publicCommands(commands);   // strip AFTER stamping, or the
      scheduleSave();                           // no-op copy hands back the
                                                // same objects and leaks it
      // A fresh beat landed — refresh the memoized fleet payload and push the
      // updated record to open dashboards so the UI reflects it near-instantly.
      publishAgent(key);
      return json(res, 200,
        archiveHave ? { commands: reply, archiveHave } : { commands: reply });
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

    // POST /api/agents/<host>/migrations/<id>/blob — the SOURCE agent uploading
    // a migrated session's raw transcript bundle. Agent-authed above. Body is
    // the raw gzipped tar; storing it advances the migration to `importing` and
    // queues importSession on the target (XERK-101).
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "agents" &&
        parts[3] === "migrations" && parts[5] === "blob" && parts.length === 6) {
      const id = decodeURIComponent(parts[4]);
      const m = migrations.get(id);
      if (!m) return json(res, 404, { error: "unknown migration" });
      if (m.phase !== "exporting")
        return json(res, 409, { error: "migration not awaiting a bundle" });
      let blob;
      try {
        blob = await readRawBody(req, MIGRATE_BLOB_MAX);
      } catch (e) {
        m.phase = "failed"; m.error = "transcript bundle too large"; m.at = Date.now();
        publishMigrations();
        return json(res, 413, { error: e.message });
      }
      if (!blob.length) return json(res, 400, { error: "empty bundle" });
      m.blob = blob;
      m.phase = "importing";
      m.at = Date.now();
      // Hand the target everything it needs to resume the moved session as its
      // old self: the transcript id + origin cwd (so `claude --resume` resolves)
      // plus the carried-over identity. Its spawnCmdId is this importCmdId, which
      // is how advanceMigrations recognizes the target session coming up.
      const src = agents[m.srcHost];
      const s = src && (src.sessions || []).find((x) => x.id === m.srcSessionId);
      const cwd = s && s.worktreePath;
      if (!cwd) {
        m.phase = "failed"; m.error = "source session gone"; m.blob = null; m.at = Date.now();
        publishMigrations();
        return json(res, 409, { error: "source session gone" });
      }
      m.importCmdId = queueCommand(m.targetHost, {
        type: "importSession",
        migrationId: id,
        transcriptId: m.transcriptId,
        cwd,
        repo: m.repo,
        model: m.meta.model,
        permissionMode: m.meta.permissionMode,
        modelSource: m.meta.modelSource,
        summary: m.meta.summary,
        summaryManual: m.meta.summaryManual,
        label: m.meta.label,
        ticket: m.meta.ticket,
        migratedFrom: { host: m.srcHost, sessionId: m.srcSessionId, at: Date.now() },
      });
      publishMigrations();
      return json(res, 200, { ok: true });
    }

    // GET /api/agents/<host>/migrations/<id>/blob — the TARGET agent pulling the
    // bundle to unpack + resume. Agent-authed above.
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "agents" &&
        parts[3] === "migrations" && parts[5] === "blob" && parts.length === 6) {
      const id = decodeURIComponent(parts[4]);
      const m = migrations.get(id);
      if (!m || !m.blob) return json(res, 404, { error: "no bundle" });
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": m.blob.length,
        "Cache-Control": "no-store",
      });
      return res.end(m.blob);
    }

    // GET /api/agents/<host>/uploads/<id>/blob — the agent collecting a file the
    // operator attached to a message (XERK-234). Agent-authed above. Scoped to
    // the host the upload was staged for, so one host's agent token can't pull
    // another host's pending attachment. The blob is NOT dropped on read: the
    // agent may be re-issued the command (at-least-once delivery), and letting it
    // expire on the TTL costs nothing a re-download doesn't.
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "agents" &&
        parts[3] === "uploads" && parts[5] === "blob" && parts.length === 6) {
      sweepUploads();
      const host = decodeURIComponent(parts[2]);
      const u = uploads.get(decodeURIComponent(parts[4]));
      if (!u || u.host !== host) return json(res, 404, { error: "no such upload" });
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": u.bytes.length,
        "Cache-Control": "no-store",
      });
      return res.end(u.bytes);
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

    // POST /api/agents/<host>/clone — queue a clone into the host's repos
    // root. Body: {repo, source?} — repo is owner/repo or a GitHub URL, and
    // source ("github"/"azure"/"gitlab", XERK-155) says which listing the pick
    // came from; the agent resolves the clone URL against its OWN cached
    // listing for that source, so nothing here is more than routing. Omitted
    // source keeps the legacy free-text GitHub meaning. The new repo joins the
    // scan and becomes spawnable once the clone lands.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "agents" &&
        parts[3] === "clone" && parts.length === 4) {
      const key = decodeURIComponent(parts[2]);
      if (!agents[key]) return json(res, 404, { error: "unknown agent" });
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body.repo) return json(res, 400, { error: "repo required" });
      const cmd = { type: "clone", repo: String(body.repo) };
      if (body.source != null) {
        if (!["github", "azure", "gitlab"].includes(body.source)) {
          return json(res, 400, { error: "unknown clone source" });
        }
        cmd.source = body.source;
      }
      const cmdId = queueCommand(key, cmd);
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

    // POST /api/agents/<host>/restart — restart the host's agent MANAGER from
    // the dashboard (XERK-157), e.g. after fixing an expired Claude login. The
    // agent exits for its supervisor (systemd Restart=always / Docker restart
    // policy / turma-agentctl) to bring it back; running sessions are re-adopted
    // on boot. The agent announces the expected downtime so the coming beat gap
    // reads as `updating`, not an outage. Collapse a mashed button: don't queue
    // a second restart while one is already unacked in flight.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "agents" &&
        parts[3] === "restart" && parts.length === 4) {
      const key = decodeURIComponent(parts[2]);
      if (!agents[key]) return json(res, 404, { error: "unknown agent" });
      const pending = (agents[key].commands || []).find((c) => c.type === "restartAgent");
      const cmdId = pending ? pending.cmdId : queueCommand(key, { type: "restartAgent" });
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
      for (const f of ["label", "baseRef", "model", "permissionMode", "modelSource"]) {
        if (typeof body[f] === "string" && body[f].trim()) cmd[f] = body[f].trim();
      }
      // Same enum as the switch route: a spawn is the OTHER way onto the local
      // model, so junk must 400 here rather than land as an errored session card.
      const spawnSourceErr = checkSpawnModelSource(cmd, hostname);
      if (spawnSourceErr) return json(res, spawnSourceErr.status, { error: spawnSourceErr.error });
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
        // Only `!body.repo` was checked, so an object/array/number went to the
        // agent verbatim (XERK-235). /api/trigger already gets this right.
        if (!body.repo || typeof body.repo !== "string") {
          return json(res, 400, { error: "repo required" });
        }
        const cmd = { type: "spawn", repo: body.repo };
        for (const f of ["prompt", "label", "baseRef", "model", "permissionMode",
                         "modelSource"]) {
          if (body[f] != null && body[f] !== "") {
            if (typeof body[f] !== "string") {
              return json(res, 400, { error: `${f} must be a string` });
            }
            // The queue is re-serialized into every /api/agents response, every
            // SSE frame and state.json, so an unbounded prompt/label is a
            // fleet-wide cost, not just this command's.
            if (body[f].length > SPAWN_FIELD_MAX) {
              return json(res, 413, { error: `${f} too long`, limit: SPAWN_FIELD_MAX });
            }
            cmd[f] = body[f];
          }
        }
        const spawnSourceErr = checkSpawnModelSource(cmd, key);
        if (spawnSourceErr) return json(res, spawnSourceErr.status, { error: spawnSourceErr.error });
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
      // POST /api/agents/<srcHost>/sessions/<id>/migrate -> move a running
      // session to another agent in the SAME org (XERK-101). Body: {host}, the
      // target. The hub orchestrates: exportSession on the source, the blob
      // relay, importSession on the target, then a kill of the source once the
      // target is up. Returns {migrationId}; the UI follows the move via the
      // `migrations` payload (its importCmdId feeds the normal followSpawn).
      if (req.method === "POST" && parts.length === 6 && parts[5] === "migrate") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const target = typeof body.host === "string" ? body.host : "";
        const src = agents[key];
        const s = (src.sessions || []).find((x) => x.id === sessionId);
        if (!s) return json(res, 404, { error: "unknown session" });
        if (s.status !== "running")
          return json(res, 409, { error: "only a running session can be moved" });
        if (s.root)
          return json(res, 409, { error: "a repos-root session has no worktree to move" });
        if (!s.transcriptId)
          return json(res, 409, { error: "this session has no conversation to move yet" });
        if (!target || target === key)
          return json(res, 400, { error: "a different target host is required" });
        const tgt = agents[target];
        if (!tgt) return json(res, 404, { error: "unknown target host" });
        if (siteKeyOf(src) !== siteKeyOf(tgt))
          return json(res, 409, { error: "the target agent is in a different org" });
        if (Date.now() - (tgt.lastSeen || 0) >= OFFLINE_AFTER_MS)
          return json(res, 503, { error: "the target agent is offline" });
        if (!(tgt.repos || []).some((r) => r && r.name === s.repo))
          return json(res, 409, {
            error: `the target agent doesn't have "${s.repo}" cloned — clone it there first`,
          });
        // Single-flight: don't start a second move of the same session while one
        // is already exporting/importing (a double-click must not fan out).
        for (const m of migrations.values()) {
          if (m.srcHost === key && m.srcSessionId === sessionId &&
              (m.phase === "exporting" || m.phase === "importing")) {
            return json(res, 409, { error: "this session is already being moved" });
          }
        }
        const m = startMigration(key, s, target);
        return json(res, 200, { ok: true, migrationId: m.id });
      }
      // POST /api/agents/<host>/sessions/<id>/uploads?name=<filename> -> stage a
      // file the operator attached in the composer (XERK-234). Body is the raw
      // bytes (no multipart: every client already has the file as a blob, and a
      // parser here would be one more thing to get wrong). The reply's uploadId
      // is what the following /input carries; nothing reaches the session until
      // that message is sent, so an attachment the operator removes just expires.
      if (req.method === "POST" && parts.length === 6 && parts[5] === "uploads") {
        const cap = uploadCapFor(agents[key]);
        if (!cap)
          return json(res, 409, {
            error: "this host's agent is too old to take file attachments — update it",
          });
        sweepUploads();
        let bytes;
        try {
          bytes = await readRawBody(req, cap);
        } catch {
          return json(res, 413, {
            error: `file too large — the limit is ${cap.toLocaleString("en-US")} bytes`,
            limit: cap,
          });
        }
        if (!bytes.length) return json(res, 400, { error: "empty file" });
        // Refuse rather than evict: the blobs already held belong to messages
        // someone is still composing, and dropping one of those would fail a
        // send that looked ready.
        if (uploadsHeldBytes() + bytes.length > UPLOAD_TOTAL_MAX_BYTES)
          return json(res, 503, { error: "the hub is holding too many pending uploads — try again shortly" });
        const id = crypto.randomBytes(12).toString("hex");
        const name = safeUploadName(url.searchParams.get("name") || "");
        uploads.set(id, {
          id, host: key, sessionId, name, size: bytes.length, bytes, at: Date.now(),
        });
        return json(res, 200, { ok: true, uploadId: id, name, size: bytes.length });
      }
      // POST /api/agents/<host>/sessions/<id>/input -> forward free-text input
      // to a running session (typing a message into the session). Body: {text},
      // plus optional {uploadIds} naming files staged above — the agent writes
      // each to disk on its host and prefixes their paths onto the message, so a
      // message can be attachments alone with no text of its own.
      if (req.method === "POST" && parts.length === 6 && parts[5] === "input") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const text = typeof body.text === "string" ? body.text : "";
        sweepUploads();
        const wanted = Array.isArray(body.uploadIds)
          ? body.uploadIds.filter((s) => typeof s === "string" && s)
          : [];
        if (wanted.length > UPLOAD_MAX_PER_MESSAGE)
          return json(res, 400, { error: `at most ${UPLOAD_MAX_PER_MESSAGE} attachments per message` });
        const attached = [];
        for (const id of wanted) {
          const u = uploads.get(id);
          // A stale id is the TTL having passed (or another hub having served
          // the upload). Refusing beats sending the text with the files silently
          // missing — the operator re-attaches and sends again.
          if (!u || u.host !== key || u.sessionId !== sessionId)
            return json(res, 404, { error: "an attachment expired before it was sent — re-attach it" });
          attached.push({ id: u.id, name: u.name, size: u.size });
        }
        if (!text.trim() && !attached.length) return json(res, 400, { error: "text required" });
        // Capped at what THIS host will deliver whole (see inputCapFor): an
        // agent that would clip the message instead gets refused here, so the
        // operator sees "too long" rather than a session that received a stub.
        const cap = inputCapFor(agents[key]);
        if (text.length > cap)
          return json(res, 413, {
            error: `message too long — ${text.length.toLocaleString("en-US")} characters, ` +
              `the limit is ${cap.toLocaleString("en-US")}`,
            limit: cap,
          });
        const cmd = { type: "input", sessionId, text };
        if (attached.length) cmd.uploads = attached;
        const cmdId = queueCommand(key, cmd);
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
        // A session on the self-hosted model takes its model from the host
        // configuration; the agent refuses this and every alias the picker could
        // offer is one the gateway rejects. Refuse here too, so the mirror case
        // of /model-source's 409 is not a silent 200 for an out-of-parity client.
        if (sessionModelSource(key, sessionId) === "local") {
          return json(res, 409, { error: "session runs on the self-hosted model" });
        }
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
      // POST /api/agents/<host>/sessions/<id>/model-source -> move a RUNNING
      // session between the subscription login and this host's self-hosted
      // model (XERK-246), keeping its conversation. This is the failover for
      // Claude usage running out, which otherwise stops every session at once.
      // Gated on the host reporting localModel.available: an agent that cannot
      // do it would ack the command and silently drop it, so refusing here is
      // what makes the button honest.
      if (req.method === "POST" && parts.length === 6 && parts[5] === "model-source") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const modelSource = typeof body.modelSource === "string" ? body.modelSource : "";
        if (!["subscription", "local"].includes(modelSource)) {
          return json(res, 400, { error: "modelSource must be subscription or local" });
        }
        if (modelSource === "local" && !localModelAvailable(agents[key])) {
          return json(res, 409, { error: "host has no local model configured" });
        }
        const cmdId = queueCommand(key, { type: "setModelSource", sessionId, modelSource });
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
        // The chat composer routes to this endpoint whenever a question is
        // pending, so a pasted answer meets the same per-host cap a typed
        // message does (XERK-227) — an older agent clips it just the same.
        const answerCap = inputCapFor(agents[key]);
        if (custom.length > answerCap)
          return json(res, 413, {
            error: `answer too long — ${custom.length.toLocaleString("en-US")} characters, ` +
              `the limit is ${answerCap.toLocaleString("en-US")}`,
            limit: answerCap,
          });
        const cmd = { type: "answerQuestion", sessionId, optionIndex };
        if (optionIndices && optionIndices.length) cmd.optionIndices = optionIndices;
        if (custom) cmd.custom = custom;
        const cmdId = queueCommand(key, cmd);
        return json(res, 200, { ok: true, cmdId });
      }
      // POST /api/agents/<host>/sessions/<id>/pane-prompt -> answer the blocking
      // choice dialog the session's TUI is showing (a tool-permission request or
      // a plan approval, reported as session.panePrompt). Body: {optionNumber},
      // the 1-based number the dialog itself displays — the agent types that
      // digit, and re-reads the pane first so a click made against a stale beat
      // is dropped rather than typed into a live composer.
      if (req.method === "POST" && parts.length === 6 && parts[5] === "pane-prompt") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const optionNumber = Number.isInteger(body.optionNumber) ? body.optionNumber : 0;
        if (optionNumber < 1 || optionNumber > 9) {
          return json(res, 400, { error: "optionNumber 1-9 required" });
        }
        const cmdId = queueCommand(key, { type: "answerPanePrompt", sessionId, optionNumber });
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

    // GET /api/jira/<siteKey>/create-meta[?project=<p>] -> the New-ticket form's
    // choices (XERK-137). Without ?project: the org's project list + existing
    // labels to suggest. With ?project: that project's creatable issue/work-item
    // types. Routes to an ONLINE host reporting the org (the metadata is a live
    // tracker fetch), rides the same {command -> staged result -> poll} path as
    // the issue detail above, and is served from cache when fresh. Placed ahead
    // of the <issueKey> route so "create-meta" isn't rejected as a bad key.
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 4 && parts[3] === "create-meta") {
      const siteKey = decodeURIComponent(parts[2]);
      const project = (url.searchParams.get("project") || "").trim();
      const key = findJiraHost(siteKey, true);
      if (!key) {
        return findJiraHost(siteKey, false)
          ? json(res, 503, { error: "no online host reports that org" })
          : json(res, 404, { error: "no host reports that org" });
      }
      const a = agents[key];
      const cached = project
        ? (a.createTypes || {})[project]
        : a.createMeta;
      if (cached && Date.now() - cached.fetchedAt < CREATE_META_FRESH_MS) {
        if (cached.error) return json(res, 200, { error: cached.error });
        return json(res, 200, project
          ? { types: cached.types }
          : { projects: cached.projects, labels: cached.labels, source: cached.source });
      }
      // An agent that has already proved it doesn't implement this command would
      // ack the next one just as silently, so say so instead of 202-ing until
      // the client times out (XERK-151). Errors ride a 200 here, as a cached
      // fetch error does — that's the shape both clients read the message from.
      const gap = agentGapError(a, "boardCreateMeta", "offer the New-ticket options");
      if (gap) return json(res, 200, { error: gap });
      // Single-flight: reuse an already-queued fetch for the same (project|meta).
      const pending = (a.commands || []).find(
        (c) => c.type === "boardCreateMeta" && (c.project || "") === project);
      const cmdId = pending
        ? pending.cmdId
        : queueCommand(key, { type: "boardCreateMeta", ...(project ? { project } : {}) });
      if (!pending) awaitResult(a, cmdId, "boardCreateMeta", project ? { project } : null);
      return json(res, 202, { pending: true, cmdId });
    }

    // POST /api/jira/<siteKey>/tickets -> create a new ticket on the org's board
    // (XERK-137). Body: {project, issueType, summary, description?, labels?[]}.
    //
    // The board's first WRITE path to the tracker. Like the /session route the
    // hub's job is ROUTING: the create runs agent-side (only the host holds the
    // tracker creds), so this validates the inputs, routes to an ONLINE host
    // reporting the org, and queues the create command. The agent creates the
    // issue and stages the outcome keyed by this command's cmdId, which the
    // client polls back at GET /api/jira/<siteKey>/tickets/<cmdId>.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 4 && parts[3] === "tickets") {
      const siteKey = decodeURIComponent(parts[2]);
      const body = JSON.parse((await readBody(req)) || "{}");
      const summary = typeof body.summary === "string" ? body.summary.trim() : "";
      const project = typeof body.project === "string" ? body.project.trim() : "";
      const issueType = typeof body.issueType === "string" ? body.issueType.trim() : "";
      const description = typeof body.description === "string" ? body.description : "";
      const labels = Array.isArray(body.labels)
        ? body.labels.filter((l) => typeof l === "string" && l.trim())
            .map((l) => l.trim()).slice(0, 20)
        : [];
      if (!summary) return json(res, 400, { error: "a title is required" });
      if (!project) return json(res, 400, { error: "a project is required" });
      if (!issueType) return json(res, 400, { error: "an issue type is required" });
      // Single-flight an identical create that's still IN FLIGHT anywhere in the
      // org (XERK-241): the reported failure had the operator retrying a create
      // that was in fact succeeding, ending with four copies of one ticket. A
      // retry of the same (project, type, title) while the first has no outcome
      // yet is a retry, not a second ticket, so it rejoins the first cmdId. Once
      // that create RESOLVES, an identical one is a new ticket again — deliberate
      // repeats stay possible.
      const fields = [siteKey, project, issueType, summary, description, labels];
      const inFlight = findCreateInFlight(...fields);
      if (inFlight) return json(res, 200, { ok: true, cmdId: inFlight.cmdId, host: inFlight.host });
      const key = pickBoardWriteHost(siteKey, "createTicket");
      if (!key) {
        return findJiraHost(siteKey, false)
          ? json(res, 503, { error: "no online host reports that org" })
          : json(res, 404, { error: "no host reports that org" });
      }
      // Refuse rather than queue a create this agent can't run (XERK-151); the
      // client would otherwise poll the outcome until it timed out.
      const gap = agentGapError(agents[key], "createTicket", "create tickets");
      if (gap) return json(res, 409, { error: gap });
      const cmdId = queueCommand(key, {
        type: "createTicket", project, issueType, summary, description, labels,
      });
      awaitResult(agents[key], cmdId, "createTicket");
      rememberCmdHost(cmdId, key, "createTicket");
      rememberCreateInFlight(fields, cmdId, key);
      return json(res, 200, { ok: true, cmdId, host: key });
    }

    // GET /api/jira/<siteKey>/tickets/<cmdId> -> poll a create's outcome
    // (XERK-137). Searches every host reporting the org for the create result
    // (the create was routed to one, but which one is the client's to not know):
    // 200 with {key,url} on success, 200 with {error} on a create failure, 202
    // while the agent hasn't reported the outcome yet.
    //
    // The "gave up" verdict is the one thing that must NOT be answered by just
    // any host of the org (XERK-241): only the host that actually took this
    // create can say it died holding it. Reading a sibling's liveness instead
    // reported a perfectly healthy create as failed for every org with an
    // offline second host — and the retries it invited each made another ticket.
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 5 && parts[3] === "tickets") {
      const siteKey = decodeURIComponent(parts[2]);
      const cmdId = decodeURIComponent(parts[4]);
      let found = null, anyHost = null;
      for (const [k, a] of Object.entries(agents)) {
        if (!a.jira || a.jira.siteKey !== siteKey) continue;
        anyHost = anyHost || k;
        const r = (a.createResults || {})[cmdId];
        if (r) { found = r; break; }
      }
      if (!anyHost) return json(res, 404, { error: "no host reports that org" });
      if (found) {
        return json(res, 200, found.error
          ? { error: found.error }
          : { key: found.key, url: found.url, warning: found.warning || null });
      }
      // Unowned (a hub restart lost the mapping, or a cmdId that was never ours)
      // stays pending: an unanswerable poll times out client-side, which is far
      // cheaper than a wrong failure the operator answers by retrying.
      const owner = commandHost(siteKey, cmdId, "createTicket", "createResults");
      if (owner && Date.now() - (agents[owner].lastSeen || 0) >= OFFLINE_AFTER_MS) {
        // Telling the operator a create failed invites them to make the ticket
        // again, so the wording has to match what the hub can actually prove.
        // Never having handed the command over proves no ticket exists; once
        // delivered the hub cannot know, because the agent may have created it
        // and died before acking. Claiming otherwise is what turns one intent
        // into two tickets, so say which of the two this is and, when it is the
        // unknowable one, send them to look before remaking it.
        const nothingRan = !commandDelivered(owner, cmdId, "createTicket");
        dropQueuedCommand(owner, cmdId, "createTicket");
        forgetCreateInFlight(cmdId);
        return json(res, 503, { error: nothingRan
          ? "the host went offline before the ticket was created"
          : "the host went silent while creating the ticket — it may have been created, "
            + "so check the board before making it again" });
      }
      return json(res, 202, { pending: true });
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
      //
      // Which offline host, though, is decided by WHO HOLDS A COPY, not by the
      // ranking — health says something about a host that can still be asked
      // and nothing about one that can't, so ranking alone would hand back a
      // healthier-looking host with no cache and lose an answer we have.
      let key = findJiraHost(siteKey, false);
      if (!key) return json(res, 404, { error: "no host reports that Jira org" });
      if (Date.now() - (agents[key].lastSeen || 0) >= OFFLINE_AFTER_MS &&
          !(agents[key].jiraIssues || {})[issueKey]) {
        key = jiraHostPool(siteKey, false)
          .find((k) => (agents[k].jiraIssues || {})[issueKey]) || key;
      }
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

    // POST /api/jira/<siteKey>/<issueKey>/status — change a ticket's status and
    // push it to the board (XERK-138). Body is one of:
    //   {value}    — the transition id (Jira) / state name (Azure) the operator
    //                picked from the detail's statusOptions (the panel picker);
    //   {category} — the board COLUMN a card was dropped onto (XERK-141:
    //                todo/inprogress/review/done), which the agent resolves to a
    //                transition against a fresh read of the available options.
    // A drag carries the column rather than a transition id because the board
    // card never loaded the ticket's transitions — only the detail panel does.
    //
    // This is the ONE thing Turma writes back to a board, so unlike the read-only
    // ticket GET it REQUIRES an online host: a queued write sitting on a sleeping
    // agent would land whenever it woke — a surprise, not a feature. The hub's
    // job is only routing + delivery; the agent re-reads the available options
    // and applies only a target still on offer, so `value` is passed through
    // (checked as a non-empty string) rather than allowlisted here — the board's
    // own workflow, not this endpoint, decides what a ticket can move to.
    //
    // The outcome rides back on the heartbeat keyed by the queued cmdId; the
    // client polls the GET below for it. Single-flight per ticket, like the
    // spawnTicket route: a double-click must not fire two changes.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 5 && parts[4] === "status") {
      const siteKey = decodeURIComponent(parts[2]);
      const issueKey = decodeURIComponent(parts[3]);
      if (!isIssueKey(issueKey)) {
        return json(res, 400, { error: "not a valid issue key" });
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      const value = typeof body.value === "string" ? body.value.trim() : "";
      const category = typeof body.category === "string" ? body.category.trim() : "";
      if (!value && !category) return json(res, 400, { error: "body needs {value} or {category}" });
      if (!findJiraHost(siteKey, false)) {
        return json(res, 404, { error: "no host reports that org" });
      }
      // The single-flight spans the org's ONLINE hosts, not just the one this
      // click would pick (XERK-241). Which host answers can move between two
      // clicks — a health flip is enough — so searching only the current host's
      // queue would miss the change already queued on a sibling and fire a
      // second transition on the same ticket.
      //
      // Online, though: a command queued on a host that then died sits in its
      // queue for as long as the record lives (days), and reusing THAT cmdId
      // would answer every later change for this ticket with a command nothing
      // will ever run. A pending change is only "pending" on a host that can
      // still run it.
      for (const k of jiraHostPool(siteKey, true)) {
        const p = (agents[k].commands || [])
          .find((c) => c.type === "setTicketStatus" && c.issueKey === issueKey);
        if (p) return json(res, 202, { ok: true, cmdId: p.cmdId, host: k });
      }
      const key = pickBoardWriteHost(siteKey, "setTicketStatus");
      if (!key) return json(res, 503, { error: "no online host reports that org" });
      // Same refusal as the create route: an agent predating XERK-138 acks this
      // and stages nothing, which the panel/drag would poll out to a timeout.
      const gap = agentGapError(agents[key], "setTicketStatus", "change a ticket's status");
      if (gap) return json(res, 409, { error: gap });
      const cmdId = queueCommand(key, { type: "setTicketStatus", issueKey, value, category });
      awaitResult(agents[key], cmdId, "setTicketStatus");
      rememberCmdHost(cmdId, key, "setTicketStatus");
      return json(res, 202, { ok: true, cmdId, host: key });
    }

    // GET /api/jira/<siteKey>/<issueKey>/status?cmdId=<id> — poll the outcome of
    // a status change queued by the POST above (XERK-138). {pending:true} until
    // the agent's heartbeat carries the result for that cmdId, then {ok, error,
    // status, statusCategory}. Keyed by cmdId so it answers the specific change
    // the client made, not a stale prior one on the same ticket.
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 5 && parts[4] === "status") {
      const siteKey = decodeURIComponent(parts[2]);
      const issueKey = decodeURIComponent(parts[3]);
      if (!isIssueKey(issueKey)) {
        return json(res, 400, { error: "not a valid issue key" });
      }
      const cmdId = url.searchParams.get("cmdId");
      if (!cmdId) return json(res, 400, { error: "cmdId required" });
      // The outcome is on the host that RAN the change, which in a multi-agent
      // org needn't be the one this poll would otherwise land on (XERK-241) —
      // e.g. the host that took it went offline, or its tracker poll started
      // failing, and the ranking has since moved on to a sibling that never saw
      // the command and would report pending forever.
      const key = commandHost(siteKey, cmdId, "setTicketStatus", "statusResults")
        || findJiraHost(siteKey, false);
      if (!key) return json(res, 404, { error: "no host reports that org" });
      const r = (agents[key].statusResults || {})[cmdId];
      if (!r) return json(res, 200, { pending: true });
      return json(res, 200, {
        ok: r.ok, error: r.error, status: r.status,
        statusCategory: r.statusCategory,
      });
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
      // The operator's model pin (XERK-123) rides the command the hub already
      // routes — the agent has no per-ticket ledger of its own to read it from.
      // Omitted when unpinned, so a ticket with no model choice spawns exactly as
      // it always did (the agent's default model).
      const mpin = ticketModelPin(siteKey, issueKey);
      const cmdId = pending ? pending.cmdId
        : queueCommand(host, { type: "spawnTicket", issueKey,
            ...(mpin ? { model: mpin.model } : {}) });
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

    // POST /api/jira/<siteKey>/<issueKey>/model — pin which MODEL this ticket's
    // session runs with (XERK-123). Body: {model:"<alias>"} to pin, {auto:true}
    // (or {model:"default"}) to release back to the login's default model.
    //
    // Hub-owned durable state exactly like the /agent pin: the model is carried
    // on the spawnTicket command the hub routes, so this is authoritative the
    // moment it returns (a 200, not a queued 202). The alias must be one the
    // org's hosts actually offer — the same allowlist the composer's model menu
    // is built from — so the pin can't name a model no session could run; the
    // agent still re-validates it host-side (resolve_model) before launch.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 5 && parts[4] === "model") {
      const siteKey = decodeURIComponent(parts[2]);
      const issueKey = decodeURIComponent(parts[3]);
      if (!isIssueKey(issueKey)) {
        return json(res, 400, { error: "not a valid issue key" });
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      // Reject a non-string `model` FIRST. Coercing it to "" made `auto` true,
      // so {model:12345} silently RELEASED an existing pin and answered 200 —
      // the opposite of what the caller asked for (XERK-235).
      if (body.model != null && typeof body.model !== "string") {
        return json(res, 400, { error: "body needs {model} or {auto:true}" });
      }
      const raw = typeof body.model === "string" ? body.model.trim().toLowerCase() : "";
      // "default" is the release value in model's clothing — treat it as {auto},
      // so the picker's "Default" option and an explicit {auto:true} land the same
      // "drop the pin" outcome rather than storing a "default" alias to resolve.
      const auto = body.auto === true || raw === "default" || raw === "";
      if (!Object.values(agents).some(
        (a) => a && a.jira && a.jira.siteKey === siteKey)) {
        return json(res, 404, { error: "no host reports that Jira org" });
      }
      if (!auto && !orgModelAliases(siteKey).has(raw)) {
        return json(res, 400, { error: "that model is not offered by this org" });
      }
      setTicketModel(siteKey, issueKey, auto ? null : raw);
      return json(res, 200, { ok: true, model: auto ? null : raw });
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

    // POST /api/jira/<siteKey>/color — pin an org's palette color (XERK-145).
    // Body: {slot: 1..8} to pin, {auto:true} to release back to the
    // hash-assigned color. Hub-owned durable state like /autostart: the save is
    // authoritative on return, the org must be one the fleet reports (no
    // phantom orgs), and the host need not be online (a color is a persistent
    // presentation choice, nothing rides a heartbeat).
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 4 && parts[3] === "color") {
      const siteKey = decodeURIComponent(parts[2]);
      const body = JSON.parse((await readBody(req)) || "{}");
      const auto = body.auto === true;
      if (!auto && !(Number.isInteger(body.slot) && body.slot >= 1 && body.slot <= ORG_COLOR_SLOTS)) {
        return json(res, 400, { error: `body needs {slot:1..${ORG_COLOR_SLOTS}} or {auto:true}` });
      }
      if (!Object.values(agents).some(
        (a) => a && a.jira && a.jira.siteKey === siteKey)) {
        return json(res, 404, { error: "no host reports that Jira org" });
      }
      setOrgColor(siteKey, auto ? null : body.slot);
      return json(res, 200, { ok: true, slot: auto ? null : body.slot });
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
    // An oversized body must come back as a status the caller can branch on.
    // The socket is still open here precisely because readBody drained instead
    // of destroying it (XERK-235).
    if (err && err.tooLarge) {
      if (!res.writableEnded) json(res, 413, { error: "body too large", limit: err.cap });
      return;
    }
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
        // `agents` = the session's live agent list, which outlives the turn
        // (a background agent keeps running after the main one stops), so it
        // rides beside `status` rather than inside it; absent from agents
        // predating it, and the chat then falls back to `status.agents`.
        liveFanout(name, msg.turn, { type: "turn", text: msg.text, status: msg.status || null,
          agents: sanitizeLiveAgents(msg.agents) });
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
    // The create single-flight's backstop, exported so a test can hold the
    // PRODUCTION default rather than the wound-down one the suite runs with —
    // its value relative to the client's give-up is the whole point (XERK-241).
    CREATE_INFLIGHT_TTL_DEFAULT_MS,
    // Exported so its type guard can be held directly: the routes above are
    // type-scoped before they ever call it, which leaves this last check —
    // the one standing between a stray cmdId and a deleted command — with no
    // reachable path through the HTTP surface (XERK-241).
    dropQueuedCommand,
    // In-memory by design, so a hub restart drops it and ownership falls back
    // to the fleet scan. Exported so a test can stage exactly that (XERK-241).
    cmdHosts,
    // The heartbeat field allowlist. Exported so a test can hold the capability
    // flags in it directly: dropping `localModel` would make the failover
    // control vanish fleet-wide with every suite still green (XERK-246).
    HEARTBEAT_KNOWN_KEYS,
    invalidateAgentsCache,
    serializeAgentsForSave,
    // XERK-235 heartbeat/record bounds — a QA pass removed each of these
    // and the suite stayed green, so they are exported to be pinned.
    sanitizeHeartbeat, agentRecordSize, safeAgentsCache,
    HEARTBEAT_UNKNOWN_MAX, AGENT_RECORD_MAX,

    queueCommand,
    findSession,
    wsAccept,
    wsEncode,
    wsParser,
    channelDuplex,
    heartbeatAlerts,
    prAlertDecision,
    readyForReview,
    sessionWorking,
    hasLiveAgents,
    sanitizeLiveAgents,
    safeUploadName,
    uploadCapFor,
    uploads,
    UPLOAD_MAX_PER_MESSAGE,
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
    orgColors,
    setOrgColor,
    ticketAgents,
    ticketModels,
    ticketModelPin,
    setTicketModel,
    orgModelAliases,
    findTicketHost,
    migrations,
    advanceMigrations,
    siteKeyOf,
  };
} else {
  if (!TURMA_PASSWORD) console.warn("WARNING: TURMA_USER/TURMA_PASSWORD not set — UI is unauthenticated");
  if (!TURMA_AGENT_TOKEN) console.warn("WARNING: TURMA_AGENT_TOKEN not set — heartbeat and tunnel endpoints are unauthenticated");
  if (!TURMA_TRIGGER_TOKEN) console.warn("WARNING: TURMA_TRIGGER_TOKEN not set — POST /api/trigger accepts only the user login (no dedicated token)");
  server.listen(PORT, () => {
    console.log(`turma listening on :${PORT}`);
    if (push.fcmEnabled()) console.log("FCM push alerts -> Android devices");
    // A warning, not an info line: a hub running without FCM delivers ZERO mobile
    // notifications (every notify() is a no-op), and that has silently bitten us
    // before (XERK-152). Loud enough to notice beside the other startup WARNINGs.
    else console.warn("WARNING: FCM push alerts disabled (FCM_SERVICE_ACCOUNT_JSON not set) — no mobile notifications will be sent");
    console.log(
      WHISPER_URL ? `whisper STT -> ${WHISPER_URL}` : "whisper STT disabled (LITELLM_URL/WHISPER_URL not set)"
    );
  });
}
