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
    (`&`, `if`/`while`/`case`), an assignment VALUE (stored, not run — splicing it also
    made shlex quadratic), a here-string a consuming command reads (`grep -q`/`read`), and a stdout
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
  - Both passes must stay LINEAR (`test_empty_expansion_readings_stay_linear`): rebuilding the
    text per removal, or tokenising every word's prefix, ran 30 KB past the 60s hook timeout.
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
- **A decision has a wall-clock deadline** (`_MAX_DECIDE_SECONDS`, checked in `_expand`): out of
  time it denies as too large. The growth budget counts characters, not time; readings re-expanded
  per eval level ran 98 KB past the 60s hook timeout, which RUNS the command.
- Tests: `test_a_proc_subst_passed_through_or_sourced_in_a_c_script`,
  `test_stdin_routes_into_a_shell`, `test_stdin_route_shapes_classify_fast`,
  `test_a_multi_statement_body_prints_the_command`,
  `test_a_filtered_or_unread_body_runs_as_its_producers_text`,
  `test_a_nested_or_conditional_body_runs_as_its_producers_text`,
  `test_a_large_conditional_or_nested_taint_body_stays_fast`,
  `test_a_large_filtered_body_classifies_without_timing_out`,
  `test_a_sibling_or_an_empty_expansion_does_not_hide_the_command`,
  `test_a_decision_past_its_deadline_denies`,
  `test_a_nested_substitution_in_a_reparsed_string_is_classified`,
  `test_deep_substitution_nesting_stays_fast` (`test_guard.py`).
