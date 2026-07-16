"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../manifest.js");

const ALL_CHANGED = {
  turma: true,
  "agent-image": true,
  "agent-native": true,
  glasses: true,
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
  assert.equal(m.components["agent-image"].ref, "ghcr.io/xerktech/turma-agent:0.3.0");
  assert.equal(m.components["agent-native"].asset, "turma-agent-native-v0.3.0.tar.gz");
  assert.equal(m.components["agent-native"].sha256_asset, "turma-agent-native-v0.3.0.tar.gz.sha256");
  assert.equal(m.components.glasses.asset, "turma-hud-v0.3.0.ehpk");
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
    changed: { turma: true, "agent-image": false, "agent-native": false, glasses: false, android: false },
    prevManifest: prev,
    androidVersionCode: 30001,
  });
  assert.equal(m.components.turma.version, "0.3.1"); // rebuilt
  assert.equal(m.components.turma.built, true);
  assert.equal(m.components["agent-image"].version, "0.3.0"); // carried, older
  assert.equal(m.components["agent-image"].ref, "ghcr.io/xerktech/turma-agent:0.3.0");
  assert.equal(m.components["agent-image"].built, false);
});

test("carried asset keeps its name/version but re-points release_tag to the new release", () => {
  const prev = firstRelease();
  const m = M.buildManifest({
    version: "0.3.1",
    tag: "v0.3.1",
    commit: "bbb",
    releasedAt: "2026-07-17T00:00:00Z",
    changed: { turma: true, "agent-image": true, "agent-native": true, glasses: false, android: false },
    prevManifest: prev,
    androidVersionCode: 30001,
  });
  const g = m.components.glasses;
  assert.equal(g.version, "0.3.0"); // still the build it actually is
  assert.equal(g.asset, "turma-hud-v0.3.0.ehpk"); // name describes the bits
  assert.equal(g.release_tag, "v0.3.1"); // but it now also lives on this release
  assert.equal(g.built, false);
});

test("unchanged component absent from prev manifest throws (never emit a hole)", () => {
  const prev = firstRelease();
  delete prev.components.glasses;
  assert.throws(() =>
    M.buildManifest({
      version: "0.3.1",
      tag: "v0.3.1",
      commit: "bbb",
      releasedAt: "2026-07-17T00:00:00Z",
      changed: { turma: true, "agent-image": true, "agent-native": true, glasses: false, android: true },
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
    changed: { turma: true, "agent-image": false, "agent-native": false, glasses: false, android: false },
    prevManifest: prev,
    androidVersionCode: 30001,
  });
  const plan = M.carryPlan(m, prev);
  const components = plan.map((a) => a.component).sort();
  // agent-image carried but it's an image -> no copy action. native/glasses/android are carried assets.
  assert.deepEqual(components, ["agent-native", "android", "glasses"]);
  const glassesAction = plan.find((a) => a.component === "glasses");
  assert.deepEqual(glassesAction, {
    component: "glasses",
    action: "copy-asset",
    asset: "turma-hud-v0.3.0.ehpk",
    from_release: "v0.3.0",
    to_release: "v0.3.1",
  });
  const nativeAction = plan.find((a) => a.component === "agent-native");
  assert.equal(nativeAction.sha256_asset, "turma-agent-native-v0.3.0.tar.gz.sha256");
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
