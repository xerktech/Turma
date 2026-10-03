// The stdlib Postgres client (XERK-776): the PURE message codec + SCRAM crypto
// pinned to known vectors (RFC 7677's SCRAM-SHA-256 proof, a hand-built DataRow),
// the GREATEST-upsert SQL builder, the factory's HA gate, and the FULL query /
// upsertGreatest / pool round-trip driven over a LOCAL Postgres protocol fake — so
// the socket path (SSL negotiation, startup, a real SCRAM handshake, the extended
// Parse/Bind/Describe/Execute/Sync flow) IS exercised in CI with no live Postgres,
// the same "pure core + local fake in CI, real backend in host QA" posture
// SharedLiveStore and S3BlobStore take. zero-npm.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const crypto = require("crypto");
const {
  createPgClient,
  PgPool,
  parsePgUrl,
  ByteWriter,
  PgProtocolReader,
  frameMessage,
  encodeStartupMessage,
  encodeSSLRequest,
  encodeParse,
  encodeBind,
  encodeSASLInitialResponse,
  parseAuthentication,
  parseRowDescription,
  parseDataRow,
  parseNoticeFields,
  parseCommandComplete,
  parseReadyForQuery,
  parseScramServerFirst,
  scramClientProof,
  md5AuthResponse,
  quoteIdent,
  buildUpsertGreatest,
  PROTOCOL_VERSION,
  SSL_REQUEST_CODE,
} = require("../pgclient.js");

// ============================================================================
// Frontend encoders
// ============================================================================

test("encodeStartupMessage frames length + protocol + params", () => {
  const buf = encodeStartupMessage({ user: "alice", database: "turma" });
  assert.equal(buf.readInt32BE(0), buf.length, "length field covers the whole message");
  assert.equal(buf.readInt32BE(4), PROTOCOL_VERSION);
  const body = buf.toString("latin1", 8);
  assert.match(body, /user\0alice\0/);
  assert.match(body, /database\0turma\0/);
  assert.equal(buf[buf.length - 1], 0, "trailing NUL terminates the param list");
});

test("encodeSSLRequest is the fixed 8-byte magic packet", () => {
  const buf = encodeSSLRequest();
  assert.equal(buf.length, 8);
  assert.equal(buf.readInt32BE(0), 8);
  assert.equal(buf.readInt32BE(4), SSL_REQUEST_CODE);
});

test("frameMessage: type byte + self-inclusive length + body", () => {
  const m = frameMessage("Q", Buffer.from("hi"));
  assert.equal(String.fromCharCode(m[0]), "Q");
  assert.equal(m.readInt32BE(1), 4 + 2); // length includes its own 4 bytes
  assert.equal(m.toString("utf8", 5), "hi");
  // Empty-body message (e.g. Sync/Terminate) is type + length 4.
  const s = frameMessage("S");
  assert.equal(s.length, 5);
  assert.equal(s.readInt32BE(1), 4);
});

test("encodeParse sends 0 param type OIDs (server infers)", () => {
  const m = encodeParse("SELECT 1");
  assert.equal(String.fromCharCode(m[0]), "P");
  // body: cstring name "" (1) + cstring "SELECT 1" (9) + int16 0 (2)
  const body = m.subarray(5);
  assert.equal(body[0], 0, "unnamed statement");
  assert.equal(body.readInt16BE(body.length - 2), 0, "no param type OIDs");
});

test("encodeBind: text values, NULL as length -1, 0 format codes", () => {
  const m = encodeBind(["x", null, 7, true]);
  const r = m.subarray(5);
  // portal "" + statement "" then int16 0 (formats), int16 4 (values)
  let p = 2; // two empty cstrings
  assert.equal(r.readInt16BE(p), 0); // 0 param format codes -> all text
  p += 2;
  assert.equal(r.readInt16BE(p), 4); // four values
  p += 2;
  const readVal = () => {
    const len = r.readInt32BE(p);
    p += 4;
    if (len === -1) return null;
    const v = r.toString("utf8", p, p + len);
    p += len;
    return v;
  };
  assert.equal(readVal(), "x");
  assert.equal(readVal(), null); // SQL NULL is length -1, no bytes
  assert.equal(readVal(), "7"); // numbers rendered as text
  assert.equal(readVal(), "t"); // booleans as Postgres t/f
});

// ============================================================================
// Backend reader + decoders
// ============================================================================

test("PgProtocolReader reassembles messages split across chunks", () => {
  const a = frameMessage("A", Buffer.from("first"));
  const b = frameMessage("B", Buffer.from("second"));
  const whole = Buffer.concat([a, b]);
  const reader = new PgProtocolReader();
  const out = [];
  // Feed one byte at a time — the worst-case split.
  for (const byte of whole) out.push(...reader.feed(Buffer.from([byte])));
  assert.equal(out.length, 2);
  assert.equal(out[0].type, "A");
  assert.equal(out[0].body.toString(), "first");
  assert.equal(out[1].type, "B");
  assert.equal(out[1].body.toString(), "second");
});

test("PgProtocolReader yields multiple messages from one chunk", () => {
  const whole = Buffer.concat([frameMessage("1"), frameMessage("2"), frameMessage("Z", Buffer.from("I"))]);
  const out = new PgProtocolReader().feed(whole);
  assert.deepEqual(out.map((m) => m.type), ["1", "2", "Z"]);
  assert.equal(out[2].body.toString(), "I");
});

test("PgProtocolReader throws on a corrupt (sub-4) length", () => {
  const bad = Buffer.from([0x44, 0, 0, 0, 2]); // type 'D', length 2 (< 4)
  assert.throws(() => new PgProtocolReader().feed(bad), /bad message length/);
});

test("PgProtocolReader rejects an over-cap declared length before buffering it", () => {
  // type 'D', length 0x7fffffff — a hostile server declaring ~2 GiB. The header
  // alone (5 bytes) trips the cap; no body bytes are accumulated.
  const header = Buffer.from([0x44, 0x7f, 0xff, 0xff, 0xff]);
  assert.throws(() => new PgProtocolReader().feed(header), /exceeds the .* cap/);
});

test("parseAuthentication decodes each flavour", () => {
  const auth = (code, extra) =>
    parseAuthentication(new ByteWriter().int32(code).bytes(extra || Buffer.alloc(0)).build());
  assert.deepEqual(auth(0), { name: "ok" });
  assert.deepEqual(auth(3), { name: "cleartext" });
  const md5 = auth(5, Buffer.from([1, 2, 3, 4]));
  assert.equal(md5.name, "md5");
  assert.deepEqual([...md5.salt], [1, 2, 3, 4]);
  const sasl = auth(10, new ByteWriter().cstring("SCRAM-SHA-256").int8(0).build());
  assert.deepEqual(sasl, { name: "sasl", mechanisms: ["SCRAM-SHA-256"] });
  assert.deepEqual(auth(11, Buffer.from("r=abc,s=xx,i=4096")), {
    name: "sasl-continue",
    data: "r=abc,s=xx,i=4096",
  });
  assert.deepEqual(auth(12, Buffer.from("v=sig")), { name: "sasl-final", data: "v=sig" });
});

test("parseRowDescription reads field metadata", () => {
  const body = new ByteWriter()
    .int16(1)
    .cstring("total")
    .int32(1234) // table oid
    .int16(2) // column attr
    .int32(20) // type oid (int8)
    .int16(8) // type len
    .int32(-1) // type mod
    .int16(0) // format text
    .build();
  const fields = parseRowDescription(body);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].name, "total");
  assert.equal(fields[0].typeOid, 20);
  assert.equal(fields[0].format, 0);
});

test("parseDataRow: text columns and a NULL (pinned vector)", () => {
  const body = new ByteWriter()
    .int16(3)
    .int32(5)
    .bytes(Buffer.from("hello"))
    .int32(-1) // NULL
    .int32(0) // empty string (length 0, not null)
    .build();
  const cols = parseDataRow(body);
  assert.equal(cols.length, 3);
  assert.equal(cols[0].toString(), "hello");
  assert.equal(cols[1], null);
  assert.equal(cols[2].toString(), "");
});

test("parseNoticeFields builds a combined message and keeps SQLSTATE", () => {
  const body = new ByteWriter()
    .int8("S".charCodeAt(0))
    .cstring("ERROR")
    .int8("C".charCodeAt(0))
    .cstring("23505")
    .int8("M".charCodeAt(0))
    .cstring("duplicate key")
    .int8(0)
    .build();
  const f = parseNoticeFields(body);
  assert.equal(f.C, "23505");
  assert.equal(f.message, "ERROR (23505) duplicate key");
});

test("parseCommandComplete pulls the trailing row count", () => {
  assert.deepEqual(parseCommandComplete(new ByteWriter().cstring("INSERT 0 1").build()), {
    tag: "INSERT 0 1",
    rowCount: 1,
  });
  assert.deepEqual(parseCommandComplete(new ByteWriter().cstring("SELECT 42").build()), {
    tag: "SELECT 42",
    rowCount: 42,
  });
});

test("parseReadyForQuery reads the transaction status byte", () => {
  assert.deepEqual(parseReadyForQuery(Buffer.from("I")), { status: "I" });
  assert.deepEqual(parseReadyForQuery(Buffer.from("E")), { status: "E" });
});

// ============================================================================
// SCRAM-SHA-256 — RFC 7677 §3 test vector
// ============================================================================

test("scramClientProof matches RFC 7677's SCRAM-SHA-256 vector", () => {
  const clientFirstBare = "n=user,r=rOprNGfwEbeRWgbNEkqO";
  const serverFirst =
    "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";
  const { clientFinalMessage, serverSignature } = scramClientProof("pencil", clientFirstBare, serverFirst);
  assert.equal(
    clientFinalMessage,
    "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0," +
      "p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="
  );
  assert.equal(serverSignature, "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
});

test("parseScramServerFirst splits nonce/salt/iterations", () => {
  const p = parseScramServerFirst("r=abcXYZ,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096");
  assert.equal(p.nonce, "abcXYZ");
  assert.equal(p.iterations, 4096);
  assert.equal(p.salt.toString("base64"), "W22ZaJ0SNY7soEsUEjb6gQ==");
});

test("md5AuthResponse follows the md5(md5(pw+user)+salt) shape", () => {
  const salt = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const inner = crypto.createHash("md5").update("secretbob").digest("hex");
  const expect = "md5" + crypto.createHash("md5").update(Buffer.concat([Buffer.from(inner), salt])).digest("hex");
  assert.equal(md5AuthResponse("bob", "secret", salt), expect);
});

// ============================================================================
// GREATEST upsert SQL builder
// ============================================================================

test("buildUpsertGreatest wraps high-water columns and orders params", () => {
  const { text, params } = buildUpsertGreatest({
    table: "usage_ledger",
    keys: { host: "k8x", day: "2026-09-11" },
    values: { tokens: 500, updated_at: "2026-09-11T00:00:00Z" },
    greatest: ["tokens"],
  });
  assert.equal(
    text,
    'INSERT INTO "usage_ledger" ("host", "day", "tokens", "updated_at") ' +
      "VALUES ($1, $2, $3, $4) ON CONFLICT (\"host\", \"day\") DO UPDATE SET " +
      '"tokens" = GREATEST("usage_ledger"."tokens", EXCLUDED."tokens"), ' +
      '"updated_at" = EXCLUDED."updated_at"'
  );
  // Params are keys first, then values, in column order.
  assert.deepEqual(params, ["k8x", "2026-09-11", 500, "2026-09-11T00:00:00Z"]);
});

test("buildUpsertGreatest with no value columns is DO NOTHING", () => {
  const { text, params } = buildUpsertGreatest({ table: "seen", keys: { id: "x" }, values: {} });
  assert.equal(text, 'INSERT INTO "seen" ("id") VALUES ($1) ON CONFLICT ("id") DO NOTHING');
  assert.deepEqual(params, ["x"]);
});

test("buildUpsertGreatest requires a conflict key", () => {
  assert.throws(() => buildUpsertGreatest({ table: "t", keys: {}, values: { a: 1 } }), /conflict key/);
});

test("quoteIdent rejects an unsafe identifier (no value ever interpolated)", () => {
  assert.equal(quoteIdent("host_total"), '"host_total"');
  assert.throws(() => quoteIdent('x"; DROP TABLE y; --'), /unsafe SQL identifier/);
  assert.throws(() => buildUpsertGreatest({ table: "t;DROP", keys: { a: 1 }, values: {} }), /unsafe SQL identifier/);
});

// ============================================================================
// parsePgUrl + factory HA gate
// ============================================================================

test("parsePgUrl reads host/port/user/password/db/sslmode", () => {
  const c = parsePgUrl("postgres://u:p%40ss@db.internal:5433/turma?sslmode=require");
  assert.equal(c.host, "db.internal");
  assert.equal(c.port, 5433);
  assert.equal(c.user, "u");
  assert.equal(c.password, "p@ss"); // percent-decoded
  assert.equal(c.database, "turma");
  assert.equal(c.sslmode, "require");
});

test("parsePgUrl defaults port 5432 and sslmode prefer", () => {
  const c = parsePgUrl("postgresql://svc@pg/appdb");
  assert.equal(c.port, 5432);
  assert.equal(c.sslmode, "prefer");
  assert.equal(c.database, "appdb");
});

test("createPgClient returns null when HA is off / fatal / no DATABASE_URL", () => {
  assert.equal(createPgClient({ ha: false }), null);
  assert.equal(createPgClient({ ha: true, databaseUrl: null }), null);
  assert.equal(createPgClient({ ha: true, databaseUrl: "postgres://x/y", fatal: ["boom"] }), null);
  assert.equal(createPgClient(null), null);
});

test("createPgClient builds a PgPool when HA is on with a DATABASE_URL", () => {
  const pool = createPgClient(
    { ha: true, databaseUrl: "postgres://u:p@h:5432/db?sslmode=disable", fatal: [] },
    { connect: false }
  );
  assert.ok(pool instanceof PgPool);
  assert.equal(pool.kind, "postgres");
  assert.equal(pool.health, "idle"); // nothing dialed yet
  pool.close();
});

// ============================================================================
// The live socket path — a local Postgres v3 protocol fake.
// ============================================================================

// A minimal Postgres server: answers SSLRequest with 'N' (plaintext — exercises
// the negotiation + fallback), runs a REAL SCRAM-SHA-256 handshake (verifying the
// client's proof with the shared password), then answers the extended query flow.
// A SELECT-shaped query echoes the bound params back as one row (proving binding);
// an INSERT-shaped one returns "INSERT 0 1" with no rows.
function startFakePg(opts = {}) {
  const password = opts.password || "pencil";
  const iterations = 4096;
  let connectionCount = 0;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    connectionCount++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (opts.hangConnection === connectionCount) {
      // Accept the TCP connection but never answer — a black-holed handshake.
      socket.on("error", () => {});
      socket.resume(); // keep reading so the client's close reaches us and server.close() can finish
      return;
    }
    let buf = Buffer.alloc(0);
    let phase = "ssl";
    const sc = {}; // scram state for this socket
    let lastSql = "";
    let boundValues = [];

    const send = (b) => socket.write(b);
    const authMsg = (code, extra) =>
      frameMessage("R", new ByteWriter().int32(code).bytes(extra || Buffer.alloc(0)).build());

    const answerQuery = () => {
      const write = [frameMessage("1"), frameMessage("2")]; // ParseComplete, BindComplete
      if (opts.hangOnQuery) return; // never respond — drives the client timeout
      if (opts.malformOnQuery) {
        // A RowDescription claiming 1000 fields with an empty body — the decoder
        // reads past the end. Proves a hostile/desynced server rejects the query
        // rather than crashing the hub with an uncaught RangeError.
        send(Buffer.concat([...write, frameMessage("T", new ByteWriter().int16(1000).build())]));
        return;
      }
      if (/^\s*INSERT/i.test(lastSql)) {
        write.push(frameMessage("n")); // NoData (Describe portal, no result columns)
        write.push(frameMessage("C", new ByteWriter().cstring("INSERT 0 1").build()));
      } else {
        const rd = new ByteWriter().int16(boundValues.length);
        boundValues.forEach((_, i) =>
          rd.cstring(`p${i}`).int32(0).int16(0).int32(25).int16(-1).int32(-1).int16(0)
        );
        write.push(frameMessage("T", rd.build()));
        const dr = new ByteWriter().int16(boundValues.length);
        for (const v of boundValues) {
          if (v == null) dr.int32(-1);
          else dr.int32(Buffer.byteLength(v)).bytes(Buffer.from(v, "utf8"));
        }
        write.push(frameMessage("D", dr.build()));
        write.push(frameMessage("C", new ByteWriter().cstring(`SELECT ${boundValues.length ? 1 : 0}`).build()));
      }
      write.push(frameMessage("Z", Buffer.from("I")));
      send(Buffer.concat(write));
    };

    const handleTyped = (type, body) => {
      if (phase === "sasl-initial" && type === "p") {
        // SASLInitialResponse: cstring mechanism, int32 len, client-first-message.
        let p = body.indexOf(0) + 1;
        p += 4; // skip the int32 length
        const clientFirst = body.toString("utf8", p); // "n,,n=,r=<nonce>"
        sc.clientFirstBare = clientFirst.slice(3); // strip gs2 header "n,,"
        const clientNonce = /r=([^,]+)/.exec(sc.clientFirstBare)[1];
        const serverNonce = clientNonce + crypto.randomBytes(12).toString("base64");
        const salt = crypto.randomBytes(16).toString("base64");
        sc.serverFirst = `r=${serverNonce},s=${salt},i=${iterations}`;
        send(authMsg(11, Buffer.from(sc.serverFirst, "utf8")));
        phase = "sasl-final";
        return;
      }
      if (phase === "sasl-final" && type === "p") {
        const clientFinal = body.toString("utf8");
        // Verify the client proof by recomputing it from the shared password.
        const expected = scramClientProof(password, sc.clientFirstBare, sc.serverFirst);
        if (clientFinal !== expected.clientFinalMessage) {
          send(frameMessage("E", new ByteWriter().int8("M".charCodeAt(0)).cstring("bad SCRAM proof").int8(0).build()));
          socket.end();
          return;
        }
        send(authMsg(12, Buffer.from(`v=${expected.serverSignature}`, "utf8")));
        send(authMsg(0)); // AuthenticationOk
        send(frameMessage("Z", Buffer.from("I")));
        phase = "query";
        return;
      }
      if (phase === "query") {
        if (type === "P") {
          const r = body;
          const nameEnd = r.indexOf(0);
          const sqlEnd = r.indexOf(0, nameEnd + 1);
          lastSql = r.toString("utf8", nameEnd + 1, sqlEnd);
        } else if (type === "B") {
          // cstring portal, cstring statement, int16 nformats(+formats), int16 nvalues, values
          let p = 0;
          p = body.indexOf(0, p) + 1; // portal
          p = body.indexOf(0, p) + 1; // statement
          const nfmt = body.readInt16BE(p);
          p += 2 + nfmt * 2;
          const nval = body.readInt16BE(p);
          p += 2;
          boundValues = [];
          for (let i = 0; i < nval; i++) {
            const len = body.readInt32BE(p);
            p += 4;
            if (len === -1) boundValues.push(null);
            else {
              boundValues.push(body.toString("utf8", p, p + len));
              p += len;
            }
          }
        } else if (type === "S") {
          if (opts.queryDelayMs) setTimeout(answerQuery, opts.queryDelayMs);
          else answerQuery();
        }
        return;
      }
    };

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (phase === "ssl") {
          if (buf.length < 8) return;
          buf = buf.subarray(8);
          send(Buffer.from("N")); // decline SSL -> plaintext
          phase = "startup";
          continue;
        }
        if (phase === "startup") {
          if (buf.length < 4) return;
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          buf = buf.subarray(len);
          send(authMsg(10, new ByteWriter().cstring("SCRAM-SHA-256").int8(0).build())); // AuthenticationSASL
          phase = "sasl-initial";
          continue;
        }
        // typed messages
        if (buf.length < 5) return;
        const type = String.fromCharCode(buf[0]);
        const mlen = buf.readInt32BE(1);
        if (buf.length < 1 + mlen) return;
        const mbody = buf.subarray(5, 1 + mlen);
        buf = buf.subarray(1 + mlen);
        handleTyped(type, Buffer.from(mbody));
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        // Destroy what is still open so a leak fails its assertion, not hangs close().
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
        get connectionCount() {
          return connectionCount;
        },
        get openSockets() {
          return sockets.size;
        },
        // Server-side close of every open connection — a Postgres restart/failover
        // as the pool's IDLE connections see it.
        dropAll: () => { for (const s of sockets) s.destroy(); },
      });
    });
  });
}

function poolFor(fake, extra = {}) {
  // No sslmode -> "prefer": the client sends SSLRequest, the fake declines with
  // 'N', and the client falls back to plaintext — so the negotiation path runs.
  const url = `postgres://user:${extra.password || "pencil"}@127.0.0.1:${fake.port}/turma`;
  return new PgPool({ ha: true, databaseUrl: url, fatal: [] }, {
    max: extra.max || 2,
    queryTimeoutMs: extra.queryTimeoutMs || 2000,
    connectTimeoutMs: extra.connectTimeoutMs,
  });
}

// Settle a promise or report it still pending — the defects below are all
// "never settles", so a bounded wait is the assertion.
function settleWithin(p, ms) {
  let timer;
  return Promise.race([
    p.then((v) => ({ resolved: v }), (e) => ({ rejected: e })),
    new Promise((r) => { timer = setTimeout(() => r({ pending: true }), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function captureWarn() {
  const lines = [];
  const orig = console.warn;
  console.warn = (...a) => lines.push(a.join(" "));
  return { lines, restore: () => { console.warn = orig; } };
}

test("live: SSL negotiation + SCRAM handshake + parameterized query round-trip", async () => {
  const fake = await startFakePg();
  const pool = poolFor(fake);
  try {
    const rows = await pool.query("SELECT $1::text AS a, $2::text AS b", ["alpha", "beta"]);
    // The fake echoes bound params as p0/p1 — proves Bind carried the values and
    // DataRow decoded back to text.
    assert.equal(rows.length, 1);
    assert.equal(rows[0].p0, "alpha");
    assert.equal(rows[0].p1, "beta");
    assert.equal(pool.health, "ready"); // the connection is live and pooled
  } finally {
    pool.close();
    await fake.close();
  }
});

test("live: a NULL parameter binds as SQL NULL and decodes back to null", async () => {
  const fake = await startFakePg();
  const pool = poolFor(fake);
  try {
    const rows = await pool.query("SELECT $1", [null]);
    assert.equal(rows[0].p0, null);
  } finally {
    pool.close();
    await fake.close();
  }
});

test("live: upsertGreatest issues the INSERT and returns the affected count", async () => {
  const fake = await startFakePg();
  const pool = poolFor(fake);
  try {
    const n = await pool.upsertGreatest({
      table: "usage_ledger",
      keys: { host: "k8x", day: "2026-09-11" },
      values: { tokens: 1000 },
      greatest: ["tokens"],
    });
    assert.equal(n, 1); // "INSERT 0 1"
  } finally {
    pool.close();
    await fake.close();
  }
});

test("live: sequential queries REUSE one pooled connection", async () => {
  const fake = await startFakePg();
  const pool = poolFor(fake, { max: 3 });
  try {
    await pool.query("SELECT $1", ["a"]);
    await pool.query("SELECT $1", ["b"]);
    await pool.query("SELECT $1", ["c"]);
    assert.equal(fake.connectionCount, 1, "one connection served all three");
  } finally {
    pool.close();
    await fake.close();
  }
});

test("live: concurrent queries never exceed the pool's max connections", async () => {
  const fake = await startFakePg();
  const pool = poolFor(fake, { max: 2 });
  try {
    const results = await Promise.all(
      ["a", "b", "c", "d", "e"].map((v) => pool.query("SELECT $1", [v]))
    );
    assert.equal(results.length, 5);
    for (const r of results) assert.equal(r.length, 1);
    assert.ok(fake.connectionCount <= 2, `made ${fake.connectionCount} connections, cap is 2`);
  } finally {
    pool.close();
    await fake.close();
  }
});

test("live: idle connections the server closed never wedge the pool", async () => {
  // Every pooled connection dies while IDLE (a Postgres failover). They must not
  // keep counting toward `max`: when they did, _pump saw a full pool with nothing
  // alive, spawned nothing, and every later query waited forever — on prod the
  // archive hydrate hung for days with ingest 503'd behind it.
  const fake = await startFakePg();
  const pool = poolFor(fake, { max: 2 });
  try {
    await Promise.all([pool.query("SELECT $1", ["a"]), pool.query("SELECT $1", ["b"])]);
    assert.equal(fake.connectionCount, 2);
    fake.dropAll();
    await new Promise((r) => setTimeout(r, 50)); // let both 'close' events land
    let timer;
    const rows = await Promise.race([
      pool.query("SELECT $1", ["c"]),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("pool wedged")), 2000); }),
    ]).finally(() => clearTimeout(timer));
    assert.deepEqual(rows, [{ p0: "c" }]);
    assert.equal(fake.connectionCount, 3, "a fresh connection replaced the dead ones");
  } finally {
    pool.close();
    await fake.close();
  }
});

test("live: a query that never gets a reply times out and poisons its connection", async () => {
  const fake = await startFakePg({ hangOnQuery: true });
  const pool = poolFor(fake, { queryTimeoutMs: 250 });
  try {
    await assert.rejects(pool.query("SELECT 1", []), /query timeout/);
  } finally {
    pool.close();
    await fake.close();
  }
});

test("live: a malformed backend message rejects the query, never crashes the process", async () => {
  // If the decode loop let a RangeError escape the socket 'data' handler it would
  // be an uncaughtException that kills node --test itself — so this test COMPLETING
  // is part of the assertion (QA finding, XERK-776 defect 1).
  const fake = await startFakePg({ malformOnQuery: true });
  const pool = poolFor(fake, { queryTimeoutMs: 2000 });
  try {
    await assert.rejects(pool.query("SELECT 1", []));
    assert.notEqual(pool.health, "ready"); // the poisoned connection was torn down
  } finally {
    pool.close();
    await fake.close();
  }
});

test("live: a wrong password fails the SCRAM handshake, so connect rejects", async () => {
  const fake = await startFakePg({ password: "correct-horse" });
  // The client uses the wrong password, so its proof won't verify server-side and
  // the fake returns an ErrorResponse with "bad SCRAM proof".
  const url = `postgres://user:wrongpw@127.0.0.1:${fake.port}/turma`;
  const pool = new PgPool({ ha: true, databaseUrl: url, fatal: [] }, { queryTimeoutMs: 1000, connectTimeoutMs: 5000 });
  try {
    await assert.rejects(pool.query("SELECT 1", []), /SCRAM/i);
  } finally {
    pool.close();
    await fake.close();
  }
});

test("live: acquire has a deadline, so a leaked slot rejects instead of wedging", async () => {
  // A slot that never returns (the leak class that hung prod for days) used to make
  // every later acquire wait forever with nothing logged.
  const fake = await startFakePg();
  const pool = poolFor(fake, { max: 1, queryTimeoutMs: 200 });
  try {
    pool._conns.push({ alive: true, busy: true }); // a leaked, permanently-busy slot
    const r = await settleWithin(pool.query("SELECT 1", []), 2000);
    assert.ok(r.rejected, "the acquire must not stay pending");
    assert.match(r.rejected.message, /acquire timeout/);
    assert.equal(pool._waiters.length, 0, "the timed-out waiter left the queue");
    pool._conns.length = 0;
  } finally {
    pool.close();
    await fake.close();
  }
});

test("live: an IDLE connection death logs one line per connection; a busy one does not", async () => {
  const fake = await startFakePg();
  const pool = poolFor(fake, { max: 2 });
  const warn = captureWarn();
  try {
    await Promise.all([pool.query("SELECT $1", ["a"]), pool.query("SELECT $1", ["b"])]);
    fake.dropAll();
    await new Promise((r) => setTimeout(r, 50));
    const idle = warn.lines.filter((l) => /idle connection .* died/.test(l));
    assert.equal(idle.length, 2, warn.lines.join("\n"));
  } finally {
    warn.restore();
    pool.close();
    await fake.close();
  }
  const hang = await startFakePg({ hangOnQuery: true });
  const pool2 = poolFor(hang, { queryTimeoutMs: 150 });
  const warn2 = captureWarn();
  try {
    await assert.rejects(pool2.query("SELECT 1", []), /query timeout/);
    assert.equal(warn2.lines.filter((l) => /idle connection/.test(l)).length, 0);
  } finally {
    warn2.restore();
    pool2.close();
    await hang.close();
  }
});

test("live: a failed dial never rejects a waiter that queued AFTER it started", async () => {
  // conn #1 is healthy but slow; conn #2's handshake is black-holed until its
  // connect timeout. q3 arrives while #2 is still dialling — it is #1's to serve,
  // and #2's eventual failure must not reject it.
  const fake = await startFakePg({ hangConnection: 2, queryDelayMs: 300 });
  const pool = poolFor(fake, { max: 2, queryTimeoutMs: 5000, connectTimeoutMs: 500 });
  try {
    const q1 = pool.query("SELECT $1", ["1"]);
    await new Promise((r) => setTimeout(r, 30));
    const q2 = pool.query("SELECT $1", ["2"]); // spawns the doomed dial
    await new Promise((r) => setTimeout(r, 330)); // q1 done; #1 now serves q2
    const q3 = pool.query("SELECT $1", ["3"]); // queued behind q2, after the dial
    const [r1, r2, r3] = await Promise.all([q1, q2, q3].map((p) => settleWithin(p, 3000)));
    assert.deepEqual(r1.resolved, [{ p0: "1" }]);
    assert.deepEqual(r2.resolved, [{ p0: "2" }]);
    assert.ok(!r3.rejected, `q3 was rejected by a stale dial: ${r3.rejected && r3.rejected.message}`);
    assert.deepEqual(r3.resolved, [{ p0: "3" }]);
    // The timed-out dial was stuck in SSL negotiation; its socket must be destroyed.
    await new Promise((r) => setTimeout(r, 50));
    // (the dial's failure re-dials for q3, so every OTHER connection is still open)
    assert.equal(fake.openSockets, fake.connectionCount - 1, "the black-holed dial's socket was closed");
  } finally {
    pool.close();
    await fake.close();
  }
});

test("live: ready() rejects when its only connection fails with no waiters", async () => {
  const fake = await startFakePg();
  const port = fake.port;
  await fake.close(); // nothing listening -> ECONNREFUSED
  const pool = new PgPool({ ha: true, databaseUrl: `postgres://u:p@127.0.0.1:${port}/turma`, fatal: [] }, {});
  try {
    const r = await settleWithin(pool.ready(), 2000);
    assert.ok(r.rejected, "ready() must not stay pending");
    assert.match(r.rejected.message, /ECONNREFUSED/);
  } finally {
    pool.close();
  }
});

test("live: close() rejects an in-flight query and a pending ready()", async () => {
  const fake = await startFakePg({ hangOnQuery: true });
  const pool = poolFor(fake, { queryTimeoutMs: 5000 });
  try {
    await pool.ready();
    const q = pool.query("SELECT 1", []);
    await new Promise((r) => setTimeout(r, 50));
    pool.close();
    const r = await settleWithin(q, 1000);
    assert.ok(r.rejected, "the in-flight query must not stay pending");
    assert.match(r.rejected.message, /closed/);
  } finally {
    pool.close();
    await fake.close();
  }
  const hung = await startFakePg({ hangConnection: 1 });
  const pool2 = poolFor(hung, { connectTimeoutMs: 5000 });
  try {
    const ready = pool2.ready();
    await new Promise((r) => setTimeout(r, 50));
    pool2.close();
    const r = await settleWithin(ready, 1000);
    assert.ok(r.rejected, "ready() must not stay pending across close()");
    assert.match(r.rejected.message, /closed/);
    assert.equal(hung.connectionCount, 1, "close() spawned no new dial");
  } finally {
    await hung.close();
  }
});

test("live: ready() waits out a failed dial that a queued query immediately re-dials", async () => {
  // max=1, first handshake black-holed: health goes connecting>idle>connecting>ready.
  // The transient idle edge is not "nothing is warming", so ready() must resolve.
  const fake = await startFakePg({ hangConnection: 1 });
  const pool = poolFor(fake, { max: 1, connectTimeoutMs: 200, queryTimeoutMs: 3000 });
  try {
    const q1 = pool.query("SELECT $1", ["1"]);
    const ready = pool.ready();
    const q2 = pool.query("SELECT $1", ["2"]);
    await assert.rejects(q1, /connect timeout/);
    const r = await settleWithin(ready, 2000);
    assert.ok(!r.rejected, `ready() rejected: ${r.rejected && r.rejected.message}`);
    assert.ok("resolved" in r, "ready() must not stay pending");
    assert.deepEqual(await q2, [{ p0: "2" }]);
  } finally {
    pool.close();
    await fake.close();
  }
});
