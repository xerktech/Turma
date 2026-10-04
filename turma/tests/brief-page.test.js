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
  const src = slice("function narrativeHtml(b) {", "\n// `live` = a host is decided");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Function("esc", "ago", "drafts", "noteBusy",
    `${src}\nreturn { narrativeHtml, decisionsHtml };`)(
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
  assert.ok(html.includes("answered</span> · archive &#60;index&#62; work · 4s ago · h"));
  assert.ok(html.includes(`${"x".repeat(59)}…`));
  assert.equal(html.includes("x".repeat(60)), false, "a long label is clipped");
});
