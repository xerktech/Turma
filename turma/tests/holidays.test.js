"use strict";
// XERK-2892: the national holiday catalogs are computed by rule for any year.

const test = require("node:test");
const assert = require("node:assert/strict");
const holidays = require("../holidays.js");

const year = (y, country = "US") =>
  holidays.holidaysIn(country, holidays.parseDay(`${y}-01-01`), holidays.parseDay(`${y}-12-31`));
const dateOf = (y, id) => year(y).filter((h) => h.id === id).map((h) => h.date);

test("XERK-2892: nth- and last-weekday rules land on the right day across years", () => {
  // Thanksgiving: the fourth Thursday of November, including a month starting on Thursday/Friday.
  assert.deepEqual(dateOf(2024, "us-thanksgiving"), ["2024-11-28"]);
  assert.deepEqual(dateOf(2025, "us-thanksgiving"), ["2025-11-27"]);
  assert.deepEqual(dateOf(2026, "us-thanksgiving"), ["2026-11-26"]);
  assert.deepEqual(dateOf(2018, "us-thanksgiving"), ["2018-11-22"]); // Nov 1 a Thursday
  // Memorial Day: the last Monday of May, including a May ending on a Monday (2021).
  assert.deepEqual(dateOf(2024, "us-memorial-day"), ["2024-05-27"]);
  assert.deepEqual(dateOf(2025, "us-memorial-day"), ["2025-05-26"]);
  assert.deepEqual(dateOf(2026, "us-memorial-day"), ["2026-05-25"]);
  assert.deepEqual(dateOf(2021, "us-memorial-day"), ["2021-05-31"]); // May 31 a Monday
  assert.deepEqual(dateOf(2026, "us-mlk-day"), ["2026-01-19"]);
  assert.deepEqual(dateOf(2026, "us-washingtons-birthday"), ["2026-02-16"]);
  assert.deepEqual(dateOf(2026, "us-labor-day"), ["2026-09-07"]);
  assert.deepEqual(dateOf(2026, "us-columbus-day"), ["2026-10-12"]);
  assert.equal(year(2026).length, 11);
});

test("XERK-2892: a weekend fixed date is observed on the nearest weekday", () => {
  // July 4 on a Saturday -> Friday 3rd; on a Sunday -> Monday 5th; midweek unchanged.
  assert.deepEqual(year(2026).find((h) => h.id === "us-independence-day"),
    { id: "us-independence-day", date: "2026-07-03", name: "Independence Day", country: "US", actualDate: "2026-07-04" });
  assert.deepEqual(year(2021).find((h) => h.id === "us-independence-day"),
    { id: "us-independence-day", date: "2021-07-05", name: "Independence Day", country: "US", actualDate: "2021-07-04" });
  assert.deepEqual(year(2025).find((h) => h.id === "us-independence-day"),
    { id: "us-independence-day", date: "2025-07-04", name: "Independence Day", country: "US" });
  // A Saturday 1 January 2022 is observed Friday 31 December 2021 — in the previous year.
  assert.deepEqual(dateOf(2021, "us-new-years-day"), ["2021-01-01", "2021-12-31"]);
  assert.deepEqual(dateOf(2022, "us-new-years-day"), []);
  // Christmas 2027 is a Saturday.
  assert.deepEqual(dateOf(2027, "us-christmas"), ["2027-12-24"]);
});

test("XERK-2892: a holiday is listed only from the year it began; windows are inclusive", () => {
  assert.deepEqual(dateOf(2020, "us-juneteenth"), []);
  assert.deepEqual(dateOf(2021, "us-juneteenth"), ["2021-06-18"]); // a Saturday
  assert.deepEqual(dateOf(1985, "us-mlk-day"), []);
  assert.equal(holidays.parseDay("1978-01-01"), Date.UTC(1978, 0, 1));
  const d = holidays.parseDay("2026-11-26");
  assert.deepEqual(holidays.holidaysIn("US", d, d).map((h) => h.id), ["us-thanksgiving"]);
  assert.deepEqual(holidays.holidaysIn("ZZ", d, d), []);
  assert.deepEqual(holidays.holidaysIn("__proto__", d, d), []);
});

test("XERK-2892: parseDay takes only real calendar dates in range", () => {
  for (const bad of ["2026-02-30", "2026-13-01", "26-01-01", "2026-1-1", "1977-12-31", "3000-01-01",
    "2026-01-01T00:00", "", null, 20260101]) {
    assert.equal(holidays.parseDay(bad), null, String(bad));
  }
  assert.equal(holidays.parseDay("2024-02-29"), Date.UTC(2024, 1, 29));
  // Every catalog id is unique and the wire lists them.
  const ids = holidays.CATALOGS.US.holidays.map((h) => h.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(holidays.catalogWire().US.holidays.map((h) => h.id), ids);
});
