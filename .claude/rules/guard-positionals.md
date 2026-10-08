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
- Positionals reached through MORE spellings are bound too (XERK-1655):
  - A NON-BRACE compound function body (`f() for p; do …; done`, `f() if …; fi`, `f() [[ … ]]`,
    `f() ((…))`, `function f while …`) is extracted by `_compound_body_end` — a nesting-tracking
    scan from after the `_FUNC_HEADER_RE` header to the compound's own closer (`done`/`fi`/`]]`…),
    the body's own opener taken without a command-start check (it sits right after the header `)`).
  - `eval`/`trap` ACTION strings are inlined in place (`_eval_inlined_lines`, an ADDED reading):
    `eval 'f /etc'`, `trap 'f /etc' EXIT`, `f() { eval 'rm -rf "$1"'; }`, `eval 'set -- /etc'`, and
    `c='rm …"$1"'; eval "$c"` (the action's `$c` resolved) — so the revealed call/`set` binds beside
    the line's defs. `_positional_readings` recurses into the inlined line (depth `_MAX_EVAL_INLINE`).
  - A non-default operator is APPLIED in a RAW binding too (`${1#x}`, `${1%/}`, `${@/a/b}`): the raw
    word is dequoted, the op applied, and the result spliced as a literal; a word still holding a `$`
    stays live. `${@:N}`/`${@:N:M}` slices the positional ARRAY (`_slice_positionals`), not the join.
  - A call word is also read with `${x:+alt}`/`${x+alt}` taken (`_alternatives_taken`, `f ${HOME:+/etc}`)
    and brace-expanded (`f {a,b} /etc` → three args, `$3` is `/etc`).
  - `set -- $(…)` sets the positionals to the words the substitution PRINTS (`_sub_substs` first).
  - A `shift` under a loop may run past `_MAX_SHIFTS`, so the last arg never lands at `$1` in the
    capped shift lists; an `every=True` binding (every parameter ← every arg) is added beside them.
  - Function OUTPUT (`rm -rf "$(f /etc)"`): a call whose output is CAPTURED — inside a `$(…)`/backtick
    (`_find_substs`) — is inlined IN PLACE (`f`'s body, args bound), so the command-substitution
    machinery resolves `$(echo "/etc")` to `/etc`. `all_defs` holds every function (a body printing a
    literal matters too); a SELF-RECURSIVE one is never inlined (it nested a countdown to "too deep").
    Only substitution-captured calls, never top-level (bound by the `work` loop already): inlining
    those only spent budget and false-denied big QA scripts as "too large".
  - `bash -c "$(declare -f f); f /etc"`: `$(declare -f f)` is spliced as f's definition
    (`_DECLARE_F_RE`), so the child's `-c` script is read with f defined and its call binds.
- **These inline readings are a CPU-blowup hotspot — the gates below are load-bearing** (XERK-1655 QA
  found 10-23x process-time blowups that tripped the 30s deadline → false-deny on real QA rigs, which
  this fleet constantly generates). A blowup needs an inlined whole-command/script reading that gets
  re-expanded per value pass, compounding when it carries nested `$(…)`. Keep all of:
  - `_positional_readings` is MEMOISED per decision (`_memo("posread", …)`): `_expand` re-reads the
    same line once per value pass, and recomputing the inlining each time was ~10x.
  - A body/action/definition that itself holds `$(…)`/backtick is NEVER inlined (call, `declare -f`,
    eval): splicing it into a `$(…)` re-expands that nest on every reading.
  - A `$(f)` capture is inlined ONLY when it FEEDS a destructive command (`_capture_feeds_destructive`,
    `_OUTPUT_TARGET_PROGS`) — `id=$(f)`/benign pipelines are data, and inlining them only re-expands
    the line (2.5x+). This loses `$(f)` output used by a NON-destructive program, by design.
  - An `eval` action that is only positional parameters (`eval "$@"`, redirections stripped via
    `_call_words`) is skipped: it reveals no hidden call/set and binding `$@` per call was 6-11x.
  - Verify ANY change here with a process_time (NOT wall-clock) replay of the function+`$(f)`+eval
    corpus subset — the deadline is wall-clock and load-dependent, so a blowup hides under load.
- Not covered (XERK-1655 residual): `source`/`.` of a written file carrying a positional, a function
  defined in one substitution and called in another, an `eval` of a value read from an untraceable
  source past the reader machinery, and past the byte budget `$1` as a PROGRAM word.
- Accepted over-deny: a benign `bash -c` nested 4+ levels with a function at each is "too deep".
- Tests: `TestScriptChannels.test_the_found_path_reaches_the_script_it_runs`,
  `test_a_function_call_and_set_bind_the_positionals`, `test_positional_readings_stay_linear`,
  `test_qa_positional_shapes`, `test_xerk_1655_positional_bypasses`.
