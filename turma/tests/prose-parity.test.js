// The web ⇄ Android prose parity fixture (XERK-2140) — see prose-parity.js.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { renderProse } = require("../public/chat.js");
const { buildFixture, serialize, canonWeb, FIXTURE } = require("./prose-parity.js");

test("prose parity: the committed fixture is what chat.js renders today", () => {
  // Fails after any renderProse change until the fixture is regenerated — and the
  // regenerated fixture is what android's ProseParityTest then holds Prose.kt to.
  const want = serialize(buildFixture());
  const have = fs.readFileSync(FIXTURE, "utf8");
  assert.ok(have === want, "android/app/src/test/resources/prose-parity.json is stale: " +
    "run `node turma/tests/prose-parity.js` and commit it (then make Prose.kt agree)");
});

test("prose parity: the web reader recovers each construct's tree", () => {
  const c = (s) => canonWeb(renderProse(s));
  assert.deepEqual(c("# T\n\nx **b** ***bi*** *i* ~~s~~ `c` https://a.b/c [l](https://u.v) ![a](https://i.j)"), [
    ["h", 1, ["T"]],
    ["p", ["x ", ["s", "b", ["b"]], " ", ["s", "bi", ["bi"]], " ", ["s", "i", ["i"]], " ", ["s", "x", ["s"]], " ",
      ["c", "c"], " ", ["a", "https://a.b/c", "https://a.b/c"], " ", ["a", "l", "https://u.v"], " ",
      ["img", "a", "https://i.j"]]],
  ]);
  // Bold holding italic stays two levels; only the `***` pairing folds to "bi".
  assert.deepEqual(c("**a *b* c**"), [["p", [["s", "b", ["a ", ["s", "i", ["b"]], " c"]]]]]);
  // Nested and ordered lists flatten to rows; numbering continues from `start`;
  // a marker switch (two web lists) is ONE canonical list, as on Android.
  assert.deepEqual(c("- a\n  3. x\n  4. y\n- b\n1. z"), [["list", [
    [0, "•", ["a"]], [1, "3.", ["x"]], [1, "4.", ["y"]], [0, "•", ["b"]], [0, "1.", ["z"]]]]]);
  assert.deepEqual(c("| a | b |\n|:-:|--:|\n| `1` |"), [["table", [["a"], ["b"]], ["center", "right"], [[[["c", "1"]], []]]]]);
  assert.deepEqual(c("```js\nx <y>\n```\n> q\n> > n\n---"), [
    ["code", "js", "x <y>"], ["q", [["p", ["q"]], ["q", [["p", ["n"]]]]]], ["hr"]]);
  // The boundary newline the web keeps beside a raw SVG block is folded away.
  assert.deepEqual(c("t\n\n<svg a=\"&\"><g/></svg>\nm"), [["p", ["t\n"]], ["svg", "<svg a=\"&\"><g/></svg>"], ["p", ["m"]]]);
});
