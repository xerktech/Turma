"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../changes.js");

test("componentsForPath maps top-level dirs; agent/** fans out to both agent components", () => {
  assert.deepEqual(C.componentsForPath("turma/server.js"), ["turma"]);
  assert.deepEqual(C.componentsForPath("agent/hub-agent.py"), ["agent-image", "agent-native"]);
  // a native-only change still fans to the image: ./agent is the build context, no .dockerignore
  assert.deepEqual(C.componentsForPath("agent/native/install.sh"), ["agent-image", "agent-native"]);
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

test("detectChanges unions components across the diff", () => {
  const changed = C.detectChanges(["turma/server.js", "android/x.kt", "CLAUDE.md"], {});
  assert.deepEqual(changed, {
    turma: true,
    "agent-image": false,
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
