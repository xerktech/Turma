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
const { ArchiveMirror, rawRootOf } = require("../archive-mirror.js");

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
  // Inside the tree but through `..`: would land on ANOTHER transcript's file.
  assert.equal(m.pathFor("repo/a.jsonl.raw/t/../../b.jsonl"), null);
  assert.equal(m.pathFor("repo//a.jsonl"), null);
  assert.equal(m.pathFor("./repo/a.jsonl"), null);
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

// archive.setRawRemote's hooks, wired the way server.js wires them.
function hooksFor(m) {
  return {
    pending: (p) => m.rawPending(p),
    pendingSize: (p) => m.rawPendingSize(p),
    pendingFiles: (d) => m.rawPendingFiles(d),
    pendingBytes: (d) => m.rawPendingBytes(d),
  };
}

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
  archive2.setRawRemote(hooksFor(mirror2));
  const fetched = await mirror2.hydrate();
  assert.ok(fetched >= 2, "hydrated the rendered layer");
  // The raw file stayed in the bucket (XERK-1043).
  const rawDir = archive2.rawDirOf("tid-1");
  assert.ok(rawDir);
  assert.equal(fs.existsSync(path.join(rawDir, "tid-1.jsonl")), false, "raw not downloaded");
  assert.equal(mirror2.rawPendingBytes(rawDir), rawBuf.length);

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

  // A PENDING raw file's heartbeat cursor is the BUCKET's size (advisory — an
  // agent with nothing new ships nothing), and asking for it fetches nothing.
  const manifest = [{ transcriptId: "tid-1", rawFiles: [["tid-1.jsonl", rawBuf.length]] }];
  assert.deepEqual(archive2.rawCursors(manifest), { "tid-1": { "tid-1.jsonl": rawBuf.length } });
  assert.deepEqual(archive2.rawCursorsForIds(["tid-1"]), { "tid-1": { "tid-1.jsonl": rawBuf.length } });
  await new Promise((r) => setImmediate(r));
  assert.equal(mirror2.rawPendingBytes(rawDir), rawBuf.length, "a cursor ask queued no fetch");
  // Its INGEST cursor is "cannot tell", never 0: a push from offset 0 is refused
  // without creating a local file the drain would later push over the object.
  const refused = archive2.ingestRaw("host-1", "tid-1", "tid-1.jsonl", 0, rawBuf);
  assert.deepEqual(refused, { stored: 0, skip: true });
  assert.equal(fs.existsSync(path.join(rawDir, "tid-1.jsonl")), false);
  // Asking queued the fetch; once it lands the local size IS the cursor, and the
  // same push realigns to it instead of duplicating.
  assert.equal(await mirror2.fetchRawUnder(rawDir), 0);
  assert.deepEqual(fs.readFileSync(path.join(rawDir, "tid-1.jsonl")), rawBuf);
  assert.deepEqual(archive2.rawCursors(manifest), { "tid-1": { "tid-1.jsonl": rawBuf.length } });
  assert.deepEqual(archive2.ingestRaw("host-1", "tid-1", "tid-1.jsonl", 0, rawBuf),
    { stored: rawBuf.length });
  assert.deepEqual(fs.readFileSync(path.join(rawDir, "tid-1.jsonl")), rawBuf); // not doubled
  archive2.setRawRemote(null);
  archive2.closeDb();
});

test("rawRootOf names the `.jsonl.raw` directory, never a rendered key", () => {
  assert.equal(rawRootOf("repo/a.jsonl.raw/tid/tid.jsonl"), "repo/a.jsonl.raw");
  assert.equal(rawRootOf("repo/a.jsonl.raw/tid/tid/subagents/x.jsonl"), "repo/a.jsonl.raw");
  assert.equal(rawRootOf("repo/a.jsonl"), null);
  assert.equal(rawRootOf("repo/a.jsonl.meta"), null);
  assert.equal(rawRootOf("x.jsonl.raw/f"), null);  // top level is never a raw dir
  assert.equal(rawRootOf("repo/a.jsonl.raw"), null); // the directory itself, no file
});

test("hydrate leaves raw objects pending; asking fetches them, atomically", async () => {
  const root = mkdtemp("turma-mir-");
  const store = memStore();
  let listed = 0;
  store.listSizes = async (prefix) => {
    listed++;
    return [...store.map].filter(([k]) => k.startsWith(prefix || ""))
      .map(([key, buf]) => ({ key, size: buf.length }));
  };
  let statted = 0;
  const stat = store.stat;
  store.stat = async (k) => { statted++; return stat(k); };
  store.map.set("repo/a.jsonl", Buffer.from("rendered\n"));
  store.map.set("repo/a.jsonl.raw/t1/t1.jsonl", Buffer.from("0123456789"));
  store.map.set("repo/a.jsonl.raw/t1/t1/subagents/s.jsonl", Buffer.from("abc"));
  store.map.set("repo/a.jsonl.raw/t2/t2.jsonl", Buffer.from("zz"));
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {}, log() {} });

  assert.equal(await m.hydrate(), 1); // only the rendered file
  assert.equal(listed, 1);
  assert.equal(statted, 0, "sizes came from the listing, not a HEAD per key");
  assert.ok(fs.existsSync(path.join(root, "repo", "a.jsonl")));
  const t1 = path.join(root, "repo", "a.jsonl.raw", "t1");
  assert.equal(fs.existsSync(t1), false);
  assert.equal(m.rawPendingBytes(t1), 13);
  assert.equal(m.rawPendingBytes(path.join(root, "repo", "a.jsonl.raw")), 15);
  assert.equal(m.rawPending(path.join(root, "repo", "a.jsonl")), false); // rendered: never pending

  // A fetch that fails leaves the file pending, with nothing half-written in place.
  const get = store.getToFile;
  store.getToFile = async () => { throw new Error("minio down"); };
  assert.equal(await m.fetchRawUnder(t1), 2);
  assert.equal(fs.existsSync(t1), false);
  assert.equal(m.rawPendingBytes(t1), 13); // still pending (asked without queuing a fetch)
  store.getToFile = get;

  assert.equal(await m.fetchRawUnder(t1), 0);
  assert.equal(fs.readFileSync(path.join(t1, "t1.jsonl"), "utf8"), "0123456789");
  assert.equal(fs.readFileSync(path.join(t1, "t1", "subagents", "s.jsonl"), "utf8"), "abc");
  assert.equal(m.rawPending(path.join(t1, "t1.jsonl")), false);
  assert.equal(m.rawPendingBytes(t1), 0);
  assert.deepEqual(fs.readdirSync(path.join(root, ".raw-fetch")), []); // no temp left
  // Its sibling transcript is untouched until asked for.
  assert.equal(m.rawPendingBytes(path.join(root, "repo", "a.jsonl.raw", "t2")), 2);

  // rawPending (the sync cursor question) queues a background fetch by itself.
  const t2file = path.join(root, "repo", "a.jsonl.raw", "t2", "t2.jsonl");
  assert.equal(m.rawPending(t2file), true);
  for (let i = 0; i < 50 && m.rawPending(t2file); i++) await new Promise((r) => setImmediate(r));
  assert.equal(fs.readFileSync(t2file, "utf8"), "zz");

  // A re-hydrate does not re-list anything local as pending.
  await m.hydrate();
  assert.equal(m.rawPendingBytes(path.join(root, "repo")), 0);
});

test("rawBytes counts the pending part, so the per-transcript raw budget holds", async () => {
  const A = mkdtemp("turma-mir-arc-");
  process.env.ARCHIVE_DIR = path.join(A, "archive");
  process.env.ARCHIVE_DB = path.join(A, "archive", "index.db");
  delete require.cache[require.resolve("../archive.js")];
  const archive = require("../archive.js");
  const store = memStore();
  const mirror = new ArchiveMirror({
    blobStore: store, archiveDir: archive.ARCHIVE_DIR,
    reindex: () => { archive.openDb(); archive.rebuildIndex(); },
  });
  archive.setBlobSink((p) => mirror.note(p));
  const meta = {
    remoteKey: "github.com/x/turma", repo: "turma", worktree: "/w/ab",
    slug: "-w-ab", createdAt: "2026-07-10T00:00:00Z", endedTs: "2026-07-10T01:00:00Z",
    summary: "budget",
  };
  const entries = [{ uuid: "u1", role: "user", ts: "2026-07-10T00:00:00Z", text: "hi" }];
  const body = JSON.stringify(entries[0]);
  archive.ingestChunk("host-1", "tid-b", meta, 0, Buffer.byteLength(body), entries, "");
  const rawBuf = Buffer.alloc(64, 0x61);
  archive.ingestRaw("host-1", "tid-b", "tid-b.jsonl", 0, rawBuf);
  await mirror.drain();
  archive.setBlobSink(null);
  archive.closeDb();

  // A fresh replica whose raw budget is exactly what the bucket holds.
  process.env.ARCHIVE_DIR = path.join(A, "replica", "archive");
  process.env.ARCHIVE_DB = path.join(A, "replica", "archive", "index.db");
  process.env.ARCHIVE_RAW_TRANSCRIPT_MAX_BYTES = String(rawBuf.length);
  delete require.cache[require.resolve("../archive.js")];
  const archive2 = require("../archive.js");
  delete process.env.ARCHIVE_RAW_TRANSCRIPT_MAX_BYTES;
  const mirror2 = new ArchiveMirror({
    blobStore: store, archiveDir: archive2.ARCHIVE_DIR,
    reindex: () => { archive2.openDb(); archive2.rebuildIndex(); },
  });
  archive2.setRawRemote(hooksFor(mirror2));
  await mirror2.hydrate();
  // Nothing raw is local, yet the rebuilt row knows the budget is spent.
  assert.equal(fs.existsSync(path.join(archive2.rawDirOf("tid-b"), "tid-b.jsonl")), false);
  assert.deepEqual(archive2.rawLimits(["tid-b"]), ["tid-b"]);
  archive2.setRawRemote(null);
  archive2.closeDb();
});

// A memStore whose getToFile can be held open per key, to pin down races.
function gatedStore() {
  const store = memStore();
  const gates = new Map();
  const get = store.getToFile;
  store.getToFile = async (key, dest) => {
    const g = gates.get(key);
    if (g) await g.promise;
    return get(key, dest);
  };
  store.hold = (key) => {
    let release;
    const promise = new Promise((r) => { release = r; });
    gates.set(key, { promise });
    return () => { gates.delete(key); release(); };
  };
  return store;
}

test("a promotion re-hydrate never un-pends a raw file mid-download (QA D1)", async () => {
  const root = mkdtemp("turma-mir-");
  const store = gatedStore();
  store.map.set("repo/a.jsonl", Buffer.from("v1\n"));
  store.map.set("repo/a.jsonl.raw/t/t.jsonl", Buffer.alloc(9000, 0x72));
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {}, log() {} });
  await m.hydrate();
  const raw = path.join(root, "repo", "a.jsonl.raw", "t", "t.jsonl");
  assert.equal(m.rawPendingSize(raw), 9000);
  // The old leader appended to the rendered file; the promoted replica's
  // re-hydrate must download it — and is held mid-download.
  store.map.set("repo/a.jsonl", Buffer.from("v1\nv2\n"));
  // ...and wrote a raw file this replica has never seen.
  store.map.set("repo/a.jsonl.raw/t/new.jsonl", Buffer.alloc(700, 0x6e));
  const fresh = path.join(root, "repo", "a.jsonl.raw", "t", "new.jsonl");
  const release = store.hold("repo/a.jsonl");
  const run = m.hydrate();
  await new Promise((r) => setImmediate(r));
  // Throughout the download, both raw files are pending: their ingest cursors
  // stay "cannot tell" instead of an ENOENT 0.
  assert.equal(m.rawPendingSize(raw), 9000);
  assert.equal(m.rawPendingSize(fresh), 700);
  assert.equal(m.rawPendingBytes(path.join(root, "repo", "a.jsonl.raw")), 9700);
  release();
  await run;
  assert.equal(fs.readFileSync(path.join(root, "repo", "a.jsonl"), "utf8"), "v1\nv2\n");
  assert.equal(m.rawPendingSize(raw), 9000);
});

test("a file that already landed is never downloaded over again (QA D2)", async () => {
  const root = mkdtemp("turma-mir-");
  const store = gatedStore();
  store.map.set("repo/a.jsonl.raw/t/one.jsonl", Buffer.alloc(1000, 0x31));
  store.map.set("repo/a.jsonl.raw/t/slow.jsonl", Buffer.alloc(10, 0x32));
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {}, log() {} });
  await m.hydrate();
  const dir = path.join(root, "repo", "a.jsonl.raw", "t");
  const one = path.join(dir, "one.jsonl");
  // The background pump is stuck on `slow` with `one` queued behind it...
  const releaseSlow = store.hold("repo/a.jsonl.raw/t/slow.jsonl");
  m.rawPending(path.join(dir, "slow.jsonl"));
  m.rawPending(one);
  // ...while a route lands `one`, and ingest appends to it.
  await m.fetchRawUnder(dir, { timeoutMs: 50 });
  assert.equal(fs.statSync(one).size, 1000);
  fs.appendFileSync(one, Buffer.alloc(500, 0x33));
  // Now the pump reaches `one`: it is no longer pending, so it is left alone.
  releaseSlow();
  for (let i = 0; i < 50 && m.rawPendingBytes(dir); i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fs.statSync(one).size, 1500, "appended bytes survived the pump");

  // And the rename-time check: a key that stops being pending DURING its GET (a
  // re-hydrate found it local) is not renamed over the local file.
  store.map.set("repo/a.jsonl.raw/t/late.jsonl", Buffer.alloc(100, 0x34));
  await m.hydrate();
  const late = path.join(dir, "late.jsonl");
  const releaseLate = store.hold("repo/a.jsonl.raw/t/late.jsonl");
  const fetching = m.fetchRawUnder(dir, { timeoutMs: 5000 });
  await new Promise((r) => setImmediate(r));
  fs.writeFileSync(late, Buffer.alloc(150, 0x35)); // a local copy AHEAD of the bucket
  await m.hydrate();                              // ...so it is no longer pending
  releaseLate();
  await fetching;
  assert.equal(fs.statSync(late).size, 150);
});

test("a partial local raw copy is counted once in pending bytes (QA D3)", async () => {
  const root = mkdtemp("turma-mir-");
  const store = memStore();
  store.map.set("repo/a.jsonl.raw/t/t.jsonl", Buffer.alloc(3000, 0x61));
  const dir = path.join(root, "repo", "a.jsonl.raw", "t");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "t.jsonl"), Buffer.alloc(1000, 0x61)); // a prefix
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {}, log() {} });
  await m.hydrate();
  assert.equal(m.rawPendingSize(path.join(dir, "t.jsonl")), 3000);
  // local walk (1000) + this (2000) = the true 3000, not 4000.
  assert.equal(m.rawPendingBytes(dir), 2000);
  assert.equal(await m.fetchRawUnder(dir), 0);
  assert.equal(fs.statSync(path.join(dir, "t.jsonl")).size, 3000);
  assert.equal(m.rawPendingBytes(dir), 0);
});

test("fetchRawUnder answers at its timeout while the store hangs (QA L1)", async () => {
  const root = mkdtemp("turma-mir-");
  const store = gatedStore();
  store.map.set("repo/a.jsonl.raw/t/t.jsonl", Buffer.from("x"));
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {}, log() {} });
  await m.hydrate();
  const release = store.hold("repo/a.jsonl.raw/t/t.jsonl");
  const t0 = Date.now();
  const left = await m.fetchRawUnder(path.join(root, "repo", "a.jsonl.raw", "t"), { timeoutMs: 50 });
  assert.equal(left, 1);
  assert.ok(Date.now() - t0 < 1000);
  release(); // the fetch carries on and lands
  for (let i = 0; i < 50 && m.rawPendingBytes(root + "/repo/a.jsonl.raw"); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(fs.readFileSync(path.join(root, "repo", "a.jsonl.raw", "t", "t.jsonl"), "utf8"), "x");
});
