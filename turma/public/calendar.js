// The Meetings page's Calendar view (XERK-2897, epic XERK-2890): a read-only,
// Microsoft Teams-style week of every org's Outlook events (GET /api/calendar),
// Tenir's impromptu captures, and holidays (GET /api/holidays). Each event is
// tinted with its org's color (board.js orgColorMap + the hub's orgColors pins).
//
// A shared module like meetings.js: brief.html mounts it, hands it the fleet
// snapshot (update) and tells it when the hub's `calendar` / `holidaySettings`
// SSE frames land (refetch). It reads the calendar routes itself — the events
// are too big for the snapshot (contract-calendar.md). Outlook events are
// read-only. A click opens the event's detail panel (XERK-2898): Outlook's
// details, and a linked Tenir capture's summary + proposals, reviewed in place by
// meetings.js (TurmaMeetings.showPanel), which this module never forks. The
// writes here: relinking a capture to another event, and creating / editing /
// deleting Turma's own events in one or many orgs (XERK-2971, the editor below).
// Rules + the Teams decisions: .claude/rules/turma-meetings.md.
// Loaded after org.js; in server.js's HASHED_ASSETS. Tests: tests/calendar.test.js.
(() => {
const DAY_MS = 86400000;
const SLOT_PX = 24;                 // one 30-minute row where the browser cannot size it (no cqh)
// A length of `n` 30-minute rows. The zoom (XERK-2954) is how many hours fill the
// pane: brief.html sizes `--slot` from `--hours` and the pane's height. Scroll
// math reads the rendered row height back (pxPerMin), never assumes SLOT_PX.
const slots = (n, minus = 0) => `calc(var(--slot, ${SLOT_PX}px) * ${n}${minus ? ` - ${minus}px` : ""})`;
const OPEN_AT_H = 8;  // the grid opens with 8:00 at the top, an hour above the 9–17 shaded working hours (brief.html .cal-col)
// The zoom steps, as hours the pane shows; the default fits 8 AM - 6 PM (XERK-2954).
const ZOOMS = [24, 16, 12, 10, 8, 6, 4];
const ZOOM_DEFAULT = 10;
const ZOOM_KEY = "turma-calendar-zoom";
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
// The Sunday of `ms`'s week: the week runs Sunday–Saturday (XERK-2940); Work week is its Monday–Friday.
function weekStart(ms) { const d = new Date(dayStart(ms)); return addDays(d.getTime(), -d.getDay()); }
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
  const first = mode === "work" ? addDays(weekStart(anchor), 1) : mode === "week" ? weekStart(anchor) : dayStart(anchor);
  const n = MODES[mode] || 5;
  return Array.from({ length: n }, (_, i) => addDays(first, i));
}
// ‹ › move a week in the week modes, else by what is shown.
function stepAnchor(anchor, mode, dir) {
  return addDays(anchor, dir * (mode === "work" || mode === "week" ? 7 : (MODES[mode] || 1)));
}
// The weeks (Sunday ms) a set of days touches: what is fetched.
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
// UTC offset of local wall time at ms, in minutes (changes across a DST switch).
const offsetAt = (ms) => -new Date(ms).getTimezoneOffset();
function fmtSpan(s, e) {
  // A span across a DST switch (the repeated fall-back hour) names each end's zone,
  // so "1:30 – 1:00 AM" reads "1:30 AM EDT – 1:00 AM EST".
  if (e > s && offsetAt(s) !== offsetAt(e)) {
    try {
      const z = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
      return `${z.format(s)} – ${z.format(e)}`;
    } catch { /* fall through */ }
  }
  try {
    const f = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
    if (typeof f.formatRange === "function" && e > s && dayStart(s) === dayStart(e)) return f.formatRange(s, e);
  } catch { /* fall through */ }
  return e > s ? `${fmtTime(s)} – ${fmtTime(e)}` : fmtTime(s);
}
const fmtLongDay = (ms) => new Date(ms).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
// "Monday, November 9, 9:00 – 9:30 AM"; an end on another day names its date (XERK-2933).
function fmtLongSpan(s, e) {
  if (e > s && dayStart(s) !== dayStart(e)) return `${fmtLongDay(s)}, ${fmtTime(s)} – ${fmtLongDay(e)}, ${fmtTime(e)}`;
  return `${fmtLongDay(s)}, ${fmtSpan(s, e)}`;
}
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
  if (ev.source === "turma") c.push("turma");
  if (evOrgs(ev).length > 1) c.push("multi");
  return c;
}
// A meeting the notes review lists as upcoming (XERK-2899): an Outlook event that is
// a timed, live meeting of an org — not a holiday-like all-day block, a canceled or
// declined one, a free / out-of-office / working-elsewhere block, or one already captured.
// Only a REAL meeting, as the hub's matcher reads it: every event now has an org (XERK-2936),
// so Focus time and Lunch would otherwise list. The hub's `meeting` flag decides — it is
// judged before a private event's attendees and link are withheld; an older hub sends none.
const NOT_MEETING_BUSY = new Set(["free", "outOfOffice", "workingElsewhere"]);
function isRealMeeting(ev) {
  if (typeof ev.meeting === "boolean") return ev.meeting;
  return (Array.isArray(ev.attendees) && ev.attendees.some((p) => p && p.role !== "organizer" && p.role !== "resource"))
    || !!ev.joinUrl || ev.isOnlineMeeting === true;
}
function isUpcomingMeeting(ev, now) {
  return !!ev && ev.source !== "tenir" && typeof ev.org === "string" && !!ev.org && !inBand(ev)
    && isRealMeeting(ev)
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
// The orgs an event belongs to: a Turma event's served `orgs` (XERK-2971), else its one `org`.
function evOrgs(ev) {
  if (ev && ev.source === "turma" && Array.isArray(ev.orgs)) {
    const out = ev.orgs.filter((o) => typeof o === "string" && o);
    if (out.length) return [...new Set(out)];
  }
  return ev && typeof ev.org === "string" && ev.org ? [ev.org] : [];
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
    let end = ev.endMs > ev.startMs ? wallMinutes(ev.endMs, day) : top;
    // The grid is wall-clock, so an end in the SECOND pass of the repeated fall-back hour
    // reads an hour early (1:30 EDT – 1:30 EST is zero long): push it down by the hour the
    // clock repeated. An end past the repeated hour (9:00 EST) already sits on its row.
    const from = Math.max(ev.startMs, day);
    const back = offsetAt(from) - offsetAt(ev.endMs);
    if (ev.endMs > from && ev.endMs < addDays(day, 1) && back > 0
      && offsetAt(ev.endMs - back * 60000) !== offsetAt(ev.endMs)) {
      end = Math.min(1440, end + back);
    }
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
let detail = null;                // the event whose detail panel is open
let lastGot = null;               // collect() of the last paint: the relink candidates
let $grid = null, $side = null, $info = null, $mt = null;
let descOpen = false;             // the open event's description is expanded
let attOpen = false;              // the open event's attendee list is expanded (collapsed by default, XERK-2942)
let panelHas = false;             // meetings.js painted the capture into the panel
const linkBusy = new Set();       // capture keys with a relink POST in flight
const linkErr = new Map();        // capture key -> the hub's refusal
const linkPick = new Map();       // capture key -> the picked event's key
let hostSetOpen = false;          // the per-host calendar settings are shown (XERK-2929)
const setBusy = new Set();        // host keys with a settings POST in flight
const setErr = new Map();         // host key -> the hub's refusal
let sidePress = false, sidePending = false;
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
let zoomHours = ((z) => (ZOOMS.includes(z) ? z : ZOOM_DEFAULT))(loadStore(ZOOM_KEY, ZOOM_DEFAULT));
let zoomAnchor = -1;              // the wall minute held at the pane's middle across a zoom
// Rendered px per minute: the body is 24h tall. A fake scroller (tests) has no height.
const pxPerMin = (sc) => (sc.scrollHeight > 0 ? sc.scrollHeight / 1440 : SLOT_PX / 30);
// 8:00 at the top, its label clear of the edge (in minutes, so a pane resize keeps it).
const openMin = (sc) => Math.max(0, OPEN_AT_H * 60 - 8 / pxPerMin(sc));
// The rows follow the pane's height, so a height change (the loading notice going, a
// host notice, a window resize) would slide the view to another time: the wall minute
// at the pane's top is held instead (QA XERK-2954). The operator's scroll moves it.
let topMin = -1;
let paneSig = "";
// The scrollTop holdTop last wrote: its scroll event can arrive after the pane has
// grown (the notice gone), and read as the operator's it moved the view (QA).
let wroteTop = -1;
function holdTop(sc, min) {
  if (min !== undefined) topMin = min;
  const sig = `${sc.clientHeight}|${sc.scrollHeight}`;
  if (min === undefined && sig === paneSig) return;
  paneSig = sig;
  if (topMin < 0) return;
  const was = sc.scrollTop;
  sc.scrollTop = Math.max(0, topMin * pxPerMin(sc));
  // Only a write that moved the pane sends an event; arming for one that did not would
  // swallow the operator's next scroll to that pixel.
  if (Math.abs(sc.scrollTop - was) >= 1) wroteTop = sc.scrollTop;
}
function zoom(dir) {
  const i = ZOOMS.indexOf(zoomHours) + (dir > 0 ? 1 : -1);
  if (i < 0 || i >= ZOOMS.length) return;
  const sc = $grid && $grid.querySelector && $grid.querySelector("#calScroll");
  if (sc && sc.clientHeight) zoomAnchor = (sc.scrollTop + sc.clientHeight / 2) / pxPerMin(sc);
  zoomHours = ZOOMS[i];
  saveStore(ZOOM_KEY, zoomHours);
  paint();
}

const wideMode = () => (modes && (modes.wide === "week" || modes.wide === "work") ? modes.wide : "work");
const narrowMode = () => (modes && (modes.narrow === "three" || modes.narrow === "day") ? modes.narrow : "day");
// A weekend meeting revealed from the notes review shows the full Week (XERK-2899 QA:
// Work week drew a panel for an event not on the grid). Not saved: a mode pick ends it.
let revealWeek = false;
const mode = () => (narrow ? narrowMode() : (revealWeek ? "week" : wideMode()));
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
// Read one week (Sunday–Saturday) of events + holidays. A read already in flight
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
      if (!ev || typeof ev !== "object" || !num(ev.startMs) || !evOrgs(ev).includes(site) || !isUpcomingMeeting(ev, now)) continue;
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
  const wd = new Date(at).getDay();
  revealWeek = !narrow && wideMode() === "work" && (wd === 0 || wd === 6);   // a weekday reveal ends it
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
  const hosts = new Map(), hostRows = new Map();
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
    for (const h of (Array.isArray(w.cal.hosts) ? w.cal.hosts : [])) {
      if (h && typeof h.host === "string") hostRows.set(h.host, h);
    }
    for (const h of w.hol || []) if (h && typeof h.date === "string") hol.set(`${h.date}\u0000${h.id}`, h);
  }
  const list = [...evs.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return { events: list, holidays: [...hol.values()], notices: [...hosts.values()], hostRows, loading, err, truncated, have };
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
// The recurring glyph (Outlook's circling arrows), on every repeating event's block and panel:
// an Outlook occurrence and a Turma series alike (XERK-2973).
const RECUR_SVG = `<svg class="cal-recur" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M12.6 6.2A5 5 0 0 0 3.3 5.6M3.4 9.8a5 5 0 0 0 9.3.6"/><path fill="currentColor" d="M2.2 2.8v4h4zM13.8 13.2v-4h-4z"/></svg>`;
const recurHtml = (ev) => (ev && ev.recurring === true ? RECUR_SVG : "");
// Each org's Outlook copy of a Turma event (XERK-2987): [{org, state, text}], state
// written|pending|failed|nohost. null = an older hub serving no `outlook`: the panel reads as before.
function outlookStates(ev) {
  const ol = ev && ev.source === "turma" ? ev.outlook : null;
  if (!ol || typeof ol !== "object" || Array.isArray(ol)) return null;
  return evOrgs(ev).map((org) => {
    const o = Object.prototype.hasOwnProperty.call(ol, org) && ol[org] && typeof ol[org] === "object" ? ol[org] : {};
    let state = o.state === "written" || o.state === "failed" ? o.state : "pending";
    if (state === "pending" && o.noHost === true) state = "nohost";
    const err = typeof o.error === "string" ? o.error.trim() : "";
    const text = state === "written" ? (Number.isFinite(o.recreatedAt) && o.recreatedAt > 0 ? "In Outlook (re-created after it was deleted there)" : "In Outlook")
      : state === "failed" ? `Failed: ${err || "Outlook gave no reason"}`
      : state === "nohost" ? "No Outlook host for this org" : "Writing…";
    return { org, state, text };
  });
}
// The block's mark: a failed copy outranks one still being written; no host marks nothing
// (it waits for a writer that may never come, and would mark every event of such an org).
function outlookMark(ev) {
  const s = outlookStates(ev);
  if (!s) return "";
  return s.some((x) => x.state === "failed") ? "failed" : s.some((x) => x.state === "pending") ? "pending" : "";
}
const OUTLOOK_MARK = { failed: "!", pending: "…" };
const outlookMarkHtml = (ev) => {
  const m = outlookMark(ev);
  return m ? `<span class="cal-olk ${m}" aria-hidden="true" title="${m === "failed" ? "An Outlook copy failed" : "Writing to Outlook"}">${OUTLOOK_MARK[m]}</span>` : "";
};
function ariaOf(ev, day) {
  const bits = [titleOf(ev)];
  // A timed event of 24h+ sits in the all-day band but keeps its times (XERK-2934).
  bits.push(ev.allDay === true ? `${fmtLongDay(day)}, all day` : fmtLongSpan(ev.startMs, ev.endMs));
  if (ev.location) bits.push(String(ev.location));
  const orgs = evOrgs(ev);
  bits.push(orgs.length > 1 ? `orgs ${orgs.map(orgLabel).join(", ")}` : orgLabel(ev.org));
  if (ev.busy === "tentative" || ev.myResponse === "tentative") bits.push("tentative");
  else if (ev.myResponse === "notResponded") bits.push("not responded");
  else if (ev.busy === "free") bits.push("free");
  if (ev.myResponse === "declined") bits.push("declined");
  if (ev.source === "tenir") bits.push("captured by Tenir, not on Outlook");
  if (ev.source === "turma") bits.push("Turma event");
  const olk = outlookMark(ev);
  if (olk) bits.push(olk === "failed" ? "an Outlook copy failed" : "writing to Outlook");
  if (ev.recurring === true) bits.push("repeats");
  return bits.join(", ");
}
// A capture's review state on its event block (XERK-2898): proposals still
// waiting, or the captions still being read. meetings.js reads the snapshot's
// rows; a Tenir-only entry the snapshot no longer carries falls back to its own status.
function capturesOf(ev) {
  if (ev.source === "tenir") return typeof ev.site === "string" && typeof ev.meetingId === "string" ? [{ site: ev.site, meetingId: ev.meetingId }] : [];
  return (Array.isArray(ev.meetings) ? ev.meetings : [])
    .filter((c) => c && typeof c.site === "string" && typeof c.meetingId === "string");
}
function badgeOf(ev) {
  const M = typeof TurmaMeetings !== "undefined" && TurmaMeetings.meetingState ? TurmaMeetings : null;
  let pending = 0, reading = false;
  for (const c of capturesOf(ev)) {
    const st = M && data ? M.meetingState(data, c.site, c.meetingId) : null;
    if (st) { pending += st.pending; reading = reading || st.reading; }
    else if (ev.source === "tenir") reading = reading || ev.status === "queued" || ev.status === "running";
  }
  return { pending, reading };
}
const LIST_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M2 3h2v2H2zm4 .25h8v1.5H6zM2 7h2v2H2zm4 .25h8v1.5H6zM2 11h2v2H2zm4 .25h8v1.5H6z"/></svg>`;
function badgeHtml(b) {
  if (b.pending) return `<span class="cal-badge" aria-hidden="true">${LIST_SVG}${b.pending}</span>`;
  if (b.reading) return `<span class="cal-badge reading" aria-hidden="true"><span class="cal-spin"></span></span>`;
  return "";
}
function badgeAria(b) {
  if (b.pending) return `${b.pending} proposal${b.pending === 1 ? "" : "s"} to review`;
  return b.reading ? "the meeting is being read" : "";
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
// A Turma event in several orgs (XERK-2971): its left bar is split into each org's
// color, top to bottom, in its orgs' order. Only palette slots are inlined (safeColor).
function orgBarHtml(ev, colors) {
  const orgs = evOrgs(ev);
  if (orgs.length < 2) return "";
  const cs = orgs.map((o) => safeColor(colors.get(o)) || "var(--muted)");
  const stops = cs.map((c, i) => `${c} ${((i / cs.length) * 100).toFixed(2)}% ${(((i + 1) / cs.length) * 100).toFixed(2)}%`).join(",");
  return `<span class="cal-orgbar" aria-hidden="true" style="background:linear-gradient(to bottom,${stops})"></span>`;
}
function timedHtml(seg, day, colors, now) {
  const ev = seg.ev;
  const left = (seg.col / seg.cols) * 100, width = (seg.span / seg.cols) * 100;
  // Whether the time line fits is the block's DRAWN height, not this one: a tall
  // pane stretches the rows, so brief.html decides it with a container query.
  const meta = [fmtSpan(ev.startMs, ev.endMs), ev.location ? String(ev.location) : ""].filter(Boolean).join(" · ");
  const cls = ["cal-ev", ...styleOf(ev, now)].filter(Boolean).join(" ");
  const b = badgeOf(ev);
  return `<button type="button" class="${cls}" data-ev="${evIndex(ev)}" data-day="${day}" data-top="${seg.top}"`
    + ` style="${evStyle(ev, colors)}top:${slots(seg.top / 30)};height:${slots((seg.bottom - seg.top) / 30, 2)};left:calc(${left}% + 1px);width:calc(${width}% - 4px)"`
    + ` aria-label="${esc([ariaOf(ev, day), badgeAria(b)].filter(Boolean).join(", "))}">`
    + orgBarHtml(ev, colors) + `<span class="cal-evb"><span class="t">${ev.source === "tenir" ? TENIR_SVG : ""}<span class="tx">${esc(titleOf(ev))}</span>${recurHtml(ev)}${outlookMarkHtml(ev)}${badgeHtml(b)}</span>`
    + `<span class="m">${esc(meta)}</span></span></button>`;
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
    const b = badgeOf(ev);
    bits.push(`<button type="button" class="${cls}" data-ev="${evIndex(ev)}" data-day="${day}" data-top="-1"`
      + ` style="${evStyle(ev, colors)}" aria-label="${esc([ariaOf(ev, day), badgeAria(b)].filter(Boolean).join(", "))}">`
      + orgBarHtml(ev, colors) + `<span class="t">${ev.source === "tenir" ? TENIR_SVG : ""}<span class="tx">${esc(titleOf(ev))}</span>${recurHtml(ev)}${outlookMarkHtml(ev)}${badgeHtml(b)}</span></button>`);
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
// ---- the detail panel (XERK-2898) -----------------------------------------------
const evKey = (ev) => `${ev.host}\u0000${ev.id}`;
// The same key as it may ride an HTML attribute: the parser turns a NUL into U+FFFD (QA).
const evDomKey = (ev) => [ev.host, ev.id].map((x) => encodeURIComponent(String(x ?? ""))).join("/");
// The org a host is decided into (the served agent `org`), which the hub's matcher
// counts an unassigned event under.
function hostOrg(host) {
  const a = data && Array.isArray(data.agents) ? data.agents.find((x) => x && x.key === host) : null;
  return a && typeof a.org === "string" ? a.org : "";
}
// An event's org as the hub's capture matcher reads it: the served `matchOrg`, else (an
// older hub) its assigned org, else its host's.
const eventOrg = (ev) => (typeof ev.matchOrg === "string" ? ev.matchOrg
  : ev.org || (ev.source === "tenir" ? "" : hostOrg(ev.host)));
const capKey = (c) => [c.site, c.meetingId].map(encodeURIComponent).join("/");
const SHOW_AS = { free: "Free", tentative: "Tentative", busy: "Busy", outOfOffice: "Out of office", workingElsewhere: "Working elsewhere" };
// A Turma event's reminder (XERK-2988): the hub's CAL_TURMA_REMINDERS, minutes before the
// start; "" = none. Outlook on the org's writer host fires it, never the hub.
const REMINDERS = [["", "None"], ["0", "At start time"], ["5", "5 minutes before"], ["15", "15 minutes before"],
  ["30", "30 minutes before"], ["60", "1 hour before"], ["120", "2 hours before"], ["720", "12 hours before"],
  ["1440", "1 day before"], ["10080", "1 week before"]];
// A new event's: none. The reminder fires in the writer host's Outlook, whose owner may be
// neither the creator nor an attendee, so it is set only when someone picks one.
const REMINDER_DEFAULT = "";
const reminderKey = (v) => (Number.isInteger(v) && REMINDERS.some(([k]) => k === String(v)) ? String(v) : "");
const reminderText = (v) => { const k = reminderKey(v); return k ? REMINDERS.find(([x]) => x === k)[1] : ""; };
const RESPONSE = { organizer: "Organizer", accepted: "Accepted", tentative: "Tentative", declined: "Declined",
  notResponded: "Not responded", none: "No response needed" };
const MY_RESPONSE = { organizer: "You organized it", accepted: "Accepted", tentative: "Tentative",
  declined: "Declined", notResponded: "Not responded yet" };
const fmtWhenLong = (ms) => `${fmtLongDay(ms)}, ${fmtTime(ms)}`;
// An Outlook occurrence's id is `<GlobalAppointmentID>:<original start ISO>`
// (contract-calendar.md): a start that differs from it is a moved occurrence.
function originalStart(ev) {
  if (ev.source === "tenir" || typeof ev.id !== "string") return NaN;
  const i = ev.id.indexOf(":");
  if (i < 0 || !ev.seriesId) return NaN;
  const t = Date.parse(ev.id.slice(i + 1));
  return Number.isFinite(t) ? t : NaN;
}
function whenText(ev) {
  if (ev.allDay !== true) return fmtLongSpan(ev.startMs, ev.endMs);
  // A multi-day all-day event names its last day too; its end is exclusive midnight (XERK-2934).
  const last = ev.endMs - 1;
  return ev.endMs > ev.startMs && dayStart(last) !== dayStart(ev.startMs)
    ? `${fmtLongDay(ev.startMs)} – ${fmtLongDay(last)}, all day` : `${fmtLongDay(ev.startMs)}, all day`;
}
// Plain text as HTML: every line escaped, joined by <br>; "" for none.
function linesHtml(t) {
  return typeof t === "string" && t.trim() ? t.trim().split(/\r?\n/).map(esc).join("<br>") : "";
}
// A Turma event's invitations (XERK-2989): which org's Outlook sends them, the options,
// and a tally of the answers the hub read off that copy. "" when it sends none.
function invitesText(ev) {
  // A series sends them too (XERK-2986, XERK-3012). A private/confidential event sends none
  // (the hub writes it with sendInvites off); its owner is served `sensitivity`, not `private`.
  if (ev.sendInvites !== true || ev.private === true || ev.sensitivity === "private" || ev.sensitivity === "confidential") return "";
  const orgs = evOrgs(ev);
  const bits = [orgs.length ? `Sent from ${orgLabel(orgs[0])}'s Outlook` : "Sent from Outlook"];
  if (ev.responseRequested === false) bits.push("no responses requested");
  if (ev.allowForward === false) bits.push("forwarding off");
  const n = {};
  for (const a of Array.isArray(ev.attendees) ? ev.attendees : []) if (a && RESPONSE[a.response]) n[a.response] = (n[a.response] || 0) + 1;
  const tally = ["accepted", "tentative", "declined", "notResponded"].filter((k) => n[k]).map((k) => `${n[k]} ${RESPONSE[k].toLowerCase()}`);
  if (tally.length) bits.push(tally.join(", "));
  return bits.join(" · ");
}
function attendeesHtml(list) {
  const rows = list.filter((a) => a && typeof a === "object" && (a.name || a.email)).map((a) => {
    const who = a.name ? String(a.name) : String(a.email);
    const role = a.role === "optional" ? "optional" : a.role === "resource" ? "room" : "";
    const resp = Object.prototype.hasOwnProperty.call(RESPONSE, a.response) ? RESPONSE[a.response] : "";
    return `<li><span class="who"${a.email && a.name ? ` title="${esc(a.email)}"` : ""}>${esc(who)}</span>`
      + (role ? `<span class="role">${esc(role)}</span>` : "")
      + (resp ? `<span class="resp ${esc(a.response)}">${esc(resp)}</span>` : "") + `</li>`;
  });
  return rows.length ? `<ul class="cal-people">${rows.join("")}</ul>` : "";
}
// Outlook events a capture can move to: the same day, not canceled, of its org
// (an unassigned event counts as its host's org, as the hub's matcher reads it),
// nearest its start first.
function linkCandidates(c, at, skip) {
  const day = dayStart(at);
  return ((lastGot && lastGot.events) || [])
    .filter((e) => e.source !== "tenir" && e.canceled !== true && !inBand(e) && evKey(e) !== skip
      && dayStart(e.startMs) === day && (e.source === "turma" ? evOrgs(e).includes(c.site) : eventOrg(e) === c.site)
      && typeof e.id === "string" && e.id)
    .sort((x, y) => Math.abs(x.startMs - at) - Math.abs(y.startMs - at)).slice(0, 20);
}
function captureLinkHtml(ev, c) {
  const k = capKey(c);
  const M = typeof TurmaMeetings !== "undefined" && TurmaMeetings.meetingState ? TurmaMeetings : null;
  const st = M && data ? M.meetingState(data, c.site, c.meetingId) : null;
  const title = ev.source === "tenir" ? titleOf(ev) : String(c.title || (st && st.title) || "Tenir capture");
  const linked = ev.source !== "tenir" || !!ev.calendarEventId;
  const cands = linkCandidates(c, ev.startMs, ev.source === "tenir" ? "" : evKey(ev));
  const pick = linkPick.get(k) || "";
  const dis = linkBusy.has(k) ? ' aria-disabled="true"' : "";
  const opts = `<option value="">${linked ? "Move it to another event…" : "Link it to an Outlook event…"}</option>`
    + cands.map((e) => `<option value="${esc(evDomKey(e))}"${evDomKey(e) === pick ? " selected" : ""}>${esc(`${fmtTime(e.startMs)} · ${titleOf(e)}`)}</option>`).join("");
  return `<div class="cal-link" data-cap="${esc(k)}">`
    + `<div class="cal-link-what">${ev.source === "tenir" ? "This capture" : `Tenir capture: <b>${esc(title)}</b>`}</div>`
    + `<div class="cal-link-row">`
    + (cands.length ? `<select data-link-pick="${esc(k)}" aria-label="Link ${esc(title)} to an event">${opts}</select>`
      + `<button type="button" class="btn-sm" data-link-go="${esc(k)}"${pick ? dis : ' aria-disabled="true"'}>${linkBusy.has(k) ? "Working…" : "Link"}</button>`
      : `<span class="cal-dnote">No other Outlook event that day to link it to.</span>`)
    + (linked ? `<button type="button" class="btn-sm" data-link-unlink="${esc(k)}"${dis}>Unlink</button>` : "")
    + (st && st.calendarBy === "operator" ? `<button type="button" class="btn-sm" data-link-auto="${esc(k)}"${dis} title="Let Turma match it to the calendar again">Match automatically</button>` : "")
    + `</div>` + (linkErr.has(k) ? `<div class="mt-err">${esc(linkErr.get(k))}</div>` : "") + `</div>`;
}
// The day an occurrence's rule is read from: its series' first day, else its ORIGINAL
// start (a moved one keeps its series' day), in the zone the event was made in.
function evAnchorYmd(ev) {
  // The series' own first day when the hub serves it (an implicit "day 31" reads off it, never
  // off a clamped Feb 28 occurrence); else the occurrence's original start.
  const s = Date.parse(ev && ev.seriesStart), o = Date.parse(ev && ev.originalStart);
  const ms = Number.isFinite(s) ? s : Number.isFinite(o) ? o : ev.startMs;
  const tz = typeof ev.timeZone === "string" && zoneKnown(ev.timeZone) ? ev.timeZone : browserZone();
  return Number.isFinite(ms) ? ymdOf(zoneParts(ms, tz)) : "";
}
function detailHtml(ev, now, hasPanel = false) {
  const rows = [];
  const row = (k, v, html = false) => { if (v) rows.push(`<div class="cal-drow"><span class="k">${esc(k)}</span><span class="v">${html ? v : esc(v)}</span></div>`); };
  const tenir = ev.source === "tenir";
  const state = [];
  if (ev.canceled === true) state.push("Canceled");
  const orig = originalStart(ev);
  const moved = Number.isFinite(orig) && Math.abs(orig - ev.startMs) >= 60000;
  row("When", whenText(ev));
  if (moved) row("Moved", `from ${fmtWhenLong(orig)}`);
  if (tenir && ev.moved === true) row("Moved", "its Outlook event moved to another time");
  const turma = ev.source === "turma";
  // Locked (XERK-2964): an Outlook event's org is its host's, so it is shown, never picked.
  // A Turma event lists every org it belongs to, each with its color (XERK-2971).
  const orgs = evOrgs(ev);
  if (turma && orgs.length) {
    const colors = colorMap();
    row(orgs.length > 1 ? "Orgs" : "Org", orgs.map((o) => {
      const c = safeColor(colors.get(o));
      return `<span class="cal-orgchip"><span class="cal-orgdot"${c ? ` style="--org:${c}"` : ""} aria-hidden="true"></span>${esc(orgLabel(o))}</span>`;
    }).join(""), true);
  } else row("Org", orgLabel(ev.org));
  if (ev.recurring === true) {
    // A Turma series says its rule as the editor does; an Outlook one only that it repeats.
    const rule = turma && ev.recurrence && typeof ev.recurrence === "object" ? ev.recurrence : null;
    row("Repeats", RECUR_SVG + esc(rule ? repeatSummary(rule, evAnchorYmd(ev)) : "Part of a recurring series"), true);
  }
  row("Where", ev.location ? String(ev.location) : "");
  const org = ev.organizer ? String(ev.organizer) : "";
  row("Organizer", org && ev.organizerEmail ? `${org} (${ev.organizerEmail})` : org);
  row("You", Object.prototype.hasOwnProperty.call(MY_RESPONSE, ev.myResponse) ? MY_RESPONSE[ev.myResponse] : "");
  if (ev.busy === "tentative" && ev.myResponse !== "tentative") state.push("Tentative");
  if (ev.busy === "free") state.push("Free");
  if (ev.busy === "outOfOffice") state.push("Out of office");
  if (turma && ev.busy === "workingElsewhere") state.push("Working elsewhere");
  const host = ev.host ? (typeof TurmaBoard !== "undefined" && TurmaBoard.hostName ? TurmaBoard.hostName(ev.host) : String(ev.host)) : "";
  const olk = outlookStates(ev);
  row("Calendar", tenir ? "Captured by Tenir — not on Outlook" : turma ? (olk ? "Made in Turma" : "Made in Turma — not on Outlook") : host ? `Outlook on ${host}` : "");
  // Each org's copy in Outlook (XERK-2987), the error in Outlook's own words, escaped.
  if (turma) row("Reminder", reminderText(ev.reminderMinutes));
  if (olk && olk.length) {
    const one = olk.length === 1;
    row("Outlook", olk.map((x) => `<span class="cal-olk-row ${x.state}">${one ? "" : `${esc(orgLabel(x.org))}: `}${esc(x.text)}</span>`).join(""), true);
  }
  if (turma) row("Invitations", invitesText(ev));
  const cats = (Array.isArray(ev.categories) ? ev.categories : []).filter((c) => typeof c === "string" && c);
  if (cats.length) row("Categories", cats.map((c) => `<span class="cal-cat">${esc(c)}</span>`).join(""), true);
  const join = safeHttps(ev.joinUrl);
  const openNotesBtn = openNotes && notesTarget(ev, now)
    ? `<div class="cal-drow"><button type="button" class="btn-sm" data-open-notes>Open in notes review</button></div>` : "";
  const att = Array.isArray(ev.attendees) ? attendeesHtml(ev.attendees) : "";
  const attN = att ? (att.match(/<li>/g) || []).length : 0;
  // The description as Outlook wrote it: escaped line by line, breaks kept.
  const descHtml = linesHtml(ev.body);
  const notes = [];
  if (ev.private === true) notes.push("A private event: its details are withheld.");
  if (tenir && ev.calendarEventMissing === true) notes.push("The Outlook event it was linked to is no longer on the calendar.");
  if (tenir && ev.ambiguous === true) notes.push("More than one Outlook event fits this capture; link the right one below.");
  // What the capture says when meetings.js has no row for it (older than the snapshot's tail).
  let capture = "";
  if (tenir && !hasPanel) {
    const ppl = (Array.isArray(ev.participants) ? ev.participants : []).filter((x) => typeof x === "string" && x);
    const url = typeof ev.tenirUrl === "string" && /^https?:\/\/[^\s"'<>`\\]+$/i.test(ev.tenirUrl) ? ev.tenirUrl : "";
    capture = (ev.status === "queued" || ev.status === "running" ? `<div class="mt-status">Reading the captions…</div>` : "")
      + (ppl.length ? `<div class="mt-people" aria-label="Participants">${ppl.map((x) => `<span>${esc(x)}</span>`).join("")}</div>` : "")
      + (typeof ev.summary === "string" && ev.summary.trim()
        ? `<div class="mt-summary" aria-label="Summary">${ev.summary.trim().split(/\n{2,}/).map((x) => `<p>${x.split(/\r?\n/).map(esc).join("<br>")}</p>`).join("")}</div>` : "")
      + (url ? `<a class="mt-tenir" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open in Tenir ↗</a>` : "");
  }
  const caps = capturesOf(ev);
  return `<div class="cal-detail-head"><h2 id="calDetailTitle">${esc(titleOf(ev))}</h2>`
    + `<button type="button" class="cal-ic" data-close-detail aria-label="Close">✕</button></div>`
    + (state.length ? `<div class="cal-dstate">${esc(state.join(" · "))}</div>` : "")
    + rows.join("")
    + (join ? `<div class="cal-drow"><a href="${esc(join)}" target="_blank" rel="noopener noreferrer">Join meeting</a></div>` : "")
    + openNotesBtn
    + notes.map((n) => `<p class="cal-dnote">${esc(n)}</p>`).join("")
    // Collapsed by default like the description (XERK-2942): a big invite list buries the rest.
    + (att ? `<div class="cal-dsec"><button type="button" class="linkish cal-dlabel" data-att-toggle aria-expanded="${attOpen}">`
      + `${attOpen ? "▾" : "▸"} Attendees (${attN})</button>${attOpen ? att : ""}</div>` : "")
    + (descHtml ? `<div class="cal-dsec"><button type="button" class="linkish cal-dlabel" data-body-toggle aria-expanded="${descOpen}">`
      // descHtml is linesHtml's output: every line esc()'d (Semgrep reads `ev.body` as an Express req.body).
      // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format
      + `${descOpen ? "▾" : "▸"} Description</button>${descOpen ? `<div class="cal-dbody">${descHtml}</div>` : ""}</div>` : "")
    + capture
    + (caps.length ? caps.map((c) => captureLinkHtml(ev, c)).join("") : "")
    + (!tenir && !turma && !caps.length && ev.startMs < now ? `<p class="cal-dnote">Tenir captured nothing for this event.</p>` : "")
    + (turma ? turmaActionsHtml(ev) : "");
}
// Each host's calendar settings (XERK-2929): whether its private events are shown.
// Its org is shown, never set: every event takes its host's org (XERK-2964).
function hostSettingsHtml(rows) {
  const list = [...rows.values()].sort((a, b) => String(a.device || a.host).localeCompare(String(b.device || b.host)));
  if (!list.length) return `<div class="cal-hostset"><p class="cal-dnote">No host has synced a calendar yet.</p></div>`;
  return `<div class="cal-hostset" role="group" aria-label="Calendar settings">`
    + list.map((h) => {
      const k = String(h.host);
      const name = String(h.device || h.host);
      const dis = setBusy.has(k) ? ' aria-disabled="true"' : "";
      const org = typeof h.org === "string" && h.org ? orgLabel(h.org) : "No org";
      return `<div class="cal-hostrow"><b>${esc(name)}</b><span class="cal-dnote">${esc(org)}</span>`
        + `<label><input type="checkbox" data-host-private="${esc(k)}"${h.showPrivate === true ? " checked" : ""}${dis}> Show private events</label>`
        + (setErr.has(k) ? `<span class="mt-err">${esc(setErr.get(k))}</span>` : "")
        + `</div>`;
    }).join("") + `</div>`;
}
// ---- The subscribable feed (XERK-2992) -------------------------------------
// A secret iCal link Google/Apple/Outlook subscribe to. The hub keeps only its
// hash, so the link is shown once, right after "Create link"; afterwards only
// "a link exists" is known. One link per org (?org=) lets Google colour each org.
const feed = { loaded: false, loading: false, available: true, exists: false, at: 0, token: "", busy: false, err: "", copied: "" };
async function loadFeed() {
  if (feed.loading) return;
  feed.loading = true;
  try {
    const res = await fetch("/api/calendar/feed");
    const out = await res.json().catch(() => ({}));
    if (res.ok) Object.assign(feed, { available: out.available !== false, exists: !!out.exists, at: Number(out.at) || 0 });
    else feed.err = refusal(res, out);
  } catch { feed.err = "Could not reach the hub."; }
  feed.loading = false;
  feed.loaded = true;
  paint(true);
}
function refusal(res, out) {
  return typeof TurmaNav !== "undefined" && TurmaNav.refusalText ? TurmaNav.refusalText(res, out)
    : (out && typeof out.error === "string" ? out.error : `the hub answered HTTP ${res.status}`);
}
// "new": POST (mint, revoking the last); "off": DELETE.
async function feedAction(kind) {
  if (feed.busy) return;
  feed.busy = true;
  feed.err = "";
  paint(true);
  try {
    const res = await fetch("/api/calendar/feed", { method: kind === "new" ? "POST" : "DELETE" });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) feed.err = refusal(res, out);
    else if (kind === "new") Object.assign(feed, { exists: true, at: Number(out.at) || Date.now(), token: String(out.token || "") });
    else Object.assign(feed, { exists: false, at: 0, token: "" });
  } catch { feed.err = "Could not reach the hub."; }
  feed.busy = false;
  paint(true);
}
function feedUrl(org) {
  const origin = typeof location !== "undefined" && location.origin ? location.origin : "";
  return `${origin}/feeds/calendar/${encodeURIComponent(feed.token)}.ics${org ? `?org=${encodeURIComponent(org)}` : ""}`;
}
async function copyFeed(url) {
  let ok = false;
  try { if (navigator.clipboard) { await navigator.clipboard.writeText(url); ok = true; } } catch { ok = false; }
  feed.copied = ok ? url : "";
  if (!ok) feed.err = "Copy failed — select the link and copy it by hand.";
  paint(true);
}
function feedSettingsHtml() {
  const dis = feed.busy ? ' aria-disabled="true"' : "";
  const head = `<div class="cal-feed" role="group" aria-label="Subscribe from another calendar"><b>Subscribe in Google Calendar</b>`;
  if (!feed.loaded) return `${head}<p class="cal-dnote">Loading…</p></div>`;
  if (!feed.available) return `${head}<p class="cal-dnote">Sign in with your own account to get a calendar link.</p></div>`;
  const err = feed.err ? `<p class="mt-err">${esc(feed.err)}</p>` : "";
  const help = `<p class="cal-dnote">A private link to every org's meetings and Turma events. In Google Calendar choose `
    + `Other calendars → + → From URL and paste it. Google refreshes a subscribed calendar every few hours. `
    + `Anyone with the link can read your calendar: make a new link to replace a leaked one.</p>`;
  if (!feed.token) {
    const made = feed.exists ? `<p class="cal-dnote">A link is on${feed.at ? ` (made ${esc(new Date(feed.at).toLocaleDateString())})` : ""}. `
      + `It is shown only once — make a new one to see it again (the old one stops working).</p>` : "";
    return `${head}${help}${made}<div class="cal-feedbtns">`
      + `<button type="button" class="btn-sm" data-feed-new${dis}>${feed.exists ? "Make a new link" : "Create link"}</button>`
      + (feed.exists ? `<button type="button" class="btn-sm" data-feed-off${dis}>Turn off</button>` : "")
      + `</div>${err}</div>`;
  }
  const colors = colorMap();
  const row = (label, url, color) => `<div class="cal-feedrow">`
    + (color !== undefined ? `<span class="cal-orgdot"${color ? ` style="--org:${esc(color)}"` : ""} aria-hidden="true"></span>` : "")
    + `<span class="cal-feedlbl">${esc(label)}</span>`
    + `<input type="text" readonly value="${esc(url)}" aria-label="${esc(`${label} calendar link`)}" data-feed-url>`
    + `<button type="button" class="btn-sm" data-feed-copy="${esc(url)}">${feed.copied === url ? "Copied" : "Copy"}</button></div>`;
  const orgs = sites();
  return `${head}${help}<p class="cal-dnote"><b>Copy it now</b> — this link is shown only once.</p>`
    + row("All orgs", feedUrl(""))
    + (orgs.length > 1 ? `<p class="cal-dnote">Google shows a subscribed calendar in one colour. For a colour per org, add each org's link instead:</p>`
      + orgs.map((o) => row(orgLabel(o.siteKey), feedUrl(o.siteKey), colors.get(o.siteKey) || "")).join("") : "")
    + `<div class="cal-feedbtns"><button type="button" class="btn-sm" data-feed-new${dis}>Make a new link</button>`
    + `<button type="button" class="btn-sm" data-feed-off${dis}>Turn off</button></div>${err}</div>`;
}
// POST /api/agents/<host>/calendar/settings; the hub's `calendar` frame re-reads too.
async function saveHost(host, body) {
  if (setBusy.has(host)) return;
  setBusy.add(host);
  setErr.delete(host);
  paint(true);
  paintDetail(true);
  let res = null, out = {};
  try {
    res = await fetch(`/api/agents/${encodeURIComponent(host)}/calendar/settings`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try { out = await res.json(); } catch { out = {}; }
  } catch { res = null; }
  setBusy.delete(host);
  const T = typeof TurmaNav !== "undefined" ? TurmaNav : null;
  const what = "Saving the calendar settings";
  if (res && res.status === 401) { location.href = "/login"; return; }
  if (!res || !res.ok) {
    const text = res ? (T && T.refusalText ? T.refusalText(what, res.status, out)
      : `${what} failed — ${(out && out.error) || `the hub answered HTTP ${res.status}`}`) : `${what} failed — the hub is unreachable`;
    setErr.set(host, text);
    if (T && T.toast) T.toast(text);
  } else refetch();
  paint(true);
  paintDetail(true);
}
// What meetings.js shows below the details: the linked captures of ONE org (the
// first's), and a daily meeting's brief when the event is that org's daily meeting.
function panelSpec(ev) {
  const caps = capturesOf(ev);
  const site = caps.length ? caps[0].site : eventOrg(ev);
  if (!site) return null;
  return { site, meetingIds: caps.filter((c) => c.site === site).map((c) => c.meetingId),
    dailyAt: ev.source === "tenir" ? 0 : ev.startMs };
}
// aria-disabled, not disabled: the focused button keeps focus at the last step.
const zoomBtn = (dir, label, glyph, end) => `<button type="button" class="cal-ic" data-zoom="${dir}" aria-label="${label}"`
  + ` title="${label}${end ? "" : ` (${dir > 0 ? "fewer" : "more"} hours)`}"${end ? ' aria-disabled="true"' : ""}>${glyph}</button>`;
function headerHtml(days) {
  const m = mode();
  const opts = narrow ? [["day", "Day"], ["three", "3 days"]] : [["work", "Work week"], ["week", "Week"]];
  const unit = m === "work" || m === "week" ? "week" : m === "three" ? "3 days" : "day";
  return `<div class="cal-bar">`
    + `<button type="button" class="primary cal-new" data-cal-new>+ New event</button>`
    + `<button type="button" data-cal-today>Today</button>`
    + `<button type="button" class="cal-ic" data-step="-1" aria-label="Previous ${unit}">‹</button>`
    + `<button type="button" class="cal-ic" data-step="1" aria-label="Next ${unit}">›</button>`
    + `<span class="cal-range-wrap"><button type="button" class="cal-range" data-open-picker aria-haspopup="dialog" aria-expanded="${picker !== null}">`
    + `${esc(rangeLabel(days))} <span class="car" aria-hidden="true">▾</span></button>`
    + (picker !== null ? pickerHtml(days, nowFn()) : "") + `</span>`
    + `<span class="sp"></span><span class="cal-modes" role="group" aria-label="View">`
    + opts.map(([k, l]) => `<button type="button" class="tri-chip${k === m ? " on" : ""}" data-mode="${k}" aria-pressed="${k === m}">${l}</button>`).join("")
    + `</span><span class="cal-zoom" role="group" aria-label="Zoom">`
    + zoomBtn(-1, "Zoom out", "−", zoomHours === ZOOMS[0])
    + zoomBtn(1, "Zoom in", "+", zoomHours === ZOOMS[ZOOMS.length - 1])
    + `</span><button type="button" class="cal-ic" data-host-settings aria-expanded="${hostSetOpen}" aria-label="Calendar settings" title="Calendar settings">⚙</button></div>`;
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
  lastGot = got;
  // The open event, as the newest read has it (a sync changed it, a relink moved it).
  if (detail) {
    const k = evKey(detail);
    let fresh = got.events.find((e) => evKey(e) === k);
    // A Tenir-only entry that a (re)link merged into an event: follow it there.
    if (!fresh && detail.source === "tenir" && got.have) {
      fresh = got.events.find((e) => e.source !== "tenir" && capturesOf(e)
        .some((c) => c.site === detail.site && c.meetingId === detail.meetingId));
    }
    if (fresh) detail = fresh;
    // A Turma event gone from its own week (deleted, or out of the org filter) closes its panel.
    else if (detail.source === "turma" && got.have && !got.loading && !got.err
      && days.some((d) => onDay(detail, d))) { detail = null; detailFrom = null; }
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
  const hours = Array.from({ length: 24 }, (_, h) => `<div class="cal-hr" style="top:${slots(h * 2)}">${h ? esc(new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" })) : ""}</div>`).join("");
  const body = days.map((d) => {
    const isToday = dayKey(d) === today;
    const segs = daySegments(got.events, d);
    const nowLine = isToday ? `<div class="cal-now" style="top:${slots(wallMinutes(now, d) / 30)}" aria-hidden="true"></div>` : "";
    return `<div class="cal-col${isToday ? " today" : ""}${offOrgs(d, got.holidays).length ? " off" : ""}" data-col="${d}">`
      + segs.map((s) => timedHtml(s, d, colors, now)).join("") + nowLine + `</div>`;
  }).join("");
  const label = `Calendar, ${rangeLabel(days)}`;
  return headerHtml(days)
    + (hostSetOpen ? hostSettingsHtml(got.hostRows) + feedSettingsHtml() : "")
    + (notes.length ? `<div class="cal-notes" aria-live="polite">${notes.join("")}</div>` : "")
    + `<div class="cal-grid" role="region" aria-label="${esc(label)}">`
    + `<div class="cal-row cal-heads" style="${cols}"><div></div>${heads}</div>`
    + `<div class="cal-row cal-band" style="${cols}"><div class="cal-band-lbl">All day</div>${band}</div>`
    + `<div class="cal-scroll" id="calScroll"><div class="cal-row cal-body" style="${cols};--hours:${zoomHours};height:${slots(48)}">`
    + `<div class="cal-gutter">${hours}</div>${body}</div></div></div>`;
}

// Focus survives a repaint by its event + day (the button is a new node).
function focusSig() {
  const a = typeof document !== "undefined" ? document.activeElement : null;
  if (!a || !$root || !$root.contains || !$root.contains(a)) return null;
  const d = a.dataset || {};
  if (d.ev !== undefined) { const ev = shown[Number(d.ev)]; return ev ? { ev: `${ev.host}\u0000${ev.id}`, day: d.day } : null; }
  for (const k of ["step", "mode", "pick", "pmonth", "zoom"]) if (d[k] !== undefined) return { sel: `[data-${k}="${d[k]}"]` };
  for (const k of ["hostPrivate"]) if (d[k] !== undefined) return { attr: k, v: d[k] };
  for (const k of ["calToday", "calNew", "openPicker", "closeDetail", "hostSettings", "feedNew", "feedOff"]) if (d[k] !== undefined) return { sel: `[data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]` };
  return null;
}
function restoreFocusSig(sig) {
  if (!sig || !$root || !$root.querySelector) return;
  let el = null;
  if (sig.ev) {
    const i = shown.findIndex((e) => `${e.host}\u0000${e.id}` === sig.ev);
    if (i >= 0) el = $root.querySelector(`[data-ev="${i}"][data-day="${sig.day}"]`) || $root.querySelector(`[data-ev="${i}"]`);
  } else if (sig.attr) {
    el = [...$root.querySelectorAll("select,input")].find((x) => x.dataset && x.dataset[sig.attr] === sig.v) || null;
  } else el = $root.querySelector(sig.sel);
  if (el && el.focus) el.focus({ preventScroll: true });
}
let lastHtml = "";
function paint(force = false) {
  if (!$root || !active) return;
  const html = calendarHtml();
  let revealed = false;
  if (force || html !== lastHtml) {
    lastHtml = html;
    const sig = focusSig();
    const T = typeof TurmaNav !== "undefined" && TurmaNav.preserveScroll ? TurmaNav : null;
    const put = () => { $grid.innerHTML = html; };
    if (T) T.preserveScroll($grid, put); else put();
    restoreFocusSig(sig);
    const sc = $grid.querySelector && $grid.querySelector("#calScroll");
    revealed = !!(sc && scrollToMin >= 0);
    if (sc && scrollToMin >= 0) { holdTop(sc, Math.max(0, scrollToMin - 60)); scrolled = true; }
    else if (sc && zoomAnchor >= 0) { holdTop(sc, Math.max(0, zoomAnchor - sc.clientHeight / 2 / pxPerMin(sc))); revealed = true; }
    else if (sc && !scrolled) { holdTop(sc, openMin(sc)); scrolled = true; }
    scrollToMin = -1;
    zoomAnchor = -1;
  }
  refit(revealed);
  paintDetail(force);
  if (revealFocus) { revealFocus = false; if ($side && !$side.hidden && $side.focus) $side.focus(); }
}
// Also holds the top minute across a pane-size change (holdTop). A stretched day has nothing to scroll, so its
// scrollTop is 0; once a resize makes the pane scroll again, open it at 8 AM like
// a fresh paint instead of leaving it stuck at midnight (XERK-2937).
let fitWas = false;
// Hidden (Notes review) the pane measures 0x0, which says nothing, so it is
// skipped; a paint that just scrolled to a revealed event keeps that scroll.
function refit(keep = false) {
  const sc = active && $grid && $grid.querySelector && $grid.querySelector("#calScroll");
  if (!sc || !sc.clientHeight) return;
  const fits = sc.scrollHeight <= sc.clientHeight + 1;
  if (fitWas && !fits && !keep) holdTop(sc, openMin(sc));
  else holdTop(sc);
  fitWas = fits;
}
// The detail panel paints apart from the grid, into its own element: the grid's
// repaints (a frame, the clock) never swap the controls under the operator.
// meetings.js paints the capture part into `$mt` itself, with its own hold.
const fieldFocused = (el) => {
  const a = typeof document !== "undefined" ? document.activeElement : null;
  return !!a && !!el && !!el.contains && el.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName || "");
};
let lastDetail = "";
function paintDetail(force = false) {
  if (!$side) return;
  const M = typeof TurmaMeetings !== "undefined" && TurmaMeetings.showPanel ? TurmaMeetings : null;
  if (!detail || !active) {
    if (M) M.showPanel($mt, null);
    if (lastDetail) { $info.innerHTML = ""; lastDetail = ""; }
    $side.hidden = true;
    panelHas = false;
    return;
  }
  $side.hidden = false;
  // The panel wears its event's org color (XERK-2939), like the event it opened from.
  const c = safeColor(detail.org ? colorMap().get(detail.org) : "");
  if (c) $side.style.setProperty("--org", c); else $side.style.removeProperty("--org");
  // A Turma-made event's panel wears its block's blue → purple gradient instead (XERK-3023).
  $side.className = detail.source === "turma" ? "cal-detail turma" : "cal-detail";
  if (!force && (sidePress || fieldFocused($info))) { sidePending = true; return; }
  sidePending = false;
  if (M) {
    panelHas = M.showPanel($mt, panelSpec(detail), { scroller: $side,
      onPaint: (has) => { if (has !== panelHas) { panelHas = has; paintDetail(); } } });
  }
  const html = detailHtml(detail, nowFn(), panelHas);
  if (html === lastDetail) return;
  lastDetail = html;
  const a = typeof document !== "undefined" ? document.activeElement : null;
  const ds = a && $info.contains && $info.contains(a) && a.dataset ? a.dataset : null;
  const k = ds && ["linkPick", "linkGo", "linkUnlink", "linkAuto", "bodyToggle", "attToggle", "closeDetail", "evEdit", "evDelete", "evDeleteYes", "evDeleteNo", "evScope", "evScopeNo"].find((x) => ds[x] !== undefined);
  $info.innerHTML = html;
  if (k && $info.querySelectorAll) {
    const el = [...$info.querySelectorAll("button,select")].find((x) => x.dataset && x.dataset[k] === ds[k]);
    if (el && el.focus) el.focus({ preventScroll: true });
  }
}
// Keyboard focus onto a control of the panel's info part after a repaint swapped it out.
function focusInfo(sel) {
  const x = $info && $info.querySelector ? $info.querySelector(sel) : null;
  if (x && x.focus) x.focus({ preventScroll: true });
}
function flushSide() { setTimeout(() => { if (sidePending) paintDetail(); }, 0); }

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
    // Esc in a field (an Edit draft, a relink pick) stays with the field.
    const f = ev.target;
    if (f && (/^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName || "") || f.isContentEditable)) return;
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
function openDetail(e, from) {
  detailFrom = from;
  if (!detail || evKey(detail) !== evKey(e)) { descOpen = false; attOpen = false; linkPick.clear(); linkErr.clear(); delConfirm = false; scopeAsk = null; evErr = ""; }
  detail = e;
  picker = null;
  paint(true);
  if ($side && $side.focus) $side.focus();
}
// Relink a capture (contract-calendar.md, `POST .../meetings/<mid>/calendar`):
// `{eventId}` to another event, `{eventId: null}` never linked, `{auto: true}`
// back to the matcher. The answer's row goes to meetings.js; the weeks re-read.
async function relink(k, body, target) {
  if (linkBusy.has(k)) return;
  const [site, mid] = k.split("/").map(decodeURIComponent);
  linkBusy.add(k);
  linkErr.delete(k);
  paintDetail(true);
  let res = null, out = {};
  try {
    res = await fetch(`/api/orgs/${encodeURIComponent(site)}/meetings/${encodeURIComponent(mid)}/calendar`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try { out = await res.json(); } catch { out = {}; }
  } catch { res = null; }
  linkBusy.delete(k);
  const T = typeof TurmaNav !== "undefined" ? TurmaNav : null;
  const what = body.auto ? "Matching the capture" : body.eventId === null ? "Unlinking the capture" : "Linking the capture";
  if (res && res.status === 401) { location.href = "/login"; return; }
  if (!res || !res.ok) {
    const text = res ? (T && T.refusalText ? T.refusalText(what, res.status, out)
      : `${what} failed — ${(out && out.error) || `the hub answered HTTP ${res.status}`}`) : `${what} failed — the hub is unreachable`;
    linkErr.set(k, text);
    if (T && T.toast) T.toast(text);
  } else {
    linkPick.delete(k);
    if (out && out.meeting && typeof TurmaMeetings !== "undefined" && TurmaMeetings.patch) TurmaMeetings.patch(site, out.meeting);
    // A Tenir-only entry linked to an event becomes that event: follow it.
    if (target && detail && detail.source === "tenir") detail = target;
    refetch();
  }
  paintDetail(true);
}
// ---- Turma events: create / edit / delete (XERK-2971) ----------------------------
// Events made in Turma, owned by the hub, in one or many orgs (contract-calendar-turma.md
// "Turma-created events"). Outlook events stay read-only: only an event served with
// source "turma" AND editable offers Edit / Delete. No optimistic paint: a write
// answers, the hub's `calendar` frame (and our own refetch) re-reads the weeks.
const ORGS_MAX = 20;                      // CALENDAR_TURMA_ORGS_MAX
const ATTENDEES_MAX = 100;
const BODY_MAX = 4000;                    // CALENDAR_BODY_MAX, code points
// The hub's CAL_EMAIL_RE (server.js): no quote, angle bracket, backtick, space,
// slash, control, bidi or invisible character, one @, a dot after it.
const EMAIL_PART = "[^@\\s/\"<>`\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]+";
const EMAIL_RE = new RegExp(`^${EMAIL_PART}@${EMAIL_PART}\\.${EMAIL_PART}$`);
const cps = (s) => [...String(s ?? "")].length;
// The hub's CAL_URL_RE: case-sensitive, so "HTTPS://" is refused there and here.
const JOIN_URL_RE = /^https:\/\/[^\s"'<>\\`]+$/;
// The address as the hub stores it (trimmed, lower-cased), or "" when it would refuse it.
function normEmail(v) {
  const e = typeof v === "string" ? v.trim().toLowerCase() : "";
  return e.length <= 200 && EMAIL_RE.test(e) ? e : "";
}
// "Ann Lee <ann@x.org>" or "ann@x.org" → {name, email}; null when no valid address.
function parseAttendee(text) {
  // A trailing comma/semicolon ends an address; both regexes would keep it in the address.
  const t = String(text ?? "").trim().replace(/[,;\s]+$/, "");
  const m = /^(.*?)\s*<([^<>]*)>$/.exec(t);
  const email = normEmail(m ? m[2] : t);
  if (!email) return null;
  const name = m ? m[1].replace(/^["']|["']$/g, "").trim() : "";
  return { name: [...name].slice(0, 100).join(""), email };
}
const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
// Wall-clock fields of instant `ms` in IANA zone `tz`.
function zoneParts(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = {};
  for (const x of f.formatToParts(ms)) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
function zoneOffsetSec(ms, tz) {
  const p = zoneParts(ms, tz);
  return (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 1000;
}
const zoneOffsetMin = (ms, tz) => Math.round(zoneOffsetSec(ms, tz) / 60);
// Before a zone adopted standard time it kept local mean time, an offset with
// seconds (Europe/Brussels +00:17:30 in 1890, Africa/Monrovia -00:44:30 until
// 1972). An ISO offset carries whole minutes only, so such a time would be saved
// rounded and reopen off by up to a minute (XERK-2953): the editor refuses it.
const LMT_ERROR = "That date is before this time zone kept standard time (its offset has seconds); pick a later date.";
const keepsLmt = (ms, tz) => zoneOffsetSec(ms, tz) % 60 !== 0;
const ymdOf = (p) => `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
// "YYYY-MM-DD" + n calendar days.
function addYmd(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
// A wall date + time in `tz` as the ISO-with-offset the hub requires, or null.
// A time a DST gap skips lands on the instant the old offset names, and its ISO is
// the time as picked + that old offset (02:30-05:00, the same instant as 03:30-04:00):
// the hub keeps it as the wall time a series repeats (XERK-3040). Every ISO parses
// back to its instant.
function wallToIso(date, time, tz) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  const t = /^(\d{2}):(\d{2})$/.exec(String(time || ""));
  if (!d || !t || +t[1] > 23 || +t[2] > 59) return null;
  const [y, mo, dd] = [+d[1], +d[2], +d[3]];
  // Date.UTC reads a year under 100 as 19xx; no event is that old.
  if (y < 1000 || mo < 1 || mo > 12 || dd < 1 || dd > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  try {
    const guess = Date.UTC(y, mo - 1, dd, +t[1], +t[2]);
    // The zone's offset a day before and after: the wall time is guess minus one of them.
    // Both name it in a repeated (fall-back) hour: the earlier instant, its first pass.
    // Neither in a skipped (spring) hour: the offset before the switch names it.
    const before = zoneOffsetMin(guess - DAY_MS, tz), after = zoneOffsetMin(guess + DAY_MS, tz);
    const names = (off) => { const q = zoneParts(guess - off * 60000, tz); return Date.UTC(q.y, q.mo - 1, q.d, q.h, q.mi) === guess; };
    const fits = [...new Set([before, after])].filter(names).map((off) => guess - off * 60000);
    const ms = fits.length ? Math.min(...fits) : guess - before * 60000;
    const p = fits.length ? zoneParts(ms, tz) : { y, mo, d: dd, h: +t[1], mi: +t[2] };
    const off = fits.length ? zoneOffsetMin(ms, tz) : before;
    const sign = off < 0 ? "-" : "+", a = Math.abs(off);
    return { ms, iso: `${ymdOf(p)}T${pad(p.h)}:${pad(p.mi)}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}` };
  } catch { return null; }
}
function zoneKnown(tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }
// The zones the picker offers: the runtime's list, plus the browser's and the event's own.
function zoneList(cur) {
  let all = [];
  try { all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []; } catch { all = []; }
  return [...new Set([cur, browserZone(), "UTC", ...all].filter((z) => typeof z === "string" && z))];
}
// A fresh form: [startMs, endMs) on the browser's wall clock, in `orgs`.
function blankForm(startMs, endMs, orgs = []) {
  const tz = browserZone();
  const s = zoneParts(startMs, tz), e = zoneParts(endMs, tz);
  return { subject: "", startDate: ymdOf(s), startTime: `${pad(s.h)}:${pad(s.mi)}`, endDate: ymdOf(e),
    endTime: `${pad(e.h)}:${pad(e.mi)}`, allDay: false, timeZone: tz, location: "", online: false, joinUrl: "",
    body: "", busy: "busy", reminder: REMINDER_DEFAULT, category: "", priv: false, sensitivity: "normal", orgs: orgs.slice(0, ORGS_MAX),
    invites: false, reqResp: true, allowFwd: true,
    required: [], optional: [], reqDraft: "", optDraft: "", repeat: blankRepeat() };
}
// The form for an event the hub served: its wall times in the zone it was made in.
function formFromEvent(ev) {
  const tz = typeof ev.timeZone === "string" && zoneKnown(ev.timeZone) ? ev.timeZone : browserZone();
  const allDay = ev.allDay === true;
  const s = zoneParts(ev.startMs, tz);
  const e = zoneParts(allDay && ev.endMs > ev.startMs ? ev.endMs - 1 : ev.endMs, tz);
  const att = (Array.isArray(ev.attendees) ? ev.attendees : []).filter((a) => a && typeof a === "object" && normEmail(a.email))
    .map((a) => ({ name: typeof a.name === "string" ? a.name : "", email: normEmail(a.email), role: a.role === "optional" ? "optional" : "required" }));
  const sens = typeof ev.sensitivity === "string" ? ev.sensitivity : "normal";
  const join = safeHttps(ev.joinUrl);
  return { subject: typeof ev.subject === "string" ? ev.subject : "", startDate: ymdOf(s), startTime: `${pad(s.h)}:${pad(s.mi)}`,
    endDate: ymdOf(e), endTime: `${pad(e.h)}:${pad(e.mi)}`, allDay, timeZone: tz,
    location: typeof ev.location === "string" ? ev.location : "", online: ev.isOnlineMeeting === true || !!join, joinUrl: join,
    body: typeof ev.body === "string" ? ev.body : "", busy: Object.prototype.hasOwnProperty.call(SHOW_AS, ev.busy) ? ev.busy : "busy",
    reminder: reminderKey(ev.reminderMinutes),
    category: (Array.isArray(ev.categories) ? ev.categories : []).filter((c) => typeof c === "string").join(", "),
    priv: sens === "private" || sens === "confidential", sensitivity: sens, orgs: evOrgs(ev).slice(0, ORGS_MAX),
    invites: ev.sendInvites === true, reqResp: ev.responseRequested !== false, allowFwd: ev.allowForward !== false,
    required: att.filter((a) => a.role === "required").map(({ name, email }) => ({ name, email })),
    optional: att.filter((a) => a.role === "optional").map(({ name, email }) => ({ name, email })),
    reqDraft: "", optDraft: "", repeat: repeatFromRule(ev.recurrence) };
}
// The instants a form names: {start, end, startMs, endMs} or {error}. An all-day
// event runs midnight to the midnight after its last day, in its zone.
function formTimes(f) {
  const tz = f.timeZone;
  if (!zoneKnown(tz)) return { error: { timeZone: "Pick a time zone." } };
  const s = wallToIso(f.startDate, f.allDay ? "00:00" : f.startTime, tz);
  if (!s) return { error: { start: "Pick a start date and time." } };
  if (keepsLmt(s.ms, tz)) return { error: { start: LMT_ERROR } };
  const e = f.allDay ? wallToIso(addYmd(f.endDate, 1), "00:00", tz) : wallToIso(f.endDate, f.endTime, tz);
  if (!e) return { error: { end: "Pick an end date and time." } };
  if (keepsLmt(e.ms, tz)) return { error: { end: LMT_ERROR } };
  if (e.ms < s.ms || (f.allDay && e.ms <= s.ms)) return { error: { end: "The end is before the start." } };
  return { start: s.iso, end: e.iso, startMs: s.ms, endMs: e.ms };
}
const categoriesOf = (f) => [...new Set(String(f.category || "").split(",").map((c) => c.trim()).filter(Boolean))];

// ---- Repeat (XERK-2973) ---------------------------------------------------------
// The editor's Repeat control ⇄ the hub's rule (contract-calendar-turma.md "Recurring
// Turma events"). Android's core/CalendarRepeat.kt is a port: both read
// turma/tests/fixtures/calendar-repeat-vectors.json, so the rule a pick sends
// and the summary line are the same on both clients. Pure; `ymd` is the
// series' first day ("YYYY-MM-DD", the event's own zone), which an implicit
// day / weekday / month means.
const R_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const R_DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const R_DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const R_WEEKDAYS = ["MO", "TU", "WE", "TH", "FR"];
const R_NTH = { 1: "first", 2: "second", 3: "third", 4: "fourth", "-1": "last" };
const R_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const R_UNITS = ["day", "week", "month", "year"];
const R_FREQ = { day: "daily", week: "weekly", month: "monthly", year: "yearly" };
const R_INTERVAL_MAX = 99, R_COUNT_MAX = 999;   // recurrence.js INTERVAL_MAX / COUNT_MAX
// {y, m (1-12), d, dow (0 = Sunday)} of a real date, else null.
function rAnchor(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  if (!m) return null;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (t.getUTCMonth() !== +m[2] - 1) return null;
  return { y: +m[1], m: +m[2], d: +m[3], dow: t.getUTCDay() };
}
// The anchor's place in its month: the 1st..4th of its weekday, the 5th reads "last".
const rAnchorNth = (a) => { const n = Math.ceil(a.d / 7); return n > 4 ? -1 : n; };
const rSameDays = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const rWeekOrder = (days) => R_DAYS.filter((d) => days.includes(d));
// What the control holds. `days` empty = the anchor's weekday (weekly) / every day
// (daily); `monthDay`/`nth` null = the anchor's (kept only when a rule named them).
function blankRepeat() {
  return { kind: "none", interval: 1, unit: "week", days: [], monthMode: "day", monthDay: null, nth: null,
    end: "never", until: "", count: 10 };
}
function repeatFromRule(rule) {
  const r = blankRepeat();
  if (!rule || typeof rule !== "object" || !Object.values(R_FREQ).includes(rule.freq)) return r;
  const interval = Number.isSafeInteger(rule.interval) ? rule.interval : 1;
  const days = Array.isArray(rule.byDay) ? rWeekOrder(rule.byDay) : [];
  const wd = rule.byWeekday && typeof rule.byWeekday === "object" && R_DAYS.includes(rule.byWeekday.day) ? rule.byWeekday : null;
  const md = Number.isSafeInteger(rule.byMonthDay) ? rule.byMonthDay : null;
  Object.assign(r, { interval, days, monthMode: wd ? "weekday" : "day", monthDay: wd ? null : md,
    nth: wd ? { n: wd.n, day: wd.day } : null });
  if (typeof rule.until === "string" && rule.until) Object.assign(r, { end: "until", until: rule.until });
  else if (Number.isSafeInteger(rule.count)) Object.assign(r, { end: "count", count: rule.count });
  const unit = Object.keys(R_FREQ).find((u) => R_FREQ[u] === rule.freq);
  let kind = "custom";
  if (interval === 1) {
    if (unit === "day" && rSameDays(days, R_WEEKDAYS)) kind = "weekday";
    else if (unit === "day" && !days.length) kind = "daily";
    else if (unit === "week") kind = "weekly";
    else if (unit === "month") kind = "monthly";
    else if (unit === "year" && !wd && md === null) kind = "yearly";
  }
  if (kind === "weekday") r.days = [];
  return Object.assign(r, { kind, unit });
}
// The rule a control names (the hub's key order, so a stored rule reads back equal), or null.
function ruleFromRepeat(r, ymd) {
  if (!r || r.kind === "none") return null;
  const a = rAnchor(ymd);
  const custom = r.kind === "custom";
  const unit = custom ? (R_UNITS.includes(r.unit) ? r.unit : "week")
    : { weekday: "day", daily: "day", weekly: "week", monthly: "month", yearly: "year" }[r.kind];
  if (!unit) return null;
  const out = { freq: R_FREQ[unit], interval: custom ? Number(r.interval) : 1 };
  const days = rWeekOrder(Array.isArray(r.days) ? r.days : []);
  if (r.kind === "weekday") out.byDay = R_WEEKDAYS.slice();
  else if ((unit === "week" || (custom && unit === "day")) && days.length && days.length < 7) out.byDay = days;
  else if (unit === "week" && days.length === 7) out.byDay = days;
  if (unit === "month" || (custom && unit === "year")) {
    if (r.monthMode === "weekday") {
      out.byWeekday = r.nth && R_DAYS.includes(r.nth.day) ? { n: r.nth.n, day: r.nth.day }
        : a ? { n: rAnchorNth(a), day: R_DAYS[a.dow] } : undefined;
      if (!out.byWeekday) delete out.byWeekday;
    } else if (Number.isSafeInteger(r.monthDay) && (!a || r.monthDay !== a.d)) out.byMonthDay = r.monthDay;
  }
  if (r.end === "until" && r.until) out.until = String(r.until);
  else if (r.end === "count") out.count = Number(r.count);
  return out;
}
// What keeps the control from saving, or "" (the hub's own rule checks, said first).
// `from`: the first day an until may name (a "following" split's day), else `ymd`.
function repeatError(r, ymd, from) {
  if (!r || r.kind === "none") return "";
  const n = Number(r.interval);
  if (r.kind === "custom" && !(Number.isSafeInteger(n) && n >= 1 && n <= R_INTERVAL_MAX)) return `Repeat every 1 to ${R_INTERVAL_MAX}.`;
  if (r.end === "until") {
    if (!rAnchor(r.until)) return "Pick the date it repeats until.";
    const first = rAnchor(from) ? from : ymd;
    if (rAnchor(first) && String(r.until) < String(first)) return "It must repeat until a day on or after its start.";
  }
  const c = Number(r.count);
  if (r.end === "count" && !(Number.isSafeInteger(c) && c >= 1 && c <= R_COUNT_MAX)) return `End after 1 to ${R_COUNT_MAX} occurrences.`;
  return "";
}
const rList = (days) => rWeekOrder(days).map((d) => R_DAY_SHORT[R_DAYS.indexOf(d)]).join(", ");
const rNthText = (w) => `the ${R_NTH[w.n] || "first"} ${R_DAY_LONG[R_DAYS.indexOf(w.day)] || ""}`;
// One line a person reads: "Every 2 weeks on Mon, Wed until 31 Dec 2026".
function repeatSummary(rule, ymd) {
  if (!rule || typeof rule !== "object" || !Object.values(R_FREQ).includes(rule.freq)) return "Does not repeat";
  const a = rAnchor(ymd) || { y: 0, m: 1, d: 1, dow: 0 };
  const i = Number.isSafeInteger(rule.interval) && rule.interval > 1 ? rule.interval : 1;
  const every = (u) => (i === 1 ? `Every ${u}` : `Every ${i} ${u}s`);
  const days = Array.isArray(rule.byDay) ? rule.byDay : [];
  const wd = rule.byWeekday && R_DAYS.includes(rule.byWeekday.day) ? rule.byWeekday : null;
  const md = Number.isSafeInteger(rule.byMonthDay) ? rule.byMonthDay : a.d;
  let s;
  if (rule.freq === "daily") s = i === 1 && rSameDays(days, R_WEEKDAYS) ? "Every weekday" : every("day") + (days.length ? ` on ${rList(days)}` : "");
  else if (rule.freq === "weekly") s = `${every("week")} on ${rList(days.length ? days : [R_DAYS[a.dow]])}`;
  else if (rule.freq === "monthly") s = `${every("month")} on ${wd ? rNthText(wd) : `day ${md}`}`;
  else s = `${every("year")} on ${wd ? `${rNthText(wd)} of ${R_MONTHS[a.m - 1]}` : `${md} ${R_MONTHS[a.m - 1]}`}`;
  const u = rAnchor(rule.until);
  if (u) s += ` until ${u.d} ${R_MONTHS[u.m - 1].slice(0, 3)}${u.y !== a.y ? ` ${u.y}` : ""}`;
  else if (Number.isSafeInteger(rule.count)) s += `, ${rule.count} time${rule.count === 1 ? "" : "s"}`;
  return s;
}
// The day the editor's repeat is read against: the series' first day when an occurrence is
// edited (QA: its own day dropped a kept "day 31", read a moved Wednesday as the series' day and
// refused a valid until), else the start the form shows (a new or single event's). A rule sent
// for "following" is re-anchored at the split by the hub (month day pinned, count shared out).
// A date MOVE re-anchors it as the hub does (QA): "following" starts the new series on the new
// day; "All events" shifts the whole series by the move. "This event" shows the series' rule.
function repDay(f) {
  if (!f || !f.seriesDate || !f.openDate || f.startDate === f.openDate || f.repScope === "occurrence") {
    return (f && f.seriesDate) || f.startDate;
  }
  if (f.repScope === "following") return f.startDate;
  const days = Math.round((Date.parse(`${f.startDate}T00:00:00Z`) - Date.parse(`${f.openDate}T00:00:00Z`)) / 864e5);
  return Number.isFinite(days) ? addYmd(f.seriesDate, days) : f.seriesDate;
}
// The first day a "following" split's until may name: the day the new series starts.
const splitDay = (f) => (f && f.repScope === "following" ? f.startDate : undefined);
// The Repeat menu, Teams' presets named for the start day ("Weekly on Tuesday").
// `r` (the control) names a weekly rule's own days in its preset.
function repeatPresets(ymd, r) {
  const a = rAnchor(ymd) || { y: 0, m: 1, d: 1, dow: 0 };
  const nth = { n: rAnchorNth(a), day: R_DAYS[a.dow] };
  const days = r && r.kind === "weekly" && Array.isArray(r.days) && r.days.length ? rList(r.days) : R_DAY_LONG[a.dow];
  return [["none", "Does not repeat"], ["weekday", "Every weekday (Mon–Fri)"], ["daily", "Daily"],
    ["weekly", `Weekly on ${days}`], ["monthly", `Monthly on day ${a.d}`],
    ["monthlyNth", `Monthly on ${rNthText(nth)}`], ["yearly", `Yearly on ${a.d} ${R_MONTHS[a.m - 1]}`], ["custom", "Custom…"]];
}
// The preset a control shows (monthly splits on its mode).
const repeatPresetOf = (r) => (r.kind === "monthly" && r.monthMode === "weekday" ? "monthlyNth" : r.kind);
// A preset picked: the control it starts (a day/weekday it named for the old start is dropped).
function repeatPick(r, preset) {
  const next = { ...r, monthDay: null, nth: null };
  if (preset === "monthlyNth") return { ...next, kind: "monthly", monthMode: "weekday" };
  if (preset === "monthly") return { ...next, kind: "monthly", monthMode: "day" };
  if (preset === "custom") {
    const unit = { weekday: "day", daily: "day", weekly: "week", monthly: "month", yearly: "year" }[r.kind] || r.unit || "week";
    return { ...r, kind: "custom", unit, days: r.kind === "weekday" ? R_WEEKDAYS.slice() : r.days };
  }
  return { ...next, kind: preset, days: preset === "weekly" ? r.days : [] };
}
// What keeps the form from saving, field → message (the hub's rules, said before it refuses).
// `pickable` is the orgs the viewer may pick.
function validateForm(f, pickable = null) {
  const err = {};
  if (!f.orgs.length) err.orgs = "Pick at least one org.";
  else if (f.orgs.length > ORGS_MAX) err.orgs = `An event belongs to at most ${ORGS_MAX} orgs.`;
  else if (pickable && f.orgs.some((o) => !pickable.includes(o))) err.orgs = "Pick only orgs you can see.";
  // Invitations go out from one org's Outlook (XERK-3016): the hub refuses them on two orgs.
  // Not for one occurrence: its orgs and invitations are the series' (both boxes disabled), and
  // the hub takes it even on an older two-org sending series.
  else if (f.invites && f.orgs.length > 1 && f.repScope !== "occurrence") err.orgs = "An event that sends invitations belongs to one org: pick one, or turn invitations off.";
  if (cps(f.subject) > 300) err.subject = "The title is longer than 300 characters.";
  if (cps(f.location) > 300) err.location = "The location is longer than 300 characters.";
  if (cps(f.body) > BODY_MAX) err.body = `The details are longer than ${BODY_MAX} characters.`;
  if (f.online && String(f.joinUrl || "").trim() && !JOIN_URL_RE.test(String(f.joinUrl).trim())) err.joinUrl = "A join link must be an https:// link.";
  else if (f.online && cps(String(f.joinUrl || "").trim()) > 500) err.joinUrl = "The join link is longer than 500 characters.";
  for (const [k, d] of [["required", "reqDraft"], ["optional", "optDraft"]]) {
    if (String(f[d] || "").trim() && !parseAttendee(f[d])
      && !String(f[d]).split(/[,;]/).map((x) => x.trim()).filter(Boolean).every((x) => parseAttendee(x))) err[d] = "Not an email address: type name@example.com or Name <name@example.com>.";
  }
  if (f.required.length + f.optional.length > ATTENDEES_MAX) err.reqDraft = `At most ${ATTENDEES_MAX} attendees.`;
  const cats = categoriesOf(f);
  if (cats.length > 20 || cats.some((c) => cps(c) > 100)) err.category = "At most 20 categories of at most 100 characters.";
  // A ',' separates names here; a ';' would split the Outlook copy, so the hub refuses it (XERK-3013).
  else if (cats.some((c) => c.includes(";"))) err.category = "A category name can't contain ';'.";
  const t = formTimes(f);
  if (t.error) Object.assign(err, t.error);
  const re = repeatError(f.repeat, repDay(f), splitDay(f));
  if (re) err.repeat = re;
  return err;
}
// The route body (POST /api/calendar/events, or a PATCH with `version`). `scope`
// names which events of a series an occurrence's edit applies to (occurrence |
// following | series); an occurrence takes no rule — it is the series'.
function formPayload(f, version, scope) {
  const t = formTimes(f);
  if (t.error) return null;
  const attendees = [...f.required.map((a) => ({ ...a, role: "required" })), ...f.optional.map((a) => ({ ...a, role: "optional" }))]
    .map((a) => ({ name: String(a.name || ""), email: a.email, role: a.role }));
  const keepPriv = f.sensitivity === "private" || f.sensitivity === "confidential" ? f.sensitivity : "private";
  const body = { orgs: f.orgs.slice(), subject: String(f.subject || "").trim(), start: t.start, end: t.end, timeZone: f.timeZone,
    allDay: !!f.allDay, location: String(f.location || "").trim(), body: String(f.body || ""), attendees,
    joinUrl: f.online ? String(f.joinUrl || "").trim() : "", isOnlineMeeting: !!f.online, busy: f.busy,
    categories: categoriesOf(f), sensitivity: f.priv ? keepPriv : (f.sensitivity === "personal" ? "personal" : "normal"),
    reminderMinutes: f.reminder && REMINDERS.some(([k]) => k === f.reminder) ? Number(f.reminder) : null,
    sendInvites: !!f.invites, responseRequested: f.reqResp !== false, allowForward: f.allowFwd !== false };
  if (scope !== "occurrence") body.recurrence = ruleFromRepeat(f.repeat, repDay(f));
  if (version !== undefined) body.version = version;
  if (scope) body.scope = scope;
  return body;
}
// An occurrence's scoped edit: only the fields the person changed, plus `version` and
// `scope` (null when nothing changed). Resending the rest is not neutral (XERK-2973 QA): a
// resent rule re-grew a count and dropped the hub's month-end day on "This and following",
// a resent start dragged the series to a moved occurrence's day, and "This event" pinned
// every field into its override so a later "All events" rename never reached it.
// start/end ride together: the hub moves by their delta.
function scopedBody(base, cur) {
  const out = {};
  for (const k of Object.keys(cur)) {
    if (k === "version" || k === "scope") continue;
    if (JSON.stringify(cur[k]) !== JSON.stringify(base[k])) out[k] = cur[k];
  }
  if ("start" in out || "end" in out) { out.start = cur.start; out.end = cur.end; }
  if (!Object.keys(out).length) return null;
  if (cur.version !== undefined) out.version = cur.version;
  if (cur.scope) out.scope = cur.scope;
  return out;
}
// The orgs a viewer may put an event in: every org its fleet reports (the hub has
// already scoped the snapshot to the caller's tenant), plus any the event holds.
function pickableOrgs(extra = []) {
  return [...new Set([...sites().map((s) => s.siteKey), ...extra].filter((o) => typeof o === "string" && o))];
}

// The panel's Edit / Delete (only an editable Turma event) and a refusal in the hub's words.
let delConfirm = false, evBusy = false, evErr = "";
// An occurrence of a Turma series asks which events an Edit / Delete is for
// (XERK-2973), Teams' three answers: "edit" | "delete" | null.
let scopeAsk = null;
const isTurmaOccurrence = (ev) => !!ev && ev.source === "turma" && ev.recurring === true && typeof ev.seriesId === "string" && !!ev.seriesId;
const SCOPES = [["occurrence", "This event"], ["following", "This and following"], ["series", "All events"]];
function turmaActionsHtml(ev) {
  if (ev.editable !== true) return `<p class="cal-dnote">Only someone who can see every org of this event can change it.</p>`;
  const dis = evBusy ? ' aria-disabled="true"' : "";
  if (scopeAsk && isTurmaOccurrence(ev)) {
    const del = scopeAsk === "delete";
    return `<div class="cal-dact" role="group" aria-label="${del ? "Delete" : "Edit"} which events">`
      + `<span class="cal-dask">${del ? (evBusy ? "Deleting…" : "Delete which events?") : "Edit which events?"}</span>`
      + SCOPES.map(([s, l]) => `<button type="button" class="btn-sm${del ? " cal-danger" : ""}" data-ev-scope="${s}"${dis}>${l}</button>`).join("")
      + `<button type="button" class="btn-sm" data-ev-scope-no${dis}>Cancel</button></div>`
      + (evErr ? `<div class="mt-err">${esc(evErr)}</div>` : "");
  }
  return `<div class="cal-dact">`
    + (delConfirm
      ? `<span class="cal-dask">Delete this event for ${evOrgs(ev).length > 1 ? "every org" : "everyone"}?</span>`
        + `<button type="button" class="btn-sm cal-danger" data-ev-delete-yes${dis}>${evBusy ? "Deleting…" : "Delete"}</button>`
        + `<button type="button" class="btn-sm" data-ev-delete-no${dis}>Cancel</button>`
      : `<button type="button" class="btn-sm" data-ev-edit${dis}>Edit</button>`
        + `<button type="button" class="btn-sm" data-ev-delete${dis}>Delete</button>`)
    + `</div>` + (evErr ? `<div class="mt-err">${esc(evErr)}</div>` : "");
}
// One fetch with the hub's refusal worded (XERK-264): {res, out, text}. text is set on failure.
async function writeJson(method, url, body, what) {
  let res = null, out = {};
  try {
    res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    try { out = await res.json(); } catch { out = {}; }
  } catch { res = null; }
  if (res && res.status === 401) { location.href = "/login"; return { res, out, text: "", signedOut: true }; }
  const T = typeof TurmaNav !== "undefined" ? TurmaNav : null;
  if (res && res.ok) return { res, out, text: "" };
  const text = res ? (T && T.refusalText ? T.refusalText(what, res.status, out)
    : `${what} failed — ${(out && out.error) || `the hub answered HTTP ${res.status}`}`) : `${what} failed — the hub is unreachable`;
  if (T && T.toast) T.toast(text);
  return { res, out, text };
}
async function deleteEvent(scope) {
  const ev = detail;
  if (!ev || ev.source !== "turma" || ev.editable !== true || evBusy) return;
  evBusy = true; evErr = "";
  paintDetail(true);
  const q = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  const r = await writeJson("DELETE", `/api/calendar/events/${encodeURIComponent(ev.id)}${q}`, undefined, "Deleting the event");
  evBusy = false;
  if (r.signedOut) return;
  if (r.text) { evErr = r.text; delConfirm = false; scopeAsk = null; if (r.res && r.res.status === 404) refetch(); return void paintDetail(true); }
  delConfirm = false; scopeAsk = null;
  if (detail && evKey(detail) === evKey(ev)) closeDetail();
  refetch();
}

// The editor: a Teams-style form in a modal (.td-backdrop, full screen when narrow).
let $edBack = null, $edPanel = null;
let ed = null;            // {mode:"new"|"edit", id?, version?, f, errors, err, busy, tried}
function openEditor(opts = {}) {
  if (!$edPanel) return;
  let f;
  if (opts.event) {
    f = formFromEvent(opts.event);
    // An occurrence of a series is edited for the events its scope names (XERK-2973).
    const scope = isTurmaOccurrence(opts.event) && SCOPES.some(([s]) => s === opts.scope) ? opts.scope : undefined;
    // A series' rule reads off its first day in every scope (QA: from a clamped Apr 30 or a
    // moved occurrence the editor read "day 30" / "Wed" while the series runs on the 31st /
    // Tuesdays); a "following" split starts at this occurrence, so its until may not end before it.
    if (scope) Object.assign(f, { seriesDate: evAnchorYmd(opts.event), openDate: f.startDate, repScope: scope });
    // A count series split here: its count is the whole run's, as the hub reads it (QA).
    if (scope === "following" && opts.event.recurrence && Number.isSafeInteger(opts.event.recurrence.count)) f.wholeCount = true;
    ed = { mode: "edit", id: String(opts.event.id), version: opts.event.version, scope, f, errors: {}, err: "", busy: false, tried: false };
    // A scoped edit sends only what changed (scopedBody): the form as opened is the base.
    if (scope) ed.base = formPayload(f, undefined, scope);
  } else {
    const now = nowFn();
    let s = num(opts.startMs) ? opts.startMs : 0;
    if (!s) {
      // Today: the next half hour; another day shown: 9:00 on its first day.
      const d = new Date(now); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
      s = visibleDays(anchor, mode()).some((x) => x === dayStart(now)) ? d.getTime()
        : new Date(visibleDays(anchor, mode())[0]).setHours(9, 0, 0, 0);
    }
    const e = num(opts.endMs) && opts.endMs > s ? opts.endMs : s + 30 * 60000;
    const pick = pickableOrgs();
    const filt = orgKeys().filter((o) => pick.includes(o));
    f = blankForm(s, e, filt.length ? filt : pick.length === 1 ? pick : []);
    if (opts.allDay) f.allDay = true;
    ed = { mode: "new", f, errors: {}, err: "", busy: false, tried: false };
  }
  ed.opener = typeof document !== "undefined" ? document.activeElement : null;
  $edBack.hidden = false;
  if (typeof document !== "undefined" && document.body && document.body.classList) document.body.classList.add("td-open");
  paintEditor(true);
  const first = $edPanel.querySelector && $edPanel.querySelector("[data-ed-field=subject]");
  if (first && first.focus) first.focus(); else if ($edPanel.focus) $edPanel.focus();
}
function closeEditor() {
  if (!ed) return;
  const back = ed.opener;
  ed = null;
  $edBack.hidden = true;
  $edPanel.innerHTML = "";
  if (typeof document !== "undefined" && document.body && document.body.classList) document.body.classList.remove("td-open");
  if (back && back.focus && back.isConnected !== false) back.focus({ preventScroll: true });
}
function chipsHtml(list, role) {
  return list.map((a, i) => `<span class="cal-chip" title="${esc(a.email)}">${esc(a.name || a.email)}`
    + `<button type="button" class="cal-chip-x" data-ed-unchip="${role}:${i}" aria-label="Remove ${esc(a.name || a.email)}">✕</button></span>`).join("");
}
function editorHtml() {
  const f = ed.f, er = ed.tried ? ed.errors : {};
  const fieldErr = (k) => (er[k] ? `<div class="mt-err" id="calEdErr-${k}">${esc(er[k])}</div>` : "");
  const inv = (k) => (er[k] ? ` aria-invalid="true" aria-describedby="calEdErr-${k}"` : "");
  const dis = ed.busy ? ' aria-disabled="true"' : "";
  const colors = colorMap();
  const orgs = pickableOrgs(ed.mode === "edit" ? f.orgs : []);
  const tzs = zoneList(f.timeZone);
  const show = Object.entries(SHOW_AS).map(([k, l]) => `<option value="${k}"${k === f.busy ? " selected" : ""}>${esc(l)}</option>`).join("");
  const one = ed.scope === "occurrence";
  const title = ed.mode !== "edit" ? "New event" : ({ occurrence: "Edit this event", following: "Edit this and following events",
    series: "Edit all events" })[ed.scope] || "Edit event";
  return `<div class="td-head"><h2 class="cal-ed-title" id="calEdTitle">${title}</h2>`
    + `<button type="button" class="td-close" data-ed-close aria-label="Close">✕</button></div>`
    + `<div class="cal-ed-form">`
    + `<label class="cal-ed-row"><span class="k">Title</span><input type="text" data-ed-field="subject" maxlength="300" placeholder="Add a title" value="${esc(f.subject)}"${inv("subject")}></label>${fieldErr("subject")}`
    + `<div class="cal-ed-row"><span class="k" id="calEdOrgsK">Orgs</span><div class="cal-ed-orgs" role="group" aria-labelledby="calEdOrgsK"${inv("orgs")}>`
    + (orgs.length ? orgs.map((o) => {
      const c = safeColor(colors.get(o));
      return `<label class="cal-ed-org"><input type="checkbox" data-ed-org="${esc(o)}"${f.orgs.includes(o) ? " checked" : ""}${one ? " disabled" : ""}>`
        + `<span class="cal-orgdot"${c ? ` style="--org:${c}"` : ""} aria-hidden="true"></span>${esc(orgLabel(o))}</label>`;
    }).join("") : `<span class="cal-dnote">No org reports a host yet.</span>`)
    + `</div></div>${fieldErr("orgs")}`
    // Orgs are the series' (the hub refuses an occurrence's own): said, not silently ignored.
    + (one ? `<div class="cal-ed-row"><span class="k"></span><span class="cal-dnote cal-ed-note" id="calEdOneNote">A series' orgs apply to every event in it. Edit All events to change them.</span></div>` : "")
    + ["required", "optional"].map((role) => {
      const d = role === "required" ? "reqDraft" : "optDraft";
      return `<div class="cal-ed-row"><span class="k">${role === "required" ? "Required" : "Optional"}</span><div class="cal-ed-chips">`
        + chipsHtml(f[role], role)
        + `<input type="text" data-ed-field="${d}" data-ed-chipin="${role}" placeholder="${role === "required" ? "Invite people" : "Optional attendees"} (name@example.com)"`
        + ` aria-label="${role === "required" ? "Required" : "Optional"} attendees" value="${esc(f[d])}"${inv(d)}></div></div>${fieldErr(d)}`;
    }).join("")
    + invitesRowHtml(f, one)
    + `<div class="cal-ed-row"><span class="k">Starts</span><div class="cal-ed-when">`
    + `<input type="date" data-ed-field="startDate" aria-label="Start date" value="${esc(f.startDate)}"${inv("start")}>`
    + (f.allDay ? "" : `<input type="time" data-ed-field="startTime" step="300" aria-label="Start time" value="${esc(f.startTime)}"${inv("start")}>`)
    + `</div></div>${fieldErr("start")}`
    + `<div class="cal-ed-row"><span class="k">Ends</span><div class="cal-ed-when">`
    + `<input type="date" data-ed-field="endDate" aria-label="End date" value="${esc(f.endDate)}"${inv("end")}>`
    + (f.allDay ? "" : `<input type="time" data-ed-field="endTime" step="300" aria-label="End time" value="${esc(f.endTime)}"${inv("end")}>`)
    + `</div></div>${fieldErr("end")}`
    + `<div class="cal-ed-row"><span class="k"></span><div class="cal-ed-when">`
    + `<label class="cal-ed-check"><input type="checkbox" data-ed-flag="allDay"${f.allDay ? " checked" : ""}> All day</label>`
    + `<select data-ed-field="timeZone" aria-label="Time zone"${one ? ' disabled aria-describedby="calEdOneNote"' : ""}${inv("timeZone")}>${tzs.map((z) => `<option value="${esc(z)}"${z === f.timeZone ? " selected" : ""}>${esc(z.replace(/_/g, " "))}</option>`).join("")}</select>`
    + `</div></div>${fieldErr("timeZone")}`
    + repeatRowsHtml(f, one) + fieldErr("repeat")
    + `<label class="cal-ed-row"><span class="k">Location</span><input type="text" data-ed-field="location" maxlength="300" placeholder="Add a location" value="${esc(f.location)}"${inv("location")}></label>${fieldErr("location")}`
    + `<div class="cal-ed-row"><span class="k">Online</span><div class="cal-ed-when">`
    + `<label class="cal-ed-check"><input type="checkbox" data-ed-flag="online"${f.online ? " checked" : ""}> Online meeting</label>`
    + (f.online ? `<input type="url" data-ed-field="joinUrl" class="cal-ed-grow" placeholder="https://… join link" aria-label="Join link" value="${esc(f.joinUrl)}"${inv("joinUrl")}>` : "")
    + `</div></div>${fieldErr("joinUrl")}`
    + `<div class="cal-ed-row"><span class="k">Show as</span><div class="cal-ed-when"><select data-ed-field="busy" aria-label="Show as">${show}</select>`
    + `<input type="text" data-ed-field="category" class="cal-ed-grow" placeholder="Category" aria-label="Category" value="${esc(f.category)}"${inv("category")}>`
    + `<label class="cal-ed-check"><input type="checkbox" data-ed-flag="priv"${f.priv ? " checked" : ""}> Private</label></div></div>${fieldErr("category")}`
    + `<label class="cal-ed-row"><span class="k">Reminder</span><select data-ed-field="reminder" aria-label="Reminder">`
    + REMINDERS.map(([k, l]) => `<option value="${k}"${k === (f.reminder || "") ? " selected" : ""}>${esc(l)}</option>`).join("")
    + `</select></label>`
    + `<label class="cal-ed-row cal-ed-top"><span class="k">Details</span><textarea data-ed-field="body" rows="5" placeholder="Add details"${inv("body")}>${esc(f.body)}</textarea></label>${fieldErr("body")}`
    + `</div>`
    + (ed.err ? `<div class="mt-err cal-ed-err" role="alert">${esc(ed.err)}</div>` : "")
    + `<div class="cal-ed-foot"><button type="button" data-ed-cancel>Cancel</button>`
    + `<button type="button" class="primary" data-ed-save${dis}>${ed.busy ? "Saving…" : ed.mode === "edit" ? "Save" : "Save event"}</button></div>`;
}
// Invitations (XERK-2989): sent from the event's one org's Outlook (XERK-3016).
// The event's, never one occurrence's: "This event" shows them disabled.
function invitesRowHtml(f, one) {
  const off = one ? ' disabled aria-describedby="calEdOneNote"' : "";
  return `<div class="cal-ed-row"><span class="k">Invitations</span><div class="cal-ed-when">`
    + `<label class="cal-ed-check"><input type="checkbox" data-ed-flag="invites"${f.invites ? " checked" : ""}${off}> Send invitations from Outlook</label>`
    + (f.invites ? `<label class="cal-ed-check"><input type="checkbox" data-ed-flag="reqResp"${f.reqResp ? " checked" : ""}${off}> Request responses</label>`
      + `<label class="cal-ed-check"><input type="checkbox" data-ed-flag="allowFwd"${f.allowFwd ? " checked" : ""}${off}> Allow forwarding</label>` : "")
    + `</div></div>`
    + (f.invites ? `<div class="cal-ed-row"><span class="k"></span><span class="cal-dnote cal-ed-note">`
      + esc(f.priv ? "A private event sends no invitations: its details are withheld from Outlook."
        : "Sent once, from the Outlook host of the event's org; updates and a delete reach the attendees too.")
      + `</span></div>` : "");
}
// The editor's summary line: a split count series' count is the whole run's, and says so.
function editorSummary(f) {
  const rule = ruleFromRepeat(f.repeat, repDay(f));
  const s = repeatSummary(rule, repDay(f));
  return f.wholeCount && rule && Number.isSafeInteger(rule.count) ? `${s} in the whole series` : s;
}
// The Repeat control (XERK-2973): a preset menu, and for a repeating event its days /
// interval / month mode / end, then the one-line summary the panel shows too.
function repeatRowsHtml(f, one) {
  const r = f.repeat || blankRepeat();
  const summary = editorSummary(f);
  if (one) {
    return `<div class="cal-ed-row"><span class="k">Repeat</span><span class="cal-dnote cal-ed-note">${esc(summary)}. `
      + `A series repeats as a whole: edit All events to change it.</span></div>`;
  }
  const opt = (v, l, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`;
  let h = `<div class="cal-ed-row"><span class="k">Repeat</span><select data-ed-rep="preset" aria-label="Repeat">`
    + repeatPresets(repDay(f), r).map(([v, l]) => opt(v, l, repeatPresetOf(r))).join("") + `</select></div>`;
  if (r.kind === "none") return h;
  const custom = r.kind === "custom";
  if (custom) {
    h += `<div class="cal-ed-row"><span class="k"></span><div class="cal-ed-when">Every`
      + `<input type="number" class="cal-ed-num" data-ed-rep="interval" min="1" max="${R_INTERVAL_MAX}" step="1" aria-label="Repeat every" value="${esc(r.interval)}">`
      + `<select data-ed-rep="unit" aria-label="Repeat unit">${R_UNITS.map((u) => opt(u, `${u}${Number(r.interval) === 1 ? "" : "s"}`, r.unit)).join("")}</select></div></div>`;
  }
  const unit = custom ? r.unit : { weekly: "week", monthly: "month" }[r.kind];
  if (unit === "week" || (custom && unit === "day")) h += `<div class="cal-ed-row"><span class="k"></span>${repeatDaysHtml(r, repDay(f), unit)}</div>`;
  if (custom && (unit === "month" || unit === "year")) {
    const a = rAnchor(repDay(f)) || { d: 1, dow: 0 };
    const nth = r.nth || { n: rAnchorNth(a), day: R_DAYS[a.dow] };
    h += `<div class="cal-ed-row"><span class="k"></span><select data-ed-rep="monthMode" aria-label="Repeat on">`
      + opt("day", `On day ${Number.isSafeInteger(r.monthDay) ? r.monthDay : a.d}`, r.monthMode)
      + opt("weekday", `On ${rNthText(nth)}`, r.monthMode) + `</select></div>`;
  }
  // No "Ends" label: the event's own end sits just above (screenshot review).
  h += `<div class="cal-ed-row"><span class="k"></span><div class="cal-ed-when"><select data-ed-rep="end" aria-label="Repeat ends">`
    + opt("never", "Never ends", r.end) + opt("until", "Ends on", r.end) + opt("count", "Ends after", r.end) + `</select>`
    + (r.end === "until" ? `<input type="date" data-ed-rep="until" aria-label="Repeat until" min="${esc(splitDay(f) || repDay(f))}" value="${esc(r.until)}">` : "")
    + (r.end === "count" ? `<input type="number" class="cal-ed-num" data-ed-rep="count" min="1" max="${R_COUNT_MAX}" step="1" aria-label="Number of occurrences${f.wholeCount ? " in the whole series" : ""}" value="${esc(r.count)}"> occurrences${f.wholeCount ? " in the whole series" : ""}` : "")
    + `</div></div>`;
  return h + `<div class="cal-ed-row"><span class="k"></span><span class="cal-ed-sum" data-ed-rep-summary aria-live="polite">${RECUR_SVG}${esc(summary)}</span></div>`;
}
// The days a weekly rule repeats on (none ticked = its start's weekday); a daily
// custom rule's days narrow it (none = every day).
function repeatDaysHtml(r, ymd, unit) {
  const a = rAnchor(ymd);
  const on = r.days.length ? r.days : unit === "week" && a ? [R_DAYS[a.dow]] : [];
  return `<div class="cal-ed-days" role="group" aria-label="${unit === "week" ? "On days" : "Only on days"}">` + R_DAYS.map((d, i) =>
    `<label class="cal-ed-day"><input type="checkbox" data-ed-repday="${d}" aria-label="${R_DAY_LONG[i]}"${on.includes(d) ? " checked" : ""}>`
    + `<span aria-hidden="true">${R_DAY_SHORT[i].slice(0, 2)}</span></label>`).join("") + `</div>`;
}
// A typed repeat field (or the start date) changed: say it in place, never by
// repainting the panel (see the change handler's comment on why).
function refreshRepeatText() {
  if (!ed || !$edPanel || !$edPanel.querySelector) return;
  const f = ed.f;
  const sum = $edPanel.querySelector("[data-ed-rep-summary]");
  if (sum) sum.innerHTML = RECUR_SVG + esc(editorSummary(f));
  const sel = $edPanel.querySelector('[data-ed-rep="preset"]');
  if (sel && sel.options) {
    const labels = new Map(repeatPresets(repDay(f), f.repeat));
    for (const o of [...sel.options]) if (labels.has(o.value)) o.textContent = labels.get(o.value);
  }
  const unit = $edPanel.querySelector('[data-ed-rep="unit"]');
  if (unit && unit.options) for (const o of [...unit.options]) o.textContent = `${o.value}${Number(f.repeat.interval) === 1 ? "" : "s"}`;
  // A weekly rule with no day ticked repeats on its start's weekday: the boxes follow it.
  const a = rAnchor(repDay(f)), r = f.repeat;
  if (a && r && !r.days.length && (r.kind === "weekly" || (r.kind === "custom" && r.unit === "week"))) {
    for (const x of [...$edPanel.querySelectorAll("[data-ed-repday]")]) x.checked = x.dataset.edRepday === R_DAYS[a.dow];
  }
}
// After a failed Save, drop the messages for fields now fixed, in place: a repaint
// here would land mid-typing in a date/time field. New errors wait for the next Save.
function clearFixedErrors() {
  ed.errors = validateForm(ed.f);
  if (!$edPanel || !$edPanel.querySelectorAll) return;
  for (const n of [...$edPanel.querySelectorAll(".mt-err[id^='calEdErr-']")]) {
    const k = n.id.slice("calEdErr-".length);
    if (ed.errors[k]) continue;
    for (const x of [...$edPanel.querySelectorAll(`[aria-describedby="${n.id}"]`)]) {
      x.removeAttribute("aria-invalid"); x.removeAttribute("aria-describedby");
    }
    n.remove();
  }
}
let lastEd = "";
function paintEditor(force = false) {
  if (!$edPanel || !ed) return;
  const html = editorHtml();
  if (!force && html === lastEd) return;
  lastEd = html;
  const B = typeof TurmaBoard !== "undefined" ? TurmaBoard : null;
  const key = B && B.focusKeyIn && $edPanel.ownerDocument ? B.focusKeyIn($edPanel) : null;
  $edPanel.innerHTML = html;
  if (key && B.restoreFocusIn) B.restoreFocusIn($edPanel, key);
}
// Commit a typed attendee into a chip; false when it is no address.
function commitChip(role) {
  const d = role === "required" ? "reqDraft" : "optDraft";
  // One address, or a pasted list ("a@b.co, c@d.co") when every part is one.
  const one = parseAttendee(ed.f[d]);
  const parts = String(ed.f[d] || "").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  const many = parts.length > 1 ? parts.map(parseAttendee) : [];
  const got = many.length && many.every(Boolean) ? many : one ? [one] : [];
  if (!got.length) return false;
  for (const a of got) {
    if (![...ed.f.required, ...ed.f.optional].some((x) => x.email === a.email)) ed.f[role].push(a);
  }
  ed.f[d] = "";
  return true;
}
async function saveEditor() {
  if (!ed || ed.busy) return;
  const cur = ed;
  for (const role of ["required", "optional"]) commitChip(role);
  cur.tried = true;
  cur.errors = validateForm(cur.f, pickableOrgs(cur.mode === "edit" && detail ? evOrgs(detail) : []));
  cur.err = "";
  if (Object.keys(cur.errors).length) return void paintEditor(true);
  let body = formPayload(cur.f, cur.mode === "edit" ? cur.version : undefined, cur.scope);
  if (cur.mode === "edit" && cur.scope && cur.base) {
    body = scopedBody(cur.base, body);
    if (!body) return void closeEditor();   // nothing changed: nothing to send
  }
  cur.busy = true;
  paintEditor(true);
  const r = cur.mode === "edit"
    ? await writeJson("PATCH", `/api/calendar/events/${encodeURIComponent(cur.id)}`, body, "Saving the event")
    : await writeJson("POST", "/api/calendar/events", body, "Creating the event");
  cur.busy = false;
  if (r.signedOut || ed !== cur) return;
  if (r.text) {
    cur.err = r.text;
    // Changed since it was opened: the hub sends the current event. Reload it and say so.
    if (r.res && r.res.status === 409 && r.out && r.out.event && typeof r.out.event === "object" && cur.mode === "edit") {
      const fresh = { source: "turma", ...r.out.event, orgs: Array.isArray(r.out.event.orgs) ? r.out.event.orgs : cur.f.orgs };
      cur.f = formFromEvent(fresh);
      if (cur.scope) Object.assign(cur.f, { seriesDate: evAnchorYmd(fresh), openDate: cur.f.startDate, repScope: cur.scope });
      if (cur.scope === "following" && fresh.recurrence && Number.isSafeInteger(fresh.recurrence.count)) cur.f.wholeCount = true;
      if (cur.scope) cur.base = formPayload(cur.f, undefined, cur.scope);
      cur.version = r.out.event.version;
      cur.tried = false;
      refetch();
    }
    return void paintEditor(true);
  }
  const saved = r.out && r.out.event && typeof r.out.event === "object" ? r.out.event : null;
  closeEditor();
  // The event left every org the header filters to: it no longer shows here.
  const keys = orgKeys();
  if (saved && detail && detail.source === "turma" && String(detail.id) === String(saved.id)) {
    const orgs = Array.isArray(saved.orgs) ? saved.orgs : [];
    if (keys.length && !orgs.some((o) => keys.includes(o))) closeDetail();
    else { detail = { ...detail, ...saved, source: "turma", host: "" }; paintDetail(true); }
  }
  refetch();
}
// A pointer press on an empty slot of the grid → its 30-minute row (wall minutes).
function slotMinAt(col, y) {
  const r = col && col.getBoundingClientRect ? col.getBoundingClientRect() : null;
  if (!r || !(r.height > 0)) return -1;
  const m = Math.floor(((y - r.top) / r.height) * 48) * 30;
  return Math.max(0, Math.min(1410, m));
}
function slotMs(day, min) { const d = new Date(day); d.setHours(Math.floor(min / 60), min % 60, 0, 0); return d.getTime(); }
let slotPress = null;
function mountEditor() {
  if (typeof document === "undefined" || !document.createElement) return;
  $edBack = document.createElement("div");
  $edBack.className = "td-backdrop cal-ed-back";
  $edBack.hidden = true;
  $edPanel = document.createElement("div");
  $edPanel.className = "td-panel cal-ed";
  $edPanel.setAttribute("role", "dialog");
  $edPanel.setAttribute("aria-modal", "true");
  $edPanel.setAttribute("aria-labelledby", "calEdTitle");
  $edPanel.tabIndex = -1;
  $edBack.appendChild($edPanel);
  const host = document.body || document.documentElement;
  if (host && host.appendChild) host.appendChild($edBack);
  // A press on the dimmed backdrop itself closes, like the board's panels.
  $edBack.addEventListener("click", (e) => { if (e.target === $edBack && ed && !ed.busy) closeEditor(); });
  $edPanel.addEventListener("keydown", (e) => {
    if (!ed) return;
    if (e.key === "Escape") { e.preventDefault(); if (!ed.busy) closeEditor(); return; }
    const t = e.target, d = t && t.dataset;
    if (e.key === "Enter" && d && d.edChipin) {
      e.preventDefault();
      if (commitChip(d.edChipin)) { delete ed.errors[d.edField]; paintEditor(true); }
      else if (String(ed.f[d.edField] || "").trim()) { ed.tried = true; ed.errors = { ...ed.errors, [d.edField]: validateForm(ed.f)[d.edField] }; paintEditor(true); }
    } else if (e.key === "Backspace" && d && d.edChipin && !t.value) {
      const list = ed.f[d.edChipin];
      if (list.length) { list.pop(); paintEditor(true); }
    }
  });
  $edPanel.addEventListener("input", (e) => {
    const t = e.target, d = t && t.dataset;
    // The repeat's typed fields are held as typed and said in the summary at once.
    if (ed && d && (d.edRep === "interval" || d.edRep === "until" || d.edRep === "count")) {
      ed.f.repeat = { ...ed.f.repeat, [d.edRep]: String(t.value ?? "") };
      return void refreshRepeatText();
    }
    if (!ed || !d || d.edField === undefined) return;
    ed.f[d.edField] = String(t.value ?? "");
    // A comma or semicolon ends an address.
    if (d.edChipin && /[,;]\s*$/.test(ed.f[d.edField])) {
      ed.f[d.edField] = ed.f[d.edField].replace(/[,;]\s*$/, "");
      if (commitChip(d.edChipin)) paintEditor(true);
    }
  });
  $edPanel.addEventListener("change", (e) => {
    const t = e.target, d = t && t.dataset;
    if (!ed || !d) return;
    if (d.edRep === "interval" || d.edRep === "until" || d.edRep === "count") {
      if (ed.tried) clearFixedErrors();       // `input` owns them; their change lands on blur
      return;
    }
    if (d.edRep !== undefined) {
      const r = ed.f.repeat || blankRepeat();
      if (d.edRep === "preset") ed.f.repeat = repeatPick(r, String(t.value));
      else if (d.edRep === "unit" && R_UNITS.includes(t.value)) ed.f.repeat = { ...r, unit: t.value, days: [] };
      else if (d.edRep === "monthMode") ed.f.repeat = { ...r, monthMode: t.value === "weekday" ? "weekday" : "day", monthDay: null, nth: null };
      else if (d.edRep === "end") ed.f.repeat = { ...r, end: ["never", "until", "count"].includes(t.value) ? t.value : "never" };
      else return;
    } else if (d.edRepday !== undefined) {
      const r = ed.f.repeat, a = rAnchor(repDay(ed.f));
      const week = r.kind === "weekly" || (r.kind === "custom" && r.unit === "week");
      const set = new Set(r.days.length ? r.days : week && a ? [R_DAYS[a.dow]] : []);
      if (t.checked) set.add(d.edRepday); else set.delete(d.edRepday);
      ed.f.repeat = { ...r, days: rWeekOrder([...set]) };
    } else if (d.edOrg !== undefined) {
      if (ed.scope === "occurrence") return;  // a series' orgs (the box is disabled too)
      const set = new Set(ed.f.orgs);
      if (t.checked) set.add(d.edOrg); else set.delete(d.edOrg);
      ed.f.orgs = pickableOrgs(ed.f.orgs).filter((o) => set.has(o));
    } else if (d.edFlag !== undefined) {
      ed.f[d.edFlag] = !!t.checked;
      if (d.edFlag === "allDay" && t.checked && ed.f.endDate < ed.f.startDate) ed.f.endDate = ed.f.startDate;
    } else if (d.edField !== undefined) {
      // A typed field's draft is `input`'s. Its `change` fires on BLUR, and also when a
      // repaint removes the still-focused node, with the text it had then: writing that
      // back resurrected an attendee the comma had just committed (QA). And a text field
      // never repaints the panel here — a repaint on blur detaches the button the mouse
      // is pressing, and the browser drops that first click (QA: Save did nothing).
      if (d.edChipin || t.tagName === "INPUT" && t.type === "text" || t.tagName === "TEXTAREA" || t.type === "url") {
        if (ed.tried) clearFixedErrors();      // removes messages only: nothing under the pointer moves
        return;
      }
      ed.f[d.edField] = String(t.value ?? "");
      // A new start day names a new "day N" / "nth weekday" for the repeat (XERK-2973).
      if (d.edField === "startDate" && ed.f.repeat) {
        ed.f.repeat = { ...ed.f.repeat, monthDay: null, nth: null };
        refreshRepeatText();
      }
      // Moving the start keeps the length, as Teams does.
      if ((d.edField === "startDate" || d.edField === "startTime") && ed.prevStart) {
        const was = formTimes({ ...ed.f, ...ed.prevStart }), now = formTimes({ ...ed.f, endDate: ed.f.startDate, endTime: ed.f.startTime });
        if (!was.error && !now.error) {
          const len = Math.max(0, was.endMs - was.startMs);
          const p = zoneParts(now.startMs + len, ed.f.timeZone);
          ed.f.endDate = ymdOf(p);
          if (!ed.f.allDay) ed.f.endTime = `${pad(p.h)}:${pad(p.mi)}`;
          // Set in place: a date/time picker's change also lands on blur (see above).
          for (const k of ["endDate", "endTime"]) {
            const x = $edPanel.querySelector && $edPanel.querySelector(`[data-ed-field="${k}"]`);
            if (x) x.value = ed.f[k];
          }
        }
      }
      // Remember only a start that parses: Chrome fires change with "" while a time is
      // half typed, and remembering that lost the length on the next digit (QA).
      if (!formTimes({ ...ed.f, endDate: ed.f.startDate, endTime: ed.f.startTime }).error) {
        ed.prevStart = { startDate: ed.f.startDate, startTime: ed.f.startTime };
      }
      if (ed.tried) clearFixedErrors();
      return;
    } else return;
    // A checkbox's change follows its own click, so a repaint here loses nothing.
    ed.prevStart = { startDate: ed.f.startDate, startTime: ed.f.startTime };
    if (ed.tried) ed.errors = validateForm(ed.f);
    paintEditor();
  });
  $edPanel.addEventListener("focusin", () => { if (ed) ed.prevStart = { startDate: ed.f.startDate, startTime: ed.f.startTime }; });
  $edPanel.addEventListener("click", (e) => {
    if (!ed) return;
    const b = e.target && e.target.closest ? e.target.closest("[data-ed-close],[data-ed-cancel],[data-ed-save],[data-ed-unchip]") : null;
    if (!b) return;
    if (b.getAttribute && b.getAttribute("aria-disabled") === "true") return;
    const d = b.dataset;
    if (d.edClose !== undefined || d.edCancel !== undefined) { if (!ed.busy) closeEditor(); return; }
    if (d.edSave !== undefined) return void saveEditor();
    if (d.edUnchip !== undefined) {
      const [role, i] = String(d.edUnchip).split(":");
      if (Array.isArray(ed.f[role])) { ed.f[role].splice(Number(i), 1); paintEditor(true); }
    }
  });
}

function go(ms) { revealing = null; anchor = dayStart(ms); paint(true); }

function mount(el, opts = {}) {
  if ($root) return;
  $root = el;
  if (opts && typeof opts.now === "function") nowFn = opts.now;
  if (opts && typeof opts.onData === "function") onData = opts.onData;
  if (opts && typeof opts.openNotes === "function") openNotes = opts.openNotes;
  // The grid and the detail panel are separate children, painted apart; the
  // panel's capture part ($mt) is meetings.js's (showPanel).
  const mk = (tag, cls) => { const x = document.createElement(tag); if (cls) x.className = cls; return x; };
  $grid = mk("div", "cal-main");
  $side = mk("aside", "cal-detail");
  $side.setAttribute("aria-labelledby", "calDetailTitle");
  $side.tabIndex = -1;
  $side.hidden = true;
  $info = mk("div", "cal-dinfo");
  $mt = mk("div", "cal-dmt");
  $side.appendChild($info);
  $side.appendChild($mt);
  $root.appendChild($grid);
  $root.appendChild($side);
  mountEditor();
  $side.addEventListener("pointerdown", () => { sidePress = true; }, true);
  $side.addEventListener("focusout", flushSide);
  const release = () => { if (sidePress) { sidePress = false; flushSide(); } };
  if (typeof addEventListener === "function") {
    for (const n of ["pointerup", "pointercancel", "contextmenu"]) addEventListener(n, release, true);
    addEventListener("blur", (e) => { if (typeof window !== "undefined" && e.target === window) release(); });
  }
  $root.addEventListener("change", (ev) => {
    const t = ev.target, d = t && t.dataset;
    if (!d) return;
    const host = d.hostPrivate;
    // A change while that host's save is in flight is put back by the repaint.
    if ((host !== undefined && setBusy.has(host)) || (t.getAttribute && t.getAttribute("aria-disabled") === "true")) {
      return void (paint(true), paintDetail(true));
    }
    if (d.hostPrivate !== undefined) return void saveHost(d.hostPrivate, { showPrivate: !!t.checked });
    if (d.linkPick === undefined) return;
    if (t.value) linkPick.set(d.linkPick, t.value); else linkPick.delete(d.linkPick);
    paintDetail(true);
  });
  const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(`(max-width: ${NARROW_PX - 1}px)`) : null;
  narrow = !!(mq && mq.matches);
  if (mq && mq.addEventListener) mq.addEventListener("change", (e) => { narrow = !!e.matches; paint(true); });
  if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("resize", () => refit());  // never pass the Event as `keep`
  $root.addEventListener("click", (ev) => {
    const b = ev.target && ev.target.closest
      ? ev.target.closest("[data-ev],[data-step],[data-mode],[data-cal-today],[data-open-picker],[data-pick],[data-pmonth],[data-close-detail],"
        + "[data-open-notes],[data-body-toggle],[data-att-toggle],[data-link-go],[data-link-unlink],[data-link-auto],[data-host-settings],[data-zoom],[data-feed-new],[data-feed-off],[data-feed-copy],"
        + "[data-cal-new],[data-ev-edit],[data-ev-delete],[data-ev-delete-yes],[data-ev-delete-no],[data-ev-scope],[data-ev-scope-no]") : null;
    if (!b) {
      if (picker !== null && !(ev.target && ev.target.closest && ev.target.closest(".cal-picker"))) { picker = null; paint(true); }
      return;
    }
    const d = b.dataset;
    if (d.ev !== undefined) {
      const e = shown[Number(d.ev)];
      if (e) openDetail(e, { ev: evKey(e), day: d.day });
      return;
    }
    if (d.closeDetail !== undefined) return void closeDetail();
    if (d.calNew !== undefined) return void openEditor();
    if (d.evEdit !== undefined || d.evDelete !== undefined || d.evDeleteYes !== undefined || d.evDeleteNo !== undefined
        || d.evScope !== undefined || d.evScopeNo !== undefined) {
      if ((b.getAttribute && b.getAttribute("aria-disabled") === "true") || !detail || detail.source !== "turma" || detail.editable !== true) return;
      // An occurrence of a series first asks which events (XERK-2973).
      if ((d.evEdit !== undefined || d.evDelete !== undefined) && isTurmaOccurrence(detail)) {
        scopeAsk = d.evEdit !== undefined ? "edit" : "delete"; evErr = "";
        paintDetail(true);
        // The prompt replaced the pressed button: focus its first answer (Cancel for a delete).
        return void focusInfo(scopeAsk === "edit" ? '[data-ev-scope="occurrence"]' : "[data-ev-scope-no]");
      }
      if (d.evScopeNo !== undefined) {
        const was = scopeAsk;
        scopeAsk = null; paintDetail(true);
        return void focusInfo(was === "delete" ? "[data-ev-delete]" : "[data-ev-edit]");
      }
      if (d.evScope !== undefined) {
        const scope = SCOPES.some(([s]) => s === d.evScope) ? d.evScope : null;
        if (!scope || !scopeAsk) return;
        if (scopeAsk === "edit") { scopeAsk = null; paintDetail(true); return void openEditor({ event: detail, scope }); }
        return void deleteEvent(scope);
      }
      if (d.evEdit !== undefined) return void openEditor({ event: detail });
      if (d.evDelete !== undefined) { delConfirm = true; evErr = ""; paintDetail(true); return void focusInfo("[data-ev-delete-no]"); }
      if (d.evDeleteNo !== undefined) { delConfirm = false; paintDetail(true); return void focusInfo("[data-ev-delete]"); }
      return void deleteEvent();
    }
    if (d.hostSettings !== undefined) {
      hostSetOpen = !hostSetOpen;
      if (hostSetOpen && !feed.loaded) loadFeed();
      return void paint(true);
    }
    if (d.feedNew !== undefined || d.feedOff !== undefined) {
      if (b.getAttribute && b.getAttribute("aria-disabled") === "true") return;
      return void feedAction(d.feedNew !== undefined ? "new" : "off");
    }
    if (d.feedCopy !== undefined) return void copyFeed(d.feedCopy);
    if (d.openNotes !== undefined) {
      const t = notesTarget(detail, nowFn());
      if (t && openNotes) openNotes(t);
      return;
    }
    if (d.bodyToggle !== undefined) { descOpen = !descOpen; return void paintDetail(true); }
    if (d.attToggle !== undefined) { attOpen = !attOpen; return void paintDetail(true); }
    if (d.linkGo !== undefined || d.linkUnlink !== undefined || d.linkAuto !== undefined) {
      if (b.getAttribute && b.getAttribute("aria-disabled") === "true") return;
      if (d.linkUnlink !== undefined) return void relink(d.linkUnlink, { eventId: null });
      if (d.linkAuto !== undefined) return void relink(d.linkAuto, { auto: true });
      const want = linkPick.get(d.linkGo);
      const target = ((lastGot && lastGot.events) || []).find((e) => evDomKey(e) === want);
      if (target) relink(d.linkGo, { eventId: target.id }, target);
      return;
    }
    if (d.zoom !== undefined) {
      if (b.getAttribute && b.getAttribute("aria-disabled") === "true") return;
      return void zoom(Number(d.zoom));
    }
    if (d.step !== undefined) return void go(stepAnchor(anchor, mode(), Number(d.step) < 0 ? -1 : 1));
    if (d.calToday !== undefined) return void go(nowFn());
    if (d.mode !== undefined) { revealWeek = false; revealing = null; setMode(d.mode); return void paint(true); }
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
  // Ctrl/⌘ + wheel over the grid zooms (a trackpad pinch arrives as this); one step per notch.
  // A pause or a turn of direction starts a new gesture: a leftover never zooms later.
  let wheelAcc = 0, wheelAt = 0;
  $root.addEventListener("wheel", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || !(ev.target && ev.target.closest && ev.target.closest(".cal-grid"))) return;
    ev.preventDefault();
    const t = Date.now();
    // A line-mode wheel (Firefox) reports ~3 per notch: count it as pixels.
    const dy = ev.deltaMode === 1 ? ev.deltaY * 40 : ev.deltaMode === 2 ? ev.deltaY * 400 : ev.deltaY;
    if (t - wheelAt > 400 || Math.sign(dy) !== Math.sign(wheelAcc)) wheelAcc = 0;
    wheelAt = t;
    wheelAcc += dy;
    if (Math.abs(wheelAcc) < 40) return;
    zoom(wheelAcc < 0 ? 1 : -1);
    wheelAcc = 0;
  }, { passive: false });
  // Click or drag on an empty slot opens the editor on that span (XERK-2971). A
  // touch that moved is a swipe or a scroll, never a create.
  $grid.addEventListener("pointerdown", (ev) => {
    slotPress = null;
    if (ev.button !== undefined && ev.button !== 0) return;
    const t = ev.target;
    const col = t && t.closest ? t.closest(".cal-col") : null;
    if (!col || (t.closest && t.closest(".cal-ev"))) return;
    const min = slotMinAt(col, ev.clientY);
    if (min < 0) return;
    slotPress = { day: Number(col.dataset.col), min, x: ev.clientX, y: ev.clientY, touch: ev.pointerType === "touch" };
  });
  $grid.addEventListener("pointerup", (ev) => {
    const p = slotPress;
    slotPress = null;
    if (!p || ed) return;
    if (p.touch && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > 10) return;
    const col = ev.target && ev.target.closest ? ev.target.closest(".cal-col") : null;
    const end = col && Number(col.dataset.col) === p.day ? slotMinAt(col, ev.clientY) : p.min;
    const a = Math.min(p.min, end < 0 ? p.min : end), b = Math.max(p.min, end < 0 ? p.min : end) + 30;
    openEditor({ startMs: slotMs(p.day, a), endMs: slotMs(p.day, b) });
  });
  // The operator's own scroll is the new view to hold (scroll does not bubble: capture).
  $grid.addEventListener("scroll", (ev) => {
    const sc = ev.target;
    if (!sc || sc.id !== "calScroll" || !sc.clientHeight) return;
    // One-shot: the first event after a write may be ours; every later one is the operator's.
    const ours = wroteTop >= 0 && Math.abs(sc.scrollTop - wroteTop) < 1;
    wroteTop = -1;
    if (!ours) topMin = sc.scrollTop / pxPerMin(sc);
  }, true);
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
  if (!active) return void paintDetail();
  // Shown again: a failed week is asked at once, not when its back-off ends.
  for (const w of weeks.values()) if (w.err && w.retry) { clearTimeout(w.retry); w.retry = 0; }
  lastHtml = "";
  paint(true);
}

const api = {
  mount, update, setActive, refetch, upcoming, reveal,
  // pure helpers, for tests
  dayStart, addDays, weekStart, dayKey, parseDayKey, visibleDays, stepAnchor, weeksOf, rangeLabel,
  wallMinutes, fmtSpan, layoutDay, daySegments, styleOf, titleOf, inBand, onDay, offOrgs, hostNotices, noticeText,
  calendarHtml, safeHttps, isUpcomingMeeting, notesTarget, UPCOMING_MS,
  detailHtml, invitesText, invitesRowHtml, panelSpec, badgeOf, outlookStates, outlookMark, fmtLongSpan, originalStart, relink, evDomKey, hostSettingsHtml, saveHost, feedSettingsHtml, feedAction, loadFeed, feed,
  _state: () => ({ anchor, mode: mode(), weeks, detail, picker, zoomHours }),
  _zoom: zoom, ZOOMS, ZOOM_DEFAULT,
  _reopen: () => { scrolled = false; topMin = -1; paneSig = ""; wroteTop = -1; },
  _els: () => ({ grid: $grid, side: $side, info: $info, mt: $mt }),
  _go: go,
  scopedBody, blankRepeat, repeatFromRule, ruleFromRepeat, repeatSummary, repeatError, repeatPresets, repeatPick, repeatPresetOf,
  validateForm, formPayload, formFromEvent, blankForm, wallToIso, parseAttendee, normEmail, evOrgs, openEditor, closeEditor,
  saveEditor, slotMinAt,
  _ed: () => ed, _edEls: () => ({ back: $edBack, panel: $edPanel }),
  _setHooks: (o) => { if (o.onData) onData = o.onData; if (o.openNotes) openNotes = o.openNotes; },
};
if (typeof window !== "undefined") window.TurmaCalendar = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
