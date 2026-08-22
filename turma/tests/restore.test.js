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
process.env.MIGRATE_SPOOL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "turma-restore-spool-"));
process.env.ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "turma-restore-archive-"));
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

const hub = require("../server.js");
const archive = require("../archive.js");
const { agents, migrations, advanceMigrations, server } = hub;

let baseUrl = "";
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); archive.closeDb(); });

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
  for (let i = 0; i < 100 && m.phase === "exporting"; i++) await new Promise((r2) => setTimeout(r2, 20));
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
  const m = [...migrations.values()].find((x) => x.transcriptId === TID && x.phase === "importing");
  assert.ok(m, "the restore from the previous test is still in flight");
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
  const m = [...migrations.values()].find((x) => x.transcriptId === TID && x.phase === "importing");
  assert.ok(m);
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
  assert.equal(fs.readdirSync(process.env.MIGRATE_SPOOL_DIR).length, 0);
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
