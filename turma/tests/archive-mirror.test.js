// The archive object-store mirror (XERK-759): note -> drain (leader-gated push) ->
// hydrate (pull + reindex), driven with an in-memory fake blob store, plus the
// real archive.js integration (its write sink fires for every durable layer, and
// the pushed bytes hydrate + rebuild a fresh replica's index byte-for-byte). zero-npm.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { mkdtemp } = require("./tmpdirs");
const { ArchiveMirror } = require("../archive-mirror.js");

// A fake BlobStore: an in-memory key->Buffer map with the same async surface.
function memStore(opts = {}) {
  const map = new Map();
  let puts = 0;
  return {
    map,
    async put(key, src) {
      puts++;
      if (opts.failPut && opts.failPut(key, puts)) {
        const e = new Error(opts.failCode || "boom");
        if (opts.failCode) e.code = opts.failCode;
        throw e;
      }
      map.set(key, src.file ? fs.readFileSync(src.file) : Buffer.from(src.body));
    },
    async getToFile(key, dest) {
      if (!map.has(key)) return false;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, map.get(key));
      return true;
    },
    async stat(key) { return map.has(key) ? { size: map.get(key).length } : null; },
    async list(prefix) { return [...map.keys()].filter((k) => k.startsWith(prefix || "")); },
    async del(key) { map.delete(key); },
  };
}

test("keyFor/pathFor stay inside ARCHIVE_DIR and use '/' keys", () => {
  const root = mkdtemp("turma-mir-");
  const m = new ArchiveMirror({ blobStore: memStore(), archiveDir: root, reindex() {} });
  assert.equal(m.keyFor(path.join(root, "repo", "a.jsonl")), "repo/a.jsonl");
  assert.equal(m.keyFor(path.join(root, "..", "escape")), null); // escapes the tree
  assert.equal(m.pathFor("repo/a.jsonl"), path.join(root, "repo", "a.jsonl"));
  assert.equal(m.pathFor("../etc/passwd"), null);
  assert.equal(m.pathFor("a\0b"), null);
});

test("note records dirty files; drain pushes them to the store", async () => {
  const root = mkdtemp("turma-mir-");
  fs.mkdirSync(path.join(root, "repo"), { recursive: true });
  const f1 = path.join(root, "repo", "a.jsonl");
  const f2 = path.join(root, "repo", "a.jsonl.meta");
  fs.writeFileSync(f1, "line1\nline2\n");
  fs.writeFileSync(f2, '{"transcriptId":"t"}');
  const store = memStore();
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {} });
  m.note(f1); m.note(f2); m.note(f1); // dedup
  assert.equal(m.pending(), 2);
  const pushed = await m.drain();
  assert.equal(pushed, 2);
  assert.equal(m.pending(), 0);
  assert.deepEqual([...store.map.keys()].sort(), ["repo/a.jsonl", "repo/a.jsonl.meta"]);
  assert.deepEqual(store.map.get("repo/a.jsonl"), fs.readFileSync(f1));
});

test("drain is a no-op for a non-leader (single owning writer), dirty kept", async () => {
  const root = mkdtemp("turma-mir-");
  const f = path.join(root, "a.jsonl");
  fs.writeFileSync(f, "x");
  const store = memStore();
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {}, isLeader: () => false });
  m.note(f);
  assert.equal(await m.drain(), 0);
  assert.equal(store.map.size, 0);
  assert.equal(m.pending(), 1); // still queued — a promoted leader pushes it
});

test("a failed push is re-queued; a raced-delete (ENOENT) is dropped", async () => {
  const root = mkdtemp("turma-mir-");
  const good = path.join(root, "good.jsonl");
  const gone = path.join(root, "gone.jsonl");
  fs.writeFileSync(good, "g");
  // `gone` is noted but never created on disk -> put reads it, ENOENT.
  const store = memStore({ failPut: (k) => k === "good.jsonl", failCode: "ETRANSIENT" });
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {} });
  m.note(good); m.note(gone);
  await m.drain();
  // good failed transiently -> re-queued; gone hit ENOENT -> dropped.
  assert.equal(m.pending(), 1);
  // Next drain (now allow the put) lands it.
  const store2 = memStore();
  const m2 = new ArchiveMirror({ blobStore: store2, archiveDir: root, reindex() {} });
  m2.note(good);
  await m2.drain();
  assert.ok(store2.map.has("good.jsonl"));
});

test("hydrate pulls every object down, skips a same-size local, then reindexes", async () => {
  const srcRoot = mkdtemp("turma-mir-");
  // Seed a store with two objects.
  const store = memStore();
  store.map.set("repo/a.jsonl", Buffer.from("hello\n"));
  store.map.set("repo/a.jsonl.meta", Buffer.from('{"bytesStored":42}'));
  let reindexed = 0;
  const m = new ArchiveMirror({
    blobStore: store, archiveDir: srcRoot, reindex: () => { reindexed++; },
  });
  const n1 = await m.hydrate();
  assert.equal(n1, 2);
  assert.equal(reindexed, 1);
  assert.equal(fs.readFileSync(path.join(srcRoot, "repo", "a.jsonl"), "utf8"), "hello\n");
  // A second hydrate downloads nothing (local sizes already match) but reindexes.
  const n2 = await m.hydrate();
  assert.equal(n2, 0);
  assert.equal(reindexed, 2);

  // A local file that is LARGER than the object (a leader's un-mirrored appends,
  // local ahead of the bucket) is NEVER truncated back — hydrate skips it.
  const ahead = path.join(srcRoot, "repo", "a.jsonl");
  fs.writeFileSync(ahead, "hello\nlocal-appended-more\n"); // > the 6-byte object
  const before = fs.readFileSync(ahead);
  const n3 = await m.hydrate();
  assert.equal(n3, 0);
  assert.deepEqual(fs.readFileSync(ahead), before); // untouched
});

// ---- real archive.js integration -------------------------------------------
// Requiring archive.js reads ARCHIVE_DIR at load, so this sets it before the
// require and drives real ingest to prove the SINK fires for both byte layers,
// the pushed bytes hydrate into a FRESH replica dir, and that dir's rebuilt index
// reads the transcript back identically.

test("archive.js sink fires for rendered + raw writes; the bytes hydrate + reindex", async () => {
  const A = mkdtemp("turma-mir-arc-");
  process.env.ARCHIVE_DIR = path.join(A, "archive");
  process.env.ARCHIVE_DB = path.join(A, "archive", "index.db");
  const archive = require("../archive.js");

  const store = memStore();
  const mirror = new ArchiveMirror({
    blobStore: store,
    archiveDir: archive.ARCHIVE_DIR,
    reindex: () => { archive.openDb(); archive.rebuildIndex(); },
  });
  archive.setBlobSink((p) => mirror.note(p));

  const meta = {
    remoteKey: "github.com/x/turma", repo: "turma", worktree: "/w/ab",
    slug: "-w-ab", createdAt: "2026-07-10T00:00:00Z", endedTs: "2026-07-10T01:00:00Z",
    summary: "a session",
  };
  const entries = [
    { uuid: "u1", role: "user", ts: "2026-07-10T00:00:00Z", text: "hello archive" },
    { uuid: "u2", role: "assistant", ts: "2026-07-10T00:00:01Z", text: "hi there" },
  ];
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  const r = archive.ingestChunk("host-1", "tid-1", meta, 0, Buffer.byteLength(body), entries, "");
  assert.ok(r.bytesStored > 0);
  // The raw layer too (a byte-for-byte sidecar file).
  const rawBuf = Buffer.from("raw session bytes\n");
  const rr = archive.ingestRaw("host-1", "tid-1", "tid-1.jsonl", 0, rawBuf);
  assert.equal(rr.stored, rawBuf.length);

  // The sink saw the rendered .jsonl, its .meta sidecar, and the raw file.
  assert.ok(mirror.pending() >= 3);
  await mirror.drain();
  const keys = [...store.map.keys()];
  assert.ok(keys.some((k) => k.endsWith(".jsonl") && !k.includes(".raw")), "rendered .jsonl pushed");
  assert.ok(keys.some((k) => k.endsWith(".meta")), ".meta pushed");
  assert.ok(keys.some((k) => k.includes(".jsonl.raw/")), "raw file pushed");

  archive.setBlobSink(null); // stop noting for the rest of the process

  // A FRESH replica: a second archive dir, hydrate the bucket into it, rebuild,
  // read the transcript back. (Point the singleton at the new dir + reopen.)
  const B = path.join(A, "replica2");
  process.env.ARCHIVE_DIR = path.join(B, "archive");
  process.env.ARCHIVE_DB = path.join(B, "archive", "index.db");
  // archive.js captured ARCHIVE_DIR at require; a same-process second dir needs a
  // fresh module. Clear the require cache for it and re-require under the new env.
  delete require.cache[require.resolve("../archive.js")];
  const archive2 = require("../archive.js");
  const mirror2 = new ArchiveMirror({
    blobStore: store,
    archiveDir: archive2.ARCHIVE_DIR,
    reindex: () => { archive2.openDb(); archive2.rebuildIndex(); },
  });
  const fetched = await mirror2.hydrate();
  assert.ok(fetched >= 3, "hydrated every layer");

  const t = archive2.getTranscript("tid-1");
  assert.ok(t, "transcript reads back after hydrate");
  assert.equal(t.entries.length, 2);
  assert.equal(t.entries[0].text, "hello archive");
  assert.equal(archive2.sessionRow("tid-1").host, "host-1");
  // The cursor recovered from the .meta sidecar: a re-ingest from offset 0 finds
  // the bytes already stored and hands back the real cursor (append-only, no
  // duplicate), so an agent RESUMES rather than re-pushing the whole transcript.
  const again = archive2.ingestChunk("host-1", "tid-1", meta, 0, Buffer.byteLength(body), entries, "");
  assert.equal(again.bytesStored, Buffer.byteLength(body));
  assert.equal(archive2.getTranscript("tid-1").entries.length, 2); // not duplicated
  archive2.closeDb();
});
