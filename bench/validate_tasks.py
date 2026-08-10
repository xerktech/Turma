#!/usr/bin/env python3
"""Validate bench tasks against the real repo history.

A bench task is a merged commit that fixed a bug (or added a feature) AND
carried its own regression tests. The task is built by checking out that commit
and then reverting ONLY the implementation files to their parent state, leaving
the tests in place. That must leave the test suite RED; restoring the
implementation must leave it GREEN. A candidate that does not show that
red->green transition is not a usable task and is dropped.

This runs no model. It is the gate that keeps the benchmark honest: every task
in tasks.json has been shown to be solvable and to actually detect the fix.

    python3 bench/validate_tasks.py --repo /path/to/Turma            # all tasks
    python3 bench/validate_tasks.py --repo /path/to/Turma --id foo   # just one
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TASKS = os.path.join(HERE, "tasks.json")


def run(cmd, cwd=None, timeout=600, env=None):
    """Run a command, returning (returncode, combined output)."""
    proc = subprocess.run(
        cmd, cwd=cwd, timeout=timeout, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    return proc.returncode, proc.stdout


def prepare_worktree(repo, task, dest):
    """Check out the task's commit into `dest`, then revert its implementation.

    Leaves the worktree on a detached HEAD whose tree is "tests from the fix,
    implementation from before the fix" — committed, so an agent's own work
    shows up as a clean diff against it.
    """
    rc, out = run(["git", "worktree", "add", "--detach", dest, task["commit"]], cwd=repo)
    if rc != 0:
        return f"worktree add failed: {out.strip()[:300]}"

    # Roll the implementation files back to the parent commit. The test files
    # named by the task stay at the fixed revision — they are the oracle.
    rc, out = run(["git", "checkout", f"{task['commit']}^", "--"] + task["revert_paths"], cwd=dest)
    if rc != 0:
        return f"revert failed: {out.strip()[:300]}"

    # Commit the rolled-back state so the agent starts from a clean tree and any
    # commit it makes is unambiguously its own.
    run(["git", "-c", "user.email=bench@turma", "-c", "user.name=bench",
         "commit", "-qam", "bench: broken baseline"], cwd=dest)
    return None


def verify(task, dest):
    """Run the task's test command. Returns (passed, output)."""
    try:
        rc, out = run(task["test_cmd"], cwd=dest, timeout=task.get("test_timeout", 300))
    except subprocess.TimeoutExpired:
        return False, "test command timed out"
    return rc == 0, out


def cleanup(repo, dest):
    run(["git", "worktree", "remove", "--force", dest], cwd=repo)
    if os.path.exists(dest):
        shutil.rmtree(dest, ignore_errors=True)


def validate(repo, task, workroot):
    """Assert the red->green transition. Returns (ok, detail)."""
    dest = os.path.join(workroot, "validate-" + task["id"])
    cleanup(repo, dest)
    err = prepare_worktree(repo, task, dest)
    if err:
        return False, err
    try:
        broken_pass, broken_out = verify(task, dest)
        if broken_pass:
            return False, "tests PASS with the fix reverted — the task does not detect its own fix"

        # Restore the implementation; the same tests must now pass.
        rc, out = run(["git", "checkout", task["commit"], "--"] + task["revert_paths"], cwd=dest)
        if rc != 0:
            return False, f"restore failed: {out.strip()[:200]}"
        fixed_pass, fixed_out = verify(task, dest)
        if not fixed_pass:
            return False, "tests FAIL even with the real fix applied — task is not solvable as specified"

        failing = [ln for ln in broken_out.splitlines()
                   if ln.strip().startswith(("not ok", "FAIL", "✖", "AssertionError"))]
        return True, f"red->green OK ({len(failing)} failing lines when broken)"
    finally:
        cleanup(repo, dest)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="path to the source repo checkout")
    ap.add_argument("--tasks", default=DEFAULT_TASKS)
    ap.add_argument("--id", action="append", help="validate only these task ids")
    ap.add_argument("--workroot", default="/root/turma-bench/work")
    args = ap.parse_args()

    with open(args.tasks) as fh:
        tasks = json.load(fh)["tasks"]
    if args.id:
        tasks = [t for t in tasks if t["id"] in args.id]
    os.makedirs(args.workroot, exist_ok=True)

    failures = 0
    for task in tasks:
        ok, detail = validate(args.repo, task, args.workroot)
        print(f"{'PASS' if ok else 'FAIL'}  {task['id']:<34} {detail}", flush=True)
        if not ok:
            failures += 1
    print(f"\n{len(tasks) - failures}/{len(tasks)} tasks valid")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
