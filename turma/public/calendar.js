// The Meetings page's Calendar view (XERK-2897, epic XERK-2890): a read-only,
// Microsoft Teams-style week of every org's Outlook events (GET /api/calendar),
// Tenir's impromptu captures, and holidays (GET /api/holidays). Each event is
// tinted with its org's color (board.js orgColorMap + the hub's orgColors pins).
//
// A shared module like meetings.js: brief.html mounts it, hands it the fleet
// snapshot (update) and tells it when the hub's `calendar` / `holidaySettings`
// SSE frames land (refetch). It reads the calendar routes itself — the events
// are too big for the snapshot (contract-calendar.md). Read-only: no drag, no
// create, no edit. Rules + the Teams decisions: .claude/rules/turma-meetings.md.
// Loaded after org.js; in server.js's HASHED_ASSETS. Tests: tests/calendar.test.js.
(() => {
const DAY_MS = 86400000;
const SLOT_PX = 24;                 // one 30-minute row
const HOUR_PX = SLOT_PX * 2;
const DAY_PX = HOUR_PX * 24;
const WORK_FROM_H = 8, WORK_UNTIL_H = 17;  // the shaded working hours; the grid opens at 8:00
const MIN_LAYOUT_MIN = 20;          // a shorter (or zero-length) event lays out as 20 minutes (one readable line)
const NARROW_PX = 760;
const RETRY_PENDING_MS = 20000;     // a sync the hub queued: re-read in case its frame is missed
const MODAL_OPEN = '.td-backdrop:not([hidden]) > [aria-modal="true"]';
const RETRY_ERROR_MAX_MS = 300000;  // a failed read's longest back-off
const MODE_KEY = "turma-calendar-mode";
const UPCOMING_MS = 7 * DAY_MS;     // how far ahead the notes review lists calendar meetings (XERK-2899)

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}
const own = (map, k) => (map && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined);
const num = (v) => typeof v === "number" && Number.isFinite(v);
// A join link is rebuilt only from an https URL with nothing that could break out of the attribute.
const safeHttps = (u) => (typeof u === "string" && /^https:\/\/[^\s"'<>`\\]+$/i.test(u) ? u : "");
// An org color is only ever a palette slot from orgColorMap; anything else paints neutral.
const safeColor = (c) => (typeof c === "string" && /^var\(--s[1-8]\)$/.test(c) ? c : "");

function loadStore(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v ?? fallback; } catch { return fallback; }
}
function saveStore(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* per-viewer nicety */ }
}

// ---- week math (local wall time; Date's own calendar arithmetic, so DST days are 23/25h) ----
function dayStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function addDays(ms, n) { const d = new Date(dayStart(ms)); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d.getTime(); }
// The Monday of `ms`'s week (Teams' week runs Monday–Sunday; Work week is Monday–Friday).
function weekStart(ms) { const d = new Date(dayStart(ms)); return addDays(d.getTime(), -((d.getDay() + 6) % 7)); }
const pad = (n) => String(n).padStart(2, "0");
function dayKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
// "YYYY-MM-DD" → that local midnight (a holiday's date is a calendar day, not an instant).
function parseDayKey(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN;
}
const MODES = { work: 5, week: 7, day: 1, three: 3 };
// The days a mode shows around `anchor`.
function visibleDays(anchor, mode) {
  const first = mode === "work" || mode === "week" ? weekStart(anchor) : dayStart(anchor);
  const n = MODES[mode] || 5;
  return Array.from({ length: n }, (_, i) => addDays(first, i));
}
// ‹ › move a week in the week modes, else by what is shown.
function stepAnchor(anchor, mode, dir) {
  return addDays(anchor, dir * (mode === "work" || mode === "week" ? 7 : (MODES[mode] || 1)));
}
// The weeks (Monday ms) a set of days touches: what is fetched.
function weeksOf(days) { return [...new Set(days.map(weekStart))]; }
// "November 9–13, 2026" (Intl formats the range across a month or year boundary).
function rangeLabel(days) {
  const a = days[0], b = days[days.length - 1];
  const opts = { month: "long", day: "numeric", year: "numeric" };
  try {
    const f = new Intl.DateTimeFormat([], opts);
    return a === b || typeof f.formatRange !== "function" ? f.format(a) : f.formatRange(a, b);
  } catch { return new Date(a).toDateString(); }
}
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function fmtSpan(s, e) {
  try {
    const f = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
    if (typeof f.formatRange === "function" && e > s && dayStart(s) === dayStart(e)) return f.formatRange(s, e);
  } catch { /* fall through */ }
  return e > s ? `${fmtTime(s)} – ${fmtTime(e)}` : fmtTime(s);
}
const fmtLongDay = (ms) => new Date(ms).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
function ago(ms, now) {
  if (!num(ms) || ms <= 0) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
// Minutes past `day`'s local midnight on the wall clock (DST-correct: 9:00 sits at row 18 every day).
function wallMinutes(ms, day) {
  if (ms <= day) return 0;
  if (ms >= addDays(day, 1)) return 1440;
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

// ---- events -------------------------------------------------------------------
// An all-day event, or one lasting a day or more, rides the all-day band (as Teams draws it).
const inBand = (ev) => ev.allDay === true || ev.endMs - ev.startMs >= DAY_MS;
// Does [s, e) touch the day starting at `day`? A zero-length event belongs to its start's day.
function onDay(ev, day) {
  const next = addDays(day, 1);
  if (ev.endMs <= ev.startMs) return ev.startMs >= day && ev.startMs < next;
  return ev.startMs < next && ev.endMs > day;
}
// Teams-like look of one event: what the class list says.
function styleOf(ev, now) {
  const c = [];
  if (ev.canceled === true) c.push("canceled");
  if (num(ev.endMs) && Math.max(ev.endMs, ev.startMs) < now) c.push("past");
  if (ev.busy === "tentative" || ev.myResponse === "tentative" || ev.myResponse === "notResponded") c.push("tentative");
  else if (ev.busy === "free" || ev.myResponse === "declined") c.push("free");
  if (ev.busy === "outOfOffice") c.push("ooo");
  if (ev.source === "tenir") c.push("tenir");
  return c;
}
// A meeting the notes review lists as upcoming (XERK-2899): an Outlook event that is
// a timed, live meeting of an org — not a holiday-like all-day block, a canceled or
// declined one, a free / out-of-office / working-elsewhere block, or one already captured.
const NOT_MEETING_BUSY = new Set(["free", "outOfOffice", "workingElsewhere"]);
function isUpcomingMeeting(ev, now) {
  return !!ev && ev.source !== "tenir" && typeof ev.org === "string" && !!ev.org && !inBand(ev)
    && ev.canceled !== true && ev.myResponse !== "declined" && !NOT_MEETING_BUSY.has(ev.busy)
    && !(Array.isArray(ev.meetings) && ev.meetings.length)
    && num(ev.endMs) && ev.endMs > now && ev.startMs < now + UPCOMING_MS;
}
// Where "Open in notes review" lands for an event: its capture (Tenir-only, or the
// first linked one), else the upcoming meeting itself; null when the notes review
// has no entry for it.
function notesTarget(ev, now) {
  if (!ev) return null;
  if (ev.source === "tenir" && typeof ev.site === "string" && typeof ev.meetingId === "string") {
    return { site: ev.site, meetingId: ev.meetingId };
  }
  const m = Array.isArray(ev.meetings) ? ev.meetings.find((x) => x && typeof x.site === "string" && typeof x.meetingId === "string") : null;
  if (m) return { site: m.site, meetingId: m.meetingId };
  return isUpcomingMeeting(ev, now) ? { site: ev.org, eventId: String(ev.id) } : null;
}
const titleOf = (ev) => {
  const s = String(ev.subject || "").trim() || "(no title)";
  return ev.canceled === true ? `Canceled: ${s}` : s;
};
// Side-by-side columns for the timed events of one day, Teams-style: each cluster
// of (transitively) overlapping events splits the width into as many columns as
// it needs at once, and an event widens into free columns to its right.
// In: [{top, bottom, ...}] minutes. Out: the same objects with col, cols, span.
function layoutDay(segs) {
  const list = segs.slice().sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  let cluster = [], cols = [], maxBottom = -Infinity;
  const finish = () => {
    for (const s of cluster) {
      s.cols = cols.length;
      let span = 1;
      while (s.col + span < cols.length
        && !cluster.some((o) => o.col === s.col + span && o.top < s.bottom && o.bottom > s.top)) span++;
      s.span = span;
    }
    cluster = []; cols = []; maxBottom = -Infinity;
  };
  for (const s of list) {
    if (cluster.length && s.top >= maxBottom) finish();
    let col = cols.findIndex((b) => b <= s.top);
    if (col < 0) { col = cols.length; cols.push(s.bottom); } else cols[col] = s.bottom;
    s.col = col;
    cluster.push(s);
    maxBottom = Math.max(maxBottom, s.bottom);
  }
  if (cluster.length) finish();
  return list;
}
// The timed events of one day as laid-out segments.
function daySegments(events, day) {
  const segs = [];
  for (const ev of events) {
    if (inBand(ev) || !onDay(ev, day)) continue;
    const top = wallMinutes(ev.startMs, day);
    const end = ev.endMs > ev.startMs ? wallMinutes(ev.endMs, day) : top;
    segs.push({ ev, top, end, bottom: Math.min(1440, Math.max(end, top + MIN_LAYOUT_MIN)) });
  }
  return layoutDay(segs);
}

// ---- page state ---------------------------------------------------------------
let $root = null;
let active = false;
let data = null;                  // the fleet snapshot, for org names/colors
let anchor = dayStart(Date.now());
let modes = loadStore(MODE_KEY, {});
let narrow = false;
let picker = null;                // the mini-month's shown month (ms of its 1st) when open
let detail = null;                // the event whose placeholder detail is open
let shown = [];                   // the events of the last paint, indexed by data-ev
let scrolled = false;             // the grid opened at working hours once
const weeks = new Map();          // `${orgKey}|${weekMs}` -> {cal, hol, loading, again, err, retry}
let nowFn = () => Date.now();
let onData = null;                // the page's callback once a read lands (the notes review's upcoming list)
let openNotes = null;             // the page's "Open in notes review" (XERK-2899)
let upcomingWanted = false;       // the notes review reads the upcoming weeks (upcoming())
let revealing = null;             // {eventId?, site?, meetingId?} to select once its week is read (reveal())
let revealFocus = false;          // the revealed event's panel takes focus on the next paint
let scrollToMin = -1;             // the grid scrolls to this wall minute on the next paint

const wideMode = () => (modes && (modes.wide === "week" || modes.wide === "work") ? modes.wide : "work");
const narrowMode = () => (modes && (modes.narrow === "three" || modes.narrow === "day") ? modes.narrow : "day");
const mode = () => (narrow ? narrowMode() : wideMode());
function setMode(m) {
  if (!(m in MODES)) return;
  modes = { ...(modes && typeof modes === "object" ? modes : {}), [narrow ? "narrow" : "wide"]: m };
  saveStore(MODE_KEY, modes);
}

function orgKeys() { return typeof TurmaOrg !== "undefined" && TurmaOrg.getKeys ? TurmaOrg.getKeys() : []; }
const orgKeyOf = () => orgKeys().slice().sort().join(",");
function sites() {
  return typeof TurmaBoard !== "undefined" && TurmaBoard.mergeSites && data ? TurmaBoard.mergeSites(data.agents || []) : [];
}
function colorMap() {
  const B = typeof TurmaBoard !== "undefined" ? TurmaBoard : null;
  const pins = typeof TurmaOrg !== "undefined" && TurmaOrg.orgColors ? TurmaOrg.orgColors() : null;
  return B && B.orgColorMap ? B.orgColorMap(sites().map((s) => s.siteKey), pins) : new Map();
}
function orgLabel(site) {
  if (!site) return "No org";
  const hit = sites().find((s) => s.siteKey === site);
  const B = typeof TurmaBoard !== "undefined" ? TurmaBoard : null;
  return B && B.orgName ? B.orgName(site, hit && hit.orgName) : String(site);
}

// ---- data ---------------------------------------------------------------------
function weekEntry(ws, org = orgKeyOf()) {
  const k = `${org}|${ws}`;
  let w = weeks.get(k);
  if (!w) { w = { cal: null, hol: null, loading: false, again: false, err: "" }; weeks.set(k, w); }
  return w;
}
async function getJson(url) {
  const r = await fetch(url);
  if (r.status === 401) { location.href = "/login"; throw new Error("signed out"); }
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  if (!r.ok) {
    const T = typeof TurmaNav !== "undefined" ? TurmaNav : null;
    throw new Error(T && T.refusalText ? T.refusalText("Loading the calendar", r.status, body)
      : `Loading the calendar failed — ${(body && body.error) || `the hub answered HTTP ${r.status}`}`);
  }
  return body;
}
// Read one week (Monday–Sunday) of events + holidays. A read already in flight
// is asked again once it lands, so a frame mid-read is never lost.
// The read keeps the org pick it started with (its cache key), so a pick changed
// mid-read never leaves that entry loading or fills it with another pick's events.
async function loadWeek(ws, keys = orgKeys()) {
  keys = keys.slice().sort();
  const org = keys.join(",");
  const w = weekEntry(ws, org);
  if (w.loading) { w.again = true; return; }
  w.loading = true;
  w.again = false;
  clearTimeout(w.retry);
  w.retry = 0;
  const q = keys.length ? `&org=${encodeURIComponent(keys.join(","))}` : "";
  try {
    const [cal, hol] = await Promise.all([
      getJson(`/api/calendar?from=${ws}&until=${addDays(ws, 7)}${q}`),
      getJson(`/api/holidays?from=${dayKey(ws)}&until=${dayKey(addDays(ws, 6))}`),
    ]);
    w.cal = cal && Array.isArray(cal.events) ? cal : { events: [], hosts: [] };
    w.hol = Array.isArray(hol) ? hol : [];
    w.err = "";
    w.fails = 0;
  } catch (e) {
    w.err = String((e && e.message) || e);
    w.fails = (w.fails || 0) + 1;
  }
  w.loading = false;
  if (weeks.get(`${org}|${ws}`) !== w) return;           // dropped by refetch() meanwhile
  if (w.again) return void loadWeek(ws, keys);
  // A failed read (a hub rollout, a 503) and a host still syncing are both read
  // again later; while hidden the timer only clears, and showing re-asks. Failures
  // back off (20s doubling to 5 min): an older hub's 404 is no reason to hammer it.
  if (w.err || (w.cal && hostNotices(w.cal, ws).some((n) => n.syncing))) {
    const wait = w.err ? Math.min(RETRY_PENDING_MS * 2 ** (w.fails - 1), RETRY_ERROR_MAX_MS) : RETRY_PENDING_MS;
    w.retry = setTimeout(() => { w.retry = 0; if (active || upcomingWanted) loadWeek(ws, keys); }, wait);
    if (w.retry && w.retry.unref) w.retry.unref();
  }
  if (active) paint();
  if (onData) onData();
}
// Fetch what is shown (and the weeks either side, so ‹ › paints at once).
function wantedWeeks(days) {
  const vis = weeksOf(days);
  return [addDays(vis[0], -7), ...vis, addDays(vis[vis.length - 1], 7)];
}
function ensureLoaded(days) {
  for (const ws of wantedWeeks(days)) {
    const w = weekEntry(ws);
    if ((!w.cal || w.err) && !w.loading && !w.retry) loadWeek(ws);
  }
}
// Something the calendar shows changed (a host's sync, an org's days off, a Tenir
// capture), or the stream was down: re-read only the shown weeks and the ones
// either side. Every other week is dropped and read again when shown, so a frame
// costs the same however many weeks this tab has browsed. The shown weeks keep
// their copy on screen until the new one lands.
// The notes review's upcoming weeks are kept and re-read too, shown or not (XERK-2899).
function refetch() {
  const org = orgKeyOf();
  const keep = new Set(active ? wantedWeeks(visibleDays(anchor, mode())).map((ws) => `${org}|${ws}`) : []);
  if (upcomingWanted) for (const ws of upcomingWeeks()) keep.add(`${org}|${ws}`);
  for (const [k, w] of [...weeks]) {
    if (keep.has(k)) continue;
    clearTimeout(w.retry);
    weeks.delete(k);
  }
  for (const k of keep) loadWeek(Number(k.slice(org.length + 1)));
}
// The weeks the next UPCOMING_MS touch.
function upcomingWeeks() {
  const now = nowFn();
  return weeksOf([dayStart(now), dayStart(now + UPCOMING_MS)]);
}
// The upcoming calendar meetings of `site` (XERK-2899), earliest first, from the
// weeks already read; asks for those weeks when they are not. The notes review
// reads this on every paint; `onData` tells the page when a read lands.
function upcoming(site) {
  upcomingWanted = true;
  const now = nowFn();
  const byId = new Map();
  for (const ws of upcomingWeeks()) {
    const w = weekEntry(ws);
    if ((!w.cal || w.err) && !w.loading && !w.retry) loadWeek(ws);
    for (const ev of (w.cal && Array.isArray(w.cal.events) ? w.cal.events : [])) {
      if (!ev || typeof ev !== "object" || !num(ev.startMs) || ev.org !== site || !isUpcomingMeeting(ev, now)) continue;
      if (!byId.has(String(ev.id))) byId.set(String(ev.id), ev);   // one meeting on two hosts of a tenant
    }
  }
  return [...byId.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}
// "Open in calendar" from the notes review (XERK-2899): move to the week of
// `startMs` and open the event's panel once that week is read — the event by its
// id, or the one carrying the capture (`site` + `meetingId`: a linked Outlook
// event's `meetings`, or the capture's own Tenir-only entry).
function reveal(target) {
  if (!target || typeof target !== "object") return;
  const at = num(target.startMs) ? target.startMs : nowFn();
  revealing = { eventId: typeof target.eventId === "string" ? target.eventId : "",
    site: typeof target.site === "string" ? target.site : "",
    meetingId: typeof target.meetingId === "string" ? target.meetingId : "" };
  anchor = dayStart(at);
  picker = null;
  detail = null;
  detailFrom = null;
  if (active) paint(true);
}
function revealHit(ev) {
  const r = revealing;
  if (!r || !ev) return false;
  if (r.meetingId) {
    if (ev.source === "tenir") return ev.site === r.site && ev.meetingId === r.meetingId;
    if (Array.isArray(ev.meetings) && ev.meetings.some((x) => x && x.site === r.site && x.meetingId === r.meetingId)) return true;
  }
  return !!r.eventId && ev.source !== "tenir" && String(ev.id) === r.eventId;
}
// The events, holidays and host rows of the shown weeks, an event held by two weeks once.
function collect(days) {
  const evs = new Map(), hol = new Map();
  const hosts = new Map();
  let loading = false, err = "", truncated = false, have = true;
  for (const ws of weeksOf(days)) {
    const w = weekEntry(ws);
    if (w.loading) loading = true;
    if (w.err) err = w.err;
    if (!w.cal) { have = false; continue; }
    if (w.cal.truncated) truncated = true;
    for (const ev of w.cal.events) {
      if (!ev || typeof ev !== "object" || !num(ev.startMs) || !num(ev.endMs)) continue;
      evs.set(`${ev.host}\u0000${ev.id}`, ev);
    }
    for (const n of hostNotices(w.cal, ws)) if (!hosts.has(n.host) || n.syncing) hosts.set(n.host, n);
    for (const h of w.hol || []) if (h && typeof h.date === "string") hol.set(`${h.date}\u0000${h.id}`, h);
  }
  const list = [...evs.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return { events: list, holidays: [...hol.values()], notices: [...hosts.values()], loading, err, truncated, have };
}
// One line per host whose copy may be stale: offline, Outlook unreachable, or a
// week the hub has not read yet (it queued a sync when asked: `pending`).
function hostNotices(cal, ws) {
  const out = [];
  const from = ws, until = addDays(ws, 7);
  for (const h of (cal && Array.isArray(cal.hosts) ? cal.hosts : [])) {
    if (!h || typeof h !== "object") continue;
    const ranges = Array.isArray(h.ranges) ? h.ranges : [];
    const covered = ranges.some((r) => Array.isArray(r) && r[0] <= from && r[1] >= until);
    const n = { host: String(h.host || ""), device: String(h.device || h.host || ""), syncedAt: h.syncedAt,
      offline: h.online === false, error: typeof h.lastError === "string" ? h.lastError : "",
      syncing: h.online !== false && (h.pending === true || !covered), never: !covered };
    if (n.offline || n.error || n.syncing) out.push(n);
  }
  return out;
}
function noticeText(n, now) {
  const when = ago(n.syncedAt, now);
  // lastError is the hub's or Outlook's own words ("Outlook is not open", "the hub
  // kept N of M events…"), so it is quoted as is, never re-labelled.
  const err = n.error ? ` Last sync problem: ${n.error}` : "";
  if (n.offline) {
    return (n.never ? `${n.device} is offline and has not synced this week; its events may be missing.`
      : `${n.device} is offline — showing its calendar as last synced${when ? ` ${when}` : ""}.`) + err;
  }
  if (n.error) return `${n.device}: the calendar sync reported a problem — ${n.error}${when ? ` (last synced ${when})` : ""}.`;
  return `Syncing ${n.device}'s Outlook for this week…`;
}

// ---- render -------------------------------------------------------------------
const TENIR_SVG = `<svg class="cal-tenir" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6A1.5 1.5 0 0 1 12.5 11H7l-3 3v-3h-.5A1.5 1.5 0 0 1 2 9.5z"/><path fill="var(--surface)" d="M5 5h1v3H5zm2-1h1v5H7zm2 1.5h1v2H9zm2-.5h1v3h-1z"/></svg>`;
function ariaOf(ev, day) {
  const bits = [titleOf(ev)];
  bits.push(inBand(ev) ? `${fmtLongDay(day)}, all day` : `${fmtLongDay(ev.startMs)}, ${fmtSpan(ev.startMs, ev.endMs)}`);
  if (ev.location) bits.push(String(ev.location));
  bits.push(orgLabel(ev.org));
  if (ev.busy === "tentative" || ev.myResponse === "tentative") bits.push("tentative");
  else if (ev.myResponse === "notResponded") bits.push("not responded");
  else if (ev.busy === "free") bits.push("free");
  if (ev.myResponse === "declined") bits.push("declined");
  if (ev.source === "tenir") bits.push("captured by Tenir, not on Outlook");
  return bits.join(", ");
}
function evIndex(ev) {
  let i = shown.indexOf(ev);
  if (i < 0) { i = shown.length; shown.push(ev); }
  return i;
}
function evStyle(ev, colors) {
  const c = safeColor(ev.org ? colors.get(ev.org) : "");
  return c ? `--org:${c};` : "";
}
function timedHtml(seg, day, colors, now) {
  const ev = seg.ev;
  const top = (seg.top / 30) * SLOT_PX;
  const h = ((seg.bottom - seg.top) / 30) * SLOT_PX - 2;
  const left = (seg.col / seg.cols) * 100, width = (seg.span / seg.cols) * 100;
  const short = h < 34;
  const meta = [fmtSpan(ev.startMs, ev.endMs), ev.location ? String(ev.location) : ""].filter(Boolean).join(" · ");
  const cls = ["cal-ev", ...styleOf(ev, now), short ? "short" : ""].filter(Boolean).join(" ");
  return `<button type="button" class="${cls}" data-ev="${evIndex(ev)}" data-day="${day}" data-top="${seg.top}"`
    + ` style="${evStyle(ev, colors)}top:${top}px;height:${h}px;left:calc(${left}% + 1px);width:calc(${width}% - 4px)"`
    + ` aria-label="${esc(ariaOf(ev, day))}">`
    + `<span class="t">${ev.source === "tenir" ? TENIR_SVG : ""}${esc(titleOf(ev))}</span>`
    + (short ? "" : `<span class="m">${esc(meta)}</span>`) + `</button>`;
}
function bandHtml(day, events, holidays, colors, now) {
  const key = dayKey(day);
  const bits = [];
  for (const h of holidays) {
    if (h.date !== key) continue;
    bits.push(`<div class="cal-hol" title="${esc(h.name)}">${esc(h.name)}</div>`);
  }
  for (const ev of events) {
    if (!inBand(ev) || !onDay(ev, day)) continue;
    const cls = ["cal-ev", "allday", ...styleOf(ev, now)].join(" ");
    bits.push(`<button type="button" class="${cls}" data-ev="${evIndex(ev)}" data-day="${day}" data-top="-1"`
      + ` style="${evStyle(ev, colors)}" aria-label="${esc(ariaOf(ev, day))}">`
      + `<span class="t">${ev.source === "tenir" ? TENIR_SVG : ""}${esc(titleOf(ev))}</span></button>`);
  }
  return bits.join("");
}
// The orgs in view a holiday is a day off for (the header pick, else every org).
function offOrgs(day, holidays) {
  const key = dayKey(day);
  const keys = orgKeys();
  const out = new Set();
  for (const h of holidays) {
    if (h.date !== key || !Array.isArray(h.offFor)) continue;
    for (const s of h.offFor) if (typeof s === "string" && (!keys.length || keys.includes(s))) out.add(s);
  }
  return [...out];
}
function pickerHtml(days, now) {
  const m0 = new Date(picker);
  const y = m0.getFullYear(), mo = m0.getMonth();
  const first = weekStart(new Date(y, mo, 1).getTime());
  const vis = new Set(days.map(dayKey));
  const today = dayKey(now);
  const title = m0.toLocaleDateString([], { month: "long", year: "numeric" });
  const wd = Array.from({ length: 7 }, (_, i) => new Date(addDays(first, i)).toLocaleDateString([], { weekday: "narrow" }));
  let cells = "";
  for (let i = 0; i < 42; i++) {
    const d = addDays(first, i);
    const dt = new Date(d);
    if (i === 35 && dt.getMonth() !== mo) break;
    const cls = ["cal-pd", dt.getMonth() !== mo ? "out" : "", vis.has(dayKey(d)) ? "in" : "", dayKey(d) === today ? "today" : ""]
      .filter(Boolean).join(" ");
    cells += `<button type="button" class="${cls}" data-pick="${d}" aria-label="${esc(fmtLongDay(d))}${vis.has(dayKey(d)) ? ", shown" : ""}">${dt.getDate()}</button>`;
  }
  return `<div class="cal-picker" role="dialog" aria-label="Pick a date">`
    + `<div class="cal-picker-head"><button type="button" class="cal-ic" data-pmonth="-12" aria-label="Previous year">«</button>`
    + `<button type="button" class="cal-ic" data-pmonth="-1" aria-label="Previous month">‹</button>`
    + `<span class="cal-picker-title" aria-live="polite">${esc(title)}</span>`
    + `<button type="button" class="cal-ic" data-pmonth="1" aria-label="Next month">›</button>`
    + `<button type="button" class="cal-ic" data-pmonth="12" aria-label="Next year">»</button></div>`
    + `<div class="cal-picker-grid">${wd.map((w) => `<span class="cal-pw" aria-hidden="true">${esc(w)}</span>`).join("")}${cells}</div></div>`;
}
function detailHtml(ev, now) {
  const rows = [];
  const row = (k, v) => { if (v) rows.push(`<div class="cal-drow"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`); };
  row("When", inBand(ev) ? `${fmtLongDay(ev.startMs)}, all day` : `${fmtLongDay(ev.startMs)}, ${fmtSpan(ev.startMs, ev.endMs)}`);
  row("Org", orgLabel(ev.org));
  row("Where", ev.location ? String(ev.location) : "");
  row("Organizer", ev.organizer ? String(ev.organizer) : "");
  row("Calendar", ev.source === "tenir" ? "Captured by Tenir — not on Outlook" : (ev.host ? (typeof TurmaBoard !== "undefined" && TurmaBoard.hostName ? TurmaBoard.hostName(ev.host) : String(ev.host)) : ""));
  const join = safeHttps(ev.joinUrl);
  const state = styleOf(ev, now).filter((c) => ["canceled", "tentative", "free"].includes(c));
  const notes = openNotes && notesTarget(ev, now)
    ? `<div class="cal-drow"><button type="button" class="btn-sm" data-open-notes>Open in notes review</button></div>` : "";
  return `<aside class="cal-detail" role="dialog" aria-modal="false" aria-labelledby="calDetailTitle" tabindex="-1">`
    + `<div class="cal-detail-head"><h2 id="calDetailTitle">${esc(titleOf(ev))}</h2>`
    + `<button type="button" class="cal-ic" data-close-detail aria-label="Close">✕</button></div>`
    + (state.length ? `<div class="cal-dstate">${esc(state.join(" · "))}</div>` : "")
    + rows.join("")
    + (join ? `<div class="cal-drow"><a href="${esc(join)}" target="_blank" rel="noopener noreferrer">Join meeting</a></div>` : "")
    + notes
    + `<p class="cal-dnote">Meeting details, notes and proposals open here soon.</p></aside>`;
}
function headerHtml(days) {
  const m = mode();
  const opts = narrow ? [["day", "Day"], ["three", "3 days"]] : [["work", "Work week"], ["week", "Week"]];
  const unit = m === "work" || m === "week" ? "week" : m === "three" ? "3 days" : "day";
  return `<div class="cal-bar">`
    + `<button type="button" data-cal-today>Today</button>`
    + `<button type="button" class="cal-ic" data-step="-1" aria-label="Previous ${unit}">‹</button>`
    + `<button type="button" class="cal-ic" data-step="1" aria-label="Next ${unit}">›</button>`
    + `<span class="cal-range-wrap"><button type="button" class="cal-range" data-open-picker aria-haspopup="dialog" aria-expanded="${picker !== null}">`
    + `${esc(rangeLabel(days))} <span class="car" aria-hidden="true">▾</span></button>`
    + (picker !== null ? pickerHtml(days, nowFn()) : "") + `</span>`
    + `<span class="sp"></span><span class="cal-modes" role="group" aria-label="View">`
    + opts.map(([k, l]) => `<button type="button" class="tri-chip${k === m ? " on" : ""}" data-mode="${k}" aria-pressed="${k === m}">${l}</button>`).join("")
    + `</span></div>`;
}
function calendarHtml() {
  const now = nowFn();
  const days = visibleDays(anchor, mode());
  ensureLoaded(days);
  const got = collect(days);
  if (revealing) {
    // A capture's own entry outranks an event that only shares its id.
    const hit = got.events.find((e) => revealing.meetingId && revealHit(e) && e.source === "tenir")
      || got.events.find(revealHit);
    if (hit) {
      detail = hit;
      const day = dayStart(hit.startMs);
      detailFrom = { ev: `${hit.host}\u0000${hit.id}`, day: String(day) };
      if (!inBand(hit)) scrollToMin = wallMinutes(hit.startMs, day);
      revealing = null;
      revealFocus = true;
    } else if (got.have && !got.loading) revealing = null;    // read, and not there: stay on its week
  }
  const colors = colorMap();
  shown = [];
  const today = dayKey(now);
  const notes = [];
  if (got.err) notes.push(`<div class="cal-note bad">${esc(got.err)}</div>`);
  for (const n of got.notices) notes.push(`<div class="cal-note${n.syncing && !n.offline && !n.error ? "" : " warn"}">${esc(noticeText(n, now))}</div>`);
  if (got.truncated) notes.push(`<div class="cal-note warn">This range holds more events than the hub serves at once; some are not shown.</div>`);
  if (!got.have && got.loading) notes.push(`<div class="cal-note">Loading the calendar…</div>`);
  const cols = `grid-template-columns: ${narrow ? 44 : 56}px repeat(${days.length}, minmax(0, 1fr))`;
  const heads = days.map((d) => {
    const dt = new Date(d);
    const off = offOrgs(d, got.holidays);
    const wd = dt.toLocaleDateString([], { weekday: narrow && days.length > 1 ? "short" : "long" });
    return `<div class="cal-dh${dayKey(d) === today ? " today" : ""}${off.length ? " off" : ""}"${dayKey(d) === today ? ' aria-current="date"' : ""}>`
      + `<span class="n">${dt.getDate()}</span><span class="w">${esc(wd)}</span>`
      + (off.length ? `<span class="offnote" title="${esc(`Day off: ${off.map(orgLabel).join(", ")}`)}">Day off${orgKeys().length === 1 ? "" : ` · ${esc(off.map(orgLabel).join(", "))}`}</span>` : "")
      + `</div>`;
  }).join("");
  const band = days.map((d) => `<div class="cal-band-day${offOrgs(d, got.holidays).length ? " off" : ""}">${bandHtml(d, got.events, got.holidays, colors, now)}</div>`).join("");
  const hours = Array.from({ length: 24 }, (_, h) => `<div class="cal-hr" style="top:${h * HOUR_PX}px">${h ? esc(new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" })) : ""}</div>`).join("");
  const body = days.map((d) => {
    const isToday = dayKey(d) === today;
    const segs = daySegments(got.events, d);
    const nowLine = isToday ? `<div class="cal-now" style="top:${(wallMinutes(now, d) / 30) * SLOT_PX}px" aria-hidden="true"></div>` : "";
    return `<div class="cal-col${isToday ? " today" : ""}${offOrgs(d, got.holidays).length ? " off" : ""}" data-col="${d}">`
      + segs.map((s) => timedHtml(s, d, colors, now)).join("") + nowLine + `</div>`;
  }).join("");
  const label = `Calendar, ${rangeLabel(days)}`;
  return headerHtml(days)
    + (notes.length ? `<div class="cal-notes" aria-live="polite">${notes.join("")}</div>` : "")
    + `<div class="cal-grid" role="region" aria-label="${esc(label)}">`
    + `<div class="cal-row cal-heads" style="${cols}"><div></div>${heads}</div>`
    + `<div class="cal-row cal-band" style="${cols}"><div class="cal-band-lbl">All day</div>${band}</div>`
    + `<div class="cal-scroll" id="calScroll"><div class="cal-row cal-body" style="${cols};height:${DAY_PX}px">`
    + `<div class="cal-gutter">${hours}</div>${body}</div></div></div>`
    + (detail ? detailHtml(detail, now) : "");
}

// Focus survives a repaint by its event + day (the button is a new node).
function focusSig() {
  const a = typeof document !== "undefined" ? document.activeElement : null;
  if (!a || !$root || !$root.contains || !$root.contains(a)) return null;
  const d = a.dataset || {};
  if (d.ev !== undefined) { const ev = shown[Number(d.ev)]; return ev ? { ev: `${ev.host}\u0000${ev.id}`, day: d.day } : null; }
  for (const k of ["step", "mode", "pick", "pmonth"]) if (d[k] !== undefined) return { sel: `[data-${k}="${d[k]}"]` };
  for (const k of ["calToday", "openPicker", "closeDetail"]) if (d[k] !== undefined) return { sel: `[data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]` };
  return null;
}
function restoreFocusSig(sig) {
  if (!sig || !$root || !$root.querySelector) return;
  let el = null;
  if (sig.ev) {
    const i = shown.findIndex((e) => `${e.host}\u0000${e.id}` === sig.ev);
    if (i >= 0) el = $root.querySelector(`[data-ev="${i}"][data-day="${sig.day}"]`) || $root.querySelector(`[data-ev="${i}"]`);
  } else el = $root.querySelector(sig.sel);
  if (el && el.focus) el.focus({ preventScroll: true });
}
let lastHtml = "";
function paint(force = false) {
  if (!$root || !active) return;
  const html = calendarHtml();
  if (!force && html === lastHtml) return;
  lastHtml = html;
  const sig = focusSig();
  const T = typeof TurmaNav !== "undefined" && TurmaNav.preserveScroll ? TurmaNav : null;
  const put = () => { $root.innerHTML = html; };
  if (T) T.preserveScroll($root, put); else put();
  restoreFocusSig(sig);
  const sc = $root.querySelector && $root.querySelector("#calScroll");
  if (sc && scrollToMin >= 0) { sc.scrollTop = Math.max(0, (scrollToMin / 30) * SLOT_PX - HOUR_PX); scrolled = true; }
  else if (sc && !scrolled) { sc.scrollTop = WORK_FROM_H * HOUR_PX - 12; scrolled = true; }  // 8 AM label in view
  scrollToMin = -1;
  if (revealFocus) { revealFocus = false; focusQ(".cal-detail"); }
}

// Arrow keys walk between events: ↑/↓ within a day (all-day band first), ←/→ to
// the nearest event of the neighbouring day. Esc closes the picker / detail.
function evButtons() {
  return $root && $root.querySelectorAll ? [...$root.querySelectorAll(".cal-ev[data-ev]")] : [];
}
function neighbour(btn, key) {
  const all = evButtons();
  const day = Number(btn.dataset.day), top = Number(btn.dataset.top);
  const byDay = (d) => all.filter((b) => Number(b.dataset.day) === d)
    .sort((a, b) => Number(a.dataset.top) - Number(b.dataset.top));
  if (key === "ArrowUp" || key === "ArrowDown") {
    const list = byDay(day);
    const i = list.indexOf(btn);
    return list[i + (key === "ArrowDown" ? 1 : -1)] || null;
  }
  const days = [...new Set(all.map((b) => Number(b.dataset.day)))].sort((a, b) => a - b);
  const pool = key === "ArrowRight" ? days.filter((d) => d > day) : days.filter((d) => d < day).reverse();
  for (const d of pool) {
    const list = byDay(d);
    if (list.length) return list.reduce((best, b) => (Math.abs(Number(b.dataset.top) - top) < Math.abs(Number(best.dataset.top) - top) ? b : best));
  }
  return null;
}
function onKey(ev) {
  if (!active || !ev || ev.defaultPrevented) return;
  if (ev.key === "Escape") {
    // A menu or modal that took the Esc marks it handled (org.js, newticket.js, which
    // listen before us); a SHOWN modal (backdrop not hidden) owns it regardless.
    // The New-ticket panel stays in the DOM while hidden, so presence alone is no test.
    if (typeof document !== "undefined" && document.querySelector && document.querySelector(MODAL_OPEN)) return;
    if (picker !== null) { picker = null; paint(true); focusQ("[data-open-picker]"); ev.preventDefault(); return; }
    if (detail) { closeDetail(); ev.preventDefault(); return; }
    return;
  }
  const t = ev.target;
  if (!t || !t.dataset || t.dataset.ev === undefined || ev.altKey || ev.ctrlKey || ev.metaKey) return;
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.key)) return;
  const n = neighbour(t, ev.key);
  ev.preventDefault();
  if (n && n.focus) { n.focus(); if (n.scrollIntoView) n.scrollIntoView({ block: "nearest" }); }
}
function focusQ(sel) {
  const el = $root && $root.querySelector && $root.querySelector(sel);
  if (!el || !el.focus) return false;
  el.focus();
  return true;
}
let detailFrom = null;
function closeDetail() {
  const back = detailFrom;
  detail = null;
  detailFrom = null;
  paint(true);
  if (back) restoreFocusSig(back);
}
function go(ms) { anchor = dayStart(ms); paint(true); }

function mount(el, opts = {}) {
  if ($root) return;
  $root = el;
  if (opts && typeof opts.now === "function") nowFn = opts.now;
  if (opts && typeof opts.onData === "function") onData = opts.onData;
  if (opts && typeof opts.openNotes === "function") openNotes = opts.openNotes;
  const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(`(max-width: ${NARROW_PX - 1}px)`) : null;
  narrow = !!(mq && mq.matches);
  if (mq && mq.addEventListener) mq.addEventListener("change", (e) => { narrow = !!e.matches; paint(true); });
  $root.addEventListener("click", (ev) => {
    const b = ev.target && ev.target.closest
      ? ev.target.closest("[data-ev],[data-step],[data-mode],[data-cal-today],[data-open-picker],[data-pick],[data-pmonth],[data-close-detail],[data-open-notes]") : null;
    if (!b) {
      if (picker !== null && !(ev.target && ev.target.closest && ev.target.closest(".cal-picker"))) { picker = null; paint(true); }
      return;
    }
    const d = b.dataset;
    if (d.ev !== undefined) {
      const e = shown[Number(d.ev)];
      if (!e) return;
      detailFrom = { ev: `${e.host}\u0000${e.id}`, day: d.day };
      detail = e;
      picker = null;
      paint(true);
      focusQ(".cal-detail");
      return;
    }
    if (d.closeDetail !== undefined) return void closeDetail();
    if (d.openNotes !== undefined) {
      const t = notesTarget(detail, nowFn());
      if (t && openNotes) openNotes(t);
      return;
    }
    if (d.step !== undefined) return void go(stepAnchor(anchor, mode(), Number(d.step) < 0 ? -1 : 1));
    if (d.calToday !== undefined) return void go(nowFn());
    if (d.mode !== undefined) { setMode(d.mode); return void paint(true); }
    if (d.openPicker !== undefined) {
      picker = picker === null ? new Date(new Date(anchor).getFullYear(), new Date(anchor).getMonth(), 1).getTime() : null;
      paint(true);
      if (picker !== null) focusQ(".cal-pd.in") || focusQ(".cal-pd");
      return;
    }
    if (d.pmonth !== undefined) {
      const m = new Date(picker);
      picker = new Date(m.getFullYear(), m.getMonth() + Number(d.pmonth), 1).getTime();
      return void paint(true);
    }
    if (d.pick !== undefined) { picker = null; go(Number(d.pick)); focusQ("[data-open-picker]"); }
  });
  // On the document, so Esc closes the picker / panel after a click elsewhere;
  // arrows act only on a focused event button (onKey checks the target).
  (typeof document !== "undefined" && document.addEventListener ? document : $root).addEventListener("keydown", onKey);
  // Swipe left/right on the grid moves like › / ‹ (the narrow layout's arrows).
  let touch = null;
  $root.addEventListener("touchstart", (ev) => {
    const p = ev.touches && ev.touches[0];
    touch = p && ev.target && ev.target.closest && ev.target.closest(".cal-grid") ? { x: p.clientX, y: p.clientY } : null;
  }, { passive: true });
  $root.addEventListener("touchend", (ev) => {
    const p = ev.changedTouches && ev.changedTouches[0];
    if (!touch || !p) return;
    const dx = p.clientX - touch.x, dy = p.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) go(stepAnchor(anchor, mode(), dx < 0 ? 1 : -1));
  }, { passive: true });
  // The current-time line and "past" dimming move with the clock.
  const tick = setInterval(() => { if (active) paint(); }, 60000);
  if (tick && tick.unref) tick.unref();
}
function update(snapshot) { data = snapshot; if (active) paint(); }
function setActive(on) {
  active = !!on;
  if (!active) return;
  // Shown again: a failed week is asked at once, not when its back-off ends.
  for (const w of weeks.values()) if (w.err && w.retry) { clearTimeout(w.retry); w.retry = 0; }
  lastHtml = "";
  paint(true);
}

const api = {
  mount, update, setActive, refetch, upcoming, reveal,
  // pure helpers, for tests
  dayStart, addDays, weekStart, dayKey, parseDayKey, visibleDays, stepAnchor, weeksOf, rangeLabel,
  wallMinutes, layoutDay, daySegments, styleOf, titleOf, inBand, onDay, offOrgs, hostNotices, noticeText,
  calendarHtml, safeHttps, isUpcomingMeeting, notesTarget, UPCOMING_MS,
  _state: () => ({ anchor, mode: mode(), weeks, detail, picker }),
  _go: go,
  _setHooks: (o) => { if (o.onData) onData = o.onData; if (o.openNotes) openNotes = o.openNotes; },
};
if (typeof window !== "undefined") window.TurmaCalendar = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
