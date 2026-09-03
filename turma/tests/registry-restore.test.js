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
const { mkdtemp } = require("./tmpdirs");
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
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-regrestore-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-regrestore-archive-");
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

test("a non-object record is dropped per-record, not left to crash the whole fleet (XERK-297)", () => {
  // A torn write can leave state.json as valid JSON with a null-ish value beside
  // healthy hosts. Before XERK-297 the null crashed the walk (the trim's sort and
  // serializeAgent both read `.lastSeen` off each record), which either failed the
  // whole restore or — worse — emptied the served payload for the ENTIRE fleet.
  // Now `dropNonObjectRecords` strips such a record BEFORE anything walks it, so
  // the healthy host beside it survives and boot is a clean, successful load.
  const poisoned = tmp("state-poisoned");
  fs.writeFileSync(poisoned, JSON.stringify({
    bad: null, arr: [1], num: 7, good: { device: "good", lastSeen: 1 },
  }));
  // A marker delimits the probe's own JSON from the restore's "loaded N agents"
  // log line, which also lands on stdout.
  const probe = `
    process.env.STATE_FILE = ${JSON.stringify(poisoned)};
    const hub = require(${JSON.stringify(path.join(__dirname, "..", "server.js"))});
    process.stdout.write("<<<" + JSON.stringify({
      keys: Object.keys(hub.agents), bytes: hub.registryBytes(),
    }) + ">>>");
  `;
  const env = { ...process.env, STATE_FILE: poisoned };
  const r = require("child_process").spawnSync(process.execPath, ["-e", probe], {
    env, encoding: "utf8",
  });
  assert.equal(r.status, 0, `the hub must still boot:\n${r.stderr}`);
  const out = JSON.parse(r.stdout.slice(
    r.stdout.indexOf("<<<") + 3, r.stdout.lastIndexOf(">>>")));
  // The one healthy host is what survives — never the raw parse, and never an
  // empty registry that threw away the good record with the bad ones.
  assert.deepEqual(out.keys, ["good"],
    "the healthy host survives; every non-object record is dropped");
  assert.ok(out.bytes > 0, "the surviving host is measured into the registry accounting");
  // A per-record DROP, not a whole-restore skip: the good host loaded, so the
  // catch's `state restore skipped` must NOT have fired.
  assert.ok(!r.stderr.includes("state restore skipped"),
    `a droppable record must not fail the whole restore:\n${r.stderr}`);
  assert.ok(r.stdout.includes("loaded 1 agents"), r.stdout);
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
  const dir = mkdtemp("turma-regrestore-ro-");
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

test("a flagged spend stage survives save + restart + restore (XERK-310 D5)", () => {
  // The runaway-spend alert (XERK-310) remembers, per host, the stage each
  // session has already been alerted at (`alerts.spendSeen`), so a hub restart
  // does not re-announce every expensive session it already flagged. server.js's
  // heartbeatAlerts tests run in-process and never SAVE, so a mutation that keeps
  // the record only in memory (the escaped one: making the stored stage
  // non-enumerable so JSON.stringify drops it) passes them while a real restart
  // re-announces. This boots a hub for BOTH halves — save then restore.
  //
  // SAVE half: an isolated child crosses a stage over a real beat, then writes
  // state.json through serializeAgentsForSave (the SAME replacer the live save
  // uses). RESTORE half: a second child boots over that file and drives the same
  // spend — a re-announce means the stage did not survive the round trip.
  const savePath = tmp("state-spend-save");
  const saveProbe = `
    const fs = require("fs");
    const hub = require(${JSON.stringify(path.join(__dirname, "..", "server.js"))});
    const HIGH = hub.SESSION_SPEND_HIGH_TOKENS;
    // A host record with a running session that has crossed the top stage.
    const rec = { device: "spendbox", lastSeen: Date.now(), alerts: {} };
    hub.agents.spendbox = rec;
    const next = { ...rec, lastSeen: Date.now(), alerts: rec.alerts, sessions: [{
      id: "s1", rcName: "spendbox-repo-s1", status: "running", session: {},
      usage: { totals: { cacheRead: HIGH + 1 } },
    }] };
    hub.heartbeatAlerts("spendbox", rec, next);
    fs.writeFileSync(${JSON.stringify(savePath)}, hub.serializeAgentsForSave());
    // Prove the SAVE actually persisted the stage — the non-enumerable mutation
    // fails right here, before any restore.
    const onDisk = JSON.parse(fs.readFileSync(${JSON.stringify(savePath)}, "utf8"));
    process.stdout.write("<<" + JSON.stringify({
      savedStage: onDisk.spendbox && onDisk.spendbox.alerts && onDisk.spendbox.alerts.spendSeen,
    }) + ">>");
  `;
  const saveRun = require("child_process").spawnSync(process.execPath, ["-e", saveProbe], {
    env: { ...process.env, STATE_FILE: tmp("state-spend-ignored") }, encoding: "utf8",
  });
  assert.equal(saveRun.status, 0, saveRun.stderr);
  const saved = JSON.parse(saveRun.stdout.match(/<<([\s\S]*)>>/)[1]);
  assert.deepEqual(saved.savedStage, { s1: 2 },
    "the crossed stage must be written to state.json, not held only in memory");

  // RESTORE half: boot over the saved file, register a device so notify() fans
  // out, drive the same spend, and count alerts. Zero = the stage was restored.
  const restoreProbe = `
    const hub = require(${JSON.stringify(path.join(__dirname, "..", "server.js"))});
    const push = require(${JSON.stringify(path.join(__dirname, "..", "push.js"))});
    let fired = 0;
    push.sendFcm = (t, { title } = {}) => { if (title != null) fired++; return Promise.resolve({ sent: 0, dead: [] }); };
    hub.registerDevice("d", "android", ["dismiss"]);
    const HIGH = hub.SESSION_SPEND_HIGH_TOKENS;
    const rec = hub.agents.spendbox;
    const next = { ...rec, lastSeen: Date.now(), alerts: rec.alerts, sessions: [{
      id: "s1", rcName: "spendbox-repo-s1", status: "running", session: {},
      usage: { totals: { cacheRead: HIGH + 1 } },
    }] };
    hub.heartbeatAlerts("spendbox", rec, next);
    process.stdout.write("<<" + JSON.stringify({
      restored: !!(rec && rec.alerts && rec.alerts.spendSeen), fired,
    }) + ">>");
  `;
  const restoreRun = require("child_process").spawnSync(process.execPath, ["-e", restoreProbe], {
    env: { ...process.env, STATE_FILE: savePath }, encoding: "utf8",
  });
  assert.equal(restoreRun.status, 0, restoreRun.stderr);
  assert.ok(restoreRun.stdout.includes("loaded 1 agents"), restoreRun.stdout);
  const out = JSON.parse(restoreRun.stdout.match(/<<([\s\S]*)>>/)[1]);
  assert.equal(out.restored, true, "the spendSeen map must survive the restore");
  assert.equal(out.fired, 0,
    "a restarted hub must NOT re-announce a session it already flagged before the restart");
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
      // XERK-455 blocks, usable half.
      codingAgent: { name: "claude", version: "1" },
      claudeAuth: { present: true, needsLogin: false, expiringSoon: false, refreshExpiresAt: 1_786_400_000_000 },
      capacity: { maxSessions: 4, running: 1, queued: 0, free: 3, rootRunning: false },
      github: { available: true, login: "octo", repos: [{ nameWithOwner: "x/y", name: "y", isPrivate: false }] },
      gitSources: [{ source: "azure", label: "AZ", available: true, user: "u", repos: [] }],
      closedSessions: [{ id: "c", root: false, summaryManual: false, prs: [] }],
      uploadMaxBytes: 5_000_000,
      jira: { available: true, configured: true, siteKey: "acme.atlassian.net", tickets: [] },
    },
    junk: {
      key: "junk", device: "junk", lastSeen: Date.now(),
      // XERK-455 blocks, unusable half: a non-object block, a non-array list, a
      // non-object element, and wrong-typed bool/int sub-fields — every one of
      // which is decode-fatal on Android and was served raw before this coercion.
      repos: ["bad", { name: "R", root: "yes", resumable: "no" }],
      codingAgent: "nope",
      claudeAuth: 7,
      capacity: "x",
      github: [],
      gitSources: 5,
      closedSessions: 9,
      uploadMaxBytes: {},
      // A WELL-SHAPED jira with unusable internals, so the ticket/repoGuess/
      // repoOptions leaf coercions run at BOOT (not just the top-level shape).
      jira: { available: "yes",
        tickets: [{ key: "K", labels: [{}, "x"], repoGuess: { cloned: {} } }, "bad"],
        repoOptions: [{ name: "r", cloned: {} }, 5] },
      sessions: [{ id: "s2", usage: { models: "nope" },
        git: "x", ticket: [], work: { aheadOfBase: {}, pushed: "x" },
        prs: [{ url: "u", number: {} }], root: "yes", ttydPort: "80", restartCount: {},
        session: { lastHasToolUse: 5, transcriptAgeSec: {}, questionOptions: "no",
          tail: [{ id: "t", blocks: [{ t: "text", text: "hi", truncated: 5 }, 9] }] } }],
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
      // XERK-455: the blocks whose coercion runs at BOOT from the restore line.
      junkKeys: hub.agents.junk && Object.keys(hub.agents.junk).sort(),
      junkRepos: hub.agents.junk && hub.agents.junk.repos,
      junkGitSources: hub.agents.junk && hub.agents.junk.gitSources,
      junkClosed: hub.agents.junk && hub.agents.junk.closedSessions,
      junkSession: hub.agents.junk && hub.agents.junk.sessions,
      junkJira: hub.agents.junk && hub.agents.junk.jira,
      soloKept: hub.agents.solo && {
        codingAgent: hub.agents.solo.codingAgent, capacity: hub.agents.solo.capacity,
        uploadMaxBytes: hub.agents.solo.uploadMaxBytes,
      },
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

  // XERK-455: a non-object block is DROPPED, a non-array list becomes [], a
  // non-object element is filtered, and wrong-typed sub-fields are gone — all at
  // boot, so a bad value could NOT have emptied the registry from the restore's
  // catch (the TDZ trap the inline helpers avoid).
  for (const k of ["codingAgent", "claudeAuth", "capacity", "github", "uploadMaxBytes"]) {
    assert.equal(out.junkKeys.includes(k), false, `restore left raw ${k}`);
  }
  assert.deepEqual(out.junkRepos, [{ name: "R", resumable: [] }]);
  assert.deepEqual(out.junkGitSources, []);
  assert.deepEqual(out.junkClosed, []);
  // jira internals coerced at boot: bad ticket filtered, labels object dropped,
  // repoGuess/repoOptions cloned dropped, non-bool `available` gone.
  assert.deepEqual(out.junkJira.tickets, [{ key: "K", labels: ["x"], repoGuess: {} }]);
  assert.deepEqual(out.junkJira.repoOptions, [{ name: "r" }]);
  assert.equal("available" in out.junkJira, false);
  // session leaves coerced at boot (the new helpers reached from the restore).
  assert.equal(out.junkSession[0].git, null);
  assert.equal(out.junkSession[0].ticket, null);
  assert.deepEqual(out.junkSession[0].work, {}); // aheadOfBase/pushed dropped
  assert.deepEqual(out.junkSession[0].prs, [{ url: "u" }]); // number dropped
  assert.equal("root" in out.junkSession[0], false);
  assert.equal("ttydPort" in out.junkSession[0], false);
  assert.equal("restartCount" in out.junkSession[0], false);
  const live = out.junkSession[0].session;
  assert.equal("lastHasToolUse" in live, false);
  assert.equal("transcriptAgeSec" in live, false);
  assert.deepEqual(live.questionOptions, []);
  assert.deepEqual(live.tail, [{ id: "t", blocks: [{ t: "text", text: "hi" }] }]);
  // And the usable half survived untouched (both branches of each guard ran).
  assert.deepEqual(out.soloKept.codingAgent, { name: "claude", version: "1" });
  assert.deepEqual(out.soloKept.capacity,
    { maxSessions: 4, running: 1, queued: 0, free: 3, rootRunning: false });
  assert.equal(out.soloKept.uploadMaxBytes, 5_000_000);
});
