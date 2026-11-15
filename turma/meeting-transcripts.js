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
  const KEY_RE = /^[0-9a-f]{40}$/;
  const fileOf = (key) => {
    // A key is only ever keyOf's hex digest (or a listed name the sweep matched
    // against the same shape), so it can never name a path outside `dir`.
    if (!KEY_RE.test(key)) throw new Error(`not a transcript key: ${String(key).slice(0, 60)}`);
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    return path.join(dir, `${key}.json`);
  };
  const SAVE_GRACE_MS = 5 * 60e3;
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

  // Which of `rows` ({meetingId, receivedAt}) have no document kept — locally, nor
  // (HA) in Postgres, asked in one statement per 500. Throws when Postgres is
  // unreachable: "can't tell" must never read as "missing" (XERK-2965).
  async function missing(rows) {
    let out = rows.filter((r) => !has(r.meetingId, r.receivedAt));
    if (!pool || !out.length) return out;
    await ensureSchema();
    const found = new Set();
    for (let i = 0; i < out.length; i += 500) {
      const keys = out.slice(i, i + 500).map((r) => keyOf(r.meetingId, r.receivedAt));
      const res = await pool.query(`SELECT key FROM ${TABLE} WHERE key IN (${keys.map((_, j) => `$${j + 1}`).join(", ")})`, keys);
      for (const r of res || []) found.add(r.key);
    }
    out = out.filter((r) => !found.has(keyOf(r.meetingId, r.receivedAt)));
    return out;
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

  // Plain text params only (no array encoding), a bounded batch per statement.
  async function deleteRows(keys) {
    let n = 0;
    for (let i = 0; i < keys.length; i += 500) {
      const batch = keys.slice(i, i + 500);
      await pool.query(`DELETE FROM ${TABLE} WHERE key IN (${batch.map((_, j) => `$${j + 1}`).join(", ")})`, batch);
      n += batch.length;
    }
    return n;
  }

  // Drop every document no live row names, then hold the store to `maxBytes`.
  // `live`: Map keyOf -> {tenant, at} (the row's tenant and receivedAt).
  // - A document saved within SAVE_GRACE_MS is never deleted: one saved between
  //   the caller building `live` and the delete would otherwise go (QA D2).
  // - Over the budget the tenant holding the most bytes loses its OLDEST
  //   transcript first, so one tenant never evicts another's (the XERK-2621 rule);
  //   its row stays and reads "no transcript kept".
  // Local files every call; Postgres rows (sized there too: a promoted leader's
  // disk starts empty) when `withRemote`.
  async function sweep(live, { withRemote = false, maxBytes = Infinity, now = Date.now() } = {}) {
    let removed = 0;
    const sizes = new Map(); // live key -> bytes
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    for (const name of names) {
      const m = /^([0-9a-f]{40})\.json$/.exec(name);
      if (!m && !/\.tmp$/.test(name)) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (m && live.has(m[1])) { sizes.set(m[1], st.size); continue; }
      if (now - st.mtimeMs <= SAVE_GRACE_MS) continue;
      try { fs.unlinkSync(full); removed++; } catch { /* gone */ }
      if (m) unsynced.delete(m[1]);
    }
    let remote = null;
    if (pool) {
      for (const key of [...unsynced]) await pushRow(key);
      if (withRemote) {
        try {
          await ensureSchema();
          remote = await pool.query(`SELECT key, octet_length(doc) AS bytes FROM ${TABLE} WHERE saved_at < $1`,
            [now - SAVE_GRACE_MS]);
          for (const r of remote || []) {
            if (live.has(r.key) && !sizes.has(r.key)) sizes.set(r.key, Number(r.bytes) || 0);
          }
        } catch (e) {
          remote = null;
          log.error(`meeting transcripts: postgres sweep failed: ${e && e.message}`);
        }
      }
    }
    const evicted = overBudget(live, sizes, maxBytes);
    for (const key of evicted) {
      try { fs.unlinkSync(fileOf(key)); removed++; } catch { /* only in postgres */ }
      unsynced.delete(key);
    }
    if (evicted.length) {
      log.error(`meeting transcripts: over the ${maxBytes}-byte budget, dropped the ${evicted.length} oldest`);
    }
    if (pool) {
      // Only rows the SELECT saw (older than the grace), plus what the budget evicted.
      const dead = new Set(evicted);
      for (const r of remote || []) if (!live.has(r.key)) dead.add(r.key);
      if (dead.size) {
        try { removed += await deleteRows([...dead]); } catch (e) {
          log.error(`meeting transcripts: postgres sweep failed: ${e && e.message}`);
        }
      }
    }
    return removed;
  }

  // The keys to drop to fit `maxBytes`: the biggest tenant's oldest first.
  function overBudget(live, sizes, maxBytes) {
    let total = 0;
    for (const b of sizes.values()) total += b;
    if (total <= maxBytes) return [];
    const byTenant = new Map();
    for (const [key, bytes] of sizes) {
      const { tenant = "", at = 0, pending = false } = live.get(key) || {};
      // A meeting still waiting to be read is never evicted: the caller back-fills
      // its document from the row, so evicting it re-saved and re-evicted it every
      // tick (QA). It still counts toward the total.
      if (pending) continue;
      if (!byTenant.has(tenant)) byTenant.set(tenant, { bytes: 0, keys: [] });
      const t = byTenant.get(tenant);
      t.bytes += bytes;
      t.keys.push({ key, at, bytes });
    }
    for (const t of byTenant.values()) t.keys.sort((a, b) => b.at - a.at); // pop() = oldest
    const out = [];
    while (total > maxBytes) {
      let big = null;
      for (const t of byTenant.values()) if (t.keys.length && (!big || t.bytes > big.bytes)) big = t;
      if (!big) break;
      const k = big.keys.pop();
      big.bytes -= k.bytes;
      total -= k.bytes;
      out.push(k.key);
    }
    return out;
  }

  return { save, has, missing, load, sweep, keyOf, overBudget, SAVE_GRACE_MS, _unsynced: unsynced };
}

module.exports = { makeTranscriptStore, keyOf, TABLE };
