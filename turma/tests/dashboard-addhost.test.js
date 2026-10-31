// The dashboard's Add host dialog (XERK-2531): mint a one-time enrollment code
// and show the copy-paste install/enroll commands. Loads the page's inline
// <script> under browser stubs (the dashboard-prune.test.js harness).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function loadDashboard() {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const g = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, get activeElement() { return null; },
      createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }),
      body: {}, title: "",
    },
    EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; },
    fetch: () => new Promise(() => {}),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    location: { pathname: "/", href: "", origin: "https://hub.example" },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    TurmaOrg: { get: () => "", filter: (a) => a || [], update() {}, subscribe() {}, sse() {} },
  };
  g.window = g; g.globalThis = g;
  const fn = new Function(
    "localStorage", "document", "window", "EventSource", "fetch",
    "setInterval", "clearInterval", "setTimeout", "clearTimeout", "location", "matchMedia", "TurmaOrg", "globalThis",
    src + "\n;globalThis.__dash = { addHostCommands, enrollCodeRowsHtml, addHostPanelHtml };",
  );
  fn(g.localStorage, g.document, g.window, g.EventSource, g.fetch,
     g.setInterval, g.clearInterval, g.setTimeout, g.clearTimeout, g.location, g.matchMedia, g.TurmaOrg, g);
  return g.__dash;
}

const dash = loadDashboard();
const CODE = "te-0123456789abcdef0123456789abcdef";

test("XERK-2531: the commands carry the hub URL and the code to every installer", () => {
  const c = dash.addHostCommands("https://hub.example", CODE);
  assert.match(c.linux, /bootstrap\.sh \| bash -s -- --url 'https:\/\/hub\.example' --enroll-code te-0123/);
  assert.match(c.windows, /bootstrap\.ps1\)\)\) -Url 'https:\/\/hub\.example' -EnrollCode te-0123/);
  assert.equal(c.existing, `turma-agentctl enroll --code ${CODE}`);
  // A quote in the origin can never break out of the single-quoted URL.
  assert.ok(!dash.addHostCommands("https://h'; rm -rf ~", CODE).linux.includes("h';"));
});

test("XERK-2531: the minted panel shows the commands; the form panel does not", () => {
  const now = 1_000_000;
  const minted = { code: CODE, enrollCode: { id: "a", device: "nas01", expiresAt: now + 15 * 60000 } };
  const html = dash.addHostPanelHtml({ open: true, codes: [], minted, device: "" }, "https://hub.example", now);
  assert.match(html, /--enroll-code te-0123/);
  assert.match(html, /<b>nas01<\/b>/);
  assert.match(html, /valid 15 min/);
  const form = dash.addHostPanelHtml({ open: true, codes: null, minted: null, device: "", error: "" }, "https://hub.example", now);
  assert.ok(!form.includes("--enroll-code"));
  assert.match(form, /Create code/);
  assert.match(form, /Loading/);
});

test("XERK-2531: the code list labels each state, escapes, and offers Revoke only on a live code", () => {
  const now = 10 * 3600000;
  const html = dash.enrollCodeRowsHtml([
    { id: "aaaa", state: "live", device: "<b>x</b>", owner: "local:op", expiresAt: now + 600000 },
    { id: "bbbb", state: "used", usedBy: "nas<1>", usedAt: now - 120000, owner: "oidc:sub" },
    { id: "cccc", state: "expired", owner: "local:op" },
  ], now);
  assert.match(html, /expires in 10 min/);
  assert.match(html, /used by nas&lt;1&gt; 2 min ago/);
  assert.match(html, /expired/);
  assert.ok(!html.includes("<b>x</b>"));
  assert.equal((html.match(/>Revoke</g) || []).length, 1);
  assert.match(dash.enrollCodeRowsHtml([], now), /No enrollment codes/);
});
