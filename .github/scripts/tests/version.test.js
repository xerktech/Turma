// Unit tests for version.js (node:test, built-in — matches the repo's
// zero-npm-dependency stance). Run by code-scan.yml's tests job:
//   node --test .github/scripts/tests/*.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../version.js");

test("parseBase accepts MAJOR.MINOR, rejects everything else", () => {
  assert.deepEqual(V.parseBase("0.3"), { major: 0, minor: 3 });
  assert.deepEqual(V.parseBase(" 12.7\n"), { major: 12, minor: 7 });
  assert.throws(() => V.parseBase("0.3.1"));
  assert.throws(() => V.parseBase("0"));
  assert.throws(() => V.parseBase("x.y"));
  assert.throws(() => V.parseBase(""));
});

test("parseTag parses v-prefixed and bare triples, null otherwise", () => {
  assert.deepEqual(V.parseTag("v0.3.9"), { major: 0, minor: 3, patch: 9 });
  assert.deepEqual(V.parseTag("0.3.9"), { major: 0, minor: 3, patch: 9 });
  assert.equal(V.parseTag("glasses-v0.2.32"), null);
  assert.equal(V.parseTag("v0.3"), null);
  assert.equal(V.parseTag("nonsense"), null);
});

test("nextPatch: empty -> 0, max+1 on the matching line, numeric not lexical", () => {
  assert.equal(V.nextPatch([], { major: 0, minor: 3 }), 0);
  assert.equal(V.nextPatch(["v0.3.0", "v0.3.1"], { major: 0, minor: 3 }), 2);
  // numeric: v0.3.10 > v0.3.9 (lexical would pick 9 -> 10)
  assert.equal(V.nextPatch(["v0.3.9", "v0.3.10"], { major: 0, minor: 3 }), 11);
  // ignores other minor lines
  assert.equal(V.nextPatch(["v0.2.99", "v0.4.5"], { major: 0, minor: 3 }), 0);
  // ignores legacy per-component tags
  assert.equal(V.nextPatch(["glasses-v0.3.32", "android-v0.3.2"], { major: 0, minor: 3 }), 0);
  // ignores malformed
  assert.equal(V.nextPatch(["v0.3.x", "v0.3.2"], { major: 0, minor: 3 }), 3);
});

test("bumpBase resets the lower fields correctly", () => {
  assert.deepEqual(V.bumpBase({ major: 0, minor: 3 }, "patch"), { major: 0, minor: 3 });
  assert.deepEqual(V.bumpBase({ major: 0, minor: 3 }, "minor"), { major: 0, minor: 4 });
  assert.deepEqual(V.bumpBase({ major: 0, minor: 3 }, "major"), { major: 1, minor: 0 });
});

test("androidVersionCode packs readably and monotonically", () => {
  assert.equal(V.androidVersionCode({ major: 0, minor: 3, patch: 0 }), 30000);
  assert.equal(V.androidVersionCode({ major: 0, minor: 3, patch: 7 }), 30007);
  assert.equal(V.androidVersionCode({ major: 1, minor: 2, patch: 15 }), 1020015);
});

test("androidVersionCode is strictly increasing across a semver-sorted sweep", () => {
  const seq = [
    { major: 0, minor: 2, patch: 32 },
    { major: 0, minor: 3, patch: 0 },
    { major: 0, minor: 3, patch: 9999 },
    { major: 0, minor: 99, patch: 9999 },
    { major: 1, minor: 0, patch: 0 },
    { major: 1999, minor: 99, patch: 9999 },
  ];
  let prev = -1;
  for (const v of seq) {
    const code = V.androidVersionCode(v);
    assert.ok(code > prev, `${V.format(v)} -> ${code} must exceed prev ${prev}`);
    assert.ok(code <= 2147483647, `${code} must fit in Int`);
    prev = code;
  }
});

test("androidVersionCode throws at each field's budget, never wraps silently", () => {
  assert.throws(() => V.androidVersionCode({ major: 0, minor: 3, patch: 10000 }));
  assert.throws(() => V.androidVersionCode({ major: 0, minor: 100, patch: 0 }));
  assert.throws(() => V.androidVersionCode({ major: 2000, minor: 0, patch: 0 }));
});

test("assertStrictlyGreatest rejects a regression against legacy namespaces", () => {
  const legacy = ["glasses-v0.2.32", "android-v0.2.2", "agent-native-v0.2.3", "v0.3.0"];
  assert.doesNotThrow(() => V.assertStrictlyGreatest({ major: 0, minor: 3, patch: 1 }, legacy));
  // 0.3.0 already exists -> not strictly greater
  assert.throws(() => V.assertStrictlyGreatest({ major: 0, minor: 3, patch: 0 }, legacy));
  // 0.2.0 is below the published glasses 0.2.32 -> the bug the cutover avoids
  assert.throws(() => V.assertStrictlyGreatest({ major: 0, minor: 2, patch: 0 }, ["glasses-v0.2.32"]));
});
