#!/usr/bin/env node
/**
 * Rebuild a wiped host's usage history from the hub's own session archive.
 *
 * A host whose disk is wiped rejoins reporting only what is left on it, and the
 * usage ledger's per-day high-water rule can only preserve days it was told about
 * BEFORE the wipe. When the ledger never saw them (it post-dates the wipe, or the
 * host was never up while it ran), that history is gone from every measured
 * source: the archive's RENDERED layer carries `{uuid, role, ts, text}` and no
 * token counts at all, and its RAW layer — the byte-for-byte copy that does carry
 * usage blocks — only ever held what was still on the host's disk when the sync
 * ran, which after a wipe is nothing older than the wipe.
 *
 * What is left is the rendered text itself. This tool ESTIMATES the missing days
 * from it:
 *
 *   1. CALIBRATE on sessions that have BOTH layers — exact tokens from raw, and
 *      rendered characters from the projection beside it — giving tokens-per-
 *      rendered-character per token key, on the same host and workload wherever
 *      possible.
 *   2. APPLY that rate to the rendered-only sessions from before the wipe,
 *      bucketed by the UTC day of each entry's own timestamp, exactly as
 *      `_accumulate_usage` buckets a real one.
 *   3. MERGE the result into the ledger as day buckets, per host series and per
 *      repo series, taking the max against anything already recorded.
 *
 * The figures it writes are ESTIMATES and nothing in the ledger's format can say
 * so — see the WARNING in `README` beside this file before running it. They are
 * accurate in bulk and poor per day (validated: ±20% over a half-split of ~250
 * sessions, ±2–6x on any single day), and a `--drift` factor below 1 is applied
 * because calibrating on recent sessions and predicting older ones over-states
 * (measured 1.15–1.46x on a host with raw coverage spanning both periods).
 *
 * Deliberately NOT reconstructed: the per-model breakdown and the sub-agent
 * split. Both are recorded as totals with no day buckets, so apportioning
 * invisible spend across them would be fabrication with no anchor at all — the
 * ledger's own header makes that call and this tool keeps it.
 *
 * Usage (read-only by default; run it inside the hub container):
 *   node turma/tools/recover-usage-from-archive.js --host maxai --before 2026-08-16
 *   node turma/tools/recover-usage-from-archive.js --host maxai --before 2026-08-16 --write
 *
 * With `--write` the ledger file is backed up beside itself first. The hub holds
 * the ledger in memory and rewrites the whole file when it saves, so a write MUST
 * be followed by a restart of the hub process or it is simply overwritten.
 */

const fs = require("fs");
const path = require("path");

const KEYS = ["input", "output", "cacheWrite", "cacheRead"];
// The raw transcript's own names for the same four figures, in the same order.
const RAW_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
];

function parseArgs(argv) {
  const out = {
    archive: process.env.ARCHIVE_DIR || "/data/archive",
    ledger: process.env.USAGE_LEDGER_FILE || "/data/usage-ledger.json",
    host: null,
    ledgerHost: null,
    before: null,
    calibrateHost: null,
    drift: 0.8,
    write: false,
    json: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--archive") out.archive = next();
    else if (a === "--ledger") out.ledger = next();
    else if (a === "--host") out.host = next();
    else if (a === "--ledger-host") out.ledgerHost = next();
    else if (a === "--before") out.before = next();
    else if (a === "--calibrate-host") out.calibrateHost = next();
    else if (a === "--drift") out.drift = Number(next());
    else if (a === "--json") out.json = next();
    else if (a === "--write") out.write = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.host) throw new Error("--host is required (the archive's host name, case-insensitive)");
  if (!out.before || !/^\d{4}-\d{2}-\d{2}$/.test(out.before)) {
    throw new Error("--before is required, as YYYY-MM-DD: the first day the ledger's own record is trusted");
  }
  if (!Number.isFinite(out.drift) || out.drift <= 0) throw new Error("--drift must be a positive number");
  if (!out.calibrateHost) out.calibrateHost = out.host;
  return out;
}

const blank = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const tokensOf = (b) => KEYS.reduce((n, k) => n + (b[k] || 0), 0);
function addInto(dst, src) {
  for (const k of KEYS) dst[k] = (dst[k] || 0) + (src[k] || 0);
  return dst;
}
function raiseInto(dst, src) {
  for (const k of KEYS) if ((src[k] || 0) > (dst[k] || 0)) dst[k] = src[k] || 0;
  return dst;
}
const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Count a raw usage block the way `_token_count` does: non-negative integers only. */
function countRaw(usage) {
  const out = blank();
  RAW_KEYS.forEach((raw, i) => {
    const v = usage[raw];
    out[KEYS[i]] = typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
  });
  return out;
}

function walkJsonl(dir, files) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, files);
    else if (e.isFile() && e.name.endsWith(".jsonl")) files.push(p);
  }
  return files;
}

/**
 * Exact per-day usage from a session's RAW copy, deduped on (message id,
 * requestId) — the identity `_accumulate_usage` uses, because one assistant
 * message is written to the transcript once per content block and its usage
 * block is repeated on each. Skipping the dedupe roughly doubles every figure.
 */
function rawUsage(rawDir) {
  const seen = new Set();
  const days = Object.create(null);
  let entries = 0;
  for (const fp of walkJsonl(rawDir, [])) {
    let txt;
    try {
      txt = fs.readFileSync(fp, "utf8");
    } catch {
      continue;
    }
    for (const line of txt.split("\n")) {
      if (line.indexOf('"usage"') < 0) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = o && o.message;
      const usage = msg && msg.usage;
      if (!usage || typeof usage !== "object") continue;
      const id = typeof msg.id === "string" ? msg.id : "";
      const key = `${id}|${o.requestId || ""}`;
      if (id && seen.has(key)) continue;
      seen.add(key);
      const day = String(o.timestamp || "").slice(0, 10);
      if (!isDay(day)) continue;
      addInto((days[day] ||= blank()), countRaw(usage));
      entries += 1;
    }
  }
  return { days, entries };
}

/** Rendered-layer characters per UTC day — the estimator's one input. */
function renderedChars(file) {
  let txt;
  try {
    txt = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const days = Object.create(null);
  let entries = 0;
  for (const line of txt.split("\n")) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const day = String(o.ts || "").slice(0, 10);
    if (!isDay(day)) continue;
    days[day] = (days[day] || 0) + (typeof o.text === "string" ? o.text.length : 0);
    entries += 1;
  }
  return { days, entries };
}

/**
 * Every archived session: the rendered file, its `.meta` sidecar and its raw
 * directory if it has one. `meta.host` is the owner, NOT the host segment in the
 * file name — a migrated session keeps the name it was first archived under, so
 * reading the name would attribute another host's spend to this one.
 */
function inventory(archiveDir) {
  const rows = [];
  let repoDirs;
  try {
    repoDirs = fs.readdirSync(archiveDir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`cannot read archive at ${archiveDir}: ${(e && e.message) || e}`);
  }
  for (const ent of repoDirs) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(archiveDir, ent.name);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      let meta = null;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, `${name}.meta`), "utf8"));
      } catch {
        meta = null;
      }
      const rawDir = path.join(dir, `${name}.raw`);
      rows.push({
        dir,
        name,
        meta,
        host: String((meta && meta.host) || "").toLowerCase(),
        remoteKey: (meta && meta.remoteKey) || ent.name,
        repo: (meta && meta.repo) || ent.name,
        rawDir: fs.existsSync(rawDir) ? rawDir : null,
      });
    }
  }
  return rows;
}

/** Tokens per rendered character, per key, from sessions holding both layers. */
function calibrate(rows, host) {
  const tokens = blank();
  let chars = 0;
  let sessions = 0;
  for (const r of rows) {
    if (r.host !== host || !r.rawDir) continue;
    const rendered = renderedChars(path.join(r.dir, r.name));
    if (!rendered) continue;
    const c = Object.values(rendered.days).reduce((n, v) => n + v, 0);
    if (!c) continue;
    const raw = rawUsage(r.rawDir);
    if (!raw.entries) continue;
    for (const b of Object.values(raw.days)) addInto(tokens, b);
    chars += c;
    sessions += 1;
  }
  if (!chars || !sessions) return null;
  const rate = {};
  for (const k of KEYS) rate[k] = tokens[k] / chars;
  return { rate, chars, sessions, tokens };
}

/**
 * A repo with no detectable git origin keys on its bare NAME (`reposOf`:
 * `remoteKey || repo`), so the same repo archived before its remote was readable
 * sits under "Turma" while the live ledger keys it "github.com/xerktech/turma".
 * Injecting the bare name would split one repo's history into two series on a
 * page whose whole job is unifying a repo across hosts. Fold a bare name onto a
 * URL key when exactly one URL key claims that display name — never when two do,
 * since two owners' `turma` are not one repo.
 */
function canonicalRepoKeys(rows, ledger) {
  const byName = new Map(); // lowercased display name -> url key, or null if ambiguous
  const offer = (name, key) => {
    if (!name || !key || !key.includes("/")) return;
    const n = name.toLowerCase();
    if (byName.has(n) && byName.get(n) !== key) byName.set(n, null);
    else byName.set(n, key);
  };
  const hosts = (ledger && ledger.hosts) || {};
  for (const entry of Object.values(hosts)) {
    for (const [key, r] of Object.entries((entry && entry.repos) || {})) offer(r && r.repo, key);
  }
  for (const r of rows) offer(r.repo, r.remoteKey);
  return (key, repo) => {
    if (!key || key.includes("/")) return key;
    const hit = byName.get(String(repo || key).toLowerCase()) || byName.get(key.toLowerCase());
    return hit || key;
  };
}

function main() {
  const opts = parseArgs(process.argv);
  const host = opts.host.toLowerCase();
  const rows = inventory(opts.archive);
  const mine = rows.filter((r) => r.host === host);
  if (!mine.length) {
    const hosts = [...new Set(rows.map((r) => r.host).filter(Boolean))].sort();
    throw new Error(`no archived sessions for host "${opts.host}" (archive holds: ${hosts.join(", ")})`);
  }

  let ledger = null;
  try {
    ledger = JSON.parse(fs.readFileSync(opts.ledger, "utf8"));
  } catch (e) {
    if (opts.write) throw e; // a dry run still works with no ledger to read
    console.error(`(could not read ${opts.ledger}: ${(e && e.message) || e} — repo keys will not be canonicalised)`);
  }
  const canonical = canonicalRepoKeys(rows, ledger);

  const cal = calibrate(rows, opts.calibrateHost.toLowerCase());
  if (!cal) throw new Error(`no session on "${opts.calibrateHost}" carries both a raw copy and rendered text, so there is nothing to calibrate against`);
  const rate = {};
  for (const k of KEYS) rate[k] = cal.rate[k] * opts.drift;

  // Estimate every rendered-only session that ended before the trusted cutoff. A
  // session WITH a raw copy is measured, not estimated, and is left alone even
  // when it predates the cutoff: its exact figures are already what the ledger
  // holds.
  const hostDays = Object.create(null);
  const repos = Object.create(null);
  let estimated = 0;
  let skippedRaw = 0;
  const folded = new Map();
  for (const r of mine) {
    if (r.rawDir) {
      skippedRaw += 1;
      continue;
    }
    const rendered = renderedChars(path.join(r.dir, r.name));
    if (!rendered || !rendered.entries) continue;
    const key = canonical(r.remoteKey, r.repo);
    if (key !== r.remoteKey) folded.set(r.remoteKey, key);
    const repo = (repos[key] ||= { repo: r.repo, remote: "", days: Object.create(null), sessions: 0 });
    let counted = false;
    for (const [day, chars] of Object.entries(rendered.days)) {
      if (day >= opts.before || !chars) continue;
      const bucket = blank();
      for (const k of KEYS) bucket[k] = Math.round(chars * rate[k]);
      addInto((hostDays[day] ||= blank()), bucket);
      addInto((repo.days[day] ||= blank()), bucket);
      counted = true;
    }
    if (counted) {
      repo.sessions += 1;
      estimated += 1;
    }
  }

  const days = Object.keys(hostDays).sort();
  const total = days.reduce((n, d) => n + tokensOf(hostDays[d]), 0);
  const report = {
    host: opts.host,
    archive: opts.archive,
    ledger: opts.ledger,
    before: opts.before,
    drift: opts.drift,
    calibration: {
      host: opts.calibrateHost,
      sessions: cal.sessions,
      chars: cal.chars,
      tokensPerChar: cal.rate,
      appliedTokensPerChar: rate,
    },
    sessions: { archived: mine.length, measuredSkipped: skippedRaw, estimated },
    days: { count: days.length, first: days[0] || null, last: days[days.length - 1] || null },
    estimatedTokens: total,
    foldedRepoKeys: Object.fromEntries(folded),
    byRepo: Object.fromEntries(
      Object.entries(repos)
        .map(([k, v]) => [k, Object.values(v.days).reduce((n, b) => n + tokensOf(b), 0)])
        .sort((a, b) => b[1] - a[1])
    ),
  };

  if (opts.json) fs.writeFileSync(opts.json, `${JSON.stringify({ report, hostDays, repos }, null, 1)}\n`);

  console.log(JSON.stringify(report, null, 2));
  if (!opts.write) {
    console.log("\n-- dry run: pass --write to merge these day buckets into the ledger --");
    return;
  }
  if (!days.length) throw new Error("nothing to write");

  const ledgerHost = opts.ledgerHost || opts.host;
  const parsed = ledger;
  if (!parsed || typeof parsed !== "object" || !parsed.hosts || typeof parsed.hosts !== "object") {
    throw new Error(`${opts.ledger} has no \`hosts\` object`);
  }
  const entry = parsed.hosts[ledgerHost];
  if (!entry) {
    throw new Error(
      `${opts.ledger} holds no host "${ledgerHost}" (has: ${Object.keys(parsed.hosts).join(", ")}) — ` +
        "pass --ledger-host with the name the hub records, which is the device name and not the archive's"
    );
  }
  const backup = `${opts.ledger}.pre-recover.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(opts.ledger, backup);

  // Raise, never overwrite: the ledger's rule is a per-day high-water mark, and
  // a day it already holds was MEASURED — an estimate must not lower it.
  const merge = (series, dayMap) => {
    series.days = series.days && typeof series.days === "object" ? series.days : {};
    let added = 0;
    for (const [d, b] of Object.entries(dayMap)) {
      if (series.cutoff && d <= series.cutoff) continue; // already folded into `pre`
      if (!series.days[d]) added += 1;
      raiseInto((series.days[d] ||= blank()), b);
    }
    return added;
  };

  entry.host = entry.host || { pre: blank(), days: {}, models: {}, cutoff: null, subagent: null, sessions: 0, lastActivity: null };
  let addedDays = merge(entry.host, hostDays);
  entry.repos = entry.repos && typeof entry.repos === "object" ? entry.repos : {};
  let addedRepos = 0;
  for (const [key, r] of Object.entries(repos)) {
    if (!key || key === "__proto__") continue;
    if (!entry.repos[key]) {
      addedRepos += 1;
      entry.repos[key] = {
        repo: r.repo,
        remote: "",
        series: { pre: blank(), days: {}, models: {}, cutoff: null, subagent: null, sessions: 0, lastActivity: null },
      };
    }
    merge(entry.repos[key].series, r.days);
  }
  // `augments` is what tells the hub this host's stored history holds more than
  // its next report will. It is recomputed on that report, but the file is served
  // before one arrives.
  entry.augments = true;

  fs.writeFileSync(opts.ledger, `${JSON.stringify(parsed)}\n`);
  console.log(
    `\nwrote ${opts.ledger}: +${addedDays} day bucket(s) on the host series, ` +
      `${addedRepos} new repo series (backup: ${backup})`
  );
  console.log("RESTART THE HUB — it rewrites this file from memory on its next save.");
}

try {
  main();
} catch (e) {
  console.error(`recover-usage-from-archive: ${(e && e.message) || e}`);
  process.exit(1);
}
