#!/usr/bin/env python3
"""Turn the operator's meeting reviews into eval data (XERK-2517).

Every proposal the operator approved, edited or rejected on the Meetings page is
an answer key the synthetic corpus lacks. This reads the hub's meetings (the
same `/api/agents` snapshot the page reads) and:

  report  - counts outcomes, and the number the ticket is judged on: the share of
            reviewed proposals approved WITHOUT edits (title, description, or
            assignee changed counts as an edit).
  cases   - writes one corpus case per reviewed meeting into a directory
            (default `reviewed/`, git-ignored: these are real captions and must
            never be committed). `run_eval.py run --corpus reviewed` scores a
            prompt or model change against them.

    python3 bench/meeting-items/harvest.py report --hub https://turma.example
    python3 bench/meeting-items/harvest.py cases  --hub https://turma.example --out reviewed
    python3 bench/meeting-items/harvest.py report --snapshot agents.json

Auth (operator): TURMA_HUB_COOKIE (a `hub_session` value) or TURMA_HUB_USER +
TURMA_HUB_PASSWORD (break-glass Basic). Never put either on the command line.
"""

import argparse
import base64
import json
import os
import re
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
APPROVED = ("creating", "created", "logged")
WORD_RE = re.compile(r"[^\W\d_]{4,}", re.UNICODE)
STOP = frozenset("that this with from into have will should about their there what when "
                 "make need needs fix add update check".split())
TENANT_TAIL = re.compile(r"@[0-9a-f]{32}$")


def outcome(item):
    """One reviewed proposal's outcome: approved (as proposed), edited, rejected,
    failed (the create failed: says nothing about the proposal) or pending."""
    r = item.get("review") or {}
    state = r.get("state")
    if state in APPROVED:
        return "edited" if r.get("edited") or r.get("assigneeChanged") else "approved"
    if state == "rejected":
        return "rejected"
    if state == "failed":
        return "failed"
    return "pending"


def outcomes(proposals):
    """Rows for every item of every settled meeting, newest meeting first."""
    rows = []
    for site, meetings in sorted((proposals or {}).items()):
        for m in meetings or []:
            if m.get("status") != "ok":
                continue
            for it in m.get("items") or []:
                r = it.get("review") or {}
                rows.append({
                    "site": TENANT_TAIL.sub("", site), "meetingId": m.get("meetingId"),
                    "meeting": m.get("inferredTitle") or m.get("title") or "",
                    "item": it.get("id"), "kind": it.get("kind"), "title": it.get("title"),
                    "suggestedAssignee": it.get("suggestedAssignee"),
                    "mapped": bool(it.get("assignee")),
                    "outcome": outcome(it), "finalTitle": r.get("title") or it.get("title"),
                    "assignedTo": r.get("assignedTo"), "unassigned": bool(r.get("unassigned")),
                    "assigneeChanged": bool(r.get("assigneeChanged")),
                })
    return rows


def summarize(rows):
    counts = {}
    for r in rows:
        counts[r["outcome"]] = counts.get(r["outcome"], 0) + 1
    judged = counts.get("approved", 0) + counts.get("edited", 0) + counts.get("rejected", 0)
    rate = counts.get("approved", 0) / judged if judged else None
    mapped = [r for r in rows if r["mapped"] and r["outcome"] in ("approved", "edited")]
    return {"counts": counts, "judged": judged, "approvedWithoutEdits": rate,
            "mappedAssigneeKept": sum(not r["assigneeChanged"] for r in mapped),
            "mappedAssigneeOf": len(mapped)}


def _words(text, n):
    seen = []
    for w in sorted(WORD_RE.findall((text or "").lower()), key=len, reverse=True):
        if w not in STOP and w not in seen:
            seen.append(w)
    return seen[:n]


def case_of(site, m, segments):
    """A corpus case (run_eval's shape) from one reviewed meeting: what the
    operator approved is `expect` (kind + the final title's two longest words,
    and the speaker when the operator kept the mapped assignee); what they
    rejected seeds `forbid` with words no approved title carries. None when
    nothing in it was reviewed."""
    items = [it for it in m.get("items") or [] if outcome(it) in ("approved", "edited", "rejected")]
    if not items or not segments:
        return None
    expect, kept_words = [], set()
    for it in items:
        if outcome(it) == "rejected":
            continue
        r = it.get("review") or {}
        final = r.get("title") or it.get("title") or ""
        words = _words(final, 2)
        kept_words.update(_words(final + " " + (it.get("description") or ""), 99))
        if not words:
            continue
        e = {"kind": it.get("kind"), "words": words, "any": True}
        if it.get("suggestedAssignee") and not r.get("assigneeChanged") and not r.get("unassigned"):
            e["assignee"] = it["suggestedAssignee"]
        expect.append(e)
    forbid = []
    for it in items:
        if outcome(it) == "rejected":
            forbid += [w for w in _words(it.get("title"), 3) if w not in kept_words][:2]
    people = sorted({s.get("speaker") for s in segments if s.get("speaker")}
                    | set(m.get("participants") or []))
    doc = {"runId": "0" * 8, "siteKey": TENANT_TAIL.sub("", site),
           "meetingId": m.get("meetingId"), "title": m.get("title") or "",
           "platform": m.get("platform") or "", "startedAt": m.get("startedAt"),
           "endedAt": m.get("endedAt"), "participants": people, "segments": segments}
    return {"transcript": doc, "repos": [], "expect": expect, "forbid": sorted(set(forbid)),
            "source": "review"}


def _hub_get(hub, path):
    req = urllib.request.Request(hub.rstrip("/") + path, headers={"Accept": "application/json"})
    cookie = os.environ.get("TURMA_HUB_COOKIE")
    if cookie:
        req.add_header("Cookie", f"hub_session={cookie}")
    elif os.environ.get("TURMA_HUB_USER"):
        tok = f"{os.environ['TURMA_HUB_USER']}:{os.environ.get('TURMA_HUB_PASSWORD', '')}"
        req.add_header("Authorization", "Basic " + base64.b64encode(tok.encode()).decode())
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def _proposals(a):
    if a.snapshot:
        with open(a.snapshot) as f:
            return json.load(f).get("meetingProposals") or {}
    return _hub_get(a.hub, "/api/agents").get("meetingProposals") or {}


def cmd_report(a):
    rows = outcomes(_proposals(a))
    if a.out:
        with open(a.out, "w") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    s = summarize(rows)
    print(json.dumps(s["counts"], sort_keys=True))
    rate = s["approvedWithoutEdits"]
    print(f"approved without edits: {'n/a' if rate is None else f'{rate:.0%}'} of {s['judged']} reviewed")
    print(f"mapped assignee kept: {s['mappedAssigneeKept']} of {s['mappedAssigneeOf']} approved with one")


def cmd_cases(a):
    if not a.hub:
        sys.exit("cases needs --hub: the transcripts are read from it")
    os.makedirs(a.out, exist_ok=True)
    n = 0
    for site, meetings in _proposals(a).items():
        for m in meetings or []:
            if m.get("status") != "ok" or not any(outcome(i) in ("approved", "edited", "rejected")
                                                   for i in m.get("items") or []):
                continue
            path = (f"/api/orgs/{urllib.parse.quote(site, safe='')}/meetings/"
                    f"{urllib.parse.quote(m['meetingId'], safe='')}/transcript")
            try:
                segs = _hub_get(a.hub, path).get("segments") or []
            except Exception as e:
                print(f"skip {m.get('meetingId')}: {e}", file=sys.stderr)
                continue
            case = case_of(site, m, segs)
            if not case:
                continue
            name = re.sub(r"[^A-Za-z0-9._-]+", "-", f"review-{m['meetingId']}")[:100]
            with open(os.path.join(a.out, name + ".json"), "w") as f:
                json.dump(case, f, indent=1, ensure_ascii=False)
            n += 1
    print(f"wrote {n} case(s) to {a.out}")


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, fn in (("report", cmd_report), ("cases", cmd_cases)):
        s = sub.add_parser(name)
        src = s.add_mutually_exclusive_group(required=True)
        src.add_argument("--hub", help="the hub's base URL")
        src.add_argument("--snapshot", help="a saved /api/agents JSON (report only)")
        s.add_argument("--out", default=os.path.join(HERE, "reviewed") if name == "cases" else None,
                       help="cases: the directory; report: an outcomes JSONL")
        s.set_defaults(fn=fn)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
