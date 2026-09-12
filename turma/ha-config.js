// The HA config contract (XERK-754, epic XERK-751) — ONE switch decides whether
// the hub runs single-process on local files/RAM (the default) or against the
// shared store, and it FAILS LOUD rather than ever running half-HA.
//
// This is the config half of the storage-abstraction seam. `resolveHaConfig` is
// PURE — it reads an env-shaped object and returns a decision + a boot line + a
// list of fatal misconfigurations; it never touches the process, so server.js
// owns the `process.exit` and the print. That keeps it unit-testable with no
// environment mutation (the suite passes plain objects).
//
// The decision + precedence come straight from docs/turma-ha-store-adr.md
// ("The HA config contract"):
//   - HA_MODE unset  -> HA is inferred ON iff TURMA_STORE_URL is present, so
//                       "add the store URL to the deployment" is the single
//                       action that turns HA on, and a bare `docker compose up`
//                       with no such env stays single-process with zero config.
//   - HA_MODE=1      -> HA forced ON; every required URL must be present or the
//                       hub REFUSES TO BOOT with a named error (never a silent
//                       fallback to single-process — a hub quietly running local
//                       while its replicas run shared is the split-brain the
//                       whole epic exists to avoid).
//   - HA_MODE=0      -> HA forced OFF even if store URLs are present — the escape
//                       hatch to run a known-good single-process hub against a
//                       cluster that still has the env wired.
// Precedence: an explicit HA_MODE (1/0) wins over URL presence; URL presence is
// the fallback signal only when HA_MODE is unset.
//
// SCOPE NOTE (XERK-754): this ticket builds the LiveStore (live-plane) backend
// only. The LedgerStore/IndexStore (Postgres, DATABASE_URL) and BlobStore
// (object storage, ARCHIVE_S3_*) backends are wave-3 children. Their URLs are
// still VALIDATED here so the "all-or-nothing, never half-HA" contract the ADR
// demands is landed once and every downstream child inherits it — a child adds a
// backend behind an already-validated URL, never a new boot check.

"use strict";

// The five object-storage vars the ADR names for the archive-bytes BlobStore.
// Grouped so the "all required together" rule can name the whole set.
const S3_VARS = [
  "ARCHIVE_S3_ENDPOINT",
  "ARCHIVE_S3_BUCKET",
  "ARCHIVE_S3_REGION",
  "ARCHIVE_S3_ACCESS_KEY",
  "ARCHIVE_S3_SECRET_KEY",
];

// Region is the one S3 var with a sane default (MinIO ignores it; S3 SDKs want a
// value). Every OTHER required var is genuinely operator-specific, so an absent
// one is a misconfig, not a default.
const S3_REGION_DEFAULT = "us-east-1";

// Whether each Postgres of-record backend is actually WIRED and consuming
// DATABASE_URL (XERK-773). The boot line must name the backends ACTUALLY in use,
// never the intended design, or it lies to the operator (turma-postgres sat idle with
// zero tables for hours in prod). The ADR (docs/turma-ha-store-adr.md) designates
// Postgres the durable of-record for BOTH the usage ledger and the archive index, but
// they land in SEPARATE waves, so the flag is granularized — flip each ONE in the
// SAME change that wires its backend:
//   - INDEX: WIRED (XERK-780, w2-index). The archive's searchable index is now the
//     shared Postgres of-record (index-store.js over pgclient) — a promoted/new
//     replica hydrates its local node:sqlite index FROM Postgres instead of rebuilding
//     from the S3 bytes, and ingest is an idempotent ON-CONFLICT upsert.
//   - LEDGER: NOT wired yet (w2-ledger). The usage ledger's high-water still lives in
//     the Valkey LiveStore (XERK-758, stdlib-only, no Postgres LedgerStore yet). Flip
//     LEDGER_BACKEND_WIRED when that backend lands.
// DATABASE_URL stays REQUIRED under HA (validated below) so the cluster is provisioned
// ahead of use by both consumers.
const INDEX_BACKEND_WIRED = true;
const LEDGER_BACKEND_WIRED = false;

// The of-record segment of the boot line: each of ledger/index named by the backend
// it ACTUALLY runs on. Kept beside the flags so the two never drift.
function ledgerIndexBootSegment() {
  const ledger = LEDGER_BACKEND_WIRED ? "ledger=postgres" : "ledger=valkey";
  const index = INDEX_BACKEND_WIRED ? "index=postgres" : "index=sqlite(local, rebuilt from s3)";
  return `${ledger}, ${index}`;
}

// A store URL must be a redis/rediss (Valkey is redis-wire) URL that actually
// parses and names a host — a malformed one is a boot refusal, never a runtime
// surprise (the ADR: "a malformed store URL is a boot refusal").
function parseStoreUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") {
    return { ok: false, reason: `expected a redis:// or rediss:// URL, got ${JSON.stringify(u.protocol)}` };
  }
  if (!u.hostname) return { ok: false, reason: "no host in URL" };
  return { ok: true };
}

// The durable-of-record URL is Postgres (CloudNativePG) per the ADR. We only
// sanity-check the scheme here — the LedgerStore/IndexStore child owns the real
// connection — so an obviously-wrong value (a redis URL in DATABASE_URL, say) is
// caught at boot rather than by the wave-3 code that has no view of the toggle.
function parseDatabaseUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    return { ok: false, reason: `expected a postgres:// URL, got ${JSON.stringify(u.protocol)}` };
  }
  if (!u.hostname) return { ok: false, reason: "no host in URL" };
  return { ok: true };
}

/**
 * Resolve the HA configuration from an env-shaped object. PURE: returns a plain
 * decision, never exits or logs.
 *
 * @returns {{
 *   ha: boolean,            // is HA on?
 *   forced: boolean,        // did an explicit HA_MODE decide it (vs URL inference)?
 *   modeRaw: string|null,   // the raw HA_MODE value, for messages
 *   storeUrl: string|null,  // TURMA_STORE_URL when HA on and valid, else null
 *   databaseUrl: string|null,
 *   s3: object|null,        // {endpoint,bucket,region,accessKey,secretKey} when HA on
 *   fatal: string[],        // named misconfigurations; non-empty means "refuse to boot"
 *   bootLine: string,       // the one line to print at boot
 * }}
 */
function resolveHaConfig(env) {
  env = env || {};
  const modeRaw = env.HA_MODE == null || env.HA_MODE === "" ? null : String(env.HA_MODE);
  const storeUrl = env.TURMA_STORE_URL || null;
  const databaseUrl = env.DATABASE_URL || null;

  const fatal = [];

  // --- Decide the mode (precedence: explicit HA_MODE, then URL presence) ------
  let ha;
  let forced;
  if (modeRaw === "0") {
    ha = false;
    forced = true;
  } else if (modeRaw === "1") {
    ha = true;
    forced = true;
  } else if (modeRaw === null) {
    ha = !!storeUrl; // inferred: the store URL is the HA-on signal
    forced = false;
  } else {
    // A non-empty HA_MODE that is neither 1 nor 0 is a typo, and guessing at it
    // could silently pick the wrong plane — refuse loudly (the ADR posture).
    fatal.push(`HA_MODE=${JSON.stringify(modeRaw)} is not one of unset, "1", or "0"`);
    ha = false;
    forced = true;
  }

  if (!ha) {
    // Single-process: nothing else is required and nothing HA-shaped is wired.
    // A store URL sitting in the env while HA_MODE=0 is deliberate (the escape
    // hatch) and must NOT drag anything shared in — so we return no URLs.
    return {
      ha: false,
      forced,
      modeRaw,
      storeUrl: null,
      databaseUrl: null,
      s3: null,
      fatal,
      bootLine: fatal.length
        ? "HA: off (single-process) — but HA_MODE is malformed (see errors above)"
        : "HA: off (single-process)",
    };
  }

  // --- HA is ON: validate every required URL (all-or-nothing) -----------------
  // The ADR: "Half the state shared and half local is the worst outcome — worse
  // than either pure mode — so it is refused, not degraded." A missing required
  // URL is fatal and NAMED; a present-but-malformed one is fatal too.
  if (!storeUrl) {
    fatal.push(
      "HA is on but TURMA_STORE_URL (Valkey live plane) is not set" +
        (forced ? " — HA_MODE=1 requires it" : "")
    );
  } else {
    const p = parseStoreUrl(storeUrl);
    if (!p.ok) fatal.push(`TURMA_STORE_URL is invalid: ${p.reason}`);
  }

  if (!databaseUrl) {
    // Required by BOTH Postgres consumers: the archive INDEX of-record already
    // consumes it (INDEX_BACKEND_WIRED, XERK-780); the usage ledger will
    // (LEDGER_BACKEND_WIRED, w2-ledger). Required so the CloudNativePG cluster is in
    // place before each backend lands (XERK-773).
    fatal.push("HA is on but DATABASE_URL (Postgres ledger + archive index of-record) is not set");
  } else {
    const p = parseDatabaseUrl(databaseUrl);
    if (!p.ok) fatal.push(`DATABASE_URL is invalid: ${p.reason}`);
  }

  // S3 blob store: required together. REGION defaults; every other var must be
  // present. Report EACH missing one (an operator fixing a half-set env wants the
  // whole list, not one at a time).
  const s3 = {
    endpoint: env.ARCHIVE_S3_ENDPOINT || null,
    bucket: env.ARCHIVE_S3_BUCKET || null,
    region: env.ARCHIVE_S3_REGION || S3_REGION_DEFAULT,
    accessKey: env.ARCHIVE_S3_ACCESS_KEY || null,
    secretKey: env.ARCHIVE_S3_SECRET_KEY || null,
  };
  for (const v of S3_VARS) {
    if (v === "ARCHIVE_S3_REGION") continue; // has a default
    if (!env[v]) fatal.push(`HA is on but ${v} (archive blob store) is not set`);
  }

  const bootLine = fatal.length
    ? "HA: on — but the configuration is INCOMPLETE (see errors above); refusing to boot"
    : `HA: on (store=valkey, ${ledgerIndexBootSegment()}, blobs=s3)`;

  return {
    ha: true,
    forced,
    modeRaw,
    storeUrl,
    databaseUrl,
    s3,
    fatal,
    bootLine,
  };
}

module.exports = {
  resolveHaConfig,
  parseStoreUrl,
  parseDatabaseUrl,
  S3_VARS,
  S3_REGION_DEFAULT,
  INDEX_BACKEND_WIRED,
  LEDGER_BACKEND_WIRED,
  ledgerIndexBootSegment,
};
