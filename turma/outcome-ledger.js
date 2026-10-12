// The outcome ledger (XERK-1839, epic XERK-1844): one row per ticket SESSION —
// which model worked which ticket, of which work class, and what became of the
// work (PR merged / closed unmerged, ticket reopened after Done). It is the
// evidence a cheaper model must earn a work class on (docs/model-quality-adr.md).
//
// The hub observes; nothing here is agent-sent. A leader sweep folds the fleet's
// sessions + closedSessions + the board's resolved rows into rows (`observe`),
// so a session the agent's `closedSessions` cache later evicts is not forgotten.
// Model provenance stays HERE, never in git: some orgs require commits authored by
// the user with no model attribution.
//
// Evidence is FLEET-WIDE: `aggregate()` counts per (class, model) across every
// org, because a model good at bug work is good at it everywhere. Per-session
// rows are only served for an org the caller names.
//
// ## Persistence — the permission ledger's two backends
//   - file (non-HA): /data/outcome-ledger.json, rewritten whole on a debounce.
//   - Postgres (HA): one row per ledger row in `outcome_session`, upserted by key,
//     monotone on `updated_at`, rescanned on the pool's ready edge and on leader
//     promotion (`rehydrate()`).
// Never `registerExternalStore`: it rewrites the whole value per persist.

"use strict";

const fs = require("fs");
const path = require("path");

function positiveEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`${name}=${JSON.stringify(raw)} is not a positive number; using ${fallback}`);
    return fallback;
  }
  return Math.floor(n);
}

const LEDGER_FILE = process.env.OUTCOME_LEDGER_FILE || "/data/outcome-ledger.json";
const MAX_ROWS = positiveEnv("OUTCOME_LEDGER_MAX_ROWS", 10000);
// A row is kept this long past its last change: the defect window plus the
// defect-attribution back-fill (XERK-1846) both need old merged work.
const RETAIN_DAYS = positiveEnv("OUTCOME_LEDGER_DAYS", 365);
// A merged PR counts as good once this long has passed with no bad signal.
const WINDOW_DAYS = positiveEnv("MODEL_QUALITY_WINDOW_DAYS", 90);
const FILE_MAX_BYTES = positiveEnv("OUTCOME_LEDGER_FILE_MAX", 16 << 20);
const SAVE_DEBOUNCE_MS = positiveEnv("OUTCOME_LEDGER_SAVE_MS", 5000);
const DAY_MS = 86400000;
const PRS_MAX = 10;
// One host may hold at most this many rows, and past MAX_ROWS the org holding the
// most rows loses its oldest first — so one host or org churning session ids
// cannot push the rest of the fleet's evidence out.
const HOST_MAX_ROWS = positiveEnv("OUTCOME_LEDGER_HOST_MAX_ROWS", Math.max(1, Math.floor(MAX_ROWS / 4)));
// /metrics labels a model outside these families "other": a model id is
// agent-supplied, and every distinct one would add series to an unauthenticated route.
const METRIC_MODELS = new Set(["opus", "sonnet", "haiku", "default"]);
const METRIC_CLASSES_MAX = 20;
const ROWS_SERVED_MAX = 500;

// ---- shapes ----------------------------------------------------------------------

// A site may contain '/' (ADO's `dev.azure.com/<org>`), so the key is a JSON tuple,
// never a '/'-joined path.
const KEY_PART_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;
const ISSUE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const PR_STATES = new Set(["OPEN", "MERGED", "CLOSED", "DRAFT"]);
const CLOSE_KINDS = new Set(["done", "not-reproducible", "already-fixed"]);
const SHA_RE = /^[0-9a-fA-F]{7,64}$/;
const COUNT_MAX = 1000;
const QA_KEYS = ["runs", "pass", "partial", "fail"];
// Defect attribution (XERK-1846): bounds on what one beat's reports and one row carry.
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const DEFECT_KINDS = new Set(["bug", "revert"]);
const DEFECT_REPORTS_MAX = 50;
const DEFECT_INTRODUCERS_MAX = 5;
const DEFECT_PRS_MAX = 3;
const ROW_DEFECTS_MAX = 10;
// Shadow runs (XERK-1847): the hub mints the id, so a report naming any other
// shape is not one of ours.
const SHADOW_ID_RE = /^sh-[0-9a-f]{8,32}$/;
const SHADOW_STATES = new Set(["running", "grading", "graded", "failed"]);
const GRADE_ENUMS = {
  verdict: new Set(["good", "bad"]),
  tests: new Set(["pass", "fail", "none"]),
  qa: new Set(["pass", "partial", "fail", "none"]),
  design: new Set(["better", "same", "worse"]),
};
const GRADE_NOTE_MAX = 500;

function capStr(v, max) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, max);
}
function posInt(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}
function timeOf(v) {
  if (typeof v === "number") return posInt(Math.floor(v));
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/**
 * A work class: the tracker's own issue type, lowercased, one token. Missing →
 * "other". Coarse on purpose — each (class, model) must collect enough tickets to
 * compare (ADR "Work class").
 */
function workClass(type) {
  const s = capStr(type, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "other";
}

/**
 * A model id or alias → its family ("opus" / "sonnet" / "haiku"), else a
 * sanitized id, else "". "claude-opus-4-8", "opus", "Opus 4.8" all read "opus".
 */
function modelFamily(v) {
  const s = capStr(v, 80).toLowerCase();
  if (!s) return "";
  for (const f of ["opus", "sonnet", "haiku"]) if (s.includes(f)) return f;
  return s.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function sanitizePr(p) {
  if (!p || typeof p !== "object") return null;
  const url = capStr(p.url, 500);
  if (!/^https?:\/\//i.test(url)) return null;
  const out = { url };
  const state = typeof p.state === "string" ? p.state.toUpperCase() : "";
  if (PR_STATES.has(state)) out.state = state;
  // The agent sends mergedAt as the tracker's ISO time; the store keeps ms.
  const mergedAt = timeOf(p.mergedAt);
  if (mergedAt) out.mergedAt = mergedAt;
  const closedAt = posInt(p.closedAt);
  if (closedAt) out.closedAt = closedAt;
  if (typeof p.mergeCommit === "string" && SHA_RE.test(p.mergeCommit)) {
    out.mergeCommit = p.mergeCommit.toLowerCase();
  }
  // Rework counters (XERK-1845). Absent = the agent could not tell.
  for (const k of ["ciRounds", "changesRequested"]) {
    const n = countOf(p[k]);
    if (n !== null) out[k] = n;
  }
  return out;
}

/** A non-negative safe integer, capped; anything else is "can't tell". */
function countOf(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? Math.min(v, COUNT_MAX) : null;
}

/**
 * QA runs off the wire ([{agent, verdict}]) → {runs, pass, partial, fail}, or
 * null when the agent sent no list (an older agent: can't tell). An empty list
 * is a KNOWN zero — a session that needed no QA pass.
 */
function qaOf(list) {
  if (!Array.isArray(list)) return null;
  const qa = { runs: 0, pass: 0, partial: 0, fail: 0 };
  for (const r of list) {
    if (!r || typeof r !== "object" || (r.agent !== "qa" && r.agent !== "qa-delta")) continue;
    qa.runs += 1;
    if (r.verdict === "PASS") qa.pass += 1;
    else if (r.verdict === "PARTIAL") qa.partial += 1;
    else if (r.verdict === "FAIL") qa.fail += 1;
  }
  return qa;
}

function sanitizeQa(q) {
  if (!q || typeof q !== "object") return null;
  const out = {};
  for (const k of QA_KEYS) {
    const n = countOf(q[k]);
    if (n === null) return null;
    out[k] = n;
  }
  if (q.incomplete === true) out.incomplete = true;
  return out;
}

/**
 * An Opus grader's verdict on a shadow change (XERK-1847), or null. `verdict`
 * is required; the other enums drop to absent when wrong ("can't tell").
 */
function sanitizeGrade(g) {
  if (!g || typeof g !== "object" || !GRADE_ENUMS.verdict.has(g.verdict)) return null;
  const out = { verdict: g.verdict };
  for (const k of ["tests", "qa", "design"]) {
    const v = typeof g[k] === "string" ? g[k].toLowerCase() : "";
    if (GRADE_ENUMS[k].has(v)) out[k] = v;
  }
  const note = capStr(g.note, GRADE_NOTE_MAX);
  if (note) out.note = note;
  const at = timeOf(g.at);
  if (at) out.at = at;
  return out;
}

/**
 * The hub's sampling decision on a LIVE row (XERK-1847): `sampled` false is
 * "this merged ticket was not picked" and is final, so the sweep never asks
 * again. A sampled one names the shadow it dispatched.
 */
function sanitizeShadowDecision(d) {
  if (!d || typeof d !== "object" || typeof d.sampled !== "boolean") return null;
  const at = posInt(d.at);
  if (!at) return null;
  const out = { sampled: d.sampled, at };
  if (!d.sampled) return out;
  if (typeof d.id !== "string" || !SHADOW_ID_RE.test(d.id)) return null;
  out.id = d.id;
  const model = modelFamily(d.model);
  if (model) out.model = model;
  const host = capStr(d.host, 200);
  if (host) out.host = host;
  return out;
}

/** A stored row → the stored shape, or null. The one whitelist: file load,
 * Postgres rescan and observe() all go through it. */
function sanitizeRow(r) {
  if (!r || typeof r !== "object") return null;
  const site = capStr(r.site, 200);
  const issue = typeof r.issue === "string" && ISSUE_RE.test(r.issue) ? r.issue : "";
  const host = capStr(r.host, 200);
  const sid = typeof r.sid === "string" && SID_RE.test(r.sid) ? r.sid : "";
  if (!site || !KEY_PART_RE.test(site) || !issue || !host || !KEY_PART_RE.test(host) || !sid) return null;
  const firstSeen = posInt(r.firstSeen);
  const updatedAt = posInt(r.updatedAt);
  if (!firstSeen || !updatedAt) return null;
  const out = {
    key: rowKey(site, issue, host, sid), site, issue, host, sid,
    cls: workClass(r.cls), model: modelFamily(r.model) || "default",
    firstSeen, updatedAt,
  };
  if (r.modelKnown === true) out.modelKnown = true;
  const repo = capStr(r.repo, 200);
  if (repo) out.repo = repo;
  const runtime = capStr(r.runtime, 20).toLowerCase();
  if (runtime && runtime !== "claude") out.runtime = runtime;
  for (const k of ["startedAt", "endedAt", "doneAt", "reopenedAt"]) {
    const t = posInt(r[k]);
    if (t) out[k] = t;
  }
  if (CLOSE_KINDS.has(r.closeKind)) out.closeKind = r.closeKind;
  if (Array.isArray(r.prs)) {
    const prs = r.prs.map(sanitizePr).filter(Boolean).slice(0, PRS_MAX);
    if (prs.length) out.prs = prs;
  }
  const qa = sanitizeQa(r.qa);
  if (qa) out.qa = qa;
  if (Array.isArray(r.defects)) {
    const defects = r.defects.map(sanitizeDefect).filter(Boolean).slice(0, ROW_DEFECTS_MAX);
    if (defects.length) out.defects = defects;
  }
  // A shadow row (XERK-1847) pairs with the live row it re-ran; a live row
  // carries the sampling decision instead. Never both.
  if (r.kind === "shadow") {
    out.kind = "shadow";
    const pairOf = capStr(r.pairOf, 700);
    if (pairOf) out.pairOf = pairOf;
    if (SHADOW_STATES.has(r.shadowState)) out.shadowState = r.shadowState;
    const grade = sanitizeGrade(r.grade);
    if (grade) out.grade = grade;
  } else {
    const shadow = sanitizeShadowDecision(r.shadow);
    if (shadow) out.shadow = shadow;
  }
  return out;
}

function prUrls(list) {
  if (!Array.isArray(list)) return [];
  return list.map((u) => capStr(u, 500)).filter((u) => /^https?:\/\//i.test(u)).slice(0, DEFECT_PRS_MAX);
}

/** A row's defect mark: the fix that implicated it. */
function sanitizeDefect(d) {
  if (!d || typeof d !== "object" || !DEFECT_KINDS.has(d.kind)) return null;
  const fix = typeof d.fix === "string" ? d.fix.toLowerCase() : "";
  const at = posInt(d.at);
  if (!FULL_SHA_RE.test(fix) || !at) return null;
  const out = { fix, kind: d.kind, at };
  const prs = prUrls(d.prs);
  if (prs.length) out.prs = prs;
  return out;
}

/**
 * One beat's `defectReports` (the agent's SZZ findings, XERK-1846) → the
 * bounded shape attributeDefects folds, or [] — agent-supplied, so every field
 * is whitelisted and capped. A report:
 *   {repo, fix, fixPrs, kind: bug|revert, ticket, at, introducers: [{sha, prs}]}
 */
function sanitizeDefectReports(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    if (out.length >= DEFECT_REPORTS_MAX) break;
    if (!r || typeof r !== "object" || !DEFECT_KINDS.has(r.kind)) continue;
    const fix = typeof r.fix === "string" ? r.fix.toLowerCase() : "";
    const at = posInt(r.at);
    if (!FULL_SHA_RE.test(fix) || !at) continue;
    const introducers = [];
    for (const i of Array.isArray(r.introducers) ? r.introducers : []) {
      if (introducers.length >= DEFECT_INTRODUCERS_MAX) break;
      const sha = i && typeof i.sha === "string" ? i.sha.toLowerCase() : "";
      if (!FULL_SHA_RE.test(sha) || sha === fix) continue;
      introducers.push({ sha, prs: prUrls(i.prs) });
    }
    if (!introducers.length) continue;
    const report = { fix, fixPrs: prUrls(r.fixPrs), kind: r.kind, at, introducers };
    const repo = capStr(r.repo, 200);
    if (repo) report.repo = repo;
    const ticket = typeof r.ticket === "string" && ISSUE_RE.test(r.ticket) ? r.ticket : "";
    if (ticket) report.ticket = ticket;
    out.push(report);
  }
  return out;
}

function rowKey(site, issue, host, sid) {
  return JSON.stringify([site, issue, host, sid]);
}

// ---- the model ------------------------------------------------------------------

let rows = new Map();          // key -> row
let backend = null;            // set below

/**
 * Fold one sweep's observations. Each observation is one ticket session the
 * fleet still reports:
 *   {site, issue, host, sid, repo, model, modelActual, runtime, running,
 *    createdAt, closedAt, prs:[{url,state}], closeKind, type, statusCategory}
 * Returns the rows that changed (also handed to the backend).
 */
function observe(observations, now = Date.now()) {
  if (!Array.isArray(observations)) return [];
  // Under HA, never fold into a model the of-record has not been read into yet: a
  // promoted leader's stale snapshot would win the newer-wins upsert over rows
  // another replica wrote.
  if (backend.loaded === false) {
    // A failed rescan (a timeout with no later pool health edge) must not leave the
    // ledger recording nothing: retry it, throttled, off this sweep.
    if (backend.retryLoad) backend.retryLoad(now);
    return [];
  }
  const changed = new Map();
  const ticketDone = new Map();     // [site, issue] -> {cat, resolvedAt} seen this sweep
  for (const o of observations) {
    if (!o || typeof o !== "object") continue;
    const base = sanitizeRow({
      site: o.site, issue: o.issue, host: o.host, sid: o.sid,
      cls: o.type, model: "x", firstSeen: now, updatedAt: now,
    });
    if (!base) continue;
    const prev = rows.get(base.key);
    const next = prev ? { ...prev, prs: prev.prs ? prev.prs.map((p) => ({ ...p })) : undefined }
      : { ...base, model: "default" };
    if (!next.prs) delete next.prs;
    // The class can be learned late (the board row arrives after the session).
    if (o.type && workClass(o.type) !== "other") next.cls = workClass(o.type);
    // The model: the one the transcript says answered wins over the alias it was
    // spawned on; once known it is never overwritten by an alias.
    const actual = modelFamily(o.modelActual);
    if (actual) { next.model = actual; next.modelKnown = true; }
    else if (!next.modelKnown) {
      const alias = modelFamily(o.model);
      if (alias) next.model = alias;
    }
    const repo = capStr(o.repo, 200);
    if (repo) next.repo = repo;
    const runtime = capStr(o.runtime, 20).toLowerCase();
    if (runtime && runtime !== "claude") next.runtime = runtime;
    const started = timeOf(o.createdAt);
    if (started && !next.startedAt) next.startedAt = started;
    if (!o.running) {
      const ended = timeOf(o.closedAt) || next.endedAt || now;
      next.endedAt = ended;
    } else if (next.endedAt) {
      delete next.endedAt;          // resumed
    }
    if (CLOSE_KINDS.has(o.closeKind)) next.closeKind = o.closeKind;
    mergePrs(next, o.prs, now);
    // QA runs (XERK-1845): the agent reports the session's whole list, so each
    // count only rises — a closed record carrying fewer runs never lowers one.
    const qa = qaOf(o.qaRuns);
    if (qa) {
      const prevQa = next.qa || {};
      next.qa = {};
      for (const k of QA_KEYS) next.qa[k] = Math.max(prevQa[k] || 0, qa[k]);
      // Part of the session's transcript went unscanned (a restart, an
      // upgrade, a resume): the counts are a floor, never served as the count.
      if (prevQa.incomplete || o.qaPartial === true) next.qa.incomplete = true;
    }
    const tkey = JSON.stringify([base.site, base.issue]);
    if (typeof o.statusCategory === "string") {
      ticketDone.set(tkey, { cat: o.statusCategory, resolvedAt: timeOf(o.resolved) });
    }
    commit(prev, next, now, changed);
  }
  // Ticket status edges, applied to every row of that ticket: Done stamps doneAt;
  // a ticket seen out of Done after one stamps reopenedAt on the rows that worked
  // it before the Done (a later session is the reopened work, not the cause).
  const byTicket = new Map();
  if (ticketDone.size) {
    for (const r of rows.values()) {
      const tkey = JSON.stringify([r.site, r.issue]);
      if (!ticketDone.has(tkey)) continue;
      if (!byTicket.has(tkey)) byTicket.set(tkey, []);
      byTicket.get(tkey).push(r);
    }
  }
  for (const [tkey, { cat, resolvedAt }] of ticketDone) {
    for (const r of byTicket.get(tkey) || []) {
      const next = { ...r };
      if (cat === "done") {
        // The tracker's own resolution time when it has one: a session first seen
        // while the board still shows an earlier Done started AFTER it.
        if (!next.doneAt) next.doneAt = resolvedAt && resolvedAt <= now ? resolvedAt : now;
      } else if (next.doneAt && !next.reopenedAt && (next.startedAt || next.firstSeen) < next.doneAt) {
        next.reopenedAt = now;
      }
      commit(r, next, now, changed);
    }
  }
  return persistChanged(changed, now);
}

// Evict, then hand the backend the rows that changed and survived.
function persistChanged(changed, now) {
  if (changed.size) {
    const dropped = evict(now);
    const live = [...changed.values()].filter((r) => rows.get(r.key) === r);
    if (live.length) backend.onChange(live);
    if (dropped.length && backend.onDelete) backend.onDelete(dropped);
  }
  return [...changed.values()];
}

/**
 * Fold defect reports (XERK-1846): each introducer of a fix maps to the ledger
 * rows of its org whose MERGED PR is that introducer — by the forge's PR url or
 * by the merge commit — and those rows are marked bad with the fix as evidence.
 *   entries: [{site, reports}] — `site` is the reporting host's DECIDED org, and
 *   only rows of that org are touched (a host cannot mark another org's work).
 * A fix counts only when it landed after the PR merged and inside the defect
 * window — a late back-fill may still mark a row that already read `good`,
 * since the fix it found landed inside that row's window — and never against
 * the fix's own PR. An introducer with no row is unattributed: human work, a direct push
 * or pre-ledger history — excluded, never counted against anyone. Idempotent:
 * the agent re-sends its reports every few minutes until they age out.
 */
function attributeDefects(entries, now = Date.now(), windowDays = WINDOW_DAYS) {
  if (!Array.isArray(entries) || !entries.some((e) => e && Array.isArray(e.reports) && e.reports.length)) {
    return [];
  }
  if (backend.loaded === false) return [];
  // url / merge sha -> [{row, pr}] over merged PRs only.
  const byUrl = new Map();
  const bySha = new Map();
  const index = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const r of rows.values()) {
    for (const p of r.prs || []) {
      if (p.state !== "MERGED") continue;
      index(byUrl, p.url, { r, p });
      if (p.mergeCommit && p.mergeCommit.length === 40) index(bySha, p.mergeCommit, { r, p });
    }
  }
  const changed = new Map();
  for (const e of entries) {
    if (!e || typeof e.site !== "string" || !e.site) continue;
    for (const rep of sanitizeDefectReports(e.reports)) {
      const fixPrs = new Set(rep.fixPrs);
      for (const intro of rep.introducers) {
        const hits = [...(bySha.get(intro.sha) || [])];
        for (const u of intro.prs) hits.push(...(byUrl.get(u) || []));
        for (const { r, p } of hits) {
          const cur = rows.get(r.key);
          if (!cur || cur.site !== e.site) continue;
          if ((cur.prs || []).some((x) => fixPrs.has(x.url) || x.mergeCommit === rep.fix)) continue;
          const mergedAt = p.mergedAt || cur.updatedAt;
          if (rep.at < mergedAt || rep.at - mergedAt > windowDays * DAY_MS) continue;
          const defects = cur.defects || [];
          if (defects.some((d) => d.fix === rep.fix) || defects.length >= ROW_DEFECTS_MAX) continue;
          const mark = { fix: rep.fix, kind: rep.kind, at: rep.at };
          if (rep.fixPrs.length) mark.prs = rep.fixPrs;
          commit(cur, { ...cur, defects: [...defects, mark] }, now, changed);
        }
      }
    }
  }
  return persistChanged(changed, now);
}

// ---- shadow runs (XERK-1847) -------------------------------------------------------

/**
 * Live rows a shadow could re-run: a claude session whose PR MERGED with a known
 * merge commit, not yet decided on, merged within `maxAgeMs`. Oldest merge first.
 */
function shadowCandidates({ now = Date.now(), maxAgeMs = 0 } = {}) {
  const out = [];
  for (const r of rows.values()) {
    if (r.kind === "shadow" || r.shadow || r.runtime || !r.repo) continue;
    const merged = (r.prs || []).filter((p) => p.state === "MERGED" && p.mergeCommit);
    if (!merged.length) continue;
    const pr = merged.reduce((a, b) => ((a.mergedAt || 0) <= (b.mergedAt || 0) ? a : b));
    const mergedAt = pr.mergedAt || r.updatedAt;
    if (maxAgeMs && now - mergedAt > maxAgeMs) continue;
    out.push({
      key: r.key, site: r.site, issue: r.issue, host: r.host, repo: r.repo, cls: r.cls,
      model: r.model, mergeSha: pr.mergeCommit, prUrl: pr.url, mergedAt,
      startedAt: r.startedAt || r.firstSeen,
    });
  }
  return out.sort((a, b) => a.mergedAt - b.mergedAt);
}

/** Record the sampling decision on a live row. False when the row is gone. */
function decideShadow(key, decision, now = Date.now()) {
  const prev = rows.get(key);
  if (!prev || prev.kind === "shadow" || prev.shadow) return false;
  const shadow = sanitizeShadowDecision(decision);
  if (!shadow) return false;
  const changed = new Map();
  commit(prev, { ...prev, shadow }, now, changed);
  persistChanged(changed, now);
  return changed.size > 0;
}

/** Shadows dispatched at or after `since` (the daily cap's count). */
function shadowsDispatchedSince(since) {
  let n = 0;
  for (const r of rows.values()) if (r.shadow && r.shadow.sampled && r.shadow.at >= since) n += 1;
  return n;
}

/**
 * Fold the agents' shadow reports: [{site, host, id, state, modelActual,
 * startedAt, endedAt, grade}]. A report counts only for a shadow the hub
 * dispatched to THAT host for THAT org (the id is hub-minted); anything else is
 * dropped. A grade, once recorded, is final.
 */
function observeShadows(reports, now = Date.now()) {
  if (!Array.isArray(reports) || backend.loaded === false) return [];
  const byId = new Map();
  for (const r of rows.values()) if (r.shadow && r.shadow.sampled) byId.set(r.shadow.id, r);
  const changed = new Map();
  for (const o of reports) {
    if (!o || typeof o !== "object" || typeof o.id !== "string") continue;
    const live = byId.get(o.id);
    if (!live || live.site !== o.site || live.shadow.host !== o.host) continue;
    const key = rowKey(live.site, live.issue, o.host, o.id);
    const prev = rows.get(key);
    const next = prev ? { ...prev } : {
      site: live.site, issue: live.issue, host: o.host, sid: o.id, kind: "shadow",
      pairOf: live.key, cls: live.cls, model: live.shadow.model || "default",
      repo: live.repo, firstSeen: now, updatedAt: now,
    };
    const actual = modelFamily(o.modelActual);
    if (actual) { next.model = actual; next.modelKnown = true; }
    if (SHADOW_STATES.has(o.state) && next.shadowState !== "graded") next.shadowState = o.state;
    const started = timeOf(o.startedAt);
    if (started && !next.startedAt) next.startedAt = started;
    const ended = timeOf(o.endedAt);
    if (ended && !next.endedAt) next.endedAt = ended;
    if (!next.grade) {
      const grade = sanitizeGrade(o.grade);
      if (grade) { next.grade = grade; next.shadowState = "graded"; }
    }
    commit(prev, next, now, changed);
  }
  return persistChanged(changed, now);
}

function mergePrs(row, prs, now) {
  if (!Array.isArray(prs)) return;
  const list = row.prs ? row.prs : [];
  for (const raw of prs) {
    const p = sanitizePr(raw);
    if (!p) continue;
    let cur = list.find((x) => x.url === p.url);
    if (!cur) {
      if (list.length >= PRS_MAX) continue;
      cur = { url: p.url };
      list.push(cur);
    }
    // Rework counters only rise (a stale read never lowers one); the merge
    // commit is set once. Both are read even past MERGED — a PR first seen
    // merged, or merged before an agent that reports them, still gets them.
    for (const k of ["ciRounds", "changesRequested"]) {
      if (p[k] !== undefined && !(cur[k] >= p[k])) cur[k] = p[k];
    }
    if (p.mergeCommit && !cur.mergeCommit && (p.state === "MERGED" || cur.state === "MERGED")) {
      cur.mergeCommit = p.mergeCommit;
    }
    // The agent's own merge time beats a sighting: a PR already merged when the
    // ledger first saw it was dated at that sighting (XERK-1845 comment 2). A
    // session's PR cannot have merged before the session started (nor after
    // now), so such a time is junk and is ignored — before the start it would
    // open the window at once, in the future it would hold it open.
    const floor = row.startedAt || row.firstSeen - WINDOW_DAYS * DAY_MS;
    const plausible = p.mergedAt && p.mergedAt >= floor && p.mergedAt <= now;
    if (cur.state === "MERGED" && plausible && p.mergedAt < (cur.mergedAt || Infinity)) {
      cur.mergedAt = p.mergedAt;
    }
    // MERGED is terminal: a later read never moves it back.
    if (cur.state === "MERGED") continue;
    if (p.state) cur.state = p.state;
    if (cur.state === "MERGED" && !cur.mergedAt) {
      cur.mergedAt = plausible ? p.mergedAt : now;
    }
    if (cur.state === "CLOSED" && !cur.closedAt) cur.closedAt = p.closedAt || now;
    if (cur.state !== "CLOSED") delete cur.closedAt;
  }
  if (list.length) row.prs = list;
}

function commit(prev, next, now, changed) {
  const clean = sanitizeRow({ ...next, updatedAt: prev ? prev.updatedAt : now });
  if (!clean) return;
  if (prev && JSON.stringify(clean) === JSON.stringify(prev)) return;
  clean.updatedAt = now;
  rows.set(clean.key, clean);
  changed.set(clean.key, clean);
}

// Drop rows past retention, then any host past its share, then — past MAX_ROWS —
// the oldest row of whichever org holds the most. Returns the keys dropped.
function evict(now = Date.now()) {
  const cutoff = now - RETAIN_DAYS * DAY_MS;
  const dropped = [];
  const drop = (r) => { rows.delete(r.key); dropped.push(r.key); };
  const byHost = new Map();
  for (const r of rows.values()) {
    if (r.updatedAt < cutoff) { drop(r); continue; }
    if (!byHost.has(r.host)) byHost.set(r.host, []);
    byHost.get(r.host).push(r);
  }
  for (const list of byHost.values()) {
    if (list.length <= HOST_MAX_ROWS) continue;
    list.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const r of list.slice(0, list.length - HOST_MAX_ROWS)) drop(r);
  }
  let over = rows.size - MAX_ROWS;
  if (over <= 0) return dropped;
  const bySite = new Map();
  for (const r of rows.values()) {
    if (!bySite.has(r.site)) bySite.set(r.site, []);
    bySite.get(r.site).push(r);
  }
  for (const list of bySite.values()) list.sort((a, b) => b.updatedAt - a.updatedAt); // oldest last
  while (over > 0) {
    let big = null;
    for (const list of bySite.values()) if (!big || list.length > big.length) big = list;
    drop(big.pop());
    over -= 1;
  }
  return dropped;
}

// ---- reads ---------------------------------------------------------------------

/**
 * A row's outcome: {outcome, reason}. bad = a signal the work was wrong; good =
 * merged and the defect window passed clean; pending = not decided yet;
 * no-change = the session closed the ticket as stale (no code to judge);
 * undelivered = ended with nothing (no PR, no close).
 */
function outcomeOf(r, now = Date.now(), windowDays = WINDOW_DAYS) {
  // A shadow never merges: its outcome is its grader's verdict (XERK-1847).
  if (r.kind === "shadow") {
    if (r.grade) return { outcome: r.grade.verdict, reason: "shadow graded" };
    if (r.shadowState === "failed") return { outcome: "undelivered", reason: "shadow failed" };
    return { outcome: "pending", reason: "shadow running" };
  }
  if (r.reopenedAt) return { outcome: "bad", reason: "reopened" };
  // A later fix blamed this work (XERK-1846): a revert of it, or a bug fix.
  if (r.defects && r.defects.length) {
    return { outcome: "bad", reason: r.defects.some((d) => d.kind === "revert") ? "reverted" : "defect" };
  }
  const prs = r.prs || [];
  const merged = prs.filter((p) => p.state === "MERGED");
  if (merged.length) {
    const first = Math.min(...merged.map((p) => p.mergedAt || r.updatedAt));
    if (now - first >= windowDays * DAY_MS) return { outcome: "good", reason: "merged, window clean" };
    return { outcome: "pending", reason: "merged, in window" };
  }
  if (prs.length && prs.every((p) => p.state === "CLOSED")) return { outcome: "bad", reason: "closed unmerged" };
  if (prs.length) return { outcome: "pending", reason: "PR open" };
  if (r.closeKind === "not-reproducible" || r.closeKind === "already-fixed") {
    return { outcome: "no-change", reason: r.closeKind };
  }
  if (r.closeKind === "done") return { outcome: "pending", reason: "closed without a PR" };
  if (r.endedAt) return { outcome: "undelivered", reason: "ended with no PR" };
  return { outcome: "pending", reason: "running" };
}

const OUTCOMES = ["good", "bad", "pending", "no-change", "undelivered"];

/**
 * A row's rework signals (XERK-1845), each null when nothing reported it: QA
 * runs + failed ones, CI red→green rounds and changes-requested reviews summed
 * over its PRs (only PRs that carried the counter).
 */
function reworkOf(r) {
  const sum = (k) => {
    const vals = (r.prs || []).map((p) => p[k]).filter((v) => typeof v === "number");
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  return {
    qaRuns: r.qa && !r.qa.incomplete ? r.qa.runs : null,
    qaFail: r.qa && !r.qa.incomplete ? r.qa.fail : null,
    ciRounds: sum("ciRounds"),
    changesRequested: sum("changesRequested"),
  };
}

function median(vals) {
  const v = [...vals].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * The served view. Groups are fleet-wide per (class, model). `site` narrows the
 * served ROWS to one org (and only then are rows served at all).
 */
function aggregate({ site = null, withRows = false, now = Date.now(), windowDays = WINDOW_DAYS } = {}) {
  const groups = new Map();
  const served = [];
  const shadows = [];
  for (const r of rows.values()) {
    const { outcome, reason } = outcomeOf(r, now, windowDays);
    if (withRows && site && r.site === site && r.kind === "shadow") served.push({ ...r, outcome, reason });
    // Shadow rows never feed the live groups (ADR: they never merge).
    if (r.kind === "shadow") { shadows.push(r); continue; }
    const gk = `${r.cls}\u0000${r.model}`;
    let g = groups.get(gk);
    if (!g) {
      g = { cls: r.cls, model: r.model, sessions: 0, reasons: {}, rework: {} };
      for (const o of OUTCOMES) g[o] = 0;
      groups.set(gk, g);
    }
    g.sessions += 1;
    g[outcome] += 1;
    for (const [k, v] of Object.entries(reworkOf(r))) {
      if (v === null) continue;
      (g.rework[k] || (g.rework[k] = [])).push(v);
    }
    if (outcome === "bad") g.reasons[reason] = (g.reasons[reason] || 0) + 1;
    if (withRows && site && r.site === site) served.push({ ...r, outcome, reason });
  }
  // Rework is REPORTED beside the outcome, never part of good/bad (ADR): per
  // signal, the median over the sessions that reported it, and how many did.
  for (const g of groups.values()) {
    const rework = {};
    for (const [k, vals] of Object.entries(g.rework)) rework[k] = { median: median(vals), n: vals.length };
    g.rework = rework;
  }
  const out = {
    windowDays,
    groups: [...groups.values()].sort((a, b) => b.sessions - a.sessions
      || a.cls.localeCompare(b.cls) || a.model.localeCompare(b.model)),
    pairs: pairsOf(shadows, now, windowDays),
  };
  // The XERK-1849 report reads the paired evidence per group, as `shadow`. A
  // candidate that ran no live session still shows, as a zero-session group.
  for (const p of out.pairs) {
    let g = out.groups.find((x) => x.cls === p.cls && x.model === p.model);
    if (!g) {
      g = { cls: p.cls, model: p.model, sessions: 0, reasons: {}, rework: {} };
      for (const o of OUTCOMES) g[o] = 0;
      out.groups.push(g);
    }
    g.shadow = { pairs: p.pairs, candidateOnlyBad: p.mOnlyFail, graded: p.graded,
      shadowGood: p.shadowGood, shadowBad: p.shadowBad, failed: p.failed };
  }
  if (withRows && site) {
    served.sort((a, b) => b.updatedAt - a.updatedAt);
    out.rows = served.slice(0, ROWS_SERVED_MAX);
  }
  return out;
}

/**
 * Paired evidence per (class, candidate model), fleet-wide (XERK-1847): each
 * shadow row against the live row it re-ran. `mOnlyFail` = the shadow graded
 * bad while the live work is not bad — the promotion rule's numerator.
 */
function pairsOf(shadows, now, windowDays) {
  const pairs = new Map();
  for (const r of shadows) {
    const live = r.pairOf ? rows.get(r.pairOf) : null;
    if (!live) continue;
    const gk = `${r.cls}\u0000${r.model}`;
    let p = pairs.get(gk);
    if (!p) {
      p = { cls: r.cls, model: r.model, pairs: 0, graded: 0, shadowGood: 0, shadowBad: 0,
        mOnlyFail: 0, failed: 0 };
      pairs.set(gk, p);
    }
    p.pairs += 1;
    if (r.grade) {
      p.graded += 1;
      if (r.grade.verdict === "good") p.shadowGood += 1;
      else {
        p.shadowBad += 1;
        if (outcomeOf(live, now, windowDays).outcome !== "bad") p.mOnlyFail += 1;
      }
    } else if (r.shadowState === "failed") p.failed += 1;
  }
  return [...pairs.values()].sort((a, b) => b.pairs - a.pairs
    || a.cls.localeCompare(b.cls) || a.model.localeCompare(b.model));
}

// ---- routing policy evidence (XERK-1848) ------------------------------------

/**
 * The 95% Wilson score interval for k successes in n trials: {lower, upper}.
 * n = 0 says nothing, so the interval is the whole [0, 1].
 */
function wilson(k, n, z = 1.96) {
  if (!(n > 0)) return { lower: 0, upper: 1 };
  const p = Math.min(Math.max(k, 0), n) / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z / (1 + z2 / n)) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

/**
 * The promotion rule (ADR "Routing policy"): at least `minPairs` graded shadow
 * pairs, and candidate-only failures at most `maxRate` of them with a 95% Wilson
 * upper bound at most `maxUpper`.
 */
function promotionPasses(graded, mOnlyFail, { minPairs = 40, maxRate = 0.05, maxUpper = 0.10 } = {}) {
  if (!(graded >= minPairs)) return false;
  return mOnlyFail / graded <= maxRate && wilson(mOnlyFail, graded).upper <= maxUpper;
}

/**
 * Graded shadow pairs for (class, candidate model) whose grade landed at or
 * after `since` (the grade's own time, else the row's last update): {graded,
 * mOnlyFail}, counted as `pairsOf` counts them. A demotion re-promotes only on
 * these — never on count deltas, which fall when rows are evicted or a live row
 * later goes bad.
 */
function pairEvidence(cls, model, { since = 0, now = Date.now(), windowDays = WINDOW_DAYS } = {}) {
  let graded = 0, mOnlyFail = 0;
  for (const r of rows.values()) {
    if (r.kind !== "shadow" || r.cls !== cls || r.model !== model || !r.grade) continue;
    if ((r.grade.at || r.updatedAt) < since) continue;
    const live = r.pairOf ? rows.get(r.pairOf) : null;
    if (!live) continue;
    graded += 1;
    if (r.grade.verdict !== "good" && outcomeOf(live, now, windowDays).outcome !== "bad") mOnlyFail += 1;
  }
  return { graded, mOnlyFail };
}

/**
 * The live bad rate of (class, model) for the tripwire: {bad, n} over live rows
 * that started after `since` (all of them when `since` is 0). n counts the rows with something to judge —
 * bad, good, or merged and still inside the defect window — so a model is not
 * read as all-bad just because `good` needs the whole window to elapse; the Opus
 * baseline is read the same way.
 */
function liveRate(cls, model, { since = 0, now = Date.now(), windowDays = WINDOW_DAYS } = {}) {
  let bad = 0, n = 0;
  for (const r of rows.values()) {
    if (r.kind === "shadow" || r.cls !== cls || r.model !== model) continue;
    // Strictly after: work started in the promotion's own millisecond was not
    // routed by it.
    if (since && (r.startedAt || r.firstSeen) <= since) continue;
    const { outcome, reason } = outcomeOf(r, now, windowDays);
    if (outcome === "bad") { bad += 1; n += 1; }
    else if (outcome === "good" || reason === "merged, in window") n += 1;
  }
  return { bad, n };
}

/** Per (class, model, outcome) counts for /metrics (no host, ticket or session). */
function metricsText(now = Date.now()) {
  // Bounded label sets: models outside the known families read "other", and only
  // the largest METRIC_CLASSES_MAX classes keep their name.
  const merged = new Map();
  // Live sessions only: a candidate's zero-session shadow-evidence group has no outcome.
  const raw = aggregate({ now }).groups.filter((g) => g.sessions > 0);
  const classTotals = new Map();
  for (const g of raw) classTotals.set(g.cls, (classTotals.get(g.cls) || 0) + g.sessions);
  const keep = new Set([...classTotals].sort((a, b) => b[1] - a[1]).slice(0, METRIC_CLASSES_MAX)
    .map(([c]) => c));
  for (const g of raw) {
    const cls = keep.has(g.cls) ? g.cls : "other";
    const model = METRIC_MODELS.has(g.model) ? g.model : "other";
    const k = `${cls}\u0000${model}`;
    const m = merged.get(k) || { cls, model };
    for (const o of OUTCOMES) m[o] = (m[o] || 0) + g[o];
    merged.set(k, m);
  }
  let out = "# HELP turma_model_outcomes Ticket sessions in the outcome ledger, by work " +
    "class, model and outcome.\n# TYPE turma_model_outcomes gauge\n";
  for (const g of merged.values()) {
    for (const o of OUTCOMES) {
      out += `turma_model_outcomes{class="${g.cls}",model="${g.model}",outcome="${o}"} ${g[o]}\n`;
    }
  }
  return out;
}

// ---- the file backend (non-HA) ---------------------------------------------------

function load() {
  rows = new Map();
  try {
    const size = fs.statSync(LEDGER_FILE).size;
    if (size > FILE_MAX_BYTES) throw new Error(`outcome ledger is ${size} bytes, over the ${FILE_MAX_BYTES} limit — starting empty`);
    const parsed = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
    const list = parsed && Array.isArray(parsed.rows) ? parsed.rows : null;
    if (!list) throw new Error("no `rows` array");
    for (const raw of list) {
      const r = sanitizeRow(raw);
      if (r) rows.set(r.key, r);
    }
    evict();
  } catch (e) {
    if (!e || e.code !== "ENOENT") {
      rows = new Map();
      console.error(`outcome ledger restore skipped: ${(e && e.message) || e}`);
    }
  }
}

let saveTimer = null;
let writing = null;
function writeNow(done) {
  const snapshot = [...rows.values()];
  const run = async () => {
    await fs.promises.mkdir(path.dirname(LEDGER_FILE), { recursive: true });
    const tmp = `${LEDGER_FILE}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify({ version: 1, rows: snapshot }), "utf8");
    await fs.promises.rename(tmp, LEDGER_FILE);
  };
  // One save at a time; never rejects out (a rejection out of a timer exits the hub).
  writing = Promise.resolve(writing).then(run).catch((e) => {
    console.error(`outcome ledger save failed: ${(e && e.message) || e}`);
    return e;
  }).then((e) => { if (done) done(e instanceof Error ? e : null); return null; });
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, SAVE_DEBOUNCE_MS);
  saveTimer.unref();
}

const fileBackend = {
  onChange() { scheduleSave(); },
  flush(done) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    writeNow(done);
  },
  async close() {},
};
backend = fileBackend;

// ---- the Postgres backend (HA) ---------------------------------------------------

const T_ROW = "outcome_session";
const PG_QUEUE_MAX = 5000;
const PG_ROWS_PER_INSERT = 500;           // 3 params a row
const RESCAN_RETRY_MS = 60000;

class OutcomeLedgerPgStore {
  constructor(pool, cfg = {}) {
    this.pool = pool;
    const { quoteIdent } = require("./pgclient.js");
    this.table = quoteIdent(T_ROW);
    this._queue = [];
    this._draining = null;
    this._closed = false;
    this._offHealth = null;
    this._readyWork = null;
    this._schemaReady = false;
    this._onExternalChange = typeof cfg.onExternalChange === "function" ? cfg.onExternalChange : null;
    // False until a rescan has read the table into the model; observe() waits on it.
    this.loaded = false;
    this._deletes = [];
  }

  async init() {
    if (typeof this.pool.onHealth === "function") {
      this._offHealth = this.pool.onHealth((h) => { if (h === "ready" && !this._closed) this._onReady(); });
    }
    if (typeof this.pool.ready === "function") {
      this.pool.ready().then(() => this._onReady()).catch((e) => {
        console.error(`outcome ledger: Postgres not reachable at boot: ${(e && e.message) || e}`);
      });
    } else if (this.pool.health === "ready") {
      await this._onReady();
    }
  }

  retryLoad(now = Date.now()) {
    if (this._closed || this._readyWork || now - (this._lastRetry || 0) < RESCAN_RETRY_MS) return;
    this._lastRetry = now;
    this._onReady();
  }

  _onReady() {
    if (this._closed) return Promise.resolve();
    if (this._readyWork) return this._readyWork;
    this._readyWork = (async () => {
      try {
        await this._ensureSchema();
        await this._drain();
        await this.rescan();
      } catch (e) {
        console.error(`outcome ledger: Postgres ready-work failed: ${(e && e.message) || e}`);
      } finally {
        this._readyWork = null;
      }
    })();
    return this._readyWork;
  }

  async _ensureSchema() {
    if (this._schemaReady) return;
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         key text PRIMARY KEY,
         updated_at bigint NOT NULL,
         doc text NOT NULL
       )`);
    this._schemaReady = true;
  }

  // Load every row into the hot model. Newest wins: a hot row changed more
  // recently than the table's copy (a write held back by an outage) is kept and
  // re-queued; a hot row the table lacks is re-queued too.
  async rescan(now = Date.now()) {
    this.loaded = false;
    await this._ensureSchema();
    const got = (await this.pool.query(
      `SELECT doc FROM ${this.table} ORDER BY updated_at DESC LIMIT $1`, [String(MAX_ROWS)])) || [];
    const held = new Set();
    const stale = [];
    for (const g of got) {
      let doc = null;
      try { doc = JSON.parse(g.doc); } catch { continue; }
      const r = sanitizeRow(doc);
      if (!r) continue;
      held.add(r.key);
      const hot = rows.get(r.key);
      if (hot && hot.updatedAt > r.updatedAt) { stale.push(hot); continue; }
      rows.set(r.key, r);
    }
    const dropped = evict(now);
    for (const r of rows.values()) if (!held.has(r.key)) stale.push(r);
    if (stale.length) this.onChange(stale);
    if (dropped.length) this.onDelete(dropped);
    this.loaded = true;
    if (this._onExternalChange) { try { this._onExternalChange(); } catch { /* never breaks a scan */ } }
  }

  onChange(list) {
    for (const r of list) this._queue.push([r.key, String(r.updatedAt), JSON.stringify(r)]);
    const over = this._queue.length - PG_QUEUE_MAX;
    if (over > 0) this._queue.splice(0, over);
    this._drain();
  }

  // Rows evicted from the model leave the table too, so it stays as bounded as the model.
  onDelete(keys) {
    this._deletes.push(...keys);
    if (this._deletes.length > PG_QUEUE_MAX) this._deletes.splice(0, this._deletes.length - PG_QUEUE_MAX);
    this._drain();
  }

  _drain() {
    if (this._draining) return this._draining;
    if (this._closed || (!this._queue.length && !this._deletes.length)) return Promise.resolve();
    this._draining = (async () => {
      await null;
      try {
        while (this._queue.length) {
          const raw = this._queue.splice(0, PG_ROWS_PER_INSERT);
          const byKey = new Map();
          for (const vals of raw) byKey.set(vals[0], vals);
          const batch = [...byKey.values()];
          const params = [];
          const tuples = batch.map((vals) => `(${vals.map((v) => { params.push(v); return `$${params.length}`; }).join(", ")})`);
          try {
            await this._ensureSchema();
            await this.pool.query(
              `INSERT INTO ${this.table} (key, updated_at, doc) VALUES ${tuples.join(", ")} ` +
              `ON CONFLICT (key) DO UPDATE SET updated_at = EXCLUDED.updated_at, doc = EXCLUDED.doc ` +
              `WHERE EXCLUDED.updated_at >= ${this.table}.updated_at`,
              params);
          } catch (e) {
            this._queue.unshift(...batch);
            console.error(`outcome ledger: Postgres write failed (${(e && e.message) || e}); ${batch.length} row(s) held for retry`);
            return;
          }
        }
        while (this._deletes.length) {
          const batch = this._deletes.splice(0, PG_ROWS_PER_INSERT);
          try {
            await this.pool.query(
              `DELETE FROM ${this.table} WHERE key IN (${batch.map((_, i) => `$${i + 1}`).join(", ")})`,
              batch);
          } catch (e) {
            this._deletes.unshift(...batch);
            console.error(`outcome ledger: Postgres delete failed (${(e && e.message) || e}); held for retry`);
            return;
          }
        }
      } finally {
        this._draining = null;
      }
    })();
    return this._draining;
  }

  flush(done) {
    Promise.resolve(this._drain()).then(() => done && done(null), (e) => done && done(e));
  }

  async close() {
    this._closed = true;
    if (this._offHealth) { try { this._offHealth(); } catch { /* best effort */ } this._offHealth = null; }
  }
}

async function configure(haConfig, pgClient, onExternalChange) {
  if (!haConfig || !haConfig.ha) return;
  if (!pgClient) {
    console.error("outcome ledger: HA is on but no Postgres client was provided — staying on the local file (DEGRADED)");
    return;
  }
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const b = new OutcomeLedgerPgStore(pgClient, { onExternalChange });
  backend = b;
  await b.init();
  console.log(`outcome ledger: using Postgres (${T_ROW}) for the durable rows`);
}

function rehydrate() {
  return backend.rescan ? backend.rescan() : Promise.resolve();
}

function flush(done) { backend.flush(done); }

load();

module.exports = {
  observe, attributeDefects, sanitizeDefectReports, aggregate, outcomeOf, metricsText, workClass, modelFamily, sanitizeRow,
  shadowCandidates, decideShadow, shadowsDispatchedSince, observeShadows, SHADOW_ID_RE,
  wilson, promotionPasses, liveRate, pairEvidence,
  configure, rehydrate, flush,
  LEDGER_FILE, MAX_ROWS, WINDOW_DAYS, RETAIN_DAYS, T_ROW, OutcomeLedgerPgStore,
  _internals: {
    rows: () => rows,
    load, writeNow,
    reset() {
      rows = new Map();
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (backend !== fileBackend) { try { backend.close(); } catch { /* noop */ } }
      backend = fileBackend;
    },
    getBackend: () => backend,
    setBackend(b) { backend = b; },
  },
};
