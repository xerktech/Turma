#!/usr/bin/env python3
"""Tests for agent/native/turma-agent-protect (XERK-1677): the root helper that
lays the guard hooks where the session uid cannot write them. Run unprivileged
against a relocated layout (`--root`), which skips chown and systemd."""

import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HELPER = os.path.join(AGENT_DIR, "native", "turma-agent-protect")

loader = importlib.machinery.SourceFileLoader("turma_agent_protect", HELPER)
spec = importlib.util.spec_from_loader(loader.name, loader)
tap = importlib.util.module_from_spec(spec)
loader.exec_module(tap)

spec = importlib.util.spec_from_file_location("hub_agent", os.path.join(AGENT_DIR, "hub-agent.py"))
ha = importlib.util.module_from_spec(spec)
sys.modules.setdefault("hub_agent", ha)
spec.loader.exec_module(ha)


def run(*argv):
    out = io.StringIO()
    with redirect_stdout(out):
        rc = tap.main(list(argv))
    return rc, out.getvalue()


def tgz(members):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = os.path.join(self.tmp.name, "root")
        os.makedirs(self.root)
        self.layout = tap.Layout(self.root)
        self.src = os.path.join(self.tmp.name, "payload")
        os.makedirs(os.path.join(self.src, "hooks"))
        for n in tap.HOOKS:
            with open(os.path.join(self.src, "hooks", n), "w") as fh:
                fh.write(f"# {n}\n")


class TestInstall(Base):
    def test_lays_hooks_and_a_dropin_wiring_them(self):
        rc, _ = run("--root", self.root, "install", "--from", self.src)
        self.assertEqual(rc, 0)
        for n in tap.HOOKS:
            path = os.path.join(self.layout.hooks, n)
            self.assertEqual(open(path).read(), f"# {n}\n")
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o644)
        body = json.load(open(self.layout.dropin))
        pre = body["hooks"]["PreToolUse"]
        self.assertEqual([e["matcher"] for e in pre],
                         ["Bash", "Write|Edit|MultiEdit|NotebookEdit"])
        bash = pre[0]["hooks"][0]["command"]
        # Absolute interpreter, isolated mode, the ROOT path — never python3
        # off PATH or a file under the session uid's home.
        self.assertTrue(bash.startswith('"/usr/bin/python3" -SI "/etc/turma-agent/hooks/guard.py"'))
        self.assertTrue(bash.endswith("--grants --protected"))
        self.assertEqual(set(body), {"hooks"})   # no key claude might reject
        self.assertEqual(os.stat(self.layout.self_copy).st_mode & 0o777, 0o755)
        self.assertEqual(run("--root", self.root, "status")[0], 0)

    def test_payload_missing_a_hook_changes_nothing(self):
        os.unlink(os.path.join(self.src, "hooks", "fileguard.py"))
        with self.assertRaises(SystemExit):
            run("--root", self.root, "install", "--from", self.src)
        # Above all no drop-in: one naming a missing hook blocks every Bash call.
        self.assertFalse(os.path.exists(self.layout.dropin))

    def test_remove_drops_everything_and_status_says_so(self):
        run("--root", self.root, "install", "--from", self.src)
        rc, _ = run("--root", self.root, "remove")
        self.assertEqual(rc, 0)
        self.assertFalse(os.path.exists(self.layout.dropin))
        self.assertFalse(os.path.exists(self.layout.etc))
        rc, out = run("--root", self.root, "status")
        self.assertEqual(rc, 1)
        self.assertIn("NOT protected", out)

    def test_status_flags_a_dropin_that_was_edited(self):
        run("--root", self.root, "install", "--from", self.src)
        with open(self.layout.dropin, "w") as fh:
            json.dump({"hooks": {}}, fh)
        self.assertEqual(run("--root", self.root, "status")[0], 1)

    def test_mutating_modes_need_root(self):
        if os.geteuid() == 0:
            self.skipTest("running as root")
        for mode in ("install", "sync", "remove"):
            self.assertEqual(run(mode)[0], 1)

    def test_unknown_mode_and_stray_args_are_refused(self):
        self.assertEqual(run("--root", self.root, "bogus")[0], 2)
        self.assertEqual(run("--root", self.root, "sync", "extra")[0], 2)


class TestOrdering(Base):
    """A drop-in naming a missing hook blocks every Bash call on the host, so
    the hooks land before it and leave after it."""

    def test_hooks_are_written_before_the_dropin(self):
        order = []
        real = tap.write_file
        def rec(path, *a, **k):
            order.append(os.path.basename(path))
            return real(path, *a, **k)
        tap.write_file = rec
        self.addCleanup(setattr, tap, "write_file", real)
        run("--root", self.root, "install", "--from", self.src)
        self.assertLess(max(order.index(n) for n in tap.HOOKS), order.index(tap.DROPIN_NAME))

    def test_the_dropin_is_removed_before_the_hooks(self):
        run("--root", self.root, "install", "--from", self.src)
        order = []
        real = tap._unlink
        def rec(path):
            order.append(os.path.basename(path))
            return real(path)
        tap._unlink = rec
        self.addCleanup(setattr, tap, "_unlink", real)
        run("--root", self.root, "remove")
        self.assertLess(order.index(tap.DROPIN_NAME), min(order.index(n) for n in tap.HOOKS))

    def test_remove_twice_leaves_nothing(self):
        run("--root", self.root, "install", "--from", self.src)
        run("--root", self.root, "remove")
        os.makedirs(self.layout.hooks)        # a half-removed leftover
        self.assertEqual(run("--root", self.root, "remove")[0], 0)
        self.assertFalse(os.path.exists(self.layout.etc))

    def test_remove_waits_for_a_sync_holding_the_lock(self):
        # A sync mid-run holds the lock; remove must not unlink under it, or the
        # sync re-lays hooks (or a drop-in naming missing ones) after "removed".
        import threading
        run("--root", self.root, "install", "--from", self.src)
        held, release = threading.Event(), threading.Event()

        def sync_like():
            with tap.locked(self.layout):
                held.set()
                release.wait(5)
        t = threading.Thread(target=sync_like)
        t.start()
        held.wait(5)
        r = threading.Thread(target=run, args=("--root", self.root, "remove"))
        r.start()
        r.join(0.3)
        self.assertTrue(r.is_alive())                  # blocked on the lock
        self.assertTrue(os.path.exists(self.layout.dropin))
        release.set()
        t.join(5)
        r.join(5)
        self.assertFalse(os.path.exists(self.layout.dropin))

    def test_a_sync_after_remove_lays_nothing(self):
        # A sync queued behind remove's lock must not re-install what it removed.
        run("--root", self.root, "install", "--from", self.src)
        run("--root", self.root, "remove")
        rc, out = run("--root", self.root, "sync")
        self.assertEqual(rc, 0)
        self.assertIn("nothing to sync", out)
        self.assertFalse(os.path.exists(self.layout.dropin))

    def test_the_guard_ignores_env_overrides(self):
        run("--root", self.root, "install", "--from", self.src)
        cmd = json.load(open(self.layout.dropin))["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        self.assertIn("--protected", cmd.split())


class TestManagerAgrees(Base):
    def test_the_manager_recognises_what_install_writes(self):
        # The drop-in path and hook dir are a contract with hub-agent.py: if they
        # drift, the manager keeps wiring its own copy AND the protected one runs.
        self.assertEqual(ha.MANAGED_GUARD_DROPIN, os.path.join(tap.DROPIN_DIR, tap.DROPIN_NAME))
        self.assertEqual(ha.PROTECTED_HOOKS_DIR, os.path.join(tap.ETC_DIR, "hooks"))
        run("--root", self.root, "install", "--from", self.src)
        # Re-point the drop-in's hook paths at the test layout, then ask the
        # manager's own predicate.
        body = open(self.layout.dropin).read().replace("/etc/turma-agent/hooks",
                                                       self.layout.hooks)
        with open(self.layout.dropin, "w") as fh:
            fh.write(body)
        self.assertTrue(ha.managed_guard_active(self.layout.dropin, self.layout.hooks))


class TestRelease(Base):
    def fake(self, members, *, sha=None):
        blob = tgz(members)
        digest = sha or hashlib.sha256(blob).hexdigest()
        manifest = {"components": {"agent-native": {
            "version": "1.2.3", "asset": "turma-agent-native-v1.2.3.tar.gz",
            "sha256_asset": "turma-agent-native-v1.2.3.tar.gz.sha256",
            "release_tag": "v1.2.3"}}}
        urls = {
            f"https://api.github.com/repos/{tap.REPO}/releases?per_page=100":
                json.dumps([{"tag_name": "v1.2.3"}, {"tag_name": "v1.10.0"},
                            {"tag_name": "agent-native-v9.9.9"}]).encode(),
            f"https://github.com/{tap.REPO}/releases/download/v1.10.0/manifest.json":
                json.dumps(manifest).encode(),
            f"https://github.com/{tap.REPO}/releases/download/v1.2.3/turma-agent-native-v1.2.3.tar.gz.sha256":
                f"{digest}  turma-agent-native-v1.2.3.tar.gz\n".encode(),
            f"https://github.com/{tap.REPO}/releases/download/v1.2.3/turma-agent-native-v1.2.3.tar.gz":
                blob,
        }
        return lambda url, cap=None: urls[url]

    def test_takes_the_hooks_from_the_newest_verified_release(self):
        fetch = self.fake({"./hooks/guard.py": b"g", "./hooks/fileguard.py": b"f",
                           "./turma-agent-protect": b"p", "./hub-agent.py": b"x"})
        with redirect_stdout(io.StringIO()):
            got = tap.payload_from_release(fetch)
        self.assertEqual(got, {"guard.py": b"g", "fileguard.py": b"f",
                               "turma-agent-protect": b"p"})

    def test_a_checksum_mismatch_is_refused(self):
        fetch = self.fake({"hooks/guard.py": b"g", "hooks/fileguard.py": b"f"}, sha="0" * 64)
        with self.assertRaises(SystemExit) as cm:
            tap.payload_from_release(fetch)
        self.assertIn("checksum", str(cm.exception))

    def test_non_file_members_are_ignored(self):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            link = tarfile.TarInfo("hooks/guard.py")
            link.type = tarfile.SYMTYPE
            link.linkname = "/etc/shadow"
            tar.addfile(link)
        blob = buf.getvalue()
        fetch = self.fake({})
        fetch_blob = lambda url, cap=None: blob if url.endswith(".tar.gz") else (  # noqa: E731
            f"{hashlib.sha256(blob).hexdigest()}  x\n".encode() if url.endswith(".sha256")
            else fetch(url))
        with redirect_stdout(io.StringIO()):
            self.assertEqual(tap.payload_from_release(fetch_blob), {})


if __name__ == "__main__":
    unittest.main()
