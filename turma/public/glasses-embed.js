// Glasses phone-companion bridge (XERK-171) — the link between the embedded web
// Sessions/Board pages and the Even Hub plugin that hosts them in a WebView.
//
// The dedicated Even phone app embeds ONLY these two pages (nav trimmed by
// nav.js when `?embed=glasses` is on the URL). The plugin and the glasses' own
// display run in the same WebView but the embedded page is a cross-origin
// iframe, so the two talk over postMessage:
//
//   page  -> plugin : {source:"turma-embed", type:"session-open", host, id}
//                     {source:"turma-embed", type:"org", key}
//                     {source:"turma-embed", type:"ready", page}
//   plugin -> page  : {source:"turma-host",  type:"enter-session", id}
//
// The behaviour the ticket asks for: opening a session on the phone enters it on
// the glasses; opening one on the glasses opens it here; LEAVING a session on
// either side does not move the other — so this only ever emits/acts on ENTER,
// never on back/close. The org filter set in the shared header scopes the
// glasses session list too. Echo between the two sides is broken by two idempotent
// guards: the plugin's App.enterSession no-ops when it's already on that session,
// and planIncoming() below ignores an enter for the session already on screen.
//
// Dual-exported (window.TurmaGlassesEmbed + module.exports) like nav.js/org.js so
// the pure decision half is unit-testable with no DOM. The imperative half runs
// only when `?embed=glasses` is present — on every other load it is inert.
(() => {
  "use strict";

  const EMBED = "glasses";
  const FROM_PAGE = "turma-embed";
  const FROM_HOST = "turma-host";

  // ---- pure half (unit-tested) ---------------------------------------------

  function isEmbedded(search) {
    try { return new URLSearchParams(search || "").get("embed") === EMBED; }
    catch { return false; }
  }

  // Decide what to do with a message the plugin sent us. `currentId` is the
  // session this page currently shows (null on the board, which has no session
  // view). Returns one of:
  //   {action:"ignore"}                    — not ours, malformed, or already here
  //   {action:"open", id}                  — open it in-place (sessions page)
  //   {action:"navigate", id}              — no in-page opener (board) -> deep-link
  function planIncoming(data, currentId, hasOpener) {
    if (!data || data.source !== FROM_HOST) return { action: "ignore" };
    if (data.type !== "enter-session" || !data.id) return { action: "ignore" };
    // Already showing it — including the echo of a session WE just opened and
    // reported up. Ignoring here is half of the anti-ping-pong guard.
    if (data.id === currentId) return { action: "ignore" };
    return hasOpener ? { action: "open", id: data.id } : { action: "navigate", id: data.id };
  }

  // The deep-link a board-page enter falls back to: switch to the sessions tab
  // (kept embedded) and open the session there via its existing ?session= wait.
  function navigateHref(id) {
    return `/sessions?embed=${EMBED}&session=${encodeURIComponent(id)}`;
  }

  // ---- imperative half ------------------------------------------------------

  function toParent(msg) {
    try { parent.postMessage(Object.assign({ source: FROM_PAGE }, msg), "*"); }
    catch { /* no parent / blocked — the app just won't sync until it can */ }
  }

  function currentOrg() {
    const O = typeof window !== "undefined" && window.TurmaOrg;
    return (O && O.get && O.get()) || "";
  }

  // The page's own session view, if any. sessions.html publishes window.TurmaEmbed
  // ({currentId, openSession}); the board page does not, which is how we tell them
  // apart (board falls back to a deep-link navigation).
  function embedApi() {
    return (typeof window !== "undefined" && window.TurmaEmbed) || null;
  }

  function start() {
    // A session opened on THIS page -> tell the plugin so the glasses follow.
    // sessions.html dispatches this on every open (a user tap or our own
    // openSession); the plugin's guard drops the echo of an open it drove.
    window.addEventListener("turma:session-open", (e) => {
      const d = (e && e.detail) || {};
      if (d.id) toParent({ type: "session-open", host: d.host, id: d.id });
    });

    // The plugin (glasses drove an enter) -> open it here.
    window.addEventListener("message", (e) => {
      const api = embedApi();
      const cur = api && api.currentId ? api.currentId() : null;
      const plan = planIncoming(e.data, cur, !!(api && api.openSession));
      if (plan.action === "open") api.openSession(plan.id);
      else if (plan.action === "navigate") location.href = navigateHref(plan.id);
    });

    // The org filter scopes the glasses list too. TurmaOrg fires subscribe() on
    // an explicit change, but its stored pick only becomes EFFECTIVE once the
    // first heartbeat reports the org — a transition subscribe() does not signal.
    // A cheap poll of get() covers both, at a latency the glasses won't notice.
    let lastOrg = null;
    function pushOrg() {
      const key = currentOrg();
      if (key === lastOrg) return;
      lastOrg = key;
      toParent({ type: "org", key });
    }
    if (window.TurmaOrg && window.TurmaOrg.subscribe) window.TurmaOrg.subscribe(pushOrg);
    setInterval(pushOrg, 1000);

    toParent({ type: "ready", page: embedApi() ? "sessions" : "board" });
    pushOrg();
  }

  const api = { EMBED, FROM_PAGE, FROM_HOST, isEmbedded, planIncoming, navigateHref };
  if (typeof window !== "undefined") {
    window.TurmaGlassesEmbed = api;
    if (isEmbedded(typeof location !== "undefined" ? location.search : "")) {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
      else start();
    }
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
