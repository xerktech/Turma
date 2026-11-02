// Meetings review (XERK-2510, moved onto the Brief page by XERK-2623): the work
// items an org host proposed from a meeting Tenir captured, each approved (a
// ticket on the org's board), edited then approved, or rejected by the operator.
//
// A shared module rather than a page: brief.html mounts it into its Meetings pane
// and feeds it the fleet snapshot, SSE frames included (update); it opens no stream and fetches no snapshot of its own.
// Loaded after org.js (it reads TurmaOrg/TurmaBoard/TurmaNav); in server.js's
// HASHED_ASSETS. Tests: tests/meetings.test.js.
(() => {
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}
function fmtWhen(ms) {
  return new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit" });
}
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
// An item's key rides a data attribute, so it is URI-encoded parts joined by "/" (an HTML
// parser would turn a NUL separator into U+FFFD).
const itemKey = (site, mid, iid) => [site, mid, iid].map(encodeURIComponent).join("/");
// A proposal can be (re)approved unless it is in flight or done.
const reviewable = (it) => !it.review || it.review.state === "failed" || it.review.state === "rejected";

// ---- page state ------------------------------------------------------------------
let $list = null;
let cache = null;
let painted = null;
let paintPending = false;
let pointerDown = false;
const busy = new Set();          // item keys with a POST in flight
const itemErr = new Map();       // item key -> the hub's refusal
const edits = new Map();         // item key -> {title, description, issueType}
const meta = new Map();          // site -> {loading} | {projects} | {error}
const types = new Map();         // site\0project -> {loading} | {types} | {error}
const PROJECT_STORE = "turma-meetings-project";
let projects = {};
try { projects = JSON.parse(localStorage.getItem(PROJECT_STORE) || "{}") || {}; } catch { projects = {}; }
function projectOf(site) {
  const m = meta.get(site);
  const list = (m && m.projects) || [];
  const saved = own(projects, site);
  if (saved && list.some((p) => p.key === saved)) return saved;
  return list.length === 1 ? list[0].key : "";
}
function setProject(site, key) {
  projects = { ...projects, [site]: key };
  try { localStorage.setItem(PROJECT_STORE, JSON.stringify(projects)); } catch { /* per-viewer nicety */ }
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

// What the ticket says by default: the proposal, then where it came from.
function ticketDescription(m, it) {
  const lines = [];
  if (it.description) lines.push(it.description, "");
  const when = isTime(m.startedAt) ? ` (${new Date(m.startedAt).toISOString().slice(0, 10)})` : "";
  lines.push(`Proposed from the meeting "${m.title}"${when}.`);
  for (const q of it.quotes || []) {
    lines.push(`> ${q.speaker ? `${q.speaker}: ` : ""}${q.text}${isTime(q.atMs + 1) ? ` [${clock(q.atMs)}]` : ""}`);
  }
  const u = safeUrl(m.tenirUrl);
  if (u) lines.push(`Meeting: ${u}`);
  return lines.join("\n");
}

// ---- render ------------------------------------------------------------------------
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
  let actions = "";
  if (edits.has(k) && reviewable(it)) {
    actions = editHtml(site, m, it, k);
  } else if (reviewable(it)) {
    const dis = busy.has(k) ? ' aria-disabled="true"' : "";
    actions = `<button class="btn-sm primary" data-act="approve" data-k="${esc(k)}"${dis}>${busy.has(k) ? "Working…" : isDecision ? "Log decision" : "Approve"}</button>`
      + (isDecision ? "" : `<button class="btn-sm" data-act="start" data-k="${esc(k)}"${dis}>Approve + start session</button>`)
      + `<button class="btn-sm" data-act="edit" data-k="${esc(k)}"${dis}>Edit</button>`
      + (state === "rejected" ? "" : `<button class="btn-sm" data-act="reject" data-k="${esc(k)}"${dis}>Reject</button>`);
  }
  const review = reviewStateHtml(site, it);
  const err = itemErr.get(k);
  return `<li class="mt-item${state === "rejected" ? " rejected" : ""}">`
    + `<div class="mt-item-head"><span class="mt-kind ${esc(it.kind)}">${esc(KIND_LABEL[it.kind] || it.kind)}</span>`
    + `<span class="mt-item-title">${esc(it.title)}</span></div>`
    + (it.description ? `<p class="mt-desc">${esc(it.description)}</p>` : "")
    + factsHtml(site, it) + quotesHtml(m, it)
    + (edits.has(k) && reviewable(it) ? `${review ? `<div class="mt-review">${review}</div>` : ""}${actions}`
      : (review || actions ? `<div class="mt-review">${review}${actions}</div>` : ""))
    + (err ? `<div class="mt-err">${esc(err)}</div>` : "")
    + `</li>`;
}
function meetingHtml(site, m) {
  const meta = [];
  if (m.platform) meta.push(m.platform);
  if (isTime(m.startedAt)) meta.push(fmtWhen(m.startedAt));
  if (isTime(m.startedAt) && isTime(m.endedAt) && m.endedAt > m.startedAt) {
    meta.push(`${Math.max(1, Math.round((m.endedAt - m.startedAt) / 60000))} min`);
  }
  const ppl = (m.participants || []).length;
  if (ppl) meta.push(`${ppl} participant${ppl === 1 ? "" : "s"}`);
  const metaHtml = meta.map((b, i) => `<span class="bit${i < meta.length - 1 ? " sep" : ""}">${esc(b)}</span>`).join("");
  const url = safeUrl(m.tenirUrl);
  const link = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open in Tenir ↗</a>` : "";
  let body;
  if (m.status === "queued") body = `<div class="mt-status">Waiting for a host of this org to read the captions…</div>`;
  else if (m.status === "running") body = `<div class="mt-status">Reading the captions${m.host ? ` on ${esc(m.host)}` : ""}…</div>`;
  else if (m.status === "failed") body = `<div class="mt-status failed">Could not propose work items — ${esc(m.error || "the run failed")}</div>`;
  else if (!(m.items || []).length) body = `<div class="mt-status">Nothing to propose from this meeting.</div>`;
  else body = `<ul class="mt-items">${m.items.map((it) => itemHtml(site, m, it)).join("")}</ul>`;
  return `<section class="mt-meeting"><div class="mt-head"><h3 class="mt-title">${esc(m.title)}</h3>${link}</div>`
    + `<div class="mt-meta">${metaHtml}</div>${body}</section>`;
}
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
function orgHtml(site, list, name) {
  const target = needsProject(list) ? targetHtml(site) : "";
  return `<div class="mt-org"><div class="mt-org-head"><h2 class="mt-org-name">${esc(name)}</h2>${target}</div>`
    + list.map((m) => meetingHtml(site, m)).join("") + `</div>`;
}

function shownOrgs(data) {
  const keys = TurmaOrg.getKeys();
  const map = data && data.meetingProposals && typeof data.meetingProposals === "object" ? data.meetingProposals : {};
  return Object.keys(map).filter((s) => Array.isArray(map[s]) && map[s].length && (!keys.length || keys.includes(s))).sort();
}
function editing() {
  const a = document.activeElement;
  return !!a && $list.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName || "");
}
function renderMeetings(data, force = false) {
  if (!$list) return;
  if (pointerDown || (!force && editing())) { paintPending = true; return; }
  paintPending = false;
  const sites = shownOrgs(data);
  const names = new Map((TurmaBoard.mergeSites ? TurmaBoard.mergeSites(data.agents || []) : [])
    .map((x) => [x.siteKey, x.orgName]));
  const name = (s) => (TurmaBoard.orgName ? TurmaBoard.orgName(s, names.get(s)) : s);
  for (const s of sites) if (needsProject(own(data.meetingProposals, s))) ensureMeta(s);
  const html = sites.length
    ? sites.map((s) => orgHtml(s, own(data.meetingProposals, s), name(s))).join("")
    : `<div class="mt-empty">${Object.values(data.meetingProposals || {}).some((l) => Array.isArray(l) && l.length)
      ? "No meetings for the orgs picked in the header — pick All orgs to see the others."
      : "No meetings yet — when Tenir sends one, its proposed work items show up here."}</div>`;
  if (html === painted) return;
  painted = html;
  TurmaNav.preserveScroll($list, () => { $list.innerHTML = html; });
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
  const [site, mid, iid] = String(k).split("/").map(decodeURIComponent);
  const list = cache && own(cache.meetingProposals, site);
  const m = Array.isArray(list) && list.find((x) => x.meetingId === mid);
  const it = m && (m.items || []).find((x) => x.id === iid);
  return it ? { site, m, it } : null;
}
function failItem(k, text) {
  itemErr.set(k, text);
  TurmaNav.toast(text);
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
  const what = action === "reject" ? "Rejecting" : it.kind === "decision" ? "Logging the decision" : "Approving";
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
  }
  repaint(true);
}
function patchMeeting(site, row) {
  const list = own(cache.meetingProposals, site);
  if (!Array.isArray(list)) return;
  cache.meetingProposals[site] = list.map((x) => (x.meetingId === row.meetingId ? row : x));
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

// Wire the review list into `el` (once). The host page owns the snapshot and the
// stream and hands every change to update() / setProposals().
function mount(el) {
  if ($list) return;
  $list = el;
  $list.addEventListener("click", (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest("[data-act],[data-meta-retry]") : null;
    if (!b) return;
    if (b.dataset.metaRetry !== undefined) { meta.delete(b.dataset.metaRetry); ensureMeta(b.dataset.metaRetry); return repaint(true); }
    if (b.getAttribute("aria-disabled") === "true") return;
    const k = b.dataset.k, act = b.dataset.act;
    if (act === "approve") review(k, "approve");
    else if (act === "start") review(k, "approve", true);
    else if (act === "reject") review(k, "reject");
    else if (act === "edit") startEdit(k);
    else if (act === "cancel") { edits.delete(k); itemErr.delete(k); repaint(true); }
  });
  // Draft text lives in `edits`, so a repaint never loses what was typed.
  $list.addEventListener("input", (ev) => {
    const t = ev.target, d = t && t.dataset;
    if (!d) return;
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
  function flushHeld() { setTimeout(() => { if (paintPending && cache) renderMeetings(cache); }, 0); }
  $list.addEventListener("focusout", flushHeld);
  $list.addEventListener("pointerdown", () => { pointerDown = true; }, true);
  function releasePress() { if (pointerDown) { pointerDown = false; flushHeld(); } }
  for (const ev of ["pointerup", "pointercancel", "contextmenu"]) addEventListener(ev, releasePress, true);
  addEventListener("blur", (e) => { if (e.target === window) releasePress(); });
}

// The host page's snapshot changed (or the org pick did).
function update(data) { cache = data; renderMeetings(data); }
// Proposals in the shown orgs still waiting on the operator (for the pane's tab).
function pendingCount(data) {
  let n = 0;
  for (const s of shownOrgs(data)) {
    for (const m of own(data.meetingProposals, s) || []) {
      if (m && m.status === "ok") n += (m.items || []).filter((it) => it && reviewable(it) && !(it.review && it.review.state === "rejected")).length;
    }
  }
  return n;
}

const api = { mount, update, pendingCount,
  // test hooks (tests/meetings.test.js)
  renderMeetings, review, startEdit, edits, setProject, itemKey, setCache: (c) => { cache = c; } };
if (typeof window !== "undefined") window.TurmaMeetings = api;
})();
