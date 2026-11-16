// Unit tests for the Meetings page's Calendar view (public/calendar.js, XERK-2897):
// week math across DST and year boundaries, the Teams-style overlap layout,
// canceled / past / tentative styling, escaping of every served string, holiday
// shading and the per-host stale notices. Runs in a fixed zone so DST is real.

"use strict";

process.env.TZ = "America/New_York";

const test = require("node:test");
const assert = require("node:assert/strict");

// The module paints into a DOM element and reads TurmaOrg/TurmaBoard; give it
// the minimum, then load the real source.
let orgKeys = [];
let replies = {};
globalThis.TurmaOrg = { getKeys: () => orgKeys, orgColors: () => null };
globalThis.TurmaBoard = require("../public/board.js");
globalThis.location = { href: "" };
const posts = [];   // every non-GET fetch: {url, body}
globalThis.fetch = async (u, init = {}) => {
  const url = String(u);
  if (init.method && init.method !== "GET") posts.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
  const key = Object.keys(replies).find((k) => url.startsWith(k));
  const body = await (key ? replies[key](url, init) : (url.startsWith("/api/holidays") ? [] : { events: [], hosts: [] }));
  // A reply of {status, body} is a refusal.
  if (body && body.status) return { status: body.status, ok: false, json: async () => body.body || {} };
  return { status: 200, ok: true, json: async () => body };
};
const cal = require("../public/calendar.js");

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const ymd = (ms) => cal.dayKey(ms);

test("XERK-2940: week math — Sunday starts, local midnights across the fall-back DST week", () => {
  // US DST ends Sunday 2026-11-01, the first day of its week.
  const days = cal.visibleDays(at(2026, 11, 4, 15), "week");
  assert.deepEqual(days.map(ymd), ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"]);
  for (const d of days) assert.equal(new Date(d).getHours(), 0);
  assert.equal(days[1] - days[0], 25 * 3600000);       // Sunday has 25 hours
  assert.equal(days[6] - days[5], 86400000);
  // The week before runs Sunday Oct 25 – Saturday Oct 31; Work week is its Monday–Friday.
  assert.deepEqual(cal.visibleDays(at(2026, 10, 29), "week").map(ymd).slice(0, 1), ["2026-10-25"]);
  assert.deepEqual(cal.visibleDays(at(2026, 10, 29), "work").map(ymd), ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
  // A Sunday is the first day of its own week, not the last of the one before (XERK-2940).
  assert.equal(ymd(cal.weekStart(at(2026, 11, 15, 12))), "2026-11-15");
  assert.equal(ymd(cal.weekStart(at(2026, 11, 14, 12))), "2026-11-08");
  assert.deepEqual(cal.visibleDays(at(2026, 11, 14), "work").map(ymd).slice(0, 1), ["2026-11-09"]);
  // › from that week lands on the DST Sunday at midnight, not 23:00.
  const next = cal.visibleDays(cal.stepAnchor(at(2026, 10, 29), "week", 1), "week");
  assert.equal(ymd(next[0]), "2026-11-01");
  assert.equal(new Date(next[0]).getHours(), 0);
  // 9:00 on the DST day sits on the 9:00 row, not 8:00 or 10:00.
  assert.equal(cal.wallMinutes(at(2026, 11, 1, 9), at(2026, 11, 1)), 540);
});

test("XERK-2897: week math — spring-forward and a week across the year boundary", () => {
  const spring = cal.visibleDays(at(2026, 3, 8, 12), "week");  // DST starts Sunday 2026-03-08
  assert.equal(ymd(spring[0]), "2026-03-08");
  assert.equal(spring[1] - spring[0], 23 * 3600000);
  assert.equal(cal.wallMinutes(at(2026, 3, 8, 9), at(2026, 3, 8)), 540);

  const nye = cal.visibleDays(at(2026, 12, 31), "week");
  assert.deepEqual([ymd(nye[0]), ymd(nye[6])], ["2026-12-27", "2027-01-02"]);
  const label = cal.rangeLabel(nye);
  assert.match(label, /2026/);
  assert.match(label, /2027/);
  assert.equal(ymd(cal.stepAnchor(at(2027, 1, 1), "week", -1)), "2026-12-25");
  // A narrow three-day view across a week edge reads both weeks.
  const three = cal.visibleDays(at(2027, 1, 2), "three");
  assert.deepEqual(three.map(ymd), ["2027-01-02", "2027-01-03", "2027-01-04"]);
  assert.deepEqual(cal.weeksOf(three).map(ymd), ["2026-12-27", "2027-01-03"]);
  assert.equal(ymd(cal.stepAnchor(three[0], "three", 1)), "2027-01-05");
  assert.equal(ymd(cal.stepAnchor(three[0], "day", -1)), "2027-01-01");
  // The ticket's example: Work week of Nov 9 2026 reads "November 9 – 13, 2026".
  assert.match(cal.rangeLabel(cal.visibleDays(at(2026, 11, 11), "work")), /^November 9\s*–\s*13, 2026$/);
});

test("XERK-2897: overlap layout puts clashing events side by side and widens into free columns", () => {
  const seg = (id, top, bottom) => ({ id, top, bottom });
  const out = cal.layoutDay([seg("A", 540, 600), seg("B", 570, 630), seg("C", 600, 660), seg("D", 780, 840)]);
  const by = Object.fromEntries(out.map((s) => [s.id, s]));
  assert.deepEqual([by.A.col, by.B.col, by.C.col], [0, 1, 0]);
  assert.deepEqual([by.A.cols, by.B.cols, by.C.cols], [2, 2, 2]);
  assert.deepEqual([by.D.col, by.D.cols, by.D.span], [0, 1, 1]);   // a separate cluster is full width
  // T and U clash; V starts as both end, so it takes column 0 and widens over U's free column.
  const w = Object.fromEntries(cal.layoutDay([seg("T", 540, 600), seg("U", 540, 600), seg("V", 600, 660), seg("W", 540, 660)])
    .map((s) => [s.id, s]));
  assert.equal(w.W.col, 0);           // the longest of equal starts goes first
  assert.equal(w.T.cols, 3);
  assert.equal(w.V.col, 1);
  assert.equal(w.V.span, 2);          // columns 1 and 2 are free from 10:00
});

test("XERK-2897: an event spanning midnight is clipped to each day; a 24h+ one rides the all-day band", () => {
  const ev = { startMs: at(2026, 11, 10, 23), endMs: at(2026, 11, 11, 1) };
  const a = cal.daySegments([ev], at(2026, 11, 10));
  const b = cal.daySegments([ev], at(2026, 11, 11));
  assert.deepEqual([a[0].top, a[0].end], [1380, 1440]);
  assert.deepEqual([b[0].top, b[0].end], [0, 60]);
  assert.equal(cal.inBand({ startMs: at(2026, 11, 10), endMs: at(2026, 11, 12) }), true);
  assert.equal(cal.inBand({ allDay: true, startMs: at(2026, 11, 10), endMs: at(2026, 11, 11) }), true);
  assert.equal(cal.daySegments([{ allDay: true, startMs: at(2026, 11, 10), endMs: at(2026, 11, 11) }], at(2026, 11, 10)).length, 0);
});

test("XERK-2930: an event in the repeated fall-back hour lays out by its length and names both zones", () => {
  // 2026-11-01 05:30Z is 1:30 EDT; 06:00Z is 1:00 EST — the clock runs backwards.
  const ev = { startMs: Date.parse("2026-11-01T05:30:00Z"), endMs: Date.parse("2026-11-01T06:00:00Z") };
  const [s] = cal.daySegments([ev], at(2026, 11, 1));
  assert.deepEqual([s.top, s.end, s.bottom], [90, 120, 120]);
  // An hour from 1:30 EDT to 1:30 EST (wall end == start) and 1:30 EDT – 1:40 EST are full length;
  // 0:30 EDT – 1:30 EST is two hours; a spring-forward hour keeps its wall rows.
  const len = (a, b, d) => { const [x] = cal.daySegments([{ startMs: Date.parse(a), endMs: Date.parse(b) }], d); return x.end - x.top; };
  assert.equal(len("2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", at(2026, 11, 1)), 60);
  assert.equal(len("2026-11-01T05:30:00Z", "2026-11-01T06:40:00Z", at(2026, 11, 1)), 70);
  assert.equal(len("2026-11-01T04:30:00Z", "2026-11-01T06:30:00Z", at(2026, 11, 1)), 120);
  assert.equal(len("2026-03-08T06:30:00Z", "2026-03-08T07:30:00Z", at(2026, 3, 8)), 120);
  // An end PAST the repeated hour keeps its wall row: 1:30 EDT – 9:00 EST ends at 9:00, and
  // an overnight 10 pm EDT – 3:00 EST ends at 3:00 on Nov 1.
  const [lg] = cal.daySegments([{ startMs: Date.parse("2026-11-01T05:30:00Z"), endMs: Date.parse("2026-11-01T14:00:00Z") }], at(2026, 11, 1));
  assert.equal(lg.end, 540);
  const [ov] = cal.daySegments([{ startMs: Date.parse("2026-11-01T02:00:00Z"), endMs: Date.parse("2026-11-01T08:00:00Z") }], at(2026, 11, 1));
  assert.deepEqual([ov.top, ov.end], [0, 180]);
  const label = cal.fmtSpan(ev.startMs, ev.endMs);
  assert.match(label, /EDT/);
  assert.match(label, /EST/);
  // An ordinary span keeps its plain label.
  assert.doesNotMatch(cal.fmtSpan(at(2026, 11, 10, 9), at(2026, 11, 10, 10)), /E[SD]T/);
});

test("XERK-2897: canceled, past, tentative, free and Tenir-only styling", () => {
  const now = at(2026, 11, 14, 12);
  assert.deepEqual(cal.styleOf({ canceled: true, startMs: now + 1, endMs: now + 2 }, now), ["canceled"]);
  assert.deepEqual(cal.styleOf({ startMs: now - 7200000, endMs: now - 3600000 }, now), ["past"]);
  assert.ok(cal.styleOf({ busy: "tentative", startMs: now, endMs: now + 1 }, now).includes("tentative"));
  assert.ok(cal.styleOf({ myResponse: "notResponded", startMs: now, endMs: now + 1 }, now).includes("tentative"));
  assert.ok(cal.styleOf({ busy: "free", startMs: now, endMs: now + 1 }, now).includes("free"));
  assert.ok(cal.styleOf({ source: "tenir", startMs: now, endMs: now + 1 }, now).includes("tenir"));
  assert.equal(cal.titleOf({ canceled: true, subject: "Standup" }), "Canceled: Standup");
  assert.equal(cal.titleOf({ subject: "  " }), "(no title)");
});

const tick = () => new Promise((r) => setImmediate(r));
function el() {
  const e = { _html: "", listeners: {}, children: [], attrs: {},
    style: { props: {}, setProperty(k, v) { this.props[k] = String(v); }, removeProperty(k) { delete this.props[k]; } },
    addEventListener(n, f) { (this.listeners[n] ||= []).push(f); },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; }, contains(t) { return !!t && t.inside === true; } };
  // A parent's markup is its children's (the grid, the detail panel), as a browser's would be.
  Object.defineProperty(e, "innerHTML", { get() { return this._html + this.children.map((c) => c.innerHTML).join(""); },
    set(v) { this._html = String(v); } });
  return e;
}
const root = el();
let NOW = at(2026, 11, 11, 10, 30);
globalThis.document = { createElement: () => el(), activeElement: null, querySelector: () => null };
cal.mount(root, { now: () => NOW });
delete globalThis.document;

async function show(anchorMs) {
  cal.setActive(true);
  cal._go(anchorMs);
  for (let i = 0; i < 6; i++) await tick();
  return cal.calendarHtml();
}

test("XERK-2897: every served string is escaped; canceled + Tenir events render as such", async () => {
  const evil = "<img src=x onerror=alert(1)>";
  replies = {
    "/api/calendar": (url) => (url.includes(`from=${cal.weekStart(at(2026, 11, 11))}`) ? {
      hosts: [{ host: "h1", device: `box${evil}`, online: false, syncedAt: NOW - 3600000, ranges: [[0, 4e12]] }],
      events: [
        { host: "h1", id: "1", org: "", subject: evil, location: evil, organizer: evil, canceled: true,
          startMs: at(2026, 11, 11, 9), endMs: at(2026, 11, 11, 10) },
        { host: "", id: "tenir:m1", source: "tenir", org: "", subject: "Hallway chat",
          startMs: at(2026, 11, 12, 14), endMs: at(2026, 11, 12, 15) },
      ],
    } : { events: [], hosts: [] }),
  };
  cal.refetch();
  const html = await show(at(2026, 11, 11));
  assert.ok(!html.includes("<img"), "no raw markup from a served field");
  assert.ok(html.includes("Canceled: &lt;img"));
  assert.match(html, /class="cal-ev canceled past/);                 // 9–10 is before 10:30
  assert.match(html, /cal-ev tenir[^"]*"[^>]*aria-label="Hallway chat,[^"]*captured by Tenir, not on Outlook"/);
  assert.match(html, /class="cal-tenir"/);
  assert.match(html, /box&lt;img src=x onerror=alert\(1\)&gt; is offline — showing its calendar as last synced 1 h ago/);
  assert.match(html, /class="cal-now"/);                               // today (Nov 11) is in view
  assert.match(html, /cal-dh today"[^>]*aria-current="date"/);
  // The placeholder detail escapes too.
  const btn = /data-ev="(\d+)" data-day="(\d+)"/.exec(html);
  click({ ev: btn[1], day: btn[2] });
  const { side, info } = cal._els();
  assert.equal(side.hidden, false);
  assert.match(info.innerHTML, /id="calDetailTitle">Canceled: &lt;img/);
  assert.ok(!root.innerHTML.includes("<img"));
});

test("XERK-2937: grid geometry is in --slot rows, so a tall pane stretches the day", async () => {
  replies = {
    "/api/calendar": (url) => (url.includes(`from=${cal.weekStart(at(2026, 11, 11))}`) ? {
      hosts: [{ host: "h1", device: "box", online: true, syncedAt: NOW, ranges: [[0, 4e12]] }],
      events: [{ host: "h1", id: "g1", org: "", subject: "Sync", startMs: at(2026, 11, 11, 9, 30), endMs: at(2026, 11, 11, 11) }],
    } : { events: [], hosts: [] }),
  };
  cal.refetch();
  const html = await show(at(2026, 11, 11));
  const slot = (n) => `calc(var(--slot, 24px) * ${n})`;
  // 9:30 is row 19; 90 minutes is 3 rows less the 2px gap.
  assert.ok(html.includes(`top:${slot(19)};height:calc(var(--slot, 24px) * 3 - 2px);`), "event placed in rows");
  assert.ok(html.includes(`class="cal-hr" style="top:${slot(20)}"`), "10 AM label on row 20");
  assert.ok(html.includes(`;height:${slot(48)}">`), "the day is 48 rows tall");
  assert.ok(!/top:\d+px/.test(html), "no fixed-px row geometry left");
});

test("XERK-2897: holidays fill the all-day band; a day off shades only for the orgs in view", async () => {
  replies = {
    "/api/holidays": () => [{ id: "us-veterans-day", date: "2026-11-11", name: "Veterans Day", country: "US", offFor: ["acme"] }],
    "/api/calendar": () => ({ events: [], hosts: [] }),
  };
  orgKeys = [];
  cal.refetch();
  let html = await show(at(2026, 11, 11));
  assert.match(html, /class="cal-hol"[^>]*>Veterans Day</);
  assert.match(html, /cal-col today off/);
  assert.match(html, /Day off · acme/);
  orgKeys = ["other.atlassian.net"];
  html = await show(at(2026, 11, 11));
  assert.match(html, />Veterans Day</);                // still a holiday
  assert.doesNotMatch(html, /cal-col today off/);      // but not a day off for the org in view
  orgKeys = ["acme"];
  html = await show(at(2026, 11, 11));
  assert.match(html, /cal-col today off/);
  orgKeys = [];
});

test("XERK-2897: the org pick rides the calendar read, and a week the hub has not synced says so", async () => {
  const asked = [];
  replies = {
    "/api/calendar": (url) => { asked.push(url); return { events: [], hosts: [{ host: "h1", device: "laptop", online: true, pending: true, ranges: [] }] }; },
  };
  orgKeys = ["a.atlassian.net", "b.atlassian.net"];
  const html = await show(at(2027, 6, 2));
  assert.ok(asked.some((u) => u.includes("&org=a.atlassian.net%2Cb.atlassian.net")));
  assert.ok(asked.some((u) => u.includes(`from=${cal.weekStart(at(2027, 6, 2))}`)));
  assert.ok(asked.some((u) => u.includes(`from=${cal.addDays(cal.weekStart(at(2027, 6, 2)), 7)}`)), "next week prefetched");
  assert.match(html, /Syncing laptop&#39;s Outlook for this week…/);
  orgKeys = [];
});

test("XERK-2897: host notices — Outlook unreachable and a covered online host", () => {
  const ws = cal.weekStart(at(2026, 11, 11));
  const n = cal.hostNotices({ hosts: [
    { host: "a", device: "a", online: true, ranges: [[ws - 1, ws + 8 * 86400000]], lastError: "Outlook is not open", syncedAt: NOW - 120000 },
    { host: "b", device: "b", online: true, ranges: [[ws - 1, ws + 8 * 86400000]] },
  ] }, ws);
  assert.equal(n.length, 1);
  // lastError is quoted in the hub's / Outlook's own words, never re-labelled.
  assert.equal(cal.noticeText(n[0], NOW), "a: the calendar sync reported a problem — Outlook is not open (last synced 2 min ago).");
  const off = cal.hostNotices({ hosts: [{ host: "c", device: "c", online: false, ranges: [[ws - 1, ws + 8 * 86400000]],
    lastError: "the hub kept 1500 of 1600 events", syncedAt: NOW - 120000 }] }, ws);
  assert.equal(cal.noticeText(off[0], NOW),
    "c is offline — showing its calendar as last synced 2 min ago. Last sync problem: the hub kept 1500 of 1600 events");
  assert.equal(cal.safeHttps("javascript:alert(1)"), "");
  assert.equal(cal.safeHttps('https://x.test/"onmouseover'), "");
});

test("XERK-2897: the org pick is the cache key — another pick's events never show", async () => {
  const ws = cal.weekStart(at(2027, 2, 3));
  replies = {
    "/api/calendar": (url) => ({ hosts: [], events: url.includes("org=a.atlassian.net") && url.includes(`from=${ws}`)
      ? [{ host: "h1", id: "A1", org: "a.atlassian.net", subject: "Only for A", startMs: at(2027, 2, 3, 9), endMs: at(2027, 2, 3, 10) }]
      : [] }),
  };
  orgKeys = ["a.atlassian.net"];
  assert.match(await show(at(2027, 2, 3)), /Only for A/);
  orgKeys = ["b.atlassian.net"];
  assert.doesNotMatch(await show(at(2027, 2, 3)), /Only for A/);
  orgKeys = [];
});

test("XERK-2897: holiday names and an org color are escaped / whitelisted", async () => {
  const evil = "<img src=x onerror=alert(2)>";
  const board = globalThis.TurmaBoard;
  globalThis.TurmaBoard = { ...board, orgColorMap: () => new Map([["acme", "red;background:url(x)"]]) };
  replies = {
    "/api/holidays": () => [{ id: "h", date: "2027-03-03", name: evil, country: "US", offFor: [] }],
    "/api/calendar": () => ({ hosts: [], events: [{ host: "h1", id: "c1", org: "acme", subject: "Colored",
      startMs: at(2027, 3, 3, 9), endMs: at(2027, 3, 3, 10) }] }),
  };
  cal.refetch();
  const html = await show(at(2027, 3, 3));
  globalThis.TurmaBoard = board;
  assert.match(html, /Colored/);
  assert.ok(!html.includes("<img"), "holiday name escaped");
  assert.ok(!html.includes("url(x)"), "an org color is inlined only as var(--sN)");
});

test("XERK-2897: a 401 sends the page to the login", async () => {
  replies = { "/api/calendar": () => ({ status: 401 }) };
  globalThis.location.href = "";
  cal.refetch();
  await show(at(2027, 4, 7));
  assert.equal(globalThis.location.href, "/login");
});

test("XERK-2897: a failed read is retried, a hidden view asks nothing, and a frame re-reads only the shown weeks", { timeout: 10000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fail = true;
  const asked = [];
  replies = {
    "/api/calendar": (url) => {
      asked.push(url);
      if (fail) return { status: 503, body: { error: "hub restarting" } };
      return { hosts: [], events: [{ host: "h1", id: "r1", org: "", subject: "Back again",
        startMs: at(2027, 5, 5, 9), endMs: at(2027, 5, 5, 10) }] };
    },
  };
  cal.refetch();
  let html = await show(at(2027, 5, 5));
  assert.match(html, /hub restarting/);
  fail = false;
  // Hidden: the retry timer fires but reads nothing.
  cal.setActive(false);
  asked.length = 0;
  t.mock.timers.tick(20000);
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(asked.length, 0, "no read while hidden");
  // Shown again: the failed weeks are read again at once.
  html = await show(at(2027, 5, 5));
  assert.match(html, /Back again/);
  assert.doesNotMatch(html, /hub restarting/);
  // Still failing while shown: the timer re-reads it.
  fail = true; cal.refetch(); for (let i = 0; i < 6; i++) await tick();
  assert.match(cal.calendarHtml(), /hub restarting/);
  fail = false; t.mock.timers.tick(20000); for (let i = 0; i < 6; i++) await tick();
  assert.match(cal.calendarHtml(), /Back again/);
  // Browse ten weeks, then a frame: only the shown week and its neighbours are read.
  for (let i = 1; i <= 10; i++) await show(cal.addDays(at(2027, 5, 5), 7 * i));
  asked.length = 0;
  cal.refetch();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(asked.length, 3, `one read per wanted week, not per week ever seen: ${asked.length}`);
});

test("XERK-2897: failures back off; showing again asks at once; a dropped week is read fresh; key order is one pick", { timeout: 10000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fail = true, subject = "First";
  const asked = [];
  const week = cal.weekStart(at(2027, 8, 4));
  replies = {
    "/api/calendar": (url) => {
      if (url.includes(`from=${week}&`)) asked.push(url);
      if (fail) return { status: 404, body: { error: "not found" } };
      return { hosts: [], events: [{ host: "h1", id: "x", org: "", subject, startMs: at(2027, 8, 4, 9), endMs: at(2027, 8, 4, 10) }] };
    },
  };
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
  cal.refetch();
  await show(at(2027, 8, 4));
  assert.equal(asked.length, 1);
  t.mock.timers.tick(20000); await settle();
  assert.equal(asked.length, 2, "first retry after 20s");
  t.mock.timers.tick(20000); await settle();
  assert.equal(asked.length, 2, "the second waits 40s");
  t.mock.timers.tick(20000); await settle();
  assert.equal(asked.length, 3);
  // Hidden while its back-off runs, then shown: asked at once.
  cal.setActive(false);
  fail = false;
  cal.setActive(true); await settle();
  assert.equal(asked.length, 4);
  assert.match(cal.calendarHtml(), /First/);
  // Browse away, a frame drops this week, browse back: read fresh, not the old copy.
  await show(at(2027, 10, 6));
  cal.refetch(); await settle();
  subject = "Second";
  assert.match(await show(at(2027, 8, 4)), /Second/);
  // One pick whatever order the header lists it in: no second read.
  orgKeys = ["b.atlassian.net", "a.atlassian.net"];
  await show(at(2027, 8, 4));
  const n = asked.length;
  orgKeys = ["a.atlassian.net", "b.atlassian.net"];
  await show(at(2027, 8, 4));
  assert.equal(asked.length, n);
  orgKeys = [];
});

test("XERK-2897: Esc closes the detail from anywhere, never under a shown modal or a handled key", async () => {
  replies = { "/api/calendar": () => ({ hosts: [], events: [{ host: "h1", id: "e", org: "", subject: "Esc me",
    startMs: at(2027, 9, 8, 9), endMs: at(2027, 9, 8, 10) }] }) };
  cal.refetch();
  const html = await show(at(2027, 9, 8));
  const btn = /data-ev="(\d+)" data-day="(\d+)"/.exec(html);
  const open = () => { click({ ev: btn[1], day: btn[2] }); };
  const esc = (extra = {}) => { for (const f of root.listeners.keydown) f({ key: "Escape", target: {}, preventDefault() {}, ...extra }); };
  let shown = null;
  // Only a SHOWN modal counts: the New-ticket panel is always in the DOM, hidden.
  globalThis.document = { querySelector: (sel) => (sel.includes(":not([hidden])") ? shown : {}) };
  try {
    open();
    shown = {};
    esc();
    assert.ok(cal._state().detail, "a shown modal owns the Esc");
    shown = null;
    esc({ defaultPrevented: true });
    assert.ok(cal._state().detail, "a menu or modal already handled it");
    esc();
    assert.equal(cal._state().detail, null, "from anywhere else (header, body, the calendar)");
  } finally { delete globalThis.document; }
});

test("XERK-2897: a read the frame dropped is not retried off screen", { timeout: 10000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const week = cal.weekStart(at(2027, 11, 3));
  const asked = [];
  let release;
  replies = { "/api/calendar": (url) => {
    if (!url.includes(`from=${week}&`)) return { hosts: [], events: [] };
    asked.push(url);
    return new Promise((r) => { release = r; });
  } };
  cal.refetch();
  await show(at(2027, 11, 3));
  assert.equal(asked.length, 1);
  await show(cal.addDays(at(2027, 11, 3), 21));            // browse away; that week is off screen
  cal.refetch();                                           // ...and a frame drops it
  release({ status: 503, body: { error: "slow and failed" } });
  for (let i = 0; i < 6; i++) await tick();
  t.mock.timers.tick(60000);
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(asked.length, 1, "the dropped week's failure arms no retry");
});

// ---- XERK-2898: the event detail panel ------------------------------------------------
// A click as a browser bubbles it to the root: the target's closest(sel) finds the control only
// when the root listener's own selector names one of its data-* attributes (XERK-2949), so a
// control dropped from that list does nothing here either.
const dataAttr = (k) => `[data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`;
function control(dataset) {
  const t = { dataset, inside: true, getAttribute: () => null };
  t.closest = (sel) => (Object.keys(dataset).some((k) => sel.split(",").map((s) => s.trim()).includes(dataAttr(k))) ? t : null);
  return t;
}
const click = (dataset) => { for (const f of root.listeners.click) f({ target: control(dataset) }); };
// The detail's buttons and selects as fresh nodes parsed from its markup, as a repaint makes them.
function detailControls(html) {
  return [...html.matchAll(/<(?:button|select)\b([^>]*)>/g)].map(([, attrs]) => {
    const ds = {};
    for (const [, k, v] of attrs.matchAll(/\bdata-([a-z-]+)(?:="([^"]*)")?/g)) ds[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v ?? "";
    return control(ds);
  });
}
const change = (dataset, value) => { for (const f of root.listeners.change || []) f({ target: { dataset, value } }); };
async function openEvent(anchorMs, match) {
  const html = await show(anchorMs);
  const re = new RegExp(`data-ev="(\\d+)" data-day="(\\d+)"[^>]*aria-label="${match}`);
  const m = re.exec(html);
  assert.ok(m, `an event button labelled ${match}`);
  click({ ev: m[1], day: m[2] });
  return cal._els().info.innerHTML;
}

test("XERK-2898: the detail shows Outlook's details — moved, canceled, recurrence, people, responses — every field escaped", async () => {
  const evil = "<img src=x onerror=alert(1)>";
  replies = { "/api/calendar": () => ({ hosts: [], events: [{
    host: "h1", id: "G1:2027-03-09T09:00:00-05:00", seriesId: "G1", org: "", source: "outlook", meetings: [],
    subject: `Plan ${evil}`, startMs: at(2027, 3, 10, 14), endMs: at(2027, 3, 10, 15), canceled: true, recurring: true,
    location: evil, organizer: evil, organizerEmail: "o@x.example", myResponse: "accepted",
    attendees: [{ name: evil, email: "a@x.example", role: "optional", response: "declined" },
      { name: "", email: "b@x.example", role: "required", response: "accepted" }, "junk"],
    joinUrl: "https://teams.example/j/1", body: `line one\n${evil}`, categories: [evil, "Blue", 7],
  }] }) };
  cal.refetch();
  let h = await openEvent(at(2027, 3, 10), "Canceled: Plan");
  assert.ok(!h.includes("<img"), "no raw markup from a served field");
  assert.match(h, /id="calDetailTitle">Canceled: Plan &lt;img/);
  assert.match(h, /cal-dstate">Canceled</);
  assert.match(h, /<span class="k">Moved<\/span><span class="v">from Tuesday, March 9, 9:00\s?AM<\/span>/);
  assert.match(h, /Part of a recurring series/);
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt; \(o@x\.example\)/);
  assert.match(h, /<span class="k">You<\/span><span class="v">Accepted</);
  // The attendee list starts collapsed (XERK-2942): a toggle naming the count, no names.
  assert.match(h, /data-att-toggle aria-expanded="false">▸ Attendees \(2\)<\/button>/);
  assert.doesNotMatch(h, /cal-people/, "the attendees start collapsed");
  click({ attToggle: "" });
  h = cal._els().info.innerHTML;
  assert.match(h, /data-att-toggle aria-expanded="true">▾ Attendees \(2\)/);
  assert.match(h, /<span class="who" title="a@x\.example">&lt;img[^<]*<\/span><span class="role">optional<\/span><span class="resp declined">Declined/);
  assert.match(h, /<span class="who">b@x\.example<\/span><span class="resp accepted">Accepted/);
  assert.match(h, /<span class="cal-cat">&lt;img[^<]*<\/span><span class="cal-cat">Blue<\/span><\/span>/);
  assert.match(h, /href="https:\/\/teams\.example\/j\/1"[^>]*>Join meeting/);
  assert.match(h, /data-body-toggle aria-expanded="false"/);
  assert.doesNotMatch(h, /cal-dbody/, "the description starts collapsed");
  assert.equal(cal._els().side.hidden, false);
  click({ bodyToggle: "" });
  h = cal._els().info.innerHTML;
  assert.match(h, /<div class="cal-dbody">line one<br>&lt;img src=x onerror=alert\(1\)&gt;<\/div>/);
  click({ closeDetail: "" });
  assert.equal(cal._els().side.hidden, true);
  // Reopened, the attendee list is collapsed again (XERK-2942).
  h = await openEvent(at(2027, 3, 10), "Canceled: Plan");
  assert.match(h, /data-att-toggle aria-expanded="false"/);
  assert.doesNotMatch(h, /cal-people/);
  click({ closeDetail: "" });
  // A join link is only ever an https URL.
  assert.doesNotMatch(cal.detailHtml({ host: "h", id: "x", startMs: 1, endMs: 2, joinUrl: "javascript:alert(1)" }, 0), /Join meeting|javascript:/);
  // An occurrence still at its original start says nothing about a move.
  assert.equal(cal.originalStart({ id: "G1:2027-03-09T09:00:00-05:00", seriesId: "" }), NaN);
  assert.doesNotMatch(cal.detailHtml({ host: "h", id: "G1:2027-03-09T09:00:00-05:00", seriesId: "G1",
    startMs: Date.parse("2027-03-09T09:00:00-05:00"), endMs: Date.parse("2027-03-09T10:00:00-05:00") }, 0), /Moved/);
});

test("XERK-2949: the attendee toggle clicks through the root listener and keeps focus across its repaint", async () => {
  replies = { "/api/calendar": () => ({ hosts: [], events: [{ host: "h1", id: "ATT", org: "", source: "outlook", meetings: [],
    subject: "Crowd", startMs: at(2027, 4, 14, 9), endMs: at(2027, 4, 14, 10),
    attendees: [{ name: "Ann", email: "a@x.example" }, { name: "Bo", email: "b@x.example" }] }] }) };
  cal.refetch();
  const h = await openEvent(at(2027, 4, 14), "Crowd");
  assert.match(h, /data-att-toggle aria-expanded="false"/);
  const info = cal._els().info;
  const qsa = info.querySelectorAll;
  let focused = null;
  info.querySelectorAll = () => detailControls(info.innerHTML).map((c) => Object.assign(c, { focus() { focused = c; } }));
  // Enter on the focused toggle: a click on it, then the repaint swaps the node under focus.
  globalThis.document = { activeElement: control({ attToggle: "" }), querySelector: () => null };
  try {
    click({ attToggle: "" });
    assert.match(info.innerHTML, /data-att-toggle aria-expanded="true"/, "the root listener handles the toggle");
    assert.ok(focused && focused.dataset.attToggle !== undefined, "focus moves to the repainted toggle");
    // The next Space is a click on the node that now holds focus: it collapses again.
    globalThis.document.activeElement = focused;
    focused = null;
    for (const f of root.listeners.click) f({ target: globalThis.document.activeElement });
    assert.match(info.innerHTML, /data-att-toggle aria-expanded="false"/);
    assert.ok(focused && focused.dataset.attToggle !== undefined);
  } finally { delete globalThis.document; info.querySelectorAll = qsa; click({ closeDetail: "" }); }
});

test("XERK-2898: a Tenir-only entry says it is not on Outlook and shows what the capture knows, escaped", () => {
  const evil = "<script>x</script>";
  const ev = { source: "tenir", host: "", org: "acme", id: "tenir:m9", site: "acme", meetingId: "m9", subject: `Hallway ${evil}`,
    startMs: at(2027, 3, 10, 14), endMs: at(2027, 3, 10, 15), participants: [evil, "Bo", 3], summary: `We met.\n\n${evil}`,
    tenirUrl: "https://tenir.example/c/9", status: "ok", moved: true, calendarEventMissing: true, ambiguous: true };
  const h = cal.detailHtml(ev, at(2027, 3, 11));
  assert.ok(!h.includes("<script>"));
  assert.match(h, /Captured by Tenir — not on Outlook/);
  assert.match(h, /its Outlook event moved to another time/);
  assert.match(h, /no longer on the calendar/);
  assert.match(h, /More than one Outlook event fits/);
  assert.match(h, /<div class="mt-people" aria-label="Participants"><span>&lt;script&gt;x&lt;\/script&gt;<\/span><span>Bo<\/span><\/div>/);
  assert.match(h, /<p>We met\.<\/p><p>&lt;script&gt;/);
  assert.match(h, /href="https:\/\/tenir\.example\/c\/9"/);
  assert.match(h, /This capture/);
  // meetings.js painted the row itself: the entry's own copy is not repeated.
  assert.doesNotMatch(cal.detailHtml(ev, 0, true), /mt-people|mt-summary|Open in Tenir/);
  assert.doesNotMatch(cal.detailHtml({ ...ev, tenirUrl: "javascript:alert(1)" }, 0), /javascript:|Open in Tenir/);
});

test("XERK-2898: badges count proposals still needing review; a meeting being read shows a spinner", async () => {
  const state = { "acme/m1": { pending: 3, reading: false }, "acme/m2": { pending: 0, reading: true }, "beta/m3": { pending: 1, reading: false } };
  globalThis.TurmaMeetings = { meetingState: (_d, site, mid) => state[`${site}/${mid}`] || null, showPanel: () => false };
  try {
    cal.update({ agents: [] });
    const o = (over) => ({ host: "h1", id: over.id, org: "", startMs: at(2027, 4, 7, 9), endMs: at(2027, 4, 7, 10), ...over });
    assert.deepEqual(cal.badgeOf(o({ id: "a", meetings: [{ site: "acme", meetingId: "m1" }, { site: "beta", meetingId: "m3" }] })), { pending: 4, reading: false });
    assert.deepEqual(cal.badgeOf(o({ id: "b", meetings: [{ site: "acme", meetingId: "m2" }] })), { pending: 0, reading: true });
    // A Tenir entry the snapshot no longer carries falls back to its own status.
    assert.deepEqual(cal.badgeOf(o({ id: "tenir:zz", source: "tenir", site: "acme", meetingId: "zz", status: "running" })), { pending: 0, reading: true });
    assert.deepEqual(cal.badgeOf(o({ id: "c" })), { pending: 0, reading: false });
    replies = { "/api/calendar": () => ({ hosts: [], events: [
      o({ id: "a", subject: "Review me", meetings: [{ site: "acme", meetingId: "m1" }] }),
      o({ id: "b", subject: "Reading", startMs: at(2027, 4, 7, 11), endMs: at(2027, 4, 7, 12), meetings: [{ site: "acme", meetingId: "m2" }] }),
      o({ id: "d", subject: "Plain", startMs: at(2027, 4, 7, 13), endMs: at(2027, 4, 7, 14), meetings: [{ site: "acme", meetingId: "gone" }] }),
    ] }) };
    cal.refetch();
    const html = await show(at(2027, 4, 7));
    assert.match(html, /aria-label="Review me,[^"]*, 3 proposals to review"><span class="cal-evb"><span class="t"><span class="tx">Review me<\/span><span class="cal-badge" aria-hidden="true"><svg[^]*?<\/svg>3<\/span>/);
    assert.match(html, /aria-label="Reading,[^"]*, the meeting is being read"><span class="cal-evb"><span class="t"><span class="tx">Reading<\/span><span class="cal-badge reading" aria-hidden="true"><span class="cal-spin">/);
    assert.match(html, /aria-label="Plain,[^"]*"><span class="cal-evb"><span class="t"><span class="tx">Plain<\/span><\/span>/);
  } finally { delete globalThis.TurmaMeetings; }
});

test("XERK-2898: the panel asks meetings.js for one org's captures and a daily meeting's brief", () => {
  assert.deepEqual(cal.panelSpec({ source: "outlook", org: "x", startMs: 5, meetings: [
    { site: "acme", meetingId: "m1" }, { site: "beta", meetingId: "m2" }, { site: "acme", meetingId: "m3" }] }),
  { site: "acme", meetingIds: ["m1", "m3"], dailyAt: 5 });
  assert.deepEqual(cal.panelSpec({ source: "outlook", org: "acme", startMs: 5, meetings: [] }), { site: "acme", meetingIds: [], dailyAt: 5 });
  assert.equal(cal.panelSpec({ source: "outlook", org: "", startMs: 5 }), null);
  assert.deepEqual(cal.panelSpec({ source: "tenir", site: "acme", meetingId: "m9", org: "acme", startMs: 5 }), { site: "acme", meetingIds: ["m9"], dailyAt: 0 });
});

test("XERK-2898: relink — link a Tenir capture to an event, unlink, back to automatic; a refusal shows the hub's words", async () => {
  const patched = [];
  globalThis.TurmaMeetings = { meetingState: () => ({ pending: 0, reading: false, title: "Sync", calendarBy: "operator" }),
    showPanel: () => false, patch: (site, row) => patched.push([site, row]) };
  let answer = { ok: true, meeting: { meetingId: "m9" } };
  const day = at(2027, 5, 12);
  const outlook = { host: "h1", id: "OUT1", org: "", source: "outlook", subject: "Design <review>", startMs: at(2027, 5, 12, 10), endMs: at(2027, 5, 12, 11), meetings: [] };
  const tenir = { host: "", id: "tenir:m9", source: "tenir", site: "acme", meetingId: "m9", org: "acme", subject: "Captured chat",
    startMs: at(2027, 5, 12, 10, 5), endMs: at(2027, 5, 12, 10, 50), status: "ok" };
  replies = { "/api/calendar": () => ({ hosts: [], events: [outlook, tenir,
    { ...outlook, id: "CANCEL", subject: "Gone", canceled: true }, { ...outlook, id: "OTHERDAY", subject: "Tomorrow", startMs: at(2027, 5, 13, 10), endMs: at(2027, 5, 13, 11) },
    { ...outlook, id: "OTHERORG", subject: "Beta", org: "beta" },
    // Unassigned, but on a host decided into another org: the hub's matcher counts it there.
    { ...outlook, host: "h2", id: "H2UNASSIGNED", subject: "Elsewhere" }] }),
  "/api/orgs/": () => answer };
  try {
    cal.update({ agents: [{ key: "h1", org: "acme" }, { key: "h2", org: "beta" }] });
    cal.refetch();
    posts.length = 0;
    let h = await openEvent(day, "Captured chat");
    assert.match(h, /data-link-pick="acme\/m9"/);
    // The key rides the attribute with no NUL (a parser turns it into U+FFFD, QA).
    assert.match(h, /<option value="h1\/OUT1">10:00\s?AM · Design &lt;review&gt;<\/option>/);
    assert.ok(!h.includes("\u0000"));
    assert.doesNotMatch(h, /Gone|Tomorrow|Beta|Elsewhere/, "only same-day, uncanceled events of its org (an unassigned one by its host's)");
    assert.match(h, /data-link-go="acme\/m9" aria-disabled="true"/, "nothing picked yet");
    assert.doesNotMatch(h, /data-link-unlink/, "an unlinked capture has nothing to unlink");
    assert.match(h, /data-link-auto="acme\/m9"/);
    change({ linkPick: "acme/m9" }, "h1/OUT1");
    assert.match(cal._els().info.innerHTML, /<option value="h1\/OUT1" selected>/, "the pick survives the repaint");
    click({ linkGo: "acme/m9" });
    click({ linkGo: "acme/m9" });                                 // a second press while in flight
    for (let i = 0; i < 6; i++) await tick();
    assert.deepEqual(posts.filter((p) => p.url.includes("/calendar")), [{ url: "/api/orgs/acme/meetings/m9/calendar", body: { eventId: "OUT1" } }]);
    assert.deepEqual(patched, [["acme", { meetingId: "m9" }]]);
    assert.equal(cal._state().detail.id, "OUT1", "the panel follows the capture to its event");
    // From the event: unlink, and back to the matcher.
    posts.length = 0;
    const capOnEvent = { ...outlook, meetings: [{ site: "acme", meetingId: "m9", title: "Captured <chat>" }] };
    h = cal.detailHtml(capOnEvent, day);
    assert.match(h, /Tenir capture: <b>Captured &lt;chat&gt;<\/b>/);
    assert.match(h, /data-link-unlink="acme\/m9"/);
    await cal.relink("acme/m9", { eventId: null });
    await cal.relink("acme/m9", { auto: true });
    assert.deepEqual(posts.map((p) => p.body), [{ eventId: null }, { auto: true }]);
    // A refusal is the hub's words, escaped, inline (the next read carries the link).
    replies["/api/calendar"] = () => ({ hosts: [], events: [capOnEvent] });
    cal.refetch();
    for (let i = 0; i < 6; i++) await tick();
    answer = { status: 404, body: { error: "no calendar event of this tenant's hosts has <that> id" } };
    await cal.relink("acme/m9", { eventId: null });
    assert.match(cal._els().info.innerHTML, /Unlinking the capture failed — no calendar event of this tenant&#39;s hosts has &lt;that&gt; id/);
  } finally { delete globalThis.TurmaMeetings; click({ closeDetail: "" }); }
});

test("XERK-2898: a Tenir entry that 'Match automatically' merges into an event follows it there", async () => {
  globalThis.TurmaMeetings = { meetingState: () => ({ pending: 0, reading: false, title: "Chat", calendarBy: "operator" }),
    showPanel: () => false, patch: () => {} };
  const ev = { host: "h1", id: "STAND", org: "acme", source: "outlook", subject: "Standup", startMs: at(2027, 7, 14, 9), endMs: at(2027, 7, 14, 9, 30), meetings: [] };
  const entry = { host: "", id: "tenir:c1", source: "tenir", site: "acme", meetingId: "c1", org: "acme", subject: "Chat",
    startMs: at(2027, 7, 14, 9, 2), endMs: at(2027, 7, 14, 9, 25), status: "ok" };
  let linked = false;
  replies = { "/api/calendar": () => ({ hosts: [], events: linked ? [{ ...ev, meetings: [{ site: "acme", meetingId: "c1", title: "Chat" }] }] : [ev, entry] }),
    "/api/orgs/": () => { linked = true; return { ok: true, meeting: { meetingId: "c1" } }; } };
  try {
    cal.update({ agents: [{ key: "h1", org: "acme" }] });
    cal.refetch();
    await openEvent(at(2027, 7, 14), "Chat");
    await cal.relink("acme/c1", { auto: true });
    for (let i = 0; i < 6; i++) await tick();
    assert.equal(cal._state().detail.id, "STAND");
    assert.match(cal._els().info.innerHTML, /Tenir capture: <b>Chat<\/b>[^]*data-link-unlink="acme\/c1"/);
  } finally { delete globalThis.TurmaMeetings; click({ closeDetail: "" }); }
});

test("XERK-2898: an unassigned event asks for its host's org (the daily brief needs one)", () => {
  cal.update({ agents: [{ key: "h1", org: "acme" }] });
  assert.deepEqual(cal.panelSpec({ source: "outlook", host: "h1", org: "", startMs: 5, meetings: [] }), { site: "acme", meetingIds: [], dailyAt: 5 });
  assert.equal(cal.panelSpec({ source: "outlook", host: "nobody", org: "", startMs: 5 }), null);
  cal.update({ agents: [] });
});

test("XERK-2898 QA: the detail's repaint waits while its relink pick has focus", async () => {
  replies = { "/api/calendar": () => ({ hosts: [], events: [{ host: "h1", id: "HOLD", org: "", source: "outlook", subject: "Hold me",
    startMs: at(2027, 8, 11, 9), endMs: at(2027, 8, 11, 10), meetings: [] }] }) };
  cal.refetch();
  await openEvent(at(2027, 8, 11), "Hold me");
  const before = cal._els().info.innerHTML;
  globalThis.document = { activeElement: { inside: true, tagName: "SELECT", dataset: {} }, querySelector: () => null };
  try {
    replies = { "/api/calendar": () => ({ hosts: [], events: [{ host: "h1", id: "HOLD", org: "", source: "outlook", subject: "Hold me",
      location: "Room 2", startMs: at(2027, 8, 11, 9), endMs: at(2027, 8, 11, 10), meetings: [] }] }) };
    cal.refetch();
    for (let i = 0; i < 6; i++) await tick();
    assert.equal(cal._els().info.innerHTML, before, "held while the field has focus");
  } finally { delete globalThis.document; }
  for (const f of cal._els().side.listeners.focusout) f({});
  await new Promise((r) => setTimeout(r, 5));
  assert.match(cal._els().info.innerHTML, /Room 2/);
  click({ closeDetail: "" });
});

test("XERK-2898 QA: the served matchOrg decides — a series pinned to no org is no candidate and opens no panel", () => {
  cal.update({ agents: [{ key: "h1", org: "acme" }] });
  // Unassigned on an acme host, but the hub says it counts for no org.
  assert.equal(cal.panelSpec({ source: "outlook", host: "h1", org: "", matchOrg: "", startMs: 5 }), null);
  assert.deepEqual(cal.panelSpec({ source: "outlook", host: "h1", org: "", matchOrg: "beta", startMs: 5, meetings: [] }),
    { site: "beta", meetingIds: [], dailyAt: 5 });
  cal.update({ agents: [] });
});

// ---- XERK-2899: the notes review's upcoming list and the two-way jump ----------------
// Last in the file: once the notes review asks for upcoming meetings, the calendar
// keeps reading those weeks while hidden (what the "hidden asks nothing" case pins
// for a calendar nobody else reads).
test("XERK-2899: upcoming() reads the coming week while hidden and lists only live org meetings", async () => {
  NOW = at(2026, 11, 12, 10, 30);       // Thursday: the next 7 days cross into the following week
  const m = (id, h, extra = {}) => ({ host: "h1", id, org: "acme", subject: id, joinUrl: "https://zoom.us/j/1",
    startMs: at(2026, 11, 12, h), endMs: at(2026, 11, 12, h + 1), ...extra });
  const asked = [];
  replies = { "/api/calendar": (url) => {
    asked.push(url);
    if (url.includes(`from=${cal.weekStart(at(2026, 11, 16))}&`)) {
      return { hosts: [], events: [{ host: "h1", id: "next-mon", org: "acme", subject: "Planning",
        attendees: [{ name: "Bo", role: "required" }], startMs: at(2026, 11, 16, 9), endMs: at(2026, 11, 16, 10) },
      { host: "h1", id: "far", org: "acme", subject: "Too far", startMs: at(2026, 11, 20, 9), endMs: at(2026, 11, 20, 10) }] };
    }
    return { hosts: [], events: [
      m("live", 11), m("now", 10),                                   // started, not ended: still upcoming
      { ...m("live", 11), host: "h2" },                              // the same meeting on a second host
      m("past", 8), m("canceled", 13, { canceled: true }), m("declined", 13, { myResponse: "declined" }),
      m("focus", 14, { busy: "free" }), m("wfh", 14, { busy: "workingElsewhere" }),
      // XERK-2936: a busy personal block (no one else invited, no join link) is no meeting.
      m("lunch", 12, { joinUrl: "", attendees: [{ name: "Me", role: "organizer" }, { name: "Room", role: "resource" }] }),
      m("hub-no", 12, { meeting: false }),                           // the hub's verdict wins over a link
      // A private meeting is served with no attendees or link: the hub's flag keeps it.
      m("private", 12, { joinUrl: "", attendees: [], meeting: true }),
      m("online", 12, { joinUrl: "", isOnlineMeeting: true }),
      m("allday", 0, { allDay: true, endMs: at(2026, 11, 13) }), m("other", 15, { org: "rival" }),
      m("captured", 15, { meetings: [{ site: "acme", meetingId: "c1", title: "x" }] }),
      { host: "", id: "tenir:t1", source: "tenir", org: "acme", site: "acme", meetingId: "t1", subject: "Adhoc",
        startMs: at(2026, 11, 12, 16), endMs: at(2026, 11, 12, 17) },
    ] };
  } };
  let landed = 0;
  cal._setHooks({ onData: () => { landed++; } });
  cal.setActive(false);
  cal.refetch();
  assert.deepEqual(cal.upcoming("acme"), [], "nothing read yet");
  for (let i = 0; i < 6; i++) await tick();
  assert.ok(landed >= 2, "the page hears each read land");
  assert.deepEqual(cal.upcoming("acme").map((e) => e.id), ["now", "live", "private", "online", "next-mon"]);
  assert.deepEqual(cal.upcoming("rival").map((e) => e.id), ["other"]);
  // A frame while hidden re-reads exactly those weeks.
  asked.length = 0;
  cal.refetch();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(asked.length, 2, `the two upcoming weeks: ${asked.join(" ")}`);
});

test("XERK-2899: reveal() opens the week and the event carrying a capture; the panel jumps back", async () => {
  NOW = at(2026, 11, 12, 10, 30);
  const week = cal.weekStart(at(2026, 12, 2));
  replies = { "/api/calendar": (url) => (url.includes(`from=${week}&`) ? { hosts: [], events: [
    { host: "h1", id: "ev-1", org: "acme", subject: "Retro", startMs: at(2026, 12, 2, 15), endMs: at(2026, 12, 2, 16),
      meetings: [{ site: "acme", meetingId: "cap-1", title: "Retro" }] },
    { host: "h1", id: "ev-2", org: "acme", subject: "Other", startMs: at(2026, 12, 3, 9), endMs: at(2026, 12, 3, 10) },
    { host: "", id: "tenir:cap-2", source: "tenir", org: "acme", site: "acme", meetingId: "cap-2", subject: "Hallway",
      startMs: at(2026, 12, 4, 11), endMs: at(2026, 12, 4, 12) },
  ] } : { hosts: [], events: [] }) };
  const jumps = [];
  cal._setHooks({ openNotes: (t) => jumps.push(t) });
  cal.refetch();
  cal.setActive(true);
  cal.reveal({ site: "acme", meetingId: "cap-1", eventId: "ev-1", startMs: at(2026, 12, 2, 15) });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(cal.dayKey(cal._state().anchor), "2026-12-02");
  assert.equal(cal._state().detail && cal._state().detail.id, "ev-1");
  assert.match(root.innerHTML, /data-open-notes>Open in notes review</);
  click({ openNotes: "" });
  assert.deepEqual(jumps, [{ site: "acme", meetingId: "cap-1" }]);
  // A Tenir-only capture is found by its meeting id; a past, unlinked event has no way back.
  cal.reveal({ site: "acme", meetingId: "cap-2", startMs: at(2026, 12, 4, 11) });
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(cal._state().detail.id, "tenir:cap-2");
  assert.deepEqual(cal.notesTarget(cal._state().detail, NOW), { site: "acme", meetingId: "cap-2" });
  assert.deepEqual(cal.notesTarget({ id: "u", org: "acme", joinUrl: "https://zoom.us/j/1", startMs: NOW + 3600000, endMs: NOW + 7200000 }, NOW),
    { site: "acme", eventId: "u" }, "an upcoming meeting opens its notes-review entry");
  assert.equal(cal.notesTarget({ id: "p", org: "acme", startMs: NOW - 7200000, endMs: NOW - 3600000 }, NOW), null);
  // An id this week does not hold leaves the panel shut, on that week.
  cal.reveal({ eventId: "nope", startMs: at(2026, 12, 3, 9) });
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(cal._state().detail, null);
  assert.equal(cal.dayKey(cal._state().anchor), "2026-12-03");
  cal.setActive(false);
});

test("XERK-2899 QA: a weekend reveal shows Week (unsaved); navigation drops a reveal still waiting", { timeout: 10000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  NOW = at(2026, 11, 12, 10, 30);
  const wk = cal.weekStart(at(2027, 2, 6));
  let fail = true;
  replies = { "/api/calendar": (url) => {
    if (!url.includes(`from=${wk}&`)) return { hosts: [], events: [] };
    if (fail) return { status: 503, body: { error: "down" } };
    return { hosts: [], events: [{ host: "h1", id: "sat", org: "acme", subject: "Saturday sync",
      startMs: at(2027, 2, 6, 10), endMs: at(2027, 2, 6, 11) }] };
  } };
  cal.setActive(true);
  assert.equal(cal._state().mode, "work");
  cal.reveal({ eventId: "sat", startMs: at(2027, 2, 6, 10) });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(cal._state().mode, "week", "a Saturday meeting is drawn, not just paneled");
  assert.equal(cal._state().detail, null, "its week failed: nothing to open yet");
  // The viewer moves on; the week recovering later must not yank them back.
  cal._go(at(2027, 3, 3));
  fail = false;
  cal._go(at(2027, 2, 6));
  t.mock.timers.tick(20000);
  for (let i = 0; i < 8; i++) await tick();
  assert.match(cal.calendarHtml(), /Saturday sync/);
  assert.equal(cal._state().detail, null);
  // An id the week does not hold is dropped once read: a later read that has it opens nothing.
  cal.reveal({ eventId: "later", startMs: at(2027, 2, 6, 10) });
  for (let i = 0; i < 8; i++) await tick();
  replies["/api/calendar"] = () => ({ hosts: [], events: [{ host: "h1", id: "later", org: "acme", subject: "Later",
    startMs: at(2027, 2, 6, 12), endMs: at(2027, 2, 6, 13) }] });
  cal.refetch();
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(cal._state().detail, null);
  // A weekday reveal ends the weekend Week; so does a mode pick.
  cal.reveal({ eventId: "x", startMs: at(2027, 2, 8, 10) });
  assert.equal(cal._state().mode, "work");
  cal.reveal({ eventId: "sat", startMs: at(2027, 2, 6, 10) });
  click({ mode: "work" });
  assert.equal(cal._state().mode, "work");
  cal.setActive(false);
});

test("XERK-2899 QA: a hidden calendar still retries a failed upcoming week", { timeout: 10000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  NOW = at(2027, 6, 2, 10);
  let fail = true;
  const asked = [];
  replies = { "/api/calendar": (url) => { asked.push(url); return fail ? { status: 503, body: { error: "down" } } : { hosts: [], events: [] }; } };
  cal.setActive(false);
  cal.upcoming("acme");
  for (let i = 0; i < 8; i++) await tick();
  const first = asked.length;
  assert.ok(first >= 1);
  fail = false;
  t.mock.timers.tick(20000);
  for (let i = 0; i < 8; i++) await tick();
  assert.ok(asked.length > first, "the notes review's weeks are read again while hidden");
});

test("XERK-2914: a reveal scrolls the grid to the event and moves focus into its panel, once", async () => {
  NOW = at(2026, 11, 12, 10, 30);
  replies = { "/api/calendar": () => ({ hosts: [], events: [
    { host: "h1", id: "late", org: "acme", subject: "Late one", startMs: at(2027, 2, 3, 15), endMs: at(2027, 2, 3, 16) },
  ] }) };
  const [grid, side] = root.children;            // mount's .cal-main and aside.cal-detail
  const scroller = { scrollTop: 0 };
  const qs = grid.querySelector;
  grid.querySelector = (sel) => (sel === "#calScroll" ? scroller : null);
  let focused = 0;
  side.focus = () => { focused++; };
  try {
    cal.refetch();
    cal.setActive(true);
    cal.reveal({ site: "acme", eventId: "late", startMs: at(2027, 2, 3, 15) });
    for (let i = 0; i < 8; i++) await tick();
    assert.equal(cal._state().detail && cal._state().detail.id, "late");
    // 15:00 is row 30 of 24px; one hour of context sits above it.
    assert.equal(scroller.scrollTop, (900 / 30) * 24 - 48, "the grid scrolls to the event");
    assert.equal(focused, 1, "the panel takes focus");
    // A later repaint leaves the operator's scroll and focus alone.
    scroller.scrollTop = 5;
    cal.refetch();
    for (let i = 0; i < 4; i++) await tick();
    assert.equal(scroller.scrollTop, 5);
    assert.equal(focused, 1);
  } finally {
    grid.querySelector = qs;
    delete side.focus;
    cal.setActive(false);
  }
});

test("XERK-2933: a cross-midnight event's label and When name the end's date", () => {
  const ev = { host: "h", org: "acme", id: "x", subject: "Late", startMs: at(2026, 10, 31, 22), endMs: at(2026, 11, 1, 3) };
  const when = /Saturday, October 31, 10:00\s?PM – Sunday, November 1, 3:00\s?AM/;
  assert.match(cal.fmtLongSpan(ev.startMs, ev.endMs), when);
  assert.match(cal.detailHtml(ev, at(2026, 11, 2)), when);
  // A same-day span keeps the short form with no repeated date.
  const same = cal.fmtLongSpan(at(2026, 11, 9, 9), at(2026, 11, 9, 9, 30));
  assert.match(same, /^Monday, November 9, 9:00/);
  assert.equal(same.match(/November/g).length, 1);
  assert.match(cal.fmtLongSpan(at(2026, 11, 9, 9), at(2026, 11, 9, 9)), /^Monday, November 9, 9:00\s?AM$/);
});

test("XERK-2933: a cross-midnight event's button aria-label names the end's date on both days", async () => {
  replies = {
    "/api/calendar": (url) => (url.includes(`from=${cal.weekStart(at(2026, 11, 11))}`) ? {
      hosts: [{ host: "h1", device: "box", online: true, syncedAt: NOW, ranges: [[0, 4e12]] }],
      events: [{ host: "h1", id: "late", org: "", subject: "Night shift", startMs: at(2026, 11, 10, 22), endMs: at(2026, 11, 11, 3) }],
    } : { events: [], hosts: [] }),
  };
  cal.refetch();
  const html = await show(at(2026, 11, 11));
  const labels = [...html.matchAll(/aria-label="(Night shift,[^"]*)"/g)].map((m) => m[1]);
  assert.equal(labels.length, 2, "one button on each day");
  for (const l of labels) assert.match(l, /Tuesday, November 10, 10:00\s?PM – Wednesday, November 11, 3:00\s?AM/);
});

test("XERK-2940: a Sunday starts its week — reveal, holiday read and the date picker", async () => {
  NOW = at(2028, 5, 13, 10);                         // a Saturday, in a week no other test read
  const asked = [];
  replies = {
    "/api/calendar": (url) => { asked.push(url); return { hosts: [], events: [] }; },
    "/api/holidays": (url) => { asked.push(url); return []; },
  };
  cal.setActive(true);
  assert.equal(cal._state().mode, "work");
  // A Sunday meeting is drawn in Week, in the week that Sunday starts.
  cal.reveal({ eventId: "sun", startMs: at(2028, 5, 14, 10) });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(cal._state().mode, "week", "a Sunday reveal shows Week, not Work week");
  assert.equal(cal.dayKey(cal.visibleDays(cal._state().anchor, "week")[0]), "2028-05-14");
  // Holidays are read for that Sunday through Saturday, so a Sunday holiday is not dropped.
  assert.ok(asked.some((u) => u.startsWith("/api/holidays?from=2028-05-14&until=2028-05-20")), asked.join("\n"));
  // The mini-month opens on a Sunday: May 2028's first cell is Sunday, April 30.
  click({ openPicker: "" });
  const first = /data-pick="(\d+)"/.exec(cal.calendarHtml());
  assert.ok(first, "the picker is open");
  assert.equal(cal.dayKey(Number(first[1])), "2028-04-30");
  assert.equal(new Date(Number(first[1])).getDay(), 0);
  cal.setActive(false);
});

test("XERK-2934: a timed event of 24h+ keeps its times; a real all-day event still reads 'all day'", () => {
  const ev = { host: "h", org: "acme", id: "x", subject: "Offsite", startMs: at(2026, 11, 9, 9), endMs: at(2026, 11, 10, 10) };
  assert.ok(cal.inBand(ev), "still drawn in the all-day band");
  const when = /Monday, November 9, 9:00\s?AM – Tuesday, November 10, 10:00\s?AM/;
  assert.match(cal.detailHtml(ev, at(2026, 11, 10)), when);
  assert.doesNotMatch(cal.detailHtml(ev, at(2026, 11, 10)), /all day/);
  const allDay = { ...ev, allDay: true, startMs: at(2026, 11, 9), endMs: at(2026, 11, 10) };
  assert.match(cal.detailHtml(allDay, at(2026, 11, 9)), /Monday, November 9, all day/);
  // A multi-day all-day event names its last day (end is exclusive midnight).
  const multi = { ...allDay, endMs: at(2026, 11, 12) };
  assert.match(cal.detailHtml(multi, at(2026, 11, 9)), /Monday, November 9 – Wednesday, November 11, all day/);
});

test("XERK-2934: a 24h+ timed event's band button aria-label names both ends", async () => {
  replies = {
    "/api/calendar": (url) => (url.includes(`from=${cal.weekStart(at(2026, 11, 11))}`) ? {
      hosts: [{ host: "h1", device: "box", online: true, syncedAt: NOW, ranges: [[0, 4e12]] }],
      events: [
        { host: "h1", id: "long", org: "", subject: "Offsite", startMs: at(2026, 11, 9, 9), endMs: at(2026, 11, 10, 10) },
        { host: "h1", id: "ad", org: "", subject: "Holiday", allDay: true, startMs: at(2026, 11, 12), endMs: at(2026, 11, 13) },
      ],
    } : { events: [], hosts: [] }),
  };
  cal.refetch();
  const html = await show(at(2026, 11, 11));
  const labels = [...html.matchAll(/aria-label="(Offsite,[^"]*)"/g)].map((m) => m[1]);
  assert.ok(labels.length >= 1);
  for (const l of labels) {
    assert.match(l, /Monday, November 9, 9:00\s?AM – Tuesday, November 10, 10:00\s?AM/);
    assert.doesNotMatch(l, /all day/);
  }
  // A real all-day event's button still reads "all day".
  assert.match(html, /aria-label="Holiday,[^"]*Thursday, November 12, all day/);
});

test("XERK-2964: an Outlook event's org is shown, never picked; host settings set private events only", async () => {
  const D = at(2027, 9, 14);
  const hostRow = { host: "h1", device: "Box <1>", online: true, syncedAt: NOW, ranges: [[0, 4e12]],
    org: "acme", showPrivate: false };
  const ev = { host: "h1", id: "G1:x", seriesId: "G1", recurring: true, org: "acme", source: "outlook", subject: "Weekly",
    startMs: at(2027, 9, 14, 10), endMs: at(2027, 9, 14, 11), meetings: [] };
  let answer = { ok: true, settings: {} };
  replies = { "/api/calendar": () => ({ hosts: [hostRow], events: [ev] }), "/api/agents/": () => answer };
  const fire = (name, ds, extra = {}) => { for (const fn of root.listeners[name]) fn({ target: { dataset: ds, closest: () => ({ dataset: ds }), ...extra } }); };
  try {
    cal.update({ agents: [{ key: "h1", org: "acme" }] });
    let h = await show(D);
    assert.match(h, /data-host-settings aria-expanded="false"/);
    fire("click", { hostSettings: "" });
    h = cal.calendarHtml();
    // Each host names its org as text; there is no Default org pick.
    assert.match(h, /<b>Box &lt;1&gt;<\/b><span class="cal-dnote">acme<\/span>/);
    assert.doesNotMatch(h, /Default org|data-host-default|<select/);
    assert.doesNotMatch(h, /email-domain rule/);
    posts.length = 0;
    fire("change", { hostPrivate: "h1" }, { checked: true });
    for (let i = 0; i < 6; i++) await tick();
    assert.deepEqual(posts.map((p) => [p.url, p.body]), [["/api/agents/h1/calendar/settings", { showPrivate: true }]]);
    // The event panel names the org as plain text: no select, no "whole series" note.
    h = cal.detailHtml(ev, D);
    assert.match(h, /<span class="k">Org<\/span><span class="v">acme<\/span>/);
    assert.doesNotMatch(h, /data-series-org|<select|for the whole series/);
    assert.match(h, /Part of a recurring series/);
    // Busy controls are aria-disabled, never disabled (focus would fall to <body>).
    assert.doesNotMatch(cal.calendarHtml() + cal.detailHtml(ev, D), / disabled[ >]/);
    // A refusal is the hub's words, escaped, on the host's row.
    answer = { status: 400, body: { error: "body must be <showPrivate>" } };
    fire("change", { hostPrivate: "h1" }, { checked: false });
    for (let i = 0; i < 6; i++) await tick();
    assert.match(cal.calendarHtml(), /Saving the calendar settings failed — body must be &lt;showPrivate&gt;/);
  } finally { fire("click", { hostSettings: "" }); click({ closeDetail: "" }); }
});

test("XERK-2943: a short block still carries its time line; the drawn height (CSS) decides if it shows", async () => {
  cal.update({ agents: [] });
  replies = { "/api/calendar": () => ({ hosts: [], events: [
    { host: "h1", id: "q", org: "", subject: "Quick", startMs: at(2027, 4, 7, 9), endMs: at(2027, 4, 7, 9) + 15 * 60000 },
  ] }) };
  cal.refetch();
  const html = await show(at(2027, 4, 7));
  assert.match(html, /<button type="button" class="cal-ev[^"]*" [^>]*aria-label="Quick,[^"]*"><span class="cal-evb"><span class="t"><span class="tx">Quick<\/span><\/span><span class="m">9:00\s–\s9:15\sAM<\/span><\/span><\/button>/);
  assert.doesNotMatch(html, /class="cal-ev[^"]*\bshort\b/);
});

test("XERK-2943: brief.html keeps the CSS that sizes short blocks and clears the detail panel", () => {
  const css = require("fs").readFileSync(require("path").join(__dirname, "..", "public", "brief.html"), "utf8");
  assert.match(css, /\.wrap\.tri-wrap \{ --tri-wrap: 1280px; max-width: var\(--tri-wrap\);/);
  assert.match(css, /\.cal-ev:not\(\.allday\) \{ container-type: size;/);
  assert.match(css, /@container \(height < 34px\) \{[^}]*\.cal-evb \{[^}]*\}\s*\.cal-evb \.m \{ display: none; \}/);
  assert.match(css, /\.cal:has\(> \.cal-detail:not\(\[hidden\]\)\) > \.cal-main \{\s*margin-right: max\(0px, 447px - max\(0px, \(100vw - var\(--tri-wrap\)\) \/ 2\)\);/);
});

test("XERK-2939: the detail panel wears its event's org color; an unassigned or forged one stays plain", async () => {
  const board = globalThis.TurmaBoard;
  globalThis.TurmaBoard = { ...board, orgColorMap: () => new Map([["acme", "var(--s3)"], ["evil", "red;x:url(y)"]]) };
  replies = { "/api/calendar": () => ({ hosts: [], events: [
    { host: "h1", id: "o1", org: "acme", source: "outlook", meetings: [], subject: "Acme sync",
      startMs: at(2027, 4, 7, 9), endMs: at(2027, 4, 7, 10) },
    { host: "h1", id: "o2", org: "", source: "outlook", meetings: [], subject: "Loose",
      startMs: at(2027, 4, 7, 11), endMs: at(2027, 4, 7, 12) },
    { host: "h1", id: "o3", org: "evil", source: "outlook", meetings: [], subject: "Forged",
      startMs: at(2027, 4, 7, 13), endMs: at(2027, 4, 7, 14) },
  ] }) };
  try {
    cal.refetch();
    const { side } = cal._els();
    await openEvent(at(2027, 4, 7), "Acme sync");
    assert.equal(side.style.props["--org"], "var(--s3)");
    await openEvent(at(2027, 4, 7), "Loose");
    assert.equal(side.style.props["--org"], undefined, "an unassigned event clears the previous tint");
    await openEvent(at(2027, 4, 7), "Acme sync");
    await openEvent(at(2027, 4, 7), "Forged");
    assert.equal(side.style.props["--org"], undefined, "only a var(--sN) slot is ever inlined");
  } finally {
    globalThis.TurmaBoard = board;
  }
});

test("XERK-2939: the detail panel's tint is exactly the session card's mix", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "public", f), "utf8");
  const mix = (css, sel) => {
    const rule = new RegExp(`${sel}\\s*\\{[^}]*?background:\\s*color-mix\\(in srgb, var\\(--org[^)]*\\)\\)?\\s*(\\d+)%, var\\(--surface\\)\\)`).exec(css);
    assert.ok(rule, `${sel} has an org color-mix background`);
    return rule[1];
  };
  const card = mix(read("sessions.html"), "\\.s-card");
  assert.equal(mix(read("app.css"), "\\.kanban-card"), card);
  assert.equal(mix(read("brief.html"), "\\.cal-detail"), card, "the panel matches the session card (operator's rule)");
});

test("XERK-3023: a Turma event's panel wears its block's gradient; an Outlook one keeps the org tint", async () => {
  replies = { "/api/calendar": () => ({ hosts: [], events: [
    { host: "", id: "turma:0123456789abcdef", org: "acme", orgs: ["acme"], source: "turma", meetings: [],
      subject: "Made here", startMs: at(2027, 4, 8, 9), endMs: at(2027, 4, 8, 10) },
    { host: "h1", id: "o9", org: "acme", source: "outlook", meetings: [], subject: "From Outlook",
      startMs: at(2027, 4, 8, 11), endMs: at(2027, 4, 8, 12) },
    { host: "", id: "tenir:m9", org: "acme", source: "tenir", site: "acme", meetingId: "m9", subject: "Impromptu",
      participants: [], status: "ok", startMs: at(2027, 4, 8, 14), endMs: at(2027, 4, 8, 15) },
  ] }) };
  cal.refetch();
  const { side } = cal._els();
  await openEvent(at(2027, 4, 8), "Made here");
  assert.equal(side.className, "cal-detail turma");
  await openEvent(at(2027, 4, 8), "From Outlook");
  assert.equal(side.className, "cal-detail", "moving to an Outlook event drops the gradient");
  await openEvent(at(2027, 4, 8), "Made here");
  await openEvent(at(2027, 4, 8), "Impromptu");
  assert.equal(side.className, "cal-detail", "a Tenir-only entry keeps the org tint");
  const fs = require("node:fs");
  const css = fs.readFileSync(require("node:path").join(__dirname, "..", "public", "brief.html"), "utf8");
  const grad = (sel) => (new RegExp(`${sel}\\s*\\{[^}]*?(linear-gradient\\([^;]*\\))`).exec(css) || [])[1];
  assert.ok(grad("\\.cal-ev\\.turma"), "the block has a gradient");
  assert.equal(grad("\\.cal-detail\\.turma"), grad("\\.cal-ev\\.turma"), "the panel's gradient is the block's");
  const rule = /\.cal-detail\.turma\s*\{([^}]*)\}/.exec(css)[1];
  assert.match(rule, /(^|[\s;])color:\s*#fff/, "the panel's text is white on the gradient");
  for (const tok of ["--muted", "--ink-2", "--accent-text"]) {
    assert.match(rule, new RegExp(`${tok}:\\s*#fff;`), `${tok} is solid white (translucent fell under 3:1)`);
  }
  assert.match(css, /\.cal-detail\.turma :focus-visible\s*\{\s*outline-color:\s*#fff/, "the focus ring shows on the gradient");
  assert.match(rule, /--focus-ring:\s*#fff/, "a field's focus halo shows on the gradient too");
  assert.match(css, /\.cal-detail select:focus[^{]*\{\s*box-shadow:\s*0 0 0 2px var\(--accent\)/,
    "a panel field's focus is a solid accent ring on the org tint, not the faint 30% halo");
  assert.match(css, /\.cal-detail\.turma select:focus[^{]*\{\s*box-shadow:\s*0 0 0 1px rgba\(11, 11, 11, 0\.75\), 0 0 0 3px #fff/,
    "on the gradient a white field keeps a dark edge inside its white ring");
});

test("XERK-2954: zoom steps the hours the pane shows, holds the middle, and stops at each end", async () => {
  NOW = at(2026, 11, 12, 10, 30);
  replies = { "/api/calendar": () => ({ hosts: [], events: [] }) };
  const [grid] = root.children;
  // A 600px pane: rows are max(10px, 600 / (hours * 2)), so the day is 48 rows of that.
  const scroller = { scrollTop: 0, clientHeight: 600,
    get scrollHeight() { return 48 * Math.max(10, 600 / (cal._state().zoomHours * 2)); } };
  const qs = grid.querySelector;
  grid.querySelector = (sel) => (sel === "#calScroll" ? scroller : null);
  try {
    cal._go(at(2026, 11, 12));
    cal.setActive(true);
    for (let i = 0; i < 4; i++) await tick();
    assert.equal(cal._state().zoomHours, 10, "opens showing 10 hours");
    assert.match(cal.calendarHtml(), /--hours:10;/);
    const ppm = () => scroller.scrollHeight / 1440;
    const mid = () => (scroller.scrollTop + 300) / ppm();
    scroller.scrollTop = 500;
    const before = mid();
    click({ zoom: "1" });
    assert.equal(cal._state().zoomHours, 8);
    assert.match(cal.calendarHtml(), /--hours:8;/);
    assert.ok(Math.abs(mid() - before) < 1e-6, "the middle minute stays put");
    for (let i = 0; i < 9; i++) click({ zoom: "1" });
    assert.equal(cal._state().zoomHours, cal.ZOOMS[cal.ZOOMS.length - 1], "zoom in stops at the last step");
    assert.match(cal.calendarHtml(), /data-zoom="1" aria-label="Zoom in" title="Zoom in" aria-disabled="true"/);
    for (let i = 0; i < 9; i++) click({ zoom: "-1" });
    assert.equal(cal._state().zoomHours, 24, "zoom out stops at the whole day");
    assert.match(cal.calendarHtml(), /data-zoom="-1" aria-label="Zoom out" title="Zoom out" aria-disabled="true"/);
    assert.match(cal.calendarHtml(), /data-zoom="1" aria-label="Zoom in" title="Zoom in \(fewer hours\)">/);
  } finally {
    while (cal._state().zoomHours !== cal.ZOOM_DEFAULT) cal._zoom(cal._state().zoomHours > cal.ZOOM_DEFAULT ? 1 : -1);
    grid.querySelector = qs;
    cal.setActive(false);
  }
});

test("XERK-2954: brief.html sizes the rows from --hours over the pane's height", () => {
  const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "public", "brief.html"), "utf8");
  assert.match(html, /\.cal-body \{ position: relative; --hours: 10; --slot: calc\(240px \/ var\(--hours\)\); \}/);
  assert.match(html, /--slot: max\(10px, 100cqh \/ \(var\(--hours\) \* 2\)\)/);
});

test("XERK-2954 QA: the grid opens with 8:00 at the top and keeps it while the pane changes height", async () => {
  NOW = at(2026, 11, 12, 10, 30);
  let hold;
  replies = { "/api/calendar": () => new Promise((r) => { hold = r; }) };
  const [grid] = root.children;
  // The loading notice takes 26px off the pane until the week lands (QA: 597 -> 623px).
  const pane = { h: 597 };
  const slotPx = () => Math.max(10, pane.h / (cal._state().zoomHours * 2));
  const scroller = { id: "calScroll", scrollTop: 0, get clientHeight() { return pane.h; },
    get scrollHeight() { return 48 * slotPx(); } };
  const qs = grid.querySelector;
  grid.querySelector = (sel) => (sel === "#calScroll" ? scroller : null);
  // In px off the line: the open leaves 8px above 8:00 so its label is not cut.
  const ppm = () => scroller.scrollHeight / 1440;
  const topOff = (min) => min * ppm() - scroller.scrollTop;
  const topAt = () => scroller.scrollTop / ppm();
  try {
    cal._reopen();
    cal.refetch();
    cal._go(at(2026, 11, 12));
    cal.setActive(true);
    for (let i = 0; i < 4; i++) await tick();
    assert.ok(Math.abs(topOff(480) - 8) < 0.5, `opens at 8:00 (8:00 is ${topOff(480)}px down)`);
    pane.h = 623;
    // The open's own scroll event lands after the pane grew (QA): it is not the operator's.
    for (const f of grid.listeners.scroll || []) f({ target: scroller });
    hold({ hosts: [], events: [{ host: "h1", id: "z1", org: "", subject: "Late", startMs: at(2026, 11, 12, 9), endMs: at(2026, 11, 12, 10) }] });
    for (let i = 0; i < 8; i++) await tick();
    assert.ok(Math.abs(topOff(480) - 8) < 0.5, `still 8:00 once the notice goes (${topOff(480)}px down)`);
    assert.ok(Math.abs(topOff(1080) - pane.h - 8) < 0.5, "and 6 PM at the bottom, 8px past it");
    // A window resize keeps the operator's place, not the pixel offset.
    scroller.scrollTop = 600 * (scroller.scrollHeight / 1440);
    for (const f of grid.listeners.scroll || []) f({ target: scroller });
    pane.h = 900;
    cal.setActive(true);  // a repaint
    assert.ok(Math.abs(topAt() - 600) < 1, `resize holds 10:00 at the top (top ${topAt()})`);
    // QA: scrolling away and back to the pixel the calendar last wrote still counts.
    const scrollTo = (min) => { scroller.scrollTop = min * ppm(); for (const f of grid.listeners.scroll || []) f({ target: scroller }); };
    pane.h = 700;
    cal.setActive(true);                     // writes 10:00 at the new height, arming one event
    const written = scroller.scrollTop;
    for (const f of grid.listeners.scroll || []) f({ target: scroller });   // that write's own event
    scrollTo(780);
    scroller.scrollTop = written;            // back to the written pixel
    for (const f of grid.listeners.scroll || []) f({ target: scroller });
    pane.h = 640;
    cal.setActive(true);
    assert.ok(Math.abs(topAt() - 600) < 1, `the operator's return to 10:00 is kept (top ${topAt()})`);
  } finally {
    grid.querySelector = qs;
    cal.setActive(false);
  }
});

test("XERK-2954 (XERK-2953): a write the browser clamped does not swallow the next scroll to that pixel", async () => {
  NOW = at(2026, 11, 12, 10, 30);
  replies = { "/api/calendar": () => ({ hosts: [], events: [] }) };
  const [grid] = root.children;
  // Like a browser, scrollTop is clamped to the scrollable range: a write past the
  // bottom lands at the bottom, and a pane already there does not move (no event).
  const pane = { h: 600 };
  const slotPx = () => Math.max(10, pane.h / (cal._state().zoomHours * 2));
  let raw = 0;
  const max = () => Math.max(0, 48 * slotPx() - pane.h);
  const scroller = { id: "calScroll", get clientHeight() { return pane.h; },
    get scrollHeight() { return 48 * slotPx(); },
    get scrollTop() { return Math.min(raw, max()); }, set scrollTop(v) { raw = Math.min(Math.max(0, v), max()); } };
  const qs = grid.querySelector;
  grid.querySelector = (sel) => (sel === "#calScroll" ? scroller : null);
  const ppm = () => scroller.scrollHeight / 1440;
  const topAt = () => scroller.scrollTop / ppm();
  const fire = () => { for (const f of grid.listeners.scroll || []) f({ target: scroller }); };
  try {
    cal._reopen();
    cal._go(at(2026, 11, 12));
    cal.setActive(true);
    for (let i = 0; i < 4; i++) await tick();
    fire();                                   // the open's own write
    scroller.scrollTop = 1e9; fire();         // the operator scrolls to the bottom: 14:00 at the top
    assert.ok(Math.abs(topAt() - 840) < 1e-6);
    // Zooming out holds the middle (19:00), asking for 13:00 at the top, past the
    // 12:00 the 12-hour day can show: the write clamps to where the pane already is.
    cal._zoom(-1);
    assert.equal(cal._state().zoomHours, 12);
    assert.ok(Math.abs(topAt() - 720) < 1e-6, `clamped at the bottom (top ${topAt()})`);
    fire();                                   // the operator's (or the clamp's) event at that same pixel
    pane.h = 150;                             // a much shorter pane can show 13:00
    cal.setActive(true);
    assert.ok(Math.abs(topAt() - 720) < 1e-6, `the resize keeps the 12:00 that was on screen (top ${topAt()})`);
  } finally {
    while (cal._state().zoomHours !== cal.ZOOM_DEFAULT) cal._zoom(cal._state().zoomHours > cal.ZOOM_DEFAULT ? 1 : -1);
    grid.querySelector = qs;
    cal.setActive(false);
  }
});

test("XERK-2954 QA: Ctrl+wheel zooms one step per notch, a stale leftover never fires, the pick is saved", () => {
  const saved = {};
  globalThis.localStorage = { getItem: (k) => saved[k] ?? null, setItem: (k, v) => { saved[k] = v; } };
  const inGrid = { closest: (sel) => (sel === ".cal-grid" ? {} : null) };
  const wheel = (deltaY, extra = {}) => { for (const f of root.listeners.wheel) f({ ctrlKey: true, deltaY, target: inGrid, preventDefault() {}, ...extra }); };
  const realNow = Date.now;
  let t = 1e6;
  Date.now = () => t;
  try {
    assert.equal(cal._state().zoomHours, 10);
    wheel(-100);
    assert.equal(cal._state().zoomHours, 8, "wheel up zooms in");
    assert.equal(saved["turma-calendar-zoom"], "8", "kept per viewer");
    wheel(12); wheel(12); wheel(12);
    assert.equal(cal._state().zoomHours, 8, "small deltas gather");
    t += 2000;
    wheel(12);
    assert.equal(cal._state().zoomHours, 8, "a pause drops the leftover");
    wheel(-30); wheel(30);
    assert.equal(cal._state().zoomHours, 8, "a turn of direction drops the leftover");
    wheel(3, { deltaMode: 1 });
    assert.equal(cal._state().zoomHours, 10, "one line-mode notch zooms out");
    wheel(-100, { ctrlKey: false });
    assert.equal(cal._state().zoomHours, 10, "a plain wheel only scrolls");
  } finally {
    Date.now = realNow;
    delete globalThis.localStorage;
    while (cal._state().zoomHours !== cal.ZOOM_DEFAULT) cal._zoom(cal._state().zoomHours > cal.ZOOM_DEFAULT ? 1 : -1);
  }
});

// ---- XERK-2971: Turma-made events — create, edit, delete, multi-org ----------------
function withOrgs(fn) {
  const board = globalThis.TurmaBoard;
  globalThis.TurmaBoard = { ...board,
    mergeSites: () => [{ siteKey: "acme" }, { siteKey: "globex" }],
    orgColorMap: () => new Map([["acme", "var(--s3)"], ["globex", "var(--s5)"]]) };
  cal.update({ agents: [] });
  return Promise.resolve().then(fn).finally(() => { globalThis.TurmaBoard = board; cal.update(null); });
}
const tev = (over = {}) => ({ source: "turma", host: "", id: "turma:0123456789abcdef", orgs: ["acme", "globex"], org: "acme",
  subject: "Joint planning", start: "2027-05-04T10:00:00-04:00", end: "2027-05-04T11:30:00-04:00",
  startMs: at(2027, 5, 4, 10), endMs: at(2027, 5, 4, 11, 30), timeZone: "America/New_York", allDay: false,
  location: "Room 4", body: "", attendees: [{ name: "Ann", email: "ann@acme.com", role: "required" }, { name: "", email: "bob@globex.com", role: "optional" }],
  joinUrl: "", isOnlineMeeting: false, busy: "busy", categories: [], sensitivity: "normal", version: 2, editable: true, ...over });
const editorFill = (f) => Object.assign(cal._ed().f, f);

test("XERK-2971: form validation mirrors the hub — orgs, emails, times, https link, lengths", () => {
  const f = cal.blankForm(at(2027, 5, 4, 9), at(2027, 5, 4, 9, 30));
  assert.equal(f.timeZone, "America/New_York");
  assert.deepEqual([f.startDate, f.startTime, f.endDate, f.endTime], ["2027-05-04", "09:00", "2027-05-04", "09:30"]);
  assert.deepEqual(Object.keys(cal.validateForm(f)), ["orgs"], "an event must belong to an org");
  f.orgs = ["acme"];
  assert.deepEqual(cal.validateForm(f), {});
  assert.deepEqual(Object.keys(cal.validateForm({ ...f, orgs: ["other"] }, ["acme"])), ["orgs"], "only pickable orgs");
  // XERK-3016: invitations go out from one org's Outlook, so a sending event has one org.
  assert.match(cal.validateForm({ ...f, invites: true, orgs: ["acme", "beta"] }).orgs, /sends invitations belongs to one org/);
  assert.deepEqual(cal.validateForm({ ...f, invites: true }), {});
  assert.deepEqual(cal.validateForm({ ...f, orgs: ["acme", "beta"] }), {});
  // One occurrence of an older two-org sending series: both boxes are disabled and the hub takes it.
  assert.deepEqual(cal.validateForm({ ...f, invites: true, orgs: ["acme", "beta"], repScope: "occurrence" }), {});
  for (const repScope of ["series", "following"]) {
    assert.match(cal.validateForm({ ...f, invites: true, orgs: ["acme", "beta"], repScope }).orgs, /one org/, repScope);
  }
  assert.match(cal.validateForm({ ...f, endTime: "08:00" }).end, /before the start/);
  assert.match(cal.validateForm({ ...f, startDate: "2027-02-30" }).start, /start/);
  assert.match(cal.validateForm({ ...f, reqDraft: "not-an-email" }).reqDraft, /Not an email/);
  assert.match(cal.validateForm({ ...f, optDraft: "a b@x.org" }).optDraft, /Not an email/);
  assert.match(cal.validateForm({ ...f, online: true, joinUrl: "http://x.org" }).joinUrl, /https/);
  assert.equal(cal.validateForm({ ...f, online: false, joinUrl: "http://x.org" }).joinUrl, undefined, "a link only counts online");
  assert.match(cal.validateForm({ ...f, subject: "x".repeat(301) }).subject, /300/);
  assert.match(cal.validateForm({ ...f, category: "Red, a;b" }).category, /';'/, "XERK-3013: Outlook splits on ';'");
  assert.equal(cal.validateForm({ ...f, category: "Red, Blue" }).category, undefined, "',' separates names");
  assert.match(cal.validateForm({ ...f, body: "😀".repeat(4001) }).body, /4000/, "code points, like the hub");
  assert.equal(cal.validateForm({ ...f, body: "😀".repeat(4000) }).body, undefined);
  assert.match(cal.validateForm({ ...f, timeZone: "Mars/Olympus" }).timeZone, /time zone/);
  // XERK-2953: local mean time (an offset with seconds) cannot round-trip an ISO
  // offset, so a time it governs is refused rather than saved a fraction of a minute off.
  const lmt = { ...f, timeZone: "Europe/Brussels", startDate: "1890-06-02", endDate: "1890-06-02", startTime: "10:00", endTime: "11:00" };
  assert.match(cal.validateForm(lmt).start, /before this time zone kept standard time/);
  assert.match(cal.validateForm({ ...lmt, allDay: true }).start, /standard time/, "all-day too");
  assert.match(cal.validateForm({ ...f, timeZone: "Africa/Monrovia", startDate: "1960-03-01", endDate: "1960-03-01" }).start,
    /standard time/, "not only before 1900: Monrovia kept -00:44:30 until 1972");
  assert.deepEqual(cal.validateForm({ ...f, timeZone: "Africa/Monrovia", startDate: "1980-03-01", endDate: "1980-03-01" }), {});
  assert.deepEqual(cal.validateForm({ ...lmt, startDate: "1960-06-02", endDate: "1960-06-02" }), {});
  assert.match(cal.validateForm({ ...lmt, startDate: "1960-06-02" }).end, /standard time/, "the end is checked on its own");
  // The hub's email rule: one @, a dot after it, nothing that breaks markup.
  assert.deepEqual(cal.parseAttendee("Ann Lee <Ann@Acme.COM>"), { name: "Ann Lee", email: "ann@acme.com" });
  assert.deepEqual(cal.parseAttendee(" o'brien@x.org "), { name: "", email: "o'brien@x.org" });
  for (const bad of ["a@b", "a@@b.c", "a\"b@c.d", "a<b@c.d", "a​b@c.d", "a/b@c.d", `${"a".repeat(200)}@b.c`]) {
    assert.equal(cal.parseAttendee(bad), null, bad);
  }
});

test("XERK-2988: a reminder round-trips the form, defaults to none, and shows on the panel", () => {
  const f = { ...cal.blankForm(at(2027, 5, 4, 9), at(2027, 5, 4, 10)), orgs: ["acme"] };
  assert.equal(f.reminder, "", "a new event has no reminder until one is picked");
  assert.equal(cal.formPayload(f).reminderMinutes, null);
  assert.equal(cal.formPayload({ ...f, reminder: "15" }).reminderMinutes, 15);
  assert.equal(cal.formPayload({ ...f, reminder: "" }).reminderMinutes, null, "None sends null");
  assert.equal(cal.formPayload({ ...f, reminder: "7" }).reminderMinutes, null, "off the list sends none");
  assert.equal(cal.formPayload({ ...f, reminder: "1440" }).reminderMinutes, 1440);
  const ev = { source: "turma", id: "turma:aaaaaaaaaaaaaaaa", orgs: ["acme"], org: "acme", startMs: at(2027, 5, 4, 9),
    endMs: at(2027, 5, 4, 10), timeZone: "America/New_York", subject: "Plan" };
  assert.equal(cal.formFromEvent({ ...ev, reminderMinutes: 60 }).reminder, "60");
  assert.equal(cal.formFromEvent({ ...ev, reminderMinutes: null }).reminder, "", "an event with none stays none");
  assert.equal(cal.formFromEvent({ ...ev, reminderMinutes: 9 }).reminder, "");
  assert.equal(cal.formFromEvent(ev).reminder, "", "an older hub's event has none");
  assert.match(cal.detailHtml({ ...ev, reminderMinutes: 10080 }, 0), /Reminder<\/span><span class="v">1 week before/);
  assert.doesNotMatch(cal.detailHtml({ ...ev, reminderMinutes: null }, 0), /Reminder/);
  assert.doesNotMatch(cal.detailHtml({ host: "h", id: "x", startMs: 1, endMs: 2, reminderMinutes: 15 }, 0), /Reminder/,
    "an Outlook event shows no Turma reminder");
});

test("XERK-2971: the payload is the route's shape — ISO with offset, all-day exclusive end, roles, privacy", () => {
  const f = { ...cal.blankForm(at(2027, 5, 4, 9), at(2027, 5, 4, 10)), orgs: ["acme", "globex"], subject: "  Plan  ",
    required: [{ name: "Ann", email: "ann@acme.com" }], optional: [{ name: "", email: "bob@globex.com" }],
    online: false, joinUrl: "https://meet.example/x", category: "Ops, ops2, Ops", priv: true, location: " R4 " };
  const b = cal.formPayload(f);
  assert.deepEqual(Object.keys(b), ["orgs", "subject", "start", "end", "timeZone", "allDay", "location", "body", "attendees",
    "joinUrl", "isOnlineMeeting", "busy", "categories", "sensitivity", "reminderMinutes", "sendInvites", "responseRequested", "allowForward", "recurrence"]);
  assert.deepEqual([b.subject, b.start, b.end, b.timeZone, b.location], ["Plan", "2027-05-04T09:00:00-04:00", "2027-05-04T10:00:00-04:00", "America/New_York", "R4"]);
  assert.deepEqual(b.attendees, [{ name: "Ann", email: "ann@acme.com", role: "required" }, { name: "", email: "bob@globex.com", role: "optional" }]);
  assert.equal(b.joinUrl, "", "no link without the online toggle");
  assert.deepEqual(b.categories, ["Ops", "ops2"]);
  assert.equal(b.sensitivity, "private");
  assert.equal(cal.formPayload({ ...f, priv: false }).sensitivity, "normal");
  assert.equal(cal.formPayload({ ...f, priv: true, sensitivity: "confidential" }).sensitivity, "confidential", "a stricter label is kept");
  assert.equal(cal.formPayload(f, 7).version, 7, "an edit carries its version");
  const all = cal.formPayload({ ...f, allDay: true, endDate: "2027-05-05" });
  assert.deepEqual([all.start, all.end, all.allDay], ["2027-05-04T00:00:00-04:00", "2027-05-06T00:00:00-04:00", true]);
  // Another zone keeps the creator's wall clock.
  assert.equal(cal.formPayload({ ...f, timeZone: "Asia/Kolkata" }).start, "2027-05-04T09:00:00+05:30");
  // DST: a fall-back time is its first pass; a skipped spring time lands on a real instant.
  assert.equal(cal.wallToIso("2026-11-01", "01:30", "America/New_York").iso, "2026-11-01T01:30:00-04:00");
  const gap = cal.wallToIso("2027-03-14", "02:30", "America/New_York");
  assert.equal(Date.parse(gap.iso), gap.ms, "the ISO parses back to its instant");
  // An event the hub served reads back into the same form.
  const back = cal.formFromEvent(tev({ isOnlineMeeting: true, joinUrl: "https://m.example/1", sensitivity: "private", categories: ["A", "B"] }));
  assert.deepEqual([back.startDate, back.startTime, back.endTime, back.timeZone, back.online, back.joinUrl, back.priv, back.category],
    ["2027-05-04", "10:00", "11:30", "America/New_York", true, "https://m.example/1", true, "A, B"]);
  assert.deepEqual(back.required, [{ name: "Ann", email: "ann@acme.com" }]);
  assert.deepEqual(back.optional, [{ name: "", email: "bob@globex.com" }]);
  assert.equal(cal.formFromEvent(tev({ allDay: true, startMs: at(2027, 5, 4), endMs: at(2027, 5, 6) })).endDate, "2027-05-05", "the last day, inclusive");
});

test("XERK-2989: invitations — the form round-trips them, the editor offers them, the panel tallies answers", () => {
  const f = { ...cal.blankForm(at(2027, 5, 4, 9), at(2027, 5, 4, 10)), orgs: ["acme", "globex"], subject: "Plan" };
  assert.deepEqual([f.invites, f.reqResp, f.allowFwd], [false, true, true], "off by default; Outlook's options");
  const b = cal.formPayload({ ...f, invites: true, allowFwd: false });
  assert.deepEqual([b.sendInvites, b.responseRequested, b.allowForward], [true, true, false]);
  const back = cal.formFromEvent(tev({ sendInvites: true, responseRequested: false }));
  assert.deepEqual([back.invites, back.reqResp, back.allowFwd], [true, false, true]);
  // An older hub serves none of the three: the form reads the defaults.
  const old = cal.formFromEvent(tev());
  assert.deepEqual([old.invites, old.reqResp, old.allowFwd], [false, true, true]);
  // The editor: one switch, its options only when on, disabled for one occurrence.
  assert.match(cal.invitesRowHtml(f, false), /data-ed-flag="invites"/);
  assert.doesNotMatch(cal.invitesRowHtml(f, false), /reqResp/);
  const on = cal.invitesRowHtml({ ...f, invites: true }, false);
  assert.match(on, /data-ed-flag="reqResp" checked/);
  assert.match(on, /data-ed-flag="allowFwd" checked/);
  assert.match(on, /Sent once, from the Outlook host of the event&#39;s org/);
  assert.match(cal.invitesRowHtml({ ...f, invites: true, priv: true }, false), /private event sends no invitations/);
  assert.match(cal.invitesRowHtml({ ...f, invites: true }, true), /data-ed-flag="invites" checked disabled/);
  // The panel: who sends, the options, a tally of the answers the hub read back.
  const ev = tev({ sendInvites: true, allowForward: false, attendees: [
    { name: "Ann", email: "ann@acme.com", role: "required", response: "accepted" },
    { name: "Bo", email: "bo@acme.com", role: "required", response: "declined" },
    { name: "", email: "cy@globex.com", role: "optional", response: "notResponded" }] });
  assert.equal(cal.invitesText(ev), "Sent from acme's Outlook · forwarding off · 1 accepted, 1 declined, 1 not responded");
  assert.equal(cal.invitesText(tev()), "", "no row when it sends none");
  assert.equal(cal.invitesText(tev({ sendInvites: true, private: true })), "");
  // XERK-3012: a series sends invitations too, and shows its sending copy's answers.
  assert.equal(cal.invitesText({ ...ev, recurring: true, seriesId: "turma:ab" }),
    "Sent from acme's Outlook · forwarding off · 1 accepted, 1 declined, 1 not responded");
  assert.equal(cal.invitesText(tev({ recurring: true })), "", "a series that sends none shows none");
  // Its owner is served the sensitivity, never `private`; the hub sends no invitations for it (QA).
  for (const sensitivity of ["private", "confidential"]) {
    assert.equal(cal.invitesText({ ...ev, recurring: true, sensitivity }), "", sensitivity);
  }
  assert.match(cal.detailHtml(ev), /Invitations/);
});

test("XERK-2971: a multi-org event renders once, with every org's color, and shows under an org filter", () => withOrgs(async () => {
  const asked = [];
  replies = { "/api/calendar": (url) => { asked.push(url); return { hosts: [], events: url.includes(`from=${cal.weekStart(at(2027, 5, 4))}`) ? [tev()] : [] }; } };
  cal.refetch();
  let html = await show(at(2027, 5, 4));
  assert.equal((html.match(/aria-label="Joint planning,/g) || []).length, 1, "once, not once per org");
  assert.match(html, /class="cal-ev turma multi"/);
  assert.match(html, /class="cal-orgbar"[^>]*linear-gradient\(to bottom,var\(--s3\) 0\.00% 50\.00%,var\(--s5\) 50\.00% 100\.00%\)/);
  assert.match(html, /aria-label="Joint planning,[^"]*orgs acme, globex[^"]*Turma event"/);
  // Under a filter on its SECOND org the hub serves it (any of its orgs) and it still shows once.
  orgKeys = ["globex"];
  try {
    cal.refetch();
    html = await show(at(2027, 5, 4));
    assert.ok(asked.some((u) => u.includes("&org=globex")));
    assert.equal((html.match(/aria-label="Joint planning,/g) || []).length, 1);
  } finally { orgKeys = []; }
  // A single-org Turma event keeps a plain org bar; an Outlook event is never "turma".
  assert.deepEqual(cal.styleOf(tev({ orgs: ["acme"] }), 0), ["turma"]);
  assert.deepEqual(cal.styleOf({ source: "outlook", org: "acme", orgs: ["acme", "globex"] }, 0), []);
  // The panel lists every org, escaped, each with its color.
  const h = cal.detailHtml(tev({ subject: "<img src=x>" }), NOW);
  assert.match(h, /Orgs<\/span><span class="v"><span class="cal-orgchip"><span class="cal-orgdot" style="--org:var\(--s3\)"[^>]*><\/span>acme<\/span><span class="cal-orgchip">[^]*globex/);
  assert.match(h, /Made in Turma — not on Outlook/);
  assert.ok(!h.includes("<img"));
}));

test("XERK-2971: Edit and Delete only on an editable Turma event; Outlook keeps its read-only panel", () => {
  const outlook = { host: "h1", id: "o1", source: "outlook", org: "acme", subject: "Sync", startMs: at(2027, 5, 4, 9), endMs: at(2027, 5, 4, 10), editable: true };
  assert.ok(!/data-ev-edit|data-ev-delete/.test(cal.detailHtml(outlook, NOW)), "an Outlook event never offers Edit/Delete");
  assert.ok(!/data-ev-edit|data-ev-delete/.test(cal.detailHtml({ ...tev(), editable: false }, NOW)));
  assert.match(cal.detailHtml({ ...tev(), editable: false }, NOW), /Only someone who can see every org/);
  const h = cal.detailHtml(tev(), NOW);
  assert.match(h, /data-ev-edit/);
  assert.match(h, /data-ev-delete/);
});

test("XERK-2971: create — New event opens the editor pre-filled with the filtered org; Save posts the payload", () => withOrgs(async () => {
  orgKeys = ["globex"];
  replies = { "/api/calendar/events": () => ({ ok: true, event: tev({ id: "turma:aaaaaaaaaaaaaaaa", orgs: ["globex"] }) }) };
  try {
    await show(at(2027, 5, 4));
    click({ calNew: "" });
    const e = cal._ed();
    assert.equal(e.mode, "new");
    assert.deepEqual(e.f.orgs, ["globex"], "the header's org pick pre-fills");
    assert.equal(cal._edEls().back.hidden, false);
    const html = cal._edEls().panel.innerHTML;
    assert.match(html, /data-ed-org="acme"/);
    assert.match(html, /data-ed-org="globex" checked/);
    assert.match(html, /Does not repeat/);
    editorFill({ subject: "Plan <b>", startDate: "2027-05-05", startTime: "13:00", endDate: "2027-05-05", endTime: "14:00", reqDraft: "Ann <ann@acme.com>" });
    posts.length = 0;
    await cal.saveEditor();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "/api/calendar/events");
    assert.deepEqual(posts[0].body.orgs, ["globex"]);
    assert.equal(posts[0].body.start, "2027-05-05T13:00:00-04:00");
    assert.deepEqual(posts[0].body.attendees, [{ name: "Ann", email: "ann@acme.com", role: "required" }], "a typed address is committed on Save");
    assert.equal(posts[0].body.version, undefined);
    assert.equal(cal._ed(), null, "closed on success");
    assert.equal(cal._edEls().back.hidden, true);
    // An invalid form never reaches the hub, and says why next to the field.
    cal.openEditor({ startMs: at(2027, 5, 5, 9), endMs: at(2027, 5, 5, 9, 30) });
    editorFill({ orgs: [], optDraft: "nope" });
    posts.length = 0;
    await cal.saveEditor();
    assert.equal(posts.length, 0);
    assert.match(cal._edEls().panel.innerHTML, /Pick at least one org\.[^]*Not an email address/);
    assert.match(cal._edEls().panel.innerHTML, /data-ed-field="optDraft"[^>]*aria-invalid="true"/);
    cal.closeEditor();
  } finally { orgKeys = []; }
}));

test("XERK-2971: an edit that lost a race gets the 409 in the hub's words and reloads the current event", () => withOrgs(async () => {
  // The specific route first: the fake fetch takes the first key the URL starts with.
  replies = {
    "/api/calendar/events/": () => ({ status: 409, body: { error: "this event was changed since you opened it; reload it and edit again",
      event: tev({ subject: "Theirs", version: 3 }) } }),
    "/api/calendar": (url) => ({ hosts: [], events: url.includes(`from=${cal.weekStart(at(2027, 5, 4))}`) ? [tev()] : [] }),
  };
  cal.refetch();
  await openEvent(at(2027, 5, 4), "Joint planning");
  click({ evEdit: "" });
  assert.equal(cal._ed().mode, "edit");
  assert.equal(cal._ed().version, 2);
  editorFill({ subject: "Mine" });
  posts.length = 0;
  await cal.saveEditor();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, `/api/calendar/events/${encodeURIComponent("turma:0123456789abcdef")}`);
  assert.equal(posts[0].body.version, 2, "the edit names the version it was made to");
  const e = cal._ed();
  assert.ok(e, "the editor stays open");
  assert.equal(e.err, "Saving the event failed — this event was changed since you opened it; reload it and edit again");
  assert.equal(e.f.subject, "Theirs", "reloaded from the hub's current copy");
  assert.equal(e.version, 3);
  assert.match(cal._edEls().panel.innerHTML, /role="alert">Saving the event failed — this event was changed/);
  cal.closeEditor();
  click({ closeDetail: "" });
}));

test("XERK-2971: delete asks first, sends DELETE, closes the panel; a refusal shows the hub's words", () => withOrgs(async () => {
  let refuse = true;
  replies = {
    "/api/calendar/events/": () => (refuse ? { status: 404, body: { error: "no such Turma event" } } : { ok: true }),
    "/api/calendar": (url) => ({ hosts: [], events: url.includes(`from=${cal.weekStart(at(2027, 5, 4))}`) ? [tev()] : [] }),
  };
  cal.refetch();
  await openEvent(at(2027, 5, 4), "Joint planning");
  posts.length = 0;
  click({ evDelete: "" });
  assert.equal(posts.length, 0, "the first press only asks");
  assert.match(cal._els().info.innerHTML, /Delete this event for every org\?[^]*data-ev-delete-yes/);
  click({ evDeleteNo: "" });
  assert.match(cal._els().info.innerHTML, /data-ev-edit/);
  click({ evDelete: "" });
  click({ evDeleteYes: "" });
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(posts[0].url, `/api/calendar/events/${encodeURIComponent("turma:0123456789abcdef")}`);
  assert.match(cal._els().info.innerHTML, /Deleting the event failed — no such Turma event/);
  refuse = false;
  replies["/api/calendar"] = () => ({ hosts: [], events: [] });
  click({ evDelete: "" });
  click({ evDeleteYes: "" });
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(cal._els().side.hidden, true, "the panel closes once the event is gone");
}));

test("XERK-2971: a click or drag on an empty slot opens the editor on that span; a touch swipe does not", () => withOrgs(async () => {
  replies = {};
  await show(at(2027, 5, 4));
  const grid = cal._els().grid;
  const day = cal.dayStart(at(2027, 5, 4));
  const col = { dataset: { col: String(day) }, getBoundingClientRect: () => ({ top: 0, height: 1440 }) };
  const target = { closest: (sel) => (sel === ".cal-col" ? col : null) };
  const press = (y, extra = {}) => { for (const f of grid.listeners.pointerdown) f({ button: 0, target, clientX: 10, clientY: y, ...extra }); };
  const lift = (y, extra = {}) => { for (const f of grid.listeners.pointerup) f({ target, clientX: 10, clientY: y, ...extra }); };
  press(600); lift(600);                                    // 10:00, one row
  assert.deepEqual([cal._ed().f.startTime, cal._ed().f.endTime], ["10:00", "10:30"]);
  cal.closeEditor();
  press(840); lift(605);                                    // dragged up 14:00 → 10:00
  assert.deepEqual([cal._ed().f.startTime, cal._ed().f.endTime], ["10:00", "14:30"]);
  cal.closeEditor();
  press(600, { pointerType: "touch" }); lift(600, { pointerType: "touch", clientX: 120 });
  assert.equal(cal._ed(), null, "a swipe is not a create");
  const onEvent = { closest: (sel) => (sel === ".cal-col" ? col : sel === ".cal-ev" ? {} : null) };
  for (const f of grid.listeners.pointerdown) f({ button: 0, target: onEvent, clientY: 600 });
  lift(600);
  assert.equal(cal._ed(), null, "a press on an event opens the event, not the editor");
  assert.equal(cal.slotMinAt(col, 1439), 1410);
}));

test("XERK-2971: the notes review and relink count a multi-org event for every org it is in", async () => {
  NOW = at(2026, 11, 11, 10, 30);
  const ev = tev({ id: "turma:1111111111111111", subject: "Cross-org sync", meeting: true,
    startMs: at(2026, 11, 12, 15), endMs: at(2026, 11, 12, 16) });
  replies = { "/api/calendar": () => ({ hosts: [], events: [ev] }) };
  cal.refetch();
  cal.upcoming("globex");
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(cal.upcoming("globex").map((e) => e.subject), ["Cross-org sync"]);
  assert.deepEqual(cal.upcoming("acme").map((e) => e.subject), ["Cross-org sync"]);
  assert.deepEqual(cal.upcoming("initech"), []);
});

test("XERK-2971 QA: a blur never repaints the editor or brings back a committed attendee; chips are escaped", () => withOrgs(async () => {
  cal.openEditor({ startMs: at(2027, 5, 5, 9), endMs: at(2027, 5, 5, 10) });
  const panel = cal._edEls().panel;
  const fire = (kind, target) => { for (const f of panel.listeners[kind] || []) f({ target, key: target.key, preventDefault() {} }); };
  const before = panel.innerHTML;
  // A text field's change (on blur) neither writes nor repaints: a repaint drops the click
  // the mouse is pressing on Save (QA).
  fire("input", { dataset: { edField: "subject" }, value: "Standup", tagName: "INPUT", type: "text" });
  fire("change", { dataset: { edField: "subject" }, value: "Standup", tagName: "INPUT", type: "text" });
  assert.equal(panel.innerHTML, before, "no repaint on a text field's blur");
  assert.equal(cal._ed().f.subject, "Standup");
  // A comma commits the chip; the removed input's late change carries the old text — ignored.
  const chipIn = { dataset: { edField: "optDraft", edChipin: "optional" }, tagName: "INPUT", type: "text" };
  fire("input", { ...chipIn, value: "Bob <b>x</b> <bob@x.io>," });
  fire("change", { ...chipIn, value: "Bob <b>x</b> <bob@x.io>," });
  assert.deepEqual(cal._ed().f.optional, [{ name: "Bob <b>x</b>", email: "bob@x.io" }]);
  assert.equal(cal._ed().f.optDraft, "", "the stale text is not written back");
  assert.match(panel.innerHTML, /Bob &lt;b&gt;x&lt;\/b&gt;<button/, "a chip's name is escaped");
  assert.ok(!panel.innerHTML.includes("<b>x</b>"));
  // A trailing separator is never part of the address; a pasted list splits.
  assert.deepEqual(cal.parseAttendee("bob@x.io,"), { name: "", email: "bob@x.io" });
  fire("input", { ...chipIn, value: "a@b.co, c@d.co" });
  fire("keydown", { ...chipIn, key: "Enter", value: "a@b.co, c@d.co" });
  assert.deepEqual(cal._ed().f.optional.map((a) => a.email), ["bob@x.io", "a@b.co", "c@d.co"]);
  // Moving the start keeps the length, without a repaint.
  fire("focusin", {});
  fire("change", { dataset: { edField: "startTime" }, value: "11:00", tagName: "INPUT", type: "time" });
  assert.deepEqual([cal._ed().f.endDate, cal._ed().f.endTime], ["2027-05-05", "12:00"]);
  cal.closeEditor();
}));

test("XERK-2971 QA: join link case and DST edges match the hub", () => {
  const f = { ...cal.blankForm(at(2027, 5, 4, 9), at(2027, 5, 4, 10)), orgs: ["acme"], online: true };
  assert.match(cal.validateForm({ ...f, joinUrl: "HTTPS://meet.example/x" }).joinUrl, /https/, "the hub's CAL_URL_RE is case-sensitive");
  assert.equal(cal.validateForm({ ...f, joinUrl: "https://meet.example/x" }).joinUrl, undefined);
  // A skipped hour lands on the instant the OLD offset names, east of UTC as well as west.
  assert.equal(cal.wallToIso("2027-03-28", "02:30", "Europe/Berlin").iso, "2027-03-28T03:30:00+02:00");
  assert.equal(cal.wallToIso("2027-10-03", "02:15", "Australia/Lord_Howe").iso, "2027-10-03T02:45:00+11:00");
  assert.equal(cal.wallToIso("2027-03-14", "02:30", "America/New_York").iso, "2027-03-14T03:30:00-04:00");
  // A repeated hour is its first pass, east and west.
  assert.equal(cal.wallToIso("2027-10-31", "02:30", "Europe/Berlin").iso, "2027-10-31T02:30:00+02:00");
  assert.equal(cal.wallToIso("2027-04-04", "01:45", "Australia/Lord_Howe").iso, "2027-04-04T01:45:00+11:00");
  assert.equal(cal.wallToIso("0050-06-01", "09:00", "UTC"), null, "no 19xx for a year under 100");
});

test("XERK-2971 QA: a half-typed start keeps the length; the shifted end is written into the inputs; a fixed field's error clears", () => withOrgs(async () => {
  cal.openEditor({ startMs: at(2027, 5, 5, 9), endMs: at(2027, 5, 5, 9, 30) });
  const panel = cal._edEls().panel;
  const inputs = { endDate: { value: "" }, endTime: { value: "" } };
  const errEnd = { id: "calEdErr-end", removed: false, remove() { this.removed = true; } };
  const endIn = { attrs: { "aria-invalid": "true" }, removeAttribute(k) { delete this.attrs[k]; } };
  const qs = panel.querySelector, qsa = panel.querySelectorAll;
  panel.querySelector = (sel) => { const m = /data-ed-field="(\w+)"/.exec(sel); return m ? inputs[m[1]] || null : null; };
  panel.querySelectorAll = (sel) => (sel.startsWith(".mt-err") ? (errEnd.removed ? [] : [errEnd]) : sel.includes("calEdErr-end") ? [endIn] : []);
  const fire = (kind, target) => { for (const f of panel.listeners[kind] || []) f({ target, preventDefault() {} }); };
  try {
    fire("focusin", {});
    fire("change", { dataset: { edField: "startTime" }, value: "", tagName: "INPUT", type: "time" });       // first digit
    fire("change", { dataset: { edField: "startTime" }, value: "14:15", tagName: "INPUT", type: "time" });
    assert.deepEqual([cal._ed().f.endTime, inputs.endTime.value, inputs.endDate.value], ["14:45", "14:45", "2027-05-05"],
      "30 minutes kept, and written into the end inputs");
    // A failed Save's error clears in place once the field is fixed.
    cal._ed().f.orgs = ["acme"];
    cal._ed().f.endTime = "13:00";
    await cal.saveEditor();
    assert.match(cal._ed().errors.end, /before the start/);
    fire("change", { dataset: { edField: "endTime" }, value: "15:00", tagName: "INPUT", type: "time" });
    assert.equal(cal._ed().errors.end, undefined);
    assert.equal(errEnd.removed, true, "the message goes");
    assert.equal(endIn.attrs["aria-invalid"], undefined, "and so does aria-invalid");
    // A text field fixed after a failed Save clears its message on blur too.
    cal._ed().f.online = true;
    cal._ed().f.joinUrl = "HTTPS://x.io/a";
    await cal.saveEditor();
    assert.match(cal._ed().errors.joinUrl, /https/);
    cal._ed().f.joinUrl = "https://x.io/a";
    fire("change", { dataset: { edField: "joinUrl" }, value: "https://x.io/a", tagName: "INPUT", type: "url" });
    assert.equal(cal._ed().errors.joinUrl, undefined);
  } finally { panel.querySelector = qs; panel.querySelectorAll = qsa; cal.closeEditor(); }
}));

// ---- XERK-2973: repeat options and this-occurrence / whole-series editing ----------
const REPEAT = require("./fixtures/calendar-repeat-vectors.json");

test("XERK-2973: every rule reads into the Repeat control and back unchanged, with the shared summary", () => {
  for (const v of REPEAT.roundTrip) {
    const r = cal.repeatFromRule(v.rule);
    assert.equal(r.kind, v.kind, `${v.name}: kind`);
    assert.deepEqual(cal.ruleFromRepeat(r, v.ymd), v.rule, `${v.name}: rule round trip`);
    assert.equal(cal.repeatSummary(v.rule, v.ymd), v.summary, `${v.name}: summary`);
    assert.equal(cal.repeatError(r, v.ymd), "", `${v.name}: a stored rule is saveable`);
  }
});

test("XERK-2973: each Repeat preset sends the rule it names", () => {
  for (const v of REPEAT.fromControl) {
    let r = cal.repeatPick(cal.blankRepeat(), v.pick);
    if (v.then) r = cal.repeatPick(r, v.then);
    assert.deepEqual(cal.ruleFromRepeat(r, v.ymd), v.rule, v.name);
  }
  // The menu names the presets for the start day, Teams-style.
  const labels = cal.repeatPresets("2026-11-17").map(([, l]) => l);
  assert.deepEqual(labels, ["Does not repeat", "Every weekday (Mon–Fri)", "Daily", "Weekly on Tuesday", "Monthly on day 17",
    "Monthly on the third Tuesday", "Yearly on 17 November", "Custom…"]);
});

test("XERK-2973: a Repeat the hub would refuse is said before Save", () => {
  for (const v of REPEAT.errors) {
    const r = { ...cal.repeatFromRule(v.rule), ...v.set };
    assert.equal(cal.repeatError(r, v.ymd), v.error, v.name);
  }
  const f = { ...cal.blankForm(at(2026, 11, 17, 9), at(2026, 11, 17, 10)), orgs: ["acme"],
    repeat: { ...cal.repeatFromRule({ freq: "daily", interval: 3 }), interval: "0" } };
  assert.equal(cal.validateForm(f).repeat, "Repeat every 1 to 99.");
});

test("XERK-2973: a new event's Repeat rides the payload; an occurrence's own edit sends none", () => {
  const f = { ...cal.blankForm(at(2026, 11, 17, 9), at(2026, 11, 17, 10)), orgs: ["acme"] };
  assert.equal(cal.formPayload(f).recurrence, null, "does not repeat = a single event");
  f.repeat = cal.repeatPick(cal.blankRepeat(), "monthlyNth");
  assert.deepEqual(cal.formPayload(f).recurrence, { freq: "monthly", interval: 1, byWeekday: { n: 3, day: "TU" } });
  const one = cal.formPayload(f, 4, "occurrence");
  assert.equal("recurrence" in one, false, "the hub refuses a rule on one occurrence");
  assert.deepEqual([one.version, one.scope], [4, "occurrence"]);
  assert.equal(cal.formPayload(f, 4, "following").scope, "following");
  assert.deepEqual(cal.formPayload(f, 4, "following").recurrence, { freq: "monthly", interval: 1, byWeekday: { n: 3, day: "TU" } });
});

const occ = (over = {}) => tev({ id: "turma:0123456789abcdef:2027-05-04T14:00:00Z", seriesId: "turma:0123456789abcdef",
  recurring: true, originalStart: "2027-05-04T14:00:00Z", recurrence: { freq: "weekly", interval: 2, byDay: ["TU", "TH"], until: "2027-06-30" }, ...over });

test("XERK-2973: a recurring event wears the glyph on its block and says its rule in the panel", () => withOrgs(async () => {
  replies = { "/api/calendar": (url) => ({ hosts: [], events: url.includes(`from=${cal.weekStart(at(2027, 5, 4))}`) ? [occ()] : [] }) };
  cal.refetch();
  const html = await show(at(2027, 5, 4));
  assert.match(html, /class="cal-recur"/);
  assert.match(html, /aria-label="Joint planning[^"]*repeats/);
  const info = await openEvent(at(2027, 5, 4), "Joint planning");
  assert.match(info, /Repeats<\/span><span class="v"><svg class="cal-recur"[^]*Every 2 weeks on Tue, Thu until 30 Jun/);
  // An Outlook occurrence keeps the plain line (its rule is Outlook's).
  assert.match(cal.detailHtml({ ...occ(), source: "outlook", recurrence: undefined }, at(2027, 5, 1)), /Part of a recurring series/);
  click({ closeDetail: "" });
}));

test("XERK-2973: Edit on an occurrence asks which events, and each answer sends its scope", () => withOrgs(async () => {
  replies = {
    "/api/calendar/events/": () => ({ ok: true, event: occ() }),
    "/api/calendar": (url) => ({ hosts: [], events: url.includes(`from=${cal.weekStart(at(2027, 5, 4))}`) ? [occ()] : [] }),
  };
  cal.refetch();
  for (const [scope, title] of [["occurrence", "Edit this event"], ["following", "Edit this and following events"], ["series", "Edit all events"]]) {
    await openEvent(at(2027, 5, 4), "Joint planning");
    click({ evEdit: "" });
    assert.equal(cal._ed(), null, "the press only asks");
    assert.match(cal._els().info.innerHTML, /Edit which events\?[^]*data-ev-scope="occurrence">This event[^]*data-ev-scope="following">This and following[^]*data-ev-scope="series">All events/);
    click({ evScope: scope });
    const e = cal._ed();
    assert.equal(e.scope, scope);
    const panel = cal._edEls().panel.innerHTML;
    assert.match(panel, new RegExp(`id="calEdTitle">${title}<`));
    if (scope === "occurrence") {
      assert.match(panel, /data-ed-org="acme" checked disabled/, "orgs are the series'");
      assert.match(panel, /A series' orgs apply to every event in it/);
      assert.match(panel, /data-ed-field="timeZone" aria-label="Time zone" disabled/);
      assert.doesNotMatch(panel, /data-ed-rep="preset"/, "one occurrence has no rule of its own");
    } else {
      assert.doesNotMatch(panel, /disabled/);
      assert.match(panel, /data-ed-rep="preset"[^]*value="custom" selected/);
      assert.match(panel, /data-ed-rep-summary[^>]*>[^]*Every 2 weeks on Tue, Thu until 30 Jun/);
    }
    // Nothing changed: nothing is sent (a resent form is not neutral, see scopedBody).
    posts.length = 0;
    await cal.saveEditor();
    assert.equal(posts.length, 0);
    assert.equal(cal._ed(), null);
    click({ evEdit: "" });
    click({ evScope: scope });
    editorFill({ subject: "Renamed" });
    await cal.saveEditor();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `/api/calendar/events/${encodeURIComponent("turma:0123456789abcdef:2027-05-04T14:00:00Z")}`);
    assert.deepEqual(posts[0].body, { subject: "Renamed", version: 2, scope }, "only the change, the series' version and the scope");
    click({ closeDetail: "" });
  }
  // Cancel backs out; a single event never asks.
  await openEvent(at(2027, 5, 4), "Joint planning");
  click({ evEdit: "" });
  click({ evScopeNo: "" });
  assert.match(cal._els().info.innerHTML, /data-ev-edit/);
  click({ closeDetail: "" });
}));

test("XERK-2973: Delete on an occurrence asks which events and sends ?scope=", () => withOrgs(async () => {
  for (const scope of ["occurrence", "following", "series"]) {
    replies = {
      "/api/calendar/events/": () => ({ ok: true }),
      "/api/calendar": (url) => ({ hosts: [], events: url.includes(`from=${cal.weekStart(at(2027, 5, 4))}`) ? [occ()] : [] }),
    };
    cal.refetch();
    await openEvent(at(2027, 5, 4), "Joint planning");
    posts.length = 0;
    click({ evDelete: "" });
    assert.equal(posts.length, 0, "the first press only asks");
    assert.match(cal._els().info.innerHTML, /Delete which events\?[^]*class="btn-sm cal-danger" data-ev-scope="occurrence"/);
    click({ evScope: scope });
    for (let i = 0; i < 6; i++) await tick();
    assert.equal(posts[0].url, `/api/calendar/events/${encodeURIComponent("turma:0123456789abcdef:2027-05-04T14:00:00Z")}?scope=${scope}`);
    assert.equal(cal._els().side.hidden, true);
  }
}));

test("XERK-2973: the editor's Repeat control drives the rule — preset, days, custom, end", () => withOrgs(async () => {
  replies = {};
  await show(at(2026, 11, 17));
  cal.openEditor({ startMs: at(2026, 11, 17, 9), endMs: at(2026, 11, 17, 10) });
  const panel = () => cal._edEls().panel.innerHTML;
  assert.match(panel(), /data-ed-rep="preset"[^]*Weekly on Tuesday/);
  const chg = (dataset, value, checked) => { for (const f of cal._edEls().panel.listeners.change) f({ target: { dataset, value, checked } }); };
  const inp = (dataset, value) => { for (const f of cal._edEls().panel.listeners.input) f({ target: { dataset, value } }); };
  chg({ edRep: "preset" }, "weekly");
  assert.match(panel(), /data-ed-repday="TU" aria-label="Tuesday" checked/, "the start's day is ticked");
  chg({ edRepday: "TH" }, "on", true);
  assert.deepEqual(cal.ruleFromRepeat(cal._ed().f.repeat, cal._ed().f.startDate), { freq: "weekly", interval: 1, byDay: ["TU", "TH"] });
  chg({ edRep: "preset" }, "custom");
  inp({ edRep: "interval" }, "2");
  chg({ edRep: "end" }, "until");
  inp({ edRep: "until" }, "2026-12-31");
  assert.deepEqual(cal.ruleFromRepeat(cal._ed().f.repeat, cal._ed().f.startDate),
    { freq: "weekly", interval: 2, byDay: ["TU", "TH"], until: "2026-12-31" });
  chg({ edRep: "unit" }, "month");
  chg({ edRep: "monthMode" }, "weekday");
  assert.match(panel(), /On the third Tuesday/);
  chg({ edRep: "end" }, "count");
  inp({ edRep: "count" }, "6");
  assert.deepEqual(cal.ruleFromRepeat(cal._ed().f.repeat, cal._ed().f.startDate),
    { freq: "monthly", interval: 2, byWeekday: { n: 3, day: "TU" }, count: 6 });
  // A typed field is said in place (no repaint mid-typing); the next repaint carries it.
  chg({ edRep: "monthMode" }, "weekday");
  assert.match(panel(), /data-ed-rep-summary[^>]*><svg[^]*<\/svg>Every 2 months on the third Tuesday, 6 times</);
  cal.closeEditor();
}));

test("XERK-2973 QA: a scoped edit sends only what changed — start/end together, the rule only when touched", () => {
  const base = { subject: "A", start: "s0", end: "e0", recurrence: { freq: "weekly", interval: 1, count: 10 }, version: 2, scope: "following" };
  assert.equal(cal.scopedBody(base, { ...base }), null);
  assert.deepEqual(cal.scopedBody(base, { ...base, end: "e1" }), { start: "s0", end: "e1", version: 2, scope: "following" });
  assert.deepEqual(cal.scopedBody(base, { ...base, recurrence: { freq: "weekly", interval: 2, count: 10 } }),
    { recurrence: { freq: "weekly", interval: 2, count: 10 }, version: 2, scope: "following" });
});

test("XERK-2973 QA: an occurrence's rule reads off its series' first day, not a clamped one", () => withOrgs(async () => {
  // Feb 28 2027 is an occurrence of "monthly on the 31st" (first day Jan 31): day 31, never day 28.
  const feb = occ({ id: "turma:0123456789abcdef:2027-02-28T15:00:00Z", originalStart: "2027-02-28T15:00:00Z",
    seriesStart: "2027-01-31T10:00:00-05:00", start: "2027-02-28T10:00:00-05:00", end: "2027-02-28T11:00:00-05:00",
    startMs: Date.parse("2027-02-28T15:00:00Z"), endMs: Date.parse("2027-02-28T16:00:00Z"), recurrence: { freq: "monthly", interval: 1 } });
  assert.match(cal.detailHtml(feb, at(2027, 2, 1)), /Every month on day 31/);
  // "All events" from it keeps the implicit 31st and may end before Feb 28 (it starts Jan 31).
  cal.openEditor({ event: feb, scope: "series" });
  const f = cal._ed().f;
  assert.equal(f.seriesDate, "2027-01-31");
  f.repeat = { ...f.repeat, end: "until", until: "2027-02-15" };
  assert.equal(cal.validateForm(f).repeat, undefined);
  assert.deepEqual(cal.formPayload(f, 2, "series").recurrence, { freq: "monthly", interval: 1, until: "2027-02-15" });
  cal.closeEditor();
}));

test("XERK-2973 QA: a stored weekly rule's preset names its own days", () => {
  const r = cal.repeatFromRule({ freq: "weekly", interval: 1, byDay: ["MO", "WE", "FR"] });
  assert.equal(new Map(cal.repeatPresets("2026-11-17", r)).get("weekly"), "Weekly on Mon, Wed, Fri");
});

test("XERK-2973 QA: every scoped editor reads the series' rule off its first day; a split's until starts at the split", () => withOrgs(async () => {
  const apr = occ({ id: "turma:0123456789abcdef:2027-04-30T14:00:00Z", originalStart: "2027-04-30T14:00:00Z",
    seriesStart: "2027-01-31T10:00:00-05:00", start: "2027-04-30T10:00:00-04:00", end: "2027-04-30T11:00:00-04:00",
    startMs: Date.parse("2027-04-30T14:00:00Z"), endMs: Date.parse("2027-04-30T15:00:00Z"), recurrence: { freq: "monthly", interval: 1 } });
  for (const scope of ["occurrence", "following", "series"]) {
    cal.openEditor({ event: apr, scope });
    assert.match(cal._edEls().panel.innerHTML, /Every month on day 31/, scope);
    cal.closeEditor();
  }
  cal.openEditor({ event: apr, scope: "following" });
  const f = cal._ed().f;
  f.repeat = { ...f.repeat, end: "until", until: "2027-03-31" };
  assert.equal(cal.validateForm(f).repeat, "It must repeat until a day on or after its start.", "the new series starts Apr 30");
  f.repeat = { ...f.repeat, end: "count", count: 4 };
  // Sent implicit: the hub pins the 31st at the split (server.test.js XERK-2973).
  assert.deepEqual(cal.formPayload(f, 2, "following").recurrence, { freq: "monthly", interval: 1, count: 4 });
  cal.closeEditor();
}));

test("XERK-2973 QA: a scoped edit that MOVES the date re-anchors the repeat as the hub does", () => withOrgs(async () => {
  // Weekly-on-Tuesday series (first day Tue 2027-01-05); open its Tue 2027-01-26 occurrence.
  const tue = occ({ id: "turma:0123456789abcdef:2027-01-26T15:00:00Z", originalStart: "2027-01-26T15:00:00Z",
    seriesStart: "2027-01-05T10:00:00-05:00", start: "2027-01-26T10:00:00-05:00", end: "2027-01-26T11:00:00-05:00",
    startMs: Date.parse("2027-01-26T15:00:00Z"), endMs: Date.parse("2027-01-26T16:00:00Z"), recurrence: { freq: "weekly", interval: 1, count: 8 } });
  const label = () => /data-ed-rep-summary[^>]*><svg[^]*?<\/svg>([^<]*)</.exec(cal._edEls().panel.innerHTML)[1];
  const change = (field, value) => { for (const f of cal._edEls().panel.listeners.change) f({ target: { dataset: { edField: field }, value } }); };
  const repaint = () => { for (const f of cal._edEls().panel.listeners.change) f({ target: { dataset: { edRep: "end" }, value: "count" } }); };
  // "This and following" moved to Wed: the new series runs on Wednesdays.
  cal.openEditor({ event: tue, scope: "following" });
  assert.match(label(), /Every week on Tue/);
  change("startDate", "2027-01-27");
  repaint();
  assert.match(label(), /Every week on Wed/);
  assert.match(cal._edEls().panel.innerHTML, /Weekly on Wednesday/);
  cal.closeEditor();
  // "All events" moved a day later shifts the whole series: Tuesdays become Wednesdays too.
  cal.openEditor({ event: tue, scope: "series" });
  change("startDate", "2027-01-27");
  repaint();
  assert.match(label(), /Every week on Wed/);
  cal.closeEditor();
  // "This event" moved keeps showing the series' own rule.
  cal.openEditor({ event: tue, scope: "occurrence" });
  change("startDate", "2027-01-27");
  assert.match(cal._edEls().panel.innerHTML, /Every week on Tue/);
  cal.closeEditor();
}));

test("XERK-2973 QA: a 409 reload keeps the series' day the editor reads", () => withOrgs(async () => {
  const feb = occ({ id: "turma:0123456789abcdef:2027-02-28T15:00:00Z", originalStart: "2027-02-28T15:00:00Z",
    seriesStart: "2027-01-31T10:00:00-05:00", start: "2027-02-28T10:00:00-05:00", end: "2027-02-28T11:00:00-05:00",
    startMs: Date.parse("2027-02-28T15:00:00Z"), endMs: Date.parse("2027-02-28T16:00:00Z"), recurrence: { freq: "monthly", interval: 1 } });
  replies = { "/api/calendar/events/": () => ({ status: 409, body: { error: "changed", event: { ...feb, subject: "Theirs", version: 3 } } }) };
  cal.openEditor({ event: feb, scope: "series" });
  editorFill({ subject: "Mine" });
  await cal.saveEditor();
  assert.equal(cal._ed().f.seriesDate, "2027-01-31");
  assert.match(cal._edEls().panel.innerHTML, /Every month on day 31/);
  cal.closeEditor();
}));

test("XERK-2973 QA: keyboard focus follows the scope prompt and its Cancel", () => withOrgs(async () => {
  replies = { "/api/calendar": (url) => ({ hosts: [], events: url.includes(`from=${cal.weekStart(at(2027, 5, 4))}`) ? [occ()] : [] }) };
  cal.refetch();
  await openEvent(at(2027, 5, 4), "Joint planning");
  const info = cal._els().info, focused = [];
  info.querySelector = (sel) => ({ focus: () => focused.push(sel) });
  try {
    click({ evEdit: "" });
    click({ evScopeNo: "" });
    click({ evDelete: "" });
    click({ evScopeNo: "" });
    assert.deepEqual(focused, ['[data-ev-scope="occurrence"]', "[data-ev-edit]", "[data-ev-scope-no]", "[data-ev-delete]"]);
  } finally { delete info.querySelector; click({ closeDetail: "" }); }
}));

test("XERK-2973 QA: a split's move on a clamped day, its until, a 409 reload's anchor, and the whole-series count", () => withOrgs(async () => {
  const apr = occ({ id: "turma:0123456789abcdef:2027-04-30T14:00:00Z", originalStart: "2027-04-30T14:00:00Z",
    seriesStart: "2027-01-31T10:00:00-05:00", start: "2027-04-30T10:00:00-04:00", end: "2027-04-30T11:00:00-04:00",
    startMs: Date.parse("2027-04-30T14:00:00Z"), endMs: Date.parse("2027-04-30T15:00:00Z"), recurrence: { freq: "monthly", interval: 1, count: 8 } });
  const label = () => /data-ed-rep-summary[^>]*><svg[^]*?<\/svg>([^<]*)</.exec(cal._edEls().panel.innerHTML)[1];
  const change = (dataset, value) => { for (const f of cal._edEls().panel.listeners.change) f({ target: { dataset, value } }); };
  cal.openEditor({ event: apr, scope: "following" });
  assert.equal(label(), "Every month on day 31, 8 times in the whole series");
  assert.match(cal._edEls().panel.innerHTML, /occurrences in the whole series/);
  // Moved a day earlier: the new series runs on the 29th (never "the series shifted": day 30).
  change({ edField: "startDate" }, "2027-04-29");
  change({ edRep: "end" }, "count");
  assert.match(label(), /^Every month on day 29/);
  // Its until may not end before the NEW start.
  const f = cal._ed().f;
  f.repeat = { ...f.repeat, end: "until", until: "2027-04-28" };
  assert.equal(cal.validateForm(f).repeat, "It must repeat until a day on or after its start.");
  f.repeat = { ...f.repeat, until: "2027-04-29" };
  assert.equal(cal.validateForm(f).repeat, undefined);
  cal.closeEditor();
  // After a 409 reload a move still re-anchors (the reload keeps the opened date).
  replies = { "/api/calendar/events/": () => ({ status: 409, body: { error: "changed", event: { ...apr, subject: "Theirs", version: 3 } } }) };
  cal.openEditor({ event: apr, scope: "following" });
  editorFill({ subject: "Mine" });
  await cal.saveEditor();
  change({ edField: "startDate" }, "2027-04-29");
  change({ edRep: "end" }, "count");
  assert.match(label(), /^Every month on day 29/);
  cal.closeEditor();
}));

test("XERK-2973 QA: the whole-series count is said visibly, only on a split, kept across a 409, and live while typing", () => withOrgs(async () => {
  const w8 = occ({ recurrence: { freq: "weekly", interval: 1, count: 8 } });
  const visible = () => cal._edEls().panel.innerHTML.replace(/aria-label="[^"]*"/g, "");
  cal.openEditor({ event: w8, scope: "following" });
  assert.match(visible(), /> occurrences in the whole series/, "the text, not just the aria-label");
  assert.match(visible(), /8 times in the whole series/);
  // Live while typing: the in-place refresh says it too.
  const sum = { innerHTML: "" };
  const panel = cal._edEls().panel;
  panel.querySelector = (sel) => (sel === "[data-ed-rep-summary]" ? sum : null);
  panel.querySelectorAll = () => [];
  try {
    for (const f of panel.listeners.input) f({ target: { dataset: { edRep: "count" }, value: "10" } });
    assert.match(sum.innerHTML, /10 times in the whole series$/);
  } finally { delete panel.querySelector; delete panel.querySelectorAll; }
  cal.closeEditor();
  // "All events" and "This event" count only the series itself: no suffix.
  for (const scope of ["series", "occurrence"]) {
    cal.openEditor({ event: w8, scope });
    assert.doesNotMatch(visible(), /in the whole series/, scope);
    cal.closeEditor();
  }
  // A 409 reload keeps saying it.
  replies = { "/api/calendar/events/": () => ({ status: 409, body: { error: "changed", event: { ...w8, subject: "Theirs", version: 3 } } }) };
  cal.openEditor({ event: w8, scope: "following" });
  editorFill({ subject: "Mine" });
  await cal.saveEditor();
  assert.match(visible(), /8 times in the whole series/);
  cal.closeEditor();
}));

// ---- XERK-2992: the subscribe-by-link settings section ---------------------------
test("XERK-2992: the feed section mints a link shown once, per org, escaped, and turns it off", async () => {
  Object.assign(cal.feed, { loaded: false, loading: false, available: true, exists: false, at: 0, token: "", busy: false, err: "", copied: "" });
  replies["/api/calendar/feed"] = (url, init) => (init.method === "POST"
    ? { ok: true, token: "TOK_en-1", path: "/feeds/calendar/TOK_en-1.ics", at: 1 }
    : init.method === "DELETE" ? { ok: true, revoked: true } : { available: true, exists: false, at: 0 });
  globalThis.location = { href: "", origin: "https://hub.example" };
  try {
    assert.match(cal.feedSettingsHtml(), /Loading/);
    await cal.loadFeed();
    assert.match(cal.feedSettingsHtml(), /data-feed-new[^>]*>Create link</);
    assert.doesNotMatch(cal.feedSettingsHtml(), /data-feed-off/);
    await cal.feedAction("new");
    const html = cal.feedSettingsHtml();
    assert.match(html, /value="https:\/\/hub\.example\/feeds\/calendar\/TOK_en-1\.ics"/);
    assert.match(html, /shown only once/);
    assert.ok(posts.some((p) => p.url === "/api/calendar/feed"));
    await cal.feedAction("off");
    assert.equal(cal.feed.token, "");
    assert.match(cal.feedSettingsHtml(), /Create link/);
    // A principal that cannot own one is told so; a refusal is shown in the hub's words.
    cal.feed.available = false;
    assert.match(cal.feedSettingsHtml(), /your own account/);
    cal.feed.available = true;
    replies["/api/calendar/feed"] = () => ({ status: 409, body: { error: "no <b>link</b> for you" } });
    await cal.feedAction("new");
    assert.match(cal.feedSettingsHtml(), /no &lt;b&gt;link&lt;\/b&gt; for you/);
  } finally {
    delete replies["/api/calendar/feed"];
    globalThis.location = { href: "" };
  }
});

test("XERK-2987: each org's Outlook copy on the panel, escaped; the block marks failed/pending; an older hub reads as before", () => {
  // An older hub serves no `outlook`: no state, the old wording, no mark.
  assert.equal(cal.outlookStates(tev()), null);
  assert.equal(cal.outlookMark(tev()), "");
  assert.match(cal.detailHtml(tev(), NOW), /Made in Turma — not on Outlook/);
  assert.ok(!/>Outlook<\/span>/.test(cal.detailHtml(tev(), NOW)));
  // An Outlook event never reads an `outlook` field as its own state.
  assert.equal(cal.outlookStates({ source: "outlook", org: "acme", outlook: { acme: { state: "failed" } } }), null);
  const ev = tev({ outlook: {
    acme: { state: "failed", error: "<b>Outlook</b> is not open", at: 1 },
    globex: { state: "pending", noHost: true, at: 1 },
  } });
  assert.deepEqual(cal.outlookStates(ev).map((x) => [x.org, x.state, x.text]),
    [["acme", "failed", "Failed: <b>Outlook</b> is not open"], ["globex", "nohost", "No Outlook host for this org"]]);
  const h = cal.detailHtml(ev, NOW);
  assert.match(h, /Calendar<\/span><span class="v">Made in Turma<\/span>/);
  assert.match(h, /<span class="cal-olk-row failed">acme: Failed: &lt;b&gt;Outlook&lt;\/b&gt; is not open<\/span>/);
  assert.match(h, /<span class="cal-olk-row nohost">globex: No Outlook host for this org<\/span>/);
  assert.ok(!h.includes("<b>Outlook"), "Outlook's words are escaped");
  assert.ok(!/data-olk-retry|Retry/.test(h), "no retry route exists: the next edit retries");
  assert.equal(cal.outlookMark(ev), "failed");
  // Written and writing; one org drops the org prefix; a re-created copy says so.
  const one = tev({ orgs: ["acme"], outlook: { acme: { state: "written", recreatedAt: 5, at: 5 } } });
  assert.match(cal.detailHtml(one, NOW), /<span class="cal-olk-row written">In Outlook \(re-created after it was deleted there\)<\/span>/);
  assert.equal(cal.outlookMark(one), "");
  const writing = tev({ outlook: { acme: { state: "written", at: 1 }, globex: { state: "pending", at: 1 } } });
  assert.equal(cal.outlookMark(writing), "pending");
  assert.match(cal.detailHtml(writing, NOW), /globex: Writing…/);
  // No host alone never marks the block (it may wait forever).
  assert.equal(cal.outlookMark(tev({ outlook: { acme: { state: "pending", noHost: true }, globex: { state: "written" } } })), "");
});

test("XERK-2987: the block wears the mark and says it aloud", () => withOrgs(async () => {
  replies = { "/api/calendar": () => ({ hosts: [], events: [tev({ outlook: { acme: { state: "failed", error: "x" }, globex: { state: "written" } } })] }) };
  cal.refetch();
  const html = await show(at(2027, 5, 4));
  assert.match(html, /<span class="cal-olk failed" aria-hidden="true"[^>]*>!<\/span>/);
  assert.match(html, /aria-label="Joint planning,[^"]*Turma event, an Outlook copy failed/);
}));
