// The state.json restore's own ceiling (XERK-272).
//
// `trimRestoredAgents()` holds the RESTORED registry to the same budget as a
// live one, but it cannot protect a restore it never reaches: the restore does
// `readFileSync` + `JSON.parse` on the WHOLE file first, so a state.json left
// behind by a flood killed a 256 MiB hub at module init — before a single log
// line, on every boot, which `restart: unless-stopped` turns into a permanent
// crash loop with nothing to read and no recovery short of deleting the file by
// hand. So the file is measured before it is opened.
//
// Its own process (and its own file) because the restore runs once, at require
// time — registry-cap.test.js has already loaded the module with a good one.
// node:test, no npm.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "hubuser";
process.env.TURMA_PASSWORD = "hubpass";
process.env.TURMA_AGENT_TOKEN = "agenttok";
// Wound right down so an "oversized" file is a few KiB rather than the hundreds
// of MiB it takes to reproduce the real kill.
process.env.STATE_FILE_MAX = "4096";

const tmp = (name) => path.join(os.tmpdir(), `turma-regrestore-${name}-${process.pid}.json`);
process.env.DEVICES_FILE = tmp("devices");
process.env.TICKET_AGENTS_FILE = tmp("ticket-agents");
process.env.AUTOSTART_ORGS_FILE = tmp("autostart-orgs");
process.env.TICKET_MODELS_FILE = tmp("ticket-models");
process.env.ORG_COLORS_FILE = tmp("org-colors");
process.env.MIGRATE_SPOOL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "turma-regrestore-migrations-"));
process.env.ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "turma-regrestore-archive-"));
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

process.env.STATE_FILE = tmp("state");
const ASIDE = `${process.env.STATE_FILE}.oversized`;
try { fs.unlinkSync(ASIDE); } catch { /* first run */ }
// 40 records of ~4 KiB — comfortably over the 4096-byte ceiling above.
fs.writeFileSync(
  process.env.STATE_FILE,
  JSON.stringify(
    Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `flood-${i}`,
        { device: `flood-${i}`, lastSeen: Date.now() - i, sessions: [{ id: `s${i}`, label: "L".repeat(4000) }] },
      ])
    )
  )
);
const WROTE = fs.statSync(process.env.STATE_FILE).size;

const errors = [];
const realError = console.error;
console.error = (m) => { errors.push(String(m)); realError(m); };
const hub = require("../server.js");
console.error = realError;

test("an oversized state.json does not get parsed, and the hub still boots", () => {
  assert.ok(WROTE > Number(process.env.STATE_FILE_MAX));
  // Booting with an empty registry is the documented-harmless outcome (the
  // state file is a best-effort cache); not booting is not.
  assert.deepEqual(Object.keys(hub.agents), []);
  assert.equal(typeof hub.server.listen, "function");
});

test("it says so, and keeps the file rather than deleting it", () => {
  // Silence here is the whole failure mode being fixed: the old behaviour was a
  // crash loop that logged nothing at all.
  assert.ok(errors.some((m) => m.includes("state restore skipped")), errors.join("\n"));
  assert.ok(errors.some((m) => m.includes(String(hub.STATE_FILE_MAX))));
  assert.ok(fs.existsSync(ASIDE), "the oversized file must be preserved for forensics");
  assert.equal(fs.statSync(ASIDE).size, WROTE);
  assert.equal(fs.existsSync(process.env.STATE_FILE), false, "and moved out of the way");
});
