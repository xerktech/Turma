"use strict";
// Native chat engine for the Sessions page. Replaces "attach to the ttyd
// terminal" as the default running-session view: it opens the hub's live
// transcript WebSocket (/live/<host>/<id>), renders the session as chat bubbles
// (user right, agent left) plus collapsible tool-action cards + thinking traces,
// and streams the in-progress turn with a typewriter reveal. A three-way
// verbosity preset (Concise hides thinking + tool actions entirely; Normal adds
// tool cards with collapsed output; Verbose expands everything) picks how much
// of each turn is shown. Ported in spirit from the glasses client (glasses/src/live.ts,
// transcript.ts, reveal.ts) into framework-free, build-free browser JS.
//
// Reads a few shared helpers from the page's inline script (same classic-script
// global scope): esc(), enc(), cache, sessTitle(), sessMeta(), fastPoll().
(function () {
  // ---- constants ------------------------------------------------------------
  const REVEAL_RATE_CPS = 150;      // typewriter speed for the in-progress turn
  const REVEAL_SNAP_CHARS = 200;    // a bigger backlog than this snaps, not types
  const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
  const TOKEN_SKEW_MS = 30000;      // refetch a ws-token this long before expiry
  const LIVE_TURN_ID = "__live";
  const POLL_MS = 6000;             // /history fallback cadence when the WS is down
  const HISTORY_RETRY_MS = 1200;    // poll cadence while /history returns 202
  const HISTORY_MAX_RETRIES = 12;

  const PRESETS = {
    concise: { thinking: false, tools: false, outputs: false },
    normal:  { thinking: false, tools: true,  outputs: false },
    verbose: { thinking: true,  tools: true,  outputs: true },
  };

  // Live per-session selectors under the compose box. Values mirror the spawn
  // composer's allowlists (the agent re-validates); picking one changes the
  // RUNNING session — model via `/model <name>`, mode via Shift+Tab cycling.
  const MODEL_OPTS = [
    { value: "default", label: "Default" },
    { value: "opus", label: "Opus" },
    { value: "sonnet", label: "Sonnet" },
    { value: "haiku", label: "Haiku" },
  ];
  const MODE_OPTS = [
    { value: "auto", label: "auto" },
    { value: "acceptEdits", label: "acceptEdits" },
    { value: "plan", label: "plan" },
    { value: "bypassPermissions", label: "bypassPermissions" },
    { value: "default", label: "default" },
  ];

  // Self-contained HTML-escape / URL-encode (identical to the page's inline
  // helpers) so chat.js has no cross-script dependency and its rendering is
  // unit-testable in Node.
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function enc(s) { return encodeURIComponent(s); }

  // Turn plain transcript text into HTML with clickable links. Bare http(s)
  // URLs and markdown [text](url) links (http/https only) become <a> tags that
  // open in a new tab; every other run of text is HTML-escaped exactly like
  // esc(). Only http/https is ever linkified (no javascript:/data: hrefs), and
  // both the label and the href are escaped, so this is as injection-safe as
  // esc() — a bare esc() and linkify() produce identical output for link-free
  // text. Used for prose surfaces (message bubbles, thinking traces); tool
  // input/output <pre> blocks stay raw esc().
  function anchor(url, label) {
    return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + "</a>";
  }
  function linkify(text) {
    const s = String(text == null ? "" : text);
    // Markdown link, OR a bare http(s) URL.
    const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<]+)/g;
    let out = "", last = 0, m;
    while ((m = re.exec(s))) {
      out += esc(s.slice(last, m.index));
      if (m[2]) {
        out += anchor(m[2], m[1]);            // [label](url)
      } else {
        // Bare URL: peel trailing sentence punctuation back out of the link,
        // and a trailing ')' only when it isn't part of the URL (e.g. a URL
        // wrapped in parens) — keep it for balanced ones like /wiki/Foo_(bar).
        let url = m[3], trail = "";
        const tp = /[.,;:!?'"]+$/.exec(url);
        if (tp) { trail = tp[0]; url = url.slice(0, -tp[0].length); }
        if (url.endsWith(")") && !url.includes("(")) { trail = ")" + trail; url = url.slice(0, -1); }
        out += anchor(url, url) + esc(trail);
      }
      last = m.index + m[0].length;
    }
    out += esc(s.slice(last));
    return out;
  }

  // ---- state ----------------------------------------------------------------
  let gen = 0;                      // bumped on every open/close; stale async work checks it
  let hostKey = null, sessionId = null, sess = null, agent = null;
  let buffer = [];                  // merged rich entries {id, role, text, blocks}
  let liveTurn = "";                // in-progress assistant text (pane scrape), "" when idle
  let liveStatus = null;            // {verb,up,down,elapsed} working indicator, null when idle
  let ws = null, backoffIdx = 0, wsRetryTimer = null;
  let pollTimer = null;
  let cachedToken = null, tokenExp = 0;
  let verbosity = { preset: "normal", show: { ...PRESETS.normal } };
  let questionActive = false;

  // reveal (only the live turn types in; committed messages render whole)
  let reveal = { shown: 0 };
  let revealFull = "";
  let rafId = null, lastTs = 0;

  // User's explicit expand/collapse of <details> cards, keyed by a stable
  // data-dkey, so a repaint (a tail delta lands ~1s while working) doesn't snap
  // every card the user opened back to its verbosity default. Cleared on
  // session open and whenever verbosity changes (so the preset sets a clean
  // baseline).
  const detailsOpen = new Map();

  const $ = (id) => document.getElementById(id);

  // ---- token + live WebSocket (LiveTail port) -------------------------------
  async function getToken() {
    const now = Date.now();
    if (cachedToken && tokenExp - now > TOKEN_SKEW_MS) return cachedToken;
    const r = await fetch("/api/ws-token");
    if (!r.ok) throw new Error("ws-token " + r.status);
    const j = await r.json();
    cachedToken = j.token;
    tokenExp = now + (Number(j.expiresInSec) || 300) * 1000;
    return cachedToken;
  }

  function wsUrl(token) {
    const base = location.origin.replace(/^http/i, "ws");
    return base + "/live/" + enc(hostKey) + "/" + enc(sessionId) + "?auth=" + enc(token);
  }

  async function startWs(myGen) {
    let token;
    try { token = await getToken(); }
    catch { scheduleReconnect(myGen); return; }
    if (myGen !== gen) return;
    let sock;
    try { sock = new WebSocket(wsUrl(token)); }
    catch { scheduleReconnect(myGen); return; }
    ws = sock;
    let opened = false;
    sock.onopen = () => { opened = true; backoffIdx = 0; };
    sock.onmessage = (ev) => {
      if (myGen !== gen) return;
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame && frame.type === "tail" && Array.isArray(frame.entries) && frame.entries.length) {
        buffer = mergeTail(buffer, frame.entries);
        repaint();
      } else if (frame && frame.type === "turn" && typeof frame.text === "string") {
        liveTurn = frame.text;
        // The working indicator (spinner verb + live token up/down counters) is
        // pinned below the scroll, not woven into the streamed text — so it stops
        // flickering in and out of the message as the TUI spinner animates.
        liveStatus = frame.status || null;
        repaint();
      }
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      if (myGen !== gen) return;
      // A socket that failed before opening may have been rejected on a stale
      // token — drop the cache so the reconnect mints a fresh one.
      if (!opened) cachedToken = null;
      scheduleReconnect(myGen);
    };
    sock.onerror = () => { try { sock.close(); } catch {} };
  }

  function scheduleReconnect(myGen) {
    if (myGen !== gen || wsRetryTimer) return;
    const delay = BACKOFF_MS[Math.min(backoffIdx, BACKOFF_MS.length - 1)];
    backoffIdx++;
    wsRetryTimer = setTimeout(() => {
      wsRetryTimer = null;
      if (myGen === gen) startWs(myGen);
    }, delay);
  }

  // ---- /history fallback (initial scrollback + WS-down updates) -------------
  async function loadHistory(myGen, retries) {
    retries = retries || 0;
    let r;
    try { r = await fetch("/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/history"); }
    catch { return; }
    if (myGen !== gen) return;
    if (r.status === 202) {
      if (retries < HISTORY_MAX_RETRIES) setTimeout(() => loadHistory(myGen, retries + 1), HISTORY_RETRY_MS);
      return;
    }
    if (!r.ok) return;
    let j;
    try { j = await r.json(); } catch { return; }
    if (myGen !== gen || !j || !Array.isArray(j.entries)) return;
    // History is the authoritative chronological scrollback (bigger byte window,
    // looser per-block caps). Seed order from it, then re-merge any newer live
    // entries already in the buffer on top.
    buffer = mergeTail(j.entries, buffer);
    repaint();
  }

  function startPollFallback(myGen) {
    stopPollFallback();
    pollTimer = setInterval(() => {
      if (myGen !== gen) return stopPollFallback();
      // Only poll when the live socket isn't delivering.
      if (!ws || ws.readyState !== WebSocket.OPEN) loadHistory(myGen);
    }, POLL_MS);
  }
  function stopPollFallback() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  // ---- merge (transcript.ts mergeTail port) ---------------------------------
  // Weight = total displayable chars; a richer/longer copy of an entry wins, so
  // the text-only heartbeat seed is replaced by the rich live tail, and the live
  // tail (tight caps) is replaced by /history (looser caps). Grow-only, so a
  // truncated preview never clobbers a fuller copy.
  function weight(e) {
    let w = (e.text || "").length;
    for (const b of (e.blocks || [])) w += (b.text || "").length + (b.input || "").length;
    return w;
  }
  function mergeTail(existing, incoming) {
    const byId = new Map();
    const order = [];
    for (const e of existing || []) {
      if (e && e.id != null && !byId.has(e.id)) { byId.set(e.id, e); order.push(e.id); }
    }
    for (const inc of incoming || []) {
      if (!inc || inc.id == null) continue;
      const cur = byId.get(inc.id);
      if (!cur) { byId.set(inc.id, inc); order.push(inc.id); continue; }
      const incHasBlocks = inc.blocks && inc.blocks.length;
      const curHasBlocks = cur.blocks && cur.blocks.length;
      if (weight(inc) >= weight(cur) || (incHasBlocks && !curHasBlocks)) byId.set(inc.id, inc);
    }
    return order.map((id) => byId.get(id));
  }

  // ---- build display items from rich entries --------------------------------
  // Items: {kind:"msg",role,text,truncated,id} | {kind:"thinking",text,truncated,id}
  //        | {kind:"action", id, name, input, inputTrunc, result:{text,isError,truncated}|null, entryId}
  function buildItems(entries) {
    const resultsById = new Map();
    const toolUseIds = new Set();
    for (const e of entries) for (const b of (e.blocks || [])) {
      if (b.t === "tool_use" && b.id) toolUseIds.add(b.id);
      if (b.t === "tool_result" && b.forId) resultsById.set(b.forId, b);
    }
    const items = [];
    for (const e of entries) {
      const role = e.role === "user" ? "user" : "assistant";
      // Older agents / the text-only cache seed carry no blocks: synthesize one.
      const blocks = (e.blocks && e.blocks.length)
        ? e.blocks
        : (e.text ? [{ t: "text", text: e.text }] : []);
      let msg = null;
      const flush = () => { if (msg) { items.push(msg); msg = null; } };
      for (const b of blocks) {
        if (b.t === "text") {
          if (!msg) msg = { kind: "msg", role, id: e.id, text: "", truncated: false };
          msg.text += b.text || "";
          if (b.truncated) msg.truncated = true;
        } else if (b.t === "thinking") {
          flush();
          items.push({ kind: "thinking", id: e.id, text: b.text || "", truncated: !!b.truncated });
        } else if (b.t === "tool_use") {
          flush();
          const res = b.id ? resultsById.get(b.id) : null;
          items.push({
            kind: "action", id: b.id || null, name: b.name || "tool",
            input: b.input || "", inputTrunc: !!b.truncated, entryId: e.id,
            result: res ? { text: res.text || "", isError: !!res.isError, truncated: !!res.truncated } : null,
          });
        } else if (b.t === "tool_result") {
          if (b.forId && toolUseIds.has(b.forId)) continue; // folded into its tool_use card
          flush();
          items.push({
            kind: "action", id: b.forId || null, name: "result", input: "", inputTrunc: false, entryId: e.id,
            result: { text: b.text || "", isError: !!b.isError, truncated: !!b.truncated }, orphan: true,
          });
        } else if (b.t === "task_notification") {
          // A background Task/agent finishing: render as an action card (like a
          // tool call) rather than a raw-XML user bubble. The summary is the
          // card title; the child's result is the expandable body.
          flush();
          const failed = b.status && b.status !== "completed";
          const result = (b.result || b.status)
            ? { text: b.result || ("status: " + b.status), isError: !!failed, truncated: !!b.truncated }
            : null;
          items.push({
            kind: "action", id: null, name: b.summary || "Background task",
            input: "", inputTrunc: false, entryId: e.id, result, task: true,
          });
        }
      }
      flush();
    }
    return items;
  }

  // ---- rendering ------------------------------------------------------------
  function truncBtn(entryId, truncated) {
    return truncated ? '<button class="trunc" data-eid="' + esc(entryId) + '">Show more…</button>' : "";
  }

  function renderMsg(it) {
    const cls = it.role === "user" ? "user" : "assistant";
    return '<div class="tr-msg ' + cls + '"><span class="role">' + cls + "</span>" +
      linkify(it.text) + truncBtn(it.id, it.truncated) + "</div>";
  }

  function renderThought(it) {
    if (!verbosity.show.thinking) return ""; // hidden by verbosity
    const key = "th:" + it.id;
    return '<details class="thought" data-dkey="' + esc(key) + '"' + openAttr(key, true) +
      "><summary>💭 Thought</summary>" +
      '<div class="thought-body">' + linkify(it.text) + truncBtn(it.id, it.truncated) + "</div></details>";
  }

  // ` open` when this card should be expanded: the user's explicit toggle wins,
  // else the verbosity-derived default.
  function openAttr(key, def) {
    return (detailsOpen.has(key) ? detailsOpen.get(key) : def) ? " open" : "";
  }
  function actionKey(a, gk, idx) { return a.id ? ("act:" + a.id) : ("act:" + gk + ":" + idx); }

  function renderActionCard(it, key) {
    const statusCls = it.result ? (it.result.isError ? "err" : "ok") : "";
    const argOne = it.input ? esc(it.input.split("\n")[0]) : "";
    let body = "";
    if (it.input) {
      body += '<div class="tool-block"><div class="tool-label">input</div><pre>' +
        esc(it.input) + "</pre>" + truncBtn(it.entryId, it.inputTrunc) + "</div>";
    }
    if (it.result) {
      body += '<div class="tool-block"><div class="tool-label">' + (it.result.isError ? "error" : "output") +
        '</div><pre class="tool-result">' + esc(it.result.text || "(no output)") + "</pre>" +
        truncBtn(it.entryId, it.result.truncated) + "</div>";
    }
    if (!body) body = '<div class="tool-block"><div class="tool-label">running…</div></div>';
    const taskCls = it.task ? " task" : "";
    const icon = it.task ? '<span class="tool-glyph">◆</span>' : '<span class="tool-dot"></span>';
    return '<details class="action-card' + (statusCls ? " " + statusCls : "") + taskCls + '" data-dkey="' + esc(key) + '"' +
      openAttr(key, verbosity.show.outputs) + ">" +
      "<summary>" + icon + '<span class="tool-name">' + esc(it.name) + "</span>" +
      '<span class="tool-arg">' + argOne + "</span></summary>" +
      '<div class="tool-body">' + body + "</div></details>";
  }

  function itemsToHtml(items) {
    const out = [];
    let i = 0, g = 0;
    while (i < items.length) {
      const it = items[i];
      if (it.kind === "msg") { out.push(renderMsg(it)); i++; continue; }
      if (it.kind === "thinking") { out.push(renderThought(it)); i++; continue; }
      // action run
      let j = i;
      while (j < items.length && items[j].kind === "action") j++;
      const run = items.slice(i, j);
      const gk = "grp:" + (run[0].id || g++);
      // Concise mode (tools hidden) omits tool actions entirely — no card, no
      // collapsed box. Otherwise render each action as its own card.
      if (verbosity.show.tools) out.push(run.map((a, idx) => renderActionCard(a, actionKey(a, gk, idx))).join(""));
      i = j;
    }
    return out.join("");
  }

  function scrolledToBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  function repaint() {
    const scroll = $("chatScroll");
    if (!scroll) return;
    const pin = scrolledToBottom(scroll);
    const prevTop = scroll.scrollTop;
    const items = buildItems(buffer);
    let html = itemsToHtml(items);
    if (!html && !liveTurn) html = '<div class="chat-empty">No messages yet. Say something below to get the agent going.</div>';
    // The in-progress assistant turn (streaming, text-only) as the trailing
    // bubble; its text is revealed by the typewriter loop.
    if (liveTurn) {
      // Reset the reveal if a new/shorter turn started.
      if (reveal.shown > liveTurn.length) reveal.shown = 0;
      revealFull = liveTurn;
      const shownText = liveTurn.slice(0, Math.max(0, reveal.shown));
      html += '<div class="tr-msg assistant streaming" id="chatLiveBubble"><span class="role">assistant</span>' +
        esc(shownText) + "</div>";
    } else {
      revealFull = "";
      reveal.shown = 0;
    }
    scroll.innerHTML = html;
    // Stay pinned to the bottom while following along; otherwise hold the
    // reader's place (innerHTML replacement resets scrollTop to 0, and new
    // entries only append below, so the prior offset still points at the same
    // content).
    scroll.scrollTop = pin ? scroll.scrollHeight : prevTop;
    updateLiveStatus();
    if (liveTurn) startReveal();
  }

  // The pinned working-status bar (a sibling of the scroll, so a scroll repaint
  // never touches it): spinner + gerund verb + live ↑/↓ token counters, plus —
  // on a second de-emphasized line — Claude Code's contextual hint/task footer,
  // mirroring the terminal's bottom status region. Shown only while generating.
  function updateLiveStatus() {
    const bar = $("chatStatus");
    if (!bar) return;
    const st = liveStatus;
    if (!st) { bar.hidden = true; bar.innerHTML = ""; return; }
    const verb = esc(st.verb || "Working");
    const toks =
      (st.up ? '<span class="tok up">↑ ' + esc(st.up) + "</span>" : "") +
      (st.down ? '<span class="tok down">↓ ' + esc(st.down) + "</span>" : "");
    const elapsed = st.elapsed ? '<span class="tok elapsed">' + esc(st.elapsed) + "</span>" : "";
    const hint = st.hint ? '<div class="cc-hint">' + esc(st.hint) + "</div>" : "";
    bar.hidden = false;
    bar.innerHTML =
      '<div class="cc-row"><span class="cc-spin"></span>' +
      '<span class="verb">' + verb + "…</span>" +
      '<span class="toks">' + elapsed + toks + "</span></div>" +
      hint;
  }

  // Repaint from outside (e.g. returning from the terminal toggle).
  function repaintPublic() { renderVerbosityControl(); renderComposeOpts(); repaint(); }

  // ---- typewriter reveal loop (live turn only) ------------------------------
  function startReveal() {
    if (rafId != null) return;
    lastTs = 0;
    rafId = requestAnimationFrame(tick);
  }
  function tick(ts) {
    rafId = null;
    const dt = lastTs ? ts - lastTs : 0;
    lastTs = ts;
    const bubble = $("chatLiveBubble");
    if (!bubble || !revealFull) return; // nothing to animate
    const target = revealFull.length;
    if (reveal.shown < target) {
      const backlog = target - reveal.shown;
      if (backlog > REVEAL_SNAP_CHARS) reveal.shown = target;
      else reveal.shown = Math.min(target, reveal.shown + Math.max(1, Math.floor(REVEAL_RATE_CPS * dt / 1000)));
      const scroll = $("chatScroll");
      const pin = scroll ? scrolledToBottom(scroll) : false;
      // Rebuild the bubble text: role span + revealed slice.
      bubble.innerHTML = '<span class="role">assistant</span>' + esc(revealFull.slice(0, reveal.shown));
      if (pin && scroll) scroll.scrollTop = scroll.scrollHeight;
    }
    if (reveal.shown < target) { rafId = requestAnimationFrame(tick); }
  }

  // ---- header + verbosity control ------------------------------------------
  function setHeader(s, a) {
    const t = $("chatTitle"), p = $("chatPath");
    const title = (s && typeof sessTitle === "function") ? sessTitle(s) : sessionId;
    const meta = (s && typeof sessMeta === "function") ? sessMeta(s) : sessionId;
    if (t) t.textContent = title;
    if (p) p.textContent = (a ? (a.device || a.key) + " · " : "") + meta;
  }

  function loadVerbosity(sid) {
    let v = null;
    try { v = JSON.parse(localStorage.getItem("turma.chat.verbosity." + sid) || "null"); } catch {}
    if (v && v.preset && v.show && typeof v.show === "object") {
      verbosity = { preset: v.preset, show: {
        thinking: !!v.show.thinking, tools: !!v.show.tools, outputs: !!v.show.outputs } };
    } else {
      verbosity = { preset: "normal", show: { ...PRESETS.normal } };
    }
  }
  function saveVerbosity() {
    try { localStorage.setItem("turma.chat.verbosity." + sessionId, JSON.stringify(verbosity)); } catch {}
  }
  function matchPreset() {
    for (const name of Object.keys(PRESETS)) {
      const p = PRESETS[name];
      if (p.thinking === verbosity.show.thinking && p.tools === verbosity.show.tools && p.outputs === verbosity.show.outputs) return name;
    }
    return null;
  }
  function renderVerbosityControl() {
    const host = $("chatVerbosity");
    if (!host) return;
    const active = matchPreset();
    const seg = ["concise", "normal", "verbose"].map((name) =>
      '<button data-preset="' + name + '" class="' + (active === name ? "on" : "") + '">' +
      name[0].toUpperCase() + name.slice(1) + "</button>").join("");
    host.innerHTML = '<span class="seg">' + seg + "</span>";
    host.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
      const name = b.getAttribute("data-preset");
      verbosity = { preset: name, show: { ...PRESETS[name] } };
      detailsOpen.clear(); // a new preset resets card open/closed to its defaults
      saveVerbosity(); renderVerbosityControl(); repaint();
    }));
  }
  // ---- live agent-mode / model selectors (under the compose box) ------------
  function currentModelValue() {
    const m = (sess && sess.model) ? String(sess.model).toLowerCase() : "default";
    return MODEL_OPTS.some((o) => o.value === m) ? m : "default";
  }
  function currentModeValue() {
    const m = (sess && sess.permissionMode) ? sess.permissionMode : "auto";
    return MODE_OPTS.some((o) => o.value === m) ? m : "auto";
  }
  function optLabel(opts, val) { const o = opts.find((x) => x.value === val); return o ? o.label : val; }
  function menuHtml(opts, current, attr) {
    return opts.map((o) =>
      '<button ' + attr + '="' + esc(o.value) + '" class="' + (o.value === current ? "on" : "") + '">' +
      '<span>' + esc(o.label) + "</span></button>").join("");
  }
  function closeComposeMenus() {
    document.querySelectorAll("#chatComposeOpts .cc-menu.open").forEach((m) => m.classList.remove("open"));
  }
  function wireComposeMenu(btnId, menuId, attr, apply) {
    const btn = $(btnId), menu = $(menuId);
    if (!btn || !menu) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = menu.classList.contains("open");
      closeComposeMenus();
      if (!wasOpen) menu.classList.add("open");
    });
    menu.querySelectorAll("button[" + attr + "]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeComposeMenus();
      apply(b.getAttribute(attr));
    }));
  }
  // fromPoll: a background heartbeat repaint — don't yank an open menu shut.
  function renderComposeOpts(fromPoll) {
    const host = $("chatComposeOpts");
    if (!host) return;
    if (fromPoll && host.querySelector(".cc-menu.open")) return;
    const mode = currentModeValue(), model = currentModelValue();
    host.innerHTML =
      '<span class="cc-opt cc-mode">' +
        '<button class="cc-btn" id="ccModeBtn" title="Agent (permission) mode — switched live, best-effort">' +
        '🛡 <span class="cc-val">' + esc(optLabel(MODE_OPTS, mode)) + '</span><span class="cc-caret">▾</span></button>' +
        '<span class="cc-menu" id="ccModeMenu"><span class="cc-hint">Agent mode</span>' +
        menuHtml(MODE_OPTS, mode, "data-mode") + "</span></span>" +
      '<span class="cc-opt cc-model">' +
        '<button class="cc-btn" id="ccModelBtn" title="Model for this session">' +
        '<span class="cc-val">' + esc(optLabel(MODEL_OPTS, model)) + '</span><span class="cc-caret">▾</span> 🧠</button>' +
        '<span class="cc-menu" id="ccModelMenu"><span class="cc-hint">Model</span>' +
        menuHtml(MODEL_OPTS, model, "data-model") + "</span></span>";
    wireComposeMenu("ccModeBtn", "ccModeMenu", "data-mode", setSessionMode);
    wireComposeMenu("ccModelBtn", "ccModelMenu", "data-model", setSessionModel);
  }
  async function setSessionModel(value) {
    if (!hostKey || !sessionId || !sess || value === currentModelValue()) return;
    sess.model = value === "default" ? null : value; // optimistic; heartbeat confirms
    renderComposeOpts();
    try {
      await fetch("/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/model", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: value }) });
      if (typeof fastPoll === "function") fastPoll();
    } catch {}
  }
  async function setSessionMode(value) {
    if (!hostKey || !sessionId || !sess || value === currentModeValue()) return;
    sess.permissionMode = value; // optimistic; heartbeat confirms
    renderComposeOpts();
    try {
      await fetch("/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/mode", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permissionMode: value }) });
      if (typeof fastPoll === "function") fastPoll();
    } catch {}
  }

  if (typeof document !== "undefined") {
    document.addEventListener("click", () => {
      closeComposeMenus();
    });
  }

  // ---- pending AskUserQuestion ---------------------------------------------
  function updateQuestion(s) {
    const box = $("chatQuestion");
    if (!box) return;
    const q = s && s.session && s.session.question;
    const opts = (s && s.session && s.session.questionOptions) || [];
    questionActive = !!q;
    if (!q) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML =
      '<div class="q-text">' + esc(q) + "</div>" +
      '<div class="q-opts">' + opts.map((o, i) =>
        '<button class="q-opt" data-idx="' + i + '">' + esc(o) + "</button>").join("") + "</div>" +
      '<div class="q-hint">Or type a custom answer below.</div>';
    box.querySelectorAll(".q-opt").forEach((b) => b.addEventListener("click", () =>
      answerQuestion(parseInt(b.getAttribute("data-idx"), 10), null)));
  }

  async function answerQuestion(optionIndex, custom) {
    if (!hostKey || !sessionId) return;
    const body = { optionIndex };
    if (custom) body.custom = custom;
    try {
      await fetch("/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/answer", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const box = $("chatQuestion"); if (box) { box.hidden = true; box.innerHTML = ""; }
      questionActive = false;
      if (typeof fastPoll === "function") fastPoll();
    } catch {}
  }

  // ---- expand a truncated block via /history --------------------------------
  let expandInFlight = false;
  async function expandEntry(entryId) {
    if (expandInFlight) return;
    expandInFlight = true;
    const myGen = gen;
    try {
      const r = await fetch("/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/history");
      if (myGen !== gen || !r.ok) return;
      const j = await r.json();
      if (myGen !== gen || !j || !Array.isArray(j.entries)) return;
      buffer = mergeTail(buffer, j.entries); // looser caps -> the block grows
      repaint();
    } catch {} finally { expandInFlight = false; }
  }

  // ---- compose (typed prompt, or custom question answer) --------------------
  function autoGrow() {
    const inp = $("chatInput");
    if (!inp) return;
    inp.style.height = "auto";
    inp.style.height = Math.min(inp.scrollHeight, 160) + "px";
  }
  async function send() {
    const inp = $("chatInput"), btn = $("chatSend");
    if (!inp || !hostKey || !sessionId) return;
    const text = inp.value;
    if (!text.trim()) return;
    inp.value = ""; autoGrow(); inp.focus();
    try {
      let url, body;
      if (questionActive) {
        url = "/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/answer";
        body = { optionIndex: -1, custom: text };
      } else {
        url = "/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/input";
        body = { text };
      }
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(String(r.status));
      if (questionActive) { const box = $("chatQuestion"); if (box) { box.hidden = true; box.innerHTML = ""; } questionActive = false; }
      if (typeof fastPoll === "function") fastPoll();
    } catch {
      if (!inp.value.trim()) { inp.value = text; autoGrow(); }
      if (btn) { btn.textContent = "Send failed"; setTimeout(() => btn.textContent = "Send", 2000); }
    }
  }

  // Delegated clicks for expand-more buttons inside the scroll.
  function wireScrollDelegation() {
    const scroll = $("chatScroll");
    if (!scroll || scroll.dataset.wired) return;
    scroll.dataset.wired = "1";
    scroll.addEventListener("click", (e) => {
      const b = e.target.closest && e.target.closest(".trunc[data-eid]");
      if (b) { e.preventDefault(); expandEntry(b.getAttribute("data-eid")); }
    });
    // `toggle` doesn't bubble, so listen in the capture phase to record each
    // card's user-chosen open/closed state (survives the next repaint).
    scroll.addEventListener("toggle", (e) => {
      const d = e.target;
      if (d && d.tagName === "DETAILS" && d.dataset && d.dataset.dkey) detailsOpen.set(d.dataset.dkey, d.open);
    }, true);
  }

  // ---- public API -----------------------------------------------------------
  function open(hk, id, s, a) {
    close();
    gen++;
    const myGen = gen;
    hostKey = hk; sessionId = id; sess = s; agent = a;
    buffer = []; liveTurn = ""; liveStatus = null; reveal.shown = 0; revealFull = ""; backoffIdx = 0;
    detailsOpen.clear();
    loadVerbosity(id);
    setHeader(s, a);
    renderVerbosityControl();
    renderComposeOpts();
    wireScrollDelegation();
    updateQuestion(s);
    // Instant paint from the heartbeat's cached (text-only) tail, then upgrade.
    const seed = (s && s.session && s.session.tail) || [];
    if (seed.length) buffer = mergeTail(buffer, seed);
    repaint();
    loadHistory(myGen);
    startWs(myGen);
    startPollFallback(myGen);
  }

  function close() {
    gen++; // invalidate any in-flight async work
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
    stopPollFallback();
    if (ws) { try { ws.onclose = null; ws.close(); } catch {} ws = null; }
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
    hostKey = null; sessionId = null; sess = null; agent = null;
    buffer = []; liveTurn = ""; liveStatus = null; questionActive = false;
    updateLiveStatus(); // hide the pinned bar when the view closes
  }

  // Called from the page's render() on each heartbeat/SSE while chat is open.
  function onPoll(s) {
    if (!s) return;
    sess = s;
    setHeader(s, agent);
    updateQuestion(s);
    renderComposeOpts(true);
  }

  if (typeof window !== "undefined") {
    window.TurmaChat = { open, close, repaint: repaintPublic, onPoll };
    // Global handlers referenced by the chat pane's inline HTML attributes.
    window.autoGrowChatInput = autoGrow;
    window.chatInputKey = function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
    window.sendChatInput = send;
  }

  // Expose the pure core (merge + item building) for Node unit tests. Harmless
  // in the browser (no `module`); the browser path uses window.TurmaChat above.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      mergeTail, weight, buildItems, itemsToHtml, esc, linkify,
      __setVerbosity: (v) => { verbosity = v; },
    };
  }
})();
