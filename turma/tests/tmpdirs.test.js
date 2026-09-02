// Guard: every suite's throwaway scratch directory must self-clean (XERK-423).
//
// The suites used to `fs.mkdtempSync(path.join(os.tmpdir(), ...))` an ARCHIVE_DIR
// / MIGRATE_SPOOL_DIR and never remove it. CI throws its runner away so it never
// noticed, but an agent host runs the suite over and over on the SAME box and had
// accreted 1,640 turma-test-archive-* trees on a tmpfs (in RAM). `./tmpdirs`'s
// `mkdtemp()` is the fix: it records each dir and removes the set on process exit.
//
// This asserts nobody reaches back around it. A new test that reintroduces the raw
// call leaks silently — no assertion catches a stray directory — so the ceiling is
// enforced statically here instead. NOTE: most of these files embed NUL bytes
// (binary fixtures), which makes `grep` treat them as binary and skip the match —
// which is exactly how the original scan for this bug missed registry-cap.test.js.
// Read them with fs, never shell out to grep.
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

// The one place the raw call is allowed to live.
const HELPER = "tmpdirs.js";

test("no test suite mkdtemps under os.tmpdir() without the self-cleaning helper", () => {
  const dir = __dirname;
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".test.js")) continue;
    if (name === HELPER || name === path.basename(__filename)) continue;
    const src = fs.readFileSync(path.join(dir, name), "utf8");
    // A raw mkdtempSync rooted at os.tmpdir() is the leak shape. `mkdtemp("...")`
    // (this repo's helper) and a mkdtempSync UNDER an already-tracked dir are fine.
    if (/mkdtempSync\(\s*path\.join\(\s*os\.tmpdir\(\)/.test(src)) {
      offenders.push(name);
    }
  }
  assert.deepEqual(
    offenders, [],
    `these suites mkdtemp under os.tmpdir() directly and leak the tree on every run — ` +
    `use require("./tmpdirs").mkdtemp(prefix) instead: ${offenders.join(", ")}`);
});
