// `publish` job entrypoint (runs last, after every targeted build succeeded).
// Builds manifest.json, renders the GitHub Release notes, and emits the
// carry-asset plan. Writes files into the working dir; the workflow attaches
// them and creates the tag/release. See release.yml.
//
// Env (from needs.plan.outputs):
//   VERSION_FULL, TAG, PREV_TAG, CHANGED (json), ANDROID_VERSION_CODE,
//   COMMIT, RELEASED_AT, OUT_DIR (default cwd)

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const manifestMod = require("./manifest.js");
const changelog = require("./changelog.js");
const { collectEntries } = require("./collect.js");
const git = require("./git.js");

function main() {
  const version = process.env.VERSION_FULL;
  const tag = process.env.TAG;
  const prevTag = process.env.PREV_TAG || "";
  const changed = JSON.parse(process.env.CHANGED || "{}");
  const androidVersionCode = Number(process.env.ANDROID_VERSION_CODE || "0");
  const commit = process.env.COMMIT || "";
  const releasedAt = process.env.RELEASED_AT || "";
  const outDir = process.env.OUT_DIR || process.cwd();

  const prevManifest = git.fetchManifest(prevTag);
  const manifest = manifestMod.buildManifest({
    version,
    tag,
    commit,
    releasedAt,
    changed,
    prevManifest,
    androidVersionCode,
  });

  const entries = collectEntries(prevTag ? `${prevTag}..HEAD` : "");
  const groups = changelog.groupByComponent(entries);
  const notes = changelog.renderReleaseNotes({ version, groups, manifest });
  const carry = manifestMod.carryPlan(manifest, prevManifest || { tag: prevTag });

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "release-notes.md"), notes);
  fs.writeFileSync(path.join(outDir, "carry-plan.json"), JSON.stringify(carry, null, 2) + "\n");

  git.setOutputs({ carry: JSON.stringify(carry), has_carry: carry.length > 0 });
  process.stderr.write(`Wrote manifest.json, release-notes.md, carry-plan.json (${carry.length} carried assets)\n`);
}

main();
