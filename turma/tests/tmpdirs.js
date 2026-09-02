// Shared scratch-directory helper for the node test suites (XERK-423).
//
// Every suite that needs a throwaway ARCHIVE_DIR / MIGRATE_SPOOL_DIR / ledger
// root used to `fs.mkdtempSync` it and never remove it. CI throws its runner
// away so it never noticed, but a developer or agent host runs the suite over
// and over on the SAME box — on truenas that had left 1,640 turma-test-archive-*
// trees on a tmpfs (i.e. in RAM).
//
// `mkdtemp(prefix)` is a drop-in for `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`
// that records the directory and removes the whole set on process exit. Cleanup
// is deferred to `process.on("exit")`, NOT a `test.after`, on purpose: some
// suites re-`require` the server module (`freshServerModule`) or assert against
// files written earlier in the run, so the trees must live until the very end of
// the process — and an exit handler runs after every `test.after`, regardless of
// the order those were registered in. It is synchronous, so `rmSync` is safe here.
const fs = require("fs");
const os = require("os");
const path = require("path");

const tracked = [];
let hooked = false;

function mkdtemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tracked.push(dir);
  if (!hooked) {
    hooked = true;
    process.on("exit", () => {
      for (const d of tracked) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    });
  }
  return dir;
}

module.exports = { mkdtemp };
