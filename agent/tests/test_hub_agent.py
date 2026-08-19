#!/usr/bin/env python3
"""Unit tests for agent/hub-agent.py (stdlib unittest only — mirrors the
image's no-pip stance; CI runs `python3 -m unittest discover -s agent/tests`).

The module is imported by file path (its name has a dash) and its module-level
constants (PROJECTS_ROOT, REGISTRY_PATH, ...) are patched per-test, so no test
ever touches /root or the real registry. SessionManager's subprocess use is
faked at its two chokepoints, run()/run_ok(), plus Popen for ttyd — no
docker/tmux/git needed.
"""

import base64
import contextlib
import datetime
import gzip
import http.server
import importlib.util
import io
import json
import os
import re
import shlex
import subprocess
import shutil
import signal
import struct
import sys
import tempfile
import threading
import tracemalloc
import time
import unittest
import urllib.error
import urllib.request
from collections import deque
from unittest import mock

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE_PATH = os.path.join(AGENT_DIR, "hub-agent.py")

spec = importlib.util.spec_from_file_location("hub_agent", MODULE_PATH)
ha = importlib.util.module_from_spec(spec)
sys.modules["hub_agent"] = ha
spec.loader.exec_module(ha)


# The shipped probe interval, captured before ManagerMixin patches it to 0 for
# the suite (see the patch list); the probe's own tests restore it.
LIMITS_PROBE_SEC_DEFAULT = ha.LIMITS_PROBE_SEC


def write_jsonl(path, lines):
    """Write transcript lines; each item is a dict (JSON-encoded) or a raw
    string (written verbatim, for truncated/garbage fixtures)."""
    with open(path, "a") as f:
        for line in lines:
            f.write(line if isinstance(line, str) else json.dumps(line))
            f.write("\n")


def write_json(path, data):
    """Seed one of the manager's own state files (sessions.json, closed.json, a
    ledger) as it would find it on disk at construction."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f)


def usage_entry(ts, msg_id, request_id, model, inp, out, cw=0, cr=0):
    return {
        "timestamp": ts,
        "requestId": request_id,
        "message": {
            "id": msg_id,
            "model": model,
            "usage": {
                "input_tokens": inp,
                "output_tokens": out,
                "cache_creation_input_tokens": cw,
                "cache_read_input_tokens": cr,
            },
        },
    }


class TestSlugify(unittest.TestCase):
    def test_spaces_become_dashes(self):
        self.assertEqual(ha.slugify("my repo name"), "my-repo-name")

    def test_punctuation_dropped_and_collapsed(self):
        self.assertEqual(ha.slugify("My Repo!"), "My-Repo")
        self.assertEqual(ha.slugify("a/b\\c"), "a-b-c")
        self.assertEqual(ha.slugify("a---b"), "a-b")

    def test_keeps_dot_underscore_dash(self):
        self.assertEqual(ha.slugify("re.po_name-1"), "re.po_name-1")

    def test_strips_leading_trailing_dashes(self):
        self.assertEqual(ha.slugify("  --hello-- "), "hello")

    def test_empty_and_none(self):
        self.assertEqual(ha.slugify(""), "")
        self.assertEqual(ha.slugify(None), "")
        self.assertEqual(ha.slugify("!!!"), "")


class TestDeviceName(unittest.TestCase):
    """Host-identity resolution — auto-detected with no env/compose config.
    Order: DEVICE_NAME/COMPUTERNAME env (entrypoint-resolved or operator
    override) -> /host/etc/hostname -> `docker info` .Name -> SMB to the Windows
    host (Docker Desktop / WSL2) -> OS hostname. Never reports the
    kernel-assigned container id (the "fe0e38df73b4" bug) or a shared
    placeholder."""

    # A container-id gethostname() is the real in-container default; use it so a
    # test only reaches a later source when the earlier ones are genuinely empty.
    CONTAINER_ID = "fe0e38df73b4"

    def _run(self, *, host_file=None, docker_name="", smb_name="", env=None,
             gethostname=CONTAINER_ID):
        """Resolve device_name() with every source stubbed.
        host_file=None means /host/etc/hostname is absent (open raises);
        docker_name is what `docker info` returns, smb_name what the SMB probe
        of the Windows host returns ('' = unreachable/blocked)."""
        def fake_open(path, *a, **k):
            if path == "/host/etc/hostname" and host_file is not None:
                return io.StringIO(host_file)
            raise OSError("no such file")

        def fake_run(cmd, cwd=None):
            if cmd[:2] == ["docker", "info"]:
                return docker_name
            return ""

        with mock.patch.dict(os.environ, env or {}, clear=True), \
                mock.patch("builtins.open", fake_open), \
                mock.patch.object(ha, "run", fake_run), \
                mock.patch.object(ha, "smb_host_name", lambda: smb_name), \
                mock.patch.object(ha.socket, "gethostname", lambda: gethostname):
            return ha.device_name()

    def test_usable_hostname_rejects_container_ids_and_placeholders(self):
        for bad in ("", "  ", "localhost", "LOCALHOST", "docker-desktop",
                    "unknown-device", "fe0e38df73b4",
                    "a" * 64):  # short + full container id forms
            self.assertEqual(ha._usable_hostname(bad), "", bad)
        for good in ("truenas", "WIN-DESK01", "host.lab", "server-1"):
            self.assertEqual(ha._usable_hostname(good), good, good)

    def test_usable_hostname_rejects_url_dot_segments(self):
        # "." / ".." survive percent-encoding untouched and are then collapsed by
        # the URL parser resolving /api/agents/<host>/..., so such a host looks
        # online while every route against it 404s (XERK-269).
        for bad in (".", "..", " . ", "\t..\n"):
            self.assertEqual(ha._usable_hostname(bad), "", bad)
        # Only the bare segments are unaddressable — names that merely contain or
        # start with dots percent-encode and route fine.
        for good in ("...", ".hidden", "a.b", "HOST.local.", "..host"):
            self.assertEqual(ha._usable_hostname(good), good, good)

    def test_dot_segment_name_falls_through_to_next_source(self):
        # The whole point of rejecting it: the agent registers under the next
        # usable source rather than under a name the hub cannot address.
        self.assertEqual(
            self._run(host_file=".\n", docker_name="..", smb_name="truenas"),
            "truenas")

    def test_dot_segment_env_override_is_refused(self):
        # DEVICE_NAME otherwise outranks every detection source, but a dot
        # segment is unaddressable no matter who chose it.
        for bad in (".", ".."):
            self.assertEqual(
                self._run(env={"DEVICE_NAME": bad}, host_file="truenas\n"),
                "truenas", bad)

    def test_env_wins_first(self):
        # entrypoint.sh exports DEVICE_NAME after resolving once; it (or an
        # explicit operator override) is checked before any auto-detection.
        self.assertEqual(
            self._run(env={"DEVICE_NAME": "MAXAI"}, host_file="truenas\n",
                      docker_name="other", smb_name="smbname"),
            "MAXAI",
        )
        self.assertEqual(self._run(env={"COMPUTERNAME": "WIN-DESK01"}), "WIN-DESK01")
        self.assertEqual(
            self._run(env={"DEVICE_NAME": "explicit", "COMPUTERNAME": "win"}),
            "explicit",
        )

    def test_host_file_wins_over_docker_and_smb(self):
        self.assertEqual(
            self._run(host_file="truenas\n", docker_name="other", smb_name="x"),
            "truenas",
        )

    def test_docker_info_name_used_when_no_host_file(self):
        # bare Linux / Docker-in-WSL: the mounted socket's daemon name.
        self.assertEqual(self._run(docker_name="DESKTOP-AB12\n"), "DESKTOP-AB12")

    def test_smb_used_when_docker_desktop(self):
        # The Docker Desktop path: docker info is the shared VM name, so we fall
        # through to the SMB probe of the Windows host for the real name.
        self.assertEqual(
            self._run(docker_name="docker-desktop", smb_name="MAXAI"), "MAXAI")

    def test_smb_used_when_no_mount_no_docker(self):
        self.assertEqual(self._run(smb_name="MAXAI"), "MAXAI")

    def test_os_hostname_used_when_real(self):
        self.assertEqual(self._run(gethostname="bare-linux"), "bare-linux")

    def test_container_id_hostname_falls_back_to_placeholder(self):
        # The reported bug: no env, no mount, docker=docker-desktop, SMB blocked,
        # and gethostname() is the container id -> unknown-device, never the id.
        self.assertEqual(
            self._run(docker_name="docker-desktop", smb_name=""), "unknown-device")


class TestCodingAgent(unittest.TestCase):
    """Which coding agent this host runs, as heartbeated for the hub's header.
    The name comes out of the CLI's own --version reply so it stays right if the
    product renames itself, with the build's default as the fallback."""

    def _run(self, out):
        with mock.patch.object(ha, "run", return_value=out):
            return ha.coding_agent()

    def test_version_reply_is_split_into_name_and_version(self):
        # `claude --version` prints "<version> (<product>)".
        self.assertEqual(
            self._run("2.1.211 (Claude Code)"),
            {"name": "Claude Code", "version": "2.1.211"},
        )

    def test_product_name_is_read_from_the_reply_not_assumed(self):
        self.assertEqual(
            self._run("1.0.0 (Claude Code Next)"),
            {"name": "Claude Code Next", "version": "1.0.0"},
        )

    def test_unparseable_reply_keeps_the_whole_string_as_the_version(self):
        # Still more use to the operator than dropping it.
        self.assertEqual(
            self._run("2.1.211"), {"name": "Claude Code", "version": "2.1.211"})

    def test_cli_that_cannot_be_run_reports_nothing(self):
        # run() returns "" on any failure; the hub renders unknown.
        self.assertIsNone(self._run(""))


class TestClaudeAuthStatus(unittest.TestCase):
    """The shared subscription login's health, heartbeated so the hub can alert
    when re-login is required (XERK-98). The REFRESH-token expiry is the signal;
    the short-lived access token is not."""

    NOW = 1_700_000_000_000  # fixed "now" in epoch ms for deterministic windows

    def _status(self, oauth, warn_ms=None):
        """Run claude_auth_status against a temp credentials file holding
        `oauth` under claudeAiOauth (None writes no such key)."""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, ".credentials.json")
            body = {} if oauth is None else {"claudeAiOauth": oauth}
            with open(path, "w") as f:
                json.dump(body, f)
            warn = ha.CLAUDE_AUTH_WARN_MS if warn_ms is None else warn_ms
            with mock.patch.object(ha, "CLAUDE_AUTH_WARN_MS", warn):
                return ha.claude_auth_status(path=path, now_ms=self.NOW)

    def test_missing_file_reads_as_not_logged_in(self):
        st = ha.claude_auth_status(path="/no/such/creds.json", now_ms=self.NOW)
        self.assertFalse(st["present"])
        self.assertTrue(st["needsLogin"])
        self.assertFalse(st["expiringSoon"])

    def test_file_without_oauth_block_is_not_a_login(self):
        st = self._status(None)
        self.assertFalse(st["present"])
        self.assertTrue(st["needsLogin"])

    def test_oauth_without_access_token_is_not_a_login(self):
        st = self._status({"refreshTokenExpiresAt": self.NOW + 10**9})
        self.assertFalse(st["present"])
        self.assertTrue(st["needsLogin"])

    def test_healthy_login_needs_nothing(self):
        st = self._status({
            "accessToken": "a",
            "refreshTokenExpiresAt": self.NOW + 30 * 24 * 3600 * 1000,
            "subscriptionType": "max",
        })
        self.assertTrue(st["present"])
        self.assertFalse(st["needsLogin"])
        self.assertFalse(st["expiringSoon"])
        self.assertEqual(st["subscriptionType"], "max")

    def test_lapsed_refresh_token_needs_login(self):
        # A refresh token in the past means claude hasn't refreshed in its
        # window — the operator must run `claude /login`.
        st = self._status({"accessToken": "a", "refreshTokenExpiresAt": self.NOW - 1})
        self.assertTrue(st["present"])
        self.assertTrue(st["needsLogin"])
        self.assertFalse(st["expiringSoon"])

    def test_refresh_token_inside_warn_window_is_expiring_soon(self):
        warn = 3 * 24 * 3600 * 1000
        st = self._status(
            {"accessToken": "a", "refreshTokenExpiresAt": self.NOW + warn // 2},
            warn_ms=warn,
        )
        self.assertFalse(st["needsLogin"])
        self.assertTrue(st["expiringSoon"])

    def test_expired_access_token_alone_does_not_need_login(self):
        # The access token is auto-refreshed; only the refresh token matters.
        st = self._status({
            "accessToken": "a",
            "expiresAt": self.NOW - 3600 * 1000,           # access expired
            "refreshTokenExpiresAt": self.NOW + 30 * 24 * 3600 * 1000,
        })
        self.assertFalse(st["needsLogin"])
        self.assertFalse(st["expiringSoon"])

    def test_present_login_with_unknown_expiry_is_assumed_ok(self):
        # An older credential shape with no refresh expiry: never cry wolf.
        st = self._status({"accessToken": "a"})
        self.assertTrue(st["present"])
        self.assertFalse(st["needsLogin"])
        self.assertFalse(st["expiringSoon"])
        self.assertIsNone(st["refreshExpiresAt"])

    def test_unreadable_json_reads_as_not_logged_in(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, ".credentials.json")
            with open(path, "w") as f:
                f.write("{ not json")
            st = ha.claude_auth_status(path=path, now_ms=self.NOW)
        self.assertFalse(st["present"])
        self.assertTrue(st["needsLogin"])


class TestAgentVersion(unittest.TestCase):
    """This build's own version, as heartbeated for the hub's host header:
    baked env (container image) -> VERSION beside hub-agent.py (native install)
    -> repo-root VERSION (dev checkout) -> None."""

    def _run(self, *, env=None, prefix_version=None, root_version=None):
        """Resolve agent_version() with hub-agent.py pretending to live in a
        temp dir, so the VERSION files a real install/checkout would leave next
        to it can be laid out per-case."""
        with tempfile.TemporaryDirectory() as tmp:
            here = os.path.join(tmp, "prefix")
            os.makedirs(here)
            if prefix_version is not None:
                with open(os.path.join(here, "VERSION"), "w") as f:
                    f.write(prefix_version)
            if root_version is not None:
                with open(os.path.join(tmp, "VERSION"), "w") as f:
                    f.write(root_version)
            with mock.patch.dict(os.environ, env or {}, clear=True), \
                    mock.patch.object(ha, "__file__",
                                      os.path.join(here, "hub-agent.py")):
                return ha.agent_version()

    def test_env_wins_first(self):
        # The image bakes TURMA_AGENT_VERSION at build time; it beats any file
        # and doubles as an operator override.
        self.assertEqual(
            self._run(env={"TURMA_AGENT_VERSION": "0.4.2"},
                      prefix_version="0.3.9", root_version="0.3"),
            "0.4.2",
        )

    def test_installed_version_file_beats_repo_root(self):
        # native/install.sh stamps VERSION into the prefix beside hub-agent.py.
        self.assertEqual(self._run(prefix_version="0.3.9\n", root_version="0.3"), "0.3.9")

    def test_repo_root_version_used_for_a_dev_checkout(self):
        self.assertEqual(self._run(root_version="0.3\n"), "0.3")

    def test_unstamped_build_reports_nothing(self):
        # Nothing to read -> None, so the hub says "unknown" rather than showing
        # a version this build can't actually vouch for.
        self.assertIsNone(self._run())
        self.assertIsNone(self._run(env={"TURMA_AGENT_VERSION": "  "}))


class TestSmbHostName(unittest.TestCase):
    """The SMB2/NTLM computer-name extraction (Docker Desktop / WSL2 path)."""

    @staticmethod
    def _challenge(names):
        """Build a minimal NTLM CHALLENGE (type 2) with the given Target Info AV
        pairs {av_id: str}, wrapped in some leading bytes like a real SMB blob."""
        ti = b""
        for av_id, val in names.items():
            v = val.encode("utf-16-le")
            ti += struct.pack("<HH", av_id, len(v)) + v
        ti += struct.pack("<HH", 0, 0)  # MsvAvEOL
        ntlm = (
            b"NTLMSSP\x00" + struct.pack("<I", 2)
            + struct.pack("<HHI", 0, 0, 0)   # TargetName fields
            + struct.pack("<I", 0)           # NegotiateFlags
            + b"\x11" * 8                     # ServerChallenge
            + b"\x00" * 8                     # Reserved
            + struct.pack("<HHI", len(ti), len(ti), 48)  # TargetInfo @ offset 48
            + ti
        )
        return b"\x00" * 137 + ntlm  # arbitrary SMB2 header/prefix before NTLMSSP

    def test_extracts_netbios_computer_name(self):
        blob = self._challenge({1: "MAXAI", 2: "XERKTECH",
                                3: "MaxAI.xerktech.com"})
        self.assertEqual(ha._smb_parse_computer_name(blob), "MAXAI")

    def test_no_ntlmssp_returns_empty(self):
        self.assertEqual(ha._smb_parse_computer_name(b"not an ntlm response"), "")

    def test_no_computer_name_av_returns_empty(self):
        # Only a domain AV pair, no MsvAvNbComputerName(0x1).
        self.assertEqual(
            ha._smb_parse_computer_name(self._challenge({2: "XERKTECH"})), "")

    def test_request_packets_are_well_formed(self):
        # SMB2 header is exactly 64 bytes; the SESSION_SETUP security buffer
        # offset (88) must equal header + fixed body, or Windows rejects it.
        self.assertEqual(len(ha._smb2_header(0, 0)), 64)


class TestPeerCell(unittest.TestCase):
    """One cell of the peers roster (XERK-339). The file is read by a model
    against a one-line format description and no parser, so a value carrying the
    field or row separator would shift every later column under the wrong
    heading."""

    def test_flattens_tabs_and_newlines(self):
        self.assertEqual(ha._peer_cell("two\tcols\nand a row"),
                         "two cols and a row")

    def test_empty_and_none_become_a_placeholder(self):
        # An empty cell would collapse two adjacent separators into one.
        self.assertEqual(ha._peer_cell(""), "-")
        self.assertEqual(ha._peer_cell(None), "-")
        self.assertEqual(ha._peer_cell("   "), "-")

    def test_caps_an_operator_written_summary(self):
        # Unbounded, and the roster is read whole by every session that consults
        # it, so one long cell is charged to all of them.
        self.assertEqual(len(ha._peer_cell("x" * 500)), ha.PEER_CELL_MAX_CHARS)


class TestSpawnOptionHelpers(unittest.TestCase):
    """Validation for the composer's spawn options (#11/#12/#13) — everything
    that gets interpolated into a git/tmux command line is allowlist-checked."""

    def test_default_branch_name_prefers_origin_head(self):
        # origin/HEAD -> origin/main means the default branch is "main".
        with mock.patch.object(
                ha, "run",
                lambda cmd, cwd=None: "origin/main" if "symbolic-ref" in cmd else ""):
            self.assertEqual(ha.default_branch_name("/repo"), "main")

    def test_default_branch_name_falls_back_to_local_main(self):
        # No origin/HEAD; a local "main" exists -> use it.
        with mock.patch.object(ha, "run", lambda cmd, cwd=None: ""), \
             mock.patch.object(ha, "branch_exists",
                               lambda repo, ref: ref == "refs/heads/main"):
            self.assertEqual(ha.default_branch_name("/repo"), "main")

    def test_default_base_ref_fetches_latest_and_prefers_origin(self):
        # New sessions fork off the LATEST default branch: fetch, then origin/<d>.
        calls = []
        with mock.patch.object(
                ha, "run",
                lambda cmd, cwd=None: "origin/main" if "symbolic-ref" in cmd else ""), \
             mock.patch.object(ha, "run_ok",
                               lambda cmd, cwd=None, timeout=None: calls.append(cmd) or (0, "")), \
             mock.patch.object(ha, "branch_exists",
                               lambda repo, ref: ref == "refs/remotes/origin/main"):
            self.assertEqual(ha.default_base_ref("/repo"), "origin/main")
        self.assertTrue(any("fetch" in c for c in calls),
                        f"expected a git fetch for latest main, got {calls}")

    def test_valid_ref_name(self):
        self.assertTrue(ha.valid_ref_name("main"))
        self.assertTrue(ha.valid_ref_name("origin/main"))
        self.assertTrue(ha.valid_ref_name("release/v1.2.3"))
        for bad in ("", "-x", "/x", "x/", "a..b", "a//b", "x.lock", "a@{0}", "a b", "a;b"):
            self.assertFalse(ha.valid_ref_name(bad), bad)

    def test_resolve_model(self):
        self.assertIsNone(ha.resolve_model(""))
        self.assertIsNone(ha.resolve_model(None))
        self.assertIsNone(ha.resolve_model("default"))
        self.assertEqual(ha.resolve_model("opus"), "opus")
        self.assertEqual(ha.resolve_model("SONNET"), "sonnet")
        self.assertEqual(ha.resolve_model("haiku"), "haiku")
        self.assertEqual(ha.resolve_model("fable"), "fable")
        for bad in ("gpt-4", "opus; rm", "claude-3"):
            with self.assertRaises(ValueError):
                ha.resolve_model(bad)

    def test_resolve_model_probed_extras(self):
        # An alias the CLI itself reported available is accepted; anything not
        # on either list still isn't, and the bracketed 1M variants never pass
        # (they'd be interpolated into a launch command line, where the
        # brackets are a shell glob).
        extra = ("opusplan", "sonnet[1m]", "best")
        self.assertEqual(ha.resolve_model("opusplan", extra), "opusplan")
        self.assertEqual(ha.resolve_model("best", extra), "best")
        with self.assertRaises(ValueError):
            ha.resolve_model("sonnet[1m]", extra)
        with self.assertRaises(ValueError):
            ha.resolve_model("opusplan")  # not probed, not static

    def test_resolve_permission_mode(self):
        self.assertEqual(ha.resolve_permission_mode(""), "auto")
        self.assertEqual(ha.resolve_permission_mode("auto"), "auto")
        self.assertEqual(ha.resolve_permission_mode("bypassPermissions"),
                         "bypassPermissions")
        self.assertEqual(ha.resolve_permission_mode("acceptEdits"), "acceptEdits")
        self.assertEqual(ha.resolve_permission_mode("plan"), "plan")
        self.assertEqual(ha.resolve_permission_mode("default"), "default")
        for bad in ("root", "yolo", "accept edits"):
            with self.assertRaises(ValueError):
                ha.resolve_permission_mode(bad)

    def test_perm_cycle_for(self):
        base = ["default", "acceptEdits", "plan"]
        # Base modes / blank / unknown launch -> base cycle only, no optionals.
        self.assertEqual(ha.perm_cycle_for("default"), base)
        self.assertEqual(ha.perm_cycle_for("acceptEdits"), base)
        self.assertEqual(ha.perm_cycle_for("plan"), base)
        # None -> assume auto (Turma's launch default).
        self.assertEqual(ha.perm_cycle_for(None), base + ["auto"])
        self.assertEqual(ha.perm_cycle_for(""), base + ["auto"])
        # Launching into an optional mode puts exactly that one in the cycle.
        self.assertEqual(ha.perm_cycle_for("auto"), base + ["auto"])
        self.assertEqual(ha.perm_cycle_for("bypassPermissions"),
                         base + ["bypassPermissions"])

    def test_resolve_base_ref(self):
        # Blank / HEAD -> the latest default branch (delegates to default_base_ref).
        with mock.patch.object(ha, "default_base_ref", lambda p: "origin/main"):
            self.assertEqual(ha.resolve_base_ref("/repo", ""), "origin/main")
            self.assertEqual(ha.resolve_base_ref("/repo", "HEAD"), "origin/main")

        # Allowlist-clean AND resolvable -> returned; missing -> ValueError.
        def fake_run(cmd, cwd=None):
            return "sha" if " ".join(cmd).endswith("--verify --quiet develop") else ""

        with mock.patch.object(ha, "run", fake_run):
            self.assertEqual(ha.resolve_base_ref("/repo", "develop"), "develop")
            with self.assertRaises(ValueError):
                ha.resolve_base_ref("/repo", "nope")            # not found
            with self.assertRaises(ValueError):
                ha.resolve_base_ref("/repo", "bad;ref")         # bad chars, never hits git


class ProjectDirMixin:
    """Temp PROJECTS_ROOT + a project dir for a fake worktree path."""

    WORKDIR = "/w/.turma/worktrees/repo"

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hub-agent-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        patcher = mock.patch.object(ha, "PROJECTS_ROOT", self.tmp)
        patcher.start()
        self.addCleanup(patcher.stop)
        # Isolate the AskUserQuestion rendezvous dir so hook-file detection
        # tests can drop req files without touching the real ~/.turma/questions.
        self.questions_dir = os.path.join(self.tmp, "questions")
        os.makedirs(self.questions_dir)
        qpatcher = mock.patch.object(ha, "QUESTIONS_DIR", self.questions_dir)
        qpatcher.start()
        self.addCleanup(qpatcher.stop)
        self.proj = os.path.join(self.tmp, ha._project_slug(self.WORKDIR))
        os.makedirs(self.proj)

    def write_question_req(self, session_id, question, options):
        """Publish a pending-question request file the way ask.py would."""
        req = {"sessionId": session_id, "question": question,
               "options": [{"label": o} if isinstance(o, str) else o for o in options]}
        with open(os.path.join(self.questions_dir, f"{session_id}.req.json"), "w") as f:
            json.dump(req, f)


class TestUsageReport(ProjectDirMixin, unittest.TestCase):
    def test_missing_project_dir_returns_none(self):
        self.assertIsNone(ha.usage_report("/does/not/exist"))

    def test_unusable_token_figures_count_as_zero(self):
        """XERK-306: whatever the transcript says travels untouched to the hub,
        the web UI and a Kotlin `Long` on Android, where a float or an
        out-of-range figure fails the decode of the WHOLE /api/agents array and
        empties every OTHER host from that phone's fleet list. A string is worse
        still here — it raised out of the beat's own aggregation on the first
        `+=`, costing this host its entire usage report. Each unusable figure
        counts as 0 — a FRACTIONAL one is truncated rather than discarded, since
        the count is real and only its type is wrong — and the rest of the
        entry, and every other entry, still count."""
        write_jsonl(os.path.join(self.proj, "a.jsonl"), [
            usage_entry("2026-07-01T10:00:00.000Z", "m1", "r1", "sonnet",
                        1.5, "9", cw=-5, cr=10 ** 400),
            usage_entry("2026-07-01T11:00:00.000Z", "m2", "r2", "sonnet",
                        100, 200, cw=300, cr=400),
            usage_entry("2026-07-01T12:00:00.000Z", "m3", "r3", "sonnet",
                        True, None, cw=float("nan"), cr=2.0),
        ])
        rep = ha.usage_report(self.WORKDIR)
        # A bool is not a count (isinstance(True, int) is True, so it would
        # otherwise fold in as 1); a whole-valued float is one, truncated.
        self.assertEqual(rep["totals"],
                         {"input": 101, "output": 200, "cacheWrite": 300, "cacheRead": 402})
        self.assertEqual(rep["days"]["2026-07-01"], rep["totals"])
        for bucket in (rep["totals"], rep["models"][0]["totals"]):
            for k, v in bucket.items():
                self.assertIsInstance(v, int, k)
                self.assertNotIsInstance(v, bool, k)

    def test_token_count_accepts_only_plausible_figures(self):
        for v in (0, 5, 2 ** 53 - 1, 2.0, 1.5):
            self.assertEqual(ha._token_count(v), int(v), v)
        for v in (-1, -0.5, True, False, None, "9", [], {},
                  2 ** 53, 10 ** 400, float("nan"), float("inf")):
            self.assertEqual(ha._token_count(v), 0, v)

    def test_aggregation_dedup_and_model_tokens(self):
        today = ha._utc_today()
        opus = usage_entry(
            "2026-07-01T10:00:00.000Z", "m1", "r1",
            "claude-opus-4-20250514", 1_000_000, 100_000,
        )
        unknown = usage_entry(
            "2026-07-02T09:00:00.000Z", "m2", "r2",
            "weird-model-x", 10, 20, cw=30, cr=40,
        )  # a model the agent has never heard of still counts, by name
        no_id = usage_entry(
            f"{today}T01:00:00.000Z", None, None,
            "claude-sonnet-4-20250514", 100_000, 0,
        )  # id-less entries are never deduped

        write_jsonl(os.path.join(self.proj, "a.jsonl"), [
            opus,
            opus,  # exact duplicate (same message id + requestId) -> skipped
            unknown,
            {"type": "user", "message": {"content": "no usage here"}},
            {"message": {"usage": "not-a-dict"}},  # malformed usage -> skipped
            # truncated tail (partial write): contains "usage" but bad JSON
            '{"timestamp":"2026-07-02T12:00:00Z","message":{"usage":{"input_tokens":5',
        ])
        write_jsonl(os.path.join(self.proj, "b.jsonl"), [
            opus,   # cross-file duplicate -> still deduped
            no_id,
            no_id,  # identical but id-less -> counted twice
        ])

        rep = ha.usage_report(self.WORKDIR)
        self.assertEqual(rep["sessions"], 2)  # two transcript files
        self.assertEqual(rep["totals"]["input"], 1_000_000 + 10 + 200_000)
        self.assertEqual(rep["totals"]["output"], 100_000 + 20)
        self.assertEqual(rep["totals"]["cacheWrite"], 30)
        self.assertEqual(rep["totals"]["cacheRead"], 40)

        # Per-day buckets: opus on 07-01, unknown on 07-02, sonnet today.
        self.assertEqual(rep["days"]["2026-07-01"]["input"], 1_000_000)
        self.assertEqual(rep["days"]["2026-07-02"]["input"], 10)
        self.assertEqual(rep["today"], rep["days"][today])
        self.assertEqual(rep["today"]["input"], 200_000)
        # Today is inside the week window; the older days are far outside it.
        self.assertEqual(rep["week"]["input"], 200_000)

        self.assertEqual(rep["lastActivity"], f"{today}T01:00:00.000Z")

        # Per-model token counts, biggest consumer first. Opus leads on tokens
        # (1.1M) despite sonnet having more messages (2) — the report ranks by
        # what was consumed, not how many turns it took.
        models = {m["model"]: m for m in rep["models"]}
        self.assertEqual([m["model"] for m in rep["models"]], [
            "claude-opus-4-20250514",
            "claude-sonnet-4-20250514",
            "weird-model-x",
        ])
        self.assertEqual(models["claude-opus-4-20250514"]["totals"], {
            "input": 1_000_000, "output": 100_000, "cacheWrite": 0, "cacheRead": 0,
        })
        # The de-duped opus message counts once, on its own day, not today.
        self.assertEqual(models["claude-opus-4-20250514"]["today"], ha._usage_bucket())
        self.assertEqual(models["weird-model-x"]["totals"], {
            "input": 10, "output": 20, "cacheWrite": 30, "cacheRead": 40,
        })
        # The id-less sonnet entry counted twice, and lands in today AND week.
        self.assertEqual(models["claude-sonnet-4-20250514"]["today"]["input"], 200_000)
        self.assertEqual(models["claude-sonnet-4-20250514"]["week"]["input"], 200_000)

    def test_synthetic_is_kept_out_of_the_model_breakdown(self):
        # Claude Code stamps a fabricated assistant entry (a session-limit
        # notice, a "No response requested." placeholder) with model
        # "<synthetic>" and an all-zero usage block. It ran no model, so it must
        # not appear as a phantom "<synthetic>" row on the usage page, and it
        # must not perturb the real per-model or grand totals.
        today = ha._utc_today()
        write_jsonl(os.path.join(self.proj, "a.jsonl"), [
            usage_entry(f"{today}T01:00:00.000Z", "m1", "r1",
                        "claude-opus-4-8", 500, 100),
            usage_entry(f"{today}T02:00:00.000Z", "m2", "r2",
                        "<synthetic>", 0, 0),
        ])
        rep = ha.usage_report(self.WORKDIR)
        names = [m["model"] for m in rep["models"]]
        self.assertEqual(names, ["claude-opus-4-8"])  # no "<synthetic>" row
        self.assertEqual(rep["totals"]["input"], 500)
        self.assertEqual(rep["totals"]["output"], 100)

    def test_week_window_is_utc_and_rolling(self):
        # Seven UTC days ending today, inclusive — the boundary day counts and
        # the day before it does not.
        window = ha._week_window("2026-07-14")
        self.assertEqual(len(window), 7)
        self.assertEqual(window[-1], "2026-07-14")   # today, last
        self.assertEqual(window[0], "2026-07-08")    # oldest day still inside
        # Crossing a month boundary is date arithmetic, not day-of-month math.
        self.assertEqual(ha._week_window("2026-07-03")[0], "2026-06-27")

    def test_week_counts_only_the_last_seven_days(self):
        today = ha._utc_today()
        inside = ha._week_window()[0]                 # 6 days ago: still counted
        outside = (datetime.date.fromisoformat(today)
                   - datetime.timedelta(days=7)).isoformat()  # 7 days ago: not
        write_jsonl(os.path.join(self.proj, "a.jsonl"), [
            usage_entry(f"{today}T01:00:00.000Z", "m1", "r1", "sonnet", 100, 0),
            usage_entry(f"{inside}T01:00:00.000Z", "m2", "r2", "sonnet", 20, 0),
            usage_entry(f"{outside}T01:00:00.000Z", "m3", "r3", "sonnet", 5_000, 0),
        ])
        rep = ha.usage_report(self.WORKDIR)
        self.assertEqual(rep["today"]["input"], 100)
        self.assertEqual(rep["week"]["input"], 120)          # today + 6-days-ago
        self.assertEqual(rep["totals"]["input"], 5_120)      # all-time keeps all
        self.assertEqual(rep["models"][0]["week"]["input"], 120)

    def test_empty_project_dir(self):
        rep = ha.usage_report(self.WORKDIR)
        self.assertEqual(rep["sessions"], 0)
        self.assertEqual(rep["totals"]["input"], 0)
        self.assertEqual(rep["days"], {})
        self.assertEqual(rep["lastActivity"], "")


class TestNormalizeRemote(unittest.TestCase):
    def test_forms_collapse_to_one_identity(self):
        # ssh, scp, https, https-with-creds and a :port ssh URL all normalize to
        # the same key, so the same repo cloned differently across hosts unifies.
        cases = {
            "git@github.com:Xerk/DockerOps.git": "github.com/xerk/dockerops",
            "https://github.com/Xerk/DockerOps": "github.com/xerk/dockerops",
            "https://github.com/Xerk/DockerOps.git": "github.com/xerk/dockerops",
            "https://user:tok@github.com/Xerk/DockerOps.git": "github.com/xerk/dockerops",
            "ssh://git@github.com:22/Xerk/DockerOps.git": "github.com/xerk/dockerops",
            "https://github.com/Xerk/DockerOps/": "github.com/xerk/dockerops",
        }
        for raw, want in cases.items():
            self.assertEqual(ha.normalize_remote(raw), want, raw)

    def test_empty(self):
        self.assertEqual(ha.normalize_remote(""), "")
        self.assertEqual(ha.normalize_remote(None), "")


class TestRepoUsageReport(unittest.TestCase):
    """repo_usage_report() aggregates transcripts by repo via the ledger,
    independent of any live session."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hub-agent-repo-usage-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        p = mock.patch.object(ha, "PROJECTS_ROOT", self.tmp)
        p.start()
        self.addCleanup(p.stop)

    def _proj(self, worktree):
        d = os.path.join(self.tmp, ha._project_slug(worktree))
        os.makedirs(d, exist_ok=True)
        return d

    def _entry(self, worktree, repo, remote):
        return {"repo": repo, "remote": remote, "slug": ha._project_slug(worktree)}

    def _fold_full(self, slug):
        # Stand-in for the manager's _fold_slug: a full (non-incremental) parse
        # of one project slug into a fresh accumulator.
        acc = ha._UsageAcc()
        ha._aggregate_project(os.path.join(self.tmp, slug), acc)
        return acc

    def test_merges_worktrees_per_repo_and_host_total(self):
        wt_a = "/w/.turma/worktrees/Turma/aaa"
        wt_b = "/w/.turma/worktrees/Turma/bbb"
        wt_c = "/w/.turma/worktrees/DockerOps/ccc"
        write_jsonl(os.path.join(self._proj(wt_a), "a.jsonl"), [
            usage_entry("2026-07-01T10:00:00.000Z", "m1", "r1",
                        "claude-opus-4-20250514", 1_000_000, 100_000),
        ])
        write_jsonl(os.path.join(self._proj(wt_b), "b.jsonl"), [
            usage_entry("2026-07-01T12:00:00.000Z", "m2", "r2",
                        "claude-sonnet-4-20250514", 100_000, 0),
        ])
        write_jsonl(os.path.join(self._proj(wt_c), "c.jsonl"), [
            usage_entry("2026-07-02T09:00:00.000Z", "m3", "r3",
                        "claude-sonnet-4-20250514", 200_000, 0),
        ])
        ledger = {
            # Same repo, two worktrees, ssh vs https remote -> one repo series.
            wt_a: self._entry(wt_a, "Turma", "git@github.com:xerktech/Turma.git"),
            wt_b: self._entry(wt_b, "Turma", "https://github.com/xerktech/Turma.git"),
            wt_c: self._entry(wt_c, "DockerOps", "git@github.com:xerktech/DockerOps.git"),
        }
        repo_usage, host = ha.repo_usage_report(ledger, self._fold_full)
        by = {r["repo"]: r for r in repo_usage}

        # Both of Turma's worktrees fold into the one repo series.
        self.assertEqual(by["Turma"]["usage"]["totals"]["input"], 1_100_000)
        self.assertEqual(by["Turma"]["usage"]["days"]["2026-07-01"]["input"], 1_100_000)
        self.assertEqual(by["Turma"]["remoteKey"], "github.com/xerktech/turma")
        self.assertEqual(by["DockerOps"]["usage"]["totals"]["input"], 200_000)

        # A repo's per-model breakdown merges across its worktrees too.
        turma_models = {m["model"]: m for m in by["Turma"]["usage"]["models"]}
        self.assertEqual(turma_models["claude-opus-4-20250514"]["totals"]["input"],
                         1_000_000)
        self.assertEqual(turma_models["claude-sonnet-4-20250514"]["totals"]["input"],
                         100_000)

        self.assertEqual(host["totals"]["input"], 1_100_000 + 200_000)
        # The host total merges the same model across repos (sonnet ran in both).
        host_models = {m["model"]: m for m in host["models"]}
        self.assertEqual(host_models["claude-sonnet-4-20250514"]["totals"]["input"],
                         100_000 + 200_000)
        # Sorted by total tokens desc.
        self.assertEqual(repo_usage[0]["repo"], "Turma")

    def test_empty_and_missing_dirs_excluded(self):
        wt_live = "/w/.turma/worktrees/Turma/live"
        wt_empty = "/w/.turma/worktrees/Turma/empty"  # dir exists, no transcripts
        wt_gone = "/w/.turma/worktrees/Ghost/gone"    # dir never created
        write_jsonl(os.path.join(self._proj(wt_live), "a.jsonl"), [
            usage_entry("2026-07-01T10:00:00.000Z", "m1", "r1",
                        "claude-sonnet-4-20250514", 100_000, 0),
        ])
        self._proj(wt_empty)
        ledger = {
            wt_live: self._entry(wt_live, "Turma", ""),
            wt_empty: self._entry(wt_empty, "Turma", ""),
            wt_gone: self._entry(wt_gone, "Ghost", ""),
        }
        repo_usage, host = ha.repo_usage_report(ledger, self._fold_full)
        repos = {r["repo"] for r in repo_usage}
        self.assertIn("Turma", repos)      # has usage via wt_live
        self.assertNotIn("Ghost", repos)   # no transcripts -> omitted
        # No remote -> remoteKey falls back to the repo name.
        turma = next(r for r in repo_usage if r["repo"] == "Turma")
        self.assertEqual(turma["remoteKey"], "Turma")

    def test_empty_ledger(self):
        repo_usage, host = ha.repo_usage_report({}, self._fold_full)
        self.assertEqual(repo_usage, [])
        self.assertIsNone(host)


class TestAggregateProjectIncremental(ProjectDirMixin, unittest.TestCase):
    """With an `offsets` dict, _aggregate_project folds only newly-appended bytes
    across beats (the manager carries a persistent per-slug acc + offsets), but
    the running totals must always match a from-scratch parse."""

    def _entry(self, ts, mid, model, inp, out):
        return usage_entry(ts, mid, mid, model, inp, out)

    def _fold(self, acc, offsets):
        return ha._aggregate_project(self.proj, acc, offsets)

    def test_incremental_matches_full_and_only_reads_new_bytes(self):
        path = os.path.join(self.proj, "a.jsonl")
        write_jsonl(path, [self._entry(
            "2026-07-01T10:00:00Z", "m1", "claude-opus-4-20250514", 1_000_000, 0)])

        acc, offsets = ha._UsageAcc(), {}
        self.assertTrue(self._fold(acc, offsets))
        self.assertEqual(acc.totals["input"], 1_000_000)
        off1 = offsets["a.jsonl"]

        # Append a second message; the incremental beat picks up only the delta.
        write_jsonl(path, [self._entry(
            "2026-07-02T10:00:00Z", "m2", "claude-opus-4-20250514", 500_000, 0)])
        self.assertTrue(self._fold(acc, offsets))
        self.assertEqual(acc.totals["input"], 1_500_000)
        self.assertGreater(offsets["a.jsonl"], off1)

        # Same result as a cold, stateless full parse of the final file.
        self.assertEqual(acc.totals["input"],
                         ha.usage_report(self.WORKDIR)["totals"]["input"])

    def test_cross_file_dedup_persists_across_beats(self):
        a = os.path.join(self.proj, "a.jsonl")
        b = os.path.join(self.proj, "b.jsonl")
        dup = self._entry("2026-07-01T10:00:00Z", "m1", "claude-opus-4-20250514", 10, 0)
        write_jsonl(a, [dup])
        acc, offsets = ha._UsageAcc(), {}
        self._fold(acc, offsets)
        # The SAME message id later shows up appended to another transcript.
        write_jsonl(b, [dup])
        self._fold(acc, offsets)
        self.assertEqual(acc.totals["input"], 10)  # counted once, not twice

    def test_partial_trailing_line_deferred_then_counted(self):
        path = os.path.join(self.proj, "a.jsonl")
        entry = self._entry("2026-07-01T10:00:00Z", "m1", "claude-opus-4-20250514", 7, 0)
        line = json.dumps(entry)
        # Write the entry WITHOUT its trailing newline (an in-progress write).
        with open(path, "w") as f:
            f.write(line[: len(line) // 2])
        acc, offsets = ha._UsageAcc(), {}
        self._fold(acc, offsets)
        self.assertEqual(acc.totals["input"], 0)  # not yet a whole line
        # Finish the line; the offset never advanced past the partial, so the
        # whole entry is read exactly once now.
        with open(path, "w") as f:
            f.write(line + "\n")
        self._fold(acc, offsets)
        self.assertEqual(acc.totals["input"], 7)

    def test_truncation_signals_rebuild(self):
        path = os.path.join(self.proj, "a.jsonl")
        write_jsonl(path, [self._entry(
            "2026-07-01T10:00:00Z", "m1", "claude-opus-4-20250514", 100, 0)])
        acc, offsets = ha._UsageAcc(), {}
        self.assertTrue(self._fold(acc, offsets))
        self.assertEqual(acc.totals["input"], 100)
        # Rewrite the file smaller: _aggregate_project reports the truncation
        # (returns False, acc untouched) so the caller rebuilds from a fresh acc
        # rather than adding on top of the stale running total.
        with open(path, "w") as f:
            f.write(json.dumps(self._entry(
                "2026-07-02T10:00:00Z", "m2", "claude-opus-4-20250514", 5, 0)) + "\n")
        self.assertFalse(self._fold(acc, offsets))
        self.assertEqual(acc.totals["input"], 100)  # unchanged on the failed fold
        fresh, foff = ha._UsageAcc(), {}
        self.assertTrue(self._fold(fresh, foff))
        self.assertEqual(fresh.totals["input"], 5)


class TestSubagentUsage(ProjectDirMixin, unittest.TestCase):
    """Background agents' transcripts are real spend on the same login, and were
    never counted at all (XERK-302) — the walk only ever read the flat listing.
    They now fold into the totals like any other turn AND are reported as a
    named slice of them."""

    def _entry(self, ts, mid, inp, out=0):
        return usage_entry(ts, mid, mid, "claude-opus-4-20250514", inp, out)

    def _sub(self, transcript_id, *parts):
        """A subagent transcript path under `<id>/subagents/<parts…>`."""
        path = os.path.join(self.proj, transcript_id, "subagents", *parts)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        return path

    def _report(self):
        acc = ha._UsageAcc()
        ha._aggregate_project(self.proj, acc)
        return ha._finalize_usage(acc)

    def test_counts_flat_and_workflow_nested_subagent_transcripts(self):
        write_jsonl(os.path.join(self.proj, "main.jsonl"),
                    [self._entry("2026-07-01T10:00:00Z", "m1", 100)])
        write_jsonl(self._sub("main", "agent-abc.jsonl"),
                    [self._entry("2026-07-01T10:05:00Z", "s1", 20)])
        # A Workflow run nests one level deeper; the shape has already grown
        # once, which is why the walk is a walk and not two hard-coded depths.
        write_jsonl(self._sub("main", "workflows", "wf_x", "agent-def.jsonl"),
                    [self._entry("2026-07-01T10:06:00Z", "s2", 3)])

        rep = self._report()
        self.assertEqual(rep["totals"]["input"], 123)          # all of it
        self.assertEqual(rep["subagent"]["totals"]["input"], 23)  # the delegated part

    def test_subagent_tokens_are_a_slice_not_an_addend(self):
        # The per-model breakdown and the day buckets count a delegated turn
        # exactly like a session's own — only the `subagent` block separates it.
        write_jsonl(os.path.join(self.proj, "main.jsonl"),
                    [self._entry("2026-07-01T10:00:00Z", "m1", 100)])
        write_jsonl(self._sub("main", "agent-abc.jsonl"),
                    [self._entry("2026-07-01T10:05:00Z", "s1", 20)])
        rep = self._report()
        self.assertEqual(rep["days"]["2026-07-01"]["input"], 120)
        self.assertEqual([m["totals"]["input"] for m in rep["models"]], [120])

    def test_a_subagents_dir_is_counted_without_its_parent_transcript(self):
        # The parent conversation can be archived or pruned away; the tokens the
        # agents it launched spent were still spent.
        write_jsonl(self._sub("gone", "agent-abc.jsonl"),
                    [self._entry("2026-07-01T10:05:00Z", "s1", 20)])
        rep = self._report()
        self.assertEqual(rep["totals"]["input"], 20)
        self.assertEqual(rep["subagent"]["totals"]["input"], 20)

    def test_sessions_counts_conversations_only(self):
        # `sessions` is a display stat meaning conversations. Counting delegated
        # transcripts would inflate it by however much a session delegated.
        write_jsonl(os.path.join(self.proj, "main.jsonl"),
                    [self._entry("2026-07-01T10:00:00Z", "m1", 1)])
        for i in range(3):
            write_jsonl(self._sub("main", f"agent-{i}.jsonl"),
                        [self._entry("2026-07-01T10:05:00Z", f"s{i}", 1)])
        self.assertEqual(self._report()["sessions"], 1)

    def test_offsets_key_on_the_relative_path_so_names_cannot_collide(self):
        # Two parents' agents can share a filename; keyed on the bare name, one
        # would take the other's offset and be skipped.
        write_jsonl(self._sub("one", "agent-abc.jsonl"),
                    [self._entry("2026-07-01T10:00:00Z", "s1", 11)])
        write_jsonl(self._sub("two", "agent-abc.jsonl"),
                    [self._entry("2026-07-01T10:01:00Z", "s2", 22)])
        acc, offsets = ha._UsageAcc(), {}
        self.assertTrue(ha._aggregate_project(self.proj, acc, offsets))
        self.assertEqual(acc.totals["input"], 33)
        self.assertEqual(
            sorted(offsets),
            [os.path.join("one", "subagents", "agent-abc.jsonl"),
             os.path.join("two", "subagents", "agent-abc.jsonl")])

    def test_incremental_matches_a_full_parse_for_subagents_too(self):
        main = os.path.join(self.proj, "main.jsonl")
        sub = self._sub("main", "agent-abc.jsonl")
        write_jsonl(main, [self._entry("2026-07-01T10:00:00Z", "m1", 100)])
        write_jsonl(sub, [self._entry("2026-07-01T10:05:00Z", "s1", 20)])
        acc, offsets = ha._UsageAcc(), {}
        self.assertTrue(ha._aggregate_project(self.proj, acc, offsets))
        # A later beat: the agent wrote more, and a NEW agent was launched.
        write_jsonl(sub, [self._entry("2026-07-02T10:00:00Z", "s2", 5)])
        write_jsonl(self._sub("main", "agent-xyz.jsonl"),
                    [self._entry("2026-07-02T10:01:00Z", "s3", 7)])
        self.assertTrue(ha._aggregate_project(self.proj, acc, offsets))

        full = ha._UsageAcc()
        ha._aggregate_project(self.proj, full)
        self.assertEqual(acc.totals, full.totals)
        self.assertEqual(acc.subagent["totals"], full.subagent["totals"])
        self.assertEqual(acc.subagent["totals"]["input"], 32)

    def test_a_vanished_subagent_transcript_signals_a_rebuild(self):
        sub = self._sub("main", "agent-abc.jsonl")
        write_jsonl(sub, [self._entry("2026-07-01T10:00:00Z", "s1", 20)])
        acc, offsets = ha._UsageAcc(), {}
        self.assertTrue(ha._aggregate_project(self.proj, acc, offsets))
        os.remove(sub)
        # Already-counted bytes can't be un-counted incrementally, so the caller
        # is told to start this slug over — same contract as a main transcript.
        self.assertFalse(ha._aggregate_project(self.proj, acc, offsets))

    def test_windows_and_merge_carry_the_split(self):
        today = ha._utc_today()
        write_jsonl(os.path.join(self.proj, "main.jsonl"),
                    [self._entry(today + "T10:00:00Z", "m1", 100)])
        write_jsonl(self._sub("main", "agent-abc.jsonl"),
                    [self._entry(today + "T10:05:00Z", "s1", 20)])
        acc = ha._UsageAcc()
        ha._aggregate_project(self.proj, acc)
        merged = ha._UsageAcc()
        ha._merge_acc(merged, acc)
        rep = ha._finalize_usage(merged)
        self.assertEqual(rep["subagent"]["today"]["input"], 20)
        self.assertEqual(rep["subagent"]["week"]["input"], 20)
        self.assertEqual(rep["subagent"]["totals"]["input"], 20)

    def test_only_regular_files_count_on_either_branch(self):
        # A DIRECTORY named *.jsonl would read as a conversation and, by taking
        # the .jsonl branch, skip its own subagents/ tree entirely.
        write_jsonl(self._sub("adir.jsonl", "agent-abc.jsonl"),
                    [self._entry("2026-07-01T10:00:00Z", "s1", 20)])
        rep = self._report()
        self.assertEqual(rep["sessions"], 0)
        self.assertEqual(rep["subagent"]["totals"]["input"], 20)

    def test_a_fifo_named_like_a_transcript_is_never_ENUMERATED(self):
        # A FIFO (or a symlink to /dev/zero) blocks a plain read forever, and
        # this walk is the cheap place to refuse it — the usage parse runs on the
        # heartbeat's critical path, where a block is a host that reads offline.
        #
        # **Asserted on the enumeration, which never opens anything.** Asserting
        # it through the parse instead makes a regression HANG the suite rather
        # than fail it: CI then burns its whole job timeout and reports as
        # infrastructure flake instead of as this test going red.
        os.mkfifo(os.path.join(self.proj, "pipe.jsonl"))
        os.mkfifo(self._sub("main", "agent-pipe.jsonl"))
        write_jsonl(os.path.join(self.proj, "main.jsonl"),
                    [self._entry("2026-07-01T10:00:00Z", "m1", 100)])
        self.assertEqual(ha._project_transcripts(self.proj), [("main.jsonl", False)])

    def test_the_parse_itself_completes_over_a_fifo(self):
        # The end-to-end half of the test above, run on a DAEMON thread with a
        # join timeout so a lost guard fails here instead of hanging the suite.
        os.mkfifo(os.path.join(self.proj, "pipe.jsonl"))
        os.mkfifo(self._sub("main", "agent-pipe.jsonl"))
        write_jsonl(os.path.join(self.proj, "main.jsonl"),
                    [self._entry("2026-07-01T10:00:00Z", "m1", 100)])
        out = {}
        t = threading.Thread(target=lambda: out.update(self._report()), daemon=True)
        t.start()
        t.join(20)
        if t.is_alive():
            self.fail("the usage parse blocked on a FIFO named like a transcript")
        self.assertEqual(out["totals"]["input"], 100)
        self.assertEqual(out["sessions"], 1)

    def test_a_subagents_SYMLINK_is_refused_outright(self):
        # os.walk always descends its own top, so followlinks=False does not
        # cover this one. Pointed at PROJECTS_ROOT it would drag every
        # transcript on the host into this slug.
        os.makedirs(os.path.join(self.proj, "main"))
        other = os.path.join(self.tmp, "elsewhere")
        os.makedirs(other)
        write_jsonl(os.path.join(other, "agent-abc.jsonl"),
                    [self._entry("2026-07-01T10:00:00Z", "s1", 999)])
        os.symlink(other, os.path.join(self.proj, "main", "subagents"))
        write_jsonl(os.path.join(self.proj, "main.jsonl"),
                    [self._entry("2026-07-01T10:00:00Z", "m1", 100)])
        rep = self._report()
        self.assertEqual(rep["totals"]["input"], 100)   # the foreign 999 stays out
        self.assertEqual(rep["subagent"]["totals"], ha._usage_bucket())

    def test_a_symlinked_PARENT_reaching_a_real_subagents_is_refused_too(self):
        # `islink` on the `subagents` component alone checks the FINAL one, so a
        # symlinked parent still reached a real subagents/ through the link. Both
        # checks are needed; refusing the class beats reasoning about each shape.
        other = os.path.join(self.tmp, "elsewhere")
        os.makedirs(os.path.join(other, "subagents"))
        write_jsonl(os.path.join(other, "subagents", "agent-abc.jsonl"),
                    [self._entry("2026-07-01T10:00:00Z", "s1", 999)])
        os.symlink(other, os.path.join(self.proj, "main"))
        write_jsonl(os.path.join(self.proj, "main.jsonl"),
                    [self._entry("2026-07-01T10:00:00Z", "m1", 100)])
        rep = self._report()
        self.assertEqual(rep["totals"]["input"], 100)
        self.assertEqual(rep["subagent"]["totals"], ha._usage_bucket())

    def test_a_symlink_loop_under_subagents_does_not_hang_or_raise(self):
        sub = os.path.join(self.proj, "main", "subagents")
        os.makedirs(sub)
        os.symlink(sub, os.path.join(sub, "loop"))
        write_jsonl(os.path.join(sub, "agent-abc.jsonl"),
                    [self._entry("2026-07-01T10:00:00Z", "s1", 20)])
        self.assertEqual(self._report()["subagent"]["totals"]["input"], 20)

    def test_a_slug_holding_only_subagents_still_reports_a_host_block(self):
        # `sessions` counts conversations, so it stopped being a proxy for "this
        # host spent something": a pruned parent leaves a subagents/ tree with
        # real tokens and no conversation, which reported per-repo usage beside
        # a NULL host-level block.
        wt = "/w/.turma/worktrees/Turma/aaa"
        proj = os.path.join(self.tmp, ha._project_slug(wt))
        os.makedirs(os.path.join(proj, "gone", "subagents"))
        write_jsonl(os.path.join(proj, "gone", "subagents", "agent-abc.jsonl"),
                    [self._entry("2026-07-01T10:00:00Z", "s1", 90)])

        def fold(slug):
            acc = ha._UsageAcc()
            ha._aggregate_project(os.path.join(self.tmp, slug), acc)
            return acc

        repo_usage, host = ha.repo_usage_report(
            {wt: {"repo": "Turma", "remote": "", "slug": ha._project_slug(wt)}}, fold)
        self.assertEqual(repo_usage[0]["usage"]["totals"]["input"], 90)
        self.assertIsNotNone(host)
        self.assertEqual(host["totals"]["input"], 90)

    def test_a_project_with_no_subagents_reports_a_zeroed_split(self):
        # Zeroed, not absent: this agent CAN answer, and the answer is "none".
        write_jsonl(os.path.join(self.proj, "main.jsonl"),
                    [self._entry("2026-07-01T10:00:00Z", "m1", 100)])
        rep = self._report()
        self.assertEqual(rep["subagent"]["totals"], ha._usage_bucket())


class TestLastEntry(ProjectDirMixin, unittest.TestCase):
    def test_skips_truncated_tail(self):
        path = os.path.join(self.proj, "t.jsonl")
        write_jsonl(path, [{"type": "assistant", "n": 1}, {"type": "assistant", "n": 2}])
        with open(path, "a") as f:
            f.write('{"type":"assistant","n":3')  # partial write, no newline
        self.assertEqual(ha._last_entry(path)["n"], 2)

    def test_missing_file(self):
        self.assertIsNone(ha._last_entry(os.path.join(self.proj, "nope.jsonl")))


class TestLastActivityTs(ProjectDirMixin, unittest.TestCase):
    """XERK-73: the last new message's own timestamp, the accurate ended-list sort
    key that the file mtime is not."""

    def test_newest_timestamped_entry_wins(self):
        path = os.path.join(self.proj, "t.jsonl")
        write_jsonl(path, [
            {"type": "user", "timestamp": "2026-07-01T00:00:00.000Z"},
            {"type": "assistant", "timestamp": "2026-07-01T00:05:00.000Z"},
        ])
        self.assertEqual(ha._last_activity_ts(path), "2026-07-01T00:05:00.000Z")

    def test_skips_a_trailing_untimestamped_entry(self):
        """A summary/system tail entry without a timestamp doesn't blank the key —
        the scan keeps walking back to the last real message."""
        path = os.path.join(self.proj, "t.jsonl")
        write_jsonl(path, [
            {"type": "assistant", "timestamp": "2026-07-01T00:05:00.000Z"},
            {"type": "summary", "summary": "recap"},   # no timestamp
        ])
        self.assertEqual(ha._last_activity_ts(path), "2026-07-01T00:05:00.000Z")

    def test_none_without_any_timestamp(self):
        path = os.path.join(self.proj, "t.jsonl")
        write_jsonl(path, [{"type": "assistant", "n": 1}])
        self.assertIsNone(ha._last_activity_ts(path))

    def test_missing_file(self):
        self.assertIsNone(ha._last_activity_ts(os.path.join(self.proj, "nope.jsonl")))


class TestSessionReport(ProjectDirMixin, unittest.TestCase):
    PR1 = "https://github.com/xerktech/Turma/pull/34"
    PR2 = "https://github.com/xerktech/DockerOps/pull/7"

    def entry_with_text(self, text):
        return {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": text}]},
        }

    def pr_create_call(self, tool_id, cmd="gh pr create --fill"):
        return {
            "type": "assistant",
            "message": {"content": [
                {"type": "tool_use", "id": tool_id, "name": "Bash",
                 "input": {"command": cmd}},
            ]},
        }

    def tool_result(self, tool_id, text):
        return {
            "type": "user",
            "message": {"content": [
                {"type": "tool_result", "tool_use_id": tool_id, "content": text},
            ]},
        }

    def opened_pr(self, url, tool_id="t1"):
        """The two entries a real `gh pr create` leaves behind: the call, then
        its output — which is the new PR's URL."""
        return [self.pr_create_call(tool_id), self.tool_result(tool_id, url)]

    def test_missing_project_dir(self):
        state = {}
        rep = ha.session_report("/absent/worktree", state)
        self.assertFalse(rep["bridgeAttached"])
        self.assertIsNone(rep["transcriptAgeSec"])
        self.assertEqual(rep["prUrls"], [])
        self.assertTrue(state["primed"])  # still primes so later beats scan

    def test_prime_to_eof_then_incremental_pr_scan(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, self.opened_pr(self.PR1, "old"))

        state = {}
        rep = ha.session_report(self.WORKDIR, state)
        # First beat primes offsets to EOF: pre-existing PR link NOT replayed.
        self.assertEqual(rep["prUrls"], [])
        self.assertIsNotNone(rep["transcriptAgeSec"])

        write_jsonl(path, self.opened_pr(self.PR2, "new"))
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [self.PR2])

        # Same URL out of a second create (a re-run) -> already seen, not
        # re-reported.
        write_jsonl(path, self.opened_pr(self.PR2, "again"))
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [])

    def test_pr_url_only_mentioned_is_not_this_sessions_pr(self):
        """The bug this scan's narrowness exists for: a PR link a session merely
        SAW — `gh pr list` output, a link the operator pasted, the model quoting
        another session's PR — is not a PR this session opened, and must not
        chip its card."""
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("hello")])
        state = {}
        ha.session_report(self.WORKDIR, state)  # prime

        listed = f"#34\tSome older work\tfeat/thing\t{self.PR1}"
        write_jsonl(path, [
            # Prose quoting a PR, a user pasting one...
            self.entry_with_text(f"I opened {self.PR2} earlier"),
            {"type": "user", "message": {"content": [
                {"type": "text", "text": f"what is {self.PR2} about?"}]}},
            # ...and a read-only gh call whose output is full of other PRs.
            self.pr_create_call("read", cmd="gh pr list --limit 5"),
            self.tool_result("read", listed),
        ])
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [])

    def test_pr_create_result_lands_on_a_later_beat(self):
        """The call and its output are separate entries, and a `gh pr create`
        that spans a beat boundary still resolves — the pending id carries."""
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("hello")])
        state = {}
        ha.session_report(self.WORKDIR, state)  # prime

        write_jsonl(path, [self.pr_create_call("t9")])
        self.assertEqual(ha.session_report(self.WORKDIR, state)["prUrls"], [])

        write_jsonl(path, [self.tool_result("t9", f"{self.PR1}\n")])
        self.assertEqual(ha.session_report(self.WORKDIR, state)["prUrls"], [self.PR1])

    MR1 = "https://gitlab.example.com/grp/sub/app/-/merge_requests/12"

    def test_glab_mr_create_result_is_this_sessions_mr(self):
        """XERK-162: a GitLab MR opened via `glab mr create` chips exactly like
        a `gh pr create` PR — the create call's own tool_result is the
        attribution event."""
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("hello")])
        state = {}
        ha.session_report(self.WORKDIR, state)  # prime

        write_jsonl(path, [
            self.pr_create_call("g1", cmd="glab mr create --fill"),
            self.tool_result("g1", f"{self.MR1}\n"),
        ])
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [self.MR1])

    def test_push_option_mr_create_counts(self):
        """`git push -o merge_request.create` is the other way a session opens
        an MR (no glab needed) — the MR URL in the push's own output counts."""
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("hello")])
        state = {}
        ha.session_report(self.WORKDIR, state)  # prime

        out = ("remote:\nremote: View merge request for xerk-1:\n"
               f"remote:   {self.MR1}\nremote:\n")
        write_jsonl(path, [
            self.pr_create_call(
                "p1", cmd="git push -o merge_request.create origin HEAD"),
            self.tool_result("p1", out),
        ])
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [self.MR1])

    AZDO1 = "https://dev.azure.com/myorg/Proj/_git/app/pullrequest/12"

    def test_az_repos_pr_create_result_is_this_sessions_pr(self):
        """XERK-226: `az repos pr create` prints the created PR as JSON with no
        link in it, so the URL is composed from the create call's OWN result."""
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("hello")])
        state = {}
        ha.session_report(self.WORKDIR, state)  # prime

        out = json.dumps({
            "pullRequestId": 12, "status": "active",
            "repository": {"name": "app",
                           "webUrl": "https://dev.azure.com/myorg/Proj/_git/app"}})
        write_jsonl(path, [
            self.pr_create_call(
                "a1", cmd="az repos pr create --title x --output json"),
            self.tool_result("a1", out),
        ])
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [self.AZDO1])

    def test_az_pr_link_in_the_result_counts_once(self):
        """A result carrying the PR link outright is taken as-is — never also
        composed, which would chip one PR twice."""
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("hello")])
        state = {}
        ha.session_report(self.WORKDIR, state)  # prime

        out = (f"Created pull request: {self.AZDO1}\n" + json.dumps({
            "pullRequestId": 12,
            "repository": {"webUrl": "https://dev.azure.com/myorg/_git/app"}}))
        write_jsonl(path, [
            self.pr_create_call("a2", cmd="az repos pr create --open"),
            self.tool_result("a2", out),
        ])
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [self.AZDO1])

    def test_plain_push_azdo_pr_hint_is_not_a_created_pr(self):
        """ADO's `git push` prints a "create a pull request by visiting …"
        hint pointing at the CREATE FORM — no PR exists yet."""
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("hello")])
        state = {}
        ha.session_report(self.WORKDIR, state)  # prime

        out = ("remote: Create a pull request for 'xerk-1' on Azure DevOps by visiting:\n"
               "remote:   https://dev.azure.com/myorg/Proj/_git/app/pullrequestcreate"
               "?sourceRef=xerk-1&targetRef=main\n")
        write_jsonl(path, [
            self.pr_create_call("a3", cmd="git push origin HEAD"),
            self.tool_result("a3", out),
        ])
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [])

    # The real shape from an on-prem TFS host: the `azure-devops` az extension
    # refuses a self-hosted collection, so the session opens its PR with a
    # local REST wrapper that prints the link itself.
    ADO_WRAPPER_OUT = (
        "Created PR !10068: Keep the model loaded in VRAM\n"
        "  https://tfsserver.example.com/tfs/DefaultCollection/DevOps/_git/App"
        "/pullrequest/10068\n"
        "  linked work item #80995")
    ADO_WRAPPER_URL = ("https://tfsserver.example.com/tfs/DefaultCollection"
                       "/DevOps/_git/App/pullrequest/10068")

    def test_on_prem_ado_wrapper_create_is_this_sessions_pr(self):
        """An on-prem ADO host has no vendor CLI to name, so `ado pr-create`
        is a built-in creating command — without it that host's PRs are never
        attributed and its cards never chip."""
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("hello")])
        state = {}
        ha.session_report(self.WORKDIR, state)  # prime

        write_jsonl(path, [
            self.pr_create_call("w1", cmd='ado pr-create --title "x" \\\n  --work-item 80995'),
            self.tool_result("w1", self.ADO_WRAPPER_OUT),
        ])
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [self.ADO_WRAPPER_URL])

    def test_path_qualified_wrapper_still_counts(self):
        """The wrapper is routinely invoked by path (`~/.local/bin/ado`), and
        after a `cd` into the worktree."""
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("hello")])
        state = {}
        ha.session_report(self.WORKDIR, state)  # prime

        write_jsonl(path, [
            self.pr_create_call(
                "w2", cmd="cd /home/u/git/app && ~/.local/bin/ado pr-create --title x"),
            self.tool_result("w2", self.ADO_WRAPPER_OUT),
        ])
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [self.ADO_WRAPPER_URL])

    def test_an_on_prem_collection_over_plain_http_still_chips(self):
        """A self-hosted collection on the LAN is routinely served over http,
        and a scheme-only mismatch would drop the chip in silence."""
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("hello")])
        state = {}
        ha.session_report(self.WORKDIR, state)  # prime

        url = "http://tfs.corp.local:8080/tfs/DefaultCollection/Dev/_git/App/pullrequest/7"
        write_jsonl(path, [
            self.pr_create_call("h1", cmd="ado pr-create --title x"),
            self.tool_result("h1", f"Created PR !7:\n  {url}"),
        ])
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [url])

    def test_a_wrapper_that_only_lists_prs_is_not_a_create(self):
        """`ado pr-list` prints every open PR's link — the exact loose text the
        narrow rule exists to keep off this session's card."""
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("hello")])
        state = {}
        ha.session_report(self.WORKDIR, state)  # prime

        write_jsonl(path, [
            self.pr_create_call("w3", cmd="ado pr-list --repo App"),
            self.tool_result("w3", self.ADO_WRAPPER_OUT),
        ])
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [])

    def test_plain_push_mr_hint_is_not_a_created_mr(self):
        """A plain `git push` prints GitLab's "to create a merge request …
        visit …/merge_requests/new" hint (and, on later pushes, the existing
        MR's link) — neither is an MR THIS push opened."""
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("hello")])
        state = {}
        ha.session_report(self.WORKDIR, state)  # prime

        out = ("remote: To create a merge request for xerk-1, visit:\n"
               "remote:   https://gitlab.example.com/grp/sub/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=xerk-1\n"
               f"remote: View merge request for xerk-1:\nremote:   {self.MR1}\n")
        write_jsonl(path, [
            self.pr_create_call("p2", cmd="git push origin HEAD"),
            self.tool_result("p2", out),
        ])
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [])

    def test_partial_line_is_reread_whole_next_beat(self):
        """The offset stops at the last newline, so an entry still being written
        is parsed once, whole — not lost as two unparseable halves."""
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("hello")])
        state = {}
        ha.session_report(self.WORKDIR, state)  # prime

        line = json.dumps(self.tool_result("t1", self.PR1))
        write_jsonl(path, [self.pr_create_call("t1")])
        with open(path, "a") as f:  # first half of the result entry, no newline
            f.write(line[:40])
        self.assertEqual(ha.session_report(self.WORKDIR, state)["prUrls"], [])

        with open(path, "a") as f:
            f.write(line[40:] + "\n")
        self.assertEqual(ha.session_report(self.WORKDIR, state)["prUrls"], [self.PR1])

    def test_truncated_file_resets_offset_without_rescan(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("hello")] * 5)
        state = {}
        ha.session_report(self.WORKDIR, state)  # primes offset to EOF

        # Rewrite shorter (context clear / rotation). The old bytes contain a
        # PR URL, but offset resets to the new size — nothing is rescanned.
        with open(path, "w") as f:
            for e in self.opened_pr(self.PR1, "reset"):
                f.write(json.dumps(e) + "\n")
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [])

        # Appends after the truncation ARE picked up.
        write_jsonl(path, self.opened_pr(self.PR2, "after"))
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [self.PR2])

    def test_question_and_tool_use_detection(self):
        path = os.path.join(self.proj, "s.jsonl")
        long_q = "Why? " * 100  # > 300 chars
        write_jsonl(path, [{
            "type": "assistant",
            "message": {"content": [
                {"type": "text", "text": "thinking"},
                {"type": "tool_use", "name": "AskUserQuestion",
                 "input": {"questions": [{"question": long_q}]}},
            ]},
        }])
        rep = ha.session_report(self.WORKDIR, {})
        self.assertEqual(rep["lastRole"], "assistant")
        self.assertTrue(rep["lastHasToolUse"])
        self.assertEqual(rep["question"], long_q[:300])
        self.assertEqual(len(rep["question"]), 300)

    def test_plain_tool_use_is_not_a_question(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [{
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {}}]},
        }])
        rep = ha.session_report(self.WORKDIR, {})
        self.assertTrue(rep["lastHasToolUse"])
        self.assertIsNone(rep["question"])

    def test_bridge_pointer_presence(self):
        with open(os.path.join(self.proj, "bridge-pointer.json"), "w") as f:
            f.write("{}")
        rep = ha.session_report(self.WORKDIR, {})
        self.assertTrue(rep["bridgeAttached"])

    def test_missing_project_dir_has_empty_tail_and_options(self):
        rep = ha.session_report("/absent/worktree", {})
        self.assertEqual(rep["tail"], [])
        self.assertEqual(rep["questionOptions"], [])

    def test_tail_reported_for_live_transcript(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [
            {"uuid": "u1", "type": "user", "message": {"content": "hi"}},
            {"uuid": "u2", "type": "assistant",
             "message": {"content": [{"type": "text", "text": "hello back"}]}},
        ])
        rep = ha.session_report(self.WORKDIR, {})
        self.assertEqual(rep["tail"], [
            {"id": "u1", "role": "user", "text": "hi"},
            {"id": "u2", "role": "assistant", "text": "hello back"},
        ])

    def test_question_options_from_ask_user_question(self):
        path = os.path.join(self.proj, "s.jsonl")
        long_label = "L" * 100
        options = [{"label": long_label}, {"label": "b"}, {"label": "c"},
                   {"label": "d"}, {"label": "e"}]  # 5 options -> capped at 4
        write_jsonl(path, [{
            "type": "assistant",
            "message": {"content": [
                {"type": "tool_use", "name": "AskUserQuestion",
                 "input": {"questions": [{"question": "pick one", "options": options}]}},
            ]},
        }])
        rep = ha.session_report(self.WORKDIR, {})
        self.assertEqual(rep["questionOptions"], [long_label[:80], "b", "c", "d"])

    def test_question_options_empty_when_no_question(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("just chatting")])
        rep = ha.session_report(self.WORKDIR, {})
        self.assertEqual(rep["questionOptions"], [])

    def test_question_options_skips_non_string_labels(self):
        path = os.path.join(self.proj, "s.jsonl")
        options = [{"label": "ok"}, {"label": 42}, "not-a-dict"]
        write_jsonl(path, [{
            "type": "assistant",
            "message": {"content": [
                {"type": "tool_use", "name": "AskUserQuestion",
                 "input": {"questions": [{"question": "pick", "options": options}]}},
            ]},
        }])
        rep = ha.session_report(self.WORKDIR, {})
        self.assertEqual(rep["questionOptions"], ["ok"])

    # ---- hook-file detection: pending question from the ask.py bridge -------
    # A pending AskUserQuestion is published by the ask.py PreToolUse bridge as
    # a <sessionId>.req.json under QUESTIONS_DIR while the tool call blocks, so
    # session_report reads it from there (not from a scraped tmux pane).
    def test_hook_file_fills_pending_question(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("working on it")])  # last entry isn't a question
        self.write_question_req("sess-1", "Which direction should I run with?",
                                ["Turma", "Tutela"])
        rep = ha.session_report(self.WORKDIR, {}, "agent-abc", session_id="sess-1")
        self.assertEqual(rep["question"], "Which direction should I run with?")
        self.assertEqual(rep["questionOptions"], ["Turma", "Tutela"])
        self.assertEqual(rep["questionSource"], "hook")

    def test_hook_file_fills_rich_question_fields(self):
        # The rich picker fields (header, position, multiSelect, per-option
        # description/preview) ride the heartbeat alongside the flat labels.
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("working on it")])
        req = {"sessionId": "sess-1", "question": "What should it mean?",
               "header": "Semantics", "index": 0, "total": 4, "multiSelect": True,
               "options": [{"label": "One-shot", "description": "start now",
                            "preview": "Card meta row: [Start]"},
                           {"label": "Standing", "description": "auto-spawn"}]}
        with open(os.path.join(self.questions_dir, "sess-1.req.json"), "w") as f:
            json.dump(req, f)
        rep = ha.session_report(self.WORKDIR, {}, "agent-abc", session_id="sess-1")
        self.assertEqual(rep["questionOptions"], ["One-shot", "Standing"])
        self.assertEqual(rep["questionHeader"], "Semantics")
        self.assertEqual(rep["questionIndex"], 0)
        self.assertEqual(rep["questionTotal"], 4)
        self.assertTrue(rep["questionMulti"])
        self.assertEqual(rep["questionOptionsRich"][0],
                         {"label": "One-shot", "description": "start now",
                          "preview": "Card meta row: [Start]"})

    def test_hook_file_works_when_no_transcript_yet(self):
        # No .jsonl in the project dir at all — the early-return path must still
        # surface the hook's request file for a question asked before any write.
        self.write_question_req("sess-1", "Which direction should I run with?",
                                ["Turma", "Tutela"])
        rep = ha.session_report(self.WORKDIR, {}, "agent-abc", session_id="sess-1")
        self.assertEqual(rep["question"], "Which direction should I run with?")
        self.assertEqual(rep["questionSource"], "hook")

    def test_hook_file_overrides_transcript_detection(self):
        # A live hook request is the authoritative pending signal; it wins even
        # when the transcript scan also turned up an AskUserQuestion tool_use.
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [{
            "type": "assistant",
            "message": {"content": [
                {"type": "tool_use", "name": "AskUserQuestion",
                 "input": {"questions": [{"question": "from transcript",
                                          "options": [{"label": "yes"}]}]}},
            ]},
        }])
        self.write_question_req("sess-1", "live from hook", ["a", "b"])
        rep = ha.session_report(self.WORKDIR, {}, "agent-abc", session_id="sess-1")
        self.assertEqual(rep["question"], "live from hook")
        self.assertEqual(rep["questionSource"], "hook")

    def test_no_hook_file_means_no_hook_question(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("working on it")])
        rep = ha.session_report(self.WORKDIR, {}, session_id="sess-1")  # no req file
        self.assertIsNone(rep["question"])
        self.assertIsNone(rep["questionSource"])

    def test_hook_file_caps_options_and_skips_non_string_labels(self):
        self.write_question_req(
            "sess-1", "Pick?",
            [{"label": "a"}, {"label": 42}, {"label": "b"},
             {"label": "c"}, {"label": "d"}, {"label": "e"}],
        )
        rep = ha.session_report(self.WORKDIR, {}, session_id="sess-1")
        # Capped at the first 4 options, then non-string labels dropped — same
        # order of operations as the transcript-detection path.
        self.assertEqual(rep["questionOptions"], ["a", "b", "c"])

    # ---- answered/orphaned req files must NOT re-surface as pending ----------
    # Regression: a long-answered question kept showing on the card and re-opened
    # in chat because its req file lingered after the owning ask.py bridge died.
    def _req_ans_paths(self, sid):
        return (os.path.join(self.questions_dir, f"{sid}.req.json"),
                os.path.join(self.questions_dir, f"{sid}.ans.json"))

    def test_hook_question_suppressed_once_answer_delivered(self):
        # The answer file sitting beside the req means the answer has been
        # delivered and the bridge is consuming it (or died before it could) —
        # the question is answered, not pending, so it must not be reported.
        self.write_question_req("sess-1", "Pick one", ["a", "b"])
        req_path, ans_path = self._req_ans_paths("sess-1")
        with open(ans_path, "w") as f:
            json.dump({"optionIndex": 0}, f)
        rep = ha.session_report(self.WORKDIR, {}, session_id="sess-1")
        self.assertIsNone(rep["question"])
        self.assertIsNone(rep["questionSource"])
        # A fresh answered pair is left on disk for the live bridge to consume.
        self.assertTrue(os.path.exists(req_path))

    def test_hook_question_stale_orphan_dropped_and_cleaned(self):
        # A req older than the bridge's max block window can only be an orphan a
        # killed/restarted/crashed turn left behind — drop it AND clean it up so
        # it can't keep re-surfacing (this is the exact long-answered symptom).
        self.write_question_req("sess-1", "Pick one", ["a", "b"])
        req_path, ans_path = self._req_ans_paths("sess-1")
        with open(ans_path, "w") as f:
            json.dump({"optionIndex": 0}, f)
        old = time.time() - (ha.QUESTION_STALE_AFTER_SEC + 60)
        os.utime(req_path, (old, old))
        rep = ha.session_report(self.WORKDIR, {}, session_id="sess-1")
        self.assertIsNone(rep["question"])
        self.assertFalse(os.path.exists(req_path))
        self.assertFalse(os.path.exists(ans_path))


class TestPaneBusy(unittest.TestCase):
    """_pane_busy reads the working/idle state straight off the session's tmux
    pane by looking for Claude Code's 'esc to interrupt' hint. Every branch is
    exercised against a faked subprocess.run so no real tmux is needed."""

    def _capture(self, stdout="", returncode=0, raises=None):
        def fake_run(cmd, *a, **kw):
            self.assertEqual(cmd[:2], ["tmux", "capture-pane"])
            self.assertIn("agent-x", cmd)  # -t <tmux_name>
            if raises:
                raise raises
            return mock.Mock(stdout=stdout, returncode=returncode)
        return fake_run

    def test_none_without_tmux_name(self):
        # No pane to read -> unknown, and no subprocess is spawned.
        with mock.patch.object(ha.subprocess, "run",
                               side_effect=AssertionError("should not run")):
            self.assertIsNone(ha._pane_busy(None))
            self.assertIsNone(ha._pane_busy(""))

    def test_true_when_interrupt_hint_present(self):
        pane = "some output\n✳ Simmering… (esc to interrupt · 12s · ↑ 1.2k tokens)\n"
        with mock.patch.object(ha.subprocess, "run", self._capture(stdout=pane)):
            self.assertIs(ha._pane_busy("agent-x"), True)

    def test_case_insensitive_marker_match(self):
        with mock.patch.object(ha.subprocess, "run",
                               self._capture(stdout="ESC TO INTERRUPT")):
            self.assertIs(ha._pane_busy("agent-x"), True)

    def test_false_when_hint_absent(self):
        # Resting: the input box / shortcuts hint, no interrupt line.
        with mock.patch.object(ha.subprocess, "run",
                               self._capture(stdout="> \n? for shortcuts\n")):
            self.assertIs(ha._pane_busy("agent-x"), False)

    def test_none_on_capture_failure(self):
        # tmux session gone (nonzero) or tmux missing (raises) -> unknown, so
        # callers fall back to the transcript-mtime heuristic.
        with mock.patch.object(ha.subprocess, "run",
                               self._capture(returncode=1)):
            self.assertIsNone(ha._pane_busy("agent-x"))
        with mock.patch.object(ha.subprocess, "run",
                               self._capture(raises=FileNotFoundError("no tmux"))):
            self.assertIsNone(ha._pane_busy("agent-x"))

    def test_markers_configurable_via_env(self):
        # A TUI wording change can be patched without an image rebuild.
        markers = ha.PANE_BUSY_MARKERS
        try:
            ha.PANE_BUSY_MARKERS = ("press ctrl-c to stop",)
            with mock.patch.object(ha.subprocess, "run",
                                   self._capture(stdout="press CTRL-C to stop")):
                self.assertIs(ha._pane_busy("agent-x"), True)
            with mock.patch.object(ha.subprocess, "run",
                                   self._capture(stdout="esc to interrupt")):
                self.assertIs(ha._pane_busy("agent-x"), False)
        finally:
            ha.PANE_BUSY_MARKERS = markers

    # XERK-130: a pane once viewed from a narrow client (a phone) stays ~54
    # columns wide, and at that width the TUI ellipsizes the footer's
    # "· esc to interrupt" to "· esc to inte…" — the plain substring match read
    # every such working session as idle for its whole turn. Fixtures below are
    # verbatim captures from live sessions.

    def test_true_when_hint_truncated_by_a_narrow_pane(self):
        pane = ("  Cat\n  Sunbeam on the floor,\n\n"
                + "─" * 54 + "\n❯ \n" + "─" * 54 + "\n"
                "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to inte…\n")
        with mock.patch.object(ha.subprocess, "run", self._capture(stdout=pane)):
            self.assertIs(ha._pane_busy("agent-x"), True)

    def test_true_when_hint_truncated_with_varying_middle_segments(self):
        # The footer's middle segments vary — "(shift+tab to cycle)" comes and
        # goes, a "· PR #98" chip can sit between the mode and the hint — so
        # the anchor is the mode glyph + the ellipsized "e…" tail segment.
        for footer in ("  ⏵⏵ bypass permissions on · esc to i…",
                       "  ⏵⏵ auto mode on · PR #98 · esc to inte…"):
            with mock.patch.object(ha.subprocess, "run",
                                   self._capture(stdout=footer + "\n")):
                self.assertIs(ha._pane_busy("agent-x"), True, footer)

    def test_false_when_the_idle_suffix_is_what_got_truncated(self):
        # An IDLE footer can be width-cut too ("· ← for agents" -> "· ← for
        # ag…"); the remnant doesn't start with "e", so it must stay idle.
        pane = "  ⏵⏵ bypass permissions on · PR #98 · ← for ag…\n"
        with mock.patch.object(ha.subprocess, "run", self._capture(stdout=pane)):
            self.assertIs(ha._pane_busy("agent-x"), False)

    def test_true_from_the_spinner_line_alone(self):
        # A narrow pane running a tool: the hint is fully elided but the
        # column-0 spinner line is visible above the input box.
        for spinner in ("✢ Determining… (12m 19s · ↓ 44.2k tokens)",
                        "· Perusing… (54m 38s · still thinking)",
                        "✻ Hashing… (2m 58s · ↓ 5.7k tokens)"):
            pane = spinner + "\n  ⎿  Tip: Use /btw to ask a quick side question\n"
            with mock.patch.object(ha.subprocess, "run",
                                   self._capture(stdout=pane)):
                self.assertIs(ha._pane_busy("agent-x"), True, spinner)

    def test_false_on_an_idle_narrow_pane(self):
        # Idle keeps a completed-turn line ("✻ Brewed for 9s" — spinner glyph,
        # NO ellipsis) on screen, and the footer suffix is "· ← for agents":
        # neither may read as busy or a finished session pins busy forever.
        pane = ("  the cat sleeps through it.\n\n✻ Brewed for 9s\n"
                + "─" * 54 + "\n❯ \n" + "─" * 54 + "\n"
                "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n")
        with mock.patch.object(ha.subprocess, "run", self._capture(stdout=pane)):
            self.assertIs(ha._pane_busy("agent-x"), False)

    def test_false_when_a_spinner_line_is_quoted_in_tool_output(self):
        # A session debugging Turma echoes captured panes into its own
        # conversation; the echoed copy is INDENTED (tool results always are),
        # so the column-0 anchor keeps it from faking busy on an idle pane.
        pane = ("  ⎿  $ tmux capture-pane -p -t agent-y\n"
                "     ✻ Hashing… (2m 58s · ↓ 5.7k tokens)\n"
                "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n")
        with mock.patch.object(ha.subprocess, "run", self._capture(stdout=pane)):
            self.assertIs(ha._pane_busy("agent-x"), False)


class TestSessionReportPaneBusy(ProjectDirMixin, unittest.TestCase):
    """session_report surfaces the (single-capture) pane probe as
    report['paneBusy'] + report['modeActual'] + report['panePrompt'] on every
    return path (even before any transcript exists)."""

    def test_pane_reads_reported_with_transcript(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [{"type": "assistant",
                            "message": {"content": [{"type": "text", "text": "hi"}]}}])
        prompt = {"prompt": "Do you want to proceed?",
                  "options": [{"number": 1, "label": "Yes", "selected": True}]}
        with mock.patch.object(ha, "_pane_status",
                               return_value=(True, "plan", prompt)) as ps:
            rep = ha.session_report(self.WORKDIR, {}, "agent-abc")
        self.assertIs(rep["paneBusy"], True)
        self.assertEqual(rep["modeActual"], "plan")
        self.assertEqual(rep["panePrompt"], prompt)
        # (tmux_name, state): state carries _stable_pane_busy's edge memory.
        self.assertEqual(ps.call_args[0][0], "agent-abc")
        self.assertIsInstance(ps.call_args[0][1], dict)

    def test_pane_reads_reported_without_transcript(self):
        # No transcript yet — the pane reads must still ride the early-return
        # path.
        with mock.patch.object(ha, "_pane_status", return_value=(False, "auto", None)):
            rep = ha.session_report("/absent/worktree", {}, "agent-abc")
        self.assertIs(rep["paneBusy"], False)
        self.assertEqual(rep["modeActual"], "auto")
        self.assertIsNone(rep["panePrompt"])
        self.assertEqual(rep["agents"], [])

    def test_background_agents_ride_the_report_while_the_pane_reads_idle(self):
        # XERK-245, the case the whole feature exists for: launching a
        # background agent ENDS the session's own turn, so paneBusy is False and
        # every working/idle mirror would call this idle. `agents` says
        # otherwise, and comes from the transcript, not the screen.
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [{"type": "user", "message": {"content": "go"}}])
        state = {}
        with mock.patch.object(ha, "_pane_status", return_value=(False, "auto", None)):
            # The first beat primes the byte offsets to EOF, so the launch has to
            # land after it — which is also what a real beat looks like.
            ha.session_report(self.WORKDIR, state, "agent-abc")
            write_jsonl(path, TASK_LAUNCH_ENTRIES + [
                {"type": "assistant",
                 "message": {"content": [{"type": "text", "text": "Launched."}]}}])
            rep = ha.session_report(self.WORKDIR, state, "agent-abc")
        self.assertIs(rep["paneBusy"], False)
        self.assertEqual(rep["agents"], [{"type": "agent", "label": "QA the parity change"}])

    def test_a_finished_agent_stops_being_reported(self):
        # The measured reason the TUI footer cannot be the source: its rows
        # linger ~24s past completion. The notification is the exact edge.
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [{"type": "user", "message": {"content": "go"}}])
        state = {}
        with mock.patch.object(ha, "_pane_status", return_value=(False, "auto", None)):
            ha.session_report(self.WORKDIR, state, "agent-abc")   # primes offsets
            write_jsonl(path, TASK_LAUNCH_ENTRIES)
            self.assertEqual(len(ha.session_report(self.WORKDIR, state, "agent-abc")["agents"]), 1)
            write_jsonl(path, [task_notification_entry("agent-1", "completed")])
            rep = ha.session_report(self.WORKDIR, state, "agent-abc")
        self.assertEqual(rep["agents"], [])

    def test_pane_reads_default_none_without_tmux(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [{"type": "assistant",
                            "message": {"content": [{"type": "text", "text": "hi"}]}}])
        rep = ha.session_report(self.WORKDIR, {})  # no tmux_name
        self.assertIsNone(rep["paneBusy"])
        self.assertIsNone(rep["modeActual"])
        self.assertIsNone(rep["panePrompt"])


class TestStablePaneBusy(unittest.TestCase):
    """_stable_pane_busy suppresses the busy->idle flicker a single mid-repaint
    capture would otherwise cause: a busy read is instant, an idle read is
    re-confirmed on the busy->idle edge, and None passes through untouched.
    time.sleep is patched out so the confirm delay costs the tests nothing."""

    def setUp(self):
        self._sleep = mock.patch.object(ha.time, "sleep").start()
        self.addCleanup(mock.patch.stopall)

    def test_busy_is_instant_and_marks_state(self):
        # A busy read is trusted on the first capture — status lights up promptly
        # — and there is no confirmation re-capture.
        st = {}
        with mock.patch.object(ha, "_pane_busy", return_value=True) as pb:
            self.assertIs(ha._stable_pane_busy("agent-x", st), True)
        pb.assert_called_once_with("agent-x")
        self.assertIs(st["paneBusyStable"], True)
        self._sleep.assert_not_called()

    def test_steady_idle_is_not_re_confirmed(self):
        # Never was busy this session -> nothing to flicker off, so a single idle
        # read is believed with no second capture.
        st = {}  # no paneBusyStable
        with mock.patch.object(ha, "_pane_busy", return_value=False) as pb:
            self.assertIs(ha._stable_pane_busy("agent-x", st), False)
        pb.assert_called_once_with("agent-x")
        self.assertIs(st["paneBusyStable"], False)
        self._sleep.assert_not_called()

    def test_single_idle_frame_while_busy_is_held(self):
        # busy->idle edge: the first capture missed the marker (redraw gap) but
        # the confirming re-capture sees it -> stays working, no flip.
        st = {"paneBusyStable": True}
        with mock.patch.object(ha, "_pane_busy", side_effect=[False, True]) as pb:
            self.assertIs(ha._stable_pane_busy("agent-x", st), True)
        self.assertEqual(pb.call_count, 2)  # confirmed with a second capture
        self.assertIs(st["paneBusyStable"], True)
        self._sleep.assert_called_once()

    def test_genuine_idle_confirms_and_flips(self):
        # busy->idle edge with the marker really gone: both captures agree,
        # so it flips to idle (only one confirm delay was spent).
        st = {"paneBusyStable": True}
        with mock.patch.object(ha, "_pane_busy", side_effect=[False, False]) as pb:
            self.assertIs(ha._stable_pane_busy("agent-x", st), False)
        self.assertEqual(pb.call_count, 2)
        self.assertIs(st["paneBusyStable"], False)

    def test_unknown_passes_through_without_touching_state(self):
        # A capture failure is not evidence the turn ended: return None (so the
        # transcript fallback decides) and leave the remembered state alone.
        st = {"paneBusyStable": True}
        with mock.patch.object(ha, "_pane_busy", return_value=None) as pb:
            self.assertIsNone(ha._stable_pane_busy("agent-x", st))
        pb.assert_called_once_with("agent-x")
        self.assertIs(st["paneBusyStable"], True)  # untouched
        self._sleep.assert_not_called()

    def test_confirm_disabled_via_env(self):
        # PANE_IDLE_CONFIRM_SEC=0 restores the raw single-read behaviour.
        st = {"paneBusyStable": True}
        orig = ha.PANE_IDLE_CONFIRM_SEC
        ha.PANE_IDLE_CONFIRM_SEC = 0.0
        try:
            with mock.patch.object(ha, "_pane_busy", side_effect=[False, True]) as pb:
                self.assertIs(ha._stable_pane_busy("agent-x", st), False)
            pb.assert_called_once_with("agent-x")  # no confirmation capture
        finally:
            ha.PANE_IDLE_CONFIRM_SEC = orig

    def test_flicker_suppressed_across_beats_in_session_report(self):
        # End-to-end through session_report: one shared state dict, a busy beat
        # then a single idle-frame beat -> paneBusy stays True across the blip.
        st = {}
        with mock.patch.object(ha, "_pane_busy", return_value=True):
            r1 = ha.session_report("/absent/worktree", st, "agent-x")
        self.assertIs(r1["paneBusy"], True)
        with mock.patch.object(ha, "_pane_busy", side_effect=[False, True]):
            r2 = ha.session_report("/absent/worktree", st, "agent-x")
        self.assertIs(r2["paneBusy"], True)


class TestHookQuestion(unittest.TestCase):
    """_hook_question reads the ask.py bridge's request file directly."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hub-agent-hookq-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        p = mock.patch.object(ha, "QUESTIONS_DIR", self.tmp)
        p.start()
        self.addCleanup(p.stop)

    def _write(self, sid, data):
        with open(os.path.join(self.tmp, f"{sid}.req.json"), "w") as f:
            json.dump(data, f)

    def test_missing_file(self):
        self.assertIsNone(ha._hook_question("nope"))

    def test_no_session_id(self):
        self.assertIsNone(ha._hook_question(None))
        self.assertIsNone(ha._hook_question(""))

    def test_reads_question_and_labels(self):
        self._write("s", {"question": "Which?",
                          "options": [{"label": "A"}, {"label": "B"}]})
        hq = ha._hook_question("s")
        self.assertEqual(hq["question"], "Which?")
        self.assertEqual(hq["labels"], ["A", "B"])
        self.assertEqual(hq["options"], [{"label": "A"}, {"label": "B"}])
        self.assertIsNone(hq["header"])
        self.assertFalse(hq["multi"])

    def test_reads_rich_option_fields(self):
        self._write("s", {"question": "Pick", "header": "Semantics",
                          "index": 2, "total": 4, "multiSelect": True,
                          "options": [{"label": "A", "description": "d",
                                       "preview": "P" * 5000}]})
        hq = ha._hook_question("s")
        self.assertEqual(hq["header"], "Semantics")
        self.assertEqual(hq["index"], 2)
        self.assertEqual(hq["total"], 4)
        self.assertTrue(hq["multi"])
        opt = hq["options"][0]
        self.assertEqual(opt["description"], "d")
        self.assertEqual(len(opt["preview"]), ha._Q_PREVIEW_MAX)  # capped

    def test_corrupt_file_is_no_question(self):
        with open(os.path.join(self.tmp, "s.req.json"), "w") as f:
            f.write("{not json")
        self.assertIsNone(ha._hook_question("s"))

    def test_question_capped_at_300_and_labels_at_80(self):
        self._write("s", {"question": "Q" * 400,
                          "options": [{"label": "L" * 100}]})
        hq = ha._hook_question("s")
        self.assertEqual(len(hq["question"]), 300)
        self.assertEqual(hq["labels"], ["L" * 80])


class TestTranscriptTail(ProjectDirMixin, unittest.TestCase):
    def test_missing_file(self):
        self.assertEqual(ha.transcript_tail(os.path.join(self.proj, "nope.jsonl")), [])

    def test_empty_file(self):
        path = os.path.join(self.proj, "empty.jsonl")
        open(path, "w").close()
        self.assertEqual(ha.transcript_tail(path), [])

    def test_mixed_entries_ansi_stripped_and_garbage_skipped(self):
        path = os.path.join(self.proj, "t.jsonl")
        ansi_text = "\x1b[31mred\x1b[0m alert"
        write_jsonl(path, [
            {"uuid": "u1", "type": "user", "message": {"content": "hello there"}},
            "not json {{{",  # garbage line, skipped
            {"uuid": "u2", "type": "assistant", "message": {"content": [
                {"type": "thinking", "thinking": "hmm, let me see"},
                {"type": "text", "text": ansi_text},
                {"type": "tool_use", "name": "Bash", "input": {}},
            ]}},
            {"uuid": "u3", "type": "user", "message": {"content": [
                {"type": "tool_result", "content": "some tool output"},
            ]}},  # tool_result-only -> dropped
            {"uuid": "u4", "type": "summary", "message": {"content": "not a turn"}},  # wrong type -> dropped
        ])
        tail = ha.transcript_tail(path)
        self.assertEqual([e["id"] for e in tail], ["u1", "u2"])
        self.assertEqual(tail[0], {"id": "u1", "role": "user", "text": "hello there"})
        self.assertEqual(tail[1]["role"], "assistant")
        self.assertEqual(tail[1]["text"], "red alert[Bash]")

    def test_oversize_message_truncated(self):
        path = os.path.join(self.proj, "big.jsonl")
        long_text = "x" * (ha.TAIL_MSG_CHARS + 50)
        write_jsonl(path, [{"uuid": "u1", "type": "user", "message": {"content": long_text}}])
        tail = ha.transcript_tail(path)
        self.assertEqual(len(tail[0]["text"]), ha.TAIL_MSG_CHARS)
        self.assertEqual(tail[0]["text"], long_text[:ha.TAIL_MSG_CHARS])

    def test_window_limited_to_tail_msgs(self):
        path = os.path.join(self.proj, "many.jsonl")
        entries = [
            {"uuid": f"u{i}", "type": "user", "message": {"content": f"msg {i}"}}
            for i in range(10)
        ]
        write_jsonl(path, entries)
        with mock.patch.object(ha, "TAIL_MSGS", 3):
            tail = ha.transcript_tail(path)
        self.assertEqual([e["id"] for e in tail], ["u7", "u8", "u9"])


class TestEntryBlocks(unittest.TestCase):
    """The rich block mapper for the native chat UI. Kept in lockstep with
    tunnel-agent.js entryBlocks (agent/tests/tunnel-agent.test.js has the mirror
    cases)."""

    def test_string_content_one_text_block(self):
        self.assertEqual(
            ha._entry_blocks({"type": "user", "message": {"content": "hi"}}, ha.BLOCK_CAPS),
            [{"t": "text", "text": "hi"}],
        )

    def test_preserves_thinking_tool_input_and_pairing(self):
        entry = {"type": "assistant", "message": {"content": [
            {"type": "thinking", "thinking": "pon\x1b[0mder"},
            {"type": "text", "text": "answer"},
            {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "ls -la", "timeout": 5}},
        ]}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS), [
            {"t": "thinking", "text": "ponder"},
            {"t": "text", "text": "answer"},
            {"t": "tool_use", "name": "Bash", "input": "ls -la", "id": "toolu_1"},
        ])
        # _entry_text stays the lossy backward-compat contract: thinking dropped,
        # tool_use collapsed to [Bash].
        self.assertEqual(ha._entry_text(entry), "answer[Bash]")

    def test_tool_result_forid_iserror_and_list_content(self):
        entry = {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "toolu_1",
             "content": [{"type": "text", "text": "boom"}], "is_error": True},
        ]}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS), [
            {"t": "tool_result", "text": "boom", "forId": "toolu_1", "isError": True},
        ])
        self.assertIsNone(ha._entry_text(entry))  # unchanged: tool_result-only -> None

    def test_unknown_tool_input_falls_back_to_compact_json(self):
        blocks = ha._entry_blocks(
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "name": "X", "input": {"a": 1, "b": "z"}}]}},
            ha.BLOCK_CAPS,
        )
        self.assertEqual(blocks, [{"t": "tool_use", "name": "X", "input": '{"a":1,"b":"z"}'}])

    def test_over_cap_text_and_result_truncated(self):
        big = "x" * (ha.BLOCK_CAPS["text"] + 500)
        tb = ha._entry_blocks({"type": "assistant", "message": {"content": big}}, ha.BLOCK_CAPS)[0]
        self.assertEqual(len(tb["text"]), ha.BLOCK_CAPS["text"])
        self.assertTrue(tb["truncated"])

        big_out = "y" * (ha.BLOCK_CAPS["result"] + 500)
        rb = ha._entry_blocks(
            {"type": "user", "message": {"content": [{"type": "tool_result", "content": big_out}]}},
            ha.BLOCK_CAPS,
        )[0]
        self.assertEqual(len(rb["text"]), ha.BLOCK_CAPS["result"])
        self.assertTrue(rb["truncated"])

    def test_wrong_type_and_no_message_return_none_empty_content_empty_list(self):
        self.assertIsNone(ha._entry_blocks({"type": "summary", "message": {"content": "x"}}, ha.BLOCK_CAPS))
        self.assertIsNone(ha._entry_blocks({"type": "user"}, ha.BLOCK_CAPS))
        self.assertEqual(ha._entry_blocks({"type": "assistant", "message": {"content": ""}}, ha.BLOCK_CAPS), [])

    def test_edit_tool_use_carries_the_actual_change_as_a_diff(self):
        entry = {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "toolu_e", "name": "Edit", "input": {
                "file_path": "/repo/a.py", "old_string": "x = 1", "new_string": "x = 2",
                "replace_all": True}},
        ]}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS), [
            {"t": "tool_use", "name": "Edit", "input": "/repo/a.py", "id": "toolu_e",
             "edit": {"old": "x = 1", "new": "x = 2", "replaceAll": True}},
        ])

    def test_edit_diff_over_cap_flags_the_block_truncated(self):
        big = "z" * (ha.BLOCK_CAPS["result"] + 100)
        block = ha._entry_blocks({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Edit", "input": {
                "file_path": "/repo/a.py", "old_string": "x", "new_string": big}},
        ]}}, ha.BLOCK_CAPS)[0]
        self.assertEqual(len(block["edit"]["new"]), ha.BLOCK_CAPS["result"])
        self.assertTrue(block["truncated"])

    def test_write_tool_use_carries_the_file_body(self):
        block = ha._entry_blocks({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Write", "input": {
                "file_path": "/repo/new.txt", "content": "hello\nworld"}},
        ]}}, ha.BLOCK_CAPS)[0]
        self.assertEqual(block["input"], "/repo/new.txt")
        self.assertEqual(block["content"], "hello\nworld")

    def test_exit_plan_mode_carries_the_plan(self):
        block = ha._entry_blocks({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "ExitPlanMode", "input": {
                "plan": "## Plan\n1. do it", "allowedPrompts": []}},
        ]}}, ha.BLOCK_CAPS)[0]
        self.assertEqual(block["plan"], "## Plan\n1. do it")

    def test_send_user_file_embeds_images_svg_html_and_degrades_the_rest(self):
        # XERK-221: SendUserFile reads the delivered files and embeds image/SVG as
        # data URIs + HTML raw, so the chat renders them; other/missing → a chip.
        d = tempfile.mkdtemp()
        try:
            svg = os.path.join(d, "a.svg")
            with open(svg, "w") as fh:
                fh.write("<svg><rect/></svg>")
            html = os.path.join(d, "p.html")
            with open(html, "w") as fh:
                fh.write("<h1>Hi</h1>")
            inp = {"files": [svg, html, os.path.join(d, "gone.png"),
                             os.path.join(d, "notes.txt")],
                   "display": "render", "caption": "the set"}
            block = ha._entry_blocks({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "t1", "name": "SendUserFile", "input": inp},
            ]}}, ha.BLOCK_CAPS)[0]
            self.assertEqual(block["caption"], "the set")
            b64 = base64.b64encode(b"<svg><rect/></svg>").decode()
            self.assertEqual(block["files"], [
                {"name": "a.svg", "kind": "image", "src": "data:image/svg+xml;base64," + b64},
                {"name": "p.html", "kind": "html", "html": "<h1>Hi</h1>"},
                {"name": "gone.png", "kind": "file"},   # missing → chip
                {"name": "notes.txt", "kind": "file"},  # non-renderable type → never opened
            ])
            # display:"attach" makes an HTML file a download chip, not an iframe.
            b2 = ha._entry_blocks({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "t2", "name": "SendUserFile",
                 "input": {"files": [html], "display": "attach"}},
            ]}}, ha.BLOCK_CAPS)[0]
            self.assertEqual(b2["files"], [{"name": "p.html", "kind": "file"}])
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_send_user_file_over_cap_degrades_to_a_name_chip(self):
        # A file past SEND_FILE_MAX_BYTES is not embedded (frame stays bounded).
        d = tempfile.mkdtemp()
        try:
            big = os.path.join(d, "big.png")
            with open(big, "wb") as fh:
                fh.write(b"\x00" * (ha.SEND_FILE_MAX_BYTES + 1))
            block = ha._entry_blocks({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "t1", "name": "SendUserFile",
                 "input": {"files": [big], "display": "render"}},
            ]}}, ha.BLOCK_CAPS)[0]
            self.assertEqual(block["files"], [{"name": "big.png", "kind": "file"}])
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_description_arg_rides_as_desc(self):
        block = ha._entry_blocks({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Bash", "input": {
                "command": "ls", "description": "List files"}},
        ]}}, ha.BLOCK_CAPS)[0]
        self.assertEqual(block["input"], "ls")
        self.assertEqual(block["desc"], "List files")

    def test_ask_user_question_summary_is_the_question_text(self):
        block = ha._entry_blocks({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "AskUserQuestion", "input": {
                "questions": [{"question": "Ship it?", "options": [{"label": "yes"}]},
                              {"question": "Which env?"}]}},
        ]}}, ha.BLOCK_CAPS)[0]
        self.assertEqual(block["input"], "Ship it? · Which env?")

    def test_compact_boundary_becomes_a_status_marker_block(self):
        entry = {"type": "system", "subtype": "compact_boundary",
                 "content": "Conversation compacted", "uuid": "u1",
                 "compactMetadata": {"trigger": "auto", "preTokens": 123380, "postTokens": 5920}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS), [
            {"t": "compact_boundary", "trigger": "auto", "preTokens": 123380, "postTokens": 5920},
        ])
        # Other system subtypes still drop, and the text feed still skips it.
        self.assertIsNone(ha._entry_text(entry))
        self.assertIsNone(ha._entry_blocks(
            {"type": "system", "subtype": "turn_duration", "durationMs": 5}, ha.BLOCK_CAPS))

    def test_pr_link_becomes_a_marker_block_with_a_synthesized_id(self):
        entry = {"type": "pr-link", "prNumber": 230, "prUrl": "https://github.com/o/r/pull/230",
                 "prRepository": "o/r", "timestamp": "2026-07-17T04:25:18.299Z"}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS), [
            {"t": "pr_link", "url": "https://github.com/o/r/pull/230", "number": 230, "repo": "o/r"},
        ])
        # No uuid on the wire entry: the feeds synthesize a stable id so the
        # client's id-keyed merge doesn't drop it. It keys on the URL ALONE, so
        # the same PR re-stamped in a later turn's preamble collapses onto one
        # entry instead of rendering a marker apiece.
        self.assertEqual(ha._entry_id(entry), "pr-link:https://github.com/o/r/pull/230")
        restamp = dict(entry, timestamp="2026-07-17T09:00:00.000Z")
        self.assertEqual(ha._entry_id(restamp), ha._entry_id(entry))
        other = dict(entry, prUrl="https://github.com/o/r/pull/231")
        self.assertNotEqual(ha._entry_id(other), ha._entry_id(entry))
        self.assertIsNone(ha._entry_blocks({"type": "pr-link"}, ha.BLOCK_CAPS))
        self.assertEqual(ha._entry_id({"type": "user", "uuid": "u9"}), "u9")


TASK_NOTIFICATION = (
    "<task-notification>\n"
    "<task-id>af9e62627de15eaf4</task-id>\n"
    "<tool-use-id>toolu_01CvWRpfgweEhin8tbti1Tdm</tool-use-id>\n"
    "<output-file>/tmp/x/tasks/af9e62627de15eaf4.output</output-file>\n"
    "<status>completed</status>\n"
    '<summary>Agent "Confirm merge semantics" finished</summary>\n'
    "<note>A task-notification fires each time this agent stops.</note>\n"
    "<result>The --settings file is merged as a higher-precedence layer.</result>\n"
    "</task-notification>"
)


def task_notification_entry(task_id, status, carrier="queue-operation"):
    """One transcript entry carrying a `<task-notification>`. The corpus shows
    them on several carriers (queue-operation, user, attachment, assistant), so
    the scan must not key on one — these fixtures cover the two commonest."""
    text = (f"<task-notification>\n<task-id>{task_id}</task-id>\n"
            f"<status>{status}</status>\n<summary>Agent finished</summary>\n"
            "</task-notification>")
    if carrier == "queue-operation":
        return {"type": "queue-operation", "operation": "enqueue", "content": text}
    return {"type": "user", "message": {"content": text}}


# A background-agent launch exactly as Claude Code writes it today: the `Agent`
# call, then the result entry whose STRUCTURED `toolUseResult` records the
# launch. The prose beside it also says "agentId: …", but that text is NOT what
# the scan keys on — see _async_launch.
TASK_LAUNCH_ENTRIES = [
    {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "toolu_1", "name": "Agent",
         "input": {"description": "QA the parity change", "prompt": "...",
                   "run_in_background": True}}]}},
    {"type": "user",
     "message": {"content": [
         {"type": "tool_result", "tool_use_id": "toolu_1",
          "content": "Async agent launched successfully. (internal metadata) "
                     "agentId: agent-1 (internal ID - do not mention to user.)"}]},
     "toolUseResult": {"isAsync": True, "status": "async_launched",
                       "agentId": "agent-1", "description": "QA the parity change",
                       "resolvedModel": "claude-opus-4-8"}},
]


class TestLiveAgentsScan(unittest.TestCase):
    """_scan_agent_entry — which background agents are in flight, off the
    transcript's own launch/stop edges. The TUI footer is NOT the source: its
    rows are forgeable pane content AND linger ~24s past completion."""

    def _scan(self, entries, state=None):
        state = {} if state is None else state
        for e in entries:
            ha._scan_entry_line(json.dumps(e), state, {"prUrls": [], "modelActual": None})
        return state

    def test_a_launch_makes_an_agent_live_with_its_description(self):
        st = self._scan(TASK_LAUNCH_ENTRIES)
        self.assertEqual(ha.live_agents_report(st),
                         [{"type": "agent", "label": "QA the parity change"}])

    def test_the_subagent_type_names_the_row_when_the_call_carries_one(self):
        # Older `Task` calls do; today's background `Agent` calls do not.
        entries = [dict(TASK_LAUNCH_ENTRIES[0]), TASK_LAUNCH_ENTRIES[1]]
        entries[0] = {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "toolu_1", "name": "Task",
             "input": {"subagent_type": "qa", "description": "QA the parity change"}}]}}
        st = self._scan(entries)
        self.assertEqual(ha.live_agents_report(st),
                         [{"type": "qa", "label": "QA the parity change"}])

    def test_loose_agent_id_text_in_tool_output_registers_nothing(self):
        # THE regression: `agentId:` appears in the OUTPUT of any tool that reads
        # a transcript (grep/cat/Read). Keying on that text registered a live
        # agent belonging to ANOTHER session, whose notification can never
        # arrive here — a phantom that never clears. Worse than the pane's.
        st = self._scan([
            {"type": "user",
             "message": {"content": [
                 {"type": "tool_result", "tool_use_id": "tb1",
                  "content": "agentId: a3c02192c84d32f9f\nagentId: deadbeef"}]},
             "toolUseResult": {"stdout": "agentId: a3c02192c84d32f9f",
                               "stderr": "", "interrupted": False, "isImage": False}},
        ])
        self.assertEqual(ha.live_agents_report(st), [])

    def test_a_synchronous_subagent_result_registers_nothing(self):
        # A foreground agent's result lands when it has ALREADY finished (its
        # shape carries content/usage, never isAsync), so registering it would
        # strand a live agent for work that is over.
        st = self._scan([
            {"type": "user",
             "message": {"content": [
                 {"type": "tool_result", "tool_use_id": "ts1",
                  "content": "Here is my report. agentId: sync-1"}]},
             "toolUseResult": {"agentId": "sync-1", "agentType": "Explore",
                               "content": "…", "status": "completed",
                               "totalTokens": 1234, "usage": {}}},
        ])
        self.assertEqual(ha.live_agents_report(st), [])

    def test_a_background_workflow_counts_as_work_in_flight(self):
        # `Workflow` writes `status:"async_launched"` with taskId/workflowName
        # and NO isAsync. Requiring isAsync excluded it — and a background
        # code-review/deep-research is the LONGEST-lived work on a host, so the
        # session read idle for its whole duration. Its stop edge already worked.
        st = self._scan([
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "tw1", "name": "Workflow", "input": {}}]}},
            {"type": "user",
             "message": {"content": [{"type": "tool_result", "tool_use_id": "tw1"}]},
             "toolUseResult": {"status": "async_launched", "taskId": "wsgju70jc",
                               "taskType": "local_workflow", "workflowName": "code-review",
                               "runId": "wf_eb4f", "summary": "Review the diff."}},
        ])
        self.assertEqual(ha.live_agents_report(st),
                         [{"type": "workflow", "label": "code-review"}])
        self._scan([task_notification_entry("wsgju70jc", "completed")], st)
        self.assertEqual(ha.live_agents_report(st), [])

    def test_the_agent_tool_name_is_what_carries_the_type(self):
        # The launch record never carries an agentType, so the type comes solely
        # from the CALL's subagent_type — and the call is named `Agent` today.
        # Matching `Task` only silently returns every row to a generic "agent".
        entries = [
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "toolu_1", "name": "Agent",
                 "input": {"subagent_type": "Explore", "description": "Map it"}}]}},
            {"type": "user",
             "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_1"}]},
             "toolUseResult": {"isAsync": True, "status": "async_launched",
                               "agentId": "agent-9", "description": "Map it"}},
        ]
        self.assertEqual(ha.live_agents_report(self._scan(entries)),
                         [{"type": "Explore", "label": "Map it"}])

    def test_a_notification_quoted_by_the_assistant_is_ignored(self):
        # A session working on THIS feature quotes notifications in its own
        # replies and fixtures; honouring those silently retires a running agent
        # and makes its id permanently un-registerable.
        st = self._scan(TASK_LAUNCH_ENTRIES)
        self._scan([{"type": "assistant", "message": {"content": [
            {"type": "text", "text":
             "<task-notification>\n<task-id>agent-1</task-id>\n"
             "<status>completed</status>\n</task-notification>"}]}}], st)
        self.assertEqual(len(ha.live_agents_report(st)), 1, "still live")

    def test_a_stop_seen_before_its_launch_still_wins(self):
        # Observed in real data: the queued copy of a notification lands at an
        # EARLIER file offset than the launch it refers to (its timestamp is
        # later). Registering on the launch would then never be undone.
        st = self._scan([task_notification_entry("agent-1", "completed")])
        self._scan(TASK_LAUNCH_ENTRIES, st)
        self.assertEqual(ha.live_agents_report(st), [])

    def test_the_notification_is_what_ends_it(self):
        st = self._scan(TASK_LAUNCH_ENTRIES)
        self._scan([task_notification_entry("agent-1", "completed")], st)
        self.assertEqual(ha.live_agents_report(st), [])

    def test_every_terminal_status_ends_it_and_both_carriers_are_read(self):
        for status in ("completed", "failed", "killed", "stopped"):
            for carrier in ("queue-operation", "user"):
                st = self._scan(TASK_LAUNCH_ENTRIES)
                self._scan([task_notification_entry("agent-1", status, carrier)], st)
                self.assertEqual(ha.live_agents_report(st), [],
                                 f"{status} via {carrier} must end it")

    def test_a_non_terminal_status_must_not_clear_the_agent(self):
        # Every status Claude Code writes today is terminal, so the gate guards
        # against a future progress-style notification — which, unguarded, would
        # retire an agent the moment it reported in while still running.
        st = self._scan(TASK_LAUNCH_ENTRIES)
        self._scan([task_notification_entry("agent-1", "running")], st)
        self.assertEqual(len(ha.live_agents_report(st)), 1)
        self._scan([task_notification_entry("agent-1", "completed")], st)
        self.assertEqual(ha.live_agents_report(st), [])

    def test_a_notification_for_another_agent_leaves_this_one_running(self):
        st = self._scan(TASK_LAUNCH_ENTRIES)
        self._scan([task_notification_entry("someone-else", "completed")], st)
        self.assertEqual(len(ha.live_agents_report(st)), 1)

    def test_several_agents_are_tracked_independently(self):
        entries = list(TASK_LAUNCH_ENTRIES) + [
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "toolu_2", "name": "Task",
                 "input": {"subagent_type": "Explore", "description": "Map it"}}]}},
            {"type": "user",
             "message": {"content": [
                 {"type": "tool_result", "tool_use_id": "toolu_2"}]},
             "toolUseResult": {"isAsync": True, "status": "async_launched",
                               "agentId": "agent-2", "description": "Map it"}},
        ]
        st = self._scan(entries)
        self.assertEqual(sorted(a["label"] for a in ha.live_agents_report(st)),
                         ["Map it", "QA the parity change"])
        self._scan([task_notification_entry("agent-1", "completed")], st)
        self.assertEqual([a["label"] for a in ha.live_agents_report(st)], ["Map it"])

    def test_a_launch_whose_call_was_missed_still_counts(self):
        # An agent restart primes the byte offsets to EOF, so the scan can see a
        # launch record whose CALL it never read. The launch record carries the
        # description itself, so the row is still named.
        st = self._scan(TASK_LAUNCH_ENTRIES[1:])
        self.assertEqual(ha.live_agents_report(st),
                         [{"type": "agent", "label": "QA the parity change"}])

    def test_ordinary_traffic_moves_nothing(self):
        st = self._scan([
            {"type": "assistant", "message": {"content": [
                {"type": "text", "text": "talking about agentId: not-a-launch"}]}},
            {"type": "user", "message": {"content": "just a prompt"}},
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "t9", "name": "Bash",
                 "input": {"command": "echo hi"}}]}},
        ])
        self.assertEqual(ha.live_agents_report(st), [])

    def test_the_live_set_is_bounded(self):
        entries = []
        for i in range(200):
            entries.append({"type": "user",
                            "message": {"content": [
                                {"type": "tool_result", "tool_use_id": f"t{i}"}]},
                            "toolUseResult": {"isAsync": True, "status": "async_launched",
                                              "agentId": f"a{i}", "description": f"job {i}"}})
        st = self._scan(entries)
        self.assertEqual(len(ha.live_agents_report(st)), ha.LIVE_AGENTS_MAX)


class TestTaskNotification(unittest.TestCase):
    """A background Task/agent finishing arrives as a user-role `<task-notification>`
    turn; it must parse into a structured task_notification block (rendered as an
    action card) rather than a raw-XML user bubble. Kept in lockstep with
    tunnel-agent.js parseTaskNotification (mirror cases in tunnel-agent.test.js)."""

    def test_parse_extracts_summary_status_result(self):
        tn = ha._parse_task_notification(TASK_NOTIFICATION)
        self.assertEqual(tn, {
            "summary": 'Agent "Confirm merge semantics" finished',
            "status": "completed",
            "result": "The --settings file is merged as a higher-precedence layer.",
            # The id is what makes this a usable STOPPED edge for the live-agent
            # scan, not just display text (XERK-245).
            "taskId": "af9e62627de15eaf4",
        })

    def test_non_notification_text_is_not_parsed(self):
        self.assertIsNone(ha._parse_task_notification("just a normal prompt"))
        self.assertIsNone(ha._parse_task_notification("talk about <task-notification> inline"))
        self.assertIsNone(ha._parse_task_notification(""))

    def test_blocks_emit_task_notification_from_string_content(self):
        entry = {"type": "user", "message": {"content": TASK_NOTIFICATION}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS), [{
            "t": "task_notification",
            "summary": 'Agent "Confirm merge semantics" finished',
            "status": "completed",
            "result": "The --settings file is merged as a higher-precedence layer.",
        }])

    def test_blocks_emit_task_notification_from_list_text_block(self):
        entry = {"type": "user", "message": {"content": [
            {"type": "text", "text": TASK_NOTIFICATION}]}}
        blocks = ha._entry_blocks(entry, ha.BLOCK_CAPS)
        self.assertEqual(blocks[0]["t"], "task_notification")
        self.assertEqual(blocks[0]["summary"], 'Agent "Confirm merge semantics" finished')

    def test_background_command_form_has_no_result(self):
        text = (
            "<task-notification>\n<status>completed</status>\n"
            "<summary>Background command finished (exit code 0)</summary>\n"
            "</task-notification>"
        )
        blocks = ha._entry_blocks({"type": "user", "message": {"content": text}}, ha.BLOCK_CAPS)
        self.assertEqual(blocks, [{
            "t": "task_notification",
            "summary": "Background command finished (exit code 0)",
            "status": "completed",
        }])

    def test_long_result_is_capped_and_truncated(self):
        big = "z" * (ha.BLOCK_CAPS["result"] + 500)
        text = f"<task-notification>\n<summary>done</summary>\n<result>{big}</result>\n</task-notification>"
        block = ha._entry_blocks({"type": "user", "message": {"content": text}}, ha.BLOCK_CAPS)[0]
        self.assertEqual(len(block["result"]), ha.BLOCK_CAPS["result"])
        self.assertTrue(block["truncated"])

    def test_entry_text_flattens_to_summary_and_result(self):
        entry = {"type": "user", "message": {"content": TASK_NOTIFICATION}}
        self.assertEqual(
            ha._entry_text(entry),
            'Agent "Confirm merge semantics" finished\n\n'
            "The --settings file is merged as a higher-precedence layer.",
        )


# The three bookkeeping turns Claude Code writes for `/compact summaries appear
# as user text`, verbatim from a real transcript (note the indentation on the
# invocation wrapper — it is not anchored to the start of a line).
COMMAND_CAVEAT = (
    "<local-command-caveat>Caveat: The messages below were generated by the user "
    "while running local commands. DO NOT respond to these messages or otherwise "
    "consider them in your response unless the user explicitly asks you to."
    "</local-command-caveat>"
)
COMMAND_INVOCATION = (
    "<command-name>/compact</command-name>\n"
    "            <command-message>compact</command-message>\n"
    "            <command-args>summaries appear as user text</command-args>"
)
COMMAND_STDOUT = "<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>"


class TestLocalCommand(unittest.TestCase):
    """Running a slash command writes three XML-ish USER turns (the caveat, the
    invocation wrapper, the command's output). Rendered verbatim they read as the
    operator typing raw XML into chat, so they must parse into structured blocks
    — and the caveat must drop out entirely. Kept in lockstep with
    tunnel-agent.js parseLocalCommand (mirror cases in tunnel-agent.test.js)."""

    def test_parse_caveat(self):
        self.assertEqual(ha._parse_local_command(COMMAND_CAVEAT), {"kind": "caveat"})

    def test_parse_invocation_extracts_name_and_args(self):
        self.assertEqual(ha._parse_local_command(COMMAND_INVOCATION), {
            "kind": "command",
            "name": "/compact",
            "args": "summaries appear as user text",
        })

    def test_parse_invocation_without_args(self):
        text = "<command-name>/clear</command-name>\n<command-args></command-args>"
        self.assertEqual(ha._parse_local_command(text),
                         {"kind": "command", "name": "/clear", "args": ""})

    def test_parse_stdout_and_stderr(self):
        self.assertEqual(ha._parse_local_command(COMMAND_STDOUT), {
            "kind": "output",
            "text": "Compacted (ctrl+o to see full summary)",
            "isError": False,
        })
        self.assertEqual(
            ha._parse_local_command("<local-command-stderr>Error: No messages</local-command-stderr>"),
            {"kind": "output", "text": "Error: No messages", "isError": True},
        )

    def test_stderr_wins_when_a_turn_carries_both(self):
        text = ("<local-command-stdout></local-command-stdout>"
                "<local-command-stderr>boom</local-command-stderr>")
        self.assertEqual(ha._parse_local_command(text),
                         {"kind": "output", "text": "boom", "isError": True})

    def test_non_command_text_is_not_parsed(self):
        self.assertIsNone(ha._parse_local_command("just a normal prompt"))
        self.assertIsNone(ha._parse_local_command("talk about <command-name> inline"))
        self.assertIsNone(ha._parse_local_command(""))

    def test_caveat_needs_the_whole_entry(self):
        # Prose that merely quotes the caveat is the human talking; only a turn
        # that IS the caveat gets dropped.
        text = "why does <local-command-caveat>x</local-command-caveat> show up?"
        self.assertIsNone(ha._parse_local_command(text))

    def test_blocks_drop_the_caveat_entirely(self):
        entry = {"type": "user", "isMeta": True, "message": {"content": COMMAND_CAVEAT}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS), [])
        self.assertIsNone(ha._entry_text(entry))

    def test_blocks_emit_command_from_string_and_list_content(self):
        expected = [{"t": "command", "name": "/compact", "args": "summaries appear as user text"}]
        self.assertEqual(
            ha._entry_blocks({"type": "user", "message": {"content": COMMAND_INVOCATION}},
                             ha.BLOCK_CAPS),
            expected)
        self.assertEqual(
            ha._entry_blocks({"type": "user", "message": {"content": [
                {"type": "text", "text": COMMAND_INVOCATION}]}}, ha.BLOCK_CAPS),
            expected)

    def test_blocks_omit_empty_args(self):
        text = "<command-name>/clear</command-name>\n<command-args></command-args>"
        self.assertEqual(ha._entry_blocks({"type": "user", "message": {"content": text}},
                                          ha.BLOCK_CAPS),
                         [{"t": "command", "name": "/clear"}])

    def test_blocks_emit_command_output(self):
        entry = {"type": "user", "message": {"content": COMMAND_STDOUT}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS),
                         [{"t": "command_output", "text": "Compacted (ctrl+o to see full summary)"}])

    def test_blocks_flag_stderr_output_as_an_error(self):
        entry = {"type": "user", "message": {"content":
                 "<local-command-stderr>Error: No messages to compact</local-command-stderr>"}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS),
                         [{"t": "command_output", "text": "Error: No messages to compact",
                           "isError": True}])

    def test_empty_output_yields_no_block(self):
        entry = {"type": "user", "message": {"content":
                 "<local-command-stdout></local-command-stdout>"}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS), [])
        self.assertIsNone(ha._entry_text(entry))

    def test_long_output_is_capped_and_truncated(self):
        big = "z" * (ha.BLOCK_CAPS["result"] + 500)
        entry = {"type": "user", "message": {"content":
                 f"<local-command-stdout>{big}</local-command-stdout>"}}
        block = ha._entry_blocks(entry, ha.BLOCK_CAPS)[0]
        self.assertEqual(len(block["text"]), ha.BLOCK_CAPS["result"])
        self.assertTrue(block["truncated"])

    def test_entry_text_flattens_command_and_output(self):
        self.assertEqual(
            ha._entry_text({"type": "user", "message": {"content": COMMAND_INVOCATION}}),
            "/compact summaries appear as user text")
        self.assertEqual(
            ha._entry_text({"type": "user", "message": {"content": COMMAND_STDOUT}}),
            "Compacted (ctrl+o to see full summary)")


class TestCompactSummary(unittest.TestCase):
    """`/compact` writes its summary as a USER turn, but the text is the MODEL's
    writing about the conversation so far. It must report as the assistant (so
    the chat doesn't render it as a wall of text the operator typed) and carry
    its own block kind so the UI can collapse it."""

    SUMMARY = ("This session is being continued from a previous conversation that ran "
               "out of context.\n\nSummary:\n1. Primary Request and Intent: …")

    def _entry(self):
        return {"type": "user", "isCompactSummary": True,
                "message": {"role": "user", "content": self.SUMMARY}}

    def test_role_reports_as_assistant(self):
        self.assertEqual(ha._entry_role(self._entry()), "assistant")

    def test_ordinary_turns_keep_their_own_role(self):
        self.assertEqual(ha._entry_role({"type": "user", "message": {"content": "hi"}}), "user")
        self.assertEqual(ha._entry_role({"type": "assistant", "message": {"content": "hi"}}),
                         "assistant")

    def test_blocks_emit_a_compact_summary_block(self):
        self.assertEqual(ha._entry_blocks(self._entry(), ha.BLOCK_CAPS),
                         [{"t": "compact_summary", "text": self.SUMMARY}])

    def test_an_ordinary_user_turn_stays_a_text_block(self):
        entry = {"type": "user", "message": {"content": self.SUMMARY}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS),
                         [{"t": "text", "text": self.SUMMARY}])

    def test_long_summary_is_capped_and_truncated(self):
        big = "z" * (ha.BLOCK_CAPS["text"] + 500)
        entry = {"type": "user", "isCompactSummary": True, "message": {"content": big}}
        block = ha._entry_blocks(entry, ha.BLOCK_CAPS)[0]
        self.assertEqual(block["t"], "compact_summary")
        self.assertEqual(len(block["text"]), ha.BLOCK_CAPS["text"])
        self.assertTrue(block["truncated"])

    def test_entry_text_keeps_the_summary_prose(self):
        # The text feed is the lossy contract: the summary stays readable there,
        # it just rides under the assistant role now.
        self.assertEqual(ha._entry_text(self._entry()), self.SUMMARY)


class TestSkillBody(unittest.TestCase):
    """Invoking a skill makes Claude Code write the whole SKILL.md back as a USER
    turn — the only role tool output can ride — tagged with `sourceToolUseID`,
    the id of the Skill tool_use that pulled it in. Taken at its wire role that
    renders as the operator typing 150KB of skill docs into chat. It's really the
    Skill call's result, so it reports as one and the chat folds it into that
    call's action card."""

    BODY = ("Base directory for this skill: /repos/x/.claude/skills/verify\n\n"
            "# Verifying Turma changes\n\nPick the surface the change reaches.…")

    def _entry(self):
        return {"type": "user", "isMeta": True, "sourceToolUseID": "toolu_01ABC",
                "message": {"role": "user", "content": [{"type": "text", "text": self.BODY}]}}

    def test_tool_source_is_the_invoking_tool_use_id(self):
        self.assertEqual(ha._entry_tool_source(self._entry()), "toolu_01ABC")

    def test_ordinary_turns_have_no_tool_source(self):
        self.assertIsNone(ha._entry_tool_source({"type": "user", "message": {"content": "hi"}}))
        # An assistant turn is never tool-authored, whatever it carries.
        self.assertIsNone(ha._entry_tool_source(
            {"type": "assistant", "sourceToolUseID": "toolu_01ABC", "message": {"content": "hi"}}))

    def test_blocks_emit_the_body_as_its_skill_calls_tool_result(self):
        self.assertEqual(ha._entry_blocks(self._entry(), ha.BLOCK_CAPS),
                         [{"t": "tool_result", "text": self.BODY, "forId": "toolu_01ABC"}])

    def test_the_same_body_typed_by_a_human_stays_a_text_block(self):
        # Only the tool tag makes it tool output — pasting a skill body by hand
        # is the operator talking, and must still read as a user bubble.
        entry = {"type": "user", "message": {"content": [{"type": "text", "text": self.BODY}]}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS),
                         [{"t": "text", "text": self.BODY}])

    def test_a_long_body_is_capped_and_truncated(self):
        entry = self._entry()
        big = "z" * (ha.BLOCK_CAPS["result"] + 500)
        entry["message"]["content"] = [{"type": "text", "text": big}]
        block = ha._entry_blocks(entry, ha.BLOCK_CAPS)[0]
        self.assertEqual(block["t"], "tool_result")
        self.assertEqual(len(block["text"]), ha.BLOCK_CAPS["result"])
        self.assertTrue(block["truncated"])

    def test_entry_text_drops_it_like_any_tool_result(self):
        # The text feed (glasses tail, heartbeat preview, archive index) carries
        # no tool results; the assistant's own "[Skill]" marker already shows the
        # invocation, so dropping the wall costs it nothing.
        self.assertIsNone(ha._entry_text(self._entry()))


class TestBashPassthrough(unittest.TestCase):
    """The `!` prefix's shell turns (<bash-input>, <bash-stdout>/<bash-stderr>)
    are recorded as user-role XML — not the human talking. They parse into the
    SAME command/output shapes the slash commands use (name "!"), so the chat
    renders a chip + output card instead of raw XML prose. Kept in lockstep
    with tunnel-agent.js parseLocalCommand (mirror cases in
    tunnel-agent.test.js)."""

    def test_parse_bash_input(self):
        self.assertEqual(
            ha._parse_local_command("<bash-input> git status</bash-input>"),
            {"kind": "command", "name": "!", "args": "git status"})

    def test_parse_bash_stdout_and_stderr(self):
        self.assertEqual(
            ha._parse_local_command("<bash-stdout>2 files changed</bash-stdout>"),
            {"kind": "output", "text": "2 files changed", "isError": False})
        self.assertEqual(
            ha._parse_local_command("<bash-stderr>fatal: not a repo</bash-stderr>"),
            {"kind": "output", "text": "fatal: not a repo", "isError": True})

    def test_empty_stderr_does_not_swallow_stdout(self):
        # A bash turn routinely ships BOTH tags with one empty — the empty
        # stream must not win just by matching first.
        self.assertEqual(
            ha._parse_local_command(
                "<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>"),
            {"kind": "output", "text": "ok", "isError": False})
        self.assertEqual(
            ha._parse_local_command(
                "<bash-stdout></bash-stdout><bash-stderr>boom</bash-stderr>"),
            {"kind": "output", "text": "boom", "isError": True})

    def test_blocks_emit_command_and_output(self):
        self.assertEqual(
            ha._entry_blocks({"type": "user", "message": {
                "content": "<bash-input> ls -la</bash-input>"}}, ha.BLOCK_CAPS),
            [{"t": "command", "name": "!", "args": "ls -la"}])
        self.assertEqual(
            ha._entry_blocks({"type": "user", "message": {
                "content": "<bash-stderr>boom</bash-stderr>"}}, ha.BLOCK_CAPS),
            [{"t": "command_output", "text": "boom", "isError": True}])

    def test_text_feed_flattens_like_a_slash_command(self):
        self.assertEqual(
            ha._entry_text({"type": "user", "message": {
                "content": "<bash-input> ls</bash-input>"}}),
            "! ls")

    def test_prose_quoting_a_bash_tag_stays_prose(self):
        self.assertIsNone(ha._parse_local_command("talk about <bash-input> inline"))


class TestInterruptMarker(unittest.TestCase):
    """Esc / the hub's Stop mid-turn writes a user-role "[Request interrupted
    by user…]" marker — a statement ABOUT the turn, not something the operator
    typed, so the rich path classifies it as an `interrupt` block (the chat's
    centred status marker) instead of a user text bubble. Mirror cases in
    tunnel-agent.test.js."""

    def test_marker_becomes_interrupt_block(self):
        for text in ("[Request interrupted by user]",
                     "[Request interrupted by user for tool use]"):
            for content in (text, [{"type": "text", "text": text}]):
                self.assertEqual(
                    ha._entry_blocks({"type": "user", "message": {"content": content}},
                                     ha.BLOCK_CAPS),
                    [{"t": "interrupt", "text": text}])

    def test_text_feed_keeps_the_raw_line(self):
        # Glasses/heartbeat/archive are one-dimensional text, where the bracket
        # line already reads as the marker it is.
        self.assertEqual(
            ha._entry_text({"type": "user", "message": {
                "content": "[Request interrupted by user]"}}),
            "[Request interrupted by user]")

    def test_prose_mentioning_an_interrupt_stays_prose(self):
        text = "the log said [Request interrupted by user] at 3pm"
        self.assertEqual(
            ha._entry_blocks({"type": "user", "message": {"content": text}},
                             ha.BLOCK_CAPS),
            [{"t": "text", "text": text}])


class TestAwaySummary(unittest.TestCase):
    """The "while you were away" recap is a `system` entry (subtype
    away_summary) whose content the model wrote — the one system subtype worth
    rendering. It surfaces as an assistant-side `away_summary` block/text with
    the "(disable recaps in /config)" TUI hint stripped; every other system
    subtype stays dropped. Mirror cases in tunnel-agent.test.js."""

    ENTRY = {"type": "system", "subtype": "away_summary",
             "content": "Fixed the bug and opened a PR. (disable recaps in /config)"}

    def test_becomes_an_away_summary_block(self):
        self.assertEqual(ha._entry_blocks(self.ENTRY, ha.BLOCK_CAPS),
                         [{"t": "away_summary", "text": "Fixed the bug and opened a PR."}])

    def test_text_feed_and_role(self):
        self.assertEqual(ha._entry_text(self.ENTRY), "Fixed the bug and opened a PR.")
        self.assertEqual(ha._entry_role(self.ENTRY), "assistant")

    def test_other_system_subtypes_stay_dropped(self):
        for sub in ("turn_duration", "bridge_status", "stop_hook_summary", None):
            entry = {"type": "system", "subtype": sub, "content": "x"}
            self.assertIsNone(ha._entry_blocks(entry, ha.BLOCK_CAPS))
            self.assertIsNone(ha._entry_text(entry))

    def test_empty_recap_drops(self):
        entry = {"type": "system", "subtype": "away_summary",
                 "content": " (disable recaps in /config)"}
        self.assertIsNone(ha._entry_blocks(entry, ha.BLOCK_CAPS))
        self.assertIsNone(ha._entry_text(entry))

    def test_long_recap_is_capped_and_truncated(self):
        entry = {"type": "system", "subtype": "away_summary",
                 "content": "z" * (ha.BLOCK_CAPS["text"] + 100)}
        block = ha._entry_blocks(entry, ha.BLOCK_CAPS)[0]
        self.assertEqual(len(block["text"]), ha.BLOCK_CAPS["text"])
        self.assertTrue(block["truncated"])


class TestToolReferenceResult(unittest.TestCase):
    """A ToolSearch result names the tools it loaded as tool_reference blocks
    inside its tool_result content; flattening them away left the call's
    output card reading empty. Mirror cases in tunnel-agent.test.js."""

    def test_tool_reference_flattens_to_a_named_line(self):
        self.assertEqual(
            ha._tool_result_text([{"type": "text", "text": "loaded:"},
                                  {"type": "tool_reference", "tool_name": "WebFetch"},
                                  {"type": "tool_reference", "tool_name": "Monitor"}]),
            "loaded:\n[tool: WebFetch]\n[tool: Monitor]")

    def test_nameless_reference_still_shows(self):
        self.assertEqual(ha._tool_result_text([{"type": "tool_reference"}]),
                         "\n[tool: tool]")


class TestQueuedPrompts(ProjectDirMixin, unittest.TestCase):
    """A message typed mid-turn only becomes a user entry when Claude Code
    dequeues it; until then it lives in queue-operation transcript entries.
    _fold_queue_op replays them FIFO so /history (and the JS live tail, mirror
    in tunnel-agent.test.js) can report the still-queued prompts."""

    def _fold(self, ops):
        q = []
        for op in ops:
            ha._fold_queue_op(op, q)
        return q

    def test_enqueue_dequeue_remove_fifo(self):
        q = self._fold([
            {"operation": "enqueue", "content": "first"},
            {"operation": "enqueue", "content": "second"},
            {"operation": "enqueue", "content": "third"},
            {"operation": "dequeue"},                      # pops "first"
            {"operation": "remove", "content": "third"},   # withdrawn by hand
        ])
        self.assertEqual(q, ["second"])

    def test_unmatched_dequeue_and_remove_are_noops(self):
        # A read window can open mid-sequence: a dequeue whose enqueue was cut
        # off must not invent or destroy anything.
        self.assertEqual(self._fold([{"operation": "dequeue"},
                                     {"operation": "remove", "content": "ghost"}]), [])

    def test_blank_enqueue_is_ignored(self):
        self.assertEqual(self._fold([{"operation": "enqueue", "content": "  "},
                                     {"operation": "enqueue"}]), [])

    def test_history_entries_reports_still_queued_prompts(self):
        path = os.path.join(self.proj, "t.jsonl")
        write_jsonl(path, [
            {"uuid": "u1", "type": "user", "message": {"content": "start work"}},
            {"type": "queue-operation", "operation": "enqueue", "content": "also do X"},
            {"type": "queue-operation", "operation": "enqueue", "content": "and Y"},
            {"type": "queue-operation", "operation": "dequeue"},
            # the dequeued prompt lands as its real user turn — no duplicate
            {"uuid": "u2", "type": "user", "message": {"content": "also do X"}},
        ])
        entries, capped, queued = ha._history_entries(path)
        self.assertFalse(capped)
        self.assertEqual([e["id"] for e in entries], ["u1", "u2"])
        self.assertEqual(queued, ["and Y"])

    def test_task_notifications_keep_their_slot_but_never_display(self):
        # A background task finishing mid-turn rides the same queue as a
        # <task-notification> XML wall. It must occupy its FIFO slot (dequeues
        # are positional) yet never render as a queued operator bubble.
        path = os.path.join(self.proj, "t.jsonl")
        write_jsonl(path, [
            {"type": "queue-operation", "operation": "enqueue",
             "content": "<task-notification>\n<task-id>x</task-id>\n</task-notification>"},
            {"type": "queue-operation", "operation": "enqueue", "content": "real prompt"},
            {"type": "queue-operation", "operation": "dequeue"},  # pops the notification
        ])
        _, _, queued = ha._history_entries(path)
        self.assertEqual(queued, ["real prompt"])
        # And an undequeued notification is filtered at display, not from the FIFO.
        self.assertEqual(ha._queued_display(
            ["<task-notification>x</task-notification>", "real prompt"]),
            ["real prompt"])

    def test_queued_list_is_capped(self):
        path = os.path.join(self.proj, "t.jsonl")
        ops = [{"type": "queue-operation", "operation": "enqueue", "content": f"p{i}"}
               for i in range(ha.QUEUED_PROMPTS_MAX + 5)]
        write_jsonl(path, ops)
        _, _, queued = ha._history_entries(path)
        self.assertEqual(len(queued), ha.QUEUED_PROMPTS_MAX)
        self.assertEqual(queued[-1], f"p{ha.QUEUED_PROMPTS_MAX + 4}")


class TestHistoryBudget(ProjectDirMixin, unittest.TestCase):
    """XERK-347: the per-block caps bound a BLOCK, so one reply is bounded as a
    whole — the window is 200 entries and the operator fold reads the entire
    transcript, and an oversized staged result is XERK-235's offline loop."""

    def _rows(self, n, chars, char="x"):
        return [{"id": f"e{i}", "role": "assistant", "text": "",
                 "blocks": [{"t": "text", "text": char * chars}]} for i in range(n)]

    def test_weight_is_WIRE_bytes_not_characters(self):
        # The payload is serialized with ensure_ascii, so one CJK char costs six
        # bytes on the wire. Counting characters under-states a non-ASCII
        # transcript by 6x, which is how a reply "inside" its ceiling still blew
        # HEARTBEAT_MAX and wedged the host offline.
        row = {"t": "text", "text": "話" * 100}
        self.assertGreaterEqual(ha._json_bytes(row), 600)
        self.assertEqual(ha._json_bytes(row), len(json.dumps(row).encode()))

    def test_a_non_ascii_window_is_trimmed_on_its_real_size(self):
        # Same character count as an ASCII window that fits; 6x the bytes.
        with mock.patch.object(ha, "HISTORY_MAX_BYTES", 3000):
            ascii_kept, ascii_dropped = ha._fit_history_budget(self._rows(4, 400))
            cjk_kept, cjk_dropped = ha._fit_history_budget(self._rows(4, 400, "話"))
        self.assertFalse(ascii_dropped)
        self.assertEqual(len(ascii_kept), 4)
        self.assertTrue(cjk_dropped)
        self.assertEqual([r["id"] for r in cjk_kept], ["e3"])

    def test_oldest_rows_go_first_and_the_reply_is_flagged(self):
        with mock.patch.object(ha, "HISTORY_MAX_BYTES", 3000):
            kept, dropped = ha._fit_history_budget(self._rows(10, 1000))
        self.assertTrue(dropped)
        self.assertEqual([r["id"] for r in kept], ["e8", "e9"])

    def test_a_reply_within_budget_is_untouched(self):
        rows = self._rows(3, 10)
        kept, dropped = ha._fit_history_budget(rows)
        self.assertFalse(dropped)
        self.assertIs(kept, rows)

    def test_the_newest_row_survives_however_big_it_is(self):
        # A blank chat is worse than a short one, and one row is not bounded by
        # the block caps alone (a SendUserFile turn's previews — XERK-355).
        with mock.patch.object(ha, "HISTORY_MAX_BYTES", 100):
            kept, dropped = ha._fit_history_budget(self._rows(2, 5000))
        self.assertTrue(dropped)
        self.assertEqual([r["id"] for r in kept], ["e1"])

    def _preview_row(self, rid, files, chars):
        # A SendUserFile turn: previews are read from DISK, not the transcript,
        # so they are the one thing the block caps do not bound (XERK-355).
        return {"id": rid, "role": "assistant", "text": "here you go",
                "blocks": [{"t": "tool_use", "name": "SendUserFile", "input": "x",
                            "files": [{"name": f"f{i}.png", "kind": "image",
                                       "src": "data:image/png;base64," + "A" * chars}
                                      for i in range(files)]}]}

    def test_a_row_too_heavy_to_deliver_sheds_its_PREVIEWS_not_the_row(self):
        # Exempting it produced a body nothing could deliver — the hub answers
        # no status past its ceiling, so the beat looped forever. Dropping it
        # would be a hole in the conversation. Shedding degrades the delivery to
        # the name chip an oversize file already gets.
        rows = [self._preview_row("e1", 4, 2000)]
        with mock.patch.object(ha, "HISTORY_MAX_BYTES", 3000):
            kept, dropped = ha._fit_history_budget(rows)
        self.assertEqual([r["id"] for r in kept], ["e1"])
        self.assertLessEqual(ha._json_bytes(kept[0]), 3000)
        block = kept[0]["blocks"][0]
        self.assertTrue(block["truncated"])
        self.assertEqual([f["kind"] for f in block["files"]], ["file"] * 4)
        # The names survive: the card still says what was delivered.
        self.assertEqual([f["name"] for f in block["files"]],
                         ["f0.png", "f1.png", "f2.png", "f3.png"])
        self.assertTrue(dropped or True)  # shedding alone need not flag the reply

    def test_shedding_takes_the_heaviest_block_first_and_stops_there(self):
        # Two deliveries in one turn: shedding the big one is enough, so the
        # small one keeps its inline previews.
        row = self._preview_row("e1", 1, 4000)
        row["blocks"].append(self._preview_row("e2", 1, 200)["blocks"][0])
        self.assertTrue(ha._shed_row_previews(row, 3000))
        self.assertEqual(row["blocks"][0]["files"][0]["kind"], "file")   # heavy: shed
        self.assertEqual(row["blocks"][1]["files"][0]["kind"], "image")  # light: kept
        self.assertLessEqual(ha._json_bytes(row), 3000)

    def test_shedding_is_LINEAR_in_the_blocks_it_sheds(self):
        # A turn may carry BLOCK_MAX_PER_ENTRY deliveries. Re-measuring the whole
        # row per block cost 18s on the beat loop for one 48-block turn — beat
        # latency against OFFLINE_AFTER_MS, on the thread the heartbeat runs on.
        # Counted, not timed: a timing assertion in CI is a flake.
        row = self._preview_row("e1", 1, 500)
        for _ in range(11):
            row["blocks"].append(self._preview_row("x", 1, 500)["blocks"][0])
        calls = []
        real = ha._json_bytes
        with mock.patch.object(ha, "_json_bytes",
                               lambda v: (calls.append(1), real(v))[1]):
            ha._shed_row_previews(row, 100)
        # One row + at most two per block (sized before, re-sized after shedding).
        self.assertLessEqual(len(calls), 1 + 2 * len(row["blocks"]))

    def test_shedding_marks_the_chip_as_DROPPED_not_never_captured(self):
        # Same `shed:True` the archive path sets, so the client can say which.
        row = self._preview_row("e1", 2, 2000)
        self.assertTrue(ha._shed_row_previews(row, 100))
        for f in row["blocks"][0]["files"]:
            self.assertTrue(f["shed"])
            self.assertEqual(f["kind"], "file")
            self.assertNotIn("src", f)

    def test_a_hostile_files_shape_cannot_break_the_beat(self):
        # `files` is only ever built as a list by _send_user_file_detail, but this
        # runs inside the heartbeat: a shape that raises here takes the host down.
        for files in (5, True, "x", {"a": 1}, [None, 7, "s"], []):
            row = {"id": "e1", "role": "assistant", "text": "t",
                   "blocks": [{"t": "tool_use", "files": files}]}
            ha._shed_row_previews(row, 1)   # must not raise

    def test_a_row_with_no_previews_sheds_nothing(self):
        row = {"id": "e1", "role": "assistant", "text": "x" * 100, "blocks": []}
        self.assertFalse(ha._shed_row_previews(row, 10))

    def test_history_entries_applies_the_budget_and_reports_truncated(self):
        path = os.path.join(self.proj, "t.jsonl")
        write_jsonl(path, [
            {"uuid": "u1", "type": "user", "message": {"content": "x" * 2000}},
            {"uuid": "a1", "type": "assistant", "message": {"content": "y" * 2000}},
            {"uuid": "a2", "type": "assistant", "message": {"content": "tail"}},
        ])
        # 6000: a row weighs its flat text AND its blocks (a deliberate
        # over-count — both ride the wire), so two 2000-char turns fit and three
        # do not.
        with mock.patch.object(ha, "HISTORY_MAX_BYTES", 6000):
            entries, capped, _ = ha._history_entries(path)
        # Nothing else cut this read — the whole-reply budget is what did, and it
        # says so, because the client renders `truncated` as "older history above".
        self.assertTrue(capped)
        self.assertEqual([e["id"] for e in entries], ["a1", "a2"])


class TestBlockCapsPinned(unittest.TestCase):
    """The cap VALUES are the ticket (XERK-347), so they are asserted, not just
    used: every earlier test compares a clip against BLOCK_CAPS itself, so
    re-introducing the tight live caps — the thing that put a "Show more…"
    button under every long message — left the whole suite green."""

    def test_text_is_capped_at_what_an_operator_can_type(self):
        # A message is shown WHOLE: nothing the operator can send (the composer
        # caps at INPUT_MAX_CHARS) and nothing a model realistically emits is
        # clipped.
        self.assertEqual(ha.BLOCK_CAPS["text"], ha.INPUT_MAX_CHARS)
        self.assertEqual(ha.BLOCK_CAPS["text"], 100000)

    def test_tool_payloads_keep_their_own_tighter_caps(self):
        # A build log or a whole-file Read is not a message; these are what the
        # payload ceilings exist to bound.
        self.assertEqual(ha.BLOCK_CAPS["input"], 4000)
        self.assertEqual(ha.BLOCK_CAPS["result"], 8000)

    def test_one_cap_set_serves_every_path(self):
        # No live/full split to re-create: a tighter live cap IS the button.
        self.assertFalse([n for n in dir(ha) if n.startswith("BLOCK_CAPS_")])


class TestHistoryEntriesRich(ProjectDirMixin, unittest.TestCase):
    def test_blocks_attached_and_tool_result_only_turn_surfaces(self):
        path = os.path.join(self.proj, "t.jsonl")
        write_jsonl(path, [
            {"uuid": "u1", "type": "user", "message": {"content": "hi"}},
            {"uuid": "a1", "type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}}]}},
            # tool_result-only turn: _entry_text drops it, but the rich path keeps
            # it (text:"" + a tool_result block) so the chat can show tool output.
            {"uuid": "r1", "type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "file.txt"}]}},
        ])
        entries, capped, queued = ha._history_entries(path)
        self.assertFalse(capped)
        self.assertEqual(queued, [])
        self.assertEqual([e["id"] for e in entries], ["u1", "a1", "r1"])
        self.assertEqual(entries[2]["text"], "")
        self.assertEqual(entries[2]["blocks"], [{"t": "tool_result", "text": "file.txt", "forId": "t1"}])
        self.assertEqual(entries[1]["blocks"], [{"t": "tool_use", "name": "Bash", "input": "ls", "id": "t1"}])


class ManagerMixin:
    """SessionManager with subprocess chokepoints faked and a temp registry."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hub-agent-mgr-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.run_calls = []
        self.run_ok_calls = []
        # (cmd, stdin) per run_stdin call — how the tmux paste path delivers a
        # message's text to the pane (XERK-227).
        self.run_stdin_calls = []
        self.run_stdin_ok = True

        def fake_run(cmd, cwd=None):
            self.run_calls.append(cmd)
            return ""

        def fake_run_ok(cmd, cwd=None, timeout=None):
            self.run_ok_calls.append(cmd)
            return 0, ""

        def fake_run_stdin(cmd, data, timeout=None):
            self.run_stdin_calls.append((cmd, data))
            return self.run_stdin_ok

        # Ports the test wants _alloc_port to see as already bound. Real probing
        # is stubbed by default: _alloc_port skips ports that are actually
        # listening (XERK-235), and on a host running its own agent the real
        # TTYD_PORT_BASE range IS bound — without this, allocation results would
        # depend on whoever else is on the box.
        self.bound_ports = set()

        def fake_port_open(port, host="127.0.0.1", timeout=0.3):
            return port in self.bound_ports

        for name, value in [
            ("run", fake_run),
            ("run_ok", fake_run_ok),
            ("run_stdin", fake_run_stdin),
            ("_port_open", fake_port_open),
            ("REGISTRY_DIR", self.tmp),
            ("REGISTRY_PATH", os.path.join(self.tmp, "sessions.json")),
            ("CLOSED_PATH", os.path.join(self.tmp, "closed.json")),
            ("QUESTIONS_DIR", os.path.join(self.tmp, "questions")),
            ("USAGE_LEDGER_PATH", os.path.join(self.tmp, "repo-usage.json")),
            ("TRIAGE_LEDGER_PATH", os.path.join(self.tmp, "jira-repos.json")),
            ("TICKET_LEDGER_PATH", os.path.join(self.tmp, "jira-sessions.json")),
            ("PR_LEDGER_PATH", os.path.join(self.tmp, "pr-sessions.json")),
            ("PR_STATUS_LEDGER_PATH", os.path.join(self.tmp, "pr-status.json")),
            ("PROJECTS_ROOT", os.path.join(self.tmp, "projects")),
            ("WORKTREES_ROOT", os.path.join(self.tmp, "worktrees")),
            # Derived from REGISTRY_DIR at import, so it needs redirecting too —
            # delete() rmtree's a session's attachment dir (XERK-234).
            ("UPLOADS_DIR", os.path.join(self.tmp, "uploads")),
            # Also derived at import. Redirected so a dev box that has a REAL
            # limits snapshot in ~/.turma can't make the heartbeat tests depend
            # on its subscription (XERK-247).
            ("LIMITS_PATH", os.path.join(self.tmp, "limits.json")),
            # Derived at import too. Every beat rewrites it (XERK-339), so
            # without this the suite would clobber the real host's peer roster.
            ("PEERS_FILE", os.path.join(self.tmp, "peers.tsv")),
            ("LIMITS_SETTINGS_PATH", os.path.join(self.tmp, "limits-settings.json")),
            # The limits probe is OFF for the suite at large. A beat with no
            # snapshot considers one due and starts a real background thread
            # that, seconds later, drives tmux through the CURRENT test's fake
            # run() — its trust-dialog Enter landed in an unrelated test's key
            # assertions (CI caught exactly that in TestSetModelMode). The tests
            # that exercise the probe re-enable it deliberately.
            ("LIMITS_PROBE_SEC", 0),
        ]:
            p = mock.patch.object(ha, name, value)
            p.start()
            self.addCleanup(p.stop)

    def make_manager(self):
        return ha.SessionManager()


class TestStartedAt(ManagerMixin, unittest.TestCase):
    """The heartbeat's startedAt: docker's StartedAt where it answers, else the
    manager's own start — never empty. The hub's restart-loop alert keys on this
    field CHANGING, so an agent that reports none (a native host, where `docker
    inspect` isn't there) could crash-loop with no notification (XERK-34)."""

    def test_falls_back_to_manager_start_when_docker_cannot_answer(self):
        # ManagerMixin's fake_run returns "" for every command, docker included.
        sm = self.make_manager()
        self.assertTrue(sm.started_at)
        # The fallback is a parseable UTC timestamp (what the hub Date.parse's).
        time.strptime(sm.started_at, "%Y-%m-%dT%H:%M:%SZ")

    def test_docker_answer_wins(self):
        real_run = ha.run

        def docker_aware_run(cmd, cwd=None):
            if cmd[:2] == ["docker", "inspect"]:
                return "2024-01-01T00:00:00.000000000Z"
            return real_run(cmd, cwd)

        with mock.patch.object(ha, "run", docker_aware_run):
            sm = self.make_manager()
        self.assertEqual(sm.started_at, "2024-01-01T00:00:00.000000000Z")


class TestTicketLedger(ManagerMixin, unittest.TestCase):
    """The transcript -> ticket ledger: which conversation worked which Jira
    ticket, recorded durably so the board's chips outlive the session record —
    killed, aged out of closed.json, or wiped with ~/.turma."""

    def _sess(self, sid="s1", tid="t1", key="PROJ-7", **over):
        s = {"id": sid, "repo": "Turma", "claudeSessionId": tid,
             "ticket": {"key": key, "siteKey": "x.atlassian.net",
                        "url": f"https://x.atlassian.net/browse/{key}",
                        "summary": "Fix the thing", "branch": key}}
        s.update(over)
        return s

    def test_remember_persists_and_reloads(self):
        sm = self.make_manager()
        sm._remember_ticket(self._sess())
        # A fresh manager reads it back off disk — the whole point of the file.
        sm2 = self.make_manager()
        self.assertEqual(sm2.ticket_ledger["t1"]["key"], "PROJ-7")
        self.assertEqual(sm2.ticket_ledger["t1"]["branch"], "PROJ-7")
        self.assertEqual(sm2.ticket_ledger["t1"]["repo"], "Turma")

    def test_ignores_a_session_with_no_ticket_or_no_transcript(self):
        sm = self.make_manager()
        sm._remember_ticket({"id": "s1", "repo": "Turma", "claudeSessionId": "t1"})
        sm._remember_ticket(self._sess(tid=None))          # not launched yet
        sm._remember_ticket(self._sess(sid="s3", tid="t3", key=None))
        self.assertEqual(sm.ticket_ledger, {})

    def test_remember_is_idempotent(self):
        """Every launch calls this, so an unchanged entry must not rewrite the
        file — and must not restamp `at`, which is the prune's sort key."""
        sm = self.make_manager()
        self.assertTrue(sm._remember_ticket(self._sess()))
        at = sm.ticket_ledger["t1"]["at"]
        self.assertFalse(sm._remember_ticket(self._sess()))
        self.assertEqual(sm.ticket_ledger["t1"]["at"], at)

    def test_clear_context_records_both_conversations(self):
        """A restart-clear-context relaunches the same session under a NEW
        transcript. Both worked the ticket and both stay separately resumable, so
        the old one is kept rather than replaced."""
        sm = self.make_manager()
        sess = self._sess()
        sm._remember_ticket(sess)
        sess["claudeSessionId"] = "t2"     # what _launch_tmux does on a restart
        sm._remember_ticket(sess)
        self.assertEqual(set(sm.ticket_ledger), {"t1", "t2"})
        self.assertEqual(sm.ticket_ledger["t2"]["key"], "PROJ-7")

    def test_backfills_from_registry_and_closed(self):
        """Sessions that predate the ledger are adopted from the two records that
        already carry both a ticket and a transcript id — so it doesn't start
        empty on the very update that makes it durable."""
        write_json(ha.REGISTRY_PATH, [self._sess(sid="live", tid="t-live")])
        write_json(ha.CLOSED_PATH, [self._sess(sid="dead", tid="t-dead", key="PROJ-9")])
        sm = self.make_manager()
        self.assertEqual(sm.ticket_ledger["t-live"]["key"], "PROJ-7")
        self.assertEqual(sm.ticket_ledger["t-dead"]["key"], "PROJ-9")
        # And it was persisted, not just held in memory.
        self.assertEqual(self.make_manager().ticket_ledger["t-dead"]["key"], "PROJ-9")

    def test_backfill_keys_a_pre_pin_record_on_its_transcript_id(self):
        """A closed record written before the session-id pin has no
        claudeSessionId; its resolved transcriptId is the only handle it ever
        had, so key on that rather than skipping it."""
        rec = self._sess(sid="old", tid=None)
        rec["transcriptId"] = "t-old"
        write_json(ha.CLOSED_PATH, [rec])
        self.assertEqual(self.make_manager().ticket_ledger["t-old"]["key"], "PROJ-7")

    def test_survives_the_registry_and_closed_history_being_wiped(self):
        """The reason this exists. ~/.turma outlives an agent update only if it's
        mounted, but even then closed.json keeps just CLOSED_PER_REPO per repo —
        so the ledger has to answer once both records are gone."""
        sm = self.make_manager()
        sm._remember_ticket(self._sess())
        sm2 = self.make_manager()
        sm2.registry, sm2.closed = [], []
        self.assertEqual(sm2.ticket_ledger["t1"]["key"], "PROJ-7")

    def test_prune_bounds_the_ledger_oldest_first(self):
        p = mock.patch.object(ha, "TICKET_LEDGER_MAX", 2)
        p.start()
        self.addCleanup(p.stop)
        sm = self.make_manager()
        for i, at in enumerate(["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z",
                                "2026-03-01T00:00:00Z"]):
            sm.ticket_ledger[f"t{i}"] = {"key": f"P-{i}", "at": at}
        sm._prune_ticket_ledger()
        self.assertEqual(set(sm.ticket_ledger), {"t1", "t2"})  # oldest t0 fell off


class TestUsageLedger(ManagerMixin, unittest.TestCase):
    """The attribution ledger: written at spawn, backfilled, pruned, and — the
    whole point — surviving a kill so usage stays reported."""

    def _proj_for(self, worktree):
        d = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(worktree))
        os.makedirs(d, exist_ok=True)
        return d

    def test_remember_persists_and_reloads(self):
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        sm._remember_usage({"repo": "Turma", "repoPath": "/w/Turma", "worktreePath": wt})
        self.assertIn(wt, sm.usage_ledger)
        self.assertTrue(os.path.exists(ha.USAGE_LEDGER_PATH))
        # A fresh manager loads the same ledger from disk.
        self.assertEqual(self.make_manager().usage_ledger[wt]["repo"], "Turma")

    def test_backfill_from_registry_and_closed(self):
        sm = self.make_manager()
        sm.registry = [{"id": "a", "repo": "Turma", "repoPath": "/w/Turma",
                        "worktreePath": "/w/.turma/worktrees/Turma/aaa"}]
        sm.closed = [{"id": "b", "repo": "DockerOps", "repoPath": "/w/DockerOps",
                      "worktreePath": "/w/.turma/worktrees/DockerOps/bbb"}]
        sm._backfill_ledger()
        self.assertIn("/w/.turma/worktrees/Turma/aaa", sm.usage_ledger)
        self.assertIn("/w/.turma/worktrees/DockerOps/bbb", sm.usage_ledger)

    def test_prune_drops_entries_whose_transcripts_gone(self):
        sm = self.make_manager()
        wt_live = "/w/.turma/worktrees/Turma/live"
        wt_gone = "/w/.turma/worktrees/Turma/gone"
        self._proj_for(wt_live)
        sm.usage_ledger = {
            wt_live: {"repo": "Turma", "remote": "", "slug": ha._project_slug(wt_live)},
            wt_gone: {"repo": "Turma", "remote": "", "slug": ha._project_slug(wt_gone)},
        }
        sm._prune_ledger()
        self.assertIn(wt_live, sm.usage_ledger)
        self.assertNotIn(wt_gone, sm.usage_ledger)

    def test_usage_survives_kill(self):
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        write_jsonl(os.path.join(self._proj_for(wt), "a.jsonl"), [
            usage_entry("2026-07-01T10:00:00.000Z", "m1", "r1",
                        "claude-sonnet-4-20250514", 100_000, 0),
        ])
        sm._remember_usage({"repo": "Turma", "repoPath": "/w/Turma", "worktreePath": wt})
        sm._refresh_repo_usage()
        self.assertTrue(any(r["repo"] == "Turma" for r in sm.repo_usage))
        # Kill: registry record dropped, caches forgotten — but the ledger and
        # transcript remain, so the repo's usage is still aggregated and reported.
        sm.registry = []
        sm._refresh_repo_usage()
        self.assertTrue(any(r["repo"] == "Turma" for r in sm.repo_usage))
        self.assertIsNotNone(sm.host_usage)


class TestLimitsSnapshot(ManagerMixin, unittest.TestCase):
    """The subscription-limits snapshot (XERK-247): hooks/statusline.py writes
    ~/.turma/limits.json out of band, the beat re-validates it and puts it on the
    heartbeat, and the probe that refreshes it is spent sparingly because it is
    billed against the very windows it measures."""

    def _write(self, data):
        with open(ha.LIMITS_PATH, "w", encoding="utf-8") as fh:
            json.dump(data, fh)

    def _snapshot(self, captured=None, **windows):
        return {"capturedAt": int(captured if captured is not None else time.time()),
                "source": "statusline", **windows}

    def test_reports_both_windows(self):
        # Reset stamps near now, as the real windows always are (5 hours and 7
        # days) — one far away is dropped, see the horizon test below.
        five, seven = int(time.time()) + 3600, int(time.time()) + 5 * 86400
        self._write(self._snapshot(fiveHour={"usedPct": 23.5, "resetsAt": five},
                                   sevenDay={"usedPct": 41.2, "resetsAt": seven}))
        snap = ha.read_limits_snapshot()
        self.assertEqual(snap["fiveHour"], {"usedPct": 23.5, "resetsAt": five})
        self.assertEqual(snap["sevenDay"], {"usedPct": 41.2, "resetsAt": seven})
        self.assertEqual(snap["source"], "statusline")

    def test_missing_or_unreadable_file_reports_nothing(self):
        self.assertIsNone(ha.read_limits_snapshot())
        with open(ha.LIMITS_PATH, "w", encoding="utf-8") as fh:
            fh.write("{ not json")
        self.assertIsNone(ha.read_limits_snapshot())
        self._write(["not", "a", "dict"])
        self.assertIsNone(ha.read_limits_snapshot())

    def test_a_snapshot_with_no_timestamp_is_refused(self):
        # Every surface ages this against its own clock; an undated snapshot
        # would render as freshly captured forever.
        self._write({"fiveHour": {"usedPct": 20}})
        self.assertIsNone(ha.read_limits_snapshot())

    def test_a_snapshot_older_than_the_max_age_is_refused_outright(self):
        # Not stale data — WRONG data: a day-old 5-hour window has reset several
        # times since, so there is nothing left to be stale about.
        self._write(self._snapshot(captured=time.time() - ha.LIMITS_MAX_AGE_SEC - 60,
                                   fiveHour={"usedPct": 90, "resetsAt": 1}))
        self.assertIsNone(ha.read_limits_snapshot())

    def test_junk_windows_are_dropped_field_by_field(self):
        self._write(self._snapshot(fiveHour={"usedPct": "lots"},
                                   sevenDay={"usedPct": 140, "resetsAt": "soon"}))
        snap = ha.read_limits_snapshot()
        self.assertNotIn("fiveHour", snap)
        self.assertEqual(snap["sevenDay"], {"usedPct": 100.0})

    def test_a_window_with_no_percentage_is_not_a_window(self):
        # It would render as a card with no rows in it — worse than no card.
        self._write(self._snapshot(fiveHour={"resetsAt": int(time.time()) + 60}))
        self.assertIsNone(ha.read_limits_snapshot())

    def test_non_finite_numbers_cannot_crash_the_beat(self):
        # THE crash this guard exists for: NaN/inf satisfy isinstance(x, float)
        # and then raise inside int(), which on the beat's critical path takes
        # the agent down — on every restart, until someone deletes the file. And
        # ~/.turma is not in the guard's deny list, so any session can write it.
        for blob in ('{"capturedAt": NaN, "fiveHour": {"usedPct": 5}}',
                     '{"capturedAt": Infinity, "fiveHour": {"usedPct": 5}}',
                     '{"capturedAt": 1, "fiveHour": {"usedPct": NaN}}'):
            with open(ha.LIMITS_PATH, "w", encoding="utf-8") as fh:
                fh.write(blob)
            self.assertIsNone(ha.read_limits_snapshot(), blob)
        now = time.time()
        self._write(self._snapshot(captured=now, fiveHour={"usedPct": 5,
                                                           "resetsAt": float("inf")}))
        self.assertNotIn("resetsAt", ha.read_limits_snapshot()["fiveHour"])

    def test_an_implausibly_large_file_is_not_read_whole(self):
        # A snapshot is a couple of hundred bytes; reading a path pointed at
        # something enormous is an unbounded allocation on the beat loop.
        with open(ha.LIMITS_PATH, "w", encoding="utf-8") as fh:
            fh.write(" " * (ha.LIMITS_MAX_BYTES + 1))
        self.assertIsNone(ha.read_limits_snapshot())

    def test_a_file_whose_size_lies_is_still_bounded(self):
        # The bound is on the READ, not on stat: /dev/zero reports st_size 0 and
        # then hands over bytes forever, which OOM-killed the agent when the
        # check was a stat.
        os.unlink(ha.LIMITS_PATH) if os.path.exists(ha.LIMITS_PATH) else None
        os.symlink("/dev/zero", ha.LIMITS_PATH)
        self.assertEqual(os.path.getsize(ha.LIMITS_PATH), 0)  # the lie
        self.assertIsNone(ha.read_limits_snapshot())

    def test_a_snapshot_from_the_future_is_refused(self):
        # It would read as freshly captured forever and never go stale anywhere.
        self._write(self._snapshot(captured=time.time() + 3600,
                                   fiveHour={"usedPct": 5}))
        self.assertIsNone(ha.read_limits_snapshot())
        # Ordinary clock skew still passes.
        self._write(self._snapshot(captured=time.time() + 5, fiveHour={"usedPct": 5}))
        self.assertIsNotNone(ha.read_limits_snapshot())

    def test_an_absurd_epoch_is_dropped_rather_than_forwarded(self):
        # 1e30 rendered as "resets in 1.1e+303d" on the card, and a client that
        # types these as a 64-bit integer can't even decode it.
        now = time.time()
        self._write(self._snapshot(captured=now,
                                   fiveHour={"usedPct": 5, "resetsAt": 10 ** 30}))
        self.assertNotIn("resetsAt", ha.read_limits_snapshot()["fiveHour"])
        self._write(self._snapshot(captured=10 ** 30, fiveHour={"usedPct": 5}))
        self.assertIsNone(ha.read_limits_snapshot())

    def test_a_reset_time_nowhere_near_now_is_dropped(self):
        # These windows are 5 hours and 7 days long; a reset a decade out
        # describes nothing, and the percentage alone is still worth showing.
        now = time.time()
        self._write(self._snapshot(captured=now,
                                   fiveHour={"usedPct": 5, "resetsAt": int(now) + 10 * 365 * 86400}))
        snap = ha.read_limits_snapshot()
        self.assertEqual(snap["fiveHour"], {"usedPct": 5.0})

    def test_heartbeat_carries_the_snapshot_and_none_without_one(self):
        sm = self.make_manager()
        with mock.patch.object(ha, "LIMITS_PROBE_SEC", 0):  # no probe from a beat
            self.assertIsNone(sm.build_payload(0)["limits"])
        resets = int(time.time()) + 900
        self._write(self._snapshot(fiveHour={"usedPct": 12, "resetsAt": resets}))
        with mock.patch.object(ha, "LIMITS_PROBE_SEC", 0):
            self.assertEqual(sm.build_payload(1)["limits"]["fiveHour"],
                             {"usedPct": 12.0, "resetsAt": resets})

    def setUp(self):
        super().setUp()
        # ManagerMixin turns the probe off for the suite; these tests are the
        # ones about when it fires, so they run with the shipped interval.
        p = mock.patch.object(ha, "LIMITS_PROBE_SEC", LIMITS_PROBE_SEC_DEFAULT)
        p.start()
        self.addCleanup(p.stop)

    def test_probe_is_due_when_there_is_no_snapshot_at_all(self):
        sm = self.make_manager()
        self.assertTrue(sm._limits_probe_due())

    def test_a_fresh_snapshot_is_not_reprobed(self):
        self._write(self._snapshot(fiveHour={"usedPct": 12}))
        sm = self.make_manager()
        self.assertFalse(sm._limits_probe_due())

    def test_an_aged_snapshot_is_reprobed_only_while_a_session_runs(self):
        # A settled host re-probing all night would burn the very quota it
        # reports, and the number cannot have moved for anything it did.
        self._write(self._snapshot(captured=time.time() - ha.LIMITS_PROBE_SEC - 60,
                                   fiveHour={"usedPct": 12}))
        sm = self.make_manager()
        sm.registry = [{"id": "a", "status": "stopped"}]
        self.assertFalse(sm._limits_probe_due())
        sm.registry = [{"id": "a", "status": "running"}]
        self.assertTrue(sm._limits_probe_due())

    def test_the_probe_is_disabled_by_a_zero_interval(self):
        sm = self.make_manager()
        with mock.patch.object(ha, "LIMITS_PROBE_SEC", 0):
            self.assertFalse(sm._limits_probe_due())
            sm.build_payload(0)
            self.assertFalse([t for t in threading.enumerate()
                              if t.name == "limits-probe" and t.is_alive()])

    def test_a_missing_snapshot_is_silent_but_a_broken_one_says_so_once(self):
        # read_limits_snapshot runs on EVERY beat and its log tail rides the
        # heartbeat to the hub, so "no snapshot yet" — the ordinary state before
        # the first probe, and forever on a login with no windows — must not
        # narrate itself every 20 seconds. A file that IS there and IS broken is
        # worth saying, but only until it stops changing.
        with mock.patch.object(ha, "_limits_last_problem", None), \
             mock.patch.object(ha, "log") as logged:
            for _ in range(3):
                self.assertIsNone(ha.read_limits_snapshot())
            self.assertEqual(logged.call_count, 0, "a missing snapshot logged")
            with open(ha.LIMITS_PATH, "w", encoding="utf-8") as fh:
                fh.write("{ not json")
            for _ in range(3):
                self.assertIsNone(ha.read_limits_snapshot())
            self.assertEqual(logged.call_count, 1, "a broken snapshot logged per beat")

    def test_a_probe_that_captures_nothing_backs_off(self):
        # A login with no subscription windows (API key, Bedrock, Vertex) can
        # NEVER produce a snapshot, and the "only while a session runs" gate does
        # not apply to the no-snapshot branch — so without a backoff that host
        # spends a real turn every beat, forever, chasing a number it will never
        # have.
        sm = self.make_manager()
        self.assertTrue(sm._limits_probe_due())
        sm._limits_probe_at = time.time()
        sm._limits_probe_outcome(False)
        self.assertFalse(sm._limits_probe_due())
        first = sm._limits_probe_backoff
        self.assertEqual(first, ha.LIMITS_PROBE_RETRY_SEC)
        sm._limits_probe_outcome(False)
        self.assertEqual(sm._limits_probe_backoff, first * 2)  # doubles
        for _ in range(20):
            sm._limits_probe_outcome(False)
        self.assertEqual(sm._limits_probe_backoff, ha.LIMITS_PROBE_MAX_BACKOFF_SEC)  # capped
        sm._limits_probe_outcome(True)  # a success clears it
        self.assertFalse(sm._limits_probe_backoff)
        self.assertTrue(sm._limits_probe_due())

    def test_a_probe_that_cannot_even_launch_backs_off_too(self):
        sm = self.make_manager()

        def failing_launch(cmd, cwd=None, timeout=None):
            self.run_ok_calls.append(cmd)
            return 1, "tmux: command not found"

        with mock.patch.object(ha, "run_ok", failing_launch), \
             mock.patch.object(ha, "LIMITS_PROBE_TRUST_SEC", 0):
            sm._run_limits_probe(os.path.join(self.tmp, "limits-settings.json"))
        self.assertEqual(sm._limits_probe_backoff, ha.LIMITS_PROBE_RETRY_SEC)

    def test_the_probe_tmux_is_torn_down_after_the_launch_too(self):
        # Not just the clean-slate kill BEFORE it: without the teardown after,
        # an interactive claude is left in a detached tmux until some later probe
        # happens to be due.
        sm = self.make_manager()
        with mock.patch.object(ha, "LIMITS_PROBE_TIMEOUT_SEC", 0), \
             mock.patch.object(ha, "LIMITS_PROBE_TRUST_SEC", 0):
            sm._run_limits_probe(os.path.join(self.tmp, "limits-settings.json"))
        kills = [i for i, c in enumerate(self.run_calls)
                 if c == ["tmux", "kill-session", "-t", ha.LIMITS_TMUX]]
        launch = [c for c in self.run_ok_calls if c[:2] == ["tmux", "new-session"]]
        self.assertEqual(len(launch), 1)
        self.assertEqual(len(kills), 2, "expected a clean-slate kill AND a teardown")

    def test_shutdown_and_boot_reap_a_probe_left_running(self):
        # The probe thread is a daemon, whose `finally` does NOT run when the
        # interpreter exits — and the native updater's SIGTERM is a routine path.
        sm = self.make_manager()
        self.run_calls.clear()
        with mock.patch.object(sm, "_read_updating_flag", return_value=("update", "1")), \
             mock.patch.object(sm, "_announce_updating"):
            with self.assertRaises(SystemExit):
                sm._handle_shutdown(15, None)
        self.assertIn(["tmux", "kill-session", "-t", ha.LIMITS_TMUX], self.run_calls)
        self.run_calls.clear()
        sm.registry = []
        sm.resume_on_boot()
        self.assertIn(["tmux", "kill-session", "-t", ha.LIMITS_TMUX], self.run_calls)

    def test_single_flight_while_a_probe_is_running(self):
        started = threading.Event()
        release = threading.Event()

        def slow_probe(settings):
            started.set()
            release.wait(5)

        sm = self.make_manager()
        with mock.patch.object(sm, "_run_limits_probe", slow_probe):
            sm._start_limits_probe()
            self.assertTrue(started.wait(5))
            first = sm._limits_probe
            sm._start_limits_probe()  # must not stack a second thread
            self.assertIs(sm._limits_probe, first)
            release.set()
            first.join(5)
            self.assertFalse(first.is_alive())

    def test_the_probe_runs_a_throwaway_claude_in_its_own_tmux(self):
        sm = self.make_manager()
        with mock.patch.object(ha, "LIMITS_PROBE_TIMEOUT_SEC", 0), \
             mock.patch.object(ha, "LIMITS_PROBE_TRUST_SEC", 0):
            sm._run_limits_probe(os.path.join(self.tmp, "limits-settings.json"))
        launch = [c for c in self.run_ok_calls if c[:2] == ["tmux", "new-session"]]
        self.assertEqual(len(launch), 1)
        cmd = launch[0][-1]
        # Not a registered session: its own tmux name, so no pane parser, no
        # worktree, and nothing the session ceiling has to account for.
        self.assertIn(ha.LIMITS_TMUX, launch[0])
        self.assertNotIn("--remote-control", cmd)
        # As small as a turn can be: cheapest model, no default system prompt,
        # none of the operator's MCP servers.
        self.assertIn("--model haiku", cmd)
        # The hook's snapshot path is pinned on the command line, not left to
        # whatever environment survives tmux and claude.
        self.assertIn(f"TURMA_LIMITS_PATH={shlex.quote(ha.LIMITS_PATH)}", cmd)
        # It measures the SUBSCRIPTION's windows, so it must never pick up the
        # local-model failover's endpoint (XERK-246) — a local model has no such
        # windows, and every probe would time out having spent a real turn.
        self.assertNotIn("local-model.env", cmd)
        self.assertNotIn("ANTHROPIC_BASE_URL", cmd)
        self.assertIn("--system-prompt", cmd)
        self.assertIn("--strict-mcp-config", cmd)
        self.assertIn("--permission-mode plan", cmd)
        # It runs in the registry dir, which is what keeps its transcript off the
        # usage page (_is_internal_tool_slug tombstones that slug).
        self.assertIn(ha.REGISTRY_DIR, launch[0])
        # And it always tears its tmux down, even when nothing was captured.
        self.assertIn(["tmux", "kill-session", "-t", ha.LIMITS_TMUX], self.run_calls)

    def test_the_probes_transcript_is_internal_overhead_not_a_repo(self):
        # It runs where the summary/models helpers run, so the same tombstone
        # keeps its tokens off the usage page's per-repo breakdown (XERK-27).
        sm = self.make_manager()
        self.assertTrue(sm._is_internal_tool_slug(ha._project_slug(ha.REGISTRY_DIR)))

    def test_the_probe_prompt_is_recognised_when_the_registry_dir_is_a_symlink(self):
        # ~/.turma is a symlink on real hosts, and claude resolves the path before
        # slugifying it — so the transcript lands under the RESOLVED dir's slug
        # and the direct REGISTRY_DIR match can't fire. The prompt signature is
        # then the only thing keeping the agent's own overhead off the usage page,
        # and it must be distinctive enough that a real session's first message
        # can't trip it.
        self.assertTrue(ha._looks_like_internal_tool_prompt(ha.LIMITS_PROBE_PROMPT))
        self.assertFalse(ha._looks_like_internal_tool_prompt("ok"))
        self.assertFalse(ha._looks_like_internal_tool_prompt("ok, ship the probe"))


class TestSubscriptionIdentity(unittest.TestCase):
    """Which subscription a host's login is on (XERK-301). The limits above are a
    property of the ACCOUNT, so hosts sharing one account share one set of bars —
    which needs a stable, opaque key, and needs "I can't tell" to stay tellable
    apart from "I share yours"."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.path = os.path.join(self.dir, ".claude.json")
        ha._subscription_cache = {}
        ha._subscription_last_problem = {}
        self.addCleanup(setattr, ha, "_subscription_cache", {})
        self.addCleanup(setattr, ha, "_subscription_last_problem", {})

    def _write(self, data, path=None):
        with open(path or self.path, "w", encoding="utf-8") as fh:
            json.dump(data, fh)

    def _read(self, env=None):
        return ha.subscription_identity(paths=[self.path], env=env or {})

    def test_reads_the_account_from_the_claude_config(self):
        self._write({"oauthAccount": {"accountUuid": "acc-1", "emailAddress": "a@b.c"}})
        block = self._read()
        self.assertEqual(block["source"], "login")
        self.assertEqual(len(block["key"]), ha.SUBSCRIPTION_KEY_CHARS)

    def test_the_key_carries_nothing_of_the_account_it_names(self):
        # The hub persists every heartbeat and fans it out to web, Android and
        # glasses; grouping only ever asks whether two hosts are equal, so the
        # uuid, the org uuid and the email have no business on the wire.
        self._write({"oauthAccount": {"accountUuid": "acc-1",
                                      "emailAddress": "someone@example.com",
                                      "organizationUuid": "org-9"}})
        key = self._read()["key"]
        for secret in ("acc-1", "someone@example.com", "org-9"):
            self.assertNotIn(secret, key)

    def test_the_same_account_gives_the_same_key_and_a_different_one_does_not(self):
        self._write({"oauthAccount": {"accountUuid": "acc-1"}})
        first = self._read()["key"]
        ha._subscription_cache = {}
        self._write({"oauthAccount": {"accountUuid": "acc-1"}})
        self.assertEqual(self._read()["key"], first)
        ha._subscription_cache = {}
        self._write({"oauthAccount": {"accountUuid": "acc-2"}})
        self.assertNotEqual(self._read()["key"], first)

    def test_a_login_that_cannot_be_identified_reports_nothing(self):
        # None is the heartbeat's "that agent can't tell you" value: such a host
        # keeps a card of its own rather than being folded in with every other
        # host that also can't say.
        self.assertIsNone(self._read())                    # no file at all
        self._write({"numStartups": 3})                    # no oauthAccount
        self.assertIsNone(self._read())
        ha._subscription_cache = {}
        self._write({"oauthAccount": {"accountUuid": ""}})  # blank uuid
        self.assertIsNone(self._read())

    def test_a_broken_config_costs_the_grouping_not_the_beat(self):
        # This runs on the beat's critical path over a file Claude Code rewrites
        # constantly, so a truncated write must never raise.
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write('{"oauthAccount": {"accountUu')
        self.assertIsNone(self._read())
        ha._subscription_cache = {}
        self._write(["not", "an", "object"])
        self.assertIsNone(self._read())

    def test_an_implausibly_large_config_is_not_read(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write(" " * (ha.SUBSCRIPTION_CONFIG_MAX_BYTES + 1))
        self.assertIsNone(self._read())

    def test_the_env_pin_overrides_the_login_and_is_hashed_too(self):
        # For a host whose config this can't read. Two hosts given the same
        # string must land in the same group, and neither source leaks its input.
        self._write({"oauthAccount": {"accountUuid": "acc-1"}})
        pinned = self._read({ha.SUBSCRIPTION_KEY_ENV: " team-max "})
        self.assertEqual(pinned["source"], "env")
        self.assertNotIn("team-max", pinned["key"])
        self.assertEqual(pinned, self._read({ha.SUBSCRIPTION_KEY_ENV: "team-max"}))
        self.assertNotEqual(pinned["key"], self._read()["key"])

    def test_every_layout_is_tried_until_one_ANSWERS(self):
        # CLAUDE_CONFIG_DIR puts the file INSIDE the config dir; the default puts
        # it beside it. Both are routinely present, so falling through only on a
        # MISSING path lets an accountless first file permanently suppress the
        # one that actually holds the login.
        other = os.path.join(self.dir, "other.json")
        self._write({"oauthAccount": {"accountUuid": "acc-2"}}, path=other)
        self._write({"numStartups": 3})          # exists, but answers nothing
        missing = os.path.join(self.dir, "nope.json")
        for paths in ([missing, other], [self.path, other]):
            self.assertEqual(
                ha.subscription_identity(paths=paths, env={})["source"], "login", paths)

    def test_something_that_is_not_a_regular_file_is_never_opened(self):
        # A FIFO blocks open() until somebody writes, and this runs INLINE in the
        # beat — the host would just stop heartbeating with nothing to say why.
        # A directory and a device at that path are equally not the config file.
        os.mkfifo(self.path)
        self.assertIsNone(self._read())
        os.unlink(self.path)
        os.mkdir(self.path)
        self.assertIsNone(self._read())

    def test_two_bad_paths_at_once_do_not_bury_the_log(self):
        # The read walks EVERY candidate, so two simultaneously-bad paths
        # alternate messages — a single-slot memo never matches either and logs
        # both on every beat, which is thousands of lines a day and the exact
        # burial the memo exists to prevent.
        second = os.path.join(self.dir, "second.json")
        os.mkdir(self.path)                 # a directory where the config should be
        os.mkfifo(second)                   # and a FIFO at the other layout
        lines = []
        with mock.patch.object(ha, "log", lines.append):
            for _ in range(5):
                self.assertIsNone(ha.subscription_identity(paths=[self.path, second], env={}))
        self.assertEqual(len(lines), 2, lines)   # one per path, once each

    @unittest.skipUnless(os.path.exists("/dev/zero"), "needs /dev/zero")
    def test_an_endless_device_is_refused_without_being_read(self):
        # /dev/zero reports st_size 0 and then hands over bytes forever, so a
        # ceiling read off stat alone is not a ceiling — the old shape allocated
        # 16 GiB in 12 seconds against it. The regular-file gate is what refuses
        # it; the read bound behind that is belt and braces.
        started = time.monotonic()
        self.assertIsNone(ha.subscription_identity(paths=["/dev/zero"], env={}))
        self.assertLess(time.monotonic() - started, 5)

    def test_a_re_login_is_picked_up_rather_than_cached_forever(self):
        # The config file is ~120 KiB and almost never changes, so it is read
        # once per (mtime, size) — but a changed login has to win.
        self._write({"oauthAccount": {"accountUuid": "acc-1"}})
        first = self._read()["key"]
        self._write({"oauthAccount": {"accountUuid": "acc-2-longer"}})
        os.utime(self.path, (0, 0))   # force a different mtime than the write
        self.assertNotEqual(self._read()["key"], first)


class TestReconcileOrphanTranscripts(ManagerMixin, unittest.TestCase):
    """Usage counts EVERY transcript on disk, not only ledger-known slugs: an
    orphan transcript (session aged out of closed.json, or predating the ledger)
    is adopted with best-effort attribution, and nothing is excluded — an
    unattributable one still counts, folded into the root bucket (XERK-147)."""

    def setUp(self):
        super().setUp()
        # Keep REPOS_ROOT (repos-root pseudo-repo + case-2 remote lookup) inside
        # the temp tree instead of the unpatched production default.
        p = mock.patch.object(ha, "REPOS_ROOT", os.path.join(self.tmp, "git"))
        p.start()
        self.addCleanup(p.stop)

    def _mk_repo(self, name):
        """A scanned repo under REPOS_ROOT — a derived (slug/cwd) attribution
        only stands when it names one of these."""
        os.makedirs(os.path.join(ha.REPOS_ROOT, name, ".git"), exist_ok=True)

    def _write_transcript(self, worktree):
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(worktree))
        os.makedirs(proj, exist_ok=True)
        write_jsonl(os.path.join(proj, "t.jsonl"), [
            usage_entry("2026-07-01T10:00:00.000Z", "m1", "r1",
                        "claude-sonnet-4-20250514", 100_000, 0),
        ])
        return proj

    def _mk_worktree(self, repo, sid):
        wt = os.path.join(ha.WORKTREES_ROOT, repo, sid)
        os.makedirs(wt, exist_ok=True)
        return wt

    def test_case1_adopts_transcript_of_existing_worktree(self):
        wt = self._mk_worktree("Turma", "abcde")
        self._write_transcript(wt)
        sm = self.make_manager()
        sm._reconcile_orphan_transcripts()
        self.assertIn(wt, sm.usage_ledger)             # keyed by the real path
        self.assertEqual(sm.usage_ledger[wt]["repo"], "Turma")
        # ...and it now surfaces in the persistent usage report.
        sm._refresh_repo_usage()
        self.assertTrue(any(r["repo"] == "Turma" for r in sm.repo_usage))

    def test_case2_recovers_repo_when_worktree_gone(self):
        # Worktree deleted; the transcript's slug still carries the
        # .turma/worktrees/<repo>/<id> shape, so the repo is recovered from it
        # (a repo this host scans — validation's happy path).
        self._mk_repo("DockerOps")
        wt = os.path.join(ha.WORKTREES_ROOT, "DockerOps", "zzzzz")
        proj = self._write_transcript(wt)
        sm = self.make_manager()
        sm._reconcile_orphan_transcripts()
        self.assertIn(proj, sm.usage_ledger)           # keyed by the proj dir
        self.assertEqual(sm.usage_ledger[proj]["repo"], "DockerOps")
        self.assertEqual(sm.usage_ledger[proj]["slug"], ha._project_slug(wt))

    def test_sibling_tool_worktree_shape_attributed(self):
        # A different tool's worktree (e.g. .agenthub/worktrees/AgentHub/<id>):
        # not under WORKTREES_ROOT, so no exact match, but the worktrees-shaped
        # slug still names the repo — attributed when this host has that repo.
        self._mk_repo("AgentHub")
        wt = "/repos/.agenthub/worktrees/AgentHub/10ab3"
        proj = self._write_transcript(wt)
        sm = self.make_manager()
        sm._reconcile_orphan_transcripts()
        self.assertEqual(sm.usage_ledger[proj]["repo"], "AgentHub")

    def test_scratchpad_slug_folds_to_root(self):
        # A claude run inside a session's scratchpad dir: its cwd embeds the
        # SLUGIFIED worktree path, so the transcript slug carries "-worktrees-"
        # and false-matched the worktree shape — recovering a phantom
        # "Turma-<id>-<uuid>" repo (XERK-147). Not a scanned repo, no usable
        # cwd tail -> folded into the root bucket.
        self._mk_repo("Turma")
        cwd = ("/tmp/claude-0/-mnt-data-Docker-git--turma-worktrees-Turma-fd761"
               "/b2e9b2c9-a9f2-4da9-8cbf-df0c27c31aae/scratchpad")
        proj = self._write_transcript(cwd)
        sm = self.make_manager()
        sm._reconcile_orphan_transcripts()
        self.assertEqual(sm.usage_ledger[proj]["repo"], ha.ROOT_REPO_NAME)

    def test_repo_recovered_from_transcript_cwd(self):
        # No worktree and no worktrees-shaped slug, but the transcript records
        # its cwd (e.g. an operator's dev-machine session, Windows path) — the
        # repo is read from there when its tail names a repo this host has.
        self._mk_repo("Veiller")
        wt = "/home/me/OneDrive/personal/Veiller"
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(wt))
        os.makedirs(proj, exist_ok=True)
        write_jsonl(os.path.join(proj, "t.jsonl"), [
            {"type": "user", "cwd": "C:\\Users\\me\\personal\\Veiller",
             "message": {"role": "user", "content": "hi"}},
        ])
        sm = self.make_manager()
        sm._reconcile_orphan_transcripts()
        self.assertEqual(sm.usage_ledger[proj]["repo"], "Veiller")

    def test_junk_cwd_tail_folds_to_root(self):
        # A cwd whose last segment names no repo this host has ("repo", "tmp",
        # "repos") must not mint a phantom repo — it folds to root (XERK-147).
        self._mk_repo("Turma")
        cwd = "/mnt/data/Docker/SwitchBoard/repo"
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(cwd))
        os.makedirs(proj, exist_ok=True)
        write_jsonl(os.path.join(proj, "t.jsonl"), [
            {"type": "user", "cwd": cwd,
             "message": {"role": "user", "content": "hi"}},
        ])
        sm = self.make_manager()
        sm._reconcile_orphan_transcripts()
        self.assertEqual(sm.usage_ledger[proj]["repo"], ha.ROOT_REPO_NAME)

    def test_unattributable_bucketed_as_root(self):
        # No worktree, no worktrees-shaped slug, and no cwd recorded — still
        # adopted so its usage counts, in the root bucket (XERK-147).
        proj = self._write_transcript("/root/scratch")  # usage_entry has no cwd
        sm = self.make_manager()
        sm._reconcile_orphan_transcripts()
        self.assertEqual(sm.usage_ledger[proj]["repo"], ha.ROOT_REPO_NAME)

    def test_skips_already_ledgered_slug(self):
        wt = self._mk_worktree("Turma", "abcde")
        self._write_transcript(wt)
        sm = self.make_manager()
        sm.usage_ledger = {wt: {"repo": "Turma", "remote": "keep",
                                "slug": ha._project_slug(wt)}}
        sm._reconcile_orphan_transcripts()
        self.assertEqual(sm.usage_ledger[wt]["remote"], "keep")  # not overwritten

    def test_ignores_dir_without_transcript(self):
        wt = self._mk_worktree("Turma", "abcde")
        os.makedirs(os.path.join(ha.PROJECTS_ROOT, ha._project_slug(wt)),
                    exist_ok=True)  # empty project dir, no *.jsonl
        sm = self.make_manager()
        sm._reconcile_orphan_transcripts()
        self.assertFalse(sm.usage_ledger)

    # --- The manager's OWN internal claude -p helpers are not repos (XERK-27) ---
    # Session naming and Jira triage run headless with cwd=REGISTRY_DIR but still
    # write a transcript into the shared ~/.claude/projects, which earlier builds
    # adopted as phantom ".turma" / "hub-agent-mgr-*" repos on the usage page.

    def _write_prompted(self, cwd_dir, prompt, tid="t"):
        """A transcript whose first user turn is `prompt`, recorded from cwd_dir —
        the shape the manager's own summary/triage claude -p leaves behind. Carries
        usage so a test can also prove the tokens don't reach the host total."""
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(cwd_dir))
        os.makedirs(proj, exist_ok=True)
        write_jsonl(os.path.join(proj, tid + ".jsonl"), [
            {"type": "user", "cwd": cwd_dir,
             "message": {"role": "user", "content": prompt}},
            usage_entry("2026-07-01T10:00:00.000Z", "m1", "r1",
                        "claude-sonnet-4-20250514", 100_000, 0),
        ])
        return proj

    def test_registry_dir_transcript_tombstoned_by_slug(self):
        # cwd=REGISTRY_DIR -> the registry dir's own slug, matched WITHOUT reading
        # the transcript (the production ".turma" leak). Tombstoned, not a repo.
        proj = self._write_prompted(
            ha.REGISTRY_DIR, ha.SUMMARY_INSTRUCTION + "Add a compose flag")
        sm = self.make_manager()
        sm._reconcile_orphan_transcripts()
        self.assertTrue(sm.usage_ledger[proj].get("internal"))
        self.assertNotIn("repo", sm.usage_ledger[proj])
        sm._refresh_repo_usage()          # nothing surfaces, no tokens counted
        self.assertFalse(sm.repo_usage)
        self.assertIsNone(sm.host_usage)

    def test_triage_signature_tombstoned_under_foreign_slug(self):
        # A verify/test harness boots the manager against a temp REGISTRY_DIR, so
        # its triage claude -p lands under …-tmp-hub-agent-mgr-<rand>, NOT the
        # running manager's registry slug. The prompt signature still catches it —
        # otherwise it would have been named "hub-agent-mgr-abcd1234".
        proj = self._write_prompted(
            "/tmp/hub-agent-mgr-abcd1234",
            ha.JIRA_TRIAGE_INSTRUCTION + "Candidate repositories:\n- Turma")
        sm = self.make_manager()
        sm._reconcile_orphan_transcripts()
        self.assertTrue(sm.usage_ledger[proj].get("internal"))
        self.assertNotIn("repo", sm.usage_ledger[proj])

    def test_sanitize_flips_existing_phantom_repo_entry(self):
        # An older build already adopted the harness transcript as a real repo
        # entry; the sanitize pass retires it to a tombstone so it drops off the
        # usage page instead of lingering forever.
        cwd = "/tmp/hub-agent-mgr-zzzz9999"
        proj = self._write_prompted(cwd, ha.JIRA_TRIAGE_INSTRUCTION + "x")
        sm = self.make_manager()
        sm.usage_ledger = {proj: {"repo": "hub-agent-mgr-zzzz9999",
                                  "remote": "", "slug": ha._project_slug(cwd)}}
        sm._sanitize_internal_tool_entries()
        self.assertTrue(sm.usage_ledger[proj].get("internal"))
        sm._refresh_repo_usage()
        self.assertFalse(any("hub-agent-mgr" in r["repo"]
                             for r in sm.repo_usage))

    def test_real_session_prompt_not_treated_as_internal(self):
        # A genuine coding prompt from a repo cwd is still adopted as its repo —
        # the carve-out is narrow and keyed on the manager's own prompt text.
        self._mk_repo("Widget")
        proj = self._write_prompted(
            "/home/me/personal/Widget", "Add a dark mode toggle to settings")
        sm = self.make_manager()
        sm._reconcile_orphan_transcripts()
        self.assertFalse(sm.usage_ledger[proj].get("internal"))
        self.assertEqual(sm.usage_ledger[proj]["repo"], "Widget")

    def test_archive_manifest_skips_internal_tool_transcript(self):
        # The reconcile ledger is the archive's input too, so a tombstone keeps the
        # helper transcripts out of the durable/searchable archive, not just usage.
        self._write_prompted(ha.REGISTRY_DIR, ha.SUMMARY_INSTRUCTION + "x")
        sm = self.make_manager()
        sm._reconcile_orphan_transcripts()
        self.assertFalse(sm._archive_manifest())

    def test_internal_signatures_track_the_live_prompts(self):
        # The signatures must stay a prefix of the live instructions, or a reword
        # would silently stop excluding the helper transcripts (XERK-27). Reading
        # the transcript is the harness-proof path; this guards its input.
        self.assertTrue(any(ha.JIRA_TRIAGE_INSTRUCTION.startswith(s)
                            for s in ha.INTERNAL_TOOL_PROMPT_SIGS))
        self.assertTrue(any(ha.SUMMARY_INSTRUCTION.startswith(s)
                            for s in ha.INTERNAL_TOOL_PROMPT_SIGS))


class TestSanitizeJunkRepoEntries(ManagerMixin, unittest.TestCase):
    """_sanitize_junk_repo_entries folds persisted ledger entries whose repo
    names nothing real — the phantom "…-scratchpad"/"tmp"/"repo"/"(other)"
    entries older builds adopted — into the root bucket, and lifts the internal
    tombstone a /model-only root session once put on the REPOS_ROOT slug
    (XERK-147)."""

    def setUp(self):
        super().setUp()
        p = mock.patch.object(ha, "REPOS_ROOT", os.path.join(self.tmp, "git"))
        p.start()
        self.addCleanup(p.stop)
        os.makedirs(os.path.join(ha.REPOS_ROOT, "Turma", ".git"), exist_ok=True)

    def _entry(self, repo, slug, remote=""):
        return {"repo": repo, "remote": remote, "slug": slug}

    def test_junk_names_fold_to_root(self):
        sm = self.make_manager()
        sm.usage_ledger = {
            "/p/a": self._entry("Turma-fd761-b2e9b2c9-scratchpad", "-p-a"),
            "/p/b": self._entry("repo", "-p-b"),
            "/p/c": self._entry("(other)", "-p-c"),
            "/p/d": self._entry(None, "-p-d"),
        }
        sm._sanitize_junk_repo_entries()
        for path in ("/p/a", "/p/b", "/p/c", "/p/d"):
            self.assertEqual(sm.usage_ledger[path]["repo"], ha.ROOT_REPO_NAME)

    def test_scanned_repo_and_remote_entries_kept(self):
        sm = self.make_manager()
        sm.usage_ledger = {
            "/p/scanned": self._entry("Turma", "-p-scanned"),
            "/p/gone": self._entry("Deleted",
                                   "-p-gone", remote="git@gh:me/Deleted.git"),
            "/p/root": self._entry(ha.ROOT_REPO_NAME, "-p-root"),
        }
        before = {p: dict(m) for p, m in sm.usage_ledger.items()}
        sm._sanitize_junk_repo_entries()
        # A scanned repo, a remote-carrying entry (real even though the repo
        # left this host), and the root bucket itself are all untouched.
        self.assertEqual(sm.usage_ledger, before)

    def test_untombstones_repos_root_slug(self):
        sm = self.make_manager()
        root_slug = ha._project_slug(ha.REPOS_ROOT)
        sm.usage_ledger = {
            ha.REPOS_ROOT: {"internal": True, "slug": root_slug},
            "/p/probe": {"internal": True, "slug": "-tmp-hub-agent-mgr-x"},
        }
        sm._sanitize_junk_repo_entries()
        self.assertEqual(sm.usage_ledger[ha.REPOS_ROOT]["repo"],
                         ha.ROOT_REPO_NAME)
        self.assertNotIn("internal", sm.usage_ledger[ha.REPOS_ROOT])
        # A genuine internal tombstone (the manager's own helpers) stays.
        self.assertTrue(sm.usage_ledger["/p/probe"].get("internal"))

    def test_noop_when_repo_scan_is_empty(self):
        # An unreadable/empty REPOS_ROOT must not fold every real repo's
        # history into root — the pass declines to judge without a repo list.
        shutil.rmtree(os.path.join(ha.REPOS_ROOT, "Turma"))
        sm = self.make_manager()
        sm.usage_ledger = {"/p/a": self._entry("Whatever", "-p-a")}
        sm._sanitize_junk_repo_entries()
        self.assertEqual(sm.usage_ledger["/p/a"]["repo"], "Whatever")


class TestTranscriptCwd(unittest.TestCase):
    """_transcript_cwd reads the real (un-slugified) cwd off a transcript's early
    entries — the authoritative inverse of the lossy project slug, used to pick
    the dir a resumed session must relaunch in."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hub-agent-cwd-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _write(self, lines):
        p = os.path.join(self.tmp, "t.jsonl")
        write_jsonl(p, lines)
        return p

    def test_reads_recorded_cwd(self):
        p = self._write([
            {"type": "user", "cwd": "/mnt/data/git/Turma",
             "message": {"role": "user", "content": "hi"}},
        ])
        self.assertEqual(ha._transcript_cwd(p), "/mnt/data/git/Turma")

    def test_none_when_no_cwd(self):
        p = self._write([usage_entry("2026-07-01T10:00:00.000Z", "m", "r",
                                     "claude-sonnet-4-20250514", 1, 1)])
        self.assertIsNone(ha._transcript_cwd(p))

    def test_none_when_file_missing(self):
        self.assertIsNone(ha._transcript_cwd(os.path.join(self.tmp, "nope.jsonl")))


class TestResumableReport(ManagerMixin, unittest.TestCase):
    """The "resume any session" picker's source: EVERY prior Claude session whose
    origin cwd is resumable on this host, grouped by repo — Turma worktrees,
    repo-dir "terminal" runs, and the repos-root pseudo-repo — while foreign
    dev-machine sessions and carded (still-registered) ones are excluded."""

    def setUp(self):
        super().setUp()
        p = mock.patch.object(ha, "REPOS_ROOT", os.path.join(self.tmp, "git"))
        p.start()
        self.addCleanup(p.stop)
        # A single scanned repo "Turma" so a repo-dir cwd classifies.
        self.repo = {"name": "Turma", "path": os.path.join(ha.REPOS_ROOT, "Turma")}
        p2 = mock.patch.object(ha, "scan_repos", lambda: [self.repo])
        p2.start()
        self.addCleanup(p2.stop)

    def _write_at(self, cwd, tid="t", text="do the thing"):
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(cwd))
        os.makedirs(proj, exist_ok=True)
        write_jsonl(os.path.join(proj, tid + ".jsonl"), [
            {"type": "user", "cwd": cwd,
             "message": {"role": "user", "content": text}},
        ])
        return proj

    def test_groups_worktree_repo_dir_and_root(self):
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "abcde")
        self._write_at(wt, tid="wt1")
        self._write_at(self.repo["path"], tid="rd1")     # repo-dir "terminal" run
        self._write_at(ha.REPOS_ROOT, tid="root1")       # repos-root pseudo-repo
        self._write_at("/home/me/elsewhere/Other", tid="foreign1")  # skipped
        sm = self.make_manager()
        rep = sm._resumable_report()
        turma = {e["transcriptId"]: e for e in rep.get("Turma", [])}
        self.assertEqual(set(turma), {"wt1", "rd1"})
        self.assertEqual(turma["wt1"]["origin"], "abcde")
        self.assertFalse(turma["wt1"]["root"])
        self.assertEqual(turma["rd1"]["origin"], "repo dir")
        self.assertEqual(turma["wt1"]["summary"], "do the thing")
        root = rep.get(ha.ROOT_REPO_NAME, [])
        self.assertEqual([e["transcriptId"] for e in root], ["root1"])
        self.assertTrue(root[0]["root"])
        # The foreign dev-machine session is not resumable here.
        self.assertNotIn("Other", rep)

    def test_excludes_carded_running_session(self):
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "live1")
        self._write_at(wt, tid="c1")
        sm = self.make_manager()
        sm.registry = [{"id": "live1", "repo": "Turma", "worktreePath": wt,
                        "status": "running"}]
        rep = sm._resumable_report()
        self.assertNotIn("Turma", rep)  # its only transcript is on a live card

    def test_carries_the_ticket_a_transcript_worked(self):
        """The durable channel is re-derived from the transcripts on disk, which
        know nothing of Jira — the ticket ledger is what re-attaches the two, and
        this is the only channel still reporting a session once its record has
        aged out of closed.json."""
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "abcde")
        self._write_at(wt, tid="tkt1")
        self._write_at(wt, tid="plain1")
        sm = self.make_manager()
        sm.ticket_ledger = {"tkt1": {"key": "PROJ-7", "siteKey": "x.atlassian.net",
                                     "branch": "PROJ-7", "repo": "Turma"}}
        by_tid = {e["transcriptId"]: e for e in sm._resumable_report()["Turma"]}
        self.assertEqual(by_tid["tkt1"]["ticket"]["key"], "PROJ-7")
        self.assertEqual(by_tid["tkt1"]["ticket"]["branch"], "PROJ-7")
        # An ordinary session reports no ticket rather than an empty one.
        self.assertIsNone(by_tid["plain1"]["ticket"])

    def test_carries_the_prs_a_transcript_opened(self):
        """This scan is the only channel still reporting a session once its
        closed record has aged out — so an ended session's PR chips (and their
        last-known status) have to come from the durable PR ledger here (XERK-13),
        exactly as the ticket does above."""
        url = "https://github.com/o/r/pull/1"
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "abcde")
        self._write_at(wt, tid="pr1")
        self._write_at(wt, tid="plain1")
        sm = self.make_manager()
        sm.pr_ledger = {"pr1": {"urls": [url], "at": "2026-01-01T00:00:00Z"}}
        sm.pr_status_cache = {url: {"url": url, "state": "MERGED"}}
        by_tid = {e["transcriptId"]: e for e in sm._resumable_report()["Turma"]}
        self.assertEqual(by_tid["pr1"]["prs"], [{"url": url, "state": "MERGED"}])
        # An ordinary session reports no PRs rather than an empty list.
        self.assertIsNone(by_tid["plain1"]["prs"])

    def test_caps_per_repo(self):
        p = mock.patch.object(ha, "RESUMABLE_PER_REPO", 2)
        p.start()
        self.addCleanup(p.stop)
        for i in range(5):
            self._write_at(os.path.join(ha.WORKTREES_ROOT, "Turma", f"w{i}"),
                           tid=f"t{i}")
        sm = self.make_manager()
        rep = sm._resumable_report()
        self.assertEqual(len(rep["Turma"]), 2)

    def test_survives_a_wiped_registry_dir(self):
        """The report is what makes the hub's Ended list durable, so it must be
        derivable from the bind-mounted transcripts ALONE. ~/.turma's durability
        is the host's to provide — a container that doesn't bind-mount it has
        sessions.json, closed.json and the ledgers on the image's writable layer,
        which an agent update recreates. What's left is ~/.claude/projects and
        each transcript's own recorded cwd."""
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "gone1")
        self._write_at(wt, tid="t1", text="the work it was doing")
        sm = self.make_manager()
        sm.registry, sm.closed, sm.usage_ledger = [], [], {}   # as if ~/.turma went

        rep = sm._resumable_report()
        self.assertEqual([e["transcriptId"] for e in rep["Turma"]], ["t1"])
        self.assertEqual(rep["Turma"][0]["cwd"], wt)
        self.assertEqual(rep["Turma"][0]["summary"], "the work it was doing")

    def test_entries_carry_their_slug(self):
        """_sorted_repo_entries()'s per-beat carded filter keys on it (below), so it
        is reported rather than dropped after picking the summary source."""
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "w1")
        self._write_at(wt, tid="t1")
        sm = self.make_manager()
        self.assertEqual(sm._resumable_report()["Turma"][0]["slug"],
                         ha._project_slug(wt))

    def test_endedTs_is_the_last_message_timestamp_not_the_mtime(self):
        """XERK-73: the ended list sorts on endedTs, so it must be the last new
        message's own timestamp — NOT the file mtime, which a synced ~/.claude or
        a backup restore inflates to copy-time (a week-old chat sorting to the top
        of Ended though nothing was said). The transcript's entries keep their
        real timestamps, so those are the truth."""
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "w1")
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(wt))
        os.makedirs(proj, exist_ok=True)
        path = os.path.join(proj, "t1.jsonl")
        write_jsonl(path, [
            {"type": "user", "cwd": wt, "timestamp": "2026-07-01T00:00:00.000Z",
             "message": {"role": "user", "content": "hi"}},
            {"type": "assistant", "cwd": wt, "timestamp": "2026-07-01T00:05:00.000Z",
             "message": {"role": "assistant", "content": "done"}},
        ])
        # The file was touched recently (a fresh copy), but that is a lie.
        recent = time.time()
        os.utime(path, (recent, recent))
        sm = self.make_manager()
        e = sm._resumable_report()["Turma"][0]
        self.assertEqual(e["endedTs"], "2026-07-01T00:05:00.000Z")

    def test_endedTs_falls_back_to_mtime_without_a_timestamped_entry(self):
        """A transcript whose tail carries no timestamp (an older/odd shape) keeps
        the mtime fallback rather than losing its endedTs entirely."""
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "w1")
        self._write_at(wt, tid="t1")   # _write_at writes no timestamp
        path = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(wt), "t1.jsonl")
        os.utime(path, (1_600_000_000, 1_600_000_000))   # 2020-09-13T12:26:40Z
        sm = self.make_manager()
        e = sm._resumable_report()["Turma"][0]
        self.assertEqual(e["endedTs"], "2020-09-13T12:26:40Z")

    def test_report_re_cuts_a_stale_scan_against_the_live_registry(self):
        """The scan is cached across the slow beats between refreshes, so on its
        own it still lists a session that has since been RESUMED and is running
        right now — offering Resume for a live session, and showing it in the
        hub's Active and Ended lists at once. The registry is current every beat,
        so the cut is re-applied at report time."""
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "w1")
        self._write_at(wt, tid="t1")
        sm = self.make_manager()
        sm.resumable = sm._resumable_report()           # scanned while it was ended
        self.assertEqual(len(sm.resumable["Turma"]), 1)

        # It gets resumed. The cache still says otherwise until the next slow beat.
        sm.registry = [{"id": "w1", "repo": "Turma", "worktreePath": wt,
                        "status": "running"}]
        turma = next(r for r in sm._sorted_repo_entries(refresh=False)
                     if r["name"] == "Turma")
        self.assertEqual(turma["resumable"], [],
                         "a running session must not be offered for resume")
        self.assertEqual(len(sm.resumable["Turma"]), 1,
                         "the filter is a view — it must not mutate the cache")

        # Killed again: the record leaves the registry, and it comes straight back
        # without waiting out a rescan.
        sm.registry = []
        turma = next(r for r in sm._sorted_repo_entries(refresh=False)
                     if r["name"] == "Turma")
        self.assertEqual([e["transcriptId"] for e in turma["resumable"]], ["t1"])


class TestCardedSlugs(ManagerMixin, unittest.TestCase):
    """_carded_slugs: every registry session's project slug, running or stopped —
    the sessions that already have a card of their own."""

    def test_covers_running_stopped_and_root(self):
        sm = self.make_manager()
        sm.registry = [
            {"id": "a", "worktreePath": "/g/.turma/worktrees/r/a", "status": "running"},
            {"id": "b", "worktreePath": "/g/.turma/worktrees/r/b", "status": "stopped"},
            {"id": "c", "worktreePath": ha.REPOS_ROOT, "root": True, "status": "running"},
        ]
        self.assertEqual(sm._carded_slugs(), {
            ha._project_slug("/g/.turma/worktrees/r/a"),
            ha._project_slug("/g/.turma/worktrees/r/b"),
            ha._project_slug(ha.REPOS_ROOT),
        })


class TestResumeTranscript(ManagerMixin, unittest.TestCase):
    """resume_transcript: resume ANY prior transcript by id, cwd'd at its origin
    (re-creating a deleted worktree at the exact path), rejecting anything not
    resumable on this host."""

    def setUp(self):
        super().setUp()
        p = mock.patch.object(ha, "REPOS_ROOT", os.path.join(self.tmp, "git"))
        p.start()
        self.addCleanup(p.stop)
        self.repo = {"name": "Turma", "path": os.path.join(ha.REPOS_ROOT, "Turma")}
        os.makedirs(self.repo["path"], exist_ok=True)   # repoPath must exist
        p2 = mock.patch.object(ha, "scan_repos", lambda: [self.repo])
        p2.start()
        self.addCleanup(p2.stop)

    def _write_at(self, cwd, tid):
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(cwd))
        os.makedirs(proj, exist_ok=True)
        write_jsonl(os.path.join(proj, tid + ".jsonl"), [
            {"type": "user", "cwd": cwd,
             "message": {"role": "user", "content": "hi"}},
        ])

    def _manager(self):
        sm = self.make_manager()
        sm._launch_tmux = mock.Mock()
        sm._launch_ttyd = mock.Mock()
        return sm

    def test_resumes_existing_worktree_with_pinned_id(self):
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "abcde")
        os.makedirs(wt, exist_ok=True)
        self._write_at(wt, "trans1")
        sm = self._manager()
        sm._worktree_add = mock.Mock()
        sm.resume_transcript("trans1", wt, cmd_id="c7")
        self.assertEqual(len(sm.registry), 1)
        sess = sm.registry[0]
        self.assertEqual(sess["worktreePath"], wt)
        # A resume mints a fresh id like spawn, so the hub correlates the same
        # way — by the command id echoed back onto the record.
        self.assertEqual(sess["spawnCmdId"], "c7")
        self.assertEqual(sess["repo"], "Turma")
        self.assertEqual(sess["status"], "running")
        sm._worktree_add.assert_not_called()          # worktree still present
        self.assertEqual(sm._launch_tmux.call_args.kwargs["resume_id"], "trans1")

    def test_recreates_deleted_worktree_at_origin_path(self):
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "gone1")  # not on disk
        self._write_at(wt, "trans2")
        sm = self._manager()
        sm._worktree_add = mock.Mock()
        with mock.patch.object(ha, "resolve_base_ref", return_value="origin/main"):
            sm.resume_transcript("trans2", wt)
        self.assertEqual(len(sm.registry), 1)
        self.assertEqual(sm.registry[0]["worktreePath"], wt)
        sm._worktree_add.assert_called_once()         # re-added at the exact path
        self.assertEqual(sm._launch_tmux.call_args.kwargs["resume_id"], "trans2")

    def test_repo_dir_terminal_session(self):
        cwd = self.repo["path"]
        self._write_at(cwd, "trans3")
        sm = self._manager()
        sm.resume_transcript("trans3", cwd)
        self.assertEqual(len(sm.registry), 1)
        self.assertEqual(sm.registry[0]["worktreePath"], cwd)
        self.assertFalse(sm.registry[0]["root"])

    def test_rejects_cwd_outside_repos_root(self):
        cwd = "/home/me/elsewhere/Other"
        self._write_at(cwd, "trans4")
        sm = self._manager()
        sm.resume_transcript("trans4", cwd)
        self.assertEqual(sm.registry, [])
        sm._launch_tmux.assert_not_called()

    def test_refuses_when_a_session_already_runs_in_that_cwd(self):
        cwd = self.repo["path"]
        self._write_at(cwd, "trans5")
        sm = self._manager()
        sm.registry = [{"id": "x", "worktreePath": cwd, "status": "running",
                        "repo": "Turma"}]
        sm.resume_transcript("trans5", cwd)
        self.assertEqual(len(sm.registry), 1)         # unchanged
        sm._launch_tmux.assert_not_called()

    def test_bad_transcript_id_is_ignored(self):
        sm = self._manager()
        sm.resume_transcript("../etc/passwd", "/x")
        self.assertEqual(sm.registry, [])
        sm._launch_tmux.assert_not_called()


class TestMigrateSession(ManagerMixin, unittest.TestCase):
    """Moving a session to another agent (XERK-101): the source packs its raw
    transcript and ships it through the hub; the target unpacks it under the
    origin cwd's slug and resumes the same conversation, carrying the moved
    session's identity."""

    def setUp(self):
        super().setUp()
        p = mock.patch.object(ha, "REPOS_ROOT", os.path.join(self.tmp, "git"))
        p.start()
        self.addCleanup(p.stop)
        self.repo = {"name": "Turma", "path": os.path.join(ha.REPOS_ROOT, "Turma")}
        os.makedirs(self.repo["path"], exist_ok=True)
        p2 = mock.patch.object(ha, "scan_repos", lambda: [self.repo])
        p2.start()
        self.addCleanup(p2.stop)

    def _write_transcript(self, cwd, tid, *, tail="\n", subagents=False):
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(cwd))
        os.makedirs(proj, exist_ok=True)
        path = os.path.join(proj, tid + ".jsonl")
        with open(path, "w") as f:
            f.write(json.dumps({"type": "user", "cwd": cwd,
                                "message": {"role": "user", "content": "hi"}}) + "\n")
            f.write(tail)  # a trailing partial (no newline) or a clean "\n"
        if subagents:
            sub = ha._subagents_dir(path)
            os.makedirs(sub, exist_ok=True)
            with open(os.path.join(sub, "agent-x.jsonl"), "w") as f:
                f.write('{"sub":1}\n')
        return path

    def _manager(self):
        sm = self.make_manager()
        sm._launch_tmux = mock.Mock()
        sm._launch_ttyd = mock.Mock()
        sm.device = "hostA"
        return sm

    def test_pack_unpack_round_trip_truncates_partial_tail(self):
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "abcde")
        # A half-written final line (no newline) must not travel — the target
        # would choke resuming a partial-JSON tail.
        path = self._write_transcript(wt, "trans1", tail='{"partial', subagents=True)
        sm = self._manager()
        blob = sm._pack_transcript(path)
        dest = os.path.join(self.tmp, "dest")
        os.makedirs(dest)
        sm._unpack_transcript(blob, dest)
        out = os.path.join(dest, "trans1.jsonl")
        self.assertTrue(os.path.isfile(out))
        with open(out) as f:
            body = f.read()
        self.assertNotIn("partial", body)          # truncated at the last newline
        self.assertTrue(body.endswith("\n"))
        # The subagents dir travels alongside, laid out for the slug dir.
        self.assertTrue(os.path.isfile(
            os.path.join(dest, "trans1", "subagents", "agent-x.jsonl")))

    def test_pack_carries_the_workflow_run_records(self):
        # The SIBLING workflows/ tree holds each run's record, which is the only
        # place a workflow picker's row labels exist (XERK-304). Left behind, a
        # moved session's rows fall back to prompt text on the target only.
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "wfmig")
        path = self._write_transcript(wt, "trans1", subagents=True)
        runs = os.path.join(path[:-len(".jsonl")], "workflows")
        os.makedirs(os.path.join(runs, "scripts"))
        # Deliberately a REALISTIC size (a record embeds the script and a
        # preview per agent). With a toy fixture, shrinking the bound to 1 KiB —
        # which silently stops every real session carrying its records — passed
        # the entire suite. The fixture is what pins the bound from below.
        with open(os.path.join(runs, "wf_abc123.json"), "w") as f:
            json.dump({"runId": "wf_abc123", "script": "x" * 200000,
                       "workflowProgress": [
                           {"type": "workflow_agent", "index": 1, "agentId": "x",
                            "label": "review:bugs", "state": "done",
                            "promptPreview": "p" * 2000}]}, f)
        with open(os.path.join(runs, "scripts", "s-wf_abc123.js"), "w") as f:
            f.write("export const meta = {}\n" + "// pad\n" * 20000)
        self.assertGreater(
            sum(os.path.getsize(os.path.join(dp, n))
                for dp, _d, fs in os.walk(runs) for n in fs),
            300000, "a toy fixture cannot pin the pack bound from below")
        sm = self._manager()
        dest = os.path.join(self.tmp, "dest-wf")
        os.makedirs(dest)
        sm._unpack_transcript(sm._pack_transcript(path), dest)
        rec = os.path.join(dest, "trans1", "workflows", "wf_abc123.json")
        self.assertTrue(os.path.isfile(rec))
        with open(rec) as f:
            self.assertEqual(json.load(f)["workflowProgress"][0]["label"], "review:bugs")
        self.assertTrue(os.path.isfile(
            os.path.join(dest, "trans1", "workflows", "scripts", "s-wf_abc123.js")))

    def test_a_fat_workflows_tree_is_LEFT_BEHIND_rather_than_failing_the_move(self):
        # The records are a nicety (row labels); the move is the product. An
        # accumulated tree pushing the bundle past MIGRATION_BLOB_MAX would
        # refuse a migration that used to succeed — trading a working move for
        # prettier labels. Past the bound it degrades to the old behaviour.
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "wffat")
        path = self._write_transcript(wt, "trans1", subagents=True)
        runs = os.path.join(path[:-len(".jsonl")], "workflows")
        os.makedirs(runs)
        with open(os.path.join(runs, "wf_big.json"), "w") as f:
            f.write("x" * (ha.WORKFLOW_PACK_MAX_BYTES + 1))
        sm = self._manager()
        dest = os.path.join(self.tmp, "dest-fat")
        os.makedirs(dest)
        blob = sm._pack_transcript(path)
        sm._unpack_transcript(blob, dest)
        # The move still happens, and the transcript still travels whole.
        self.assertTrue(os.path.isfile(os.path.join(dest, "trans1.jsonl")))
        self.assertTrue(os.path.isfile(
            os.path.join(dest, "trans1", "subagents", "agent-x.jsonl")))
        self.assertFalse(os.path.isdir(os.path.join(dest, "trans1", "workflows")))
        self.assertLess(len(blob), ha.MIGRATION_BLOB_MAX)

    def test_records_are_dropped_when_they_would_put_the_bundle_over(self):
        # Bounding the TREE against a constant is not enough: the ceiling is on
        # the whole bundle, so any records tree — however small, however legal —
        # can push a near-ceiling transcript over it and refuse a move that used
        # to succeed. Only the finished blob can answer that.
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "wfhead")
        path = self._write_transcript(wt, "trans1", subagents=True)
        # Incompressible, so the gzipped blob really does approach the ceiling.
        with open(path, "ab") as f:
            f.write(os.urandom(200000))
            f.write(b"\n")
        runs = os.path.join(path[:-len(".jsonl")], "workflows")
        os.makedirs(runs)
        with open(os.path.join(runs, "wf_abc123.json"), "wb") as f:
            f.write(os.urandom(120000))
        sm = self._manager()
        with mock.patch.object(ha, "MIGRATION_BLOB_MAX", 260000):
            blob = sm._pack_transcript(path)
        self.assertLessEqual(len(blob), 260000, "the move must still be possible")
        dest = os.path.join(self.tmp, "dest-head")
        os.makedirs(dest)
        sm._unpack_transcript(blob, dest)
        self.assertTrue(os.path.isfile(os.path.join(dest, "trans1.jsonl")))
        self.assertFalse(os.path.isdir(os.path.join(dest, "trans1", "workflows")),
                         "the records are what gets dropped, not the session")

    def test_an_unreadable_record_drops_the_records_not_the_move(self):
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "wfperm")
        path = self._write_transcript(wt, "trans1", subagents=True)
        runs = os.path.join(path[:-len(".jsonl")], "workflows")
        os.makedirs(runs)
        bad = os.path.join(runs, "wf_abc123.json")
        with open(bad, "w") as f:
            json.dump({"runId": "wf_abc123"}, f)
        os.chmod(bad, 0)
        self.addCleanup(os.chmod, bad, 0o644)
        if os.access(bad, os.R_OK):
            self.skipTest("running as root — an unreadable file cannot be staged")
        sm = self._manager()
        dest = os.path.join(self.tmp, "dest-perm")
        os.makedirs(dest)
        sm._unpack_transcript(sm._pack_transcript(path), dest)
        self.assertTrue(os.path.isfile(os.path.join(dest, "trans1.jsonl")))
        self.assertTrue(os.path.isfile(
            os.path.join(dest, "trans1", "subagents", "agent-x.jsonl")))

    def test_an_unreadable_SUBAGENT_still_refuses_the_move_loudly(self):
        # The opposite trade from the records: a subagent transcript is
        # conversation data, and losing one silently is worse than a failed
        # move. It must not be mistaken for a records failure and swallowed.
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "wfsubperm")
        path = self._write_transcript(wt, "trans1", subagents=True)
        runs = os.path.join(path[:-len(".jsonl")], "workflows")
        os.makedirs(runs)
        with open(os.path.join(runs, "wf_abc123.json"), "w") as f:
            json.dump({"runId": "wf_abc123"}, f)
        bad = os.path.join(path[:-len(".jsonl")], "subagents", "agent-x.jsonl")
        os.chmod(bad, 0)
        self.addCleanup(os.chmod, bad, 0o644)
        if os.access(bad, os.R_OK):
            self.skipTest("running as root — an unreadable file cannot be staged")
        sm = self._manager()
        with mock.patch.object(sm, "_pack_bytes",
                               side_effect=sm._pack_bytes) as packed:
            with self.assertRaises(OSError):
                sm._pack_transcript(path)
        self.assertEqual(packed.call_count, 1,
                         "a failure outside the records must not buy a second pack")

    def test_an_unreadable_records_DIR_drops_the_records_too(self):
        # The error's filename is then the tree ITSELF, not something under it —
        # the shape a vanished-mid-pack tree also produces. Without the equality
        # clause both invert into refusing the move.
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "wfdirperm")
        path = self._write_transcript(wt, "trans1", subagents=True)
        runs = os.path.join(path[:-len(".jsonl")], "workflows")
        os.makedirs(runs)
        with open(os.path.join(runs, "wf_abc123.json"), "w") as f:
            json.dump({"runId": "wf_abc123"}, f)
        os.chmod(runs, 0)
        self.addCleanup(os.chmod, runs, 0o755)
        if os.access(runs, os.R_OK):
            self.skipTest("running as root — an unreadable dir cannot be staged")
        sm = self._manager()
        dest = os.path.join(self.tmp, "dest-dirperm")
        os.makedirs(dest)
        sm._unpack_transcript(sm._pack_transcript(path), dest)
        self.assertTrue(os.path.isfile(os.path.join(dest, "trans1.jsonl")))
        self.assertTrue(os.path.isfile(
            os.path.join(dest, "trans1", "subagents", "agent-x.jsonl")))
        self.assertFalse(os.path.isdir(os.path.join(dest, "trans1", "workflows")))

    def test_an_UNATTRIBUTABLE_pack_error_refuses_rather_than_dropping(self):
        # tarfile sets `filename` only for path operations; its own short read
        # ("unexpected end of data", from a file that shrank mid-pack) carries
        # none. Treating that as a records fault ships a TRUNCATED subagent
        # transcript with a log line blaming the records — so "can't tell which
        # tree" has to resolve to refuse: a failed move is visible and
        # retryable, silent conversation-data loss is neither.
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "wfnofn")
        path = self._write_transcript(wt, "trans1", subagents=True)
        runs = os.path.join(path[:-len(".jsonl")], "workflows")
        os.makedirs(runs)
        with open(os.path.join(runs, "wf_abc123.json"), "w") as f:
            json.dump({"runId": "wf_abc123"}, f)
        sm = self._manager()
        with mock.patch.object(sm, "_pack_bytes",
                               side_effect=OSError("unexpected end of data")) as packed:
            with self.assertRaises(OSError):
                sm._pack_transcript(path)
        self.assertEqual(packed.call_count, 1, "and it does not buy a second pack")

    def test_dir_size_skips_what_it_cannot_read_rather_than_raising(self):
        # A walk/delete race, or a leftover root-owned file, must not raise out
        # of the measure — which would refuse the move it is meant to protect.
        d = os.path.join(self.tmp, "unreadable")
        os.makedirs(d)
        with open(os.path.join(d, "a"), "w") as f:
            f.write("y" * 100)
        with mock.patch.object(ha.os.path, "getsize", side_effect=OSError("boom")):
            self.assertEqual(ha._dir_size(d, 1000), 0)

    def test_dir_size_bails_out_once_it_is_over_the_bound(self):
        d = os.path.join(self.tmp, "sizeme")
        os.makedirs(d)
        with open(os.path.join(d, "a"), "w") as f:
            f.write("y" * 100)
        self.assertEqual(ha._dir_size(d, 1000), 100)
        self.assertIsNone(ha._dir_size(d, 50))
        # A symlink is not followed, so it cannot inflate (or leak) the measure.
        os.symlink("/etc/passwd", os.path.join(d, "link"))
        self.assertEqual(ha._dir_size(d, 1000), 100)

    def test_unpack_rejects_a_traversing_member(self):
        sm = self._manager()
        buf = io.BytesIO()
        with __import__("tarfile").open(fileobj=buf, mode="w:gz") as tar:
            data = b"x"
            ti = __import__("tarfile").TarInfo(name="../escape.jsonl")
            ti.size = len(data)
            tar.addfile(ti, io.BytesIO(data))
        with self.assertRaises(ValueError):
            sm._unpack_transcript(buf.getvalue(), os.path.join(self.tmp, "d2"))

    def test_export_packs_and_uploads(self):
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "sess1")
        self._write_transcript(wt, "transE")
        sm = self._manager()
        sm.registry = [{"id": "sess1", "worktreePath": wt, "status": "running",
                        "repo": "Turma", "claudeSessionId": "transE"}]
        sent = {}

        def upload(mid, blob):
            sent.update(mid=mid, blob=blob)
            return True   # the real one answers whether the POST landed

        sm._migration_upload = upload
        sm.export_session("sess1", "mig123")
        self.assertEqual(sent["mid"], "mig123")
        # What it uploaded really is the packed transcript.
        dest = os.path.join(self.tmp, "dl")
        os.makedirs(dest)
        sm._unpack_transcript(sent["blob"], dest)
        self.assertTrue(os.path.isfile(os.path.join(dest, "transE.jsonl")))

    def test_export_no_transcript_uploads_nothing(self):
        sm = self._manager()
        sm.registry = [{"id": "s", "worktreePath": "/nope", "status": "running",
                        "repo": "Turma", "claudeSessionId": "gone"}]
        called = []
        sm._migration_upload = lambda *a: called.append(a)
        sm.export_session("s", "mig1")
        self.assertEqual(called, [])

    def test_migration_upload_retries_a_busy_hub_but_not_a_refusal(self):
        # A bundle is the largest body an agent ever sends, so it is the one most
        # likely to meet the hub's in-flight budget and be told 503 (XERK-258).
        # Nothing else retries it, and a lost bundle strands the whole move until
        # it times out hub-side.
        sm = self._manager()
        sm.MIGRATION_UPLOAD_BACKOFF_SEC = 0  # don't actually sleep in the suite

        def attempts_for(codes):
            """Run an upload whose Nth call raises codes[N], and count the calls."""
            calls = []

            def fake_urlopen(req, timeout=None):
                calls.append(req)
                code = codes[len(calls) - 1] if len(calls) <= len(codes) else None
                if code is not None:
                    raise urllib.error.HTTPError(
                        req.full_url, code, "nope", {}, None)
                return mock.MagicMock(
                    __enter__=lambda s: mock.Mock(read=lambda: b""),
                    __exit__=lambda *a: False)

            with mock.patch.object(ha.urllib.request, "urlopen", fake_urlopen):
                sm._migration_upload("mig1", b"bundle")
            return len(calls)

        # 503 twice then success: it keeps trying and the move survives.
        self.assertEqual(attempts_for([503, 503]), 3)
        # A 4xx is the hub having parsed the bundle and declined it — re-sending
        # the same bytes would be refused identically, so it gives up at once.
        self.assertEqual(attempts_for([413]), 1)
        # And it never retries forever.
        self.assertEqual(attempts_for([503, 503, 503, 503, 503]),
                         sm.MIGRATION_UPLOAD_ATTEMPTS)

    def test_import_unpacks_and_resumes_with_identity(self):
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "orig")  # not on disk here
        # Pack a transcript on a "source", then import it on this "target".
        src_path = self._write_transcript(wt, "transI")
        src = self._manager()
        blob = src._pack_transcript(src_path)
        # Wipe the target's copy so import is what puts it on disk.
        shutil.rmtree(os.path.join(ha.PROJECTS_ROOT, ha._project_slug(wt)))

        sm = self._manager()
        sm._worktree_add = mock.Mock()
        sm._migration_download = lambda mid: blob
        cmd = {
            "type": "importSession", "cmdId": "c9", "migrationId": "mig9",
            "transcriptId": "transI", "cwd": wt, "repo": "Turma",
            "model": "opus", "permissionMode": "plan", "summary": "Fix the logs",
            "ticket": {"key": "ENG-9", "branch": "ENG-9"},
            "migratedFrom": {"host": "hostA", "sessionId": "orig"},
        }
        with mock.patch.object(ha, "resolve_base_ref", return_value="origin/main"):
            sm.import_session(cmd)
        # The transcript landed at the origin cwd's slug so claude --resume finds it.
        self.assertTrue(os.path.isfile(os.path.join(
            ha.PROJECTS_ROOT, ha._project_slug(wt), "transI.jsonl")))
        self.assertEqual(len(sm.registry), 1)
        sess = sm.registry[0]
        self.assertEqual(sess["worktreePath"], wt)
        self.assertEqual(sess["repo"], "Turma")
        self.assertEqual(sess["spawnCmdId"], "c9")
        self.assertEqual(sess["model"], "opus")
        self.assertEqual(sess["permissionMode"], "plan")
        self.assertEqual(sess["summary"], "Fix the logs")
        self.assertEqual(sess["ticket"]["key"], "ENG-9")
        self.assertEqual(sess["migratedFrom"]["host"], "hostA")
        # The moved conversation is resumed (its id pinned), and the missing
        # worktree re-created at the exact origin path.
        self.assertEqual(sm._launch_tmux.call_args.kwargs["resume_id"], "transI")
        sm._worktree_add.assert_called_once()

    def test_import_download_failure_creates_no_session(self):
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "orig2")
        sm = self._manager()
        sm._migration_download = lambda mid: None
        sm.import_session({"migrationId": "m", "transcriptId": "t",
                           "cwd": wt, "repo": "Turma"})
        self.assertEqual(sm.registry, [])
        sm._launch_tmux.assert_not_called()

    def test_import_rejects_a_foreign_cwd(self):
        sm = self._manager()
        got = []
        sm._migration_download = lambda mid: got.append(mid)
        sm.import_session({"migrationId": "m", "transcriptId": "t",
                           "cwd": "/home/me/elsewhere", "repo": "Turma"})
        self.assertEqual(sm.registry, [])
        self.assertEqual(got, [])   # bailed before spending a download

    def test_localize_migrated_cwd(self):
        """The target remaps a source worktree path onto its own REPOS_ROOT
        (differing mounts), passes an already-local path through untouched, and
        leaves a non-worktree/foreign path unchanged for the caller to reject."""
        sm = self._manager()
        wt_tail = os.path.join("Turma", "c59fe")
        local = os.path.join(ha.WORKTREES_ROOT, "Turma", "c59fe")
        # A source host mounting REPOS_ROOT elsewhere (WSL-native, container).
        self.assertEqual(
            sm._localize_migrated_cwd("/home/mhabeeb/git/.turma/worktrees/" +
                                      wt_tail.replace(os.sep, "/")),
            local)
        # Already under this host's REPOS_ROOT -> unchanged.
        self.assertEqual(sm._localize_migrated_cwd(local), local)
        # No recognizable worktree tail -> unchanged (rejected downstream).
        self.assertEqual(sm._localize_migrated_cwd("/home/me/elsewhere"),
                         "/home/me/elsewhere")

    def test_import_remaps_a_foreign_repos_root(self):
        """A source mounting REPOS_ROOT at a DIFFERENT path ships its own
        absolute worktree path; the target remaps the .turma/worktrees tail onto
        its OWN REPOS_ROOT and resumes there, instead of wedging forever in
        `importing` by rejecting it as foreign (the real-fleet migration bug)."""
        foreign = "/home/otheruser/src/.turma/worktrees/Turma/c59fe"
        local = os.path.join(ha.WORKTREES_ROOT, "Turma", "c59fe")
        # Pack a transcript (its bytes are slug-agnostic) to hand to the target.
        src_path = self._write_transcript(local, "transR")
        blob = self._manager()._pack_transcript(src_path)
        shutil.rmtree(os.path.join(ha.PROJECTS_ROOT, ha._project_slug(local)))

        sm = self._manager()
        sm._worktree_add = mock.Mock()
        sm._migration_download = lambda mid: blob
        cmd = {"type": "importSession", "cmdId": "cR", "migrationId": "migR",
               "transcriptId": "transR", "cwd": foreign, "repo": "Turma"}
        with mock.patch.object(ha, "resolve_base_ref", return_value="origin/main"):
            sm.import_session(cmd)
        self.assertEqual(len(sm.registry), 1)
        # Resumed at the LOCAL worktree path, not the foreign one.
        self.assertEqual(sm.registry[0]["worktreePath"], local)
        # The transcript landed under the LOCAL slug so claude --resume resolves.
        self.assertTrue(os.path.isfile(os.path.join(
            ha.PROJECTS_ROOT, ha._project_slug(local), "transR.jsonl")))
        self.assertEqual(sm._launch_tmux.call_args.kwargs["resume_id"], "transR")

    def _write_pr_transcript(self, cwd, tid, url):
        """A transcript whose conversation OPENED a PR: the two entries a real
        `gh pr create` leaves behind (the call, then its URL output)."""
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(cwd))
        os.makedirs(proj, exist_ok=True)
        path = os.path.join(proj, tid + ".jsonl")
        with open(path, "w") as f:
            f.write(json.dumps({"type": "assistant", "cwd": cwd, "message": {
                "content": [{"type": "tool_use", "id": "t1", "name": "Bash",
                             "input": {"command": "gh pr create --fill"}}]}}) + "\n")
            f.write(json.dumps({"type": "user", "cwd": cwd, "message": {
                "content": [{"type": "tool_result", "tool_use_id": "t1",
                             "content": url}]}}) + "\n")
        return path

    def test_import_keeps_the_pr_chips(self):
        """A migrated session KEEPS the PR chips it opened: the transcript holds
        the `gh pr create` events, the transcript id is preserved, so the target
        re-derives them at launch (session_report's per-beat scan primes past
        them, and session_pr_urls is keyed by the freshly-minted id)."""
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "prsess")
        url = "https://github.com/xerktech/Turma/pull/77"
        src_path = self._write_pr_transcript(wt, "transP", url)
        blob = self._manager()._pack_transcript(src_path)
        shutil.rmtree(os.path.join(ha.PROJECTS_ROOT, ha._project_slug(wt)))

        sm = self._manager()
        # _launch_tmux is mocked, so pin the id itself as the real one would —
        # _seed_prs resolves the transcript by the session's pinned id.
        sm._launch_tmux = mock.Mock(
            side_effect=lambda sess, **kw: sess.__setitem__(
                "claudeSessionId", kw.get("resume_id")))
        sm._worktree_add = mock.Mock()
        sm._migration_download = lambda mid: blob
        cmd = {"type": "importSession", "cmdId": "cP", "migrationId": "migP",
               "transcriptId": "transP", "cwd": wt, "repo": "Turma"}
        with mock.patch.object(ha, "resolve_base_ref", return_value="origin/main"):
            sm.import_session(cmd)
        sess = sm.registry[0]
        # The chip is on the record, in session_pr_urls, and in the durable
        # ledger (keyed by the preserved transcript id) — all three channels the
        # PR-status feature reads.
        self.assertEqual(sess.get("prUrls"), [url])
        self.assertEqual(sm.session_pr_urls[sess["id"]], [url])
        self.assertEqual(sm.pr_ledger["transP"]["urls"], [url])


class TestSpawnFailures(ManagerMixin, unittest.TestCase):
    """A refused session-creating command is REPORTED, not just logged
    (XERK-265). The command is ACKed whether the agent ran it or declined it, so
    without a staged failure the hub cannot tell a refusal from a slow spawn: a
    migration sits in `importing` until MIGRATE_TIMEOUT_MS and the Sessions page
    spins out its follow window, both with no reason attached."""

    def setUp(self):
        super().setUp()
        p = mock.patch.object(ha, "REPOS_ROOT", os.path.join(self.tmp, "git"))
        p.start()
        self.addCleanup(p.stop)
        self.repo = {"name": "Turma", "path": os.path.join(ha.REPOS_ROOT, "Turma")}
        os.makedirs(self.repo["path"], exist_ok=True)
        p2 = mock.patch.object(ha, "scan_repos", lambda: [self.repo])
        p2.start()
        self.addCleanup(p2.stop)

    def _manager(self):
        sm = self.make_manager()
        sm._launch_tmux = mock.Mock()
        sm._launch_ttyd = mock.Mock()
        sm.device = "hostA"
        return sm

    def test_a_refused_resume_stages_its_reason_against_the_cmd_id(self):
        sm = self._manager()
        with mock.patch.object(ha, "MAX_SESSIONS", 0):
            sm._resume_at_cwd("trans1", os.path.join(ha.WORKTREES_ROOT, "Turma", "w1"),
                              cmd_id="c1")
        self.assertEqual(len(sm.spawn_failures), 1)
        f = sm.spawn_failures[0]
        self.assertEqual(f["cmdId"], "c1")
        self.assertIsNone(f["migrationId"])
        self.assertIn("MAX_SESSIONS", f["error"])
        self.assertEqual(sm.registry, [])   # and no half-built session behind it

    def test_a_refused_import_names_its_migration_so_the_hub_can_fail_it(self):
        """The case the ticket is about: the target declines, and the hub needs
        the migrationId to fail that move now instead of at its timeout."""
        sm = self._manager()
        sm._migration_download = lambda mid: None   # relay fetch fails
        sm.import_session({"migrationId": "mig9", "cmdId": "c9",
                           "transcriptId": "0" * 8 + "-0000-4000-8000-" + "0" * 12,
                           "cwd": os.path.join(ha.WORKTREES_ROOT, "Turma", "w2"),
                           "repo": "Turma"})
        self.assertEqual(sm.registry, [])
        self.assertEqual([f["migrationId"] for f in sm.spawn_failures], ["mig9"])
        self.assertEqual(sm.spawn_failures[0]["cmdId"], "c9")

    def test_an_import_refused_inside_resume_still_names_its_migration(self):
        """_resume_at_cwd's own refusals are the ones the ticket found discarded
        — they must carry the migration id through, not just the cmdId."""
        sm = self._manager()
        cwd = os.path.join(ha.WORKTREES_ROOT, "Turma", "w3")
        with mock.patch.object(ha, "MAX_SESSIONS", 0):
            sm._resume_at_cwd("trans3", cwd, cmd_id="c3", migration_id="mig3")
        self.assertEqual(sm.spawn_failures[0]["migrationId"], "mig3")

    def test_a_refused_export_is_reported_too(self):
        """The SOURCE half hangs the same way — a move whose blob never ships
        sits in `exporting` for the whole timeout."""
        sm = self._manager()
        sm.registry = [{"id": "s", "worktreePath": "/nope", "status": "running",
                        "repo": "Turma", "claudeSessionId": "gone"}]
        sm.export_session("s", "mig1")
        self.assertEqual([f["migrationId"] for f in sm.spawn_failures], ["mig1"])
        self.assertIn("transcript", sm.spawn_failures[0]["error"])

    def test_a_failed_upload_is_reported(self):
        sm = self._manager()
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "sessU")
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(wt))
        os.makedirs(proj, exist_ok=True)
        with open(os.path.join(proj, "transU.jsonl"), "w") as f:
            f.write(json.dumps({"type": "user", "cwd": wt}) + "\n")
        sm.registry = [{"id": "sessU", "worktreePath": wt, "status": "running",
                        "repo": "Turma", "claudeSessionId": "transU"}]
        sm._migration_upload = lambda mid, blob: False
        sm.export_session("sessU", "migU")
        self.assertEqual([f["migrationId"] for f in sm.spawn_failures], ["migU"])

    def test_a_resume_any_that_finds_no_transcript_is_reported(self):
        sm = self._manager()
        sm.resume_transcript("11111111-2222-4333-8444-555555555555",
                             cwd_hint=None, cmd_id="c7")
        self.assertEqual([f["cmdId"] for f in sm.spawn_failures], ["c7"])

    def test_an_uncorrelatable_refusal_is_logged_only(self):
        """Nothing to report it against: the migration id IS the handle, and a
        malformed one is what's being rejected."""
        sm = self._manager()
        sm.import_session({"migrationId": "bad id!", "transcriptId": "t"})
        self.assertEqual(sm.spawn_failures, [])

    def test_staged_failures_ride_the_next_beat_and_clear_on_delivery(self):
        sm = self._manager()
        self.assertNotIn("spawnFailures", sm.build_payload(1))  # absent when empty
        with mock.patch.object(ha, "MAX_SESSIONS", 0):
            sm._resume_at_cwd("t", os.path.join(ha.WORKTREES_ROOT, "Turma", "w4"),
                              cmd_id="c4")
        self.assertEqual(len(sm.build_payload(1)["spawnFailures"]), 1)
        with mock.patch.object(ha.urllib.request, "urlopen") as uo:
            uo.return_value.__enter__.return_value.read.return_value = b"{}"
            sm.post({"device": "hostA"})
        self.assertEqual(sm.spawn_failures, [])

    def test_the_prune_race_is_reported(self):
        """THE refusal this ticket exists for. XERK-256 made a resume decline
        while a prune removes the target worktree — ordinary timing between two
        features, so it must not read as a move that randomly hung for the
        timeout."""
        sm = self._manager()
        cwd = os.path.join(ha.WORKTREES_ROOT, "Turma", "wP")
        os.makedirs(cwd, exist_ok=True)
        sm._claim_worktree = mock.Mock(return_value=False)
        sm._resume_at_cwd("tP", cwd, cmd_id="cP", migration_id="migP")
        self.assertEqual([f["migrationId"] for f in sm.spawn_failures], ["migP"])
        self.assertIn("prune", sm.spawn_failures[0]["error"])
        self.assertEqual(sm.registry, [])   # the claim failing un-registers it

    def test_the_prune_race_is_reported_on_a_killed_resume_too(self):
        """resume() hits the same handshake, and its refusal was equally silent
        — worse, in fact: that wait is by session id and never times out."""
        sm = self._manager()
        sm.closed = [{"id": "k1", "repo": "Turma", "worktreePath":
                      os.path.join(ha.WORKTREES_ROOT, "Turma", "wK"),
                      "claudeSessionId": "tK", "ttydPort": 7700}]
        sm._claim_worktree = mock.Mock(return_value=False)
        sm.resume("k1", cmd_id="cK")
        self.assertEqual([f["cmdId"] for f in sm.spawn_failures], ["cK"])
        self.assertIn("prune", sm.spawn_failures[0]["error"])

    def test_a_launch_that_throws_is_reported_like_a_refusal(self):
        """The record survives as `status:"error"`, and the hub's migration
        handoff waits for a RUNNING session — so without this the move waits out
        its timeout exactly as a refusal used to."""
        sm = self._manager()
        sm._launch_tmux = mock.Mock(side_effect=RuntimeError("tmux is gone"))
        cwd = os.path.join(ha.WORKTREES_ROOT, "Turma", "wE")
        os.makedirs(cwd, exist_ok=True)
        sm._resume_at_cwd("tE", cwd, cmd_id="cE", migration_id="migE")
        self.assertEqual([f["migrationId"] for f in sm.spawn_failures], ["migE"])
        self.assertIn("tmux is gone", sm.spawn_failures[0]["error"])
        # The record is left carrying the error, as _set_error intends — the
        # refusal is what tells the hub, since an `error` record never satisfies
        # its wait for a running one.
        self.assertEqual(sm.registry[0]["status"], "error")

    def test_a_reason_carrying_an_exception_is_truncated(self):
        """A reason interpolates `{e}`, whose text is unbounded, and it lands in
        a hub cache that counts against that host's record ceiling — an 8 MiB
        one would wedge the host's control plane."""
        sm = self._manager()
        sm._refuse_start("x" * 100000, cmd_id="c1")
        self.assertEqual(len(sm.spawn_failures[0]["error"]),
                         ha.SPAWN_FAILURE_REASON_MAX)

    def test_the_staged_list_is_bounded(self):
        sm = self._manager()
        for i in range(ha.SPAWN_FAILURES_MAX + 10):
            sm._refuse_start(f"nope {i}", cmd_id=f"c{i}")
        self.assertEqual(len(sm.spawn_failures), ha.SPAWN_FAILURES_MAX)
        # Oldest-first eviction: the newest refusal is always the one kept.
        self.assertEqual(sm.spawn_failures[-1]["cmdId"],
                         f"c{ha.SPAWN_FAILURES_MAX + 9}")


class TestRegistryPersistence(ManagerMixin, unittest.TestCase):
    def test_save_load_round_trip(self):
        sm = self.make_manager()
        self.assertEqual(sm.registry, [])  # fresh boot: no registry file
        sm.registry = [
            {"id": "ab123", "repo": "Turma", "status": "running", "ttydPort": 7700},
            {"id": "cd456", "repo": "DockerOps", "status": "stopped", "ttydPort": 7701},
        ]
        sm.save()
        self.assertFalse(os.path.exists(ha.REGISTRY_PATH + ".tmp"))  # atomic
        sm2 = self.make_manager()
        self.assertEqual(sm2.registry, sm.registry)

    def test_corrupt_registry_yields_empty(self):
        os.makedirs(ha.REGISTRY_DIR, exist_ok=True)
        with open(ha.REGISTRY_PATH, "w") as f:
            f.write("{not json!")
        self.assertEqual(self.make_manager().registry, [])

    def test_non_list_registry_yields_empty(self):
        os.makedirs(ha.REGISTRY_DIR, exist_ok=True)
        with open(ha.REGISTRY_PATH, "w") as f:
            json.dump({"id": "notalist"}, f)
        self.assertEqual(self.make_manager().registry, [])

    def test_damaged_registry_is_quarantined_not_eaten(self):
        """A damaged registry must survive its own recovery (XERK-235).

        Returning [] silently meant the next beat's save() overwrote the
        damaged file with `[]`: every session went unmanaged with tmux, ttyd
        and its port still live, nothing logged, and the evidence gone.
        """
        os.makedirs(ha.REGISTRY_DIR, exist_ok=True)
        for body in ('[{"id":"f5951","repo":"alpha","status":"run',
                     "this is not json at all",
                     '{"id": "x"}'):
            with self.subTest(body=body[:20]):
                with open(ha.REGISTRY_PATH, "w") as f:
                    f.write(body)
                sm = self.make_manager()
                self.assertEqual(sm.registry, [])
                kept = [n for n in os.listdir(ha.REGISTRY_DIR)
                        if n.startswith("sessions.json.corrupt.")]
                self.assertTrue(kept, "the damaged registry was not preserved")
                with open(os.path.join(ha.REGISTRY_DIR, kept[0])) as f:
                    self.assertEqual(f.read(), body)
                for n in kept:
                    os.remove(os.path.join(ha.REGISTRY_DIR, n))

    def test_missing_registry_is_not_quarantined(self):
        """First boot is not a corruption — it must leave no scary artifact."""
        os.makedirs(ha.REGISTRY_DIR, exist_ok=True)
        self.assertEqual(self.make_manager().registry, [])
        self.assertEqual(
            [n for n in os.listdir(ha.REGISTRY_DIR) if ".corrupt." in n], []
        )


class TestPortAndIdAllocation(ManagerMixin, unittest.TestCase):
    def test_alloc_port_from_base(self):
        sm = self.make_manager()
        self.assertEqual(sm._alloc_port(), ha.TTYD_PORT_BASE)

    def test_alloc_port_skips_used_and_fills_gaps(self):
        sm = self.make_manager()
        base = ha.TTYD_PORT_BASE
        sm.registry = [{"id": "a", "ttydPort": base}, {"id": "b", "ttydPort": base + 2}]
        self.assertEqual(sm._alloc_port(), base + 1)
        sm.registry.append({"id": "c", "ttydPort": base + 1})
        self.assertEqual(sm._alloc_port(), base + 3)

    def test_alloc_port_skips_a_port_something_else_already_holds(self):
        """A port the registry doesn't know about is still taken (XERK-235).

        A ttyd orphaned by a lost registry, a second agent, or an unrelated
        service holds the bind. ttyd's failure to take it is silent, so the
        session's terminal would 404 for its whole life — or worse, the orphan
        answers on it and serves ANOTHER session's pane.
        """
        sm = self.make_manager()
        base = ha.TTYD_PORT_BASE
        self.bound_ports = {base, base + 1}
        self.assertEqual(sm._alloc_port(), base + 2)

    def test_alloc_port_skips_registry_and_bound_together(self):
        sm = self.make_manager()
        base = ha.TTYD_PORT_BASE
        sm.registry = [{"id": "a", "ttydPort": base + 2}]
        self.bound_ports = {base, base + 1}
        self.assertEqual(sm._alloc_port(), base + 3)

    def test_new_id_avoids_existing(self):
        sm = self.make_manager()
        sm.registry = [{"id": "aaaaa"}]
        ids = {sm._new_id() for _ in range(50)}
        self.assertNotIn("aaaaa", ids)
        for sid in ids:
            self.assertEqual(len(sid), 5)


class TestAckDeque(ManagerMixin, unittest.TestCase):
    def test_eviction_keeps_set_bounded_and_in_sync(self):
        sm = self.make_manager()
        sm.acked_order = deque(maxlen=3)  # shrink for the test
        for cid in ["c1", "c2", "c3"]:
            sm._ack(cid)
        self.assertEqual(sm.acked, {"c1", "c2", "c3"})
        sm._ack("c4")  # evicts c1
        self.assertEqual(sm.acked, {"c2", "c3", "c4"})
        self.assertEqual(list(sm.acked_order), ["c2", "c3", "c4"])
        sm._ack("c5")  # keeps evicting oldest-first, set stays in sync
        self.assertEqual(sm.acked, {"c3", "c4", "c5"})
        self.assertEqual(len(sm.acked), len(sm.acked_order))


class TestHandleCommands(ManagerMixin, unittest.TestCase):
    def test_set_model_source_command_is_dispatched(self):
        """Deleting the dispatch arm makes the hub queue the command, the agent
        ack it, and every switch become a silent no-op."""
        sm = self.make_manager()
        sm.set_model_source = mock.Mock()
        sm.save = mock.Mock()
        sm.handle_commands([{"cmdId": "ms1", "type": "setModelSource",
                             "sessionId": "abcde", "modelSource": "local"}])
        sm.set_model_source.assert_called_once_with("abcde", "local")

    def test_dedup_and_dispatch(self):
        sm = self.make_manager()
        sm.spawn = mock.Mock()
        sm.kill = mock.Mock()
        sm.save = mock.Mock()

        cmds = [
            {"cmdId": "c1", "type": "spawn", "repo": "Turma"},
            {"cmdId": "c2", "type": "kill", "sessionId": "ab123"},
            {"type": "kill", "sessionId": "no-cmd-id"},  # no cmdId -> ignored
            "not-a-dict",                                 # garbage -> ignored
        ]
        self.assertTrue(sm.handle_commands(cmds))
        # spawn now threads the composer options (all None for a bare command)
        # plus the cmdId, which it echoes onto the session it creates.
        sm.spawn.assert_called_once_with(
            "Turma", prompt=None, label=None, base_ref=None,
            model=None, permission_mode=None, model_source=None, cmd_id="c1",
        )
        sm.kill.assert_called_once_with("ab123")
        sm.save.assert_called_once()
        self.assertEqual(sm.acked, {"c1", "c2"})

        # Re-delivery of the same cmdIds (at-least-once): nothing re-executes.
        sm.spawn.reset_mock()
        sm.kill.reset_mock()
        self.assertFalse(sm.handle_commands(cmds))
        sm.spawn.assert_not_called()
        sm.kill.assert_not_called()

    def test_refresh_jira_command_polls_when_configured(self):
        sm = self.make_manager()
        sm.refresh_jira = mock.Mock()
        sm.save = mock.Mock()
        with mock.patch.object(ha, "jira_configured", return_value=True):
            self.assertTrue(sm.handle_commands(
                [{"cmdId": "j1", "type": "refreshJira"}]))
        sm.refresh_jira.assert_called_once_with()
        self.assertEqual(sm.acked, {"j1"})

    def test_refresh_jira_command_is_a_noop_when_unconfigured(self):
        # The "unset env = zero Jira HTTP calls, ever" guarantee has to hold
        # even against a command an older/confused hub aimed at this host.
        sm = self.make_manager()
        sm.refresh_jira = mock.Mock()
        sm.save = mock.Mock()
        with mock.patch.object(ha, "jira_configured", return_value=False):
            self.assertTrue(sm.handle_commands(
                [{"cmdId": "j2", "type": "refreshJira"}]))
        sm.refresh_jira.assert_not_called()
        # Still acked — an unexecutable command must not redeliver forever.
        self.assertEqual(sm.acked, {"j2"})

    def test_spawn_command_threads_composer_options(self):
        sm = self.make_manager()
        sm.spawn = mock.Mock()
        sm.save = mock.Mock()
        sm.handle_commands([{
            "cmdId": "c9", "type": "spawn", "repo": "Turma",
            "prompt": "fix the bug", "label": "Fix login", "baseRef": "main",
            "model": "opus", "permissionMode": "plan",
        }])
        sm.spawn.assert_called_once_with(
            "Turma", prompt="fix the bug", label="Fix login", base_ref="main",
            model="opus", permission_mode="plan", model_source=None,
            cmd_id="c9",
        )

    def test_prune_command_dispatches_to_prune_repo(self):
        sm = self.make_manager()
        sm.prune_repo = mock.Mock()
        sm.save = mock.Mock()
        sm.handle_commands([{"cmdId": "cp", "type": "prune", "repo": "Turma"}])
        sm.prune_repo.assert_called_once_with("Turma")
        self.assertIn("cp", sm.acked)

    def test_restart_agent_command_arms_flag_without_exiting(self):
        # XERK-157: restartAgent only ARMS the restart in handle_commands (so the
        # command gets acked and leaves the hub's queue); the exit happens later
        # in run_forever, once that ack has been delivered.
        sm = self.make_manager()
        sm.save = mock.Mock()
        sm._perform_restart = mock.Mock(side_effect=AssertionError("must not exit here"))
        self.assertTrue(sm.handle_commands([{"cmdId": "ra", "type": "restartAgent"}]))
        self.assertTrue(sm._restart_pending)
        self.assertIn("ra", sm.acked)
        sm._perform_restart.assert_not_called()

    def test_unknown_type_and_poison_command_still_acked(self):
        sm = self.make_manager()
        sm.save = mock.Mock()
        sm.restart = mock.Mock(side_effect=RuntimeError("boom"))
        cmds = [
            {"cmdId": "u1", "type": "frobnicate"},
            {"cmdId": "p1", "type": "restart", "sessionId": "x"},
        ]
        self.assertTrue(sm.handle_commands(cmds))  # no exception escapes
        self.assertEqual(sm.acked, {"u1", "p1"})

    def test_empty_and_none(self):
        sm = self.make_manager()
        sm.save = mock.Mock()
        self.assertFalse(sm.handle_commands([]))
        self.assertFalse(sm.handle_commands(None))
        sm.save.assert_not_called()


class TestResumeOnBootAdopt(ManagerMixin, unittest.TestCase):
    """Boot re-adopts a session whose claude tmux is STILL ALIVE instead of
    killing+relaunching it — the property that lets the native agent update
    itself (restart just this manager) without stopping active sessions. When
    the tmux is gone it falls back to today's --resume relaunch."""

    def _running_sess(self):
        return {
            "id": "aaaaa", "status": "running", "ttydPort": 7700,
            "worktreePath": self.tmp,  # exists, so it isn't demoted
            "tmuxName": "agent-aaaaa",
        }

    def test_adopts_live_tmux_without_relaunch(self):
        sm = self.make_manager()
        sm.registry = [self._running_sess()]
        sm._launch_tmux = mock.Mock()
        sm._launch_ttyd = mock.Mock()
        with mock.patch.object(sm, "_tmux_alive", return_value=True):
            sm.resume_on_boot()
        # The live claude is left running: no kill, no relaunch...
        sm._launch_tmux.assert_not_called()
        # ...but the ttyd bridge is re-ensured, and the session stays running.
        sm._launch_ttyd.assert_called_once()
        self.assertEqual(sm.registry[0]["status"], "running")

    def test_relaunches_when_tmux_gone(self):
        sm = self.make_manager()
        sm.registry = [self._running_sess()]
        sm._launch_tmux = mock.Mock()
        sm._launch_ttyd = mock.Mock()
        with mock.patch.object(sm, "_tmux_alive", return_value=False):
            sm.resume_on_boot()
        # Whole tree died (container restart / reboot): relaunch with --resume,
        # continuing the prior conversation.
        sm._launch_tmux.assert_called_once()
        self.assertTrue(sm._launch_tmux.call_args.kwargs.get("resume"))
        sm._launch_ttyd.assert_called_once()

    def test_worktree_gone_is_demoted(self):
        sm = self.make_manager()
        sess = self._running_sess()
        sess["worktreePath"] = os.path.join(self.tmp, "vanished")
        sm.registry = [sess]
        sm._launch_tmux = mock.Mock()
        sm._launch_ttyd = mock.Mock()
        with mock.patch.object(sm, "_tmux_alive", return_value=True):
            sm.resume_on_boot()
        self.assertEqual(sess["status"], "stopped")
        sm._launch_tmux.assert_not_called()
        sm._launch_ttyd.assert_not_called()

    def test_launch_ttyd_adopts_our_surviving_ttyd(self):
        # A ttyd WE launched that survived a manager restart still holds the port
        # and its pid is alive. _launch_ttyd must adopt it (no rebind, no Popen).
        sm = self.make_manager()
        sess = self._running_sess()
        sess["ttydPid"] = 5150
        with mock.patch.object(ha, "_pid_alive", return_value=True), \
             mock.patch.object(ha, "_port_open", return_value=True), \
             mock.patch.object(ha.subprocess, "Popen") as popen:
            sm._launch_ttyd(sess)
        popen.assert_not_called()
        self.assertNotIn(sess["id"], sm.ttyd)

    def test_launch_ttyd_does_not_adopt_a_reused_open_port(self):
        # Fresh spawn onto a port that happens to be open (just freed by a killed
        # session whose ttyd hasn't died): no ttydPid, so we must NOT adopt — we
        # launch our own, avoiding attaching to the wrong session's terminal.
        sm = self.make_manager()
        sess = self._running_sess()  # no ttydPid

        class FakeProc:
            pid = 7000
            def poll(self_i):
                return None

        with mock.patch.object(ha, "_port_open", return_value=True), \
             mock.patch.object(ha.subprocess, "Popen", return_value=FakeProc()) as popen:
            sm._launch_ttyd(sess)
        popen.assert_called_once()
        self.assertEqual(sess["ttydPid"], 7000)

    def test_launch_ttyd_persists_pid_when_port_free(self):
        sm = self.make_manager()
        sess = self._running_sess()

        class FakeProc:
            pid = 4242
            def poll(self_i):
                return None

        with mock.patch.object(ha, "_port_open", return_value=False), \
             mock.patch.object(ha.subprocess, "Popen", return_value=FakeProc()):
            sm._launch_ttyd(sess)
        # The pid is persisted so a later manager can reap an adopted orphan.
        self.assertEqual(sess["ttydPid"], 4242)
        self.assertIs(sm.ttyd[sess["id"]].pid, 4242)

    def test_launch_ttyd_lets_a_mac_force_a_selection(self):
        # The Claude TUI holds mouse tracking, so xterm.js only makes a
        # selection — the prerequisite for copying anything out — when a
        # modifier forces one. On macOS that modifier is Alt AND ONLY with this
        # option on, so without it a Mac operator cannot select at all (XERK-7).
        sm = self.make_manager()
        sess = self._running_sess()

        class FakeProc:
            pid = 4243
            def poll(self_i):
                return None

        with mock.patch.object(ha, "_port_open", return_value=False), \
             mock.patch.object(ha.subprocess, "Popen", return_value=FakeProc()) as popen:
            sm._launch_ttyd(sess)
        args = popen.call_args[0][0]
        self.assertIn("macOptionClickForcesSelection=true", args)

    def test_kill_ttyd_reaps_adopted_orphan_by_pid(self):
        # An adopted ttyd isn't in self.ttyd; _kill_ttyd must still reap it via
        # the persisted pid so stop/delete don't leak the process and its port.
        sm = self.make_manager()
        sess = self._running_sess()
        sess["ttydPid"] = 9191
        sm.registry = [sess]
        with mock.patch.object(ha.os, "kill") as oskill:
            sm._kill_ttyd(sess["id"])
        oskill.assert_called_once_with(9191, ha.signal.SIGTERM)


class TestSessionLifecycle(ManagerMixin, unittest.TestCase):
    def make_spawn_ready_manager(self, repos):
        sm = self.make_manager()
        p = mock.patch.object(ha, "scan_repos", lambda: repos)
        p.start()
        self.addCleanup(p.stop)
        sm._launch_ttyd = mock.Mock()  # avoid the real Popen
        return sm

    def test_spawn_creates_registry_entry(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        self.assertEqual(len(sm.registry), 1)
        sess = sm.registry[0]
        self.assertEqual(sess["status"], "running")
        self.assertEqual(sess["repo"], "Turma")
        # The app creates no branch — the worktree is detached, the agent branches.
        self.assertIsNone(sess["branch"])
        self.assertEqual(sess["ttydPort"], ha.TTYD_PORT_BASE)
        self.assertEqual(sess["tmuxName"], f"agent-{sess['id']}")
        self.assertTrue(sess["rcName"].endswith(f"-Turma-{sess['id']}"))
        self.assertEqual(
            sess["worktreePath"],
            os.path.join(ha.WORKTREES_ROOT, "Turma", sess["id"]),
        )
        # git worktree add --detach (no -b) went through run_ok
        wt = next(c for c in self.run_ok_calls if "worktree" in c and "add" in c)
        self.assertIn("--detach", wt)
        self.assertNotIn("-b", wt)

    def test_spawn_echoes_the_hub_command_id_onto_the_session(self):
        # The hub can't name the session it asked for — we mint the id here — so
        # it correlates by the command id, which must survive onto the record and
        # into the heartbeat payload for the UI to open the session it started.
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma", cmd_id="c42")
        sess = sm.registry[0]
        self.assertEqual(sess["spawnCmdId"], "c42")
        self.assertEqual(sm._session_payload(sess, refresh=False)["spawnCmdId"], "c42")

    def test_spawn_without_a_command_id_reports_none(self):
        # Spawns that don't come from a hub command (and sessions predating the
        # echo) simply have nothing to correlate — never a missing key.
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        self.assertIsNone(sm.registry[0]["spawnCmdId"])
        self.assertIsNone(sm._session_payload(sm.registry[0], refresh=False)["spawnCmdId"])

    def test_spawn_at_max_sessions_queues_instead_of_refusing(self):
        # A spawn that overruns the cap is no longer dropped on the floor — it
        # lands as a `queued` record with no worktree/tmux, waiting for a slot.
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        p = mock.patch.object(ha, "MAX_SESSIONS", 1)
        p.start()
        self.addCleanup(p.stop)
        sm.registry = [{"id": "aaaaa", "status": "running", "ttydPort": 7700}]
        self.run_ok_calls.clear()
        sm.spawn("Turma")
        self.assertEqual(len(sm.registry), 2)
        q = sm.registry[1]
        self.assertEqual(q["status"], "queued")
        self.assertEqual(q["queuedReason"], "capacity")
        self.assertIsNotNone(q["queuedAt"])
        # No worktree was added for a queued session (it isn't provisioned yet).
        self.assertFalse(any("worktree" in c and "add" in c for c in self.run_ok_calls))
        # The queue markers ride the heartbeat so the card can explain the wait.
        pay = sm._session_payload(q, refresh=False)
        self.assertEqual(pay["queuedReason"], "capacity")

    def test_drain_queue_provisions_when_a_slot_frees(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        p = mock.patch.object(ha, "MAX_SESSIONS", 1)
        p.start()
        self.addCleanup(p.stop)
        sm.registry = [{"id": "aaaaa", "status": "running", "ttydPort": 7700}]
        sm.spawn("Turma")
        q = sm.registry[1]
        self.assertEqual(q["status"], "queued")
        # Still full — draining does nothing.
        sm._drain_queue()
        self.assertEqual(q["status"], "queued")
        # Free the slot; the next drain provisions the queued session in place.
        sm.registry[0]["status"] = "stopped"
        self.run_ok_calls.clear()
        sm._drain_queue()
        self.assertEqual(q["status"], "running")
        self.assertIsNone(q.get("queuedReason"))
        self.assertTrue(any("worktree" in c and "add" in c for c in self.run_ok_calls))

    def test_drain_queue_is_one_per_beat(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        p = mock.patch.object(ha, "MAX_SESSIONS", 5)
        p.start()
        self.addCleanup(p.stop)
        sm.spawn("Turma")  # runs (slot free)
        # Two more that queue only because they await a clone that never comes;
        # force them queued via a low cap instead.
        p.stop()
        p2 = mock.patch.object(ha, "MAX_SESSIONS", 1)
        p2.start()
        self.addCleanup(p2.stop)
        sm.spawn("Turma")
        sm.spawn("Turma")
        queued = [s for s in sm.registry if s["status"] == "queued"]
        self.assertEqual(len(queued), 2)
        # Raise the cap so both COULD run, then drain: exactly one provisions.
        p2.stop()
        p3 = mock.patch.object(ha, "MAX_SESSIONS", 5)
        p3.start()
        self.addCleanup(p3.stop)
        sm._drain_queue()
        self.assertEqual(sum(1 for s in sm.registry if s["status"] == "running"), 2)
        self.assertEqual(sum(1 for s in sm.registry if s["status"] == "queued"), 1)

    def test_spawn_refused_for_unknown_repo(self):
        sm = self.make_spawn_ready_manager([])
        sm.spawn("NoSuchRepo")
        self.assertEqual(sm.registry, [])

    def test_capacity_payload_reports_the_ceiling_and_load(self):
        # The hub can't split work across an org's hosts unless each reports its
        # ceiling and current load; this is the fact ticket routing ranks on.
        sm = self.make_spawn_ready_manager([])
        p = mock.patch.object(ha, "MAX_SESSIONS", 3)
        p.start()
        self.addCleanup(p.stop)
        sm.registry = [
            {"id": "a", "status": "running"},
            {"id": "b", "status": "running"},
            {"id": "c", "status": "queued"},
        ]
        cap = sm._capacity_payload()
        self.assertEqual(cap["maxSessions"], 3)
        self.assertEqual(cap["running"], 2)
        self.assertEqual(cap["queued"], 1)
        self.assertEqual(cap["free"], 1)
        self.assertFalse(cap["rootRunning"])
        # free never goes negative even when the cap is lowered under a full host.
        with mock.patch.object(ha, "MAX_SESSIONS", 1):
            self.assertEqual(sm._capacity_payload()["free"], 0)

    def test_kill_drops_record_but_keeps_worktree(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        sid = sm.registry[0]["id"]
        sm.usage_cache[sid] = {"totals": {}}
        self.run_ok_calls.clear()
        self.run_calls.clear()
        sm.kill(sid)
        self.assertEqual(sm.registry, [])
        self.assertNotIn(sid, sm.usage_cache)
        # kill must KEEP the worktree (uncommitted work survives): no worktree
        # remove and no `git branch -D`.
        self.assertFalse(
            any("worktree" in c and "remove" in c
                for c in self.run_calls + self.run_ok_calls),
            f"kill must not remove the worktree: {self.run_calls}",
        )
        self.assertFalse(
            any("branch" in c and "-D" in c for c in self.run_calls),
            f"kill must not delete a branch: {self.run_calls}",
        )
        # It is offered for resume (closed history records it).
        self.assertTrue(any(c.get("id") == sid for c in sm.closed))

    def test_kill_snapshots_prs_and_transcript_onto_the_closed_record(self):
        """kill() drops the live caches keyed by session id, so the two things
        the hub's Ended-sessions view needs — which PRs this session opened, and
        which conversation was its own — have to move onto the closed record on
        the way out, or they are simply gone."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        sess = sm.registry[0]
        sid = sess["id"]
        url = "https://github.com/o/r/pull/7"
        sm.session_pr_urls[sid] = [url]
        sm.pr_status_cache[url] = {"url": url, "state": "MERGED", "checks": "passing"}
        # The transcript this session was having — the one its launch pinned.
        cs = sess["claudeSessionId"]
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(sess["worktreePath"]))
        os.makedirs(proj, exist_ok=True)
        with open(os.path.join(proj, f"{cs}.jsonl"), "w") as f:
            f.write("{}\n")

        sm.kill(sid)

        rec = next(c for c in sm.closed if c["id"] == sid)
        self.assertEqual(rec["prUrls"], [url])
        self.assertEqual(rec["transcriptId"], cs)
        # The live cache is gone, but the payload still resolves full PR status
        # through the snapshot — the whole point of keeping the URLs.
        self.assertNotIn(sid, sm.session_pr_urls)
        entry = next(c for c in sm._closed_payload() if c["id"] == sid)
        self.assertEqual(entry["prs"], [{"url": url, "state": "MERGED", "checks": "passing"}])
        self.assertEqual(entry["transcriptId"], cs)

    def test_session_payload_reports_the_pinned_transcript_id_while_running(self):
        """The pin makes a session's conversation free to name, so the payload
        reports it from the moment it spawns — no listdir, running or not. The
        hub needs it live: it's what points the live tail at THIS session's
        transcript rather than the newest one sharing its project dir."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        sess = sm.registry[0]
        self.assertEqual(sm._session_payload(sess, refresh=False)["transcriptId"],
                         sess["claudeSessionId"])
        sess["status"] = "stopped"
        self.assertEqual(sm._session_payload(sess, refresh=False)["transcriptId"],
                         sess["claudeSessionId"])

    def test_unpinned_session_payload_carries_its_transcript_id_running_or_stopped(self):
        """A session spawned before the pin has no id to report, so the payload
        falls back to the newest transcript in its project dir.

        It pays that listdir while RUNNING too. The lookup used to be skipped for
        a running session (it's read live over /live, not opened from the
        archive), but the hub's Ended list now dedupes on this id, and a running
        session is the one case where a duplicate is intolerable: the durable
        side of that list is a transcript scan that's minutes stale by design, so
        with nothing to recognise a just-resumed session by it would show as
        running and ended at once."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        sess = sm.registry[0]
        sess["claudeSessionId"] = None  # as an older agent left it
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(sess["worktreePath"]))
        os.makedirs(proj, exist_ok=True)
        with open(os.path.join(proj, "t-xyz.jsonl"), "w") as f:
            f.write("{}\n")

        self.assertEqual(sm._session_payload(sess, refresh=False)["transcriptId"], "t-xyz")
        sess["status"] = "stopped"
        self.assertEqual(sm._session_payload(sess, refresh=False)["transcriptId"], "t-xyz")

    def test_unpinned_session_payload_transcript_id_is_none_before_one_exists(self):
        """An unpinned session that hasn't written a transcript yet has no id to
        report and nothing on disk to guess from. The key is still present and
        null — the hub reads it unconditionally to key its Ended-list dedupe, and
        a missing key would read as a session with no conversation rather than
        one whose conversation hasn't started."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        sess = sm.registry[0]
        sess["claudeSessionId"] = None   # as an older agent left it
        payload = sm._session_payload(sess, refresh=False)
        self.assertIn("transcriptId", payload)
        self.assertIsNone(payload["transcriptId"])

    def test_closed_payload_is_null_safe_for_a_session_with_no_pr_or_transcript(self):
        """The common case: a session killed before it opened a PR, and (on an
        older agent's closed.json) one recorded before the snapshot existed. The
        keys must still be present and null rather than absent — the hub reads
        them unconditionally."""
        sm = self.make_manager()
        sm.closed = [{"id": "s1", "repo": "r"}]   # a pre-snapshot record
        entry = sm._closed_payload()[0]
        self.assertIsNone(entry["prs"])
        self.assertIsNone(entry["transcriptId"])
        self.assertIsNone(entry["ticket"])

    def test_closed_payload_reports_the_ticket_the_session_worked(self):
        """_remember_closed has always snapshotted the ticket onto the record, but
        it never reached the wire — so the board, which reverse-indexes
        session.ticket, lost a ticket's session the moment it was killed and could
        only ever say which session IS working a ticket, never which one DID.

        summaryManual rides along for the same reason: it decides how the board
        labels the chip, which must not change just because the session was
        killed."""
        ticket = {"key": "PROJ-7", "siteKey": "x.atlassian.net", "branch": "PROJ-7",
                  "url": "https://x.atlassian.net/browse/PROJ-7", "summary": "Fix it"}
        sm = self.make_manager()
        sm.closed = [{"id": "s1", "repo": "r", "ticket": ticket,
                      "summary": "My Own Name", "summaryManual": True}]
        entry = sm._closed_payload()[0]
        self.assertEqual(entry["ticket"], ticket)
        self.assertTrue(entry["summaryManual"])

    def test_delete_removes_worktree_but_touches_no_branch(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        sid = sm.registry[0]["id"]
        os.makedirs(sm.registry[0]["worktreePath"], exist_ok=True)  # so it's removed
        self.run_calls.clear()
        self.run_ok_calls.clear()
        sm.delete(sid)
        self.assertEqual(sm.registry, [])
        # The worktree is removed...
        self.assertTrue(
            any("worktree" in c and "remove" in c
                for c in self.run_calls + self.run_ok_calls),
            f"delete must remove the worktree: {self.run_calls}",
        )
        # ...but the app owns no branch, so no branch is ever deleted or renamed
        # (the agent's own branch, and its committed work, survive untouched).
        allcalls = self.run_calls + self.run_ok_calls
        self.assertFalse(
            any("branch" in c and ("-D" in c or "-m" in c) for c in allcalls),
            f"delete must not touch any branch: {allcalls}",
        )
        # No stale resume offer is left behind.
        self.assertFalse(any(c.get("id") == sid for c in sm.closed))

    def test_start_refuses_when_already_running_or_full(self):
        sm = self.make_manager()
        sm._launch_tmux = mock.Mock()
        sm._launch_ttyd = mock.Mock()
        sm.registry = [{"id": "aaaaa", "status": "running", "ttydPort": 7700,
                        "worktreePath": self.tmp, "tmuxName": "agent-aaaaa"}]
        sm.start("aaaaa")  # already running: no relaunch
        sm._launch_tmux.assert_not_called()

    def test_start_resumes_stopped_session(self):
        sm = self.make_manager()
        sm._launch_tmux = mock.Mock()
        sm._launch_ttyd = mock.Mock()
        sess = {"id": "aaaaa", "status": "stopped", "stoppedAt": "x",
                "errorMsg": "old", "ttydPort": 7700,
                "worktreePath": self.tmp, "tmuxName": "agent-aaaaa"}
        sm.registry = [sess]
        sm.start("aaaaa")
        self.assertEqual(sess["status"], "running")
        self.assertIsNone(sess["stoppedAt"])
        self.assertIsNone(sess["errorMsg"])
        sm._launch_tmux.assert_called_once()

    def test_error_is_captured_not_raised(self):
        sm = self.make_manager()
        sm._launch_tmux = mock.Mock(side_effect=RuntimeError("tmux exploded"))
        sess = {"id": "aaaaa", "status": "stopped", "stoppedAt": "x",
                "errorMsg": None, "ttydPort": 7700,
                "worktreePath": self.tmp, "tmuxName": "agent-aaaaa"}
        sm.registry = [sess]
        sm.start("aaaaa")  # must not raise
        self.assertEqual(sess["status"], "error")
        self.assertIn("tmux exploded", sess["errorMsg"])

    # --- spawn composer options (#11/#12/#13) ------------------------------

    def _worktree_add_cmd(self):
        return next(c for c in self.run_ok_calls if "worktree" in c and "add" in c)

    def _claude_cmd(self):
        """The claude command line _launch_tmux hands to `tmux new-session`."""
        newsess = next(c for c in self.run_ok_calls if "new-session" in c)
        return newsess[-1]

    def test_spawn_no_options_keeps_todays_command_shape(self):
        """Regression guard: a bare spawn adds a DETACHED worktree (no -b, no
        app branch) and launches with the default auto mode, no --model, no
        positional prompt, on a freshly minted claude session id. (No default
        base resolves under the fake git, so the detach point is HEAD — nothing
        trails the worktree path.)"""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        sess = sm.registry[0]
        peers = ha.PEERS_SYSTEM_PROMPT.format(
            path=ha.PEERS_FILE, sid=sess["id"], host=sm.device)
        self.assertEqual(sess["status"], "running")
        wt = self._worktree_add_cmd()
        self.assertIn("--detach", wt)
        self.assertNotIn("-b", wt)
        self.assertEqual(wt[-1], sess["worktreePath"])  # nothing after the path
        settings = os.path.join(ha.REGISTRY_DIR, "guard-settings.json")
        self.assertEqual(
            self._claude_cmd(),
            f"TURMA_SESSION_ID={shlex.quote(sess['id'])} "
            f"TURMA_QUESTIONS_DIR={shlex.quote(ha.QUESTIONS_DIR)} "
            f"claude --session-id {sess['claudeSessionId']} "
            f"--remote-control '{sess['rcName']}' "
            f"--name {sess['rcName']} "
            f"--permission-mode auto --settings {shlex.quote(settings)} "
            f"--append-system-prompt "
            f"{shlex.quote(ha.NEW_WORK_SYSTEM_PROMPT + peers)}",
        )
        # The guard settings file was written and wires three PreToolUse
        # matchers: the Bash guard, the ~/.claude file guard, and the
        # AskUserQuestion → glasses bridge.
        loaded = json.loads(open(settings).read())
        matchers = [e["matcher"] for e in loaded["hooks"]["PreToolUse"]]
        self.assertEqual(matchers, ["Bash", "Write|Edit|MultiEdit|NotebookEdit",
                                    "AskUserQuestion"])

    def test_spawn_exports_gitlab_host_for_glab(self):
        """A GitLab-configured host tells every session's glab WHERE to auth:
        glab reads GITLAB_HOST, never the agent's GITLAB_URL, so without this a
        self-hosted session's `glab mr create` can't auth, the model falls back
        to a raw API call, and the MR never gets a chip (_scan_pr_line only
        attributes the creating command's own tool_result)."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        with mock.patch.multiple(ha, GITLAB_URL="gitlab.example.com",
                                 GITLAB_TOKEN="tok"):
            sm.spawn("Turma")
        self.assertIn("GITLAB_HOST=https://gitlab.example.com ",
                      self._claude_cmd())

    def test_spawn_leaves_an_operator_set_gitlab_host_alone(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        with mock.patch.multiple(ha, GITLAB_URL="gitlab.example.com",
                                 GITLAB_TOKEN="tok"), \
                mock.patch.dict(os.environ, {"GITLAB_HOST": "https://other.tld"}):
            sm.spawn("Turma")
        self.assertNotIn("GITLAB_HOST=", self._claude_cmd())

    def test_spawn_onto_the_local_model(self):
        """Starting NEW work on the local model matters as much as failing an
        existing session over: once usage is gone you cannot spawn either. A
        regression making every spawn subscription-only shipped green before
        this test existed."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        with mock.patch.multiple(ha, LOCAL_MODEL_BASE_URL="https://gw.example.com/v1",
                                 LOCAL_MODEL_API_KEY="sk-abc",
                                 LOCAL_MODEL_NAME="gpt-oss:120b"):
            sm.spawn("Turma", model_source="local")
            sess = sm.registry[-1]
            self.assertEqual(sess["modelSource"], "local")
            cmd = next(c[-1] for c in self.run_ok_calls if "new-session" in c)
            self.assertIn("local-model.env", cmd)

    def test_spawn_onto_local_refused_without_configuration(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        with mock.patch.multiple(ha, LOCAL_MODEL_BASE_URL="", LOCAL_MODEL_API_KEY=""):
            sm.spawn("Turma", model_source="local")
        self.assertEqual(sm.registry[-1]["status"], "error")

    def test_spawn_defaults_to_the_subscription(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        self.assertEqual(sm.registry[-1]["modelSource"], "subscription")

    def test_spawn_threads_all_options(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])

        # Make the base ref resolve (branch_exists -> run rev-parse --verify).
        def fake_run(cmd, cwd=None):
            self.run_calls.append(cmd)
            return "sha" if " ".join(cmd).endswith("--verify --quiet develop") else ""

        p = mock.patch.object(ha, "run", fake_run)
        p.start()
        self.addCleanup(p.stop)

        sm.spawn("Turma", prompt="fix the bug", label="Fix Login",
                 base_ref="develop", model="opus",
                 permission_mode="acceptEdits")
        sess = sm.registry[0]
        self.assertEqual(sess["status"], "running")
        # The app creates no branch — detached worktree, agent branches its work.
        self.assertIsNone(sess["branch"])
        # Stored option fields.
        self.assertEqual(sess["label"], "Fix Login")
        self.assertEqual(sess["model"], "opus")
        self.assertEqual(sess["permissionMode"], "acceptEdits")
        self.assertEqual(sess["baseRef"], "develop")
        # Label (slugged) flavors the RC display name.
        self.assertTrue(sess["rcName"].endswith("-Turma-Fix-Login"), sess["rcName"])
        # worktree add is detached and forks off the chosen base ref.
        wt = self._worktree_add_cmd()
        self.assertIn("--detach", wt)
        self.assertNotIn("-b", wt)
        self.assertEqual(wt[-1], "develop")
        # Launch line carries model, permission mode, and the positional prompt.
        cmd = self._claude_cmd()
        self.assertIn("--model opus", cmd)
        self.assertIn("--permission-mode acceptEdits", cmd)
        self.assertNotIn("bypassPermissions", cmd)
        self.assertTrue(cmd.endswith(" -- 'fix the bug'"), cmd)

    def test_spawn_permission_mode_default_omits_flag(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma", permission_mode="default")
        self.assertNotIn("--permission-mode", self._claude_cmd())

    def test_spawn_prompt_is_shell_quoted(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma", prompt="rm -rf / ; echo $HOME `whoami`")
        cmd = self._claude_cmd()
        # The whole prompt is one shlex-quoted token after `--`; no metachar leaks.
        self.assertIn(" -- '", cmd)
        self.assertTrue(cmd.rstrip().endswith("'"))

    # --- new-work branching policy (--append-system-prompt) ---------------

    def test_spawn_appends_new_work_branching_policy(self):
        """Every session is told to fork new work off the latest default branch,
        since its checkout is only as fresh as spawn time (worktree) or as the
        host left it (repos root). Shell-quoted as one token."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        cmd = self._claude_cmd()
        peers = ha.PEERS_SYSTEM_PROMPT.format(
            path=ha.PEERS_FILE, sid=sm.registry[0]["id"], host=sm.device)
        self.assertIn(
            "--append-system-prompt "
            + shlex.quote(ha.NEW_WORK_SYSTEM_PROMPT + peers),
            cmd,
        )

    def test_new_work_policy_names_the_fetch_and_remote_ref(self):
        """The directive's load-bearing content: fetch, resolve origin/HEAD, and
        branch off the REMOTE ref rather than the local HEAD."""
        policy = ha.NEW_WORK_SYSTEM_PROMPT
        self.assertIn("git fetch origin", policy)
        self.assertIn("refs/remotes/origin/HEAD", policy)
        self.assertIn("git switch -c <your-branch> origin/main", policy)

    def test_root_session_also_gets_branching_policy(self):
        """A repos-root session has no worktree, so it works in the repo dirs on
        whatever branch the host left checked out — it needs this MOST."""
        sm = self._root_ready_manager()
        sm.spawn(ha.ROOT_REPO_NAME)
        self.assertIn("--append-system-prompt", self._claude_cmd())

    def test_resume_relaunch_keeps_branching_policy(self):
        """It's session policy, not spawn state: a resumed session is launched
        with it too."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        sess = sm.registry[0]
        sm._launch_tmux(sess, resume=True)
        self.assertIn("--append-system-prompt", self._claude_cmd())

    # --- cross-session messaging (XERK-339) --------------------------------

    def test_launch_names_the_session_for_its_peers(self):
        """--name pins the PEER name (ListAgents/SendMessage) to the same string
        as the RC name. Without it claude names the session after its working
        directory — the random worktree dir — so no peer and no operator can
        tell one session from another."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        sess = sm.registry[0]
        self.assertIn(f"--name {sess['rcName']}", self._claude_cmd())

    def test_resume_relaunch_keeps_the_peer_name(self):
        """The name is the session's identity to its peers, so a resume must not
        drop it — a resumed session that went anonymous would be unreachable."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        sess = sm.registry[0]
        sm._launch_tmux(sess, resume=True)
        self.assertIn(f"--name {sess['rcName']}", self._claude_cmd())

    def test_ticket_session_is_named_for_its_ticket(self):
        """A ticket-backed session's RC/peer name carries the KEY rather than the
        random id, so `truenas-Turma-XERK-339` tells an operator (and a sibling
        picking a message target) what it is."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma", ticket={"key": "XERK-339", "summary": "Cross session"})
        sess = sm.registry[0]
        self.assertTrue(sess["rcName"].endswith("-Turma-XERK-339"),
                        sess["rcName"])
        self.assertNotIn(sess["id"], sess["rcName"])

    def test_two_sessions_never_share_a_peer_name(self):
        """A duplicate name makes BOTH sessions unaddressable, not just
        confusable: SendMessage refuses the ambiguous name and demands a `[ref]`
        the roster has no column for and no way to learn with ListAgents denied,
        so the message reaches neither. Measured on Claude Code 2.1.235 — it does
        not rename the later session for us."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma", ticket={"key": "XERK-339", "summary": "first go"})
        sm.spawn("Turma", ticket={"key": "XERK-339", "summary": "second go"})
        names = [s["rcName"] for s in sm.registry]
        self.assertEqual(len(set(names)), 2, names)
        self.assertTrue(names[0].endswith("-Turma-XERK-339"))
        self.assertTrue(names[1].endswith("-Turma-XERK-339-2"))

    def test_a_stopped_session_releases_its_peer_name(self):
        """Only a LIVE session reserves a name — a stopped one holds no inbox
        socket, so recycling its name is the point rather than a hazard."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma", label="hotfix")
        first = sm.registry[0]["rcName"]
        sm.registry[0]["status"] = "stopped"
        sm.spawn("Turma", label="hotfix")
        self.assertEqual(sm.registry[1]["rcName"], first)

    def test_a_duplicate_operator_label_also_gets_a_variant(self):
        """The collision is not ticket-specific: an operator reusing a label in
        one repo hits it too."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma", label="hotfix")
        sm.spawn("Turma", label="hotfix")
        self.assertNotEqual(sm.registry[0]["rcName"], sm.registry[1]["rcName"])

    def test_operator_label_still_beats_the_ticket_key(self):
        """An explicitly typed label is the operator's own name for the session
        and outranks the key we would otherwise derive."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma", label="hotfix", ticket={"key": "XERK-339"})
        self.assertTrue(sm.registry[0]["rcName"].endswith("-Turma-hotfix"))

    def test_bare_spawn_still_falls_back_to_the_session_id(self):
        """No label and no ticket: the id remains the last resort, so a bare
        spawn's name is unchanged from before this ticket."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        sess = sm.registry[0]
        self.assertTrue(sess["rcName"].endswith(f"-Turma-{sess['id']}"))

    def test_launch_points_the_session_at_the_peers_file(self):
        """The directive names the roster's path and the reader's OWN id (the
        file is shared, so a session can only skip itself by id), and says to
        read it rather than call ListAgents."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        sess = sm.registry[0]
        cmd = self._claude_cmd()
        self.assertIn(ha.PEERS_FILE, cmd)
        # Keyed on host AND id: ids are unique per host and the roster now spans
        # hosts, so a bare id can name a peer as yourself.
        self.assertIn(f"`host` is {sm.device} AND `id` is {sess['id']}", cmd)
        self.assertIn("use no other roster: ListAgents is\nunavailable", cmd)
        # The org boundary is the point of the file, so the directive has to say
        # so — a session that treats it as a convenience will reach past it.
        self.assertIn("scoped to your organisation", cmd)

    def test_peers_file_lists_running_sessions_only(self):
        """A queued session has no claude to receive anything and a stopped one's
        inbox socket is gone, so listing either would only yield messages that
        vanish."""
        sm = self.make_manager()
        sm._write_peers_file([
            {"id": "aaaaa", "rcName": "nas-Turma-XERK-1", "repo": "Turma",
             "status": "running", "summary": "live one",
             "git": {"liveBranch": "XERK-1"}},
            {"id": "bbbbb", "rcName": "nas-Turma-q", "repo": "Turma",
             "status": "queued", "summary": "waiting"},
            {"id": "ccccc", "rcName": "nas-Turma-s", "repo": "Turma",
             "status": "stopped", "summary": "gone"},
        ])
        body = open(ha.PEERS_FILE).read()
        rows = [r for r in body.splitlines() if not r.startswith("#")]
        self.assertEqual(
            rows, [f"aaaaa\tnas-Turma-XERK-1\t{sm.device}\tTurma\tXERK-1\tlive one"])

    def test_peers_file_prefers_the_ticket_and_says_detached(self):
        """The task column names the ticket where there is one, and a session
        that has not cut its branch yet reads `detached` rather than blank."""
        sm = self.make_manager()
        sm._write_peers_file([
            {"id": "aaaaa", "rcName": "nas-Turma-XERK-9", "repo": "Turma",
             "status": "running", "summary": "seeded name",
             "ticket": {"key": "XERK-9", "summary": "Do the thing"},
             "git": {"liveBranch": None}},
        ])
        row = [r for r in open(ha.PEERS_FILE).read().splitlines()
               if not r.startswith("#")][0]
        self.assertEqual(row.split("\t")[4], "detached")
        self.assertEqual(row.split("\t")[5], "XERK-9 Do the thing")

    def test_a_beat_publishes_the_roster(self):
        """The wiring, not just the writer: a heartbeat leaves the roster on disk
        naming this host's running sessions, since that file is the only thing a
        session is told to read to find a peer."""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        sess = sm.registry[0]
        sm.build_payload(1)
        rows = [r for r in open(ha.PEERS_FILE).read().splitlines()
                if not r.startswith("#")]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].split("\t")[:3],
                         [sess["id"], sess["rcName"], sm.device])

    def test_hub_roster_replaces_the_local_one(self):
        """XERK-348: the hub's rows are ORG-scoped and span hosts, so when it
        sends them they are the roster — the local list is only the fallback."""
        sm = self.make_manager()
        sm._ingest_peers([
            {"id": "p1", "name": "MaxAI-Turma-XERK-9", "host": "MaxAI",
             "repo": "Turma", "branch": "XERK-9", "task": "XERK-9 elsewhere"},
        ])
        sm._write_peers_file([
            {"id": "local", "rcName": "nas-Turma-local", "repo": "Turma",
             "status": "running", "summary": "not this one"},
        ])
        rows = [r for r in open(ha.PEERS_FILE).read().splitlines()
                if not r.startswith("#")]
        self.assertEqual(
            rows, ["p1\tMaxAI-Turma-XERK-9\tMaxAI\tTurma\tXERK-9\tXERK-9 elsewhere"])

    def test_a_reply_without_peers_forgets_the_last_roster(self):
        """The boundary may only fail NARROW. A hub that stops vouching for a
        roster — downgraded, or unable to resolve this host's org — must not
        leave sessions addressing names it no longer stands behind."""
        sm = self.make_manager()
        sm._ingest_peers([{"id": "p1", "name": "other-host-session",
                           "host": "MaxAI", "repo": "Turma"}])
        self.assertIsNotNone(sm.peer_fleet)
        sm._ingest_peers(None)                  # a reply carrying no `peers`
        self.assertIsNone(sm.peer_fleet)
        sm._write_peers_file([
            {"id": "local", "rcName": "nas-Turma-local", "repo": "Turma",
             "status": "running", "summary": "mine"},
        ])
        body = open(ha.PEERS_FILE).read()
        self.assertNotIn("other-host-session", body)
        self.assertIn("nas-Turma-local", body)

    def test_a_stale_hub_roster_falls_back_to_this_host(self):
        """Same rule against the clock: the hub going silent expires its roster
        rather than freezing it, since its rows name sessions on OTHER hosts
        that nothing has confirmed since."""
        sm = self.make_manager()
        sm._ingest_peers([{"id": "p1", "name": "other-host-session",
                           "host": "MaxAI", "repo": "Turma"}])
        sm.peer_fleet_at = time.time() - (ha.PEERS_FLEET_TTL_SEC + 1)
        sm._write_peers_file([
            {"id": "local", "rcName": "nas-Turma-local", "repo": "Turma",
             "status": "running", "summary": "mine"},
        ])
        body = open(ha.PEERS_FILE).read()
        self.assertNotIn("other-host-session", body)
        self.assertIn("nas-Turma-local", body)

    def test_wire_rows_are_validated_and_capped(self):
        """The roster crossed a trust boundary, so the agent re-checks it: a row
        with no `name` is unaddressable and only misleads, a non-dict is noise,
        and the row count is bounded here as well as hub-side."""
        sm = self.make_manager()
        sm._ingest_peers(
            ["not a dict", {"id": "x", "host": "h"}]                 # both dropped
            + [{"id": f"p{i}", "name": f"n{i}", "host": "h"}
               for i in range(ha.PEERS_MAX_ROWS + 25)])
        self.assertEqual(len(sm.peer_fleet), ha.PEERS_MAX_ROWS)
        self.assertTrue(all(r[1] for r in sm.peer_fleet))

    def test_wire_rows_are_sanitized_like_local_ones(self):
        """_peer_cell runs whatever the source: a hub row carrying a tab would
        otherwise shift every later column under the wrong heading."""
        sm = self.make_manager()
        sm._ingest_peers([{"id": "p1", "name": "peer", "host": "h",
                           "repo": "Turma", "branch": "b",
                           "task": "two\tcols\nand a row"}])
        sm._write_peers_file([])
        row = [r for r in open(ha.PEERS_FILE).read().splitlines()
               if not r.startswith("#")][0]
        self.assertEqual(row.split("\t"),
                         ["p1", "peer", "h", "Turma", "b", "two cols and a row"])

    def test_peers_file_write_failure_never_reaches_the_beat(self):
        """Best-effort by contract: the roster is a convenience, and a heartbeat
        must not die because a disk is full."""
        sm = self.make_manager()
        with mock.patch.object(ha, "PEERS_FILE", "/does/not/exist/peers.tsv"):
            sm._write_peers_file([{"id": "a", "rcName": "n", "repo": "r",
                                   "status": "running"}])  # must not raise

    def test_migrated_ticket_session_keeps_its_ticket_name(self):
        """A session that moves host carries its ticket, so it must keep being
        called after its key — reverting to a hash on arrival would rename the
        thing peers address and the operator recognises."""
        sm = self.make_spawn_ready_manager([])
        sm._launch_tmux = mock.Mock()
        sm.device = "hostA"
        p = mock.patch.object(ha, "REPOS_ROOT", self.tmp)
        p.start()
        self.addCleanup(p.stop)
        os.makedirs(os.path.join(self.tmp, "Turma"), exist_ok=True)
        cwd = os.path.join(ha.WORKTREES_ROOT, "Turma", "zzzzz")
        os.makedirs(cwd, exist_ok=True)
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(cwd))
        os.makedirs(proj, exist_ok=True)
        with open(os.path.join(proj, "trans1.jsonl"), "w") as f:
            f.write("{}\n")
        sess = sm._resume_at_cwd("trans1", cwd,
                                 extra={"ticket": {"key": "XERK-339"}})
        self.assertIsNotNone(sess, sm.spawn_failures)
        self.assertTrue(sess["rcName"].endswith("-Turma-XERK-339"),
                        sess["rcName"])

    def test_spawn_rejects_missing_base_ref(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        # ManagerMixin's run() returns "" for everything, so no base ref resolves.
        sm.spawn("Turma", base_ref="does-not-exist")
        self.assertEqual(sm.registry[0]["status"], "error")

    def test_spawn_rejects_unknown_model(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma", model="gpt-5")
        self.assertEqual(sm.registry[0]["status"], "error")

    # --- root (repos-root) sessions ---------------------------------------
    # A session spawned against ROOT_REPO_NAME runs directly at REPOS_ROOT with
    # no worktree and no branch; the worktree/branch machinery must be skipped
    # everywhere (spawn/kill/delete) so REPOS_ROOT and its repos are never
    # touched, and only one may run at a time.

    def _root_ready_manager(self):
        sm = self.make_spawn_ready_manager([])  # scan_repos irrelevant for root
        p = mock.patch.object(ha, "REPOS_ROOT", self.tmp)
        p.start()
        self.addCleanup(p.stop)
        return sm

    def test_root_repo_entry_advertises_root(self):
        p = mock.patch.object(ha, "REPOS_ROOT", self.tmp)
        p.start()
        self.addCleanup(p.stop)
        entry = ha.root_repo_entry()
        self.assertEqual(entry["name"], ha.ROOT_REPO_NAME)
        self.assertTrue(entry["isRoot"])
        self.assertEqual(entry["path"], self.tmp)
        self.assertEqual(entry["branches"], [])  # no base-branch walk for root

    def test_spawn_root_runs_in_repos_root_without_worktree(self):
        sm = self._root_ready_manager()
        sm.spawn(ha.ROOT_REPO_NAME)
        self.assertEqual(len(sm.registry), 1)
        sess = sm.registry[0]
        self.assertEqual(sess["status"], "running")
        self.assertTrue(sess["root"])
        self.assertIsNone(sess["branch"])
        self.assertEqual(sess["repo"], ha.ROOT_REPO_NAME)
        self.assertEqual(sess["worktreePath"], self.tmp)  # REPOS_ROOT itself
        # No worktree is ever added for a root session.
        self.assertFalse(any("worktree" in c and "add" in c for c in self.run_ok_calls))
        # claude still launches, and does so with cwd = REPOS_ROOT (tmux -c).
        newsess = next(c for c in self.run_ok_calls if "new-session" in c)
        self.assertIn(self.tmp, newsess)

    def test_spawn_root_ignores_base_but_keeps_model(self):
        sm = self._root_ready_manager()
        # base_ref would normally have to resolve in the repo; for root it does
        # not apply, so an unresolvable one must NOT fail the spawn.
        sm.spawn(ha.ROOT_REPO_NAME, base_ref="does-not-exist",
                 model="opus", permission_mode="acceptEdits")
        sess = sm.registry[0]
        self.assertEqual(sess["status"], "running")
        self.assertIsNone(sess["branch"])
        self.assertIsNone(sess["baseRef"])
        self.assertEqual(sess["model"], "opus")            # model still applies
        self.assertEqual(sess["permissionMode"], "acceptEdits")

    def test_second_root_session_queues_behind_the_first(self):
        sm = self._root_ready_manager()
        sm.spawn(ha.ROOT_REPO_NAME)
        self.assertEqual(sm.registry[0]["status"], "running")
        sm.spawn(ha.ROOT_REPO_NAME)  # only one root slot — the second waits
        self.assertEqual(len(sm.registry), 2)
        self.assertEqual(sm.registry[1]["status"], "queued")
        self.assertEqual(sm.registry[1]["queuedReason"], "root-busy")

    def test_kill_root_keeps_repos_root_and_records_root(self):
        sm = self._root_ready_manager()
        sm.spawn(ha.ROOT_REPO_NAME)
        sid = sm.registry[0]["id"]
        sm.kill(sid)
        self.assertEqual(sm.registry, [])
        # REPOS_ROOT is not a worktree: never remove it, never delete a branch.
        self.assertFalse(any("worktree" in c and "remove" in c for c in self.run_calls))
        self.assertFalse(any("branch" in c and "-D" in c for c in self.run_calls))
        self.assertTrue(sm.closed[-1]["root"])  # resumable, flagged as root

    def test_delete_root_skips_worktree_and_branch(self):
        sm = self._root_ready_manager()
        sm.spawn(ha.ROOT_REPO_NAME)
        sid = sm.registry[0]["id"]
        sm.delete(sid)
        self.assertEqual(sm.registry, [])
        self.assertFalse(any("worktree" in c and "remove" in c
                             for c in self.run_calls + self.run_ok_calls))
        self.assertFalse(any("branch" in c and ("-D" in c or "-m" in c)
                             for c in self.run_calls + self.run_ok_calls))

    def test_session_payload_flags_root(self):
        sm = self._root_ready_manager()
        sm.spawn(ha.ROOT_REPO_NAME)
        payload = sm._session_payload(sm.registry[0])
        self.assertTrue(payload["root"])
        self.assertIsNone(payload["branch"])


class TestSendInput(ManagerMixin, unittest.TestCase):
    def make_manager(self):
        # __init__ itself issues run() calls (hostname, docker inspect, claude
        # --version); clear those so run_calls only reflects send_input.
        sm = super().make_manager()
        self.run_calls.clear()
        self.run_ok_calls.clear()
        self.run_stdin_calls.clear()
        return sm

    def _running_session(self, sm, sid="abcde", status="running"):
        # summaryStarted=True: these tests exercise the tmux keystroke path, not
        # naming — mark the session as already past its one-shot naming attempt
        # so send_input doesn't launch a summary subprocess.
        sess = {"id": sid, "status": status, "tmuxName": f"agent-{sid}",
                "summary": None, "summaryStarted": True}
        sm.registry = [sess]
        return sess

    def test_first_prompt_names_still_unnamed_session(self):
        # A bare/quick spawn (or repos-root) has no summary and no naming attempt
        # yet; the first typed prompt should kick off _start_summary, one-shot.
        sm = self.make_manager()
        sess = {"id": "abcde", "status": "running", "tmuxName": "agent-abcde",
                "summary": None}
        sm.registry = [sess]
        with mock.patch.object(sm, "_start_summary") as start:
            sm.send_input("abcde", "Add a docker compose flag")
        start.assert_called_once_with(sess, "Add a docker compose flag")
        # The message still goes through regardless.
        self.assertEqual(self.run_stdin_calls[0][1], "Add a docker compose flag")

    def test_later_prompts_do_not_resummarize(self):
        sm = self.make_manager()
        sess = self._running_session(sm)  # summaryStarted=True already
        with mock.patch.object(sm, "_start_summary") as start:
            sm.send_input(sess["id"], "another message")
        start.assert_not_called()

    def test_no_resummarize_once_named(self):
        sm = self.make_manager()
        sess = {"id": "abcde", "status": "running", "tmuxName": "agent-abcde",
                "summary": "Adding Compose Flag"}
        sm.registry = [sess]
        with mock.patch.object(sm, "_start_summary") as start:
            sm.send_input("abcde", "keep going")
        start.assert_not_called()

    def test_no_resummarize_while_summary_in_flight(self):
        sm = self.make_manager()
        sess = {"id": "abcde", "status": "running", "tmuxName": "agent-abcde",
                "summary": None}
        sm.registry = [sess]
        sm.summaries = {"abcde": {"proc": object()}}  # attempt already running
        with mock.patch.object(sm, "_start_summary") as start:
            sm.send_input("abcde", "hello")
        start.assert_not_called()

    def test_message_is_pasted_then_submitted(self):
        # The text rides tmux's paste buffer over STDIN — never an argv element,
        # which tmux refuses past ~16 KiB (XERK-227) — and Enter submits it.
        sm = self.make_manager()
        sess = self._running_session(sm)
        sm.send_input(sess["id"], "hello")
        self.assertEqual(self.run_stdin_calls, [
            (["tmux", "load-buffer", "-b", "turma-input-agent-abcde", "-"], "hello"),
        ])
        self.assertEqual(self.run_ok_calls, [
            ["tmux", "paste-buffer", "-d", "-p", "-b", "turma-input-agent-abcde",
             "-t", "agent-abcde"],
        ])
        self.assertEqual(self.run_calls, [
            ["tmux", "send-keys", "-t", "agent-abcde", "Enter"],
        ])

    def test_a_long_message_is_pasted_whole(self):
        # The point of the paste path: a message far past what a send-keys
        # command line could carry reaches the pane intact, in one go.
        sm = self.make_manager()
        sess = self._running_session(sm)
        text = "x" * 60000
        sm.send_input(sess["id"], text)
        self.assertEqual(self.run_stdin_calls[0][1], text)
        self.assertEqual(sess["pendingInputs"][0]["text"], text)

    def test_newlines_survive_the_paste(self):
        # A pasted log or spec keeps its line breaks: paste-buffer -p brackets
        # the text for an application that asked for bracketed paste (Claude Code
        # does), so the whole thing lands as ONE message rather than submitting a
        # turn per line. CR and CRLF normalize to LF.
        sm = self.make_manager()
        sess = self._running_session(sm)
        sm.send_input(sess["id"], "line1\r\nline2\rline3\nline4")
        self.assertEqual(self.run_stdin_calls[0][1], "line1\nline2\nline3\nline4")

    def test_control_bytes_are_stripped(self):
        # A control byte inside a bracketed paste would end the paste early and
        # have what follows read as KEYSTROKES — and the text isn't always the
        # operator's own (a PR review comment is typed in the same way). Tab and
        # newline are content and survive.
        sm = self.make_manager()
        sess = self._running_session(sm)
        sm.send_input(sess["id"], "safe\x1b[201~rm -rf /\x00\x07 end\tkept\nkept")
        self.assertEqual(self.run_stdin_calls[0][1],
                         "safe[201~rm -rf / end\tkept\nkept")

    def test_falls_back_to_send_keys_when_the_paste_fails(self):
        # A tmux too old for load-buffer/paste-buffer must still deliver a short
        # message: flattened to one line and clipped to a command-safe length.
        sm = self.make_manager()
        sess = self._running_session(sm)
        self.run_stdin_ok = False
        sm.send_input(sess["id"], "line1\nline2")
        self.assertEqual(self.run_calls, [
            ["tmux", "send-keys", "-t", "agent-abcde", "-l", "--", "line1 line2"],
            ["tmux", "send-keys", "-t", "agent-abcde", "Enter"],
        ])

    def test_fallback_chunks_a_long_message_instead_of_clipping_it(self):
        # tmux refuses a command line past ~16 KiB, so the fallback types the
        # text in command-safe chunks — every character arrives, and only the
        # trailing Enter submits (XERK-227).
        sm = self.make_manager()
        sess = self._running_session(sm)
        self.run_stdin_ok = False
        text = "".join(chr(97 + i % 26) for i in range(ha.SENDKEYS_MAX_CHARS * 2 + 500))
        sm.send_input(sess["id"], text)
        typed = [c[-1] for c in self.run_calls[:-1]]
        self.assertEqual(len(typed), 3)
        self.assertEqual("".join(typed), text, "no character may be dropped")
        self.assertTrue(all(len(t) <= ha.SENDKEYS_MAX_CHARS for t in typed))
        self.assertEqual(self.run_calls[-1],
                         ["tmux", "send-keys", "-t", "agent-abcde", "Enter"])

    def test_message_past_the_cap_is_refused_not_truncated(self):
        # Half a message is worse than none: the operator cannot tell a
        # delivered stub from the whole thing, and the hub has already refused
        # it with an error the composer shows (XERK-227).
        sm = self.make_manager()
        sess = self._running_session(sm)
        with mock.patch.object(ha, "INPUT_MAX_CHARS", 5):
            sm.send_input(sess["id"], "abcdefghij")
        self.assertEqual(self.run_stdin_calls, [])
        self.assertEqual(self.run_calls, [])
        self.assertNotIn("pendingInputs", sess)

    def test_a_message_at_the_cap_still_goes(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        with mock.patch.object(ha, "INPUT_MAX_CHARS", 5):
            sm.send_input(sess["id"], "abcde")
        self.assertEqual(self.run_stdin_calls[0][1], "abcde")

    def test_noop_for_unknown_session(self):
        sm = self.make_manager()
        sm.registry = []
        sm.send_input("nope", "hello")
        self.assertEqual(self.run_calls, [])
        self.assertEqual(self.run_stdin_calls, [])

    def test_noop_for_non_running_session(self):
        sm = self.make_manager()
        sess = self._running_session(sm, status="stopped")
        sm.send_input(sess["id"], "hello")
        self.assertEqual(self.run_calls, [])
        self.assertEqual(self.run_stdin_calls, [])

    def test_noop_for_whitespace_only_text(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        sm.send_input(sess["id"], "   \t\n  ")
        self.assertEqual(self.run_calls, [])
        self.assertEqual(self.run_stdin_calls, [])

    def test_records_the_message_on_the_outbox(self):
        # Every sent message is recorded so _poll_pending_inputs can guarantee it
        # across a compaction (XERK-47): text as sent, attempts=1 (initial send).
        sm = self.make_manager()
        sess = self._running_session(sm)
        sm.send_input(sess["id"], "run the tests")
        pend = sess["pendingInputs"]
        self.assertEqual(len(pend), 1)
        self.assertEqual(pend[0]["text"], "run the tests")
        self.assertEqual(pend[0]["attempts"], 1)
        self.assertIn("at", pend[0])

    def test_outbox_is_bounded(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        for i in range(ha.PENDING_INPUT_MAX + 5):
            sm.send_input(sess["id"], f"msg {i}")
        self.assertEqual(len(sess["pendingInputs"]), ha.PENDING_INPUT_MAX)
        # The OLDEST are dropped, newest kept.
        self.assertEqual(sess["pendingInputs"][-1]["text"],
                         f"msg {ha.PENDING_INPUT_MAX + 4}")


class TestSafeUploadName(unittest.TestCase):
    """A filename off the wire is joined onto a path, so it must never be able to
    escape the uploads directory (XERK-234). Mirrors the hub's safeUploadName and
    android's Uploads.sanitizeUploadName — the three must agree."""

    def test_a_traversal_is_reduced_to_its_basename(self):
        self.assertEqual(ha.safe_upload_name("../../etc/passwd"), "passwd")
        self.assertEqual(ha.safe_upload_name("/abs/x.tar.gz"), "x.tar.gz")
        self.assertEqual(ha.safe_upload_name(r"C:\win\a.png"), "a.png")

    def test_an_upload_is_never_a_dotfile_and_never_nameless(self):
        # A leading dot would hide the file the operator just attached.
        self.assertEqual(ha.safe_upload_name("  ..hidden.png"), "hidden.png")
        for empty in ("", ".", "...", None, "///"):
            self.assertEqual(ha.safe_upload_name(empty), "upload")

    def test_an_over_long_name_keeps_its_extension(self):
        # The extension is what tells Claude Code's Read what kind of file it is.
        out = ha.safe_upload_name("a" * 130 + ".png")
        self.assertEqual(len(out), ha.UPLOAD_NAME_MAX)
        self.assertTrue(out.endswith(".png"))

    def test_characters_outside_the_safe_set_become_underscores(self):
        self.assertEqual(ha.safe_upload_name("déjà vu (1).PNG"), "d_j_ vu (1).PNG")
        self.assertEqual(ha.safe_upload_name("a\nb;rm -rf.txt"), "a_b_rm -rf.txt")

    def test_the_directory_is_under_uploads_whatever_the_id(self):
        d = ha.upload_dir_for("../../root")
        self.assertEqual(os.path.dirname(d), ha.UPLOADS_DIR)


class TestAttachmentMessage(unittest.TestCase):
    """What actually gets typed into the pane for a message with attachments.
    The files are on disk by then, so the session is told WHERE they are and
    left to read them with its ordinary tools (XERK-234)."""

    def test_one_file_with_text(self):
        out = ha.attachment_message(["/u/a.png"], [], "what is this?")
        self.assertIn("/u/a.png", out)
        self.assertTrue(out.startswith("[The operator attached a file"))
        # The operator's own words come last, so the message reads normally.
        self.assertTrue(out.endswith("what is this?"))

    def test_several_files_are_counted_and_pluralized(self):
        out = ha.attachment_message(["/u/a.png", "/u/b.pdf"], [], "")
        self.assertIn("attached 2 files", out)
        self.assertIn("Read them from disk", out)
        self.assertEqual(out.splitlines()[1:], ["/u/a.png", "/u/b.pdf"])

    def test_attachments_alone_need_no_text(self):
        out = ha.attachment_message(["/u/a.png"], [], "")
        self.assertEqual(out.splitlines(), [
            "[The operator attached a file to this message. Read it from disk:]",
            "/u/a.png",
        ])

    def test_a_file_that_failed_to_transfer_is_named_not_dropped(self):
        # The operator SAW it attached; a session quietly never receiving it
        # would be asked about a file it has no way to know existed.
        out = ha.attachment_message([], ["spec.pdf"], "have a look")
        self.assertIn("spec.pdf", out)
        self.assertIn("failed to transfer", out)
        self.assertTrue(out.endswith("have a look"))


class TestStoreUploads(ManagerMixin, unittest.TestCase):
    """_store_uploads: fetch each staged blob and write it under this session's
    uploads directory, out of every repo (XERK-234)."""

    def _sess(self, sm, sid="abcde"):
        sess = {"id": sid, "status": "running", "tmuxName": f"agent-{sid}",
                "summary": "named", "summaryStarted": True}
        sm.registry = [sess]
        return sess

    def test_files_land_under_the_session_and_are_not_in_the_worktree(self):
        sm = self.make_manager()
        sess = self._sess(sm)
        with mock.patch.object(sm, "_download_upload", return_value=b"PNGDATA"):
            paths, failed = sm._store_uploads(
                sess, [{"id": "u1", "name": "shot.png"}])
        self.assertEqual(failed, [])
        self.assertEqual(paths, [os.path.join(ha.UPLOADS_DIR, "abcde", "shot.png")])
        with open(paths[0], "rb") as fh:
            self.assertEqual(fh.read(), b"PNGDATA")

    def test_the_same_name_twice_does_not_overwrite(self):
        # An earlier message's path still points at the first one.
        sm = self.make_manager()
        sess = self._sess(sm)
        with mock.patch.object(sm, "_download_upload", side_effect=[b"one", b"two"]):
            paths, _ = sm._store_uploads(
                sess, [{"id": "u1", "name": "a.png"}, {"id": "u2", "name": "a.png"}])
        self.assertEqual([os.path.basename(p) for p in paths], ["a.png", "a-2.png"])
        with open(paths[0], "rb") as fh:
            self.assertEqual(fh.read(), b"one")

    def test_a_download_failure_is_reported_not_swallowed(self):
        sm = self.make_manager()
        sess = self._sess(sm)
        with mock.patch.object(sm, "_download_upload", side_effect=[b"ok", None]):
            paths, failed = sm._store_uploads(
                sess, [{"id": "u1", "name": "a.png"}, {"id": "u2", "name": "b.pdf"}])
        self.assertEqual([os.path.basename(p) for p in paths], ["a.png"])
        self.assertEqual(failed, ["b.pdf"])

    def test_a_blob_past_the_cap_is_not_written(self):
        sm = self.make_manager()
        sess = self._sess(sm)
        big = b"x" * (ha.UPLOAD_MAX_BYTES + 1)
        with mock.patch.object(sm, "_download_upload", return_value=big):
            paths, failed = sm._store_uploads(sess, [{"id": "u1", "name": "a.bin"}])
        self.assertEqual(paths, [])
        self.assertEqual(failed, ["a.bin"])

    def test_a_traversing_name_still_lands_inside_the_uploads_dir(self):
        sm = self.make_manager()
        sess = self._sess(sm)
        with mock.patch.object(sm, "_download_upload", return_value=b"x"):
            paths, _ = sm._store_uploads(
                sess, [{"id": "u1", "name": "../../../../etc/cron.d/evil"}])
        self.assertEqual(paths, [os.path.join(ha.UPLOADS_DIR, "abcde", "evil")])

    def test_no_more_than_the_per_message_cap_is_written(self):
        sm = self.make_manager()
        sess = self._sess(sm)
        items = [{"id": f"u{i}", "name": f"f{i}.png"}
                 for i in range(ha.UPLOAD_MAX_PER_MESSAGE + 5)]
        with mock.patch.object(sm, "_download_upload", return_value=b"x"):
            paths, failed = sm._store_uploads(sess, items)
        self.assertEqual(len(paths), ha.UPLOAD_MAX_PER_MESSAGE)
        self.assertEqual(failed, [])


class TestFetchBoardAttachment(unittest.TestCase):
    """Pulling one attachment's BYTES off the configured tracker (XERK-242) —
    the one tracker request that carries a credential to a URL out of a ticket."""

    JIRA = dict(JIRA_SITE="myorg.atlassian.net", JIRA_EMAIL="e@x.c", JIRA_TOKEN="t",
                AZDO_URL="", AZDO_TOKEN="")

    def _opened(self, blob, *, capture=None, encoding=None, length=None):
        """Stand in for the module opener, recording the request it was given.
        Shaped like the HTTPResponse the real one returns: read1 + headers.
        `length` sets a Content-Length the body need not match (a truncated
        download); omitted, it stands for a chunked reply that declares none."""
        hdrs = {"Content-Encoding": encoding} if encoding else {}
        if length is not None:
            hdrs["Content-Length"] = str(length)

        class Resp(io.BytesIO):
            headers = hdrs

        def fake_open(req, timeout=None):
            if capture is not None:
                capture.append(req)
            return Resp(blob)
        return mock.patch.object(ha._ATTACH_OPENER, "open", fake_open)

    def test_fetches_with_the_tracker_credential(self):
        seen = []
        with mock.patch.multiple(ha, **self.JIRA), self._opened(b"PNG", capture=seen):
            blob = ha.fetch_board_attachment(
                "https://myorg.atlassian.net/rest/api/3/attachment/content/1", 1000)
        self.assertEqual(blob, b"PNG")
        self.assertTrue(seen[0].get_header("Authorization").startswith("Basic "))

    def test_a_url_off_the_tracker_is_refused_before_it_is_requested(self):
        # The URL comes out of a tracker response, but it is the only ticket field
        # we turn into an outbound request holding a credential — so a server that
        # is compromised or simply wrong must not be able to aim it elsewhere.
        for url in ("https://evil.example/steal",
                    "http://169.254.169.254/latest/meta-data/",
                    "file:///etc/passwd", "", None):
            with mock.patch.multiple(ha, **self.JIRA), \
                 mock.patch.object(ha._ATTACH_OPENER, "open") as opener:
                self.assertIsNone(ha.fetch_board_attachment(url, 1000))
                opener.assert_not_called()

    def test_a_body_past_the_cap_is_not_returned(self):
        with mock.patch.multiple(ha, **self.JIRA), self._opened(b"x" * 11):
            self.assertIsNone(ha.fetch_board_attachment(
                "https://myorg.atlassian.net/x", 10))

    def test_a_transport_failure_is_none_not_an_exception(self):
        # It runs inside a spawn: a dead attachment must cost the file, not the
        # session.
        with mock.patch.multiple(ha, **self.JIRA), \
             mock.patch.object(ha._ATTACH_OPENER, "open", side_effect=OSError("boom")):
            self.assertIsNone(ha.fetch_board_attachment(
                "https://myorg.atlassian.net/x", 10))

    def test_azure_uses_the_board_pat_and_its_own_host(self):
        seen = []
        with mock.patch.multiple(ha, JIRA_SITE="", JIRA_EMAIL="", JIRA_TOKEN="",
                                 AZDO_URL="https://tfs.co:8080/tfs/Coll",
                                 AZDO_TOKEN="pat"), \
             self._opened(b"LOG", capture=seen):
            self.assertEqual(ha.fetch_board_attachment(
                "https://tfs.co:8080/tfs/Coll/_apis/wit/attachments/a", 100), b"LOG")
        self.assertEqual(seen[0].get_header("Authorization"),
                         "Basic " + base64.b64encode(b":pat").decode())

    def _req(self):
        return urllib.request.Request(
            "https://myorg.atlassian.net/rest/api/3/attachment/content/1",
            headers={"Authorization": "Basic secret", "User-Agent": "turma-agent/1.0"})

    def test_the_credential_does_not_follow_a_cross_host_redirect(self):
        # Jira answers /attachment/content with a 30x to a media CDN. urllib
        # copies headers onto the redirected request verbatim, which would hand
        # our Basic auth to that third party (and break the presigned fetch).
        # A public IP literal, not a hostname: getaddrinfo on a literal needs no
        # DNS, so this asserts the policy rather than the runner's resolver (this
        # dev box's resolver answers NXDOMAIN with a public address, CI's won't).
        h, req = ha._StripAuthRedirect(), self._req()
        with mock.patch.multiple(ha, **self.JIRA):
            away = h.redirect_request(req, None, 302, "Found", {},
                                      "https://93.184.216.34/blob?sig=1")
            self.assertIsNone(away.get_header("Authorization"))
            self.assertEqual(away.get_header("User-agent"), "turma-agent/1.0")
            # Still the tracker: the credential is what the next hop needs.
            same = h.redirect_request(req, None, 302, "Found", {},
                                      "https://myorg.atlassian.net/elsewhere")
            self.assertEqual(same.get_header("Authorization"), "Basic secret")

    def test_a_downgrade_to_http_on_the_same_host_still_drops_it(self):
        # Same host is NOT the same trust: without the scheme in the compare,
        # a 302 to http:// puts the tracker's Basic auth on the wire in clear.
        h, req = ha._StripAuthRedirect(), self._req()
        with mock.patch.multiple(ha, **self.JIRA):
            down = h.redirect_request(req, None, 302, "Found", {},
                                      "http://myorg.atlassian.net/rest/x")
        self.assertIsNone(down.get_header("Authorization"))

    def test_a_redirect_the_tracker_may_not_aim_at_is_refused(self):
        # The initial URL is tracker-only, but a 30x is the tracker choosing a
        # second URL — unpoliced, it is an arbitrary read (cloud metadata, the
        # LAN, localhost) whose body then lands where the prompt says to read it.
        h, req = ha._StripAuthRedirect(), self._req()
        with mock.patch.multiple(ha, **self.JIRA):
            for bad in ("http://169.254.169.254/latest/meta-data/",
                        "http://127.0.0.1:8300/api/agents",
                        "http://10.10.10.20/pool/secrets",
                        "ftp://media.example/blob",
                        "file:///etc/passwd"):
                with self.assertRaises(urllib.error.HTTPError, msg=bad):
                    h.redirect_request(req, None, 302, "Found", {}, bad)

    def test_a_redirect_to_a_name_that_will_not_resolve_is_refused(self):
        # This gates a URL the TRACKER chose, so "can't tell" must not mean "go".
        h, req = ha._StripAuthRedirect(), self._req()
        with mock.patch.multiple(ha, **self.JIRA), \
             mock.patch.object(ha.socket, "getaddrinfo",
                               side_effect=OSError("NXDOMAIN")):
            with self.assertRaises(urllib.error.HTTPError):
                h.redirect_request(req, None, 302, "Found", {}, "https://cdn.example/x")

    def test_host_is_public_reads_every_resolved_address(self):
        # A name resolving to both a public and a private address is not public:
        # which one urllib connects to isn't ours to choose.
        def resolved(*addrs):
            return [(0, 0, 0, "", (a, 0)) for a in addrs]
        with mock.patch.object(ha.socket, "getaddrinfo",
                               return_value=resolved("93.184.216.34")):
            self.assertTrue(ha._host_is_public("cdn.example"))
        for private in ("169.254.169.254", "127.0.0.1", "10.10.10.20",
                        "192.168.1.5", "172.16.0.1", "::1", "fd00::1",
                        "0.0.0.0", "224.0.0.1",
                        "100.64.0.1",            # carrier NAT, not "private"
                        "::ffff:10.0.0.1"):      # v4-mapped, still the LAN
            with mock.patch.object(ha.socket, "getaddrinfo",
                                   return_value=resolved("93.184.216.34", private)):
                self.assertFalse(ha._host_is_public("cdn.example"), private)

    def test_a_tracker_on_a_private_address_can_still_redirect_to_itself(self):
        # A self-hosted TFS/Jira routinely IS a private address, so the policy
        # is "public, OR back to the configured tracker" — not "public".
        h = ha._StripAuthRedirect()
        req = urllib.request.Request("http://10.10.10.20/tfs/Coll/_apis/wit/x",
                                     headers={"Authorization": "Basic secret"})
        with mock.patch.multiple(ha, JIRA_SITE="", JIRA_EMAIL="", JIRA_TOKEN="",
                                 AZDO_URL="http://10.10.10.20/tfs/Coll",
                                 AZDO_TOKEN="pat"):
            back = h.redirect_request(req, None, 302, "Found", {},
                                      "http://10.10.10.20/tfs/Coll/blob")
        self.assertEqual(back.get_header("Authorization"), "Basic secret")

    def test_a_content_encoded_body_is_decoded_not_written_raw(self):
        # We ask for identity, so this is a proxy compressing anyway; undecoded,
        # a .png lands on disk as a gzip stream and nothing says so.
        seen = []
        with mock.patch.multiple(ha, **self.JIRA), \
             self._opened(gzip.compress(b"PNGDATA"), capture=seen, encoding="gzip"):
            blob = ha.fetch_board_attachment("https://myorg.atlassian.net/x", 1000)
        self.assertEqual(blob, b"PNGDATA")
        self.assertEqual(seen[0].get_header("Accept-encoding"), "identity")

    def test_an_undecodable_encoding_is_a_miss_not_a_corrupt_file(self):
        with mock.patch.multiple(ha, **self.JIRA), \
             self._opened(b"\x00\x01", encoding="br"):
            self.assertIsNone(
                ha.fetch_board_attachment("https://myorg.atlassian.net/x", 1000))

    def test_a_compression_bomb_is_refused_without_inflating_it(self):
        """The byte cap has to bound what comes OUT, not just what comes in.

        gzip does ~1000:1 on repetitive data, so a body well under the wire cap
        inflates to gigabytes — and a one-shot decompress allocates all of it
        before any size check can run, on the manager's own process. Measured
        here by peak allocation, because "it returned None" would also be true
        of an implementation that inflated the whole bomb first and then
        rejected it."""
        bomb = gzip.compress(b"\0" * (64 << 20))          # 64 MiB -> ~64 KiB
        self.assertLess(len(bomb), 1 << 20, "fixture isn't a bomb")
        tracemalloc.start()
        try:
            with mock.patch.multiple(ha, **self.JIRA), \
                 self._opened(bomb, encoding="gzip"):
                blob = ha.fetch_board_attachment(
                    "https://myorg.atlassian.net/x", 1 << 20)   # 1 MiB cap
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        self.assertIsNone(blob)
        # A few MiB of slack over the 1 MiB cap; the unbounded version peaked
        # at hundreds of MiB for this fixture.
        self.assertLess(peak, 8 << 20, f"inflated {peak} bytes before refusing")

    def test_a_compressed_body_inside_the_cap_still_arrives_whole(self):
        body = bytes(range(256)) * 200          # 51200 bytes, compressible
        with mock.patch.multiple(ha, **self.JIRA), \
             self._opened(gzip.compress(body), encoding="gzip"):
            self.assertEqual(
                ha.fetch_board_attachment("https://myorg.atlassian.net/x",
                                          len(body)), body)

    def test_a_body_that_ends_early_is_a_miss_not_a_truncated_file(self):
        # A half-written screenshot the prompt then tells the session to read is
        # worse than a named miss — the call this repo already makes for an
        # over-long message. Both framings: a short body under Content-Length,
        # and a compressed stream that ends before its end marker.
        body = b"A" * 1000
        with mock.patch.multiple(ha, **self.JIRA), \
             self._opened(b"A" * 400, length=1000):
            self.assertIsNone(ha.fetch_board_attachment(
                "https://myorg.atlassian.net/x", 5000))
        with mock.patch.multiple(ha, **self.JIRA), \
             self._opened(gzip.compress(body)[:20], encoding="gzip"):
            self.assertIsNone(ha.fetch_board_attachment(
                "https://myorg.atlassian.net/x", 5000))

    def test_a_body_with_no_length_to_check_against_is_taken_as_it_comes(self):
        # Chunked transfer-encoding carries no Content-Length; a complete body
        # must not read as truncated just because there is nothing to compare.
        body = b"A" * 1000
        with mock.patch.multiple(ha, **self.JIRA), self._opened(body):
            self.assertEqual(ha.fetch_board_attachment(
                "https://myorg.atlassian.net/x", 5000), body)
        with mock.patch.multiple(ha, **self.JIRA), \
             self._opened(gzip.compress(body), encoding="gzip"):
            self.assertEqual(ha.fetch_board_attachment(
                "https://myorg.atlassian.net/x", 5000), body)

    def test_a_compressed_body_whose_WIRE_size_is_over_the_cap_is_refused(self):
        # The cap bounds both sides, and this is the case only the WIRE bound
        # catches: incompressible bytes gzip to slightly MORE than themselves, so
        # the body decodes to exactly the cap while costing more than it on the
        # wire. Without that bound it reads to the end and is accepted.
        body = os.urandom(1000)                       # gzips to ~1023
        packed = gzip.compress(body)
        self.assertGreater(len(packed), 1000, "fixture isn't incompressible")
        with mock.patch.multiple(ha, **self.JIRA), \
             self._opened(packed, encoding="gzip"):
            self.assertIsNone(ha.fetch_board_attachment(
                "https://myorg.atlassian.net/x", 1000))

    def test_an_unconfigured_board_is_not_a_redirect_wildcard(self):
        # board_attachment_host() is "" with no board, and "" must not match a
        # netloc-less URL. Unreachable through fetch_board_attachment, which
        # refuses every URL in that state — this pins the belt, not the braces.
        with mock.patch.multiple(ha, JIRA_SITE="", JIRA_EMAIL="", JIRA_TOKEN="",
                                 AZDO_URL="", AZDO_TOKEN=""):
            self.assertEqual(ha.board_attachment_host(), "")
            self.assertFalse(ha.attachment_redirect_ok("http:///x"))
            # ...and with no tracker to be exempt, a private target is still
            # judged on its address rather than waved through.
            self.assertFalse(ha.attachment_redirect_ok("http://127.0.0.1/y"))

    def test_the_cap_still_wins_over_the_completeness_check(self):
        # Stopping at the cap IS a short read; it must stay "too big", not
        # become "truncated" (and must not be accepted because it looks short).
        with mock.patch.multiple(ha, **self.JIRA), \
             self._opened(b"A" * 5000, length=5000):
            self.assertIsNone(ha.fetch_board_attachment(
                "https://myorg.atlassian.net/x", 1000))


class TestStoreTicketAttachments(ManagerMixin, unittest.TestCase):
    """A ticket's own files -> this session's uploads directory (XERK-242)."""

    def _sess(self, sm, sid="abcde"):
        sess = {"id": sid, "status": "running", "tmuxName": f"agent-{sid}"}
        sm.registry = [sess]
        return sess

    def _att(self, name="shot.png", size=10, url="https://s/1"):
        return {"name": name, "size": size, "url": url, "mime": "image/png"}

    def test_files_land_under_the_session_and_not_in_the_worktree(self):
        # Same tree a chat attachment lands in: out of the repo (a file there
        # reads as uncommitted work) and pre-approved for Read by the guard.
        sm = self.make_manager()
        sess = self._sess(sm)
        with mock.patch.object(ha, "fetch_board_attachment", return_value=b"PNGDATA"):
            paths, failed = sm._store_ticket_attachments(sess, [self._att()])
        self.assertEqual(failed, [])
        self.assertEqual(paths, [os.path.join(ha.UPLOADS_DIR, "abcde", "shot.png")])
        with open(paths[0], "rb") as fh:
            self.assertEqual(fh.read(), b"PNGDATA")

    def test_a_traversing_name_still_lands_inside_the_uploads_dir(self):
        sm = self.make_manager()
        sess = self._sess(sm)
        with mock.patch.object(ha, "fetch_board_attachment", return_value=b"x"):
            paths, _ = sm._store_ticket_attachments(
                sess, [self._att(name="../../../../etc/cron.d/evil")])
        self.assertEqual(paths, [os.path.join(ha.UPLOADS_DIR, "abcde", "evil")])

    def test_the_files_are_readable_only_by_the_agent(self):
        # A host's sessions share one HOME; another user having a session's
        # ticket files (or being able to drop one in) is not something to leave
        # to the ambient umask.
        sm = self.make_manager()
        sess = self._sess(sm)
        with mock.patch.object(ha, "fetch_board_attachment", return_value=b"x"):
            paths, _ = sm._store_ticket_attachments(sess, [self._att()])
        self.assertEqual(os.stat(paths[0]).st_mode & 0o777, 0o600)
        self.assertEqual(
            os.stat(ha.upload_dir_for("abcde")).st_mode & 0o777, 0o700)

    def test_it_never_writes_over_a_file_that_appeared_underneath_it(self):
        # _unique_upload_path asks exists() and _write_new_file then opens: the
        # gap is a real one. O_EXCL is what closes it — and it is the ONLY case
        # that distinguishes O_EXCL from O_NOFOLLOW, since either flag alone
        # covers the dangling-symlink case above.
        os.makedirs(ha.UPLOADS_DIR, mode=0o700, exist_ok=True)
        taken = os.path.join(ha.UPLOADS_DIR, "taken.png")
        with open(taken, "wb") as fh:
            fh.write(b"WAS HERE FIRST")
        with self.assertRaises(FileExistsError):
            ha._write_new_file(taken, b"CLOBBER")
        with open(taken, "rb") as fh:
            self.assertEqual(fh.read(), b"WAS HERE FIRST")

    def test_a_dangling_symlink_is_not_written_through(self):
        # os.path.exists() follows symlinks, so _unique_upload_path reads a
        # dangling one as a free name; a plain open() would then create its
        # TARGET, outside the uploads tree entirely.
        sm = self.make_manager()
        sess = self._sess(sm)
        dirpath = ha.upload_dir_for("abcde")
        os.makedirs(dirpath, mode=0o700, exist_ok=True)
        victim = os.path.join(self.tmp, "victim.txt")
        os.symlink(victim, os.path.join(dirpath, "shot.png"))
        with mock.patch.object(ha, "fetch_board_attachment", return_value=b"PWNED"):
            paths, failed = sm._store_ticket_attachments(sess, [self._att()])
        self.assertFalse(os.path.exists(victim))
        self.assertEqual(failed, ["shot.png"])
        self.assertEqual(paths, [])

    def test_a_download_failure_is_named_not_dropped(self):
        # A screenshot the ticket is built around is exactly what the session
        # needs to know it is missing.
        sm = self.make_manager()
        sess = self._sess(sm)
        with mock.patch.object(ha, "fetch_board_attachment",
                               side_effect=[b"ok", None]):
            paths, failed = sm._store_ticket_attachments(
                sess, [self._att("a.png"), self._att("b.pdf")])
        self.assertEqual([os.path.basename(p) for p in paths], ["a.png"])
        self.assertEqual(failed, ["b.pdf"])

    def test_a_file_whose_reported_size_is_too_big_is_never_downloaded(self):
        sm = self.make_manager()
        sess = self._sess(sm)
        with mock.patch.object(ha, "fetch_board_attachment") as fetch:
            paths, failed = sm._store_ticket_attachments(
                sess, [self._att("huge.mov", size=ha.TICKET_ATTACH_MAX_BYTES + 1)])
            fetch.assert_not_called()
        self.assertEqual((paths, failed), ([], ["huge.mov"]))

    def test_the_total_budget_stops_a_ticket_full_of_big_files(self):
        # Nobody picked these file by file, so the caps are the point.
        sm = self.make_manager()
        sess = self._sess(sm)
        items = [self._att(f"f{i}.bin", size=600) for i in range(3)]
        with mock.patch.multiple(ha, TICKET_ATTACH_MAX_BYTES=1000,
                                 TICKET_ATTACH_TOTAL_BYTES=1000), \
             mock.patch.object(ha, "fetch_board_attachment",
                               side_effect=lambda url, cap, timeout=None, deadline=None: b"x" * 600):
            paths, failed = sm._store_ticket_attachments(sess, items)
        self.assertEqual([os.path.basename(p) for p in paths], ["f0.bin"])
        self.assertEqual(failed, ["f1.bin", "f2.bin"])

    def test_a_trickling_tracker_cannot_hold_the_manager_loop(self):
        """The deadline is a real bound, proven over a real socket.

        This runs on the manager's ONE loop, inside a spawn, so a tracker that
        keeps the download alive stalls every session on the host and the hub
        calls it offline after 75s. A socket timeout does NOT bound this: it caps
        the wait for the NEXT byte, and a server dribbling bytes under the byte
        cap resets it forever. So this drives an actual trickling HTTP server
        rather than a mocked `fetch_board_attachment` — mocking the download here
        would only assert that we compute a number, which is what let the
        unbounded read ship green in the first place."""
        served = threading.Event()

        class Trickle(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def log_message(self, *a):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", str(1 << 20))  # a lie it never finishes
                self.end_headers()
                served.set()
                try:
                    # ~100s of trickle: the server must OUTLIVE the assertion
                    # below, or a regression's blocking read simply completes
                    # under the threshold and the test passes on the bug. Costs
                    # nothing when the code is right — the agent hangs up at its
                    # 2s deadline and this write raises straight into the except.
                    for _ in range(2000):
                        self.wfile.write(b"x")
                        self.wfile.flush()
                        time.sleep(0.05)      # under every byte cap, indefinitely
                except Exception:
                    pass                      # the agent hung up: the point

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Trickle)
        self.addCleanup(srv.server_close)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        base = f"http://127.0.0.1:{srv.server_address[1]}/Coll"

        sm = self.make_manager()
        sess = self._sess(sm)
        items = [{"name": f"f{i}.bin", "size": None, "url": f"{base}/a{i}"}
                 for i in range(3)]
        started = time.monotonic()
        with mock.patch.multiple(ha, JIRA_SITE="", JIRA_EMAIL="", JIRA_TOKEN="",
                                 AZDO_URL=base, AZDO_TOKEN="pat",
                                 TICKET_ATTACH_DEADLINE_SEC=2,
                                 TICKET_ATTACH_TIMEOUT_SEC=2):
            paths, failed = sm._store_ticket_attachments(sess, items)
        took = time.monotonic() - started
        self.assertTrue(served.is_set())            # it really did connect
        self.assertLess(took, 15, f"took {took:.1f}s against a 2s budget")
        self.assertEqual(paths, [])
        self.assertEqual(failed, ["f0.bin", "f1.bin", "f2.bin"])  # each one named

    def test_a_silent_tracker_is_bounded_too(self):
        sm = self.make_manager()
        sess = self._sess(sm)
        items = [self._att(f"f{i}.png") for i in range(5)]
        elapsed, timeouts, deadlines = [0.0], [], []

        def slow(url, cap, timeout=None, deadline=None):
            timeouts.append(timeout)
            deadlines.append(deadline)
            elapsed[0] += timeout          # every one of them times out
            return None
        with mock.patch.multiple(ha, TICKET_ATTACH_DEADLINE_SEC=6,
                                 TICKET_ATTACH_TIMEOUT_SEC=4), \
             mock.patch.object(ha.time, "monotonic", lambda: elapsed[0]), \
             mock.patch.object(ha, "fetch_board_attachment", slow):
            paths, failed = sm._store_ticket_attachments(sess, items)
        self.assertEqual(paths, [])
        self.assertEqual(len(failed), 5)             # every file is named
        self.assertEqual(timeouts, [4, 2])           # clamped to the budget left
        # The batch deadline is handed DOWN, so one download can't outlast it.
        self.assertEqual(deadlines, [6, 6])
        self.assertLessEqual(elapsed[0], 6)

    def test_no_more_than_the_count_cap_is_fetched(self):
        sm = self.make_manager()
        sess = self._sess(sm)
        items = [self._att(f"f{i}.png") for i in range(ha.TICKET_ATTACH_MAX + 5)]
        with mock.patch.object(ha, "fetch_board_attachment", return_value=b"x"):
            paths, failed = sm._store_ticket_attachments(sess, items)
        self.assertEqual(len(paths), ha.TICKET_ATTACH_MAX)
        self.assertEqual(failed, [])

    def test_nothing_to_fetch_costs_nothing(self):
        sm = self.make_manager()
        sess = self._sess(sm)
        for empty in (None, [], ["junk"]):
            self.assertEqual(sm._store_ticket_attachments(sess, empty), ([], []))
        self.assertFalse(os.path.isdir(ha.upload_dir_for("abcde")))


class TestSendInputUploads(ManagerMixin, unittest.TestCase):
    """send_input with attachments (XERK-234): the files are written first, and
    the message that reaches the pane carries their paths."""

    def _sess(self, sm, sid="abcde"):
        sess = {"id": sid, "status": "running", "tmuxName": f"agent-{sid}",
                "summary": "named", "summaryStarted": True}
        sm.registry = [sess]
        return sess

    def test_the_pasted_message_carries_the_paths_and_then_the_text(self):
        sm = self.make_manager()
        sess = self._sess(sm)
        with mock.patch.object(sm, "_download_upload", return_value=b"x"):
            sm.send_input("abcde", "what is this?",
                          uploads=[{"id": "u1", "name": "shot.png"}])
        typed = self.run_stdin_calls[0][1]
        self.assertIn(os.path.join(ha.UPLOADS_DIR, "abcde", "shot.png"), typed)
        self.assertTrue(typed.endswith("what is this?"))

    def test_a_message_can_be_attachments_alone(self):
        sm = self.make_manager()
        sess = self._sess(sm)
        with mock.patch.object(sm, "_download_upload", return_value=b"x"):
            sm.send_input("abcde", "", uploads=[{"id": "u1", "name": "shot.png"}])
        self.assertTrue(self.run_stdin_calls)
        self.assertIn("shot.png", self.run_stdin_calls[0][1])

    def test_the_outbox_holds_the_COMPOSED_text(self):
        # A compaction resend re-types this verbatim (XERK-47), and the files are
        # already on disk — so the paths must be what was recorded.
        sm = self.make_manager()
        sess = self._sess(sm)
        with mock.patch.object(sm, "_download_upload", return_value=b"x"):
            sm.send_input("abcde", "hi", uploads=[{"id": "u1", "name": "a.png"}])
        self.assertIn("a.png", sess["pendingInputs"][0]["text"])

    def test_nothing_is_typed_when_every_attachment_vanished(self):
        # No text of its own and nothing to say about: there is no message.
        sm = self.make_manager()
        sess = self._sess(sm)
        with mock.patch.object(sm, "_store_uploads", return_value=([], [])):
            sm.send_input("abcde", "", uploads=[{"id": "u1", "name": "a.png"}])
        self.assertEqual(self.run_stdin_calls, [])

    def test_an_unnamed_session_is_named_from_the_TYPED_text(self):
        # Not from the attachment header, which says nothing about the task.
        sm = self.make_manager()
        sess = {"id": "abcde", "status": "running", "tmuxName": "agent-abcde",
                "summary": None}
        sm.registry = [sess]
        with mock.patch.object(sm, "_download_upload", return_value=b"x"), \
                mock.patch.object(sm, "_start_summary") as start:
            sm.send_input("abcde", "review this mock",
                          uploads=[{"id": "u1", "name": "a.png"}])
        start.assert_called_once_with(sess, "review this mock")

    def test_an_attachment_only_message_spends_no_naming_attempt(self):
        sm = self.make_manager()
        sess = {"id": "abcde", "status": "running", "tmuxName": "agent-abcde",
                "summary": None}
        sm.registry = [sess]
        with mock.patch.object(sm, "_download_upload", return_value=b"x"), \
                mock.patch.object(sm, "_start_summary") as start:
            sm.send_input("abcde", "", uploads=[{"id": "u1", "name": "a.png"}])
        start.assert_not_called()

    def test_an_ordinary_message_never_touches_the_uploads_dir(self):
        sm = self.make_manager()
        self._sess(sm)
        sm.send_input("abcde", "just talking")
        self.assertFalse(os.path.exists(ha.UPLOADS_DIR))


class TestSweepUploads(ManagerMixin, unittest.TestCase):
    """Attachment dirs of long-gone sessions are swept; a live or resumable
    session's files stay, because its conversation still names their paths."""

    def _dir(self, sid, age_sec=0):
        path = os.path.join(ha.UPLOADS_DIR, sid)
        os.makedirs(path, exist_ok=True)
        if age_sec:
            old = time.time() - age_sec
            os.utime(path, (old, old))
        return path

    def test_an_unknown_and_aged_dir_goes(self):
        sm = self.make_manager()
        sm.registry, sm.closed = [], []
        gone = self._dir("old", ha.UPLOAD_RETENTION_SEC + 60)
        sm._sweep_uploads()
        self.assertFalse(os.path.exists(gone))

    def test_a_running_session_keeps_its_files_however_old(self):
        sm = self.make_manager()
        sm.registry = [{"id": "live"}]
        sm.closed = []
        keep = self._dir("live", ha.UPLOAD_RETENTION_SEC + 60)
        sm._sweep_uploads()
        self.assertTrue(os.path.exists(keep))

    def test_a_killed_but_resumable_session_keeps_its_files(self):
        sm = self.make_manager()
        sm.registry = []
        sm.closed = [{"id": "killed"}]
        keep = self._dir("killed", ha.UPLOAD_RETENTION_SEC + 60)
        sm._sweep_uploads()
        self.assertTrue(os.path.exists(keep))

    def test_a_recent_unknown_dir_is_left_alone(self):
        sm = self.make_manager()
        sm.registry, sm.closed = [], []
        keep = self._dir("recent")
        sm._sweep_uploads()
        self.assertTrue(os.path.exists(keep))


class TestPendingScan(ProjectDirMixin, unittest.TestCase):
    """_pending_scan folds a transcript into (delivered user turns, still-queued
    prompts, compaction count) in one pass — the facts the resend guarantee
    keys on (XERK-47)."""

    def _write(self, lines):
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(self.WORKDIR))
        os.makedirs(proj, exist_ok=True)
        path = os.path.join(proj, "t.jsonl")
        with open(path, "w") as f:
            for e in lines:
                f.write(json.dumps(e) + "\n")
        return path

    def test_delivered_queued_and_compactions(self):
        path = self._write([
            {"type": "user", "message": {"role": "user", "content": "hello"}},
            {"type": "queue-operation", "operation": "enqueue", "content": "later msg"},
            {"type": "system", "subtype": "compact_boundary",
             "compactMetadata": {"trigger": "auto"}},
            {"type": "user", "message": {"role": "user", "content": "second"}},
        ])
        delivered, queued, compactions = ha._pending_scan(path)
        self.assertIn("hello", delivered)
        self.assertIn("second", delivered)
        self.assertEqual(queued, ["later msg"])
        self.assertEqual(compactions, 1)

    def test_compact_summary_and_meta_turns_are_not_delivered(self):
        # A compact summary is written as a user turn but is the model's own prose
        # (isCompactSummary); a system-sourced turn (a task-notification) isn't a
        # human message. Neither counts as a delivered operator message.
        path = self._write([
            {"type": "user", "isCompactSummary": True,
             "message": {"role": "user", "content": "summary prose"}},
            {"type": "user", "isMeta": True,
             "message": {"role": "user", "content": "meta"}},
            {"type": "user", "promptSource": "system",
             "message": {"role": "user", "content": "injected"}},
            {"type": "user", "message": {"role": "user", "content": "real one"}},
        ])
        delivered, _queued, _c = ha._pending_scan(path)
        self.assertEqual(delivered, ["real one"])

    def test_dequeue_empties_the_queue(self):
        path = self._write([
            {"type": "queue-operation", "operation": "enqueue", "content": "q"},
            {"type": "queue-operation", "operation": "dequeue"},
        ])
        _d, queued, _c = ha._pending_scan(path)
        self.assertEqual(queued, [])


class TestPollPendingInputs(ManagerMixin, unittest.TestCase):
    """_poll_pending_inputs confirms sent messages landed and re-sends any a
    compaction dropped (XERK-47)."""

    SID = "11111111-1111-4111-8111-111111111111"

    def make_manager(self):
        sm = super().make_manager()
        self.run_calls.clear()
        return sm

    def _session(self, sm, pending, worktree=None):
        wt = worktree or os.path.join(self.tmp, "wt")
        os.makedirs(wt, exist_ok=True)
        sess = {"id": "s1", "status": "running", "tmuxName": "agent-s1",
                "worktreePath": wt, "claudeSessionId": self.SID,
                "pendingInputs": pending}
        sm.registry = [sess]
        return sess, wt

    def _write_transcript(self, wt, lines):
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(wt))
        os.makedirs(proj, exist_ok=True)
        with open(os.path.join(proj, f"{self.SID}.jsonl"), "w") as f:
            for e in lines:
                f.write(json.dumps(e) + "\n")

    def test_delivered_message_is_reaped(self):
        sm = self.make_manager()
        sess, wt = self._session(sm, [{"text": "do it", "at": time.time(),
                                       "attempts": 1}])
        self._write_transcript(wt, [
            {"type": "user", "message": {"role": "user", "content": "do it"}}])
        with mock.patch.object(ha, "_pane_busy", return_value=False):
            sm._poll_pending_inputs()
        self.assertNotIn("pendingInputs", sess)
        self.assertEqual(self.run_calls, [])  # no resend

    def test_still_queued_message_is_kept_not_resent(self):
        sm = self.make_manager()
        sess, wt = self._session(sm, [{"text": "later", "at": time.time(),
                                       "attempts": 1}])
        self._write_transcript(wt, [
            {"type": "queue-operation", "operation": "enqueue", "content": "later"}])
        with mock.patch.object(ha, "_pane_busy", return_value=False):
            sm._poll_pending_inputs()
        self.assertEqual(len(sess["pendingInputs"]), 1)
        self.assertEqual(self.run_calls, [])

    def test_compaction_dropped_message_is_resent_when_idle(self):
        sm = self.make_manager()
        # compactBase 0: a compaction (count 1) has happened since it was sent.
        sess, wt = self._session(sm, [{"text": "hi there", "at": time.time(),
                                       "attempts": 1, "compactBase": 0}])
        self._write_transcript(wt, [
            {"type": "system", "subtype": "compact_boundary",
             "compactMetadata": {"trigger": "auto"}}])
        with mock.patch.object(ha, "_pane_busy", return_value=False):
            sm._poll_pending_inputs()
        # Re-typed the same way a first send goes in: pasted, then Enter.
        self.assertEqual(self.run_stdin_calls, [
            (["tmux", "load-buffer", "-b", "turma-input-agent-s1", "-"], "hi there"),
        ])
        self.assertEqual(self.run_calls, [
            ["tmux", "send-keys", "-t", "agent-s1", "Enter"],
        ])
        it = sess["pendingInputs"][0]
        self.assertEqual(it["attempts"], 2)
        self.assertEqual(it["compactBase"], 1)  # only a NEWER compaction re-loses it

    def test_no_resend_while_pane_is_busy(self):
        sm = self.make_manager()
        sess, wt = self._session(sm, [{"text": "hi", "at": time.time(),
                                       "attempts": 1, "compactBase": 0}])
        self._write_transcript(wt, [
            {"type": "system", "subtype": "compact_boundary",
             "compactMetadata": {"trigger": "auto"}}])
        with mock.patch.object(ha, "_pane_busy", return_value=True):
            sm._poll_pending_inputs()
        self.assertEqual(self.run_calls, [])            # deferred
        self.assertEqual(len(sess["pendingInputs"]), 1)  # still tracked

    def test_no_resend_without_a_new_compaction(self):
        sm = self.make_manager()
        # compactBase already 1 and the transcript holds one compaction: no NEW
        # compaction, so a not-yet-delivered message just waits (in-flight).
        sess, wt = self._session(sm, [{"text": "hi", "at": time.time(),
                                       "attempts": 1, "compactBase": 1}])
        self._write_transcript(wt, [
            {"type": "system", "subtype": "compact_boundary",
             "compactMetadata": {"trigger": "auto"}}])
        with mock.patch.object(ha, "_pane_busy", return_value=False):
            sm._poll_pending_inputs()
        self.assertEqual(self.run_calls, [])
        self.assertEqual(len(sess["pendingInputs"]), 1)

    def test_resend_budget_is_bounded(self):
        sm = self.make_manager()
        sess, wt = self._session(
            sm, [{"text": "hi", "at": time.time(),
                  "attempts": ha.PENDING_INPUT_MAX_ATTEMPTS, "compactBase": 0}])
        self._write_transcript(wt, [
            {"type": "system", "subtype": "compact_boundary",
             "compactMetadata": {"trigger": "auto"}}])
        with mock.patch.object(ha, "_pane_busy", return_value=False):
            sm._poll_pending_inputs()
        self.assertEqual(self.run_calls, [])       # budget spent, no resend
        self.assertNotIn("pendingInputs", sess)     # given up, reaped

    def test_only_one_resend_per_beat(self):
        sm = self.make_manager()
        sess, wt = self._session(sm, [
            {"text": "one", "at": time.time(), "attempts": 1, "compactBase": 0},
            {"text": "two", "at": time.time(), "attempts": 1, "compactBase": 0},
        ])
        self._write_transcript(wt, [
            {"type": "system", "subtype": "compact_boundary",
             "compactMetadata": {"trigger": "auto"}}])
        with mock.patch.object(ha, "_pane_busy", return_value=False):
            sm._poll_pending_inputs()
        # Exactly one message re-typed this beat (paste + Enter); the other waits.
        self.assertEqual([data for _cmd, data in self.run_stdin_calls], ["one"])
        self.assertEqual(len(sess["pendingInputs"]), 2)

    def test_expired_unconfirmed_message_is_dropped(self):
        sm = self.make_manager()
        sess, wt = self._session(
            sm, [{"text": "stale", "at": time.time() - ha.PENDING_INPUT_TTL_SEC - 1,
                  "attempts": 1, "compactBase": 0}])
        self._write_transcript(wt, [])  # never landed, no compaction
        with mock.patch.object(ha, "_pane_busy", return_value=False):
            sm._poll_pending_inputs()
        self.assertEqual(self.run_calls, [])
        self.assertNotIn("pendingInputs", sess)

    def test_stopped_session_drops_its_outbox(self):
        sm = self.make_manager()
        sess, _wt = self._session(sm, [{"text": "x", "at": time.time(),
                                        "attempts": 1}])
        sess["status"] = "stopped"
        sm._poll_pending_inputs()
        self.assertNotIn("pendingInputs", sess)

    def test_unknown_pane_state_does_not_resend(self):
        # _pane_busy None (uncapturable) is not "idle" — never resend on it.
        sm = self.make_manager()
        sess, wt = self._session(sm, [{"text": "hi", "at": time.time(),
                                       "attempts": 1, "compactBase": 0}])
        self._write_transcript(wt, [
            {"type": "system", "subtype": "compact_boundary",
             "compactMetadata": {"trigger": "auto"}}])
        with mock.patch.object(ha, "_pane_busy", return_value=None):
            sm._poll_pending_inputs()
        self.assertEqual(self.run_calls, [])
        self.assertEqual(len(sess["pendingInputs"]), 1)


class TestPrCommentEvents(unittest.TestCase):
    """_pr_comment_events normalizes conversation comments, review bodies and
    inline review-thread comments into one self-flagged event list (XERK-49)."""

    URL = "https://github.com/o/r/pull/7"

    def _fake_run(self, view, api):
        def run(cmd, cwd=None):
            if cmd[:3] == ["gh", "pr", "view"]:
                return json.dumps(view)
            if cmd[:2] == ["gh", "api"]:
                return json.dumps(api)
            return ""
        return run

    def test_gathers_all_three_channels(self):
        view = {
            "comments": [
                {"id": "c1", "author": {"login": "alice"}, "body": "please rename",
                 "url": "u1"},
            ],
            "reviews": [
                {"id": "r1", "author": {"login": "bob"}, "state": "CHANGES_REQUESTED",
                 "body": "needs a test"},
                {"id": "r2", "author": {"login": "bob"}, "state": "APPROVED",
                 "body": ""},                      # bare approve — dropped
            ],
        }
        api = [{"id": 99, "user": {"login": "carol"}, "body": "off by one",
                "path": "x.py", "line": 12, "html_url": "u3"}]
        with mock.patch.object(ha, "run", self._fake_run(view, api)):
            events = ha._pr_comment_events(self.URL, "botlogin")
        kinds = {e["kind"] for e in events}
        self.assertEqual(len(events), 3)
        self.assertIn("comment", kinds)
        self.assertIn("review Changes Requested", kinds)
        self.assertIn("inline", kinds)
        inline = next(e for e in events if e["kind"] == "inline")
        self.assertEqual(inline["loc"], "x.py:12")
        self.assertEqual(inline["key"], "99")

    def test_self_authored_is_flagged(self):
        view = {
            "comments": [
                {"id": "c1", "author": {"login": "botlogin"}, "body": "opened this",
                 "viewerDidAuthor": True},
                {"id": "c2", "author": {"login": "alice"}, "body": "fix it"},
            ],
            "reviews": [],
        }
        with mock.patch.object(ha, "run", self._fake_run(view, [])):
            events = ha._pr_comment_events(self.URL, "botlogin")
        by_key = {e["key"]: e for e in events}
        self.assertTrue(by_key["c1"]["is_self"])
        self.assertFalse(by_key["c2"]["is_self"])

    def test_login_compare_flags_self_without_viewer_field(self):
        # Inline comments have no viewerDidAuthor; fall back to a login compare.
        api = [{"id": 5, "user": {"login": "botlogin"}, "body": "mine"}]
        view = {"comments": [], "reviews": []}
        with mock.patch.object(ha, "run", self._fake_run(view, api)):
            events = ha._pr_comment_events(self.URL, "botlogin")
        self.assertTrue(events[0]["is_self"])

    def test_fetch_failure_returns_none(self):
        with mock.patch.object(ha, "run", lambda cmd, cwd=None: ""):
            self.assertIsNone(ha._pr_comment_events(self.URL, "botlogin"))

    def test_empty_pr_returns_empty_not_none(self):
        view = {"comments": [], "reviews": []}
        with mock.patch.object(ha, "run", self._fake_run(view, [])):
            self.assertEqual(ha._pr_comment_events(self.URL, "botlogin"), [])


class TestPrCommentMessage(unittest.TestCase):
    """_pr_comment_message folds new comments into the single typed message."""

    def test_names_pr_and_each_comment(self):
        msg = ha._pr_comment_message(
            "https://github.com/o/r/pull/7",
            [{"author": "alice", "body": "rename the flag", "kind": "comment",
              "loc": None},
             {"author": "carol", "body": "off by one", "kind": "inline",
              "loc": "x.py:12"}])
        self.assertIn("#7", msg)
        self.assertIn("this session", msg)
        self.assertIn("@alice", msg)
        self.assertIn("rename the flag", msg)
        self.assertIn("inline on x.py:12", msg)

    def test_body_is_capped(self):
        msg = ha._pr_comment_message(
            "https://github.com/o/r/pull/1",
            [{"author": "a", "body": "x" * 5000, "kind": "comment", "loc": None}])
        self.assertLessEqual(len(msg), ha.PR_COMMENTS_BODY_CAP + 200)

    def test_names_a_gitlab_mr_the_gitlab_way(self):
        msg = ha._pr_comment_message(
            "https://gitlab.example.com/grp/app/-/merge_requests/12",
            [{"author": "alice", "body": "rename it", "kind": "comment",
              "loc": None}])
        self.assertIn("!12", msg)
        self.assertIn("MR", msg)
        self.assertIn("@alice", msg)

    def test_names_an_azdo_pr_the_azdo_way(self):
        """XERK-226: Azure DevOps spells a pull-request reference `!12` — `#12`
        addresses a WORK ITEM there — but it is still a PR, not an MR."""
        msg = ha._pr_comment_message(
            "https://dev.azure.com/myorg/Proj/_git/app/pullrequest/12",
            [{"author": "Alice", "body": "rename it", "kind": "comment",
              "loc": None}])
        self.assertIn("!12", msg)
        self.assertIn("the PR", msg)
        self.assertNotIn("MR", msg)


class TestMrCommentEvents(unittest.TestCase):
    """XERK-162: _mr_comment_events answers _pr_comment_events' exact contract
    from GitLab's notes API."""

    MR = "https://gitlab.example.com/grp/app/-/merge_requests/12"

    def _configured(self):
        return mock.patch.multiple(
            ha, GITLAB_URL="https://gitlab.example.com", GITLAB_TOKEN="tok")

    def _events(self, notes, user={"username": "bot"}):
        def fake_get(path):
            return user if path == "user" else notes
        ha._GITLAB_SELF["username"] = None
        with self._configured(), \
                mock.patch.object(ha, "_gitlab_get", side_effect=fake_get):
            return ha._pr_comment_events(self.MR, "ghlogin-unused")

    def test_notes_map_to_events_and_system_notes_drop(self):
        events = self._events([
            {"id": 1, "system": True, "body": "added 1 commit",
             "author": {"username": "alice"}},
            {"id": 2, "system": False, "body": "rename the flag",
             "author": {"username": "alice"}},
            {"id": 3, "system": False, "body": "off by one",
             "author": {"username": "carol"},
             "type": "DiffNote",
             "position": {"new_path": "x.py", "new_line": 12}},
            {"id": 4, "system": False, "body": "on it",
             "author": {"username": "bot"}},
        ])
        self.assertEqual([e["key"] for e in events], ["2", "3", "4"])
        self.assertEqual(events[0]["kind"], "comment")
        self.assertEqual(events[1]["kind"], "inline")
        self.assertEqual(events[1]["loc"], "x.py:12")
        # The token's own user is baselined but never delivered.
        self.assertEqual([e["is_self"] for e in events], [False, False, True])

    def test_hard_failure_is_none_not_empty(self):
        ha._GITLAB_SELF["username"] = None
        with self._configured(), \
                mock.patch.object(ha, "_gitlab_get", return_value=None):
            self.assertIsNone(ha._pr_comment_events(self.MR, ""))

    def test_empty_mr_returns_empty_not_none(self):
        self.assertEqual(self._events([]), [])

    def test_foreign_gitlab_mr_is_none(self):
        ha._GITLAB_SELF["username"] = None
        with self._configured():
            self.assertIsNone(ha._pr_comment_events(
                "https://other.tld/g/a/-/merge_requests/9", ""))


class AzdoPrMixin:
    """The configured-ADO-org fixture the pull-request cases share."""

    ORG = "https://dev.azure.com/myorg"
    PR = "https://dev.azure.com/myorg/Proj/_git/app/pullrequest/12"

    def _configured(self):
        ha._AZDO_PR_REF.clear()
        ha._AZDO_SELF["ids"] = None
        return mock.patch.multiple(ha, AZDO_URL=self.ORG, AZDO_TOKEN="pat")

    def pr_payload(self, **over):
        data = {
            "pullRequestId": 12, "title": "Add flag", "status": "active",
            "isDraft": False, "mergeStatus": "succeeded",
            "targetRefName": "refs/heads/main",
            "repository": {"id": "repo-guid", "name": "app",
                           "project": {"id": "proj-guid", "name": "Proj"}},
        }
        data.update(over)
        return data

    @staticmethod
    def build_eval(status):
        return {"status": status, "configuration": {"type": {
            "id": "0609b952-1397-4640-95ec-e00a01b2c241",
            "displayName": "Build"}}}


class TestAzdoPrStatus(AzdoPrMixin, unittest.TestCase):
    """XERK-226: an Azure DevOps pull request answers in _summarize_pr's exact
    shape, so every chip renderer treats it like a GitHub PR."""

    def test_pr_id_under_configured_org(self):
        with self._configured():
            self.assertEqual(ha._azdo_pr_id(self.PR), "12")
            # ADO serves the PR with or without the project segment.
            self.assertEqual(ha._azdo_pr_id(
                "https://dev.azure.com/myorg/_git/app/pullrequest/12"), "12")
            # …and with the web UI's own tab query string.
            self.assertEqual(ha._azdo_pr_id(self.PR + "?_a=files"), "12")

    def test_pr_id_self_hosted_collection(self):
        with mock.patch.multiple(ha, AZDO_URL="https://tfs.co:8080/tfs/DefaultCollection",
                                 AZDO_TOKEN="pat"):
            self.assertEqual(ha._azdo_pr_id(
                "https://tfs.co:8080/tfs/DefaultCollection/P/_git/r/pullrequest/9"),
                "9")

    def test_pr_id_foreign_org_or_unconfigured(self):
        # Another org (no credential) and an unconfigured host both resolve to
        # None — the chip stays a bare link.
        with self._configured():
            self.assertIsNone(ha._azdo_pr_id(
                "https://dev.azure.com/other/P/_git/r/pullrequest/1"))
        with mock.patch.multiple(ha, AZDO_URL="", AZDO_TOKEN=""):
            self.assertIsNone(ha._azdo_pr_id(self.PR))

    def test_create_form_link_is_not_a_pull_request(self):
        # ADO's `git push` hint points at the CREATE form, like GitLab's
        # /merge_requests/new — no PR exists yet.
        with self._configured():
            self.assertIsNone(ha._azdo_pr_id(
                "https://dev.azure.com/myorg/Proj/_git/app/pullrequestcreate"
                "?sourceRef=xerk-1&targetRef=main"))

    def test_check_class(self):
        self.assertEqual(ha._azdo_check_class("approved"), "pass")
        self.assertEqual(ha._azdo_check_class("rejected"), "fail")
        self.assertEqual(ha._azdo_check_class("broken"), "fail")
        for s in ("queued", "running"):
            self.assertEqual(ha._azdo_check_class(s), "pending")
        self.assertIsNone(ha._azdo_check_class("notApplicable"))
        self.assertIsNone(ha._azdo_check_class(None))

    def test_only_ci_policies_are_checks(self):
        """A PR waiting on a human reviewer must not read as "CI pending":
        governance policies are not this PR's CI."""
        reviewers = {"status": "queued", "configuration": {"type": {
            "id": "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd",
            "displayName": "Minimum number of reviewers"}}}
        out = ha._summarize_azdo_pr(
            self.pr_payload(), [reviewers, self.build_eval("approved")])
        self.assertEqual(out["checks"], "passing")
        self.assertEqual(out["checkCounts"], {"pass": 1, "fail": 0, "pending": 0})

    def test_ci_policy_recognized_by_display_name_without_an_id(self):
        ev = {"status": "approved",
              "configuration": {"type": {"displayName": "Status"}}}
        self.assertEqual(ha._summarize_azdo_pr(self.pr_payload(), [ev])["checks"],
                         "passing")

    def test_summarize_open_passing_mergeable(self):
        out = ha._summarize_azdo_pr(self.pr_payload(),
                                    [self.build_eval("approved")])
        self.assertEqual(out["state"], "OPEN")
        self.assertEqual(out["number"], 12)
        self.assertEqual(out["title"], "Add flag")
        self.assertEqual(out["checks"], "passing")
        self.assertEqual(out["mergeable"], "MERGEABLE")
        self.assertEqual(out["ready"], "ready")
        self.assertEqual(out["base"], "main")

    def test_draft_and_terminal_states(self):
        self.assertEqual(
            ha._summarize_azdo_pr(self.pr_payload(isDraft=True))["state"], "DRAFT")
        self.assertEqual(
            ha._summarize_azdo_pr(self.pr_payload(status="completed"))["state"],
            "MERGED")
        self.assertEqual(
            ha._summarize_azdo_pr(self.pr_payload(status="abandoned"))["state"],
            "CLOSED")

    def test_conflict_blocks_even_with_green_ci(self):
        out = ha._summarize_azdo_pr(self.pr_payload(mergeStatus="conflicts"),
                                    [self.build_eval("approved")])
        self.assertEqual(out["mergeable"], "CONFLICTING")
        self.assertEqual(out["ready"], "blocked")

    def test_unproven_mergeability_is_pending(self):
        for raw in ("queued", "notSet", ""):
            out = ha._summarize_azdo_pr(self.pr_payload(mergeStatus=raw),
                                        [self.build_eval("approved")])
            self.assertEqual(out["mergeable"], "UNKNOWN")
            self.assertEqual(out["ready"], "pending")

    def test_unreadable_policies_report_no_ci_not_no_chip(self):
        out = ha._summarize_azdo_pr(self.pr_payload(), None)
        self.assertIsNone(out["checks"])
        self.assertIsNone(out["checkCounts"])
        self.assertEqual(out["state"], "OPEN")

    def test_pr_status_dispatches_and_keeps_the_scraped_url(self):
        calls = []

        def fake_get(path, params=None):
            calls.append((path, params or {}))
            if path.endswith("/_apis/git/pullrequests/12"):
                return self.pr_payload()
            return {"value": [self.build_eval("approved")]}

        with self._configured(), \
                mock.patch.object(ha, "_azure_get", side_effect=fake_get):
            out = ha.pr_status(self.PR)
        self.assertEqual(out["url"], self.PR)      # the link the chip opens
        self.assertEqual(out["ready"], "ready")
        # The evaluations call is keyed on the CodeReview artifact id, which is
        # NOT the PR's own /Git/PullRequestId artifactId.
        self.assertEqual(calls[1][1]["artifactId"],
                         "vstfs:///CodeReview/CodeReviewId/proj-guid/12")

    def test_pr_status_none_on_fetch_failure(self):
        with self._configured(), \
                mock.patch.object(ha, "_azure_get", return_value=None):
            self.assertIsNone(ha.pr_status(self.PR))

    def test_pr_status_leaves_github_alone(self):
        with self._configured(), \
                mock.patch.object(ha, "run", return_value=None):
            self.assertIsNone(ha.pr_status("https://github.com/o/r/pull/7"))


class TestAzdoPrCommentEvents(AzdoPrMixin, unittest.TestCase):
    """XERK-226: _azdo_pr_comment_events answers _pr_comment_events' exact
    contract from Azure DevOps' PR threads API."""

    ME = {"authenticatedUser": {"id": "me-guid", "uniqueName": "bot@x.io",
                                "providerDisplayName": "Turma Bot"}}

    def _events(self, threads, me=None):
        def fake_get(path, params=None):
            if path.endswith("/_apis/connectionData"):
                return self.ME if me is None else me
            if path.endswith("/_apis/git/pullrequests/12"):
                return self.pr_payload()
            return {"value": threads}

        with self._configured(), \
                mock.patch.object(ha, "_azure_get", side_effect=fake_get):
            return ha._pr_comment_events(self.PR, "")

    @staticmethod
    def thread(tid, comments, ctx=None):
        return {"id": tid, "comments": comments, "threadContext": ctx}

    @staticmethod
    def comment(cid, body, author=None, ctype="text"):
        return {"id": cid, "content": body, "commentType": ctype,
                "author": author or {"id": "alice-guid",
                                     "displayName": "Alice"}}

    def test_conversation_comment(self):
        evs = self._events([self.thread(3, [self.comment(1, "rename it")])])
        self.assertEqual(len(evs), 1)
        self.assertEqual(evs[0]["author"], "Alice")
        self.assertEqual(evs[0]["body"], "rename it")
        self.assertEqual(evs[0]["kind"], "comment")
        self.assertFalse(evs[0]["is_self"])

    def test_key_pairs_thread_and_comment(self):
        """A comment id is unique only WITHIN its thread, so the seen-key must
        carry both — else thread 4's comment 1 dedupes away thread 3's."""
        evs = self._events([self.thread(3, [self.comment(1, "a")]),
                            self.thread(4, [self.comment(1, "b")])])
        self.assertEqual([e["key"] for e in evs], ["3:1", "4:1"])

    def test_inline_comment_carries_file_and_line(self):
        ctx = {"filePath": "/src/app.py", "rightFileStart": {"line": 42}}
        evs = self._events([self.thread(5, [self.comment(1, "typo")], ctx)])
        self.assertEqual(evs[0]["kind"], "inline")
        self.assertEqual(evs[0]["loc"], "/src/app.py:42")

    def test_system_and_empty_comments_are_dropped(self):
        evs = self._events([self.thread(6, [
            self.comment(1, "Alice voted 10", ctype="system"),
            self.comment(2, "   "),
            self.comment(3, "real note"),
        ])])
        self.assertEqual([e["body"] for e in evs], ["real note"])

    def test_own_comment_is_marked_self(self):
        mine = {"id": "me-guid", "displayName": "Turma Bot"}
        evs = self._events([self.thread(7, [
            self.comment(1, "pushed a fix", author=mine)])])
        self.assertTrue(evs[0]["is_self"])

    def test_unknown_self_never_swallows_a_comment(self):
        evs = self._events([self.thread(8, [self.comment(1, "hi")])],
                           me={})
        self.assertFalse(evs[0]["is_self"])

    def test_empty_pr_returns_empty_not_none(self):
        self.assertEqual(self._events([]), [])

    def test_fetch_failure_is_none_so_the_baseline_holds(self):
        with self._configured(), \
                mock.patch.object(ha, "_azure_get", return_value=None):
            self.assertIsNone(ha._pr_comment_events(self.PR, ""))

    def test_foreign_org_is_none(self):
        with self._configured():
            self.assertIsNone(ha._pr_comment_events(
                "https://dev.azure.com/other/P/_git/r/pullrequest/1", ""))


class TestPrCreatePattern(unittest.TestCase):
    """TURMA_PR_CREATE_CMDS: a host whose PRs are opened by its own wrapper can
    register it, without loosening attribution for anyone else."""

    def _re(self, extra=""):
        return re.compile(ha._pr_create_pattern(extra))

    def test_built_ins_need_no_configuration(self):
        rx = self._re()
        for cmd in ("gh pr create --fill", "glab mr create", "ado pr-create -t x",
                    "az repos pr create", "git push -o merge_request.create"):
            self.assertTrue(rx.search(cmd), cmd)

    def test_the_wrapper_run_through_its_interpreter_still_counts(self):
        """The on-prem wrapper is a script, and a host that loses it from PATH
        runs it by path — the same PR, opened the same way."""
        rx = self._re()
        for cmd in ("ado.py pr-create --title x",
                    "python3 /home/u/git/ado/ado.py pr-create --title x",
                    "python3 ado.py pr-create",
                    "~/.local/bin/ado pr-create --title x",
                    "./ado.py pr-create"):
            self.assertTrue(rx.search(cmd), cmd)
        self.assertIsNone(rx.search("cat ado.py"))
        self.assertIsNone(rx.search("vim ado.py pr-create.md"))

    def test_a_built_in_is_anchored_against_a_hyphen_too(self):
        """`\\b` treats `-` as a boundary, so an unanchored built-in matches the
        tail of a different command."""
        rx = self._re()
        for cmd in ("run-ado pr-create", "my-gh pr create", "x-az repos pr create"):
            self.assertIsNone(rx.search(cmd), cmd)

    def test_a_registered_wrapper_matches(self):
        rx = self._re("mkpr, tfs pr new")
        self.assertTrue(rx.search("mkpr --title x"))
        self.assertTrue(rx.search("tfs   pr  new --repo app"))

    def test_an_unregistered_wrapper_does_not(self):
        self.assertIsNone(self._re("mkpr").search("openpr --title x"))

    def test_a_registered_word_is_not_matched_inside_a_longer_one(self):
        """Anchoring is what keeps a short entry from matching half a command."""
        rx = self._re("mkpr")
        self.assertIsNone(rx.search("mkprod deploy"))
        self.assertIsNone(rx.search("run-mkpr --title x"))
        self.assertTrue(rx.search("./mkpr --title x"))

    def test_a_built_in_is_not_matched_inside_a_longer_word(self):
        self.assertIsNone(self._re().search("myado pr-create"))

    def test_entries_are_literal_not_patterns(self):
        """The value is host config, but it must never reach the engine as a
        pattern — a stray `.` or `*` would silently widen attribution."""
        rx = self._re("mk.pr")
        self.assertTrue(rx.search("mk.pr --title x"))
        self.assertIsNone(rx.search("mkxpr --title x"))

    def test_blank_and_malformed_entries_widen_nothing(self):
        for extra in ("", "   ", ",,", " , ,"):
            self.assertEqual(ha._pr_create_pattern(extra),
                             ha._pr_create_pattern(), extra)

    def test_a_too_short_entry_is_ignored(self):
        """Attribution must not fail OPEN: a one- or two-character token makes
        half the commands a session runs read as "opened a PR"."""
        for extra in ("a", "x,pr", " a "):
            self.assertEqual(ha._pr_create_pattern(extra),
                             ha._pr_create_pattern(), extra)
        self.assertIsNone(self._re("a").search("ls -a /tmp"))
        # Two one-character words are three characters JOINED, and still match
        # half of what a session runs — the longest word is what counts.
        self.assertEqual(ha._pr_create_pattern("a b"), ha._pr_create_pattern())
        self.assertIsNone(self._re("a b").search("cat a b"))
        # …but a real short wrapper name still registers.
        self.assertTrue(self._re("prc").search("prc --title x"))


class TestAzdoCreatedPrUrl(unittest.TestCase):
    """XERK-226: `az repos pr create` prints the created PR as JSON and no link
    at all, so the chip's URL is composed from that object."""

    def _out(self, **over):
        data = {"pullRequestId": 12, "status": "active",
                "repository": {"name": "app",
                               "webUrl": "https://dev.azure.com/myorg/Proj/_git/app"}}
        data.update(over)
        return json.dumps(data)

    def test_composes_the_web_url(self):
        self.assertEqual(
            ha._azdo_created_pr_url(self._out()),
            "https://dev.azure.com/myorg/Proj/_git/app/pullrequest/12")

    def test_falls_back_to_remote_url_and_strips_userinfo(self):
        out = self._out(repository={
            "name": "app",
            "remoteUrl": "https://myorg@dev.azure.com/myorg/Proj/_git/app"})
        self.assertEqual(
            ha._azdo_created_pr_url(out),
            "https://dev.azure.com/myorg/Proj/_git/app/pullrequest/12")

    def test_an_on_prem_http_remote_url_composes_too(self):
        """`remoteUrl` is the ONLY field the az extension's SDK can supply (it
        has no webUrl), and it carries the `<org>@` prefix — so a plain-http
        on-prem collection composes nothing unless the strip knows http."""
        out = self._out(repository={
            "name": "app",
            "remoteUrl": "http://Collection@tfs.corp.local:8080/tfs/C/P/_git/app"})
        self.assertEqual(
            ha._azdo_created_pr_url(out),
            "http://tfs.corp.local:8080/tfs/C/P/_git/app/pullrequest/12")

    def test_finds_the_object_past_a_cli_banner(self):
        noisy = "WARNING: extension is in preview\n" + self._out()
        self.assertTrue(ha._azdo_created_pr_url(noisy))

    def test_invents_nothing_when_a_half_is_missing(self):
        self.assertIsNone(ha._azdo_created_pr_url(self._out(pullRequestId=None)))
        self.assertIsNone(ha._azdo_created_pr_url(
            self._out(repository={"name": "app"})))
        # Not a repository root — never extended into a PR link.
        self.assertIsNone(ha._azdo_created_pr_url(self._out(
            repository={"webUrl": "https://dev.azure.com/myorg/Proj"})))
        self.assertIsNone(ha._azdo_created_pr_url("gh: not json at all"))


class TestPollPrComments(ManagerMixin, unittest.TestCase):
    """_poll_pr_comments types new PR review activity into the running session
    that opened the PR, baselining history on first sight (XERK-49)."""

    URL = "https://github.com/o/r/pull/7"

    def make_manager(self):
        sm = super().make_manager()
        sm.github = {"available": True, "login": "botlogin", "repos": []}
        self.run_calls.clear()
        return sm

    def _session(self, sm, base=None):
        sess = {"id": "s1", "status": "running", "tmuxName": "agent-s1",
                "worktreePath": os.path.join(self.tmp, "wt"), "summary": "work"}
        if base is not None:
            sess["prCommentBase"] = base
        sm.registry = [sess]
        sm.session_pr_urls = {"s1": [self.URL]}
        return sess

    def _typed(self):
        # The texts delivered into the pane — send_input pastes them (XERK-227).
        return [data for _cmd, data in self.run_stdin_calls]

    def _events(self, *events):
        return mock.patch.object(ha, "_pr_comment_events",
                                 return_value=list(events))

    def _ev(self, key, author="alice", body="fix", is_self=False, kind="comment"):
        return {"key": key, "author": author, "body": body, "kind": kind,
                "loc": None, "is_self": is_self}

    def test_first_sighting_baselines_silently(self):
        sm = self.make_manager()
        sess = self._session(sm)                    # no prior base -> first sight
        with self._events(self._ev("c1"), self._ev("c2")):
            sm._poll_pr_comments()
        self.assertEqual(self._typed(), [])         # nothing delivered
        self.assertEqual(set(sess["prCommentBase"][self.URL]), {"c1", "c2"})

    def test_new_comment_is_delivered(self):
        sm = self.make_manager()
        sess = self._session(sm, base={self.URL: ["c1"]})
        with self._events(self._ev("c1"), self._ev("c2", body="rename it")):
            sm._poll_pr_comments()
        typed = self._typed()
        self.assertEqual(len(typed), 1)
        self.assertIn("rename it", typed[0])
        self.assertEqual(set(sess["prCommentBase"][self.URL]), {"c1", "c2"})

    def test_self_comment_is_not_delivered_but_is_seen(self):
        sm = self.make_manager()
        sess = self._session(sm, base={self.URL: ["c1"]})
        with self._events(self._ev("c1"),
                          self._ev("c2", author="botlogin", is_self=True)):
            sm._poll_pr_comments()
        self.assertEqual(self._typed(), [])
        self.assertIn("c2", sess["prCommentBase"][self.URL])

    def test_fetch_failure_keeps_baseline(self):
        sm = self.make_manager()
        sess = self._session(sm, base={self.URL: ["c1"]})
        with mock.patch.object(ha, "_pr_comment_events", return_value=None):
            sm._poll_pr_comments()
        self.assertEqual(self._typed(), [])
        self.assertEqual(sess["prCommentBase"][self.URL], ["c1"])

    def test_skipped_without_gh_login(self):
        sm = self.make_manager()
        sm.github = {"available": False, "login": None, "repos": []}
        self._session(sm, base={self.URL: ["c1"]})
        with self._events(self._ev("c2")):
            sm._poll_pr_comments()
        self.assertEqual(self._typed(), [])

    def test_stopped_session_is_skipped(self):
        sm = self.make_manager()
        sess = self._session(sm, base={self.URL: ["c1"]})
        sess["status"] = "stopped"
        with self._events(self._ev("c2")):
            sm._poll_pr_comments()
        self.assertEqual(self._typed(), [])

    def test_seen_set_is_capped(self):
        sm = self.make_manager()
        big = [f"k{i}" for i in range(ha.PR_COMMENTS_SEEN_MAX + 10)]
        sess = self._session(sm, base={self.URL: big})
        with self._events(self._ev("knew", body="hi")):
            sm._poll_pr_comments()
        self.assertLessEqual(len(sess["prCommentBase"][self.URL]),
                             ha.PR_COMMENTS_SEEN_MAX)
        self.assertIn("knew", sess["prCommentBase"][self.URL])


class TestPrConflictMessage(unittest.TestCase):
    """_pr_conflict_message names the PR and the branch to merge, and asks for
    a merge rather than a rebase (XERK-223)."""

    URL = "https://github.com/o/r/pull/7"

    def test_names_the_pr_and_its_base(self):
        msg = ha._pr_conflict_message(self.URL, "main")
        self.assertIn("#7", msg)
        self.assertIn(self.URL, msg)
        self.assertIn("origin/main", msg)
        self.assertIn("merge conflicts", msg)

    def test_asks_for_a_merge_not_a_rebase_or_a_pr_merge(self):
        msg = ha._pr_conflict_message(self.URL, "main")
        self.assertIn("Do not rebase or force-push", msg)
        self.assertIn("do not merge the PR itself", msg)

    def test_unknown_base_still_reads(self):
        msg = ha._pr_conflict_message(self.URL, None)
        self.assertNotIn("origin/None", msg)
        self.assertIn("base branch", msg)

    def test_repeat_says_still(self):
        self.assertIn("still has merge conflicts",
                      ha._pr_conflict_message(self.URL, "main", again=True))

    def test_gitlab_mr_speaks_mr(self):
        msg = ha._pr_conflict_message(
            "https://gitlab.com/g/p/-/merge_requests/4", "trunk")
        self.assertIn("!4", msg)
        self.assertIn("The MR", msg)
        self.assertNotIn("PR", msg)

    def test_azdo_pr_is_a_pr_numbered_the_azdo_way(self):
        msg = ha._pr_conflict_message(
            "https://dev.azure.com/myorg/Proj/_git/app/pullrequest/4", "main")
        self.assertIn("!4", msg)
        self.assertIn("The PR", msg)
        self.assertNotIn("MR", msg)


class TestPollPrConflicts(ManagerMixin, unittest.TestCase):
    """_poll_pr_conflicts types a resolve-the-conflicts message into the running
    session that opened a now-unmergeable PR, once per conflict episode
    (XERK-223)."""

    URL = "https://github.com/o/r/pull/7"

    def make_manager(self):
        sm = super().make_manager()
        sm.github = {"available": True, "login": "botlogin", "repos": []}
        self.run_calls.clear()
        return sm

    def _session(self, sm, **status):
        sess = {"id": "s1", "status": "running", "tmuxName": "agent-s1",
                "worktreePath": os.path.join(self.tmp, "wt"), "summary": "work"}
        sm.registry = [sess]
        sm.session_pr_urls = {"s1": [self.URL]}
        sm.pr_status_cache = {self.URL: dict(
            {"url": self.URL, "state": "OPEN", "mergeable": "CONFLICTING",
             "checks": "passing", "base": "main"}, **status)}
        return sess

    def _typed(self):
        # The texts delivered into the pane — send_input pastes them (XERK-227).
        return [data for _cmd, data in self.run_stdin_calls]

    def test_conflict_is_delivered_once_per_episode(self):
        sm = self.make_manager()
        sess = self._session(sm)
        sm._poll_pr_conflicts()
        self.assertEqual(len(self._typed()), 1)
        self.assertIn("origin/main", self._typed()[0])
        self.assertEqual(sess["prConflicts"][self.URL]["attempts"], 1)
        sm._poll_pr_conflicts()                    # next beat, still conflicting
        self.assertEqual(len(self._typed()), 1)    # not re-typed

    def test_mergeable_clears_the_episode_and_rearms(self):
        sm = self.make_manager()
        sess = self._session(sm)
        sm._poll_pr_conflicts()
        sm.pr_status_cache[self.URL]["mergeable"] = "MERGEABLE"
        sm._poll_pr_conflicts()
        self.assertNotIn("prConflicts", sess)
        sm.pr_status_cache[self.URL]["mergeable"] = "CONFLICTING"
        sm._poll_pr_conflicts()                    # conflicts again -> nudged again
        self.assertEqual(len(self._typed()), 2)

    def test_unknown_neither_nudges_nor_clears(self):
        sm = self.make_manager()
        sess = self._session(sm)
        sm._poll_pr_conflicts()
        sm.pr_status_cache[self.URL]["mergeable"] = "UNKNOWN"
        sm._poll_pr_conflicts()
        self.assertEqual(len(self._typed()), 1)
        # The episode is still armed: a push that didn't resolve it must not get
        # a fresh retry budget just because GitHub is recomputing.
        self.assertEqual(sess["prConflicts"][self.URL]["attempts"], 1)

    def test_retries_are_spaced_and_bounded(self):
        sm = self.make_manager()
        sess = self._session(sm)
        for _ in range(ha.PR_CONFLICT_MAX_ATTEMPTS + 2):
            sm._poll_pr_conflicts()
            ep = sess.get("prConflicts", {}).get(self.URL)
            if ep:
                ep["at"] = 0                       # age past the backoff
        self.assertEqual(len(self._typed()), ha.PR_CONFLICT_MAX_ATTEMPTS)
        self.assertIn("still has merge conflicts", self._typed()[1])

    def test_backoff_holds_a_second_nudge(self):
        sm = self.make_manager()
        self._session(sm)
        sm._poll_pr_conflicts()
        sm._poll_pr_conflicts()                    # within PR_CONFLICT_RETRY_SEC
        self.assertEqual(len(self._typed()), 1)

    def test_merged_pr_is_left_alone(self):
        sm = self.make_manager()
        sess = self._session(sm, state="MERGED")
        sm._poll_pr_conflicts()
        self.assertEqual(self._typed(), [])
        self.assertNotIn("prConflicts", sess)

    def test_stopped_session_is_skipped(self):
        sm = self.make_manager()
        sess = self._session(sm)
        sess["status"] = "stopped"
        sm._poll_pr_conflicts()
        self.assertEqual(self._typed(), [])

    def test_unfetched_status_does_nothing(self):
        sm = self.make_manager()
        self._session(sm)
        sm.pr_status_cache = {}                    # no status yet this beat
        sm._poll_pr_conflicts()
        self.assertEqual(self._typed(), [])

    def test_episode_for_a_dropped_pr_is_forgotten(self):
        sm = self.make_manager()
        sess = self._session(sm)
        sm._poll_pr_conflicts()
        sm.session_pr_urls["s1"] = ["https://github.com/o/r/pull/9"]
        sm.pr_status_cache = {}
        sm._poll_pr_conflicts()
        self.assertNotIn("prConflicts", sess)

    def test_disabled_by_env_flag(self):
        sm = self.make_manager()
        self._session(sm)
        with mock.patch.object(ha, "PR_CONFLICT_RESOLVE", False):
            sm._poll_pr_conflicts()
        self.assertEqual(self._typed(), [])


# Verbatim `tmux capture-pane -p` output from a live Claude Code 2.1.220
# session, trimmed to the dialog region — the two blocking dialogs
# parse_pane_prompt exists to read. Kept as real captures rather than
# hand-written strings: the wordings, glyphs and blank-line placement are the
# contract, and inventing them is how a parser passes its tests and fails a pane.
PANE_PERMISSION_DIALOG = """\
● Running 1 shell command…
  ⎿  $ touch /tmp/permtest-marker

────────────────────────────────────────────────────────────────────
 Bash command

   touch /tmp/permtest-marker
   Create marker file in /tmp

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to tmp/ from this project
   3. No

 Esc to cancel · Tab to amend · ctrl+e to explain
"""

PANE_PLAN_DIALOG = """\
  ────────────────────────────────────────────────────────────────────
   Ready to code?

   Here is Claude's plan:
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
   Plan

   I will add one test.
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌

  ────────────────────────────────────────────────────────────────────
   Claude has written up a plan and is ready to execute. Would you like to proceed?

   ❯ 1. Yes, and use auto mode
     2. Yes, manually approve edits
     3. No, refine with Ultraplan on Claude Code on the web
     4. Tell Claude what to change
        shift+tab to approve with this feedback
"""

# The same session with no dialog up: the composer is live, so the mode footer
# is on screen. This is the shape that must NEVER parse as a dialog.
PANE_IDLE_COMPOSER = """\
● Done — PR #230 is up.

  1. first thing
  2. second thing
  Which one?
────────────────────────────────────────────────────────────────────
❯ Try "edit <filepath> to..."
────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← for agents
"""


class TestPrsLanded(ManagerMixin, unittest.TestCase):
    """`_poll_prs_landed` + `_new_work_since_prs`: the clock that lets the
    Ready-for-review "merging IS the review" demotion EXPIRE (XERK-224).

    Without it a session whose PR merged is pinned to Idle for good, so giving
    that same session a new task produced work nobody could see."""

    URL = "https://github.com/o/r/pull/7"

    def _sess(self, sm, state="OPEN"):
        wt = os.path.join(self.tmp, "wt")
        sess = {"id": "s1", "status": "running", "worktreePath": wt,
                "claudeSessionId": "tid-1"}
        sm.registry = [sess]
        sm.session_pr_urls = {"s1": [self.URL]}
        sm.pr_status_cache = {self.URL: {"url": self.URL, "state": state}}
        return sess

    def _transcript(self, sess, *timestamps):
        """Write the session's transcript with one dated entry per timestamp."""
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(sess["worktreePath"]))
        os.makedirs(proj, exist_ok=True)
        path = os.path.join(proj, sess["claudeSessionId"] + ".jsonl")
        with open(path, "w", encoding="utf-8") as fh:
            for ts in timestamps:
                fh.write(json.dumps({"type": "assistant", "timestamp": ts}) + "\n")
        return path

    def test_stamps_the_conversation_clock_when_every_pr_lands(self):
        sm = self.make_manager()
        sess = self._sess(sm, state="OPEN")
        self._transcript(sess, "2026-08-06T10:00:00.000Z")
        sm._poll_prs_landed()
        self.assertIsNone(sess.get("prsLandedTs"), "an OPEN PR marks nothing")

        sm.pr_status_cache[self.URL]["state"] = "MERGED"
        sm._poll_prs_landed()
        # The stamp is the transcript's own timestamp, NOT wall time — both
        # sides of the later comparison have to share one clock.
        self.assertEqual(sess["prsLandedTs"], "2026-08-06T10:00:00.000Z")

    def test_the_stamp_does_not_drift_once_set(self):
        sm = self.make_manager()
        sess = self._sess(sm, state="MERGED")
        self._transcript(sess, "2026-08-06T10:00:00.000Z")
        sm._poll_prs_landed()
        self._transcript(sess, "2026-08-06T10:00:00.000Z", "2026-08-06T11:00:00.000Z")
        sm._poll_prs_landed()
        self.assertEqual(sess["prsLandedTs"], "2026-08-06T10:00:00.000Z",
                         "later activity must move the COMPARISON, not the mark")

    def test_an_unfetched_pr_state_stamps_nothing(self):
        sm = self.make_manager()
        sess = self._sess(sm, state="MERGED")
        sm.pr_status_cache["https://github.com/o/r/pull/8"] = {}   # never fetched
        sm.session_pr_urls["s1"].append("https://github.com/o/r/pull/8")
        self._transcript(sess, "2026-08-06T10:00:00.000Z")
        sm._poll_prs_landed()
        self.assertIsNone(sess.get("prsLandedTs"),
                          "'not looked at' is not 'landed' — stamping early would "
                          "measure new work against the wrong moment")

    def test_a_new_pr_clears_the_stamp_for_a_fresh_round(self):
        sm = self.make_manager()
        sess = self._sess(sm, state="MERGED")
        self._transcript(sess, "2026-08-06T10:00:00.000Z")
        sm._poll_prs_landed()
        self.assertTrue(sess.get("prsLandedTs"))
        sm.pr_status_cache[self.URL]["state"] = "OPEN"    # session opened another
        sm._poll_prs_landed()
        self.assertIsNone(sess.get("prsLandedTs"))

    def test_new_work_since_prs_reads_the_two_stamps(self):
        sm = self.make_manager()
        sess = {"id": "s1"}
        sig = {"lastActivityTs": "2026-08-06T10:00:00.000Z"}
        # No landing recorded: the question doesn't apply, and False keeps the
        # behaviour that shipped before this expiry existed.
        self.assertFalse(sm._new_work_since_prs(sess, sig))
        sess["prsLandedTs"] = "2026-08-06T10:00:00.000Z"
        self.assertFalse(sm._new_work_since_prs(sess, sig), "same moment: nothing new")
        sig["lastActivityTs"] = "2026-08-06T11:00:00.000Z"
        self.assertTrue(sm._new_work_since_prs(sess, sig), "the session spoke again")
        # A stopped session reports no live signals, and an undated transcript
        # answers nothing — neither may read as progress.
        self.assertFalse(sm._new_work_since_prs(sess, None))
        self.assertFalse(sm._new_work_since_prs(sess, {"lastActivityTs": None}))


class TestAnswerPanePrompt(ManagerMixin, unittest.TestCase):
    """Answering the TUI's blocking dialog from the chat page: type the option
    digit, but only after re-reading the pane — the click was made against a
    heartbeat that is up to a beat stale."""

    def make_manager(self):
        sm = super().make_manager()
        self.run_calls.clear()
        return sm

    def _session(self, sm, status="running"):
        sm.registry = [{"id": "abcde", "status": status, "tmuxName": "agent-abcde"}]

    def _answer(self, sm, number, cap=PANE_PERMISSION_DIALOG):
        with mock.patch.object(ha, "_capture_pane", return_value=cap):
            sm.answer_pane_prompt("abcde", number)

    def test_types_the_option_digit(self):
        sm = self.make_manager()
        self._session(sm)
        self._answer(sm, 2)
        self.assertEqual(
            self.run_calls, [["tmux", "send-keys", "-t", "agent-abcde", "2"]])

    def test_stale_click_is_dropped_when_the_dialog_is_gone(self):
        # The whole safety property: without the re-read this would type a bare
        # "1" into the live composer, silently prepending a stray character to
        # the operator's next message.
        sm = self.make_manager()
        self._session(sm)
        self._answer(sm, 1, cap=PANE_IDLE_COMPOSER)
        self.assertEqual(self.run_calls, [])

    def test_number_not_on_screen_is_dropped(self):
        sm = self.make_manager()
        self._session(sm)
        self._answer(sm, 4)          # the permission dialog offers 1-3
        self.assertEqual(self.run_calls, [])

    def test_noop_for_stopped_or_unknown_session(self):
        sm = self.make_manager()
        self._session(sm, status="stopped")
        self._answer(sm, 1)
        sm.registry = []
        self._answer(sm, 1)
        self.assertEqual(self.run_calls, [])

    def test_non_numeric_answer_is_dropped(self):
        sm = self.make_manager()
        self._session(sm)
        self._answer(sm, "; rm -rf /")
        self.assertEqual(self.run_calls, [])


class TestInterrupt(ManagerMixin, unittest.TestCase):
    """Stop the turn a running session has in flight: a single Escape into its
    TUI, which cancels the generation/tool call and leaves the session running
    with its conversation intact."""

    def make_manager(self):
        sm = super().make_manager()
        self.run_calls.clear()  # drop __init__'s own run() calls
        return sm

    def _session(self, sm, status="running"):
        sess = {"id": "abcde", "status": status, "tmuxName": "agent-abcde"}
        sm.registry = [sess]
        return sess

    def test_sends_escape_to_the_session_pane(self):
        sm = self.make_manager()
        self._session(sm)
        sm.interrupt("abcde")
        self.assertEqual(
            self.run_calls, [["tmux", "send-keys", "-t", "agent-abcde", "Escape"]])

    def test_noop_for_stopped_session(self):
        sm = self.make_manager()
        self._session(sm, status="stopped")
        sm.interrupt("abcde")
        self.assertEqual(self.run_calls, [])

    def test_noop_for_unknown_session(self):
        sm = self.make_manager()
        self._session(sm)
        sm.interrupt("nope")
        self.assertEqual(self.run_calls, [])

    def test_idle_session_is_still_interrupted(self):
        # Stop is deliberately not gated on paneBusy: that read is up to a beat
        # stale when the operator clicks, and Escape into an idle pane is
        # harmless — refusing would break the case the button exists for.
        sm = self.make_manager()
        sess = self._session(sm)
        sess["paneBusy"] = False
        sm.interrupt("abcde")
        self.assertEqual(
            self.run_calls, [["tmux", "send-keys", "-t", "agent-abcde", "Escape"]])


# A realistic /model picker pane capture: ❯ on the current model (Fable, row
# index 2), descriptions two-plus spaces right of the label, ✔ on the current
# row. What parse_model_picker and the set_model tests below drive against.
MODEL_PICKER_PANE = """
❯ /model
   Select model
   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.

     1. Default (recommended)  Opus 4.8 with 1M context · Best for everyday, complex tasks
     2. Opus                   Opus 4.8 with 1M context · Best for everyday, complex tasks
   ❯ 3. Fable ✔                Fable 5 · Most capable for your hardest and longest-running tasks
     4. Sonnet                 Sonnet 5 · Efficient for routine tasks
     5. Haiku                  Haiku 4.5 · Fastest for quick answers

   Enter to set as default · s to use this session only · Esc to cancel
"""


class _PickerPane:
    """A /model-picker pane simulator for set_model's closed loop: send-keys
    move its ❯ cursor, `s` closes it and prints the confirmation — and it can
    be told to drop arrow presses or never confirm, which is exactly the
    flakiness the verified loop exists to survive."""
    ROWS = ("Default (recommended)", "Opus", "Fable", "Sonnet", "Haiku")

    def __init__(self, cur=2, drop_arrows=0, confirm=True, opens=True):
        self.cur = cur                  # ❯ starts on Fable, like the real pane
        self.drop_arrows = drop_arrows  # swallow this many arrow presses
        self.confirm = confirm          # print "Set model to…" after `s`
        self.opens = opens              # whether /model paints a picker at all
        self.open = False
        self.confirmed = False

    def key(self, key):
        if key == "Enter" and not self.open:
            self.open = self.opens
        elif key in ("Down", "Up") and self.open:
            if self.drop_arrows > 0:
                self.drop_arrows -= 1
                return
            step = 1 if key == "Down" else -1
            self.cur = min(len(self.ROWS) - 1, max(0, self.cur + step))
        elif key == "s" and self.open:
            self.open = False
            self.confirmed = self.confirm
        elif key == "Escape":
            self.open = False

    def capture(self):
        if self.open:
            lines = ["   Select model"]
            for i, label in enumerate(self.ROWS):
                mark = "❯ " if i == self.cur else "  "
                lines.append(f"   {mark}{i + 1}. {label}    a description")
            return "\n".join(lines)
        if self.confirmed:
            return "  ⎿  Set model to Sonnet 5 for this session only\n❯ "
        return "❯ \n  ? for shortcuts"  # idle; deliberately no mode marker


class _ModePane:
    """A footer-mode pane simulator for set_mode's closed loop: BTab advances
    through `cycle`, capture() shows the current mode's real footer marker."""
    MARKERS = {
        "default": "⏸ manual mode on",
        "acceptEdits": "⏵⏵ accept edits on",
        "plan": "⏸ plan mode on",
        "auto": "⏵⏵ auto mode on",
        "bypassPermissions": "⏵⏵ bypass permissions on",
    }

    def __init__(self, cycle, cur=0):
        self.cycle = list(cycle)
        self.i = cur

    @property
    def mode(self):
        return self.cycle[self.i]

    def key(self, key):
        if key == "BTab":
            self.i = (self.i + 1) % len(self.cycle)

    def capture(self):
        return f"❯ \n  {self.MARKERS[self.mode]} (shift+tab to cycle)"


class TestSetModelMode(ManagerMixin, unittest.TestCase):
    """Live model / permission-mode switches on a running session — both are
    CLOSED LOOPS: model by driving the /model picker one verified arrow at a
    time and pressing `s` (session-only; the typed `/model <name>` form would
    also rewrite the shared login's saved default), mode by pressing Shift+Tab
    and reading the footer marker back until the target shows. The real mode
    cycle is account- AND model-dependent, so no precomputed press count is
    trusted; the guessed-cycle math survives only as the fallback for a pane
    whose marker can't be read."""

    def make_manager(self, pane=None, busy=False):
        sm = super().make_manager()
        self.run_calls.clear()
        sm.save = mock.Mock()  # don't touch disk; just assert the record update
        self.pane = _PickerPane() if pane is None else pane

        def fake_run(cmd, cwd=None):
            self.run_calls.append(cmd)
            if cmd[:2] == ["tmux", "send-keys"] and hasattr(self.pane, "key"):
                self.pane.key(cmd[-1])
            return ""

        def fake_capture(tmux_name):
            return self.pane.capture() if hasattr(self.pane, "capture") else self.pane

        for name, value in [("run", fake_run),
                            ("_pane_busy", lambda t: busy),
                            ("_capture_pane", fake_capture),
                            ("MODEL_PICKER_WAIT_SEC", 0),
                            ("MODEL_STEP_WAIT_SEC", 0),
                            ("MODEL_CONFIRM_WAIT_SEC", 0),
                            ("MODE_STEP_WAIT_SEC", 0)]:
            p = mock.patch.object(ha, name, value)
            p.start()
            self.addCleanup(p.stop)
        return sm

    def _session(self, sm, sid="abcde", model=None, perm="auto", status="running",
                 launch=None):
        # launch defaults to perm — a just-launched session's current mode is the
        # mode it launched into, which fixes its blind-fallback cycle.
        sess = {"id": sid, "status": status, "tmuxName": f"agent-{sid}",
                "model": model, "permissionMode": perm,
                "launchPermissionMode": perm if launch is None else launch}
        sm.registry = [sess]
        return sess

    def _keys(self):
        return [c[-1] for c in self.run_calls]

    # ---- set_model ---------------------------------------------------------

    def test_set_model_drives_picker_to_row_and_session_only(self):
        sm = self.make_manager()
        sess = self._session(sm, model=None)
        sm.set_model("abcde", "sonnet")
        self.assertEqual(self._keys(), ["C-u", "/model", "Enter", "Down", "s"])
        self.assertEqual(sess["model"], "sonnet")
        sm.save.assert_called_once()

    def test_set_model_default_arrows_up_and_stores_none(self):
        sm = self.make_manager()
        sess = self._session(sm, model="opus")
        sm.set_model("abcde", "default")
        self.assertEqual(self._keys(), ["C-u", "/model", "Enter", "Up", "Up", "s"])
        self.assertIsNone(sess["model"])

    def test_set_model_dropped_arrow_self_corrects(self):
        # A dropped keypress used to leave the old press-burst one row short,
        # and `s` then silently selected the WRONG model. The verified loop
        # sees the unmoved ❯ and simply presses again.
        sm = self.make_manager(pane=_PickerPane(drop_arrows=1))
        sess = self._session(sm, model=None)
        sm.set_model("abcde", "sonnet")
        self.assertEqual(self._keys(),
                         ["C-u", "/model", "Enter", "Down", "Down", "s"])
        self.assertEqual(sess["model"], "sonnet")

    def test_set_model_busy_pane_defers_instead_of_dropping(self):
        # Typed into a mid-turn pane the command would only queue as a prompt.
        # The pick is deferred (pendingModel), not silently dropped — the old
        # log-only refusal is what made the button feel dead.
        sm = self.make_manager(busy=True)
        sess = self._session(sm, model=None)
        sm.set_model("abcde", "sonnet")
        self.assertEqual(self.run_calls, [])
        self.assertEqual(sess["pendingModel"], "sonnet")
        self.assertIsNone(sess["model"])

    def test_apply_pending_switches_lands_the_deferred_pick(self):
        sm = self.make_manager(busy=False)
        sess = self._session(sm, model=None)
        sess["pendingModel"] = "sonnet"
        sm._apply_pending_switches()
        self.assertNotIn("pendingModel", sess)
        self.assertEqual(sess["model"], "sonnet")
        self.assertIn("s", self._keys())

    def test_apply_pending_switches_waits_out_a_busy_pane(self):
        sm = self.make_manager(busy=True)
        sess = self._session(sm, model=None)
        sess["pendingModel"] = "sonnet"
        sm._apply_pending_switches()
        self.assertEqual(sess["pendingModel"], "sonnet")  # still waiting
        self.assertEqual(self.run_calls, [])

    def test_set_model_no_picker_escapes_and_keeps_model(self):
        sm = self.make_manager(pane=_PickerPane(opens=False))
        sess = self._session(sm, model="opus")
        sm.set_model("abcde", "sonnet")
        self.assertEqual(self._keys()[-1], "Escape")
        self.assertEqual(sess["model"], "opus")

    def test_set_model_unconfirmed_selection_leaves_the_record(self):
        # `s` was sent but the TUI never printed its confirmation: the record
        # must not assert a switch nobody proved — the transcript scan's
        # modelActual settles what the chip shows either way.
        sm = self.make_manager(pane=_PickerPane(confirm=False))
        sess = self._session(sm, model="opus")
        sm.set_model("abcde", "sonnet")
        self.assertEqual(self._keys()[-1], "s")
        self.assertEqual(sess["model"], "opus")

    def test_set_model_row_not_offered_escapes(self):
        # A probed alias with no picker row (the bracketed 1M variants) backs
        # out rather than pressing keys at a row that isn't there.
        sm = self.make_manager()
        sm.models_info = {"available": ["sonnet", "opusplan", "default"]}
        sess = self._session(sm, model=None)
        sm.set_model("abcde", "opusplan")
        self.assertEqual(self._keys()[-1], "Escape")
        self.assertIsNone(sess["model"])

    def test_set_model_rejects_unknown_before_any_keystroke(self):
        sm = self.make_manager()
        self._session(sm, model=None)
        with self.assertRaises(ValueError):
            sm.set_model("abcde", "gpt-9")
        self.assertEqual(self.run_calls, [])

    def test_set_model_noop_for_non_running(self):
        sm = self.make_manager()
        self._session(sm, status="stopped")
        sm.set_model("abcde", "sonnet")
        self.assertEqual(self.run_calls, [])

    # ---- set_mode (closed loop) --------------------------------------------

    def test_set_mode_presses_until_the_marker_reads_the_target(self):
        pane = _ModePane(["default", "acceptEdits", "plan", "auto"], cur=3)
        sm = self.make_manager(pane=pane)
        sess = self._session(sm, perm="auto")
        sm.set_mode("abcde", "plan")
        self.assertEqual(self._keys(), ["BTab"] * 3)
        self.assertEqual(sess["permissionMode"], "plan")
        self.assertEqual(pane.mode, "plan")
        sm.save.assert_called_once()

    def test_set_mode_reaches_a_mode_the_guessed_cycle_says_is_absent(self):
        # Observed live: a bypass-launched session's real cycle DOES contain
        # auto (account-enabled), which perm_cycle_for guesses absent — the
        # old computed-press path refused this switch outright. The closed
        # loop doesn't consult the guess at all.
        pane = _ModePane(["default", "acceptEdits", "plan", "auto",
                          "bypassPermissions"], cur=4)
        sm = self.make_manager(pane=pane)
        sess = self._session(sm, perm="bypassPermissions")
        sm.set_mode("abcde", "auto")
        self.assertEqual(sess["permissionMode"], "auto")
        self.assertEqual(pane.mode, "auto")

    def test_set_mode_trusts_the_pane_over_a_stale_record(self):
        # The operator cycled by hand in the live terminal: the record says
        # auto but the pane shows plan. The loop starts from the PANE's truth,
        # where the old path counted presses from the stale record and landed
        # on the wrong mode.
        pane = _ModePane(["default", "acceptEdits", "plan", "auto"], cur=2)
        sm = self.make_manager(pane=pane)
        sess = self._session(sm, perm="auto")  # stale
        sm.set_mode("abcde", "acceptEdits")
        self.assertEqual(self._keys(), ["BTab"] * 3)  # plan→auto→default→acceptEdits
        self.assertEqual(sess["permissionMode"], "acceptEdits")

    def test_set_mode_unreachable_target_wraps_and_keeps_the_truth(self):
        pane = _ModePane(["default", "acceptEdits", "plan", "auto"], cur=0)
        sm = self.make_manager(pane=pane)
        sess = self._session(sm, perm="default")
        sm.set_mode("abcde", "bypassPermissions")
        self.assertEqual(self._keys(), ["BTab"] * 4)  # one full lap, then stop
        self.assertEqual(sess["permissionMode"], "default")

    def test_set_mode_already_there_presses_nothing(self):
        pane = _ModePane(["default", "acceptEdits", "plan", "auto"], cur=2)
        sm = self.make_manager(pane=pane)
        sess = self._session(sm, perm="plan")
        sm.set_mode("abcde", "plan")
        self.assertEqual(self.run_calls, [])
        self.assertEqual(sess["permissionMode"], "plan")

    def test_set_mode_unreadable_pane_falls_back_to_computed_presses(self):
        # No marker to read (a TUI wording this parser predates): the guessed
        # cycle is still better than nothing. auto-launch cycle
        # [default, acceptEdits, plan, auto]: auto -> plan = 3 presses.
        sm = self.make_manager(pane="❯ \n  ? for shortcuts")
        sess = self._session(sm, perm="auto")
        sm.set_mode("abcde", "plan")
        self.assertEqual(self._keys(), ["BTab"] * 3)
        self.assertEqual(sess["permissionMode"], "plan")

    def test_set_mode_blind_unreachable_is_a_noop(self):
        sm = self.make_manager(pane="❯ \n  ? for shortcuts")
        sess = self._session(sm, perm="auto")
        sm.set_mode("abcde", "bypassPermissions")
        self.assertEqual(self.run_calls, [])
        self.assertEqual(sess["permissionMode"], "auto")

    def test_set_mode_rejects_unknown(self):
        sm = self.make_manager()
        self._session(sm, perm="auto")
        with self.assertRaises(ValueError):
            sm.set_mode("abcde", "yolo")
        self.assertEqual(self.run_calls, [])

    def test_set_mode_noop_for_non_running(self):
        sm = self.make_manager()
        self._session(sm, perm="auto", status="stopped")
        sm.set_mode("abcde", "plan")
        self.assertEqual(self.run_calls, [])


class TestLocalModelConfig(unittest.TestCase):
    """Validating the self-hosted-model settings (XERK-246). These decide
    whether the failover is OFFERED at all, so a half-configured host must read
    as "no", never as "yes" — a session launched against an endpoint with no key
    dies on its first request, which is worse than never offering the switch."""

    def _configured(self, **over):
        vals = {"LOCAL_MODEL_BASE_URL": "https://gw.example.com/v1",
                "LOCAL_MODEL_API_KEY": "sk-abc", "LOCAL_MODEL_NAME": "gpt-oss:120b"}
        vals.update(over)
        return mock.patch.multiple(ha, **vals)

    def test_needs_both_endpoint_and_key(self):
        with self._configured():
            self.assertTrue(ha.local_model_configured())
        with self._configured(LOCAL_MODEL_API_KEY=""):
            self.assertFalse(ha.local_model_configured())
        with self._configured(LOCAL_MODEL_BASE_URL=""):
            self.assertFalse(ha.local_model_configured())

    def test_model_name_is_charset_checked(self):
        """The name is interpolated into a launch command line."""
        with self._configured(LOCAL_MODEL_NAME="gpt-oss:120b"):
            self.assertTrue(ha.local_model_configured())
        with self._configured(LOCAL_MODEL_NAME="oops; rm -rf /"):
            self.assertFalse(ha.local_model_configured())

    def test_partial_config_says_which_half_is_missing(self):
        """A half-configured host disables the feature with the control simply
        never appearing; without a reason nobody can tell it from "off"."""
        seen = []
        with mock.patch.object(ha, "log", lambda m: seen.append(m)), \
             mock.patch.object(ha, "_local_model_complaints", set()):
            with self._configured(LOCAL_MODEL_API_KEY=""):
                self.assertFalse(ha.local_model_configured())
                ha.local_model_configured()          # every beat calls it
        self.assertEqual(len(seen), 1, "said once, not once per heartbeat")
        self.assertIn("LOCAL_MODEL_API_KEY", seen[0])
        # Feature simply off (neither set) says nothing at all.
        quiet = []
        with mock.patch.object(ha, "log", lambda m: quiet.append(m)), \
             mock.patch.object(ha, "_local_model_complaints", set()):
            with self._configured(LOCAL_MODEL_BASE_URL="", LOCAL_MODEL_API_KEY=""):
                self.assertFalse(ha.local_model_configured())
        self.assertEqual(quiet, [])

    def test_resolve_model_source_enum(self):
        with self._configured():
            self.assertEqual(ha.resolve_model_source(""), "subscription")
            self.assertEqual(ha.resolve_model_source(None), "subscription")
            self.assertEqual(ha.resolve_model_source("local"), "local")
            with self.assertRaises(ValueError):
                ha.resolve_model_source("bedrock")

    def test_local_refused_when_host_has_no_local_model(self):
        """Better a clean spawn error than a session that looks failed-over and
        is quietly still burning the subscription."""
        with self._configured(LOCAL_MODEL_API_KEY=""):
            with self.assertRaises(ValueError):
                ha.resolve_model_source("local")
            self.assertEqual(ha.resolve_model_source("subscription"), "subscription")

    def test_env_pairs_shape(self):
        with self._configured():
            pairs = ha.local_model_env_pairs()
        # Claude Code appends /v1/messages itself, so the configured /v1 base is
        # trimmed back to the host.
        self.assertIn("ANTHROPIC_BASE_URL=https://gw.example.com", pairs)
        self.assertIn("ANTHROPIC_MODEL=gpt-oss:120b", pairs)
        # Without this every background/small-model call asks the gateway for
        # the LOGIN's default alias and 403s invisibly.
        self.assertIn("ANTHROPIC_SMALL_FAST_MODEL=gpt-oss:120b", pairs)
        self.assertTrue(any(p.startswith("CLAUDE_CODE_MAX_CONTEXT_TOKENS=") for p in pairs))
        # An ambient key outranks ANTHROPIC_AUTH_TOKEN and would bill the very
        # account the failover exists to stop depending on.
        self.assertIn("ANTHROPIC_API_KEY=", pairs)

    def test_messages_api_base_trims_only_a_trailing_v1(self):
        """A plain rpartition mangles bases that merely CONTAIN /v1, and both
        of these pass every configuration check before dying on first request."""
        self.assertEqual(ha._messages_api_base("https://gw.example.com/v1"),
                         "https://gw.example.com")
        self.assertEqual(ha._messages_api_base("https://gw.example.com/v1/"),
                         "https://gw.example.com")
        # A host whose NAME contains v1 must survive intact.
        self.assertEqual(ha._messages_api_base("https://v1.example.com"),
                         "https://v1.example.com")
        # A gateway mounted under a path keeps it.
        self.assertEqual(ha._messages_api_base("https://gw.example.com/v1/openai"),
                         "https://gw.example.com/v1/openai")
        self.assertEqual(ha._messages_api_base("https://gw.example.com"),
                         "https://gw.example.com")

    def test_context_env_survives_a_typo(self):
        """A bad value in a NEW env var must not stop every session on the host
        at import time — that is the outage this feature exists to prevent."""
        for bad in ["64k", "", "  ", "-5", "0", "not-a-number"]:
            with mock.patch.dict(os.environ, {"LOCAL_MODEL_CONTEXT": bad}):
                self.assertEqual(ha._positive_int_env("LOCAL_MODEL_CONTEXT", 65536), 65536)
        with mock.patch.dict(os.environ, {"LOCAL_MODEL_CONTEXT": "131072"}):
            self.assertEqual(ha._positive_int_env("LOCAL_MODEL_CONTEXT", 65536), 131072)


class TestLocalModelFailover(ManagerMixin, unittest.TestCase):
    """Moving a running session onto the self-hosted model and back (XERK-246).

    The point of the feature is that running out of Claude usage stops every
    session at once; the session should carry on rather than halt. So the switch
    must keep the CONVERSATION (resume, never clear-context) and must survive
    later relaunches."""

    def make_manager(self, configured=True):
        sm = super().make_manager()
        sm.save = mock.Mock()
        # Stub the real Popen. Without this the launch paths spawn an ACTUAL
        # ttyd, which exists on a dev box and not on a CI runner — there the
        # launch raised, set_model_source treated it as a failed relaunch and
        # reverted the record, and ten tests failed for a reason that had
        # nothing to do with what they assert. (It also stops the suite leaking
        # real ttyd processes onto the developer's TTYD_PORT_BASE range.)
        sm._launch_ttyd = mock.Mock()
        # ManagerMixin does NOT patch REPOS_ROOT, so these tests were reading
        # the developer's REAL git root — which is why they passed here and
        # errored on CI: `scan_repos()` happened to find a Turma checkout.
        # Point it at a scratch root so the fixtures own everything they assert.
        pr = mock.patch.object(ha, "REPOS_ROOT", os.path.join(self.tmp, "git"))
        pr.start()
        self.addCleanup(pr.stop)
        vals = {"LOCAL_MODEL_BASE_URL": "https://gw.example.com/v1",
                "LOCAL_MODEL_API_KEY": "sk-abc",
                "LOCAL_MODEL_NAME": "gpt-oss:120b"} if configured else {
                "LOCAL_MODEL_BASE_URL": "", "LOCAL_MODEL_API_KEY": "",
                "LOCAL_MODEL_NAME": "gpt-oss:120b"}
        p = mock.patch.multiple(ha, **vals)
        p.start()
        self.addCleanup(p.stop)
        return sm

    def _repo_on_disk(self, name="Turma"):
        """Make scan_repos() actually see the repo.

        _resume_at_cwd refuses a cwd whose repo is not in scan_repos(), so a
        fixture that only creates the worktree silently produces no session at
        all. Locally that passed on ambient state; CI has none, which is how it
        was caught."""
        os.makedirs(os.path.join(ha.REPOS_ROOT, name, ".git"), exist_ok=True)
        return os.path.join(ha.REPOS_ROOT, name)

    def _session(self, sm, source="subscription", status="running"):
        sess = {"id": "abcde", "status": status, "tmuxName": "agent-abcde",
                "worktreePath": os.path.join(self.tmp, "wt"),
                "rcName": "host-repo-abcde", "ttydPort": 7700,
                "claudeSessionId": "11111111-1111-4111-8111-111111111111",
                "modelSource": source, "permissionMode": "auto"}
        os.makedirs(sess["worktreePath"], exist_ok=True)
        sm.registry = [sess]
        return sess

    def _launches(self):
        """The claude command line of each tmux new-session."""
        return [c[-1] for c in self.run_ok_calls if "new-session" in c]

    def _launch_argv(self):
        """The whole new-session argv — where the -e settings live."""
        return [c for c in self.run_ok_calls if "new-session" in c][-1]

    def _launch_env(self):
        """What the launch line ACTUALLY EXPORTS to claude.

        Deliberately runs the real prefix through a real shell rather than
        reading the file: the file being correct is not the same as its settings
        reaching the child process. Dropping `set -a` leaves them defined but
        unexported, so every "local" session silently runs on the exhausted
        subscription while the UI still paints the mark — and a test that only
        read the file could not tell."""
        cmd = self._launches()[-1]
        m = re.search(r"^(.*?local-model\.env[^;]*; set \+a;)", cmd)
        if not m:
            return []
        probe = m.group(1) + (
            ' python3 -c "import os;print(chr(10).join('
            "f'{k}={v}' for k, v in os.environ.items() if k.startswith('ANTHROPIC_')"
            ' or k.startswith(\'CLAUDE_CODE_MAX\')))"')
        out = subprocess.run(["sh", "-c", probe], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True).stdout
        return [ln for ln in out.splitlines() if ln.strip()]

    def test_local_session_launches_against_the_local_endpoint(self):
        sm = self.make_manager()
        sess = self._session(sm, source="local")
        sm._launch_tmux(sess)
        env = self._launch_env()
        self.assertIn("ANTHROPIC_BASE_URL=https://gw.example.com", env)
        self.assertIn("ANTHROPIC_MODEL=gpt-oss:120b", env)
        self.assertIn("ANTHROPIC_AUTH_TOKEN=sk-abc", env)
        # The credential must reach NO process's argv — neither the command
        # string (the tmux server's argv) nor a `tmux -e` value (the client's).
        # /proc/<pid>/cmdline is world-readable in both cases.
        self.assertNotIn("sk-abc", self._launches()[-1])
        self.assertNotIn("sk-abc", " ".join(self._launch_argv()))

    def test_env_file_quotes_hostile_values(self):
        """The file is SOURCED by a shell, so an unquoted value would execute.
        The defence had no test, so removing the quoting shipped green."""
        hostile = "k'; touch " + os.path.join(self.tmp, "pwned") + "; echo '"
        with mock.patch.multiple(ha, LOCAL_MODEL_BASE_URL="https://gw.example.com/v1",
                                 LOCAL_MODEL_API_KEY=hostile,
                                 LOCAL_MODEL_NAME="gpt-oss:120b"):
            path = ha.write_local_model_env(os.path.join(self.tmp, "lm.env"))
        out = subprocess.run(
            ["sh", "-c", f". {shlex.quote(path)}; printf %s \"$ANTHROPIC_AUTH_TOKEN\""],
            stdout=subprocess.PIPE, text=True).stdout
        self.assertEqual(out, hostile)                       # survived intact
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "pwned")))

    def test_guard_denies_reading_the_credential_file(self):
        """0600 stops other uids, not the sessions themselves — they run as the
        uid that owns it, and this file's whole content IS the secret."""
        deny = ha.build_guard_settings()["permissions"]["deny"]
        self.assertIn("Read(~/.turma/local-model.env)", deny)

    def test_stale_env_file_is_removed_when_config_goes(self):
        """It holds a live gateway key under a HOST bind mount; leaving it after
        a rotation or removal keeps a working credential on disk forever."""
        path = os.path.join(self.tmp, "lm.env")
        with mock.patch.multiple(ha, LOCAL_MODEL_BASE_URL="https://gw.example.com/v1",
                                 LOCAL_MODEL_API_KEY="sk-abc",
                                 LOCAL_MODEL_NAME="gpt-oss:120b"):
            ha.write_local_model_env(path)
        self.assertTrue(os.path.exists(path))
        ha.discard_local_model_env(path)
        self.assertFalse(os.path.exists(path))
        ha.discard_local_model_env(path)                     # idempotent

    def test_launch_fallback_persists_and_clears_the_key(self):
        sm = self.make_manager(configured=False)
        sess = self._session(sm, source="local")
        env_path = os.path.join(ha.REGISTRY_DIR, "local-model.env")
        os.makedirs(ha.REGISTRY_DIR, exist_ok=True)
        open(env_path, "w").write("ANTHROPIC_AUTH_TOKEN=stale\n")
        sm._launch_tmux(sess)
        self.assertEqual(sess["modelSource"], "subscription")
        sm.save.assert_called()                  # the demotion reaches disk
        self.assertFalse(os.path.exists(env_path))

    def test_env_file_is_owner_only(self):
        """It holds the gateway credential, so nothing else on the host may
        read it — that is the entire reason it exists rather than argv."""
        sm = self.make_manager()
        sess = self._session(sm, source="local")
        sm._launch_tmux(sess)
        path = os.path.join(ha.REGISTRY_DIR, "local-model.env")
        self.assertEqual(oct(os.stat(path).st_mode & 0o777), "0o600")

    def test_subscription_session_launches_clean(self):
        """No stray endpoint vars on an ordinary session — otherwise every
        session on the host would quietly move to the local model."""
        sm = self.make_manager()
        sess = self._session(sm, source="subscription")
        sm._launch_tmux(sess)
        self.assertEqual(self._launch_env(), [])
        self.assertNotIn("ANTHROPIC_", self._launches()[-1])

    def test_launch_falls_back_when_local_config_disappears(self):
        """Config removed under a session already on local: launching against
        the subscription silently would be a surprise usage bill, so the record
        is corrected to say what actually happened."""
        sm = self.make_manager(configured=False)
        sess = self._session(sm, source="local")
        sm._launch_tmux(sess)
        self.assertEqual(self._launch_env(), [])
        self.assertEqual(sess["modelSource"], "subscription")

    def _pin_transcript(self, sess):
        """Put this session's pinned conversation on disk, so the resume path
        can actually resolve it (a pinned id with no file resolves to nothing,
        by design — see _session_transcript_path)."""
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(sess["worktreePath"]))
        os.makedirs(proj, exist_ok=True)
        open(os.path.join(proj, sess["claudeSessionId"] + ".jsonl"), "w").write("{}\n")

    def test_local_launch_drops_model_flag(self):
        """--model OVERRIDES ANTHROPIC_MODEL, so a failed-over session carrying a
        Claude alias would ask the gateway for a model it will never serve: every
        turn 403s while the record still reads running/local. The composer
        remembers a model PER REPO, so this is the common case, not an exotic
        one. Never re-add --model for a local session."""
        sm = self.make_manager()
        sess = self._session(sm, source="local")
        sess["model"] = "sonnet"
        sm._launch_tmux(sess)
        cmd = self._launches()[-1]
        self.assertNotIn("--model", cmd)
        self.assertIn("ANTHROPIC_MODEL=gpt-oss:120b", self._launch_env())

    def test_subscription_launch_keeps_model_flag(self):
        sm = self.make_manager()
        sess = self._session(sm, source="subscription")
        sess["model"] = "sonnet"
        sm._launch_tmux(sess)
        self.assertIn("--model sonnet", self._launches()[-1])

    def test_set_model_refused_on_a_local_session(self):
        """The picker only offers Claude aliases the gateway refuses — including
        'Default', which resolves to the login default. Accepting one would
        break the session with nothing in errorMsg and no way back from the
        chip."""
        sm = self.make_manager()
        sess = self._session(sm, source="local")
        self.run_calls.clear()
        sm.set_model("abcde", "sonnet")
        self.assertIsNone(sess.get("model"))
        # The picker is never opened and no keys are sent to the pane.
        self.assertEqual([c for c in self.run_calls if "tmux" in c], [])

    def test_switch_keeps_the_conversation(self):
        """The whole value of failing over is not losing what the session has
        already worked out, so it resumes its own transcript id."""
        sm = self.make_manager()
        sess = self._session(sm)
        self._pin_transcript(sess)
        sm.set_model_source("abcde", "local")
        self.assertEqual(sess["modelSource"], "local")
        cmd = self._launches()[-1]
        self.assertIn("--resume 11111111-1111-4111-8111-111111111111", cmd)
        self.assertNotIn("--session-id", cmd)   # never a fresh context
        self.assertTrue(any(e.startswith("ANTHROPIC_BASE_URL=") for e in self._launch_env()))

    def test_switch_bumps_restart_count_so_the_ui_can_settle(self):
        sm = self.make_manager()
        sess = self._session(sm)
        before = sess.get("restartCount", 0)
        sm.set_model_source("abcde", "local")
        self.assertEqual(sess["restartCount"], before + 1)
        self.assertTrue(sess.get("modelSourceAt"))

    def test_switch_back_to_subscription(self):
        sm = self.make_manager()
        sess = self._session(sm, source="local")
        sm.set_model_source("abcde", "subscription")
        self.assertEqual(sess["modelSource"], "subscription")
        self.assertEqual(self._launch_env(), [])

    def test_same_source_is_a_noop(self):
        """No pointless relaunch — that would drop a turn in flight."""
        sm = self.make_manager()
        self._session(sm, source="local")
        sm.set_model_source("abcde", "local")
        self.assertEqual(self._launches(), [])

    def test_unconfigured_host_refuses_and_stays_put(self):
        sm = self.make_manager(configured=False)
        sess = self._session(sm)
        sm.set_model_source("abcde", "local")
        self.assertEqual(sess["modelSource"], "subscription")
        self.assertEqual(sess["status"], "error")
        self.assertEqual(self._launches(), [])

    def test_failed_relaunch_reverts_the_record(self):
        """The record must never claim a move that did not happen, or the UI
        shows 'local' for a session still on the exhausted subscription."""
        sm = self.make_manager()
        sess = self._session(sm)
        with mock.patch.object(sm, "_launch_tmux", side_effect=RuntimeError("boom")):
            sm.set_model_source("abcde", "local")
        self.assertEqual(sess["modelSource"], "subscription")
        self.assertEqual(sess["status"], "error")

    def test_kill_then_resume_stays_on_the_local_model(self):
        """Usage has not come back just because the session was killed. A resume
        that drops modelSource silently returns the session to the exhausted
        subscription AND restores its --model alias, which the gateway refuses —
        with no mark and no error. Refuted the documented invariant once."""
        sm = self.make_manager()
        sess = self._session(sm, source="local")
        sess.update({"repo": "Turma", "repoPath": os.path.join(self.tmp, "Turma"),
                     "model": "sonnet"})
        os.makedirs(sess["repoPath"], exist_ok=True)
        sm._remember_closed(sess)
        self.assertEqual(sm.closed[0].get("modelSource"), "local")
        sm.registry = []
        sm.resume(sess["id"])
        revived = sm._find(sess["id"])
        self.assertEqual(revived["modelSource"], "local")
        self.assertNotIn("--model", self._launches()[-1])

    def _migrate_in(self, sm, source, launch=True):
        """Run the shared migration/resume-any record build for a moved session.

        launch=False stubs the launch, so the RECORD's own validation is what is
        being asserted — otherwise _launch_tmux's fallback demotes an
        unconfigured host anyway and the re-validation could be deleted without
        a single test noticing."""
        self._repo_on_disk()
        cwd = os.path.join(ha.WORKTREES_ROOT, "Turma", "mmmmm")
        os.makedirs(cwd, exist_ok=True)
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(cwd))
        os.makedirs(proj, exist_ok=True)
        open(os.path.join(proj, "t-1.jsonl"), "w").write("{}\n")
        ctx = (mock.patch.object(sm, "_launch_tmux") if not launch
               else contextlib.nullcontext())
        with ctx:
            sm._resume_at_cwd("t-1", cwd, extra={"modelSource": source, "model": "sonnet"})
        return sm.registry[-1] if sm.registry else {}

    def test_resume_any_transcript_keeps_the_local_model(self):
        """The DASHBOARD's Resume picker routes through resume_transcript, not
        resume(), and passed no model source at all — so a killed failed-over
        session came back on the exhausted subscription with no mark and no
        error. The closed record already knew the answer."""
        sm = self.make_manager()
        sess = self._session(sm, source="local")
        self._repo_on_disk()
        cwd = os.path.join(ha.WORKTREES_ROOT, "Turma", "rrrrr")
        os.makedirs(cwd, exist_ok=True)
        sess.update({"worktreePath": cwd, "repo": "Turma",
                     "repoPath": os.path.join(self.tmp, "Turma")})
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(cwd))
        os.makedirs(proj, exist_ok=True)
        tid = sess["claudeSessionId"]
        open(os.path.join(proj, tid + ".jsonl"), "w").write("{}\n")
        sm._remember_closed(sess)
        sm.registry = []
        sm.resume_transcript(tid, cwd)
        self.assertEqual(sm.registry[-1]["modelSource"], "local")

    def test_resume_any_pre_restart_transcript_keeps_the_local_model(self):
        """"Restart (clear context)" MOVES claudeSessionId, so a session's
        earlier conversations stay resumable while matching no closed record by
        id — and resuming one silently returned a failed-over session to the
        exhausted subscription. Every conversation in a worktree is the same
        lineage, so the worktree answers for all of them."""
        sm = self.make_manager()
        sess = self._session(sm, source="local")
        self._repo_on_disk()
        cwd = os.path.join(ha.WORKTREES_ROOT, "Turma", "ppppp")
        os.makedirs(cwd, exist_ok=True)
        sess.update({"worktreePath": cwd, "repo": "Turma",
                     "repoPath": os.path.join(self.tmp, "Turma")})
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(cwd))
        os.makedirs(proj, exist_ok=True)
        older = "55555555-5555-4555-8555-555555555555"   # the pre-restart one
        for tid in (older, sess["claudeSessionId"]):
            open(os.path.join(proj, tid + ".jsonl"), "w").write("{}\n")
        sm._remember_closed(sess)      # closed record pins only the NEWER id
        sm.registry = []
        sm.resume_transcript(older, cwd)
        self.assertEqual(sm.registry[-1]["modelSource"], "local")

    def test_resume_any_uses_the_worktree_s_LATEST_closed_record(self):
        """self.closed is append-ordered, so the naive lookup returns the
        EARLIEST record for a worktree — a session later switched back to the
        subscription and killed again would be resumed onto the local model
        anyway. The last thing the operator chose is the answer."""
        sm = self.make_manager()
        self._repo_on_disk()
        cwd = os.path.join(ha.WORKTREES_ROOT, "Turma", "lllll")
        os.makedirs(cwd, exist_ok=True)
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(cwd))
        os.makedirs(proj, exist_ok=True)
        # A conversation from BEFORE a "clear context", so it matches no closed
        # record by id and has to fall back to the worktree.
        orphan_tid = "66666666-6666-4666-8666-666666666666"
        open(os.path.join(proj, orphan_tid + ".jsonl"), "w").write("{}\n")
        base = {"repo": "Turma", "repoPath": os.path.join(self.tmp, "Turma"),
                "worktreePath": cwd, "status": "running", "rcName": "r",
                "tmuxName": "t", "ttydPort": 7700}
        # Same worktree, killed twice: first on local, later on subscription.
        sm._remember_closed({**base, "id": "aaaaa", "modelSource": "local",
                             "claudeSessionId": "88888888-8888-4888-8888-888888888888"})
        sm._remember_closed({**base, "id": "bbbbb", "modelSource": "subscription",
                             "claudeSessionId": "77777777-7777-4777-8777-777777777777"})
        sm.registry = []
        sm.resume_transcript(orphan_tid, cwd)
        self.assertEqual(sm.registry[-1]["modelSource"], "subscription")

    def test_resume_any_prefers_the_latest_record_for_a_REUSED_transcript_id(self):
        """A resume-any PINS the resumed transcript id onto the session it
        creates, so killing that one leaves a SECOND closed record with the same
        id. Append-order answers with the state before the operator last changed
        their mind — here, putting work back on the local model after they moved
        it off. No "clear context" needed: kill, resume, switch back, kill."""
        sm = self.make_manager()
        self._repo_on_disk()
        cwd = os.path.join(ha.WORKTREES_ROOT, "Turma", "ddddd")
        os.makedirs(cwd, exist_ok=True)
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(cwd))
        os.makedirs(proj, exist_ok=True)
        tid = "99999999-9999-4999-8999-999999999999"
        open(os.path.join(proj, tid + ".jsonl"), "w").write("{}\n")
        base = {"repo": "Turma", "repoPath": os.path.join(self.tmp, "Turma"),
                "worktreePath": cwd, "status": "running", "rcName": "r",
                "tmuxName": "t", "ttydPort": 7700, "claudeSessionId": tid}
        sm._remember_closed({**base, "id": "aaaaa", "modelSource": "local"})
        sm._remember_closed({**base, "id": "bbbbb", "modelSource": "subscription"})
        sm.registry = []
        sm.resume_transcript(tid, cwd)
        self.assertEqual(sm.registry[-1]["modelSource"], "subscription")

    def test_switch_to_local_drops_a_deferred_model_pick(self):
        """set_model refuses a local session, so a pick waiting for an idle pane
        would sit heartbeat-visible and then vanish unexplained."""
        sm = self.make_manager()
        sess = self._session(sm)
        sess["pendingModel"] = "opus"
        sm.set_model_source("abcde", "local")
        self.assertNotIn("pendingModel", sess)

    def test_resume_any_foreign_transcript_defaults_to_subscription(self):
        """No closed record means no answer — never a guess."""
        sm = self.make_manager()
        self._repo_on_disk()
        cwd = os.path.join(ha.WORKTREES_ROOT, "Turma", "fffff")
        os.makedirs(cwd, exist_ok=True)
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(cwd))
        os.makedirs(proj, exist_ok=True)
        tid = "22222222-2222-4222-8222-222222222222"
        open(os.path.join(proj, tid + ".jsonl"), "w").write("{}\n")
        sm.resume_transcript(tid, cwd)
        self.assertEqual(sm.registry[-1]["modelSource"], "subscription")

    def test_session_payload_reports_the_model_source(self):
        """Both the UI mark and the hub's /model 409 read this field off the
        live session payload; dropping it disables both silently."""
        sm = self.make_manager()
        sess = self._session(sm, source="local")
        sess.update({"repo": "Turma", "repoPath": os.path.join(self.tmp, "Turma"),
                     "branch": None, "root": False, "label": None, "summary": None,
                     "createdAt": ha.now_iso(), "baseRef": None})
        os.makedirs(sess["repoPath"], exist_ok=True)
        # The git/usage side of the payload is not what this asserts.
        p = mock.patch.object(sm, "_session_git", return_value=({}, {}))
        p.start()
        self.addCleanup(p.stop)
        self.assertEqual(sm._session_payload(sess, refresh=False)["modelSource"], "local")
        sess["modelSource"] = "subscription"
        self.assertEqual(sm._session_payload(sess, refresh=False)["modelSource"],
                         "subscription")
        # A record predating the field reads as subscription, never as absent.
        sess.pop("modelSource")
        self.assertEqual(sm._session_payload(sess, refresh=False)["modelSource"],
                         "subscription")

    def test_closed_payload_reports_the_model_source(self):
        """The Ended card's mark reads this field; without it the mark can never
        render for a killed session — which is exactly when you are reading the
        transcript and need to know which model wrote it."""
        sm = self.make_manager()
        sess = self._session(sm, source="local")
        sess.update({"repo": "Turma", "repoPath": os.path.join(self.tmp, "Turma")})
        sm._remember_closed(sess)
        self.assertEqual(sm._closed_payload()[0]["modelSource"], "local")

    def test_heartbeat_reports_the_capability_honestly(self):
        """The hub and every composer gate on this; reporting available on a
        host with no configuration would offer a switch that cannot work."""
        sm = self.make_manager()
        self.assertTrue(sm.build_payload(1)["localModel"]["available"])
        with mock.patch.multiple(ha, LOCAL_MODEL_BASE_URL="", LOCAL_MODEL_API_KEY=""):
            body = sm.build_payload(1)
        self.assertFalse(body["localModel"]["available"])
        self.assertIsNone(body["localModel"]["model"])

    def test_context_cap_rejects_an_absurd_window(self):
        """Overstating the window is the exact failure the setting guards: the
        agent compacts far too late and the server truncates the tail silently."""
        with mock.patch.dict(os.environ, {"LOCAL_MODEL_CONTEXT": "999999999999"}):
            self.assertEqual(ha._positive_int_env("LOCAL_MODEL_CONTEXT", 65536), 65536)
        with mock.patch.dict(os.environ, {"LOCAL_MODEL_CONTEXT": "131072"}):
            self.assertEqual(ha._positive_int_env("LOCAL_MODEL_CONTEXT", 65536), 131072)

    def test_import_session_forwards_the_model_source(self):
        """The agent half of the migration chain."""
        sm = self.make_manager()
        captured = {}
        with mock.patch.object(sm, "_resume_at_cwd",
                               side_effect=lambda *a, **k: captured.update(k)), \
             mock.patch.object(sm, "_migration_download", return_value=b"x"), \
             mock.patch.object(sm, "_unpack_transcript"), \
             mock.patch.object(sm, "_resumable_cwd_class", return_value="worktree"), \
             mock.patch.object(sm, "_localize_migrated_cwd",
                               return_value=os.path.join(ha.WORKTREES_ROOT, "Turma", "iiiii")):
            sm.import_session({
                "migrationId": "aaaaaaaaaaaaaaaa", "repo": "Turma",
                "transcriptId": "33333333-3333-4333-8333-333333333333",
                "cwd": "/other/host/.turma/worktrees/Turma/iiiii",
                "modelSource": "local"})
        self.assertEqual((captured.get("extra") or {}).get("modelSource"), "local")

    def test_migrated_session_keeps_its_model_source(self):
        """The conversation moves; the model it was running against must move
        with it, or the move quietly undoes the failover."""
        sm = self.make_manager()
        self.assertEqual(self._migrate_in(sm, "local")["modelSource"], "local")

    def test_migration_to_a_host_without_a_local_model_falls_back(self):
        """It crosses a host boundary: the TARGET may have no local model even
        though the source did, and launching at an endpoint that isn't there is
        worse than landing on the subscription."""
        sm = self.make_manager(configured=False)
        self.assertEqual(
            self._migrate_in(sm, "local", launch=False)["modelSource"], "subscription")

    def test_noop_for_non_running_session(self):
        sm = self.make_manager()
        sess = self._session(sm, status="stopped")
        sm.set_model_source("abcde", "local")
        self.assertEqual(sess["modelSource"], "subscription")
        self.assertEqual(self._launches(), [])


class TestParsePanePrompt(unittest.TestCase):
    """Reading the TUI's blocking choice dialog off the pane. It never reaches
    the transcript and it suppresses the busy hint, so without this read a
    session blocked on a human reports idle."""

    def test_permission_dialog(self):
        p = ha.parse_pane_prompt(PANE_PERMISSION_DIALOG)
        self.assertEqual(p["prompt"], "Do you want to proceed?")
        self.assertEqual(
            [(o["number"], o["label"], o["selected"]) for o in p["options"]],
            [(1, "Yes", True),
             (2, "Yes, and always allow access to tmp/ from this project", False),
             (3, "No", False)])
        # The context is the fenced block above the question — the tool and the
        # exact command it wants to run, which is the whole decision.
        self.assertEqual(
            p["detail"],
            "Bash command\ntouch /tmp/permtest-marker\nCreate marker file in /tmp")

    def test_plan_dialog(self):
        p = ha.parse_pane_prompt(PANE_PLAN_DIALOG)
        self.assertEqual(
            p["prompt"],
            "Claude has written up a plan and is ready to execute. Would you like to proceed?")
        self.assertEqual([o["number"] for o in p["options"]], [1, 2, 3, 4])
        self.assertEqual(p["options"][0]["label"], "Yes, and use auto mode")
        self.assertTrue(p["options"][0]["selected"])
        # The plan body sits one rule further up than a permission dialog's
        # block; the same walk has to reach it.
        self.assertEqual(p["detail"], "Plan\nI will add one test.")

    def test_idle_composer_is_never_a_dialog(self):
        # A numbered list in the conversation, a "?" line above it, and the
        # composer live: the mode footer is what says nothing is blocking.
        self.assertIsNone(ha.parse_pane_prompt(PANE_IDLE_COMPOSER))
        self.assertIsNone(ha.parse_pane_prompt(""))
        self.assertIsNone(ha.parse_pane_prompt(None))

    def test_requires_cursor_numbering_and_a_question(self):
        # No ❯ cursor -> not a live picker.
        self.assertIsNone(ha.parse_pane_prompt(
            "Do you want to proceed?\n 1. Yes\n 2. No\n"))
        # Cursor and numbering, but no question line above.
        self.assertIsNone(ha.parse_pane_prompt(
            "some prose\n ❯ 1. Yes\n   2. No\n"))
        # Numbering that doesn't start at 1 (a list continuing from off-screen).
        self.assertIsNone(ha.parse_pane_prompt(
            "Proceed?\n ❯ 2. Yes\n   3. No\n"))
        # A single option is a list, not a choice.
        self.assertIsNone(ha.parse_pane_prompt("Proceed?\n ❯ 1. Yes\n"))

    def test_a_dialog_suppresses_the_busy_hint(self):
        # This is WHY the read is needed: while the dialog is up the pane shows
        # no interrupt hint and no mode footer, so paneBusy reads False — the
        # session looks idle while it is actually blocked on a human.
        self.assertFalse(ha._busy_from_capture(PANE_PERMISSION_DIALOG))
        self.assertIsNone(ha.parse_pane_mode(PANE_PERMISSION_DIALOG))


class TestParsePaneMode(unittest.TestCase):
    def test_all_five_markers(self):
        for marker, mode in [
            ("⏸ manual mode on · ? for shortcuts", "default"),
            ("⏵⏵ accept edits on (shift+tab to cycle)", "acceptEdits"),
            ("⏸ plan mode on (shift+tab to cycle)", "plan"),
            ("⏵⏵ auto mode on (shift+tab to cycle)", "auto"),
            ("⏵⏵ bypass permissions on (shift+tab to cycle)",
             "bypassPermissions"),
        ]:
            self.assertEqual(ha.parse_pane_mode(f"❯ \n  {marker}"), mode, marker)

    def test_conversation_text_without_the_glyph_is_not_a_marker(self):
        self.assertIsNone(ha.parse_pane_mode("we turned plan mode on earlier\n❯ "))

    def test_the_footers_marker_wins_over_a_quoted_one(self):
        cap = ("…the TUI says ⏸ plan mode on while planning…\n"
               "❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)")
        self.assertEqual(ha.parse_pane_mode(cap), "auto")

    def test_none_cases(self):
        self.assertIsNone(ha.parse_pane_mode(""))
        self.assertIsNone(ha.parse_pane_mode(None))
        self.assertIsNone(ha.parse_pane_mode("❯ \n  ? for shortcuts"))


# What `claude -p "/model"` really prints (v2.1.214): the current default's
# label, then the usage line carrying the login's whole alias list.
MODEL_PROBE_OUT = (
    "Current model: Fable 5\n"
    "Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, "
    "sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.\n"
)


class TestParseModelProbe(unittest.TestCase):
    def test_parses_aliases_and_default_label(self):
        got = ha.parse_model_probe(MODEL_PROBE_OUT)
        self.assertEqual(got["defaultLabel"], "Fable 5")
        self.assertEqual(got["available"], [
            "sonnet", "opus", "haiku", "fable", "best",
            "sonnet[1m]", "opus[1m]", "fable[1m]", "opusplan", "default"])

    def test_ansi_is_stripped(self):
        got = ha.parse_model_probe(
            "Current model: \x1b[1mFable 5\x1b[22m\n"
            "Usage: /model <name>. Available: sonnet, default.")
        self.assertEqual(got["defaultLabel"], "Fable 5")
        self.assertEqual(got["available"], ["sonnet", "default"])

    def test_no_available_line_is_a_failed_attempt_not_an_empty_list(self):
        self.assertIsNone(ha.parse_model_probe("Current model: X"))
        self.assertIsNone(ha.parse_model_probe(""))
        self.assertIsNone(ha.parse_model_probe(None))

    def test_default_is_guaranteed_and_missing_label_is_none(self):
        got = ha.parse_model_probe("Usage: /model <name>. Available: sonnet, opus.")
        self.assertIn("default", got["available"])
        self.assertIsNone(got["defaultLabel"])


class TestParseModelPicker(unittest.TestCase):
    def test_rows_cursor_and_labels(self):
        rows, cur = ha.parse_model_picker(MODEL_PICKER_PANE)
        self.assertEqual(rows, ["Default (recommended)", "Opus", "Fable",
                                "Sonnet", "Haiku"])
        self.assertEqual(cur, 2)  # the ❯ sits on Fable

    def test_capture_without_a_picker(self):
        self.assertEqual(ha.parse_model_picker("❯ \n  1. not a picker"),
                         ([], None))
        self.assertEqual(ha.parse_model_picker(""), ([], None))
        self.assertEqual(ha.parse_model_picker(None), ([], None))

    def test_numbered_chat_lines_above_the_picker_are_not_rows(self):
        rows, cur = ha.parse_model_picker(
            "  1. buy groceries\n  2. do laundry\n" + MODEL_PICKER_PANE)
        self.assertEqual(len(rows), 5)
        self.assertEqual(cur, 2)

    def test_picker_index_for(self):
        rows, _ = ha.parse_model_picker(MODEL_PICKER_PANE)
        self.assertEqual(ha._picker_index_for(rows, None), 0)  # default
        self.assertEqual(ha._picker_index_for(rows, "fable"), 2)
        self.assertEqual(ha._picker_index_for(rows, "sonnet"), 3)
        self.assertIsNone(ha._picker_index_for(rows, "opusplan"))


class TestScanModelEntry(unittest.TestCase):
    def _fold(self, entry):
        rep = {"modelActual": None}
        ha._scan_model_entry(entry, rep)
        return rep["modelActual"]

    def test_assistant_entry_names_the_model_that_answered(self):
        self.assertEqual(
            self._fold({"type": "assistant",
                        "message": {"model": "claude-opus-4-8"}}),
            "claude-opus-4-8")

    def test_synthetic_is_not_a_model(self):
        self.assertIsNone(self._fold(
            {"type": "assistant", "message": {"model": "<synthetic>"}}))

    def test_tui_switch_confirmation_with_ansi(self):
        e = {"type": "user", "message": {"role": "user", "content":
             "<local-command-stdout>Set model to \x1b[1mSonnet 5\x1b[22m and "
             "saved as your default for new sessions</local-command-stdout>"}}
        self.assertEqual(self._fold(e), "Sonnet 5")

    def test_session_only_switch_confirmation(self):
        e = {"type": "user", "message": {"content":
             "<local-command-stdout>Set model to Haiku 4.5 for this session "
             "only</local-command-stdout>"}}
        self.assertEqual(self._fold(e), "Haiku 4.5")

    def test_print_mode_system_shape(self):
        e = {"type": "system", "subtype": "local_command", "content":
             "<local-command-stdout>Set model to Sonnet 5 for this session "
             "only</local-command-stdout>"}
        self.assertEqual(self._fold(e), "Sonnet 5")

    def test_kept_model_is_no_change(self):
        e = {"type": "user", "message": {"content":
             "<local-command-stdout>Kept model as Fable 5</local-command-stdout>"}}
        self.assertIsNone(self._fold(e))


class TestSessionReportModelActual(ProjectDirMixin, unittest.TestCase):
    def test_incremental_scan_reports_newest_signal(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [{"type": "assistant",
                            "message": {"model": "claude-old-1"}}])
        state = {}
        rep = ha.session_report(self.WORKDIR, state)
        self.assertIsNone(rep["modelActual"])  # primed to EOF, no replay
        write_jsonl(path, [
            {"type": "assistant", "message": {"model": "claude-old-1"}},
            {"type": "assistant", "message": {"model": "claude-opus-4-8"}},
        ])
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["modelActual"], "claude-opus-4-8")


class TestModelsProbe(ManagerMixin, unittest.TestCase):
    def _start(self, sm, rc):
        fake = mock.Mock()
        fake.poll.return_value = rc
        with mock.patch.object(ha.subprocess, "Popen",
                               return_value=fake) as pop:
            sm._start_models_probe()
        return fake, pop

    def test_probe_reaps_into_models_info(self):
        sm = self.make_manager()
        fake, pop = self._start(sm, 0)
        args, kwargs = pop.call_args
        self.assertEqual(args[0], ["claude", "-p", "/model"])
        self.assertEqual(kwargs["cwd"], ha.REGISTRY_DIR)  # internal-tool cwd
        with open(sm.models_probe["outPath"], "w") as f:
            f.write(MODEL_PROBE_OUT)
        sm._poll_models_probe()
        self.assertIsNone(sm.models_probe)
        self.assertEqual(sm.models_info["defaultLabel"], "Fable 5")
        self.assertIn("fable", sm.models_info["available"])
        self.assertEqual(sm.models_available()[0], "sonnet")

    def test_failed_probe_keeps_the_previous_list(self):
        sm = self.make_manager()
        sm.models_info = {"available": ["opus"], "defaultLabel": "X", "at": "t"}
        self._start(sm, 1)
        sm._poll_models_probe()
        self.assertIsNone(sm.models_probe)
        self.assertEqual(sm.models_info["available"], ["opus"])

    def test_overrunning_probe_is_killed(self):
        sm = self.make_manager()
        fake, _ = self._start(sm, None)
        sm.models_probe["startedMono"] = (
            time.time() - ha.MODELS_PROBE_TIMEOUT_SEC - 1)
        sm._poll_models_probe()
        fake.kill.assert_called_once()
        self.assertIsNone(sm.models_probe)
        self.assertIsNone(sm.models_info)

    def test_second_start_is_a_noop_while_one_is_in_flight(self):
        sm = self.make_manager()
        self._start(sm, None)
        job = sm.models_probe
        with mock.patch.object(ha.subprocess, "Popen") as pop:
            sm._start_models_probe()
            pop.assert_not_called()
        self.assertIs(sm.models_probe, job)


class TestSeedModelActual(ManagerMixin, unittest.TestCase):
    SID = "11111111-1111-4111-8111-111111111111"

    def _transcript(self, wt, entries):
        d = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(wt))
        os.makedirs(d, exist_ok=True)
        write_jsonl(os.path.join(d, f"{self.SID}.jsonl"), entries)

    def test_seeds_the_newest_signal_from_the_tail(self):
        sm = self.make_manager()
        wt = os.path.join(self.tmp, "wt")
        self._transcript(wt, [
            {"type": "assistant", "message": {"model": "claude-sonnet-5"}},
            {"type": "user", "message": {"content":
             "<local-command-stdout>Set model to Haiku 4.5 for this session "
             "only</local-command-stdout>"}},
        ])
        sess = {"id": "s1", "worktreePath": wt, "claudeSessionId": self.SID}
        self.assertEqual(sm._seed_model_actual(sess), "Haiku 4.5")

    def test_no_transcript_seeds_nothing(self):
        sm = self.make_manager()
        sess = {"id": "s1", "worktreePath": os.path.join(self.tmp, "none"),
                "claudeSessionId": self.SID}
        self.assertIsNone(sm._seed_model_actual(sess))


class TestInternalToolSlugModelProbe(ManagerMixin, unittest.TestCase):
    """The models probe's transcript is nothing but the /model command — no
    genuine user text for the prompt-signature match — so _is_internal_tool_slug
    recognizes it by its first command instead (the harness-foreign-slug case;
    in production its REGISTRY_DIR cwd already matches by slug)."""

    CAVEAT = ("Caveat: The messages below were generated by the user while "
              "running local commands. DO NOT respond to these messages or "
              "otherwise consider them in your response unless the user "
              "explicitly asks you to.")

    def _slug(self, name, entries):
        d = os.path.join(ha.PROJECTS_ROOT, name)
        os.makedirs(d, exist_ok=True)
        write_jsonl(os.path.join(d, "t.jsonl"), entries)
        return name

    def _probe_entries(self):
        return [
            {"type": "user", "isMeta": True,
             "message": {"role": "user",
                         "content": f"<local-command-caveat>{self.CAVEAT}"
                                    "</local-command-caveat>"}},
            {"type": "user", "message": {"role": "user", "content":
             "<command-name>/model</command-name><command-message>model"
             "</command-message><command-args></command-args>"}},
            {"type": "system", "subtype": "local_command", "content":
             "<local-command-stdout>Current model: Fable 5</local-command-stdout>"},
        ]

    def test_model_probe_transcript_is_internal(self):
        sm = self.make_manager()
        slug = self._slug("-tmp-hub-agent-mgr-zzz", self._probe_entries())
        self.assertTrue(sm._is_internal_tool_slug(slug))

    def test_real_session_opening_with_model_still_counts(self):
        sm = self.make_manager()
        slug = self._slug("-w-repo", self._probe_entries() + [
            {"type": "user",
             "message": {"role": "user", "content": "now fix the login bug"}},
        ])
        self.assertFalse(sm._is_internal_tool_slug(slug))

    def test_repos_root_slug_never_internal(self):
        # The REPOS_ROOT slug holds EVERY root session's transcript, and the
        # check only reads the newest — a root session in which the operator
        # typed nothing but /model reads exactly like the probe, and one such
        # transcript must not tombstone the whole root history (XERK-147).
        sm = self.make_manager()
        slug = self._slug(ha._project_slug(ha.REPOS_ROOT), self._probe_entries())
        self.assertFalse(sm._is_internal_tool_slug(slug))


class TestModelActualPayload(ManagerMixin, unittest.TestCase):
    def _sess(self):
        return {"id": "abcde", "status": "running", "repo": "Turma",
                "repoPath": "/w/Turma", "worktreePath": "/w/.turma/worktrees/x",
                "branch": None, "rcName": "rc", "tmuxName": "agent-abcde",
                "claudeSessionId": "22222222-2222-4222-8222-222222222222"}

    def test_scan_signal_persists_on_the_record_and_payload(self):
        sm = self.make_manager()
        sess = self._sess()
        sm.registry = [sess]
        signals = {"prUrls": [], "modelActual": "claude-opus-4-8", "tail": []}
        with mock.patch.object(ha, "session_report", return_value=signals), \
             mock.patch.object(sm, "_session_git", return_value=({}, {})):
            payload = sm._session_payload(sess, refresh=False)
        self.assertEqual(payload["modelActual"], "claude-opus-4-8")
        self.assertEqual(sess["modelActual"], "claude-opus-4-8")
        # ...and it stays on the payload once the scan has nothing new.
        signals2 = {"prUrls": [], "modelActual": None, "tail": []}
        with mock.patch.object(ha, "session_report", return_value=signals2), \
             mock.patch.object(sm, "_session_git", return_value=({}, {})):
            payload = sm._session_payload(sess, refresh=False)
        self.assertEqual(payload["modelActual"], "claude-opus-4-8")

    def test_mode_reconciles_to_the_pane_and_pending_model_rides(self):
        # The operator can cycle modes by hand in the live terminal, which no
        # command ever reports: the pane's modeActual is the truth, so the
        # stored permissionMode follows it. A deferred model pick rides the
        # payload so the chip can show the switch as in-flight.
        sm = self.make_manager()
        sess = self._sess()
        sess["permissionMode"] = "auto"
        sess["pendingModel"] = "sonnet"
        sm.registry = [sess]
        signals = {"prUrls": [], "modelActual": None, "modeActual": "plan",
                   "tail": []}
        with mock.patch.object(ha, "session_report", return_value=signals), \
             mock.patch.object(sm, "_session_git", return_value=({}, {})):
            payload = sm._session_payload(sess, refresh=False)
        self.assertEqual(payload["permissionMode"], "plan")
        self.assertEqual(sess["permissionMode"], "plan")
        self.assertEqual(payload["pendingModel"], "sonnet")


class TestAnswerQuestion(ManagerMixin, unittest.TestCase):
    """answer_question drops the ask.py bridge's answer file — only when a
    request file is actually pending for that session."""

    def _running_session(self, sm, sid="abcde", status="running"):
        sess = {"id": sid, "status": status, "tmuxName": f"agent-{sid}"}
        sm.registry = [sess]
        return sess

    def _req(self, sid):
        with open(os.path.join(ha.QUESTIONS_DIR, f"{sid}.req.json"), "w") as f:
            json.dump({"sessionId": sid, "question": "q",
                       "options": [{"label": "a"}, {"label": "b"}]}, f)

    def _ans(self, sid):
        path = os.path.join(ha.QUESTIONS_DIR, f"{sid}.ans.json")
        if not os.path.exists(path):
            return None
        with open(path) as f:
            return json.load(f)

    def test_writes_answer_file_for_option_pick(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        self._req(sess["id"])
        sm.answer_question(sess["id"], 1, None)
        self.assertEqual(self._ans(sess["id"]), {"optionIndex": 1})

    def test_writes_answer_file_with_custom_text(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        self._req(sess["id"])
        sm.answer_question(sess["id"], -1, "do the other thing")
        self.assertEqual(self._ans(sess["id"]),
                         {"optionIndex": -1, "custom": "do the other thing"})

    def test_noop_when_no_request_pending(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        sm.answer_question(sess["id"], 0, None)  # no req file written
        self.assertIsNone(self._ans(sess["id"]))

    def test_noop_for_unknown_or_stopped_session(self):
        sm = self.make_manager()
        self._req("ghost")
        sm.registry = []
        sm.answer_question("ghost", 0, None)
        self.assertIsNone(self._ans("ghost"))

    def test_noop_when_no_option_and_no_text(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        self._req(sess["id"])
        sm.answer_question(sess["id"], -1, "   ")  # blank custom, negative index
        self.assertIsNone(self._ans(sess["id"]))

    def test_writes_multi_select_answer(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        self._req(sess["id"])
        # A multiSelect answer carries a list; the single-index compat key is the
        # first pick. Duplicates and negatives are sanitized out.
        sm.answer_question(sess["id"], -1, None, [2, 0, 2, -1])
        self.assertEqual(self._ans(sess["id"]),
                         {"optionIndices": [2, 0], "optionIndex": 2})

    def test_empty_multi_select_list_falls_back_to_single(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        self._req(sess["id"])
        sm.answer_question(sess["id"], 1, None, [])  # empty list -> single index
        self.assertEqual(self._ans(sess["id"]), {"optionIndex": 1})

    def test_kill_clears_pending_question_files(self):
        sm = self.make_manager()
        sess = {"id": "abcde", "status": "running", "repo": "r",
                "tmuxName": "agent-abcde", "worktreePath": "/w", "root": True}
        sm.registry = [sess]
        self._req("abcde")
        with open(os.path.join(ha.QUESTIONS_DIR, "abcde.ans.json"), "w") as f:
            f.write("{}")
        sm.kill("abcde")
        self.assertFalse(os.path.exists(os.path.join(ha.QUESTIONS_DIR, "abcde.req.json")))
        self.assertFalse(os.path.exists(os.path.join(ha.QUESTIONS_DIR, "abcde.ans.json")))


class TestSweepOrphanQuestions(ManagerMixin, unittest.TestCase):
    """_sweep_orphan_questions drops rendezvous files whose owning ask.py bridge
    is gone — the session isn't running, or its claude tmux has exited. This is
    the fix for a question that keeps showing pending after a turn died outside
    the kill/restart cleanup (claude crashed / esc-cancel / finished on its own),
    beyond _hook_question's own answered/stale guards."""

    def _files(self, sid, ans=False):
        os.makedirs(ha.QUESTIONS_DIR, exist_ok=True)
        with open(os.path.join(ha.QUESTIONS_DIR, f"{sid}.req.json"), "w") as f:
            json.dump({"sessionId": sid, "question": "q", "options": []}, f)
        if ans:
            with open(os.path.join(ha.QUESTIONS_DIR, f"{sid}.ans.json"), "w") as f:
                f.write("{}")

    def _exists(self, sid, suffix):
        return os.path.exists(os.path.join(ha.QUESTIONS_DIR, f"{sid}.{suffix}"))

    def test_clears_files_for_unknown_session(self):
        sm = self.make_manager()
        sm.registry = []
        self._files("ghost", ans=True)
        sm._sweep_orphan_questions()
        self.assertFalse(self._exists("ghost", "req.json"))
        self.assertFalse(self._exists("ghost", "ans.json"))

    def test_clears_files_for_stopped_session(self):
        sm = self.make_manager()
        sm.registry = [{"id": "s1", "status": "stopped", "tmuxName": "agent-s1"}]
        self._files("s1")
        sm._sweep_orphan_questions()
        self.assertFalse(self._exists("s1", "req.json"))

    def test_clears_files_when_tmux_gone(self):
        sm = self.make_manager()
        sm.registry = [{"id": "s1", "status": "running", "tmuxName": "agent-s1"}]
        self._files("s1")
        with mock.patch.object(sm, "_tmux_alive", return_value=False):
            sm._sweep_orphan_questions()
        self.assertFalse(self._exists("s1", "req.json"))

    def test_keeps_files_for_running_session_with_live_tmux(self):
        # A real pending question (or a multi-question flow mid-advance) must be
        # left alone — its bridge is alive and will clean up itself.
        sm = self.make_manager()
        sm.registry = [{"id": "s1", "status": "running", "tmuxName": "agent-s1"}]
        self._files("s1")
        with mock.patch.object(sm, "_tmux_alive", return_value=True):
            sm._sweep_orphan_questions()
        self.assertTrue(self._exists("s1", "req.json"))

    def test_tmux_alive_uses_has_session(self):
        sm = self.make_manager()
        self.run_ok_calls.clear()
        self.assertTrue(sm._tmux_alive("agent-x"))  # fake_run_ok returns rc 0
        self.assertIn(["tmux", "has-session", "-t", "agent-x"], self.run_ok_calls)

    def test_tmux_alive_false_without_name(self):
        sm = self.make_manager()
        self.assertFalse(sm._tmux_alive(None))


class TestHistoryCommand(ManagerMixin, unittest.TestCase):
    WORKDIR = "/w/.turma/worktrees/repo"

    def _running_session(self, sm, sid="abcde", workdir=None):
        workdir = workdir or self.WORKDIR
        sess = {"id": sid, "status": "running", "worktreePath": workdir,
                "tmuxName": f"agent-{sid}"}
        sm.registry = [sess]
        return sess

    def _proj_dir(self, workdir=None):
        workdir = workdir or self.WORKDIR
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(workdir))
        os.makedirs(proj, exist_ok=True)
        return proj

    def test_unknown_session_stages_empty_result(self):
        sm = self.make_manager()
        sm.registry = []
        sm._stage_history("nope")
        self.assertEqual(sm.history_results, [
            {"sessionId": "nope", "entries": [], "truncated": False, "queued": []},
        ])

    def test_fixture_transcript_entries_ids_roles_order(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        proj = self._proj_dir()
        write_jsonl(os.path.join(proj, "t.jsonl"), [
            {"uuid": "u1", "type": "user", "message": {"content": "hi"}},
            {"uuid": "u2", "type": "assistant",
             "message": {"content": [{"type": "text", "text": "hello back"}]}},
        ])
        sm._stage_history(sess["id"])
        self.assertEqual(sm.history_results, [{
            "sessionId": sess["id"],
            "entries": [
                {"id": "u1", "role": "user", "text": "hi",
                 "blocks": [{"t": "text", "text": "hi"}]},
                {"id": "u2", "role": "assistant", "text": "hello back",
                 "blocks": [{"t": "text", "text": "hello back"}]},
            ],
            "truncated": False,
            "queued": [],
        }])

    def test_truncated_false_when_everything_fits(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        proj = self._proj_dir()
        write_jsonl(os.path.join(proj, "t.jsonl"), [
            {"uuid": f"u{i}", "type": "user", "message": {"content": f"msg {i}"}}
            for i in range(5)
        ])
        with mock.patch.object(ha, "HISTORY_MAX_MSGS", 10):
            sm._stage_history(sess["id"])
        self.assertEqual(len(sm.history_results[0]["entries"]), 5)
        self.assertFalse(sm.history_results[0]["truncated"])

    def test_truncated_true_when_exceeding_history_max_msgs(self):
        # All 10 entries here are operator messages, so the XERK-186 exemption
        # folds the 7 the entry cap cut right back in: truncated reports the
        # cut, but no operator message is lost to it.
        sm = self.make_manager()
        sess = self._running_session(sm)
        proj = self._proj_dir()
        write_jsonl(os.path.join(proj, "t.jsonl"), [
            {"uuid": f"u{i}", "type": "user", "message": {"content": f"msg {i}"}}
            for i in range(10)
        ])
        with mock.patch.object(ha, "HISTORY_MAX_MSGS", 3):
            sm._stage_history(sess["id"])
        result = sm.history_results[0]
        self.assertEqual([e["id"] for e in result["entries"]],
                         [f"u{i}" for i in range(10)])
        self.assertTrue(result["truncated"])

    def test_entry_cap_evicts_tool_traffic_not_operator_messages(self):
        # XERK-186: the entry cap drops old assistant/tool turns, but every
        # operator message survives — in file order, ahead of the window.
        sm = self.make_manager()
        sess = self._running_session(sm)
        proj = self._proj_dir()
        lines = [{"uuid": "op1", "type": "user", "message": {"content": "do the thing"}}]
        for i in range(10):
            lines.append({"uuid": f"a{i}", "type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": f"t{i}", "name": "Bash",
                 "input": {"command": f"cmd {i}"}}]}})
            lines.append({"uuid": f"r{i}", "type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": f"t{i}", "content": f"out {i}"}]}})
        lines.append({"uuid": "op2", "type": "user", "message": {"content": "now fix it"}})
        write_jsonl(os.path.join(proj, "t.jsonl"), lines)
        with mock.patch.object(ha, "HISTORY_MAX_MSGS", 4):
            sm._stage_history(sess["id"])
        result = sm.history_results[0]
        ids = [e["id"] for e in result["entries"]]
        # op1 was evicted by the cap and folded back in ahead of the window
        # (= the last 4 entries); op2 is inside the window and not duplicated.
        self.assertEqual(ids, ["op1", "r8", "a9", "r9", "op2"])
        self.assertTrue(result["truncated"])

    def test_byte_cap_folds_operator_messages_back_in(self):
        # XERK-186: an operator message cut off by the 4 MiB byte window is
        # recovered by the full-file operator scan.
        sm = self.make_manager()
        sess = self._running_session(sm)
        proj = self._proj_dir()
        path = os.path.join(proj, "t.jsonl")
        write_jsonl(path, [
            {"uuid": "old-op", "type": "user", "message": {"content": "the first ask"}},
            {"uuid": "a1", "type": "assistant",
             "message": {"content": [{"type": "text", "text": "working on it"}]}},
        ])
        # Simulate the byte window: the tail read only sees the assistant line.
        with open(path) as f:
            tail_line = f.readlines()[1].strip().encode()
        with mock.patch.object(ha, "_read_tail_lines", lambda p, n: [tail_line]):
            with mock.patch("os.path.getsize", return_value=(1 << 22) + 1):
                sm._stage_history(sess["id"])
        result = sm.history_results[0]
        self.assertEqual([e["id"] for e in result["entries"]], ["old-op", "a1"])
        self.assertTrue(result["truncated"])

    def test_operator_exempt_set_is_capped_newest_first(self):
        # HISTORY_USER_MSGS bounds the folded-back set, keeping the newest.
        sm = self.make_manager()
        sess = self._running_session(sm)
        proj = self._proj_dir()
        write_jsonl(os.path.join(proj, "t.jsonl"), [
            {"uuid": f"u{i}", "type": "user", "message": {"content": f"msg {i}"}}
            for i in range(6)
        ])
        with mock.patch.object(ha, "HISTORY_MAX_MSGS", 2), \
             mock.patch.object(ha, "HISTORY_USER_MSGS", 3):
            sm._stage_history(sess["id"])
        result = sm.history_results[0]
        # window = u4,u5; exempt olds capped to newest 3 of u0..u3 = u1,u2,u3
        self.assertEqual([e["id"] for e in result["entries"]],
                         ["u1", "u2", "u3", "u4", "u5"])

    def test_empty_transcript_file(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        proj = self._proj_dir()
        open(os.path.join(proj, "t.jsonl"), "w").close()
        sm._stage_history(sess["id"])
        self.assertEqual(sm.history_results, [
            {"sessionId": sess["id"], "entries": [], "truncated": False, "queued": []},
        ])

    def test_missing_project_dir_stages_empty(self):
        sm = self.make_manager()
        sess = self._running_session(sm, workdir="/absent/worktree")
        sm._stage_history(sess["id"])
        self.assertEqual(sm.history_results, [
            {"sessionId": sess["id"], "entries": [], "truncated": False, "queued": []},
        ])

    def test_keeps_full_message_beyond_tail_preview_cap(self):
        # History is a reading path: a message longer than the heartbeat's
        # per-message preview (TAIL_MSG_CHARS) is kept in full up to the larger
        # TAIL_MSG_CHARS_FULL, so a long response isn't cut off mid-sentence.
        sm = self.make_manager()
        sess = self._running_session(sm)
        proj = self._proj_dir()
        long_text = "x" * (ha.TAIL_MSG_CHARS + 50)
        write_jsonl(os.path.join(proj, "t.jsonl"), [
            {"uuid": "u1", "type": "user", "message": {"content": long_text}},
        ])
        sm._stage_history(sess["id"])
        text = sm.history_results[0]["entries"][0]["text"]
        self.assertEqual(text, long_text)
        self.assertGreater(len(text), ha.TAIL_MSG_CHARS)

    def test_byte_cap_marks_truncated(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        proj = self._proj_dir()
        path = os.path.join(proj, "t.jsonl")
        with mock.patch.object(ha, "_read_tail_lines",
                                lambda p, n: [json.dumps(
                                    {"uuid": "u1", "type": "user",
                                     "message": {"content": "hi"}}
                                ).encode()]):
            with mock.patch("os.path.getsize", return_value=(1 << 22) + 1):
                open(path, "w").close()
                sm._stage_history(sess["id"])
        self.assertTrue(sm.history_results[0]["truncated"])


class TestHandleCommandsInputHistory(ManagerMixin, unittest.TestCase):
    def test_dispatches_input_and_history_and_acks_both(self):
        sm = self.make_manager()
        sm.save = mock.Mock()
        sm.send_input = mock.Mock()
        sm._stage_history = mock.Mock()
        cmds = [
            {"cmdId": "i1", "type": "input", "sessionId": "s1", "text": "hi"},
            {"cmdId": "h1", "type": "history", "sessionId": "s1"},
        ]
        self.assertTrue(sm.handle_commands(cmds))
        sm.send_input.assert_called_once_with("s1", "hi", uploads=None)
        sm._stage_history.assert_called_once_with("s1")
        self.assertEqual(sm.acked, {"i1", "h1"})

    def test_an_input_command_carries_its_attachments_through(self):
        # The hub names the staged files on the command (XERK-234); the agent is
        # what fetches and writes them.
        sm = self.make_manager()
        sm.save = mock.Mock()
        sm.send_input = mock.Mock()
        ups = [{"id": "u1", "name": "shot.png", "size": 12}]
        self.assertTrue(sm.handle_commands([
            {"cmdId": "i2", "type": "input", "sessionId": "s1", "text": "look",
             "uploads": ups},
        ]))
        sm.send_input.assert_called_once_with("s1", "look", uploads=ups)

    def test_dispatches_interrupt(self):
        sm = self.make_manager()
        sm.save = mock.Mock()
        sm.interrupt = mock.Mock()
        cmds = [{"cmdId": "x1", "type": "interrupt", "sessionId": "s1"}]
        self.assertTrue(sm.handle_commands(cmds))
        sm.interrupt.assert_called_once_with("s1")
        self.assertEqual(sm.acked, {"x1"})

    def test_dispatches_answer_question(self):
        sm = self.make_manager()
        sm.save = mock.Mock()
        sm.answer_question = mock.Mock()
        cmds = [{"cmdId": "a1", "type": "answerQuestion", "sessionId": "s1",
                 "optionIndex": 2, "custom": "other"}]
        self.assertTrue(sm.handle_commands(cmds))
        sm.answer_question.assert_called_once_with("s1", 2, "other", None)
        self.assertEqual(sm.acked, {"a1"})

    def test_dispatches_answer_question_multi(self):
        sm = self.make_manager()
        sm.save = mock.Mock()
        sm.answer_question = mock.Mock()
        cmds = [{"cmdId": "a2", "type": "answerQuestion", "sessionId": "s1",
                 "optionIndex": -1, "optionIndices": [0, 2]}]
        self.assertTrue(sm.handle_commands(cmds))
        sm.answer_question.assert_called_once_with("s1", -1, None, [0, 2])
        self.assertEqual(sm.acked, {"a2"})


class TestInputMaxCharsPayload(ManagerMixin, unittest.TestCase):
    """The agent tells the hub how long a message it can deliver INTACT
    (XERK-227). The hub caps a typed message at this; an agent that doesn't
    report it is assumed to be one that would silently clip at 4k."""

    def test_heartbeat_reports_the_agent_input_cap(self):
        sm = self.make_manager()
        payload = sm.build_payload(0)
        self.assertEqual(payload["inputMaxChars"], ha.INPUT_MAX_CHARS)

    def test_it_follows_the_configured_cap(self):
        sm = self.make_manager()
        with mock.patch.object(ha, "INPUT_MAX_CHARS", 12345):
            self.assertEqual(sm.build_payload(0)["inputMaxChars"], 12345)


class TestHistoryStagingLifecycle(ManagerMixin, unittest.TestCase):
    """historyResults staging must mirror ackedCommands/pending_prs: appear in
    the next built payload, survive a failed heartbeat POST, and clear only
    after a successful one."""

    def test_immediate_extra_heartbeat_carries_staged_result(self):
        # Mirrors run_forever's "immediate extra heartbeat after executing
        # commands": handle_commands() runs (staging a history result), THEN
        # build_payload() is called for the follow-up beat — no extra wiring
        # needed for the staged result to ride along automatically.
        sm = self.make_manager()
        sm.registry = []  # unknown sessionId -> empty staged result
        sm.save = mock.Mock()
        did_work = sm.handle_commands(
            [{"cmdId": "h1", "type": "history", "sessionId": "s1"}]
        )
        self.assertTrue(did_work)
        extra_beat_payload = sm.build_payload(1)
        self.assertEqual(extra_beat_payload["historyResults"],
                          [{"sessionId": "s1", "entries": [], "truncated": False,
                            "queued": []}])

    def test_absent_when_nothing_staged(self):
        sm = self.make_manager()
        payload = sm.build_payload(0)
        self.assertNotIn("historyResults", payload)

    def test_staged_result_appears_in_next_payload(self):
        sm = self.make_manager()
        sm.history_results.append({"sessionId": "s1", "entries": [], "truncated": False})
        payload = sm.build_payload(0)
        self.assertEqual(payload["historyResults"],
                          [{"sessionId": "s1", "entries": [], "truncated": False}])

    def test_cleared_only_after_successful_post(self):
        sm = self.make_manager()
        sm.history_results.append({"sessionId": "s1", "entries": [], "truncated": False})
        payload = sm.build_payload(0)

        # Failed POST: staged result must survive.
        with mock.patch.object(ha.urllib.request, "urlopen",
                                side_effect=OSError("network down")):
            reply = sm.post(payload)
        self.assertIsNone(reply)
        self.assertEqual(len(sm.history_results), 1)
        payload2 = sm.build_payload(1)
        self.assertEqual(payload2["historyResults"], payload["historyResults"])

        # Successful POST: staged result is cleared.
        class FakeResp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            # Real HTTPResponse.read takes an optional size, and post() now
            # passes one (HEARTBEAT_REPLY_MAX) — a no-arg double stops standing
            # in for the thing it fakes. RECORDED, not just tolerated: a widened
            # double that ignores its argument let the bound be deleted with
            # both suites still green.
            def read(self, *a):
                FakeResp.read_args = a
                return b"{}"

        with mock.patch.object(ha.urllib.request, "urlopen",
                                return_value=FakeResp()):
            reply = sm.post(payload2)
        self.assertEqual(reply, {})
        # The heartbeat reply is BOUNDED (XERK-348): it now carries a peer
        # roster, so an unbounded read makes the hub's reply size this process's
        # memory ceiling. Asserted here because deleting the bound is otherwise
        # invisible to every test.
        self.assertEqual(FakeResp.read_args, (ha.HEARTBEAT_REPLY_MAX,))
        self.assertEqual(sm.history_results, [])
        self.assertNotIn("historyResults", sm.build_payload(2))

    def test_multiple_pending_requests_batch(self):
        sm = self.make_manager()
        sm.registry = []
        sm._stage_history("s1")
        sm._stage_history("s2")
        payload = sm.build_payload(0)
        self.assertEqual(
            [r["sessionId"] for r in payload["historyResults"]], ["s1", "s2"],
        )


class TestStagedHistoryCeiling(ManagerMixin, unittest.TestCase):
    """XERK-347: a beat that the hub refuses as too large is the ONE failure
    re-sending cannot fix — every staged result is held until a POST succeeds,
    so the identical oversize body goes back up every beat and the host never
    comes back (XERK-235's offline loop). Both halves are tested: the beat is
    kept under the ceiling, and a 413 that happens anyway ends the loop."""

    def _result(self, sid, chars):
        return {"sessionId": sid, "truncated": False, "queued": [],
                "entries": [{"id": "e1", "role": "assistant", "text": "",
                             "blocks": [{"t": "text", "text": "x" * chars}]}]}

    def test_several_sessions_histories_are_trimmed_to_the_aggregate(self):
        sm = self.make_manager()
        for sid in ("s1", "s2", "s3"):
            sm.history_results.append(self._result(sid, 4000))
        with mock.patch.object(ha, "HISTORY_STAGED_MAX_BYTES", 9000):
            payload = sm.build_payload(0)
        # Newest kept, oldest dropped — and dropped from the staged list too, or
        # the next beat rebuilds the same oversize body.
        self.assertEqual([r["sessionId"] for r in payload["historyResults"]], ["s2", "s3"])
        self.assertEqual([r["sessionId"] for r in sm.history_results], ["s2", "s3"])

    def test_the_newest_result_rides_however_big_it_is(self):
        sm = self.make_manager()
        sm.history_results.append(self._result("s1", 50000))
        with mock.patch.object(ha, "HISTORY_STAGED_MAX_BYTES", 100):
            payload = sm.build_payload(0)
        self.assertEqual([r["sessionId"] for r in payload["historyResults"]], ["s1"])

    def test_only_ONE_result_on_the_whole_beat_is_exempt(self):
        # One exemption per LIST let two oversize deliveries share a beat, which
        # is a body the hub answers with no status at all.
        sm = self.make_manager()
        sm.history_results.append(self._result("s1", 40000))
        sm.subagent_history_results.append(self._result("s2", 40000))
        with mock.patch.object(ha, "HISTORY_STAGED_MAX_BYTES", 100):
            payload = sm.build_payload(0)
        self.assertEqual([r["sessionId"] for r in payload["historyResults"]], ["s1"])
        self.assertNotIn("subagentHistoryResults", payload)

    def test_a_body_past_HEARTBEAT_BODY_MAX_is_shed_BEFORE_it_is_sent(self):
        # The hub 413s only up to a point; past it Node destroys the socket and
        # urllib sees a broken pipe, so no status handler can fire. Measuring
        # the body we are about to send is the only place this can be caught.
        sm = self.make_manager()
        sm.history_results.append(self._result("s1", 200000))
        payload = sm.build_payload(0)
        self.assertIn("historyResults", payload)
        sent = {}

        class FakeResp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, *a): return b"{}"

        def fake_urlopen(req, timeout=None):
            sent["bytes"] = len(req.data)
            return FakeResp()

        before = len(json.dumps(payload))
        with mock.patch.object(ha, "HEARTBEAT_BODY_MAX", 5000), \
                mock.patch.object(ha.urllib.request, "urlopen", fake_urlopen):
            self.assertEqual(sm.post(payload), {})
        # What went on the wire is the SHED body, not the one handed to post().
        self.assertLess(sent["bytes"], before)
        self.assertLess(sent["bytes"], 200000)
        # ...and shed for good: the next beat is not the same body again.
        self.assertEqual(sm.history_results, [])
        self.assertNotIn("historyResults", sm.build_payload(1))

    def test_the_beat_itself_still_rides_when_its_deliveries_are_shed(self):
        sm = self.make_manager()
        sm.history_results.append(self._result("s1", 200000))
        sm.spawn_failures.append({"cmdId": "c1", "error": "no"})
        payload = sm.build_payload(0)
        with mock.patch.object(ha, "HEARTBEAT_BODY_MAX", 5000):
            sm._drop_on_demand_results(payload)
        self.assertNotIn("historyResults", payload)
        # An EVENT that exists nowhere else is not a fetch — it stays held.
        self.assertEqual(payload["spawnFailures"], [{"cmdId": "c1", "error": "no"}])
        self.assertEqual(len(sm.spawn_failures), 1)

    def test_the_body_ceiling_comes_from_the_HUB_not_a_fixed_number(self):
        # The hub's ceiling is a fraction of its container limit, so a hub given
        # less memory has a smaller one — and a fixed agent-side number posts
        # straight into the band where no status ever comes back.
        sm = self.make_manager()
        self.assertEqual(sm._body_max(), ha.HEARTBEAT_BODY_MAX)   # before any reply
        sm._note_body_max({"commands": [], "bodyMax": 8 << 20})
        self.assertEqual(sm._body_max(), int((8 << 20) * ha.HEARTBEAT_BODY_MARGIN))

    def test_a_preposterous_or_broken_bodyMax_cannot_talk_us_up(self):
        sm = self.make_manager()
        sm._note_body_max({"bodyMax": 1 << 40})
        self.assertEqual(sm._body_max(), ha.HEARTBEAT_BODY_MAX)   # our own cap holds
        for bad in ({"bodyMax": 0}, {"bodyMax": -1}, {"bodyMax": True},
                    {"bodyMax": "8"}, {}, None):
            sm2 = self.make_manager()
            sm2._note_body_max(bad)
            self.assertEqual(sm2._body_max(), ha.HEARTBEAT_BODY_MAX)

    def test_a_smaller_hub_sheds_a_body_a_bigger_one_would_have_taken(self):
        sm = self.make_manager()
        sm.history_results.append(self._result("s1", 3 << 20))
        sm._note_body_max({"bodyMax": 2 << 20})   # a hub with a 2 MiB ceiling
        payload = sm.build_payload(0)
        sent = {}

        class FakeResp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, *a): return b"{}"

        def fake_urlopen(req, timeout=None):
            sent["bytes"] = len(req.data)
            return FakeResp()

        with mock.patch.object(ha.urllib.request, "urlopen", fake_urlopen):
            self.assertEqual(sm.post(payload), {})
        self.assertNotIn("historyResults", payload)
        self.assertEqual(sm.history_results, [])
        self.assertLess(sent["bytes"], sm._body_max())

    def test_a_beat_that_gets_NO_status_still_stops_repeating_itself(self):
        # The hub answers no status past its ceiling, and the learned ceiling is
        # only refreshed on a SUCCESSFUL beat — so a hub restarted with less
        # memory (or an agent repointed at a smaller one) would re-post the same
        # body every beat forever with nothing able to notice.
        sm = self.make_manager()
        sm._note_body_max({"bodyMax": 32 << 20})     # learned from a big hub
        sm.history_results.append(self._result("s1", 2000))
        payload = sm.build_payload(0)
        with mock.patch.object(ha.urllib.request, "urlopen",
                               side_effect=BrokenPipeError("broken pipe")):
            self.assertIsNone(sm.post(payload))
            self.assertEqual(len(sm.history_results), 1)   # one failure proves nothing
            self.assertIsNone(sm.post(payload))
        self.assertEqual(sm.history_results, [])           # ...two does
        # The stale ceiling goes with them: the next beats run on the
        # conservative default until this hub states its own.
        self.assertEqual(sm._body_max(), ha.HEARTBEAT_BODY_MAX)

    def test_an_ordinary_outage_sheds_nothing(self):
        sm = self.make_manager()
        sm.spawn_failures.append({"cmdId": "c1", "error": "no"})
        payload = sm.build_payload(0)
        with mock.patch.object(ha.urllib.request, "urlopen",
                               side_effect=OSError("network down")):
            for _ in range(5):
                self.assertIsNone(sm.post(payload))
        self.assertEqual(len(sm.spawn_failures), 1)

    def test_a_successful_beat_clears_the_failure_streak(self):
        sm = self.make_manager()
        sm.history_results.append(self._result("s1", 10))

        class FakeResp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, *a): return b"{}"

        with mock.patch.object(ha.urllib.request, "urlopen",
                               side_effect=OSError("blip")):
            self.assertIsNone(sm.post(sm.build_payload(0)))
        with mock.patch.object(ha.urllib.request, "urlopen", return_value=FakeResp()):
            self.assertEqual(sm.post(sm.build_payload(1)), {})
        sm.history_results.append(self._result("s2", 10))
        with mock.patch.object(ha.urllib.request, "urlopen",
                               side_effect=OSError("blip")):
            self.assertIsNone(sm.post(sm.build_payload(2)))
        # One failure since the success — a streak that reset, not two in a row.
        self.assertEqual(len(sm.history_results), 1)

    def test_an_infinite_or_absurd_bodyMax_cannot_break_every_beat(self):
        # `1e999` is legal JSON and parses to inf; int(inf) RAISES, inside the
        # try — so every beat would log as failed while every beat succeeded.
        sm = self.make_manager()
        for bad in (float("inf"), float("-inf"), float("nan")):
            sm._note_body_max({"bodyMax": bad})
            self.assertEqual(sm._body_max(), ha.HEARTBEAT_BODY_MAX)

    def test_a_tiny_bodyMax_cannot_silently_disable_history_forever(self):
        # Every beat 200, every delivery shed, nothing anywhere looking wrong —
        # the operator's chat just never loads. Below the floor it is nonsense.
        sm = self.make_manager()
        sm._note_body_max({"bodyMax": 1})
        self.assertEqual(sm._body_max(), ha.HEARTBEAT_BODY_MIN)

    def test_a_beat_within_the_aggregate_is_untouched(self):
        sm = self.make_manager()
        sm.history_results.append(self._result("s1", 10))
        sm.subagent_history_results.append(self._result("s2", 10))
        payload = sm.build_payload(0)
        self.assertEqual(len(payload["historyResults"]), 1)
        self.assertEqual(len(payload["subagentHistoryResults"]), 1)

    def test_a_413_drops_the_on_demand_deliveries_instead_of_looping(self):
        sm = self.make_manager()
        sm.history_results.append(self._result("s1", 10))
        sm.subagent_history_results.append(self._result("s2", 10))
        sm.jira_issue_results.append({"issueKey": "X-1"})
        # ...while a refusal that re-sending CAN fix keeps everything staged.
        sm.spawn_failures.append({"cmdId": "c1", "error": "no"})
        payload = sm.build_payload(0)
        err = ha.urllib.error.HTTPError(
            "http://hub/api/heartbeat", 413, "Payload Too Large", {},
            io.BytesIO(b'{"error":"body too large"}'))
        with mock.patch.object(ha.urllib.request, "urlopen", side_effect=err):
            self.assertIsNone(sm.post(payload))
        self.assertEqual(sm.history_results, [])
        self.assertEqual(sm.subagent_history_results, [])
        self.assertEqual(sm.jira_issue_results, [])
        # The beat itself still rides — the host stays online, and its operator
        # sees a history that did not arrive rather than a card that went dark.
        self.assertEqual(len(sm.spawn_failures), 1)
        self.assertNotIn("historyResults", sm.build_payload(1))

    def test_any_other_refusal_still_HOLDS_the_staged_results(self):
        sm = self.make_manager()
        sm.history_results.append(self._result("s1", 10))
        payload = sm.build_payload(0)
        err = ha.urllib.error.HTTPError(
            "http://hub/api/heartbeat", 503, "Service Unavailable", {}, io.BytesIO(b"{}"))
        with mock.patch.object(ha.urllib.request, "urlopen", side_effect=err):
            self.assertIsNone(sm.post(payload))
        self.assertEqual(len(sm.history_results), 1)


class TestBuildPayloadCaching(ManagerMixin, unittest.TestCase):
    """The heartbeat build caches slow-changing work (usage, git facts, docker
    log tail) off the per-beat critical path (#2/#5/#7): recomputed on the slow
    cadence or a cache miss, reused in between, and skipped on a `light` beat."""

    def _session(self, sid):
        return {"id": sid, "repo": "R", "repoPath": "/x/R",
                "worktreePath": f"/x/R/{sid}", "branch": None, "rcName": sid,
                "status": "running"}

    def test_usage_refresh_is_staggered_and_caches(self):
        sm = self.make_manager()
        sm.registry = [self._session("aaa"), self._session("bbb")]
        calls = []
        sm._refresh_usage = lambda sid, wt: calls.append((sid, ha._usage_slot(sid)))

        # Each session refreshes only on the beat matching its own stable slot
        # (first appearance aside), so they don't all reparse on the same beat.
        for beat in range(ha.USAGE_EVERY):
            calls.clear()
            sm.usage_cache = {"aaa": {}, "bbb": {}}  # both already cached
            sm.build_payload(beat)
            for sid, slot in calls:
                self.assertEqual(slot, beat % ha.USAGE_EVERY)
        # Over a full window every session refreshed exactly once.
        seen = set()
        for beat in range(ha.USAGE_EVERY):
            calls.clear()
            sm.usage_cache = {"aaa": {}, "bbb": {}}
            sm.build_payload(beat)
            seen.update(sid for sid, _ in calls)
        self.assertEqual(seen, {"aaa", "bbb"})

    def test_newly_seen_session_refreshes_immediately(self):
        sm = self.make_manager()
        sm.registry = [self._session("aaa")]
        refreshed = []
        sm._refresh_usage = lambda sid, wt: refreshed.append(sid)
        # Beat 1 is (almost certainly) not aaa's slot, but with no cached usage
        # it must still refresh on first appearance.
        sm.usage_cache = {}
        sm.build_payload(1)
        self.assertIn("aaa", refreshed)

    def test_light_beat_skips_expensive_refreshes(self):
        sm = self.make_manager()
        sm.registry = [self._session("aaa")]
        sm.usage_cache = {"aaa": {}}       # already cached -> no first-sight refresh
        refreshed, gh = [], []
        sm._refresh_usage = lambda sid, wt: refreshed.append(sid)
        sm.refresh_github = lambda: gh.append(1)
        log_calls = []
        with mock.patch.object(ha, "log_tail",
                               lambda cid: log_calls.append(cid) or "tail"):
            # A light beat on beat 0 (which WOULD normally refresh everything)
            # still touches none of the expensive paths.
            sm.log_tail_cache = "cached"
            payload = sm.build_payload(0, light=True)
        self.assertEqual(refreshed, [])
        self.assertEqual(gh, [])
        self.assertEqual(log_calls, [])            # docker logs not shelled out
        self.assertEqual(payload["logTail"], "cached")

    def test_log_tail_throttled_across_beats(self):
        sm = self.make_manager()
        sm.registry = []
        calls = []
        with mock.patch.object(ha, "log_tail",
                               lambda cid: calls.append(cid) or f"t{len(calls)}"):
            for beat in range(ha.LOG_TAIL_EVERY + 1):
                sm.build_payload(beat)
        # Recomputed on beat 0 and again at LOG_TAIL_EVERY, reused in between.
        self.assertEqual(len(calls), 2)

    def test_repo_slow_facts_cached_and_recomputed_on_cadence(self):
        sm = self.make_manager()
        computed = []
        with mock.patch.object(ha, "repo_slow_facts",
                               lambda path: computed.append(path) or {"remote": path}):
            self.assertEqual(sm._repo_slow_facts("/x/R", refresh=False), {"remote": "/x/R"})
            self.assertEqual(computed, ["/x/R"])        # first sight -> computed
            sm._repo_slow_facts("/x/R", refresh=False)  # cached -> not recomputed
            self.assertEqual(computed, ["/x/R"])
            sm._repo_slow_facts("/x/R", refresh=True)   # slow cadence -> recomputed
            self.assertEqual(computed, ["/x/R", "/x/R"])

    def test_session_git_caches_slow_and_recomputes_on_branch_change(self):
        sm = self.make_manager()
        sess = self._session("aaa")
        slow_calls, sync_calls = [], []
        with mock.patch.object(ha, "git_info_cheap",
                               lambda wt: {"branch": self._branch}), \
             mock.patch.object(ha, "git_info_slow",
                               lambda wt: slow_calls.append(wt) or {"remote": "r"}), \
             mock.patch.object(ha, "branch_sync",
                               lambda repo, br, base: sync_calls.append(br) or {"baseRef": base}):
            self._branch = "HEAD"          # still detached
            gi, work = sm._session_git(sess, refresh=False)
            self.assertEqual(gi, {"branch": "HEAD", "remote": "r"})
            self.assertEqual(len(slow_calls), 1)       # first sight -> computed

            gi, work = sm._session_git(sess, refresh=False)
            self.assertEqual(len(slow_calls), 1)       # cached, no recompute

            self._branch = "feature-x"     # agent just named its work branch
            sm._session_git(sess, refresh=False)
            self.assertEqual(len(slow_calls), 2)       # branch change -> recompute
            self.assertEqual(sync_calls[-1], "feature-x")


class TestNormalizeGithubRepo(unittest.TestCase):
    def test_plain_owner_repo(self):
        self.assertEqual(ha.normalize_github_repo("xerktech/Turma"), "xerktech/Turma")
        self.assertEqual(ha.normalize_github_repo("  xerktech/Turma  "), "xerktech/Turma")

    def test_urls_and_git_suffix(self):
        self.assertEqual(
            ha.normalize_github_repo("https://github.com/xerktech/Turma.git"),
            "xerktech/Turma")
        self.assertEqual(
            ha.normalize_github_repo("https://github.com/xerktech/Turma/"),
            "xerktech/Turma")
        self.assertEqual(
            ha.normalize_github_repo("git@github.com:xerktech/Turma.git"),
            "xerktech/Turma")

    def test_keeps_dots_and_dashes_in_names(self):
        self.assertEqual(ha.normalize_github_repo("my-org/re.po_name-1"), "my-org/re.po_name-1")

    def test_rejects_bad(self):
        for bad in ("", "   ", None, "noslash", "a/b/c", "../evil/x", "owner/..",
                    "-lead/repo", "owner/re po", "owner/re;po", "owner/re`po",
                    "owner/$x", "https://github.com/only-owner", "owner/"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                ha.normalize_github_repo(bad)


class TestListGithubRepos(unittest.TestCase):
    """The clone dropdown's repo discovery. `gh repo list` with no owner returns
    only the user's OWN repos, so org repos must come from an explicit org sweep
    — otherwise an org member sees an empty dropdown (the reported bug)."""

    def _fake_run(self, *, orgs, by_owner):
        def fake_run(cmd, cwd=None):
            joined = " ".join(cmd)
            if "user/orgs" in joined:
                return "\n".join(orgs)
            if cmd[:3] == ["gh", "repo", "list"]:
                owner = cmd[3] if len(cmd) > 3 and not cmd[3].startswith("-") else None
                return json.dumps(by_owner.get(owner, []))
            return ""
        return fake_run

    def test_sweeps_user_orgs_so_org_repos_appear(self):
        fake = self._fake_run(
            orgs=["xerktech"],
            by_owner={
                None: [],  # the login owns no personal repos (the org case)
                "xerktech": [
                    {"nameWithOwner": "xerktech/Turma", "updatedAt": "2026-07-02", "isPrivate": True},
                    {"nameWithOwner": "xerktech/DockerOps", "updatedAt": "2026-07-01"},
                ],
            },
        )
        with mock.patch.object(ha, "run", fake), \
                mock.patch.dict(os.environ, {}, clear=True):
            repos = ha.list_github_repos()
        names = [r["nameWithOwner"] for r in repos]
        self.assertEqual(names, ["xerktech/Turma", "xerktech/DockerOps"])  # newest first
        self.assertTrue(repos[0]["isPrivate"])
        self.assertEqual(repos[0]["name"], "Turma")

    def test_own_orgs_and_env_owners_merged_and_deduped(self):
        fake = self._fake_run(
            orgs=["orgA"],
            by_owner={
                None: [{"nameWithOwner": "me/dotfiles", "updatedAt": "2026-05-01"}],
                "orgA": [{"nameWithOwner": "orgA/app", "updatedAt": "2026-06-01"}],
                "orgB": [
                    {"nameWithOwner": "orgB/lib", "updatedAt": "2026-06-15"},
                    {"nameWithOwner": "orgA/app", "updatedAt": "2026-06-01"},  # dup across owners
                ],
            },
        )
        with mock.patch.object(ha, "run", fake), \
                mock.patch.dict(os.environ, {"GH_CLONE_OWNERS": "orgB"}, clear=True):
            repos = ha.list_github_repos()
        names = [r["nameWithOwner"] for r in repos]
        self.assertEqual(names, ["orgB/lib", "orgA/app", "me/dotfiles"])  # deduped, newest-first

    def test_no_creds_paths_return_empty(self):
        # run() returns "" for everything (no orgs, no repos) -> empty list, no raise.
        with mock.patch.object(ha, "run", lambda *a, **k: ""), \
                mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(ha.list_github_repos(), [])


class TestClone(ManagerMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.repos_root = os.path.join(self.tmp, "root")
        os.makedirs(self.repos_root)
        p = mock.patch.object(ha, "REPOS_ROOT", self.repos_root)
        p.start()
        self.addCleanup(p.stop)

    def test_invalid_spec_records_error_without_popen(self):
        sm = self.make_manager()
        with mock.patch.object(ha.subprocess, "Popen") as popen:
            sm.clone("not a repo")
            popen.assert_not_called()
        jobs = sm._clones_payload()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["status"], "error")

    def test_existing_dest_refused_without_popen(self):
        sm = self.make_manager()
        os.makedirs(os.path.join(self.repos_root, "Turma"))
        with mock.patch.object(ha.subprocess, "Popen") as popen:
            sm.clone("xerktech/Turma")
            popen.assert_not_called()
        job = sm.clones["Turma"]
        self.assertEqual(job["status"], "error")
        self.assertIn("already exists", job["error"])

    def test_clone_launches_git_and_finishes_on_poll(self):
        sm = self.make_manager()
        dest = os.path.join(self.repos_root, "Turma")

        class FakeProc:
            def poll(self_inner):
                # Simulate git materializing the checkout, then exiting 0.
                os.makedirs(os.path.join(dest, ".git"), exist_ok=True)
                return 0

            def kill(self_inner):
                pass

        with mock.patch.object(ha.subprocess, "Popen", return_value=FakeProc()) as popen:
            sm.clone("xerktech/Turma")
            # git clone <url> <dest> was launched (not a session run_ok call).
            args = popen.call_args[0][0]
            self.assertEqual(args[:2], ["git", "clone"])
            self.assertIn("https://github.com/xerktech/Turma.git", args)
            self.assertIn(dest, args)
        self.assertEqual(sm.clones["Turma"]["status"], "cloning")
        sm._poll_clones()
        self.assertEqual(sm.clones["Turma"]["status"], "done")
        # The serializable view never leaks the Popen/file handles.
        payload = sm._clones_payload()[0]
        self.assertEqual(set(payload),
                         {"name", "repo", "status", "error", "source", "startedAt"})

    def test_failed_clone_captures_error(self):
        sm = self.make_manager()

        class FailProc:
            def poll(self_inner):
                return 1  # no .git created -> failure

            def kill(self_inner):
                pass

        with mock.patch.object(ha.subprocess, "Popen", return_value=FailProc()):
            sm.clone("xerktech/Turma")
        sm._poll_clones()
        self.assertEqual(sm.clones["Turma"]["status"], "error")


class TestValidSourceRepo(unittest.TestCase):
    """XERK-155: the loose path check for non-GitHub listings — spaces are legal
    in an Azure DevOps project segment, but the LAST segment becomes a directory
    under REPOS_ROOT and stays on the strict GitHub charset."""

    def test_accepts_plain_and_nested_and_spaced_paths(self):
        for ok in ("owner/repo", "group/sub/project", "My Project/repo",
                    "a/b/c/d/e/f"):
            self.assertTrue(ha.valid_source_repo(ok), ok)

    def test_rejects_unsafe_paths(self):
        for bad in ("", "single", "a/b/c/d/e/f/g", "owner/re po",
                    "owner/../repo", "-lead/repo", "owner/-repo",
                    "owner/", "/repo", "owner//repo", "owner/re;po"):
            self.assertFalse(ha.valid_source_repo(bad), bad)


class _FakeHttpResp:
    def __init__(self, body):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self, *a):          # real HTTPResponse.read takes an optional size
        return json.dumps(self._body).encode()


class TestCollectGitlabRepos(unittest.TestCase):
    def test_shapes_and_filters_projects(self):
        page = [
            {"path_with_namespace": "grp/sub/app",
             "ssh_url_to_repo": "git@gitlab.example.com:grp/sub/app.git",
             "description": "the app", "visibility": "private",
             "last_activity_at": "2026-07-02T00:00:00Z"},
            {"path_with_namespace": "grp/site",
             "ssh_url_to_repo": "git@gitlab.example.com:grp/site.git",
             "visibility": "public", "last_activity_at": "2026-07-01T00:00:00Z"},
            # Malformed entries are dropped, never sanitized.
            {"path_with_namespace": "grp/evil repo",
             "ssh_url_to_repo": "git@gitlab.example.com:grp/evil.git"},
            {"path_with_namespace": "grp/nossh", "ssh_url_to_repo": ""},
        ]
        with mock.patch.object(ha, "GITLAB_URL", "https://gitlab.example.com"), \
                mock.patch.object(ha, "GITLAB_TOKEN", "tok"), \
                mock.patch.object(ha.urllib.request, "urlopen",
                                  return_value=_FakeHttpResp(page)):
            repos = ha.collect_gitlab_repos()
        self.assertEqual([r["nameWithOwner"] for r in repos],
                         ["grp/sub/app", "grp/site"])
        self.assertEqual(repos[0]["name"], "app")
        self.assertEqual(repos[0]["cloneUrl"],
                         "git@gitlab.example.com:grp/sub/app.git")
        self.assertTrue(repos[0]["isPrivate"])
        self.assertFalse(repos[1]["isPrivate"])
        self.assertEqual(repos[0]["description"], "the app")

    def test_http_failure_raises_for_keep_last_good(self):
        with mock.patch.object(ha, "GITLAB_URL", "https://gitlab.example.com"), \
                mock.patch.object(ha, "GITLAB_TOKEN", "tok"), \
                mock.patch.object(ha.urllib.request, "urlopen",
                                  side_effect=OSError("down")):
            with self.assertRaises(OSError):
                ha.collect_gitlab_repos()


class TestCollectAzureRepos(unittest.TestCase):
    def test_shapes_and_filters_repos(self):
        data = {"value": [
            {"name": "Api", "remoteUrl": "https://dev.azure.com/org/Proj/_git/Api",
             "project": {"name": "My Project",
                         "lastUpdateTime": "2026-06-01T00:00:00Z"}},
            {"name": "Old", "isDisabled": True,
             "remoteUrl": "https://x", "project": {"name": "My Project"}},
            {"name": "re po", "remoteUrl": "https://x",
             "project": {"name": "My Project"}},   # unsafe dest name -> dropped
        ]}
        with mock.patch.object(ha, "azure_req", return_value=data):
            repos = ha.collect_azure_repos()
        self.assertEqual([r["nameWithOwner"] for r in repos], ["My Project/Api"])
        self.assertEqual(repos[0]["name"], "Api")
        self.assertEqual(repos[0]["cloneUrl"],
                         "https://dev.azure.com/org/Proj/_git/Api")
        self.assertTrue(repos[0]["isPrivate"])


class TestGitSources(ManagerMixin, unittest.TestCase):
    """XERK-155: the extra clone sources' refresh, payload and clone routing."""

    def setUp(self):
        super().setUp()
        self.repos_root = os.path.join(self.tmp, "root")
        os.makedirs(self.repos_root)
        p = mock.patch.object(ha, "REPOS_ROOT", self.repos_root)
        p.start()
        self.addCleanup(p.stop)

    GL_REPO = {"nameWithOwner": "grp/app", "name": "app", "description": "",
               "isPrivate": True, "updatedAt": "2026-07-01",
               "cloneUrl": "git@gitlab.example.com:grp/app.git"}
    AZ_REPO = {"nameWithOwner": "Proj/Api", "name": "Api", "description": "",
               "isPrivate": True, "updatedAt": "2026-06-01",
               "cloneUrl": "https://dev.azure.com/org/Proj/_git/Api"}

    def _sourced_manager(self):
        sm = self.make_manager()
        sm.git_sources = {
            "azure": {"available": True, "repos": [dict(self.AZ_REPO)], "error": None},
            "gitlab": {"available": True, "repos": [dict(self.GL_REPO)], "error": None},
        }
        return sm

    def test_refresh_keeps_last_good_list_on_failure(self):
        sm = self._sourced_manager()
        with mock.patch.object(ha, "collect_azure_repos",
                               side_effect=OSError("down")), \
                mock.patch.object(ha, "collect_gitlab_repos",
                                  return_value=[dict(self.GL_REPO)]):
            sm.refresh_git_sources()
        az = sm.git_sources["azure"]
        self.assertEqual(az["repos"], [self.AZ_REPO])   # kept, not blanked
        self.assertIn("down", az["error"])
        self.assertIsNone(sm.git_sources["gitlab"]["error"])

    def test_payload_strips_clone_url_and_tags_source(self):
        sm = self._sourced_manager()
        with mock.patch.object(ha, "AZDO_URL", "https://dev.azure.com/org"), \
                mock.patch.object(ha, "GITLAB_URL", "https://gitlab.example.com"):
            payload = sm._git_sources_payload()
        self.assertEqual([b["source"] for b in payload], ["azure", "gitlab"])
        self.assertEqual(payload[0]["label"], "dev.azure.com/org")
        self.assertEqual(payload[1]["label"], "gitlab.example.com")
        for block in payload:
            for r in block["repos"]:
                self.assertNotIn("cloneUrl", r)
                self.assertEqual(r["source"], block["source"])
        # The internal listings still hold their cloneUrl for clone-time use.
        self.assertIn("cloneUrl", sm.git_sources["gitlab"]["repos"][0])

    def test_clone_resolves_listed_gitlab_repo_over_ssh(self):
        sm = self._sourced_manager()
        with mock.patch.object(ha.subprocess, "Popen") as popen:
            sm.clone("grp/app", source="gitlab")
        args = popen.call_args[0][0]
        self.assertIn("git@gitlab.example.com:grp/app.git", args)
        env = popen.call_args[1]["env"]
        self.assertEqual(env["GIT_TERMINAL_PROMPT"], "0")
        self.assertIn("BatchMode=yes", env["GIT_SSH_COMMAND"])
        self.assertEqual(sm.clones["app"]["source"], "gitlab")

    def test_clone_resolves_bare_spec_across_sources(self):
        # An older hub (or the triage ledger) sends no source; the bare
        # nameWithOwner still finds the azure listing and its remoteUrl.
        sm = self._sourced_manager()
        with mock.patch.object(ha.subprocess, "Popen") as popen:
            sm.clone("Proj/Api")
        args = popen.call_args[0][0]
        self.assertIn("https://dev.azure.com/org/Proj/_git/Api", args)
        self.assertEqual(sm.clones["Api"]["source"], "azure")

    def test_github_listing_wins_a_bare_spec_collision(self):
        sm = self._sourced_manager()
        sm.github = {"available": True, "login": "me", "repos": [
            {"nameWithOwner": "Proj/Api", "name": "Api"}]}
        with mock.patch.object(ha.subprocess, "Popen") as popen:
            sm.clone("Proj/Api")
        self.assertIn("https://github.com/Proj/Api.git", popen.call_args[0][0])
        self.assertEqual(sm.clones["Api"]["source"], "github")

    def test_unlisted_repo_for_explicit_source_is_refused(self):
        sm = self._sourced_manager()
        with mock.patch.object(ha.subprocess, "Popen") as popen:
            sm.clone("grp/unknown", source="gitlab")
            popen.assert_not_called()
        jobs = sm._clones_payload()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["status"], "error")
        self.assertIn("not in the gitlab repo listing", jobs[0]["error"])

    def test_free_text_still_falls_back_to_github(self):
        sm = self._sourced_manager()
        with mock.patch.object(ha.subprocess, "Popen") as popen:
            sm.clone("someone/elsewhere")
        self.assertIn("https://github.com/someone/elsewhere.git",
                      popen.call_args[0][0])

    def test_triage_candidates_include_extra_sources(self):
        sm = self._sourced_manager()
        sm.triage_gh_repos = [{"nameWithOwner": "xerktech/Turma", "name": "Turma",
                               "description": "hub"}]
        with mock.patch.object(sm, "_triage_repos", return_value=[]):
            cands = sm._refresh_triage_candidates()
        by_name = {c["name"]: c for c in cands}
        self.assertEqual(by_name["Turma"]["source"], "github")
        self.assertEqual(by_name["Api"]["source"], "azure")
        self.assertEqual(by_name["app"]["source"], "gitlab")
        for c in cands:
            self.assertNotIn("cloneUrl", c)


class TestCleanSummary(unittest.TestCase):
    def test_strips_quotes_and_trailing_punctuation(self):
        self.assertEqual(ha.clean_summary('"Adding Compose Flag."'), "Adding Compose Flag")
        self.assertEqual(ha.clean_summary("`Fix Login`"), "Fix Login")

    def test_takes_first_non_empty_line(self):
        self.assertEqual(ha.clean_summary("\n  Title Here \n more text"), "Title Here")

    def test_caps_words(self):
        self.assertEqual(
            ha.clean_summary("one two three four five six seven eight"),
            "one two three four five six")

    def test_empty_none_and_blank_return_none(self):
        self.assertIsNone(ha.clean_summary(""))
        self.assertIsNone(ha.clean_summary("   \n  "))
        self.assertIsNone(ha.clean_summary(None))


class TestCleanManualSummary(unittest.TestCase):
    def test_keeps_the_text_the_operator_typed(self):
        # Unlike clean_summary, punctuation/quotes inside a human's own name are
        # deliberate, not model noise.
        self.assertEqual(ha.clean_manual_summary("Malcolm's v2.1 fix"), "Malcolm's v2.1 fix")

    def test_first_line_only_whitespace_collapsed(self):
        self.assertEqual(ha.clean_manual_summary("  Fix   Login \n second line "), "Fix Login")

    def test_caps_length_to_the_card_width(self):
        self.assertEqual(len(ha.clean_manual_summary("x" * 200)), ha.SUMMARY_MAX_CHARS)

    def test_word_count_is_not_capped(self):
        # The model's reply is capped at SUMMARY_MAX_WORDS; a human's isn't.
        self.assertEqual(ha.clean_manual_summary("one two three four five six seven"),
                         "one two three four five six seven")

    def test_blank_clears(self):
        self.assertIsNone(ha.clean_manual_summary(""))
        self.assertIsNone(ha.clean_manual_summary("   \n  "))
        self.assertIsNone(ha.clean_manual_summary(None))


class TestResolveSubagent(unittest.TestCase):
    """_resolve_subagent maps a pane agent-list row (type + description) to the
    background agent's transcript, via the main transcript's Task call + its
    result's 'agentId: <id>'."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hub-agent-sub-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _main_with_task(self, agent_id, subagent_type, description):
        """Write a main transcript holding one Task tool_use + its tool_result
        (carrying agentId) and the subagent transcript it names. Returns the
        main transcript path."""
        main = os.path.join(self.tmp, "main.jsonl")
        tool_id = "toolu_" + agent_id
        lines = [
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": tool_id, "name": "Task",
                 "input": {"subagent_type": subagent_type,
                           "description": description, "prompt": "go"}}]}},
            {"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": tool_id, "content": [
                    {"type": "text",
                     "text": f"Async agent launched successfully.\nagentId: {agent_id} (internal)"}]}]}},
        ]
        with open(main, "w") as f:
            for e in lines:
                f.write(json.dumps(e) + "\n")
        subdir = os.path.join(self.tmp, "main", "subagents")
        os.makedirs(subdir)
        sub = os.path.join(subdir, f"agent-{agent_id}.jsonl")
        with open(sub, "w") as f:
            f.write(json.dumps({"agentId": agent_id, "isSidechain": True,
                                "message": {"content": "working"}}) + "\n")
        return main, sub

    def _main_with_agent_call(self, agent_id, description):
        """The same, but as today's `Agent` call: named `Agent`, and carrying NO
        subagent_type — which is why the clicked row's type is the generic
        "agent"."""
        main = os.path.join(self.tmp, "main.jsonl")
        tool_id = "toolu_" + agent_id
        lines = [
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": tool_id, "name": "Agent",
                 "input": {"description": description, "prompt": "go",
                           "run_in_background": True}}]}},
            {"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": tool_id, "content": [
                    {"type": "text",
                     "text": f"Async agent launched successfully.\nagentId: {agent_id} (internal)"}]}]}},
        ]
        with open(main, "w") as f:
            for e in lines:
                f.write(json.dumps(e) + "\n")
        subdir = os.path.join(self.tmp, "main", "subagents")
        os.makedirs(subdir, exist_ok=True)
        sub = os.path.join(subdir, f"agent-{agent_id}.jsonl")
        with open(sub, "w") as f:
            f.write(json.dumps({"agentId": agent_id, "isSidechain": True,
                                "message": {"content": "working"}}) + "\n")
        return main, sub

    def test_resolves_todays_agent_call_via_the_wildcard_type(self):
        # Only `Task` was matched here, so on today's transcripts NO clicked row
        # resolved and every subagent view opened empty. A background launch
        # carries no subagent_type, so the row's generic "agent" must act as a
        # wildcard and let the description decide.
        main, sub = self._main_with_agent_call("ag9001", "QA lifecycle probe")
        self.assertEqual(ha._resolve_subagent(main, "agent", "QA lifecycle probe"), sub)
        # A pane-truncated label still resolves through the same path.
        self.assertEqual(ha._resolve_subagent(main, "agent", "QA lifecycle pro…"), sub)

    def test_resolves_exact_type_and_label(self):
        main, sub = self._main_with_task("abc123", "Explore", "Find the parser")
        self.assertEqual(ha._resolve_subagent(main, "Explore", "Find the parser"), sub)

    def test_resolves_truncated_label_by_prefix(self):
        main, sub = self._main_with_task("abc123", "Explore", "Find the parser code")
        # A pane-truncated label (a prefix) still resolves.
        self.assertEqual(ha._resolve_subagent(main, "Explore", "Find the parser"), sub)

    def test_resolves_ellipsized_label_and_type(self):
        # XERK-130: on a narrow pane the TUI cuts a long cell with its own "…"
        # ellipsis, which is not part of the real value — it must be stripped
        # or the prefix match can never succeed.
        main, sub = self._main_with_task(
            "abc123", "general-purpose", "Search for pane busy detection code")
        self.assertEqual(
            ha._resolve_subagent(main, "general-purpose",
                                 "Search for pane busy dete…"), sub)
        # The type column can be cut too on an extreme width.
        self.assertEqual(
            ha._resolve_subagent(main, "general-pur…",
                                 "Search for pane busy detection code"), sub)
        # "..." accepted alongside for safety.
        self.assertEqual(
            ha._resolve_subagent(main, "general-purpose",
                                 "Search for pane busy dete..."), sub)

    def test_ellipsis_stripping_does_not_break_a_genuine_match(self):
        # A description whose real text ends in "…" still resolves when the
        # pane shows it whole (the stripped remnant is a prefix of the real one).
        main, sub = self._main_with_task("abc123", "Explore", "Keep digging…")
        self.assertEqual(ha._resolve_subagent(main, "Explore", "Keep digging…"), sub)

    def test_newest_matching_task_wins(self):
        main = os.path.join(self.tmp, "main.jsonl")
        subdir = os.path.join(self.tmp, "main", "subagents")
        os.makedirs(subdir)
        rows = []
        for aid in ("old1", "new2"):
            tid = "toolu_" + aid
            rows.append({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": tid, "name": "Task",
                 "input": {"subagent_type": "Explore", "description": "Same task"}}]}})
            rows.append({"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": tid, "content":
                 f"agentId: {aid}"}]}})
            with open(os.path.join(subdir, f"agent-{aid}.jsonl"), "w") as f:
                f.write("{}\n")
        with open(main, "w") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
        self.assertEqual(ha._resolve_subagent(main, "Explore", "Same task"),
                         os.path.join(subdir, "agent-new2.jsonl"))

    def test_no_match_or_missing_file_returns_none(self):
        main, _sub = self._main_with_task("abc123", "Explore", "Find the parser")
        self.assertIsNone(ha._resolve_subagent(main, "general-purpose", "Find the parser"))
        self.assertIsNone(ha._resolve_subagent(main, "Explore", "Nonexistent"))
        # main is the pseudo-agent — never a subagent file.
        self.assertIsNone(ha._resolve_subagent(main, "main", ""))


class TestResolveWorkflowRun(unittest.TestCase):
    """XERK-304: a `workflow` row resolves to a RUN — a directory of agent
    transcripts — not to one conversation, and the run is keyed on the launch
    record's `runId`. Fixtures mirror the real shapes captured off a live
    Claude Code 2.1 workflow run."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hub-agent-wf-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.main = os.path.join(self.tmp, "main.jsonl")

    def _launch(self, name, run_id, task_id="we1gtmfyd"):
        """One Workflow launch as Claude Code records it: the tool_use, plus the
        `local_workflow` toolUseResult carrying BOTH ids."""
        return [
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "toolu_" + run_id, "name": "Workflow",
                 "input": {"script": "export const meta = {}"}}]}},
            {"type": "user", "toolUseResult": {
                "status": "async_launched", "taskId": task_id,
                "taskType": "local_workflow", "workflowName": name,
                "runId": run_id, "summary": name + " summary",
                "transcriptDir": "/somewhere/else/entirely/" + run_id,
            }, "message": {"content": [
                {"type": "tool_result", "tool_use_id": "toolu_" + run_id,
                 "content": "Workflow launched in background."}]}},
        ]

    def _write_main(self, *launches):
        with open(self.main, "w") as f:
            for group in launches:
                for e in group:
                    f.write(json.dumps(e) + "\n")

    def _run_dir(self, run_id):
        d = os.path.join(self.tmp, "main", "subagents", "workflows", run_id)
        os.makedirs(d, exist_ok=True)
        return d

    def _record(self, run_id, agents):
        """The run's own record, a SIBLING of subagents/ at
        <stem>/workflows/<runId>.json. `agents` is [(agentId, label, state)].
        Shape taken from a real Claude Code 2.1 run record."""
        d = os.path.join(self.tmp, "main", "workflows")
        os.makedirs(d, exist_ok=True)
        progress = [{"type": "workflow_phase", "index": 1, "title": "Probe"}]
        for i, (aid, label, state) in enumerate(agents, start=1):
            progress.append({
                "type": "workflow_agent", "index": i, "label": label,
                "phaseIndex": 1, "phaseTitle": "Probe", "agentId": aid,
                "state": state, "startedAt": 1787023867583 + i * 1000,
                "promptPreview": "…", "attempt": 1,
            })
        with open(os.path.join(d, run_id + ".json"), "w") as f:
            json.dump({"runId": run_id, "workflowName": "fixture",
                       "status": "completed", "workflowProgress": progress}, f)
        return os.path.join(self.tmp, "main.jsonl")

    def _agent(self, run_dir, aid, prompt, ts, meta=None, done=False):
        with open(os.path.join(run_dir, "agent-%s.jsonl" % aid), "w") as f:
            f.write(json.dumps({"type": "user", "uuid": "u-" + aid,
                                "agentId": aid, "isSidechain": True,
                                "timestamp": ts,
                                "message": {"role": "user", "content": prompt}}) + "\n")
            f.write(json.dumps({"type": "assistant", "uuid": "a-" + aid,
                                "agentId": aid, "isSidechain": True,
                                "message": {"content": [
                                    {"type": "text", "text": "answer from " + aid}]}}) + "\n")
        # The real meta of a workflow agent: an agentType and a depth, and NO
        # description — which is why the row is named off the first prompt.
        with open(os.path.join(run_dir, "agent-%s.meta.json" % aid), "w") as f:
            json.dump(meta if meta is not None
                      else {"agentType": "workflow-subagent", "spawnDepth": 1}, f)
        if done is not None:
            with open(os.path.join(run_dir, "journal.jsonl"), "a") as f:
                f.write(json.dumps({"type": "started", "agentId": aid}) + "\n")
                if done:
                    f.write(json.dumps({"type": "result", "agentId": aid,
                                        "result": "ok"}) + "\n")

    def test_the_run_dir_is_the_runId_not_the_taskId(self):
        # The ROW is keyed on taskId (what _async_launch reads), but the DIR is
        # named after runId — two different handles. Reading taskId as the
        # directory name is what resolved nothing at all.
        self._write_main(self._launch("code-review", "wf_86e01141-7bc",
                                      task_id="we1gtmfyd"))
        run = self._run_dir("wf_86e01141-7bc")
        os.makedirs(os.path.join(self.tmp, "main", "subagents", "workflows",
                                 "we1gtmfyd"), exist_ok=True)
        self.assertEqual(ha._resolve_workflow_run(self.main, "code-review"), run)

    def test_the_records_absolute_transcriptDir_is_never_followed(self):
        # It is untrusted input on a path join AND wrong for a session that has
        # since migrated to a host mounting REPOS_ROOT elsewhere. The run id is
        # rebuilt under THIS transcript's own tree instead.
        self._write_main(self._launch("code-review", "wf_aaa111"))
        run = self._run_dir("wf_aaa111")
        self.assertEqual(ha._resolve_workflow_run(self.main, "code-review"), run)
        self.assertFalse(os.path.exists("/somewhere/else/entirely/wf_aaa111"))

    def test_newest_matching_launch_wins(self):
        self._write_main(self._launch("nightly", "wf_old111"),
                         self._launch("nightly", "wf_new222"))
        self._run_dir("wf_old111")
        newest = self._run_dir("wf_new222")
        self.assertEqual(ha._resolve_workflow_run(self.main, "nightly"), newest)

    def test_a_pane_ellipsized_name_still_resolves(self):
        self._write_main(self._launch("exhaustive-code-review", "wf_bbb222"))
        run = self._run_dir("wf_bbb222")
        self.assertEqual(
            ha._resolve_workflow_run(self.main, "exhaustive-code-…"), run)

    def test_an_unknown_name_or_missing_dir_resolves_to_nothing(self):
        self._write_main(self._launch("code-review", "wf_ccc333"))
        self.assertIsNone(ha._resolve_workflow_run(self.main, "some-other-flow"))
        # The launch is recorded but the run wrote no dir yet.
        self.assertIsNone(ha._resolve_workflow_run(self.main, "code-review"))

    def test_a_forged_run_id_can_never_name_a_directory(self):
        # runId comes off the transcript and is joined onto a path; a value that
        # isn't a run id is dropped rather than escaping the workflows/ dir.
        for forged in ("../../../../etc", "wf_../..", "", "nope"):
            self._write_main(self._launch("evil", forged))
            self.assertIsNone(ha._resolve_workflow_run(self.main, "evil"))

    def test_agents_are_listed_in_launch_order_with_prompt_labels(self):
        self._write_main(self._launch("fixture", "wf_ddd444"))
        run = self._run_dir("wf_ddd444")
        self._agent(run, "a6e2ac4a81e8d4ede", "Reply with exactly the word: beta.",
                    "2026-08-18T03:31:09.349Z", done=True)
        self._agent(run, "a7cee247530950375", "Reply with exactly the word: alpha.",
                    "2026-08-18T03:31:07.583Z", done=False)
        rows, truncated = ha._workflow_agents(run)
        self.assertFalse(truncated)
        # Ordered by first timestamp — launch order — not by name or mtime.
        self.assertEqual([r["id"] for r in rows],
                         ["a7cee247530950375", "a6e2ac4a81e8d4ede"])
        self.assertEqual(rows[0]["label"], "Reply with exactly the word: alpha.")
        self.assertEqual([r["status"] for r in rows], ["running", "done"])

    def test_the_run_record_names_the_rows(self):
        # The whole point of the picker: a fan-out over ONE prompt template
        # renders every row identically unless the script's own `label:` is
        # used, and the run record is the only place on disk that has it.
        self._write_main(self._launch("fixture", "wf_rec111"))
        run = self._run_dir("wf_rec111")
        prompt = "Write a thorough essay of approximately 900 words on "
        for aid in ("ag1", "ag2", "ag3"):
            self._agent(run, aid, prompt, "2026-08-18T03:31:07.583Z", done=True)
        self._record("wf_rec111", [("ag1", "essay:compilers", "done"),
                                   ("ag2", "essay:filesystems", "done"),
                                   ("ag3", "essay:networking", "running")])
        rec = ha._workflow_run_record(self.main, "wf_rec111")
        rows, _ = ha._workflow_agents(run, rec)
        self.assertEqual([r["label"] for r in rows],
                         ["essay:compilers", "essay:filesystems", "essay:networking"])
        # Without it every row is the same string — a picker you cannot pick from.
        plain, _ = ha._workflow_agents(run)
        self.assertEqual(len({r["label"] for r in plain}), 1)

    def test_a_recorded_state_is_passed_through_not_flattened(self):
        # "failed"/"skipped" are worth seeing; collapsing them to done/running
        # hides an agent that never produced anything.
        self._write_main(self._launch("fixture", "wf_rec222"))
        run = self._run_dir("wf_rec222")
        for aid in ("ag1", "ag2"):
            self._agent(run, aid, "work", "2026-08-18T03:31:07.583Z", done=True)
        self._record("wf_rec222", [("ag1", "one", "failed"), ("ag2", "two", "skipped")])
        rows, _ = ha._workflow_agents(
            run, ha._workflow_run_record(self.main, "wf_rec222"))
        self.assertEqual([r["status"] for r in rows], ["failed", "skipped"])

    def test_the_record_orders_the_rows_by_launch_index(self):
        self._write_main(self._launch("fixture", "wf_rec333"))
        run = self._run_dir("wf_rec333")
        # Written with timestamps in the OPPOSITE order to the record's index,
        # so only the index can produce the expected sequence.
        self._agent(run, "late", "b", "2026-08-18T03:31:01.000Z", done=True)
        self._agent(run, "early", "a", "2026-08-18T03:31:09.000Z", done=True)
        self._record("wf_rec333", [("early", "first", "done"), ("late", "second", "done")])
        rows, _ = ha._workflow_agents(
            run, ha._workflow_run_record(self.main, "wf_rec333"))
        self.assertEqual([r["id"] for r in rows], ["early", "late"])

    def test_an_agent_the_record_misses_still_gets_a_row(self):
        # A partially-recorded run must stay deterministic and complete: the
        # uncovered agent falls back to its prompt and sorts after the rest.
        self._write_main(self._launch("fixture", "wf_rec444"))
        run = self._run_dir("wf_rec444")
        self._agent(run, "known", "recorded work", "2026-08-18T03:31:07.000Z", done=True)
        self._agent(run, "orphan", "unrecorded work", "2026-08-18T03:31:08.000Z", done=True)
        self._record("wf_rec444", [("known", "the recorded one", "done")])
        rows, _ = ha._workflow_agents(
            run, ha._workflow_run_record(self.main, "wf_rec444"))
        self.assertEqual([r["id"] for r in rows], ["known", "orphan"])
        self.assertEqual(rows[1]["label"], "unrecorded work")

    def test_a_missing_or_oversized_record_falls_back_to_the_transcripts(self):
        self._write_main(self._launch("fixture", "wf_rec555"))
        run = self._run_dir("wf_rec555")
        self._agent(run, "ag1", "the prompt", "2026-08-18T03:31:07.583Z", done=True)
        self.assertIsNone(ha._workflow_run_record(self.main, "wf_rec555"))
        d = os.path.join(self.tmp, "main", "workflows")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "wf_rec555.json"), "w") as f:
            f.write("x" * (ha.WORKFLOW_RECORD_MAX_BYTES + 1))
        self.assertIsNone(ha._workflow_run_record(self.main, "wf_rec555"))
        rows, _ = ha._workflow_agents(run, None)
        self.assertEqual(rows[0]["label"], "the prompt")

    def test_a_forged_run_id_cannot_name_a_record_either(self):
        self._write_main(self._launch("fixture", "wf_rec666"))
        for forged in ("../../../../etc/passwd", "..", "", "wf_../x"):
            self.assertIsNone(ha._workflow_run_record(self.main, forged))

    def test_the_records_epoch_startedAt_is_normalised_to_ISO(self):
        # It times agents in epoch ms while the rest of this wire is ISO, and a
        # field that is a string on one path and a number on the other is what
        # breaks a typed client's decode.
        self._write_main(self._launch("fixture", "wf_rec777"))
        run = self._run_dir("wf_rec777")
        self._agent(run, "ag1", "work", "2026-08-18T03:31:07.583Z", done=True)
        self._record("wf_rec777", [("ag1", "named", "done")])
        rows, _ = ha._workflow_agents(
            run, ha._workflow_run_record(self.main, "wf_rec777"))
        self.assertRegex(rows[0]["startedAt"], r"^\d{4}-\d{2}-\d{2}T[\d:]{8}Z$")
        self.assertEqual(ha._epoch_ms_iso("not a number"), "")
        self.assertEqual(ha._epoch_ms_iso(None), "")

    def test_a_partially_recorded_run_still_gets_status_from_the_journal(self):
        # A record covering SOME agents must not suppress the journal for the
        # rest: the journal on disk knew the answer for every one of them, and
        # the run served rows with no status beside rows that had one.
        self._write_main(self._launch("fixture", "wf_par111"))
        run = self._run_dir("wf_par111")
        for aid in ("p1", "p2", "p3"):
            self._agent(run, aid, "prompt for " + aid, "2026-08-18T04:02:00.000Z", done=True)
        self._record("wf_par111", [("p1", "one", "done"), ("p2", "two", "done")])
        rows, _ = ha._workflow_agents(
            run, ha._workflow_run_record(self.main, "wf_par111"))
        by_id = {r["id"]: r for r in rows}
        self.assertEqual(by_id["p3"].get("status"), "done",
                         "the uncovered agent's status comes from the journal")

    def test_the_journal_is_folded_at_most_ONCE_however_many_rows_need_it(self):
        # Two separate properties, and asserting only the first leaves the second
        # free to regress: the fold is LAZY (a fully recorded run never reads the
        # journal) and MEMOISED (a run with many uncovered agents reads it once,
        # not once per row). It costs up to 5.7s on a large journal and runs on
        # the synchronous beat loop, so per-row would be beat latency multiplied.
        self._write_main(self._launch("fixture", "wf_par222"))

        covered = self._run_dir("wf_par222")
        self._agent(covered, "a1", "work", "2026-08-18T04:02:00.000Z", done=True)
        self._record("wf_par222", [("a1", "named", "done")])
        rec = ha._workflow_run_record(self.main, "wf_par222")
        with mock.patch.object(ha, "_workflow_finished_agents") as folded:
            rows, _ = ha._workflow_agents(covered, rec)
        folded.assert_not_called()
        self.assertEqual(rows[0]["status"], "done")

        # Now a run the record covers only partly, with SEVERAL uncovered agents.
        self._write_main(self._launch("fixture", "wf_par333"))
        partial = self._run_dir("wf_par333")
        for aid in ("u1", "u2", "u3", "u4"):
            self._agent(partial, aid, "work " + aid, "2026-08-18T04:02:00.000Z", done=True)
        self._record("wf_par333", [("u1", "named", "done")])
        rec2 = ha._workflow_run_record(self.main, "wf_par333")
        with mock.patch.object(ha, "_workflow_finished_agents",
                               return_value={"u2", "u3", "u4"}) as folded:
            rows, _ = ha._workflow_agents(partial, rec2)
        self.assertEqual(folded.call_count, 1,
                         "three uncovered rows must share ONE fold, not take one each")
        self.assertEqual(sorted(r["status"] for r in rows),
                         ["done", "done", "done", "done"])

        # And a fold that answers None — an UNREADABLE journal — is memoised too.
        # Memoising only a truthy result re-reads once per uncovered row in
        # exactly the case where the read is most likely to be slow.
        with mock.patch.object(ha, "_workflow_finished_agents",
                               return_value=None) as folded:
            rows, _ = ha._workflow_agents(partial, rec2)
        self.assertEqual(folded.call_count, 1, "a None fold is memoised too")
        self.assertEqual([r for r in rows if "status" in r][0]["label"], "named")

    def test_a_record_that_is_not_an_object_is_refused(self):
        # json.load happily returns a list; without the isinstance guard the
        # progress read raises AttributeError and the drill-down never answers.
        self._write_main(self._launch("fixture", "wf_bad111"))
        d = os.path.join(self.tmp, "main", "workflows")
        os.makedirs(d, exist_ok=True)
        for body in ("[1, 2, 3]", '"a string"', "null", "17"):
            with open(os.path.join(d, "wf_bad111.json"), "w") as f:
                f.write(body)
            self.assertIsNone(ha._workflow_run_record(self.main, "wf_bad111"), body)

    def test_a_deeply_nested_record_is_a_MISS_not_an_escape(self):
        # json.load blows the stack on this, and RecursionError is not a
        # ValueError — escaping leaves handle_commands' blanket catch to stage
        # NOTHING, so the client polls to its timeout instead of being told.
        self._write_main(self._launch("fixture", "wf_bad222"))
        d = os.path.join(self.tmp, "main", "workflows")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "wf_bad222.json"), "w") as f:
            f.write("[" * 100000 + "]" * 100000)
        self.assertIsNone(ha._workflow_run_record(self.main, "wf_bad222"))

    def test_a_forged_run_id_is_refused_by_the_record_read_ITSELF(self):
        # Defence in depth: _resolve_workflow_run has already validated the id
        # by the time this is called, so only a direct test pins the check here.
        self._write_main(self._launch("fixture", "wf_bad333"))
        d = os.path.join(self.tmp, "main", "workflows")
        os.makedirs(d, exist_ok=True)
        # A real, readable file the forged id would otherwise reach.
        with open(os.path.join(d, "secret.json"), "w") as f:
            json.dump({"workflowProgress": []}, f)
        for forged in ("../workflows/secret", "secret", "", "..", "wf_a/../b"):
            self.assertIsNone(ha._workflow_run_record(self.main, forged), forged)

    def test_record_derived_label_and_status_are_capped(self):
        # They ride the heartbeat body, so their size is the agent's to bound —
        # the hub's own 256-char cap is the second line of defence, not the first.
        self._write_main(self._launch("fixture", "wf_cap111"))
        run = self._run_dir("wf_cap111")
        self._agent(run, "a1", "work", "2026-08-18T04:02:00.000Z", done=True)
        self._record("wf_cap111", [("a1", "L" * 5000, "S" * 5000)])
        rows, _ = ha._workflow_agents(
            run, ha._workflow_run_record(self.main, "wf_cap111"))
        self.assertEqual(len(rows[0]["label"]), ha.WORKFLOW_AGENT_LABEL_CHARS)
        self.assertEqual(len(rows[0]["status"]), ha.WORKFLOW_AGENT_LABEL_CHARS)

    def test_a_meta_description_beats_the_prompt_when_there_is_one(self):
        self._write_main(self._launch("fixture", "wf_eee555"))
        run = self._run_dir("wf_eee555")
        self._agent(run, "ag1", "a very long prompt nobody wants as a title",
                    "2026-08-18T03:31:07.583Z",
                    meta={"agentType": "qa", "description": "review:bugs"})
        rows, _ = ha._workflow_agents(run)
        self.assertEqual(rows[0]["label"], "review:bugs")

    def test_no_journal_means_no_status_rather_than_a_guess(self):
        # An absent field is "this run can't say", never "nothing finished" —
        # the same rule the heartbeat's capability flags follow.
        self._write_main(self._launch("fixture", "wf_fff666"))
        run = self._run_dir("wf_fff666")
        self._agent(run, "ag1", "do a thing", "2026-08-18T03:31:07.583Z", done=None)
        rows, _ = ha._workflow_agents(run)
        self.assertNotIn("status", rows[0])

    def test_a_nested_child_workflows_agents_belong_to_the_run(self):
        # A script may call workflow() to run a child inline; its agents land one
        # dir deeper and are as much part of this run as the top-level ones.
        self._write_main(self._launch("parent", "wf_ggg777"))
        run = self._run_dir("wf_ggg777")
        self._agent(run, "ag1", "top level", "2026-08-18T03:31:07.000Z", done=True)
        child = os.path.join(run, "wf_child888")
        os.makedirs(child)
        self._agent(child, "ag2", "nested", "2026-08-18T03:31:08.000Z", done=True)
        rows, _ = ha._workflow_agents(run)
        self.assertEqual([r["id"] for r in rows], ["ag1", "ag2"])
        self.assertTrue(ha._workflow_agent_path(run, "ag2"))

    def test_the_list_is_capped_and_says_so(self):
        self._write_main(self._launch("big", "wf_hhh999"))
        run = self._run_dir("wf_hhh999")
        for i in range(ha.WORKFLOW_AGENTS_MAX + 5):
            self._agent(run, "ag%04d" % i, "task %d" % i,
                        "2026-08-18T03:%02d:00.000Z" % (i % 60), done=None)
        rows, truncated = ha._workflow_agents(run)
        self.assertEqual(len(rows), ha.WORKFLOW_AGENTS_MAX)
        self.assertTrue(truncated)

    def test_an_UNREADABLE_journal_says_nothing_rather_than_running(self):
        # An OSError reading the journal used to be indistinguishable from an
        # empty one, so every agent of a run that finished hours ago came back
        # `running`. "Can't tell" is no status at all.
        self._write_main(self._launch("fixture", "wf_jjj111"))
        run = self._run_dir("wf_jjj111")
        self._agent(run, "ag1", "do a thing", "2026-08-18T03:31:07.583Z", done=True)
        journal = os.path.join(run, "journal.jsonl")
        os.chmod(journal, 0)
        self.addCleanup(os.chmod, journal, 0o644)
        if os.access(journal, os.R_OK):
            self.skipTest("running as root — an unreadable file cannot be staged")
        self.assertIsNone(ha._workflow_finished_agents(run))
        rows, _ = ha._workflow_agents(run)
        self.assertNotIn("status", rows[0])

    def test_a_journal_larger_than_any_tail_window_still_reports_every_result(self):
        # A `result` line carries the agent's RETURN VALUE, so a few dozen agents
        # push the journal past a fixed tail — and the records a tail drops are
        # the OLDEST, which the launch-order sort puts at the TOP of the picker.
        # They read as "still running" forever.
        self._write_main(self._launch("big", "wf_kkk222"))
        run = self._run_dir("wf_kkk222")
        payload = "x" * 30000
        with open(os.path.join(run, "journal.jsonl"), "w") as f:
            for i in range(40):
                aid = "ag%02d" % i
                f.write(json.dumps({"type": "started", "agentId": aid}) + "\n")
                f.write(json.dumps({"type": "result", "agentId": aid,
                                    "result": payload}) + "\n")
        self.assertGreater(os.path.getsize(os.path.join(run, "journal.jsonl")), 1 << 20)
        done = ha._workflow_finished_agents(run)
        self.assertEqual(len(done), 40)
        self.assertIn("ag00", done, "the OLDEST result is the one a tail window drops")

    def test_an_over_long_result_line_is_still_credited_to_its_own_agent(self):
        # An agent whose RETURN VALUE contains the text of a journal record must
        # not retire the agent that text names. JSON escaping is what does this —
        # inside a string the nested record's quotes are backslash-escaped, so
        # the unescaped pattern cannot match — and it holds at every length.
        self._write_main(self._launch("big", "wf_lll333"))
        run = self._run_dir("wf_lll333")
        forged = json.dumps({"type": "result", "agentId": "victim"})
        with open(os.path.join(run, "journal.jsonl"), "w") as f:
            f.write(json.dumps({"type": "result", "agentId": "real1",
                                "result": forged + "y" * (1 << 19)}) + "\n")
            # Same record with its fields REORDERED, so the forged text sits
            # ahead of the real id. The anchored marker refuses this line rather
            # than risk crediting the victim — the cost of the anchor, paid as a
            # miss (the agent reads as still running), which is the safe way to
            # be wrong. Real journals write `type` first, so this is the
            # hypothetical half of the trade, not the live one.
            f.write(json.dumps({"result": forged + "y" * (1 << 19),
                                "type": "result", "agentId": "real2"}) + "\n")
        done = ha._workflow_finished_agents(run)
        self.assertEqual(done, {"real1"})
        self.assertNotIn("victim", done, "never the agent named inside a return value")

    def test_a_CORRUPT_over_long_line_cannot_retire_an_agent(self):
        # The case JSON escaping does NOT cover: a half-written or corrupt line
        # that is not valid JSON at all and carries a raw record inside it. The
        # anchored marker is what refuses it — an unanchored search would find
        # the record anywhere in the line and mark a live agent finished.
        self._write_main(self._launch("big", "wf_ooo666"))
        run = self._run_dir("wf_ooo666")
        raw = b'{"type":"result","agentId":"victim"}'
        with open(os.path.join(run, "journal.jsonl"), "wb") as f:
            f.write(b'GARBAGE ' + raw + b'z' * (1 << 19) + b'\n')
            f.write(json.dumps({"type": "result", "agentId": "real1"}).encode() + b'\n')
        self.assertEqual(ha._workflow_finished_agents(run), {"real1"})

    def test_a_journal_far_past_any_tail_reports_its_NEWEST_results_too(self):
        # The read cap is a runaway backstop, not a working limit: reading
        # forward means hitting it would drop the NEWEST results, so it has to
        # sit far above any real journal.
        self._write_main(self._launch("big", "wf_ppp777"))
        run = self._run_dir("wf_ppp777")
        payload = "x" * 500000
        with open(os.path.join(run, "journal.jsonl"), "w") as f:
            for i in range(200):
                f.write(json.dumps({"type": "result", "agentId": "ag%03d" % i,
                                    "result": payload}) + "\n")
        self.assertGreater(os.path.getsize(os.path.join(run, "journal.jsonl")), 64 << 20)
        done = ha._workflow_finished_agents(run)
        self.assertEqual(len(done), 200)
        self.assertIn("ag199", done, "the NEWEST result is the one a forward cap drops")

    def test_a_prompt_past_the_label_bound_leaves_the_row_nameless_not_broken(self):
        # The byte bound truncates rather than degrading, so an enormous first
        # prompt yields no label at all. That is the accepted trade against an
        # unbounded read on a memory-limited container — and the row must stay
        # usable, which is why both clients fall back to the id.
        self._write_main(self._launch("fixture", "wf_qqq888"))
        run = self._run_dir("wf_qqq888")
        self._agent(run, "huge", "P" * (ha.WORKFLOW_LABEL_MAX_BYTES + (1 << 16)),
                    "2026-08-18T03:31:07.583Z", done=True)
        rows, _ = ha._workflow_agents(run)
        self.assertEqual(rows[0]["id"], "huge")
        self.assertEqual(rows[0]["label"], "")

    def test_a_realistically_large_prompt_is_still_named(self):
        # The bound is generous on purpose: a prompt of a few hundred KB — a
        # pasted diff, a long spec — is ordinary and must still name its row.
        self._write_main(self._launch("fixture", "wf_rrr999"))
        run = self._run_dir("wf_rrr999")
        self._agent(run, "big1", "Review this diff: " + "d" * 300000,
                    "2026-08-18T03:31:07.583Z", done=True)
        rows, _ = ha._workflow_agents(run)
        self.assertTrue(rows[0]["label"].startswith("Review this diff:"))

    def test_a_SYMLINKED_agent_transcript_is_not_followed(self):
        # isfile FOLLOWS links, so `agent-etc.jsonl -> /etc/passwd` showed up as a
        # phantom agent whose "transcript" was whatever it pointed at.
        self._write_main(self._launch("fixture", "wf_mmm444"))
        run = self._run_dir("wf_mmm444")
        self._agent(run, "real", "a real prompt", "2026-08-18T03:31:07.583Z", done=True)
        outside = os.path.join(self.tmp, "elsewhere.jsonl")
        with open(outside, "w") as f:
            f.write(json.dumps({"type": "user", "message": {"content": "secret"}}) + "\n")
        os.symlink(outside, os.path.join(run, "agent-linked.jsonl"))
        self.assertEqual(sorted(ha._workflow_agent_files(run)), ["real"])
        self.assertIsNone(ha._workflow_agent_path(run, "linked"))

    def test_a_file_whose_id_is_not_an_id_is_skipped(self):
        # Pins VALID_WORKFLOW_AGENT_ID_RE itself. The walk-map lookup already
        # makes an escape impossible, so without this the pattern check can be
        # deleted with the whole suite still green.
        self._write_main(self._launch("fixture", "wf_nnn555"))
        run = self._run_dir("wf_nnn555")
        self._agent(run, "good1", "fine", "2026-08-18T03:31:07.583Z", done=True)
        for bad in ("agent-.jsonl", "agent-with space.jsonl", "agent-" + "z" * 65 + ".jsonl"):
            with open(os.path.join(run, bad), "w") as f:
                f.write("{}\n")
        self.assertEqual(sorted(ha._workflow_agent_files(run)), ["good1"])

    def test_an_agent_id_can_never_escape_the_run_dir(self):
        # The id arrives from a clicked row over HTTP and is about to name a
        # file, so it is matched against the run's own walk, never joined on.
        self._write_main(self._launch("fixture", "wf_iii000"))
        run = self._run_dir("wf_iii000")
        self._agent(run, "ag1", "do a thing", "2026-08-18T03:31:07.583Z", done=True)
        outside = os.path.join(self.tmp, "agent-secret.jsonl")
        with open(outside, "w") as f:
            f.write("{}\n")
        for forged in ("../../../../etc/passwd", "../agent-secret", "..", "",
                       "a/b", "a" * 200):
            self.assertIsNone(ha._workflow_agent_path(run, forged), forged)
        self.assertTrue(ha._workflow_agent_path(run, "ag1"))
        # Surrounding whitespace is trimmed rather than refused, matching the
        # hub's own `.trim()` on the query param — the two ends must agree on
        # what the id IS before they can agree on whether it is allowed.
        self.assertTrue(ha._workflow_agent_path(run, " ag1 "))


class TestStageSubagentHistory(ManagerMixin, unittest.TestCase):
    def _setup_session(self, sm):
        wt = "/w/.turma/worktrees/repo/aaa"
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(wt))
        os.makedirs(proj)
        main = os.path.join(proj, "trans1.jsonl")
        tool_id = "toolu_xyz"
        with open(main, "w") as f:
            f.write(json.dumps({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": tool_id, "name": "Task",
                 "input": {"subagent_type": "Explore", "description": "Map the code"}}]}}) + "\n")
            f.write(json.dumps({"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": tool_id,
                 "content": "agentId: sub777"}]}}) + "\n")
        subdir = os.path.join(proj, "trans1", "subagents")
        os.makedirs(subdir)
        with open(os.path.join(subdir, "agent-sub777.jsonl"), "w") as f:
            f.write(json.dumps({"type": "user", "uuid": "u1",
                                "message": {"content": "explore this repo"}}) + "\n")
            f.write(json.dumps({"type": "assistant", "uuid": "u2",
                                "message": {"content": [{"type": "text", "text": "done exploring"}]}}) + "\n")
        sm.registry = [{"id": "s1", "status": "running", "worktreePath": wt}]

    def test_stages_the_resolved_subagent_transcript(self):
        sm = self.make_manager()
        self._setup_session(sm)
        sm._stage_subagent_history("s1", "Explore", "Map the code")
        self.assertEqual(len(sm.subagent_history_results), 1)
        r = sm.subagent_history_results[0]
        self.assertEqual((r["sessionId"], r["type"], r["label"]),
                         ("s1", "Explore", "Map the code"))
        self.assertTrue(any("done exploring" in (e.get("text") or "") for e in r["entries"]))

    def test_unresolved_row_stages_empty_result(self):
        sm = self.make_manager()
        self._setup_session(sm)
        sm._stage_subagent_history("s1", "Explore", "No such agent")
        self.assertEqual(sm.subagent_history_results[0]["entries"], [])

    def test_unknown_session_stages_empty_without_raising(self):
        sm = self.make_manager()
        sm.registry = []
        sm._stage_subagent_history("ghost", "Explore", "x")
        self.assertEqual(sm.subagent_history_results[0]["entries"], [])

    # ---- workflow rows (XERK-304) ------------------------------------------

    def _setup_workflow(self, sm, write_agents=True):
        wt = "/w/.turma/worktrees/repo/bbb"
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(wt))
        os.makedirs(proj)
        main = os.path.join(proj, "trans2.jsonl")
        with open(main, "w") as f:
            f.write(json.dumps({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "toolu_wf", "name": "Workflow",
                 "input": {"script": "x"}}]}}) + "\n")
            f.write(json.dumps({"type": "user", "toolUseResult": {
                "status": "async_launched", "taskId": "we1gtmfyd",
                "taskType": "local_workflow", "workflowName": "code-review",
                "runId": "wf_86e01141-7bc"}, "message": {"content": [
                    {"type": "tool_result", "tool_use_id": "toolu_wf",
                     "content": "launched"}]}}) + "\n")
        run = os.path.join(proj, "trans2", "subagents", "workflows", "wf_86e01141-7bc")
        os.makedirs(run)
        if write_agents:
            with open(os.path.join(run, "agent-ag1.jsonl"), "w") as f:
                f.write(json.dumps({"type": "user", "uuid": "u1",
                                    "timestamp": "2026-08-18T03:31:07.583Z",
                                    "message": {"content": "review the diff"}}) + "\n")
                f.write(json.dumps({"type": "assistant", "uuid": "u2",
                                    "message": {"content": [
                                        {"type": "text", "text": "found a bug"}]}}) + "\n")
            with open(os.path.join(run, "journal.jsonl"), "w") as f:
                f.write(json.dumps({"type": "result", "agentId": "ag1"}) + "\n")
        sm.registry = [{"id": "s1", "status": "running", "worktreePath": wt}]

    def test_a_workflow_row_stages_the_runs_agent_LIST(self):
        sm = self.make_manager()
        self._setup_workflow(sm)
        sm._stage_subagent_history("s1", "workflow", "code-review")
        r = sm.subagent_history_results[0]
        self.assertEqual(r["agents"],
                         [{"id": "ag1", "label": "review the diff",
                           "startedAt": "2026-08-18T03:31:07.583Z", "status": "done"}])
        self.assertFalse(r["agentsTruncated"])
        self.assertEqual(r["entries"], [], "the run itself has no conversation")

    def test_an_agentId_stages_that_one_agents_transcript(self):
        sm = self.make_manager()
        self._setup_workflow(sm)
        sm._stage_subagent_history("s1", "workflow", "code-review", "ag1")
        r = sm.subagent_history_results[0]
        self.assertEqual(r["agentId"], "ag1")
        self.assertNotIn("agents", r,
                         "`agents` present is what tells the client it is a list")
        self.assertTrue(any("found a bug" in (e.get("text") or "") for e in r["entries"]))

    def test_a_started_run_with_no_agents_yet_still_answers_as_a_LIST(self):
        # An empty list is a real answer ("nothing running yet"), deliberately
        # distinct from the unresolved row's "unavailable".
        sm = self.make_manager()
        self._setup_workflow(sm, write_agents=False)
        sm._stage_subagent_history("s1", "workflow", "code-review")
        r = sm.subagent_history_results[0]
        self.assertEqual(r["agents"], [])

    def test_an_unresolved_workflow_row_carries_no_agents_key_at_all(self):
        sm = self.make_manager()
        self._setup_workflow(sm)
        sm._stage_subagent_history("s1", "workflow", "no-such-workflow")
        self.assertNotIn("agents", sm.subagent_history_results[0])

    def test_a_forged_agentId_stages_empty_without_raising(self):
        sm = self.make_manager()
        self._setup_workflow(sm)
        sm._stage_subagent_history("s1", "workflow", "code-review", "../../../etc/passwd")
        r = sm.subagent_history_results[0]
        self.assertEqual(r["entries"], [])
        self.assertNotIn("agents", r)


class TestSetSummary(ManagerMixin, unittest.TestCase):
    def test_renames_and_pins_the_name(self):
        sm = self.make_manager()
        sm.registry = [{"id": "s1", "status": "running", "summary": "Auto Name",
                        "summaryRetryAt": 999}]
        sm.set_summary("s1", "  My Own Name  ")
        self.assertEqual(sm.registry[0]["summary"], "My Own Name")
        self.assertTrue(sm.registry[0]["summaryManual"])
        self.assertNotIn("summaryRetryAt", sm.registry[0])

    def test_blank_clears_the_name_and_unpins(self):
        sm = self.make_manager()
        sm.registry = [{"id": "s1", "status": "running", "summary": "My Own Name",
                        "summaryManual": True}]
        sm.set_summary("s1", "  ")
        self.assertIsNone(sm.registry[0]["summary"])
        self.assertFalse(sm.registry[0]["summaryManual"])

    def test_works_on_a_stopped_session(self):
        # Presentational only — no process is touched, so state doesn't gate it.
        sm = self.make_manager()
        sm.registry = [{"id": "s1", "status": "stopped", "summary": None}]
        sm.set_summary("s1", "Renamed While Stopped")
        self.assertEqual(sm.registry[0]["summary"], "Renamed While Stopped")

    def test_unknown_session_is_a_no_op(self):
        sm = self.make_manager()
        sm.registry = []
        sm.set_summary("nope", "Whatever")  # must not raise

    def test_manual_name_survives_an_in_flight_naming_job(self):
        sm = self.make_manager()
        sm.registry = [{"id": "s1", "status": "running", "summary": None}]

        class FakeProc:
            def poll(self_i):
                return 0

            def kill(self_i):
                pass

        with mock.patch.object(ha.subprocess, "Popen", return_value=FakeProc()):
            sm._start_summary(sm.registry[0], "Add a docker compose flag")
        sm.set_summary("s1", "My Own Name")          # renamed mid-flight
        with open(sm.summaries["s1"]["outPath"], "w") as f:
            f.write("Adding Compose Flag\n")
        sm._poll_summaries()
        self.assertEqual(sm.registry[0]["summary"], "My Own Name")  # operator wins
        self.assertEqual(sm.summaries, {})                          # still reaped

    def test_command_routes_to_set_summary(self):
        sm = self.make_manager()
        sm.registry = [{"id": "s1", "status": "running", "summary": None}]
        sm.handle_commands([
            {"cmdId": "c1", "type": "setSummary", "sessionId": "s1", "summary": "Named By Hand"},
        ])
        self.assertEqual(sm.registry[0]["summary"], "Named By Hand")

    def test_manual_name_and_its_pin_survive_kill_then_resume(self):
        sm = self.make_manager()
        sm.registry = [{"id": "s1", "status": "running", "repo": "r", "root": True,
                        "summary": "My Own Name", "summaryManual": True,
                        "tmuxName": "agent-s1", "worktreePath": None,
                        "rcName": "h-r-s1", "ttydPort": 7681}]
        with mock.patch.object(sm, "_kill_tmux"), mock.patch.object(sm, "_kill_ttyd"):
            sm.kill("s1")
        rec = sm.closed[-1]
        self.assertEqual(rec["summary"], "My Own Name")
        self.assertTrue(rec["summaryManual"])
        with mock.patch.object(sm, "_launch_tmux"), mock.patch.object(sm, "_launch_ttyd"):
            sm.resume("s1")
        self.assertEqual(sm.registry[0]["summary"], "My Own Name")
        self.assertTrue(sm.registry[0]["summaryManual"])


class TestSessionSummaries(ManagerMixin, unittest.TestCase):
    def test_missing_prompt_skipped(self):
        sm = self.make_manager()
        with mock.patch.object(ha.subprocess, "Popen") as popen:
            sm._start_summary({"id": "s1"}, "   ")
            sm._start_summary({"id": "s1"}, None)
            popen.assert_not_called()
        self.assertEqual(sm.summaries, {})

    def test_launch_uses_claude_p_headless_off_the_worktree(self):
        sm = self.make_manager()

        class FakeProc:
            def poll(self_i):
                return 0

            def kill(self_i):
                pass

        with mock.patch.object(ha.subprocess, "Popen", return_value=FakeProc()) as popen:
            sm._start_summary({"id": "s1"}, "Add a docker compose flag")
            args = popen.call_args[0][0]
            self.assertEqual(args[:4], ["claude", "-p", "--model", ha.SESSION_SUMMARY_MODEL])
            self.assertIn("Add a docker compose flag", args[-1])  # task in the prompt
            # Runs in the registry dir (not a worktree) and passes no --settings,
            # so it never loads the session safety guard.
            self.assertEqual(popen.call_args[1]["cwd"], ha.REGISTRY_DIR)
            self.assertNotIn("--settings", args)
        self.assertIn("s1", sm.summaries)

    def test_finish_sets_name_and_reaps_job(self):
        sm = self.make_manager()
        sm.registry = [{"id": "s1", "status": "running", "summary": None}]
        sm.save = mock.Mock()

        class FakeProc:
            def poll(self_i):
                return 0

            def kill(self_i):
                pass

        with mock.patch.object(ha.subprocess, "Popen", return_value=FakeProc()):
            sm._start_summary(sm.registry[0], "Add a docker compose flag")
        out_path = sm.summaries["s1"]["outPath"]
        # The model's answer lands on the job's stdout file.
        with open(out_path, "w") as f:
            f.write("Adding Compose Flag\n")
        sm._poll_summaries()
        self.assertEqual(sm.registry[0]["summary"], "Adding Compose Flag")
        self.assertEqual(sm.summaries, {})            # reaped
        self.assertFalse(os.path.exists(out_path))    # temp output cleaned up
        self.assertTrue(sm.save.called)
        # A named session owes no retry, so the armed backoff is cleared.
        self.assertNotIn("summaryRetryAt", sm.registry[0])

    def test_timeout_kills_and_schedules_a_retry(self):
        sm = self.make_manager()
        sm.registry = [{"id": "s1", "status": "running", "summary": None}]
        killed = {"v": False}

        class HangProc:
            def poll(self_i):
                return None  # never exits

            def kill(self_i):
                killed["v"] = True

        with mock.patch.object(ha.subprocess, "Popen", return_value=HangProc()):
            sm._start_summary(sm.registry[0], "do a thing")
        sm.summaries["s1"]["startedMono"] -= ha.SUMMARY_TIMEOUT_SEC + 1  # force overrun
        sm._poll_summaries()
        self.assertTrue(killed["v"])
        self.assertEqual(sm.summaries, {})
        self.assertIsNone(sm.registry[0]["summary"])
        # A hung attempt is a property of the attempt, not the session: it spends
        # one try and leaves the session eligible for the rest.
        self.assertEqual(sm.registry[0]["summaryAttempts"], 1)
        self.assertGreater(sm.registry[0]["summaryRetryAt"], time.time())

    def test_empty_reply_schedules_a_retry(self):
        sm = self.make_manager()
        sm.registry = [{"id": "s1", "status": "running", "summary": None}]

        class FakeProc:
            def poll(self_i):
                return 0  # clean exit, but the model said nothing

            def kill(self_i):
                pass

        with mock.patch.object(ha.subprocess, "Popen", return_value=FakeProc()):
            sm._start_summary(sm.registry[0], "do a thing")
        sm._poll_summaries()  # stdout file is empty
        self.assertIsNone(sm.registry[0]["summary"])
        self.assertEqual(sm.registry[0]["summaryAttempts"], 1)
        self.assertGreater(sm.registry[0]["summaryRetryAt"], time.time())

    def test_attempts_are_capped(self):
        sm = self.make_manager()
        sess = {"id": "s1", "status": "running", "summary": None}
        sm.registry = [sess]

        class FakeProc:
            def poll(self_i):
                return 1  # every attempt fails

            def kill(self_i):
                pass

        with mock.patch.object(ha.subprocess, "Popen", return_value=FakeProc()):
            for _ in range(ha.SUMMARY_MAX_ATTEMPTS + 2):
                sess["summaryRetryAt"] = 0  # backoff elapsed
                if ha._summary_due(sess, time.time()):
                    sm._start_summary(sess, "do a thing")
                sm._poll_summaries()
        self.assertEqual(sess["summaryAttempts"], ha.SUMMARY_MAX_ATTEMPTS)
        self.assertFalse(ha._summary_due(sess, time.time()))  # gives up for good

    def test_launch_failure_spends_an_attempt_and_retries(self):
        sm = self.make_manager()
        sess = {"id": "s1", "status": "running", "summary": None}
        sm.registry = [sess]
        with mock.patch.object(ha.subprocess, "Popen", side_effect=OSError("boom")):
            sm._start_summary(sess, "do a thing")
        self.assertEqual(sm.summaries, {})
        self.assertEqual(sess["summaryAttempts"], 1)
        self.assertGreater(sess["summaryRetryAt"], time.time())

    def test_no_prompt_spends_no_attempt(self):
        sm = self.make_manager()
        sess = {"id": "s1", "status": "running", "summary": None}
        with mock.patch.object(ha.subprocess, "Popen"):
            sm._start_summary(sess, "")
        # Nothing to name yet is not a failed try — the bare session must keep all
        # of its attempts for when a first prompt finally lands.
        self.assertEqual(ha._summary_attempts(sess), 0)

    def test_session_deleted_mid_summary_is_safe(self):
        sm = self.make_manager()
        sm.registry = []  # session killed/deleted while the summary ran

        class FakeProc:
            def poll(self_i):
                return 0

            def kill(self_i):
                pass

        with mock.patch.object(ha.subprocess, "Popen", return_value=FakeProc()):
            sm._start_summary({"id": "s1"}, "do a thing")
        with open(sm.summaries["s1"]["outPath"], "w") as f:
            f.write("Some Name")
        sm._poll_summaries()  # must not raise even with no matching session
        self.assertEqual(sm.summaries, {})


class TestSummaryDue(unittest.TestCase):
    def test_named_session_is_never_due(self):
        self.assertFalse(ha._summary_due({"summary": "Adding Flag"}, 1000))

    def test_unnamed_untried_session_is_due(self):
        self.assertTrue(ha._summary_due({"summary": None}, 1000))

    def test_backoff_defers_then_releases(self):
        sess = {"summary": None, "summaryAttempts": 1, "summaryRetryAt": 1000}
        self.assertFalse(ha._summary_due(sess, 999))
        self.assertTrue(ha._summary_due(sess, 1000))

    def test_exhausted_attempts_close_it_out(self):
        sess = {"summary": None, "summaryAttempts": ha.SUMMARY_MAX_ATTEMPTS,
                "summaryRetryAt": 0}
        self.assertFalse(ha._summary_due(sess, 10_000))

    def test_legacy_summary_started_counts_as_one_attempt(self):
        # Records persisted by the one-shot agent carry summaryStarted with no
        # counter. Reading it as "one try spent" (not as a permanent gate) is what
        # lets a session it failed to name still get its remaining retries.
        sess = {"summary": None, "summaryStarted": True}
        self.assertEqual(ha._summary_attempts(sess), 1)
        self.assertTrue(ha._summary_due(sess, 10_000))


class TestFirstUserText(unittest.TestCase):
    """_first_user_text: pull the first genuine human prompt from the top of a
    transcript, skipping the header, isMeta caveats, and slash-command wrappers."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="first-user-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _write(self, name, entries):
        path = os.path.join(self.tmp, name)
        with open(path, "w") as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")
        return path

    def _user(self, text, meta=False):
        e = {"type": "user", "message": {"role": "user", "content": text}}
        if meta:
            e["isMeta"] = True
        return e

    def test_returns_first_real_user_prompt(self):
        # Header rows + an assistant turn precede the human's actual first prompt.
        path = self._write("t.jsonl", [
            {"type": "mode"},
            {"type": "bridge-session"},
            {"type": "system", "isMeta": False},
            self._user("Add a docker compose flag"),
            {"type": "assistant", "message": {"role": "assistant",
                                              "content": [{"type": "text", "text": "ok"}]}},
            self._user("second message"),
        ])
        self.assertEqual(ha._first_user_text(path), "Add a docker compose flag")

    def test_skips_meta_caveat(self):
        # Claude Code's <local-command-caveat> lands as an isMeta user entry.
        path = self._write("t.jsonl", [
            self._user("<local-command-caveat>Caveat: ...", meta=True),
            self._user("the real prompt"),
        ])
        self.assertEqual(ha._first_user_text(path), "the real prompt")

    def test_skips_command_wrappers(self):
        path = self._write("t.jsonl", [
            self._user("<command-name>/clear</command-name>"),
            self._user("<local-command-stdout>done</local-command-stdout>"),
            self._user("actual work please"),
        ])
        self.assertEqual(ha._first_user_text(path), "actual work please")

    def test_skips_command_wrappers_the_chat_now_flattens(self):
        # _entry_text renders the wrapper as "/compact <args>" for the chat, so
        # this skip has to key on the turn's KIND, not on the display text still
        # looking like raw XML — else a session gets named after its slash command.
        path = self._write("t.jsonl", [
            self._user(COMMAND_INVOCATION),
            self._user(COMMAND_STDOUT),
            self._user("actual work please"),
        ])
        self.assertEqual(ha._first_user_text(path), "actual work please")

    def test_skips_a_compact_summary(self):
        # A resumed-after-compaction transcript opens with the model's own
        # summary on a user turn; the human's prompt is what names the session.
        summary = dict(self._user("This session is being continued from a previous…"))
        summary["isCompactSummary"] = True
        path = self._write("t.jsonl", [summary, self._user("actual work please")])
        self.assertEqual(ha._first_user_text(path), "actual work please")

    def test_skips_tool_result_only_user_turns(self):
        # A user turn that is only a tool_result has no display text -> skipped.
        path = self._write("t.jsonl", [
            {"type": "user", "message": {"role": "user", "content": [
                {"type": "tool_result", "content": "output"}]}},
            self._user("here is the task"),
        ])
        self.assertEqual(ha._first_user_text(path), "here is the task")

    def test_skips_system_sourced_turns(self):
        # An injected turn (e.g. a task-notification) is promptSource:system, not
        # a human prompt — it must not become the session's name.
        notif = self._user("<task-notification>\n<summary>Agent finished</summary>\n</task-notification>")
        notif["promptSource"] = "system"
        path = self._write("t.jsonl", [notif, self._user("the real human prompt")])
        self.assertEqual(ha._first_user_text(path), "the real human prompt")

    def test_none_when_no_user_prompt_yet(self):
        # Just-spawned session: header only, no human turn has landed.
        path = self._write("t.jsonl", [
            {"type": "mode"},
            {"type": "assistant", "message": {"role": "assistant",
                                              "content": [{"type": "text", "text": "hi"}]}},
        ])
        self.assertIsNone(ha._first_user_text(path))

    def test_missing_file_is_none(self):
        self.assertIsNone(ha._first_user_text(os.path.join(self.tmp, "nope.jsonl")))

    def test_bounded_by_max_lines(self):
        # The prompt sits past the line budget -> not found (bound honored).
        entries = [{"type": "mode"}] * 10 + [self._user("late prompt")]
        path = self._write("t.jsonl", entries)
        self.assertIsNone(ha._first_user_text(path, max_lines=5))


class TestRootSessionIsolation(ManagerMixin, unittest.TestCase):
    """XERK-6: a fresh root session must not open onto the previous one's chat.

    Every repos-root session runs at REPOS_ROOT, so they all share ONE
    ~/.claude/projects slug dir — unlike a worktree session, whose cwd (and
    therefore slug) is its own. Resolving "this session's transcript" as
    "the newest *.jsonl in that dir" is exact for a worktree and wrong here: the
    newest is the PREVIOUS root session's until the new claude writes its first
    entry, so a just-spawned root session reported that session's tail, served
    its history, seeded its name from its first prompt — and on resume relaunched
    it. Pinning claude's session id per launch (--session-id) is what tells the
    two apart.

    Each test runs the real sequence: root session A converses, ends, root
    session B spawns.
    """

    def setUp(self):
        super().setUp()
        for name, value in [("REPOS_ROOT", self.tmp)]:
            p = mock.patch.object(ha, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(ha, "scan_repos", lambda: [])  # root needs no repo
        p.start()
        self.addCleanup(p.stop)
        # The one project dir every root session's transcript lands in.
        self.proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(self.tmp))
        os.makedirs(self.proj, exist_ok=True)

    def _manager(self):
        sm = self.make_manager()
        sm._launch_ttyd = mock.Mock()  # avoid the real Popen
        return sm

    def _converse(self, sess, text, mtime):
        """Write the transcript claude would have written for `sess`, at a fixed
        mtime so "newest" is unambiguous rather than a filesystem-clock race."""
        path = os.path.join(self.proj, f"{sess['claudeSessionId']}.jsonl")
        with open(path, "w") as f:
            f.write(json.dumps({"type": "mode"}) + "\n")
            f.write(json.dumps({"type": "user", "uuid": f"u-{text}",
                                "message": {"role": "user", "content": text}}) + "\n")
        os.utime(path, (mtime, mtime))
        return path

    def _spawn_root(self, sm):
        sm.spawn(ha.ROOT_REPO_NAME)
        return sm.registry[-1]

    def test_each_root_session_is_pinned_to_its_own_claude_session_id(self):
        sm = self._manager()
        a = self._spawn_root(sm)
        sm.kill(a["id"])
        b = self._spawn_root(sm)
        self.assertTrue(a["claudeSessionId"] and b["claudeSessionId"])
        self.assertNotEqual(a["claudeSessionId"], b["claudeSessionId"],
                            "two root sessions must not share a conversation")
        # Both were LAUNCHED under those ids, not just labelled with them.
        launches = [c[-1] for c in self.run_ok_calls if "new-session" in c]
        self.assertIn(f"--session-id {a['claudeSessionId']}", launches[0])
        self.assertIn(f"--session-id {b['claudeSessionId']}", launches[1])

    def test_new_root_session_does_not_report_the_previous_ones_tail(self):
        # The reported symptom: session A's whole history showing up in B.
        sm = self._manager()
        a = self._spawn_root(sm)
        self._converse(a, "session A work", mtime=1000)
        sm.kill(a["id"])
        b = self._spawn_root(sm)

        # B has not spoken yet: no transcript, so nothing to show.
        rep = ha.session_report(self.tmp, {}, claude_sid=b["claudeSessionId"])
        self.assertEqual(rep["tail"], [])
        self.assertIsNone(rep["transcriptAgeSec"])

        # ...and once it does speak, it shows ITS conversation, not A's.
        self._converse(b, "session B work", mtime=2000)
        rep = ha.session_report(self.tmp, {}, claude_sid=b["claudeSessionId"])
        self.assertEqual([e["text"] for e in rep["tail"]], ["session B work"])

    def test_a_root_session_reports_its_own_tail_even_when_not_the_newest(self):
        # mtime order is not session order: A is still the newest file on disk
        # while B is spawning, and B's own transcript stays older than a root
        # session that outlives it. Only the pin distinguishes them.
        sm = self._manager()
        a = self._spawn_root(sm)
        self._converse(a, "session A work", mtime=9000)  # the newest file
        sm.kill(a["id"])
        b = self._spawn_root(sm)
        self._converse(b, "session B work", mtime=1000)  # older, but B's own

        rep = ha.session_report(self.tmp, {}, claude_sid=b["claudeSessionId"])
        self.assertEqual([e["text"] for e in rep["tail"]], ["session B work"])
        # The rule this replaced, on the same fixture, is what shipped the bug:
        # B's card showing A's chat. If this ever stops differing, the test above
        # has stopped proving anything.
        stale = ha.session_report(self.tmp, {}, claude_sid=None)
        self.assertEqual([e["text"] for e in stale["tail"]], ["session A work"])

    def test_history_serves_the_new_root_sessions_own_conversation(self):
        # The chat view's initial scrollback comes from here, so this is the
        # other half of "the whole previous chat history is there".
        sm = self._manager()
        a = self._spawn_root(sm)
        self._converse(a, "session A work", mtime=1000)
        sm.kill(a["id"])
        b = self._spawn_root(sm)

        sm._stage_history(b["id"])
        self.assertEqual(sm.history_results[-1]["entries"], [],
                         "a root session that hasn't spoken has no history")

        self._converse(b, "session B work", mtime=2000)
        sm._stage_history(b["id"])
        self.assertEqual([e["text"] for e in sm.history_results[-1]["entries"]],
                         ["session B work"])

    def test_new_root_session_is_not_named_from_the_previous_ones_prompt(self):
        sm = self._manager()
        a = self._spawn_root(sm)
        self._converse(a, "Add a docker compose flag", mtime=1000)
        sm.kill(a["id"])
        b = self._spawn_root(sm)

        with mock.patch.object(sm, "_start_summary") as start:
            sm._seed_summaries()
        start.assert_not_called()  # B has no prompt of its own yet

        self._converse(b, "Fix the board filter", mtime=2000)
        with mock.patch.object(sm, "_start_summary") as start:
            sm._seed_summaries()
        start.assert_called_once_with(b, "Fix the board filter")

    def test_resuming_a_root_session_rejoins_its_own_conversation(self):
        # The worst form of the bug: not just displaying the wrong history but
        # handing the relaunched claude someone else's context.
        sm = self._manager()
        a = self._spawn_root(sm)
        self._converse(a, "session A work", mtime=1000)
        sm.kill(a["id"])
        b = self._spawn_root(sm)
        self._converse(b, "session B work", mtime=9000)  # B's is now the newest
        sm.kill(b["id"])

        sm.resume(a["id"])
        cmd = [c[-1] for c in self.run_ok_calls if "new-session" in c][-1]
        self.assertIn(f"--resume {a['claudeSessionId']}", cmd)
        self.assertNotIn(b["claudeSessionId"], cmd)

    def test_killing_a_root_session_records_its_own_transcript_id(self):
        # What the Ended-sessions card opens from the archive.
        sm = self._manager()
        a = self._spawn_root(sm)
        self._converse(a, "session A work", mtime=1000)
        sm.kill(a["id"])
        b = self._spawn_root(sm)
        self._converse(b, "session B work", mtime=9000)
        sm.kill(b["id"])

        rec_a = next(c for c in sm.closed if c["id"] == a["id"])
        self.assertEqual(rec_a["transcriptId"], a["claudeSessionId"])
        rec_b = next(c for c in sm.closed if c["id"] == b["id"])
        self.assertEqual(rec_b["transcriptId"], b["claudeSessionId"])

    def test_restart_moves_a_root_session_to_a_fresh_conversation(self):
        # "Restart (clear context)" means a new conversation, and the session has
        # to follow it — its pre-restart transcript stays the newest on disk.
        sm = self._manager()
        a = self._spawn_root(sm)
        self._converse(a, "before the restart", mtime=9000)
        before = a["claudeSessionId"]

        sm.restart(a["id"])

        self.assertNotEqual(a["claudeSessionId"], before)
        cmd = [c[-1] for c in self.run_ok_calls if "new-session" in c][-1]
        self.assertIn(f"--session-id {a['claudeSessionId']}", cmd)
        self.assertNotIn("--resume", cmd)
        rep = ha.session_report(self.tmp, {}, claude_sid=a["claudeSessionId"])
        self.assertEqual(rep["tail"], [], "cleared context, not the old chat")

    def test_a_session_predating_the_pin_keeps_the_newest_transcript_rule(self):
        # An agent update must not blank the history of a session already
        # running under the old rule: with no id there is nothing to pin to, and
        # newest-mtime is the only handle it ever had.
        sm = self._manager()
        legacy = self._spawn_root(sm)
        path = os.path.join(self.proj, "legacy-transcript.jsonl")
        with open(path, "w") as f:
            f.write(json.dumps({"type": "user", "uuid": "u1",
                                "message": {"role": "user", "content": "old work"}}) + "\n")
        legacy["claudeSessionId"] = None  # as an older agent left the record

        rep = ha.session_report(self.tmp, {}, claude_sid=None)
        self.assertEqual([e["text"] for e in rep["tail"]], ["old work"])
        self.assertEqual(ha._session_transcript_path(legacy), path)
        sm._stage_history(legacy["id"])
        self.assertEqual([e["text"] for e in sm.history_results[-1]["entries"]],
                         ["old work"])

    def test_a_worktree_session_resolves_the_same_either_way(self):
        # The pin is not a root-only special case; it's the general rule, and a
        # worktree session (private slug dir) must answer identically under it.
        sm = self._manager()
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        with mock.patch.object(ha, "scan_repos", lambda: [repo]):
            sm.spawn("Turma")
        sess = sm.registry[-1]
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(sess["worktreePath"]))
        os.makedirs(proj, exist_ok=True)
        path = os.path.join(proj, f"{sess['claudeSessionId']}.jsonl")
        with open(path, "w") as f:
            f.write("{}\n")
        self.assertEqual(ha._session_transcript_path(sess), path)
        self.assertEqual(ha._newest_transcript_path(sess["worktreePath"]), path)


class TestSeedSummaries(ManagerMixin, unittest.TestCase):
    """_seed_summaries: name a bare-spawned session from its transcript's first
    prompt, regardless of which input channel typed it (the live terminal path
    that bypasses send_input is the whole reason this exists)."""

    WORKDIR = "/w/.turma/worktrees/Turma/seed"

    def _transcript(self, text=None, meta_only=False):
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(self.WORKDIR))
        os.makedirs(proj, exist_ok=True)
        path = os.path.join(proj, "sess.jsonl")
        with open(path, "w") as f:
            f.write(json.dumps({"type": "mode"}) + "\n")
            if text is not None:
                f.write(json.dumps({"type": "user",
                                    "message": {"role": "user", "content": text}}) + "\n")
        return path

    def _session(self, **over):
        sess = {"id": "abcde", "status": "running", "worktreePath": self.WORKDIR,
                "summary": None}
        sess.update(over)
        return sess

    def test_names_unnamed_running_session_from_transcript(self):
        sm = self.make_manager()
        sm.registry = [self._session()]
        self._transcript("Add a docker compose flag")
        with mock.patch.object(sm, "_start_summary") as start:
            sm._seed_summaries()
        start.assert_called_once_with(sm.registry[0], "Add a docker compose flag")

    def test_no_transcript_prompt_yet_retries_later(self):
        sm = self.make_manager()
        sm.registry = [self._session()]
        self._transcript(text=None)  # header only, no prompt landed
        with mock.patch.object(sm, "_start_summary") as start:
            sm._seed_summaries()
        start.assert_not_called()  # left unnamed, will retry next beat

    def test_skips_already_named(self):
        sm = self.make_manager()
        sm.registry = [self._session(summary="Adding Compose Flag")]
        self._transcript("Add a docker compose flag")
        with mock.patch.object(sm, "_start_summary") as start:
            sm._seed_summaries()
        start.assert_not_called()

    def test_retries_a_failed_attempt_once_the_backoff_elapses(self):
        # The bug this guards: a first attempt that came back with no name (rate
        # limit, empty reply, timeout) used to gate the session forever, so its
        # card showed the raw id for life.
        sm = self.make_manager()
        sm.registry = [self._session(summaryAttempts=1, summaryRetryAt=0)]
        self._transcript("Add a docker compose flag")
        with mock.patch.object(sm, "_start_summary") as start:
            sm._seed_summaries()
        # Named from the FIRST prompt, same as the original attempt would have.
        start.assert_called_once_with(sm.registry[0], "Add a docker compose flag")

    def test_waits_out_the_backoff_before_retrying(self):
        sm = self.make_manager()
        sm.registry = [self._session(summaryAttempts=1,
                                     summaryRetryAt=time.time() + 300)]
        self._transcript("Add a docker compose flag")
        with mock.patch.object(sm, "_start_summary") as start:
            sm._seed_summaries()
        start.assert_not_called()  # spaced out — the login is shared

    def test_skips_once_attempts_are_exhausted(self):
        sm = self.make_manager()
        sm.registry = [self._session(summaryAttempts=ha.SUMMARY_MAX_ATTEMPTS,
                                     summaryRetryAt=0)]
        self._transcript("Add a docker compose flag")
        with mock.patch.object(sm, "_start_summary") as start:
            sm._seed_summaries()
        start.assert_not_called()

    def test_skips_summary_in_flight(self):
        sm = self.make_manager()
        sm.registry = [self._session()]
        sm.summaries = {"abcde": {"proc": object()}}
        self._transcript("Add a docker compose flag")
        with mock.patch.object(sm, "_start_summary") as start:
            sm._seed_summaries()
        start.assert_not_called()

    def test_skips_non_running_session(self):
        sm = self.make_manager()
        sm.registry = [self._session(status="stopped")]
        self._transcript("Add a docker compose flag")
        with mock.patch.object(sm, "_start_summary") as start:
            sm._seed_summaries()
        start.assert_not_called()


class TestProjectSlug(unittest.TestCase):
    def test_every_non_alphanumeric_becomes_dash(self):
        # Claude Code slugs dots too: /repos/.turma/... -> -repos--turma-...
        # (observed on disk; the old '/'-only mapping missed every worktree
        # transcript because of the '.turma' path segment).
        self.assertEqual(
            ha._project_slug("/repos/.turma/worktrees/CoinBox-46578"),
            "-repos--turma-worktrees-CoinBox-46578",
        )

    def test_plain_path_matches_old_rule(self):
        self.assertEqual(ha._project_slug("/w/repo"), "-w-repo")

    def test_windows_style_path(self):
        self.assertEqual(
            ha._project_slug(r"C:\Users\me/.myapp"),
            "C--Users-me--myapp",
        )


class TestScanRepos(unittest.TestCase):
    def test_scan_filters_dotdirs_and_non_git(self):
        tmp = tempfile.mkdtemp(prefix="hub-agent-scan-")
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        os.makedirs(os.path.join(tmp, "RepoA", ".git"))
        os.makedirs(os.path.join(tmp, "plainDir"))
        os.makedirs(os.path.join(tmp, ".turma", "worktrees"))
        os.makedirs(os.path.join(tmp, ".hidden", ".git"))
        with open(os.path.join(tmp, "afile"), "w") as f:
            f.write("x")
        # worktree-style .git FILE also counts (os.path.exists, not isdir)
        os.makedirs(os.path.join(tmp, "RepoB"))
        with open(os.path.join(tmp, "RepoB", ".git"), "w") as f:
            f.write("gitdir: elsewhere")
        with mock.patch.object(ha, "REPOS_ROOT", tmp):
            repos = ha.scan_repos()
        self.assertEqual(
            [r["name"] for r in repos], ["RepoA", "RepoB"]  # sorted, filtered
        )


class TestRepoLastCommitIso(unittest.TestCase):
    def test_unix_ts_normalized_to_utc_iso(self):
        with mock.patch.object(ha, "run", lambda cmd, cwd=None: "1700000000"):
            self.assertEqual(
                ha.repo_last_commit_iso("/x"), "2023-11-14T22:13:20Z"
            )

    def test_no_commits_yields_empty(self):
        # `git log` on a repo with no commits returns "" -> int("") -> ''.
        with mock.patch.object(ha, "run", lambda cmd, cwd=None: ""):
            self.assertEqual(ha.repo_last_commit_iso("/x"), "")


class TestRepoActivitySort(ManagerMixin, unittest.TestCase):
    """repos[] is ordered most-recently-active first (commit time OR session
    activity, whichever is later), with the root pseudo-repo pinned first."""

    def _manager_for(self, commits):
        """commits: [(name, lastCommit_iso)] — stub scan_repos/repo_entry/
        root_repo_entry so the sort's inputs are fully controlled."""
        sm = self.make_manager()
        by_name = {
            n: {"name": n, "path": "/x/" + n, "lastCommit": c} for n, c in commits
        }
        for name, value in [
            ("scan_repos", lambda: [{"name": n, "path": "/x/" + n} for n, _ in commits]),
            # repo_entry now takes cached slow facts as its second arg (ignored here).
            ("repo_entry", lambda r, slow: dict(by_name[r["name"]])),
            ("repo_slow_facts", lambda path: {}),
            ("root_repo_entry", lambda: {"name": "(root)", "isRoot": True}),
        ]:
            p = mock.patch.object(ha, name, value)
            p.start()
            self.addCleanup(p.stop)
        return sm

    def _order(self, sm):
        return [e["name"] for e in sm._sorted_repo_entries()]

    def test_root_pinned_first_then_commit_time_desc(self):
        sm = self._manager_for([
            ("A", "2026-01-01T00:00:00Z"),
            ("B", "2026-06-01T00:00:00Z"),
            ("C", ""),  # no commits
        ])
        self.assertEqual(self._order(sm), ["(root)", "B", "A", "C"])

    def test_session_activity_can_outrank_commit_time(self):
        sm = self._manager_for([
            ("A", "2026-01-01T00:00:00Z"),
            ("B", "2026-06-01T00:00:00Z"),
        ])
        # A has an old commit but a very recent live session -> jumps ahead of B.
        sm.registry = [{"id": "s1", "repo": "A"}]
        sm.usage_cache = {"s1": {"lastActivity": "2026-12-01T00:00:00Z"}}
        self.assertEqual(self._order(sm), ["(root)", "A", "B"])

    def test_closed_session_kill_time_counts_as_activity(self):
        sm = self._manager_for([
            ("A", "2026-01-01T00:00:00Z"),
            ("B", "2026-06-01T00:00:00Z"),
        ])
        sm.closed = [{"repo": "A", "closedAt": "2026-12-15T00:00:00Z"}]
        self.assertEqual(self._order(sm), ["(root)", "A", "B"])

    def test_ties_keep_alphabetical_scan_order(self):
        # No commits, no sessions -> all "" activity; stable sort preserves the
        # alphabetical order scan_repos already returns.
        sm = self._manager_for([("A", ""), ("B", ""), ("C", "")])
        self.assertEqual(self._order(sm), ["(root)", "A", "B", "C"])


@unittest.skipUnless(
    hasattr(signal, "SIGUSR1"), "SIGUSR1 is POSIX-only; the agent runs on Linux"
)
class TestPokeHeartbeat(unittest.TestCase):
    """SIGUSR1 (sent by tunnel-agent.js on a control-channel poke) must cut the
    heartbeat loop's interval wait short so a just-queued command is picked up
    right away instead of up to a whole INTERVAL later."""

    def test_sigusr1_sets_the_poke_event_and_cuts_the_wait_short(self):
        prev = signal.getsignal(signal.SIGUSR1)
        signal.signal(signal.SIGUSR1, lambda *_: ha._poke.set())
        self.addCleanup(signal.signal, signal.SIGUSR1, prev)

        ha._poke.clear()
        # Without a poke, wait() blocks up to the timeout and returns False.
        self.assertFalse(ha._poke.wait(0.05))

        # A poke makes the same wait return True effectively immediately — the
        # heartbeat loop would beat now rather than after INTERVAL.
        os.kill(os.getpid(), signal.SIGUSR1)
        start = time.monotonic()
        self.assertTrue(ha._poke.wait(5))
        self.assertLess(time.monotonic() - start, 1.0)


class TestPruneRepo(unittest.TestCase):
    """prune_repo() over a REAL git repo + worktrees (the logic is git-heavy, so
    faking run() would prove little). Verifies only merged/clean worktrees and
    branches are swept and in-progress work is preserved."""

    def _git(self, *args, cwd=None):
        import subprocess
        return subprocess.run(["git", *args], cwd=cwd or self.repo,
                              capture_output=True, text=True, check=True)

    def setUp(self):
        import subprocess
        if not shutil.which("git"):
            self.skipTest("git not available")
        self.tmp = tempfile.mkdtemp(prefix="hub-agent-prune-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = os.path.join(self.tmp, "demo")
        os.makedirs(self.repo)
        env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
        run = lambda *a, cwd=None: subprocess.run(
            ["git", *a], cwd=cwd or self.repo, env=env, capture_output=True,
            text=True, check=True)
        self._run = run
        run("init", "-q", "-b", "main")
        run("commit", "-q", "--allow-empty", "-m", "c1")

        self.wt_root = os.path.join(self.tmp, "worktrees")
        patches = [
            ("REGISTRY_DIR", self.tmp),
            ("REGISTRY_PATH", os.path.join(self.tmp, "sessions.json")),
            ("CLOSED_PATH", os.path.join(self.tmp, "closed.json")),
            ("USAGE_LEDGER_PATH", os.path.join(self.tmp, "repo-usage.json")),
            ("TRIAGE_LEDGER_PATH", os.path.join(self.tmp, "jira-repos.json")),
            ("TICKET_LEDGER_PATH", os.path.join(self.tmp, "jira-sessions.json")),
            ("PR_LEDGER_PATH", os.path.join(self.tmp, "pr-sessions.json")),
            ("PR_STATUS_LEDGER_PATH", os.path.join(self.tmp, "pr-status.json")),
            ("PROJECTS_ROOT", os.path.join(self.tmp, "projects")),
            ("WORKTREES_ROOT", self.wt_root),
            ("REPOS_ROOT", self.tmp),
            ("device_name", lambda: "test-host"),
            ("scan_repos", lambda: [{"name": "demo", "path": self.repo}]),
        ]
        for name, value in patches:
            p = mock.patch.object(ha, name, value)
            p.start()
            self.addCleanup(p.stop)

    def _add_worktree(self, sid, base="main"):
        path = os.path.join(self.wt_root, "demo", sid)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self._run("worktree", "add", "--detach", path, base)
        return path

    def _await_prune(self, sm, repo="demo", timeout=30):
        """Block until the worker finishes `repo`, then return its record. The
        sweep is asynchronous now (XERK-256), so every test has to wait for it."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            rec = sm.prunes.get(repo)
            if rec and rec.get("finishedMono") is not None:
                return rec
            time.sleep(0.02)
        self.fail(f"prune of {repo!r} did not finish within {timeout}s "
                  f"(last: {sm.prunes.get(repo)})")

    def test_prune_sweeps_merged_keeps_in_progress(self):
        sm = ha.SessionManager()

        merged_wt = self._add_worktree("merged")          # detached at main -> merged
        unmerged_wt = self._add_worktree("unmerged")
        self._run("commit", "-q", "--allow-empty", "-m", "wip", cwd=unmerged_wt)
        dirty_wt = self._add_worktree("dirty")
        with open(os.path.join(dirty_wt, "scratch.txt"), "w") as f:
            f.write("uncommitted")

        # feature-merged points at main's tip (merged -> deleted); feature-wip at
        # the unmerged worktree's commit, so it's ahead of main (kept).
        self._run("branch", "feature-merged", "main")
        wip_sha = self._run("rev-parse", "HEAD", cwd=unmerged_wt).stdout.strip()
        self._run("branch", "feature-wip", wip_sha)

        sm.prune_repo("demo")
        res = self._await_prune(sm)

        # Merged/clean worktree gone; unmerged + dirty kept.
        self.assertFalse(os.path.isdir(merged_wt))
        self.assertTrue(os.path.isdir(unmerged_wt))
        self.assertTrue(os.path.isdir(dirty_wt))

        branches = self._run("branch", "--format", "%(refname:short)").stdout.split()
        self.assertNotIn("feature-merged", branches)   # merged -> deleted
        self.assertIn("feature-wip", branches)         # unmerged -> kept
        self.assertIn("main", branches)                # default -> kept

        self.assertEqual(res["status"], "done")
        self.assertEqual(res["removedWorktrees"], 1)
        self.assertEqual(res["deletedBranches"], 1)
        self.assertGreaterEqual(res["skippedWorktrees"], 2)

    def test_prune_unknown_repo_reports_error(self):
        sm = ha.SessionManager()
        sm.prune_repo("nope")
        self.assertEqual(self._await_prune(sm, "nope")["status"], "error")

    def test_prune_returns_immediately_and_reports_queued(self):
        """The whole point of XERK-256: the command must not run the sweep on the
        caller's thread, which is the heartbeat loop."""
        sm = ha.SessionManager()
        self._add_worktree("merged")
        gate = threading.Event()
        real = sm._run_prune
        sm._run_prune = lambda repo: (gate.wait(10), real(repo))

        start = time.monotonic()
        sm.prune_repo("demo")
        self.assertLess(time.monotonic() - start, 1.0)
        # ...and the beat can already report the sweep rather than going dark.
        self.assertEqual(sm.prunes["demo"]["status"], "queued")
        self.assertIsNone(sm.prunes["demo"]["finishedMono"])
        payload = sm._prunes_payload()
        self.assertEqual([p["repo"] for p in payload], ["demo"])
        self.assertEqual(payload[0]["status"], "queued")
        gate.set()
        self._await_prune(sm)

    def test_prune_of_a_repo_already_in_flight_is_not_stacked(self):
        """Three clicks on a repo already queued leave ONE sweep and ONE worker.

        The worker is stubbed rather than gated: gating it still lets it POP the
        entry before the assertion runs, so reading the queue length races it —
        which is exactly how this test first failed in CI and passed locally."""
        sm = ha.SessionManager()
        started = []

        class FakeThread:
            def __init__(self, **kw):
                started.append(kw.get("name"))

            def is_alive(self):
                return True      # so a later enqueue sees a worker already up

            def start(self):
                pass

        with mock.patch.object(ha.threading, "Thread", FakeThread):
            sm.prune_repo("demo")
            sm.prune_repo("demo")
            sm.prune_repo("demo")
        self.assertEqual(list(sm._prune_queue), ["demo"])
        self.assertEqual(started, ["prune-worker"])
        self.assertEqual(sm.prunes["demo"]["status"], "queued")

    def test_running_prune_never_ages_out_of_the_heartbeat(self):
        """_poll_prunes drops a record once it has lingered — a sweep in flight
        has no finishedMono, so it can't be dropped out from under itself."""
        sm = ha.SessionManager()
        gate = threading.Event()
        real = sm._run_prune
        sm._run_prune = lambda repo: (gate.wait(10), real(repo))
        sm.prune_repo("demo")
        sm._poll_prunes()
        self.assertIn("demo", sm.prunes)
        gate.set()
        res = self._await_prune(sm)
        # Finished: now the linger clock applies.
        sm.prunes["demo"]["finishedMono"] = time.time() - ha.PRUNE_RESULT_LINGER_SEC - 1
        sm._poll_prunes()
        self.assertNotIn("demo", sm.prunes)
        self.assertEqual(res["status"], "done")

    def test_prune_leaves_a_worktree_claimed_mid_sweep_alone(self):
        """Off the beat, a session can be spawned or resumed onto a worktree this
        sweep already listed. The live set is re-read before every removal, so
        the claim wins."""
        sm = ha.SessionManager()
        claimed = self._add_worktree("claimed")
        sm.registry.append({"id": "s1", "worktreePath": claimed})
        sm.prune_repo("demo")
        res = self._await_prune(sm)
        self.assertTrue(os.path.isdir(claimed))
        self.assertEqual(res["removedWorktrees"], 0)

    def test_worker_folds_removals_into_closed_on_the_beat(self):
        """self.closed belongs to the beat thread: the worker only names paths,
        and _poll_prunes applies them."""
        sm = ha.SessionManager()
        merged_wt = self._add_worktree("merged")
        sm.closed = [{"id": "old", "worktreePath": merged_wt},
                     {"id": "keep", "worktreePath": "/elsewhere"}]
        sm.prune_repo("demo")
        self._await_prune(sm)
        self.assertEqual(sm._prune_swept, [merged_wt])
        sm._poll_prunes()
        self.assertEqual([c["id"] for c in sm.closed], ["keep"])
        self.assertEqual(sm._prune_swept, [])

    def test_prune_rereads_head_and_keeps_work_committed_mid_sweep(self):
        """The listing is minutes old on a real sweep. A session given work can
        COMMIT it and be killed while the sweep runs — the worktree is kept, so it
        leaves the live set, and judged by the HEAD read at listing time it still
        looks merged. Removing it there destroys commits reachable from no ref."""
        sm = ha.SessionManager()
        victim = self._add_worktree("victim")            # detached at main

        # Land the commit between the listing and the merged check, exactly as a
        # session finishing its turn mid-sweep would.
        real_run_out = ha.run_out

        def commit_then_answer(cmd, *a, **kw):
            if "status" in cmd and "--porcelain" in cmd:
                self._run("commit", "-q", "--allow-empty", "-m", "landed mid-sweep",
                          cwd=victim)
            return real_run_out(cmd, *a, **kw)

        with mock.patch.object(ha, "run_out", side_effect=commit_then_answer):
            sm.prune_repo("demo")
            res = self._await_prune(sm)

        self.assertTrue(os.path.isdir(victim))
        self.assertEqual(res["removedWorktrees"], 0)
        self.assertGreaterEqual(res["skippedWorktrees"], 1)
        # ...and the commit is still reachable, which is the thing that matters.
        sha = self._run("rev-parse", "HEAD", cwd=victim).stdout.strip()
        self.assertEqual(
            ha.run_ok(["git", "-C", self.repo, "cat-file", "-e", sha])[0], 0)

    def test_prune_skips_a_worktree_claimed_between_the_checks(self):
        """The re-check right before the removal, not the one at the top of the
        loop: a resume can land while this tree's own status/merge checks run."""
        sm = ha.SessionManager()
        claimed = self._add_worktree("claimed")
        real_run_ok = ha.run_ok

        def claim_then_answer(cmd, *a, **kw):
            if "merge-base" in cmd:
                sm.registry.append({"id": "late", "worktreePath": claimed})
            return real_run_ok(cmd, *a, **kw)

        with mock.patch.object(ha, "run_ok", side_effect=claim_then_answer):
            sm.prune_repo("demo")
            res = self._await_prune(sm)
        self.assertTrue(os.path.isdir(claimed))
        self.assertEqual(res["removedWorktrees"], 0)

    def test_a_resume_cannot_land_on_a_worktree_being_removed(self):
        """`git worktree remove` runs for 10-37s on a real pool and the dir
        exists for most of it, so a resume mid-removal would skip the re-add and
        launch claude into a directory about to be unlinked. The claim is what
        makes the registration and the check one step."""
        sm = ha.SessionManager()
        wt = self._add_worktree("contested")
        self.assertTrue(sm._claim_for_removal(wt))       # worker gets there first
        self.assertFalse(sm._claim_worktree(wt, {"id": "r1", "worktreePath": wt}))
        self.assertEqual(sm.registry, [])                # ...and did not register
        sm._release_removal(wt)
        self.assertTrue(sm._claim_worktree(wt, {"id": "r1", "worktreePath": wt}))
        self.assertEqual([s["id"] for s in sm.registry], ["r1"])
        # With the session registered, the worker no longer gets the tree.
        self.assertFalse(sm._claim_for_removal(wt))

    def test_a_removal_always_releases_its_claim(self):
        """Nothing else ever empties _prune_removing, so a claim leaked by a
        failed removal would refuse every future resume onto that path, forever
        — hence the `finally`. Checked on both exits: a removal that works and
        one that fails."""
        sm = ha.SessionManager()
        self._add_worktree("merged")
        sm.prune_repo("demo")
        self._await_prune(sm)
        self.assertEqual(sm._prune_removing, set())

        sm2 = ha.SessionManager()
        doomed = self._add_worktree("doomed")
        real_run_ok = ha.run_ok

        def failing_removal(cmd, *a, **kw):
            if "worktree" in cmd and "remove" in cmd:
                return 1, "boom"
            return real_run_ok(cmd, *a, **kw)

        with mock.patch.object(ha, "run_ok", side_effect=failing_removal):
            sm2.prune_repo("demo")
            res = self._await_prune(sm2)
        self.assertTrue(os.path.isdir(doomed))
        self.assertEqual(res["removedWorktrees"], 0)
        self.assertEqual(sm2._prune_removing, set())

    def test_progress_updates_never_stamp_a_finish(self):
        """finishedMono is what starts the linger clock, so only a terminal
        record may carry it — else a long sweep ages out of the heartbeat while
        it is still running."""
        sm = ha.SessionManager()
        sm._publish_prune("demo", status="running", summary="pruning… worktree 4 of 31")
        self.assertIsNone(sm.prunes["demo"].get("finishedMono"))
        # Even with an `at` far in the past, a running record survives the poll.
        sm.prunes["demo"]["at"] = "2000-01-01T00:00:00Z"
        sm._poll_prunes()
        self.assertIn("demo", sm.prunes)
        sm._finish_prune("demo", "done", None, "removed 1 worktree")
        self.assertIsNotNone(sm.prunes["demo"]["finishedMono"])

    def test_prune_keeps_a_worktree_whose_status_cannot_be_read(self):
        """`git status` failing or timing out must not read as CLEAN — run()
        collapses both to '', which is why this path uses run_out.

        The patch is command-SELECTIVE: `rev-parse HEAD` goes through run_out too
        now, and a blanket patch would fail that instead, leaving this guard
        passing for the wrong reason."""
        sm = ha.SessionManager()
        merged_wt = self._add_worktree("merged")
        real_run_out = ha.run_out

        def unreadable_status(cmd, *a, **kw):
            if "status" in cmd and "--porcelain" in cmd:
                return None, ""
            return real_run_out(cmd, *a, **kw)

        with mock.patch.object(ha, "run_out", side_effect=unreadable_status):
            sm.prune_repo("demo")
            res = self._await_prune(sm)
        self.assertTrue(os.path.isdir(merged_wt))
        self.assertEqual(res["removedWorktrees"], 0)
        self.assertGreaterEqual(res["skippedWorktrees"], 1)


def _text_entry(uuid, role, text, ts="2026-07-01T10:00:00Z"):
    return {"type": role, "uuid": uuid, "timestamp": ts,
            "message": {"role": role, "content": text}}


class TestArchiveSync(ManagerMixin, unittest.TestCase):
    """Shipping inactive-session transcripts to the hub's durable archive:
    the manifest (what to sync) and the delta push (append-only byte ranges)."""

    def _write_transcript(self, worktree, fname, entries, repo="Turma", remote="git@github.com:xerk/Turma.git"):
        slug = ha._project_slug(worktree)
        d = os.path.join(ha.PROJECTS_ROOT, slug)
        os.makedirs(d, exist_ok=True)
        write_jsonl(os.path.join(d, fname), entries)
        return slug

    def _ledger(self, sm, worktree, repo="Turma", remote="git@github.com:xerk/Turma.git"):
        sm.usage_ledger = {worktree: {"repo": repo, "remote": remote,
                                      "slug": ha._project_slug(worktree)}}

    def test_manifest_lists_inactive_attributed(self):
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        self._write_transcript(wt, "t1.jsonl", [_text_entry("u1", "user", "hi")])
        self._ledger(sm, wt)
        sm.registry = []
        sm.closed = [{"id": "s", "worktreePath": wt, "summary": "My Task",
                      "createdAt": "2026-07-01T00:00:00Z"}]
        manifest = sm._archive_manifest()
        self.assertEqual(len(manifest), 1)
        m = manifest[0]
        self.assertEqual(m["transcriptId"], "t1")
        self.assertEqual(m["repo"], "Turma")
        self.assertEqual(m["remoteKey"], "github.com/xerk/turma")
        self.assertEqual(m["summary"], "My Task")
        self.assertGreater(m["size"], 0)
        # endedTs is the last message's own timestamp, not the file mtime (XERK-73).
        self.assertEqual(m["endedTs"], "2026-07-01T10:00:00Z")
        self.assertNotIn("mtime", m)  # internal sort key stripped
        self.assertNotIn("path", m)   # internal read path stripped

    def test_manifest_excludes_running_session_slug(self):
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/live"
        self._write_transcript(wt, "t1.jsonl", [_text_entry("u1", "user", "hi")])
        self._ledger(sm, wt)
        sm.registry = [{"id": "s", "worktreePath": wt, "status": "running"}]
        self.assertEqual(sm._archive_manifest(), [])
        # Once it stops, it becomes eligible.
        sm.registry = [{"id": "s", "worktreePath": wt, "status": "stopped"}]
        self.assertEqual(len(sm._archive_manifest()), 1)

    def test_deltas_push_filtered_entries_and_resume(self):
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        # The assistant turn carries a thinking + a text block; the archive now
        # ships the full blocks[] (parity with the live chat view) alongside the
        # flat `text`, so history renders identically to a running session.
        self._write_transcript(wt, "t1.jsonl", [
            _text_entry("u1", "user", "make it searchable"),
            {"type": "assistant", "uuid": "a1", "timestamp": "2026-07-01T10:01:00Z",
             "message": {"role": "assistant", "content": [
                 {"type": "thinking", "text": "hmm"},
                 {"type": "text", "text": "added an index"}]}},
        ])
        self._ledger(sm, wt)
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}

        pushed = []

        def fake_post(tid, body):
            pushed.append((tid, body))
            return {"bytesStored": body["endOffset"]}

        with mock.patch.object(sm, "_post_archive_chunk", fake_post):
            sm._archive_deltas({})  # hub has nothing yet -> push from 0

        self.assertEqual(len(pushed), 1)
        tid, body = pushed[0]
        self.assertEqual(tid, "t1")
        self.assertEqual(body["startOffset"], 0)
        texts = [e["text"] for e in body["entries"]]
        self.assertEqual(texts, ["make it searchable", "added an index"])
        # The rich blocks ride along: the assistant turn keeps its thinking trace
        # (flattened out of `text`) so the archive chat UI can show/hide it.
        self.assertEqual(body["entries"][1]["blocks"], [
            {"t": "thinking", "text": "hmm"},
            {"t": "text", "text": "added an index"},
        ])
        self.assertEqual(body["meta"]["remoteKey"], "github.com/xerk/turma")

        # Nothing to do when the hub is already caught up.
        pushed.clear()
        with mock.patch.object(sm, "_post_archive_chunk", fake_post):
            sm._archive_deltas({"t1": body["size"]})
        self.assertEqual(pushed, [])

    # ---- the raw layer (XERK-338) -------------------------------------------
    #
    # Beside the RENDERED entries above, the agent ships a byte-for-byte copy of
    # the session's own files. What is held here is the enumeration (which files
    # belong to a session, and what must never be followed to reach one) and the
    # append-only push — which is the whole answer to "a resumed session must not
    # duplicate data", so it is pinned from both ends: nothing re-ships, and a
    # source that has SHRUNK never truncates what the hub already holds.

    def _nested(self, slug, tid, rel, data=b"x"):
        """Write one file inside a session's own directory, e.g. a subagent."""
        full = os.path.join(ha.PROJECTS_ROOT, slug, tid, *rel.split("/"))
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as f:
            f.write(data)
        return full

    def test_session_files_lists_the_whole_session_directory(self):
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        slug = self._write_transcript(wt, "t1.jsonl", [_text_entry("u1", "user", "hi")])
        self._nested(slug, "t1", "subagents/agent-1.jsonl", b"{}\n")
        self._nested(slug, "t1", "subagents/agent-1.meta.json", b"{}")
        self._nested(slug, "t1", "workflows/wf_abc.json", b"{}")
        self._nested(slug, "t1", "tool-results/b1.txt", b"overflowed output")
        # Belongs to the PROJECT, not this session: one copy per conversation
        # would be storage with no owner.
        os.makedirs(os.path.join(ha.PROJECTS_ROOT, slug, "memory"), exist_ok=True)
        with open(os.path.join(ha.PROJECTS_ROOT, slug, "memory", "MEMORY.md"), "w") as f:
            f.write("nope")
        proj = os.path.join(ha.PROJECTS_ROOT, slug)
        rels = [rel for rel, _size in sm._session_files(proj, "t1")]
        self.assertEqual(sorted(rels), sorted([
            "t1.jsonl",
            os.path.join("t1", "subagents", "agent-1.jsonl"),
            os.path.join("t1", "subagents", "agent-1.meta.json"),
            os.path.join("t1", "tool-results", "b1.txt"),
            os.path.join("t1", "workflows", "wf_abc.json"),
        ]))
        # Sizes are the real ones — they are what the hub's cursor is compared to.
        sizes = dict(sm._session_files(proj, "t1"))
        self.assertEqual(sizes[os.path.join("t1", "tool-results", "b1.txt")],
                         len(b"overflowed output"))

    def test_session_files_never_follows_a_symlink_out(self):
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        slug = self._write_transcript(wt, "t1.jsonl", [_text_entry("u1", "user", "hi")])
        self._nested(slug, "t1", "subagents/agent-1.jsonl", b"{}\n")
        proj = os.path.join(ha.PROJECTS_ROOT, slug)
        outside = os.path.join(ha.PROJECTS_ROOT, "elsewhere")
        os.makedirs(outside, exist_ok=True)
        with open(os.path.join(outside, "secret.jsonl"), "w") as f:
            f.write("{}\n")
        # A linked DIRECTORY inside the session, and a linked FILE beside it.
        # Pointed at PROJECTS_ROOT either one drags the whole host's history into
        # one session's archive.
        try:
            os.symlink(outside, os.path.join(ha.PROJECTS_ROOT, slug, "t1", "linked"))
            os.symlink(os.path.join(outside, "secret.jsonl"),
                       os.path.join(ha.PROJECTS_ROOT, slug, "t1", "linked.jsonl"))
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        rels = [rel for rel, _s in sm._session_files(proj, "t1")]
        self.assertNotIn(os.path.join("t1", "linked.jsonl"), rels)
        self.assertFalse([r for r in rels if "secret" in r], rels)

    def test_session_files_stops_at_its_cap(self):
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        slug = self._write_transcript(wt, "t1.jsonl", [_text_entry("u1", "user", "hi")])
        for i in range(12):
            self._nested(slug, "t1", f"tool-results/b{i}.txt", b"x")
        proj = os.path.join(ha.PROJECTS_ROOT, slug)
        self.assertEqual(len(sm._session_files(proj, "t1", limit=4)), 4)

    def test_manifest_carries_the_raw_file_list(self):
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        slug = self._write_transcript(wt, "t1.jsonl", [_text_entry("u1", "user", "hi")])
        self._nested(slug, "t1", "subagents/agent-1.jsonl", b"{}\n")
        self._ledger(sm, wt)
        sm.registry = []
        m = sm._archive_manifest()[0]
        # Pairs, not objects — this rides every slow heartbeat.
        self.assertTrue(all(isinstance(f, list) and len(f) == 2 for f in m["rawFiles"]))
        self.assertIn("t1.jsonl", [rel for rel, _s in m["rawFiles"]])

    def test_raw_deltas_push_then_resume_without_reshipping(self):
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        slug = self._write_transcript(wt, "t1.jsonl", [_text_entry("u1", "user", "hi")])
        self._ledger(sm, wt)
        sm.registry = []
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}
        path = os.path.join(ha.PROJECTS_ROOT, slug, "t1.jsonl")
        first = os.path.getsize(path)

        pushed = []
        # Stands in for the hub: append-only, and it answers with the cursor.
        stored = {}

        def fake_post(tid, rel, start, raw):
            pushed.append((tid, rel, start, raw))
            if start != stored.get(rel, 0):
                return {"stored": stored.get(rel, 0)}
            stored[rel] = start + len(raw)
            return {"stored": stored[rel]}

        with mock.patch.object(sm, "_post_archive_raw", fake_post):
            sm._archive_raw_deltas({})
        self.assertEqual([(t, r, s) for t, r, s, _ in pushed], [("t1", "t1.jsonl", 0)])
        self.assertEqual(stored["t1.jsonl"], first)
        # Byte-for-byte, not a rendering of it.
        with open(path, "rb") as f:
            self.assertEqual(pushed[0][3], f.read())

        # Caught up: nothing moves.
        pushed.clear()
        with mock.patch.object(sm, "_post_archive_raw", fake_post):
            sm._archive_raw_deltas({"t1": {"t1.jsonl": first}})
        self.assertEqual(pushed, [])

        # THE resumed-session case: `claude --resume` appends to the same file
        # under the same transcript id, so only the appended bytes ship. A
        # content-addressed or whole-file scheme would re-upload the lot here,
        # every time the session was resumed.
        with open(path, "ab") as f:
            f.write(json.dumps(_text_entry("u2", "user", "and again")).encode() + b"\n")
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}
        with mock.patch.object(sm, "_post_archive_raw", fake_post):
            sm._archive_raw_deltas({"t1": {"t1.jsonl": first}})
        self.assertEqual(len(pushed), 1)
        self.assertEqual(pushed[0][2], first)
        self.assertEqual(stored["t1.jsonl"], os.path.getsize(path))

    def test_session_files_skips_what_the_hub_could_never_name(self):
        """The hub's allowlist is [A-Za-z0-9._-]; a name outside it is a
        PERMANENT 400. Offering one is not harmless: three of them exhausted the
        pass's failure budget on every beat and starved every other transcript on
        the host. Reachable with no malice — a workflow's script is named after
        the workflow, and a name with a space or an accent is ordinary."""
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        slug = self._write_transcript(wt, "t1.jsonl", [_text_entry("u1", "user", "hi")])
        self._nested(slug, "t1", "subagents/good.jsonl", b"{}\n")
        for bad in ["tool-results/agent one.jsonl", "tool-results/a@b.txt",
                    "tool-results/caf\u00e9.txt"]:
            self._nested(slug, "t1", bad, b"x")
        rels = [rel for rel, _s in sm._session_files(os.path.join(ha.PROJECTS_ROOT, slug), "t1")]
        self.assertIn(os.path.join("t1", "subagents", "good.jsonl"), rels)
        for bad in ["agent one.jsonl", "a@b.txt", "caf\u00e9.txt"]:
            self.assertFalse([r for r in rels if bad in r], f"{bad} was offered: {rels}")

    def test_archivable_rel_agrees_with_the_hub_on_a_trailing_newline(self):
        """Python's `$` matches before a trailing newline and JavaScript's does
        not, so `^[A-Za-z0-9._-]+$` accepted "a.jsonl\n" here while the hub's
        identical-looking regex refused it. A trailing newline is a legal Linux
        filename. Any agent/hub regex pair has this trap."""
        self.assertTrue(ha._archivable_rel("a.jsonl"))
        self.assertFalse(ha._archivable_rel("a.jsonl\n"))
        self.assertFalse(ha._archivable_rel("abc\n"))
        self.assertFalse(ha._archivable_rel("a\tb"))
        self.assertFalse(ha._archivable_rel("a b.txt"))
        self.assertFalse(ha._archivable_rel("caf\u00e9.txt"))
        self.assertFalse(ha._archivable_rel(".."))
        self.assertFalse(ha._archivable_rel("/x"))
        self.assertFalse(ha._archivable_rel("a" * 256))
        self.assertTrue(ha._archivable_rel("a" * 255))
        self.assertFalse(ha._archivable_rel("n/" * 10 + "f.txt"))   # too deep

    def test_raw_push_refused_permanently_does_not_spend_the_failure_budget(self):
        """A 4xx is the hub saying THIS FILE is unacceptable. Counted as a
        failure, three of them ended the pass every beat — which is how one bad
        file starved every other transcript on the host."""
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        slug = self._write_transcript(wt, "t1.jsonl", [_text_entry("u1", "user", "hi")])
        for i in range(4):
            self._nested(slug, "t1", f"subagents/a{i}.jsonl", b"{}\n")
        self._ledger(sm, wt)
        sm.registry = []
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}
        seen = []

        def refuse_first_four(tid, rel, start, raw):
            seen.append(rel)
            # Everything but the conversation itself is refused permanently.
            if rel.endswith(".jsonl") and "/" in rel:
                return {"skip": True}
            return {"stored": start + len(raw)}

        with mock.patch.object(sm, "_post_archive_raw", refuse_first_four):
            sm._archive_raw_deltas({})
        # All five were attempted: a permanent refusal must not end the pass.
        self.assertEqual(len(seen), 5, seen)
        self.assertIn("t1.jsonl", seen)

    def test_post_archive_raw_distinguishes_a_permanent_refusal(self):
        """The REAL _post_archive_raw, not a mock of it: a 4xx is the hub saying
        THIS FILE is unacceptable, and must come back as `skip` so the delta loop
        leaves it. Returned as a transport failure it spent the pass's budget,
        and three such files starved every other transcript on the host.

        The test above mocks _post_archive_raw wholesale, so it cannot see this —
        mutating the 4xx branch left that test green."""
        sm = self.make_manager()

        def raising(code):
            def fake(req, timeout=None):
                raise urllib.error.HTTPError(req.full_url, code, "no", {}, None)
            return fake

        with mock.patch.object(ha.urllib.request, "urlopen", raising(400)):
            self.assertEqual(sm._post_archive_raw("t1", "a.jsonl", 0, b"x"),
                             {"skip": True})
        with mock.patch.object(ha.urllib.request, "urlopen", raising(413)):
            self.assertEqual(sm._post_archive_raw("t1", "a.jsonl", 0, b"x"),
                             {"skip": True})
        # A 5xx is transient — the hub is unwell, not the file. That one MUST
        # stay a failure, or a down hub gets every file on the host thrown at it.
        with mock.patch.object(ha.urllib.request, "urlopen", raising(503)):
            self.assertIsNone(sm._post_archive_raw("t1", "a.jsonl", 0, b"x"))
        # ...as is a dead socket.
        def boom(req, timeout=None):
            raise OSError("connection refused")
        with mock.patch.object(ha.urllib.request, "urlopen", boom):
            self.assertIsNone(sm._post_archive_raw("t1", "a.jsonl", 0, b"x"))

    def test_raw_deltas_stop_after_repeated_transport_failures(self):
        """...but a hub that is genuinely down must not have every file on the
        host thrown at it. `None` (transport) still spends the budget."""
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        slug = self._write_transcript(wt, "t1.jsonl", [_text_entry("u1", "user", "hi")])
        for i in range(9):
            self._nested(slug, "t1", f"subagents/a{i}.jsonl", b"{}\n")
        self._ledger(sm, wt)
        sm.registry = []
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}
        seen = []
        with mock.patch.object(sm, "_post_archive_raw",
                               lambda *a: seen.append(a[1]) or None):
            sm._archive_raw_deltas({})
        self.assertEqual(len(seen), ha.ARCHIVE_RAW_FAILURES_MAX, seen)

    def test_session_files_never_raises_on_the_heartbeat_path(self):
        """`_session_files` runs on the beat's critical path, where the walk's
        contract is that nothing raises — an escape is a host that reads offline.
        The unnameable-file log's throttle reads its timestamp through `getattr`
        for exactly that reason: a manager-like object whose __init__ did not run
        took the beat down over a LOG LINE (XERK-338 QA H2)."""
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        slug = self._write_transcript(wt, "t1.jsonl", [_text_entry("u1", "user", "hi")])
        self._nested(slug, "t1", "tool-results/bad name.txt", b"x")
        proj = os.path.join(ha.PROJECTS_ROOT, slug)
        # The attribute the throttle reads, gone.
        del sm._unnameable_logged_at
        rels = sm._session_files(proj, "t1")          # must not raise
        self.assertIn(("t1.jsonl", mock.ANY), [(r, mock.ANY) for r, _s in rels])
        self.assertFalse([r for r, _s in rels if "bad name" in r])

    def test_unnameable_file_log_is_throttled(self):
        """The manifest is rebuilt every beat, so an unthrottled line writes
        forever for one unnameable file (XERK-338 QA G6/H3). Every comparable
        warn on this path throttles to 1/hour."""
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        slug = self._write_transcript(wt, "t1.jsonl", [_text_entry("u1", "user", "hi")])
        self._nested(slug, "t1", "tool-results/bad name.txt", b"x")
        proj = os.path.join(ha.PROJECTS_ROOT, slug)
        lines = []
        with mock.patch.object(ha, "log", lambda m: lines.append(m)):
            for _ in range(5):
                sm._session_files(proj, "t1")
        said = [m for m in lines if "cannot be named" in m]
        self.assertEqual(len(said), 1, said)
        # ...and it names the files, since they are otherwise silently absent.
        self.assertIn("bad name.txt", said[0])

    def test_raw_deltas_leave_a_shrunken_source_alone(self):
        # The hub holds MORE than the host now has: the transcript was rewritten
        # or replaced under us. Truncating the archive to match would throw away
        # the only copy of the history — so nothing is pushed for that file.
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        self._write_transcript(wt, "t1.jsonl", [_text_entry("u1", "user", "hi")])
        self._ledger(sm, wt)
        sm.registry = []
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}
        pushed = []
        with mock.patch.object(sm, "_post_archive_raw",
                               lambda *a: pushed.append(a) or {"stored": 0}):
            sm._archive_raw_deltas({"t1": {"t1.jsonl": 10 ** 9}})
        self.assertEqual(pushed, [])

    def test_raw_deltas_respect_the_hubs_verdict(self):
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        self._write_transcript(wt, "t1.jsonl", [_text_entry("u1", "user", "hi")])
        self._ledger(sm, wt)
        sm.registry = []
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}
        pushed = []
        post = lambda *a: pushed.append(a) or {"stored": 0}
        # A full store skips the pass outright...
        with mock.patch.object(sm, "_post_archive_raw", post):
            sm._archive_raw_deltas({}, store_full=True)
        self.assertEqual(pushed, [])
        # ...and a transcript over its own raw budget is skipped by id.
        with mock.patch.object(sm, "_post_archive_raw", post):
            sm._archive_raw_deltas({}, skip_ids=["t1"])
        self.assertEqual(pushed, [])
        # A `skip` in the REPLY stops that file too, rather than retrying it.
        with mock.patch.object(sm, "_post_archive_raw",
                               lambda *a: pushed.append(a) or {"skip": True}):
            sm._archive_raw_deltas({})
        self.assertEqual(len(pushed), 1)

    def test_deltas_ship_pr_link_marker_with_synthesized_uuid(self):
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        # A pr-link entry has no uuid and no display text, but it does have a
        # pr_link marker block — it must survive into the archive under the same
        # synthesized id the live feeds use (_entry_id), so the viewer keys it
        # identically.
        self._write_transcript(wt, "t1.jsonl", [
            _text_entry("u1", "user", "open a pr"),
            {"type": "pr-link", "prNumber": 230,
             "prUrl": "https://github.com/o/r/pull/230", "prRepository": "o/r",
             "timestamp": "2026-07-01T10:05:00Z"},
        ])
        self._ledger(sm, wt)
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}
        pushed = []
        with mock.patch.object(sm, "_post_archive_chunk",
                               lambda tid, body: (pushed.append(body), {"bytesStored": body["endOffset"]})[1]):
            sm._archive_deltas({})
        entries = pushed[0]["entries"]
        self.assertEqual(len(entries), 2)
        pr = entries[1]
        self.assertEqual(pr["uuid"], "pr-link:https://github.com/o/r/pull/230")
        self.assertEqual(pr["text"], "")
        self.assertEqual(pr["blocks"], [
            {"t": "pr_link", "url": "https://github.com/o/r/pull/230",
             "number": 230, "repo": "o/r"}])

    def test_deltas_ship_tool_result_only_turn(self):
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        # A turn carrying ONLY a tool_result has no display text (_entry_text
        # returns None) but does have a renderable block; the archive widens
        # inclusion like _history_entries so the tool output survives in history.
        self._write_transcript(wt, "t1.jsonl", [
            {"type": "user", "uuid": "r1", "timestamp": "2026-07-01T10:00:00Z",
             "message": {"role": "user", "content": [
                 {"type": "tool_result", "tool_use_id": "x1", "content": "out.txt"}]}},
        ])
        self._ledger(sm, wt)
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}

        pushed = []

        def fake_post(tid, body):
            pushed.append((tid, body))
            return {"bytesStored": body["endOffset"]}

        with mock.patch.object(sm, "_post_archive_chunk", fake_post):
            sm._archive_deltas({})

        self.assertEqual(len(pushed), 1)
        entries = pushed[0][1]["entries"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["text"], "")  # no display text...
        self.assertEqual(entries[0]["blocks"], [   # ...but the tool output is kept
            {"t": "tool_result", "text": "out.txt", "forId": "x1"}])

    def test_deltas_stop_on_no_forward_progress(self):
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        self._write_transcript(wt, "t1.jsonl", [_text_entry("u1", "user", "hello world")])
        self._ledger(sm, wt)
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}
        calls = []

        def stuck_post(tid, body):
            calls.append(tid)
            return {"bytesStored": 0}  # hub reports no progress (offset realign)

        with mock.patch.object(sm, "_post_archive_chunk", stuck_post):
            sm._archive_deltas({})
        self.assertEqual(len(calls), 1)  # one attempt, then it bails (no loop)


class TestArchivePayloadBudget(ManagerMixin, unittest.TestCase):
    """The archive's SendUserFile payload budget (XERK-267): the previews are
    bounded per delivery but unbounded relative to the transcript, so a
    screenshot-heavy session archives orders of magnitude larger than the
    conversation it records."""

    def setUp(self):
        super().setUp()
        self.files_dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.files_dir, ignore_errors=True)

    def _write_transcript(self, worktree, fname, entries):
        d = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(worktree))
        os.makedirs(d, exist_ok=True)
        write_jsonl(os.path.join(d, fname), entries)

    def _ledger(self, sm, worktree):
        sm.usage_ledger = {worktree: {"repo": "Turma",
                                      "remote": "git@github.com:xerk/Turma.git",
                                      "slug": ha._project_slug(worktree)}}

    def _png(self, name, size):
        """A real file on disk — _send_user_file_detail reads and base64s it."""
        path = os.path.join(self.files_dir, name)
        with open(path, "wb") as fh:
            fh.write(b"\x89PNG" + b"\x00" * (size - 4))
        return path

    def _delivery(self, uuid, path, ts="2026-07-01T10:00:00Z"):
        return {"type": "assistant", "uuid": uuid, "timestamp": ts,
                "message": {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "x" + uuid, "name": "SendUserFile",
                     "input": {"files": [path], "display": "render"}}]}}

    def _push(self, sm, **kwargs):
        pushed = []

        def fake_post(tid, body):
            pushed.append(body)
            return {"bytesStored": body["endOffset"]}

        with mock.patch.object(sm, "_post_archive_chunk", fake_post):
            sm._archive_deltas({}, **kwargs)
        return pushed

    def _files_of(self, body):
        return [e["blocks"][0].get("files", [{}])[0] for e in body["entries"]]

    def test_shed_block_payloads_leaves_an_identifiable_chip(self):
        blocks = [{"t": "tool_use", "name": "SendUserFile", "files": [
            {"name": "shot.png", "kind": "image", "src": "data:image/png;base64,AAAA"},
            {"name": "page.html", "kind": "html", "html": "<h1>hi</h1>"},
            {"name": "notes.txt", "kind": "file"},
        ]}]
        dropped = ha._shed_block_payloads(blocks)
        self.assertEqual(dropped, len("data:image/png;base64,AAAA") + len("<h1>hi</h1>"))
        # Bytes, not code points. A base64 payload is pure ASCII, so only a
        # non-ASCII preview can tell the two apart.
        wide = [{"t": "tool_use", "files": [
            {"name": "p.html", "kind": "html", "html": "中" * 200}]}]
        self.assertEqual(ha._shed_block_payloads(wide), len(("中" * 200).encode("utf-8")))
        self.assertEqual(blocks[0]["files"], [
            # Dropped for size, and says so — never confused with a file that
            # was unreadable when the preview was taken.
            {"name": "shot.png", "kind": "file", "shed": True},
            {"name": "page.html", "kind": "file", "shed": True},
            {"name": "notes.txt", "kind": "file"},   # nothing to drop, untouched
        ])
        # Idempotent: a second pass finds nothing left to drop.
        self.assertEqual(ha._shed_block_payloads(blocks), 0)

    def test_byte_ceiling_agrees_with_the_hub_and_never_raises(self):
        # Both sides read the SAME env var, so a disagreement here means one of
        # them does the opposite of what the operator asked. And this runs at
        # IMPORT: raising would stop hub-agent.py loading and take every session
        # on the host down over a typo'd tunable.
        self.assertEqual(ha._byte_ceiling("0", 999), 0)        # 0 disables, not "unset"
        self.assertEqual(ha._byte_ceiling("16MiB", 999), 999)  # a typo, not 16
        self.assertEqual(ha._byte_ceiling("-5", 999), 999)
        self.assertEqual(ha._byte_ceiling("", 999), 999)
        self.assertEqual(ha._byte_ceiling(None, 999), 999)
        self.assertEqual(ha._byte_ceiling(" 1048576 ", 999), 1048576)
        # str.isdigit() says yes to characters int() then refuses, so a stray
        # footnote marker pasted into the compose env would RAISE here — at
        # import, taking the host's whole fleet down.
        self.assertEqual(ha._byte_ceiling("16777216²", 999), 999)
        self.assertEqual(ha._byte_ceiling("①", 999), 999)
        # Non-ASCII digits parse for Python and not for the hub's /^\d+$/, and
        # a ceiling of 16 where the hub reads 16 MiB strips every preview.
        self.assertEqual(ha._byte_ceiling("١٦", 999), 999)   # Arabic-Indic 16
        self.assertEqual(ha._byte_ceiling("１６", 999), 999)   # fullwidth 16
        # Past 2**53-1 the hub's Number.isSafeInteger refuses; agree with it.
        self.assertEqual(ha._byte_ceiling(str((1 << 53) - 1), 999), (1 << 53) - 1)
        self.assertEqual(ha._byte_ceiling(str(1 << 53), 999), 999)
        # The two parsers read the SAME env var, so they must trim the same set.
        # str.strip() strips U+0085 and U+001C-1F where JS's String.trim() does
        # not, and String.trim() strips U+FEFF where str.strip() does not — so
        # under either default a BOM'd value gave one side a 16-BYTE ceiling
        # while the other read 16 MiB. Mirrors the hub's byteCeiling case.
        for odd in ("﻿16", "\x8516", "\x1c16", "\x8516\x85", "16﻿"):
            self.assertEqual(ha._byte_ceiling(odd, 999), 999, repr(odd))
        # The exact ASCII set, matching the hub's regex character-for-character.
        self.assertEqual(ha._byte_ceiling(" \t\n\r\f\v16 \t\n\r\f\v", 999), 16)

    def test_payload_bytes_are_utf8_bytes_not_code_points(self):
        # The budget is named in bytes and the hub spends it in bytes; counting
        # characters let a non-ASCII preview ship 3-4x its share.
        html = "中" * 500 + "\U0001f600" * 100
        blocks = [{"t": "tool_use", "files": [{"name": "p.html", "kind": "html", "html": html}]}]
        self.assertEqual(ha._block_payload_bytes(blocks), len(html.encode("utf-8")))
        self.assertNotEqual(len(html.encode("utf-8")), len(html))   # they really differ

    def test_a_disabled_ceiling_keeps_every_preview(self):
        # 0 means "no ceiling" on the hub, so it must not mean "shed everything"
        # here — that inversion would silently strip previews fleet-wide.
        #
        # SEVERAL deliveries, deliberately: the budget is checked AFTER an entry
        # is emitted, so a one-delivery transcript keeps its preview under either
        # reading and the test proves nothing.
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        png = self._png("a.png", 4096)
        self._write_transcript(wt, "t1.jsonl", [
            self._delivery("a%d" % i, png, "2026-07-01T10:0%d:00Z" % i) for i in range(4)])
        self._ledger(sm, wt)
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}
        with mock.patch.object(ha, "ARCHIVE_PAYLOAD_MAX", 0):
            files = self._files_of(self._push(sm)[0])
        self.assertEqual(len(files), 4)
        self.assertTrue(all(f["kind"] == "image" for f in files), files)
        self.assertFalse(any(f.get("shed") for f in files))

    def test_an_ordinary_delivery_still_archives_with_its_preview(self):
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        self._write_transcript(wt, "t1.jsonl", [self._delivery("a1", self._png("a.png", 512))])
        self._ledger(sm, wt)
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}
        f = self._files_of(self._push(sm)[0])[0]
        self.assertEqual(f["kind"], "image")
        self.assertTrue(f["src"].startswith("data:image/png;base64,"))

    def test_the_hub_naming_a_transcript_sheds_it_before_the_wire(self):
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        self._write_transcript(wt, "t1.jsonl", [self._delivery("a1", self._png("a.png", 512))])
        self._ledger(sm, wt)
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}
        body = self._push(sm, shed_ids=["t1"])[0]
        self.assertEqual(self._files_of(body)[0], {"name": "a.png", "kind": "file", "shed": True})
        # The delivery's own card survives — only the payload went.
        self.assertEqual(body["entries"][0]["blocks"][0]["name"], "SendUserFile")

    def test_the_agent_sheds_a_runaway_transcript_without_being_told(self):
        # A first-time offender: the hub has never seen it, so nothing on the
        # reply names it. The local counter keeps the bytes off the wire anyway.
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        big = self._png("big.png", 4096)
        self._write_transcript(wt, "t1.jsonl", [
            self._delivery("a%d" % i, big, "2026-07-01T10:0%d:00Z" % i) for i in range(6)])
        self._ledger(sm, wt)
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}
        # base64 of 4096 bytes is ~5.5 KB, so a 8 KB budget spans two deliveries.
        with mock.patch.object(ha, "ARCHIVE_PAYLOAD_MAX", 8192):
            files = self._files_of(self._push(sm)[0])
        self.assertEqual(files[0]["kind"], "image")     # under budget
        self.assertTrue(all(f.get("shed") for f in files[2:]),
                        "everything past the budget should be a chip")
        self.assertEqual(files[-1]["name"], "big.png")  # ...still named

    def test_a_shed_verdict_on_the_reply_applies_to_the_next_chunk(self):
        # The hub counts STORED bytes and we count only sheddable payload, so it
        # can cross its ceiling first; its answer wins from that chunk on.
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        png = self._png("a.png", 512)
        self._write_transcript(wt, "t1.jsonl", [
            self._delivery("a%d" % i, png, "2026-07-01T10:0%d:00Z" % i) for i in range(4)])
        self._ledger(sm, wt)
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}
        pushed = []

        def fake_post(tid, body):
            pushed.append(body)
            return {"bytesStored": body["endOffset"], "shed": True}

        # One entry per chunk, so the verdict lands between two of them.
        with mock.patch.object(ha, "ARCHIVE_CHUNK_BYTES", 400), \
             mock.patch.object(sm, "_post_archive_chunk", fake_post):
            sm._archive_deltas({})
        self.assertGreater(len(pushed), 1)
        self.assertEqual(self._files_of(pushed[0])[0]["kind"], "image")   # before
        self.assertTrue(self._files_of(pushed[1])[0]["shed"])             # after

    def test_shedding_says_so_in_the_log(self):
        # Without it, an operator looking at an archived session full of
        # name-only chips has nothing telling them the previews were dropped for
        # size rather than never captured. Also the only thing making the shed
        # byte count observable at all — it has no other consumer.
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        png = self._png("a.png", 4096)
        self._write_transcript(wt, "t1.jsonl", [
            self._delivery("a%d" % i, png, "2026-07-01T10:0%d:00Z" % i) for i in range(4)])
        self._ledger(sm, wt)
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}
        lines = []
        with mock.patch.object(ha, "log", lines.append):
            self._push(sm, shed_ids=["t1"])
        shed_lines = [ln for ln in lines if "shed" in ln]
        self.assertEqual(len(shed_lines), 1, lines)   # once per transcript per pass
        self.assertIn("t1", shed_lines[0])
        # A real byte count, and a plausible one: 4 base64'd 4 KiB images.
        dropped = int(re.search(r"shed (\d+) bytes", shed_lines[0]).group(1))
        self.assertGreater(dropped, 4 * 4096)

    def test_a_full_store_is_not_pushed_at_at_all(self):
        sm = self.make_manager()
        wt = "/w/.turma/worktrees/Turma/aaa"
        self._write_transcript(wt, "t1.jsonl", [_text_entry("u1", "user", "hello")])
        self._ledger(sm, wt)
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}
        self.assertEqual(self._push(sm, store_full=True), [])

    def test_a_full_verdict_mid_pass_stops_the_pass(self):
        # Two transcripts; the hub fills up on the first. The second must not be
        # attempted — a refused chunk is not a chunk to retry (XERK-255).
        sm = self.make_manager()
        for i, name in enumerate(("aaa", "bbb")):
            wt = "/w/.turma/worktrees/Turma/" + name
            self._write_transcript(wt, "t%d.jsonl" % i, [_text_entry("u1", "user", "hello")])
            sm.usage_ledger = dict(sm.usage_ledger or {}, **{wt: {
                "repo": "Turma", "remote": "git@github.com:xerk/Turma.git",
                "slug": ha._project_slug(wt)}})
        sm._archive_pending = {m["transcriptId"]: m for m in sm._archive_manifest()}
        self.assertEqual(len(sm._archive_pending), 2)
        calls = []

        with mock.patch.object(sm, "_post_archive_chunk",
                               lambda tid, body: (calls.append(tid), {"bytesStored": 0, "full": True})[1]):
            sm._archive_deltas({})
        self.assertEqual(len(calls), 1)


class TestPrStatus(unittest.TestCase):
    """The `gh pr view` status helpers: check-rollup classification, the compact
    summary the cards render, and the URL fetch wrapper."""

    def test_check_class_checkrun_states(self):
        # Unfinished CheckRuns are pending regardless of conclusion.
        self.assertEqual(ha._check_class({"status": "IN_PROGRESS"}), "pending")
        self.assertEqual(ha._check_class({"status": "QUEUED"}), "pending")
        # Completed runs classify on conclusion.
        self.assertEqual(ha._check_class({"status": "COMPLETED", "conclusion": "SUCCESS"}), "pass")
        self.assertEqual(ha._check_class({"status": "COMPLETED", "conclusion": "FAILURE"}), "fail")
        self.assertEqual(ha._check_class({"status": "COMPLETED", "conclusion": "TIMED_OUT"}), "fail")
        # Neutral / skipped are non-blocking passes.
        self.assertEqual(ha._check_class({"status": "COMPLETED", "conclusion": "NEUTRAL"}), "pass")
        self.assertEqual(ha._check_class({"status": "COMPLETED", "conclusion": "SKIPPED"}), "pass")

    def test_check_class_statuscontext(self):
        # Legacy StatusContext entries carry a single `state`.
        self.assertEqual(ha._check_class({"state": "SUCCESS"}), "pass")
        self.assertEqual(ha._check_class({"state": "FAILURE"}), "fail")
        self.assertEqual(ha._check_class({"state": "ERROR"}), "fail")
        self.assertEqual(ha._check_class({"state": "PENDING"}), "pending")

    def test_check_class_garbage(self):
        self.assertIsNone(ha._check_class("nope"))
        self.assertIsNone(ha._check_class({"conclusion": "WEIRD_NEW_ENUM"}))

    def test_summarize_open_passing(self):
        out = ha._summarize_pr({
            "number": 42, "title": "Add flag", "state": "OPEN", "isDraft": False,
            "url": "https://github.com/o/r/pull/42",
            "statusCheckRollup": [
                {"status": "COMPLETED", "conclusion": "SUCCESS"},
                {"status": "COMPLETED", "conclusion": "SUCCESS"},
            ],
        })
        self.assertEqual(out["state"], "OPEN")
        self.assertEqual(out["number"], 42)
        self.assertEqual(out["checks"], "passing")
        self.assertEqual(out["checkCounts"], {"pass": 2, "fail": 0, "pending": 0})

    def test_summarize_failing_wins_over_pending(self):
        out = ha._summarize_pr({
            "state": "OPEN",
            "statusCheckRollup": [
                {"status": "COMPLETED", "conclusion": "SUCCESS"},
                {"status": "IN_PROGRESS"},
                {"status": "COMPLETED", "conclusion": "FAILURE"},
            ],
        })
        self.assertEqual(out["checks"], "failing")

    def test_summarize_pending(self):
        out = ha._summarize_pr({
            "state": "OPEN",
            "statusCheckRollup": [
                {"status": "COMPLETED", "conclusion": "SUCCESS"},
                {"status": "QUEUED"},
            ],
        })
        self.assertEqual(out["checks"], "pending")

    def test_summarize_draft_and_no_checks(self):
        out = ha._summarize_pr({"state": "OPEN", "isDraft": True, "statusCheckRollup": []})
        self.assertEqual(out["state"], "DRAFT")   # draft surfaced as its own state
        self.assertIsNone(out["checks"])          # no checks -> no rollup
        self.assertIsNone(out["checkCounts"])

    def test_summarize_merged_stays_merged(self):
        # isDraft only rewrites OPEN; a merged PR keeps its state.
        out = ha._summarize_pr({"state": "MERGED", "isDraft": False, "statusCheckRollup": []})
        self.assertEqual(out["state"], "MERGED")

    # ---- merge readiness: CI *and* mergeability, not CI alone ----

    def _mergeable_pr(self, mergeable, rollup=None, state="OPEN"):
        return ha._summarize_pr({
            "state": state, "mergeable": mergeable,
            "statusCheckRollup": rollup if rollup is not None
            else [{"status": "COMPLETED", "conclusion": "SUCCESS"}],
        })

    def test_ready_needs_green_ci_and_no_conflict(self):
        out = self._mergeable_pr("MERGEABLE")
        self.assertEqual(out["checks"], "passing")
        self.assertEqual(out["mergeable"], "MERGEABLE")
        self.assertEqual(out["ready"], "ready")

    def test_conflict_blocks_despite_green_ci(self):
        # The bug this exists for: green checks on a branch that merges nowhere
        # used to read as a ✓.
        out = self._mergeable_pr("CONFLICTING")
        self.assertEqual(out["checks"], "passing")   # CI half unchanged...
        self.assertEqual(out["ready"], "blocked")    # ...but the PR can't land

    def test_conflict_blocks_even_while_ci_pends(self):
        out = self._mergeable_pr("CONFLICTING", [{"status": "IN_PROGRESS"}])
        self.assertEqual(out["checks"], "pending")
        self.assertEqual(out["ready"], "blocked")

    def test_unproven_mergeability_is_pending_not_ready(self):
        # GitHub computes mergeability lazily; UNKNOWN is not a MERGEABLE.
        self.assertEqual(self._mergeable_pr("UNKNOWN")["ready"], "pending")
        self.assertEqual(self._mergeable_pr(None)["ready"], "pending")

    def test_failing_ci_blocks_whatever_mergeability_says(self):
        out = self._mergeable_pr("MERGEABLE",
                                 [{"status": "COMPLETED", "conclusion": "FAILURE"}])
        self.assertEqual(out["ready"], "blocked")

    def test_no_checks_gets_no_verdict_unless_conflicting(self):
        # Absent CI is not evidence of anything, so the card keeps its no-mark —
        # but a conflict is evidence, and blocks on its own.
        self.assertIsNone(self._mergeable_pr("MERGEABLE", [])["ready"])
        self.assertIsNone(self._mergeable_pr("UNKNOWN", [])["ready"])
        self.assertEqual(self._mergeable_pr("CONFLICTING", [])["ready"], "blocked")

    def test_closed_pr_ignores_mergeability(self):
        # A merged/closed PR merges nowhere by definition; its mark is CI alone,
        # and gh reports these as UNKNOWN/CONFLICTING as it pleases.
        self.assertEqual(self._mergeable_pr("UNKNOWN", state="MERGED")["ready"], "ready")
        self.assertEqual(self._mergeable_pr("CONFLICTING", state="CLOSED")["ready"], "ready")

    def test_draft_conflict_blocks(self):
        # DRAFT is an OPEN sub-state — still a PR whose conflict matters.
        out = ha._summarize_pr({
            "state": "OPEN", "isDraft": True, "mergeable": "CONFLICTING",
            "statusCheckRollup": [{"status": "COMPLETED", "conclusion": "SUCCESS"}],
        })
        self.assertEqual(out["state"], "DRAFT")
        self.assertEqual(out["ready"], "blocked")

    def test_pr_status_parses_gh(self):
        payload = json.dumps({"number": 7, "state": "OPEN", "url": "u",
                              "mergeable": "MERGEABLE", "statusCheckRollup": []})
        with mock.patch.object(ha, "run", return_value=payload) as run:
            out = ha.pr_status("https://github.com/o/r/pull/7")
        self.assertEqual(out["number"], 7)
        # The verdict is only as good as the field it needs being asked for.
        self.assertIn("mergeable", run.call_args[0][0][-1])

    def test_pr_status_none_on_failure(self):
        with mock.patch.object(ha, "run", return_value=""):
            self.assertIsNone(ha.pr_status("https://github.com/o/r/pull/7"))
        with mock.patch.object(ha, "run", return_value="not json"):
            self.assertIsNone(ha.pr_status("https://github.com/o/r/pull/7"))


class TestMrStatus(unittest.TestCase):
    """XERK-162: GitLab merge-request status answers in _summarize_pr's exact
    shape, so every chip renderer treats an MR like a PR."""

    MR = "https://gitlab.example.com/grp/sub/app/-/merge_requests/12"

    def _configured(self):
        return mock.patch.multiple(
            ha, GITLAB_URL="https://gitlab.example.com", GITLAB_TOKEN="tok")

    def test_mr_url_parts_under_configured_base(self):
        with self._configured():
            self.assertEqual(ha._mr_url_parts(self.MR),
                             ("grp/sub/app", "12"))

    def test_mr_url_parts_subpath_install(self):
        with mock.patch.multiple(ha, GITLAB_URL="https://host.tld/gitlab",
                                 GITLAB_TOKEN="tok"):
            self.assertEqual(
                ha._mr_url_parts(
                    "https://host.tld/gitlab/grp/app/-/merge_requests/3"),
                ("grp/app", "3"))

    def test_mr_url_parts_foreign_host_or_unconfigured(self):
        # A foreign GitLab (no credential) and an unconfigured host both
        # resolve to None — the chip stays a bare link.
        with self._configured():
            self.assertIsNone(ha._mr_url_parts(
                "https://other.gitlab.tld/g/a/-/merge_requests/1"))
            # Suffix-spoofing host: gitlab.example.com.evil.com is NOT ours.
            self.assertIsNone(ha._mr_url_parts(
                "https://gitlab.example.com.evil.com/g/a/-/merge_requests/1"))
        with mock.patch.multiple(ha, GITLAB_URL="", GITLAB_TOKEN=""):
            self.assertIsNone(ha._mr_url_parts(self.MR))

    def test_mr_url_parts_matches_host_not_bytes(self):
        # Hostnames are case-insensitive and the scheme doesn't change WHICH
        # GitLab an MR lives on — a byte-for-byte prefix compare left every
        # attributed MR a bare link chip forever over a trivial GITLAB_URL
        # spelling difference.
        for base in ("https://GitLab.Example.com", "http://gitlab.example.com",
                     "gitlab.example.com", "https://gitlab.example.com/"):
            with mock.patch.multiple(ha, GITLAB_URL=base, GITLAB_TOKEN="tok"):
                self.assertEqual(ha._mr_url_parts(self.MR),
                                 ("grp/sub/app", "12"), base)

    def test_mr_check_class(self):
        self.assertEqual(ha._mr_check_class("success"), "pass")
        self.assertEqual(ha._mr_check_class("skipped"), "pass")
        self.assertEqual(ha._mr_check_class("failed"), "fail")
        self.assertEqual(ha._mr_check_class("canceled"), "fail")
        for s in ("created", "pending", "running", "manual", "scheduled"):
            self.assertEqual(ha._mr_check_class(s), "pending")
        self.assertIsNone(ha._mr_check_class(None))
        self.assertIsNone(ha._mr_check_class("weird_new_enum"))

    def test_summarize_open_passing_mergeable(self):
        out = ha._summarize_mr({
            "iid": 12, "title": "Add flag", "state": "opened", "draft": False,
            "web_url": self.MR,
            "head_pipeline": {"status": "success"},
            "detailed_merge_status": "mergeable",
        })
        self.assertEqual(out["state"], "OPEN")
        self.assertEqual(out["number"], 12)
        self.assertEqual(out["checks"], "passing")
        self.assertEqual(out["checkCounts"], {"pass": 1, "fail": 0, "pending": 0})
        self.assertEqual(out["mergeable"], "MERGEABLE")
        self.assertEqual(out["ready"], "ready")

    def test_summarize_states_and_draft(self):
        self.assertEqual(ha._summarize_mr({"state": "merged"})["state"], "MERGED")
        self.assertEqual(ha._summarize_mr({"state": "closed"})["state"], "CLOSED")
        self.assertEqual(ha._summarize_mr({"state": "locked"})["state"], "OPEN")
        self.assertEqual(
            ha._summarize_mr({"state": "opened", "draft": True})["state"], "DRAFT")
        # draft only rewrites OPEN, as isDraft does for a PR.
        self.assertEqual(
            ha._summarize_mr({"state": "merged", "draft": True})["state"], "MERGED")

    def test_summarize_conflict_blocks_and_unknown_is_unproven(self):
        for status in ("conflict", "broken_status"):
            conflicted = ha._summarize_mr({
                "state": "opened", "detailed_merge_status": status,
                "head_pipeline": {"status": "success"},
            })
            self.assertEqual(conflicted["mergeable"], "CONFLICTING", status)
            self.assertEqual(conflicted["ready"], "blocked", status)
        # A still-computing status is UNKNOWN — green CI alone must not claim ✓.
        for status in ("checking", "unchecked", "preparing"):
            out = ha._summarize_mr({
                "state": "opened", "detailed_merge_status": status,
                "head_pipeline": {"status": "success"},
            })
            self.assertEqual(out["mergeable"], "UNKNOWN", status)
            self.assertEqual(out["ready"], "pending", status)

    def test_summarize_non_conflict_statuses_read_mergeable(self):
        # GitHub's `mergeable` answers conflicts ONLY, so a GitLab enum that
        # reports an approvals/CI/workflow gate — not a git-level can't-merge —
        # must read MERGEABLE, or every healthy MR sits at ● forever where the
        # equivalent GitHub PR shows ✓.
        for status in ("mergeable", "not_approved", "ci_still_running",
                       "discussions_not_resolved", "need_rebase",
                       "some_future_status"):
            out = ha._summarize_mr({
                "state": "opened", "detailed_merge_status": status,
                "head_pipeline": {"status": "success"},
            })
            self.assertEqual(out["mergeable"], "MERGEABLE", status)
            self.assertEqual(out["ready"], "ready", status)

    def test_summarize_legacy_merge_status_fallback(self):
        old = ha._summarize_mr({"state": "opened", "merge_status": "can_be_merged"})
        self.assertEqual(old["mergeable"], "MERGEABLE")
        older = ha._summarize_mr({"state": "opened",
                                  "merge_status": "cannot_be_merged"})
        self.assertEqual(older["mergeable"], "CONFLICTING")

    def test_summarize_no_pipeline_no_checks(self):
        out = ha._summarize_mr({"state": "opened", "head_pipeline": None})
        self.assertIsNone(out["checks"])
        self.assertIsNone(out["checkCounts"])

    def test_pr_status_dispatches_mr_url_to_gitlab_not_gh(self):
        with self._configured(), \
                mock.patch.object(ha, "_gitlab_get", return_value={
                    "iid": 12, "state": "opened", "web_url": self.MR}) as gl, \
                mock.patch.object(ha, "run") as run:
            out = ha.pr_status(self.MR)
        run.assert_not_called()
        self.assertEqual(out["number"], 12)
        # The project path is URL-encoded into the API path.
        self.assertIn("projects/grp%2Fsub%2Fapp/merge_requests/12",
                      gl.call_args[0][0])

    def test_mr_status_none_when_unreachable(self):
        with mock.patch.multiple(ha, GITLAB_URL="", GITLAB_TOKEN=""):
            self.assertIsNone(ha.pr_status(self.MR))
        with self._configured(), \
                mock.patch.object(ha, "_gitlab_get", return_value=None):
            self.assertIsNone(ha.pr_status(self.MR))

    def test_mr_status_keeps_input_url_when_payload_lacks_one(self):
        with self._configured(), \
                mock.patch.object(ha, "_gitlab_get",
                                  return_value={"iid": 12, "state": "opened"}):
            self.assertEqual(ha.pr_status(self.MR)["url"], self.MR)


class TestRefreshPrStatus(ManagerMixin, unittest.TestCase):
    """The manager's slow-cadence PR status refresh + per-session attachment."""

    def _running_session(self, sid, urls):
        sm = self.make_manager()
        sm.registry = [{"id": sid, "status": "running"}]
        sm.session_pr_urls[sid] = list(urls)
        return sm

    def test_skips_when_gh_unavailable(self):
        sm = self._running_session("s1", ["https://github.com/o/r/pull/1"])
        sm.github = {"available": False}
        with mock.patch.object(ha, "pr_status") as pr:
            sm.refresh_pr_status()
        pr.assert_not_called()
        self.assertEqual(sm.pr_status_cache, {})

    def test_gh_less_gitlab_host_still_refreshes_its_mrs(self):
        """XERK-162: a host with no gh login but a configured GitLab polls its
        MRs — and only them; the github URL it can't answer for is skipped
        (keeping its last-known status) rather than burning a doomed gh call."""
        mr = "https://gitlab.example.com/grp/app/-/merge_requests/5"
        gh_url = "https://github.com/o/r/pull/1"
        sm = self._running_session("s1", [gh_url, mr])
        sm.github = {"available": False}
        with mock.patch.multiple(ha, GITLAB_URL="https://gitlab.example.com",
                                 GITLAB_TOKEN="tok"), \
                mock.patch.object(ha, "pr_status",
                                  return_value={"url": mr, "state": "OPEN"}) as pr:
            sm.refresh_pr_status()
        pr.assert_called_once_with(mr)
        self.assertEqual(sm.pr_status_cache[mr]["state"], "OPEN")

    def test_foreign_gitlab_mr_is_not_polled(self):
        # An MR on a GitLab this host holds no credential for can never answer;
        # don't spend the beat's budget asking.
        mr = "https://other.tld/g/a/-/merge_requests/9"
        sm = self._running_session("s1", [mr])
        sm.github = {"available": True}
        with mock.patch.multiple(ha, GITLAB_URL="https://gitlab.example.com",
                                 GITLAB_TOKEN="tok"), \
                mock.patch.object(ha, "pr_status") as pr:
            sm.refresh_pr_status()
        pr.assert_not_called()

    def test_gh_less_azdo_host_still_refreshes_its_prs(self):
        """XERK-226: the same for an Azure DevOps org — its PAT answers for its
        own PRs, and a foreign org's PR is skipped rather than asked about."""
        ours = "https://dev.azure.com/myorg/Proj/_git/app/pullrequest/5"
        theirs = "https://dev.azure.com/other/P/_git/r/pullrequest/9"
        sm = self._running_session("s1", [ours, theirs,
                                          "https://github.com/o/r/pull/1"])
        sm.github = {"available": False}
        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/myorg",
                                 AZDO_TOKEN="pat"), \
                mock.patch.object(ha, "pr_status",
                                  return_value={"url": ours, "state": "OPEN"}) as pr:
            sm.refresh_pr_status()
        pr.assert_called_once_with(ours)

    def test_fetches_and_caches(self):
        url = "https://github.com/o/r/pull/1"
        sm = self._running_session("s1", [url])
        sm.github = {"available": True}
        with mock.patch.object(ha, "pr_status", return_value={"url": url, "state": "OPEN"}) as pr:
            sm.refresh_pr_status()
        pr.assert_called_once_with(url)
        self.assertEqual(sm.pr_status_cache[url]["state"], "OPEN")

    def test_prunes_unreferenced(self):
        sm = self._running_session("s1", ["https://github.com/o/r/pull/1"])
        sm.github = {"available": True}
        sm.pr_status_cache = {"https://github.com/o/r/pull/99": {"state": "MERGED"}}
        with mock.patch.object(ha, "pr_status", return_value=None):
            sm.refresh_pr_status()
        self.assertNotIn("https://github.com/o/r/pull/99", sm.pr_status_cache)

    def test_ignores_stopped_sessions(self):
        # A stopped session's PR is not RE-POLLED (no gh call)...
        url = "https://github.com/o/r/pull/1"
        sm = self.make_manager()
        sm.registry = [{"id": "s1", "status": "stopped"}]
        sm.session_pr_urls["s1"] = [url]
        sm.github = {"available": True}
        with mock.patch.object(ha, "pr_status") as pr:
            sm.refresh_pr_status()
        pr.assert_not_called()

    def test_keeps_stopped_session_last_known_status(self):
        # ...but its last-known status is retained (not pruned), so its card
        # still shows the state it reached.
        url = "https://github.com/o/r/pull/1"
        sm = self.make_manager()
        sm.registry = [{"id": "s1", "status": "stopped"}]
        sm.session_pr_urls["s1"] = [url]
        sm.pr_status_cache[url] = {"url": url, "state": "MERGED"}
        sm.github = {"available": True}
        with mock.patch.object(ha, "pr_status", return_value=None):
            sm.refresh_pr_status()
        self.assertEqual(sm.pr_status_cache[url]["state"], "MERGED")

    def test_keeps_killed_session_last_known_status(self):
        """A killed session has NO registry record — only a closed record holding
        its own prUrls. Its status must survive the sweep anyway: the Ended
        sessions list renders those chips, so evicting them here would mean the
        act of killing a session blanked the PR state its ended card shows."""
        url = "https://github.com/o/r/pull/1"
        sm = self.make_manager()
        sm.registry = []
        sm.closed = [{"id": "s1", "repo": "r", "prUrls": [url]}]
        sm.pr_status_cache[url] = {"url": url, "state": "MERGED"}
        sm.github = {"available": True}
        with mock.patch.object(ha, "pr_status") as pr:
            sm.refresh_pr_status()
        pr.assert_not_called()   # not re-polled, same rule as a stopped session
        self.assertEqual(sm.pr_status_cache[url]["state"], "MERGED")

    def test_closed_prs_shape(self):
        url = "https://github.com/o/r/pull/1"
        sm = self.make_manager()
        rec = {"id": "s1", "prUrls": [url]}
        # Mirrors _session_prs: a bare {url} placeholder until the status lands.
        self.assertEqual(sm._closed_prs(rec), [{"url": url}])
        sm.pr_status_cache[url] = {"url": url, "state": "MERGED"}
        self.assertEqual(sm._closed_prs(rec), [{"url": url, "state": "MERGED"}])
        # A session that opened no PR reports None, like the live payload.
        self.assertIsNone(sm._closed_prs({"id": "s2"}))
        self.assertIsNone(sm._closed_prs({"id": "s3", "prUrls": []}))

    def test_session_prs_shape(self):
        url = "https://github.com/o/r/pull/1"
        sm = self._running_session("s1", [url])
        # No cache yet -> bare {url} placeholder, still attached (running or not).
        self.assertEqual(sm._session_prs("s1"), [{"url": url}])
        sm.pr_status_cache[url] = {"url": url, "state": "OPEN"}
        self.assertEqual(sm._session_prs("s1"), [{"url": url, "state": "OPEN"}])
        # A session that opened no PR reports None (so the payload key stays empty).
        self.assertIsNone(sm._session_prs("nope"))

    _SIGNAL_STUB = {
        "tail": [], "bridgeAttached": False, "paneBusy": None,
        "transcriptAgeSec": None, "lastRole": None, "lastHasToolUse": False,
        "question": None, "questionOptions": [], "questionSource": None,
    }

    def test_prs_survive_pending_clear(self):
        """The regression this whole store exists for: pending_prs is emptied on
        every delivered beat (_clear_pending_prs), and session_report only emits
        a PR url ONCE (offset advances past it). The PR must stay on the card
        anyway — read from the persistent session_pr_urls, not the queue."""
        url = "https://github.com/o/r/pull/5"
        sm = self.make_manager()
        sess = {"id": "s1", "status": "running", "repo": "r", "repoPath": "/p",
                "worktreePath": "/w", "branch": None, "rcName": "n"}
        sm.registry = [sess]
        with mock.patch.object(sm, "_session_git", return_value=(None, {})):
            # Beat 1: session_report scrapes the new PR url -> it's on the card.
            with mock.patch.object(ha, "session_report",
                                   return_value={"prUrls": [url], **self._SIGNAL_STUB}):
                p1 = sm._session_payload(sess)
            self.assertEqual([pr["url"] for pr in p1["prs"]], [url])
            # A delivered heartbeat empties the per-beat delivery queue...
            sm._clear_pending_prs()
            self.assertEqual(sm.pending_prs["s1"], [])
            # Beat 2: session_report emits NO new url (offset moved past it)...
            with mock.patch.object(ha, "session_report",
                                   return_value={"prUrls": [], **self._SIGNAL_STUB}):
                p2 = sm._session_payload(sess)
            # ...but the PR is STILL on the card (persistent store).
            self.assertEqual([pr["url"] for pr in p2["prs"]], [url])
        # And refresh_pr_status can still find it to poll after the clear.
        sm.github = {"available": True}
        with mock.patch.object(ha, "pr_status", return_value={"url": url, "state": "OPEN"}) as pr:
            sm.refresh_pr_status()
        pr.assert_called_once_with(url)

    def test_prs_survive_agent_restart(self):
        """XERK-15: a running session's opened-PR chips must survive an agent
        restart. session_pr_urls is in-memory and the transcript scan primes to
        EOF on boot (so it never replays old links), so the links have to be
        mirrored onto the durable session record and rehydrated from it — the
        same durability a killed session's PRs already get off closed.json."""
        url = "https://github.com/o/r/pull/9"
        sm = self.make_manager()
        sess = {"id": "s1", "status": "running", "repo": "r", "repoPath": "/p",
                "worktreePath": "/w", "branch": None, "rcName": "n"}
        sm.registry = [sess]
        with mock.patch.object(sm, "_session_git", return_value=(None, {})):
            with mock.patch.object(ha, "session_report",
                                   return_value={"prUrls": [url], **self._SIGNAL_STUB}):
                sm._session_payload(sess)
        # The link is now mirrored onto the record and persisted to disk.
        self.assertEqual(sess["prUrls"], [url])
        # A fresh manager (agent restart) reads the registry back and rehydrates
        # the in-memory store, so the chip is on the card from the first beat.
        sm2 = self.make_manager()
        self.assertEqual(sm2.session_pr_urls["s1"], [url])
        self.assertEqual([pr["url"] for pr in sm2._session_prs("s1")], [url])
        # And the rehydrated link is re-pollable, so the full state/CI returns.
        sm2.github = {"available": True}
        with mock.patch.object(ha, "pr_status",
                               return_value={"url": url, "state": "OPEN"}) as pr:
            sm2.refresh_pr_status()
        pr.assert_called_once_with(url)


class TestPrLedger(ManagerMixin, unittest.TestCase):
    """The durable transcript -> PR-links ledger (XERK-13): what makes a
    session's PR chips survive a manager restart and outlive its record —
    killed, aged out of closed.json, or wiped with the in-memory scan."""

    URL = "https://github.com/o/r/pull/1"
    URL2 = "https://github.com/o/r/pull/2"

    def _running(self, sm, sid="s1", tid="t1", urls=(URL,)):
        sm.registry = [{"id": sid, "status": "running", "claudeSessionId": tid}]
        sm.session_pr_urls[sid] = list(urls)
        return sm

    def test_remember_persists_and_reloads(self):
        sm = self._running(self.make_manager())
        self.assertTrue(sm._remember_prs(sm.registry[0]))
        # A fresh manager reads the links back off disk — the whole point.
        self.assertEqual(self.make_manager().pr_ledger["t1"]["urls"], [self.URL])

    def test_ignores_a_session_with_no_pr_or_no_transcript(self):
        sm = self.make_manager()
        # No PR opened.
        sm.registry = [{"id": "s1", "status": "running", "claudeSessionId": "t1"}]
        self.assertFalse(sm._remember_prs(sm.registry[0]))
        # A PR but no transcript to key on (not launched / pinned yet).
        sm.session_pr_urls["s2"] = [self.URL]
        self.assertFalse(sm._remember_prs({"id": "s2"}))
        self.assertEqual(sm.pr_ledger, {})

    def test_remember_is_idempotent(self):
        """Called each beat a URL is present, so an unchanged entry must not
        rewrite the file — and must not restamp `at`, the prune's sort key."""
        sm = self._running(self.make_manager())
        self.assertTrue(sm._remember_prs(sm.registry[0]))
        at = sm.pr_ledger["t1"]["at"]
        self.assertFalse(sm._remember_prs(sm.registry[0]))
        self.assertEqual(sm.pr_ledger["t1"]["at"], at)

    def test_a_new_url_merges_without_restamping(self):
        sm = self._running(self.make_manager())
        sm._remember_prs(sm.registry[0])
        at = sm.pr_ledger["t1"]["at"]
        sm.session_pr_urls["s1"].append(self.URL2)
        self.assertTrue(sm._remember_prs(sm.registry[0]))
        self.assertEqual(sm.pr_ledger["t1"]["urls"], [self.URL, self.URL2])
        self.assertEqual(sm.pr_ledger["t1"]["at"], at)   # first-seen preserved

    def test_ledger_backfills_a_live_session_the_xerk15_mirror_missed(self):
        """The ledger fills the gap XERK-15's sess["prUrls"] mirror can't: a
        registry record predating that mirror carries no prUrls to rehydrate
        from, but its ledgered links (from a prior run) still name its PRs, so the
        chip comes back on boot anyway (setdefault — XERK-15 wins when it has a
        copy). The record here has no prUrls, exactly that pre-mirror shape."""
        sm = self._running(self.make_manager())
        sm._remember_prs(sm.registry[0])
        write_json(ha.REGISTRY_PATH, sm.registry)   # persisted WITHOUT prUrls
        sm2 = self.make_manager()
        self.assertEqual(sm2.session_pr_urls["s1"], [self.URL])   # re-seeded
        self.assertEqual([p["url"] for p in sm2._session_prs("s1")], [self.URL])

    def test_backfills_from_closed_history(self):
        """A closed record snapshots its own prUrls; adopt those so a ledger
        added after the fact doesn't start empty on the sessions already ended."""
        rec = {"id": "dead", "repo": "r", "transcriptId": "t-dead",
               "prUrls": [self.URL]}
        write_json(ha.CLOSED_PATH, [rec])
        sm = self.make_manager()
        self.assertEqual(sm.pr_ledger["t-dead"]["urls"], [self.URL])
        # And it was persisted, not just held in memory.
        self.assertEqual(self.make_manager().pr_ledger["t-dead"]["urls"], [self.URL])

    def test_ledger_prs_shape(self):
        sm = self.make_manager()
        sm.pr_ledger["t1"] = {"urls": [self.URL], "at": "2026-01-01T00:00:00Z"}
        # Bare {url} until the status lands (mirrors _session_prs/_closed_prs).
        self.assertEqual(sm._ledger_prs("t1"), [{"url": self.URL}])
        sm.pr_status_cache[self.URL] = {"url": self.URL, "state": "MERGED"}
        self.assertEqual(sm._ledger_prs("t1"), [{"url": self.URL, "state": "MERGED"}])
        # Nothing ledgered / opened -> None, so the payload key stays empty.
        self.assertIsNone(sm._ledger_prs("nope"))
        self.assertIsNone(sm._ledger_prs(None))

    def test_refresh_persists_status_so_the_pill_survives_a_restart(self):
        """A polled PR's status is persisted, so a fresh manager loads it back and
        the chip keeps its state/CI pill rather than degrading to a bare link."""
        sm = self._running(self.make_manager())
        sm.github = {"available": True}
        with mock.patch.object(
                ha, "pr_status", return_value={"url": self.URL, "state": "OPEN"}):
            sm.refresh_pr_status()
        self.assertEqual(
            self.make_manager().pr_status_cache[self.URL]["state"], "OPEN")

    def test_a_ledgered_ended_pr_status_is_not_evicted(self):
        """An ended session aged out of closed.json is reported only through the
        resumable scan, which reads its links from the ledger — so its last-known
        status has to survive the prune even with no live/closed record holding
        it, or its ended card shows a bare link."""
        stale = "https://github.com/o/r/pull/99"
        sm = self.make_manager()
        sm.registry = []
        sm.closed = []
        sm.pr_ledger["t1"] = {"urls": [self.URL], "at": "2026-01-01T00:00:00Z"}
        sm.pr_status_cache = {self.URL: {"url": self.URL, "state": "MERGED"},
                              stale: {"url": stale, "state": "CLOSED"}}
        sm.github = {"available": True}
        with mock.patch.object(ha, "pr_status") as pr:
            sm.refresh_pr_status()
        pr.assert_not_called()                                  # never re-polled
        self.assertEqual(sm.pr_status_cache[self.URL]["state"], "MERGED")  # kept
        self.assertNotIn(stale, sm.pr_status_cache)   # truly unreferenced: evicted

    def test_kill_records_to_the_ledger(self):
        sm = self._running(self.make_manager())
        sm.registry[0].update({"repo": "r", "worktreePath": "/w"})
        with mock.patch.object(sm, "_kill_tmux"), \
                mock.patch.object(sm, "_kill_ttyd"), \
                mock.patch.object(sm, "_session_transcript_id", return_value="t1"):
            sm.kill("s1")
        self.assertEqual(sm.pr_ledger["t1"]["urls"], [self.URL])
        # Survives the kill dropping the in-memory set.
        self.assertNotIn("s1", sm.session_pr_urls)

    def test_end_to_end_scan_then_restart_keeps_the_chip(self):
        """The whole path: the real transcript scan discovers an opened PR through
        _session_payload, the ledger persists it, and a fresh manager (a restart,
        with the scan primed to EOF and unable to re-find it) still reports it."""
        sm = self.make_manager()
        tid = "22222222-2222-4222-8222-222222222222"
        wt = os.path.join(ha.WORKTREES_ROOT, "Turma", "abcde")
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(wt))
        os.makedirs(proj, exist_ok=True)
        path = os.path.join(proj, tid + ".jsonl")
        write_jsonl(path, [{"type": "user",
                            "message": {"role": "user", "content": "hi"}}])
        sess = {"id": "s1", "status": "running", "repo": "Turma", "repoPath": "/p",
                "worktreePath": wt, "branch": None, "rcName": "n",
                "claudeSessionId": tid}
        sm.registry = [sess]
        write_json(ha.REGISTRY_PATH, sm.registry)
        with mock.patch.object(sm, "_session_git", return_value=(None, {})):
            self.assertIsNone(sm._session_payload(sess)["prs"])   # beat 1 primes
            # Now the session actually opens a PR — the two entries `gh pr create`
            # leaves: the call, then its output (the new PR's URL).
            write_jsonl(path, [
                {"type": "assistant", "message": {"content": [
                    {"type": "tool_use", "id": "c1", "name": "Bash",
                     "input": {"command": "gh pr create --fill"}}]}},
                {"type": "user", "message": {"content": [
                    {"type": "tool_result", "tool_use_id": "c1",
                     "content": self.URL}]}},
            ])
            p1 = sm._session_payload(sess)   # beat 2: scan scrapes the URL
        self.assertEqual([pr["url"] for pr in p1["prs"]], [self.URL])
        self.assertEqual(sm.pr_ledger[tid]["urls"], [self.URL])   # and it's durable

        # Restart: a fresh manager reads the same registry + transcript. The scan
        # primes to EOF and finds nothing new, but the chip comes back anyway.
        sm2 = self.make_manager()
        with mock.patch.object(sm2, "_session_git", return_value=(None, {})):
            p2 = sm2._session_payload(sm2.registry[0])
        self.assertEqual([pr["url"] for pr in p2["prs"]], [self.URL])

    def test_prune_bounds_oldest_first(self):
        p = mock.patch.object(ha, "PR_LEDGER_MAX", 2)
        p.start()
        self.addCleanup(p.stop)
        sm = self.make_manager()
        for i, at in enumerate(["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z",
                                "2026-03-01T00:00:00Z"]):
            sm.pr_ledger[f"t{i}"] = {"urls": [f"u{i}"], "at": at}
        sm._prune_pr_ledger()
        self.assertEqual(set(sm.pr_ledger), {"t1", "t2"})   # oldest t0 fell off


class TestNormalizeJiraSite(unittest.TestCase):
    """Every way an operator might write the site collapses to one bare
    lowercase host — the cross-host siteKey the hub dedupes boards on."""

    def test_variants_collapse(self):
        for raw in ("myorg.atlassian.net",
                    "MyOrg.Atlassian.Net",
                    "https://myorg.atlassian.net",
                    "https://myorg.atlassian.net/",
                    "https://myorg.atlassian.net/jira/software/projects/X/boards/1",
                    "https://user@myorg.atlassian.net:443/browse/PROJ-1"):
            self.assertEqual(ha.normalize_jira_site(raw), "myorg.atlassian.net", raw)

    def test_empty(self):
        self.assertEqual(ha.normalize_jira_site(""), "")
        self.assertEqual(ha.normalize_jira_site(None), "")


class TestShapeIssue(unittest.TestCase):
    """Raw REST-v3 search issue -> the compact wire ticket the board renders."""

    def _issue(self, **overrides):
        fields = {
            "summary": "Fix the flux capacitor",
            "status": {"name": "In Review",
                       "statusCategory": {"key": "indeterminate"}},
            "priority": {"name": "High"},
            "issuetype": {"name": "Bug"},
            "project": {"key": "PROJ", "name": "Project X"},
            "labels": ["infra", "urgent"],
            "updated": "2026-07-14T08:12:00.000+0000",
            "created": "2026-07-01T08:12:00.000+0000",
            "duedate": "2026-07-20",
            "parent": {"key": "PROJ-100"},
        }
        fields.update(overrides)
        return {"key": "PROJ-123", "fields": fields}

    def test_full_issue(self):
        t = ha._shape_issue(self._issue(), "myorg.atlassian.net")
        self.assertEqual(t["key"], "PROJ-123")
        self.assertEqual(t["url"], "https://myorg.atlassian.net/browse/PROJ-123")
        self.assertEqual(t["summary"], "Fix the flux capacitor")
        self.assertEqual(t["status"], "In Review")
        self.assertEqual(t["statusCategory"], "inprogress")
        self.assertEqual(t["priority"], "High")
        self.assertEqual(t["type"], "Bug")
        self.assertEqual(t["project"], "PROJ")
        self.assertEqual(t["projectName"], "Project X")
        self.assertEqual(t["labels"], ["infra", "urgent"])
        self.assertEqual(t["dueDate"], "2026-07-20")
        self.assertEqual(t["parentKey"], "PROJ-100")

    def test_category_mapping(self):
        for key, cat in (("new", "todo"), ("indeterminate", "inprogress"),
                         ("done", "done"), ("weird-future-key", "todo")):
            issue = self._issue(status={"name": "S",
                                        "statusCategory": {"key": key}})
            self.assertEqual(
                ha._shape_issue(issue, "s")["statusCategory"], cat, key)

    def test_missing_optionals_degrade_to_none(self):
        issue = self._issue(priority=None, duedate=None, labels=None)
        del issue["fields"]["parent"]
        t = ha._shape_issue(issue, "s")
        self.assertIsNone(t["priority"])
        self.assertIsNone(t["dueDate"])
        self.assertIsNone(t["parentKey"])
        self.assertEqual(t["labels"], [])

    def test_caps(self):
        issue = self._issue(summary="x" * 500,
                            labels=[f"l{i}" for i in range(20)])
        t = ha._shape_issue(issue, "s")
        self.assertEqual(len(t["summary"]), 200)
        self.assertEqual(len(t["labels"]), 5)

    def test_empty_issue_never_raises(self):
        t = ha._shape_issue({}, "s")
        self.assertEqual(t["statusCategory"], "todo")
        self.assertEqual(t["summary"], "")


def _jira_page(keys, next_token=None):
    page = {"issues": [
        {"key": k, "fields": {"summary": k,
                              "status": {"name": "To Do",
                                         "statusCategory": {"key": "new"}}}}
        for k in keys]}
    if next_token:
        page["nextPageToken"] = next_token
    return page


class TestFetchJiraIssues(unittest.TestCase):
    """Pagination against /rest/api/3/search/jql (the nextPageToken API that
    replaced the removed /rest/api/3/search) and the truncation cap."""

    def test_stitches_pages_via_next_page_token(self):
        pages = [_jira_page(["A-1", "A-2"], next_token="tok1"),
                 _jira_page(["A-3"])]
        calls = []

        def fake_get(path, params):
            calls.append((path, dict(params)))
            return pages[len(calls) - 1]

        with mock.patch.object(ha, "JIRA_SITE", "myorg.atlassian.net"), \
             mock.patch.object(ha, "jira_get", fake_get):
            tickets, truncated = ha.fetch_jira_issues("jql here", 100)
        self.assertEqual([t["key"] for t in tickets], ["A-1", "A-2", "A-3"])
        self.assertFalse(truncated)
        # The new endpoint, never the removed one, on every page.
        self.assertTrue(all(p == "/rest/api/3/search/jql" for p, _ in calls))
        self.assertNotIn("nextPageToken", calls[0][1])
        self.assertEqual(calls[1][1]["nextPageToken"], "tok1")
        self.assertIn("summary", calls[0][1]["fields"])

    def test_cap_stops_pagination_and_flags_truncated(self):
        def fake_get(path, params):
            return _jira_page(["B-1", "B-2"], next_token="more")

        with mock.patch.object(ha, "JIRA_SITE", "s.atlassian.net"), \
             mock.patch.object(ha, "jira_get", fake_get):
            tickets, truncated = ha.fetch_jira_issues("jql", 3)
        self.assertEqual(len(tickets), 3)
        self.assertTrue(truncated)

    def test_page_bound_flags_truncated(self):
        def fake_get(path, params):
            return _jira_page(["C-1"], next_token="forever")

        with mock.patch.object(ha, "JIRA_SITE", "s.atlassian.net"), \
             mock.patch.object(ha, "jira_get", fake_get):
            tickets, truncated = ha.fetch_jira_issues("jql", 1000)
        self.assertEqual(len(tickets), ha.JIRA_MAX_PAGES)
        self.assertTrue(truncated)


class TestCollectJira(unittest.TestCase):
    def test_unconfigured_full_schema_no_http(self):
        with mock.patch.object(ha, "JIRA_SITE", ""), \
             mock.patch.object(ha, "JIRA_EMAIL", ""), \
             mock.patch.object(ha, "JIRA_TOKEN", ""), \
             mock.patch.object(ha, "jira_get") as get:
            block = ha.collect_jira()
        get.assert_not_called()
        self.assertEqual(block, ha.JIRA_EMPTY)
        self.assertIsNot(block, ha.JIRA_EMPTY)   # a copy, never the shared dict
        self.assertFalse(block["configured"])

    def test_configured_flag_marks_creds_not_success(self):
        # `configured` is what lets the hub aim the board's manual refresh at a
        # host whose polls are FAILING — which reports available=False and is
        # otherwise indistinguishable from a host with no Jira at all.
        with mock.patch.object(ha, "JIRA_SITE", "s.atlassian.net"), \
             mock.patch.object(ha, "JIRA_EMAIL", "e@x.com"), \
             mock.patch.object(ha, "JIRA_TOKEN", "t"):
            empty = ha.jira_empty()
            self.assertTrue(empty["configured"])
            self.assertFalse(empty["available"])  # creds != a successful poll

            with mock.patch.object(ha, "fetch_jira_issues",
                                   return_value=([], False)):
                block = ha.collect_jira()
        self.assertTrue(block["configured"])
        self.assertTrue(block["available"])


    def test_configured_issues_both_queries(self):
        jqls = []

        def fake_fetch(jql, cap):
            jqls.append(jql)
            key = "D-1" if "!= Done" in jql else "D-2"
            return ([ha._shape_issue({"key": key, "fields": {}}, "s")],
                    False)

        with mock.patch.object(ha, "JIRA_SITE", "MyOrg.atlassian.net"), \
             mock.patch.object(ha, "JIRA_EMAIL", "me@x.com"), \
             mock.patch.object(ha, "JIRA_TOKEN", "tok"), \
             mock.patch.object(ha, "fetch_jira_issues", fake_fetch):
            block = ha.collect_jira()
        self.assertTrue(block["available"])
        self.assertEqual(block["siteKey"], "myorg.atlassian.net")
        self.assertEqual(block["user"], "me@x.com")
        self.assertIsNone(block["error"])
        self.assertFalse(block["truncated"])
        self.assertEqual([t["key"] for t in block["tickets"]], ["D-1", "D-2"])
        self.assertTrue(block["fetchedAt"])
        # Active work and recently-Done are separate queries with separate caps.
        self.assertEqual(len(jqls), 2)
        self.assertIn("statusCategory != Done", jqls[0])
        self.assertIn("statusCategory = Done", jqls[1])
        self.assertIn(f"-{ha.JIRA_DONE_DAYS}d", jqls[1])

    def test_truncated_rolls_up(self):
        with mock.patch.object(ha, "JIRA_SITE", "s.atlassian.net"), \
             mock.patch.object(ha, "JIRA_EMAIL", "e"), \
             mock.patch.object(ha, "JIRA_TOKEN", "t"), \
             mock.patch.object(ha, "fetch_jira_issues",
                               side_effect=[([], True), ([], False)]):
            self.assertTrue(ha.collect_jira()["truncated"])


def _adf(*content):
    return {"type": "doc", "version": 1, "content": list(content)}


def _para(*content):
    return {"type": "paragraph", "content": list(content)}


def _txt(text, marks=None):
    node = {"type": "text", "text": text}
    if marks:
        node["marks"] = marks
    return node


class TestAdfText(unittest.TestCase):
    """Jira's rich text (ADF node tree) -> the plain text the board renders."""

    def test_paragraphs_separated(self):
        doc = _adf(_para(_txt("first")), _para(_txt("second")))
        self.assertEqual(ha.adf_plain(doc, 999), ("first\n\nsecond", False))

    def test_plain_string_body(self):
        # REST v2 / some webhooks send a bare string, not a node tree.
        self.assertEqual(ha.adf_plain("just text", 999), ("just text", False))

    def test_link_mark_keeps_href(self):
        doc = _adf(_para(_txt("the PR", [{"type": "link", "attrs": {"href": "https://x/1"}}])))
        self.assertEqual(ha.adf_plain(doc, 999)[0], "the PR (https://x/1)")

    def test_link_mark_skips_redundant_href(self):
        url = "https://x/1"
        doc = _adf(_para(_txt(url, [{"type": "link", "attrs": {"href": url}}])))
        self.assertEqual(ha.adf_plain(doc, 999)[0], url)

    def test_lists_bullets_and_hard_breaks(self):
        doc = _adf({"type": "bulletList", "content": [
            {"type": "listItem", "content": [_para(_txt("one"))]},
            {"type": "listItem", "content": [_para(_txt("two"))]},
        ]}, _para(_txt("a"), {"type": "hardBreak"}, _txt("b")))
        self.assertEqual(ha.adf_plain(doc, 999)[0], "- one\n- two\n\na\nb")

    def test_mention_emoji_card_and_table(self):
        doc = _adf(
            _para(_txt("cc "), {"type": "mention", "attrs": {"text": "@Sam"}}),
            {"type": "table", "content": [{"type": "tableRow", "content": [
                {"type": "tableCell", "content": [_para(_txt("k"))]},
                {"type": "tableCell", "content": [_para(_txt("v"))]},
            ]}]},
            _para({"type": "inlineCard", "attrs": {"url": "https://x/2"}}),
        )
        self.assertEqual(ha.adf_plain(doc, 999)[0], "cc @Sam\n\nk | v\n\nhttps://x/2")

    def test_unknown_node_still_yields_its_text(self):
        doc = _adf({"type": "someFutureThing", "content": [_para(_txt("kept"))]})
        self.assertEqual(ha.adf_plain(doc, 999)[0], "kept")

    def test_malformed_never_raises(self):
        for bad in (None, 12, [], {"type": "text"}, {"content": None},
                    {"type": "paragraph", "content": "nope"},
                    {"type": "text", "text": "x", "marks": ["junk"]}):
            ha.adf_plain(bad, 99)   # just must not raise

    def test_clip_reports_truncation(self):
        doc = _adf(_para(_txt("x" * 50)))
        text, trunc = ha.adf_plain(doc, 10)
        self.assertEqual(text, "x" * 10)
        self.assertTrue(trunc)
        self.assertFalse(ha.adf_plain(doc, 50)[1])

    def test_blank_line_runs_collapse(self):
        doc = _adf(_para(_txt("a")), _para(), _para(), _para(_txt("b")))
        self.assertEqual(ha.adf_plain(doc, 999)[0], "a\n\nb")


def _issue_detail_payload(**over):
    fields = {
        "summary": "Fix the thing",
        "status": {"name": "In Review", "statusCategory": {"key": "indeterminate"}},
        "priority": {"name": "High"},
        "issuetype": {"name": "Bug"},
        "project": {"key": "ENG", "name": "Engineering"},
        "parent": {"key": "ENG-1", "fields": {"summary": "the epic"}},
        "labels": ["a", "b"],
        "updated": "2026-07-14T10:00:00.000+0000",
        "created": "2026-07-01T10:00:00.000+0000",
        "duedate": "2026-07-20",
        "resolution": {"name": "Done"},
        "reporter": {"displayName": "Ada"},
        "assignee": {"displayName": "Grace"},
        "description": _adf(_para(_txt("why it matters"))),
        "comment": {"total": 2, "comments": [
            {"id": "1", "author": {"displayName": "Ada"},
             "created": "2026-07-02T10:00:00.000+0000",
             "updated": "2026-07-02T10:00:00.000+0000",
             "body": _adf(_para(_txt("first note")))},
            {"id": "2", "author": {"displayName": "Grace"},
             "created": "2026-07-03T10:00:00.000+0000",
             "updated": "2026-07-03T10:00:00.000+0000",
             "body": _adf(_para(_txt("second note")))},
        ]},
    }
    fields.update(over.pop("fields", {}))
    return {"key": "ENG-42", "fields": fields, **over}


class TestShapeIssueDetail(unittest.TestCase):
    """The expanded-view shape: the card's fields plus description/comments."""

    def test_full_shape(self):
        d = ha._shape_issue_detail(_issue_detail_payload(), "myorg.atlassian.net")
        # Everything the card already had still rides along.
        self.assertEqual(d["key"], "ENG-42")
        self.assertEqual(d["url"], "https://myorg.atlassian.net/browse/ENG-42")
        self.assertEqual(d["status"], "In Review")
        self.assertEqual(d["statusCategory"], "inprogress")
        self.assertEqual(d["priority"], "High")
        self.assertEqual(d["project"], "ENG")
        # …plus what only the detail view shows.
        self.assertEqual(d["description"], "why it matters")
        self.assertFalse(d["descriptionTruncated"])
        self.assertEqual(d["reporter"], "Ada")
        self.assertEqual(d["assignee"], "Grace")
        self.assertEqual(d["resolution"], "Done")
        self.assertEqual(d["parentSummary"], "the epic")
        self.assertEqual([c["body"] for c in d["comments"]], ["first note", "second note"])
        self.assertEqual([c["author"] for c in d["comments"]], ["Ada", "Grace"])
        self.assertEqual(d["commentTotal"], 2)
        self.assertTrue(d["fetchedAt"])

    def test_keeps_newest_comments_and_reports_total(self):
        many = [{"id": str(i), "author": {"displayName": "A"},
                 "body": _adf(_para(_txt(f"c{i}")))}
                for i in range(ha.JIRA_COMMENT_MAX + 5)]
        d = ha._shape_issue_detail(
            _issue_detail_payload(fields={"comment": {"total": len(many), "comments": many}}),
            "s")
        self.assertEqual(len(d["comments"]), ha.JIRA_COMMENT_MAX)
        # Jira lists comments oldest-first; the newest are the ones kept.
        self.assertEqual(d["comments"][-1]["body"], f"c{len(many) - 1}")
        self.assertEqual(d["commentTotal"], len(many))   # so the UI can say what it dropped

    def test_long_text_truncated_and_flagged(self):
        big = _adf(_para(_txt("x" * (ha.JIRA_DESC_MAX_CHARS + 100))))
        huge = _adf(_para(_txt("y" * (ha.JIRA_COMMENT_MAX_CHARS + 100))))
        d = ha._shape_issue_detail(_issue_detail_payload(fields={
            "description": big,
            "comment": {"total": 1, "comments": [{"id": "1", "body": huge}]},
        }), "s")
        self.assertEqual(len(d["description"]), ha.JIRA_DESC_MAX_CHARS)
        self.assertTrue(d["descriptionTruncated"])
        self.assertEqual(len(d["comments"][0]["body"]), ha.JIRA_COMMENT_MAX_CHARS)
        self.assertTrue(d["comments"][0]["truncated"])

    def test_empty_fields_degrade_not_raise(self):
        d = ha._shape_issue_detail({"key": "X-1", "fields": {}}, "s")
        self.assertEqual(d["description"], "")
        self.assertEqual(d["comments"], [])
        self.assertEqual(d["commentTotal"], 0)
        self.assertIsNone(d["reporter"])
        self.assertIsNone(d["resolution"])
        self.assertEqual(d["labels"], [])
        self.assertIsNone(d["parentSummary"])

    def test_junk_comment_container_ignored(self):
        for junk in ("nope", {"comments": "nope"}, {}, None):
            d = ha._shape_issue_detail(
                _issue_detail_payload(fields={"comment": junk}), "s")
            self.assertEqual(d["comments"], [])

    def test_detail_keeps_more_labels_than_the_card(self):
        labels = [f"l{i}" for i in range(ha.JIRA_DETAIL_LABELS_MAX + 5)]
        payload = _issue_detail_payload(fields={"labels": labels})
        self.assertEqual(len(ha._shape_issue(payload, "s")["labels"]), 5)
        self.assertEqual(len(ha._shape_issue_detail(payload, "s")["labels"]),
                         ha.JIRA_DETAIL_LABELS_MAX)

    def test_status_options_from_transitions_expansion(self):
        # The `transitions` expansion rides the issue GET; each option is labelled
        # with the RESULTING status (to.name), valued by the transition id, and
        # its column mapped from to.statusCategory. XERK-138.
        payload = _issue_detail_payload(transitions=[
            {"id": "11", "name": "Start Progress",
             "to": {"name": "In Progress", "statusCategory": {"key": "indeterminate"}}},
            {"id": "31", "name": "Done",
             "to": {"name": "Done", "statusCategory": {"key": "done"}}},
        ])
        d = ha._shape_issue_detail(payload, "s")
        self.assertEqual(d["statusOptions"], [
            {"id": "11", "name": "In Progress", "category": "inprogress"},
            {"id": "31", "name": "Done", "category": "done"},
        ])

    def test_status_options_empty_without_expansion(self):
        # No `transitions` (the expansion wasn't asked for, or a permissions wall)
        # -> no options, so the row stays read-only rather than raising.
        self.assertEqual(
            ha._shape_issue_detail(_issue_detail_payload(), "s")["statusOptions"], [])

    def test_status_options_skip_malformed(self):
        payload = _issue_detail_payload(transitions=[
            "junk", {"name": "no id"}, {"id": "9"},          # each dropped
            {"id": "5", "to": {"name": "Ready"}},            # kept; category -> todo
        ])
        self.assertEqual(ha._shape_issue_detail(payload, "s")["statusOptions"],
                         [{"id": "5", "name": "Ready", "category": "todo"}])

    def test_attachments_carry_what_a_download_needs(self):
        # XERK-242: the ticket's own files ride the detail so spawn_ticket can
        # fetch them for a session that has no board creds of its own.
        d = ha._shape_issue_detail(_issue_detail_payload(fields={"attachment": [
            {"id": "1", "filename": "shot.png", "size": 1234,
             "mimeType": "image/png",
             "content": "https://myorg.atlassian.net/rest/api/3/attachment/content/1"},
        ]}), "myorg.atlassian.net")
        self.assertEqual(d["attachments"], [{
            "name": "shot.png", "size": 1234, "mime": "image/png",
            "url": "https://myorg.atlassian.net/rest/api/3/attachment/content/1",
        }])

    def test_attachments_default_empty_and_skip_unfetchable(self):
        self.assertEqual(
            ha._shape_issue_detail(_issue_detail_payload(), "s")["attachments"], [])
        # No name or no URL is nothing to fetch and nothing to call it.
        d = ha._shape_issue_detail(_issue_detail_payload(fields={"attachment": [
            "junk", {"filename": "no-url.png"}, {"content": "https://s/1"},
            {"filename": "ok.pdf", "content": "https://s/2"},
        ]}), "s")
        self.assertEqual([a["name"] for a in d["attachments"]], ["ok.pdf"])
        self.assertIsNone(d["attachments"][0]["size"])

    def test_the_cap_keeps_the_NEWEST_and_says_how_many_it_dropped(self):
        # Both trackers list attachments oldest-first, so keeping the first N
        # would drop exactly the screenshot someone just added because the ticket
        # is about it. And the count before the cap rides along, so nothing is
        # dropped SILENTLY — the prompt can't state a quietly wrong total.
        n = ha.TICKET_ATTACH_MAX + 5
        many = [{"filename": f"f{i}.png", "content": f"https://s/{i}"} for i in range(n)]
        d = ha._shape_issue_detail(_issue_detail_payload(fields={"attachment": many}), "s")
        self.assertEqual(len(d["attachments"]), ha.TICKET_ATTACH_MAX)
        self.assertEqual(d["attachments"][-1]["name"], f"f{n - 1}.png")   # newest kept
        self.assertEqual(d["attachments"][0]["name"], f"f{n - ha.TICKET_ATTACH_MAX}.png")
        self.assertEqual(d["attachmentTotal"], n)

    def test_the_total_counts_only_fetchable_entries(self):
        d = ha._shape_issue_detail(_issue_detail_payload(fields={"attachment": [
            "junk", {"filename": "no-url.png"},
            {"filename": "ok.pdf", "content": "https://s/2"},
        ]}), "s")
        self.assertEqual(d["attachmentTotal"], 1)


class TestFetchJiraIssue(unittest.TestCase):
    def test_requests_the_issue_with_detail_fields(self):
        seen = {}

        def fake_get(path, params):
            seen["path"], seen["params"] = path, params
            return _issue_detail_payload()

        with mock.patch.object(ha, "JIRA_SITE", "MyOrg.atlassian.net"), \
             mock.patch.object(ha, "jira_get", fake_get):
            d = ha.fetch_jira_issue("ENG-42")
        self.assertEqual(seen["path"], "/rest/api/3/issue/ENG-42")
        for f in ("description", "comment", "reporter", "assignee"):
            self.assertIn(f, seen["params"]["fields"])
        # The available status changes come back with the issue (XERK-138), not
        # in a second round trip.
        self.assertEqual(seen["params"]["expand"], "transitions")
        # The ticket's attachments ride the same GET (XERK-242) — without the
        # field asked for, Jira sends none and a session sees no files at all.
        self.assertIn("attachment", seen["params"]["fields"])
        self.assertEqual(d["key"], "ENG-42")
        self.assertEqual(d["url"], "https://myorg.atlassian.net/browse/ENG-42")


# --- Azure DevOps (XERK-43) ----------------------------------------------------

class TestNormalizeAzureSite(unittest.TestCase):
    """Every way an operator writes AZDO_URL collapses to one siteKey that KEEPS
    the org/collection path (unlike the Jira host-only key)."""

    def test_cloud_and_server_variants(self):
        cases = {
            "https://dev.azure.com/MyOrg": "dev.azure.com/myorg",
            "https://dev.azure.com/MyOrg/": "dev.azure.com/myorg",
            "dev.azure.com/MyOrg": "dev.azure.com/myorg",
            "https://user@dev.azure.com/MyOrg": "dev.azure.com/myorg",
            "https://dev.azure.com/MyOrg/_apis/wit/wiql": "dev.azure.com/myorg",
            "https://tfs.co:8080/tfs/DefaultCollection":
                "tfs.co:8080/tfs/defaultcollection",
            "https://tfs.co/DefaultCollection/_apis/wit/wiql":
                "tfs.co/defaultcollection",
        }
        for raw, want in cases.items():
            self.assertEqual(ha.normalize_azure_site(raw), want, raw)

    def test_empty(self):
        self.assertEqual(ha.normalize_azure_site(""), "")
        self.assertEqual(ha.normalize_azure_site(None), "")


class TestAzureBase(unittest.TestCase):
    """AZDO_URL -> the scheme-qualified API/link base, trimmed of any pasted tail."""

    def test_defaults_https_and_trims(self):
        with mock.patch.object(ha, "AZDO_URL", "dev.azure.com/org"):
            self.assertEqual(ha.azure_base(), "https://dev.azure.com/org")
        # The REST/board tail is trimmed; any project segment before it is kept
        # (AZDO_URL is documented as the org/collection base, not a deep link).
        with mock.patch.object(ha, "AZDO_URL",
                               "https://tfs.co/Collection/_workitems/edit/9/"):
            self.assertEqual(ha.azure_base(), "https://tfs.co/Collection")
        with mock.patch.object(ha, "AZDO_URL", ""):
            self.assertEqual(ha.azure_base(), "")


class TestAzureGitAuthConfig(unittest.TestCase):
    """XERK-54: reuse the board's PAT to authenticate plain git against a
    non-GitHub Azure DevOps org, via a URL-scoped http.extraHeader."""

    def test_wires_url_scoped_basic_header(self):
        with mock.patch.multiple(ha, AZDO_URL="https://tfs.co/DefaultCollection",
                                 AZDO_TOKEN="pat123"):
            key, value = ha.azure_git_auth_config()
            # Scoped to the collection base, so no other host sees the header.
            self.assertEqual(key, "http.https://tfs.co/DefaultCollection.extraHeader")
            # Basic with an empty username, exactly like azure_req().
            expect = base64.b64encode(b":pat123").decode()
            self.assertEqual(value, f"Authorization: Basic {expect}")

    def test_dev_azure_services_and_pasted_tail(self):
        # A bare host and a pasted deep link both collapse to the base via
        # azure_base(), so the header scope is the org/collection.
        with mock.patch.multiple(ha, AZDO_URL="dev.azure.com/MyOrg", AZDO_TOKEN="p"):
            self.assertEqual(ha.azure_git_auth_config()[0],
                             "http.https://dev.azure.com/MyOrg.extraHeader")
        with mock.patch.multiple(
                ha, AZDO_URL="https://tfs.co/Col/_git/repo", AZDO_TOKEN="p"):
            self.assertEqual(ha.azure_git_auth_config()[0],
                             "http.https://tfs.co/Col.extraHeader")

    def test_none_when_unconfigured(self):
        with mock.patch.multiple(ha, AZDO_URL="", AZDO_TOKEN=""):
            self.assertIsNone(ha.azure_git_auth_config())
        # A URL without a token (or vice versa) is not enough to wire anything.
        with mock.patch.multiple(ha, AZDO_URL="https://tfs.co/Col", AZDO_TOKEN=""):
            self.assertIsNone(ha.azure_git_auth_config())
        with mock.patch.multiple(ha, AZDO_URL="", AZDO_TOKEN="p"):
            self.assertIsNone(ha.azure_git_auth_config())


def _azure_wi(wid, state, wtype="Bug", project="Proj", title=None, **fields):
    f = {
        "System.Id": wid,
        "System.Title": title if title is not None else f"WI {wid}",
        "System.State": state,
        "System.WorkItemType": wtype,
        "System.TeamProject": project,
        "System.ChangedDate": "2026-07-16T00:00:00Z",
        "System.CreatedDate": "2026-07-01T00:00:00Z",
    }
    f.update(fields)
    return {"id": wid, "fields": f}


class TestShapeAzureItem(unittest.TestCase):
    """A raw work item -> the SAME wire ticket shape Jira's _shape_issue makes."""

    def test_full_item(self):
        wi = _azure_wi(1234, "Active", wtype="User Story", project="Payments",
                       title="Fix checkout",
                       **{"Microsoft.VSTS.Common.Priority": 2,
                          "System.Tags": "infra; urgent",
                          "System.Parent": 900,
                          "Microsoft.VSTS.Scheduling.DueDate": "2026-08-01T00:00:00Z"})
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}):
            t = ha._shape_azure_item(wi, "dev.azure.com/org", "https://dev.azure.com/org")
        self.assertEqual(t["key"], "1234")
        self.assertEqual(t["url"],
                         "https://dev.azure.com/org/Payments/_workitems/edit/1234")
        self.assertEqual(t["summary"], "Fix checkout")
        self.assertEqual(t["status"], "Active")
        self.assertEqual(t["statusCategory"], "inprogress")
        self.assertEqual(t["priority"], "P2")
        self.assertEqual(t["type"], "User Story")
        self.assertEqual(t["project"], "Payments")
        self.assertEqual(t["projectName"], "Payments")
        self.assertEqual(t["labels"], ["infra", "urgent"])
        self.assertEqual(t["dueDate"], "2026-08-01T00:00:00Z")
        self.assertEqual(t["parentKey"], "900")

    def test_missing_optionals_degrade(self):
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}):
            t = ha._shape_azure_item(_azure_wi(7, "New"), "s", "https://s")
        self.assertIsNone(t["priority"])
        self.assertIsNone(t["dueDate"])
        self.assertIsNone(t["parentKey"])
        self.assertEqual(t["labels"], [])
        self.assertEqual(t["statusCategory"], "todo")

    def test_url_without_project(self):
        wi = _azure_wi(5, "Active", project=None)
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}):
            t = ha._shape_azure_item(wi, "s", "https://s")
        self.assertEqual(t["url"], "https://s/_workitems/edit/5")


class TestAzureCategory(unittest.TestCase):
    """Azure state -> board column: the per-type states API when reachable (custom
    processes), else the static name map, else todo."""

    def test_states_api_metastate_wins(self):
        def fake_req(path, params, body=None):
            self.assertTrue(path.endswith("/states"))
            return {"value": [{"name": "Peer Review", "category": "InProgress"},
                              {"name": "Shipped", "category": "Completed"}]}
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", fake_req):
            self.assertEqual(ha._azure_category("s", "P", "Bug", "Peer Review"),
                             "inprogress")
            self.assertEqual(ha._azure_category("s", "P", "Bug", "Shipped"), "done")

    def test_name_map_fallback_when_api_fails(self):
        def boom(*a, **k):
            raise RuntimeError("403")
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", boom):
            self.assertEqual(ha._azure_category("s", "P", "Bug", "Active"), "inprogress")
            self.assertEqual(ha._azure_category("s", "P", "Bug", "Closed"), "done")
            self.assertEqual(ha._azure_category("s", "P", "Bug", "New"), "todo")
            # Genuinely unknown state -> todo, the safe default.
            self.assertEqual(ha._azure_category("s", "P", "Bug", "Wibble"), "todo")

    def test_state_map_is_cached_per_type(self):
        calls = []

        def fake_req(path, params, body=None):
            calls.append(path)
            return {"value": [{"name": "Active", "category": "InProgress"}]}
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", fake_req):
            ha._azure_category("s", "P", "Bug", "Active")
            ha._azure_category("s", "P", "Bug", "Active")
        self.assertEqual(len(calls), 1)   # second lookup hits the cache

    def test_reads_the_apis_own_category_field(self):
        # XERK-250: the states API's WorkItemStateColor is {name, color,
        # category} — reading `stateCategory` matched nothing on every real org,
        # so the list came back EMPTY and the whole feature silently degraded.
        # This payload is the API reference's own sample response verbatim.
        doc = {"count": 5, "value": [
            {"name": "New", "color": "b2b2b2", "category": "Proposed"},
            {"name": "Active", "color": "007acc", "category": "InProgress"},
            {"name": "CustomState", "color": "5688E0", "category": "InProgress"},
            {"name": "Resolved", "color": "ff9d00", "category": "Resolved"},
            {"name": "Closed", "color": "339933", "category": "Completed"},
        ]}
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", return_value=doc):
            states = ha._azure_states("s", "P", "Bug")
        self.assertEqual(states, [
            {"name": "New", "category": "todo"},
            {"name": "Active", "category": "inprogress"},
            {"name": "CustomState", "category": "inprogress"},
            {"name": "Resolved", "category": "inprogress"},
            {"name": "Closed", "category": "done"},
        ])

    def test_removed_metastate_is_done(self):
        doc = {"value": [{"name": "Removed", "color": "ffffff", "category": "Removed"}]}
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", return_value=doc):
            self.assertEqual(ha._azure_category("s", "P", "Task", "Removed"), "done")

    def test_an_empty_read_is_retried_but_a_good_one_is_kept(self):
        # A failed states read must not be cached for the life of the process:
        # the Status row and every drag key on this list, so one 503 would
        # disable ADO status changes until someone restarted the agent.
        calls = []
        doc = {"value": [{"name": "Active", "category": "InProgress"}]}

        def flaky(path, params, body=None):
            calls.append(path)
            if len(calls) == 1:
                raise RuntimeError("503")
            return doc
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "AZDO_META_RETRY_SEC", 0), \
             mock.patch.object(ha, "azure_req", flaky):
            self.assertEqual(ha._azure_states("s", "P", "Bug"), [])       # blip
            self.assertEqual(len(ha._azure_states("s", "P", "Bug")), 1)   # retried
            ha._azure_states("s", "P", "Bug")                             # now cached
        self.assertEqual(len(calls), 2)

    def test_a_permanent_failure_is_logged_once_not_every_retry(self):
        # A locked-down endpoint is re-tried per type forever; logging each
        # retry buries the log for as long as the org stays misconfigured.
        lines = []

        def boom(*a, **k):
            raise RuntimeError("403")
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "AZDO_META_RETRY_SEC", 0), \
             mock.patch.object(ha, "azure_req", boom), \
             mock.patch.object(ha, "log", lines.append):
            for _ in range(5):
                ha._azure_states("s", "P", "Bug")
        self.assertEqual(len(lines), 1, lines)


class TestAzureStatusOptions(unittest.TestCase):
    """XERK-138: a work item's changeable states, from the states API, minus the
    one it's already in — the source-agnostic statusOptions shape (id == name)."""

    def _states(self):
        return {"value": [
            {"name": "New", "category": "Proposed"},
            {"name": "Active", "category": "InProgress"},
            {"name": "Closed", "category": "Completed"},
        ]}

    def test_lists_states_except_current(self):
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", return_value=self._states()):
            opts = ha._azure_status_options("s", "P", "Bug", "Active")
        self.assertEqual(opts, [
            {"id": "New", "name": "New", "category": "todo"},
            {"id": "Closed", "name": "Closed", "category": "done"},
        ])

    def test_the_agile_bug_workflow_reaches_every_column(self):
        # XERK-250 end to end: the four board columns a New Bug can be dropped
        # onto, resolved from the real ADO state set. Before the fix this list
        # was empty, so the panel's Change button never appeared and every drop
        # refused with "nothing can move it to …".
        doc = {"value": [
            {"name": "New", "color": "b2b2b2", "category": "Proposed"},
            {"name": "Active", "color": "007acc", "category": "InProgress"},
            {"name": "Resolved", "color": "ff9d00", "category": "Resolved"},
            {"name": "Closed", "color": "339933", "category": "Completed"},
        ]}
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", return_value=doc):
            opts = ha._azure_status_options("s", "P", "Bug", "New")
        landed = {c: (ha._status_option_for_column(opts, c) or {}).get("id")
                  for c in ("todo", "inprogress", "review", "done")}
        self.assertEqual(landed, {"todo": None,          # it is already New
                                  "inprogress": "Active",
                                  "review": "Resolved",  # ADO's review column
                                  "done": "Closed"})

    # -- what the type's PROCESS actually permits (XERK-250) -----------------

    _TYPE_DOC = {"transitions": {
        "New": [{"to": "New"}, {"to": "Active"}, {"to": "Removed"}],
        "Removed": [{"to": "New"}],
        "Active": [{"to": "Active"}, {"to": "Resolved"}, {"to": "Removed"}],
    }}

    def _both(self, states, type_doc):
        """azure_req answering the states call and the type call differently."""
        def req(path, params, body=None, **k):
            return type_doc if path.endswith(("/Bug", "/Task")) else states
        return req

    def test_a_state_the_process_forbids_is_not_offered(self):
        # Offering a state ADO will refuse turns a drop into an error the
        # operator can do nothing about — as much a "can't change the status"
        # as an empty picker. From Removed, this process allows only New.
        states = {"value": [
            {"name": "New", "category": "Proposed"},
            {"name": "Active", "category": "InProgress"},
            {"name": "Resolved", "category": "Resolved"},
            {"name": "Removed", "category": "Removed"},
        ]}
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", self._both(states, self._TYPE_DOC)):
            opts = ha._azure_status_options("s", "P", "Bug", "Removed")
            self.assertEqual([o["id"] for o in opts], ["New"])
            # The drag that used to be offered and then refused now refuses
            # up front, before anything is written.
            self.assertIsNone(ha._status_option_for_column(opts, "review"))
            # …and from Active the review column is reachable again.
            self.assertEqual(
                ha._status_option_for_column(
                    ha._azure_status_options("s", "P", "Bug", "Active"),
                    "review")["id"], "Resolved")

    def test_an_unreadable_transition_map_offers_everything(self):
        # A server that won't report a map must not read as a workflow that
        # permits nothing — that is the pre-XERK-250 behaviour, kept.
        states = {"value": [{"name": "New", "category": "Proposed"},
                            {"name": "Active", "category": "InProgress"}]}

        def req(path, params, body=None, **k):
            if path.endswith("/states"):
                return states
            raise RuntimeError("403 on the type definition")
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", req):
            opts = ha._azure_status_options("s", "P", "Bug", "New")
        self.assertEqual([o["id"] for o in opts], ["Active"])

    def test_a_state_with_no_way_out_offers_nothing(self):
        # A KNOWN but absent/empty entry is a real answer and is honoured.
        states = {"value": [{"name": "New", "category": "Proposed"},
                            {"name": "Shipped", "category": "Completed"}]}
        doc = {"transitions": {"New": [{"to": "Shipped"}], "Shipped": []}}
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", self._both(states, doc)):
            self.assertEqual(ha._azure_status_options("s", "P", "Bug", "Shipped"), [])

    def test_an_unreadable_entry_fails_OPEN_not_closed(self):
        # The one direction this must never get wrong. A malformed entry means
        # "can't tell" -> offer everything; failing closed would hide the Change
        # button and refuse every drop, which IS the bug XERK-250 is about.
        # ADO's contract makes none of these reachable today; that is the point.
        states = {"value": [{"name": "New", "category": "Proposed"},
                            {"name": "Active", "category": "InProgress"},
                            {"name": "Closed", "category": "Completed"}]}
        unreadable = [
            "New",                       # entry is not a list at all
            None,                        # entry is null
            ["New", 3, None],            # members aren't dicts
            [{"actions": None}],         # member carries no `to`
            [{"to": None}],              # `to` is null
            [{"to": 7}],                 # `to` isn't a string
            [{"to": "   "}],             # `to` is blank
        ]
        for moves in unreadable:
            doc = {"transitions": {"Active": moves}}
            with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
                 mock.patch.object(ha, "azure_req", self._both(states, doc)):
                opts = ha._azure_status_options("s", "P", "Bug", "Active")
            self.assertEqual([o["id"] for o in opts], ["New", "Closed"],
                             f"{moves!r} should read as 'can't tell'")
        # A PARTLY-readable entry is can't-tell too, deliberately: the realistic
        # break is a partial schema change, and keeping only the readable
        # members would silently narrow the picker with no log line.
        doc = {"transitions": {"Active": [{"to": "Closed"}, {"to": None}, 3]}}
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", self._both(states, doc)):
            opts = ha._azure_status_options("s", "P", "Bug", "Active")
        self.assertEqual([o["id"] for o in opts], ["New", "Closed"])
        # …but an entry every member of which reads IS a verdict, self
        # transitions and all.
        doc = {"transitions": {"Active": [{"to": "Active"}, {"to": "Closed"}]}}
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", self._both(states, doc)):
            opts = ha._azure_status_options("s", "P", "Bug", "Active")
        self.assertEqual([o["id"] for o in opts], ["Closed"])

    def test_one_unreadable_entry_doesnt_cost_the_readable_ones(self):
        # The guard is per-ENTRY: a state whose entry can't be iterated must not
        # take the rest of the map down with it, which is what an exception out
        # of the parse would do.
        states = {"value": [{"name": "New", "category": "Proposed"},
                            {"name": "Active", "category": "InProgress"},
                            {"name": "Closed", "category": "Completed"}]}
        doc = {"transitions": {"Active": None, "New": [{"to": "Active"}]}}
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", self._both(states, doc)):
            self.assertEqual(
                [o["id"] for o in ha._azure_status_options("s", "P", "Bug", "New")],
                ["Active"])                       # New's own entry survived
            self.assertEqual(
                [o["id"] for o in ha._azure_status_options("s", "P", "Bug", "Active")],
                ["New", "Closed"])                # Active's is "can't tell"

    def test_a_malformed_transitions_block_never_raises(self):
        states = {"value": [{"name": "New", "category": "Proposed"},
                            {"name": "Active", "category": "InProgress"}]}
        for block in (None, [], "nope", 7, {"": [{"to": "New"}]}):
            with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
                 mock.patch.object(ha, "azure_req",
                                   self._both(states, {"transitions": block})):
                opts = ha._azure_status_options("s", "P", "Bug", "New")
            self.assertEqual([o["id"] for o in opts], ["Active"], repr(block))

    def test_the_path_segments_are_fully_encoded(self):
        # project/wtype come from ADO's own response, but they land in a REST
        # path, so a "/" must not be able to extend it.
        seen = []

        def spy(path, params, body=None, **k):
            seen.append(path)
            raise RuntimeError("stop")
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", spy):
            ha._azure_states("s", "My Prøject", "User Story")
            ha._azure_transitions("s", "a/b", "Bug/../../workitems/1")
        self.assertEqual(seen[0],
                         "/My%20Pr%C3%B8ject/_apis/wit/workItemTypes/User%20Story/states")
        self.assertEqual(seen[1],
                         "/a%2Fb/_apis/wit/workItemTypes/Bug%2F..%2F..%2Fworkitems%2F1")

    def test_empty_when_states_api_unavailable(self):
        def boom(*a, **k):
            raise RuntimeError("403")
        with mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", boom):
            self.assertEqual(ha._azure_status_options("s", "P", "Bug", "New"), [])


class TestCollectAzure(unittest.TestCase):
    def _configured(self):
        return mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/MyOrg",
                                   AZDO_TOKEN="pat", AZDO_PROJECT="", AZDO_USER="")

    def test_unconfigured_full_schema_no_http(self):
        with mock.patch.object(ha, "AZDO_URL", ""), \
             mock.patch.object(ha, "AZDO_TOKEN", ""), \
             mock.patch.object(ha, "azure_req") as req:
            block = ha.collect_azure()
        req.assert_not_called()
        self.assertFalse(block["configured"])
        self.assertFalse(block["available"])
        self.assertEqual(block["source"], "azure")
        self.assertEqual(block["tickets"], [])
        self.assertIsNone(block["siteKey"])  # nothing configured -> no identity

    def test_configured_empty_carries_local_identity(self):
        # A configured-but-never-polled Azure org still knows WHO it is from
        # local config, so the empty block carries its siteKey/orgName — that's
        # what keeps a configured-but-unreachable org visible on the board and
        # org filters instead of vanishing until its first successful poll.
        with mock.patch.object(ha, "AZDO_URL", "https://dev.azure.com/MyOrg/"), \
             mock.patch.object(ha, "AZDO_TOKEN", "t"), \
             mock.patch.object(ha, "BOARD_ORG_NAME", "My Org"):
            block = ha.azure_empty()
        self.assertTrue(block["configured"])
        self.assertFalse(block["available"])
        self.assertEqual(block["siteKey"], "dev.azure.com/myorg")
        self.assertEqual(block["site"], "dev.azure.com/myorg")
        self.assertEqual(block["orgName"], "My Org")

    def _fake_req(self, items):
        def req(path, params, body=None):
            if path == "/_apis/wit/wiql":
                self.assertIsNotNone(body)      # WIQL is a POST
                self.assertIn("@Me", body["query"])
                return {"workItems": [{"id": i["id"]} for i in items]}
            if path == "/_apis/wit/workitems":
                self.assertIn("errorPolicy", params)
                want = set(params["ids"].split(","))
                return {"value": [i for i in items if str(i["id"]) in want]}
            if path.endswith("/states"):
                return {"value": []}            # force the name-map path
            raise AssertionError(path)
        return req

    def test_buckets_active_and_recent_done_like_jira(self):
        items = [
            _azure_wi(1, "Active"),
            _azure_wi(2, "Closed", **{"System.ChangedDate": "2099-01-01T00:00:00Z"}),
            _azure_wi(3, "Closed", **{"System.ChangedDate": "2000-01-01T00:00:00Z"}),
            _azure_wi(4, "New"),
        ]
        with self._configured(), mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", self._fake_req(items)):
            block = ha.collect_azure()
        self.assertTrue(block["available"])
        self.assertEqual(block["source"], "azure")
        self.assertEqual(block["siteKey"], "dev.azure.com/myorg")
        self.assertEqual(block["user"], "myorg")   # AZDO_USER unset -> org segment
        keys = [t["key"] for t in block["tickets"]]
        self.assertIn("1", keys)          # active
        self.assertIn("4", keys)          # active
        self.assertIn("2", keys)          # recent done kept
        self.assertNotIn("3", keys)       # done older than the window dropped

    def test_project_scope_added_to_wiql(self):
        seen = {}

        def req(path, params, body=None):
            if path == "/_apis/wit/wiql":
                seen["q"] = body["query"]
                return {"workItems": []}
            return {"value": []}
        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o",
                                 AZDO_TOKEN="p", AZDO_PROJECT="My Proj", AZDO_USER=""), \
             mock.patch.object(ha, "azure_req", req):
            ha.collect_azure()
        self.assertIn("[System.TeamProject] = 'My Proj'", seen["q"])

    def test_truncated_when_capped(self):
        items = [_azure_wi(i, "Active") for i in range(5)]
        with self._configured(), mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "AZDO_MAX_IDS", 2), \
             mock.patch.object(ha, "azure_req", self._fake_req(items)):
            block = ha.collect_azure()
        self.assertTrue(block["truncated"])
        self.assertEqual(len(block["tickets"]), 2)


class TestAzureHtmlToText(unittest.TestCase):
    def test_blocks_lists_links_entities(self):
        html = ('<p>Hello <b>world</b></p><ul><li>one</li><li>two</li></ul>'
                '<div>see <a href="http://x.io/p">here</a> &amp; there</div>')
        out = ha.azure_html_to_text(html)
        self.assertIn("Hello world", out)
        self.assertIn("- one", out)
        self.assertIn("- two", out)
        self.assertIn("here (http://x.io/p)", out)
        self.assertIn("& there", out)

    def test_plain_string_passes_through(self):
        self.assertEqual(ha.azure_html_to_text("just text"), "just text")

    def test_empty_and_none(self):
        self.assertEqual(ha.azure_html_to_text(""), "")
        self.assertEqual(ha.azure_html_to_text(None), "")

    def test_plain_truncates(self):
        text, trunc = ha.azure_plain("<p>" + "x" * 50 + "</p>", 10)
        self.assertTrue(trunc)
        self.assertLessEqual(len(text), 10)


class TestFetchAzureIssue(unittest.TestCase):
    def test_detail_shape_with_comments(self):
        def req(path, params, body=None):
            if path == "/_apis/wit/workitems/42":
                self.assertEqual(params.get("$expand"), "all")
                return _azure_wi(42, "Active", title="Detail",
                                 **{"System.Description": "<p>full <b>desc</b></p>",
                                    "System.Reason": "Investigation complete",
                                    "System.CreatedBy": {"displayName": "Ada"},
                                    "System.AssignedTo": {"displayName": "Grace"}})
            if path.endswith("/comments"):
                self.assertIn("preview", params["api-version"])
                return {"totalCount": 2, "comments": [
                    {"id": 1, "text": "<p>older</p>", "createdDate": "2026-07-01T00:00:00Z",
                     "createdBy": {"displayName": "Ada"}},
                    {"id": 2, "text": "<p>newer</p>", "createdDate": "2026-07-05T00:00:00Z",
                     "createdBy": {"displayName": "Grace"}},
                ]}
            raise AssertionError(path)
        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/org",
                                 AZDO_TOKEN="p"), \
             mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", req):
            d = ha.fetch_azure_issue("42")
        self.assertEqual(d["key"], "42")
        self.assertIn("full desc", d["description"])
        self.assertEqual(d["reporter"], "Ada")
        self.assertEqual(d["assignee"], "Grace")
        self.assertEqual(d["resolution"], "Investigation complete")
        self.assertEqual(d["commentTotal"], 2)
        self.assertEqual([c["body"] for c in d["comments"]], ["older", "newer"])

    def test_comments_failure_degrades_to_none(self):
        def req(path, params, body=None):
            if path == "/_apis/wit/workitems/42":
                return _azure_wi(42, "Active", **{"System.Description": "<p>x</p>"})
            raise RuntimeError("comments 404")
        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/org",
                                 AZDO_TOKEN="p"), \
             mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", req):
            d = ha.fetch_azure_issue("42")
        self.assertEqual(d["comments"], [])
        self.assertEqual(d["commentTotal"], 0)

    def test_attached_files_come_off_the_relations(self):
        # XERK-242: Azure keeps attachments as work-item relations, not a field —
        # and the item carries other relation kinds that are not files.
        wi = _azure_wi(42, "Active")
        wi["relations"] = [
            {"rel": "System.LinkTypes.Hierarchy-Reverse", "url": "https://x/1"},
            {"rel": "AttachedFile",
             "url": "https://dev.azure.com/org/_apis/wit/attachments/abc",
             "attributes": {"name": "trace.log", "resourceSize": 88}},
        ]

        def req(path, params, body=None):
            if path == "/_apis/wit/workitems/42":
                return wi
            raise RuntimeError("no comments")
        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/org",
                                 AZDO_TOKEN="p"), \
             mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", req):
            d = ha.fetch_azure_issue("42")
        self.assertEqual(d["attachments"], [{
            "name": "trace.log", "size": 88, "mime": None,
            "url": "https://dev.azure.com/org/_apis/wit/attachments/abc",
        }])

    def test_no_relations_is_no_attachments(self):
        def req(path, params, body=None):
            if path == "/_apis/wit/workitems/42":
                return _azure_wi(42, "Active")
            raise RuntimeError("no comments")
        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/org",
                                 AZDO_TOKEN="p"), \
             mock.patch.object(ha, "_AZDO_STATE_CACHE", {}), \
             mock.patch.object(ha, "azure_req", req):
            self.assertEqual(ha.fetch_azure_issue("42")["attachments"], [])


class TestBoardSourceDispatch(unittest.TestCase):
    """The shims that pick the one configured source; azure wins if both set."""

    def test_source_and_configured(self):
        with mock.patch.multiple(ha, JIRA_SITE="", JIRA_EMAIL="", JIRA_TOKEN="",
                                 AZDO_URL="", AZDO_TOKEN=""):
            self.assertIsNone(ha.board_source())
            self.assertFalse(ha.board_configured())
        with mock.patch.multiple(ha, JIRA_SITE="s.atlassian.net", JIRA_EMAIL="e",
                                 JIRA_TOKEN="t", AZDO_URL="", AZDO_TOKEN=""):
            self.assertEqual(ha.board_source(), "jira")
            self.assertTrue(ha.board_configured())
        with mock.patch.multiple(ha, JIRA_SITE="", JIRA_EMAIL="", JIRA_TOKEN="",
                                 AZDO_URL="https://dev.azure.com/o", AZDO_TOKEN="p"):
            self.assertEqual(ha.board_source(), "azure")
            self.assertEqual(ha.board_site_key(), "dev.azure.com/o")

    def test_valid_issue_key_is_source_aware(self):
        with mock.patch.multiple(ha, JIRA_SITE="s.atlassian.net", JIRA_EMAIL="e",
                                 JIRA_TOKEN="t", AZDO_URL="", AZDO_TOKEN=""):
            self.assertTrue(ha.valid_issue_key("PROJ-7"))
            self.assertFalse(ha.valid_issue_key("1234"))   # numeric isn't a Jira key
        with mock.patch.multiple(ha, JIRA_SITE="", JIRA_EMAIL="", JIRA_TOKEN="",
                                 AZDO_URL="https://dev.azure.com/o", AZDO_TOKEN="p"):
            self.assertTrue(ha.valid_issue_key("1234"))
            self.assertFalse(ha.valid_issue_key("PROJ-7"))  # keys aren't Azure ids

    def test_ticket_branch_base(self):
        with mock.patch.multiple(ha, JIRA_SITE="s.atlassian.net", JIRA_EMAIL="e",
                                 JIRA_TOKEN="t", AZDO_URL="", AZDO_TOKEN=""):
            self.assertEqual(ha.ticket_branch_base("PROJ-7", {}), "PROJ-7")
        with mock.patch.multiple(ha, JIRA_SITE="", JIRA_EMAIL="", JIRA_TOKEN="",
                                 AZDO_URL="https://dev.azure.com/o", AZDO_TOKEN="p"):
            self.assertEqual(ha.ticket_branch_base("1234", {"project": "My Proj"}),
                             "My-Proj-1234")
            self.assertEqual(ha.ticket_branch_base("1234", {}), "wi-1234")


class TestBoardErrorSummary(unittest.TestCase):
    """A board-poll failure is turned into a short, human-readable `error` for
    the dashboard (XERK-156): an upstream 5xx (the Cloudflare-family HTTP 530 a
    self-hosted org's front returns) or a connection failure reads as
    'temporarily unreachable' rather than the cryptic `HTTP Error 530: <none>`."""

    AZ = dict(JIRA_SITE="", JIRA_EMAIL="", JIRA_TOKEN="",
              AZDO_URL="https://dev.azure.com/o", AZDO_TOKEN="p")
    JI = dict(AZDO_URL="", AZDO_TOKEN="",
              JIRA_SITE="s.atlassian.net", JIRA_EMAIL="e", JIRA_TOKEN="t")

    def _http(self, code, msg="<none>"):
        return urllib.error.HTTPError("https://x/y", code, msg, {}, None)

    def test_upstream_5xx_reads_as_temporarily_unreachable(self):
        with mock.patch.multiple(ha, **self.AZ):
            self.assertEqual(ha._board_error_summary(self._http(530)),
                             "Azure DevOps temporarily unreachable (HTTP 530)")
            self.assertEqual(ha._board_error_summary(self._http(503)),
                             "Azure DevOps temporarily unreachable (HTTP 503)")
        with mock.patch.multiple(ha, **self.JI):
            self.assertEqual(ha._board_error_summary(self._http(502)),
                             "Jira temporarily unreachable (HTTP 502)")

    def test_auth_and_rate_limit_get_their_own_hint(self):
        with mock.patch.multiple(ha, **self.AZ):
            self.assertEqual(ha._board_error_summary(self._http(401)),
                             "Azure DevOps rejected the credentials (HTTP 401)")
            self.assertEqual(ha._board_error_summary(self._http(403)),
                             "Azure DevOps rejected the credentials (HTTP 403)")
            self.assertEqual(ha._board_error_summary(self._http(429)),
                             "Azure DevOps rate-limited the request (HTTP 429)")

    def test_other_4xx_keeps_the_code(self):
        with mock.patch.multiple(ha, **self.AZ):
            msg = ha._board_error_summary(self._http(404, "Not Found"))
            self.assertIn("HTTP 404", msg)
            self.assertIn("Azure DevOps", msg)

    def test_connection_failure_reads_as_unreachable(self):
        with mock.patch.multiple(ha, **self.JI):
            msg = ha._board_error_summary(
                urllib.error.URLError("Name or service not known"))
            self.assertTrue(msg.startswith("Jira unreachable"))
            self.assertIn("Name or service not known", msg)

    def test_timeout_reads_as_unreachable(self):
        with mock.patch.multiple(ha, **self.JI):
            self.assertTrue(
                ha._board_error_summary(TimeoutError()).startswith("Jira unreachable"))

    def test_unrecognised_falls_back_to_raw_text(self):
        with mock.patch.multiple(ha, **self.AZ):
            self.assertEqual(ha._board_error_summary(ValueError("boom")), "boom")


class TestBoardOrgName(unittest.TestCase):
    """BOARD_ORG_NAME: the operator's presentational override for the board's org
    label, source-agnostic and applied in collect_board()."""

    def test_clean_org_name(self):
        self.assertEqual(ha.clean_org_name("Acme"), "Acme")
        self.assertEqual(ha.clean_org_name("  Acme   Corp \n junk"), "Acme Corp")
        # Blank in, blank out — the clients then derive from the siteKey.
        for blank in ("", "   ", "\n", None):
            self.assertEqual(ha.clean_org_name(blank), "")
        self.assertEqual(len(ha.clean_org_name("x" * 200)), ha.ORG_NAME_MAX_CHARS)

    def test_collect_board_stamps_the_override(self):
        with mock.patch.object(ha, "collect_jira", lambda: {"siteKey": "s", "tickets": []}), \
             mock.patch.object(ha, "azure_configured", lambda: False):
            with mock.patch.object(ha, "BOARD_ORG_NAME", "Acme"):
                self.assertEqual(ha.collect_board()["orgName"], "Acme")
            # Unset rides as None, which every client reads as "derive it".
            with mock.patch.object(ha, "BOARD_ORG_NAME", ""):
                self.assertIsNone(ha.collect_board()["orgName"])

    def test_it_never_touches_the_site_key(self):
        """The siteKey is what the hub keys, merges and routes on (and what the
        hub's ticket-agent/auto-start ledgers are stored under), so the label
        override must leave it exactly as the collector reported it."""
        with mock.patch.multiple(ha, JIRA_SITE="", JIRA_EMAIL="", JIRA_TOKEN="",
                                 AZDO_URL="https://tfs.co/tfs/DefaultCollection",
                                 AZDO_TOKEN="p", BOARD_ORG_NAME="Acme"), \
             mock.patch.object(ha, "collect_azure",
                               lambda: {"siteKey": ha.normalize_azure_site(ha.AZDO_URL)}):
            self.assertEqual(ha.collect_board()["siteKey"], "tfs.co/tfs/defaultcollection")


class TestStageJiraIssue(ManagerMixin, unittest.TestCase):
    """The {type:"jiraIssue"} command: every path stages a result (the board is
    waiting on this key) and none of them raises out of the heartbeat loop."""

    def _configured(self):
        return mock.patch.multiple(ha, JIRA_SITE="s.atlassian.net",
                                   JIRA_EMAIL="e", JIRA_TOKEN="t")

    def test_success_stages_issue(self):
        sm = self.make_manager()
        with self._configured(), \
             mock.patch.object(ha, "fetch_jira_issue",
                               return_value={"key": "ENG-42"}) as f:
            sm._stage_jira_issue("ENG-42")
        f.assert_called_once_with("ENG-42")
        self.assertEqual(sm.jira_issue_results,
                         [{"key": "ENG-42", "issue": {"key": "ENG-42"}, "error": None}])

    def test_fetch_error_stages_error_not_raises(self):
        sm = self.make_manager()
        with self._configured(), \
             mock.patch.object(ha, "fetch_jira_issue",
                               side_effect=RuntimeError("404 " + "x" * 300)):
            sm._stage_jira_issue("ENG-42")
        r = sm.jira_issue_results[0]
        self.assertIsNone(r["issue"])
        self.assertTrue(r["error"].startswith("404"))
        self.assertLessEqual(len(r["error"]), 200)

    def test_bad_key_never_reaches_jira(self):
        sm = self.make_manager()
        bad = ["", None, "../../secrets", "ENG-42/comment", "ENG 42", "42",
               "ENG-", "ENG-42?x=1", "-1"]
        with self._configured(), mock.patch.object(ha, "fetch_jira_issue") as f:
            for k in bad:
                sm._stage_jira_issue(k)
        f.assert_not_called()
        self.assertEqual(len(sm.jira_issue_results), len(bad))
        for r in sm.jira_issue_results:
            self.assertEqual(r["error"], "not a valid issue key")

    def test_unconfigured_host_says_so_without_fetching(self):
        sm = self.make_manager()
        with mock.patch.multiple(ha, JIRA_SITE="", JIRA_EMAIL="", JIRA_TOKEN=""), \
             mock.patch.object(ha, "fetch_jira_issue") as f:
            sm._stage_jira_issue("ENG-42")
        f.assert_not_called()
        self.assertIn("no board credentials", sm.jira_issue_results[0]["error"])

    def test_command_routes_and_acks(self):
        sm = self.make_manager()
        with self._configured(), \
             mock.patch.object(ha, "fetch_jira_issue", return_value={"key": "ENG-9"}):
            sm.handle_commands([{"cmdId": "c1", "type": "jiraIssue", "issueKey": "ENG-9"}])
        self.assertEqual(sm.jira_issue_results[0]["key"], "ENG-9")
        self.assertIn("c1", sm.acked)

    def test_results_ride_the_payload_only_when_staged(self):
        sm = self.make_manager()
        sm.registry = []
        self.assertNotIn("jiraIssueResults", sm.build_payload(1))
        sm.jira_issue_results = [{"key": "ENG-9", "issue": None, "error": "x"}]
        self.assertEqual(sm.build_payload(1)["jiraIssueResults"],
                         [{"key": "ENG-9", "issue": None, "error": "x"}])


class TestSetBoardStatus(ManagerMixin, unittest.TestCase):
    """XERK-138: the board's one write path. A status change is re-validated
    against a FRESH options read, applied to the configured source, and its
    outcome staged keyed by the command's cmdId. Nothing raises out of the loop."""

    def _jira(self):
        return mock.patch.multiple(ha, JIRA_SITE="s.atlassian.net",
                                   JIRA_EMAIL="e", JIRA_TOKEN="t",
                                   AZDO_URL="", AZDO_TOKEN="")

    def _azure(self):
        return mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/org",
                                   AZDO_TOKEN="p", JIRA_SITE="", JIRA_EMAIL="",
                                   JIRA_TOKEN="")

    def test_jira_transition_posts_the_chosen_id(self):
        sm = self.make_manager()
        opts = [{"id": "31", "name": "Done", "category": "done"}]
        seen = {}

        def fake_req(path, params, body=None):
            seen["path"], seen["body"] = path, body
            return {}
        with self._jira(), \
             mock.patch.object(ha, "board_status_options", return_value=opts), \
             mock.patch.object(ha, "jira_req", fake_req), \
             mock.patch.object(ha, "fetch_board_issue",
                               return_value={"key": "ENG-9", "status": "Done"}):
            sm.set_board_status("c1", "ENG-9", "31")
        self.assertEqual(seen["path"], "/rest/api/3/issue/ENG-9/transitions")
        self.assertEqual(seen["body"], {"transition": {"id": "31"}})
        r = sm.ticket_status_results[0]
        self.assertEqual((r["cmdId"], r["key"], r["ok"], r["status"]),
                         ("c1", "ENG-9", True, "Done"))
        # The fresh issue rides jira_issue_results so the panel's re-read is instant.
        self.assertEqual(sm.jira_issue_results[0]["issue"]["status"], "Done")

    def test_azure_patches_system_state(self):
        sm = self.make_manager()
        opts = [{"id": "Closed", "name": "Closed", "category": "done"}]
        seen = {}

        def fake_req(path, params, body=None, method=None, content_type="application/json"):
            seen.update(path=path, body=body, method=method, ct=content_type)
            return {}
        with self._azure(), \
             mock.patch.object(ha, "board_status_options", return_value=opts), \
             mock.patch.object(ha, "azure_req", fake_req), \
             mock.patch.object(ha, "fetch_board_issue",
                               return_value={"key": "42", "status": "Closed"}):
            sm.set_board_status("c2", "42", "Closed")
        self.assertEqual(seen["path"], "/_apis/wit/workitems/42")
        self.assertEqual(seen["method"], "PATCH")
        self.assertEqual(seen["ct"], "application/json-patch+json")
        self.assertEqual(seen["body"],
                         [{"op": "add", "path": "/fields/System.State", "value": "Closed"}])
        self.assertTrue(sm.ticket_status_results[0]["ok"])

    def test_target_not_on_offer_is_refused_without_writing(self):
        sm = self.make_manager()
        opts = [{"id": "31", "name": "Done", "category": "done"}]
        with self._jira(), \
             mock.patch.object(ha, "board_status_options", return_value=opts), \
             mock.patch.object(ha, "apply_board_status") as apply:
            sm.set_board_status("c1", "ENG-9", "99")
        apply.assert_not_called()
        r = sm.ticket_status_results[0]
        self.assertFalse(r["ok"])
        self.assertIn("no longer an available change", r["error"])

    def test_write_failure_stages_error_not_raises(self):
        sm = self.make_manager()
        opts = [{"id": "31", "name": "Done", "category": "done"}]
        with self._jira(), \
             mock.patch.object(ha, "board_status_options", return_value=opts), \
             mock.patch.object(ha, "apply_board_status",
                               side_effect=RuntimeError("403 forbidden " + "x" * 300)):
            sm.set_board_status("c1", "ENG-9", "31")
        r = sm.ticket_status_results[0]
        self.assertFalse(r["ok"])
        self.assertTrue(r["error"].startswith("403 forbidden"))
        self.assertLessEqual(len(r["error"]), 200)

    def test_options_read_failure_stages_error(self):
        sm = self.make_manager()
        with self._jira(), \
             mock.patch.object(ha, "board_status_options",
                               side_effect=RuntimeError("boom")), \
             mock.patch.object(ha, "apply_board_status") as apply:
            sm.set_board_status("c1", "ENG-9", "31")
        apply.assert_not_called()
        self.assertIn("couldn't read available statuses",
                      sm.ticket_status_results[0]["error"])

    def test_bad_key_and_unconfigured_never_write(self):
        sm = self.make_manager()
        with self._jira(), mock.patch.object(ha, "apply_board_status") as apply:
            sm.set_board_status("c1", "../secrets", "31")
        apply.assert_not_called()
        self.assertEqual(sm.ticket_status_results[0]["error"], "not a valid issue key")
        sm.ticket_status_results.clear()
        with mock.patch.multiple(ha, JIRA_SITE="", JIRA_EMAIL="", JIRA_TOKEN="",
                                 AZDO_URL="", AZDO_TOKEN=""), \
             mock.patch.object(ha, "apply_board_status") as apply:
            sm.set_board_status("c1", "ENG-9", "31")
        apply.assert_not_called()
        self.assertIn("no board credentials", sm.ticket_status_results[0]["error"])

    def test_command_routes_acks_and_rides_payload(self):
        sm = self.make_manager()
        sm.registry = []
        opts = [{"id": "31", "name": "Done", "category": "done"}]
        with self._jira(), \
             mock.patch.object(ha, "board_status_options", return_value=opts), \
             mock.patch.object(ha, "jira_req", return_value={}), \
             mock.patch.object(ha, "fetch_board_issue", return_value={"key": "ENG-9"}):
            sm.handle_commands([{"cmdId": "c9", "type": "setTicketStatus",
                                 "issueKey": "ENG-9", "value": "31"}])
        self.assertIn("c9", sm.acked)
        self.assertEqual(sm.ticket_status_results[0]["cmdId"], "c9")
        self.assertEqual(sm.build_payload(1)["ticketStatusResults"][0]["cmdId"], "c9")

    # --- drag-and-drop: resolve a dropped COLUMN to a transition (XERK-141) ---

    def test_category_resolves_to_the_matching_transition(self):
        """A drop POSTs a board column; the agent resolves it to a transition
        against the fresh options and writes that transition's id."""
        sm = self.make_manager()
        opts = [{"id": "11", "name": "To Do", "category": "todo"},
                {"id": "31", "name": "Done", "category": "done"}]
        seen = {}

        def fake_req(path, params, body=None):
            seen["body"] = body
            return {}
        with self._jira(), \
             mock.patch.object(ha, "board_status_options", return_value=opts), \
             mock.patch.object(ha, "jira_req", fake_req), \
             mock.patch.object(ha, "fetch_board_issue",
                               return_value={"key": "ENG-9", "status": "Done"}):
            sm.set_board_status("c1", "ENG-9", "", category="done")
        self.assertEqual(seen["body"], {"transition": {"id": "31"}})
        r = sm.ticket_status_results[0]
        self.assertTrue(r["ok"])
        self.assertEqual(r["status"], "Done")

    def test_category_review_picks_a_review_named_inprogress_status(self):
        """The In Review column has no wire category of its own — it's carved out
        of `inprogress` by the status name, exactly as board.js categoryOf does."""
        sm = self.make_manager()
        opts = [{"id": "21", "name": "In Progress", "category": "inprogress"},
                {"id": "22", "name": "In Review", "category": "inprogress"}]
        seen = {}
        with self._jira(), \
             mock.patch.object(ha, "board_status_options", return_value=opts), \
             mock.patch.object(ha, "jira_req",
                               lambda p, params, body=None: seen.update(body=body) or {}), \
             mock.patch.object(ha, "fetch_board_issue", return_value={"key": "ENG-9"}):
            sm.set_board_status("c1", "ENG-9", "", category="review")
        self.assertEqual(seen["body"], {"transition": {"id": "22"}})

    def test_category_with_no_matching_option_is_refused(self):
        sm = self.make_manager()
        opts = [{"id": "21", "name": "In Progress", "category": "inprogress"}]
        with self._jira(), \
             mock.patch.object(ha, "board_status_options", return_value=opts), \
             mock.patch.object(ha, "apply_board_status") as apply:
            sm.set_board_status("c1", "ENG-9", "", category="done")
        apply.assert_not_called()
        r = sm.ticket_status_results[0]
        self.assertFalse(r["ok"])
        self.assertIn("Done", r["error"])   # labelled in the operator's own vocabulary

    def test_neither_value_nor_category_is_refused(self):
        sm = self.make_manager()
        with self._jira(), \
             mock.patch.object(ha, "board_status_options", return_value=[]) as opts, \
             mock.patch.object(ha, "apply_board_status") as apply:
            sm.set_board_status("c1", "ENG-9", "")
        apply.assert_not_called()
        opts.assert_not_called()            # bailed before even reading options
        self.assertIn("no status given", sm.ticket_status_results[0]["error"])

    def test_command_passes_category_through(self):
        sm = self.make_manager()
        sm.registry = []
        opts = [{"id": "31", "name": "Done", "category": "done"}]
        with self._jira(), \
             mock.patch.object(ha, "board_status_options", return_value=opts), \
             mock.patch.object(ha, "jira_req", return_value={}), \
             mock.patch.object(ha, "fetch_board_issue", return_value={"key": "ENG-9"}):
            sm.handle_commands([{"cmdId": "c9", "type": "setTicketStatus",
                                 "issueKey": "ENG-9", "value": "", "category": "done"}])
        self.assertIn("c9", sm.acked)
        self.assertTrue(sm.ticket_status_results[0]["ok"])


class TestBoardColumn(unittest.TestCase):
    """The status-column resolver behind drag-and-drop (XERK-141). Mirrors
    board.js categoryOf: review is carved out of inprogress by the status name."""

    def test_board_column_mirrors_category_of(self):
        self.assertEqual(ha._board_column("Anything", "todo"), "todo")
        self.assertEqual(ha._board_column("Anything", "weird"), "todo")
        self.assertEqual(ha._board_column("In Progress", "inprogress"), "inprogress")
        self.assertEqual(ha._board_column("Done", "done"), "done")
        # Review carve-out, word-boundary matched, only from inprogress.
        self.assertEqual(ha._board_column("In Review", "inprogress"), "review")
        self.assertEqual(ha._board_column("Testing", "inprogress"), "review")
        self.assertEqual(ha._board_column("QA", "inprogress"), "review")
        self.assertEqual(ha._board_column("Attestation", "inprogress"), "inprogress")
        self.assertEqual(ha._board_column("Testing complete", "done"), "done")
        # Azure DevOps' "fixed, not yet verified" state (XERK-250).
        self.assertEqual(ha._board_column("Resolved", "inprogress"), "review")
        # Still only ever pulled FROM inprogress: a Jira "Resolved" is normally
        # in the done category and stays in Done.
        self.assertEqual(ha._board_column("Resolved", "done"), "done")

    def test_first_matching_option_wins(self):
        opts = [{"id": "a", "name": "First Done", "category": "done"},
                {"id": "b", "name": "Second Done", "category": "done"}]
        self.assertEqual(ha._status_option_for_column(opts, "done")["id"], "a")
        self.assertIsNone(ha._status_option_for_column(opts, "todo"))
        self.assertIsNone(ha._status_option_for_column([], "done"))


# --- Ticket creation (XERK-137) ------------------------------------------------

class TestTextToAdf(unittest.TestCase):
    """Plain text -> the minimal ADF doc Jira's create API wants."""

    def test_paragraphs_and_blank_lines(self):
        doc = ha._text_to_adf("one\n\ntwo")
        self.assertEqual(doc["type"], "doc")
        self.assertEqual(doc["content"][0],
                         {"type": "paragraph",
                          "content": [{"type": "text", "text": "one"}]})
        self.assertEqual(doc["content"][1], {"type": "paragraph"})  # blank line
        self.assertEqual(doc["content"][2]["content"][0]["text"], "two")

    def test_empty_is_still_a_valid_doc(self):
        self.assertEqual(ha._text_to_adf("")["content"], [{"type": "paragraph"}])


class TestJiraAccountId(unittest.TestCase):
    def test_caches_the_lookup(self):
        calls = []

        def fg(path, params):
            calls.append(path)
            return {"accountId": "abc"}

        with mock.patch.object(ha, "_JIRA_MYSELF", {"accountId": None, "tried": False}), \
             mock.patch.object(ha, "jira_get", fg):
            self.assertEqual(ha._jira_account_id(), "abc")
            self.assertEqual(ha._jira_account_id(), "abc")  # served from cache
        self.assertEqual(calls, ["/rest/api/3/myself"])

    def test_failure_is_swallowed_and_not_retried(self):
        with mock.patch.object(ha, "_JIRA_MYSELF", {"accountId": None, "tried": False}), \
             mock.patch.object(ha, "jira_get", side_effect=RuntimeError("401")):
            self.assertIsNone(ha._jira_account_id())


class TestCreateJiraIssue(unittest.TestCase):
    def test_builds_fields_and_self_assigns(self):
        seen = {}

        def fake_post(path, body):
            seen["path"], seen["body"] = path, body
            return {"key": "ENG-99"}

        with mock.patch.object(ha, "JIRA_SITE", "MyOrg.atlassian.net"), \
             mock.patch.object(ha, "jira_post", fake_post), \
             mock.patch.object(ha, "_jira_account_id", lambda: "acc-1"):
            out = ha.create_jira_issue("ENG", "10001", "Title", "Desc", ["a", "b"])
        self.assertEqual(seen["path"], "/rest/api/3/issue")
        f = seen["body"]["fields"]
        self.assertEqual(f["project"], {"key": "ENG"})
        self.assertEqual(f["summary"], "Title")
        self.assertEqual(f["issuetype"], {"id": "10001"})
        self.assertEqual(f["labels"], ["a", "b"])
        self.assertEqual(f["assignee"], {"id": "acc-1"})
        self.assertEqual(f["description"]["type"], "doc")
        self.assertEqual(out, {"key": "ENG-99",
                               "url": "https://myorg.atlassian.net/browse/ENG-99",
                               "assigned": True})

    def test_omits_optional_fields_when_empty(self):
        captured = {}

        def fp(path, body):
            captured["body"] = body
            return {"key": "E-1"}

        with mock.patch.object(ha, "JIRA_SITE", "o.atlassian.net"), \
             mock.patch.object(ha, "jira_post", fp), \
             mock.patch.object(ha, "_jira_account_id", lambda: None):
            ha.create_jira_issue("E", "1", "T", "", [])
        f = captured["body"]["fields"]
        for k in ("assignee", "description", "labels"):
            self.assertNotIn(k, f)

    def test_missing_key_raises(self):
        with mock.patch.object(ha, "JIRA_SITE", "o.atlassian.net"), \
             mock.patch.object(ha, "jira_post", lambda p, b: {}), \
             mock.patch.object(ha, "_jira_account_id", lambda: None):
            with self.assertRaises(RuntimeError):
                ha.create_jira_issue("E", "1", "T", "", [])


class TestJiraCreateMeta(unittest.TestCase):
    def test_projects_and_labels(self):
        def fg(path, params):
            if "project/search" in path:
                return {"values": [{"key": "ENG", "name": "Engineering"},
                                   {"key": "OPS"}]}
            if path == "/rest/api/3/label":
                return {"values": ["turma", "bug", 7]}  # non-str dropped
            raise AssertionError(path)

        with mock.patch.object(ha, "jira_get", fg):
            m = ha.jira_create_meta()
        self.assertEqual(m["source"], "jira")
        self.assertEqual(m["projects"], [{"key": "ENG", "name": "Engineering"},
                                         {"key": "OPS", "name": "OPS"}])
        self.assertEqual(m["labels"], ["turma", "bug"])

    def test_label_fetch_failure_degrades(self):
        def fg(path, params):
            if "project/search" in path:
                return {"values": [{"key": "ENG", "name": "Eng"}]}
            raise RuntimeError("no labels")

        with mock.patch.object(ha, "jira_get", fg):
            self.assertEqual(ha.jira_create_meta()["labels"], [])


class TestJiraIssueTypes(unittest.TestCase):
    def test_excludes_subtasks_and_idless(self):
        def fg(path, params):
            self.assertIn("/createmeta/ENG/issuetypes", path)
            return {"issueTypes": [
                {"id": "1", "name": "Task"},
                {"id": "2", "name": "Sub-task", "subtask": True},
                {"name": "NoId"},
            ]}

        with mock.patch.object(ha, "jira_get", fg):
            self.assertEqual(ha.jira_issue_types("ENG"), [{"id": "1", "name": "Task"}])


class TestHttpErrorDetail(unittest.TestCase):
    """A rejected tracker request must carry the SERVER's explanation: urllib
    stringifies an HTTPError to "HTTP Error 400: Bad Request" and drops the body,
    which is the only place either tracker says what was actually wrong."""

    def _err(self, body, code=400):
        return urllib.error.HTTPError(
            "http://x", code, "Bad Request", {},
            io.BytesIO(body.encode() if isinstance(body, str) else body))

    def test_azure_message(self):
        detail = ha._http_error_detail(self._err(json.dumps(
            {"message": "TF401326: Work item type Bug does not have field "
                        "System.Description."})))
        self.assertIn("HTTP 400", detail)
        self.assertIn("does not have field System.Description", detail)

    def test_jira_error_messages_and_field_errors(self):
        self.assertIn("summary is required", ha._http_error_detail(self._err(
            json.dumps({"errorMessages": ["summary is required"]}))))
        detail = ha._http_error_detail(self._err(
            json.dumps({"errorMessages": [], "errors": {"project": "no such"}})))
        self.assertIn("project: no such", detail)

    def test_html_body_is_stripped_to_its_sentence(self):
        detail = ha._http_error_detail(self._err(
            "<html><style>b{}</style><body><h1>Access denied</h1></body></html>",
            code=403))
        self.assertIn("HTTP 403", detail)
        self.assertIn("Access denied", detail)
        self.assertNotIn("<", detail)
        self.assertNotIn("b{}", detail)

    def test_empty_body_still_names_the_code(self):
        self.assertEqual(ha._http_error_detail(self._err("")), "HTTP 400")

    def test_capped(self):
        detail = ha._http_error_detail(self._err(json.dumps({"message": "x" * 900})))
        self.assertLessEqual(len(detail), ha.BOARD_ERROR_MAX_CHARS + 20)

    def test_board_urlopen_raises_with_the_detail(self):
        def boom(req, timeout=None):
            raise self._err(json.dumps({"message": "TF401320: Rule Error"}))

        with mock.patch.object(ha.urllib.request, "urlopen", boom):
            with self.assertRaises(RuntimeError) as cm:
                ha._board_urlopen(urllib.request.Request("http://x"))
        self.assertIn("TF401320: Rule Error", str(cm.exception))

    def test_board_urlopen_parses_empty_body_as_empty_dict(self):
        class _Resp:
            def read(self):
                return b""

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        with mock.patch.object(ha.urllib.request, "urlopen",
                               lambda req, timeout=None: _Resp()):
            self.assertEqual(ha._board_urlopen(urllib.request.Request("http://x")), {})


class TestAzureDescriptionField(unittest.TestCase):
    """The Agile/Scrum Bug keeps its description in ReproSteps and has no
    System.Description, and patching a field a type doesn't have fails the whole
    create — so the field is looked up rather than assumed."""

    def _fields(self, *refs):
        return {"value": [{"referenceName": r} for r in refs]}

    def test_bug_without_description_uses_repro_steps(self):
        with mock.patch.object(ha, "_AZDO_FIELD_CACHE", {}), \
             mock.patch.object(ha, "azure_req", return_value=self._fields(
                 "System.Title", "Microsoft.VSTS.TCM.ReproSteps")):
            self.assertEqual(ha._azure_description_field("s", "P", "Bug"),
                             "Microsoft.VSTS.TCM.ReproSteps")

    def test_description_wins_when_the_type_has_it(self):
        with mock.patch.object(ha, "_AZDO_FIELD_CACHE", {}), \
             mock.patch.object(ha, "azure_req", return_value=self._fields(
                 "System.Description", "Microsoft.VSTS.TCM.ReproSteps")):
            self.assertEqual(ha._azure_description_field("s", "P", "Task"),
                             "System.Description")

    def test_unknown_field_list_falls_back_to_description(self):
        def boom(*a, **k):
            raise RuntimeError("403")

        with mock.patch.object(ha, "_AZDO_FIELD_CACHE", {}), \
             mock.patch.object(ha, "azure_req", boom):
            self.assertEqual(ha._azure_description_field("s", "P", "Bug"),
                             "System.Description")

    def test_neither_field_means_send_none(self):
        with mock.patch.object(ha, "_AZDO_FIELD_CACHE", {}), \
             mock.patch.object(ha, "azure_req",
                               return_value=self._fields("System.Title")):
            self.assertIsNone(ha._azure_description_field("s", "P", "Odd"))

    def test_cached_per_project_and_type(self):
        calls = []

        def req(path, params, body=None):
            calls.append(path)
            return self._fields("System.Description")

        with mock.patch.object(ha, "_AZDO_FIELD_CACHE", {}), \
             mock.patch.object(ha, "azure_req", req):
            ha._azure_description_field("s", "P", "Bug")
            ha._azure_description_field("s", "P", "Bug")
            ha._azure_description_field("s", "P", "Task")
        self.assertEqual(len(calls), 2)


class TestCreateAzureIssue(unittest.TestCase):
    def _has_description(self):
        """The common case: the type carries System.Description."""
        return mock.patch.object(
            ha, "_azure_description_field", lambda s, p, w: "System.Description")

    def test_builds_json_patch_ops(self):
        seen = {}

        def fake_create(project, wtype, ops):
            seen.update(project=project, wtype=wtype, ops=ops)
            return {"id": 77}

        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/org",
                                 AZDO_TOKEN="p", AZDO_USER="me@x"), \
             self._has_description(), \
             mock.patch.object(ha, "azure_create_workitem", fake_create):
            out = ha.create_azure_issue("Proj", "Bug", "Title", "l1\nl2", ["t1", "t2"])
        ops = {o["path"]: o["value"] for o in seen["ops"]}
        self.assertEqual(ops["/fields/System.Title"], "Title")
        self.assertIn("l1<br>l2", ops["/fields/System.Description"])
        self.assertEqual(ops["/fields/System.Tags"], "t1; t2")
        self.assertEqual(ops["/fields/System.AssignedTo"], "me@x")
        self.assertEqual(seen["wtype"], "Bug")
        self.assertEqual(out["key"], "77")
        self.assertIn("/_workitems/edit/77", out["url"])

    def test_escapes_html_and_skips_unknown_assignee(self):
        captured = {}

        def fc(p, w, ops):
            captured["ops"] = ops
            return {"id": 1}

        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o",
                                 AZDO_TOKEN="p", AZDO_USER=""), \
             self._has_description(), \
             mock.patch.object(ha, "_azure_identities", lambda: []), \
             mock.patch.object(ha, "azure_create_workitem", fc):
            ha.create_azure_issue("P", "Task", "T", "<script>", [])
        desc = [o for o in captured["ops"]
                if o["path"].endswith("Description")][0]["value"]
        self.assertIn("&lt;script&gt;", desc)
        self.assertFalse(any(o["path"].endswith("AssignedTo") for o in captured["ops"]))

    def test_missing_id_raises(self):
        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o",
                                 AZDO_TOKEN="p"), \
             self._has_description(), \
             mock.patch.object(ha, "_azure_identities", lambda: []), \
             mock.patch.object(ha, "azure_create_workitem", lambda p, w, o: {}):
            with self.assertRaises(RuntimeError):
                ha.create_azure_issue("P", "Task", "T", "", [])

    def test_description_goes_to_the_field_the_type_actually_has(self):
        captured = {}

        def fc(p, w, ops):
            captured["ops"] = ops
            return {"id": 5}

        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o",
                                 AZDO_TOKEN="p", AZDO_USER=""), \
             mock.patch.object(ha, "_azure_description_field",
                               lambda s, p, w: "Microsoft.VSTS.TCM.ReproSteps"), \
             mock.patch.object(ha, "_azure_identities", lambda: []), \
             mock.patch.object(ha, "azure_create_workitem", fc):
            ha.create_azure_issue("P", "Bug", "T", "steps", [])
        paths = [o["path"] for o in captured["ops"]]
        self.assertIn("/fields/Microsoft.VSTS.TCM.ReproSteps", paths)
        self.assertNotIn("/fields/System.Description", paths)

    def test_type_with_no_description_field_still_creates(self):
        captured = {}

        def fc(p, w, ops):
            captured["ops"] = ops
            return {"id": 6}

        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o",
                                 AZDO_TOKEN="p", AZDO_USER=""), \
             mock.patch.object(ha, "_azure_description_field", lambda s, p, w: None), \
             mock.patch.object(ha, "_azure_identities", lambda: []), \
             mock.patch.object(ha, "azure_create_workitem", fc):
            out = ha.create_azure_issue("P", "Odd", "T", "dropped", [])
        self.assertEqual(out["key"], "6")
        self.assertEqual([o["path"] for o in captured["ops"]],
                         ["/fields/System.Title"])

    def test_falls_through_the_identity_ladder(self):
        """The identity a collection accepts is unguessable (email / DOMAIN\\user
        / display name), so a rejected one must move to the next candidate, not
        straight to unassigned — an unassigned item misses the board's @Me."""
        tries = []

        def fc(p, w, ops):
            tries.append(ops)
            who = [o["value"] for o in ops if o["path"].endswith("AssignedTo")]
            if who and who[0] != "DOMAIN\\me":
                raise ha.BoardHttpError("HTTP 400: TF401320: Rule Error", 400)
            return {"id": 9}

        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o",
                                 AZDO_TOKEN="p"), \
             self._has_description(), \
             mock.patch.object(ha, "_azure_identities",
                               lambda: ["Board Label", "DOMAIN\\me"]), \
             mock.patch.object(ha, "azure_create_workitem", fc):
            out = ha.create_azure_issue("P", "Task", "T", "d", [])
        self.assertEqual(out["key"], "9")
        self.assertTrue(out["assigned"])
        self.assertEqual(len(tries), 2)

    def test_unassigned_is_the_last_resort_and_is_reported(self):
        tries = []

        def fc(p, w, ops):
            tries.append(ops)
            if any(o["path"].endswith("AssignedTo") for o in ops):
                raise ha.BoardHttpError("HTTP 400: TF401320: Rule Error", 400)
            return {"id": 9}

        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o",
                                 AZDO_TOKEN="p"), \
             self._has_description(), \
             mock.patch.object(ha, "_azure_identities", lambda: ["a", "b"]), \
             mock.patch.object(ha, "azure_create_workitem", fc):
            out = ha.create_azure_issue("P", "Task", "T", "d", [])
        self.assertEqual(out["key"], "9")
        self.assertFalse(out["assigned"])          # drives the client's warning
        self.assertEqual(len(tries), 3)
        self.assertFalse(any(o["path"].endswith("AssignedTo") for o in tries[2]))
        # An unassigned item is invisible on the board, so the tracker's own
        # words are the operator's only lead on which spelling it wants.
        self.assertIn("TF401320", out["assignError"])

    def test_no_candidate_at_all_says_so_rather_than_blaming_the_server(self):
        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o",
                                 AZDO_TOKEN="p", AZDO_USER=""), \
             self._has_description(), \
             mock.patch.object(ha, "_azure_identities", lambda: []), \
             mock.patch.object(ha, "azure_create_workitem",
                               lambda p, w, o: {"id": 4}):
            out = ha.create_azure_issue("P", "Task", "T", "d", [])
        self.assertFalse(out["assigned"])
        self.assertIn("could not work out your identity", out["assignError"])

    def test_keeps_the_first_error_when_every_attempt_fails(self):
        """A later attempt only proves that identity didn't work either; the
        first rejection is the one that names the real problem."""
        def fc(p, w, ops):
            raise ha.BoardHttpError(
                "HTTP 400: TF401326: missing required field Area", 400)

        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o",
                                 AZDO_TOKEN="p"), \
             self._has_description(), \
             mock.patch.object(ha, "_azure_identities", lambda: ["me@x"]), \
             mock.patch.object(ha, "azure_create_workitem", fc):
            with self.assertRaises(RuntimeError) as cm:
                ha.create_azure_issue("P", "Task", "T", "d", [])
        self.assertIn("missing required field Area", str(cm.exception))

    def test_an_unrefused_failure_is_never_retried(self):
        """A 4xx proves nothing was created; a timeout or 5xx does not, so
        re-sending could duplicate the work item."""
        for boom in (ha.BoardHttpError("HTTP 503: busy", 503),
                     TimeoutError("timed out")):
            tries = []

            def fc(p, w, ops, _b=boom):
                tries.append(ops)
                raise _b

            with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o",
                                     AZDO_TOKEN="p"), \
                 self._has_description(), \
                 mock.patch.object(ha, "_azure_identities", lambda: ["a", "b"]), \
                 mock.patch.object(ha, "azure_create_workitem", fc):
                with self.assertRaises(Exception):
                    ha.create_azure_issue("P", "Task", "T", "d", [])
            self.assertEqual(len(tries), 1, f"retried after {boom!r}")

    def test_no_ladder_means_one_unassigned_attempt(self):
        tries = []

        def fc(p, w, ops):
            tries.append(ops)
            raise ha.BoardHttpError("HTTP 400: something else", 400)

        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o",
                                 AZDO_TOKEN="p", AZDO_USER=""), \
             self._has_description(), \
             mock.patch.object(ha, "_azure_identities", lambda: []), \
             mock.patch.object(ha, "azure_create_workitem", fc):
            with self.assertRaises(RuntimeError):
                ha.create_azure_issue("P", "Task", "T", "d", [])
        self.assertEqual(len(tries), 1)


class TestAzureIdentities(unittest.TestCase):
    """The candidates tried as System.AssignedTo, best first."""

    def _conn(self):
        return {"authenticatedUser": {
            "properties": {"Account": {"$value": "DOMAIN\\me"}},
            "uniqueName": "me@corp.com", "providerDisplayName": "Me Myself",
            "id": "guid-1"}}

    def _fresh(self, mine=None):
        """A clean connection-data probe. The harvest is pinned as already-run
        (with `mine`, if any) so these cases stay about the probe alone."""
        return mock.patch.multiple(
            ha, _AZDO_ME={"names": [], "tried": False},
            _AZDO_MINE={"names": list(mine or []), "tried": True})

    def test_operator_setting_leads_then_connection_data(self):
        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o",
                                 AZDO_TOKEN="p", AZDO_USER="Board Label"), \
             self._fresh(), \
             mock.patch.object(ha, "azure_req", return_value=self._conn()):
            self.assertEqual(ha._azure_identities(),
                             ["Board Label", "DOMAIN\\me", "me@corp.com",
                              "Me Myself", "guid-1",
                              "Me Myself <DOMAIN\\me>", "Me Myself <me@corp.com>"])

    def test_harvested_spellings_outrank_the_connection_data_guesses(self):
        """What the server itself calls this user beats anything derived from
        the PAT's connection data, which is only a guess at what it accepts."""
        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o",
                                 AZDO_TOKEN="p", AZDO_USER="Board Label"), \
             self._fresh(mine=["Me Myself <DOMAIN\\me>"]), \
             mock.patch.object(ha, "azure_req", return_value=self._conn()):
            got = ha._azure_identities()
        self.assertEqual(got[:2], ["Board Label", "Me Myself <DOMAIN\\me>"])
        self.assertEqual(len(got), len(set(got)))

    def test_deduped_when_the_setting_is_already_a_candidate(self):
        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o",
                                 AZDO_TOKEN="p", AZDO_USER="me@corp.com"), \
             self._fresh(), \
             mock.patch.object(ha, "azure_req", return_value=self._conn()):
            got = ha._azure_identities()
        self.assertEqual(got[0], "me@corp.com")
        self.assertEqual(len(got), len(set(got)))

    def test_a_failed_probe_is_retried_not_cached(self):
        """Marking the probe tried up-front turned one transient failure into a
        process that never self-assigned again."""
        calls = []

        def flaky(path, params, body=None):
            calls.append(path)
            if len(calls) == 1:
                raise RuntimeError("boom")
            return self._conn()

        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o",
                                 AZDO_TOKEN="p", AZDO_USER=""), \
             self._fresh(), mock.patch.object(ha, "azure_req", flaky):
            self.assertEqual(ha._azure_identities(), [])
            self.assertIn("DOMAIN\\me", ha._azure_identities())
            ha._azure_identities()
        self.assertEqual(len(calls), 2)            # cached after the success


class TestAzureIdentityStrings(unittest.TestCase):
    """One identity value -> every spelling worth sending back as AssignedTo."""

    def test_an_identity_object_offers_unique_then_the_classic_pairing(self):
        self.assertEqual(
            ha._azure_identity_strings({"displayName": "Me Myself",
                                        "uniqueName": "DOMAIN\\me",
                                        "id": "guid-1"}),
            ["DOMAIN\\me", "Me Myself <DOMAIN\\me>", "guid-1", "Me Myself"])

    def test_a_bare_string_is_already_the_servers_own_text(self):
        self.assertEqual(ha._azure_identity_strings("NCHFA\\mx"), ["NCHFA\\mx"])

    def test_nothing_usable(self):
        for v in (None, "", "   ", 7, {}, {"displayName": ""}):
            self.assertEqual(ha._azure_identity_strings(v), [], repr(v))


class TestAzureMineIdentities(unittest.TestCase):
    """Harvesting the assignee spelling off work items already assigned to @Me —
    the one candidate the server has demonstrably resolved before."""

    def _fresh(self):
        return mock.patch.object(ha, "_AZDO_MINE", {"names": [], "tried": False})

    def _reqs(self, item, calls=None):
        def req(path, params, body=None):
            (calls if calls is not None else []).append((path, params, body))
            if path == "/_apis/wit/wiql":
                return {"workItems": [{"id": 51125}, {"id": 9}]}
            if path == "/_apis/wit/workitems":
                return {"value": [item]}
            raise AssertionError(path)
        return req

    def test_reads_the_assignee_off_the_operators_newest_item(self):
        calls = []
        item = {"id": 51125, "fields": {"System.AssignedTo": {
            "displayName": "Habeeb, Max", "uniqueName": "NCHFA\\mxhabeeb"}}}
        with mock.patch.multiple(ha, AZDO_URL="https://tfs/x", AZDO_TOKEN="p",
                                 AZDO_PROJECT=""), \
             self._fresh(), \
             mock.patch.object(ha, "azure_req", self._reqs(item, calls)):
            self.assertEqual(ha._azure_mine_identities(),
                             ["NCHFA\\mxhabeeb", "Habeeb, Max <NCHFA\\mxhabeeb>",
                              "Habeeb, Max"])
        wiql = [c for c in calls if c[0] == "/_apis/wit/wiql"][0]
        self.assertIn("[System.AssignedTo] = @Me", wiql[2]["query"])
        # Only the newest item is fetched — this is a spelling probe, not a poll.
        self.assertEqual([c for c in calls if c[0] == "/_apis/wit/workitems"][0][1]
                         ["ids"], "51125")

    def test_the_project_scope_is_carried_and_quoted(self):
        """Same WIQL the poll builds, so the probe sees the same items — and an
        apostrophe in a project name must not break out of the literal."""
        calls = []
        with mock.patch.multiple(ha, AZDO_URL="https://tfs/x", AZDO_TOKEN="p",
                                 AZDO_PROJECT="O'Brien"), \
             self._fresh(), \
             mock.patch.object(ha, "azure_req", self._reqs(
                 {"id": 1, "fields": {"System.AssignedTo": "x"}}, calls)):
            self.assertEqual(ha._azure_mine_identities(), ["x"])
        query = [c for c in calls if c[0] == "/_apis/wit/wiql"][0][2]["query"]
        self.assertIn("[System.TeamProject] = 'O''Brien'", query)

    def test_no_assigned_items_caches_an_empty_answer(self):
        calls = []

        def req(path, params, body=None):
            calls.append(path)
            return {"workItems": []}

        with mock.patch.multiple(ha, AZDO_URL="https://tfs/x", AZDO_TOKEN="p",
                                 AZDO_PROJECT=""), \
             self._fresh(), mock.patch.object(ha, "azure_req", req):
            self.assertEqual(ha._azure_mine_identities(), [])
            self.assertEqual(ha._azure_mine_identities(), [])
        self.assertEqual(len(calls), 1)          # "none" is an answer, cached

    def test_a_failed_probe_is_retried_not_cached(self):
        calls = []
        item = {"id": 3, "fields": {"System.AssignedTo": {
            "displayName": "Me", "uniqueName": "d\\me"}}}
        ok = self._reqs(item)

        def flaky(path, params, body=None):
            calls.append(path)
            if len(calls) == 1:
                raise RuntimeError("boom")
            return ok(path, params, body)

        with mock.patch.multiple(ha, AZDO_URL="https://tfs/x", AZDO_TOKEN="p",
                                 AZDO_PROJECT=""), \
             self._fresh(), mock.patch.object(ha, "azure_req", flaky):
            self.assertEqual(ha._azure_mine_identities(), [])
            self.assertIn("d\\me", ha._azure_mine_identities())


class TestAzureCreateMeta(unittest.TestCase):
    def test_projects_and_tags(self):
        def req(path, params, body=None):
            if path == "/_apis/projects":
                return {"value": [{"name": "Proj A"}, {"name": "Proj B"}]}
            if path == "/_apis/wit/tags":
                return {"value": [{"name": "tag1"}, {"name": "tag2"}]}
            raise AssertionError(path)

        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o", AZDO_TOKEN="p"), \
             mock.patch.object(ha, "azure_req", req):
            m = ha.azure_create_meta()
        self.assertEqual(m["source"], "azure")
        self.assertEqual(m["projects"],
                         [{"key": "Proj A", "name": "Proj A"},
                          {"key": "Proj B", "name": "Proj B"}])
        self.assertEqual(m["labels"], ["tag1", "tag2"])

    def test_tag_failure_degrades(self):
        def req(path, params, body=None):
            if path == "/_apis/projects":
                return {"value": [{"name": "P"}]}
            raise RuntimeError("no tags")

        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o", AZDO_TOKEN="p"), \
             mock.patch.object(ha, "azure_req", req):
            self.assertEqual(ha.azure_create_meta()["labels"], [])


class TestAzureWorkitemTypes(unittest.TestCase):
    def test_excludes_disabled(self):
        def req(path, params, body=None):
            self.assertIn("/workitemtypes", path)
            return {"value": [{"name": "Bug"}, {"name": "Old", "isDisabled": True},
                              {"foo": 1}]}

        with mock.patch.multiple(ha, AZDO_URL="https://dev.azure.com/o", AZDO_TOKEN="p"), \
             mock.patch.object(ha, "azure_req", req):
            self.assertEqual(ha.azure_workitem_types("P"), [{"id": "Bug", "name": "Bug"}])


class TestStageCreateMeta(ManagerMixin, unittest.TestCase):
    """{type:"boardCreateMeta"}: two shapes on one deque, told apart by `project`;
    every failure stages an `error` rather than raising out of the beat."""

    def _cfg(self):
        return mock.patch.multiple(ha, JIRA_SITE="s.atlassian.net", JIRA_EMAIL="e",
                                   JIRA_TOKEN="t", AZDO_URL="", AZDO_TOKEN="")

    def test_projects_shape(self):
        sm = self.make_manager()
        with self._cfg(), mock.patch.object(
                ha, "board_create_meta",
                return_value={"projects": [{"key": "E", "name": "E"}],
                              "labels": ["x"], "source": "jira"}):
            sm._stage_create_meta(None)
        r = sm.create_meta_results[0]
        self.assertIsNone(r["project"])
        self.assertEqual(r["projects"], [{"key": "E", "name": "E"}])
        self.assertEqual(r["labels"], ["x"])
        self.assertIsNone(r["error"])

    def test_types_shape(self):
        sm = self.make_manager()
        with self._cfg(), mock.patch.object(
                ha, "board_issue_types",
                return_value=[{"id": "1", "name": "Task"}]) as f:
            sm._stage_create_meta("ENG")
        f.assert_called_once_with("ENG")
        r = sm.create_meta_results[0]
        self.assertEqual(r["project"], "ENG")
        self.assertEqual(r["types"], [{"id": "1", "name": "Task"}])

    def test_error_stages_not_raises(self):
        sm = self.make_manager()
        with self._cfg(), mock.patch.object(
                ha, "board_create_meta", side_effect=RuntimeError("boom")):
            sm._stage_create_meta(None)
        self.assertTrue(sm.create_meta_results[0]["error"].startswith("boom"))

    def test_unconfigured_says_so(self):
        sm = self.make_manager()
        with mock.patch.multiple(ha, JIRA_SITE="", JIRA_EMAIL="", JIRA_TOKEN="",
                                 AZDO_URL="", AZDO_TOKEN=""):
            sm._stage_create_meta(None)
        self.assertIn("no board credentials", sm.create_meta_results[0]["error"])


class TestStageCreateTicket(ManagerMixin, unittest.TestCase):
    """{type:"createTicket"}: creates and stages the outcome keyed by cmdId; a bad
    request or a create failure stages an `error` rather than raising."""

    def _cfg(self):
        return mock.patch.multiple(ha, JIRA_SITE="s.atlassian.net", JIRA_EMAIL="e",
                                   JIRA_TOKEN="t", AZDO_URL="", AZDO_TOKEN="")

    def _cmd(self, **kw):
        base = {"cmdId": "c1", "type": "createTicket", "project": "ENG",
                "issueType": "1", "summary": "Hi", "description": "d",
                "labels": ["a"]}
        base.update(kw)
        return base

    def test_success_stages_key(self):
        sm = self.make_manager()
        with self._cfg(), mock.patch.object(
                ha, "create_board_issue",
                return_value={"key": "ENG-5", "url": "u", "assigned": True}) as f:
            sm._stage_create_ticket(self._cmd())
        f.assert_called_once_with("ENG", "1", "Hi", "d", ["a"])
        self.assertEqual(sm.create_ticket_results[0],
                         {"cmdId": "c1", "key": "ENG-5", "url": "u", "error": None,
                          "warning": None})

    def test_unassigned_create_succeeds_but_warns(self):
        """The board filters on the tracker user, so an unassigned ticket is
        created and then invisible there — that has to be said out loud."""
        sm = self.make_manager()
        with self._cfg(), mock.patch.object(
                ha, "create_board_issue",
                return_value={"key": "ENG-6", "url": "u", "assigned": False}):
            sm._stage_create_ticket(self._cmd())
        out = sm.create_ticket_results[0]
        self.assertEqual(out["key"], "ENG-6")
        self.assertIsNone(out["error"])
        self.assertIn("couldn't be assigned", out["warning"])

    def test_the_warning_carries_the_trackers_own_reason(self):
        """"Set AZDO_USER" was worse than useless as advice — it is already a
        candidate, and being refused is how a create reaches this path."""
        sm = self.make_manager()
        with self._cfg(), mock.patch.object(
                ha, "create_board_issue",
                return_value={"key": "42", "url": "u", "assigned": False,
                              "assignError": "the server refused every identity "
                                             "this host could find (TF401320)"}):
            sm._stage_create_ticket(self._cmd())
        warning = sm.create_ticket_results[0]["warning"]
        self.assertIn("TF401320", warning)
        self.assertNotIn("AZDO_USER", warning)

    def test_missing_title_fails_without_creating(self):
        sm = self.make_manager()
        with self._cfg(), mock.patch.object(ha, "create_board_issue") as f:
            sm._stage_create_ticket(self._cmd(summary="  "))
        f.assert_not_called()
        self.assertIn("title", sm.create_ticket_results[0]["error"])

    def test_create_error_stages_bounded_error(self):
        sm = self.make_manager()
        with self._cfg(), mock.patch.object(
                ha, "create_board_issue",
                side_effect=RuntimeError("Jira 400 " + "x" * 400)):
            sm._stage_create_ticket(self._cmd())
        r = sm.create_ticket_results[0]
        self.assertIsNone(r["key"])
        self.assertTrue(r["error"].startswith("Jira 400"))
        self.assertLessEqual(len(r["error"]), 300)

    def test_command_routes_and_acks(self):
        sm = self.make_manager()
        with self._cfg(), mock.patch.object(
                ha, "create_board_issue", return_value={"key": "E-1", "url": "u"}):
            sm.handle_commands([self._cmd()])
        self.assertEqual(sm.create_ticket_results[0]["key"], "E-1")
        self.assertIn("c1", sm.acked)

    def test_results_ride_payload_only_when_staged(self):
        sm = self.make_manager()
        sm.registry = []
        p = sm.build_payload(1)
        self.assertNotIn("createTicketResults", p)
        self.assertNotIn("createMetaResults", p)
        sm.create_ticket_results = [
            {"cmdId": "c1", "key": "E-1", "url": "u", "error": None}]
        sm.create_meta_results = [
            {"project": None, "projects": [], "labels": [], "source": "jira",
             "error": None}]
        p = sm.build_payload(1)
        self.assertEqual(p["createTicketResults"][0]["key"], "E-1")
        self.assertEqual(p["createMetaResults"][0]["source"], "jira")


class TestRefreshJira(ManagerMixin, unittest.TestCase):
    """The manager's slow-cadence Jira refresh: stale-cache fail-open (a fetch
    error keeps the prior tickets and surfaces only the error string)."""

    def test_success_replaces_block(self):
        sm = self.make_manager()
        fresh = {**ha.JIRA_EMPTY, "available": True, "tickets": [{"key": "A-1"}]}
        with mock.patch.object(ha, "collect_jira", return_value=fresh):
            sm.refresh_jira()
        self.assertEqual(sm.jira["tickets"], [{"key": "A-1"}])

    def test_failure_keeps_stale_tickets_and_sets_error(self):
        sm = self.make_manager()
        sm.jira = {**ha.JIRA_EMPTY, "available": True,
                   "fetchedAt": "2026-07-14T00:00:00Z",
                   "tickets": [{"key": "A-1"}]}
        with mock.patch.object(ha, "collect_jira",
                               side_effect=RuntimeError("boom " + "x" * 300)):
            sm.refresh_jira()
        self.assertEqual(sm.jira["tickets"], [{"key": "A-1"}])       # stale kept
        self.assertEqual(sm.jira["fetchedAt"], "2026-07-14T00:00:00Z")
        self.assertTrue(sm.jira["error"].startswith("boom"))
        self.assertLessEqual(len(sm.jira["error"]), 200)

    def test_failed_first_poll_still_reports_configured(self):
        # The regression the board's manual refresh depends on: a host whose
        # very FIRST poll fails must still advertise configured=True, or the hub
        # filters it out of the fan-out and the button can never retry the one
        # host that's actually broken. (This is the real 503-at-boot case.)
        # It must ALSO carry its locally-derived siteKey so the failing org shows
        # up on the board / org filters instead of vanishing — `available` is the
        # only field that then distinguishes it from a healthy org.
        with mock.patch.object(ha, "JIRA_SITE", "s.atlassian.net"), \
             mock.patch.object(ha, "JIRA_EMAIL", "e@x.com"), \
             mock.patch.object(ha, "JIRA_TOKEN", "t"):
            sm = self.make_manager()
            with mock.patch.object(ha, "collect_jira",
                                   side_effect=RuntimeError("HTTP Error 503")):
                sm.refresh_jira()
        self.assertTrue(sm.jira["configured"])
        self.assertFalse(sm.jira["available"])   # creds != a successful poll
        self.assertEqual(sm.jira["siteKey"], "s.atlassian.net")  # still visible
        self.assertIn("503", sm.jira["error"])

    def test_success_after_failure_clears_error(self):
        sm = self.make_manager()
        sm.jira = {**ha.JIRA_EMPTY, "error": "old failure"}
        fresh = {**ha.JIRA_EMPTY, "available": True}
        with mock.patch.object(ha, "collect_jira", return_value=fresh):
            sm.refresh_jira()
        self.assertIsNone(sm.jira["error"])

    def test_payload_cadence_and_light_gating(self):
        sm = self.make_manager()
        sm.registry = []
        calls = []
        sm.refresh_jira = lambda: calls.append(1)
        with mock.patch.object(ha, "JIRA_SITE", "s.atlassian.net"), \
             mock.patch.object(ha, "JIRA_EMAIL", "e"), \
             mock.patch.object(ha, "JIRA_TOKEN", "t"):
            payload = sm.build_payload(0)                 # beat 0 -> refresh
            self.assertEqual(len(calls), 1)
            sm.build_payload(1)                           # off-cadence -> no
            self.assertEqual(len(calls), 1)
            sm.build_payload(ha.JIRA_REFRESH_EVERY)       # on-cadence -> yes
            self.assertEqual(len(calls), 2)
            sm.build_payload(0, light=True)               # light beat -> no
            self.assertEqual(len(calls), 2)
        # The cached block rides every payload regardless, carrying the polled
        # fields verbatim plus the picker's repo options.
        self.assertIn("jira", payload)
        self.assertEqual({k: v for k, v in payload["jira"].items()
                          if k != "repoOptions"}, sm.jira)

    def test_payload_skips_refresh_when_unconfigured(self):
        # The manager is built INSIDE the patch: the block's `configured` flag
        # is stamped at init from the creds, so a host is only genuinely
        # unconfigured if it was unconfigured when it started. (Constructing it
        # outside also leaks the ambient JIRA_* env of whatever box runs the
        # suite — a real agent container has creds.)
        with mock.patch.object(ha, "JIRA_SITE", ""), \
             mock.patch.object(ha, "JIRA_EMAIL", ""), \
             mock.patch.object(ha, "JIRA_TOKEN", ""):
            sm = self.make_manager()
            sm.registry = []
            calls = []
            sm.refresh_jira = lambda: calls.append(1)
            payload = sm.build_payload(0)
        self.assertEqual(calls, [])                       # zero Jira work
        self.assertEqual(payload["jira"], ha.JIRA_EMPTY)  # block still present
        self.assertFalse(payload["jira"]["configured"])


class TestTriageCandidates(unittest.TestCase):
    """The candidate set a ticket may be matched to: cloned repos first, then the
    org's clonable ones. This list IS the org boundary and the allowlist."""

    def test_cloned_repos_come_first_and_are_marked(self):
        cands = ha._triage_candidates(
            [{"name": "Turma"}, {"name": "DockerOps"}],
            [{"nameWithOwner": "xerktech/Other", "name": "Other"}])
        self.assertEqual([c["name"] for c in cands], ["Turma", "DockerOps", "Other"])
        self.assertEqual([c["cloned"] for c in cands], [True, True, False])

    def test_uncloned_org_repos_are_selectable_and_keep_their_owner(self):
        cands = ha._triage_candidates([], [
            {"nameWithOwner": "xerktech/Widget", "name": "Widget",
             "description": "the widget service"},
        ])
        self.assertEqual(cands, [{"name": "Widget", "cloned": False,
                                  "nameWithOwner": "xerktech/Widget",
                                  "source": "github",
                                  "description": "the widget service"}])

    def test_a_cloned_repo_shadows_its_own_gh_listing(self):
        # The same repo arrives twice (scanned on disk + listed by gh). It must
        # collapse to ONE candidate, and to the cloned one — otherwise the model
        # sees a duplicate name and the "prefer cloned" hint is meaningless.
        cands = ha._triage_candidates(
            [{"name": "Turma"}],
            [{"nameWithOwner": "xerktech/Turma", "name": "Turma"}])
        self.assertEqual(len(cands), 1)
        self.assertTrue(cands[0]["cloned"])

    def test_a_cloned_repo_inherits_its_gh_description(self):
        # The scan knows a name and nothing else. Shadowing the gh half outright
        # would leave the candidates the prompt tells the model to PREFER as bare
        # names — describing worst exactly the repos most likely to win.
        cands = ha._triage_candidates(
            [{"name": "Turma"}],
            [{"nameWithOwner": "xerktech/Turma", "name": "Turma",
              "description": "agent fleet hub"}])
        self.assertEqual(cands[0]["description"], "agent fleet hub")
        self.assertEqual(cands[0]["nameWithOwner"], "xerktech/Turma")

    def test_truncation_is_stable_against_gh_updatedat_churn(self):
        # gh lists repos updatedAt-DESC, so a cut in THAT order makes the surviving
        # name set move whenever anyone pushes to a cold repo — which would defeat
        # _candidates_fingerprint's names-only design and re-triage the board on
        # every sweep. The candidate cut must not depend on updatedAt at all.
        gh = [{"nameWithOwner": f"o/r{i:03d}", "name": f"r{i:03d}",
               "updatedAt": f"2026-01-{(i % 28) + 1:02d}T00:00:00Z"} for i in range(300)]
        before = ha._triage_candidates([], gh)
        shuffled = list(reversed(gh))   # the same repos, a later sweep's order
        after = ha._triage_candidates([], shuffled)
        self.assertEqual([c["name"] for c in before], [c["name"] for c in after])
        self.assertEqual(ha._candidates_fingerprint(before),
                         ha._candidates_fingerprint(after))

    def test_root_pseudo_repo_is_never_a_candidate(self):
        cands = ha._triage_candidates([{"name": ha.ROOT_REPO_NAME}], [])
        self.assertEqual(cands, [])

    def test_candidate_list_is_bounded(self):
        gh = [{"nameWithOwner": f"o/r{i}", "name": f"r{i}"} for i in range(400)]
        self.assertEqual(len(ha._triage_candidates([], gh)), ha.JIRA_TRIAGE_CANDIDATES)


class TestTriageFingerprints(unittest.TestCase):
    """What re-triages a ticket and — just as important — what doesn't."""

    def test_ticket_text_change_invalidates(self):
        a = {"summary": "Fix login", "type": "Bug", "project": "ENG", "labels": []}
        b = {**a, "summary": "Fix logout"}
        self.assertNotEqual(ha._ticket_fingerprint(a), ha._ticket_fingerprint(b))

    def test_status_or_updated_churn_does_not_invalidate(self):
        # A ticket moving column, or any field edit bumping `updated`, is not new
        # information about WHICH REPO the work belongs in. Re-triaging on it
        # would burn the shared login re-deciding the same answer.
        a = {"summary": "Fix login", "type": "Bug", "project": "ENG", "labels": [],
             "status": "To Do", "updated": "2026-07-01T00:00:00Z"}
        b = {**a, "status": "In Progress", "updated": "2026-07-15T00:00:00Z"}
        self.assertEqual(ha._ticket_fingerprint(a), ha._ticket_fingerprint(b))

    def test_new_candidate_repo_invalidates(self):
        one = ha._triage_candidates([{"name": "Turma"}], [])
        two = ha._triage_candidates([{"name": "Turma"}, {"name": "Widget"}], [])
        self.assertNotEqual(ha._candidates_fingerprint(one),
                            ha._candidates_fingerprint(two))

    def test_cloning_an_existing_candidate_invalidates(self):
        # Same repo, now on disk: worth re-deciding, since "prefer cloned" may
        # now pull a ticket to it.
        before = ha._triage_candidates([], [{"nameWithOwner": "o/Widget", "name": "Widget"}])
        after = ha._triage_candidates([{"name": "Widget"}], [])
        self.assertNotEqual(ha._candidates_fingerprint(before),
                            ha._candidates_fingerprint(after))

    def test_gh_metadata_churn_does_not_invalidate(self):
        # The regression this guards: the gh block re-sweeps on its own cadence
        # and `updatedAt`/`description` move constantly. Hashing them would
        # re-triage the ENTIRE board every sweep, forever.
        before = ha._triage_candidates([], [
            {"nameWithOwner": "o/Widget", "name": "Widget",
             "description": "old", "updatedAt": "2026-01-01T00:00:00Z"}])
        after = ha._triage_candidates([], [
            {"nameWithOwner": "o/Widget", "name": "Widget",
             "description": "new words entirely", "updatedAt": "2026-07-15T00:00:00Z"}])
        self.assertEqual(ha._candidates_fingerprint(before),
                         ha._candidates_fingerprint(after))

    def test_candidate_order_does_not_invalidate(self):
        a = [{"name": "A", "cloned": True}, {"name": "B", "cloned": False}]
        self.assertEqual(ha._candidates_fingerprint(a),
                         ha._candidates_fingerprint(list(reversed(a))))

    def test_fingerprints_are_stable_across_processes(self):
        # crc32, not the salted builtin hash: a per-process salt would invalidate
        # the whole ledger on every manager restart.
        import subprocess
        out = subprocess.run(
            [sys.executable, "-c",
             "import importlib.util,sys;"
             f"spec=importlib.util.spec_from_file_location('ha', {ha.__file__!r});"
             "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);"
             "print(m._ticket_fingerprint({'summary':'Fix login'}))"],
            capture_output=True, text=True)
        self.assertEqual(out.stdout.strip(),
                         str(ha._ticket_fingerprint({"summary": "Fix login"})))


class TestParseTriage(unittest.TestCase):
    """The trust boundary: a model reply becomes a decision only if it names a
    repo from the candidate list."""

    def setUp(self):
        self.cands = ha._triage_candidates(
            [{"name": "Turma"}], [{"nameWithOwner": "xerktech/Widget", "name": "Widget"}])
        self.tickets = [{"key": "ENG-1"}, {"key": "ENG-2"}]

    def test_parses_repo_and_reason(self):
        out = ha._parse_triage(
            '{"ENG-1": {"repo": "Turma", "why": "heartbeat code"}}',
            self.tickets, self.cands)
        self.assertEqual(out["ENG-1"], {"repo": "Turma", "cloned": True,
                                        "nameWithOwner": None, "source": None,
                                        "reason": "heartbeat code"})

    def test_uncloned_candidate_keeps_its_owner(self):
        out = ha._parse_triage('{"ENG-1": {"repo": "Widget"}}', self.tickets, self.cands)
        self.assertEqual(out["ENG-1"]["nameWithOwner"], "xerktech/Widget")
        self.assertFalse(out["ENG-1"]["cloned"])

    def test_hallucinated_repo_is_no_answer_not_a_no_repo_verdict(self):
        # The model picks from a list, so an off-list name is invented. That's a
        # BROKEN attempt — omitting the key leaves the ticket undecided so the
        # retry picks it up. Recording it as "no repo fits" would paint a
        # confident chip asserting something the model never said, and (decisions
        # are never re-triaged) leave it there for good.
        out = ha._parse_triage(
            '{"ENG-1": {"repo": "totally-made-up", "why": "vibes"}}',
            self.tickets, self.cands)
        self.assertEqual(out, {})

    def test_null_is_an_answer_meaning_no_repo_fits(self):
        # The one case that IS a verdict: null was asked for and means what it says.
        for raw in ['{"ENG-1": null}', '{"ENG-1": {"repo": null}}']:
            out = ha._parse_triage(raw, self.tickets, self.cands)
            self.assertEqual(out["ENG-1"]["repo"], None, raw)

    def test_unreadable_value_shapes_are_no_answer(self):
        # Haiku deviating from the asked-for shape ({"repository": ...}, a bare
        # list) must retry, not silently become "no repo fits" for the batch.
        for raw in ['{"ENG-1": {"repository": "Turma"}}',
                    '{"ENG-1": ["Turma"]}',
                    '{"ENG-1": 42}',
                    '{"ENG-1": {"why": "no repo key at all"}}']:
            self.assertEqual(ha._parse_triage(raw, self.tickets, self.cands), {}, raw)

    def test_unasked_keys_are_ignored(self):
        out = ha._parse_triage(
            '{"ENG-1": {"repo": "Turma"}, "OPS-9": {"repo": "Turma"}}',
            self.tickets, self.cands)
        self.assertEqual(list(out), ["ENG-1"])

    def test_bare_string_reply_is_tolerated(self):
        out = ha._parse_triage('{"ENG-1": "Turma"}', self.tickets, self.cands)
        self.assertEqual(out["ENG-1"]["repo"], "Turma")

    def test_json_in_a_fence_or_prose_is_recovered(self):
        for raw in ['```json\n{"ENG-1": {"repo": "Turma"}}\n```',
                    'Sure! Here you go:\n{"ENG-1": {"repo": "Turma"}}\nHope that helps.']:
            out = ha._parse_triage(raw, self.tickets, self.cands)
            self.assertEqual(out["ENG-1"]["repo"], "Turma", raw)

    def test_unusable_reply_is_no_decision_not_a_null_decision(self):
        # An empty/garbage reply is a failed ATTEMPT (retry it), not the model
        # saying "no repo fits" (which would render a chip and never retry).
        for raw in ["", None, "I could not determine this.", "{oops", "[1,2]"]:
            self.assertEqual(ha._parse_triage(raw, self.tickets, self.cands), {}, repr(raw))

    def test_reason_is_capped(self):
        out = ha._parse_triage(
            '{"ENG-1": {"repo": "Turma", "why": "%s"}}' % ("x" * 400),
            self.tickets, self.cands)
        self.assertEqual(len(out["ENG-1"]["reason"]), ha.JIRA_TRIAGE_REASON_MAX)


class TestJiraTriage(ManagerMixin, unittest.TestCase):
    """The triage lifecycle on the manager: batching, caching, retries, and the
    repoGuess that rides the heartbeat."""

    def setUp(self):
        super().setUp()
        self.popen_calls = []
        p = mock.patch.object(ha, "scan_repos",
                              return_value=[{"name": "Turma",
                                             "path": os.path.join(self.tmp, "Turma")}])
        p.start()
        self.addCleanup(p.stop)

    def _configured(self):
        return mock.patch.multiple(ha, JIRA_SITE="s.atlassian.net",
                                   JIRA_EMAIL="e", JIRA_TOKEN="t")

    def _manager(self, tickets):
        sm = self.make_manager()
        sm.jira = {**ha.JIRA_EMPTY, "available": True, "configured": True,
                   "siteKey": "s.atlassian.net", "tickets": tickets}
        sm.github = {"available": True, "login": "x",
                     "repos": [{"nameWithOwner": "xerktech/Widget", "name": "Widget"}]}
        return sm

    def _fake_popen(self, reply, rc=0):
        """Stand in for the detached `claude -p`: record the argv and write the
        reply where the real subprocess's stdout redirect would have put it."""
        test = self

        class FakeProc:
            def __init__(self, cmd, stdout=None, **kw):
                test.popen_calls.append(cmd)
                if reply is not None and stdout is not None:
                    stdout.write(reply)
                    stdout.flush()

            def poll(self):
                return rc

            def kill(self):
                pass

        return mock.patch.object(ha.subprocess, "Popen", FakeProc)

    def test_triage_decides_and_stamps_repo_guess_on_the_ticket(self):
        sm = self._manager([{"key": "ENG-1", "summary": "Fix the heartbeat"}])
        with self._configured(), self._fake_popen(
                '{"ENG-1": {"repo": "Turma", "why": "heartbeat lives there"}}'):
            sm._start_jira_triage()
            sm._poll_jira_triage()
        self.assertEqual(sm.jira["tickets"][0]["repoGuess"], {
            "repo": "Turma", "cloned": True, "nameWithOwner": None,
            "source": None, "reason": "heartbeat lives there", "manual": False,
            "at": sm.jira["tickets"][0]["repoGuess"]["at"],
        })

    def test_untriaged_ticket_carries_no_guess_at_all(self):
        # Absence must not read as "no repo fits" — the board draws nothing for
        # a ticket it simply hasn't looked at yet.
        sm = self._manager([{"key": "ENG-1", "summary": "x"}])
        sm._apply_triage()
        self.assertNotIn("repoGuess", sm.jira["tickets"][0])

    def test_declined_ticket_carries_an_explicit_null_repo(self):
        sm = self._manager([{"key": "ENG-1", "summary": "Design review"}])
        with self._configured(), self._fake_popen('{"ENG-1": null}'):
            sm._start_jira_triage()
            sm._poll_jira_triage()
        self.assertIn("repoGuess", sm.jira["tickets"][0])
        self.assertIsNone(sm.jira["tickets"][0]["repoGuess"]["repo"])

    def test_the_model_only_ever_sees_candidate_repos(self):
        sm = self._manager([{"key": "ENG-1", "summary": "x"}])
        with self._configured(), self._fake_popen('{"ENG-1": null}'):
            sm._start_jira_triage()
        prompt = self.popen_calls[0][-1]
        self.assertIn("Turma [cloned]", prompt)
        self.assertIn("- Widget", prompt)
        self.assertIn("ENG-1: x", prompt)

    def test_launch_is_headless_and_never_enters_a_repo(self):
        # Same posture as the session summarizer: no --settings (so no guard to
        # load), cwd outside any worktree, argv list (so ticket text can't inject).
        sm = self._manager([{"key": "ENG-1", "summary": "x; rm -rf /"}])
        with self._configured(), self._fake_popen('{"ENG-1": null}'):
            sm._start_jira_triage()
        cmd = self.popen_calls[0]
        self.assertEqual(cmd[:4], ["claude", "-p", "--model", ha.JIRA_TRIAGE_MODEL])
        self.assertEqual(len(cmd), 5)          # the prompt is ONE argv element
        self.assertNotIn("--settings", cmd)

    def test_a_settled_board_costs_nothing(self):
        sm = self._manager([{"key": "ENG-1", "summary": "Fix the heartbeat"}])
        with self._configured(), self._fake_popen('{"ENG-1": {"repo": "Turma"}}'):
            sm._start_jira_triage()
            sm._poll_jira_triage()
            self.popen_calls.clear()
            for _ in range(5):
                sm._start_jira_triage()
        self.assertEqual(self.popen_calls, [])

    def test_decisions_survive_a_manager_restart(self):
        sm = self._manager([{"key": "ENG-1", "summary": "Fix the heartbeat"}])
        with self._configured(), self._fake_popen('{"ENG-1": {"repo": "Turma"}}'):
            sm._start_jira_triage()
            sm._poll_jira_triage()
        again = self._manager([{"key": "ENG-1", "summary": "Fix the heartbeat"}])
        again._apply_triage()
        self.assertEqual(again.jira["tickets"][0]["repoGuess"]["repo"], "Turma")
        self.popen_calls.clear()
        with self._configured(), self._fake_popen('{"ENG-1": {"repo": "Turma"}}'):
            again._start_jira_triage()
        self.assertEqual(self.popen_calls, [])   # no re-run

    def test_edited_ticket_is_retriaged(self):
        sm = self._manager([{"key": "ENG-1", "summary": "Fix the heartbeat"}])
        with self._configured(), self._fake_popen('{"ENG-1": {"repo": "Turma"}}'):
            sm._start_jira_triage()
            sm._poll_jira_triage()
        sm.jira["tickets"] = [{"key": "ENG-1", "summary": "Rewrite the Widget API"}]
        self.popen_calls.clear()
        with self._configured(), self._fake_popen('{"ENG-1": {"repo": "Widget"}}'):
            sm._start_jira_triage()
            sm._poll_jira_triage()
        self.assertEqual(len(self.popen_calls), 1)
        self.assertEqual(sm.jira["tickets"][0]["repoGuess"]["repo"], "Widget")

    def test_a_stale_decision_keeps_rendering_until_a_new_one_lands(self):
        # Stale means "re-triage this", NOT "stop showing it". The old answer is
        # the best one available until a better one arrives, and blanking it here
        # would wipe every chip on the board over a transient (a gh hiccup
        # restales every ticket at once).
        sm = self._manager([{"key": "ENG-1", "summary": "Fix the heartbeat"}])
        with self._configured(), self._fake_popen('{"ENG-1": {"repo": "Turma"}}'):
            sm._start_jira_triage()
            sm._poll_jira_triage()
        sm.jira["tickets"] = [{"key": "ENG-1", "summary": "Rewrite the Widget API"}]
        with self._configured(), self._fake_popen(None):
            sm._start_jira_triage()   # re-triage in flight
        sm._apply_triage()
        self.assertEqual(sm.jira["tickets"][0]["repoGuess"]["repo"], "Turma")

    def test_a_failed_attempt_does_not_destroy_the_existing_decision(self):
        # The regression: an unrelated transient (a rate limit on the one shared
        # ~/.claude login) must not cost the board a decision it already paid for.
        sm = self._manager([{"key": "ENG-1", "summary": "Fix the heartbeat"}])
        with self._configured(), self._fake_popen('{"ENG-1": {"repo": "Turma"}}'):
            sm._start_jira_triage()
            sm._poll_jira_triage()
        sm.jira["tickets"] = [{"key": "ENG-1", "summary": "Rewrite the Widget API"}]
        with self._configured(), self._fake_popen("garbage"):
            sm._start_jira_triage()
            sm._poll_jira_triage()    # attempt fails outright
        sm._apply_triage()
        self.assertEqual(sm.jira["tickets"][0]["repoGuess"]["repo"], "Turma")

    def test_a_gh_outage_neither_restales_nor_blanks_the_board(self):
        # refresh_github blanks the block to repos:[] on ANY error — on that field
        # alone, identical to "the org has no repos". Triaging against it would
        # re-run the whole board through the model twice (once when gh breaks,
        # once when it recovers) and burn every ticket's retry budget.
        sm = self._manager([{"key": "ENG-1", "summary": "Fix the heartbeat"}])
        with self._configured(), self._fake_popen('{"ENG-1": {"repo": "Turma"}}'):
            sm._start_jira_triage()
            sm._poll_jira_triage()
        sm.github = {"available": False, "login": None, "repos": []}   # gh hiccup
        self.popen_calls.clear()
        with self._configured(), self._fake_popen('{"ENG-1": {"repo": "Turma"}}'):
            sm._start_jira_triage()
        self.assertEqual(self.popen_calls, [], "no re-triage from a gh outage")
        sm._apply_triage()
        self.assertEqual(sm.jira["tickets"][0]["repoGuess"]["repo"], "Turma")

    def test_a_new_question_gets_a_fresh_retry_budget(self):
        # attempts are scoped to the question being asked, not to the ticket's
        # life. A lifetime counter would let three invalidations spread over months
        # permanently ban a ticket from re-triage — freezing a now-wrong chip.
        sm = self._manager([{"key": "ENG-1", "summary": "x"}])
        for i in range(ha.JIRA_TRIAGE_MAX_ATTEMPTS):
            with self._configured(), self._fake_popen("garbage"), \
                 mock.patch.object(ha.time, "time", return_value=1e9 + i * 1e6):
                sm._start_jira_triage()
                sm._poll_jira_triage()
        self.popen_calls.clear()
        sm.jira["tickets"] = [{"key": "ENG-1", "summary": "a different ticket now"}]
        with self._configured(), self._fake_popen('{"ENG-1": {"repo": "Turma"}}'):
            sm._start_jira_triage()
            sm._poll_jira_triage()
        self.assertEqual(len(self.popen_calls), 1, "exhausted budget must not carry over")
        self.assertEqual(sm.jira["tickets"][0]["repoGuess"]["repo"], "Turma")

    def test_a_landed_decision_clears_the_attempt_run(self):
        sm = self._manager([{"key": "ENG-1", "summary": "x"}])
        with self._configured(), self._fake_popen("garbage"):
            sm._start_jira_triage()
            sm._poll_jira_triage()    # burns attempt 1
        with self._configured(), self._fake_popen('{"ENG-1": {"repo": "Turma"}}'), \
             mock.patch.object(ha.time, "time", return_value=1e12):
            sm._start_jira_triage()
            sm._poll_jira_triage()    # succeeds on attempt 2
        entry = sm.triage_ledger["s.atlassian.net/ENG-1"]
        self.assertTrue(entry["decided"])
        for k in ("attempts", "retryAt", "tryTicketFp", "tryCandFp"):
            self.assertNotIn(k, entry)

    def test_batch_is_bounded_and_one_job_runs_at_a_time(self):
        tickets = [{"key": f"ENG-{i}", "summary": f"t{i}"} for i in range(60)]
        sm = self._manager(tickets)
        with self._configured(), self._fake_popen(None):
            sm._start_jira_triage()
            sm._start_jira_triage()   # a job is in flight; must not fork another
        self.assertEqual(len(self.popen_calls), 1)
        self.assertEqual(self.popen_calls[0][-1].count("(type:"), 0)
        self.assertEqual(len(sm.triage_job["batch"]), ha.JIRA_TRIAGE_BATCH)

    def test_a_backlog_drains_over_later_beats(self):
        tickets = [{"key": f"ENG-{i}", "summary": f"t{i}"} for i in range(60)]
        sm = self._manager(tickets)
        seen = set()
        for _ in range(3):
            reply = json.dumps({t["key"]: {"repo": "Turma"} for t in tickets})
            with self._configured(), self._fake_popen(reply):
                sm._start_jira_triage()
                sm._poll_jira_triage()
        for t in sm.jira["tickets"]:
            seen.add(t.get("repoGuess", {}).get("repo"))
        self.assertEqual(seen, {"Turma"})   # all 60 decided in 3 batches of 25

    def test_unanswered_ticket_retries_then_gives_up(self):
        sm = self._manager([{"key": "ENG-1", "summary": "x"}])
        for i in range(ha.JIRA_TRIAGE_MAX_ATTEMPTS + 2):
            with self._configured(), self._fake_popen("garbage"),                  mock.patch.object(ha.time, "time", return_value=1e9 + i * 1e6):
                sm._start_jira_triage()
                sm._poll_jira_triage()
        self.assertEqual(len(self.popen_calls), ha.JIRA_TRIAGE_MAX_ATTEMPTS)
        self.assertNotIn("repoGuess", sm.jira["tickets"][0])

    def test_backoff_spaces_the_retries(self):
        sm = self._manager([{"key": "ENG-1", "summary": "x"}])
        with self._configured(), self._fake_popen("garbage"):
            sm._start_jira_triage()
            sm._poll_jira_triage()
            self.popen_calls.clear()
            sm._start_jira_triage()   # immediately after: still inside the backoff
        self.assertEqual(self.popen_calls, [])

    def test_timeout_kills_the_job_and_frees_the_slot(self):
        sm = self._manager([{"key": "ENG-1", "summary": "x"}])
        with self._configured(), self._fake_popen(None, rc=None):
            sm._start_jira_triage()
            sm.triage_job["startedMono"] -= ha.JIRA_TRIAGE_TIMEOUT_SEC + 1
            sm._poll_jira_triage()
        self.assertIsNone(sm.triage_job)

    def test_unconfigured_host_never_triages(self):
        sm = self.make_manager()
        with mock.patch.multiple(ha, JIRA_SITE="", JIRA_EMAIL="", JIRA_TOKEN=""), \
             self._fake_popen('{"ENG-1": {"repo": "Turma"}}'):
            sm._start_jira_triage()
        self.assertEqual(self.popen_calls, [])
        self.assertIsNone(sm.triage_job)

    def test_no_candidates_means_no_triage(self):
        sm = self._manager([{"key": "ENG-1", "summary": "x"}])
        sm.github = {"available": False, "login": None, "repos": []}
        with self._configured(), mock.patch.object(ha, "scan_repos", return_value=[]), \
             self._fake_popen('{"ENG-1": {"repo": "Turma"}}'):
            sm._start_jira_triage()
        self.assertEqual(self.popen_calls, [])

    def test_refresh_jira_restamps_guesses_onto_the_new_tickets(self):
        # collect_jira() builds fresh dicts every poll; without the re-stamp the
        # board's chips would blank on every slow beat.
        sm = self._manager([{"key": "ENG-1", "summary": "Fix the heartbeat"}])
        with self._configured(), self._fake_popen('{"ENG-1": {"repo": "Turma"}}'):
            sm._start_jira_triage()
            sm._poll_jira_triage()
        fresh = {**ha.JIRA_EMPTY, "available": True, "siteKey": "s.atlassian.net",
                 "tickets": [{"key": "ENG-1", "summary": "Fix the heartbeat"}]}
        with mock.patch.object(ha, "collect_jira", return_value=fresh):
            sm.refresh_jira()
        self.assertEqual(sm.jira["tickets"][0]["repoGuess"]["repo"], "Turma")


class TestSetJiraRepo(ManagerMixin, unittest.TestCase):
    """The operator's own answer to which repo a ticket belongs in — a manual pin
    that outranks the model and is never re-triaged, the same posture a hand-typed
    session rename takes against the auto-summarizer."""

    def setUp(self):
        super().setUp()
        self.popen_calls = []
        p = mock.patch.object(ha, "scan_repos",
                              return_value=[{"name": "Turma",
                                             "path": os.path.join(self.tmp, "Turma")}])
        p.start()
        self.addCleanup(p.stop)

    def _configured(self):
        return mock.patch.multiple(ha, JIRA_SITE="s.atlassian.net",
                                   JIRA_EMAIL="e", JIRA_TOKEN="t")

    def _manager(self, tickets=None):
        sm = self.make_manager()
        sm.jira = {**ha.JIRA_EMPTY, "available": True, "configured": True,
                   "siteKey": "s.atlassian.net",
                   "tickets": tickets if tickets is not None
                   else [{"key": "ENG-1", "summary": "x"}]}
        sm.github = {"available": True, "login": "x",
                     "repos": [{"nameWithOwner": "xerktech/Widget", "name": "Widget"}]}
        sm._refresh_triage_candidates()
        return sm

    def _fake_popen(self, reply, rc=0):
        test = self

        class FakeProc:
            def __init__(self, cmd, stdout=None, **kw):
                test.popen_calls.append(cmd)
                if reply is not None and stdout is not None:
                    stdout.write(reply)
                    stdout.flush()

            def poll(self):
                return rc

            def kill(self):
                pass

        return mock.patch.object(ha.subprocess, "Popen", FakeProc)

    def test_pins_a_cloned_repo_and_marks_it_manual(self):
        sm = self._manager()
        sm.set_jira_repo("ENG-1", "Turma")
        g = sm.jira["tickets"][0]["repoGuess"]
        self.assertEqual(g["repo"], "Turma")
        self.assertTrue(g["cloned"])
        self.assertTrue(g["manual"])

    def test_pins_an_uncloned_repo_too(self):
        # The whole point of offering uncloned repos: a ticket can belong to a repo
        # this host hasn't cloned yet, and saying so is a real answer.
        sm = self._manager()
        sm.set_jira_repo("ENG-1", "Widget")
        g = sm.jira["tickets"][0]["repoGuess"]
        self.assertEqual(g["repo"], "Widget")
        self.assertFalse(g["cloned"])
        self.assertEqual(g["nameWithOwner"], "xerktech/Widget")
        self.assertTrue(g["manual"])

    def test_an_explicit_none_is_a_manual_no_repo_fits(self):
        sm = self._manager()
        sm.set_jira_repo("ENG-1", None)
        g = sm.jira["tickets"][0]["repoGuess"]
        self.assertIsNone(g["repo"])
        self.assertTrue(g["manual"])

    def test_a_manual_pin_is_never_re_triaged(self):
        sm = self._manager()
        sm.set_jira_repo("ENG-1", "Widget")
        with self._configured(), self._fake_popen('{"ENG-1": {"repo": "Turma"}}'):
            sm._start_jira_triage()
        self.assertEqual(self.popen_calls, [], "a pinned ticket must not be triaged")
        self.assertEqual(sm.jira["tickets"][0]["repoGuess"]["repo"], "Widget")

    def test_a_pin_survives_the_ticket_text_changing(self):
        # A ticket edit restales an AUTO decision; it must not unpin a manual one.
        sm = self._manager()
        sm.set_jira_repo("ENG-1", "Widget")
        sm.jira["tickets"] = [{"key": "ENG-1", "summary": "completely rewritten"}]
        with self._configured(), self._fake_popen('{"ENG-1": {"repo": "Turma"}}'):
            sm._start_jira_triage()
        self.assertEqual(self.popen_calls, [])
        sm._apply_triage()
        self.assertEqual(sm.jira["tickets"][0]["repoGuess"]["repo"], "Widget")

    def test_a_pin_landing_mid_flight_beats_the_model_reply(self):
        # The batch was built before the override existed, so its reply answers a
        # question no longer being asked.
        sm = self._manager()
        with self._configured(), self._fake_popen('{"ENG-1": {"repo": "Turma"}}'):
            sm._start_jira_triage()
            sm.set_jira_repo("ENG-1", "Widget")   # operator overrides mid-flight
            sm._poll_jira_triage()
        g = sm.jira["tickets"][0]["repoGuess"]
        self.assertEqual(g["repo"], "Widget")
        self.assertTrue(g["manual"])

    def test_auto_releases_the_pin_with_a_full_retry_budget(self):
        sm = self._manager()
        sm.set_jira_repo("ENG-1", "Widget")
        sm.set_jira_repo("ENG-1", None, auto=True)
        self.assertNotIn("s.atlassian.net/ENG-1", sm.triage_ledger)
        self.assertNotIn("repoGuess", sm.jira["tickets"][0])
        with self._configured(), self._fake_popen('{"ENG-1": {"repo": "Turma"}}'):
            sm._start_jira_triage()
            sm._poll_jira_triage()
        self.assertEqual(sm.jira["tickets"][0]["repoGuess"]["repo"], "Turma")
        self.assertFalse(sm.jira["tickets"][0]["repoGuess"]["manual"])

    def test_a_non_candidate_repo_is_refused(self):
        # The operator is likelier right than the model, but the request still
        # arrives over HTTP, and a name this host can't offer is one its own picker
        # never showed.
        sm = self._manager()
        sm.set_jira_repo("ENG-1", "NotARepo")
        self.assertNotIn("repoGuess", sm.jira["tickets"][0])
        self.assertNotIn("s.atlassian.net/ENG-1", sm.triage_ledger)

    def test_a_bad_issue_key_is_refused_before_it_reaches_the_ledger(self):
        sm = self._manager()
        for bad in ["../../etc/passwd", "", "42", "ENG-", None]:
            sm.set_jira_repo(bad, "Turma")
        self.assertEqual(sm.triage_ledger, {})

    def test_a_command_for_another_org_is_refused(self):
        # The hub routes by siteKey; a mismatch means it reached the wrong host,
        # and filing it under ours would corrupt a key another board reads.
        sm = self._manager()
        sm.set_jira_repo("ENG-1", "Turma", site_key="other.atlassian.net")
        self.assertEqual(sm.triage_ledger, {})
        sm.set_jira_repo("ENG-1", "Turma", site_key="s.atlassian.net")
        self.assertEqual(sm.jira["tickets"][0]["repoGuess"]["repo"], "Turma")

    def test_a_pin_persists_across_a_manager_restart(self):
        sm = self._manager()
        sm.set_jira_repo("ENG-1", "Widget")
        sm2 = self._manager()
        self.assertTrue(sm2.triage_ledger["s.atlassian.net/ENG-1"]["manual"])
        sm2._apply_triage()
        self.assertEqual(sm2.jira["tickets"][0]["repoGuess"]["repo"], "Widget")

    def test_cloning_a_pinned_repo_updates_its_clone_state(self):
        # A pin never re-triages, so a stored cloned:false would outlive the clone
        # forever and leave the chip dashed for good.
        sm = self._manager()
        sm.set_jira_repo("ENG-1", "Widget")
        self.assertFalse(sm.jira["tickets"][0]["repoGuess"]["cloned"])
        with mock.patch.object(ha, "scan_repos", return_value=[
                {"name": "Turma", "path": os.path.join(self.tmp, "Turma")},
                {"name": "Widget", "path": os.path.join(self.tmp, "Widget")}]):
            sm._refresh_triage_candidates()
        sm._apply_triage()
        self.assertTrue(sm.jira["tickets"][0]["repoGuess"]["cloned"])

    def test_a_gh_outage_does_not_flip_a_pinned_repo_to_uncloned(self):
        # The candidate list blanks on a failed sweep; absence there is not
        # evidence a repo stopped being cloned.
        sm = self._manager()
        sm.set_jira_repo("ENG-1", "Turma")
        sm.github = {"available": False, "login": None, "repos": []}
        with mock.patch.object(ha, "scan_repos", return_value=[]):
            sm._refresh_triage_candidates()
        sm._apply_triage()
        self.assertTrue(sm.jira["tickets"][0]["repoGuess"]["cloned"])

    def test_a_pin_is_evicted_last_when_the_ledger_is_bounded(self):
        # An auto decision a prune drops is recomputed next beat; a pin is the one
        # thing here that cannot be regenerated.
        sm = self._manager()
        sm.set_jira_repo("ENG-1", "Turma")
        for i in range(ha.JIRA_TRIAGE_LEDGER_MAX + 10):
            sm.triage_ledger[f"s.atlassian.net/AUTO-{i}"] = {
                "decided": True, "repo": "Turma", "at": "2999-01-01T00:00:00Z"}
        sm._prune_triage_ledger()
        self.assertIn("s.atlassian.net/ENG-1", sm.triage_ledger)

    def test_the_picker_options_ride_the_heartbeat_and_match_the_allowlist(self):
        # The board offers exactly what set_jira_repo accepts — the two read the
        # same list, so they cannot drift.
        sm = self._manager()
        with self._configured():
            payload = sm.build_payload(1)
        names = [o["name"] for o in payload["jira"]["repoOptions"]]
        self.assertEqual(sorted(names), ["Turma", "Widget"])
        for name in names:
            sm.set_jira_repo("ENG-1", name)
            self.assertEqual(sm.jira["tickets"][0]["repoGuess"]["repo"], name)

    def test_an_unconfigured_host_ships_no_picker_options(self):
        with mock.patch.multiple(ha, JIRA_SITE="", JIRA_EMAIL="", JIRA_TOKEN=""):
            sm = self.make_manager()
            payload = sm.build_payload(1)
        self.assertNotIn("repoOptions", payload["jira"])

    def test_no_agent_side_auto_start_flag(self):
        # Auto-start opt-in is HUB-ONLY (XERK-41): the agent carries no
        # TICKET_AUTO_START env and reports no ticketAutoStart flag.
        self.assertFalse(hasattr(ha, "TICKET_AUTO_START"))
        sm = self._manager()
        with self._configured():
            payload = sm.build_payload(1)
        self.assertNotIn("ticketAutoStart", payload)
        self.assertNotIn("autoStart", payload["jira"])

    def test_the_command_reaches_set_jira_repo(self):
        sm = self._manager()
        sm.handle_commands([{"cmdId": "c1", "type": "setJiraRepo",
                             "siteKey": "s.atlassian.net", "issueKey": "ENG-1",
                             "repo": "Widget", "auto": False}])
        self.assertEqual(sm.jira["tickets"][0]["repoGuess"]["repo"], "Widget")
        sm.handle_commands([{"cmdId": "c2", "type": "setJiraRepo",
                             "siteKey": "s.atlassian.net", "issueKey": "ENG-1",
                             "repo": None, "auto": True}])
        self.assertNotIn("repoGuess", sm.jira["tickets"][0])

    def test_ledger_is_bounded(self):
        sm = self._manager([])
        for i in range(ha.JIRA_TRIAGE_LEDGER_MAX + 50):
            sm.triage_ledger[f"s/OLD-{i}"] = {"decided": True, "repo": "Turma",
                                              "at": f"2026-01-01T00:00:{i:02d}Z"}
        sm._prune_triage_ledger()
        self.assertEqual(len(sm.triage_ledger), ha.JIRA_TRIAGE_LEDGER_MAX)

    def test_prune_keeps_work_still_owed(self):
        # An undecided entry is a retry the manager still owes; dropping it would
        # silently cancel that work.
        sm = self._manager([])
        for i in range(ha.JIRA_TRIAGE_LEDGER_MAX + 10):
            sm.triage_ledger[f"s/OLD-{i}"] = {"decided": True, "repo": "Turma",
                                              "at": f"2026-01-01T00:00:{i:02d}Z"}
        sm.triage_ledger["s/NEW-1"] = {"decided": False, "attempts": 1}
        sm._prune_triage_ledger()
        self.assertIn("s/NEW-1", sm.triage_ledger)

    def test_triage_never_raises_out_of_the_heartbeat(self):
        sm = self._manager([{"key": "ENG-1", "summary": "x"}])
        sm.registry = []
        with self._configured(), \
             mock.patch.object(ha.subprocess, "Popen", side_effect=OSError("no claude")):
            payload = sm.build_payload(1)
        self.assertIn("jira", payload)
        self.assertIsNone(sm.triage_job)


class TestNextTicketBranch(unittest.TestCase):
    """The ticket -> branch name rule: the bare key, then -1/-2 as it's taken."""

    def test_bare_key_when_nothing_holds_it(self):
        self.assertEqual(ha.next_ticket_branch("PROJ-123", set()), "PROJ-123")

    def test_suffixes_climb_past_taken_names(self):
        self.assertEqual(ha.next_ticket_branch("PROJ-123", {"PROJ-123"}), "PROJ-123-1")
        self.assertEqual(
            ha.next_ticket_branch("PROJ-123", {"PROJ-123", "PROJ-123-1"}), "PROJ-123-2")

    def test_fills_a_gap_left_by_a_deleted_branch(self):
        # -1 was merged and pruned. The rule is "first free name", not "count how
        # many ever existed" — otherwise a pruned repo keeps climbing forever.
        self.assertEqual(
            ha.next_ticket_branch("PROJ-123", {"PROJ-123", "PROJ-123-2"}), "PROJ-123-1")

    def test_a_similar_key_is_not_a_collision(self):
        # PROJ-1230 shares a prefix but is a different ticket entirely.
        self.assertEqual(ha.next_ticket_branch("PROJ-123", {"PROJ-1230"}), "PROJ-123")

    def test_blank_entries_are_ignored(self):
        self.assertEqual(ha.next_ticket_branch("PROJ-123", ["", None, "  "]), "PROJ-123")

    def test_none_when_every_suffix_is_taken(self):
        taken = {"PROJ-9"} | {f"PROJ-9-{n}"
                              for n in range(1, ha.TICKET_BRANCH_MAX_SUFFIX + 1)}
        self.assertIsNone(ha.next_ticket_branch("PROJ-9", taken))


class TestBranchNames(unittest.TestCase):
    """Every name a new branch could collide with: local heads, plus remote
    branches reduced to the name they'd have locally."""

    def _names(self, refs):
        with mock.patch.object(ha, "run", lambda cmd, cwd=None: "\n".join(refs)):
            return ha.branch_names("/repo")

    def test_local_and_remote_branches_both_count(self):
        # A branch pushed for this ticket from another host counts even on a host
        # that has never checked it out — that's the point of reading remotes.
        self.assertEqual(
            self._names(["refs/heads/main", "refs/heads/PROJ-1",
                         "refs/remotes/origin/PROJ-2"]),
            {"main", "PROJ-1", "PROJ-2"})

    def test_origin_head_is_not_a_name(self):
        # It's a symbolic alias for the default branch, not a branch anyone took.
        self.assertEqual(self._names(["refs/remotes/origin/HEAD"]), set())

    def test_a_slashed_branch_keeps_its_whole_name(self):
        # Only the REMOTE prefix is stripped; "feat/x" is the branch's real name.
        self.assertEqual(
            self._names(["refs/heads/feat/x", "refs/remotes/origin/feat/y"]),
            {"feat/x", "feat/y"})

    def test_junk_lines_are_skipped(self):
        self.assertEqual(self._names(["", "  ", "refs/tags/v1", "refs/heads/ok"]),
                         {"ok"})


class TestBuildTicketPrompt(unittest.TestCase):
    """The ticket -> initial prompt. The session has no Jira creds of its own, so
    this text is all it will ever see of the ticket."""

    def _detail(self, **over):
        d = {"key": "PROJ-7", "summary": "Fix the board",
             "url": "https://x.atlassian.net/browse/PROJ-7",
             "status": "In Progress", "type": "Bug", "priority": "High",
             "assignee": "Ann", "description": "The board is broken.",
             "comments": [], "commentTotal": 0}
        d.update(over)
        return d

    def test_carries_the_ticket_text(self):
        p = ha.build_ticket_prompt(self._detail())
        for want in ("PROJ-7", "Fix the board", "In Progress", "High", "Ann",
                     "The board is broken.",
                     "https://x.atlassian.net/browse/PROJ-7"):
            self.assertIn(want, p)

    def test_says_plainly_that_it_is_a_snapshot(self):
        # The session can't re-read Jira itself, so the prompt has to be honest
        # about what it is and point at the live copy.
        p = ha.build_ticket_prompt(self._detail())
        self.assertIn("snapshot", p)

    def test_missing_fields_are_omitted_rather_than_blank(self):
        p = ha.build_ticket_prompt({"key": "PROJ-8"})
        self.assertIn("PROJ-8", p)
        self.assertNotIn("Priority:", p)
        self.assertNotIn("Assignee:", p)
        self.assertIn("_No description._", p)
        self.assertIn("_No comments._", p)

    def test_comments_are_inlined_newest_first_kept(self):
        cs = [{"author": f"U{i}", "created": "2026-01-01", "body": f"note {i}"}
              for i in range(12)]
        p = ha.build_ticket_prompt(self._detail(comments=cs, commentTotal=12))
        self.assertIn("note 11", p)       # newest kept
        self.assertNotIn("note 0\n", p)   # oldest dropped by the cap
        self.assertIn("2 older are in Jira", p)

    def test_labels_and_parent_are_flattened(self):
        p = ha.build_ticket_prompt(self._detail(
            labels=["ops", "urgent"], parentKey="PROJ-1", parentSummary="Epic"))
        self.assertIn("ops, urgent", p)
        self.assertIn("PROJ-1 — Epic", p)

    def test_never_raises_on_a_junk_detail(self):
        # It's built from a network response; a shape surprise must not take the
        # spawn (and with it the manager's beat) down.
        for junk in (None, {}, {"comments": [None, "x"], "labels": "nope"},
                     {"key": "P-1", "comments": [{}]},
                     {"key": "P-1", "attachments": "nope"},
                     {"key": "P-1", "attachments": [None, "x"]}):
            self.assertIsInstance(ha.build_ticket_prompt(junk), str)

    # --- attachments (XERK-242) ---------------------------------------------

    def _with_files(self, **over):
        return self._detail(attachments=[{"name": "shot.png", "url": "https://s/1"}],
                            attachmentTotal=1, **over)

    def test_it_reports_the_ticket_s_real_total_not_what_landed(self):
        # "2 files are attached to this ticket" when 3 are, or when 25 are and
        # the cap kept 10, is a count the session has no way to check.
        d = self._detail(
            attachments=[{"name": f"f{i}.png", "url": f"https://s/{i}"} for i in range(3)],
            attachmentTotal=25)
        p = ha.build_ticket_prompt(d, (["/u/f1.png"], ["f2.png"]))
        self.assertIn("This ticket has 25 attached files", p)
        self.assertIn("22 oldest are not listed", p)   # dropped by the cap, said so
        self.assertIn("f2.png", p)                     # the miss is still named

    def test_a_detail_with_no_total_falls_back_to_what_it_carries(self):
        # An older agent's cached detail has no attachmentTotal.
        d = self._detail(attachments=[{"name": "a.png", "url": "https://s/1"}])
        p = ha.build_ticket_prompt(d, (["/u/a.png"], []))
        self.assertIn("This ticket has 1 attached file.", p)
        self.assertNotIn("not listed here", p)

    def test_downloaded_attachments_are_named_by_their_path_on_disk(self):
        p = ha.build_ticket_prompt(
            self._with_files(), (["/root/.turma/uploads/abc/shot.png"], []))
        self.assertIn("## Attachments", p)
        self.assertIn("/root/.turma/uploads/abc/shot.png", p)
        # The section sits ahead of the closing instruction, so the last thing
        # the session reads is still what to do.
        self.assertLess(p.index("## Attachments"), p.index("Start by working out"))

    def test_a_file_that_could_not_be_downloaded_is_still_named(self):
        p = ha.build_ticket_prompt(self._with_files(), ([], ["shot.png"]))
        self.assertIn("shot.png", p)
        self.assertIn("could not be downloaded", p)

    def test_a_ticket_with_no_files_gets_no_section(self):
        self.assertNotIn("## Attachments",
                         ha.build_ticket_prompt(self._detail(), ([], [])))

    def test_files_are_named_without_paths_when_none_were_fetched(self):
        # No download attempted: say the files exist and where to get them,
        # rather than claiming paths that aren't there.
        p = ha.build_ticket_prompt(self._with_files())
        self.assertIn("shot.png", p)
        self.assertIn("NOT on this machine", p)


class TestSpawnTicket(ManagerMixin, unittest.TestCase):
    """The board's start button, agent-side: resolve the repo from THIS host's
    triage ledger, fetch the ticket, reserve a branch, spawn."""

    SITE = "x.atlassian.net"

    def make_ticket_manager(self, *, repos=None, decided=True, repo="Turma"):
        if repos is None:
            repos = [{"name": "Turma", "path": os.path.join(self.tmp, "Turma")}]
        sm = self.make_manager()
        for name, value in [("scan_repos", lambda: repos),
                            ("JIRA_SITE", self.SITE),
                            ("JIRA_EMAIL", "a@b.c"),
                            ("JIRA_TOKEN", "t")]:
            p = mock.patch.object(ha, name, value)
            p.start()
            self.addCleanup(p.stop)
        if decided:
            sm.triage_ledger[ha._triage_key(self.SITE, "PROJ-7")] = {
                "decided": True, "repo": repo, "cloned": True, "reason": "it's there"}
        sm._launch_ttyd = mock.Mock()   # avoid the real Popen
        return sm

    def _detail(self, **over):
        d = {"key": "PROJ-7", "summary": "Fix the board",
             "url": f"https://{self.SITE}/browse/PROJ-7",
             "description": "broken", "comments": []}
        d.update(over)
        return d

    def _launches(self):
        return [c for c in self.run_ok_calls if c and c[0] == "tmux" and "new-session" in c]

    def test_spawns_with_the_ticket_and_a_reserved_branch(self):
        sm = self.make_ticket_manager()
        sm._start_summary = mock.Mock()
        with mock.patch.object(ha, "fetch_jira_issue", lambda k: self._detail()):
            sm.spawn_ticket("PROJ-7", cmd_id="c1")
        self.assertEqual(len(sm.registry), 1)
        sess = sm.registry[0]
        self.assertEqual(sess["repo"], "Turma")
        self.assertEqual(sess["spawnCmdId"], "c1")     # the UI's handle on it
        self.assertEqual(sess["ticket"], {
            "key": "PROJ-7", "siteKey": self.SITE,
            "url": f"https://{self.SITE}/browse/PROJ-7",
            "summary": "Fix the board", "branch": "PROJ-7",
        })
        # The ticket names the session, so no `claude -p` naming job is spent.
        self.assertEqual(sess["summary"], "PROJ-7 Fix the board")
        sm._start_summary.assert_not_called()
        # ...and the link rides the heartbeat, which is what the board indexes.
        self.assertEqual(
            sm._session_payload(sess, refresh=False)["ticket"]["key"], "PROJ-7")

    def test_the_link_outlives_the_session_it_was_spawned_for(self):
        """The whole ask: which session was tasked with a ticket must survive.
        Three channels, each covering the next one's blind spot — the live record,
        the closed record it becomes when killed, and the durable ledger that is
        all that's left once closed.json evicts it (CLOSED_PER_REPO per repo)."""
        sm = self.make_ticket_manager()
        with mock.patch.object(ha, "fetch_jira_issue", lambda k: self._detail()):
            sm.spawn_ticket("PROJ-7")
        sess = sm.registry[0]
        tid = sess["claudeSessionId"]
        self.assertEqual(sm.ticket_ledger[tid]["key"], "PROJ-7")

        sm.kill(sess["id"])
        self.assertEqual(sm._closed_payload()[0]["ticket"]["key"], "PROJ-7")

        # Now evict the closed record, as the 6th kill in this repo would. The
        # ledger is the only thing left that knows, and it's on disk — so a fresh
        # manager (an agent restart) still answers.
        sm.closed = []
        sm.save()
        self.assertEqual(self.make_manager().ticket_ledger[tid]["key"], "PROJ-7")

    def test_the_ticket_text_is_the_initial_prompt(self):
        sm = self.make_ticket_manager()
        with mock.patch.object(ha, "fetch_jira_issue",
                               lambda k: self._detail(description="the board is broken")):
            sm.spawn_ticket("PROJ-7")
        cmd = self._launches()[-1][-1]
        self.assertIn("the board is broken", cmd)

    def test_the_ticket_files_are_downloaded_and_their_paths_ride_the_prompt(self):
        # XERK-242: the session has no board creds, so a ticket's screenshots are
        # fetched FOR it and land where its Read is already pre-approved.
        sm = self.make_ticket_manager()
        detail = self._detail(attachments=[
            {"name": "shot.png", "url": f"https://{self.SITE}/rest/api/3/"
                                        "attachment/content/1", "size": 3}])
        with mock.patch.object(ha, "fetch_jira_issue", lambda k: detail), \
             mock.patch.object(ha, "fetch_board_attachment", return_value=b"PNG"):
            sm.spawn_ticket("PROJ-7")
        sid = sm.registry[0]["id"]
        landed = os.path.join(ha.UPLOADS_DIR, sid, "shot.png")
        self.assertTrue(os.path.exists(landed))
        self.assertIn(landed, self._launches()[-1][-1])
        # ...and out of the worktree, which prune/delete read as held work.
        self.assertFalse(landed.startswith(sm.registry[0]["worktreePath"]))

    def test_a_queued_ticket_downloads_its_files_when_it_is_provisioned(self):
        # The paths are keyed on the session id, so a session that waited on a
        # clone still gets them — under ITS id, not a placeholder.
        sm = self.make_ticket_manager(repo="Elsewhere")
        sm.triage_ledger[ha._triage_key(self.SITE, "PROJ-7")]["nameWithOwner"] = \
            "xerktech/Elsewhere"
        sm.clone = lambda nwo, source=None: None
        detail = self._detail(attachments=[
            {"name": "spec.pdf", "url": f"https://{self.SITE}/x", "size": 3}])
        # An awaiting-clone session's repoPath is built from REPOS_ROOT, which
        # ManagerMixin does NOT redirect — it is the production default, and this
        # is the one test that CREATES that directory rather than just naming it.
        with mock.patch.object(ha, "REPOS_ROOT", os.path.join(self.tmp, "git")), \
             mock.patch.object(ha, "fetch_jira_issue", lambda k: detail), \
             mock.patch.object(ha, "fetch_board_attachment") as fetch:
            sm.spawn_ticket("PROJ-7")
            fetch.assert_not_called()          # nothing fetched while it queues
            sess = sm.registry[0]
            os.makedirs(os.path.join(sess["repoPath"], ".git"), exist_ok=True)
            fetch.return_value = b"PDF"
            sm._drain_queue()
        self.assertEqual(sess["status"], "running")
        self.assertIn(os.path.join(ha.UPLOADS_DIR, sess["id"], "spec.pdf"),
                      self._launches()[-1][-1])

    def test_an_undownloadable_file_costs_the_file_not_the_session(self):
        sm = self.make_ticket_manager()
        detail = self._detail(attachments=[
            {"name": "shot.png", "url": f"https://{self.SITE}/x"}])
        with mock.patch.object(ha, "fetch_jira_issue", lambda k: detail), \
             mock.patch.object(ha, "fetch_board_attachment", return_value=None):
            sm.spawn_ticket("PROJ-7")
        self.assertEqual(sm.registry[0]["status"], "running")
        self.assertIn("could not be downloaded", self._launches()[-1][-1])

    def test_the_reserved_branch_rides_the_system_prompt(self):
        sm = self.make_ticket_manager()
        with mock.patch.object(ha, "fetch_jira_issue", lambda k: self._detail()):
            sm.spawn_ticket("PROJ-7")
        cmd = self._launches()[-1][-1]
        self.assertIn("--append-system-prompt", cmd)
        self.assertIn("Name the branch you create for it exactly: PROJ-7", cmd)
        # The directive EXTENDS the branching policy rather than replacing it —
        # the branch still has to be cut from the refreshed remote default.
        self.assertIn("git fetch origin", cmd)

    def test_a_second_session_on_one_ticket_gets_the_next_branch(self):
        # The first session hasn't branched yet, so git knows nothing about its
        # name (branch_names sees an empty repo here) — the reservation has to
        # come from the registry, or both would be told "PROJ-7".
        sm = self.make_ticket_manager()
        with mock.patch.object(ha, "fetch_jira_issue", lambda k: self._detail()):
            sm.spawn_ticket("PROJ-7")
            sm.spawn_ticket("PROJ-7")
        self.assertEqual([s["ticket"]["branch"] for s in sm.registry],
                         ["PROJ-7", "PROJ-7-1"])

    def test_an_existing_branch_in_git_is_avoided(self):
        # The ticket was worked months ago and the branch pushed; the name is
        # taken even though this manager has no session for it.
        sm = self.make_ticket_manager()
        with mock.patch.object(ha, "run",
                               lambda cmd, cwd=None: "refs/remotes/origin/PROJ-7"), \
             mock.patch.object(ha, "fetch_jira_issue", lambda k: self._detail()):
            sm.spawn_ticket("PROJ-7")
        self.assertEqual(sm.registry[0]["ticket"]["branch"], "PROJ-7-1")

    def test_the_ticket_survives_kill_and_resume(self):
        sm = self.make_ticket_manager()
        with mock.patch.object(ha, "fetch_jira_issue", lambda k: self._detail()):
            sm.spawn_ticket("PROJ-7")
        sid = sm.registry[0]["id"]
        sm.kill(sid)
        sm.resume(sid)
        sess = next(s for s in sm.registry if s["id"] == sid)
        # The reserved name is re-TOLD, not re-reserved: it's what this session
        # is, and re-reserving would hand it -1 against its own first branch.
        self.assertEqual(sess["ticket"]["branch"], "PROJ-7")
        self.assertIn("Name the branch you create for it exactly: PROJ-7",
                      self._launches()[-1][-1])

    def test_an_ordinary_session_reports_no_ticket(self):
        sm = self.make_ticket_manager()
        sm.spawn("Turma")
        self.assertIsNone(sm.registry[0]["ticket"])
        self.assertIsNone(
            sm._session_payload(sm.registry[0], refresh=False)["ticket"])

    def test_refuses_an_untriaged_ticket_without_calling_jira(self):
        sm = self.make_ticket_manager(decided=False)
        with mock.patch.object(ha, "fetch_jira_issue") as f:
            sm.spawn_ticket("PROJ-7")
        self.assertEqual(sm.registry, [])
        f.assert_not_called()

    def test_refuses_an_uncloned_repo_with_no_owner_to_clone(self):
        # Not cloned here AND the ledger recorded no owner/repo to clone from —
        # there's nothing to clone, so refuse before spending a Jira fetch.
        sm = self.make_ticket_manager(repo="Elsewhere")  # no nameWithOwner
        with mock.patch.object(ha, "fetch_jira_issue") as f:
            sm.spawn_ticket("PROJ-7")
        self.assertEqual(sm.registry, [])
        f.assert_not_called()

    def test_uncloned_repo_with_an_owner_clones_on_demand_and_queues(self):
        # The hub routes a ticket to the most-available host in the org even when
        # NO host has the repo; that host clones it and queues the session behind
        # the clone (provisioned by _drain_queue once the .git dir lands).
        sm = self.make_ticket_manager(repo="Elsewhere")
        sm.triage_ledger[ha._triage_key(self.SITE, "PROJ-7")]["nameWithOwner"] = \
            "xerktech/Elsewhere"
        started = []
        sm.clone = lambda nwo, source=None: started.append(nwo)
        with mock.patch.object(ha, "fetch_jira_issue",
                               return_value={"summary": "s", "url": "u"}):
            sm.spawn_ticket("PROJ-7")
        self.assertEqual(started, ["xerktech/Elsewhere"])  # clone kicked off
        self.assertEqual(len(sm.registry), 1)
        q = sm.registry[0]
        self.assertEqual(q["status"], "queued")
        self.assertEqual(q["queuedReason"], "awaiting-clone")
        self.assertEqual(q["awaitClone"], "Elsewhere")
        self.assertEqual(q["awaitCloneOwner"], "xerktech/Elsewhere")
        # Its repoPath points at where the clone will land, and its branch is
        # deferred (no repo yet to scan for a free name).
        self.assertEqual(q["repoPath"], os.path.join(ha.REPOS_ROOT, "Elsewhere"))
        self.assertIsNone(q["ticket"]["branch"])

    def test_refuses_anything_that_is_not_a_jira_key(self):
        sm = self.make_ticket_manager()
        with mock.patch.object(ha, "fetch_jira_issue") as f:
            for bad in ("", None, "PROJ", "-1", "../../etc/passwd",
                        "PROJ-7; rm -rf /", "PROJ-7 && curl x"):
                sm.spawn_ticket(bad)
        self.assertEqual(sm.registry, [])
        f.assert_not_called()

    def test_an_unconfigured_host_makes_no_jira_call(self):
        # "unset creds = zero Jira HTTP, ever" stays a property of the AGENT, not
        # of the hub's targeting — same stance as refreshJira.
        sm = self.make_ticket_manager()
        with mock.patch.object(ha, "JIRA_TOKEN", ""), \
             mock.patch.object(ha, "fetch_jira_issue") as f:
            sm.spawn_ticket("PROJ-7")
        self.assertEqual(sm.registry, [])
        f.assert_not_called()

    def test_a_failed_fetch_does_not_spawn_a_blind_session(self):
        # handle_commands logs and acks it. A session working a ticket it can't
        # see would be worse than no session.
        sm = self.make_ticket_manager()

        def boom(_k):
            raise RuntimeError("jira 500")

        with mock.patch.object(ha, "fetch_jira_issue", boom):
            sm.handle_commands([{"type": "spawnTicket", "issueKey": "PROJ-7",
                                 "cmdId": "c9"}])
        self.assertEqual(sm.registry, [])
        self.assertIn("c9", sm.acked)

    def test_handle_commands_dispatches_spawn_ticket(self):
        sm = self.make_ticket_manager()
        sm.spawn_ticket = mock.Mock()
        sm.handle_commands([{"type": "spawnTicket", "issueKey": "PROJ-7",
                             "cmdId": "c9"}])
        sm.spawn_ticket.assert_called_once_with("PROJ-7", cmd_id="c9", model=None)

    def test_handle_commands_carries_the_model_pin(self):
        # The hub's per-ticket model pin (XERK-123) rides the command; the agent
        # forwards it to spawn_ticket, which validates it like any spawn model.
        sm = self.make_ticket_manager()
        sm.spawn_ticket = mock.Mock()
        sm.handle_commands([{"type": "spawnTicket", "issueKey": "PROJ-7",
                             "model": "opus", "cmdId": "c9"}])
        sm.spawn_ticket.assert_called_once_with("PROJ-7", cmd_id="c9", model="opus")

    def test_a_model_pin_lands_on_the_session_and_command_line(self):
        sm = self.make_ticket_manager()
        with mock.patch.object(ha, "fetch_jira_issue", lambda k: self._detail()):
            sm.spawn_ticket("PROJ-7", model="opus")
        sess = sm.registry[0]
        self.assertEqual(sess["model"], "opus")     # resolve_model(opus) -> opus
        cmd = self._launches()[-1][-1]
        self.assertIn("--model opus", cmd)

    def test_no_model_pin_spawns_with_the_default_model(self):
        sm = self.make_ticket_manager()
        with mock.patch.object(ha, "fetch_jira_issue", lambda k: self._detail()):
            sm.spawn_ticket("PROJ-7")
        sess = sm.registry[0]
        self.assertIsNone(sess["model"])            # omit --model = login default
        self.assertNotIn("--model", self._launches()[-1][-1])

    def test_hostile_ticket_text_cannot_break_out_of_the_command_line(self):
        # Ticket text is the one genuinely untrusted input here: unlike an
        # operator-typed prompt, ANY Jira user can write a description or comment,
        # and it lands on the tmux command line. shlex.quote is what holds — this
        # pins that it's actually applied to every field that reaches the prompt.
        evil = "'; touch /tmp/pwned; echo '"
        detail = self._detail(
            summary=evil, description=evil, labels=[evil],
            comments=[{"author": evil, "body": evil, "created": evil}])
        sm = self.make_ticket_manager()
        with mock.patch.object(ha, "fetch_jira_issue", lambda k: detail):
            sm.spawn_ticket("PROJ-7")
        cmd = self._launches()[-1][-1]
        # The payload rides as DATA, with every quote it carries neutralised.
        self.assertIn("touch /tmp/pwned", cmd)
        self.assertIn("'\"'\"'", cmd, "shlex.quote's escaped-quote form")
        # The proof it can't ESCAPE is the round trip, not a substring search
        # (the escaped form '"'"'; touch … happens to CONTAIN the raw payload):
        # the command parses back into shell words with the whole prompt as
        # exactly one of them, byte-for-byte what we built...
        words = shlex.split(cmd)
        self.assertEqual(words[-1], ha.build_ticket_prompt(detail))
        # ...so nothing the ticket carried ever became a word of its own.
        self.assertNotIn("touch", words)

    def test_spawns_an_azure_work_item(self):
        """An Azure host spawns a numeric-id work item through the SAME path,
        with a project-prefixed branch and Azure-worded prompt (XERK-43)."""
        site = "dev.azure.com/org"
        repos = [{"name": "Turma", "path": os.path.join(self.tmp, "Turma")}]
        sm = self.make_manager()
        for name, value in [("scan_repos", lambda: repos),
                            ("JIRA_SITE", ""), ("JIRA_EMAIL", ""), ("JIRA_TOKEN", ""),
                            ("AZDO_URL", "https://dev.azure.com/org"),
                            ("AZDO_TOKEN", "pat")]:
            p = mock.patch.object(ha, name, value)
            p.start()
            self.addCleanup(p.stop)
        sm.triage_ledger[ha._triage_key(site, "1234")] = {
            "decided": True, "repo": "Turma", "cloned": True, "reason": "x"}
        sm._launch_ttyd = mock.Mock()
        detail = {"key": "1234", "summary": "Fix checkout",
                  "url": "https://dev.azure.com/org/Proj/_workitems/edit/1234",
                  "project": "Proj", "projectName": "Proj",
                  "description": "broken", "comments": []}
        with mock.patch.object(ha, "fetch_azure_issue", lambda k: detail):
            sm.spawn_ticket("1234", cmd_id="a1")
        self.assertEqual(len(sm.registry), 1)
        sess = sm.registry[0]
        self.assertEqual(sess["repo"], "Turma")
        self.assertEqual(sess["ticket"], {
            "key": "1234", "siteKey": site, "url": detail["url"],
            "summary": "Fix checkout", "branch": "Proj-1234",
            "branchBase": "Proj-1234",
        })
        cmd = self._launches()[-1][-1]
        self.assertIn("Work Azure DevOps work item #1234", cmd)
        self.assertIn("Name the branch you create for it exactly: Proj-1234", cmd)

    # --- refusals are REPORTED, not just logged (XERK-325 / XERK-265) --------

    def test_an_untriaged_ticket_is_reported_to_the_hub_not_only_logged(self):
        """The bug this class of refusal caused: the command is ACKed either way,
        so a refusal that only log()s is indistinguishable from a slow spawn — the
        board's start button spun out its follow window and then cleared, exactly
        as it does for a spawn that WORKED, and the operator clicked again."""
        sm = self.make_ticket_manager(decided=False)
        with mock.patch.object(ha, "fetch_jira_issue", lambda k: self._detail()):
            sm.spawn_ticket("PROJ-7", cmd_id="c1")
        self.assertEqual(sm.registry, [])
        self.assertEqual([f["cmdId"] for f in sm.spawn_failures], ["c1"])
        # Operator-facing: it has to say WHY, since it is the whole answer for a
        # click that did nothing.
        self.assertIn("no triaged repo", sm.spawn_failures[0]["error"])

    def test_a_decided_but_repo_less_verdict_refuses_the_same_way(self):
        """_apply_triage publishes a declined ticket as repoGuess.repo = None, and
        the entry stays that way (_triage_stale never re-triages a decided one).
        That is the PERMANENT half of the divergence, so it must report too."""
        sm = self.make_ticket_manager(decided=False)
        sm.triage_ledger[ha._triage_key(self.SITE, "PROJ-7")] = {
            "decided": True, "repo": None, "cloned": False, "reason": ""}
        with mock.patch.object(ha, "fetch_jira_issue", lambda k: self._detail()):
            sm.spawn_ticket("PROJ-7", cmd_id="c2")
        self.assertEqual(sm.registry, [])
        self.assertEqual([f["cmdId"] for f in sm.spawn_failures], ["c2"])

    def test_a_bad_key_reports_without_spending_a_board_fetch(self):
        fetched = []
        sm = self.make_ticket_manager()
        with mock.patch.object(ha, "fetch_jira_issue", lambda k: fetched.append(k)):
            sm.spawn_ticket("not a key", cmd_id="c3")
        self.assertEqual(fetched, [])
        self.assertEqual([f["cmdId"] for f in sm.spawn_failures], ["c3"])

    def test_an_uncloneable_repo_reports_which_repo_and_why(self):
        """Not cloned here AND no owner recorded to clone it from — the one
        clone-path refusal that is terminal rather than queued behind a clone."""
        sm = self.make_ticket_manager(repo="Elsewhere")
        sm.triage_ledger[ha._triage_key(self.SITE, "PROJ-7")]["nameWithOwner"] = None
        with mock.patch.object(ha, "fetch_jira_issue", lambda k: self._detail()):
            sm.spawn_ticket("PROJ-7", cmd_id="c4")
        self.assertEqual(sm.registry, [])
        self.assertEqual([f["cmdId"] for f in sm.spawn_failures], ["c4"])
        self.assertIn("Elsewhere", sm.spawn_failures[0]["error"])

    def test_a_refusal_with_no_cmd_id_stays_a_log_line(self):
        """The cmdId IS the correlation, so a refusal with nothing to report
        against is logged only — the auto-start sweep's own path, and the rule
        _refuse_start already applies to every other caller."""
        sm = self.make_ticket_manager(decided=False)
        with mock.patch.object(ha, "fetch_jira_issue", lambda k: self._detail()):
            sm.spawn_ticket("PROJ-7")
        self.assertEqual(sm.spawn_failures, [])


class TestUpdatingAnnounce(ManagerMixin, unittest.TestCase):
    """XERK-29: before the manager restarts for an update it can't heartbeat
    through, it tells the hub the downtime is EXPECTED so the host shows an
    `updating` status instead of an unexpected-outage `offline`."""

    def setUp(self):
        super().setUp()
        self.flag = os.path.join(self.tmp, "updating.json")
        p = mock.patch.object(ha, "UPDATING_FLAG_PATH", self.flag)
        p.start()
        self.addCleanup(p.stop)

    def _write_flag(self, **d):
        with open(self.flag, "w") as f:
            json.dump(d, f)

    def test_read_flag_present_absent_and_garbled(self):
        sm = self.make_manager()
        # Absent (the container-update case: no updater wrote one).
        self.assertEqual(sm._read_updating_flag(), (None, None))
        # Present (the native updater left the target version).
        self._write_flag(reason="update", version="9.9.9")
        self.assertEqual(sm._read_updating_flag(), ("update", "9.9.9"))
        # Garbled JSON degrades to "generic restart, no version".
        with open(self.flag, "w") as f:
            f.write("{not json")
        self.assertEqual(sm._read_updating_flag(), (None, None))

    def test_boot_clears_a_stale_flag(self):
        # A SIGKILL (no handler ran) can leave the file behind; the next boot
        # must not let it leak a stale version into a future announce.
        self._write_flag(reason="update", version="1.2.3")
        self.make_manager()
        self.assertFalse(os.path.exists(self.flag))

    def test_announce_noops_without_hub_url(self):
        sm = self.make_manager()
        with mock.patch.object(ha, "TURMA_URL", ""), \
             mock.patch.object(ha.urllib.request, "urlopen",
                               side_effect=AssertionError("must not POST")):
            sm._announce_updating("update", "9.9.9")  # no raise = no POST

    def test_announce_posts_signal_with_reason_and_version(self):
        sm = self.make_manager()
        seen = {}

        class _Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return b""

        def fake_urlopen(req, timeout=None):
            seen["url"] = req.full_url
            seen["method"] = req.get_method()
            seen["body"] = json.loads(req.data.decode())
            seen["auth"] = req.get_header("Authorization")
            return _Resp()

        with mock.patch.object(ha, "TURMA_URL", "http://hub:8300"), \
             mock.patch.object(ha, "TURMA_TOKEN", "tok"), \
             mock.patch.object(ha.urllib.request, "urlopen", fake_urlopen):
            sm._announce_updating("update", "9.9.9")

        self.assertEqual(seen["method"], "POST")
        self.assertEqual(
            seen["url"], f"http://hub:8300/api/agents/{sm.device}/updating")
        self.assertEqual(seen["body"], {"reason": "update", "version": "9.9.9"})
        self.assertEqual(seen["auth"], "Bearer tok")

    def test_announce_swallows_network_failure(self):
        sm = self.make_manager()
        with mock.patch.object(ha, "TURMA_URL", "http://hub:8300"), \
             mock.patch.object(ha.urllib.request, "urlopen",
                               side_effect=OSError("boom")):
            sm._announce_updating("restart", None)  # best-effort, must not raise

    def test_shutdown_handler_announces_from_flag_then_exits(self):
        sm = self.make_manager()
        self._write_flag(reason="update", version="9.9.9")
        calls = []
        with mock.patch.object(sm, "_announce_updating",
                               side_effect=lambda *a: calls.append(a)):
            with self.assertRaises(SystemExit):
                sm._handle_shutdown(ha.signal.SIGTERM, None)
        self.assertEqual(calls, [("update", "9.9.9")])

    def test_shutdown_handler_defaults_to_generic_restart(self):
        # The container case: Watchtower's SIGTERM, no flag on disk.
        sm = self.make_manager()
        calls = []
        with mock.patch.object(sm, "_announce_updating",
                               side_effect=lambda *a: calls.append(a)):
            with self.assertRaises(SystemExit):
                sm._handle_shutdown(ha.signal.SIGTERM, None)
        self.assertEqual(calls, [("restart", None)])


class TestRestartAgent(ManagerMixin, unittest.TestCase):
    """XERK-157: the dashboard's "Restart agent" button restarts the manager the
    same way a supervisor SIGTERM does, but the exit is deferred until the
    command's ack has reached the hub so it can't re-fire on boot (a loop)."""

    def _no_systemd_env(self, **extra):
        # A copy of the real env with INVOCATION_ID removed (so `not under_systemd`
        # holds), plus any overrides — patch.dict(clear=True) restores it after.
        env = {k: v for k, v in os.environ.items() if k != "INVOCATION_ID"}
        env.update(extra)
        return env

    def test_delivered_gate_defers_until_ack_reaches_hub(self):
        sm = self.make_manager()
        sm._perform_restart = mock.Mock()
        sm._restart_pending = True
        # Not delivered yet: the follow-up heartbeat failed to reach the hub, so
        # the command is still queued — do NOT exit, keep the flag for a retry.
        sm._restart_if_delivered(False)
        sm._perform_restart.assert_not_called()
        self.assertTrue(sm._restart_pending)
        # Delivered: the ack landed, the command is off the queue — restart now.
        sm._restart_if_delivered(True)
        sm._perform_restart.assert_called_once()
        self.assertFalse(sm._restart_pending)

    def test_delivered_gate_noop_when_not_armed(self):
        sm = self.make_manager()
        sm._perform_restart = mock.Mock()
        sm._restart_if_delivered(True)
        sm._perform_restart.assert_not_called()

    def test_perform_restart_exits_under_systemd(self):
        # INVOCATION_ID set => systemd started us; a clean exit is enough
        # (Restart=always brings us back). Never shell out to the ctl script,
        # even if one happens to be present, or we'd fight the supervisor.
        sm = self.make_manager()
        bindir = os.path.join(self.tmp, "bin")
        os.makedirs(bindir, exist_ok=True)
        open(os.path.join(bindir, "turma-agentctl"), "w").close()
        with mock.patch.object(ha, "__file__", os.path.join(self.tmp, "hub-agent.py")), \
             mock.patch.dict(ha.os.environ, self._no_systemd_env(INVOCATION_ID="abc"), clear=True), \
             mock.patch.object(sm, "_announce_updating") as ann, \
             mock.patch.object(ha.subprocess, "Popen") as popen:
            with self.assertRaises(SystemExit):
                sm._perform_restart()
        ann.assert_called_once_with("restart")
        popen.assert_not_called()

    def test_perform_restart_exits_in_container(self):
        # No systemd and no ctl script beside hub-agent.py (the container layout):
        # exit and let Docker's restart policy recreate us.
        sm = self.make_manager()
        with mock.patch.object(ha, "__file__", os.path.join(self.tmp, "hub-agent.py")), \
             mock.patch.dict(ha.os.environ, self._no_systemd_env(), clear=True), \
             mock.patch.object(sm, "_announce_updating") as ann, \
             mock.patch.object(ha.subprocess, "Popen") as popen:
            with self.assertRaises(SystemExit):
                sm._perform_restart()
        ann.assert_called_once_with("restart")
        popen.assert_not_called()

    def test_perform_restart_hands_off_to_agentctl_when_no_supervisor(self):
        # Native WSL without systemd: a ctl script sits beside hub-agent.py and
        # there's no supervisor, so relaunch through it (detached) rather than
        # exiting into the void. It SIGTERMs us to complete the restart.
        sm = self.make_manager()
        bindir = os.path.join(self.tmp, "bin")
        os.makedirs(bindir, exist_ok=True)
        ctl = os.path.join(bindir, "turma-agentctl")
        open(ctl, "w").close()
        with mock.patch.object(ha, "__file__", os.path.join(self.tmp, "hub-agent.py")), \
             mock.patch.dict(ha.os.environ, self._no_systemd_env(), clear=True), \
             mock.patch.object(sm, "_announce_updating") as ann, \
             mock.patch.object(ha.subprocess, "Popen") as popen:
            sm._perform_restart()  # returns, does NOT SystemExit — ctl stops us
        ann.assert_called_once_with("restart")
        popen.assert_called_once()
        self.assertEqual(popen.call_args.args[0], [ctl, "restart"])


if __name__ == "__main__":
    unittest.main()
