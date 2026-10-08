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
- **The same raw reading covers every route a script text arrives by** (XERK-1649):
  - a `-c` script an `xargs`/`find -exec` RUNS (`_raw_shell_c_scripts`) — runner position only,
    so `xargs echo bash -c …` stays text; a double-quoted `\`` is also read unescaped;
  - a `-c`/eval script's `$(echo …)`s spliced as their printed text, quoted `$(…)` kept
    (`_raw_script_texts`), wherever they sit in it;
  - a `<(…)` body's printed text with quoted `$(…)` kept (`_kept_printed`), its statements
    JOINED, since `echo 'a=$(…)'; echo '$a'` binds across lines.
  - A new script route needs this reading too, or `a=$(…); $a` hides there.
- **Every xargs option walk goes through `_xargs_options`** (XERK-1649): short options cluster
  (`-rn 1` = `-r -n 1`), so a per-word walk put `1` in command position and allowed `rm -rf /`.
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
- **Each `for` list is also read once per distinct word** (XERK-1647, `_for_word_lines`): joined,
  `for v in a 'rm …'; do $v; done` ran program `a`. The list is cut to that word, and `_FOR_PICK`
  makes the name hold it ALONE — an earlier `v=a` or another `for v` joined in hid it too.
  - Lists are read by `_for_lists`, word by word (`_FOR_WORD_RE`: `$'…\'…'`, `\;`, and a `do` word
    are list words; a `${…}` is read through by `_assign_value_end`): `[^;\n]+` cut
    `for v in a 'x;' 'rm …'` at the `;`.
  - A `for` inside a SHELL list already read is a word (skipped); one inside another `for … in`
    text is still scanned — it may be the real loop (`echo for x in y && for v in …`) — but binds
    nothing, as main's regex didn't. A text scan's end is cached per word start it passed, and a
    later scan stops on reaching one (`_for_scan`): a run of `for … in` with no `do` was rescanned
    to the line's end once each (quadratic). `_for_lists` is cached per text AND parse flags
    (`_quote_states` reads them): keyed on text alone, a flagged reading got the plain one's.
  - Only a shell loop's list — `do` or `{` follows it (`_FOR_DO_RE`) — whose name is expanded
    somewhere (`$v`, `${v…}`, `${!v}`) is read per word. Python's `for f in a if …` in a quoted
    script matches too: read per word, real 10 KB rigs went too large or nested too deeply.
  - A list with no `do` keeps the old `[^;\n]*` binding: scanned word by word, its words ran on
    into the quotes around it.
  - Values pass only (`_expand_values`): the per-value/brace/old-parse passes multiplied by the words
    made a 600-char line hit the 30 s deadline. The joined readings still run every pass.
    The chained reading (XERK-1648) DOES run per word when values chain: a word `"$R"` naming
    `R=$Q` was empty without it.
  - Each reading is the WHOLE line less its list — never just the loop: that lost what the line set
    before it (`x=…; for v in a eval; do $v "$x"`) or took out through another name.
  - Budget: `_MAX_FOR_WORD_CHARS` of line × passes (taint readings multiply); past it the line is
    `_TOO_LARGE` (a deny) — e.g. ~200 loops on one line. Characters, never a wall clock: that
    denied a real command only on a busy host.
  - Two lists used in one word (`$a$b`, `${a}a$b`, `$a$z$b`, `$a'$'b`) are also read as their
    PRODUCT (XERK-1657, `_glued_name_groups`): one at a time, `$a$b` never formed `rm`. Not
    across a `/` (`$d/$f`): that doubled real directory loops' cost (QA); quotes-only glue let
    `${a}a$b` and an empty `$z` between through (QA). Past
    `_MAX_FOR_PRODUCT` readings the line is too large (60×60 words took 8 s). Unglued nested lists
    stay one at a time.
  - Any NUMBER of glued names is one product (`$a$b$c`, XERK-1692), and glue reaches through a
    name holding a loop name (`_glue_sources`): `c=$a`, `c=" $a"`, `c=$(echo $a)`, `printf -v`,
    `read c <<< $a`, and `$1$2` bound by `set --` or a call (`shift` on the line: any later
    argument). Pairwise, three names never formed the word. Namerefs are XERK-1722.
    - The product's reading count sums over groups, so an N-way loop stays inside
      `_MAX_FOR_PRODUCT` (7³ is too large, a deny). A group inside a larger one is skipped.
    - Every list of each name is read against every other's (as pairs were on main); only past
      the cap does each glued word fall back to its nearest preceding list per name. All-only, a
      rig repeating the same three loops went too large (replay); near-only can miss a word
      read later than its loops (a function body).
    - A loop name keeps its list word: an edge targeting one is dropped (`v=$1` in a heredoc
      script made every `rf-$v` a product, a replayed false deny).
    - `_glue_sources` is lexical and order-blind on purpose: an extra source only adds capped
      readings, a missed one is a product never read. Sources settle on a worklist (any chain
      length or order, linear). Its value regex bounds each `$(…)`/backtick unit: unbounded, a
      run of unclosed `c=$(` took 77 s on 80 KB (QA).
  - Shell-list words are brace-expanded first (`_brace_words`): `_expand_braces` skips a list
    holding a blank, so `for v in a {'rm …',b}` bound one word. Past `_BRACE_SEQ_MAX` words each
    item of each list is a word too (`_brace_items_flat`, `_BRACE_FLAT_DEPTH` levels, a deeper item
    kept as written — at 4 levels a deeper payload was dropped): read short, a later item ran unread;
    refused, a long brace in heredoc text nothing runs was denied (QA). `$"…"` dequotes as `"…"`,
    `$'…'` as its decoded text.
  - Cost accepted: each word now read (brace items, product) is a whole-line reading, as a literal
    list of that length already was; a heavy line can reach the deadline (fails closed).
  - A one-word list's whole `"$v"` (each per-word reading) splices quoted; bare, as the joined
    multi-word reading splices it, `for v in 'rm …'; do bash -c "$v"` handed `-c` `rm` (XERK-1657).
  - A loop over positionals (`set -- …; for v; do`, `f(){ for v in "$@"; …}; f …`) is read per
    word on each bound reading in `_expand` too, `_FOR_PICK` saved and restored around it.
  - An `eval` whose joined words rebuild a use (`eval '$'v`, `eval "$"v`) is re-read with the
    line's values substituted — only when quotes split a `$` from its name in the raw segment
    (`_QUOTE_SPLIT_USE_RE`, brace forms `'${'v'}'`/`'${v'}` too): on every eval it cost ~5x.
    Tests: `test_loop_words_reach_a_script_positional_or_eval_alone`.
- `_expand_braces` ends a brace word with `_word_end`, so a glued `$(…)` stays whole:
  `{,}$(echo rm …)` was cut at its `(` into `$ $`.
- A brace word's START is also read as bash's word (XERK-1683, `_brace_word_start`): cut at the
  last blank, quoted or not, `eval 'rm -rf /etc'{,x}` repeated only `/etc'`.
  - Found by a forward `_word_end` scan from the innermost substitution body holding the brace:
    `_quote_states` reads a `"$(…)"` body as bare, so a backward quote walk stopped inside it.
  - An ADDED reading in `_expand_readings` (`_BRACE_QUOTED`), taken only once the two starts
    differ (`_BRACE_QUOTED_SEEN`); the blank-cut reading stays.
  - Open: quoted items with blanks (`{'a b',c}`, XERK-1738); a here-string word (XERK-1739).
  - Tests: `test_a_brace_glued_to_a_quoted_word_repeats_the_whole_word`.
- **`_shell_c_script` is how to read a `-c` script**: bash drops a `--` after `-c`.
- **`$'…'` is decoded by bash's rules** (`_ansi_c_text`, XERK-1693), never `unicode_escape`: that
  raised on escapes bash takes (`\x`, `\x4`, `\u41`) and the string stayed undecoded, so one such
  escape hid the whole script. Unknown escapes keep their `\`; a NUL ends the text.
  - Only an UNQUOTED `$'` is decoded (`_quote_states` at the `$`, always computed): in `"…"`,
    `'…'` or a `#` comment it is literal; decoded, `"$'\x27'"` unbalanced the line and a
    comment's `$'\nx'` hid the next one. A skipped match steps past its `$'` only.
  - `_quote_states` reads a bare `$'…'` as one quote span whose `\` escapes the next character:
    read as `'…'`, the `\'` in `$'it\'s'` closed it and `s'` hid every later `$'…'` from the
    decode. A blind-decode reading beside it was tried and lost to one decoy per model.
  - Only an ODD run of `$` before the `'` is ANSI-C (`_ansi_c_dollar`): `$$'a\'` is the PID and a
    plain `'a\'`, which bash closes at the `\'`; read as ANSI-C it hid the command after it.
  - Divergence kept (no bypass found): bash decodes `$'…'` inside `"${x:-…}"` (extquote).
  Tests: `test_ansi_c_strings_decode_as_bash_does` (against real bash).
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
  - Protected-path globs go through `_shell_fnmatch`, never bare `fnmatch` (XERK-1654): it
    rewrites `[^` to `[!`; with any `[:`/`[=`/`[.`, first `[` to last `]` becomes `*`.
    - That only WIDENS (fail closed; accepted over-deny `/e[[:digit:]]c`). Never parse brackets
      here: a regex bracket parse reopened `/e[t[:]c` and backtracked exponentially (hook stall).
  - A glob straight after a `$HOME` token is judged as possibly the home itself (`$HOME*`,
    `$HOME?`, `$HOME*/.ssh`, and `/root*/.ssh`; `_glob_names_home`).
    Not `~*`: bash expands no tilde there.
    Tests: `test_a_bash_only_glob_class_or_a_glob_after_home_is_judged`.
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
- **A blank or operator inside an unquoted `${…}` stays in its word** (XERK-1680): bash reads
  `${x: -5}/etc`, `${x:<newline>-5}/etc` and `${x/;/}/etc` as one word; cut, `/etc` was unjudged.
  - Tokenizer (`_keep_brace_blanks`): shlex's blanks (`\r` too) swap to private-use stand-ins
    the text does NOT hold — a fixed set was disabled by planting one.
  - A `${` then a blank names no parameter and is skipped: the guard's own `${ <placeholder>}`
    splices became one program word (a replayed false deny).
  - Splitter: an operator inside a `${…}` that `_brace_end` closes later is a `cuts` entry, so the
    segment is read split AND joined — a misread close must not hide every later command.
  - The stage walk (`keep_redirects`) joins these too (its redirect cuts still never join):
    split only, `echo '…' ${x/;/} | sh` cut the producer off its shell.
  - Open (XERK-1742): a spliced DEFAULT keeps `;`/`&` live
    (`echo '…' ${x:-;} | sh`), unlike an assigned value, which `_quote_literal` escapes.
  - Tests: `test_a_blank_inside_an_unquoted_brace_stays_in_its_word`.
- **A lone `\` ending a text is read DROPPED** (XERK-1646, `_drop_trailing_escape`): shlex
  raises on it, and the whitespace-split fallback kept a `-c`/`eval` script's quotes.
  - The reading lives in the TOKENIZER (`_tokenize_cached`): every route tokenizes — the
    stdin-feed walk's stages (`echo '…'\ | sh`), a segment whose escaped blank the split ate
    (`'…'\ ; true`), a `\<newline>` split at its newline.
  - Dropped, not bash's literal `\`: zsh drops it, so does a continuation (bash's here-string
    `text\`+newline), and the literal only ever weakens the last word (`/etc\`, `sh\`). Never
    add the literal as a second whole-line or per-segment reading: each level of a nested
    `eval '…'\` re-expanded both, 4x per level, and 1 KB took 29s (QA).
  - Detected by `_quote_states` + the run's parity, never shlex: `comments=True` read a glued
    `'…'#\` as a comment; without it `# don't` is an open quote.
  - `_expand_braces` drops it too, BEFORE joining (as zsh does): left on, `{/etc,/var}\` became
    `/etc\ /var\`, ONE word to shlex.
  - A substitution's PRINTED text ending in one is spliced with it dropped in the plain reading
    (`_subst_text`, XERK-1691): kept, it escaped the `"` closing `sh -c "$(echo "…'\\")"`, the
    line no longer tokenized, and the script hid. The literal reading keeps it (as `\\`).
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
- **A value naming another assigned name also gets its whole chain's value** (XERK-1648,
  `_chain_values`): names resolved in dependency order (`_dependency_order`, Tarjan SCCs, edges
  sorted), each value read ONCE against what is known before its group, then stored resolved —
  never re-inlined per recursion level (that grew the text to "too deep").
  - The chained values are a READING of their own (`_VALUES_CHAINED`, keyed in `_memo`): when any
    name reads differently (`_CHAIN_DIFFERS`), `_expand_both` re-runs `_expand_picks` with every
    value chain-resolved. Main's resolve-once values (against values naming none; an unresolved
    name empty) stay the values of every other pass. Both lists have one value per assignment,
    so pass counts and caps are unchanged.
    - Swapped in, a QA oracle (bash's real value of each target) found a later assignment read
      into an earlier use (`c=$p/; … p=1`), whose empty reading is bash's.
    - Appended to the values, they moved which value each per-value pass picks, losing main's
      pairing of two names' last values (`a=$p; a=eval; …; b='rm …'; $a "$b"`, a QA bypass), and
      doubled reassigned names past `_MAX_VALUE_PASSES` ("too large").
  - Cost: the empty reading stays, so `q=/tmp/q; d=$q; r=$d/; rm -rf $r` still reads `/` and
    is denied — the ordered reading (XERK-1660, `guard-order.md`) adds, never removes.
  - Resolving once alone read `q=/etc; d=$q; r=$d` as `r` empty, and a link naming a cycle
    (`d=$q$c; c=$c`) and a name with a plain and a chained value (`q=/tmp; q=$e; d=$q`) the same.
  - Inside a cycle (an SCC, or a name using itself) a member reads another's unlinked values only
    and an unknown one empty, as main did: `d=/; d=$d/etc` is `//etc`. What a cycle holds
    depends on ORDER, which the ordered reading reads (XERK-1660, `guard-order.md`; seeded-cycle
    shapes). Do not add propagation inside a cycle — four QA passes broke each variant:
    - re-reading on each change nested every lap's text, and a real test loop's
      `n=$((n + ${m:-0}))` counters were refused as too deep (replay); a 3000-member wheel 33s;
    - reading once in seed order let a stuck read's partial value leak into members that never
      re-read it, and in set order the verdict changed with PYTHONHASHSEED.
  - A link's `${q%x}`, `${q/a/b}`, `${q:+…}` applies its operator (`_apply_var_op`); names in a
    `:+`/`+` alternative are expanded by the caller's `expand` (both `_assigned_values` and
    `_substitute_vars`) and count as dependencies (`_names_used`). Spliced raw, `${x:+$x}` ran
    as the literal `$x` — a bypass of `rm -rf ${x:+$x}`.
  - An unset name's default is resolved over the line's positions like a nested `${…}`
    (XERK-1661): spliced raw, `a=/etc; rm -rf ${q:-$a}` left a `${a}` nothing expanded again.
    Only the default's span, so an element's `${y[0]:-$a}` keeps its `[0]`; an ASSIGNED element's
    marker-led default is resolved the same way. A quote in it stays raw (XERK-1700).
  - `_dequote_value` braces a name a quote ends (`$b'tc'`, `"$b"tc` → `${b}tc`): stored as
    `$btc`, it read an unset name where bash appends `tc` to `$b` (XERK-1661).
    `_brace_quote_ended` braces one in any text (`$(echo $b'tc')`), with NO unbraced re-read:
    via `_GLUED_NAME_RE` that re-read doubled ~9% of real commands, 11 past the deadline (QA).
    Left as written: an escaped `\$b'`, and `$b'` inside `'…'` (a `-c` re-parse joins them).
  - A value that only MAY be empty (`q=$(true)`, `q=$nope`) is still read as set and never
    takes its `:-` default: XERK-1705. (A literally empty one does, `guard-param-ops.md`.)
  - Tests: `test_a_chain_of_assignments_resolves_every_link`,
    `test_a_cycle_of_assignments_stays_bounded`, `test_a_cycle_of_assignments_is_read_once`,
    `test_names_in_an_operator_argument_are_dependencies`,
    `test_a_name_in_an_operator_argument_or_a_quote_join_expands`.
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
