// Restoring an ARCHIVED session onto a live host (XERK-441).
//
// The hub's archive keeps a byte-for-byte copy of every ended session's own
// files (XERK-338's raw layer), so a session outlives the box it ran on. Until
// this, nothing could feed those bytes back to an agent: `importSession` existed
// only as the target half of a live migration, which needs the SOURCE host
// online. These drive the route end to end — seed the archive, remove the host,
// restore onto another — and pin the refusals, because each one of them is the
// difference between "we can't" and a resumed session that quietly lost its
// conversation.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "hubuser";
process.env.TURMA_PASSWORD = "hubpass";
process.env.TURMA_AGENT_TOKEN = "agenttok";
process.env.STATE_FILE = path.join(os.tmpdir(), `turma-restore-state-${process.pid}.json`);
process.env.DEVICES_FILE = path.join(os.tmpdir(), `turma-restore-devices-${process.pid}.json`);
process.env.USAGE_LEDGER_FILE = path.join(os.tmpdir(), `turma-restore-ledger-${process.pid}.json`);
// NOT mkdtemp'd: a spool dir the TEST creates is a directory production does not
// have. `spoolRawBody` makes it on the migration-UPLOAD path only, and a hub that
// has never relayed a live move — a fresh deploy, a recreated volume, or the
// one-agent fleet this feature exists for — has none, which failed every restore
// with an ENOENT reported to the operator as a corrupt archive. Naming a path
// that does not exist is what keeps that honest.
process.env.MIGRATE_SPOOL_DIR = path.join(
  os.tmpdir(), `turma-restore-spool-${process.pid}`, "migrations");
process.env.ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "turma-restore-archive-"));
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

const hub = require("../server.js");
const archive = require("../archive.js");
// The same module object server.js holds, so a test can stand in for the packer.
const tarmod = require("../tar.js");
const { agents, migrations, advanceMigrations, server } = hub;
// Every restore leaves a record holding an in-flight slot and MIGRATE_INFLIGHT_MAX
// is 4, so a run of them starves itself. The tests above deliberately chain (one
// looks up the record the last one made), so this is called by the independent
// tests below rather than from a beforeEach.
// Packing is async and off the request. The budget is deliberately generous: a
// tight one made this suite fail only in the parallel full-tree run, which reads
// as a real defect and is not one.
// `dropMigrationBlob` unlinks with the ASYNC fs.unlink, so an existsSync fired
// on the next line races it — the file is released, just not yet.
async function spoolGone(id) {
  const f = path.join(process.env.MIGRATE_SPOOL_DIR, `${id}.bin`);
  for (let i = 0; i < 200 && fs.existsSync(f); i++)
    await new Promise((r) => setTimeout(r, 10));
  return !fs.existsSync(f);
}
async function waitPacked(m) {
  for (let i = 0; i < 600 && m.phase === "exporting"; i++)
    await new Promise((r) => setTimeout(r, 25));
  return m.phase;
}
function releaseInFlight() {
  for (const m of [...migrations.values()]) {
    if (m.phase !== "exporting" && m.phase !== "importing") continue;
    migrations.delete(m.id);
    // The record is what owns the spool file; dropping one without the other
    // leaves bytes behind that the spool-is-empty assertions then trip over.
    try { fs.unlinkSync(path.join(process.env.MIGRATE_SPOOL_DIR, `${m.id}.bin`)); } catch {}
  }
}

let baseUrl = "";
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  archive.closeDb();
  fs.rmSync(path.dirname(process.env.MIGRATE_SPOOL_DIR), { recursive: true, force: true });
});

function request(method, pathName, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + pathName, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(buf.toString("utf8")); } catch {}
        resolve({ status: res.statusCode, body: parsed, buf });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const userHeaders = {
  authorization: "Basic " + Buffer.from("hubuser:hubpass").toString("base64"),
  "content-type": "application/json",
};
const agentHeaders = { authorization: "Bearer agenttok", "content-type": "application/json" };

// Read a gzipped ustar archive back into {name -> Buffer}. Deliberately a
// hand-rolled reader rather than the writer's own code: a bundle this hub writes
// is read by python's `tarfile` on the agent, so the test has to check the BYTES
// on the wire, not that pack and unpack agree with each other.
function untarGz(buf) {
  const tar = zlib.gunzipSync(buf);
  const out = {};
  let off = 0;
  while (off + 512 <= tar.length) {
    const head = tar.subarray(off, off + 512);
    if (head.every((b) => b === 0)) break;
    const cstr = (start, len) => {
      const s = head.subarray(start, start + len);
      const z = s.indexOf(0);
      return s.subarray(0, z === -1 ? s.length : z).toString("utf8");
    };
    const name = cstr(0, 100);
    const prefix = cstr(345, 155);
    const size = parseInt(cstr(124, 12).trim() || "0", 8);
    // The checksum has to verify, or a real tar reader would reject the member.
    const stated = parseInt(cstr(148, 8).trim() || "-1", 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 0x20 : head[i];
    assert.equal(sum, stated, `checksum for ${name}`);
    assert.equal(cstr(257, 6), "ustar", "ustar magic");
    off += 512;
    out[prefix ? `${prefix}/${name}` : name] = tar.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

const TID = "aaaaaaaa-1111-2222-3333-444444444444";
const CONVERSATION = '{"type":"user","message":"one"}\n{"type":"assistant","message":"two"}\n';
const SUBAGENT = '{"type":"assistant","message":"sub"}\n';
const WORKTREE = "/mnt/tank/repos/.turma/worktrees/Widget/ab12c";

// Seed the archive the way a real agent does: rendered entries first (that is
// what puts the row in the index), then the raw layer beside it.
function seedArchive(tid = TID, { raw = true, worktree = WORKTREE } = {}) {
  archive.ingestChunk("truenas", tid, {
    repo: "Widget", remoteKey: "github.com/acme/widget", worktree,
    summary: "Fix the flange", createdAt: "2026-08-01T00:00:00Z",
    endedTs: "2026-08-02T00:00:00Z",
  }, 0, CONVERSATION.length, [{ uuid: "u1", role: "user", ts: 1, text: "one" }]);
  if (!raw) return;
  archive.ingestRaw("truenas", tid, `${tid}.jsonl`, 0, Buffer.from(CONVERSATION));
  archive.ingestRaw("truenas", tid, `${tid}/subagents/qa.jsonl`, 0, Buffer.from(SUBAGENT));
}

function beat(device, { repos = ["Widget"], sessions = [] } = {}) {
  return request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    body: { device, agentId: device, repos: repos.map((n) => ({ name: n })), sessions },
  });
}

test.before(() => { seedArchive(); });

test("restore: an archived session is packed and imported onto a live host", async () => {
  await beat("k8x");
  const r = await request("POST", `/api/archive/${TID}/restore`,
    { headers: userHeaders, body: { host: "k8x" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.migrationId;
  const m = migrations.get(id);
  assert.ok(m);
  // No source: this is the whole point — the host that ran it may not exist.
  assert.equal(m.srcHost, null);
  assert.equal(m.srcSessionId, null);
  assert.equal(m.restore, true);
  assert.equal(m.transcriptId, TID);

  // Packing is async; the record flips to `importing` once the spool is written.
  await waitPacked(m);
  assert.equal(m.phase, "importing", m.error || "");
  assert.ok(m.importCmdId);

  const cmd = (agents["k8x"].commands || []).find((c) => c.cmdId === m.importCmdId);
  assert.ok(cmd, "importSession is queued on the target");
  assert.equal(cmd.type, "importSession");
  assert.equal(cmd.transcriptId, TID);
  // The archived host's own path: the agent remaps its mount-independent tail
  // onto its own REPOS_ROOT, so the hub must ship it unchanged.
  assert.equal(cmd.cwd, WORKTREE);
  assert.equal(cmd.repo, "Widget");
  assert.equal(cmd.migratedFrom.host, "truenas");
  assert.equal(cmd.migratedFrom.sessionId, null);
  assert.equal(cmd.migratedFrom.fromArchive, true);
  // The archive's summary is the only name the session still has — but it was
  // never operator-typed, so claiming `summaryManual` would stop the agent ever
  // re-deriving one.
  assert.equal(cmd.summary, "Fix the flange");
  assert.equal(cmd.summaryManual, false);
});

test("restore: the bundle the target downloads is the archived bytes, byte for byte", async () => {
  // Its own restore rather than the previous test's: scanning `migrations` for
  // one still in `importing` couples the test to how fast the last pack ran,
  // which made this suite fail under parallel load and nowhere else.
  releaseInFlight();
  await beat("k8x");
  const r0 = await request("POST", `/api/archive/${TID}/restore`,
    { headers: userHeaders, body: { host: "k8x" } });
  assert.equal(r0.status, 200, JSON.stringify(r0.body));
  const m = migrations.get(r0.body.migrationId);
  assert.equal(await waitPacked(m), "importing", m.error || "");
  const blob = await request("GET", `/api/agents/k8x/migrations/${m.id}/blob`,
    { headers: agentHeaders });
  assert.equal(blob.status, 200);
  const files = untarGz(blob.buf);
  // The layout `_pack_transcript` produces and `_unpack_transcript` expects:
  // relative to the project-slug dir, conversation at the top.
  assert.deepEqual(Object.keys(files).sort(), [`${TID}.jsonl`, `${TID}/subagents/qa.jsonl`]);
  assert.equal(files[`${TID}.jsonl`].toString("utf8"), CONVERSATION);
  assert.equal(files[`${TID}/subagents/qa.jsonl`].toString("utf8"), SUBAGENT);
});

test("restore: the handoff finishes without killing anything", async () => {
  // Its own restore rather than the previous test's: scanning `migrations` for
  // one still in `importing` couples the test to how fast the last pack ran,
  // which made this suite fail under parallel load and nowhere else.
  releaseInFlight();
  await beat("k8x");
  const r0 = await request("POST", `/api/archive/${TID}/restore`,
    { headers: userHeaders, body: { host: "k8x" } });
  assert.equal(r0.status, 200, JSON.stringify(r0.body));
  const m = migrations.get(r0.body.migrationId);
  assert.equal(await waitPacked(m), "importing", m.error || "");
  // The target reports the imported session up, under the importSession cmdId.
  await beat("k8x", { sessions: [{ id: "s-new", status: "running", spawnCmdId: m.importCmdId,
    repo: "Widget", transcriptId: TID }] });
  advanceMigrations();
  assert.equal(m.phase, "done", m.error || "");
  assert.equal(m.targetSessionId, "s-new");
  // A move kills the source once the target is up. A restore has no source, so
  // nothing may be queued anywhere — a stray kill would hit whatever session id
  // happened to match.
  for (const a of Object.values(agents)) {
    assert.equal((a.commands || []).some((c) => c.type === "kill"), false);
  }
  // And the spool file is released like any settled move.
  assert.equal(m.blobPath, null);
  assert.equal(await spoolGone(m.id), true, "the spool file is released");
});

test("restore: a session with no RAW copy is readable and refused, in the hub's words", async () => {
  // The rendered layer is {uuid, role, ts, text} — a display copy. `claude
  // --resume` cannot read it, so a session archived before the raw layer, or one
  // whose raw push never landed, must be refused HERE rather than failing inside
  // the agent after a download.
  const tid = "bbbbbbbb-1111-2222-3333-444444444444";
  seedArchive(tid, { raw: false });
  await beat("k8x");
  const r = await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: { host: "k8x" } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /no raw copy/);
});

test("restore: an unknown transcript is a 404, not an empty bundle", async () => {
  const r = await request("POST", "/api/archive/cccccccc-0000-0000-0000-000000000000/restore",
    { headers: userHeaders, body: { host: "k8x" } });
  assert.equal(r.status, 404);
});

test("restore: the target must be online and have the repo", async () => {
  const tid = "dddddddd-1111-2222-3333-444444444444";
  seedArchive(tid);
  assert.equal((await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: { host: "nope" } })).status, 404);
  assert.equal((await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: {} })).status, 400);

  await beat("norepo", { repos: ["Other"] });
  const noRepo = await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: { host: "norepo" } });
  assert.equal(noRepo.status, 409);
  assert.match(noRepo.body.error, /doesn't have "Widget" cloned/);

  await beat("stale");
  agents["stale"].lastSeen = Date.now() - 10 * 60 * 1000;
  const offline = await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: { host: "stale" } });
  assert.equal(offline.status, 503);
  assert.match(offline.body.error, /offline/);
});

test("restore: one conversation, one session", async () => {
  // A restore PRESERVES the transcript id, so restoring a conversation that is
  // already running would put two claudes on one transcript file — and
  // `_session_transcript_path` could not say whose it is.
  const tid = "eeeeeeee-1111-2222-3333-444444444444";
  seedArchive(tid);
  await beat("k8x", { sessions: [{ id: "live-1", status: "running", repo: "Widget", transcriptId: tid }] });
  const r = await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: { host: "k8x" } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already running on k8x/);
  await beat("k8x");
});

test("restore: a double click does not fan out into two restores", async () => {
  const tid = "ffffffff-1111-2222-3333-444444444444";
  seedArchive(tid);
  await beat("k8x");
  const first = await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: { host: "k8x" } });
  assert.equal(first.status, 200);
  const second = await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: { host: "k8x" } });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already being restored/);
  const m = migrations.get(first.body.migrationId);
  m.phase = "failed";
  hub.dropMigrationBlob(m);
});

test("restore: the route is the operator's, never an agent's", async () => {
  const tid = "99999999-1111-2222-3333-444444444444";
  seedArchive(tid);
  const r = await request("POST", `/api/archive/${tid}/restore`,
    { headers: agentHeaders, body: { host: "k8x" } });
  assert.equal(r.status, 401);
});

// A raw name the archive accepts but ustar cannot carry: `safeRawRel` allows 255
// bytes per component, the tar header field is 100 with a 155-byte prefix that
// can only split on a `/`, so a long BASENAME has nowhere to go.
const LONG_NAME = "q".repeat(150) + ".jsonl";

test("restore: a bundle that could not carry everything says so on the record", async () => {
  releaseInFlight();
  // Dropping a subagent transcript and reporting `done` tells the operator they
  // have their session back when part of it is not there — and the only trace
  // used to be a line in the hub's own stderr.
  const tid = "bbbbbbbb-1111-2222-3333-444444444444";
  seedArchive(tid);
  archive.ingestRaw("truenas", tid, `${tid}/subagents/${LONG_NAME}`, 0, Buffer.from(SUBAGENT));
  await beat("k8x");
  const r = await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: { host: "k8x" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = migrations.get(r.body.migrationId);
  await waitPacked(m);

  // It still restores — the conversation itself is intact.
  assert.equal(m.phase, "importing", m.error || "");
  assert.ok(m.incomplete, "the record carries what the bundle could not");
  assert.equal(m.incomplete.total, 1);
  assert.ok(m.incomplete.skipped.some((n) => n.includes(LONG_NAME)));
  // And it rides out to the clients, so the UI can word it as partial.
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  const sm = res.body.migrations.find((x) => x.id === m.id);
  assert.ok(sm.incomplete, "serialized for the clients");
  assert.equal(sm.incomplete.total, 1);
});

test("restore: a conversation that cannot be packed intact FAILS, it does not half-restore", async () => {
  releaseInFlight();
  // A skipped `<id>.jsonl` restores an empty session and a NUL-padded one a
  // corrupt transcript, and `claude --resume` presents either as the operator's
  // own history. Refusing is the only honest outcome.
  //
  // Driven through the packer's own seam rather than by shrinking the file:
  // `listRawFiles` stats live, so the real race — a raw file rewritten between
  // that stat and the async pack — cannot be made to happen on demand.
  const tid = "cccccccc-1111-2222-3333-444444444444";
  seedArchive(tid);
  await beat("k8x");
  const real = tarmod.packGzipTar;
  tarmod.packGzipTar = async (...a) => {
    const out = await real(...a);
    out.short.push(`${tid}.jsonl`);
    return out;
  };
  try {
    const r = await request("POST", `/api/archive/${tid}/restore`,
      { headers: userHeaders, body: { host: "k8x" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = migrations.get(r.body.migrationId);
    await waitPacked(m);
    assert.equal(m.phase, "failed");
    assert.match(m.error, /could not be packed intact/);
    assert.equal(m.importCmdId, null, "nothing was queued on the target");
    assert.equal(fs.existsSync(path.join(process.env.MIGRATE_SPOOL_DIR, `${m.id}.bin`)), false,
      "and the spool file is gone");
  } finally {
    tarmod.packGzipTar = real;
  }
});

test("restore: a conversation that comes back up mid-restore aborts it", async () => {
  releaseInFlight();
  // The admission check is a snapshot, and the importing window is minutes: the
  // archived host can revive, or someone can resume that transcript by hand, and
  // finishing would put two claudes on one file.
  const tid = "dddddddd-1111-2222-3333-444444444444";
  seedArchive(tid);
  await beat("k8x");
  const r = await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: { host: "k8x" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = migrations.get(r.body.migrationId);
  await waitPacked(m);
  assert.equal(m.phase, "importing", m.error || "");

  // The host that ran it turns back up, with that conversation live.
  await beat("revived", { sessions: [{ id: "old-1", status: "running", repo: "Widget", transcriptId: tid }] });
  advanceMigrations();
  assert.equal(m.phase, "failed");
  assert.match(m.error, /came back up on revived/);
  assert.equal(await spoolGone(m.id), true, "the spool file is released");
});

test("restore: the TARGET reporting the session up is a success, not a clash", async () => {
  releaseInFlight();
  // The same re-check must not read the target's own imported session as a rival
  // claude, or every restore would abort at the moment it succeeded.
  const tid = "eeeeeeee-1111-2222-3333-444444444444";
  seedArchive(tid);
  await beat("k8x");
  const r = await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: { host: "k8x" } });
  const m = migrations.get(r.body.migrationId);
  await waitPacked(m);
  await beat("k8x", { sessions: [{ id: "s-imported", status: "running", repo: "Widget",
                                  transcriptId: tid, spawnCmdId: m.importCmdId }] });
  advanceMigrations();
  assert.equal(m.phase, "done", m.error || "");
  assert.equal(m.targetSessionId, "s-imported");
});

test("restore: a recorded worktree that is not a session worktree is refused up front", async () => {
  releaseInFlight();
  // The path is replayed as the agent's cwd and remapped by its
  // `.turma/worktrees/<repo>/<dir>` tail. Without that tail only the agent can
  // refuse it — after the hub has spent an in-flight slot and a spool file, and
  // the operator has watched a restore that could never work.
  await beat("k8x");
  for (const [n, bad] of Object.entries({
    etc: "/etc",
    traversal: "/mnt/tank/repos/.turma/worktrees/Widget/../../../etc",
    root: "/",
    shallow: "/mnt/tank/repos/.turma/worktrees/Widget",
  })) {
    const tid = `ffff${n.padEnd(4, "0").slice(0, 4)}-1111-2222-3333-444444444444`;
    seedArchive(tid, { worktree: bad });
    const r = await request("POST", `/api/archive/${tid}/restore`,
      { headers: userHeaders, body: { host: "k8x" } });
    assert.equal(r.status, 409, `${n}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /not a session worktree/);
  }
});

test("restore: a ROOT session is restorable — its cwd has no worktree tail to match", async () => {
  releaseInFlight();
  // The repos-root pseudo-repo's cwd IS the source host's REPOS_ROOT. Requiring a
  // `.turma/worktrees/<repo>/<dir>` tail refused every archived root session —
  // 822 of the stranded rows on the production hub, against 178 the tail accepts.
  // The agent supports them (`_resumable_cwd_class` -> is_root), so the row's own
  // repo is what identifies one; there is no shape for the hub to check.
  const tid = "10101010-1111-2222-3333-444444444444";
  archive.ingestChunk("truenas", tid, {
    repo: "(root)", remoteKey: "", worktree: "/mnt/tank/repos",
    summary: "Root work", createdAt: "2026-08-01T00:00:00Z", endedTs: "2026-08-02T00:00:00Z",
  }, 0, CONVERSATION.length, [{ uuid: "u1", role: "user", ts: 1, text: "one" }]);
  archive.ingestRaw("truenas", tid, `${tid}.jsonl`, 0, Buffer.from(CONVERSATION));
  await beat("k8x", { repos: ["Widget", "(root)"] });
  const r = await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: { host: "k8x" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = migrations.get(r.body.migrationId);
  await waitPacked(m);
  assert.equal(m.phase, "importing", m.error || "");
  const cmd = (agents["k8x"].commands || []).find((c) => c.cmdId === m.importCmdId);
  assert.equal(cmd.cwd, "/mnt/tank/repos", "the source's REPOS_ROOT rides unchanged");
});

test("restore: a repo-dir session is restorable too", async () => {
  releaseInFlight();
  // `<REPOS_ROOT>/<repo>`, the third shape `_resumable_cwd_class` accepts. Same
  // problem as root: no tail, so the row's repo is what says the last segment is
  // a repo rather than an arbitrary directory.
  const tid = "20202020-1111-2222-3333-444444444444";
  seedArchive(tid, { worktree: "/mnt/tank/repos/Widget" });
  await beat("k8x");
  const r = await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: { host: "k8x" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("restore: a host that is OFFLINE cannot veto a restore forever", async () => {
  releaseInFlight();
  // A host that died with the session running keeps `status: "running"` in its
  // last record for good, so gating on it answered "kill it there first" naming a
  // host the operator cannot reach — on precisely the population this feature is
  // for. Only ONLINE hosts get a say.
  const tid = "30303030-1111-2222-3333-444444444444";
  seedArchive(tid);
  await beat("k8x");
  await beat("deadbox", { sessions: [{ id: "ghost", status: "running", repo: "Widget", transcriptId: tid }] });
  // While it is online, it does veto.
  const live = await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: { host: "k8x" } });
  assert.equal(live.status, 409);
  assert.match(live.body.error, /already running on deadbox/);

  agents["deadbox"].lastSeen = Date.now() - 10 * 60 * 1000;
  const r = await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: { host: "k8x" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("restore: a rival claude ON THE TARGET is caught, not skipped with the host", async () => {
  releaseInFlight();
  // `import_session` downloads and unpacks BEFORE `_resume_at_cwd` refuses, so a
  // conversation resumed locally on the target between admission and its next
  // beat has the archived bytes written over it. Skipping the whole target host
  // left the one machine that actually unpacks unchecked; only the migration's
  // OWN session may be skipped.
  const tid = "40404040-1111-2222-3333-444444444444";
  seedArchive(tid);
  await beat("k8x");
  const r = await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: { host: "k8x" } });
  const m = migrations.get(r.body.migrationId);
  await waitPacked(m);
  assert.equal(m.phase, "importing", m.error || "");

  // The target itself turns out to be running that conversation already, under a
  // spawnCmdId that is NOT this migration's.
  await beat("k8x", { sessions: [{ id: "local-resume", status: "running", repo: "Widget",
                                   transcriptId: tid, spawnCmdId: "unrelated" }] });
  advanceMigrations();
  assert.equal(m.phase, "failed");
  assert.match(m.error, /came back up on k8x/);
});

test("restore: the incomplete list is CAPPED on the wire", async () => {
  releaseInFlight();
  // It rides /api/agents and every SSE frame, and the names come from the raw
  // layer — bounded per name, unbounded in COUNT. `total` still tells the truth.
  const tid = "50505050-1111-2222-3333-444444444444";
  seedArchive(tid);
  for (let i = 0; i < 25; i++) {
    archive.ingestRaw("truenas", tid, `${tid}/subagents/${"z".repeat(150)}${i}.jsonl`,
                      0, Buffer.from(SUBAGENT));
  }
  await beat("k8x");
  const r = await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: { host: "k8x" } });
  const m = migrations.get(r.body.migrationId);
  await waitPacked(m);
  assert.equal(m.phase, "importing", m.error || "");
  assert.equal(m.incomplete.total, 25, "the count is the truth");
  assert.equal(m.incomplete.skipped.length, 20, "the NAMES are capped");
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  const sm = res.body.migrations.find((x) => x.id === m.id);
  assert.equal(sm.incomplete.skipped.length, 20);
});

test("restore: an offline host cannot veto at the TICK either, not just admission", async () => {
  // Fixing admission alone made the outcome WORSE than the refusal it replaced:
  // the restore was admitted, spent an in-flight slot and a pack, and was then
  // killed by the same dead host one tick later, with an error asserting it "came
  // back up". A host keeps `status: "running"` for PRUNE_AFTER_MS — seven days.
  releaseInFlight();
  const tid = "60606060-1111-2222-3333-444444444444";
  seedArchive(tid);
  await beat("k8x");
  await beat("tombstone", { sessions: [{ id: "ghost", status: "running", repo: "Widget",
                                         transcriptId: tid, spawnCmdId: "OLDSPAWN" }] });
  agents["tombstone"].lastSeen = Date.now() - 10 * 60 * 1000;

  const r = await request("POST", `/api/archive/${tid}/restore`,
    { headers: userHeaders, body: { host: "k8x" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = migrations.get(r.body.migrationId);
  assert.equal(await waitPacked(m), "importing", m.error || "");

  advanceMigrations();
  assert.equal(m.phase, "importing", `a dead host killed it: ${m.error}`);
});

test("restore: a `..` in the recorded worktree is refused whatever else it looks like", async () => {
  // The traversal guard has to be pinned on its own: every case in the shape
  // matrix also fails the shape test, so removing the guard changed nothing there
  // and the suite stayed green over it.
  releaseInFlight();
  await beat("k8x");
  for (const [n, bad] of Object.entries({
    // Shaped exactly like a worktree, and `(root)`/repo-dir shaped, so ONLY the
    // `..` check can refuse each of these.
    worktreeish: "/mnt/tank/repos/.turma/worktrees/Widget/..",
    rootish: "/mnt/tank/repos/..",
    repodirish: "/mnt/tank/repos/../Widget",
  })) {
    const tid = `7777${n.padEnd(4, "0").slice(0, 4)}-1111-2222-3333-444444444444`;
    archive.ingestChunk("truenas", tid, {
      repo: n === "rootish" ? "(root)" : "Widget", remoteKey: "", worktree: bad,
      summary: "s", createdAt: "2026-08-01T00:00:00Z", endedTs: "2026-08-02T00:00:00Z",
    }, 0, CONVERSATION.length, [{ uuid: "u1", role: "user", ts: 1, text: "one" }]);
    archive.ingestRaw("truenas", tid, `${tid}.jsonl`, 0, Buffer.from(CONVERSATION));
    const r = await request("POST", `/api/archive/${tid}/restore`,
      { headers: userHeaders, body: { host: "k8x" } });
    assert.equal(r.status, 409, `${n}: ${JSON.stringify(r.body)}`);
  }
});

test("restore: a transcript directory is refused up front, not packed and then refused", async () => {
  // `repo == "(root)"` is ALSO the agent's catch-all for a cwd it could not
  // attribute to a repo, so accepting root rows on the repo alone admitted every
  // row whose recorded "worktree" is really a ~/.claude/projects/<slug> store —
  // 1228 of the 1262 restorable (root) rows on the production hub. No agent can
  // resume one, so each cost a slot, a pack and a spool file to learn that.
  releaseInFlight();
  await beat("k8x", { repos: ["Widget", "(root)"] });
  for (const [n, dir] of Object.entries({
    root: "/root/.claude/projects/-mnt-data-Docker-git-Turma",
    home: "/home/mhabeeb/.claude/projects/-home-mhabeeb-git-Other",
  })) {
    const tid = `8888${n.padEnd(4, "0").slice(0, 4)}-1111-2222-3333-444444444444`;
    archive.ingestChunk("truenas", tid, {
      repo: "(root)", remoteKey: "", worktree: dir,
      summary: "s", createdAt: "2026-08-01T00:00:00Z", endedTs: "2026-08-02T00:00:00Z",
    }, 0, CONVERSATION.length, [{ uuid: "u1", role: "user", ts: 1, text: "one" }]);
    archive.ingestRaw("truenas", tid, `${tid}.jsonl`, 0, Buffer.from(CONVERSATION));
    const r = await request("POST", `/api/archive/${tid}/restore`,
      { headers: userHeaders, body: { host: "k8x" } });
    assert.equal(r.status, 409, `${n}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /transcript directory/);
  }
});
