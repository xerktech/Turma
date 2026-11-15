"use strict";
// Recurring Turma events (XERK-2969): the rule whitelist and its expansion.
// Pure: no server state, no dependency (zone math is Intl). Contract:
// .claude/rules/contract-calendar.md ("Recurring Turma events").
//
// A series is its record's first instance (the ANCHOR: start, end, timeZone)
// plus a rule. Occurrences keep the anchor's WALL-CLOCK start and length in the
// event's zone, so a DST change never moves a 9:00 meeting to 8:00 or 10:00.
// An occurrence is named by its ORIGINAL start as a UTC ISO stamp with seconds
// (`2026-11-16T14:00:00Z`), the Outlook reader's convention for its own
// `<seriesId>:<original start>` ids, so clients treat both alike.

const DAY_MS = 864e5;
const FREQS = ["daily", "weekly", "monthly", "yearly"];
const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const INTERVAL_MAX = 99;
const COUNT_MAX = 999;
// No series expands past this many periods in one call, whatever its rule: the
// bound behind "a rule may be unbounded, its expansion never is".
const PERIODS_MAX = 20000;
// A recurring event lasts at most this long: expansion looks back by it to find
// occurrences that began before a served range and still overlap it.
const DURATION_MAX_MS = 31 * DAY_MS;
const KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const intIn = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;

// A real calendar date "YYYY-MM-DD" -> its civil day number, else NaN.
function dateDay(s) {
  const m = typeof s === "string" ? DATE_RE.exec(s) : null;
  if (!m) return NaN;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t / DAY_MS : NaN;
}
const dayDate = (dn) => new Date(dn * DAY_MS).toISOString().slice(0, 10);

// A 400 naming what is wrong with a client's rule, or null. Never coerces.
function ruleError(v) {
  if (!isObj(v)) return "recurrence must be an object, or null for a single event";
  const known = ["freq", "interval", "byDay", "byMonthDay", "byWeekday", "until", "count"];
  const extra = Object.keys(v).find((k) => !known.includes(k));
  if (extra) return `recurrence.${extra} is not a recurrence field (one of ${known.join(", ")})`;
  if (!FREQS.includes(v.freq)) return `recurrence.freq must be one of ${FREQS.join(", ")}`;
  if (has(v, "interval") && !intIn(v.interval, 1, INTERVAL_MAX)) return `recurrence.interval must be 1..${INTERVAL_MAX}`;
  const dayLike = v.freq === "daily" || v.freq === "weekly";
  if (has(v, "byDay")) {
    if (!dayLike) return "recurrence.byDay is for a daily or weekly rule";
    if (!Array.isArray(v.byDay) || !v.byDay.length || !v.byDay.every((d) => DAYS.includes(d)) ||
        new Set(v.byDay).size !== v.byDay.length) {
      return `recurrence.byDay must be a non-empty list of distinct days (${DAYS.join(", ")})`;
    }
  }
  if ((has(v, "byMonthDay") || has(v, "byWeekday")) && dayLike) {
    return "recurrence.byMonthDay and byWeekday are for a monthly or yearly rule";
  }
  if (has(v, "byMonthDay") && has(v, "byWeekday")) return "recurrence takes byMonthDay or byWeekday, not both";
  if (has(v, "byMonthDay") && !intIn(v.byMonthDay, 1, 31)) return "recurrence.byMonthDay must be 1..31";
  if (has(v, "byWeekday") && (!isObj(v.byWeekday) || Object.keys(v.byWeekday).some((k) => k !== "n" && k !== "day") ||
      !(intIn(v.byWeekday.n, 1, 4) || v.byWeekday.n === -1) || !DAYS.includes(v.byWeekday.day))) {
    return "recurrence.byWeekday must be {n: 1..4 or -1 (last), day: SU..SA}";
  }
  if (has(v, "until") && has(v, "count")) return "recurrence takes until or count, not both";
  if (has(v, "until") && !Number.isFinite(dateDay(v.until))) return "recurrence.until must be a date, e.g. 2027-03-31";
  if (has(v, "count") && !intIn(v.count, 1, COUNT_MAX)) return `recurrence.count must be 1..${COUNT_MAX}`;
  return null;
}

// The ONE rule whitelist (routes, boot restore, HA watch): the stored form, in a
// fixed key order so a stored rule is a coerce fixed point; anything malformed
// is null (a single event). Defaults are NOT filled in — an absent byDay /
// byMonthDay means "the anchor's", so moving the series moves its days with it.
function sanitizeRule(v) {
  if (ruleError(v)) return null;
  const out = { freq: v.freq, interval: has(v, "interval") ? v.interval : 1 };
  if (has(v, "byDay")) out.byDay = DAYS.filter((d) => v.byDay.includes(d));   // week order
  if (has(v, "byMonthDay")) out.byMonthDay = v.byMonthDay;
  if (has(v, "byWeekday")) out.byWeekday = { n: v.byWeekday.n, day: v.byWeekday.day };
  if (has(v, "until")) out.until = v.until;
  if (has(v, "count")) out.count = v.count;
  return out;
}

// ---- zone math ------------------------------------------------------------------
const fmts = new Map();
function fmt(tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric",
      day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    if (fmts.size > 200) fmts.clear();
    fmts.set(tz, f);
  }
  return f;
}
// `ms`'s wall clock in `tz`, as the epoch number of that wall time read as UTC.
// The zone's offset is cached per 15-minute UTC bucket, so Intl's formatToParts —
// the whole cost of expansion (~0.15 ms a call) — runs about once per bucket
// instead of per occurrence. A bucket is cached only when its first and last
// second read the same offset (no transition inside it: some zones move at
// 00:01, St Johns and Gaza among them); one that holds a transition is computed
// exactly on every call.
const BUCKET_MS = 9e5;
const offsets = new Map();   // tz -> Map(bucket -> offset ms | null = holds a transition)
function offsetAt(ms, tz) {
  const at = Math.floor(ms / 1000) * 1000;
  const p = {};
  for (const { type, value } of fmt(tz).formatToParts(new Date(at))) p[type] = Number(value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at;
}
function wallOf(ms, tz) {
  let m = offsets.get(tz);
  if (!m) {
    if (offsets.size > 20) offsets.clear();   // ≤20 zones × 20000 buckets: a few MB
    offsets.set(tz, (m = new Map()));
  }
  const b = Math.floor(ms / BUCKET_MS);
  let off = m.get(b);
  if (off === undefined) {
    const first = offsetAt(b * BUCKET_MS, tz);
    off = offsetAt((b + 1) * BUCKET_MS - 1000, tz) === first ? first : null;
    if (m.size > 20000) m.clear();
    m.set(b, off);
  }
  return ms + (off === null ? offsetAt(ms, tz) : off);
}
// The instant whose wall clock in `tz` reads `w`. A time skipped by a
// spring-forward reads at the old offset (the clock then shows an hour later); a
// time repeated by a fall-back is its FIRST instant — so each wall time is ONE
// instant, as the Daily Brief scheduler maps them. Offsets are probed 36h either
// side so a zone east of +12 still sees its pre-transition offset.
function instantOf(w, tz) {
  const before = wallOf(w - 1.5 * DAY_MS, tz) - (w - 1.5 * DAY_MS);
  const after = wallOf(w + 1.5 * DAY_MS, tz) - (w + 1.5 * DAY_MS);
  const ok = [w - before, w - after].filter((c) => wallOf(c, tz) === w);
  return ok.length ? Math.min(...ok) : w - before;
}

// ---- expansion --------------------------------------------------------------------
// `series` = {startMs, endMs, timeZone, rule}. Calls `each({key, startMs, endMs})`
// for every occurrence whose ORIGINAL start lies in [lo, hi), earliest first,
// until `max` were yielded or `each` returns false. Returns how many it yielded.
function eachOccurrence(series, lo, hi, max, each) {
  if (!series || !series.rule || !(max > 0)) return 0;
  const { rule, timeZone: tz } = series;
  const w0 = wallOf(series.startMs, tz);
  const wallLen = wallOf(series.endMs, tz) - w0;
  const day0 = Math.floor(w0 / DAY_MS);
  const tod = w0 - day0 * DAY_MS;          // wall time of day, ms
  const d0 = new Date(day0 * DAY_MS);
  const y0 = d0.getUTCFullYear(), mo0 = d0.getUTCMonth(), dom0 = d0.getUTCDate();
  const wd0 = (((day0 + 4) % 7) + 7) % 7;   // 1970-01-01 was a Thursday
  const iv = rule.interval;
  const untilDay = rule.until ? dateDay(rule.until) : Infinity;
  const count = rule.count || Infinity;
  const byDay = (rule.byDay || [DAYS[wd0]]).map((d) => DAYS.indexOf(d));
  const loDay = Number.isFinite(lo) ? Math.floor(wallOf(lo, tz) / DAY_MS) - 1 : -Infinity;
  const hiDay = Number.isFinite(hi) ? Math.floor(wallOf(hi, tz) / DAY_MS) + 1 : Infinity;

  // The one date of month `mIdx` (years*12 + month) the rule names.
  const monthDate = (mIdx) => {
    const y = Math.floor(mIdx / 12), mo = mIdx - y * 12;
    const first = Date.UTC(y, mo, 1) / DAY_MS;
    const len = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    if (rule.byWeekday) {
      const want = DAYS.indexOf(rule.byWeekday.day);
      const wdFirst = (((first + 4) % 7) + 7) % 7;
      const firstHit = first + ((want - wdFirst + 7) % 7);
      if (rule.byWeekday.n > 0) return firstHit + 7 * (rule.byWeekday.n - 1);
      return firstHit + 7 * Math.floor((first + len - 1 - firstHit) / 7);
    }
    // A day past the month's end is its last day (Outlook's rule): "the 31st"
    // is Feb 28/29, Apr 30, ...
    return first + Math.min(rule.byMonthDay || dom0, len) - 1;
  };
  const periodDates = (k) => {
    if (rule.freq === "daily") {
      const dn = day0 + k * iv;
      return rule.byDay && !byDay.includes((((dn + 4) % 7) + 7) % 7) ? [] : [dn];
    }
    if (rule.freq === "weekly") {
      const ws = day0 - wd0 + 7 * iv * k;
      return byDay.map((i) => ws + i);
    }
    if (rule.freq === "monthly") return [monthDate(y0 * 12 + mo0 + k * iv)];
    return [monthDate((y0 + k * iv) * 12 + mo0)];
  };
  // How many occurrences periods [0, k) hold, in O(1): only period 0 can hold
  // dates before the anchor, and after it a period holds a fixed number (a
  // daily byDay filter repeats every 7 periods). So a count is never walked.
  const inP = (j) => periodDates(j).filter((dn) => dn >= day0).length;
  const cycle = rule.freq === "daily" ? [0, 1, 2, 3, 4, 5, 6].map(inP) : null;
  if (cycle && cycle.every((c) => !c)) return 0;   // a byDay the rule's days never meet
  const hitsBefore = (kk) => {
    if (kk <= 0) return 0;
    if (cycle) {
      const full = Math.floor(kk / 7);
      return full * cycle.reduce((a, b) => a + b, 0) + cycle.slice(0, kk - full * 7).reduce((a, b) => a + b, 0);
    }
    return inP(0) + (kk - 1) * (rule.freq === "weekly" ? byDay.length : 1);
  };
  // Where to start: skip straight to the periods just before `lo`.
  let k = 0;
  if (Number.isFinite(loDay) && loDay > day0) {
    const span = rule.freq === "daily" ? iv : rule.freq === "weekly" ? 7 * iv : rule.freq === "monthly" ? 31 * iv : 366 * iv;
    k = Math.max(0, Math.floor((loDay - day0) / span) - 2);
  }
  let seen = hitsBefore(k), yielded = 0;
  if (seen >= count) return 0;
  for (let n = 0; n < PERIODS_MAX; n++, k++) {
    const dates = periodDates(k);
    if (dates.length && dates[0] > hiDay + 7) break;
    if (dates.length && dates[0] > untilDay) break;
    for (const dn of dates) {
      if (dn < day0 || dn > untilDay || seen >= count) continue;
      seen++;
      const w = dn * DAY_MS + tod;
      const startMs = instantOf(w, tz);
      if (startMs >= hi) return yielded;
      if (startMs < lo) continue;
      const key = new Date(startMs).toISOString().replace(/\.\d{3}Z$/, "Z");
      // A start in a spring-forward gap reads an hour later, which can put the
      // wall end before it: keep the anchor's length then.
      let endMs = instantOf(w + wallLen, tz);
      if (endMs < startMs || (endMs === startMs && wallLen > 0)) endMs = startMs + (series.endMs - series.startMs);
      yielded++;
      if (each({ key, startMs, endMs }) === false || yielded >= max) return yielded;
    }
    if (seen >= count) break;
  }
  return yielded;
}

function occurrences(series, lo, hi, max) {
  const out = [];
  eachOccurrence(series, lo, hi, max, (o) => { out.push(o); });
  return out;
}
// The occurrence originally starting at `key`, or null.
function occurrenceAt(series, key) {
  if (typeof key !== "string" || !KEY_RE.test(key)) return null;
  const ms = Date.parse(key);
  if (!Number.isFinite(ms)) return null;
  const [o] = occurrences(series, ms, ms + 1, 1);
  return o && o.key === key ? o : null;
}
// The local date `days` after `ms`'s in `tz`, as YYYY-MM-DD.
const localDate = (ms, tz, days = 0) => dayDate(Math.floor(wallOf(ms, tz) / DAY_MS) + days);

module.exports = {
  FREQS, DAYS, INTERVAL_MAX, COUNT_MAX, PERIODS_MAX, DURATION_MAX_MS, KEY_RE,
  ruleError, sanitizeRule, eachOccurrence, occurrences, occurrenceAt, localDate, wallOf, instantOf,
};
