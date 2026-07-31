// Version math for the unified release pipeline (see .github/workflows/release.yml
// and RELEASING.md). Pure — no I/O, no child_process — so it's unit-tested in
// .github/scripts/tests/version.test.js and reused by plan.js/publish.js.
//
// The root VERSION file holds MAJOR.MINOR only; the PATCH is DERIVED from the
// existing v<M>.<m>.<p> git tags (max+1), never committed. Keeping the patch out
// of the repo is what makes "release on every merge" safe: the auto-patch path
// reads tags and never writes back, so it can't re-trigger itself.

"use strict";

// Android's versionCode is a single monotonic Int. Packing MAJOR/MINOR/PATCH
// into decimal digit fields keeps it human-readable in a Play/adb error AND
// strictly increasing in semver order — but only while each field stays inside
// its budget, so we ASSERT the budgets rather than documenting them. The bound
// MAJOR<2000 keeps the max (1_999_989_999) under Int's 2^31-1 (2_147_483_647).
const ANDROID_MAJOR_MAX = 2000; // exclusive
const ANDROID_MINOR_MAX = 100; // exclusive
const ANDROID_PATCH_MAX = 10000; // exclusive

// Parse the root VERSION file's MAJOR.MINOR. Rejects anything else so a stray
// edit fails the release loudly instead of computing a garbage version.
function parseBase(text) {
  const s = String(text).trim();
  const m = /^(\d+)\.(\d+)$/.exec(s);
  if (!m) throw new Error(`VERSION must be MAJOR.MINOR, got ${JSON.stringify(s)}`);
  return { major: Number(m[1]), minor: Number(m[2]) };
}

// Parse a full v<M>.<m>.<p> tag (or bare M.m.p). Returns null for anything that
// isn't one — legacy glasses-v*/android-v*/agent-native-v* tags parse to null
// here so nextPatch ignores them (but assertStrictlyGreatest still checks them).
function parseTag(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function format(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

// Numeric semver compare (NOT lexical — v0.3.10 > v0.3.9).
function compare(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

// The next patch for a given MAJOR.MINOR line: one past the highest existing
// v<M>.<m>.<p> tag on that line, or 0 if the line has no releases yet. Tags on
// other lines and all legacy-namespaced tags are ignored.
function nextPatch(tags, base) {
  let max = -1;
  for (const t of tags) {
    const p = parseTag(t);
    if (p && p.major === base.major && p.minor === base.minor) {
      if (p.patch > max) max = p.patch;
    }
  }
  return max + 1;
}

// Bump MAJOR.MINOR for a manual minor/major release. Patch resets to 0 by way
// of nextPatch finding no tags on the new line.
function bumpBase(base, type) {
  if (type === "major") return { major: base.major + 1, minor: 0 };
  if (type === "minor") return { major: base.major, minor: base.minor + 1 };
  return { major: base.major, minor: base.minor };
}

// Pack a version into an Android versionCode. Throws (red release) rather than
// silently wrapping if a field is out of budget.
function androidVersionCode(v) {
  if (!(v.major < ANDROID_MAJOR_MAX)) throw new Error(`MAJOR ${v.major} >= ${ANDROID_MAJOR_MAX}: versionCode would overflow Int`);
  if (!(v.minor < ANDROID_MINOR_MAX)) throw new Error(`MINOR ${v.minor} >= ${ANDROID_MINOR_MAX}: versionCode packing would collide`);
  if (!(v.patch < ANDROID_PATCH_MAX)) throw new Error(`PATCH ${v.patch} >= ${ANDROID_PATCH_MAX}: versionCode packing would collide`);
  return v.major * 1000000 + v.minor * 10000 + v.patch;
}

// The glasses guard: the new version MUST sort strictly above EVERY existing
// tag, including the legacy per-component namespaces (glasses-v0.2.32 etc.),
// because Even Hub / Android version their installs by content and a regression
// silently stops registering new builds. This is the assertion standing between
// a fat-fingered VERSION edit and a bricked release channel.
function assertStrictlyGreatest(version, allTags) {
  for (const t of allTags) {
    // Strip any known prefix down to the M.m.p core.
    const core = String(t).replace(/^(v|glasses-v|android-v|agent-native-v)/, "");
    const p = parseTag(core);
    if (p && compare(version, p) <= 0) {
      throw new Error(`computed version ${format(version)} is not greater than existing tag ${t}`);
    }
  }
  return version;
}

module.exports = {
  parseBase,
  parseTag,
  format,
  compare,
  nextPatch,
  bumpBase,
  androidVersionCode,
  assertStrictlyGreatest,
  ANDROID_MAJOR_MAX,
  ANDROID_MINOR_MAX,
  ANDROID_PATCH_MAX,
};
