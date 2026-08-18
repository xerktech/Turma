// turma usage ledger — token usage that outlives the host that spent it.
//
// Token usage is an AGENT-DERIVED aggregate: `hub-agent.py`'s repo_usage_report()
// re-parses every transcript on the box each beat and reports `usage` +
// `repoUsage[]`. The hub kept only the newest snapshot, on the host's registry
// record, so all of it was lost the moment that record went away — a deleted
// host, a pruned one, an evicted one — and a host whose DISK was wiped came back
// reporting near-zero and overwrote its own history in place (XERK-338).
//
// The archive does not answer this: it stores each ended session's DISPLAYABLE
// entries ({uuid, role, ts, text}) and no token counts at all, it never sees a
// live session, and background-agent transcripts are outside it. So usage needs
// a durable store of its own, which is this.
//
// ## The model: a per-DAY high-water mark
//
// What a host spent on a given UTC day is a historical fact. The agent's report
// of that day can only UNDER-state it — transcripts are deleted, never invented —
// with the single exception of today, which is still growing. So the durable
// answer is the per-day, per-token-key MAXIMUM of everything ever reported, and
// an absent day means "not reported", never "zero".
//
// That is deliberately NOT a "carry the old total forward when the new one drops"
// rule, and it must not be replaced by one. A host's reported all-time total
// falls for two very different reasons, and only the day buckets tell them apart:
//   - the whole disk is gone (a wipe) — the old total is entirely additional;
//   - some transcripts are gone and the rest are not. Claude Code deletes its own
//     transcripts on `cleanupPeriodDays` (30 by default), so this is ROUTINE, not
//     an edge case. Adding the old total to the new one here would count every
//     surviving transcript twice, every month, forever.
// Under the max rule both are exact, because a day that vanished from the report
// keeps its recorded value and a day that grew takes the larger.
//
// ## All-time spend older than any day bucket: `pre`
//
// The agent reports 60 days of buckets (HISTORY_DAYS) plus an all-time total, so
// `total - sum(days)` is the spend too old to be in the report. This store keeps
// its own, longer day window, so a report's "too old" figure also covers days
// this store still holds — those are subtracted out before it is taken, or every
// day aging out of the agent's window would be counted twice. `pre` is a
// high-water mark like everything else, and a day trimmed out of the window is
// ADDED to it rather than dropped, so the all-time total never shrinks.
//
// All-time = `pre + sum(days)`, and `today`/`week` are recomputed from the day
// buckets, so no window is ever a stale snapshot of one.
//
// ## Known limitations
//
// The per-model breakdown and the sub-agent split carry no day buckets (only the
// three windows travel — see _finalize_usage), so they can only be high-water
// marks on their totals. After a wipe those recover as spend re-accumulates,
// where the headline figures are exact immediately. Deliberate: the alternative
// is apportioning invisible spend across models, which is fabrication.
//
// A repo RENAMED on a live host is reported under the new name while this store
// still holds the old one, so it charts as two series until the old name's days
// age out of the window. The host-level figures are unaffected — they are kept
// independently of the repo blocks, never summed from them.
"use strict";

const fs = require("fs");
const path = require("path");

const LEDGER_FILE = process.env.USAGE_LEDGER_FILE || "/data/usage-ledger.json";

// Same four keys the agent reports (hub-agent.py TOKEN_KEYS) and the hub coerces
// (normalizeTokenBucket). Anything else on a bucket is dropped on the way in.
const TOKEN_KEYS = ["input", "output", "cacheWrite", "cacheRead"];
// The rolling window behind `week`, in UTC days including today — hub-agent.py's
// WEEK_DAYS.
const WEEK_DAYS = 7;

function positiveEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// How many UTC days of per-day history a series keeps. The agent reports 60 and
// this store must hold more than that for its own window to be worth anything,
// but a day bucket is ~75 bytes of JSON PER REPO, in memory and in every
// /api/agents body. Twice the agent's window and four times the 30 days either
// chart draws; spend older than this is not lost, it folds into `pre`.
const LEDGER_DAYS = positiveEnv("USAGE_LEDGER_DAYS", 120);
// Repos kept per host, biggest spender first. A host that clones and drops repos
// over years would otherwise accumulate an entry per name it ever saw.
const LEDGER_REPOS = positiveEnv("USAGE_LEDGER_REPOS", 100);
// Hosts kept, least-recently-seen evicted first. Above AGENTS_MAX's 64 would be
// the wrong instinct: what is kept here is one usage block per host, and the byte
// ceiling below is the bound that actually holds — a count so high that the bytes
// always decide it first is not a second bound, just a slower one.
const LEDGER_HOSTS = positiveEnv("USAGE_LEDGER_HOSTS", 32);

// The ledger is held in memory and serialized whole on every save, so it is
// bounded as a FRACTION OF THE CONTAINER, like every other hub ceiling — a flat
// number larger than `mem_limit` can never refuse anything before the OOM killer
// fires. A 32nd of a 256 MiB hub is 8 MiB, against a measured real fleet whose
// entire usage payload is well under 1 MiB per host.
function containerMemoryLimit() {
  for (const p of ["/sys/fs/cgroup/memory.max",
                   "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    let raw;
    try { raw = fs.readFileSync(p, "utf8").trim(); } catch { continue; }
    if (raw === "max") continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n < 2 ** 40) return n;
  }
  return null;
}
const LEDGER_MAX = positiveEnv("USAGE_LEDGER_MAX", (() => {
  const limit = containerMemoryLimit();
  if (!limit) return 8 << 20;
  return Math.max(2 << 20, Math.min(8 << 20, Math.floor(limit / 32)));
})());
// How much of that may ride ONE /api/agents body as `retiredUsage`. The store's
// own ceiling is not this bound: it covers the whole history including hosts that
// are still live and therefore already in `agents`, and the fleet payload is
// re-serialized per beat and fanned out to every dashboard, phone and pair of
// glasses. Newest-first, so a truncation drops the oldest history rather than the
// spend anyone is looking at.
const RETIRED_MAX = positiveEnv("USAGE_LEDGER_SERVE_MAX", 1 << 20);

// How long a change may sit unsaved. A beat that ADDS to the history is the thing
// this file exists for and is saved promptly; a beat that only re-states what is
// already recorded — which is almost all of them — rides a slow timer, because
// rewriting the whole file at the beat rate would be ~10,000 rewrites a day,
// forever, to protect nothing.
const SAVE_DEBOUNCE_MS = positiveEnv("USAGE_LEDGER_SAVE_MS", 5 * 1000);
const SNAPSHOT_MS = positiveEnv("USAGE_LEDGER_SNAPSHOT_MS", 5 * 60 * 1000);

// ---- buckets ----------------------------------------------------------------

// A token figure as it may be used. Everything reaching here has been through the
// hub's normalizeTokenBucket, but this store also reads its OWN file back, which
// an operator can edit and an older build can have written.
function num(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}
function blankBucket() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}
function bucketOf(b) {
  const out = blankBucket();
  if (b && typeof b === "object") for (const k of TOKEN_KEYS) out[k] = num(b[k]);
  return out;
}
function addBucket(dst, src) {
  if (src) for (const k of TOKEN_KEYS) dst[k] += num(src[k]);
  return dst;
}
// The high-water rule itself, per key: a report can only under-state a past day.
function raiseBucket(dst, src) {
  if (src) for (const k of TOKEN_KEYS) { const v = num(src[k]); if (v > dst[k]) dst[k] = v; }
  return dst;
}
// dst -= src, floored at zero per key. Used to take a report's "spend older than
// its day window" apart; the subtrahend is a HIGH-WATER figure, so it can exceed
// what the report claims and the floor is load-bearing, not defensive.
function subBucket(dst, src) {
  if (src) for (const k of TOKEN_KEYS) dst[k] = Math.max(0, dst[k] - num(src[k]));
  return dst;
}
function bucketTokens(b) {
  let n = 0;
  if (b) for (const k of TOKEN_KEYS) n += num(b[k]);
  return n;
}
function bucketExceeds(a, b) {
  for (const k of TOKEN_KEYS) if (num(a[k]) > num(b && b[k])) return true;
  return false;
}
function isoDay(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
function utcToday(now) {
  return new Date(now === undefined ? Date.now() : now).toISOString().slice(0, 10);
}
// The WEEK_DAYS UTC dates ending today, as a Set. Dated by UTC-midnight epoch
// arithmetic, which cannot skip or repeat a day the way a local-time Date walk
// can — the same rule hub-agent.py's _week_window() follows.
function weekWindow(now) {
  const end = Date.parse(utcToday(now) + "T00:00:00Z");
  const out = new Set();
  for (let i = 0; i < WEEK_DAYS; i++) out.add(new Date(end - i * 86400000).toISOString().slice(0, 10));
  return out;
}

// ---- the reported shape -----------------------------------------------------

// One usage block reduced to what this store reads. Built fresh throughout: the
// input is the live registry record, which must never be aliased, let alone
// mutated, by anything downstream.
function usageOf(u) {
  if (!u || typeof u !== "object") return null;
  const days = {};
  if (u.days && typeof u.days === "object" && !Array.isArray(u.days)) {
    for (const [d, b] of Object.entries(u.days)) if (isoDay(d)) days[d] = bucketOf(b);
  }
  const models = {};
  if (Array.isArray(u.models)) {
    for (const m of u.models) {
      if (!m || typeof m !== "object" || typeof m.model !== "string" || !m.model) continue;
      if (m.model === "__proto__") continue;
      models[m.model] = { totals: bucketOf(m.totals), today: bucketOf(m.today), week: bucketOf(m.week) };
    }
  }
  return {
    totals: bucketOf(u.totals), days, models, sessions: num(u.sessions),
    lastActivity: typeof u.lastActivity === "string" ? u.lastActivity : null,
    // A SLICE of the block, never an addend (XERK-302), and absent means "that
    // agent can't tell you" — carried through as absent rather than manufactured
    // as zeroes, which would assert nothing was ever delegated.
    subagent: u.subagent && typeof u.subagent === "object" ? {
      totals: bucketOf(u.subagent.totals),
      today: bucketOf(u.subagent.today),
      week: bucketOf(u.subagent.week),
    } : null,
  };
}

// The per-repo list, reduced the same way. `remoteKey` is the agent's normalized
// git origin, which is what unifies one repo across hosts on both clients, so it
// is what this store keys on too.
function reposOf(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const usage = usageOf(r.usage);
    if (!usage) continue;
    const repo = typeof r.repo === "string" ? r.repo : "";
    const remoteKey = (typeof r.remoteKey === "string" && r.remoteKey) || repo;
    if (!remoteKey || remoteKey === "__proto__") continue;
    out.push({
      repo, remoteKey, remote: typeof r.remote === "string" ? r.remote : "", usage,
    });
  }
  return out;
}

// ---- a stored series --------------------------------------------------------
//
// { pre, days, models, subagent, sessions, lastActivity } — see the header.

function blankSeries() {
  return {
    // `cutoff` is the newest date this series has ever folded into `pre`.
    // Without it, trimming is not idempotent: a report that still carries a
    // trimmed day re-adds it to `days`, the next trim adds it to `pre` AGAIN,
    // and the all-time total climbs on every beat. It cannot fire at the shipped
    // sizing (the window is twice the agent's), which is exactly why it needs to
    // be closed here rather than left to a comment about the sizing.
    pre: blankBucket(), days: {}, models: {}, cutoff: null,
    subagent: null, sessions: 0, lastActivity: null,
  };
}

function seriesOf(raw) {
  const s = blankSeries();
  if (!raw || typeof raw !== "object") return s;
  s.pre = bucketOf(raw.pre);
  if (raw.days && typeof raw.days === "object" && !Array.isArray(raw.days)) {
    for (const [d, b] of Object.entries(raw.days)) if (isoDay(d)) s.days[d] = bucketOf(b);
  }
  if (raw.models && typeof raw.models === "object" && !Array.isArray(raw.models)) {
    for (const [m, b] of Object.entries(raw.models)) if (m && m !== "__proto__") s.models[m] = bucketOf(b);
  }
  if (raw.subagent) s.subagent = bucketOf(raw.subagent);
  if (isoDay(raw.cutoff)) s.cutoff = raw.cutoff;
  s.sessions = num(raw.sessions);
  s.lastActivity = typeof raw.lastActivity === "string" ? raw.lastActivity : null;
  trimDays(s);
  return s;
}

// Hold a series' day map to the window. A trimmed day is FOLDED INTO `pre`, never
// dropped: `pre + sum(days)` is the all-time total, so discarding a bucket would
// make a host's lifetime spend shrink as it aged.
function trimDays(s) {
  const keys = Object.keys(s.days);
  if (keys.length <= LEDGER_DAYS) return s;
  keys.sort();
  for (const d of keys.slice(0, keys.length - LEDGER_DAYS)) {
    addBucket(s.pre, s.days[d]);
    delete s.days[d];
    if (!s.cutoff || d > s.cutoff) s.cutoff = d;
  }
  return s;
}

function cloneSeries(s) {
  const out = blankSeries();
  out.pre = bucketOf(s.pre);
  for (const [d, b] of Object.entries(s.days)) out.days[d] = bucketOf(b);
  for (const [m, b] of Object.entries(s.models)) out.models[m] = bucketOf(b);
  if (s.subagent) out.subagent = bucketOf(s.subagent);
  out.cutoff = s.cutoff;
  out.sessions = s.sessions;
  out.lastActivity = s.lastActivity;
  return out;
}

function seriesTotals(s) {
  const out = bucketOf(s.pre);
  for (const b of Object.values(s.days)) addBucket(out, b);
  return out;
}

/**
 * Raise one series to a report. Returns whether the store still holds something
 * the report did NOT — i.e. whether serving this host means serving more than it
 * just said. That answer is what lets the common case (a host that has never lost
 * a transcript) be served byte-for-byte as its agent sent it.
 */
function absorb(s, u) {
  let augments = false;
  // `pre` is the report's "spend older than its day window" MINUS the days this
  // store holds that the report no longer carries — those are inside that figure,
  // and without subtracting them every day aging out of the agent's 60-day window
  // would be counted twice, once in `pre` and once in its own kept bucket.
  const reportedDays = blankBucket();
  for (const b of Object.values(u.days)) addBucket(reportedDays, b);
  const preR = subBucket(bucketOf(u.totals), reportedDays);
  const held = blankBucket();
  for (const [d, b] of Object.entries(s.days)) {
    if (d in u.days) continue;
    addBucket(held, b);
    augments = true; // a day the report has stopped mentioning
  }
  // A report reaching further back than this store's own window carries days
  // already inside `pre`, so what is left of its remainder under-states `pre` —
  // which the high-water raise below absorbs, since `pre` only ever grows.
  subBucket(preR, held);
  if (bucketExceeds(s.pre, preR)) augments = true;
  raiseBucket(s.pre, preR);

  for (const [d, b] of Object.entries(u.days)) {
    // Already inside `pre` (see blankSeries' note on `cutoff`). Re-admitting it
    // would have the next trim add it to `pre` a second time.
    if (s.cutoff && d <= s.cutoff) continue;
    const cur = s.days[d] || (s.days[d] = blankBucket());
    if (bucketExceeds(cur, b)) augments = true; // that day was bigger once
    raiseBucket(cur, b);
  }
  trimDays(s);

  for (const [m, mu] of Object.entries(u.models)) {
    const cur = s.models[m] || (s.models[m] = blankBucket());
    if (bucketExceeds(cur, mu.totals)) augments = true;
    raiseBucket(cur, mu.totals);
  }
  for (const m of Object.keys(s.models)) if (!(m in u.models)) augments = true;

  if (u.subagent) {
    s.subagent = s.subagent || blankBucket();
    if (bucketExceeds(s.subagent, u.subagent.totals)) augments = true;
    raiseBucket(s.subagent, u.subagent.totals);
  }
  if (u.sessions > s.sessions) s.sessions = u.sessions;
  else if (u.sessions < s.sessions) augments = true;
  if (u.lastActivity && (!s.lastActivity || u.lastActivity > s.lastActivity)) {
    s.lastActivity = u.lastActivity;
  }
  return augments;
}

/**
 * Render a stored series as a usage block, in the shape `_finalize_usage` emits.
 * `live` is that series' newest report, or null for a host the hub no longer has.
 *
 * `today`/`week` come from the day buckets rather than from any stored window, so
 * neither can be a snapshot that was true once. The per-model and sub-agent
 * windows have no day buckets to rebuild from and come from `live` alone — see
 * the header's limitation note.
 */
function render(s, live, now) {
  const days = {};
  for (const [d, b] of Object.entries(s.days)) days[d] = bucketOf(b);
  const window = weekWindow(now);
  const week = blankBucket();
  for (const [d, b] of Object.entries(days)) if (window.has(d)) addBucket(week, b);
  const models = Object.entries(s.models).map(([model, totals]) => ({
    model, totals: bucketOf(totals),
    today: bucketOf(live && live.models[model] && live.models[model].today),
    week: bucketOf(live && live.models[model] && live.models[model].week),
  })).sort((x, y) => bucketTokens(y.totals) - bucketTokens(x.totals));
  const out = {
    totals: seriesTotals(s),
    today: bucketOf(days[utcToday(now)]),
    week, days, models,
    sessions: s.sessions,
  };
  if (s.lastActivity) out.lastActivity = s.lastActivity;
  if (s.subagent) {
    out.subagent = {
      totals: bucketOf(s.subagent),
      today: bucketOf(live && live.subagent && live.subagent.today),
      week: bucketOf(live && live.subagent && live.subagent.week),
    };
  }
  return out;
}

// ---- the store --------------------------------------------------------------

// hostKey -> {device, siteKey, firstSeen, lastSeen, augments, host, repos}
// where `host` is a series and `repos` is remoteKey -> {repo, remote, series}.
let hosts = Object.create(null);

function entryOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const repos = Object.create(null);
  if (raw.repos && typeof raw.repos === "object" && !Array.isArray(raw.repos)) {
    for (const [key, r] of Object.entries(raw.repos)) {
      if (!key || key === "__proto__" || !r || typeof r !== "object") continue;
      repos[key] = {
        repo: typeof r.repo === "string" ? r.repo : "",
        remote: typeof r.remote === "string" ? r.remote : "",
        series: seriesOf(r.series),
      };
    }
  }
  const host = raw.host ? seriesOf(raw.host) : null;
  if (!host && !Object.keys(repos).length) return null;
  return {
    device: typeof raw.device === "string" ? raw.device : "",
    siteKey: typeof raw.siteKey === "string" ? raw.siteKey : "",
    firstSeen: num(raw.firstSeen),
    lastSeen: num(raw.lastSeen),
    // Recomputed on this host's next beat; until then, serving the recorded
    // history is the safe answer for a record whose provenance is a file.
    augments: true,
    host, repos,
  };
}

function load() {
  hosts = Object.create(null);
  try {
    // Measured before it is opened, for the reason the state.json restore spells
    // out: readFileSync materializes the whole file, so an oversized one is an
    // OOM at init — on every boot, which `restart: unless-stopped` turns into a
    // crash loop. Kept beside itself rather than deleted; it is the only copy.
    const size = fs.statSync(LEDGER_FILE).size;
    if (size > LEDGER_MAX) {
      const aside = `${LEDGER_FILE}.oversized`;
      let movedTo = null;
      try { fs.renameSync(LEDGER_FILE, aside); movedTo = aside; } catch { /* read-only volume */ }
      throw new Error(
        `usage ledger is ${size} bytes, over the ${LEDGER_MAX} limit — starting ` +
          `empty; the file is ` +
          (movedTo ? `kept at ${movedTo}` : `left in place at ${LEDGER_FILE} (could not move it)`)
      );
    }
    const parsed = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
    const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.hosts : null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("usage ledger has no `hosts` object");
    }
    let kept = 0;
    for (const [key, value] of Object.entries(raw)) {
      if (!key || key === "__proto__") continue;
      const entry = entryOf(value);
      if (!entry) continue;
      hosts[key] = entry;
      kept += 1;
    }
    evictOverflow();
    if (kept) console.log(`loaded usage history for ${kept} host(s) from ${LEDGER_FILE}`);
  } catch (e) {
    if (!e || e.code !== "ENOENT") {
      hosts = Object.create(null);
      console.error(`usage ledger restore skipped: ${(e && e.message) || e}`);
    }
  }
}

// Least-recently-seen first, until both the count and the byte ceilings hold. A
// host still beating has `lastSeen` of now, so what goes is always the oldest
// retired history — the only thing here that can be given up.
function evictOverflow() {
  let dropped = 0;
  const keys = Object.keys(hosts).sort((a, b) => (hosts[a].lastSeen || 0) - (hosts[b].lastSeen || 0));
  while (keys.length > LEDGER_HOSTS) { delete hosts[keys.shift()]; dropped += 1; }
  let blob = serialize();
  while (blob !== null && blob.length > LEDGER_MAX && keys.length > 1) {
    delete hosts[keys.shift()];
    dropped += 1;
    blob = serialize();
  }
  if (dropped) {
    console.warn(
      `usage ledger over its ${LEDGER_HOSTS}-host / ${LEDGER_MAX}-byte budget — ` +
        `dropped the ${dropped} least-recently-seen host(s)`
    );
  }
  return blob;
}

function serialize() {
  try {
    return JSON.stringify({ version: 1, hosts });
  } catch (e) {
    // Failing to save is survivable; throwing out of a save TIMER is not — that
    // is an uncaught exception on the main loop and the whole hub exits, taking
    // every host's control plane with it (XERK-235).
    console.error(`usage ledger save skipped — could not serialize: ${e.message}`);
    return null;
  }
}

let saveTimer = null;
let snapshotTimer = null;
// Asynchronous, like every other /data store: the blob can be megabytes and this
// runs on a timer on the main loop, where a sync write would stall every
// heartbeat in flight. `done` is a test seam, not a caller contract.
function writeNow(done) {
  const blob = evictOverflow();
  if (blob === null) return void (done && done(new Error("not serializable")));
  fs.mkdir(path.dirname(LEDGER_FILE), { recursive: true }, () => {
    fs.writeFile(LEDGER_FILE, blob, (err) => {
      if (err) console.error(`usage ledger save failed: ${err.message}`);
      if (done) done(err || null);
    });
  });
}
function scheduleSave() {
  if (saveTimer) return;
  if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
  saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, SAVE_DEBOUNCE_MS);
  saveTimer.unref();
}
function scheduleSnapshot() {
  if (saveTimer || snapshotTimer) return;
  snapshotTimer = setTimeout(() => { snapshotTimer = null; writeNow(); }, SNAPSHOT_MS);
  snapshotTimer.unref();
}

// A host name reaches the log from an agent-supplied field, so it gets the same
// treatment server.js's logName gives it: JSON.stringify does the line-forging
// half, and the sweep after it covers the control characters JSON leaves intact
// (C0, DEL and C1 — NEL is a line break to some readers).
function logName(key) {
  return JSON.stringify(String(key).slice(0, 200))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

// Hold one host's repo set to its cap, biggest spender first. Dropping a repo
// drops history, so it is logged — silence here reads as a fleet that spent less.
function trimRepos(key, entry) {
  const keys = Object.keys(entry.repos);
  if (keys.length <= LEDGER_REPOS) return;
  keys.sort((a, b) =>
    bucketTokens(seriesTotals(entry.repos[b].series)) - bucketTokens(seriesTotals(entry.repos[a].series)));
  const gone = keys.slice(LEDGER_REPOS);
  for (const k of gone) delete entry.repos[k];
  console.warn(
    `usage ledger: ${logName(key)} has more than ${LEDGER_REPOS} repos ` +
      `(USAGE_LEDGER_REPOS) — dropped the ${gone.length} smallest`
  );
}

// One line per host per hour at most: a host whose recorded history exceeds its
// report is a STEADY state (every beat after a wipe), not an event.
const shortfallLoggedAt = new Map();
function noteShortfall(key, recorded, reported, now) {
  if (recorded <= reported) return;
  if (now - (shortfallLoggedAt.get(key) || 0) < 60 * 60 * 1000) return;
  shortfallLoggedAt.set(key, now);
  console.log(
    `usage ledger: ${logName(key)} reports ${reported} all-time tokens against the ` +
      `${recorded} this hub has recorded — serving the recorded history`
  );
}

// ---- the API ----------------------------------------------------------------

/**
 * Fold one accepted heartbeat into the ledger. Called with the COERCED record
 * (normalizeRecord has run), after every gate that could still refuse the beat —
 * a refused beat is not history.
 */
function ingest(key, record, now = Date.now()) {
  if (!key || !record || typeof record !== "object") return;
  const usage = usageOf(record.usage);
  const repos = reposOf(record.repoUsage);
  let entry = hosts[key];
  const fresh = !entry;
  if (fresh) {
    // A host that has never spent anything is not history worth a slot; it gets
    // one on the first beat that reports tokens.
    if (!usage && !repos.length) return;
    entry = hosts[key] = {
      device: "", siteKey: "", firstSeen: now, lastSeen: now,
      augments: false, host: null, repos: Object.create(null),
    };
  }
  entry.lastSeen = now;
  if (typeof record.device === "string" && record.device) entry.device = record.device;
  const siteKey = record.jira && typeof record.jira.siteKey === "string" ? record.jira.siteKey : "";
  if (siteKey) entry.siteKey = siteKey;

  let augments = false;
  if (usage) {
    entry.host = entry.host || blankSeries();
    if (absorb(entry.host, usage)) augments = true;
    noteShortfall(key, bucketTokens(seriesTotals(entry.host)), bucketTokens(usage.totals), now);
  }
  const reported = new Set();
  for (const r of repos) {
    reported.add(r.remoteKey);
    const slot = entry.repos[r.remoteKey] ||
      (entry.repos[r.remoteKey] = { repo: r.repo, remote: r.remote, series: blankSeries() });
    // The LIVE report wins the labels: a repo renamed on disk should read under
    // its current name, not the one it carried when it was first recorded.
    if (r.repo) slot.repo = r.repo;
    if (r.remote) slot.remote = r.remote;
    if (absorb(slot.series, r.usage)) augments = true;
  }
  // A repo this host has stopped reporting keeps its history — that is the whole
  // point — which also means this host can never again be served raw.
  for (const k of Object.keys(entry.repos)) if (!reported.has(k)) augments = true;
  trimRepos(key, entry);
  entry.augments = augments;
  if (augments || fresh) scheduleSave(); else scheduleSnapshot();
}

// What one series is SERVED as: everything recorded, raised by the newest report.
//
// It raises a COPY through `absorb` rather than rendering the stored series
// directly, so there is exactly one implementation of the high-water rule. The
// stored series is not necessarily current: `state.json` is saved every 30s and
// this store's ordinary beats ride a 5-minute snapshot timer, so after a hub
// restart the registry can hold a NEWER report than the file did — and until that
// host beats again, rendering the store alone would serve the older numbers.
function servedSeries(stored, live, now) {
  if (!live) return render(stored, null, now);
  const merged = cloneSeries(stored);
  absorb(merged, live);
  return render(merged, live, now);
}

function repoBlocks(entry, liveRepos, now) {
  const out = Object.entries(entry.repos).map(([remoteKey, slot]) => ({
    repo: slot.repo, remote: slot.remote, remoteKey,
    usage: servedSeries(slot.series, (liveRepos && liveRepos.get(remoteKey) || {}).usage || null, now),
  }));
  // A repo in the report but not yet in the store — the same restore window the
  // comment above describes. Passed through rather than dropped.
  if (liveRepos) {
    for (const [remoteKey, r] of liveRepos) {
      if (entry.repos[remoteKey]) continue;
      const s = blankSeries();
      absorb(s, r.usage);
      out.push({ repo: r.repo, remote: r.remote, remoteKey, usage: render(s, r.usage, now) });
    }
  }
  return out.sort((a, b) => bucketTokens(b.usage.totals) - bucketTokens(a.usage.totals));
}

/**
 * The durable usage for a host that is STILL in the registry: everything this hub
 * has recorded, raised by what it just reported. Returns null when the store
 * holds nothing the report does not — which is every host that has never lost a
 * transcript, so the common path costs one map lookup and the record reaches the
 * client exactly as its agent sent it.
 */
function fold(key, record, now = Date.now()) {
  const entry = hosts[key];
  if (!entry || !entry.augments) return null;
  const live = usageOf(record && record.usage);
  const liveRepos = new Map(reposOf(record && record.repoUsage).map((r) => [r.remoteKey, r]));
  return {
    usage: entry.host ? servedSeries(entry.host, live, now) : (record && record.usage) || null,
    repoUsage: repoBlocks(entry, liveRepos, now),
  };
}

// Throttle for the truncation warning below: the condition that fires it is
// steady state, not an event, so an unthrottled line writes once per beat forever.
let retiredTruncLogAt = 0;

/**
 * Hosts the ledger remembers that the registry no longer has — deleted, pruned,
 * or evicted. Shaped as agent records so both clients can render them beside the
 * live fleet with the code they already have; `retired` is what marks them, and
 * `jira.siteKey` is carried so the org filter keeps applying to them.
 */
function retiredAgents(liveKeys, now = Date.now()) {
  const live = new Set(liveKeys || []);
  const keys = Object.keys(hosts)
    .filter((k) => !live.has(k))
    .sort((a, b) => (hosts[b].lastSeen || 0) - (hosts[a].lastSeen || 0));
  const out = [];
  let bytes = 0;
  let dropped = 0;
  for (const key of keys) {
    const entry = hosts[key];
    // Once ONE host has been dropped for size, stop rendering the rest. Keys are
    // newest-first, so the remainder is older history that is worth less than
    // what already shipped, and rendering it only to discard it is pure cost on
    // the serving path — measured 45.5 ms for 32 retired hosts at the day/repo
    // ceilings, of which 4 actually fit. (Bounded either way, unlike the raw
    // layer's cursor loop; but this runs inside `buildAgentsCache`, so it is a
    // hub-wide stall like every other synchronous step there.)
    //
    // Deliberately NOT "stop once `bytes` reaches the ceiling": it never does.
    // The total plateaus below it as soon as every remaining host individually
    // overflows what is left, so that test renders all 32 and saves nothing —
    // measured 48.1 ms, i.e. no change. The remainder is still COUNTED, because
    // the log has to say how much was left out.
    if (dropped && out.length) { dropped += 1; continue; }
    const usage = entry.host ? servedSeries(entry.host, null, now) : null;
    const repoUsage = repoBlocks(entry, null, now);
    if (!usage && !repoUsage.length) continue;
    const rec = {
      key, device: entry.device || key,
      retired: true,
      lastSeen: entry.lastSeen,
      online: false, terminalOnline: false,
      jira: entry.siteKey ? { siteKey: entry.siteKey } : null,
      usage, repoUsage,
    };
    let size;
    try { size = JSON.stringify(rec).length; } catch { continue; }
    if (bytes + size > RETIRED_MAX && out.length) { dropped += 1; continue; }
    bytes += size;
    out.push(rec);
  }
  // Never a silent truncation: a Usage page quietly missing a retired host's
  // spend reads as a fleet that spent less, with nothing to say otherwise.
  if (dropped && now - retiredTruncLogAt > 60 * 60 * 1000) {
    retiredTruncLogAt = now;
    console.warn(
      `usage ledger: ${dropped} retired host(s) left out of the fleet payload — ` +
        `it is already ${bytes} bytes of retired history against the ` +
        `${RETIRED_MAX}-byte serve budget (USAGE_LEDGER_SERVE_MAX)`
    );
  }
  out.sort((x, y) => (x.device + x.key).localeCompare(y.device + y.key));
  return out;
}

/** Drop one host's history outright. The only way to actually forget a host. */
function forget(key) {
  if (!Object.prototype.hasOwnProperty.call(hosts, key)) return false;
  delete hosts[key];
  shortfallLoggedAt.delete(key);
  scheduleSave();
  return true;
}

/** Whether anything is recorded for this host. */
function has(key) {
  return Object.prototype.hasOwnProperty.call(hosts, key);
}

load();

module.exports = {
  ingest, fold, retiredAgents, forget, has,
  LEDGER_FILE, LEDGER_MAX, LEDGER_DAYS, LEDGER_HOSTS, LEDGER_REPOS, RETIRED_MAX,
  // Test seams: the pure reducers, and a way to start from an empty store.
  _internals: {
    hosts: () => hosts,
    reset() {
      hosts = Object.create(null);
      shortfallLoggedAt.clear();
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
    },
    load, writeNow, absorb, render, servedSeries, blankSeries, seriesTotals, usageOf, reposOf,
    weekWindow, utcToday, bucketTokens,
  },
};
