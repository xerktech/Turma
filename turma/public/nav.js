// Turma site chrome — the one source of truth for the header and the phone
// bottom-nav that every page carries. Each of index/sessions/board/usage used
// to hand-roll its own copy of both, so the wordmark, the tab list and the
// four bottom-nav icons were duplicated four times and drifted (sessions grew
// its own full-width bar; only some pages carried a status slot).
//
// The header markup this builds is IDENTICAL on every page. Everything a page
// wants to say about itself goes in the two slots — #hdrSub (the static
// descriptor) and #hdrMeta (dynamic) — which the page's own script fills. An
// unfilled slot collapses (`.sub:empty` in app.css), so pages using fewer slots
// still ship the same DOM.
//
// A third slot, #hdrOrg, is the exception that proves the rule: no page fills
// it. It is filled by org.js with the one org-scoping control every page obeys
// (XERK-62), which is why it lives in the chrome rather than in any page's
// markup. It sits after the spacer so it right-aligns beside the tabs, and it
// collapses when the fleet reports no tracker org at all.
//
// Loaded by every page in the browser (window.TurmaNav) and require()d directly
// by tests/nav.test.js, the same dual-export pattern as chat.js / board.js.
// Mounting is synchronous on load so the header paints with the page and the
// slot elements exist before the page's own script runs.
(() => {
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  // The nav itself: one list, rendered as pill tabs up top and as the phone
  // bottom bar. `id` is what a page names in `data-page` to mark its tab.
  const PAGES = [
    {
      id: "dashboard", href: "/", label: "Dashboard",
      icon: `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>`,
    },
    {
      id: "sessions", href: "/sessions", label: "Sessions",
      icon: `<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/>`,
      join: `stroke-linejoin="round"`,
    },
    {
      id: "board", href: "/board", label: "Board",
      icon: `<rect x="3" y="3" width="5" height="18" rx="1"/><rect x="9.5" y="3" width="5" height="12" rx="1"/><rect x="16" y="3" width="5" height="15" rx="1"/>`,
    },
    {
      id: "usage", href: "/usage", label: "Usage",
      icon: `<path d="M5 20V12"/><path d="M12 20V5"/><path d="M19 20v-5"/>`,
    },
  ];

  const SIGNOUT = "fetch('/api/logout',{method:'POST'}).then(()=>location.href='/login');return false;";

  function tabsHtml(active) {
    const tabs = PAGES.map(p =>
      `<a href="${p.href}"${p.id === active ? ' class="active"' : ""}>${esc(p.label)}</a>`
    ).join("\n      ");
    return `<nav class="nav-tabs">
      ${tabs}
      <a href="#" class="signout" onclick="${SIGNOUT}">Sign out</a>
    </nav>`;
  }

  // The header's inner row. Capped and centred by .site-header-in (app.css) so
  // it lines up with each page's own content column.
  function siteHeaderHtml(active, sub) {
    return `<div class="site-header-in">
    <a class="wordmark" href="/"><img src="/favicon.svg" alt="" width="26" height="26"><span>Turma</span></a>
    <span class="sub" id="hdrSub">${esc(sub ?? "")}</span>
    <span class="sub" id="hdrMeta"></span>
    <span class="spacer"></span>
    <span class="org-slot" id="hdrOrg"></span>
    ${tabsHtml(active)}
  </div>`;
  }

  function bottomNavHtml(active) {
    return PAGES.map(p => `<a href="${p.href}"${p.id === active ? ' class="active"' : ""}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"${p.join ? " " + p.join : ""}>${p.icon}</svg>
    ${esc(p.label)}
  </a>`).join("\n  ");
  }

  // Mount into the page's placeholders. `data-page` picks the active tab and
  // `data-sub` seeds the descriptor slot; both live on the <header>.
  function mount(doc) {
    const header = doc.getElementById("siteHeader");
    if (!header) return;
    const active = header.dataset.page || "";
    header.innerHTML = siteHeaderHtml(active, header.dataset.sub || "");
    const bottom = doc.getElementById("bottomNav");
    if (bottom) bottom.innerHTML = bottomNavHtml(active);
  }

  // Every page repaints by replacing a container's innerHTML on each heartbeat
  // beat (SSE ~1s / poll) — which silently throws the user's scroll position
  // back to the start every second: the page's own window scroll AND any inner
  // overflow:auto region (the board's horizontal column strip, the fleet tree,
  // a session list, a long transcript). It was most obvious mid-swipe on the
  // phone board (XERK-35) but happens everywhere a beat repaints under a
  // scrolled viewport. `preserveScroll` is the one wrapper every recurring
  // repaint goes through so it can't recur: snapshot the scroll offsets, run the
  // paint, put them back — synchronously, in the same frame, so nothing flickers.
  //
  // Scrolled descendants are matched across the swap by a stable key: the
  // nearest `id` anchor if the element or an ancestor carries one (so a list the
  // beat REORDERS — host cards by activity, sessions by state — still maps its
  // scroll to the right row), else the STRUCTURAL child-index path from the
  // container (fine for a fixed, ordered set like the board's four columns). Only
  // elements actually scrolled off zero are captured, so a settled page costs one
  // cheap walk. Window scroll is restored only if the paint moved it (replacing a
  // tall container can briefly collapse document height and clamp to the top).
  function scrollKey(container, el) {
    const path = [];
    for (let n = el; n && n !== container; n = n.parentNode) {
      if (n.id) return { id: n.id, path: path.reverse() };
      const parent = n.parentNode;
      if (!parent) break;
      path.push(Array.prototype.indexOf.call(parent.children, n));
    }
    return { id: null, path: path.reverse() };
  }
  function nodeAt(root, path) {
    let n = root;
    for (const i of path) n = n && n.children[i];
    return n;
  }
  function nodeForKey(container, key) {
    const base = key.id ? document.getElementById(key.id) : container;
    return base && nodeAt(base, key.path);
  }
  function preserveScroll(container, paint) {
    if (!container) { paint(); return; }
    const winX = window.scrollX, winY = window.scrollY;
    const saved = [];
    for (const el of container.querySelectorAll("*")) {
      if (el.scrollTop || el.scrollLeft) {
        saved.push({ key: scrollKey(container, el), top: el.scrollTop, left: el.scrollLeft });
      }
    }
    paint();
    for (const s of saved) {
      const el = nodeForKey(container, s.key);
      if (el) { el.scrollTop = s.top; el.scrollLeft = s.left; }
    }
    if (window.scrollX !== winX || window.scrollY !== winY) window.scrollTo(winX, winY);
  }

  const api = { PAGES, siteHeaderHtml, bottomNavHtml, tabsHtml, mount, esc, preserveScroll };
  if (typeof window !== "undefined") window.TurmaNav = api;
  // Guarded on `document`, not `window`: a test can put a stand-in on a fake
  // global `window` before requiring this and still drive mount() itself.
  if (typeof document !== "undefined") mount(document);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
