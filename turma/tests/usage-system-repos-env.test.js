// USAGE_SYSTEM_REPOS is read at REQUIRE time, so this lives in its own file —
// `node --test` runs each test file in its own process, so the env set here does
// not leak into usage-ledger.test.js (which requires the module with no such
// list). It exercises the operator-configured half of the system-usage fold: a
// host-specific junk name the recover tool slugified from an orphan cwd, folded
// into Turma-System-Usage once the operator has confirmed from the archive that
// it is not real repo work ("reattribute the real ones, fold the rest").
"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const LEDGER = path.join(os.tmpdir(), `turma-usage-sysrepos-${process.pid}.json`);
process.env.USAGE_LEDGER_FILE = LEDGER;
process.env.USAGE_SYSTEM_REPOS = "git, mhabeeb ,, workspace";
try { fs.unlinkSync(LEDGER); } catch { /* first run */ }

const ledger = require("../usage-ledger.js");
const { reset, bucketTokens } = ledger._internals;
const { SYSTEM_USAGE_REPO, isSystemUsageRepo } = ledger;

const DAY = "2026-08-18";
const now = Date.parse(`${DAY}T12:00:00Z`);
const bucket = (n) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 });
function usage(n) {
  return {
    totals: bucket(n), today: bucket(n), week: bucket(n),
    days: { [DAY]: bucket(n) }, sessions: 1, lastActivity: `${DAY}T11:00:00Z`,
    models: [{ model: "m", totals: bucket(n), today: bucket(0), week: bucket(0) }],
  };
}

test("USAGE_SYSTEM_REPOS folds operator-listed junk, whitespace/blanks ignored", () => {
  for (const v of ["git", "mhabeeb", "workspace"]) {
    assert.equal(isSystemUsageRepo(v, v), true, v);
  }
  // A name not on the list — and an empty CSV cell — must not fold.
  assert.equal(isSystemUsageRepo("Turma", "Turma"), false);
  assert.equal(isSystemUsageRepo("", ""), false);
});

test("the configured junk merges into the same block as the structural set", () => {
  reset();
  ledger.ingest("maxai", {
    device: "maxai", jira: { siteKey: "XERK" }, usage: usage(100),
    repoUsage: [
      { repo: "Turma", remoteKey: "Turma", remote: "", usage: usage(100) },
      { repo: "git", remoteKey: "git", remote: "", usage: usage(4) },
      { repo: "hub-agent-mgr-aaa", remoteKey: "hub-agent-mgr-aaa", remote: "", usage: usage(6) },
    ],
  }, now);
  const [rec] = ledger.retiredAgents([], now);
  const keys = rec.repoUsage.map((r) => r.remoteKey).sort();
  assert.deepEqual(keys, ["Turma", SYSTEM_USAGE_REPO]);
  const sys = rec.repoUsage.find((r) => r.remoteKey === SYSTEM_USAGE_REPO);
  assert.equal(bucketTokens(sys.usage.totals), 10); // git(4) + hub-agent-mgr(6)
});

test.after(() => { try { fs.unlinkSync(LEDGER); } catch { /* gone */ } });
