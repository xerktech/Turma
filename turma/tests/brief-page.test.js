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
