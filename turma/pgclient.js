// A stdlib-only Postgres wire-protocol client + connection pool (XERK-776, epic
// XERK-751/XERK-775). The spine the two Postgres of-record backends plug into: a
// LedgerStore (the durable usage ledger, "the only copy of a year of spend") and
// an IndexStore (the archive search index), both wave-2 children that flip a
// server.js call site onto this — NOT here (this ticket lands the client alone,
// wires no consumer).
//
// stdlib ONLY — the hub ships no node_modules (the XERK-754 stance; `node --test`,
// offline CI). So this is a hand-rolled Postgres v3 frontend/backend protocol over
// node:net / node:tls, exactly the discipline store.js's RESP2 codec and
// blobstore.js's SigV4 signer already follow: the message CODEC (encode/decode of
// every message type used) is the PURE, unit-tested core; the live socket path is
// exercised in CI against a LOCAL protocol fake and against a REAL Postgres only in
// host QA (the SharedLiveStore/S3BlobStore posture).
//
// What it speaks:
//   - StartupMessage / SSLRequest (TLS negotiation for postgres://).
//   - SASL/SCRAM-SHA-256 authentication (the CloudNativePG default), plus the
//     cheap legacy fallbacks (cleartext, MD5) so a differently-configured cluster
//     still connects.
//   - The extended Parse/Bind/Describe/Execute/Sync flow for PARAMETERIZED
//     statements (so no value is ever interpolated into SQL), and simple Query.
//   - RowDescription/DataRow decode (text format), CommandComplete, ErrorResponse/
//     NoticeResponse, ReadyForQuery, graceful Terminate.
//
// The contract: `query(text, params) -> rows` and `upsertGreatest(...)` — the
// parameterized INSERT … ON CONFLICT … DO UPDATE SET col = GREATEST(t.col,
// EXCLUDED.col) the ledger's per-host high-water needs (a low/partial writer can
// never lower a recorded total — the same max-merge semantics the Valkey ledger
// backend uses today, so a PG LedgerStore is a drop-in of-record).
//
// `createPgClient(haConfig)` returns null when HA is off (or the config is fatal),
// so nothing is wired in single-process and the non-HA path is byte-identical.

"use strict";

const net = require("net");
const tls = require("tls");
const crypto = require("crypto");
const { URL } = require("url");
const { EventEmitter } = require("events");

// The v3 protocol version (3.0), and the magic Int32 that turns a startup packet
// into an SSLRequest. Both are wire constants.
const PROTOCOL_VERSION = 196608; // (3 << 16) | 0
const SSL_REQUEST_CODE = 80877103; // 1234 << 16 | 5679

// ============================================================================
// Byte writer — a tiny growable buffer for building frontend messages. Pure.
// ============================================================================

class ByteWriter {
  constructor() {
    this._chunks = [];
  }
  int8(n) {
    const b = Buffer.allocUnsafe(1);
    b.writeUInt8(n & 0xff, 0);
    this._chunks.push(b);
    return this;
  }
  int16(n) {
    const b = Buffer.allocUnsafe(2);
    b.writeInt16BE(n, 0);
    this._chunks.push(b);
    return this;
  }
  int32(n) {
    const b = Buffer.allocUnsafe(4);
    b.writeInt32BE(n, 0);
    this._chunks.push(b);
    return this;
  }
  // A C string: UTF-8 bytes followed by a NUL terminator.
  cstring(s) {
    this._chunks.push(Buffer.from(String(s), "utf8"), Buffer.from([0]));
    return this;
  }
  bytes(buf) {
    this._chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    return this;
  }
  build() {
    return Buffer.concat(this._chunks);
  }
}

// Frame a typed frontend message: a 1-byte type, then Int32 length (which INCLUDES
// the 4 length bytes but NOT the type byte), then the body. This is the whole
// framing rule for every frontend message except Startup/SSLRequest (which carry
// no type byte).
function frameMessage(type, body) {
  body = body || Buffer.alloc(0);
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(type.charCodeAt(0), 0);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

// ============================================================================
// Frontend message encoders — pure, exported for unit tests.
// ============================================================================

// StartupMessage: Int32 length, Int32 protocol, then cstring key/value pairs, a
// final NUL. No type byte. `params` MUST include `user`; `database` is usual.
function encodeStartupMessage(params) {
  const w = new ByteWriter().int32(PROTOCOL_VERSION);
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    w.cstring(k).cstring(v);
  }
  w.int8(0); // terminating NUL for the parameter list
  const body = w.build();
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeInt32BE(4 + body.length, 0);
  body.copy(out, 4);
  return out;
}

// SSLRequest: Int32 length (8), Int32 magic. No type byte. The server answers with
// a SINGLE byte 'S' (proceed with TLS) or 'N' (plaintext).
function encodeSSLRequest() {
  const out = Buffer.allocUnsafe(8);
  out.writeInt32BE(8, 0);
  out.writeInt32BE(SSL_REQUEST_CODE, 4);
  return out;
}

// Simple Query ('Q'): one cstring of SQL. Returns rows without the extended flow;
// used for statements with no parameters (schema DDL at boot, say).
function encodeQuery(sql) {
  return frameMessage("Q", new ByteWriter().cstring(sql).build());
}

// Parse ('P'): name (unnamed ''), the SQL, and Int16 param-type count 0 — we send
// no type OIDs so the server INFERS every parameter's type from its use, which is
// what lets a caller pass plain JS values as text.
function encodeParse(sql, name = "") {
  return frameMessage("P", new ByteWriter().cstring(name).cstring(sql).int16(0).build());
}

// Bind ('B'): portal (''), statement (''), then param formats, param values,
// result formats. We use ZERO format codes on both sides, which the protocol reads
// as "all text" — so every value goes out as its text representation and every
// column comes back as text (decoded UTF-8 by parseDataRow's caller).
function encodeBind(values, { portal = "", statement = "" } = {}) {
  const w = new ByteWriter().cstring(portal).cstring(statement);
  w.int16(0); // 0 param format codes -> all text
  w.int16(values.length);
  for (const v of values) {
    if (v == null) {
      w.int32(-1); // SQL NULL
    } else {
      const buf = Buffer.isBuffer(v) ? v : Buffer.from(paramText(v), "utf8");
      w.int32(buf.length).bytes(buf);
    }
  }
  w.int16(0); // 0 result format codes -> all text
  return frameMessage("B", w.build());
}

// The text rendering of a bound parameter. Booleans become Postgres's 't'/'f';
// everything else is String(). null is handled by the caller (length -1).
function paramText(v) {
  if (typeof v === "boolean") return v ? "t" : "f";
  return String(v);
}

// Describe ('D'): 'S' a statement or 'P' a portal, then its name. Describing the
// portal is what makes the server send the RowDescription for the result columns.
function encodeDescribe(kind, name = "") {
  return frameMessage("D", new ByteWriter().int8(kind.charCodeAt(0)).cstring(name).build());
}

// Execute ('E'): portal name, then Int32 max rows (0 = all).
function encodeExecute(portal = "", maxRows = 0) {
  return frameMessage("E", new ByteWriter().cstring(portal).int32(maxRows).build());
}

function encodeSync() {
  return frameMessage("S");
}

function encodeTerminate() {
  return frameMessage("X");
}

// SASLInitialResponse ('p'): the mechanism name, then Int32 length of the initial
// response, then the client-first-message bytes.
function encodeSASLInitialResponse(mechanism, clientFirstMessage) {
  const data = Buffer.from(clientFirstMessage, "utf8");
  const w = new ByteWriter().cstring(mechanism).int32(data.length).bytes(data);
  return frameMessage("p", w.build());
}

// SASLResponse ('p'): just the mechanism data (client-final-message); the message
// length frames it.
function encodeSASLResponse(clientFinalMessage) {
  return frameMessage("p", Buffer.from(clientFinalMessage, "utf8"));
}

// PasswordMessage ('p'): a cstring password (cleartext, or the md5 digest form).
function encodePasswordMessage(password) {
  return frameMessage("p", new ByteWriter().cstring(password).build());
}

// ============================================================================
// Backend message reader — incremental, tolerant of a message split across any
// number of socket chunks (a large DataRow, a deep result). Pure, like RespParser.
// ============================================================================
//
// Every backend message is: 1 type byte, Int32 length (INCLUDES the 4 length
// bytes, EXCLUDES the type byte), then (length - 4) body bytes. `feed(chunk)`
// returns the array of complete {type, body} messages decodable so far and holds
// any partial tail for the next chunk.
// A backend message's declared length is checked against this the moment its
// 5-byte header is in hand (BEFORE the body is buffered), so a hostile/desynced
// server declaring a huge length can never make `feed` accumulate unbounded memory
// — it throws at the declaration and the connection layer resets. Generous: far
// above any real ledger/index row, so it never refuses a legitimate message.
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

class PgProtocolReader {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    let offset = 0;
    for (;;) {
      if (this.buf.length - offset < 5) break; // need type + length
      const type = String.fromCharCode(this.buf[offset]);
      const len = this.buf.readInt32BE(offset + 1);
      // A length below 4 is a protocol desync (the length covers its own 4 bytes),
      // not a value — surface it so the connection layer resets rather than looping.
      if (len < 4) throw new Error(`bad message length ${len} for type ${JSON.stringify(type)}`);
      if (len - 4 > MAX_MESSAGE_BYTES) {
        throw new Error(`backend message length ${len} exceeds the ${MAX_MESSAGE_BYTES}-byte cap`);
      }
      const total = 1 + len; // type byte + declared length
      if (this.buf.length - offset < total) break; // body not all here yet
      const body = this.buf.subarray(offset + 5, offset + total);
      // Copy the body out so a subarray view doesn't pin the whole concat alive.
      out.push({ type, body: Buffer.from(body) });
      offset += total;
    }
    this.buf = offset > 0 ? Buffer.from(this.buf.subarray(offset)) : this.buf;
    return out;
  }
}

// ---- A cursor over a message body, for the decoders below. ------------------
class ByteReader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  int8() {
    return this.buf.readUInt8(this.pos++);
  }
  int16() {
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  int32() {
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  cstring() {
    const end = this.buf.indexOf(0, this.pos);
    const s = this.buf.toString("utf8", this.pos, end < 0 ? this.buf.length : end);
    this.pos = end < 0 ? this.buf.length : end + 1;
    return s;
  }
  bytes(n) {
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  remaining() {
    return this.buf.subarray(this.pos);
  }
}

// ============================================================================
// Backend message decoders — pure, exported for unit tests.
// ============================================================================

// Authentication ('R'): an Int32 sub-code selects the flavour.
function parseAuthentication(body) {
  const r = new ByteReader(body);
  const code = r.int32();
  switch (code) {
    case 0:
      return { name: "ok" };
    case 3:
      return { name: "cleartext" };
    case 5:
      return { name: "md5", salt: Buffer.from(r.bytes(4)) };
    case 10: {
      // AuthenticationSASL: a NUL-terminated list of mechanism names, ended by an
      // empty string (a lone NUL).
      const mechanisms = [];
      for (;;) {
        const m = r.cstring();
        if (m === "") break;
        mechanisms.push(m);
      }
      return { name: "sasl", mechanisms };
    }
    case 11:
      return { name: "sasl-continue", data: r.remaining().toString("utf8") };
    case 12:
      return { name: "sasl-final", data: r.remaining().toString("utf8") };
    default:
      return { name: "unsupported", code };
  }
}

// RowDescription ('T'): Int16 field count, then per field: name, table OID, column
// attr, type OID, type length, type modifier, format code.
function parseRowDescription(body) {
  const r = new ByteReader(body);
  const count = r.int16();
  const fields = [];
  for (let i = 0; i < count; i++) {
    fields.push({
      name: r.cstring(),
      tableOid: r.int32(),
      columnAttr: r.int16(),
      typeOid: r.int32(),
      typeLen: r.int16(),
      typeMod: r.int32(),
      format: r.int16(),
    });
  }
  return fields;
}

// DataRow ('D'): Int16 column count, then per column Int32 length (-1 = NULL) and
// that many bytes. Returns an array of Buffer|null — the caller decodes text.
function parseDataRow(body) {
  const r = new ByteReader(body);
  const count = r.int16();
  const cols = [];
  for (let i = 0; i < count; i++) {
    const len = r.int32();
    if (len === -1) cols.push(null);
    else cols.push(Buffer.from(r.bytes(len)));
  }
  return cols;
}

// ErrorResponse ('E') / NoticeResponse ('N'): a sequence of (Int8 field type,
// cstring value), terminated by a 0 field type. Returns a map keyed by the field
// type char (S severity, C SQLSTATE code, M message, D detail, …) plus a `.message`
// convenience combining the human fields.
function parseNoticeFields(body) {
  const r = new ByteReader(body);
  const fields = {};
  for (;;) {
    const t = r.int8();
    if (t === 0) break;
    fields[String.fromCharCode(t)] = r.cstring();
  }
  const parts = [fields.S, fields.C ? `(${fields.C})` : null, fields.M].filter(Boolean);
  fields.message = parts.join(" ") || "postgres error";
  return fields;
}

// CommandComplete ('C'): a cstring tag like "INSERT 0 1" / "UPDATE 2" / "SELECT 3".
// The affected/returned row count is the LAST integer token.
function parseCommandComplete(body) {
  const tag = new ByteReader(body).cstring();
  const m = /(\d+)\s*$/.exec(tag);
  return { tag, rowCount: m ? Number(m[1]) : null };
}

// ReadyForQuery ('Z'): a single status byte — 'I' idle, 'T' in a transaction, 'E'
// in a failed transaction.
function parseReadyForQuery(body) {
  return { status: String.fromCharCode(body[0]) };
}

// ============================================================================
// SCRAM-SHA-256 — the pure crypto core, exported for the RFC-7677 test vector.
// ============================================================================

// Parse a server-first-message ("r=<nonce>,s=<b64 salt>,i=<iters>") into its
// attributes.
function parseScramServerFirst(s) {
  const attrs = {};
  for (const kv of s.split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) attrs[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return {
    nonce: attrs.r,
    salt: attrs.s ? Buffer.from(attrs.s, "base64") : null,
    iterations: Number(attrs.i),
  };
}

// Given the password, the client-first-message-bare (`n=<user>,r=<nonce>`) and the
// raw server-first-message, compute the client-final-message (with proof) and the
// server signature we must see back. PURE — no channel binding (SCRAM-SHA-256, not
// -PLUS, which is what Postgres uses over TLS), so the GS2 header is "n,," and the
// client-final channel-binding attribute is the fixed `c=biws` (base64 of "n,,").
// Pinned to RFC 7677's vector in the test.
function scramClientProof(password, clientFirstBare, serverFirstMessage) {
  const { nonce, salt, iterations } = parseScramServerFirst(serverFirstMessage);
  const saltedPassword = crypto.pbkdf2Sync(Buffer.from(String(password), "utf8"), salt, iterations, 32, "sha256");
  const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
  const clientKey = hmac(saltedPassword, "Client Key");
  const storedKey = crypto.createHash("sha256").update(clientKey).digest();
  const clientFinalWithoutProof = "c=biws,r=" + nonce;
  const authMessage = `${clientFirstBare},${serverFirstMessage},${clientFinalWithoutProof}`;
  const clientSignature = hmac(storedKey, authMessage);
  const proof = Buffer.alloc(clientKey.length);
  for (let i = 0; i < clientKey.length; i++) proof[i] = clientKey[i] ^ clientSignature[i];
  const serverKey = hmac(saltedPassword, "Server Key");
  const serverSignature = hmac(serverKey, authMessage);
  return {
    clientFinalMessage: `${clientFinalWithoutProof},p=${proof.toString("base64")}`,
    serverSignature: serverSignature.toString("base64"),
    combinedNonce: nonce,
  };
}

// The md5 auth response: "md5" + md5( md5(password + user) + salt ). Legacy, kept
// as a cheap fallback next to SCRAM.
function md5AuthResponse(user, password, salt) {
  const md5 = (d) => crypto.createHash("md5").update(d).digest("hex");
  const inner = md5(Buffer.concat([Buffer.from(String(password) + String(user), "utf8")]));
  return "md5" + md5(Buffer.concat([Buffer.from(inner, "utf8"), salt]));
}

// ============================================================================
// The parameterized GREATEST upsert SQL builder — pure, exported for tests.
// ============================================================================

// A Postgres identifier we are willing to embed in SQL. Table/column names here
// come from the hub's OWN code, never user input — but we validate anyway (only
// [A-Za-z_][A-Za-z0-9_]*) and double-quote, so a typo fails loudly rather than
// opening an injection seam if a future caller gets careless. Values NEVER go
// here; they are always bound parameters ($1,$2,…).
function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe SQL identifier ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

// Build `INSERT INTO t (cols…) VALUES ($1…) ON CONFLICT (keys…) DO UPDATE SET …`,
// where each column in `greatest` is set to GREATEST(t.col, EXCLUDED.col) — the
// monotonic high-water merge — and every other value column is set to EXCLUDED.col
// (a plain overwrite). Returns { text, params } with params in the INSERT column
// order (keys first, then values), so a low/partial writer can never lower a
// recorded total. `keys` and `values` are {col: value} objects.
function buildUpsertGreatest({ table, keys, values, greatest = [] }) {
  const keyCols = Object.keys(keys || {});
  const valCols = Object.keys(values || {});
  if (keyCols.length === 0) throw new Error("upsertGreatest: at least one conflict key required");
  const allCols = [...keyCols, ...valCols];
  const params = [...keyCols.map((c) => keys[c]), ...valCols.map((c) => values[c])];
  const greatestSet = new Set(greatest);
  const t = quoteIdent(table);

  const colList = allCols.map(quoteIdent).join(", ");
  const placeholders = allCols.map((_, i) => `$${i + 1}`).join(", ");
  const conflict = keyCols.map(quoteIdent).join(", ");

  let text;
  if (valCols.length === 0) {
    // Nothing to update on conflict — just don't clobber the existing row.
    text = `INSERT INTO ${t} (${colList}) VALUES (${placeholders}) ON CONFLICT (${conflict}) DO NOTHING`;
  } else {
    const assignments = valCols
      .map((c) => {
        const q = quoteIdent(c);
        return greatestSet.has(c)
          ? `${q} = GREATEST(${t}.${q}, EXCLUDED.${q})`
          : `${q} = EXCLUDED.${q}`;
      })
      .join(", ");
    text = `INSERT INTO ${t} (${colList}) VALUES (${placeholders}) ON CONFLICT (${conflict}) DO UPDATE SET ${assignments}`;
  }
  return { text, params };
}

// ============================================================================
// PgConnection — one socket's lifecycle: SSL negotiation, startup, auth, and a
// single-in-flight request/response model (the pool serialises one query per
// connection). Host-QA against a real Postgres; CI drives it over a local fake.
// ============================================================================

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_QUERY_TIMEOUT_MS = 30000;

class PgConnection {
  constructor(cfg) {
    this.cfg = cfg; // {host,port,user,password,database,sslmode,applicationName}
    this.socket = null;
    this.reader = new PgProtocolReader();
    this.alive = false; // ready to take a query
    this.busy = false; // held by a caller
    this._connectTimer = null;
    // Handshake resolvers.
    this._onReady = null;
    this._onFail = null;
    // In-flight query state.
    this._q = null; // { resolve, reject, fields, rows, command, rowCount, timer, error }
    // SCRAM in-flight state.
    this._scram = null; // { clientNonce, clientFirstBare, expectedServerSignature }
  }

  // Dial, negotiate SSL, send startup, run auth. Resolves once ReadyForQuery lands.
  connect() {
    return new Promise((resolve, reject) => {
      this._onReady = resolve;
      this._onFail = (e) => {
        this._teardown();
        reject(e);
      };
      this._connectTimer = setTimeout(
        () => this._onFail && this._onFail(new Error("postgres connect timeout")),
        this.cfg.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS
      );
      this._connectTimer.unref?.();
      this._dial();
    });
  }

  _dial() {
    const plain = net.connect({ host: this.cfg.host, port: this.cfg.port });
    plain.on("error", (e) => this._fail(e));
    if (this.cfg.sslmode === "disable") {
      plain.on("connect", () => {
        this.socket = plain;
        this._wireSocket();
        this._sendStartup();
      });
      return;
    }
    // SSLRequest first: read exactly one byte, then upgrade or continue.
    plain.on("connect", () => plain.write(encodeSSLRequest()));
    const onFirst = (chunk) => {
      plain.removeListener("data", onFirst);
      const answer = String.fromCharCode(chunk[0]);
      if (answer === "S") {
        const secure = tls.connect(
          {
            socket: plain,
            servername: this.cfg.host,
            // In-cluster CNPG typically presents a cert signed by its own CA that
            // the hub does not carry, so `require` means channel ENCRYPTION, not
            // peer verification (what an app-to-CNPG connection does without a CA
            // wired). `verify-full` would need the CA; documented in the rules.
            rejectUnauthorized: this.cfg.sslmode === "verify-full",
          },
          () => {
            this.socket = secure;
            this._wireSocket();
            this._sendStartup();
          }
        );
        secure.on("error", (e) => this._fail(e));
      } else if (answer === "N") {
        if (this.cfg.sslmode === "require" || this.cfg.sslmode === "verify-full") {
          this._fail(new Error("postgres server refused SSL but sslmode requires it"));
          return;
        }
        this.socket = plain;
        this._wireSocket();
        this._sendStartup();
      } else {
        this._fail(new Error(`unexpected SSLRequest reply byte ${JSON.stringify(answer)}`));
      }
    };
    plain.on("data", onFirst);
  }

  _wireSocket() {
    this.socket.on("data", (chunk) => this._onData(chunk));
    this.socket.on("error", (e) => this._fail(e));
    this.socket.on("close", () => this._fail(new Error("postgres connection closed")));
  }

  _sendStartup() {
    const params = {
      user: this.cfg.user,
      database: this.cfg.database || this.cfg.user,
      application_name: this.cfg.applicationName || "turma-hub",
      client_encoding: "UTF8",
    };
    this._write(encodeStartupMessage(params));
  }

  _write(buf) {
    try {
      this.socket.write(buf);
    } catch (e) {
      this._fail(e);
    }
  }

  _onData(chunk) {
    let messages;
    try {
      messages = this.reader.feed(chunk);
    } catch (e) {
      this._fail(e);
      return;
    }
    for (const { type, body } of messages) {
      try {
        this._onMessage(type, body);
      } catch (e) {
        // A decoder threw on a malformed/truncated body (a body lying about its
        // field/column count, a NUL-less notice, a short auth packet) — a protocol
        // desync we can't recover from. Route it to _fail exactly as the reader's
        // own corrupt-length case does; NEVER let it escape this socket 'data'
        // handler to become an uncaughtException that takes the whole hub down
        // (the XERK-235 class). The in-flight query rejects and the socket resets.
        this._fail(e);
        return;
      }
    }
  }

  _onMessage(type, body) {
    switch (type) {
      case "R":
        this._onAuth(parseAuthentication(body));
        return;
      case "S": // ParameterStatus (name/value) — server settings; ignored.
        return;
      case "K": // BackendKeyData — for query cancellation; we don't cancel, ignore.
        return;
      case "Z": {
        // ReadyForQuery: either the handshake completing, or a query's terminator.
        if (!this.alive) {
          this.alive = true;
          if (this._connectTimer) clearTimeout(this._connectTimer);
          const ready = this._onReady;
          this._onReady = this._onFail = null;
          ready && ready();
        } else if (this._q) {
          this._finishQuery();
        }
        return;
      }
      case "T":
        if (this._q) this._q.fields = parseRowDescription(body);
        return;
      case "D":
        if (this._q) this._appendRow(parseDataRow(body));
        return;
      case "C":
        if (this._q) {
          const cc = parseCommandComplete(body);
          this._q.command = cc.tag.split(" ")[0];
          this._q.rowCount = cc.rowCount;
        }
        return;
      case "E": {
        // ErrorResponse. During the handshake it fails the connect; during a query
        // it fails that query (the server still sends ReadyForQuery after, which
        // _finishQuery is a no-op for once the error is set).
        const fields = parseNoticeFields(body);
        const err = new Error("postgres: " + fields.message);
        err.pgError = fields;
        if (!this.alive) this._fail(err);
        else if (this._q) this._q.error = err;
        return;
      }
      case "N": // NoticeResponse — informational; do not fail anything.
        return;
      case "A": // NotificationResponse (LISTEN/NOTIFY) — unused.
      case "1": // ParseComplete
      case "2": // BindComplete
      case "3": // CloseComplete
      case "n": // NoData (a statement returning no rows)
      case "s": // PortalSuspended (we never set a row cap, so unexpected but benign)
      case "I": // EmptyQueryResponse
        return;
      default:
        // An unknown type mid-stream is a desync we can't recover from.
        this._fail(new Error(`unexpected backend message type ${JSON.stringify(type)}`));
    }
  }

  _onAuth(auth) {
    switch (auth.name) {
      case "ok":
        return; // ReadyForQuery follows and completes the handshake.
      case "cleartext":
        this._write(encodePasswordMessage(this.cfg.password || ""));
        return;
      case "md5":
        this._write(encodePasswordMessage(md5AuthResponse(this.cfg.user, this.cfg.password || "", auth.salt)));
        return;
      case "sasl": {
        if (!auth.mechanisms.includes("SCRAM-SHA-256")) {
          this._fail(new Error(`no supported SASL mechanism in ${JSON.stringify(auth.mechanisms)}`));
          return;
        }
        const clientNonce = crypto.randomBytes(18).toString("base64");
        // Postgres takes the username from the startup packet, so SCRAM's own
        // username field is empty: client-first-bare is `n=,r=<nonce>`.
        const clientFirstBare = `n=,r=${clientNonce}`;
        this._scram = { clientNonce, clientFirstBare };
        this._write(encodeSASLInitialResponse("SCRAM-SHA-256", `n,,${clientFirstBare}`));
        return;
      }
      case "sasl-continue": {
        const serverFirst = auth.data;
        const parsed = parseScramServerFirst(serverFirst);
        // The server nonce MUST extend the one we sent — otherwise a MITM could
        // replay a foreign challenge.
        if (!parsed.nonce || !parsed.nonce.startsWith(this._scram.clientNonce)) {
          this._fail(new Error("SCRAM server nonce does not match client nonce"));
          return;
        }
        const { clientFinalMessage, serverSignature } = scramClientProof(
          this.cfg.password || "",
          this._scram.clientFirstBare,
          serverFirst
        );
        this._scram.expectedServerSignature = serverSignature;
        this._write(encodeSASLResponse(clientFinalMessage));
        return;
      }
      case "sasl-final": {
        // v=<b64 server signature>. Verify the server proved knowledge of the
        // password too (mutual auth) before we trust the connection.
        const got = /(?:^|,)v=([^,]+)/.exec(auth.data);
        if (!got || got[1] !== this._scram.expectedServerSignature) {
          this._fail(new Error("SCRAM server signature mismatch"));
          return;
        }
        this._scram = null;
        return; // AuthenticationOk + ReadyForQuery follow.
      }
      default:
        this._fail(new Error(`unsupported authentication request ${JSON.stringify(auth)}`));
    }
  }

  _appendRow(cols) {
    const fields = this._q.fields || [];
    const row = {};
    for (let i = 0; i < cols.length; i++) {
      const name = fields[i] ? fields[i].name : `col${i}`;
      row[name] = cols[i] == null ? null : cols[i].toString("utf8");
    }
    this._q.rows.push(row);
  }

  // Run one parameterized statement via the extended protocol. `sql` with `params`
  // goes out as Parse/Bind/Describe/Execute/Sync in one write; the reply is
  // gathered until ReadyForQuery. Resolves { rows, command, rowCount }.
  query(sql, params = [], timeoutMs = DEFAULT_QUERY_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.alive) {
        reject(new Error("postgres connection not ready"));
        return;
      }
      if (this._q) {
        reject(new Error("postgres connection already has a query in flight"));
        return;
      }
      const timer = setTimeout(() => {
        // A timed-out query poisons the connection (we can't tell where in the
        // reply stream we are), so we fail it AND tear the socket down — the pool
        // discards it and a later acquire makes a fresh one.
        const q = this._q;
        this._q = null;
        if (q) q.reject(new Error("postgres query timeout"));
        this._teardown();
      }, timeoutMs);
      timer.unref?.();
      this._q = { resolve, reject, fields: null, rows: [], command: null, rowCount: null, timer, error: null };
      const batch = Buffer.concat([
        encodeParse(sql),
        encodeBind(params),
        encodeDescribe("P"),
        encodeExecute(),
        encodeSync(),
      ]);
      this._write(batch);
    });
  }

  _finishQuery() {
    const q = this._q;
    this._q = null;
    if (!q) return;
    if (q.timer) clearTimeout(q.timer);
    if (q.error) q.reject(q.error);
    else q.resolve({ rows: q.rows, command: q.command, rowCount: q.rowCount });
  }

  // A fatal socket/protocol failure: fail the handshake or the in-flight query,
  // mark dead, and tear the socket down. Idempotent.
  _fail(err) {
    if (this._onFail) {
      const fail = this._onFail;
      this._onReady = this._onFail = null;
      fail(err);
      return;
    }
    if (this._q) {
      const q = this._q;
      this._q = null;
      if (q.timer) clearTimeout(q.timer);
      q.reject(err);
    }
    this._teardown();
  }

  _teardown() {
    this.alive = false;
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.destroy();
      } catch {
        /* best effort */
      }
      this.socket = null;
    }
  }

  // Graceful close: send Terminate then destroy.
  close() {
    if (this.socket && this.alive) {
      try {
        this.socket.write(encodeTerminate());
      } catch {
        /* best effort */
      }
    }
    this._teardown();
  }
}

// ============================================================================
// PgPool — a bounded set of reusable connections with a waiter queue, one query
// per connection at a time, health reporting, and per-query timeout. Mirrors
// SharedLiveStore's socket-lifecycle posture: fail narrow, reconnect lazily (a
// dead connection is discarded and the next acquire makes a fresh one).
// ============================================================================

const DEFAULT_MAX_CONNS = 4;

class PgPool {
  /**
   * @param {object} haConfig  resolveHaConfig(env) — reads `databaseUrl`.
   * @param {object} [opts] { max, queryTimeoutMs, connectTimeoutMs, connect }
   */
  constructor(haConfig, opts = {}) {
    this.kind = "postgres";
    this.cfg = parsePgUrl(haConfig.databaseUrl);
    this.cfg.connectTimeoutMs = opts.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
    this.max = Math.max(1, opts.max || DEFAULT_MAX_CONNS);
    this.queryTimeoutMs = opts.queryTimeoutMs || DEFAULT_QUERY_TIMEOUT_MS;
    this._conns = [];
    this._waiters = [];
    this._closed = false;
    this._emitter = new EventEmitter();
    this._health = "idle";
    if (opts.connect) this._spawnConn(); // eager warm-up (optional)
  }

  get health() {
    if (this._closed) return "closed";
    if (this._conns.some((c) => c.alive)) return "ready";
    if (this._conns.length > 0) return "connecting";
    return "idle";
  }

  onHealth(cb) {
    this._emitter.on("health", cb);
    return () => this._emitter.off("health", cb);
  }

  _setHealth() {
    const h = this.health;
    if (h === this._health) return;
    this._health = h;
    this._emitter.emit("health", h);
  }

  // The public contract: run a parameterized statement, return the ROWS.
  async query(text, params = []) {
    const conn = await this._acquire();
    try {
      const res = await conn.query(text, params, this.queryTimeoutMs);
      return res.rows;
    } finally {
      this._afterQuery(conn);
    }
  }

  // Like query but returns the full result (rows + command + rowCount) — used by
  // upsertGreatest for the affected-row count.
  async execute(text, params = []) {
    const conn = await this._acquire();
    try {
      return await conn.query(text, params, this.queryTimeoutMs);
    } finally {
      this._afterQuery(conn);
    }
  }

  // The parameterized GREATEST high-water upsert the ledger needs. Returns the
  // affected row count.
  async upsertGreatest(spec) {
    const { text, params } = buildUpsertGreatest(spec);
    const res = await this.execute(text, params);
    return res.rowCount;
  }

  _acquire() {
    if (this._closed) return Promise.reject(new Error("postgres pool closed"));
    return new Promise((resolve, reject) => {
      this._waiters.push({ resolve, reject });
      this._pump();
    });
  }

  _pump() {
    while (this._waiters.length) {
      const idle = this._conns.find((c) => c.alive && !c.busy);
      if (idle) {
        idle.busy = true;
        this._waiters.shift().resolve(idle);
        continue;
      }
      if (this._conns.length < this.max) {
        this._spawnConn();
        return; // it will _pump() again on ready
      }
      return; // all busy — the waiter waits for a release
    }
  }

  _spawnConn() {
    const conn = new PgConnection(this.cfg);
    this._conns.push(conn);
    this._setHealth();
    conn
      .connect()
      .then(() => {
        this._setHealth();
        this._pump();
      })
      .catch((e) => {
        this._removeConn(conn);
        // A connect failure is surfaced to ONE waiting caller (fail-narrow); the
        // others retry via _pump, which may spawn again.
        const w = this._waiters.shift();
        if (w) w.reject(e);
        this._pump();
      });
  }

  _removeConn(conn) {
    const i = this._conns.indexOf(conn);
    if (i >= 0) this._conns.splice(i, 1);
    this._setHealth();
  }

  _afterQuery(conn) {
    if (conn.alive) {
      // Reusable: hand it to the next waiter or park it idle.
      conn.busy = false;
      this._pump();
    } else {
      // Poisoned by an error/timeout — drop it; a later acquire spawns a fresh one.
      this._removeConn(conn);
      this._pump();
    }
  }

  async ready() {
    if (this.health === "ready") return;
    await new Promise((resolve, reject) => {
      if (this._closed) return reject(new Error("postgres pool closed"));
      const off = this.onHealth((h) => {
        if (h === "ready") {
          off();
          resolve();
        }
      });
      // Kick a connection if none is warming.
      if (this._conns.length === 0) this._spawnConn();
    });
  }

  close() {
    this._closed = true;
    for (const w of this._waiters.splice(0)) w.reject(new Error("postgres pool closed"));
    for (const conn of this._conns.splice(0)) conn.close();
    this._setHealth();
  }
}

// Parse a postgres:// URL into the connection config. sslmode defaults to
// "prefer" (try SSL, fall back to plaintext) — the libpq default — so an operator
// need only set `?sslmode=require` (or `disable`) to change it.
function parsePgUrl(raw) {
  const u = new URL(raw);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  return {
    host: u.hostname,
    port: Number(u.port) || 5432,
    user: u.username ? decodeURIComponent(u.username) : "postgres",
    password: u.password ? decodeURIComponent(u.password) : "",
    database: db || null,
    sslmode: (u.searchParams.get("sslmode") || "prefer").toLowerCase(),
    applicationName: u.searchParams.get("application_name") || "turma-hub",
  };
}

// ============================================================================
// Factory — the ONE place the HA toggle decides whether Postgres exists.
// ============================================================================

/**
 * Build the Postgres pool for the resolved HA config, or null when HA is off (or
 * the config is fatal / DATABASE_URL absent) — so nothing is wired single-process
 * and the non-HA path is byte-identical. ha-config has ALREADY validated the URL
 * scheme (all-or-nothing, fail-loud at boot), but guard anyway.
 * @param {object} haConfig  result of resolveHaConfig(env)
 * @param {object} [opts]     { max, queryTimeoutMs, connectTimeoutMs, connect }
 * @returns {PgPool|null}
 */
function createPgClient(haConfig, opts = {}) {
  if (!haConfig || !haConfig.ha || !haConfig.databaseUrl) return null;
  if (Array.isArray(haConfig.fatal) && haConfig.fatal.length) return null;
  return new PgPool(haConfig, opts);
}

module.exports = {
  createPgClient,
  PgPool,
  PgConnection,
  parsePgUrl,
  // Pure codec + crypto core, exported for the unit tests.
  ByteWriter,
  PgProtocolReader,
  frameMessage,
  encodeStartupMessage,
  encodeSSLRequest,
  encodeQuery,
  encodeParse,
  encodeBind,
  encodeDescribe,
  encodeExecute,
  encodeSync,
  encodeTerminate,
  encodeSASLInitialResponse,
  encodeSASLResponse,
  encodePasswordMessage,
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
};
