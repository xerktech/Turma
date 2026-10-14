// The HA archive index mirror's overflow drop (XERK-1834). A full queue drops its
// OLDEST op; when that op was an entries append, later appends still landed at their
// own seqs and Postgres kept a hole. A dropped op now owes its transcript a REFILL
// from the local `.jsonl`. Own process: it requires server.js.

"use strict";

const path = require("path");
const fs = require("fs");
const { mkdtemp, scratchDir } = require("./tmpdirs");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "hubuser";
process.env.TURMA_PASSWORD = "hubpass";
process.env.TURMA_AGENT_TOKEN = "agenttok";
process.env.INDEX_MIRROR_QUEUE_MAX = "3";
process.env.INDEX_MIRROR_REFILL_RETRY_MS = "30";
const tmp = (name) => path.join(scratchDir(), `turma-idxrepair-${name}-${process.pid}.json`);
for (const [k, n] of [["DEVICES_FILE", "devices"], ["TICKET_AGENTS_FILE", "ticket-agents"],
  ["AUTOSTART_ORGS_FILE", "autostart-orgs"], ["TICKET_MODELS_FILE", "ticket-models"],
  ["ORG_COLORS_FILE", "org-colors"], ["USAGE_LEDGER_FILE", "usage-ledger"], ["STATE_FILE", "state"]]) {
  process.env[k] = tmp(n);
}
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-idxrepair-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-idxrepair-archive-");
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

const hub = require("../server.js");
const archive = require("../archive.js");

const META = { remoteKey: "github.com/xerk/turma", repo: "turma", host: "nas",
  createdAt: "2026-07-10T00:00:00Z", endedTs: "2026-07-10T01:00:00Z", summary: "A Session" };
const ent = (uuid, text) => ({ uuid, role: "user", ts: "2026-07-10T00:00:00Z", text });

// An in-memory PgIndexStore stand-in whose writes wait on `gate` while it is set, so
// ops pile up behind the first one. Entries upsert ON CONFLICT (id, seq) DO NOTHING.
function slowStore() {
  const s = {
    rows: new Map(), entries: new Map(), gate: null, log: [],
    async wait() { if (s.gate) await s.gate.p; },
    async upsertSession(row) { await s.wait(); s.rows.set(row.transcriptId, { ...row }); },
    async appendEntries(id, list, startSeq) {
      await s.wait();
      s.log.push(`append:${id}:${startSeq}`);
      const m = s.entries.get(id) || new Map();
      list.forEach((e, i) => { if (!m.has(startSeq + i)) m.set(startSeq + i, e.text); });
      s.entries.set(id, m);
    },
    async replaceEntries(id, list) {
      await s.wait();
      s.log.push(`replace:${id}:${list.length}`);
      s.entries.set(id, new Map(list.map((e, i) => [i, e.text])));
    },
    async deleteTranscript(id) { await s.wait(); s.rows.delete(id); s.entries.delete(id); },
    // PgIndexStore.transcriptCounts over the maps (the reconcile's Postgres side).
    async transcriptCounts(ids) {
      s.countCalls = (s.countCalls || 0) + 1;
      if (s.countDelay) await new Promise((r) => setTimeout(r, s.countDelay));
      const out = new Map();
      for (const id of ids) {
        const keys = [...(s.entries.get(id) || new Map()).keys()];
        const row = s.rows.get(id);
        out.set(id, { msgCount: row ? row.msgCount || 0 : null, n: keys.length,
          maxSeq: keys.length ? Math.max(...keys) : -1 });
      }
      return out;
    },
    hold() { let r; s.gate = { p: new Promise((res) => { r = res; }) }; s.gate.release = r; },
    release() { const g = s.gate; s.gate = null; g.release(); },
  };
  return s;
}
const seqs = (store, id) => [...(store.entries.get(id) || new Map()).entries()]
  .sort((a, b) => a[0] - b[0]).map(([seq, text]) => `${seq}:${text}`);

async function settle(mirror, ms = 2000) {
  const end = Date.now() + ms;
  while (mirror._running || mirror._q.length || mirror._refill.size) {
    if (Date.now() > end) throw new Error("mirror never settled");
    await new Promise((r) => setTimeout(r, 1));
  }
}

let off = 0;
function push(id, list) {
  const len = Buffer.byteLength(JSON.stringify(list));
  const r = archive.ingestChunk("nas", id, META, off, off + len, list, "acme");
  off = r.bytesStored;
}

// The leader gate the hub injects (isLeader, leaderTerm); a promotion bumps the term.
let leading = true;
let term = 0;
function setup() {
  archive.closeDb();
  fs.rmSync(process.env.ARCHIVE_DIR, { recursive: true, force: true });
  off = 0;
  const store = slowStore();
  leading = true;
  term = 0;
  const mirror = new hub.IndexMirror(store, () => leading, () => term);
  archive.setIndexSink(mirror.sink());
  archive.setIndexMode("pg", store);
  return { store, mirror };
}
function teardown() { archive.setIndexSink(null); archive.setIndexMode(null); archive.closeDb(); }

test("an append dropped on overflow is refilled: Postgres ends with no seq gap", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0"), ent("n1", "n1"), ent("n2", "n2")]);
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:n1", "2:n2"]);

    // A slow op holds the drain; the queue (max 3) then overflows and the oldest
    // queued op, the a3 append, is dropped.
    store.hold();
    archive.setIndexSink(mirror.sink());
    mirror.sink().session({ transcriptId: "other" });          // in flight, blocked
    for (const a of ["a3", "a4", "a5", "a6"]) push("t", [ent(a, a)]);
    assert.ok(mirror._dropped > 0, "the queue overflowed");
    store.release();
    await settle(mirror);

    assert.deepEqual(seqs(store, "t"),
      ["0:n0", "1:n1", "2:n2", "3:a3", "4:a4", "5:a5", "6:a6"]);
    assert.equal(store.rows.get("t").msgCount, 7, "the row is re-sent too");
  } finally { teardown(); }
});

test("a refill whose local file is gone is skipped, never replaced with nothing", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0")]);
    await settle(mirror);
    fs.rmSync(path.join(process.env.ARCHIVE_DIR, archive.sessionRow("t").filePath));
    mirror._refill.set("t", term);
    mirror._drain();
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0"]);
  } finally { teardown(); }
});

test("an op that fails every retry is refilled", async () => {
  const { store, mirror } = setup();
  try {
    let fail = 3;
    const append = store.appendEntries;
    store.appendEntries = async (...a) => { if (fail-- > 0) throw new Error("down"); return append(...a); };
    push("t", [ent("n0", "n0"), ent("n1", "n1")]);
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:n1"], "refill replaced the dropped append");
  } finally { teardown(); }
});

test("a refill waits for the queue to drain: it runs after every op queued before it", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0")]);
    await settle(mirror);
    store.log.length = 0;
    store.hold();
    mirror.sink().session({ transcriptId: "other" });          // in flight, blocked
    mirror._refill.set("t", term);
    push("t", [ent("a1", "a1")]);
    push("t", [ent("a2", "a2")]);
    store.release();
    await settle(mirror);
    assert.deepEqual(store.log, ["append:t:1", "append:t:2", "replace:t:3"]);
  } finally { teardown(); }
});

test("a retried refill sends what the file holds when it RUNS, so a newer append survives", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0"), ent("n1", "n1")]);
    await settle(mirror);
    // The repair's first try fails after a7 was ingested behind it; the retry is
    // re-queued behind that append and must not replace with a stale snapshot.
    const replace = store.replaceEntries;
    let first = true;
    store.replaceEntries = async (id, list) => {
      if (first) { first = false; push("t", [ent("a2", "a2")]); throw new Error("blip"); }
      return replace(id, list);
    };
    mirror._refill.set("t", term);
    mirror._drain();
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:n1", "2:a2"]);
  } finally { teardown(); }
});

test("a refill failing through an outage stays owed and lands once Postgres is back", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0")]);
    await settle(mirror);
    const append = store.appendEntries;
    const replace = store.replaceEntries;
    let down = true;
    store.appendEntries = async (...a) => { if (down) throw new Error("ECONNREFUSED"); return append(...a); };
    store.replaceEntries = async (...a) => { if (down) throw new Error("ECONNREFUSED"); return replace(...a); };
    push("t", [ent("a1", "a1")]);
    push("t", [ent("a2", "a2")]);
    // Every op and the repair have failed; the drain has stopped, the repair is owed.
    while (mirror._running) await new Promise((r) => setTimeout(r, 1));
    assert.ok(mirror._refill.has("t"), "the failed refill is still owed");
    assert.ok(mirror._refillAfter > Date.now() - 5, "and held off for the retry interval");
    down = false;
    await settle(mirror);                                       // the retry timer fires
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:a1", "2:a2"]);
  } finally { teardown(); }
});

test("a refill re-sends the session row as well as the entries", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0"), ent("n1", "n1")]);
    await settle(mirror);
    store.rows.set("t", { transcriptId: "t", msgCount: 0 });     // a dropped row write
    mirror._refill.set("t", term);
    mirror._drain();
    await settle(mirror);
    assert.equal(store.rows.get("t").msgCount, 2);
  } finally { teardown(); }
});

test("a refill runs only while leading under the term it was owed in", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0"), ent("n1", "n1")]);
    await settle(mirror);
    store.entries.set("t", new Map([[0, "n0"], [1, "n1"], [2, "theirs"]]));
    leading = false;
    mirror._refill.set("t", term);
    mirror._drain();
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:n1", "2:theirs"], "no refill while deposed");
    // Owed under an earlier term, then this replica wins the lease back: still skipped.
    leading = true;
    mirror._refill.set("t", term);
    term++;
    mirror._drain();
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:n1", "2:theirs"], "no refill from an earlier term");
  } finally { teardown(); }
});

test("a refill still QUEUED (a retry) from an earlier term is skipped after a promotion", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0"), ent("n1", "n1")]);
    await settle(mirror);
    store.hold();
    mirror.sink().session({ transcriptId: "other" });          // in flight, blocked
    mirror._q.push({ t: "refill", transcriptId: "t", term, _tries: 1 });
    // Deposed, another leader appends, re-promoted — all while those ops wait.
    store.entries.set("t", new Map([[0, "n0"], [1, "n1"], [2, "theirs"]]));
    term++;
    store.release();
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:n1", "2:theirs"]);
  } finally { teardown(); }
});

test("a replace queued before a promotion, or while not leading, still lands (boot backfill)", async () => {
  const { store, mirror } = setup();
  try {
    leading = false;
    store.hold();
    mirror.sink().session({ transcriptId: "other" });          // in flight, blocked
    mirror.sink().replace("t", [{ text: "x0" }, { text: "x1" }]);
    term++;                                    // promoted meanwhile
    store.release();
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:x0", "1:x1"]);
  } finally { teardown(); }
});

test("an append queued in an earlier term still runs after a promotion", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0")]);
    await settle(mirror);
    store.hold();
    mirror.sink().session({ transcriptId: "other" });          // in flight, blocked
    mirror.sink().entries("t", [{ text: "e1" }], 1);
    term++;
    store.release();
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:e1"]);
  } finally { teardown(); }
});

test("a drop under the current term re-owes a refill an earlier term left owed", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0")]);
    await settle(mirror);
    mirror._refill.set("t", term);                             // owed under term 0
    term++;                                                    // promoted meanwhile
    store.hold();
    mirror.sink().session({ transcriptId: "other" });          // in flight, blocked
    for (const a of ["a1", "a2", "a3", "a4"]) push("t", [ent(a, a)]);
    assert.equal(mirror._refill.get("t"), term, "re-stamped under the current term");
    store.release();
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:a1", "2:a2", "3:a3", "4:a4"]);
  } finally { teardown(); }
});

test("a refill sends nothing while deposed, and hands replaceEntries the leader gate", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0")]);
    await settle(mirror);
    store.rows.set("t", { transcriptId: "t", msgCount: 99 });
    leading = false;
    mirror._refill.set("t", term);
    mirror._drain();
    await settle(mirror);
    assert.equal(store.rows.get("t").msgCount, 99, "no row upsert while deposed");
    leading = true;
    let proceed;
    const replace = store.replaceEntries;
    store.replaceEntries = async (id, list, p) => { proceed = p; return replace(id, list); };
    mirror._refill.set("t", term);
    mirror._drain();
    await settle(mirror);
    assert.equal(typeof proceed, "function");
    assert.equal(proceed(), true);
    term++;
    assert.equal(proceed(), false, "the gate turns false once the term moves");
  } finally { teardown(); }
});

test("a dropped duplicate repair or remove is not owed a refill", () => {
  const { mirror } = setup();
  try {
    mirror._lost({ t: "repair", transcriptId: "t" });
    mirror._lost({ t: "remove", transcriptId: "t" });
    assert.equal(mirror._refill.size, 0);
  } finally { teardown(); }
});

test("an exhausted refill never overwrites a refill owed since under a newer term", () => {
  const { mirror } = setup();
  try {
    mirror._refill.set("t", 2);
    mirror._lost({ t: "refill", transcriptId: "t", term: 1 });
    assert.equal(mirror._refill.get("t"), 2);
  } finally { teardown(); }
});

test("the owed set is capped at the queue size", () => {
  const { mirror } = setup();
  try {
    for (const id of ["a", "b", "c", "d"]) mirror._lost({ t: "entries", transcriptId: id });
    assert.equal(mirror._refill.size, 3);
  } finally { teardown(); }
});

test("a refill stops before replacing when the term moves after its row upsert", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0")]);
    await settle(mirror);
    store.entries.set("t", new Map([[0, "n0"], [1, "theirs"]]));
    const upsert = store.upsertSession;
    store.upsertSession = async (row) => { await upsert(row); term++; };
    mirror._refill.set("t", term);
    mirror._drain();
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:theirs"]);
  } finally { teardown(); }
});

test("a refill Postgres refuses outright is given up, not retried forever", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0")]);
    await settle(mirror);
    let calls = 0;
    store.replaceEntries = async () => {
      calls++;
      const e = new Error("postgres: ERROR (22021) invalid byte sequence");
      e.pgError = { C: "22021" };
      throw e;
    };
    mirror._refill.set("t", term);
    mirror._drain();
    await settle(mirror);
    assert.equal(calls, 3);
    assert.equal(mirror._refill.size, 0);
  } finally { teardown(); }
});

test("a NUL in an entry is dropped from what is mirrored (Postgres refuses it)", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "bad\u0000text")]);
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:badtext"]);
    assert.equal(archive.mirrorRefillOf("t").entries[0].text, "badtext");
    // ...and from the session row's strings.
    off = 0;
    push("s", [ent("m0", "ok")]);
    archive.ingestChunk("nas", "s", { ...META, summary: "bad\u0000sum" }, off, off, [], "acme");
    await settle(mirror);
    assert.equal(store.rows.get("s").summary, "badsum");
    assert.equal(archive.mirrorRefillOf("s").row.summary, "badsum");
  } finally { teardown(); }
});

test("mirrorRefillOf: nothing for a placeholder row with no file yet", () => {
  setup();
  try {
    archive.manifestCursors("nas", [{ transcriptId: "t-ph", remoteKey: "rk", repo: "turma" }], "acme");
    assert.ok(archive.sessionRow("t-ph"), "the placeholder row exists");
    assert.equal(archive.mirrorRefillOf("t-ph"), null);
  } finally { teardown(); }
});

// ---- the periodic leader-only reconcile (XERK-1701) --------------------------
// It closes what the owed set cannot: a drop past its cap, a refill a deposition
// dropped, a gated replace skipped after a term change.

test("reconcile: a transcript dropped past the owed-set cap heals, ahead of a backlog", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0")]);
    await settle(mirror);
    // The owed set is full (cap 3) of other ids, so t's overflow drop is not tracked.
    for (const id of ["x1", "x2", "x3"]) mirror._refill.set(id, term);
    mirror._refillAfter = Date.now() + 60000;                  // and held off
    store.hold();
    mirror.sink().session({ transcriptId: "other" });          // in flight, blocked
    for (const a of ["a1", "a2", "a3", "a4"]) push("t", [ent(a, a)]);
    assert.ok(!mirror._refill.has("t"), "t is not owed: the set was full");
    store.release();
    while (mirror._running) await new Promise((r) => setTimeout(r, 1));
    assert.ok(!store.entries.get("t").has(1), "a seq hole");

    // A backlog is queued; the reconcile's refill goes to the HEAD, not behind it.
    store.hold();
    mirror.sink().session({ transcriptId: "other" });          // in flight, blocked
    mirror.sink().session({ transcriptId: "other" });          // queued
    const reconciled = mirror.reconcile();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(mirror._q[0] && mirror._q[0].t, "refill");
    assert.equal(mirror._q[0].transcriptId, "t");
    store.release();
    assert.equal(await reconciled, 1);
    mirror._refill.clear();
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:a1", "2:a2", "3:a3", "4:a4"]);
    assert.equal(await mirror.reconcile(), 0, "converged: nothing left to re-send");
  } finally { teardown(); }
});

test("reconcile: a refill a deposed replica dropped heals under the new leader", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0"), ent("n1", "n1"), ent("n2", "n2")]);
    await settle(mirror);
    store.entries.get("t").delete(1);                          // the dropped op's hole
    mirror._refill.set("t", term);                             // owed under term 0...
    leading = false;                                           // ...but deposed first
    mirror._drain();
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "2:n2"], "the deposed replica dropped it");
    assert.equal(await mirror.reconcile(), 0, "a follower never reconciles");
    assert.equal(store.countCalls || 0, 0, "nor asks Postgres");

    // The new leader (its own mirror, a later term) finds the hole and re-sends.
    leading = true;
    term++;
    const next = new hub.IndexMirror(store, () => leading, () => term);
    archive.setIndexSink(next.sink());
    assert.equal(await next.reconcile(), 1);
    await settle(next);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:n1", "2:n2"]);
  } finally { teardown(); }
});

test("reconcile: a gated replace skipped after a term change heals", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0"), ent("n1", "n1"), ent("n2", "n2")]);
    await settle(mirror);
    store.entries.set("t", new Map([[0, "n0"]]));              // Postgres lost the tail
    store.hold();
    mirror.sink().session({ transcriptId: "other" });          // in flight, blocked
    mirror.sink().replace("t", archive.mirrorRefillOf("t").entries, true);
    term++;                                                    // lease lost and won back
    store.release();
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0"], "the heal replace was skipped");
    assert.equal(await mirror.reconcile(), 1);
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:n1", "2:n2"]);
  } finally { teardown(); }
});

test("reconcile: never trims rows past a local copy that is behind, nor races a queued op", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0"), ent("n1", "n1")]);
    await settle(mirror);
    // Another leader appended past this copy (and left a hole below it): leave it be.
    store.entries.set("t", new Map([[0, "n0"], [2, "theirs"]]));
    assert.equal(await mirror.reconcile(), 0);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "2:theirs"]);
    // Behind only because an append is still queued: not a heal.
    store.entries.set("t", new Map([[0, "n0"], [1, "n1"]]));
    store.hold();
    mirror.sink().session({ transcriptId: "other" });          // in flight, blocked
    push("t", [ent("a2", "a2")]);
    const r = mirror.reconcile();
    store.release();
    assert.equal(await r, 0);
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:n1", "2:a2"]);
  } finally { teardown(); }
});

test("reconcile: bounded per tick, resuming from its cursor", async () => {
  const { store, mirror } = setup();
  try {
    for (const id of ["a", "b", "c"]) { off = 0; push(id, [ent(`${id}0`, `${id}0`)]); }
    await settle(mirror);
    for (const id of ["a", "b", "c"]) store.entries.delete(id);
    store.countDelay = 40;
    // One batch of two per tick: the budget runs out during the first round trip.
    assert.equal(await mirror.reconcile({ batch: 2, budgetMs: 10 }), 2);
    assert.equal(store.countCalls, 1);
    assert.equal(mirror._reconcileCursor, "b");
    await settle(mirror);
    assert.equal(await mirror.reconcile({ batch: 2, budgetMs: 10 }), 1, "the next tick resumes at c");
    await settle(mirror);
    for (const id of ["a", "b", "c"]) assert.deepEqual(seqs(store, id), [`0:${id}0`]);
    // The end of the pass wraps to the start.
    store.entries.delete("a");
    assert.equal(await mirror.reconcile({ batch: 2, budgetMs: 10 }), 1);
  } finally { teardown(); }
});

test("reconcile: inert with HA off (sqlite index, no mirror, no timer)", async () => {
  archive.closeDb();
  archive.setIndexMode(null);
  const store = slowStore();
  const mirror = new hub.IndexMirror(store, () => true, () => 0);
  try {
    assert.deepEqual(archive.reconcileCandidates("", 10), []);
    assert.equal(await mirror.reconcile(), 0);
    assert.equal(store.countCalls || 0, 0);
    hub.setIndexMirror(store, false);
    assert.equal(hub.getIndexMirror(), null);
  } finally { archive.closeDb(); }
});

test("reconcile: a seq hole heals even while the transcript still has writes queued", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0"), ent("n1", "n1"), ent("n2", "n2")]);
    await settle(mirror);
    store.entries.get("t").delete(1);                          // a dropped append's hole
    store.hold();
    mirror.sink().session({ transcriptId: "other" });          // in flight, blocked
    push("t", [ent("a3", "a3")]);                              // sustained traffic on t
    const r = mirror.reconcile();
    await new Promise((res) => setTimeout(res, 5));
    store.release();
    assert.equal(await r, 1, "a hole is never just in flight");
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:n1", "2:n2", "3:a3"]);
  } finally { teardown(); }
});

// ---- reconcile QA fixes (XERK-1701) ------------------------------------------

const jsonlOf = (id) => path.join(process.env.ARCHIVE_DIR, archive.sessionRow(id).filePath);
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("reconcile: a full queue drops the oldest PLAIN op, never the reconcile's head refill", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0"), ent("n1", "n1"), ent("n2", "n2")]);
    await settle(mirror);
    store.entries.get("t").delete(1);                          // a hole
    store.hold();
    mirror.sink().session({ transcriptId: "other" });          // in flight, blocked
    for (const id of ["f0", "f1", "f2"]) mirror.sink().session({ transcriptId: id }); // full (3)
    assert.equal(await mirror.reconcile(), 1);
    assert.equal(mirror._q[0].t, "refill");
    mirror.sink().session({ transcriptId: "late" });           // overflows
    assert.equal(mirror._q[0].t, "refill", "the refill survives the overflow");
    assert.equal(mirror._q[0].transcriptId, "t");
    assert.deepEqual(mirror._q.slice(1).map((o) => o.row.transcriptId), ["f1", "f2", "late"]);
    assert.ok(!mirror._refill.has("t"), "not pushed back into the owed set");
    assert.ok(mirror._refill.has("f0"), "the dropped plain op is owed instead");
    store.release();
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:n1", "2:n2"]);
  } finally { teardown(); }
});

test("reconcile: a queue of nothing but refills drops the incoming plain op", async () => {
  const { store, mirror } = setup();
  try {
    store.hold();
    mirror.sink().session({ transcriptId: "other" });          // in flight, blocked
    for (const id of ["r0", "r1", "r2"]) mirror._q.push({ t: "refill", transcriptId: id, term });
    mirror.sink().session({ transcriptId: "late" });
    assert.deepEqual(mirror._q.map((o) => o.t), ["refill", "refill", "refill"]);
    assert.ok(mirror._refill.has("late"));
    store.release();
    await settle(mirror);
  } finally { teardown(); }
});

test("an exhausted refill is owed only within the owed-set cap", () => {
  const { mirror } = setup();
  try {
    for (const id of ["a", "b", "c"]) mirror._lost({ t: "entries", transcriptId: id });
    mirror._lost({ t: "refill", transcriptId: "d", term });
    assert.equal(mirror._refill.size, 3);
    assert.ok(!mirror._refill.has("d"));
  } finally { teardown(); }
});

test("reconcile: a torn final line (msgCount above the parsed entries) is re-sent once, not every tick", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0"), ent("n1", "n1"), ent("n2", "n2")]);
    await settle(mirror);
    fs.appendFileSync(jsonlOf("t"), '{"uuid":"tor\n');         // a crash mid-append
    archive.reconcileHydratedCursors();                         // counts lines: 4
    assert.equal(archive.sessionRow("t").msgCount, 4);
    store.entries.get("t").delete(1);
    assert.equal(await mirror.reconcile(), 1);
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:n1", "2:n2"]);
    const replaces = store.log.filter((l) => l.startsWith("replace:t")).length;
    assert.equal(await mirror.reconcile(), 0, "Postgres holds what the file parses to");
    assert.equal(await mirror.reconcile(), 0);
    assert.equal(store.log.filter((l) => l.startsWith("replace:t")).length, replaces);
    // New damage is still healed.
    store.entries.get("t").delete(0);
    assert.equal(await mirror.reconcile(), 1);
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:n1", "2:n2"]);
  } finally { teardown(); }
});

test("reconcile: a refill record stops masking once the local count moves", () => {
  // QA (rollup XERK-1701): Postgres holding what the last refill sent only means "done"
  // while the local count is the one that refill ran at. A later append whose session row
  // landed but whose entry was dropped untracked must still heal.
  const { mirror } = setup();
  try {
    mirror._refilled.set("t", { local: 4, sent: 3 });
    const p = { msgCount: 5, n: 3, maxSeq: 2 };
    assert.equal(mirror._reconcileHeals({ transcriptId: "t", msgCount: 5 }, p, new Map()), true);
    assert.equal(mirror._reconcileHeals({ transcriptId: "t", msgCount: 4 },
      { msgCount: 4, n: 3, maxSeq: 2 }, new Map()), false, "unchanged: still masked");
  } finally { teardown(); }
});

test("reconcile: the refill record is bounded like the owed set, oldest first", () => {
  const { mirror } = setup();
  try {
    for (const id of ["a", "b", "c", "d", "e"]) mirror._noteRefilled(id, 4, 3);
    assert.deepEqual([...mirror._refilled.keys()], ["c", "d", "e"]);
  } finally { teardown(); }
});

test("reconcile: queues at most one batch of refills, the rest resume next tick", async () => {
  const { store, mirror } = setup();
  try {
    for (const id of ["a", "b", "c"]) { off = 0; push(id, [ent(`${id}0`, `${id}0`)]); }
    await settle(mirror);
    for (const id of ["a", "b", "c"]) store.entries.delete(id);
    store.hold();                                               // nothing drains
    assert.equal(await mirror.reconcile({ batch: 2, budgetMs: 5000 }), 2);
    assert.equal(mirror._reconcileCursor, "b", "stopped before c");
    assert.equal(await mirror.reconcile({ batch: 2, budgetMs: 5000 }), 0,
      "a batch of refills is still waiting: no more");
    store.release();
    await settle(mirror);
    assert.equal(await mirror.reconcile({ batch: 2, budgetMs: 5000 }), 1, "c, next tick");
    await settle(mirror);
    for (const id of ["a", "b", "c"]) assert.deepEqual(seqs(store, id), [`0:${id}0`]);
  } finally { teardown(); }
});

test("reconcile: a batch is clamped to what one Postgres statement can bind", async () => {
  const { mirror } = setup();
  const orig = archive.reconcileCandidates;
  const limits = [];
  archive.reconcileCandidates = (after, limit) => { limits.push(limit); return []; };
  try {
    await mirror.reconcile({ batch: 50000, budgetMs: 50 });
    assert.ok(limits.length && limits.every((l) => l <= 10000), `limits ${limits}`);
  } finally { archive.reconcileCandidates = orig; teardown(); }
});

test("reconcile: a refill re-sends first copies only (an unrepaired duplicate line)", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0"), ent("n1", "n1"), ent("n2", "n2")]);
    await settle(mirror);
    const lines = fs.readFileSync(jsonlOf("t"), "utf8").split("\n");
    fs.writeFileSync(jsonlOf("t"), [lines[0], ...lines].join("\n"));
    assert.equal(archive.mirrorRefillOf("t").entries.length, 3);
    store.entries.get("t").delete(2);
    assert.equal(await mirror.reconcile(), 1);
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:n1", "2:n2"]);
  } finally { teardown(); }
});

test("reconcile: deposed or re-termed during a Postgres round trip, it queues nothing", async () => {
  for (const flip of [() => { leading = false; }, () => { term++; }]) {
    const { store, mirror } = setup();
    try {
      push("t", [ent("n0", "n0"), ent("n1", "n1"), ent("n2", "n2")]);
      await settle(mirror);
      store.entries.get("t").delete(1);
      store.countDelay = 30;
      const r = mirror.reconcile();
      await tick();
      flip();
      assert.equal(await r, 0);
      assert.ok(!mirror._q.some((o) => o.t === "refill"));
    } finally { teardown(); }
  }
});

test("reconcile: skipped while the index hydrates, before or during a round trip", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0"), ent("n1", "n1"), ent("n2", "n2")]);
    await settle(mirror);
    store.entries.get("t").delete(1);
    archive.setHydrating(true);
    assert.equal(await mirror.reconcile(), 0);
    assert.equal(store.countCalls || 0, 0, "Postgres is not asked");
    archive.setHydrating(false);
    store.countDelay = 30;
    const r = mirror.reconcile();
    await tick();
    archive.setHydrating(true);
    assert.equal(await r, 0);
    assert.ok(!mirror._q.some((o) => o.t === "refill"));
  } finally { archive.setHydrating(false); teardown(); }
});

test("reconcile: single-flight, overlapping calls share one run", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0"), ent("n1", "n1"), ent("n2", "n2")]);
    await settle(mirror);
    store.entries.get("t").delete(1);
    store.countDelay = 20;
    const a = mirror.reconcile();
    const b = mirror.reconcile();
    assert.equal(a, b);
    assert.equal(await a, 1);
    assert.equal(store.countCalls, 1);
    await settle(mirror);
  } finally { teardown(); }
});

test("reconcile: an id already holding a queued refill is not queued again", async () => {
  const { store, mirror } = setup();
  try {
    push("t", [ent("n0", "n0"), ent("n1", "n1"), ent("n2", "n2")]);
    await settle(mirror);
    store.entries.get("t").delete(1);                          // a hole: always healed
    store.hold();
    mirror.sink().session({ transcriptId: "other" });          // in flight, blocked
    mirror._q.push({ t: "refill", transcriptId: "t", term });
    assert.equal(await mirror.reconcile(), 0);
    assert.equal(mirror._q.filter((o) => o.t === "refill").length, 1);
    store.release();
    await settle(mirror);
    assert.deepEqual(seqs(store, "t"), ["0:n0", "1:n1", "2:n2"]);
  } finally { teardown(); }
});

test("reconcileCandidates leaves out a pending duplicate repair and a blocked download", async () => {
  const { mirror } = setup();
  const errOrig = console.error;
  console.error = () => {};
  try {
    for (const id of ["d", "g", "u"]) { off = 0; push(id, [ent(`${id}0`, `${id}0`), ent(`${id}1`, `${id}1`)]); }
    await settle(mirror);
    const ids = () => archive.reconcileCandidates("", 10).map((r) => r.transcriptId);
    assert.deepEqual(ids(), ["d", "g", "u"]);
    // d: a duplicate line whose repair Postgres never confirms (this store has no setCounts).
    const lines = fs.readFileSync(jsonlOf("d"), "utf8").split("\n");
    fs.writeFileSync(jsonlOf("d"), [lines[0], ...lines].join("\n"));
    await archive.dedupArchive({ publish: true });
    await settle(mirror);
    assert.deepEqual(ids(), ["g", "u"], "the repair owns d");
    // g: its rendered download is blocked.
    const gPath = jsonlOf("g");
    archive.setRenderedGate((p) => p === gPath);
    assert.deepEqual(ids(), ["u"]);
  } finally { console.error = errOrig; archive.setRenderedGate(null); teardown(); }
});

test("reconcile: the timer exists only with HA on", () => {
  const origSet = global.setInterval;
  const origClear = global.clearInterval;
  const made = [];
  let cleared = 0;
  global.setInterval = (fn, ms, ...a) => { const t = origSet(fn, ms, ...a); made.push({ ms, t }); return t; };
  global.clearInterval = (t) => { cleared++; return origClear(t); };
  const store = slowStore();
  try {
    hub.setIndexMirror(store, false);
    assert.equal(made.length, 0, "HA off: no timer");
    hub.setIndexMirror(store, true);
    assert.equal(made.length, 1, "HA on: one timer");
    assert.equal(made[0].t.hasRef(), false, "unref'd");
    hub.setIndexMirror(store, false);
    assert.equal(made.length, 1);
    assert.ok(cleared >= 1, "turning HA off stops it");
  } finally {
    global.setInterval = origSet;
    global.clearInterval = origClear;
    hub.setIndexMirror(null, false);
    for (const m of made) origClear(m.t);
    archive.closeDb();
  }
});
