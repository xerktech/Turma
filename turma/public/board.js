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
    ["review", "In Review"],
    ["done", "Done"],
  ];
  const SLOTS = 8; // categorical palette --s1..--s8 (app.css)

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  // "In Review"/"Testing" statuses live in Jira's `indeterminate` category
  // (which the agent maps to `inprogress`) — there is no fourth cross-org
  // category for them. So the In Review column is carved out of `inprogress`
  // by matching the org-specific status NAME rather than the category. Matched
  // on word boundaries so "Attestation" or "Contest" can't leak in, but "In
  // Review", "Code Review", "Testing", "In Test", "QA" all land here.
  const REVIEW_STATUS_RE = /\b(review|reviewing|testing|test|qa)\b/i;

  function isReviewStatus(t) {
    return REVIEW_STATUS_RE.test(String((t && t.status) || ""));
  }

  // Defensive: an unknown/missing statusCategory lands in To Do rather than
  // vanishing (the agent maps Jira's fixed new/indeterminate/done keys, but an
  // older agent or a hand-fed payload might not). An `inprogress` ticket whose
  // status name reads as review/testing is pulled into the `review` column —
  // only from inprogress, so a Done ("Testing complete") or To Do ticket keeps
  // its category and can't be yanked backward/forward by its name alone.
  function categoryOf(t) {
    const c = t && t.statusCategory;
    const base = c === "inprogress" || c === "done" ? c : "todo";
    if (base === "inprogress" && isReviewStatus(t)) return "review";
    return base;
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
    const reporters = new Map(); // siteKey -> {hosts:Set, online:boolean, repos:Map}
    for (const a of agents || []) {
      const j = a && a.jira;
      if (!j || !j.siteKey) continue;
      const site = j.siteKey;
      let rep = reporters.get(site);
      if (!rep) {
        reporters.set(site, rep = {
          hosts: new Set(), online: false, repos: new Map(), hostOpts: new Map() });
      }
      rep.hosts.add(a.device || a.key || "?");
      if (a.online) rep.online = true;
      // The manual picker's repo choices, unioned over EVERY host reporting this
      // org — collected here, alongside the hosts, rather than in the winners
      // loop below. The blocks that survive `byUser` are one per (site, user),
      // and the common case is that an org's hosts all poll as the SAME user, so
      // the winners loop sees exactly one of them: the picker would then offer
      // whichever host happened to poll Jira last, and a repo cloned only on the
      // other would vanish from the dropdown.
      //
      // `cloned` is host-relative and a cloned copy wins the dedupe: the pin fans
      // out to every host anyway, and "someone here has it" is the useful claim.
      for (const o of j.repoOptions || []) {
        if (!o || !o.name) continue;
        const seen = rep.repos.get(o.name);
        if (!seen || (o.cloned && !seen.cloned)) rep.repos.set(o.name, o);
      }
      // The agent-pin picker's host choices (XERK-38): every host reporting
      // this org, online or not — a pin is a persistent choice about future
      // spawns, so a momentarily-offline host is still a valid answer (the
      // picker marks it; the spawn itself requires it online). Keyed on the
      // hub's agent key, which is what the /agent endpoint validates against.
      const hk = a.key || a.device;
      if (hk) {
        rep.hostOpts.set(hk, {
          key: hk, name: a.device || hk, online: !!a.online });
      }
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
        const rep = reporters.get(site) ||
          { hosts: new Set(), online: false, repos: new Map(), hostOpts: new Map() };
        bySite.set(site, entry = {
          siteKey: site,
          users: [],
          hosts: [...rep.hosts].sort(),
          online: rep.online,
          lastFetched: null,
          error: null,
          truncated: false,
          tickets: [],
          // Cloned repos first (the ones you can work in today), then by name —
          // the picker's own order, so it doesn't inherit the scan's.
          repoOptions: [...rep.repos.values()].sort((x, y) =>
            (y.cloned ? 1 : 0) - (x.cloned ? 1 : 0) || x.name.localeCompare(y.name)),
          // Online hosts first (the ones a pin would route to today), then by
          // name — the agent picker's own order.
          hostOptions: [...rep.hostOpts.values()].sort((x, y) =>
            (y.online ? 1 : 0) - (x.online ? 1 : 0) || x.name.localeCompare(y.name)),
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

  // A siteKey identifies a board's org, but the org name is the only part of it a
  // human reads, so every surface that shows a site to one shows this instead —
  // the board's org chips and the dashboard's host rows. The full siteKey stays
  // the identity everything is keyed and routed on; this is presentational only.
  //
  // Two siteKey shapes, two derivations:
  //   - Jira Cloud is a bare host ("myorg.atlassian.net"); strip the `.atlassian.net`
  //     suffix, leaving the org. A non-Atlassian bare host IS the org's name there.
  //   - Azure DevOps carries an org/collection PATH ("dev.azure.com/myorg",
  //     "tfs.co/DefaultCollection"); the last path segment is the org/collection,
  //     which is the readable identity — the host alone would name every unrelated
  //     org the same.
  function orgName(siteKey) {
    let s = String(siteKey ?? "");
    if (s.includes("/")) {
      const segs = s.split("/").filter(Boolean);
      return segs[segs.length - 1] || s;
    }
    return s.replace(/\.atlassian\.net$/i, "");
  }

  // Whether an org is opted in to auto-start, for the org-chip switch (XERK-41).
  // Hub-only: it's the hub-owned per-org toggle (data.autoStartOrgs) and nothing
  // else — no agent-side flag — so a click freely turns it on and off.
  function autoStartOn(autoStartOrgs, siteKey) {
    return !!(autoStartOrgs && autoStartOrgs[siteKey]);
  }

  // Stable org color: hash the siteKey itself into a --s1..--s8 palette slot
  // (the categorical palette in app.css). Deriving the slot from the KEY —
  // rather than the key's position in the current set of orgs, as this once did
  // — is what makes the color PERSISTENT: it no longer moves when a host (hence
  // an org) is added to or removed from the fleet, which used to reshuffle every
  // org's hue (XERK-48). The trade is that two distinct orgs can hash to the same
  // slot (it's a hash, not a distinct-per-org assignment) — a cosmetic collision,
  // accepted so a given org keeps one color for good. djb2 over the key's chars.
  function orgColor(siteKey) {
    const s = String(siteKey || "");
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return `var(--s${(h % SLOTS) + 1})`;
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

  // The agent's guessed repo for a ticket (see the Jira -> repo triage section
  // in hub-agent.py), as a card chip. Three states, deliberately distinct:
  //   - a repo cloned on the reporting host  -> plain chip, ready to work in
  //   - a repo only in the org's gh listing  -> dashed chip, needs cloning first
  //   - the model declined (no repo fits)    -> greyed "no repo"
  // A ticket with no `repoGuess` at all hasn't been triaged yet and gets NO chip:
  // that is not the same claim as "no repo fits", and it resolves within a beat
  // or two. The reason rides as a tooltip — it's a rationale, not a headline.
  function repoChipHtml(t) {
    const g = t && t.repoGuess;
    if (!g) return "";
    if (!g.repo) {
      return `<span class="kc-repo kc-repo-none" title="No repository fits this ticket">no repo</span>`;
    }
    const cls = g.cloned ? "kc-repo" : "kc-repo kc-repo-uncloned";
    const tip = [
      g.cloned ? "" : "not cloned on this host",
      g.reason || "",
    ].filter(Boolean).join(" — ");
    return `<span class="${cls}" title="${esc(tip || g.repo)}">${esc(g.repo)}</span>`;
  }

  // --- ticket -> session link ----------------------------------------------
  // The agent stamps the ticket onto the session record it spawns (session.ticket
  // = {key, siteKey, url, summary, branch}); this indexes the fleet payload the
  // board already polls to walk that link backwards, keyed "<siteKey>\x00<key>".
  // Nothing is written to Jira — the link lives in Turma only, and there is no
  // hub-side ticket store to keep in sync.
  //
  // It reads the same THREE channels the Sessions page's Ended list merges, for
  // the same reason: an operator asking "which session worked PROJ-123" draws no
  // distinction between them, and reading only the live registry meant a ticket
  // forgot its work the instant that work was killed.
  //   - a.sessions        live + stopped, registry-backed.
  //   - a.closedSessions  killed. Carries `ticket` off the closed record.
  //   - repo.resumable    the durable side: re-derived every slow beat from the
  //                       transcripts on disk, so it survives an agent restart
  //                       and outlives closed.json's CLOSED_PER_REPO cap. Its
  //                       ticket comes from the agent's transcript -> ticket
  //                       ledger, since a transcript knows nothing of Jira.
  //
  // Deduped on transcriptId with the registry-backed record winning — a killed
  // session is reported through BOTH its closed record and (once the slow scan
  // catches up) resumable, and only the record knows its id, its createdAt and
  // that it was renamed.
  //
  // A session restarted with "clear context" legitimately contributes a second
  // chip: its pre-restart conversation is a different transcript, still on disk
  // and still separately resumable, and both really did work the ticket. That is
  // the same thing the Ended list shows.
  function ticketSessionIndex(agents) {
    const idx = new Map();
    const seen = new Set();          // "<host>\x00<transcriptId>" — dedupe key
    const add = (s, a) => {
      const t = s && s.ticket;
      if (!t || !t.key) return;
      const host = a.key || a.device;
      const tid = s.transcriptId;
      // Untranscripted records can't collide (nothing to key on) and are rare:
      // a session killed before its first turn, or one an older agent wrote.
      if (tid) {
        const dk = host + "\x00" + tid;
        if (seen.has(dk)) return;
        seen.add(dk);
      }
      const k = (t.siteKey || "") + "\x00" + t.key;
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push({ ...s, host });
    };
    for (const a of agents || []) {
      for (const s of a.sessions || []) add(s, a);
      for (const c of a.closedSessions || []) add(c, a);
    }
    // Resumable last, and in its own pass over the whole fleet: it is the weakest
    // channel, so every registry-backed record must already be in `seen` before
    // it gets a look — otherwise a killed session reported by a host listed later
    // would lose to its own scan entry and show up id-less.
    for (const a of agents || []) {
      for (const r of a.repos || []) {
        for (const t of r.resumable || []) add(t, a);
      }
    }
    // Oldest first: the first session on a ticket is the one holding the bare
    // PROJ-123 branch, so the chips read in the order the branches were cut. A
    // resumable entry has no createdAt — it was never a record — so it sorts on
    // when its conversation last spoke, the only timestamp its scan recovers.
    const at = (s) => String(s.createdAt || s.endedTs || "");
    for (const list of idx.values()) {
      list.sort((x, y) => at(x).localeCompare(at(y)));
    }
    return idx;
  }

  function ticketSessionsOf(idx, siteKey, key) {
    return (idx && idx.get((siteKey || "") + "\x00" + key)) || [];
  }

  // One of a ticket's sessions, as a chip linking into it. The dot carries the
  // run state, read from the session's own live record — so the card says what
  // that work is actually doing, not merely that it was once started.
  //
  // The label is the BRANCH, not the session name: a ticket-spawned session is
  // named from its ticket, so its name just repeats the key and summary already
  // printed on this card, while the branch (-1, -2) is the one thing that tells
  // two sessions on one ticket apart. The live branch wins over the reserved one
  // — the reservation is what the agent was TOLD, git is what it did. An operator
  // who renames a session means that name, so it leads once it exists; a session
  // that has neither yet falls back to its id, and one recovered from the
  // transcript scan (which never had an id) to its ticket key.
  //
  // WHERE IT LINKS follows the run state, not the channel it arrived on, because
  // that is what the Sessions page can actually open:
  //   - running -> ?session=<id>, the live chat view.
  //   - anything else -> ?ended=<transcriptId>, the read-only view. Its deep-link
  //     wait only ever resolves a RUNNING session, so pointing a stopped/killed
  //     chip at ?session= parks the page on "Opening session…" forever. That bug
  //     was reachable before this ever read the ended channels: a `stopped`
  //     registry session is in a.sessions and has never been openable live.
  //   - no transcript at all -> not a link. A session killed before its first
  //     turn has no conversation to open, and an <a> to nothing is worse than
  //     plain text saying so.
  function sessionChipHtml(s) {
    const branch = (s.git && s.git.branch) || (s.ticket && s.ticket.branch);
    const renamed = s.summaryManual ? s.summary : null;
    const label = renamed || branch || s.summary || s.label || s.id
      || (s.ticket && s.ticket.key) || "session";
    const stopped = s.status !== "running";
    const state = s.status === "error" ? "failed"
      : s.status === "queued" ? "queued"
      : (stopped ? "stopped" : "running");
    const tip = [s.summary || s.label, branch && branch !== label ? "branch " + branch : "", state]
      .filter(Boolean).join(" · ");
    const cls = "kc-sess" + (s.status === "error" ? " kc-sess-err" : stopped ? " kc-sess-off" : "");
    // The label is its own element so it can ellipsise: .kc-sess is a flex
    // container, and text-overflow can't touch anonymous flex content — it would
    // hard-cut mid-letter. As a flex ITEM this span is blockified, so it can.
    const body = `<span class="kc-sess-dot"></span><span class="kc-sess-name">${esc(label)}</span>`;
    const href = !stopped && s.id
      ? `/sessions?session=${encodeURIComponent(s.id)}`
      : (s.transcriptId ? `/sessions?ended=${encodeURIComponent(s.transcriptId)}` : null);
    if (!href) {
      return `<span class="${cls}" title="${esc(tip ? tip + " · no conversation" : label)}"
        >${body}</span>`;
    }
    return `<a class="${cls}" href="${href}" title="${esc(tip || label)}">${body}</a>`;
  }

  // The card's session control: its sessions, plus the button that starts one.
  // `start` is this ticket's in-flight state ({pending} | {error}), or null.
  // States, in the order they're decided:
  //   - no triaged repo    -> no button at all. There is nothing to start against,
  //                           and the repo chip beside this already says why (a
  //                           "no repo" verdict, or no chip while untriaged).
  //   - a spawn in flight  -> a busy marker. The session id doesn't exist until
  //                           the agent mints it a beat later, so this covers the
  //                           gap the POST can't.
  //   - a spawn in flight  -> a busy marker. The session id doesn't exist until
  //                           the agent mints it a beat later, so this covers the
  //                           gap the POST can't.
  //   - repo not cloned     -> a LIVE start button that clones on demand. The hub
  //                           routes to the most-available host in the org, which
  //                           clones the repo and queues the session behind it, so
  //                           "not cloned anywhere" is no longer a dead end — the
  //                           tooltip just says it'll clone first.
  //   - ready              -> the start button.
  // A failed start renders its reason BESIDE a live button rather than replacing
  // it: every failure here is a fleet-state one (no online host, not triaged yet),
  // so the operator needs both the reason and the retry.
  // Once a ticket has sessions the button stays, compacted to a "+": a second
  // session on one ticket is supported (it gets the -1/-2 branch), just not the
  // common case, so it stops competing with the chips for the card's width.
  function ticketStartHtml(t, sessions, start) {
    const g = t && t.repoGuess;
    const chips = (sessions || []).map(sessionChipHtml).join("");
    if (!g || !g.repo) return chips;
    const st = start || {};
    if (st.pending) {
      return chips + `<span class="kc-start kc-start-busy"
        title="Starting a session for ${esc(t.key)}…">⏳ starting…</span>`;
    }
    const err = st.error
      ? `<span class="kc-start-err" title="${esc(st.error)}">⚠ ${esc(st.error)}</span>`
      : "";
    const more = (sessions || []).length > 0;
    const tip = more
      ? `Start another session on ${t.key} — it gets its own branch`
      : g.cloned
        ? `Start a session on ${t.key} in ${g.repo}`
        : `Start a session on ${t.key} — ${g.repo} isn't cloned yet, so it clones first`;
    // A not-yet-cloned repo gets a distinct label so the extra step is visible,
    // but the button is live either way.
    const label = more ? "+" : (g.cloned ? "☐ Start session" : "☐ Start (clone first)");
    return chips + err + `<button class="kc-start${more ? " kc-start-more" : ""}${g.cloned ? "" : " kc-start-clone"}" type="button"
      data-start="${esc(t.key)}" title="${esc(tip)}"
      aria-label="${esc(tip)}">${label}</button>`;
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
    const repo = repoChipHtml(t);
    if (repo) bits.push(repo);
    const start = ticketStartHtml(t, o.sessions, o.start);
    if (start) bits.push(start);
    bits.push(`<span class="kc-org" style="--org:${esc(color)}" title="${esc(site && site.siteKey || "")}">${esc(t.project || "")}</span>`);
    // The card itself opens the detail view (data-* carry what the click
    // handler needs to route the fetch: the issue and its owning org). It's a
    // div, not a button, because it contains the kc-key link out to Jira, the
    // start button and any session chips — nested interactive elements, which a
    // real <button> could not legally hold — hence the explicit role/tabindex,
    // and the handler's own Enter/Space keying. Each of those children is
    // early-returned by the board's delegated handlers so it does its own thing
    // rather than also opening the panel.
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

  // The triaged repo, for the detail panel's field list: the same three states as
  // the card chip, but with room to say what the chip could only imply — plus the
  // Change control, since this row is the one place with room to correct it.
  //
  // A manual pin says so rather than dressing itself as a guess: the rationale
  // line is the model's reasoning, and an operator's choice has none to show.
  function repoFieldHtml(t, opts) {
    const o = opts || {};
    const g = t && t.repoGuess;
    const bits = [];
    if (!g) {
      // Untriaged. The chip renders nothing here (absence isn't "no repo fits"),
      // but the row still appears so the operator can answer before the model
      // does — a ticket nobody has classified is exactly one worth pinning.
      bits.push(`<span class="td-dim">Not triaged yet</span>`);
    } else if (!g.repo) {
      bits.push(`<span class="td-dim">${g.manual
        ? "No repository — set by you"
        : "No repository fits this ticket"}</span>`);
    } else {
      bits.push(`<span class="kc-repo${g.cloned ? "" : " kc-repo-uncloned"}">${esc(g.repo)}</span>`);
      if (g.nameWithOwner && g.nameWithOwner !== g.repo) {
        bits.push(`<span class="td-dim">${esc(g.nameWithOwner)}</span>`);
      }
      if (!g.cloned) bits.push(`<span class="td-dim">(not cloned on this host)</span>`);
      if (g.manual) bits.push(`<span class="td-dim">— set by you</span>`);
      else if (g.reason) bits.push(`<span class="td-dim">— ${esc(g.reason)}</span>`);
    }
    if (o.editable) {
      bits.push(`<button type="button" class="td-edit" data-repo-edit="1">Change</button>`);
    }
    // A failed save is reported ON the row it failed to change, next to the value
    // it left behind — the optimistic paint has already been rolled back, so
    // without this the row would just silently snap to its old value.
    if (o.error) bits.push(`<span class="td-err-inline">Couldn't save — ${esc(o.error)}</span>`);
    return bits.join(" ");
  }

  // The picker's current answer, as one of the values its options carry. The
  // handler reads this to know whether a selection actually CHANGED anything, so
  // it must be derived exactly the way repoPickerHtml preselects — which is why
  // both go through here rather than each deciding for itself.
  //
  // Only a MANUAL pin is an answer of the operator's. An auto guess of "Turma" is
  // the model's answer, and their setting is still "let it decide".
  function repoPickerValue(t) {
    const g = (t && t.repoGuess) || null;
    if (!g || !g.manual) return "__auto__";
    return g.repo || "__none__";
  }

  // The picker itself, shown in place of the row once "Change" is clicked. Its
  // options are the host's OWN candidate list (jira.repoOptions), which is the
  // same list set_jira_repo allowlists against — so every option here is one the
  // agent will accept, and the two can't drift.
  //
  // Both non-repo choices are spelled out as real options rather than left to a
  // stray empty value: "no repo fits" and "let the model decide" are genuinely
  // different answers, and the agent treats them differently (a pin vs. dropping
  // the pin), so the UI must not blur them either.
  //
  // **Choosing an option IS the save** — there is no Save button. The dropdown is
  // the setting, and it reads as one: an operator who picks a repo and clicks away
  // has answered the question the row asked, and every one of these options is a
  // complete answer on its own. It used to require a separate Save, which silently
  // threw the choice away on a click-away and snapped the row back to the model's
  // guess, so the pin only ever landed for someone who knew to press it.
  function repoPickerHtml(t, options) {
    const g = (t && t.repoGuess) || null;
    const pinned = !!(g && g.manual);
    const cur = pinned && g.repo ? g.repo : null;
    const opts = (options || []).filter(o => o && o.name);
    // A pinned repo that has fallen OUT of the options (deleted from the org, off
    // the candidate cap's tail, or a `gh` sweep that blanked the list) is carried
    // back in as its own option, so it can stay `selected`.
    //
    // Without this the select has nothing selected and the browser falls back to
    // its first option — "Let the agent decide" — which misreports the current
    // state, and (since the handler saves what changed against the preselection)
    // would read a re-pick of the pin itself as a release of it.
    // `_apply_triage` deliberately keeps rendering such a repo (absence from the
    // list isn't evidence the pin is wrong), so this state is reachable by design
    // and the picker has to tell the same story the row does.
    const orphan = cur && !opts.some(o => o.name === cur)
      ? { name: cur, cloned: !!(g && g.cloned), nameWithOwner: g && g.nameWithOwner }
      : null;
    const cloned = opts.filter(o => o.cloned);
    const uncloned = opts.filter(o => !o.cloned);
    const optHtml = (o) => `<option value="${esc(o.name)}"${
      o.name === cur ? " selected" : ""}>${esc(o.name)}${
      o.nameWithOwner && o.nameWithOwner !== o.name ? ` (${esc(o.nameWithOwner)})` : ""}</option>`;
    const group = (label, list) => list.length
      ? `<optgroup label="${esc(label)}">${list.map(optHtml).join("")}</optgroup>` : "";
    // `__auto__`/`__none__` are sentinels, not repo names: a repo can't be called
    // either (the agent's own names come from directory + gh listings, and the
    // endpoint's name pattern would reject the underscores anyway), and the
    // handler maps them to {auto:true} / {repo:null} before anything is sent.
    const sel = `<select class="td-repo-select" data-repo-select="1">
      <option value="__auto__"${pinned ? "" : " selected"}>Let the agent decide</option>
      <option value="__none__"${pinned && !g.repo ? " selected" : ""}>No repository fits</option>
      ${group("Currently set", orphan ? [orphan] : [])}
      ${group("Cloned", cloned)}
      ${group("Not cloned", uncloned)}
    </select>`;
    // Cancel stays: it's the way out for someone who opened the picker by mistake
    // and doesn't want to re-pick their existing answer to close it. Clicking away
    // does the same — with nothing changed there is nothing to save.
    return `<div class="td-repo-edit">${sel}
      <button type="button" class="td-edit" data-repo-cancel="1">Cancel</button>
      ${opts.length || orphan ? "" : `<span class="td-dim">No repos reported for this org</span>`}
    </div>`;
  }

  // The ticket's pinned host out of the hub's ticketAgents map (keyed
  // "<siteKey>/<issueKey>"); null when the ticket routes automatically.
  function agentPinOf(ticketAgents, siteKey, issueKey) {
    const p = (ticketAgents || {})[`${siteKey}/${issueKey}`];
    return p && p.host ? p : null;
  }

  // The Agent row of the detail panel (XERK-38): which HOST this ticket's
  // sessions spawn on. Deliberately panel-only — the card gets no chip. Auto
  // routing is the overwhelmingly common case, and unlike the repo guess there
  // is no model answer worth surfacing at a glance: the row exists for the rare
  // multi-agent-org override, so it lives where the other rare controls do.
  function agentFieldHtml(pin, hostOptions, opts) {
    const o = opts || {};
    const bits = [];
    if (!pin) {
      bits.push(`<span class="td-dim">Auto — most available agent</span>`);
    } else {
      const opt = (hostOptions || []).find(h => h && h.key === pin.host);
      bits.push(`<span class="kc-repo">${esc(opt ? opt.name : pin.host)}</span>`);
      // A pinned host that stopped reporting the org (or went quiet) still IS
      // the pin — findTicketHost refuses rather than reroutes — so the row says
      // what that means for the next spawn instead of hiding it.
      if (!opt) bits.push(`<span class="td-dim">(no longer reports this org)</span>`);
      else if (!opt.online) bits.push(`<span class="td-dim">(offline)</span>`);
      bits.push(`<span class="td-dim">— set by you</span>`);
    }
    if (o.editable) {
      bits.push(`<button type="button" class="td-edit" data-agent-edit="1">Change</button>`);
    }
    if (o.error) bits.push(`<span class="td-err-inline">Couldn't save — ${esc(o.error)}</span>`);
    return bits.join(" ");
  }

  // The picker's current answer — same contract as repoPickerValue: the change
  // handler compares a pick against this to know whether anything changed, so
  // it must derive exactly the way agentPickerHtml preselects.
  function agentPickerValue(pin) {
    return pin ? pin.host : "__auto__";
  }

  // The agent picker, swapped in for the row on "Change". Choosing an option IS
  // the save, exactly like the repo picker above and for the same reason. The
  // options are the org's reporting hosts (hostOptions from mergeSites) — the
  // same fleet list the /agent endpoint allowlists against, so every option is
  // one the hub will accept.
  function agentPickerHtml(pin, hostOptions) {
    const cur = pin ? pin.host : null;
    const opts = (hostOptions || []).filter(h => h && h.key);
    // A pinned host that has left the fleet list is carried back in so it can
    // stay `selected` — otherwise the browser falls back to "Auto", misreporting
    // the pin and turning a click-away into a silent release of it (the same
    // trap repoPickerHtml documents).
    const orphan = cur && !opts.some(h => h.key === cur)
      ? { key: cur, name: cur, online: false, gone: true } : null;
    const optHtml = (h) => `<option value="${esc(h.key)}"${
      h.key === cur ? " selected" : ""}>${esc(h.name)}${
      h.gone ? " (no longer reports this org)" : h.online ? "" : " (offline)"}</option>`;
    const sel = `<select class="td-repo-select" data-agent-select="1">
      <option value="__auto__"${pin ? "" : " selected"}>Auto — most available agent</option>
      ${orphan ? `<optgroup label="Currently set">${optHtml(orphan)}</optgroup>` : ""}
      ${opts.map(optHtml).join("")}
    </select>`;
    return `<div class="td-repo-edit">${sel}
      <button type="button" class="td-edit" data-agent-cancel="1">Cancel</button>
      ${opts.length || orphan ? "" : `<span class="td-dim">No agents reported for this org</span>`}
    </div>`;
  }

  // `t` is the card's ticket (always present); `detail` is the fetched issue
  // (null until it lands). opts: {color, now, siteKey, error, loading}.
  function detailHtml(t, detail, opts) {
    const o = opts || {};
    const d = detail || {};
    // Prefer the fetched copy field-by-field: it's newer than the last board
    // poll, so an issue reprioritized since the beat reads correctly here.
    const v = (k) => (d[k] != null && d[k] !== "" ? d[k] : t[k]);
    // Name the source in the "open the live copy" links from the ticket's own URL
    // (Azure work items are `.../_workitems/edit/<id>`), so an Azure board reads
    // "Open in Azure DevOps" rather than "Open in Jira".
    const srcName = /\/_workitems\//i.test(String(v("url") || "")) ? "Azure DevOps" : "Jira";
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
      // The guess only ever rides the heartbeat ticket — the on-demand issue
      // fetch comes straight from Jira, which knows nothing about repos — so this
      // reads `t` directly rather than through v(). Spelled out here (rationale
      // and clone state as text) where the card only had room for a chip.
      // `editing` swaps the row for the picker in place: it's the same field, and
      // the operator is answering the question the row just asked.
      fieldRow("Repo", o.editing
        ? repoPickerHtml(t, o.repoOptions)
        : repoFieldHtml(t, { editable: !!o.canEdit, error: o.repoError })),
      // Which host the ticket's sessions spawn on (XERK-38). The pin is
      // hub-owned (o.agentPin, from the /api/agents payload's ticketAgents),
      // not a ticket field, and the save is a plain hub POST — so unlike the
      // Repo row it needs no online host to be editable; it just needs hosts
      // to offer (or an existing pin to release).
      fieldRow("Agent", o.agentEditing
        ? agentPickerHtml(o.agentPin, o.hostOptions)
        : agentFieldHtml(o.agentPin, o.hostOptions, {
            editable: !!(o.agentPin || (o.hostOptions || []).length),
            error: o.agentError,
          })),
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
      body = `<div class="td-note td-err">Couldn't load the full ticket — ${esc(o.error)}. <a href="${esc(v("url") || "#")}" target="_blank" rel="noopener">Open in ${srcName}</a> instead.</div>`;
    } else if (!detail) {
      body = `<div class="td-note">Loading description and comments…</div>`;
    } else {
      const desc = d.description
        ? textHtml(d.description) +
          (d.descriptionTruncated ? `<div class="td-note">Description truncated — <a href="${esc(v("url") || "#")}" target="_blank" rel="noopener">read the rest in ${srcName}</a>.</div>` : "")
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
          ${dropped ? `<div class="td-note">Showing the ${comments.length} newest — <a href="${esc(v("url") || "#")}" target="_blank" rel="noopener">${dropped} older in ${srcName}</a>.</div>` : ""}
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
      <div class="td-foot"><a href="${esc(v("url") || "#")}" target="_blank" rel="noopener">Open in ${srcName} ↗</a></div>`;
  }

  // The three-column board for the selected sites (filter = a siteKey, or
  // null/"" for all). Sites are the mergeSites() output; each org's color is a
  // stable hash of its own siteKey (orgColor), so it holds across filtering and
  // fleet changes without threading the whole key set through here.
  function boardHtml(sites, filter, opts) {
    const o = opts || {};
    const shown = sites.filter(s => !filter || s.siteKey === filter);
    const cards = { todo: [], inprogress: [], review: [], done: [] };
    for (const site of shown) {
      const color = orgColor(site.siteKey);
      for (const t of site.tickets) {
        cards[categoryOf(t)].push({ t, site, color });
      }
    }
    const cols = CATEGORIES.map(([cat, label]) => {
      const list = cards[cat].sort((x, y) => ticketSort(x.t, y.t));
      const body = list.length
        ? list.map(c => cardHtml(c.t, c.site, {
            color: c.color, now: o.now,
            sessions: ticketSessionsOf(o.sessionIndex, c.site.siteKey, c.t.key),
            start: o.starts && o.starts.get((c.site.siteKey || "") + "\x00" + c.t.key),
          })).join("")
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

  // Newest `fetchedAt` across every agent's jira block ("" when none report
  // one) — the board's freshness watermark. The manual refresh watches this
  // advance to know a re-poll actually LANDED, rather than assuming it did
  // after a fixed delay: the round trip is a queued command + the agent's next
  // beat, whose latency depends on the host's interval and Jira's own speed.
  // Same lexicographic-compare-on-fixed-format-UTC assumption as mergeSites.
  function newestFetchedAt(agents) {
    let newest = "";
    for (const a of agents || []) {
      const f = a && a.jira && a.jira.fetchedAt;
      if (f && String(f) > newest) newest = String(f);
    }
    return newest;
  }

  // Is a manual refresh still in flight across `hosts`? True while any of them
  // still holds an unacked refreshJira. The hub drops a command from the record
  // the moment the agent acks it, so this flips false once the fleet has
  // EXECUTED the re-poll — including a poll that failed, which the watermark
  // above can't see (the fail-open keeps the old tickets and only sets `error`,
  // leaving fetchedAt untouched) and would otherwise wait out its full timeout.
  function jiraRefreshPending(agents, hosts) {
    const want = new Set(hosts || []);
    for (const a of agents || []) {
      if (!a || !want.has(a.key)) continue;
      if ((a.commands || []).some(c => c && c.type === "refreshJira")) return true;
    }
    return false;
  }

  // Did a finished refresh fail OUTRIGHT — i.e. did every targeted host come
  // back with an error? Deliberately not "any host errored": one permanently
  // broken host would then label every refresh a failure even when the rest of
  // the fleet updated fine (each org's own error still shows on its column).
  // A successful poll always returns a block with error=null, so a lingering
  // error belongs to the poll we just triggered — which is why this reads the
  // error rather than inferring failure from a frozen fetchedAt, whose 1-second
  // resolution can't distinguish "failed" from "polled twice in one second".
  function jiraRefreshFailed(agents, hosts) {
    const want = new Set(hosts || []);
    const targeted = (agents || []).filter(a => a && want.has(a.key));
    return targeted.length > 0 && targeted.every(a => !!(a.jira && a.jira.error));
  }

  // What should a start-in-flight become, given the current fleet? The board's
  // start button is optimistic: the pending state is painted the instant it's
  // pressed, before the POST is even sent, so the operator gets immediate
  // acknowledgement and can move on. This decides when that optimism resolves.
  //
  // `p` is {cmdId, host, sawCmd, ageMs}; `sessions` are the ticket's sessions,
  // `cmd` whether the host's queue still holds this cmdId right now, `known`
  // whether the host is in the fleet payload at all.
  //   - "hold"  keep showing ⏳ (also mutates p.sawCmd once the command appears)
  //   - "clear" drop it: a session reported this cmdId (landed), or the command
  //             we WATCHED land has since drained (the agent ran or refused it)
  //   - "error" the backstop for a host that stopped beating mid-spawn
  //
  // The load-bearing subtlety is `sawCmd`: "command absent" only means "acked"
  // once we've actually seen it PRESENT. A cache too stale to have seen it land
  // (the SSE-fallback poll hasn't caught up to the click yet) reads as absent
  // too, and treating that as acked sweeps the pending the instant it's set —
  // the bug where the ⏳ never appeared at all. A cmdId-less pending (POST not
  // back yet) always holds; its own fetch resolves it.
  function startSweepVerdict(p, sessions, cmd, known, timeoutMs) {
    if (!p || !p.cmdId) return "hold";
    if ((sessions || []).some(s => s.spawnCmdId === p.cmdId)) return "clear";
    if (!known) return (p.ageMs > timeoutMs) ? "error" : "hold";  // host gone: only time out
    if (cmd) { p.sawCmd = true; return "hold"; }                  // command still queued
    if (p.sawCmd) return "clear";                                 // watched it land, now drained
    return (p.ageMs > timeoutMs) ? "error" : "hold";              // never saw it; wait it out
  }

  const api = {
    CATEGORIES, mergeSites, categoryOf, isReviewStatus, ticketSort, orgColor, orgName, autoStartOn, ageStr,
    prioClass, cardHtml, boardHtml, detailHtml, textHtml, linkify, fmtDate, esc,
    repoChipHtml, repoFieldHtml, repoPickerHtml, repoPickerValue,
    agentPinOf, agentFieldHtml, agentPickerHtml, agentPickerValue,
    ticketSessionIndex, ticketSessionsOf, sessionChipHtml, ticketStartHtml,
    newestFetchedAt, jiraRefreshPending, jiraRefreshFailed, startSweepVerdict,
  };
  if (typeof window !== "undefined") window.TurmaBoard = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
