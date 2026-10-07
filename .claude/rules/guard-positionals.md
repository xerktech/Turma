---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: positional parameters (XERK-1600, XERK-1626)

- `$1`…, `$@`, `$*` and their operator forms (`${1:-x}`, `${@:2}`, read as the value) are bound
  at three sites; anything else reaches the classifier as a literal `"$1"`.
  - `sh -c '<script>' <args>`: `_bind_positionals` over the script, args DEQUOTED and escaped.
  - A function call: `_positional_readings` binds each defined body (`f() {…}`, `f() (…)`,
    `function f {…}`) to each call's words, RAW (quotes kept) so a caller's `"$2"` stays live for
    an enclosing `sh -c` binding. Calls inside bound bodies are followed (`f() { g "$@"; }`).
  - A `set` (`set -- w…`, `set w…`, after options; `-o` takes a value): the text up to the next
    `set` is bound to its words, plus the whole line when it can replay (`_REPLAYS_RE`).
- A call's or `set`'s words end at the first operator outside quotes AND outside `(…)`/`$(…)`/
  backticks (`_word_breaks`); a flat `[^;|…]*` cut `run "A|B"` mid-quote and the unbalanced
  splice read a `su -s /bin/sh` as a `chown -R` target (a replayed false deny).
- A call back into a function already on the bound path (recursion) is not followed: each
  pass nested `$(( $1 - 1 ))` one level deeper until "too deep" denied a plain countdown.
- On a line that can replay (a loop…), the text BEFORE each `set` is bound too, with every `set`
  in it emptied (`set --`): left in, each level re-bound the line to its own words (`set -- $v`
  in a loop) until "too deep" (replayed). Never the whole line: that doubled every such line.
- A `set` word naming a positional (`set -- "$@" x`, `"$1"`, `"${1:-a}"`) is bound to the previous
  `set`'s words; one still unbound is a one-word SLOT, also read dropped (`_set_lists`). Kept raw
  it re-bound itself per level ("too large"); dropped outright it renumbered every later word
  (`set -- "$1" /etc; rm -rf "$2"`, a QA bypass).
- In a loop (or after such a list) no pass count is right (`set -- x "$@"` ×3, `"$@" /etc` ×4):
  the list's positions are UNKNOWN and it is read with every parameter bound to every word.
- `shift` adds one list per literal `shift [N]`; EVERY count when a loop or a recursive call may
  repeat it, or the count is computed (`shift $n`, `"2"`, `s=shift; $s`). Every count always
  made `r(){ tag=$1; shift; …}` called 9 times 44 readings.
- A call is found behind `eval`/`coproc`/`builtin`/`command`, in a case arm, in backticks, and
  spelled `'f'`/`"f"`/`\f`; its redirections (`f 2>/dev/null /etc`, `2>&1`) are not words.
- A `{` body's `}` closes only after a command ends (`;`, `&`, newline, or `fi`/`done`/`esac` AS a
  command); `echo }`, `echo done }`, `${x}`, `*})` are words. After `)`/`}` it is ambiguous
  (`(cmd) }` vs `echo $(x) }`), so the body is read to each such `}` (`_MAX_BODY_ENDS`) and on.
- A separator there is `_separates`: never `\;`, `\&`, a `\`-newline or the `&` of `>&`/`<&` —
  a lexical `;&\n` check let `echo \; fi }` close a body bash keeps open (QA).
  A newline ending a COMMENT always separates, whatever the comment ends in (`# c\`).
- `_is_comment` takes the caller's last comment end (`comment_nl`): a `\` ending a comment is
  text, so `# c\` NL `# d` is two comments. Read as a continuation, the 2nd `#` was a word and
  its `'` hid what followed — `rm -rf /etc` itself, on main too. All four scanners pass it.
  An EVEN backslash run before the blank (`a\\ #`) is literal text, so `#` starts a comment.
- A function header may have comment lines before its body (`f() # c` NL `{`).
- A `for p in a /etc` list is the name's values JOINED, so a whole `"$p"` word splices each value
  as its own word (`_FOR_NAMES`); mid-string (`bash -c "… $p"`) they stay joined. A ONE-word
  list (each per-word reading) splices quoted (XERK-1657); `for v;`/`"$@"` lists are read per
  word too.
- A raw word never lands inside `'…'` of the body: the function's shell does not expand it there.
- An UNQUOTED use of a raw word splits it (XERK-1657): a quoted word is spliced dequoted, plain
  text escaped as a `$x` value is (`f(){ $1; }; f 'rm …'` ran `rm`); one holding `$`/backtick only
  dequoted, so `f "$v"` stays live for the line's substitution.
  - Never in an ASSIGNMENT (`_in_assignment_word`): escaped, `f(){ x=$1; $x; }; f 'rm …'` read
    `x=rm` (a QA bypass of main's deny). Assignment = a command's leading `NAME=` words, or a
    declaring builtin's (`local`/`export`/…, after its options). `env x=$1` is an argument and
    `x=case $1` runs `$1`: both split (QA). A separator that is quoted or escaped (`env a\;x=$1`)
    starts no command, so that word splits too. The `sh -c` binding keeps such a value whole.
- Every binding is an ADDED reading beside the unbound text, and ORDER-BLIND on purpose: a `set`
  binds bodies it never reaches; a call binds whatever body its name has.
- `shift` in the bound text adds each shifted list (`_shifted`, up to `_MAX_SHIFTS`); `for p;`
  reads as `for p in "$@"`.
- `"$@"` / `"${a[N]}"` are one word per element: an array subscript in `"…"` reads every element
  (values are stored joined, so `"${a[1]}"` read the whole list as ONE word).
- A bound reading's own assignments win over the line's (`local d=$1` is the bound value).
- A `set` gives at most two lists, and a bound reading's expansion is memoised per decision:
  more lists, unmemoised, re-expanded one span 104 times on a looped `set -- "$@" x` (replayed).
- Text an enclosing text already read is read AGAIN at each nesting level: a skip for "covered"
  text was tried and leaked twice (an inert unquoted copy, then `{set …}` / `${x+(…)}` passing
  a lexical group-body test, each hiding the eval'd copy). Don't reintroduce it; the per-decision
  memo above is the safe saving.
- **Cost stays linear: only bodies and set-spans are read, never the line per call.** A per-call
  re-expansion of the line is quadratic and made a XERK-1600 attempt time out the hook.
  - Per-call/per-set readings share a byte budget (`_POSITIONAL_READ_FACTOR` × line + floor);
    binding stops at it (`limit` → `_BoundTooLong`) and is not charged to the growth budget —
    charged, 450 refs × 450 calls made a benign 5 KB line "too large". Past it, one reading per
    function binds every parameter to every remaining call's NON-PLAIN words (`_PLAIN_WORD_RE`).
  - Residual: past the budget, a `$1` in PROGRAM position (`f() { "$1" -rf "$2"; }`) only sees
    the union, so a program word among many calls is not read per call.
  - A 3000-statement body using `$1` called 40 times takes ~5s (main: 0.6s; the deadline is 30s and fails closed).
- A bound parameter's operator is APPLIED (`${@/tmp/etc}`, `${1%/}`), `${!#}` is the last arg,
  and an unset one takes its default (`${1:-/etc}` with no arg or `''`) (XERK-1641).
  - Unset ones are also read as an ADDED per-segment reading (`_bind_positionals(seg, [None])`),
    which covers a top-level `rm -rf "${1:-/etc}"`. Never via `_VAR_USE_RE`: a script's text is
    substituted before it is bound, so `sh -c '…"${1:-}"' _ /etc` read the default, not `/etc`.
  - `find -L/-H/-P/-D x/-O3` options before the roots are skipped (`_find_roots`).
  - A shell fed by `find … {} \;` / `xargs -n1` is read once PER PATH (`$1`, or `$0` when
    `{}` comes first), capped at `_MAX_PER_RUN` paths, ranked by `_dangerous_target` first
    (`_per_run_operands`): by length alone a padded `//////////etc` was ranked out (QA).
  - One reading binding `$1` to every path lost `d="$1"`, `cd "$1"` and `$0`, and false-denied
    a direct `sh -c` with 2+ args; all paths, uncapped, false-denied ~330 roots as too large
    (QA). Residual: past the cap, 33+ paths the guard calls dangerous are not all read per run.
- Not covered (XERK-1655): a quoted `eval 'set -- …'`, `trap`/alias calls, `f() if/for/while/[[`
  bodies, `${1#x}`/`${!#}`/`"${@:2}"` ops applied, an eval'd single-quoted `$1`, `"$(f /etc)"`
  output, `f ${HOME:+/etc}`, `f {a,b} …` brace words, `set -- $(…)`, a `while` shifting past
  `_MAX_SHIFTS`, `source` of a file, a function defined in one substitution and called in
  another, and past the byte budget `$1` as a PROGRAM word.
- Accepted over-deny: a benign `bash -c` nested 4+ levels with a function at each is "too deep".
- Tests: `TestScriptChannels.test_the_found_path_reaches_the_script_it_runs`,
  `test_a_function_call_and_set_bind_the_positionals`, `test_positional_readings_stay_linear`,
  `test_qa_positional_shapes`.
