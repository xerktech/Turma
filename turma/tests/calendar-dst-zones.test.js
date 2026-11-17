// The calendar grid's DST axis (XERK-2932) in zones whose switches calendar.test.js (New York)
// cannot show: Santiago changes at midnight, Lord Howe shifts by 30 minutes. Each zone runs in
// its own child process, since the zone is read once when Node starts.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

const run = (tz, body) => JSON.parse(execFileSync(process.execPath, ["-e", `
  globalThis.TurmaOrg = { getKeys: () => [], orgColors: () => null };
  globalThis.TurmaBoard = require(${JSON.stringify(require.resolve("../public/board.js"))});
  globalThis.location = { href: "" };
  globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ events: [], hosts: [] }) });
  const cal = require(${JSON.stringify(require.resolve("../public/calendar.js"))});
  const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
  process.stdout.write(JSON.stringify((() => { ${body} })()));
`], { env: { ...process.env, TZ: tz } }).toString());

test("XERK-2932: Santiago — the repeated 23:00 hour is drawn, a skipped midnight starts the day at 1:00", () => {
  const r = run("America/Santiago", `
    const sat = at(2026, 4, 4), ax = cal.gridAxis([sat]);
    const [late] = cal.daySegments([{ startMs: Date.parse("2026-04-05T02:30:00Z"), endMs: Date.parse("2026-04-05T03:45:00Z") }], sat, ax);
    const sun = at(2026, 9, 6), week = cal.visibleDays(sun, "week"), wa = cal.gridAxis(week);
    const [first] = cal.daySegments([{ startMs: sun, endMs: sun + 3600000 }], sun, wa);
    const [over] = cal.daySegments([{ startMs: Date.parse("2026-09-06T02:00:00Z"), endMs: Date.parse("2026-09-06T04:30:00Z") }], sun, wa);
    return { total: ax.total, late: [late.top, late.end], hours: cal.gridHours(ax).slice(-2),
      first: [first.top, first.end], over: [over.top, over.end], gaps: cal.gridGaps(sun, wa),
      alone: cal.gridHours(cal.gridAxis([sun]))[0], top: cal.hoursHtml(cal.gridAxis([sun])).split("</div>")[0] };`);
  assert.equal(r.total, 1500);
  assert.deepEqual(r.late, [1410, 1485], "23:30 -03 → 23:45 -04 is not clipped at midnight");
  assert.deepEqual(r.hours.map((h) => [h.top, h.h]), [[1380, 23], [1440, 23]]);
  // Sep 6 starts at 1:00: an event at its first minute sits on the 1:00 row, below the hatch,
  // and one crossing in from Saturday starts there too.
  assert.deepEqual(r.gaps, [{ top: 0, len: 60, pass: 0 }]);
  assert.deepEqual(r.first, [60, 120]);
  assert.deepEqual(r.over, [60, 90]);
  assert.deepEqual([r.alone.top, r.alone.h], [0, 1], "a day shown alone starts with its 1 AM row");
  assert.equal(r.top, '<div class="cal-hr top" style="top:calc(var(--slot, 24px) * 0)">1 AM', "and labels it at the top edge");
});

test("XERK-2932: Lord Howe — a 30-minute shift draws hour lines from the labels", () => {
  const r = run("Australia/Lord_Howe", `
    const d = at(2026, 4, 5), ax = cal.gridAxis([d]);
    return { total: ax.total, hours: cal.gridHours(ax).slice(1, 5).map((h) => [h.top, h.h]),
      nine: cal.gridMin(at(2026, 4, 5, 9), d, ax), html: (() => {
        const el = () => { const e = { _html: "", listeners: {}, children: [], attrs: {}, style: { setProperty() {}, removeProperty() {} },
          addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, appendChild(c) { this.children.push(c); return c; },
          querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return false; } };
          Object.defineProperty(e, "innerHTML", { get() { return this._html; }, set(v) { this._html = String(v); } }); return e; };
        globalThis.document = { createElement: el, activeElement: null, querySelector: () => null };
        cal.mount(el(), { now: () => d + 12 * 3600000 });
        cal.setActive(true); cal.setMode("week"); cal._go(d);
        return cal.calendarHtml();
      })() };`);
  assert.equal(r.total, 1470);
  // 1:30–2:00 repeats: 2 AM sits half an hour off the 60-minute rhythm, at 150.
  assert.deepEqual(r.hours, [[60, 1], [150, 2], [210, 3], [270, 4]]);
  assert.equal(r.nine, 570);
  // So the week paints its hour lines from the labels, not the column's repeating gradient.
  assert.match(r.html, /class="cal-row cal-body cal-odd"/);
  assert.match(r.html, /class="cal-hl" style="top:calc\(var\(--slot, 24px\) \* 5\)"/);
  assert.match(r.html, /class="cal-hl half" style="top:calc\(var\(--slot, 24px\) \* 6\)"/, "half-hour lines too");
});
