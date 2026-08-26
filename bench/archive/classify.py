#!/usr/bin/env python3
"""Classify every assistant turn in an archived-session corpus by turn type.

XERK-445 Phase 0 step 2. The point is not the labels themselves: it is the
TOKEN WEIGHT behind each label. The ticket's thesis is that most tokens in a
long agent session go to execution rather than planning, so a router can push
execution onto a cheap tier. That is a measurable claim about our own workload,
and this measures it.

A *turn* is one assistant message -- the unit a router actually decides on. It
is classified from signals that a router could also see at decision time
(the tools the turn is about to call, and whether the previous tool result was
an error), so the resulting split is directly comparable to what a signal-based
router like Switchyard's `stage_router` would do.

Usage:
    python3 bench/archive/classify.py --corpus DIR [--json OUT] [--limit N]

The corpus is a tree of raw Claude Code transcripts as archived by the Turma
hub (`<repo>/<file>.jsonl.raw/<id>/<id>.jsonl`); see bench/archive/README.md.
"""

import argparse
import collections
import json
import os
import pathlib
import sys

# --- turn taxonomy ---------------------------------------------------------
# These are the ticket's six categories, plus DELEGATION, which the ticket did
# not name but which our workload turns out to contain a lot of (subagents).
PLANNING = "planning"
CODE_EDIT = "code_edit"
TOOL_EXEC = "tool_exec"          # tool call + result validation
FILE_READ = "file_read_search"
ERROR_RECOVERY = "error_recovery"
SUMMARIZATION = "summarization"
DELEGATION = "delegation"
NARRATION = "narration"        # prose glue between tool calls

CATEGORIES = [PLANNING, CODE_EDIT, TOOL_EXEC, FILE_READ,
              ERROR_RECOVERY, SUMMARIZATION, DELEGATION, NARRATION]

EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit", "ApplyPatch"}
READ_TOOLS = {"Read", "Glob", "Grep", "LS", "NotebookRead", "ToolSearch"}
DELEGATE_TOOLS = {"Task", "Agent", "Workflow", "Skill"}
PLAN_TOOLS = {"ExitPlanMode", "EnterPlanMode", "TaskCreate", "TaskUpdate",
              "AskUserQuestion", "TodoWrite"}

# Markers that a tool result came back bad even when is_error is False --
# a command can exit non-zero, or print a traceback, and still be reported as
# a successful tool call.
ERROR_MARKERS = (
    "Traceback (most recent call last)", "command not found", "No such file",
    "Permission denied", "fatal:", "error:", "ERROR:", "FAILED", "AssertionError",
    "SyntaxError", "npm ERR!", "exit code 1", "Exit code 1",
)


def _usage_tokens(usage):
    """Tokens on one transcript ENTRY, split into the parts that price
    differently. cache_read is ~10x cheaper than fresh input and dominates
    volume, so a split that ignores it badly misstates where money goes."""
    if not isinstance(usage, dict):
        return dict(input=0, cache_creation=0, cache_read=0, output=0)
    return dict(
        input=int(usage.get("input_tokens") or 0),
        cache_creation=int(usage.get("cache_creation_input_tokens") or 0),
        cache_read=int(usage.get("cache_read_input_tokens") or 0),
        output=int(usage.get("output_tokens") or 0),
    )


def _reduce_usage(entry_usages):
    """Collapse the entries of ONE requestId into that API call's real cost.

    Claude Code writes one transcript entry per content block, so a single
    assistant message arrives as 2-3 entries sharing a requestId. Measured over
    the corpus: the three input-side counters repeat the SAME value on every
    entry of the group, while output_tokens grows to a final cumulative figure
    on the last one. Summing therefore triple-counts the prompt -- it inflated
    this corpus to 21.1 billion tokens, ~3x the truth.

    Taking the max of each is right for both shapes: identical values collapse
    to themselves, and the growing output counter collapses to its total.
    """
    if not entry_usages:
        return dict(input=0, cache_creation=0, cache_read=0, output=0)
    return {k: max(u[k] for u in entry_usages)
            for k in ("input", "cache_creation", "cache_read", "output")}


def _text_of(content):
    if isinstance(content, str):
        return content
    out = []
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                out.append(b.get("text") or "")
    return "\n".join(out)


def _result_looks_bad(block):
    if block.get("is_error"):
        return True
    body = block.get("content")
    if isinstance(body, list):
        body = " ".join(str(x.get("text", "")) for x in body
                        if isinstance(x, dict))
    body = str(body or "")[:4000]
    return any(m in body for m in ERROR_MARKERS)


def classify_turn(tools, text, prev_result_bad, is_last):
    """Classify one assistant turn.

    Order matters. Error recovery wins over what the turn happens to call,
    because a router that cannot tell 'editing a file' from 'editing a file to
    undo a failure' would route the hard case to the cheap tier -- which is the
    exact failure mode this classification exists to expose.
    """
    if prev_result_bad:
        return ERROR_RECOVERY
    if tools & DELEGATE_TOOLS:
        return DELEGATION
    if tools & EDIT_TOOLS:
        return CODE_EDIT
    if tools & PLAN_TOOLS:
        return PLANNING
    if tools & READ_TOOLS:
        return FILE_READ
    if tools:  # Bash and anything else that acts on the world
        return TOOL_EXEC
    # No tools at all: prose. A turn that ends the session is a real summary;
    # a short one mid-session is narration ("Now the payload generator:"), which
    # is execution glue and must not be counted as summarization -- doing so put
    # 39% of this corpus in the wrong bucket.
    stripped = (text or "").strip()
    if is_last:
        return SUMMARIZATION
    if len(stripped) > 600:
        return PLANNING
    return NARRATION


def walk_transcript(path):
    """Yield (category, tokens, meta) per API TURN in one transcript.

    The unit is a requestId group, not a transcript entry: that is one API call,
    one billed unit, and one routing decision. See _reduce_usage.
    """
    entries = []
    try:
        with open(path, encoding="utf8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except (ValueError, TypeError):
                    continue
    except OSError:
        return

    # Walk once, in order, building turns. Order matters for error recovery:
    # a turn is recovery only if the tool results it is reacting to came back bad.
    turns = []            # [{req, entries[], idx}]
    by_req = {}
    prev_result_bad = False
    pending_bad = {}      # req -> was the preceding tool result bad

    for o in entries:
        etype = o.get("type")
        if etype == "user":
            content = o.get("message", {}).get("content")
            if isinstance(content, list) and any(
                    isinstance(b, dict) and b.get("type") == "tool_result"
                    for b in content):
                prev_result_bad = any(
                    isinstance(b, dict) and b.get("type") == "tool_result"
                    and _result_looks_bad(b) for b in content)
            else:
                prev_result_bad = False
            continue
        if etype != "assistant":
            continue

        msg = o.get("message", {}) or {}
        if msg.get("model") == "<synthetic>":
            continue  # harness-generated, never billed, never routed

        req = o.get("requestId") or f"_solo_{len(turns)}_{o.get('uuid')}"
        if req not in by_req:
            by_req[req] = {"req": req, "entries": [], "bad": prev_result_bad}
            turns.append(by_req[req])
        by_req[req]["entries"].append(o)

    for i, turn in enumerate(turns):
        tools = set()
        texts = []
        usages = []
        model = None
        sidechain = False
        for o in turn["entries"]:
            msg = o.get("message", {}) or {}
            model = model or msg.get("model")
            sidechain = sidechain or bool(o.get("isSidechain"))
            usages.append(_usage_tokens(msg.get("usage")))
            for c in msg.get("content", []) or []:
                if not isinstance(c, dict):
                    continue
                if c.get("type") == "tool_use":
                    tools.add(c.get("name"))
                elif c.get("type") == "text":
                    texts.append(c.get("text") or "")

        cat = classify_turn(tools, "\n".join(texts), turn["bad"],
                            i == len(turns) - 1)
        yield cat, _reduce_usage(usages), {
            "model": model,
            "sidechain": sidechain,
            "tools": sorted(t for t in tools if t),
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--json", help="write full results here")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    files = sorted(pathlib.Path(args.corpus).rglob("*.jsonl"))
    files = [f for f in files if ".jsonl.raw" in str(f)]
    if args.limit:
        files = files[:args.limit]
    if not files:
        sys.exit(f"no raw transcripts under {args.corpus}")

    turns = collections.Counter()
    tokens = {c: collections.Counter() for c in CATEGORIES}
    sidechain_turns = collections.Counter()
    models = collections.Counter()
    tool_hist = collections.Counter()
    per_repo = collections.defaultdict(collections.Counter)
    scanned = 0

    for path in files:
        repo = path.relative_to(args.corpus).parts[0]
        got = False
        for cat, tok, meta in walk_transcript(path):
            got = True
            turns[cat] += 1
            per_repo[repo][cat] += 1
            for k, v in tok.items():
                tokens[cat][k] += v
            if meta["sidechain"]:
                sidechain_turns[cat] += 1
            if meta["model"]:
                models[meta["model"]] += 1
            for t in meta["tools"]:
                tool_hist[t] += 1
        if got:
            scanned += 1

    total_turns = sum(turns.values())
    if not total_turns:
        sys.exit("no assistant turns found")

    def tot(c):
        t = tokens[c]
        return t["input"] + t["cache_creation"] + t["cache_read"] + t["output"]

    grand = sum(tot(c) for c in CATEGORIES) or 1
    grand_out = sum(tokens[c]["output"] for c in CATEGORIES) or 1

    print(f"transcripts scanned : {scanned}")
    print(f"assistant turns     : {total_turns}")
    print()
    hdr = f"{'category':16} {'turns':>7} {'turn%':>7} {'tokens':>14} {'tok%':>7} {'output':>12} {'out%':>7}"
    print(hdr)
    print("-" * len(hdr))
    for c in sorted(CATEGORIES, key=lambda x: -turns[x]):
        print(f"{c:16} {turns[c]:>7} {100*turns[c]/total_turns:>6.1f}% "
              f"{tot(c):>14,} {100*tot(c)/grand:>6.1f}% "
              f"{tokens[c]['output']:>12,} {100*tokens[c]['output']/grand_out:>6.1f}%")
    print("-" * len(hdr))
    print(f"{'TOTAL':16} {total_turns:>7} {'100.0%':>7} {grand:>14,} {'100.0%':>7} "
          f"{grand_out:>12,} {'100.0%':>7}")

    # The routing-relevant summary: which turns a signal-based router would
    # push down, and what share of the bill they carry.
    weak = [TOOL_EXEC, FILE_READ, CODE_EDIT, SUMMARIZATION, NARRATION]
    strong = [PLANNING, ERROR_RECOVERY, DELEGATION]
    wt = sum(turns[c] for c in weak)
    wtok = sum(tot(c) for c in weak)
    wout = sum(tokens[c]["output"] for c in weak)
    print()
    print("candidate weak tier :", ", ".join(weak))
    print(f"  {wt} turns ({100*wt/total_turns:.1f}%), "
          f"{100*wtok/grand:.1f}% of all tokens, {100*wout/grand_out:.1f}% of output tokens")
    print("candidate strong tier:", ", ".join(strong))
    st = total_turns - wt
    print(f"  {st} turns ({100*st/total_turns:.1f}%), "
          f"{100*(grand-wtok)/grand:.1f}% of all tokens, "
          f"{100*(grand_out-wout)/grand_out:.1f}% of output tokens")

    print()
    print("sidechain (subagent) turns:", sum(sidechain_turns.values()),
          f"({100*sum(sidechain_turns.values())/total_turns:.1f}%)")
    print("top models:", ", ".join(f"{m}={n}" for m, n in models.most_common(6)))
    print("top tools :", ", ".join(f"{t}={n}" for t, n in tool_hist.most_common(10)))

    if args.json:
        with open(args.json, "w", encoding="utf8") as fh:
            json.dump({
                "transcripts": scanned,
                "turns": dict(turns),
                "tokens": {c: dict(tokens[c]) for c in CATEGORIES},
                "sidechain": dict(sidechain_turns),
                "models": dict(models),
                "tools": dict(tool_hist),
                "per_repo": {r: dict(v) for r, v in per_repo.items()},
            }, fh, indent=2)
        print(f"\nwrote {args.json}")


if __name__ == "__main__":
    main()
