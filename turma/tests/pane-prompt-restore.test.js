// A served permission dialog's id (XERK-1831) survives the boot-time state.json
// restore. coerceLiveSignals runs inside that restore, at module init, BEFORE
// server.js defines PANE_DIALOG_ID_RE — so the id check there must be an inline
// literal. Referencing the const throws a TDZ ReferenceError, the restore is
// skipped, and the hub boots with an EMPTY fleet; nothing else in the suite
// restores a dialog, so only this file can catch it. Its own process because the
// restore runs once, at require time.
// node:test, no npm.

"use strict";

const fs = require("fs");
const path = require("path");
const { mkdtemp, scratchDir } = require("./tmpdirs");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "hubuser";
process.env.TURMA_PASSWORD = "hubpass";
process.env.TURMA_AGENT_TOKEN = "agenttok";
const tmp = (name) => path.join(scratchDir(), `turma-panerestore-${name}-${process.pid}.json`);
process.env.DEVICES_FILE = tmp("devices");
process.env.TICKET_AGENTS_FILE = tmp("ticket-agents");
process.env.AGENT_IDENTITIES_FILE = tmp("agent-identities");
process.env.AUTOSTART_ORGS_FILE = tmp("autostart-orgs");
process.env.TICKET_MODELS_FILE = tmp("ticket-models");
process.env.ORG_COLORS_FILE = tmp("org-colors");
process.env.USAGE_LEDGER_FILE = tmp("usage-ledger");
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-panerestore-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-panerestore-archive-");
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");
process.env.STATE_FILE = tmp("state");

const GOOD = "0123456789abcdef0123456789abcdef";
const dialog = (id) => ({ prompt: "Do you want to proceed?", detail: "Bash command\n  ls",
  options: [{ number: 1, label: "Yes", selected: true }], id });
fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({
  nas01: { device: "nas01", lastSeen: Date.now(), sessions: [
    { id: "s1", status: "running", session: { panePrompt: dialog(GOOD) } },
    { id: "s2", status: "running", session: { panePrompt: dialog("ABCDEF0123456789ABCDEF0123456789") } },
  ] },
}));

const hub = require("../server");

test("a restored dialog keeps a well-formed id and drops a forged one", () => {
  const sessions = hub.agents.nas01 && hub.agents.nas01.sessions;
  assert.ok(Array.isArray(sessions), "the restore was skipped — the fleet came back empty");
  assert.equal(sessions[0].session.panePrompt.id, GOOD);
  assert.equal("id" in sessions[1].session.panePrompt, false, "an uppercase id is not the agent's digest");
});
