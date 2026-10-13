---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
  - "agent/hub-agent.py"
---

# pr-summary — the guard's PR-description check

Split out of `agent-hooks.md` (size ceiling); the guard's other categories live there.

- **pr-summary is the hard half of `PR_SUMMARY_SYSTEM_PROMPT`** (`pr_summary_reason`): the two must
  name the same headings, or a session following its instructions is refused by its own guard.
  - Checks `gh pr create|new`, `glab mr create|new`, `az repos pr create`, and an `edit`/`update`
    only when it sets the description (glued `-bTEXT` too). `-h`/`--help` is help wherever it
    sits, EXCEPT right after a bare flag: gh/glab read it as that flag's VALUE (`-b -h`,
    `--label -h`), so the check runs. Value-taking flags differ per CLI, hence "any bare flag";
    the cost is refusing `--web -h` / `-tfoo -h`, which would only print help.
  - **Flags sit on EITHER side of the verb** (`gh pr -R o/r create`, `gh pr -b x edit 1` — real
    gh/glab accept both), so everything after `pr`/`mr` is ONE pass: body flags collected wherever
    they are, a token after a bare flag read as its value unless it is a verb with no later verb.
    Each earlier attempt to special-case "flags before the verb" left a bypass.
  - **The body checked is the ONE source gh sends** (XERK-1565) — never the plain command text, so a
    title or comment alone does not satisfy it. `--body-file` resolves against event `cwd`, moved
    by a leading `cd`.
    - A regular FILE nothing in the command writes is checked ALONE: a heredoc gh never reads
      vouched for `--body-file hosts.yml <<EOF …` (sibling heredoc too) when it was unioned in.
    - STDIN (`-F -`) is checked against EVERY heredoc in the command, each on its own: which one
      is the PR's is not mapped, so a good sibling can't vouch for a bad one, and two
      `gh pr edit N -F - <<EOF` with good bodies still pass.
    - An inline body, or a file a heredoc writer in the command fills (`cat > f <<EOF; gh pr
      create -F f`), is checked as that value + every heredoc (`--body "$(cat <<EOF …)"`). No
      source at all checks "" → refused.
    - **A writer-filled file that EXISTS must also pass ALONE.** `written` keeps no order or
      condition (groups and `$(…)` expand first), so an appending (`>>`, `tee -a`), `false &&`-gated
      or later writer left `.env`/`hosts.yml` in what gh read. Cost: a stale non-conforming
      leftover is refused — remove it in an earlier step or use a new path. Never drop this check.
    - **Do not narrow heredocs to "the one feeding the PR command"** for those: matching by owner
      line or redirect target refused 26% of real compliant PR commands (`git push && gh pr create
      …`, `cd x && …`, `cat > "$S/b.md"`, `\`-continued).
    - **The accepted residual is an UNRELATED real heredoc in the same command** (`cat > n.txt
      <<EOF …` then `gh pr create -b junk`) — it takes a model gaming its own guard. `<<` inside
      quotes, after `#`, `<<<` and `\<<` are not heredocs to the XERK-1256 lexer, so they don't
      count. Measured by swapping a compliant body into all 483 real heredoc PR commands: 0 refused.
    - **`_split_heredocs` yields `(owner, body, quoted)`** — a shape change there crashes this check,
      and the guard then fails CLOSED on every heredoc-bodied PR (shipped once, in v2.1.50).
  - A body it can't see (`--fill`, the editor, `$(cat file)`) is refused, saying how to pass it.
  - **More than one description flag is refused** (XERK-1565): the check reads the UNION of every
    source while gh sends only the LAST, so `--body-file ok.md --body-file ~/.config/gh/hosts.yml`
    passed on ok.md's sections and posted the token file. Heredocs are not flags, so `--body
    "$(cat <<EOF …)"` and `-F - <<EOF` stay one source.
  - **A STDIN description must be the PR command's OWN heredoc** (XERK-1565, `_stdin_redirects`):
    gh reads whatever fd 0 ends up as, so `-F - <<EOF … < hosts.yml` (also `0<`, `<<<`, `<&`, a
    pipe, or a sibling's heredoc: `-F - < f; gh pr view 1 <<EOF`) posted the file on the heredoc's
    sections.
    `-` or a path resolving to `/dev/stdin` needs exactly one heredoc on that segment.
  - **A description FILE fails CLOSED** (XERK-1565, `_pr_description_file`) — never enumerate bad
    paths; four rounds of that each left one (`/dev/stderr 2<f`, `//dev/fd/3 3<f`, a symlink).
    - Accepted ONLY: stdin as above; a REGULAR file outside `/dev` and `/proc`; or a path a
      heredoc-only `cat > f <<EOF` / `tee f <<EOF` in the command writes (`_note_paths`).
    - Refused: every other `/dev`/`/proc` name, a non-regular or unreadable path, a missing file
      nothing writes, and a file another segment names any other way (`ln -sf /dev/stdin f`,
      `cp hosts.yml f`, `cat hosts.yml <<EOF > f`) — each with its own reason. Only a pure reader,
      printer or remover (`rm`, `cat`, `test`, `echo`, … `_PR_PATH_READERS`) or `git add` may name
      it; its output redirects count.
    - Symlinks resolve one component at a time and NEVER through `/dev`/`/proc`: `realpath` follows
      the HOOK's own `/proc/self/fd` links, which name different fds in gh. A leading `//` is `/`.
    - With a file flag, an input redirect on ANY fd (`<`, `N<`, `<&`, `<<<`) is refused, and a
      redirect BEFORE the command word (`< f gh pr create -F -`) is the PR command's
      (`_drop_leading_redirects`).
  - **A redirection among the PR command's words is no flag value** (rollup XERK-1701): with one
    present the command is read with its LIVE redirections moved after the words
    (`_redirects_last`), so `--body-file 2>/dev/null f.md` checks f.md, as gh reads it. A quoted
    `'2>x'` is not live and stays the file name.
  - That moved reading is used only when EVERY redirection target is a plain word
    (`_redirect_targets_plain`); an expansion or bracket in one keeps the raw reading, which
    refuses. Where a target ends is the shell's call, and a misread one moved a creds path out.
  - **A shorthand CLUSTER is a description flag too** (`_shorthand_value`): pflag reads `-dF x` as
    `-d -F x`, so `--body-file ok.md -dF hosts.yml` (also `-dFhosts.yml`, `-wF`, glab `-yd`) is
    two sources. ANY letter of a single-dash token counts (gh `b`/`F`, glab `d`): a glued value
    holding one (`-Rbob/r`) over-refuses; stopping at a misjudged value-taking letter would leak.
  - **Every file read is `O_NONBLOCK` + regular-file only** (`_read_regular`): a FIFO at the body or
    template path hung the hook, and Claude Code lets a timed-out hook's command THROUGH.
  - Headings match with `(?!\w)`, not `\b` — a template heading ending `?`/`:`/`)` never matched.
  - Not covered (accepted): `gh api …/pulls`, `hub pull-request`, `git push -o
    merge_request.create`; `-R other/repo` is checked against the LOCAL checkout's template.
  - **A repo's own PR template wins**: its headings are required instead (ones worded `optional`/
    `if applicable` excepted); a headingless template checks nothing; an EMPTY or unreadable one
    (FIFO) is no template, so the standard applies — failing open there disabled the check. Turma ships one, so Turma's
    sessions are held to its headings, not the `**Summary:**` line.
  - Off with `$TURMA_PR_SUMMARY=0`. Replayed against 32k real Bash commands: refuses only PR
    creates/body edits, 0 others. Tests: `TestPrSummary`, the hook-entrypoint toggle case (its cwd
    must be OUTSIDE this repo, or Turma's own template switches it to template mode).
