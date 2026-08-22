#!/usr/bin/env python3
"""Curate replay tasks from the Turma hub's archived session history.

XERK-445 Phase 0 step 3. The ticket asks for 30-50 representative historical
tasks with known-good outcomes, and warns that grading is the hard part: the
transcript contains the answer, so replaying it leaks the answer.

The way out is to take the two halves of a task from two different places:

  * the INTENT comes from the session's first user message -- the real ask, in
    the user's own words, before any work happened;
  * the GRADE comes from the repo's own regression tests at the merge commit
    that session produced.

Nothing from the body of the transcript reaches the replayed agent, so there is
nothing to leak. This reuses the mechanical grading contract already proven in
bench/METHOD.md: check out the merge commit, revert only the implementation
files, and the repo's own tests start red and must end green.

A session qualifies only if it actually landed -- a merge commit that changed
BOTH implementation and test files. That is what "known-good outcome" means
here, and it is why the yield is far below the number of archived sessions.

Usage:
    python3 bench/archive/curate.py --corpus DIR --repos-root ~/git \\
        --out bench/archive/tasks-archive.json
"""

import argparse
import collections
import json
import os
import pathlib
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scrub import scrub, sensitivity  # noqa: E402

TEST_RE = re.compile(r"(^|/)(tests?|spec)/|\.(test|spec)\.[jt]sx?$|(^|/)test_[^/]+\.py$")
DOC_RE = re.compile(r"\.(md|txt|png|jpg|svg|lock)$|(^|/)(docs?|\.github)/")
TICKET_RE = re.compile(r"\b([A-Z]{2,10}-\d+)\b")


def run(cmd, cwd, timeout=60):
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                           timeout=timeout)
        return p.returncode, p.stdout.strip()
    except (subprocess.SubprocessError, OSError):
        return 1, ""


def first_user_intent(entries):
    """The real ask, in the user's words, before any work happened."""
    for e in entries:
        if e.get("type") != "user":
            continue
        c = e.get("message", {}).get("content")
        if isinstance(c, list):
            t = " ".join(b.get("text", "") for b in c
                         if isinstance(b, dict) and b.get("type") == "text").strip()
        elif isinstance(c, str):
            t = c.strip()
        else:
            t = ""
        # Skip harness scaffolding (<system-reminder>, tool results) and
        # one-word nudges like "continue".
        if t and not t.startswith("<") and len(t) > 40:
            return t
    return None


def derive_test_cmd(test_files, repo_path):
    """Build a runnable test command from the test files the fix shipped with.

    Returns None when the repo's suite cannot be driven from file paths alone;
    those candidates are reported rather than silently dropped, because a task
    nobody can grade is worse than a task nobody ships.
    """
    js = [f for f in test_files if f.endswith((".test.js", ".spec.js"))]
    py = [f for f in test_files if f.endswith(".py")]
    ts = [f for f in test_files if f.endswith((".test.ts", ".spec.ts"))]
    if js:
        return ["node", "--test"] + sorted(js)
    if py:
        if os.path.exists(os.path.join(repo_path, "pytest.ini")) or \
           os.path.exists(os.path.join(repo_path, "pyproject.toml")):
            return ["python3", "-m", "pytest", "-q"] + sorted(py)
        return ["python3", "-m", "unittest"] + \
               sorted(f[:-3].replace("/", ".") for f in py)
    if ts:
        return ["npx", "vitest", "run"] + sorted(ts)
    return None


# Prompts that are not a user's ask at all. A QA invocation names the branch and
# the files under test; a research ask has no gradeable outcome even when its
# merge commit happens to make the suite green.
_NOT_A_TASK = (
    re.compile(r"(?i)^\s*QA\s+(the|this)\b"),
    re.compile(r"(?i)\bworking checkout\s*:"),
    re.compile(r"(?i)\bre-?QA\b|\bqa-delta\b"),
    re.compile(r"(?i)\bI need a deep understanding\b"),
    re.compile(r"(?i)\b(write up|research|investigate|summarize|explain)\b[^.]{0,60}"
               r"\b(so I can|before we|and report)\b"),
)


def _leaks_answer(intent, impl, tests):
    """Return a reason string if this prompt hands over the answer, else None.

    Two independent checks. The path check is the objective one: a prompt that
    names a file the task reverts, or the test that grades it, has given the
    game away regardless of how it is worded. bench/tasks.json's own contract
    says the prompt carries "no file paths ... and no hint that regression tests
    for it already exist".
    """
    for pat in _NOT_A_TASK:
        if pat.search(intent):
            return "not a user ask"
    lowered = intent.lower()
    for path in impl:
        if path.lower() in lowered:
            return f"names reverted file {path}"
        base = os.path.basename(path)
        # A bare basename is only evidence when it is distinctive; short or
        # generic names (index.js, main.py) appear in ordinary prose.
        if len(base) > 8 and base.lower() in lowered:
            return f"names reverted file {base}"
    for path in tests:
        if path.lower() in lowered or os.path.basename(path).lower() in lowered:
            return f"names grading test {os.path.basename(path)}"
    return None


def classify_kind(intent, impl_files):
    blob = (intent or "").lower()
    if any(w in blob for w in ("bug", "broken", "fails", "wrong", "regress",
                               "crash", "error", "does not", "doesn't")):
        return "bugfix"
    if any(w in blob for w in ("add", "support", "implement", "new ")):
        return "feature"
    if any(f.endswith((".yaml", ".yml", ".tf")) for f in impl_files):
        return "infra"
    return "change"


def lang_of(impl_files):
    exts = collections.Counter(pathlib.Path(f).suffix for f in impl_files)
    if not exts:
        return "unknown"
    top = exts.most_common(1)[0][0]
    return {".js": "js", ".py": "py", ".ts": "ts", ".kt": "kotlin",
            ".yaml": "yaml", ".yml": "yaml", ".tf": "terraform"}.get(top,
                                                                     top.lstrip(".") or "unknown")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--repos-root", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--report", help="write the full candidate ledger here")
    args = ap.parse_args()

    repos_root = os.path.expanduser(args.repos_root)
    local_repos = {d.lower(): os.path.join(repos_root, d)
                   for d in os.listdir(repos_root)
                   if os.path.isdir(os.path.join(repos_root, d, ".git"))}

    files = [f for f in pathlib.Path(args.corpus).rglob("*.jsonl")
             if ".jsonl.raw" in str(f)]

    tasks, ledger = [], []
    seen_commits = set()
    reasons = collections.Counter()

    for path in sorted(files):
        repo_dir = path.relative_to(args.corpus).parts[0]
        repo_path = local_repos.get(repo_dir.lower())

        entries = []
        try:
            with open(path, encoding="utf8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if line:
                        try:
                            entries.append(json.loads(line))
                        except (ValueError, TypeError):
                            pass
        except OSError:
            continue
        if not any(e.get("type") == "assistant" for e in entries):
            continue

        if not repo_path:
            reasons["repo not cloned locally"] += 1
            continue

        intent = first_user_intent(entries)
        if not intent:
            reasons["no usable user intent"] += 1
            continue

        branches = {e.get("gitBranch") for e in entries if e.get("gitBranch")}
        keys = set()
        for b in branches:
            keys.update(TICKET_RE.findall(b or ""))
        keys.update(TICKET_RE.findall(intent[:400]))
        if not keys:
            reasons["no ticket key on branch or intent"] += 1
            continue

        merge = None
        key_used = None
        for k in sorted(keys):
            rc, out = run(["git", "log", "--merges", f"--grep={k}",
                           "--format=%H", "-1"], repo_path)
            if rc == 0 and out:
                merge, key_used = out.split("\n")[0], k
                break
        if not merge:
            reasons["no merge commit for ticket"] += 1
            continue
        if merge in seen_commits:
            reasons["duplicate of an earlier session"] += 1
            continue

        rc, out = run(["git", "diff", "--name-only", f"{merge}^1", merge], repo_path)
        if rc != 0 or not out:
            reasons["merge diff unavailable"] += 1
            continue
        changed = [f for f in out.split("\n") if f]
        tests = [f for f in changed if TEST_RE.search(f)]
        impl = [f for f in changed
                if not TEST_RE.search(f) and not DOC_RE.search(f)]
        if not tests or not impl:
            reasons["merge lacks impl+test pair"] += 1
            continue

        # The runner reverts with `git checkout <commit>^1 -- <paths>`, which
        # fails outright on a file the merge ADDED -- it does not exist at the
        # parent. Keep only impl files that exist on both sides. If that leaves
        # nothing, the change was pure addition and this construction cannot
        # express it as a red baseline; drop it rather than ship a task whose
        # revert step errors.
        # The runner reverts with `git checkout <commit>^1 -- <paths>` and the
        # validator restores with `git checkout <commit> -- <paths>`, so a path
        # must exist on BOTH sides. A file the merge ADDED breaks the revert; a
        # file the merge DELETED breaks the restore. Require both trees.
        rc, present = run(["git", "ls-tree", "-r", "--name-only", f"{merge}^1"],
                          repo_path, timeout=120)
        rc2, at_merge = run(["git", "ls-tree", "-r", "--name-only", merge],
                            repo_path, timeout=120)
        if rc != 0 or rc2 != 0:
            reasons["tree listing unavailable"] += 1
            continue
        parent_files = set(present.split("\n"))
        merge_files = set(at_merge.split("\n"))
        both = parent_files & merge_files
        dropped = [f for f in impl if f not in both]
        impl = [f for f in impl if f in both]
        if not impl:
            reasons["fix is pure addition/deletion (nothing revertable)"] += 1
            continue
        if dropped:
            reasons["_note: dropped added/deleted files from revert set"] += len(dropped)

        # --- the answer-leak gate -------------------------------------------
        # The construction assumes the first user message is a user's ASK. In
        # this corpus it frequently is not: it is a Jira ticket carrying an
        # implementation spec, or a QA invocation naming the files to look at.
        # Either hands the replayed agent the answer, and 14 of the first 30
        # validated tasks did exactly that. Reject on evidence, not on shape
        # alone: if the prompt names a file the task reverts, or names the test
        # that grades it, it is not a task.
        leak = _leaks_answer(intent, impl, tests)
        if leak:
            reasons[f"answer leak: {leak}"] += 1
            ledger.append(dict(repo=repo_dir, key=key_used, commit=merge,
                               status="rejected", why=f"answer leak: {leak}"))
            continue

        test_cmd = derive_test_cmd(tests, repo_path)
        if not test_cmd:
            reasons["no derivable test command"] += 1
            ledger.append(dict(repo=repo_dir, key=key_used, commit=merge,
                               status="no test_cmd", tests=tests[:5]))
            continue

        seen_commits.add(merge)
        sens = sensitivity(intent, " ".join(changed), repo_dir)
        tasks.append({
            "id": f"{repo_dir}-{key_used}".lower(),
            "commit": merge,
            "kind": classify_kind(intent, impl),
            "lang": lang_of(impl),
            "sensitivity": sens,
            "source": {
                "ticket": key_used,
                "repo": repo_dir,
                "transcript": path.name,
            },
            "revert_paths": sorted(impl),
            "test_cmd": test_cmd,
            "test_timeout": 900,
            "prompt": scrub(intent).strip(),
        })
        ledger.append(dict(repo=repo_dir, key=key_used, commit=merge,
                           status="task", sensitivity=sens))

    tasks.sort(key=lambda t: t["id"])
    payload = {
        "_comment": [
            "Replay tasks mined from the Turma hub's archived session history",
            "(XERK-445 Phase 0). The prompt is the session's FIRST user message,",
            "scrubbed -- the real ask, before any work happened. Nothing from the",
            "body of the transcript is included, so a replay cannot read the answer",
            "out of the task. Grading is mechanical and comes from git, not from the",
            "transcript: check out `commit`, revert `revert_paths` to the parent, and",
            "the repo's own tests must go red-then-green.",
            "sensitivity=local-only tasks must never be sent to a cloud endpoint.",
            "Every task still has to pass bench/validate_tasks.py before it is used.",
        ],
        "tasks": tasks,
    }
    with open(args.out, "w", encoding="utf8") as fh:
        json.dump(payload, fh, indent=1)
        fh.write("\n")

    by_repo = collections.Counter(t["source"]["repo"] for t in tasks)
    by_kind = collections.Counter(t["kind"] for t in tasks)
    by_lang = collections.Counter(t["lang"] for t in tasks)
    by_sens = collections.Counter(t["sensitivity"] for t in tasks)
    print(f"transcripts examined : {len(files)}")
    print(f"tasks curated        : {len(tasks)}  -> {args.out}")
    print(f"  by repo  : {dict(by_repo.most_common())}")
    print(f"  by kind  : {dict(by_kind)}")
    print(f"  by lang  : {dict(by_lang)}")
    print(f"  sensitivity: {dict(by_sens)}")
    print("\ncandidates dropped, by reason:")
    for r, n in reasons.most_common():
        print(f"  {n:5}  {r}")
    if args.report:
        with open(args.report, "w", encoding="utf8") as fh:
            json.dump(ledger, fh, indent=1)
        print(f"\nledger -> {args.report}")


if __name__ == "__main__":
    main()
