// A restored state.json record carrying a `localModel` block must not empty the
// WHOLE registry (the loadState-TDZ class, XERK-301).
//
// normalizeLocalModel / normalizeDsh run from `loadState`'s restore loop, which
// executes far above where a module `const` used to declare the models-list
// bound. A `const` referenced from there is in its temporal dead zone; the
// ReferenceError it threw was swallowed by loadState's `catch { agents = {}; }`,
// so ONE local-model host in state.json dropped EVERY restored host and the hub
// booted empty ("state restore skipped: Cannot access 'LOCAL_MODEL_LIST_MAX'
// before initialization"). The bound is now an inline literal, so the restore
// succeeds. Its own process (and file) because the restore runs once, at require
// time — other suites have already loaded the module with a different file.
// node:test, no npm.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const { mkdtemp } = require("./tmpdirs");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "hubuser";
process.env.TURMA_PASSWORD = "hubpass";
process.env.TURMA_AGENT_TOKEN = "agenttok";

const tmp = (name) => path.join(os.tmpdir(), `turma-tdzrestore-${name}-${process.pid}.json`);
process.env.DEVICES_FILE = tmp("devices");
process.env.TICKET_AGENTS_FILE = tmp("ticket-agents");
process.env.AUTOSTART_ORGS_FILE = tmp("autostart-orgs");
process.env.TICKET_MODELS_FILE = tmp("ticket-models");
process.env.ORG_COLORS_FILE = tmp("org-colors");
process.env.USAGE_LEDGER_FILE = tmp("usage-ledger");
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-tdzrestore-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-tdzrestore-archive-");
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");
process.env.STATE_FILE = tmp("state");

// One host reporting a discovered-local-model list (the record that hit the TDZ),
// plus a plain host beside it, to prove the local-model record no longer poisons
// the whole restore.
fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({
  lm1: {
    device: "lm1",
    lastSeen: Date.now(),
    localModel: {
      available: true,
      model: "qwen2.5-coder",
      contextTokens: 32768,
      models: [
        { id: "qwen2.5-coder", contextTokens: 32768 },
        { id: "deepseek-v3", contextTokens: 65536 },
      ],
      defaultModel: "qwen2.5-coder",
    },
    sessions: [],
  },
  plain2: { device: "plain2", lastSeen: Date.now(), sessions: [] },
}));

const errors = [];
const realError = console.error;
console.error = (m) => { errors.push(String(m)); realError(m); };
const hub = require("../server.js");
console.error = realError;

test("a restored localModel record does not TDZ-empty the whole registry", () => {
  assert.ok(
    !errors.some((m) => /state restore skipped/.test(m)),
    `restore threw: ${errors.filter((m) => /state restore skipped/.test(m)).join("; ")}`
  );
  assert.ok(hub.agents.lm1, "the local-model host itself restored");
  assert.ok(hub.agents.plain2, "a plain host beside it restored (not emptied by the TDZ throw)");
});

test("the restored localModel block is normalized and preserved", () => {
  const lm = hub.agents.lm1 && hub.agents.lm1.localModel;
  assert.ok(lm && lm.available === true, "localModel.available survived the restore normalize");
  assert.ok(Array.isArray(lm.models) && lm.models.length === 2, "the discovered models list survived");
});
