#!/usr/bin/env python3
"""Differential QA rig for agent/hooks/guard.py: does bash run what the guard allows?

Usage: python3 agent/tests/guard_differential.py CASES.txt [--old OLD_guard.py]

Each non-blank CASES line (lines starting `##` are comments) is a bash template
holding `{P}`. The guard classifies it with `{P}` = a destructive command; bash
RUNS it with `{P}` = `touch <tempdir>/MARK`. BYPASS = the mark appeared AND the
guard allowed it; falsedeny = no mark AND the guard denied it.

Every line is EXECUTED FOR REAL, including any text around `{P}` (XERK-1590): a
hand-rolled copy of this rig ran `rm -rf ${nope:-/etc}` as root and wiped /etc
on two hosts. So bash runs as `nobody` via setpriv (no capabilities, no
setuid gain), which can touch only what the host leaves world-writable, and the
rig refuses to run at all unless it can drop to it. Never "simplify" that away.

Before the cases, two controls must come out right (`{P}` marks when run as nobody,
`false && {P}` doesn't), so a broken drop or a leftover process can't pass for a clean run.
The rig is a child subreaper and kills every process a case leaves behind,
`setsid` ones included, before the next case starts.
"""

import argparse
import ctypes
import importlib.util
import os
import shutil
import signal
import subprocess
import sys
import tempfile

GUARD_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "hooks", "guard.py")
NOBODY = "65534"
PR_SET_CHILD_SUBREAPER = 36
PAYLOAD = "r" + "m -rf /"  # split so this file's own text never reads as the command


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def unprivileged():
    """argv prefix that runs a command as nobody, or exit: there is no safe fallback."""
    if os.geteuid() != 0:
        sys.exit("guard_differential: run as root so cases can be dropped to nobody; "
                 "running them as your own user could delete your files")
    setpriv = shutil.which("setpriv")
    if not setpriv:
        sys.exit("guard_differential: setpriv not found; refusing to run cases as root")
    return [setpriv, "--reuid=" + NOBODY, "--regid=" + NOBODY, "--clear-groups",
            "--inh-caps=-all", "--bounding-set=-all", "--no-new-privs", "--"]


def reap_leftovers():
    """Kill every process re-parented to this subreaper, until none remain."""
    me = str(os.getpid())
    while True:
        kids = []
        for pid in filter(str.isdigit, os.listdir("/proc")):
            try:
                with open(f"/proc/{pid}/stat") as f:
                    # comm may hold spaces; the fields after its `)` are fixed.
                    if f.read().rsplit(")", 1)[1].split()[1] == me:
                        kids.append(int(pid))
            except (OSError, IndexError):
                pass
        if not kids:
            return
        for pid in kids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for pid in kids:
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass


def ran(prefix, template):
    # /tmp, not $TMPDIR: nobody must be able to reach the dir, or nothing marks.
    d = tempfile.mkdtemp(prefix="guard-diff-", dir="/tmp")
    try:
        os.chmod(d, 0o777)
        mark = os.path.join(d, "MARK")
        proc = subprocess.Popen(
            prefix + ["bash", "-c", template.replace("{P}", "touch " + mark)],
            cwd=d, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, start_new_session=True,
            env={"PATH": "/usr/bin:/bin", "HOME": d})
        timed_out = False
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            timed_out = True
        # A case may background children; kill its whole session either way.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        reap_leftovers()
        return os.path.exists(mark), timed_out
    finally:
        shutil.rmtree(d, ignore_errors=True)


def verdict(guard, template):
    try:
        return guard.decide("Bash", {"command": template.replace("{P}", PAYLOAD)})[0]
    except Exception as e:  # a crash is a finding, not a rig failure
        return "EXC:" + type(e).__name__


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cases", type=argparse.FileType())
    ap.add_argument("--old", help="base guard.py to compare against (e.g. origin/main's)")
    args = ap.parse_args()
    prefix = unprivileged()
    if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        sys.exit("guard_differential: cannot become a child subreaper; refusing to run")
    # The positive control proves the drop itself: it marks only as nobody.
    if (ran(prefix, '[ "$(id -u)" = ' + NOBODY + ' ] && {P}') != (True, False)
            or ran(prefix, "false && {P}")[0]):
        sys.exit("guard_differential: control cases failed (the drop to nobody or the "
                 "temp dir is broken); every result would read as no bypass")
    new = load(GUARD_PATH, "guard_new")
    old = load(args.old, "guard_old") if args.old else None
    with args.cases as f:
        for line in f:
            t = line.rstrip("\n")
            if not t or t.startswith("##"):
                continue
            r, timed_out = ran(prefix, t)
            n = verdict(new, t)
            tag = "BYPASS" if r and n == "allow" else (
                "timeout" if timed_out and not r else
                "falsedeny" if not r and n != "allow" else "ok")
            o = verdict(old, t) if old else n
            if o != n:
                tag += " CHANGED"
            print(f"{tag:18} ran={int(r)} old={o:5} new={n:5} | {t}", flush=True)


if __name__ == "__main__":
    main()
