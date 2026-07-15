// Turma board — pure logic for the /board Kanban page (agents' `jira`
// heartbeat blocks -> one cross-org board). Loaded by board.html in the
// browser (window.TurmaBoard) and require()d directly by tests/board.test.js,
// same dual-export pattern as chat.js. Everything here is pure string/data
// work — no DOM, no fetch — so the merge and the card rendering are unit-
// testable without a browser.
(() => {
  const CATEGORIES = [
    ["todo", "To Do"],
    ["inprogress", "In Progress"],
    ["done", "Done"],
  ];
  const SLOTS = 8; // categorical palette --s1..--s8 (app.css)

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  // Defensive: an unknown/missing statusCategory lands in To Do rather than
  // vanishing (the agent maps Jira's fixed new/indeterminate/done keys, but an
  // older agent or a hand-fed payload might not).
  function categoryOf(t) {
    const c = t && t.statusCategory;
    return c === "inprogress" || c === "done" ? c : "todo";
  }

  function ticketSort(a, b) {
    return String(b.updated || "").localeCompare(String(a.updated || ""));
  }

  // Merge every agent's `jira` block into one entry per Jira site (org).
  //
  // Creds are per-agent and USER-scoped, so two hosts on one site may poll as
  // different users. Step 1: within each (siteKey, user) group only the block
  // with the newest fetchedAt survives — never union two beats of the same
  // user, or a stale block would resurrect tickets a fresh poll no longer
  // returned (e.g. after reassignment). Step 2: union the surviving per-user
  // blocks of each site, deduping tickets by issue key (a strictly newer
  // `updated` wins a collision). This degrades to plain freshest-block-wins
  // when all of a site's agents share one token — the common case.
  function mergeSites(agents) {
    const byUser = new Map();  // siteKey \x00 user -> {block, agent}
    const reporters = new Map(); // siteKey -> {hosts:Set, online:boolean}
    for (const a of agents || []) {
      const j = a && a.jira;
      if (!j || !j.siteKey) continue;
      const site = j.siteKey;
      let rep = reporters.get(site);
      if (!rep) reporters.set(site, rep = { hosts: new Set(), online: false });
      rep.hosts.add(a.device || a.key || "?");
      if (a.online) rep.online = true;
      const key = site + "\x00" + (j.user || "");
      const prev = byUser.get(key);
      if (!prev || String(j.fetchedAt || "") > String(prev.block.fetchedAt || "")) {
        byUser.set(key, { block: j, agent: a });
      }
    }

    const bySite = new Map(); // siteKey -> merged entry
    // Fresher blocks first so a collision keeps the fresher copy by default.
    const winners = [...byUser.values()].sort((x, y) =>
      String(y.block.fetchedAt || "").localeCompare(String(x.block.fetchedAt || "")));
    for (const { block } of winners) {
      const site = block.siteKey;
      let entry = bySite.get(site);
      if (!entry) {
        const rep = reporters.get(site) || { hosts: new Set(), online: false };
        bySite.set(site, entry = {
          siteKey: site,
          users: [],
          hosts: [...rep.hosts].sort(),
          online: rep.online,
          lastFetched: null,
          error: null,
          truncated: false,
          tickets: [],
          _byKey: new Map(),
        });
      }
      if (block.user && !entry.users.includes(block.user)) entry.users.push(block.user);
      if (String(block.fetchedAt || "") > String(entry.lastFetched || "")) {
        entry.lastFetched = block.fetchedAt || entry.lastFetched;
      }
      if (block.error && !entry.error) entry.error = block.error;
      if (block.truncated) entry.truncated = true;
      for (const t of block.tickets || []) {
        if (!t || !t.key) continue;
        const seen = entry._byKey.get(t.key);
        if (!seen) entry._byKey.set(t.key, t);
        else if (String(t.updated || "") > String(seen.updated || "")) {
          entry._byKey.set(t.key, t);
        }
      }
    }
    return [...bySite.values()]
      .map(e => {
        e.tickets = [...e._byKey.values()];
        delete e._byKey;
        e.users.sort();
        return e;
      })
      .sort((x, y) => x.siteKey.localeCompare(y.siteKey));
  }

  // Stable org color: position in the sorted key list -> --s1..--s8 (the same
  // palette trick the history chart uses), so a site keeps its hue as long as
  // the set of sites is stable, regardless of filter or ordering.
  function orgColor(siteKey, allKeys) {
    const i = [...new Set(allKeys)].sort().indexOf(siteKey);
    return `var(--s${(Math.max(i, 0) % SLOTS) + 1})`;
  }

  function ageStr(iso, now) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "";
    const s = Math.max(0, ((now ?? Date.now()) - t) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    if (s < 86400 * 7) return Math.floor(s / 86400) + "d";
    return Math.floor(s / (86400 * 7)) + "w";
  }

  function prioClass(p) {
    const v = String(p || "").toLowerCase();
    if (v === "highest" || v === "high") return "prio-high";
    if (v === "low" || v === "lowest") return "prio-low";
    return "";
  }

  function cardHtml(t, site, opts) {
    const o = opts || {};
    const color = o.color || "var(--muted)";
    const now = o.now;
    const overdue = t.dueDate && categoryOf(t) !== "done" &&
      t.dueDate < new Date(now ?? Date.now()).toISOString().slice(0, 10);
    const bits = [];
    if (t.status) bits.push(`<span class="jira-status">${esc(t.status)}</span>`);
    if (t.priority) {
      bits.push(`<span class="kc-prio ${prioClass(t.priority)}">${esc(t.priority)}</span>`);
    }
    if (t.dueDate) {
      bits.push(`<span class="kc-due${overdue ? " overdue" : ""}">due ${esc(t.dueDate)}</span>`);
    }
    bits.push(`<span class="kc-org" style="--org:${esc(color)}" title="${esc(site && site.siteKey || "")}">${esc(t.project || "")}</span>`);
    return `<div class="kanban-card">
      <div class="kc-top">
        <a class="kc-key" href="${esc(t.url || "#")}" target="_blank" rel="noopener">${esc(t.key)}</a>
        <span class="kc-type">${esc(t.type || "")}</span>
        <span class="kc-age" title="${esc(t.updated || "")}">${esc(ageStr(t.updated, now))}</span>
      </div>
      <div class="kc-summary">${esc(t.summary || "")}</div>
      <div class="kc-meta">${bits.join("")}</div>
    </div>`;
  }

  // The three-column board for the selected sites (filter = a siteKey, or
  // null/"" for all). Sites are the mergeSites() output; allKeys keeps org
  // colors stable across filtering.
  function boardHtml(sites, filter, opts) {
    const o = opts || {};
    const allKeys = o.allKeys || sites.map(s => s.siteKey);
    const shown = sites.filter(s => !filter || s.siteKey === filter);
    const cards = { todo: [], inprogress: [], done: [] };
    for (const site of shown) {
      const color = orgColor(site.siteKey, allKeys);
      for (const t of site.tickets) {
        cards[categoryOf(t)].push({ t, site, color });
      }
    }
    const cols = CATEGORIES.map(([cat, label]) => {
      const list = cards[cat].sort((x, y) => ticketSort(x.t, y.t));
      const body = list.length
        ? list.map(c => cardHtml(c.t, c.site, { color: c.color, now: o.now })).join("")
        : `<div class="kc-none">none</div>`;
      return `<div class="kanban-col${cat === "done" ? " kanban-done" : ""}">
        <div class="kc-head">${label} <span class="kc-count">${list.length}</span></div>
        <div class="kc-list">${body}</div>
      </div>`;
    });
    const notes = [];
    if (shown.some(s => s.truncated)) {
      notes.push(`<div class="kc-note">Some orgs report only their first ${esc(String(o.capNote || "N"))} tickets (truncated).</div>`);
    }
    for (const s of shown) {
      if (s.error) notes.push(`<div class="kc-note kc-err">${esc(s.siteKey)}: last poll failed — ${esc(s.error)} (showing last good data)</div>`);
    }
    return notes.join("") + `<div class="kanban-cols">${cols.join("")}</div>`;
  }

  const api = {
    CATEGORIES, mergeSites, categoryOf, ticketSort, orgColor, ageStr,
    prioClass, cardHtml, boardHtml, esc,
  };
  if (typeof window !== "undefined") window.TurmaBoard = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
