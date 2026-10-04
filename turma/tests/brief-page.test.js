// brief.html's /api/agents fetch MERGES, never replaces (XERK-444): a `briefs`
// SSE frame that lands while the fetch is in flight is newer than the body, so
// the snapshot must keep it. The page's own `refresh` and `briefs` handler are
// lifted out of the inline script and run against a controllable fetch.
// node:test, no npm.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "public", "brief.html"), "utf8");

function slice(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker);
  assert.ok(a >= 0, `brief.html has ${startMarker}`);
  const b = SRC.indexOf(endMarker, a);
  assert.ok(b > a, `brief.html has ${endMarker} after ${startMarker}`);
  return SRC.slice(a, b + endMarker.length);
}

function loadPage() {
  const refreshSrc = slice("let briefsClock = 0;", "\n  if (cache) render(cache);\n}\n");
  const handler = slice('es.addEventListener("briefs", (e) => {', "\n  });");
  const handlerFn = handler.slice('es.addEventListener("briefs", '.length, -");".length);
  let pending = null;
  const fetch = () => new Promise((resolve) => {
    pending = (body) => resolve({ status: 200, json: async () => body });
  });
  const factory = new Function("fetch", "render", "location", `
    let cache = null;
    ${refreshSrc}
    const onBriefs = ${handlerFn};
    return {
      refresh, onBriefs,
      setCache: (c) => { cache = c; },
      getCache: () => cache,
    };`);
  const page = factory(fetch, () => {}, {});
  page.answer = (body) => pending(body);
  return page;
}

test("brief.html: a briefs frame that lands mid-fetch survives the older snapshot (XERK-444)", async () => {
  const p = loadPage();
  p.setCache({ agents: [], briefs: { "a.net": [{ id: 1 }] } });
  const done = p.refresh();
  p.onBriefs({ data: JSON.stringify({ "a.net": [{ id: 2 }] }) });   // newer brief, mid-fetch
  p.answer({ agents: [{ key: "h" }], briefs: { "a.net": [{ id: 1 }] } });
  await done;
  assert.equal(p.getCache().briefs["a.net"][0].id, 2, "the live brief survives");
  assert.equal(p.getCache().agents[0].key, "h", "every other key comes from the snapshot");
});

test("brief.html: an unraced snapshot still replaces the briefs", async () => {
  const p = loadPage();
  p.setCache({ agents: [], briefs: { "a.net": [{ id: 1 }] } });
  const done = p.refresh();
  p.answer({ agents: [], briefs: { "a.net": [{ id: 3 }] } });
  await done;
  assert.equal(p.getCache().briefs["a.net"][0].id, 3);
});

// ---- XERK-1574: the narrative + the decisions log on the page ------------------

function loadDecisionsPage() {
  const refreshSrc = slice("let briefsClock = 0;", "\n  if (cache) render(cache);\n}\n");
  const handler = slice('es.addEventListener("decisions", (e) => {', "\n  });");
  const handlerFn = handler.slice('es.addEventListener("decisions", '.length, -");".length);
  let pending = null;
  const fetch = () => new Promise((resolve) => {
    pending = (body) => resolve({ status: 200, json: async () => body });
  });
  const factory = new Function("fetch", "render", "location", `
    let cache = null;
    ${refreshSrc}
    const onDecisions = ${handlerFn};
    return { refresh, onDecisions, setCache: (c) => { cache = c; }, getCache: () => cache };`);
  const page = factory(fetch, () => {}, {});
  page.answer = (body) => pending(body);
  return page;
}

test("brief.html: a decisions frame that lands mid-fetch survives the older snapshot (XERK-1574)", async () => {
  const p = loadDecisionsPage();
  p.setCache({ agents: [], briefs: {}, decisions: { "a.net": [{ text: "old" }] } });
  const done = p.refresh();
  p.onDecisions({ data: JSON.stringify({ "a.net": [{ text: "new" }] }) });
  p.answer({ agents: [], briefs: {}, decisions: { "a.net": [{ text: "old" }] } });
  await done;
  assert.equal(p.getCache().decisions["a.net"][0].text, "new");
});

test("brief.html: a decisionCounts frame that lands mid-fetch survives with its tail (XERK-1574)", async () => {
  const handler = slice('es.addEventListener("decisionCounts", (e) => {', "\n  });");
  const handlerFn = handler.slice('es.addEventListener("decisionCounts", '.length, -");".length);
  const refreshSrc = slice("let briefsClock = 0;", "\n  if (cache) render(cache);\n}\n");
  let pending = null;
  const fetch = () => new Promise((resolve) => {
    pending = (body) => resolve({ status: 200, json: async () => body });
  });
  const p = new Function("fetch", "render", "location", `
    let cache = null;
    ${refreshSrc}
    const onCounts = ${handlerFn};
    return { refresh, onCounts, setCache: (c) => { cache = c; }, getCache: () => cache };`)(
    fetch, () => {}, {});
  p.setCache({ agents: [], decisions: {}, decisionCounts: { "a.net": 3 } });
  const done = p.refresh();
  p.onCounts({ data: JSON.stringify({ "a.net": 4 }) });
  pending({ agents: [], decisions: {}, decisionCounts: { "a.net": 3 } });
  await done;
  assert.equal(p.getCache().decisionCounts["a.net"], 4);
});

function loadRenderers() {
  const src = slice("const narrativeOpen = new Set();", "\n// `live` = a host is decided");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Function("esc", "ago", "drafts", "noteBusy",
    `${src}\nreturn { narrativeHtml, decisionsHtml, narrativeOpen };`)(
    esc, (ms, now) => `${Math.round((now - ms) / 1000)}s`,
    new Map([["a.net", "half <typed>"]]), new Set());
}

test("brief.html: the summary is labelled, escaped, and absent without a narrative (XERK-1574)", () => {
  const { narrativeHtml } = loadRenderers();
  assert.equal(narrativeHtml({}), "");
  assert.equal(narrativeHtml(null), "");
  const html = narrativeHtml({ narrative: "Two <b>shipped</b>." });
  assert.match(html, /Summary · written by a model/);
  assert.ok(html.includes("Two &#60;b&#62;shipped&#60;/b&#62;."));
});

test("brief.html: the decisions tail is newest first, escaped, a composer only for a live org (XERK-1574)", () => {
  const { decisionsHtml } = loadRenderers();
  const list = [
    { at: 1000, source: "question", question: "Which <DB>?", answer: "PG", ticket: "X-1", host: "h" },
    { at: 2000, source: "note", text: "No infra merges." },
  ];
  const html = decisionsHtml("a.net", list, 5000, true);
  assert.ok(html.indexOf("No infra merges.") < html.indexOf("Which &#60;DB&#62;?"), "newest first");
  assert.match(html, /data-note="a\.net"/);
  assert.ok(html.includes('value="half &#60;typed&#62;"'), "the draft survives a repaint");
  assert.equal(decisionsHtml("a.net", list, 5000, false).includes("data-note"), false);
  assert.equal(decisionsHtml("a.net", [], 5000, false), "", "nothing to show, nowhere to add");
  assert.match(decisionsHtml("a.net", [], 5000, true), /No decisions recorded yet/);
});

test("brief.html: the decisions count is the org's, not the served tail's (XERK-1574)", () => {
  const { decisionsHtml } = loadRenderers();
  const tail = Array.from({ length: 20 }, (_, i) => ({ at: 1000 + i, source: "note", text: `n${i}` }));
  const html = decisionsHtml("a.net", tail, 5000, false, 50);
  assert.match(html, /Decisions <span class="n">50<\/span>/);
  assert.match(html, /\+40 earlier/);
  // An older hub sends no count: the served list is the floor.
  assert.match(decisionsHtml("a.net", tail, 5000, false), /Decisions <span class="n">20<\/span>/);
  assert.match(decisionsHtml("a.net", tail, 5000, false, 3), /Decisions <span class="n">20<\/span>/);
});

test("brief.html: a decision row names the session it came from (XERK-1574)", () => {
  const { decisionsHtml } = loadRenderers();
  const html = decisionsHtml("a.net", [
    { at: 1000, source: "question", question: "Q?", answer: "A", label: "archive <index> work", host: "h" },
    { at: 2000, source: "question", question: "Q2?", answer: "B", label: "x".repeat(80) },
  ], 5000, false);
  const text = (h) => h.replace(/<[^>]*>/g, "");
  assert.ok(text(html).includes("question · archive &#60;index&#62; work · 4s ago · h"));
  assert.ok(html.includes(`${"x".repeat(59)}…`));
  assert.equal(html.includes("x".repeat(60)), false, "a long label is clipped");
});

// The whole org renderer (SECTIONS → orgHtml), with the page's globals stubbed.
function loadOrgHtml() {
  const end = "\nfunction render(data) {";
  const src = slice("const SECTIONS = [", end).slice(0, -end.length);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Function("esc", "TurmaBoard", "busy", "drafts", "noteBusy",
    `${src}\nreturn orgHtml;`)(esc, { orgName: (s) => `Org ${s}` }, new Set(), new Map(), new Set());
}

test("brief.html: the decisions log is its own card AFTER the brief's, not inside its period (XERK-1574)", () => {
  const orgHtml = loadOrgHtml();
  const brief = { at: 9000, since: 1000, counts: { needsYou: 0 }, needsYou: [],
    spend: [{ host: "h", fiveHourPct: 10 }] };
  const older = { at: 4000, since: 1000, counts: {} };
  const decs = [{ at: 1000, source: "note", text: "No infra merges.", label: "infra work" }];
  const html = orgHtml("a.net", [brief, older], 9500, true, decs, 12);
  const cards = html.split('<section class="brief-org').slice(1);
  assert.equal(cards.length, 2, "one brief card, then one decisions card");
  assert.equal(cards[0].includes("No infra merges."), false, "the brief card holds no decision");
  assert.ok(cards[0].includes("Earlier briefs (1)"), "earlier briefs stay in the brief card");
  assert.ok(cards[0].includes("<h3>Spend"));
  assert.ok(cards[1].startsWith(' brief-decisions">'));
  assert.ok(cards[1].includes("Org a.net"), "the card names its org");
  assert.match(cards[1], /Decisions <span class="n">12<\/span>/);
  assert.match(cards[1], /\+11 earlier/);
  assert.ok(cards[1].includes("infra work"), "a row still names its session");
  assert.match(cards[1], /data-note="a\.net"/, "the note box rides the decisions card");
  // An org with no brief yet still gets its decisions card after the placeholder.
  const none = orgHtml("a.net", [], 9500, true, decs, 1).split('<section class="brief-org').slice(1);
  assert.equal(none.length, 2);
  assert.ok(none[0].includes("No brief yet"));
  assert.ok(none[1].includes("No infra merges."));
  // Nothing logged and nowhere to add one: no decisions card at all.
  assert.equal(orgHtml("a.net", [brief], 9500, false, [], 0).split('<section class="brief-org').length, 2);
});

test("brief.html: the summary is clamped until Show more, its toggle hidden until measured (XERK-1574)", () => {
  const { narrativeHtml, narrativeOpen } = loadRenderers();
  const shut = narrativeHtml({ narrative: "Two shipped." }, "a.net");
  assert.match(shut, /<p data-narrative="a\.net" class="clamped">/);
  assert.match(shut, /data-narrative-toggle="a\.net" aria-expanded="false" hidden>Show more</);
  narrativeOpen.add("a.net");
  const open = narrativeHtml({ narrative: "Two shipped." }, "a.net");
  assert.match(open, /<p data-narrative="a\.net">/, "an expanded summary is not clamped");
  assert.match(open, /aria-expanded="true" hidden>Show less</);
  // A readable measure at desktop width.
  assert.match(SRC, /\.brief-narrative p \{[^}]*max-width: 70ch/);
  assert.match(SRC, /\.brief-narrative p\.clamped \{[^}]*-webkit-line-clamp: 4/);
});

test("brief.html: a summary's toggle shows only when the text overflows the clamp (XERK-1574)", () => {
  const src = slice("function fitNarratives() {", "\n}\n");
  const para = (lines, open) => {
    const cls = new Set(open ? [] : ["clamped"]);
    const btn = { dataset: { narrativeToggle: "a.net" }, hidden: true };
    return {
      btn,
      cls,
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
      get clientHeight() { return cls.has("clamped") ? Math.min(lines, 4) * 21 : lines * 21; },
      get scrollHeight() { return lines * 21; },
      nextElementSibling: btn,
    };
  };
  const ps = [para(3, false), para(18, false), para(18, true)];
  const fit = new Function("$briefs", `${src}\nreturn fitNarratives;`)({ querySelectorAll: () => ps });
  fit();
  assert.equal(ps[0].btn.hidden, true, "a summary that fits gets no toggle");
  assert.equal(ps[1].btn.hidden, false);
  assert.equal(ps[2].btn.hidden, false, "an expanded summary keeps its Show less");
  assert.ok(ps[1].cls.has("clamped"));
  assert.equal(ps[2].cls.has("clamped"), false, "measuring never re-clamps an expanded one");
});

test("brief.html: a typed-answer marker is muted, never bold as if chosen (XERK-1574)", () => {
  const { decisionsHtml } = loadRenderers();
  const html = decisionsHtml("a.net", [
    { at: 1000, source: "question", question: "Which DB?", answer: "Postgres, plus a typed answer" },
    { at: 2000, source: "question", question: "Why?", answer: "(a typed answer)" },
    { at: 3000, source: "question", question: "Q?", answer: "Yes" },
  ], 5000, false);
  assert.ok(html.includes('Which DB? → <b>Postgres</b><span class="typed">, plus a typed answer</span>'));
  assert.ok(html.includes('Why? → <span class="typed">(a typed answer)</span>'));
  assert.ok(html.includes("Q? → <b>Yes</b>"));
  assert.equal(/<b>[^<]*typed answer/.test(html), false);
});

test("brief.html: a decision's kind is a noun, its meta pieces each unbreakable (XERK-1574)", () => {
  const { decisionsHtml } = loadRenderers();
  const html = decisionsHtml("a.net", [
    { at: 1000, source: "question", question: "Q?", answer: "A", ticket: "X-1", label: "work", host: "Jira poller" },
    { at: 2000, source: "permission", question: "Bash", answer: "Yes" },
    { at: 3000, source: "note", text: "n" },
  ], 5000, false);
  for (const k of ["question", "permission", "note"]) assert.ok(html.includes(`<span class="kind">${k}</span>`), k);
  assert.equal(html.includes("answered"), false);
  // The "·" ENDS each piece but the last, so a wrapped line never starts with one.
  const sep = '<span class="sep"> ·</span>';
  assert.ok(html.includes(`<span class="bit"><span class="v"><span class="kind">question</span></span>${sep}</span>`
    + ` <span class="bit"><span class="v"><span class="key">X-1</span></span>${sep}</span>`
    + ` <span class="bit"><span class="v"><span class="sess">work</span></span>${sep}</span>`
    + ` <span class="bit"><span class="v">4s ago</span>${sep}</span>`
    + ' <span class="bit"><span class="v">Jira poller</span></span></div>'));
  assert.equal(/<span class="bit">[^<]*·/.test(html), false);
  assert.match(SRC, /\.brief-decision \.brief-meta \.bit \{[^}]*white-space: nowrap;/);
  assert.match(SRC, /\.brief-meta \.bit > \.v \{[^}]*text-overflow: ellipsis/);
  assert.match(SRC, /\.brief-meta \.bit > \.sep \{[^}]*flex: none/);
});

test("brief.html: the decisions subtitle sits beside its title, not pushed right (XERK-1574)", () => {
  const { decisionsHtml } = loadRenderers();
  const head = decisionsHtml("a.net", [{ at: 1, source: "note", text: "n" }], 5000, false, 1, "acme")
    .match(/<div class="brief-head">(.*?)<\/div>/)[1];
  assert.ok(head.endsWith('<span class="spacer"></span>'), "the spacer, not the subtitle, is the last child");
  assert.ok(head.includes("acme · the org's log, across every brief"));
});
