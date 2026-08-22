#!/usr/bin/env python3
"""Run the coding-agent bench: N harnesses x M tasks against one local model.

Every harness gets the identical task prompt, the identical delivery contract,
the identical time cap and a pristine worktree, so the only variable is the
harness itself. Scoring is mechanical — the repo's own regression tests decide
whether a task was solved; nothing is judged by a model.

    python3 bench/run_bench.py --repo /path/to/Turma --harness opencode aider
    python3 bench/run_bench.py --repo /path/to/Turma --attempts 2 --jobs 3

Credentials are never read from disk or written to a config: the base URL and
key come from TURMA_LOCAL_BASE_URL / TURMA_LOCAL_API_KEY in the environment and
are passed to each harness the way that harness expects.
"""

import argparse
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIGS = os.path.join(HERE, "configs")
# The model every harness is pointed at. Overridable so one task set can be run
# across a whole model matrix -- which is the point of XERK-445 Phase 3: the
# harness is held fixed and the MODEL is the variable, the inverse of the
# bake-off this directory was built for.
MODEL = os.environ.get("TURMA_LOCAL_MODEL", "gpt-oss:120b")

# Appended verbatim to every task prompt, for every harness. Kept out of
# tasks.json so a harness can never be measured against different wording.
DELIVERY_CONTRACT = (
    "\n\nYou are running unattended — no one is available to answer questions or "
    "approve a plan, so never end your turn with a question or an offer. Work "
    "until the task is actually done. Verify your change by running the "
    "repository's own tests for the code you touched. When it is done, create a "
    "git branch and commit your work to it. Do not push and do not open a pull "
    "request."
)


def _bin(*names):
    """First existing path among the candidates, else the bare name."""
    for n in names:
        if os.path.exists(n):
            return n
    return os.path.basename(names[0])


OPENCODE = _bin("/root/.local/node/bin/opencode", "/usr/local/bin/opencode")
CRUSH = _bin("/root/.local/node/bin/crush", "/usr/local/bin/crush")
CODEX = _bin("/root/.local/node/bin/codex", "/usr/local/bin/codex")
GOOSE = _bin("/root/.local/bin/goose", "/usr/local/bin/goose")
AIDER = _bin("/root/.local/bin/aider", "/usr/local/bin/aider")


def base_env():
    env = os.environ.copy()
    # Not /root/tmp: this used to run as root and the hardcoded path is simply
    # unwritable for anyone else, which surfaces as every task "abandoning" in
    # ~7s with EACCES rather than as a setup error.
    tmp = os.environ.get("TMPDIR") or os.path.join(
        os.path.expanduser("~"), ".cache", "turma-bench-tmp")
    os.makedirs(tmp, exist_ok=True)
    env["TMPDIR"] = tmp
    # Keep every harness from picking up an ambient cloud login: the bench is
    # explicitly about the SELF-HOSTED model, and a stray key would silently
    # benchmark someone else's frontier model instead.
    for k in ("ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY"):
        env.pop(k, None)
    return env


def harness_opencode(prompt, env):
    env = dict(env)
    env["OPENCODE_CONFIG"] = os.path.join(CONFIGS, "opencode.json")
    # --print-logs puts the session's own diagnostics on stderr (merged into the
    # transcript), which is the only way to see WHERE a stalled run stopped:
    # without it a hung session records an empty log.
    return [OPENCODE, "run", "--print-logs", "--log-level", "INFO",
            "--model", f"local/{MODEL}", prompt], env


def harness_crush(prompt, env):
    env = dict(env)
    # Crush auto-configures a cloud OpenAI provider from this var and would
    # then ignore our local one.
    env.pop("OPENAI_API_KEY", None)
    cfg_dir = os.path.expanduser("~/.config/crush")
    os.makedirs(cfg_dir, exist_ok=True)
    shutil.copy(os.path.join(CONFIGS, "crush.json"), os.path.join(cfg_dir, "crush.json"))
    return [CRUSH, "run", prompt], env


def harness_codex(prompt, env):
    cfg_dir = os.path.expanduser("~/.codex")
    os.makedirs(cfg_dir, exist_ok=True)
    # Codex does not expand env vars inside base_url, so the URL is substituted
    # here. The KEY still comes from the environment via env_key.
    with open(os.path.join(CONFIGS, "codex-config.toml")) as fh:
        toml = fh.read().replace("$TURMA_LOCAL_BASE_URL", env["TURMA_LOCAL_BASE_URL"])
    with open(os.path.join(cfg_dir, "config.toml"), "w") as fh:
        fh.write(toml)
    return [CODEX, "exec", "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox", prompt], env


def harness_goose(prompt, env):
    env = dict(env)
    url = env["TURMA_LOCAL_BASE_URL"].rstrip("/")
    host, _, _ = url.rpartition("/v1")
    env["OPENAI_HOST"] = host or url
    env["OPENAI_BASE_PATH"] = "v1/chat/completions"
    env["OPENAI_API_KEY"] = env["TURMA_LOCAL_API_KEY"]
    cfg_dir = os.path.expanduser("~/.config/goose")
    os.makedirs(cfg_dir, exist_ok=True)
    shutil.copy(os.path.join(CONFIGS, "goose-config.yaml"), os.path.join(cfg_dir, "config.yaml"))
    # Goose stops after a default number of turns "without asking for user
    # input to continue" — unattended, that reads as giving up mid-exploration,
    # so the cap is raised to the same effective ceiling the others have (their
    # own wall-clock limit).
    return [GOOSE, "run", "--no-session", "--max-turns", "200", "-t", prompt], env


def harness_aider(prompt, env):
    env = dict(env)
    env["OPENAI_API_KEY"] = env["TURMA_LOCAL_API_KEY"]
    env["AIDER_ANALYTICS"] = "false"
    return [AIDER, "--model", f"openai/{MODEL}",
            "--openai-api-base", env["TURMA_LOCAL_BASE_URL"],
            "--yes-always", "--no-check-update", "--no-show-model-warnings",
            "--no-analytics", "--no-gitignore",
            "--message", prompt], env


def harness_claude_local(prompt, env):
    """Claude Code itself, pointed at the self-hosted model.

    Claude Code speaks the Anthropic Messages API, and the LiteLLM gateway
    serves /v1/messages against the same gpt-oss backend — so the CLI we already
    ship, with every Turma integration intact, can run on the local model with
    nothing but environment variables. CLAUDE_CONFIG_DIR isolates this from the
    host's real login so a bench run can never touch the operator's ~/.claude.
    """
    env = dict(env)
    url = env["TURMA_LOCAL_BASE_URL"].rstrip("/")
    host, _, _ = url.rpartition("/v1")
    env["ANTHROPIC_BASE_URL"] = host or url
    env["ANTHROPIC_AUTH_TOKEN"] = env["TURMA_LOCAL_API_KEY"]
    env["ANTHROPIC_MODEL"] = MODEL
    env["ANTHROPIC_SMALL_FAST_MODEL"] = MODEL
    # Claude Code does not know this model's window and would otherwise assume
    # 200k and compact far too late. Tracks the server's real per-slot window
    # (see docs/opencode-model-eval-2026-08.md's sizing).
    env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] = os.environ.get("TURMA_LOCAL_CONTEXT", "81920")
    # Isolated from the operator's real login: a bench run must never write to
    # the ~/.claude the fleet's sessions share. Overridable, and defaulted under
    # the runs directory rather than a machine-specific absolute path.
    env["CLAUDE_CONFIG_DIR"] = env.get(
        "BENCH_CLAUDE_CONFIG_DIR",
        os.path.join(os.path.expanduser("~"), ".turma-bench-claude"))
    return ["claude", "-p", "--permission-mode", "bypassPermissions", prompt], env


HARNESSES = {
    "claude-local": harness_claude_local,
    "opencode": harness_opencode,
    "crush": harness_crush,
    "codex": harness_codex,
    "goose": harness_goose,
    "aider": harness_aider,
}

# Aider commits its own edits by default; that is a real product capability, but
# it means its "committed" score is not model-driven the way the others' are.
AUTO_COMMITS = {"aider"}


def run(cmd, cwd=None, timeout=600, env=None):
    proc = subprocess.run(cmd, cwd=cwd, timeout=timeout, env=env,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return proc.returncode, proc.stdout


# Instruction files every one of these harnesses auto-loads into its context.
# They are removed from the prepared worktree — see strip_agent_instructions.
AGENT_INSTRUCTION_FILES = ("CLAUDE.md", "AGENTS.md", "CRUSH.md", "GEMINI.md",
                           ".cursorrules", ".windsurfrules")


def strip_agent_instructions(dest):
    """Remove the repo's agent instruction files from a prepared worktree.

    These commits predate XERK-244, when CLAUDE.md was a single 160-175k-CHAR
    file. Every harness here auto-loads it, which costs ~40k tokens before any
    work starts — more than half of this model's 64k window — and Claude Code
    simply refuses with "Prompt is too long". Worse, it is not neutral guidance:
    its delivery rules told agents to push and open a PR and watch CI, which is
    a different task than the one being scored.

    Today's repo does not look like that (22k chars, the rest in path-scoped
    rules that load only on matching files), so leaving it in would measure a
    historical artifact rather than the harnesses. It is stripped identically
    for every harness, and no task's tests reference it.
    """
    removed = []
    for name in AGENT_INSTRUCTION_FILES:
        path = os.path.join(dest, name)
        if os.path.exists(path):
            os.remove(path)
            removed.append(name)
    return removed


def prepare(repo, task, dest):
    """Fresh worktree at the fix commit with the implementation rolled back."""
    if os.path.exists(dest):
        run(["git", "worktree", "remove", "--force", dest], cwd=repo)
        shutil.rmtree(dest, ignore_errors=True)
    rc, out = run(["git", "worktree", "add", "--detach", dest, task["commit"]], cwd=repo)
    if rc != 0:
        raise RuntimeError(f"worktree add: {out[:200]}")
    rc, out = run(["git", "checkout", f"{task['commit']}^", "--"] + task["revert_paths"], cwd=dest)
    if rc != 0:
        raise RuntimeError(f"revert: {out[:200]}")
    strip_agent_instructions(dest)
    run(["git", "-c", "user.email=bench@turma", "-c", "user.name=bench",
         "commit", "-qam", "bench: broken baseline"], cwd=dest)
    rc, head = run(["git", "rev-parse", "HEAD"], cwd=dest)
    return head.strip()


def score(task, dest, baseline):
    """Did the tests go green, and did the agent commit anything?"""
    try:
        rc, out = run(task["test_cmd"], cwd=dest, timeout=task.get("test_timeout", 600))
        solved = rc == 0
    except subprocess.TimeoutExpired:
        solved, out = False, "tests timed out"
    _, log = run(["git", "log", "--oneline", f"{baseline}..HEAD"], cwd=dest)
    _, dirty = run(["git", "status", "--porcelain"], cwd=dest)
    return {
        "solved": solved,
        "committed": bool(log.strip()),
        "commits": [l for l in log.splitlines() if l.strip()],
        "left_uncommitted": bool(dirty.strip()),
        "test_tail": out[-1500:],
    }


# A run that never reached the model tells us nothing about the harness. These
# are the gateway/transport failures seen in practice (Bun's fetch wording, plus
# the usual proxy codes); a run whose transcript is only these, with no tool
# activity, is retried rather than scored as a capability failure.
INFRA_ERROR_RE = re.compile(
    r"Unable to connect|Cannot connect to API|ECONNRESET|ECONNREFUSED|ETIMEDOUT|"
    r"socket hang up|502 Bad Gateway|503 Service|504 Gateway|Connection error",
    re.I)
# Evidence the harness actually got a model turn back and acted on it. Kept to
# capitalised tool NAMES and unambiguous markers: bare words like "shell" appear
# in harness diagnostics ("shell tool using shell shell=/usr/bin/zsh") and would
# otherwise read as activity in a session that never reached the model.
TOOL_ACTIVITY_RE = re.compile(
    r"\b(Read|Edit|Write|Glob|Grep|Bash|MultiEdit|apply_patch|todowrite|"
    r"tool_call|tool_use)\b")
# Structured diagnostic lines emitted by the harnesses themselves. They are not
# model output, so they must not count as activity when deciding whether a run
# ever got off the ground.
DIAGNOSTIC_LINE_RE = re.compile(r"^\s*(timestamp=|\{\"time\":|\[\d{4}-\d{2}-\d{2})")


def looks_like_infra_failure(out):
    """True when the transcript is transport errors and nothing else.

    Harness diagnostics are stripped first: a run that only ever logged its own
    startup and then failed to connect has done no work, however many tool-ish
    words its logs happen to contain.
    """
    if not out or not INFRA_ERROR_RE.search(out):
        return False
    model_output = "\n".join(ln for ln in out.splitlines()
                             if not DIAGNOSTIC_LINE_RE.match(ln))
    return not TOOL_ACTIVITY_RE.search(model_output)


def one_run(repo, task, hname, attempt, args, workroot, infra_try=1):
    dest = os.path.join(workroot, f"{hname}-{task['id']}-{attempt}")
    rec = {"harness": hname, "task": task["id"], "attempt": attempt,
           "kind": task["kind"], "lang": task["lang"]}
    started = time.time()
    try:
        baseline = prepare(repo, task, dest)
        cmd, env = HARNESSES[hname](task["prompt"] + DELIVERY_CONTRACT, base_env())
        try:
            rc, out = run(cmd, cwd=dest, timeout=args.cap, env=env)
            rec["timed_out"] = False
        except subprocess.TimeoutExpired as exc:
            # Keep what the harness had already printed — on a timeout that
            # partial transcript is the only evidence of WHERE it got stuck,
            # which is exactly what a cap is there to diagnose.
            partial = exc.output or ""
            if isinstance(partial, bytes):
                partial = partial.decode("utf-8", "replace")
            rc, out = -1, partial + "\n\n[bench] HARNESS TIMED OUT"
            rec["timed_out"] = True
        rec["exit"] = rc
        rec["seconds"] = round(time.time() - started, 1)
        rec.update(score(task, dest, baseline))
        # A session that produced no edit at all and returned almost nothing is
        # the "instant abandon" the July eval documented; worth counting apart
        # from an honest wrong answer.
        rec["abandoned"] = rec["seconds"] < 25 and not rec["committed"] and not rec["solved"]
        rec["infra_failure"] = not rec["solved"] and looks_like_infra_failure(out)
        rec["infra_try"] = infra_try
        os.makedirs(args.runs, exist_ok=True)
        with open(os.path.join(args.runs, f"{hname}-{task['id']}-{attempt}.log"), "w") as fh:
            fh.write(" ".join(cmd[:4]) + "\n\n" + out)
    except Exception as exc:                                    # harness/setup blew up
        rec.update({"error": str(exc)[:300], "solved": False, "committed": False,
                    "seconds": round(time.time() - started, 1)})
    finally:
        run(["git", "worktree", "remove", "--force", dest], cwd=repo)
        shutil.rmtree(dest, ignore_errors=True)
    if rec.get("infra_failure") and infra_try < args.infra_retries:
        print(f"  {hname:<9} {task['id']:<28} attempt {attempt} "
              f"INFRA FAILURE (never reached the model) — retry "
              f"{infra_try + 1}/{args.infra_retries}", flush=True)
        return one_run(repo, task, hname, attempt, args, workroot, infra_try + 1)
    print(f"  {hname:<9} {task['id']:<28} attempt {attempt} "
          f"solved={rec.get('solved')} committed={rec.get('committed')} "
          f"{rec.get('seconds')}s"
          f"{' [INFRA]' if rec.get('infra_failure') else ''}", flush=True)
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--tasks", default=os.path.join(HERE, "tasks.json"))
    ap.add_argument("--harness", nargs="+", default=list(HARNESSES), choices=list(HARNESSES))
    ap.add_argument("--id", action="append", help="run only these task ids")
    ap.add_argument("--attempts", type=int, default=1)
    ap.add_argument("--cap", type=int, default=1500, help="per-run wall-clock cap, seconds")
    ap.add_argument("--infra-retries", type=int, default=2,
                    help="attempts for a run that never reached the model (transport errors)")
    ap.add_argument("--jobs", type=int, default=2,
                    help="concurrent runs; the GPU serves one model, so 2-3 is the useful range")
    ap.add_argument("--workroot", default="/root/turma-bench/work")
    ap.add_argument("--runs", default="/root/turma-bench/runs")
    ap.add_argument("--out", default="/root/turma-bench/results.json")
    args = ap.parse_args()

    for var in ("TURMA_LOCAL_BASE_URL", "TURMA_LOCAL_API_KEY"):
        if not os.environ.get(var):
            sys.exit(f"{var} must be set in the environment")

    if not os.path.isdir(os.path.join(args.repo, ".git")):
        sys.exit(f"--repo {args.repo!r} is not a git checkout")
    with open(args.tasks) as fh:
        tasks = json.load(fh)["tasks"]
    if args.id:
        tasks = [t for t in tasks if t["id"] in args.id]
    os.makedirs(args.workroot, exist_ok=True)

    jobs = [(t, h, a) for a in range(1, args.attempts + 1) for h in args.harness for t in tasks]
    print(f"{len(jobs)} runs: {len(tasks)} tasks x {len(args.harness)} harnesses "
          f"x {args.attempts} attempts, {args.jobs} at a time\n", flush=True)

    records = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futs = [pool.submit(one_run, args.repo, t, h, a, args, args.workroot)
                for (t, h, a) in jobs]
        for fut in concurrent.futures.as_completed(futs):
            records.append(fut.result())

    with open(args.out, "w") as fh:
        json.dump({"model": MODEL, "records": records}, fh, indent=2)

    print("\n" + "=" * 74)
    print(f"{'harness':<10} {'solved':>10} {'committed':>11} {'abandoned':>10} {'median s':>9}")
    print("-" * 74)
    for h in args.harness:
        rs = [r for r in records if r["harness"] == h]
        if not rs:
            continue
        secs = sorted(r.get("seconds", 0) for r in rs)
        med = secs[len(secs) // 2] if secs else 0
        note = " *" if h in AUTO_COMMITS else ""
        infra = sum(bool(r.get("infra_failure")) for r in rs)
        print(f"{h:<10} {sum(bool(r.get('solved')) for r in rs):>4}/{len(rs):<5} "
              f"{sum(bool(r.get('committed')) for r in rs):>6}/{len(rs):<4}{note:<2}"
              f"{sum(bool(r.get('abandoned')) for r in rs):>9} {med:>9}"
              f"{('   ' + str(infra) + ' INFRA') if infra else ''}")
    if set(args.harness) & AUTO_COMMITS:
        print("\n* commits its own edits by default — its 'committed' count is a tool")
        print("  capability, not the model choosing to honor the delivery contract.")
    print(f"\nfull records: {args.out}   transcripts: {args.runs}")


if __name__ == "__main__":
    sys.exit(main())
