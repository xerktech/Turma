// Turma site chrome — the one source of truth for the header and the phone
// bottom-nav that every page carries. Each of index/sessions/board/usage used
// to hand-roll its own copy of both, so the wordmark, the tab list and the
// four bottom-nav icons were duplicated four times and drifted (sessions grew
// its own full-width bar; only some pages carried a status slot).
//
// The header markup this builds is IDENTICAL on every page. Everything a page
// wants to say about itself goes in the three slots — #hdrSub (static
// descriptor), #hdrMeta (dynamic, left) and #hdrStatus (dynamic, right) — which
// the page's own script fills. An unfilled slot collapses (`.sub:empty` in
// app.css), so pages using fewer slots still ship the same DOM.
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
    ${tabsHtml(active)}
    <span class="sub" id="hdrStatus"></span>
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

  const api = { PAGES, siteHeaderHtml, bottomNavHtml, tabsHtml, mount, esc };
  if (typeof window !== "undefined") {
    window.TurmaNav = api;
    mount(document);
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
