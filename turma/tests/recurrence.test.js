// Unit tests for the recurrence rule whitelist and its expansion (XERK-2969,
// turma/recurrence.js): DST transitions, month-end and nth-weekday rules,
// until/count, the serve-range cut and the expansion bounds.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const r = require("../recurrence.js");

const NY = "America/New_York";
const ms = (s) => Date.parse(s);
const series = (start, end, rule, timeZone = NY) => ({ startMs: ms(start), endMs: ms(end), timeZone, rule });
const keys = (s, lo, hi, max = 100) => r.occurrences(s, lo, hi, max).map((o) => o.key);
const local = (o, tz = NY) => new Date(r.wallOf(o.startMs, tz)).toISOString().slice(0, 16);

test("XERK-2969: a weekly 9:00 stays 9:00 local across both DST transitions", () => {
  const s = series("2026-10-26T09:00:00-04:00", "2026-10-26T10:00:00-04:00", { freq: "weekly", interval: 1 });
  const occ = r.occurrences(s, ms("2026-10-01T00:00:00Z"), ms("2026-11-10T00:00:00Z"), 10);
  assert.deepEqual(occ.map((o) => o.key), ["2026-10-26T13:00:00Z", "2026-11-02T14:00:00Z", "2026-11-09T14:00:00Z"]);
  assert.deepEqual(occ.map((o) => local(o)), ["2026-10-26T09:00", "2026-11-02T09:00", "2026-11-09T09:00"]);
  for (const o of occ) assert.equal(o.endMs - o.startMs, 3600e3);
  // Spring forward: March 2027.
  const spring = keys(series("2027-03-01T09:00:00-05:00", "2027-03-01T09:30:00-05:00", { freq: "weekly", interval: 1 }),
    ms("2027-03-01T00:00:00Z"), ms("2027-03-20T00:00:00Z"));
  assert.deepEqual(spring, ["2027-03-01T14:00:00Z", "2027-03-08T14:00:00Z", "2027-03-15T13:00:00Z"]);
});

test("XERK-2969: a time the spring-forward skips reads an hour later and keeps its length; a repeated one is its first", () => {
  const gap = r.occurrences(series("2026-03-07T02:30:00-05:00", "2026-03-07T03:00:00-05:00", { freq: "daily", interval: 1, count: 3 }),
    0, Infinity, 5);
  assert.deepEqual(gap.map((o) => o.key), ["2026-03-07T07:30:00Z", "2026-03-08T07:30:00Z", "2026-03-09T06:30:00Z"]);
  assert.deepEqual(gap.map((o) => o.endMs - o.startMs), [18e5, 18e5, 18e5], "never an end before its start");
  const back = r.occurrences(series("2026-10-31T01:30:00-04:00", "2026-10-31T02:00:00-04:00", { freq: "daily", interval: 1, count: 2 }),
    0, Infinity, 5);
  assert.equal(back[1].key, "2026-11-01T05:30:00Z", "1:30 on the fall-back day is the first (EDT) 1:30");
  // A zone east of +12 (Auckland's DST starts the last Sunday of September).
  const nz = keys(series("2026-09-24T09:00:00+12:00", "2026-09-24T10:00:00+12:00", { freq: "weekly", interval: 1, count: 2 }, "Pacific/Auckland"),
    0, Infinity);
  assert.deepEqual(nz, ["2026-09-23T21:00:00Z", "2026-09-30T20:00:00Z"]);
});

test("XERK-2969: the 31st clamps to each month's last day; nth and last weekday", () => {
  const s = series("2027-01-31T09:00:00-05:00", "2027-01-31T10:00:00-05:00", { freq: "monthly", interval: 1, count: 5 });
  assert.deepEqual(r.occurrences(s, 0, Infinity, 10).map((o) => local(o).slice(0, 10)),
    ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]);
  const leap = series("2028-02-29T12:00:00Z", "2028-02-29T13:00:00Z", { freq: "yearly", interval: 1, count: 3 }, "UTC");
  assert.deepEqual(keys(leap, 0, Infinity), ["2028-02-29T12:00:00Z", "2029-02-28T12:00:00Z", "2030-02-28T12:00:00Z"]);
  const second = series("2026-11-10T15:00:00-05:00", "2026-11-10T16:00:00-05:00",
    { freq: "monthly", interval: 1, byWeekday: { n: 2, day: "TU" } });
  assert.deepEqual(r.occurrences(second, 0, ms("2027-02-01T00:00:00Z"), 10).map((o) => local(o).slice(0, 10)),
    ["2026-11-10", "2026-12-08", "2027-01-12"]);
  const lastFri = series("2026-11-27T15:00:00-05:00", "2026-11-27T16:00:00-05:00",
    { freq: "monthly", interval: 2, byWeekday: { n: -1, day: "FR" } });
  assert.deepEqual(r.occurrences(lastFri, 0, ms("2027-04-01T00:00:00Z"), 10).map((o) => local(o).slice(0, 10)),
    ["2026-11-27", "2027-01-29", "2027-03-26"]);
});

test("XERK-2969: weekdays, every other week, until (inclusive, local) and count", () => {
  const wk = series("2026-11-16T09:00:00-05:00", "2026-11-16T09:15:00-05:00",
    { freq: "weekly", interval: 2, byDay: ["MO", "WE", "FR"], until: "2026-12-02" });
  assert.deepEqual(r.occurrences(wk, 0, Infinity, 50).map((o) => local(o).slice(0, 10)),
    ["2026-11-16", "2026-11-18", "2026-11-20", "2026-11-30", "2026-12-02"]);
  const weekdays = series("2026-11-20T09:00:00-05:00", "2026-11-20T09:15:00-05:00",
    { freq: "daily", interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"], count: 3 });
  assert.deepEqual(r.occurrences(weekdays, 0, Infinity, 50).map((o) => local(o).slice(0, 10)),
    ["2026-11-20", "2026-11-23", "2026-11-24"]);
  // A start that is not on the rule's days: the anchor sets the time, the rule the days.
  assert.equal(local(r.occurrences(series("2026-11-18T09:00:00-05:00", "2026-11-18T10:00:00-05:00",
    { freq: "weekly", interval: 1, byDay: ["MO"] }), 0, Infinity, 1)[0]), "2026-11-23T09:00");
});

test("XERK-2969: expansion covers only the asked range, from far away, and is bounded", () => {
  const s = series("2020-01-01T09:00:00-05:00", "2020-01-01T10:00:00-05:00", { freq: "daily", interval: 1 });
  const lo = ms("2031-06-01T00:00:00Z"), hi = lo + 100 * 864e5;
  const occ = r.occurrences(s, lo, hi, 1000);
  assert.equal(occ.length, 100);
  assert.ok(occ.every((o) => o.startMs >= lo && o.startMs < hi));
  assert.equal(r.occurrences(s, lo, hi, 7).length, 7, "max cuts it");
  // Monthly from years back lands on the right month (no skip-ahead overshoot).
  const m = series("2020-01-15T12:00:00Z", "2020-01-15T13:00:00Z", { freq: "monthly", interval: 1 }, "UTC");
  assert.deepEqual(keys(m, ms("2030-03-01T00:00:00Z"), ms("2030-05-01T00:00:00Z")), ["2030-03-15T12:00:00Z", "2030-04-15T12:00:00Z"]);
  // A rule with no occurrence in its until window costs at most PERIODS_MAX periods.
  const never = series("2026-11-16T09:00:00Z", "2026-11-16T10:00:00Z", { freq: "yearly", interval: 1, until: "2026-11-01" }, "UTC");
  assert.deepEqual(keys(never, 0, Infinity), []);
});

test("XERK-2969: occurrenceAt and localDate", () => {
  const s = series("2026-10-26T09:00:00-04:00", "2026-10-26T10:00:00-04:00", { freq: "weekly", interval: 1 });
  assert.equal(r.occurrenceAt(s, "2026-11-02T14:00:00Z").startMs, ms("2026-11-02T14:00:00Z"));
  for (const bad of ["2026-11-02T13:00:00Z", "2026-11-02T14:00:00.000Z", "2026-10-19T13:00:00Z", "nope", 5]) {
    assert.equal(r.occurrenceAt(s, bad), null, String(bad));
  }
  assert.equal(r.localDate(ms("2026-11-02T03:00:00Z"), NY, -1), "2026-10-31");
});

test("XERK-2969: ruleError refuses in words; sanitizeRule is a fixed point", () => {
  for (const bad of [null, [], { freq: "hourly" }, { freq: "weekly", interval: 0 }, { freq: "weekly", byDay: [] },
    { freq: "weekly", byDay: ["MO", "MO"] }, { freq: "monthly", byDay: ["MO"] }, { freq: "weekly", byMonthDay: 3 },
    { freq: "monthly", byMonthDay: 32 }, { freq: "monthly", byMonthDay: 1, byWeekday: { n: 1, day: "MO" } },
    { freq: "monthly", byWeekday: { n: 5, day: "MO" } }, { freq: "daily", until: "2026-02-30" },
    { freq: "daily", until: "2027-01-01", count: 3 }, { freq: "daily", count: 1000 }, { freq: "daily", tz: "x" }]) {
    assert.equal(typeof r.ruleError(bad), "string", JSON.stringify(bad));
    assert.equal(r.sanitizeRule(bad), null);
  }
  const rule = r.sanitizeRule({ count: 4, byDay: ["FR", "MO"], freq: "weekly" });
  assert.deepEqual(rule, { freq: "weekly", interval: 1, byDay: ["MO", "FR"], count: 4 });
  assert.equal(JSON.stringify(r.sanitizeRule(JSON.parse(JSON.stringify(rule)))), JSON.stringify(rule));
});

test("XERK-2969: a count series skips straight to the range (never walked from its start) and agrees with a full walk", () => {
  for (const rule of [{ freq: "daily", interval: 3, byDay: ["MO", "WE"], count: 50 }, { freq: "weekly", interval: 2, byDay: ["SU", "TH"], count: 40 },
    { freq: "monthly", interval: 1, byMonthDay: 5, count: 30 }, { freq: "yearly", interval: 1, byWeekday: { n: -1, day: "MO" }, count: 9 },
    { freq: "daily", interval: 1, count: 999 }]) {
    const s = series("2024-01-20T09:00:00-05:00", "2024-01-20T10:00:00-05:00", rule);
    const lo = ms("2025-06-01T00:00:00Z"), hi = ms("2026-06-01T00:00:00Z");
    const all = keys(s, 0, Infinity, 2000).filter((k) => ms(k) >= lo && ms(k) < hi);
    assert.deepEqual(keys(s, lo, hi, 2000), all, JSON.stringify(rule));
  }
  // A month of a 999-count daily series, and one exception check, cost a few zone
  // lookups — not one per occurrence since the start (QA: 73 ms a series, 17 s a GET).
  // Counted as Intl calls, not wall time, so a loaded CI runner cannot flake it.
  // 09:37 so no earlier test has warmed the zone cache for these instants.
  const s = series("2024-01-01T09:37:00-05:00", "2024-01-01T10:37:00-05:00", { freq: "daily", interval: 1, count: 999 });
  const real = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  Intl.DateTimeFormat.prototype.formatToParts = function (...a) { calls++; return real.apply(this, a); };
  try {
    assert.equal(r.occurrences(s, ms("2026-08-01T00:00:00Z"), ms("2026-09-01T00:00:00Z"), 100).length, 31);
    assert.ok(r.occurrenceAt(s, "2026-09-20T13:37:00Z"));
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = real;
  }
  assert.ok(calls < 31 * 8 + 100, `${calls} zone lookups`);
  // A byDay the interval never meets has no occurrence, found without walking PERIODS_MAX.
  calls = 0;
  Intl.DateTimeFormat.prototype.formatToParts = function (...a) { calls++; return real.apply(this, a); };
  try {
    assert.deepEqual(keys({ ...s, rule: { freq: "daily", interval: 7, byDay: ["TU"] } }, 0, Infinity), []);
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = real;
  }
  assert.ok(calls < 10, `${calls} zone lookups for a rule that never meets its days`);
  assert.equal(r.occurrenceAt(null, "2026-09-20T13:00:00Z"), null, "no series, no occurrence");
});

test("XERK-2969: the cached zone offset equals Intl's at every minute around each transition (00:01 movers included)", () => {
  let checked = 0;
  for (const tz of ["America/St_Johns", "Asia/Gaza", "America/New_York", "Europe/London", "Australia/Lord_Howe",
    "Pacific/Chatham", "America/Santiago"]) {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric",
      day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    const off = (ms) => {
      const p = {};
      for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = Number(value);
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
    };
    // From 1985: St Johns moved at 00:01 until 2011, Gaza in 2010 — the cases a
    // whole-bucket cache got wrong.
    let prev = off(Date.UTC(1985, 0, 1));
    for (let day = Date.UTC(1985, 0, 2); day < Date.UTC(2031, 0, 1); day += 864e5) {
      const o = off(day);
      if (o === prev) continue;
      let lo = day - 864e5, hi = day;   // the transition minute, by bisection
      while (hi - lo > 6e4) { const mid = lo + Math.floor((hi - lo) / 12e4) * 6e4; if (off(mid) === prev) lo = mid; else hi = mid; }
      for (let t = hi - 30 * 6e4; t <= hi + 30 * 6e4; t += 6e4) { assert.equal(r.wallOf(t, tz), t + off(t), `${tz} ${new Date(t).toISOString()}`); checked++; }
      prev = o;
    }
  }
  assert.ok(checked > 5000);
});

test("XERK-2953: reanchorDays moves an explicit day with a moved anchor, so it is an occurrence of its own rule", () => {
  // 2027-07-31 is a Saturday, 2027-07-30 a Friday.
  assert.deepEqual(r.reanchorDays({ freq: "monthly", interval: 1, byMonthDay: 31 }, "2027-07-31", "2027-07-30"),
    { freq: "monthly", interval: 1, byMonthDay: 30 });
  // byDay shifts by the weekday delta, across the week's end too (Sat -> Sun is +1).
  assert.deepEqual(r.reanchorDays({ freq: "weekly", interval: 1, byDay: ["MO", "WE"] }, "2027-07-26", "2027-07-27").byDay, ["TU", "TH"]);
  assert.deepEqual(r.reanchorDays({ freq: "weekly", interval: 1, byDay: ["FR", "SA"] }, "2027-07-31", "2027-08-01").byDay, ["SU", "SA"]);
  assert.deepEqual(r.reanchorDays({ freq: "daily", interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"] }, "2027-07-30", "2027-07-23").byDay,
    ["MO", "TU", "WE", "TH", "FR"], "a whole-week move keeps the days");
  // byWeekday: the new date's weekday and nth; a 5th is the last; "last" stays last when it still is.
  assert.deepEqual(r.reanchorDays({ freq: "monthly", interval: 1, byWeekday: { n: 2, day: "TU" } }, "2027-07-13", "2027-07-14").byWeekday,
    { n: 2, day: "WE" });
  assert.deepEqual(r.reanchorDays({ freq: "monthly", interval: 1, byWeekday: { n: 4, day: "TU" } }, "2027-07-27", "2027-07-29").byWeekday,
    { n: -1, day: "TH" });
  assert.deepEqual(r.reanchorDays({ freq: "monthly", interval: 1, byWeekday: { n: -1, day: "TU" } }, "2027-07-27", "2027-07-26").byWeekday,
    { n: -1, day: "MO" });
  assert.deepEqual(r.reanchorDays({ freq: "monthly", interval: 1, byWeekday: { n: -1, day: "TU" } }, "2027-07-27", "2027-07-20").byWeekday,
    { n: 3, day: "TU" });
  // Implicit days and same-date edits are left alone.
  assert.equal(r.reanchorDays({ freq: "monthly", interval: 1 }, "2027-07-31", "2027-07-30").byMonthDay, undefined);
  const same = { freq: "monthly", interval: 1, byMonthDay: 31 };
  assert.equal(r.reanchorDays(same, "2027-07-31", "2027-07-31"), same);
  // Every re-anchored rule names its new anchor as an occurrence.
  for (const [rule, from, to] of [[{ freq: "monthly", interval: 1, byMonthDay: 31 }, "2027-07-31", "2027-07-30"],
    [{ freq: "weekly", interval: 1, byDay: ["MO", "WE"] }, "2027-07-26", "2027-07-24"],
    [{ freq: "weekly", interval: 2, byDay: ["MO", "WE"] }, "2027-07-26", "2027-07-27"],
    [{ freq: "weekly", interval: 2, byDay: ["MO", "WE"] }, "2027-07-26", "2027-08-02"],
    [{ freq: "yearly", interval: 1, byWeekday: { n: -1, day: "FR" } }, "2027-07-30", "2027-07-28"]]) {
    const re = r.sanitizeRule(r.reanchorDays(rule, from, to));
    const s = series(`${to}T09:00:00Z`, `${to}T10:00:00Z`, re, "UTC");
    assert.equal(keys(s, s.startMs, Infinity, 1)[0], `${to}T09:00:00Z`, JSON.stringify(re));
  }
  // Every N > 1 weeks, days carried across DIFFERENT week boundaries (weeks start Sunday) are
  // no one week's days: refused (null). Interval 1, or all days in the same week, re-anchor.
  assert.equal(r.reanchorDays({ freq: "weekly", interval: 2, byDay: ["FR", "SA"] }, "2027-07-31", "2027-08-01"), null);
  assert.equal(r.reanchorDays({ freq: "weekly", interval: 2, byDay: ["SU", "TU"] }, "2027-08-01", "2027-07-31"), null);
  assert.deepEqual(r.reanchorDays({ freq: "weekly", interval: 2, byDay: ["FR", "SA"] }, "2027-07-30", "2027-08-06").byDay, ["FR", "SA"]);
  assert.deepEqual(r.reanchorDays({ freq: "weekly", interval: 3, byDay: ["SA"] }, "2027-07-31", "2027-08-01").byDay, ["SU"]);
  // The series' implicit day spelled out reads as the same days.
  assert.deepEqual(r.withAnchorDays({ freq: "monthly", interval: 1 }, "2027-01-31"), { freq: "monthly", interval: 1, byMonthDay: 31 });
  assert.deepEqual(r.withAnchorDays({ freq: "weekly", interval: 1 }, "2027-07-26"), { freq: "weekly", interval: 1, byDay: ["MO"] });
  assert.equal(r.sameDays(r.sanitizeRule({ freq: "weekly", byDay: ["WE", "MO"] }), r.sanitizeRule({ freq: "weekly", byDay: ["MO", "WE"] })), true);
  assert.equal(r.sameDays({ freq: "monthly", interval: 1 }, { freq: "monthly", interval: 1, byMonthDay: 3 }), false);
});

// XERK-3040: an anchor in or across a spring-forward gap keeps the wall time it was given.
const lw = (iso) => Date.parse(iso.replace(/(?:Z|[+-]\d{2}:\d{2})$/, "") + "Z");
const hinted = (start, end, rule, prev) => {
  const s = series(start, end, rule);
  return { ...s, wall: r.wallHint(s.startMs, s.endMs, NY, lw(start), lw(end), prev) };
};

test("XERK-3040: an anchor spanning the gap repeats its WALL length, not the length the gap stretched", () => {
  // 01:00-02:30 EST on 2027-03-14: 02:30 does not exist, so the end is 07:30Z (03:30 EDT).
  const s = hinted("2027-03-14T01:00:00-05:00", "2027-03-14T02:30:00-05:00", { freq: "weekly", interval: 1 });
  assert.deepEqual(s.wall, { tod: 36e5, len: 54e5 });
  const occ = r.occurrences(s, 0, Infinity, 3);
  assert.deepEqual(occ.map((o) => o.key), ["2027-03-14T06:00:00Z", "2027-03-21T05:00:00Z", "2027-03-28T05:00:00Z"]);
  assert.equal(occ[0].endMs, ms("2027-03-14T07:30:00Z"), "the anchor itself is unchanged");
  assert.deepEqual(occ.slice(1).map((o) => o.endMs - o.startMs), [54e5, 54e5], "1.5h, not 2.5h");
  // Without the hint: the bug as filed.
  const bare = r.occurrences(series("2027-03-14T01:00:00-05:00", "2027-03-14T02:30:00-05:00", { freq: "weekly", interval: 1 }), 0, Infinity, 2);
  assert.equal(bare[1].endMs - bare[1].startMs, 90e5);
});

test("XERK-3040: an anchor IN the gap keeps its 02:30 on every later day", () => {
  const s = hinted("2026-03-08T02:30:00-05:00", "2026-03-08T03:30:00-04:00", { freq: "daily", interval: 1 });
  assert.deepEqual(s.wall, { tod: 9e6, len: 36e5 });
  const occ = r.occurrences(s, 0, Infinity, 3);
  assert.equal(occ[0].key, "2026-03-08T07:30:00Z");
  assert.deepEqual(occ.slice(1).map((o) => local(o)), ["2026-03-09T02:30", "2026-03-10T02:30"]);
  assert.deepEqual(occ.slice(1).map((o) => o.endMs - o.startMs), [36e5, 36e5]);
  // The occurrence id still resolves.
  assert.ok(r.occurrenceAt(s, "2026-03-09T06:30:00Z"));
});

test("XERK-3040: the hint is kept only while it names the anchor, and never for an ordinary one", () => {
  const plain = series("2026-03-09T09:00:00-04:00", "2026-03-09T10:00:00-04:00", { freq: "daily", interval: 1 });
  assert.equal(r.wallHint(plain.startMs, plain.endMs, NY, lw("2026-03-09T09:00:00-04:00"), NaN, null), null);
  // A UTC string names no wall time in New York: no hint.
  assert.equal(r.wallHint(ms("2026-03-08T07:30:00Z"), ms("2026-03-08T08:30:00Z"), NY,
    lw("2026-03-08T07:30:00Z"), lw("2026-03-08T08:30:00Z"), null), null);
  // A carried hint survives Z strings at the same instants (a hub-built split)…
  const prev = { tod: 9e6, len: 36e5 };
  assert.deepEqual(r.wallHint(ms("2026-03-08T07:30:00Z"), ms("2026-03-08T08:30:00Z"), NY, NaN, NaN, prev), prev);
  // …and on another date whose 02:30 lands on the same instant pattern (a later gap day).
  assert.deepEqual(r.wallHint(ms("2027-03-14T07:30:00Z"), ms("2027-03-14T08:30:00Z"), NY, NaN, NaN, prev), prev);
  // A series re-timed off the gap drops it.
  assert.equal(r.wallHint(ms("2026-03-08T14:00:00Z"), ms("2026-03-08T15:00:00Z"), NY, NaN, NaN, prev), null);
  // A plain reading of the same instants (a form resending 03:30-04:00) keeps it: same instant.
  assert.deepEqual(r.wallHint(ms("2026-03-08T07:30:00Z"), ms("2026-03-08T08:30:00Z"), NY,
    lw("2026-03-08T03:30:00-04:00"), lw("2026-03-08T04:30:00-04:00"), prev), prev);
  // A new gap end replaces its length.
  assert.deepEqual(r.wallHint(ms("2026-03-08T07:30:00Z"), ms("2026-03-08T07:30:00Z"), NY,
    NaN, lw("2026-03-08T02:45:00-05:00"), prev), prev, "02:45-05:00 is 07:45Z, not this end: the old hint stands");
  assert.deepEqual(r.wallHint(ms("2026-03-08T07:30:00Z"), ms("2026-03-08T07:45:00Z"), NY,
    NaN, lw("2026-03-08T02:45:00-05:00"), prev), { tod: 9e6, len: 9e5 });
  // A forged hint naming another instant is ignored by the expansion.
  const forged = { ...plain, wall: { tod: 0, len: 1 } };
  assert.deepEqual(r.occurrences(forged, 0, Infinity, 2).map((o) => o.endMs - o.startMs), [36e5, 36e5]);
});

test("XERK-3041: a series started at the SECOND 1:30 of a fall-back day keeps its own first instant", () => {
  const s = series("2027-11-07T06:30:00Z", "2027-11-07T07:30:00Z", { freq: "daily", interval: 1, count: 3 });
  const occ = r.occurrences(s, 0, Infinity, 5);
  assert.deepEqual(occ.map((o) => o.key), ["2027-11-07T06:30:00Z", "2027-11-08T06:30:00Z", "2027-11-09T06:30:00Z"]);
  assert.deepEqual(occ.map((o) => o.endMs - o.startMs), [36e5, 36e5, 36e5]);
  assert.ok(r.occurrenceAt(s, "2027-11-07T06:30:00Z"), "the anchor's own key resolves");
  assert.equal(r.occurrenceAt(s, "2027-11-07T05:30:00Z"), null, "the first 1:30 is not an occurrence");
  // A range cut around the anchor still finds it.
  assert.deepEqual(keys(s, ms("2027-11-07T06:00:00Z"), ms("2027-11-07T07:00:00Z")), ["2027-11-07T06:30:00Z"]);
});

test("XERK-3041: an anchor whose END falls in the repeated hour keeps its stored end", () => {
  const s = series("2027-11-07T05:00:00Z", "2027-11-07T06:45:00Z", { freq: "daily", interval: 1, count: 2 });
  const occ = r.occurrences(s, 0, Infinity, 5);
  assert.equal(occ[0].endMs - occ[0].startMs, 105 * 60e3, "the anchor is exactly its stored instance");
});
