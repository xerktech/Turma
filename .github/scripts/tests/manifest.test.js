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
  assert.equal(m.components.glasses.kind, "evenhub");
  assert.equal(m.components.glasses.package_id, "com.xerktech.turma");
  assert.equal(m.components.glasses.asset, undefined); // the portal is the channel, not a release asset
  assert.equal(m.components.android.asset, "turma-android-v0.3.0.apk");
  assert.equal(m.components.android.version_code, 30000);
  for (const c of Object.values(m.components)) assert.equal(c.built, true);
});

test("glasses package_id is overridable (EVENHUB_PACKAGE_ID repo variable path)", () => {
  const c = M.freshComponent("glasses", "0.3.0", "v0.3.0", { glassesPackageId: "com.xerktech.turma.beta" });
  assert.equal(c.package_id, "com.xerktech.turma.beta");
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
    changed: { turma: true, "agent-image": true, "agent-native": true, glasses: true, android: false },
    prevManifest: prev,
    androidVersionCode: 30001,
  });
  const a = m.components.android;
  assert.equal(a.version, "0.3.0"); // still the build it actually is
  assert.equal(a.asset, "turma-android-v0.3.0.apk"); // name describes the bits
  assert.equal(a.release_tag, "v0.3.1"); // but it now also lives on this release
  assert.equal(a.built, false);
});

test("carried glasses keeps its older version on the portal; nothing to copy", () => {
  const prev = firstRelease();
  const m = M.buildManifest({
    version: "0.3.1",
    tag: "v0.3.1",
    commit: "bbb",
    releasedAt: "2026-07-17T00:00:00Z",
    changed: { turma: true, "agent-image": true, "agent-native": true, glasses: false, android: true },
    prevManifest: prev,
    androidVersionCode: 30001,
  });
  const g = m.components.glasses;
  assert.equal(g.version, "0.3.0");
  assert.equal(g.kind, "evenhub");
  assert.equal(g.built, false);
  assert.deepEqual(M.carryPlan(m, prev), []); // the portal already holds 0.3.0
});

test("carried glasses from a pre-portal (asset-kind) manifest is normalized to evenhub", () => {
  // Manifests older than the portal pipeline shipped the .ehpk as a release
  // asset; carrying one must NOT re-emit the asset entry (nothing copies the
  // file forward anymore) — it becomes an evenhub reference at its old version.
  const prev = firstRelease();
  prev.components.glasses = {
    version: "0.3.0",
    kind: "asset",
    asset: "turma-hud-v0.3.0.ehpk",
    release_tag: "v0.3.0",
    built: true,
  };
  const m = M.buildManifest({
    version: "0.3.1",
    tag: "v0.3.1",
    commit: "bbb",
    releasedAt: "2026-07-17T00:00:00Z",
    changed: { turma: true, "agent-image": true, "agent-native": true, glasses: false, android: true },
    prevManifest: prev,
    androidVersionCode: 30001,
  });
  const g = m.components.glasses;
  assert.deepEqual(g, { version: "0.3.0", kind: "evenhub", package_id: "com.xerktech.turma", built: false });
  assert.deepEqual(M.carryPlan(m, prev), []);
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
  // agent-image carried but it's an image, glasses lives on the Even Hub portal
  // -> no copy action for either. native/android are the carried release assets.
  assert.deepEqual(components, ["agent-native", "android"]);
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
