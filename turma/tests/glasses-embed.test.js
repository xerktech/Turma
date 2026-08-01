// Unit tests for the glasses phone-companion bridge (public/glasses-embed.js) —
// the web half of the Even phone app link (XERK-171). Only the pure decision
// half is exercised here (the imperative half needs a live iframe + parent);
// its plugin-side counterpart is glasses/src/phone-bridge.test.ts. node:test,
// no npm, the dual-export pattern nav.test.js/org.test.js use.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const GE = require("../public/glasses-embed.js");

test("glasses-embed: isEmbedded only on ?embed=glasses", () => {
  assert.equal(GE.isEmbedded("?embed=glasses"), true);
  assert.equal(GE.isEmbedded("?foo=1&embed=glasses"), true);
  assert.equal(GE.isEmbedded("?embed=other"), false);
  assert.equal(GE.isEmbedded(""), false);
  assert.equal(GE.isEmbedded(null), false);
});

test("glasses-embed: planIncoming opens in-place when the page has a session view", () => {
  const plan = GE.planIncoming({ source: "turma-host", type: "enter-session", id: "s1" }, null, true);
  assert.deepEqual(plan, { action: "open", id: "s1" });
});

test("glasses-embed: planIncoming navigates (deep-link) when there is no in-page opener (board)", () => {
  const plan = GE.planIncoming({ source: "turma-host", type: "enter-session", id: "s1" }, null, false);
  assert.deepEqual(plan, { action: "navigate", id: "s1" });
});

test("glasses-embed: planIncoming ignores an enter for the session already on screen (anti-echo)", () => {
  const plan = GE.planIncoming({ source: "turma-host", type: "enter-session", id: "s1" }, "s1", true);
  assert.deepEqual(plan, { action: "ignore" });
});

test("glasses-embed: planIncoming ignores foreign, malformed, or id-less messages", () => {
  const cur = "sX", opener = true;
  assert.deepEqual(GE.planIncoming(null, cur, opener), { action: "ignore" });
  assert.deepEqual(GE.planIncoming({ source: "turma-embed", type: "enter-session", id: "s1" }, cur, opener), { action: "ignore" });
  assert.deepEqual(GE.planIncoming({ source: "turma-host", type: "org", key: "x" }, cur, opener), { action: "ignore" });
  assert.deepEqual(GE.planIncoming({ source: "turma-host", type: "enter-session" }, cur, opener), { action: "ignore" });
});

test("glasses-embed: navigateHref stays embedded and deep-links the session", () => {
  assert.equal(GE.navigateHref("s 1/x"), "/sessions?embed=glasses&session=s%201%2Fx");
});
