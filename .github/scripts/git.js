// The ONLY child_process in .github/scripts. Every git/gh shell-out lives here
// so the version/changes/changelog/manifest modules stay pure and unit-testable.
// This file is exercised for real only in CI (it needs a git checkout + gh auth);
// keep it thin — data-fetching wrappers, no business logic.

"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// execFileSync returns NULL — not "" — whenever stdout is redirected away
// (stdio: "ignore"), so a caller that shells out purely for the side effect and
// ignores the chatter must not have `.toString()` called on its result. Coerce
// here rather than at each call site: the throw is a TypeError, which any
// caller wrapping run() in a try/catch reads as "the command failed", turning a
// silenced-output bug into a plausible-looking empty answer.
function run(cmd, args, opts) {
  const out = execFileSync(cmd, args, Object.assign({ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, opts));
  return out === null ? "" : out.toString();
}

function git(args) {
  return run("git", args).replace(/\s+$/, "");
}

// All tags, one per line -> array. Includes legacy glasses-v*/android-v*/... tags.
function allTags() {
  const out = git(["tag", "-l"]);
  return out ? out.split("\n").filter(Boolean) : [];
}

// The highest existing v<M>.<m>.<p> tag (numeric semver), or "" if none. This is
// the previous unified release, used as the diff/changelog range start.
function previousReleaseTag(versionModule) {
  const V = versionModule;
  let best = null;
  let bestTag = "";
  for (const t of allTags()) {
    const p = V.parseTag(t);
    if (!p) continue; // ignores legacy-prefixed tags
    if (!best || V.compare(p, best) > 0) {
      best = p;
      bestTag = t;
    }
  }
  return bestTag;
}

// Does a ref resolve? Used to decide whether a rollup range start exists.
function tagExists(tag) {
  if (!tag) return false;
  try {
    git(["rev-parse", "--verify", "--quiet", `${tag}^{commit}`]);
    return true;
  } catch (_e) {
    return false;
  }
}

// Changed paths across a range (A..B) or a single commit's first-parent diff.
function diffPaths(range) {
  const out = git(["diff", "--name-only", range]);
  return out ? out.split("\n").filter(Boolean) : [];
}

// The commits that LANDED on main across a range, walking first parents only —
// each merge commit (PR merged via merge) and each squash/direct commit, without
// the internal commits a merge brought in as second parents. Newest first.
// Returns [{oid, subject, isMerge}].
function firstParentCommits(range) {
  if (!range) return [];
  const fmt = "%H%x1f%P%x1f%s";
  const out = git(["rev-list", "--first-parent", "--format=" + fmt, range]);
  const commits = [];
  for (const line of out.split("\n")) {
    // rev-list --format prefixes each commit with a "commit <hash>" line; skip those.
    if (!line || line.startsWith("commit ")) continue;
    const [oid, parents, subject] = line.split("\x1f");
    if (!oid) continue;
    const isMerge = (parents || "").trim().split(/\s+/).filter(Boolean).length > 1;
    commits.push({ oid, subject: subject || "", isMerge });
  }
  return commits;
}

// Changed paths a single landed commit introduced: first-parent diff for a merge
// (what the merge brought onto main), plain parent diff for a squash/direct one.
function commitPaths(commit) {
  const range = commit.isMerge ? `${commit.oid}^1..${commit.oid}` : `${commit.oid}^..${commit.oid}`;
  try {
    return diffPaths(range);
  } catch (_e) {
    // A root commit has no parent; treat as touching nothing rather than failing.
    return [];
  }
}

// Merged PRs against main as [{number, title, url, author, body, mergeCommitOid}].
// One `gh` call; the caller intersects mergeCommitOid with the range's commits.
function mergedPrs(limit) {
  const out = run("gh", [
    "pr",
    "list",
    "--state",
    "merged",
    "--base",
    "main",
    "--limit",
    String(limit || 200),
    "--json",
    "number,title,url,author,body,mergeCommit",
  ]);
  const arr = JSON.parse(out || "[]");
  return arr.map((p) => ({
    number: p.number,
    title: p.title,
    url: p.url,
    author: p.author && p.author.login,
    body: p.body || "",
    mergeCommitOid: p.mergeCommit && p.mergeCommit.oid,
  }));
}

// Download the manifest.json asset from a release tag; null if the release or the
// asset is absent (the first unified release, or a legacy tag).
function fetchManifest(tag) {
  if (!tag) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turma-manifest-"));
  try {
    run("gh", ["release", "download", tag, "--pattern", "manifest.json", "--dir", dir], { stdio: ["ignore", "ignore", "ignore"] });
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch (_e) {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Append key=value pairs to $GITHUB_OUTPUT (multiline-safe heredoc form).
function setOutputs(outputs) {
  const file = process.env.GITHUB_OUTPUT;
  const lines = [];
  for (const [k, v] of Object.entries(outputs)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (s.includes("\n")) {
      const delim = `__EOF_${k}__`;
      lines.push(`${k}<<${delim}`, s, delim);
    } else {
      lines.push(`${k}=${s}`);
    }
  }
  const text = lines.join("\n") + "\n";
  if (file) fs.appendFileSync(file, text);
  else process.stdout.write(text); // local dry-run
}

module.exports = {
  run,
  git,
  allTags,
  previousReleaseTag,
  tagExists,
  diffPaths,
  firstParentCommits,
  commitPaths,
  mergedPrs,
  fetchManifest,
  setOutputs,
};
