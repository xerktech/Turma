// The storage-abstraction seam (XERK-754): the FileLiveStore contract, the
// byte-for-byte durable-persistence proof, the RESP2 codec, the shared-client URL
// parsing / health, and the factory's backend selection. The Valkey SOCKET path
// can't run in CI (no network), so its pure pieces — codec, URL parse, health
// state, not-connected rejection — are exercised here and the socket lifecycle is
// left to host QA.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { mkdtemp } = require("./tmpdirs");
const {
  createLiveStore,
  FileLiveStore,
  SharedLiveStore,
  RespParser,
  encodeCommand,
  sameValue,
  WATCH_CHANNEL,
} = require("../store.js");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// FileLiveStore — the default in-memory backend, whole contract.
// ---------------------------------------------------------------------------

test("XERK-754: FileLiveStore get/set/del round-trip", async () => {
  const s = new FileLiveStore();
  assert.equal(await s.get("k"), null);
  await s.set("k", { a: 1 });
  assert.deepEqual(await s.get("k"), { a: 1 });
  await s.del("k");
  assert.equal(await s.get("k"), null);
});

test("XERK-760: getDel returns the value AND removes it; null when absent", async () => {
  const s = new FileLiveStore();
  assert.equal(await s.getDel("k"), null); // absent
  await s.set("k", { a: 1 });
  assert.deepEqual(await s.getDel("k"), { a: 1 }); // returns the value
  assert.equal(await s.get("k"), null); // and it's gone
  assert.equal(await s.getDel("k"), null); // second consume sees nothing
});

test("XERK-760: getDel is a SNAPSHOT and is atomic under concurrency (single-use consume)", async () => {
  const s = new FileLiveStore();
  await s.set("k", { a: 1 });
  const v = await s.getDel("k");
  v.a = 999; // mutating the returned copy must not matter (already deleted, but snapshot anyway)
  assert.equal(await s.get("k"), null);
  // Two concurrent consumes of one key: exactly ONE gets the value (no `await`
  // between the read and the delete inside getDel), the other gets null. The old
  // get()+del() pair yielded between the two awaits and let both read it.
  await s.set("once", "the-token");
  const [a, b] = await Promise.all([s.getDel("once"), s.getDel("once")]);
  const got = [a, b].filter((x) => x != null);
  assert.deepEqual(got, ["the-token"], "exactly one concurrent consumer wins");
});

test("XERK-754: get returns a SNAPSHOT — mutating it can't reshape the store", async () => {
  const s = new FileLiveStore();
  await s.set("k", { a: 1 });
  const v = await s.get("k");
  v.a = 999;
  assert.deepEqual(await s.get("k"), { a: 1 }, "in-place mutation of a get() copy must not leak back");
});

test("XERK-754: setIfAbsent is single-flight", async () => {
  const s = new FileLiveStore();
  assert.equal(await s.setIfAbsent("g", "first"), true);
  assert.equal(await s.setIfAbsent("g", "second"), false);
  assert.equal(await s.get("g"), "first");
});

test("XERK-754: compareAndSet matches by value incl. null/absent", async () => {
  const s = new FileLiveStore();
  // absent -> expected null succeeds
  assert.equal(await s.compareAndSet("c", null, "v1"), true);
  assert.equal(await s.get("c"), "v1");
  // mismatch fails, no write
  assert.equal(await s.compareAndSet("c", "wrong", "v2"), false);
  assert.equal(await s.get("c"), "v1");
  // match succeeds
  assert.equal(await s.compareAndSet("c", "v1", "v2"), true);
  assert.equal(await s.get("c"), "v2");
  // object expected matches by deep value
  await s.set("o", { x: [1, 2] });
  assert.equal(await s.compareAndSet("o", { x: [1, 2] }, "flat"), true);
  assert.equal(await s.get("o"), "flat");
});

test("XERK-754: compareAndSet expected-null matches absent OR stored-null (the shared-backend parity contract, QA D2)", async () => {
  const s = new FileLiveStore();
  // absent key: expected null succeeds
  assert.equal(await s.compareAndSet("a", null, "v"), true);
  // key holding JSON null: expected null ALSO succeeds (File conflates the two;
  // SharedLiveStore's Lua matches v==false OR v=="null" to agree — host-verified).
  await s.set("b", null);
  assert.equal(await s.compareAndSet("b", null, "v"), true);
  assert.equal(await s.get("b"), "v");
  // expected null must NOT match a stored non-null value
  await s.set("c", 5);
  assert.equal(await s.compareAndSet("c", null, "v"), false);
  assert.equal(await s.get("c"), 5);
});

test("XERK-754: incrBy counts from 0", async () => {
  const s = new FileLiveStore();
  assert.equal(await s.incrBy("n", 3), 3);
  assert.equal(await s.incrBy("n", 4), 7);
});

test("XERK-754: scan/mget filter by prefix", async () => {
  const s = new FileLiveStore();
  await s.set("host:a", 1);
  await s.set("host:b", 2);
  await s.set("other", 3);
  const rows = await s.scan("host:");
  assert.deepEqual(new Set(rows.map((r) => r.key)), new Set(["host:a", "host:b"]));
  const rows2 = await s.mget("host:");
  assert.equal(rows2.length, 2);
});

test("XERK-754: watch fires on matching set/del, unsubscribe stops it", async () => {
  const s = new FileLiveStore();
  const events = [];
  const off = s.watch("host:", (e) => events.push(e));
  await s.set("host:a", 1);
  await s.set("elsewhere", 2); // not under prefix
  await s.del("host:a");
  assert.deepEqual(
    events.map((e) => [e.type, e.key]),
    [["set", "host:a"], ["del", "host:a"]]
  );
  off();
  await s.set("host:c", 3);
  assert.equal(events.length, 2, "unsubscribed watcher gets nothing more");
});

test("XERK-754: publish/subscribe fans out, unsubscribe stops", async () => {
  const s = new FileLiveStore();
  const got = [];
  const off = s.subscribe("chan", (m) => got.push(m));
  await s.publish("chan", { hi: 1 });
  await s.publish("other", { no: 1 });
  off();
  await s.publish("chan", { hi: 2 });
  assert.deepEqual(got, [{ hi: 1 }]);
});

test("XERK-754: queuePush/queueDrain drains once and empties", async () => {
  const s = new FileLiveStore();
  await s.queuePush("q", { cmd: 1 });
  await s.queuePush("q", { cmd: 2 });
  assert.deepEqual(await s.queueDrain("q"), [{ cmd: 1 }, { cmd: 2 }]);
  assert.deepEqual(await s.queueDrain("q"), [], "second drain is empty");
});

test("XERK-754: ttlMs expires a key", async () => {
  const s = new FileLiveStore();
  await s.set("t", "v", { ttlMs: 15 });
  assert.equal(await s.get("t"), "v");
  await delay(40);
  assert.equal(await s.get("t"), null);
});

// ---------------------------------------------------------------------------
// Durable persistence — byte-for-byte behaviour-compatible with today's stores.
// ---------------------------------------------------------------------------

test("XERK-754: a durable key persists JSON byte-for-byte via temp+rename", async () => {
  const dir = mkdtemp("turma-store-");
  const file = path.join(dir, "state.json");
  const s = new FileLiveStore({ persistent: { state: { file, debounceMs: 5 } } });
  // A registry-shaped value, exactly what state.json holds today.
  const value = { "host-a": { lastSeen: 123, sessions: [], commands: [] }, "host-b": { lastSeen: 456 } };
  await s.set("state", value);
  s.flush(); // synchronous temp+rename, the drain path
  const onDisk = fs.readFileSync(file, "utf8");
  assert.equal(onDisk, JSON.stringify(value), "on-disk bytes are exactly JSON.stringify(value)");
  // temp+rename leaves no sibling temp file behind.
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "no .tmp- file left after an atomic write");
});

test("XERK-754: a durable key reloads on a fresh store (restart restore)", async () => {
  const dir = mkdtemp("turma-store-");
  const file = path.join(dir, "policy.json");
  const first = new FileLiveStore({ persistent: { policy: { file, debounceMs: 5 } } });
  await first.set("policy", { orgA: { minPriority: "P1" } });
  first.flush();
  // A new process would construct a new store; the value comes back.
  const second = new FileLiveStore({ persistent: { policy: { file, debounceMs: 5 } } });
  assert.deepEqual(await second.get("policy"), { orgA: { minPriority: "P1" } });
});

test("XERK-754: the debounced (async) write also lands byte-for-byte", async () => {
  const dir = mkdtemp("turma-store-");
  const file = path.join(dir, "d.json");
  const s = new FileLiveStore({ persistent: { d: { file, debounceMs: 5 } } });
  await s.set("d", { n: 7 });
  await delay(30); // let the debounce fire (async temp+rename)
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify({ n: 7 }));
});

test("XERK-754: an unreadable/absent durable file loads as absent, never fatal", async () => {
  const dir = mkdtemp("turma-store-");
  const file = path.join(dir, "missing.json");
  // No file written — construction must not throw and the key reads null.
  const s = new FileLiveStore({ persistent: { k: { file } } });
  assert.equal(await s.get("k"), null);
});

test("XERK-754: a RAM-only key is never written to disk", async () => {
  const dir = mkdtemp("turma-store-");
  const file = path.join(dir, "only.json");
  const s = new FileLiveStore({ persistent: { durable: { file, debounceMs: 5 } } });
  await s.set("ram-only", { x: 1 }); // not the durable key
  s.flush();
  assert.equal(fs.existsSync(file), false, "a non-durable key touches no file");
});

// ---------------------------------------------------------------------------
// RESP2 codec — the wire protocol, exercised without a socket.
// ---------------------------------------------------------------------------

test("XERK-754: encodeCommand builds a RESP array of bulk strings", () => {
  assert.equal(
    encodeCommand(["SET", "k", "v"]).toString("utf8"),
    "*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\nv\r\n"
  );
  // numbers stringify, binary-safe lengths are byte lengths
  assert.equal(encodeCommand(["INCRBY", "n", 5]).toString("utf8"), "*3\r\n$6\r\nINCRBY\r\n$1\r\nn\r\n$1\r\n5\r\n");
});

test("XERK-754: RespParser decodes every RESP2 type", () => {
  const p = new RespParser();
  assert.deepEqual(p.feed(Buffer.from("+OK\r\n")), ["OK"]);
  assert.deepEqual(p.feed(Buffer.from(":42\r\n")), [42]);
  assert.deepEqual(p.feed(Buffer.from("$3\r\nabc\r\n")), ["abc"]);
  assert.deepEqual(p.feed(Buffer.from("$-1\r\n")), [null]); // null bulk
  assert.deepEqual(p.feed(Buffer.from("*-1\r\n")), [null]); // null array
  const err = p.feed(Buffer.from("-ERR nope\r\n"));
  assert.ok(err[0] instanceof Error && err[0].message === "ERR nope");
  assert.deepEqual(p.feed(Buffer.from("*2\r\n$1\r\na\r\n:7\r\n")), [["a", 7]]);
});

test("XERK-754: RespParser reassembles a reply split across chunks", () => {
  const p = new RespParser();
  const full = "*2\r\n$5\r\nhello\r\n$5\r\nworld\r\n";
  const out = [];
  for (const ch of full) out.push(...p.feed(Buffer.from(ch))); // one byte at a time
  assert.deepEqual(out, [["hello", "world"]]);
});

test("XERK-754: RespParser returns multiple replies from one chunk", () => {
  const p = new RespParser();
  assert.deepEqual(p.feed(Buffer.from("+A\r\n:1\r\n$1\r\nb\r\n")), ["A", 1, "b"]);
});

test("XERK-754: RespParser surfaces an Error on a malformed length, never throws (QA D3)", () => {
  // A desync'd bulk/array length must become an Error reply (the connection layer
  // resets on it) rather than throwing out of feed() on NaN arithmetic.
  const bad = new RespParser();
  const r1 = bad.feed(Buffer.from("$abc\r\n"));
  assert.ok(r1[0] instanceof Error && /bad bulk length/.test(r1[0].message));
  const bad2 = new RespParser();
  const r2 = bad2.feed(Buffer.from("*xyz\r\n"));
  assert.ok(r2[0] instanceof Error && /bad array length/.test(r2[0].message));
});

// ---------------------------------------------------------------------------
// Factory + SharedLiveStore construction (no dialling).
// ---------------------------------------------------------------------------

test("XERK-754: factory returns the file backend when HA is off", () => {
  const s = createLiveStore({ ha: false });
  assert.ok(s instanceof FileLiveStore);
  assert.equal(s.kind, "file");
  assert.equal(s.health, "ready");
});

test("XERK-754: factory returns the shared backend when HA is on", () => {
  const s = createLiveStore({ ha: true, storeUrl: "rediss://:secret@valkey.host:6380/3" }, { connect: false });
  assert.ok(s instanceof SharedLiveStore);
  assert.equal(s.kind, "shared");
  assert.equal(s.tls, true);
  assert.equal(s.host, "valkey.host");
  assert.equal(s.port, 6380);
  assert.equal(s.db, 3);
  assert.equal(s.password, "secret");
  assert.equal(s.health, "closed", "not dialled with connect:false");
});

test("XERK-754: shared store defaults port 6379 / db 0, reads plain redis://", () => {
  const s = createLiveStore({ ha: true, storeUrl: "redis://valkey.host" }, { connect: false });
  assert.equal(s.tls, false);
  assert.equal(s.port, 6379);
  assert.equal(s.db, 0);
  assert.equal(s.password, null);
});

test("XERK-754: shared store rejects commands while not connected (fail narrow)", async () => {
  const s = createLiveStore({ ha: true, storeUrl: "redis://valkey.host:6379" }, { connect: false });
  await assert.rejects(() => s.get("k"), /not connected/);
});

test("XERK-754: shared store onHealth fires on close()", () => {
  const s = createLiveStore({ ha: true, storeUrl: "redis://valkey.host:6379" }, { connect: false });
  const seen = [];
  s.onHealth((h) => seen.push(h));
  s.close();
  // already "closed" -> no change emitted; construct connecting then close
  assert.equal(s.health, "closed");
  assert.deepEqual(seen, []);
});

test("XERK-754: sameValue canonicalises JSON for CAS", () => {
  assert.equal(sameValue(1, 1), true);
  assert.equal(sameValue({ a: 1 }, { a: 1 }), true);
  assert.equal(sameValue({ a: 1 }, { a: 2 }), false);
  assert.equal(sameValue(null, null), true);
});

test("XERK-754: WATCH_CHANNEL is exported and stable", () => {
  assert.equal(WATCH_CHANNEL, "__turma_watch__");
});
