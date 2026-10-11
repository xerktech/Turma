#!/usr/bin/env python3
"""Replay a model-escalation POLICY over the validated task set (XERK-1827).

run_bench.py holds the model fixed per run; this runs each task through a tier
ladder the way the hub now runs a ticket: the first tier gets a fresh attempt,
and only a task it did not DELIVER (tests green AND committed) moves to the next
tier, which starts from a fresh worktree with the retry preamble a production
retry session gets. The result is each policy's solve rate and dollar cost side
by side, so it is the regression gate for any later change to the ladder.

    TURMA_LOCAL_BASE_URL=... TURMA_LOCAL_API_KEY=... \\
      python3 bench/run_policy.py --repo /path/to/Turma \\
        --policy ladder --policy always-opus --out policy.json

    python3 bench/run_policy.py --summarize policy.json    # no model calls

Scoring, the delivery contract, the cap and the infra-retry rule are
run_bench.py's, unchanged; this only decides WHICH model runs next.
"""

import argparse
import concurrent.futures
import json
import os
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import run_bench  # noqa: E402

# Gateway ids for each alias — the same Bedrock models the XERK-445 spike
# measured. opus is 4-5, not 4-6: 4-6's daily gateway quota let only 2 tasks run.
GATEWAY_MODELS = {
    "haiku": "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "sonnet": "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "opus": "bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0",
}

# USD per million tokens: input, output, cache write (5m), cache read — Bedrock
# on-demand list prices for the models above.
PRICES = {
    "haiku": (1.00, 5.00, 1.25, 0.10),
    "sonnet": (3.00, 15.00, 3.75, 0.30),
    "opus": (5.00, 25.00, 6.25, 0.50),
}

# The ladders. "ladder" is the production policy: it MUST match the hub's
# TICKET_MODEL_LADDER (turma/server.js), or this gate measures a policy nobody
# runs. Tests: TestPolicyMatchesHub.
POLICIES = {
    "ladder": ["haiku", "sonnet", "opus"],
    "always-opus": ["opus"],
    "always-haiku": ["haiku"],
    "always-sonnet": ["sonnet"],
}

# Prepended to a retry tier's prompt. Mirrors the agent's TICKET_RETRY_DIRECTIVE
# minus the branch sentence: a bench run never pushes, so there is no earlier
# branch to find.
RETRY_PREAMBLE = (
    "A previous attempt at this task ran on {prev} and ended without delivering "
    "a working, committed change. This attempt runs on a stronger model. Start "
    "fresh from the current tree.\n\n"
)


def cost_usd(alias, rec):
    """Dollar cost of one run from its deduplicated transcript usage."""
    pi, po, pw, pr = PRICES[alias]
    return round((rec.get("input_tokens", 0) * pi
                  + rec.get("output_tokens", 0) * po
                  + rec.get("cache_creation_tokens", 0) * pw
                  + rec.get("cache_read_tokens", 0) * pr) / 1e6, 4)


def delivered(rec):
    """The production bar: the change works AND it was committed."""
    return bool(rec.get("solved")) and bool(rec.get("committed"))


def run_ladder(repo, task, ladder, args, run_one=run_bench.one_run):
    """Walk one task up a ladder; stop at the first tier that delivers.

    A run that never reached the model (infra) or could not be bootstrapped
    (setup) ends the walk WITHOUT escalating: neither says anything about the
    tier's ability, and escalating would bill the next tier for a gateway blip.
    """
    tiers = []
    prev = None
    for alias in ladder:
        prefix = RETRY_PREAMBLE.format(prev=prev) if prev else ""
        rec = run_one(repo, task, "claude-local", 1, args, args.workroot,
                      model=GATEWAY_MODELS[alias], prompt_prefix=prefix)
        rec["tier"] = alias
        rec["retry"] = bool(prev)
        rec["cost_usd"] = cost_usd(alias, rec)
        tiers.append(rec)
        if delivered(rec) or rec.get("infra_failure") or rec.get("setup_failed"):
            break
        prev = alias
    last = tiers[-1]
    return {
        "task": task["id"],
        "tiers": tiers,
        "delivered": delivered(last),
        "delivered_by": last["tier"] if delivered(last) else None,
        "inconclusive": bool(last.get("infra_failure") or last.get("setup_failed")),
        "cost_usd": round(sum(t["cost_usd"] for t in tiers), 4),
        "seconds": round(sum(t.get("seconds", 0) for t in tiers), 1),
    }


def summarize(results, out=sys.stdout):
    """Print one row per policy, plus each policy's cost against always-opus."""
    rows = {}
    for name, per_task in results["policies"].items():
        recs = list(per_task.values())
        scored = [r for r in recs if not r["inconclusive"]]
        solved = sum(r["delivered"] for r in scored)
        cost = round(sum(r["cost_usd"] for r in recs), 2)
        by = {}
        for r in scored:
            if r["delivered_by"]:
                by[r["delivered_by"]] = by.get(r["delivered_by"], 0) + 1
        rows[name] = {"solved": solved, "scored": len(scored),
                      "inconclusive": len(recs) - len(scored), "cost_usd": cost,
                      "usd_per_solve": round(cost / solved, 2) if solved else None,
                      "delivered_by": by}
    base = rows.get("always-opus", {}).get("cost_usd")
    print(f"{'policy':<14} {'solved':>9} {'$ total':>9} {'$/solve':>8} "
          f"{'vs opus':>8}  delivered by", file=out)
    for name, r in rows.items():
        rel = f"{r['cost_usd'] / base:.2f}x" if base else "—"
        per = f"{r['usd_per_solve']:.2f}" if r["usd_per_solve"] is not None else "—"
        inc = f" (+{r['inconclusive']} inconclusive)" if r["inconclusive"] else ""
        print(f"{name:<14} {r['solved']:>3}/{r['scored']:<5} {r['cost_usd']:>9.2f} "
              f"{per:>8} {rel:>8}  {r['delivered_by']}{inc}", file=out)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo")
    ap.add_argument("--tasks", default=os.path.join(HERE, "archive", "tasks-validated.json"))
    ap.add_argument("--id-prefix", default="turma-",
                    help="task ids to run; turma- is the 25-task set the spike measured")
    ap.add_argument("--id", action="append", help="run only these task ids")
    ap.add_argument("--policy", action="append", choices=list(POLICIES))
    ap.add_argument("--cap", type=int, default=1500)
    ap.add_argument("--infra-retries", type=int, default=2)
    ap.add_argument("--jobs", type=int, default=1,
                    help="concurrent tasks; the gateway 429s well before 12")
    ap.add_argument("--workroot", default=os.path.expanduser("~/turma-policy/work"))
    ap.add_argument("--runs", default=os.path.expanduser("~/turma-policy/runs"))
    ap.add_argument("--out", default=os.path.expanduser("~/turma-policy/results.json"))
    ap.add_argument("--summarize", metavar="RESULTS",
                    help="print the table for an existing results file and exit")
    args = ap.parse_args()

    if args.summarize:
        with open(args.summarize) as fh:
            summarize(json.load(fh))
        return 0
    if not args.repo or not os.path.isdir(os.path.join(args.repo, ".git")):
        sys.exit("--repo must be a git checkout of the tasks' repo")
    for var in ("TURMA_LOCAL_BASE_URL", "TURMA_LOCAL_API_KEY"):
        if not os.environ.get(var):
            sys.exit(f"{var} must be set in the environment")
    policies = args.policy or ["ladder", "always-opus"]
    with open(args.tasks) as fh:
        tasks = [t for t in json.load(fh)["tasks"] if t["id"].startswith(args.id_prefix)]
    if args.id:
        tasks = [t for t in tasks if t["id"] in args.id]
    os.makedirs(args.workroot, exist_ok=True)

    # Resumable: tasks already in --out are kept and skipped, and the file is
    # rewritten after every task, so a killed run loses at most what was in flight.
    results = {"policies": {}}
    if os.path.exists(args.out):
        with open(args.out) as fh:
            results = json.load(fh)
    lock = threading.Lock()

    def job(name, task):
        rec = run_ladder(args.repo, task, POLICIES[name], args)
        with lock:
            results["policies"].setdefault(name, {})[task["id"]] = rec
            with open(args.out + ".tmp", "w") as fh:
                json.dump(results, fh, indent=2)
            os.replace(args.out + ".tmp", args.out)

    todo = [(p, t) for p in policies for t in tasks
            if t["id"] not in results["policies"].get(p, {})]
    print(f"{len(todo)} ladder walks ({len(tasks)} tasks x {policies}), "
          f"{args.jobs} at a time\n", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for f in concurrent.futures.as_completed(
                [pool.submit(job, p, t) for p, t in todo]):
            f.result()
    print()
    summarize(results)
    print(f"\nfull records: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
