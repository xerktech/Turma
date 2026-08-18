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
// The filter value is a SET of full siteKeys (what the hub keys and routes
// on), never display org names; an empty set means every org. Multi-select
// (XERK-222): each menu row toggles its org in and out of the set and stays
// highlighted while selected — the menu stays open across toggles so several
// orgs can be picked in one visit; "All orgs" clears the set. Persisted as a
// JSON array; a pre-multi single-siteKey value reads as a one-org selection,
// so an existing pick survives the upgrade. The per-org auto-start switch
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
    // STRINGS only, matching `siteKeyOf` in turma/server.js, which this mirrors
    // and which that file cross-references by name. `jira` is agent-supplied and
    // an object key would otherwise be compared by reference here while the hub
    // reads it as "no org" — the two ends disagreeing about what an org IS.
    const v = agent && agent.jira && agent.jira.siteKey;
    return typeof v === "string" ? v : "";
  }

  // Normalize a selection — "", a single siteKey, an array or a Set — to an
  // array of siteKeys, so every pure function below takes any of the shapes a
  // caller may still hold.
  function keysOf(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.filter(Boolean);
    if (v instanceof Set) return [...v].filter(Boolean);
    return [v];
  }

  // The fleet, scoped to the selected orgs (empty selection = every org).
  // Deliberately NOT board.js's filterSites fallback ("unknown filter shows
  // everything") — that rule is about a site list, and here the caller has
  // already resolved the selection through effectiveKeys(), which is where a
  // stale pick self-heals.
  function filterAgents(agents, keys) {
    const list = agents || [];
    const sel = keysOf(keys);
    if (!sel.length) return list;
    return list.filter(a => sel.includes(siteKeyOf(a)));
  }

  // A stored pick only counts while some host still reports that org — an org
  // whose last agent was removed must not leave every page filtered down to
  // nothing with no way back. The stored value is KEPT (a host that comes back
  // resumes its filter); each key just doesn't apply while nothing reports it.
  function effectiveKeys(keys, sites) {
    const list = sites || [];
    return keysOf(keys).filter(k => list.some(s => s.siteKey === k));
  }

  function autoOn(map, siteKey) {
    return !!(map && map[siteKey]);
  }

  // The header button: the current scope, one dot per selected org, each
  // coloured by that org's palette slot so it matches its cards and columns
  // everywhere else. One org shows its name; several show a count.
  function buttonHtml(sites, keys, colorMap, open) {
    const B = board();
    const sel = keysOf(keys);
    const picked = (sites || []).filter(s => sel.includes(s.siteKey));
    const label = !picked.length ? "All orgs"
      : picked.length === 1 ? B.orgName(picked[0].siteKey, picked[0].orgName)
      : `${picked.length} orgs`;
    const dots = picked.map(s => {
      const color = colorMap.get(s.siteKey) || B.orgColor(s.siteKey);
      return `<span class="org-dot" aria-hidden="true"${color ? ` style="--org:${esc(color)}"` : ""}></span>`;
    }).join("");
    return `<button type="button" class="org-btn${picked.length ? " scoped" : ""}" data-org-toggle
      aria-haspopup="true" aria-expanded="${open ? "true" : "false"}"
      title="${picked.length ? "Showing " + esc(label) + " only — click to change" : "Filter every page by org"}">` +
      (dots || `<span class="org-dot" aria-hidden="true"></span>`) +
      `<span class="org-btn-label">${esc(label)}</span>` +
      `<span class="org-chev" aria-hidden="true">▾</span></button>`;
  }

  // The swatch strip an org row expands into when its color chip is clicked
  // (XERK-145): one swatch per palette slot — the pinned one marked — plus an
  // "auto" release back to the hash-assigned color. Every option is a complete
  // answer, so a click saves and closes (the repo/agent picker contract).
  function swatchRowHtml(siteKey, pin) {
    const B = board();
    const slots = B.SLOTS || 8;
    const cells = [];
    for (let n = 1; n <= slots; n++) {
      cells.push(
        `<button type="button" class="org-swatch${pin === n ? " picked" : ""}"` +
        ` data-org-swatch="${n}" data-org-swatch-key="${esc(siteKey)}"` +
        ` style="--org:var(--s${n})" aria-pressed="${pin === n ? "true" : "false"}"` +
        ` title="Color ${n}${pin === n ? " (current)" : ""}"></button>`);
    }
    return `<div class="org-swatch-row" data-org-swatch-row="${esc(siteKey)}">${cells.join("")}` +
      `<button type="button" class="org-swatch-auto${pin ? "" : " picked"}"` +
      ` data-org-swatch="auto" data-org-swatch-key="${esc(siteKey)}"` +
      ` title="Let the palette assign this org's color">auto</button></div>`;
  }

  // The menu: "All orgs" plus one row per reporting org. Each named row is three
  // segments — the scope toggle, the org's color chip (XERK-145), and its
  // auto-start switch — the divided-pill shape the board chips carried, laid
  // out as a list. Rows are checkboxes, not radios (XERK-222): a click toggles
  // that org's membership in the selection and the row stays highlighted while
  // it's in; any number can be on at once. `colorFor` is the org whose swatch
  // strip is expanded.
  function menuHtml(sites, keys, colorMap, autoMap, ageStr, colorPins, colorFor) {
    const B = board();
    const sel = keysOf(keys);
    const total = (sites || []).reduce((n, s) => n + (s.tickets || []).length, 0);
    const rows = [
      `<div class="org-row${sel.length ? "" : " active"}">` +
      `<button type="button" class="org-row-main" data-org-key="" role="menuitemcheckbox"` +
      ` aria-checked="${sel.length ? "false" : "true"}">` +
      `<span class="org-row-name">All orgs</span>` +
      `<span class="chip-n">${total}</span></button></div>`,
    ];
    for (const s of sites || []) {
      const color = colorMap.get(s.siteKey) || B.orgColor(s.siteKey, null, colorPins);
      const on = autoOn(autoMap, s.siteKey);
      const hosts = (s.hosts || []).length;
      const age = s.online ? "" : (ageStr ? ageStr(s.lastFetched) : "");
      const picked = sel.includes(s.siteKey);
      rows.push(
        `<div class="org-row${picked ? " active" : ""}" style="--org:${esc(color)}">` +
        `<button type="button" class="org-row-main has-dot" data-org-key="${esc(s.siteKey)}"` +
        ` role="menuitemcheckbox" aria-checked="${picked ? "true" : "false"}"` +
        ` title="${esc(s.siteKey)} · ${hosts} host${hosts === 1 ? "" : "s"}">` +
        `<span class="org-dot" aria-hidden="true"></span>` +
        `<span class="org-row-name">${esc(B.orgName(s.siteKey, s.orgName))}</span>` +
        `<span class="chip-n">${(s.tickets || []).length}</span>` +
        (s.online ? "" : `<span class="chip-stale" title="No host reporting this org is online — showing its last report">⚠ offline${age ? " · synced " + esc(age) + " ago" : ""}</span>`) +
        `</button>` +
        `<button type="button" class="org-chip-color" data-org-color="${esc(s.siteKey)}"` +
        ` aria-expanded="${colorFor === s.siteKey ? "true" : "false"}"` +
        ` title="Change this org's color"><span class="org-color-dot" aria-hidden="true"></span></button>` +
        `<button type="button" class="org-chip-auto${on ? " on" : ""}" data-org-auto="${esc(s.siteKey)}"` +
        ` aria-pressed="${on ? "true" : "false"}"` +
        ` title="Auto-start a session for every To Do ticket with a repo — ${on ? "ON, click to turn off" : "OFF, click to turn on"} (Done tickets always kill their session)">` +
        `<span class="org-auto-dot" aria-hidden="true"></span>auto</button></div>`);
      if (colorFor === s.siteKey) {
        // orgSlotPin validates (0-based or null); the strip marks the 1-based slot.
        const pin = B.orgSlotPin ? B.orgSlotPin(colorPins, s.siteKey) : null;
        rows.push(swatchRowHtml(s.siteKey, pin === null ? null : pin + 1));
      }
    }
    return `<div class="org-menu" role="menu">${rows.join("")}</div>`;
  }

  function controlHtml(sites, keys, colorMap, autoMap, open, ageStr, colorPins, colorFor) {
    return `<span class="org-filter${open ? " open" : ""}">` +
      buttonHtml(sites, keys, colorMap, open) +
      (open ? menuHtml(sites, keys, colorMap, autoMap, ageStr, colorPins, colorFor) : "") +
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
  let stored = [];        // what localStorage says, whether or not it applies
  let sites = [];         // the orgs the fleet currently reports
  let autoMap = {};       // the hub's per-org auto-start opt-in
  let colorPins = {};     // the hub's manual org-color pins (XERK-145)
  let colorFor = null;    // the org whose swatch strip is expanded, or null
  let open = false;
  let slot = null;
  let painted = "";       // last markup written, so a beat repaint is a no-op

  // The persisted value is a JSON array of siteKeys ("" for none). A pre-multi
  // value — this key's own old single-siteKey format, or the board-era legacy
  // key's — is a bare string, which reads as a one-org selection, so an
  // operator's existing pick survives the upgrade to multi-select.
  function parseStored(raw) {
    if (!raw) return [];
    if (raw[0] === "[") {
      try {
        const a = JSON.parse(raw);
        if (Array.isArray(a)) return a.filter(k => typeof k === "string" && k);
      } catch { /* malformed — treat as no selection */ }
      return [];
    }
    return [raw];
  }

  function encodeStored(keys) {
    return keys.length ? JSON.stringify(keys) : "";
  }

  function readStored() {
    try {
      const v = localStorage.getItem(KEY);
      if (v !== null) return parseStored(v);
      // One-time migration off the board-only key.
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) { localStorage.setItem(KEY, legacy); return parseStored(legacy); }
    } catch { /* private mode / no storage — the filter is just not persisted */ }
    return [];
  }

  // The selection as it APPLIES right now (a pick for an org nobody reports
  // doesn't) — an array of siteKeys, empty meaning every org.
  function getKeys() {
    return effectiveKeys(stored, sites);
  }

  // Single-key back-compat read: the selected org when exactly one applies,
  // else "" — what a caller that can only use one org (the new-ticket form's
  // seed) wants, and what older stubs expect.
  function get() {
    const keys = getKeys();
    return keys.length === 1 ? keys[0] : "";
  }

  function notify() {
    for (const fn of listeners) { try { fn(getKeys()); } catch { /* a page's own repaint */ } }
  }

  function persist() {
    try { localStorage.setItem(KEY, encodeStored(stored)); } catch { /* not persisted */ }
  }

  // Replace the whole selection (the "All orgs" row passes []). Accepts any of
  // keysOf's shapes, so set("acme") still means "just acme".
  function set(keys) {
    const next = keysOf(keys);
    if (encodeStored(next) === encodeStored(stored)) { close(); paint(); return; }
    stored = next;
    persist();
    close();
    paint();
    notify();
  }

  // Flip one org in or out of the selection (XERK-222). The menu deliberately
  // STAYS OPEN — multi-select means picking several in one visit, and closing
  // on each toggle would make that three open-click round trips.
  function toggle(key) {
    if (!key) { set([]); return; }
    stored = stored.includes(key) ? stored.filter(k => k !== key) : [...stored, key];
    persist();
    paint();
    notify();
  }

  function subscribe(fn) {
    if (typeof fn === "function") listeners.push(fn);
  }

  function close() { open = false; colorFor = null; }

  // Feed the control the heartbeat every page already has. Cheap on a settled
  // fleet: the markup is rebuilt but only written when it actually changed, so
  // a 1s beat doesn't churn the DOM (or drop an open menu's hover).
  function update(data) {
    const B = board();
    sites = B.mergeSites((data && data.agents) || []);
    if (data && data.autoStartOrgs) autoMap = data.autoStartOrgs;
    if (data && data.orgColors) colorPins = data.orgColors;
    paint();
  }

  function paint() {
    if (!slot) return;
    const B = board();
    const keys = getKeys();
    const colorMap = B.orgColorMap(sites.map(s => s.siteKey), colorPins);
    // Nothing to scope by until at least one host reports a tracker org, so the
    // slot stays empty and collapses (#hdrOrg:empty in app.css) rather than
    // offering a menu whose only entry is "All orgs".
    const html = sites.length ? controlHtml(sites, keys, colorMap, autoMap, open, B.ageStr, colorPins, colorFor) : "";
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

  // Pin an org's palette slot (1..8), or release it back to auto (slot null) —
  // XERK-145. Hub-owned durable state like the auto-start opt-in, painted
  // optimistically and rolled back if the POST fails. notify() runs on every
  // change so each page repaints its org-tinted cards at once — every page
  // reads the pins through orgColors() below, so a repaint sees the new map.
  async function setOrgColor(siteKey, slotN) {
    const prev = colorPins;
    colorPins = Object.assign({}, colorPins);
    if (slotN) colorPins[siteKey] = slotN; else delete colorPins[siteKey];
    colorFor = null;
    paint();
    notify();
    let ok = false;
    try {
      const r = await fetch(`/api/jira/${encodeURIComponent(siteKey)}/color`,
        { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(slotN ? { slot: slotN } : { auto: true }) });
      if (r.status === 401) { location.href = "/login"; return; }
      ok = r.ok;
    } catch { /* network error — fall through to rollback */ }
    if (!ok) {
      colorPins = prev;
      paint();
      notify();
    }
  }

  // The current org-color pins, for the pages' own card tints: one live source
  // (fed by update() and the SSE event), so a pin lands everywhere at once.
  function orgColors() { return colorPins; }

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
    es.addEventListener("orgColors", (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      colorPins = m || {};
      paint();
      // The pins tint cards on every page, so a change (this tab's or another's)
      // repaints more than this control.
      notify();
    });
  }

  function mount(doc) {
    slot = doc.getElementById("hdrOrg");
    if (!slot) return;
    // A freshly-mounted control starts closed, with nothing painted and nothing
    // known about the fleet — it learns the orgs from the first update().
    painted = ""; open = false; sites = []; autoMap = {}; colorPins = {}; colorFor = null;
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
      const swatch = e.target.closest("[data-org-swatch]");
      if (swatch) {
        const v = swatch.dataset.orgSwatch;
        setOrgColor(swatch.dataset.orgSwatchKey, v === "auto" ? null : Number(v));
        return;
      }
      const colorChip = e.target.closest("[data-org-color]");
      if (colorChip) {
        const k = colorChip.dataset.orgColor;
        colorFor = colorFor === k ? null : k;
        paint();
        return;
      }
      const pick = e.target.closest("[data-org-key]");
      // An org row toggles and keeps the menu open; the empty key is the
      // "All orgs" row, which clears the selection and closes.
      if (pick) { toggle(pick.dataset.orgKey); return; }
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
      stored = parseStored(e.newValue || "");
      paint();
      notify();
    });
    paint();
  }

  const api = {
    KEY, LEGACY_KEY, esc,
    siteKeyOf, keysOf, filterAgents, effectiveKeys, autoOn, parseStored, encodeStored,
    buttonHtml, menuHtml, controlHtml, swatchRowHtml,
    get, getKeys, set, toggle, subscribe, update, sse, setAutoStart, setOrgColor, orgColors, mount,
    // The common call site: scope the beat's fleet to the current selection.
    filter(agents) { return filterAgents(agents, getKeys()); },
  };
  if (typeof window !== "undefined") window.TurmaOrg = api;
  // Guarded on `document`, not `window`: the tests put a stand-in TurmaBoard on
  // a fake global `window` before requiring this, and must still drive mount()
  // themselves against their own document shim.
  if (typeof document !== "undefined") mount(document);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
