#!/usr/bin/env python3
"""Unit tests for agent/hub-agent.py (stdlib unittest only — mirrors the
image's no-pip stance; CI runs `python3 -m unittest discover -s agent/tests`).

The module is imported by file path (its name has a dash) and its module-level
constants (PROJECTS_ROOT, REGISTRY_PATH, ...) are patched per-test, so no test
ever touches /root or the real registry. SessionManager's subprocess use is
faked at its two chokepoints, run()/run_ok(), plus Popen for ttyd — no
docker/tmux/git needed.
"""

import datetime
import importlib.util
import io
import json
import os
import shlex
import shutil
import signal
import struct
import sys
import tempfile
import time
import unittest
from collections import deque
from unittest import mock

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE_PATH = os.path.join(AGENT_DIR, "hub-agent.py")

spec = importlib.util.spec_from_file_location("hub_agent", MODULE_PATH)
ha = importlib.util.module_from_spec(spec)
sys.modules["hub_agent"] = ha
spec.loader.exec_module(ha)


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
        for bad in ("gpt-4", "opus; rm", "claude-3"):
            with self.assertRaises(ValueError):
                ha.resolve_model(bad)

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


class TestLastEntry(ProjectDirMixin, unittest.TestCase):
    def test_skips_truncated_tail(self):
        path = os.path.join(self.proj, "t.jsonl")
        write_jsonl(path, [{"type": "assistant", "n": 1}, {"type": "assistant", "n": 2}])
        with open(path, "a") as f:
            f.write('{"type":"assistant","n":3')  # partial write, no newline
        self.assertEqual(ha._last_entry(path)["n"], 2)

    def test_missing_file(self):
        self.assertIsNone(ha._last_entry(os.path.join(self.proj, "nope.jsonl")))


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


class TestSessionReportPaneBusy(ProjectDirMixin, unittest.TestCase):
    """session_report surfaces the pane probe as report['paneBusy'] on every
    return path (even before any transcript exists)."""

    def test_pane_busy_reported_with_transcript(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [{"type": "assistant",
                            "message": {"content": [{"type": "text", "text": "hi"}]}}])
        with mock.patch.object(ha, "_pane_busy", return_value=True) as pb:
            rep = ha.session_report(self.WORKDIR, {}, "agent-abc")
        self.assertIs(rep["paneBusy"], True)
        pb.assert_called_once_with("agent-abc")

    def test_pane_busy_reported_without_transcript(self):
        # No transcript yet — paneBusy must still ride the early-return path.
        with mock.patch.object(ha, "_pane_busy", return_value=False):
            rep = ha.session_report("/absent/worktree", {}, "agent-abc")
        self.assertIs(rep["paneBusy"], False)

    def test_pane_busy_defaults_none_without_tmux(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [{"type": "assistant",
                            "message": {"content": [{"type": "text", "text": "hi"}]}}])
        rep = ha.session_report(self.WORKDIR, {})  # no tmux_name
        self.assertIsNone(rep["paneBusy"])


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
            ha._entry_blocks({"type": "user", "message": {"content": "hi"}}, ha.BLOCK_CAPS_LIVE),
            [{"t": "text", "text": "hi"}],
        )

    def test_preserves_thinking_tool_input_and_pairing(self):
        entry = {"type": "assistant", "message": {"content": [
            {"type": "thinking", "thinking": "pon\x1b[0mder"},
            {"type": "text", "text": "answer"},
            {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "ls -la", "timeout": 5}},
        ]}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS_LIVE), [
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
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS_LIVE), [
            {"t": "tool_result", "text": "boom", "forId": "toolu_1", "isError": True},
        ])
        self.assertIsNone(ha._entry_text(entry))  # unchanged: tool_result-only -> None

    def test_unknown_tool_input_falls_back_to_compact_json(self):
        blocks = ha._entry_blocks(
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "name": "X", "input": {"a": 1, "b": "z"}}]}},
            ha.BLOCK_CAPS_LIVE,
        )
        self.assertEqual(blocks, [{"t": "tool_use", "name": "X", "input": '{"a":1,"b":"z"}'}])

    def test_over_cap_text_and_result_truncated(self):
        big = "x" * (ha.BLOCK_CAPS_LIVE["text"] + 500)
        tb = ha._entry_blocks({"type": "assistant", "message": {"content": big}}, ha.BLOCK_CAPS_LIVE)[0]
        self.assertEqual(len(tb["text"]), ha.BLOCK_CAPS_LIVE["text"])
        self.assertTrue(tb["truncated"])

        big_out = "y" * (ha.BLOCK_CAPS_LIVE["result"] + 500)
        rb = ha._entry_blocks(
            {"type": "user", "message": {"content": [{"type": "tool_result", "content": big_out}]}},
            ha.BLOCK_CAPS_LIVE,
        )[0]
        self.assertEqual(len(rb["text"]), ha.BLOCK_CAPS_LIVE["result"])
        self.assertTrue(rb["truncated"])

    def test_wrong_type_and_no_message_return_none_empty_content_empty_list(self):
        self.assertIsNone(ha._entry_blocks({"type": "summary", "message": {"content": "x"}}, ha.BLOCK_CAPS_LIVE))
        self.assertIsNone(ha._entry_blocks({"type": "user"}, ha.BLOCK_CAPS_LIVE))
        self.assertEqual(ha._entry_blocks({"type": "assistant", "message": {"content": ""}}, ha.BLOCK_CAPS_LIVE), [])


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
        })

    def test_non_notification_text_is_not_parsed(self):
        self.assertIsNone(ha._parse_task_notification("just a normal prompt"))
        self.assertIsNone(ha._parse_task_notification("talk about <task-notification> inline"))
        self.assertIsNone(ha._parse_task_notification(""))

    def test_blocks_emit_task_notification_from_string_content(self):
        entry = {"type": "user", "message": {"content": TASK_NOTIFICATION}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS_LIVE), [{
            "t": "task_notification",
            "summary": 'Agent "Confirm merge semantics" finished',
            "status": "completed",
            "result": "The --settings file is merged as a higher-precedence layer.",
        }])

    def test_blocks_emit_task_notification_from_list_text_block(self):
        entry = {"type": "user", "message": {"content": [
            {"type": "text", "text": TASK_NOTIFICATION}]}}
        blocks = ha._entry_blocks(entry, ha.BLOCK_CAPS_LIVE)
        self.assertEqual(blocks[0]["t"], "task_notification")
        self.assertEqual(blocks[0]["summary"], 'Agent "Confirm merge semantics" finished')

    def test_background_command_form_has_no_result(self):
        text = (
            "<task-notification>\n<status>completed</status>\n"
            "<summary>Background command finished (exit code 0)</summary>\n"
            "</task-notification>"
        )
        blocks = ha._entry_blocks({"type": "user", "message": {"content": text}}, ha.BLOCK_CAPS_LIVE)
        self.assertEqual(blocks, [{
            "t": "task_notification",
            "summary": "Background command finished (exit code 0)",
            "status": "completed",
        }])

    def test_long_result_is_capped_and_truncated(self):
        big = "z" * (ha.BLOCK_CAPS_LIVE["result"] + 500)
        text = f"<task-notification>\n<summary>done</summary>\n<result>{big}</result>\n</task-notification>"
        block = ha._entry_blocks({"type": "user", "message": {"content": text}}, ha.BLOCK_CAPS_LIVE)[0]
        self.assertEqual(len(block["result"]), ha.BLOCK_CAPS_LIVE["result"])
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
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS_LIVE), [])
        self.assertIsNone(ha._entry_text(entry))

    def test_blocks_emit_command_from_string_and_list_content(self):
        expected = [{"t": "command", "name": "/compact", "args": "summaries appear as user text"}]
        self.assertEqual(
            ha._entry_blocks({"type": "user", "message": {"content": COMMAND_INVOCATION}},
                             ha.BLOCK_CAPS_LIVE),
            expected)
        self.assertEqual(
            ha._entry_blocks({"type": "user", "message": {"content": [
                {"type": "text", "text": COMMAND_INVOCATION}]}}, ha.BLOCK_CAPS_LIVE),
            expected)

    def test_blocks_omit_empty_args(self):
        text = "<command-name>/clear</command-name>\n<command-args></command-args>"
        self.assertEqual(ha._entry_blocks({"type": "user", "message": {"content": text}},
                                          ha.BLOCK_CAPS_LIVE),
                         [{"t": "command", "name": "/clear"}])

    def test_blocks_emit_command_output(self):
        entry = {"type": "user", "message": {"content": COMMAND_STDOUT}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS_LIVE),
                         [{"t": "command_output", "text": "Compacted (ctrl+o to see full summary)"}])

    def test_blocks_flag_stderr_output_as_an_error(self):
        entry = {"type": "user", "message": {"content":
                 "<local-command-stderr>Error: No messages to compact</local-command-stderr>"}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS_LIVE),
                         [{"t": "command_output", "text": "Error: No messages to compact",
                           "isError": True}])

    def test_empty_output_yields_no_block(self):
        entry = {"type": "user", "message": {"content":
                 "<local-command-stdout></local-command-stdout>"}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS_LIVE), [])
        self.assertIsNone(ha._entry_text(entry))

    def test_long_output_is_capped_and_truncated(self):
        big = "z" * (ha.BLOCK_CAPS_LIVE["result"] + 500)
        entry = {"type": "user", "message": {"content":
                 f"<local-command-stdout>{big}</local-command-stdout>"}}
        block = ha._entry_blocks(entry, ha.BLOCK_CAPS_LIVE)[0]
        self.assertEqual(len(block["text"]), ha.BLOCK_CAPS_LIVE["result"])
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
        self.assertEqual(ha._entry_blocks(self._entry(), ha.BLOCK_CAPS_FULL),
                         [{"t": "compact_summary", "text": self.SUMMARY}])

    def test_an_ordinary_user_turn_stays_a_text_block(self):
        entry = {"type": "user", "message": {"content": self.SUMMARY}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS_FULL),
                         [{"t": "text", "text": self.SUMMARY}])

    def test_long_summary_is_capped_and_truncated(self):
        big = "z" * (ha.BLOCK_CAPS_LIVE["text"] + 500)
        entry = {"type": "user", "isCompactSummary": True, "message": {"content": big}}
        block = ha._entry_blocks(entry, ha.BLOCK_CAPS_LIVE)[0]
        self.assertEqual(block["t"], "compact_summary")
        self.assertEqual(len(block["text"]), ha.BLOCK_CAPS_LIVE["text"])
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
        self.assertEqual(ha._entry_blocks(self._entry(), ha.BLOCK_CAPS_FULL),
                         [{"t": "tool_result", "text": self.BODY, "forId": "toolu_01ABC"}])

    def test_the_same_body_typed_by_a_human_stays_a_text_block(self):
        # Only the tool tag makes it tool output — pasting a skill body by hand
        # is the operator talking, and must still read as a user bubble.
        entry = {"type": "user", "message": {"content": [{"type": "text", "text": self.BODY}]}}
        self.assertEqual(ha._entry_blocks(entry, ha.BLOCK_CAPS_FULL),
                         [{"t": "text", "text": self.BODY}])

    def test_a_long_body_is_capped_and_truncated(self):
        entry = self._entry()
        big = "z" * (ha.BLOCK_CAPS_LIVE["result"] + 500)
        entry["message"]["content"] = [{"type": "text", "text": big}]
        block = ha._entry_blocks(entry, ha.BLOCK_CAPS_LIVE)[0]
        self.assertEqual(block["t"], "tool_result")
        self.assertEqual(len(block["text"]), ha.BLOCK_CAPS_LIVE["result"])
        self.assertTrue(block["truncated"])

    def test_entry_text_drops_it_like_any_tool_result(self):
        # The text feed (glasses tail, heartbeat preview, archive index) carries
        # no tool results; the assistant's own "[Skill]" marker already shows the
        # invocation, so dropping the wall costs it nothing.
        self.assertIsNone(ha._entry_text(self._entry()))


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
        entries, capped = ha._history_entries(path)
        self.assertFalse(capped)
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

        def fake_run(cmd, cwd=None):
            self.run_calls.append(cmd)
            return ""

        def fake_run_ok(cmd, cwd=None, timeout=None):
            self.run_ok_calls.append(cmd)
            return 0, ""

        for name, value in [
            ("run", fake_run),
            ("run_ok", fake_run_ok),
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
        ]:
            p = mock.patch.object(ha, name, value)
            p.start()
            self.addCleanup(p.stop)

    def make_manager(self):
        return ha.SessionManager()


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


class TestReconcileOrphanTranscripts(ManagerMixin, unittest.TestCase):
    """Usage counts EVERY transcript on disk, not only ledger-known slugs: an
    orphan transcript (session aged out of closed.json, or predating the ledger)
    is adopted with best-effort attribution, and nothing is excluded — an
    unattributable one still counts under OTHER_REPO_NAME."""

    def setUp(self):
        super().setUp()
        # Keep REPOS_ROOT (repos-root pseudo-repo + case-2 remote lookup) inside
        # the temp tree instead of the unpatched production default.
        p = mock.patch.object(ha, "REPOS_ROOT", os.path.join(self.tmp, "git"))
        p.start()
        self.addCleanup(p.stop)

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
        # .turma/worktrees/<repo>/<id> shape, so the repo is recovered from it.
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
        # slug still names the repo — attributed, not lumped into (other).
        wt = "/repos/.agenthub/worktrees/AgentHub/10ab3"
        proj = self._write_transcript(wt)
        sm = self.make_manager()
        sm._reconcile_orphan_transcripts()
        self.assertEqual(sm.usage_ledger[proj]["repo"], "AgentHub")

    def test_repo_recovered_from_transcript_cwd(self):
        # No worktree and no worktrees-shaped slug, but the transcript records
        # its cwd (e.g. an operator's dev-machine session, Windows path) — the
        # repo is read from there, not lumped into (other).
        wt = "/home/me/OneDrive/personal/Foverlay"
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(wt))
        os.makedirs(proj, exist_ok=True)
        write_jsonl(os.path.join(proj, "t.jsonl"), [
            {"type": "user", "cwd": "C:\\Users\\me\\personal\\Foverlay",
             "message": {"role": "user", "content": "hi"}},
        ])
        sm = self.make_manager()
        sm._reconcile_orphan_transcripts()
        self.assertEqual(sm.usage_ledger[proj]["repo"], "Foverlay")

    def test_unattributable_bucketed_as_other(self):
        # No worktree, no worktrees-shaped slug, and no cwd recorded — still
        # adopted so its usage counts, under OTHER_REPO_NAME.
        proj = self._write_transcript("/root/scratch")  # usage_entry has no cwd
        sm = self.make_manager()
        sm._reconcile_orphan_transcripts()
        self.assertEqual(sm.usage_ledger[proj]["repo"], ha.OTHER_REPO_NAME)

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
            model=None, permission_mode=None, cmd_id="c1",
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
            model="opus", permission_mode="plan", cmd_id="c9",
        )

    def test_prune_command_dispatches_to_prune_repo(self):
        sm = self.make_manager()
        sm.prune_repo = mock.Mock()
        sm.save = mock.Mock()
        sm.handle_commands([{"cmdId": "cp", "type": "prune", "repo": "Turma"}])
        sm.prune_repo.assert_called_once_with("Turma")
        self.assertIn("cp", sm.acked)

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
            f"--permission-mode auto --settings {shlex.quote(settings)} "
            f"--append-system-prompt {shlex.quote(ha.NEW_WORK_SYSTEM_PROMPT)}",
        )
        # The guard settings file was written and wires the Bash guard hook plus
        # the AskUserQuestion → glasses bridge, both as PreToolUse matchers.
        loaded = json.loads(open(settings).read())
        matchers = [e["matcher"] for e in loaded["hooks"]["PreToolUse"]]
        self.assertEqual(matchers, ["Bash", "AskUserQuestion"])

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
        self.assertIn(
            f"--append-system-prompt {shlex.quote(ha.NEW_WORK_SYSTEM_PROMPT)}",
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
        # The keystroke still goes through regardless.
        self.assertIn(
            ["tmux", "send-keys", "-t", "agent-abcde", "-l", "--",
             "Add a docker compose flag"], self.run_calls)

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

    def test_exact_argvs_literal_send_then_enter(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        sm.send_input(sess["id"], "hello")
        self.assertEqual(self.run_calls, [
            ["tmux", "send-keys", "-t", "agent-abcde", "-l", "--", "hello"],
            ["tmux", "send-keys", "-t", "agent-abcde", "Enter"],
        ])

    def test_newlines_flattened_to_spaces(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        sm.send_input(sess["id"], "line1\r\nline2\rline3\nline4")
        self.assertEqual(self.run_calls[0], [
            "tmux", "send-keys", "-t", "agent-abcde", "-l", "--",
            "line1 line2 line3 line4",
        ])

    def test_dash_prefixed_text_sent_literally_after_option_terminator(self):
        # A dictated/typed reply that starts with '-' (or '--') must not be
        # parsed as a tmux send-keys option — the `--` terminator forces it
        # through as the literal key-list argument.
        sm = self.make_manager()
        sess = self._running_session(sm)
        sm.send_input(sess["id"], "-1 on that idea")
        self.assertEqual(self.run_calls, [
            ["tmux", "send-keys", "-t", "agent-abcde", "-l", "--", "-1 on that idea"],
            ["tmux", "send-keys", "-t", "agent-abcde", "Enter"],
        ])

        self.run_calls.clear()
        sm.send_input(sess["id"], "--force the deploy")
        self.assertEqual(self.run_calls, [
            ["tmux", "send-keys", "-t", "agent-abcde", "-l", "--", "--force the deploy"],
            ["tmux", "send-keys", "-t", "agent-abcde", "Enter"],
        ])

    def test_text_capped_at_input_max_chars(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        with mock.patch.object(ha, "INPUT_MAX_CHARS", 5):
            sm.send_input(sess["id"], "abcdefghij")
        self.assertEqual(self.run_calls[0][-1], "abcde")

    def test_noop_for_unknown_session(self):
        sm = self.make_manager()
        sm.registry = []
        sm.send_input("nope", "hello")
        self.assertEqual(self.run_calls, [])

    def test_noop_for_non_running_session(self):
        sm = self.make_manager()
        sess = self._running_session(sm, status="stopped")
        sm.send_input(sess["id"], "hello")
        self.assertEqual(self.run_calls, [])

    def test_noop_for_whitespace_only_text(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        sm.send_input(sess["id"], "   \t\n  ")
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


class TestSetModelMode(ManagerMixin, unittest.TestCase):
    """Live model / permission-mode switches on a running session: model via a
    typed `/model <name>`, mode via computed Shift+Tab (BTab) presses over the
    session's launch-dependent cycle (perm_cycle_for). Both re-validate their
    argument and persist the new value."""

    def make_manager(self):
        sm = super().make_manager()
        self.run_calls.clear()
        sm.save = mock.Mock()  # don't touch disk; just assert the record update
        return sm

    def _session(self, sm, sid="abcde", model=None, perm="auto", status="running",
                 launch=None):
        # launch defaults to perm — a just-launched session's current mode is the
        # mode it launched into, which fixes its live Shift+Tab cycle.
        sess = {"id": sid, "status": status, "tmuxName": f"agent-{sid}",
                "model": model, "permissionMode": perm,
                "launchPermissionMode": perm if launch is None else launch}
        sm.registry = [sess]
        return sess

    def test_set_model_types_slash_model_and_persists(self):
        sm = self.make_manager()
        sess = self._session(sm, model=None)
        sm.set_model("abcde", "sonnet")
        self.assertEqual(self.run_calls, [
            ["tmux", "send-keys", "-t", "agent-abcde", "-l", "--", "/model sonnet"],
            ["tmux", "send-keys", "-t", "agent-abcde", "Enter"],
        ])
        self.assertEqual(sess["model"], "sonnet")
        sm.save.assert_called_once()

    def test_set_model_default_resets_and_stores_none(self):
        sm = self.make_manager()
        sess = self._session(sm, model="opus")
        sm.set_model("abcde", "default")
        self.assertEqual(self.run_calls[0][-1], "/model default")
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

    def test_set_mode_cycles_forward_the_minimal_presses(self):
        # An auto-launched session's cycle is [default, acceptEdits, plan, auto]
        # (bypassPermissions is NOT reachable). auto (idx 3) -> plan (idx 2) over
        # that 4-mode cycle = (2-3) % 4 = 3 presses.
        sm = self.make_manager()
        sess = self._session(sm, perm="auto")
        sm.set_mode("abcde", "plan")
        self.assertEqual(self.run_calls,
                         [["tmux", "send-keys", "-t", "agent-abcde", "BTab"]] * 3)
        self.assertEqual(sess["permissionMode"], "plan")
        sm.save.assert_called_once()

    def test_set_mode_within_base_takes_forward_step(self):
        # Same auto-launch cycle, now sitting at acceptEdits (idx 1) after a prior
        # cycle. acceptEdits -> plan (idx 2) = one forward press.
        sm = self.make_manager()
        self._session(sm, perm="acceptEdits", launch="auto")
        sm.set_mode("abcde", "plan")
        self.assertEqual(len(self.run_calls), 1)

    def test_set_mode_plan_to_auto_wraps_forward(self):
        # auto-launch cycle [default, acceptEdits, plan, auto]. plan (idx 2) ->
        # auto (idx 3) = one forward press.
        sm = self.make_manager()
        sess = self._session(sm, perm="plan", launch="auto")
        sm.set_mode("abcde", "auto")
        self.assertEqual(len(self.run_calls), 1)
        self.assertEqual(sess["permissionMode"], "auto")

    def test_set_mode_bypass_unreachable_on_auto_launch_is_noop(self):
        # The reported bug: an auto-launched session's cycle has no
        # bypassPermissions, so selecting it must NOT blindly cycle to some other
        # mode — it's a no-op and the record keeps the real mode.
        sm = self.make_manager()
        sess = self._session(sm, perm="auto")
        sm.set_mode("abcde", "bypassPermissions")
        self.assertEqual(self.run_calls, [])
        self.assertEqual(sess["permissionMode"], "auto")
        sm.save.assert_not_called()

    def test_set_mode_reaches_bypass_when_launched_into_it(self):
        # A bypassPermissions-launched session HAS it in cycle
        # [default, acceptEdits, plan, bypassPermissions]; bypass (idx 3) -> plan
        # (idx 2) = (2-3) % 4 = 3 presses.
        sm = self.make_manager()
        sess = self._session(sm, perm="bypassPermissions")
        sm.set_mode("abcde", "plan")
        self.assertEqual(len(self.run_calls), 3)
        self.assertEqual(sess["permissionMode"], "plan")

    def test_set_mode_auto_unreachable_on_bypass_launch_is_noop(self):
        # Only the launched optional is guaranteed in-cycle: a bypass-launched
        # session can't be assumed to reach auto, so it's a no-op skip.
        sm = self.make_manager()
        sess = self._session(sm, perm="bypassPermissions")
        sm.set_mode("abcde", "auto")
        self.assertEqual(self.run_calls, [])
        self.assertEqual(sess["permissionMode"], "bypassPermissions")

    def test_set_mode_auto_unreachable_on_default_launch_is_noop(self):
        # A default-launched session (no --permission-mode) has the base cycle
        # only; auto is not guaranteed reachable, so selecting it is a no-op.
        sm = self.make_manager()
        sess = self._session(sm, perm="default")
        sm.set_mode("abcde", "auto")
        self.assertEqual(self.run_calls, [])
        self.assertEqual(sess["permissionMode"], "default")

    def test_set_mode_missing_launch_field_assumes_auto(self):
        # An older session persisted before launchPermissionMode existed: fall
        # back to the auto cycle (Turma's launch default). auto -> plan = 3.
        sm = self.make_manager()
        sess = {"id": "abcde", "status": "running", "tmuxName": "agent-abcde",
                "model": None, "permissionMode": "auto"}  # no launchPermissionMode
        sm.registry = [sess]
        sm.set_mode("abcde", "plan")
        self.assertEqual(len(self.run_calls), 3)
        self.assertEqual(sess["permissionMode"], "plan")

    def test_set_mode_noop_when_already_target(self):
        sm = self.make_manager()
        self._session(sm, perm="plan")
        sm.set_mode("abcde", "plan")
        self.assertEqual(self.run_calls, [])
        sm.save.assert_not_called()

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
            {"sessionId": "nope", "entries": [], "truncated": False},
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
        self.assertEqual([e["id"] for e in result["entries"]], ["u7", "u8", "u9"])
        self.assertTrue(result["truncated"])

    def test_empty_transcript_file(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        proj = self._proj_dir()
        open(os.path.join(proj, "t.jsonl"), "w").close()
        sm._stage_history(sess["id"])
        self.assertEqual(sm.history_results, [
            {"sessionId": sess["id"], "entries": [], "truncated": False},
        ])

    def test_missing_project_dir_stages_empty(self):
        sm = self.make_manager()
        sess = self._running_session(sm, workdir="/absent/worktree")
        sm._stage_history(sess["id"])
        self.assertEqual(sm.history_results, [
            {"sessionId": sess["id"], "entries": [], "truncated": False},
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
        sm.send_input.assert_called_once_with("s1", "hi")
        sm._stage_history.assert_called_once_with("s1")
        self.assertEqual(sm.acked, {"i1", "h1"})

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
                          [{"sessionId": "s1", "entries": [], "truncated": False}])

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

            def read(self):
                return b"{}"

        with mock.patch.object(ha.urllib.request, "urlopen",
                                return_value=FakeResp()):
            reply = sm.post(payload2)
        self.assertEqual(reply, {})
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
        self.assertEqual(set(payload), {"name", "repo", "status", "error", "startedAt"})

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

    def test_resolves_exact_type_and_label(self):
        main, sub = self._main_with_task("abc123", "Explore", "Find the parser")
        self.assertEqual(ha._resolve_subagent(main, "Explore", "Find the parser"), sub)

    def test_resolves_truncated_label_by_prefix(self):
        main, sub = self._main_with_task("abc123", "Explore", "Find the parser code")
        # A pane-truncated label (a prefix) still resolves.
        self.assertEqual(ha._resolve_subagent(main, "Explore", "Find the parser"), sub)

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

        # Merged/clean worktree gone; unmerged + dirty kept.
        self.assertFalse(os.path.isdir(merged_wt))
        self.assertTrue(os.path.isdir(unmerged_wt))
        self.assertTrue(os.path.isdir(dirty_wt))

        branches = self._run("branch", "--format", "%(refname:short)").stdout.split()
        self.assertNotIn("feature-merged", branches)   # merged -> deleted
        self.assertIn("feature-wip", branches)         # unmerged -> kept
        self.assertIn("main", branches)                # default -> kept

        res = sm.prunes["demo"]
        self.assertEqual(res["status"], "done")
        self.assertEqual(res["removedWorktrees"], 1)
        self.assertEqual(res["deletedBranches"], 1)
        self.assertGreaterEqual(res["skippedWorktrees"], 2)

    def test_prune_unknown_repo_reports_error(self):
        sm = ha.SessionManager()
        sm.prune_repo("nope")
        self.assertEqual(sm.prunes["nope"]["status"], "error")


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
        self.assertNotIn("mtime", m)  # internal sort key stripped

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
        self.assertEqual(d["key"], "ENG-42")
        self.assertEqual(d["url"], "https://myorg.atlassian.net/browse/ENG-42")


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
            self.assertEqual(r["error"], "not a Jira issue key")

    def test_unconfigured_host_says_so_without_fetching(self):
        sm = self.make_manager()
        with mock.patch.multiple(ha, JIRA_SITE="", JIRA_EMAIL="", JIRA_TOKEN=""), \
             mock.patch.object(ha, "fetch_jira_issue") as f:
            sm._stage_jira_issue("ENG-42")
        f.assert_not_called()
        self.assertIn("no Jira credentials", sm.jira_issue_results[0]["error"])

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
        with mock.patch.object(ha, "JIRA_SITE", "s.atlassian.net"), \
             mock.patch.object(ha, "JIRA_EMAIL", "e@x.com"), \
             mock.patch.object(ha, "JIRA_TOKEN", "t"):
            sm = self.make_manager()
            with mock.patch.object(ha, "collect_jira",
                                   side_effect=RuntimeError("HTTP Error 503")):
                sm.refresh_jira()
        self.assertTrue(sm.jira["configured"])
        self.assertFalse(sm.jira["available"])   # indistinguishable from "off"...
        self.assertIsNone(sm.jira["siteKey"])    # ...on every field but the flag
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
                                        "nameWithOwner": None,
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
            "reason": "heartbeat lives there", "manual": False,
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

    def test_ticket_auto_start_flag_is_off_by_default(self):
        # The hub reads the top-level ticketAutoStart to decide whether to auto-spawn
        # this org's To Do tickets; it must default OFF (XERK-32).
        sm = self._manager()
        with self._configured():
            self.assertFalse(sm.build_payload(1)["ticketAutoStart"])

    def test_ticket_auto_start_flag_reflects_the_config(self):
        # Settable ONLY from the agent's config, and honestly advertised when it is.
        sm = self._manager()
        with self._configured(), mock.patch.object(ha, "TICKET_AUTO_START", True):
            self.assertTrue(sm.build_payload(1)["ticketAutoStart"])

    def test_ticket_auto_start_rides_top_level_not_the_jira_block(self):
        # Board-agnostic on purpose: the flag lives beside `jira`, not inside it, so
        # a future non-Jira board carries it unchanged.
        sm = self._manager()
        with self._configured(), mock.patch.object(ha, "TICKET_AUTO_START", True):
            payload = sm.build_payload(1)
        self.assertNotIn("autoStart", payload["jira"])
        self.assertTrue(payload["ticketAutoStart"])

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
                     {"key": "P-1", "comments": [{}]}):
            self.assertIsInstance(ha.build_ticket_prompt(junk), str)


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
        sm.clone = lambda nwo: started.append(nwo)
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
        sm.spawn_ticket.assert_called_once_with("PROJ-7", cmd_id="c9")

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


if __name__ == "__main__":
    unittest.main()
