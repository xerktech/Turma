// Unit tests for turma/usage-ledger.js — the durable token-usage history that
// outlives the host that spent it (XERK-338).
//
// The thing under test is the PER-DAY HIGH-WATER model: what a host spent on a
// given UTC day is a fact its agent's report can only under-state, so the durable
// answer is the maximum ever reported for that day. What these hold is that the
// two ways a report shrinks — the whole disk gone, and Claude Code's own
// `cleanupPeriodDays` deleting transcripts out from under a live host — come out
// right without the store being told which happened. A rule that got that wrong
// would be invisible: one silently loses history, the other silently doubles it,
// and both look like an ordinary chart.
//
// Its own process: the module reads its file and its budgets at REQUIRE time.
// node:test, no npm.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const LEDGER = path.join(os.tmpdir(), `turma-usage-ledger-${process.pid}.json`);
process.env.USAGE_LEDGER_FILE = LEDGER;
// Wound down from the fleet's 120/100/32 so retention and eviction are testable
// at a handful of entries rather than by inventing months of history.
process.env.USAGE_LEDGER_DAYS = "3";
process.env.USAGE_LEDGER_HOSTS = "3";
try { fs.unlinkSync(LEDGER); } catch { /* first run */ }
try { fs.unlinkSync(`${LEDGER}.oversized`); } catch { /* first run */ }

const ledger = require("../usage-ledger.js");
const { reset, hosts, load, writeNow, bucketTokens } = ledger._internals;

// ---- fixtures ---------------------------------------------------------------

const DAY = "2026-08-18";
const now = Date.parse(`${DAY}T12:00:00Z`);
const bucket = (n) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 });

/**
 * One usage block as the agent reports it (hub-agent.py _finalize_usage).
 * `days` is {date: tokens}; `totals` defaults to their sum but is passed
 * explicitly wherever the point is spend OLDER than the day window.
 */
function usage(days, { totals, models = { m1: 0 }, subagent = null, sessions = 1 } = {}) {
  const sum = Object.values(days).reduce((a, b) => a + b, 0);
  const all = totals === undefined ? sum : totals;
  return {
    totals: bucket(all), today: bucket(days[DAY] || 0), week: bucket(sum),
    days: Object.fromEntries(Object.entries(days).map(([d, n]) => [d, bucket(n)])),
    sessions, lastActivity: `${DAY}T11:00:00Z`,
    models: Object.entries(models).map(([m, n]) => ({
      model: m, totals: bucket(n || all), today: bucket(0), week: bucket(0),
    })),
    ...(subagent === null ? {} : {
      subagent: { totals: bucket(subagent), today: bucket(0), week: bucket(0) },
    }),
  };
}
/** A whole heartbeat record's usage half: a host block and one block per repo. */
function beat(days, repos, opts = {}) {
  return {
    device: opts.device || "host-a",
    jira: opts.siteKey === null ? null : { siteKey: opts.siteKey || "XERK" },
    usage: days === null ? null : usage(days, opts),
    repoUsage: Object.entries(repos || {}).map(([repo, d]) => ({
      repo, remoteKey: `rk-${repo}`, remote: `git@x:/${repo}.git`,
      usage: usage(d, opts),
    })),
  };
}
const totalOf = (u) => bucketTokens(u.totals);
/** What a live host is actually served: the fold, or its own report unchanged. */
function served(key, record) {
  return ledger.fold(key, record, now) || { usage: record.usage, repoUsage: record.repoUsage };
}
const repoTotal = (list, remoteKey) => {
  const r = list.find((x) => x.remoteKey === remoteKey);
  return r ? totalOf(r.usage) : null;
};

test.beforeEach(() => reset());

// ---- the high-water rule ----------------------------------------------------

test("a growing host is served exactly what it reported", () => {
  const first = beat({ [DAY]: 100 }, { r: { [DAY]: 100 } });
  ledger.ingest("h", first, now);
  const second = beat({ [DAY]: 250 }, { r: { [DAY]: 250 } });
  ledger.ingest("h", second, now);
  // Null, not a merged copy: with nothing recorded beyond the report there is
  // nothing to add, and the record must reach the client as the agent sent it.
  assert.equal(ledger.fold("h", second, now), null);
});

test("a wiped host keeps the history it can no longer see", () => {
  ledger.ingest("h", beat({ "2026-08-17": 1000 }, { r: { "2026-08-17": 1000 } }), now);
  // Same name, empty disk: the agent re-parses what is left and reports a
  // fraction of it, on a different day.
  const wiped = beat({ [DAY]: 30 }, { r: { [DAY]: 30 } });
  ledger.ingest("h", wiped, now);
  const out = served("h", wiped);
  assert.equal(totalOf(out.usage), 1030);
  assert.equal(repoTotal(out.repoUsage, "rk-r"), 1030);
  assert.equal(bucketTokens(out.usage.days["2026-08-17"]), 1000);
  assert.equal(bucketTokens(out.usage.days[DAY]), 30);
});

test("transcripts aging out from under a LIVE host are not counted twice", () => {
  // Claude Code deletes its own transcripts on `cleanupPeriodDays`, so a live,
  // healthy host's all-time total drops routinely. A carry-the-old-total rule
  // would add the 700 that is still on disk to itself, every month, forever.
  ledger.ingest("h", beat({ "2026-08-16": 300, "2026-08-17": 700 }), now);
  const pruned = beat({ "2026-08-17": 700 });
  ledger.ingest("h", pruned, now);
  assert.equal(totalOf(served("h", pruned).usage), 1000);
  // ...and again on the next beat: the answer has to be stable, not compounding.
  ledger.ingest("h", pruned, now);
  assert.equal(totalOf(served("h", pruned).usage), 1000);
});

test("a day the agent no longer reports keeps the figure it had", () => {
  ledger.ingest("h", beat({ "2026-08-17": 500, [DAY]: 10 }), now);
  const lost = beat({ [DAY]: 10 });
  ledger.ingest("h", lost, now);
  const out = served("h", lost).usage;
  assert.equal(bucketTokens(out.days["2026-08-17"]), 500);
  assert.equal(totalOf(out), 510);
});

test("a day that GREW takes the larger, never the sum", () => {
  ledger.ingest("h", beat({ [DAY]: 100 }), now);
  const grown = beat({ [DAY]: 140 });
  ledger.ingest("h", grown, now);
  const out = served("h", grown).usage;
  assert.equal(bucketTokens(out.days[DAY]), 140);
  assert.equal(totalOf(out), 140);
});

test("spend older than the day window survives without being double-counted", () => {
  // `pre` is the report's total minus its day buckets — spend too old to appear
  // in either. As days age out of the AGENT's window they move into that figure
  // while this store still holds their buckets, so they have to be subtracted
  // back out or every one of them lands in the total twice.
  ledger.ingest("h", beat({ "2026-08-17": 100, [DAY]: 50 }, null, { totals: 1000 }), now);
  let out = served("h", beat({ "2026-08-17": 100, [DAY]: 50 }, null, { totals: 1000 })).usage;
  assert.equal(totalOf(out), 1000);
  // Aug 17 ages out of the agent's window: it leaves `days` and its 100 moves
  // into the report's older-than-window remainder. The total must not move.
  const aged = beat({ [DAY]: 50 }, null, { totals: 1000 });
  ledger.ingest("h", aged, now);
  out = served("h", aged).usage;
  assert.equal(totalOf(out), 1000);
  assert.equal(bucketTokens(out.days["2026-08-17"]), 100);
});

test("a day trimmed out of the window is folded into the total, not dropped", () => {
  // USAGE_LEDGER_DAYS is 3 in this process. Held against the STORE rather than
  // the served block: an agent still reporting all four days is served all four
  // (the fold raises a copy of the store by the live report), and what is at
  // stake here is what survives once the agent stops sending the oldest one.
  ledger.ingest("h", beat({ "2026-08-14": 1, "2026-08-15": 2, "2026-08-16": 4, "2026-08-17": 8 }), now);
  const stored = hosts()["h"].host;
  assert.deepEqual(Object.keys(stored.days).sort(), ["2026-08-15", "2026-08-16", "2026-08-17"]);
  // The oldest day's tokens are still in the all-time figure — a lifetime total
  // that shrinks as history ages is the bug this exists to avoid.
  assert.equal(bucketTokens(ledger._internals.seriesTotals(stored)), 15);
  // And the served block still totals 15 once the agent has moved on.
  const later = beat({ "2026-08-15": 2, "2026-08-16": 4, "2026-08-17": 8 }, null, { totals: 15 });
  ledger.ingest("h", later, now);
  assert.equal(totalOf(served("h", later).usage), 15);
});

test("re-reporting a day this store has already trimmed does not compound", () => {
  // The trim folds a day into `pre`. If the report still carries that day, the
  // raise puts it back into `days` and the NEXT trim folds it in a second time —
  // an all-time total that climbs on every beat, forever, with nothing on screen
  // to say so. It cannot fire at the shipped sizing (the store's window is twice
  // the agent's), so it is pinned at the wound-down one instead: 4 reported days
  // against USAGE_LEDGER_DAYS=3.
  const b = beat({ "2026-08-14": 1, "2026-08-15": 2, "2026-08-16": 4, "2026-08-17": 8 });
  for (let i = 0; i < 5; i++) {
    ledger.ingest("h", b, now);
    assert.equal(bucketTokens(ledger._internals.seriesTotals(hosts()["h"].host)), 15,
      `beat ${i}: the all-time total must not grow by re-stating the same report`);
  }
});

test("today and week are recomputed from the day buckets", () => {
  const older = "2026-06-01"; // outside the week window ending DAY
  ledger.ingest("h", beat({ [older]: 900 }), now);
  const fresh = beat({ [DAY]: 10 });
  ledger.ingest("h", fresh, now);
  const out = served("h", fresh).usage;
  assert.equal(totalOf(out), 910);
  assert.equal(bucketTokens(out.today), 10);
  assert.equal(bucketTokens(out.week), 10);
});

test("a repo the agent stops reporting keeps its history", () => {
  ledger.ingest("h", beat({ [DAY]: 30 }, { a: { [DAY]: 20 }, b: { [DAY]: 10 } }), now);
  const gone = beat({ [DAY]: 20 }, { a: { [DAY]: 20 } });
  ledger.ingest("h", gone, now);
  const out = served("h", gone);
  assert.deepEqual(out.repoUsage.map((r) => r.remoteKey).sort(), ["rk-a", "rk-b"]);
  assert.equal(repoTotal(out.repoUsage, "rk-b"), 10);
});

test("the host block is kept independently of the repo blocks", () => {
  // The agent's reconciler moves a slug between repo names (a rename, a phantom
  // retired) without the host total changing. The host figure must not move.
  ledger.ingest("h", beat({ [DAY]: 500 }, { phantom: { [DAY]: 500 } }), now);
  const renamed = beat({ [DAY]: 500 }, { real: { [DAY]: 500 } });
  ledger.ingest("h", renamed, now);
  assert.equal(totalOf(served("h", renamed).usage), 500);
});

test("a per-model total is a high-water mark, its windows come from the report", () => {
  // Models carry no day buckets (only the three windows travel), so there is
  // nothing to recompute a window from — see the module header's limitation note.
  ledger.ingest("h", beat({ "2026-08-17": 600 }, null, { models: { m1: 600 } }), now);
  const fresh = beat({ [DAY]: 20 }, null, { models: { m1: 20 } });
  ledger.ingest("h", fresh, now);
  const m = served("h", fresh).usage.models.find((x) => x.model === "m1");
  assert.equal(bucketTokens(m.totals), 600);
});

test("the sub-agent split survives, stays a SLICE, and is never invented", () => {
  ledger.ingest("h", beat({ "2026-08-17": 800 }, null, { subagent: 300 }), now);
  const fresh = beat({ [DAY]: 50 }, null, { subagent: 10 });
  ledger.ingest("h", fresh, now);
  const out = served("h", fresh).usage;
  assert.equal(totalOf(out), 850);
  assert.equal(bucketTokens(out.subagent.totals), 300);
  // Absent means "that agent can't tell you", so it is never manufactured.
  reset();
  ledger.ingest("n", beat({ [DAY]: 100 }), now);
  assert.equal("subagent" in ledger.retiredAgents([], now)[0].usage, false);
});

// ---- retired hosts ----------------------------------------------------------

test("retiredAgents is exactly the hosts the registry no longer has", () => {
  ledger.ingest("live", beat({ [DAY]: 100 }, { r: { [DAY]: 100 } }, { device: "live" }), now);
  ledger.ingest("gone", beat({ [DAY]: 200 }, { r: { [DAY]: 200 } },
    { device: "gone", siteKey: "ACME" }), now);
  const out = ledger.retiredAgents(["live"], now);
  assert.deepEqual(out.map((a) => a.key), ["gone"]);
  const [rec] = out;
  assert.equal(rec.retired, true);
  assert.equal(rec.online, false);
  assert.equal(rec.device, "gone");
  // The org filter applies to a retired host too, so its last known site rides
  // along in the shape every client already filters on.
  assert.deepEqual(rec.jira, { siteKey: "ACME" });
  assert.equal(totalOf(rec.usage), 200);
  // Nothing else: a retired entry is usage and nothing that reads as a host.
  assert.equal("sessions" in rec, false);
  assert.equal("commands" in rec, false);
  assert.equal("repos" in rec, false);
});

test("a retired host's model windows read as zero, not as its last day's", () => {
  ledger.ingest("gone", beat({ [DAY]: 100 }, null, { models: { m1: 100 } }), now);
  const [rec] = ledger.retiredAgents([], now);
  const m = rec.usage.models.find((x) => x.model === "m1");
  assert.equal(bucketTokens(m.totals), 100);
  assert.equal(bucketTokens(m.today), 0);
  assert.equal(bucketTokens(m.week), 0);
});

test("the serve budget truncates newest-first, loudly, without rendering the rest", () => {
  // `retiredAgents` runs inside `buildAgentsCache`, so it is a hub-wide stall
  // like every other synchronous step there. It is bounded (unlike the raw
  // layer's cursor loop was), but it used to RENDER every host and then discard
  // the ones that did not fit — 45.5 ms for 32 hosts at the ceilings, of which 4
  // shipped. Stopping at the first drop takes that to 13.6 ms.
  const fresh = require("child_process").spawnSync(process.execPath, ["-e", `
    const os = require("os"), fs = require("fs"), path = require("path");
    process.env.USAGE_LEDGER_FILE = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "turma-serve-")), "l.json");
    process.env.USAGE_LEDGER_SERVE_MAX = "700";   // room for roughly one host
    const l = require(${JSON.stringify(path.join(__dirname, "..", "usage-ledger.js"))});
    const b = (n) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 });
    const blk = () => ({ totals: b(5), today: b(0), week: b(5),
      days: { "2026-08-18": b(5) }, sessions: 1, models: [] });
    // Ingested oldest-first, so "newest wins" cannot pass by insertion order.
    for (const [i, key] of ["old", "mid", "new"].entries()) {
      l.ingest(key, { device: key, usage: blk(),
        repoUsage: [{ repo: "r", remoteKey: "rk", remote: "", usage: blk() }] },
        1000 + i * 1000);
    }
    console.log(JSON.stringify(l.retiredAgents([]).map((a) => a.device)));
  `], { encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  const served = JSON.parse(fresh.stdout.trim().split("\n").pop());
  // The NEWEST survives a truncation: what is given up is the oldest history.
  assert.deepEqual(served, ["new"]);

  // And rendering STOPS at the first drop rather than carrying on to see what
  // else might fit. The observable difference needs THREE hosts: one that fits,
  // one that overflows, and behind it a small old one that would fit in what is
  // left. With the early exit the third is never reached; without it, it squeezes
  // in. A two-host fixture cannot tell them apart (the first host is always kept,
  // so the drop lands on the last one either way) — which is why deleting the
  // guard left the suite green (XERK-338 QA D8).
  //
  // Sizes are measured, not guessed: 751 / 5088 / 419 bytes at these shapes, so
  // a 1500-byte budget fits the first, is overflowed by the second, and has room
  // for the third.
  const squeeze = require("child_process").spawnSync(process.execPath, ["-e", `
    const os = require("os"), fs = require("fs"), path = require("path");
    process.env.USAGE_LEDGER_FILE = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "turma-squeeze-")), "l.json");
    process.env.USAGE_LEDGER_SERVE_MAX = "1500";
    const l = require(${JSON.stringify(path.join(__dirname, "..", "usage-ledger.js"))});
    const b = (n) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 });
    const blk = () => ({ totals: b(5), today: b(0), week: b(5),
      days: { "2026-08-18": b(5) }, sessions: 1, models: [] });
    const rec = (dev, repos) => ({ device: dev, usage: blk(),
      repoUsage: Array.from({ length: repos }, (_, i) =>
        ({ repo: "r" + i, remoteKey: "rk" + i, remote: "", usage: blk() })) });
    l.ingest("h3-old", rec("h3-old", 0), 1000);     // oldest, tiny, would fit
    l.ingest("h2-mid", rec("h2-mid", 14), 5000);    // overflows the budget
    l.ingest("h1-new", rec("h1-new", 1), 9000);     // newest, fits
    console.log(JSON.stringify(l.retiredAgents([]).map((a) => a.device)));
  `], { encoding: "utf8" });
  assert.equal(squeeze.status, 0, squeeze.stderr);
  assert.deepEqual(JSON.parse(squeeze.stdout.trim().split("\n").pop()), ["h1-new"],
    "a small older host squeezed in behind a large newer one — the loop did not stop");
  // And it says so — a Usage page quietly missing a host reads as a fleet that
  // spent less, with nothing on screen to say otherwise.
  assert.match(fresh.stderr, /USAGE_LEDGER_SERVE_MAX/);
});

// ---- the size guards (XERK-338 QA F8) ---------------------------------------
//
// Each of these pins a guard that shipped with NOTHING turning red if it were
// deleted. The store grows on agent-supplied STRINGS across BEATS, where the
// per-record ceiling bounds only one beat — so every one of them is what stands
// between a single host and the whole fleet's history.

test("the per-model breakdown is capped", () => {
  ledger.ingest("many", beat({ [DAY]: 10 }, null,
    { models: Object.fromEntries(Array.from({ length: 500 }, (_, i) => ["m" + i, 1])) }), now);
  const models = Object.keys(hosts()["many"].host.models);
  assert.ok(ledger.LEDGER_MODELS > 0, "the cap is not exported to assert against");
  assert.ok(models.length <= ledger.LEDGER_MODELS,
    `${models.length} models kept, cap is ${ledger.LEDGER_MODELS}`);
  // The biggest survive: what is dropped is a row of detail, never spend.
  assert.equal(totalOf(served("many", beat({ [DAY]: 10 }, null,
    { models: { m0: 1 } })).usage), 10);
});

test("every agent-supplied name is length-bounded", () => {
  const long = "m" + "x".repeat(5000);
  ledger.ingest("longname", beat({ [DAY]: 10 }, { ["r" + "y".repeat(5000)]: { [DAY]: 10 } },
    { models: { [long]: 1 } }), now);
  const e = hosts()["longname"];
  for (const name of Object.keys(e.host.models)) {
    assert.ok([...name].length <= 200, `model name kept at ${[...name].length} code points`);
  }
  for (const [rk, slot] of Object.entries(e.repos)) {
    assert.ok([...rk].length <= 200, `remoteKey kept at ${[...rk].length}`);
    assert.ok([...slot.repo].length <= 200, `repo kept at ${[...slot.repo].length}`);
  }
});

test("a host is trimmed to its share of the store, keeping its all-time total", () => {
  // Days alone were not enough to trim to: a host with many repos, many models
  // and long names has almost no day bytes to give and sat 6.8x over its share
  // forever — which is how it pushed the store past LEDGER_MAX and got an
  // INNOCENT host evicted (QA F2/F3).
  const fresh = require("child_process").spawnSync(process.execPath, ["-e", `
    const os = require("os"), fs = require("fs"), path = require("path");
    process.env.USAGE_LEDGER_FILE = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "turma-share-")), "l.json");
    // Pinned explicitly: this subprocess INHERITS the parent's env, where
    // USAGE_LEDGER_HOSTS is wound down to 3 — so leaving it out silently changes
    // the share this is asserting against.
    process.env.USAGE_LEDGER_MAX = "3000000";
    process.env.USAGE_LEDGER_HOSTS = "32";
    const l = require(${JSON.stringify(path.join(__dirname, "..", "usage-ledger.js"))});
    const b = (n) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 });
    const N = "x".repeat(200);
    const blk = () => ({ totals: b(1000), today: b(0), week: b(0),
      days: { "2026-08-18": b(1000) }, sessions: 1,
      models: Array.from({ length: 64 }, (_, i) => (
        { model: "m" + i + N, totals: b(1), today: b(0), week: b(0) })) });
    l.ingest("fat", { device: "fat", usage: blk(),
      repoUsage: Array.from({ length: 100 }, (_, i) => (
        { repo: "r" + i + N, remoteKey: "rk" + i + N, remote: N, usage: blk() })) });
    const e = l._internals.hosts().fat;
    const total = l._internals.bucketTokens(l._internals.seriesTotals(e.host));
    console.log(JSON.stringify({ size: JSON.stringify(e).length, total, share: l.hostShare() }));
  `], { encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  const out = JSON.parse(fresh.stdout.trim().split("\n").pop());
  // Against the share the child actually computed, not a number copied here that
  // a later change to the derivation would quietly invalidate.
  assert.ok(out.size <= out.share, `host kept at ${out.size} bytes, share is ${out.share}`);
  assert.ok(out.size > 0);
  // The point of trimming rather than evicting: the all-time total is untouched.
  assert.equal(out.total, 1000);
  assert.match(fresh.stderr, /over its .* share/);
});

test("the byte ceiling drops the BIGGEST host, never an innocent bystander", () => {
  // Least-recently-seen is the right victim for the COUNT ceiling and the wrong
  // one for the BYTE ceiling: it destroyed a small innocent host's durable
  // history while the host that caused the overflow stayed (QA F3).
  const fresh = require("child_process").spawnSync(process.execPath, ["-e", `
    const os = require("os"), fs = require("fs"), path = require("path");
    process.env.USAGE_LEDGER_FILE = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "turma-evict-")), "l.json");
    process.env.USAGE_LEDGER_MAX = "200000";
    process.env.USAGE_LEDGER_HOSTS = "2";         // inherited otherwise; see above
    process.env.USAGE_LEDGER_REPOS = "400";       // let one host get genuinely fat
    const l = require(${JSON.stringify(path.join(__dirname, "..", "usage-ledger.js"))});
    const b = (n) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 });
    const blk = () => ({ totals: b(5), today: b(0), week: b(5),
      days: { "2026-08-18": b(5) }, sessions: 1, models: [] });
    const rec = (dev, repos) => ({ device: dev, usage: blk(),
      repoUsage: Array.from({ length: repos }, (_, i) =>
        ({ repo: "r" + i, remoteKey: "rk" + i, remote: "", usage: blk() })) });
    // The innocent one is the OLDEST, i.e. exactly what the old rule dropped.
    l.ingest("innocent", rec("innocent", 1), 1000);
    l.ingest("hog", rec("hog", 400), 9000);
    l._internals.writeNow(() => {
      console.log(JSON.stringify({
        innocent: l.has("innocent"), hog: l.has("hog"),
        bytes: fs.statSync(process.env.USAGE_LEDGER_FILE).size }));
    });
  `], { encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  const out = JSON.parse(fresh.stdout.trim().split("\n").pop());
  assert.equal(out.innocent, true, "the innocent host's history was destroyed");
  assert.ok(out.bytes <= 200000, `file left at ${out.bytes}, over its own ceiling`);
});

test("the save path survives a store that cannot be trimmed under its ceiling", () => {
  // `evictOverflow` runs inside `writeNow`, which runs in a setTimeout — so a
  // throw there is an uncaught exception on the MAIN LOOP and the hub process
  // EXITS, which `restart: unless-stopped` turns into a crash loop taking the
  // fleet's whole control plane. A dead-variable reference sat on the
  // last-host-still-over branch and did exactly that (XERK-338 QA G1). A rarely
  // reached branch that THROWS when reached is worse than no branch.
  const fresh = require("child_process").spawnSync(process.execPath, ["-e", `
    const os = require("os"), fs = require("fs"), path = require("path");
    process.env.USAGE_LEDGER_FILE = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "turma-tiny-")), "l.json");
    // Smaller than a single host can serialize to, so eviction runs out of hosts
    // and the last-host-still-over branch is genuinely REACHED. At 1000 the store
    // fits once one host is dropped and the branch never runs — that fixture
    // passed with the bug reintroduced.
    process.env.USAGE_LEDGER_MAX = "120";
    process.env.USAGE_LEDGER_HOSTS = "2";
    const l = require(${JSON.stringify(path.join(__dirname, "..", "usage-ledger.js"))});
    const b = (n) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 });
    const blk = () => ({ totals: b(5), today: b(0), week: b(5),
      days: { "2026-08-18": b(5) }, sessions: 1, models: [] });
    for (const h of ["h1", "h2"]) l.ingest(h, { device: h, usage: blk(),
      repoUsage: [{ repo: "r", remoteKey: "rk", remote: "", usage: blk() }] });
    l._internals.writeNow(() => console.log("SURVIVED"));
  `], { encoding: "utf8" });
  assert.equal(fresh.status, 0, `the save path threw: ${fresh.stderr}`);
  assert.match(fresh.stdout, /SURVIVED/);
  assert.doesNotMatch(fresh.stderr, /ReferenceError/);
});

test("a repo or model literally named `added` still persists", () => {
  // The per-beat scratch flag was a field on the series, filtered out of
  // `serialize` by a replacer keyed on the name — and a JSON.stringify replacer
  // matches at EVERY depth, so it silently deleted a repo whose remoteKey was
  // `added` (a repo directory of that name produces exactly that key) and a
  // model of that name: present in memory, absent from /data, gone after a
  // restart, with no log line (XERK-338 QA G2).
  ledger.ingest("addedhost", {
    device: "addedhost",
    usage: usage({ [DAY]: 5 }, { models: { added: 1, "claude-opus-5": 4 } }),
    repoUsage: [
      { repo: "added", remoteKey: "added", remote: "", usage: usage({ [DAY]: 5 }) },
      { repo: "normal", remoteKey: "normal", remote: "", usage: usage({ [DAY]: 5 }) },
    ],
  }, now);
  // Through the MODULE's own serializer and off the disk — asserting on a
  // JSON.stringify written HERE would not exercise the replacer at all.
  return new Promise((resolve, reject) => writeNow((err) => {
    try {
      assert.equal(err, null);
      const onDisk = JSON.parse(fs.readFileSync(LEDGER, "utf8")).hosts.addedhost;
      assert.deepEqual(Object.keys(onDisk.repos).sort(), ["added", "normal"]);
      assert.ok("added" in onDisk.host.models, "a model named `added` was dropped");
      // ...and the scratch flag itself is NOT a stored field.
      assert.equal("added" in onDisk.host, false, "per-beat scratch reached the file");
      resolve();
    } catch (e) { reject(e); }
  }));
});

test("XERK-552: flush() writes the store now, so a graceful shutdown loses no deltas", () => {
  reset();
  try { fs.unlinkSync(LEDGER); } catch { /* fresh */ }
  ledger.ingest("h", beat({ [DAY]: 100 }, { r: { [DAY]: 100 } }), now);
  // The 5s debounce has not fired — nothing is on disk yet — but flush must land it.
  return new Promise((resolve, reject) => ledger.flush((err) => {
    try {
      assert.equal(err, null);
      const onDisk = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
      assert.ok(onDisk.hosts.h, "the ingested host is flushed to disk");
      resolve();
    } catch (e) { reject(e); }
  }));
});

test("hostShare leaves room for the JSON envelope", () => {
  // An EXACT even split means a store of hosts each perfectly inside their share
  // still overflows on the wrapper alone (XERK-338 QA F3). Nothing turned red if
  // someone tidied the 0.9 away (QA G5).
  // A MEANINGFUL margin, not just `<`: an exact even split still satisfies `<`
  // on the integer floor alone (8,388,606 < 8,388,608), so that assertion passed
  // with the 0.9 removed.
  const full = ledger.hostShare() * ledger.LEDGER_HOSTS;
  assert.ok(full <= ledger.LEDGER_MAX * 0.95 || ledger.hostShare() === 64 << 10,
    `share x hosts = ${full}, only ${ledger.LEDGER_MAX - full} bytes under ` +
    `LEDGER_MAX ${ledger.LEDGER_MAX} — no room for the JSON envelope`);
});

test("trimming reaches the share by dropping MODELS, before it costs any spend", () => {
  // The ORDER is the fix, not just the fact of trimming. Step 2 (the per-model
  // breakdown, whose totals are kept in full anyway) is what actually brings a
  // repo-heavy host under its share; without it the host falls through to step 3
  // and drops 88 of its 100 REPOS — 88 repos of per-repo spend gone from the
  // breakdown, where the correct code loses none (XERK-338 QA H1). Nothing
  // turned red for removing it.
  const fresh = require("child_process").spawnSync(process.execPath, ["-e", `
    const os = require("os"), fs = require("fs"), path = require("path");
    process.env.USAGE_LEDGER_FILE = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "turma-order-")), "l.json");
    process.env.USAGE_LEDGER_MAX = "3000000";
    process.env.USAGE_LEDGER_HOSTS = "32";
    const l = require(${JSON.stringify(path.join(__dirname, "..", "usage-ledger.js"))});
    const b = (n) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 });
    const N = "x".repeat(200);
    const blk = () => ({ totals: b(1000), today: b(0), week: b(0),
      days: { "2026-08-18": b(1000) }, sessions: 1,
      models: Array.from({ length: 64 }, (_, i) => (
        { model: "m" + i + N, totals: b(1), today: b(0), week: b(0) })) });
    l.ingest("fat", { device: "fat", usage: blk(),
      repoUsage: Array.from({ length: 100 }, (_, i) => (
        { repo: "r" + i + N, remoteKey: "rk" + i + N, remote: N, usage: blk() })) });
    const e = l._internals.hosts().fat;
    console.log(JSON.stringify({
      repos: Object.keys(e.repos).length,
      models: Object.keys(e.host.models).length,
      size: JSON.stringify(e).length, share: l.hostShare() }));
  `], { encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  const out = JSON.parse(fresh.stdout.trim().split("\n").pop());
  assert.ok(out.size <= out.share, `host at ${out.size}, share ${out.share}`);
  // The point: it got there on MODELS, so every repo's spend survived.
  assert.equal(out.repos, 100, `${100 - out.repos} repos of spend were dropped instead`);
  assert.ok(out.models < 64, "the model breakdown was not trimmed at all");
});

test("the share and evict warnings quantify, and are throttled", () => {
  // Both are throttled to 1/hour, so each is the ONLY trace of a host losing
  // detail — a line that does not say how much was lost is barely a trace, and
  // an unthrottled one buries the rest (XERK-338 QA G7/H4).
  const fresh = require("child_process").spawnSync(process.execPath, ["-e", `
    const os = require("os"), fs = require("fs"), path = require("path");
    process.env.USAGE_LEDGER_FILE = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "turma-warn-")), "l.json");
    process.env.USAGE_LEDGER_MAX = "70000";
    process.env.USAGE_LEDGER_HOSTS = "32";
    const l = require(${JSON.stringify(path.join(__dirname, "..", "usage-ledger.js"))});
    const lines = [];
    console.warn = (m) => lines.push(m);
    const b = (n) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 });
    const N = "x".repeat(200);
    const blk = () => ({ totals: b(1000), today: b(0), week: b(0),
      days: { "2026-08-18": b(1000) }, sessions: 1, models: [] });
    // Two hosts, each big enough to trim, so an unthrottled warn shows up twice.
    for (const h of ["fatA", "fatB"]) l.ingest(h, { device: h, usage: blk(),
      repoUsage: Array.from({ length: 100 }, (_, i) => (
        { repo: "r" + i + N, remoteKey: "rk" + i + N, remote: N, usage: blk() })) });
    console.log(JSON.stringify(lines));
  `], { encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  const lines = JSON.parse(fresh.stdout.trim().split("\n").pop());
  const share = lines.filter((l) => /over its .*-byte share/.test(l));
  assert.equal(share.length, 1, `share warning fired ${share.length} times, not once`);
  // ...and it says what it cost, in repos and in tokens.
  assert.match(share[0], /Dropped \d+ of its smallest repo\(s\), taking \d+ tokens/);
});

test("a numbers-only beat does not re-run the share check", () => {
  // enforceHostShare stringifies the whole entry (4.6 ms at 100 repos) and runs
  // on the heartbeat path; a beat that merely raises existing counts grows the
  // entry by digits (XERK-338 QA F9). Its whole effect is that the check does
  // NOT run, so the counter is the only way to see it.
  const before = ledger._internals.shareChecks();
  const b1 = beat({ [DAY]: 10 }, { r: { [DAY]: 10 } }, { device: "steady" });
  ledger.ingest("steady", b1, now);
  const afterFirst = ledger._internals.shareChecks();
  assert.ok(afterFirst > before, "a fresh host must be checked");
  // Same shape, bigger numbers: no new day, repo or model.
  ledger.ingest("steady", beat({ [DAY]: 99 }, { r: { [DAY]: 99 } }, { device: "steady" }), now);
  assert.equal(ledger._internals.shareChecks(), afterFirst,
    "the share check re-ran on a beat that added no structure");
  // ...but a NEW repo does trigger it.
  ledger.ingest("steady", beat({ [DAY]: 99 }, { r: { [DAY]: 99 }, r2: { [DAY]: 5 } },
    { device: "steady" }), now);
  assert.ok(ledger._internals.shareChecks() > afterFirst, "a new repo must be checked");
});

test("a host that has spent nothing never takes a ledger slot", () => {
  ledger.ingest("empty", { device: "empty", usage: null, repoUsage: [] }, now);
  assert.deepEqual(Object.keys(hosts()), []);
});

test("forget is the only thing that drops a host's history", () => {
  ledger.ingest("h", beat({ [DAY]: 100 }), now);
  assert.equal(ledger.has("h"), true);
  assert.equal(ledger.forget("h"), true);
  assert.equal(ledger.has("h"), false);
  assert.equal(ledger.forget("h"), false);
  assert.deepEqual(ledger.retiredAgents([], now), []);
});

// The file write is async (see writeNow); every test that reads the file back
// goes through this rather than racing it.
const saved = () => new Promise((resolve, reject) =>
  writeNow((err) => (err ? reject(err) : resolve())));

test("the least-recently-seen host is evicted past the count ceiling", async () => {
  for (const [i, key] of ["a", "b", "c", "d"].entries()) {
    ledger.ingest(key, beat({ [DAY]: 100 }, null, { device: key }), now + i * 1000);
  }
  // USAGE_LEDGER_HOSTS is 3 in this process; eviction runs on the save path.
  await saved();
  assert.deepEqual(Object.keys(hosts()).sort(), ["b", "c", "d"]);
});

// ---- the file ---------------------------------------------------------------

test("history round-trips through the file", async () => {
  ledger.ingest("h", beat({ "2026-08-17": 1000 }, { r: { "2026-08-17": 1000 } },
    { siteKey: "XERK" }), now);
  await saved();
  reset();
  load();
  const [rec] = ledger.retiredAgents([], now);
  assert.equal(rec.key, "h");
  assert.equal(totalOf(rec.usage), 1000);
  assert.equal(repoTotal(rec.repoUsage, "rk-r"), 1000);
  assert.deepEqual(rec.jira, { siteKey: "XERK" });
});

test("a restored store is raised by a record it has never absorbed", () => {
  // The window after a hub restart: `state.json` saves every 30s while this
  // store's ordinary beats ride a 5-minute snapshot timer, so the registry can
  // hold a NEWER report than the file did — and /api/agents is served before any
  // host re-beats. Rendering the store alone would serve the older numbers, so
  // the fold raises a COPY of it by whatever the record carries.
  ledger.ingest("h", beat({ "2026-08-17": 900 }, { r: { "2026-08-17": 900 } }), now);
  const entry = hosts()["h"];
  reset();
  hosts()["h"] = entry;
  entry.augments = true; // what entryOf() sets on everything it restores
  const newer = beat({ "2026-08-17": 900, [DAY]: 1 }, { r: { "2026-08-17": 900, [DAY]: 1 } });
  const out = ledger.fold("h", newer, now);
  assert.equal(totalOf(out.usage), 901);
  assert.equal(repoTotal(out.repoUsage, "rk-r"), 901);
  // A repo only the record knows about is passed through, not dropped.
  const withNew = beat({ [DAY]: 5 }, { r: { [DAY]: 1 }, brand: { [DAY]: 4 } });
  assert.equal(repoTotal(ledger.fold("h", withNew, now).repoUsage, "rk-brand"), 4);
});

test("a junk or hostile file leaves an empty ledger rather than throwing", () => {
  for (const blob of ['"hello"', "[1,2,3]", "null", "{}", "not json at all",
                      '{"hosts":{"h":{"host":"nope","repos":42}}}',
                      '{"hosts":{"h":{"host":{"pre":{"input":"9"},"days":{"nope":1}}}}}',
                      '{"hosts":{"__proto__":{"host":{"pre":{"input":1}}}}}']) {
    fs.writeFileSync(LEDGER, blob);
    reset();
    assert.doesNotThrow(() => load());
    assert.equal(Object.getPrototypeOf({}).input, undefined, "prototype must be untouched");
    for (const rec of ledger.retiredAgents([], now)) {
      // Whatever survives, every figure is a usable number — a string or a float
      // reaching a Kotlin `Long` fails the decode of the WHOLE /api/agents array.
      assert.ok(Number.isSafeInteger(totalOf(rec.usage)));
    }
  }
});

test("an oversized file is moved aside rather than loaded into a 256 MiB hub", () => {
  const aside = `${LEDGER}.oversized`;
  try { fs.unlinkSync(aside); } catch { /* not there */ }
  fs.writeFileSync(LEDGER, JSON.stringify({ version: 1, hosts: {} }) + " ".repeat(ledger.LEDGER_MAX));
  reset();
  load();
  assert.deepEqual(Object.keys(hosts()), []);
  assert.equal(fs.existsSync(aside), true);
  assert.equal(fs.existsSync(LEDGER), false);
  fs.unlinkSync(aside);
});

test("ingesting never aliases or mutates the record it was handed", () => {
  const record = beat({ [DAY]: 10 }, { r: { [DAY]: 10 } });
  const before = JSON.stringify(record);
  ledger.ingest("h", record, now);
  ledger.fold("h", record, now);
  ledger.retiredAgents([], now);
  assert.equal(JSON.stringify(record), before);
});

// ---- the system-usage fold --------------------------------------------------
//
// Agent-overhead repo series (the manager's own `claude -p` helpers, banked here
// as phantom repos by a `recover-usage-from-archive` run) fold at SERVE time into
// one `Turma-System-Usage` block instead of listing dozens of junk repos on the
// Usage page. Non-destructive: the stored series are untouched, so this runs in
// `repoBlocks`, the choke point both `fold` and `retiredAgents` reach.

const { SYSTEM_USAGE_REPO, isSystemUsageRepo } = ledger;

// A heartbeat whose repos key remoteKey === repo, the shape the recover tool
// bank (no `rk-` origin, since these have no git remote).
function overheadBeat(repos, opts = {}) {
  return {
    device: opts.device || "maxai",
    jira: { siteKey: "XERK" },
    usage: usage({ [DAY]: 100 }),
    repoUsage: Object.entries(repos).map(([repo, d]) => ({
      repo, remoteKey: repo, remote: "", usage: usage(d),
    })),
  };
}
const names = (list) => list.map((r) => r.remoteKey).sort();

test("isSystemUsageRepo matches the manager's overhead, never a real repo", () => {
  // Overhead: the temp-dir repo name, its worktree-shaped slug forms, and any
  // leading-dot name (`scan_repos` skips dot-dirs, so a live agent never reports
  // one — only the recover tool / an orphan cwd slug produces them here).
  for (const v of ["hub-agent-mgr-z2rtwr4", "hub-agent-mgr-00d_zcu0",
                   "-tmp-hub-agent-mgr-abcd1234", "-tmp-claude-0-tmp-hub-agent-mgr-x",
                   ".turma", ".switchboard", ".config"]) {
    assert.equal(isSystemUsageRepo(v, v), true, v);
  }
  // A real repo that merely CONTAINS the substring, and ordinary repos, are not —
  // including one whose name embeds a dot but does not START with one.
  for (const v of ["my-hub-agent-mgr-tool", "hub-agent-manager", "turma", "Turma",
                   "git", "AgentHub", "ArgoCD", "SwitchBoard", "tmp.hMHoC0PYr4",
                   "github.com/x/y"]) {
    assert.equal(isSystemUsageRepo(v, v), false, v);
  }
  // Either field triggers it — the classifier checks remoteKey AND repo.
  assert.equal(isSystemUsageRepo("rk-x", "hub-agent-mgr-x"), true);
  assert.equal(isSystemUsageRepo("hub-agent-mgr-x", "rk-x"), true);
});

test("retired: overhead repos fold into one Turma-System-Usage block", () => {
  reset();
  ledger.ingest("maxai", overheadBeat({
    Turma: { [DAY]: 100 },
    "hub-agent-mgr-aaa": { [DAY]: 5 },
    "hub-agent-mgr-bbb": { [DAY]: 7 },
    ".turma": { [DAY]: 3 },
  }), now);
  const [rec] = ledger.retiredAgents([], now);
  // The three phantom repos are gone; one honest system block replaces them.
  assert.deepEqual(names(rec.repoUsage), ["Turma", SYSTEM_USAGE_REPO]);
  // ADDITIVE across distinct repos (5+7+3), not a high-water max.
  assert.equal(repoTotal(rec.repoUsage, SYSTEM_USAGE_REPO), 15);
  assert.equal(bucketTokens(
    rec.repoUsage.find((r) => r.remoteKey === SYSTEM_USAGE_REPO).usage.days[DAY]), 15);
  // The real repo is untouched.
  assert.equal(repoTotal(rec.repoUsage, "Turma"), 100);
});

test("live-augmented: overhead banked in the store but no longer reported still folds", () => {
  reset();
  // Beat 1 reports a real repo and two overhead ones; beat 2 (the sanitized
  // agent) reports only the real repo — so the store holds overhead the report
  // does not, `augments` is true, and `fold` runs.
  ledger.ingest("h", overheadBeat({
    Turma: { [DAY]: 40 }, "hub-agent-mgr-aaa": { [DAY]: 5 }, "hub-agent-mgr-bbb": { [DAY]: 7 },
  }), now);
  const beat2 = overheadBeat({ Turma: { [DAY]: 40 } });
  ledger.ingest("h", beat2, now);
  const out = ledger.fold("h", beat2, now);
  assert.notEqual(out, null);
  assert.deepEqual(names(out.repoUsage), ["Turma", SYSTEM_USAGE_REPO]);
  assert.equal(repoTotal(out.repoUsage, SYSTEM_USAGE_REPO), 12);
});

test("foldSystemRepos is pure, idempotent, and unchanged-ref when nothing folds", () => {
  const block = (repo, n) => ({ repo, remoteKey: repo, remote: "", usage: usage({ [DAY]: n }) });
  // No overhead → the SAME array reference back (byte-for-byte served payload).
  const clean = [block("Turma", 100), block("git-tool", 5)];
  assert.equal(ledger.foldSystemRepos(clean), clean);
  // Overhead present → a new list, phantoms replaced by one system block.
  const mixed = [block("Turma", 100), block("hub-agent-mgr-a", 5), block(".turma", 3)];
  const folded = ledger.foldSystemRepos(mixed);
  assert.notEqual(folded, mixed);
  assert.deepEqual(folded.map((r) => r.remoteKey).sort(), ["Turma", SYSTEM_USAGE_REPO]);
  assert.equal(totalOf(folded.find((r) => r.remoteKey === SYSTEM_USAGE_REPO).usage), 8);
  // Idempotent: re-folding the folded list makes no second system block.
  const again = ledger.foldSystemRepos(folded);
  assert.equal(again, folded);
  // A non-array is passed through untouched.
  assert.equal(ledger.foldSystemRepos(undefined), undefined);
});

test("a fleet with no overhead is unchanged — no system block, still served raw", () => {
  reset();
  const b = beat({ [DAY]: 100 }, { r: { [DAY]: 100 } });
  ledger.ingest("h", b, now);
  // Nothing beyond the report → null → the record reaches the client as sent.
  assert.equal(ledger.fold("h", b, now), null);
  // And a retired host with only real repos grows no system block.
  reset();
  ledger.ingest("h", beat({ [DAY]: 100 }, { r: { [DAY]: 100 } }), now);
  const [rec] = ledger.retiredAgents([], now);
  assert.deepEqual(names(rec.repoUsage), ["rk-r"]);
});

test.after(() => {
  for (const f of [LEDGER, `${LEDGER}.oversized`]) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
});
