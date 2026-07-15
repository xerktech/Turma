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

  function overdueOf(t, now) {
    return !!(t.dueDate && categoryOf(t) !== "done" &&
      t.dueDate < new Date(now ?? Date.now()).toISOString().slice(0, 10));
  }

  function cardHtml(t, site, opts) {
    const o = opts || {};
    const color = o.color || "var(--muted)";
    const now = o.now;
    const overdue = overdueOf(t, now);
    const bits = [];
    if (t.status) bits.push(`<span class="jira-status">${esc(t.status)}</span>`);
    if (t.priority) {
      bits.push(`<span class="kc-prio ${prioClass(t.priority)}">${esc(t.priority)}</span>`);
    }
    if (t.dueDate) {
      bits.push(`<span class="kc-due${overdue ? " overdue" : ""}">due ${esc(t.dueDate)}</span>`);
    }
    bits.push(`<span class="kc-org" style="--org:${esc(color)}" title="${esc(site && site.siteKey || "")}">${esc(t.project || "")}</span>`);
    // The card itself opens the detail view (data-* carry what the click
    // handler needs to route the fetch: the issue and its owning org). It's a
    // div, not a button, because it contains the kc-key link out to Jira and a
    // nested interactive element would be invalid HTML — hence the explicit
    // role/tabindex, and the handler's own Enter/Space keying.
    return `<div class="kanban-card" role="button" tabindex="0"
      data-key="${esc(t.key)}" data-site="${esc(site && site.siteKey || "")}"
      aria-label="${esc(t.key + ": " + (t.summary || ""))}">
      <div class="kc-top">
        <a class="kc-key" href="${esc(t.url || "#")}" target="_blank" rel="noopener">${esc(t.key)}</a>
        <span class="kc-type">${esc(t.type || "")}</span>
        <span class="kc-age" title="${esc(t.updated || "")}">${esc(ageStr(t.updated, now))}</span>
      </div>
      <div class="kc-summary">${esc(t.summary || "")}</div>
      <div class="kc-meta">${bits.join("")}</div>
    </div>`;
  }

  // --- expanded ticket detail ---------------------------------------------
  // The card only carries what fits on it; description and comments are fetched
  // on demand (GET /api/jira/<siteKey>/<key>, which routes to the host holding
  // that org's creds). So the detail view renders in two passes: immediately
  // from the card's own heartbeat fields, then again once `detail` lands. Pure
  // string work, like everything else here.

  // Plain text (Jira ADF flattened agent-side) -> paragraphs, preserving the
  // blank-line breaks the flattener emits. Escaped, then linkified: a bare URL
  // in a description or comment is usually the point of it (a PR, a log, a
  // spec), so it's worth a click.
  function textHtml(s) {
    const paras = String(s ?? "").split(/\n{2,}/).filter(p => p.trim());
    return paras.map(p => {
      const lines = p.split("\n").map(l => linkify(esc(l))).join("<br>");
      return `<p>${lines}</p>`;
    }).join("");
  }

  // Runs on ALREADY-ESCAPED text, so the pattern can't see a quote or angle
  // bracket — an injected href is impossible. Trailing punctuation is left out
  // of the href ("see https://x/y." shouldn't link the period), as is a
  // trailing "&…;" entity fragment from the escaping.
  function linkify(escaped) {
    return escaped.replace(/https?:\/\/[^\s<]+/g, (m) => {
      const url = m.replace(/(&[a-z]+;|[.,;:!?)\]}]+)+$/i, "");
      if (!url) return m;
      return `<a href="${url}" target="_blank" rel="noopener">${url}</a>` + m.slice(url.length);
    });
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return String(iso);
    const d = new Date(t);
    return d.toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  function fieldRow(label, valueHtml) {
    if (!valueHtml) return "";
    return `<div class="td-field"><dt>${esc(label)}</dt><dd>${valueHtml}</dd></div>`;
  }

  // `t` is the card's ticket (always present); `detail` is the fetched issue
  // (null until it lands). opts: {color, now, siteKey, error, loading}.
  function detailHtml(t, detail, opts) {
    const o = opts || {};
    const d = detail || {};
    // Prefer the fetched copy field-by-field: it's newer than the last board
    // poll, so an issue reprioritized since the beat reads correctly here.
    const v = (k) => (d[k] != null && d[k] !== "" ? d[k] : t[k]);
    const now = o.now;
    const overdue = overdueOf({ dueDate: v("dueDate"), statusCategory: v("statusCategory") }, now);

    const labels = Array.isArray(d.labels) && d.labels.length ? d.labels
      : (Array.isArray(t.labels) ? t.labels : []);
    const fields = [
      fieldRow("Status", v("status") ? `<span class="jira-status">${esc(v("status"))}</span>` : ""),
      fieldRow("Resolution", d.resolution ? esc(d.resolution) : ""),
      fieldRow("Priority", v("priority")
        ? `<span class="kc-prio ${prioClass(v("priority"))}">${esc(v("priority"))}</span>` : ""),
      fieldRow("Type", v("type") ? esc(v("type")) : ""),
      fieldRow("Assignee", d.assignee ? esc(d.assignee) : ""),
      fieldRow("Reporter", d.reporter ? esc(d.reporter) : ""),
      fieldRow("Project", v("projectName")
        ? `${esc(v("projectName"))} <span class="td-dim">(${esc(v("project") || "")})</span>`
        : (v("project") ? esc(v("project")) : "")),
      fieldRow("Parent", v("parentKey")
        ? esc(v("parentKey")) + (d.parentSummary ? ` <span class="td-dim">${esc(d.parentSummary)}</span>` : "")
        : ""),
      fieldRow("Created", v("created") ? esc(fmtDate(v("created"))) : ""),
      fieldRow("Updated", v("updated") ? esc(fmtDate(v("updated"))) : ""),
      fieldRow("Due", v("dueDate")
        ? `<span class="${overdue ? "kc-due overdue" : "kc-due"}">${esc(v("dueDate"))}</span>` : ""),
      fieldRow("Labels", labels.length
        ? labels.map(l => `<span class="td-label">${esc(l)}</span>`).join(" ") : ""),
    ].join("");

    // Description/comments only exist once the fetch lands, so until then this
    // section carries the loading or error state rather than an empty void.
    let body;
    if (o.error) {
      body = `<div class="td-note td-err">Couldn't load the full ticket — ${esc(o.error)}. <a href="${esc(v("url") || "#")}" target="_blank" rel="noopener">Open in Jira</a> instead.</div>`;
    } else if (!detail) {
      body = `<div class="td-note">Loading description and comments…</div>`;
    } else {
      const desc = d.description
        ? textHtml(d.description) +
          (d.descriptionTruncated ? `<div class="td-note">Description truncated — <a href="${esc(v("url") || "#")}" target="_blank" rel="noopener">read the rest in Jira</a>.</div>` : "")
        : `<div class="td-none">No description.</div>`;
      const comments = d.comments || [];
      const dropped = Math.max(0, (d.commentTotal || comments.length) - comments.length);
      const cHtml = comments.length
        ? comments.map(c => `<div class="td-comment">
            <div class="td-chead"><span class="td-cauthor">${esc(c.author || "Unknown")}</span>
              <span class="td-cwhen" title="${esc(c.created || "")}">${esc(ageStr(c.updated || c.created, now))}</span></div>
            <div class="td-cbody">${textHtml(c.body)}${c.truncated ? `<div class="td-note">Comment truncated.</div>` : ""}</div>
          </div>`).join("")
        : `<div class="td-none">No comments.</div>`;
      body = `<section class="td-section">
          <h3>Description</h3>${desc}
        </section>
        <section class="td-section">
          <h3>Comments <span class="td-dim">${d.commentTotal || comments.length}</span></h3>
          ${dropped ? `<div class="td-note">Showing the ${comments.length} newest — <a href="${esc(v("url") || "#")}" target="_blank" rel="noopener">${dropped} older in Jira</a>.</div>` : ""}
          ${cHtml}
        </section>`;
    }

    const color = o.color || "var(--muted)";
    return `<div class="td-head">
        <div class="td-crumbs">
          <span class="kc-org" style="--org:${esc(color)}" title="${esc(o.siteKey || "")}">${esc(v("project") || "")}</span>
          <a class="kc-key" href="${esc(v("url") || "#")}" target="_blank" rel="noopener">${esc(t.key)}</a>
          <span class="kc-type">${esc(v("type") || "")}</span>
        </div>
        <button class="td-close" type="button" aria-label="Close">✕</button>
      </div>
      <h2 class="td-summary">${esc(v("summary") || "")}</h2>
      <dl class="td-fields">${fields}</dl>
      ${body}
      <div class="td-foot"><a href="${esc(v("url") || "#")}" target="_blank" rel="noopener">Open in Jira ↗</a></div>`;
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
    prioClass, cardHtml, boardHtml, detailHtml, textHtml, linkify, fmtDate, esc,
  };
  if (typeof window !== "undefined") window.TurmaBoard = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
