"use strict";
// Tenant scoping of the hub's request surface (XERK-2534, epic XERK-2529).
//
// Pure: no server state. server.js builds a VIEW from the request principal and the
// live fleet (`viewFor` there) and hands it to the functions below:
//
//   view = {
//     mayHost(key)      -> whether the principal may see/drive that host key
//                          (server.js `principalMayDriveHost`: a tenant host only for
//                          its tenant's users; an untenanted host only for operators),
//     maySite(site)     -> whether the principal may see that org (server.js
//                          `principalMaySite`: an org key carries its tenant,
//                          `<siteKey>@<tenantId>`, XERK-2551),
//     repos / fleetRepos -> repo names the principal's hosts / ANY host reports,
//     seesUntenanted    -> the principal reaches untenanted (operator) data,
//   }
//
// A repo name carries no tenant, so a repo no host reports at all is ORPHAN data:
// the hub's operators' (the untenanted world, like an untenanted host).

// ---- The route table: every browser/API route the HTTP handler serves --------
// Default-deny: `classifyRoute` returns null for anything not listed, and the
// handler answers that 404 before any route runs. A new route needs a row here.
//
// Classes:
//   public        no login (login flow, health, assets)
//   agent         an agent credential bound to <host> (XERK-268); never a browser
//   automation    its own bearer (trigger token, Tenir's meetings token)
//   signed-in     any principal; serves no tenant data
//   host          <host> in the path: 404 unless the principal may drive it
//   org           <site> in the path: 404 unless an org of the principal
//   repo          <repo> in the path: 404 unless a repo of the principal
//   session       a live session id in the path: 404 unless its host is the principal's
//   transcript    <tid> in the path: 404 unless its host is the principal's
//   filtered      the handler filters what it returns to the principal
//
// A pattern segment `:x` matches any one segment; a trailing `*` any remainder.
const ROUTES = [
  // public
  ["GET", "/healthz", "public"], ["GET", "/readyz", "public"], ["GET", "/metrics", "public"],
  ["GET HEAD", "/login", "public"], ["GET HEAD", "/login.html", "public"],
  ["POST", "/api/login", "public"], ["POST", "/api/logout", "public"],
  ["GET", "/api/oidc/config", "public"], ["POST", "/api/oidc/mobile/exchange", "public"],
  ["GET", "/auth/oidc/login", "public"], ["GET", "/auth/oidc/callback", "public"],
  ["GET POST", "/auth/oidc/logout", "public"],
  ["GET HEAD", "/term-font.woff2", "public"],
  // agent transport
  ["POST", "/api/heartbeat", "agent"],
  ["GET", "/api/agent/token", "agent"], ["POST", "/api/agent/enroll", "agent"],
  ["POST", "/api/agents/:host/updating", "agent"], ["POST", "/api/agents/:host/alive", "agent"],
  ["POST", "/api/agents/:host/archive/:tid", "agent"],
  ["POST", "/api/agents/:host/archive/:tid/raw/:file", "agent"],
  ["GET POST", "/api/agents/:host/migrations/:id/blob", "agent"],
  ["GET", "/api/agents/:host/uploads/:id/blob", "agent"],
  ["GET", "/api/agents/:host/meetings/:run/transcript", "agent"],
  // automation
  ["POST", "/api/trigger", "automation"],
  ["POST", "/api/orgs/:site/meetings", "automation"],
  // pages (static shells: the data they show comes from the scoped routes)
  ["GET", "/", "signed-in"], ["GET", "/index.html", "signed-in"],
  ["GET", "/usage", "signed-in"], ["GET", "/usage.html", "signed-in"],
  ["GET", "/insights", "signed-in"], ["GET", "/insights.html", "signed-in"],
  ["GET", "/brief", "signed-in"], ["GET", "/brief.html", "signed-in"],
  ["GET", "/meetings", "signed-in"], ["GET", "/meetings.html", "signed-in"],
  ["GET", "/history", "signed-in"], ["GET", "/history.html", "signed-in"],
  ["GET", "/sessions", "signed-in"], ["GET", "/sessions.html", "signed-in"],
  ["GET", "/board", "signed-in"], ["GET", "/board.html", "signed-in"],
  // signed-in, no tenant data
  ["GET", "/api/ws-token", "signed-in"],
  // Who the caller is (XERK-2553): its own label + roles, never another tenant's data.
  ["GET", "/api/me", "signed-in"],
  // The caller's own tenant's Tenir token (XERK-2551; the handler 404s a principal with no tenant).
  ["GET POST", "/api/meetings-token", "signed-in"],
  // Push devices: a phone's own registration. WHICH alerts reach it is the push
  // partition's (XERK-2551).
  ["POST DELETE", "/api/devices", "signed-in"],
  // filtered by the handler
  ["GET", "/api/events", "filtered"], ["GET", "/api/agents", "filtered"],
  ["GET", "/api/permissions", "filtered"], ["GET", "/api/model-quality", "filtered"],
  ["GET", "/api/search", "filtered"], ["GET", "/api/archive", "filtered"],
  ["GET POST", "/api/enroll-codes", "filtered"], ["DELETE", "/api/enroll-codes/:id", "filtered"],
  ["POST", "/api/jira/refresh", "filtered"],
  // per host (the operator commands)
  ["POST", "/api/agents/:host/clone", "host"],
  ["POST", "/api/agents/:host/repos/:repo/prune", "host"],
  ["POST", "/api/agents/:host/restart", "host"],
  ["POST", "/api/agents/:host/roll-token", "host"],
  ["POST", "/api/agents/:host/revoke-name-token", "host"],
  ["POST", "/api/agents/:host/transcripts/:tid/resume", "host"],
  ["POST", "/api/agents/:host/uploads", "host"],
  ["GET POST DELETE PUT PATCH", "/api/agents/:host/sessions", "host"],
  ["GET POST DELETE PUT PATCH", "/api/agents/:host/sessions/*", "host"],
  ["DELETE", "/api/agents/:host", "host"],
  // per live session id (resolved to its host by the handler's lookup)
  ["GET HEAD", "/term/:sid/*", "session"], ["GET HEAD", "/term/:sid", "session"],
  // per transcript (the archive)
  ["GET", "/api/archive/:tid", "transcript"],
  ["POST", "/api/archive/:tid/restore", "transcript"],
  ["GET", "/api/archive/:tid/raw", "transcript"],
  ["GET", "/api/archive/:tid/raw/:file", "transcript"],
  ["GET", "/api/archive/:tid/trajectory", "transcript"],
  ["GET", "/api/dsh/:tid/trajectory", "transcript"],
  // per org
  ["GET", "/api/jira/:site/create-meta", "org"],
  ["POST", "/api/jira/:site/tickets", "org"], ["GET", "/api/jira/:site/tickets/:cmd", "org"],
  ["GET POST", "/api/jira/:site/permission-policy", "org"],
  ["POST", "/api/jira/:site/epic-builder", "org"],
  ["DELETE", "/api/jira/:site/epic-builder/:id", "org"],
  ["POST", "/api/jira/:site/autostart", "org"], ["POST", "/api/jira/:site/automerge", "org"],
  ["POST", "/api/jira/:site/priority-writeback", "org"],
  ["POST", "/api/jira/:site/dedupe-link", "org"],
  ["POST", "/api/jira/:site/triage-policy", "org"], ["POST", "/api/jira/:site/color", "org"],
  ["GET", "/api/jira/:site/:issue", "org"],
  ["GET POST", "/api/jira/:site/:issue/status", "org"],
  ["GET", "/api/jira/:site/:issue/priority", "org"],
  ["POST DELETE", "/api/jira/:site/:issue/session", "org"],
  ["POST", "/api/jira/:site/:issue/repo", "org"], ["POST", "/api/jira/:site/:issue/agent", "org"],
  ["POST", "/api/jira/:site/:issue/model", "org"], ["POST", "/api/jira/:site/:issue/runtime", "org"],
  ["POST", "/api/jira/:site/:issue/platform", "org"],
  ["POST", "/api/jira/:site/:issue/triage", "org"],
  ["POST", "/api/jira/:site/:issue/epic-run", "org"],
  ["POST", "/api/orgs/:site/meetings/:id/items/:item", "org"],
  ["POST", "/api/orgs/:site/decisions", "org"],
  ["POST", "/api/orgs/:site/daily-brief/run", "org"],
  ["GET PUT", "/api/orgs/:site/daily-brief/schedule", "org"],
  // per repo
  ["POST", "/api/repos/:repo/tier", "repo"],
];

// WebSocket upgrades (server.on("upgrade")), the same classes.
const UPGRADES = [
  ["/agent/control", "agent"], ["/agent/data", "agent"],
  ["/term/:sid/*", "session"], ["/term/:sid", "session"],
  ["/live/:host/:sid", "host"],
  ["/audio", "signed-in"],
];

const CLASSES = new Set(["public", "agent", "automation", "signed-in", "host", "session", "org",
  "repo", "transcript", "filtered"]);

function compile(pattern) {
  const segs = pattern.split("/").filter(Boolean);
  const rest = segs[segs.length - 1] === "*";
  return { segs: rest ? segs.slice(0, -1) : segs, rest };
}
const COMPILED = ROUTES.map(([methods, pattern, cls]) => ({
  methods: new Set(methods.split(" ")), pattern, cls, ...compile(pattern),
}));
const COMPILED_UPGRADES = UPGRADES.map(([pattern, cls]) => ({ pattern, cls, ...compile(pattern) }));

function matchSegs(c, parts) {
  if (c.rest ? parts.length <= c.segs.length : parts.length !== c.segs.length) return null;
  const params = {};
  for (let i = 0; i < c.segs.length; i++) {
    const s = c.segs[i];
    if (s.startsWith(":")) params[s.slice(1)] = parts[i];
    else if (s !== parts[i]) return null;
  }
  return params;
}

// `parts` are the RAW (still percent-encoded) path segments. Literal segments win
// over a parameter: the first matching row in table order whose literal segments
// match, preferring rows with more literals (so `/api/jira/refresh` is not an org).
function bestMatch(list, parts, method) {
  let best = null;
  for (const c of list) {
    if (method && !c.methods.has(method)) continue;
    const params = matchSegs(c, parts);
    if (!params) continue;
    const lits = c.segs.filter((s) => !s.startsWith(":")).length;
    if (!best || lits > best.lits) best = { cls: c.cls, pattern: c.pattern, params, lits };
  }
  return best && { cls: best.cls, pattern: best.pattern, params: best.params };
}

function classifyRoute(method, parts) {
  return bestMatch(COMPILED, parts, method === "HEAD" ? "HEAD" : method);
}
function classifyUpgrade(parts) {
  return bestMatch(COMPILED_UPGRADES, parts, null);
}

// ---- Scoping what a route serves ----------------------------------------------
function orgVisible(view, site) {
  return typeof site === "string" && view.maySite(site);
}
function repoVisible(view, repo) {
  if (typeof repo !== "string") return false;
  return view.repos.has(repo) || (view.seesUntenanted && !view.fleetRepos.has(repo));
}
// "<siteKey>/<issueKey>" (a siteKey may itself hold "/", an issue key never does).
function siteOfTicketKey(k) {
  const i = String(k).lastIndexOf("/");
  return i > 0 ? k.slice(0, i) : "";
}

function filterMap(m, keep) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return m;
  const out = Object.create(null);
  for (const [k, v] of Object.entries(m)) if (keep(k, v)) out[k] = v;
  return out;
}
const bySite = (view) => (m) => filterMap(m, (k) => orgVisible(view, k));
const byTicket = (view) => (m) => filterMap(m, (k) => orgVisible(view, siteOfTicketKey(k)));

// How each top-level key of the /api/agents payload, and each SSE event, is
// scoped. A key/event missing here is DROPPED for a scoped view (default-deny);
// the route-table test pins that every key the hub emits is listed.
const SCOPERS = {
  // hub-wide, no tenant data
  now: () => (v) => v,
  pushEnabled: () => (v) => v,
  error: () => (v) => v,
  // The routing policy is learned fleet-wide; whether it may be (XERK-2550 decides).
  modelPolicy: () => (v) => v,
  agents: (view) => (list) => Array.isArray(list) ? list.filter((a) => a && view.mayHost(a.key)) : list,
  retiredUsage: (view) => (list) => Array.isArray(list) ? list.filter((a) => a && view.mayHost(a.key)) : list,
  autoStartOrgs: bySite, autoMergeOrgs: bySite, priorityWriteBackOrgs: bySite,
  dedupeLinkOrgs: bySite, orgColors: bySite, triagePolicies: bySite,
  decisions: bySite, decisionCounts: bySite, dailyBriefSchedules: bySite,
  dailyBriefs: bySite, meetingProposals: bySite,
  ticketModels: byTicket, ticketRuntimes: byTicket, ticketPlatforms: byTicket,
  ticketTriageActions: byTicket, epicRuns: byTicket,
  ticketAgents: (view) => (m) => filterMap(m, (k, v) =>
    orgVisible(view, siteOfTicketKey(k)) && !(v && typeof v.host === "string" && !view.mayHost(v.host))),
  epicBuilders: (view) => (m) => filterMap(m, (_k, r) => !!r && orgVisible(view, r.siteKey) &&
    !(typeof r.host === "string" && r.host && !view.mayHost(r.host)) &&
    !(typeof r.targetHost === "string" && r.targetHost && !view.mayHost(r.targetHost))),
  ticketQueue: (view) => (list) => Array.isArray(list) ? list.filter((e) => e && orgVisible(view, e.siteKey)) : list,
  migrations: (view) => (list) => Array.isArray(list) ? list.filter((m) => m &&
    (m.srcHost == null || view.mayHost(m.srcHost)) && view.mayHost(m.targetHost)) : list,
  repoTiers: (view) => (m) => filterMap(m, (k) => repoVisible(view, k)),
};
// SSE events whose name is not their payload key.
const EVENT_ALIASES = { triageActions: "ticketTriageActions" };
const SINGLE_HOST_EVENTS = new Set(["agent", "removed"]);
// Events that carry a WHOLE scoped map or list (the view's full current value, not a
// delta): a frame identical to the last one a stream received for that event is
// redundant, so the hub skips it (rollup XERK-2593). Without it every stream got a
// frame whenever ANY org's map changed — another tenant's activity timing, and noise.
const SNAPSHOT_EVENTS = new Set(Object.keys(SCOPERS).concat(Object.keys(EVENT_ALIASES))
  .filter((e) => !["now", "pushEnabled", "error", "modelPolicy", "agents", "retiredUsage"].includes(e)));

// The payload a view may see. Returns `{out, changed}`; `changed` false means the
// caller may serve the unscoped bytes as they are.
function scopePayload(obj, view) {
  const out = {};
  let changed = false;
  for (const [k, v] of Object.entries(obj)) {
    const s = SCOPERS[k];
    if (!s) { changed = true; continue; }
    const nv = s(view)(v);
    if (sizeOf(nv) !== sizeOf(v)) changed = true;
    out[k] = nv;
  }
  return { out, changed };
}
function sizeOf(v) {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === "object") return Object.keys(v).length;
  return 0;
}

// One SSE frame for a view: the data to send, or undefined to send nothing.
function scopeEvent(event, data, view) {
  if (SINGLE_HOST_EVENTS.has(event)) {
    return data && typeof data.key === "string" && view.mayHost(data.key) ? data : undefined;
  }
  const s = SCOPERS[EVENT_ALIASES[event] || event];
  if (!s || event === "agents") return undefined;
  return s(view)(data);
}

module.exports = {
  ROUTES, UPGRADES, CLASSES, classifyRoute, classifyUpgrade,
  SCOPERS, EVENT_ALIASES, SINGLE_HOST_EVENTS, SNAPSHOT_EVENTS, scopePayload, scopeEvent,
  orgVisible, repoVisible, siteOfTicketKey,
};
