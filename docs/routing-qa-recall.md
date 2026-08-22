# QA recall experiment — can a cheap tier run QA?

XERK-445 follow-up. Answer key: the 5 defects the frontier-model QA agent found
in `bench/archive/scrub.py` and `curate.py` at commit `9c89288`, reviewed again
by three tiers with an identical prompt, identical tree, 1500s cap.

| reviewer | recall | HIGH | cost | notes |
|---|---|---|---|---|
| opus-4-6 | **5/5** | 1/1 | baseline | 10 findings reported |
| haiku-4-5 | **4/5** | 1/1 | **~1/5** | 10 findings; missed only the curate.py revert defect |
| nemotron 3.5 Lightning (local) | **0/5** | 0/1 | $0 | never completed |
| nemotron, with explicit tool discipline | **~2/5** | 0/1 | $0 | lost the prompt to compaction |

## The result

**haiku-4-5 recovers 80% of frontier recall at about a fifth of the cost**, and
caught the one HIGH-severity finding. For QA that is a good trade, because a QA
FAIL carries a reproduction and is therefore checkable — you do not have to
trust the cheap tier's precision, only its recall.

**The local 30B model is not a viable QA reviewer at this size.** Two distinct
failures, neither about analysis:

- **Unguided it does not converge.** It looped — seven repeated `cat`s of the
  same two files plus a subagent spawn — until autocompaction thrashed and the
  session died. 258 bytes of output, no findings.
- **Compaction is broken for it.** With reasoning off, compaction returns an
  *empty summary* and the session dies immediately. With reasoning on it
  compacts but thrashes. Given explicit tool discipline it finished, but had
  lost the original prompt to compaction and reviewed five claims it invented,
  recovering roughly two of the five real defects.

QA sessions average 84 turns, so compaction is not an edge case for this
workload — it is the common path.

## Methodology note

Keyword scoring **over-credited** the local model 5/5. Spot-checking the text
showed it matching lines that merely *describe* a rule ("Rule 28: Private key
BEGIN/END blocks") rather than identify a defect. The cloud scores held up under
the same check; the local one did not. Scoring QA output by keyword is not
reliable on its own — every score here was read back before it was believed.

The key was also widened once, in the models' favour: D9 is the defect class
"redacts text containing no secret", and both cloud reviewers found it via the
JWT and email rules instead of the `process.env` example the original agent
used. Scoring only the original example would have under-credited them.

## What this changes

- **Route QA to haiku-4-5, not to the local tier.** ~80% recall at ~20% cost.
- **Do not route QA to a 30B local model** until compaction works. The blocker
  is agentic control and summarisation, not the model's ability to read code.
- The asymmetry still holds and is what makes the cheap tier acceptable: a FAIL
  with a repro is self-verifying; a PASS is not. Escalate PASSes on risky
  surfaces, act on FAILs directly.
