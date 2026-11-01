"use strict";
// Moving the pre-tenancy deployment into one tenant (XERK-2554, epic XERK-2529).
//
// Pure orchestration: no server state. server.js registers one STEP per store
// that holds pre-tenancy (untenanted) data and calls `runMigration` once the
// stores are loaded. A step is
//
//   { name, count(t) -> number, apply(t) -> number | Promise<number> }
//
// `count` says how much the step would move into tenant `t` (the dry run logs
// it); `apply` moves it and answers how much it moved. Every step must be
// IDEMPOTENT — after `apply`, `count` reads 0 and a second `apply` moves nothing
// — because a hub killed mid-step re-runs that step on its next boot.
//
// The marker (`{tenantId, owner, startedAt, completedAt?, steps, hosts, sites}`)
// is the durable record: `steps[name]` is written as each step lands, so a
// resumed run skips the steps already done, and `completedAt` is what opens the
// tenant routes (server.js `tenantMigrationGateClosed`). `hosts`/`sites` are the
// untenanted host and org keys found when the run STARTED: later leftovers (a
// host still beating under its plain name until its bind beat, a ledger row
// loaded after the run) are re-keyed only for those, never for an untenanted
// host an operator enrolls after the migration.

const ID_RE = /^[0-9a-f]{32}$/;
const KEYS_MAX = 4096;      // hosts/sites remembered (a fleet is tens of hosts)
const KEY_MAX = 300;

function keyList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const k of v) {
    if (typeof k === "string" && k && k.length <= KEY_MAX && !out.includes(k)) out.push(k);
    if (out.length >= KEYS_MAX) break;
  }
  return out;
}

// Whitelist, field by field, in the order runMigration writes them (a coerce
// fixed point, so the HA store's own-write echo dedups).
function coerceMarker(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  if (typeof raw.tenantId !== "string" || !ID_RE.test(raw.tenantId)) return {};
  const ms = (n) => (Number.isSafeInteger(n) && n > 0 ? n : 0);
  const out = { tenantId: raw.tenantId };
  if (typeof raw.owner === "string" && ID_RE.test(raw.owner)) out.owner = raw.owner;
  out.startedAt = ms(raw.startedAt);
  const steps = Object.create(null);
  if (raw.steps && typeof raw.steps === "object" && !Array.isArray(raw.steps)) {
    for (const [name, s] of Object.entries(raw.steps)) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || !s || typeof s !== "object") continue;
      steps[name] = { moved: Number.isSafeInteger(s.moved) && s.moved >= 0 ? s.moved : 0, at: ms(s.at) };
    }
  }
  out.steps = steps;
  out.hosts = keyList(raw.hosts);
  out.sites = keyList(raw.sites);
  if (ms(raw.completedAt)) out.completedAt = ms(raw.completedAt);
  // Recorded hosts that have since beaten on their tenant key (server.js): their
  // plain name's later rows are someone else's.
  const arrived = keyList(raw.arrived);
  if (arrived.length) out.arrived = arrived;
  return out;
}

function countAll(steps, t, log) {
  const counts = {};
  for (const s of steps) {
    try { counts[s.name] = Number(s.count(t)) || 0; } catch (e) {
      counts[s.name] = 0;
      log(`tenant migration: counting ${s.name} failed: ${(e && e.message) || e}`);
    }
  }
  return counts;
}

/**
 * Run (or resume, or dry-run) the migration into tenant `tenantId`.
 *   marker   the current durable marker (coerced)
 *   save     (marker) -> void|Promise; persists it (awaited before each step)
 *   snapshot () -> {hosts, sites}; the untenanted keys, read once at the start
 * Returns {state: "dry-run"|"done"|"already-done"|"failed"|"refused", counts, marker, error?}.
 * A failed step leaves the marker incomplete; the next run resumes at it.
 */
async function runMigration({ steps, marker, tenantId, owner, dryRun, save, snapshot, now = Date.now, log = console.log }) {
  const cur = coerceMarker(marker);
  if (!ID_RE.test(tenantId || "")) return { state: "refused", error: "no owner tenant", marker: cur, counts: {} };
  if (cur.tenantId && cur.tenantId !== tenantId) {
    return {
      state: "refused", marker: cur, counts: {},
      error: `this hub was already migrated${cur.completedAt ? "" : " (partly)"} into tenant ${cur.tenantId}, ` +
        "not the one TURMA_MIGRATE_OWNER names now — restore the pre-migration /data snapshot to start over",
    };
  }
  if (cur.completedAt) return { state: "already-done", marker: cur, counts: {} };
  const counts = countAll(steps, tenantId, log);
  log(`tenant migration${dryRun ? " (dry run)" : ""}: moving into tenant ${tenantId} — ` +
    steps.map((s) => `${s.name}=${counts[s.name]}`).join(" "));
  if (dryRun) return { state: "dry-run", marker: cur, counts };
  let m = cur.tenantId ? cur : (() => {
    const snap = snapshot ? snapshot() : {};
    return coerceMarker({ tenantId, owner, startedAt: now(), steps: {}, hosts: snap.hosts, sites: snap.sites });
  })();
  await save(m);
  for (const s of steps) {
    if (m.steps[s.name]) continue;
    let moved;
    try { moved = Number(await s.apply(tenantId)) || 0; } catch (e) {
      const error = `step ${s.name} failed: ${(e && e.message) || e}`;
      log(`tenant migration: ${error} — the tenant routes stay closed; it resumes at this step`);
      return { state: "failed", marker: m, counts, error };
    }
    m = coerceMarker({ ...m, steps: { ...m.steps, [s.name]: { moved, at: now() } } });
    await save(m);
  }
  m = coerceMarker({ ...m, completedAt: now() });
  await save(m);
  log(`tenant migration: done — ` + steps.map((s) => `${s.name}=${m.steps[s.name].moved}`).join(" "));
  return { state: "done", marker: m, counts };
}

module.exports = { runMigration, coerceMarker, countAll };
