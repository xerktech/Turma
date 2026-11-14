"use strict";
// A settled meeting's full transcript (XERK-2941).
//
// The proposal store (`meetingProposals`) is written whole on every change, so it
// keeps a meeting's captions only while the meeting is waiting to be read
// (contract-meetings.md, "Why the byte budget"). The operator still wants to read
// the whole meeting afterwards, so each transcript ALSO lands here, one document
// per meeting, read on demand by `GET /api/orgs/<site>/meetings/<id>/transcript`.
//
// - Off HA: one JSON file per meeting under `dir` (/data, the persisted volume).
// - HA: the same file as a per-pod cache, plus a Postgres row (`meeting_transcript`)
//   as the of-record — `/data` is a per-pod emptyDir there, so a promoted leader
//   reads the row on a local miss. Never the archive bucket: its hydrate lists and
//   pulls every key in it.
//
// A document is keyed by its row's identity (meetingId + the hub-minted receivedAt),
// never by the org key, so a tenant migration re-keying the org leaves it found.
// The route only ever reads it through a row the caller may see.
//
// Nothing here throws to a caller; every store failure is logged and retried.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TABLE = "meeting_transcript";

function keyOf(meetingId, receivedAt) {
  return crypto.createHash("sha256").update(`${meetingId}\0${receivedAt}`).digest("hex").slice(0, 40);
}

function makeTranscriptStore({ dir, pool = null, log = console } = {}) {
  const fileOf = (key) => path.join(dir, `${key}.json`);
  // Keys saved locally whose Postgres write has not landed yet (HA only).
  const unsynced = new Set();
  let schemaReady = null;

  function ensureSchema() {
    if (!pool) return Promise.resolve(false);
    if (!schemaReady) {
      schemaReady = pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
        key text PRIMARY KEY, doc text NOT NULL, saved_at bigint NOT NULL)`)
        .then(() => true, (e) => { schemaReady = null; throw e; });
    }
    return schemaReady;
  }

  async function pushRow(key) {
    let doc;
    try { doc = fs.readFileSync(fileOf(key), "utf8"); } catch { unsynced.delete(key); return; }
    try {
      await ensureSchema();
      await pool.query(`INSERT INTO ${TABLE} (key, doc, saved_at) VALUES ($1, $2, $3)
        ON CONFLICT (key) DO NOTHING`, [key, doc, Date.now()]);
      unsynced.delete(key);
    } catch (e) {
      log.error(`meeting transcripts: saving ${key} to postgres failed (retried): ${e && e.message}`);
    }
  }

  // Store one meeting's transcript. Synchronous on disk (the caller answers 200
  // right after); the Postgres copy follows off the request path.
  function save(meetingId, receivedAt, doc) {
    const key = keyOf(meetingId, receivedAt);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${fileOf(key)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ meetingId, receivedAt, ...doc }));
      fs.renameSync(tmp, fileOf(key));
    } catch (e) {
      log.error(`meeting transcripts: writing ${key} failed: ${e && e.message}`);
      return false;
    }
    if (pool) { unsynced.add(key); pushRow(key); }
    return true;
  }

  function has(meetingId, receivedAt) {
    return fs.existsSync(fileOf(keyOf(meetingId, receivedAt)));
  }

  // The stored document, or null when none was kept. Only a document naming the
  // same meeting counts (a hash collision reads as absent, never as another's).
  async function load(meetingId, receivedAt) {
    const key = keyOf(meetingId, receivedAt);
    let text = null;
    try { text = fs.readFileSync(fileOf(key), "utf8"); } catch { text = null; }
    if (text === null && pool) {
      try {
        await ensureSchema();
        const rows = await pool.query(`SELECT doc FROM ${TABLE} WHERE key = $1`, [key]);
        text = rows && rows[0] ? rows[0].doc : null;
      } catch (e) {
        log.error(`meeting transcripts: reading ${key} from postgres failed: ${e && e.message}`);
        throw new Error("the transcript store is unreachable");
      }
    }
    if (text === null) return null;
    try {
      const doc = JSON.parse(text);
      return doc && doc.meetingId === meetingId && doc.receivedAt === receivedAt ? doc : null;
    } catch {
      return null;
    }
  }

  // Drop every document no live row names (`liveKeys`: a Set of keyOf values).
  // Local files every call; Postgres rows when `withRemote` (the caller spaces it).
  async function sweep(liveKeys, { withRemote = false } = {}) {
    let removed = 0;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    for (const name of names) {
      const m = /^([0-9a-f]{40})\.json$/.exec(name);
      // A stray temp file from a killed write is swept too.
      if (!m && !/\.tmp$/.test(name)) continue;
      if (m && liveKeys.has(m[1])) continue;
      try { fs.unlinkSync(path.join(dir, name)); removed++; } catch { /* gone */ }
      if (m) unsynced.delete(m[1]);
    }
    if (pool) {
      for (const key of [...unsynced]) await pushRow(key);
      if (withRemote) {
        try {
          await ensureSchema();
          const rows = await pool.query(`SELECT key FROM ${TABLE}`);
          const dead = (rows || []).map((r) => r.key).filter((k) => !liveKeys.has(k));
          // Plain text params only (no array encoding), a bounded batch per statement.
          for (let i = 0; i < dead.length; i += 500) {
            const batch = dead.slice(i, i + 500);
            await pool.query(`DELETE FROM ${TABLE} WHERE key IN (${batch.map((_, j) => `$${j + 1}`).join(", ")})`, batch);
            removed += batch.length;
          }
        } catch (e) {
          log.error(`meeting transcripts: postgres sweep failed: ${e && e.message}`);
        }
      }
    }
    return removed;
  }

  return { save, has, load, sweep, keyOf, _unsynced: unsynced };
}

module.exports = { makeTranscriptStore, keyOf, TABLE };
