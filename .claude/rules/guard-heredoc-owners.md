---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: which heredoc owners count as shells (XERK-1618)

- A heredoc body is expanded as a SCRIPT when its owner may be a shell; otherwise it is data.
  `_heredoc_owner_feeds_shell` decides; the line's first word alone missed `bash<<EOF`,
  `(bash <<EOF`, `{ bash; } <<EOF`, `x=$(bash <<EOF`, `fi <<EOF`.
- **A closer on the heredoc's line is decided by a BROAD rule on purpose**: any `)`/`}` or
  `fi`/`done`/`esac` on the owner line → the body is a script if ANY shell word is named anywhere on
  the command (`_SHELL_WORD_RE`, over raw text AND quote/escape/line-continuation-joined text), or
  any stage reads stdin.
  - Do not replace it with a parser of the group. Ten QA passes broke each one: stripping the
    redirects between closer and `<<` (quoted targets, `>|`, `{fd}>`, and it went quadratic — 973s,
    past the hook timeout, which RUNS the command), first/last-closer cuts (a quoted `)` on each
    side), a quote/nesting-aware scanner (literal `{`, `\$'`, backtick in `"…"`, case `)`).
  - Cost, measured: 0 new false denies over a 36k-command real corpus replay vs main. A false deny
    needs a closer, a shell word AND a destructive body on one command.
- `_ungrouped` yields two readings (end-trimmed, cut at first `)`/`}`); either finding a shell
  counts. Each alone lost a shape the other reads (`X=$(pwd) bash` vs `(bash)<<EOF`).
- `_split_segments` cuts `2>&1` at `&` and `>|f` at `|`; the owner text is normalised before it is
  split for the program check.
- Every scan here must stay linear: one `_SHELL_WORD_RE` pass, the whole-command reader scan is
  memoised per `_expand` call (per owner it was O(heredocs × segments)). Tests:
  `TestExpansionBudget.test_redirect_runs_on_a_heredoc_line_stay_linear`.
- **A program name is asked of every way bash may form it** (`_name_readings`, XERK-1629): the
  text as written, and with every `$(…)`/backtick, `$@`, `$*`, `$''`, `$""` dropped, ANSI-C
  decoded and braces expanded (`bas``h`, `bas$(:)h`, `$'bas\150'`, `{bas,-s}h` = `bash -sh`).
  - Read at `_command_reads_stdin` (every pipe/heredoc reader) and over the whole owner in
    `_heredoc_owner_feeds_shell` and the closer scan — BEFORE `_ungrouped`, which strips a
    leading `{` and cut `{bas,-s}h` to `bas,-s`.
  - Dropping a substitution that prints text over-reads; it only ever adds a shell reading.
- Not covered (open tickets): names via variable/glob/function/alias (XERK-1624), data later
  run as code (XERK-1555).
- Tests: `TestScriptChannels.test_a_heredoc_owner_shell_behind_a_glue_subshell_or_group`,
  `test_a_shell_name_formed_by_an_empty_expansion_or_a_brace`.
