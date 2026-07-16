// `bump` job helper (minor/major only): roll up every patch since the last minor
// into a new CHANGELOG.md section, in place. The workflow commits VERSION +
// CHANGELOG.md together before any build runs. See release.yml / RELEASING.md.
//
// Env:
//   NEW_VERSION     the bumped version, e.g. "0.4.0" (the section heading)
//   BASE_MAJOR      pre-bump MAJOR (start of the line being closed)
//   BASE_MINOR      pre-bump MINOR
//   DATE            YYYY-MM-DD (passed in so the render is deterministic/testable)
//   CHANGELOG_PATH  default ./CHANGELOG.md

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const changelog = require("./changelog.js");
const { collectEntries } = require("./collect.js");
const git = require("./git.js");

const DEFAULT_MD = `# Changelog

Patch releases are auto-cut on every merge and listed on the [Releases page](../../releases).
This file rolls up each **minor** release — the changes since the previous minor.

${changelog.CHANGELOG_MARKER}
`;

function main() {
  const newVersion = process.env.NEW_VERSION;
  const baseMajor = process.env.BASE_MAJOR;
  const baseMinor = process.env.BASE_MINOR;
  const date = process.env.DATE;
  const file = process.env.CHANGELOG_PATH || path.join(process.cwd(), "CHANGELOG.md");

  // The line being closed started at v<major>.<minor>.0; roll up everything
  // since. If that tag doesn't exist (shouldn't, but be safe), fall back to an
  // empty range rather than failing the release.
  const startTag = `v${baseMajor}.${baseMinor}.0`;
  const range = git.tagExists(startTag) ? `${startTag}..HEAD` : "";
  const entries = collectEntries(range);
  const groups = changelog.groupByComponent(entries);
  const section = changelog.renderChangelogSection({ version: newVersion, date, groups });

  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : DEFAULT_MD;
  fs.writeFileSync(file, changelog.insertSection(existing, section));
  process.stderr.write(`Updated ${file} with the ${newVersion} rollup (${entries.length} entries since ${startTag})\n`);
}

main();
