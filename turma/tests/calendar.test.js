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
globalThis.fetch = async (u) => {
  const url = String(u);
  const key = Object.keys(replies).find((k) => url.startsWith(k));
  const body = await (key ? replies[key](url) : (url.startsWith("/api/holidays") ? [] : { events: [], hosts: [] }));
  // A reply of {status, body} is a refusal.
  if (body && body.status) return { status: body.status, ok: false, json: async () => body.body || {} };
  return { status: 200, ok: true, json: async () => body };
};
const cal = require("../public/calendar.js");

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const ymd = (ms) => cal.dayKey(ms);

test("XERK-2897: week math — Monday starts, local midnights across the fall-back DST week", () => {
  // US DST ends Sunday 2026-11-01.
  const days = cal.visibleDays(at(2026, 10, 29, 15), "week");
  assert.deepEqual(days.map(ymd), ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
  for (const d of days) assert.equal(new Date(d).getHours(), 0);
  assert.equal(days[6] - days[5], 86400000);           // Sat → Sun is still a full day
  assert.equal(cal.addDays(days[6], 1) - days[6], 25 * 3600000); // Sunday has 25 hours
  assert.deepEqual(cal.visibleDays(at(2026, 10, 29), "work").map(ymd).slice(-1), ["2026-10-30"]);
  // › from that week lands on the next Monday at midnight, not 23:00.
  const next = cal.visibleDays(cal.stepAnchor(at(2026, 10, 29), "week", 1), "week");
  assert.equal(ymd(next[0]), "2026-11-02");
  assert.equal(new Date(next[0]).getHours(), 0);
  // 9:00 on the DST day sits on the 9:00 row, not 8:00 or 10:00.
  assert.equal(cal.wallMinutes(at(2026, 11, 1, 9), at(2026, 11, 1)), 540);
});

test("XERK-2897: week math — spring-forward and a week across the year boundary", () => {
  const spring = cal.visibleDays(at(2026, 3, 8, 12), "week");  // DST starts Sunday 2026-03-08
  assert.equal(ymd(spring[0]), "2026-03-02");
  assert.equal(cal.addDays(spring[6], 1) - spring[6], 23 * 3600000);
  assert.equal(cal.wallMinutes(at(2026, 3, 8, 9), at(2026, 3, 8)), 540);

  const nye = cal.visibleDays(at(2026, 12, 31), "week");
  assert.deepEqual([ymd(nye[0]), ymd(nye[6])], ["2026-12-28", "2027-01-03"]);
  const label = cal.rangeLabel(nye);
  assert.match(label, /2026/);
  assert.match(label, /2027/);
  assert.equal(ymd(cal.stepAnchor(at(2027, 1, 1), "week", -1)), "2026-12-25");
  // A narrow three-day view across a week edge reads both weeks.
  const three = cal.visibleDays(at(2027, 1, 3), "three");
  assert.deepEqual(three.map(ymd), ["2027-01-03", "2027-01-04", "2027-01-05"]);
  assert.deepEqual(cal.weeksOf(three).map(ymd), ["2026-12-28", "2027-01-04"]);
  assert.equal(ymd(cal.stepAnchor(three[0], "three", 1)), "2027-01-06");
  assert.equal(ymd(cal.stepAnchor(three[0], "day", -1)), "2027-01-02");
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
  const e = { _html: "", listeners: {}, addEventListener(n, f) { (this.listeners[n] ||= []).push(f); },
    querySelector() { return null; }, querySelectorAll() { return []; }, contains(t) { return !!t && t.inside === true; } };
  Object.defineProperty(e, "innerHTML", { get() { return this._html; }, set(v) { this._html = String(v); } });
  return e;
}
const root = el();
let NOW = at(2026, 11, 11, 10, 30);
cal.mount(root, { now: () => NOW });

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
  for (const f of root.listeners.click) f({ target: { closest: () => ({ dataset: { ev: btn[1], day: btn[2] } }) } });
  assert.ok(root.innerHTML.includes('class="cal-detail"'));
  assert.ok(!root.innerHTML.includes("<img"));
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
  const open = () => { for (const f of root.listeners.click) f({ target: { closest: () => ({ dataset: { ev: btn[1], day: btn[2] } }) } }); };
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
        startMs: at(2026, 11, 16, 9), endMs: at(2026, 11, 16, 10) },
      { host: "h1", id: "far", org: "acme", subject: "Too far", startMs: at(2026, 11, 20, 9), endMs: at(2026, 11, 20, 10) }] };
    }
    return { hosts: [], events: [
      m("live", 11), m("now", 10),                                   // started, not ended: still upcoming
      { ...m("live", 11), host: "h2" },                              // the same meeting on a second host
      m("past", 8), m("canceled", 13, { canceled: true }), m("declined", 13, { myResponse: "declined" }),
      m("focus", 14, { busy: "free" }), m("wfh", 14, { busy: "workingElsewhere" }),
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
  assert.deepEqual(cal.upcoming("acme").map((e) => e.id), ["now", "live", "next-mon"]);
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
  for (const f of root.listeners.click) f({ target: { closest: () => ({ dataset: { openNotes: "" } }) } });
  assert.deepEqual(jumps, [{ site: "acme", meetingId: "cap-1" }]);
  // A Tenir-only capture is found by its meeting id; a past, unlinked event has no way back.
  cal.reveal({ site: "acme", meetingId: "cap-2", startMs: at(2026, 12, 4, 11) });
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(cal._state().detail.id, "tenir:cap-2");
  assert.deepEqual(cal.notesTarget(cal._state().detail, NOW), { site: "acme", meetingId: "cap-2" });
  assert.deepEqual(cal.notesTarget({ id: "u", org: "acme", startMs: NOW + 3600000, endMs: NOW + 7200000 }, NOW),
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
  // A mode pick ends the weekend Week.
  for (const f of root.listeners.click) f({ target: { closest: () => ({ dataset: { mode: "work" } }) } });
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
