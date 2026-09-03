// XERK-310 D7: a MISCONFIGURED spend-threshold pair must never state a
// falsehood in the alert body.
//
// The thresholds are read from the environment at REQUIRE time, so this lives in
// its own file — `node --test` runs each test file in its own process, so the
// deliberately-backwards pair set here does not leak into server.test.js (which
// requires the module with the defaults). Before the fix, `sessionSpendStage`
// COUNTED thresholds rather than matching them and the body named a FIXED WARN/
// HIGH const, so WARN=300M HIGH=200M on a 250M session produced
// "has spent 250M tokens" / "Past 300M" — a body untrue on its face. The fix
// sorts the pair at load and names the threshold actually crossed.

"use strict";

const os = require("os");
const path = require("path");
const { mkdtemp } = require("./tmpdirs");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "hubuser";
process.env.TURMA_PASSWORD = "hubpass";
process.env.TURMA_AGENT_TOKEN = "agenttok";
// The backwards pair: WARN is set ABOVE HIGH. The load-time sort is what makes
// the body honest regardless of how the operator ordered them.
process.env.SESSION_SPEND_WARN_TOKENS = "300000000";
process.env.SESSION_SPEND_HIGH_TOKENS = "200000000";

const tmp = (name) => path.join(os.tmpdir(), `turma-spendcfg-${name}-${process.pid}.json`);
process.env.STATE_FILE = tmp("state");
process.env.DEVICES_FILE = tmp("devices");
process.env.TICKET_AGENTS_FILE = tmp("ticket-agents");
process.env.AUTOSTART_ORGS_FILE = tmp("autostart-orgs");
process.env.TICKET_MODELS_FILE = tmp("ticket-models");
process.env.TICKET_RUNTIMES_FILE = tmp("ticket-runtimes");
process.env.ORG_COLORS_FILE = tmp("org-colors");
process.env.TRIAGE_POLICIES_FILE = tmp("triage-policies");
process.env.TRIAGE_ACTIONS_FILE = tmp("triage-actions");
process.env.USAGE_LEDGER_FILE = tmp("usage-ledger");
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-spendcfg-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-spendcfg-archive-");
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

const push = require("../push.js");
const notifications = [];
push.sendFcm = (tokens, { title, body, data = {} } = {}) => {
  notifications.push({ tokens, title, body, data });
  return Promise.resolve({ sent: tokens.length, dead: [] });
};
const titles = () => notifications.filter((n) => n.title != null).map((n) => n.title);

const hub = require("../server.js");
// notify() no-ops with no registered device, so register one (as server.test.js
// does) or every beat would fire nothing and the assertions would pass vacuously.
hub.registerDevice("capture-device", "android", ["dismiss"]);

// The same one-host beat driver server.test.js uses, inlined (its harness is not
// exported). `alerts` persists across beats so edge-triggering is exercised.
function makeHost() {
  const alerts = {};
  let prev = {};
  return (payload, at = Date.now()) => {
    const next = { ...payload, lastSeen: at, alerts };
    hub.heartbeatAlerts("host1", prev, next);
    prev = next;
    return next;
  };
}

test("the pair is sorted at load, so the stages are ascending whatever the env order", () => {
  assert.deepEqual(hub.SESSION_SPEND_STAGES, [200_000_000, 300_000_000]);
});

test("a session between the two thresholds names the one it crossed, not a higher ceiling", () => {
  const beat = makeHost();
  notifications.length = 0;
  // 250M: past the lower (sorted) 200M stage, not the 300M one.
  beat({ sessions: [{
    id: "s1", rcName: "nas-repo-s1", status: "running", session: {},
    usage: { totals: { cacheRead: 250_000_000 } },
  }] });
  assert.equal(titles().length, 1);
  assert.match(titles()[0], /^nas-repo-s1 has spent 250M tokens$/);
  // The body must name 200M (the crossed threshold), never 300M (above the
  // figure in the title) — the exact falsehood D7 reported.
  assert.match(notifications[0].body, /Past 200M/);
  assert.equal(/300M/.test(notifications[0].body), false,
    `body must not name a ceiling above the title: ${notifications[0].body}`);
  // Only the lower stage is crossed, so this is not the urgent/top stage.
  assert.notEqual(notifications[0].data.priority, "high");
});

test("crossing the higher threshold is the top (urgent) stage", () => {
  const beat = makeHost();
  notifications.length = 0;
  beat({ sessions: [{
    id: "s2", rcName: "nas-repo-s2", status: "running", session: {},
    usage: { totals: { cacheRead: 310_000_000 } },
  }] });
  assert.equal(titles().length, 1);
  assert.equal(notifications[0].data.priority, "high");
  assert.match(notifications[0].body, /Still climbing past 300M/);
});
