// The HA config contract (XERK-754): precedence, fail-loud validation, boot line.
// `resolveHaConfig` is pure (takes an env-shaped object), so these run in-process
// with no env mutation and no own-process isolation.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveHaConfig,
  POSTGRES_LEDGER_WIRED,
  POSTGRES_INDEX_WIRED,
  ledgerIndexBootSegment,
} = require("../ha-config.js");

// A complete HA env, so a test can drop ONE var to prove it is required.
const FULL = {
  HA_MODE: "1",
  TURMA_STORE_URL: "rediss://valkey.turma.svc:6379/0",
  DATABASE_URL: "postgres://u:p@pg.turma.svc:5432/turma",
  ARCHIVE_S3_ENDPOINT: "https://minio.turma.svc",
  ARCHIVE_S3_BUCKET: "turma-archive",
  ARCHIVE_S3_REGION: "us-east-1",
  ARCHIVE_S3_ACCESS_KEY: "ak",
  ARCHIVE_S3_SECRET_KEY: "sk",
};

test("XERK-754: default (no env) is single-process, no fatal, non-HA boot line", () => {
  const r = resolveHaConfig({});
  assert.equal(r.ha, false);
  assert.equal(r.forced, false);
  assert.deepEqual(r.fatal, []);
  assert.equal(r.storeUrl, null);
  assert.equal(r.bootLine, "HA: off (single-process)");
});

test("XERK-754: HA_MODE unset infers HA ON from TURMA_STORE_URL presence", () => {
  // The store URL alone turns HA on — but then the other required URLs are
  // demanded (all-or-nothing), so a lone URL is a FATAL misconfig, not a boot.
  const r = resolveHaConfig({ TURMA_STORE_URL: "redis://valkey:6379" });
  assert.equal(r.ha, true);
  assert.equal(r.forced, false); // inferred, not forced
  assert.ok(r.fatal.some((m) => m.includes("DATABASE_URL")));
  assert.ok(r.fatal.some((m) => m.includes("ARCHIVE_S3_BUCKET")));
});

test("XERK-754: HA_MODE unset + full env infers HA on cleanly", () => {
  const env = { ...FULL };
  delete env.HA_MODE;
  const r = resolveHaConfig(env);
  assert.equal(r.ha, true);
  assert.equal(r.forced, false);
  assert.deepEqual(r.fatal, []);
  // The of-record segment names the backends ACTUALLY wired (XERK-773), per-backend
  // (XERK-779 granularized the flag: ledger=postgres, index still sqlite until XERK-780).
  assert.equal(r.bootLine, `HA: on (store=valkey, ${ledgerIndexBootSegment()}, blobs=s3)`);
  assert.equal(r.storeUrl, FULL.TURMA_STORE_URL);
  assert.equal(r.databaseUrl, FULL.DATABASE_URL);
  assert.equal(r.s3.bucket, "turma-archive");
});

test("XERK-754: HA_MODE=1 with full env boots HA, forced", () => {
  const r = resolveHaConfig(FULL);
  assert.equal(r.ha, true);
  assert.equal(r.forced, true);
  assert.deepEqual(r.fatal, []);
});

test("XERK-754: HA_MODE=1 with a missing URL is FATAL (never a silent fallback)", () => {
  for (const drop of ["TURMA_STORE_URL", "DATABASE_URL", "ARCHIVE_S3_ENDPOINT", "ARCHIVE_S3_BUCKET", "ARCHIVE_S3_ACCESS_KEY", "ARCHIVE_S3_SECRET_KEY"]) {
    const env = { ...FULL };
    delete env[drop];
    const r = resolveHaConfig(env);
    assert.equal(r.ha, true, `${drop}: still HA (forced), does not fall back`);
    assert.ok(r.fatal.length > 0, `${drop}: is fatal`);
    assert.ok(r.fatal.some((m) => m.includes(drop) || (drop === "TURMA_STORE_URL" && m.includes("TURMA_STORE_URL"))), `${drop}: named in the error`);
    assert.match(r.bootLine, /INCOMPLETE|refusing/);
  }
});

test("XERK-754: ARCHIVE_S3_REGION is the one S3 var with a default (not required)", () => {
  const env = { ...FULL };
  delete env.ARCHIVE_S3_REGION;
  const r = resolveHaConfig(env);
  assert.deepEqual(r.fatal, []);
  assert.equal(r.s3.region, "us-east-1");
});

test("XERK-754: HA_MODE=0 forces single-process even with every URL present", () => {
  const r = resolveHaConfig({ ...FULL, HA_MODE: "0" });
  assert.equal(r.ha, false);
  assert.equal(r.forced, true);
  assert.deepEqual(r.fatal, []);
  // The escape hatch must not drag any shared URL in.
  assert.equal(r.storeUrl, null);
  assert.equal(r.databaseUrl, null);
  assert.equal(r.s3, null);
  assert.equal(r.bootLine, "HA: off (single-process)");
});

test("XERK-754: explicit HA_MODE wins over URL presence (precedence)", () => {
  // URL present but HA_MODE=0 -> off; no URL but HA_MODE=1 -> on (and fatal).
  assert.equal(resolveHaConfig({ HA_MODE: "0", TURMA_STORE_URL: "redis://x:6379" }).ha, false);
  const forcedOn = resolveHaConfig({ HA_MODE: "1" });
  assert.equal(forcedOn.ha, true);
  assert.ok(forcedOn.fatal.length > 0);
});

test("XERK-754: a malformed store URL is a boot refusal, not a runtime surprise", () => {
  const bad = resolveHaConfig({ ...FULL, TURMA_STORE_URL: "http://valkey:6379" });
  assert.ok(bad.fatal.some((m) => m.includes("TURMA_STORE_URL is invalid")));
  const notaurl = resolveHaConfig({ ...FULL, TURMA_STORE_URL: "::::" });
  assert.ok(notaurl.fatal.some((m) => m.includes("TURMA_STORE_URL is invalid")));
});

test("XERK-754: a malformed DATABASE_URL scheme is fatal", () => {
  const r = resolveHaConfig({ ...FULL, DATABASE_URL: "redis://pg:6379" });
  assert.ok(r.fatal.some((m) => m.includes("DATABASE_URL is invalid")));
});

test("XERK-754: a non 0/1 HA_MODE is fatal (typo, not a silent guess)", () => {
  const r = resolveHaConfig({ HA_MODE: "yes" });
  assert.ok(r.fatal.some((m) => m.includes("HA_MODE")));
});

test("XERK-779: the boot line names each backend per-flag (ledger on Postgres, index still sqlite)", () => {
  const r = resolveHaConfig(FULL);
  assert.deepEqual(r.fatal, []);
  // XERK-779 moved the LEDGER onto Postgres; the archive INDEX (XERK-780) has not
  // landed, so the line must say ledger=postgres, index=sqlite(...), never claim the
  // index is on Postgres.
  assert.equal(POSTGRES_LEDGER_WIRED, true, "the ledger of-record is Postgres (XERK-779)");
  assert.equal(POSTGRES_INDEX_WIRED, false, "flip this with XERK-780's IndexStore");
  assert.equal(r.bootLine, "HA: on (store=valkey, ledger=postgres, index=sqlite(local, rebuilt from s3), blobs=s3)");
});

test("XERK-779: the of-record boot segment composes the two per-backend flags", () => {
  // The segment and the flags live together so they can never drift: each half names
  // the backend actually wired, flipped in the SAME change that wires it.
  const seg = ledgerIndexBootSegment();
  const ledger = POSTGRES_LEDGER_WIRED ? "ledger=postgres" : "ledger=valkey";
  const index = POSTGRES_INDEX_WIRED ? "index=postgres" : "index=sqlite(local, rebuilt from s3)";
  assert.equal(seg, `${ledger}, ${index}`);
});

test("XERK-773: DATABASE_URL stays required under HA (provisioned ahead of use)", () => {
  const env = { ...FULL };
  delete env.DATABASE_URL;
  const r = resolveHaConfig(env);
  assert.ok(r.fatal.some((m) => m.includes("DATABASE_URL")), "still fatal when absent");
});
