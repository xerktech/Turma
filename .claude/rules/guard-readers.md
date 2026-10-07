---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: what a reader binds (XERK-1622, XERK-1650, XERK-1658)

- A `read`/`mapfile`/`readarray`/`select` name is bound by `_reader_values` to every text that may
  reach its stdin; over-reading is the policy, since a missed feed lets `$a` run unseen.
- Splitting: under a literal `IFS=` on the line, or a reader's `-d` (`''` = NUL), every name
  ALSO gets the text's pieces, ONE value with a piece per line (which piece lands where is not
  modelled), plus every piece to every name while the bindings stay under `_MAX_SPLIT_PAIRS`
  (64) — field→name is bash's split, which modelling got wrong (`rm -rf "$b"` ran); past the
  budget only the joined value, as a 17+-field split already gets (QA passes 12-15) (`rm -rf "$d"`). A value per piece for a
  long text went "too large". IFS blanks beside another separator cut no piece
  (`IFS=', '` gives the last name `rm -rf /` whole); alone (`IFS=$'\t'`) they do.
- An IFS/`-d` value an expansion spells (`IFS=$i`, `-d "$d"`) splits on all punctuation but
  `/._~-`: those cut the very path or option a piece would hold.
- Feeds `_reader_feeds` adds beyond here-strings, `< <(…)` and piped echoes:
  - `yes WORDS`, `/bin/echo`, `'echo'`, and a producer an expansion spells (`$(echo echo) WORDS`)
    read as `echo WORDS`.
  - A bare `$a` with no words (a group closer `)`/`}` is none) is NO producer: read as `echo` it bound a reader to "" and that
    empty value hid main's own deny of `exec 3<<E … read -u 3 a; $a` (XERK-1658 QA).
  - A "blind" reader (`-u FD`, `< file`, `0< file`, in a group `done < f`, after `exec < f`) gets
    every echo on the line, output redirections cut.
- Heredocs are cut before `_var_values` runs, so their bodies never reach `_reader_values`.
  `_reader_extra_readings` adds a reading where a heredoc reaching a reader (on the reader's own
  command, or a group closer: `done <<E`, `<<E read a`) is rewritten as `<<< $'<body>'` (k-th
  delimiter of an owner = k-th body), plus one keeping only an owner's last (`read a <<A <<B`).
  - A heredoc on ANOTHER command never feeds every reader: real scripts' distinct bodies bound
    readers of pipes and spent the budget ("too large", XERK-1658 QA).
  - A heredoc written to a file a reader reads (`cat > f <<E`/`tee f`/`dd of=f` and `< f`,
    matched by FILE NAME via `_path_key`, as `cd`/`~`/`$S/` respell one file; "?" = a name an
    expansion or glob spells, matching any) or to an fd
    (`exec 3<<E` and `-u`/`<&`) is printed beside as an unpiped `echo`, its `<<E` cut (or the
    re-read takes the rest of the line as its body); only blind readers take an unpiped echo.
    Unmatched, 16 files written beside a reader of one spent the budget (QA pass 3).
  - Every bound body is ONE printed text of their lines: a value per body spent the budget on
    8 config files written beside a reader (QA pass 5).
  - A heredoc reaches a reader when the reader's segment, a command-position reader word
    (`_READER_WORD_RE`: `x=$(read`, `time`/`!`/`\read`, `IFS=';' read`) or a group closer sits in
    the command holding the `<<` (`_heredoc_command`: its `;`/`&&`/`||` piece, cut only at
    UNQUOTED operators, or `read -d ';'` lost its heredoc; the word unquoted too). Its body
    binds AS WRITTEN (`$'…'`), so `eval "$a"` of `echo "$(rm …)"` is seen.
  - `_reader_extra_readings` skips its segment scan when there is no heredoc (only the `mapfile -C`
    callbacks run then): a 30 KB non-heredoc line paid `_HEREDOC_OP_RE.sub` over it (QA pass 16).
  - `_READER_WORD_RE`'s assignment-value alternation is ReDoS-prone: each unit's first char must
    be distinct and the catch-all must exclude `` ` ``/`$`/`(`/`)`, or `X=`x` `×20 before a heredoc
    backtracks and hangs the guard OPEN past the hook timeout. Stress any new value form (QA pass 16).
  - Its prefix-assignment run is bounded (`{0,8}`) and gated on a `read`/`mapfile`/`readarray`
    substring, so a long `a=`x` `run before a reader is O(n), not a quadratic finditer (QA pass 17).
    The shared `_expand` cost on such a run is pre-existing (same on main), not this change.
    Its value's unit count is bounded too (`{0,64}`), or a bare `` `x` ``-run as one value was a
    new quadratic finditer (QA pass 18). The remaining per-reading cost is interruptible Python the
    30s deadline catches (fail-closed deny), not an uninterruptible C regex call.
  - Never a word-anywhere fallback: "read" in a PR/issue title bound markdown bodies (seconds,
    "too large", data denied), and binding them inert hid real commands (QA passes 7-12).
    A reader after a `$'\''` or `$((1<<2))` the splitter misreads is XERK-1733.
  - Each `<<E` is replaced where the LEXER found it (`_split_heredocs(trace=)`): searching the text
    for an owner line hit a quoted/commented copy, a `$((1<<2))` shift or identical lines (QA).
  - Every OTHER owner's `<<E` is cut in those readings: kept, it swallowed the rest of the reading
    (the echoes included) as its body, and one unrelated heredoc turned the feed off (QA pass 4).
- `mapfile -C f` calls `f INDEX LINE` per line: added as calls written AFTER the line, so the
  positional binding (`guard-positionals.md`) binds `f`'s `$2`.
- Both are ADDED readings re-expanded whole; each stops because the rewritten line holds no reader
  heredoc and the call suffix is checked for. Don't drop either: they are the recursion's floor.
- `select v; do` with no `in` lists `"$@"`, as `for v;` does (`_IMPLICIT_FOR_RE`).
- Tests: `test_a_value_a_split_heredoc_or_callback_reader_takes_runs`,
  `test_a_value_a_grouped_or_looped_reader_takes_from_stdin_runs`.
