// Unit tests for turma/tools/recover-usage-from-archive.js — the operator tool
// that rebuilds a wiped host's usage history from the archive as ESTIMATED day
// buckets.
//
// The estimate itself is a calibrated ratio and has no right answer to assert;
// what these tests pin is everything around it that can silently credit the
// wrong host, count a turn twice, or lower a measured day — the failures that
// would look like a plausible number rather than an error.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");

const TOOL = path.join(__dirname, "..", "tools", "recover-usage-from-archive.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "turma-recover-"));
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
