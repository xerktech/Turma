// Turma "New ticket" control — the board's one write path to the tracker, moved
// out of the board page and into the shared site header so a ticket can be
// created from ANY page (XERK-150).
//
// It used to live in the board toolbar: the button, the modal, and all of the
// create wiring were board.html's. But creating a ticket is not a board-only
// act — it's an org-scoped action, exactly like the org filter beside it — so it
// belongs in the chrome every page carries, mounted into nav.js's #hdrNewTicket
// slot and owned here once instead of being reachable only from the Kanban.
//
// The pure form HTML still lives in board.js (createFormHtml / createOrgOptions /
// createProjectOptions / createTypeOptions / createLabelWord), unit-tested there;
// this module is the imperative half — the fetch/poll/submit wiring board.html
// used to hold — plus the button and modal DOM it now creates itself rather than
// relying on any page's markup.
//
// Depends on board.js (the form vocabulary) and TurmaOrg (the current scope, for
// the default org a create targets), so every page loads it after both. Fed the
// same heartbeat every page already hands TurmaOrg.update(), so it knows the
// fleet's orgs and can hide its button until one reports. Dual-exported
// (window.TurmaNewTicket + module.exports) like nav.js / org.js / board.js, so
// the pure half is unit-testable with no DOM.
(() => {
  "use strict";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function board() {
    return (typeof window !== "undefined" && window.TurmaBoard) || {
      createFormHtml: () => "", orgName: (k) => k, mergeSites: () => [],
    };
  }

  // ---- pure half (unit-tested) ---------------------------------------------

  // Jira labels can't contain spaces, so split on commas AND whitespace; Azure
  // tags can, so split on commas only. Deduped, capped to match the hub.
  function splitLabels(raw, source) {
    const parts = source === "azure"
      ? String(raw || "").split(",")
      : String(raw || "").split(/[,\s]+/);
    const seen = new Set(), out = [];
    for (let p of parts) {
      p = p.trim();
      if (p && !seen.has(p)) { seen.add(p); out.push(p); }
    }
    return out.slice(0, 20);
  }

  // The header button. Kept out of nav.js so the chrome stays purely structural
  // and this module owns the one thing that toggles it (the fleet reporting an
  // org). The accent-filled pill reads as the primary action beside the quiet
  // org filter, exactly as it did next to Refresh on the board.
  function buttonHtml() {
    return `<button type="button" class="newticket-btn" data-newticket
        title="Create a new ticket on a board">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
      <span>New ticket</span>
    </button>`;
  }

  // ---- imperative half ------------------------------------------------------

  let docRef = null, bodyEl = null;
  let slot = null, btnEl = null, backdrop = null, panel = null;
  let sites = [];          // the orgs the fleet currently reports (merged)
  let btnShown = false;
  // { sites, siteKey, source, meta, types, values, busy, error, created }
  let createState = null, createSeq = 0;

  // The org list a create can target: every org the fleet reports, shaped down
  // to what createOrgOptions / the submit path need.
  function orgSites() {
    return sites.map((s) => ({
      siteKey: s.siteKey, orgName: s.orgName, source: s.source, online: s.online }));
  }

  function paintCreate() {
    if (createState && panel) panel.innerHTML = board().createFormHtml(createState);
  }

  // A modal is open somewhere (this one or the board's own detail panel), so
  // body scroll-lock and its removal stay correct without coupling to the board
  // page's internal state — we only drop td-open once no backdrop is showing.
  // Queries through the mounted document (the real one in the browser), never a
  // global, so it holds under the test shim too.
  function anyBackdropOpen() {
    return !!(docRef && docRef.querySelector &&
      docRef.querySelector(".td-backdrop:not([hidden])"));
  }

  function openCreate() {
    const list = orgSites();
    if (!list.length) return;
    const cur = (typeof window !== "undefined" && window.TurmaOrg &&
      window.TurmaOrg.get && window.TurmaOrg.get()) || "";
    const pick = list.find((s) => s.siteKey === cur) || list[0];
    createState = {
      sites: list, siteKey: pick.siteKey, source: pick.source || "jira",
      meta: {}, types: {},
      values: { project: "", issueType: "", summary: "", description: "", labels: "" },
      busy: false, error: "", created: null,
    };
    backdrop.hidden = false;
    if (bodyEl) bodyEl.classList.add("td-open");
    paintCreate();
    loadMeta();
  }

  function closeCreate() {
    createSeq++;                 // abandon any in-flight meta/type fetch
    createState = null;
    if (backdrop) backdrop.hidden = true;
    if (panel) panel.replaceChildren();
    if (bodyEl && !anyBackdropOpen()) bodyEl.classList.remove("td-open");
  }

  // Read the text fields back into state before any repaint (a select change
  // repaints, which would otherwise reset a half-typed title to its stored value).
  function syncCreateFields() {
    if (!createState || !panel) return;
    const g = (sel) => { const el = panel.querySelector(sel); return el ? el.value : undefined; };
    const v = createState.values;
    const s = g("[data-cf-summary]"); if (s !== undefined) v.summary = s;
    const d = g("[data-cf-desc]"); if (d !== undefined) v.description = d;
    const l = g("[data-cf-labels]"); if (l !== undefined) v.labels = l;
  }

  async function fetchCreateMeta(siteKey, project, alive) {
    const q = project ? `?project=${encodeURIComponent(project)}` : "";
    const url = `/api/jira/${encodeURIComponent(siteKey)}/create-meta${q}`;
    const deadline = Date.now() + 45000;
    let delay = 600;
    while (alive() && Date.now() < deadline) {
      let r;
      try { r = await fetch(url); } catch { return { error: "the hub is unreachable" }; }
      if (r.status === 401) { location.href = "/login"; return {}; }
      if (r.status === 202) { await sleep(delay); delay = Math.min(delay * 1.5, 3000); continue; }
      let d = {};
      try { d = await r.json(); } catch { /* non-JSON error body */ }
      if (!r.ok) return { error: d.error || `HTTP ${r.status}` };
      return d;
    }
    return alive() ? { error: "the host didn't answer in time" } : {};
  }

  async function loadMeta() {
    const mySeq = ++createSeq, site = createState.siteKey;
    createState.meta = {};                 // loading
    paintCreate();
    const alive = () => createSeq === mySeq && createState && createState.siteKey === site;
    const d = await fetchCreateMeta(site, "", alive);
    if (!alive()) return;
    if (d.error) { createState.meta = { error: d.error }; return void paintCreate(); }
    createState.meta = { projects: d.projects || [], labels: d.labels || [] };
    if (d.source) createState.source = d.source;
    // A lone project is auto-selected so the type list loads without a click.
    if ((d.projects || []).length === 1) {
      createState.values.project = d.projects[0].key;
      paintCreate();
      return void loadTypes();
    }
    paintCreate();
  }

  async function loadTypes() {
    const project = createState.values.project;
    if (!project) return;
    const mySeq = ++createSeq, site = createState.siteKey;
    createState.types = {};                // loading
    paintCreate();
    const alive = () => createSeq === mySeq && createState &&
      createState.siteKey === site && createState.values.project === project;
    const d = await fetchCreateMeta(site, project, alive);
    if (!alive()) return;
    if (d.error) { createState.types = { error: d.error }; return void paintCreate(); }
    const types = d.types || [];
    createState.types = { types };
    if (types.length === 1) createState.values.issueType = types[0].id;
    paintCreate();
  }

  async function pollCreate(siteKey, cmdId) {
    const url = `/api/jira/${encodeURIComponent(siteKey)}/tickets/${encodeURIComponent(cmdId)}`;
    const deadline = Date.now() + 60000;
    let delay = 700;
    while (createState && Date.now() < deadline) {
      let r;
      try { r = await fetch(url); } catch { return { error: "the hub is unreachable" }; }
      if (r.status === 401) { location.href = "/login"; return {}; }
      if (r.status === 202) { await sleep(delay); delay = Math.min(delay * 1.5, 3000); continue; }
      let d = {};
      try { d = await r.json(); } catch { /* non-JSON error body */ }
      if (!r.ok) return { error: d.error || `HTTP ${r.status}` };
      return d;
    }
    return { error: "the create didn't complete in time" };
  }

  async function submitCreate() {
    const s = createState;
    if (!s || s.busy) return;
    syncCreateFields();
    const v = s.values;
    if (!v.project || !v.issueType || !(v.summary || "").trim()) return;
    s.busy = true; s.error = "";
    paintCreate();
    const labels = splitLabels(v.labels, s.source);
    let r, body = {};
    try {
      r = await fetch(`/api/jira/${encodeURIComponent(s.siteKey)}/tickets`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: v.project, issueType: v.issueType,
          summary: v.summary.trim(), description: v.description, labels }),
      });
    } catch { if (createState === s) { s.busy = false; s.error = "the hub is unreachable"; paintCreate(); } return; }
    if (r.status === 401) { location.href = "/login"; return; }
    try { body = await r.json(); } catch { /* non-JSON error body */ }
    if (!r.ok) {
      if (createState === s) { s.busy = false; s.error = body.error || `HTTP ${r.status}`; paintCreate(); }
      return;
    }
    const out = await pollCreate(s.siteKey, body.cmdId);
    if (createState !== s) return;         // closed while the create was in flight
    s.busy = false;
    if (out.error) { s.error = out.error; return void paintCreate(); }
    s.created = { key: out.key, url: out.url, warning: out.warning || "" };
    paintCreate();
  }

  // Show the button only once an org exists to create against, without churning
  // the DOM each beat: the button is appended/removed from the slot on the edge,
  // and while absent the slot is :empty and collapses (its gap costs nothing).
  function setButtonVisible(vis) {
    if (vis === btnShown || !slot || !btnEl) return;
    btnShown = vis;
    if (vis) slot.appendChild(btnEl);
    else if (btnEl.parentNode) btnEl.parentNode.removeChild(btnEl);
  }

  // Fed the heartbeat every page already hands TurmaOrg.update(). Cheap on a
  // settled fleet: mergeSites runs, but the only DOM touch is the button's
  // edge-triggered show/hide.
  function update(data) {
    sites = board().mergeSites((data && data.agents) || []);
    setButtonVisible(sites.length > 0);
    // An org can disappear (its last host removed) while the modal is open; keep
    // the open form's org list current so its selector doesn't offer a gone org.
    if (createState) {
      createState.sites = orgSites();
      if (!createState.sites.some((s) => s.siteKey === createState.siteKey)) closeCreate();
    }
  }

  function mount(doc) {
    slot = doc.getElementById("hdrNewTicket");
    if (!slot) return;
    docRef = doc;
    bodyEl = doc.body || doc.documentElement;
    // Fresh mount: nothing known about the fleet yet, button hidden until the
    // first update() learns of an org.
    sites = []; btnShown = false; createState = null;

    const holder = doc.createElement("div");
    holder.innerHTML = buttonHtml();
    btnEl = holder.firstElementChild;

    // The modal DOM is created here rather than sitting in every page's markup —
    // moving the button to the chrome means moving its dialog too. Same classes
    // (.td-backdrop / .td-panel.cf-panel) the board detail panel uses, so the
    // shared modal CSS in app.css styles it with no page-specific markup.
    backdrop = doc.createElement("div");
    backdrop.className = "td-backdrop";
    backdrop.id = "createBackdrop";
    backdrop.hidden = true;
    panel = doc.createElement("div");
    panel.className = "td-panel cf-panel";
    panel.id = "createPanel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "New ticket");
    backdrop.appendChild(panel);
    (doc.body || doc.documentElement).appendChild(backdrop);

    btnEl.addEventListener("click", openCreate);

    panel.addEventListener("click", (e) => {
      if (!createState) return;
      if (e.target.closest("[data-cf-close]") || e.target.closest("[data-cf-cancel]")) {
        return closeCreate();
      }
      if (e.target.closest("[data-cf-another]")) {
        // Keep the org/project/type; clear the text for the next ticket.
        createState.created = null; createState.error = "";
        createState.values.summary = "";
        createState.values.description = "";
        createState.values.labels = "";
        return void paintCreate();
      }
      if (e.target.closest("[data-cf-submit]")) return void submitCreate();
    });
    panel.addEventListener("change", (e) => {
      if (!createState) return;
      const org = e.target.closest("[data-cf-org]");
      if (org) {
        syncCreateFields();
        createState.siteKey = org.value;
        const site = createState.sites.find((x) => x.siteKey === org.value);
        createState.source = (site && site.source) || "jira";
        createState.values.project = "";
        createState.values.issueType = "";
        createState.values.labels = "";     // wording differs per source
        createState.error = "";
        return void loadMeta();
      }
      const proj = e.target.closest("[data-cf-project]");
      if (proj) {
        syncCreateFields();
        createState.values.project = proj.value;
        createState.values.issueType = "";
        return void loadTypes();
      }
      const typ = e.target.closest("[data-cf-type]");
      if (typ) {
        syncCreateFields();                 // keep any title/desc typed before this
        createState.values.issueType = typ.value;
        return void paintCreate();          // re-evaluate the submit button
      }
    });
    // Text input: store the value and re-evaluate the submit button WITHOUT a
    // full repaint (which would drop the caret out of the field being typed into).
    panel.addEventListener("input", (e) => {
      if (!createState) return;
      if (!e.target.closest("[data-cf-summary],[data-cf-desc],[data-cf-labels]")) return;
      syncCreateFields();
      const btn = panel.querySelector("[data-cf-submit]");
      if (btn) {
        const v = createState.values;
        btn.disabled = !(v.project && v.issueType && (v.summary || "").trim()) || !!createState.busy;
      }
    });
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeCreate(); });
    doc.addEventListener("keydown", (e) => { if (e.key === "Escape" && createState) closeCreate(); });
  }

  const api = { splitLabels, buttonHtml, update, mount };
  if (typeof window !== "undefined") window.TurmaNewTicket = api;
  // Guarded on `document`, not `window`, so a test can stand up a fake window
  // (with a TurmaBoard) before requiring this and still drive mount() itself.
  if (typeof document !== "undefined") mount(document);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
