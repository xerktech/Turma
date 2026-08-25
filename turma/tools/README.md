# `turma/tools/`

One-off operator tools. Nothing here is on the hub's serving path; each is run by
hand inside the hub container, against `/data`.

## `recover-usage-from-archive.js`

Rebuilds a wiped host's missing usage history from the hub's own session archive,
as **estimated** per-day buckets, and merges them into `usage-ledger.json`.

**WARNING — what it writes is an estimate, and the ledger cannot say so.** The
usage ledger is documented as holding facts: "what a host spent on a given UTC day
is a FACT, and the agent's report of it can only under-state". This tool
deliberately breaks that, because for a host whose disk was wiped before the
ledger ever saw it the alternative is a permanent zero. Nothing in the ledger's
format marks a bucket as estimated, and nothing downstream distinguishes one, so
**every run must be recorded** — in the PR that ran it and in the bullet in
`.claude/rules/turma-usage.md` — or the next reader has no way to know.

### Why estimation is the only option after a wipe

- The archive's **rendered** layer is a projection: `{uuid, role, ts, text}`, no
  token counts.
- The archive's **raw** layer does carry the transcripts' own usage blocks, but it
  only ever held what was still on the host's disk when the sync ran. After a wipe
  that is nothing older than the wipe, so it re-derives the days the ledger already
  has and nothing else. Verified on MaxAI's 148 raw copies: **2026-08-16 → 08-21
  come back identical to the ledger, all four figures**, and 08-22 → 08-25 come
  back LOWER because those days still have live sessions the archive has not taken
  yet. That agreement is what says the parser is faithful; the absence of any
  earlier day is what says the raw layer cannot cross a wipe.
- The ledger's per-day high-water rule preserves only days it was **told** about
  before the wipe.

### How the estimate is made

Calibrate tokens-per-rendered-character on sessions holding **both** layers —
exact tokens from raw, characters from the projection beside it — then apply that
rate to the rendered-only sessions from before the wipe, bucketed by each entry's
own UTC day. Merged into the ledger with the same max rule the hub uses, so an
estimate can never lower a measured day.

### Accuracy, as measured

- **In bulk: ±20%.** Half-split over ~250 calibration sessions gave a median
  pred/truth of 1.00, p10 0.85, p90 1.17.
- **Per day: ±2–6x.** A single day is not a usable number; a month is.
- **Calibrating recent, predicting old, over-states.** On truenas (raw coverage
  spanning both periods) predicting July from late-August rates came out 1.15–1.46x
  high. `--drift` scales the rate for it; it defaults to 0.8, deliberately biased
  low, because a max-rule day bucket that is too high can never be corrected
  downwards by a later report while one that is too low can.
- **Not reconstructed:** the per-model breakdown and the sub-agent split. Both are
  stored as totals with no day buckets, so there is no anchor to apportion against
  and doing it anyway would be fabrication.
- **A figure above `TOKEN_MAX` (2^53-1) counts as zero**, as `_token_count` does.
  Not for tidiness: the ledger's `num()` refuses a non-safe integer, so one absurd
  value in a CALIBRATION transcript poisons the rate, is written out as `1e+308`,
  and loads back as a zeroed day — taking the measured figures in that bucket with
  it. The tool reads archived bytes from every host in the fleet.

### Running it

Dry run (the default) prints the estimate and writes nothing:

```sh
kubectl -n ai exec -i <turma-pod> -- sh -c 'cat > /tmp/recover.js && node /tmp/recover.js \
  --host maxai --ledger-host MaxAI --before 2026-08-16' < turma/tools/recover-usage-from-archive.js
```

- `--host` matches the archive's `.meta` **`host`** field, case-insensitively —
  the session's OWNER. The host segment in an archived file's NAME is the host it
  was first archived under, which a migrated session keeps, so the name is the
  wrong thing to read.
- `--ledger-host` is the key in `usage-ledger.json` (the device name) when it
  differs in case or spelling from the archive's.
- `--before` is the first day the ledger's own record is trusted; days at or after
  it are left exactly as the hub recorded them.

`--drift` is capped and `--before` must be a real date, not merely a date-shaped
string: the day comparison is lexicographic, so a typo'd `2026-13-45` would put
every measured day back in scope for an estimate.

Add `--write` to merge. It backs the ledger up beside itself first, and **the hub
must be restarted afterwards** — it holds the ledger in memory and rewrites the
whole file on its next save, which would otherwise throw the merge away. For the
same reason, anything the hub saves BETWEEN the tool's read and that restart is
discarded — keep the gap short, and treat the backup as the way back.
