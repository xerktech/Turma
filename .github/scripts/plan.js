// `plan` job entrypoint: compute the version, tag and per-component build/carry
// matrix for this release, and write them to $GITHUB_OUTPUT for the downstream
// jobs' `if:` conditions. Read-only against the repo (it only reads tags + the
// diff) — that's what makes running on every merge safe. See release.yml.
//
// Env:
//   RELEASE_TYPE   patch | minor | major   (default patch)
//   FORCE_ALL      "true" forces every component to build
//   GITHUB_OUTPUT  written by setOutputs (falls back to stdout locally)

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const V = require("./version.js");
const changes = require("./changes.js");
const git = require("./git.js");

function main() {
  const releaseType = (process.env.RELEASE_TYPE || "patch").trim();
  const forceInput = String(process.env.FORCE_ALL || "").toLowerCase() === "true";

  const versionFile = path.join(process.cwd(), "VERSION");
  const baseRaw = V.parseBase(fs.readFileSync(versionFile, "utf8"));
  // For a minor/major the target line is the bumped base; the `bump` job commits
  // the new VERSION separately, but plan must compute against the target line so
  // nextPatch resets to 0 on it.
  const base = V.bumpBase(baseRaw, releaseType);

  const tags = git.allTags();
  const prevTag = git.previousReleaseTag(V);
  const patch = V.nextPatch(tags, base);
  const version = V.format({ major: base.major, minor: base.minor, patch });
  V.assertStrictlyGreatest({ major: base.major, minor: base.minor, patch }, tags);
  const androidVersionCode = V.androidVersionCode({ major: base.major, minor: base.minor, patch });

  // Force a full build on the first release (no prev tag), an explicit request,
  // or any minor/major (a carried component would ship a version that disagrees
  // with the release's — see RELEASING.md).
  const forceAll = forceInput || !prevTag || releaseType !== "patch";
  const diffPaths = prevTag ? git.diffPaths(`${prevTag}..HEAD`) : [];
  const changed = changes.detectChanges(diffPaths, { forceAll });

  git.setOutputs({
    version,
    tag: `v${version}`,
    prev_tag: prevTag,
    release_type: releaseType,
    base_major: base.major,
    base_minor: base.minor,
    android_version_code: androidVersionCode,
    changed: JSON.stringify(changed),
    force_all: forceAll,
    build_turma: changed.turma,
    build_agent_image: changed["agent-image"],
    build_agent_native: changed["agent-native"],
    build_glasses: changed.glasses,
    build_android: changed.android,
  });

  // Human-readable summary for the Actions run log / step summary.
  const lines = [
    `Release v${version} (${releaseType}), prev ${prevTag || "(none)"}`,
    ...changes.COMPONENTS.map((c) => `  ${c}: ${changed[c] ? "BUILD" : "carry"}`),
  ];
  process.stderr.write(lines.join("\n") + "\n");
}

main();
