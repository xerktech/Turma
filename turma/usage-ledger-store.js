// The Postgres of-record backend for the durable usage ledger (XERK-779, epic
// XERK-775). This is the ADR's designated home for "the only copy of a year of
// spend": docs/turma-ha-store-adr.md, "Why the ledger's high-water lives in
// Postgres, not as a Valkey counter". It RETIRES the Valkey SharedLedgerBackend
// (XERK-758) under HA — that backend existed only because there was no stdlib
// Postgres client; w1-pg (XERK-776, pgclient.js) now provides one.
//
// ## The high-water write is one atomic, contention-free statement
//
// The ledger model is a per-UTC-day, per-host HIGH-WATER mark (usage-ledger.js):
// "a report can only under-state a past day", so the durable answer is the per-key
// MAXIMUM ever reported. In Postgres that is exactly:
//
//   INSERT INTO usage_day (host, series, day, token_key, tokens) VALUES (...)
//   ON CONFLICT (host, series, day, token_key)
//   DO UPDATE SET tokens = GREATEST(usage_day.tokens, EXCLUDED.tokens);
//
// with no read-modify-write window — so a low/partial writer can never lower a
// recorded total AND concurrent replicas are correct with NO lock (GREATEST is
// commutative + idempotent). This is what makes concurrent-replica ledger writes
// safe under active-active; the live plane's CAS/increment primitives are for the
// single-flight guards and queue sequencing, never the durable high-water.
//
// ## The schema round-trips the WHOLE in-memory model (full fidelity)
//
// The Valkey backend stored each host as one JSON blob; here each numeric LEAF of a
// host's model is its own GREATEST row, so per-repo breakdowns, per-model totals,
// the sub-agent split, `pre` (spend aged past the day window) and the scalars all
// survive a cold rehydrate for RETIRED hosts too — not just the headline day
// buckets. `series` distinguishes the host-level series ('') from each repo series
// (its `remoteKey`). Four tables:
//   - usage_host(host, device, site_key, first_seen, last_seen)          — entry meta
//   - usage_series(host, series, repo, remote, cutoff, sessions, last_activity)
//   - usage_day(host, series, day, token_key, tokens)   — day buckets + `pre`/`sub`
//       via the sentinel days '__pre__' / '__sub__' (neither is a valid ISO date, so
//       a scan routes it to the right bucket, never a real day)
//   - usage_model(host, series, model, token_key, tokens)
// Token leaves use GREATEST; `cutoff`/`last_activity`/`sessions` use GREATEST (ISO
// strings sort lexically = latest; sessions is a high-water count); `first_seen`
// LEAST-nonzero; `last_seen` GREATEST; labels (device/site_key/repo/remote) are a
// non-empty last-writer overwrite. Every one is monotonic or commutative, so a
// concurrent writer converges with no lock.
//
// ## `pre` and `cutoff` — why day rows are dropped at/below the cutoff
//
// In-memory, a day older than the window folds into `pre` and `cutoff` advances to
// it; all-time = `pre + sum(days)`. The store keeps the SAME shape: it writes only
// days > cutoff (the in-memory model already excludes days ≤ cutoff), writes `pre`
// as the '__pre__' sentinel, and DELETES any real-date row ≤ cutoff after each host
// write so the store never holds a day BOTH as a row AND inside `pre` (which would
// double-count). The scan is belt-and-suspenders: it also drops a real-date row ≤
// the row's cutoff during reassembly, so a straggler seen before its delete lands is
// never counted twice. cutoff advances monotonically (GREATEST) and `pre` only ever
// grows, so this is safe under concurrent writers.
//
// ## Read model stays HOT + synchronous
//
// The served views (`fold`/`retiredAgents`/`has`) read the SAME in-memory `hosts`
// model, SYNCHRONOUSLY and unchanged — a database could never hand back a live object
// on the hot serve path. This backend keeps the model hot: its own writes raise it,
// and it rescans Postgres on the pool's health→READY edge (boot + reconnect) and on
// LEADER PROMOTION (`usageLedger.rehydrate()`). Under Option 2 (leader-only serving)
// the leader receives every beat, so its model is complete; a promoted standby
// rescans to pick up what the old leader wrote since this replica's own boot scan.
// There is no Postgres pub/sub watch (pgclient does not wire LISTEN/NOTIFY), so —
// UNLIKE the Valkey backend's continuous `watch` — cross-replica freshness between
// promotions is bounded by the rescan cadence, an accepted divergence documented in
// .claude/rules/turma-usage.md.

"use strict";

// The four tables. Names are module constants (never user input) but every one is
// still run through pgclient's `quoteIdent` before it reaches SQL, so a typo here
// fails loudly rather than opening an injection seam for a careless future edit.
const T_HOST = "usage_host";
const T_SERIES = "usage_series";
const T_DAY = "usage_day";
const T_MODEL = "usage_model";

// Sentinel `day` values carrying the non-day buckets in the day table. Neither is a
// valid ISO date, so `ops.isoDay` rejects both and a scan routes them by name.
const DAY_PRE = "__pre__";
const DAY_SUB = "__sub__";

// Postgres caps a statement at 65535 bound parameters. A multi-row upsert of C-column
// rows fits floor(cap / C) rows per statement; stay well under with a generous margin.
const MAX_PARAMS = 60000;

const { quoteIdent } = require("./pgclient.js");

// A token figure to a Postgres bigint literal. The model holds safe integers
// (`num()` gate); String() renders an integer with no exponent for anything under
// 1e21, far above any real token count, so it is a valid bigint text.
function tokenText(n) {
  return String(n);
}
// A bigint column comes back as TEXT (pgclient text protocol). Parse to a Number the
// model's `num()` accepts; a non-finite/unsafe value coerces to 0 there.
function tokenNum(v) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

class LedgerStore {
  /**
   * @param {object} pool  a PgPool (pgclient.js): async query/execute, onHealth/health.
   * @param {object} ops   the ledger's own internals (usage-ledger.js `sharedOps()`):
   *   the in-memory model accessors + pure high-water reducers + TOKEN_KEYS/isoDay,
   *   passed in to avoid a require cycle and to mutate the SAME `hosts` object the
   *   read path serves.
   * @param {object} [cfg] { debounceMs, onExternalChange }
   */
  constructor(pool, ops, cfg = {}) {
    this.pool = pool;
    this.ops = ops;
    this.TOKEN_KEYS = ops.TOKEN_KEYS;
    this.debounceMs = cfg.debounceMs || ops.SAVE_DEBOUNCE_MS || 5000;
    this._onExternalChange = typeof cfg.onExternalChange === "function" ? cfg.onExternalChange : null;
    this._dirty = new Set();
    this._timer = null;
    this._closed = false;
    this._offHealth = null;
    this._scanning = false;
    this._schemaReady = false;
    this._readyWork = null;
    // A per-host promise chain so two flushes never race one host's write set.
    this._writing = new Map();
  }

  // Signal the hub that the served model changed with no local beat behind it (a
  // scan/rescan load), so it rebuilds /api/agents (retiredUsage especially). A
  // throwing callback must never break model loading.
  _notifyExternal() {
    if (!this._onExternalChange) return;
    try { this._onExternalChange(); } catch { /* must not break a scan */ }
  }

  // Start watching for the pool to become usable and load the existing history.
  // NEVER BLOCKS BOOT: the pool is not connected within this synchronous call, so a
  // scan issued inline would reject ("connection not ready"). Instead the schema +
  // scan run when the pool TRANSITIONS TO READY (boot connect AND reconnect), and a
  // fire-and-forget `ready()` kicks the first connection so that edge actually fires.
  async init() {
    if (typeof this.pool.onHealth === "function") {
      this._offHealth = this.pool.onHealth((h) => {
        if (h === "ready" && !this._closed) this._onReady();
      });
    }
    // Kick a connection; the ensuing ready edge (or this promise) runs the work.
    if (typeof this.pool.ready === "function") {
      this.pool.ready().then(() => this._onReady()).catch((e) => {
        console.error(`usage ledger: Postgres not reachable at boot: ${(e && e.message) || e}`);
      });
    } else if (this.pool.health === "ready") {
      await this._onReady();
    }
  }

  // Ensure the schema then scan. Coalesced: the health handler AND the boot `ready()`
  // both call it, and a reconnect re-fires it; overlapping calls share one promise
  // and re-runs are idempotent (CREATE IF NOT EXISTS; max-merge scan).
  _onReady() {
    if (this._closed) return Promise.resolve();
    if (this._readyWork) return this._readyWork;
    this._readyWork = (async () => {
      try {
        await this._ensureSchema();
        await this._scan();
      } catch (e) {
        console.error(`usage ledger: Postgres ready-work failed: ${(e && e.message) || e}`);
      } finally {
        this._readyWork = null;
      }
    })();
    return this._readyWork;
  }

  async _ensureSchema() {
    if (this._schemaReady) return;
    const ddl = [
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(T_HOST)} (
         host text PRIMARY KEY,
         device text,
         site_key text,
         first_seen bigint,
         last_seen bigint
       )`,
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(T_SERIES)} (
         host text NOT NULL,
         series text NOT NULL,
         repo text,
         remote text,
         cutoff text,
         sessions bigint,
         last_activity text,
         PRIMARY KEY (host, series)
       )`,
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(T_DAY)} (
         host text NOT NULL,
         series text NOT NULL,
         day text NOT NULL,
         token_key text NOT NULL,
         tokens bigint NOT NULL,
         PRIMARY KEY (host, series, day, token_key)
       )`,
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(T_MODEL)} (
         host text NOT NULL,
         series text NOT NULL,
         model text NOT NULL,
         token_key text NOT NULL,
         tokens bigint NOT NULL,
         PRIMARY KEY (host, series, model, token_key)
       )`,
    ];
    // One statement at a time — the extended protocol carries a single command.
    for (const stmt of ddl) await this.pool.query(stmt);
    this._schemaReady = true;
  }

  // Public rescan (leader promotion). Same as the ready-edge scan; idempotent.
  async rescan() {
    if (this._closed) return;
    if (!this._schemaReady) return this._onReady();
    await this._scan();
  }

  // Load every host from Postgres into the model by HIGH-WATER max-merge (never a
  // replace), so a scan racing a write, or a re-scan after reconnect/promotion, can
  // only RAISE a figure. Guarded against overlap; a failure is logged, not fatal.
  async _scan() {
    if (this._scanning) return;
    this._scanning = true;
    try {
      let rawByHost;
      try {
        rawByHost = await this._readAll();
      } catch (e) {
        // A database not yet up must not crash the hub; the next ready edge re-runs.
        console.error(`usage ledger: Postgres scan failed: ${(e && e.message) || e}`);
        return;
      }
      let kept = 0;
      for (const [host, raw] of rawByHost) {
        const peer = this.ops.coerce(raw); // raw -> coerced entry, or null
        if (!peer) continue;
        const local = this.ops.getEntry(host);
        if (local) this.ops.mergeEntry(local, peer); // raise, never lower
        else this.ops.setEntry(host, peer);
        kept += 1;
      }
      if (kept) {
        console.log(`loaded usage history for ${kept} host(s) from Postgres`);
        // The scan raised the served model with no beat behind it — invalidate the
        // /api/agents cache so a reconnect/promotion load reaches the dashboard.
        this._notifyExternal();
      }
    } finally {
      this._scanning = false;
    }
  }

  // Read the four tables and reassemble the coerce-shaped raw entry per host:
  //   { device, siteKey, firstSeen, lastSeen, host: <seriesRaw>|null,
  //     repos: { <remoteKey>: { repo, remote, series: <seriesRaw> } } }
  // where seriesRaw = { pre, days, models, subagent, cutoff, sessions, lastActivity }.
  async _readAll() {
    const hostRows = await this.pool.query(`SELECT host, device, site_key, first_seen, last_seen FROM ${quoteIdent(T_HOST)}`);
    const seriesRows = await this.pool.query(`SELECT host, series, repo, remote, cutoff, sessions, last_activity FROM ${quoteIdent(T_SERIES)}`);
    const dayRows = await this.pool.query(`SELECT host, series, day, token_key, tokens FROM ${quoteIdent(T_DAY)}`);
    const modelRows = await this.pool.query(`SELECT host, series, model, token_key, tokens FROM ${quoteIdent(T_MODEL)}`);

    // host -> { device, siteKey, firstSeen, lastSeen, series: Map(series -> seriesRaw) }
    const hosts = new Map();
    const ensureHost = (h) => {
      let e = hosts.get(h);
      if (!e) hosts.set(h, e = { device: "", siteKey: "", firstSeen: 0, lastSeen: 0, series: new Map() });
      return e;
    };
    const ensureSeries = (e, s) => {
      let sr = e.series.get(s);
      if (!sr) e.series.set(s, sr = { repo: "", remote: "", cutoff: null, sessions: 0, lastActivity: null, pre: {}, days: {}, models: {}, subagent: null });
      return sr;
    };

    for (const r of hostRows) {
      const e = ensureHost(r.host);
      e.device = r.device || "";
      e.siteKey = r.site_key || "";
      e.firstSeen = r.first_seen == null ? 0 : tokenNum(r.first_seen);
      e.lastSeen = tokenNum(r.last_seen);
    }
    for (const r of seriesRows) {
      const sr = ensureSeries(ensureHost(r.host), r.series);
      sr.repo = r.repo || "";
      sr.remote = r.remote || "";
      sr.cutoff = typeof r.cutoff === "string" && r.cutoff ? r.cutoff : null;
      sr.sessions = tokenNum(r.sessions);
      sr.lastActivity = typeof r.last_activity === "string" && r.last_activity ? r.last_activity : null;
    }
    for (const r of dayRows) {
      const sr = ensureSeries(ensureHost(r.host), r.series);
      const tokens = tokenNum(r.tokens);
      if (r.day === DAY_PRE) (sr.pre[r.token_key] = (sr.pre[r.token_key] || 0) + tokens);
      else if (r.day === DAY_SUB) { (sr.subagent = sr.subagent || {})[r.token_key] = tokens; }
      else if (this.ops.isoDay(r.day)) {
        // Belt: never count a real-date row at/below the folded cutoff (it lives in
        // `pre` already). The delete on write is the suspenders; this covers a
        // straggler read before its delete lands.
        if (sr.cutoff && r.day <= sr.cutoff) continue;
        (sr.days[r.day] || (sr.days[r.day] = {}))[r.token_key] = tokens;
      }
    }
    for (const r of modelRows) {
      const sr = ensureSeries(ensureHost(r.host), r.series);
      (sr.models[r.model] || (sr.models[r.model] = {}))[r.token_key] = tokenNum(r.tokens);
    }

    // Assemble the coerce-shaped raw per host.
    const out = new Map();
    for (const [host, e] of hosts) {
      const repos = {};
      let hostSeries = null;
      for (const [s, sr] of e.series) {
        const raw = { pre: sr.pre, days: sr.days, models: sr.models, cutoff: sr.cutoff, sessions: sr.sessions, lastActivity: sr.lastActivity };
        if (sr.subagent) raw.subagent = sr.subagent;
        if (s === "") hostSeries = raw;
        else repos[s] = { repo: sr.repo, remote: sr.remote, series: raw };
      }
      out.set(host, { device: e.device, siteKey: e.siteKey, firstSeen: e.firstSeen, lastSeen: e.lastSeen, host: hostSeries, repos });
    }
    return out;
  }

  // The ledger changed host `key` this beat. Mark it dirty and arm the debounce.
  // Every write is an idempotent GREATEST upsert, so a re-stating beat that raised
  // nothing simply no-ops against equal stored values — there is no separate slow
  // snapshot cadence (the file backend's two-timer split does not apply).
  onChange(key /* , prompt */) {
    if (this._closed) return;
    this._dirty.add(key);
    this._arm();
  }

  onForget(key) {
    if (this._closed) return;
    // Durable delete is immediate (an operator action, not a debounced re-state) and
    // must beat any in-flight dirty write for the key.
    this._dirty.delete(key);
    this._serialize(key, () => this._deleteHost(key));
  }

  _arm() {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this._flushDirty(); }, this.debounceMs);
    this._timer.unref?.();
  }

  _flushDirty(done) {
    const keys = [...this._dirty];
    this._dirty.clear();
    const writes = keys.map((key) => this._serialize(key, () => this._persistHost(key)));
    if (!done) return;
    Promise.allSettled(writes).then(() => done(null), () => done(null));
  }

  // Serialise writes to one host key within this replica (a second write reading a
  // value the first is mid-writing would churn), like the Valkey backend's `_writing`.
  _serialize(key, fn) {
    const prev = this._writing.get(key) || Promise.resolve();
    const next = prev.then(fn, fn).catch(() => {});
    this._writing.set(key, next);
    next.finally(() => { if (this._writing.get(key) === next) this._writing.delete(key); });
    return next;
  }

  // The atomic per-host HIGH-WATER write: decompose the live entry into rows and
  // GREATEST-upsert each table (no read-modify-write — the upsert IS the merge), then
  // drop any real-date day row at/below the folded cutoff so the store never double-
  // counts a day that also lives in `pre`.
  async _persistHost(key) {
    const entry = this.ops.getEntry(key);
    if (!entry) return; // forgotten between the mark and the flush
    // Bound this host's bytes BEFORE decomposing (the per-host `enforceHostShare` is
    // the store's expression of LEDGER_MAX — a host is one logical row-set, so its
    // share IS its ceiling). It mutates the live entry, exactly as the file/Valkey
    // backends do.
    try { this.ops.enforceHostShare(key, entry); } catch { /* never throws in practice */ }

    const rows = this._rowsForEntry(key, entry);
    try {
      if (rows.host.length) {
        await this._upsert(T_HOST, ["host", "device", "site_key", "first_seen", "last_seen"], ["host"],
          `device = COALESCE(NULLIF(EXCLUDED.device,''), ${quoteIdent(T_HOST)}.device), ` +
          `site_key = COALESCE(NULLIF(EXCLUDED.site_key,''), ${quoteIdent(T_HOST)}.site_key), ` +
          `first_seen = LEAST(NULLIF(${quoteIdent(T_HOST)}.first_seen,0), NULLIF(EXCLUDED.first_seen,0)), ` +
          `last_seen = GREATEST(${quoteIdent(T_HOST)}.last_seen, EXCLUDED.last_seen)`,
          rows.host);
      }
      if (rows.series.length) {
        await this._upsert(T_SERIES, ["host", "series", "repo", "remote", "cutoff", "sessions", "last_activity"], ["host", "series"],
          `repo = COALESCE(NULLIF(EXCLUDED.repo,''), ${quoteIdent(T_SERIES)}.repo), ` +
          `remote = COALESCE(NULLIF(EXCLUDED.remote,''), ${quoteIdent(T_SERIES)}.remote), ` +
          `cutoff = GREATEST(${quoteIdent(T_SERIES)}.cutoff, EXCLUDED.cutoff), ` +
          `sessions = GREATEST(${quoteIdent(T_SERIES)}.sessions, EXCLUDED.sessions), ` +
          `last_activity = GREATEST(${quoteIdent(T_SERIES)}.last_activity, EXCLUDED.last_activity)`,
          rows.series);
      }
      if (rows.day.length) {
        await this._upsert(T_DAY, ["host", "series", "day", "token_key", "tokens"], ["host", "series", "day", "token_key"],
          `tokens = GREATEST(${quoteIdent(T_DAY)}.tokens, EXCLUDED.tokens)`, rows.day);
      }
      if (rows.model.length) {
        await this._upsert(T_MODEL, ["host", "series", "model", "token_key", "tokens"], ["host", "series", "model", "token_key"],
          `tokens = GREATEST(${quoteIdent(T_MODEL)}.tokens, EXCLUDED.tokens)`, rows.model);
      }
      // Drop real-date day rows at/below each series' cutoff — they are folded into
      // `pre`, so leaving them would double-count on scan and grow the table without
      // bound. A real ISO date is `\d{4}-\d{2}-\d{2}`; the sentinels never match.
      for (const { series, cutoff } of rows.cutoffs) {
        await this.pool.query(
          `DELETE FROM ${quoteIdent(T_DAY)} WHERE host = $1 AND series = $2 AND day <= $3 ` +
            `AND day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
          [key, series, cutoff]
        );
      }
    } catch (e) {
      // Retried on the next dirty flush; a durable write must never throw out of the
      // debounce timer (an uncaught throw there exits the hub — the XERK-235 rule).
      console.error(`usage ledger: Postgres write failed for a host: ${(e && e.message) || e}`);
    }
  }

  // Decompose one entry into the per-table row arrays (each row an array in the given
  // column order). Zero token leaves are SKIPPED — GREATEST(x,0) is a no-op, so
  // writing them is pure cost.
  _rowsForEntry(key, entry) {
    const host = [];
    const series = [];
    const day = [];
    const model = [];
    const cutoffs = [];
    host.push([key, entry.device || "", entry.siteKey || "", entry.firstSeen || 0, entry.lastSeen || 0]);

    const addSeries = (sid, repo, remote, s) => {
      if (!s) return;
      series.push([key, sid, repo || "", remote || "", s.cutoff || null, s.sessions || 0, s.lastActivity || null]);
      if (s.cutoff) cutoffs.push({ series: sid, cutoff: s.cutoff });
      for (const [d, b] of Object.entries(s.days || {})) this._bucketRows(day, key, sid, d, b);
      if (s.pre) this._bucketRows(day, key, sid, DAY_PRE, s.pre);
      if (s.subagent) this._bucketRows(day, key, sid, DAY_SUB, s.subagent);
      for (const [m, b] of Object.entries(s.models || {})) {
        for (const tk of this.TOKEN_KEYS) {
          const v = b && b[tk];
          if (v) model.push([key, sid, m, tk, tokenText(v)]);
        }
      }
    };
    addSeries("", "", "", entry.host);
    for (const [rk, r] of Object.entries(entry.repos || {})) {
      if (rk === "__proto__" || !r) continue;
      addSeries(rk, r.repo, r.remote, r.series);
    }
    return { host, series, day, model, cutoffs };
  }

  _bucketRows(dst, key, sid, dayId, bucket) {
    for (const tk of this.TOKEN_KEYS) {
      const v = bucket && bucket[tk];
      if (v) dst.push([key, sid, dayId, tk, tokenText(v)]);
    }
  }

  // A chunked multi-row GREATEST upsert. Rows are chunked to stay under Postgres's
  // 65535-parameter statement limit.
  async _upsert(table, cols, conflictCols, updateSet, rows) {
    const perChunk = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
    const t = quoteIdent(table);
    const colList = cols.map(quoteIdent).join(", ");
    const conflict = conflictCols.map(quoteIdent).join(", ");
    for (let i = 0; i < rows.length; i += perChunk) {
      const chunk = rows.slice(i, i + perChunk);
      const params = [];
      const tuples = chunk.map((row) => {
        const ph = row.map((v) => { params.push(v); return `$${params.length}`; });
        return `(${ph.join(", ")})`;
      });
      const sql =
        `INSERT INTO ${t} (${colList}) VALUES ${tuples.join(", ")} ` +
        `ON CONFLICT (${conflict}) DO UPDATE SET ${updateSet}`;
      await this.pool.query(sql, params);
    }
  }

  async _deleteHost(key) {
    try {
      for (const table of [T_HOST, T_SERIES, T_DAY, T_MODEL]) {
        await this.pool.query(`DELETE FROM ${quoteIdent(table)} WHERE host = $1`, [key]);
      }
    } catch (e) {
      console.error(`usage ledger: Postgres forget of a host failed: ${(e && e.message) || e}`);
    }
  }

  // Flush every pending durable write now — the graceful-shutdown drain path.
  flush(done) {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._flushDirty(done || (() => {}));
  }

  async close() {
    this._closed = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._offHealth) { try { this._offHealth(); } catch { /* best effort */ } this._offHealth = null; }
    // The pool itself is owned by server.js (shared with the archive IndexStore) and
    // is closed there on shutdown, so this backend never closes it.
  }
}

module.exports = { LedgerStore, T_HOST, T_SERIES, T_DAY, T_MODEL, DAY_PRE, DAY_SUB, MAX_PARAMS };
