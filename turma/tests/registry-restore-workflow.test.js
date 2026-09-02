// XERK-304. A hub restart must survive a state.json that carries a workflow
// picker's cached agent list — i.e. any state file written after someone opened
// a Workflow row.
//
// Its own process, and its own state file, for the same reason
// registry-restore.test.js has one: the restore runs ONCE, at require time.
//
// This exists because a unit test cannot see the bug it is named for. The
// restore calls `normalizeRecord` near the top of server.js, ~1000 lines above
// where `sanitizeWorkflowAgents`' constants were first declared, so at restore
// time they sat in the temporal dead zone. The ReferenceError landed in the
// restore's own catch — which swallows everything and sets `agents = {}` — and
// the hub booted with ZERO hosts on the first restart after any picker had been
// opened. Calling `normalizeRecord()` from a test cannot reproduce that: by then
// the module is fully evaluated and no TDZ exists. Only booting can.
//
// So this asserts on what a BOOT produces, never on the coercion in isolation.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const { mkdtemp } = require("./tmpdirs");
const test = require("node:test");
const assert = require("node:assert/strict");

// The cache key `subagentKey` builds is NUL-separated (neither field can
// contain one). Written as an escape rather than a literal byte, so this file
// stays text to git and to every diff that has to review it.
const NUL = "\u0000";

process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "hubuser";
process.env.TURMA_PASSWORD = "hubpass";
process.env.TURMA_AGENT_TOKEN = "agenttok";

const tmp = (name) => path.join(os.tmpdir(), `turma-wfrestore-${name}-${process.pid}.json`);
process.env.DEVICES_FILE = tmp("devices");
process.env.TICKET_AGENTS_FILE = tmp("ticket-agents");
process.env.AUTOSTART_ORGS_FILE = tmp("autostart-orgs");
process.env.TICKET_MODELS_FILE = tmp("ticket-models");
process.env.ORG_COLORS_FILE = tmp("org-colors");
// Durable token-usage history (XERK-338), a /data file of its own.
process.env.USAGE_LEDGER_FILE = tmp("usage-ledger");
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-wfrestore-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-wfrestore-archive-");
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");
process.env.STATE_FILE = tmp("state");

// An ordinary host, exactly as one looks once a workflow picker has been opened:
// a subagentHistory entry whose value carries a run's agent list. Nothing
// hostile — this is the benign, expected shape, which is what made it serious.
const RUN_KEY = ["s1", "workflow", "code-review", ""].join(NUL);
const PLAIN_KEY = ["s1", "Explore", "Map the code", ""].join(NUL);
fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({
  "boot-host": {
    device: "boot-host",
    lastSeen: Date.now(),
    sessions: [{ id: "s1", status: "running" }],
    subagentHistory: {
      [RUN_KEY]: {
        entries: [],
        agents: [
          {
            id: "ac1e9a79ae2f94528",
            label: "essay:alpha",
            startedAt: "2026-08-18T05:37:35Z",
            status: "done",
          },
        ],
        agentsTruncated: false,
        fetchedAt: Date.now(),
      },
      // A plain transcript entry alongside it, which must come through untouched.
      [PLAIN_KEY]: {
        entries: [{ id: "e1", role: "assistant", text: "found it" }],
        fetchedAt: Date.now(),
      },
    },
  },
}));

const errors = [];
const realError = console.error;
console.error = (m) => { errors.push(String(m)); realError(m); };
const hub = require("../server.js");
console.error = realError;

test("a workflow picker in state.json does not cost the hub its whole registry", () => {
  assert.ok(!errors.some((m) => m.includes("state restore skipped")),
    `the restore threw: ${errors.join("\n")}`);
  assert.deepEqual(Object.keys(hub.agents), ["boot-host"],
    "the restore must survive a cached workflow agent list");
});

test("and that boot coerced the cached rows rather than leaving them raw", () => {
  const cache = hub.agents["boot-host"].subagentHistory;
  assert.deepEqual(cache[RUN_KEY].agents, [
    {
      id: "ac1e9a79ae2f94528",
      label: "essay:alpha",
      startedAt: "2026-08-18T05:37:35Z",
      status: "done",
    },
  ]);
  // A plain transcript entry must not grow workflow keys on the way through.
  assert.ok(!("agents" in cache[PLAIN_KEY]));
  assert.ok(!("agentsTruncated" in cache[PLAIN_KEY]));
});
