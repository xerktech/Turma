# QA recall experiment — can a cheap tier run QA?

XERK-445 follow-up. Answer key: the 5 defects the frontier-model QA agent found
in `bench/archive/scrub.py` and `curate.py` at commit `9c89288`, reviewed again
by three tiers with an identical prompt, identical tree, 1500s cap.

| reviewer | recall | HIGH | cost | notes |
|---|---|---|---|---|
| opus-4-6 | **5/5** | 1/1 | baseline | 10 findings |
| haiku-4-5 | **4/5** | 1/1 | **~1/5** | 10 findings; missed the curate.py revert defect |
| nemotron, unguided | **0/5** | 0/1 | $0 | looped, thrashed, died at 258 bytes |
| nemotron, tool-disciplined | **4/5** | 1/1 | $0 | compaction fired; recovered anyway |
| nemotron, no compaction (hybrid) | **2/5** | 1/1 | $0 | stayed under the threshold |

## The result

**haiku-4-5 recovers 80% of frontier recall at about a fifth of the cost**, and
caught the one HIGH-severity finding. For QA that is a good trade, because a QA
FAIL carries a reproduction and is therefore checkable -- you do not have to
trust the cheap tier's precision, only its recall.

**Nemotron is a real contender on analysis and an unreliable one in practice.**
Given explicit tool discipline it scored 4/5 -- level with haiku, at zero
marginal cost. The failures are not about reading code:

- **Unguided it does not converge.** It looped -- seven repeated `cat`s of the
  same two files plus a subagent spawn -- until autocompaction thrashed and the
  session died with no findings.
- **Its own compaction is broken.** With reasoning off, compaction returns an
  *empty summary* and the session dies immediately; with reasoning on it
  compacts but thrashes. QA sessions average 84 turns, so compaction is the
  common path for this workload.
- **Run-to-run variance is the real blocker.** Three local runs of the same
  review scored 0/5, 4/5 and 2/5. opus and haiku were stable. A reviewer you
  cannot predict is hard to put in a gate.
- **It never found the ReDoS in any run.** That is the one finding requiring
  reasoning about how a regex *executes* rather than what it matches, and both
  cloud tiers got it. Suggestive, not proven, on n=3.

So fixing compaction is **necessary but not sufficient**. The hybrid experiment
(local main model, cheap cloud model for compaction and small/fast work) is the
right architecture and is wired and working -- both tiers behind one endpoint --
but it did not settle the question, because compaction never fired in that run.
**That is the experiment still to do.**

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
