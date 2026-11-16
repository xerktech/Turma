"use strict";
// RFC 5545 serializer for the subscribable calendar feed (XERK-2992,
// contract-calendar.md "The subscribable feed"). Pure: takes the events
// `calendarView` serves and returns the VCALENDAR text. No dependency.
//
// Times are written in UTC (`...Z`), so the feed carries no VTIMEZONE and a
// subscriber's client shows them in its own zone. An all-day event is written
// as VALUE=DATE from its wall date (the `YYYY-MM-DD` its ISO start carries,
// which is the creator's / Outlook's local date), end exclusive as RFC 5545
// wants and as the store already keeps it.
//
// Every event is one VEVENT, recurring occurrences included (the view has
// already expanded them): no RRULE, so the hub's own rules (Outlook's
// month-end rule, moved and deleted occurrences) are exactly what a subscriber
// sees.

const crypto = require("crypto");

// TEXT value escaping (RFC 5545 §3.3.11): backslash, semicolon, comma, newline.
// Control characters other than the newline are dropped (the store already
// strips them; this is defence in depth, a CR would break the line framing).
function icsText(s) {
  return String(s == null ? "" : s)
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

// Fold a content line at 75 octets (§3.1), never inside a UTF-8 sequence.
function foldLine(line) {
  const buf = Buffer.from(line, "utf8");
  if (buf.length <= 75) return line;
  const out = [];
  let start = 0;
  let limit = 75;
  while (start < buf.length) {
    let end = Math.min(start + limit, buf.length);
    // Back off a continuation byte (10xxxxxx) so a code point is never split.
    while (end < buf.length && end > start && (buf[end] & 0xc0) === 0x80) end--;
    out.push(buf.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74;   // later lines start with the folding space
  }
  return out.join("\r\n ");
}

const pad = (n) => String(n).padStart(2, "0");
function utcStamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
// The wall date of an ISO string ("2026-11-16T00:00:00-05:00" -> "20261116").
function wallDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${m[1]}${m[2]}${m[3]}` : "";
}
function nextDate(yyyymmdd) {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + 1));
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

// A UID stable across fetches, so a subscriber updates an event in place
// instead of duplicating it. Hashed: an Outlook id is long and a host key
// carries the tenant id, neither of which belongs in a subscriber's calendar.
function eventUid(ev) {
  const h = crypto.createHash("sha256")
    .update(`${ev.source || ""}\u0000${ev.host || ""}\u0000${ev.id || ""}`).digest("hex").slice(0, 32);
  return `${h}@turma`;
}

// `ev` is one calendarView event; `orgName(site)` labels an org. Returns the
// VEVENT's lines, or [] when the event has no usable time.
function veventLines(ev, now, orgName) {
  if (!Number.isFinite(ev.startMs) || !Number.isFinite(ev.endMs)) return [];
  const lines = ["BEGIN:VEVENT", `UID:${eventUid(ev)}`, `DTSTAMP:${utcStamp(now)}`];
  if (ev.allDay === true) {
    const s = wallDate(ev.start);
    if (!s) return [];
    let e = wallDate(ev.end);
    if (!e || e <= s) e = nextDate(s);
    lines.push(`DTSTART;VALUE=DATE:${s}`, `DTEND;VALUE=DATE:${e}`);
  } else {
    lines.push(`DTSTART:${utcStamp(ev.startMs)}`, `DTEND:${utcStamp(Math.max(ev.endMs, ev.startMs))}`);
  }
  const subject = String(ev.subject || "").trim() || "(no title)";
  lines.push(`SUMMARY:${icsText(ev.canceled === true ? `Canceled: ${subject}` : subject)}`);
  if (ev.location) lines.push(`LOCATION:${icsText(ev.location)}`);
  const orgs = (Array.isArray(ev.orgs) && ev.orgs.length ? ev.orgs : [ev.org]).filter((o) => typeof o === "string" && o);
  const orgLabels = orgs.map(orgName);
  const desc = [];
  const body = typeof ev.body === "string" && ev.body ? ev.body : (typeof ev.summary === "string" ? ev.summary : "");
  if (body) desc.push(body);
  if (ev.joinUrl) desc.push(`Join: ${ev.joinUrl}`);
  if (orgLabels.length) desc.push(`${orgLabels.length > 1 ? "Orgs" : "Org"}: ${orgLabels.join(", ")}`);
  if (desc.length) lines.push(`DESCRIPTION:${icsText(desc.join("\n\n"))}`);
  // An https link only (the store's whitelist already enforces it for joinUrl).
  if (typeof ev.joinUrl === "string" && /^https:\/\//.test(ev.joinUrl)) lines.push(`URL:${icsText(ev.joinUrl)}`);
  if (orgLabels.length) lines.push(`CATEGORIES:${orgLabels.map(icsText).join(",")}`);
  if (ev.canceled === true) lines.push("STATUS:CANCELLED");
  else if (ev.busy === "tentative" || ev.myResponse === "tentative") lines.push("STATUS:TENTATIVE");
  lines.push(`TRANSP:${ev.busy === "free" ? "TRANSPARENT" : "OPAQUE"}`);
  if (ev.private === true) lines.push("CLASS:PRIVATE");
  lines.push("END:VEVENT");
  return lines;
}

// The whole feed. `name` is the calendar's display name (X-WR-CALNAME, which
// Google, Apple and Outlook all read for a subscribed calendar).
function calendarIcs(events, { name = "Turma", now = Date.now(), orgName = (s) => s } = {}) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Turma//Calendar feed//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${icsText(name)}`,
    // Ask for a refresh every hour. Google ignores it (it polls on its own
    // schedule, often 8-24h); Apple and Outlook honour it.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
  for (const ev of events || []) {
    if (ev && typeof ev === "object") lines.push(...veventLines(ev, now, orgName));
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

module.exports = { calendarIcs, icsText, foldLine, eventUid };
