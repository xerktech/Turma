---
paths:
  - agent/hooks/guard.py
  - agent/tests/test_guard.py
---

# Guard: which words are a `cd` (XERK-1769)

- A `cd`/`pushd`/`popd` (or `builtin`/`command`) word that bash dequotes or empties to that name
  counts too (`_cd_spelled_readings`): `c\d`, `"c"d`, `$"cd"`, `c$@d`, `c$(:)d`, `c${nope}d`,
  `c\<newline>d`. Missed, `c\d /; rm -rf *` was judged from the session cwd and allowed.
  - Feeds `_cd_targets` (as an added reading) and the `_MOVES_RE` gate (XERK-1753's PWD reading).
  - A value the line assigns (`x=cd; $x /`) is already spliced before either sees it.
  - An opaque substitution placeholder in the word is read empty: it may print nothing.
- Only a word that itself spells a cd name is rewritten, wherever it sits; no other word is.
  Dropping names in the arguments read `cd "$d"` as a bare `cd` home and refused
  `cd "$d"; rm -rf *`. Accepted over-read: `echo c\d; rm -rf *` is refused, as
  `echo cd; rm -rf *` already was.
- No word-length skip: padding (`c""""…d`, `c$@$@…d`) is free to bash.
- A redirection among `cd`'s words is not its operand (`cd >/dev/null /`, `cd 2>&1 /`,
  `cd />/dev/null`, `cd ~&>x`): `_cd_split_redirects` puts a blank before each one glued to a
  word, on the raw text before shlex; `_CD_REDIRECT_RE` then skips it.
  - Only a BARE one (`_quote_states`, outside `_find_substs` bodies and `${…}` by a depth
    count): shlex drops quotes, so a cut after it read `cd "/x/a>b/../../../etc"` as `/x/a`;
    nor one a `$(…)` prints or a `${a#>}` holds. Only an odd `$` run opens a `${`: `$${` is
    the PID and a `{`, and counted as an opener it hid every later redirect.
    Never `_mask_expansions` here: it rescans per unclosed `=(`/`$((`, quadratic on the hook.
  - Digits alone before it are its fd (`2>x`, `{fd}>x`); glued to text they are not:
    `cd /2>x` is `cd /2`, as in bash.
  - The uncut operand (main's reading) is ALSO kept when it names an exact root or the home:
    a value spliced in earlier (`${x:-<}`) has lost its expansion. Only then: kept always,
    each redirected `cd` took two cwd slots and filled the cap (a false deny).
- `_CD_QUOTED_RE` is an ADDED match whose words run through quotes and escapes
  (`cd "/x/a;b/../../../etc"`). Never replace `_CD_RE` with it: matched at a `cd` inside a
  string it pairs quotes from there and swallowed `echo "a cd b"; cd /etc; echo "c"`.
- Words come from `_CD_WORD_RE`: non-overlapping, alternatives with distinct starts. A
  separator-anchored regex with a backtracking `+` was quadratic: 32 KB of `\ ` took 70s in the
  hook, past its timeout, which lets the command run. Re-time any change to it on long runs of
  `\ `, `\;`, unclosed quotes, `$(`, `${`.
- Past `_MAX_CWDS` the cwd list is trimmed by `_cd_trimmed`/`_cd_nearest`, never by
  recency: exact roots, the home and its holders, and one cwd per danger group are always
  kept (`guard-home.md`, XERK-1768). Dropped by recency, `cd /d0; … cd /d7; cd /; rm -rf *`
  was allowed, and seven `cd ~uN` hid a later `cd /etc` (XERK-1769 QA).
- Tests: `test_a_cd_spelled_with_quotes_or_escapes_is_a_cd`.
