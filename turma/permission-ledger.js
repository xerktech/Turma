// The permission ledger (XERK-1563, epic XERK-1560): every permission prompt a
// session hit — a numbered TUI dialog, an auto-mode classifier block, or the
// session asking for permission in chat — with how long it held the session and
// the allow rule that would retire it. Agents send rows on the heartbeat
// (`permissionEvents`); this module bounds them, keeps them, and serves the
// rolling aggregates `GET /api/permissions` and `/metrics` read.
//
// ## Persistence — the usage-ledger FILE skeleton, a Postgres APPEND table under HA
//
// The in-memory model (per-host shards of rows keyed by row id) is the served,
// synchronous read model in both modes. Only persistence differs:
//   - file (DEFAULT, non-HA): `/data/permission-ledger.json`, rewritten whole on a
//     debounce + flushed on graceful shutdown — usage-ledger.js's load/evict and
//     debounced-write shape. HA `/data` is a per-pod emptyDir, so this is NON-HA only.
//   - Postgres (HA): one row per ledger row in `permission_event`, upserted by
//     (host, id) — a row is sent open and again closed, and the later one wins —
//     with PERMISSION_LEDGER_DAYS retention, rescanned into the model on the pool's
//     ready edge and on leader promotion (`rehydrate()`). Under XERK-919 the leader
//     receives every beat and serves every read, so its hot model is complete.
// Never `registerExternalStore`: rows churn every beat, and HA rewrites a whole
// external-store value per persist.

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

const LEDGER_FILE = process.env.PERMISSION_LEDGER_FILE || "/data/permission-ledger.json";
const MAX_ROWS = positiveEnv("PERMISSION_LEDGER_MAX_ROWS", 20000);
// One host may hold at most this share, so a flooding host cannot evict the fleet.
const HOST_MAX_ROWS = positiveEnv("PERMISSION_LEDGER_HOST_MAX_ROWS", Math.max(1, Math.floor(MAX_ROWS / 4)));
const DAYS = positiveEnv("PERMISSION_LEDGER_DAYS", 30);
const DAY_MS = 86400000;
// What one beat may add: the agent sends at most this many, and a hub never
// trusts that it did.
const EVENTS_PER_BEAT = 200;
// The file is measured before it is read (an oversized one is an OOM at boot,
// every boot); ~1 KiB a row puts the ceiling well past MAX_ROWS.
const FILE_MAX_BYTES = positiveEnv("PERMISSION_LEDGER_FILE_MAX", 64 << 20);
const SAVE_DEBOUNCE_MS = positiveEnv("PERMISSION_LEDGER_SAVE_MS", 5000);
const TOP_MAX = 50;
const RECENT_MAX = 50;

// ---- ingest bounds: every field whitelisted, strict enums, capped strings ----
const KINDS = new Set(["dialog", "classifier-denied", "ask-in-chat"]);
const DIALOG_KINDS = new Set(["permission", "plan", "sandbox", "other"]);
const ANSWERS = new Set(["allow", "deny", "unknown"]);
const VIA = new Set(["turma", "terminal", "unknown"]);
const ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const SID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const STR_CAPS = {
  tool: 128, head: 200, digest: 400, toolUseId: 128, prompt: 300, denyReason: 300,
};
// A wait longer than the retention window is not a wait this ledger can hold.
const WAIT_MAX_MS = DAYS * DAY_MS;

function capStr(v, max) {
  if (typeof v !== "string") return "";
  // C0/DEL/C1 out: these are rendered and logged, and a line break forges rows.
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, max);
}
function finiteNum(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * One agent-sent row → the stored shape, or null. Whitelist: an unknown key is
 * dropped, a wrong-typed one coerced to "can't tell" (absent), never to a
 * plausible value. `openedAt` is required and may not sit in the future (past a
 * day of clock skew) — a future row would never age out of the window.
 */
function sanitizePermissionEvent(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) return null;
  if (!KINDS.has(raw.kind)) return null;
  const openedAt = finiteNum(raw.openedAt);
  if (openedAt === null || openedAt <= 0 || openedAt > now + DAY_MS) return null;
  const row = { id: raw.id, kind: raw.kind, openedAt: Math.floor(openedAt) };
  if (typeof raw.sessionId === "string" && SID_RE.test(raw.sessionId)) row.sessionId = raw.sessionId;
  if (raw.kind === "dialog") row.dialogKind = DIALOG_KINDS.has(raw.dialogKind) ? raw.dialogKind : "other";
  for (const [k, max] of Object.entries(STR_CAPS)) {
    const v = capStr(raw[k], max);
    if (v) row[k] = v;
  }
  for (const k of ["options", "rulesMatched"]) {
    if (!Array.isArray(raw[k])) continue;
    const list = raw[k].filter((s) => typeof s === "string").slice(0, k === "options" ? 9 : 8)
      .map((s) => capStr(s, 200));
    if (list.length) row[k] = list;
  }
  const closedAt = finiteNum(raw.closedAt);
  if (closedAt !== null && closedAt >= row.openedAt && closedAt <= now + DAY_MS) {
    row.closedAt = Math.floor(closedAt);
  }
  const waited = finiteNum(raw.waitedMs);
  if (waited !== null && waited >= 0 && waited <= WAIT_MAX_MS) row.waitedMs = Math.floor(waited);
  if (ANSWERS.has(raw.answer)) row.answer = raw.answer;
  if (Number.isInteger(raw.answerNumber) && raw.answerNumber >= 1 && raw.answerNumber <= 9) {
    row.answerNumber = raw.answerNumber;
  }
  if (VIA.has(raw.via)) row.via = raw.via;
  return row;
}

// ---- the model -----------------------------------------------------------------
// host -> Map(id -> row). Insertion order is not trusted for eviction: rows are
// evicted by `openedAt`, oldest first.
let hosts = new Map();

function rowCount() {
  let n = 0;
  for (const m of hosts.values()) n += m.size;
  return n;
}

function oldestFirst(list) {
  return list.sort((a, b) => a.openedAt - b.openedAt || (a.id < b.id ? -1 : 1));
}

// Drop rows past retention, then trim any host past its share, then the store
// past MAX_ROWS — oldest first each time. Returns the (host, id) pairs dropped.
function evict(now = Date.now()) {
  const cutoff = now - DAYS * DAY_MS;
  const dropped = [];
  for (const [host, m] of hosts) {
    for (const [id, row] of m) if (row.openedAt < cutoff) { m.delete(id); dropped.push([host, id]); }
    if (m.size > HOST_MAX_ROWS) {
      for (const row of oldestFirst([...m.values()]).slice(0, m.size - HOST_MAX_ROWS)) {
        m.delete(row.id);
        dropped.push([host, row.id]);
      }
    }
    if (!m.size) hosts.delete(host);
  }
  let over = rowCount() - MAX_ROWS;
  if (over > 0) {
    const all = [];
    for (const [host, m] of hosts) for (const row of m.values()) all.push({ host, row });
    all.sort((a, b) => a.row.openedAt - b.row.openedAt);
    for (const { host, row } of all) {
      if (over-- <= 0) break;
      const m = hosts.get(host);
      m.delete(row.id);
      if (!m.size) hosts.delete(host);
      dropped.push([host, row.id]);
    }
  }
  return dropped;
}

/**
 * Fold one beat's rows for `host`. A row id seen before REPLACES the stored row
 * (an open dialog row is sent again once closed). Returns how many were kept.
 * Called only after every gate that can still refuse the beat.
 */
function ingest(host, events, now = Date.now()) {
  if (typeof host !== "string" || !host || host === "__proto__" || !Array.isArray(events)) return 0;
  const kept = [];
  for (const raw of events.slice(0, EVENTS_PER_BEAT)) {
    const row = sanitizePermissionEvent(raw, now);
    if (row) kept.push(row);
  }
  if (!kept.length) return 0;
  let m = hosts.get(host);
  if (!m) hosts.set(host, (m = new Map()));
  for (const row of kept) m.set(row.id, row);
  evict(now);
  backend.onChange(host, kept);
  return kept.length;
}

// ---- reads ---------------------------------------------------------------------

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function toolRule(tool, head) {
  if (tool === "Bash" && head) return `Bash(${head}:*)`;
  if (typeof tool === "string" && tool.startsWith("mcp__")) return tool;
  if (tool === "WebFetch" && head && HOST_RE.test(head)) return `WebFetch(domain:${head})`;
  return null;
}

/**
 * The allow rule that would retire a prompt — DETERMINISTIC, a table, never a
 * judgement (the LLM judge is a later child):
 *   ask-in-chat                      → "model behaviour: see CLAUDE.md step 0"
 *   a sandbox dialog naming a host   → sandbox.network.allowedDomains: <host>
 *   classifier-denied                → an autoMode.environment allow line for the
 *                                      call (its tool rule, else the reason's subject)
 *   Bash                             → Bash(<head>:*)
 *   MCP                              → the full mcp__<server>__<tool>
 *   WebFetch                         → WebFetch(domain:<d>)
 *   anything else                    → null (no rule retires it)
 */
function suggestedRule(g) {
  if (!g) return null;
  if (g.kind === "ask-in-chat") return "model behaviour: see CLAUDE.md step 0";
  if (g.dialogKind === "sandbox" && g.head && HOST_RE.test(g.head)) {
    return `sandbox.network.allowedDomains: ${g.head}`;
  }
  const rule = toolRule(g.tool, g.head);
  if (g.kind === "classifier-denied") {
    const subject = rule || (g.denyReason || "").split(/[.;:\n]/)[0].trim().slice(0, 120) ||
      g.head || g.tool;
    return subject ? `autoMode.environment: allow ${subject}` : null;
  }
  if (g.dialogKind === "plan") return null;
  return rule;
}

function scopedRows(hostSet, days, now) {
  const since = now - Math.min(Math.max(1, days || 7), DAYS) * DAY_MS;
  const out = [];
  for (const [host, m] of hosts) {
    if (hostSet && !hostSet.has(host)) continue;
    for (const row of m.values()) if (row.openedAt >= since) out.push({ host, row });
  }
  return out;
}

/**
 * `{top, recent}` for the Usage page. `hostSet` (a Set of host keys) scopes it —
 * the route builds it from the LIVE fleet's org, like `retiredUsage`; null = all.
 */
function aggregate({ hosts: hostSet = null, days = 7, now = Date.now() } = {}) {
  const rows = scopedRows(hostSet, days, now);
  const groups = new Map();
  for (const { row } of rows) {
    const key = [row.kind, row.dialogKind || "", row.tool || "", row.head || ""].join("\u0000");
    let g = groups.get(key);
    if (!g) {
      g = { kind: row.kind, dialogKind: row.dialogKind || null, tool: row.tool || null,
        head: row.head || null, count: 0, allowed: 0, denied: 0, waits: [], lastAt: 0,
        denyReason: null };
      groups.set(key, g);
    }
    g.count += 1;
    if (row.answer === "allow") g.allowed += 1;
    if (row.answer === "deny") g.denied += 1;
    if (typeof row.waitedMs === "number") g.waits.push(row.waitedMs);
    if (row.openedAt >= g.lastAt) {
      g.lastAt = row.openedAt;
      if (row.denyReason) g.denyReason = row.denyReason;
    }
  }
  const top = [...groups.values()]
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, TOP_MAX)
    .map((g) => ({
      kind: g.kind, dialogKind: g.dialogKind, tool: g.tool, head: g.head,
      count: g.count, allowed: g.allowed, denied: g.denied,
      medianWaitMs: median(g.waits), lastAt: g.lastAt, suggestedRule: suggestedRule(g),
    }));
  const recent = rows
    .sort((a, b) => b.row.openedAt - a.row.openedAt)
    .slice(0, RECENT_MAX)
    .map(({ host, row }) => {
      const out = { host };
      for (const k of ["id", "sessionId", "kind", "dialogKind", "tool", "head", "prompt",
        "denyReason", "answer", "via", "waitedMs", "openedAt", "closedAt"]) {
        if (row[k] !== undefined) out[k] = row[k];
      }
      return out;
    });
  return { days: Math.min(Math.max(1, days || 7), DAYS), top, recent };
}

/** Per-kind counts and summed waits across everything retained (for /metrics). */
function kindTotals() {
  const out = {};
  for (const k of KINDS) out[k] = { count: 0, waitMs: 0 };
  for (const m of hosts.values()) {
    for (const row of m.values()) {
      out[row.kind].count += 1;
      if (typeof row.waitedMs === "number") out[row.kind].waitMs += row.waitedMs;
    }
  }
  return out;
}

// ---- the file backend (non-HA) ---------------------------------------------------

function load() {
  hosts = new Map();
  try {
    const size = fs.statSync(LEDGER_FILE).size;
    if (size > FILE_MAX_BYTES) {
      throw new Error(`permission ledger is ${size} bytes, over the ${FILE_MAX_BYTES} limit — starting empty`);
    }
    const parsed = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
    const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.hosts : null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("no `hosts` object");
    const now = Date.now();
    for (const [host, list] of Object.entries(raw)) {
      if (!host || host === "__proto__" || !Array.isArray(list)) continue;
      const m = new Map();
      for (const r of list) {
        const row = sanitizePermissionEvent(r, now);   // the file is re-checked too
        if (row) m.set(row.id, row);
      }
      if (m.size) hosts.set(host, m);
    }
    evict(now);
  } catch (e) {
    if (!e || e.code !== "ENOENT") {
      hosts = new Map();
      console.error(`permission ledger restore skipped: ${(e && e.message) || e}`);
    }
  }
}

function serialize() {
  try {
    const out = {};
    for (const [host, m] of hosts) out[host] = [...m.values()];
    return JSON.stringify({ version: 1, hosts: out });
  } catch (e) {
    // Throwing out of a save TIMER is an uncaught exception that exits the hub.
    console.error(`permission ledger save skipped — could not serialize: ${e.message}`);
    return null;
  }
}

let saveTimer = null;
function writeNow(done) {
  const blob = serialize();
  if (blob === null) return void (done && done(new Error("not serializable")));
  fs.mkdir(path.dirname(LEDGER_FILE), { recursive: true }, () => {
    fs.writeFile(LEDGER_FILE, blob, (err) => {
      if (err) console.error(`permission ledger save failed: ${err.message}`);
      if (done) done(err || null);
    });
  });
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
let backend = fileBackend;

// ---- the Postgres backend (HA) ---------------------------------------------------

const T_EVENT = "permission_event";
const PG_QUEUE_MAX = 10000;
const PG_ROWS_PER_INSERT = 500;          // 4 params a row, far under 65535
const PG_RETENTION_SWEEP_MS = 60 * 60 * 1000;

class PermissionLedgerPgStore {
  constructor(pool, cfg = {}) {
    this.pool = pool;
    const { quoteIdent } = require("./pgclient.js");
    this.table = quoteIdent(T_EVENT);
    this._queue = [];
    this._draining = null;
    this._closed = false;
    this._offHealth = null;
    this._readyWork = null;
    this._schemaReady = false;
    this._sweepTimer = null;
    this._onExternalChange = typeof cfg.onExternalChange === "function" ? cfg.onExternalChange : null;
    this._dropped = 0;
  }

  async init() {
    if (typeof this.pool.onHealth === "function") {
      this._offHealth = this.pool.onHealth((h) => { if (h === "ready" && !this._closed) this._onReady(); });
    }
    if (typeof this.pool.ready === "function") {
      this.pool.ready().then(() => this._onReady()).catch((e) => {
        console.error(`permission ledger: Postgres not reachable at boot: ${(e && e.message) || e}`);
      });
    } else if (this.pool.health === "ready") {
      await this._onReady();
    }
    this._sweepTimer = setInterval(() => { this.sweep().catch(() => {}); }, PG_RETENTION_SWEEP_MS);
    if (this._sweepTimer.unref) this._sweepTimer.unref();
  }

  _onReady() {
    if (this._closed) return Promise.resolve();
    if (this._readyWork) return this._readyWork;
    this._readyWork = (async () => {
      try {
        await this._ensureSchema();
        await this.rescan();
      } catch (e) {
        console.error(`permission ledger: Postgres ready-work failed: ${(e && e.message) || e}`);
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
         host text NOT NULL,
         id text NOT NULL,
         opened_at bigint NOT NULL,
         doc text NOT NULL,
         PRIMARY KEY (host, id)
       )`);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS permission_event_opened_at ON ${this.table} (opened_at)`);
    this._schemaReady = true;
  }

  // Load the retained window into the hot model — boot/reconnect and promotion.
  // A max-of-two merge is not needed: a row is immutable once closed and the
  // newest write of an id wins in both places, so the store's copy REPLACES.
  async rescan(now = Date.now()) {
    await this._ensureSchema();
    const since = now - DAYS * DAY_MS;
    const got = await this.pool.query(
      `SELECT host, doc FROM ${this.table} WHERE opened_at >= $1 ORDER BY opened_at DESC LIMIT $2`,
      [String(since), String(MAX_ROWS)]);
    for (const r of got || []) {
      if (!r || typeof r.host !== "string" || !r.host || r.host === "__proto__") continue;
      let doc = null;
      try { doc = JSON.parse(r.doc); } catch { continue; }
      const row = sanitizePermissionEvent(doc, now);
      if (!row) continue;
      let m = hosts.get(r.host);
      if (!m) hosts.set(r.host, (m = new Map()));
      m.set(row.id, row);
    }
    evict(now);
    if (this._onExternalChange) { try { this._onExternalChange(); } catch { /* never breaks a scan */ } }
  }

  // Off the beat: enqueue only, a serialized background drain writes. Bounded —
  // a Postgres outage drops the OLDEST queued writes (the hot model keeps them
  // until the next promotion rescan), never grows the heap.
  onChange(host, rows) {
    for (const row of rows) this._queue.push([host, row.id, String(row.openedAt), JSON.stringify(row)]);
    const over = this._queue.length - PG_QUEUE_MAX;
    if (over > 0) {
      this._queue.splice(0, over);
      if (!this._dropped) console.error(`permission ledger: Postgres write queue over ${PG_QUEUE_MAX}; dropping oldest`);
      this._dropped += over;
    }
    this._drain();
  }

  _drain() {
    if (this._draining || this._closed) return this._draining;
    this._draining = (async () => {
      try {
        while (this._queue.length) {
          const batch = this._queue.splice(0, PG_ROWS_PER_INSERT);
          const params = [];
          const tuples = batch.map((vals) => `(${vals.map((v) => { params.push(v); return `$${params.length}`; }).join(", ")})`);
          try {
            await this._ensureSchema();
            await this.pool.query(
              `INSERT INTO ${this.table} (host, id, opened_at, doc) VALUES ${tuples.join(", ")} ` +
              `ON CONFLICT (host, id) DO UPDATE SET opened_at = EXCLUDED.opened_at, doc = EXCLUDED.doc`,
              params);
          } catch (e) {
            console.error(`permission ledger: Postgres write failed (${(e && e.message) || e}); ${batch.length} row(s) dropped`);
          }
        }
      } finally {
        this._draining = null;
      }
    })();
    return this._draining;
  }

  async sweep(now = Date.now()) {
    if (this._closed) return;
    await this._ensureSchema();
    await this.pool.query(`DELETE FROM ${this.table} WHERE opened_at < $1`,
      [String(now - DAYS * DAY_MS)]);
  }

  flush(done) {
    Promise.resolve(this._drain()).then(() => done && done(null), (e) => done && done(e));
  }

  async close() {
    this._closed = true;
    if (this._sweepTimer) { clearInterval(this._sweepTimer); this._sweepTimer = null; }
    if (this._offHealth) { try { this._offHealth(); } catch { /* best effort */ } this._offHealth = null; }
  }
}

/**
 * Pick the backend (server.js, once at boot, fire-and-forget). HA off: the file
 * backend loaded at require time stays. HA on: the Postgres append table, sharing
 * the hub's one pool; no pool under HA stays on the file and says so (degraded).
 */
async function configure(haConfig, pgClient, onExternalChange) {
  if (!haConfig || !haConfig.ha) return;
  if (!pgClient) {
    console.error("permission ledger: HA is on but no Postgres client was provided — staying on the local file (DEGRADED)");
    return;
  }
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const b = new PermissionLedgerPgStore(pgClient, { onExternalChange });
  backend = b;
  await b.init();
  console.log("permission ledger: using Postgres (permission_event) for the durable rows");
}

// Re-load from the of-record on LEADER PROMOTION; a no-op on the file backend.
function rehydrate() {
  return backend.rescan ? backend.rescan() : Promise.resolve();
}

function flush(done) { backend.flush(done); }

load();

module.exports = {
  ingest, aggregate, kindTotals, sanitizePermissionEvent, suggestedRule, configure,
  rehydrate, flush,
  LEDGER_FILE, MAX_ROWS, HOST_MAX_ROWS, DAYS, EVENTS_PER_BEAT, T_EVENT,
  PermissionLedgerPgStore,
  _internals: {
    hosts: () => hosts,
    rowCount, load, writeNow,
    reset() {
      hosts = new Map();
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (backend !== fileBackend) { try { backend.close(); } catch { /* noop */ } }
      backend = fileBackend;
    },
    getBackend: () => backend,
    setBackend(b) { backend = b; },
  },
};
