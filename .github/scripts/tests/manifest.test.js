"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../manifest.js");

const ALL_CHANGED = {
  turma: true,
  "agent-native": true,
  "agent-windows": true,
  android: true,
};

function firstRelease() {
  return M.buildManifest({
    version: "0.3.0",
    tag: "v0.3.0",
    commit: "aaa",
    releasedAt: "2026-07-16T00:00:00Z",
    changed: ALL_CHANGED,
    prevManifest: null,
    androidVersionCode: 30000,
    owner: "xerktech",
  });
}

test("first release: every component fresh and built", () => {
  const m = firstRelease();
  assert.equal(m.schema, 1);
  assert.equal(m.components.turma.ref, "ghcr.io/xerktech/turma:0.3.0");
  assert.equal(m.components["agent-native"].asset, "turma-agent-native-v0.3.0.tar.gz");
  assert.equal(m.components["agent-native"].sha256_asset, "turma-agent-native-v0.3.0.tar.gz.sha256");
  assert.equal(m.components["agent-windows"].kind, "asset");
  assert.equal(m.components["agent-windows"].asset, "turma-agent-windows-v0.3.0.zip");
  assert.equal(m.components["agent-windows"].sha256_asset, "turma-agent-windows-v0.3.0.zip.sha256");
  assert.equal(m.components["agent-windows"].release_tag, "v0.3.0");
  assert.equal(m.components.android.asset, "turma-android-v0.3.0.apk");
  assert.equal(m.components.android.version_code, 30000);
  for (const c of Object.values(m.components)) assert.equal(c.built, true);
});

test("carried image keeps its OLDER version and ref; never retagged to the new version", () => {
  const prev = firstRelease();
  const m = M.buildManifest({
    version: "0.3.1",
    tag: "v0.3.1",
    commit: "bbb",
    releasedAt: "2026-07-17T00:00:00Z",
    changed: { turma: false, "agent-native": false, "agent-windows": false, android: true },
    prevManifest: prev,
    androidVersionCode: 30001,
  });
  assert.equal(m.components.android.built, true); // rebuilt
  assert.equal(m.components.turma.version, "0.3.0"); // carried, older
  assert.equal(m.components.turma.ref, "ghcr.io/xerktech/turma:0.3.0");
  assert.equal(m.components.turma.built, false);
});

test("carried asset keeps its name/version but re-points release_tag to the new release", () => {
  const prev = firstRelease();
  const m = M.buildManifest({
    version: "0.3.1",
    tag: "v0.3.1",
    commit: "bbb",
    releasedAt: "2026-07-17T00:00:00Z",
    changed: { turma: true, "agent-native": true, "agent-windows": true, android: false },
    prevManifest: prev,
    androidVersionCode: 30001,
  });
  const a = m.components.android;
  assert.equal(a.version, "0.3.0"); // still the build it actually is
  assert.equal(a.asset, "turma-android-v0.3.0.apk"); // name describes the bits
  assert.equal(a.release_tag, "v0.3.1"); // but it now also lives on this release
  assert.equal(a.built, false);
});

test("unchanged component absent from prev manifest throws (never emit a hole)", () => {
  const prev = firstRelease();
  delete prev.components.android;
  assert.throws(() =>
    M.buildManifest({
      version: "0.3.1",
      tag: "v0.3.1",
      commit: "bbb",
      releasedAt: "2026-07-17T00:00:00Z",
      changed: { turma: true, "agent-native": true, "agent-windows": true, android: false },
      prevManifest: prev,
      androidVersionCode: 30001,
    }),
  );
});

test("carryPlan emits copy-asset only for carried assets, not images or built ones", () => {
  const prev = firstRelease();
  const m = M.buildManifest({
    version: "0.3.1",
    tag: "v0.3.1",
    commit: "bbb",
    releasedAt: "2026-07-17T00:00:00Z",
    changed: { turma: true, "agent-native": false, "agent-windows": false, android: false },
    prevManifest: prev,
    androidVersionCode: 30001,
  });
  const plan = M.carryPlan(m, prev);
  const components = plan.map((a) => a.component).sort();
  // turma carried but it's an image -> no copy action. The three carried release ASSETS copy forward.
  assert.deepEqual(components, ["agent-native", "agent-windows", "android"]);
  const androidAction = plan.find((a) => a.component === "android");
  assert.deepEqual(androidAction, {
    component: "android",
    action: "copy-asset",
    asset: "turma-android-v0.3.0.apk",
    from_release: "v0.3.0",
    to_release: "v0.3.1",
  });
  const nativeAction = plan.find((a) => a.component === "agent-native");
  assert.equal(nativeAction.sha256_asset, "turma-agent-native-v0.3.0.tar.gz.sha256");
  // The Windows zip carries forward under its ORIGINAL name with its sha256
  // sidecar — the updater/bootstrap resolve a carried asset by that name.
  const winAction = plan.find((a) => a.component === "agent-windows");
  assert.deepEqual(winAction, {
    component: "agent-windows",
    action: "copy-asset",
    asset: "turma-agent-windows-v0.3.0.zip",
    from_release: "v0.3.0",
    to_release: "v0.3.1",
    sha256_asset: "turma-agent-windows-v0.3.0.zip.sha256",
  });
});

test("carried agent-windows keeps its zip name/version and re-points release_tag", () => {
  const prev = firstRelease();
  const m = M.buildManifest({
    version: "0.3.1",
    tag: "v0.3.1",
    commit: "bbb",
    releasedAt: "2026-07-17T00:00:00Z",
    changed: { turma: true, "agent-native": true, "agent-windows": false, android: true },
    prevManifest: prev,
    androidVersionCode: 30001,
  });
  const w = m.components["agent-windows"];
  assert.equal(w.version, "0.3.0"); // still the build it actually is
  assert.equal(w.asset, "turma-agent-windows-v0.3.0.zip"); // name describes the bits
  assert.equal(w.release_tag, "v0.3.1"); // but it now also lives on this release
  assert.equal(w.built, false);
});

test("newComponents flags a component absent from the previous manifest (introduction)", () => {
  const prev = firstRelease();
  delete prev.components["agent-windows"]; // a pre-Windows manifest
  assert.deepEqual(M.newComponents(["turma", "agent-native", "agent-windows"], prev), ["agent-windows"]);
  // A missing/unreadable manifest treats every component as new (force-build all).
  assert.deepEqual(M.newComponents(["turma", "agent-windows"], null), ["turma", "agent-windows"]);
  assert.deepEqual(M.newComponents(["turma"], { components: { turma: {} } }), []);
});

test("carryPlan is empty when everything was rebuilt", () => {
  const prev = firstRelease();
  const m = M.buildManifest({
    version: "0.3.1",
    tag: "v0.3.1",
    commit: "bbb",
    releasedAt: "2026-07-17T00:00:00Z",
    changed: ALL_CHANGED,
    prevManifest: prev,
    androidVersionCode: 30001,
  });
  assert.deepEqual(M.carryPlan(m, prev), []);
});
