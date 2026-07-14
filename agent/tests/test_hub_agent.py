#!/usr/bin/env python3
"""Unit tests for agent/hub-agent.py (stdlib unittest only — mirrors the
image's no-pip stance; CI runs `python3 -m unittest discover -s agent/tests`).

The module is imported by file path (its name has a dash) and its module-level
constants (PROJECTS_ROOT, REGISTRY_PATH, ...) are patched per-test, so no test
ever touches /root or the real registry. SessionManager's subprocess use is
faked at its two chokepoints, run()/run_ok(), plus Popen for ttyd — no
docker/tmux/git needed.
"""

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

    def test_aggregation_dedup_and_pricing(self):
        today = time.strftime("%Y-%m-%d")
        opus = usage_entry(
            "2026-07-01T10:00:00.000Z", "m1", "r1",
            "claude-opus-4-20250514", 1_000_000, 100_000,
        )  # 1M in @ $5 + 100k out @ $25 = $7.50
        unknown = usage_entry(
            "2026-07-02T09:00:00.000Z", "m2", "r2",
            "weird-model-x", 10, 20, cw=30, cr=40,
        )  # unknown model: tokens counted, cost 0
        no_id = usage_entry(
            f"{today}T01:00:00.000Z", None, None,
            "claude-sonnet-4-20250514", 100_000, 0,
        )  # id-less entries are never deduped; sonnet 100k in = $0.30

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
        self.assertAlmostEqual(rep["totals"]["cost"], 7.5 + 0.0 + 0.6, places=2)

        # Per-day buckets: opus on 07-01, unknown on 07-02, sonnet today.
        self.assertAlmostEqual(rep["days"]["2026-07-01"]["cost"], 7.5, places=2)
        self.assertEqual(rep["days"]["2026-07-02"]["input"], 10)
        self.assertAlmostEqual(rep["days"]["2026-07-02"]["cost"], 0.0, places=2)
        self.assertEqual(rep["today"], rep["days"][today])
        self.assertEqual(rep["today"]["input"], 200_000)

        self.assertEqual(rep["lastActivity"], f"{today}T01:00:00.000Z")
        # sonnet has 2 messages, opus and weird-model-x 1 each -> sonnet first.
        self.assertEqual(rep["models"][0], "claude-sonnet-4-20250514")
        self.assertIn("weird-model-x", rep["models"])

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
                        "claude-opus-4-20250514", 1_000_000, 100_000),  # $7.50
        ])
        write_jsonl(os.path.join(self._proj(wt_b), "b.jsonl"), [
            usage_entry("2026-07-01T12:00:00.000Z", "m2", "r2",
                        "claude-sonnet-4-20250514", 100_000, 0),        # $0.30
        ])
        write_jsonl(os.path.join(self._proj(wt_c), "c.jsonl"), [
            usage_entry("2026-07-02T09:00:00.000Z", "m3", "r3",
                        "claude-sonnet-4-20250514", 200_000, 0),        # $0.60
        ])
        ledger = {
            # Same repo, two worktrees, ssh vs https remote -> one repo series.
            wt_a: self._entry(wt_a, "Turma", "git@github.com:xerktech/Turma.git"),
            wt_b: self._entry(wt_b, "Turma", "https://github.com/xerktech/Turma.git"),
            wt_c: self._entry(wt_c, "DockerOps", "git@github.com:xerktech/DockerOps.git"),
        }
        repo_usage, host = ha.repo_usage_report(ledger, self._fold_full)
        by = {r["repo"]: r for r in repo_usage}

        self.assertAlmostEqual(by["Turma"]["usage"]["totals"]["cost"], 7.8, places=2)
        self.assertEqual(by["Turma"]["usage"]["totals"]["input"], 1_100_000)
        self.assertAlmostEqual(
            by["Turma"]["usage"]["days"]["2026-07-01"]["cost"], 7.8, places=2)
        self.assertEqual(by["Turma"]["remoteKey"], "github.com/xerktech/turma")
        self.assertAlmostEqual(by["DockerOps"]["usage"]["totals"]["cost"], 0.6, places=2)

        self.assertAlmostEqual(host["totals"]["cost"], 7.8 + 0.6, places=2)
        self.assertEqual(host["totals"]["input"], 1_100_000 + 200_000)
        # Sorted by cost desc.
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

    def test_missing_project_dir(self):
        state = {}
        rep = ha.session_report("/absent/worktree", state)
        self.assertFalse(rep["bridgeAttached"])
        self.assertIsNone(rep["transcriptAgeSec"])
        self.assertEqual(rep["prUrls"], [])
        self.assertTrue(state["primed"])  # still primes so later beats scan

    def test_prime_to_eof_then_incremental_pr_scan(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text(f"old PR: {self.PR1}")])

        state = {}
        rep = ha.session_report(self.WORKDIR, state)
        # First beat primes offsets to EOF: pre-existing PR link NOT replayed.
        self.assertEqual(rep["prUrls"], [])
        self.assertEqual(rep["lastRole"], "assistant")
        self.assertIsNotNone(rep["transcriptAgeSec"])

        write_jsonl(path, [self.entry_with_text(f"opened {self.PR2} just now")])
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [self.PR2])

        # Same URL appended again -> already seen, not re-reported.
        write_jsonl(path, [self.entry_with_text(f"again {self.PR2}")])
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [])

    def test_truncated_file_resets_offset_without_rescan(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("hello")] * 5)
        state = {}
        ha.session_report(self.WORKDIR, state)  # primes offset to EOF

        # Rewrite shorter (context clear / rotation). The old bytes contain a
        # PR URL, but offset resets to the new size — nothing is rescanned.
        with open(path, "w") as f:
            f.write(json.dumps(self.entry_with_text(f"reset {self.PR1}")) + "\n")
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [])

        # Appends after the truncation ARE picked up.
        write_jsonl(path, [self.entry_with_text(f"new {self.PR2}")])
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
        self.assertEqual(ha._hook_question("nope"), (None, []))

    def test_no_session_id(self):
        self.assertEqual(ha._hook_question(None), (None, []))
        self.assertEqual(ha._hook_question(""), (None, []))

    def test_reads_question_and_labels(self):
        self._write("s", {"question": "Which?",
                          "options": [{"label": "A"}, {"label": "B"}]})
        self.assertEqual(ha._hook_question("s"), ("Which?", ["A", "B"]))

    def test_corrupt_file_is_no_question(self):
        with open(os.path.join(self.tmp, "s.req.json"), "w") as f:
            f.write("{not json")
        self.assertEqual(ha._hook_question("s"), (None, []))

    def test_question_capped_at_300_and_labels_at_80(self):
        self._write("s", {"question": "Q" * 400,
                          "options": [{"label": "L" * 100}]})
        q, opts = ha._hook_question("s")
        self.assertEqual(len(q), 300)
        self.assertEqual(opts, ["L" * 80])


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
            ("PROJECTS_ROOT", os.path.join(self.tmp, "projects")),
            ("WORKTREES_ROOT", os.path.join(self.tmp, "worktrees")),
        ]:
            p = mock.patch.object(ha, name, value)
            p.start()
            self.addCleanup(p.stop)

    def make_manager(self):
        return ha.SessionManager()


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
        # adopted so its cost counts, under OTHER_REPO_NAME.
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

    def test_spawn_refused_at_max_sessions(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        p = mock.patch.object(ha, "MAX_SESSIONS", 1)
        p.start()
        self.addCleanup(p.stop)
        sm.registry = [{"id": "aaaaa", "status": "running", "ttydPort": 7700}]
        sm.spawn("Turma")
        self.assertEqual(len(sm.registry), 1)  # unchanged

    def test_spawn_refused_for_unknown_repo(self):
        sm = self.make_spawn_ready_manager([])
        sm.spawn("NoSuchRepo")
        self.assertEqual(sm.registry, [])

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
        positional prompt. (No default base resolves under the fake git, so the
        detach point is HEAD — nothing trails the worktree path.)"""
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
            f"claude --remote-control '{sess['rcName']}' "
            f"--permission-mode auto --settings {shlex.quote(settings)}",
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

    def test_spawn_root_refused_when_root_already_running(self):
        sm = self._root_ready_manager()
        sm.spawn(ha.ROOT_REPO_NAME)
        self.assertEqual(len(sm.registry), 1)
        sm.spawn(ha.ROOT_REPO_NAME)  # a second concurrent root is refused
        self.assertEqual(len(sm.registry), 1)

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

    def test_dispatches_answer_question(self):
        sm = self.make_manager()
        sm.save = mock.Mock()
        sm.answer_question = mock.Mock()
        cmds = [{"cmdId": "a1", "type": "answerQuestion", "sessionId": "s1",
                 "optionIndex": 2, "custom": "other"}]
        self.assertTrue(sm.handle_commands(cmds))
        sm.answer_question.assert_called_once_with("s1", 2, "other")
        self.assertEqual(sm.acked, {"a1"})


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
            ha._project_slug(r"C:\Users\me/.switchboard"),
            "C--Users-me--switchboard",
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

    def test_pr_status_parses_gh(self):
        payload = json.dumps({"number": 7, "state": "OPEN", "url": "u",
                              "statusCheckRollup": []})
        with mock.patch.object(ha, "run", return_value=payload):
            out = ha.pr_status("https://github.com/o/r/pull/7")
        self.assertEqual(out["number"], 7)

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


if __name__ == "__main__":
    unittest.main()
