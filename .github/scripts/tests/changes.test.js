"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../changes.js");

test("componentsForPath maps top-level dirs; agent/** maps to agent-native", () => {
  assert.deepEqual(C.componentsForPath("turma/server.js"), ["turma"]);
  assert.deepEqual(C.componentsForPath("agent/hub-agent.py"), ["agent-native"]);
  assert.deepEqual(C.componentsForPath("agent/native/install.sh"), ["agent-native"]);
  assert.deepEqual(C.componentsForPath("glasses/src/app.ts"), ["glasses"]);
  assert.deepEqual(C.componentsForPath("android/app/build.gradle.kts"), ["android"]);
});

test("componentsForPath returns [] for non-component paths (-> Other, never a build)", () => {
  assert.deepEqual(C.componentsForPath("VERSION"), []);
  assert.deepEqual(C.componentsForPath("CHANGELOG.md"), []);
  assert.deepEqual(C.componentsForPath(".github/workflows/release.yml"), []);
  assert.deepEqual(C.componentsForPath("CLAUDE.md"), []);
  assert.deepEqual(C.componentsForPath("./README.md"), []);
});

test("componentsForPath excludes a component's non-shipped tests/tooling (XERK-426)", () => {
  // Under an EXCLUDE_PREFIX -> [] even though it sits under a component dir.
  assert.deepEqual(C.componentsForPath("turma/tests/server.test.js"), []);
  assert.deepEqual(C.componentsForPath("turma/tools/recover-usage-from-archive.js"), []);
  assert.deepEqual(C.componentsForPath("agent/tests/hub_agent_test.py"), []);
  assert.deepEqual(C.componentsForPath("glasses/tests/mock-hub.mjs"), []);
  assert.deepEqual(C.componentsForPath("android/app/src/test/AppTest.kt"), []);
  assert.deepEqual(C.componentsForPath("./turma/tests/server.test.js"), []);
  // The shipped siblings still map to their component — the exclude is scoped.
  assert.deepEqual(C.componentsForPath("turma/server.js"), ["turma"]);
  assert.deepEqual(C.componentsForPath("turma/public/board.js"), ["turma"]);
  assert.deepEqual(C.componentsForPath("agent/hub-agent.py"), ["agent-native"]);
  assert.deepEqual(C.componentsForPath("glasses/src/app.ts"), ["glasses"]);
  assert.deepEqual(C.componentsForPath("android/app/src/main/Main.kt"), ["android"]);
});

test("detectChanges: a test-only turma merge builds nothing", () => {
  const changed = C.detectChanges(["turma/tests/server.test.js"], {});
  for (const c of C.COMPONENTS) assert.equal(changed[c], false);
});

test("detectChanges: tests + a shipped file still builds the component", () => {
  const changed = C.detectChanges(
    ["turma/tests/server.test.js", "turma/server.js"],
    {},
  );
  assert.equal(changed.turma, true);
});

test("componentExcludes lists the non-shipped sub-paths, each under a component prefix", () => {
  const excludes = C.componentExcludes();
  const prefixes = C.componentPrefixes();
  assert.ok(excludes.length > 0);
  for (const ex of excludes) {
    assert.ok(
      prefixes.some((p) => ex.startsWith(p)),
      `${ex} must sit under a component prefix`,
    );
    assert.ok(ex.endsWith("/"), `${ex} must be a dir prefix`);
  }
});

test("detectChanges unions components across the diff", () => {
  const changed = C.detectChanges(["turma/server.js", "android/x.kt", "CLAUDE.md"], {});
  assert.deepEqual(changed, {
    turma: true,
    "agent-native": false,
    glasses: false,
    android: true,
  });
});

test("detectChanges forceAll marks every component regardless of paths", () => {
  const changed = C.detectChanges([], { forceAll: true });
  for (const c of C.COMPONENTS) assert.equal(changed[c], true);
});

test("detectChanges with no matching paths builds nothing", () => {
  const changed = C.detectChanges(["VERSION", "CHANGELOG.md"], {});
  for (const c of C.COMPONENTS) assert.equal(changed[c], false);
});

// release.yml's `push:` filter has to restate PREFIX_MAP's prefixes as globs,
// because a workflow trigger can't call into JS — the gate that decides whether
// a merge starts a release at all is the one part of the path->component map
// that lives outside this file. Drift is silent and one-directional: a component
// dir added here but not there just never auto-releases, which looks exactly
// like the release pipeline working fine until someone checks the tags.
//
// The filter has two halves that must BOTH stay in step (XERK-426): the
// component-dir globs mirror componentPrefixes(), and the `!`-negation globs
// that carve tests/tooling back out mirror componentExcludes() — a merge
// confined to the excluded sub-paths must start no release, or it rebuilds and
// redeploys a runtime-identical hub.
test("release.yml's push paths mirror PREFIX_MAP and EXCLUDE_PREFIXES", () => {
  const yml = fs.readFileSync(
    path.join(__dirname, "..", "..", "workflows", "release.yml"),
    "utf8",
  );
  // The paths: block may carry 6-space comment lines between the globs.
  const block = yml.match(
    /\n {2}push:\n {4}branches: \[main\]\n {4}paths:\n((?: {6}(?:#.*|- ".*")\n)+)/,
  );
  assert.ok(block, "release.yml has no push:main paths: block in the expected shape");

  const globs = [...block[1].matchAll(/- "(.*)"/g)].map((m) => m[1]);
  const includes = globs.filter((g) => !g.startsWith("!"));
  const excludes = globs.filter((g) => g.startsWith("!"));

  const expectedIncludes = C.componentPrefixes().map((p) => `${p}**`);
  const expectedExcludes = C.componentExcludes().map((p) => `!${p}**`);
  assert.deepEqual(includes.slice().sort(), expectedIncludes.slice().sort());
  assert.deepEqual(excludes.slice().sort(), expectedExcludes.slice().sort());

  // GitHub Actions evaluates paths in order and a later pattern overrides an
  // earlier one, so every negation must FOLLOW every positive it carves from.
  // globs[] is in document order, so the last include must precede the first
  // exclude.
  const lastIncludeIdx = globs.map((g) => !g.startsWith("!")).lastIndexOf(true);
  const firstExcludeIdx = globs.findIndex((g) => g.startsWith("!"));
  assert.ok(
    lastIncludeIdx < firstExcludeIdx,
    "every `!`-negation must come after the component-dir globs",
  );
});
