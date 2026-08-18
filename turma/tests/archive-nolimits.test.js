// The documented kill-switch: ARCHIVE_TRANSCRIPT_MAX_BYTES=0 and
// ARCHIVE_TOTAL_MAX_BYTES=0 turn each ceiling OFF (XERK-267).
//
// Its own file because both are read from the environment at require() time,
// so "disabled" cannot be expressed in a module instance that has them set.
// The failure this guards against is an inversion — dropping the `MAX && …`
// guard makes a DISABLED total ceiling read as permanently FULL, which stops
// every agent on the fleet archiving, and nothing else in the suite would say
// so because nothing else runs with the ceilings off.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "turma-archive-nolimit-"));
process.env.ARCHIVE_DIR = path.join(TMP, "archive");
// INSIDE ARCHIVE_DIR, matching the production default.
process.env.ARCHIVE_DB = path.join(TMP, "archive", "index.db");
process.env.ARCHIVE_TRANSCRIPT_MAX_BYTES = "0";
process.env.ARCHIVE_TOTAL_MAX_BYTES = "0";

const archive = require("../archive.js");

const META = {
  remoteKey: "github.com/xerk/turma", repo: "turma", worktree: "/repos/.turma/worktrees/ab",
  slug: "-repos--turma-worktrees-ab", createdAt: "2026-07-10T00:00:00Z",
  endedTs: "2026-07-10T01:00:00Z", summary: "No Limits",
};

function delivery(uuid, bytes, ts) {
  return {
    uuid, role: "assistant", ts, text: "",
    blocks: [{
      t: "tool_use", name: "SendUserFile",
      files: [{ name: "shot.png", kind: "image", src: "data:image/png;base64," + "A".repeat(bytes) }],
    }],
  };
}

test("0 parses as zero, not as unset", () => {
  assert.equal(archive.ARCHIVE_TRANSCRIPT_MAX, 0);
  assert.equal(archive.ARCHIVE_TOTAL_MAX, 0);
});

test("a disabled per-transcript ceiling keeps every payload, however many", () => {
  const entries = [];
  for (let i = 0; i < 30; i++) entries.push(delivery(`d${i}`, 4096, "2026-07-10T00:01:00Z"));
  const r = archive.ingestChunk("nas", "unbounded", { ...META }, 0, 4000, entries);
  assert.equal(r.shed, undefined, "nothing may shed with the ceiling off");
  const files = archive.getTranscript("unbounded").entries.map((e) => e.blocks[0].files[0]);
  assert.equal(files.length, 30);
  assert.ok(files.every((f) => f.kind === "image" && !f.shed), "a payload was shed anyway");
  assert.deepEqual(archive.archiveLimits(["unbounded"]).shed, []);
});

test("a disabled total ceiling never reads as full — the inversion that stops the fleet", () => {
  // The store now holds far more than any non-zero ceiling would allow, so a
  // `>= 0` comparison reached without its guard would say "full" forever.
  assert.ok(archive.totalArchiveBytes() > 100_000);
  assert.equal(archive.archiveLimits([]).full, false);
  const r = archive.ingestChunk("nas", "still-fine", { ...META, summary: "Still Fine" }, 0, 40,
    [{ uuid: "sf1", role: "user", ts: "2026-07-10T00:02:00Z", text: "stored" }]);
  assert.equal(r.full, undefined);
  assert.equal(r.bytesStored, 40);
});
