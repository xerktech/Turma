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
// This process ALSO carries the degenerate registry config (a big fleet cap
// against the default byte budget), because the overshoot bound only breaks
// when the DERIVED per-host share falls below what a floor would have imposed —
// at the caps registry-cap.test.js uses it never does. A hub at these numbers
// was OOM-killed at -m 256m before the share stopped being floored.
process.env.AGENTS_MAX = "2000";

const tmp = (name) => path.join(os.tmpdir(), `turma-regrestore-${name}-${process.pid}.json`);
process.env.DEVICES_FILE = tmp("devices");
process.env.TICKET_AGENTS_FILE = tmp("ticket-agents");
process.env.AUTOSTART_ORGS_FILE = tmp("autostart-orgs");
process.env.TICKET_MODELS_FILE = tmp("ticket-models");
process.env.ORG_COLORS_FILE = tmp("org-colors");
// Durable token-usage history (XERK-338), a /data file of its own.
process.env.USAGE_LEDGER_FILE = tmp("usage-ledger");
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
const warns = [];
const realError = console.error;
const realWarn = console.warn;
console.error = (m) => { errors.push(String(m)); realError(m); };
console.warn = (m) => { warns.push(String(m)); realWarn(m); };
const hub = require("../server.js");
console.error = realError;
console.warn = realWarn;

test("a big fleet cap cannot inflate the overshoot bound", () => {
  // The retained worst case is AGENTS_TOTAL_MAX + AGENTS_MAX x AGENT_FAIR_SHARE.
  // A FLOOR under the share makes the second term unbounded in AGENTS_MAX, and
  // raising AGENTS_MAX is exactly what an operator with a growing fleet is told
  // to do: at these numbers the floored share was 65536, i.e. 2000 x 64 KiB =
  // 3.9x the budget, and the hub was OOM-killed at -m 256m. Derived, it is 2x
  // at any AGENTS_MAX.
  assert.equal(hub.AGENTS_MAX, 2000);
  assert.ok(hub.AGENT_FAIR_SHARE < (64 << 10), "the rig must put the share under the old floor");
  assert.ok(
    hub.AGENTS_MAX * hub.AGENT_FAIR_SHARE <= hub.AGENTS_TOTAL_MAX,
    `${hub.AGENTS_MAX} x ${hub.AGENT_FAIR_SHARE} exceeds the ${hub.AGENTS_TOTAL_MAX} budget`
  );
});

test("and the hub says so, because the two numbers now disagree", () => {
  // The bound holds, but the CONFIG is wrong — hosts get refused on record size
  // long before the slots run out. Silence here is how the boot banner ends up
  // printing two numbers whose product contradicts the third.
  assert.ok(
    warns.some((m) => m.includes("AGENTS_MAX=2000") && m.includes("Raise AGENTS_TOTAL_MAX")),
    warns.join("\n")
  );
});

test("an oversized state.json does not get parsed, and the hub still boots", () => {
  assert.ok(WROTE > Number(process.env.STATE_FILE_MAX));
  // Booting with an empty registry is the documented-harmless outcome (the
  // state file is a best-effort cache); not booting is not.
  assert.deepEqual(Object.keys(hub.agents), []);
  assert.equal(typeof hub.server.listen, "function");
});

test("a restore that fails PART WAY through serves nothing, not half a registry", () => {
  // The size ceiling throws BEFORE the parse, so it cannot reach this state.
  // What can: a file small enough to open whose CONTENT breaks the walk —
  // `agents = JSON.parse(...)` installs the whole thing before `normalizeRecord`
  // or `trimRestoredAgents` ever looks at it, so a throw in either used to leave
  // the raw, uncoerced, unbounded parse installed and being served. That is the
  // one state the restore exists to prevent, so it needs its own boot.
  const poisoned = tmp("state-poisoned");
  // Null records: the trim's sort reads `.lastSeen` off each and throws.
  fs.writeFileSync(poisoned, JSON.stringify({ h1: null, h2: null, h3: null }));
  const probe = `
    process.env.STATE_FILE = ${JSON.stringify(poisoned)};
    const hub = require(${JSON.stringify(path.join(__dirname, "..", "server.js"))});
    process.stdout.write(JSON.stringify({
      keys: Object.keys(hub.agents), bytes: hub.registryBytes(),
    }));
  `;
  const env = { ...process.env, STATE_FILE: poisoned };
  const r = require("child_process").spawnSync(process.execPath, ["-e", probe], {
    env, encoding: "utf8",
  });
  assert.equal(r.status, 0, `the hub must still boot:\n${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.keys, [], "a failed restore must leave an EMPTY registry, not the raw parse");
  // And the accounting agrees, so the first beat is measured against an empty
  // registry rather than a phantom one.
  assert.equal(out.bytes, 0);
  assert.ok(r.stderr.includes("state restore skipped"), r.stderr);
});

// ROOT CANNOT RUN THIS ONE, and the reason is the mechanism it tests. The case
// makes the rename fail by chmod'ing the DIRECTORY to 0555 — but root bypasses
// the DAC check, so the rename succeeds, the hub takes the happy path, and the
// assertion fails on a hub that is behaving correctly. Skipped rather than
// reworked because there is no portable way to make `rename` fail for root
// without a real read-only mount, and CI runs as a normal user, where this is
// the case that actually guards the message.
//
// It matters that this is a SKIP and not a deletion: every agent session on the
// TrueNAS host runs as root, so before this the suite failed there on every run
// and the failure had to be recognised and dismissed by hand each time.
const ROOT = typeof process.getuid === "function" && process.getuid() === 0;

test("when it CANNOT move the file, it says that instead of naming one that isn't there", {
  skip: ROOT && "root bypasses the directory permission this case depends on",
}, () => {
  // The message is the operator's only lead. On a read-only /data the rename
  // fails, and pointing them at a `.oversized` that was never created sends
  // them looking for a file the hub did not write — reading as "the hub ate my
  // state".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turma-regrestore-ro-"));
  const locked = path.join(dir, "state.json");
  fs.writeFileSync(locked, JSON.stringify({ h: { device: "h", lastSeen: 1, pad: "x".repeat(8000) } }));
  fs.chmodSync(dir, 0o555); // read-only DIRECTORY: the file is readable, unrenamable
  try {
    const probe = `require(${JSON.stringify(path.join(__dirname, "..", "server.js"))});`;
    const r = require("child_process").spawnSync(process.execPath, ["-e", probe], {
      env: { ...process.env, STATE_FILE: locked }, encoding: "utf8",
    });
    assert.equal(r.status, 0, `the hub must still boot on a read-only volume:\n${r.stderr}`);
    assert.ok(r.stderr.includes("could not move it"), r.stderr);
    assert.equal(r.stderr.includes(".oversized"), false,
      "it must not name a file it failed to create");
    assert.ok(fs.existsSync(locked), "and the original must still be there");
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test("every field the restore coerces is reachable from the restore's own line", () => {
  // The restore loop lives near the top of server.js and reaches each
  // normalize* only because FUNCTION DECLARATIONS hoist. Anything one of them
  // closes over that is a module `const` declared further down is in its TDZ
  // there, and the ReferenceError lands in the restore's catch — which empties
  // the WHOLE registry. Every host that was offline at that moment is then gone
  // from disk 30s later, when the save timer rewrites state.json from the
  // hosts that have re-beaten.
  //
  // XERK-301 shipped exactly that (a `const SUBSCRIPTION_KEY_MAX` above
  // `normalizeSubscription`), so this boots a hub over a record carrying every
  // coerced block at once. It is a BOOT test on purpose: server.test.js walks
  // the loader's body directly and cannot see a TDZ that only exists at
  // require time.
  // TWO records, because a `const` on an error BRANCH is invisible to a fixture
  // that only ever takes the happy one: `solo` carries a usable value for every
  // coerced field (including the optional sub-keys), `junk` an unusable one, so
  // both sides of each normalize* actually run at boot.
  const populated = tmp("state-populated");
  fs.writeFileSync(populated, JSON.stringify({
    solo: {
      key: "solo", device: "solo", lastSeen: Date.now(), repos: [],
      sessions: [{ id: "s1", usage: { models: [{ model: "m", totals: {} }] } }],
      usage: {
        totals: { input: 5 }, days: { "2026-08-01": { input: 5 } },
        lastActivity: "2026-08-01T00:00:00Z",
        models: [{ model: "m", totals: {} }],
      },
      repoUsage: [{ repo: "Turma", usage: { totals: { input: 5 } } }],
      limits: { fiveHour: { usedPct: 12 }, sevenDay: { usedPct: 30, resetsAt: 1_786_950_000 },
                capturedAt: 1_786_400_000, source: "statusline" },
      subscription: { key: "abc123", source: "login" },
      localModel: { available: true, model: "qwen", contextTokens: 128000 },
      models: { available: ["opus", "sonnet"], defaultLabel: "Opus 5", at: "2026-08-01" },
    },
    junk: {
      key: "junk", device: "junk", lastSeen: Date.now(), repos: [],
      sessions: [{ id: "s2", usage: { models: "nope" } }],
      // Every branch of the token-figure walk (XERK-306), including the one
      // that LOGS: its throttle state is a module binding too, so a record that
      // only ever coerces silently would not prove it is reachable.
      usage: {
        totals: { input: 1.5 }, days: { "2026-08-01": "nope" }, lastActivity: 5,
        models: [{ model: 7 }],
      },
      repoUsage: [null, { repo: 5, usage: 3 }],
      limits: { fiveHour: { usedPct: "lots" }, capturedAt: "soon" },
      subscription: { key: 7, source: 9 },
      localModel: { available: "yes", contextTokens: "many" },
      models: { available: "nope", defaultLabel: 5, at: [] },
      // Over the 120-char wire cap, so `normalizeClones`' bound is REACHED at
      // boot — it was a module const below the restore line, i.e. a second
      // live instance of the same TDZ, and no fixture exercised the branch.
      clones: [{ repo: "Turma", progress: "z".repeat(300) }],
    },
  }));
  // A successful restore logs its own "loaded N agents" line to stdout, so the
  // probe's answer is fenced rather than being the whole stream.
  const probe = `
    const hub = require(${JSON.stringify(path.join(__dirname, "..", "server.js"))});
    process.stdout.write("<<" + JSON.stringify({
      keys: Object.keys(hub.agents).sort(),
      sub: hub.agents.solo && hub.agents.solo.subscription,
      junkSub: hub.agents.junk && hub.agents.junk.subscription,
      junkLimits: hub.agents.junk && hub.agents.junk.limits,
      junkUsage: hub.agents.junk && hub.agents.junk.usage,
      junkRepoUsage: hub.agents.junk && hub.agents.junk.repoUsage,
    }) + ">>");
  `;
  const r = require("child_process").spawnSync(process.execPath, ["-e", probe], {
    env: { ...process.env, STATE_FILE: populated }, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.includes("state restore skipped"), false,
    `the restore must survive a fully-populated record:\n${r.stderr}`);
  const out = JSON.parse(r.stdout.match(/<<([\s\S]*)>>/)[1]);
  assert.deepEqual(out.keys, ["junk", "solo"]);
  assert.deepEqual(out.sub, { key: "abc123", source: "login" });
  // And the unusable half really did go through the coercions' other branch.
  assert.equal(out.junkSub, null);
  assert.equal(out.junkLimits, null);
  // The float zeroed, the unusable day and the non-string lastActivity gone,
  // the nameless model dropped — and `days` kept as the empty map it became.
  assert.deepEqual(out.junkUsage, { totals: { input: 0 }, days: {}, models: [] });
  assert.deepEqual(out.junkRepoUsage, [{}]);
});
