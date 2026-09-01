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
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Duplex } = require("stream");
// Only the archive's raw layer uses this (XERK-338): agents gzip a session's own
// bytes on the wire, and the hub gunzips them under a hard output bound.
const zlib = require("zlib");
// Durable, searchable archive of ended sessions (organized files on /data + a
// node:sqlite FTS index). See archive.js. Lazily opens its DB on first use, so
// requiring it is cheap and side-effect-free.
const archive = require("./archive.js");
const tar = require("./tar.js");
// Mobile push (FCM) fan-out for the alert bus. Lazily/gracefully no-ops when
// FCM_SERVICE_ACCOUNT_JSON is unset, so requiring it is side-effect-free.
const push = require("./push.js");
// Durable token-usage history (XERK-338): usage is an agent-derived aggregate
// that lived only on the registry record, so deleting/pruning a host threw it
// away and a wiped host overwrote its own past with near-zero. This keeps it on
// /data, keyed by host, and folds it back into what /api/agents serves. Reads
// its file at require time (like the other /data stores below).
const usageLedger = require("./usage-ledger.js");

const PORT = parseInt(process.env.PORT || "8300", 10);

// dsh (DeepSeek Harness runtime, XERK-460) fleet-wide KILL SWITCH. This is an
// in-CODE flag — deliberately not an env var or a build flag — that turns OFF all
// dsh functionality WITHOUT deleting any of the dsh machinery, so it can be flipped
// back on by editing one line. Set to DISABLED (false).
//
// The agent (Python) and Android each carry a SAME-NAMED flag, so no single
// component can re-enable dsh on its own — the hub still refuses to accept or
// advertise dsh here even if an agent reports the capability. (Glasses has no
// runtime-selection surface, so it carries no such flag.) It gates the two
// hub choke points every dsh decision funnels through: `dshAvailable` (server-side
// acceptance — spawn gate, org gate, ticket routing) and `normalizeDsh` (the wire
// coercion, so the served /api/agents payload never advertises dsh to any client).
let DSH_ENABLED = false;

// The qwen (Qwen Code, XERK-504) equivalent of DSH_ENABLED. Same in-CODE kill
// switch discipline: the agent (Python) and Android carry a SAME-named flag
// (glasses has no runtime-selection surface), so no single component can
// re-enable qwen on its own — the hub still
// refuses to accept or advertise qwen here even if an agent reports the
// capability. It gates the two hub choke points every qwen decision funnels
// through: `qwenAvailable` (server-side acceptance — the spawn gate) and
// `normalizeQwen` (the wire coercion, so the served /api/agents payload never
// advertises qwen to any client). [Qwen A] ships it false; [Qwen B] lifts it.
let QWEN_ENABLED = true; // [Qwen B] launcher + XERK-520 end-to-end gate verified qwen on real Qwen Code; still gated per-host by qwen_configured()

/**
 * The memory ceiling this process actually runs under — `containerMemoryLimit()`
 * when containerised (which is how it is deployed), else the host's RAM.
 *
 * Every memory ceiling in this file is a fraction of this rather than a fixed
 * number (XERK-258), so raising the container's `mem_limit` widens them all with
 * no code change, and a hub given LESS memory tightens itself instead of dying.
 * Declared here, at the top, because those ceilings sit beside the features they
 * bound and so are spread through the whole file. (`containerMemoryLimit` is
 * defined further down, next to the registry budget that shares it, and is
 * reachable here by hoisting.)
 *
 * It answers `null` when there is no limit to read, and a limit ABOVE real RAM
 * cannot be the binding constraint — both fall back to the host's memory, or the
 * derived ceilings come out absurd.
 */
const MEMORY_LIMIT =
  Number(process.env.MEMORY_LIMIT_BYTES) ||
  Math.min(containerMemoryLimit() || os.totalmem(), os.totalmem());
// One request may hold an eighth of the container; everything being read at once
// may hold a quarter. The gap between them is deliberate — it leaves room for the
// response, the parsed object (a JSON body costs several times its wire size once
// parsed) and the rest of the hub's working set. See chargeBody for how they are
// enforced and why a body arriving into an idle hub is admitted regardless.
//
// The PER-REQUEST ceiling only ever tightens: it is `min(what one request can
// legitimately need, what the container can hold)`. Deriving it purely from the
// limit would hand a hub on a 64 GB host an 8 GB single-body ceiling, which is
// not generosity — no caller has any business sending that, and the fixed
// number is the sanity bound. The TOTAL budget is the one that genuinely wants
// to widen with mem_limit, because that buys CONCURRENCY.
const BODY_INFLIGHT_ABSOLUTE_MAX = 32 << 20; // 32 MiB — the largest one body may be
const BODY_INFLIGHT_MAX =
  Number(process.env.BODY_INFLIGHT_MAX) ||
  Math.min(BODY_INFLIGHT_ABSOLUTE_MAX, Math.floor(MEMORY_LIMIT / 8));
// The ceiling on EVERYTHING being read at once, across BOTH lanes.
//
// It has to be one number covering both, because two independent ceilings have
// to be ADDED to know the worst case and nobody does that arithmetic when
// tuning one of them. That is not hypothetical: when the lanes were made
// genuinely independent, the real worst case silently became `shared + a whole
// big body` — the shared half having been sized back when a big body still
// consumed it — and the 256-concurrent-30 MiB flood started OOM-killing the hub
// that had survived it for four commits.
//
// Half the container, so that one max-size body (BODY_INFLIGHT_MAX at
// BODY_PARSE_COST, i.e. three quarters of this) plus the shared traffic beside
// it still leaves room for the response, the working set and the sockets.
const BODY_INFLIGHT_TOTAL_MAX =
  Number(process.env.BODY_INFLIGHT_TOTAL_MAX) || Math.floor(MEMORY_LIMIT / 2);

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
// Ticket -> runtime pins (XERK-473): which RUNTIME a ticket's session runs on —
// "claude" (the default) or "dsh" (XERK-460). Like the model pin this is
// hub-owned durable state on /data: the runtime is carried on the spawnTicket
// command as `agentType`, so the hub must remember it across a restart, and it
// also decides WHICH hosts the dispatch may route to — only a host that offers
// the dsh runtime can run a dsh-pinned ticket (findTicketHost). Only a non-default
// ("dsh") choice is stored; clearing (or "claude") releases back to the default.
const TICKET_RUNTIMES_FILE = process.env.TICKET_RUNTIMES_FILE || "/data/ticket-runtimes.json";
const TICKET_RUNTIMES_MAX = 500;
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
// Per-org triage policy (XERK-486 [F]): the knobs that govern WHAT an org's
// auto stream will start, now that the single on/off switch (autoStartOrgs) has
// become "policy enabled". siteKey -> {minPriority?, excludeTypes?, repoAllow?,
// repoDeny?, rateMax?}. minPriority: auto-start this band and higher (P0 > P1 >
// P2 > P3); excludeTypes: triage types never auto-started; repoAllow: only these
// repos auto-start (empty = any); repoDeny: these repos never auto-start (wins
// over allow); rateMax: per-org auto dispatches per rate window (defaults to
// TICKET_QUEUE_RATE_MAX). Hub-owned durable state like autostart-orgs.json:
// per-org, tiny, must survive a hub restart, rides the fleet payload + SSE.
const TRIAGE_POLICIES_FILE = process.env.TRIAGE_POLICIES_FILE || "/data/triage-policies.json";
// Per-ticket operator triage decision (XERK-486 [F]): "<siteKey>/<issueKey>" ->
// "approve" | "hold" | "reject". approve forces auto-start eligibility past the
// org policy and the model's triage gate; hold keeps the ticket out of the auto
// stream until released; reject drops it from the auto stream. Same key shape as
// the agent/model pins (ticketAgents / ticketModels): hub-owned durable state
// that must survive a restart, bounded like the other pin maps.
const TRIAGE_ACTIONS_FILE = process.env.TRIAGE_ACTIONS_FILE || "/data/triage-actions.json";
const TRIAGE_ACTIONS_MAX = 500;
const TRIAGE_ACTIONS = new Set(["approve", "hold", "reject"]);
// Per-org opt-in for triage priority write-back (XERK-483): when ON for an org,
// the hub's sweep queues a setTicketPriority command so the tracker's own
// priority field matches the triage band. Same hub-owned-durable rationale as
// the auto-start opt-in: per-org, tiny, must survive a hub restart.
const PRIORITY_WRITEBACK_ORGS_FILE =
  process.env.PRIORITY_WRITEBACK_ORGS_FILE || "/data/priority-writeback-orgs.json";
// Per-org opt-in for duplicate linking (XERK-484): when ON for an org, the
// hub's sweep queues a createDuplicateLink command so a ticket the classifier
// flagged triage.dedupeOf gets linked as a Jira Duplicate of its twin. Same
// hub-owned-durable rationale as the priority write-back opt-in above.
const DEDUPE_LINK_ORGS_FILE =
  process.env.DEDUPE_LINK_ORGS_FILE || "/data/dedupe-link-orgs.json";
// Manual org-color pins (XERK-145): siteKey -> palette slot 1..8, the operator's
// override of the hash-assigned org color. Hub-owned durable state like the
// auto-start opt-in (same reasons: per-org, tiny, must survive a restart, and
// shared by web + android through the fleet payload + its own SSE event).
const ORG_COLORS_FILE = process.env.ORG_COLORS_FILE || "/data/org-colors.json";
const ORG_COLOR_SLOTS = 8; // categorical palette --s1..--s8 (app.css / TurmaColors.series)
// Per-repo importance tiers (XERK-487): repo name -> "live"|"active"|"archive"|
// "ignore". Feeds triage ORDERING (a tiebreaker under XERK-480 [E]'s priority
// key) and POLICY ([F]'s allow/deny), and gates auto-start (ignore-tier repos
// never auto-start). Hub-owned durable state like the auto-start opt-in and org
// colors above — per-repo, tiny, and it must survive a restart, so it lives on
// the /data volume, not the best-effort state.json.
const REPO_TIERS_FILE = process.env.REPO_TIERS_FILE || "/data/repo-tiers.json";
// A one-shot boot seed (config-file to start, per the ticket): a JSON object of
// {repo: tier} applied only to repos the durable file does not already carry, so
// operator edits made through the API always win over the seed.
const REPO_TIER_SEED = process.env.REPO_TIER_SEED || "";
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
// Newest N entries served when scrollback comes from the hub's durable archive
// (a running session materializes there — see the /history route). The archive
// holds the WHOLE transcript; this bounds the payload to the same order of
// magnitude as an agent `/history` window (SESSION_HISTORY_MSGS defaults to 200).
const HISTORY_ARCHIVE_MSGS = Number(process.env.HISTORY_ARCHIVE_MSGS) || 200;
// Bounds for a session's live agent rows (sanitizeLiveAgents, far below). They
// live UP HERE, away from their function, because the state.json restore runs
// at module init and calls that function: a `const` declared later is in its
// temporal dead zone then, so reading one throws a ReferenceError that the
// restore's own `catch {}` swallows — the record loads half-coerced and says
// nothing. Any constant a restore-path function reads has to be declared above
// the restore.
const LIVE_AGENTS_MAX = 32;
const LIVE_AGENT_FIELD_MAX = 400;
const DSH_WEB_URL_MAX = 512;   // the host-wide dsh-web viewer URL, capped on the wire
// Up HERE with the live-agent caps rather than beside sanitizeWorkflowAgents
// where they are used, and that placement is LOAD-BEARING (XERK-304). The
// state.json restore calls normalizeRecord ~700 lines below this and ~1000
// lines ABOVE that function, so a `const` declared next to it sits in the
// temporal dead zone at restore time; the ReferenceError lands in the restore's
// own catch, which swallows everything and boots the hub with an EMPTY
// registry. The function itself hoists, so only its constants must live here.
// Same trap the comment above that restore loop warns about.
const WORKFLOW_AGENT_FIELD_MAX = 256;
const WORKFLOW_AGENTS_MAX = 200;
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

// Whether a host offers the dsh runtime (XERK-460) — the capability gate the
// composer's runtime selector is shown on, and the spawn route validates a
// `dsh` choice against. An ABSENT flag (a pre-dsh agent) means "cannot do it".
function dshAvailable(agent) {
  // The fleet-wide kill switch wins first: with dsh disabled no host offers it,
  // whatever it reports. This is the single decision function checkSpawnAgentType,
  // orgOffersDsh, findTicketHost and the spawn-eligibility loops all go through,
  // so gating it here disables server-side dsh acceptance everywhere at once.
  if (!DSH_ENABLED) return false;
  return Boolean(agent && agent.dsh && agent.dsh.available);
}

// Whether a host offers the qwen (Qwen Code, XERK-504) runtime — the qwen twin
// of dshAvailable. The capability gate the composer's runtime option is shown
// on, and the spawn route validates a `qwen` choice against. An ABSENT flag (a
// pre-qwen agent) means "cannot do it". The fleet-wide kill switch wins first,
// so with qwen disabled no host offers it whatever it reports.
function qwenAvailable(agent) {
  if (!QWEN_ENABLED) return false;
  return Boolean(agent && agent.qwen && agent.qwen.available);
}

// Whether `model` is one the host's discovered set serves (XERK-489) — the
// membership check that makes the dropdown honest, mirroring checkSpawnModelSource.
// An EMPTY set (older agent, or discovery not landed) cannot DISPROVE membership,
// so it accepts — the agent re-validates on launch and demotes if truly absent.
// Blank model = "use the host default", always fine.
function localModelServes(agent, model) {
  if (!model) return true;
  const lm = agent && agent.localModel;
  const list = (lm && Array.isArray(lm.models)) ? lm.models : [];
  if (!list.length) return true;
  return list.some((m) => m && m.id === model);
}

// Which model source a host reports for one of its sessions, "" when unknown.
function sessionModelSource(hostKey, sessionId) {
  const s = (agents[hostKey]?.sessions || []).find((x) => x.id === sessionId);
  return (s && s.modelSource) || "";
}

// The runtime a host reports for one of its sessions ("claude"|"dsh", "" when
// unknown / a pre-dsh agent that reads as claude).
function sessionAgentType(hostKey, sessionId) {
  const s = (agents[hostKey]?.sessions || []).find((x) => x.id === sessionId);
  return (s && s.agentType) || "";
}

// Does this host's dsh runtime serve `model`? Mirrors localModelServes — an
// empty discovered set can't refute (discovery may not have landed), so accept.
function dshServes(agent, model) {
  if (!model) return true;
  const d = agent && agent.dsh;
  const list = (d && Array.isArray(d.models)) ? d.models : [];
  if (!list.length) return true;
  return list.some((m) => m && m.id === model);
}

// Validate a spawn's optional modelSource the same way the switch route does.
// Returns null when fine, else {status, error}. Spawning onto the local model is
// how you start NEW work once usage is gone, so it gets the same enum check and
// the same capability gate rather than failing later as an errored session card.
function checkSpawnModelSource(cmd, hostKey) {
  // A named endpoint model (XERK-489) is charset-validated FIRST, even when the
  // caller omits modelSource — strict parity with the /model-source route, which
  // checks localModel regardless. Before this ran ahead of the modelSource==null
  // early-return, a bad localModel with no source was queued unchecked (inert on
  // the agent, but a silent inconsistency). Same charset gate as both switch
  // routes; endpoint ids carry ':'/'/'.
  if (cmd.localModel != null &&
      (typeof cmd.localModel !== "string" || cmd.localModel.length > 60 ||
       !/^[A-Za-z0-9._:/-]+$/.test(cmd.localModel))) {
    return { status: 400, error: "invalid localModel" };
  }
  if (cmd.modelSource == null) return null;
  if (!["subscription", "local"].includes(cmd.modelSource)) {
    return { status: 400, error: "modelSource must be subscription or local" };
  }
  if (cmd.modelSource === "local" && !localModelAvailable(agents[hostKey])) {
    return { status: 409, error: "host has no local model configured" };
  }
  // Membership is a LOCAL spawn concern only — an unserved model matters only
  // when this spawn is actually going onto the endpoint.
  if (cmd.localModel != null && cmd.modelSource === "local" &&
      !localModelServes(agents[hostKey], cmd.localModel)) {
    return { status: 409, error: "host does not serve that local model" };
  }
  return null;
}

// Same enum + capability gate for the runtime choice (XERK-460): a dsh spawn is
// refused for a host that does not offer dsh, so a stale composer's click gets a
// clear 409 rather than a session the host silently drops. The agent re-validates
// too (resolve_agent_type) — this is the hub half of that contract.
function checkSpawnAgentType(cmd, hostKey) {
  if (cmd.agentType == null) return null;
  if (!["claude", "dsh", "qwen"].includes(cmd.agentType)) {
    return { status: 400, error: "agentType must be claude, dsh or qwen" };
  }
  if (cmd.agentType === "dsh" && !dshAvailable(agents[hostKey])) {
    return { status: 409, error: "host does not offer the dsh runtime" };
  }
  if (cmd.agentType === "qwen" && !qwenAvailable(agents[hostKey])) {
    return { status: 409, error: "host does not offer the qwen runtime" };
  }
  return null;
}

// A repos-root session may not run under bypassPermissions (XERK-309): it works
// directly in REPOS_ROOT with no worktree, and under bypass a Bash redirect can
// write anywhere under the shared ~/.claude (the file-edit guard walks past
// Bash). The agent re-validates and errors the card, but refusing here gives the
// operator the hub's own message (XERK-264) instead of a silent errored session.
// Deliberately scoped to root: a worktree session may still choose bypass —
// closing that needs the filesystem/uid change the ticket weighs.
function checkSpawnPermissionMode(cmd) {
  // Trim before the compare so the hub agrees with the AGENT, which strips
  // whitespace before its enum check (resolve_permission_mode). Without this a
  // padded " bypassPermissions " on a root repo would 200 here and then land as
  // an errored session card instead of the clean 409 (XERK-264). Casing/other
  // non-enum spellings the agent rejects as "unknown mode" are not this gate's
  // job — the hub never validated the mode enum; it only owns the root+bypass
  // refusal, and that is the one value both sides must normalize identically.
  const mode = typeof cmd.permissionMode === "string" ? cmd.permissionMode.trim() : "";
  if (mode === "bypassPermissions" && cmd.repo === ROOT_REPO_NAME) {
    return {
      status: 409,
      error: "bypassPermissions is not allowed for a repos-root session",
    };
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
//
// A FRACTION OF THE CONTAINER LIMIT, like the in-flight body ceilings (XERK-258)
// — the flat 128 MiB this replaced was double the whole 256m the hub is deployed
// with, so the refusal could never fire before the OOM killer did. It tightens
// only: 128 MiB stays 128 MiB on a big host, and comes down to a quarter of the
// container on a small one.
//
// A SEPARATE budget from the in-flight quarter, deliberately: these blobs are
// held for MINUTES (UPLOAD_TTL_MS), not for the length of one request.
const UPLOAD_TOTAL_MAX_BYTES =
  Number(process.env.UPLOAD_TOTAL_MAX_BYTES) ||
  Math.min(1 << 27, Math.floor(MEMORY_LIMIT / 4));
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
// Per-host agent identity (XERK-268). TURMA_AGENT_TOKEN is the fleet MASTER; a
// host's own credential is derived from it and its host name, and each agent is
// given ONLY that derived value as its TURMA_TOKEN (DockerOps, per service —
// `node turma/server.js --agent-token <host>` prints one). The hub never needs a
// list of hosts or a token map: it re-derives the expected value for whatever
// host a request NAMES and compares.
//
// Why this exists: `<host>` in /api/agents/<host>/… and `device` on the
// heartbeat are values the CALLER types. With one shared token they proved
// nothing, so any token-holder could beat as another host, collect the commands
// queued for it (migration/upload ids ride there) and act as either half of a
// move. Deriving per host makes the host the CREDENTIAL's, not the caller's.
//
// A per-relay one-time secret was the other candidate and does not work: it
// would ride on exactly the commands an impersonated heartbeat hands out.
const TURMA_AGENT_STRICT = /^(1|true|yes|on)$/i.test(process.env.TURMA_AGENT_STRICT || "");
// A host's own agent token: `<base64url(host)>.<HMAC(master, host)>`.
//
// It NAMES the host it is for, and the HMAC is what makes that name unforgeable
// — so the hub can identify a caller from the token ALONE, before it has read a
// body or looked at a path. That is what lets `/api/heartbeat`, whose host is
// buried in its payload, refuse an unknown credential BEFORE reading 32 MiB
// (an HMAC cannot be inverted, so a bare digest could not be placed without
// already knowing the host, and the gate would have had to let anything
// through). The name half is not a secret: whoever holds the token is that
// host, and host names travel in the URL anyway.
//
// Keyed on the host name the agent reports as `device`, so a host RENAME
// invalidates its token by design — the hub cannot tell a rename from an
// impersonation, and guessing would be the bug.
function hostAgentToken(host) {
  // Non-strings never get a token: `String(host)` would coerce an array or a
  // toString()-carrying object into a host name and mint a REAL credential for
  // it. No caller passes one today; this is so none can start.
  if (!TURMA_AGENT_TOKEN || typeof host !== "string" || !host) return "";
  const name = Buffer.from(host);
  // A name that doesn't survive the UTF-8 round trip gets no token: a lone
  // surrogate encodes to the replacement character, so two different host names
  // would derive the SAME credential. No real host name does this — the point
  // is that the derivation is injective, not that anyone would hit it.
  if (name.toString() !== host) return "";
  // Nor a name the hub would refuse to register anyway (XERK-269): minting a
  // valid credential for an unusable host produces the worst outcome of all —
  // the agent renames ITSELF to its next naming source, the token no longer
  // matches, and the tunnel reconnect-loops forever without ever mentioning the
  // name. Refusing at mint time is where the operator can still act on it.
  if (!isPlainHostKey(host)) return "";
  return name.toString("base64url") + "." +
    crypto.createHmac("sha256", TURMA_AGENT_TOKEN).update(host).digest("hex");
}

// The host a bearer token proves it is, or null if it proves nothing. Reads the
// name off the token and re-derives to check it, so an attacker editing the name
// half invalidates the HMAC half.
function tokenHost(token) {
  if (!TURMA_AGENT_TOKEN || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  let host;
  try {
    host = Buffer.from(token.slice(0, dot), "base64url").toString();
  } catch {
    return null;
  }
  // Compare the WHOLE token, so a name that doesn't round-trip through base64url
  // (padding games, a different encoding of the same bytes) fails here rather
  // than resolving to a host it isn't the token for.
  return host && safeEqual(token, hostAgentToken(host)) ? host : null;
}
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
//
// Which token that IS is per host now (XERK-268), and the hub must send the one
// this host's ttyd was actually started with: its derived token if the host
// authenticates with it, the legacy master while it hasn't rolled over yet. We
// know which from how its own heartbeat authenticated (`tokenBound` on the
// record), so a half-rolled fleet keeps every terminal working rather than
// 401ing the hosts that haven't moved.
function ttydAuth(host) {
  const a = agents[host];
  const token = (a && a.tokenBound ? hostAgentToken(host) : TURMA_AGENT_TOKEN) || "changeme";
  return "Basic " + Buffer.from(`term:${token}`).toString("base64");
}

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

// ---- the registry's own ceiling (XERK-272) ---------------------------------
//
// Nothing capped how many DISTINCT `device` names the registry could hold, and
// every one of them is a retained record that also lands in state.json, every
// /api/agents body and every SSE frame. `prune()` only reclaims at seven days
// and AGENT_RECORD_MAX bounds ONE record, so 512 beats of 0.9 MiB under 512
// names OOM-killed a 256 MiB hub while the same 512 beats under ONE name peaked
// at 169 MiB. The per-record bound was never the aggregate.
//
// XERK-268 binds `device` to the credential, so this is no longer reachable by
// anyone holding the fleet token — but it does not BOUND anything: a
// compromised or buggy host still mints names under its own proved token, the
// `legacy` master a mid-rollover fleet accepts is not yet retired, and a host
// whose name derives from something unstable grows records with no attacker at
// all. The two are complementary; neither replaces the other.
//
// Two budgets, because they bound different things:
//   * AGENTS_TOTAL_MAX — the aggregate BYTES of every record, sized from the
//     container the hub actually runs in. A ceiling above the limit the kernel
//     kills on is not a ceiling (XERK-258), so this is derived from the cgroup
//     rather than picked.
//   * AGENTS_MAX — the record COUNT. The byte budget measures what
//     `agentRecordSize` measures, which deliberately EXCLUDES the on-demand
//     caches (history, subagent history, Jira issues, create results). Those are
//     capped per host by COUNT, not by bytes, so this bounds their multiple and
//     nothing here bounds their size — one host can still park a lot in them.
//
// The aggregate is what a NEWCOMER is admitted against, and what an OVER-SHARE
// host is refused against — never a host beating a normal-sized record, whose
// refusal would be indistinguishable from an outage. See AGENT_FAIR_SHARE.
//
// Both are env-overridable: an operator who grows the fleet past the cap should
// raise it in compose, not discover the hub silently dropping a host.

/**
 * A positive-integer env knob, or the default. A knob that silently accepts a
 * negative refuses the WHOLE fleet on its first beat with nothing but a
 * per-beat 429 to explain it, so a bad value is announced and ignored rather
 * than obeyed.
 */
function positiveEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  console.warn(`WARNING: ${name}=${JSON.stringify(raw)} is not a positive number — using ${fallback}`);
  return fallback;
}

// A host name is agent-supplied and reaches the hub's log; it is validated for
// length and prototype keys but NOT for content, so a newline in it forges a
// log line that reads exactly like one of the hub's own. Every log that names a
// host goes through this.
function logName(key) {
  // JSON.stringify does the line-forging half (a newline becomes the two
  // characters \ and n, so it can never start a line); the sweep after it
  // covers the control characters JSON leaves intact, which a terminal acts on.
  // C0, DEL **and C1** — JSON.stringify escapes none of the C1 block, and NEL
  // (U+0085) is a line break to some readers.
  return JSON.stringify(String(key).slice(0, 200))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

const AGENTS_MAX = positiveEnv("AGENTS_MAX", 64);
// How long a record must have gone unseen before the registry may reclaim its
// slot for a host it has never met. Deliberately far longer than
// OFFLINE_AFTER_MS: a record holds an offline host's last known sessions, PR
// chips and usage, so a host rebooting, updating, or off for the afternoon must
// never be displaced by a newcomer — a flood is refused instead. Only a host
// that has been gone long enough to be uninteresting is evictable.
const AGENT_EVICT_IDLE_MS = positiveEnv("AGENT_EVICT_IDLE_MS", 60 * 60 * 1000);

// The container's memory limit in bytes, or null when it cannot be read (not
// containerised, no cgroupfs, or explicitly unlimited). cgroup v2 first, then
// v1, whose "unlimited" is a near-2^63 sentinel rather than a word.
function containerMemoryLimit() {
  for (const p of ["/sys/fs/cgroup/memory.max",
                   "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    let raw;
    try { raw = fs.readFileSync(p, "utf8").trim(); } catch { continue; }
    if (raw === "max") continue;
    const n = Number(raw);
    // 2 ** 40, not `1 << 40` — JS bitwise is 32-bit and would wrap to 0.
    if (Number.isFinite(n) && n > 0 && n < 2 ** 40) return n;
  }
  return null;
}

// An eighth of the container, clamped. The deployed hub is `mem_limit: 256m`,
// so that is 32 MiB retained — against a measured real fleet whose LARGEST
// record is 0.30 MiB, i.e. ~100 hosts of headroom. The eighth is what leaves
// room for the copies the registry implies: the memoized /api/agents body, the
// state.json blob the save timer builds, and the per-record SSE frames all
// materialize alongside it.
function defaultRegistryBudget() {
  const limit = containerMemoryLimit();
  if (!limit) return 32 << 20;
  return Math.max(8 << 20, Math.min(64 << 20, Math.floor(limit / 8)));
}
const AGENTS_TOTAL_MAX = positiveEnv("AGENTS_TOTAL_MAX", defaultRegistryBudget());

// One host's share of the aggregate — 512 KiB at the deployed sizing, against a
// measured real fleet whose LARGEST record is 0.30 MiB.
//
// This is what keeps a full registry from reading as an outage. The aggregate
// gate refuses whoever happens to beat next, and rolling a known host back to
// its previous record rolls back its `lastSeen` too — so under sustained
// pressure a live host is refused on every beat and crosses OFFLINE_AFTER_MS
// while it is up, silently, with no way for the operator to tell that from a
// network failure. A host inside its share is never the reason the registry is
// full, so it is never the one that pays: the refusal lands on the host whose
// record is over its share, which is also the host the operator needs named.
//
// The cost is a bounded overshoot rather than a hard total: fat records are
// still admitted only while the aggregate has slack, and every host inside its
// share sums to at most AGENTS_TOTAL_MAX again — so worst-case retained is
// exactly AGENTS_TOTAL_MAX + AGENTS_MAX * AGENT_FAIR_SHARE, i.e. 2x the budget
// (a quarter of the container at the deployed sizing), not the unbounded growth
// this replaces.
//
// **That identity is the whole bound, so the share is DERIVED and never
// floored.** A floor under it (there was a 64 KiB one) makes the second term
// `AGENTS_MAX * 64 KiB`, which is unbounded in AGENTS_MAX — and raising
// AGENTS_MAX is exactly what an operator with a growing fleet is told to do.
// At AGENTS_MAX=2000 against the deployed 32 MiB budget that is 3.9x, and the
// hub is OOM-killed. Raising the count means raising the budget with it; the
// boot check below says so rather than letting the two contradict silently.
//
// A function, not an expression, so the extremes are reachable to a test
// without a whole process pinned to a degenerate config: the interesting cases
// (a count past the budget in BYTES, a count of one) are exactly the ones a
// realistic rig never reaches.
function fairShare(total, max) {
  return Math.max(1, Math.floor(total / max));
}
const AGENT_FAIR_SHARE = fairShare(AGENTS_TOTAL_MAX, AGENTS_MAX);
// A share this small means the count cap and the byte budget disagree about how
// big a fleet this hub is for: hosts would be refused on size long before the
// slots ran out. The memory bound still holds — it is the CONFIGURATION that is
// wrong, so this warns rather than adjusting either number, and it warns HERE
// (module scope) rather than in the listen banner, so it is reachable to a test
// and to anything that loads the module without binding a port.
const AGENT_SHARE_SANE_MIN = 64 << 10;
if (AGENT_FAIR_SHARE < AGENT_SHARE_SANE_MIN) {
  console.warn(
    `WARNING: AGENTS_MAX=${AGENTS_MAX} leaves each host only ${AGENT_FAIR_SHARE} ` +
      `bytes of the ${AGENTS_TOTAL_MAX}-byte registry budget — hosts will be ` +
      `refused on record size long before the slots run out. Raise ` +
      `AGENTS_TOTAL_MAX alongside AGENTS_MAX.`
  );
}

// The most state.json may be before the restore refuses to open it at all. Sized
// like the registry budget and generously above it, because the saved blob
// carries the on-demand caches the budget deliberately excludes; the point is
// to catch a file that cannot fit in the container's memory, not to second-guess
// a legitimate one. See the restore for why measuring beats parsing.
const STATE_FILE_MAX = positiveEnv(
  "STATE_FILE_MAX",
  (() => {
    const limit = containerMemoryLimit();
    if (!limit) return 64 << 20;
    return Math.max(32 << 20, Math.min(128 << 20, Math.floor(limit / 4)));
  })()
);

// The cache keys `serializeAgent` strips; see AGENT_RECORD_MAX.
//
// Declared UP HERE, above the state.json restore, for the reason LIVE_AGENTS_MAX
// documents: the restore runs at module init and enforces the budget below, so
// every constant that path reads has to exist by then or the `const` is in its
// temporal dead zone and the restore's own `catch {}` swallows the throw.
const AGENT_CACHE_KEYS = [
  "history", "subagentHistory", "jiraIssues", "statusResults",
  "priorityResults", "linkResults",
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

// Last measured size per host, so the aggregate costs a sum over numbers rather
// than re-serializing the whole registry on every beat. A side map, not a field
// on the record: anything stored on the record is served to every client.
const recordBytes = new Map();

// Which hosts are already over half their share, so that warning fires on the
// crossing rather than on every beat — same discipline as recordSizeWarned.
const shareWarned = new Map();

// The aggregate `agentRecordSize` of the whole registry. Measures lazily for a
// key it has not seen (the state.json restore, and the tests, install records
// without going through the heartbeat) and forgets keys that are gone, so it
// stays correct without every `delete agents[key]` site having to remember it.
function registryBytes() {
  let total = 0;
  for (const [key, a] of Object.entries(agents)) {
    let n = recordBytes.get(key);
    if (n === undefined) recordBytes.set(key, (n = agentRecordSize(a)));
    total += n;
  }
  if (recordBytes.size > Object.keys(agents).length) {
    for (const key of recordBytes.keys()) {
      if (!Object.prototype.hasOwnProperty.call(agents, key)) recordBytes.delete(key);
    }
  }
  return total;
}

// A refusal is one line per window, not one per beat: a flood is exactly the
// traffic that triggers it, so an unthrottled log turns a survived attack into
// disk pressure. The suppressed count rides the next line so nothing is hidden.
const REFUSED_LOG_EVERY_MS = 60 * 1000;
let refusedLogAt = 0;
let refusedSinceLog = 0;
// The usage-coercion throttle (XERK-306), declared here rather than beside
// logUsageCoercion for the reason that comment gives: `loadState`'s restore
// runs the coercions from ABOVE this file's later declarations, so a binding
// down there is read in its TDZ and empties the whole registry on boot.
const USAGE_COERCION_LOG_EVERY_MS = 60 * 1000;
let usageCoercionLogAt = 0;
let usageCoercionSuppressed = 0;
function logRegistryFull(detail) {
  refusedSinceLog += 1;
  const now = Date.now();
  if (now - refusedLogAt < REFUSED_LOG_EVERY_MS) return;
  const also = refusedSinceLog > 1 ? ` (+${refusedSinceLog - 1} more refused since the last line)` : "";
  refusedLogAt = now;
  refusedSinceLog = 0;
  console.error(
    `registry is full (${Object.keys(agents).length}/${AGENTS_MAX} hosts, ` +
      `${registryBytes()}/${AGENTS_TOTAL_MAX} bytes): ${detail}${also}`
  );
}

// Hosts whose slot may be reclaimed for a newcomer, least-recently-seen first.
function evictableAgents(now) {
  return Object.entries(agents)
    .filter(([, a]) => now - (a.lastSeen || 0) > AGENT_EVICT_IDLE_MS)
    .sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0))
    .map(([key]) => key);
}

// Reclaim long-idle records until the registry has room for `addSlots` more
// hosts and `addBytes` more bytes; returns whether it does. `false` is the
// caller's cue to REFUSE the beat rather than take a live host's slot — see
// AGENT_EVICT_IDLE_MS for why a newcomer never wins that trade.
function makeRegistryRoom(addBytes, addSlots) {
  let bytes = registryBytes();
  let count = Object.keys(agents).length;
  const overBudget = () =>
    bytes + addBytes > AGENTS_TOTAL_MAX || count + addSlots > AGENTS_MAX;
  if (!overBudget()) return true;
  const now = Date.now();
  const evictable = evictableAgents(now);
  // Would evicting ALL of them even be enough? If not, evict none: dropping
  // records the caller is going to be refused anyway loses an offline host's
  // last known state and buys nothing.
  const reclaimable = evictable.reduce((n, key) => n + (recordBytes.get(key) || 0), 0);
  if (bytes - reclaimable + addBytes > AGENTS_TOTAL_MAX ||
      count - evictable.length + addSlots > AGENTS_MAX) return false;
  const before = evictable.length;
  while (overBudget() && evictable.length) {
    const key = evictable.shift();
    bytes -= recordBytes.get(key) || 0;
    count -= 1;
    console.warn(
      `registry at its limit — evicting ${logName(key)}, unseen for ` +
        `${Math.round((now - (agents[key].lastSeen || 0)) / 60000)}m`
    );
    delete agents[key];
    recordBytes.delete(key);
    // Everything else keyed by host name has to let go too, or a registry that
    // admits and evicts forever leaks a per-host entry per name it ever saw.
    recordSizeWarned.delete(key);
    shareWarned.delete(key);
    invalidateAgentsCache();
    sseBroadcast("removed", { key });
  }
  // An eviction has to reach state.json, or a restart brings the record back.
  if (evictable.length !== before) scheduleSave();
  return !overBudget();
}

// Hold the restored registry to the same budget. A hub that was flooded before
// it restarted has the flood ON DISK, and loading all of it is an OOM before
// the first request is served — a bound that the path which LOADS the state
// doesn't enforce is not a bound (the same reason `normalizeRecord` runs on the
// restore as well as the ingest, XERK-259).
//
// Unconditional keep-newest, NOT the idle rule above: nothing is live at boot,
// every record is by definition from before the restart, and the alternative to
// dropping the stalest is not booting at all.
function trimRestoredAgents() {
  const keys = Object.keys(agents);
  if (!keys.length) return;
  const newestFirst = keys.sort((a, b) => (agents[b].lastSeen || 0) - (agents[a].lastSeen || 0));
  let bytes = 0;
  const dropped = [];
  newestFirst.forEach((key, i) => {
    const size = agentRecordSize(agents[key]);
    if (i < AGENTS_MAX && bytes + size <= AGENTS_TOTAL_MAX) {
      bytes += size;
      recordBytes.set(key, size);
      return;
    }
    dropped.push(key);
    delete agents[key];
    recordBytes.delete(key);
  });
  if (dropped.length) {
    console.warn(
      `dropped ${dropped.length} restored agent record(s) over the registry ` +
        `budget (${AGENTS_MAX} hosts / ${AGENTS_TOTAL_MAX} bytes); kept the ` +
        `${keys.length - dropped.length} most recently seen`
    );
  }
}

// Reverse-tunnel state. controlChannels[name] = the live control connection for
// that container's tunnel-agent; pendingChannels[ch] = the record awaiting the
// agent's data-WS dial-back for channel `ch`.
//
// Both are NULL-PROTOTYPE: the keys are attacker-influenced (a `?name=`/`?ch=`
// off the wire), and on a plain object `__proto__` is not a key. It read back as
// Object.prototype — truthy, so a `ch` of `__proto__` sailed past the "is there
// a pending channel" check and died on `.resolve is not a function`, out of an
// async upgrade handler with no unhandledRejection hook: an instant hub exit.
// Assignment was worse, silently re-parenting the map.
const controlChannels = Object.create(null);
const pendingChannels = Object.create(null);
// Live transcript subscribers: liveClients[host][sessionId] = Set of glasses
// WebSocket sockets watching that session's transcript in near-real-time (see
// the /live upgrade handler). The hub asks the host's tunnel-agent to tail a
// session only while at least one socket here is watching it, and fans the
// agent's `{tail, entries}` deltas back out to that set.
const liveClients = {};

// ---- persistence (best-effort: survives hub restarts so the UI isn't blank
// for the first heartbeat interval; losing it is harmless) -------------------
try {
  // The trim below cannot protect a restore it never reaches: `readFileSync` +
  // `JSON.parse` materialize the WHOLE file first, so a 264 MiB state.json left
  // by a flood kills a 256 MiB hub at init — before a single log line, on every
  // boot, which `restart: unless-stopped` turns into a permanent crash loop
  // with nothing to read. So the file is measured before it is opened
  // (XERK-272). Losing the cache is documented as harmless; not booting is not,
  // and the file is preserved beside itself rather than deleted so the flood
  // can still be examined.
  const stateSize = fs.statSync(STATE_FILE).size;
  if (stateSize > STATE_FILE_MAX) {
    // The rename can fail (a read-only /data), and the message has to say what
    // actually happened: an operator sent to a `.oversized` that was never
    // created finds nothing and concludes the hub ate their state.
    const aside = `${STATE_FILE}.oversized`;
    let movedTo = null;
    try { fs.renameSync(STATE_FILE, aside); movedTo = aside; } catch { /* read-only volume */ }
    throw new Error(
      `state file is ${stateSize} bytes, over the ${STATE_FILE_MAX} limit — ` +
        `starting with an empty registry; the file is ` +
        (movedTo ? `kept at ${movedTo}` : `left in place at ${STATE_FILE} (could not move it)`)
    );
  }
  // Parsed into a LOCAL so the shape can be judged before anything is installed
  // (XERK-269). A blob that isn't a plain object is not a registry: `Object.keys`
  // of a JSON string yields character indices, which restored "5 agents" out of
  // `"hello"`. The array/number/boolean shapes throw nowhere on their own, so
  // without this check they reach `agents` intact and the catch never runs.
  const loaded = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
    // `typeof null` is "object", so null needs naming explicitly — otherwise the
    // one shape with no other diagnosis reads "state file is object, not an
    // object", which is the opposite of a useful message.
    const shape = loaded === null ? "null"
      : Array.isArray(loaded) ? "an array" : typeof loaded;
    throw new Error(`state file is ${shape}, not an object`);
  }
  agents = loaded;
  // Records written before a coercion existed — and any host that is OFFLINE,
  // so no beat will ever rewrite its record — carry whatever shape was current
  // when they were saved. Normalize what we LOAD, not just what arrives: the
  // first `/api/agents` after a restart serves the raw record, and a hub
  // restart is exactly when a new coercion ships. `normalizeRecord` is shared
  // with the ingest path so the two cannot drift; adding a coercion in one
  // place covers both. Tests: `the state.json restore coerces too`.
  // The KEY is coerced here too, for the same reason the record is: a record
  // written before the key guard existed carries a name the ingest path would
  // now refuse, and the restore is the first thing served after a restart. A
  // dot-segment key is the case that matters — it is uncommandable AND
  // undeletable (`DELETE /api/agents/.` is itself one of the routes whose path
  // collapses), so without this it sits there until `prune()` ages it out days
  // later. Dropping it is safe: a live host re-registers on its next beat.
  //
  // `dropUnusableHostKeys` and `isPlainHostKey` are FUNCTION declarations far
  // below this line and are reached only because those hoist. Do not convert
  // either to a `const`: the TDZ ReferenceError would land in this block's
  // catch, which swallows everything, and the hub would boot with no agents —
  // its one `state restore skipped:` line the only sign anything went wrong.
  for (const key of dropUnusableHostKeys(agents)) {
    console.warn(`dropping restored agent under unusable device name ${hostKeyLabel(key)}`);
  }
  for (const a of Object.values(agents)) normalizeRecord(a);
  // A RESTORED command cannot be proven undelivered (XERK-303), so it is stamped
  // as delivered here. `deliveredAt` is written when the reply hands the command
  // over, and `scheduleSave` is a 30-SECOND DEBOUNCE: a save that landed between
  // the queue and the delivery wrote that command WITHOUT the stamp, so the copy
  // on disk says "never delivered" about work the agent has since run. Restoring
  // that as undelivered is what turns a hub restart into a SECOND session for one
  // ticket — the reclaim would withdraw it and re-route it under a fresh cmdId
  // the agent's in-memory de-dup cannot catch.
  //
  // Past a restart the honest answer is "the hub cannot tell", and both readers
  // of this stamp already have to treat that as delivered: the reclaim leaves it
  // alone, and XERK-241's create poll says "it may have been created — check the
  // board". The cost is a spawn genuinely lost to a restart becoming
  // unreclaimable, which is a delay; the thing it buys is not a duplicate.
  // Deliberately NOT inside `normalizeRecord`: that is shared with the ingest
  // path, where these commands are live in memory and their stamps are the truth.
  sanitizeRestoredCommands(agents);
  // Hold what we LOAD to the registry budget too — a flood that landed before
  // the restart is on disk, and restoring all of it is an OOM before the first
  // request (XERK-272).
  trimRestoredAgents();
  console.log(`loaded ${Object.keys(agents).length} agents from ${STATE_FILE}`);
} catch (e) {
  // A missing file is first boot / no volume mounted and says nothing worth
  // saying. Anything else is a state file the hub HAS and could not use — an
  // oversized one, corrupt JSON, or a blob that is not a registry — which the
  // operator has to be told about, and which leaves a partially-built registry
  // behind unless it is cleared.
  if (!e || e.code !== "ENOENT") {
    agents = {};
    console.error(`state restore skipped: ${(e && e.message) || e}`);
  }
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

// ---- ticket -> runtime pins (XERK-473) -------------------------------------
// The operator's answer to which RUNTIME a ticket's session runs on — "claude"
// (the default) or "dsh" (XERK-460). Keyed "<siteKey>/<issueKey>" like the model
// pin; each entry {runtime, at}. Hub-owned and durable for the same reason: the
// runtime is delivered on the spawnTicket command the hub routes (as `agentType`),
// so the hub must remember the choice across a restart. Only a NON-default ("dsh")
// choice is stored — "claude" and clearing both release the pin — so a ticket with
// no runtime choice rides exactly the command it always did.
let ticketRuntimes = {};
try {
  const parsed = JSON.parse(fs.readFileSync(TICKET_RUNTIMES_FILE, "utf8"));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ticketRuntimes = parsed;
} catch {
  /* first boot or no volume mounted */
}
let trSaveTimer = null;
function scheduleTicketRuntimesSave() {
  if (trSaveTimer) return;
  trSaveTimer = setTimeout(() => {
    trSaveTimer = null;
    fs.mkdir(path.dirname(TICKET_RUNTIMES_FILE), { recursive: true }, () => {
      fs.writeFile(TICKET_RUNTIMES_FILE, JSON.stringify(ticketRuntimes), (err) => {
        if (err) console.error(`ticket-runtimes save failed: ${err.message}`);
      });
    });
  }, 5 * 1000);
  trSaveTimer.unref();
}
function ticketRuntimePin(siteKey, issueKey) {
  const p = ticketRuntimes[`${siteKey}/${issueKey}`];
  return p && typeof p.runtime === "string" && p.runtime ? p : null;
}
// Set or clear a ticket's pinned runtime. `runtime` null or "claude" clears it
// (claude is the default — nothing to store). The caller has already validated
// the value against {claude, dsh, qwen} and, for a non-default runtime, that the
// org offers it; this owns the map's bookkeeping and eviction.
function setTicketRuntime(siteKey, issueKey, runtime) {
  const k = `${siteKey}/${issueKey}`;
  if (!runtime || runtime === "claude") delete ticketRuntimes[k];
  else {
    ticketRuntimes[k] = { runtime, at: Date.now() };
    const keys = Object.keys(ticketRuntimes);
    if (keys.length > TICKET_RUNTIMES_MAX) {
      keys.sort((a, b) => (ticketRuntimes[a].at || 0) - (ticketRuntimes[b].at || 0));
      for (const old of keys.slice(0, keys.length - TICKET_RUNTIMES_MAX)) {
        delete ticketRuntimes[old];
      }
    }
  }
  scheduleTicketRuntimesSave();
  invalidateAgentsCache();
  sseBroadcast("ticketRuntimes", ticketRuntimes);
}
// Whether any host reporting `siteKey` offers the dsh runtime — the org-level
// capability the runtime pin's dsh option is gated on, both here (rejecting a
// dsh pin no host could honour) and on the board (hiding the option). Unioned
// across the org's hosts online or not, mirroring orgModelAliases: a host that
// offers dsh while briefly offline still means the org can run it.
function orgOffersDsh(siteKey) {
  return Object.values(agents).some(
    (a) => a && a.jira && a.jira.siteKey === siteKey && dshAvailable(a));
}
// The qwen twin of orgOffersDsh (XERK-515) — whether any host reporting `siteKey`
// offers the qwen runtime, so the runtime pin's "qwen" option is gated the same
// way (rejected server-side where no host could honour it, hidden on the board).
function orgOffersQwen(siteKey) {
  return Object.values(agents).some(
    (a) => a && a.jira && a.jira.siteKey === siteKey && qwenAvailable(a));
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
  // Switching auto OFF calls off the work it queued and NOTHING else (XERK-296):
  // the org's auto-queued tickets leave the line, its running sessions carry on,
  // and a ticket an operator queued by hand keeps its place. That is only
  // possible because a waiting ticket is no longer a created session.
  if (!enabled) dropAutoQueuedTickets(siteKey);
  // Rides the /api/agents payload (and its own SSE event), like the agent pins,
  // so open boards reflect the toggle without waiting out an ETag match.
  invalidateAgentsCache();
  sseBroadcast("autoStartOrgs", autoStartOrgs);
}

// ---- per-ticket triage actions (XERK-486 [F]) -------------------------------
// The operator's per-ticket verdict: "approve" (force auto-start eligibility
// past the org policy and the triage gate), "hold" (never auto-start until
// released), or "reject" (drop from the auto stream). Keyed and bounded exactly
// like the agent/model pins, with {action, at} so the 500-entry cap evicts the
// oldest decision. The sweep (decision time) and the drain (dispatch time) both
// consult ticketTriageAction so a verdict holds across both.
let ticketTriageActions = {};
try {
  const parsed = JSON.parse(fs.readFileSync(TRIAGE_ACTIONS_FILE, "utf8"));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [k, v] of Object.entries(parsed)) {
      if (v && TRIAGE_ACTIONS.has(v.action)) ticketTriageActions[k] = v;
    }
  }
} catch {
  /* first boot or no volume mounted */
}
let ttSaveTimer = null;
function scheduleTriageActionsSave() {
  if (ttSaveTimer) return;
  ttSaveTimer = setTimeout(() => {
    ttSaveTimer = null;
    fs.mkdir(path.dirname(TRIAGE_ACTIONS_FILE), { recursive: true }, () => {
      fs.writeFile(TRIAGE_ACTIONS_FILE, JSON.stringify(ticketTriageActions), (err) => {
        if (err) console.error(`triage-actions save failed: ${err.message}`);
      });
    });
  }, 5 * 1000);
  ttSaveTimer.unref();
}
function ticketTriageAction(siteKey, issueKey) {
  const a = ticketTriageActions[`${siteKey}/${issueKey}`];
  return a && TRIAGE_ACTIONS.has(a.action) ? a.action : null;
}
// Set or clear (action=null) a ticket's triage verdict. The caller has already
// validated the siteKey is one the fleet reports; this owns the map's bookkeeping.
function setTicketTriageAction(siteKey, issueKey, action) {
  const k = `${siteKey}/${issueKey}`;
  if (!action) {
    delete ticketTriageActions[k];
  } else {
    ticketTriageActions[k] = { action, at: Date.now() };
    const keys = Object.keys(ticketTriageActions);
    if (keys.length > TRIAGE_ACTIONS_MAX) {
      keys.sort((a, b) => (ticketTriageActions[a].at || 0) - (ticketTriageActions[b].at || 0));
      for (const old of keys.slice(0, keys.length - TRIAGE_ACTIONS_MAX)) {
        delete ticketTriageActions[old];
      }
    }
  }
  scheduleTriageActionsSave();
  invalidateAgentsCache();
  sseBroadcast("triageActions", ticketTriageActions);
}

// ---- per-org triage policy (XERK-486 [F]) ----------------------------------
// The org's auto-start policy: minPriority (auto-start this band and higher),
// excludeTypes, repoAllow/repoDeny, rateMax. siteKey -> policy object. Loaded
// with per-field sanitization at boot so a hand-edited file can't smuggle a
// non-string into a .includes() or a float into a rate comparison.
let triagePolicies = {};
try {
  const parsed = JSON.parse(fs.readFileSync(TRIAGE_POLICIES_FILE, "utf8"));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [k, v] of Object.entries(parsed)) {
      const p = {};
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if (v.minPriority && ["P0", "P1", "P2", "P3"].includes(v.minPriority)) p.minPriority = v.minPriority;
        if (Array.isArray(v.excludeTypes)) p.excludeTypes = v.excludeTypes.filter(x => typeof x === "string");
        if (Array.isArray(v.repoAllow)) p.repoAllow = v.repoAllow.filter(x => typeof x === "string");
        if (Array.isArray(v.repoDeny)) p.repoDeny = v.repoDeny.filter(x => typeof x === "string");
        if (Number.isInteger(v.rateMax) && v.rateMax >= 1 && v.rateMax <= 50) p.rateMax = v.rateMax;
      }
      if (Object.keys(p).length) triagePolicies[k] = p;
    }
  }
} catch {
  /* first boot or no volume mounted */
}
function sanitizeTriagePolicy(patch) {
  // Returns a sanitized partial policy or null if the patch is malformed.
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return null;
  const p = {};
  if ("minPriority" in patch) {
    if (patch.minPriority != null && !["P0", "P1", "P2", "P3"].includes(patch.minPriority)) return null;
    p.minPriority = patch.minPriority || null;
  }
  for (const f of ["excludeTypes", "repoAllow", "repoDeny"]) {
    if (f in patch) {
      if (patch[f] != null && (!Array.isArray(patch[f]) || !patch[f].every(x => typeof x === "string"))) return null;
      p[f] = patch[f] || null;
    }
  }
  if ("rateMax" in patch) {
    if (patch.rateMax != null && (!Number.isInteger(patch.rateMax) || patch.rateMax < 1 || patch.rateMax > 50)) return null;
    p.rateMax = patch.rateMax || null;
  }
  return p;
}
let tpSaveTimer = null;
function scheduleTriagePolicySave() {
  if (tpSaveTimer) return;
  tpSaveTimer = setTimeout(() => {
    tpSaveTimer = null;
    fs.mkdir(path.dirname(TRIAGE_POLICIES_FILE), { recursive: true }, () => {
      fs.writeFile(TRIAGE_POLICIES_FILE, JSON.stringify(triagePolicies), (err) => {
        if (err) console.error(`triage-policies save failed: ${err.message}`);
      });
    });
  }, 5 * 1000);
  tpSaveTimer.unref();
}
// Merge a sanitized patch into an org's policy (null values clear a knob).
function setTriagePolicy(siteKey, patch) {
  const p = { ...(triagePolicies[siteKey] || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) delete p[k];
    else p[k] = v;
  }
  if (Object.keys(p).length) triagePolicies[siteKey] = p;
  else delete triagePolicies[siteKey];
  scheduleTriagePolicySave();
  invalidateAgentsCache();
  sseBroadcast("triagePolicies", triagePolicies);
}

// ---- per-org priority write-back opt-in (XERK-483) -------------------------
// The set of orgs the operator has switched triage priority write-back ON for,
// keyed by siteKey with the value simply `true` (presence = enabled; disabling
// deletes the key). Writing priority into someone's tracker is intrusive, so
// this is OFF by default everywhere. Same shape and lifecycle as autoStartOrgs.
let priorityWriteBackOrgs = {};
try {
  const parsed = JSON.parse(fs.readFileSync(PRIORITY_WRITEBACK_ORGS_FILE, "utf8"));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [k, v] of Object.entries(parsed)) if (v) priorityWriteBackOrgs[k] = true;
  }
} catch {
  /* first boot or no volume mounted */
}
let pwSaveTimer = null;
function schedulePriorityWriteBackSave() {
  if (pwSaveTimer) return;
  pwSaveTimer = setTimeout(() => {
    pwSaveTimer = null;
    fs.mkdir(path.dirname(PRIORITY_WRITEBACK_ORGS_FILE), { recursive: true }, () => {
      fs.writeFile(PRIORITY_WRITEBACK_ORGS_FILE, JSON.stringify(priorityWriteBackOrgs), (err) => {
        if (err) console.error(`priority-writeback-orgs save failed: ${err.message}`);
      });
    });
  }, 5 * 1000);
  pwSaveTimer.unref();
}
// Flip an org's priority write-back opt-in. The caller has already validated the
// siteKey is one the fleet actually reports; this owns the map's bookkeeping.
function setPriorityWriteBackOrg(siteKey, enabled) {
  if (enabled) priorityWriteBackOrgs[siteKey] = true;
  else delete priorityWriteBackOrgs[siteKey];
  schedulePriorityWriteBackSave();
  // Rides the /api/agents payload (and its own SSE event), like the auto-start
  // opt-in, so open boards reflect the toggle without waiting out an ETag match.
  invalidateAgentsCache();
  sseBroadcast("priorityWriteBackOrgs", priorityWriteBackOrgs);
}

// ---- per-org duplicate linking opt-in (XERK-484) ---------------------------
// The set of orgs the operator has switched duplicate linking ON for, keyed by
// siteKey with the value simply `true` (presence = enabled; disabling deletes
// the key). Writing issue links into someone's tracker is intrusive, so this is
// OFF by default everywhere. Same shape and lifecycle as priorityWriteBackOrgs.
let dedupeLinkOrgs = {};
try {
  const parsed = JSON.parse(fs.readFileSync(DEDUPE_LINK_ORGS_FILE, "utf8"));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [k, v] of Object.entries(parsed)) if (v) dedupeLinkOrgs[k] = true;
  }
} catch {
  /* first boot or no volume mounted */
}
let dlSaveTimer = null;
function scheduleDedupeLinkSave() {
  if (dlSaveTimer) return;
  dlSaveTimer = setTimeout(() => {
    dlSaveTimer = null;
    fs.mkdir(path.dirname(DEDUPE_LINK_ORGS_FILE), { recursive: true }, () => {
      fs.writeFile(DEDUPE_LINK_ORGS_FILE, JSON.stringify(dedupeLinkOrgs), (err) => {
        if (err) console.error(`dedupe-link-orgs save failed: ${err.message}`);
      });
    });
  }, 5 * 1000);
  dlSaveTimer.unref();
}
// Flip an org's duplicate-linking opt-in. The caller has already validated the
// siteKey is one the fleet actually reports; this owns the map's bookkeeping.
function setDedupeLinkOrg(siteKey, enabled) {
  if (enabled) dedupeLinkOrgs[siteKey] = true;
  else delete dedupeLinkOrgs[siteKey];
  scheduleDedupeLinkSave();
  // Rides the /api/agents payload (and its own SSE event), like the other
  // per-org opt-ins, so open boards reflect the toggle without an ETag match.
  invalidateAgentsCache();
  sseBroadcast("dedupeLinkOrgs", dedupeLinkOrgs);
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

// ---- per-repo importance tiers (XERK-487) ----------------------------------
// A repo's tier weights triage ordering and policy above raw ticket priority:
// "a bug in the live-serving hub" outranks "a docs nit in an archived repo".
// The four tiers are a TOTAL ORDER, most important first; higher rank sorts
// earlier and is the more important repo.
const REPO_TIERS = ["ignore", "archive", "active", "live"]; // rank = index
const REPO_TIER_RANK = Object.fromEntries(REPO_TIERS.map((t, i) => [t, i]));
// The default for an UNSET repo is the middle working tier, never the top
// (XERK-487): a repo we know nothing special about is ordinary "active" work —
// it outranks an explicitly archived repo and is outranked by a live one, and
// it still routes (only "ignore" is ever withheld from the auto stream). It is
// deliberately NOT the top tier, so silence never promotes a repo above one an
// operator deliberately marked live.
const DEFAULT_REPO_TIER = "active";
// A repo name is agent/operator-supplied and this map outlives the request, so
// the key is bounded like every other durable free-text key.
const REPO_NAME_MAX = 200;
const isRepoTier = (t) => typeof t === "string" && Object.hasOwn(REPO_TIER_RANK, t);
let repoTiers = {};
try {
  const parsed = JSON.parse(fs.readFileSync(REPO_TIERS_FILE, "utf8"));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [k, v] of Object.entries(parsed)) {
      // Only NON-default, in-range tiers are kept: the default is implicit, so
      // storing it would just be dead weight (setRepoTier deletes back to it).
      if (k && k.length <= REPO_NAME_MAX && isRepoTier(v) && v !== DEFAULT_REPO_TIER) {
        repoTiers[k] = v;
      }
    }
  }
} catch {
  /* first boot or no volume mounted */
}
// One-shot config seed: fills in repos the durable file does not already carry.
// Wrapped so a malformed REPO_TIER_SEED is a logged boot warning, never a crash.
if (REPO_TIER_SEED) {
  try {
    const seed = JSON.parse(REPO_TIER_SEED);
    if (seed && typeof seed === "object" && !Array.isArray(seed)) {
      for (const [k, v] of Object.entries(seed)) {
        if (k && k.length <= REPO_NAME_MAX && isRepoTier(v) &&
            v !== DEFAULT_REPO_TIER && !Object.hasOwn(repoTiers, k)) {
          repoTiers[k] = v;
        }
      }
    } else {
      console.error("REPO_TIER_SEED is not a JSON object of {repo: tier} — ignored");
    }
  } catch (err) {
    console.error(`REPO_TIER_SEED could not be parsed — ignored: ${err.message}`);
  }
}
let rtSaveTimer = null;
function scheduleRepoTiersSave() {
  if (rtSaveTimer) return;
  rtSaveTimer = setTimeout(() => {
    rtSaveTimer = null;
    fs.mkdir(path.dirname(REPO_TIERS_FILE), { recursive: true }, () => {
      fs.writeFile(REPO_TIERS_FILE, JSON.stringify(repoTiers), (err) => {
        if (err) console.error(`repo-tiers save failed: ${err.message}`);
      });
    });
  }, 5 * 1000);
  rtSaveTimer.unref();
}
// The read seams the rest of triage consumes. Keyed by the SAME repo name
// `repoGuess`/`ticketRepo` yields, so a ticket's triaged repo joins cleanly.
// An unset or blank repo is the default middle tier — the "can't tell" answer,
// never top — so every caller gets a usable rank without a null check.
function repoTier(repo) {
  return (repo && repoTiers[repo]) || DEFAULT_REPO_TIER;
}
function repoTierRank(repo) {
  return REPO_TIER_RANK[repoTier(repo)];
}
// The one policy the tier store owns outright (XERK-487): an ignore-tier repo is
// never auto-started. [F]'s allow/deny reads the rank for finer thresholds.
function isRepoIgnored(repo) {
  return repoTier(repo) === "ignore";
}
// Set (or, with tier === DEFAULT_REPO_TIER, clear) a repo's tier. The caller has
// already validated the name and the tier value; this owns the map bookkeeping,
// mirroring setAutoStartOrg/setOrgColor — durable save, cache bust, SSE frame.
function setRepoTier(repo, tier) {
  if (tier && tier !== DEFAULT_REPO_TIER) repoTiers[repo] = tier;
  else delete repoTiers[repo];
  scheduleRepoTiersSave();
  invalidateAgentsCache();
  sseBroadcast("repoTiers", repoTiers);
}
// The repo names the fleet actually reports (agents[].repos[].name), so a tier
// can't be pinned onto a phantom repo — the same "no inventing state the fleet
// doesn't back" guard the /autostart and /color routes apply to a siteKey.
function fleetRepoNames() {
  const names = new Set();
  for (const a of Object.values(agents)) {
    for (const r of (a && a.repos) || []) if (r && r.name) names.add(r.name);
  }
  return names;
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
// State is in-memory and short-lived; a hub restart mid-migration aborts it,
// leaving the source session intact.
const migrations = new Map(); // migrationId -> record (see startMigration)
const MIGRATE_TIMEOUT_MS = Number(process.env.MIGRATE_TIMEOUT_MS) || 5 * 60 * 1000;
const MIGRATE_DONE_KEEP_MS = 30 * 1000; // keep a done/failed record briefly so UI can observe
const MIGRATIONS_MAX = 40; // backstop against unbounded growth
// Upload cap for the relay: a hair above the agent's own 64 MiB pack limit so a
// legitimate at-cap bundle isn't rejected for framing overhead.
const MIGRATE_BLOB_MAX = (1 << 26) + (1 << 20); // 65 MiB

// The archive's raw layer (XERK-338). CHUNK is the decompressed ceiling one push
// may expand to — it bounds `gunzipSync`, so it is the number that actually
// stops a zip bomb; BODY is the compressed body cap, sized so an ordinary chunk
// never trips it (JSONL gzips ~5-8x, so 4 MiB of transcript is well under 1 MiB
// on the wire) while a body that could only be a bomb is refused before it is
// ever decompressed. The agent's own read window must stay at or under CHUNK, or
// every push it makes is refused.
const ARCHIVE_RAW_CHUNK_MAX = 1 << 22;   // 4 MiB decompressed
// The wire cap has to clear the worst case of gzipping a full chunk, not equal
// it. gzip EXPANDS incompressible input (~+0.03%: a measured 4 MiB of urandom
// came out at 4,195,602 bytes), so an equal cap made any session file holding
// 4 MiB of already-compressed bytes impossible to push — permanently, and,
// because a failed push aborted the whole pass, it stopped the raw sync for
// every OTHER transcript on that host too (XERK-338 QA D2).
const ARCHIVE_RAW_BODY_MAX = ARCHIVE_RAW_CHUNK_MAX + (1 << 16);

// The RENDERED archive route's own body ceiling (XERK-356). It read with
// `readBody`'s DEFAULT 1 MiB while the agent builds each delta out of an 8 MiB
// window — and archival deliberately excludes RUNNING sessions, so an ended
// session's FIRST delta is its whole transcript, several MB for anything real.
// Every such push was refused (413, or a socket the agent's urllib lost the
// answer on), so the durable archive held only trivially small transcripts: it
// was empty for exactly the sessions it exists to preserve, and nothing said so.
//
// **This route costs many times its wire size at peak, not `BODY_PARSE_COST`'s
// 3x**, because it holds the accumulated body string, the parsed entry array,
// `ingestChunk`'s re-serialized `lines` and the append buffer all at once.
// Measured at roughly this multiple of the body at peak RSS.
//
// The number matters because the in-flight budget is only a bound on memory
// while its units MEAN memory. Charged at 3x with an 8 MiB ceiling, a real
// 256 MiB cgroup was OOM-KILLED by three hosts backfilling 6 MB deltas beside
// one large-but-legal heartbeat — `restart: unless-stopped` then loops the
// outage (XERK-356 QA D1). At this cost and ceiling the same cgroup survives
// FORTY-EIGHT hosts pushing max-size deltas beside a 30 MiB heartbeat, three
// rounds running, peaking at 239 MiB of its 256.
//
// Measure with `ARCHIVE_DIR` on a REAL DISK. On tmpfs (the obvious scratch
// choice) every archived byte is charged to the same cgroup and unreclaimable,
// so the hub OOMs on what it STORED and any conclusion about what it PARSED is
// worthless — it also makes the fix look like the regression, since the version
// that refuses the pushes writes nothing.
const ARCHIVE_PARSE_COST = 20;
// With the charge honest, the AGGREGATE is already bounded by
// BODY_INFLIGHT_TOTAL_MAX; the per-body ceiling only decides how many fit at
// once. It is derived so one max-size delta costs a sixteenth of the container —
// two or three concurrent backfills plus ordinary traffic — and, like every
// other ceiling here (XERK-258), it TIGHTENS with a smaller container instead of
// being a flat number a small hub cannot honour.
//
// The agent is TOLD this number on its beat reply (`archiveChunkMax`) and cuts
// each delta at a line boundary to fit, because the body is a RE-ENCODING of the
// window rather than a fixed ratio of it — a SendUserFile turn is a short line
// that renders to megabytes of inline payload. So a body past this is an agent
// that predates the field, or a bug; it is not the normal path. Deltas are
// append-only, so a smaller ceiling costs round trips and never content: 2 MiB
// keeps the EXCLUSIVE lane's worst case at 40 MiB of charge rather than 80, and
// a whole-transcript backfill is a handful more POSTs in one sync pass.
const ARCHIVE_CHUNK_ABSOLUTE_MAX = 2 << 20;   // 2 MiB of rendered entries per delta
const ARCHIVE_CHUNK_BODY_MAX =
  Number(process.env.ARCHIVE_CHUNK_BODY_MAX) ||
  Math.min(ARCHIVE_CHUNK_ABSOLUTE_MAX, Math.floor(MEMORY_LIMIT / (ARCHIVE_PARSE_COST * 3)));
// How the boot line states it. A MiB formatter FLOORS, and this is the one
// derived ceiling that can land under a MiB on a small container — printed as
// "0 MiB" the boot line stops being the way the number is discoverable, which is
// the whole reason it is printed.
function archiveChunkLabel(bytes = ARCHIVE_CHUNK_BODY_MAX) {
  return bytes >= (1 << 20)
    ? `${Math.round(bytes / (1 << 20))} MiB`
    : `${Math.round(bytes / 1024)} KiB`;
}

// Why a transcript is NOT in the archive, in the hub's own words (XERK-356).
//
// A refused push is otherwise invisible: the agent logs one line and moves on,
// while the Sessions page tells the operator the session "hasn't reached the
// archive yet — it syncs within a few minutes of ending", which for a refusal is
// untrue and never stops being untrue. Recorded HERE, where the hub does the
// refusing, rather than reported back by the agent: the hub's own words need no
// wire contract, no cap on an agent-supplied string and no trust in the host
// that just failed, and they are what the refusal contract already says an
// operator must see (XERK-264).
//
// Bounded, because `transcriptId` is agent-chosen and therefore unbounded input.
// A successful chunk for that transcript clears it — the record answers "why is
// this missing", so it must not outlive the missing.
//
// Keyed on HOST + transcript, and evicted **within a host first**: keyed on the
// transcript alone, any one agent could push 200 refusals of its own and drop
// every other host's real diagnostic on the floor, which is the one thing this
// record exists to provide (XERK-356 QA D8). The reason is one of a fixed set of
// hub-authored strings — never an exception's text — so nothing agent-shaped is
// stored or served, and the whole map is bounded by construction.
const archiveRefusals = new Map(); // `${host}\u0000${tid}` -> { host, transcriptId, at, error }
const ARCHIVE_REFUSALS_MAX = 200;
const ARCHIVE_REFUSALS_PER_HOST = 25;
const refusalKey = (host, transcriptId) => `${host}\u0000${transcriptId}`;
function noteArchiveRefusal(transcriptId, host, error) {
  const key = refusalKey(host, transcriptId);
  archiveRefusals.delete(key); // re-insert so it is this host's newest
  archiveRefusals.set(key, { host, transcriptId, at: Date.now(), error: String(error || "") });
  let mine = 0;
  for (const k of [...archiveRefusals.keys()].reverse()) {           // newest first
    if (archiveRefusals.get(k).host !== host) continue;
    if (++mine > ARCHIVE_REFUSALS_PER_HOST) archiveRefusals.delete(k);
  }
  while (archiveRefusals.size > ARCHIVE_REFUSALS_MAX) {
    archiveRefusals.delete(archiveRefusals.keys().next().value);      // oldest overall
  }
}
// The newest refusal recorded for a transcript, whichever host reported it. The
// reader knows only the id — an archived session that never landed has no row to
// say whose it was — so a migrated transcript legitimately has one per host, and
// the last failure is the one that explains why it is missing now.
function archiveRefusalFor(transcriptId) {
  let found = null;
  for (const r of archiveRefusals.values()) {
    if (r.transcriptId === transcriptId && (!found || r.at >= found.at)) found = r;
  }
  return found;
}
// **The bundle NEVER rides in the record** (XERK-263). At 65 MiB a pair of
// concurrent moves — two clicks of the Sessions page's Move control — would
// retain 130 MiB in a hub running at mem_limit 256m, so the relay spools each
// one to a file here and the record keeps only its path. Same volume as the
// rest of /data, but nothing in it is durable: a file outliving its migration
// is garbage, which is why boot sweeps the whole directory.
const MIGRATE_SPOOL_DIR = process.env.MIGRATE_SPOOL_DIR || "/data/migrations";
// Spooling moved the pressure off the heap and onto /data, which the archive
// shares — so bound how much of it a burst of moves can hold at once. Enforced
// where a move STARTS, not on the relay upload: an agent's upload is
// best-effort with no retry, so refusing one strands a migration, while
// refusing the operator's click just says "not right now" on the Move control.
const MIGRATE_INFLIGHT_MAX = Number(process.env.MIGRATE_INFLIGHT_MAX) || 4;
// How many names an incomplete restore lists on its record. It rides /api/agents
// and every SSE frame, and the names come from the archive's raw layer — bounded
// per name but not in COUNT, so a session with thousands of subagent files could
// otherwise put every one of them on a payload a 256 MiB hub serves to every tab.
const INCOMPLETE_NAMES_MAX = 20;
// The agent's own name for the repos-root pseudo-repo (`ROOT_REPO_NAME` in
// hub-agent.py). A root session's recorded cwd is the source host's REPOS_ROOT,
// which carries no shape the hub can check, so the row's repo is what says so.
const ROOT_REPO_NAME = "(root)";

// The id `crypto.randomBytes(8).toString("hex")` produces in startMigration, and
// the filename that makes — the second being the ONLY thing the boot sweep may
// delete. Keep the two in step: they are the same name either side of `.bin`.
const MIGRATE_ID_RE = /^[0-9a-f]{16}$/;
const MIGRATE_SPOOL_RE = /^[0-9a-f]{16}\.bin$/;

// Where a migration's spooled bundle lives. Keyed on the HUB-MINTED id (hex
// from crypto.randomBytes, and only ever an id already in `migrations`), never
// on the path segment the agent sent — the relay is a host boundary, so the
// filename must not be something a caller can steer.
// It ENFORCES that rather than trusting it: the id is checked against the shape
// startMigration mints, so a caller-supplied one could not name a path here even
// if some future route passed one through. Throwing is right — the request
// handler turns it into a 500, and there is no sane fallback path to spool to.
function migrationSpoolPath(id) {
  if (!MIGRATE_ID_RE.test(String(id)))
    throw new Error("refusing to spool under a migration id this hub did not mint");
  // Not path-traversable: the guard above leaves 16 hex characters, so no
  // component can hold a separator or '..'.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return path.join(MIGRATE_SPOOL_DIR, `${id}.bin`);
}

// Release a migration's spooled bundle. Idempotent, and safe to call while the
// target is still streaming it out: the unlink drops the name, and the reader's
// open fd keeps the bytes alive until it finishes. Every path that settles or
// abandons a migration goes through this — a leaked file is 65 MiB of disk that
// nothing will ever come back for.
function dropMigrationBlob(m) {
  const p = m && m.blobPath;
  if (!p) return;
  m.blobPath = null;
  m.blobSize = 0;
  fs.unlink(p, () => {});
}

// Boot sweep: the migration records are in memory, so a restart abandons every
// in-flight move and anything still in the spool dir belongs to no one. Without
// this, a hub killed mid-relay leaks its bundle to disk permanently.
//
// It deletes ONLY names this hub could have written (MIGRATE_SPOOL_RE), never
// whatever it happens to find. MIGRATE_SPOOL_DIR is deployment config, and a
// one-word compose slip pointing it at /data would otherwise have boot delete
// state.json and devices.json.
function sweepMigrationSpool() {
  let names;
  try {
    names = fs.readdirSync(MIGRATE_SPOOL_DIR);
  } catch {
    return; // no spool dir yet — nothing has been relayed on this volume
  }
  for (const n of names) {
    if (!MIGRATE_SPOOL_RE.test(n)) continue;
    try { fs.unlinkSync(path.join(MIGRATE_SPOOL_DIR, n)); } catch {}
  }
}

// The wire shape (blob stripped) the /api/agents payload and SSE carry, so the
// UI can follow a migration to its new host and surface a failure.
function serializeMigration(m) {
  return {
    id: m.id, srcHost: m.srcHost, srcSessionId: m.srcSessionId,
    // A restore from the archive (XERK-441) has no source session; the flag is
    // what lets a client word it as one rather than as a move from nowhere.
    restore: !!m.restore,
    targetHost: m.targetHost, siteKey: m.siteKey, repo: m.repo,
    transcriptId: m.transcriptId, phase: m.phase, error: m.error || null,
    importCmdId: m.importCmdId || null, targetSessionId: m.targetSessionId || null,
    // Files the archive holds that the bundle could not carry (XERK-441). Absent
    // on a complete restore, so a client can word a partial one as partial; the
    // conversation is never among them, because that fails the restore outright.
    incomplete: m.incomplete || null,
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
// A queued command as anyone outside the hub may see it. Both stripped fields
// are the hub's own bookkeeping, riding on the command because that is exactly
// how long each is meaningful — so neither the agent's reply nor the fleet
// payload carries them, and neither becomes a client contract:
//   - `deliveredAt`, the record of having handed the command over (XERK-241).
//   - `ticketSource`, which queue entry a spawnTicket came from (XERK-303), so a
//     reclaim can put the ticket back in line as the same kind of work.
// Returns the same array when there is nothing to strip.
// Everything a RESTORED command needs before anything else reads it (XERK-303).
// A FUNCTION declaration on purpose — the restore runs far above this line and
// reaches it only because declarations hoist.
//
// Two jobs, and the first is why `normalizeRecord` cannot do either: it is shared
// with the ingest path, where these commands are live in memory and their stamps
// are the truth.
//
//  1. REWRITE a non-array `commands`, and DROP any element that is not an
//     object. `normalizeRecord` does not walk
//     `commands`, and a corrupt or hand-edited state.json is the only way one
//     gets in — nothing on the wire reaches this array, and `queueCommand` only
//     ever pushes objects. Dropping it HERE is what makes every `c.type` /
//     `c.cmdId` read in the file safe, and there are a dozen. The one that
//     matters is `autoStartSweep`'s, which runs in a `setInterval` with no
//     `uncaughtException` handler behind it: `null.type` there is not a failed
//     request, it EXITS THE HUB, taking every host's control plane with it —
//     and it re-fires 15s after each restart. The heartbeat's ack filter drops
//     junk too, but only for a host that BEATS, and an offline host holding a
//     stranded spawn is exactly the subject here and never will.
//  2. STAMP what is left as delivered. `deliveredAt` cannot be reconstructed
//     from disk, so past a restart the hub's honest answer is "cannot tell", and
//     both readers of the stamp treat that as delivered.
function sanitizeRestoredCommands(reg) {
  const at = Date.now();
  for (const a of Object.values(reg || {})) {
    if (!a || typeof a !== "object" || !("commands" in a)) continue;
    // The CONTAINER's type, checked before the elements'. Skipping a non-array
    // leaves it in the registry, and it is fatal one line sooner than a junk
    // element is: `(a.commands || []).some` is not a function, `for…of` a plain
    // object is not iterable — the same `setInterval` with the same no-handler
    // exit behind it, and `publicCommands`/the ack filter break identically. A
    // string is a plausible shape for a hand-edited file precisely because it
    // looks scalar. Rewritten, not skipped, for the same reason `normalizeSessions`
    // rewrites a non-array `sessions`.
    if (!Array.isArray(a.commands)) {
      console.warn(`dropped a malformed queued command list restored for `
        + `${logName(a.device)} (${typeof a.commands}, not an array)`);
      a.commands = [];
      continue;
    }
    const clean = a.commands.filter((c) => c && typeof c === "object");
    if (clean.length !== a.commands.length) {
      console.warn(`dropped ${a.commands.length - clean.length} malformed queued `
        + `command(s) restored for ${logName(a.device)}`);
      a.commands = clean;
    }
    for (const c of a.commands) if (!("deliveredAt" in c)) c.deliveredAt = at;
  }
}

// The `typeof` is not decoration: `in` THROWS on a truthy primitive, and this
// runs on both the fleet payload and the heartbeat reply. A `commands` array
// holding a bare string (a corrupt or hand-edited state.json — `normalizeRecord`
// does not walk commands) would 400 that host's every beat with the internal
// error text, and serve every dashboard a stale payload from `lastGoodAgentsCache`
// for as long as the record lived. That is XERK-235's loop, from a one-word gap.
const INTERNAL_COMMAND_FIELDS = ["deliveredAt", "ticketSource", "ticketSite"];
function publicCommands(cmds) {
  const internal = (c) => c && typeof c === "object"
    && INTERNAL_COMMAND_FIELDS.some((f) => f in c);
  if (!cmds || !cmds.some(internal)) return cmds;
  return cmds.map((c) => {
    if (!internal(c)) return c;
    const { deliveredAt, ticketSource, ticketSite, ...rest } = c;
    return rest;
  });
}

function serializeAgent(key, agent, now) {
  // `resultWaits` is per-command bookkeeping with timestamps (XERK-151) — pure
  // internal state, stripped like the caches. `tokenBound` likewise: it is the
  // hub's note of which credential this host beat with (XERK-268), read only by
  // ttydAuth, and putting it on the wire would make it a client contract.
  // `unsupported` is NOT: it's a tiny, rarely-changing map of what this host's
  // agent can't do, worth reading.
  const { history, subagentHistory, jiraIssues, statusResults,
          priorityResults, linkResults,
          createMeta, createTypes, createResults, resultWaits, tokenBound,
          orgBound, ...a } = agent;
  const online = now - (a.lastSeen || 0) < OFFLINE_AFTER_MS;
  // Earlier epochs of this host's spend added back (XERK-338). Null — and so
  // free — for every host that has never lost transcripts, which is all of them
  // until one is wiped; only then does the served block stop being the agent's
  // own. Applied HERE rather than at ingest so what is stored and size-budgeted
  // stays the agent's raw report, and so a purge takes effect on the next read.
  const durable = usageLedger.fold(key, a, now);
  return {
    key,
    ...a,
    ...(durable || {}),
    // Fold agent-overhead scratch repos (`hub-agent-mgr-*`, `.turma`) into one
    // `Turma-System-Usage` block (XERK-338). `durable.repoUsage` is already folded
    // (repoBlocks), so this only bites the raw path — a live host whose OWN
    // heartbeat still names such a repo while the ledger does not augment
    // (`fold` → null), which would otherwise serve the junk repo unfolded.
    // Idempotent, and returns the list unchanged when nothing matches.
    repoUsage: usageLedger.foldSystemRepos((durable && durable.repoUsage) || a.repoUsage),
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
    now, agents: list, ticketAgents, ticketModels, ticketRuntimes, autoStartOrgs, priorityWriteBackOrgs, dedupeLinkOrgs, orgColors,
    // Per-org triage policy (XERK-486 [F]) and the per-ticket triage verdicts
    // (approve/hold/reject): hub-owned like the pins above, and the board's one
    // read channel for both — the policy panel and the card chips read them
    // straight off the payload (plus their own SSE events for live boards).
    triagePolicies, ticketTriageActions,
    // Per-repo importance tiers (XERK-487), hub-owned durable state keyed by
    // repo name. Only non-default tiers ride here; an absent repo is the default
    // middle tier. Board reads it to show/set a repo's tier; the ordering and
    // ignore-gate it drives are hub-side.
    repoTiers,
    // Tickets waiting for a host to free up (XERK-296). Hub-owned like the pins
    // above — a queued ticket has no host and no session, so this payload is the
    // only place it exists.
    ticketQueue: ticketQueuePayload(),
    // In-flight (and just-settled) session migrations, so the Sessions page can
    // follow a moved session onto its new host and surface a failure (XERK-101).
    migrations: migrationList(),
    // Token usage for hosts the registry no longer has (XERK-338): deleted,
    // pruned, or evicted. Agent-shaped records carrying nothing but `usage` /
    // `repoUsage` / `jira.siteKey` and flagged `retired`, so the Usage page and
    // the Android Usage screen chart them beside the live fleet with the code
    // they already have — and so no OTHER page picks them up, since none of them
    // reads this key. Empty from a hub predating the ledger.
    retiredUsage: usageLedger.retiredAgents(Object.keys(agents), now),
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
  const v = a && a.jira && a.jira.siteKey;
  // STRINGS only. `jira` is agent-supplied and nothing coerces `siteKey`, so an
  // object or array would be compared by reference: a host declaring the same
  // `{...}` every beat compares unequal to the one stored in `orgBound`, reads
  // as permanently drifted, silently loses every peer and warns on every beat.
  // Anything that is not a string is "no org", which is the narrow answer.
  return typeof v === "string" ? v : "";
}

// --- the org-scoped peer roster (XERK-348) --------------------------------
//
// Cross-session messaging has exactly ONE boundary control of its own — this
// machine vs. beyond it — and OUR boundary is the org, which spans hosts. The
// axes don't line up, so the boundary is drawn where the hub can draw it: an
// agent denies `ListAgents` (which removes the tool outright, so a session
// cannot ENUMERATE anyone), and the only address book left is the roster this
// builds. Note the limit precisely: `SendMessage` resolves any string it is
// given, so a session can still GUESS a name — rcName is `<host>-<repo>-<KEY>`
// and structurally guessable. What the roster removes is discovery, not
// delivery. Never write it up as "can only name what the hub sent".
//
// The rule is siteKeyOf's, exactly as a migration's is: same org only, and an
// ORG-LESS host is alone rather than pooled with every other org-less host.
// Never widen this to "every host the hub knows" — the roster IS the boundary.
const PEERS_MAX_ROWS = 120;
// The wire cap on EVERY cell, not just the free-text one. The agent caps and
// flattens each cell again on arrival (_peer_cell) — it owns the file's format,
// and this crosses a trust boundary — but the reply is built and held HERE, so
// an uncapped field is the hub's problem before it is ever the agent's.
//
// Capping only `task` was not a smaller version of this, it was a hole: nothing
// in sanitizeHeartbeat or normalizeRecord bounds `rcName`, whose only limit is
// AGENT_RECORD_MAX across the WHOLE record, and the hub's own spawn route takes
// a SPAWN_FIELD_MAX (100k) `label` that the agent slugs straight into it. Four
// org hosts x 30 sessions x a 200 KB name each — every record inside the 8 MiB
// gate — built a 23.8 MB reply and OOM-killed a hub in a real 256 MiB cgroup,
// while the same load left a pre-roster hub serving at 122 MB. `mem_limit: 256m`
// plus `restart: unless-stopped` is the outage loop the memory-ceiling contract
// in CLAUDE.md exists to prevent. Six capped cells x PEERS_MAX_ROWS bounds the
// whole roster at ~86 KB.
const PEER_CELL_MAX = 120;
const peerCell = (v) => String(v == null ? "" : v).slice(0, PEER_CELL_MAX);

// The org the hub BOUND this host to when it first declared one, which is NOT
// the one it claims on this beat. `jira.siteKey` is asserted by the agent about
// itself, so gating a disclosure on it lets any holder of any host's token join
// any org and read that org's whole session roster — session ids, peer names,
// repos, live branches and ticket summaries — none of which an agent credential
// could reach before (`/api/agents` refuses one). That is the same objection
// XERK-268 makes to trusting a self-asserted `<host>`, and the binding is the
// answer to it: trust-on-first-use, hub-owned, persisted with the record, and
// reset by the operator action that already exists — DELETE /api/agents/<host>.
function boundOrgOf(a) {
  const v = a && a.orgBound;
  // STRINGS only, for the same reason siteKeyOf coerces — and one more: this
  // value is PERSISTED. An earlier build of this branch bound a non-string org
  // (siteKeyOf did not coerce yet), so a hub upgrading over its own `/data`
  // reads one back, and `.slice()` on it threw out of the heartbeat handler:
  // 400 with the raw exception text on EVERY beat from that host, forever, with
  // the recovery path throwing too. Nothing coerces `orgBound` on restore, so
  // the guard has to live here.
  return typeof v === "string" ? v : "";
}

// Warned once per host per drift, so a permanently misconfigured host does not
// bury the log — but the operator has to be able to SEE this: from the host's
// own side a drift is indistinguishable from "my org has no other hosts up".
// Rate-limited per host by TIME, which is the only bound that holds. Keying on
// the declared value let a host alternating two site keys warn every beat, and
// keying on a drifted/not-drifted flag was no better: the flag flips just as
// easily as the value, whether the host alternates two orgs or alternates one
// org with silence. Both were measured at ~10 warns per 20 beats. Interpolated
// keys are capped on BOTH sides — they are agent-supplied and uncapped upstream,
// and a 100 KB siteKey wrote a 100 KB log line.
const orgDriftWarned = new Map();
const ORG_KEY_LOG_MAX = 80;
const ORG_DRIFT_WARN_EVERY_MS = 10 * 60 * 1000;
function warnOrgDrift(key, a) {
  if (!orgDrifted(a)) return;
  const now = Date.now();
  const last = orgDriftWarned.get(key) || 0;
  if (now - last < ORG_DRIFT_WARN_EVERY_MS) return;
  orgDriftWarned.set(key, now);
  const claimed = siteKeyOf(a).slice(0, ORG_KEY_LOG_MAX);
  console.warn(
    `heartbeat from ${logName(key)}: declares org ${JSON.stringify(claimed)} ` +
      `but is bound to ${JSON.stringify(boundOrgOf(a).slice(0, ORG_KEY_LOG_MAX))} ` +
      `— serving it no peers beyond its own sessions while it says so. The ` +
      `binding does not move; a beat that declares the bound org again is served ` +
      `normally. If this host really moved org, remove it ` +
      `(DELETE /api/agents/<host>) and let it re-register.`
  );
}

// A host declaring a different org than the one it is bound to. Either it was
// reconfigured (remove the host; the binding goes with the record) or a token
// holder is trying to change orgs. Both get the same answer: no peers but its
// own, and it is excluded from everyone else's roster.
function orgDrifted(a) {
  const bound = boundOrgOf(a);
  const claimed = siteKeyOf(a);
  // Drift is DECLARING A DIFFERENT ORG, not failing to declare one. A host that
  // sends no `jira` block — tracker never configured, configuration removed, or
  // simply a beat that omits it — asserts nothing, so there is nothing to
  // disagree with: it keeps its binding and its peers. Treating "" as drift
  // locked such a host out of its own roster AND out of migration on the beat
  // its tracker went quiet, which is a self-inflicted outage, not a boundary.
  // The attack this exists for still trips it: joining another org means
  // declaring that org, which is non-empty and different.
  return !!bound && !!claimed && claimed !== bound;
}

// One host's running sessions, appended until the roster is FULL. The cap has to
// bound what is BUILT, not what is returned: capping cell width alone left the
// row COUNT unbounded, and nothing limits how many running sessions a heartbeat
// may declare — a ~3.8 MB record buys ~60,000 of them, and materialising four
// such hosts' rows before slicing to 120 OOM-killed a 256 MiB hub 3/3 while a
// pre-roster hub served the identical load at 156 MB. Build 120 rows, never
// 240,000 and then 120.
function pushPeerRows(rows, host, a) {
  for (const s of a.sessions || []) {
    if (rows.length >= PEERS_MAX_ROWS) return;
    if (!s || s.status !== "running") continue;
    const t = s.ticket || {};
    const task = t.key ? `${t.key} ${t.summary || ""}` : (s.summary || s.label || "");
    rows.push({
      id: peerCell(s.id),
      name: peerCell(s.rcName),
      host: peerCell(host),
      repo: peerCell(s.repo),
      // The branch the agent named for itself; "" reads as detached agent-side.
      branch: peerCell((s.git && s.git.liveBranch) || ""),
      task: peerCell(task),
    });
  }
}

function orgPeers(key) {
  const me = agents[key];
  if (!me) return [];
  // A drifted host is treated exactly as an org-less one: it still sees its own
  // sessions, which it already knows, and nothing else.
  const org = orgDrifted(me) ? "" : boundOrgOf(me);
  const now = Date.now();
  const rows = [];
  // This host FIRST, so its own rows are the ones that survive a full roster:
  // the peer in the next worktree is likelier to be worth a message than one
  // two hosts away.
  pushPeerRows(rows, key, me);
  if (!org) return rows;
  for (const [host, a] of Object.entries(agents)) {
    if (rows.length >= PEERS_MAX_ROWS) break;
    if (!a || host === key) continue;
    // No org of its own means no peers of its own; a drifted host is excluded
    // from everyone else's roster as well as getting none of its own.
    if (boundOrgOf(a) !== org || orgDrifted(a)) continue;
    // An offline host's sessions cannot take delivery, and a name that only
    // absorbs a message is worse than no name at all.
    if (now - (a.lastSeen || 0) >= OFFLINE_AFTER_MS) continue;
    pushPeerRows(rows, host, a);
  }
  return rows;
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
    if (oldest) { dropMigrationBlob(oldest); migrations.delete(oldest.id); }
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
      // Which runtime the moved session ran on (XERK-460), re-validated against
      // the target's own dsh capability (a move onto a host without dsh falls
      // back to claude), the same story as modelSource above.
      agentType: s.agentType || null,
      // And WHICH self-hosted model + window (XERK-489), carried so a moved
      // local session keeps it — the target re-validates against its own
      // discovered set and falls back to its default when it serves a different
      // one.
      localModelName: s.localModelName || null,
      localModelContext: s.localModelContext || null,
      summary: s.summary || null,
      summaryManual: s.summaryManual || null,
      label: s.label || null,
      ticket: s.ticket || null,
    },
    phase: "exporting", // exporting -> importing -> done | failed
    // The bundle is spooled to disk, so the record carries only where it is and
    // how big it is (for the target's Content-Length) — see MIGRATE_SPOOL_DIR.
    blobPath: null, blobSize: 0, uploading: false,
    importCmdId: null, targetSessionId: null,
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

// Restore an ARCHIVED session onto a live host (XERK-441).
//
// A migration relays a RUNNING session's transcript from the source agent. The
// hub's own archive holds the same bytes for every session that ENDED — its raw
// layer is a byte-for-byte copy of the session's own files (XERK-338) — so the
// host being gone is not a reason its work is unreachable.
//
// The target half is unchanged: this writes the same bundle `_pack_transcript`
// would have (`<id>.jsonl`, `<id>/subagents/…` relative to the project-slug dir)
// into the same spool and hands it to the same `importSession`, so the agent
// needs no new command and the download, unpack, worktree re-creation and resume
// are the code that already moves a live session.
//
// The record IS a migration record with no `srcHost`: there is nothing to export
// from and nothing to kill on handoff (`advanceMigrations` already skips the kill
// when the source host is absent), so it starts in `exporting` — meaning "the hub
// is packing" — and flips to `importing` once the spool file is written. That
// keeps every phase, timeout, refusal and follow-the-spawn path exactly as it is.
//
// Packing is ASYNC and the route does not wait on it: a bundle is tens of MiB off
// /data, and the hub serves every other client on this one loop.
function startArchiveRestore(row, files, targetHost) {
  if (migrations.size >= MIGRATIONS_MAX) {
    let oldest = null;
    for (const m of migrations.values()) {
      if (m.phase === "done" || m.phase === "failed") {
        if (!oldest || m.at < oldest.at) oldest = m;
      }
    }
    if (oldest) { dropMigrationBlob(oldest); migrations.delete(oldest.id); }
  }
  const id = crypto.randomBytes(8).toString("hex");
  const tgt = agents[targetHost] || null;
  const m = {
    id, srcHost: null, srcSessionId: null, targetHost,
    // What this record IS, so the UI can word it as a restore rather than a move
    // — a move that says "moving from nowhere" reads as a bug.
    restore: true,
    siteKey: siteKeyOf(tgt), repo: row.repo,
    transcriptId: row.transcriptId,
    meta: {
      model: null, permissionMode: null, modelSource: null, agentType: null,
      // The archive's own summary is the only name this session still has; the
      // rest of the identity a move carries (model, mode, ticket) lived on the
      // heartbeat of a host that is gone, so the resumed session takes the
      // target's defaults. NOT `summaryManual`: the archive cannot tell an
      // operator-typed name from a derived one, and claiming manual would stop
      // the agent ever re-deriving it.
      summary: row.summary || null, summaryManual: false,
      label: null, ticket: null,
    },
    phase: "exporting",
    blobPath: null, blobSize: 0, uploading: false,
    importCmdId: null, targetSessionId: null,
    refusal: null,
    error: null, startedAt: Date.now(), at: Date.now(),
  };
  migrations.set(id, m);
  publishMigrations();

  const spool = migrationSpoolPath(id);
  tar.packGzipTar(files, spool, MIGRATE_BLOB_MAX, { mtimeSec: Date.now() / 1000 })
    .then((out) => {
      // The record may have been failed or swept while the bytes were being
      // written — the same race the migration relay's upload settles (a timeout
      // can land mid-pack). Advancing anyway would queue an importSession for a
      // restore the operator was already told had failed.
      if (!migrations.has(id) || m.phase !== "exporting") {
        try { fs.unlinkSync(spool); } catch {}
        return;
      }
      // Never silent: a member the tar format cannot name, or a raw file shorter
      // than the archive recorded, means the restored session is missing
      // something. The conversation itself is checked at the route (a bundle
      // without it is refused), so this is about the extras.
      const missing = [...out.skipped, ...out.short];
      if (missing.length) {
        console.warn(`restore ${id}: bundle is incomplete — ` +
          `${out.skipped.length} unnameable, ${out.short.length} short: ` +
          missing.slice(0, 5).join(", "));
        // The CONVERSATION itself cannot be one of them. A skipped `<id>.jsonl`
        // restores an empty session and a NUL-padded one restores a corrupt
        // transcript, and `claude --resume` would present either as the operator's
        // history. Better to refuse the restore than to hand back a damaged one.
        const conv = `${row.transcriptId}.jsonl`;
        if (missing.includes(conv)) {
          m.phase = "failed";
          m.error = "the archived conversation could not be packed intact";
          m.at = Date.now();
          try { fs.unlinkSync(spool); } catch {}
          publishMigrations();
          return;
        }
        // Everything else rides, but the record SAYS SO. A restore that silently
        // drops a subagent transcript and reports `done` tells the operator they
        // have their session back when part of it is gone.
        m.incomplete = {
          skipped: out.skipped.slice(0, INCOMPLETE_NAMES_MAX),
          short: out.short.slice(0, INCOMPLETE_NAMES_MAX),
          total: missing.length,
        };
      }
      m.blobPath = spool;
      m.blobSize = out.bytes;
      m.phase = "importing";
      m.at = Date.now();
      m.importCmdId = queueCommand(targetHost, {
        type: "importSession",
        migrationId: id,
        transcriptId: row.transcriptId,
        // The worktree path as the ARCHIVED host recorded it. The agent's
        // `_localize_migrated_cwd` remaps its mount-independent
        // `.turma/worktrees/<repo>/<dir>` tail onto THIS host's REPOS_ROOT, which
        // is the same remap a cross-mount move relies on.
        cwd: row.worktree,
        repo: row.repo,
        summary: m.meta.summary,
        summaryManual: m.meta.summaryManual,
        // Where this conversation came from, for the resumed session's own
        // record. `sessionId` is null — an archived session has no live id, and
        // inventing one would name a session that does not exist.
        migratedFrom: { host: row.host || null, sessionId: null, at: Date.now(), fromArchive: true },
      });
      publishMigrations();
    })
    .catch((e) => {
      if (!migrations.has(id)) return;
      m.phase = "failed";
      m.error = e && e.tooLarge
        ? `this session's archived files are larger than the ${MIGRATE_BLOB_MAX}-byte bundle ceiling`
        : "packing the archived session failed";
      m.at = Date.now();
      dropMigrationBlob(m);
      publishMigrations();
      console.error(`restore ${id}: pack failed: ${e && e.message}`);
    });
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
        dropMigrationBlob(m);
        m.at = now;
        if (agents[m.srcHost]) {
          queueCommand(m.srcHost, { type: "kill", sessionId: m.srcSessionId });
        }
        publishMigrations();
        continue;
      }
    }
    // A RESTORE only. The "one conversation, one session" check runs at
    // admission, and the importing window is up to MIGRATE_TIMEOUT_MS — long
    // enough for the archived host to come back and beat in with that very
    // conversation running, at which point finishing would put two claudes on one
    // transcript, exactly what the admission check exists to prevent. A live
    // move needs no equivalent: its source is running BY DESIGN, and it is killed
    // at handoff. The target is skipped, since its own import is the success
    // above; read after that handoff so a completed restore always wins the tie.
    if (m.restore && (m.phase === "exporting" || m.phase === "importing")) {
      for (const [host, a] of Object.entries(agents)) {
        // ONLINE hosts only, exactly as at admission. A host that died with the
        // session running keeps `status: "running"` for PRUNE_AFTER_MS — seven
        // days — so without this the restore is admitted (the admission check
        // skips it) and then killed one tick later by the same dead host, with an
        // error asserting it "came back up". That is worse than the old refusal:
        // the operator has now also spent an in-flight slot, a spool file and a
        // pack, and the agent 404s the download it was told to make.
        if (Date.now() - (a.lastSeen || 0) >= OFFLINE_AFTER_MS) continue;
        const live = (a.sessions || []).find(
          (s) => s.transcriptId === m.transcriptId && s.status === "running" &&
                 // Never the migration's OWN imported session. Belt-and-braces
                 // today — the handoff above matches the same predicate and
                 // `continue`s first, so this cannot currently fire — but it is
                 // what makes the rule true independently of that ordering.
                 //
                 // What it must NOT do is skip the whole TARGET, which leaves the
                 // one host that actually unpacks unchecked: `import_session`
                 // downloads and unpacks BEFORE `_resume_at_cwd` refuses, so a
                 // conversation resumed locally on the target between admission
                 // and its next beat has the archived bytes written over it.
                 s.spawnCmdId !== m.importCmdId);
        if (!live) continue;
        m.phase = "failed";
        m.error = `that conversation came back up on ${host} — the restore was ` +
                  "abandoned rather than run a second claude on it";
        dropMigrationBlob(m);
        m.at = now;
        publishMigrations();
        break;
      }
      if (m.phase === "failed") continue;
    }
    // The agent REFUSED its half of the move and said so on a beat (XERK-265):
    // fail now, carrying its reason, instead of leaving the operator watching a
    // move that can no longer complete for the whole MIGRATE_TIMEOUT_MS. Read
    // after the handoff above so a success always wins the tie, and covers both
    // halves — an export that never shipped a blob as well as a refused import.
    if ((m.phase === "exporting" || m.phase === "importing") && m.refusal) {
      m.phase = "failed";
      m.error = m.refusal;
      dropMigrationBlob(m);   // the spool file, exactly as the timeout below
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
      dropMigrationBlob(m);
      m.at = now;
      publishMigrations();
      continue;
    }
    // Retire a settled record after a short grace so open UIs can observe the
    // terminal state before it disappears.
    if ((m.phase === "done" || m.phase === "failed") &&
        now - m.at > MIGRATE_DONE_KEEP_MS) {
      dropMigrationBlob(m); // settling already dropped it; this is the backstop
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
function normalizeModelUsage(usage, tally) {
  if (!usage) return;
  // A non-array `models` is DELETED, not left alone. Returning early here only
  // held while `models` was untyped: `for (const m of list || [])` throws on an
  // object, and the dashboard builds its whole body in one pass, so ONE host
  // beating `"models": {...}` blanked the front page for EVERY operator — tiles,
  // host list and all, nav only. Android types it (`List<ModelUsage>`, defaulted
  // to empty), and a full /api/agents decode is atomic there, so the same beat
  // empties every OTHER host from every phone's fleet.
  //
  // Absent rather than `[]`, matching the siblings: absent is what every client
  // reads as "this agent can't tell you". The distinction is weak downstream —
  // an ARRAY of junk still ends up `[]` below, and the ledger re-serves `[]` for
  // any host with history — so this is consistency, not a guarantee to lean on.
  //
  // And it is TALLIED. Before this the failure was loud (a blank dashboard); a
  // silent delete is invisible data loss with nothing to alert on, while every
  // other coercion in this file says what it dropped.
  if (!Array.isArray(usage.models)) {
    if ("models" in usage) {
      const deliberate = usage.models === null;
      delete usage.models;
      // A null is the agent saying "nothing to report", exactly as it is for the
      // usage block itself two functions down — tallying it would warn that this
      // host's "token figures understate what it really spent", which is false.
      if (!deliberate) noteUsageCoercion(tally, "models");
    }
    return;
  }
  usage.models = usage.models
    .map((m) => (typeof m === "string" ? { model: m } : m))
    .filter((m) => m && typeof m.model === "string" && m.model);
}

// The sub-agent split (XERK-302): what share of a usage block was spent by the
// background agents its sessions delegated to. Coerced here for exactly the
// reason the model lists above are — Android TYPES it, so one host's
// `subagent: "lots"` would fail the decode of the WHOLE /api/agents array and
// silently empty every other host from that phone's fleet.
//
// Anything unusable becomes ABSENT, never a zeroed block: absent is what every
// client already reads as "this agent can't tell you" (an agent predating the
// field reports none), while a zeroed one asserts that nothing was delegated —
// and the Usage page divides by these, so a fabricated zero would quietly
// understate the fleet's delegated share instead of excluding the host.
//
// So this VALIDATES rather than repairs, which is the only way to keep that
// promise: repairing junk into a well-formed all-zero block is indistinguishable
// from a host that genuinely delegated nothing, and both `{}` and
// `{totals:{input:"9"}}` would land in the denominator with a fabricated 0 on
// top. A real agent always sends all three windows (`_finalize_usage` builds
// them unconditionally), so strictness costs a working host nothing.
//
// A figure must be a NON-NEGATIVE SAFE INTEGER, not merely a finite number: this
// is decoded into a Kotlin `Long`, and a float or a 1e308 serialized back out
// fails the decode of the WHOLE /api/agents array — killing the fleet list on
// every phone over one host's bad figure. A MISSING key is 0 (a newer agent may
// add fields; silence is not a false claim), but a key that is present and
// unusable invalidates the block.
function normalizeSubagentUsage(usage) {
  if (!usage || typeof usage !== "object") return;
  const s = usage.subagent;
  const drop = () => { if ("subagent" in usage) delete usage.subagent; };
  if (!s || typeof s !== "object" || Array.isArray(s)) return drop();
  const out = {};
  for (const w of ["totals", "today", "week"]) {
    const b = s[w];
    if (!b || typeof b !== "object" || Array.isArray(b)) return drop();
    const clean = {};
    for (const k of ["input", "output", "cacheWrite", "cacheRead"]) {
      const v = b[k];
      if (v === undefined || v === null) { clean[k] = 0; continue; }
      if (!Number.isSafeInteger(v) || v < 0) return drop();
      clean[k] = v;
    }
    out[w] = clean;
  }
  usage.subagent = out;
}

// The token FIGURES themselves (XERK-306). A bucket's four counts are Kotlin
// `Long`s on Android (UsageBucket) and a full /api/agents decode is ATOMIC
// there, so ONE host reporting `1.5` or `1e308` for a single figure throws for
// the WHOLE array: every OTHER host silently vanishes from that phone's fleet
// list while the tile still reads "N / N online". XERK-302 closed this for the
// `subagent` block alone; these are its siblings — the host/repo/session
// windows, the per-day buckets, and each model's windows.
//
// A figure must be a NON-NEGATIVE SAFE INTEGER, the rule normalizeSubagentUsage
// established. But an unusable one here is REWRITTEN to 0 rather than
// invalidating its block: absent totals is not a meaningful "can't tell you"
// the way an absent `subagent` is — every client renders these unconditionally
// and an agent that reports usage at all reports all three windows. That
// silently UNDERSTATES the host, which is why it is logged.
//
// Nothing is ever filled IN. A missing key stays missing (every client defaults
// it to 0), because this walk runs before the SECOND AGENT_RECORD_MAX
// measurement and `{}` → `{"input":0,"output":0,"cacheWrite":0,"cacheRead":0}`
// is a ~25x expansion on a `days` map whose size the agent chooses. Rewriting a
// figure that is PRESENT can only shrink the record: no JSON number that fails
// the test above is shorter than `0`.
//
// The key list is a LITERAL in each walk below, never a module `const`: this
// runs from `loadState`, which is above any such declaration and would read it
// in its TDZ — a ReferenceError there lands in the restore's catch and empties
// the WHOLE registry on boot (the restore-TDZ rule in .claude/rules/turma.md).

// One `owner[key]` bucket, in place. A bucket that is not an object at all is
// DELETED rather than rebuilt: it holds no figure worth keeping, deleting can
// never expand the record, and every client already reads an absent window as
// zeros. A stringified figure ("9") counts as unusable on purpose — it is what
// the wire type says it isn't, and the web's `+=` would concatenate it.
function normalizeTokenBucket(owner, key, tally) {
  if (!objectish(owner) || !(key in owner)) return;
  const bucket = owner[key];
  if (!objectish(bucket)) {
    delete owner[key];
    noteUsageCoercion(tally, key);
    return;
  }
  for (const k of ["input", "output", "cacheWrite", "cacheRead"]) {
    if (!(k in bucket)) continue;
    if (Number.isSafeInteger(bucket[k]) && bucket[k] >= 0) continue;
    bucket[k] = 0;
    noteUsageCoercion(tally, `${key}.${k}`);
  }
}

// Every bucket one usage block carries.
function normalizeUsageTokens(usage, tally) {
  if (!objectish(usage)) return;
  for (const w of ["totals", "today", "week"]) normalizeTokenBucket(usage, w, tally);
  // `days` is a `Map<String, UsageBucket>` on Android, so a non-object (an
  // ARRAY, say) is decode-fatal on its own, before any figure inside it counts.
  if ("days" in usage) {
    if (!objectish(usage.days)) {
      delete usage.days;
      noteUsageCoercion(tally, "days");
    } else {
      for (const d of Object.keys(usage.days)) normalizeTokenBucket(usage.days, d, tally);
    }
  }
  // Runs after normalizeModelUsage, which has already dropped every entry that
  // is not an object with a name.
  if (Array.isArray(usage.models)) {
    for (const m of usage.models) {
      for (const w of ["totals", "today", "week"]) normalizeTokenBucket(m, w, tally);
    }
  }
  // Typed `String` on Android — a number here is as decode-fatal as a float
  // figure, and it rides the same block.
  if ("lastActivity" in usage && typeof usage.lastActivity !== "string") {
    delete usage.lastActivity;
    noteUsageCoercion(tally, "lastActivity");
  }
}

// Every coercion a usage block needs, wherever one rides the heartbeat.
function normalizeUsageBlock(usage, tally) {
  normalizeModelUsage(usage, tally);
  normalizeSubagentUsage(usage);
  normalizeUsageTokens(usage, tally);
}

// A usage block hangs off its owner under a known key; a non-object one is
// decode-fatal on Android (`UsageInfo`), so it is DROPPED — deleting shrinks the
// record where rewriting it to `null` would grow it.
//
// An explicit `null` is DROPPED THE SAME WAY BUT NOT TALLIED, because it is the
// agent's deliberate "nothing to report" rather than a value it got wrong: a
// host reports `usage: null` until it has spent something (`host_usage` in
// hub-agent.py), and a session's is `null` until its transcript has a usage
// block. Counting those made a brand-new host warn on EVERY beat that its
// "token figures understate what it really spent" — false, since it had spent
// nothing, and it drowned the real signal at ~1 line per beat per new host.
// Anything else non-object is still a host getting the shape wrong, and still
// says so.
function dropUnusableUsage(owner, tally) {
  if (!objectish(owner) || !("usage" in owner)) return;
  if (objectish(owner.usage)) return;
  const deliberate = owner.usage === null;
  delete owner.usage;
  if (!deliberate) noteUsageCoercion(tally, "usage");
}

// Every place a usage block rides the heartbeat: the host-wide aggregate, the
// per-repo ones, and each live session's own.
function normalizeUsage(payload) {
  if (!payload || typeof payload !== "object") return;
  const tally = { count: 0, first: "" };
  dropUnusableUsage(payload, tally);
  normalizeUsageBlock(payload.usage, tally);
  // `Array.isArray`, not `|| []`: a non-iterable `repoUsage`/`sessions` (an
  // OBJECT, say) makes a bare `for…of` THROW, and a throw here is uniquely
  // costly — on the restore path it lands in a silent `catch {}` and abandons
  // every host after this one, uncoerced, on every boot.
  // Both are typed LISTS on Android, so a non-array is decode-fatal for the
  // WHOLE fleet payload, not just this host — rewrite it rather than merely
  // stepping around it. (Safe because normalizeRecord runs past the raw-size
  // gate; before it, this would have shrunk away an amplifier.)
  if (!Array.isArray(payload.repoUsage)) {
    if ("repoUsage" in payload) payload.repoUsage = [];
  } else {
    // `List<RepoUsage>` on Android, so a `null` or a bare string IN the list is
    // as fatal as a bad figure inside one — the same drop normalizeSessions
    // makes over `sessions`.
    if (!payload.repoUsage.every(objectish)) {
      payload.repoUsage = payload.repoUsage.filter(objectish);
      noteUsageCoercion(tally, "repoUsage[]");
    }
    for (const r of payload.repoUsage) {
      // Typed `String` on both, and deleting is what every client already reads
      // as "unnamed" — rewriting to `String(r.repo)` could grow the record.
      for (const k of ["repo", "remoteKey"]) {
        if (k in r && typeof r[k] !== "string") {
          delete r[k];
          noteUsageCoercion(tally, `repoUsage.${k}`);
        }
      }
      dropUnusableUsage(r, tally);
      normalizeUsageBlock(r.usage, tally);
    }
  }
  if (Array.isArray(payload.sessions)) {
    // Guarded rather than assuming normalizeSessions ran first: order in
    // normalizeRecord is deliberately NOT load-bearing.
    for (const s of payload.sessions) {
      dropUnusableUsage(s, tally);
      normalizeUsageBlock(s && s.usage, tally);
    }
  }
  logUsageCoercion(payload, tally);
}

function noteUsageCoercion(tally, where) {
  if (!tally) return;
  tally.count += 1;
  if (!tally.first) tally.first = where;
}

// Test-only, and exported only under TURMA_TEST: the throttle below is
// fleet-wide module state, so one test spending the window silences the next.
function resetUsageCoercionLog() {
  usageCoercionLogAt = 0;
  usageCoercionSuppressed = 0;
}

// Coercing a figure to 0 UNDERSTATES the host rather than excluding it, so it
// must not be silent. Throttled process-wide (a beat arrives every few seconds
// and a host reporting one bad figure reports it forever) — the throttle's own
// state is declared with the other log throttles, above `loadState`, because
// the restore reaches this too. The example path goes through logName: a `days`
// key is agent-authored text that would otherwise forge a log line.
function logUsageCoercion(payload, tally) {
  if (!tally.count) return;
  usageCoercionSuppressed += 1;
  const now = Date.now();
  if (now - usageCoercionLogAt < USAGE_COERCION_LOG_EVERY_MS) return;
  const also = usageCoercionSuppressed > 1
    ? ` (+${usageCoercionSuppressed - 1} more beats coerced since the last line)` : "";
  usageCoercionLogAt = now;
  usageCoercionSuppressed = 0;
  console.warn(
    `heartbeat from ${logName(payload.device || payload.agentId || "?")}: ` +
      `${tally.count} unusable usage field(s) coerced (first ${logName(tally.first)}) — ` +
      `this host's token figures understate what it really spent${also}`
  );
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

// The subscription grouping key (XERK-301), coerced for the same reason
// normalizeLimits above is: it fans out to web, Android and glasses, and
// Android decodes it into TYPED fields. Anything unusable becomes null — the
// "that host can't tell you" value every client already handles by leaving the
// host on a card of its own, never a plausible default, since a bogus shared
// key would fold two unrelated subscriptions into one set of bars.
//
// The bounds are LITERALS here, exactly as normalizeLimits' are. Every
// normalize* is reached from `loadState`'s restore loop, which runs far above
// this line and is only legal because function declarations hoist — a module
// `const` up here would be in its TDZ there, and the ReferenceError lands in
// the restore's catch, which empties the whole registry. 128 bounds the key:
// the agent emits 16 hex chars, so this is the boundary's bound rather than
// that length, and it exists because the key is a MAP KEY on every client, so
// an unbounded one is a per-beat amplification of the XERK-235 kind.
function normalizeSubscription(payload) {
  if (!payload || typeof payload !== "object") return;
  const sub = payload.subscription;
  if (!sub || typeof sub !== "object" || Array.isArray(sub)) {
    if ("subscription" in payload) payload.subscription = null;
    return;
  }
  const key = typeof sub.key === "string" ? sub.key.trim() : "";
  if (!key) {
    payload.subscription = null;
    return;
  }
  const out = { key: key.slice(0, 128) };
  if (typeof sub.source === "string") out.source = sub.source.slice(0, 32);
  payload.subscription = out;
}

// Coerce the local-model block at ingest, for exactly the reason normalizeLimits
// above does it (XERK-246): this fans out to web, Android and glasses, and
// Android decodes it into TYPED fields — `available: Boolean`, `contextTokens:
// Int?` — so an `available` of "yes" or a contextTokens past 2^31 from ONE buggy
// host fails the decode of the WHOLE /api/agents array, and every other host
// silently vanishes from that phone's fleet.
//
// Anything unusable becomes null, which every client already reads as "this host
// cannot fail over" — the same degradation as an agent too old to report it.
//
// XERK-489 adds the discovered `models[]` and `defaultModel`. The array is a
// WHITELIST, bounded in LENGTH and per-element — Android decodes /api/agents
// atomically, so an endpoint answering thousands of ids, or one malformed
// entry, from ONE host would drop the whole fleet from every phone (the
// PEER_CELL_MAX / retiredUsage failure class the ticket calls out).
const LOCAL_MODEL_LIST_MAX = 200;
// Bound a model name to 60 code points, stripping the XML-illegal class that
// breaks Android's uiautomator dump, exactly like the single `model` field
// below. Cut on CODE POINTS (after the strip) so a slice never manufactures a
// lone surrogate. Returns "" for anything unusable.
function sanitizeModelName(s) {
  if (typeof s !== "string") return "";
  return [...s.slice(0, 512)
    .replace(/\p{Surrogate}/gu, "�")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f￾￿]/g, "")
    .trim()]
    .slice(0, 60).join("");
}
// A positive int-safe context window, or null — the field is Int? on Android,
// so a float / out-of-range / non-number must degrade to null, never throw.
function sanitizeContextTokens(ctx) {
  return typeof ctx === "number" && Number.isSafeInteger(ctx) &&
    ctx > 0 && ctx <= 2_147_483_647 ? ctx : null;
}
function normalizeLocalModel(payload) {
  if (!payload || typeof payload !== "object") return;
  const lm = payload.localModel;
  if (!lm || typeof lm !== "object" || Array.isArray(lm)) {
    if ("localModel" in payload) payload.localModel = null;
    return;
  }
  // Strictly boolean: a truthy string would turn a host that cannot fail over
  // into one the UI offers the switch on, and the command would be dropped.
  if (lm.available !== true) {
    payload.localModel = {
      available: false, model: null, contextTokens: null,
      models: [], defaultModel: null,
    };
    return;
  }
  // Nothing XML-ILLEGAL may leave here, from either direction — the whole class,
  // not just the one case that bit us. A lone surrogate, a C0 control and the
  // noncharacters U+FFFE/U+FFFF are all unencodable in XML, and each kills
  // Android's `uiautomator dump` outright (`KXmlSerializer: Illegal character`
  // / a 0-byte file), i.e. the tool a QA pass drives the app with. Cutting with
  // `slice(60)` through an astral pair MANUFACTURES a lone surrogate, so that
  // cut is on CODE POINTS and runs after the strip. Only a rogue agent reaches
  // this — a real one is bounded by LOCAL_MODEL_NAME_RE — which is this
  // function's whole threat model.
  //
  // BOUND FIRST, THEN SPREAD. `[...s]` materialises one array element per code
  // point over the WHOLE string, and this runs BEFORE the AGENT_RECORD_MAX check
  // that refuses an oversized beat — so spreading the raw value let a single
  // agent-authed heartbeat with a 24 MiB name OOM-kill the hub at its deployed
  // `mem_limit: 256m` (32M chars measured at 288 MB heap), which
  // `restart: unless-stopped` turns into an outage loop of the fleet's whole
  // control plane. 512 UTF-16 units is far more than the 60 code points that
  // survive, and cutting there can only split an astral pair — which the
  // surrogate replace immediately below then handles.
  const name = sanitizeModelName(lm.model);
  // The discovered set: [{id, contextTokens|null}]. Bound the length first, then
  // sanitize each entry; an id that sanitizes to "" is DROPPED (a nameless row
  // the dropdown could not label). Deduped by id so a doubled entry can't pad it.
  const models = [];
  const seen = new Set();
  if (Array.isArray(lm.models)) {
    for (const m of lm.models) {
      if (models.length >= LOCAL_MODEL_LIST_MAX) break;
      if (!m || typeof m !== "object" || Array.isArray(m)) continue;
      const id = sanitizeModelName(m.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, contextTokens: sanitizeContextTokens(m.contextTokens) });
    }
  }
  // defaultModel must be one the sanitized list carries (else the dropdown would
  // preselect a value it can't show); fall back to the single `name`.
  const def = sanitizeModelName(lm.defaultModel);
  const defaultModel = (def && seen.has(def)) ? def : (name || null);
  payload.localModel = {
    available: true,
    // The name is display-only here (the agent validates its own charset before
    // launching), but it must be A STRING or the decode dies.
    model: name || null,
    // Int-safe or nothing: dropping a bad one costs nothing and keeps the fleet
    // decodable.
    contextTokens: sanitizeContextTokens(lm.contextTokens),
    models,
    defaultModel,
  };
}

// The dsh-runtime capability flag (XERK-460), the exact shape and threat model as
// normalizeLocalModel: Android decodes /api/agents atomically into typed fields,
// so one host's `dsh.available: "yes"` would fail the whole fleet decode. Strictly
// boolean, so a non-`true` value — a truthy string included — reads as "this host
// cannot do dsh", which is what makes the composer HIDE the runtime selector for
// it rather than queue a spawn the host will refuse.
function normalizeDsh(payload) {
  if (!payload || typeof payload !== "object") return;
  const d = payload.dsh;
  if (!d || typeof d !== "object" || Array.isArray(d)) {
    if ("dsh" in payload) payload.dsh = null;
    return;
  }
  // With the fleet-wide kill switch off, the served block is fully INERT — no
  // capability, no discovered models, no default, no web viewer — so nothing
  // dsh-shaped rides /api/agents to any client (web, Android, glasses) even when
  // an agent reports the capability. Zeroing `models`/`defaultModel` too (not
  // just `available`) matters because the hub's own `/model` route reads
  // `dsh.models` via `dshServes`: leaving them would keep a dsh code path live
  // with the switch off. The full coercion below runs only with the flag on, so
  // re-enabling needs no further change here.
  if (!DSH_ENABLED) {
    payload.dsh = { available: false, models: [], defaultModel: null, contextTokens: null };
    return;
  }
  const out = { available: d.available === true };
  // The endpoint's discovered dsh models (XERK-503), the exact shape and
  // coercion as normalizeLocalModel's — [{id, contextTokens|null}], bound the
  // length first, sanitize each id (drop a nameless row), dedupe. A dsh session
  // offers this so it isn't locked to one model. `defaultModel` is kept whenever
  // it sanitizes (see below — unlike localModel's, it may sit outside the list).
  // Every field is TYPED on Android, so an unusable value must degrade, not
  // decode-fail the whole fleet array.
  const models = [];
  const seen = new Set();
  if (Array.isArray(d.models)) {
    for (const m of d.models) {
      if (models.length >= LOCAL_MODEL_LIST_MAX) break;
      if (!m || typeof m !== "object" || Array.isArray(m)) continue;
      const id = sanitizeModelName(m.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, contextTokens: sanitizeContextTokens(m.contextTokens) });
    }
  }
  out.models = models;
  // Unlike localModel's, a dsh default may legitimately sit OUTSIDE the
  // discovered list — the zero-config case is a single configured DSH_MODEL with
  // discovery not landed — so it is kept whenever it sanitizes, not gated on the
  // list carrying it.
  out.defaultModel = sanitizeModelName(d.defaultModel) || null;
  out.contextTokens = sanitizeContextTokens(d.contextTokens);
  // The host-wide read-only `dsh web` viewer (XERK-501, agent `_dsh_web_payload`): kept
  // only when the agent reports it UP, as a whitelisted {running, port, url}.
  // A new sub-key a newer agent adds is dropped unless added here (like every
  // normalize*). `url` is length-capped on the wire (the XERK-348 peer-cell
  // lesson: an uncapped agent-set string is a memory hazard); a non-string or
  // an absent url becomes null, which the clients render as host-only text.
  const w = d.web;
  if (DSH_ENABLED && w && typeof w === "object" && !Array.isArray(w) && w.running === true) {
    // The url flows to an anchor href on the client, so accept ONLY http(s):
    // — an agent-set javascript:/data: value is dropped to null here rather
    // than trusted downstream (defence in depth; not a live XSS on Chromium).
    const rawUrl = typeof w.url === "string" ? w.url.slice(0, DSH_WEB_URL_MAX) : "";
    out.web = {
      running: true,
      port: Number.isFinite(w.port) ? w.port : null,
      url: /^https?:\/\//i.test(rawUrl) ? rawUrl : null,
    };
  }
  payload.dsh = out;
}

// The qwen (Qwen Code, XERK-504) capability block, coerced at ingest exactly
// like normalizeDsh and for the same reason: Android TYPES it (AgentInfo.qwen),
// and `/api/agents` decodes atomically there, so one host's `qwen.available:
// "yes"` would fail the whole fleet decode. Strictly boolean, so a non-`true`
// value — a truthy string included — reads as "this host cannot do qwen", which
// is what makes the composer HIDE the runtime option for it rather than queue a
// spawn the host will refuse. With the fleet-wide kill switch off the served
// block is fully INERT ({available:false}), so nothing qwen-shaped rides
// /api/agents to any client even when an agent reports the capability.
function normalizeQwen(payload) {
  if (!payload || typeof payload !== "object") return;
  const q = payload.qwen;
  if (!q || typeof q !== "object" || Array.isArray(q)) {
    if ("qwen" in payload) payload.qwen = null;
    return;
  }
  if (!QWEN_ENABLED) {
    payload.qwen = { available: false };
    return;
  }
  payload.qwen = { available: q.available === true };
}

// The triage (XERK-481) capability block, coerced at ingest exactly like
// normalizeQwen/normalizeDsh and for the same reason: it is agent-supplied, a
// client TYPES it (AgentInfo.triage: TriageInfo?), and `/api/agents` decodes
// atomically on Android — so one host's `triage.available: "yes"` would fail the
// whole fleet decode and empty every other host from every phone's fleet list.
// Strictly boolean, so a non-`true` value — a truthy string included — reads as
// "this host cannot triage". Unusable becomes NULL (never a rebuilt {available:
// true}), and absent means absent: an agent predating triage carries no block,
// which clients read as "that host can't triage", never as "triaged, unknown".
// The per-ticket ASSESSMENT rides jira.tickets[].triage and is coerced in
// normalizeJira; this is only the top-level capability flag.
function normalizeTriage(payload) {
  if (!payload || typeof payload !== "object") return;
  const t = payload.triage;
  if (!t || typeof t !== "object" || Array.isArray(t)) {
    if ("triage" in payload) payload.triage = null;
    return;
  }
  payload.triage = { available: t.available === true };
}

// This host's EFFECTIVE default runtime for an unpinned spawn (XERK-521), coerced
// at ingest exactly like normalizeQwen/normalizeDsh and for the same reason: it
// is agent-supplied, a client may TYPE it, and `/api/agents` decodes atomically
// on Android, so one host's `defaultRuntime: 123` would fail the whole fleet
// decode. Coerced to the fixed runtime enum; anything else — a non-string, an
// unknown value, or ABSENT (a pre-XERK-521 agent) — reads as "claude", the same
// "can't tell / unchanged" value the composer treats an absent field as, never a
// plausible other default. A runtime whose fleet-wide kill switch is OFF here is
// also forced to "claude", so the served default stays CONSISTENT with the
// zeroed capability block a disabled runtime reports (a composer must not
// pre-select a runtime whose option normalizeQwen/normalizeDsh just hid).
function normalizeDefaultRuntime(a) {
  if (!a || typeof a !== "object") return;
  if (!("defaultRuntime" in a)) return;
  let r = a.defaultRuntime;
  if (r !== "claude" && r !== "dsh" && r !== "qwen") r = "claude";
  if (r === "dsh" && !DSH_ENABLED) r = "claude";
  if (r === "qwen" && !QWEN_ENABLED) r = "claude";
  a.defaultRuntime = r;
}

// Merge the agent's on-demand history deliveries (heartbeat `historyResults`)
// into the host's per-session cache, then bound its memory: drop entries older
// than HISTORY_MAX_AGE_MS and cap the cache at HISTORY_MAX_SESSIONS, evicting
// the oldest `fetchedAt` first. Runs on every heartbeat ingest, even absent new
// results, so the sweep still bounds memory on quiet hosts.
// Scrollback for a RUNNING session, read from the hub's durable archive, shaped
// as the /history contract. The agent keeps a worktree-backed running session's
// rendered transcript syncing to the archive, so this materializes hub-side and
// serves INSTANTLY — no agent round-trip. Returns null when the archive has
// nothing for this transcript yet (a brand-new session, first few beats), so the
// caller falls back to the queue-and-202 path.
//
// The archive keys entries on `uuid`; the live/history path and the client merge
// (foldHistory) key on `id`, so map uuid -> id here. Bounded to the newest
// HISTORY_ARCHIVE_MSGS; the archive holds the whole transcript.
function archiveHistory(transcriptId) {
  if (!transcriptId) return null;
  let t;
  try { t = archive.getTranscript(transcriptId); } catch { return null; }
  if (!t || !Array.isArray(t.entries) || t.entries.length === 0) return null;
  const all = t.entries;
  const truncated = all.length > HISTORY_ARCHIVE_MSGS;
  const window = truncated ? all.slice(-HISTORY_ARCHIVE_MSGS) : all;
  const entries = window.map((e) => ({
    id: e.uuid, role: e.role, ts: e.ts, text: e.text || "",
    blocks: Array.isArray(e.blocks) ? e.blocks : [],
  }));
  // queued:[] — the still-queued prompt list rides the live tail, not the
  // archive; the client keeps whatever the socket last delivered.
  return { entries, truncated, queued: [], fetchedAt: Date.now(), fromArchive: true };
}

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
// type, so the short description/label disambiguates them. `agentId` is the
// workflow drill-down's fourth component (XERK-304) — a `workflow` row answers
// with an agent LIST under the empty id, and each of that run's agents with its
// own transcript under its own id, so all of them are distinct cache entries.
// NUL-separated because no field can contain it.
function subagentKey(sessionId, type, label, agentId) {
  return String(sessionId) + "\0" + String(type || "") + "\0" +
    String(label || "") + "\0" + String(agentId || "");
}

// A workflow agent id names a file on the agent host, so the hub refuses a
// malformed one outright rather than queueing a command that can only miss.
// The agent pattern-checks it again — this is the cheap half of both-ends.
const SUBAGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// The workflow picker's rows, coerced (XERK-304). Android TYPES this field
// (`HistoryResponse.agents: List<WorkflowAgent>?`), and by this repo's own rule
// typing a field on a client and adding its hub-side coercion are the SAME
// change — an unexpected shape from a heartbeat is otherwise served straight
// through to a decoder that will throw on it. Same shape as sanitizeLiveAgents:
// non-array -> null (the field is then simply absent, which every client reads
// as "not a run"), every value through safeString, length capped.
function sanitizeWorkflowAgents(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const id = safeString(a.id).slice(0, WORKFLOW_AGENT_FIELD_MAX);
    if (!id) continue;
    const row = {
      id,
      label: safeString(a.label).slice(0, WORKFLOW_AGENT_FIELD_MAX),
      startedAt: safeString(a.startedAt).slice(0, WORKFLOW_AGENT_FIELD_MAX),
    };
    // `status` is OMITTED, never blanked. The agent leaves it off when the run's
    // journal cannot say whether an agent finished, and an absent field meaning
    // "that agent can't tell" is the fleet-wide rule — normalizing every row to
    // a full shape would put that back as `""`, so the wire could no longer
    // express the difference the agent went to trouble to preserve.
    // Trimmed, so a whitespace-only value omits rather than becoming a status
    // the web paints as an empty chip and Android hides — the two clients would
    // disagree about a row that says nothing.
    const status = safeString(a.status).trim().slice(0, WORKFLOW_AGENT_FIELD_MAX);
    if (status) row.status = status;
    out.push(row);
    if (out.length >= WORKFLOW_AGENTS_MAX) break;
  }
  return out;
}

// Same lifecycle as ingestHistory, keyed by (session,type,label,agentId) —
// merges the agent's `subagentHistoryResults`, then evicts by age and caps the
// cache.
function ingestSubagentHistory(agent, results) {
  const now = Date.now();
  for (const r of results || []) {
    if (!r || !r.sessionId) continue;
    agent.subagentHistory[subagentKey(r.sessionId, r.type, r.label, r.agentId)] =
      { entries: r.entries, truncated: r.truncated,
        agents: sanitizeWorkflowAgents(r.agents),
        agentsTruncated: !!r.agentsTruncated, fetchedAt: now };
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

// Per-cmdId cache of triage-priority write outcomes (XERK-483), mirroring
// ingestStatusResults: keyed by cmdId so the /priority poll route answers the
// specific write it made, pruned oldest-first on the same bounds as the
// status cache. ALSO folds each outcome into the sweep's suppression map: an
// ERROR suppresses unconditionally for the retry window (a refusing tracker
// must not be hammered), while a successful "skipped" (the value was a
// human's) suppresses only while the tracker still shows the value the agent
// reported — once that changes, the sweep re-evaluates. "written"/"no-op"
// need no suppression of their own: the tracker value now equals the target,
// so the sweep's primary match-check skips the ticket.
function ingestPriorityResults(agent, ticketPriorityResults) {
  const now = Date.now();
  for (const r of ticketPriorityResults || []) {
    if (!r || !r.cmdId) continue;
    agent.priorityResults[r.cmdId] = {
      key: r.key || null, siteKey: r.siteKey || null, band: r.band || null,
      ok: !!r.ok, error: r.error || null, action: r.action || null,
      priority: r.priority ?? null, at: now,
    };
    if (r.siteKey && r.key && r.band) {
      const suppressValue = r.ok && r.action === "skipped"
        ? (r.priority ?? null)
        : null;
      priorityWriteBackSkips.set(
        r.siteKey + "\x00" + r.key + "\x00" + r.band,
        { at: now, prio: suppressValue });
    }
  }
  for (const [id, e] of Object.entries(agent.priorityResults)) {
    if (now - e.at > JIRA_ISSUE_MAX_AGE_MS) delete agent.priorityResults[id];
  }
  const over = Object.keys(agent.priorityResults).length - JIRA_ISSUE_MAX;
  if (over > 0) {
    Object.entries(agent.priorityResults)
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, over)
      .forEach(([id]) => delete agent.priorityResults[id]);
  }
}

// Duplicate-link outcomes (XERK-484): cache by cmdId like priorityResults, and
// fold each into the sweep's suppression map. An ok result ("linked", "no-op",
// or "skipped") suppresses STICKY: the pair is either linked in the tracker, or
// a human removed our link and the agent's ledger keeps it that way — either
// way re-queueing every 15s would be a relink storm. An error suppresses only
// for the retry window, so a tracker that refused (bad link type, permissions)
// is re-tried after DEDUPE_LINK_RETRY_MS instead of every sweep.
function ingestTicketLinkResults(agent, ticketLinkResults) {
  const now = Date.now();
  for (const r of ticketLinkResults || []) {
    if (!r || !r.cmdId) continue;
    agent.linkResults[r.cmdId] = {
      key: r.key || null, twinKey: r.twinKey || null, siteKey: r.siteKey || null,
      ok: !!r.ok, error: r.error || null, action: r.action || null, at: now,
    };
    if (r.siteKey && r.key && r.twinKey) {
      dedupeLinkSkips.set(
        r.siteKey + "\x00" + r.key + "\x00" + r.twinKey,
        { at: now, sticky: !!r.ok });
    }
  }
  for (const [id, e] of Object.entries(agent.linkResults)) {
    if (now - e.at > JIRA_ISSUE_MAX_AGE_MS) delete agent.linkResults[id];
  }
  const over = Object.keys(agent.linkResults).length - JIRA_ISSUE_MAX;
  if (over > 0) {
    Object.entries(agent.linkResults)
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, over)
      .forEach(([id]) => delete agent.linkResults[id]);
  }
}

// How long a staged session-start refusal (XERK-265) stays readable, and how
// many one host may hold. It exists to answer a wait that is already running —
// the Sessions page's SPAWN_FOLLOW_MS, or a migration — so minutes is generous.
const SPAWN_FAILURE_MAX_AGE_MS = 10 * 60 * 1000;
const SPAWN_FAILURE_MAX = 40;
// And how long one reason / one cmdId key may be. These are NOT stylistic: this
// cache is served with the record, so `agentRecordSize` counts it, and the
// ceiling check runs BEFORE the ingest — an unbounded reason would land, push
// the record past AGENT_RECORD_MAX, and then 413 every following beat from that
// host, including the ones that would have swept it. The agent truncates too;
// this is the boundary that makes a buggy or hostile one survivable (XERK-235).
// Mirrored as a LITERAL in normalizeSpawnRefusals, which runs on the state.json
// restore declared far above this line and so cannot close over this const
// without a TDZ ReferenceError. Move one, move the other.
const SPAWN_FAILURE_ERROR_MAX = 500;
const SPAWN_FAILURE_CMDID_MAX = 200;

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
// `ownCmdIds` is the set of command ids this host was actually GIVEN (its queue
// before this beat's acks were applied). Both handles are checked against what
// the hub knows, never taken on the agent's word: all agents share one token, so
// an unchecked cmdId lets any host end another host's spawn wait with arbitrary
// text, and an unchecked migrationId lets it fail a move it has no part in.
function ingestSpawnFailures(hostKey, agent, ownCmdIds, results) {
  const now = Date.now();
  // A non-array here would throw mid-handler, AFTER the record was replaced and
  // before the ack/publish/save — costing the host its commands every beat.
  for (const r of (Array.isArray(results) ? results : [])) {
    if (!r) continue;
    const error = typeof r.error === "string" && r.error
      ? r.error.slice(0, SPAWN_FAILURE_ERROR_MAX)
      : "the agent refused it";
    // The length and key-name checks are belt-and-braces BEHIND `ownCmdIds`:
    // `queueCommand` mints ids from crypto.randomBytes, so the hub can never
    // have issued one called `__proto__` or 200 chars long, and no test can
    // fail on their removal today. They are here for the day that membership
    // check is relaxed — `__proto__` would then invoke the prototype setter
    // rather than store an entry, silently dropping the refusal, which is why
    // `device` refuses the same names.
    if (typeof r.cmdId === "string" && r.cmdId &&
        r.cmdId.length <= SPAWN_FAILURE_CMDID_MAX &&
        r.cmdId !== "__proto__" && r.cmdId !== "constructor" &&
        r.cmdId !== "prototype" && ownCmdIds.has(r.cmdId)) {
      agent.spawnRefusals[r.cmdId] = { error, at: now };
    }
    // A migration's own handle. The refusal can arrive for either half, so match
    // the record by id — the export half has no importCmdId to key on. Only a
    // host actually IN the move may fail it.
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
  if (wait.kind === "setTicketPriority") return !!(agent.priorityResults || {})[cmdId];
  if (wait.kind === "createDuplicateLink") return !!(agent.linkResults || {})[cmdId];
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

// The ONE tie-break every cross-host resolution of a tracker block uses
// (XERK-325): an ONLINE host's block outranks any offline one, freshness
// deciding only WITHIN a tier.
//
// It is a shared function rather than the same three lines written out at each
// site because writing it out is exactly how this went wrong twice: the ranking
// was changed in `ticketRepo` while `autoStartSweep`, `autoStopSweep` and
// `fleetTicketRows` each kept their own copy, and every divergence was silent
// and user-visible — a killed session for a ticket the board showed as To Do, a
// queued Start click dropped without a word, auto-start queueing tickets no card
// displays while ignoring the ones it does.
//
// The rule itself: the hub can only ACT through an online host, and the board
// ranks the same way (`mergeSites`, its two vendored copies, and `Board.kt`), so
// resolving against an offline host's fresher block makes the hub act on a copy
// the operator was never shown. Hosts poll the tracker independently — ~10
// minutes apart on this fleet — so an offline host holding the newest block is
// ordinary, not an edge case. Offline blocks are still eligible, last, or a
// wholly-offline org would resolve nothing at all.
//
// Anything that resolves a ticket or a block across hosts belongs here. Grep
// `blockOutranks` for the full set; do not add a site with its own compare.
function agentBlockOnline(a, now) {
  return now - ((a && a.lastSeen) || 0) < OFFLINE_AFTER_MS;
}
function compareBlocks(x, y) {   // rank order, best first
  if (x.online !== y.online) return x.online ? -1 : 1;
  // Plain `>`/`<`, NOT localeCompare — the comparison every mirror uses, in both
  // its group pick and its sort. They disagree only on spellings that differ by
  // case or separator, which no real agent emits (one `now_iso()` format
  // fleet-wide); the reason to keep them identical anyway is that the last
  // attempt to "match mergeSites exactly" used localeCompare here and merely
  // MOVED the divergence from the two-user shape onto the common same-user one.
  return x.at > y.at ? -1 : x.at < y.at ? 1 : 0;   // fresher first
}
function blockOutranks(cand, best) {
  return !best || compareBlocks(cand, best) < 0;
}

// The repo an org's board says a ticket belongs in, as triaged by whichever host
// reported it (see the Jira -> repo triage section in hub-agent.py). null when no
// host reports the ticket, or none has triaged it yet, or the model declined it.
// Read off the ROW `fleetTicketRows` resolved, so it is by construction the same
// copy the card renders. Ranking blocks here on its own was subtly different and
// therefore wrong twice over: it ignored the newer-`updated` override, so a board
// showing RepoA (the newer copy) dispatched against RepoB (the better-ranked
// block); and where the winning copy carried no `repoGuess` at all, the card
// showed the ticket untriaged while the hub started it off a losing block's
// guess. `rows` is optional and exists only so a caller already holding the map
// — the auto-start sweep, per ticket — does not rebuild it per call.
//
// **An ONLINE host's answer outranks any offline one, however stale** (XERK-325).
// Every caller is a ROUTING decision, and `findTicketHost` can only route to an
// online host that agrees with this repo — so an offline host winning on
// freshness names a repo nothing can be dispatched against, and a ticket an
// online host had triaged and could run stalls as "no online host has triaged
// that ticket". Hosts poll Jira independently (~10 min apart in this fleet), so
// an offline host holding the newest block is ordinary, not an edge case.
// Freshness still decides WITHIN each tier; the offline tier is the fallback that
// keeps a wholly-offline org resolving a repo at all, which is what lets the
// queue hold the ticket rather than drop it.
function ticketRepo(siteKey, issueKey, rows) {
  const r = (rows || fleetTicketRows()).get(ticketQueueKey(siteKey, issueKey));
  return (r && r.row.repoGuess && r.row.repoGuess.repo) || null;
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

// Can this host take a session RIGHT NOW? The gate the hub-side ticket queue
// dispatches on (XERK-296), and deliberately a different question from the
// ranking above: that one orders hosts, this one decides whether any may be
// given work at all.
//
// An agent that reports no `capacity` block is "can't tell", never "full" — the
// heartbeat contract's rule for an absent capability. Such a host stays
// dispatchable (it still queues the session itself, exactly as it did before
// this queue existed, which is the pre-XERK-296 behavior a mixed fleet needs);
// hostAvailability already ranks it below every host with real free slots, so it
// is only ever picked when nothing better is known.
function hostHasFreeSlot(a) {
  const c = a && a.capacity;
  if (!c || typeof c.free !== "number") return true;
  return hostAvailability(a) > 0;
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
// elsewhere would contradict the one thing the pin asserts. A pinned host that
// is merely FULL is not an error: the ticket waits in the hub queue for that
// host, which is what the pin asks for.
//
// `opts.requireFree` (XERK-296) narrows the pool to hosts with a slot free RIGHT
// NOW, so a ticket is only ever routed to a host that can actually start it.
// Nothing is chosen when none can — the caller queues the TICKET instead and
// asks again on the next beat, which is what makes the host a dispatch-time
// decision rather than an enqueue-time one. Returns `{full:true}` with that
// refusal so the caller can tell "wait, this will clear" from "this can't work".
// Returns {host, needsClone} | {error, status, full?}.
//
// Does THIS host's own triage answer the question the board asked? Triage is
// per-host (each agent's ~/.turma/jira-repos.json, decided by its own model run
// over its own candidate repos), while `ticketRepo` shows the freshest host's
// answer — so a fleet routinely holds hosts that have not triaged a ticket the
// board already displays a chip for, and hosts that triaged it somewhere else.
// `spawn_ticket` re-derives the repo from the LOCAL ledger and refuses what it
// has no decision for, so dispatching to either kind is a spawn that cannot run.
// Eligibility therefore has to be the agent's own accept condition, and matching
// `repo` is part of it: a host that answered a different repo would spawn against
// THAT one, which is not the repo the operator was shown.
//
// Mirrors `_apply_triage`: no entry (or an undecided one) publishes no repoGuess,
// and a "nothing fits" verdict publishes `repo: null` — both of which the agent
// refuses, and both of which fail this test.
function hostTriagedTicket(a, issueKey, repo) {
  const t = ((a.jira && a.jira.tickets) || []).find((x) => x && x.key === issueKey);
  return !!(t && t.repoGuess && t.repoGuess.repo && t.repoGuess.repo === repo);
}
function findTicketHost(siteKey, repo, issueKey, opts) {
  const requireFree = !!(opts && opts.requireFree);
  const now = Date.now();
  // Which runtime this ticket is pinned to run on (XERK-473 dsh, XERK-515 qwen).
  // A non-default runtime ("dsh"/"qwen") restricts the pool to hosts that offer
  // it — a host without it can no more run the ticket than one that triaged a
  // different repo, so this filters beside the triage check and yields its own
  // distinct refusal below. The capability check is per-runtime, so the pin can
  // only ever name a runtime some host could actually run.
  const runtimePin = issueKey ? ticketRuntimePin(siteKey, issueKey) : null;
  const wantRuntime = (runtimePin && runtimePin.runtime && runtimePin.runtime !== "claude")
    ? runtimePin.runtime : null;
  const runtimeOfferedBy = (a) =>
    wantRuntime === "dsh" ? dshAvailable(a)
    : wantRuntime === "qwen" ? qwenAvailable(a)
    : true;
  let anyOrg = false, anyOnline = false;
  // Vacuously satisfied when there is no ticket to have triaged / no runtime need.
  let anyTriaged = !issueKey;
  let anyRuntimeCapable = !wantRuntime;
  const cloned = [], uncloned = [];
  for (const [key, a] of Object.entries(agents)) {
    if (!a.jira || a.jira.siteKey !== siteKey) continue;
    anyOrg = true;
    if (now - (a.lastSeen || 0) >= OFFLINE_AFTER_MS) continue;
    anyOnline = true;
    // A host that cannot run the requested runtime is out of the running
    // entirely — checked ahead of triage and capacity so `anyRuntimeCapable`
    // counts hosts that COULD run it, separating "no host offers <runtime>"
    // (blocked, a freed slot would not help) from the triage and full refusals.
    if (wantRuntime && !runtimeOfferedBy(a)) continue;
    anyRuntimeCapable = true;
    // Ahead of the capacity filter so `anyTriaged` counts hosts that could run
    // this ticket if they had room, which is what separates the two refusals
    // below: "nothing can run it" (blocked — a freed slot would not help) from
    // "what can run it is busy" (full — clears itself). Filtering after capacity
    // would collapse a full agreeing host into the first, and the ticket would
    // age out on the blocked timer instead of waiting for the slot it needs.
    if (issueKey && !hostTriagedTicket(a, issueKey, repo)) continue;
    anyTriaged = true;
    // A host with no room is out of the running entirely under requireFree —
    // including out of the "has the repo cloned" preference, so a full cloned
    // host never holds the ticket back from a free one that can clone on demand.
    if (requireFree && !hostHasFreeSlot(a)) continue;
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
    if (requireFree && !hostHasFreeSlot(a)) {
      return { status: 503, full: true, error:
        `this ticket is pinned to agent "${pin.host}", which has no free session slot` };
    }
    // The pinned host cannot run the requested runtime — reported, not routed
    // around, exactly like the triage refusal just below it. Blocked, never
    // full: a slot freeing on that host does not give it the runtime.
    if (wantRuntime && !runtimeOfferedBy(a)) {
      return { status: 503, error:
        `this ticket is pinned to agent "${pin.host}", which does not offer the ${wantRuntime} runtime` };
    }
    // The pin says WHICH host, never that the host can run it — reported rather
    // than routed around, exactly like every other pin refusal.
    //
    // Deliberately AFTER the capacity refusal, and not because either reason
    // clears itself — neither does, and a pinned host that is full AND untriaged
    // is reported as merely full until a slot frees. That is the better trade:
    // `full` is what makes the POST QUEUE the click instead of losing it, and
    // being untriaged is usually the minutes-long gap before a host's triage
    // batch returns, which a queued entry then dispatches on its own. The
    // permanent case (a decided `repo: null`) holds as blocked once capacity
    // clears and ages out with the queue's visible "gave up" note, which is
    // XERK-296's answer for exactly this. Refusing here instead would throw away
    // the click for the common transient case.
    if (!hostTriagedTicket(a, issueKey, repo)) {
      return { status: 503, error:
        `this ticket is pinned to agent "${pin.host}", which has not triaged it to ${repo}` };
    }
    return { host: pin.host,
      needsClone: !(a.repos || []).some((r) => r && r.name === repo) };
  }
  if (!anyOnline) {
    return { status: 503, error: "every host reporting that Jira org is offline" };
  }
  // Not `full`: a slot freeing does not give a host the pinned runtime, so this
  // holds as `blocked` and ages out rather than waiting for capacity that would
  // not help — the same shape as the untriaged refusal below.
  if (!anyRuntimeCapable) {
    return { status: 503, error:
      `no online host reporting that Jira org offers the ${wantRuntime} runtime` };
  }
  // Not `full`: a slot coming free does not give a host a triage decision, so
  // this holds on the queue as `blocked` and ages out rather than waiting for a
  // capacity change that would not help.
  if (!anyTriaged) {
    return { status: 503, error:
      `no online host has triaged that ticket to ${repo}` };
  }
  if (requireFree && !cloned.length && !uncloned.length) {
    // The pool is the hosts that TRIAGED this ticket to `repo`, not the org's
    // hosts, so say that — a free host that answered a different repo is not a
    // slot this ticket can use, and reporting the org as full while one sits
    // idle sends the operator to look at capacity they don't have a problem
    // with. Still `full`: every host that could run it is genuinely full, so
    // this is the reason that clears itself.
    return { status: 503, full: true, error: issueKey
      ? `every host that has triaged that ticket to ${repo} has its session slots full`
      : "every host reporting that Jira org has its session slots full" };
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
// `historyResults`, which at the agent's own ceilings (HISTORY_MAX_BYTES per
// delivery, HISTORY_STAGED_MAX_BYTES per beat, plus base64 SendUserFile images)
// reaches several MiB on an ordinary "open the chat history" click. At 1 MiB the hub
// destroyed the socket, the agent saw ECONNRESET rather than a status code,
// and — because it holds staged results until a POST succeeds — re-sent the
// same oversized body every beat, so the host stayed offline forever with
// nothing logged (XERK-235).
// Now the SHARED per-request ceiling rather than a fixed 32 MiB (XERK-258): the
// fixed number happened to equal an eighth of the deployed 256m, so this is the
// same value today, but a hub given more or less memory must move with it. It
// stays a named constant because the reason a HEARTBEAT needs the biggest body
// the hub allows is the paragraph above, not the arithmetic.
const HEARTBEAT_MAX = BODY_INFLIGHT_MAX;

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
  "dsh", "qwen", "triage", "defaultRuntime", "gitSources", "github", "inputMaxChars", "jira", "limits", "localModel",
  "logTail", "memory", "models", "prunes", "repoUsage", "repos", "reposRoot",
  "sessions", "startedAt", "subscription", "uploadMaxBytes", "usage",
  "historyResults", "subagentHistoryResults", "jiraIssueResults",
  "ticketStatusResults", "createMetaResults", "createTicketResults",
  "ticketPriorityResults", "ticketLinkResults",
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

// `AGENT_CACHE_KEYS` and `agentRecordSize` are declared with the registry
// budget instead (see `let agents`), because the state.json restore enforces
// that budget at module init and so has to be able to measure a record.

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
        `heartbeat from ${logName(key)}: dropped unknown field ${JSON.stringify(k)} ` +
          `(${size} bytes, limit ${HEARTBEAT_UNKNOWN_MAX})`
      );
      delete payload[k];
    }
  }
  // `sessions` is a KNOWN key, so the sweep above never looks inside it. Each
  // session's live agent rows come from a pane scrape and are re-shaped and
  // bounded here for the same reason the `turn` frame's are — the clients turn
  // this list into a count and a label, and nothing else bounds it.
  // Pre-ceiling, so this may only ever SHRINK (see normalizeRecord, which runs
  // past the gate and is free to rewrite). Live agent rows come from a pane
  // scrape and are re-shaped and bounded here for the same reason the `turn`
  // frame's are — clients turn this list into a count and a label, and nothing
  // else bounds it.
  if (Array.isArray(payload.sessions)) {
    for (const s of payload.sessions) {
      const live = objectish(s) ? s.session : null;
      if (objectish(live) && "agents" in live) {
        live.agents = sanitizeLiveAgents(live.agents) || [];
      }
    }
  }
  return payload;
}

/**
 * Is this a plain object — the thing a client that TYPED a field will accept?
 *
 * The one predicate every shape check in the coercion path goes through, because
 * the obvious spelling is wrong in the same way every time: `typeof [] ===
 * "object"`, so `!x || typeof x !== "object"` passes arrays straight through,
 * and the follow-on `"k" in []` is false so an array is neither coerced nor
 * rejected. Both escapes were measured the same way — the Android login probe
 * decodes /api/agents, so one raw array anywhere in the payload reads as "Could
 * not reach the hub" and the app cannot sign in at all.
 *
 * A `function` declaration, not a `const`: it is used ~70 lines ABOVE this point
 * by `sanitizeHeartbeat`, and this file has already shipped a coercion that
 * threw a ReferenceError at module init from exactly that pattern (a const in
 * its temporal dead zone, swallowed by the restore's `catch {}` — see
 * `normalizeRecord`'s ordering comment). Declarations hoist; consts do not.
 */
function objectish(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/**
 * Every coercion an agent record needs before a client sees it, in ONE place.
 *
 * Called from the heartbeat ingest and from the `state.json` restore, because a
 * coercion applied at only one of those is a hole straight through itself: the
 * restore serves whatever was persisted, for one beat on a live host and up to
 * the record's whole life on an offline one. Add a new `normalize*` HERE and
 * both paths get it.
 *
 * The stakes are Android's: `/api/agents` decodes atomically into typed fields,
 * so one host's wrong-typed value throws for the whole array and every OTHER
 * host silently disappears from that phone.
 */
/**
 * Whether a string is usable as the `agents` key, i.e. as a host this hub can
 * actually address. Shared by the heartbeat ingest and the `state.json` restore
 * so the two cannot drift — the same reason `normalizeRecord` is shared.
 *
 * Two families are refused. `agents` is a plain object, so a prototype key is
 * not a host: `__proto__` 200'd while the beat was silently discarded, and
 * replaced the registry's prototype (XERK-235). And a URL dot segment is
 * unaddressable: percent-encoding leaves "." and ".." untouched (both are
 * unreserved), and the URL parser resolving /api/agents/<host>/... then
 * collapses the segment — "." drops it, ".." climbs a level — so such a host
 * shows online and healthy while every route against it 404s (XERK-269).
 *
 * Exact match, deliberately: the padded forms (" . ", ".\n") ARE addressable,
 * since the padding percent-encodes to %20/%0A and no parser collapses those.
 * Names that merely contain dots ("...", ".hidden", "a.b", "HOST.local.") are
 * ordinary host names and must keep working.
 */
function isPlainHostKey(key) {
  return typeof key === "string" && key.length > 0 && key.length <= 200 &&
    key !== "__proto__" && key !== "constructor" && key !== "prototype" &&
    key !== "." && key !== "..";
}

/**
 * A refused key is attacker-controlled and NOT length-capped on the way in —
 * `sanitizeHeartbeat` doesn't bound `device`, so only HEARTBEAT_MAX (32 MiB)
 * does. Logging it raw let two refused beats write 9 MiB into the hub log, a
 * synchronous write on the request path that blocks every other host's beat
 * while it runs. Always log a key through this.
 */
function hostKeyLabel(key) {
  const s = typeof key === "string" ? key : String(key);
  return s.length > 80
    ? `${JSON.stringify(s.slice(0, 80))}… (${s.length} chars)`
    : JSON.stringify(s);
}

/**
 * Drop every key `isPlainHostKey` refuses, returning the dropped names.
 *
 * Extracted from the restore loop so it can be tested directly: a regex over
 * the loader's source proves the call is THERE, not that it drops anything —
 * removing the `delete` still logs "dropping …" while dropping nothing, and
 * `continue`→`break` silently makes survival depend on JSON key order. Both
 * kept the suite green.
 *
 * Non-object input returns empty rather than iterating: `Object.keys("hello")`
 * is ["0".."4"], which restored a five-"agent" registry out of a corrupt file.
 */
function dropUnusableHostKeys(store) {
  const dropped = [];
  if (!store || typeof store !== "object" || Array.isArray(store)) return dropped;
  for (const key of Object.keys(store)) {
    if (isPlainHostKey(key)) continue;
    dropped.push(key);
    delete store[key];
  }
  return dropped;
}

// The workflow picker's rows are coerced at heartbeat ingest, but the cache they
// land in is PERSISTED — so a restart serves whatever was on disk, uncoerced,
// and the restore is the first thing a freshly-shipped coercion has to cover
// (XERK-304). Same rule as every other typed field: it belongs in
// normalizeRecord, which runs on the ingest AND the restore.
function normalizeSubagentHistory(a) {
  const cache = a && a.subagentHistory;
  if (!cache || typeof cache !== "object") return;
  for (const entry of Object.values(cache)) {
    if (!entry || typeof entry !== "object") continue;
    // Only touch entries that actually carry a run's list — a plain transcript
    // has no business growing workflow keys on the way through.
    if (!("agents" in entry)) continue;
    entry.agents = sanitizeWorkflowAgents(entry.agents);
    entry.agentsTruncated = !!entry.agentsTruncated;
  }
}

/**
 * Coerce the served `spawnRefusals` map (XERK-325). Android TYPES it as
 * `Map<String, SpawnRefusal>` with a `String` error and a `Long` at, and a full
 * `/api/agents` decode is atomic there — so one bad value fails the whole fleet
 * array, not just its own host.
 *
 * The heartbeat path cannot produce one: `ingestSpawnFailures` is the only
 * writer, it substitutes a default for a missing reason and slices the length,
 * and an agent that puts `spawnRefusals` on its own beat is overwritten. The
 * RESTORE path can — `state.json` is served before any host re-beats — and
 * unlike every other on-demand cache this one is deliberately NOT stripped from
 * the payload, which is what makes it the first typed-and-served record field
 * needing this. So: defence in depth, and the rule that typing a field on a
 * client and adding its hub-side coercion are the same change.
 *
 * Coerces to the "can't tell you" value every client already handles — an absent
 * entry, never a plausible default — since a fabricated reason would end an
 * operator's spawn wait with text no agent ever said.
 */
function normalizeSpawnRefusals(a) {
  if (!a || typeof a !== "object") return;
  const raw = a.spawnRefusals;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if ("spawnRefusals" in a) a.spawnRefusals = {};
    return;
  }
  // A PLAIN object, matching exactly what the ingest path builds — a
  // null-prototype one here would make a restored record a different shape from
  // a beaten one, which `deepStrictEqual` sees and clients need not.
  const out = {};
  for (const [id, e] of Object.entries(raw)) {
    // So the key filter is what does the work, and it is not optional: `out[id]`
    // uses [[Set]], so a `__proto__` key would invoke the prototype setter
    // rather than store an entry — silently dropping the refusal AND re-pointing
    // this map's prototype at agent-influenced data. JSON can express all three
    // names and this input is a file we exist to distrust; a cmdId is hub-minted
    // hex, so none of them can be real. Same names `ingestSpawnFailures` refuses.
    if (id === "__proto__" || id === "constructor" || id === "prototype") continue;
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    // `at` ages entries out and must be a finite number; `error` is what the UI
    // shows, so an empty or non-string one becomes the same default the ingest
    // uses rather than being dropped — the refusal itself is still the answer.
    if (typeof e.at !== "number" || !Number.isFinite(e.at)) continue;
    // The bound is a LITERAL, not `SPAWN_FAILURE_ERROR_MAX`, for the same reason
    // normalizeSubscription's are: that const is declared far below the
    // state.json restore that calls this, so closing over it would be a TDZ
    // ReferenceError landing in the restore's own `catch {}` — booting the hub
    // with an empty registry, its one `state restore skipped:` line the only
    // sign anything went wrong. Keep the two in step by hand; they are both 500.
    const error = typeof e.error === "string" && e.error
      ? e.error.slice(0, 500)
      : "the agent refused it";
    out[id] = { error, at: e.at };
  }
  // The ingest bounds this map two ways — an age sweep and SPAWN_FAILURE_MAX —
  // and the restore has to apply the count bound too, or the one path this
  // coercion exists for is the one that leaves it unbounded: a state.json map is
  // served on every /api/agents until that host next beats, and a host that
  // never beats again serves it forever. Oldest-first, like the ingest's own
  // eviction. A literal for the TDZ reason above; it mirrors SPAWN_FAILURE_MAX.
  const ids = Object.keys(out);
  if (ids.length > 40) {
    ids.sort((x, y) => out[x].at - out[y].at)
      .slice(0, ids.length - 40)
      .forEach((id) => delete out[id]);
  }
  a.spawnRefusals = out;
}

function normalizeRecord(a) {
  // Order is NOT load-bearing, and must not become so: each of these guards its
  // own input shape (`Array.isArray`, not `|| []`), because a throw anywhere in
  // here lands in the restore's silent `catch {}` and abandons every host after
  // this one, uncoerced, on every boot. Sessions first only because it is the
  // one that rewrites a shape the others iterate.
  normalizeSessions(a);
  normalizeSubagentHistory(a);
  normalizeUsage(a);
  normalizeLimits(a);
  normalizeSubscription(a);
  normalizeLocalModel(a);
  normalizeDsh(a);
  normalizeQwen(a);
  normalizeTriage(a);
  normalizeDefaultRuntime(a);
  normalizeModels(a);
  normalizeSpawnRefusals(a);
  normalizeRetired(a);
  normalizeJira(a);
  normalizeClones(a);
}

/**
 * `clones[]` coerced to the shape every client types (XERK-369).
 *
 * There was no coercion here at all while Android types EVERY field on
 * `CloneInfo` as a String and a full `/api/agents` decode is atomic there — so
 * one host beating `clones: [{ status: 123 }]` threw the whole fleet array on
 * every phone. That was latent before this change and is live the moment
 * `progress` joins it, so both are fixed together, per the heartbeat contract
 * in CLAUDE.md: typing a field and adding its hub-side coercion are the SAME
 * change.
 *
 * Non-strings are DROPPED rather than stringified, so the client's own default
 * ("" / absent) applies and nothing invents an "[object Object]" for the
 * operator to read. `progress` is capped because it is agent-supplied,
 * per-clone and unbounded on the wire otherwise — the shape that built a
 * 23.8 MB reply and OOM-killed a hub in XERK-348.
 */
function normalizeClones(a) {
  if (!a || typeof a !== "object") return;
  if (!("clones" in a)) return;
  if (!Array.isArray(a.clones)) { delete a.clones; return; }
  a.clones = a.clones.filter((c) => c && typeof c === "object" && !Array.isArray(c));
  for (const c of a.clones) {
    for (const k of ["repo", "name", "status", "error", "source", "startedAt", "progress"]) {
      if (k in c && typeof c[k] !== "string") delete c[k];
    }
    // 120 INLINE, not a module `const`: `normalizeClones` is reached from
    // `loadState`'s restore loop near the top of this file, where a const
    // declared below is in its TDZ — the ReferenceError lands in the restore's
    // catch and the whole registry is emptied (XERK-301). One clone-progress
    // line on the wire; the agent caps it too, this is the half that does not
    // trust the agent.
    if (typeof c.progress === "string" && c.progress.length > 120) {
      c.progress = c.progress.slice(0, 120);
    }
  }
}

/**
 * `jira.siteKey` coerced to a string, or dropped (XERK-348).
 *
 * It is agent-supplied and was served RAW, while Android types it
 * (`AgentInfo.jira.siteKey: String`) and a full `/api/agents` decode is atomic
 * there — so one host beating an object key throws the whole fleet array on
 * every phone. Per the heartbeat contract in CLAUDE.md, typing a field and
 * adding its hub-side coercion are the same change, and `normalizeRecord` is
 * where it goes so the `state.json` restore is covered as well as the ingest.
 *
 * Dropped rather than stringified: `siteKeyOf` already reads a non-string as
 * "no org", and inventing `"[object Object]"` would make one up instead.
 */
function normalizeJira(a) {
  if (!a || typeof a !== "object") return;
  const j = a.jira;
  if (!j || typeof j !== "object" || Array.isArray(j)) return;
  if ("siteKey" in j && typeof j.siteKey !== "string") delete j.siteKey;
  // Per-ticket triage assessment (XERK-481). `jira` is a KNOWN heartbeat key, so
  // sanitizeHeartbeat's unknown-field sweep never looks inside it — a field
  // typed under a ticket has to be coerced HERE, the same rule normalizeSessions
  // states for the `sessions` array. Android TYPES `JiraTicket.triage`, so one
  // host beating a malformed block would fail the whole fleet decode; coercing
  // it in normalizeRecord covers the state.json restore too.
  if (Array.isArray(j.tickets)) {
    for (const t of j.tickets) {
      if (t && typeof t === "object" && !Array.isArray(t)) sanitizeTicketTriage(t);
    }
  }
}

// Coerce ONE ticket's `triage` block (XERK-481) to the fixed wire shape every
// client types: {priority, priorityName, type, value, actionable, dedupeOf,
// reason, at, source}. Mirrors the agent's build_ticket_triage — the two are
// the SAME contract, so an unusable field is DROPPED (letting the client's own
// null/absent default apply — "not assessed"), never invented as a plausible
// value. `priority` is kept only when it is a real P0..P3 band, so a malformed
// one reads as unknown, never as "P-something". `actionable` is kept only strict
// boolean. Every string is length-capped: it is agent-supplied, per-ticket and
// otherwise unbounded on the wire (the XERK-348 lesson). Bounds are INLINE
// LITERALS, not module consts: normalizeRecord is reached from loadState's
// restore loop near the top of this file, where a const declared below is in its
// TDZ, and the ReferenceError lands in the restore's catch and empties the whole
// registry (XERK-301) — the same reason the sibling normalizers inline theirs.
function sanitizeTicketTriage(t) {
  if (!t || typeof t !== "object" || !("triage" in t)) return;
  const tr = t.triage;
  if (!tr || typeof tr !== "object" || Array.isArray(tr)) { delete t.triage; return; }
  const out = {};
  if (tr.priority === "P0" || tr.priority === "P1" ||
      tr.priority === "P2" || tr.priority === "P3") {
    out.priority = tr.priority;
  }
  // caps: labels/keys/source are short; `reason` is a model rationale.
  const caps = { priorityName: 120, type: 60, value: 60, dedupeOf: 60, source: 40, reason: 2000, at: 40 };
  for (const k of Object.keys(caps)) {
    if (typeof tr[k] === "string" && tr[k]) out[k] = tr[k].slice(0, caps[k]);
  }
  if (tr.actionable === true || tr.actionable === false) out.actionable = tr.actionable;
  t.triage = out;
}

// The host login's own model list (`models`, XERK-33) — NOT the per-model usage
// block above, which is a different field with a different shape. Android types
// it (`ModelsInfo?`) and decodes /api/agents atomically, so one host beating
// `models: "x"` — or a number, or an object whose `available` is a string —
// throws for the WHOLE array and empties every other host from every phone's
// fleet list, while the tile still reads "N / N online". The web guards this one
// with Array.isArray, so it fails only on the client that fails silently.
//
// Unusable becomes ABSENT, and that means absent — never a rebuilt empty block.
// An empty one passes `board.js`'s `Array.isArray(mb.available)` gate and joins
// the freshest-probe compare, where it can take the DEFAULT LABEL off a host that
// probed properly; absent is skipped there, and is what the ticket model picker
// already reads as "this agent can't tell you", falling back to the static family
// aliases. `Board.kt` has the identical compare.
//
// The bounds are INLINE LITERALS on purpose. `normalizeRecord` is reached from
// `loadState`'s restore loop near the top of this file, which resolves these
// functions only because declarations hoist — a module `const` below is in its
// TDZ there, the ReferenceError lands in the restore's catch, and the WHOLE
// registry is emptied, after which the save timer rewrites state.json from only
// the hosts that have re-beaten. That is XERK-301, and shipping it again is what
// the sibling normalizers inline their own bounds to avoid.
function normalizeModels(payload) {
  if (!payload || typeof payload !== "object") return;
  if (!("models" in payload)) return;   // absent stays absent — never fabricated
  const m = payload.models;
  if (!m || typeof m !== "object" || Array.isArray(m)) {
    delete payload.models;
    return;
  }
  // Each NAME is bounded too, not just the count: 100 entries of 70 KiB is a
  // 7 MiB block on /api/agents and on every SSE frame, which a count cap alone
  // waves through. Capping one field of several is the XERK-348 mistake.
  const available = Array.isArray(m.available)
    ? m.available
        .filter((x) => typeof x === "string" && x)   // DROPPED, never String()'d —
        .slice(0, 100)                               // a coerced number is a model
        .map((x) => x.slice(0, 120))                 // name that does not exist
    : [];
  const defaultLabel = typeof m.defaultLabel === "string" ? m.defaultLabel.slice(0, 120) : "";
  // NO LABEL MEANS NO CLAIM ON THE LABEL. Both mirrors gate the label write on
  // `at` being at least the incumbent's (`board.js` mergeSites and its Board.kt
  // twin), so a block with a fresh `at` and an empty label wins that compare and
  // CLEARS the label of a host that probed properly — the picker drops to
  // "Default" from "Default (Opus 5)". A real agent reaches this honestly: the
  // probe returns `label or None` when it finds no "Current model:" line.
  //
  // Blanking `at` loses that compare to any dated incumbent while the block still
  // contributes its `available` entries, which is the whole of what it knows.
  // Fixed HERE rather than in the compare because `mergeSites` is mirrored across
  // board.js, its two vendored copies and Board.kt — one hub-side line beats a
  // five-way change, and the hub is where the value is untrusted anyway.
  const at = !defaultLabel ? "" : (typeof m.at === "string" ? m.at.slice(0, 120) : "");
  // The LIST is what makes the block worth serving. A `defaultLabel` or an `at`
  // with no usable `available` is still the rebuilt-empty block this function
  // exists to avoid: it passes board.js's `Array.isArray(mb.available)` gate,
  // joins the freshest-probe compare, and — with a newer `at` than a host that
  // probed properly — takes that host's default label off the picker. Checking
  // all three fields let `{available: "nope", at: "2099-01-01"}` do exactly that.
  if (!available.length) {
    delete payload.models;
    return;
  }
  payload.models = { available, defaultLabel, at };
}

/**
 * `retired` is a HUB-OWNED flag, never an agent's to set (XERK-338).
 *
 * It exists on `AgentsResponse.retiredUsage` entries, which the hub builds
 * itself; a record that came off the wire is by definition a live host and must
 * carry `false`. Android TYPES it (`AgentInfo.retired: Boolean`), and typing a
 * field and adding its hub-side coercion are the SAME change — without this an
 * agent putting `retired: "yes"` on its own beat had that value served verbatim,
 * and since a full `/api/agents` decode is ATOMIC on Android, ONE host threw for
 * the WHOLE array and emptied every other host from every phone's fleet list.
 * It persisted into `state.json` too, so it survived a restart.
 *
 * Deleted rather than coerced to `false`: the field is not part of an agent
 * record's shape at all, and `false` is already what an absent one decodes to.
 */
function normalizeRetired(a) {
  if (!a || typeof a !== "object") return;
  if ("retired" in a) delete a.retired;
}

/**
 * The heartbeat's coercion step, reached through a holder so a test can force it
 * to throw (XERK-262). Production always holds the real [normalizeRecord]; only
 * a `TURMA_TEST` suite ever replaces `normalize`.
 *
 * The indirection exists because the backstop around this call cannot be
 * reached from the heartbeat wire today, and a QA mutation pass deleted the
 * whole try/catch with the suite green.
 *
 * Why it is unreachable: every `normalize*` guards its own input shape, so the
 * only throw the path has ever had was `sanitizeLiveAgents`'s `String(...)` on a
 * value with no primitive conversion (pure JSON can express one —
 * `{"toString":1,"valueOf":1}`), and `sanitizeHeartbeat` walks those same rows
 * BEFORE any record is installed. Do not read that as "the input is impossible":
 * the same value reaches `sanitizeLiveAgents` from the `/agent/control` frame
 * handler, where nothing catches it (XERK-278).
 *
 * Being unreachable is exactly why deleting this catch reads as safe. It is not:
 * `agents[key] = next` has ALREADY run by the time the coercion is called, so
 * without the rollback a throw leaves the RAW, uncoerced record installed and
 * served — defeating every gate downstream, `normalizeLocalModel`'s
 * strict-boolean `available` check included. One `normalize*` that can throw on
 * an input `sanitizeHeartbeat` does not walk makes this load-bearing with no
 * other warning.
 */
const recordCoercion = { normalize: normalizeRecord };

// The per-SESSION coercions (see normalizeRecord).
//
// `sessions` is a KNOWN key, so sanitizeHeartbeat's unknown-field sweep never
// looks inside it — everything typed under a session has to be handled here.
// Android decodes /api/agents into typed fields, so an object or array where it
// expects a String throws for the WHOLE array and every other host disappears
// from that phone; a field only becomes this dangerous once a client TYPES it,
// which is why `modelSource`/`modelSourceAt` are here from the commit that
// declared them on `SessionInfo`.
function normalizeSessions(payload) {
  if (!payload || typeof payload !== "object") return;
  // A non-array `sessions` is REWRITTEN, not skipped. It is decode-fatal on
  // Android — measured as the app failing to sign in at all, reporting "Could
  // not reach the hub" — and on the restore path it also throws out of
  // normalizeUsage's `for … of`, silently abandoning the record. Rewriting is
  // safe only because this now runs PAST the AGENT_RECORD_MAX gate: doing it
  // before would have erased the amplifier that gate exists to refuse.
  if (!Array.isArray(payload.sessions)) {
    if ("sessions" in payload) payload.sessions = [];
    return;
  }
  // DROP a non-object element, never skip past it: `sessions` is typed
  // `List<SessionInfo>` on Android, so a `null` or a bare string in the array is
  // as fatal as a wrong-typed field inside one — measured as a host silently
  // missing from the phone while the tile still counted it.
  if (!payload.sessions.every(objectish)) payload.sessions = payload.sessions.filter(objectish);
  for (const s of payload.sessions) {
    // Re-bounded here as well as in sanitizeHeartbeat, because the restore path
    // never goes through that: idempotent, so running twice costs nothing.
    //
    // REWRITE a non-object `session`, never merely skip past it. `session` is
    // typed `LiveSignals?` on Android, so any non-object is decode-fatal for
    // the WHOLE /api/agents array — measured as the app unable to sign in at
    // all, since the login probe decodes it and reads the throw as "Could not
    // reach the hub". Skipping the sanitize is NOT enough: the raw value stays
    // in the record and is what gets served. `null` is the "can't tell you"
    // value every client already handles.
    //
    // An array is the case a bare `typeof live === "object"` guard misses, and
    // `"agents" in []` is false, so it fell through both halves of the old
    // test. Rewriting is safe here only because normalizeSessions runs PAST the
    // AGENT_RECORD_MAX gate — see normalizeRecord's ordering comment.
    if ("session" in s && !objectish(s.session)) s.session = null;
    const live = s.session;
    if (live && "agents" in live) {
      live.agents = sanitizeLiveAgents(live.agents) || [];
    }
    for (const k of ["modelSource", "modelSourceAt", "agentType"]) {
      if (k in s && typeof s[k] !== "string") s[k] = "";
    }
    // summary is agent-supplied display text (the session's own title — what the
    // Android card shows and the notification titles now lead with). Coerce to a
    // trimmed, capped string: a non-string would throw the atomic /api/agents
    // decode on Android (typed String), and an unbounded name would push the
    // notification payload past FCM's ~4 KB data limit, dropping the whole
    // alert. 120 is 2.5x the agent's own 48-char cap, so legitimate titles
    // never get cut. Literal, not a module const: normalizeSessions is reached
    // from loadState's restore loop, where a later const is in its TDZ
    // (XERK-301, same reason normalizeClones inlines its 120).
    if ("summary" in s) {
      const t = typeof s.summary === "string" ? s.summary.trim() : "";
      s.summary = t.slice(0, 120);
    }
    // Kill switch OFF: a reported/persisted dsh session runtime reads as claude
    // on the wire (coerce "dsh" -> "", which every client already treats as the
    // default), so no client renders a session as dsh and the hub's own /model
    // route never takes its dsh branch. Mirrors the agent's rebuild coercion.
    if (!DSH_ENABLED && s.agentType === "dsh") s.agentType = "";
    // Same kill-switch coercion for qwen (XERK-506): a reported/persisted qwen
    // session runtime reads as claude on the wire while QWEN_ENABLED is off.
    if (!QWEN_ENABLED && s.agentType === "qwen") s.agentType = "";
    // XERK-489: the per-session self-hosted model name (String? on Android) and
    // its context window (Int? on Android). Typing a field on SessionInfo and
    // adding its hub-side coercion are the SAME change — a wrong-typed one from a
    // rogue agent would otherwise fail the WHOLE /api/agents decode on the phone.
    // A non-string name and a non-int-safe context degrade to the "can't tell"
    // value every client already handles (null), never a plausible default.
    if ("localModelName" in s && typeof s.localModelName !== "string") s.localModelName = null;
    // XERK-489 Phase 4: the context-fullness meter's numerator + denominator, both
    // Int? on Android — same coercion, same reason (a rogue figure must degrade to
    // null, not fail the whole fleet decode). The numerator is genuinely null until
    // a turn is measured; a non-int-safe denominator degrades to null and the client
    // hides the meter rather than dividing by junk.
    for (const k of ["localModelContext", "lastTurnContextTokens", "contextWindowTokens"]) {
      if (k in s) {
        const c = s[k];
        s[k] = (typeof c === "number" && Number.isSafeInteger(c) &&
          c > 0 && c <= 2_147_483_647) ? c : null;
      }
    }
  }
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

// ---- in-flight body budget (XERK-258) ---------------------------------------
// A per-request ceiling bounds ONE body. Nothing bounded the SUM of the bodies
// being read at the same moment, so two requests each comfortably under
// HEARTBEAT_MAX together exceeded the container's whole memory limit: measured
// at the deployed 256m, two concurrent 30 MiB heartbeats OOM-kill the hub, and
// all agents share one TURMA_AGENT_TOKEN, so any one host can take down the
// fleet's entire control plane — which `restart: unless-stopped` then loops.
//
// The ceilings are FRACTIONS OF THE CONTAINER LIMIT, not fixed numbers, so
// raising mem_limit widens them with no code change and a hub given LESS memory
// tightens itself instead of dying. Both are logged at boot.

// Thrown when admitting a body would put the hub over the budget. A 503 (not a
// 413): the request is not too big, the hub is momentarily too busy, and the
// caller should retry rather than shrink anything.
class BodyBudgetExceeded extends Error {
  constructor(held) {
    super("hub busy: too many large requests in flight");
    this.budgetExceeded = true;
    this.held = held;
    this.limit = BODY_INFLIGHT_TOTAL_MAX;
  }
}

let bodyInflightBytes = 0;
// Whether the big-body lane below is occupied. At most one body at a time may
// exceed the shared budget.
let bigLaneTaken = false;
// Charged to the big lane, kept OUT of `bodyInflightBytes` on purpose — see
// chargeBody. Tracked for reporting; the lane's real bound is the per-request
// cap plus the fact that only one body may hold it.
let bigLaneBytes = 0;

/**
 * Which lane a body of `n` budget units may use right now, or null to refuse.
 * Holds nothing — this is the admission rule alone, so both readers can also ask
 * it of a DECLARED length that has not arrived (see readBody).
 *
 * Two lanes, because one shared budget cannot express both of the hub's real
 * obligations:
 *
 *  - **shared** — bodies that fit alongside everything else in flight. This is
 *    almost all traffic and needs no special case.
 *  - **big** — ONE body at a time that does not fit. Without it, the hub's own
 *    advertised per-request ceilings are unreachable under any concurrent
 *    traffic: `HEARTBEAT_MAX` says a 32 MiB beat is legal, but at 3x parse cost
 *    it needs 96 of the 64 MiB budget, so it would be refused whenever ANY other
 *    body was being read. A rule keyed on the hub being bit-for-bit idle is not
 *    a rule anyone can rely on: one trickling request defeats it, and it also
 *    refused a real 65 MiB migration bundle with 3 KB in flight — back when the
 *    relay buffered one. It spools to disk now (XERK-263) and never reaches this
 *    budget, so large HEARTBEATS are what the lane carries.
 *
 * The lane bounds the hub because only one body can hold it and every body is
 * still capped per-request. Worst case is therefore one max-size body plus the
 * whole shared budget, which is what the container is sized against.
 */
function bodyLaneFor(n) {
  return laneForCharge(null, n);
}

/**
 * Move an already-charged `n` from the shared lane into the big one, when a read
 * that started ordinary outgrows the budget and is promoted.
 *
 * Without this the charge is split across two counters while the read owns only
 * ONE lane, and `release()` — which can only name the lane the read ENDED in —
 * hands the whole amount back to the big lane, leaking the shared portion
 * forever. That is not an attack: a single legitimate 22 MiB heartbeat (well
 * inside HEARTBEAT_MAX, and the size XERK-235 exists because staged history
 * reaches) permanently consumed the entire shared budget, after which every
 * non-trivial body was refused for the life of the process.
 *
 * A body's charge must live entirely in the lane it currently occupies. Then
 * release is correct by construction, and so is every reading of either counter.
 */
function migrateToBigLane(n) {
  bodyInflightBytes -= n;
  if (bodyInflightBytes < 0) bodyInflightBytes = 0;
  bigLaneBytes += n;
}

/**
 * Whether the budget is contended enough for a non-progressing read to be worth
 * reclaiming. True while the one big lane is occupied, or the shared budget is
 * more than half spent — the two states in which one body holding on actually
 * costs another body its turn.
 */
function budgetUnderPressure(lane) {
  // The big lane is EXCLUSIVE, so a body sitting in it blocks the next large
  // body however much room the shared budget has. A stall there is contention
  // by definition.
  if (lane === "big") return true;
  return (bodyInflightBytes + bigLaneBytes) * 2 > BODY_INFLIGHT_TOTAL_MAX;
}

/**
 * The same decision for a read that is ALREADY under way and wants `delta` more
 * units, given the lane it is in.
 *
 * A shared-lane body is re-judged on every top-up. Deciding a lane once and then
 * charging blindly is what makes a budget stop being one: several bodies each
 * entered the shared lane while they were small, never consulted it again, and
 * grew straight past the ceiling together — two 30 MiB heartbeats OOM-killed the
 * hub with the budget nominally in force.
 *
 * A body that outgrows the shared lane is PROMOTED to the big one if it is free,
 * rather than being killed at the point it stops fitting — a body that could not
 * have known its own final size should not be punished for the hub filling up
 * behind it, and this is the ordinary path for a large heartbeat that arrives
 * chunked with no length to check up front.
 */
function laneForCharge(lane, delta) {
  if (lane === "big") return "big"; // already exempt, for the whole read
  // Shared admission counts the big lane too. A big body really is occupying
  // memory, so pretending otherwise is what let the true worst case drift above
  // what the container can hold. As it grows, ordinary traffic's room shrinks —
  // but never to nothing, because the ceiling is set above what one body can
  // ever charge, which is what keeps a holder from starving everyone (the total
  // outage that made the lanes separate accounts in the first place).
  if (bodyInflightBytes + bigLaneBytes + delta <= BODY_INFLIGHT_TOTAL_MAX) return "shared";
  if (!bigLaneTaken) return "big";
  return null;
}

/**
 * Charge `n` budget units for bytes THAT HAVE ALREADY ARRIVED, in `lane`.
 *
 * **Only real, buffered bytes are ever charged — never a declared
 * `Content-Length`.** Reserving on the declared length looks like the better
 * trade (it refuses a doomed body before buffering any of it) and is a
 * denial-of-service: a socket that declares the maximum body and then sends
 * nothing holds the whole budget for as long as the request timeout allows,
 * and every other body on the hub is refused 503. That costs an attacker no
 * bandwidth, needs no credentials (`/api/login` reads a body before any auth
 * gate) and is renewable, so it wedges the fleet's control plane far more
 * cheaply than the OOM this budget exists to prevent. A declared length is a
 * CLAIM; the budget may only ever track what was actually spent.
 *
 * A body's lane is decided once and held for the whole read. Re-judged per
 * top-up, a big-lane body would be refused mid-stream by its own accumulated
 * charge the moment it passed the shared budget.
 */
function chargeBody(n, lane) {
  // **The lanes are accounted SEPARATELY, and that is the whole point of having
  // lanes.** Billing the big body to the shared budget made merely OCCUPYING
  // the lane a total outage: its own charge exceeds the budget, so every other
  // body — a 200-byte heartbeat, the operator's own login — was refused 503
  // behind it, and one authenticated socket could hold the fleet's control
  // plane offline for about 29 kbit/s.
  //
  // Kept apart, a big body costs the shared lane nothing: occupying the lane
  // delays other LARGE bodies, which is what an exclusive lane means, and
  // ordinary traffic never notices. The hub's ceiling is unchanged either way —
  // one max-size body plus the shared budget, which is what it is sized for.
  if (lane === "big") {
    bigLaneTaken = true;
    bigLaneBytes += n;
    return;
  }
  bodyInflightBytes += n;
}

/**
 * What a body of `n` wire bytes really costs the hub, which is NOT `n`.
 *
 * A budget that charged wire bytes did not save the hub: two concurrent 30 MiB
 * heartbeats summed to 60 MiB against a 64 MiB budget, were both admitted, and
 * OOM-killed it anyway. The wire size is the smallest part of the bill — the
 * body is also held as a JS string, and then `JSON.parse` builds an object graph
 * beside it that outweighs both. So a JSON body is charged a MULTIPLE of what it
 * declares, and the budget bounds the hub's real footprint rather than its
 * traffic.
 *
 * Raw (Buffer) bodies keep their 1x: the migration relay and the attachment
 * uploads never decode or parse what they hold, so for them the wire size IS the
 * cost, and inflating it would refuse legitimate bundles that fit comfortably.
 */
const BODY_PARSE_COST = 3;

/**
 * Give `n` bytes back. Both readers call this the moment the body stops being
 * held — on end, on error, and on either refusal — because a charge that
 * outlives its buffer ratchets the budget permanently shut, which would take the
 * hub down just as surely as the OOM this replaced, only more quietly.
 */
function releaseBody(n, lane) {
  // Freeing the lane is the half that must never be missed — leaked, the hub
  // refuses every large body for the rest of its life.
  if (lane === "big") {
    bigLaneBytes -= n;
    if (bigLaneBytes < 0) bigLaneBytes = 0;
    bigLaneTaken = false;
    return;
  }
  bodyInflightBytes -= n;
  // Belt and braces: a double release would drive this negative, which would
  // hand the shared lane more room than the container has.
  if (bodyInflightBytes < 0) bodyInflightBytes = 0;
}
// Everything held right now, BOTH lanes — what a test or a log wants to see.
const bodyInflightHeld = () => bodyInflightBytes + bigLaneBytes;

// Collect a request body as a string. Past `cap` it keeps DRAINING for a while
// rather than destroying the socket: draining is what lets the route write a
// 413 on the same connection, where a mid-body destroy reaches the client as a
// socket hang-up with no status to branch on. Same rule readRawBody follows.
//
// `costPerByte` is what this body will actually cost the hub, in budget units
// per wire byte. It defaults to BODY_PARSE_COST, which models an ordinary JSON
// body — a route that costs materially more must say so, because the in-flight
// budget is only a bound on memory while its units MEAN memory. The archive
// ingest is the route that proved it: charged 3x while really costing ~20x, the
// budget happily admitted enough concurrent pushes to OOM-kill the container
// (XERK-356).
function readBody(req, cap = BODY_MAX, costPerByte = BODY_PARSE_COST) {
  return new Promise((resolve, reject) => {
    let data = "";
    let len = 0;
    let over = false;
    // Budget units this read has charged — the body's wire bytes times
    // BODY_PARSE_COST, not the wire bytes themselves. Released the moment the
    // body stops being held — on end, on error, and on either refusal — because
    // a charge that outlives its buffer would ratchet the budget shut.
    let held = 0;
    let lane = null; // decided on the first charge, held for the whole read
    let bigLaneSince = 0; // when this read took the exclusive lane, if it has
    let draining = false; // holds one of the DRAIN_CONCURRENCY_MAX slots
    const costOf = (bytes) => bytes * costPerByte;
    // How far past the refusal point we keep draining before cutting the socket.
    // Draining is what lets the route answer on the same connection; a mid-body
    // destroy reaches the client as a hang-up with no status to branch on. A
    // body refused on BUDGET may be tiny, so it drains from where it stopped
    // rather than all the way to `cap` — otherwise a flood of refusals would
    // cost the hub the very read time the budget exists to avoid spending.
    let drainLimit = cap + RAW_BODY_DRAIN_SLACK;
    const release = () => { releaseBody(held, lane); held = 0; lane = null; };
    const endDrain = () => { if (draining) { draining = false; drainingNow--; } };
    // Armed only while this read holds budget, and reset by every chunk: a slow
    // client keeps sending and is never touched; an abandoned one is.
    let idleTimer = null;
    // Where `len` stood when the window opened, and how much further it must get
    // before the window may be reopened. Without these the window resets on any
    // byte and a dribble holds its charge for as long as it likes.
    let progressMark = 0;
    let progressNeeded = 0;
    const disarmIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
    const armIdle = () => {
      disarmIdle();
      progressMark = len;
      // Never ask for more than the body has left to give, so a nearly-finished
      // upload is not reclaimed over its last few bytes.
      const left = Number.isFinite(declared) && declared > len ? declared - len : Infinity;
      progressNeeded = Math.max(1, Math.min(BODY_MIN_PROGRESS_BYTES, left));
      idleTimer = setTimeout(() => {
        if (over) return;
        // Reclaiming exists to relieve CONTENTION, so it only fires under it.
        // On a hub with room to spare a stalled read is blocking nobody, and
        // dropping it would be a pure false positive — a small request over a
        // bad link holds a few hundred KB of a 64 MiB budget and monopolizes
        // nothing. Under pressure the non-progressing reads are exactly the
        // ones that should give way.
        if (!budgetUnderPressure(lane)) return armIdle();
        over = true;
        release();
        reject(new BodyStalled());
        try { req.destroy(); } catch {}
      }, BODY_IDLE_TIMEOUT_MS);
      // Must not hold the process open on its own (the suite would never exit).
      if (idleTimer.unref) idleTimer.unref();
    };
    req.on("close", () => { endDrain(); disarmIdle(); });
    const refuse = (err, from = cap) => {
      over = true;
      data = ""; // release it — it is not going to be used
      drainLimit = from + (err.budgetExceeded ? BUDGET_DRAIN_SLACK : RAW_BODY_DRAIN_SLACK);
      // Draining is capped by CONCURRENCY, not just by length. Under the cap
      // this reads on so the route can answer on the same connection — that is
      // how an agent whose staged history outgrew HEARTBEAT_MAX learns its own
      // limit and resizes instead of looping offline (XERK-235). Past it, the
      // request reads nothing more and `noDrain` tells the route to close: the
      // courtesy is what is killing the hub by then, and a reset the caller
      // retries beats a status nobody is alive to read.
      if (drainingNow >= DRAIN_CONCURRENCY_MAX) { drainLimit = 0; err.noDrain = true; }
      else { drainingNow++; draining = true; }
      release();
      disarmIdle();
      // A budget refusal STOPS READING rather than draining. Draining is a
      // courtesy paid out of the very resource that has just run out, and Node
      // hands us whatever has accumulated in one `data` event — megabytes — so
      // even "destroy on the first chunk" costs a chunk per socket, and 256 of
      // those OOM-killed the hub with not one body being buffered. Paused, the
      // bytes stop at the kernel's socket buffer and TCP backpressure tells the
      // client to stop; the 503 already queued still flushes, and Node closes
      // the connection once it has.
      if (err.budgetExceeded || err.noDrain) req.pause();
      reject(err);
    };

    const declared = Number(req.headers["content-length"]);
    // NOTE the asymmetry with the budget check below: an OVERSIZE body is NOT
    // refused on its declaration. Refusing before the client has sent anything
    // makes Node close the connection under a request still being written, and a
    // client that writes its whole body before reading — python's urllib, which
    // is exactly what hub-agent.py posts with — then loses the response and sees
    // a socket error. That is XERK-235's failure: an agent whose staged history
    // outgrew the cap must learn its LIMIT from the 413 and resize, not re-send
    // the same body every beat forever. So an oversize body is read to `cap`
    // first, as it always was, and answered on a connection the client is done
    // with. What keeps that bounded is the budget: those `cap` bytes are charged
    // like any other, so a FLOOD of oversize bodies is refused below on budget
    // (cheaply, before buffering) and only the one or two the hub can afford
    // ever buffer their way to a 413.
    //
    // A declared length is CHECKED against the budget but never CHARGED to it
    // (see chargeBody). The distinction is the whole point: checking costs an
    // attacker's idle socket nothing, because a claim that is never charged is
    // never held, so nothing is denied to anyone else.
    //
    // The check has to exist, though. Node delivers whatever has accumulated in
    // one `data` event — megabytes, not one buffer's worth — so a body refused
    // on its first chunk has already been buffered that far. Waiting for bytes
    // to arrive before refusing let 256 sockets streaming 30 MiB each OOM the
    // hub anyway. Refusing on the claim keeps that to nothing, and a client that
    // under-declares is still caught by the incremental charge below.
    if (Number.isFinite(declared) && declared > 0 && !bodyLaneFor(costOf(declared)))
      return refuse(new BodyBudgetExceeded(bodyInflightBytes), 0);

    req.on("data", (c) => {
      len += c.length;
      if (over) {
        if (len > drainLimit) req.destroy();
        return;
      }
      if (len > cap) return refuse(new BodyTooLarge(cap));
      // Top the charge up to what has actually arrived. Compared in BUDGET
      // UNITS, not wire bytes — against `len` this would stop topping up after
      // the first chunk and a body would ride most of the way in uncharged.
      const want = costOf(len);
      if (want > held) {
        const next = laneForCharge(lane, want - held);
        if (!next) return refuse(new BodyBudgetExceeded(bodyInflightBytes), len);
        if (lane !== "big" && next === "big") {
          // Carry what is already charged into the lane this read now occupies.
          if (lane === "shared") migrateToBigLane(held);
          bigLaneSince = Date.now();
        }
        lane = next;
        chargeBody(want - held, lane);
        held = want;
        // Held the exclusive lane too long, however well-behaved: see
        // BIG_LANE_MAX_HOLD_MS for why progress alone cannot bound this.
        if (lane === "big" && Date.now() - bigLaneSince > BIG_LANE_MAX_HOLD_MS)
          return refuse(new BodyStalled(), len);
        if (!progressNeeded || len - progressMark >= progressNeeded) armIdle();
      }
      data += c;
    });
    req.on("end", () => { if (!over) { disarmIdle(); release(); resolve(data); } });
    req.on("error", (e) => { disarmIdle(); release(); reject(e); });
  });
}

// How much past `cap` readRawBody keeps draining before it gives up on saying
// anything and cuts the socket. Draining is what lets the route answer 413 on
// the same connection — destroying it mid-body reaches the client as a socket
// hang up, and "the network broke" is the wrong thing to tell someone whose
// file was simply too big (XERK-234).
const RAW_BODY_DRAIN_SLACK = 1 << 20; // 1 MiB
// How many refused bodies may be draining at once. Draining is unbuffered, but
// it is not free: Node allocates for every read it hands us, and 256 sockets
// each streaming past an oversize refusal out-allocated the collector and
// OOM-killed the hub at the deployed 256m — unauthenticated, via /api/login's
// 1 MiB cap. Past this many, a refusal stops reading and closes instead.
//
// The count, not a byte budget, is what matters: the cost is concurrent read
// churn, and the whole point of draining is that the bytes are never kept.
// Small enough to bound the flood, and comfortably more than the number of
// oversize bodies a healthy fleet produces at once — which is normally zero, and
// one when a host's staged history has outgrown HEARTBEAT_MAX. That one still
// drains, still gets its 413, and still resizes against it (XERK-235); only a
// flood is cut off, and only past the point where draining is what is killing us.
const DRAIN_CONCURRENCY_MAX = Number(process.env.DRAIN_CONCURRENCY_MAX) || 8;
let drainingNow = 0;

// The same courtesy, rationed, for a body refused on BUDGET rather than on size.
// A budget refusal happens when the hub is ALREADY at its ceiling and, unlike an
// oversize one, happens to many requests at once — 256 sockets each draining a
// megabyte to read their 503 is a quarter-gigabyte of churn at exactly the wrong
// moment, and it OOM-killed the hub even though not one of those bodies was
// being buffered. This is enough for the response to flush and no more.
const BUDGET_DRAIN_SLACK = 64 << 10; // 64 KiB

// How long a body holding budget may go silent before the hub takes it back.
//
// The budget bounds how MUCH may be held; without this nothing bounded how
// LONG. One socket that streamed 22 MiB and then simply stopped took the big
// lane and refused every other body on the hub — tiny heartbeats and the
// operator's own login included — until `requestTimeout` (300s) expired, and it
// cost ~0.6 kbit/s to renew forever. A hold with no progress is not slow, it is
// abandoned, and the two are told apart by whether bytes are still arriving.
//
// Only armed while a read actually holds a charge, and reset by every chunk, so
// a genuinely slow client on a bad link is untouched — it keeps sending. The
// window is generous for that reason: this is not a throughput floor.
const BODY_IDLE_TIMEOUT_MS = Number(process.env.BODY_IDLE_TIMEOUT_MS) || 20 * 1000;

// ...and how much must ARRIVE in that window for the body to count as making
// progress. This is the half that matters.
//
// A window reset by ANY byte is not a liveness check, it is a heartbeat an
// attacker can forge: one byte every 15s is neither silence nor slowness, and it
// held the big lane — refusing every POST on the hub, operator login included —
// indefinitely, for about 0.5 bit/s after a one-time 22 MiB warmup. Renewing
// cost nothing because it never had to re-stream.
//
// So the rule is a minimum RATE, not a minimum sign of life: roughly 3 KiB/s at
// the defaults. That is far below anything the fleet does — agents reach the hub
// over a LAN or the tunnel — and far above what a dribble can fake. The floor
// gives way to what is actually left of the body, so a nearly-complete upload is
// never reclaimed for the sake of a few last bytes; an attacker cannot use that,
// since holding a big charge requires a large body with a large remainder.
const BODY_MIN_PROGRESS_BYTES =
  Number(process.env.BODY_MIN_PROGRESS_BYTES) || 64 << 10; // 64 KiB per window

// The longest any ONE body may occupy the exclusive big lane, however well it
// behaves. The progress floor cannot close this on its own: a body dribbling AT
// the floor is byte-for-byte indistinguishable from a legitimate slow migration
// at the same rate, so no rate threshold separates them and raising the floor
// only moves the price. This is the orthogonal bound — not "are you making
// progress" but "you have had the lane long enough".
//
// Generous on purpose: the largest body that reaches this budget is a
// BODY_INFLIGHT_MAX heartbeat, which clears the window at a few dozen KiB/s —
// far below what a LAN or the tunnel does. (The 65 MiB migration bundle spools
// to disk and is not charged here at all.) What this denies is the indefinite
// hold — an attacker must re-establish rather than sit there forever.
const BIG_LANE_MAX_HOLD_MS =
  Number(process.env.BIG_LANE_MAX_HOLD_MS) || 10 * 60 * 1000;

// Thrown when a body holding budget stops arriving. Its socket is destroyed —
// a caller that stopped mid-body is not waiting to read a status, and by this
// point it is holding room the rest of the fleet needs.
class BodyStalled extends Error {
  constructor() {
    super("body stalled while holding the in-flight budget");
    this.stalled = true;
  }
}

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
    // Charged and released exactly as readBody does — the two readers must stay
    // in step, or the budget bounds only half of what the hub buffers.
    let held = 0;
    let lane = null;
    let bigLaneSince = 0;
    let draining = false;
    let drainLimit = cap + RAW_BODY_DRAIN_SLACK;
    const release = () => { releaseBody(held, lane); held = 0; lane = null; };
    const endDrain = () => { if (draining) { draining = false; drainingNow--; } };
    // Armed only while this read holds budget, and reset by every chunk: a slow
    // client keeps sending and is never touched; an abandoned one is.
    let idleTimer = null;
    // Where `len` stood when the window opened, and how much further it must get
    // before the window may be reopened. Without these the window resets on any
    // byte and a dribble holds its charge for as long as it likes.
    let progressMark = 0;
    let progressNeeded = 0;
    const disarmIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
    const armIdle = () => {
      disarmIdle();
      progressMark = len;
      // Never ask for more than the body has left to give, so a nearly-finished
      // upload is not reclaimed over its last few bytes.
      const left = Number.isFinite(declared) && declared > len ? declared - len : Infinity;
      progressNeeded = Math.max(1, Math.min(BODY_MIN_PROGRESS_BYTES, left));
      idleTimer = setTimeout(() => {
        if (over) return;
        // Reclaiming exists to relieve CONTENTION, so it only fires under it.
        // On a hub with room to spare a stalled read is blocking nobody, and
        // dropping it would be a pure false positive — a small request over a
        // bad link holds a few hundred KB of a 64 MiB budget and monopolizes
        // nothing. Under pressure the non-progressing reads are exactly the
        // ones that should give way.
        if (!budgetUnderPressure(lane)) return armIdle();
        over = true;
        release();
        reject(new BodyStalled());
        try { req.destroy(); } catch {}
      }, BODY_IDLE_TIMEOUT_MS);
      // Must not hold the process open on its own (the suite would never exit).
      if (idleTimer.unref) idleTimer.unref();
    };
    req.on("close", () => { endDrain(); disarmIdle(); });
    const refuse = (err, from = cap) => {
      over = true;
      chunks = []; // release what we'd buffered — it is not going to be used
      drainLimit = from + (err.budgetExceeded ? BUDGET_DRAIN_SLACK : RAW_BODY_DRAIN_SLACK);
      // Draining is capped by CONCURRENCY, not just by length. Under the cap
      // this reads on so the route can answer on the same connection — that is
      // how an agent whose staged history outgrew HEARTBEAT_MAX learns its own
      // limit and resizes instead of looping offline (XERK-235). Past it, the
      // request reads nothing more and `noDrain` tells the route to close: the
      // courtesy is what is killing the hub by then, and a reset the caller
      // retries beats a status nobody is alive to read.
      if (drainingNow >= DRAIN_CONCURRENCY_MAX) { drainLimit = 0; err.noDrain = true; }
      else { drainingNow++; draining = true; }
      release();
      disarmIdle();
      // A budget refusal STOPS READING rather than draining. Draining is a
      // courtesy paid out of the very resource that has just run out, and Node
      // hands us whatever has accumulated in one `data` event — megabytes — so
      // even "destroy on the first chunk" costs a chunk per socket, and 256 of
      // those OOM-killed the hub with not one body being buffered. Paused, the
      // bytes stop at the kernel's socket buffer and TCP backpressure tells the
      // client to stop; the 503 already queued still flushes, and Node closes
      // the connection once it has.
      if (err.budgetExceeded || err.noDrain) req.pause();
      reject(err);
    };

    // Same rule readBody follows: checked against the budget, charged to nothing,
    // and NOT refused early for being oversize — see readBody for why.
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > 0 && !bodyLaneFor(declared))
      return refuse(new BodyBudgetExceeded(bodyInflightBytes), 0);

    req.on("data", (c) => {
      len += c.length;
      if (over) {
        // Still coming after we've said no: read and throw it away up to a
        // point, then stop paying for a client that won't.
        if (len > drainLimit) req.destroy();
        return;
      }
      // BodyTooLarge, like readBody (and spoolRawBody): callers test `.tooLarge`
      // to tell "your body is too big, send less" (413) from "the hub is
      // momentarily full, send it again" (503), and those must not collapse.
      // A plain Error left BOTH this reader's callers — the archive raw ingest
      // and the migration blob relay — answering 400 for an oversized body.
      if (len > cap) return refuse(new BodyTooLarge(cap));
      if (len > held) {
        const next = laneForCharge(lane, len - held);
        if (!next) return refuse(new BodyBudgetExceeded(bodyInflightBytes), len);
        if (lane !== "big" && next === "big") {
          // Carry what is already charged into the lane this read now occupies.
          if (lane === "shared") migrateToBigLane(held);
          bigLaneSince = Date.now();
        }
        lane = next;
        chargeBody(len - held, lane);
        held = len;
        // Held the exclusive lane too long, however well-behaved: see
        // BIG_LANE_MAX_HOLD_MS for why progress alone cannot bound this.
        if (lane === "big" && Date.now() - bigLaneSince > BIG_LANE_MAX_HOLD_MS)
          return refuse(new BodyStalled(), len);
        if (!progressNeeded || len - progressMark >= progressNeeded) armIdle();
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!over) { disarmIdle(); release(); resolve(Buffer.concat(chunks)); } });
    req.on("error", (e) => { disarmIdle(); release(); reject(e); });
  });
}

/**
 * Close the connection under a request whose body we refused on BUDGET, once its
 * response has flushed.
 *
 * Pausing the request is not enough on its own. Node keeps a connection alive by
 * DUMPING an unread body when the response finishes — it resumes the stream we
 * paused and reads the whole thing, discarding it. Discarded or not, those bytes
 * are read into memory, and with 256 sockets each sending a 30 MiB body that is
 * gigabytes of churn while the hub is already at its ceiling. It OOM-killed the
 * hub at the deployed 256m with not one of those bodies being buffered.
 *
 * So the socket goes, and it goes AFTER `finish` so the 503 the caller needs
 * (XERK-264) is on the wire first. The connection is not reusable anyway — we
 * never read its body — which is what `Connection: close` tells the client.
 */
function endRefusedConnection(req, res) {
  try { req.pause(); } catch {}
  const kill = () => { try { req.socket.destroy(); } catch {} };
  if (res.writableFinished) kill();
  else res.once("finish", kill);
}

// Collect a request body straight into a FILE, never the heap (XERK-263), and
// resolve with the byte count. For the migration relay, whose bundle can be 65
// MiB against a hub that runs at mem_limit 256m: buffering one costs a quarter
// of the container's memory, and the operator can start two at once.
//
// Reads with backpressure (the socket is paused whenever the file stream is
// behind) so a fast uploader can't queue the whole body in the write buffer and
// undo the point of spooling. Past `cap` it follows readRawBody's drain rule —
// keep reading a little further so the route can answer 413 on the same
// connection instead of hanging the socket up on the agent.
//
// On ANY failure the partial file is removed BEFORE the rejection lands, so a
// caller only has to fail the migration; on success the file is the caller's to
// unlink (see dropMigrationBlob).
function spoolRawBody(req, cap, filePath) {
  return new Promise((resolve, reject) => {
    let out;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      out = fs.createWriteStream(filePath);
    } catch (e) {
      reject(e);
      return;
    }
    let len = 0;
    let settled = false;
    // Whichever fails first — the request or the file — tears the spool down
    // and rejects exactly once.
    const fail = (err) => {
      if (settled) return;
      settled = true;
      // The socket may be paused on the file stream's backpressure, and that
      // stream is gone — resume so the drain rule above can run (and, on the
      // over-cap path, so the 413 reaches the agent instead of a hang-up).
      req.resume();
      const cleanup = () => fs.unlink(filePath, () => reject(err));
      // A write stream that ALREADY errored has emitted its `close`, so waiting
      // for another one would hang the request forever instead of failing it.
      if (out.destroyed || out.closed) cleanup();
      else { out.once("close", cleanup); out.destroy(); }
    };
    req.on("data", (c) => {
      len += c.length;
      if (settled) {
        // Still coming after we've said no: read and throw it away up to a
        // point, then stop paying for a client that won't stop.
        if (len > cap + RAW_BODY_DRAIN_SLACK) req.destroy();
        return;
      }
      if (len > cap) {
        fail(new BodyTooLarge(cap));
        return;
      }
      if (!out.write(c)) {
        req.pause();
        out.once("drain", () => req.resume());
      }
    });
    req.on("error", fail);
    req.on("aborted", () => fail(new Error("request aborted")));
    req.on("end", () => {
      if (settled) return;
      // Resolve only once the bytes are actually on disk — the target agent may
      // GET this file the moment the migration flips to `importing`.
      //
      // **The end callback's error is the whole point of this shape**: a write
      // that fails during the FINAL flush (an ENOSPC on the last ≤64 KiB, which
      // is every body small enough to fit the write buffer) surfaces here and
      // nowhere else. Swallowing it answered 200 for a truncated bundle, which
      // the target then failed to unpack with nothing logged anywhere. Settle
      // only INSIDE the callback, so `fail` is still armed when it fires.
      out.end((err) => {
        if (err) return fail(err);
        // Resolve with what reached the DISK, never with what came off the
        // socket: a short write is a corrupt bundle, not a smaller one.
        if (out.bytesWritten !== len)
          return fail(new Error(`spool wrote ${out.bytesWritten} of ${len} bytes`));
        // And resolve on `close`, not here: the end callback runs BEFORE the
        // descriptor is closed (end-cb → finish → close), so a close(2) failure
        // would land on `error` after a resolve and be swallowed — the same
        // shape as the flush error above.
        out.once("close", () => {
          if (settled) return;
          settled = true;
          resolve(len);
        });
      });
    });
    out.on("error", fail);
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

// Did this request carry a VALID agent credential, whatever host it is for?
// Weaker than agentBearerKind only in that it doesn't say which host — it still
// refuses an unknown token outright, which is what keeps an anonymous caller off
// the heartbeat's 32 MiB body read (XERK-268). The one caller is that pre-body
// gate; everywhere else has a host in hand and must bind to it.
function agentPresented(req) {
  if (!TURMA_AGENT_TOKEN) return true;
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    const token = header.slice(7);
    if (tokenHost(token)) return true;
    // Under TURMA_AGENT_STRICT the master is not a credential at all, and that
    // has to hold HERE and not only at the authorization check past it: this
    // gate stands in front of the 32 MiB read, so leaving the master usable
    // through it means a leaked master still OOMs the hub on a fleet whose
    // whole point was that the master had been retired.
    return !TURMA_AGENT_STRICT && safeEqual(token, TURMA_AGENT_TOKEN);
  }
  return userAuthorized(req) && !!TURMA_PASSWORD;
}

// The heartbeat's pre-body gate as a response. Refusing the master under strict
// costs the caller the host-named 403 that agentHostRefusal gives every other
// surface — the host is still unread, in the body behind this gate — so say the
// same thing without it, rather than dropping an agent mid-rollover onto a bare
// "unauthorized" it cannot act on (XERK-268).
function agentPresentedRefusal(req) {
  if (agentPresented(req)) return null;
  const token = (req.headers.authorization || "").startsWith("Bearer ")
    ? req.headers.authorization.slice(7) : "";
  if (TURMA_AGENT_STRICT && TURMA_AGENT_TOKEN && token && safeEqual(token, TURMA_AGENT_TOKEN)) {
    return {
      status: 403,
      error: "this hub requires each agent's own token (TURMA_AGENT_STRICT is set), not the fleet master",
    };
  }
  return { status: 401, error: "unauthorized" };
}

// WHAT an agent-authed request proved about which host it is (XERK-268). Every
// agent-authed surface names a host — the `<host>` path segment, the heartbeat's
// `device`, the tunnel's `?name=` — and this says whether the credential backs
// that claim. Four outcomes:
//
//   "proved"   the bearer is this host's derived token, so `host` is the
//              credential's and not the caller's to pick;
//   "operator" the ordinary user login (Basic/cookie). The operator owns the
//              whole fleet and can already drive every host through the user
//              API, so they may name any host — this is what keeps the
//              documented curl paths working;
//   "legacy"   the raw fleet master. It authenticates "some agent in this
//              fleet" and NOTHING about which one, which is the pre-XERK-268
//              trust model, kept so a host that hasn't been given its derived
//              token yet keeps working. TURMA_AGENT_STRICT refuses it;
//   null       not an agent credential at all (or the wrong host's).
//
// `host` null asks only "is this an agent at all" — the coarse gate before a
// body has been parsed. Never let a route settle for that when it has a host to
// check: "authenticated" is not "is who it says it is".
function agentBearerKind(req, host) {
  // Unconfigured hub: no token check at all (warned about loudly at boot).
  if (!TURMA_AGENT_TOKEN) return "legacy";
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    const token = header.slice(7);
    const bound = tokenHost(token);
    // A host token proves exactly one host. Naming any other is the
    // impersonation this exists to refuse — not a fallback to `legacy`.
    if (bound) return host != null && bound === host ? "proved" : null;
    if (safeEqual(token, TURMA_AGENT_TOKEN)) return "legacy";
    return null;
  }
  return userAuthorized(req) && !!TURMA_PASSWORD ? "operator" : null;
}

// The gate every host-scoped agent route goes through: resolve the credential
// against the host the caller NAMED and turn it into a response, or null to
// carry on. Refusals are worded so the operator can act on them, per the hub's
// refusal contract — a rolled-over agent hitting a strict hub, or a strict hub
// meeting a host still on the master, must not read as a generic 401.
function agentHostRefusal(req, host) {
  const kind = agentBearerKind(req, host);
  if (!kind) {
    // A token that IS a host token, for a different host, gets said out loud.
    // The commonest cause by far is not an attack but a host RENAME — the name
    // is inside the token, so the agent's credential silently stops matching —
    // and "unauthorized" sends the operator hunting for a wrong secret instead
    // of a changed name. It tells the caller nothing it doesn't already hold:
    // the token names its own host on its face.
    const bound = tokenHost((req.headers.authorization || "").slice(7));
    if (bound) {
      return {
        status: 403,
        error: `this agent token is ${bound}'s, not ${host}'s — a host's token is derived from its name, so re-derive it if the host was renamed`,
      };
    }
    return { status: 401, error: "unauthorized" };
  }
  if (kind === "legacy" && TURMA_AGENT_STRICT && TURMA_AGENT_TOKEN) {
    return {
      status: 403,
      error: `this hub requires ${host}'s own agent token (TURMA_AGENT_STRICT is set), not the fleet master`,
    };
  }
  return null;
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
//
// `host` is the host this socket claims to be (XERK-268): `?name=` on the
// control channel, and the host the data channel's `ch` was opened FOR on the
// data channel — a socket may only be the host its credential derives to. Null
// means there is no claim to check, which is not a state either caller is in.
function agentWsAuthorized(url, req, host) {
  if (!TURMA_AGENT_TOKEN) return true;
  const token = url.searchParams.get("token");
  if (token) {
    if (host != null && safeEqual(token, hostAgentToken(host))) return true;
    return !TURMA_AGENT_STRICT && safeEqual(token, TURMA_AGENT_TOKEN);
  }
  return !agentHostRefusal(req, host);
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
/**
 * `String(x)` for a value that came off the wire — it CANNOT throw (XERK-278).
 *
 * Plain `String(x)` throws `TypeError: Cannot convert object to primitive value`
 * when a value has no usable primitive conversion, and **pure JSON can express
 * one**: `{"toString":1,"valueOf":1}` gives both hooks as own, non-callable
 * properties, so neither ToPrimitive path works. `JSON.parse` of an
 * attacker-controlled body produces exactly that object.
 *
 * That was a one-packet remote kill of the whole hub. `sanitizeLiveAgents` has
 * three callers; two are on the heartbeat path, where the request handler's
 * catch turns the throw into a 400. The third is the `/agent/control` WebSocket
 * frame handler, which runs inside a `socket.on("data")` listener with no
 * try/catch above it — and this process installs no `uncaughtException` handler,
 * so the throw exited node. Under DockerOps' `restart: unless-stopped` that is a
 * repeatable outage loop of the fleet's entire control plane, and the ordinary
 * single-user web login is enough to open the socket.
 *
 * Fixed HERE rather than by wrapping the caller: a coercion that throws on
 * untrusted input is the bug, and a caller-side guard is one that the next
 * caller gets added without.
 */
function safeString(v) {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try {
    return String(v);
  } catch {
    // Unconvertible. Treated as absent, which is what every field here already
    // does with a missing value — nothing downstream could render it anyway.
    return "";
  }
}

function sanitizeLiveAgents(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const type = safeString(a.type).slice(0, LIVE_AGENT_FIELD_MAX);
    if (!type) continue;
    out.push({ sel: !!a.sel, type,
      label: safeString(a.label).slice(0, LIVE_AGENT_FIELD_MAX) });
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
    // The session's own title (its `summary`) is what the operator recognises on
    // the phone — the Sessions screen leads with it too. `rcName` is the
    // structural <host>-<repo>-<key> spawn id, which means nothing at a glance,
    // so it stands in only while a summary has not been generated yet.
    const label = session.summary || session.rcName || `${key} · ${session.repo}@${session.branch}`;
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

// ---- the hub-side ticket queue (XERK-296) ----------------------------------
// Work waiting for a session is a QUEUED TICKET on the hub, not a session record
// on a host. Before this, a spawn that couldn't run right now was still routed
// to a host immediately and the AGENT turned it into a real session — id minted,
// host claimed, ledger entry, card on the board — that then sat doing nothing
// until a slot freed. Two things were wrong with that:
//   - it isn't a session. It has no worktree, no conversation and no branch; it
//     is a promise to start one, and showing it as a session made the fleet look
//     busier than it was and made "cancel this" read as "kill a session".
//   - it nailed the ticket to ONE host at the moment it was queued. In an org
//     with several agents, a slot freeing on any OTHER host couldn't take it —
//     the work waited for the machine it happened to be assigned, which is the
//     complaint this ticket opens with.
// So the queue lives here, holds tickets, and the HOST IS CHOSEN AT DISPATCH:
// drainTicketQueue() re-runs findTicketHost (with requireFree) every beat, so
// whichever agent frees a slot first gets the oldest waiting ticket.
//
// The agent-side session queue (XERK-14) is unchanged and still carries what it
// is actually for: an explicit "+ New session" on a host the operator named, and
// a ticket session waiting on its repo to finish cloning — both cases where the
// host IS the decision and the work has already begun there. A ticket spawn can
// still land in it if a host fills between our capacity read and its beat; that
// is a race, not the normal path, and it drains as it always did.
//
// Deliberately IN-MEMORY, like the migration records and the auto-start attempt
// map: a hub restart drops the queue rather than starting a burst of sessions
// from a boot-time replay of stale intent. Auto-queued tickets come straight
// back on the next sweep; a manually queued one is lost and has to be clicked
// again (its ticket is untouched, so nothing is destroyed by that).
const TICKET_QUEUE_MAX = 200;
// And how many ONE ORG may hold. The fleet cap alone is not a cap: an ordinary
// 250-ticket To Do backlog on one opted-in org filled all 200 in a single sweep,
// and every OTHER org's Start button then answered "the ticket queue is full" —
// one org's routine backlog switching ticket-starting off fleet-wide. The queue
// is drained per org (capacity is per org), so a per-org line is the real
// resource; the fleet cap is only the memory bound behind it.
const TICKET_QUEUE_PER_ORG_MAX = 25;
// …of which the SWEEP may hold this many. The rest is reserved for a person: an
// opted-in org's backlog refills its line every 15s, so without a reserve the
// per-org cap simply moved the starvation one level down — the operator's own
// Start button answering "that org already has 25 tickets waiting" for as long
// as the backlog lasts. Auto work is re-derivable and can wait; a click can't.
const TICKET_QUEUE_PER_ORG_AUTO_MAX = 20;
// Longest a hold reason from findTicketHost is carried on an entry — it is
// operator-facing text that rides /api/agents to every client.
const TICKET_QUEUE_ERROR_MAX = 300;
// Longest an issue key / siteKey may be to enter the queue. Both come off an
// AGENT's jira block on the sweep path, and an entry is served to every client
// on the fleet payload, so they are bounded HERE — see enqueueTicketStart.
const TICKET_KEY_MAX = 64;
const TICKET_SITE_MAX = 200;
// How long an entry may sit with its ticket unresolvable (no reporting org lists
// it any more) before it is dropped. Long enough to ride out a poll gap or a
// host restart, short enough that a deleted/renamed ticket can't hold a place in
// its org's line forever.
const TICKET_QUEUE_STALE_MS = 10 * 60 * 1000;
// How long an entry may sit "blocked" — a hold only the operator can clear (no
// triaged repo, a pinned agent that's gone).
const TICKET_QUEUE_BLOCKED_MAX_MS = 30 * 60 * 1000;
// The longest ANY entry may wait, however good its reason. This is what bounds
// a manual entry rather than second-guessing it from fleet state: a click is one
// operator asking for one session, and the only honest ways to end it are their
// cancel, its own dispatch, its ticket reaching Done, or giving up out loud
// after a while. Long enough that an org busy all afternoon still starts the
// work; short enough that nobody is surprised by a session tomorrow.
const TICKET_QUEUE_MAX_WAIT_MS = 4 * 60 * 60 * 1000;
// …and when it does end that way, the entry does NOT silently vanish. It goes
// TERMINAL — `reason:"expired"`, still on the payload, rendered as "gave up
// waiting" with the ✕ to dismiss — for this long. A queued click disappearing
// without a word reads exactly like someone else cancelling it, which is the
// class of thing this whole ticket is about: work that goes missing quietly. A
// terminal entry never dispatches and never counts against a line's length.
const TICKET_QUEUE_EXPIRED_TTL_MS = 60 * 60 * 1000;
// How many notes may be held at once. They count against no line, so this is the
// only thing bounding them.
const TICKET_QUEUE_NOTES_MAX = TICKET_QUEUE_MAX;
// How long a dispatch is remembered, so a cancel that LOST to it can say so
// rather than 404ing as if the ticket had never been queued.
const TICKET_DISPATCH_MEMO_MS = 5 * 60 * 1000;
// XERK-485 [E]: the auto stream and the queue are ordered by the model's
// triage, not just by repo tier. Lower rank comes first. An unknown band or
// type (no triage yet, or one whose field survived sanitization as something
// else) sorts AFTER every real one — an unassessed ticket never outranks one
// the model actually assessed.
const TRIAGE_PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
const NO_PRIORITY_RANK = 9;
// Within one band, the KIND of work: a P1 bug ahead of a P1 doc nit. Same
// unknown-sorts-last rule as the band.
const TRIAGE_TYPE_WEIGHT = {
  bug: 0, task: 1, feature: 2, improvement: 3, chore: 4, documentation: 5, other: 6,
};
const NO_TYPE_WEIGHT = 7;
// XERK-485 [E]: the per-org RATE LIMIT on auto-started sessions. A burst of
// ready tickets (a backlog the fleet just freed up) must not start them all in
// the same beat: the shared login, the clone storms and the tracker load all
// argue for a trickle. The limit counts DISPATCHES (an auto entry handed to a
// host), not queue entries — sitting in line commits nothing, exactly as with
// the attempt backoff. A manual click is a deliberate intent and is never
// rate-held. Over the limit an entry HOLDS (`reason:"rate"`) rather than
// dropping: a hold is not a give-up, and the max-wait backstop is what ends it.
// A dispatch that turns out to have started no session refunds its slot on the
// next backoff re-attempt, so a flapping ticket cannot starve the org's budget.
const TICKET_QUEUE_RATE_MAX = 5;
const TICKET_QUEUE_RATE_WINDOW_MS = 15 * 60 * 1000;
// FIFO. Entries: {siteKey, issueKey, source:"auto"|"manual", at, reason, error,
// blockedSince, unknownSince, expiredAt}. `reason` is why it is STILL waiting, as of the
// last drain: "capacity" (some host will free up), "blocked" (something the
// operator has to fix — the text is in `error`), "rate" (the org's auto-start
// rate window is still full — also self-clears), or null before the first drain
// has judged it.
const ticketQueue = [];
// "<siteKey>\x00<issueKey>" -> when its spawn was handed to a host. Bounded by
// the prune in rememberDispatch; read only by the cancel route.
const ticketDispatchedAt = new Map();

// XERK-485 [E]: per-org rolling-window rate limit on AUTO dispatches.
// siteKey -> [{at, key}] of the auto dispatches still inside the window.
// In-memory like the queue itself: a hub restart resets the window, which is
// the safe side (a fresh hub starting a few extra sessions is far less harmful
// than replaying a stale budget). `key` is the ticket's queue key, so a refund
// removes THIS ticket's own stamp, never somebody else's.
const autoStartRate = new Map();

// The org's live stamps, with anything older than the window pruned. Callers
// read `.length` only; stamping goes through recordAutoStartRate so an org's
// first stamp is always stored, not pushed into a throwaway array.
function autoStartRateLive(siteKey, now) {
  const live = (autoStartRate.get(siteKey) || []).filter(
    (s) => now - s.at < TICKET_QUEUE_RATE_WINDOW_MS);
  if (live.length) autoStartRate.set(siteKey, live);
  else autoStartRate.delete(siteKey);
  return live;
}

function recordAutoStartRate(siteKey, key, now) {
  const live = (autoStartRate.get(siteKey) || []).filter(
    (s) => now - s.at < TICKET_QUEUE_RATE_WINDOW_MS);
  live.push({ at: now, key });
  autoStartRate.set(siteKey, live);
}

// A dispatch that was acked but left no session spent its rate slot for nothing
// — hand this ticket's own newest stamp back so a flapping ticket cannot
// starve the org's window. (If the stamp already aged out of the window there
// is nothing to refund and this is a no-op.)
function refundAutoStartRate(siteKey, key, now) {
  const live = (autoStartRate.get(siteKey) || []).filter(
    (s) => now - s.at < TICKET_QUEUE_RATE_WINDOW_MS);
  for (let i = live.length - 1; i >= 0; i--) {
    if (live[i].key === key) { live.splice(i, 1); break; }
  }
  if (live.length) autoStartRate.set(siteKey, live);
  else autoStartRate.delete(siteKey);
}

function ticketQueueKey(siteKey, issueKey) {
  return (siteKey || "") + "\x00" + issueKey;
}

// Say a thing at most once every TICKET_LOG_THROTTLE_MS. The sweep re-derives
// its whole verdict every 15 seconds, so any line about a STATE ("this org is at
// its share", "this row can't be queued") is a line about a condition that will
// still be true in 15 seconds — printed raw, it buries the log in the case it
// exists to explain. Per-event lines (queued, dispatched, dropped) are not
// throttled: those are things that happened once.
const TICKET_LOG_THROTTLE_MS = 10 * 60 * 1000;
const ticketLogAt = new Map();
function logQueueState(key, msg) {
  const now = Date.now();
  const last = ticketLogAt.get(key);
  if (last && now - last < TICKET_LOG_THROTTLE_MS) return;
  for (const [k, at] of ticketLogAt) {
    if (now - at > TICKET_LOG_THROTTLE_MS) ticketLogAt.delete(k);
  }
  ticketLogAt.set(key, now);
  console.log(msg);
}

function queuedTicket(siteKey, issueKey) {
  return ticketQueue.find(
    (e) => e.siteKey === siteKey && e.issueKey === issueKey) || null;
}

// The same lookup, but only for an entry that is actually WAITING. A terminal
// note answers `queuedTicket` and must not stand in for a place in line —
// treating one as "already queued" is what made a note block its own ticket's
// auto-start for the whole hour it was on screen.
function liveQueuedTicket(siteKey, issueKey) {
  const e = queuedTicket(siteKey, issueKey);
  return e && !e.expiredAt ? e : null;
}

function liveQueueCount() {
  return ticketQueue.reduce((n, e) => n + (e.expiredAt ? 0 : 1), 0);
}

// Terminal notes are bounded on their own, since they count against no line: a
// fleet that saturates for hours can mint one per expired entry, and each lives
// TICKET_QUEUE_EXPIRED_TTL_MS. Oldest notes go first — they are the ones most
// likely to have been read, and none of them is work.
function sweepExpiredNotes() {
  const notes = ticketQueue.filter((e) => e.expiredAt);
  const over = notes.length - TICKET_QUEUE_NOTES_MAX;
  if (over <= 0) return;
  notes.sort((x, y) => x.expiredAt - y.expiredAt);
  for (const e of notes.slice(0, over)) {
    const i = ticketQueue.indexOf(e);
    if (i >= 0) ticketQueue.splice(i, 1);
  }
}

// May this ticket join the line, and if not, WHY not — the wording an operator
// gets and, just as importantly, what the sweep should do about it. The three
// refusals are different facts and were once all reported as "the queue is
// full": an unqueueable ROW is one ticket's problem and the sweep must skip past
// it (reporting it as a full queue made one bad row truncate an org's auto-start
// at that row, every sweep, forever), while a full line is the whole org's.
//   "ok" | "invalid" | "org-auto-full" | "org-full" | "fleet-full"
// `priority` (optional, "P0".."P3"): XERK-485 preemption — a P0 AUTO ticket may
// exceed the sweep's share AND the org's line; only the fleet's memory bound
// still stops it. Manual entries and lower bands are unaffected.
function ticketQueueAdmission(siteKey, issueKey, source, priority) {
  if (typeof siteKey !== "string" || !siteKey || siteKey.length > TICKET_SITE_MAX) return "invalid";
  if (typeof issueKey !== "string" || issueKey.length > TICKET_KEY_MAX
      || !isIssueKey(issueKey)) {
    return "invalid";
  }
  const cur = queuedTicket(siteKey, issueKey);
  if (cur && !cur.expiredAt) return "ok";               // already in line
  // A terminal entry holds no place, so it neither blocks its own re-queue nor
  // counts toward the lines below.
  const mine = ticketQueue.filter((e) => e.siteKey === siteKey && !e.expiredAt);
  const preempt = source === "auto" && priority === "P0";
  if (!preempt
      && source === "auto"
      && mine.filter((e) => e.source === "auto").length >= TICKET_QUEUE_PER_ORG_AUTO_MAX) {
    return "org-auto-full";
  }
  if (!preempt && mine.length >= TICKET_QUEUE_PER_ORG_MAX) return "org-full";
  // The fleet cap is a LINE'S LENGTH, and a terminal note is not in the line —
  // counting it let dead notes 429 a live click from an unrelated org, which is
  // the refusal this ticket exists to remove. Notes are bounded separately, by
  // sweepExpiredNotes below.
  if (liveQueueCount() >= TICKET_QUEUE_MAX) return "fleet-full";
  return "ok";
}

// The queue as clients see it, oldest first, with each entry's 1-based place in
// its OWN org's line — capacity is per org, so "3rd waiting" only means anything
// among the tickets competing for the same hosts.
function ticketQueuePayload() {
  const seen = new Map();
  return ticketQueue.map((e) => {
    // A terminal entry is not IN the line — it is a note about one that ended —
    // so it takes no place and doesn't push the tickets behind it down.
    const n = e.expiredAt ? 0 : (seen.get(e.siteKey) || 0) + 1;
    if (!e.expiredAt) seen.set(e.siteKey, n);
    return { siteKey: e.siteKey, issueKey: e.issueKey, source: e.source,
      queuedAt: e.at, position: n, reason: e.reason || null,
      error: e.error || null };
  });
}

// Rides /api/agents like ticketAgents/autoStartOrgs, plus its own SSE event so
// an open board reflects a queue change without waiting out the poll.
//
// The CACHE is invalidated synchronously (the next reader must not be served a
// stale payload) but the BROADCAST is coalesced to the end of the turn: a sweep
// queues one ticket at a time, and publishing per entry made a routine backlog
// cost every open board a frame per ticket — 201 frames and 2.8 MB for 200
// tickets. Every caller in one synchronous pass therefore shares one frame.
let ticketQueueBroadcastPending = false;
function publishTicketQueue() {
  invalidateAgentsCache();
  if (ticketQueueBroadcastPending) return;
  ticketQueueBroadcastPending = true;
  setImmediate(() => {
    ticketQueueBroadcastPending = false;
    sseBroadcast("ticketQueue", ticketQueuePayload());
  }).unref?.();
}

// Remember that a ticket's spawn went out, so the cancel route can tell "you
// already cancelled this" from "this started a moment ago" — the queue entry is
// gone in both cases, and answering the second like the first told an operator
// their cancel worked while a session was starting.
function rememberDispatch(siteKey, issueKey) {
  const now = Date.now();
  for (const [k, at] of ticketDispatchedAt) {
    if (now - at > TICKET_DISPATCH_MEMO_MS) ticketDispatchedAt.delete(k);
  }
  ticketDispatchedAt.set(ticketQueueKey(siteKey, issueKey), now);
}

function dispatchedRecently(siteKey, issueKey) {
  const at = ticketDispatchedAt.get(ticketQueueKey(siteKey, issueKey));
  return !!at && Date.now() - at <= TICKET_DISPATCH_MEMO_MS;
}

// Put a ticket in line. Returns the entry, or null when it can't be queued (a
// key this hub won't serve, or a full line).
//
// One entry per ticket: a click on a ticket the sweep already queued UPGRADES it
// to "manual" rather than adding a second. That upgrade is the point — an
// operator who asked for this by hand keeps their place when the org's auto
// switch goes off, and only the auto-queued entries are swept away.
//
// The key is validated HERE, not only on the manual route. On the sweep path
// both fields come from an AGENT's `jira` block — untrusted — and an entry is
// then served to every client on the top-level payload, where Android TYPES
// `issueKey` as a String and decodes the whole payload atomically. An object or
// a 20k-char key from one buggy host would break every phone's fleet decode,
// hub-wide rather than per-host, and no `normalize*` covers this list: this
// check is that coercion. `priority` (optional) carries the ticket's triage
// band so a P0 auto ticket can preempt a full org line (XERK-485).
function enqueueTicketStart(siteKey, issueKey, source, priority) {
  if (ticketQueueAdmission(siteKey, issueKey, source, priority) !== "ok") return null;
  const existing = queuedTicket(siteKey, issueKey);
  if (existing && !existing.expiredAt) {
    if (source === "manual" && existing.source !== "manual") {
      existing.source = "manual";
      publishTicketQueue();
    }
    return existing;
  }
  // Asking again after it gave up REPLACES the note with a fresh place in line,
  // rather than handing back the dead entry.
  if (existing) dropQueuedTicket(siteKey, issueKey, null);
  const e = { siteKey, issueKey, source: source === "manual" ? "manual" : "auto",
    at: Date.now(), reason: null, error: null, blockedSince: 0, unknownSince: 0 };
  ticketQueue.push(e);
  sweepExpiredNotes();
  publishTicketQueue();
  return e;
}

// Drop one ticket's entry. `why` is for the log only. Returns whether it was there.
function dropQueuedTicket(siteKey, issueKey, why) {
  const i = ticketQueue.findIndex(
    (e) => e.siteKey === siteKey && e.issueKey === issueKey);
  if (i < 0) return false;
  ticketQueue.splice(i, 1);
  if (why) console.log(`ticket queue: dropped ${logName(issueKey)} — ${why}`);
  publishTicketQueue();
  return true;
}

// Every AUTO-queued ticket of one org leaves the queue — the third thing XERK-296
// asks for: turning an org's auto switch off must be able to call the waiting
// work off, and be nothing more than that. It cannot touch a session, because a
// queued ticket ISN'T one; and it leaves manual entries alone, since an operator
// who clicked Start asked for that ticket specifically rather than for the org's
// blanket policy.
function dropAutoQueuedTickets(siteKey) {
  let n = 0;
  for (let i = ticketQueue.length - 1; i >= 0; i--) {
    const e = ticketQueue[i];
    if (e.siteKey !== siteKey || e.source !== "auto") continue;
    ticketQueue.splice(i, 1);
    n++;
  }
  if (n) {
    console.log(`ticket queue: dropped ${n} auto-queued ticket(s) for ${logName(siteKey)}`
      + " — auto-start was switched off");
    publishTicketQueue();
  }
  return n;
}

// Every ticket the fleet reports, indexed "<siteKey>\x00<issueKey>" -> the
// freshest host's row for it. Built ONCE per drain pass, because the drain runs
// on every heartbeat and the walk is over every host's whole ticket list.
//
// **Merged across ALL of an org's hosts, never resolved against one winning
// block.** Each agent polls Jira as `assignee = currentUser()`, so two hosts in
// one org routinely report DIFFERENT ticket lists, and the poll is ~10 minutes
// apart. Picking one block per org therefore made a ticket only the other host's
// Jira user can see look like a ticket that no longer exists — dispatch-blocked
// while it "waited", then aged out and deleted. Freshest-wins is only the
// tie-break for a key two hosts BOTH report.
// One org's rows out of `fleetTicketRows()`.
function ticketRowsForSite(rows, siteKey) {
  return [...rows.values()].filter((r) => r && r.siteKey === siteKey);
}

// The fleet's ticket rows, resolved the way the BOARD resolves them. This is a
// port of `board.js::mergeSites`, and it is the hub's only ticket-row view —
// everything that acts "on what the board shows" reads it rather than walking
// `agents` itself.
//
// TWO stages, and getting either alone wrong has shipped a user-visible bug:
//
//  1. GROUP by (siteKey, user) and keep that group's best block. A host polls as
//     `assignee = currentUser()`, so an org whose hosts authenticate as different
//     Jira users legitimately reports different ticket lists. Collapsing an org to
//     ONE block dropped every ticket belonging to the other user — they sat on the
//     board in To Do and were never started, and a Done only the other user could
//     see never stopped its session.
//  2. UNION those winners, one row per ticket key. Unioning across raw HOSTS
//     instead — skipping the grouping — resurrects the losing block of a
//     same-user pair, so a ticket an offline host still lists but the board has
//     dropped comes back to life and gets auto-started.
//
// Within a group, and between two groups reporting one key, `blockOutranks`
// decides: online first, then freshest. Between two copies of a key the newer
// `updated` wins outright, block rank only breaking that tie — which is
// `mergeSites`' rule, and matters because the two hosts' copies of a ticket
// normally carry an IDENTICAL `updated` (it is the tracker's own field).
function fleetTicketRows() {
  const now = Date.now();
  const byUser = new Map();   // siteKey \x00 user -> winning block
  for (const a of Object.values(agents)) {
    const j = a && a.jira;
    if (!j || !j.siteKey) continue;
    const cand = { block: j, siteKey: j.siteKey, online: agentBlockOnline(a, now),
                   at: String(j.fetchedAt || "") };
    const k = j.siteKey + "\x00" + (j.user || "");
    if (blockOutranks(cand, byUser.get(k))) byUser.set(k, cand);
  }
  const rows = new Map();     // ticketQueueKey -> {row, siteKey, key, online, at}
  for (const w of [...byUser.values()].sort(compareBlocks)) {
    for (const t of w.block.tickets || []) {
      if (!t || !t.key) continue;
      const k = ticketQueueKey(w.siteKey, t.key);
      const cur = rows.get(k);
      // Best-ranked group first, so first-wins IS block rank; a strictly newer
      // `updated` still overrides it.
      if (cur && String(t.updated || "") <= String(cur.row.updated || "")) continue;
      rows.set(k, { row: t, siteKey: w.siteKey, key: t.key,
                    online: w.online, at: w.at });
    }
  }
  return rows;
}

// Is a spawnTicket for this ticket already riding some org host's command queue?
// The window between dispatch and the session's first heartbeat.
function spawnTicketInFlight(siteKey, issueKey) {
  return Object.values(agents).some((a) =>
    a.jira && a.jira.siteKey === siteKey &&
    (a.commands || []).some(
      (c) => c && c.type === "spawnTicket" && c.issueKey === issueKey));
}

function holdQueued(e, reason, error) {
  const msg = error ? String(error).slice(0, TICKET_QUEUE_ERROR_MAX) : null;
  if (e.reason === reason && e.error === msg) return false;
  e.reason = reason;
  e.error = msg;
  return true;
}

// Hand the highest-priority waiting tickets to whichever hosts can actually
// start them. Visit order (XERK-485 [E]): within an org's line the priority key
// — triage band -> type weight -> repo tier -> FIFO — decides, and across orgs
// the lines interleave round-robin so one backlog can't starve another.
// Runs on every heartbeat (a beat is when capacity changes) and on the 15s
// sweep, so a freed slot is filled within a beat rather than a sweep interval.
//
// AT MOST ONE DISPATCH PER HOST PER PASS, mirroring the agent's own one-per-beat
// drain: provisioning launches claude against the one shared ~/.claude login, so
// handing a host four sessions at once is the contention that stagger exists to
// avoid. A second ticket for the same host waits for the next pass; a ticket for
// a DIFFERENT host in the same pass goes straight out.
//
// An AUTO entry leaves on the sweep's own evidence: a session on any channel, a
// spawn in flight, its org's switch going off, or its ticket leaving To Do.
//
// A MANUAL entry is one operator asking for one session, and the only honest
// ends for it are their cancel, its own dispatch, its ticket reaching Done, and
// the bounded waits below. It is deliberately NOT retired by fleet state — a
// rule that dropped it when the ticket's session count grew swallowed the click
// whenever a session it never asked for appeared (the auto sweep, another
// operator, another board), and a count that can DIP (an agent mid-restart, a
// `closedSessions` eviction) swallowed it with no new session at all. A second
// session on a ticket is a thing the + button exists to ask for, so the queue
// cannot infer the ask from a count it does not own.
//
// Every hold is bounded except `capacity`, the one that clears itself:
// TICKET_QUEUE_MAX_WAIT_MS caps any wait, TICKET_QUEUE_STALE_MS a ticket no host
// reports any more, TICKET_QUEUE_BLOCKED_MAX_MS one nothing can route.
function drainTicketQueue() {
  if (!ticketQueue.length) return;
  const now = Date.now();
  const rows = fleetTicketRows();
  const usedHosts = new Set();
  let started = null;
  let changed = false;
  for (const e of ticketQueueOrder(rows)) {
    const k = ticketQueueKey(e.siteKey, e.issueKey);
    const drop = (why) => {
      const i = ticketQueue.indexOf(e);
      if (i >= 0) ticketQueue.splice(i, 1);
      changed = true;
      if (why) console.log(`ticket queue: dropped ${logName(e.issueKey)} — ${why}`);
    };
    // Every way the hub GIVES UP on an entry, as against the ways it stops being
    // work (dispatched, cancelled, its ticket reached Done). An AUTO entry is
    // re-derivable — the next sweep re-queues it if it still qualifies — so it
    // just goes. A MANUAL one is an operator's click and must never leave the
    // queue silently: it goes TERMINAL, on the payload, with the ✕, exactly as
    // the max-wait backstop below does. The blocked timer used to `drop()` here,
    // which was survivable while only a click could put an entry in this state
    // and the operator was watching it; a reclaimed spawn (XERK-303) arrives
    // without anyone watching, so a click could vanish 30 minutes later with
    // nothing on the board — the class of thing this whole queue exists to stop.
    const giveUp = (why, msg) => {
      if (e.source !== "manual") { drop(why); return; }
      e.expiredAt = now;
      e.reason = "expired";
      // Capped like every other hold reason: this one interpolates
      // findTicketHost's text, which carries a device name, and it rides
      // /api/agents to every client.
      e.error = String(msg).slice(0, TICKET_QUEUE_ERROR_MAX);
      changed = true;
      console.log(`ticket queue: ${logName(e.issueKey)} gave up — ${why}`);
    };
    // A terminal entry is a message to the operator, not work: it holds nothing,
    // dispatches nothing, and leaves once it has been on screen long enough to
    // be read (or the moment they dismiss it with the ✕).
    if (e.expiredAt) {
      if (now - e.expiredAt > TICKET_QUEUE_EXPIRED_TTL_MS) drop(null);
      continue;
    }
    // The backstop under every hold below: nothing waits here indefinitely
    // except a slot that is coming, and even that has an end. It ends VISIBLY —
    // see TICKET_QUEUE_EXPIRED_TTL_MS.
    if (now - e.at > TICKET_QUEUE_MAX_WAIT_MS) {
      const mins = Math.round((now - e.at) / 60000);
      e.expiredAt = now;
      e.reason = "expired";
      e.error = `no agent had a free slot for ${Math.round(mins / 60)} hours, `
        + "so it stopped waiting — start it again when the fleet is quieter";
      changed = true;
      console.log(`ticket queue: ${logName(e.issueKey)} gave up after ${mins} minutes`
        + " without a free slot");
      continue;
    }
    const hit = rows.get(k);
    const row = hit ? hit.row : null;
    // Nobody reports this ticket any more. Give it a while (a poll gap, a host
    // restart) and then let it go — an entry whose ticket has ceased to exist
    // held its org's line open forever, which is what made a full queue permanent.
    if (!row) {
      if (!e.unknownSince) { e.unknownSince = now; changed = true; }
      if (now - e.unknownSince > TICKET_QUEUE_STALE_MS) {
        giveUp("no reporting org lists that ticket any more",
          "no agent reports that ticket any more — it stopped waiting");
      }
      continue;
    }
    if (e.unknownSince) { e.unknownSince = 0; changed = true; }
    const cat = row.statusCategory || null;
    if (cat === "done") { drop("its ticket moved to Done"); continue; }
    if (e.source === "auto") {
      // The auto guards, unchanged in strength from the sweep's: a session on any
      // channel means the work is under way (or was, and was killed), and a spawn
      // in flight means one is about to be.
      // Computed at most once per pass, and only if an auto entry needs it — it
      // walks every host's sessions, closed sessions and resumable scans.
      if (!started) started = startedTicketKeys();
      if (started.has(k)) { drop("it already has a session"); continue; }
      if (spawnTicketInFlight(e.siteKey, e.issueKey)) {
        drop("a spawn for it is already in flight");
        continue;
      }
      if (!autoStartOrgs[e.siteKey]) { drop("auto-start is off for its org"); continue; }
      // Auto-start only ever starts To Do work; a ticket a human has since moved
      // into progress is being handled and shouldn't gain a session behind them.
      if (cat && cat !== "todo") { drop("its ticket left To Do"); continue; }
    }
    const repo = ticketRepo(e.siteKey, e.issueKey, rows);
    if (!repo) {
      // An AUTO entry leaves at once: the sweep only ever queues a ticket that
      // HAS a repo, so it cannot re-queue this one until the triage comes back —
      // no churn. A manual click is given a while to be made good on first.
      if (e.source === "auto") { drop("its ticket has no triaged repo"); continue; }
      changed = holdQueued(e, "blocked", "that ticket has no triaged repo yet") || changed;
      if (!e.blockedSince) e.blockedSince = now;
      if (now - e.blockedSince > TICKET_QUEUE_BLOCKED_MAX_MS) {
        giveUp("it stayed blocked with nothing the hub could do about it",
          "it waited 30 minutes with no triaged repo — triage it and start it again");
      }
      continue;
    }
    // The repo was retiered to "ignore" while this AUTO entry waited (XERK-487).
    // The sweep won't re-queue an ignore-tier repo, so drop it with no churn —
    // exactly like a ticket that lost its triaged repo above. A MANUAL entry is
    // left alone: a hand-started ticket is deliberate intent, not tier-gated.
    if (e.source === "auto" && isRepoIgnored(repo)) {
      drop("its repo is now ignore-tier");
      continue;
    }
    // XERK-485 [E]: the model re-triaged this ticket while it waited and the new
    // assessment says held/rejected (actionable !== true) or names a duplicate.
    // An AUTO entry drops without churn (the sweep's gate won't re-queue it —
    // same rule as a retiered repo above); a MANUAL entry is a deliberate intent
    // and keeps draining. No triage block at all means "can't tell", so it stays
    // dispatchable — the same rule a missing capacity block follows. An explicit
    // operator approve (XERK-486 [F]) overrides this gate.
    const triageAction = e.source === "auto"
      ? ticketTriageAction(e.siteKey, e.issueKey)
      : null;
    if (e.source === "auto" && triageAction !== "approve" && row.triage &&
        (row.triage.actionable !== true || row.triage.dedupeOf)) {
      drop("its triage no longer says actionable");
      continue;
    }
    // XERK-486 [F]: the operator held or rejected this ticket while it waited.
    // The sweep's verdict check won't re-queue it, so drop with no churn — a
    // hold must survive the drain exactly like a retriage. MANUAL entries are
    // deliberate intent and keep draining (same rule as every other auto guard).
    if (e.source === "auto" &&
        (triageAction === "hold" || triageAction === "reject")) {
      drop(`it was ${triageAction} by triage while it waited`);
      continue;
    }
    const { host, error, full } = findTicketHost(
      e.siteKey, repo, e.issueKey, { requireFree: true });
    if (!host) {
      changed = holdQueued(e, full ? "capacity" : "blocked", full ? null : error) || changed;
      // "capacity" clears itself, so it waits (up to the max wait above).
      if (full) { if (e.blockedSince) { e.blockedSince = 0; changed = true; } continue; }
      // A routing failure HOLDS, whatever queued it. Dropping an auto entry here
      // dropped it into the sweep's arms: an org whose hosts are all offline was
      // re-queued 15s later, every 15s, churning the log, the payload and the
      // board's chip for as long as it stayed down. It waits, like a full org
      // does, and the blocked timer below is what ends it if nobody acts.
      if (!e.blockedSince) e.blockedSince = now;
      if (now - e.blockedSince > TICKET_QUEUE_BLOCKED_MAX_MS) {
        giveUp("it stayed blocked with nothing the hub could do about it",
          `it waited 30 minutes and nothing could run it — ${error || "no host was available"}`);
      }
      continue;
    }
    if (e.blockedSince) { e.blockedSince = 0; changed = true; }
    // XERK-485 [E]: the org's auto-start rate window is full — the entry HOLDS
    // (reason "rate", self-clearing like capacity) instead of dropping, and it
    // must NOT claim this host: another org's entry may still take the slot in
    // the same pass. Manual clicks are deliberate intent and are never held.
    if (e.source === "auto" &&
        autoStartRateLive(e.siteKey, now).length >= autoStartRateMax(e.siteKey)) {
      changed = holdQueued(e, "rate",
        "waiting out the org's auto-start rate limit") || changed;
      continue;
    }
    if (usedHosts.has(host)) continue;   // that host already took one this pass
    usedHosts.add(host);
    // The operator's model pin (XERK-123) rides the command, exactly as it does
    // from the Start button — read at DISPATCH so a pin changed while the ticket
    // waited is the one that takes effect.
    const mpin = ticketModelPin(e.siteKey, e.issueKey);
    // The runtime pin (XERK-473) rides the command as `agentType`, read at
    // DISPATCH like the model pin so a pin changed while the ticket waited takes
    // effect. findTicketHost has already restricted the pool to a host that
    // offers it, so this only carries the choice; omitted (claude) by default.
    const rpin = ticketRuntimePin(e.siteKey, e.issueKey);
    // `ticketSource`/`ticketSite` ride the command as hub-only bookkeeping
    // (stripped by publicCommands): the entry leaves the queue here, so they are
    // the only record of what KIND of work this was and WHOSE org it was
    // dispatched for, if the command has to be reclaimed from a host that dies
    // before taking it (XERK-303).
    queueCommand(host, { type: "spawnTicket", issueKey: e.issueKey,
      ticketSource: e.source, ticketSite: e.siteKey,
      ...(mpin ? { model: mpin.model } : {}),
      ...(rpin ? { agentType: rpin.runtime } : {}) });
    rememberDispatch(e.siteKey, e.issueKey);
    const wait = Math.round((now - e.at) / 1000);
    console.log(`ticket queue: dispatched ${logName(e.issueKey)} to ${logName(host)}`
      + ` (${e.source}, waited ${wait}s)`);
    // An auto-started ticket's attempt is recorded HERE, where the spawn is
    // actually handed over — queuing on the hub commits nothing, so it must not
    // spend a retry. The backoff still exists for what it has always covered: an
    // agent that ACKS this command and leaves no session (XERK-61/109).
    if (e.source === "auto") {
      const prior = autoStarted.get(k);
      const attempts = Math.min((prior ? prior.attempts : 0) + 1,
        AUTO_START_BACKOFF_STEPS);
      autoStarted.set(k, { attempts, nextAt: autoStartRetryAt(now, attempts) });
      // XERK-485 [E]: this dispatch counts against the org's rate window.
      recordAutoStartRate(e.siteKey, k, now);
      if (attempts > 1) {
        console.log(`auto-start: retrying ${logName(e.issueKey)} on ${logName(host)} — the previous `
          + "spawnTicket was acked but left no session (backing off, but the hub "
          + "keeps trying so it recovers once the block clears)");
      }
    }
    drop(null);
  }
  if (changed) {
    // The drain is where notes are MINTED, so the bound belongs here too —
    // applied only on enqueue it held at 2x until the next click.
    sweepExpiredNotes();
    publishTicketQueue();
  }
}

// A spawnTicket routed to a host that then went offline before it could be
// handed over (XERK-303). The hub's queue guarantees that any host in the org can
// take a waiting ticket, but that guarantee ENDS AT DISPATCH — the entry leaves
// the queue there by design — so an undelivered command on a dead host was work
// nothing re-routed. It sat until that host came back, up to PRUNE_AFTER_MS (a
// week), showing nothing on the board: a dispatched ticket is neither a session
// nor a queue entry, so there was no surface for it to be missing FROM.
//
// Three preconditions, and each of them is load-bearing:
//
// 1. **`deliveredAt` is absent** — never merely "the host is offline". Delivery
//    is the line between "the agent never saw this" and "the agent may already
//    have run it", and a host routinely goes silent BETWEEN delivery and ack,
//    which is the very window this runs in. Withdrawing there gives the ticket a
//    second session on top of the one already starting, and a double start is
//    worse than a delay. A delivered command is left where it is: it re-delivers
//    when the host returns (delivery is at-least-once) and runs then. A command
//    RESTORED from state.json is stamped delivered at boot for the same reason —
//    see the restore.
// 2. **The command carries `ticketSite`/`ticketSource`** — the queue entry is
//    gone, so they are the only record of whose org this was and what kind of
//    work. The org must come from the COMMAND, not from `siteKeyOf(a)`: a host's
//    `jira.siteKey` is self-reported and bound to no credential (XERK-268 proves
//    the host, not the org), so reading it live lets a host that re-points its
//    Jira config re-queue another org's ticket into its own — and a different
//    org's host then runs it. An unstamped command (an older hub's, in memory
//    across nothing) is simply not reclaimed: guessing its kind is how an
//    operator's click comes back as auto and gets swept away by the org switch.
// 3. **A host is free to take it RIGHT NOW.** Withdrawing is only an improvement
//    if the very next drain can dispatch; a command withdrawn into a queue that
//    cannot move it is destroyed on one of the queue's own timers, and it would
//    have RUN when its host came back. A single-host org, an org that is entirely
//    down and a ticket pinned to the dead host each hit that, and so does a
//    merely BUSY org — `full` is a wait that clears itself for a ticket already
//    in line, but for one that is not it just trades a week on a dead host for
//    four hours and a "gave up waiting" note. None of them is withdrawn; the
//    command waits, exactly as today, and this runs again in 15 seconds, so the
//    rescue happens the moment a slot actually exists.
//
// One residue is deliberate: once reclaimed, the ticket is an ordinary queue
// entry. If an older entry beats it to the slot it can wait, and can eventually
// expire — VISIBLY, as the terminal note every queued ticket gets. That is the
// queue's contract, not a silent loss.
//
// Admission is then checked BEFORE the withdrawal, never after: it can still
// refuse (a full org line), and dropping a command we then fail to re-queue is
// the same destruction by another route. Refused, the command stays put and the
// next sweep retries.
//
// Runs ahead of `drainTicketQueue` in the same pass, so a reclaimed ticket is
// dispatched in the tick it is rescued rather than sitting in the queue for one.
// Its position relative to `autoStartSweep` is NOT load-bearing (the sweep skips
// a ticket that is queued and equally one whose spawn is in flight); do not write
// a rationale here that claims otherwise.
function reclaimStrandedTicketSpawns() {
  const now = Date.now();
  for (const [host, a] of Object.entries(agents)) {
    if (now - (a.lastSeen || 0) < OFFLINE_AFTER_MS) continue;
    // Iterate a COPY: dropQueuedCommand rewrites a.commands underneath us.
    for (const c of [...(a.commands || [])]) {
      if (!c || typeof c !== "object" || c.type !== "spawnTicket") continue;
      // Presence, not truthiness — the same test publicCommands strips on. A
      // stamp the hub has written in any form means "handed over"; the two reads
      // disagreeing is how a command gets stripped from the wire and reclaimed
      // anyway.
      if ("deliveredAt" in c) {
        // Throttled, because this is a line about a CONDITION — true again on
        // every 15s sweep for as long as the host stays down — and the whole
        // point of it is that the hub is deliberately not going to act.
        logQueueState(`held\x00${logName(host)}\x00${logName(c.issueKey)}`,
          `ticket queue: ${logName(c.issueKey)} was already handed to `
          + `${logName(host)}, which has since gone offline — it may be mid-spawn, `
          + "so it waits for that host rather than risk a second session");
        continue;
      }
      const siteKey = c.ticketSite;
      const source = c.ticketSource;
      if (!siteKey || !c.issueKey) continue;
      if (source !== "manual" && source !== "auto") continue;
      const rows = fleetTicketRows();
      const repo = ticketRepo(siteKey, c.issueKey, rows);
      if (!repo) continue;
      const { host: free } =
        findTicketHost(siteKey, repo, c.issueKey, { requireFree: true });
      if (!free) continue;
      // An AUTO rescue is itself an attempt that produced nothing, so it waits
      // out the backoff the dispatch spent, exactly like the sweep's own retry.
      // Without this a pair of hosts flapping alternately reclaims forever: each
      // bounce finds the other host up, passes every precondition, and the ticket
      // never starts while the log, the payload and the board churn every
      // OFFLINE_AFTER_MS. Costs the normal case nothing — the first backoff step
      // is 60s and a host must be silent for 75s to get here at all.
      if (source === "auto") {
        const prior = autoStarted.get(ticketQueueKey(siteKey, c.issueKey));
        if (prior && now < prior.nextAt) continue;
      }
      // Re-admit under the ticket's CURRENT triage band, not a fixed one, so a
      // P0 auto ticket keeps its preemption through the re-queue even if the
      // org's auto share is full the moment the dead host's spawn is reclaimed.
      const row = rows.get(ticketQueueKey(siteKey, c.issueKey));
      const tri = row && row.row && row.row.triage && typeof row.row.triage === "object"
        ? row.row.triage : null;
      const prio = tri ? tri.priority : undefined;
      if (ticketQueueAdmission(siteKey, c.issueKey, source, prio) !== "ok") continue;
      if (!dropQueuedCommand(host, c.cmdId, "spawnTicket")) continue;
      if (!enqueueTicketStart(siteKey, c.issueKey, source, prio)) {
        // Unreachable: admission answered "ok" one line ago and nothing between
        // the two touches the queue. Said out loud anyway, because the one thing
        // this function must never do quietly is lose the work.
        console.error(`ticket queue: reclaimed ${logName(c.issueKey)} from `
          + `${logName(host)} but could not re-queue it — start it again`);
        continue;
      }
      console.log(`ticket queue: reclaimed ${logName(c.issueKey)} from `
        + `${logName(host)} — it went offline before taking the spawn, so the `
        + `ticket is back in line (${source})`);
    }
  }
}

// XERK-485 [E]: the triage gate. Why the sweep must NOT queue this ticket, or
// null when it may. Triage (XERK-481/482) is the hub's only evidence that a
// ticket is worth a session, so the sweep acts on its verdict:
//   no triage block at all  -> "untriaged"   (the model hasn't assessed it)
//   actionable !== true     -> "not actionable" (the model held or rejected it)
//   dedupeOf set            -> "duplicate"   (a confirmed duplicate of another ticket)
// A gated ticket still renders on the board — it simply is never swept, and
// spends no attempt, exactly like a ticket with no triaged repo. The block was
// coerced at ingest (sanitizeTicketTriage), so `actionable` is a strict boolean
// when present and `dedupeOf` a string when present; a host that sent junk has
// already had it dropped at the door.
function triageGateReason(t) {
  const tri = t && typeof t === "object" ? t.triage : null;
  if (!tri || typeof tri !== "object" || Array.isArray(tri)) return "untriaged";
  if (tri.actionable !== true) return "not actionable";
  if (tri.dedupeOf) return "duplicate";
  return null;
}

// XERK-485 [E]: the priority key as a comparable array —
// [triage band, type weight, -repo tier]. A caller's STABLE sort on this is the
// full ordering: priority -> type -> repo tier (XERK-487's [G], the tiebreak
// below priority+type) -> the caller's insertion order (board order for the
// sweep, FIFO for the queue).
function triageSortKey(triage, repo) {
  const tr = triage && typeof triage === "object" ? triage : null;
  return [
    tr && TRIAGE_PRIORITY_RANK[tr.priority] !== undefined
      ? TRIAGE_PRIORITY_RANK[tr.priority] : NO_PRIORITY_RANK,
    tr && TRIAGE_TYPE_WEIGHT[tr.type] !== undefined
      ? TRIAGE_TYPE_WEIGHT[tr.type] : NO_TYPE_WEIGHT,
    -repoTierRank(repo),
  ];
}

// XERK-486 [F]: the org triage policy. Why the sweep must NOT auto-start this
// ticket because of its ORG's policy, or null when the policy allows it. An org
// with no policy object has no constraint at all (the policy panel only adds
// knobs; it never removes the default "anything actionable goes"). Each knob is
// independent, and the first violated one is reported — the text rides the
// queue-state log, not the board, so it just needs to be true, not pretty.
//   minPriority  -> auto-start this band and HIGHER only (rank <= min's rank)
//   excludeTypes -> these triage types never auto-start
//   repoDeny     -> these repos never auto-start (checked first: deny beats allow)
//   repoAllow    -> non-empty: only these repos auto-start
function triagePolicyReason(siteKey, tri, repo) {
  const p = triagePolicies[siteKey];
  if (!p || typeof p !== "object") return null;
  if (p.minPriority) {
    const rank = tri && TRIAGE_PRIORITY_RANK[tri.priority] !== undefined
      ? TRIAGE_PRIORITY_RANK[tri.priority] : NO_PRIORITY_RANK;
    if (rank > TRIAGE_PRIORITY_RANK[p.minPriority]) {
      return `below its minimum auto-start priority (${p.minPriority}+)`;
    }
  }
  if (p.excludeTypes && p.excludeTypes.length) {
    const type = tri && tri.type;
    if (type && p.excludeTypes.includes(type)) {
      return `its triage type (${type}) is excluded by policy`;
    }
  }
  if (p.repoDeny && p.repoDeny.length && p.repoDeny.includes(repo)) {
    return `its repo (${repo}) is denied by policy`;
  }
  if (p.repoAllow && p.repoAllow.length && !p.repoAllow.includes(repo)) {
    return `its repo (${repo}) is not on the allow list`;
  }
  return null;
}

// XERK-486 [F]: the org's auto dispatches per rate window — its policy's
// rateMax when set, else the fleet default. A per-org knob on a global guard:
// the window itself (TICKET_QUEUE_RATE_WINDOW_MS) stays shared.
function autoStartRateMax(siteKey) {
  const p = triagePolicies[siteKey];
  return p && Number.isInteger(p.rateMax) && p.rateMax >= 1 ? p.rateMax : TICKET_QUEUE_RATE_MAX;
}

// XERK-485 [E]: the drain's visit order. Within an org's line the priority key
// decides (band -> type -> tier -> FIFO by `at`); across orgs the lines
// interleave round-robin, each org's turn anchored on its OLDEST entry, so one
// org's backlog can't starve another's. Hosts never cross orgs, so in practice
// this decides which ticket in an org claims a host's one-per-pass dispatch —
// the round-robin keeps the cross-org fairness explicit rather than an
// accident of array order.
function ticketQueueOrder(rows) {
  if (ticketQueue.length <= 1) return [...ticketQueue];
  const lines = new Map();                    // siteKey -> [{e, key}], FIFO order
  for (const e of ticketQueue) {
    const hit = rows.get(ticketQueueKey(e.siteKey, e.issueKey));
    const row = hit ? hit.row : null;
    const key = triageSortKey(
      row ? row.triage : null, ticketRepo(e.siteKey, e.issueKey, rows));
    let line = lines.get(e.siteKey);
    if (!line) lines.set(e.siteKey, (line = []));
    line.push({ e, key });
  }
  for (const line of lines.values()) {
    line.sort((a, b) => {
      for (let i = 0; i < a.key.length; i++) {
        if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
      }
      return a.e.at - b.e.at;                 // FIFO within an identical key
    });
  }
  const byAge = [...lines.values()].sort((x, y) => x[0].e.at - y[0].e.at);
  const out = [];
  let depth = 0;
  for (;;) {
    let any = false;
    for (const line of byAge) {
      if (depth < line.length) { out.push(line[depth].e); any = true; }
    }
    if (!any) break;
    depth++;
  }
  return out;
}

function autoStartSweep() {
  const orgs = orgsWithAutoStart();
  if (!orgs.size) return;
  const now = Date.now();
  const started = startedTicketKeys();
  const rows = fleetTicketRows();
  for (const siteKey of orgs) {
    // The board's own view of this org's tickets — see `fleetTicketRows`. Never
    // walk `agents` for a ticket list here: this sweep STARTS work, so acting on
    // a copy the operator was not shown is a session nobody asked for.
    // XERK-485 [E]: the full priority key orders the auto stream —
    // triage band -> type weight -> repo tier (XERK-487's [G], now a
    // tiebreak below priority+type) -> board order (stable sort).
    // A P0 bug takes the scarce auto slots ahead of a P3 chore.
    const candidates = ticketRowsForSite(rows, siteKey)
      .map((r) => {
        const repo = r.row ? ticketRepo(siteKey, r.row.key, rows) : null;
        return { t: r.row, repo, key: triageSortKey(r.row && r.row.triage, repo) };
      })
      .filter((c) => c.t && c.t.key && c.t.statusCategory === "todo"
        && c.repo && !isRepoIgnored(c.repo))
      .sort((a, b) => {
        for (let i = 0; i < a.key.length; i++) {
          if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
        }
        return 0;   // stable: board order within an identical key
      });
    for (const { t, repo } of candidates) {
      const k = siteKey + "\x00" + t.key;
      // A session exists on some channel — the work is under way (or was, and
      // was deliberately killed). Done with this ticket for good; drop any
      // attempt record so the map only ever holds tickets still failing.
      if (started.has(k)) { autoStarted.delete(k); continue; }
      // XERK-486 [F]: the operator's per-ticket verdict outranks everything the
      // model said. Hold and reject keep the ticket out of the auto stream no
      // matter its triage block; approve forces eligibility past the triage
      // gate AND the org policy below (but not past the ignore-tier/missing-
      // repo filter above — that gate still applies).
      const action = ticketTriageAction(siteKey, t.key);
      if (action === "hold" || action === "reject") {
        logQueueState(`triaged\x00${siteKey}\x00${logName(t.key)}`,
          `auto-start: ${logName(t.key)} is ${action} by triage — not swept, no attempt spent`);
        continue;
      }
      // XERK-485 [E]: the triage gate. A ticket without a triage assessment, or
      // one the model held/rejected/flagged as a confirmed duplicate, still
      // renders on the board but is never swept — it spends no attempt, exactly
      // like a ticket with no triaged repo. An explicit operator approve
      // (XERK-486) overrides it. Throttled: this is a state line, re-derived
      // every 15s.
      const gated = action === "approve" ? null : triageGateReason(t);
      if (gated) {
        logQueueState(`held\x00${siteKey}\x00${logName(t.key)}`,
          `auto-start: ${logName(t.key)} is ${gated} — not swept, no attempt spent`);
        continue;
      }
      // XERK-486 [F]: the org's triage policy (minPriority / excludeTypes /
      // repo allow+deny). An approve above bypasses the policy; the policy only
      // ever adds constraints, so an org with no policy object is unrestricted.
      const policyReason = action === "approve"
        ? null
        : triagePolicyReason(siteKey, t.triage, repo);
      if (policyReason) {
        logQueueState(`policy\x00${siteKey}\x00${logName(t.key)}`,
          `auto-start: ${logName(t.key)} skipped by ${logName(siteKey)} triage policy — ${policyReason}`);
        continue;
      }
      // Already waiting in the hub queue — its place in line IS the pending
      // attempt, and drainTicketQueue owns everything from here (XERK-296).
      if (liveQueuedTicket(siteKey, t.key)) continue;
      // A spawnTicket already riding some org host's queue: the agent hasn't
      // taken it yet, so there is nothing to conclude about it either way.
      const inFlight = Object.values(agents).some((a) =>
        a.jira && a.jira.siteKey === siteKey &&
        (a.commands || []).some(
          (c) => c && c.type === "spawnTicket" && c.issueKey === t.key));
      if (inFlight) continue;
      // Nothing in flight and still no session: the last attempt (if any) was
      // taken and produced nothing. Retry it once its backoff has elapsed — the
      // backoff is the ONLY gate now, so a ticket blocked by a transient failure
      // recovers on its own the moment the block clears (XERK-109).
      const prior = autoStarted.get(k);
      if (prior && now < prior.nextAt) continue;
      // XERK-485 [E]: if we are past backoff the previous attempt produced no
      // session, so refund the rate slot it spent — otherwise a flapping ticket
      // would permanently burn its org's budget.
      if (prior) refundAutoStartRate(siteKey, k, now);
      // The sweep DECIDES the ticket should run; it no longer picks the host.
      // That is drainTicketQueue's, at the moment an agent can actually take it,
      // so a slot freeing anywhere in the org claims the oldest waiting ticket
      // (XERK-296). The attempt/backoff is likewise spent at dispatch, not here:
      // sitting in the queue commits nothing and must not burn a retry.
      // A refusal is NOT one fact. An unqueueable ROW (a key this hub won't
      // serve) is that ticket's problem and the rest of the list must still go
      // through — reporting it as a full queue truncated an org's auto-start at
      // its first bad row, every sweep, forever. A full line IS the org's
      // problem, and only the fleet cap ends the sweep outright.
      // XERK-485 [E]: a P0 may exceed the org's auto share (and the org line);
      // the fleet cap is the only bound. Say so, throttled.
      const tri = t.triage && typeof t.triage === "object" ? t.triage : null;
      const prio = tri ? tri.priority : undefined;
      if (prio === "P0") {
        const mine = ticketQueue.filter((e) => e.siteKey === siteKey && !e.expiredAt);
        if (mine.length >= TICKET_QUEUE_PER_ORG_AUTO_MAX) {
          logQueueState(`p0preempt\x00${logName(siteKey)}\x00${logName(t.key)}`,
            `auto-start: ${logName(t.key)} (P0) is preempting the ${logName(siteKey)} auto share `
            + `(${TICKET_QUEUE_PER_ORG_AUTO_MAX} auto already in line) — bounded only by the fleet cap`);
        }
      }
      const verdict = ticketQueueAdmission(siteKey, t.key, "auto", prio);
      if (verdict === "invalid") {
        // Keyed on the SANITISED name: t.key is agent-supplied and this map
        // outlives the call, so an unbounded key would be an unbounded entry.
        logQueueState(`bad\x00${siteKey}\x00${logName(t.key)}`,
          `auto-start: ${logName(t.key)} isn't a key this hub can queue — skipped`);
        continue;
      }
      if (verdict === "org-auto-full" || verdict === "org-full") {
        logQueueState(`share\x00${logName(siteKey)}`,
          `auto-start: ${logName(siteKey)} already has its share of the queue `
          + `(${TICKET_QUEUE_PER_ORG_AUTO_MAX} auto); the rest wait for a free slot`);
        break;                       // this ORG is full; other orgs still sweep
      }
      if (verdict === "fleet-full") {
        logQueueState("fleet-full",
          `auto-start: the hub's ticket queue is full (${TICKET_QUEUE_MAX})`);
        return;                      // nothing fits anywhere this sweep
      }
      // Pass the band so the admission re-check inside enqueueTicketStart sees
      // the same preemption verdict the sweep just decided on — without it a
      // P0 auto-start is re-judged as a plain ticket and refused at a full
      // org share.
      enqueueTicketStart(siteKey, t.key, "auto", prio);
    }
  }
}

// --- Triage priority write-back (XERK-483) -----------------------------------
// Per-org opt-in (see priorityWriteBackOrgs above): when ON for an org, this
// sweep queues a setTicketPriority command for every ticket whose triage band
// disagrees with the tracker's own priority, so the tracker field matches the
// triage. The AGENT re-checks a fresh read before writing (it never overwrites
// a human-set value); its staged result lands in priorityResults, where the
// /priority poll route and this sweep's suppression map read it back.
const PRIORITY_WRITEBACK_RETRY_MS = 10 * 60 * 1000;
const PRIORITY_WRITEBACK_SKIP_MAX = 500;
// (siteKey, key, band) -> {at, prio}: the tracker value an agent outcome
// answered about. prio === null means "suppress regardless of value" (an
// error, or a write/no-op that already matches the target); a non-null prio
// suppresses only while the tracker still shows exactly that value, so a
// later human change re-arms the sweep.
const priorityWriteBackSkips = new Map();

// The tracker value a triage band maps to, per source. Jira's standard
// priority names; ADO's 1-4 scale spelled the way the board reports it
// ("P1".."P4"), so comparisons run against the board row's own string.
const BAND_TO_TRACKER_PRIORITY = {
  jira: { P0: "Highest", P1: "High", P2: "Medium", P3: "Low" },
  azure: { P0: "P1", P1: "P2", P2: "P3", P3: "P4" },
};

function orgsWithPriorityWriteBack() {
  return new Set(
    Object.keys(priorityWriteBackOrgs).filter((k) => priorityWriteBackOrgs[k]));
}

// Which tracker source a siteKey is polled from: the first reporting host
// whose jira block names it. An org is only ever served by one source type;
// "jira" is the safe default for an unknown source.
function orgBoardSource(siteKey) {
  for (const a of Object.values(agents)) {
    const j = a && a.jira;
    if (j && j.siteKey === siteKey && (j.source === "jira" || j.source === "azure"))
      return j.source;
  }
  return "jira";
}

// A setTicketPriority for this ticket already riding some org host's queue.
function setTicketPriorityInFlight(siteKey, issueKey) {
  return Object.values(agents).some((a) =>
    a.jira && a.jira.siteKey === siteKey &&
    (a.commands || []).some(
      (c) => c && c.type === "setTicketPriority" && c.issueKey === issueKey));
}

function priorityWriteBackSweep() {
  const orgs = orgsWithPriorityWriteBack();
  if (!orgs.size) return;
  const now = Date.now();
  // Expire the suppression map, then cap it oldest-first (Map keeps
  // insertion order).
  for (const [k, e] of priorityWriteBackSkips) {
    if (now - e.at > PRIORITY_WRITEBACK_RETRY_MS) priorityWriteBackSkips.delete(k);
  }
  const over = priorityWriteBackSkips.size - PRIORITY_WRITEBACK_SKIP_MAX;
  if (over > 0) {
    for (const [k] of [...priorityWriteBackSkips].slice(0, over)) {
      priorityWriteBackSkips.delete(k);
    }
  }
  const rows = fleetTicketRows();
  for (const siteKey of orgs) {
    const map = BAND_TO_TRACKER_PRIORITY[orgBoardSource(siteKey)];
    for (const { row: t, key } of ticketRowsForSite(rows, siteKey)) {
      const band = t && t.triage && t.triage.priority;
      if (!band || !map[band]) continue;             // no triage band, or unknown band
      if (String(t.priority || "") === map[band]) continue; // tracker already agrees
      // The agent stages its result keyed by the issue key TRUNCATED to 50
      // chars (record-size bound), and ingestPriorityResults keys the
      // suppression map off that staged value — so a key longer than 50 would
      // never suppress (every sweep re-queues the same ticket, forever). Build
      // the key the same way; short keys are untouched by the slice.
      const sk = siteKey + "\x00" + String(key).slice(0, 50) + "\x00" + band;
      const sup = priorityWriteBackSkips.get(sk);
      if (sup && (sup.prio === null || String(t.priority || "") === String(sup.prio)))
        continue;                                    // recently answered, value unchanged
      if (setTicketPriorityInFlight(siteKey, key)) continue;
      const host = pickBoardWriteHost(siteKey, "setTicketPriority");
      if (!host) continue;
      if (agentGapError(agents[host], "setTicketPriority", "write a ticket's priority"))
        continue;
      const cmdId = queueCommand(host, { type: "setTicketPriority", issueKey: key, priority: band });
      awaitResult(agents[host], cmdId, "setTicketPriority");
      rememberCmdHost(cmdId, host, "setTicketPriority");
    }
  }
}

// --- Duplicate linking (XERK-484) -------------------------------------------
// Per-org opt-in (see dedupeLinkOrgs above): when ON for an org, this sweep
// queues a createDuplicateLink command for every ticket the classifier flagged
// with triage.dedupeOf, so the tracker shows the pair as Jira "Duplicate"
// links. The AGENT is the idempotency authority (live GET-links read beats a
// hub-side assumption, and its ledger keeps a human's removal of a link
// sticky); this sweep only DECIDES which pairs are still worth asking about.
// Its suppression map (dedupeLinkSkips, keyed like the sweep builds it below,
// off the agent's 50-char-truncated key) is filled by ingestTicketLinkResults:
// an ok outcome suppresses sticky, an error until the retry window lapses.
// Jira only: the issueLink API is Jira's, so non-Jira orgs are skipped even if
// opted in, and the agent refuses them too — two layers, either one alone is
// safe, both together mean an operator can't turn this on for an ADO org and
// watch it fail.
const DEDUPE_LINK_RETRY_MS = 10 * 60 * 1000;
const DEDUPE_LINK_SKIP_MAX = 500;
// (siteKey, key[:50], twin) -> {at, sticky}: the outcome an agent answered for
// this pair. sticky === true (an ok result) never expires — relinking or
// re-probing a confirmed pair would be the relink storm the ticket calls out;
// sticky === false (an error) expires after DEDUPE_LINK_RETRY_MS.
const dedupeLinkSkips = new Map();

function orgsWithDedupeLink() {
  return new Set(Object.keys(dedupeLinkOrgs).filter((k) => dedupeLinkOrgs[k]));
}

// A createDuplicateLink for this ticket already riding some org host's queue.
function dedupeLinkInFlight(siteKey, issueKey) {
  return Object.values(agents).some((a) =>
    a.jira && a.jira.siteKey === siteKey &&
    (a.commands || []).some(
      (c) => c && c.type === "createDuplicateLink" && c.issueKey === issueKey));
}

function dedupeLinkSweep() {
  const orgs = orgsWithDedupeLink();
  if (!orgs.size) return;
  const now = Date.now();
  // Expire the non-sticky (error) entries, then cap the map oldest-first
  // (Map keeps insertion order). A capped sticky entry only costs one
  // re-attempt, which the agent's live links read answers with a no-op — or a
  // sticky skip if its ledger says a human removed the link.
  for (const [k, e] of dedupeLinkSkips) {
    if (!e.sticky && now - e.at > DEDUPE_LINK_RETRY_MS) dedupeLinkSkips.delete(k);
  }
  const over = dedupeLinkSkips.size - DEDUPE_LINK_SKIP_MAX;
  if (over > 0) {
    for (const [k] of [...dedupeLinkSkips].slice(0, over)) {
      dedupeLinkSkips.delete(k);
    }
  }
  const rows = fleetTicketRows();
  for (const siteKey of orgs) {
    if (orgBoardSource(siteKey) !== "jira") continue; // issueLink is Jira's API
    for (const { row: t, key } of ticketRowsForSite(rows, siteKey)) {
      const twin = t && t.triage && t.triage.dedupeOf;
      if (!twin || twin === key) continue; // no dedupe flag, or a self-flag
      // Same 50-char-truncated keys the agent stages (and ingestTicketLinkResults
      // keys the suppression map on), so long keys suppress too.
      const sk = siteKey + "\x00" + String(key).slice(0, 50) + "\x00" + String(twin).slice(0, 50);
      if (dedupeLinkSkips.has(sk)) continue; // answered: sticky or in retry window
      if (dedupeLinkInFlight(siteKey, key)) continue;
      const host = pickBoardWriteHost(siteKey, "createDuplicateLink");
      if (!host) continue;
      if (agentGapError(agents[host], "createDuplicateLink", "link duplicate tickets"))
        continue;
      const cmdId = queueCommand(
        host, { type: "createDuplicateLink", issueKey: key, twinKey: twin });
      awaitResult(agents[host], cmdId, "createDuplicateLink");
      rememberCmdHost(cmdId, host, "createDuplicateLink");
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
  // read off `fleetTicketRows()`, the same union-and-rank the board renders, so
  // the hub stops on what the board shows rather than on one host's view.
  //
  // This sweep KILLS, so both halves of that agreement are load-bearing and each
  // has already broken once. Ranked on freshness alone it ended a live session
  // over a Done only an OFFLINE host reported, while the card still showed the
  // ticket in To Do. Grouped one-block-per-ORG it did the opposite, missing a
  // Done the board plainly displayed whenever an org's hosts poll as different
  // Jira users. Withholding a stop is the better failure of the two, but neither
  // is correct.
  const doneKeys = new Set(); // "<siteKey>\x00<issueKey>"
  for (const { row: t, siteKey } of fleetTicketRows().values()) {
    if (t && t.key && t.statusCategory === "done") {
      doneKeys.add(ticketQueueKey(siteKey, t.key));
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
  // Work dispatched to a host that then died before taking it goes back in the
  // queue (XERK-303), in time for the drain at the end of this same tick to hand
  // it to a host that is actually up.
  reclaimStrandedTicketSpawns();
  autoStartSweep();
  autoStopSweep();
  // Triage -> tracker priority (XERK-483): gated per org; no-op unless opted in.
  priorityWriteBackSweep();
  // Triage -> duplicate links (XERK-484): gated per org and Jira-only; no-op
  // unless opted in.
  dedupeLinkSweep();
  // Drained AFTER the sweeps so a ticket the sweep just queued can go out in the
  // same tick, and a session auto-stop just freed is seen by the drain the beat
  // it lands. The heartbeat drains too (that's where capacity actually changes);
  // this is the backstop for a fleet that is quiet but full.
  drainTicketQueue();
}, AUTO_START_EVERY_MS).unref();

// Migration timeouts + settled-record cleanup (the fast handoff runs on the
// target's heartbeat; this is the fallback that fails a stuck move and retires a
// done one). Runs regardless of boot grace — a migration is only ever created
// after boot, by an explicit operator action.
setInterval(() => {
  if (migrations.size) advanceMigrations();
}, 10 * 1000).unref();

// Branded static assets: the shared stylesheet, self-hosted UI fonts (Inter +
// Space Grotesk), and the icon/favicon set + web manifest. Read once into memory
// and served UNAUTHENTICATED from an explicit allowlist (see the router) — the
// login page must render its CSS/fonts/icon before any session cookie exists,
// and none of this leaks anything (same rationale as /healthz). Icons and fonts
// are content-stable under their own names, so they cache hard; the stylesheet
// and scripts change every deploy and are fingerprinted instead (below).
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
// The BARE name of a fingerprinted asset revalidates on every request: the only
// thing still asking for it is an HTML page a cache handed back from before the
// deploy, and that page is precisely the one that must not be given a stale
// body. `no-cache` is store-and-revalidate, not don't-store, so with the ETag
// below the usual answer is a 304 (XERK-312).
const REVALIDATE_CACHE = "public, no-cache";
// A fingerprint no release ever minted is still a 200 (see `supersededAsset`),
// and an unauthenticated caller can ask for 2^48 of them. `private` keeps a
// shared cache in front of the hub from storing a distinct entry per guess;
// the bare names it falls back to are a fixed set of six, so they stay public.
const SUPERSEDED_CACHE = "private, no-cache";
// The HTML shells name their assets BY fingerprint, so a shell held without
// asking would keep pointing at last release's URLs — the same stale window one
// level up. `private` keeps the logged-in pages out of shared caches (the CDN
// in front of the hub included); the login page sets its own `no-store`.
const HTML_CACHE = "private, no-cache";

// Content hash of a body — the identity a fingerprinted URL and an ETag are
// both built from. Truncated to 12 hex (48 bits): short enough to read in a
// URL, far past any collision worth reasoning about for a handful of files.
const assetFingerprint = (body) =>
  crypto.createHash("sha256").update(body).digest("hex").slice(0, 12);

const readAsset = (...file) => fs.readFileSync(path.join(__dirname, "public", ...file));
const staticAsset = (body, type, cache) => ({ body, type, cache, etag: `"${assetFingerprint(body)}"` });

// Filenames are hardcoded string literals (no request data reaches path.join) so
// there's no path-traversal surface; the request only ever indexes this fixed map.
const STATIC_ASSETS = {
  "/favicon.svg":          staticAsset(readAsset("favicon.svg"),          "image/svg+xml",                            IMMUTABLE_CACHE),
  "/favicon.ico":          staticAsset(readAsset("favicon.ico"),          "image/x-icon",                             IMMUTABLE_CACHE),
  "/favicon-16.png":       staticAsset(readAsset("favicon-16.png"),       "image/png",                                IMMUTABLE_CACHE),
  "/favicon-32.png":       staticAsset(readAsset("favicon-32.png"),       "image/png",                                IMMUTABLE_CACHE),
  "/apple-touch-icon.png": staticAsset(readAsset("apple-touch-icon.png"), "image/png",                                IMMUTABLE_CACHE),
  "/icon-192.png":         staticAsset(readAsset("icon-192.png"),         "image/png",                                IMMUTABLE_CACHE),
  "/icon-512.png":         staticAsset(readAsset("icon-512.png"),         "image/png",                                IMMUTABLE_CACHE),
  "/site.webmanifest":     staticAsset(readAsset("site.webmanifest"),     "application/manifest+json; charset=utf-8", "public, max-age=3600"),
  "/fonts/inter-latin-wght-normal.woff2":         staticAsset(readAsset("fonts", "inter-latin-wght-normal.woff2"),         "font/woff2", IMMUTABLE_CACHE),
  "/fonts/space-grotesk-latin-wght-normal.woff2": staticAsset(readAsset("fonts", "space-grotesk-latin-wght-normal.woff2"), "font/woff2", IMMUTABLE_CACHE),
};

// The shared stylesheet and scripts are MUTABLE — they change with every deploy
// — so no TTL under their own name is correct: a warm browser serves the NEW
// html against the OLD app.css until it expires, which is a site that renders
// unstyled for that whole window (XERK-312). A short TTL only shortens it.
// So each is ALSO published under a content-hashed name, which a new body
// changes, and the HTML below is rewritten at boot to link that name. Nothing
// can hold a stale copy of a URL that no longer exists.
//
// Any new shared /*.js belongs HERE, not in the map above — the pages link
// whatever `withHashedAssets` rewrites, and an entry missing from the allowlist
// 404s and takes that page's whole render down.
const HASHED_ASSETS = [
  ["/app.css",       "app.css",       "text/css; charset=utf-8"],
  ["/chat.js",       "chat.js",       "text/javascript; charset=utf-8"],
  ["/board.js",      "board.js",      "text/javascript; charset=utf-8"],
  ["/nav.js",        "nav.js",        "text/javascript; charset=utf-8"],
  ["/org.js",        "org.js",        "text/javascript; charset=utf-8"],
  ["/newticket.js",  "newticket.js",  "text/javascript; charset=utf-8"],
];

// Bare URL -> fingerprinted URL, the map the HTML rewrite runs on.
const ASSET_URLS = {};
// The same bodies again, for a fingerprint a previous release minted.
const SUPERSEDED_ASSETS = {};
for (const [urlPath, file, type] of HASHED_ASSETS) {
  const body = readAsset(file);
  const hashed = urlPath.replace(/\.([^.]+)$/, `.${assetFingerprint(body)}.$1`);
  ASSET_URLS[urlPath] = hashed;
  STATIC_ASSETS[hashed] = staticAsset(body, type, IMMUTABLE_CACHE);
  // The bare name keeps serving the same body, revalidating: browsers holding a
  // pre-deploy HTML page still link it, and 404ing them would take the styling
  // off a page that was working a moment ago — the very failure being fixed.
  STATIC_ASSETS[urlPath] = staticAsset(body, type, REVALIDATE_CACHE);
  SUPERSEDED_ASSETS[urlPath] = staticAsset(body, type, SUPERSEDED_CACHE);
}

// A fingerprinted name this build does NOT know: `/app.<some old hash>.css`,
// asked for by an HTML page a cache handed back from before the deploy. It must
// resolve to the CURRENT body rather than 404 — a 404 here is the unstyled page
// this whole mechanism exists to prevent, and a worse one than the stale
// stylesheet it replaced. Revalidating, because it is by definition not the
// version whose URL was minted. The base name is matched against the allowlist,
// so this widens what is served by exactly nothing.
const HASHED_NAME_RE = /^\/([\w-]+)\.[0-9a-f]{12}\.(css|js)$/;
function supersededAsset(pathname) {
  const m = HASHED_NAME_RE.exec(pathname);
  if (!m) return null;
  const bare = `/${m[1]}.${m[2]}`;
  if (!Object.prototype.hasOwnProperty.call(ASSET_URLS, bare)) return null;
  if (ASSET_URLS[bare] === pathname) return null; // the current one; served above
  return SUPERSEDED_ASSETS[bare];
}

// Point a page at the fingerprinted URLs. Only real attribute references are
// rewritten (href="/app.css", src="/nav.js"); the pages' own comments name these
// files in prose constantly, and those must be left alone.
function withHashedAssets(buf) {
  let html = buf.toString("utf8");
  for (const [bare, hashed] of Object.entries(ASSET_URLS)) {
    html = html.split(`="${bare}"`).join(`="${hashed}"`);
  }
  return Buffer.from(html, "utf8");
}
const htmlPage = (file) => {
  const body = withHashedAssets(readAsset(file));
  return { body, etag: `"${assetFingerprint(body)}"` };
};

const INDEX = htmlPage("index.html");
const USAGE = htmlPage("usage.html");
const SESSIONS = htmlPage("sessions.html");
const BOARD = htmlPage("board.html");
// Not an `htmlPage`: the login form is served `no-store` (a cached login page
// is its own problem), so it has no conditional-GET path to carry an ETag for.
const LOGIN = withHashedAssets(readAsset("login.html"));

// Does this conditional request already hold the body we would send? The header
// is a comma-separated list and either side may weaken an entry (`W/"..."`); a
// cache or proxy in front of the hub is entitled to do both.
function etagMatches(req, etag) {
  const header = req.headers["if-none-match"];
  if (!header || !etag) return false;
  return header
    .split(",")
    .some((t) => { const v = t.trim(); return v === "*" || v.replace(/^W\//, "") === etag; });
}

// Serve one of the HTML shells. They revalidate every time (they name
// fingerprinted assets, so a stale shell re-opens XERK-312 one level up), and
// the ETag makes the common answer a 304 rather than the whole page.
function sendPage(req, res, page) {
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": HTML_CACHE,
    ETag: page.etag,
  };
  if (etagMatches(req, page.etag)) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  return res.end(page.body);
}

// Bundled web font served to the live terminal. ttyd's page is same-origin
// (proxied under /term/<name>/), so its xterm.js can load this from the hub;
// proxyTerm() injects the matching @font-face. A Nerd Font gives the TUI full
// Unicode + icon coverage regardless of what fonts the viewer's machine has.
const TERM_FONT = fs.readFileSync(path.join(__dirname, "public", "jbm-nerd-mono.woff2"));
// <link preload> + <style> injected into ttyd's HTML document defining that
// font as 'JBMNerd' — the family name the agent points ttyd's fontFamily at.
// The preload starts the 1 MB fetch at parse time, and the /term-font.woff2
// route serves it immutable, so repeat loads hit the browser cache.
// `font-display:swap` (NOT `block`): text renders immediately on the fallback
// stack and the Nerd Font swaps in when it lands. With `block`, the entire
// terminal stayed blank while the font downloaded — up to the 3 s block
// period, and longer-feeling on slow mobile links, which read as "the
// terminal is invisible". The fallbacks in ttyd's fontFamily stack (DejaVu
// Sans Mono, system monospace) share JBMNerd's 0.6 em advance, so the swap
// lands without grid shift or box-drawing misalignment.
const TERM_FONT_STYLE =
  "<link rel='preload' as='font' type='font/woff2' crossorigin " +
  "href='/term-font.woff2'>" +
  "<style>@font-face{font-family:'JBMNerd';" +
  "src:url('/term-font.woff2') format('woff2');font-display:swap;}</style>";

// Touch-scroll shim injected into ttyd's page for phones. Sessions run inside
// tmux with `mouse on`, which routes the *wheel* by screen model (agent/tmux.conf):
// forwarded to the app on the alternate screen (Claude scrolls its own history),
// or into tmux copy-mode on the main screen (qwen's tmux history). A touchscreen
// produces no wheel events, so a finger drag scrolls nothing. This maps a
// one-finger vertical drag onto synthetic WheelEvents on the terminal element,
// which xterm.js forwards to tmux just like a real mouse wheel — so touch scroll
// lands on the same per-screen-model path.
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

// "Jump to bottom" control injected into EVERY session's ttyd page — one code
// path for every runtime, alongside the font / touch-scroll / OSC52 injections
// above (no agentType gate). The two runtimes render into DIFFERENT terminal
// screens, so agent/tmux.conf routes the WHEEL by SCREEN MODEL (`#{alternate_on}`),
// not by runtime — and this pill just dispatches wheel-DOWN, landing on whichever
// path is right:
//   - Claude runs on the ALTERNATE screen with its OWN scroll handler; tmux
//     forwards the wheel to it (`send -M`) and Claude scrolls its conversation.
//   - qwen renders APPEND-ONLY on the MAIN screen (ui.useTerminalBuffer:false,
//     the flicker fix), so its history lives in TMUX's buffer; the wheel drives
//     tmux copy-mode (`copy-mode -e` auto-exits at the live tail).
// Either way a wheel-DOWN burst reaches the live bottom, and off the bottom it is
// a no-op, so over-scroll is harmless. Same primitive TERM_TOUCH_SCROLL uses; no
// knowledge of any runtime. It repeats bursts until the screen stays unchanged
// for a few consecutive polls (scrolled/exited to the live tail). If the live
// pane is then STREAMING, its footer animates every frame and never "settles",
// so an active turn (detected from either runtime's busy footer) stops at a tight
// cap rather than spinning to MAX. Verified end-to-end in a real browser for both
// screen models.
//
// window.term is ttyd's own xterm instance (the same handle TERM_OSC52_JS wires
// onto); it appears a beat after parse, so every read guards on it.
const TERM_SCROLL_BOTTOM_STYLE =
  "<style>#turmaToBottom{position:fixed;right:16px;bottom:16px;z-index:2147483647;" +
  "display:none;align-items:center;gap:5px;padding:7px 13px;border:0;border-radius:999px;" +
  "font:600 12px/1 -apple-system,system-ui,sans-serif;color:#fff;" +
  "background:rgba(37,99,235,.92);box-shadow:0 2px 10px rgba(0,0,0,.45);cursor:pointer;}" +
  "#turmaToBottom:hover{background:#2563eb;}</style>";
// Bare JS (exported for the sandbox test), embedded in TERM_SCROLL_BOTTOM below.
const TERM_SCROLL_BOTTOM_JS =
  "(function(){" +
  // BURST wheel-downs per pass. The loop stops when the screen has been UNCHANGED
  // for STABLE consecutive passes (tmux copy-mode has scrolled to / exited at the
  // live tail) or a cap is hit. Requiring STABLE consecutive reads — not a single
  // one — is what survives a repaint that lands after the poll: the pane is
  // redrawn by bytes making a full round trip (browser→tunnel→ttyd→tmux and back),
  // so one poll can read the pre-scroll frame and look "settled" when it isn't (a
  // real ~1/10 stop-short QA caught, worse over the tunnel). A late frame just
  // resets the counter. DELAY is comfortably above a typical round trip too.
  // MAX is the idle safety net (never reached in practice — an idle scroll settles
  // as soon as copy-mode reaches the bottom). ACTIVE_MAX is the tight bound once
  // back at a STREAMING live tail: the busy footer animates every frame, so the
  // settle test never trips; the cap stops us dead rather than spinning to MAX,
  // and the turn lands at the tail on completion regardless.
  "var STEP=40,BURST=8,TAIL=3,STABLE=3,DELAY=120,MAX=800,ACTIVE_MAX=64," +
  "busy=false,btn=null,sawActive=false;" +
  "function xterm(){return document.querySelector('.xterm');}" +
  // The visible screen rows as an array. tmux repaints a fixed region so viewportY
  // is 0 and getLine walks the on-screen rows; as tmux copy-mode scrolls these
  // change, and once it reaches / exits at the live bottom they stop.
  "function rows(){var t=window.term;if(!t||!t.buffer||!t.buffer.active)return null;" +
  "var b=t.buffer.active,n=(t.rows||24),base=(b.viewportY||0),out=[];" +
  "for(var i=0;i<n;i++){var ln=b.getLine(base+i);" +
  "out.push(ln?ln.translateToString(true):'');}return out;}" +
  // Compare region: all but the last TAIL rows, so a static composer footer isn't
  // part of the settle test.
  "function snap(){var r=rows();return r?r.slice(0,r.length-TAIL).join('\\n'):null;}" +
  // Is a turn streaming? Matches EITHER runtime's busy footer — Claude's "esc to
  // interrupt" and qwen's "enter to steer" / "esc to cancel)" — mirroring the
  // agent's PANE_BUSY_MARKERS + QWEN_PANE_BUSY_MARKERS. The closing paren on
  // "cancel)" is LOAD-BEARING: Claude's permission dialog says "Esc to cancel ·
  // Tab to amend" (no paren) and must NOT read as busy. If a marker ever drifts we
  // fall back to the MAX bound rather than misbehaving.
  "function active(){var r=rows();if(!r)return false;" +
  "return /esc to interrupt|enter to steer|esc to cancel\\)/i.test(r.join('\\n'));}" +
  "function wheelDown(n){var t=xterm();if(!t)return;for(var i=0;i<n;i++){" +
  "t.dispatchEvent(new WheelEvent('wheel',{deltaY:STEP,deltaMode:0," +
  "bubbles:true,cancelable:true}));}}" +
  "function toBottom(){if(busy)return;busy=true;sawActive=false;var sent=0,stable=0;" +
  "(function pass(){var before=snap();wheelDown(BURST);sent+=BURST;" +
  "setTimeout(function(){var after=snap();" +
  // A null snap (term not ready) bails rather than spins.
  "if(before===null||after===null){busy=false;hide();return;}" +
  // sawActive is STICKY: once a streaming turn is seen, keep the tight cap even if
  // active() flickers false on a later poll (its footer read is momentary).
  "if(active())sawActive=true;var cap=sawActive?ACTIVE_MAX:MAX;" +
  "if(after===before)stable++;else stable=0;" +
  "if(sent<cap&&stable<STABLE){pass();}else{busy=false;hide();}" +
  "},DELAY);})();}" +
  "function show(){if(btn)btn.style.display='flex';}" +
  "function hide(){if(btn)btn.style.display='none';}" +
  "function wire(){btn=document.createElement('button');btn.id='turmaToBottom';" +
  "btn.type='button';btn.textContent='\\u2193 Bottom';" +
  "btn.title='Scroll to the latest output';" +
  "btn.addEventListener('click',toBottom);document.body.appendChild(btn);" +
  // Reveal the pill the instant the operator scrolls UP off the tail (mirrors the
  // chat view's jump-to-latest pill); toBottom hides it again once it clamps.
  "addEventListener('wheel',function(e){if(!busy&&e.deltaY<0)show();},{passive:true});}" +
  "if(document.body)wire();else addEventListener('DOMContentLoaded',wire);" +
  "})();";
const TERM_SCROLL_BOTTOM =
  TERM_SCROLL_BOTTOM_STYLE + "<script>" + TERM_SCROLL_BOTTOM_JS + "</script>";

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
    // `host` is carried so the dial-back can be checked against the host the
    // channel was opened FOR (XERK-268) — `ch` alone identifies the channel but
    // proves nothing about who answered it.
    pendingChannels[ch] = {
      host: name,
      resolve: (duplex) => {
        clearTimeout(timer);
        delete pendingChannels[ch];
        resolve(duplex);
      },
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
  const headers = { ...req.headers, host: "ttyd", authorization: ttydAuth(name) };
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
          const inject = TERM_FONT_STYLE + TERM_TOUCH_SCROLL + TERM_OSC52_CLIPBOARD +
            TERM_SCROLL_BOTTOM;
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

// ---- connection cap (XERK-273) ----------------------------------------------
// Nothing else bounds concurrent SOCKETS. Every accepted connection costs a read
// buffer, an HTTP parser and request/response objects before a single body byte
// is read — a cost the in-flight byte budget above cannot see, because it is not
// made of body bytes.
//
// Measured at `-m 256m` (the deployed limit), that cost is ~28 KiB per socket:
// 1024 idle-bodied connections peak at 49 MiB and 4096 at 135 MiB, where the hub
// survives the OOM killer but stops answering. So sockets alone turn fatal
// somewhere past ~8000, NOT at the ~1024 the ticket first attributed to them —
// there the bill was overwhelmingly the 0.9 MiB bodies, which is the budget's
// job, not this one's. Both bounds are needed and neither substitutes for the
// other: the cap cannot bound bytes (a cap safe against a worst-case body would
// have to be ~4) and the budget cannot bound sockets.
//
// The number is sized against real use, not against what survives. A dashboard
// viewer holds an SSE stream, up to ~6 HTTP/1.1 sockets and a terminal socket;
// every agent holds a control channel plus a data channel per open terminal.
// A plausible fleet is well under 100 sockets, so 256 is ~3.5x headroom and
// still far below the lethal count. Raise it via the env if a bigger fleet ever
// needs it — set it too LOW and the UI breaks looking like a network fault,
// which is exactly why the refusal is logged rather than silent.
//
// A refused connection is DESTROYED by Node before any HTTP parsing, so there is
// no way to answer it with a 503 — the client sees a reset. That is the accepted
// cost, and the reason the `drop` log below is the only diagnosable trace.
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 256;
// Refusals are logged rate-limited: a flood is thousands of drops per second and
// a line each would make the log its own resource problem. The FIRST drop of a
// burst prints immediately (that edge is the diagnosis), then at most one
// summary line per window for as long as it lasts.
const DROP_LOG_EVERY_MS = 60 * 1000;
let dropsSinceLog = 0;
let dropLoggedAt = 0;

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
    // HEAD as well as GET: these are public, and a HEAD falling through to the
    // auth gate answered 401 for the very stylesheet the login page renders with
    // — which is what a CDN or an uptime check asks for.
    const isAssetRead = req.method === "GET" || req.method === "HEAD";
    if (isAssetRead && Object.prototype.hasOwnProperty.call(STATIC_ASSETS, url.pathname)) {
      const asset = STATIC_ASSETS[url.pathname];
      const headers = { "Content-Type": asset.type, "Cache-Control": asset.cache, ETag: asset.etag };
      // The bare names revalidate on every request (XERK-312); the 304 is what
      // keeps that from re-sending the stylesheet on every navigation.
      if (etagMatches(req, asset.etag)) {
        res.writeHead(304, headers);
        return res.end();
      }
      res.writeHead(200, headers);
      // A HEAD gets the headers and no body; node still sets Content-Length off
      // the body it never writes if we hand it one, so end it empty.
      return res.end(req.method === "HEAD" ? undefined : asset.body);
    }

    // Same, for a fingerprint a previous release minted (XERK-312).
    if (isAssetRead) {
      const stale = supersededAsset(url.pathname);
      if (stale) {
        const headers = { "Content-Type": stale.type, "Cache-Control": stale.cache, ETag: stale.etag };
        if (etagMatches(req, stale.etag)) {
          res.writeHead(304, headers);
          return res.end();
        }
        res.writeHead(200, headers);
        return res.end(req.method === "HEAD" ? undefined : stale.body);
      }
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
    // `.../archive/<tid>` is the rendered delta; `.../archive/<tid>/raw/<file>`
    // is the byte-for-byte copy of one of that session's own files (XERK-338).
    // Both are agent-pushed on the same credential, which is also what binds
    // `<host>` (XERK-268).
    const isArchiveIngest =
      req.method === "POST" && parts[0] === "api" && parts[1] === "agents" &&
      parts[3] === "archive" &&
      (parts.length === 5 || (parts.length === 7 && parts[5] === "raw"));

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

    if (url.pathname === "/api/heartbeat") {
      // The heartbeat names the host it acts as in its BODY, so it is bound to
      // the credential in the handler, once that is parsed (XERK-268). All this
      // can do is refuse a caller carrying no agent credential at ALL: a bearer
      // that isn't the master is indistinguishable from some host's derived
      // token until we know which host it claims to be. That keeps the
      // credential-less case refused before the body is read, as it always was.
      const gate = agentPresentedRefusal(req);
      if (gate) return json(res, gate.status, { error: gate.error });
    } else if (isArchiveIngest || isUpdatingSignal || isMigrationBlob || isUploadBlob) {
      // These all carry the host they act as in `<host>`, so the credential is
      // checked AGAINST it rather than merely being a valid agent token. The
      // decode is the same expression each route runs on the same segment, so
      // the host checked here and the host compared there cannot diverge; a
      // segment that does not decode is matched raw so an anonymous caller
      // still gets 401 here rather than the route's 400 before any auth ran.
      let claimed;
      try { claimed = decodeURIComponent(parts[2]); } catch { claimed = parts[2]; }
      const refusal = agentHostRefusal(req, claimed);
      if (refusal) return json(res, refusal.status, { error: refusal.error });
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
    // HEAD as well as GET, for the same reason the asset routes take it: this is
    // the one unauthenticated HTML surface, so it is what a CDN or an uptime
    // check probes, and a HEAD used to fall through to a 404.
    if (isAssetRead && (url.pathname === "/login" || url.pathname === "/login.html")) {
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
      return sendPage(req, res, INDEX);
    }

    if (req.method === "GET" && (url.pathname === "/usage" || url.pathname === "/usage.html")) {
      return sendPage(req, res, USAGE);
    }

    // The page was /history until it dropped cost and became token-only. Keep
    // old bookmarks and the Android client's deep links working.
    if (req.method === "GET" && (url.pathname === "/history" || url.pathname === "/history.html")) {
      res.writeHead(301, { Location: "/usage" });
      return res.end();
    }

    if (req.method === "GET" && (url.pathname === "/sessions" || url.pathname === "/sessions.html")) {
      return sendPage(req, res, SESSIONS);
    }

    // Unified Jira Kanban across every agent's org (the agents' `jira`
    // heartbeat blocks; merging happens client-side in board.js).
    if (req.method === "GET" && (url.pathname === "/board" || url.pathname === "/board.html")) {
      return sendPage(req, res, BOARD);
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
      // Identity is the physical host name (`device`); with one container per
      // host the container name is no longer meaningful. agentId is a last-resort
      // fallback if the host name couldn't be read.
      const key = payload.device || payload.agentId;
      if (!key) return json(res, 400, { error: "device/agentId required" });
      // A beat the hub would throw away must never report success — see
      // isPlainHostKey for which names are refused and why. Logged because the
      // agent side cannot say why on its own: urllib's HTTPError stringifies
      // without the body, so the agent's log shows a bare "HTTP Error 400" and
      // the host simply vanishes from the dashboard. This line is the only
      // place the reason is recoverable.
      if (!isPlainHostKey(key)) {
        console.warn(`refused heartbeat: device ${hostKeyLabel(key)} is not a plain host name`);
        return json(res, 400, { error: "device must be a plain host name" });
      }
      // `device` is the host this beat claims to BE, and the whole record —
      // sessions, capacity, the command queue it drains — hangs off it. Bind it
      // to the credential now that it's parsed (XERK-268): unbound, any
      // token-holder could beat as another host and be handed the commands
      // queued for it, which is how a migration/upload id leaves the fleet.
      const beatRefusal = agentHostRefusal(req, key);
      if (beatRefusal) return json(res, beatRefusal.status, { error: beatRefusal.error });
      // Which credential it used decides which token its ttyd is running with
      // (see ttydAuth). Hub-derived, never read off the payload.
      const tokenBound = agentBearerKind(req, key) === "proved";
      // Admission control (XERK-272), ordered AFTER the binding above so an
      // unbound beat can never spend a registry slot. A host already in the
      // registry always gets in — its record is bounded below and replacing it
      // frees what it held — but a name the hub has never seen only gets a slot
      // if there is room, or one can be reclaimed from a host gone longer than
      // AGENT_EVICT_IDLE_MS.
      //
      // XERK-268 makes `device` PROVED rather than self-asserted, which shrinks
      // this from an anyone-with-the-token attack to a compromised-or-buggy host
      // and the `legacy` master credential a mid-rollover fleet still accepts —
      // neither of which is nothing, and a host deriving its name from something
      // unstable grows records with no attacker at all.
      const known = Object.prototype.hasOwnProperty.call(agents, key);
      if (!known && !makeRegistryRoom(0, 1)) {
        // Throttled like the over-half warning, and for the same reason: the
        // flood this exists to survive is exactly the traffic that would write
        // this line, so a per-beat log turns a refused attack into disk
        // pressure on the host. Once per REFUSED_LOG_EVERY_MS, with the count.
        logRegistryFull(`new host ${logName(key)} refused`);
        return json(res, 429, {
          error: "agent registry full", limit: AGENTS_MAX, bytes: AGENTS_TOTAL_MAX,
        });
      }
      const prev = agents[key] || {};
      // At-least-once command delivery: drop any queued command the agent
      // reports as executed; keep re-sending the rest until acked.
      const acked = new Set(payload.ackedCommands || []);
      // `c && typeof c === "object"` is the same guard publicCommands needs, and
      // for the same reason: `null.cmdId` throws HERE, before a reply is built,
      // 400ing this host's every beat with the internal error text — XERK-235's
      // offline loop. Filtering rather than tolerating also self-heals the record
      // on the first beat, so a junk element cannot outlive one round trip.
      const commands = (prev.commands || []).filter(
        (c) => c && typeof c === "object" && !acked.has(c.cmdId));
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
      // Triage-priority write outcomes (XERK-483) — cached by cmdId below like
      // ticketStatusResults, and folded into the sweep's suppression map so a
      // human-set value (or a tracker error) isn't re-queued every 15s.
      const ticketPriorityResults = payload.ticketPriorityResults;
      delete payload.ticketPriorityResults;
      // Duplicate-link outcomes (XERK-484) — cached by cmdId below like
      // ticketPriorityResults, and folded into the sweep's suppression map so a
      // linked (or human-removed) pair is not re-queued every 15s.
      const ticketLinkResults = payload.ticketLinkResults;
      delete payload.ticketLinkResults;
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
      let archiveHave, archiveShed, archiveFull, archiveRawHave, archiveRawSkip;
      if (Array.isArray(archiveManifest) && archiveManifest.length) {
        try {
          archiveHave = archive.manifestCursors(key, archiveManifest);
          // The budget state that goes back with the cursors (XERK-267): which
          // transcripts have spent their per-transcript budget, so the agent
          // strips the inline file payloads before shipping them, and whether
          // the store is full, so it doesn't push at all this pass. Advisory —
          // archive.ingestChunk enforces both on its own.
          const limits = archive.archiveLimits(Object.keys(archiveHave));
          archiveShed = limits.shed.length ? limits.shed : undefined;
          archiveFull = limits.full || undefined;
          // The raw layer's own cursors, per session-relative file (XERK-338).
          // Computed AFTER manifestCursors, which is what creates the rows the
          // raw directories hang off. Absent for every transcript this hub holds
          // nothing of, which the agent reads as zero and ships from the start.
          archiveRawHave = archive.rawCursors(archiveManifest);
          const rawSkip = archive.rawLimits(Object.keys(archiveHave));
          archiveRawSkip = rawSkip.length ? rawSkip : undefined;
        } catch (e) { console.error(`archive manifest ingest failed: ${e.message}`); }
      }
      const next = (agents[key] = {
        ...payload,
        // Pending host commands (spawn/kill/start/restart/resume/delete)
        // queued by the UI; re-sent on every reply below until acked.
        commands,
        // Whether this host authenticated with its OWN derived token or the
        // fleet master (XERK-268). Assigned AFTER the payload spread so a
        // heartbeat claiming it is bound cannot make itself so; read only by
        // ttydAuth, and stripped from the fleet payload like the caches.
        tokenBound,
        // The org this host is BOUND to (XERK-348), assigned after the spread
        // for the same reason `tokenBound` is: a heartbeat claiming a binding
        // must not be able to make itself one. Set on the first beat that
        // declares an org and never moved after — see boundOrgOf.
        orgBound: prev.orgBound || siteKeyOf(payload) || undefined,
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
        // Per-cmdId triage-priority-write outcome cache (see the /priority
        // route, XERK-483); survives across beats like `statusResults`.
        priorityResults: prev.priorityResults || {},
        // Per-cmdId duplicate-link outcome cache (XERK-484); survives across
        // beats like `priorityResults` and is stripped from the fleet payload.
        linkResults: prev.linkResults || {},
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
      const refuseOversized = (size) => {
        if (prev && Object.keys(prev).length) agents[key] = prev;
        else delete agents[key];
        console.error(
          `heartbeat from ${logName(key)}: record is ${size} bytes, over the ` +
            `${AGENT_RECORD_MAX} limit — beat refused`
        );
        return json(res, 413, { error: "agent record too large", limit: AGENT_RECORD_MAX });
      };
      // TWO measurements, one ceiling. The RAW size is the amplifier check: a
      // coercion that discards junk must not be able to shrink an oversized
      // beat into an accepted one (rewriting an 8 MiB string `sessions` to `[]`
      // did exactly that, turning a 413 into a 200). The COERCED size is what
      // actually gets stored and served, and a coercion can EXPAND —
      // normalizeModelUsage rewrites `"m"` to `{model:"m"}`, ~3.5x, so an 8 MiB
      // beat of model names parked 28 MiB per host for a week. Neither
      // measurement alone holds the ceiling.
      const rawSize = agentRecordSize(next);
      if (rawSize > AGENT_RECORD_MAX) return refuseOversized(rawSize);
      // Coercion sits BETWEEN the two, so it never walks an unbounded record —
      // that is how a 24 MiB model name reached a per-code-point spread and
      // OOM-killed the hub. A throw here would leave the RAW record installed
      // (`agents[key] = next` is already done), which is worse than refusing:
      // it defeats every gate downstream, including localModelAvailable's
      // strict-boolean check. The coercions are written not to throw; this is
      // the backstop that makes that not matter.
      try {
        recordCoercion.normalize(next);
      } catch (e) {
        console.error(`heartbeat from ${logName(key)}: coercion failed (${e.message}) — beat refused`);
        if (prev && Object.keys(prev).length) agents[key] = prev;
        else delete agents[key];
        return json(res, 400, { error: "malformed heartbeat" });
      }
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
          `heartbeat from ${logName(key)}: record is ${recordSize} bytes, over half the ` +
            `${AGENT_RECORD_MAX} limit`
        );
      }
      recordSizeWarned.set(key, overHalf);
      // The same crossing-edge warning against the host's SHARE, which is the
      // line that actually bites: the ceiling above is 8 MiB and a share is
      // 512 KiB, so a host drifts past its share — and starts being refused
      // once the registry is also full — with the ceiling's warning still
      // eight times away. A record grows over weeks, which is plenty of notice
      // if anyone is told; without this the first signal is the host vanishing.
      const overHalfShare = recordSize > AGENT_FAIR_SHARE / 2;
      if (overHalfShare && !shareWarned.get(key)) {
        console.warn(
          `heartbeat from ${logName(key)}: record is ${recordSize} bytes, over half ` +
            `its ${AGENT_FAIR_SHARE}-byte share of the registry budget — past the ` +
            `whole share it is refused whenever the registry is full`
        );
      }
      shareWarned.set(key, overHalfShare);
      if (recordSize > AGENT_RECORD_MAX) return refuseOversized(recordSize);
      // The AGGREGATE budget (XERK-272). One record under the per-record ceiling
      // is not the bound: AGENTS_MAX records AT that ceiling is 512 MiB on a
      // 256 MiB hub. Measured after the coercion, because the coerced record is
      // the one that gets retained, served and saved.
      recordBytes.set(key, recordSize);
      if (!makeRegistryRoom(0, 0) && recordSize > AGENT_FAIR_SHARE) {
        // Only a host OVER its share is refused here. A host inside it is not
        // the reason the registry is full, and refusing it would roll back its
        // `lastSeen` with its record — reading as offline while it is up, every
        // beat, with nothing to distinguish that from a network failure. See
        // AGENT_FAIR_SHARE. This host is never what gets EVICTED either: it was
        // just seen, so the idle rule excludes it.
        if (prev && Object.keys(prev).length) {
          agents[key] = prev;
          recordBytes.set(key, agentRecordSize(prev));
        } else {
          delete agents[key];
          recordBytes.delete(key);
        }
        logRegistryFull(
          `${logName(key)} refused — its record is ${recordSize} bytes, over the ` +
            `${AGENT_FAIR_SHARE}-byte per-host share`
        );
        return json(res, 429, {
          error: "agent registry full", bytes: AGENTS_TOTAL_MAX, share: AGENT_FAIR_SHARE,
        });
      }
      // Durable usage history (XERK-338). Deliberately after EVERY gate that can
      // still refuse this beat — a refused beat is not history, and a record
      // rolled back to `prev` must not have been folded into the ledger first.
      usageLedger.ingest(key, next);
      ingestHistory(next, historyResults);
      ingestSubagentHistory(next, subagentHistoryResults);
      ingestJiraIssues(next, jiraIssueResults);
      ingestStatusResults(next, ticketStatusResults);
      ingestPriorityResults(next, ticketPriorityResults);
      ingestTicketLinkResults(next, ticketLinkResults);
      ingestCreateMeta(next, createMetaResults);
      ingestCreateResults(next, createTicketResults);
      // Scoped to the commands this host was actually given: `prev.commands` is
      // the queue BEFORE this beat's acks were filtered out, and the agent
      // stages a refusal in the same handle_commands call that acks it, so the
      // two always ride together. A hub restart inside `scheduleSave`'s debounce
      // forgets the queue and therefore drops that refusal — correctly: the hub
      // can no longer tell whose command it was, and the wait simply degrades to
      // the pre-XERK-265 timeout. Never authenticate it from the beat's own
      // `ackedCommands` instead; that is the agent's word, which is the thing
      // being checked.
      ingestSpawnFailures(key, next,
        new Set((prev.commands || []).map((c) => c && c.cmdId)), spawnFailures);
      // Ordered after every ingest above: an ack settles against what this same
      // beat delivered, which is the whole basis of the gap detection.
      resolveResultWaits(prev, next, commands);
      heartbeatAlerts(key, prev, next);
      rearmMovedWatches(key, prev, next);
      // A migration finishes the instant its target session heartbeats in — do
      // the handoff (kill source, mark done) now rather than waiting out the
      // sweep interval (XERK-101). Cheap: a no-op unless a migration is live.
      if (migrations.size) advanceMigrations();
      // This beat is the fleet's capacity report, so it is exactly when a
      // waiting ticket may have become startable (XERK-296) — a session that
      // ended here frees a slot the queue can claim within one beat instead of
      // up to a 15s sweep. A no-op unless something is queued. `next.commands` IS
      // the local `commands` array, so a dispatch made here rides THIS reply and
      // is stamped delivered by the loop below — not the next beat's, as this
      // said before XERK-303 went looking for the undelivered window.
      if (ticketQueue.length) drainTicketQueue();
      // Stamp what this reply hands over. Delivery is the line between "the
      // agent never saw this" and "the agent may already have run it" — the
      // hub's only evidence for either, since the queue drains on ACK, not on
      // delivery. dropQueuedCommand and the create poll both turn on it.
      for (const c of commands) if (c && !c.deliveredAt) c.deliveredAt = Date.now();
      const reply = publicCommands(commands);   // strip AFTER stamping, or the
      scheduleSave();                           // no-op copy hands back the
                                                // same objects and leaks it
      // Re-measure what the record ACTUALLY ended up as. The gate above runs
      // before the ingests on purpose (a refused beat must never reach the
      // caches, XERK-235), so it measures the record before the alert/PR
      // bookkeeping lands on it — and an aggregate that only ever sees the
      // pre-bookkeeping size drifts low, which is a budget that quietly grows.
      // Settling it here costs the next beat's gate nothing and keeps the
      // number honest; a beat that ends slightly over is caught on that gate.
      recordBytes.set(key, agentRecordSize(next));
      // A fresh beat landed — refresh the memoized fleet payload and push the
      // updated record to open dashboards so the UI reflects it near-instantly.
      publishAgent(key);
      // The roster rides every reply (XERK-348). Built AFTER this beat's ingest,
      // so a session that first appeared on it is addressable by its peers on
      // their next beat rather than the one after.
      warnOrgDrift(key, next);
      const peers = orgPeers(key);
      // Tell the agent how big a body this hub will actually take (XERK-347).
      // It is a FRACTION OF THE CONTAINER LIMIT, so only the hub knows it — and
      // an agent guessing a fixed number guesses wrong on any hub sized smaller
      // than the deployed 256 MiB. It matters because past roughly this ceiling
      // Node destroys the socket under a request still being written, so the
      // agent gets no status at all: it must refuse its own oversize body
      // BEFORE sending, and it can only do that against a number it was told.
      // An agent that predates this keeps its own conservative default.
      const bodyMax = HEARTBEAT_MAX;
      // And how big an ARCHIVE chunk it will take (XERK-356). Same reasoning as
      // `bodyMax` — the number is a fraction of this container's limit, so only
      // the hub knows it — but a different ceiling, on a different route: the
      // agent sizes each delta to it instead of posting a body that is refused,
      // which is why the durable archive was empty for every real session. It
      // rides the archive branch because that is the reply an agent pushes off.
      return json(res, 200, archiveHave
        ? { commands: reply, peers, bodyMax, archiveHave, archiveShed, archiveFull,
            archiveRawHave, archiveRawSkip, archiveChunkMax: ARCHIVE_CHUNK_BODY_MAX }
        : { commands: reply, peers, bodyMax });
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
    // Agent-authed above, and `<host>` — which is the archive row's owner — is
    // bound to the credential there (XERK-268), so a host cannot file transcript
    // chunks under another's name. Body: {startOffset, endOffset, size, entries, meta}.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "agents" &&
        parts[3] === "archive" && parts.length === 5) {
      const key = decodeURIComponent(parts[2]);
      const transcriptId = decodeURIComponent(parts[4]);
      if (!/^[A-Za-z0-9._-]+$/.test(transcriptId)) return json(res, 400, { error: "bad transcriptId" });
      // A raw push whose <file> segment was an unencoded `.`/`..` has had that
      // segment normalised away by the URL parser and arrives HERE, on the
      // rendered route, with a gzip body. No privilege is gained (the auth gate
      // reads the same normalised path), but answering the JSON parser's
      // complaint about a binary body is a confusing way to say "you built that
      // URL wrong" — so name it (XERK-338 QA).
      if ((req.headers["content-type"] || "").includes("gzip")) {
        return json(res, 400, { error: "gzip body on the rendered archive route — " +
          "percent-encode the raw file path into a single segment" });
      }
      // ARCHIVE_CHUNK_BODY_MAX, not the default 1 MiB: a real session's first
      // delta is its whole transcript (XERK-356). Read here rather than through
      // the outer handler's generic 413 so the refusal is RECORDED — an archive
      // push nobody sees fail is the whole bug — and so 413 and 503 stay
      // distinct: on a 503 the agent must retry, on a 413 it must not.
      let raw;
      try {
        raw = await readBody(req, ARCHIVE_CHUNK_BODY_MAX, ARCHIVE_PARSE_COST);
      } catch (e) {
        if (e && e.tooLarge) {
          const error = `archive chunk is larger than this hub takes (${e.cap} bytes)`;
          noteArchiveRefusal(transcriptId, key, error);
          console.error(`archive: refused a chunk from ${key} for ${transcriptId}: ${error}`);
          return json(res, 413, { error, limit: e.cap });
        }
        if (e && e.budgetExceeded) return json(res, 503, { error: e.message });
        if (e && e.stalled) return; // socket already gone — nobody to answer
        return json(res, 400, { error: "could not read body" });
      }
      // Parsed OUTSIDE that catch: a body that arrived but is not JSON is the
      // outer handler's 400 with its own message, exactly as it was.
      const body = JSON.parse(raw || "{}");
      try {
        const r = archive.ingestChunk(
          key, transcriptId, body.meta || {},
          Number(body.startOffset) || 0, Number(body.endOffset) || 0,
          Array.isArray(body.entries) ? body.entries : []
        );
        // It landed, so whatever this host last failed with here is history.
        archiveRefusals.delete(refusalKey(key, transcriptId));
        return json(res, 200, r);
      } catch (e) {
        // The driver's own words stay in the hub log, out of BOTH the record
        // and the reply: `e.message` here is whatever `node:sqlite` or the
        // filesystem made of agent-supplied fields (absolute /data paths
        // included), the record is served to a browser, and the reply is what
        // the agent logs on the host (XERK-356 QA D9).
        console.error(`archive: could not store a chunk from ${key} for ${transcriptId}: ${e.message}`);
        const stored = "the hub could not store this chunk — see the hub log";
        noteArchiveRefusal(transcriptId, key, stored);
        return json(res, 500, { error: stored });
      }
    }

    // POST /api/agents/<host>/archive/<transcriptId>/raw/<file>?start=<n> — an
    // agent pushing one append-only byte range of one of a session's OWN files
    // into the archive's raw layer (XERK-338). `<file>` is the session-relative
    // path, percent-encoded into a single segment (so `subagents/agent-1.jsonl`
    // arrives as `subagents%2Fagent-1.jsonl`), and is allowlisted component by
    // component in `archive.safeRawRel` before it can name anything on disk.
    //
    // The body is the raw bytes, gzipped — these are 3-14x the size of the
    // rendered entries beside them and JSONL compresses ~5-8x, so shipping them
    // uncompressed would make the raw layer cost more on the wire than
    // everything else the agent sends put together. Decompression is BOUNDED
    // (`maxOutputLength`): the body cap alone bounds the compressed side, and a
    // zip bomb is exactly the shape that turns a 1 MiB body into an OOM on a
    // 256 MiB hub.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "agents" &&
        parts[3] === "archive" && parts[5] === "raw" && parts.length === 7) {
      const key = decodeURIComponent(parts[2]);
      const transcriptId = decodeURIComponent(parts[4]);
      // Length-bounded as well as allowlisted: since XERK-338 the id is a
      // DIRECTORY COMPONENT of the raw layer's path, so an id past the
      // filesystem's 255-byte name limit made every push for that session fail
      // at the syscall and report `skip` with no diagnostic at all (QA F6).
      if (!/^[A-Za-z0-9._-]{1,255}$/.test(transcriptId)) {
        return json(res, 400, { error: "bad transcriptId" });
      }
      let rel;
      try { rel = decodeURIComponent(parts[6]); } catch { return json(res, 400, { error: "bad file" }); }
      if (!archive.safeRawRel(rel)) return json(res, 400, { error: "bad file" });
      const start = Number(url.searchParams.get("start") || 0);
      if (!Number.isSafeInteger(start) || start < 0) return json(res, 400, { error: "bad start" });
      let gz;
      try {
        gz = await readRawBody(req, ARCHIVE_RAW_BODY_MAX);
      } catch (e) {
        // 413 and 503 mean opposite things and must not be collapsed: on a 503
        // the agent retries, on a 413 it must not. `budgetExceeded` is the flag
        // the reader actually sets — `overloaded` was never set by anything.
        if (e && e.tooLarge) return json(res, 413, { error: e.message });
        if (e && e.budgetExceeded) return json(res, 503, { error: e.message });
        return json(res, 400, { error: "could not read body" });
      }
      // `gunzipSync` is SYNCHRONOUS, so the decompressed buffer is not a
      // concurrent term: nothing else runs on this loop between the allocation
      // and the last line that reads it, and at most ONE such buffer exists at a
      // time. The peak this adds to the hub is therefore ARCHIVE_RAW_CHUNK_MAX,
      // flat, not N times it.
      //
      // An earlier version charged it to the in-flight body budget to bound "N
      // concurrent gunzips". That was inert — the charge and release sit in one
      // synchronous run, so 64 concurrent pushes all saw an empty budget and not
      // one 503 — and the comment asserted a guarantee that does not exist. If
      // this ever becomes async, the charge has to come back for real.
      let buf;
      try {
        buf = gz.length ? zlib.gunzipSync(gz, { maxOutputLength: ARCHIVE_RAW_CHUNK_MAX })
                        : Buffer.alloc(0);
      } catch (e) {
        // A body that does not decompress is a broken or hostile push, not a
        // chunk to retry — but it answers 400 rather than the cursor protocol's
        // "no progress", because the agent has nothing to realign to.
        return json(res, 400, { error: "body is not gzip within the size limit" });
      }
      try {
        return json(res, 200, archive.ingestRaw(key, transcriptId, rel, start, buf));
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // POST /api/agents/<host>/migrations/<id>/blob — the SOURCE agent uploading
    // a migrated session's raw transcript bundle. Body is the raw gzipped tar;
    // storing it advances the migration to `importing` and queues importSession
    // on the target (XERK-101).
    //
    // Only this migration's OWN source host may post it (XERK-266), and `<host>`
    // is PROVED by the credential at the gate above rather than typed
    // (XERK-268) — it takes both halves to make this an identity check. With
    // the scope alone an attacker simply named the real source and passed.
    // **Every refusal answers the SAME 404** — wrong host, wrong phase, an
    // upload already in flight, a spool that could not be written, empty body,
    // vanished source session; the 413 below is the one exception, and is
    // discussed there — and that uniformity is the point, not tidiness: any
    // RESPONSE a non-source cannot also get names the source to a prober. So do
    // NOT restore a friendlier 409/400/500 at any of them, and **enumerate what
    // this route can answer rather than eyeballing the guard** — the `source
    // session gone` branch below is why. The real source loses nothing it acts
    // on: it only logs the failure, and the RECORD still carries the true
    // reason for the operator.
    // The uniform 404s are now belt AND braces rather than the whole defence:
    // the two residual oracles they could not close — the TIMING of the reply
    // (this guard runs before the body read) and the 413 — needed an unverified
    // caller to be exploitable, and there is no longer any such caller. Keep
    // them anyway: they are what still holds if a future route reaches this
    // code with a weaker credential.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "agents" &&
        parts[3] === "migrations" && parts[5] === "blob" && parts.length === 6) {
      const host = decodeURIComponent(parts[2]);
      const id = decodeURIComponent(parts[4]);
      const m = migrations.get(id);
      if (!m || m.srcHost !== host || m.phase !== "exporting")
        return json(res, 404, { error: "unknown migration" });
      // Two uploads for one migration would interleave into a single spool
      // file, since the phase only flips once the first finishes writing.
      // Drained first, so the loser reads the reply instead of a socket error
      // — and it is the SAME 404 as every other refusal above, since only the
      // real source can reach this line.
      if (m.uploading) {
        req.resume();
        return json(res, 404, { error: "unknown migration" });
      }
      // Spooled to disk rather than buffered (XERK-263); the record keeps only
      // the path, so an in-flight move costs the hub bytes, not megabytes.
      const spool = migrationSpoolPath(m.id);
      let size;
      m.uploading = true;
      try {
        size = await spoolRawBody(req, MIGRATE_BLOB_MAX, spool);
      } catch (e) {
        m.uploading = false;
        const tooBig = e && e.tooLarge;
        m.phase = "failed";
        m.error = tooBig ? "transcript bundle too large" : "transcript bundle spool failed";
        m.at = Date.now();
        publishMigrations();
        // The 413 is the enumerated exception discussed above. A SPOOL failure
        // is not a second one: it answers the uniform 404 like every other
        // refusal, because a distinct status would name the source to anyone
        // holding the id the moment the hub's disk misbehaved. Nothing is lost
        // — the agent only logs the reply, the RECORD carries the real reason
        // for the operator, and the detail (which names the spool path) goes to
        // the hub's log where it is actionable.
        if (tooBig) return json(res, 413, { error: e.message });
        console.error(`migration ${m.id}: spool failed: ${e && e.message}`);
        return json(res, 404, { error: "unknown migration" });
      }
      m.uploading = false;
      if (!size) {
        // Never recorded on m, so drop the empty file here — and drop it
        // BEFORE answering. This is the one path that leaves the migration
        // retriable, and a fire-and-forget unlink could land after a retry had
        // already re-created the same path and deleted the good bundle.
        try { fs.unlinkSync(spool); } catch {}
        return json(res, 404, { error: "unknown migration" });
      }
      // The move may have SETTLED while those bytes were being written — a
      // refusal the source staged for this very upload (its POST timed out
      // while the hub was still spooling, XERK-265) fails it within one beat,
      // and the timeout can land here too. Advancing anyway would resurrect a
      // move the operator was already told had failed, queue an importSession
      // for it, and then kill the source when the target came up. Same careful
      // unlink as the empty-body path: this file is now nobody's.
      if (m.phase !== "exporting") {
        try { fs.unlinkSync(spool); } catch {}
        return json(res, 404, { error: "unknown migration" });
      }
      m.blobPath = spool;
      m.blobSize = size;
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
        // The RECORD says what really happened (the operator reads that, and it
        // stays truthful), but the REPLY is the same 404 as every other refusal
        // — only the real source can reach this line, so a distinct status here
        // would name it to anyone holding the id, exactly like the spool and
        // empty-body refusals above. Nothing consumes this reply; the agent
        // only logs it.
        m.phase = "failed"; m.error = "source session gone";
        dropMigrationBlob(m); m.at = Date.now();
        publishMigrations();
        return json(res, 404, { error: "unknown migration" });
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
        agentType: m.meta.agentType,
        localModelName: m.meta.localModelName,
        localModelContext: m.meta.localModelContext,
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
    // bundle to unpack + resume. Scoped to the migration's OWN target host
    // (XERK-266), over a `<host>` the credential proves (XERK-268) — and here
    // that binding is the ONLY thing that can work: uniform refusals cannot
    // help a route whose success IS the disclosure, so while the segment was
    // merely typed, a token-holder with the id could walk the host names until
    // one returned the bytes. The bundle is another host's raw conversation.
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "agents" &&
        parts[3] === "migrations" && parts[5] === "blob" && parts.length === 6) {
      const host = decodeURIComponent(parts[2]);
      const id = decodeURIComponent(parts[4]);
      const m = migrations.get(id);
      if (!m || m.targetHost !== host || !m.blobPath)
        return json(res, 404, { error: "no bundle" });
      // SNAPSHOT the path and size together, before the first async hop. A
      // concurrent settle (a heartbeat's handoff, the timeout sweep) calls
      // dropMigrationBlob, which zeroes both — and since the unlink leaves this
      // read's fd valid, reading the size later served the full body under a
      // `Content-Length: 0`, which the agent's urllib read as an empty bundle.
      const blobPath = m.blobPath;
      const blobSize = m.blobSize;
      // Streamed off the spool file, so handing a 65 MiB bundle down costs the
      // hub a read buffer rather than a second copy of the whole thing.
      const stream = fs.createReadStream(blobPath);
      // Headers wait for `open`, so a spool file that was never written (or is
      // unreadable) is still a clean 404 rather than a truncated 200.
      stream.once("open", () => {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": blobSize,
          "Cache-Control": "no-store",
        });
        stream.pipe(res);
      });
      stream.on("error", (e) => {
        if (res.headersSent) return res.destroy();
        json(res, 404, { error: "no bundle" });
        console.error(`migration ${id}: bundle read failed: ${e && e.message}`);
      });
      // The agent hanging up mid-download must not leave the read running.
      res.on("close", () => stream.destroy());
      return;
    }

    // GET /api/agents/<host>/uploads/<id>/blob — the agent collecting a file the
    // operator attached to a message (XERK-234). Scoped to the host the upload
    // was staged for, and since `<host>` is proved at the gate above (XERK-268)
    // that now means what this line always claimed: one host's agent token
    // cannot pull another host's pending attachment. Same shape as the
    // migration GET above and closed the same way — a hit returns the bytes, so
    // nothing but binding the segment could have stopped a token-holder who
    // knew the upload id from walking the host names. The blob is NOT dropped
    // on read: the
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
      if (!t) {
        // "Not here" and "not here because we refused it" read identically to
        // the operator, and the clients word the first as "it syncs within a few
        // minutes of ending" — which is a promise the hub cannot keep once a
        // push has been refused (XERK-356). `error` keeps its old value so
        // anything reading only that is unchanged; `refused` is the new half.
        const r = archiveRefusalFor(transcriptId);
        return json(res, 404, r
          ? { error: "unknown transcript", refused: { host: r.host, at: r.at, error: r.error } }
          : { error: "unknown transcript" });
      }
      return json(res, 200, t);
    }

    // POST /api/archive/<transcriptId>/restore — resume an ARCHIVED session on a
    // live host (XERK-441). Body: {host}, the target.
    //
    // This is the operator's own click on a session whose host may not exist any
    // more, so it rides the user login like /migrate — and, unlike /migrate,
    // there is no source agent to consult: everything it validates comes from the
    // hub's own archive index and the target's heartbeat.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "archive" &&
        parts[3] === "restore" && parts.length === 4) {
      const transcriptId = decodeURIComponent(parts[2]);
      const body = JSON.parse((await readBody(req)) || "{}");
      const target = typeof body.host === "string" ? body.host : "";
      const row = archive.sessionRow(transcriptId);
      if (!row) return json(res, 404, { error: "unknown transcript" });
      if (!row.worktree)
        return json(res, 409, {
          error: "this archived session recorded no worktree path, so there is nowhere to resume it",
        });
      // A recorded worktree is only usable if it is one of the three shapes the
      // agent's `_resumable_cwd_class` accepts, checked against what the ROW says
      // rather than guessed from the path: the hub does not know a target's
      // REPOS_ROOT, and hosts mount it at different paths on purpose.
      //   - a worktree session, `.turma/worktrees/<repo>/<dir>` — the only
      //     mount-independent shape, and the only one `_localize_migrated_cwd`
      //     can remap across differing mounts;
      //   - a ROOT session, whose cwd IS the source's REPOS_ROOT. There is no
      //     tail to match and nothing hub-side to compare it to, so the row's own
      //     repo is what identifies it. These are the MAJORITY of archived
      //     sessions — refusing them by shape made every one unrestorable;
      //   - a repo-dir session, `<REPOS_ROOT>/<repo>`, identified the same way.
      // Anything else the agent would refuse anyway, so refusing here only saves
      // an in-flight slot and a spool file. A `..` component is never legitimate.
      // A `~/.claude/projects/<slug>` dir is a TRANSCRIPT STORE, never a cwd, and
      // no agent can resume one. It is the overwhelming majority of what the
      // archive records for `(root)` rows — `repo == "(root)"` is also the
      // agent's catch-all bucket for any cwd it could not attribute to a repo, so
      // the repo alone does not mean "root session". Refusing them here is what
      // keeps admitting root rows from spending a slot, a pack and a spool file
      // on ~1228 rows the agent would refuse a minute later.
      if (/(^|\/)\.claude\/projects(\/|$)/.test(row.worktree))
        return json(res, 409, {
          error: "this archived session recorded a transcript directory rather than a working " +
                 "directory, so there is nowhere to resume it",
        });
      const wtParts = row.worktree.split("/").filter(Boolean);
      const isWorktree = /(^|\/)\.turma\/worktrees\/[^/]+\/[^/]+\/?$/.test(row.worktree);
      const isRoot = row.repo === ROOT_REPO_NAME;
      const isRepoDir = wtParts.length > 0 && wtParts[wtParts.length - 1] === row.repo &&
                        !/(^|\/)\.turma(\/|$)/.test(row.worktree);
      if (row.worktree.split("/").includes("..") ||
          !(isWorktree || isRoot || isRepoDir))
        return json(res, 409, {
          error: "this archived session's recorded worktree path is not a session worktree",
        });
      if (!row.repo)
        return json(res, 409, { error: "this archived session recorded no repo" });
      // The RENDERED entries are a display copy — `{uuid, role, ts, text}` — and
      // `claude --resume` cannot read them. Only the raw layer's byte-for-byte
      // files can be resumed, so a session archived before that layer existed, or
      // one whose raw push never landed, is readable and not restorable. Say
      // which, rather than failing later inside the agent.
      const files = archive.listRawFiles(transcriptId) || [];
      const packable = [];
      let conversation = false;
      for (const f of files) {
        const full = archive.rawFileFor(transcriptId, f.path);
        if (!full) continue;
        if (f.path === `${transcriptId}.jsonl`) conversation = true;
        packable.push({ name: f.path, path: full, size: f.bytes });
      }
      if (!conversation)
        return json(res, 409, {
          error: "the archive holds no raw copy of this session's conversation — " +
                 "only the rendered transcript, which can be read but not resumed",
        });
      if (!target) return json(res, 400, { error: "a target host is required" });
      const tgt = agents[target];
      if (!tgt) return json(res, 404, { error: "unknown target host" });
      if (Date.now() - (tgt.lastSeen || 0) >= OFFLINE_AFTER_MS)
        return json(res, 503, { error: "the target agent is offline" });
      if (!(tgt.repos || []).some((r) => r && r.name === row.repo))
        return json(res, 409, {
          error: `the target agent doesn't have "${row.repo}" cloned — clone it there first`,
        });
      // One conversation, one session. A migration PRESERVES the transcript id,
      // so restoring a conversation that is already running somewhere would put
      // two live sessions on one transcript — two claudes appending to the same
      // file, and a `_session_transcript_path` that cannot say whose it is.
      for (const [host, a] of Object.entries(agents)) {
        // ONLINE hosts only. A host that died with the session running keeps
        // `status: "running"` in its last record forever, so gating on it refused
        // the restore with "kill it there first" naming a host the operator
        // cannot reach — on exactly the population this feature exists for.
        if (Date.now() - (a.lastSeen || 0) >= OFFLINE_AFTER_MS) continue;
        const live = (a.sessions || []).find(
          (x) => x.transcriptId === transcriptId && x.status === "running");
        if (live)
          return json(res, 409, {
            error: `that conversation is already running on ${host} — kill it there first`,
          });
      }
      let inFlight = 0;
      for (const m of migrations.values()) {
        if (m.phase !== "exporting" && m.phase !== "importing") continue;
        inFlight++;
        if (m.transcriptId === transcriptId)
          return json(res, 409, { error: "this session is already being restored" });
      }
      // The same ceiling a move is held to, and for the same reason: each
      // in-flight bundle is up to 65 MiB spooled onto /data, which is shared with
      // the archive itself.
      if (inFlight >= MIGRATE_INFLIGHT_MAX)
        return json(res, 503, {
          error: `too many moves in flight (${MIGRATE_INFLIGHT_MAX}) — wait for one to finish`,
        });
      const m = startArchiveRestore(row, packable, target);
      return json(res, 200, { ok: true, migrationId: m.id });
    }

    // GET /api/archive/<transcriptId>/raw — what the raw layer holds for that
    // session, as [{path, bytes}] (XERK-338). Storing bytes nothing can read
    // back is not archiving them, so this and the download below ship with the
    // ingest rather than waiting for a UI to want them; they are also how an
    // operator confirms a session really did land.
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "archive" &&
        parts[3] === "raw" && parts.length === 4) {
      const transcriptId = decodeURIComponent(parts[2]);
      const files = archive.listRawFiles(transcriptId);
      if (!files) return json(res, 404, { error: "unknown transcript" });
      return json(res, 200, { transcriptId, files });
    }

    // GET /api/archive/<transcriptId>/raw/<file> — one raw file, byte for byte.
    // `<file>` is percent-encoded into a single segment like the ingest route's,
    // and goes through the same allowlist before it names anything.
    //
    // Served as a DOWNLOAD, never inline: these are attacker-influenced bytes
    // (a session transcript contains whatever was pasted into it), and a
    // browser rendering them same-origin behind the hub's login is stored XSS.
    // `text/plain` + `nosniff` + an attachment disposition is the same posture
    // the rest of the app's file surfaces take.
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "archive" &&
        parts[3] === "raw" && parts.length === 5) {
      const transcriptId = decodeURIComponent(parts[2]);
      let rel;
      try { rel = decodeURIComponent(parts[4]); } catch { return json(res, 400, { error: "bad file" }); }
      const full = archive.rawFileFor(transcriptId, rel);
      if (!full) return json(res, 404, { error: "unknown file" });
      let size;
      try { size = fs.statSync(full).size; } catch { return json(res, 404, { error: "unknown file" }); }
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": size,
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `attachment; filename="${archive.slugify(rel, "raw")}"`,
        "Cache-Control": "no-store",
      });
      return void fs.createReadStream(full)
        .on("error", () => res.destroy())
        .pipe(res);
    }

    // GET /api/dsh/<transcriptId>/trajectory — the Turma-native read-only
    // Trajectory over a dsh session's D3 NATIVE event log (XERK-498), parsed
    // server-side from the raw archive layer into turns/steps/tool-calls/
    // token-usage/timings. This is the host-wide dsh viewer that replaces the
    // removed per-session dsh terminal; it needs no host proxy and no dsh web
    // server because the native log already rides the raw archive (XERK-469).
    // JSON and bounded (archive.js); nothing raw is returned. A non-dsh (or
    // not-yet-archived) session answers 404 — the client shows "no trajectory".
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "dsh" &&
        parts[3] === "trajectory" && parts.length === 4) {
      const transcriptId = decodeURIComponent(parts[2]);
      const traj = archive.dshTrajectory(transcriptId);
      if (!traj) return json(res, 404, { error: "no dsh trajectory for this session" });
      return json(res, 200, traj);
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
      for (const f of ["label", "baseRef", "model", "permissionMode",
                       "modelSource", "localModel", "agentType"]) {
        if (typeof body[f] === "string" && body[f].trim()) cmd[f] = body[f].trim();
      }
      if (Number.isInteger(body.localContext) && body.localContext > 0) {
        cmd.localContext = body.localContext;
      }
      // Same enum as the switch route: a spawn is the OTHER way onto the local
      // model, so junk must 400 here rather than land as an errored session card.
      const spawnSourceErr = checkSpawnModelSource(cmd, hostname);
      if (spawnSourceErr) return json(res, spawnSourceErr.status, { error: spawnSourceErr.error });
      const spawnTypeErr = checkSpawnAgentType(cmd, hostname);
      if (spawnTypeErr) return json(res, spawnTypeErr.status, { error: spawnTypeErr.error });
      const spawnModeErr = checkSpawnPermissionMode(cmd);
      if (spawnModeErr) return json(res, spawnModeErr.status, { error: spawnModeErr.error });
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
                         "modelSource", "localModel", "agentType"]) {
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
        // The context override is numeric (XERK-489); the agent clamps it to the
        // served window, so the hub only keeps a positive int and drops anything
        // else so the served figure applies.
        if (Number.isInteger(body.localContext) && body.localContext > 0) {
          cmd.localContext = body.localContext;
        }
        const spawnSourceErr = checkSpawnModelSource(cmd, key);
        if (spawnSourceErr) return json(res, spawnSourceErr.status, { error: spawnSourceErr.error });
        const spawnTypeErr = checkSpawnAgentType(cmd, key);
        if (spawnTypeErr) return json(res, spawnTypeErr.status, { error: spawnTypeErr.error });
        const spawnModeErr = checkSpawnPermissionMode(cmd);
        if (spawnModeErr) return json(res, spawnModeErr.status, { error: spawnModeErr.error });
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
        // The CLAIMED org on both sides, deliberately UNCHANGED by XERK-348's
        // org binding, which gates the peer roster and nothing else.
        //
        // Two attempts to bind-gate this route were reverted, and neither should
        // be retried without the missing piece. Comparing `orgBound` made the hub
        // and every Move menu disagree in both directions, because `orgBound` is
        // stripped from the served payload and no client can mirror a rule keyed
        // on it. Refusing a DRIFTED host on top of a claim match is what is left
        // of that, and it buys almost nothing: the refusal is one beat deep — a
        // drifted host that simply omits its `jira` block on the next beat is a
        // legal target again — while being the only surviving hub/client
        // divergence. It also does not close the real hole, which predates this
        // and is measured in XERK-349: two hosts that BOTH declare no org match
        // each other whatever they are bound to, so a session can be relayed
        // across a binding boundary with no drift anywhere.
        //
        // Closing that means serving the DECIDED org so the three client mirrors
        // can agree with the hub. That is a parity change, and it is XERK-349.
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
        let inFlight = 0;
        for (const m of migrations.values()) {
          if (m.phase !== "exporting" && m.phase !== "importing") continue;
          inFlight++;
          if (m.srcHost === key && m.srcSessionId === sessionId) {
            return json(res, 409, { error: "this session is already being moved" });
          }
        }
        // Each in-flight move is a 65 MiB bundle already spooled onto /data or
        // about to be (an `exporting` one is waiting on exactly that upload),
        // and /data is shared with the archive — so cap how many can be in that
        // state at once. Refusing HERE is safe in a way refusing the relay
        // upload isn't: this is the operator's own click, and the web Move
        // control shows the reason (see PARITY.md for the Android gap).
        if (inFlight >= MIGRATE_INFLIGHT_MAX)
          return json(res, 503, {
            error: `too many moves in flight (${MIGRATE_INFLIGHT_MAX}) — wait for one to finish`,
          });
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
        } catch (e) {
          // Same distinction the migration relay draws: "too big" is about the
          // file and tells the operator to pick a smaller one; "busy" is about
          // the hub and tells them to press send again.
          if (e && e.stalled) return;
          if (e && e.budgetExceeded) {
            res.setHeader("Retry-After", "1");
            res.setHeader("Connection", "close");
            json(res, 503, { error: e.message, held: e.held, limit: e.limit });
            return endRefusedConnection(req, res);
          }
          json(res, 413, {
            error: `file too large — the limit is ${cap.toLocaleString("en-US")} bytes`,
            limit: cap,
          });
          if (e.noDrain) endRefusedConnection(req, res);
          return;
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
        // A LOCAL session's model is an ENDPOINT model, not a Claude alias
        // (XERK-489). The agent rewrites the env and relaunches rather than
        // driving the /model picker (whose Claude rows the gateway all reject),
        // so accept it here — but against the endpoint charset (ids carry `:`/`/`
        // that the Claude-alias regex forbids) and only when the host's
        // discovered set actually serves it (409, mirroring the switch route).
        // A dsh session's model is a DISCOVERED endpoint id, not a Claude alias
        // (XERK-504): the agent relaunches the dsh process on the new model
        // rather than driving the (non-existent) /model picker, so accept the
        // endpoint charset and validate against the host's discovered dsh set.
        if (sessionAgentType(key, sessionId) === "dsh") {
          if (model.length > 60 || !/^[A-Za-z0-9._:/-]+$/.test(model))
            return json(res, 400, { error: "invalid model" });
          if (!dshServes(agents[key], model))
            return json(res, 409, { error: "host does not serve that dsh model" });
          const cmdId = queueCommand(key, { type: "setModel", sessionId, model });
          return json(res, 200, { ok: true, cmdId });
        }
        if (sessionModelSource(key, sessionId) === "local") {
          if (model.length > 60 || !/^[A-Za-z0-9._:/-]+$/.test(model))
            return json(res, 400, { error: "invalid model" });
          if (!localModelServes(agents[key], model))
            return json(res, 409, { error: "host does not serve that local model" });
          // Optional advanced context-window override (XERK-489). The agent
          // clamps it to the served window (shrink-only); the hub only checks it
          // is a positive int, else drops it so the served figure applies.
          const cmd = { type: "setModel", sessionId, model };
          if (Number.isInteger(body.context) && body.context > 0) {
            cmd.localContext = body.context;
          }
          const cmdId = queueCommand(key, cmd);
          return json(res, 200, { ok: true, cmdId });
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
        // A repos-root session may not switch INTO bypassPermissions live either
        // (XERK-309) — the spawn gate would be pointless if a live switch reopened
        // it. Refused only when we can see the session is root; if the record
        // isn't in the payload yet the agent's own set_mode gate still refuses.
        const modeSess = (agents[key].sessions || []).find((x) => x.id === sessionId);
        // Trim to match the agent's own strip (set_mode) — see checkSpawnPermissionMode.
        if (modeSess && modeSess.root && permissionMode.trim() === "bypassPermissions") {
          return json(res, 409, {
            error: "bypassPermissions is not allowed for a repos-root session",
          });
        }
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
        // Optionally land on a CHOSEN endpoint model in the same step (XERK-489);
        // validate membership like the /model route. Ignored for a subscription
        // switch.
        const localModel = typeof body.localModel === "string" ? body.localModel : "";
        if (localModel) {
          if (localModel.length > 60 || !/^[A-Za-z0-9._:/-]+$/.test(localModel))
            return json(res, 400, { error: "invalid localModel" });
          if (modelSource === "local" && !localModelServes(agents[key], localModel))
            return json(res, 409, { error: "host does not serve that local model" });
        }
        const cmd = { type: "setModelSource", sessionId, modelSource };
        if (localModel && modelSource === "local") cmd.localModel = localModel;
        const cmdId = queueCommand(key, cmd);
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
        // A RUNNING session's transcript is materialized in the hub's durable
        // archive (the agent keeps a worktree-backed running session syncing), so
        // serve scrollback from there INSTANTLY on a cache miss instead of making
        // the operator wait out an agent round-trip — the delay this fixes. Still
        // queue a refresh so the cache heals to the freshest copy (the archive
        // lags the live head by a few beats; the live tail covers that head, and
        // the client folds the two in transcript order). Only when the archive has
        // nothing yet do we fall through to the queue-and-202 path.
        const sess = (agents[key].sessions || []).find((x) => x.id === sessionId);
        if (sess && sess.status === "running") {
          const fromArchive = archiveHistory(sess.transcriptId);
          if (fromArchive) {
            if (!pending) queueCommand(key, { type: "history", sessionId });
            return json(res, 200, fromArchive);
          }
        }
        const cmdId = pending ? pending.cmdId : queueCommand(key, { type: "history", sessionId });
        return json(res, 202, { pending: true, cmdId });
      }
      // GET /api/agents/<host>/sessions/<id>/subagents/history?type=&label=
      //   [&agentId=] -> the transcript of one live background agent the session
      // spawned (the pane agent-list row identifies it by type + short
      // description). Same fresh-cache / queue-and-202 / single-flight shape as
      // /history.
      //
      // A `workflow` row is the one that answers differently (XERK-304): with no
      // `agentId` it comes back carrying `agents` — that run's agent list — and
      // the client re-requests with one of those ids to get a transcript. The
      // presence of `agents` is the whole signal, so it is served whenever the
      // agent sent one, empty list included.
      if (req.method === "GET" && parts.length === 7 &&
          parts[5] === "subagents" && parts[6] === "history") {
        const agentType = (url.searchParams.get("type") || "").trim();
        const label = (url.searchParams.get("label") || "").trim();
        const agentId = (url.searchParams.get("agentId") || "").trim();
        if (!agentType) return json(res, 400, { error: "type required" });
        if (agentId && !SUBAGENT_ID_RE.test(agentId)) {
          return json(res, 400, { error: "bad agentId" });
        }
        const cached = (agents[key].subagentHistory || {})[
          subagentKey(sessionId, agentType, label, agentId)];
        if (cached && Date.now() - cached.fetchedAt < HISTORY_FRESH_MS) {
          const body = {
            entries: cached.entries,
            truncated: cached.truncated,
            fetchedAt: cached.fetchedAt,
          };
          if (cached.agents) {
            body.agents = cached.agents;
            body.agentsTruncated = !!cached.agentsTruncated;
          }
          return json(res, 200, body);
        }
        const pending = (agents[key].commands || []).find(
          (c) => c.type === "subagentHistory" && c.sessionId === sessionId &&
            c.agentType === agentType && (c.label || "") === label &&
            (c.agentId || "") === agentId);
        const cmdId = pending ? pending.cmdId
          : queueCommand(key, { type: "subagentHistory", sessionId, agentType, label, agentId });
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
      // Removing the host does NOT remove what it spent (XERK-338) — that is the
      // whole point of the ledger, and the Usage page keeps charting it as a
      // retired host. `?usage=purge` is the deliberate second step for an
      // operator who wants the history gone too; there is no way back from it,
      // so it is never the default and never implied by removing the card.
      const purged = url.searchParams.get("usage") === "purge"
        ? usageLedger.forget(key) : false;
      scheduleSave();
      invalidateAgentsCache();
      sseBroadcast("removed", { key });
      return json(res, 200, { ok: true, usagePurged: purged });
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

    // GET /api/jira/<siteKey>/<issueKey>/priority?cmdId=<id> — poll the outcome
    // of a priority write queued by the sweep (XERK-483). {pending:true} until
    // the agent's heartbeat carries the result for that cmdId, then
    // {ok, error, action, priority}: action is "written" (the band was applied),
    // "no-op" (already at that value), or "skipped" (a human-set value was left
    // alone — the sweep stops re-queueing on this). Keyed by cmdId for the same
    // reason the /status route is.
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 5 && parts[4] === "priority") {
      const siteKey = decodeURIComponent(parts[2]);
      const issueKey = decodeURIComponent(parts[3]);
      if (!isIssueKey(issueKey)) {
        return json(res, 400, { error: "not a valid issue key" });
      }
      const cmdId = url.searchParams.get("cmdId");
      if (!cmdId) return json(res, 400, { error: "cmdId required" });
      const key = commandHost(siteKey, cmdId, "setTicketPriority", "priorityResults")
        || findJiraHost(siteKey, false);
      if (!key) return json(res, 404, { error: "no host reports that org" });
      const r = (agents[key].priorityResults || {})[cmdId];
      if (!r) return json(res, 200, { pending: true });
      return json(res, 200, {
        ok: r.ok, error: r.error, action: r.action, priority: r.priority,
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
    // uses, since the session id doesn't exist yet at POST time. When the org has
    // no free slot the reply is `{queued:true, position}` instead and there is no
    // cmdId to correlate: nothing has been handed to a host yet (XERK-296).
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
      const { host, error, status, needsClone, full } =
        findTicketHost(siteKey, repo, issueKey, { requireFree: true });
      // Every org host is up but none has a free slot — the ticket waits in the
      // hub's queue (XERK-296) instead of being nailed to a host now and turned
      // into a session that only waits. Whichever agent frees a slot first takes
      // it; the operator can cancel it with the DELETE below. A HARD failure (no
      // org, everything offline, a pinned host that's gone) still refuses here:
      // queuing can't fix any of those, and a refusal has to reach the operator.
      if (!host && full) {
        const e = enqueueTicketStart(siteKey, issueKey, "manual");
        if (!e) {
          // Which line is full decides the wording, and there are two: this org's
          // (the real resource — the queue drains per org) and the fleet's (the
          // memory bound behind it). One org's backlog must never be reported as
          // "the queue is full" to another org's operator.
          return json(res, 429, {
            error: ticketQueueAdmission(siteKey, issueKey, "manual") === "fleet-full"
              ? "the hub's ticket queue is full"
              : `that org already has ${TICKET_QUEUE_PER_ORG_MAX} tickets waiting to start`,
          });
        }
        const pos = ticketQueuePayload().find(
          (q) => q.siteKey === siteKey && q.issueKey === issueKey);
        return json(res, 200, { ok: true, queued: true, repo,
          position: (pos && pos.position) || 1 });
      }
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
      // The runtime pin (XERK-473) rides as `agentType`; findTicketHost above
      // already ensured `host` offers it. Omitted (claude) when unpinned.
      const rpin = ticketRuntimePin(siteKey, issueKey);
      const cmdId = pending ? pending.cmdId
        : queueCommand(host, { type: "spawnTicket", issueKey,
            ticketSource: "manual", ticketSite: siteKey,
            ...(mpin ? { model: mpin.model } : {}),
            ...(rpin ? { agentType: rpin.runtime } : {}) });
      // This ticket may ALREADY be waiting in the queue (the sweep queued it, or
      // a board that hadn't seen the queue yet clicked Start). Its session is
      // starting now, so its place in line is spent — leaving it there would
      // dispatch it AGAIN on the next free slot, hours later and unasked.
      dropQueuedTicket(siteKey, issueKey, "dispatched by a direct start");
      rememberDispatch(siteKey, issueKey);
      // needsClone tells the board the chosen host doesn't have the repo yet, so
      // it will clone on demand and the session starts queued behind the clone.
      return json(res, 200, { ok: true, cmdId, host, repo, needsClone });
    }

    // DELETE /api/jira/<siteKey>/<issueKey>/session -> take a waiting ticket out
    // of the hub queue (XERK-296). It can only ever remove a QUEUED TICKET —
    // nothing has been dispatched, so there is no session, no worktree and no
    // command to withdraw, and the ticket itself is untouched. Killing a session
    // that has actually started is the Sessions page's job and stays there.
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 5 && parts[4] === "session") {
      const siteKey = decodeURIComponent(parts[2]);
      const issueKey = decodeURIComponent(parts[3]);
      if (!isIssueKey(issueKey)) {
        return json(res, 400, { error: "not a valid issue key" });
      }
      if (!dropQueuedTicket(siteKey, issueKey, "cancelled by the operator")) {
        // The entry is equally gone whether it was cancelled a moment ago or
        // DISPATCHED a moment ago, and answering the second like the first told
        // an operator their cancel worked while a session was starting. So a
        // recent dispatch is refused in the hub's own words instead.
        if (dispatchedRecently(siteKey, issueKey)) {
          return json(res, 409, { error:
            "that ticket just started — its session is coming up, so stop it from "
            + "the Sessions page" });
        }
        return json(res, 404, { error: "that ticket isn't waiting in the queue" });
      }
      return json(res, 200, { ok: true });
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

    // POST /api/jira/<siteKey>/<issueKey>/runtime — pin which RUNTIME this
    // ticket's session runs on (XERK-473 dsh, XERK-515 qwen). Body:
    // {runtime:"claude"|"dsh"|"qwen"}, where "claude" (or {auto:true}) releases
    // back to the default. Hub-owned durable state exactly like the /model pin —
    // the runtime rides the spawnTicket command as `agentType`, so this is
    // authoritative the moment it returns (a 200). A non-default pin is refused
    // unless the org actually offers that runtime, so it can't name one no
    // session could run; the agent still re-validates (resolve_agent_type) and
    // the dispatch (findTicketHost) routes it only to a host that offers it.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 5 && parts[4] === "runtime") {
      const siteKey = decodeURIComponent(parts[2]);
      const issueKey = decodeURIComponent(parts[3]);
      if (!isIssueKey(issueKey)) {
        return json(res, 400, { error: "not a valid issue key" });
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.runtime != null && typeof body.runtime !== "string") {
        return json(res, 400, { error: "body needs {runtime} or {auto:true}" });
      }
      const raw = typeof body.runtime === "string" ? body.runtime.trim().toLowerCase() : "";
      // "claude" is the default, so pinning to it is a release — same landing as
      // {auto:true} or an empty value, rather than storing a "claude" pin.
      const auto = body.auto === true || raw === "claude" || raw === "";
      if (!auto && raw !== "dsh" && raw !== "qwen") {
        return json(res, 400, { error: "runtime must be claude, dsh or qwen" });
      }
      if (!Object.values(agents).some(
        (a) => a && a.jira && a.jira.siteKey === siteKey)) {
        return json(res, 404, { error: "no host reports that Jira org" });
      }
      if (!auto && raw === "dsh" && !orgOffersDsh(siteKey)) {
        return json(res, 400, { error: "no host reporting this org offers the dsh runtime" });
      }
      if (!auto && raw === "qwen" && !orgOffersQwen(siteKey)) {
        return json(res, 400, { error: "no host reporting this org offers the qwen runtime" });
      }
      setTicketRuntime(siteKey, issueKey, auto ? null : raw);
      return json(res, 200, { ok: true, runtime: auto ? "claude" : raw });
    }

    // POST /api/jira/<siteKey>/<issueKey>/triage — the operator's per-ticket
    // triage verdict (XERK-486 [F]). Body: {action:"approve"|"hold"|"reject"}
    // to set it, {action:null} (or {clear:true}) to release back to the
    // triage-model's call + the org policy. Hub-owned durable state exactly like
    // the /agent /model /runtime pins: keyed "<siteKey>/<issueKey>", authoritative
    // on return (a 200), the org must be one the fleet reports.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 5 && parts[4] === "triage") {
      const siteKey = decodeURIComponent(parts[2]);
      const issueKey = decodeURIComponent(parts[3]);
      if (!isIssueKey(issueKey)) {
        return json(res, 400, { error: "not a valid issue key" });
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      const action = body.clear === true || body.action == null ? null : body.action;
      if (action != null && !TRIAGE_ACTIONS.has(action)) {
        return json(res, 400, { error: "body needs {action:approve|hold|reject} or {clear:true}" });
      }
      if (!Object.values(agents).some(
        (a) => a && a.jira && a.jira.siteKey === siteKey)) {
        return json(res, 404, { error: "no host reports that Jira org" });
      }
      setTicketTriageAction(siteKey, issueKey, action);
      return json(res, 200, { ok: true, action });
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

    // POST /api/jira/<siteKey>/priority-writeback — flip an org's triage
    // priority write-back opt-in (XERK-483). Body: {enabled:true|false}.
    // Same posture as /autostart: hub-owned durable state, authoritative on
    // return, the org must be one the fleet reports, the host need not be
    // online. Writing tracker fields is intrusive, so it stays OFF until
    // explicitly enabled here.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 4 && parts[3] === "priority-writeback") {
      const siteKey = decodeURIComponent(parts[2]);
      const body = JSON.parse((await readBody(req)) || "{}");
      if (typeof body.enabled !== "boolean") {
        return json(res, 400, { error: "body needs {enabled:true|false}" });
      }
      if (!Object.values(agents).some(
        (a) => a && a.jira && a.jira.siteKey === siteKey)) {
        return json(res, 404, { error: "no host reports that Jira org" });
      }
      setPriorityWriteBackOrg(siteKey, body.enabled);
      return json(res, 200, { ok: true, enabled: body.enabled });
    }

    // POST /api/jira/<siteKey>/dedupe-link — flip an org's duplicate-linking
    // opt-in (XERK-484). Body: {enabled:true|false}. Same posture as
    // /priority-writeback: hub-owned durable state, authoritative on return,
    // the org must be one the fleet reports, the host need not be online.
    // Writing issue links into a tracker is intrusive, so it stays OFF until
    // explicitly enabled here.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 4 && parts[3] === "dedupe-link") {
      const siteKey = decodeURIComponent(parts[2]);
      const body = JSON.parse((await readBody(req)) || "{}");
      if (typeof body.enabled !== "boolean") {
        return json(res, 400, { error: "body needs {enabled:true|false}" });
      }
      if (!Object.values(agents).some(
        (a) => a && a.jira && a.jira.siteKey === siteKey)) {
        return json(res, 404, { error: "no host reports that Jira org" });
      }
      setDedupeLinkOrg(siteKey, body.enabled);
      return json(res, 200, { ok: true, enabled: body.enabled });
    }

    // POST /api/jira/<siteKey>/triage-policy — upsert an org's triage policy
    // (XERK-486 [F]). Body: a patch of {minPriority?, excludeTypes?, repoAllow?,
    // repoDeny?, rateMax?}; null values clear a knob. Hub-owned durable state
    // like /autostart: authoritative on return, the org must be one the fleet
    // reports, the host need not be online. The auto-start switch itself stays
    // the on/off gate; this only shapes WHAT an enabled org auto-starts.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "jira" &&
        parts.length === 4 && parts[3] === "triage-policy") {
      const siteKey = decodeURIComponent(parts[2]);
      const body = JSON.parse((await readBody(req)) || "{}");
      const p = sanitizeTriagePolicy(body);
      if (p === null) {
        return json(res, 400, {
          error: "policy knobs must be {minPriority:P0|P1|P2|P3|null, excludeTypes:string[]|null, repoAllow:string[]|null, repoDeny:string[]|null, rateMax:int 1..50|null}",
        });
      }
      if (!Object.values(agents).some(
        (a) => a && a.jira && a.jira.siteKey === siteKey)) {
        return json(res, 404, { error: "no host reports that Jira org" });
      }
      setTriagePolicy(siteKey, p);
      return json(res, 200, { ok: true, policy: triagePolicies[siteKey] || null });
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

    // POST /api/repos/<repo>/tier — set a repo's importance tier (XERK-487).
    // Body: {tier:"live"|"active"|"archive"|"ignore"} to pin, {auto:true} to
    // reset to the default middle tier. Hub-owned durable state like /autostart
    // and /color: the save is authoritative on return (a 200, nothing rides a
    // heartbeat), and the repo must be one the fleet actually reports (or already
    // has a tier), so a pin can't invent a phantom repo or grow the map without
    // bound. The repo name is the same one repoGuess yields, so it joins to a
    // ticket's triaged repo.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "repos" &&
        parts.length === 4 && parts[3] === "tier") {
      const repo = decodeURIComponent(parts[2]);
      const body = JSON.parse((await readBody(req)) || "{}");
      const auto = body.auto === true;
      if (!auto && !isRepoTier(body.tier)) {
        return json(res, 400, {
          error: `body needs {tier:${REPO_TIERS.map((t) => `"${t}"`).join("|")}} or {auto:true}` });
      }
      if (!repo || repo.length > REPO_NAME_MAX) {
        return json(res, 400, { error: "a repo name is required" });
      }
      if (!fleetRepoNames().has(repo) && !Object.hasOwn(repoTiers, repo)) {
        return json(res, 404, { error: "no host reports a repo by that name" });
      }
      setRepoTier(repo, auto ? DEFAULT_REPO_TIER : body.tier);
      return json(res, 200, { ok: true, tier: auto ? DEFAULT_REPO_TIER : body.tier });
    }

    // Terminal proxy: /term/<sessionId>/… -> the ttyd of the host that owns
    // that session, tunneled to its per-session ttydPort. User auth already
    // enforced by the gate above.
    if (parts[0] === "term" && parts.length >= 2) {
      const sessionId = decodeURIComponent(parts[1]);
      const loc = findSession(sessionId);
      if (!loc) return json(res, 404, { error: "unknown session" });
      // ttyd runs with `-b /term/<id>`, so it answers the BARE base path with a
      // 302 to that same path plus a trailing slash. A hop that normalizes the
      // slash away therefore turns the terminal into a redirect to itself, and
      // the browser gives up: cloudflared 2026.8.0 did exactly that (path.Clean
      // in canonicalizeRequestPath, restored a release later), taking out every
      // terminal on the fleet while the agents stayed connected. Every client
      // asks for the slash form, so serve the document at the base path here
      // rather than depending on the slash surviving every hop to us. Only the
      // base path — assets and the WS below it never end in one.
      // The slash is INSERTED into the original target, never rebuilt from the
      // parsed URL: rebuilding re-encodes the query and would newly accept
      // absolute-form, protocol-relative and backslash targets that reach ttyd
      // as a 404 today. `startsWith` is what holds this to origin-form requests,
      // so the only difference on the wire is the one character.
      if (parts.length === 2 && !url.pathname.endsWith("/") && req.url.startsWith(url.pathname)) {
        req.url = `${url.pathname}/${req.url.slice(url.pathname.length)}`;
      }
      return proxyTerm(req, res, loc.host, loc.port);
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    // An oversized body must come back as a status the caller can branch on.
    // The socket is still open here precisely because readBody drained instead
    // of destroying it (XERK-235).
    if (err && err.tooLarge) {
      if (!res.writableEnded) json(res, 413, { error: "body too large", limit: err.cap });
      // Not drained (the hub is under an oversize flood), so nothing is coming
      // to consume the rest of this body — close rather than let Node dump it.
      if (err.noDrain) endRefusedConnection(req, res);
      return;
    }
    // Not "your request is too big" — "the hub is momentarily holding as much as
    // it safely can". A 503 so the caller retries instead of shrinking anything;
    // the {error} body is what every client already toasts (XERK-264).
    if (err && err.budgetExceeded) {
      if (!res.writableEnded) {
        res.setHeader("Retry-After", "1");
        res.setHeader("Connection", "close");
        json(res, 503, { error: err.message, held: err.held, limit: err.limit });
      }
      endRefusedConnection(req, res);
      return;
    }
    // A stalled body's socket is already gone — there is nobody to answer.
    if (err && err.stalled) return;
    json(res, 400, { error: err.message });
  }
});

// The cap counts every open socket, INCLUDING the upgraded WebSockets below —
// they are the long-lived, most expensive ones, so leaving them out would let
// the very connections this protects against accumulate uncounted. That is also
// why the number has to clear steady-state WebSocket use with room to spare.
server.maxConnections = MAX_CONNECTIONS;

// Node destroys a connection over the cap before emitting `request`, so this is
// the only place a refusal is observable. See MAX_CONNECTIONS for why it is
// rate-limited rather than one line per drop.
server.on("drop", () => {
  dropsSinceLog++;
  const now = Date.now();
  if (now - dropLoggedAt < DROP_LOG_EVERY_MS) return;
  console.warn(
    `WARNING: connection cap reached (MAX_CONNECTIONS=${MAX_CONNECTIONS}) — ` +
      `refused ${dropsSinceLog} connection(s); clients see a reset, not an HTTP error`
  );
  dropLoggedAt = now;
  dropsSinceLog = 0;
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
    // `name` is read BEFORE the auth check, because it is what the credential
    // has to back (XERK-268) — registering another host's tunnel would route
    // that host's terminals through the impostor.
    const name = url.searchParams.get("name");
    if (!name) return socket.destroy();
    if (!agentWsAuthorized(url, req, name)) return socket.destroy();
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
      // The session id must be a STRING, not merely truthy (XERK-278). It is
      // used as a property key in `liveFanout`, and coercing an object to a key
      // runs the same ToPrimitive that `safeString` exists to survive — so an
      // object id here threw out of this listener and killed the process, the
      // moment any viewer socket was open on that host. Every real id is a
      // string, so this only ever refuses a malformed frame.
      if (msg && typeof msg.tail === "string" && msg.tail && Array.isArray(msg.entries)) {
        // `queued` = still-queued prompts typed mid-turn (foldQueueOp in
        // tunnel-agent.js); absent from agents predating it.
        liveFanout(name, msg.tail, { type: "tail", entries: msg.entries,
          queued: Array.isArray(msg.queued) ? msg.queued : [] });
      } else if (msg && typeof msg.turn === "string" && msg.turn && typeof msg.text === "string") {
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
    const ch = url.searchParams.get("ch");
    const pending = pendingChannels[ch];
    if (!pending) return socket.destroy();
    // Only the host this channel was opened for may answer it (XERK-268): the
    // duplex becomes that host's terminal stream.
    if (!agentWsAuthorized(url, req, pending.host)) return socket.destroy();
    wsHandshake(socket, req);
    pending.resolve(channelDuplex(socket));
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
    const hdrs = { ...req.headers, host: "ttyd", authorization: ttydAuth(loc.host) };
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

// Nothing in the migration spool survives a restart usefully (the records that
// name those files were in memory), so clear it before anything can relay.
sweepMigrationSpool();

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
    // Asset fingerprinting (XERK-312). Exported so a test can hold the map
    // itself: the wire tests prove one page links a hashed URL, this proves
    // EVERY mutable asset got a hashed twin AND kept its bare name served —
    // dropping either half is a silent regression the pages still render past.
    STATIC_ASSETS, ASSET_URLS, IMMUTABLE_CACHE, REVALIDATE_CACHE, HTML_CACHE, SUPERSEDED_CACHE,
    supersededAsset,
    invalidateAgentsCache,
    serializeAgentsForSave,
    // The usage-coercion warning is rate-limited to one line a minute across the
    // WHOLE fleet, on module state. Exported so a test can hold BOTH halves of
    // the rule — that a deliberate `null` stays silent AND that a wrong-typed
    // value still warns — without the second half passing merely because an
    // earlier test in the file spent the window.
    resetUsageCoercionLog,
    // The in-flight body budget (XERK-258). Exported because the admission rule
    // is the whole fix and is otherwise only reachable by actually flooding a
    // memory-limited container: the ceilings so a test can hold the arithmetic
    // that derives them from the container limit, and charge/release so the
    // "idle hub admits anything, a busy one does not" rule can be held directly.
    MEMORY_LIMIT, BODY_INFLIGHT_MAX, BODY_INFLIGHT_TOTAL_MAX, UPLOAD_TOTAL_MAX_BYTES,
    // The archive route's own ceiling and the refusal record behind it
    // (XERK-356): a test has to be able to hold BOTH — that the hub takes a
    // multi-MB delta at all, and that a refused one is still answerable when the
    // operator asks where that session went.
    ARCHIVE_CHUNK_BODY_MAX, ARCHIVE_PARSE_COST, archiveChunkLabel,
    archiveRefusals, archiveRefusalFor,
    noteArchiveRefusal, ARCHIVE_REFUSALS_MAX, ARCHIVE_REFUSALS_PER_HOST,
    bodyLaneFor, chargeBody, releaseBody, bodyInflightHeld, BODY_PARSE_COST,
    DRAIN_CONCURRENCY_MAX, BODY_IDLE_TIMEOUT_MS, BODY_MIN_PROGRESS_BYTES,
    BIG_LANE_MAX_HOLD_MS, budgetUnderPressure,
    // XERK-235 heartbeat/record bounds — a QA pass removed each of these
    // and the suite stayed green, so they are exported to be pinned.
    sanitizeHeartbeat, agentRecordSize, safeAgentsCache,
    HEARTBEAT_UNKNOWN_MAX, AGENT_RECORD_MAX,
    // XERK-272 registry bounds. Exported for the same reason as the group above:
    // the per-record ceiling stayed green while an unbounded NUMBER of records
    // OOM-killed the hub, so the aggregate has to be pinned by name too.
    AGENTS_MAX, AGENTS_TOTAL_MAX, AGENT_EVICT_IDLE_MS, AGENT_FAIR_SHARE,
    STATE_FILE_MAX, positiveEnv, logName, recordSizeWarned, shareWarned, fairShare,
    registryBytes, makeRegistryRoom, trimRestoredAgents, containerMemoryLimit,
    defaultRegistryBudget, recordBytes,
    // Ingest coercion, exported for the same reason as the rest of this group:
    // Android decodes /api/agents atomically, so one host's wrong-typed field
    // hides the WHOLE fleet from that phone (XERK-246). `normalizeRecord` is
    // the one both the ingest path and the state.json restore call.
    normalizeRecord,
    normalizeLocalModel,
    normalizeDsh,
    dshAvailable,
    // The fleet-wide dsh kill switch (XERK-460) is in-code and DISABLED by
    // default, so the retained dsh tests must flip it ON around themselves to
    // prove dsh still works when enabled. The setter lets a test do that (and
    // reset to false after); the getter is for asserting the default is off.
    __setDshEnabled(v) { DSH_ENABLED = v; },
    __getDshEnabled() { return DSH_ENABLED; },
    normalizeQwen,
    normalizeTriage,
    normalizeDefaultRuntime,
    qwenAvailable,
    // The fleet-wide qwen kill switch (XERK-504) mirrors the dsh one above: the
    // [Qwen A] tests flip it ON around themselves to prove the plumbing works
    // when enabled, and assert the default is off.
    __setQwenEnabled(v) { QWEN_ENABLED = v; },
    __getQwenEnabled() { return QWEN_ENABLED; },
    normalizeRetired,
    normalizeJira,
    normalizeClones,
    CLONE_PROGRESS_MAX: 120,
    normalizeSpawnRefusals,
    // The KEY half of that pair, shared by the ingest and the restore for the
    // same anti-drift reason (XERK-269). `dropUnusableHostKeys` is exported
    // because a source-regex over the restore loop proves the CALL exists, not
    // that it drops anything — two mutations of an inline loop kept the suite
    // green while restoring the ghost. `hostKeyLabel` because a refused key is
    // attacker-controlled and unbounded.
    isPlainHostKey, dropUnusableHostKeys, hostKeyLabel,
    // The holder the heartbeat's coercion step goes through, exported so a test
    // can make it throw and hold the rollback that follows (XERK-262). See its
    // declaration for why that rollback cannot be reached from the wire.
    recordCoercion,

    // Durable token-usage history (XERK-338). Exported so a wire test can clear
    // it between cases: it is process-wide and outlives the registry by design,
    // so a synthetic host left in it would ride every later /api/agents body.
    usageLedger,

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
    agentPresented,
    agentBearerKind,
    agentHostRefusal,
    agentPresentedRefusal,
    tokenHost,
    // The reverse-tunnel maps, exported so their null prototype can be asserted
    // directly. Reaching it through a socket instead means the regression is
    // detected by the hub DYING mid-run, which reads as a CI timeout rather
    // than a failing test (XERK-268).
    controlChannels,
    pendingChannels,
    agentWsAuthorized,
    hostAgentToken,
    ttydAuth,
    triggerAuthorized,
    safeEqual,
    credentialsMatch,
    issueSessionToken,
    sessionTokenValid,
    fmtDur,
    TERM_OSC52_JS,
    TERM_SCROLL_BOTTOM_JS,
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
    // Triage policy + per-ticket verdict (XERK-486 [F]): the stores, the policy
    // evaluator the sweep and drain consult, the per-org rate cap, and the
    // setters the /triage-policy and /triage routes drive.
    triagePolicies,
    setTriagePolicy,
    sanitizeTriagePolicy,
    triagePolicyReason,
    autoStartRateMax,
    ticketTriageActions,
    ticketTriageAction,
    setTicketTriageAction,
    TRIAGE_ACTIONS_MAX,
    priorityWriteBackOrgs,
    setPriorityWriteBackOrg,
    orgsWithPriorityWriteBack,
    priorityWriteBackSweep,
    priorityWriteBackSkips,
    // Duplicate-linking (XERK-484): per-org opt-in store, sweep, suppression map,
    // and the setter the /dedupe-link route drives.
    dedupeLinkOrgs,
    setDedupeLinkOrg,
    orgsWithDedupeLink,
    dedupeLinkSweep,
    dedupeLinkSkips,
    ingestTicketLinkResults,
    orgColors,
    setOrgColor,
    // Per-repo importance tiers (XERK-487): the store and the read seams [E]'s
    // priority key and [F]'s allow/deny consume, plus the setter tests drive.
    repoTiers,
    repoTier,
    repoTierRank,
    isRepoIgnored,
    setRepoTier,
    DEFAULT_REPO_TIER,
    REPO_TIERS,
    ticketAgents,
    ticketModels,
    ticketModelPin,
    setTicketModel,
    orgModelAliases,
    ticketRuntimes,
    ticketRuntimePin,
    setTicketRuntime,
    orgOffersDsh,
    orgOffersQwen,
    findTicketHost,
    hostHasFreeSlot,
    // The hub-side ticket queue (XERK-296) — the array itself, so a test can see
    // what is waiting and in what order.
    ticketQueue,
    ticketQueuePayload,
    enqueueTicketStart,
    dropQueuedTicket,
    dropAutoQueuedTickets,
    drainTicketQueue,
    reclaimStrandedTicketSpawns,
    sanitizeRestoredCommands,
    queuedTicket,
    liveQueuedTicket,
    liveQueueCount,
    TICKET_QUEUE_NOTES_MAX,
    ticketDispatchedAt,
    holdQueued,
    ticketQueueAdmission,
    fleetTicketRows,
    TICKET_QUEUE_MAX,
    TICKET_QUEUE_PER_ORG_MAX,
    TICKET_QUEUE_PER_ORG_AUTO_MAX,
    TICKET_QUEUE_MAX_WAIT_MS,
    TICKET_QUEUE_EXPIRED_TTL_MS,
    logQueueState,
    TICKET_LOG_THROTTLE_MS,
    TICKET_QUEUE_ERROR_MAX,
    TICKET_QUEUE_STALE_MS,
    TICKET_QUEUE_BLOCKED_MAX_MS,
    // XERK-485 [E]: the triage gate, the priority key and the drain's visit
    // order, plus the org rate limit and its state — exported so a test can
    // hold each rule directly rather than only through a full sweep.
    triageGateReason,
    triageSortKey,
    ticketQueueOrder,
    TRIAGE_PRIORITY_RANK,
    TRIAGE_TYPE_WEIGHT,
    NO_PRIORITY_RANK,
    NO_TYPE_WEIGHT,
    TICKET_QUEUE_RATE_MAX,
    TICKET_QUEUE_RATE_WINDOW_MS,
    autoStartRate,
    recordAutoStartRate,
    refundAutoStartRate,
    migrations,
    advanceMigrations,
    // The relay spools bundles here rather than holding them in the record
    // (XERK-263); exported so a test can look at what is actually on disk.
    MIGRATE_SPOOL_DIR,
    sweepMigrationSpool,
    dropMigrationBlob,
    migrationSpoolPath,
    siteKeyOf,
    orgPeers,
    boundOrgOf,
    orgDrifted,
    orgDriftWarned,
    warnOrgDrift,
  };
} else if (process.argv[2] === "--agent-token") {
  // `node turma/server.js --agent-token <host>` prints the token that host's
  // agent must run with (XERK-268) — the value DockerOps sets as its TURMA_TOKEN.
  // Run it on the hub, where the master lives; nothing is started or bound.
  const host = process.argv[3];
  if (!host) {
    console.error("usage: node server.js --agent-token <host>   (the host name the agent reports as `device`)");
    process.exit(2);
  } else if (!TURMA_AGENT_TOKEN) {
    console.error("TURMA_AGENT_TOKEN is not set — there is no master to derive from");
    process.exit(2);
  } else {
    const token = hostAgentToken(host);
    if (!token) {
      // Say WHY. A blank line here sent the operator looking at the master, and
      // the failure it prevents (a reconnect loop with no mention of the name)
      // gives them nothing to go on either.
      console.error(`refusing to mint a token for ${JSON.stringify(host)}: the hub cannot register that host name, so its agent would rename itself and this token would never match`);
      process.exit(2);
    }
    console.log(token);
  }
} else {
  if (!TURMA_PASSWORD) console.warn("WARNING: TURMA_USER/TURMA_PASSWORD not set — UI is unauthenticated");
  if (!TURMA_AGENT_TOKEN) console.warn("WARNING: TURMA_AGENT_TOKEN not set — heartbeat and tunnel endpoints are unauthenticated");
  if (!TURMA_TRIGGER_TOKEN) console.warn("WARNING: TURMA_TRIGGER_TOKEN not set — POST /api/trigger accepts only the user login (no dedicated token)");
  // The fleet master proves only "some agent", never WHICH one, so until every
  // host runs on its own derived token and TURMA_AGENT_STRICT is set, a host is
  // still free to name another in `device` or a `<host>` segment (XERK-268).
  // Said at boot rather than left to the docs — a half-finished rollover looks
  // exactly like a finished one from the outside.
  if (TURMA_AGENT_TOKEN && !TURMA_AGENT_STRICT) {
    console.warn("WARNING: TURMA_AGENT_STRICT not set — the shared TURMA_AGENT_TOKEN is still accepted, so an agent can act as any host. Give each agent `node server.js --agent-token <host>` as its TURMA_TOKEN, then set TURMA_AGENT_STRICT=1");
  }
  server.listen(PORT, () => {
    console.log(`turma listening on :${PORT} (max ${MAX_CONNECTIONS} concurrent connections)`);
    // Every one of these is derived from the container limit, so print what they
    // came out as: it is the only way to tell a hub that is correctly sized from
    // one whose mem_limit moved under it, and it turns "why did that 503?" into
    // one `docker logs` (XERK-258, XERK-273).
    const mib = (n) => `${Math.round(n / (1 << 20))} MiB`;
    console.log(
      `memory limit ${mib(MEMORY_LIMIT)} -> body in-flight ${mib(BODY_INFLIGHT_MAX)}/request, ` +
        `${mib(BODY_INFLIGHT_TOTAL_MAX)} across both lanes; uploads held ` +
        `${mib(UPLOAD_TOTAL_MAX_BYTES)}; archive chunk ${archiveChunkLabel()} ` +
        `at ${ARCHIVE_PARSE_COST}x`
    );
    // The effective registry budget, printed for the same reason: it is DERIVED
    // from this container's own cgroup limit rather than configured, so without
    // this the only way to learn what the hub enforces is to be refused by it.
    console.log(
      `agent registry: <=${AGENTS_MAX} hosts, <=${AGENTS_TOTAL_MAX} bytes ` +
        `(${AGENT_FAIR_SHARE}/host), container limit ` +
        `${containerMemoryLimit() ?? "unknown"}`
    );
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
