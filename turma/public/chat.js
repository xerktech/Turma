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
  const STOP_SUPPRESS_MS = 4000;    // how long a clicked Stop overrides the busy read
  const ACTION_FAIL_MS = 2000;      // how long the compose button shows a failure

  const PRESETS = {
    concise: { thinking: false, tools: false, outputs: false },
    normal:  { thinking: false, tools: true,  outputs: false },
    verbose: { thinking: true,  tools: true,  outputs: true },
  };

  // Live per-session selectors under the compose box. Values mirror the spawn
  // composer's allowlists (the agent re-validates); picking one changes the
  // RUNNING session — model via the /model picker's session-only path, mode via
  // Shift+Tab cycling.
  //
  // MODEL_OPTS is the static FALLBACK menu, used only when the host hasn't
  // probed its login's real model list yet (or predates the probe) — see
  // modelOpts(), which builds the menu from the heartbeat's `models` block so
  // it offers exactly what this login can actually run (XERK-33).
  const MODEL_OPTS = [
    { value: "default", label: "Default" },
    { value: "opus", label: "Opus" },
    { value: "sonnet", label: "Sonnet" },
    { value: "haiku", label: "Haiku" },
  ];
  // The aliases the menu offers when available, in display order — the same
  // curated set Claude Code's own /model picker shows. Aliases the picker has
  // no row for (best / opusplan / the bracketed 1M variants) are deliberately
  // not offered: the agent's session-only switch drives that picker, so a menu
  // entry it can't reach would be a button that does nothing.
  const MODEL_MENU_ALIASES = ["default", "opus", "fable", "sonnet", "haiku"];
  // The host's real model menu: the curated aliases its probe reported
  // available, labelled with what "Default" currently resolves to. `models` is
  // the heartbeat's {available, defaultLabel} block; absent/empty (an agent
  // predating the probe, or none has succeeded yet) falls back to the static
  // list rather than an empty menu.
  function modelOpts(models) {
    const avail = models && Array.isArray(models.available) ? models.available : null;
    if (!avail || !avail.length) return MODEL_OPTS;
    const opts = MODEL_MENU_ALIASES
      .filter((a) => a === "default" || avail.indexOf(a) !== -1)
      .map((a) => ({
        value: a,
        label: a === "default" && models.defaultLabel
          ? "Default (" + prettyModel(models.defaultLabel) + ")"
          : a[0].toUpperCase() + a.slice(1),
      }));
    return opts.length > 1 ? opts : MODEL_OPTS;
  }
  // Human form of a model signal, which arrives in two shapes: a model id off a
  // transcript's assistant entry ("claude-opus-4-8", "claude-haiku-4-5-20251001",
  // "claude-fable-5[1m]") or an already-friendly display label from a /model
  // confirmation ("Sonnet 5"). Ids are parsed — family word capitalized, digit
  // runs joined into a dotted version, trailing date stamp dropped, "[1m]"
  // rendered as a 1M suffix; anything else passes through untouched.
  function prettyModel(v) {
    if (!v) return "";
    let s = String(v).trim();
    if (!/^claude-/i.test(s)) return s;
    const oneM = /\[1m\]$/i.test(s);
    s = s.replace(/^claude-/i, "").replace(/\[1m\]$/i, "");
    const parts = s.split("-").filter(Boolean);
    const words = [], nums = [];
    for (const p of parts) {
      if (/^\d{8}$/.test(p)) continue; // date stamp, not a version
      if (/^\d+$/.test(p)) nums.push(p);
      else words.push(p[0].toUpperCase() + p.slice(1));
    }
    const name = words.join(" ") + (nums.length ? " " + nums.join(".") : "");
    return (name || String(v)) + (oneM ? " 1M" : "");
  }
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
        // Bare URL: peel trailing sentence punctuation, markdown emphasis
        // markers (e.g. a URL wrapped in **bold**), and typographic quotes
        // (Claude often emits curly ‘’ “” around URLs) back out of the link,
        // and a trailing ')' only when it isn't part of the URL (e.g. a URL
        // wrapped in parens) — keep it for balanced ones like /wiki/Foo_(bar).
        let url = m[3], trail = "";
        const tp = /[.,;:!?'"*_‘’“”]+$/.exec(url);
        if (tp) { trail = tp[0]; url = url.slice(0, -tp[0].length); }
        if (url.endsWith(")") && !url.includes("(")) { trail = ")" + trail; url = url.slice(0, -1); }
        out += anchor(url, url) + esc(trail);
      }
      last = m.index + m[0].length;
    }
    out += esc(s.slice(last));
    return out;
  }

  // ---- inline code spans ----------------------------------------------------
  // `code` inside a run of prose. A backtick string opens a span that closes on
  // the next backtick string of EXACTLY the same length (so ``a `b` c`` holds a
  // literal backtick), and an unclosed run is literal text — both GFM rules.
  //
  // A span never crosses a line break: a stray backtick would otherwise swallow
  // everything down to the next one, taking whole paragraphs (and any table in
  // them) into a code span. GFM allows the wrap; transcript prose is full of
  // lone backticks, so the trade isn't worth it.
  //
  // The span body is esc()'d and NOT linkified — a URL in `code` is being shown,
  // not offered — while the prose around it still goes through linkify().
  function codeSpan(body) {
    // GFM strips one leading + trailing space, so `` ` `` can hold a backtick.
    let b = body;
    if (b.length > 2 && b.startsWith(" ") && b.endsWith(" ") && b.trim() !== "") b = b.slice(1, -1);
    return '<code class="md-code-inline">' + esc(b) + "</code>";
  }
  function runLen(s, i) { let n = 0; while (s[i + n] === "`") n++; return n; }
  function renderInline(text) {
    const s = String(text == null ? "" : text);
    if (s.indexOf("`") < 0) return linkify(s); // no backtick → nothing to lift out
    let out = "", i = 0;
    while (i < s.length) {
      const open = s.indexOf("`", i);
      if (open < 0) { out += linkify(s.slice(i)); break; }
      const n = runLen(s, open);
      // Scan for a closing run of the same length, bailing at a line break.
      let j = open + n, close = -1;
      while (j < s.length) {
        const c = s.indexOf("`", j);
        if (c < 0 || s.slice(open + n, c).indexOf("\n") >= 0) break;
        const m = runLen(s, c);
        if (m === n) { close = c; break; }
        j = c + m;
      }
      if (close < 0) { out += linkify(s.slice(i, open + n)); i = open + n; continue; } // unclosed: literal
      out += linkify(s.slice(i, open)) + codeSpan(s.slice(open + n, close));
      i = close + n;
    }
    return out;
  }

  // ---- markdown tables ------------------------------------------------------
  // Render prose that may contain GitHub-flavoured markdown tables. A table is a
  // header row (a line with `|`) immediately followed by a delimiter row (cells
  // of dashes with optional leading/trailing colons for alignment), then body
  // rows until the first line that isn't a pipe row. Recognised tables become
  // real <table> elements; everything else falls straight through renderInline()
  // so non-table prose is byte-identical to before. Cells and prose alike are
  // renderInline()'d, so injection safety is inherited from esc()/linkify() and
  // `code` works in a cell too.
  //
  // renderProse() runs the fenced-code pass over this one (see below), so a
  // pipe row inside a code block is never mistaken for a table.
  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    // Split on pipes that aren't backslash-escaped, then unescape `\|`.
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  }
  function hasPipe(line) { return line.indexOf("|") >= 0; }
  function isDelimiterRow(line) {
    if (!hasPipe(line)) return false;
    const cells = splitRow(line);
    return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
  }
  function cellAlign(c) {
    const l = c.startsWith(":"), r = c.endsWith(":");
    if (l && r) return "center";
    if (r) return "right";
    if (l) return "left";
    return "";
  }
  function renderTable(header, aligns, rows) {
    const cell = (tag, txt, i) => {
      const a = aligns[i] || "";
      return "<" + tag + (a ? ' style="text-align:' + a + '"' : "") + ">" + renderInline(txt) + "</" + tag + ">";
    };
    let html = '<table class="md-table"><thead><tr>';
    header.forEach((h, i) => { html += cell("th", h, i); });
    html += "</tr></thead><tbody>";
    for (const r of rows) {
      html += "<tr>";
      for (let i = 0; i < header.length; i++) html += cell("td", r[i] == null ? "" : r[i], i);
      html += "</tr>";
    }
    return html + "</tbody></table>";
  }
  function renderTables(text) {
    const s = String(text == null ? "" : text);
    if (s.indexOf("|") < 0) return renderInline(s); // no pipe → no table possible
    const lines = s.split("\n");
    let out = "", i = 0, buf = [];
    const flush = () => { if (buf.length) { out += renderInline(buf.join("\n")); buf = []; } };
    while (i < lines.length) {
      const isTableHead = i + 1 < lines.length && hasPipe(lines[i]) && isDelimiterRow(lines[i + 1]) &&
        splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
      if (isTableHead) {
        flush();
        const header = splitRow(lines[i]);
        const aligns = splitRow(lines[i + 1]).map(cellAlign);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() !== "" && hasPipe(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        out += renderTable(header, aligns, rows);
        continue;
      }
      buf.push(lines[i]); i++;
    }
    flush();
    return out;
  }

  // ---- fenced code blocks ---------------------------------------------------
  // A ``` fence opens a code block that runs to the next fence of at least the
  // same length (or, unterminated, to the end of the text — which is the normal
  // case mid-stream, while the typewriter is still revealing the block, and is
  // why an open fence renders as code rather than waiting for its closer).
  //
  // The opening line must be the fence plus at most a one-word info string
  // (```hcl), so an inline run of backticks in prose can't open a block. The
  // body is never linkified or table-scanned — it's code, and esc() alone is
  // what makes it injection-safe.
  const FENCE_OPEN = /^\s*(`{3,})[ \t]*([^\s`]*)[ \t]*$/;
  function fenceCloses(line, open) {
    const m = /^\s*(`{3,})[ \t]*$/.exec(line);
    return !!m && m[1].length >= open.length;
  }
  function renderCode(lang, body) {
    return '<pre class="md-code"' + (lang ? ' data-lang="' + esc(lang) + '"' : "") +
      "><code>" + esc(body) + "</code></pre>";
  }
  function renderProse(text) {
    const s = String(text == null ? "" : text);
    if (s.indexOf("```") < 0) return renderTables(s); // no fence → nothing to lift out
    const lines = s.split("\n");
    let out = "", i = 0, buf = [];
    const flush = () => { if (buf.length) { out += renderTables(buf.join("\n")); buf = []; } };
    while (i < lines.length) {
      const open = FENCE_OPEN.exec(lines[i]);
      if (open) {
        flush();
        i++;
        const body = [];
        while (i < lines.length && !fenceCloses(lines[i], open[1])) { body.push(lines[i]); i++; }
        i++; // consume the closer; past the end already for an unterminated block
        out += renderCode(open[2], body.join("\n"));
        continue;
      }
      buf.push(lines[i]); i++;
    }
    flush();
    return out;
  }

  // ---- state ----------------------------------------------------------------
  let gen = 0;                      // bumped on every open/close; stale async work checks it
  let hostKey = null, sessionId = null, sess = null, agent = null;
  let buffer = [];                  // merged rich entries {id, role, text, blocks}
  // Prompts typed mid-turn, still waiting in Claude Code's queue (the agent
  // folds queue-operation transcript entries — see foldQueueOp in
  // tunnel-agent.js). Rendered as pending user bubbles under the live turn;
  // replaced wholesale by each tail frame / history load, so a consumed prompt
  // drops out the moment its real user turn lands.
  let queuedPrompts = [];
  let liveTurn = "";                // in-progress assistant text (pane scrape), "" when idle
  let liveStatus = null;            // {verb,up,down,elapsed} working indicator, null when idle
  let ws = null, backoffIdx = 0, wsRetryTimer = null;
  let pollTimer = null;
  // Whether the reader is following the tail. True on open (so we land at the
  // bottom even after the async /history load grows the transcript below the
  // seed paint) and while they're parked at the bottom; flipped false the moment
  // they scroll up (which reveals the "jump to latest" button). This is the
  // source of truth for auto-scroll, NOT a per-repaint scrolledToBottom() read,
  // because that read is stale during the open-time seed→history race.
  let stickBottom = true;
  let cachedToken = null, tokenExp = 0;
  let verbosity = { preset: "normal", show: { ...PRESETS.normal } };
  let questionActive = false;
  // Text of a question we just answered; suppresses re-showing its box while an
  // in-flight heartbeat still reports it as pending (cleared once it's gone).
  let answeredQuestion = null;
  // When Stop was clicked, or 0. See composeBusy().
  let stopPendingAt = 0;
  // Until when the compose button is showing a transient failure message.
  let actionFailUntil = 0;

  // reveal (only the live turn types in; committed messages render whole)
  let reveal = { shown: 0 };
  let revealFull = "";
  let rafId = null, lastTs = 0;

  // The HTML currently in the scroll, and whether a changed paint was held back
  // because the reader was selecting text. See repaint()/selectionInScroll().
  let lastHtml = null;
  let repaintDeferred = false;

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
      if (frame && frame.type === "tail" && Array.isArray(frame.entries)) {
        if (frame.entries.length) buffer = mergeTail(buffer, frame.entries);
        // Every tail frame carries the CURRENT still-queued prompt list (an
        // agent predating the field sends none — keep whatever we had).
        if (Array.isArray(frame.queued)) queuedPrompts = frame.queued;
        repaint();
      } else if (frame && frame.type === "turn" && typeof frame.text === "string") {
        applyTurn(frame.text);
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
    if (Array.isArray(j.queued)) queuedPrompts = j.queued;
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
  //
  // EVERY block payload field counts, not just text/input: a command block
  // carries its content in name/args (a task_notification in summary/result),
  // and leaving those out made the rich copy TIE its own flat text — and the
  // `>=` tie-break then let a text-only seed clobber the blocks right back off
  // the entry (a `!` chip regressing to a raw user bubble).
  function weight(e) {
    let w = (e.text || "").length;
    for (const b of (e.blocks || [])) {
      w += (b.text || "").length + (b.input || "").length + (b.name || "").length +
        (b.args || "").length + (b.summary || "").length + (b.result || "").length;
    }
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
  //        | {kind:"command", id, name, args, argsTrunc, result:{text,isError,truncated}|null}
  //        | {kind:"compact", id, text, truncated}
  //        | {kind:"interrupt", id, text} | {kind:"away", id, text, truncated}
  function buildItems(entries) {
    const resultsById = new Map();
    const toolUseIds = new Set();
    for (const e of entries) for (const b of (e.blocks || [])) {
      if (b.t === "tool_use" && b.id) toolUseIds.add(b.id);
      // Last result wins, deliberately: a Skill call reports twice — a
      // "Launching skill: <name>" stub, then the skill body itself, which the
      // agent tags with the same tool_use id (hub-agent.py _entry_tool_source).
      // Later means richer, and the body is what a reader opening the card wants.
      if (b.t === "tool_result" && b.forId) resultsById.set(b.forId, b);
    }
    const items = [];
    // A slash command's output arrives as its OWN transcript entry, right after
    // the invocation — there's no id to pair them by (unlike tool_use/
    // tool_result), so fold an output into the command card still open from the
    // preceding entry, the way the transcript itself orders them.
    let openCmd = null;
    for (const e of entries) {
      const role = e.role === "user" ? "user" : "assistant";
      // The live path keys the entry on `id` (uuid->id in _history_entries); the
      // archive keeps it on `uuid` (GET /api/archive/<id>). Accept either so the
      // same buildItems drives both — data-uuid (scroll-to-hit) and the card
      // persistence keys stay real for archived transcripts too.
      const eid = e.id != null ? e.id : e.uuid;
      // Older agents / the text-only cache seed carry no blocks: synthesize one.
      const blocks = (e.blocks && e.blocks.length)
        ? e.blocks
        : (e.text ? [{ t: "text", text: e.text }] : []);
      let msg = null;
      const flush = () => { if (msg) { items.push(msg); msg = null; } };
      for (const b of blocks) {
        // Anything else between an invocation and an output means that output
        // isn't this command's — stop holding the card open for it.
        if (b.t !== "command" && b.t !== "command_output") openCmd = null;
        if (b.t === "text") {
          if (!msg) msg = { kind: "msg", role, id: eid, text: "", truncated: false };
          msg.text += b.text || "";
          if (b.truncated) msg.truncated = true;
        } else if (b.t === "thinking") {
          flush();
          items.push({ kind: "thinking", id: eid, text: b.text || "", truncated: !!b.truncated });
        } else if (b.t === "tool_use") {
          flush();
          const res = b.id ? resultsById.get(b.id) : null;
          items.push({
            kind: "action", id: b.id || null, name: b.name || "tool",
            input: b.input || "", inputTrunc: !!b.truncated, entryId: eid,
            result: res ? { text: res.text || "", isError: !!res.isError, truncated: !!res.truncated } : null,
          });
        } else if (b.t === "tool_result") {
          if (b.forId && toolUseIds.has(b.forId)) continue; // folded into its tool_use card
          flush();
          items.push({
            kind: "action", id: b.forId || null, name: "result", input: "", inputTrunc: false, entryId: eid,
            result: { text: b.text || "", isError: !!b.isError, truncated: !!b.truncated }, orphan: true,
          });
        } else if (b.t === "command") {
          flush();
          openCmd = {
            kind: "command", id: eid, name: b.name || "/command",
            args: b.args || "", argsTrunc: !!b.truncated, result: null,
          };
          items.push(openCmd);
        } else if (b.t === "command_output") {
          flush();
          // resultId, not the card's id: the output is its OWN transcript entry,
          // so that's the entry "Show more" has to re-fetch a fuller copy of.
          const result = {
            text: b.text || "", isError: !!b.isError, truncated: !!b.truncated, entryId: eid,
          };
          if (openCmd && !openCmd.result) {
            openCmd.result = result;
          } else {
            // Output with no invocation ahead of it (scrolled-off command, or a
            // tail window that starts mid-sequence): show it on its own.
            items.push({ kind: "command", id: eid, name: "output", args: "", argsTrunc: false, result });
          }
          openCmd = null;
        } else if (b.t === "compact_summary") {
          flush();
          items.push({ kind: "compact", id: eid, text: b.text || "", truncated: !!b.truncated });
        } else if (b.t === "interrupt") {
          // "[Request interrupted by user…]" — a statement about the turn, not
          // something the operator typed; rendered as a centred status marker.
          flush();
          items.push({ kind: "interrupt", id: eid, text: b.text || "" });
        } else if (b.t === "away_summary") {
          // The model's "while you were away" recap — an assistant-side card,
          // like the compact summary, not a bubble.
          flush();
          items.push({ kind: "away", id: eid, text: b.text || "", truncated: !!b.truncated });
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
            input: "", inputTrunc: false, entryId: eid, result, task: true,
          });
        }
      }
      flush();
    }
    return items;
  }

  // ---- rendering ------------------------------------------------------------
  // Static (archived) renders have no /history to expand into — the stored
  // transcript is already the fullest copy — so the "Show more…" affordance is
  // suppressed there; the live view keeps it.
  let noExpand = false;
  function truncBtn(entryId, truncated) {
    return (truncated && !noExpand) ? '<button class="trunc" data-eid="' + esc(entryId) + '">Show more…</button>' : "";
  }

  function renderMsg(it) {
    const cls = it.role === "user" ? "user" : "assistant";
    return '<div class="tr-msg ' + cls + '" data-uuid="' + esc(it.id) + '"><span class="role">' + cls + "</span>" +
      renderProse(it.text) + truncBtn(it.id, it.truncated) + "</div>";
  }

  function renderThought(it) {
    if (!verbosity.show.thinking) return ""; // hidden by verbosity
    const key = "th:" + it.id;
    return '<details class="thought" data-dkey="' + esc(key) + '" data-uuid="' + esc(it.id) + '"' + openAttr(key, true) +
      "><summary>💭 Thought</summary>" +
      '<div class="thought-body">' + renderProse(it.text) + truncBtn(it.id, it.truncated) + "</div></details>";
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
    return '<details class="action-card' + (statusCls ? " " + statusCls : "") + taskCls + '" data-dkey="' + esc(key) +
      '" data-uuid="' + esc(it.entryId) + '"' +
      openAttr(key, verbosity.show.outputs) + ">" +
      "<summary>" + icon + '<span class="tool-name">' + esc(it.name) + "</span>" +
      '<span class="tool-arg">' + argOne + "</span></summary>" +
      '<div class="tool-body">' + body + "</div></details>";
  }

  // A slash command the operator ran (/compact, /clear, …) and its output. Not
  // the human talking and not a tool call: rendered as a compact chip rather
  // than a bubble, and — unlike an action card — never hidden by Concise, since
  // it's the operator's own intent and one line either way.
  function renderCommandCard(it) {
    const key = "cmd:" + it.id;
    const head = '<span class="cmd-glyph">›</span><span class="cmd-name">' + esc(it.name) + "</span>" +
      (it.args ? '<span class="cmd-args">' + esc(it.args.split("\n")[0]) + "</span>" : "");
    if (!it.result) {
      return '<div class="cmd-card" data-uuid="' + esc(it.id) + '">' + head +
        truncBtn(it.id, it.argsTrunc) + "</div>";
    }
    return '<details class="cmd-card' + (it.result.isError ? " err" : "") + '" data-dkey="' + esc(key) +
      '" data-uuid="' + esc(it.id) + '"' + openAttr(key, false) + "><summary>" + head + "</summary>" +
      '<div class="cmd-body"><pre>' + esc(it.result.text || "(no output)") + "</pre>" +
      truncBtn(it.result.entryId || it.id, it.result.truncated) + "</div></details>";
  }

  // The summary Claude writes when the context is compacted. The transcript
  // stores it as a user turn, but the model wrote it — so it renders on the
  // assistant's side, collapsed, rather than as a wall of text the operator
  // appears to have typed.
  function renderCompactCard(it) {
    const key = "cmp:" + it.id;
    return '<details class="compact-card" data-dkey="' + esc(key) + '" data-uuid="' + esc(it.id) + '"' +
      openAttr(key, false) + "><summary>↺ Context compacted — summary of the conversation so far</summary>" +
      '<div class="compact-body">' + renderProse(it.text) + truncBtn(it.id, it.truncated) + "</div></details>";
  }

  // "[Request interrupted by user…]" as a centred, muted status marker — the
  // one thing the TUI's red ⎿ marker says that matters here is THAT the turn
  // was cut, so the label is the marker text without its brackets.
  function renderInterrupt(it) {
    const label = String(it.text || "Request interrupted by user").replace(/^\[|\]$/g, "");
    return '<div class="chat-interrupt" data-uuid="' + esc(it.id) + '">◼ ' + esc(label) + "</div>";
  }

  // The "while you were away" recap, collapsed like the compact-summary card.
  // Never hidden by verbosity: it exists precisely for the operator who was
  // not watching, and it's one line while closed.
  function renderAwayCard(it) {
    const key = "away:" + it.id;
    return '<details class="away-card" data-dkey="' + esc(key) + '" data-uuid="' + esc(it.id) + '"' +
      openAttr(key, false) + "><summary>☾ While you were away — recap</summary>" +
      '<div class="away-body">' + renderProse(it.text) + truncBtn(it.id, it.truncated) + "</div></details>";
  }

  function itemsToHtml(items) {
    const out = [];
    let i = 0, g = 0;
    while (i < items.length) {
      const it = items[i];
      if (it.kind === "msg") { out.push(renderMsg(it)); i++; continue; }
      if (it.kind === "thinking") { out.push(renderThought(it)); i++; continue; }
      if (it.kind === "command") { out.push(renderCommandCard(it)); i++; continue; }
      if (it.kind === "compact") { out.push(renderCompactCard(it)); i++; continue; }
      if (it.kind === "interrupt") { out.push(renderInterrupt(it)); i++; continue; }
      if (it.kind === "away") { out.push(renderAwayCard(it)); i++; continue; }
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

  // Is the reader mid-selection inside the transcript? A repaint replaces the
  // scroll's innerHTML wholesale, which destroys every node the selection is
  // anchored to — so a live session (a `turn` frame lands ~1s while the agent
  // works) would wipe the selection out from under a reader trying to copy.
  // Deferring the paint while a selection is live is what makes copy reliable.
  function selectionInScroll() {
    const scroll = $("chatScroll");
    if (!scroll || typeof window === "undefined" || !window.getSelection) return false;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    for (let i = 0; i < sel.rangeCount; i++) {
      const r = sel.getRangeAt(i);
      if (!r.collapsed && scroll.contains(r.commonAncestorContainer)) return true;
    }
    return false;
  }

  function repaint() {
    const scroll = $("chatScroll");
    if (!scroll) return;
    const pin = stickBottom;
    const prevTop = scroll.scrollTop;
    const items = buildItems(buffer);
    let html = itemsToHtml(items);
    if (!html && !liveTurn && !queuedPrompts.length) html = '<div class="chat-empty">No messages yet. Say something below to get the agent going.</div>';
    // The in-progress assistant turn (streaming, text-only) as the trailing
    // bubble; its text is revealed by the typewriter loop.
    if (liveTurn) {
      // liveTurn is already classified by applyTurn (block swaps / tool bullets /
      // shrinks handled there — see XERK-19), so by here it only grows within a
      // block or was reset to shown=0 for a new one. This prefix check is a
      // defensive clamp for any other path that sets liveTurn directly: if the
      // new text doesn't continue the revealed slice, snap `shown` to it rather
      // than typewriting the tail of an unrelated block from a stale offset.
      if (!liveTurn.startsWith(revealFull.slice(0, reveal.shown))) reveal.shown = liveTurn.length;
      revealFull = liveTurn;
      const shownText = liveTurn.slice(0, Math.max(0, reveal.shown));
      html += '<div class="tr-msg assistant streaming" id="chatLiveBubble"><span class="role">assistant</span>' +
        esc(shownText) + "</div>";
    } else {
      revealFull = "";
      reveal.shown = 0;
    }
    // Still-queued prompts (typed mid-turn) trail the live turn, where they'll
    // actually run — the TUI shows the same list under its input box. Each is a
    // dimmed user bubble labelled "queued"; the list is replaced wholesale by
    // every tail frame, so a consumed prompt swaps for its real user turn.
    for (const q of queuedPrompts) {
      html += '<div class="tr-msg user queued"><span class="role">queued</span>' + esc(q) + "</div>";
    }
    // Most repaints are no-ops: the /history poll and the ~1s `turn` frame fire
    // whether or not anything changed, and re-writing identical HTML still
    // destroys the selection (and the reader's place). Compare first and touch
    // the DOM only on a real change.
    if (html === lastHtml) {
      updateJump();
      updateLiveStatus();
      if (liveTurn) startReveal();
      return;
    }
    // Something DID change, but the reader is mid-selection — hold the paint and
    // flush it once the selection clears (selectionchange, below).
    if (selectionInScroll()) {
      repaintDeferred = true;
      updateLiveStatus();
      return;
    }
    repaintDeferred = false;
    scroll.innerHTML = html;
    lastHtml = html;
    // Stay pinned to the bottom while following along; otherwise hold the
    // reader's place (innerHTML replacement resets scrollTop to 0, and new
    // entries only append below, so the prior offset still points at the same
    // content).
    scroll.scrollTop = pin ? scroll.scrollHeight : prevTop;
    updateJump();
    updateLiveStatus();
    if (liveTurn) startReveal();
  }

  // The floating "jump to latest" pill hovering just above the compose box: shown
  // only when the reader has scrolled up off the tail (and there's actually room
  // to scroll). Clicking it (chatJumpBottom) re-pins to the bottom.
  function updateJump() {
    const btn = $("chatJump"), scroll = $("chatScroll");
    if (!btn || !scroll) return;
    const scrollable = scroll.scrollHeight - scroll.clientHeight > 60;
    btn.hidden = stickBottom || !scrollable;
  }
  function jumpToBottom() {
    const scroll = $("chatScroll");
    if (!scroll) return;
    stickBottom = true;
    scroll.scrollTop = scroll.scrollHeight;
    updateJump();
  }

  // The pinned working-status bar (a sibling of the scroll, so a scroll repaint
  // never touches it): spinner + gerund verb + live ↑/↓ token counters, plus —
  // on a second de-emphasized line — Claude Code's contextual hint/task footer,
  // mirroring the terminal's bottom status region. Shown only while generating.
  function updateLiveStatus() {
    // The compose button reads the same liveStatus this bar does — repaint it
    // here so both surfaces flip on the same ~1s frame.
    updateComposeAction();
    const bar = $("chatStatus");
    if (!bar) return;
    const st = liveStatus;
    if (!st) { bar.hidden = true; bar.innerHTML = ""; return; }
    const verb = esc(st.verb || "Working");
    const toks =
      (st.up ? '<span class="tok up">↑ ' + esc(st.up) + "</span>" : "") +
      (st.down ? '<span class="tok down">↓ ' + esc(st.down) + "</span>" : "");
    const elapsed = st.elapsed ? '<span class="tok elapsed">' + esc(st.elapsed) + "</span>" : "";
    // The hint is one rotating tip/task line, or an active-task checklist the
    // agent sends newline-joined (a to-do item per line) — render each on its
    // own row so the whole list shows below the verb, not just the first item.
    const hint = st.hint
      ? st.hint.split("\n").map((h) => '<div class="cc-hint">' + esc(h) + "</div>").join("")
      : "";
    bar.hidden = false;
    bar.innerHTML =
      '<div class="cc-row"><span class="cc-spin"></span>' +
      '<span class="verb">' + verb + "…</span>" +
      '<span class="toks">' + elapsed + toks + "</span></div>" +
      hint +
      agentsHtml(st.agents);
    wireAgentDelegation(bar);
  }

  // ---- the compose buttons: Send always sends; ◼ Stop appears mid-turn ------
  // Send never morphs into Stop: a message sent while the agent works QUEUES
  // (Claude Code runs it when the turn ends, and the chat shows it as a dimmed
  // "queued" bubble), so the button that talks has to stay available mid-turn —
  // on a phone it is the ONLY way to send, and morphing it into Stop made
  // queueing impossible there. Stop is its own warning-coloured button beside
  // Send, shown only while a turn is running (`composeBusy`), still in the
  // compose row rather than parked in the header away from where the operator
  // is typing.
  //
  // `liveStatus` is the busy read because it's the fastest one on the page: the
  // tunnel scrapes the pane's "esc to interrupt" hint every ~1s and pushes a
  // `turn` frame carrying the status (null the moment generating ends), where the
  // heartbeat's paneBusy is a beat or more behind. When the socket is down and no
  // frames arrive, liveStatus stays null and Stop stays hidden — the safe
  // degradation, since a Stop that can't see the turn is worse than no Stop.
  function composeBusy() {
    // A pending AskUserQuestion is answered THROUGH the compose box — a typed
    // reply routes to /answer as a custom answer (see send()). So while a question
    // is up Stop is hidden even though the pane still reads busy (the
    // AskUserQuestion tool call is blocking): clicking Stop there would
    // interrupt the turn and destroy the question, which is exactly the wrong
    // thing when the operator only wanted to type a custom response (XERK-21).
    if (questionActive) { stopPendingAt = 0; return false; }
    if (!liveStatus) { stopPendingAt = 0; return false; }
    // A clicked Stop only lands on the agent's next beat, so the pane keeps
    // reporting the turn for a second or two afterwards. Hide Stop immediately
    // anyway — the operator asked for the turn to end and shouldn't watch a
    // dead Stop to find out it worked. If the turn is somehow still alive once
    // the window lapses, the interrupt didn't take and Stop legitimately comes
    // back.
    if (stopPendingAt) {
      if (Date.now() - stopPendingAt < STOP_SUPPRESS_MS) return false;
      stopPendingAt = 0;
    }
    return true;
  }
  function isBusy() { return composeBusy(); }

  // Paint every compose bar on the page (the chat's and — while the terminal
  // toggle is showing, with this engine still warm underneath it — the
  // terminal's) from the one busy read: Send keeps its label (only its tooltip
  // says whether a send queues), and the ◼ Stop beside it shows only mid-turn.
  function updateComposeAction() {
    if (typeof document === "undefined") return;
    const busy = composeBusy();
    if (actionFailUntil && Date.now() < actionFailUntil) return; // let the failure text stand
    actionFailUntil = 0;
    for (const btn of document.querySelectorAll(".compose-action")) {
      btn.textContent = "Send";
      btn.title = busy
        ? "Send now — the message queues and runs when this turn ends"
        : "Send this message to the agent";
    }
    for (const btn of document.querySelectorAll(".compose-stop")) {
      btn.hidden = !busy;
      btn.textContent = "◼ Stop";
      btn.title = "Stop the agent's current turn (Esc) — the session keeps running";
    }
  }
  // Show a transient failure on a compose-bar button (`sel` picks which — the
  // Send buttons by default, the Stop buttons for a failed interrupt), then
  // repaint normally.
  function actionFailed(text, sel) {
    actionFailUntil = Date.now() + ACTION_FAIL_MS;
    const btns = document.querySelectorAll(sel || ".compose-action");
    for (const btn of btns) btn.textContent = text;
    setTimeout(() => { actionFailUntil = 0; updateComposeAction(); }, ACTION_FAIL_MS);
  }

  // Interrupt the in-flight turn: POST .../interrupt, which the agent delivers as
  // an Escape into the session's TUI — the turn is cancelled, the session and its
  // conversation keep running. Nothing is destroyed, so there's no arm-then-
  // confirm step the way Kill has.
  async function stop() {
    if (!hostKey || !sessionId) return;
    stopPendingAt = Date.now();
    updateComposeAction();
    // Nothing else repaints once the pane goes quiet, so re-check the button when
    // the suppression window lapses.
    setTimeout(updateComposeAction, STOP_SUPPRESS_MS + 50);
    try {
      const r = await fetch("/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/interrupt",
        { method: "POST" });
      if (!r.ok) throw new Error(String(r.status));
      if (typeof fastPoll === "function") fastPoll();
    } catch {
      stopPendingAt = 0; // the turn is still running — give Stop back right away
      updateComposeAction();
      actionFailed("Stop failed", ".compose-stop");
    }
  }

  // The live agent-manager list scraped from the pane (parseAgentList in
  // tunnel-agent.js). Each subagent row is a button that opens that background
  // agent's transcript (see openSubagentView); "main" is the session itself —
  // already on screen — so it's a plain marker, not a link. Absent/empty -> "".
  function agentsHtml(agents) {
    if (!Array.isArray(agents) || !agents.length) return "";
    const rows = agents.map((a) => {
      const dot = '<span class="dot' + (a.sel ? " sel" : "") + '"></span>';
      const type = '<span class="atype">' + esc(a.type) + "</span>";
      const label = a.label ? '<span class="alabel">' + esc(a.label) + "</span>" : "";
      // "main" (the parent conversation) has no separate transcript to open.
      if (a.type === "main" && !a.label) return '<div class="cc-agent main">' + dot + type + "</div>";
      return '<button type="button" class="cc-agent" data-atype="' + esc(a.type) +
        '" data-alabel="' + esc(a.label || "") + '">' + dot + type + label + "</button>";
    });
    return '<div class="cc-agents"><div class="cc-agents-hd">Agents</div>' + rows.join("") + "</div>";
  }

  // One delegated click handler on the status bar: a subagent row opens its
  // transcript through the host page (openSubagentView, defined in sessions.html)
  // — chat.js has the host/session, the host owns the read-only stage.
  function wireAgentDelegation(bar) {
    if (!bar || bar.dataset.agentsWired) return;
    bar.dataset.agentsWired = "1";
    bar.addEventListener("click", (e) => {
      const b = e.target.closest && e.target.closest(".cc-agent[data-atype]");
      if (!b) return;
      e.preventDefault();
      if (typeof window.openSubagentView === "function") {
        window.openSubagentView(b.getAttribute("data-atype"), b.getAttribute("data-alabel") || "");
      }
    });
  }

  // Repaint from outside (e.g. returning from the terminal toggle).
  function repaintPublic() { renderVerbosityControl(); renderComposeOpts(); repaint(); }

  // A tool-use bullet as it renders in the pane's ● block after reflow:
  // an identifier (Bash, Read, Update, Task, mcp__server__tool, …) immediately
  // followed by "(" — e.g. "Bash(git status)", "Read(app.js)". Prose almost
  // never opens "Word(" with no space, and a false positive only skips ONE
  // block's live typing preview (it still renders in full once the transcript
  // commits it) — a safe degradation — while a missed tool bullet brings the
  // flicker back, so the test deliberately leans toward matching.
  function isToolBullet(t) { return /^[\w-]+\(/.test(t); }

  // Fold a pane-scrape `turn` frame into the streaming bubble. The pane's
  // "last ● bullet" is NOT a growing stream: within one generating turn it
  // SWAPS between blocks — assistant prose, then a tool-use bullet (Bash(…),
  // Read(…)), then the next prose. Feeding every swap straight to the bubble is
  // what makes "the final line delete and re-appear over and over" (XERK-19):
  // the tool bullet swaps in (the line deletes) and prose swaps back (it
  // reappears). So classify the frame instead of trusting it verbatim:
  //  - empty, or a tool-use bullet -> the streaming block is over (or is a tool
  //    that renders as a committed card, not raw text here). Clear the bubble;
  //    the committed transcript owns what just finished.
  //  - the SAME prose block, grown or re-captured shorter -> keep the LONGER
  //    text and never shrink. A shorter partial re-capture of the same block is
  //    what re-typed the tail from a stale offset; holding it keeps the reveal's
  //    place so only genuine new characters type in.
  //  - a genuinely different prose block -> retype it from 0, not from the
  //    previous block's offset.
  // This stands in for glasses/src/reveal.ts advanceReveal's entryId-change
  // snap; the pane scrape has no id, so the revealed prose stands in for it.
  function applyTurn(text) {
    const t = typeof text === "string" ? text : "";
    if (!t || isToolBullet(t)) { liveTurn = ""; return; }
    if (t.startsWith(liveTurn) || liveTurn.startsWith(t)) {
      // Same block: grow to the longer capture, ignore a shorter re-capture.
      if (t.length >= liveTurn.length) liveTurn = t;
      return;
    }
    liveTurn = t;
    reveal.shown = 0;
  }

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
    // The reveal rewrites the live bubble in place, so it clobbers a selection
    // anchored inside it just like a repaint does. Idle the loop (holding the
    // revealed text where it is) until the reader is done selecting.
    if (selectionInScroll()) { rafId = requestAnimationFrame(tick); return; }
    const target = revealFull.length;
    if (reveal.shown < target) {
      const backlog = target - reveal.shown;
      if (backlog > REVEAL_SNAP_CHARS) reveal.shown = target;
      else reveal.shown = Math.min(target, reveal.shown + Math.max(1, Math.floor(REVEAL_RATE_CPS * dt / 1000)));
      const scroll = $("chatScroll");
      // Rebuild the bubble text: role span + revealed slice.
      bubble.innerHTML = '<span class="role">assistant</span>' + esc(revealFull.slice(0, reveal.shown));
      if (stickBottom && scroll) scroll.scrollTop = scroll.scrollHeight;
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
  // Shared Concise/Normal/Verbose segmented control. `onPick` runs after the
  // preset is applied (persist + repaint), so the live and static views can
  // reuse the same widget with their own save/repaint.
  function buildVerbositySeg(host, onPick) {
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
      onPick();
    }));
  }
  function renderVerbosityControl() {
    buildVerbositySeg($("chatVerbosity"), () => { saveVerbosity(); renderVerbosityControl(); repaint(); });
  }
  // ---- live agent-mode / model selectors (under the compose box) ------------
  function availableModelOpts() {
    return modelOpts(agent && agent.models);
  }
  function currentModelValue() {
    const m = (sess && sess.model) ? String(sess.model).toLowerCase() : "default";
    return availableModelOpts().some((o) => o.value === m) ? m : "default";
  }
  // A just-picked model switch, held until the agent confirms it (modelActual
  // moves), the heartbeat starts carrying the agent's own pendingModel, or it
  // times out. Without this the chip would flash BACK to the old actual model
  // for the beat or two between the optimistic paint and the confirmation
  // landing — which reads as the switch not taking.
  let modelSwitchPending = null; // {value, prevActual, at}
  const MODEL_SWITCH_SETTLE_MS = 30000;
  // What the model chip SAYS: a switch still in flight (the agent's deferred
  // pendingModel, or our own just-clicked memo) with an ellipsis, else the
  // model actually answering (per the agent's transcript read) over the picked
  // alias, which in turn beats a bare "Default" — the chip's old text, which
  // told the operator nothing (XERK-33).
  function modelChipLabel() {
    const actual = sess && sess.modelActual;
    const pending = sess && sess.pendingModel;
    if (pending) {
      // The agent itself says the pick is waiting for an idle beat — that
      // outranks (and retires) the click-time memo.
      modelSwitchPending = null;
      return optLabel(availableModelOpts(), String(pending).toLowerCase()) + "…";
    }
    if (modelSwitchPending) {
      const settled = actual !== modelSwitchPending.prevActual ||
        Date.now() - modelSwitchPending.at > MODEL_SWITCH_SETTLE_MS;
      if (!settled) return optLabel(availableModelOpts(), modelSwitchPending.value) + "…";
      modelSwitchPending = null;
    }
    if (actual) return prettyModel(actual);
    return optLabel(availableModelOpts(), currentModelValue());
  }
  // The mode switch's counterpart memo: hold the picked mode until the
  // heartbeat's permissionMode agrees (the agent reconciles it from the TUI's
  // own footer marker, so agreement means the switch really landed) or the
  // settle window passes (an unreachable mode legitimately never lands, and
  // the chip goes back to the truth).
  let modeSwitchPending = null; // {value, at}
  const MODE_SWITCH_SETTLE_MS = 30000;
  function modeChipValue() {
    if (modeSwitchPending) {
      const settled = (sess && sess.permissionMode === modeSwitchPending.value) ||
        Date.now() - modeSwitchPending.at > MODE_SWITCH_SETTLE_MS;
      if (!settled) return modeSwitchPending.value;
      modeSwitchPending = null;
    }
    return currentModeValue();
  }
  function currentModeValue() {
    const m = (sess && sess.permissionMode) ? sess.permissionMode : "auto";
    return MODE_OPTS.some((o) => o.value === m) ? m : "auto";
  }
  // Restrict the mode menu to the modes this session's live Shift+Tab cycle can
  // actually reach — the agent reports them as `session.permissionModes`
  // (perm_cycle_for in hub-agent.py: the base modes plus whichever optional the
  // session was launched into). Switching to a mode outside that set is a no-op
  // agent-side, so we don't offer it. The current mode is always kept so the
  // selector can never hide the active choice, and an older agent that omits the
  // field falls back to showing every mode.
  function filterModeOpts(allOpts, available, current) {
    if (!Array.isArray(available)) return allOpts;
    return allOpts.filter((o) => available.indexOf(o.value) !== -1 || o.value === current);
  }
  function availableModeOpts() {
    return filterModeOpts(MODE_OPTS, sess && sess.permissionModes, currentModeValue());
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
  // The PR's merge-readiness verdict ('ready'/'blocked'/'pending'/""), derived
  // agent-side from CI *and* mergeability together (_merge_ready in
  // hub-agent.py) — green CI on a conflicting branch is not a PR that can land.
  // An agent predating the field reports the CI half alone, so fall back to
  // that rather than dropping the mark. Kept in sync with index.html and
  // sessions.html.
  function prReady(pr) {
    return pr.ready || { passing: "ready", failing: "blocked", pending: "pending" }[pr.checks] || "";
  }
  // What that mark is saying, for its tooltip: the CI rollup, plus — for a PR
  // that could still land — whether GitHub says it merges.
  function prReadyTitle(pr) {
    const state = String(pr.state || "").toUpperCase();
    const parts = [];
    if (pr.checks) parts.push("CI " + pr.checks);
    if (pr.mergeable && (state === "OPEN" || state === "DRAFT"))
      parts.push(pr.mergeable === "CONFLICTING" ? "merge conflict"
        : pr.mergeable === "MERGEABLE" ? "no conflicts" : "mergeability unknown");
    return parts.join(" · ");
  }
  // One PR badge (state colour + #number + merge-readiness mark), linked to the PR.
  function prBadge(pr) {
    const url = pr.url || "";
    const m = url.match(/\/pull\/(\d+)/);
    const num = pr.number ? "#" + pr.number : (m ? "#" + m[1] : "PR");
    const state = String(pr.state || "").toUpperCase();
    const cls = { OPEN: "pr-open", DRAFT: "pr-draft", MERGED: "pr-merged", CLOSED: "pr-closed" }[state] || "";
    const label = state ? state[0] + state.slice(1).toLowerCase() : "";
    const ready = prReady(pr);
    const mark = ready === "ready" ? "✓" : ready === "blocked" ? "✗" : ready === "pending" ? "●" : "";
    const chk = mark ? ' <span class="pr-ready ' + ready + '" title="' + esc(prReadyTitle(pr)) + '">' + mark + "</span>" : "";
    return '<a class="pr-badge ' + cls + '" href="' + esc(url) +
      '" target="_blank" rel="noopener" title="' + esc(pr.title || url) + '">' +
      '<span class="pr-dot"></span>' + esc(num) + (label ? " " + esc(label) : "") + chk + "</a>";
  }
  // PR status chips for the footer, next to 🛡 mode / 🧠 model. Lists every PR
  // the session opened (newest first — the freshest link leads), each linked
  // with its own state colour + #number + CI-check mark. "" when none.
  function prFooterChip(s) {
    const prs = (s && s.prs) || [];
    if (!prs.length) return "";
    const badges = prs.slice().reverse().map(prBadge).join("");
    return '<span class="cc-opt cc-pr">' + badges + "</span>";
  }
  // The Jira ticket this session was spawned to work (session.ticket, stamped by
  // the agent at spawn) — the reverse of the board's ticket -> session link, for
  // the footer beside the PR chip. "" for an ordinary session.
  //
  // It links to that ticket on Turma's OWN board (its detail panel deep-links
  // open via /board?ticket=&site=), not out to Jira (XERK-16): the board is
  // where this ticket's repo triage, its other sessions, and its controls live,
  // so from inside a session that is the more useful hop — and the board card
  // links on to the live Jira issue in turn. Same-tab, since it's an in-app nav.
  function ticketFooterChip(s) {
    const t = (s && s.ticket) || null;
    if (!t || !t.key) return "";
    const tip = [t.summary, t.branch ? "branch " + t.branch : ""].filter(Boolean).join(" · ");
    const href = "/board?ticket=" + encodeURIComponent(t.key) +
      (t.siteKey ? "&site=" + encodeURIComponent(t.siteKey) : "");
    return '<span class="cc-opt cc-ticket">' +
      '<a class="jira-chip" href="' + esc(href) + '"' +
      ' title="' + esc(tip || t.key) + '">' + esc(t.key) + "</a></span>";
  }
  // fromPoll: a background heartbeat repaint — don't yank an open menu shut.
  function renderComposeOpts(fromPoll) {
    const host = $("chatComposeOpts");
    if (!host) return;
    if (fromPoll && host.querySelector(".cc-menu.open")) return;
    const mode = modeChipValue(), model = currentModelValue();
    const modeOpts = availableModeOpts();
    const mOpts = availableModelOpts();
    const mTitle = "Model for this session — switched live, session-only" +
      (sess && sess.pendingModel ? " (switching after the current turn)"
        : sess && sess.modelActual ? " (now: " + sess.modelActual + ")" : "");
    host.innerHTML =
      '<span class="cc-opt cc-mode">' +
        '<button class="cc-btn" id="ccModeBtn" title="Agent (permission) mode — switched live, best-effort">' +
        '🛡 <span class="cc-val">' + esc(optLabel(MODE_OPTS, mode)) + '</span><span class="cc-caret">▾</span></button>' +
        '<span class="cc-menu" id="ccModeMenu"><span class="cc-hint">Agent mode</span>' +
        menuHtml(modeOpts, mode, "data-mode") + "</span></span>" +
      '<span class="cc-right">' + ticketFooterChip(sess) + prFooterChip(sess) +
        '<span class="cc-opt cc-model">' +
          '<button class="cc-btn" id="ccModelBtn" title="' + esc(mTitle) + '">' +
          '<span class="cc-val">' + esc(modelChipLabel()) + '</span><span class="cc-caret">▾</span> 🧠</button>' +
          '<span class="cc-menu" id="ccModelMenu"><span class="cc-hint">Model</span>' +
          menuHtml(mOpts, model, "data-model") + "</span></span>" +
      "</span>";
    wireComposeMenu("ccModeBtn", "ccModeMenu", "data-mode", setSessionMode);
    wireComposeMenu("ccModelBtn", "ccModelMenu", "data-model", setSessionModel);
  }
  async function setSessionModel(value) {
    if (!hostKey || !sessionId || !sess || value === currentModelValue()) return;
    modelSwitchPending = { value, prevActual: sess.modelActual || null, at: Date.now() };
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
    // The memo alone paints the picked mode — deliberately NOT written onto
    // sess.permissionMode: the memo settles when the HEARTBEAT's mode agrees,
    // and an optimistic local write would satisfy that test instantly, letting
    // the next stale beat flash the old mode back (the exact flicker the memo
    // exists to stop).
    modeSwitchPending = { value, at: Date.now() };
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
  // Build one option card: label + optional description + a collapsible preview
  // (the rendered mockup/code the TUI shows on the right). `rich` is the
  // {label, description?, preview?} shape from `questionOptionsRich`; when only
  // the legacy label strings are present it degrades to label-only.
  function optionCardHtml(rich, i, multi) {
    const label = esc(rich.label || "");
    const head = multi
      ? '<input type="checkbox" class="q-check" id="qopt-' + i + '" data-idx="' + i + '">' +
        '<label class="q-opt-label" for="qopt-' + i + '">' + label + "</label>"
      : '<span class="q-opt-label">' + label + "</span>" +
        '<button class="q-opt-pick" data-idx="' + i + '">Choose</button>';
    let body = "";
    if (rich.description) body += '<div class="q-opt-desc">' + esc(rich.description) + "</div>";
    if (rich.preview) {
      // Previews are pre-formatted mockups/code — a monospace <pre> preserves
      // their alignment faithfully where markdown reflow would mangle it.
      body += '<details class="q-prev-wrap"><summary>Preview</summary>' +
        '<pre class="q-prev">' + esc(rich.preview) + "</pre></details>";
    }
    return '<div class="q-opt-card" data-idx="' + i + '"><div class="q-opt-head">' +
      head + "</div>" + body + "</div>";
  }

  function updateQuestion(s) {
    const box = $("chatQuestion");
    if (!box) return;
    const sess2 = s && s.session;
    const q = sess2 && sess2.question;
    // Prefer the rich options ({label, description?, preview?}); fall back to the
    // legacy label strings so an older agent still renders a pick list.
    const rich = (sess2 && sess2.questionOptionsRich) || null;
    const labels = (sess2 && sess2.questionOptions) || [];
    const opts = (rich && rich.length) ? rich : labels.map((l) => ({ label: l }));
    const multi = !!(sess2 && sess2.questionMulti);
    const header = sess2 && sess2.questionHeader;
    const total = sess2 && sess2.questionTotal;
    const index = sess2 && sess2.questionIndex;
    // A stale heartbeat may still report the question we just answered; keep it
    // hidden until the agent actually clears it, then forget the suppression.
    if (q && q === answeredQuestion) { questionActive = false; box.hidden = true; box.innerHTML = ""; updateComposeAction(); return; }
    answeredQuestion = null;
    questionActive = !!q;
    // The compose button reads questionActive (a live question makes it Send, not
    // Stop), so flip it the moment the question appears or clears rather than
    // waiting for the next ~1s live frame to repaint it.
    updateComposeAction();
    if (!q) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    // Header chip + "n of N" progress, shown when a call bundles several
    // questions so the operator knows more follow this one.
    let meta = "";
    if (header || (typeof total === "number" && total > 1)) {
      meta = '<div class="q-meta">' +
        (header ? '<span class="q-chip">' + esc(header) + "</span>" : "") +
        ((typeof total === "number" && total > 1)
          ? '<span class="q-progress">' + ((typeof index === "number" ? index : 0) + 1) +
            " of " + total + "</span>" : "") + "</div>";
    }
    const submit = multi ? '<button class="q-submit">Submit selection</button>' : "";
    box.innerHTML = meta +
      '<div class="q-text">' + esc(q) + "</div>" +
      '<div class="q-opts' + (multi ? " q-opts-multi" : "") + '">' +
        opts.map((o, i) => optionCardHtml(o, i, multi)).join("") + "</div>" +
      submit +
      '<div class="q-hint">Or type a custom answer below.</div>';
    if (multi) {
      const btn = box.querySelector(".q-submit");
      if (btn) btn.addEventListener("click", () => {
        const picks = Array.from(box.querySelectorAll(".q-check"))
          .filter((c) => c.checked)
          .map((c) => parseInt(c.getAttribute("data-idx"), 10));
        if (picks.length) answerQuestion(-1, null, picks);
      });
    } else {
      box.querySelectorAll(".q-opt-pick").forEach((b) => b.addEventListener("click", () =>
        answerQuestion(parseInt(b.getAttribute("data-idx"), 10), null)));
    }
  }

  async function answerQuestion(optionIndex, custom, optionIndices) {
    if (!hostKey || !sessionId) return;
    const body = { optionIndex };
    if (Array.isArray(optionIndices) && optionIndices.length) body.optionIndices = optionIndices;
    if (custom) body.custom = custom;
    // Hide the box immediately on click — the round-trip to the hub (and the
    // agent's next heartbeat) can take a moment, and leaving it up reads as if
    // the click didn't register. `answeredQuestion` keeps a stale heartbeat
    // from bouncing it back; if the POST fails we re-surface it below.
    answeredQuestion = (sess && sess.session && sess.session.question) || null;
    questionActive = false;
    const box = $("chatQuestion"); if (box) { box.hidden = true; box.innerHTML = ""; }
    updateComposeAction(); // question gone -> the button follows the working turn again
    try {
      const r = await fetch("/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/answer", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(String(r.status));
      if (typeof fastPoll === "function") fastPoll();
    } catch {
      answeredQuestion = null; // send failed — let the pending question show again
      if (sess) updateQuestion(sess);
    }
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
    const inp = $("chatInput");
    if (!inp || !hostKey || !sessionId) return;
    const text = inp.value;
    if (!text.trim()) return;
    inp.value = ""; autoGrow(); inp.focus();
    const wasAnswer = questionActive;
    try {
      let url, body;
      if (wasAnswer) {
        url = "/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/answer";
        body = { optionIndex: -1, custom: text };
        // Optimistically dismiss the question box (see answerQuestion).
        answeredQuestion = (sess && sess.session && sess.session.question) || null;
        questionActive = false;
        const box = $("chatQuestion"); if (box) { box.hidden = true; box.innerHTML = ""; }
        updateComposeAction(); // question gone -> the button follows the working turn again
      } else {
        url = "/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/input";
        body = { text };
      }
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(String(r.status));
      if (typeof fastPoll === "function") fastPoll();
    } catch {
      if (wasAnswer) { answeredQuestion = null; if (sess) updateQuestion(sess); }
      if (!inp.value.trim()) { inp.value = text; autoGrow(); }
      actionFailed("Send failed");
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
    // Follow the reader: parked at the bottom → keep auto-scrolling (and hide the
    // jump pill); scrolled up → stop pinning and reveal it. Scroll events are
    // coalesced to the settled position, so a programmatic scroll-to-bottom in
    // repaint() just re-affirms stickBottom rather than fighting it.
    scroll.addEventListener("scroll", () => {
      stickBottom = scrolledToBottom(scroll);
      updateJump();
    });
    // `toggle` doesn't bubble, so listen in the capture phase to record each
    // card's user-chosen open/closed state (survives the next repaint).
    scroll.addEventListener("toggle", (e) => {
      const d = e.target;
      if (d && d.tagName === "DETAILS" && d.dataset && d.dataset.dkey) detailsOpen.set(d.dataset.dkey, d.open);
    }, true);
    // Flush a paint that was held back while the reader had text selected, as
    // soon as that selection collapses (a click anywhere) or moves out of the
    // transcript. selectionchange is on the document, not the scroll, because a
    // selection can be cleared from outside it.
    document.addEventListener("selectionchange", () => {
      if (repaintDeferred && !selectionInScroll()) repaint();
    });
  }

  // ---- static (archived) transcript rendering -------------------------------
  // An ended session pulled from the durable archive (GET /api/archive/<id>,
  // which now carries blocks[]) rendered through the SAME buildItems +
  // itemsToHtml pipeline as the live view — identical bubbles, tool cards,
  // thinking traces, and verbosity control — but with no WebSocket, compose box,
  // streaming turn, or /history expand. The two views are mutually exclusive
  // panes, so this reuses the module-level `verbosity`/`detailsOpen` state.
  let stScroll = null, stVerbHost = null, stTranscriptId = null, stEntries = [];

  function loadStaticVerbosity(tid) {
    // Same per-key store as the live view (keyed by transcript id), so a reader's
    // preset sticks across opens of the same ended session.
    let v = null;
    try { v = JSON.parse(localStorage.getItem("turma.chat.verbosity." + tid) || "null"); } catch {}
    if (v && v.preset && v.show && typeof v.show === "object") {
      verbosity = { preset: v.preset, show: {
        thinking: !!v.show.thinking, tools: !!v.show.tools, outputs: !!v.show.outputs } };
    } else {
      verbosity = { preset: "normal", show: { ...PRESETS.normal } };
    }
  }
  function saveStaticVerbosity() {
    try { localStorage.setItem("turma.chat.verbosity." + stTranscriptId, JSON.stringify(verbosity)); } catch {}
  }
  function renderStaticVerbosity() {
    buildVerbositySeg(stVerbHost, () => { saveStaticVerbosity(); renderStaticVerbosity(); repaintStatic(); });
  }
  function repaintStatic() {
    if (!stScroll) return;
    const html = itemsToHtml(buildItems(stEntries));
    stScroll.innerHTML = html || '<div class="tr-empty">This session\'s transcript is empty.</div>';
  }
  // Scroll the matched entry to the middle of the pane and flash it (a
  // search-result open carries the hit's uuid). Bubbles + cards carry data-uuid.
  function scrollToStaticHit(uuid) {
    if (!stScroll || !uuid || !(window.CSS && CSS.escape)) return;
    const el = stScroll.querySelector('[data-uuid="' + CSS.escape(uuid) + '"]');
    if (!el) return;
    const cRect = stScroll.getBoundingClientRect(), eRect = el.getBoundingClientRect();
    stScroll.scrollTop += (eRect.top - cRect.top) - (stScroll.clientHeight / 2 - el.offsetHeight / 2);
    el.classList.add("hit");
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  }

  // opts: { entries, scrollEl, verbHost, transcriptId, scrollUuid? }
  function openStatic(opts) {
    close();          // tear down any live view (ws/timers/reveal)
    closeStatic();    // and any prior static view's verbosity control
    opts = opts || {};
    stScroll = opts.scrollEl || null;
    stVerbHost = opts.verbHost || null;
    stTranscriptId = opts.transcriptId || null;
    stEntries = Array.isArray(opts.entries) ? opts.entries : [];
    noExpand = true;  // no /history to expand into
    detailsOpen.clear();
    loadStaticVerbosity(stTranscriptId);
    renderStaticVerbosity();
    repaintStatic();
    if (opts.scrollUuid) scrollToStaticHit(opts.scrollUuid);
    // Wire card expand/collapse persistence for the static scroll too.
    wireStaticDelegation();
  }
  function closeStatic() {
    if (stVerbHost) stVerbHost.innerHTML = "";
    stScroll = null; stVerbHost = null; stTranscriptId = null; stEntries = [];
  }
  function wireStaticDelegation() {
    if (!stScroll || stScroll.dataset.wired) return;
    stScroll.dataset.wired = "1";
    // `toggle` doesn't bubble; capture it to remember each card's open state so a
    // verbosity re-render doesn't snap the reader's opened cards shut.
    stScroll.addEventListener("toggle", (e) => {
      const d = e.target;
      if (d && d.tagName === "DETAILS" && d.dataset && d.dataset.dkey) detailsOpen.set(d.dataset.dkey, d.open);
    }, true);
  }

  // ---- public API -----------------------------------------------------------
  function open(hk, id, s, a) {
    close();
    closeStatic();
    gen++;
    const myGen = gen;
    hostKey = hk; sessionId = id; sess = s; agent = a;
    buffer = []; queuedPrompts = []; liveTurn = ""; liveStatus = null; reveal.shown = 0; revealFull = ""; backoffIdx = 0;
    stopPendingAt = 0; actionFailUntil = 0; // the compose button starts at Send
    modelSwitchPending = null; modeSwitchPending = null;
    lastHtml = null; repaintDeferred = false; // this session's paint memo starts empty
    stickBottom = true; // land at the tail on open, past the seed→history race
    noExpand = false;
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
    buffer = []; queuedPrompts = []; liveTurn = ""; liveStatus = null; questionActive = false; answeredQuestion = null;
    stopPendingAt = 0; actionFailUntil = 0; modelSwitchPending = null; modeSwitchPending = null;
    lastHtml = null; repaintDeferred = false;
    updateLiveStatus(); // hide the pinned bar when the view closes
  }

  // Called from the page's render() on each heartbeat/SSE while chat is open.
  // `a` is the session's host payload when the caller has a fresh one — it
  // carries the probed `models` block the model menu is built from, which would
  // otherwise stay frozen at whatever open() saw.
  function onPoll(s, a) {
    if (!s) return;
    sess = s;
    if (a) agent = a;
    setHeader(s, agent);
    updateQuestion(s);
    renderComposeOpts(true);
  }

  if (typeof window !== "undefined") {
    window.TurmaChat = { open, close, repaint: repaintPublic, onPoll, renderStatic: openStatic, closeStatic,
      isBusy, stop, actionFailed };
    // Global handlers referenced by the chat pane's inline HTML attributes.
    window.autoGrowChatInput = autoGrow;
    // Enter always sends, exactly like the button: a queued message is a
    // normal thing to type mid-turn.
    window.chatInputKey = function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
    window.sendChatInput = send;
    // Send always sends — mid-turn it queues (Claude Code holds the message
    // until the turn ends, and the chat shows it as a "queued" bubble). The
    // separate ◼ Stop button interrupts the turn.
    window.chatComposeAction = function () { send(); };
    window.chatComposeStop = function () { stop(); };
    window.chatJumpBottom = jumpToBottom;
  }

  // Expose the pure core (merge + item building) for Node unit tests. Harmless
  // in the browser (no `module`); the browser path uses window.TurmaChat above.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      mergeTail, weight, buildItems, itemsToHtml, esc, linkify, renderInline, renderProse, prFooterChip,
      ticketFooterChip, modelOpts, prettyModel, MODEL_OPTS,
      agentsHtml, optionCardHtml, filterModeOpts, MODE_OPTS, repaint, selectionInScroll, tick,
      isBusy, updateComposeAction, isToolBullet,
      // Drive the real `turn`-frame classifier (see applyTurn): the ws onmessage
      // hands it frame.text verbatim, so the flicker tests exercise it directly.
      __applyTurn: (t) => { applyTurn(t); },
      __setLiveStatus: (st) => { liveStatus = st; },
      __stopPending: (t) => { stopPendingAt = t; },
      modelChipLabel, modeChipValue,
      __setSess: (s) => { sess = s; },
      __setAgent: (a) => { agent = a; },
      __setModelSwitchPending: (p) => { modelSwitchPending = p; },
      __setModeSwitchPending: (p) => { modeSwitchPending = p; },
      __setQuestionActive: (v) => { questionActive = v; },
      __setVerbosity: (v) => { verbosity = v; },
      __setNoExpand: (v) => { noExpand = v; },
      __setBuffer: (b) => { buffer = b; },
      __setQueued: (q) => { queuedPrompts = q; },
      __setLiveTurn: (t) => { liveTurn = t; reveal.shown = 0; },
      // Set the live turn WITHOUT resetting the reveal — the real ws `turn`
      // frame does exactly this (liveTurn = frame.text), and testing the
      // swap-vs-continuation snap needs `shown` to carry across the change.
      __setLiveTurnRaw: (t) => { liveTurn = t; },
      __setRevealShown: (n) => { reveal.shown = n; },
      __resetPaint: () => { lastHtml = null; repaintDeferred = false; },
      __revealShown: () => reveal.shown,
      __liveTurn: () => liveTurn,
    };
  }
})();
