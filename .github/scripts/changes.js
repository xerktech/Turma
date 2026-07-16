// The path -> component map: the SINGLE source of truth for which components a
// set of changed files touches. Used by BOTH change-detection (which components
// to build vs carry) and changelog grouping (which heading a PR lands under), so
// the build matrix and the changelog can never disagree about what a change is.
// Pure — unit-tested in .github/scripts/tests/changes.test.js.

"use strict";

// The five release components. `agent/**` fans out to BOTH agent-image and
// agent-native on purpose: the image build context is ./agent with no
// .dockerignore, so agent/native/** genuinely IS in the image context and a
// native-only change really does change the image. Over-building a native-only
// change wastes runner time; under-building ships a manifest that lies. We take
// the former.
const COMPONENTS = ["turma", "agent-image", "agent-native", "glasses", "android"];

// Ordered longest-prefix-first isn't needed here since the prefixes are
// disjoint top-level dirs, but keep the mapping explicit rather than derived.
const PREFIX_MAP = [
  { prefix: "turma/", components: ["turma"] },
  { prefix: "agent/", components: ["agent-image", "agent-native"] },
  { prefix: "glasses/", components: ["glasses"] },
  { prefix: "android/", components: ["android"] },
];

// Which components a single changed path touches. Anything matching no prefix
// (VERSION, CHANGELOG.md, .github/**, README.md, CLAUDE.md, ...) returns [] and
// is surfaced as "Other" in the changelog — never dropped, never a build.
function componentsForPath(p) {
  const s = String(p).replace(/^\.?\/+/, "");
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

module.exports = { COMPONENTS, componentsForPath, detectChanges };
