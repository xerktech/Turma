---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: refuse constructs it can't confidently read (XERK-1749)

The guard tries to model bash exactly, one construct at a time. Each QA pass on a fix files 3-5
new evasions, so the long-tail queue grows faster than it drains, and each new value-parsing
branch risks a slow/hung `decide()` (a hook timeout lets the command THROUGH). None of these
shapes happen by accident — they need a session deliberately building an evasion, and the hard
boundary for a hostile session is XERK-1677. So for this tail: **stop modelling the exotic
construct; DETECT it and fail closed when the line also has a dangerous sink.**

## The rule

`_unreadable_construct(command)` (in `_decide_bash`, after the exact readers, before the final
allow; non-grantable, category `policy`):

- **sink first** (`_unreadable_sink`, three cheap regexes; most commands have none, so the marker
  scan runs only when one is present): a destructive file op (`rm`/`dd`/`shred`/`mkfs*`/`truncate`
  …), an `rm -rf`-shaped flag cluster, OR a shell-executing sink (`eval`/`source`/`trap`/a shell
  `-c`/a pipe into a shell/a shell reading `<<`/`<<<`/a `< <(…)` feed). Coarse and quoting-BLIND
  on purpose — the dangerous thing may sit in a value, here-string or heredoc body.
- **then markers** (`_unreadable_markers`): a construct the guard does not resolve exactly. The
  message is "write it plainly, or put the data in a file."

## Why the markers are gated to LIVE shell, and why that is load-bearing

Real transcripts are almost entirely ordinary, BUT they are full of these constructs **in benign
positions**: a `${…}` inside `python3 -c '…'`, a heredoc carrying a python/commit/file payload, a
nested `"$(cmd "x")"`, `${arr[@]}`, `${VAR:-default}`. A quoting-BLIND marker scan denied ~1300 of
42.5k real commands (measured) — unshippable. So the markers:

- **run on the heredoc-STRIPPED text** (`_split_heredocs`): a heredoc body is data, never scanned
  for markers (the sink scan still sees it).
- **fire only in live quoting states** (`""`/`"`/`{"`, via `_quote_states`): a `${…}` or `$'…'`
  inside a single-quoted `… -c '…'` / `python3 -c '…'` payload is DATA and is skipped.
- **word-level markers are command-position only** (`_UNREAD_CMDPOS`): `declare -n`/`coproc`/
  `shopt` as a path (`.local/`) or a word in a message (`"shopt …"`) is not the builtin.

With that gating the corpus yields **~12 new denies in ~42.7k commands (~0.03%), EVERY one a guard-
DEVELOPMENT transcript** running the literal bypass payloads as test data (`python3 -c "import
guard … 'esac)x rm -rf /'"`, `cat > tc.py <<'PY' … DENY=[("nameref", …)]`), the XERK-1749
commit/PR/ticket for this change included. Zero ordinary dev commands flip. The count grows only
because the fleet does heavy guard-QA; it is not real work. Accepted: a guard-QA session that
inlines a bypass string gets refused; put the cases in a file (`guard_differential.py`) as
guard-qa.md already says. **0 regressions** (the change is purely additive — it adds a deny on the
allow path and removes none — so no base-deny can become an allow).

## The marker list (extend HERE, do not add new exact-bash modelling)

Each fires on a live construct next to a sink; the folded ticket is named.
- **nameref** `declare/local/typeset -n` (XERK-1722) · **coproc** · **shopt** (XERK-1716) — cmd-start.
- **var-ifs** `IFS=$…` / `read -d "$…"` (XERK-1702).
- **case-subst** an `esac)` GLUED to text — `$(case … esac)x`; the substitution scanner ends the
  body at the first case-pattern `)` (XERK-1695). A plain `$(case … esac)` ends at a separator and
  is left alone (keyed on the glue, so raw text, so the `eval '…'` re-parse form is caught too).
- **indirection** `${!name}` — but not `${!pre*}`/`${!arr[@]}` (prefix/key listings) (XERK-1732).
- **array-op** `${name[idx]<op>}` — a subscript WITH an op (XERK-1700/1716/1730/1731). Bare
  `${arr[@]}` has no op and is left alone (the common case).
- **extglob** `?(`/`*(`/`+(`/`@(`/`!(` in an op word (XERK-1709/1714/1716).
- **nested-op** a `${` inside a trim/replace pattern (XERK-1709/1723).
- **bracket-pat** a `[` in a trim/replace pattern (XERK-1707).
- **arith-name** a substring offset `${name:…$…}` with an expansion (XERK-1723).
- **quoted-brace** a quoted/escaped `}` inside an op word (XERK-1729/1700).
- **assign-op** `${x:=w}`/`${x=w}` (XERK-1700).
- **ansi-c** `$'…'` whose body escapes a quote (`\'`/`\"`) — desyncs the splitter (XERK-1733). A
  plain `$'\t'`/`$'\n'` is left alone.
- **herestring-brace** `<<<` feeding a shell with a brace-list word (XERK-1739).

## PowerShell / cmd scripts are scanned, never parsed (rollup XERK-1584)

- When `powershell`/`pwsh`/`cmd` is the command's PROGRAM (after `_strip_prefixes`),
  `_ps_script_reason` refuses it if ANY argument word is a remove command/alias, ANY is a
  recursive switch (`-Recurse` abbreviation, `/s` in a switch run) or wildcard, and ANY names a
  protected path. Words are split on blanks, punctuation and comment chars; quoted text also
  counts whole (`'C:\Program Files'`).
- Four statement parsers each lost to a shape QA ran live in pwsh: option values, `-Com`, blocks,
  `<#` inside a string, newlines, expression position (`$x = rm …`, `echo (rm …)`). Don't
  rebuild one.
- Accepted over-deny: a read-only script naming all three (`Get-ChildItem C:\Windows; Remove-Item
  -Recurse .\dist`). Only a shell PROGRAM is scanned, so a commit message quoting one is data.
  Also any recursive delete in a script that names `/` or `~` elsewhere (`rm -r ./dist; ls ~`).
- It runs on the RAW command's segments too, not only the expanded ones: the expansion swaps a
  single-quoted subexpression for a placeholder, and pwsh runs it (`_ps_raw_reason`).
  - A shell word there counts as the program, right after a `$(`/backtick/`<(` (behind prefix
    words), or after a runner (`_PS_RUNNERS`: xargs, parallel, flock…; find/fd `-exec`/`-x`)
    (XERK-1861): segment-start only missed `xargs pwsh -c '$(…)'`. `echo pwsh …` stays data.
  - Accepted over-read: after a runner any later word may be its program, so
    `xargs echo pwsh … <all three>` is refused.
  - A shell's/`eval`'s later words are scripts, each scanned as a command (`bash -c 'pwsh …'`).
  - It scans the heredoc-STRIPPED text: a note's body line naming all three was refused.
  - A body a shell reads (`_walk_owner_feeds_shell`, or an ssh/autossh word, `_names_ssh`) is
    scanned as a script. Match ssh by dequoted basename: a raw `\bssh\b`-style regex both
    over-read `ssh-notes.md` and missed `/usr/bin/ssh`, `\ssh`, `"ssh"` (QA). Stripped,
    `bash <<'E'` hid a pwsh `$(…)` main had denied (QA). A body whose owner line runs
    pwsh/cmd is scanned with it (`pwsh -c - <<E`).
  - Past `_PS_RAW_DEPTH` nested scripts, text invoking pwsh or `cmd /c` is REFUSED: returning
    nothing let five nested `bash <<E` through where main denied (QA). Never fail open there.
    Test at exactly `_PS_RAW_DEPTH + 1`: deeper nests are denied by another path anyway.
  - Owner lines are split once per OWNER, never per heredoc: per heredoc, N `<<E` on one line
    was quadratic (36s at 16 KB, QA). Each substitution opener looks ahead a bounded run.
  - Open (XERK-1863), all allowed on main too: `echo '…' | pwsh -c -`, `eval "$(cat <<E…)"`,
    `p\wsh`, a `bash <<<` here-string, `eval pwsh -c \''$(…)'\'`, `bash -c '… "$1"' _ '$(…)'`.
- Keep it linear: a `/s` regex with an ambiguous repeat took 238s at 256 KB through the hook;
  the trailing-glob cut in `_ps_targets` is `rfind`, never a regex (72s at 128 KB, XERK-1861).
- Tests: `test_a_powershell_c_script_s_remove_targets_are_judged`,
  `test_a_long_cmd_switch_run_stays_linear`.

## Residual — NOT closed this way (documented, not a bug to "finish")

Behavioural shapes indistinguishable from ordinary automation by text alone, so a marker broad
enough to catch them false-denies normal scripts (measured: var-program ~600 FP, reparse-special
~200, escaped-dollar/bad-subst ~150 each). They stay OPEN under the XERK-1677 boundary; closing one
needs real data-flow resolution (the per-construct modelling this ticket stops doing), not a marker:
- a rebuilt `$var` run as a command (XERK-1697/1703/1711/1713/1726/1730/1732/1747),
- a value echoed out of a reader / substitution (XERK-1713), positionals or OLDPWD/IFS inside a
  re-parse (XERK-1715), a `:-` default that may be empty (XERK-1705), a quoted `${}` in printed
  text (XERK-1698), nested quotes in an assigned `$(…)` / a shell as printer (XERK-1744/1745),
  an unquoted backslash in a value (XERK-1728), operators spliced through a default (XERK-1742).

## Invariants

- **Never make a marker broad to catch a residual** — re-measure FP on the real corpus first (the
  replay in guard-qa.md: old vs new over `~/.claude/projects` Bash commands; report the number).
  A marker that overlaps common usage (`${arr[@]}`, `${VAR:-x}`, `"$(cmd "x")"`, a bare `$var`
  program) is the failure mode, every time.
- **Keep every scan LINEAR** (no new ReDoS): markers use `_quote_states`/`_brace_end`/bounded
  regexes, jump past each `${…}` span, and bound every `(?:…)*`. Two shapes were O(n²) in QA and
  must stay fixed: `_unreadable_brace_spans` STOPS at the first live `${` that does not close
  (re-scanning every later `$` on `${${${…` was quadratic); `_UNREAD_HERESTR_BRACE_RE` CAPS its
  `[^}]{0,200}` runs (unbounded, each `{` in a `${${…`/`$($(…` word scanned to the end); and
  `_UNREAD_HERESTR_WORD_RE` has NO `$(…)` branch (it overlapped the catch-all and backtracked on
  `sh <<< $($(…`). `test_the_marker_scan_stays_linear` times them with `process_time` (never
  wall-clock — XERK-1750) and includes the `sh <<< $(…`, `bash <<< ${…` and `sh <<< 'x'…` shapes.
- **The marker sits on the CONSTRUCT, not the result**, so it catches confident MISREADS
  (XERK-1707/1728/1729/1733) a "value unreadable" rule never would.
- Module names are unique (the file is ~14k lines): the markers use `_UNREAD_*` / `_unreadable_*`.
- Tests: `TestUnreadableConstructs` — the DENIED shapes, the ordinary ALLOWED look-alikes (the real
  guard: arrays/defaults/single-quoted data/`bash -c make`/`grep -rf` keep working), marker-without-
  sink allows, non-grantability, and the linearity timing.
