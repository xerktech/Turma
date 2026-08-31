"use strict";
// Native chat engine for the Sessions page. Replaces "attach to the ttyd
// terminal" as the default running-session view: it opens the hub's live
// transcript WebSocket (/live/<host>/<id>), renders the session as chat bubbles
// (user right, agent left) plus collapsible tool-action cards + thinking traces,
// and shows the in-progress turn as a trailing bubble that updates in place
// (text appears as it arrives — no typewriter, XERK-251). A three-way
// verbosity preset (Concise hides thinking + tool actions entirely; Normal adds
// tool cards with collapsed output; Verbose expands everything) picks how much
// of each turn is shown. Ported in spirit from the glasses client (glasses/src/live.ts,
// transcript.ts) into framework-free, build-free browser JS.
//
// Reads a few shared helpers from the page's inline script (same classic-script
// global scope): esc(), enc(), cache, sessTitle(), sessMeta(), fastPoll().
(function () {
  // ---- constants ------------------------------------------------------------
  const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
  const TOKEN_SKEW_MS = 30000;      // refetch a ws-token this long before expiry
  const LIVE_TURN_ID = "__live";
  const POLL_MS = 6000;             // /history fallback cadence when the WS is down
  const HISTORY_RETRY_MS = 1200;    // poll cadence while /history returns 202
  // The retry window must outlast a HEARTBEAT, not just a fetch (XERK-347). A
  // 202 means "the agent hasn't delivered it yet", and a delivery can be shed —
  // by the agent's own body ceiling, or after two failed beats — in which case
  // the NEXT beat is the earliest it can arrive, and the beat interval is 20s.
  // At 12 retries this gave up after 14.4s and the scrollback then never came:
  // the poll fallback only re-asks while the socket is DOWN, so a session with a
  // healthy live tail sat on an empty history until it was reopened.
  const HISTORY_MAX_RETRIES = 40;   // ~48s
  const STOP_SUPPRESS_MS = 4000;    // how long a clicked Stop overrides the busy read
  const ACTION_FAIL_MS = 2000;      // how long the compose button shows a failure
  // Files one message may carry (XERK-234). Mirrors the hub's
  // UPLOAD_MAX_PER_MESSAGE, which refuses past it — this only keeps the composer
  // from staging a message the hub was always going to reject.
  const MAX_ATTACHMENTS = 10;

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

  // Turn plain transcript text into HTML with clickable links and inline images.
  // A markdown image ![alt](url) becomes an <img> (XERK-221); bare http(s) URLs
  // and markdown [text](url) links (http/https only) become <a> tags that open
  // in a new tab; every other run of text is HTML-escaped exactly like esc().
  // Only http/https is ever linkified (no javascript:/data: hrefs), and both the
  // label and the href are escaped, so this is as injection-safe as esc() — a
  // bare esc() and linkify() produce identical output for link/image-free text.
  // Used for prose surfaces (message bubbles, thinking traces); tool input/output
  // <pre> blocks stay raw esc().
  // Only http(s)/mailto reaches an href; anything else becomes "#". The linkify
  // pass already restricts what it matches, but `anchor` is ALSO called directly
  // for a pr_link entry (buildItems), whose URL comes off the wire — and
  // `target="_blank"` is not a defence, it just happens to make Chrome refuse
  // the navigation. Mirrors safeUrl in index.html/sessions.html (XERK-235).
  function safeUrl(u) {
    // Tab/CR/LF are REMOVED by the URL parser before it parses, so they must be
    // removed here too or the checks below see a different string than the
    // browser will (`/<tab>/evil` parses as `//evil`).
    const s = String(u ?? "").replace(/[\t\r\n]/g, "").trim();
    if (/^(https?:|mailto:)/i.test(s)) return esc(s);
    // Root-relative is allowed — the ticket chip points at Turma's OWN board
    // (/board?ticket=…), not out to the tracker. But only when the second
    // character cannot begin an authority: a leading `//` is protocol-relative,
    // and in a special scheme the parser treats `\` exactly as `/`, so `/\evil`
    // resolves to http://evil just as `//evil` does.
    if (/^\/(?![/\\])/.test(s)) return esc(s);
    return "#";
  }
  function anchor(url, label) {
    return '<a href="' + safeUrl(url) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + "</a>";
  }
  // An inline image (a markdown ![alt](url), or a raw SVG turned into a data URI
  // by svgToImg). The src is restricted to http(s) and data:image/* at the call
  // site, so this never emits a script-bearing scheme; a data:image/svg+xml is
  // safe here because SVG loaded through <img> runs in the browser's secure
  // static mode (no scripts, no external fetches). Both attrs are esc()'d.
  function imgTag(url, alt, cls) {
    return '<img class="md-img' + (cls ? " " + cls : "") + '" src="' + esc(url) +
      '" alt="' + esc(alt || "") + '" loading="lazy">';
  }
  // Render raw SVG source as an image (XERK-221). The markup is URL-encoded into a
  // data:image/svg+xml URI and shown through <img>, NOT injected into the DOM: an
  // <img>-embedded SVG runs in secure static mode, so a <script>/onload/foreignObject
  // in agent- or tool-emitted SVG can never execute or fetch. encodeURIComponent
  // leaves the result free of <, >, ", & (all percent-encoded), so it's inert in
  // the attribute; esc() is applied for uniformity with every other src above.
  function svgToImg(svg) {
    return imgTag("data:image/svg+xml," + encodeURIComponent(String(svg).trim()), "", "md-svg");
  }
  function linkify(text) {
    const s = String(text == null ? "" : text);
    // Markdown image (http(s) or data:image/* src), a markdown link, OR a bare
    // http(s) URL — image tried first so its leading `!` isn't left as stray text.
    const re = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)\)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<]+)/g;
    let out = "", last = 0, m;
    while ((m = re.exec(s))) {
      out += esc(s.slice(last, m.index));
      if (m[2] != null) {
        out += imgTag(m[2], m[1]);            // ![alt](url)
      } else if (m[4]) {
        out += anchor(m[4], m[3]);            // [label](url)
      } else {
        // Bare URL: peel trailing sentence punctuation, markdown emphasis
        // markers (e.g. a URL wrapped in **bold**), and typographic quotes
        // (Claude often emits curly ‘’ “” around URLs) back out of the link,
        // and a trailing ')' only when it isn't part of the URL (e.g. a URL
        // wrapped in parens) — keep it for balanced ones like /wiki/Foo_(bar).
        let url = m[5], trail = "";
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

  // ---- raw (non-fenced) SVG blocks ------------------------------------------
  // Lift a standalone <svg>…</svg> block out of prose and render it as an image
  // (XERK-221), passing the surrounding text through renderTables() unchanged. A
  // block only qualifies when its <svg> opens at the START of a line — so a
  // `<svg>` mentioned inside an inline `code` span or mid-sentence stays text —
  // and it must reach a </svg>; an unterminated one (a live turn captured
  // mid-block) falls through as escaped text until its closer lands.
  // renderProse() lifts fenced code out first, so a fenced SVG is handled
  // there, never here.
  function renderSvgAndText(text) {
    const s = String(text == null ? "" : text);
    if (!/<svg[\s>]/i.test(s)) return renderTables(s); // no <svg → nothing to lift out
    const re = /(^|\n)[ \t]*(<svg[\s>][\s\S]*?<\/svg\s*>)/gi;
    let out = "", last = 0, m;
    while ((m = re.exec(s))) {
      out += renderTables(s.slice(last, m.index) + m[1]); // keep the boundary newline
      out += svgToImg(m[2]);
      last = m.index + m[0].length;
    }
    out += renderTables(s.slice(last));
    return out;
  }

  // ---- fenced code blocks ---------------------------------------------------
  // A ``` fence opens a code block that runs to the next fence of at least the
  // same length (or, unterminated, to the end of the text — which is the normal
  // case for a live turn captured mid-block, and is why an open fence renders
  // as code rather than waiting for its closer).
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
  // Copy-to-clipboard button planted in the top-right of every fenced code
  // block (XERK-183). Two inline SVGs — the check is revealed by CSS only while
  // .md-copy.copied is set (see sessions.html / vendor/chat.css). The button
  // sits OUTSIDE the <pre>, so it (like the language ::before label) never lands
  // in a copied text selection, and the click handler reads the <code> text, not
  // the <pre>. Rendered pure so the phone companion's vendored engine shows it too.
  const MD_COPY_BTN =
    '<button class="md-copy" type="button" aria-label="Copy code" title="Copy code">' +
    '<svg class="ic-copy" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="9" width="13" height="13" rx="2"/>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
    '<svg class="ic-check" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
    'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20 6L9 17l-5-5"/></svg></button>';
  function renderCode(lang, body) {
    return '<div class="md-code-wrap">' + MD_COPY_BTN +
      '<pre class="md-code"' + (lang ? ' data-lang="' + esc(lang) + '"' : "") +
      "><code>" + esc(body) + "</code></pre></div>";
  }
  // Write `text` to the system clipboard, resolving on success. Prefers the
  // async Clipboard API (available over the hub's https tunnel and in the phone
  // webview) and falls back to a hidden-textarea execCommand copy.
  function writeClipboard(text) {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (ok) resolve(); else reject(new Error("execCommand copy failed"));
      } catch (err) { reject(err); }
    });
  }
  // Delegated handler for the code-block copy button. One listener per transcript
  // container (the live scroll, the static/archive scroll, and the phone's root)
  // routes through this. Returns true when it handled a .md-copy click, so a
  // shared listener can early-out. Flashes .copied/.failed on the button; a later
  // repaint may clear the class sooner, which is harmless.
  function copyCodeClick(e) {
    const t = e && e.target;
    const btn = t && t.closest && t.closest(".md-copy");
    if (!btn) return false;
    e.preventDefault();
    const wrap = btn.closest(".md-code-wrap");
    const code = wrap && wrap.querySelector("pre.md-code code");
    const text = code ? (code.textContent || "") : "";
    const flash = function (cls) {
      btn.classList.remove("copied", "failed");
      btn.classList.add(cls);
      setTimeout(function () { try { btn.classList.remove(cls); } catch (_) {} }, 1200);
    };
    writeClipboard(text).then(function () { flash("copied"); }, function () { flash("failed"); });
    return true;
  }
  // A fenced block whose entire body is one <svg>…</svg> document renders as an
  // image, not code (XERK-221) — catches ```svg, ```xml/```html-wrapped SVG, and a
  // bare ``` fence around SVG alike, without disturbing a fence that merely
  // contains an <svg> among other content.
  const SVG_FENCE = /^\s*<svg[\s>][\s\S]*<\/svg\s*>\s*$/i;
  function renderProse(text) {
    const s = String(text == null ? "" : text);
    if (s.indexOf("```") < 0) return renderSvgAndText(s); // no fence → still scan for raw SVG
    const lines = s.split("\n");
    let out = "", i = 0, buf = [];
    const flush = () => { if (buf.length) { out += renderSvgAndText(buf.join("\n")); buf = []; } };
    while (i < lines.length) {
      const open = FENCE_OPEN.exec(lines[i]);
      if (open) {
        flush();
        i++;
        const body = [];
        while (i < lines.length && !fenceCloses(lines[i], open[1])) { body.push(lines[i]); i++; }
        i++; // consume the closer; past the end already for an unterminated block
        const bodyStr = body.join("\n");
        out += SVG_FENCE.test(bodyStr) ? svgToImg(bodyStr) : renderCode(open[2], bodyStr);
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
  // In-flight model-source switch (XERK-246); cleared once the heartbeat agrees.
  let modelSourcePending = null;
  let buffer = [];                  // merged rich entries {id, role, text, blocks}
  // Prompts typed mid-turn, still waiting in Claude Code's queue (the agent
  // folds queue-operation transcript entries — see foldQueueOp in
  // tunnel-agent.js). Rendered as pending user bubbles under the live turn;
  // replaced wholesale by each tail frame / history load, so a consumed prompt
  // drops out the moment its real user turn lands.
  let queuedPrompts = [];
  let liveTurn = "";                // in-progress assistant text (pane scrape), "" when idle
  let liveStatus = null;            // {verb,up,down,elapsed} working indicator, null when idle
  // The session's live agent list, kept SEPARATE from liveStatus because the two
  // stop being true at different moments (XERK-245): liveStatus clears the
  // instant the turn ends (it is what shows Stop), while a background agent
  // keeps running past that — the exact stretch where the operator most needs to
  // see what is still going, and where the list used to blink out.
  let liveAgents = [];
  let ws = null, backoffIdx = 0, wsRetryTimer = null;
  // The generation a startWs() is currently mid-connect for (null = none). See
  // startWs — it is keyed by generation, not a bare flag, so opening a DIFFERENT
  // session always gets its socket.
  let wsStarting = null;
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
  // The TUI's blocking dialog (permission / plan approval) is on screen, and
  // the prompt text of one just answered — same roles as the two above, for the
  // pane-scraped dialog rather than the hook-intercepted question.
  let panePromptActive = false;
  let answeredPanePrompt = null;
  // When Stop was clicked, or 0. See composeBusy().
  let stopPendingAt = 0;
  // Until when the compose button is showing a transient failure message.
  let actionFailUntil = 0;

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

  // Single-flight PER GENERATION, because connecting is ASYNC: `ws` is only
  // assigned after the ws-token round trip, so two callers landing in that
  // window for the same view (open() and the page's reconnect nudge, a retry
  // timer and a nudge) would each build a socket, and `close()` — which only
  // knows the last one assigned — could never close the other. It would sit
  // open, and the hub, still seeing a live client, would never unwatch the
  // session.
  //
  // Keyed by generation rather than a bare flag: opening a DIFFERENT session
  // must always connect, and the older connect then discards itself at its own
  // generation check below rather than being suppressed here.
  async function startWs(myGen) {
    if (wsStarting === myGen) return;
    wsStarting = myGen;
    try { await openWs(myGen); } finally { if (wsStarting === myGen) wsStarting = null; }
  }

  async function openWs(myGen) {
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
        // Prefer the frame's own list; an agent/hub predating it carries the
        // list only on `status`, where it lives just for the running turn.
        liveAgents = Array.isArray(frame.agents)
          ? frame.agents
          : (frame.status && Array.isArray(frame.status.agents) ? frame.status.agents : []);
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

  // Reconnect the live socket NOW instead of waiting out the backoff — the page
  // calls this the moment the staged session's host gets its tunnel back
  // (XERK-252), so a flap costs the operator a second rather than up to a whole
  // BACKOFF_MS step. A socket that's still open (the hub holds it across a flap
  // and re-arms the agent's watch on control reconnect) needs nothing.
  function reconnectNow() {
    if (!hostKey || !sessionId || wsStarting === gen) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
    backoffIdx = 0;
    startWs(gen);
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
  // One 202-retry chain at a time. The poll fallback ticks every POLL_MS while
  // the socket is down and each tick used to start its own chain, which the
  // longer window above turns from 12 overlapping requests into 40 (measured:
  // 156 GETs in 45s against 86). The chain that is already waiting is the one
  // that will deliver.
  let historyChain = false;
  async function loadHistory(myGen, retries) {
    retries = retries || 0;
    if (retries === 0) {
      if (historyChain) return;
      historyChain = true;
    }
    // A closed view has no URL to fetch: close() nulls hostKey/sessionId, and a
    // 202-retry timer already in flight would otherwise build (and 404 on)
    // `/api/agents/null/sessions/null/history`. The gen check downstream only
    // discards the RESULT — this is what stops the request.
    if (myGen !== gen || !hostKey || !sessionId) { historyChain = false; return; }
    let r;
    try { r = await fetch("/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/history"); }
    catch { historyChain = false; return; }
    if (myGen !== gen) { historyChain = false; return; }
    if (r.status === 202) {
      if (retries < HISTORY_MAX_RETRIES) setTimeout(() => loadHistory(myGen, retries + 1), HISTORY_RETRY_MS);
      else historyChain = false;   // gave up — the next tick may start over
      return;
    }
    historyChain = false;
    if (!r.ok) return;
    let j;
    try { j = await r.json(); } catch { return; }
    if (myGen !== gen || !j || !Array.isArray(j.entries)) return;
    // History is the authoritative chronological scrollback (bigger byte window,
    // looser per-block caps). Fold it in preserving transcript order — never
    // seed-then-append, which drops the grow-only buffer's pre-window entries
    // below history out of order on every reload (foldHistory).
    buffer = foldHistory(j.entries, buffer);
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
  // the text-only heartbeat seed (a 500-char preview) is replaced by the rich
  // live tail or /history — which read at the SAME block caps as each other
  // (XERK-347), so neither can shrink the other. Grow-only, so a truncated
  // preview never clobbers a fuller copy.
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
        (b.args || "").length + (b.summary || "").length + (b.result || "").length +
        (b.desc || "").length + (b.content || "").length + (b.plan || "").length +
        (b.url || "").length + (b.caption || "").length +
        (b.edit ? (b.edit.old || "").length + (b.edit.new || "").length : 0) +
        // Embedded SendUserFile previews (XERK-221): count them so an image-bearing
        // copy outweighs a degraded reload (file since deleted → a name-only chip).
        (Array.isArray(b.files) ? b.files.reduce((s, f) =>
          s + (f ? (f.src || "").length + (f.html || "").length + (f.name || "").length : 0), 0) : 0);
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

  // Fold a /history WINDOW into the live buffer, preserving transcript order.
  //
  // Both `history` (the /history response) and `buffer` (the grow-only live
  // buffer) are individually oldest-to-newest and share a common run of ids.
  // The old code did `mergeTail(history, buffer)` — seed order from history,
  // append every buffer id history didn't know at the END. That is wrong: the
  // live buffer accumulates from the moment the chat opened and is never
  // trimmed, so once it reaches further back than the (bounded) /history
  // window, a reload — which the poll fallback fires on every socket drop, far
  // more often on a flaky mobile link — appended all those PRE-window entries
  // BELOW history, dropping older text to the bottom out of order.
  //
  // Instead do a two-pointer merge that syncs on the shared ids and keeps each
  // side's own order: history is authoritative (looser caps) where they
  // overlap, its older head leads, and only the buffer entries strictly newer
  // than history's newest shared id — the live tail past the snapshot — trail
  // it. pickHeavier mirrors mergeTail's tie-break (the buffer/live copy wins an
  // equal-weight tie, a blocks copy beats a text-only one).
  function foldHistory(history, buffer) {
    history = history || [];
    buffer = buffer || [];
    const inHist = new Set();
    for (const h of history) if (h && h.id != null) inHist.add(h.id);
    const inBuf = new Set();
    for (const b of buffer) if (b && b.id != null) inBuf.add(b.id);
    const pickHeavier = (h, b) => {
      const bBlocks = b.blocks && b.blocks.length;
      const hBlocks = h.blocks && h.blocks.length;
      return (weight(b) >= weight(h) || (bBlocks && !hBlocks)) ? b : h;
    };
    const out = [];
    const seen = new Set();
    let i = 0, j = 0;
    const pushOnce = (e) => { if (e && e.id != null && !seen.has(e.id)) { seen.add(e.id); out.push(e); } };
    while (i < history.length && j < buffer.length) {
      const h = history[i], b = buffer[j];
      if (!h || h.id == null || seen.has(h.id)) { i++; continue; }
      if (!b || b.id == null || seen.has(b.id)) { j++; continue; }
      if (h.id === b.id) { pushOnce(pickHeavier(h, b)); i++; j++; continue; }
      // Emit whichever entry sits before the next shared anchor. A buffer-unique
      // entry (history never has it) that precedes a shared id goes now; a
      // history-unique entry likewise. When neither is shared, history — the
      // authoritative scrollback — leads.
      if (inHist.has(b.id) && !inBuf.has(h.id)) { pushOnce(h); i++; }
      else if (inBuf.has(h.id) && !inHist.has(b.id)) { pushOnce(b); j++; }
      else { pushOnce(h); i++; }
    }
    for (; i < history.length; i++) pushOnce(history[i]);
    for (; j < buffer.length; j++) pushOnce(buffer[j]);
    return out;
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
    // PR URLs already marked, so a re-stamped pr-link renders once (see below).
    const prSeen = new Set();
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
          const act = {
            kind: "action", id: b.id || null, name: b.name || "tool",
            input: b.input || "", inputTrunc: !!b.truncated, entryId: eid,
            result: res ? { text: res.text || "", isError: !!res.isError, truncated: !!res.truncated } : null,
          };
          // The reviewable payload of a known tool call (agent _tool_use_detail):
          // an Edit's actual diff, a Write's file body, an ExitPlanMode plan,
          // any tool's human description.
          if (b.desc) act.desc = b.desc;
          if (b.edit) act.edit = { old: b.edit.old || "", new: b.edit.new || "", replaceAll: !!b.edit.replaceAll };
          if (b.content) act.content = b.content;
          if (b.plan) act.plan = b.plan;
          // TodoWrite / dsh todo_write: the checklist snapshot the agent
          // attached (hub-agent _todo_items / tunnel-agent todoItems).
          if (Array.isArray(b.todos) && b.todos.length) act.todos = b.todos;
          // SendUserFile inline preview (XERK-221): rendered images/SVG/HTML the
          // session delivered, embedded on the block by the agent.
          if (Array.isArray(b.files) && b.files.length) act.files = b.files;
          if (b.caption) act.caption = b.caption;
          items.push(act);
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
          // resultId, not the card's id: the output is its OWN transcript
          // entry, so that is the entry a hit scrolls to, not the card it is
          // drawn in.
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
        } else if (b.t === "compact_boundary") {
          // The record that a compaction RAN — a centred status marker like an
          // interrupt, carrying the trigger and before/after token counts.
          flush();
          items.push({
            kind: "compact_boundary", id: eid, trigger: b.trigger || "",
            preTokens: b.preTokens, postTokens: b.postTokens,
          });
        } else if (b.t === "pr_link") {
          // Claude Code's own record of a PR this session opened — an inline
          // marker where in the conversation it landed.
          //
          // ONE marker per URL, at its FIRST occurrence. Claude Code re-stamps a
          // session's PR links in the metadata preamble at the top of every user
          // turn, so a long session logs the same PR ~6 times, spread across the
          // whole conversation (measured over the corpus: 1163 entries for 195
          // distinct PRs). Folding only CONSECUTIVE repeats left the rest to
          // render as a marker apiece. The first occurrence is the real one — it
          // lands within a few entries of the `gh pr create` that opened it.
          //
          // Deduping here rather than relying on the id-keyed tail merge is what
          // covers the archive/ended-session view, which calls buildItems on
          // stored entries with no merge step at all.
          flush();
          if (!prSeen.has(b.url)) {
            prSeen.add(b.url);
            items.push({ kind: "pr", id: eid, url: b.url || "", number: b.number, repo: b.repo || "" });
          }
        }
      }
      flush();
    }
    return items;
  }

  // ---- rendering ------------------------------------------------------------
  // A block the agent had to clip to its cap: a build log, a whole-file Read —
  // never an ordinary message, whose cap is the operator's own input ceiling
  // (agent BLOCK_CAPS). A static mark, never a control: the live tail and
  // /history read at the SAME fidelity now (XERK-347), so there is no fuller
  // copy to fetch and a "Show more…" button could only be a dead end. Don't put
  // one back — that is the ticket.
  function clipMark(truncated) {
    return truncated ? '<span class="clipped">… clipped to fit</span>' : "";
  }

  function renderMsg(it) {
    const cls = it.role === "user" ? "user" : "assistant";
    return '<div class="tr-msg ' + cls + '" data-uuid="' + esc(it.id) + '"><span class="role">' + cls + "</span>" +
      renderProse(it.text) + clipMark(it.truncated) + "</div>";
  }

  function renderThought(it) {
    if (!verbosity.show.thinking) return ""; // hidden by verbosity
    const key = "th:" + it.id;
    return '<details class="thought" data-dkey="' + esc(key) + '" data-uuid="' + esc(it.id) + '"' + openAttr(key, true) +
      "><summary>💭 Thought</summary>" +
      '<div class="thought-body">' + renderProse(it.text) + clipMark(it.truncated) + "</div></details>";
  }

  // ` open` when this card should be expanded: the user's explicit toggle wins,
  // else the verbosity-derived default.
  function openAttr(key, def) {
    return (detailsOpen.has(key) ? detailsOpen.get(key) : def) ? " open" : "";
  }
  function actionKey(a, gk, idx) { return a.id ? ("act:" + a.id) : ("act:" + gk + ":" + idx); }

  // SendUserFile inline previews (XERK-221): the image/SVG/HTML files a session
  // delivered, embedded on the block by the agent. An image renders through the
  // same <img> path as prose images (a data:image/svg+xml SVG in secure static
  // mode); an HTML page renders in a FULLY sandboxed iframe — `sandbox` with no
  // tokens forbids scripts, same-origin, forms and navigation, so an agent- or
  // tool-authored page can't run code or reach the hub, and srcdoc is esc()'d so
  // it can't break out of the attribute. A non-renderable/oversize file (kind
  // "file") shows as a name chip. The src scheme is re-checked here (defence in
  // depth) so only data:image/* and http(s) ever reach an <img>.
  function renderToolFiles(files, caption) {
    let out = '<div class="tool-files">';
    for (const f of files) {
      if (!f || typeof f !== "object") continue;
      const name = esc(f.name || "file");
      if (f.kind === "image" && typeof f.src === "string" && /^(data:image\/|https?:)/i.test(f.src)) {
        const svg = /^data:image\/svg\+xml/i.test(f.src);
        out += '<figure class="tool-file"><img class="md-img' + (svg ? " md-svg" : "") +
          '" src="' + esc(f.src) + '" alt="' + name + '" loading="lazy">' +
          '<figcaption>' + name + "</figcaption></figure>";
      } else if (f.kind === "html" && typeof f.html === "string") {
        out += '<figure class="tool-file"><iframe class="md-embed" sandbox referrerpolicy="no-referrer"' +
          ' loading="lazy" title="' + name + '" srcdoc="' + esc(f.html) + '"></iframe>' +
          '<figcaption>' + name + "</figcaption></figure>";
      } else {
        // `shed` distinguishes "dropped to fit the reply" (agent
        // _shed_row_previews / _shed_block_payloads) from a file that was never
        // renderable in the first place — without it the operator sees a bare
        // chip and no reason why their screenshot isn't there.
        out += '<div class="tool-file file"><span class="tool-file-name">📎 ' + name + "</span>" +
          (f.shed ? '<span class="clipped">… preview dropped to fit</span>' : "") + "</div>";
      }
    }
    out += "</div>";
    if (caption) out += '<div class="tool-caption">' + renderInline(caption) + "</div>";
    return out;
  }

  // A TodoWrite / dsh todo_write snapshot, rendered as a checklist rather than
  // a raw-JSON tool card — one glyph per state, and a one-line count on the
  // summary so the card reads at a glance even collapsed. Claude and dsh share
  // the {content, status, activeForm?} shape the agent attaches (see
  // hub-agent _todo_items / tunnel-agent todoItems).
  var TODO_STATUS = {
    completed:   { glyph: "✓", cls: "done" },   // ✓
    in_progress: { glyph: "◐", cls: "prog" },   // ◐
    pending:     { glyph: "○", cls: "todo" },   // ○
  };
  function todoCounts(todos) {
    var c = { in_progress: 0, pending: 0, completed: 0 };
    for (var i = 0; i < todos.length; i++) {
      var s = todos[i] && todos[i].status;
      // Only ever index one of the three literal keys — never the raw status,
      // so an Object.prototype key ("toString", "__proto__") in unsanitized
      // input can't touch an inherited property instead of coercing to pending.
      c[s === "in_progress" || s === "completed" ? s : "pending"]++;
    }
    return c;
  }
  function todoSummaryText(c) {
    var parts = [];
    if (c.in_progress) parts.push(c.in_progress + " in progress");
    if (c.pending) parts.push(c.pending + " pending");
    if (c.completed) parts.push(c.completed + " done");
    return parts.length ? parts.join(" · ") : "empty";
  }
  function renderTodoCard(it, key) {
    var todos = it.todos;
    var summary = todoSummaryText(todoCounts(todos));
    var rows = "";
    for (var i = 0; i < todos.length; i++) {
      var t = todos[i] || {};
      // Normalize to one of the three literal keys first, so TODO_STATUS is only
      // ever indexed by an own-key — an Object.prototype key ("toString") in
      // unsanitized input would otherwise resolve to an inherited value and
      // render an "undefined" glyph/class (same guard as todoCounts).
      var status = (t.status === "in_progress" || t.status === "completed") ? t.status : "pending";
      var meta = TODO_STATUS[status];
      // In progress prefers the present-tense activeForm when the agent sent it
      // (Claude does; dsh does not), else the imperative content.
      var text = (status === "in_progress" && t.activeForm) ? t.activeForm : (t.content || "");
      rows += '<li class="todo-item ' + meta.cls + '"><span class="todo-glyph">' +
        meta.glyph + '</span><span class="todo-text">' + esc(text) + "</span></li>";
    }
    var body = '<ul class="todo-list">' + rows + "</ul>";
    return '<details class="action-card todo-card" data-dkey="' + esc(key) +
      '" data-uuid="' + esc(it.entryId) + '"' + openAttr(key, verbosity.show.outputs) + ">" +
      "<summary><span class=\"tool-glyph todo-head\">☑</span>" +
      '<span class="tool-name">To-dos</span>' +
      '<span class="tool-arg">' + esc(summary) + "</span></summary>" +
      '<div class="tool-body">' + body + "</div></details>";
  }

  function renderActionCard(it, key) {
    if (Array.isArray(it.todos) && it.todos.length) return renderTodoCard(it, key);
    const statusCls = it.result ? (it.result.isError ? "err" : "ok") : "";
    // A plan card's salient line is the plan itself; a SendUserFile card's is its
    // caption or a file count — not the raw input JSON either would fall back to.
    const argSrc = it.plan || (it.files ? "" : it.input);
    let argOne = argSrc ? esc(argSrc.split("\n")[0]) : "";
    if (it.files && !argOne) {
      argOne = esc(it.caption ? it.caption.split("\n")[0]
        : it.files.length + (it.files.length === 1 ? " file" : " files"));
    }
    const descOne = it.desc ? '<span class="tool-desc">' + esc(it.desc.split("\n")[0]) + "</span>" : "";
    let body = "";
    // A SendUserFile delivery renders its files (the point of the card); its raw
    // input JSON would just be the same paths, so it's suppressed when files show.
    if (it.files) body += renderToolFiles(it.files, it.caption);
    if (it.input && !it.plan && !it.files) {
      body += '<div class="tool-block"><div class="tool-label">input</div><pre>' +
        esc(it.input) + "</pre>" + clipMark(it.inputTrunc) + "</div>";
    }
    // The reviewable payloads (agent _tool_use_detail): an Edit's actual old →
    // new change as a −/+ diff, a Write's file body, an ExitPlanMode plan as
    // rendered markdown — what the operator otherwise opens the terminal for.
    if (it.edit) {
      body += '<div class="tool-block"><div class="tool-label">edit' +
        (it.edit.replaceAll ? " (replace all)" : "") + '</div><div class="tool-diff">' +
        (it.edit.old ? '<pre class="diff-old">' + esc(it.edit.old) + "</pre>" : "") +
        (it.edit.new ? '<pre class="diff-new">' + esc(it.edit.new) + "</pre>" : "") +
        "</div></div>";
    }
    if (it.content) {
      body += '<div class="tool-block"><div class="tool-label">content</div><pre>' +
        esc(it.content) + "</pre></div>";
    }
    if (it.plan) {
      body += '<div class="tool-block"><div class="tool-label">plan</div>' +
        '<div class="tool-plan">' + renderProse(it.plan) + "</div>" +
        clipMark(it.inputTrunc) + "</div>";
    }
    if (it.result) {
      body += '<div class="tool-block"><div class="tool-label">' + (it.result.isError ? "error" : "output") +
        '</div><pre class="tool-result">' + esc(it.result.text || "(no output)") + "</pre>" +
        clipMark(it.result.truncated) + "</div>";
    }
    if (!body) body = '<div class="tool-block"><div class="tool-label">running…</div></div>';
    const taskCls = it.task ? " task" : "";
    const icon = it.task ? '<span class="tool-glyph">◆</span>' : '<span class="tool-dot"></span>';
    // A plan (approval) and a SendUserFile delivery (its files ARE the point) are
    // open by default; other tool cards follow the verbosity preset.
    return '<details class="action-card' + (statusCls ? " " + statusCls : "") + taskCls + '" data-dkey="' + esc(key) +
      '" data-uuid="' + esc(it.entryId) + '"' +
      openAttr(key, (it.plan || it.files) ? true : verbosity.show.outputs) + ">" +
      "<summary>" + icon + '<span class="tool-name">' + esc(it.name) + "</span>" +
      '<span class="tool-arg">' + argOne + "</span>" + descOne + "</summary>" +
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
        clipMark(it.argsTrunc) + "</div>";
    }
    return '<details class="cmd-card' + (it.result.isError ? " err" : "") + '" data-dkey="' + esc(key) +
      '" data-uuid="' + esc(it.id) + '"' + openAttr(key, false) + "><summary>" + head + "</summary>" +
      '<div class="cmd-body"><pre>' + esc(it.result.text || "(no output)") + "</pre>" +
      clipMark(it.result.truncated) + "</div></details>";
  }

  // The summary Claude writes when the context is compacted. The transcript
  // stores it as a user turn, but the model wrote it — so it renders on the
  // assistant's side, collapsed, rather than as a wall of text the operator
  // appears to have typed.
  function renderCompactCard(it) {
    const key = "cmp:" + it.id;
    return '<details class="compact-card" data-dkey="' + esc(key) + '" data-uuid="' + esc(it.id) + '"' +
      openAttr(key, false) + "><summary>↺ Context compacted — summary of the conversation so far</summary>" +
      '<div class="compact-body">' + renderProse(it.text) + clipMark(it.truncated) + "</div></details>";
  }

  // "[Request interrupted by user…]" as a centred, muted status marker — the
  // one thing the TUI's red ⎿ marker says that matters here is THAT the turn
  // was cut, so the label is the marker text without its brackets.
  function renderInterrupt(it) {
    const label = String(it.text || "Request interrupted by user").replace(/^\[|\]$/g, "");
    return '<div class="chat-interrupt" data-uuid="' + esc(it.id) + '">◼ ' + esc(label) + "</div>";
  }

  // A compaction that ran — a centred status marker like the interrupt one,
  // saying WHY the context just reset and what it cost (pre → post tokens).
  function fmtTokens(n) {
    if (typeof n !== "number" || !isFinite(n)) return "";
    return n >= 1000 ? (Math.round(n / 100) / 10) + "k" : String(n);
  }
  function renderCompactBoundary(it) {
    let label = "Context compacted" + (it.trigger ? " (" + it.trigger + ")" : "");
    const pre = fmtTokens(it.preTokens), post = fmtTokens(it.postTokens);
    if (pre && post) label += " — " + pre + " → " + post + " tokens";
    return '<div class="chat-interrupt chat-compact-mark" data-uuid="' + esc(it.id) + '">↺ ' + esc(label) + "</div>";
  }

  // Claude Code's own record of a PR this session opened — an inline linked
  // marker at the point in the conversation where it landed.
  function renderPrMarker(it) {
    const label = "Opened PR" + (it.number ? " #" + it.number : "") + (it.repo ? " — " + it.repo : "");
    return '<div class="chat-pr-mark" data-uuid="' + esc(it.id) + '">↗ ' + anchor(it.url, label) + "</div>";
  }

  // The "while you were away" recap, collapsed like the compact-summary card.
  // Never hidden by verbosity: it exists precisely for the operator who was
  // not watching, and it's one line while closed.
  function renderAwayCard(it) {
    const key = "away:" + it.id;
    return '<details class="away-card" data-dkey="' + esc(key) + '" data-uuid="' + esc(it.id) + '"' +
      openAttr(key, false) + "><summary>☾ While you were away — recap</summary>" +
      '<div class="away-body">' + renderProse(it.text) + clipMark(it.truncated) + "</div></details>";
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
      if (it.kind === "compact_boundary") { out.push(renderCompactBoundary(it)); i++; continue; }
      if (it.kind === "pr") { out.push(renderPrMarker(it)); i++; continue; }
      if (it.kind === "away") { out.push(renderAwayCard(it)); i++; continue; }
      // action run
      let j = i;
      while (j < items.length && items[j].kind === "action") j++;
      const run = items.slice(i, j);
      const gk = "grp:" + (run[0].id || g++);
      // Concise mode (tools hidden) omits tool mechanics — but a SendUserFile
      // DELIVERY (a card carrying rendered files) is user-facing content, not a
      // tool detail, so it renders in every verbosity (XERK-221). Otherwise show
      // each action as its own card.
      out.push(run.map((a, idx) =>
        (verbosity.show.tools || (a.files && a.files.length))
          ? renderActionCard(a, actionKey(a, gk, idx)) : "").join(""));
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
    // The in-progress assistant turn (text-only) as the trailing bubble, shown
    // in full the moment it arrives (XERK-251 — it used to type in). liveTurn is
    // already classified by applyTurn (block swaps / tool bullets / shorter
    // re-captures handled there, see XERK-19), so what lands here is the block
    // the pane is actually generating.
    if (liveTurn) {
      html += '<div class="tr-msg assistant streaming" id="chatLiveBubble"><span class="role">assistant</span>' +
        esc(liveTurn) + "</div>";
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
    // The bar survives the end of the turn when background agents are still
    // running (XERK-245) — it then carries just the agent list under a spinner
    // saying so, rather than vanishing and leaving the page looking idle while
    // work continues. `st` stays the turn's own indicator, so Stop is unaffected.
    const agents = agentsHtml(liveAgents);
    if (!st) {
      // Only BACKGROUND agents keep the bar up. `main` is the conversation
      // already on screen, so a list carrying only it means nothing is
      // delegated — raising a "Background agents…" bar for it would claim work
      // that isn't running. Same carve-out the heartbeat makes (live_subagents).
      if (!agents || !hasBackgroundAgents(liveAgents)) {
        bar.hidden = true; bar.innerHTML = ""; return;
      }
      bar.hidden = false;
      bar.innerHTML =
        '<div class="cc-row"><span class="cc-spin"></span>' +
        '<span class="verb">Background agents…</span></div>' + agents;
      wireAgentDelegation(bar);
      return;
    }
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
      agents;
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
    // Same for the TUI's own blocking dialog: it is answered with its buttons,
    // and a Stop there would cancel the decision rather than a running turn.
    if (panePromptActive) { stopPendingAt = 0; return false; }
    if (!liveStatus) { stopPendingAt = 0; return false; }
    // A dsh session's working status carries `noStop` — its turn has no
    // pane-Escape interrupt (kill would end the whole session), so Stop stays
    // hidden even though the bar shows the "Deep diving…" verb. See
    // tunnel-agent dshStatus / .claude/rules/turma-sessions.md.
    if (liveStatus.noStop) { stopPendingAt = 0; return false; }
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
      if (!r.ok) { await hubRefused("Stop", r); throw new Error(String(r.status)); }
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
  // Is anything actually delegated? `main` is the session's own conversation,
  // so it never counts. Rows arrive from a pane scrape via the hub, so a
  // non-object element is possible on a buggy agent and must not throw here.
  function hasBackgroundAgents(agents) {
    return Array.isArray(agents)
      && agents.some((a) => a && typeof a === "object" && a.type && a.type !== "main");
  }

  function agentsHtml(agents) {
    if (!Array.isArray(agents)) return "";
    agents = agents.filter((a) => a && typeof a === "object" && a.type);
    if (!agents.length) return "";
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

  // Fold a pane-scrape `turn` frame into the live bubble. The pane's
  // "last ● bullet" is NOT a growing stream: within one generating turn it
  // SWAPS between blocks — assistant prose, then a tool-use bullet (Bash(…),
  // Read(…)), then the next prose. Feeding every swap straight to the bubble is
  // what makes "the final line delete and re-appear over and over" (XERK-19):
  // the tool bullet swaps in (the line deletes) and prose swaps back (it
  // reappears). So classify the frame instead of trusting it verbatim:
  //  - empty, or a tool-use bullet -> the in-progress block is over (or is a
  //    tool that renders as a committed card, not raw text here). Clear the
  //    bubble; the committed transcript owns what just finished.
  //  - the SAME prose block, grown or re-captured shorter -> keep the LONGER
  //    text and never shrink. A shorter partial re-capture of the same block is
  //    the TUI redrawing mid-frame, and letting it through shrinks the bubble
  //    only to re-grow it a frame later — the char-level flicker.
  //  - a genuinely different prose block -> replace the bubble's text with it.
  function applyTurn(text) {
    const t = typeof text === "string" ? text : "";
    if (!t || isToolBullet(t)) { liveTurn = ""; return; }
    if (t.startsWith(liveTurn) || liveTurn.startsWith(t)) {
      // Same block: grow to the longer capture, ignore a shorter re-capture.
      if (t.length >= liveTurn.length) liveTurn = t;
      return;
    }
    liveTurn = t;
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
    const m = url.match(/\/pull\/(\d+)|\/-\/merge_requests\/(\d+)|\/pullrequest\/(\d+)/i);
    // GitLab and Azure DevOps number their requests !n, not #n (in ADO #n is a
    // WORK ITEM) — the sigil follows the URL's platform, mirroring _pr_ref.
    const sigil = m && !m[1] ? "!" : "#";
    const num = pr.number ? sigil + pr.number : (m ? sigil + (m[1] || m[2] || m[3]) : "PR");
    const state = String(pr.state || "").toUpperCase();
    const cls = { OPEN: "pr-open", DRAFT: "pr-draft", MERGED: "pr-merged", CLOSED: "pr-closed" }[state] || "";
    const label = state ? state[0] + state.slice(1).toLowerCase() : "";
    const ready = prReady(pr);
    const mark = ready === "ready" ? "✓" : ready === "blocked" ? "✗" : ready === "pending" ? "●" : "";
    const chk = mark ? ' <span class="pr-ready ' + ready + '" title="' + esc(prReadyTitle(pr)) + '">' + mark + "</span>" : "";
    return '<a class="pr-badge ' + cls + '" href="' + safeUrl(url) +
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
      '<a class="jira-chip" href="' + safeUrl(href) + '"' +
      ' title="' + esc(tip || t.key) + '">' + esc(t.key) + "</a></span>";
  }
  // fromPoll: a background heartbeat repaint — don't yank an open menu shut.
  function renderComposeOpts(fromPoll) {
    const host = $("chatComposeOpts");
    if (!host) return;
    if (fromPoll && host.querySelector(".cc-menu.open")) return;
    const dsh = isDshSession();
    const qwen = isQwenSession();
    const mode = modeChipValue(), model = currentModelValue();
    const modeOpts = availableModeOpts();
    const mOpts = availableModelOpts();
    const mTitle = "Model for this session — switched live, session-only" +
      (sess && sess.pendingModel ? " (switching after the current turn)"
        : sess && sess.modelActual ? " (now: " + sess.modelActual + ")" : "");
    // The permission-mode chip is Claude-only: a dsh session manages its own
    // approvals (ask/never + sandbox), not Claude's modes (XERK-504).
    const modeChip = dsh ? "" :
      '<span class="cc-opt cc-mode">' +
        '<button class="cc-btn" id="ccModeBtn" title="Agent (permission) mode — switched live, best-effort">' +
        '🛡 <span class="cc-val">' + esc(optLabel(MODE_OPTS, mode)) + '</span><span class="cc-caret">▾</span></button>' +
        '<span class="cc-menu" id="ccModeMenu"><span class="cc-hint">Agent mode</span>' +
        menuHtml(modeOpts, mode, "data-mode") + "</span></span>";
    // The runtime chip: a read-only "⚙ dsh" for a dsh session, else the Claude
    // subscription/local switch (shown when the host offers a local endpoint).
    const runtimeChip = dsh ? dshRuntimeChipHtml()
      : qwen ? qwenRuntimeChipHtml()
      : (localModelOffered()
          ? '<span class="cc-opt cc-source' + (currentModelSource() === "local" ? " cc-source-local" : "") + '">' +
            '<button class="cc-btn" id="ccSourceBtn" title="' +
            esc("Which runtime this session runs on. Switching keeps the conversation" +
                (localModelInfo().model ? " — self-hosted: " + localModelInfo().model : "")) + '">' +
            (currentModelSource() === "local" ? "🏠" : "☁") +
            ' <span class="cc-val">' + esc(modelSourceLabel()) + '</span><span class="cc-caret">▾</span></button>' +
            '<span class="cc-menu" id="ccSourceMenu"><span class="cc-hint">Runtime</span>' +
            menuHtml(modelSourceOpts(), currentModelSource(), "data-source") + "</span></span>"
          : "");
    // The model chip: the discovered dsh list for a dsh session, a fixed
    // label for a qwen session (no discovered list, host-configured model),
    // the discovered local list for a local session, else the Claude alias picker.
    const modelChip = dsh ? dshModelChipHtml()
      : qwen ? qwenModelChipHtml()
      : (currentModelSource() === "local"
          ? localModelChipHtml()
          : '<span class="cc-opt cc-model">' +
            '<button class="cc-btn" id="ccModelBtn" title="' + esc(mTitle) + '">' +
            '<span class="cc-val">' + esc(modelChipLabel()) + '</span><span class="cc-caret">▾</span> 🧠</button>' +
            '<span class="cc-menu" id="ccModelMenu"><span class="cc-hint">Model</span>' +
            menuHtml(mOpts, model, "data-model") + "</span></span>");
    host.innerHTML = modeChip +
      '<span class="cc-right">' + contextMeterChip() + ticketFooterChip(sess) + prFooterChip(sess) +
        runtimeChip + modelChip + "</span>";
    wireComposeMenu("ccModeBtn", "ccModeMenu", "data-mode", setSessionMode);
    wireComposeMenu("ccModelBtn", "ccModelMenu", "data-model", setSessionModel);
    wireComposeMenu("ccSourceBtn", "ccSourceMenu", "data-source", setSessionModelSource);
    wireComposeMenu("ccLocalModelBtn", "ccLocalModelMenu", "data-lmodel",
      (v) => setSessionLocalModel(v));
    wireComposeMenu("ccDshModelBtn", "ccDshModelMenu", "data-dmodel",
      (v) => setSessionDshModel(v));
    wireLocalContext();
  }
  // ---- context-fullness meter (XERK-489 Phase 4) ----------------------------
  // How full the model's context window is right now, warning before the ~95%
  // auto-compaction. EXACT for a local session (its selected model's window); a
  // subscription session's window is derived from the model it runs (agent-side)
  // and marked "~" — the transcript can't tell a family's 1M variant from its
  // 200k one. Both figures come off the heartbeat (agent transcript-sum), never a
  // pane statusLine — that text needs a statusLine Turma refuses to wire because
  // it breaks busy detection (XERK-130). Returns "" until a turn is measured.
  function contextMeterChip() {
    if (!sess) return "";
    const num = sess.lastTurnContextTokens, den = sess.contextWindowTokens;
    if (!(typeof num === "number" && num > 0 && typeof den === "number" && den > 0)) return "";
    const pct = Math.min(100, Math.round((num / den) * 100));
    const cls = pct >= 95 ? " ctx-danger" : pct >= 85 ? " ctx-warn" : "";
    const approx = currentModelSource() !== "local";
    const title = "Context " + fmtCtx(num) + " / " + fmtCtx(den) +
      (approx ? " (subscription — window from model)" : " (exact)") +
      " — the session auto-compacts near 95%";
    return '<span class="cc-opt cc-ctx-meter' + cls + '" title="' + esc(title) + '">' +
      '<span class="cc-ctx-track"><span class="cc-ctx-fill" style="width:' + pct + '%"></span></span>' +
      '<span class="cc-ctx-cap">' + pct + "%" + (approx ? " ~" : "") + "</span></span>";
  }

  // ---- local-model failover (XERK-246) --------------------------------------
  // Running out of Claude usage stops every session on a host at once. A session
  // can be moved onto that host's self-hosted model and carry on in the SAME
  // conversation. The control follows the HOST's reported capability, exactly
  // like the 📎 follows uploadMaxBytes: an agent that reports no `localModel`
  // cannot do it, so offering the switch would queue a command it silently drops.
  function localModelInfo(a) { return (a || agent || {}).localModel || {}; }
  function localModelOffered() {
    // Also shown when the session is ALREADY local, so a session whose host
    // later lost its configuration still has a visible way back.
    return Boolean(localModelInfo().available) || currentModelSource() === "local";
  }
  function currentModelSource() {
    // A memo belongs to the session it was made on. Honouring another session's
    // memo paints a subscription session as local (the exact confusion the mark
    // exists to prevent) and swallows its own switch click via the
    // `value === currentModelSource()` early-return in setSessionModelSource.
    // A memo must prove WHICH session it belongs to. Tolerating a session-less
    // one re-opens the leak this guard exists to close (and let a regression
    // that stopped recording the id ship green).
    const mine = modelSourcePending && modelSourcePending.sessionId === sessionId;
    if (mine && Date.now() - modelSourcePending.at < 60000) return modelSourcePending.value;
    return (sess && sess.modelSource) || "subscription";
  }
  // The runtime selector for a Claude session: the mounted subscription vs the
  // host's OWN endpoint — the same two "Claude Code" / "Claude Code Local"
  // runtimes the spawn composer offers (XERK-504), so the footer reads like the
  // initial selector. It does NOT name the model — the adjacent model dropdown
  // does, and the raw discovered id (e.g. "bedrock/us.anthropic.claude-opus-4-5-…")
  // is noise here. (A dsh session is a different runtime that cannot be switched
  // to a Claude one live — its conversation is a dsh event log, not Claude JSONL
  // — so it shows a read-only runtime chip instead; see dshRuntimeChipHtml.)
  function modelSourceLabel() {
    return currentModelSource() === "local" ? "Claude Code Local" : "Claude Code";
  }
  function modelSourceOpts() {
    return [
      { value: "subscription", label: "Claude Code" },
      { value: "local", label: "Claude Code Local" },
    ];
  }
  async function setSessionModelSource(value) {
    if (!hostKey || !sessionId || !sess || value === currentModelSource()) return;
    // Memo-only, like the mode switch: the relaunch takes a moment and the
    // heartbeat is the thing that confirms it actually happened.
    modelSourcePending = { value, at: Date.now(), sessionId };
    renderComposeOpts();
    try {
      const r = await fetch("/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/model-source", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelSource: value }) });
      // A refusal (a host with no local model, an agent too old) must take the
      // memo back with it: left up, the chip shows the model the session is NOT
      // running on until the memo ages out (XERK-264).
      if (!r.ok) { await hubRefused("Model switch", r); modelSourcePending = null; renderComposeOpts(); return; }
      if (typeof fastPoll === "function") fastPoll();
    } catch { modelSourcePending = null; renderComposeOpts(); }
  }

  // ---- endpoint model dropdown + context override (XERK-489) ---------------
  // A local session is no longer pinned to one model: it picks from the ids the
  // endpoint SERVES (localModel.models), switched live like the subscription
  // model. Selecting one applies that model's served context window; an advanced
  // field can only SHRINK it (an overstated CLAUDE_CODE_MAX_CONTEXT_TOKENS makes
  // claude compact too late and the tail truncate).
  const MAX_LOCAL_MODEL_CONTEXT = 2000000;   // mirrors the agent's cap
  function localModels() {
    const l = localModelInfo();
    return Array.isArray(l.models) ? l.models : [];
  }
  function fmtCtx(n) {
    if (!(typeof n === "number" && n > 0)) return "";
    return n >= 1000 ? Math.round(n / 1000) + "k" : String(n);
  }
  // A just-picked local-model switch, held across the relaunch like the source
  // memo — cleared once the heartbeat's localModelName agrees or it times out.
  let localModelPending = null; // {value, at, sessionId}
  const LOCAL_MODEL_SETTLE_MS = 60000;
  function localModelMemoActive() {
    return localModelPending && localModelPending.sessionId === sessionId &&
      Date.now() - localModelPending.at < LOCAL_MODEL_SETTLE_MS;
  }
  function currentLocalModel() {
    if (localModelMemoActive()) return localModelPending.value;
    const l = localModelInfo();
    return (sess && sess.localModelName) || l.defaultModel || l.model || "";
  }
  // The endpoint's served window for a model id, or null when it reports none
  // (a bare OpenAI-compatible endpoint — the override field is then free-form).
  function servedContextFor(id) {
    const m = localModels().find((x) => x && x.id === id);
    return m && typeof m.contextTokens === "number" ? m.contextTokens : null;
  }
  function currentLocalContext() {
    const stored = sess && sess.localModelContext;
    if (typeof stored === "number" && stored > 0) return stored;
    return servedContextFor(currentLocalModel());
  }
  function localModelOpts() {
    return localModels().map((m) => {
      const k = fmtCtx(m && m.contextTokens);
      return { value: m.id, label: (m && m.id) + (k ? " · " + k : "") };
    });
  }
  // The whole local-model chip: a dropdown of the discovered models (each
  // "id · 128k") plus an advanced context override. Degrades to a fixed label
  // when the host reports local but no discovered list (an older agent, or the
  // discovery worker's first pass not yet landed).
  function localModelChipHtml() {
    const models = localModels();
    const cur = currentLocalModel();
    if (!models.length) {
      return '<span class="cc-opt cc-model cc-model-fixed">' +
        '<span class="cc-btn" title="' +
        esc("This host's self-hosted model. Its list has not been discovered yet.") + '">' +
        '<span class="cc-val">' + esc(cur || "local model") + "</span> 🧠</span></span>";
    }
    const ctx = currentLocalContext();
    const served = servedContextFor(cur);
    const kLabel = fmtCtx(ctx);
    const val = esc(cur || "local model") +
      (kLabel ? ' <span class="cc-ctx">· ' + esc(kLabel) + "</span>" : "") +
      (localModelMemoActive() ? "…" : "");
    const cap = served || MAX_LOCAL_MODEL_CONTEXT;
    const ctxRow =
      '<div class="cc-ctx-adv"><label for="ccLocalCtx">Context ' +
      (served ? "(max " + esc(fmtCtx(served)) + ")" : "(tokens)") + "</label>" +
      '<span class="cc-ctx-in"><input type="number" id="ccLocalCtx" min="1" max="' + cap +
      '" step="1024" value="' + (typeof ctx === "number" && ctx > 0 ? ctx : "") + '">' +
      '<button id="ccLocalCtxApply" class="cc-apply">Apply</button></span></div>';
    return '<span class="cc-opt cc-model cc-model-local">' +
      '<button class="cc-btn" id="ccLocalModelBtn" title="' +
      esc("Self-hosted model for this session — switched live, session-only. " +
          "Selecting a model applies its context window; Advanced can shrink it.") + '">' +
      '<span class="cc-val">' + val + '</span><span class="cc-caret">▾</span> 🧠</button>' +
      '<span class="cc-menu" id="ccLocalModelMenu"><span class="cc-hint">Self-hosted model</span>' +
      menuHtml(localModelOpts(), cur, "data-lmodel") +
      '<span class="cc-sep"></span>' + ctxRow + "</span></span>";
  }
  // The context input lives INSIDE the menu popover, so its own clicks/keys must
  // not bubble to the document listener that closes every menu.
  function wireLocalContext() {
    const input = $("ccLocalCtx"), apply = $("ccLocalCtxApply");
    if (!input || !apply) return;
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); apply.click(); }
    });
    apply.addEventListener("click", (e) => {
      e.stopPropagation();
      const v = parseInt(input.value, 10);
      closeComposeMenus();
      if (v > 0) setSessionLocalModel(currentLocalModel(), v);
    });
  }
  async function setSessionLocalModel(value, context) {
    if (!hostKey || !sessionId || !sess) return;
    const sameModel = value === currentLocalModel();
    const sameCtx = context == null || context === currentLocalContext();
    if (sameModel && sameCtx) return;         // re-picking the showing value
    localModelPending = { value, at: Date.now(), sessionId };
    renderComposeOpts();
    const body = { model: value };
    if (typeof context === "number" && context > 0) body.context = context;
    try {
      const r = await fetch("/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/model", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      // A refusal (an unserved model, an agent too old) takes the memo back —
      // left up, the chip names a model the session is NOT running (XERK-264).
      if (!r.ok) { await hubRefused("Model switch", r); localModelPending = null; renderComposeOpts(); return; }
      if (typeof fastPoll === "function") fastPoll();
    } catch { localModelPending = null; renderComposeOpts(); }
  }

  // ---- dsh runtime footer (XERK-504) ----------------------------------------
  // A dsh session runs a DIFFERENT runtime (the DeepSeek Harness), not the
  // Claude subscription/local split — so its footer shows a read-only "⚙ dsh"
  // runtime chip (a dsh conversation cannot be moved to a Claude runtime live)
  // and a live dropdown of the host's DISCOVERED dsh models, mirroring the local
  // one minus the context override (dsh has no per-session window override). The
  // mode chip is hidden for dsh — dsh manages approvals itself (ask/never +
  // sandbox), not Claude's permission modes.
  function isDshSession() { return Boolean(sess && sess.agentType === "dsh"); }
  function isQwenSession() { return Boolean(sess && sess.agentType === "qwen"); }
  function dshInfo(a) { return (a || agent || {}).dsh || {}; }
  function dshModels() {
    const d = dshInfo();
    return Array.isArray(d.models) ? d.models : [];
  }
  let dshModelPending = null; // {value, at, sessionId}
  function dshModelMemoActive() {
    return dshModelPending && dshModelPending.sessionId === sessionId &&
      Date.now() - dshModelPending.at < LOCAL_MODEL_SETTLE_MS;
  }
  function currentDshModel() {
    if (dshModelMemoActive()) return dshModelPending.value;
    const d = dshInfo();
    return (sess && sess.model) || d.defaultModel || "";
  }
  function dshModelOpts() {
    return dshModels().map((m) => {
      const k = fmtCtx(m && m.contextTokens);
      return { value: m.id, label: (m && m.id) + (k ? " · " + k : "") };
    });
  }
  // A read-only runtime marker matching the session card's "⚙ dsh" badge — it is
  // NOT a picker: a running dsh session cannot switch to a Claude runtime live
  // (the conversation formats differ), so offering the change would only queue a
  // command the host refuses.
  function dshRuntimeChipHtml() {
    return '<span class="cc-opt cc-source cc-source-local">' +
      '<span class="cc-btn" title="' +
      esc("Runs on the dsh (DeepSeek Harness) runtime, not Claude Code") + '">' +
      '⚙ <span class="cc-val">dsh</span></span></span>';
  }
  // Read-only runtime marker for a qwen session: a running Qwen Code session
  // cannot switch to a Claude runtime live (the conversation formats differ),
  // so it is shown as a fixed chip, not a picker.
  function qwenRuntimeChipHtml() {
    return '<span class="cc-opt cc-source cc-source-local">' +
      '<span class="cc-btn" title="' +
      esc("Runs on the Qwen Code runtime, not Claude Code") + '">' +
      '⚙ <span class="cc-val">Qwen Code</span></span></span>';
  }
  // The qwen model chip: a fixed, read-only label. The qwen heartbeat reports
  // only {available} — no discovered model list (model plumbing is a later
  // child, XERK-504) — so there is nothing to offer in a dropdown; the session
  // runs on the host's configured qwen model. Show the actual model (the same
  // value the Claude picker's label already reads off sess.modelActual) as a
  // fixed chip, mirroring the dsh/local "no discovered list" fallback. This is
  // what stops the qwen session's model chip from offering Claude's aliases.
  function qwenModelChipHtml() {
    return '<span class="cc-opt cc-model cc-model-fixed">' +
      '<span class="cc-btn" title="' +
      esc("The Qwen Code model this session runs on. It is set by the host and cannot be switched live.") + '">' +
      '<span class="cc-val">' + esc(modelChipLabel() || "qwen model") + "</span> 🧠</span></span>";
  }
  function dshModelChipHtml() {
    const models = dshModels();
    const cur = currentDshModel();
    if (!models.length) {
      return '<span class="cc-opt cc-model cc-model-fixed">' +
        '<span class="cc-btn" title="' +
        esc("This host's dsh model. Its list has not been discovered yet.") + '">' +
        '<span class="cc-val">' + esc(cur || "dsh model") + "</span> 🧠</span></span>";
    }
    const k = fmtCtx((models.find((m) => m && m.id === cur) || {}).contextTokens);
    const val = esc(cur || "dsh model") +
      (k ? ' <span class="cc-ctx">· ' + esc(k) + "</span>" : "") +
      (dshModelMemoActive() ? "…" : "");
    return '<span class="cc-opt cc-model cc-model-local">' +
      '<button class="cc-btn" id="ccDshModelBtn" title="' +
      esc("dsh model for this session — switched live; the session resumes its " +
          "conversation on the new model.") + '">' +
      '<span class="cc-val">' + val + '</span><span class="cc-caret">▾</span> 🧠</button>' +
      '<span class="cc-menu" id="ccDshModelMenu"><span class="cc-hint">dsh model</span>' +
      menuHtml(dshModelOpts(), cur, "data-dmodel") + "</span></span>";
  }
  async function setSessionDshModel(value) {
    if (!hostKey || !sessionId || !sess || value === currentDshModel()) return;
    dshModelPending = { value, at: Date.now(), sessionId };
    renderComposeOpts();
    try {
      const r = await fetch("/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/model", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: value }) });
      if (!r.ok) { await hubRefused("Model switch", r); dshModelPending = null; renderComposeOpts(); return; }
      if (typeof fastPoll === "function") fastPoll();
    } catch { dshModelPending = null; renderComposeOpts(); }
  }

  async function setSessionModel(value) {
    if (!hostKey || !sessionId || !sess || value === currentModelValue()) return;
    // The subscription-model picker path only; a LOCAL session uses the endpoint
    // dropdown above (setSessionLocalModel), which posts an endpoint model id.
    if (currentModelSource() === "local") return;
    const prevModel = sess.model;
    modelSwitchPending = { value, prevActual: sess.modelActual || null, at: Date.now() };
    sess.model = value === "default" ? null : value; // optimistic; heartbeat confirms
    renderComposeOpts();
    // A refused switch (an invalid model, a session since gone) takes BOTH the
    // memo and that optimistic write back — the chip would otherwise name a
    // model the session never moved to (XERK-264).
    const undo = () => {
      modelSwitchPending = null;
      sess.model = prevModel;
      renderComposeOpts();
    };
    try {
      const r = await fetch("/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/model", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: value }) });
      if (!r.ok) { await hubRefused("Model switch", r); undo(); return; }
      if (typeof fastPoll === "function") fastPoll();
    } catch { undo(); }
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
      const r = await fetch("/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/mode", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permissionMode: value }) });
      // Same as the model chip: a refused mode must not keep painting itself.
      if (!r.ok) { await hubRefused("Mode switch", r); modeSwitchPending = null; renderComposeOpts(); return; }
      if (typeof fastPoll === "function") fastPoll();
    } catch { modeSwitchPending = null; renderComposeOpts(); }
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

  // The blocking choice dialog the session's TUI is showing — a tool-permission
  // request or a plan approval (agent parse_pane_prompt). It never reaches the
  // transcript, and it suppresses the pane's busy hint, so before this the
  // session read IDLE while it sat waiting on a human and the only way to
  // answer was the raw terminal. Rendered in the same box as a pending
  // AskUserQuestion: a session is never blocked on both (one blocks in the
  // ask.py hook, the other in the TUI), and one "waiting on you" surface is
  // what the operator wants.
  function panePromptHtml(p) {
    const opts = (p.options || []).map((o) =>
      '<div class="q-opt-card"><div class="q-opt-head">' +
      '<span class="q-opt-label">' + esc(o.label || "") + "</span>" +
      '<button class="q-opt-pick' + (o.selected ? " sel" : "") +
      '" data-num="' + esc(o.number) + '">' + esc(o.number) + ". Choose</button>" +
      "</div></div>").join("");
    return '<div class="q-meta"><span class="q-chip">waiting</span></div>' +
      '<div class="q-text">' + esc(p.prompt || "") + "</div>" +
      (p.detail ? '<pre class="q-prev q-pane-detail">' + esc(p.detail) + "</pre>" : "") +
      '<div class="q-opts">' + opts + "</div>";
  }

  function updateQuestion(s) {
    const box = $("chatQuestion");
    if (!box) return;
    const sess2 = s && s.session;
    const q = sess2 && sess2.question;
    // No AskUserQuestion pending: a TUI dialog may still be blocking the turn.
    if (!q) {
      const p = sess2 && sess2.panePrompt;
      const valid = p && p.prompt && p.options && p.options.length;
      panePromptActive = !!valid && p.prompt !== answeredPanePrompt;
      if (!panePromptActive) { answeredPanePrompt = null; }
      updateComposeAction();
      if (panePromptActive) {
        questionActive = false;
        box.hidden = false;
        box.innerHTML = panePromptHtml(p);
        box.querySelectorAll(".q-opt-pick").forEach((b) => b.addEventListener("click", () =>
          answerPanePrompt(parseInt(b.getAttribute("data-num"), 10), p.prompt)));
        return;
      }
    } else {
      panePromptActive = false;
    }
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

  // Answer the TUI's blocking dialog by its option number — the agent re-reads
  // the pane and drops the answer if the dialog has moved on (see
  // answer_pane_prompt), so a click made against a stale beat can't type a
  // stray digit into a live composer.
  async function answerPanePrompt(optionNumber, prompt) {
    if (!hostKey || !sessionId || !Number.isInteger(optionNumber)) return;
    // Hide on click like the question box: the agent's next beat is a moment
    // away, and leaving the dialog up reads as if the click didn't register.
    answeredPanePrompt = prompt || null;
    panePromptActive = false;
    const box = $("chatQuestion"); if (box) { box.hidden = true; box.innerHTML = ""; }
    updateComposeAction();
    try {
      const r = await fetch("/api/agents/" + enc(hostKey) + "/sessions/" + enc(sessionId) + "/pane-prompt", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ optionNumber }),
      });
      if (!r.ok) { await hubRefused("Answer", r); throw new Error(String(r.status)); }
    } catch {
      answeredPanePrompt = null;   // let the next beat re-surface it
      actionFailed("Couldn't answer");
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
      if (!r.ok) { await hubRefused("Answer", r); throw new Error(String(r.status)); }
      if (typeof fastPoll === "function") fastPoll();
    } catch {
      answeredQuestion = null; // send failed — let the pending question show again
      if (sess) updateQuestion(sess);
    }
  }

  // ---- file attachments (XERK-234) ------------------------------------------
  // Files the operator staged for the NEXT message. Each is uploaded to the hub
  // the moment it is picked — so Send is instant, and a file too big or a host
  // too old is refused while there is still something to look at rather than at
  // the end of a message the operator thought they'd sent.
  //
  // Shape: {key, name, size, status:"uploading"|"ready"|"error", uploadId, error}
  let attachments = [];
  let attachSeq = 0;

  function fmtBytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return Math.round(b / 1024) + " KB";
    return (b / (1024 * 1024)).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + " MB";
  }

  // The largest file the OPEN session's host will take, 0 when it can't take one
  // (an agent that predates attachments reports no `uploadMaxBytes` — see the
  // hub's uploadCapFor). 0 is what hides the 📎 rather than letting the operator
  // attach into a void.
  function attachCap(a) {
    const n = Number((a || agent || {}).uploadMaxBytes);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function attachEnabled() { return attachCap() > 0; }

  function attachmentsHtml(list) {
    return (list || []).map((f) => {
      const cls = f.status === "error" ? " att-error"
        : f.status === "uploading" ? " att-uploading" : "";
      const meta = f.status === "error" ? esc(f.error || "failed")
        : f.status === "uploading" ? "uploading…" : fmtBytes(f.size);
      return `<span class="att-chip${cls}" title="${esc(f.name)}">` +
        `<span class="att-name">${esc(f.name)}</span>` +
        `<span class="att-size">${meta}</span>` +
        `<button class="att-x" title="Remove" data-att="${esc(f.key)}">✕</button></span>`;
    }).join("");
  }

  // Paint every strip on the page (chat's and the terminal's), the same way
  // updateComposeAction paints every Send — the two bars send through one
  // endpoint and must never disagree about what is attached.
  function renderAttachments() {
    const html = attachmentsHtml(attachments);
    for (const el of document.querySelectorAll(".compose-attach")) {
      if (el.innerHTML !== html) el.innerHTML = html;
    }
    const clip = $("chatClip");
    if (clip) {
      clip.hidden = !attachEnabled();
      // A pending question is answered THROUGH the compose box (POST .../answer,
      // which carries no attachments), so attaching is off while one is up.
      clip.disabled = questionActive;
      clip.title = questionActive
        ? "Answer the question first — an answer can't carry a file"
        : "Attach images or documents";
    }
  }

  function removeAttachment(key) {
    attachments = attachments.filter((f) => f.key !== key);
    renderAttachments();
  }

  function clearAttachments() { attachments = []; renderAttachments(); }

  // Stage files and start their uploads. Called by the 📎 picker, a drop on the
  // transcript, and a paste carrying files (a screenshot off the clipboard).
  function attachFiles(files) {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length || !hostKey || !sessionId) return;
    const cap = attachCap();
    if (!cap) { actionFailed("Host too old for files"); return; }
    for (const file of list) {
      if (attachments.length >= MAX_ATTACHMENTS) {
        actionFailed(`Max ${MAX_ATTACHMENTS} files`);
        break;
      }
      const rec = {
        key: "a" + (++attachSeq),
        name: file.name || "upload",
        size: file.size || 0,
        status: file.size > cap ? "error" : "uploading",
        error: file.size > cap ? `too big — max ${fmtBytes(cap)}` : "",
        uploadId: "",
      };
      attachments.push(rec);
      if (rec.status !== "error") uploadOne(rec, file);
    }
    renderAttachments();
  }

  async function uploadOne(rec, file) {
    // The session this upload belongs to: if the operator walks to another
    // session mid-upload the reply is stale, and its chip is already gone.
    const forSession = sessionId, forHost = hostKey;
    try {
      const url = "/api/agents/" + enc(forHost) + "/sessions/" + enc(forSession) +
        "/uploads?name=" + encodeURIComponent(rec.name);
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      });
      const reply = await r.json().catch(() => null);
      if (!r.ok) throw new Error((reply && reply.error) || ("upload failed (" + r.status + ")"));
      if (forSession !== sessionId || !attachments.includes(rec)) return;
      rec.uploadId = reply.uploadId;
      rec.name = reply.name || rec.name;   // the name it will land under
      rec.size = reply.size || rec.size;
      rec.status = "ready";
    } catch (e) {
      if (forSession !== sessionId || !attachments.includes(rec)) return;
      rec.status = "error";
      rec.error = (e && e.message) || "upload failed";
    }
    renderAttachments();
  }

  // Wire the picker/drop/paste entry points once. The picker is one <input> for
  // the page (sessions.html), reset after every pick so re-choosing the same
  // file still fires `change`.
  function openFilePicker() {
    const inp = $("chatFilePicker");
    if (!inp || !attachEnabled() || questionActive) return;
    inp.value = "";
    inp.click();
  }

  function wireAttachDrop() {
    const wrap = document.querySelector(".chat-scroll-wrap");
    if (!wrap || wrap.dataset.attWired) return;
    wrap.dataset.attWired = "1";
    const has = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || [])
      .includes("Files");
    wrap.addEventListener("dragover", (e) => {
      if (!has(e) || !attachEnabled()) return;
      e.preventDefault();
      wrap.classList.add("att-drop");
    });
    wrap.addEventListener("dragleave", (e) => {
      if (e.target === wrap) wrap.classList.remove("att-drop");
    });
    wrap.addEventListener("drop", (e) => {
      wrap.classList.remove("att-drop");
      if (!has(e) || !attachEnabled()) return;
      e.preventDefault();
      attachFiles(e.dataTransfer.files);
    });
    // One delegated handler for every chip's ✕, on both strips.
    document.addEventListener("click", (e) => {
      const x = e.target.closest && e.target.closest(".att-x[data-att]");
      if (!x) return;
      e.preventDefault();
      removeAttachment(x.getAttribute("data-att"));
    });
  }

  // A paste carrying files (a screenshot, a dragged-in doc) attaches them; a
  // paste of plain text is left alone so the textarea handles it normally.
  function composePaste(e) {
    const files = (e && e.clipboardData && e.clipboardData.files) || null;
    if (!files || !files.length || !attachEnabled() || questionActive) return;
    e.preventDefault();
    attachFiles(files);
  }

  /**
   * The staged uploadIds for the message about to be sent, or null when one is
   * still uploading / failed — the caller then holds the message rather than
   * sending it with a file silently missing. `[]` means simply nothing attached.
   */
  function readyUploadIds() {
    if (!attachments.length) return [];
    if (attachments.some((f) => f.status === "uploading")) return null;
    if (attachments.some((f) => f.status === "error")) return null;
    return attachments.map((f) => f.uploadId).filter(Boolean);
  }

  // ---- compose (typed prompt, or custom question answer) --------------------
  function autoGrow() {
    const inp = $("chatInput");
    if (!inp) return;
    // scrollHeight is 0 for a textarea that isn't laid out — its pane is
    // `.chat-pane[hidden]` (terminal view) or, on a phone, the whole `.stage` is
    // display:none. Growing from that pins an inline height:0px that squishes the
    // box below one line and survives every repaint until a page refresh
    // (XERK-149). `growCompose` runs this during the chat<->terminal carryDraft,
    // exactly when the box can be hidden — so skip while hidden and keep the last
    // laid-out height; the pane's own carryDraft re-grows it when it's shown.
    if (inp.offsetParent === null) return;
    inp.style.height = "auto";
    inp.style.height = Math.min(inp.scrollHeight, 160) + "px";
  }
  // The hub rejects a message past the receiving host's character cap with a 413
  // (XERK-227). That is the one send failure the operator can act on — the text
  // is still in the box, it just has to be split — so it gets its own label
  // instead of the generic "Send failed", which reads as "the hub is down".
  // The cap is per host (an agent too old to paste takes far less), so the
  // label carries the hub's `limit` when it sent one: "too long" without a
  // number leaves the operator guessing how much to cut.
  const TOO_LONG = "Message too long";
  // A staged attachment aged out of the hub's relay (XERK-234). Like "too long"
  // this is a refusal the operator can act on — re-attach and send again — so it
  // gets its own wording rather than the generic "Send failed".
  const ATT_GONE = "Attachment expired — re-attach";
  // Everything else the hub refuses — a 409, a 503, a full command queue — has
  // already gone to the toast in the hub's own words (see hubRefused), so the
  // button just says the send didn't happen. It used to read the bare status
  // number, which told the operator nothing (XERK-264).
  const SEND_FAILED = "Send failed";
  function sendFailure(status, limit, error) {
    if (status === 404 && /attachment/i.test(error || "")) return ATT_GONE;
    if (status !== 413) return SEND_FAILED;
    const n = Number(limit);
    return n > 0 ? `Too long — max ${n.toLocaleString()}` : TOO_LONG;
  }
  // "Is this message one WE worded?" — the gate both compose bars put a thrown
  // message through before showing it, so a transport error's own text can't
  // land on the button.
  function isTooLong(msg) {
    return msg === TOO_LONG || msg === ATT_GONE || /^Too long — max /.test(msg || "");
  }
  // ---- a refusal the hub explained ------------------------------------------
  // The hub refuses a command with a status and a JSON `{error}` body — an org
  // mismatch, an agent too old to run it, an offline host, an expired
  // attachment, a command queue too full to take another. Chat dropped all of
  // that on the floor (XERK-264): a send read as a bare status number, an
  // answer vanished, a model switch kept the label it optimistically painted.
  //
  // The compose button has room for a label, not a sentence, so the hub's own
  // words go to the page's shared toast — the one surface every refused command
  // on the page raises — and the button keeps its short wording. Returns the
  // parsed body so the caller can read `limit`/`error` for that wording.
  //
  // Guarded on TurmaNav: the vendored copy of this engine (glasses)
  // renders transcripts with none of the site chrome loaded.
  async function hubRefused(what, res) {
    const body = await res.json().catch(() => null);
    const nav = typeof window !== "undefined" && window.TurmaNav;
    if (nav && nav.toast && nav.refusalText) nav.toast(nav.refusalText(what, res.status, body));
    return body;
  }
  async function send() {
    const inp = $("chatInput");
    if (!inp || !hostKey || !sessionId) return;
    const text = inp.value;
    const wasAnswer = questionActive;
    // Attachments ride a plain message only (an /answer carries no files), and
    // a message can be attachments alone — but never one that is still on its
    // way up, which would arrive with the file missing and nothing said.
    const uploadIds = wasAnswer ? [] : readyUploadIds();
    if (!wasAnswer && uploadIds === null) {
      actionFailed(attachments.some((f) => f.status === "error")
        ? "Remove the failed file" : "Files still uploading");
      return;
    }
    if (!text.trim() && !(uploadIds && uploadIds.length)) return;
    inp.value = ""; autoGrow(); inp.focus();
    const sentAttachments = wasAnswer ? [] : attachments.slice();
    if (!wasAnswer) clearAttachments();
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
        if (uploadIds.length) body.uploadIds = uploadIds;
      }
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) {
        const err = await hubRefused(wasAnswer ? "Answer" : "Send", r);
        throw new Error(sendFailure(r.status, err && err.limit, err && err.error));
      }
      if (typeof fastPoll === "function") fastPoll();
    } catch (e) {
      if (wasAnswer) { answeredQuestion = null; if (sess) updateQuestion(sess); }
      if (!inp.value.trim()) { inp.value = text; autoGrow(); }
      // Put the chips back with the text: the operator is going to press Send
      // again, and re-picking the files by hand is not something a failed POST
      // should cost them. The staged uploads live on the hub for 20 minutes.
      if (sentAttachments.length && !attachments.length) {
        attachments = sentAttachments;
        renderAttachments();
      }
      actionFailed(isTooLong(e && e.message) ? e.message : "Send failed");
    }
  }

  // Delegated clicks inside the scroll (code-block copy buttons).
  function wireScrollDelegation() {
    const scroll = $("chatScroll");
    if (!scroll || scroll.dataset.wired) return;
    scroll.dataset.wired = "1";
    scroll.addEventListener("click", copyCodeClick);
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
    // Code-block copy button (XERK-183) — the static/archive/subagent views.
    stScroll.addEventListener("click", copyCodeClick);
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
    // A switch memo belongs to the session it was made on. Opening a DIFFERENT
    // session must drop it, or that session is painted with the previous one's
    // pending source (🏠 on a subscription session) and its own switch click is
    // swallowed by the `value === currentModelSource()` early-return.
    if (!modelSourcePending || modelSourcePending.sessionId !== id) modelSourcePending = null;
    // Same for the endpoint-model memo (XERK-489): drop a foreign session's, and
    // retire ours once the heartbeat's localModelName agrees.
    if (!localModelPending || localModelPending.sessionId !== id) localModelPending = null;
    // Same for the dsh endpoint-model memo (XERK-504): drop a foreign session's,
    // and retire ours once the heartbeat's `model` agrees.
    if (!dshModelPending || dshModelPending.sessionId !== id) dshModelPending = null;
    hostKey = hk; sessionId = id; sess = s; agent = a;
    // The switch has landed once the host reports the source we asked for.
    if (modelSourcePending && s && s.modelSource === modelSourcePending.value) modelSourcePending = null;
    if (localModelPending && s && s.localModelName === localModelPending.value) localModelPending = null;
    if (dshModelPending && s && s.model === dshModelPending.value) dshModelPending = null;
    historyChain = false;   // a chain from the PREVIOUS session must not block this one
    buffer = []; queuedPrompts = []; liveTurn = ""; liveStatus = null; liveAgents = [];
    backoffIdx = 0;
    stopPendingAt = 0; actionFailUntil = 0; // the compose button starts at Send
    modelSwitchPending = null; modeSwitchPending = null;
    lastHtml = null; repaintDeferred = false; // this session's paint memo starts empty
    stickBottom = true; // land at the tail on open, past the seed→history race
    detailsOpen.clear();
    loadVerbosity(id);
    setHeader(s, a);
    renderVerbosityControl();
    renderComposeOpts();
    wireScrollDelegation();
    wireAttachDrop();
    clearAttachments();  // files are staged per session, never carried across
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
    hostKey = null; sessionId = null; sess = null; agent = null;
    modelSourcePending = null;
    buffer = []; queuedPrompts = []; liveTurn = ""; liveStatus = null; liveAgents = [];
    questionActive = false; answeredQuestion = null;
    panePromptActive = false; answeredPanePrompt = null;
    stopPendingAt = 0; actionFailUntil = 0; modelSwitchPending = null; modeSwitchPending = null;
    lastHtml = null; repaintDeferred = false;
    clearAttachments();
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
    // The host payload carries `uploadMaxBytes`, so the 📎 can only appear once
    // a beat has been seen — repaint the strip on every one.
    renderAttachments();
  }

  if (typeof window !== "undefined") {
    window.TurmaChat = { open, close, repaint: repaintPublic, onPoll, renderStatic: openStatic, closeStatic,
      // sendFailure/isTooLong are shared with the terminal composer so the two
      // compose bars word a refusal identically (XERK-227).
      isBusy, stop, actionFailed, sendFailure, isTooLong,
      // The page calls this when the host's tunnel comes back (XERK-252).
      reconnectNow,
      // The terminal composer sends through the same /input, so it reads the
      // staged attachments from here rather than keeping a second list
      // (XERK-234).
      readyUploadIds, clearAttachments, hasAttachments: () => attachments.length > 0,
      attachError: () => (attachments.some((f) => f.status === "error")
        ? "Remove the failed file" : "Files still uploading") };
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
    // File attachments (XERK-234): the composer's 📎, the picker's change, and
    // a paste that carries files.
    window.chatComposeAttach = openFilePicker;
    window.chatFilesPicked = function (e) { attachFiles(e && e.target && e.target.files); };
    window.chatComposePaste = composePaste;
  }

  // Expose the pure core (merge + item building) for Node unit tests. Harmless
  // in the browser (no `module`); the browser path uses window.TurmaChat above.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      mergeTail, foldHistory, weight, buildItems, itemsToHtml, esc, linkify, renderInline, renderProse, copyCodeClick, prFooterChip,
      ticketFooterChip, modelOpts, prettyModel, MODEL_OPTS,
      agentsHtml, hasBackgroundAgents, optionCardHtml, panePromptHtml, filterModeOpts, MODE_OPTS, repaint, selectionInScroll,
      isBusy, updateComposeAction, updateLiveStatus, isToolBullet, sendFailure, isTooLong, TOO_LONG,
      loadHistory, reconnectNow, startWs,
      __setSessionRef: (hk, id) => { hostKey = hk; sessionId = id; },
      __gen: () => gen,
      // What open()/close() do between two sessions: everything in flight for
      // the old view is invalidated by the bump alone.
      __nextGen: () => { gen++; },
      attachmentsHtml, fmtBytes, readyUploadIds, renderAttachments, attachFiles,
      clearAttachments, MAX_ATTACHMENTS,
      __setAttachments: (a) => { attachments = a; },
      __attachments: () => attachments,
      // Drive the real `turn`-frame classifier (see applyTurn): the ws onmessage
      // hands it frame.text verbatim, so the flicker tests exercise it directly.
      __applyTurn: (t) => { applyTurn(t); },
      __setLiveStatus: (st) => { liveStatus = st; },
      __setLiveAgents: (a) => { liveAgents = Array.isArray(a) ? a : []; },
      __stopPending: (t) => { stopPendingAt = t; },
      modelChipLabel, modeChipValue,
      __setSess: (s) => { sess = s; sessionId = s && s.id; },
      __setHostKey: (k) => { hostKey = k; },
      __setAgent: (a) => { agent = a; },
      __setModelSwitchPending: (p) => { modelSwitchPending = p; },
      localModelOffered, currentModelSource, modelSourceLabel, modelSourceOpts,
      setSessionModelSource,
      // XERK-489 endpoint model dropdown + context override
      localModels, localModelOpts, currentLocalModel, currentLocalContext,
      servedContextFor, fmtCtx, localModelChipHtml, setSessionLocalModel,
      contextMeterChip,   // Phase 4 context-fullness meter
      // XERK-504 dsh runtime footer (read-only runtime chip + live model dropdown)
      isDshSession, dshModels, currentDshModel, dshModelOpts, dshModelChipHtml,
      dshRuntimeChipHtml, setSessionDshModel,
      isQwenSession, qwenRuntimeChipHtml, qwenModelChipHtml,
      renderComposeOpts,
      __setDshModelPending: (p) => { dshModelPending = p; },
      __setLocalModelPending: (p) => { localModelPending = p; },
      __setModelSourcePending: (p) => { modelSourcePending = p; },
      __setModeSwitchPending: (p) => { modeSwitchPending = p; },
      __setQuestionActive: (v) => { questionActive = v; },
      __setPanePromptActive: (v) => { panePromptActive = v; },
      __setVerbosity: (v) => { verbosity = v; },
      __setBuffer: (b) => { buffer = b; },
      __setQueued: (q) => { queuedPrompts = q; },
      __setLiveTurn: (t) => { liveTurn = t; },
      __resetPaint: () => { lastHtml = null; repaintDeferred = false; },
      __liveTurn: () => liveTurn,
    };
  }
})();
