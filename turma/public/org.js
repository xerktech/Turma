// Turma org filter — the one org-scoping control, mounted in the shared site
// header (nav.js's #hdrOrg slot) and honoured by every page.
//
// It used to be a strip of chips on the board alone, so "which org am I looking
// at" was a question only the Kanban could answer: the dashboard listed every
// host of every org, the sessions sidebar every session of every org, and usage
// charted the lot. Since a host polls exactly ONE org (agent-side rule), an
// org IS a partition of the fleet, so the same pick that filters tickets can
// filter hosts, sessions and usage — which is what XERK-62 asks for. Moving it
// into the header is what makes it available on all four pages at once, and the
// selection is persisted (and shared across open tabs) so it follows the
// operator from page to page rather than resetting at each nav.
//
// The filter value is a full siteKey (what the hub keys and routes on), never
// the display org name; "" means every org. The per-org auto-start switch
// (XERK-41) rode the board's chips, so it comes along as a row segment in this
// menu — it is a per-org setting, and this is now where per-org settings live.
//
// Depends on board.js for the org vocabulary (mergeSites / orgName /
// orgColorMap), which is why every page loads board.js now, not just the board
// and the dashboard. Dual-exported (window.TurmaOrg + module.exports) like
// nav.js / board.js / chat.js, so the pure half is unit-testable with no DOM.
(() => {
  "use strict";

  // Where the pick is persisted. The board's own key is read once and migrated,
  // so an operator's existing board filter carries into the new global one
  // rather than silently resetting to "all orgs" on upgrade.
  const KEY = "turma-org";
  const LEGACY_KEY = "turma-board-org";

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  // ---- pure half (unit-tested) ---------------------------------------------

  // The org a host belongs to. A host with no tracker creds reports no jira
  // block and belongs to no org — so it shows under "All orgs" and under none
  // of the named ones, which is the truth about it.
  function siteKeyOf(agent) {
    return (agent && agent.jira && agent.jira.siteKey) || "";
  }

  // The fleet, scoped to one org. Deliberately NOT board.js's filterSites
  // fallback ("unknown filter shows everything") — that rule is about a site
  // list, and here the caller has already resolved the key through
  // effectiveKey(), which is where a stale pick self-heals.
  function filterAgents(agents, key) {
    const list = agents || [];
    if (!key) return list;
    return list.filter(a => siteKeyOf(a) === key);
  }

  // A stored pick only counts while some host still reports that org — an org
  // whose last agent was removed must not leave every page filtered down to
  // nothing with no way back. The stored value is KEPT (a host that comes back
  // resumes its filter); it just doesn't apply while nothing reports it.
  function effectiveKey(key, sites) {
    if (!key) return "";
    return (sites || []).some(s => s.siteKey === key) ? key : "";
  }

  function autoOn(map, siteKey) {
    return !!(map && map[siteKey]);
  }

  // The header button: the current scope, dot-coloured by the org's palette slot
  // so it matches that org's cards and columns everywhere else.
  function buttonHtml(sites, key, colorMap, open) {
    const B = board();
    const site = (sites || []).find(s => s.siteKey === key);
    const label = site ? B.orgName(site.siteKey, site.orgName) : "All orgs";
    const color = site ? (colorMap.get(site.siteKey) || B.orgColor(site.siteKey)) : "";
    return `<button type="button" class="org-btn${site ? " scoped" : ""}" data-org-toggle
      aria-haspopup="true" aria-expanded="${open ? "true" : "false"}"
      title="${site ? "Showing " + esc(label) + " only — click to change" : "Filter every page by org"}"
      ${color ? `style="--org:${esc(color)}"` : ""}>` +
      `<span class="org-dot" aria-hidden="true"></span>` +
      `<span class="org-btn-label">${esc(label)}</span>` +
      `<span class="org-chev" aria-hidden="true">▾</span></button>`;
  }

  // The menu: "All orgs" plus one row per reporting org. Each named row is two
  // segments — the scope pick, and the org's auto-start switch — the same
  // divided-pill shape the board chips carried, laid out as a list.
  function menuHtml(sites, key, colorMap, autoMap, ageStr) {
    const B = board();
    const total = (sites || []).reduce((n, s) => n + (s.tickets || []).length, 0);
    const rows = [
      `<div class="org-row${key ? "" : " active"}">` +
      `<button type="button" class="org-row-main" data-org-key="" role="menuitemradio"` +
      ` aria-checked="${key ? "false" : "true"}">` +
      `<span class="org-row-name">All orgs</span>` +
      `<span class="chip-n">${total}</span></button></div>`,
    ];
    for (const s of sites || []) {
      const color = colorMap.get(s.siteKey) || B.orgColor(s.siteKey);
      const on = autoOn(autoMap, s.siteKey);
      const hosts = (s.hosts || []).length;
      const age = s.online ? "" : (ageStr ? ageStr(s.lastFetched) : "");
      rows.push(
        `<div class="org-row${key === s.siteKey ? " active" : ""}" style="--org:${esc(color)}">` +
        `<button type="button" class="org-row-main has-dot" data-org-key="${esc(s.siteKey)}"` +
        ` role="menuitemradio" aria-checked="${key === s.siteKey ? "true" : "false"}"` +
        ` title="${esc(s.siteKey)} · ${hosts} host${hosts === 1 ? "" : "s"}">` +
        `<span class="org-dot" aria-hidden="true"></span>` +
        `<span class="org-row-name">${esc(B.orgName(s.siteKey, s.orgName))}</span>` +
        `<span class="chip-n">${(s.tickets || []).length}</span>` +
        (s.online ? "" : `<span class="chip-stale" title="No host reporting this org is online — showing its last report">⚠ offline${age ? " · synced " + esc(age) + " ago" : ""}</span>`) +
        `</button>` +
        `<button type="button" class="org-chip-auto${on ? " on" : ""}" data-org-auto="${esc(s.siteKey)}"` +
        ` aria-pressed="${on ? "true" : "false"}"` +
        ` title="Auto: start To Do tickets, stop Done sessions — ${on ? "ON, click to turn off" : "OFF, click to turn on"}">` +
        `<span class="org-auto-dot" aria-hidden="true"></span>auto</button></div>`);
    }
    return `<div class="org-menu" role="menu">${rows.join("")}</div>`;
  }

  function controlHtml(sites, key, colorMap, autoMap, open, ageStr) {
    return `<span class="org-filter${open ? " open" : ""}">` +
      buttonHtml(sites, key, colorMap, open) +
      (open ? menuHtml(sites, key, colorMap, autoMap, ageStr) : "") +
      `</span>`;
  }

  // ---- imperative half ------------------------------------------------------

  function board() {
    return (typeof window !== "undefined" && window.TurmaBoard) || {
      orgName: k => k, orgColor: () => "", orgColorMap: () => new Map(),
      mergeSites: () => [], ageStr: () => "",
    };
  }

  const listeners = [];
  let stored = "";        // what localStorage says, whether or not it applies
  let sites = [];         // the orgs the fleet currently reports
  let autoMap = {};       // the hub's per-org auto-start opt-in
  let open = false;
  let slot = null;
  let painted = "";       // last markup written, so a beat repaint is a no-op

  function readStored() {
    try {
      const v = localStorage.getItem(KEY);
      if (v !== null) return v;
      // One-time migration off the board-only key.
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) { localStorage.setItem(KEY, legacy); return legacy; }
    } catch { /* private mode / no storage — the filter is just not persisted */ }
    return "";
  }

  // The pick as it APPLIES right now (a pick for an org nobody reports doesn't).
  function get() {
    return effectiveKey(stored, sites);
  }

  function notify() {
    for (const fn of listeners) { try { fn(get()); } catch { /* a page's own repaint */ } }
  }

  function set(key) {
    const next = key || "";
    if (next === stored) { close(); return; }
    stored = next;
    try { localStorage.setItem(KEY, next); } catch { /* not persisted */ }
    close();
    paint();
    notify();
  }

  function subscribe(fn) {
    if (typeof fn === "function") listeners.push(fn);
  }

  function close() { open = false; }

  // Feed the control the heartbeat every page already has. Cheap on a settled
  // fleet: the markup is rebuilt but only written when it actually changed, so
  // a 1s beat doesn't churn the DOM (or drop an open menu's hover).
  function update(data) {
    const B = board();
    sites = B.mergeSites((data && data.agents) || []);
    if (data && data.autoStartOrgs) autoMap = data.autoStartOrgs;
    paint();
  }

  function paint() {
    if (!slot) return;
    const B = board();
    const key = get();
    const colorMap = B.orgColorMap(sites.map(s => s.siteKey));
    // Nothing to scope by until at least one host reports a tracker org, so the
    // slot stays empty and collapses (#hdrOrg:empty in app.css) rather than
    // offering a menu whose only entry is "All orgs".
    const html = sites.length ? controlHtml(sites, key, colorMap, autoMap, open, B.ageStr) : "";
    if (html === painted) return;
    painted = html;
    slot.innerHTML = html;
  }

  // Flip an org's hub-side auto-start opt-in (XERK-41). Painted optimistically —
  // the hub is authoritative the moment the POST returns and its SSE event keeps
  // every other open page in step, but the local flip makes THIS one respond
  // instantly. Rolls back if the POST fails.
  async function setAutoStart(siteKey, enabled) {
    const had = autoOn(autoMap, siteKey);
    autoMap = Object.assign({}, autoMap);
    if (enabled) autoMap[siteKey] = true; else delete autoMap[siteKey];
    paint();
    let ok = false;
    try {
      const r = await fetch(`/api/jira/${encodeURIComponent(siteKey)}/autostart`,
        { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled }) });
      if (r.status === 401) { location.href = "/login"; return; }
      ok = r.ok;
    } catch { /* network error — fall through to rollback */ }
    if (!ok) {
      autoMap = Object.assign({}, autoMap);
      if (had) autoMap[siteKey] = true; else delete autoMap[siteKey];
      paint();
    }
  }

  // The hub broadcasts the whole (tiny) opt-in map whenever it changes. Each
  // page hands its EventSource over rather than opening a second one.
  function sse(es) {
    if (!es || !es.addEventListener) return;
    es.addEventListener("autoStartOrgs", (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      autoMap = m || {};
      paint();
    });
  }

  function mount(doc) {
    slot = doc.getElementById("hdrOrg");
    if (!slot) return;
    // A freshly-mounted control starts closed, with nothing painted and nothing
    // known about the fleet — it learns the orgs from the first update().
    painted = ""; open = false; sites = []; autoMap = {};
    stored = readStored();
    // One delegated listener set, attached once — the control's markup is
    // replaced on every change, so per-element handlers would have to be
    // re-bound each time.
    slot.addEventListener("click", (e) => {
      // Marked BEFORE anything repaints: handling a click replaces the control's
      // markup, which detaches the clicked node, so by the time this same event
      // bubbles on to the click-away handler below `slot.contains(e.target)` is
      // false — and the menu closed itself on the very click that opened it.
      // A flag on the event is the one signal a repaint can't invalidate.
      e.turmaOrgHandled = true;
      const auto = e.target.closest("[data-org-auto]");
      if (auto) { setAutoStart(auto.dataset.orgAuto, !auto.classList.contains("on")); return; }
      const pick = e.target.closest("[data-org-key]");
      if (pick) { set(pick.dataset.orgKey); return; }
      if (e.target.closest("[data-org-toggle]")) { open = !open; paint(); }
    });
    doc.addEventListener("click", (e) => {
      if (open && !e.turmaOrgHandled && !slot.contains(e.target)) { close(); paint(); }
    });
    doc.addEventListener("keydown", (e) => {
      if (open && e.key === "Escape") { close(); paint(); }
    });
    // Another tab changed the scope — follow it, so the fleet doesn't disagree
    // with itself across two windows.
    window.addEventListener("storage", (e) => {
      if (e.key !== KEY) return;
      stored = e.newValue || "";
      paint();
      notify();
    });
    paint();
  }

  const api = {
    KEY, LEGACY_KEY, esc,
    siteKeyOf, filterAgents, effectiveKey, autoOn,
    buttonHtml, menuHtml, controlHtml,
    get, set, subscribe, update, sse, setAutoStart, mount,
    // The common call site: scope the beat's fleet to the current pick.
    filter(agents) { return filterAgents(agents, get()); },
  };
  if (typeof window !== "undefined") window.TurmaOrg = api;
  // Guarded on `document`, not `window`: the tests put a stand-in TurmaBoard on
  // a fake global `window` before requiring this, and must still drive mount()
  // themselves against their own document shim.
  if (typeof document !== "undefined") mount(document);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
