"use strict";
// The iCal serializer behind the subscribable calendar feed (XERK-2992).
const test = require("node:test");
const assert = require("node:assert/strict");
const { calendarIcs, icsText, foldLine, eventUid } = require("../ics");

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);

test("XERK-2992: TEXT values escape backslash, semicolon, comma and newlines, and drop controls", () => {
  assert.equal(icsText("a\\b;c,d\r\ne\nf\u0007g"), "a\\\\b\\;c\\,d\\ne\\nfg");
  assert.equal(icsText(null), "");
});

test("XERK-2992: lines fold at 75 octets and never split a UTF-8 character", () => {
  const line = `SUMMARY:${"é".repeat(60)}`;   // 8 + 120 octets
  const folded = foldLine(line);
  const parts = folded.split("\r\n");
  assert.ok(parts.length > 1);
  for (const [i, p] of parts.entries()) {
    assert.ok(Buffer.byteLength(p, "utf8") <= 75, `line ${i} too long`);
    assert.ok(!p.includes("�"), "a code point was split");
    if (i) assert.equal(p[0], " ");
  }
  assert.equal(parts.map((p, i) => (i ? p.slice(1) : p)).join(""), line);
  assert.equal(foldLine("SHORT:x"), "SHORT:x");
});

test("XERK-2992: a timed event is written in UTC; an all-day one by its wall date, end exclusive", () => {
  const out = calendarIcs([
    { source: "outlook", host: "h", id: "1", subject: "Standup", start: "2026-11-16T09:00:00-05:00",
      end: "2026-11-16T09:15:00-05:00", startMs: Date.parse("2026-11-16T09:00:00-05:00"),
      endMs: Date.parse("2026-11-16T09:15:00-05:00"), org: "acme.atlassian.net" },
    { source: "turma", host: "", id: "turma:ab", subject: "Offsite", allDay: true,
      start: "2026-11-20T00:00:00-08:00", end: "2026-11-22T00:00:00-08:00",
      startMs: Date.parse("2026-11-20T00:00:00-08:00"), endMs: Date.parse("2026-11-22T00:00:00-08:00"),
      orgs: ["a", "b"], org: "a", busy: "free" },
    { source: "outlook", host: "h", id: "2", subject: "Zero length all-day", allDay: true,
      start: "2026-11-25T00:00:00Z", end: "2026-11-25T00:00:00Z", startMs: 1, endMs: 1 },
  ], { now: NOW, orgName: (s) => s.replace(/\.atlassian\.net$/, "") });
  assert.match(out, /^BEGIN:VCALENDAR\r\n[\s\S]*END:VCALENDAR\r\n$/);
  assert.ok(!/[^\r]\n/.test(out), "every line ends CRLF");
  assert.match(out, /DTSTART:20261116T140000Z\r\nDTEND:20261116T141500Z\r\n/);
  assert.match(out, /DTSTART;VALUE=DATE:20261120\r\nDTEND;VALUE=DATE:20261122\r\n/);
  assert.match(out, /DTSTART;VALUE=DATE:20261125\r\nDTEND;VALUE=DATE:20261126\r\n/);
  assert.match(out, /CATEGORIES:acme\r\n/);
  assert.match(out, /CATEGORIES:a,b\r\n/);
  assert.match(out, /TRANSP:TRANSPARENT\r\n/);
  assert.match(out, /DTSTAMP:20261115T120000Z\r\n/);
});

test("XERK-2992: canceled, tentative and private events say so; a join link rides URL + DESCRIPTION", () => {
  const base = { host: "h", start: "2026-11-16T09:00:00Z", end: "2026-11-16T10:00:00Z",
    startMs: Date.parse("2026-11-16T09:00:00Z"), endMs: Date.parse("2026-11-16T10:00:00Z") };
  const out = calendarIcs([
    { ...base, id: "c", subject: "Retro", canceled: true },
    { ...base, id: "t", subject: "Maybe", myResponse: "tentative" },
    { ...base, id: "p", subject: "Private event", private: true },
    { ...base, id: "j", subject: "Call", joinUrl: "https://zoom.us/j/1", body: "Agenda" },
    { ...base, id: "x", subject: "No times", startMs: NaN },
  ], { now: NOW });
  assert.match(out, /SUMMARY:Canceled: Retro\r\nSTATUS:CANCELLED\r\n/);
  assert.match(out, /STATUS:TENTATIVE\r\n/);
  assert.match(out, /CLASS:PRIVATE\r\n/);
  assert.match(out, /DESCRIPTION:Agenda\\n\\nJoin: https:\/\/zoom.us\/j\/1\r\nURL:https:\/\/zoom.us\/j\/1\r\n/);
  assert.doesNotMatch(out, /No times/);
  assert.equal((out.match(/BEGIN:VEVENT/g) || []).length, 4);
});

test("XERK-2992: a UID is stable per event, distinct across hosts, and leaks no id", () => {
  const a = eventUid({ source: "outlook", host: "laptop@" + "f".repeat(32), id: "GLOBAL-ID" });
  assert.equal(a, eventUid({ source: "outlook", host: "laptop@" + "f".repeat(32), id: "GLOBAL-ID" }));
  assert.notEqual(a, eventUid({ source: "outlook", host: "desk", id: "GLOBAL-ID" }));
  assert.match(a, /^[0-9a-f]{32}@turma$/);
});

test("XERK-2992: a recurring all-day occurrence east of UTC keeps its own wall date", () => {
  // turmaOccurrenceRecord serves an occurrence's start in UTC: Berlin Monday
  // midnight is Sunday 23:00Z.
  const out = calendarIcs([{ source: "turma", host: "", id: "turma:ab:2026-11-15T23:00:00Z", subject: "Off",
    allDay: true, timeZone: "Europe/Berlin", start: "2026-11-15T23:00:00Z", end: "2026-11-16T23:00:00Z",
    startMs: Date.parse("2026-11-15T23:00:00Z"), endMs: Date.parse("2026-11-16T23:00:00Z") },
  { source: "turma", host: "", id: "turma:cd", subject: "Tokyo", allDay: true, timeZone: "Asia/Tokyo",
    start: "2026-11-17T15:00:00Z", end: "2026-11-18T15:00:00Z",
    startMs: Date.parse("2026-11-17T15:00:00Z"), endMs: Date.parse("2026-11-18T15:00:00Z") }], { now: NOW });
  assert.match(out, /DTSTART;VALUE=DATE:20261116\r\nDTEND;VALUE=DATE:20261117\r\n/);
  assert.match(out, /DTSTART;VALUE=DATE:20261118\r\nDTEND;VALUE=DATE:20261119\r\n/);
  // A multi-day occurrence: the END date is read in the zone too (QA: the last day was lost).
  const three = calendarIcs([{ source: "turma", host: "", id: "turma:ef:x", subject: "Trip", allDay: true,
    timeZone: "Europe/Berlin", start: "2026-11-17T23:00:00Z", end: "2026-11-20T23:00:00Z",
    startMs: Date.parse("2026-11-17T23:00:00Z"), endMs: Date.parse("2026-11-20T23:00:00Z") }], { now: NOW });
  assert.match(three, /DTSTART;VALUE=DATE:20261118\r\nDTEND;VALUE=DATE:20261121\r\n/);
});

test("XERK-2992: a URL value is written as a URI (no TEXT escaping); an owner's private event says CLASS:PRIVATE", () => {
  const base = { host: "h", start: "2026-11-16T09:00:00Z", end: "2026-11-16T10:00:00Z",
    startMs: Date.parse("2026-11-16T09:00:00Z"), endMs: Date.parse("2026-11-16T10:00:00Z") };
  const out = calendarIcs([{ ...base, id: "u", subject: "Teams", joinUrl: "https://teams.microsoft.com/l/x?a=1,b;c" },
    { ...base, id: "o", subject: "Mine", sensitivity: "private" }], { now: NOW });
  assert.match(out, /\r\nURL:https:\/\/teams\.microsoft\.com\/l\/x\?a=1,b;c\r\n/);
  assert.match(out, /SUMMARY:Mine\r\n[\s\S]*?CLASS:PRIVATE\r\n/);
});
