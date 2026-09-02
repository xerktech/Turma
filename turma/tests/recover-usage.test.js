// Unit tests for turma/tools/recover-usage-from-archive.js — the operator tool
// that rebuilds a wiped host's usage history from the archive as ESTIMATED day
// buckets.
//
// The estimate itself is a calibrated ratio and has no right answer to assert;
// what these tests pin is everything around it that can silently credit the
// wrong host, count a turn twice, or lower a measured day — the failures that
// would look like a plausible number rather than an error.

"use strict";

const fs = require("fs");
const path = require("path");
const { mkdtemp } = require("./tmpdirs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");

const TOOL = path.join(__dirname, "..", "tools", "recover-usage-from-archive.js");

function tmp() {
  return mkdtemp("turma-recover-");
}

/** One archived session: rendered projection, `.meta` sidecar, optional raw copy. */
function session(root, repoDir, name, { meta, rendered, raw }) {
  const dir = path.join(root, repoDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, name),
    rendered.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
  fs.writeFileSync(path.join(dir, `${name}.meta`), JSON.stringify(meta));
  if (raw) {
    const rawDir = path.join(dir, `${name}.raw`, meta.transcriptId || "t");
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(
      path.join(rawDir, "t.jsonl"),
      raw.map((e) => JSON.stringify(e)).join("\n") + "\n"
    );
  }
}

const asst = (day, text) => ({ uuid: `${day}-${text.length}`, role: "assistant", ts: `${day}T10:00:00Z`, text });
const turn = (day, id, req, usage) => ({
  timestamp: `${day}T10:00:00Z`,
  requestId: req,
  message: { id, model: "claude-opus-5", usage },
});
const usage = (o) => ({
  input_tokens: 0, output_tokens: o, cache_creation_input_tokens: 0, cache_read_input_tokens: o * 100,
});

function ledgerFile(root, hosts) {
  const p = path.join(root, "usage-ledger.json");
  fs.writeFileSync(p, JSON.stringify({ version: 1, hosts }));
  return p;
}

const blank = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const series = (days) => ({ pre: blank(), days, models: {}, cutoff: null, subagent: null, sessions: 0, lastActivity: null });

function run(args, opts = {}) {
  return execFileSync(process.execPath, [TOOL, ...args], { encoding: "utf8", ...opts });
}

function fixture() {
  const root = tmp();
  const archive = path.join(root, "archive");
  // Calibration session: has BOTH layers, so it sets the tokens-per-character rate.
  session(archive, "turma", "2026-08-20__cal__wiped__aaaa.jsonl", {
    meta: { transcriptId: "aaaa", host: "WIPED", remoteKey: "github.com/x/turma", repo: "Turma" },
    rendered: [asst("2026-08-20", "x".repeat(100))],
    // Same message id and requestId three times, as a multi-block assistant turn
    // is written: one turn's usage, not three.
    raw: [
      turn("2026-08-20", "m1", "r1", usage(10)),
      turn("2026-08-20", "m1", "r1", usage(10)),
      turn("2026-08-20", "m1", "r1", usage(10)),
    ],
  });
  // Pre-wipe, rendered only: this is what gets estimated.
  session(archive, "turma", "2026-07-01__old__wiped__bbbb.jsonl", {
    meta: { transcriptId: "bbbb", host: "WIPED", remoteKey: "github.com/x/turma", repo: "Turma" },
    rendered: [asst("2026-07-01", "y".repeat(200))],
  });
  return { root, archive };
}

test("estimates only the rendered-only days before the cutoff, at the calibrated rate", () => {
  const { root, archive } = fixture();
  const ledger = ledgerFile(root, { WIPED: { device: "WIPED", host: series({}), repos: {} } });
  const out = JSON.parse(
    run(["--host", "wiped", "--ledger-host", "WIPED", "--before", "2026-08-16",
      "--archive", archive, "--ledger", ledger, "--drift", "1"]).split("\n-- dry")[0]
  );
  // 100 rendered chars measured 10 output + 1000 cache-read: 200 chars estimates
  // double that. Three identical raw lines are ONE turn — without the dedupe the
  // rate, and so the estimate, is three times too high.
  assert.equal(out.estimatedTokens, 2020);
  assert.deepEqual(out.days, { count: 1, first: "2026-07-01", last: "2026-07-01" });
  assert.equal(out.sessions.estimated, 1);
  assert.equal(out.sessions.measuredSkipped, 1);
  // A dry run must not touch the ledger.
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(ledger, "utf8")).hosts.WIPED.host.days).length, 0);
});

test("--drift scales the rate down, and is applied to every token key", () => {
  const { root, archive } = fixture();
  const ledger = ledgerFile(root, { WIPED: { device: "WIPED", host: series({}), repos: {} } });
  const args = ["--host", "wiped", "--ledger-host", "WIPED", "--before", "2026-08-16",
    "--archive", archive, "--ledger", ledger];
  const full = JSON.parse(run([...args, "--drift", "1"]).split("\n-- dry")[0]);
  const half = JSON.parse(run([...args, "--drift", "0.5"]).split("\n-- dry")[0]);
  assert.equal(half.estimatedTokens, full.estimatedTokens / 2);
});

test("attributes on the .meta host, not the host segment of the file name", () => {
  const { root, archive } = fixture();
  // A migrated session keeps the name it was first archived under; its owner is
  // the other host, and crediting the name would move that host's spend here.
  session(archive, "turma", "2026-07-02__moved__wiped__cccc.jsonl", {
    meta: { transcriptId: "cccc", host: "OTHER", remoteKey: "github.com/x/turma", repo: "Turma" },
    rendered: [asst("2026-07-02", "z".repeat(400))],
  });
  const ledger = ledgerFile(root, { WIPED: { device: "WIPED", host: series({}), repos: {} } });
  const out = JSON.parse(
    run(["--host", "wiped", "--ledger-host", "WIPED", "--before", "2026-08-16",
      "--archive", archive, "--ledger", ledger, "--drift", "1"]).split("\n-- dry")[0]
  );
  assert.equal(out.days.count, 1);
  assert.equal(out.estimatedTokens, 2020);
});

test("--write raises day buckets without ever lowering a measured one, and backs the file up", () => {
  const { root, archive } = fixture();
  const measured = { input: 0, output: 999999, cacheWrite: 0, cacheRead: 0 };
  const ledger = ledgerFile(root, {
    WIPED: {
      device: "WIPED",
      // A day inside the estimated range that the hub DID measure: the estimate
      // must not pull it down.
      host: series({ "2026-07-01": measured }),
      repos: {},
    },
  });
  run(["--host", "wiped", "--ledger-host", "WIPED", "--before", "2026-08-16",
    "--archive", archive, "--ledger", ledger, "--drift", "1", "--write"]);
  const after = JSON.parse(fs.readFileSync(ledger, "utf8")).hosts.WIPED;
  assert.equal(after.host.days["2026-07-01"].output, 999999); // kept: the max wins
  assert.equal(after.host.days["2026-07-01"].cacheRead, 2000); // raised: it had none
  assert.equal(after.augments, true);
  assert.ok(Object.keys(after.repos).includes("github.com/x/turma"));
  assert.equal(fs.readdirSync(root).filter((f) => f.includes(".pre-recover.")).length, 1);
});

test("folds a bare repo name onto the URL key exactly one repo claims", () => {
  const { root, archive } = fixture();
  // Archived before its origin was readable, so it keyed on the display name.
  session(archive, "turma", "2026-07-03__bare__wiped__dddd.jsonl", {
    meta: { transcriptId: "dddd", host: "WIPED", remoteKey: "", repo: "Turma" },
    rendered: [asst("2026-07-03", "q".repeat(100))],
  });
  const ledger = ledgerFile(root, { WIPED: { device: "WIPED", host: series({}), repos: {} } });
  const out = JSON.parse(
    run(["--host", "wiped", "--ledger-host", "WIPED", "--before", "2026-08-16",
      "--archive", archive, "--ledger", ledger, "--drift", "1"]).split("\n-- dry")[0]
  );
  // `reposOf` keys on `remoteKey || repo`; the archive dir name stands in for a
  // sidecar with no remoteKey at all, and either spelling must fold.
  assert.deepEqual(out.foldedRepoKeys, { turma: "github.com/x/turma" });
  assert.deepEqual(Object.keys(out.byRepo), ["github.com/x/turma"]);
});

test("refuses a host row that is not an object, rather than overwriting it", () => {
  const { root, archive } = fixture();
  const ledger = ledgerFile(root, { WIPED: null });
  assert.throws(
    () => run(["--host", "wiped", "--ledger-host", "WIPED", "--before", "2026-08-16",
      "--archive", archive, "--ledger", ledger, "--write"], { stdio: "pipe" }),
    (e) => /host "WIPED" is not an object/.test(String(e.stderr))
  );
});

test("refuses a host the ledger does not hold, naming the ones it does", () => {
  const { root, archive } = fixture();
  const ledger = ledgerFile(root, { WIPED: { device: "WIPED", host: series({}), repos: {} } });
  assert.throws(
    () => run(["--host", "wiped", "--before", "2026-08-16", "--archive", archive,
      "--ledger", ledger, "--write"], { stdio: "pipe" }),
    (e) => /holds no host "wiped"/.test(String(e.stderr))
  );
});

test("refuses a host with no archived session at all", () => {
  const { root, archive } = fixture();
  const ledger = ledgerFile(root, { WIPED: { device: "WIPED", host: series({}), repos: {} } });
  assert.throws(
    () => run(["--host", "nobody", "--before", "2026-08-16", "--archive", archive,
      "--ledger", ledger], { stdio: "pipe" }),
    (e) => /no archived sessions for host "nobody"/.test(String(e.stderr))
  );
});

test("leaves days at or after the cutoff to the hub's own measured record", () => {
  const { root, archive } = fixture();
  // Rendered-only AND after the cutoff: the hub measured that day itself, so the
  // estimator must not touch it. Without the guard this session is estimated and
  // the max rule can raise a measured bucket with a guess.
  session(archive, "turma", "2026-08-18__after__wiped__eeee.jsonl", {
    meta: { transcriptId: "eeee", host: "WIPED", remoteKey: "github.com/x/turma", repo: "Turma" },
    rendered: [asst("2026-08-18", "w".repeat(5000))],
  });
  const ledger = ledgerFile(root, { WIPED: { device: "WIPED", host: series({}), repos: {} } });
  const out = JSON.parse(
    run(["--host", "wiped", "--ledger-host", "WIPED", "--before", "2026-08-16",
      "--archive", archive, "--ledger", ledger, "--drift", "1"]).split("\n-- dry")[0]
  );
  assert.deepEqual(out.days, { count: 1, first: "2026-07-01", last: "2026-07-01" });
  assert.equal(out.estimatedTokens, 2020);
});

test("says what it WROTE, not what it was offered, when a cutoff skips a day", () => {
  const { root, archive } = fixture();
  const ledger = ledgerFile(root, {
    WIPED: { device: "WIPED", host: { ...series({}), cutoff: "2026-07-05" }, repos: {} },
  });
  const out = run(["--host", "wiped", "--ledger-host", "WIPED", "--before", "2026-08-16",
    "--archive", archive, "--ledger", ledger, "--drift", "1", "--write"]);
  // Every offered day is inside `pre` already, so nothing lands on the host
  // series — a summary that counted the offer would read as 1 day recovered.
  assert.match(out, /host series 0 day\(s\) added, 0 already recorded[^;]*1 skipped as already inside `pre` \(cutoff 2026-07-05\)/);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(ledger, "utf8")).hosts.WIPED.host.days), []);
});

test("counts the repo series' days too, so a repo cutoff cannot read as work landed", () => {
  const { root, archive } = fixture();
  const ledger = ledgerFile(root, {
    WIPED: {
      device: "WIPED",
      host: series({}),
      // `trimDays` sets a cutoff on repo series as well, and the days this tool
      // writes are exactly the old ones a cutoff swallows.
      repos: { "github.com/x/turma": { repo: "Turma", remote: "", series: { ...series({}), cutoff: "2026-12-31" } } },
    },
  });
  const out = run(["--host", "wiped", "--ledger-host", "WIPED", "--before", "2026-08-16",
    "--archive", archive, "--ledger", ledger, "--drift", "1", "--write"]);
  assert.match(out, /repo series 0 new and 1 existing, 0 day\(s\) added, 0 already recorded[^;]*1 skipped as already inside/);
  const after = JSON.parse(fs.readFileSync(ledger, "utf8")).hosts.WIPED;
  assert.deepEqual(Object.keys(after.repos["github.com/x/turma"].series.days), []);
  // With no cutoff of its own the host series still takes the day, so the
  // summary's two halves genuinely differ.
  assert.deepEqual(Object.keys(after.host.days), ["2026-07-01"]);
});

test("dedupes on the (id, requestId) TUPLE, not on the two joined", () => {
  const root = tmp();
  const archive = path.join(root, "archive");
  session(archive, "turma", "2026-08-20__cal__wiped__aaaa.jsonl", {
    meta: { transcriptId: "aaaa", host: "WIPED", remoteKey: "github.com/x/turma", repo: "Turma" },
    rendered: [asst("2026-08-20", "x".repeat(100))],
    raw: [
      // Two DIFFERENT turns that a separator-joined key collapses into one, and
      // a numeric id, which the agent dedupes on and a string-typed one does not.
      turn("2026-08-20", "a|b", "c", usage(10)),
      turn("2026-08-20", "a", "b|c", usage(10)),
      turn("2026-08-20", 7, "r", usage(10)),
      turn("2026-08-20", 7, "r", usage(10)),
    ],
  });
  session(archive, "turma", "2026-07-01__old__wiped__bbbb.jsonl", {
    meta: { transcriptId: "bbbb", host: "WIPED", remoteKey: "github.com/x/turma", repo: "Turma" },
    rendered: [asst("2026-07-01", "y".repeat(100))],
  });
  const ledger = ledgerFile(root, { WIPED: { device: "WIPED", host: series({}), repos: {} } });
  const out = JSON.parse(
    run(["--host", "wiped", "--ledger-host", "WIPED", "--before", "2026-08-16",
      "--archive", archive, "--ledger", ledger, "--drift", "1"]).split("\n-- dry")[0]
  );
  // Three distinct turns at 1010 tokens each over 100 calibration characters,
  // applied to 100 estimated characters.
  assert.equal(out.estimatedTokens, 3030);
});

test("a FIFO inside a raw copy does not wedge the walk either", () => {
  const { root, archive } = fixture();
  // The raw walk is a SECOND path to the same hang, and its guard is separate:
  // the rendered test below cannot reach it.
  const inRaw = path.join(archive, "turma", "2026-08-20__cal__wiped__aaaa.jsonl.raw", "aaaa", "zz.jsonl");
  execFileSync("mkfifo", [inRaw]);
  const ledger = ledgerFile(root, { WIPED: { device: "WIPED", host: series({}), repos: {} } });
  const out = JSON.parse(
    run(["--host", "wiped", "--ledger-host", "WIPED", "--before", "2026-08-16",
      "--archive", archive, "--ledger", ledger, "--drift", "1"], { timeout: 20000 }).split("\n-- dry")[0]
  );
  assert.equal(out.estimatedTokens, 2020);
});

test("a FIFO named like a transcript does not wedge the walk", () => {
  const { root, archive } = fixture();
  const fifo = path.join(archive, "turma", "2026-07-06__fifo__wiped__iiii.jsonl");
  // The case that actually hangs: `readFileSync` on a FIFO with no writer blocks
  // forever, on a tool an operator runs inside the hub container. A DIRECTORY of
  // the same name throws EISDIR instead, so it does not reproduce this.
  execFileSync("mkfifo", [fifo]);
  fs.writeFileSync(`${fifo}.meta`, JSON.stringify({ transcriptId: "iiii", host: "WIPED", remoteKey: "github.com/x/turma", repo: "Turma" }));
  const ledger = ledgerFile(root, { WIPED: { device: "WIPED", host: series({}), repos: {} } });
  const out = JSON.parse(
    run(["--host", "wiped", "--ledger-host", "WIPED", "--before", "2026-08-16",
      "--archive", archive, "--ledger", ledger, "--drift", "1"], { timeout: 20000 }).split("\n-- dry")[0]
  );
  assert.equal(out.estimatedTokens, 2020);
});

test("skips a day a series has already folded into `pre`", () => {
  const { root, archive } = fixture();
  const ledger = ledgerFile(root, {
    WIPED: {
      device: "WIPED",
      // Everything up to 2026-07-05 is inside `pre` already; re-admitting the
      // 07-01 bucket would have the next trim add it to `pre` a SECOND time.
      host: { ...series({}), cutoff: "2026-07-05" },
      repos: {},
    },
  });
  run(["--host", "wiped", "--ledger-host", "WIPED", "--before", "2026-08-16",
    "--archive", archive, "--ledger", ledger, "--drift", "1", "--write"]);
  const after = JSON.parse(fs.readFileSync(ledger, "utf8")).hosts.WIPED;
  assert.deepEqual(Object.keys(after.host.days), []);
  // The repo series is new, so it has no cutoff and does take the day.
  assert.deepEqual(Object.keys(after.repos["github.com/x/turma"].series.days), ["2026-07-01"]);
});

test("a token figure above TOKEN_MAX counts as zero, and cannot destroy a measured day", () => {
  const root = tmp();
  const archive = path.join(root, "archive");
  session(archive, "turma", "2026-08-20__cal__wiped__aaaa.jsonl", {
    meta: { transcriptId: "aaaa", host: "WIPED", remoteKey: "github.com/x/turma", repo: "Turma" },
    rendered: [asst("2026-08-20", "x".repeat(100))],
    raw: [{
      timestamp: "2026-08-20T10:00:00Z",
      requestId: "r1",
      message: { id: "m1", model: "claude-opus-5", usage: {
        // Not a token count. Left unbounded it poisons the rate, the estimate is
        // written as 1e+308, and `usage-ledger.js`'s `num()` — which requires a
        // safe integer — loads the whole bucket back as 0, taking the measured
        // figures beside it with it.
        input_tokens: 1e308, output_tokens: Number.MAX_SAFE_INTEGER + 2,
        cache_creation_input_tokens: -5, cache_read_input_tokens: 700,
      } },
    }],
  });
  session(archive, "turma", "2026-07-01__old__wiped__bbbb.jsonl", {
    meta: { transcriptId: "bbbb", host: "WIPED", remoteKey: "github.com/x/turma", repo: "Turma" },
    rendered: [asst("2026-07-01", "y".repeat(100))],
  });
  const measured = { input: 111, output: 222, cacheWrite: 333, cacheRead: 444 };
  const ledger = ledgerFile(root, {
    WIPED: { device: "WIPED", host: series({ "2026-07-01": measured }), repos: {} },
  });
  run(["--host", "wiped", "--ledger-host", "WIPED", "--before", "2026-08-16",
    "--archive", archive, "--ledger", ledger, "--drift", "1", "--write"]);
  const day = JSON.parse(fs.readFileSync(ledger, "utf8")).hosts.WIPED.host.days["2026-07-01"];
  assert.equal(day.input, 111); // the unusable figures counted 0, so nothing rose
  assert.equal(day.output, 222);
  assert.equal(day.cacheWrite, 333);
  assert.equal(day.cacheRead, 700); // the one real figure did
  for (const v of Object.values(day)) assert.ok(Number.isSafeInteger(v), `${v} is not a safe integer`);
});

test("a repo named after an Object.prototype member neither crashes nor pollutes", () => {
  const { root, archive } = fixture();
  for (const name of ["constructor", "toString"]) {
    session(archive, "turma", `2026-07-04__${name}__wiped__f${name}.jsonl`, {
      meta: { transcriptId: `f${name}`, host: "WIPED", remoteKey: name, repo: name },
      rendered: [asst("2026-07-04", "p".repeat(100))],
    });
  }
  const ledger = ledgerFile(root, { WIPED: { device: "WIPED", host: series({}), repos: {} } });
  run(["--host", "wiped", "--ledger-host", "WIPED", "--before", "2026-08-16",
    "--archive", archive, "--ledger", ledger, "--drift", "1", "--write"]);
  const after = JSON.parse(fs.readFileSync(ledger, "utf8")).hosts.WIPED;
  assert.ok(Object.keys(after.repos).includes("constructor"));
  assert.deepEqual(Object.keys(after.repos.toString.series.days), ["2026-07-04"]);
  assert.equal({}.repo, undefined);
});

test("a raw copy carrying no usage line is estimated, not written off as measured", () => {
  const { root, archive } = fixture();
  session(archive, "turma", "2026-07-05__emptyraw__wiped__gggg.jsonl", {
    meta: { transcriptId: "gggg", host: "WIPED", remoteKey: "github.com/x/turma", repo: "Turma" },
    rendered: [asst("2026-07-05", "e".repeat(100))],
    // Synced, but nothing in it carries a usage block — so the ledger got nothing
    // from it either, and skipping it as "measured" would drop the session.
    raw: [{ type: "mode", mode: "normal" }],
  });
  const ledger = ledgerFile(root, { WIPED: { device: "WIPED", host: series({}), repos: {} } });
  const out = JSON.parse(
    run(["--host", "wiped", "--ledger-host", "WIPED", "--before", "2026-08-16",
      "--archive", archive, "--ledger", ledger, "--drift", "1"]).split("\n-- dry")[0]
  );
  assert.equal(out.sessions.rawWithoutUsage, 1);
  assert.equal(out.sessions.estimated, 2);
  assert.deepEqual(out.days.first, "2026-07-01");
  assert.deepEqual(out.days.last, "2026-07-05");
});

test("refuses a date-shaped non-date and an absurd drift", () => {
  const { root, archive } = fixture();
  const ledger = ledgerFile(root, { WIPED: { device: "WIPED", host: series({}), repos: {} } });
  const base = ["--host", "wiped", "--ledger-host", "WIPED", "--archive", archive, "--ledger", ledger];
  // Lexicographic comparison: a typo'd month puts every measured day back in
  // scope for an estimate.
  assert.throws(
    () => run([...base, "--before", "2026-13-45"], { stdio: "pipe" }),
    (e) => /not a real date/.test(String(e.stderr))
  );
  assert.throws(
    () => run([...base, "--before", "2026-08-16", "--drift", "1e308"], { stdio: "pipe" }),
    (e) => /--drift must be a positive number no greater than/.test(String(e.stderr))
  );
});

test("never opens a non-regular file where a transcript is expected", () => {
  const { root, archive } = fixture();
  // A DIRECTORY named *.jsonl inside a raw copy would read as a transcript; the
  // FIFO of the same shape is what actually wedges a walk forever.
  const rawDir = path.join(archive, "turma", "2026-08-20__cal__wiped__aaaa.jsonl.raw", "aaaa");
  fs.mkdirSync(path.join(rawDir, "nested.jsonl"), { recursive: true });
  fs.mkdirSync(path.join(archive, "turma", "2026-07-09__dir__wiped__hhhh.jsonl"), { recursive: true });
  const ledger = ledgerFile(root, { WIPED: { device: "WIPED", host: series({}), repos: {} } });
  const out = JSON.parse(
    run(["--host", "wiped", "--ledger-host", "WIPED", "--before", "2026-08-16",
      "--archive", archive, "--ledger", ledger, "--drift", "1"]).split("\n-- dry")[0]
  );
  assert.equal(out.estimatedTokens, 2020);
});
