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

test("setRawRemote refuses an incomplete hook set instead of unwiring the guards", () => {
  const archive = require("../archive.js");
  assert.throws(() => archive.setRawRemote({ pending: () => false, pendingBytes: () => 0 }),
    /missing hook\(s\) pendingSize, pendingFiles/);
  archive.setRawRemote(null); // explicit unwire stays allowed
});

test("a route fetches at most 4 raw objects at once", async () => {
  const root = mkdtemp("turma-mir-");
  const store = memStore();
  for (let i = 0; i < 10; i++) store.map.set(`repo/a.jsonl.raw/t/f${i}.jsonl`, Buffer.from("x"));
  let inFlight = 0, peak = 0;
  const get = store.getToFile;
  store.getToFile = async (k, d) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return get(k, d);
  };
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {}, log() {} });
  await m.hydrate();
  assert.equal(await m.fetchRawUnder(path.join(root, "repo", "a.jsonl.raw", "t")), 0);
  assert.equal(peak, 4);
});

test("a rendered download cut mid-body leaves nothing at its real path", async () => {
  const root = mkdtemp("turma-mir-");
  const store = memStore();
  store.map.set("repo/a.jsonl", Buffer.alloc(5000, 0x61));
  store.getToFile = async (key, dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.alloc(100, 0x61)); // the part that arrived
    throw new Error("socket hang up");
  };
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {}, log() {} });
  assert.equal(await m.hydrate(), 0);
  assert.equal(fs.existsSync(path.join(root, "repo", "a.jsonl")), false);
  assert.deepEqual(fs.readdirSync(path.join(root, ".raw-fetch")), []);
});

test("hydrateUntilListed retries until the hydrate completes (XERK-1048)", async () => {
  const root = mkdtemp("turma-mir-");
  const store = memStore();
  store.map.set("repo/a.jsonl", Buffer.from("x\n"));
  let down = 3;
  const list = store.list;
  store.list = async (p) => { if (down-- > 0) throw new Error("ECONNREFUSED"); return list(p); };
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {}, log() {} });
  const slept = [];
  const n = await m.hydrateUntilListed({
    firstDelayMs: 100, maxDelayMs: 250, sleep: async (ms) => { slept.push(ms); },
  });
  assert.equal(n, 1);
  assert.equal(m.hydrated, true);
  assert.deepEqual(slept, [100, 200, 250]); // capped exponential backoff
  assert.ok(fs.existsSync(path.join(root, "repo", "a.jsonl")));
});

test("a failed listing is reported, not mistaken for an empty bucket", async () => {
  const root = mkdtemp("turma-mir-");
  const store = memStore();
  store.list = async () => { throw new Error("down"); };
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {}, log() {} });
  assert.equal(await m.hydrate(), 0);
  assert.equal(m.hydrated, false);
});

test("a failed rendered download blocks only its transcript until retryBlocked lands it (XERK-1050)", async () => {
  const root = mkdtemp("turma-mir-");
  const store = memStore();
  store.map.set("repo/a.jsonl", Buffer.from("a\n"));
  store.map.set("repo/b.jsonl", Buffer.from("b\n"));
  store.map.set("repo/b.jsonl.meta", Buffer.from("{}"));
  let failB = 2;
  const get = store.getToFile;
  store.getToFile = async (k, d) => {
    if (k === "repo/b.jsonl" && failB-- > 0) throw new Error("socket hang up");
    return get(k, d);
  };
  let landed = 0;
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {}, log() {},
    onLanded: () => { landed++; } });
  const slept = [];
  await m.hydrateUntilListed({ firstDelayMs: 10, sleep: async (ms) => { slept.push(ms); } });
  // Listed, so the replica-wide gate would open; only b is held back.
  assert.equal(m.hydrated, true);
  assert.deepEqual(slept, []);
  assert.equal(m.renderedBlocked(path.join(root, "repo", "b.jsonl")), true);
  assert.equal(m.renderedBlocked(path.join(root, "repo", "a.jsonl")), false);
  assert.equal(m.blockedCount(), 1);
  assert.match(m.lastFailure, /1 rendered download\(s\) failed, e\.g\. repo\/b\.jsonl \(socket hang up\)/);
  await m.retryBlockedUntilClear({ firstDelayMs: 10, maxDelayMs: 15, sleep: async (ms) => { slept.push(ms); } });
  assert.deepEqual(slept, [10, 15]);
  assert.equal(m.blockedCount(), 0);
  assert.equal(m.lastFailure, null);
  assert.equal(landed, 1);
  assert.equal(fs.readFileSync(path.join(root, "repo", "b.jsonl"), "utf8"), "b\n");
});

test("a blocked .meta blocks its transcript; a key gone from the bucket is forgotten (XERK-1050)", async () => {
  const root = mkdtemp("turma-mir-");
  const store = memStore();
  store.map.set("repo/b.jsonl", Buffer.from("b\n"));
  store.map.set("repo/b.jsonl.meta", Buffer.from("{}"));
  store.map.set("repo/c.jsonl", Buffer.from("c\n"));
  const get = store.getToFile;
  store.getToFile = async (k, d) => {
    if ((k === "repo/b.jsonl.meta" || k === "repo/c.jsonl") && store.map.has(k)) throw new Error("HTTP 403");
    return get(k, d);
  };
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {}, log() {} });
  await m.hydrate();
  assert.equal(m.renderedBlocked(path.join(root, "repo", "b.jsonl")), true);
  assert.equal(m.blockedCount(), 2);
  // c deleted from the bucket: the retry's GET 404s, and so does the next listing.
  store.map.delete("repo/c.jsonl");
  await m.retryBlocked();
  assert.equal(m.renderedBlocked(path.join(root, "repo", "c.jsonl")), false);
  assert.equal(m.blockedCount(), 1);
  // A re-hydrate forgets a blocked key the listing no longer names.
  store.map.delete("repo/b.jsonl.meta");
  await m.hydrate();
  assert.equal(m.blockedCount(), 0);
});

test("a hydrate waits for an in-flight retryBlocked pass, never overlapping it", async () => {
  const root = mkdtemp("turma-mir-");
  const store = gatedStore();
  store.map.set("repo/b.jsonl", Buffer.from("b\n"));
  const get = store.getToFile;
  let fail = true;
  store.getToFile = async (k, d) => { if (fail) throw new Error("HTTP 403"); return get(k, d); };
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {}, log() {} });
  await m.hydrate();
  assert.equal(m.blockedCount(), 1);
  fail = false;
  const release = store.hold("repo/b.jsonl");
  const retry = m.retryBlocked();
  let hydrated = false;
  const h = m.hydrate().then(() => { hydrated = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(hydrated, false, "hydrate waited on the retry pass");
  assert.equal(await m.retryBlocked(), 0, "no second pass while one runs");
  release();
  assert.equal(await retry, 1);
  await h;
  assert.equal(m.blockedCount(), 0);
});

test("hydrateGated holds the ingest gate closed until the hydrate completes (XERK-1048)", async () => {
  const root = mkdtemp("turma-mir-");
  const store = memStore();
  store.map.set("repo/a.jsonl", Buffer.from("a\n"));
  let down = 2;
  const list = store.list;
  store.list = async (p) => { if (down-- > 0) throw new Error("ECONNREFUSED"); return list(p); };
  const logs = [];
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {}, log: (l) => logs.push(l) });
  const gate = [];
  const gateAtSleep = [];
  await m.hydrateGated((v) => gate.push(v), {
    firstDelayMs: 1, sleep: async () => { gateAtSleep.push(gate[gate.length - 1]); },
  });
  assert.deepEqual(gate, [true, false]);          // closed once, opened once, at the end
  assert.deepEqual(gateAtSleep, [true, true]);    // closed across every retry
  assert.ok(fs.existsSync(path.join(root, "repo", "a.jsonl")));
  assert.match(logs.join("\n"), /listing the bucket failed \(ECONNREFUSED\) — is the object store reachable\? Archive ingest/);
  // A failed rendered DOWNLOAD does not hold the replica-wide gate (XERK-1050).
  const m3 = new ArchiveMirror({ blobStore: { ...store, list: async () => ["repo/z.jsonl"],
    stat: async () => ({ size: 9 }), getToFile: async () => { throw new Error("HTTP 403"); } },
  archiveDir: root, reindex() {}, log() {} });
  const gate3 = [];
  await m3.hydrateGated((v) => gate3.push(v), { firstDelayMs: 1, sleep: async () => { throw new Error("retried"); } });
  assert.deepEqual(gate3, [true, false]);
  assert.equal(m3.blockedCount(), 1);
  // ...and released even when the hydrate throws.
  const m2 = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {}, log() {} });
  m2.hydrateUntilListed = async () => { throw new Error("boom"); };
  const gate2 = [];
  await assert.rejects(m2.hydrateGated((v) => gate2.push(v)));
  assert.deepEqual(gate2, [true, false]);
});

test("a completed hydrate whose next listing fails is incomplete again", async () => {
  const root = mkdtemp("turma-mir-");
  const store = memStore();
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {}, log() {} });
  await m.hydrate();
  assert.equal(m.hydrated, true);
  store.list = async () => { throw new Error("down"); };
  await m.hydrate();
  assert.equal(m.hydrated, false);
});

test("persistent download failures log one summary per attempt, naming the cause", async () => {
  const root = mkdtemp("turma-mir-");
  const store = memStore();
  for (let i = 0; i < 50; i++) store.map.set(`repo/f${i}.jsonl`, Buffer.from("x"));
  store.map.set("repo/a.jsonl.raw/t/t.jsonl", Buffer.from("r"));
  let bad = 3; // three attempts fail every rendered GET with a 403
  const get = store.getToFile;
  store.getToFile = async (k, d) => { if (bad > 0) throw new Error("HTTP 403"); return get(k, d); };
  const logs = [];
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {}, log: (l) => logs.push(l) });
  await m.hydrateUntilListed({ firstDelayMs: 1, sleep: async () => { throw new Error("listed"); } });
  await m.retryBlockedUntilClear({ firstDelayMs: 1, sleep: async () => { bad--; } });
  assert.equal(m.blockedCount(), 0);
  const retries = logs.filter((l) => /retrying/.test(l));
  assert.equal(retries.length, 3);                // one line per attempt, not 50
  assert.equal(logs.length, 4, logs.join("\n"));  // + the raw-pending line; no per-key lines
  assert.doesNotMatch(retries[0], /\?\./);
  assert.match(retries[0], /50 rendered download\(s\) failed, e\.g\. .*HTTP 403/);
  assert.match(retries[0], /closed for 50 transcript\(s\) only/);
  assert.doesNotMatch(retries[0], /object store reachable/); // a 403 is not an outage
  assert.equal(logs.filter((l) => /raw-layer object/.test(l)).length, 1); // said once
});

test("archive.js refuses ingest for a blocked transcript only (XERK-1050)", async () => {
  const A = mkdtemp("turma-mir-arc-");
  process.env.ARCHIVE_DIR = path.join(A, "archive");
  process.env.ARCHIVE_DB = path.join(A, "archive", "index.db");
  delete require.cache[require.resolve("../archive.js")];
  const archive = require("../archive.js");
  const store = memStore();
  const mirror = new ArchiveMirror({ blobStore: store, archiveDir: archive.ARCHIVE_DIR,
    reindex: () => { archive.openDb(); archive.rebuildIndex(); }, log() {} });
  const meta = (slug) => ({ remoteKey: "github.com/x/turma", repo: "turma", worktree: `/w/${slug}`,
    slug, createdAt: "2026-07-10T00:00:00Z", summary: slug });
  const e = (t) => [{ uuid: t, role: "user", ts: "2026-07-10T00:00:00Z", text: t }];
  const len = (t) => Buffer.byteLength(JSON.stringify(e(t)[0]));
  for (const t of ["ta", "tb"]) archive.ingestChunk("h", t, meta(t), 0, len(t), e(t), "");
  archive.setRenderedGate((p) => mirror.renderedBlocked(p));
  const fileOf = (t) => path.join(archive.ARCHIVE_DIR, archive.sessionRow(t).filePath);
  const before = fs.readFileSync(fileOf("tb"));
  mirror._blocked.set(mirror.keyFor(fileOf("tb")), "repo/tb.jsonl (HTTP 403)");

  // Blocked: no progress, nothing written; the other transcript ingests normally.
  assert.deepEqual(archive.ingestChunk("h", "tb", meta("tb"), len("tb"), len("tb") * 2, e("tb"), ""),
    { bytesStored: len("tb") });
  assert.deepEqual(fs.readFileSync(fileOf("tb")), before);
  assert.equal(archive.ingestChunk("h", "ta", meta("ta"), len("ta"), len("ta") * 2, e("ta"), "").bytesStored,
    len("ta") * 2);
  // The inverted path does not want it; the manifest path still names its cursor.
  assert.deepEqual(archive.inventoryCursors("h",
    [{ i: "ta", s: len("ta") * 3 }, { i: "tb", s: len("tb") * 3 }], ""), { ta: len("ta") * 2 });
  assert.equal(archive.manifestCursors("h", [{ transcriptId: "tb" }], "").tb, len("tb"));
  assert.deepEqual(mirror.blockedPaths(), [fileOf("tb")]);
  assert.deepEqual(archive.missingFiledPaths(), []);

  // Recorded bytes with no local file (a 404, or never mirrored): blocked too.
  mirror._blocked.clear();
  fs.unlinkSync(fileOf("ta"));
  assert.deepEqual(archive.missingFiledPaths(), []); // not yet found
  archive.reconcileHydratedCursors();                // a hydrate finds it
  assert.deepEqual(archive.missingFiledPaths(), [fileOf("ta")]);
  assert.deepEqual(archive.ingestChunk("h", "ta", meta("ta"), len("ta") * 2, len("ta") * 3, e("ta"), ""),
    { bytesStored: len("ta") * 2 });
  assert.equal(fs.existsSync(fileOf("ta")), false);
  // A source cursor with no sidecar is blocked the same way (a `.meta` 404).
  fs.unlinkSync(fileOf("tb") + ".meta");
  assert.deepEqual(archive.ingestChunk("h", "tb", meta("tb"), len("tb"), len("tb") * 2, e("tb"), ""),
    { bytesStored: len("tb") });

  // A new transcript never takes a path whose object is still in the bucket.
  const taken = path.join(archive.ARCHIVE_DIR, archive.archiveRelPath("tc", { ...meta("tc"), host: "h", transcriptId: "tc" }));
  mirror._blocked.set(mirror.keyFor(taken), "x");
  archive.ingestChunk("h", "tc", meta("tc"), 0, len("tc"), e("tc"), "");
  assert.notEqual(fileOf("tc"), taken);

  // Unset (every non-HA path): inert.
  archive.setRenderedGate(null);
  assert.deepEqual(archive.missingFiledPaths(), []);
  archive.closeDb();
});

test("a late landing re-derives the cursor BEFORE it unblocks (XERK-1050 QA D1)", async () => {
  const A = mkdtemp("turma-mir-arc-");
  process.env.ARCHIVE_DIR = path.join(A, "archive");
  process.env.ARCHIVE_DB = path.join(A, "archive", "index.db");
  delete require.cache[require.resolve("../archive.js")];
  const archive = require("../archive.js");
  const store = memStore();
  let order = [];
  const mirror = new ArchiveMirror({ blobStore: store, archiveDir: archive.ARCHIVE_DIR,
    reindex() {}, log() {},
    onLanded: () => {
      // Still refused while the cursor is re-derived: no window with a stale one.
      order.push(archive.ingestChunk("h", "t", m, c2, c2 + 10, e("x"), "").bytesStored);
      archive.reconcileLanded(true);
    } });
  archive.setBlobSink((p) => mirror.note(p));
  const m = { repo: "turma", slug: "t", summary: "t", createdAt: "2026-07-10T00:00:00Z" };
  const e = (t) => [{ uuid: t, role: "user", ts: "2026-07-10T00:00:00Z", text: t }];
  const c1 = 100, c2 = 200;
  archive.ingestChunk("h", "t", m, 0, c1, e("a"), "");
  await mirror.drain();                       // the bucket holds chunk 1 only...
  archive.setBlobSink(null);
  archive.ingestChunk("h", "t", m, c1, c2, e("b"), ""); // ...the index, chunk 2
  const file = path.join(archive.ARCHIVE_DIR, archive.sessionRow("t").filePath);
  fs.unlinkSync(file); fs.unlinkSync(file + ".meta"); // a fresh replica's disk
  archive.setRenderedGate((p) => mirror.renderedBlocked(p));
  for (const k of [mirror.keyFor(file), mirror.keyFor(file + ".meta")]) mirror._blocked.set(k, k);

  assert.equal(await mirror.retryBlocked(), 2);
  assert.deepEqual(order, [c2]);                          // refused inside onLanded
  // Healed to the landed copy (a mismatched offset hands back the cursor).
  assert.equal(archive.ingestChunk("h", "t", m, 1, 2, [], "").bytesStored, c1);
  assert.equal(mirror.blockedCount(), 0);
  // The agent re-sends chunk 2 from the healed cursor; nothing is skipped.
  assert.equal(archive.ingestChunk("h", "t", m, c1, c2, e("b"), "").bytesStored, c2);
  assert.equal(archive.getTranscript("t").entries.map((x) => x.text).join(""), "ab");

  // A reconcile that throws (an index hydrate running) keeps it blocked.
  fs.unlinkSync(file); mirror._blocked.set(mirror.keyFor(file), "x");
  archive.setHydrating(true);
  assert.equal(await mirror.retryBlocked(), 0);
  assert.equal(mirror.blockedCount(), 1);
  archive.setHydrating(false);
  archive.setRenderedGate(null);
  archive.closeDb();
});

test("drain never PUTs a blocked key over the bucket's copy (XERK-1050)", async () => {
  const root = mkdtemp("turma-mir-");
  const f = path.join(root, "a.jsonl");
  fs.writeFileSync(f, "short");
  const store = memStore();
  const m = new ArchiveMirror({ blobStore: store, archiveDir: root, reindex() {} });
  m.note(f);
  m._blocked.set("a.jsonl", "x");
  assert.equal(await m.drain(), 0);
  assert.equal(m.pending(), 1);
  m._blocked.clear();
  assert.equal(await m.drain(), 1);
});
