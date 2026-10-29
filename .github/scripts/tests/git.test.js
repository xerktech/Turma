"use strict";

// git.js is the only child_process module here and is otherwise exercised for
// real only in CI (it needs a git checkout + gh auth). These cases cover the one
// piece that is hermetic — run()'s handling of what execFileSync hands back —
// using `echo` rather than git/gh so they need neither.

const test = require("node:test");
const assert = require("node:assert/strict");
const git = require("../git.js");

test("run returns the command's stdout as a string", () => {
  assert.equal(git.run("echo", ["hello"]), "hello\n");
});

// The regression: execFileSync returns null (not "") when stdout is redirected
// away, so run() calling .toString() on it threw a TypeError. fetchManifest
// silences gh exactly this way and try/catches around it, so the throw was read
// as "this release has no manifest.json" and it returned null for EVERY tag.
// Nothing caught it because the first unified release force-builds every
// component and so never carries one — the first auto patch release would have
// been the first to ask, and publish.js would have failed the release with
// "component android is unchanged but absent from the previous manifest".
test("run returns '' rather than throwing when stdout is ignored", () => {
  assert.equal(git.run("echo", ["hello"], { stdio: ["ignore", "ignore", "ignore"] }), "");
});

test("run still throws when the command itself fails", () => {
  assert.throws(() => git.run("false", []));
});

test("branchedFromParentOf: only a sibling of the tagged commit", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-test-"));
  const cwd = process.cwd();
  t.after(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.chdir(dir);
  const g = (...a) => git.run("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  const commit = (m) => g("commit", "-q", "--allow-empty", "-m", m);
  g("init", "-q");
  commit("old"); // a pre-bump commit a stale re-run might plan
  g("tag", "old");
  commit("dispatched");
  g("tag", "-a", "-m", "annotated", "dispatched");
  commit("bump");
  g("tag", "-a", "-m", "release", "bump");
  g("checkout", "-q", "dispatched");
  commit("raced"); // a merge that landed during the release run
  g("tag", "raced");
  commit("later");
  assert.equal(git.branchedFromParentOf("bump", "raced"), true);
  assert.equal(git.branchedFromParentOf("bump", "old"), false); // stale re-run
  assert.equal(git.branchedFromParentOf("bump", "dispatched"), false); // stale re-run
  assert.equal(git.branchedFromParentOf("dispatched", "bump"), false); // tag is an ancestor
  assert.equal(git.branchedFromParentOf("bump", "HEAD"), true);
  assert.equal(git.branchedFromParentOf("old", "HEAD"), false); // tag on a root commit
  assert.throws(() => git.branchedFromParentOf("bump", "no-such-ref"));
});
