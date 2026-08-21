// Unit tests for the "Clone from GitHub" bar's client logic (the inline script
// in public/index.html): search filtering, multi-select accumulation, the live
// selected-count, and the multi-repo batch clone. That code lives inline (not a
// require-able module like chat.js), so the harness loads the page's <script>
// body under lightweight browser-global stubs and drives the real functions —
// node:test, no npm, matching this package's zero-dependency stance.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Load the page's inline script into a sandbox with just enough of the DOM/
// timer/network surface stubbed that the module body runs to its definitions.
// Returns the clone functions plus hooks to observe render()/post() and set the
// module's `cache`, and a getElementById-backed element registry.
function loadCloneModule() {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  const els = new Map();                 // id -> fake element (for updateCloneButton)
  const store = {};
  const g = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    document: {
      getElementById: (id) => els.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      get activeElement() { return null; },
      createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }),
      body: {}, title: "",
    },
    EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; },
    fetch: () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ agents: [] }), text: () => Promise.resolve("") }),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    location: { pathname: "/", href: "" },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    // The header's org filter (org.js) — a real dependency of the page now that
    // every list is scoped by it. Stubbed as the identity scope ("all orgs"), so
    // these tests see the whole fabricated fleet.
    TurmaOrg: { get: () => "", filter: (a) => a || [], update() {}, subscribe() {}, sse() {} },
  };
  g.window = g; g.globalThis = g;

  // Expose the pieces we test and give the test a way to observe post()/render()
  // and seed `cache`, then evaluate under the stubs.
  const exportTail = `
    ;globalThis.__clone = { cloneBar, cloneSources, clonePick, clonePickCount, cloneRepo, cloneSearch, cloneText, updateCloneButton, cloneToggle, cloneDraft, cloneOpen, hostId };
    globalThis.__setRender = (f) => { render = f; };
    globalThis.__setPost = (f) => { post = f; };
    globalThis.__setCache = (c) => { cache = c; };
  `;
  const fn = new Function(
    "localStorage", "document", "window", "EventSource", "fetch",
    "setInterval", "clearInterval", "setTimeout", "clearTimeout", "location", "matchMedia", "TurmaOrg", "globalThis",
    src + exportTail
  );
  fn(g.localStorage, g.document, g.window, g.EventSource, g.fetch,
     g.setInterval, g.clearInterval, g.setTimeout, g.clearTimeout, g.location, g.matchMedia, g.TurmaOrg, g);

  const api = g.__clone;
  const posts = [];
  g.__setRender(() => {});                       // suppress DOM re-render side-effects
  g.__setPost((url, body) => { posts.push({ url, body }); return Promise.resolve(); });
  return { ...api, posts, els, setCache: g.__setCache };
}

// The section is collapsed by default; picker-content tests expand it first.
function expand(m, key) { m.cloneOpen.add(key); }

// A host with GitHub creds and a handful of repos, one of which is already
// present locally (so it should render disabled).
function sampleAgent() {
  return {
    key: "host1", online: true, repos: [{ name: "already" }],
    github: {
      available: true, login: "me", repos: [
        { name: "alpha", nameWithOwner: "me/alpha", isPrivate: false },
        { name: "beta", nameWithOwner: "me/beta", isPrivate: true },
        { name: "already", nameWithOwner: "me/already", isPrivate: false },
        { name: "gamma", nameWithOwner: "org/gamma", isPrivate: false },
      ],
    },
  };
}

test("cloneBar: a running clone shows the progress line, and escapes it", () => {
  const m = loadCloneModule();
  const a = sampleAgent();
  a.clones = [{ repo: "me/alpha", name: "alpha", status: "cloning",
                progress: "Receiving objects:  47% (2345/5000)" }];
  m.setCache({ agents: [a] });
  const html = m.cloneBar(a);
  assert.match(html, /Cloning <b>me\/alpha<\/b>/);
  assert.match(html, /Receiving objects:\s+47% \(2345\/5000\)/,
    "the agent's progress line reaches the row");
  // It is agent-supplied text on a page that renders HTML: escaped like every
  // other field, never interpolated raw.
  a.clones[0].progress = "<img src=x onerror=alert(1)>";
  assert.ok(!m.cloneBar(a).includes("<img src=x"), "progress is escaped");
});

test("cloneBar: no progress renders exactly as it did before", () => {
  // A repo that finishes inside one beat never reports progress, and an older
  // agent never sends the field — neither may leave a stray empty note.
  const m = loadCloneModule();
  const a = sampleAgent();
  a.clones = [{ repo: "me/alpha", name: "alpha", status: "cloning" }];
  m.setCache({ agents: [a] });
  const html = m.cloneBar(a);
  assert.match(html, /Cloning <b>me\/alpha<\/b>…<\/div>/);
  assert.ok(!html.includes("clone-note\"></span>"), "no empty note span");
});

test("cloneBar: a finished clone ignores any progress left on the job", () => {
  const m = loadCloneModule();
  const a = sampleAgent();
  a.clones = [{ repo: "me/alpha", name: "alpha", status: "done", progress: "99%" }];
  m.setCache({ agents: [a] });
  const html = m.cloneBar(a);
  assert.match(html, /✓ Cloned <b>alpha<\/b>/);
  assert.ok(!html.includes("99%"), "done rows have their own wording");
});

test("cloneBar: collapsed by default — header only, no picker until expanded", () => {
  const m = loadCloneModule();
  const a = sampleAgent();
  m.setCache({ agents: [a] });
  const collapsed = m.cloneBar(a);
  assert.match(collapsed, /clone-bar collapsed/, "starts collapsed");
  assert.match(collapsed, /Clone from GitHub/, "header label always shows");
  assert.ok(!collapsed.includes('type="checkbox"'), "no picker while collapsed");
  assert.ok(!collapsed.includes("clone-search-"), "no search box while collapsed");
  // cloneToggle flips it open.
  m.cloneToggle(a.key);
  const opened = m.cloneBar(a);
  assert.ok(!/clone-bar collapsed/.test(opened), "toggled open");
  assert.ok(opened.includes('type="checkbox"'), "picker shows once expanded");
});

test("cloneBar: renders a search box + one checkbox per repo, already-present disabled", () => {
  const m = loadCloneModule();
  const a = sampleAgent();
  m.setCache({ agents: [a] });
  expand(m, a.key);
  const html = m.cloneBar(a);
  assert.ok(html.includes(`clone-search-${m.hostId(a.key)}`), "has a search input");
  assert.equal((html.match(/type="checkbox"/g) || []).length, 4, "one checkbox per repo");
  // The already-present repo is disabled and annotated.
  assert.match(html.replace(/\s+/g, " "), /me\/already.*already here/);
  assert.match(html, /me\/beta 🔒/, "private repos get a lock");
});

test("cloneBar: search box filters the list case-insensitively", () => {
  const m = loadCloneModule();
  const a = sampleAgent();
  m.setCache({ agents: [a] });
  expand(m, a.key);
  m.cloneDraft.set(a.key, { search: "ME/" });
  const html = m.cloneBar(a);
  assert.ok(html.includes("me/alpha"), "keeps matches");
  assert.ok(!html.includes("org/gamma"), "drops non-matches");
  // No matches → an explanatory row, no checkboxes.
  m.cloneDraft.set(a.key, { search: "zzz" });
  const none = m.cloneBar(a);
  assert.ok(!none.includes('type="checkbox"'), "no checkboxes when nothing matches");
  assert.match(none, /No repos match/);
});

test("clonePick / clonePickCount: accumulate selections plus the free-text box", () => {
  const m = loadCloneModule();
  const a = sampleAgent();
  m.setCache({ agents: [a] });
  assert.equal(m.clonePickCount(a.key), 0);
  m.clonePick(a.key, "github|me/alpha", true);
  m.clonePick(a.key, "github|org/gamma", true);
  assert.equal(m.clonePickCount(a.key), 2, "two checked");
  m.clonePick(a.key, "github|org/gamma", false);
  assert.equal(m.clonePickCount(a.key), 1, "unchecking removes it");
  m.cloneText(a.key, "foo/bar");
  assert.equal(m.clonePickCount(a.key), 2, "free-text counts as one more");
  m.cloneText(a.key, "   ");
  assert.equal(m.clonePickCount(a.key), 1, "blank free-text does not count");
});

test("updateCloneButton: reflects the live count on the button + count span", () => {
  const m = loadCloneModule();
  const a = sampleAgent();
  m.setCache({ agents: [a] });
  const hid = m.hostId(a.key);
  const btn = { textContent: "", disabled: false, dataset: { off: "0" } };
  const cnt = { textContent: "" };
  m.els.set("clone-btn-" + hid, btn);
  m.els.set("clone-count-" + hid, cnt);
  m.clonePick(a.key, "github|me/alpha", true);  // clonePick calls updateCloneButton
  assert.equal(btn.textContent, "Clone");
  assert.equal(btn.disabled, false);
  assert.equal(cnt.textContent, "1 selected");
  m.clonePick(a.key, "github|me/beta", true);
  assert.equal(btn.textContent, "Clone 2");
  assert.equal(cnt.textContent, "2 selected");
  // Clearing all selections re-disables the button.
  m.clonePick(a.key, "github|me/alpha", false);
  m.clonePick(a.key, "github|me/beta", false);
  assert.equal(btn.disabled, true);
  assert.equal(cnt.textContent, "");
});

test("cloneRepo: fires one POST per selected repo plus the free-text box, then clears the draft", () => {
  const m = loadCloneModule();
  const a = sampleAgent();
  m.setCache({ agents: [a] });
  m.clonePick(a.key, "github|me/alpha", true);
  m.clonePick(a.key, "github|org/gamma", true);
  m.cloneText(a.key, "foo/bar");
  m.cloneRepo(a.key);
  assert.equal(m.posts.length, 3, "one clone POST per selection + free-text");
  assert.deepEqual(m.posts.map((p) => p.body.repo).sort(), ["foo/bar", "me/alpha", "org/gamma"]);
  // Picks carry the source of the listing they came from; free text stays
  // source-less (the legacy GitHub meaning).
  const bySrc = Object.fromEntries(m.posts.map((p) => [p.body.repo, p.body.source]));
  assert.equal(bySrc["me/alpha"], "github");
  assert.equal(bySrc["foo/bar"], undefined);
  assert.ok(m.posts.every((p) => p.url === "/api/agents/host1/clone"), "all hit the clone endpoint");
  assert.deepEqual(m.cloneDraft.get(a.key), {}, "draft cleared after cloning");
});

test("cloneRepo: no selection and empty box is a no-op", () => {
  const m = loadCloneModule();
  const a = sampleAgent();
  m.setCache({ agents: [a] });
  m.cloneRepo(a.key);
  assert.equal(m.posts.length, 0);
});

// Preserving an open clone-list's scroll across the poll's innerHTML swap moved
// out of index.html's bespoke captureCloneScroll into the shared
// TurmaNav.preserveScroll (XERK-35) — index.html's render() now wraps the
// #groups swap in it, and the id-anchored capture/restore contract (which is
// exactly this .clone-list-across-re-render case) is pinned in nav.test.js.

test("cloneBar: a host with no GitHub creds renders greyed out with no picker", () => {
  const m = loadCloneModule();
  const bare = { key: "h2", online: true, repos: [], github: { available: false } };
  m.setCache({ agents: [bare] });
  const collapsed = m.cloneBar(bare);
  assert.match(collapsed, /clone-bar collapsed disabled/, "greyed + collapsed by default");
  expand(m, bare.key);
  const html = m.cloneBar(bare);
  assert.match(html, /cloning unavailable/);
  assert.ok(!html.includes('type="checkbox"'), "no picker when creds are absent");
});

// --- XERK-155: multiple git sources ------------------------------------------

// A host reporting extra sources beside GitHub (the agent's gitSources block).
function multiSourceAgent() {
  const a = sampleAgent();
  a.gitSources = [
    { source: "azure", label: "dev.azure.com/xerk", available: true, user: "mal",
      repos: [{ name: "Api", nameWithOwner: "Proj/Api", isPrivate: true, source: "azure" }] },
    { source: "gitlab", label: "gitlab.example.com", available: true, user: null,
      repos: [{ name: "app", nameWithOwner: "grp/sub/app", isPrivate: true, source: "gitlab" }] },
  ];
  return a;
}

test("cloneSources: github block plus each gitSources entry, tagged by source", () => {
  const m = loadCloneModule();
  const srcs = m.cloneSources(multiSourceAgent());
  assert.deepEqual(srcs.map((s) => s.source), ["github", "azure", "gitlab"]);
  assert.ok(srcs[0].repos.every((r) => r.source === "github"));
  assert.equal(srcs[1].label, "dev.azure.com/xerk");
  // An agent predating gitSources still renders its github-only bar.
  const legacy = m.cloneSources(sampleAgent());
  assert.deepEqual(legacy.map((s) => s.source), ["github"]);
  // No creds at all: the github placeholder carries the unavailable state.
  const bare = m.cloneSources({ key: "h2", github: { available: false } });
  assert.equal(bare.length, 1);
  assert.equal(bare[0].available, false);
});

test("cloneBar: multiple sources render a generic label and per-source group headings", () => {
  const m = loadCloneModule();
  const a = multiSourceAgent();
  m.setCache({ agents: [a] });
  expand(m, a.key);
  const html = m.cloneBar(a);
  assert.match(html, /Clone a repo/, "generic header with several sources");
  assert.ok(!html.includes("Clone from GitHub"), "GitHub-only wording gone");
  assert.match(html, /clone-src/, "group headings present");
  assert.match(html, /dev\.azure\.com\/xerk/);
  assert.match(html, /gitlab\.example\.com/);
  assert.match(html, /Proj\/Api/);
  assert.match(html, /grp\/sub\/app/);
  assert.equal((html.match(/type="checkbox"/g) || []).length, 6, "4 github + 1 azure + 1 gitlab");
  // Picks are keyed source|nameWithOwner so the POST knows the listing.
  assert.match(html, /clonePick\('host1','azure\|Proj\/Api'/);
});

test("cloneBar: a single-source host keeps its flat list (no group headings)", () => {
  const m = loadCloneModule();
  const a = sampleAgent();
  m.setCache({ agents: [a] });
  expand(m, a.key);
  const html = m.cloneBar(a);
  assert.match(html, /Clone from GitHub/);
  assert.ok(!html.includes("clone-src"), "no headings for one source");
});

test("cloneRepo: an azure pick POSTs its source", () => {
  const m = loadCloneModule();
  const a = multiSourceAgent();
  m.setCache({ agents: [a] });
  m.clonePick(a.key, "azure|Proj/Api", true);
  m.cloneRepo(a.key);
  assert.equal(m.posts.length, 1);
  assert.deepEqual(m.posts[0].body, { repo: "Proj/Api", source: "azure" });
});

test("cloneBar: a single non-GitHub source names itself in the header (no 'Clone from GitHub')", () => {
  const m = loadCloneModule();
  const a = {
    key: "glhost", online: true, repos: [],
    github: { available: false, login: null, repos: [] },
    gitSources: [
      { source: "gitlab", label: "gitlab.example.com", available: true, user: null,
        repos: [{ name: "app", nameWithOwner: "grp/app", isPrivate: true, source: "gitlab" }] },
    ],
  };
  m.setCache({ agents: [a] });
  expand(m, a.key);
  const html = m.cloneBar(a);
  assert.match(html, /Clone from gitlab\.example\.com/, "header names the real source");
  assert.ok(!html.includes("Clone from GitHub"), "never claims GitHub");
  assert.ok(!html.includes("clone-src"), "single source keeps the flat list");
  // And when that lone source has no usable creds yet, the note names it too.
  a.gitSources[0].available = false;
  const off = m.cloneBar(a);
  assert.match(off, /No gitlab\.example\.com credentials on this host/);
});
