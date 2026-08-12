// Unit tests for the archive's two size ceilings (XERK-267): the per-transcript
// budget that sheds SendUserFile payloads, and the whole-store ceiling that
// stops ingest before /data fills under the hub's own state.json.
//
// Its own file, not a case in archive.test.js, because both ceilings are read
// from the environment at require() time and one of these tests needs the store
// to be FULL — which every later assertion in a shared module instance would
// then inherit. node --test gives each file its own process.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "turma-archive-budget-"));
process.env.ARCHIVE_DIR = path.join(TMP, "archive");
process.env.ARCHIVE_DB = path.join(TMP, "archive", "index.db");
// Tiny stand-ins for the 16 MiB / 64 GiB defaults. The store ceiling is set
// above what the budget tests below write, so it engages only in the last test.
process.env.ARCHIVE_TRANSCRIPT_MAX_BYTES = "4096";
process.env.ARCHIVE_TOTAL_MAX_BYTES = "40000";

const archive = require("../archive.js");

const META = {
  remoteKey: "github.com/xerk/turma", repo: "turma", worktree: "/repos/.turma/worktrees/ab",
  slug: "-repos--turma-worktrees-ab", createdAt: "2026-07-10T00:00:00Z",
  endedTs: "2026-07-10T01:00:00Z", summary: "Screenshot Heavy",
};

// One SendUserFile delivery as the agent ships it: a tool_use block whose
// files[] carries the image inline as a base64 data: URI.
function delivery(uuid, bytes, ts) {
  return {
    uuid, role: "assistant", ts: ts || "2026-07-10T00:00:00Z", text: "",
    blocks: [{
      t: "tool_use", name: "SendUserFile",
      files: [{ name: "screen.png", kind: "image", src: "data:image/png;base64," + "A".repeat(bytes) }],
    }],
  };
}

function storedLines(transcriptId) {
  const t = archive.getTranscript(transcriptId);
  return t.entries;
}

test("under budget: a delivery keeps its inline payload", () => {
  const r = archive.ingestChunk("nas", "small", { ...META, summary: "Small" }, 0, 50,
    [delivery("s1", 200)]);
  assert.equal(r.shed, undefined);
  const f = storedLines("small")[0].blocks[0].files[0];
  assert.equal(f.kind, "image");
  assert.ok(f.src.startsWith("data:image/png;base64,"));
  assert.equal(f.shed, undefined);
});

test("crossing the budget sheds the REST of the transcript, not what came before", () => {
  // Three 2 KB deliveries: the first two fit inside the 4096-byte budget, and
  // the entry that carries it over is the last one stored whole.
  const r = archive.ingestChunk("nas", "big", { ...META }, 0, 300, [
    delivery("b1", 2000, "2026-07-10T00:00:01Z"),
    delivery("b2", 2000, "2026-07-10T00:00:02Z"),
    delivery("b3", 2000, "2026-07-10T00:00:03Z"),
  ]);
  // The reply tells the agent to stop shipping payloads for this transcript.
  assert.equal(r.shed, true);
  const files = storedLines("big").map((e) => e.blocks[0].files[0]);
  assert.equal(files[0].kind, "image");            // under budget, kept whole
  assert.ok(files[0].src.length > 2000);
  assert.equal(files[2].kind, "file");             // past it, name chip only
  assert.equal(files[2].src, undefined);
  assert.equal(files[2].html, undefined);
  assert.equal(files[2].shed, true);               // dropped for size, not missing
  assert.equal(files[2].name, "screen.png");       // ...and still identifiable
});

test("the shed is sticky across chunks — a later delta sheds from its first entry", () => {
  const r = archive.ingestChunk("nas", "big", { ...META }, 300, 400,
    [delivery("b4", 2000, "2026-07-10T00:00:04Z")]);
  assert.equal(r.shed, true);
  const files = storedLines("big").map((e) => e.blocks[0].files[0]);
  assert.equal(files[3].shed, true);
  assert.equal(files[3].src, undefined);
});

test("archiveLimits reports the over-budget transcripts for the heartbeat reply", () => {
  const lim = archive.archiveLimits(["small", "big", "never-seen"]);
  assert.deepEqual(lim.shed, ["big"]);
  assert.equal(lim.full, false);
});

test("the budget bounds the file: a runaway transcript can't outgrow it by much", () => {
  // 40 deliveries of 4 KB each — 160 KB of payload offered, which is what the
  // ticket measured blowing up to hundreds of MB at full scale.
  const entries = [];
  for (let i = 0; i < 40; i++) entries.push(delivery(`r${i}`, 4096, "2026-07-10T00:01:00Z"));
  archive.ingestChunk("nas", "runaway", { ...META, summary: "Runaway" }, 0, 5000, entries);
  const rel = "turma/2026-07-10__runaway__nas__runaway.jsonl";
  const size = fs.statSync(path.join(process.env.ARCHIVE_DIR, rel)).size;
  // One entry may carry the overshoot; everything after it is a name chip.
  assert.ok(size < 4096 * 3, `stored ${size} bytes for 160 KB of payload`);
  // Full fidelity is NOT the promise here — the conversation is, so every
  // message survives with its file named.
  assert.equal(storedLines("runaway").length, 40);
});

test("rebuildIndex re-derives archiveBytes from the files, so a lost DB keeps the budget", () => {
  archive.closeDb();
  fs.rmSync(process.env.ARCHIVE_DB, { force: true });
  fs.rmSync(process.env.ARCHIVE_DB + "-wal", { force: true });
  fs.rmSync(process.env.ARCHIVE_DB + "-shm", { force: true });
  archive.openDb();   // rebuilds from the organized files
  // The sidecars carry archiveBytes now, but the rebuild reads the real file —
  // every archive written before this feature has a sidecar without the field.
  const lim = archive.archiveLimits(["small", "big"]);
  assert.deepEqual(lim.shed, ["big"]);
});

test("a full store stops storing, and says so instead of erroring", () => {
  // Fill past the 40000-byte ceiling with ordinary prose (nothing sheddable).
  let n = 0;
  while (!archive.archiveLimits([]).full && n < 50) {
    archive.ingestChunk("nas", `fill${n}`, { ...META, summary: `Fill ${n}` }, 0, 100,
      [{ uuid: `f${n}`, role: "user", ts: "2026-07-10T00:00:00Z", text: "x".repeat(2000) }]);
    n++;
  }
  assert.ok(n < 50, "the store ceiling never engaged");

  const before = archive.getTranscript("small").entries.length;
  const r = archive.ingestChunk("nas", "small", { ...META, summary: "Small" }, 50, 90,
    [{ uuid: "s2", role: "user", ts: "2026-07-10T00:00:00Z", text: "after the ceiling" }]);
  // Reported as no forward progress (the agent's own stop condition) plus an
  // explicit flag — never a rejection it would retry forever, which is the
  // failure mode XERK-255 documented.
  assert.equal(r.bytesStored, 50);
  assert.equal(r.full, true);
  assert.equal(archive.getTranscript("small").entries.length, before);
});
