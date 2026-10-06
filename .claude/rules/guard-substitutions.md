---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: finding command substitutions (XERK-1605)

- **Substitutions are found by a balanced scan, not `_SUBST_RE`** (`_find_substs`): the regex
  cannot nest, so nested backticks paired wrongly and `\$( (echo …) )` matched nothing.
  - Backticks pair by EQUAL backslash-run length, so nesting reads right at any re-parse depth;
    a backtick body loses one escape level, as in bash.
  - `$((…))` arithmetic is skipped but scanned INTO: skipping it whole stopped inner `$(…)`
    resolving early and pushed a real `kubectl exec … sh -c` one-liner into `_TOO_DEEP`.
  - Every parser of substitution text must use it — `_sub_substs`, `_produced_text`,
    `_reads_stdin_script`, the `<(` feed — and `_ASSIGN_SUBST`'s backtick must skip `\``.
    Converting `_sub_substs` alone made `x=\`echo \\\`echo …\\\`\`; $x` a NEW bypass.
  - `_subst_text` resolves a body's own substitutions (memoised `_body_printed`), and `_expand`
    never expands one body twice at the same cwds: without both, deep nesting went 2^depth.
  - Still on `_SUBST_RE` (blanking only): the heredoc owner and the DB scan.
- **A new reading of what a substitution prints is ADDED, never swapped in** (XERK-1609).
  - Splicing a multi-statement body's output where main read it as opaque lost main's denies
    (`eval "$(true; echo '${x#a}')rm …"`): `_expand` keeps the `multi=False` readings too.
  - Printed text has two readings that disagree: the literal WORD bash splices in (a printed
    `"` closes nothing) and the text a re-parsing shell runs (`bash -c "$(…)"` strips quotes).
    Neither alone is safe; escaping in place opened `bash -c "$(echo "''rm …")"`.
  - Segmenting cuts `$(a; b)` in half, so `_expand` re-splits the line with each such body
    replaced by its output. Re-expanding the whole line per level instead made nesting ~10x
    slower toward the hook's timeout, which fails OPEN.
- **A `<(…)` is a file its stage reads** (XERK-1611): every `<(…)` in a pipeline feeds its readers
  whatever the program — `cat <(echo …) | bash` runs it. `_proc_subst_texts` over-reads its body.
  - Found off the WHOLE line, fed to every reader: the splits are not paren-aware and cut
    `<(echo … | cat)` and `<(echo …; true)`; `_reads_stdin_script` reads a cut-off `<(` as a path.
- **A shell `-c` script holding `<(` is re-read with every `<(…)` left raw** — the substituted
  segment had turned `. <(echo …)` into `. <cmd>`. It sits BEFORE the operator-split `continue`,
  which otherwise skips any shell branch whose `-c` script holds `;`, `&&` or `|`.
- **A shell `-c` script holding `$(`/backtick is ALSO re-read with every substitution left raw**
  (XERK-1622): the inner shell runs it, so `bash -c 'a=$(echo rm …); $a'` assigns the output whole;
  the outer splice made it `a=rm …; $a`, where `$a` is just `rm`. Added, never swapped.
- **Values bound outside `NAME=` reach `$name` too** (XERK-1622, `_assigned_values`): a `for` list
  is read in whole dequoted words (`"$(echo rm …)"` is one), and `read NAMES <<< WORD` binds them
  as bash splits it — a word each, the last the remainder (`_reader_values`); every name gets
  the whole text when the line sets IFS, and `-a`'s array always does. A `${x:-…}` word is read
  with its default applied too, as an assignment's is.
  - A name can be glued to the `<<<` (`read a<<<"…"`): shlex keeps it in the redirection token.
- **A reader with no here-string of its own takes the stdin feeds that reach it** (XERK-1650,
  `_reader_feeds`): a here-string or `< <(…)` on a group it is in, and an `echo`/`printf`
  (or a group of them) piped into it or into one of its groups.
  - A feed on any OTHER command (`cat <<< … |`, `f <<< …` calling a reader function,
    `exec < <(…)`, an echo piped into `cat`) feeds EVERY reader: its path can't be traced.
  - Paired, never every feed to every reader: N `echo … | while read` loops read each name N
    ways, N² readings, and a benign script was refused as too large.
  - A multi-line text is one more value with its lines kept (each line a read), never a value
    per line: N reads of an N-line here-string was N² readings again.
  - `mapfile`/`readarray` bind an array (MAPFILE by default); `select` binds REPLY, its list as
    `for` does. A reader's own `<(…)` words are cut before its names are read.
  - Residuals: IFS/`-d` delimiters, `bash -c 'read …'`, `mapfile -C`, coproc, files, `yes`, and `read a <<E` (values are read with
    heredoc bodies already cut) (XERK-1658)..
- **A `${…}` nested in another resolves innermost first** (XERK-1653, `_substitute_vars`'s `sub`):
  `_VAR_USE_RE` stops at the inner `}`, so `${x:-${y:-$(echo rm …)}}` was left raw and ran unseen.
  - The inner ones splice over the WHOLE line's positions (quote states, `_brace_end` memo), never
    a re-substitution pass over the output: that would re-expand `$` a spliced value carries.
  - Only when `_brace_end` closes past the match AND a `${` sits inside; a `}` merely quoted
    (`${a:-'}' #}`) stays raw as one word (XERK-1585). Past `_MAX_NESTED_VARS` → too large.
  - 0 decision changes over a 20.5k-command replay (636 holding `${`).
- `_expand_braces` ends a brace word with `_word_end`, so a glued `$(…)` stays whole:
  `{,}$(echo rm …)` was cut at its `(` into `$ $`.
- **`_shell_c_script` is how to read a `-c` script**: bash drops a `--` after `-c`.
- **`_ANSI_C_RE` checks the backslash run's PARITY**: an odd run (`"\$'…'"`) is literal here and
  ANSI-C only to a `-c` re-parse; an even run (`\\$'…'`) is still live. A bare lookbehind bypassed.
- **The stdin-feed walk splits with `groups=True`** (XERK-1614): a cut inside `{ echo …; }` or
  `X=<(a; b)` severed producer from reader. Only that walk: every other caller keeps the old
  split and relies on `_expand`'s group pass to read bodies.
  - `|&` is one pipe, in every split; `2>&1` is XERK-1616's `keep_redirects`, which the walk also passes.
  - No group opens inside `${…}` (`${x#(}` is pattern text), and a group still open at the end
    re-splits without `groups`: an unclosed "group" swallowed every later pipe (a QA regression).
  - Producers are flattened by `_simple_commands` (recursive, groups on): a single plain split
    cut a deep `{ { …; }; }` apart. A `{` right after an opener counts at any depth.
  - The walk reads pipelines from BOTH splits plus each whole-group pipeline's interior
    (`_walked_pipelines`): a group kept whole but not opened (`do (a; echo …) | sh`) hid what
    the plain split had cut out — a QA regression. Never walk the group split alone.
  - `_group_core` opens a group behind keywords (`do`, `then`, `!`, `time`) or before trailing
    redirections (`(…) 2>&1`); `_unwrap_group` opens only a group that IS the segment.
  - Its trailing redirections are read by `_only_redirects`, one greedy pass from the closer. Not a
    regex: searched it went O(n²), and anchored it split `>a1>a1…` every way — exponential.
- **`_reads_stdin_script` recurses** into a group/list and a `-c` script: `bash -c bash` and
  `(cat | bash)` read the stdin they inherit. Past `_MAX_EXPAND_DEPTH` it says "reads" (closed).
  - A part equal to its stage goes to `_command_reads_stdin`, never re-split: the redirect
    re-reading returns `>&1` among `>&1`'s own parts, and looping hit the cap (a false deny).
- **An `exec`'s here-string joins the line-wide `<(…)` texts**, and a line with any of them scans
  every pipeline: `exec 3< <(…); bash <&3` has no pipe. De-duped + capped once, else O(n²).
- **More stdin-to-shell routes the walk now reaches** (XERK-1628), each still a producer→reader pair:
  - A COMPOUND command (`if…fi`, `for/while/until/select…done`, `case…esac`) is kept whole in
    `groups=True` splits (as `( )`/`{ }`), so a pipe to/from it is not cut at its inner `;`
    (`echo … | if true; then bash; fi`, `if …; then echo …; fi | sh`). `_compound_opener` detects
    the head at a command start; `_group_core` opens the body via `_compound_body`, a scanner that
    drops the skeleton keywords and `case` patterns but keeps inner groups and PIPELINES whole
    (a plain split cut the inner group, a group-aware one re-groups the whole compound). `time -p
    { …; }` opens because `-p` is a `_CMD_KEYWORDS` keyword-arg.
  - `_group_core` finds a group's closer by a quote/escape/`$(…)`-aware FORWARD scan (`_group_close`),
    not a reverse search of the last few closers, so a closer quoted (`2>"/tmp/x )))))"`),
    substituted (`2>"…$(echo \")\")…"`) or escaped (`2>/tmp/f\)`) in a trailing redirect target is
    not mistaken for the group's. Substitutions in that target are blanked before `_only_redirects`.
  - `_unwrap_group` strips only a bracket that WRAPS the whole segment (`(a) 2>f\)` and `(a)|(b)` are
    left alone); the verifying scan runs ONLY when a redirect/escape char is present, so a 3000-deep
    `(…)` nest stays O(n) per call, not O(n²) at every recursion level.
  - `eval` reads stdin as a script (`_command_reads_stdin_as`): its joined words run inheriting
    stdin (`… | eval bash`, `eval '{,bash}'`, `eval 'cat | {,bash}'`), and a `$(cat)` in them
    (`_passes_input`) captures that stdin to BE the script (`bash -c 'eval "$(cat)"'`). The `-c`
    script is re-read off the raw stage so its `$(cat)` survives the placeholder pass.
  - `xargs … sh -c` with no script arg runs the piped text as the shell's `-c` script.
  - An output process substitution `cmd > >(reader)` feeds the reader this stage's stdout
    (`>(` joins `feeds_a_shell` and the single-stage-skip exemption).
  - A bare call to a function the line defines runs its body in the walk (`_function_bodies`):
    `f() { bash; }; echo … | f` and `f() { echo …; }; f | sh`.
  - A named/variable fd reader is a stdin-script read (`_STDIN_SCRIPT_RE` matches `/dev/fd/$fd`),
    and a heredoc an `exec` holds on an fd joins the fed texts (`exec 3<<EOF…EOF; bash <&3`).
  - 0 decision changes over a 33.9k-command real-Bash replay; `_compound_body` must keep inner
    pipelines whole (a nested `{…} | sh` regressed when it over-flattened).
- **`cat`/`tac`/`tee`/`head`/`tail` of only `<(…)` operands prints their texts** (`_cat_printed`),
  as does `< <(…)` and bash's `$(< <(…))`; redirects, `-` and `/dev/null` are skipped, a real file
  operand stays opaque. Bounded by `_SUBST_DEPTH`.
  - `_proc_subst_texts` is memoised per decision (`_memo("proc")`) and skips the split for a body
    with no operator or `#`: each `cat <(` level re-split its body, 7.5x main on a deep nest.
- **A filtered or partly-unread body gets a TAINT reading too** (XERK-1613, `_body_tainted`): the
  text its producers emit — echo/printf args, or a here-string — carried through any pass-through or
  rewriting filter (sed/tr/awk/cut/rev…) as if it passed unchanged. ADDED beside the opaque reading,
  never swapped. Operator decision: neither model each filter (partial) nor fail closed (that denies
  `$(command -v tool) args`).
  - A statement whose output is UNKNOWN but non-silent contributes `_UNREAD_OUTPUT`; as the PROGRAM
    word of the output it is refused (`_UNREAD_PROG`) — `$(basename /x/rm; echo -rf /etc)`. A LONE
    unknown statement returns None (that IS `$(command -v tool)`), staying opaque.
  - Output is joined with SPACE, not newline: a command substitution's output is word-split, so a
    trailing unread statement is an argument, never a phantom program (a newline forged a command
    boundary that over-denied arg-position substitutions).
  - `_UNREAD_PROG` fires only in true PROGRAM position (`_taint_in_command_pos`): not in a
    `for … in`/`select` word list, where the output is data. Residual (safe-direction, rollup):
    an array element `arr=($(ls; echo y))` is read as a subshell group, so its unread-leading
    output still over-denies — rare, absent from the 35k-command replay.
  - Left opaque (as on main, documented residuals): a backgrounded/control-flow body
    (`&`, `if`/`while`/`case`), an assignment VALUE where it sits (stored, not run — splicing
    it also made shlex quadratic), a here-string a consuming command reads (`grep -q`/`read`), and a stdout
    redirect (`>/dev/null`, `>&2`). A filter that rewrites harmless text into a dangerous command
    (`rev`, `sed s,/x,,`) still slips: accepted.
  - A body's OWN substitutions resolve to their taint first (`_taint_nested`, XERK-1617); an
    opaque one becomes `_UNREAD_OUTPUT`. Tokenising `echo $(cat <<< '…')` unresolved dropped the
    inner `)` and quotes, so `$(echo $(cat <<< 'rm …'))` ran unread. A nested conditional uses
    its every-statement-ran reading only (residual).
  - A `&&`/`||` body may skip any statement, so its taint is a TUPLE: every suffix of its
    statements (XERK-1617). `_taint_readings` splices each in separately, so the words after
    the substitution follow every suffix (newline-joining them lost those args: a bypass).
    - Past `_MAX_TAINT_STARTS` statements: the all-run reading plus one led by `_UNREAD_OUTPUT`.
    - Accepted over-deny: any `$(lookup || echo fallback)` in program position
      (`$(command -v gsed || echo sed) -i`, `"$(which node || echo node)" app.js`): the unread
      lookup may lead with the fallback's text as args — indistinguishable from
      `ls -d …/rm || echo -rf /`. Two unread branches (`$(command -v a || command -v b)`) allow.
  - A `grep` that prints its lines is a rewriting filter too (`_greps_lines`); one with
    `-q`/`-c`/`-l`/`-L` (or long forms) prints none of the text, so it stays unread. Options are
    PARSED, not pattern-matched: an option's value (`-e -q`, `-elib`) or a word after `--` is a
    pattern, and reading it as `-q` left a line-printing grep opaque.
  - A `$((…))` runs no command, only its substitutions, whose output is an operand. Read as a
    command, a taint reading there was an unread PROGRAM (4 replay false denies,
    `$(( $(stat … || echo 0)/1M ))`), so BOTH taint passes skip it:
    - the bodies loop expands the interior as `: <expr>` (`_arith_interior`);
    - the line/segment passes leave a substitution inside `$((` opaque (`_subst_in_arith`) —
      `N=$(( $(nproc || echo 2) ))` is read in place there. Nothing there tracks quoting, so the
      text from `$((` to the substitution and on to `))` must be plain arithmetic
      (`_ARITH_GAP_RE`): a quoted `$((` decoy (`echo '$((' ; $(…) ; echo '))'`) hid a deny.
    - A printed `a[$(…)]` subscript (bash re-expands it) is still caught by the printed reading.
  - An assignment VALUE's taint reaches its later `$a`/`eval $a` through `_assigned_values`
    (XERK-1625): `_expand_both` adds one pass per suffix reading (`_VALUES_TAINT`, capped at
    `_MAX_TAINT_STARTS`), never joined into the plain values — `_substitute_vars` joins a
    name's values into ONE word list, so a second value would trail the placeholder program.
    - The lookup-or-fallback over-deny above reaches the assigned form too:
      `CC=$(command -v clang || echo gcc); $CC …` denies, as `$(command -v clang || echo gcc) …` does.
  - The line pass rebuilds the whole command in ONE `_sub_substs` sweep per suffix reading, so N statements
    stay linear; the pathological-input envelope is `_statements_printed`'s, unchanged by this.
- **Each substitution gets its own plain reading, its siblings literal** (`_decoy_readings`,
  XERK-1615): one reading for the whole segment let a sibling printing `"` decide it.
  - One reading per substitution, never every combination; past `_MAX_DECOY_SUBSTS` → too deep.
  - Each costs a whole-segment expansion, charged to the growth budget (`_spend`).
- **An expansion that may be EMPTY is also read as empty** (`_unset_readings`, `_param_spans`).
  - Glued to word text (a word char, `\`, another `$`) by a lexer, not a spelling list.
  - As a whole command word of unquoted names, unknown outputs and quoted LIST expansions
    (`$x rm`, `$(true)$(true) rm`, `"${@:2}" rm`). A quoted `"$x"` is a word (bash runs `""`);
    a whole-word ARGUMENT is never dropped, since an empty target reads as the root.
  - A bare name glued to another expansion is braced FIRST, everywhere (`_brace_glued_names`, at
    `_expand`/`_prenormalise` entry, quotes and escapes included): inlining `$x$(echo rm …)`
    read `$xrm`, a longer name that swallowed the command, at any re-parse depth.
  - The brace is an ADDED reading (`_expand` also reads the text unbraced, `_BRACE_GLUED` off):
    `eval "\$x$(echo y) rm …"` runs `$xy rm`; which level a substitution runs at is not in the
    text, and every parity rule tried for it left a shape open.
  - A name the line assigns is spliced first, never read empty. A revealed `format` counts only
    with a drive letter: `$R format --check .` (ruff, black, cargo) is the clash.
  - `_expand_braces` skips `${x,,}`: brace-expanding it read `${x,,}rm` as `$xrm $rm $rm`.
  - A destructive OPERAND (rm/chmod/chown/find roots, and rm's `~/.ssh` check) is also read with
    the unset names ENDING it dropped (`_trailing_unset_dropped`, XERK-1623): `/etc$x`,
    `$HOME$x`, `/$x`, `/etc$x/.`, `/e$x*c`. "Ending" = only `/` and `.` follow, or text holding
    a glob char (judged by the glob check).
    Only in `_is_dangerous_path`/`_is_home_ssh`, never segment-wide. Kept: a leading or
    whole-word name, one before more text (`./"$name".git` is a path built from it, a deliberate
    allow), and a name in a tilde prefix (`~$USER`: bash leaves it literal). `${x:-w}` defaults
    are spliced upstream, so a default that is itself unset (`${x:-${y}}`) drops too.
    Accepted over-deny: `rm -rf /$sub` with sub unset by this line; a literal `'/etc$x'`
    (tokens arrive dequoted).
  - Both passes must stay LINEAR (`test_empty_expansion_readings_stay_linear`): rebuilding the
    text per removal, or tokenising every word's prefix, ran 30 KB toward the hook timeout.
  - Past `_MAX_EMPTY_PROGRAM_WORDS` with a word dropped → too deep: a partial reading was re-read
    64 words at a time at every depth, unbudgeted, past the hook timeout.
  - `_script_readings` unescapes every `\$` before a parameter: shlex keeps it in `"…"`, bash
    drops it, so `eval "\$x rm …"` reached the re-parse with a literal `$x`. Every text fed to
    a stdin shell (here-string, producer) gets it too; a shell-fed UNQUOTED heredoc gets bash's
    own heredoc unescape (`_heredoc_readings`: `\` before `\`, `$`, backtick, newline).
- **A `\<newline>` is dropped before shlex sees it** (`_join_continuations`, in the tokenizer and
  `_var_values`), outside single quotes, as bash does. shlex glued the newline to the NEXT word,
  so `time \<newline>rm -rf /etc` read as program `\nrm`.
  - It reads `_quote_states`, which restarts quoting inside `$(…)` AND a backtick body: an own
    scan, or a missed backtick, took `# don't` / `"\`echo "it's"\`"` as an open quote.
  - A backtick body ends at the next UNESCAPED backtick, as in bash, whatever `'` or `#` it holds;
    its states are computed locally. An open frame let `\`echo # it's\`` swallow its closer.
- **A `${…}` inside `"…"` is a quoting frame of its own** (XERK-1621, `_quote_states`'s `{"`):
  a `"` there nests a string, never closes the outer one. Read flat, `"${y:-"it's"}"; rm …` left
  the `'` open and hid the `rm`.
  - The operator splitter jumps such a `${…}` whole via `_brace_end(…, quoted=True)`; a spliced
    default there drops its own `"` delimiters (`_dq_default`), or `""it's""` reopens the quote.
  - A `'` directly in that frame is SHELL-DEPENDENT: bash pairs it (its text still expands),
    zsh and dash read it as a plain character. Sessions run either, so a line holding one is
    read both ways (`_BRACE_OTHER_SHELL`, an added reading in `_expand_both`); `_closers` and
    `_memo` key on it.
- **`_find_substs` pairs a `)` only with a `(` quoted the same way** (`_quote_states`): blind,
  the `)` in `"$(echo ")'")"` ended the body and its `'` hid the line. The splitter also jumps
  a `$(…)` inside `"…"` whole. An escaped `\$(` in a string is string text end to end, so it
  still pairs as before.
- **A bad substitution (`${` naming no parameter) prints nothing**: `_printed_text` and
  `_stmt_printed` read such a body as unknown, so the empty-glue reading still runs `rm`.
  - Shells PARSE one differently (`_bad_brace`): bash nests quotes in it; dash skips its name
    and ONE operator character, quote or not, then reads on as usual (`_dash_bad_body`:
    `${''}'}` closes at the second `}`). The other-shell reading (`_BRACE_OTHER_SHELL`, with
    zsh/dash's literal `'`) applies that in `_quote_states`, `_brace_end` and the splitter.
- **The pre-XERK-1621 flat parse is kept as a reading** (`_MAIN_PARSE`): no `${…}` frames, parens
  paired blind. Taken when the parsers can differ (`_MAIN_PARSE_SEEN`: a quote in a `${…}`, a
  paren skipped as quoted, a quoted `$(…)` jumped, a bad `${`). Every new rule models some
  shell, and fuzzing kept finding a malformed line one shell recovers from that the new parse
  allowed and the old one denied; ADDED, the old denies survive. Accepted cost: ~2x on such lines.
  - Every memo a reading feeds keys on it: `_memo`, `_closers`, and `_reading()` for
    `_body_printed`/`_body_tainted_at`. A body memoised under one reading was replayed in another.
  - Those lru caches are cleared when a decision's budget opens: a hit skips the SEEN side effects,
    so a body cached by an earlier in-process decision never asked for this one's readings.
- **A pipe-to-shell producer is also read with an unknown glued output as empty**
  (`glued_empty`): `$(true)echo rm … | sh` runs `echo`.
- **An assigned value's `${y:-…}` default is applied at assignment, as an ADDED value**
  (`_assigned_values`; `y` may be set after all). It resolves OTHER names (`z=$y` chains) but
  never a value of its own name: there `x=; x=${x-a}"rm …"; $x` (x set-empty) read as `arm …` in
  every reading. Gating on "the line assigns the name" instead lost `x=${x:-"rm …"}`; keeping it
  out of every resolution lost `y=${x:-"rm …"}; z=$y; $z`. It counts for the per-value readings,
  not toward the assignment cap; those readings have their own cap (`_MAX_VALUE_PASSES`), since
  16 names × 16 `x=${D:-…}` ran 30s at 2× readings.
  - Past either cap `_budget["capped"]` is set, and `decide` refuses it as a POLICY deny like a
    spent budget: before the grant AND after the policy checks, since a grantable reason found
    first (a DB drop, a fork bomb) returns before the cap is met. Granted, the policy checks ran
    without the per-value readings: `x=ls; <17 x=…>; x="gh pr merge 1"; $x` passed `x=ls *`. `_assign_value_end` extends a value whose
  `${…}` closes past the regex's flat quote pairing (`x="${y:-"rm …"}"`).
- **A name assigned more than once is also read with each value on its own** (`_picked`,
  XERK-1621): joined, `x=a; x="rm …"; $x` ran the program `a`. Added readings, never swapped.
  - One whole-line reading per value; more than `_MAX_VALUE_READINGS` assignments to one name
    deny as too large. `for` list words are not counted (data, and lists run long).
- **A decision has a wall-clock deadline** (`_MAX_DECIDE_SECONDS`, checked in `_expand`): out of
  time it denies as too large. The growth budget counts characters, not time; readings re-expanded
  per eval level ran 98 KB toward the hook timeout, which RUNS the command.
- **main() has a hard deadline too** (`_HOOK_DEADLINE_SECONDS`, XERK-1619): `decide` runs on a
  daemon thread; past it the hook prints a deny and `os._exit`s. The in-decide check never runs
  inside one frame — shlex on one 300 KB word took 126-181s, quadratic in its length. The hook
  timeout is Claude Code's 600s default (`build_guard_settings` sets none).
  - Tests must never reach the real `os._exit`: it ends the run with rc 0, a truncated green
    suite. `test_guard.py` swaps `_hard_exit` for one that raises, module-wide.
  - A thread, not SIGALRM: the hook also runs on the Windows agent.
  - Residual: one C call holding the GIL (a backtracking regex) still blocks the watchdog.
- Tests: `test_a_proc_subst_passed_through_or_sourced_in_a_c_script`,
  `test_stdin_routes_into_a_shell`, `test_compound_eval_fd_and_output_subst_routes`,
  `test_stdin_route_shapes_classify_fast`,
  `test_a_multi_statement_body_prints_the_command`,
  `test_a_filtered_or_unread_body_runs_as_its_producers_text`,
  `test_a_nested_or_conditional_body_runs_as_its_producers_text`,
  `test_an_assigned_filtered_or_conditional_body_runs_as_its_text`,
  `test_a_large_conditional_or_nested_taint_body_stays_fast`,
  `test_a_large_filtered_body_classifies_without_timing_out`,
  `test_a_sibling_or_an_empty_expansion_does_not_hide_the_command`,
  `test_an_unset_name_after_a_protected_target_is_read_empty`,
  `test_a_nested_quote_or_a_reassigned_value_does_not_hide_the_command`,
  `test_a_decision_past_its_deadline_denies`, `test_a_decision_past_the_hook_deadline_denies`,
  `test_a_nested_substitution_in_a_reparsed_string_is_classified`,
  `test_deep_substitution_nesting_stays_fast`, `test_a_default_nested_in_a_default_applies` (`test_guard.py`).
