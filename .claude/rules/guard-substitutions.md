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
- Tests: `test_a_proc_subst_passed_through_or_sourced_in_a_c_script`,
  `test_a_multi_statement_body_prints_the_command`,
  `test_a_filtered_or_unread_body_runs_as_its_producers_text`,
  `test_a_nested_or_conditional_body_runs_as_its_producers_text`,
  `test_a_large_conditional_or_nested_taint_body_stays_fast`,
  `test_a_large_filtered_body_classifies_without_timing_out`,
  `test_a_nested_substitution_in_a_reparsed_string_is_classified`,
  `test_deep_substitution_nesting_stays_fast` (`test_guard.py`).
