// The path -> component map: the SINGLE source of truth for which components a
// set of changed files touches. Used by BOTH change-detection (which components
// to build vs carry) and changelog grouping (which heading a PR lands under), so
// the build matrix and the changelog can never disagree about what a change is.
// Pure — unit-tested in .github/scripts/tests/changes.test.js.

"use strict";

// The four release components. `agent/**` maps only to agent-native — the agent
// no longer ships a container image; native is the sole agent distribution.
const COMPONENTS = ["turma", "agent-native", "glasses", "android"];

// Ordered longest-prefix-first isn't needed here since the prefixes are
// disjoint top-level dirs, but keep the mapping explicit rather than derived.
const PREFIX_MAP = [
  { prefix: "turma/", components: ["turma"] },
  { prefix: "agent/", components: ["agent-native"] },
  { prefix: "glasses/", components: ["glasses"] },
  { prefix: "android/", components: ["android"] },
];

// Sub-paths under a component prefix that never reach that component's SHIPPED
// artifact — its test suite and operator tooling. A change confined to these
// touches no component: it builds nothing and lands under "Other" in the
// changelog. The turma image COPYs only server.js/archive.js/tar.js/push.js/
// usage-ledger.js/public/ (turma/tests, turma/tools stay out); the native
// tarball cp's a curated list that excludes agent/tests; the .ehpk packs from
// dist (not glasses/tests); the .apk is built from app/src/main (not
// app/src/test). Checked longest-match FIRST, so an exclude always wins over the
// bare prefix that contains it.
//
// XERK-426: mapping the bare `turma/` prefix meant a test-only turma/ merge
// rebuilt AND — since XERK-425 — REDEPLOYED a runtime-identical hub, which
// `Recreate`+`replicas: 1` pays for by dropping every tunnel/SSE/terminal
// channel. release.yml's `push:` filter mirrors these as `!`-negation globs so
// such a merge starts no release at all; the parity test asserts the mirror.
const EXCLUDE_PREFIXES = [
  "turma/tests/",
  "turma/tools/",
  "agent/tests/",
  "glasses/tests/",
  "android/app/src/test/",
];

// Which components a single changed path touches. A path under an EXCLUDE_PREFIX
// (a component's tests/tooling), or matching no component prefix at all
// (VERSION, CHANGELOG.md, .github/**, README.md, CLAUDE.md, ...), returns [] and
// is surfaced as "Other" in the changelog — never dropped, never a build.
function componentsForPath(p) {
  const s = String(p).replace(/^\.?\/+/, "");
  for (const ex of EXCLUDE_PREFIXES) {
    if (s.startsWith(ex)) return [];
  }
  for (const { prefix, components } of PREFIX_MAP) {
    if (s.startsWith(prefix)) return components.slice();
  }
  return [];
}

// Map a list of changed paths to a {component: bool} record over ALL components.
// forceAll (first release, minor/major, or the explicit dispatch input) marks
// everything changed regardless of the diff.
function detectChanges(paths, opts) {
  const forceAll = !!(opts && opts.forceAll);
  const changed = {};
  for (const c of COMPONENTS) changed[c] = forceAll;
  if (forceAll) return changed;
  for (const p of paths) {
    for (const c of componentsForPath(p)) changed[c] = true;
  }
  return changed;
}

// The distinct source dirs a component can live under. release.yml's push:main
// filter has to restate these as globs (a trigger can't call into JS); this is
// what its test asserts against, so the two can't drift apart silently.
function componentPrefixes() {
  return PREFIX_MAP.map(({ prefix }) => prefix);
}

// The sub-paths carved back OUT of the component dirs (tests + tooling that
// never ships). release.yml's push:main filter restates these as `!`-negation
// globs following the component-dir globs, so a merge confined to them starts no
// release; the parity test in tests/changes.test.js asserts the two agree.
function componentExcludes() {
  return EXCLUDE_PREFIXES.slice();
}

module.exports = {
  COMPONENTS,
  componentsForPath,
  detectChanges,
  componentPrefixes,
  componentExcludes,
};
