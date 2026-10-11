// The outcome ledger (XERK-1839, epic XERK-1844): one row per ticket SESSION —
// which model worked which ticket, of which work class, and what became of the
// work (PR merged / closed unmerged, ticket reopened after Done). It is the
// evidence a cheaper model must earn a work class on (docs/model-quality-adr.md).
//
// The hub observes; nothing here is agent-sent. A leader sweep folds the fleet's
// sessions + closedSessions + the board's resolved rows into rows (`observe`),
// so a session the agent's `closedSessions` cache later evicts is not forgotten.
// Model provenance stays HERE, never in git: some orgs require commits authored by
// the user with no model attribution.
//
// Evidence is FLEET-WIDE: `aggregate()` counts per (class, model) across every
// org, because a model good at bug work is good at it everywhere. Per-session
// rows are only served for an org the caller names.
//
// ## Persistence — the permission ledger's two backends
//   - file (non-HA): /data/outcome-ledger.json, rewritten whole on a debounce.
//   - Postgres (HA): one row per ledger row in `outcome_session`, upserted by key,
//     monotone on `updated_at`, rescanned on the pool's ready edge and on leader
//     promotion (`rehydrate()`).
// Never `registerExternalStore`: it rewrites the whole value per persist.

"use strict";

const fs = require("fs");
const path = require("path");

function positiveEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`${name}=${JSON.stringify(raw)} is not a positive number; using ${fallback}`);
    return fallback;
  }
  return Math.floor(n);
}

const LEDGER_FILE = process.env.OUTCOME_LEDGER_FILE || "/data/outcome-ledger.json";
const MAX_ROWS = positiveEnv("OUTCOME_LEDGER_MAX_ROWS", 10000);
// A row is kept this long past its last change: the defect window plus the
// defect-attribution back-fill (XERK-1846) both need old merged work.
const RETAIN_DAYS = positiveEnv("OUTCOME_LEDGER_DAYS", 365);
// A merged PR counts as good once this long has passed with no bad signal.
const WINDOW_DAYS = positiveEnv("MODEL_QUALITY_WINDOW_DAYS", 90);
const FILE_MAX_BYTES = positiveEnv("OUTCOME_LEDGER_FILE_MAX", 16 << 20);
const SAVE_DEBOUNCE_MS = positiveEnv("OUTCOME_LEDGER_SAVE_MS", 5000);
const DAY_MS = 86400000;
const PRS_MAX = 10;
const ROWS_SERVED_MAX = 500;

// ---- shapes ----------------------------------------------------------------------

const KEY_PART_RE = /^[^\u0000-\u001f\u007f/]{1,200}$/;
const ISSUE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const PR_STATES = new Set(["OPEN", "MERGED", "CLOSED", "DRAFT"]);
const CLOSE_KINDS = new Set(["done", "not-reproducible", "already-fixed"]);

function capStr(v, max) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, max);
}
function posInt(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}
function timeOf(v) {
  if (typeof v === "number") return posInt(Math.floor(v));
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/**
 * A work class: the tracker's own issue type, lowercased, one token. Missing →
 * "other". Coarse on purpose — each (class, model) must collect enough tickets to
 * compare (ADR "Work class").
 */
function workClass(type) {
  const s = capStr(type, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "other";
}

/**
 * A model id or alias → its family ("opus" / "sonnet" / "haiku"), else a
 * sanitized id, else "". "claude-opus-4-8", "opus", "Opus 4.8" all read "opus".
 */
function modelFamily(v) {
  const s = capStr(v, 80).toLowerCase();
  if (!s) return "";
  for (const f of ["opus", "sonnet", "haiku"]) if (s.includes(f)) return f;
  return s.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function sanitizePr(p) {
  if (!p || typeof p !== "object") return null;
  const url = capStr(p.url, 500);
  if (!/^https?:\/\//i.test(url)) return null;
  const out = { url };
  const state = typeof p.state === "string" ? p.state.toUpperCase() : "";
  if (PR_STATES.has(state)) out.state = state;
  const mergedAt = posInt(p.mergedAt);
  if (mergedAt) out.mergedAt = mergedAt;
  const closedAt = posInt(p.closedAt);
  if (closedAt) out.closedAt = closedAt;
  return out;
}

/** A stored row → the stored shape, or null. The one whitelist: file load,
 * Postgres rescan and observe() all go through it. */
function sanitizeRow(r) {
  if (!r || typeof r !== "object") return null;
  const site = capStr(r.site, 200);
  const issue = typeof r.issue === "string" && ISSUE_RE.test(r.issue) ? r.issue : "";
  const host = capStr(r.host, 200);
  const sid = typeof r.sid === "string" && SID_RE.test(r.sid) ? r.sid : "";
  if (!site || !KEY_PART_RE.test(site) || !issue || !host || !KEY_PART_RE.test(host) || !sid) return null;
  const firstSeen = posInt(r.firstSeen);
  const updatedAt = posInt(r.updatedAt);
  if (!firstSeen || !updatedAt) return null;
  const out = {
    key: rowKey(site, issue, host, sid), site, issue, host, sid,
    cls: workClass(r.cls), model: modelFamily(r.model) || "default",
    firstSeen, updatedAt,
  };
  if (r.modelKnown === true) out.modelKnown = true;
  const repo = capStr(r.repo, 200);
  if (repo) out.repo = repo;
  const runtime = capStr(r.runtime, 20).toLowerCase();
  if (runtime && runtime !== "claude") out.runtime = runtime;
  for (const k of ["startedAt", "endedAt", "doneAt", "reopenedAt"]) {
    const t = posInt(r[k]);
    if (t) out[k] = t;
  }
  if (CLOSE_KINDS.has(r.closeKind)) out.closeKind = r.closeKind;
  if (Array.isArray(r.prs)) {
    const prs = r.prs.map(sanitizePr).filter(Boolean).slice(0, PRS_MAX);
    if (prs.length) out.prs = prs;
  }
  return out;
}

function rowKey(site, issue, host, sid) {
  return `${site}/${issue}/${host}/${sid}`;
}

// ---- the model ------------------------------------------------------------------

let rows = new Map();          // key -> row
let backend = null;            // set below

/**
 * Fold one sweep's observations. Each observation is one ticket session the
 * fleet still reports:
 *   {site, issue, host, sid, repo, model, modelActual, runtime, running,
 *    createdAt, closedAt, prs:[{url,state}], closeKind, type, statusCategory}
 * Returns the rows that changed (also handed to the backend).
 */
function observe(observations, now = Date.now()) {
  if (!Array.isArray(observations)) return [];
  const changed = new Map();
  const ticketDone = new Map();     // site/issue -> statusCategory seen this sweep
  for (const o of observations) {
    if (!o || typeof o !== "object") continue;
    const base = sanitizeRow({
      site: o.site, issue: o.issue, host: o.host, sid: o.sid,
      cls: o.type, model: "x", firstSeen: now, updatedAt: now,
    });
    if (!base) continue;
    const prev = rows.get(base.key);
    const next = prev ? { ...prev, prs: prev.prs ? prev.prs.map((p) => ({ ...p })) : undefined }
      : { ...base, model: "default" };
    if (!next.prs) delete next.prs;
    // The class can be learned late (the board row arrives after the session).
    if (o.type && workClass(o.type) !== "other") next.cls = workClass(o.type);
    // The model: the one the transcript says answered wins over the alias it was
    // spawned on; once known it is never overwritten by an alias.
    const actual = modelFamily(o.modelActual);
    if (actual) { next.model = actual; next.modelKnown = true; }
    else if (!next.modelKnown) {
      const alias = modelFamily(o.model);
      if (alias) next.model = alias;
    }
    const repo = capStr(o.repo, 200);
    if (repo) next.repo = repo;
    const runtime = capStr(o.runtime, 20).toLowerCase();
    if (runtime && runtime !== "claude") next.runtime = runtime;
    const started = timeOf(o.createdAt);
    if (started && !next.startedAt) next.startedAt = started;
    if (!o.running) {
      const ended = timeOf(o.closedAt) || next.endedAt || now;
      next.endedAt = ended;
    } else if (next.endedAt) {
      delete next.endedAt;          // resumed
    }
    if (CLOSE_KINDS.has(o.closeKind)) next.closeKind = o.closeKind;
    mergePrs(next, o.prs, now);
    const tkey = `${base.site}/${base.issue}`;
    if (typeof o.statusCategory === "string") ticketDone.set(tkey, o.statusCategory);
    commit(prev, next, now, changed);
  }
  // Ticket status edges, applied to every row of that ticket: Done stamps doneAt;
  // a ticket seen out of Done after one stamps reopenedAt on the rows that worked
  // it before the Done (a later session is the reopened work, not the cause).
  const byTicket = new Map();
  if (ticketDone.size) {
    for (const r of rows.values()) {
      const tkey = `${r.site}/${r.issue}`;
      if (!ticketDone.has(tkey)) continue;
      if (!byTicket.has(tkey)) byTicket.set(tkey, []);
      byTicket.get(tkey).push(r);
    }
  }
  for (const [tkey, cat] of ticketDone) {
    for (const r of byTicket.get(tkey) || []) {
      const next = { ...r };
      if (cat === "done") {
        if (!next.doneAt) next.doneAt = now;
      } else if (next.doneAt && !next.reopenedAt && (next.startedAt || next.firstSeen) < next.doneAt) {
        next.reopenedAt = now;
      }
      commit(r, next, now, changed);
    }
  }
  if (changed.size) {
    evict(now);
    const live = [...changed.values()].filter((r) => rows.get(r.key) === r);
    if (live.length) backend.onChange(live);
  }
  return [...changed.values()];
}

function mergePrs(row, prs, now) {
  if (!Array.isArray(prs)) return;
  const list = row.prs ? row.prs : [];
  for (const raw of prs) {
    const p = sanitizePr(raw);
    if (!p) continue;
    let cur = list.find((x) => x.url === p.url);
    if (!cur) {
      if (list.length >= PRS_MAX) continue;
      cur = { url: p.url };
      list.push(cur);
    }
    // MERGED is terminal: a later read never moves it back.
    if (cur.state === "MERGED") continue;
    if (p.state) cur.state = p.state;
    if (cur.state === "MERGED" && !cur.mergedAt) cur.mergedAt = p.mergedAt || now;
    if (cur.state === "CLOSED" && !cur.closedAt) cur.closedAt = p.closedAt || now;
    if (cur.state !== "CLOSED") delete cur.closedAt;
  }
  if (list.length) row.prs = list;
}

function commit(prev, next, now, changed) {
  const clean = sanitizeRow({ ...next, updatedAt: prev ? prev.updatedAt : now });
  if (!clean) return;
  if (prev && JSON.stringify(clean) === JSON.stringify(prev)) return;
  clean.updatedAt = now;
  rows.set(clean.key, clean);
  changed.set(clean.key, clean);
}

function evict(now = Date.now()) {
  const cutoff = now - RETAIN_DAYS * DAY_MS;
  for (const [k, r] of rows) if (r.updatedAt < cutoff) rows.delete(k);
  if (rows.size <= MAX_ROWS) return;
  const oldest = [...rows.values()].sort((a, b) => a.updatedAt - b.updatedAt);
  for (const r of oldest.slice(0, rows.size - MAX_ROWS)) rows.delete(r.key);
}

// ---- reads ---------------------------------------------------------------------

/**
 * A row's outcome: {outcome, reason}. bad = a signal the work was wrong; good =
 * merged and the defect window passed clean; pending = not decided yet;
 * no-change = the session closed the ticket as stale (no code to judge);
 * undelivered = ended with nothing (no PR, no close).
 */
function outcomeOf(r, now = Date.now(), windowDays = WINDOW_DAYS) {
  if (r.reopenedAt) return { outcome: "bad", reason: "reopened" };
  const prs = r.prs || [];
  const merged = prs.filter((p) => p.state === "MERGED");
  if (merged.length) {
    const first = Math.min(...merged.map((p) => p.mergedAt || r.updatedAt));
    if (now - first >= windowDays * DAY_MS) return { outcome: "good", reason: "merged, window clean" };
    return { outcome: "pending", reason: "merged, in window" };
  }
  if (prs.length && prs.every((p) => p.state === "CLOSED")) return { outcome: "bad", reason: "closed unmerged" };
  if (prs.length) return { outcome: "pending", reason: "PR open" };
  if (r.closeKind === "not-reproducible" || r.closeKind === "already-fixed") {
    return { outcome: "no-change", reason: r.closeKind };
  }
  if (r.closeKind === "done") return { outcome: "pending", reason: "closed without a PR" };
  if (r.endedAt) return { outcome: "undelivered", reason: "ended with no PR" };
  return { outcome: "pending", reason: "running" };
}

const OUTCOMES = ["good", "bad", "pending", "no-change", "undelivered"];

/**
 * The served view. Groups are fleet-wide per (class, model). `site` narrows the
 * served ROWS to one org (and only then are rows served at all).
 */
function aggregate({ site = null, withRows = false, now = Date.now(), windowDays = WINDOW_DAYS } = {}) {
  const groups = new Map();
  const served = [];
  for (const r of rows.values()) {
    const { outcome, reason } = outcomeOf(r, now, windowDays);
    const gk = `${r.cls}\u0000${r.model}`;
    let g = groups.get(gk);
    if (!g) {
      g = { cls: r.cls, model: r.model, sessions: 0, reasons: {} };
      for (const o of OUTCOMES) g[o] = 0;
      groups.set(gk, g);
    }
    g.sessions += 1;
    g[outcome] += 1;
    if (outcome === "bad") g.reasons[reason] = (g.reasons[reason] || 0) + 1;
    if (withRows && site && r.site === site) served.push({ ...r, outcome, reason });
  }
  const out = {
    windowDays,
    groups: [...groups.values()].sort((a, b) => b.sessions - a.sessions
      || a.cls.localeCompare(b.cls) || a.model.localeCompare(b.model)),
  };
  if (withRows && site) {
    served.sort((a, b) => b.updatedAt - a.updatedAt);
    out.rows = served.slice(0, ROWS_SERVED_MAX);
  }
  return out;
}

/** Per (class, model, outcome) counts for /metrics (no host, ticket or session). */
function metricsText(now = Date.now()) {
  const { groups } = aggregate({ now });
  let out = "# HELP turma_model_outcomes Ticket sessions in the outcome ledger, by work " +
    "class, model and outcome.\n# TYPE turma_model_outcomes gauge\n";
  for (const g of groups) {
    for (const o of OUTCOMES) {
      out += `turma_model_outcomes{class="${g.cls}",model="${g.model}",outcome="${o}"} ${g[o]}\n`;
    }
  }
  return out;
}

// ---- the file backend (non-HA) ---------------------------------------------------

function load() {
  rows = new Map();
  try {
    const size = fs.statSync(LEDGER_FILE).size;
    if (size > FILE_MAX_BYTES) throw new Error(`outcome ledger is ${size} bytes, over the ${FILE_MAX_BYTES} limit — starting empty`);
    const parsed = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
    const list = parsed && Array.isArray(parsed.rows) ? parsed.rows : null;
    if (!list) throw new Error("no `rows` array");
    for (const raw of list) {
      const r = sanitizeRow(raw);
      if (r) rows.set(r.key, r);
    }
    evict();
  } catch (e) {
    if (!e || e.code !== "ENOENT") {
      rows = new Map();
      console.error(`outcome ledger restore skipped: ${(e && e.message) || e}`);
    }
  }
}

let saveTimer = null;
let writing = null;
function writeNow(done) {
  const snapshot = [...rows.values()];
  const run = async () => {
    await fs.promises.mkdir(path.dirname(LEDGER_FILE), { recursive: true });
    const tmp = `${LEDGER_FILE}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify({ version: 1, rows: snapshot }), "utf8");
    await fs.promises.rename(tmp, LEDGER_FILE);
  };
  // One save at a time; never rejects out (a rejection out of a timer exits the hub).
  writing = Promise.resolve(writing).then(run).catch((e) => {
    console.error(`outcome ledger save failed: ${(e && e.message) || e}`);
    return e;
  }).then((e) => { if (done) done(e instanceof Error ? e : null); return null; });
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, SAVE_DEBOUNCE_MS);
  saveTimer.unref();
}

const fileBackend = {
  onChange() { scheduleSave(); },
  flush(done) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    writeNow(done);
  },
  async close() {},
};
backend = fileBackend;

// ---- the Postgres backend (HA) ---------------------------------------------------

const T_ROW = "outcome_session";
const PG_QUEUE_MAX = 5000;
const PG_ROWS_PER_INSERT = 500;           // 3 params a row

class OutcomeLedgerPgStore {
  constructor(pool, cfg = {}) {
    this.pool = pool;
    const { quoteIdent } = require("./pgclient.js");
    this.table = quoteIdent(T_ROW);
    this._queue = [];
    this._draining = null;
    this._closed = false;
    this._offHealth = null;
    this._readyWork = null;
    this._schemaReady = false;
    this._onExternalChange = typeof cfg.onExternalChange === "function" ? cfg.onExternalChange : null;
  }

  async init() {
    if (typeof this.pool.onHealth === "function") {
      this._offHealth = this.pool.onHealth((h) => { if (h === "ready" && !this._closed) this._onReady(); });
    }
    if (typeof this.pool.ready === "function") {
      this.pool.ready().then(() => this._onReady()).catch((e) => {
        console.error(`outcome ledger: Postgres not reachable at boot: ${(e && e.message) || e}`);
      });
    } else if (this.pool.health === "ready") {
      await this._onReady();
    }
  }

  _onReady() {
    if (this._closed) return Promise.resolve();
    if (this._readyWork) return this._readyWork;
    this._readyWork = (async () => {
      try {
        await this._ensureSchema();
        await this._drain();
        await this.rescan();
      } catch (e) {
        console.error(`outcome ledger: Postgres ready-work failed: ${(e && e.message) || e}`);
      } finally {
        this._readyWork = null;
      }
    })();
    return this._readyWork;
  }

  async _ensureSchema() {
    if (this._schemaReady) return;
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         key text PRIMARY KEY,
         updated_at bigint NOT NULL,
         doc text NOT NULL
       )`);
    this._schemaReady = true;
  }

  // Load every row into the hot model. Newest wins: a hot row changed more
  // recently than the table's copy (a write held back by an outage) is kept and
  // re-queued; a hot row the table lacks is re-queued too.
  async rescan(now = Date.now()) {
    await this._ensureSchema();
    const got = (await this.pool.query(
      `SELECT doc FROM ${this.table} ORDER BY updated_at DESC LIMIT $1`, [String(MAX_ROWS)])) || [];
    const held = new Set();
    const stale = [];
    for (const g of got) {
      let doc = null;
      try { doc = JSON.parse(g.doc); } catch { continue; }
      const r = sanitizeRow(doc);
      if (!r) continue;
      held.add(r.key);
      const hot = rows.get(r.key);
      if (hot && hot.updatedAt > r.updatedAt) { stale.push(hot); continue; }
      rows.set(r.key, r);
    }
    evict(now);
    for (const r of rows.values()) if (!held.has(r.key)) stale.push(r);
    if (stale.length) this.onChange(stale);
    if (this._onExternalChange) { try { this._onExternalChange(); } catch { /* never breaks a scan */ } }
  }

  onChange(list) {
    for (const r of list) this._queue.push([r.key, String(r.updatedAt), JSON.stringify(r)]);
    const over = this._queue.length - PG_QUEUE_MAX;
    if (over > 0) this._queue.splice(0, over);
    this._drain();
  }

  _drain() {
    if (this._draining) return this._draining;
    if (this._closed || !this._queue.length) return Promise.resolve();
    this._draining = (async () => {
      await null;
      try {
        while (this._queue.length) {
          const raw = this._queue.splice(0, PG_ROWS_PER_INSERT);
          const byKey = new Map();
          for (const vals of raw) byKey.set(vals[0], vals);
          const batch = [...byKey.values()];
          const params = [];
          const tuples = batch.map((vals) => `(${vals.map((v) => { params.push(v); return `$${params.length}`; }).join(", ")})`);
          try {
            await this._ensureSchema();
            await this.pool.query(
              `INSERT INTO ${this.table} (key, updated_at, doc) VALUES ${tuples.join(", ")} ` +
              `ON CONFLICT (key) DO UPDATE SET updated_at = EXCLUDED.updated_at, doc = EXCLUDED.doc ` +
              `WHERE EXCLUDED.updated_at >= ${this.table}.updated_at`,
              params);
          } catch (e) {
            this._queue.unshift(...batch);
            console.error(`outcome ledger: Postgres write failed (${(e && e.message) || e}); ${batch.length} row(s) held for retry`);
            break;
          }
        }
      } finally {
        this._draining = null;
      }
    })();
    return this._draining;
  }

  flush(done) {
    Promise.resolve(this._drain()).then(() => done && done(null), (e) => done && done(e));
  }

  async close() {
    this._closed = true;
    if (this._offHealth) { try { this._offHealth(); } catch { /* best effort */ } this._offHealth = null; }
  }
}

async function configure(haConfig, pgClient, onExternalChange) {
  if (!haConfig || !haConfig.ha) return;
  if (!pgClient) {
    console.error("outcome ledger: HA is on but no Postgres client was provided — staying on the local file (DEGRADED)");
    return;
  }
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const b = new OutcomeLedgerPgStore(pgClient, { onExternalChange });
  backend = b;
  await b.init();
  console.log(`outcome ledger: using Postgres (${T_ROW}) for the durable rows`);
}

function rehydrate() {
  return backend.rescan ? backend.rescan() : Promise.resolve();
}

function flush(done) { backend.flush(done); }

load();

module.exports = {
  observe, aggregate, outcomeOf, metricsText, workClass, modelFamily, sanitizeRow,
  configure, rehydrate, flush,
  LEDGER_FILE, MAX_ROWS, WINDOW_DAYS, RETAIN_DAYS, T_ROW, OutcomeLedgerPgStore,
  _internals: {
    rows: () => rows,
    load, writeNow,
    reset() {
      rows = new Map();
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (backend !== fileBackend) { try { backend.close(); } catch { /* noop */ } }
      backend = fileBackend;
    },
    getBackend: () => backend,
    setBackend(b) { backend = b; },
  },
};
