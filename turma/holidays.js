"use strict";
// National holiday catalogs (XERK-2892), computed by rule for any year — no data
// file to refresh and no dependency. Pure: no server state.
//
// A country is DATA: a row in CATALOGS listing its holidays, each a rule the
// helpers below evaluate. Adding a country is adding a row; nothing else changes.
//
// A holiday's `id` is stable across years (`us-thanksgiving`), because an org's
// days-off choice is remembered by id and applies every year.

const DAY_MS = 864e5;

// ---- rule kinds -------------------------------------------------------------------
// fixed(month, day)            the same date every year (month 1-12)
// nth(month, weekday, n)       the n-th weekday of the month (weekday 0=Sun..6=Sat)
// last(month, weekday)         the last such weekday of the month
// `observed: "us"` moves a date that falls on a weekend to the nearest weekday
// (Saturday -> Friday before, Sunday -> Monday after), as US federal law does.
const fixed = (month, day) => ({ kind: "fixed", month, day });
const nth = (month, weekday, n) => ({ kind: "nth", month, weekday, n });
const last = (month, weekday) => ({ kind: "last", month, weekday });

const MON = 1, THU = 4;

// `since` is the first year the holiday exists (none before it is listed).
const CATALOGS = {
  US: {
    name: "United States",
    holidays: [
      { id: "us-new-years-day", name: "New Year's Day", rule: fixed(1, 1), observed: "us" },
      { id: "us-mlk-day", name: "Martin Luther King Jr. Day", rule: nth(1, MON, 3), since: 1986 },
      { id: "us-washingtons-birthday", name: "Washington's Birthday", rule: nth(2, MON, 3) },
      { id: "us-memorial-day", name: "Memorial Day", rule: last(5, MON) },
      { id: "us-juneteenth", name: "Juneteenth", rule: fixed(6, 19), observed: "us", since: 2021 },
      { id: "us-independence-day", name: "Independence Day", rule: fixed(7, 4), observed: "us" },
      { id: "us-labor-day", name: "Labor Day", rule: nth(9, MON, 1) },
      { id: "us-columbus-day", name: "Columbus Day", rule: nth(10, MON, 2) },
      { id: "us-veterans-day", name: "Veterans Day", rule: fixed(11, 11), observed: "us" },
      { id: "us-thanksgiving", name: "Thanksgiving Day", rule: nth(11, THU, 4) },
      { id: "us-christmas", name: "Christmas Day", rule: fixed(12, 25), observed: "us" },
    ],
  },
};

// The years a query may reach. 1978 is the first year the current rules hold for
// every holiday (the Monday-holiday law took effect in 1971 and Veterans Day went
// back to 11 November in 1978), so earlier years would be answered wrongly. The
// top bound keeps a hostile `from`/`until` from asking for a loop of millennia.
const YEAR_MIN = 1978;
const YEAR_MAX = 2999;
// The longest window one GET answers (a year view plus its edge weeks).
const RANGE_MAX_DAYS = 400;

// Every catalog id -> its country, for validating an org's days-off choice.
const HOLIDAY_COUNTRY = Object.create(null);
for (const [country, c] of Object.entries(CATALOGS)) {
  for (const h of c.holidays) HOLIDAY_COUNTRY[h.id] = country;
}

// UTC midnight of a calendar date (month 1-12).
const utc = (y, m, d) => Date.UTC(y, m - 1, d);
const weekdayOf = (ms) => new Date(ms).getUTCDay();
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function ruleDate(rule, year) {
  if (rule.kind === "fixed") return utc(year, rule.month, rule.day);
  if (rule.kind === "nth") {
    const first = utc(year, rule.month, 1);
    return first + (((rule.weekday - weekdayOf(first) + 7) % 7) + 7 * (rule.n - 1)) * DAY_MS;
  }
  // last: step back from the month's last day.
  const end = utc(year, rule.month + 1, 0);
  return end - ((weekdayOf(end) - rule.weekday + 7) % 7) * DAY_MS;
}
function observedDate(ms, how) {
  if (how !== "us") return ms;
  const wd = weekdayOf(ms);
  return wd === 6 ? ms - DAY_MS : wd === 0 ? ms + DAY_MS : ms;
}

// "YYYY-MM-DD" -> UTC ms, or null for anything that is not a real date in range.
function parseDay(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (y < YEAR_MIN || y > YEAR_MAX) return null;
  const ms = utc(y, m, d);
  return isoOf(ms) === s ? ms : null;
}

// One country's holidays held between `fromMs` and `untilMs` (both UTC midnights,
// inclusive), oldest first: [{id, date, name, country, actualDate?}]. `date` is the
// day the holiday is OBSERVED (the day off); `actualDate` rides only when a weekend
// moved it. A Saturday 1 January is observed the Friday before — in the previous
// year — so the year after the window is evaluated too.
function holidaysIn(country, fromMs, untilMs) {
  const c = Object.hasOwn(CATALOGS, country) ? CATALOGS[country] : null;
  if (!c) return [];
  const out = [];
  const y0 = new Date(fromMs).getUTCFullYear() - 1;
  const y1 = new Date(untilMs).getUTCFullYear() + 1;
  for (let y = y0; y <= y1; y++) {
    for (const h of c.holidays) {
      if (h.since && y < h.since) continue;
      const actual = ruleDate(h.rule, y);
      const held = observedDate(actual, h.observed);
      if (held < fromMs || held > untilMs) continue;
      const row = { id: h.id, date: isoOf(held), name: h.name, country };
      if (held !== actual) row.actualDate = isoOf(actual);
      out.push(row);
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// The catalog as the settings UI lists it: country -> {name, holidays:[{id, name}]}.
function catalogWire() {
  const out = Object.create(null);
  for (const [country, c] of Object.entries(CATALOGS)) {
    out[country] = { name: c.name, holidays: c.holidays.map((h) => ({ id: h.id, name: h.name })) };
  }
  return out;
}

module.exports = {
  CATALOGS, HOLIDAY_COUNTRY, RANGE_MAX_DAYS, DAY_MS,
  parseDay, holidaysIn, catalogWire,
  hasCountry: (c) => typeof c === "string" && Object.hasOwn(CATALOGS, c),
};
