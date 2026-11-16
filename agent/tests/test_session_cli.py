#!/usr/bin/env python3
"""Tests for the session CLI (agent/hooks/session_cli.py, XERK-1564).

A session runs `python3 -SsE "$TURMA_SESSION_CLI" <subcommand> ...`; each
subcommand writes ONE rendezvous file under
~/.turma/session-requests/<TURMA_SESSION_ID>/ that the manager reads. The
end-to-end cases run the script exactly as a session does (a subprocess under
`-SsE`, HOME pointed at a temp dir); the rest drive main() in-process.
"""

import base64
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE_PATH = os.path.join(AGENT_DIR, "hooks", "session_cli.py")

spec = importlib.util.spec_from_file_location("session_cli", MODULE_PATH)
cli = importlib.util.module_from_spec(spec)
sys.modules["session_cli"] = cli
spec.loader.exec_module(cli)

# The manager reads what this CLI writes, so the two must agree on the
# request-file shape; load it too (its name has a dash).
_ha_spec = importlib.util.spec_from_file_location(
    "hub_agent_for_cli", os.path.join(AGENT_DIR, "hub-agent.py"))
ha = importlib.util.module_from_spec(_ha_spec)
_ha_spec.loader.exec_module(ha)


class SessionCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="session-cli-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.reqdir = os.path.join(self.tmp, "session-requests")
        p = mock.patch.object(cli, "REQUESTS_DIR", self.reqdir)
        p.start()
        self.addCleanup(p.stop)

    def run_main(self, argv, sid="abcde"):
        out, err = io.StringIO(), io.StringIO()
        env = {"TURMA_SESSION_ID": sid} if sid is not None else {}
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch.object(sys, "stdout", out), \
                mock.patch.object(sys, "stderr", err):
            if sid is None:
                os.environ.pop("TURMA_SESSION_ID", None)
            try:
                rc = cli.main(argv)
            except SystemExit as e:          # argparse usage errors
                rc = e.code
        return rc, out.getvalue(), err.getvalue()

    def read(self, name, sid="abcde"):
        with open(os.path.join(self.reqdir, sid, f"{name}.json")) as fh:
            return json.load(fh)

    # -- wake ------------------------------------------------------------------

    def test_wake_writes_the_request_and_confirms_on_one_line(self):
        before = int(time.time() * 1000)
        rc, out, _ = self.run_main(["wake", "2h", "check", "the", "CI", "run"])
        after = int(time.time() * 1000)
        self.assertEqual(rc, 0)
        self.assertEqual(out.count("\n"), 1)
        self.assertIn("2h", out)
        req = self.read("wake")
        self.assertEqual(req["reason"], "check the CI run")
        self.assertGreaterEqual(req["wakeAt"], before + 2 * 3600 * 1000)
        self.assertLessEqual(req["wakeAt"], after + 2 * 3600 * 1000)
        # ...and the manager reads exactly that file back.
        with mock.patch.object(ha, "SESSION_REQUESTS_DIR", self.reqdir):
            got = ha.read_wake_request("abcde")
        self.assertEqual(got, {"wakeAt": req["wakeAt"], "wakeReason": "check the CI run"})

    def test_a_later_double_dash_in_the_reason_is_kept(self):
        # argparse takes only the first `--` as the separator and drops later
        # ones; the bridge mod runs `wake -- <dur> <why>`, so a reason's own
        # `--` must reach the request verbatim.
        for argv, reason in ((["wake", "--", "2h", "check", "--", "foo"], "check -- foo"),
                             # The FIRST `--` is the separator wherever it sits.
                             (["wake", "2h", "check", "--", "foo", "--", "b"], "check foo -- b"),
                             (["wake", "2h", "--", "-x", "--", "--"], "-x -- --"),
                             (["wake", "--", "2h", "--", "check"], "-- check")):
            with self.subTest(argv=argv):
                rc, _, err = self.run_main(argv)
                self.assertEqual(rc, 0, err)
                self.assertEqual(self.read("wake")["reason"], reason)

    def test_durations(self):
        for text, secs in (("20m", 1200), ("2h", 7200), ("1h30m", 5400),
                           ("45s", 45), ("1d", 86400), ("7d", 7 * 86400)):
            self.assertEqual(cli.parse_duration(text), secs, text)
        for bad in ("", "0m", "10", "2x", "h", "-5m", "1.5h", "8d", "2h 3m"):
            with self.assertRaises(cli.Refused, msg=bad):
                cli.parse_duration(bad)

    def test_wake_bounds_refuse_and_write_nothing(self):
        for argv in (["wake", "2h", "x" * 201], ["wake", "0m", "r"],
                     ["wake", "8d", "r"], ["wake", "soon", "r"]):
            with self.subTest(argv=argv[:2]):
                rc, out, err = self.run_main(argv)
                self.assertEqual(rc, 2)
                self.assertEqual(out, "")
                self.assertIn("nothing was written", err)
        self.assertFalse(os.path.exists(self.reqdir))
        rc, _, _ = self.run_main(["wake", "2h", "x" * 200])
        self.assertEqual(rc, 0)

    def test_wake_needs_a_reason(self):
        rc, _, _ = self.run_main(["wake", "2h"])
        self.assertEqual(rc, 2)
        rc, _, _ = self.run_main(["wake", "2h", "   "])
        self.assertEqual(rc, 2)
        self.assertFalse(os.path.exists(self.reqdir))

    # -- close-ticket ----------------------------------------------------------

    def test_close_ticket_writes_the_request(self):
        for resolution in ("done", "not-reproducible", "already-fixed"):
            rc, out, _ = self.run_main(["close-ticket", resolution,
                                        "--note", "  reran the repro on main: passes "])
            self.assertEqual(rc, 0, resolution)
            self.assertEqual(out.count("\n"), 1)
            req = self.read("close-ticket")
            self.assertEqual(req["resolution"], resolution)
            self.assertEqual(req["note"], "reran the repro on main: passes")
            self.assertIsInstance(req["requestedAt"], int)

    def test_close_ticket_bounds(self):
        for argv in (["close-ticket", "wontfix", "--note", "n"],
                     ["close-ticket", "done"],
                     ["close-ticket", "done", "--note", "  "],
                     ["close-ticket", "done", "--note", "n" * 2001]):
            with self.subTest(argv=argv[:3]):
                rc, out, _ = self.run_main(argv)
                self.assertEqual(rc, 2)
                self.assertEqual(out, "")
        self.assertFalse(os.path.exists(self.reqdir))
        rc, _, _ = self.run_main(["close-ticket", "done", "--note", "n" * 2000])
        self.assertEqual(rc, 0)

    # -- environment -----------------------------------------------------------

    # -- shadow runs (XERK-1847) -------------------------------------------------

    def test_shadow_done_and_grade_round_trip_through_the_manager_readers(self):
        rc, out, _ = self.run_main(["shadow-done", "--note", " fixed it\n twice "])
        self.assertEqual(rc, 0)
        self.assertEqual(out.count("\n"), 1)
        rc, _, _ = self.run_main(["shadow-grade", "--verdict", "bad", "--tests", "fail",
                                  "--qa", "partial", "--design", "worse", "--note", "breaks x"])
        self.assertEqual(rc, 0)
        with mock.patch.object(ha, "SESSION_REQUESTS_DIR", self.reqdir):
            self.assertEqual(ha.read_shadow_done("abcde"), "fixed it twice")
            self.assertEqual(ha.read_shadow_grade("abcde"), {
                "verdict": "bad", "tests": "fail", "qa": "partial", "design": "worse",
                "note": "breaks x"})

    def test_shadow_bounds_refuse_and_write_nothing(self):
        for argv in (["shadow-done"], ["shadow-done", "--note", " "],
                     ["shadow-done", "--note", "n" * 2001],
                     ["shadow-grade", "--verdict", "ok", "--tests", "pass", "--qa", "pass",
                      "--design", "same", "--note", "n"],
                     ["shadow-grade", "--verdict", "good", "--tests", "pass", "--qa", "pass",
                      "--design", "same", "--note", "n" * 501]):
            with self.subTest(argv=argv[:3]):
                rc, out, _ = self.run_main(argv)
                self.assertEqual(rc, 2)
                self.assertEqual(out, "")
        self.assertFalse(os.path.exists(self.reqdir))

    def test_without_a_session_id_it_says_why_and_exits_2(self):
        for sid in (None, ""):
            rc, out, err = self.run_main(["wake", "2h", "r"], sid=sid)
            self.assertEqual(rc, 2)
            self.assertEqual(out, "")
            self.assertIn("TURMA_SESSION_ID is not set", err)
        self.assertFalse(os.path.exists(self.reqdir))

    def test_an_id_that_is_not_a_plain_name_is_refused(self):
        for sid in ("..", ".", "a/b", "../x", "-x"):
            rc, _, _ = self.run_main(["wake", "2h", "r"], sid=sid)
            self.assertEqual(rc, 2, sid)
        self.assertFalse(os.path.exists(self.reqdir))

    # -- atomic write ----------------------------------------------------------

    def test_the_write_is_atomic_and_leaves_no_temp_file(self):
        self.run_main(["wake", "20m", "first"])
        self.run_main(["wake", "40m", "second"])          # replaces in place
        folder = os.path.join(self.reqdir, "abcde")
        self.assertEqual(sorted(os.listdir(folder)), ["wake.json"])
        self.assertEqual(self.read("wake")["reason"], "second")

    def test_a_failed_write_leaves_the_old_request_and_no_temp_file(self):
        self.run_main(["wake", "20m", "first"])
        with mock.patch.object(cli.os, "replace", side_effect=OSError("disk full")):
            rc, _, err = self.run_main(["wake", "40m", "second"])
        self.assertEqual(rc, 1)
        self.assertIn("disk full", err)
        folder = os.path.join(self.reqdir, "abcde")
        self.assertEqual(sorted(os.listdir(folder)), ["wake.json"])
        self.assertEqual(self.read("wake")["reason"], "first")

    def test_the_temp_name_is_dot_prefixed_and_never_followed(self):
        seen = []
        real_open = os.open

        def spy(path, flags, mode=0o777):
            seen.append((os.path.basename(path), flags))
            return real_open(path, flags, mode)
        with mock.patch.object(cli.os, "open", side_effect=spy):
            self.run_main(["wake", "20m", "r"])
        name, flags = seen[0]
        self.assertTrue(name.startswith(".wake."), name)
        self.assertTrue(flags & os.O_EXCL)
        self.assertTrue(flags & os.O_NOFOLLOW)

    # -- as a session runs it --------------------------------------------------

    def test_end_to_end_under_the_hook_flags(self):
        home = os.path.join(self.tmp, "home")
        os.makedirs(home)
        env = {"HOME": home, "PATH": os.environ.get("PATH", ""),
               "TURMA_SESSION_ID": "s1"}
        r = subprocess.run([sys.executable, "-SsE", MODULE_PATH, "wake", "2m", "test"],
                           env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        path = os.path.join(home, ".turma", "session-requests", "s1", "wake.json")
        with open(path) as fh:
            self.assertEqual(json.load(fh)["reason"], "test")
        env.pop("TURMA_SESSION_ID")
        r = subprocess.run([sys.executable, "-SsE", MODULE_PATH, "wake", "2m", "test"],
                           env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 2)
        self.assertIn("TURMA_SESSION_ID", r.stderr)


# The COM lines of the calendar script, replaced in the pwsh drive by a fake
# Outlook object model with the same members the script touches.
_COM_LINES = """  try { $ol = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') }
  catch {
    if (Get-Process outlook -ErrorAction SilentlyContinue) {
      throw 'classic Outlook is open but did not answer: is it still starting, running as administrator (or this shell is), or is another Outlook version registered for scripts?'
    }
    if (Get-Process olk -ErrorAction SilentlyContinue) {
      throw 'only the new Outlook is open, and it cannot be read: open classic Outlook and retry'
    }
    throw 'classic Outlook is not open: open it and retry (this never starts Outlook itself)'
  }"""
_FAKE_OUTLOOK = r"""
  $ex = [pscustomobject]@{ PrimarySmtpAddress = 'bo@corp.example' }
  $exEntry = [pscustomobject]@{ Type = 'EX' }
  $exEntry | Add-Member ScriptMethod GetExchangeUser { $script:ex }
  # Live: GetExchangeUser can be empty; PR_SMTP_ADDRESS then answers.
  $pa = [pscustomobject]@{}
  $pa | Add-Member ScriptMethod GetProperty { param($t) if ($t -like '*0x39FE001E') { 'cy@corp.example' } }
  $noUser = [pscustomobject]@{ Type = 'EX'; PropertyAccessor = $pa }
  $noUser | Add-Member ScriptMethod GetExchangeUser { $null }
  $script:appts = @(
    [pscustomobject]@{ Subject = 'Standup'; StartUTC = [datetime]'2026-11-13T14:00:00'
      EndUTC = [datetime]'2026-11-13T14:15:00'; AllDayEvent = $false; Location = 'Teams'
      Organizer = 'Ana Ortiz'; BusyStatus = 2; ResponseStatus = 3; MeetingStatus = 1
      IsRecurring = $true
      Body = "Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?ctx=1 <rest>"
      Recipients = @(
        [pscustomobject]@{ Name = 'Ana Ortiz'; Type = 1; MeetingResponseStatus = 1
          Address = 'ana@corp.example'; AddressEntry = [pscustomobject]@{ Type = 'SMTP' } },
        [pscustomobject]@{ Name = 'Bo Lin'; Type = 2; MeetingResponseStatus = 4
          Address = '/o=ExchangeLabs/cn=bo'; AddressEntry = $exEntry },
        [pscustomobject]@{ Name = 'Cy Diaz'; Type = 1; MeetingResponseStatus = 0
          Address = '/o=ExchangeLabs/cn=cy'; AddressEntry = $noUser }) },
    [pscustomobject]@{ Subject = 'Focus'; StartUTC = [datetime]'2026-11-13T16:00:00'
      EndUTC = [datetime]'2026-11-13T17:00:00'; AllDayEvent = $false; Location = ''
      Organizer = ''; BusyStatus = 2; ResponseStatus = 0; MeetingStatus = 5
      IsRecurring = $false; Body = 'no link'; Recipients = @() })
  $script:found = [pscustomobject]@{ i = 0 }
  $script:found | Add-Member ScriptMethod GetFirst { $this.i = 1; $script:appts[0] }
  $script:found | Add-Member ScriptMethod GetNext {
    if ($this.i -lt $script:appts.Count) { $this.i++; $script:appts[$this.i - 1] } else { $null } }
  $script:items = [pscustomobject]@{ IncludeRecurrences = $false }
  $script:items | Add-Member ScriptMethod Sort {
    param($k) [Console]::Error.WriteLine("SORT recur=$($this.IncludeRecurrences)") }
  $script:items | Add-Member ScriptMethod Restrict {
    param($f) [Console]::Error.WriteLine("FILTER=$f recur=$($this.IncludeRecurrences)"); $script:found }
  $ol = [pscustomobject]@{ Session = [pscustomobject]@{} }
  $ol.Session | Add-Member ScriptMethod GetDefaultFolder { param($n) [pscustomobject]@{ Items = $script:items } }"""


# XERK-2895: a fake Outlook for the hub sync's reader — a recurring series
# (one plain occurrence, one MOVED exception whose id keeps its original start),
# a canceled single meeting, a private one, and an item with no id at all.
_FAKE_SYNC_OUTLOOK = r"""
  $orgEntry = [pscustomobject]@{ Type = 'SMTP'; Address = 'ana@corp.example' }
  function Appt($h) {
    $m = $script:base.Clone(); foreach ($k in $h.Keys) { $m[$k] = $h[$k] }
    $o = [pscustomobject]$m
    $o | Add-Member ScriptMethod GetOrganizer { $script:orgEntry }
    $o
  }
  # XERK-2984: the Turma writer's stamp, as a UserProperties collection.
  function UP($v) { $u = [pscustomobject]@{ v = $v }
    $u | Add-Member ScriptMethod Find { param($n) if ($n -eq 'TurmaId') { [pscustomobject]@{ Value = $this.v } } }
    $u }
  $exPa = [pscustomobject]@{}
  $exPa | Add-Member ScriptMethod GetProperty { param($t)
    if ($t -like '*/82280040') { [datetime]'2026-11-17T14:00:00' } else { throw 'no prop' } }
  $script:base = @{ AllDayEvent = $false; Location = 'Teams'; Organizer = 'Ana Ortiz'; BusyStatus = 2
    ResponseStatus = 3; MeetingStatus = 1; Recipients = @(); Categories = ''; Sensitivity = 0
    LastModificationTime = [datetime]'2026-11-01T09:30:00' }
  $script:appts = @(
    (Appt (@{ Subject = 'Standup'; GlobalAppointmentID = 'G-STANDUP'; RecurrenceState = 2
      IsRecurring = $true; StartUTC = [datetime]'2026-11-16T14:00:00'; EndUTC = [datetime]'2026-11-16T14:15:00'
      Categories = 'Team, Daily'
      Body = "Agenda`r`n`r`n`r`n`r`nJoin: https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?ctx=1" })),
    (Appt (@{ Subject = 'Standup (moved)'; GlobalAppointmentID = 'G-STANDUP'; RecurrenceState = 3
      IsRecurring = $true; StartUTC = [datetime]'2026-11-17T15:00:00'; EndUTC = [datetime]'2026-11-17T15:15:00'
      PropertyAccessor = $exPa; Body = 'moved' })),
    (Appt (@{ Subject = 'Review'; GlobalAppointmentID = 'G-REVIEW'; RecurrenceState = 0
      IsRecurring = $false; StartUTC = [datetime]'2026-11-18T16:00:00'; EndUTC = [datetime]'2026-11-18T17:00:00'
      MeetingStatus = 5; Body = ''; UserProperties = (UP 'turma:0123456789abcdef') })),
    (Appt (@{ Subject = 'Doctor'; GlobalAppointmentID = 'G-DOC'; RecurrenceState = 0
      IsRecurring = $false; StartUTC = [datetime]'2026-11-19T10:00:00'; EndUTC = [datetime]'2026-11-19T11:00:00'
      Sensitivity = 2; Body = 'private notes'; UserProperties = (UP 'turma:NOT-OURS') })),
    (Appt (@{ Subject = 'No id'; RecurrenceState = 0; IsRecurring = $false
      StartUTC = [datetime]'2026-11-20T10:00:00'; EndUTC = [datetime]'2026-11-20T11:00:00'; Body = '' })))
  $script:items = [pscustomobject]@{ IncludeRecurrences = $false }
  $script:items | Add-Member ScriptMethod Sort { param($k) }
  $script:items | Add-Member ScriptMethod Restrict { param($f)
    [Console]::Error.WriteLine("FILTER=$f")
    $r = [pscustomobject]@{ i = 0 }
    $r | Add-Member ScriptMethod GetFirst { $this.i = 1; $script:appts[0] }
    $r | Add-Member ScriptMethod GetNext {
      if ($this.i -lt $script:appts.Count) { $this.i++; $script:appts[$this.i - 1] } else { $null } }
    $r }
  $ol = [pscustomobject]@{ Session = [pscustomobject]@{} }
  $ol.Session | Add-Member ScriptMethod GetDefaultFolder { param($n) [pscustomobject]@{ Items = $script:items } }"""

SYNC_FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "calendar_sync_fixture.json")


def _w(events, **window):
    """The script's JSON for one window of `events`."""
    return {"ok": True, "windows": [dict(window, events=events)]}


ISO = r"^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$"


class CalendarTest(unittest.TestCase):
    """XERK-2884: `calendar` reads classic Outlook over COM through powershell.exe."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="session-cli-cal-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def fake_ps(self, body, shebang=True):
        path = os.path.join(self.tmp, "powershell.exe")
        with open(path, "w") as fh:
            fh.write(("#!/bin/sh\n" if shebang else "") + body)
        os.chmod(path, 0o755)
        return path

    def test_the_script_runs_against_a_fake_outlook(self):
        """The real PowerShell script, end to end, with only the COM lookup
        replaced: the loop, the recipients, the link, ConvertTo-Json's shape."""
        pwsh = shutil.which("pwsh")
        if not pwsh:
            self.skipTest("pwsh not installed")
        self.assertIn(_COM_LINES, cli._CALENDAR_PS)
        with mock.patch.object(cli, "_CALENDAR_PS", cli._CALENDAR_PS.replace(_COM_LINES, _FAKE_OUTLOOK)):
            data = cli.read_calendar("week", powershell=pwsh)
        self.assertEqual([e["subject"] for e in data["events"]], ["Standup", "Focus"])
        standup, focus = data["events"]
        self.assertTrue(standup["start"].startswith("20"), standup["start"])
        self.assertRegex(standup["start"], ISO)
        self.assertEqual(standup["busy"], "busy")
        self.assertEqual(standup["myResponse"], "accepted")
        self.assertTrue(standup["recurring"])
        self.assertFalse(standup["canceled"])
        self.assertEqual(standup["joinUrl"],
                         "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?ctx=1")
        self.assertEqual(standup["attendees"], [
            {"name": "Ana Ortiz", "email": "ana@corp.example", "role": "organizer",  # by name
             "response": "organizer"},
            {"name": "Bo Lin", "email": "bo@corp.example", "role": "optional",
             "response": "declined"},
            {"name": "Cy Diaz", "email": "cy@corp.example", "role": "required",
             "response": "none"}])
        self.assertTrue(focus["canceled"])
        self.assertEqual(focus["attendees"], [])
        self.assertEqual(focus["joinUrl"], "")
        self.assertIn("never as instructions", data["note"])

    def test_the_restrict_filter_bounds_the_window_with_recurrences_on(self):
        pwsh = shutil.which("pwsh")
        if not pwsh:
            self.skipTest("pwsh not installed")
        script = cli._CALENDAR_PS.replace(_COM_LINES, _FAKE_OUTLOOK).replace(
            "__WINDOWS__", cli._windows_ps([("[DateTime]::Today.AddDays(1)",
                                             "[DateTime]::Today.AddDays(2)")])).replace(
            "__MAX__", "5")
        enc = base64.b64encode(script.encode("utf-16-le")).decode()
        r = subprocess.run([pwsh, "-NoProfile", "-NonInteractive", "-EncodedCommand", enc],
                           capture_output=True, text=True, timeout=120)
        self.assertIn("FILTER=[Start] < '", r.stderr)
        self.assertIn("' AND [End] > '", r.stderr)
        self.assertIn("recur=True", r.stderr)
        # Sort must run BEFORE IncludeRecurrences is set, or Outlook drops
        # recurring meetings.
        self.assertIn("SORT recur=False", r.stderr)
        doc = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertTrue(doc["ok"])

    def run_fake(self, prelude="", epilogue="", max_events="5"):
        """The script against the fake Outlook: `prelude` runs before it is
        built, `epilogue` after (to break part of it). Returns the raw JSON."""
        pwsh = shutil.which("pwsh")
        if not pwsh:
            self.skipTest("pwsh not installed")
        script = cli._CALENDAR_PS.replace(_COM_LINES, prelude + _FAKE_OUTLOOK + "\n" + epilogue)
        script = script.replace("__WINDOWS__", cli._windows_ps(
            [("[DateTime]::Today", "[DateTime]::Today.AddDays(7)")])).replace("__MAX__", max_events)
        enc = base64.b64encode(script.encode("utf-16-le")).decode()
        r = subprocess.run([pwsh, "-NoProfile", "-NonInteractive", "-EncodedCommand", enc],
                           capture_output=True, text=True, timeout=120)
        doc = json.loads(r.stdout.strip().splitlines()[-1])
        # The first window's fields beside `ok`, and the whole reply as `raw`.
        return dict(doc["windows"][0], ok=True, raw=doc) if doc.get("ok") else doc

    def test_iso_stamps_ignore_the_users_culture(self):
        """fi-FI writes '.' for ':', th-TH a Buddhist year, ar-SA a Hijri one."""
        for culture in ("fi-FI", "th-TH", "ar-SA"):
            doc = self.run_fake(
                prelude=f"  [Threading.Thread]::CurrentThread.CurrentCulture = '{culture}'\n")
            self.assertTrue(doc["ok"], (culture, doc))
            ev = doc["events"][0]
            for v in (doc["from"], doc["until"], ev["start"], ev["end"]):
                self.assertRegex(v, ISO, culture)

    def test_the_script_caps_its_own_loop(self):
        self.assertEqual(len(self.run_fake(max_events="1")["events"]), 1)

    def test_one_unreadable_item_is_skipped_not_fatal(self):
        doc = self.run_fake(epilogue=(
            "  $script:appts[1].StartUTC = 'not a date'"))      # Iso's SpecifyKind throws
        self.assertTrue(doc["ok"], doc)
        self.assertEqual([e["subject"] for e in doc["events"]], ["Standup"])
        self.assertEqual(doc["skipped"], 1)
        self.assertEqual(cli.normalize_calendar(doc["raw"])["unreadable"], 1)

    def test_every_item_failing_reports_outlooks_reason(self):
        """A security-prompt denial throws on every item: the read stops after a
        few with Outlook's message instead of returning an empty calendar."""
        breaker = "".join(
            f"  $script:appts += [pscustomobject]@{{ Subject = 'x{i}'; StartUTC = 'denied' }}\n"
            for i in range(10))
        doc = self.run_fake(epilogue=(
            "  $script:appts = @()\n" + breaker))
        self.assertFalse(doc["ok"], doc)
        with self.assertRaisesRegex(cli.Refused, "Outlook could not be read: .+"):
            cli.normalize_calendar(doc)

    def test_a_lookalike_zoom_domain_is_not_a_join_link(self):
        doc = self.run_fake(epilogue=(
            "  $script:appts[1].Body = 'https://evilzoom.us/j/1 or https://acme.zoom.us/j/2'"))
        self.assertEqual(doc["events"][1]["joinUrl"], "https://acme.zoom.us/j/2")

    def test_each_unreachable_outlook_case_says_which(self):
        """A shadowing Get-Process stands in for which Outlook processes run."""
        pwsh = shutil.which("pwsh")
        if not pwsh:
            self.skipTest("pwsh not installed")
        for running, said in ((["outlook"], "open but did not answer"),
                              (["outlook", "olk"], "open but did not answer"),
                              (["olk"], "only the new Outlook is open")):
            names = ",".join(f"'{n}'" for n in running)
            shadow = ("function Get-Process { [CmdletBinding()] param([string[]]$Name) "
                      f"if (@({names}) -contains $Name[0]) {{ 1 }} }}\n")
            with mock.patch.object(cli, "_CALENDAR_PS", shadow + cli._CALENDAR_PS):
                with self.assertRaisesRegex(cli.Refused, said, msg=running):
                    cli.read_calendar("today", powershell=pwsh)

    def test_outlook_not_open_is_reported_never_started(self):
        """The real script with no Outlook to attach to (pwsh has no
        GetActiveObject, as a PC with Outlook closed has nothing to attach to):
        it says to open Outlook, and never tries to start one itself."""
        pwsh = shutil.which("pwsh")
        if not pwsh:
            self.skipTest("pwsh not installed")
        self.assertNotIn("New-Object -ComObject", cli._CALENDAR_PS)
        with self.assertRaisesRegex(cli.Refused, "classic Outlook is not open"):
            cli.read_calendar("today", powershell=pwsh)

    def test_an_outlook_error_is_reported_not_printed_as_events(self):
        ps = self.fake_ps("echo '{\"ok\":false,\"error\":\"Class not registered\"}'\n")
        with self.assertRaisesRegex(cli.Refused, "Class not registered"):
            cli.read_calendar("today", powershell=ps)

    def test_noise_before_the_json_is_ignored(self):
        ps = self.fake_ps("echo 'banner'\necho '{\"ok\":true,\"windows\":[{\"events\":[]}]}'\n")
        self.assertEqual(cli.read_calendar("today", powershell=ps)["events"], [])

    def test_no_json_names_the_exit_and_stderr(self):
        ps = self.fake_ps("echo boom >&2\nexit 3\n")
        with self.assertRaisesRegex(cli.Refused, r"exit 3\): boom"):
            cli.read_calendar("today", powershell=ps)

    def test_a_hung_outlook_times_out(self):
        ps = self.fake_ps("exec sleep 5\n")   # exec: no orphan holds the pipe open
        with mock.patch.object(cli, "CALENDAR_TIMEOUT_SEC", 0.5):
            with self.assertRaisesRegex(cli.Refused, "did not answer"):
                cli.read_calendar("today", powershell=ps)

    def _interop_off(self, state, conf=None, entry="WSLInterop"):
        """ENOEXEC from a fake .exe, with the `entry` binfmt entry in `state`
        (None = not registered) and `conf` as /etc/wsl.conf."""
        ps = self.fake_ps("\x7fELF-not-really", shebang=False)
        binfmt = os.path.join(self.tmp, "binfmt")
        os.makedirs(binfmt, exist_ok=True)
        if state is not None:
            with open(os.path.join(binfmt, entry), "w") as fh:
                fh.write(f"{state}\ninterpreter /init\nflags: PF\n")
        wsl_conf = os.path.join(self.tmp, "wsl.conf")
        if conf is not None:
            with open(wsl_conf, "w") as fh:
                fh.write(conf)
        with mock.patch.object(cli, "BINFMT_MISC", binfmt), \
                mock.patch.object(cli, "WSL_CONF", wsl_conf):
            with self.assertRaises(cli.Refused) as cm:
                cli.read_calendar("today", powershell=ps)
        msg = str(cm.exception)
        self.assertIn("Exec format error", msg)
        self.assertLessEqual(len(msg.replace(ps, "/mnt/c/Windows/System32/WindowsPowerShell/"
                                             "v1.0/powershell.exe")), 300)
        return msg

    def test_interop_unregistered_names_the_fix(self):
        """XERK-2938: systemd on WSL dropped the WSLInterop binfmt entry."""
        msg = self._interop_off(None)
        self.assertIn("WSL interop is not registered", msg)
        self.assertIn("re-run the Turma agent installer", msg)

    def test_interop_disabled_names_the_fix(self):
        msg = self._interop_off("disabled")
        self.assertIn("echo 1 | sudo tee", msg)

    def test_interop_late_entry_counts_as_registered(self):
        msg = self._interop_off("disabled", entry="WSLInterop-late")
        self.assertIn("WSLInterop-late", msg)

    def test_interop_off_in_wsl_conf_is_named_not_the_installer(self):
        """The installer refuses to override wsl.conf, so never send the
        operator there; every spelling WSL reads as false counts."""
        for conf in ("[interop]\nenabled=false\n", "[interop]\nenabled=0\n",
                     '[interop] # x\nEnabled = "False" # no\n',
                     "[boot]\nsystemd=true\r\n[interop]\r\nenabled=false\r\nenabled=true\r\n",
                     "[interop]\nenabled=false\n[interop]\nenabled=true\n",
                     '[interop]\nenabled="false\nenabled=false\n',
                     '[interop]\nenabled="true\nenabled=false\n',
                     '[interop]\nenabled="fal"se\n', '[interop]\nenabled=fa"lse"\n',
                     "#\n" * 40000 + "[interop]\nenabled=false\n"):
            with self.subTest(conf=conf[-60:]):
                msg = self._interop_off(None, conf=conf)
                self.assertIn("turned off in", msg)
                self.assertNotIn("installer", msg)
        # WSL keeps the FIRST value, even an invalid one; only `"` quotes; inner
        # spaces and a `#` inside quotes are part of the value.
        for conf in ("[automount]\nenabled=false\n", "[interop]\nenabled=true\nenabled=false\n",
                     "[interop]\nenabled=off\nenabled=false\n", "[interop]\n#enabled=false\n",
                     "[interop]\nenabled='false'\n", '[interop]\nenabled="false#x"\n',
                     "[interop]\nenabled = fal se\n",
                     '[interop]\nenabled="false\n', '[interop]\nenabled="false "\n'):
            with self.subTest(conf=conf):
                self.assertIn("not registered", self._interop_off(None, conf=conf))

    def test_interop_enabled_but_failing_is_still_named(self):
        self.assertIn("interop looks off", self._interop_off("enabled"))

    def test_the_range_is_only_ever_two_integers(self):
        ps = self.fake_ps('echo "$6" > "$(dirname "$0")/enc"\necho \'{"ok":true,"windows":[{"events":[]}]}\'\n')
        cli.read_calendar("tomorrow", powershell=ps)
        with open(os.path.join(self.tmp, "enc")) as fh:
            script = base64.b64decode(fh.read().strip()).decode("utf-16-le")
        self.assertIn("$day = [DateTime]::Today.AddDays(1)\n", script)
        self.assertIn("@(($day), ($day.AddDays(1)))", script)
        self.assertNotIn("__", script)

    def test_normalize_types_cleans_and_caps(self):
        evil = "Sync\u202e\x1b[31m" + "x" * 1000
        data = cli.normalize_calendar(_w([
            {"subject": evil, "busy": "2", "myResponse": True, "status": 7,
             "joinUrl": "javascript:alert(1)", "attendees": [{"name": 5, "type": 9}] * 300},
            "not an event"]))
        (e,) = data["events"]
        self.assertNotIn("\u202e", e["subject"])
        self.assertNotIn("\x1b", e["subject"])
        self.assertEqual(len(e["subject"]), cli.CALENDAR_TEXT_MAX)
        self.assertEqual((e["busy"], e["myResponse"]), ("unknown", "unknown"))
        self.assertTrue(e["canceled"])
        self.assertEqual(e["joinUrl"], "")
        self.assertEqual(len(e["attendees"]), cli.CALENDAR_ATTENDEES_MAX)
        self.assertEqual(e["attendees"][0], {"name": "", "email": "", "role": "unknown",
                                             "response": "unknown"})
        for line in ("a\u2028b", "a\u2029b", "a\u061cb", "a\u2060b", "a\nb"):
            got = cli.normalize_calendar(_w([
                {"subject": line, "attendees": []}]))["events"][0]["subject"]
            self.assertEqual(got, "a b", repr(line))
        self.assertEqual(cli._text("Inter\xadnational"), "International")
        got = cli.normalize_calendar(_w([{"organizer": "Ana", "attendees": [
            {"name": "Ana", "type": 1, "email": "/o=ExchangeLabs/ou=x/cn=ana"},
            {"name": "Bo", "type": 1, "email": "bo@corp.example"}]}]))["events"][0]["attendees"]
        self.assertEqual([(a["role"], a["email"]) for a in got],
                         [("organizer", ""), ("required", "bo@corp.example")])
        got = cli.normalize_calendar(_w([{"organizer": "Ana", "attendees": [
            {"name": "Ana", "type": 2}, {"name": "Ana", "type": 1, "email": "/o=X/cn=a@b.c"},
            {"name": "Ana", "type": 1, "email": "x ana@corp.example"}, {"name": "", "type": 1}]},
            {"organizer": "", "attendees": [{"name": "", "type": 1}]}]))["events"]
        self.assertEqual([(a["role"], a["email"]) for a in got[0]["attendees"]],
                         [("optional", ""), ("organizer", ""), ("required", ""), ("required", "")])
        self.assertEqual(got[1]["attendees"][0]["role"], "required")
        self.assertNotIn("unreadable", cli.normalize_calendar(
            _w([], skipped=-1)))
        for bad in (None, [], {"ok": "true"}, {"ok": True},
                    {"ok": True, "events": {"value": [{"subject": "x"}], "Count": 1}},
                    _w([{"subject": "x", "attendees": {"name": "a"}}])):
            with self.assertRaises(cli.Refused):
                cli.normalize_calendar(bad)

    def script_for(self, *args, **kw):
        ps = self.fake_ps('echo "$6" > "$(dirname "$0")/enc"\necho \'{"ok":true,"windows":[{"events":[]}]}\'\n')
        cli.read_calendar(*args, powershell=ps, **kw)
        with open(os.path.join(self.tmp, "enc")) as fh:
            return base64.b64decode(fh.read().strip()).decode("utf-16-le")

    def test_a_date_and_a_span_reach_the_script_as_integers(self):
        """XERK-2903: a session asking about last Friday names its date."""
        s = self.script_for("2026-11-13")
        self.assertIn("$day = (New-Object DateTime 2026, 11, 13)\n", s)
        self.assertIn("@(($day), ($day.AddDays(1)))", s)
        s = self.script_for("yesterday", days=3)
        self.assertIn("$day = [DateTime]::Today.AddDays(-1)\n", s)
        self.assertIn("@(($day), ($day.AddDays(3)))", s)
        for edge in ("1900-01-01", "2999-12-31"):     # the year bounds are inclusive
            self.assertIn("New-Object DateTime", self.script_for(edge, days=31))

    def test_the_real_script_reads_a_dated_window(self):
        pwsh = shutil.which("pwsh")
        if not pwsh:
            self.skipTest("pwsh not installed")
        start, n = cli.calendar_window("2026-11-13", 2)
        script = cli._CALENDAR_PS.replace(_COM_LINES, _FAKE_OUTLOOK).replace(
            "__WINDOWS__", cli._windows_ps([(start, f"{start}.AddDays({n})")])).replace(
            "__MAX__", "5")
        enc = base64.b64encode(script.encode("utf-16-le")).decode()
        r = subprocess.run([pwsh, "-NoProfile", "-NonInteractive", "-EncodedCommand", enc],
                           capture_output=True, text=True, timeout=120)
        doc = json.loads(r.stdout.strip().splitlines()[-1])["windows"][0]
        self.assertTrue(doc["from"].startswith("2026-11-13T00:00:00"), doc)
        self.assertTrue(doc["until"].startswith("2026-11-15T00:00:00"), doc)

    def test_a_bad_date_or_span_exits_2_before_powershell(self):
        for argv in (["calendar", "2026-13-01"], ["calendar", "friday"],
                     ["calendar", "2026-11-13; rm -rf /"], ["calendar", "2026-1-3"], ["calendar", "20261113"],
                     ["calendar", "2026-W46-5"], ["calendar", "9999-12-31"],
                     ["calendar", "0001-01-01"],
                     ["calendar", "today", "--days", "0"], ["calendar", "week", "--days", "32"]):
            err = io.StringIO()
            with mock.patch.object(cli, "find_powershell") as find, \
                    mock.patch.object(sys, "stderr", err):
                self.assertEqual(cli.main(argv), 2, argv)
            find.assert_not_called()
            self.assertIn("calendar:", err.getvalue())

    def test_calendar_needs_no_session_id_and_writes_nothing(self):
        reqdir = os.path.join(self.tmp, "session-requests")
        out, err = io.StringIO(), io.StringIO()
        ps = self.fake_ps("echo '{\"ok\":true,\"windows\":[{\"events\":[]}]}'\n")
        with mock.patch.object(cli, "REQUESTS_DIR", reqdir), \
                mock.patch.object(cli, "find_powershell", return_value=ps), \
                mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(sys, "stdout", out), mock.patch.object(sys, "stderr", err):
            os.environ.pop("TURMA_SESSION_ID", None)
            rc = cli.main(["calendar"])
        self.assertEqual(rc, 0, err.getvalue())
        self.assertEqual(json.loads(out.getvalue())["events"], [])
        self.assertFalse(os.path.exists(reqdir))

    def test_no_powershell_exits_1_saying_why(self):
        err = io.StringIO()
        with mock.patch.object(cli, "find_powershell", return_value=None), \
                mock.patch.object(sys, "stderr", err):
            self.assertEqual(cli.main(["calendar", "week"]), 1)
        self.assertIn("WSL or Windows host", err.getvalue())

    def test_find_powershell_falls_back_to_the_automount(self):
        hit = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
        with mock.patch.object(cli.shutil, "which", return_value=None), \
                mock.patch.object(cli.glob, "glob", return_value=[hit]):
            self.assertEqual(cli.find_powershell(), hit)


class CalendarSyncReaderTest(unittest.TestCase):
    """XERK-2895: the hub sync's reader — arbitrary epoch-ms windows, the
    contract's extra fields, and a window the cap truncated never `complete`."""

    WEEK = 7 * 86400000
    MON = 1794787200000          # 2026-11-16T00:00Z, a Monday

    def run_sync(self, windows, max_events=50):
        pwsh = shutil.which("pwsh")
        if not pwsh:
            self.skipTest("pwsh not installed")
        with mock.patch.object(cli, "_CALENDAR_PS", cli._CALENDAR_PS.replace(_COM_LINES, _FAKE_SYNC_OUTLOOK)):
            return cli.read_calendar_windows(windows, powershell=pwsh, max_events=max_events)

    def test_the_real_script_reads_full_events_per_window(self):
        (w,) = self.run_sync([(self.MON, self.MON + self.WEEK)])
        self.assertTrue(w["complete"])
        self.assertEqual(w["unreadable"], 1)              # the item with no id
        by = {e["subject"]: e for e in w["events"]}
        self.assertEqual(set(by), {"Standup", "Standup (moved)", "Review", "Doctor"})
        st, mv, rv, dr = by["Standup"], by["Standup (moved)"], by["Review"], by["Doctor"]
        self.assertEqual(st["id"], "G-STANDUP:2026-11-16T14:00:00Z")
        # A moved exception keeps the id its occurrence had: its ORIGINAL start.
        self.assertEqual(mv["id"], "G-STANDUP:2026-11-17T14:00:00Z")
        self.assertEqual((st["seriesId"], mv["seriesId"], rv["seriesId"]), ("G-STANDUP", "G-STANDUP", ""))
        self.assertEqual(rv["id"], "G-REVIEW")
        self.assertTrue(rv["canceled"])
        self.assertEqual(st["categories"], ["Team", "Daily"])
        self.assertEqual(st["body"], "Agenda\n\nJoin: https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?ctx=1")
        self.assertTrue(st["isOnlineMeeting"])
        self.assertFalse(rv["isOnlineMeeting"])
        self.assertEqual(st["organizerEmail"], "ana@corp.example")
        self.assertRegex(st["lastModified"], ISO)
        self.assertEqual((st["sensitivity"], dr["sensitivity"]), ("normal", "private"))
        self.assertRegex(mv["start"], ISO)
        # XERK-2984: the stamp, kept only in its own shape.
        self.assertEqual((rv["turmaId"], dr["turmaId"], st["turmaId"]),
                         ("turma:0123456789abcdef", "", ""))

    def test_several_windows_in_one_run_and_the_cap_marks_incomplete(self):
        wins = [(self.MON, self.MON + self.WEEK), (self.MON + self.WEEK, self.MON + 2 * self.WEEK)]
        got = self.run_sync(wins, max_events=2)
        self.assertEqual(len(got), 2)
        for w in got:
            self.assertFalse(w["complete"])               # 5 items, cap 2
            self.assertEqual(len(w["events"]), 2)
        got = self.run_sync(wins, max_events=5)
        self.assertTrue(all(w["complete"] for w in got))  # exactly the cap is complete

    def test_only_integers_reach_the_script(self):
        ps = os.path.join(tempfile.mkdtemp(prefix="cal-sync-"), "powershell.exe")
        self.addCleanup(shutil.rmtree, os.path.dirname(ps), ignore_errors=True)
        with open(ps, "w") as fh:
            fh.write('#!/bin/sh\necho "$6" > "$(dirname "$0")/enc"\n'
                     'echo \'{"ok":true,"windows":[{"events":[],"complete":true}]}\'\n')
        os.chmod(ps, 0o755)
        self.assertEqual(cli.read_calendar_windows([(self.MON, self.MON + 1)], powershell=ps),
                         [{"complete": True, "unreadable": 0, "events": []}])
        with open(os.path.join(os.path.dirname(ps), "enc")) as fh:
            script = base64.b64decode(fh.read().strip()).decode("utf-16-le")
        self.assertIn(f"FromUnixTimeMilliseconds({self.MON}).LocalDateTime", script)
        self.assertIn(f"$out.Count -lt {cli.CALENDAR_SYNC_WINDOW_MAX}", script)
        self.assertNotIn("__", script)
        for bad in ([], [(1, 1)], [(2, 1)], [("1", 2)], [(True, 5)], [(0, 5)], [(1.5, 9)],
                    [(1, cli.CALENDAR_MS_MAX)], [(1, 2, 3)], ["12"]):
            with self.assertRaises(cli.Refused, msg=bad):
                cli.calendar_windows_ps(bad)

    def test_a_window_count_mismatch_is_refused(self):
        doc = {"ok": True, "windows": [{"events": []}]}
        with self.assertRaisesRegex(cli.Refused, "1 windows for 2"):
            cli.normalize_calendar_windows(doc, 2)

    def test_the_recorded_fixture(self):
        """A reply recorded from the real script (recurring occurrence, moved
        exception, canceled meeting, private event, an id-less item)."""
        with open(SYNC_FIXTURE, encoding="utf-8") as fh:
            doc = json.load(fh)
        (w,) = cli.normalize_calendar_windows(doc, 1)
        self.assertEqual(sorted(e["id"] for e in w["events"]),
                         ["G-DOC", "G-REVIEW", "G-STANDUP:2026-11-16T14:00:00Z",
                          "G-STANDUP:2026-11-17T14:00:00Z"])
        self.assertEqual({e["id"]: e["turmaId"] for e in w["events"]}["G-REVIEW"],
                         "turma:0123456789abcdef")
        # The session view of the same reply drops the sync's fields and the body.
        printed = cli.normalize_calendar(doc)["events"][0]
        self.assertNotIn("body", printed)
        self.assertNotIn("id", printed)

    def test_full_fields_are_typed_and_capped(self):
        e = {"globalId": "G‮1", "recurrenceState": 2, "originalStart": "2026-01-01T00:00:00Z",
             "attendees": [{"name": "Ana", "type": 1, "email": "ana@x.example"}], "organizer": "Ana",
             "body": "a\x00b‮\r\n" + "y" * 9000, "categories": ["  x ", 5, ""] + ["c"] * 40,
             "sensitivity": "2", "organizerEmail": "/o=ExchangeLabs/cn=ana"}
        (w,) = cli.normalize_calendar_windows({"ok": True, "windows": [{"events": [e]}]}, 1)
        (ev,) = w["events"]
        self.assertEqual(ev["id"], "G 1:2026-01-01T00:00:00Z")
        self.assertEqual(ev["seriesId"], "G 1")
        self.assertEqual(len(ev["body"]), cli.CALENDAR_BODY_MAX)
        self.assertTrue(ev["body"].startswith("a b\ny"))
        self.assertEqual(ev["categories"], ["x"] + ["c"] * 17)
        self.assertEqual(ev["sensitivity"], "private")     # unreadable errs private
        self.assertEqual(ev["organizerEmail"], "ana@x.example")
        self.assertFalse(ev["isOnlineMeeting"])


# XERK-2984: a fake Outlook for the Turma writer — a store of appointments by
# EntryID (one the user made, never stamped), GetItemFromID, a DASL Find on the
# stamp, CreateItem, TimeZones (one Outlook lacks), and Save/Delete/Send that log
# what they did to stderr. Send throws: the writer must never call it.
_FAKE_WRITE_OUTLOOK = r"""
  $script:store = [ordered]@{}
  $script:n = 0
  $script:cal = [pscustomobject]@{ EntryID = 'CAL'; Items = $null }
  $script:bin = [pscustomobject]@{ EntryID = 'BIN' }
  function NewItem($id) {
    $it = [pscustomobject]@{ EntryID = $id; Subject = ''; Location = ''; Body = ''; BusyStatus = 2
      Sensitivity = 0; Categories = ''; AllDayEvent = $false; ReminderSet = $true
      StartTimeZone = $null; EndTimeZone = $null; StartInStartTimeZone = $null; EndInEndTimeZone = $null
      StartUTC = [datetime]'2026-11-18T12:00:00'; EndUTC = [datetime]'2026-11-18T13:00:00'
      LastModificationTime = [datetime]'2026-11-16T09:30:00'; props = @{}; Parent = $script:cal
      MeetingStatus = 0; ResponseRequested = $true; mapi = @{} }
    # Recipients (XERK-2989): a 1-based list, as Outlook's.
    $rl = [pscustomobject]@{ list = (New-Object System.Collections.ArrayList) }
    $rl | Add-Member ScriptProperty Count { $this.list.Count }
    $rl | Add-Member ScriptMethod Item { param($i) $this.list[$i - 1] }
    $rl | Add-Member ScriptMethod Remove { param($i) $this.list.RemoveAt($i - 1) }
    $rl | Add-Member ScriptMethod Add { param($a)
      $r = [pscustomobject]@{ Address = $a; Type = 1; AddressEntry = $null }; [void]$this.list.Add($r); $r }
    $rl | Add-Member ScriptMethod ResolveAll { $true }
    $it | Add-Member NoteProperty Recipients $rl
    $pa = [pscustomobject]@{ owner = $it }
    $pa | Add-Member ScriptMethod SetProperty { param($k, $v) $this.owner.mapi[$k] = $v }
    $it | Add-Member NoteProperty PropertyAccessor $pa
    $up = [pscustomobject]@{ owner = $it }
    $up | Add-Member ScriptMethod Find { param($k) $this.owner.props[$k] }
    $up | Add-Member ScriptMethod Add { param($k, $t, $f)
      [Console]::Error.WriteLine("ADDPROP $k type=$t folder=$f")
      $p = [pscustomobject]@{ Value = '' }; $this.owner.props[$k] = $p; $p }
    $it | Add-Member NoteProperty UserProperties $up
    $it | Add-Member ScriptMethod Save {
      if (-not $this.EntryID) { $script:n++; $this.EntryID = "E$($script:n)" }
      $script:store[$this.EntryID] = $this
      $z = [TimeZoneInfo]::FindSystemTimeZoneById($this.StartTimeZone.ID)
      $this.StartInStartTimeZone = [TimeZoneInfo]::ConvertTimeFromUtc($this.StartUTC, $z)
      $st = ''; if ($this.props['TurmaId']) { $st = $this.props['TurmaId'].Value }
      $sent = ''; if ($this.props['TurmaSent']) { $sent = $this.props['TurmaSent'].Value }
      [Console]::Error.WriteLine('SAVE ' + (ConvertTo-Json -Compress -InputObject @{
        id = $this.EntryID; stamp = $st; subject = $this.Subject; location = $this.Location
        body = $this.Body; busy = $this.BusyStatus; sens = $this.Sensitivity; cats = $this.Categories
        allDay = $this.AllDayEvent; reminder = $this.ReminderSet; tz = $this.StartTimeZone.ID
        wall = $this.StartInStartTimeZone.ToString('s')
        startUtc = $this.StartUTC.ToString('s'); endUtc = $this.EndUTC.ToString('s')
        status = $this.MeetingStatus; sent = $sent; resp = $this.ResponseRequested
        dnf = $this.mapi.Values | Select-Object -First 1
        to = @($this.Recipients.list | ForEach-Object { "$($_.Address):$($_.Type)" }) })) }
    $it | Add-Member ScriptMethod Delete {
      [Console]::Error.WriteLine("DELETE $($this.EntryID)"); $script:store.Remove($this.EntryID) }
    $it | Add-Member ScriptMethod Send {
      if ($script:failSend -or ($this.Subject -eq 'Boom' -and $this.MeetingStatus -eq 1)) { throw 'The send failed.' }
      [Console]::Error.WriteLine("SEND $($this.EntryID) status=$($this.MeetingStatus) to=" +
        (@($this.Recipients.list | ForEach-Object { $_.Address }) -join ',')) }
    $it
  }
  $mine = NewItem 'U1'; $mine.Subject = 'My own lunch'; $script:store['U1'] = $mine
  # A stamp in the wrong case (PowerShell's -eq would match it), and a real
  # copy the user deleted to Deleted Items: neither is the copy.
  $odd = NewItem 'T9'; $odd.props['TurmaId'] = [pscustomobject]@{ Value = 'TURMA:DDDDDDDDDDDDDDDD' }
  $script:store['T9'] = $odd
  $gone = NewItem 'B7'; $gone.Parent = $script:bin
  $gone.props['TurmaId'] = [pscustomobject]@{ Value = 'turma:9999999999999999' }; $script:store['B7'] = $gone
  $items = [pscustomobject]@{}
  $items | Add-Member ScriptMethod Find { param($f)
    [Console]::Error.WriteLine("FIND $f")
    if ($f -match "TurmaId"" = '([^']*)'$") {
      foreach ($it in $script:store.Values) {
        if ($it.Parent -eq $script:cal -and $it.props['TurmaId'] -and
            $it.props['TurmaId'].Value -eq $Matches[1]) { return $it } } }
    $null }
  $tzs = [pscustomobject]@{}
  $tzs | Add-Member ScriptMethod Item { param($id)
    if ($id -eq 'Russia Time Zone 11') { throw 'no such zone' }
    [pscustomobject]@{ ID = $id } }
  $ol = [pscustomobject]@{ Session = [pscustomobject]@{
    CurrentUser = [pscustomobject]@{ Address = 'Me@Example.com'; AddressEntry = $null } }; TimeZones = $tzs }
  $ol.Session | Add-Member ScriptMethod GetItemFromID { param($id)
    if ($script:store.Contains($id)) { $script:store[$id] } else { throw 'The operation failed.' } }
  $script:cal.Items = $items
  $ol.Session | Add-Member ScriptMethod GetDefaultFolder { param($n) $script:cal }
  $ol.Session | Add-Member ScriptMethod CompareEntryIDs { param($a, $b) $a -ceq $b }
  $script:items = $items
  $ol | Add-Member ScriptMethod CreateItem { param($t) [Console]::Error.WriteLine("CREATE $t"); NewItem '' }"""

WRITE_FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "calendar_write_fixture.json")


class CalendarWriteTest(unittest.TestCase):
    """XERK-2984: the Turma writer — commands typed and capped before the
    script, find-before-create on the stamp (so a replay never duplicates), a
    foreign EntryID never edited, Save without Send, an absent copy's delete ok."""

    MON = 1794787200000          # 2026-11-16T00:00Z, a Monday
    A, B, C, D, K = ("turma:" + c * 16 for c in "abcde")

    def up(self, tid, **ev):
        e = {"subject": "Plan", "start": "2026-11-16T09:00:00-05:00",
             "end": "2026-11-16T10:00:00-05:00", "timeZone": "America/New_York"}
        e.update(ev)
        return {"op": "upsert", "turmaId": tid, "outlookId": "", "event": e}

    def run_write(self, cmds):
        """The real script under pwsh against _FAKE_WRITE_OUTLOOK: (results, stderr lines)."""
        pwsh = shutil.which("pwsh")
        if not pwsh:
            self.skipTest("pwsh not installed")
        seen = {}
        real = cli.subprocess.run

        def run(*a, **kw):
            seen["proc"] = real(*a, **kw)
            return seen["proc"]
        with mock.patch.object(cli, "_CALENDAR_WRITE_PS",
                               cli._CALENDAR_WRITE_PS.replace(_COM_LINES, _FAKE_WRITE_OUTLOOK)), \
                mock.patch.object(cli.subprocess, "run", side_effect=run):
            got = cli.write_calendar_events(cmds, powershell=pwsh)
        err = seen["proc"].stderr.decode("utf-8", "replace").splitlines()
        return got, err, seen["proc"].stdout.decode("utf-8-sig").strip().splitlines()[-1]

    def test_the_real_script_upserts_finds_its_copy_and_deletes(self):
        cmds = [
            self.up(self.A, body="Agenda", joinUrl="https://teams.microsoft.com/l/x",
                    categories=["Team", "Plan"], busy="tentative", location="Room 1"),
            self.up(self.A, subject="Plan v2"),                  # a replay: finds it by stamp
            dict(self.up(self.B), outlookId="U1"),               # a foreign EntryID
            self.up(self.C, sensitivity="private", body="secret", location="home"),
            self.up(self.K, timeZone="Asia/Kamchatka"),          # a zone this Outlook lacks
            {"op": "delete", "turmaId": self.A, "outlookId": "E1"},
            {"op": "delete", "turmaId": self.D, "outlookId": ""},  # never existed: ok
            self.up("turma:" + "f" * 16, timeZone="Mars/Base"),    # refused before the script
        ]
        got, err, last = self.run_write(cmds)
        saves = [json.loads(l[5:]) for l in err if l.startswith("SAVE ")]
        self.assertEqual([r["ok"] for r in got], [True, True, True, True, False, True, True, False])
        self.assertEqual([r.get("outlookId") for r in got[:4]], ["E1", "E1", "E2", "E3"])
        self.assertEqual(sum(l.startswith("CREATE 1") for l in err), 3)   # A, B, C — not the replay
        first, replay, b, c = saves
        self.assertEqual(first["stamp"], self.A)
        self.assertEqual(first["body"], "Agenda\nJoin: https://teams.microsoft.com/l/x")
        self.assertEqual((first["busy"], first["sens"], first["reminder"], first["allDay"]),
                         (1, 0, False, False))
        self.assertEqual((first["tz"], first["wall"]), ("Eastern Standard Time", "2026-11-16T09:00:00"))
        self.assertEqual((first["startUtc"], first["endUtc"]), ("2026-11-16T14:00:00", "2026-11-16T15:00:00"))
        self.assertIn("Team", first["cats"])
        self.assertIn("Plan", first["cats"])
        self.assertEqual((replay["id"], replay["subject"]), ("E1", "Plan v2"))
        # The user's own appointment, named by a stale EntryID, is left alone.
        self.assertEqual(b["id"], "E2")
        self.assertNotIn("SAVE", " ".join(l for l in err if '"id":"U1"' in l))
        self.assertEqual((c["subject"], c["body"], c["location"], c["sens"]), ("Private event", "", "", 2))
        self.assertIn("no time zone", got[4]["error"])
        self.assertIn("DELETE E1", err)
        self.assertEqual(sum(l.startswith("DELETE") for l in err), 1)   # never T9 (TURMA:DDDD…)
        self.assertFalse([l for l in err if l.startswith("SEND")])
        self.assertEqual(got[5]["startMs"], self.MON + 14 * 3600000)
        self.assertNotIn("startMs", got[6])
        self.assertIn("no Windows zone", got[7]["error"])
        self.assertRegex(got[0]["lastModified"], ISO)
        # Every stamp lookup is the DASL filter on the user property.
        self.assertTrue(any(l.startswith("FIND @SQL=\"http://schemas.microsoft.com/mapi/string/"
                                         "{00020329-0000-0000-C000-000000000046}/TurmaId\" = '"
                                         + self.A + "'") for l in err))

    PEOPLE = [{"name": "Ann", "email": "ann@example.com", "role": "required"},
              {"name": "Bo", "email": "bo@example.com", "role": "optional"}]

    def sends(self, err):
        return [l for l in err if l.startswith("SEND ")]

    def test_xerk2989_the_sending_copy_sends_once_and_updates_only_on_change(self):
        inv = dict(sendInvites=True, attendees=self.PEOPLE)
        got, err, _ = self.run_write([
            self.up(self.A, **inv),                                  # new: a meeting, sent
            self.up(self.A, **inv),                                  # a replay: saved, NOT sent
            self.up(self.A, subject="Plan v2", **inv),               # changed: an update is sent
            self.up(self.A, subject="Plan v2", sendInvites=True, attendees=self.PEOPLE[:1]),
        ])
        self.assertTrue(all(r["ok"] for r in got))
        self.assertEqual(self.sends(err), ["SEND E1 status=1 to=ann@example.com,bo@example.com",
                                           "SEND E1 status=1 to=ann@example.com,bo@example.com",
                                           "SEND E1 status=1 to=ann@example.com"])
        saves = [json.loads(l[5:]) for l in err if l.startswith("SAVE ")]
        self.assertEqual(saves[0]["to"], ["ann@example.com:1", "bo@example.com:2"])
        self.assertEqual((saves[0]["resp"], saves[0]["dnf"]), (True, False))
        self.assertTrue(saves[-1]["sent"])                         # the stamp of what went out
        self.assertEqual(sum(l.startswith("CREATE") for l in err), 1)

    def test_xerk2989_invites_off_cancels_then_writes_a_plain_copy(self):
        inv = dict(sendInvites=True, attendees=self.PEOPLE)
        got, err, _ = self.run_write([self.up(self.A, **inv), self.up(self.A, attendees=self.PEOPLE),
                                      self.up(self.B, **inv), {"op": "delete", "turmaId": self.B, "outlookId": ""}])
        self.assertTrue(all(r["ok"] for r in got))
        self.assertIn("SEND E1 status=5 to=ann@example.com,bo@example.com", err)   # a cancellation
        self.assertIn("DELETE E1", err)
        plain = [json.loads(l[5:]) for l in err if l.startswith("SAVE ")][2]
        self.assertEqual((plain["status"], plain["to"], plain["sent"]), (0, [], ""))
        self.assertNotEqual(got[1]["outlookId"], "E1")
        # Deleting a sent copy cancels it first.
        b = got[2]["outlookId"]
        self.assertIn(f"SEND {b} status=5 to=ann@example.com,bo@example.com", err)
        self.assertIn(f"DELETE {b}", err)

    def test_xerk2989_no_invitations_for_a_plain_private_or_forward_locked_copy(self):
        got, err, _ = self.run_write([
            self.up(self.A, attendees=self.PEOPLE),                                  # not the sender
            self.up(self.B, sensitivity="private", sendInvites=True, attendees=self.PEOPLE),
            self.up(self.C, sendInvites=True, attendees=self.PEOPLE, allowForward=False,
                    responseRequested=False)])
        self.assertTrue(all(r["ok"] for r in got))
        a, b, c = [json.loads(l[5:]) for l in err if l.startswith("SAVE ") and '"sent":""' in l][:2] + \
            [json.loads(l[5:]) for l in err if l.startswith("SAVE ")][-1:]
        self.assertEqual((a["to"], a["status"], b["to"], b["status"]), ([], 0, [], 0))
        self.assertEqual((c["dnf"], c["resp"]), (True, False))
        self.assertEqual(len(self.sends(err)), 1)

    def test_xerk2989_a_failed_send_is_a_failed_row_and_retried(self):
        cmd = self.up(self.A, sendInvites=True, attendees=self.PEOPLE)
        script = cli._CALENDAR_WRITE_PS
        with mock.patch.object(cli, "_CALENDAR_WRITE_PS",
                               script.replace("$it.Send() } catch {", "$script:failSend = $true; $it.Send() } catch {")):
            got, err, _ = self.run_write([cmd])
        self.assertFalse(got[0]["ok"])
        self.assertIn("did not send the invitations", got[0]["error"])
        self.assertIn("The send failed.", got[0]["error"])
        self.assertEqual(json.loads([l for l in err if l.startswith("SAVE ")][-1][5:])["sent"], "")

    def test_xerk2989_qa_a_failed_update_keeps_the_sent_stamp_so_a_delete_still_cancels(self):
        inv = dict(sendInvites=True, attendees=self.PEOPLE)
        got, err, _ = self.run_write([self.up(self.A, **inv), self.up(self.A, subject="Boom", **inv),
                                      {"op": "delete", "turmaId": self.A, "outlookId": ""}])
        self.assertEqual([r["ok"] for r in got], [True, False, True])
        self.assertIn("SEND E1 status=5 to=ann@example.com,bo@example.com", err)   # still cancelled
        self.assertIn("DELETE E1", err)

    def test_xerk2989_qa_the_mailbox_owner_is_never_its_own_recipient(self):
        inv = dict(sendInvites=True, attendees=self.PEOPLE + [{"email": "me@example.com"}])
        got, err, _ = self.run_write([self.up(self.A, **inv), self.up(self.A, **inv), self.up(self.A, subject="v2", **inv)])
        self.assertTrue(all(r["ok"] for r in got))
        for save in [json.loads(l[5:]) for l in err if l.startswith("SAVE ")]:
            self.assertEqual(save["to"], ["ann@example.com:1", "bo@example.com:2"])

    def test_xerk2989_prepare_types_the_invitation(self):
        p = cli.prepare_calendar_write(self.up(self.A, sendInvites=True, attendees=[
            {"email": "ann@example.com", "role": "optional"}, {"email": "ANN@example.com"},
            {"email": "not-an-email"}, "x"]))["event"]
        self.assertTrue(p["send"])
        self.assertEqual(p["attendees"], [{"email": "ann@example.com", "name": "", "type": 2}])
        self.assertEqual(len(p["sentKey"]), 32)
        same = cli.prepare_calendar_write(self.up(self.A, sendInvites=True, attendees=[
            {"email": "ann@example.com", "role": "optional"}]))["event"]
        self.assertEqual(p["sentKey"], same["sentKey"])
        none = cli.prepare_calendar_write(self.up(self.A, sendInvites=True, attendees=[]))["event"]
        self.assertEqual((none["send"], none["sentKey"]), (False, ""))

    def test_an_all_day_event_keeps_its_midnights(self):
        got, err, _ = self.run_write([self.up(self.A, allDay=True, start="2026-11-16T00:00:00-05:00",
                                              end="2026-11-18T00:00:00-05:00")])
        (save,) = [json.loads(l[5:]) for l in err if l.startswith("SAVE ")]
        self.assertTrue(save["allDay"])
        self.assertEqual((save["wall"], save["endUtc"]), ("2026-11-16T00:00:00", "2026-11-18T05:00:00"))

    def test_the_fall_back_hour_round_trips_as_instants(self):
        """The repeated 02:30 of Berlin's fall-back night: the FIRST one (+02:00)
        is a different instant from the second; a wall time cannot tell them apart."""
        got, err, _ = self.run_write([
            self.up(self.A, start="2026-10-25T02:30:00+02:00", end="2026-10-25T03:30:00+02:00",
                    timeZone="Europe/Berlin"),
            self.up(self.B, start="2026-10-25T02:30:00+01:00", end="2026-10-25T03:30:00+01:00",
                    timeZone="Europe/Berlin")])
        first, second = [json.loads(l[5:]) for l in err if l.startswith("SAVE ")]
        self.assertEqual((first["startUtc"], first["endUtc"]), ("2026-10-25T00:30:00", "2026-10-25T01:30:00"))
        self.assertEqual((second["startUtc"], second["endUtc"]), ("2026-10-25T01:30:00", "2026-10-25T02:30:00"))
        self.assertEqual(first["tz"], "W. Europe Standard Time")

    def test_a_copy_in_deleted_items_is_not_edited_a_new_one_is_made(self):
        got, err, _ = self.run_write([dict(self.up("turma:" + "9" * 16), outlookId="B7")])
        (save,) = [json.loads(l[5:]) for l in err if l.startswith("SAVE ")]
        self.assertNotEqual(save["id"], "B7")
        self.assertEqual(got[0]["outlookId"], save["id"])

    def test_one_unreadable_command_never_fails_the_batch(self):
        with mock.patch.object(cli, "_run_outlook_ps",
                               return_value={"ok": True, "results": [{"ok": True, "outlookId": "E1"}]}) as run:
            got = cli.write_calendar_events([self.up(self.A, subject="bad \ud800 text"),
                                             self.up(self.C)])
        self.assertEqual(run.call_count, 1)
        self.assertFalse(got[0]["ok"])
        self.assertTrue(got[0]["refused"])
        self.assertEqual(got[1], {"ok": True, "outlookId": "E1"})
        p = cli.prepare_calendar_write(self.up(self.B, busy={"x": 1}, sensitivity=["y"]))
        self.assertEqual((p["event"]["busy"], p["event"]["sensitivity"]), (2, 0))

    def test_the_recorded_fixture(self):
        """A reply recorded from the real script (test above), read without pwsh."""
        with open(WRITE_FIXTURE, encoding="utf-8") as fh:
            doc = json.load(fh)
        ps = os.path.join(tempfile.mkdtemp(prefix="cal-write-"), "powershell.exe")
        self.addCleanup(shutil.rmtree, os.path.dirname(ps), ignore_errors=True)
        with open(ps, "w") as fh:
            fh.write('#!/bin/sh\ncat > "$(dirname "$0")/stdin"\necho "$6" > "$(dirname "$0")/enc"\n'
                     f"echo '{json.dumps(doc)}'\n")
        os.chmod(ps, 0o755)
        cmds = [self.up(self.A), self.up(self.A, subject="x"), dict(self.up(self.B), outlookId="U1"),
                self.up(self.C, sensitivity="private"), self.up(self.K, timeZone="Asia/Kamchatka"),
                {"op": "delete", "turmaId": self.A, "outlookId": "E1"},
                {"op": "delete", "turmaId": self.D, "outlookId": ""}]
        got = cli.write_calendar_events(cmds, powershell=ps)
        self.assertEqual([r["ok"] for r in got], [True, True, True, True, False, True, True])
        self.assertEqual(got[2]["outlookId"], "E2")
        # Only ASCII base64 reaches stdin, and no event text reaches the script.
        d = os.path.dirname(ps)
        with open(os.path.join(d, "stdin"), "rb") as fh:
            sent = json.loads(base64.b64decode(fh.read()))
        self.assertEqual([c["turmaId"] for c in sent["cmds"]], [c["turmaId"] for c in cmds])
        with open(os.path.join(d, "enc")) as fh:
            script = base64.b64decode(fh.read().strip()).decode("utf-16-le")
        self.assertNotIn("Plan", script)
        self.assertNotIn("__", script)

    def test_a_whole_run_failure_is_refused_and_a_short_answer_too(self):
        with mock.patch.object(cli, "_run_outlook_ps",
                               return_value={"ok": False, "error": "classic Outlook is not open"}):
            with self.assertRaisesRegex(cli.Refused, "not open"):
                cli.write_calendar_events([self.up(self.A)])
        with mock.patch.object(cli, "_run_outlook_ps", return_value={"ok": True, "results": []}):
            with self.assertRaisesRegex(cli.Refused, "expected shape"):
                cli.write_calendar_events([self.up(self.A)])
        with mock.patch.object(cli, "_run_outlook_ps") as run:      # nothing writable: no run
            got = cli.write_calendar_events([{"op": "upsert", "turmaId": "x"}])
        run.assert_not_called()
        self.assertFalse(got[0]["ok"])
        self.assertTrue(got[0]["refused"])           # Outlook was never asked
        with mock.patch.object(cli, "_run_outlook_ps") as run:
            got = cli.write_calendar_events([self.up(self.A, recurrence={"freq": "daily"}),
                                             self.up(self.B, timeZone="Mars/Base")])
        run.assert_not_called()
        self.assertEqual([(r["ok"], r.get("refused")) for r in got], [(False, True)] * 2)
        with self.assertRaises(cli.Refused):
            cli.write_calendar_events([self.up(self.A)] * (cli.CALENDAR_WRITE_BATCH_MAX + 1))

    def test_prepare_types_caps_and_refuses_in_words(self):
        p = cli.prepare_calendar_write(self.up(self.A, subject="a\x00b" + "y" * 400,
                                               categories=["  x ", 5] + ["c"] * 40,
                                               busy="nope", joinUrl="http://insecure"))
        e = p["event"]
        self.assertEqual(len(e["subject"]), cli.CALENDAR_TEXT_MAX)
        self.assertTrue(e["subject"].startswith("a b"))
        self.assertEqual((e["busy"], e["sensitivity"]), (2, 0))       # defaults: busy, normal
        self.assertEqual(e["body"], "")                                # only an https link rides
        self.assertEqual(e["categories"], ["x"] + ["c"] * 18)
        self.assertEqual((e["startMs"], e["endMs"]), (self.MON + 14 * 3600000, self.MON + 15 * 3600000))
        self.assertEqual(cli.prepare_calendar_write(self.up(self.A, start="2026-11-16T14:00:00Z",
                                                            end="2026-11-16T15:00:00Z", timeZone=None)
                                                    )["event"]["zone"], "UTC")
        self.assertEqual(cli.prepare_calendar_write(self.up(self.A, timeZone="Asia/Kolkata"))["event"]["zone"],
                         "India Standard Time")
        # Bare GMT is UTC+0 all year, never London's GMT Standard Time.
        self.assertEqual((cli.windows_zone("GMT"), cli.windows_zone("Europe/London")),
                         ("UTC", "GMT Standard Time"))
        self.assertEqual(cli.prepare_calendar_write({"op": "delete", "turmaId": self.A,
                                                     "outlookId": "x\x00y"}),
                         {"op": "delete", "turmaId": self.A, "outlookId": ""})
        for bad, why in [({"op": "upsert", "turmaId": "turma:ABC"}, "Turma event id"),
                         ({"op": "move", "turmaId": self.A}, "upsert or delete"),
                         ({"op": "upsert", "turmaId": self.A}, "needs its event"),
                         (self.up(self.A, start="2026-11-16T09:00:00"), "instants"),
                         (self.up(self.A, end="2026-11-16T08:00:00-05:00"), "instants"),
                         (self.up(self.A, recurrence={"freq": "daily"}), "single events"),
                         (self.up(self.A, timeZone="Mars/Base"), "no Windows zone")]:
            with self.assertRaisesRegex(cli.Refused, why, msg=bad):
                cli.prepare_calendar_write(bad)


class WslConfReaderTest(unittest.TestCase):
    """wsl.conf's `[interop] enabled`, read as WSL's configfile.cpp reads it
    (XERK-2945). install.sh calls this same reader (test_install_wsl_interop.sh)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def read(self, conf: bytes):
        path = os.path.join(self.tmp, "wsl.conf")
        with open(path, "wb") as fh:
            fh.write(conf)
        return cli.wsl_conf_interop_off(path)

    def test_escapes_and_headers_as_wsl_reads_them(self):
        cases = {
            b"[interop]\nenabled=tr\\ue\nenabled=false\n": True,      # invalid escape voids line 2
            b"[interop]\nenabled=fal\\\nse\n": True,                  # line continuation
            b"[interop]\nenabled=fal\\\r\nse\n": False,               # CRLF: `\` + \r is invalid
            b"[interop]\nenabled=fal\\": False,                        # `\` then EOF: invalid
            b"[interop]\nenabled=false\\\n": True,                     # continuation, then EOF
            b"[interop]\nenabled=\\\"false\\\"\n": False,              # escaped quotes stay
            b"[interop]\nenabled=false\\t\n": False,                   # escaped tab not trimmed
            b"[interop]\nenabled=\\x\nenabled=0\n": True,
            b"[ interop ]\nenabled=false\n": False,                    # invalid header: no section
            b"[interop]\n[ boot ]\nenabled=false\n": True,             # ...and the old one stands
            b"[interop]\n[automount x\nenabled=false\n": False,        # buffer now `automou`
            b"[interop]\n[interopX y\nenabled=false\n": True,          # buffer truncated: `interop`
            b"[interop]\n[ab c\nenabled=false\n": False,               # shorter: unmatchable
            b"[interop]x\nenabled=false\n": False,
            b"[interop]\renabled=false\n": True,                       # \r ends the header
            b"[interop]\n#x\renabled=false\n": False,                  # but not a comment
            b"[interop]\nen_abled=false\nenabled=false\n": True,
            b"[Interop]\nENABLED=FALSE\n": True,
            b"[interop]\nenabled=fal\\\nse \n": True,              # trailing blank after a
            b"[interop]\nenabled=false\\\n   # off\n": True,         # continuation is trimmed
            b"[interop]\nenabled=\\\n\\\nfalse\t\t\n": True,
            b"[interop]\nenabled=false\x00junk\n": True,             # a NUL ends the C string
            b"[interop]\nenabled=fal\x00se\n": False,
            b"[interop]\nenabled=\x00\n": False,                     # empty: no bool
            b"[interop]\nenabled=false\\\n\x00": True,              # continuation, final NUL
            b"[interop]\nenabled=falsexxxxxx\n": False,
            b"[interop]\nenabled=false" + b" " * 50 + b"\n": True,
            b"[interop]\nenabled=0" + b" " * 50 + b"x\n": False,
        }
        for conf, off in cases.items():
            with self.subTest(conf=conf):
                self.assertEqual(self.read(conf), off)

    def test_a_huge_value_line_stays_fast(self):
        import time
        t = time.monotonic()
        self.assertFalse(self.read(b"[interop]\nenabled=" + b"x" * 300_000 + b"\n"))
        self.assertLess(time.monotonic() - t, 2.0)



if __name__ == "__main__":
    unittest.main()
