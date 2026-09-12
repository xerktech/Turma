---
paths:
  - turma/pgclient.js
  - turma/tests/pgclient.test.js
---

# The stdlib Postgres client (`turma/pgclient.js`, XERK-776)

The spine the two Postgres of-record backends plug into — a **LedgerStore** (the durable usage
ledger, "the only copy of a year of spend") and an **IndexStore** (the archive search index) — both
wave-2 children of epic XERK-775 (finish Option-3 active-active). **Read `docs/turma-ha-store-adr.md`
first** (Postgres is designated the durable of-record) and `CLAUDE.md`'s stdlib-only + HA-off-is-
byte-identical + no-work-on-the-beat invariants. This file is the operative rules for the client.

## What XERK-776 landed, and what consumes it now

- **Landed by XERK-776:** the Postgres v3 wire client (`PgConnection`), a bounded reusable-connection
  pool (`PgPool`), the `createPgClient(haConfig)` factory, and the tests. That ticket wired NO consumer.
- **CONSUMERS:** the archive INDEX of-record (`index-store.js`, XERK-780/w2-index) is wired onto this
  pool — `INDEX_BACKEND_WIRED = true`, the boot line reads `index=postgres`. The usage ledger is NOT
  yet (`LEDGER_BACKEND_WIRED = false` in `ha-config.js`, still Valkey — `w2-ledger`).
- **The wired flag is GRANULAR, one per backend** (XERK-773 was a single conflated flag): flip each in
  the SAME change that wires ITS backend, never ahead of it, or the boot line lies to the operator.
  Mechanics of the archive-index consumer: `.claude/rules/turma-ha-archive.md`.

## stdlib-only, like store.js and blobstore.js

- **The hub ships NO `node_modules`.** This is a hand-rolled Postgres frontend/backend v3 protocol
  over `node:net` / `node:tls` — NEVER add `pg`/`postgres`/`pg-native` (no `package.json`, `node
  --test`, offline CI). Same discipline as store.js's RESP2 codec and blobstore.js's SigV4 signer.
- **The pure CODEC is the unit-testable core; the socket path is not run in CI against a real
  backend.** Encoders (`encodeStartupMessage`, `encodeParse`/`encodeBind`/…), the incremental
  `PgProtocolReader`, the message decoders (`parseAuthentication`/`parseRowDescription`/`parseDataRow`/
  `parseNoticeFields`/`parseCommandComplete`), the SCRAM crypto, and `buildUpsertGreatest` are all
  PURE and exported. The live socket path is exercised in CI against a **LOCAL Postgres protocol fake**
  (a `net` server in the test that runs a real SCRAM handshake + the extended-query flow) and against
  a REAL Postgres only in host QA — the SharedLiveStore / S3BlobStore posture.

## Wire-protocol invariants (do not undo)

- **Message framing is asymmetric.** Every message is `Int32 length` that INCLUDES its own 4 bytes.
  Frontend messages (except two) and ALL backend messages carry a leading 1-byte type; the length
  EXCLUDES that type byte. The two exceptions — **StartupMessage and SSLRequest** — carry NO type
  byte. `frameMessage(type, body)` is the typed framer; `encodeStartupMessage`/`encodeSSLRequest` are
  the untyped ones. `PgProtocolReader.feed` needs ≥5 bytes to know a message's length and holds a
  partial tail across chunks (a DataRow can span sockets), exactly like `RespParser`.
- **A malformed backend message must NEVER escape the socket handler.** The
  `ByteReader` decoders (`parseRowDescription`/`parseDataRow`/`parseNoticeFields`/
  `parseAuthentication`) throw a `RangeError` on a body that lies about its field/column
  count or is truncated. `PgConnection._onData` wraps BOTH `reader.feed` AND the per-message
  `_onMessage` decode in try/catch and routes any throw to `_fail` (reject the in-flight query,
  reset the socket) — a hostile/desynced server (or a MITM, since `require` is encrypt-only)
  otherwise becomes an `uncaughtException` that kills the whole hub (the XERK-235 class). Do NOT
  move the decode loop back outside the try. `PgProtocolReader` also caps a message's DECLARED
  length (`MAX_MESSAGE_BYTES`, checked at the header before any body is buffered) so a bogus huge
  length can't grow the read buffer unbounded.
- **SCRAM-SHA-256 is the auth path** (the CNPG default). It is `-SHA-256`, NOT `-PLUS`, so there is NO
  channel binding: the GS2 header is `n,,` and the client-final channel-binding attribute is the fixed
  `c=biws` (base64 of `n,,`). The username in SCRAM is EMPTY (`n=,r=<nonce>`) because Postgres takes
  the user from the StartupMessage. `scramClientProof` is pinned to **RFC 7677 §3's vector** in the
  test — a future edit that breaks the proof fails there. Cleartext + MD5 auth are kept as cheap
  fallbacks for a differently-configured cluster.
- **Two mutual-auth checks are load-bearing, keep both:** the server nonce MUST start with the client
  nonce (else reject — a replayed/foreign challenge), and the server's `v=` signature MUST equal the
  one we computed (else reject — proves the server knew the password too). Removing either weakens the
  handshake to one-way trust.
- **Parameterized statements go through the extended flow** (Parse → Bind → Describe portal → Execute
  → Sync in one write), so **a value is NEVER interpolated into SQL** — it is always a bound `$n`
  parameter sent in TEXT format (0 format codes both ways). Simple `Query` ('Q') exists for
  parameter-less DDL only. Results decode as TEXT (UTF-8 strings, or null); a caller that needs a
  number/bigint parses the string (Postgres text protocol semantics).

## The pool + the query contract

- **`query(text, params) -> rows`** and **`execute(...) -> {rows, command, rowCount}`**. `PgPool` is a
  bounded set of reusable connections (default `max` 4) with a waiter queue and **one query in flight
  per connection** (the pool serialises). Fail-narrow socket posture like SharedLiveStore: a connect
  failure rejects ONE waiting caller; a query error or **timeout POISONS its connection** (we can't
  tell where in the reply stream we are), which is torn down and dropped — the next acquire lazily
  spawns a fresh one. Per-query timeout (`queryTimeoutMs`, default 30s) + connect timeout
  (`connectTimeoutMs`, default 15s). `health` is `idle`/`connecting`/`ready`/`closed`; `ready()`
  resolves once a connection is up.
- **`upsertGreatest({table, keys, values, greatest})`** builds the `INSERT … ON CONFLICT (keys) DO
  UPDATE SET col = GREATEST(table.col, EXCLUDED.col)` the ledger's per-host high-water needs — a
  low/partial writer can NEVER lower a recorded total, the SAME max-merge semantics the Valkey ledger
  backend uses today (so a PG `LedgerStore` is a drop-in of-record). Columns NOT in `greatest` are
  plain `EXCLUDED.col` overwrites; empty `values` degrades to `DO NOTHING`. Params are ordered
  keys-then-values. `quoteIdent` validates every table/column name (`[A-Za-z_][A-Za-z0-9_]*`, double-
  quoted) and throws on anything else — identifiers come from the hub's own code, but this is the
  belt-and-braces against a careless future caller; **values still never reach `quoteIdent`.**

## TLS

- **`sslmode` from the URL query, default `prefer`** (libpq's default): send SSLRequest, upgrade on
  'S', fall back to plaintext on 'N'. `require`/`verify-full` refuse a server that declines SSL;
  `disable` skips SSLRequest entirely (sends StartupMessage directly — so a fake/proxy expecting an
  SSLRequest first will desync; the CI fake uses `prefer` so the negotiation runs and it answers 'N').
- **`require` means channel ENCRYPTION, not peer verification** — `rejectUnauthorized` is false unless
  `sslmode=verify-full`. In-cluster CNPG presents a cert signed by its own CA that the hub does not
  carry, so app-to-CNPG connections encrypt without validating the cert (the common posture);
  `verify-full` would need the CA wired into the deployment. Deliberate — do not silently flip it.

## HA off is byte-identical

- **`createPgClient(haConfig)` returns null when HA is off**, when `DATABASE_URL` is absent, or when
  the config is fatal — so nothing is wired single-process and the non-HA (docker-compose) path is
  unchanged, exactly like `createBlobStore` / the store factory.

## Not on the beat loop

- Nothing here runs on the agent beat or the hub's heartbeat path (XERK-395). When `w2-ledger` /
  `w2-index` wire a consumer, the same rule binds them: a Postgres round-trip belongs off the beat's
  worst case (a worker or the leader's off-beat sweep), never inline.

## Tests

- `turma/tests/pgclient.test.js`: the pure encoders/decoders, the `PgProtocolReader` split-chunk +
  multi-message + corrupt-length cases, `parseAuthentication` for every flavour, the pinned DataRow
  vector, the **RFC 7677 SCRAM-SHA-256 proof + server-signature vector**, `md5AuthResponse`, the
  `buildUpsertGreatest` SQL + param-order + `DO NOTHING` + `quoteIdent` rejection, `parsePgUrl`, the
  factory HA gate, and the FULL query / `upsertGreatest` / pool round-trip (SSL negotiation → SCRAM →
  extended query) over the local fake, plus connection reuse, the `max` cap, query timeout, and a
  wrong-password handshake failure.
