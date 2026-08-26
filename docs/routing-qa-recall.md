# QA recall experiment — can a cheap tier run QA?

XERK-445 follow-up. Answer key: the 5 defects the frontier-model QA agent found
in `bench/archive/scrub.py` and `curate.py` at commit `9c89288`, reviewed again
by three tiers with an identical prompt, identical tree, 1500s cap.

| reviewer | recall | HIGH | cost | notes |
|---|---|---|---|---|
| opus-4-6 | **5/5** | 1/1 | 1.00x | 10 findings |
| sonnet-4-5 | **4/5** | 1/1 | 0.60x | found the revert defect, missed the false-positive class |
| haiku-4-5 | **4/5** | 1/1 | **0.20x** | found the false-positive class, missed the revert defect |
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

### The compaction experiment, run

The hypothesis was that compaction is the blocker: fix it and Nemotron becomes a
contender. It was tested directly -- same task, same tree, a 90k window chosen
to force compaction, varying only the model Claude Code uses for compaction and
other small/fast work.

| arm | compactions | recall |
|---|---|---|
| Nemotron compacting itself | 2 | **3/5** |
| haiku-4-5 compacting for it | 1 | **3/5** |

**Identical -- same three findings, same two misses.** Swapping the compactor
changed nothing measurable. Both arms survived compaction and kept the task.

That also retires the "empty summary" failure as a deterministic bug: here
self-compaction worked twice in one session. It was variance, not a capability
floor.

### So compaction was never the blocker -- variance is

Five local runs of the same review:

| run | recall |
|---|---|
| unguided, self-compaction | 0/5 (looped, thrashed, died) |
| guided, self-compaction | 4/5 |
| no compaction fired | 2/5 |
| forced compaction, self | 3/5 |
| forced compaction, haiku | 3/5 |

**mean 2.4/5, range 0-4.** haiku scored 4/5 and opus 5/5, each stable and
on-task in a single run. Both compaction arms missed the same two findings --
the specific redaction gaps and the deleted-file revert defect -- which haiku
and opus caught.

The honest conclusion: Nemotron's ceiling is real (4/5 at its best, and it did
find the ReDoS in one run) but its *expected* value is about half of haiku's,
and a QA gate is bought on the expected value, not the ceiling. **Fixing
compaction does not move it.**

### Recall per dollar

| model | recall | rel. cost | recall per unit cost |
|---|---|---|---|
| opus-4-6 | 5/5 | 1.00x | 5.0 |
| sonnet-4-5 | 4/5 | 0.60x | 6.7 |
| haiku-4-5 | 4/5 | **0.20x** | **20.0** |

haiku is **4x more efficient than opus and 3x more than sonnet** at finding
these defects.

Sonnet and haiku each scored 4/5 but found *different* fours — sonnet caught the
curate.py revert defect, haiku caught the damages-clean-text class. Their union
is 5/5, i.e. opus-level, at 0.80x. That is barely cheaper than simply running
opus, so **stacking two cheap tiers is not worth the complexity**; run haiku
alone and escalate.

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
