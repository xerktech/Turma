// Compose git.js (raw data) + changes.js (path map) + changelog.buildEntries
// (pure) into the changelog entries for a range. Impure (git + gh); exercised in
// CI. Shared by publish.js (per-release notes) and changelog-cli.js (minor
// rollup) so both derive entries the same way.

"use strict";

const git = require("./git.js");
const changes = require("./changes.js");
const changelog = require("./changelog.js");

function collectEntries(range) {
  if (!range) return [];
  const commits = git.firstParentCommits(range);
  const prs = git.mergedPrs(200);
  const componentsByOid = {};
  for (const commit of commits) {
    const set = new Set();
    for (const p of git.commitPaths(commit)) {
      for (const comp of changes.componentsForPath(p)) set.add(comp);
    }
    componentsByOid[commit.oid] = Array.from(set);
  }
  return changelog.buildEntries({ commits, prs, componentsByOid });
}

module.exports = { collectEntries };
