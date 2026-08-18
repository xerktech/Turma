// Unit tests for the agent registry's own ceiling (XERK-272).
//
// Nothing capped how many DISTINCT `device` names the registry could retain:
// 512 beats of 0.9 MiB under 512 names OOM-killed a 256 MiB hub, while the same
// 512 beats under ONE name peaked at 169 MiB. `AGENT_RECORD_MAX` bounds one
// record and `prune()` only reclaims at seven days, so neither is the aggregate.
// XERK-268 binds `device` to the credential, which changes WHO can do this
// (a compromised or buggy host, or the `legacy` master) but bounds nothing.
//
// This gets its OWN process because the caps are process-wide constants read at
// require time, and the numbers that make the behavior testable are nothing
// like the fleet's. server.test.js lifts `AGENTS_MAX` for the opposite reason:
// it invents ~100 synthetic hosts and is not a fleet either. The DEGENERATE
// config (a fleet cap far past the byte budget) lives in registry-restore.
// node:test, no npm.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");

// Environment must be pinned BEFORE the module under test loads.
process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "hubuser";
process.env.TURMA_PASSWORD = "hubpass";
process.env.TURMA_AGENT_TOKEN = "agenttok";
process.env.AGENTS_MAX = "4";
// Chosen so the derived per-host share (total / max = 160 KiB) sits clear of the
// record sizes below — the whole point of the share is that a small host and a
// fat one land on opposite sides of it.
process.env.AGENTS_TOTAL_MAX = String(640 << 10);
process.env.AGENT_EVICT_IDLE_MS = String(60 * 1000);

const tmp = (name) => path.join(os.tmpdir(), `turma-regcap-${name}-${process.pid}.json`);
process.env.DEVICES_FILE = tmp("devices");
process.env.TICKET_AGENTS_FILE = tmp("ticket-agents");
process.env.AUTOSTART_ORGS_FILE = tmp("autostart-orgs");
process.env.TICKET_MODELS_FILE = tmp("ticket-models");
process.env.ORG_COLORS_FILE = tmp("org-colors");
// Durable token-usage history (XERK-338), a /data file of its own.
process.env.USAGE_LEDGER_FILE = tmp("usage-ledger");
process.env.MIGRATE_SPOOL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "turma-regcap-migrations-"));
process.env.ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "turma-regcap-archive-"));
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

// A state.json holding SIX hosts against a cap of four — the shape a hub that
// was flooded before it restarted has on disk. Written before the require so
// the restore path sees it.
process.env.STATE_FILE = tmp("state");
const RESTORE_NOW = Date.now();
const restoredSeen = {
  "keep-newest": RESTORE_NOW - 1000,
  "keep-2": RESTORE_NOW - 2000,
  "keep-3": RESTORE_NOW - 3000,
  "keep-4": RESTORE_NOW - 4000,
  "drop-stale": RESTORE_NOW - 5000,
  "drop-stalest": RESTORE_NOW - 6000,
};
fs.writeFileSync(
  process.env.STATE_FILE,
  JSON.stringify(
    Object.fromEntries(
      Object.entries(restoredSeen).map(([key, lastSeen]) => [
        key, { device: key, lastSeen, repos: [{ name: "r1" }], sessions: [] },
      ])
    )
  )
);

const hub = require("../server.js");
const {
  server, agents, recordBytes,
  AGENTS_MAX, AGENTS_TOTAL_MAX, AGENT_EVICT_IDLE_MS, AGENT_FAIR_SHARE, STATE_FILE_MAX,
  registryBytes, makeRegistryRoom, agentRecordSize, positiveEnv, logName,
  containerMemoryLimit, defaultRegistryBudget,
} = hub;

// What the restore left behind, snapshotted before any test mutates the
// registry (the trim runs at require time, once).
const restoredKeys = Object.keys(agents).slice().sort();

// ---- the restore trim -------------------------------------------------------

test("restore: a state.json over the cap loads only the most recently seen", () => {
  // A bound the LOADING path doesn't enforce is not a bound — restoring the
  // whole flood is an OOM before the first request is served.
  assert.equal(restoredKeys.length, AGENTS_MAX);
  assert.deepEqual(restoredKeys, ["keep-2", "keep-3", "keep-4", "keep-newest"]);
});

test("restore: the trim seeds the byte accounting for what it kept", () => {
  // Not cosmetic: the aggregate check on the first beat after a restart reads
  // these, and a registry that measures as 0 admits a flood.
  for (const key of restoredKeys) {
    assert.equal(typeof recordBytes.get(key), "number", `${key} unmeasured`);
    assert.ok(recordBytes.get(key) > 0);
  }
});

// ---- HTTP ------------------------------------------------------------------

let baseUrl;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function request(method, pathName, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + pathName, { method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const agentHeaders = { authorization: "Bearer agenttok", "content-type": "application/json" };
const beat = (body) => request("POST", "/api/heartbeat", { body, headers: agentHeaders });

// Each test starts from an empty registry: the caps are small enough that one
// test's hosts would otherwise be the next one's flood.
function resetRegistry() {
  for (const key of Object.keys(agents)) delete agents[key];
  recordBytes.clear();
}

// A record big enough to matter against the 64 KiB aggregate but far under the
// 8 MiB per-record ceiling, so what refuses it is unambiguously the aggregate.
const chunky = (device, kib) => ({
  device,
  sessions: [{ id: "s1", status: "running", label: "L".repeat(kib << 10) }],
});

test("http: past the cap, a NEW device is refused rather than admitted", async () => {
  resetRegistry();
  for (let i = 0; i < AGENTS_MAX; i++) {
    assert.equal((await beat({ device: `full-${i}` })).status, 200);
  }
  const refused = await beat({ device: "one-too-many" });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, "agent registry full");
  assert.equal(refused.body.limit, AGENTS_MAX);
  // Refused means REFUSED: no record, no slot taken, nothing to serve.
  assert.equal("one-too-many" in agents, false);
  assert.equal(Object.keys(agents).length, AGENTS_MAX);
});

test("http: a host already in the registry keeps beating at the cap", async () => {
  resetRegistry();
  for (let i = 0; i < AGENTS_MAX; i++) await beat({ device: `full-${i}` });
  // The cap is admission control on NEW names. Turning it into a wall for the
  // fleet's own hosts would make every one of them go offline at once — the
  // exact outage the ticket is about, arrived at from the other side.
  const again = await beat({ device: "full-0", repos: [{ name: "r2" }] });
  assert.equal(again.status, 200);
  assert.deepEqual(agents["full-0"].repos, [{ name: "r2" }]);
});

test("http: a live host is never evicted to seat a newcomer", async () => {
  resetRegistry();
  for (let i = 0; i < AGENTS_MAX; i++) await beat({ device: `live-${i}` });
  // All four were seen just now, so none is reclaimable however old the newcomer
  // makes the registry look.
  assert.equal((await beat({ device: "newcomer" })).status, 429);
  for (let i = 0; i < AGENTS_MAX; i++) {
    assert.ok(agents[`live-${i}`], `live-${i} was evicted for a newcomer`);
  }
});

test("http: a newcomer reclaims the LONG-idle slot, oldest first", async () => {
  resetRegistry();
  for (let i = 0; i < AGENTS_MAX; i++) await beat({ device: `mix-${i}` });
  // Two hosts gone long past the idle window; the rest were seen a moment ago.
  agents["mix-0"].lastSeen = Date.now() - AGENT_EVICT_IDLE_MS * 3;
  agents["mix-1"].lastSeen = Date.now() - AGENT_EVICT_IDLE_MS * 2;

  assert.equal((await beat({ device: "newcomer" })).status, 200);
  assert.ok(agents["newcomer"]);
  // Least-recently-seen goes first, and ONLY as many as the newcomer needs —
  // a record holds an offline host's last known sessions, PR chips and usage,
  // so eviction is not free and is never done in bulk.
  assert.equal("mix-0" in agents, false, "the stalest slot should have been taken");
  assert.ok(agents["mix-1"], "only one slot was needed");
  assert.ok(agents["mix-2"] && agents["mix-3"]);
  assert.equal(recordBytes.has("mix-0"), false, "an evicted host's bytes must be released");
});

test("http: a host just short of the idle window is NOT evictable", async () => {
  resetRegistry();
  for (let i = 0; i < AGENTS_MAX; i++) await beat({ device: `grace-${i}` });
  // Offline (well past OFFLINE_AFTER_MS) but not yet idle enough to reclaim:
  // a host rebooting or updating must not lose its record to a newcomer.
  agents["grace-0"].lastSeen = Date.now() - (AGENT_EVICT_IDLE_MS - 5000);
  assert.equal((await beat({ device: "newcomer" })).status, 429);
  assert.ok(agents["grace-0"]);
});

// ---- the aggregate byte budget ---------------------------------------------

test("http: records that fit the per-record ceiling still can't sum past the aggregate", async () => {
  resetRegistry();
  // AGENTS_MAX records at AGENT_RECORD_MAX is 512 MiB on a 256 MiB hub, so the
  // per-record ceiling was never the bound. All three pass it easily.
  assert.ok(300 << 10 > AGENT_FAIR_SHARE, "the rig's fat record must be over-share");
  assert.equal((await beat(chunky("fat-a", 300))).status, 200);
  assert.equal((await beat(chunky("fat-b", 300))).status, 200);
  const refused = await beat(chunky("fat-c", 300));
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, "agent registry full");
  assert.equal(refused.body.bytes, AGENTS_TOTAL_MAX);
  assert.equal(refused.body.share, AGENT_FAIR_SHARE);
  assert.equal("fat-c" in agents, false);
});

test("http: a host INSIDE its share is not refused for someone else's bulk", async () => {
  // The regression this exists for: the aggregate gate refuses whoever beats
  // next, and rolling a known host back to its previous record rolls back
  // `lastSeen` too — so a live, normal-sized host was refused every beat, aged
  // past OFFLINE_AFTER_MS, and read as offline while it was up, with nothing to
  // tell that apart from a network failure.
  resetRegistry();
  assert.equal((await beat({ device: "small", repos: [{ name: "r1" }] })).status, 200);
  assert.equal((await beat(chunky("hog-a", 300))).status, 200);
  assert.equal((await beat(chunky("hog-b", 300))).status, 200);
  assert.ok(registryBytes() > AGENTS_TOTAL_MAX - (300 << 10), "the rig must be under pressure");

  const before = agents["small"].lastSeen;
  await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 3; i++) {
    const ok = await beat({ device: "small", repos: [{ name: `r${i}` }] });
    assert.equal(ok.status, 200, "a host inside its share must keep beating");
  }
  assert.deepEqual(agents["small"].repos, [{ name: "r2" }], "its content must be current");
  assert.ok(agents["small"].lastSeen > before, "and its liveness must advance");
  // The exemption is bounded, not a hole: every exempt host is under its share,
  // so they sum to at most the budget again.
  assert.ok(registryBytes() <= AGENTS_TOTAL_MAX + AGENTS_MAX * AGENT_FAIR_SHARE);
});

test("http: the share exemption's overshoot is bounded at 2x the budget", async () => {
  // The exemption admits an at-or-under-share host REGARDLESS of the budget, so
  // the aggregate is a soft total. Drive the worst case and hold the bound:
  //   * a fat beat is accepted only while the whole registry fits, so the fat
  //     records sum to at most the budget;
  //   * every exempt host is inside its share and there are at most AGENTS_MAX
  //     of them, so they sum to at most AGENTS_MAX x share = the budget again.
  // Hence 2x, and never the container.
  resetRegistry();
  // Only a GROWING host can overshoot. A new device is admitted only while the
  // registry is inside the budget (`makeRegistryRoom(0, 1)`), so the flood path
  // cannot reach past it — the exemption is reachable only by hosts that were
  // already seated. Seat the worst case first: one host holding most of the
  // budget, and the rest of the slots.
  assert.equal((await beat(chunky("fat-1", 560))).status, 200);
  for (let i = 0; i < AGENTS_MAX - 1; i++) {
    assert.equal((await beat({ device: `snug-${i}` })).status, 200);
  }
  assert.equal(Object.keys(agents).length, AGENTS_MAX);
  // A further fat beat is capped by the budget, which is what bounds the fat
  // half at one budget's worth.
  assert.equal((await beat(chunky("fat-1", 900))).status, 429);

  // Now grow every seated host to just inside its share. Each is exempt, so all
  // of them land — this is the overshoot, and it is the whole of it.
  const snugKiB = Math.floor((AGENT_FAIR_SHARE - 4096) / 1024);
  for (let i = 0; i < AGENTS_MAX - 1; i++) {
    assert.equal((await beat(chunky(`snug-${i}`, snugKiB))).status, 200, `snug-${i}`);
  }
  assert.ok(registryBytes() > AGENTS_TOTAL_MAX, "the rig must actually be overshooting");
  assert.ok(
    registryBytes() <= 2 * AGENTS_TOTAL_MAX,
    `overshoot ${registryBytes()} exceeded 2x the ${AGENTS_TOTAL_MAX} budget`
  );
  // And no new host can be seated while it overshoots, so it cannot compound.
  assert.equal((await beat({ device: "latecomer" })).status, 429);
});

test("http: an over-share refusal leaves the host's PREVIOUS record intact", async () => {
  resetRegistry();
  assert.equal((await beat({ device: "grower", repos: [{ name: "r1" }] })).status, 200);
  assert.equal((await beat(chunky("ballast-a", 300))).status, 200);
  assert.equal((await beat(chunky("ballast-b", 300))).status, 200);
  // `grower` is known, so admission lets it through — going over its share
  // while the registry is full is what refuses it, and a refused beat must not
  // damage what is being served.
  const refused = await beat(chunky("grower", 300));
  assert.equal(refused.status, 429);
  assert.deepEqual(agents["grower"].repos, [{ name: "r1" }]);
  assert.equal(recordBytes.get("grower"), agentRecordSize(agents["grower"]));
  // A normal-sized beat from the same host still lands.
  assert.equal((await beat({ device: "grower", repos: [{ name: "r3" }] })).status, 200);
  assert.deepEqual(agents["grower"].repos, [{ name: "r3" }]);
});

test("registryBytes tracks deletes it never saw, and matches a full re-measure", async () => {
  resetRegistry();
  // Every route that drops a host (DELETE /api/agents/<host>, prune(), the
  // tests) mutates `agents` directly, so the accounting has to self-heal rather
  // than depend on each of those sites remembering it.
  await beat({ device: "gone", sessions: [{ id: "s1", status: "running" }] });
  await beat({ device: "stays", sessions: [{ id: "s2", status: "running" }] });
  const both = registryBytes();
  delete agents["gone"];
  const after = registryBytes();
  assert.ok(after < both);
  assert.equal(after, agentRecordSize(agents["stays"]));
  assert.equal(recordBytes.has("gone"), false);
});

// ---- sizing ----------------------------------------------------------------

test("the default budget is derived from the container, and clamped", () => {
  // "A ceiling above the limit the kernel kills on is not a ceiling" (XERK-258)
  // — so the default is read from the cgroup rather than picked, and clamped so
  // a hostile/absent cgroup value can't produce a budget of nothing or of
  // everything.
  const budget = defaultRegistryBudget();
  assert.ok(budget >= (8 << 20) && budget <= (64 << 20), `budget ${budget} out of range`);
  const limit = containerMemoryLimit();
  assert.ok(limit === null || (typeof limit === "number" && limit > 0));
  if (limit && limit / 8 >= (8 << 20) && limit / 8 <= (64 << 20)) {
    assert.equal(budget, Math.floor(limit / 8));
  }
});

test("makeRegistryRoom reports failure instead of over-evicting", () => {
  resetRegistry();
  agents["fresh"] = { device: "fresh", lastSeen: Date.now() };
  // Nothing reclaimable and no room: the answer is `false` (which the caller
  // turns into a 429), never "evict the live host anyway".
  assert.equal(makeRegistryRoom(AGENTS_TOTAL_MAX + 1, 0), false);
  assert.ok(agents["fresh"]);
  assert.equal(makeRegistryRoom(0, AGENTS_MAX), false);
  assert.ok(agents["fresh"]);
  // Room for one more host is exactly what a beat from a new device asks for.
  assert.equal(makeRegistryRoom(0, 1), true);
});

test("a bad env knob is announced and ignored, never obeyed", () => {
  // `Number(x) || default` accepted a negative silently, and a negative cap
  // refuses the WHOLE fleet on its first beat with only a per-beat 429 to
  // explain it — a compose typo taking every host offline.
  const prev = process.env.__REGCAP_PROBE;
  const warned = [];
  const realWarn = console.warn;
  console.warn = (m) => warned.push(String(m));
  try {
    for (const bad of ["-1", "0", "abc", "-1e9"]) {
      process.env.__REGCAP_PROBE = bad;
      assert.equal(positiveEnv("__REGCAP_PROBE", 64), 64, `${bad} was obeyed`);
    }
    process.env.__REGCAP_PROBE = "128";
    assert.equal(positiveEnv("__REGCAP_PROBE", 64), 128);
    delete process.env.__REGCAP_PROBE;
    assert.equal(positiveEnv("__REGCAP_PROBE", 64), 64);
  } finally {
    console.warn = realWarn;
    if (prev === undefined) delete process.env.__REGCAP_PROBE;
    else process.env.__REGCAP_PROBE = prev;
  }
  assert.ok(warned.some((m) => m.includes("__REGCAP_PROBE")), "a bad value must be announced");
});

test("a host name cannot forge a hub log line", async () => {
  // `device` is agent-supplied and validated only for length and prototype
  // keys, so a newline in it wrote a line indistinguishable from the hub's own.
  const forged = "evil\n2026-01-01T00:00:00Z FORGED: all clear";
  assert.equal(logName(forged).includes("\n"), false);
  assert.equal(logName("h x").includes(" "), false);
  assert.ok(logName("plain-host").includes("plain-host"));
  // And it reaches the log through a real refusal, not just the helper.
  resetRegistry();
  for (let i = 0; i < AGENTS_MAX; i++) await beat({ device: `forge-${i}` });
  const lines = [];
  const realErr = console.error;
  console.error = (m) => lines.push(String(m));
  try {
    assert.equal((await beat({ device: forged })).status, 429);
  } finally {
    console.error = realErr;
  }
  assert.equal(lines.some((l) => l.includes("\n")), false, "a refusal log carried a raw newline");
});

test("EVERY heartbeat log naming a host is safe, not just the newest ones", async () => {
  // The 429 paths were fixed first and the older ones left; that is the wrong
  // way round. `refuseOversized` is ONE request with no registry pressure at
  // all, and the unknown-field drop rides a beat that returns 200 — both are
  // easier to reach than the throttled refusal above. All four sites that name
  // a host are driven here, so none of them can quietly revert.
  resetRegistry();
  const forged = "evil\r\n2026-01-01T00:00:00Z FORGED: hub healthy\u001b[2J\u0085NEL";
  const lines = [];
  const realErr = console.error;
  const realWarn = console.warn;
  console.error = (m) => lines.push(String(m));
  console.warn = (m) => lines.push(String(m));
  try {
    // Over AGENT_RECORD_MAX -> refuseOversized's 413.
    assert.equal(
      (await beat({ device: forged, sessions: "A".repeat((8 << 20) + 1024) })).status, 413);
    // An oversized UNKNOWN field -> sanitizeHeartbeat's drop line, on a beat
    // that is otherwise ACCEPTED.
    await beat({ device: forged, bogusField: "B".repeat((64 << 10) + 512) });
    // Between half and all of AGENT_RECORD_MAX -> the over-half warn (and the
    // over-half-SHARE warn, which this rig crosses far earlier).
    await beat(chunky(forged, (8 << 20) / 2 / 1024 + 64));
    // And the coercion-failure line, which no wire input can reach.
    const realNormalize = hub.recordCoercion.normalize;
    hub.recordCoercion.normalize = () => { throw new Error("coercion blew up"); };
    try {
      assert.equal((await beat({ device: forged })).status, 400);
    } finally {
      hub.recordCoercion.normalize = realNormalize;
    }
  } finally {
    console.error = realErr;
    console.warn = realWarn;
  }
  // 413, the drop line, over-half, over-half-share, coercion failure.
  assert.ok(lines.length >= 5, `only ${lines.length} of the log paths were driven`);
  assert.ok(lines.some((l) => l.includes("over the")), "the 413 line");
  assert.ok(lines.some((l) => l.includes("dropped unknown field")), "the drop line");
  assert.ok(lines.some((l) => l.includes("over half the")), "the over-half warn");
  assert.ok(lines.some((l) => l.includes("share of the registry budget")), "the share warn");
  assert.ok(lines.some((l) => l.includes("coercion failed")), "the coercion-failure line");
  for (const l of lines) {
    // C0, DEL and C1 — JSON.stringify escapes none of the C1 block, and NEL
    // (U+0085) reads as a line break to some log viewers.
    assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(l), false,
      `a raw control character reached the log: ${JSON.stringify(l)}`);
    assert.equal(l.includes("\n"), false, `a forged line break reached the log: ${JSON.stringify(l)}`);
  }
});

test("the refusal log is throttled, and says how many it swallowed", async () => {
  // The flood this cap exists to survive is exactly the traffic that writes
  // this line — unthrottled, surviving the attack costs the host its disk.
  resetRegistry();
  for (let i = 0; i < AGENTS_MAX; i++) await beat({ device: `noisy-${i}` });
  const lines = [];
  const realErr = console.error;
  console.error = (m) => lines.push(String(m));
  try {
    for (let i = 0; i < 60; i++) {
      assert.equal((await beat({ device: `flood-${i}` })).status, 429);
    }
  } finally {
    console.error = realErr;
  }
  assert.ok(lines.length <= 2, `60 refusals wrote ${lines.length} log lines`);
});

test("the state.json ceiling is measured before the file is opened", () => {
  // The restore trim cannot protect a restore it never reaches: readFileSync +
  // JSON.parse materialize the whole file, so a flooded state.json killed the
  // hub at init — before any log line, on every boot, forever.
  assert.ok(STATE_FILE_MAX >= (32 << 20), "the ceiling must clear a legitimate state file");
  const limit = containerMemoryLimit();
  if (limit) assert.ok(STATE_FILE_MAX <= limit, "and must not exceed the container itself");
});

test("fairShare never returns zero, however absurd the caps are", () => {
  // A share of 0 makes `recordSize > share` true for everyone, so the exemption
  // never applies and every host is refused the moment the registry is full —
  // the silent-offline regression, arrived at from a config `positiveEnv`
  // accepts. Held on the function so the extremes are reachable without a whole
  // process pinned to a degenerate config.
  assert.equal(hub.fairShare(1 << 20, 4), (1 << 20) / 4);
  assert.equal(hub.fairShare(100, 100), 1);
  assert.equal(hub.fairShare(100, 1000), 1, "a count past the budget in BYTES must still leave 1");
  assert.equal(hub.fairShare(1, 1 << 30), 1);
  assert.equal(hub.fairShare(1 << 20, 1), 1 << 20);
  // Floor, not round or ceil: AGENTS_MAX x share must never exceed the budget.
  assert.equal(hub.fairShare(10, 3), 3);
});

test("a host is warned BEFORE its share starts refusing it, once per crossing", async () => {
  // The per-record ceiling's warning is at 4 MiB and a share is 512 KiB, so a
  // host drifts past its share with the older warning still eight times away —
  // and the first thing the operator sees is the host vanishing.
  resetRegistry();
  const warns = [];
  const realWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    const halfShareKiB = Math.ceil(AGENT_FAIR_SHARE / 2 / 1024) + 2;
    assert.equal((await beat(chunky("drifter", halfShareKiB))).status, 200);
    assert.equal((await beat(chunky("drifter", halfShareKiB))).status, 200);
    assert.equal((await beat(chunky("drifter", halfShareKiB))).status, 200);
  } finally {
    console.warn = realWarn;
  }
  const share = warns.filter((m) => m.includes("over half") && m.includes("share"));
  assert.equal(share.length, 1, `warned ${share.length} times, want exactly one crossing`);
  assert.ok(share[0].includes("drifter"));
  assert.ok(hub.shareWarned.get("drifter"), "the crossing must be remembered, not re-warned");
});

test("the per-host share is DERIVED, so the overshoot cannot grow with AGENTS_MAX", () => {
  // The bound is exactly AGENTS_TOTAL_MAX + AGENTS_MAX * AGENT_FAIR_SHARE. A
  // FLOOR under the share (there was a 64 KiB one) makes the second term
  // unbounded in AGENTS_MAX — and raising AGENTS_MAX is what an operator with a
  // growing fleet is told to do. At AGENTS_MAX=2000 against the deployed 32 MiB
  // budget that was 3.9x the budget and the hub was OOM-killed.
  assert.ok(
    AGENTS_MAX * AGENT_FAIR_SHARE <= AGENTS_TOTAL_MAX,
    `${AGENTS_MAX} hosts x ${AGENT_FAIR_SHARE} bytes exceeds the ${AGENTS_TOTAL_MAX} budget`
  );
  assert.equal(AGENT_FAIR_SHARE, Math.max(1, Math.floor(AGENTS_TOTAL_MAX / AGENTS_MAX)));
});

test("an evicted host is forgotten by everything keyed on its name", async () => {
  resetRegistry();
  for (let i = 0; i < AGENTS_MAX; i++) await beat({ device: `sweep-${i}` });
  agents["sweep-0"].lastSeen = Date.now() - AGENT_EVICT_IDLE_MS * 2;
  // Populate the size-warning ledger for the host about to go, the way a beat
  // over half the per-record ceiling would.
  hub.recordSizeWarned.set("sweep-0", true);
  assert.equal((await beat({ device: "replacement" })).status, 200);
  assert.equal("sweep-0" in agents, false);
  // A registry that admits and evicts forever must not leak a per-host entry
  // for every name it has ever seen.
  assert.equal(recordBytes.has("sweep-0"), false);
  assert.equal(hub.recordSizeWarned.has("sweep-0"), false, "recordSizeWarned leaked an evicted host");
});

test("makeRegistryRoom spends no record on a request it cannot satisfy", () => {
  resetRegistry();
  agents["idle"] = { device: "idle", lastSeen: Date.now() - AGENT_EVICT_IDLE_MS * 2 };
  recordBytes.set("idle", 100);
  // Evicting everything reclaimable still would not fit this, so evict nothing:
  // the caller is refused either way, and an evicted record is an offline host's
  // last known sessions, PR chips and usage, gone.
  assert.equal(makeRegistryRoom(AGENTS_TOTAL_MAX + 1, 0), false);
  assert.ok(agents["idle"], "an idle record was spent on a refusal");
});
