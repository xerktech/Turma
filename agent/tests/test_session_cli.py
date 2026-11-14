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
            "__FROM__", "[DateTime]::Today.AddDays(1)").replace("__DAYS__", "1").replace(
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
        script = script.replace("__FROM__", "[DateTime]::Today").replace(
            "__DAYS__", "7").replace("__MAX__", max_events)
        enc = base64.b64encode(script.encode("utf-16-le")).decode()
        r = subprocess.run([pwsh, "-NoProfile", "-NonInteractive", "-EncodedCommand", enc],
                           capture_output=True, text=True, timeout=120)
        return json.loads(r.stdout.strip().splitlines()[-1])

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
        self.assertEqual(cli.normalize_calendar(doc)["unreadable"], 1)

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
        ps = self.fake_ps("echo 'banner'\necho '{\"ok\":true,\"events\":[]}'\n")
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

    def test_interop_off_is_named(self):
        """With WSL interop off, a .exe is just an unrunnable file (ENOEXEC)."""
        ps = self.fake_ps("\x7fELF-not-really", shebang=False)
        with self.assertRaisesRegex(cli.Refused, "interop looks off"):
            cli.read_calendar("today", powershell=ps)

    def test_the_range_is_only_ever_two_integers(self):
        ps = self.fake_ps('echo "$6" > "$(dirname "$0")/enc"\necho \'{"ok":true,"events":[]}\'\n')
        cli.read_calendar("tomorrow", powershell=ps)
        with open(os.path.join(self.tmp, "enc")) as fh:
            script = base64.b64decode(fh.read().strip()).decode("utf-16-le")
        self.assertIn("[DateTime]::Today.AddDays(1)", script)
        self.assertIn("$from.AddDays(1)", script)
        self.assertNotIn("__", script)

    def test_normalize_types_cleans_and_caps(self):
        evil = "Sync\u202e\x1b[31m" + "x" * 1000
        data = cli.normalize_calendar({"ok": True, "events": [
            {"subject": evil, "busy": "2", "myResponse": True, "status": 7,
             "joinUrl": "javascript:alert(1)", "attendees": [{"name": 5, "type": 9}] * 300},
            "not an event"]})
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
            got = cli.normalize_calendar({"ok": True, "events": [
                {"subject": line, "attendees": []}]})["events"][0]["subject"]
            self.assertEqual(got, "a b", repr(line))
        self.assertEqual(cli._text("Inter\xadnational"), "International")
        got = cli.normalize_calendar({"ok": True, "events": [{"organizer": "Ana", "attendees": [
            {"name": "Ana", "type": 1, "email": "/o=ExchangeLabs/ou=x/cn=ana"},
            {"name": "Bo", "type": 1, "email": "bo@corp.example"}]}]})["events"][0]["attendees"]
        self.assertEqual([(a["role"], a["email"]) for a in got],
                         [("organizer", ""), ("required", "bo@corp.example")])
        got = cli.normalize_calendar({"ok": True, "events": [{"organizer": "Ana", "attendees": [
            {"name": "Ana", "type": 2}, {"name": "Ana", "type": 1, "email": "/o=X/cn=a@b.c"},
            {"name": "Ana", "type": 1, "email": "x ana@corp.example"}, {"name": "", "type": 1}]},
            {"organizer": "", "attendees": [{"name": "", "type": 1}]}]})["events"]
        self.assertEqual([(a["role"], a["email"]) for a in got[0]["attendees"]],
                         [("optional", ""), ("organizer", ""), ("required", ""), ("required", "")])
        self.assertEqual(got[1]["attendees"][0]["role"], "required")
        self.assertNotIn("unreadable", cli.normalize_calendar(
            {"ok": True, "skipped": -1, "events": []}))
        for bad in (None, [], {"ok": "true"}, {"ok": True},
                    {"ok": True, "events": {"value": [{"subject": "x"}], "Count": 1}},
                    {"ok": True, "events": [{"subject": "x", "attendees": {"name": "a"}}]}):
            with self.assertRaises(cli.Refused):
                cli.normalize_calendar(bad)

    def script_for(self, *args, **kw):
        ps = self.fake_ps('echo "$6" > "$(dirname "$0")/enc"\necho \'{"ok":true,"events":[]}\'\n')
        cli.read_calendar(*args, powershell=ps, **kw)
        with open(os.path.join(self.tmp, "enc")) as fh:
            return base64.b64decode(fh.read().strip()).decode("utf-16-le")

    def test_a_date_and_a_span_reach_the_script_as_integers(self):
        """XERK-2903: a session asking about last Friday names its date."""
        s = self.script_for("2026-11-13")
        self.assertIn("$from = (New-Object DateTime 2026, 11, 13)", s)
        self.assertIn("$from.AddDays(1)", s)
        s = self.script_for("yesterday", days=3)
        self.assertIn("$from = [DateTime]::Today.AddDays(-1)", s)
        self.assertIn("$from.AddDays(3)", s)

    def test_the_real_script_reads_a_dated_window(self):
        pwsh = shutil.which("pwsh")
        if not pwsh:
            self.skipTest("pwsh not installed")
        start, n = cli.calendar_window("2026-11-13", 2)
        script = cli._CALENDAR_PS.replace(_COM_LINES, _FAKE_OUTLOOK).replace(
            "__FROM__", start).replace("__DAYS__", str(n)).replace("__MAX__", "5")
        enc = base64.b64encode(script.encode("utf-16-le")).decode()
        r = subprocess.run([pwsh, "-NoProfile", "-NonInteractive", "-EncodedCommand", enc],
                           capture_output=True, text=True, timeout=120)
        doc = json.loads(r.stdout.strip().splitlines()[-1])
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
        ps = self.fake_ps("echo '{\"ok\":true,\"events\":[]}'\n")
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


if __name__ == "__main__":
    unittest.main()
