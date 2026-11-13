// Meetings triage (XERK-2510; the Brief page's one pane since XERK-2857): every
// org's meetings and daily briefs in a two-pane triage. The rail groups entries
// by org (collapsible) and date; the main pane works one entry at a time: a
// meeting's proposals, or a daily meeting's brief with that meeting's proposals.
// Each proposal is approved (a ticket on the org's board), edited then approved,
// or rejected by the operator; reviewed ones leave the list but stay reviewable.
//
// A shared module rather than a page: brief.html mounts it and feeds it the fleet
// snapshot, SSE frames included (update); it opens no stream and fetches no
// snapshot of its own. The brief's own sections and schedule editor are the
// page's (mount hooks), so their state and invariants stay in brief.html.
// Loaded after org.js (it reads TurmaOrg/TurmaBoard/TurmaNav); in server.js's
// HASHED_ASSETS. Tests: tests/meetings.test.js, tests/brief.test.js.
(() => {
// A host/org key for DISPLAY: board.js bareKey drops a tenant key's `@<32-hex>`
// suffix (XERK-2634). Handlers, maps and URLs keep the raw key.
function displayKey(k) {
  const B = typeof TurmaBoard !== "undefined" ? TurmaBoard : null;
  return B && B.bareKey ? B.bareKey(k) : String(k ?? "");
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}
function fmtWhen(ms) {
  return new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit" });
}
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtDay = (ms) => new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
// An org's entry in a served map, OWN keys only (an org may be named `__proto__`, XERK-1451).
const own = (map, k) => (map && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined);
const isTime = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
// An offset into the meeting as m:ss / h:mm:ss.
function clock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}
// The hub only stores an http(s) URL with no quote/space/bracket (meetingUrlOk);
// re-checked here so a link is never built from anything else.
const safeUrl = (u) => (typeof u === "string" && /^https?:\/\/[^\s"'<>`\\]+$/i.test(u) ? u : "");
// That moment in Tenir: a W3C media fragment on the meeting's own link.
function momentUrl(tenirUrl, atMs) {
  const u = safeUrl(tenirUrl);
  if (!u || !isTime(atMs + 1)) return "";
  return `${u.replace(/#.*$/, "")}#t=${Math.floor(atMs / 1000)}`;
}
const boardUrl = (site, key) => `/board?ticket=${encodeURIComponent(key)}&site=${encodeURIComponent(site)}`;
const KIND_LABEL = { task: "task", bug: "bug", followup: "follow-up", decision: "decision" };
// An item's (or meeting's, or entry's) key rides a data attribute, so it is
// URI-encoded parts joined by "/" (an HTML parser would turn a NUL into U+FFFD).
const itemKey = (site, mid, iid) => [site, mid, iid].map(encodeURIComponent).join("/");
const meetingKey = (site, mid) => [site, mid].map(encodeURIComponent).join("/");
const entryKey = (site, id) => [site, id].map(encodeURIComponent).join("/");
const splitKey = (k) => String(k).split("/").map(decodeURIComponent);
// A proposal can be (re)approved unless it is in flight or done.
const reviewable = (it) => !it.review || it.review.state === "failed" || it.review.state === "rejected";
// Awaiting the operator: a rejected one was answered.
const isPending = (it) => !!it && reviewable(it) && !(it.review && it.review.state === "rejected");
// Answered and out of the way: hidden behind "show reviewed", never greyed in place.
const isReviewed = (it) => !!it && !!it.review && ["created", "logged", "rejected"].includes(it.review.state);
const GEAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
  + `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

// ---- page state ------------------------------------------------------------------
let $list = null;
let hooks = {};                  // the host page's brief renderers (mount)
let cache = null;
let painted = null;
let paintPending = false;
let pointerDown = false;
const busy = new Set();          // item keys with a POST in flight
const itemErr = new Map();       // item key -> the hub's refusal
const edits = new Map();         // item key -> {title, description, issueType}
const meta = new Map();          // site -> {loading} | {projects} | {error}
const types = new Map();         // site\0project -> {loading} | {types} | {error}
const archBusy = new Set();      // meeting keys with an archive POST in flight
const archErr = new Map();       // meeting key -> the hub's refusal
const showReviewed = new Set();  // meeting keys whose reviewed proposals are shown
const FILTERS = [["review", "Needs review"], ["all", "All"], ["archived", "Archived"]];
let filter = "review";
let query = "";                  // the rail's search, as typed
let selected = null;             // entry key in the main pane
let curItem = null;              // item key the keyboard acts on
let curOrder = [];               // the item order curItem was last seen in (followCursor)
let selMemo = null;              // the selected entry's org, time, briefs and meetings (pickSelected)
let narrowMain = false;          // a phone shows the main pane, not the rail
let drawer = null;               // site whose settings drawer is open
// Per-viewer niceties in localStorage, every access guarded (private mode throws).
function loadStore(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v ?? fallback; } catch { return fallback; }
}
function saveStore(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* per-viewer nicety */ }
}
const PROJECT_STORE = "turma-meetings-project";
let projects = loadStore(PROJECT_STORE, {});
if (!projects || typeof projects !== "object" || Array.isArray(projects)) projects = {};
const COLLAPSE_STORE = "turma-meetings-collapsed";
const collapsed = new Set((() => { const v = loadStore(COLLAPSE_STORE, []); return Array.isArray(v) ? v.filter((s) => typeof s === "string") : []; })());
function setCollapsed(site, on) {
  if (on) collapsed.add(site); else collapsed.delete(site);
  saveStore(COLLAPSE_STORE, [...collapsed]);
}
function projectOf(site) {
  const m = meta.get(site);
  const list = (m && m.projects) || [];
  const saved = own(projects, site);
  if (saved && list.some((p) => p.key === saved)) return saved;
  return list.length === 1 ? list[0].key : "";
}
function setProject(site, key) {
  projects = { ...projects };
  Object.defineProperty(projects, site, { value: key, enumerable: true, writable: true, configurable: true });
  saveStore(PROJECT_STORE, projects);
}
// The issue type a proposal's kind maps to, among what the project offers.
function defaultType(kind, list) {
  if (!Array.isArray(list) || !list.length) return "";
  const by = (re) => list.find((t) => re.test(t.name || ""));
  const hit = (kind === "bug" && by(/bug/i)) || by(/^task$/i) || by(/task|story|issue/i) || list[0];
  return hit.id;
}
function typesOf(site) {
  const p = projectOf(site);
  return p ? types.get(`${site}\u0000${p}`) : null;
}

// What the ticket says by default: the proposal only. The meeting's title,
// date, quotes and Tenir link stay in Turma (XERK-2514): the ticket lands in
// the org's own tracker, where colleagues read it, and captions are not theirs to see.
function ticketDescription(_m, it) {
  return it.description || "";
}

// ---- entries ------------------------------------------------------------------------
// One rail entry per captured meeting, except the org's DAILY meeting: one entry
// per meetingAt, pairing the brief written for it with the meeting the hub marked
// daily (`daily.meetingAt` / `daily.briefRunId`, contract-meetings.md). The
// upcoming one comes from the hub's schedule `next` (hooks.nextOf), never computed here.
const nowMs = () => (hooks.now ? hooks.now() : Date.now());
function meetingsOf(data, site) {
  const l = own(data && data.meetingProposals, site);
  return Array.isArray(l) ? l.filter((m) => m && typeof m.meetingId === "string") : [];
}
function briefsOf(data, site) {
  const l = own(data && data.dailyBriefs, site);
  return Array.isArray(l) ? l.filter((b) => b && typeof b.runId === "string") : [];
}
const meetingPending = (m) => (m.status === "ok" ? (m.items || []).filter(isPending).length : 0);
function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function entriesOf(data, site, now) {
  const out = [];
  const daily = new Map();
  const dayEntry = (at) => {
    let e = daily.get(at);
    if (!e) { e = { id: `d:${at}`, site, daily: true, at, meetings: [], briefs: [], upcoming: null }; daily.set(at, e); }
    return e;
  };
  const briefs = briefsOf(data, site);
  const byRun = new Map(briefs.map((b) => [b.runId, b]));
  const claimed = new Set();
  for (const m of meetingsOf(data, site)) {
    const d = m.daily && typeof m.daily === "object" ? m.daily : null;
    if (d && isTime(d.meetingAt)) {
      const e = dayEntry(d.meetingAt);
      e.meetings.push(m);
      if (typeof d.briefRunId === "string" && byRun.has(d.briefRunId) && !claimed.has(d.briefRunId)) {
        claimed.add(d.briefRunId);
        e.briefs.push(byRun.get(d.briefRunId));
      }
    } else {
      const at = isTime(m.startedAt) ? m.startedAt : isTime(m.receivedAt) ? m.receivedAt : 0;
      out.push({ id: `m:${m.meetingId}`, site, daily: false, at, meetings: [m], briefs: [] });
    }
  }
  for (const b of briefs) {
    if (claimed.has(b.runId)) continue;
    const at = isTime(b.meetingAt) ? b.meetingAt : isTime(b.startedAt) ? b.startedAt : 0;
    if (at) dayEntry(at).briefs.push(b);
  }
  const next = hooks.nextOf ? hooks.nextOf(site) : null;
  if (next && isTime(next.meetingAt)) dayEntry(next.meetingAt).upcoming = next;
  for (const e of daily.values()) {
    // Served newest first; a linked brief joined out of order, so order again (stable).
    e.briefs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    out.push(e);
  }
  out.sort((a, b) => b.at - a.at);
  // The org's current daily entries: today's and any upcoming one (Run now lives
  // there); with none, the newest, so an org with only old briefs still has one.
  const today = startOfDay(now);
  let anyCurrent = false;
  for (const e of out) {
    e.key = entryKey(site, e.id);
    e.current = e.daily && e.at >= today;
    anyCurrent = anyCurrent || e.current;
    e.pending = e.meetings.reduce((n, m) => n + meetingPending(m), 0);
    e.inflight = e.meetings.some((m) => m.status === "queued" || m.status === "running");
    e.archived = e.meetings.length > 0 && e.meetings.every((m) => isTime(m.archivedAt));
  }
  if (!anyCurrent) { const d = out.find((e) => e.daily); if (d) d.current = true; }
  return out;
}
function bucketOf(at, now) {
  const d0 = startOfDay(now);
  if (at >= d0 + 864e5) return "Upcoming";
  if (at >= d0) return "Today";
  if (at >= startOfDay(d0 - 1)) return "Yesterday";
  if (at >= d0 - 6 * 864e5) return "This week";
  return "Earlier";
}
function matches(e, q) {
  if (!q) return true;
  const hay = [e.daily ? "daily meeting" : ""];
  for (const m of e.meetings) {
    hay.push(m.title || "");
    for (const it of m.items || []) if (it) hay.push(it.title || "");
  }
  return hay.join("\n").toLowerCase().includes(q);
}
function inFilter(e, f, sel) {
  if (f === "archived") return e.archived;
  if (e.archived) return false;
  if (f === "all") return true;
  // Needs review keeps the selected entry until the selection moves: an entry
  // whose last proposal was just answered never vanishes from under the pointer.
  return e.pending > 0 || e.inflight || e.current || e.key === sel;
}
function nameMap(data) {
  const names = new Map((TurmaBoard.mergeSites ? TurmaBoard.mergeSites(data.agents || []) : [])
    .map((x) => [x.siteKey, x.orgName]));
  return (s) => (TurmaBoard.orgName ? TurmaBoard.orgName(s, names.get(s)) : displayKey(s));
}
function orgSites(data) {
  const keys = TurmaOrg.getKeys();
  const set = new Set();
  for (const a of data.agents || []) if (a && typeof a.org === "string" && a.org) set.add(a.org);
  for (const map of [data.meetingProposals, data.dailyBriefs]) {
    if (!map || typeof map !== "object") continue;
    for (const s of Object.keys(map)) { const l = own(map, s); if (Array.isArray(l) && l.length) set.add(s); }
  }
  return [...set].filter((s) => !keys.length || keys.includes(s));
}
// Everything the pane shows, computed from the snapshot and the viewer's picks.
function buildView(data, sel = selected) {
  const now = nowMs();
  const name = nameMap(data);
  const q = query.trim().toLowerCase();
  const orgs = orgSites(data).map((site) => {
    const entries = entriesOf(data, site, now);
    return { site, name: name(site), entries,
      shown: entries.filter((e) => inFilter(e, filter, sel) && matches(e, q)),
      pending: entries.reduce((n, e) => n + (e.archived ? 0 : e.pending), 0) };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.site.localeCompare(b.site));
  const visible = q ? orgs.filter((o) => o.shown.length) : orgs;
  const flat = visible.filter((o) => !collapsed.has(o.site)).flatMap((o) => o.shown);
  // The selection stands while its entry is still in the list (a collapsed org
  // keeps it); else the first entry shown.
  const all = visible.flatMap((o) => o.shown);
  return { now, name, orgs, visible, flat, sel: pickSelected(all, flat, sel), q };
}
// The selected entry, or what took its place: an entry can be re-keyed under the
// viewer (a title-matched daily meeting claims a brief-only `d:<M>` entry), and
// jumping to the first entry of another org loses the operator's place. So: the
// entry now carrying its brief or meeting, else the nearest in time in its org.
function pickSelected(all, flat, sel) {
  const hit = all.find((e) => e.key === sel);
  if (hit || !sel || !selMemo || selMemo.key !== sel) return hit || flat[0] || null;
  const same = all.filter((e) => e.site === selMemo.site);
  const carries = same.find((e) => e.briefs.some((b) => selMemo.runIds.includes(b.runId))
    || e.meetings.some((m) => selMemo.meetingIds.includes(m.meetingId)));
  if (carries) return carries;
  const near = same.slice().sort((a, b) => Math.abs(a.at - selMemo.at) - Math.abs(b.at - selMemo.at))[0];
  return near || flat[0] || null;
}
function rememberSelected(e) {
  selMemo = e ? { key: e.key, site: e.site, at: e.at, runIds: e.briefs.map((b) => b.runId),
    meetingIds: e.meetings.map((m) => m.meetingId) } : null;
}
// The keyboard cursor follows its place, not its key: when the current proposal
// leaves the list (answered here, or an SSE frame saying so — the hub broadcasts
// BEFORE the POST answers), it moves to the one that took its place, the next
// still listed after it, else the one before. Clearing it made the next A act on
// the FIRST proposal — a ticket for the wrong one (QA).
function followCursor(order) {
  if (curItem && !order.includes(curItem)) {
    const i = curOrder.indexOf(curItem);
    const now = new Set(order);
    curItem = i < 0 ? null : (curOrder.slice(i + 1).find((k) => now.has(k))
      || curOrder.slice(0, i).reverse().find((k) => now.has(k)) || null);
  }
  curOrder = order;
}

// ---- render: one proposal ---------------------------------------------------------
function quotesHtml(m, it) {
  const qs = (it.quotes || []).filter((q) => q && q.text);
  if (!qs.length) return "";
  return `<ul class="mt-quotes">${qs.map((q) => {
    const at = isTime(q.atMs + 1) ? momentUrl(m.tenirUrl, q.atMs) : "";
    const link = at ? `<a href="${esc(at)}" target="_blank" rel="noopener noreferrer">▸ ${esc(clock(q.atMs))}</a>`
      : (isTime(q.atMs + 1) ? `<span class="mt-meta"> ${esc(clock(q.atMs))}</span>` : "");
    return `<li>${q.speaker ? `<span class="who">${esc(q.speaker)}:</span> ` : ""}“${esc(q.text)}”${link}</li>`;
  }).join("")}</ul>`;
}
function factsHtml(site, it) {
  const f = [];
  if (it.suggestedAssignee) f.push(`<span>Owner: ${esc(it.suggestedAssignee)}</span>`);
  if (it.due) f.push(`<span>Due: ${esc(it.due)}</span>`);
  if (it.repoGuess) f.push(`<span>Repo: ${esc(it.repoGuess)}</span>`);
  const dups = (it.duplicateKeys || []).map((k) => `<a href="${esc(boardUrl(site, k))}">${esc(k)}</a>`);
  if (dups.length) f.push(`<span>May duplicate ${dups.join(", ")}</span>`);
  return f.length ? `<div class="mt-facts">${f.join("")}</div>` : "";
}
function reviewStateHtml(site, it) {
  const r = it.review;
  if (!r) return "";
  if (r.state === "creating") return `<span class="state">Creating the ticket…</span>`;
  if (r.state === "logged") return `<span class="state good">✓ Added to the decisions log</span>`;
  if (r.state === "rejected") return `<span class="state">Rejected</span>`;
  if (r.state === "failed") return `<span class="state bad">Not created — ${esc(r.error || "the create failed")}</span>`;
  if (r.state === "created") {
    let s = `<span class="state good">✓ Created <a href="${esc(boardUrl(site, r.key))}">${esc(r.key)}</a></span>`;
    if (r.start) {
      const sess = r.session === "queued" ? "session starting"
        : r.session === "failed" ? `no session — ${r.sessionError || "it could not start"}`
          : "session starts once the board lists it with a repo";
      s += `<span class="state${r.session === "failed" ? " bad" : ""}">· ${esc(sess)}</span>`;
    }
    return s;
  }
  return "";
}
const kbd = (on, k) => (on ? ` <kbd class="mt-kbd" aria-hidden="true">${k}</kbd>` : "");
function editHtml(site, m, it, k) {
  const e = edits.get(k);
  const isDecision = it.kind === "decision";
  let typeSel = "";
  if (!isDecision) {
    const t = typesOf(site);
    const opts = t && t.types ? t.types.map((x) => `<option value="${esc(x.id)}"${x.id === e.issueType ? " selected" : ""}>${esc(x.name || x.id)}</option>`).join("") : "";
    typeSel = t && t.types
      ? `<label>Type <select data-edit-type="${esc(k)}">${opts}</select></label>`
      : `<div class="mt-meta">${t && t.error ? esc(t.error) : projectOf(site) ? "Loading issue types…" : "Pick a project above first."}</div>`;
  }
  const dis = busy.has(k) ? ' aria-disabled="true"' : "";
  return `<div class="mt-edit">`
    + `<label>Title <input data-edit-title="${esc(k)}" maxlength="200" value="${esc(e.title)}"></label>`
    + `<label>${isDecision ? "Detail" : "Description"} <textarea data-edit-desc="${esc(k)}"${isDecision ? ' maxlength="290"' : ""}>${esc(e.description)}</textarea></label>`
    + typeSel
    + `<div class="row"><button class="btn-sm primary" data-act="approve" data-k="${esc(k)}"${dis}>${isDecision ? "Log decision" : "Approve"}</button>`
    + (isDecision ? "" : `<button class="btn-sm" data-act="start" data-k="${esc(k)}"${dis}>Approve + start session</button>`)
    + `<button class="btn-sm" data-act="cancel" data-k="${esc(k)}">Cancel</button></div></div>`;
}
function itemHtml(site, m, it) {
  const k = itemKey(site, m.meetingId, it.id);
  const isDecision = it.kind === "decision";
  const state = it.review && it.review.state;
  const cur = k === curItem;
  const dis = busy.has(k) ? ' aria-disabled="true"' : "";
  let actions = "";
  if (edits.has(k) && reviewable(it) && state !== "rejected") {
    actions = editHtml(site, m, it, k);
  } else if (state === "rejected") {
    actions = `<button class="btn-sm" data-act="reopen" data-k="${esc(k)}"${dis}>${busy.has(k) ? "Working…" : "Reopen"}</button>`;
  } else if (reviewable(it)) {
    actions = `<button class="btn-sm primary" data-act="approve" data-k="${esc(k)}"${dis}>${busy.has(k) ? "Working…" : isDecision ? "Log decision" : "Approve"}${kbd(cur, "A")}</button>`
      + (isDecision ? "" : `<button class="btn-sm" data-act="start" data-k="${esc(k)}"${dis}>Approve + start session${kbd(cur, "S")}</button>`)
      + `<button class="btn-sm" data-act="edit" data-k="${esc(k)}"${dis}>Edit${kbd(cur, "E")}</button>`
      + `<button class="btn-sm" data-act="reject" data-k="${esc(k)}"${dis}>Reject${kbd(cur, "R")}</button>`
      + (state === "failed" ? `<button class="btn-sm" data-act="reopen" data-k="${esc(k)}"${dis}>Reopen</button>` : "");
  }
  const review = reviewStateHtml(site, it);
  const err = itemErr.get(k);
  const editing = edits.has(k) && reviewable(it) && state !== "rejected";
  return `<li class="mt-item${state === "rejected" ? " rejected" : ""}${cur ? " cur" : ""}" data-item="${esc(k)}">`
    + `<div class="mt-item-head"><span class="mt-kind ${esc(it.kind)}">${esc(KIND_LABEL[it.kind] || it.kind)}</span>`
    + `<span class="mt-item-title">${esc(it.title)}</span></div>`
    + (it.description ? `<p class="mt-desc">${esc(it.description)}</p>` : "")
    + factsHtml(site, it) + quotesHtml(m, it)
    + (editing ? `${review ? `<div class="mt-review">${review}</div>` : ""}${actions}`
      : (review || actions ? `<div class="mt-review">${review}${actions}</div>` : ""))
    + (err ? `<div class="mt-err">${esc(err)}</div>` : "")
    + `</li>`;
}

// ---- render: one meeting -----------------------------------------------------------
function needsProject(list) {
  return list.some((m) => m.status === "ok" && (m.items || []).some((it) => it.kind !== "decision" && reviewable(it)));
}
function targetHtml(site) {
  const m = meta.get(site);
  if (!m || m.loading) return `<div class="mt-target">New tickets go to … <span class="mt-meta">loading projects</span></div>`;
  if (m.error) return `<div class="mt-target">New tickets go to … <span class="err">${esc(m.error)}</span> <button class="btn-sm" data-meta-retry="${esc(site)}">Retry</button></div>`;
  const cur = projectOf(site);
  const opts = (cur ? "" : `<option value="">Pick a project</option>`)
    + m.projects.map((p) => `<option value="${esc(p.key)}"${p.key === cur ? " selected" : ""}>${esc(p.name ? `${p.name} (${p.key})` : p.key)}</option>`).join("");
  return `<label class="mt-target">New tickets go to <select data-project="${esc(site)}">${opts}</select></label>`;
}
function archiveButton(site, m) {
  // A meeting still being read can't be archived (the hub's 409); no button then.
  if (m.status !== "ok" && m.status !== "failed") return "";
  const mk = meetingKey(site, m.meetingId);
  const arch = isTime(m.archivedAt);
  const b = archBusy.has(mk);
  return `<button class="btn-sm" data-archive="${esc(mk)}" data-to="${arch ? "false" : "true"}" aria-disabled="${b}">`
    + `${b ? "Working…" : arch ? "Unarchive" : "Archive meeting"}</button>`;
}
function meetingMeta(m, orgName) {
  const bits = [];
  if (orgName) bits.push(orgName);
  if (m.platform) bits.push(m.platform);
  if (isTime(m.startedAt)) bits.push(fmtWhen(m.startedAt));
  if (isTime(m.startedAt) && isTime(m.endedAt) && m.endedAt > m.startedAt) {
    bits.push(`${Math.max(1, Math.round((m.endedAt - m.startedAt) / 60000))} min`);
  }
  const ppl = (m.participants || []).length;
  if (ppl) bits.push(`${ppl} participant${ppl === 1 ? "" : "s"}`);
  if (isTime(m.archivedAt)) bits.push("archived");
  return bits.map((b, i) => `<span class="bit${i < bits.length - 1 ? " sep" : ""}">${esc(b)}</span>`).join("");
}
// `primary`: the entry IS this meeting (its title heads the pane, with the back
// button); else it sits under a daily meeting's brief.
function meetingHtml(site, m, { primary = false, orgName = "", back = "" } = {}) {
  const url = safeUrl(m.tenirUrl);
  const link = url ? `<a class="mt-tenir" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open in Tenir ↗</a>` : "";
  const mk = meetingKey(site, m.meetingId);
  const tools = `<span class="mt-tools">${link}${archiveButton(site, m)}</span>`;
  const head = primary
    ? `<div class="tri-head">${back}<h2 class="tri-title">${esc(m.title || "Untitled meeting")}</h2>${tools}</div>`
    : `<div class="mt-head"><h3 class="mt-title">${esc(m.title || "Untitled meeting")}</h3>${tools}</div>`;
  const aerr = archErr.get(mk);
  let body;
  if (m.status === "queued") body = `<div class="mt-status">Waiting for a host of this org to read the captions…</div>`;
  else if (m.status === "running") body = `<div class="mt-status">Reading the captions${m.host ? ` on ${esc(displayKey(m.host))}` : ""}…</div>`;
  else if (m.status === "failed") body = `<div class="mt-status failed">Could not propose work items — ${esc(m.error || "the run failed")}</div>`;
  else if (!(m.items || []).length) body = `<div class="mt-status">Nothing to propose from this meeting.</div>`;
  else {
    const items = m.items;
    const done = items.filter(isReviewed);
    const open = items.filter((it) => !isReviewed(it));
    const pct = Math.round((done.length / items.length) * 100);
    const showing = showReviewed.has(mk);
    const tickets = done.filter((it) => it.review.state === "created").length;
    const rejected = done.filter((it) => it.review.state === "rejected").length;
    const sums = [`${done.length} of ${items.length} reviewed`];
    if (tickets) sums.push(`${tickets} ticket${tickets === 1 ? "" : "s"}`);
    if (rejected) sums.push(`${rejected} rejected`);
    body = `<div class="mt-prog" role="progressbar" aria-label="Reviewed" aria-valuemin="0" aria-valuemax="${items.length}" aria-valuenow="${done.length}"><i style="width:${pct}%"></i></div>`
      + `<div class="mt-progtext">${esc(sums.join(" · "))}`
      + (done.length ? ` · <button type="button" class="linkish" data-show-reviewed="${esc(mk)}" aria-expanded="${showing}">${showing ? "hide reviewed" : `show reviewed (${done.length})`}</button>` : "")
      + `</div>`
      + (needsProject([m]) ? targetHtml(site) : "")
      + (open.length ? `<ul class="mt-items">${open.map((it) => itemHtml(site, m, it)).join("")}</ul>`
        : `<div class="mt-status">Every proposal is reviewed.</div>`)
      + (showing && done.length ? `<ul class="mt-items mt-done" aria-label="Reviewed">${done.map((it) => itemHtml(site, m, it)).join("")}</ul>` : "");
  }
  return `<section class="mt-meeting${primary ? " primary" : ""}">${head}`
    + `<div class="mt-meta">${meetingMeta(m, orgName)}</div>`
    + (aerr ? `<div class="mt-err">${esc(aerr)}</div>` : "")
    + body + `</section>`;
}

// ---- render: the rail ---------------------------------------------------------------
function entryTitle(e) {
  return e.daily ? "Daily meeting" : (e.meetings[0].title || "Untitled meeting");
}
function entryWhen(e, now) {
  if (!isTime(e.at)) return "";
  const b = bucketOf(e.at, now);
  return b === "Today" ? fmtTime(e.at) : b === "Upcoming" || b === "Yesterday" ? `${fmtDay(e.at).split(",")[0]} ${fmtTime(e.at)}` : fmtDay(e.at);
}
function entrySide(e) {
  if (e.pending) return `<span class="tri-count" aria-label="${e.pending} to review">${e.pending}</span>`;
  if (e.inflight) return `<span class="tri-note">reading…</span>`;
  if (e.daily && !e.meetings.length) {
    const head = e.briefs[0];
    if (head && head.status === "running") return `<span class="tri-note">writing brief…</span>`;
    if (head && head.status === "failed" && !e.briefs.some((b) => b.status === "ok")) return `<span class="tri-note bad">brief failed</span>`;
    if (e.briefs.some((b) => b.status === "ok")) return `<span class="tri-note">brief</span>`;
    if (e.upcoming && isTime(e.upcoming.runAt)) return `<span class="tri-note">brief ${esc(fmtTime(e.upcoming.runAt))}</span>`;
    return "";
  }
  const m = e.meetings[0];
  if (e.meetings.length === 1 && m.status === "failed") return `<span class="tri-note bad">failed</span>`;
  if (e.meetings.every((x) => !(x.items || []).length)) return `<span class="tri-note">nothing proposed</span>`;
  return `<span class="tri-note good" aria-label="all reviewed">✓</span>`;
}
function entryHtml(e, sel, now) {
  const on = sel && sel.key === e.key;
  return `<button type="button" class="tri-entry${on ? " sel" : ""}${!e.pending && !e.inflight && !e.current ? " done" : ""}" data-entry="${esc(e.key)}"${on ? ' aria-current="true"' : ""}>`
    + `<span class="t">${esc(entryTitle(e))}</span><span class="w">${esc(entryWhen(e, now))}</span>`
    + `<span class="sp"></span>${entrySide(e)}</button>`;
}
function orgRailHtml(o, v) {
  const open = !collapsed.has(o.site);
  let body = "";
  if (open) {
    let last = "";
    for (const e of o.shown) {
      const b = bucketOf(e.at, v.now);
      if (b !== last) { body += `<div class="tri-sec">${esc(b)}</div>`; last = b; }
      body += entryHtml(e, v.sel, v.now);
    }
    if (!o.shown.length) {
      body = `<div class="tri-none">${filter === "review" ? "Nothing to review" : filter === "archived" ? "Nothing archived" : "No meetings yet"}</div>`;
    }
  }
  return `<div class="tri-org${open ? "" : " closed"}"><div class="tri-org-head">`
    + `<button type="button" class="tri-org-toggle" data-org-toggle="${esc(o.site)}" aria-expanded="${open}">`
    + `<span class="car" aria-hidden="true">${open ? "▾" : "▸"}</span><span class="nm">${esc(o.name)}</span></button>`
    + (o.pending ? `<span class="tri-count" aria-label="${o.pending} to review">${o.pending}</span>` : "")
    + `<button type="button" class="tri-gear" data-org-settings="${esc(o.site)}" aria-expanded="${drawer === o.site}"`
    + ` aria-label="Meeting settings for ${esc(o.name)}" title="Settings">${GEAR_SVG}</button>`
    + `</div>${body}</div>`;
}
function railHtml(v) {
  const tools = `<input type="search" class="tri-search" data-search="1" value="${esc(query)}" placeholder="Search meetings and proposals" aria-label="Search meetings and proposals" autocomplete="off">`
    + `<div class="tri-filters" role="group" aria-label="Show">${FILTERS.map(([f, label]) =>
      `<button type="button" class="tri-chip${f === filter ? " on" : ""}" data-filter="${f}" aria-pressed="${f === filter}">${label}</button>`).join("")}</div>`;
  const orgs = v.visible.length ? v.visible.map((o) => orgRailHtml(o, v)).join("")
    : `<div class="tri-none">${v.q ? `Nothing matches “${esc(query.trim())}”.` : "No org yet."}</div>`;
  return tools + orgs;
}

// ---- render: the main pane ----------------------------------------------------------
function mainHtml(v) {
  const back = `<button type="button" class="btn-sm tri-back" data-back="1" aria-label="Back to the list">‹ Back</button>`;
  const e = v.sel;
  if (!e) {
    return `<div class="tri-head">${back}</div><div class="mt-empty">${filter === "review"
      ? "Nothing needs review. When Tenir sends a meeting, its proposed work items show up here."
      : filter === "archived" ? "No archived meetings." : "No meetings yet."}</div>`;
  }
  const orgName = v.name(e.site);
  if (!e.daily) return meetingHtml(e.site, e.meetings[0], { primary: true, orgName, back });
  const now = v.now;
  const brief = hooks.briefHtml ? hooks.briefHtml(e.site, e) : "";
  const meetings = e.meetings.length ? e.meetings.map((m) => meetingHtml(e.site, m)).join("")
    : `<div class="mt-status">${e.at > now
      ? "Its proposals land here once Tenir sends the meeting."
      : "No meeting was captured for this one."}</div>`;
  return `<div class="tri-head">${back}<h2 class="tri-title">Daily meeting</h2>`
    + `<span class="tri-sub">${esc(orgName)} · ${esc(isTime(e.at) ? fmtWhen(e.at) : "")}</span></div>`
    + `<div class="tri-brief">${brief}</div>`
    + `<h3 class="tri-h">Proposals</h3>${meetings}`;
}

// ---- Tenir labels (XERK-2638) ---------------------------------------------------------
// Tenir names each meeting window's org by a short label; the hub maps it to the
// org (`meetingLabels`) and lists the labels it could not map (`meetingLabelMisses`).
const LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const labelDrafts = new Map();   // site -> the label being typed
const labelBusy = new Set();     // site with a label POST in flight
const labelErr = new Map();      // site -> the hub's refusal
const missPick = new Map();      // miss key -> the org picked for it
const missLabel = (k) => String(k).replace(/@[0-9a-f]{32}$/, "");
// Org names as the label UI shows them: two orgs with one name get their site too.
function labelNamer(orgs, name) {
  const count = new Map();
  for (const s of orgs) count.set(name(s), (count.get(name(s)) || 0) + 1);
  const site = (s) => String(s).replace(/@[0-9a-f]{32}$/, "");
  return (s) => (count.get(name(s)) > 1 ? `${name(s)} (${site(s)})` : name(s));
}
function labelOrgs(data) {
  const keys = TurmaOrg.getKeys();
  const map = data && data.meetingLabels && typeof data.meetingLabels === "object" ? data.meetingLabels : {};
  return Object.keys(map).filter((s) => own(map, s) && typeof own(map, s).label === "string"
    && (!keys.length || keys.includes(s))).sort();
}
// Every label Tenir sent that no org has: ONE banner on top, a row per label.
function missesHtml(data, baseName) {
  const map = data && data.meetingLabelMisses && typeof data.meetingLabelMisses === "object" ? data.meetingLabelMisses : {};
  const orgs = labelOrgs(data);
  if (!orgs.length) return "";
  const name = labelNamer(orgs, baseName);
  const rows = Object.keys(map).filter((k) => LABEL_RE.test(missLabel(k))).sort().map((k) => {
    const label = missLabel(k), m = own(map, k) || {};
    const what = m.shared
      ? `Tenir sent a meeting for <b>${esc(label)}</b>, which more than one org answers to.`
      : `Tenir sent a meeting for <b>${esc(label)}</b>, which no org has. It keeps retrying.`;
    const pick = missPick.get(k) || "";
    const opts = `<option value="">Pick the org</option>` + orgs.map((s) =>
      `<option value="${esc(s)}"${s === pick ? " selected" : ""}>${esc(name(s))}</option>`).join("");
    const busy = pick && labelBusy.has(pick);
    return `<div class="mt-miss"><span class="what">${what}</span>`
      + `<select data-miss="${esc(k)}" aria-label="Org for ${esc(label)}">${opts}</select>`
      + `<button class="btn-sm" data-miss-use="${esc(k)}" aria-disabled="${!pick || busy ? "true" : "false"}">Use this label</button>`
      + (pick && labelErr.has(pick) ? `<span class="mt-err-inline">${esc(labelErr.get(pick))}</span>` : "")
      + `</div>`;
  }).join("");
  return rows ? `<div class="mt-misses" role="status">${rows}</div>` : "";
}
function labelRowHtml(data, s) {
  const cur = own(data.meetingLabels, s);
  const v = labelDrafts.has(s) ? labelDrafts.get(s) : cur.label;
  const busy = labelBusy.has(s) ? "true" : "false";
  return `<div class="mt-label-row">`
    + `<input data-label="${esc(s)}" value="${esc(v)}" maxlength="40" spellcheck="false" autocomplete="off" placeholder="no label" aria-label="Tenir label">`
    + `<button class="btn-sm" data-label-save="${esc(s)}" aria-disabled="${busy}">Save</button>`
    + (cur.custom ? `<button class="btn-sm" data-label-reset="${esc(s)}" aria-disabled="${busy}" title="Go back to the default label">Reset</button>`
      : `<span class="def">${cur.label ? "default" : "no label — give it one"}</span>`)
    + (labelErr.has(s) ? `<span class="mt-err-inline">${esc(labelErr.get(s))}</span>` : "")
    + `</div>`;
}
async function saveLabel(site, label) {
  if (labelBusy.has(site)) return false;
  if (label !== null && !LABEL_RE.test(label)) {
    labelErr.set(site, "Use 1-40 lowercase letters, digits, - or _");
    repaint(true);
    return false;
  }
  labelBusy.add(site);
  labelErr.delete(site);
  repaint(true);
  let res = null, out = {};
  try {
    res = await fetch(`/api/orgs/${encodeURIComponent(site)}/meeting-label`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }) });
    try { out = await res.json(); } catch { out = {}; }
  } catch { res = null; }
  labelBusy.delete(site);
  const ok = !!(res && res.ok);
  if (!ok) {
    const text = res ? TurmaNav.refusalText("Saving the label", res.status, out) : "Saving the label failed — the hub is unreachable";
    labelErr.set(site, text);
    TurmaNav.toast(text);
  } else {
    labelDrafts.delete(site);
    if (cache && out && typeof out.label === "string") {
      cache.meetingLabels = { ...(cache.meetingLabels || {}) };
      Object.defineProperty(cache.meetingLabels, site, { value: { label: out.label, custom: !!out.custom },
        enumerable: true, writable: true, configurable: true });
    }
  }
  repaint(true);
  return ok;
}

// ---- Whose work (XERK-2514) ------------------------------------------------------
// Per org: the operator's names as captions spell them and their role. The agent
// proposes only their work, so a standup doesn't turn everyone's status into items.
const focusDrafts = new Map();   // site -> {names, role} being typed
const focusBusy = new Set();
const focusErr = new Map();
function focusOf(data, s) {
  const f = own(data && data.meetingFocus, s);
  return f && Array.isArray(f.names) ? { names: f.names.join(", "), role: String(f.role || "") }
    : { names: "", role: "" };
}
function focusRowHtml(data, s) {
  const v = focusDrafts.get(s) || focusOf(data, s);
  const busy = focusBusy.has(s) ? "true" : "false";
  return `<div class="mt-label-row">`
    + `<input class="mt-focus-names" data-focus-names="${esc(s)}" value="${esc(v.names)}" maxlength="520" autocomplete="off" placeholder="Your name(s), comma-separated" aria-label="Your names in this org's meetings">`
    + `<input class="mt-focus-role" data-focus-role="${esc(s)}" value="${esc(v.role)}" maxlength="300" autocomplete="off" placeholder="Your role" aria-label="Your role in this org">`
    + `<button class="btn-sm" data-focus-save="${esc(s)}" aria-disabled="${busy}">Save</button>`
    + (own(data.meetingFocus, s) ? `<button class="btn-sm" data-focus-clear="${esc(s)}" aria-disabled="${busy}" title="Propose everyone's work again">Clear</button>`
      : `<span class="def">everyone's work</span>`)
    + (focusErr.has(s) ? `<span class="mt-err-inline">${esc(focusErr.get(s))}</span>` : "")
    + `</div>`;
}
async function saveFocus(site, names, role) {
  if (focusBusy.has(site)) return false;
  const list = String(names || "").split(",").map((n) => n.trim()).filter(Boolean);
  if (list.length > 5) {
    focusErr.set(site, "At most 5 names");
    repaint(true);
    return false;
  }
  focusBusy.add(site);
  focusErr.delete(site);
  repaint(true);
  let res = null, out = {};
  try {
    res = await fetch(`/api/orgs/${encodeURIComponent(site)}/meeting-focus`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ names: list, role: String(role || "").trim() }) });
    try { out = await res.json(); } catch { out = {}; }
  } catch { res = null; }
  focusBusy.delete(site);
  const ok = !!(res && res.ok);
  if (!ok) {
    const text = res ? TurmaNav.refusalText("Saving whose work", res.status, out) : "Saving whose work failed — the hub is unreachable";
    focusErr.set(site, text);
    TurmaNav.toast(text);
  } else {
    focusDrafts.delete(site);
    if (cache) {
      const m = { ...(cache.meetingFocus || {}) };
      if (out && out.focus) Object.defineProperty(m, site, { value: out.focus, enumerable: true, writable: true, configurable: true });
      else delete m[site];
      cache.meetingFocus = m;
    }
  }
  repaint(true);
  return ok;
}

// ---- the settings drawer (one org) ---------------------------------------------------
function drawerHtml(data, v) {
  if (!drawer) return "";
  const site = drawer;
  const orgName = v.name(site);
  const labeled = !!own(data.meetingLabels, site) && typeof own(data.meetingLabels, site).label === "string";
  const sec = (title, body, hint = "") => `<div class="tri-dsec"><div class="tri-dlabel">${title}</div>${body}${hint ? `<p class="mt-labels-hint">${hint}</p>` : ""}</div>`;
  const sched = hooks.scheduleHtml ? hooks.scheduleHtml(site) : "";
  return `<aside class="tri-drawer" role="dialog" aria-label="Meeting settings for ${esc(orgName)}">`
    + `<div class="tri-drawer-head"><div class="tri-drawer-title"><h2>${esc(orgName)} — meeting settings</h2>`
    + `<div class="mt-meta">${esc(displayKey(site))}</div></div>`
    + `<button type="button" class="btn-sm" data-drawer-close="1" aria-label="Close settings">✕</button></div>`
    + sec("New tickets go to", targetHtml(site))
    + (labeled ? sec("Whose work", focusRowHtml(data, site),
      "Only work for you (by name, as the captions show it) or your role is proposed. Empty proposes everyone's.") : "")
    + (labeled ? sec("Tenir label", labelRowHtml(data, site),
      "This org's label in the meeting PC's capture.json (<code>\"org\"</code>).") : "")
    + (sched ? sec("Daily brief", sched) : "")
    + `</aside>`;
}

// ---- paint -----------------------------------------------------------------------------
function editing() {
  const a = document.activeElement;
  return !!a && $list.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName || "");
}
// What has focus, as keys that survive the swap: the page's own (hooks) first,
// else one of this pane's controls by its data attribute.
const FOCUS_ATTRS = ["search", "filter", "orgToggle", "orgSettings", "entry", "showReviewed", "archive",
  "drawerClose", "back", "labelSave", "labelReset", "focusSave", "focusClear", "missUse", "metaRetry"];
function focusKey() {
  if (hooks.focusKey) { const k = hooks.focusKey(); if (k) return { page: k }; }
  const a = document.activeElement;
  const ds = a && a.dataset;
  if (!ds || !$list.contains(a)) return null;
  if (ds.act !== undefined) return { attr: "k", v: ds.k, act: ds.act };
  const attr = FOCUS_ATTRS.find((x) => ds[x] !== undefined);
  if (!attr) return null;
  let range = null;
  try { if (attr === "search") range = [a.selectionStart, a.selectionEnd]; } catch { /* no selection API */ }
  return { attr, v: ds[attr], range };
}
function restoreFocus(key) {
  if (!key) return;
  if (key.page) return void (hooks.restoreFocus && hooks.restoreFocus(key.page));
  const el = [...$list.querySelectorAll("button,input")].find((x) => x.dataset && x.dataset[key.attr] === key.v
    && (key.act === undefined || x.dataset.act === key.act));
  if (!el || !el.focus) return;
  el.focus();
  if (key.range && el.setSelectionRange) { try { el.setSelectionRange(key.range[0], key.range[1]); } catch { /* fine */ } }
}
function renderMeetings(data, force = false) {
  if (!$list) return;
  if (pointerDown || (!force && editing())) { paintPending = true; return; }
  paintPending = false;
  const v = buildView(data);
  selected = v.sel ? v.sel.key : null;
  rememberSelected(v.sel);
  // The org's projects are fetched only where an Approve may need one.
  if (v.sel && needsProject(v.sel.meetings)) ensureMeta(v.sel.site);
  if (drawer) ensureMeta(drawer);
  followCursor(itemOrder(v));
  const full = missesHtml(data, v.name)
    + `<div class="tri${narrowMain && v.sel ? " show-main" : ""}">`
    + `<nav class="tri-rail" aria-label="Meetings by org">${railHtml(v)}</nav>`
    + `<section class="tri-main" aria-label="Selected meeting">${mainHtml(v)}</section></div>`
    + drawerHtml(data, v);
  if (full === painted) return;
  painted = full;
  const focus = focusKey();
  TurmaNav.preserveScroll($list, () => { $list.innerHTML = full; });
  restoreFocus(focus);
}
const repaint = (force = false) => { if (cache) { painted = null; renderMeetings(cache, force); } };

// ---- the org's projects / types (the New-ticket modal's routes, XERK-137) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchMeta(site, project) {
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  const url = `/api/jira/${encodeURIComponent(site)}/create-meta${q}`;
  for (let i = 0; i < 25; i++) {
    let r;
    try { r = await fetch(url); } catch { return { error: "the hub is unreachable" }; }
    if (r.status === 401) { location.href = "/login"; return { error: "signed out" }; }
    if (r.status === 202) { await sleep(1500); continue; }
    let d = {};
    try { d = await r.json(); } catch { /* non-JSON */ }
    if (!r.ok || d.error) return { error: d.error || `the hub answered HTTP ${r.status}` };
    return d;
  }
  return { error: "the host didn't answer in time" };
}
function ensureMeta(site) {
  if (meta.has(site)) return void ensureTypes(site);
  meta.set(site, { loading: true });
  fetchMeta(site, "").then((d) => {
    meta.set(site, d.error ? { error: d.error } : { projects: Array.isArray(d.projects) ? d.projects : [] });
    ensureTypes(site);
    repaint();
  });
}
function ensureTypes(site) {
  const p = projectOf(site);
  if (!p) return null;
  const k = `${site}\u0000${p}`;
  if (types.has(k) && !types.get(k).error) return types.get(k).promise || Promise.resolve();
  const promise = fetchMeta(site, p).then((d) => {
    types.set(k, d.error ? { error: d.error } : { types: Array.isArray(d.types) ? d.types : [] });
    repaint();
  });
  types.set(k, { loading: true, promise });
  return promise;
}

// ---- review actions ------------------------------------------------------------------
function findItem(k) {
  const [site, mid, iid] = splitKey(k);
  const list = cache && own(cache.meetingProposals, site);
  const m = Array.isArray(list) && list.find((x) => x.meetingId === mid);
  const it = m && (m.items || []).find((x) => x.id === iid);
  return it ? { site, m, it } : null;
}
function failItem(k, text) {
  itemErr.set(k, text);
  TurmaNav.toast(text);
}
// The keyboard's items: the selected entry's proposals still in the main list.
function itemOrder(v) {
  const e = v && v.sel;
  if (!e) return [];
  const out = [];
  for (const m of e.meetings) {
    if (m.status !== "ok") continue;
    for (const it of m.items || []) if (it && !isReviewed(it) && reviewable(it)) out.push(itemKey(e.site, m.meetingId, it.id));
  }
  return out;
}
// The selection moves on from an entry the operator just finished (its last
// proposal answered, or it was archived): the next entry, else the one before.
function advanceFrom(oldKey, beforeKeys) {
  const v = buildView(cache, null);
  const keys = new Set(v.flat.map((e) => e.key));
  if (keys.has(oldKey)) return;
  const i = beforeKeys.indexOf(oldKey);
  selected = beforeKeys.slice(i + 1).find((k) => keys.has(k))
    || beforeKeys.slice(0, Math.max(0, i)).reverse().find((k) => keys.has(k)) || null;
  curItem = null;
}
async function review(k, action, start = false) {
  if (busy.has(k)) return;
  const hit = findItem(k);
  if (!hit) return;
  const { site, m, it } = hit;
  // Busy from the first await, not the POST (XERK-2511 QA): while the project's
  // types load, a second press — a Reject — must not post first and then be
  // overtaken by this Approve, creating a ticket the operator rejected.
  busy.add(k);
  repaint(true);
  const fail = (text) => { busy.delete(k); failItem(k, text); repaint(true); };
  const body = { action };
  if (action === "approve") {
    const e = edits.get(k);
    body.title = e ? e.title : it.title;
    if (e && (e.title !== e.initial.title || e.description !== e.initial.description)) body.edited = true;
    body.description = e ? e.description : (it.kind === "decision" ? it.description : ticketDescription(m, it));
    if (it.kind !== "decision") {
      const project = projectOf(site);
      if (!project) return void fail("Pick a project for new tickets first");
      await ensureTypes(site);
      const t = types.get(`${site}\u0000${project}`) || {};
      if (t.error) return void fail(`Approving failed — ${t.error}`);
      const issueType = (e && e.issueType) || defaultType(it.kind, t.types);
      if (!issueType) return void fail("That project offers no issue type to create");
      body.project = project;
      body.issueType = issueType;
      if (start) body.start = true;
    }
  }
  itemErr.delete(k);
  repaint(true);
  const what = action === "reject" ? "Rejecting" : action === "reopen" ? "Reopening"
    : it.kind === "decision" ? "Logging the decision" : "Approving";
  const beforeView = buildView(cache);
  const before = beforeView.flat.map((e) => e.key);
  const entry = beforeView.sel;
  let res = null, out = {};
  try {
    res = await fetch(`/api/orgs/${encodeURIComponent(site)}/meetings/${encodeURIComponent(m.meetingId)}/items/${encodeURIComponent(it.id)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try { out = await res.json(); } catch { out = {}; }
  } catch { res = null; }
  busy.delete(k);
  if (!res || !res.ok) {
    failItem(k, res ? TurmaNav.refusalText(what, res.status, out) : `${what} failed — the hub is unreachable`);
  } else {
    edits.delete(k);
    if (out.meeting && cache) patchMeeting(site, out.meeting);
    // The cursor moves on through followCursor, whichever lands first: this
    // answer or the SSE frame carrying the same row.
    followCursor(itemOrder(buildView(cache)));
    // The entry's last proposal answered: on to the next one that needs review.
    if (action !== "reopen" && filter === "review" && entry && entry.key === selected) {
      const after = buildView(cache).sel;
      if (after && after.key === entry.key && !after.pending && !after.inflight && !after.current) {
        selected = null;
        advanceFrom(entry.key, before);
      }
    }
  }
  repaint(true);
}
function patchMeeting(site, row) {
  const list = own(cache.meetingProposals, site);
  if (!Array.isArray(list) || !row || typeof row.meetingId !== "string") return;
  cache.meetingProposals = { ...cache.meetingProposals };
  Object.defineProperty(cache.meetingProposals, site, { value: list.map((x) => (x.meetingId === row.meetingId ? row : x)),
    enumerable: true, writable: true, configurable: true });
}
// Archive / Unarchive a whole meeting (contract-meetings.md): the hub's answer
// is the row; a refusal is shown in the hub's words (XERK-264).
async function archive(mk, archived) {
  if (archBusy.has(mk)) return;
  const [site, mid] = splitKey(mk);
  archBusy.add(mk);
  archErr.delete(mk);
  repaint(true);
  const before = buildView(cache).flat.map((e) => e.key);
  const was = selected;
  let res = null, out = {};
  try {
    res = await fetch(`/api/orgs/${encodeURIComponent(site)}/meetings/${encodeURIComponent(mid)}/archive`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived }) });
    try { out = await res.json(); } catch { out = {}; }
  } catch { res = null; }
  archBusy.delete(mk);
  const what = archived ? "Archiving the meeting" : "Unarchiving the meeting";
  if (!res || !res.ok) {
    const text = res ? TurmaNav.refusalText(what, res.status, out) : `${what} failed — the hub is unreachable`;
    archErr.set(mk, text);
    TurmaNav.toast(text);
  } else if (out && out.meeting && cache) {
    patchMeeting(site, out.meeting);
    if (was) advanceFrom(was, before);
  }
  repaint(true);
}
function startEdit(k) {
  const hit = findItem(k);
  if (!hit) return;
  const { site, m, it } = hit;
  const t = typesOf(site);
  const draft = { title: it.title,
    description: it.kind === "decision" ? (it.description || "") : ticketDescription(m, it) };
  edits.set(k, { ...draft, initial: { ...draft },
    issueType: it.kind === "decision" ? "" : defaultType(it.kind, t && t.types) });
  if (it.kind !== "decision") ensureTypes(site);
  repaint(true);
}
function select(key) {
  selected = key;
  curItem = null;
  narrowMain = true;
  repaint(true);
}

// ---- keyboard triage --------------------------------------------------------------
// A approve, S approve + session, E edit, R reject, J/K next/previous proposal —
// never a key's auto-repeat, never while typing (a field, a contenteditable), with a
// modifier, or with the settings drawer or another dialog open.
function onKey(ev) {
  // A held key auto-repeats: holding A must not approve proposal after proposal.
  if (!$list || !cache || !ev || ev.repeat || ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const t = ev.target;
  if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.isContentEditable)) return;
  if (t && t.closest && t.closest("dialog,[role=dialog]")) return;
  if (drawer || $list.offsetParent === null) return;
  const key = String(ev.key || "").toLowerCase();
  if (!["a", "s", "e", "r", "j", "k"].includes(key)) return;
  const order = itemOrder(buildView(cache));
  // A frame may have moved the list since the last paint (a held repaint): the
  // cursor follows its place here too, before any key acts on it.
  followCursor(order);
  if (!order.length) return;
  ev.preventDefault();
  const i = order.indexOf(curItem);
  if (key === "j" || key === "k") {
    curItem = i < 0 ? order[0] : order[Math.max(0, Math.min(order.length - 1, i + (key === "j" ? 1 : -1)))];
    repaint(true);
    const el = $list.querySelector && $list.querySelector(".mt-item.cur");
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    return;
  }
  const k = i < 0 ? order[0] : curItem;
  curItem = k;
  const hit = findItem(k);
  if (!hit) return;
  if (key === "a") review(k, "approve");
  else if (key === "s") { if (hit.it.kind !== "decision") review(k, "approve", true); }
  else if (key === "e") startEdit(k);
  else review(k, "reject");
}

// Wire the triage into `el` (once). The host page owns the snapshot and the
// stream and hands every change to update(); `pageHooks` render the brief.
function mount(el, pageHooks = {}) {
  if ($list) return;
  $list = el;
  hooks = pageHooks || {};
  $list.addEventListener("click", (ev) => {
    const b = ev.target && ev.target.closest
      ? ev.target.closest("[data-act],[data-meta-retry],[data-label-save],[data-label-reset],[data-miss-use],[data-focus-save],[data-focus-clear],"
        + "[data-entry],[data-filter],[data-org-toggle],[data-org-settings],[data-drawer-close],[data-back],[data-show-reviewed],[data-archive]") : null;
    if (!b) return;
    const d = b.dataset;
    if (d.entry !== undefined) return void select(d.entry);
    if (d.filter !== undefined) {
      if (FILTERS.some(([f]) => f === d.filter)) filter = d.filter;
      return void repaint(true);
    }
    if (d.orgToggle !== undefined) { setCollapsed(d.orgToggle, !collapsed.has(d.orgToggle)); return void repaint(true); }
    if (d.orgSettings !== undefined) { drawer = drawer === d.orgSettings ? null : d.orgSettings; return void repaint(true); }
    if (d.drawerClose !== undefined) { drawer = null; return void repaint(true); }
    if (d.back !== undefined) { narrowMain = false; return void repaint(true); }
    if (d.showReviewed !== undefined) {
      if (showReviewed.has(d.showReviewed)) showReviewed.delete(d.showReviewed); else showReviewed.add(d.showReviewed);
      return void repaint(true);
    }
    if (d.archive !== undefined) {
      if (b.getAttribute("aria-disabled") === "true") return;
      return void archive(d.archive, d.to === "true");
    }
    if (d.focusSave !== undefined || d.focusClear !== undefined) {
      if (b.getAttribute("aria-disabled") === "true") return;
      if (d.focusClear !== undefined) return void saveFocus(d.focusClear, "", "");
      const site = d.focusSave, v = focusDrafts.get(site) || focusOf(cache, site);
      return void saveFocus(site, v.names, v.role);
    }
    if (d.labelSave !== undefined || d.labelReset !== undefined || d.missUse !== undefined) {
      if (b.getAttribute("aria-disabled") === "true") return;
      if (d.labelReset !== undefined) return void saveLabel(d.labelReset, null);
      if (d.missUse !== undefined) {
        const k = d.missUse, site = missPick.get(k);
        if (site) saveLabel(site, missLabel(k)).then((ok) => { if (ok) missPick.delete(k); });
        return;
      }
      const site = d.labelSave;
      const v = labelDrafts.has(site) ? labelDrafts.get(site) : (own(cache && cache.meetingLabels, site) || {}).label;
      return void saveLabel(site, String(v || "").trim().toLowerCase());
    }
    if (d.metaRetry !== undefined) { meta.delete(d.metaRetry); ensureMeta(d.metaRetry); return repaint(true); }
    if (d.act === undefined || b.getAttribute("aria-disabled") === "true") return;
    const k = d.k, act = d.act;
    if (k !== undefined && act !== "cancel") curItem = k;
    if (act === "approve") review(k, "approve");
    else if (act === "start") review(k, "approve", true);
    else if (act === "reject") review(k, "reject");
    else if (act === "reopen") review(k, "reopen");
    else if (act === "edit") startEdit(k);
    else if (act === "cancel") { edits.delete(k); itemErr.delete(k); repaint(true); }
  });
  // Draft text lives in `edits`, so a repaint never loses what was typed.
  $list.addEventListener("input", (ev) => {
    const t = ev.target, d = t && t.dataset;
    if (!d) return;
    // The search filters as it is typed: its own paint is forced (a field has
    // focus), and focus + caret go back to it.
    if (d.search !== undefined) { query = String(t.value || ""); return void repaint(true); }
    if (d.label !== undefined) { labelDrafts.set(d.label, t.value); labelErr.delete(d.label); return; }
    if (d.focusNames !== undefined || d.focusRole !== undefined) {
      const site = d.focusNames ?? d.focusRole;
      const v = { ...(focusDrafts.get(site) || focusOf(cache, site)) };
      if (d.focusNames !== undefined) v.names = t.value; else v.role = t.value;
      focusDrafts.set(site, v);
      focusErr.delete(site);
      return;
    }
    const k = d.editTitle ?? d.editDesc ?? d.editType;
    const e = k !== undefined && edits.get(k);
    if (!e) return;
    if (d.editTitle !== undefined) e.title = t.value;
    else if (d.editDesc !== undefined) e.description = t.value;
    else e.issueType = t.value;
  });
  $list.addEventListener("change", (ev) => {
    const t = ev.target, d = t && t.dataset;
    if (!d) return;
    if (d.miss !== undefined) {
      if (t.value) missPick.set(d.miss, t.value); else missPick.delete(d.miss);
      return void repaint(true);
    }
    if (d.project !== undefined) {
      setProject(d.project, t.value);
      ensureTypes(d.project);
      for (const [k, e] of edits) if (k.startsWith(`${encodeURIComponent(d.project)}/`)) e.issueType = "";
      repaint(true);
    } else if (d.editType !== undefined) {
      const e = edits.get(d.editType);
      if (e) e.issueType = t.value;
    }
  });
  $list.addEventListener("keydown", (ev) => {
    const t = ev.target;
    if (!t || !t.dataset) return;
    if (ev.key === "Escape" && drawer) { drawer = null; return void repaint(true); }
    if (ev.key !== "Enter") return;
    const fs = t.dataset.focusNames ?? t.dataset.focusRole;
    if (fs !== undefined) {
      ev.preventDefault();
      const v = focusDrafts.get(fs) || focusOf(cache, fs);
      return void saveFocus(fs, v.names, v.role);
    }
    if (t.dataset.label === undefined) return;
    ev.preventDefault();
    const site = t.dataset.label;
    saveLabel(site, String(t.value || "").trim().toLowerCase());
  });
  if (typeof document.addEventListener === "function") document.addEventListener("keydown", onKey);
  function flushHeld() { setTimeout(() => { if (paintPending && cache) renderMeetings(cache); }, 0); }
  $list.addEventListener("focusout", flushHeld);
  $list.addEventListener("pointerdown", () => { pointerDown = true; }, true);
  // Released anywhere (a press can end off the list). The flush is a task later,
  // so the click this press makes has been dispatched first. A context menu or
  // the WINDOW losing focus can eat the pointerup; never a capture `blur` (it
  // fires for the field the press itself blurred, swapping the list mid-press).
  function releasePress() { if (pointerDown) { pointerDown = false; flushHeld(); } }
  for (const ev of ["pointerup", "pointercancel", "contextmenu"]) addEventListener(ev, releasePress, true);
  addEventListener("blur", (e) => { if (e.target === window) releasePress(); });
}

// The host page's snapshot changed (or the org pick did). `force`: the viewer's
// own action, painted even with a field focused (never through a pointer press).
function update(data, force = false) { cache = data; renderMeetings(data, force); }
// A paint the host page patched in place (a busy button): the next one must not
// be skipped as unchanged.
function invalidate() { painted = null; }
// A held repaint is owed (the page's own field changed under focus).
function hold() { paintPending = true; }
// Proposals in the shown orgs still waiting on the operator.
function pendingCount(data) {
  let n = 0;
  const keys = TurmaOrg.getKeys();
  const map = data && data.meetingProposals && typeof data.meetingProposals === "object" ? data.meetingProposals : {};
  for (const s of Object.keys(map)) {
    if (keys.length && !keys.includes(s)) continue;
    for (const m of meetingsOf(data, s)) if (!isTime(m.archivedAt)) n += meetingPending(m);
  }
  return n;
}

const api = { mount, update, invalidate, hold, pendingCount,
  // test hooks (tests/meetings.test.js, tests/brief.test.js)
  renderMeetings, review, archive, startEdit, edits, setProject, itemKey, entryKey, meetingKey, saveLabel,
  missesHtml, saveFocus, onKey, entriesOf, select,
  openDrawer: (s) => { drawer = s; repaint(true); },
  setFilter: (f) => { filter = f; repaint(true); },
  setQuery: (q) => { query = q; repaint(true); },
  state: () => ({ selected, curItem, filter, drawer, narrowMain, collapsed: [...collapsed] }),
  setCache: (c) => { cache = c; } };
if (typeof window !== "undefined") window.TurmaMeetings = api;
})();
